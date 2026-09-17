import { NextResponse } from "next/server";
import { getDbClient } from "@/lib/db/client";
import { getServerConfig } from "@/lib/config";
import { logger } from "@/lib/observability";

export const dynamic = "force-dynamic";

export interface ReadinessCheckResult {
  status: "ready" | "not_ready";
  timestamp: string;
  checks: {
    database: "ok" | "error";
    migrations: "ok" | "error";
    config: "ok" | "error";
  };
}

/**
 * Readiness endpoint: verifies critical local dependencies (SQLite connectivity,
 * schema migration presence, configuration completeness) before accepting live traffic.
 * Secure: strictly avoids exposing database paths, secrets, or internal stack traces.
 */
export async function GET() {
  let dbStatus: "ok" | "error" = "error";
  let migrationsStatus: "ok" | "error" = "error";
  let configStatus: "ok" | "error" = "error";

  // 1. Check server configuration
  try {
    const config = getServerConfig();
    if (config) {
      configStatus = "ok";
    }
  } catch (err: any) {
    logger.error("Readiness check: Configuration validation failed", err);
    configStatus = "error";
  }

  // 2. Check SQLite connectivity & migrations
  try {
    const client = getDbClient();
    // Verify connection with simple query
    await client.execute("SELECT 1;");
    dbStatus = "ok";

    // Verify migrations table exists and at least one migration is applied
    const migResult = await client.execute(
      "SELECT count(*) as count FROM migrations;",
    );
    const count = Number(migResult.rows[0]?.count ?? 0);
    if (count > 0) {
      migrationsStatus = "ok";
    } else {
      logger.warn("Readiness check: No applied migrations found in database");
      migrationsStatus = "error";
    }
  } catch (err: any) {
    logger.error("Readiness check: Database verification failed", err);
    dbStatus = "error";
    migrationsStatus = "error";
  }

  const isReady =
    dbStatus === "ok" && migrationsStatus === "ok" && configStatus === "ok";

  const responseBody: ReadinessCheckResult = {
    status: isReady ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks: {
      database: dbStatus,
      migrations: migrationsStatus,
      config: configStatus,
    },
  };

  return NextResponse.json(responseBody, {
    status: isReady ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Content-Type": "application/json",
    },
  });
}
