import { logger } from "../observability/logger";

export interface RateLimitOptions {
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
}

export const RATE_LIMIT_POLICIES = {
  // Generation creation / image upload (expensive inference)
  uploadIp: { maxRequests: 10, windowSeconds: 60 },
  uploadUser: { maxRequests: 5, windowSeconds: 60 },
  // Status polling on active generation pages
  pollingIp: { maxRequests: 60, windowSeconds: 60 },
  // Stripe checkout session creation
  checkoutUser: { maxRequests: 5, windowSeconds: 60 },
  // Signed asset downloads
  assetDownloadUser: { maxRequests: 30, windowSeconds: 60 },
} as const;

/**
 * In-memory sliding-window store for single-instance, local, test, or fallback environments.
 */
interface InMemRecord {
  timestamps: number[];
}

const memoryStore = new Map<string, InMemRecord>();

/**
 * Resets the rate limiting store. Primarily for deterministic unit and integration tests.
 */
export function resetRateLimits(): void {
  memoryStore.clear();
}

/**
 * Redacts identifier for safe audit logging without leaking personal data.
 */
function redactIdentifier(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

/**
 * Evaluates rate limit for a given identifier using sliding-window algorithm.
 * Automatically utilizes Upstash Redis if configured; otherwise seamlessly falls back
 * to local in-memory sliding window.
 */
export async function checkRateLimit(
  identifier: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = options.windowSeconds * 1000;
  const cutoff = now - windowMs;

  // 1. Attempt Upstash Redis if environment credentials are valid
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken && !process.env.VITEST) {
    try {
      const { Ratelimit } = await import("@upstash/ratelimit");
      const { Redis } = await import("@upstash/redis");

      const redis = new Redis({
        url: upstashUrl,
        token: upstashToken,
      });

      const ratelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(
          options.maxRequests,
          `${options.windowSeconds} s`,
        ),
        analytics: false,
      });

      const upstashRes = await ratelimit.limit(identifier);

      const resetAtMs = upstashRes.reset;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((resetAtMs - now) / 1000),
      );

      const result: RateLimitResult = {
        allowed: upstashRes.success,
        limit: options.maxRequests,
        remaining: upstashRes.remaining,
        resetAtMs,
        retryAfterSeconds: upstashRes.success ? 0 : retryAfterSeconds,
      };

      if (!result.allowed) {
        logger.warn("Rate limit exceeded (Upstash)", {
          event: "abuse.rate_limit_exceeded",
          identifier: redactIdentifier(identifier),
          limit: options.maxRequests,
          windowSeconds: options.windowSeconds,
          retryAfterSeconds,
        });
      }

      return result;
    } catch (redisError) {
      // Degrade gracefully to in-memory fallback on Redis connectivity errors
      logger.warn(
        "Upstash rate-limiter failed; falling back to in-memory store",
        {
          error: redisError instanceof Error ? redisError.message : String(redisError),
        },
      );
    }
  }

  // 2. In-memory sliding-window rate limiting
  let record = memoryStore.get(identifier);
  if (!record) {
    record = { timestamps: [] };
    memoryStore.set(identifier, record);
  }

  // Filter out timestamps older than the sliding window
  record.timestamps = record.timestamps.filter((ts) => ts > cutoff);

  const currentCount = record.timestamps.length;
  if (currentCount < options.maxRequests) {
    record.timestamps.push(now);
    const remaining = options.maxRequests - record.timestamps.length;
    const oldestTimestamp = record.timestamps[0] || now;
    const resetAtMs = oldestTimestamp + windowMs;

    return {
      allowed: true,
      limit: options.maxRequests,
      remaining,
      resetAtMs,
      retryAfterSeconds: 0,
    };
  }

  // Rate limit exceeded
  const oldestTimestamp = record.timestamps[0] || now;
  const resetAtMs = oldestTimestamp + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000));

  logger.warn("Rate limit exceeded (In-Memory)", {
    event: "abuse.rate_limit_exceeded",
    identifier: redactIdentifier(identifier),
    limit: options.maxRequests,
    windowSeconds: options.windowSeconds,
    remaining: 0,
    retryAfterSeconds,
  });

  return {
    allowed: false,
    limit: options.maxRequests,
    remaining: 0,
    resetAtMs,
    retryAfterSeconds,
  };
}

/**
 * Formats standard HTTP rate-limiting headers for responses.
 */
export function getRateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAtMs / 1000)),
  };

  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }

  return headers;
}
