import { Client } from "@libsql/client";
import { WebhookEvent, WebhookProvider, WebhookStatus } from "../types";
import { nanoid } from "nanoid";

export class WebhooksRepository {
  constructor(private client: Client) {}

  private mapRow(row: any): WebhookEvent {
    return {
      id: String(row.id),
      provider: row.provider as WebhookProvider,
      external_event_id: String(row.external_event_id),
      event_type: String(row.event_type),
      payload_hash: row.payload_hash ? String(row.payload_hash) : null,
      status: row.status as WebhookStatus,
      received_at: String(row.received_at),
      processed_at: row.processed_at ? String(row.processed_at) : null,
      error_message: row.error_message ? String(row.error_message) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async findByExternalId(
    provider: WebhookProvider,
    externalEventId: string,
  ): Promise<WebhookEvent | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM webhook_events WHERE provider = ? AND external_event_id = ? LIMIT 1;",
      args: [provider, externalEventId],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  /**
   * Record a webhook event atomically.
   * If an event with (provider, externalEventId) already exists, returns { isDuplicate: true, event: existingEvent }.
   */
  async recordEvent(params: {
    provider: WebhookProvider;
    externalEventId: string;
    eventType: string;
    payloadHash?: string | null;
  }): Promise<{ isDuplicate: boolean; event: WebhookEvent }> {
    const { provider, externalEventId, eventType, payloadHash } = params;
    const existing = await this.findByExternalId(provider, externalEventId);
    if (existing) {
      return { isDuplicate: true, event: existing };
    }

    const id = nanoid();
    const now = new Date().toISOString();

    try {
      await this.client.execute({
        sql: `
          INSERT INTO webhook_events (
            id, provider, external_event_id, event_type, payload_hash,
            status, received_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?);
        `,
        args: [
          id,
          provider,
          externalEventId,
          eventType,
          payloadHash ?? null,
          now,
          now,
          now,
        ],
      });

      const created = await this.findByExternalId(provider, externalEventId);
      return { isDuplicate: false, event: created! };
    } catch (err: any) {
      if (
        err?.message?.includes("UNIQUE constraint failed: webhook_events.provider, webhook_events.external_event_id") ||
        err?.message?.includes("uq_webhook_provider_event")
      ) {
        const raceExisting = await this.findByExternalId(provider, externalEventId);
        return { isDuplicate: true, event: raceExisting! };
      }
      throw err;
    }
  }

  async markProcessed(params: {
    provider: WebhookProvider;
    externalEventId: string;
    status: WebhookStatus;
    errorMessage?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE webhook_events
        SET status = ?, processed_at = ?, error_message = ?, updated_at = ?
        WHERE provider = ? AND external_event_id = ?;
      `,
      args: [
        params.status,
        now,
        params.errorMessage ?? null,
        now,
        params.provider,
        params.externalEventId,
      ],
    });
  }
}
