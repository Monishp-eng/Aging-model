"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureDatabaseInitialized,
  getUsersRepository,
  getGenerationsRepository,
} from "@/lib/db";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth";
import { validateDeleteConfirmation } from "@/lib/validation";
import { deleteUserStorageAssets } from "@/lib/storage";

type FormState = {
  message: string;
  status: number;
};

export async function deleteAccount(prevState: FormState, formData: FormData) {
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
  const authProviderUserId = auth.authProviderUserId;

  // 2. Validate explicit user intent confirmation
  const confirmation = formData.get("deleteConfirmation");
  if (!validateDeleteConfirmation(confirmation)) {
    return {
      message: "Confirmation failed. Please type 'delete my account' exactly.",
      status: 400,
    };
  }

  const usersRepo = getUsersRepository();
  const generationsRepo = getGenerationsRepository();

  // 3. Mark deletion pending to block any new generations or purchases
  try {
    await usersRepo.markDeletionPending(user.id);
  } catch (err: any) {
    console.error("Failed to mark deletion pending:", err);
    return {
      message: "Unable to initiate account deletion. Please try again.",
      status: 500,
    };
  }

  // 4. Cancel in-flight generations and mark all generation assets cleaned up
  try {
    await generationsRepo.markAllForUserCleanedUp(user.id);
  } catch (err: any) {
    console.error("Failed to update user generations for deletion:", err);
  }

  // 5. Recursively discover and delete all user files in storage (input, output, temp)
  const { deletedCount, errors: storageErrors } = await deleteUserStorageAssets(user.id);
  if (storageErrors.length > 0) {
    console.error("Storage errors during account deletion:", storageErrors);
    await usersRepo.recordDeletionError(user.id, storageErrors.join("; "));
    return {
      message: "An error occurred while removing your files. Please try again to complete deletion.",
      status: 500,
    };
  }

  // 6. Delete user from Supabase Auth admin
  const supabaseAdmin = createAdminClient();
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(authProviderUserId);
  if (deleteError) {
    console.error("Supabase deleteUser error:", deleteError);
    await usersRepo.recordDeletionError(user.id, deleteError.message);
    return {
      message: "Unable to complete authentication account removal. Please try again.",
      status: 500,
    };
  }

  // 7. Complete deletion: Anonymize user PII in SQLite while preserving credit ledger audit trail
  const originalEmail = user.email;
  try {
    await usersRepo.markDeletedWithAnonymization(user.id);
  } catch (err: any) {
    console.error("Failed to mark user deleted in repository:", err);
  }

  console.log(
    `[Account Deletion Complete] userId=${user.id} storageFilesDeleted=${deletedCount}`,
  );

  return {
    message: `Successfully deleted account for ${originalEmail}. All photos and personal data have been removed.`,
    status: 200,
  };
}
