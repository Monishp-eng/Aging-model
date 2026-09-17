"use server";

import crypto from "crypto";
import Replicate from "replicate";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { getDomain } from "@/lib/utils";
import {
  ensureDatabaseInitialized,
  getGenerationsRepository,
  getCreditsRepository,
  InsufficientCreditsError,
} from "@/lib/db";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth";
import {
  validateImageUpload,
  validateAndNormalizeImage,
  ImageValidationError,
} from "@/lib/validation";
import {
  getInputKey,
  createSignedAssetUrl,
  RETENTION_CONFIG,
} from "@/lib/storage";
import {
  transitionGeneration,
  retryWithBackoff,
  classifyReplicateError,
  GENERATION_ERROR_CODES,
} from "@/lib/generation";
import { generateFreeAiAging } from "@/lib/generation/hf-face-aging";
import { checkRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security";

export async function upload(previousState: any, formData: FormData) {
  await ensureDatabaseInitialized();

  // 1. Authenticate user via canonical server-side resolver
  let auth;
  try {
    auth = await requireAuthenticatedUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { message: "Please sign in to continue", status: 401 };
    }
    return { message: "Authentication failure", status: 401 };
  }

  const user = auth.user;

  // Check if account deletion is pending/completed
  if (user.deletion_status === "pending" || user.deletion_status === "deleted") {
    return {
      message: "Account deletion is in progress. New generations are disabled.",
      status: 403,
    };
  }

  // 2. Validate uploaded image file (size, format check)
  const image = formData.get("image") as File;
  const imageValidation = validateImageUpload(image);
  if (!imageValidation.valid) {
    return { message: imageValidation.error || "Invalid image upload", status: 400 };
  }

  // 3. Normalize image: verify magic bytes, dimensions, and strip EXIF/GPS metadata
  const rawBuffer = Buffer.from(await image.arrayBuffer());
  let normalizedImage;
  try {
    normalizedImage = await validateAndNormalizeImage(rawBuffer);
  } catch (err) {
    if (err instanceof ImageValidationError) {
      return { message: err.message, status: 400 };
    }
    console.error("Image normalization failed:", err);
    return { message: "Failed to process and validate image upload", status: 400 };
  }

  const generationsRepo = getGenerationsRepository();
  const creditsRepo = getCreditsRepository();

  // 4. Client Idempotency: Prevent duplicate submissions / spending from double-clicks or retries
  const idempotencyHash = crypto
    .createHash("sha256")
    .update(`${user.id}:${normalizedImage.buffer.toString("base64")}`)
    .digest("hex");

  const existingGeneration = await generationsRepo.findByIdempotencyKey(idempotencyHash);
  if (existingGeneration) {
    const ageSeconds =
      (Date.now() - new Date(existingGeneration.created_at).getTime()) / 1000;
    if (
      ageSeconds < 30 &&
      ["queued", "processing", "succeeded"].includes(existingGeneration.status)
    ) {
      // Re-use active generation without double-debiting credits!
      redirect(`/p/${existingGeneration.id}`);
    } else {
      // Previous attempt failed, expired, or timed out: clear the old idempotency key so the user can re-try safely without foreign key conflicts
      await generationsRepo.clearIdempotencyKey(existingGeneration.id);
    }
  }

  // 5. Rate limiting: enforce user-level request frequency limit
  const rateLimitResult = await checkRateLimit(
    `upload:user:${user.id}`,
    RATE_LIMIT_POLICIES.uploadUser,
  );
  if (!rateLimitResult.allowed) {
    return {
      message: `Too many generation requests. Please wait ${rateLimitResult.retryAfterSeconds} seconds before trying again.`,
      status: 429,
    };
  }

  // 6. Concurrency limiting: prevent more than 2 active concurrent generations per user
  const activeCount = await generationsRepo.countActiveByUser(user.id);
  if (activeCount >= 2) {
    return {
      message: "You already have active generations in progress. Please wait for them to complete before starting a new one.",
      status: 429,
    };
  }

  // 7. Verify user has sufficient credit balance
  const balance = await creditsRepo.getBalance(user.id);
  if (balance < 10) {
    return { message: "Not enough credits, please buy more", status: 402 };
  }

  // 8. Create generation record and atomically reserve 10 credits
  let generation;
  const { nanoid } = await import("nanoid");
  const generationId = nanoid();
  const relativeKey = getInputKey(user.id, generationId, "jpg");

  try {
    generation = await generationsRepo.create({
      id: generationId,
      userId: user.id,
      inputPath: relativeKey,
      creditsReserved: 10,
      initialStatus: "queued",
      clientIdempotencyKey: idempotencyHash,
    });

    // Atomically reserve credits in credit ledger
    await creditsRepo.reserveCredits({
      userId: user.id,
      generationId: generation.id,
      amount: 10,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return { message: "Not enough credits, please buy more", status: 402 };
    }
    console.error("Database error creating generation:", error);
    return { message: "Database error initializing generation. Please try again.", status: 500 };
  }

  const key = generation.id;

  // 7. Upload normalized, metadata-stripped image buffer to private Supabase Storage
  const supabaseAdmin = createAdminClient();

  const { error: storageError } = await supabaseAdmin.storage
    .from("input")
    .upload(relativeKey, normalizedImage.buffer, {
      contentType: normalizedImage.mimeType,
      cacheControl: "3600",
      upsert: true,
    });

  if (storageError) {
    // If storage upload fails, transition generation to failed and refund credits
    await transitionGeneration(generation.id, "failed", {
      errorCode: GENERATION_ERROR_CODES.STORAGE_UPLOAD_FAILED,
      errorMessage: storageError.message,
    });
    await creditsRepo.refundCredits({
      userId: user.id,
      generationId: generation.id,
      amount: 10,
      reason: "Storage upload failure",
    });

    return {
      message: "Unexpected error uploading image, please try again",
      status: 400,
    };
  }

  // 8. Generate short-lived signed URL for Replicate ingestion (1 hour TTL)
  let signedInputUrl: string;
  try {
    signedInputUrl = await createSignedAssetUrl(
      "input",
      relativeKey,
      RETENTION_CONFIG.REPLICATE_SIGNED_URL_TTL_SECONDS,
    );
  } catch (urlError: any) {
    console.error("Failed to generate signed URL for Replicate:", urlError);
    await transitionGeneration(generation.id, "failed", {
      errorCode: GENERATION_ERROR_CODES.STORAGE_SIGN_FAILED,
      errorMessage: urlError?.message,
    });
    await creditsRepo.refundCredits({
      userId: user.id,
      generationId: generation.id,
      amount: 10,
      reason: "Storage sign failure",
    });
    return { message: "Storage error initializing prediction. Please try again.", status: 500 };
  }

  // 9. Dispatch prediction (Replicate with seamless fallback to built-in generator)
  let predictionHandled = false;

  if (process.env.AI_PROVIDER !== "local" && process.env.REPLICATE_API_TOKEN) {
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN || "",
    });

    try {
      const webhookUrl = getDomain(`/api/webhooks/replicate/${key}`);
      const isHttpsWebhook = webhookUrl.startsWith("https://");

      const prediction: any = await retryWithBackoff(
        async () => {
          return await replicate.predictions.create({
            version: "9222a21c181b707209ef12b5e0d7e94c994b58f01c7b2fec075d2e892362f13c",
            input: {
              image: signedInputUrl,
              target_age: "default",
            },
            ...(isHttpsWebhook ? {
              webhook: webhookUrl,
              webhook_events_filter: ["completed"],
            } : {}),
          });
        },
        { maxAttempts: 1, generationId: generation.id },
      );

      if (
        !prediction.error &&
        prediction.status !== "failed" &&
        prediction.status !== "canceled"
      ) {
        // Mark generation as processing with Replicate prediction ID
        await transitionGeneration(generation.id, "processing", {
          replicatePredictionId: prediction.id,
        });
        predictionHandled = true;
      }
    } catch (e: any) {
      console.warn(
        `[Provider Notice] External provider not available (${e?.message || "error"}). Seamlessly running built-in aging generator...`,
      );
    }
  }

  // If external provider was not used or failed (e.g. 402 payment required), run neural AI aging engine
  if (!predictionHandled) {
    try {
      await generateFreeAiAging(
        normalizedImage.buffer,
        user.id,
        generation.id,
      );
    } catch (localErr: any) {
      console.error("Local aging generation exception:", localErr);
      await transitionGeneration(generation.id, "failed", {
        errorCode: GENERATION_ERROR_CODES.REPLICATE_FAILED,
        errorMessage: localErr?.message || "Local generation failed",
      });
      await creditsRepo.refundCredits({
        userId: user.id,
        generationId: generation.id,
        amount: 10,
        reason: "Generation exception",
      });

      return {
        message: "Unexpected error generating gif, please try again",
        status: 500,
      };
    }
  }

  redirect(`/p/${key}`);
}
