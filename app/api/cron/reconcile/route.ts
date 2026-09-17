import { NextRequest, NextResponse } from "next/server";
import { ensureDatabaseInitialized } from "@/lib/db";
import { reconcileStaleGenerations } from "@/lib/generation/reconciliation";

export const dynamic = "force-dynamic";

import { getServerConfig } from "@/lib/config";
import { logger } from "@/lib/observability";

function isAuthorizedCronRequest(req: NextRequest): boolean {
  let cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    try {
      cronSecret = getServerConfig().cron.secret;
    } catch {
      cronSecret = undefined;
    }
  }

  if (!cronSecret) {
    logger.error("[Reconciliation Cron] CRON_SECRET environment variable is not configured");
    return false;
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === cronSecret) return true;
  }

  const customHeader = req.headers.get("x-cron-secret");
  if (customHeader && customHeader.trim() === cronSecret) {
    return true;
  }

  return false;
}

export async function GET(req: NextRequest) {
  return handleReconcile(req);
}

export async function POST(req: NextRequest) {
  return handleReconcile(req);
}

async function handleReconcile(req: NextRequest) {
  // 1. Authenticate request
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing cron secret" },
      { status: 401 },
    );
  }

  await ensureDatabaseInitialized();

  // 2. Parse optional query parameters (batchSize, staleMinutes)
  const searchParams = req.nextUrl.searchParams;
  const batchSize = searchParams.get("batchSize")
    ? parseInt(searchParams.get("batchSize")!, 10)
    : undefined;
  const staleMinutes = searchParams.get("staleMinutes")
    ? parseInt(searchParams.get("staleMinutes")!, 10)
    : undefined;

  try {
    const result = await reconcileStaleGenerations({
      batchSize: Number.isInteger(batchSize) && batchSize! > 0 ? batchSize : undefined,
      staleThresholdMinutes:
        Number.isInteger(staleMinutes) && staleMinutes! > 0 ? staleMinutes : undefined,
    });

    const runId = crypto.randomUUID();

    logger.info("Generation reconciliation completed", {
      event: "generation_reconciliation.completed",
      run_id: runId,
      processed: result.processed,
      reconciled: result.reconciled,
      refunded: result.refunded,
      duration_ms: result.durationMs,
    });

    console.log(
      `[Reconciliation Cron Complete] processed=${result.processed} reconciled=${result.reconciled} refunded=${result.refunded} durationMs=${result.durationMs}`,
    );

    return NextResponse.json({ ...result, runId }, { status: 200 });
  } catch (err: any) {
    logger.error("[Reconciliation Cron Exception]", err);
    console.error("[Reconciliation Cron Exception]", err);
    return NextResponse.json(
      { error: "Internal reconciliation error", message: err?.message },
      { status: 500 },
    );
  }
}
