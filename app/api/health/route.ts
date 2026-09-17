import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Liveness endpoint: fast, unauthenticated, zero external dependency.
 * Indicates whether the application process is running and able to handle HTTP traffic.
 */
export async function GET() {
  const config = getServerConfig();

  const responseBody = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    release: {
      version: config.observability.releaseVersion,
      commit: config.observability.commitSha,
      env: config.env,
    },
  };

  return NextResponse.json(responseBody, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Content-Type": "application/json",
    },
  });
}
