import { getDbClient, runMigrations, closeDbClient } from "../lib/db";

async function main() {
  console.log("Applying SQLite database migrations...");
  const client = getDbClient();
  try {
    const result = await runMigrations(client);
    if (result.applied.length > 0) {
      console.log(`Successfully applied migrations: ${result.applied.join(", ")}`);
    } else {
      console.log("Database schema is already up to date.");
    }
    if (result.alreadyApplied.length > 0) {
      console.log(`Previously applied: ${result.alreadyApplied.join(", ")}`);
    }
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await closeDbClient(client);
  }
}

main();
