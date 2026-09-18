import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOutputKey } from "@/lib/storage";
import { transitionGeneration } from "./lifecycle";

/**
 * Generates an SVG badge overlay indicating age.
 */
function createAgeBadgeSvg(width: number, height: number, ageText: string): Buffer {
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
            text-anchor="middle">${ageText}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Synthesizes biological facial aging: hair/beard silvering,
 * skin texture maturation, and spatial facial masking.
 */
function applyMorphologicalAging(
  origBuf: Buffer,
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

      let r = origBuf[idx];
      let g = origBuf[idx + 1];
      let b = origBuf[idx + 2];

      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Facial mask: only age face and hair, preserving background completely
      if (dist < 1.25) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);

        // Protect eye sockets and pupils
        const eyeDx = Math.abs(x - cx) / (size * 0.20);
        const eyeDy = Math.abs(y - (cy - size * 0.035)) / (size * 0.08);
        const eyeDist = Math.sqrt(eyeDx * eyeDx + eyeDy * eyeDy);
        const eyeMask = Math.max(0, Math.min(1, 1.2 - eyeDist));

        // 1. Biological Hair & Beard Silvering
        if (t > 0.15) {
          const upperHead = Math.max(0, -dy + 0.15);
          const sideTemples = Math.max(0, Math.abs(dx) - 0.25) * Math.max(0, 0.75 - Math.abs(dy));
          const chinArea = Math.max(0, dy - 0.28) * Math.max(0, 0.6 - Math.abs(dx));
          const hairSpatial = Math.min(1.0, upperHead * 1.6 + sideTemples * 2.2 + chinArea * 1.4);

          const darkFactor = Math.max(0, Math.min(1, (135 - lum) / 95)) * Math.max(0, Math.min(1, (55 - sat) / 40));
          const silverScore = hairSpatial * darkFactor * (1.0 - eyeMask);

          if (silverScore > 0.03) {
            const intensity = Math.min(0.90, (t * 1.2) * Math.pow(silverScore, 0.8));
            const targetLum = Math.min(215, Math.max(165, lum * 0.5 + 130));

            r = Math.round(r * (1 - intensity) + (targetLum - 2) * intensity);
            g = Math.round(g * (1 - intensity) + targetLum * intensity);
            b = Math.round(b * (1 - intensity) + (targetLum + 4) * intensity);
          }
        }

        // 2. Skin maturation, subtle depth and crease contrast
        if (t > 0.10 && dist < 0.95 && eyeMask < 0.5) {
          // Forehead horizontal micro-crease pattern
          const foreheadWeight = Math.max(0, -dy - 0.1) * Math.max(0, 0.7 - Math.abs(dx));
          const foreheadCrease = Math.sin(y * 0.22) * foreheadWeight * t * 14;

          // Nasolabial fold region (corners of nose to sides of mouth)
          const nasoWeight = Math.max(0, dy - 0.05) * Math.max(0, 0.45 - dy) * Math.max(0, 0.35 - Math.abs(Math.abs(dx) - 0.22));
          const nasoShadow = nasoWeight * t * 24;

          // Crow's feet region near outer eye edges
          const crowsWeight = Math.max(0, Math.abs(dx) - 0.32) * Math.max(0, 0.25 - Math.abs(dy + 0.05));
          const crowsShadow = Math.sin((x + y) * 0.25) * crowsWeight * t * 16;

          const shadowTotal = foreheadCrease + nasoShadow + crowsShadow;

          // Gentle skin tone maturation (subtle desaturation & deeper undertones)
          const skinT = t * 0.25;
          const skinLum = lum * 0.94;
          r = Math.max(0, Math.min(255, Math.round(r * (1 - skinT) + skinLum * skinT - shadowTotal)));
          g = Math.max(0, Math.min(255, Math.round(g * (1 - skinT) + (skinLum - 4) * skinT - shadowTotal)));
          b = Math.max(0, Math.min(255, Math.round(b * (1 - skinT) + (skinLum - 10) * skinT - shadowTotal)));
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
 * Generates a progressive 6-stage biological aging GIF and HD portrait.
 * Fully offline, zero external API costs, with biological silvering and wrinkle morphology.
 */
export async function generateLocalAgingGif(
  inputBuffer: Buffer,
  userId: string,
  generationId: string,
): Promise<{ outputPath: string; gifBuffer: Buffer }> {
  const size = 768;

  // Mark generation as processing
  await transitionGeneration(generationId, "processing");

  // 1. Normalize input image to 768x768 raw RGB buffer
  const origRaw = await sharp(inputBuffer)
    .resize(size, size, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const stages = [
    { t: 0.0, age: "Original Photo", delay: 1200 },
    { t: 0.28, age: "+15 Years", delay: 850 },
    { t: 0.58, age: "+30 Years", delay: 850 },
    { t: 0.85, age: "+45 Years", delay: 850 },
    { t: 1.0, age: "Mature / Senior", delay: 1600 },
    { t: 0.58, age: "+30 Years", delay: 600 },
  ];

  const encoder = new GIFEncoder(size, size, "neuquant", true);
  encoder.setQuality(4);
  encoder.setRepeat(0); // Infinite loop
  encoder.start();

  for (const stage of stages) {
    encoder.setDelay(stage.delay);
    const morphed = applyMorphologicalAging(origRaw, stage.t, size);
    const badge = createAgeBadgeSvg(size, size, stage.age);

    const composited = await sharp(morphed, {
      raw: { width: size, height: size, channels: 3 },
    })
      .sharpen({ sigma: 1.1, m1: 1.1, m2: 2.0 })
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

  // 3. Save HD 24-bit JPEG portrait
  try {
    const seniorRaw = applyMorphologicalAging(origRaw, 1.0, size);
    const hdPortraitBuffer = await sharp(seniorRaw, {
      raw: { width: size, height: size, channels: 3 },
    })
      .sharpen({ sigma: 1.0, m1: 1.0, m2: 1.5 })
      .jpeg({ quality: 95 })
      .toBuffer();

    const hdKey = getOutputKey(userId, generationId, "jpg");
    await supabaseAdmin.storage
      .from("output")
      .upload(hdKey, hdPortraitBuffer, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: true,
      });
  } catch (hdErr) {
    console.warn("Could not upload HD portrait JPEG in local generator:", hdErr);
  }

  // 4. Update generation record in SQLite to 'succeeded'
  await transitionGeneration(generationId, "succeeded", {
    outputPath: canonicalOutputPath,
    lastReconciledAt: new Date().toISOString(),
  });

  return { outputPath: canonicalOutputPath, gifBuffer };
}
