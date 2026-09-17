import { createBackup } from "../lib/db/backup";
import { closeDbClient } from "../lib/db/client";

async function main() {
  console.log("Starting SQLite database backup...");
  try {
    const result = await createBackup();
    console.log("Database backup completed successfully!");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error("Database backup failed:", error);
    process.exit(1);
  } finally {
    await closeDbClient();
  }
}

main();
