/**
 * Input validation boundaries for application entities, route parameters,
 * and server actions.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Validates a generation ID string.
 * Must be 3 to 64 characters of safe URL-safe characters: [a-zA-Z0-9_-].
 */
export function validateGenerationId(id: unknown): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new ValidationError("Generation ID is required");
  }
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(trimmed)) {
    throw new ValidationError("Invalid generation ID format");
  }
  return trimmed;
}

/**
 * Validates a Stripe Price ID string.
 * Must be 5 to 100 characters of [a-zA-Z0-9_].
 */
export function validatePriceId(priceId: unknown): string {
  if (typeof priceId !== "string" || !priceId.trim()) {
    throw new ValidationError("Price ID is required");
  }
  const trimmed = priceId.trim();
  if (!/^(price_[a-zA-Z0-9]+|[a-zA-Z0-9_]{5,100})$/.test(trimmed)) {
    throw new ValidationError("Invalid Price ID format");
  }
  return trimmed;
}

/**
 * Validates account deletion confirmation text.
 */
export function validateDeleteConfirmation(confirmation: unknown): boolean {
  return typeof confirmation === "string" && confirmation.trim().toLowerCase() === "delete my account";
}

import { MAX_IMAGE_SIZE_BYTES } from "./image";
export * from "./image";

/**
 * Validates an uploaded image file.
 */
export function validateImageUpload(file: unknown, maxSizeBytes = MAX_IMAGE_SIZE_BYTES): { valid: boolean; error?: string } {
  if (!file || typeof file !== "object" || !("size" in file) || !("type" in file)) {
    return { valid: false, error: "Image file is required" };
  }

  const fileObj = file as { size: number; type: string };
  if (fileObj.size === 0) {
    return { valid: false, error: "Image file cannot be empty" };
  }

  if (fileObj.size > maxSizeBytes) {
    return { valid: false, error: `Image file exceeds maximum allowed size of ${maxSizeBytes / (1024 * 1024)}MB` };
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
  if (!allowedTypes.includes(fileObj.type.toLowerCase())) {
    return { valid: false, error: "Invalid image format. Supported formats: JPEG, PNG, WebP" };
  }

  return { valid: true };
}
