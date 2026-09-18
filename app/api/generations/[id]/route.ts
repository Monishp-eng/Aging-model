import { NextRequest, NextResponse } from "next/server";
import { ensureDatabaseInitialized, getGenerationsRepository } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import { validateGenerationId } from "@/lib/validation";
import { getAuthorizedGenerationAsset, isGenerationExpired } from "@/lib/storage";
import {
  checkRateLimit,
  RATE_LIMIT_POLICIES,
  getRateLimitHeaders,
} from "@/lib/security";
import { isTerminalState } from "@/lib/generation/lifecycle";
import { reconcileGeneration } from "@/lib/generation/reconciliation";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // 1. Authenticate user
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  // Rate limiting on status polling
  const rateLimit = await checkRateLimit(
    `polling:${auth.user.id}`,
    RATE_LIMIT_POLICIES.pollingIp,
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many polling requests" },
      { status: 429, headers: getRateLimitHeaders(rateLimit) },
    );
  }

  // 2. Validate generation ID format
  let validatedId: string;
  try {
    validatedId = validateGenerationId(params.id);
  } catch {
    return NextResponse.json(
      { error: "Invalid generation ID format" },
      { status: 400 },
    );
  }

  await ensureDatabaseInitialized();
  const repo = getGenerationsRepository();

  // 3. Ownership authorization boundary (IDOR / BOLA prevention)
  let generation = await repo.getGenerationForUser(validatedId, auth.user.id);
  if (!generation) {
    return NextResponse.json(
      { error: "Generation not found" },
      { status: 404 },
    );
  }

  // If generation is actively queued/processing, reconcile with provider
  // This guarantees recovery in local development and environments without HTTPS webhooks
  if (!isTerminalState(generation.status)) {
    try {
      await reconcileGeneration(generation.id);
      const refreshed = await repo.getGenerationForUser(validatedId, auth.user.id);
      if (refreshed) {
        generation = refreshed;
      }
    } catch (err) {
      console.warn(`[Polling Reconciliation Warning] Failed to reconcile ${generation.id}:`, err);
    }
  }

  // 4. Expiration and signed asset resolution
  const expired = isGenerationExpired(generation);
  let inputUrl: string | null = null;
  let outputUrl: string | null = null;
  let portraitUrl: string | null = null;

  if (!expired) {
    try {
      const inputAsset = await getAuthorizedGenerationAsset(
        auth.user.id,
        generation.id,
        "input",
      );
      inputUrl = inputAsset.signedUrl;

      if (generation.output_path) {
        const outputAsset = await getAuthorizedGenerationAsset(
          auth.user.id,
          generation.id,
          "output",
        );
        outputUrl = outputAsset.signedUrl;

        try {
          const portraitAsset = await getAuthorizedGenerationAsset(
            auth.user.id,
            generation.id,
            "portrait",
          );
          portraitUrl = portraitAsset.signedUrl;
        } catch {
          portraitUrl = outputUrl;
        }
      }
    } catch (err) {
      console.warn(
        `[Asset Resolution Warning] Could not resolve signed URLs for ${generation.id}:`,
        err,
      );
    }
  }

  // 5. Controlled response without sensitive provider secrets
  const responseData = {
    id: generation.id,
    status: generation.status,
    inputUrl,
    outputUrl,
    portraitUrl,
    failed: generation.status === "failed",
    expired,
    errorCode: generation.error_code,
    errorMessage: generation.error_message,
    createdAt: generation.created_at,
    updatedAt: generation.updated_at,
  };

  return NextResponse.json(responseData, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    },
  });
}
