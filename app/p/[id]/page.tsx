import PhotoPage from "@/app/p/[id]/photo-page";
import { notFound } from "next/navigation";
import { ensureDatabaseInitialized, getGenerationsRepository } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import { validateGenerationId } from "@/lib/validation";
import { getAuthorizedGenerationAsset, isGenerationExpired } from "@/lib/storage";

export const dynamic = "force-dynamic";

async function getData(id: string) {
  let validatedId: string;
  try {
    validatedId = validateGenerationId(id);
  } catch {
    return notFound();
  }

  await ensureDatabaseInitialized();

  // Enforce server-side authentication
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return notFound();
  }

  // Enforce resource ownership at the data-access boundary (BOLA/IDOR prevention)
  const generation = await getGenerationsRepository().getGenerationForUser(
    validatedId,
    auth.user.id,
  );

  if (!generation) {
    return notFound();
  }

  const expired = isGenerationExpired(generation);
  let inputUrl = "";
  let outputUrl: string | null = null;

  if (!expired) {
    try {
      const inputAsset = await getAuthorizedGenerationAsset(auth.user.id, generation.id, "input");
      inputUrl = inputAsset.signedUrl;
      if (generation.output_path) {
        const outputAsset = await getAuthorizedGenerationAsset(auth.user.id, generation.id, "output");
        outputUrl = outputAsset.signedUrl;
      }
    } catch (err) {
      console.warn(`Could not generate signed URLs for generation ${generation.id}:`, err);
    }
  }

  return {
    id: generation.id,
    input: inputUrl,
    output: outputUrl,
    failed: generation.status === "failed",
    expired,
    created_at: generation.created_at,
    user_id: generation.user_id,
  };
}

export default async function Photo({ params }: { params: { id: string } }) {
  const { id } = params;
  const fallbackData = await getData(id);

  return <PhotoPage id={id} data={fallbackData} />;
}
