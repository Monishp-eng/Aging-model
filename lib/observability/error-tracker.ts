import { logger } from "./logger";
import { redactSensitiveData } from "./redactor";
import { getCorrelationContext, CorrelationContext } from "./correlation";

export interface ErrorEvent {
  id: string;
  timestamp: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  context: Record<string, any>;
  tags: Record<string, string>;
}

let capturedErrorsForTesting: ErrorEvent[] | null = null;

export function enableErrorCaptureForTesting(): void {
  capturedErrorsForTesting = [];
}

export function disableErrorCaptureForTesting(): ErrorEvent[] {
  const errors = capturedErrorsForTesting || [];
  capturedErrorsForTesting = null;
  return errors;
}

export function getCapturedErrorsForTesting(): ErrorEvent[] {
  return capturedErrorsForTesting ? [...capturedErrorsForTesting] : [];
}

/**
 * Production error tracker interface.
 * Scrubs all context and gracefully degrades if upstream monitoring fails.
 */
export function captureException(
  error: any,
  additionalContext: Record<string, any> = {},
): string {
  const errorId = crypto.randomUUID();
  const correlation: Partial<CorrelationContext> = getCorrelationContext() || {};

  try {
    const errorObj =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
          }
        : {
            name: "NonErrorThrown",
            message: typeof error === "object" ? JSON.stringify(error) : String(error),
          };

    // Sanitize and redact all context
    const cleanContext = redactSensitiveData({
      ...additionalContext,
      requestId: correlation.requestId,
      generationId: correlation.generationId,
      predictionId: correlation.predictionId,
      userId: correlation.userId,
    });

    const event: ErrorEvent = {
      id: errorId,
      timestamp: new Date().toISOString(),
      error: errorObj,
      context: cleanContext,
      tags: {
        env: process.env.APP_ENV || process.env.NODE_ENV || "development",
        operation: correlation.operation || "unknown",
      },
    };

    if (capturedErrorsForTesting) {
      capturedErrorsForTesting.push(event);
    }

    // Attempt Sentry dispatch if configured without crashing if Sentry throws
    const sentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (sentryDsn) {
      try {
        // Safe dynamic check for Sentry if available in runtime
        const globalSentry = (globalThis as any).Sentry;
        if (globalSentry?.captureException) {
          globalSentry.captureException(error, {
            extra: cleanContext,
            tags: event.tags,
          });
        }
      } catch (sentryErr) {
        // Must never crash the application if monitoring provider fails
        logger.warn("Upstream error tracker failed to capture exception", {
          error: (sentryErr as any)?.message,
        });
      }
    }

    // Log structured error to stdout/stderr
    logger.error(`[ErrorTracker:${errorId}] ${errorObj.name}: ${errorObj.message}`, error, {
      errorId,
      ...cleanContext,
    });

    return errorId;
  } catch (internalErr) {
    // Ultimate safety guard: error tracker itself must never throw
    console.error("[CRITICAL] ErrorTracker internal failure:", internalErr);
    return errorId;
  }
}

/**
 * Captures a structured informational message with tags and sanitized context.
 */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context: Record<string, any> = {},
): void {
  try {
    const cleanContext = redactSensitiveData(context);
    logger.info(`[ErrorTracker] ${message}`, cleanContext);
  } catch (err) {
    console.error("[CRITICAL] ErrorTracker captureMessage failure:", err);
  }
}
