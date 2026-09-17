import { Client } from "@libsql/client";
import { Generation, GenerationStatus, InvalidStateTransitionError, NotFoundError } from "../types";
import { nanoid } from "nanoid";

const VALID_TRANSITIONS: Record<GenerationStatus, readonly GenerationStatus[]> = {
  queued: ["processing", "succeeded", "canceled", "failed"],
  processing: ["succeeded", "failed", "canceled", "expired"],
  succeeded: ["expired"],
  failed: ["expired"],
  canceled: ["expired"],
  expired: [],
};

export class GenerationsRepository {
  constructor(private client: Client) {}

  private mapRow(row: any): Generation {
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      status: row.status as GenerationStatus,
      input_path: String(row.input_path),
      output_path: row.output_path ? String(row.output_path) : null,
      replicate_prediction_id: row.replicate_prediction_id ? String(row.replicate_prediction_id) : null,
      credits_reserved: Number(row.credits_reserved),
      error_code: row.error_code ? String(row.error_code) : null,
      error_message: row.error_message ? String(row.error_message) : null,
      started_at: row.started_at ? String(row.started_at) : null,
      completed_at: row.completed_at ? String(row.completed_at) : null,
      failed_at: row.failed_at ? String(row.failed_at) : null,
      expires_at: row.expires_at ? String(row.expires_at) : null,
      cleaned_up_at: row.cleaned_up_at ? String(row.cleaned_up_at) : null,
      delete_attempts: Number(row.delete_attempts || 0),
      last_delete_error: row.last_delete_error ? String(row.last_delete_error) : null,
      attempt_count: Number(row.attempt_count || 1),
      processing_started_at: row.processing_started_at ? String(row.processing_started_at) : null,
      last_reconciled_at: row.last_reconciled_at ? String(row.last_reconciled_at) : null,
      client_idempotency_key: row.client_idempotency_key ? String(row.client_idempotency_key) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async findById(id: string): Promise<Generation | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM generations WHERE id = ? LIMIT 1;",
      args: [id],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async findForUser(id: string, userId: string): Promise<Generation | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM generations WHERE id = ? AND user_id = ? LIMIT 1;",
      args: [id, userId],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async getGenerationForUser(id: string, userId: string): Promise<Generation | null> {
    return this.findForUser(id, userId);
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: "DELETE FROM generations WHERE id = ? AND user_id = ?;",
      args: [id, userId],
    });
    return rs.rowsAffected > 0;
  }

  async clearIdempotencyKey(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: "UPDATE generations SET client_idempotency_key = NULL, updated_at = ? WHERE id = ?;",
      args: [now, id],
    });
  }

  async listForUser(
    userId: string,
    options?: { status?: GenerationStatus; limit?: number; offset?: number },
  ): Promise<Generation[]> {
    let sql = "SELECT * FROM generations WHERE user_id = ?";
    const args: any[] = [userId];

    if (options?.status) {
      sql += " AND status = ?";
      args.push(options.status);
    }

    sql += " ORDER BY created_at DESC";

    if (options?.limit) {
      sql += " LIMIT ?";
      args.push(options.limit);
      if (options?.offset) {
        sql += " OFFSET ?";
        args.push(options.offset);
      }
    }

    const rs = await this.client.execute({ sql, args });
    return rs.rows.map((r) => this.mapRow(r));
  }

  async create(data: {
    id?: string;
    userId: string;
    inputPath: string;
    creditsReserved?: number;
    initialStatus?: GenerationStatus;
    clientIdempotencyKey?: string | null;
  }): Promise<Generation> {
    const maxRetries = 3;
    let attempts = 0;
    const now = new Date().toISOString();
    const creditsReserved = data.creditsReserved ?? 10;
    const status = data.initialStatus ?? "queued";

    while (attempts < maxRetries) {
      attempts++;
      const id = data.id || nanoid();

      try {
        await this.client.execute({
          sql: `
            INSERT INTO generations (
              id, user_id, status, input_path, credits_reserved,
              client_idempotency_key, attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?);
          `,
          args: [
            id,
            data.userId,
            status,
            data.inputPath,
            creditsReserved,
            data.clientIdempotencyKey ?? null,
            now,
            now,
          ],
        });

        const created = await this.findById(id);
        if (!created) throw new Error(`Generation with ID ${id} was not created`);
        return created;
      } catch (err: any) {
        // Distinguish unique constraint violation on id from all other errors
        const isCollision =
          err?.message?.includes("UNIQUE constraint failed: generations.id") ||
          err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";

        if (isCollision && !data.id && attempts < maxRetries) {
          continue; // Retry with a new nanoid
        }
        // Non-collision or custom id error -> do not retry blindly
        throw err;
      }
    }

    throw new Error("Failed to generate unique generation ID after multiple attempts");
  }

  async transitionStatus(
    id: string,
    targetStatus: GenerationStatus,
    updates?: {
      outputPath?: string | null;
      replicatePredictionId?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      expiresAt?: string | null;
      cleanedUpAt?: string | null;
      processingStartedAt?: string | null;
      lastReconciledAt?: string | null;
      attemptCount?: number;
    },
  ): Promise<Generation> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError(`Generation ${id} not found`);
    }

    const allowed = VALID_TRANSITIONS[existing.status];
    if (existing.status !== targetStatus && !allowed.includes(targetStatus)) {
      throw new InvalidStateTransitionError(existing.status, targetStatus);
    }

    const now = new Date().toISOString();
    const startedAt = targetStatus === "processing" ? (existing.started_at || now) : existing.started_at;
    const processingStartedAt = targetStatus === "processing"
      ? (updates?.processingStartedAt ?? existing.processing_started_at ?? now)
      : (updates?.processingStartedAt ?? existing.processing_started_at);
    const completedAt = targetStatus === "succeeded" ? (existing.completed_at || now) : existing.completed_at;
    const failedAt = ["failed", "canceled", "expired"].includes(targetStatus)
      ? (existing.failed_at || now)
      : existing.failed_at;

    await this.client.execute({
      sql: `
        UPDATE generations
        SET
          status = ?,
          output_path = COALESCE(?, output_path),
          replicate_prediction_id = COALESCE(?, replicate_prediction_id),
          error_code = COALESCE(?, error_code),
          error_message = COALESCE(?, error_message),
          expires_at = COALESCE(?, expires_at),
          cleaned_up_at = COALESCE(?, cleaned_up_at),
          processing_started_at = ?,
          last_reconciled_at = COALESCE(?, last_reconciled_at),
          attempt_count = COALESCE(?, attempt_count),
          started_at = ?,
          completed_at = ?,
          failed_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      args: [
        targetStatus,
        updates?.outputPath ?? null,
        updates?.replicatePredictionId ?? null,
        updates?.errorCode ?? null,
        updates?.errorMessage ?? null,
        updates?.expiresAt ?? null,
        updates?.cleanedUpAt ?? null,
        processingStartedAt ?? null,
        updates?.lastReconciledAt ?? null,
        updates?.attemptCount ?? null,
        startedAt,
        completedAt,
        failedAt,
        now,
        id,
      ],
    });

    return (await this.findById(id))!;
  }

  async findByIdempotencyKey(key: string): Promise<Generation | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM generations WHERE client_idempotency_key = ? LIMIT 1;",
      args: [key],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async findByReplicatePredictionId(predictionId: string): Promise<Generation | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM generations WHERE replicate_prediction_id = ? LIMIT 1;",
      args: [predictionId],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async findStaleGenerations(cutoffIso: string, limit: number = 50): Promise<Generation[]> {
    const rs = await this.client.execute({
      sql: `
        SELECT * FROM generations
        WHERE status IN ('queued', 'processing')
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?;
      `,
      args: [cutoffIso, limit],
    });
    return rs.rows.map((r) => this.mapRow(r));
  }

  async touchReconciled(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: "UPDATE generations SET last_reconciled_at = ?, updated_at = ? WHERE id = ?;",
      args: [now, now, id],
    });
  }

  async findExpiredGenerations(options?: {
    limit?: number;
    olderThan?: string;
  }): Promise<Generation[]> {
    const limit = options?.limit ?? 50;
    const cutoff = options?.olderThan ?? new Date().toISOString();
    const rs = await this.client.execute({
      sql: `
        SELECT * FROM generations
        WHERE cleaned_up_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at <= ?
          AND status IN ('succeeded', 'failed', 'canceled')
        ORDER BY expires_at ASC
        LIMIT ?;
      `,
      args: [cutoff, limit],
    });
    return rs.rows.map((r) => this.mapRow(r));
  }

  async recordCleanupResult(
    id: string,
    result: { success: boolean; error?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    if (result.success) {
      await this.client.execute({
        sql: `
          UPDATE generations
          SET
            cleaned_up_at = ?,
            status = CASE WHEN status = 'succeeded' THEN 'expired' ELSE status END,
            updated_at = ?
          WHERE id = ?;
        `,
        args: [now, now, id],
      });
    } else {
      await this.client.execute({
        sql: `
          UPDATE generations
          SET
            delete_attempts = delete_attempts + 1,
            last_delete_error = ?,
            updated_at = ?
          WHERE id = ?;
        `,
        args: [result.error ?? "Unknown cleanup error", now, id],
      });
    }
  }

  async markAllForUserCleanedUp(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE generations
        SET
          cleaned_up_at = ?,
          status = CASE WHEN status IN ('queued', 'processing') THEN 'canceled'
                        WHEN status = 'succeeded' THEN 'expired'
                        ELSE status END,
          updated_at = ?
        WHERE user_id = ?;
      `,
      args: [now, now, userId],
    });
  }

  async countActiveByUser(userId: string): Promise<number> {
    const rs = await this.client.execute({
      sql: "SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND status IN ('queued', 'processing');",
      args: [userId],
    });
    if (rs.rows.length === 0) return 0;
    return Number(rs.rows[0].count);
  }

  async countTotalGenerations(): Promise<number> {
    const rs = await this.client.execute("SELECT COUNT(*) AS count FROM generations;");
    if (rs.rows.length === 0) return 0;
    return Number(rs.rows[0].count);
  }
}

