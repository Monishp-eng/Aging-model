/**
 * Deterministic, path-traversal-safe storage object key generators
 * and sanitization primitives for private asset management.
 */

export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}

/**
 * Sanitizes a path component (such as userId, generationId, or extension)
 * to strictly prevent path traversal, control characters, and injection attacks.
 */
export function sanitizePathSegment(segment: string, fieldName = "segment"): string {
  if (!segment || typeof segment !== "string") {
    throw new InvalidPathError(`${fieldName} must be a non-empty string`);
  }

  const trimmed = segment.trim();

  // Block path traversal attempts
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("%2e") ||
    trimmed.includes("%2f")
  ) {
    throw new InvalidPathError(`${fieldName} contains illegal path characters: "${segment}"`);
  }

  // Enforce safe characters: alphanumeric, dashes, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new InvalidPathError(`${fieldName} contains unsupported characters: "${segment}"`);
  }

  return trimmed;
}

/**
 * Generates the deterministic storage object path for an uploaded input image.
 * Structure within bucket: `{userId}/{generationId}/source.{ext}`
 */
export function getInputKey(userId: string, generationId: string, ext = "jpg"): string {
  const safeUser = sanitizePathSegment(userId, "userId");
  const safeGen = sanitizePathSegment(generationId, "generationId");
  const safeExt = sanitizePathSegment(ext.replace(/^\./, ""), "ext");
  return `${safeUser}/${safeGen}/source.${safeExt}`;
}

/**
 * Generates the deterministic storage object path for a generated output artifact (GIF).
 * Structure within bucket: `{userId}/{generationId}/result.{ext}`
 */
export function getOutputKey(userId: string, generationId: string, ext = "gif"): string {
  const safeUser = sanitizePathSegment(userId, "userId");
  const safeGen = sanitizePathSegment(generationId, "generationId");
  const safeExt = sanitizePathSegment(ext.replace(/^\./, ""), "ext");
  return `${safeUser}/${safeGen}/result.${safeExt}`;
}

/**
 * Generates the deterministic storage object path for temporary artifacts.
 * Structure within bucket: `{userId}/{generationId}/{randomId}`
 */
export function getTempKey(userId: string, generationId: string, randomId: string): string {
  const safeUser = sanitizePathSegment(userId, "userId");
  const safeGen = sanitizePathSegment(generationId, "generationId");
  const safeRandom = sanitizePathSegment(randomId, "randomId");
  return `${safeUser}/${safeGen}/${safeRandom}`;
}

export interface ParsedStorageReference {
  bucket: "input" | "output" | "temp";
  path: string;
}

/**
 * Parses any storage identifier (relative path or legacy public URL)
 * into a canonical bucket and object path.
 */
export function parseStoragePath(reference: string): ParsedStorageReference {
  if (!reference || typeof reference !== "string") {
    throw new InvalidPathError("Storage reference cannot be empty");
  }

  const trimmed = reference.trim();

  // 1. Handle legacy public URLs:
  // e.g. http(s)://.../storage/v1/object/public/{bucket}/{path}
  const publicUrlMatch = trimmed.match(/\/storage\/v1\/object\/public\/(input|output|temp)\/(.+)$/);
  if (publicUrlMatch) {
    const bucket = publicUrlMatch[1] as "input" | "output" | "temp";
    const path = publicUrlMatch[2].replace(/^\/+/, "");
    return { bucket, path };
  }

  // 2. Handle bucket-prefixed relative paths:
  // e.g. input/{userId}/{generationId}/source.jpg
  const bucketPrefixMatch = trimmed.match(/^(input|output|temp)\/(.+)$/);
  if (bucketPrefixMatch) {
    const bucket = bucketPrefixMatch[1] as "input" | "output" | "temp";
    const path = bucketPrefixMatch[2].replace(/^\/+/, "");
    return { bucket, path };
  }

  // 3. Fallback: if no bucket prefix is detected, assume input if source or output if result
  if (trimmed.includes("result.") || trimmed.endsWith(".gif")) {
    return { bucket: "output", path: trimmed.replace(/^\/+/, "") };
  }

  return { bucket: "input", path: trimmed.replace(/^\/+/, "") };
}
