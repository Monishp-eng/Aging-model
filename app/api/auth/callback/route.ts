import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { waitUntil } from "@vercel/functions";
import { dub } from "@/lib/dub";
import { getSafeRedirectPath } from "@/lib/auth/redirects";
import { ensureDatabaseInitialized, getUsersRepository } from "@/lib/db";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const searchParams = url.searchParams;
  const origin = url.origin;

  // Validate redirect destination against open redirect attacks
  const safeNext = getSafeRedirectPath(searchParams.get("next"), "/");
  const code = searchParams.get("code");
  const authError = searchParams.get("error");

  if (authError) {
    console.warn("OAuth provider returned an error:", authError);
    return NextResponse.redirect(new URL("/auth/auth-code-error", origin));
  }

  if (code) {
    try {
      const supabase = createClient(cookies());
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error && data?.user) {
        const { user } = data;

        // Synchronize authenticated user with SQLite database
        try {
          await ensureDatabaseInitialized();
          const usersRepo = getUsersRepository();
          await usersRepo.syncFromAuth({
            authProviderUserId: user.id,
            email: user.email || "",
            name: user.user_metadata?.full_name || user.user_metadata?.name || null,
            image: user.user_metadata?.avatar_url || null,
          });
        } catch (dbError) {
          console.error("Failed to synchronize user into SQLite on auth callback:", dbError);
          // Non-fatal: session is valid, user will sync on subsequent requests
        }

        // Referral tracking
        const clickId =
          cookies().get("dub_id")?.value || cookies().get("dclid")?.value;
        const isNewUser =
          new Date(user.created_at) > new Date(Date.now() - 10 * 60 * 1000);

        if (clickId && isNewUser) {
          waitUntil(
            dub.track.lead({
              clickId,
              eventName: "Sign Up",
              customerId: user.id,
              customerName: user.user_metadata?.name,
              customerEmail: user.email,
              customerAvatar: user.user_metadata?.avatar_url,
            }),
          );
          cookies().delete("dub_id");
          cookies().delete("dclid");
        }

        // Safely redirect to the validated local path
        return NextResponse.redirect(new URL(safeNext, origin));
      } else if (error) {
        console.error("Supabase exchangeCodeForSession failed:", error.message);
      }
    } catch (err) {
      console.error("Exception during OAuth code exchange:", err);
    }
  }

  // Redirect to the error page on failure or missing code
  return NextResponse.redirect(new URL("/auth/auth-code-error", origin));
}
