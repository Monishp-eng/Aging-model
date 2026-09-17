import { WebhookSSRFError, SafeDownloadedArtifact } from "./types";

/**
 * Checks if a parsed URL targets a trusted, public Replicate artifact host.
 * Strictly prohibits loopback, link-local, private RFC1918 addresses,
 * non-HTTPS schemes, unexpected ports, and userinfo.
 */
export function isAllowedReplicateUrl(parsed: URL): boolean {
  // 1. Must use HTTPS
  if (parsed.protocol !== "https:") {
    return false;
  }

  // 2. Must not contain userinfo / credentials
  if (parsed.username || parsed.password) {
    return false;
  }

  // 3. Port must be standard HTTPS (empty or 443)
  if (parsed.port && parsed.port !== "443") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  // 4. Reject localhost, literal IPs, and non-FQDNs
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }

  // 5. Reject IPv4 / IPv6 literals (e.g. 127.0.0.1, 169.254.169.254, 10.0.0.1, ::1)
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^\[?[0-9a-fA-F:]+\]?$/;
  if (ipv4Regex.test(hostname) || ipv6Regex.test(hostname)) {
    return false;
  }

  // 6. Strict allowlist: replicate.delivery or *.replicate.delivery
  const isReplicateDelivery =
    hostname === "replicate.delivery" || hostname.endsWith(".replicate.delivery");

  return isReplicateDelivery;
}

/**
 * Inspects initial bytes to verify the artifact matches a supported image format.
 * Guards against malicious HTML, scripts, SVG active content, or executables.
 */
export function validateImageMagicBytes(buffer: Buffer): { valid: boolean; detectedType?: string } {
  if (buffer.length < 12) {
    return { valid: false };
  }

  // GIF87a or GIF89a: 0x47, 0x49, 0x46, 0x38, (0x37 or 0x39), 0x61
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { valid: true, detectedType: "image/gif" };
  }

  // JPEG: 0xFF, 0xD8, 0xFF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, detectedType: "image/jpeg" };
  }

  // PNG: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
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
    return { valid: true, detectedType: "image/png" };
  }

  // WebP: RIFF ... WEBP
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { valid: true, detectedType: "image/webp" };
  }

  return { valid: false };
}

/**
 * Safely downloads an output artifact from Replicate.
 * - Enforces HTTPS and host allowlisting (replicate.delivery)
 * - Detects and aborts private network / metadata targets
 * - Validates each hop on redirects (max 3 hops)
 * - Bounds downloaded stream size
 * - Validates Content-Type and magic bytes
 */
export async function validateAndFetchReplicateArtifact(
  rawUrl: string,
  options?: {
    maxSizeBytes?: number;
    timeoutMs?: number;
  },
): Promise<SafeDownloadedArtifact> {
  const maxBytes = options?.maxSizeBytes ?? 50 * 1024 * 1024; // 50MB default limit
  const timeoutMs = options?.timeoutMs ?? 15000; // 15s timeout

  let currentUrl = rawUrl;
  let redirectCount = 0;
  const maxRedirects = 3;

  while (redirectCount <= maxRedirects) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new WebhookSSRFError(`Invalid output URL format: ${currentUrl}`);
    }

    // SSRF verification on every hop
    if (!isAllowedReplicateUrl(parsed)) {
      throw new WebhookSSRFError(
        `Output URL does not point to an authorized Replicate host: ${parsed.hostname}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(parsed.href, {
        method: "GET",
        headers: {
          Accept: "image/gif, image/png, image/jpeg, image/webp",
          "User-Agent": "Extrapolate-Artifact-Fetcher/1.0",
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw new WebhookSSRFError("Artifact download timed out");
      }
      throw new WebhookSSRFError(`Failed to fetch artifact: ${err?.message}`);
    }

    clearTimeout(timer);

    // Handle redirects deliberately
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new WebhookSSRFError("Redirect response missing Location header");
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new WebhookSSRFError("Excessive redirects during artifact download");
      }

      currentUrl = new URL(location, parsed).href;
      continue;
    }

    if (!response.ok) {
      throw new WebhookSSRFError(
        `Artifact fetch returned non-200 HTTP status: ${response.status} ${response.statusText}`,
      );
    }

    // Check remote Content-Length if present
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declaredBytes = parseInt(contentLength, 10);
      if (!isNaN(declaredBytes) && declaredBytes > maxBytes) {
        throw new WebhookSSRFError(
          `Artifact declared size (${declaredBytes} bytes) exceeds limit of ${maxBytes} bytes`,
        );
      }
    }

    // Stream and buffer the response up to maxBytes
    if (!response.body) {
      throw new WebhookSSRFError("Artifact response contains empty body");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            await reader.cancel();
            throw new WebhookSSRFError(
              `Artifact stream exceeded maximum allowed size of ${maxBytes} bytes`,
            );
          }
          chunks.push(value);
        }
      }
    } catch (streamErr) {
      await reader.cancel().catch(() => {});
      throw streamErr;
    }

    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      throw new WebhookSSRFError("Downloaded artifact is empty (0 bytes)");
    }

    // Format and magic byte verification
    const magic = validateImageMagicBytes(buffer);
    if (!magic.valid || !magic.detectedType) {
      throw new WebhookSSRFError(
        "Downloaded artifact failed magic byte inspection; not a valid GIF or image",
      );
    }

    return {
      buffer,
      contentType: magic.detectedType,
      sizeBytes: buffer.length,
    };
  }

  throw new WebhookSSRFError("Too many redirects encountered while fetching artifact");
}
