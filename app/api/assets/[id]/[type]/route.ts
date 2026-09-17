import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth";
import { validateGenerationId } from "@/lib/validation";
import {
  getAuthorizedGenerationAsset,
  AssetExpiredError,
  StorageNotFoundError,
  StorageUnauthorizedError,
} from "@/lib/storage";
import {
  checkRateLimit,
  RATE_LIMIT_POLICIES,
  getRateLimitHeaders,
} from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; type: string } },
) {
  // 1. Validate route params
  const { id, type } = params;

  let generationId: string;
  try {
    generationId = validateGenerationId(id);
  } catch {
    return new NextResponse(JSON.stringify({ error: "Invalid generation ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (type !== "input" && type !== "output") {
    return new NextResponse(
      JSON.stringify({ error: "Invalid asset type. Supported types: 'input', 'output'" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 2. Authenticate user
  let auth;
  try {
    auth = await requireAuthenticatedUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new NextResponse(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new NextResponse(JSON.stringify({ error: "Authentication failure" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Rate limiting on asset access
  const rateLimit = await checkRateLimit(
    `asset:${auth.user.id}`,
    RATE_LIMIT_POLICIES.assetDownloadUser,
  );
  if (!rateLimit.allowed) {
    return new NextResponse(
      JSON.stringify({ error: "Too many asset download requests" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          ...getRateLimitHeaders(rateLimit),
        },
      },
    );
  }

  // 3. Resolve authorized short-lived asset URL
  try {
    const { signedUrl } = await getAuthorizedGenerationAsset(
      auth.user.id,
      generationId,
      type as "input" | "output",
    );

    // 4. Redirect to signed asset URL with strict private caching directives
    const response = NextResponse.redirect(signedUrl, 307);
    response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    response.headers.set("Pragma", "no-cache");
    return response;
  } catch (err: any) {
    if (err instanceof AssetExpiredError) {
      return new NextResponse(
        JSON.stringify({
          error: "Asset expired",
          message: err.message,
        }),
        {
          status: 410,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (err instanceof StorageNotFoundError) {
      return new NextResponse(JSON.stringify({ error: err.message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (err instanceof StorageUnauthorizedError) {
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.error(`[Asset delivery error] generationId=${generationId} type=${type}:`, err);
    return new NextResponse(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
