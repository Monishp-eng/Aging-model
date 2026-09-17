import { getDbClient, seedReferenceData, closeDbClient, runMigrations } from "../lib/db";

async function main() {
  console.log("Seeding SQLite reference data...");
  const client = getDbClient();
  try {
    await runMigrations(client);
    await seedReferenceData(client);
    console.log("Reference data seeded successfully (products and prices initialized).");
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  } finally {
    await closeDbClient(client);
  }
}

main();
