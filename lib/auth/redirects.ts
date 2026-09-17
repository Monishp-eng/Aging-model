/**
 * Validates and sanitizes a post-authentication redirect destination.
 * Prevents open redirect attacks (e.g., protocol-relative URLs,
 * javascript/data schemes, external hosts, Windows backslash bypasses).
 *
 * @param input The untrusted redirect destination from query params or client input
 * @param fallback The safe fallback path (defaults to '/')
 * @returns A strictly validated same-origin relative path
 */
export function getSafeRedirectPath(
  input: string | null | undefined,
  fallback = "/",
): string {
  if (!input || typeof input !== "string") {
    return fallback;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }

  // Reject backslashes (both raw and URL-encoded) which can cause browser scheme/host confusion
  if (trimmed.includes("\\") || /%5c/i.test(trimmed)) {
    return fallback;
  }

  // Reject CRLF injection or null byte attempts
  if (/[\r\n\0]|%0d|%0a|%00/i.test(trimmed)) {
    return fallback;
  }

  // Reject protocol-relative URLs (e.g. //evil.com, ///evil.com)
  if (/^\/{2,}/.test(trimmed)) {
    return fallback;
  }

  // Must strictly start with a single slash
  if (!trimmed.startsWith("/")) {
    return fallback;
  }

  // Reject schemes disguised with colon before first query/hash (e.g. /javascript:...)
  const pathPart = trimmed.split("?")[0].split("#")[0];
  if (pathPart.includes(":")) {
    return fallback;
  }

  try {
    // Parse against a dummy base origin to verify URL components
    const dummyOrigin = "https://safe-redirect.extrapolate.internal";
    const parsed = new URL(trimmed, dummyOrigin);

    // Verify the URL did not escape the dummy origin
    if (parsed.origin !== dummyOrigin) {
      return fallback;
    }

    // Ensure the protocol remained https and no foreign host was parsed
    if (parsed.protocol !== "https:" || parsed.host !== "safe-redirect.extrapolate.internal") {
      return fallback;
    }

    // Double-check pathname starts with '/' and is not protocol-relative
    if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) {
      return fallback;
    }

    // Reconstruct the sanitized path (pathname + search + hash)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
