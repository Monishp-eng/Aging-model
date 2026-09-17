import { createClient, Client } from "@libsql/client";
import path from "path";
import fs from "fs";

let globalClient: Client | null = null;

export function resolveDatabaseUrl(customUrl?: string): string {
  if (customUrl) return customUrl;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Default path inside workspace root: ./data/extrapolate.db
  const defaultDir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  const defaultPath = path.join(defaultDir, "extrapolate.db");
  // Normalize Windows backslashes for file: protocol
  return `file:${defaultPath.replace(/\\/g, "/")}`;
}

export function createDatabaseClient(databaseUrl?: string): Client {
  const url = resolveDatabaseUrl(databaseUrl);

  // If using a file URL, ensure parent folder exists
  if (url.startsWith("file:")) {
    const filePath = url.slice("file:".length);
    if (!filePath.startsWith(":memory:")) {
      const dir = path.dirname(path.resolve(filePath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  const client = createClient({ url });

  return client;
}

export async function initializePragmas(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode = WAL;");
  await client.execute("PRAGMA foreign_keys = ON;");
  await client.execute("PRAGMA busy_timeout = 5000;");
}

export function getDbClient(customUrl?: string): Client {
  if (customUrl) {
    return createDatabaseClient(customUrl);
  }
  if (!globalClient) {
    globalClient = createDatabaseClient();
  }
  return globalClient;
}

// For test teardown and resource cleanup
export async function closeDbClient(client?: Client): Promise<void> {
  const c = client || globalClient;
  if (c) {
    c.close();
    if (!client) globalClient = null;
  }
}
