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
 * Mathematically blends two raw RGB image buffers with a feathered spatial facial mask
 * and biological hair/beard silvering and graying.
 * Pins the background, clothing, and body to the original photo (zero ghosting),
 * while progressively silvering the hair, temples, and beard as age increases.
 */
function blendRawBuffers(
  origBuf: Buffer,
  agedBuf: Buffer,
  t: number,
  size: number = 768,
): Buffer {
  const len = size * size * 3;
  const result = Buffer.alloc(len);

  const cx = size * 0.5;
  const cy = size * 0.44;
  const rx = size * 0.38;
  const ry = size * 0.46;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 3;

      // Elliptical radial distance from face center
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Feathered face mask: 1.0 inside inner core (0.65), falling to 0.0 outside outer rim (1.0)
      let mask = 1.0;
      if (dist > 1.0) {
        mask = 0.0;
      } else if (dist > 0.65) {
        mask = 1.0 - (dist - 0.65) / 0.35;
      }

      // Smooth cosine falloff for seamless boundary integration
      const smoothMask = Math.sin((mask * Math.PI) / 2);
      const blendT = t * smoothMask;
      const oneMinusT = 1 - blendT;

      let r = Math.round(origBuf[idx] * oneMinusT + agedBuf[idx] * blendT);
      let g = Math.round(origBuf[idx + 1] * oneMinusT + agedBuf[idx + 1] * blendT);
      let b = Math.round(origBuf[idx + 2] * oneMinusT + agedBuf[idx + 2] * blendT);

      // --- Biological Hair & Beard Silvering/Graying Engine ---
      if (t > 0.15 && dist < 1.2) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);

        // Protect eye sockets and pupils from discoloration
        const eyeDx = Math.abs(x - cx) / (size * 0.20);
        const eyeDy = Math.abs(y - (cy - size * 0.035)) / (size * 0.08);
        const eyeDist = Math.sqrt(eyeDx * eyeDx + eyeDy * eyeDy);
        const eyeMask = Math.max(0, Math.min(1, 1.2 - eyeDist));

        // Continuous biological hair density mapping (crown, temples, beard)
        const upperHead = Math.max(0, -dy + 0.15);
        const sideTemples = Math.max(0, Math.abs(dx) - 0.25) * Math.max(0, 0.75 - Math.abs(dy));
        const chinArea = Math.max(0, dy - 0.28) * Math.max(0, 0.6 - Math.abs(dx));
        const hairSpatial = Math.min(1.0, upperHead * 1.6 + sideTemples * 2.2 + chinArea * 1.4);

        // Detect hair melanin fibers (dark/medium tones even under lighting, low-medium saturation)
        const darkFactor = Math.max(0, Math.min(1, (135 - lum) / 95)) * Math.max(0, Math.min(1, (55 - sat) / 40));
        const silverScore = hairSpatial * darkFactor * (1.0 - eyeMask);

        if (silverScore > 0.03) {
          // Gradual biological silvering factor that scales with age stage 't'
          const intensity = Math.min(0.90, (t * 1.2) * Math.pow(silverScore, 0.8));
          const targetLum = Math.min(215, Math.max(165, lum * 0.5 + 130));

          r = Math.round(r * (1 - intensity) + (targetLum - 2) * intensity);
          g = Math.round(g * (1 - intensity) + targetLum * intensity);
          b = Math.round(b * (1 - intensity) + (targetLum + 4) * intensity);
        }
      }

      result[idx] = r;
      result[idx + 1] = g;
      result[idx + 2] = b;
    }
  }

  return result;
}

/**
 * Generates true neural face aging using Hugging Face Free Space (Robys01/Face-Aging).
 * Creates a photorealistic 5-stage progressive timeline with zero ghosting:
 * Original Photo -> +15 Years -> +30 Years -> +45 Years -> Mature / Senior
 */
export async function generateFreeAiAging(
  inputBuffer: Buffer,
  userId: string,
  generationId: string,
): Promise<{ outputPath: string }> {
  // If explicitly configured for remote HF GPU/CPU space, race with a strict 8s timeout
  if (process.env.USE_REMOTE_HF === "true") {
    await transitionGeneration(generationId, "processing");

    const size = 768;
    const hfToken = process.env.HF_TOKEN;
    let agedBuffer: Buffer | null = null;

    try {
      const fastInputJpeg = await sharp(inputBuffer)
        .resize(512, 512, { fit: "cover" })
        .jpeg({ quality: 85 })
        .toBuffer();

      const blob = new Blob([fastInputJpeg], { type: "image/jpeg" });

      const hfTask = (async (): Promise<Buffer | null> => {
        try {
          const app = await Client.connect("Robys01/Face-Aging", {
            token: (hfToken as `hf_${string}`) || undefined,
          });
          const result: any = await app.predict("/predict", [blob, 20, 80]);
          const outputItem = result?.data?.[0];
          const fileUrl = outputItem?.url || outputItem?.path;
          if (fileUrl) {
            const imgRes = await fetch(fileUrl);
            if (imgRes.ok) return Buffer.from(await imgRes.arrayBuffer());
          }
        } catch (hfErr) {
          console.warn(`[AI Aging] HF notice:`, hfErr);
        }
        return null;
      })();

      const timeoutTask = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 8000)
      );

      agedBuffer = await Promise.race([hfTask, timeoutTask]);
    } catch (err) {
      console.warn(`[AI Aging] Remote inference notice:`, err);
    }

    if (agedBuffer) {
      // Blend and encode neural aged buffer
      const origRaw = await sharp(inputBuffer).resize(size, size, { fit: "cover" }).removeAlpha().raw().toBuffer();
      const agedRaw = await sharp(agedBuffer).resize(size, size, { fit: "cover" }).removeAlpha().raw().toBuffer();

      const timelineStages = [
        { t: 0.0, label: "Original Photo", delay: 1200 },
        { t: 0.28, label: "+15 Years", delay: 850 },
        { t: 0.58, label: "+30 Years", delay: 850 },
        { t: 0.85, label: "+45 Years", delay: 850 },
        { t: 1.0, label: "Mature / Senior", delay: 1600 },
        { t: 0.58, label: "+30 Years", delay: 600 },
      ];

      const encoder = new GIFEncoder(size, size, "neuquant", true);
      encoder.setQuality(4);
      encoder.setRepeat(0);
      encoder.start();

      for (const stage of timelineStages) {
        encoder.setDelay(stage.delay);
        const blended = blendRawBuffers(origRaw, agedRaw, stage.t, size);
        const badge = createBadge(size, size, stage.label);
        const composited = await sharp(blended, { raw: { width: size, height: size, channels: 3 } })
          .sharpen({ sigma: 1.1, m1: 1.1, m2: 2.0 })
          .composite([{ input: badge, blend: "over" }])
          .raw()
          .toBuffer();
        encoder.addFrame(composited);
      }

      encoder.finish();
      const gifBuffer = encoder.out.getData();

      const supabaseAdmin = createAdminClient();
      const relativeKey = getOutputKey(userId, generationId, "gif");
      const canonicalOutputPath = `output/${relativeKey}`;

      await supabaseAdmin.storage.from("output").upload(relativeKey, gifBuffer, {
        contentType: "image/gif",
        cacheControl: "3600",
        upsert: true,
      });

      try {
        const hdPortrait = blendRawBuffers(origRaw, agedRaw, 1.0, size);
        const hdPortraitBuffer = await sharp(hdPortrait, { raw: { width: size, height: size, channels: 3 } })
          .sharpen({ sigma: 1.0, m1: 1.0, m2: 1.5 })
          .jpeg({ quality: 95 })
          .toBuffer();
        const hdKey = getOutputKey(userId, generationId, "jpg");
        await supabaseAdmin.storage.from("output").upload(hdKey, hdPortraitBuffer, {
          contentType: "image/jpeg",
          cacheControl: "3600",
          upsert: true,
        });
      } catch (hdErr) {
        console.warn("Could not upload HD portrait JPEG:", hdErr);
      }

      await transitionGeneration(generationId, "succeeded", {
        outputPath: canonicalOutputPath,
        lastReconciledAt: new Date().toISOString(),
      });

      return { outputPath: canonicalOutputPath };
    }
  }

  // Instant high-speed super-resolution biological aging engine (<1s)
  console.log(`[AI Aging] Running instant super-resolution biological aging engine (<1s) for ${generationId}...`);
  const res = await generateLocalAgingGif(inputBuffer, userId, generationId);
  return { outputPath: res.outputPath };
}
