import { NextRequest, NextResponse } from "next/server";
import { ensureDatabaseInitialized, getGenerationsRepository } from "@/lib/db";
import {
  deleteGenerationAssets,
  cleanExpiredTemporaryAssets,
  RETENTION_CONFIG,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

import { getServerConfig } from "@/lib/config";
import { logger, metrics } from "@/lib/observability";

/**
 * Validates the cron secret against environment configuration.
 * Accepts either Bearer token in Authorization header or x-cron-secret header.
 */
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
    logger.error("[Cleanup Cron] CRON_SECRET environment variable is not configured");
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
  return handleCleanup(req);
}

export async function POST(req: NextRequest) {
  return handleCleanup(req);
}

async function handleCleanup(req: NextRequest) {
  const startTime = Date.now();

  // 1. Authenticate request using server-to-server secret
  if (!isAuthorizedCronRequest(req)) {
    return new NextResponse(
      JSON.stringify({ error: "Unauthorized: Invalid or missing cron secret" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  await ensureDatabaseInitialized();
  const generationsRepo = getGenerationsRepository();

  // 2. Fetch bounded batch of expired generations
  const now = new Date().toISOString();
  const expiredGenerations = await generationsRepo.findExpiredGenerations({
    limit: RETENTION_CONFIG.BATCH_SIZE,
    olderThan: now,
  });

  let succeeded = 0;
  let failed = 0;
  const failureDetails: Array<{ id: string; error: string }> = [];

  // 3. Process deletions idempotently
  for (const gen of expiredGenerations) {
    try {
      const deleteResult = await deleteGenerationAssets(gen);
      if (deleteResult.success) {
        await generationsRepo.recordCleanupResult(gen.id, { success: true });
        succeeded++;
      } else {
        await generationsRepo.recordCleanupResult(gen.id, {
          success: false,
          error: deleteResult.error,
        });
        failed++;
        failureDetails.push({ id: gen.id, error: deleteResult.error || "Unknown failure" });
      }
    } catch (err: any) {
      const errorMessage = err?.message || "Storage deletion exception";
      await generationsRepo.recordCleanupResult(gen.id, {
        success: false,
        error: errorMessage,
      });
      failed++;
      failureDetails.push({ id: gen.id, error: errorMessage });
    }
  }

  // 4. Clean expired temporary artifacts in the temp bucket
  let tempCleaned = 0;
  try {
    const tempResult = await cleanExpiredTemporaryAssets(RETENTION_CONFIG.TEMP_ASSET_TTL_HOURS);
    tempCleaned = tempResult.cleanedCount;
  } catch (err: any) {
    console.error("[Cleanup Cron] Temporary assets cleanup error:", err?.message);
  }

  const runId = crypto.randomUUID();
  const durationMs = Date.now() - startTime;

  // Record operational metrics
  metrics.recordCleanup({
    deletedCount: succeeded + tempCleaned,
    failedCount: failed,
    durationMs,
  });

  logger.info("Storage cleanup completed", {
    event: "storage_cleanup.completed",
    run_id: runId,
    deleted: succeeded + tempCleaned,
    failed,
    duration_ms: durationMs,
  });

  console.log(
    `[Cleanup Cron Complete] processed=${expiredGenerations.length} succeeded=${succeeded} failed=${failed} tempCleaned=${tempCleaned} durationMs=${durationMs}`,
  );

  return new NextResponse(
    JSON.stringify({
      success: true,
      runId,
      processed: expiredGenerations.length,
      succeeded,
      failed,
      tempCleaned,
      durationMs,
      failures: failureDetails.length > 0 ? failureDetails : undefined,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
