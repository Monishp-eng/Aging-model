import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  // 1. Resolve or generate request correlation ID
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();

  // Create request headers with correlation ID
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  // 2. Bypass Supabase session refresh for API routes to avoid overhead
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set("x-request-id", requestId);
    return response;
  }

  // 3. For page routes, maintain Supabase session and propagate correlation ID
  try {
    const { supabase, response } = createClient(request);
    await supabase.auth.getUser();
    response.headers.set("x-request-id", requestId);
    return response;
  } catch {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set("x-request-id", requestId);
    return response;
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for static files and images:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public images/assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
