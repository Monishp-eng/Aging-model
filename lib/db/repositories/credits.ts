import { Client } from "@libsql/client";
import {
  CreditLedgerEntry,
  InsufficientCreditsError,
  DuplicateRefundError,
  DuplicateReservationError,
  NotFoundError,
} from "../types";
import { nanoid } from "nanoid";

export class CreditsRepository {
  constructor(private client: Client) {}

  private mapRow(row: any): CreditLedgerEntry {
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      generation_id: row.generation_id ? String(row.generation_id) : null,
      stripe_event_id: row.stripe_event_id ? String(row.stripe_event_id) : null,
      type: row.type as CreditLedgerEntry["type"],
      amount: Number(row.amount),
      metadata: row.metadata ? String(row.metadata) : null,
      created_at: String(row.created_at),
    };
  }

  async getBalance(userId: string): Promise<number> {
    const rs = await this.client.execute({
      sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
      args: [userId],
    });
    if (rs.rows.length === 0) {
      throw new NotFoundError(`User ${userId} not found`);
    }
    return Number(rs.rows[0].credits_balance);
  }

  async listLedgerForUser(userId: string, limit: number = 50): Promise<CreditLedgerEntry[]> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?;",
      args: [userId, limit],
    });
    return rs.rows.map((r) => this.mapRow(r));
  }

  /**
   * Atomically reserve credits for a generation.
   * Enforces:
   * 1. Balance must be >= amount (fails atomic conditional UPDATE otherwise)
   * 2. Exactly one reservation per generation via unique constraint
   */
  async reserveCredits(params: {
    userId: string;
    generationId: string;
    amount: number;
    metadata?: Record<string, any>;
  }): Promise<{ balance: number; ledgerEntry: CreditLedgerEntry }> {
    const { userId, generationId, amount, metadata } = params;
    if (amount <= 0) throw new Error("Reservation amount must be strictly positive");

    const now = new Date().toISOString();
    const ledgerId = nanoid();

    const maxRetries = 10;
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;
      let tx;
      try {
        tx = await this.client.transaction("write");
      } catch (err: any) {
        if (
          (err?.code === "SQLITE_BUSY" || err?.message?.includes("database is locked")) &&
          attempt < maxRetries
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
          continue;
        }
        throw err;
      }

      try {
        // 1. Conditional update ensures credits_balance >= amount atomically
        const updateRs = await tx.execute({
          sql: `
            UPDATE users
            SET credits_balance = credits_balance - ?, updated_at = ?
            WHERE id = ? AND credits_balance >= ?;
          `,
          args: [amount, now, userId, amount],
        });

        if (updateRs.rowsAffected === 0) {
          // Find current balance to report exact deficit
          const userRs = await tx.execute({
            sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
            args: [userId],
          });
          await tx.rollback();
          if (userRs.rows.length === 0) {
            throw new NotFoundError(`User ${userId} not found`);
          }
          const currentBalance = Number(userRs.rows[0].credits_balance);
          throw new InsufficientCreditsError(amount, currentBalance);
        }

        // 2. Insert ledger record (-amount)
        try {
          await tx.execute({
            sql: `
              INSERT INTO credit_ledger (
                id, user_id, generation_id, type, amount, metadata, created_at
              ) VALUES (?, ?, ?, 'reservation', ?, ?, ?);
            `,
            args: [
              ledgerId,
              userId,
              generationId,
              -amount,
              metadata ? JSON.stringify(metadata) : null,
              now,
            ],
          });
        } catch (err: any) {
          if (
            err?.message?.includes("UNIQUE constraint failed: credit_ledger.generation_id, credit_ledger.type") ||
            err?.message?.includes("uq_credit_ledger_generation_type")
          ) {
            await tx.rollback();
            throw new DuplicateReservationError(generationId);
          }
          throw err;
        }

        // 3. Query new balance
        const balanceRs = await tx.execute({
          sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
          args: [userId],
        });
        const newBalance = Number(balanceRs.rows[0].credits_balance);

        await tx.commit();

        return {
          balance: newBalance,
          ledgerEntry: {
            id: ledgerId,
            user_id: userId,
            generation_id: generationId,
            stripe_event_id: null,
            type: "reservation",
            amount: -amount,
            metadata: metadata ? JSON.stringify(metadata) : null,
            created_at: now,
          },
        };
      } catch (error: any) {
        if (
          (error?.code === "SQLITE_BUSY" || error?.message?.includes("database is locked")) &&
          attempt < maxRetries
        ) {
          try {
            await tx.rollback();
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
          continue;
        }
        throw error;
      }
    }

    throw new Error("Unable to reserve credits due to high database contention");
  }

  /**
   * Idempotently refund credits for a failed or canceled generation.
   * If already refunded, returns { alreadyRefunded: true } without adding credits again.
   */
  async refundCredits(params: {
    userId: string;
    generationId: string;
    amount: number;
    reason?: string;
  }): Promise<{ balance: number; alreadyRefunded: boolean; ledgerEntry?: CreditLedgerEntry }> {
    const { userId, generationId, amount, reason } = params;
    if (amount <= 0) throw new Error("Refund amount must be strictly positive");

    const now = new Date().toISOString();
    const ledgerId = nanoid();
    const tx = await this.client.transaction("write");

    try {
      // Check if already refunded
      const existingRefund = await tx.execute({
        sql: `
          SELECT * FROM credit_ledger
          WHERE generation_id = ? AND type = 'refund'
          LIMIT 1;
        `,
        args: [generationId],
      });

      if (existingRefund.rows.length > 0) {
        // Already refunded! Return current balance idempotently without double-refunding
        const userRs = await tx.execute({
          sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
          args: [userId],
        });
        await tx.rollback();
        const currentBalance = Number(userRs.rows[0]?.credits_balance ?? 0);
        return {
          balance: currentBalance,
          alreadyRefunded: true,
          ledgerEntry: this.mapRow(existingRefund.rows[0]),
        };
      }

      // Insert refund ledger entry (+amount)
      try {
        await tx.execute({
          sql: `
            INSERT INTO credit_ledger (
              id, user_id, generation_id, type, amount, metadata, created_at
            ) VALUES (?, ?, ?, 'refund', ?, ?, ?);
          `,
          args: [
            ledgerId,
            userId,
            generationId,
            amount,
            reason ? JSON.stringify({ reason }) : null,
            now,
          ],
        });
      } catch (err: any) {
        if (
          err?.message?.includes("UNIQUE constraint failed: credit_ledger.generation_id, credit_ledger.type") ||
          err?.message?.includes("uq_credit_ledger_generation_type")
        ) {
          await tx.rollback();
          const userRs = await this.client.execute({
            sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
            args: [userId],
          });
          return {
            balance: Number(userRs.rows[0]?.credits_balance ?? 0),
            alreadyRefunded: true,
          };
        }
        throw err;
      }

      // Increment user balance
      const updateRs = await tx.execute({
        sql: "UPDATE users SET credits_balance = credits_balance + ?, updated_at = ? WHERE id = ?;",
        args: [amount, now, userId],
      });

      if (updateRs.rowsAffected === 0) {
        await tx.rollback();
        throw new NotFoundError(`User ${userId} not found`);
      }

      const balanceRs = await tx.execute({
        sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
        args: [userId],
      });
      const newBalance = Number(balanceRs.rows[0].credits_balance);

      await tx.commit();

      return {
        balance: newBalance,
        alreadyRefunded: false,
        ledgerEntry: {
          id: ledgerId,
          user_id: userId,
          generation_id: generationId,
          stripe_event_id: null,
          type: "refund",
          amount: amount,
          metadata: reason ? JSON.stringify({ reason }) : null,
          created_at: now,
        },
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Idempotently record a Stripe purchase event and credit user account.
   * If stripe_event_id was already applied, returns { alreadyProcessed: true }.
   */
  async recordStripePurchase(params: {
    userId: string;
    stripeEventId: string;
    amount: number;
    metadata?: Record<string, any>;
  }): Promise<{ balance: number; alreadyProcessed: boolean; ledgerEntry?: CreditLedgerEntry }> {
    const { userId, stripeEventId, amount, metadata } = params;
    if (amount <= 0) throw new Error("Purchase credit amount must be strictly positive");

    const now = new Date().toISOString();
    const ledgerId = nanoid();
    const tx = await this.client.transaction("write");

    try {
      // Check if this Stripe event was already recorded
      const existing = await tx.execute({
        sql: "SELECT * FROM credit_ledger WHERE stripe_event_id = ? LIMIT 1;",
        args: [stripeEventId],
      });

      if (existing.rows.length > 0) {
        const userRs = await tx.execute({
          sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
          args: [userId],
        });
        await tx.rollback();
        return {
          balance: Number(userRs.rows[0]?.credits_balance ?? 0),
          alreadyProcessed: true,
          ledgerEntry: this.mapRow(existing.rows[0]),
        };
      }

      // Insert purchase ledger record (+amount)
      try {
        await tx.execute({
          sql: `
            INSERT INTO credit_ledger (
              id, user_id, stripe_event_id, type, amount, metadata, created_at
            ) VALUES (?, ?, ?, 'purchase', ?, ?, ?);
          `,
          args: [
            ledgerId,
            userId,
            stripeEventId,
            amount,
            metadata ? JSON.stringify(metadata) : null,
            now,
          ],
        });
      } catch (err: any) {
        if (
          err?.message?.includes("UNIQUE constraint failed: credit_ledger.stripe_event_id") ||
          err?.message?.includes("uq_credit_ledger_stripe_event")
        ) {
          await tx.rollback();
          const userRs = await this.client.execute({
            sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
            args: [userId],
          });
          return {
            balance: Number(userRs.rows[0]?.credits_balance ?? 0),
            alreadyProcessed: true,
          };
        }
        throw err;
      }

      // Increment balance
      const updateRs = await tx.execute({
        sql: "UPDATE users SET credits_balance = credits_balance + ?, updated_at = ? WHERE id = ?;",
        args: [amount, now, userId],
      });

      if (updateRs.rowsAffected === 0) {
        await tx.rollback();
        throw new NotFoundError(`User ${userId} not found`);
      }

      const balanceRs = await tx.execute({
        sql: "SELECT credits_balance FROM users WHERE id = ? LIMIT 1;",
        args: [userId],
      });
      const newBalance = Number(balanceRs.rows[0].credits_balance);

      await tx.commit();

      return {
        balance: newBalance,
        alreadyProcessed: false,
        ledgerEntry: {
          id: ledgerId,
          user_id: userId,
          generation_id: null,
          stripe_event_id: stripeEventId,
          type: "purchase",
          amount: amount,
          metadata: metadata ? JSON.stringify(metadata) : null,
          created_at: now,
        },
      };
    } catch (error) {
      throw error;
    }
  }
}
