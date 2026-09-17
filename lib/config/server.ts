import { ServerConfig } from "./types";
import { validateServerConfig, ConfigValidationError } from "./schema";

let cachedConfig: ServerConfig | null = null;

/**
 * Returns validated server configuration singleton.
 * Throws ConfigValidationError immediately on invalid configuration.
 */
export function getServerConfig(overrideEnv?: Record<string, string | undefined>): ServerConfig {
  if (overrideEnv) {
    const result = validateServerConfig(overrideEnv);
    if (!result.valid || !result.config) {
      throw new ConfigValidationError(result.errors, result.warnings);
    }
    return result.config;
  }

  if (!cachedConfig) {
    const result = validateServerConfig(process.env);
    if (!result.valid || !result.config) {
      throw new ConfigValidationError(result.errors, result.warnings);
    }
    cachedConfig = result.config;
  }

  return cachedConfig;
}

/**
 * Clears cached config for test isolation.
 */
export function resetServerConfigForTesting(): void {
  cachedConfig = null;
}
