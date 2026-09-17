import { LogLevel } from "../config/types";
import { redactSensitiveData } from "./redactor";
import { getCorrelationContext, CorrelationContext } from "./correlation";

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  scope?: string;
  requestId?: string;
  generationId?: string;
  predictionId?: string;
  webhookEventId?: string;
  userId?: string;
  durationMs?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: any;
}

// In-memory buffer for testing / log verification
let logCaptureBuffer: LogEntry[] | null = null;

export function enableLogCapture(): void {
  logCaptureBuffer = [];
}

export function disableLogCapture(): LogEntry[] {
  const logs = logCaptureBuffer || [];
  logCaptureBuffer = null;
  return logs;
}

export function getCapturedLogs(): LogEntry[] {
  return logCaptureBuffer ? [...logCaptureBuffer] : [];
}

export class Logger {
  private scope?: string;
  private defaultContext?: Record<string, any>;

  constructor(scope?: string, defaultContext?: Record<string, any>) {
    this.scope = scope;
    this.defaultContext = defaultContext;
  }

  private shouldLog(level: LogLevel): boolean {
    const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
    const currentWeight = LEVEL_WEIGHTS[level] || 20;
    const targetWeight = LEVEL_WEIGHTS[configuredLevel] || 20;
    return currentWeight >= targetWeight;
  }

  public formatLogEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, any>,
    error?: any,
  ): LogEntry {
    const correlation: Partial<CorrelationContext> = getCorrelationContext() || {};
    const timestamp = new Date().toISOString();

    const entry: LogEntry = {
      timestamp,
      level,
      message,
      ...(this.scope ? { scope: this.scope } : {}),
      ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation.generationId ? { generationId: correlation.generationId } : {}),
      ...(correlation.predictionId ? { predictionId: correlation.predictionId } : {}),
      ...(correlation.webhookEventId ? { webhookEventId: correlation.webhookEventId } : {}),
      ...(correlation.userId ? { userId: correlation.userId } : {}),
      ...this.defaultContext,
      ...context,
    };

    if (error) {
      if (error instanceof Error) {
        entry.error = {
          name: error.name,
          message: error.message,
          stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
        };
      } else if (typeof error === "string") {
        entry.error = {
          name: "Error",
          message: error,
        };
      } else {
        entry.error = {
          name: "UnknownError",
          message: JSON.stringify(error),
        };
      }
    }

    return redactSensitiveData(entry);
  }

  private write(level: LogLevel, message: string, context?: Record<string, any>, error?: any): void {
    if (!this.shouldLog(level)) return;

    const entry = this.formatLogEntry(level, message, context, error);

    // If capture buffer is active (during tests), save copy
    if (logCaptureBuffer) {
      logCaptureBuffer.push(entry);
    }

    const isProduction =
      process.env.APP_ENV === "production" ||
      process.env.NEXT_PUBLIC_VERCEL_ENV === "production" ||
      process.env.NODE_ENV === "production" ||
      process.env.LOG_FORMAT === "json";

    if (isProduction) {
      const line = JSON.stringify(entry);
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
    } else {
      const correlationTag = entry.requestId ? ` [req:${entry.requestId.slice(0, 8)}]` : "";
      const scopeTag = entry.scope ? ` [${entry.scope}]` : "";
      const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]${scopeTag}${correlationTag}`;

      if (level === "error") {
        console.error(`${prefix} ${message}`, entry.error || "", Object.keys(context || {}).length > 0 ? context : "");
      } else if (level === "warn") {
        console.warn(`${prefix} ${message}`, Object.keys(context || {}).length > 0 ? context : "");
      } else {
        console.log(`${prefix} ${message}`, Object.keys(context || {}).length > 0 ? context : "");
      }
    }
  }

  public debug(message: string, context?: Record<string, any>): void {
    this.write("debug", message, context);
  }

  public info(message: string, context?: Record<string, any>): void {
    this.write("info", message, context);
  }

  public warn(message: string, context?: Record<string, any>): void {
    this.write("warn", message, context);
  }

  public error(message: string, errorOrContext?: any, context?: Record<string, any>): void {
    if (errorOrContext instanceof Error || typeof errorOrContext === "string") {
      this.write("error", message, context, errorOrContext);
    } else {
      this.write("error", message, errorOrContext, undefined);
    }
  }

  public child(scope: string, context?: Record<string, any>): Logger {
    const combinedScope = this.scope ? `${this.scope}:${scope}` : scope;
    return new Logger(combinedScope, { ...this.defaultContext, ...context });
  }
}

export const logger = new Logger();

export function createScopedLogger(scope: string, context?: Record<string, any>): Logger {
  return new Logger(scope, context);
}
