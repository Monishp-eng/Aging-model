import {
  AppEnvironment,
  ConfigValidationResult,
  LogLevel,
  ServerConfig,
  ClientConfig,
} from "./types";

export class ConfigValidationError extends Error {
  public readonly errors: string[];
  public readonly warnings: string[];

  constructor(errors: string[], warnings: string[] = []) {
    super(
      `[ConfigValidationError] Configuration validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
    this.name = "ConfigValidationError";
    this.errors = errors;
    this.warnings = warnings;
  }
}

/**
 * Determines current runtime environment with explicit priority:
 * 1. APP_ENV
 * 2. NEXT_PUBLIC_VERCEL_ENV
 * 3. NODE_ENV
 */
export function getAppEnvironment(env: Record<string, string | undefined> = process.env): AppEnvironment {
  const rawEnv = (env.APP_ENV || env.NEXT_PUBLIC_VERCEL_ENV || env.NODE_ENV || "development").toLowerCase().trim();

  if (rawEnv === "production" || rawEnv === "prod") return "production";
  if (rawEnv === "preview" || rawEnv === "staging") return "preview";
  if (rawEnv === "test") return "test";
  return "development";
}

/**
 * Scans environment variables for public secret leakage.
 * Any NEXT_PUBLIC_ variable containing sensitive keywords like SECRET, TOKEN, PASSWORD,
 * or private KEYs (except legitimate public keys like NEXT_PUBLIC_SUPABASE_ANON_KEY) is rejected.
 */
export function checkSecretLeakage(env: Record<string, string | undefined> = process.env): string[] {
  const leaks: string[] = [];
  const allowedPublicKeys = new Set([
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_VERCEL_ENV",
    "NEXT_PUBLIC_VERCEL_URL",
    "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SENTRY_DSN",
  ]);

  for (const key of Object.keys(env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    if (allowedPublicKeys.has(key)) continue;

    const upperKey = key.toUpperCase();
    if (
      upperKey.includes("SECRET") ||
      upperKey.includes("SERVICE_ROLE") ||
      upperKey.includes("PRIVATE") ||
      upperKey.includes("PASSWORD") ||
      upperKey.includes("REPLICATE_API_TOKEN") ||
      upperKey.includes("STRIPE_SECRET")
    ) {
      leaks.push(`Security violation: Server secret exposed as public variable '${key}'`);
    }
  }

  return leaks;
}

/**
 * Validates that a string is a well-formed URL with an acceptable protocol (http/https/file/libsql).
 */
export function isValidUrl(urlStr: string, allowedProtocols = ["http:", "https:", "file:", "libsql:"]): boolean {
  try {
    const parsed = new URL(urlStr);
    return allowedProtocols.includes(parsed.protocol);
  } catch {
    // Special check for file:./relative/path which might not parse cleanly in standard URL without base
    if (urlStr.startsWith("file:")) return true;
    return false;
  }
}

/**
 * Normalizes application URL to eliminate trailing slashes and ensure proper protocol.
 */
export function normalizeUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, "");
}

/**
 * Resolves the canonical application origin.
 * Priority:
 * 1. NEXT_PUBLIC_APP_URL or APP_URL
 * 2. Production Vercel URL
 * 3. Preview Vercel URL
 * 4. Localhost fallback
 */
export function resolveAppUrl(
  env: Record<string, string | undefined> = process.env,
  appEnv: AppEnvironment = getAppEnvironment(env),
): string {
  if (env.APP_URL) return normalizeUrl(env.APP_URL);
  if (env.NEXT_PUBLIC_APP_URL) return normalizeUrl(env.NEXT_PUBLIC_APP_URL);

  if (appEnv === "production" && env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL) {
    return normalizeUrl(`https://${env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`);
  }

  if ((appEnv === "preview" || appEnv === "production") && env.NEXT_PUBLIC_VERCEL_URL) {
    return normalizeUrl(`https://${env.NEXT_PUBLIC_VERCEL_URL}`);
  }

  return "http://localhost:3000";
}

/**
 * Validates and constructs the typed ServerConfig.
 * In production: enforces strict fail-fast validation.
 * In development/preview/test: allows development fallbacks while surfacing actionable warnings.
 */
export function validateServerConfig(env: Record<string, string | undefined> = process.env): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const appEnv = getAppEnvironment(env);
  const isProduction = appEnv === "production";
  const isPreview = appEnv === "preview";
  const isTest = appEnv === "test";
  const isDevelopment = appEnv === "development";

  // 1. Audit secret leakage in NEXT_PUBLIC_* variables
  const secretLeaks = checkSecretLeakage(env);
  if (secretLeaks.length > 0) {
    errors.push(...secretLeaks);
  }

  // 2. Canonical Application URL
  const appUrl = resolveAppUrl(env, appEnv);
  if (!isValidUrl(appUrl, ["http:", "https:"])) {
    errors.push(`Invalid application URL resolved: '${appUrl}'`);
  }

  // 3. Optional local tunnel URL
  const rawTunnelUrl = env.TUNNEL_URL || env.WEBHOOK_TUNNEL_URL;
  let tunnelUrl: string | undefined;
  if (rawTunnelUrl) {
    if (isValidUrl(rawTunnelUrl, ["http:", "https:"])) {
      tunnelUrl = normalizeUrl(rawTunnelUrl);
    } else {
      warnings.push(`Configured TUNNEL_URL is not a valid URL: '${rawTunnelUrl}'`);
    }
  } else if (isDevelopment) {
    warnings.push(
      "TUNNEL_URL is not set in development mode. External webhooks (e.g. Replicate) will fallback to appUrl (localhost) and cannot reach your local server from the internet.",
    );
  }

  // Webhook base URL: tunnel takes precedence in development if provided; otherwise appUrl
  const webhookBaseUrl = (isDevelopment && tunnelUrl) ? tunnelUrl : appUrl;

  // 4. Database configuration
  const databaseUrl = env.DATABASE_URL || "file:./data/extrapolate.db";
  if (!isValidUrl(databaseUrl)) {
    errors.push(`Invalid DATABASE_URL format: '${databaseUrl}'. Must begin with file:, libsql:, http:, or https:`);
  }

  // 5. Supabase configuration
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || (isProduction ? "" : "https://placeholder.supabase.co");
  const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || (isProduction ? "" : "placeholder-anon-key");
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || (isProduction ? "" : "placeholder-service-role-key");

  if (!supabaseUrl) {
    errors.push("Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
  } else if (!isValidUrl(supabaseUrl, ["http:", "https:"])) {
    errors.push(`NEXT_PUBLIC_SUPABASE_URL is not a valid HTTP/HTTPS URL: '${supabaseUrl}'`);
  }

  if (!supabaseAnonKey) {
    errors.push("Missing required environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  if (!supabaseServiceRoleKey) {
    errors.push("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  }

  // 6. Stripe configuration
  const stripeSecretKey =
    env.STRIPE_SECRET_KEY ||
    (!isProduction ? env.STRIPE_SECRET_KEY_TEST || "sk_test_placeholder" : "");
  const stripeWebhookSecret =
    env.STRIPE_WEBHOOK_SECRET ||
    (!isProduction ? env.STRIPE_WEBHOOK_SECRET_TEST || "whsec_placeholder" : "");

  if (isProduction && !stripeSecretKey) {
    errors.push("Missing required production variable: STRIPE_SECRET_KEY");
  }
  if (isProduction && !stripeWebhookSecret) {
    errors.push("Missing required production variable: STRIPE_WEBHOOK_SECRET");
  }

  // 7. Replicate configuration
  const replicateApiToken = env.REPLICATE_API_TOKEN || (isProduction ? "" : "r8_placeholder");
  const replicateWebhookSecret = env.REPLICATE_WEBHOOK_SECRET || (isProduction ? "" : "whsec_placeholder");

  if (isProduction && !replicateApiToken) {
    errors.push("Missing required production variable: REPLICATE_API_TOKEN");
  }
  if (isProduction && !replicateWebhookSecret) {
    errors.push("Missing required production variable: REPLICATE_WEBHOOK_SECRET");
  }

  // 8. Cron configuration
  const cronSecret = env.CRON_SECRET || (isProduction ? "" : "dev_cron_secret_placeholder");
  if (isProduction && !cronSecret) {
    errors.push("Missing required production variable: CRON_SECRET for securing scheduled jobs");
  }

  // 9. Observability & Versioning
  const rawLogLevel = (env.LOG_LEVEL || (isProduction ? "info" : "debug")).toLowerCase();
  const logLevel: LogLevel = ["debug", "info", "warn", "error"].includes(rawLogLevel)
    ? (rawLogLevel as LogLevel)
    : "info";

  const releaseVersion = env.RELEASE_VERSION || env.npm_package_version || "0.1.0";
  const commitSha =
    env.COMMIT_SHA ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.GITHUB_SHA ||
    "local-dev";

  const sentryDsn = env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN;
  if (sentryDsn && !isValidUrl(sentryDsn, ["http:", "https:"])) {
    warnings.push(`Configured SENTRY_DSN is not a valid URL: '${sentryDsn}'`);
  }

  // 10. Rate Limiting configuration
  const upstashRedisRestUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashRedisRestToken = env.UPSTASH_REDIS_REST_TOKEN;
  const rawMaxConcurrent = env.MAX_CONCURRENT_GENERATIONS;
  const maxConcurrentGenerations =
    rawMaxConcurrent && !isNaN(Number(rawMaxConcurrent))
      ? Math.max(1, Number(rawMaxConcurrent))
      : 2;

  const valid = errors.length === 0;

  const config: ServerConfig = {
    env: appEnv,
    isProduction,
    isDevelopment,
    isTest,
    isPreview,
    appUrl,
    tunnelUrl,
    webhookBaseUrl,
    database: {
      url: databaseUrl,
    },
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      serviceRoleKey: supabaseServiceRoleKey,
    },
    stripe: {
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret,
    },
    replicate: {
      apiToken: replicateApiToken,
      webhookSecret: replicateWebhookSecret,
    },
    cron: {
      secret: cronSecret,
    },
    ratelimit: {
      upstashRedisRestUrl,
      upstashRedisRestToken,
      maxConcurrentGenerations,
    },
    observability: {
      logLevel,
      sentryDsn: sentryDsn && isValidUrl(sentryDsn, ["http:", "https:"]) ? sentryDsn : undefined,
      releaseVersion,
      commitSha,
    },
  };

  return {
    valid,
    errors,
    warnings,
    config: valid ? config : undefined,
  };
}

/**
 * Builds safe client-side configuration.
 * Only public-safe variables are included.
 */
export function buildClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig {
  const appEnv = getAppEnvironment(env);
  const appUrl = resolveAppUrl(env, appEnv);
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
  const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";
  const sentryDsn = env.NEXT_PUBLIC_SENTRY_DSN;
  const releaseVersion = env.NEXT_PUBLIC_RELEASE_VERSION || env.RELEASE_VERSION || "0.1.0";

  return {
    env: appEnv,
    isProduction: appEnv === "production",
    isDevelopment: appEnv === "development",
    isTest: appEnv === "test",
    isPreview: appEnv === "preview",
    appUrl,
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
    },
    sentryDsn: sentryDsn && isValidUrl(sentryDsn, ["http:", "https:"]) ? sentryDsn : undefined,
    releaseVersion,
  };
}
