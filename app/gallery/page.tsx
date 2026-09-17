import { GalleryPage } from "@/app/gallery/gallery-page";
import { ensureDatabaseInitialized, getGenerationsRepository } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import { getAuthorizedGenerationAsset, isGenerationExpired } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function Gallery() {
  await ensureDatabaseInitialized();

  const auth = await getAuthenticatedUser();
  if (!auth) {
    return <GalleryPage data={[]} />;
  }

  const user = auth.user;

  const generationsRepo = getGenerationsRepository();
  const generations = await generationsRepo.listForUser(user.id, {
    status: "succeeded",
  });

  const data = await Promise.all(
    generations.map(async (g) => {
      const expired = isGenerationExpired(g);
      let inputUrl = "";
      let outputUrl: string | null = null;

      if (!expired) {
        try {
          const inputAsset = await getAuthorizedGenerationAsset(user.id, g.id, "input");
          inputUrl = inputAsset.signedUrl;
          if (g.output_path) {
            const outputAsset = await getAuthorizedGenerationAsset(user.id, g.id, "output");
            outputUrl = outputAsset.signedUrl;
          }
        } catch (err) {
          console.warn(`Failed to resolve asset URLs for gallery item ${g.id}:`, err);
        }
      }

      return {
        id: g.id,
        input: inputUrl,
        output: outputUrl,
        failed: g.status === "failed",
        expired,
        created_at: g.created_at,
        user_id: g.user_id,
      };
    }),
  );

  return <GalleryPage data={data} />;
}
