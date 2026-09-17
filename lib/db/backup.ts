import fs from "node:fs";
import path from "node:path";
import { Client, createClient } from "@libsql/client";
import { getDbClient, resolveDatabaseUrl } from "./client";
import { logger } from "../observability/logger";

export interface BackupResult {
  backupPath: string;
  sizeBytes: number;
  tableCount: number;
  durationMs: number;
  timestamp: string;
  integrity: string;
}

export interface RestoreResult {
  targetPath: string;
  tableCount: number;
  integrity: string;
  durationMs: number;
  timestamp: string;
}

/**
 * Creates a consistent, verified SQLite backup.
 * Flushes WAL logs and uses VACUUM INTO for consistent snapshot.
 */
export async function createBackup(options: {
  destinationDir?: string;
  client?: Client;
  customFilename?: string;
} = {}): Promise<BackupResult> {
  const startTime = Date.now();
  const client = options.client || getDbClient();

  const destDir = options.destinationDir || path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = options.customFilename || `extrapolate-backup-${timestamp}.db`;
  const backupPath = path.join(destDir, filename);

  // Normalize path for SQL query on Windows
  const normalizedBackupPath = backupPath.replace(/\\/g, "/");

  logger.info("Starting SQLite database backup", { backupPath: normalizedBackupPath });

  // 1. Checkpoint WAL logs to ensure all transactions are flushed to disk
  try {
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (err: any) {
    logger.warn("wal_checkpoint pragma warning:", { error: err?.message });
  }

  // 2. Perform atomic vacuum snapshot into target file
  let vacuumSuccess = false;
  try {
    // If file exists, remove first so VACUUM INTO doesn't fail
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    await client.execute(`VACUUM INTO '${normalizedBackupPath}';`);
    vacuumSuccess = true;
  } catch (err: any) {
    logger.warn("VACUUM INTO failed, falling back to direct filesystem copy", {
      error: err?.message,
    });
  }

  if (!vacuumSuccess) {
    // Fallback: Resolve source db file path and copy directly
    const dbUrl = resolveDatabaseUrl();
    if (!dbUrl.startsWith("file:")) {
      throw new Error(`Cannot backup non-file SQLite database URL: ${dbUrl}`);
    }
    const sourceFilePath = path.resolve(dbUrl.replace(/^file:/, ""));
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error(`Source database file does not exist: ${sourceFilePath}`);
    }
    fs.copyFileSync(sourceFilePath, backupPath);
  }

  // 3. Verify backup file existence and size
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file was not created at ${backupPath}`);
  }
  const stat = fs.statSync(backupPath);

  // 4. Verify integrity of newly created backup using an isolated client
  const backupClient = createClient({ url: `file:${normalizedBackupPath}` });
  let integrity = "unknown";
  let tableCount = 0;

  try {
    const integrityRes = await backupClient.execute("PRAGMA integrity_check;");
    integrity = String(integrityRes.rows[0]?.[0] || "unknown");

    const tablesRes = await backupClient.execute(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
    );
    tableCount = Number(tablesRes.rows[0]?.count ?? 0);
  } finally {
    backupClient.close();
  }

  if (integrity !== "ok") {
    throw new Error(`Backup integrity check failed with status: ${integrity}`);
  }

  const durationMs = Date.now() - startTime;
  const result: BackupResult = {
    backupPath,
    sizeBytes: stat.size,
    tableCount,
    durationMs,
    timestamp: new Date().toISOString(),
    integrity,
  };

  logger.info("SQLite database backup completed successfully", result);

  return result;
}

/**
 * Restores a SQLite backup into target database path with safety pre-restore copy
 * and full integrity verification.
 */
export async function restoreBackup(options: {
  backupPath: string;
  targetPath?: string;
}): Promise<RestoreResult> {
  const startTime = Date.now();
  const { backupPath } = options;

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file does not exist: ${backupPath}`);
  }

  // Normalize paths
  const normalizedBackupPath = backupPath.replace(/\\/g, "/");

  // 1. Verify backup file integrity prior to restoring
  const backupCheckClient = createClient({ url: `file:${normalizedBackupPath}` });
  let backupIntegrity = "unknown";
  let tableCount = 0;
  try {
    const checkRes = await backupCheckClient.execute("PRAGMA integrity_check;");
    backupIntegrity = String(checkRes.rows[0]?.[0] || "unknown");

    const tablesRes = await backupCheckClient.execute(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
    );
    tableCount = Number(tablesRes.rows[0]?.count ?? 0);
  } finally {
    backupCheckClient.close();
  }

  if (backupIntegrity !== "ok") {
    throw new Error(`Source backup file failed integrity check: ${backupIntegrity}`);
  }

  // 2. Resolve destination target path
  let targetPath = options.targetPath;
  if (!targetPath) {
    const dbUrl = resolveDatabaseUrl();
    if (dbUrl.startsWith("file:")) {
      targetPath = path.resolve(dbUrl.replace(/^file:/, ""));
    } else {
      targetPath = path.resolve(process.cwd(), "data", "extrapolate.db");
    }
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 3. Safety: If target database file already exists, create pre-restore snapshot
  if (fs.existsSync(targetPath)) {
    const preRestoreBackup = `${targetPath}.pre-restore-${Date.now()}`;
    fs.copyFileSync(targetPath, preRestoreBackup);
    logger.info("Existing database preserved before restore", { preRestoreBackup });
  }

  // 4. Safely overwrite target database
  fs.copyFileSync(backupPath, targetPath);

  // 5. Clean up old WAL and SHM files to ensure clean state
  const targetWal = `${targetPath}-wal`;
  const targetShm = `${targetPath}-shm`;
  if (fs.existsSync(targetWal)) fs.unlinkSync(targetWal);
  if (fs.existsSync(targetShm)) fs.unlinkSync(targetShm);

  // 6. Verify restored database
  const normalizedTargetPath = targetPath.replace(/\\/g, "/");
  const restoredClient = createClient({ url: `file:${normalizedTargetPath}` });
  let restoredIntegrity = "unknown";
  try {
    const checkRes = await restoredClient.execute("PRAGMA integrity_check;");
    restoredIntegrity = String(checkRes.rows[0]?.[0] || "unknown");
  } finally {
    restoredClient.close();
  }

  if (restoredIntegrity !== "ok") {
    throw new Error(`Restored database failed integrity check: ${restoredIntegrity}`);
  }

  const durationMs = Date.now() - startTime;
  const result: RestoreResult = {
    targetPath,
    tableCount,
    integrity: restoredIntegrity,
    durationMs,
    timestamp: new Date().toISOString(),
  };

  logger.info("SQLite database restore completed successfully", result);

  return result;
}
