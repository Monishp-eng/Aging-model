import { Client } from "@libsql/client";
import { User, NotFoundError } from "../types";
import { nanoid } from "nanoid";

export class UsersRepository {
  constructor(private client: Client) {}

  private mapRow(row: any): User {
    return {
      id: String(row.id),
      auth_provider_user_id: String(row.auth_provider_user_id),
      email: String(row.email),
      name: row.name ? String(row.name) : null,
      image: row.image ? String(row.image) : null,
      stripe_customer_id: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
      credits_balance: Number(row.credits_balance),
      deletion_requested_at: row.deletion_requested_at ? String(row.deletion_requested_at) : null,
      deletion_status: row.deletion_status as User["deletion_status"],
      deleted_at: row.deleted_at ? String(row.deleted_at) : null,
      deletion_error: row.deletion_error ? String(row.deletion_error) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async findById(id: string): Promise<User | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM users WHERE id = ? LIMIT 1;",
      args: [id],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async findByAuthProviderId(authProviderUserId: string): Promise<User | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM users WHERE auth_provider_user_id = ? LIMIT 1;",
      args: [authProviderUserId],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<User | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM users WHERE stripe_customer_id = ? LIMIT 1;",
      args: [stripeCustomerId],
    });
    if (rs.rows.length === 0) return null;
    return this.mapRow(rs.rows[0]);
  }

  async create(data: {
    id?: string;
    auth_provider_user_id?: string;
    authProviderUserId?: string;
    email: string;
    name?: string | null;
    image?: string | null;
    stripe_customer_id?: string | null;
    stripeCustomerId?: string | null;
    credits_balance?: number;
    creditsBalance?: number;
  }): Promise<User> {
    const id = data.id || nanoid();
    const now = new Date().toISOString();
    const authProviderId = data.auth_provider_user_id || data.authProviderUserId;
    if (!authProviderId) {
      throw new Error("auth_provider_user_id is required to create a user");
    }
    const credits = data.credits_balance ?? data.creditsBalance ?? 100;
    const stripeCustomerId = data.stripe_customer_id ?? data.stripeCustomerId ?? null;

    await this.client.execute({
      sql: `
        INSERT INTO users (
          id, auth_provider_user_id, email, name, image,
          stripe_customer_id, credits_balance, deletion_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?);
      `,
      args: [
        id,
        authProviderId,
        data.email,
        data.name ?? null,
        data.image ?? null,
        stripeCustomerId,
        credits,
        now,
        now,
      ],
    });

    const created = await this.findById(id);
    if (!created) throw new Error(`User with ID ${id} was not created`);
    return created;
  }

  async syncFromAuth(data: {
    authProviderUserId: string;
    email: string;
    name?: string | null;
    image?: string | null;
  }): Promise<User> {
    const existing = await this.findByAuthProviderId(data.authProviderUserId);
    const now = new Date().toISOString();

    if (existing) {
      await this.client.execute({
        sql: `
          UPDATE users
          SET email = ?, name = COALESCE(?, name), image = COALESCE(?, image), updated_at = ?
          WHERE id = ?;
        `,
        args: [data.email, data.name ?? null, data.image ?? null, now, existing.id],
      });
      return (await this.findById(existing.id))!;
    }

    return this.create({
      auth_provider_user_id: data.authProviderUserId,
      email: data.email,
      name: data.name ?? null,
      image: data.image ?? null,
    });
  }

  async updateStripeCustomerId(userId: string, stripeCustomerId: string): Promise<void> {
    const now = new Date().toISOString();
    const rs = await this.client.execute({
      sql: "UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?;",
      args: [stripeCustomerId, now, userId],
    });
    if (rs.rowsAffected === 0) {
      throw new NotFoundError(`User ${userId} not found`);
    }
  }

  async markDeletionPending(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE users
        SET deletion_status = 'pending', deletion_requested_at = ?, deletion_error = NULL, updated_at = ?
        WHERE id = ?;
      `,
      args: [now, now, userId],
    });
  }

  async markDeleted(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE users
        SET deletion_status = 'deleted', deletion_requested_at = COALESCE(deletion_requested_at, ?), deleted_at = ?, updated_at = ?
        WHERE id = ?;
      `,
      args: [now, now, now, userId],
    });
  }

  async markDeletedWithAnonymization(userId: string): Promise<void> {
    const now = new Date().toISOString();
    const anonymizedEmail = `deleted-${userId}@deleted.extrapolate.app`;
    await this.client.execute({
      sql: `
        UPDATE users
        SET
          deletion_status = 'deleted',
          deletion_requested_at = COALESCE(deletion_requested_at, ?),
          deleted_at = ?,
          deletion_error = NULL,
          email = ?,
          name = 'Deleted User',
          image = NULL,
          credits_balance = 0,
          updated_at = ?
        WHERE id = ?;
      `,
      args: [now, now, anonymizedEmail, now, userId],
    });
  }

  async recordDeletionError(userId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `
        UPDATE users
        SET deletion_error = ?, updated_at = ?
        WHERE id = ?;
      `,
      args: [error, now, userId],
    });
  }
}
