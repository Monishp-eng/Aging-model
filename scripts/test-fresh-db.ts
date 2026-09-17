import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { runMigrations } from "../lib/db/migrations";
import { initializePragmas } from "../lib/db/client";

async function main() {
  const testDir = path.resolve(process.cwd(), "data", "test-fresh-ci");
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const dbFile = path.join(testDir, "fresh.db");
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  const client = createClient({ url: `file:${dbFile.replace(/\\/g, "/")}` });
  await initializePragmas(client);

  console.log("Applying migrations on empty SQLite database from zero...");
  const result = await runMigrations(client);
  console.log("Applied migrations:", result.applied);

  // Verify tables
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
  console.log("Created tables:", tables.rows.map((r: any) => r.name));

  client.close();
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
  console.log("FRESH DATABASE CI GATE TEST PASSED!");
}

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
