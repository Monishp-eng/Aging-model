import sharp from "sharp";

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB authoritative limit
export const MIN_IMAGE_DIMENSION = 64; // px
export const MAX_IMAGE_DIMENSION = 4096; // px
export const MAX_IMAGE_PIXELS = 4096 * 4096; // ~16.7 megapixels

/**
 * Validates the raw magic byte signature of an image buffer
 * to protect against MIME spoofing and polyglot files.
 */
export function detectImageMagicBytes(buffer: Buffer | Uint8Array): "jpeg" | "png" | "webp" | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  // WebP: RIFF (bytes 0-3) + WEBP (bytes 8-11)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }

  return null;
}

export interface NormalizedImageResult {
  buffer: Buffer;
  format: "jpeg";
  width: number;
  height: number;
  mimeType: "image/jpeg";
}

/**
 * Authoritative upload validation and normalization pipeline:
 * 1. Checks file size bounds (max 10MB)
 * 2. Inspects magic bytes (rejects non-image payloads and fake extensions)
 * 3. Safely decodes with Sharp and checks dimension bounds (64px - 4096px)
 * 4. Protects against decompression bombs
 * 5. Normalizes orientation according to EXIF orientation tag
 * 6. Strips all EXIF, GPS, IPTC, and camera metadata to protect user privacy
 * 7. Re-encodes as clean, sanitized JPEG
 */
export async function validateAndNormalizeImage(
  input: Buffer | Uint8Array | ArrayBuffer,
  maxSizeBytes = MAX_IMAGE_SIZE_BYTES,
): Promise<NormalizedImageResult> {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (buffer.length === 0) {
    throw new ImageValidationError("Image file cannot be empty");
  }

  if (buffer.length > maxSizeBytes) {
    throw new ImageValidationError(
      `Image file size (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds the maximum allowed limit of ${maxSizeBytes / (1024 * 1024)}MB`,
    );
  }

  // 1. Validate magic bytes
  const magicFormat = detectImageMagicBytes(buffer);
  if (!magicFormat) {
    throw new ImageValidationError(
      "Invalid image format. Only JPEG, PNG, and WebP images are supported.",
    );
  }

  // 2. Decode and validate dimensions with Sharp
  let metadata: sharp.Metadata;
  try {
    const imagePipeline = sharp(buffer, {
      failOnError: true,
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    metadata = await imagePipeline.metadata();
  } catch (err: any) {
    throw new ImageValidationError(
      `Failed to decode image: ${err?.message || "Corrupted or malformed image data"}`,
    );
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
    throw new ImageValidationError(
      `Image dimensions (${width}x${height}) are too small. Minimum allowed is ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION}px.`,
    );
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new ImageValidationError(
      `Image dimensions (${width}x${height}) exceed the maximum allowed limit of ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}px.`,
    );
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ImageValidationError("Image exceeds maximum pixel count limit.");
  }

  // 3. Normalization & EXIF/Privacy Stripping:
  // .rotate() auto-rotates based on EXIF orientation, then sharp strips EXIF by default
  try {
    const normalizedBuffer = await sharp(buffer)
      .rotate()
      .jpeg({
        quality: 90,
        mozjpeg: true,
      })
      .toBuffer();

    return {
      buffer: normalizedBuffer,
      format: "jpeg",
      width,
      height,
      mimeType: "image/jpeg",
    };
  } catch (err: any) {
    throw new ImageValidationError(
      `Failed to normalize and sanitize image: ${err?.message || "Unknown error"}`,
    );
  }
}
