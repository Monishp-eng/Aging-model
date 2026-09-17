import { metrics, MetricsSummary } from "./metrics";

export type AlertSeverity = "CRITICAL" | "WARNING" | "INFO";

export interface AlertDefinition {
  id: string;
  name: string;
  severity: AlertSeverity;
  threshold: string;
  meaning: string;
  action: string;
  runbookUrl: string;
}

export interface ActiveAlert {
  id: string;
  name: string;
  severity: AlertSeverity;
  currentValue: string;
  threshold: string;
  triggeredAt: string;
  meaning: string;
  action: string;
  runbookUrl: string;
}

export const ALERT_DEFINITIONS: AlertDefinition[] = [
  {
    id: "HIGH_HTTP_5XX_RATE",
    name: "High HTTP 5xx Error Rate",
    severity: "CRITICAL",
    threshold: "> 5% over recent request window (min 20 requests)",
    meaning: "Application server is failing to handle requests, indicating crash or database deadlock",
    action: "Check application logs for unhandled exceptions, inspect SQLite database lock status",
    runbookUrl: "/docs/INCIDENTS.md#high-5xx-error-rate-spike",
  },
  {
    id: "HIGH_GENERATION_FAILURE_RATE",
    name: "High Generation Failure Rate",
    severity: "CRITICAL",
    threshold: "> 15% generation failures (min 10 generations)",
    meaning: "Inference pipeline or storage output upload is experiencing systemic failures",
    action: "Inspect Replicate API status, check storage quota and prediction logs",
    runbookUrl: "/docs/INCIDENTS.md#replicate-provider-outage",
  },
  {
    id: "HIGH_REFUND_RATE",
    name: "Abnormal Credit Refund Spike",
    severity: "WARNING",
    threshold: "> 20% of completed generations resulted in refunds",
    meaning: "Excessive generation failures causing widespread automatic credit refunds",
    action: "Audit recent failed generation error messages and credit ledger consistency",
    runbookUrl: "/docs/INCIDENTS.md#stuck-generations",
  },
  {
    id: "HIGH_WEBHOOK_FAILURE_RATE",
    name: "High Webhook Ingress Failure Rate",
    severity: "CRITICAL",
    threshold: "> 5% webhook delivery failures (min 10 webhooks)",
    meaning: "Replicate or Stripe webhooks are failing signature verification or payload parsing",
    action: "Verify REPLICATE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET in environment",
    runbookUrl: "/docs/INCIDENTS.md#webhook-delivery-failures--spikes",
  },
  {
    id: "STORAGE_CLEANUP_FAILURES",
    name: "Storage Retention Cleanup Failure",
    severity: "WARNING",
    threshold: "Any failed deletions during scheduled cleanup cron",
    meaning: "Expired images could not be purged from private storage, risking storage leak",
    action: "Check Supabase storage connectivity and service-role key permissions",
    runbookUrl: "/docs/INCIDENTS.md#storage-outage-supabase",
  },
];

/**
 * Evaluates current in-memory metrics against alert thresholds.
 * Returns list of currently active alerts.
 */
export function evaluateAlerts(customSummary?: MetricsSummary): ActiveAlert[] {
  const summary = customSummary || metrics.getSummary();
  const activeAlerts: ActiveAlert[] = [];
  const now = new Date().toISOString();

  // 1. Check HTTP 5xx rate
  if (summary.http.totalRequests >= 20 && summary.http.error5xxRate > 0.05) {
    const def = ALERT_DEFINITIONS.find((d) => d.id === "HIGH_HTTP_5XX_RATE")!;
    activeAlerts.push({
      ...def,
      currentValue: `${(summary.http.error5xxRate * 100).toFixed(1)}% (${summary.http.error5xxCount}/${summary.http.totalRequests})`,
      triggeredAt: now,
    });
  }

  // 2. Check Generation failure rate
  if (summary.generations.total >= 10 && summary.generations.failureRate > 0.15) {
    const def = ALERT_DEFINITIONS.find((d) => d.id === "HIGH_GENERATION_FAILURE_RATE")!;
    activeAlerts.push({
      ...def,
      currentValue: `${(summary.generations.failureRate * 100).toFixed(1)}% (${summary.generations.failed}/${summary.generations.total})`,
      triggeredAt: now,
    });
  }

  // 3. Check Refund rate
  if (summary.generations.total >= 10 && summary.generations.refunded / summary.generations.total > 0.2) {
    const def = ALERT_DEFINITIONS.find((d) => d.id === "HIGH_REFUND_RATE")!;
    activeAlerts.push({
      ...def,
      currentValue: `${((summary.generations.refunded / summary.generations.total) * 100).toFixed(1)}% (${summary.generations.refunded}/${summary.generations.total})`,
      triggeredAt: now,
    });
  }

  // 4. Check Webhook failure rate
  if (summary.webhooks.total >= 10 && summary.webhooks.failureRate > 0.05) {
    const def = ALERT_DEFINITIONS.find((d) => d.id === "HIGH_WEBHOOK_FAILURE_RATE")!;
    activeAlerts.push({
      ...def,
      currentValue: `${(summary.webhooks.failureRate * 100).toFixed(1)}% (${summary.webhooks.failed}/${summary.webhooks.total})`,
      triggeredAt: now,
    });
  }

  // 5. Check Cleanup failures
  if (summary.cleanup.totalFailed > 0) {
    const def = ALERT_DEFINITIONS.find((d) => d.id === "STORAGE_CLEANUP_FAILURES")!;
    activeAlerts.push({
      ...def,
      currentValue: `${summary.cleanup.totalFailed} failed deletion(s)`,
      triggeredAt: now,
    });
  }

  return activeAlerts;
}
