export type AppEnvironment = "development" | "preview" | "production" | "test";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DatabaseConfig {
  url: string;
}

export interface SupabaseServerConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export interface SupabaseClientConfig {
  url: string;
  anonKey: string;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export interface ReplicateConfig {
  apiToken: string;
  webhookSecret: string;
}

export interface CronConfig {
  secret: string;
}

export interface ObservabilityConfig {
  logLevel: LogLevel;
  sentryDsn?: string;
  releaseVersion: string;
  commitSha: string;
}

export interface RateLimitConfig {
  upstashRedisRestUrl?: string;
  upstashRedisRestToken?: string;
  maxConcurrentGenerations: number;
}

export interface ServerConfig {
  env: AppEnvironment;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  isPreview: boolean;
  appUrl: string;
  tunnelUrl?: string;
  webhookBaseUrl: string;
  database: DatabaseConfig;
  supabase: SupabaseServerConfig;
  stripe: StripeConfig;
  replicate: ReplicateConfig;
  cron: CronConfig;
  ratelimit: RateLimitConfig;
  observability: ObservabilityConfig;
}

export interface ClientConfig {
  env: AppEnvironment;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  isPreview: boolean;
  appUrl: string;
  supabase: SupabaseClientConfig;
  sentryDsn?: string;
  releaseVersion: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  config?: ServerConfig;
}
