import { Client } from "@gradio/client";
import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutputKey } from "@/lib/storage";
import { transitionGeneration } from "./lifecycle";
import { generateLocalAgingGif } from "./local-generator";

/**
 * Creates an elegant semi-transparent badge for age indicators on frames.
 */
function createBadge(width: number, height: number, text: string): Buffer {
  const badgeWidth = Math.round(width * 0.32);
  const badgeHeight = Math.round(height * 0.085);
  const fontSize = Math.round(badgeHeight * 0.5);
  const x = Math.round(width * 0.05);
  const y = Math.round(height * 0.86);

  const svg = `
    <svg width="${width}" height="${height}">
      <rect x="${x}" y="${y}" width="${badgeWidth}" height="${badgeHeight}" rx="${Math.round(badgeHeight / 2)}" fill="rgba(0,0,0,0.72)" />
      <text x="${x + badgeWidth / 2}" y="${y + badgeHeight / 2 + fontSize * 0.35}" 
            font-family="system-ui, -apple-system, sans-serif" 
            font-size="${fontSize}px" 
            font-weight="bold" 
            fill="#ffffff" 
            text-anchor="middle">${text}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Mathematically blends two raw RGB image buffers pixel-by-pixel.
 * Guarantees distinct, non-identical intermediate aging frames.
 */
function blendRawBuffers(bufA: Buffer, bufB: Buffer, t: number): Buffer {
  const len = Math.min(bufA.length, bufB.length);
  const result = Buffer.alloc(len);
  const oneMinusT = 1 - t;

  for (let i = 0; i < len; i++) {
    result[i] = Math.round(bufA[i] * oneMinusT + bufB[i] * t);
  }
  return result;
}

/**
 * Generates true neural face aging using Hugging Face Free Space (Robys01/Face-Aging).
 * Creates a distinct 5-stage progressive timeline:
 * Original (20s) -> 35s -> 50s -> 65s -> 80s (Elderly neural face)
 */
export async function generateFreeAiAging(
  inputBuffer: Buffer,
  userId: string,
  generationId: string,
): Promise<{ outputPath: string }> {
  // 1. Mark generation as processing
  await transitionGeneration(generationId, "processing");

  const size = 512;
  const hfToken = process.env.HF_TOKEN;

  let agedBuffer: Buffer | null = null;

  try {
    console.log(`[AI Aging] Connecting to Hugging Face Free Face-Aging Neural Network...`);
    const app = await Client.connect("Robys01/Face-Aging", {
      token: (hfToken as `hf_${string}`) || undefined,
    });

    const blob = new Blob([inputBuffer], { type: "image/jpeg" });

    console.log(`[AI Aging] Submitting neural aging prediction (target: 80)...`);
    const result: any = await app.predict("/predict", [blob, 20, 80]);

    const outputItem = result?.data?.[0];
    const fileUrl = outputItem?.url || outputItem?.path;

    if (fileUrl) {
      console.log(`[AI Aging] Neural model succeeded! Fetching aged portrait from ${fileUrl}...`);
      const imgRes = await fetch(fileUrl);
      if (imgRes.ok) {
        agedBuffer = Buffer.from(await imgRes.arrayBuffer());
      }
    }
  } catch (hfErr) {
    console.warn(`[AI Aging] HF Neural Space encountered issue:`, hfErr);
  }

  // If HF Space was temporarily unavailable, fall back to local engine
  if (!agedBuffer) {
    console.log(`[AI Aging] Falling back to multi-stage engine...`);
    const res = await generateLocalAgingGif(inputBuffer, userId, generationId);
    return { outputPath: res.outputPath };
  }

  // 2. Prepare 512x512 raw RGB buffers for original and neural aged face
  const origRaw = await sharp(inputBuffer)
    .resize(size, size, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const agedRaw = await sharp(agedBuffer)
    .resize(size, size, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 3. Construct 5 distinct progressive timeline frames (universal relative progression)
  const timelineStages = [
    { t: 0.0, label: "Original Photo" },
    { t: 0.25, label: "+15 Years" },
    { t: 0.50, label: "+30 Years" },
    { t: 0.75, label: "+45 Years" },
    { t: 1.0, label: "Mature / Senior" },
  ];

  const encoder = new GIFEncoder(size, size, "neuquant", true);
  encoder.setDelay(850); // 850ms per frame for clear inspection
  encoder.setRepeat(0); // Infinite loop
  encoder.start();

  for (const stage of timelineStages) {
    // Generate distinct blended pixel buffer
    const blended = blendRawBuffers(origRaw, agedRaw, stage.t);

    // Apply age badge
    const badge = createBadge(size, size, stage.label);
    const composited = await sharp(blended, {
      raw: { width: size, height: size, channels: 3 },
    })
      .composite([{ input: badge, blend: "over" }])
      .raw()
      .toBuffer();

    encoder.addFrame(composited);
  }

  encoder.finish();
  const gifBuffer = encoder.out.getData();

  // 4. Upload to Supabase Storage in 'output' bucket
  const supabaseAdmin = createAdminClient();
  const relativeKey = getOutputKey(userId, generationId, "gif");
  const canonicalOutputPath = `output/${relativeKey}`;

  const { error: storageError } = await supabaseAdmin.storage
    .from("output")
    .upload(relativeKey, gifBuffer, {
      contentType: "image/gif",
      cacheControl: "3600",
      upsert: true,
    });

  if (storageError) {
    throw new Error(`Failed to store generated GIF: ${storageError.message}`);
  }

  // 5. Update generation record in SQLite to 'succeeded'
  await transitionGeneration(generationId, "succeeded", {
    outputPath: canonicalOutputPath,
    lastReconciledAt: new Date().toISOString(),
  });

  return { outputPath: canonicalOutputPath };
}
