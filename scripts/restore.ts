import path from "node:path";
import { restoreBackup } from "../lib/db/backup";
import { closeDbClient } from "../lib/db/client";

async function main() {
  const backupFile = process.argv[2];
  if (!backupFile) {
    console.error("Usage: tsx scripts/restore.ts <path-to-backup.db> [target-database-path]");
    process.exit(1);
  }

  const targetPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  console.log(`Restoring database from: ${backupFile}`);
  if (targetPath) {
    console.log(`Target database path: ${targetPath}`);
  }

  try {
    const result = await restoreBackup({ backupPath: path.resolve(backupFile), targetPath });
    console.log("Database restore completed successfully!");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error("Database restore failed:", error);
    process.exit(1);
  } finally {
    await closeDbClient();
  }
}

main();
