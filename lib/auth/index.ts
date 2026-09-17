import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ensureDatabaseInitialized, getUsersRepository, User } from "@/lib/db";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface AuthenticatedUser {
  /** Supabase Auth user ID (auth_provider_id in SQLite) */
  authProviderUserId: string;
  /** Application user ID (id in SQLite users table) */
  id: string;
  /** User email address */
  email: string;
  /** Complete SQLite user record */
  user: User;
}

/**
 * Resolves the authenticated user from the server-side Supabase session
 * and synchronizes with the SQLite users repository.
 * Returns null if not authenticated or if the user is deactivated/deleted.
 */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  try {
    await ensureDatabaseInitialized();

    const cookieStore = cookies();
    const supabase = createClient(cookieStore);

    // Securely retrieve and verify user from Supabase Auth
    const {
      data: { user: authUser },
      error,
    } = await supabase.auth.getUser();

    if (error || !authUser || !authUser.id) {
      return null;
    }

    const usersRepo = getUsersRepository();
    const dbUser = await usersRepo.syncFromAuth({
      authProviderUserId: authUser.id,
      email: authUser.email || "",
      name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || null,
      image: authUser.user_metadata?.avatar_url || null,
    });

    // If the account has been soft-deleted, deny authentication
    if (dbUser.deletion_status === "deleted") {
      return null;
    }

    return {
      authProviderUserId: authUser.id,
      id: dbUser.id,
      email: dbUser.email,
      user: dbUser,
    };
  } catch (error) {
    console.error("Error in getAuthenticatedUser:", error);
    return null;
  }
}

/**
 * Requires an authenticated user session.
 * Throws UnauthorizedError if unauthenticated or soft-deleted.
 */
export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    throw new UnauthorizedError();
  }
  return auth;
}
