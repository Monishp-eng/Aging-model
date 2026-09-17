export interface HttpMetric {
  path: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
}

export interface GenerationMetric {
  generationId: string;
  status: "succeeded" | "failed" | "canceled";
  durationMs: number;
  queueDurationMs?: number;
  inferenceDurationMs?: number;
  processingDurationMs?: number;
  refunded?: boolean;
  timestamp: number;
}

export interface WebhookMetric {
  provider: "replicate" | "stripe" | "other";
  eventType: string;
  status: "processed" | "duplicate" | "rejected" | "failed";
  durationMs: number;
  timestamp: number;
}

export interface CleanupMetric {
  deletedCount: number;
  failedCount: number;
  durationMs: number;
  timestamp: number;
}

export interface MetricsSummary {
  http: {
    totalRequests: number;
    error4xxCount: number;
    error5xxCount: number;
    error5xxRate: number;
    avgDurationMs: number;
  };
  generations: {
    total: number;
    succeeded: number;
    failed: number;
    refunded: number;
    successRate: number;
    failureRate: number;
    avgDurationMs: number;
  };
  webhooks: {
    total: number;
    processed: number;
    duplicate: number;
    rejected: number;
    failed: number;
    failureRate: number;
  };
  cleanup: {
    totalRuns: number;
    totalDeleted: number;
    totalFailed: number;
  };
}

class MetricsCollector {
  private httpRequests: HttpMetric[] = [];
  private generationMetrics: GenerationMetric[] = [];
  private webhookMetrics: WebhookMetric[] = [];
  private cleanupMetrics: CleanupMetric[] = [];
  private maxBufferSize = 1000;

  public recordHttpRequest(method: string, path: string, statusCode: number, durationMs: number): void {
    this.httpRequests.push({ method, path, statusCode, durationMs, timestamp: Date.now() });
    if (this.httpRequests.length > this.maxBufferSize) {
      this.httpRequests.shift();
    }
  }

  public recordGeneration(metric: Omit<GenerationMetric, "timestamp">): void {
    this.generationMetrics.push({ ...metric, timestamp: Date.now() });
    if (this.generationMetrics.length > this.maxBufferSize) {
      this.generationMetrics.shift();
    }
  }

  public recordWebhook(metric: Omit<WebhookMetric, "timestamp">): void {
    this.webhookMetrics.push({ ...metric, timestamp: Date.now() });
    if (this.webhookMetrics.length > this.maxBufferSize) {
      this.webhookMetrics.shift();
    }
  }

  public recordCleanup(metric: Omit<CleanupMetric, "timestamp">): void {
    this.cleanupMetrics.push({ ...metric, timestamp: Date.now() });
    if (this.cleanupMetrics.length > this.maxBufferSize) {
      this.cleanupMetrics.shift();
    }
  }

  public getSummary(): MetricsSummary {
    // 1. HTTP summary
    const totalHttp = this.httpRequests.length;
    let err4xx = 0;
    let err5xx = 0;
    let totalHttpDuration = 0;

    for (const r of this.httpRequests) {
      if (r.statusCode >= 500) err5xx++;
      else if (r.statusCode >= 400) err4xx++;
      totalHttpDuration += r.durationMs;
    }

    const error5xxRate = totalHttp > 0 ? Number((err5xx / totalHttp).toFixed(4)) : 0;
    const avgHttpDurationMs = totalHttp > 0 ? Math.round(totalHttpDuration / totalHttp) : 0;

    // 2. Generation summary
    const totalGen = this.generationMetrics.length;
    let succeededGen = 0;
    let failedGen = 0;
    let refundedGen = 0;
    let totalGenDuration = 0;

    for (const g of this.generationMetrics) {
      if (g.status === "succeeded") succeededGen++;
      else if (g.status === "failed") failedGen++;
      if (g.refunded) refundedGen++;
      totalGenDuration += g.durationMs;
    }

    const genSuccessRate = totalGen > 0 ? Number((succeededGen / totalGen).toFixed(4)) : 1;
    const genFailureRate = totalGen > 0 ? Number((failedGen / totalGen).toFixed(4)) : 0;
    const avgGenDurationMs = totalGen > 0 ? Math.round(totalGenDuration / totalGen) : 0;

    // 3. Webhook summary
    const totalWebhooks = this.webhookMetrics.length;
    let processedWh = 0;
    let duplicateWh = 0;
    let rejectedWh = 0;
    let failedWh = 0;

    for (const w of this.webhookMetrics) {
      if (w.status === "processed") processedWh++;
      else if (w.status === "duplicate") duplicateWh++;
      else if (w.status === "rejected") rejectedWh++;
      else if (w.status === "failed") failedWh++;
    }

    const webhookFailureRate = totalWebhooks > 0 ? Number((failedWh / totalWebhooks).toFixed(4)) : 0;

    // 4. Cleanup summary
    let totalDeleted = 0;
    let totalFailed = 0;
    for (const c of this.cleanupMetrics) {
      totalDeleted += c.deletedCount;
      totalFailed += c.failedCount;
    }

    return {
      http: {
        totalRequests: totalHttp,
        error4xxCount: err4xx,
        error5xxCount: err5xx,
        error5xxRate,
        avgDurationMs: avgHttpDurationMs,
      },
      generations: {
        total: totalGen,
        succeeded: succeededGen,
        failed: failedGen,
        refunded: refundedGen,
        successRate: genSuccessRate,
        failureRate: genFailureRate,
        avgDurationMs: avgGenDurationMs,
      },
      webhooks: {
        total: totalWebhooks,
        processed: processedWh,
        duplicate: duplicateWh,
        rejected: rejectedWh,
        failed: failedWh,
        failureRate: webhookFailureRate,
      },
      cleanup: {
        totalRuns: this.cleanupMetrics.length,
        totalDeleted,
        totalFailed,
      },
    };
  }

  public reset(): void {
    this.httpRequests = [];
    this.generationMetrics = [];
    this.webhookMetrics = [];
    this.cleanupMetrics = [];
  }
}

export const metrics = new MetricsCollector();
