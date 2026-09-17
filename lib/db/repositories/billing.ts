import { Client } from "@libsql/client";
import { Product, Price, ProductWithPrice } from "../types";
import { nanoid } from "nanoid";

export class BillingRepository {
  constructor(private client: Client) {}

  async upsertProduct(data: {
    id?: string;
    stripeProductId: string;
    name: string;
    description?: string | null;
    active?: boolean;
    metadata?: Record<string, any> | string | null;
  }): Promise<Product> {
    const now = new Date().toISOString();
    const id = data.id || data.stripeProductId;
    const active = data.active === undefined || data.active ? 1 : 0;
    const metadataStr =
      typeof data.metadata === "object" && data.metadata !== null
        ? JSON.stringify(data.metadata)
        : (data.metadata as string | null);

    await this.client.execute({
      sql: `
        INSERT INTO products (
          id, stripe_product_id, name, description, active, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stripe_product_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          active = excluded.active,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at;
      `,
      args: [
        id,
        data.stripeProductId,
        data.name,
        data.description ?? null,
        active,
        metadataStr ?? null,
        now,
        now,
      ],
    });

    const rs = await this.client.execute({
      sql: "SELECT * FROM products WHERE stripe_product_id = ? LIMIT 1;",
      args: [data.stripeProductId],
    });
    const row = rs.rows[0];
    return {
      id: String(row.id),
      stripe_product_id: String(row.stripe_product_id),
      name: String(row.name),
      description: row.description ? String(row.description) : null,
      active: Number(row.active),
      metadata: row.metadata ? String(row.metadata) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async deleteProduct(stripeProductId: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM products WHERE stripe_product_id = ?;",
      args: [stripeProductId],
    });
  }

  async upsertPrice(data: {
    id?: string;
    stripePriceId: string;
    stripeProductId: string;
    unitAmount: number;
    currency?: string;
    active?: boolean;
    metadata?: Record<string, any> | string | null;
  }): Promise<Price> {
    const now = new Date().toISOString();
    const id = data.id || data.stripePriceId;
    const active = data.active === undefined || data.active ? 1 : 0;
    const currency = data.currency || "usd";
    const metadataStr =
      typeof data.metadata === "object" && data.metadata !== null
        ? JSON.stringify(data.metadata)
        : (data.metadata as string | null);

    // Look up internal product_id if given stripe_product_id
    const prodRs = await this.client.execute({
      sql: "SELECT id FROM products WHERE stripe_product_id = ? OR id = ? LIMIT 1;",
      args: [data.stripeProductId, data.stripeProductId],
    });
    if (prodRs.rows.length === 0) {
      throw new Error(`Cannot create price: Product ${data.stripeProductId} does not exist`);
    }
    const internalProductId = String(prodRs.rows[0].id);

    await this.client.execute({
      sql: `
        INSERT INTO prices (
          id, stripe_price_id, product_id, unit_amount, currency, active, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stripe_price_id) DO UPDATE SET
          unit_amount = excluded.unit_amount,
          currency = excluded.currency,
          active = excluded.active,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at;
      `,
      args: [
        id,
        data.stripePriceId,
        internalProductId,
        data.unitAmount,
        currency,
        active,
        metadataStr ?? null,
        now,
        now,
      ],
    });

    const rs = await this.client.execute({
      sql: "SELECT * FROM prices WHERE stripe_price_id = ? LIMIT 1;",
      args: [data.stripePriceId],
    });
    const row = rs.rows[0];
    return {
      id: String(row.id),
      stripe_price_id: String(row.stripe_price_id),
      product_id: String(row.product_id),
      unit_amount: Number(row.unit_amount),
      currency: String(row.currency),
      active: Number(row.active),
      metadata: row.metadata ? String(row.metadata) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async deletePrice(stripePriceId: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM prices WHERE stripe_price_id = ?;",
      args: [stripePriceId],
    });
  }

  async listActiveProductsWithPrices(): Promise<ProductWithPrice[]> {
    const rs = await this.client.execute(`
      SELECT 
        products.id AS product_id,
        prices.stripe_price_id AS price_id,
        products.name AS product_name,
        products.description AS product_description,
        prices.unit_amount AS unit_amount,
        products.metadata AS product_metadata
      FROM products
      JOIN prices ON products.id = prices.product_id
      WHERE products.active = 1 AND prices.active = 1
      ORDER BY prices.unit_amount ASC;
    `);

    return rs.rows.map((row) => {
      let credits = 0;
      if (row.product_metadata) {
        try {
          const meta = JSON.parse(String(row.product_metadata));
          credits = Number(meta.credits || 0);
        } catch {}
      }
      return {
        id: String(row.product_id),
        price_id: String(row.price_id),
        name: String(row.product_name),
        description: row.product_description ? String(row.product_description) : "",
        price: Math.round((Number(row.unit_amount) / 100.0) * 100) / 100,
        credits,
      };
    });
  }

  async getActivePriceWithProduct(stripePriceId: string): Promise<ProductWithPrice | null> {
    const rs = await this.client.execute({
      sql: `
        SELECT 
          products.id AS product_id,
          prices.stripe_price_id AS price_id,
          products.name AS product_name,
          products.description AS product_description,
          prices.unit_amount AS unit_amount,
          products.metadata AS product_metadata
        FROM products
        JOIN prices ON products.id = prices.product_id
        WHERE prices.stripe_price_id = ? AND products.active = 1 AND prices.active = 1
        LIMIT 1;
      `,
      args: [stripePriceId],
    });
    if (rs.rows.length === 0) return null;
    const row = rs.rows[0];
    let credits = 0;
    if (row.product_metadata) {
      try {
        const meta = JSON.parse(String(row.product_metadata));
        credits = Number(meta.credits || 0);
      } catch {}
    }
    return {
      id: String(row.product_id),
      price_id: String(row.price_id),
      name: String(row.product_name),
      description: row.product_description ? String(row.product_description) : "",
      price: Math.round((Number(row.unit_amount) / 100.0) * 100) / 100,
      credits,
    };
  }
}
