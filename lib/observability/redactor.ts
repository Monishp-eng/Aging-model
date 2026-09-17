/**
 * Deep redaction utility to sanitize sensitive operational data (tokens, secrets,
 * authorization headers, signed storage query params, cookies, and raw binary/base64 payloads).
 */

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /token/i,
  /secret/i,
  /password/i,
  /signature/i,
  /api[-_]?key/i,
  /credential/i,
  /private/i,
  /bearer/i,
];

/**
 * Sanitizes URLs with sensitive query parameters (such as presigned storage URLs or tokens).
 */
export function sanitizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    if (url.search) {
      return `${url.origin}${url.pathname}?[REDACTED_QUERY_PARAMS]`;
    }
    return urlStr;
  } catch {
    // If not a full URL with protocol, check if query exists
    const qIndex = urlStr.indexOf("?");
    if (qIndex !== -1) {
      return `${urlStr.substring(0, qIndex)}?[REDACTED_QUERY_PARAMS]`;
    }
    return urlStr;
  }
}

/**
 * Recursively redacts sensitive keys and large binary/base64 blobs from any object or primitive.
 */
export function redactSensitiveData<T = any>(data: T, depth = 0): T {
  if (depth > 8) return "[MAX_DEPTH_EXCEEDED]" as any;
  if (data === null || data === undefined) return data;

  // Handle strings
  if (typeof data === "string") {
    // Check for base64 data URI (e.g. data:image/png;base64,...)
    if (data.startsWith("data:image/") || (data.length > 500 && /^[A-Za-z0-9+/=]+$/.test(data.slice(0, 100)))) {
      return `[REDACTED_BLOB_LENGTH_${data.length}]` as any;
    }
    // Check if string contains signed storage URL with tokens
    if (data.includes("token=") || data.includes("X-Amz-Signature") || data.includes("signature=")) {
      return sanitizeUrl(data) as any;
    }
    return data;
  }

  // Handle Arrays
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, depth + 1)) as any;
  }

  // Handle Errors
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: process.env.NODE_ENV === "production" ? undefined : data.stack,
    } as any;
  }

  // Handle Objects
  if (typeof data === "object") {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return sanitized as any;
  }

  return data;
}
