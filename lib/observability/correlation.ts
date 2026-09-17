import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

export interface CorrelationContext {
  requestId: string;
  userId?: string;
  generationId?: string;
  predictionId?: string;
  webhookEventId?: string;
  operation?: string;
  [key: string]: any;
}

const asyncLocalStorage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Generates a standard cryptographically random UUID for request tracing.
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Executes a function within an active correlation context.
 */
export function withCorrelationContext<T>(
  context: Partial<CorrelationContext>,
  fn: () => T,
): T {
  const current = asyncLocalStorage.getStore() || { requestId: generateCorrelationId() };
  const merged: CorrelationContext = {
    ...current,
    ...context,
    requestId: context.requestId || current.requestId || generateCorrelationId(),
  };

  return asyncLocalStorage.run(merged, fn);
}

/**
 * Retrieves the current correlation context if available.
 */
export function getCorrelationContext(): CorrelationContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Merges additional fields into the current active correlation context.
 */
export function updateCorrelationContext(updates: Partial<CorrelationContext>): void {
  const current = asyncLocalStorage.getStore();
  if (current) {
    Object.assign(current, updates);
  }
}
