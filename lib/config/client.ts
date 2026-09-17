import { ClientConfig } from "./types";
import { buildClientConfig } from "./schema";

let cachedClientConfig: ClientConfig | null = null;

/**
 * Returns safe public client-side configuration.
 */
export function getClientConfig(): ClientConfig {
  if (!cachedClientConfig) {
    cachedClientConfig = buildClientConfig(process.env);
  }
  return cachedClientConfig;
}

/**
 * Clears client config cache for test isolation.
 */
export function resetClientConfigForTesting(): void {
  cachedClientConfig = null;
}
