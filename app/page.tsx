import HomePage from "@/components/home-page";
import { ensureDatabaseInitialized, getGenerationsRepository } from "@/lib/db";

export const revalidate = 60;

async function getCount(): Promise<number> {
  try {
    await ensureDatabaseInitialized();
    return await getGenerationsRepository().countTotalGenerations();
  } catch (error) {
    console.error("Error fetching generation count:", error);
    return 0;
  }
}

export default async function Home() {
  const count = await getCount();

  return <HomePage count={count} />;
}
