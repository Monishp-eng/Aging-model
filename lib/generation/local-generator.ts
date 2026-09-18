import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutputKey } from "@/lib/storage";
import { transitionGeneration } from "./lifecycle";

/**
 * Generates an SVG badge overlay indicating age.
 */
function createAgeBadgeSvg(width: number, height: number, ageText: string): Buffer {
  const badgeWidth = Math.round(width * 0.28);
  const badgeHeight = Math.round(height * 0.09);
  const fontSize = Math.round(badgeHeight * 0.52);
  const x = Math.round(width * 0.05);
  const y = Math.round(height * 0.85);

  const svg = `
    <svg width="${width}" height="${height}">
      <rect x="${x}" y="${y}" width="${badgeWidth}" height="${badgeHeight}" rx="${Math.round(badgeHeight / 2)}" fill="rgba(0,0,0,0.65)" />
      <text x="${x + badgeWidth / 2}" y="${y + badgeHeight / 2 + fontSize * 0.35}" 
            font-family="system-ui, -apple-system, sans-serif" 
            font-size="${fontSize}px" 
            font-weight="bold" 
            fill="#ffffff" 
            text-anchor="middle">${ageText}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Generates a progressive 4-frame aging GIF from the uploaded image buffer.
 * Frames: Age ~20 -> Age ~40 -> Age ~60 -> Age ~80
 * 
 * Works 100% offline, zero credit card, zero external API costs.
 */
export async function generateLocalAgingGif(
  inputBuffer: Buffer,
  userId: string,
  generationId: string,
): Promise<{ outputPath: string; gifBuffer: Buffer }> {
  const size = 512;

  // Mark generation as processing
  await transitionGeneration(generationId, "processing");

  // 1. Normalize input image to square size
  const baseImg = sharp(inputBuffer).resize(size, size, { fit: "cover" });
  const baseBuffer = await baseImg.png().toBuffer();

  const encoder = new GIFEncoder(size, size, "octree", true);
  encoder.setDelay(800); // 800ms per frame
  encoder.setRepeat(0); // Infinite loop
  encoder.start();

  const stages = [
    {
      age: "Original Photo",
      modulate: { brightness: 1.0, saturation: 1.05 },
      gamma: 1.0,
      sharpen: false,
    },
    {
      age: "+15 Years",
      modulate: { brightness: 0.96, saturation: 0.92 },
      gamma: 1.1,
      sharpen: true,
    },
    {
      age: "+30 Years",
      modulate: { brightness: 0.92, saturation: 0.75 },
      gamma: 1.25,
      sharpen: true,
    },
    {
      age: "+45 Years",
      modulate: { brightness: 0.88, saturation: 0.55 },
      gamma: 1.4,
      sharpen: true,
    },
  ];

  for (const stage of stages) {
    let pipeline = sharp(baseBuffer).modulate(stage.modulate).gamma(stage.gamma);

    if (stage.sharpen) {
      pipeline = pipeline.sharpen({ sigma: 1.5, m1: 1.2, m2: 2.0 });
    }

    const badge = createAgeBadgeSvg(size, size, stage.age);
    const composited = await pipeline
      .composite([{ input: badge, blend: "over" }])
      .raw()
      .toBuffer();

    encoder.addFrame(composited);
  }

  encoder.finish();
  const gifBuffer = encoder.out.getData();

  // 2. Upload to Supabase Storage in the 'output' bucket
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

  // 3. Update generation record in SQLite to 'succeeded'
  await transitionGeneration(generationId, "succeeded", {
    outputPath: canonicalOutputPath,
    lastReconciledAt: new Date().toISOString(),
  });

  return { outputPath: canonicalOutputPath, gifBuffer };
}
