/**
 * Online SQLite backup (P4-OPS-07).
 *
 * The shell wrapper at `scripts/db-backup.sh` is the canonical entry
 * point for cron; this module exists so `pnpm db:backup` can run the
 * same operation without depending on the system `sqlite3` CLI being
 * installed — useful inside the slim Docker runtime image.
 *
 * Strategy: the CLI launcher first acquires the canonical writer lease, then
 * opens the DB, runs `VACUUM INTO 'target'`, verifies the snapshot contains
 * schema rows, and sweeps backups past the retention window. Function callers
 * inside the supervised API reuse that already-authorized writer process.
 *
 * Restore drill is documented in `docs/RUNBOOK.md §7`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRawSqlite, closeDb } from "./client";

export interface BackupOptions {
  /** Directory to write backups into. Created if absent. */
  backupDir?: string;
  /** Delete backups older than this many days. Default 90. */
  retentionDays?: number;
  /** Optional explicit timestamp for the filename (mostly for tests). */
  timestamp?: string;
  /** Snapshot append-only logs + run artifacts beside the SQLite backup. */
  includeEvidence?: boolean;
}

export interface BackupResult {
  /** Absolute path of the new backup file. */
  target: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Backup files removed by the retention sweep. */
  removed: string[];
  /** Directory containing the matching logs/artifacts snapshot. */
  evidenceTarget: string | null;
  evidenceSizeBytes: number;
}

const DEFAULT_RETENTION_DAYS = 90;

function configuredRetentionDays(): number {
  const raw = process.env.BACKUP_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("BACKUP_RETENTION_DAYS must be a positive integer");
  }
  return value;
}

function defaultBackupDir(): string {
  if (process.env.AGENTIC_BACKUP_DIR?.trim()) {
    return path.resolve(process.env.AGENTIC_BACKUP_DIR.trim());
  }
  const dataDir = process.env.AGENTIC_DATA_DIR ?? "./data";
  return path.join(dataDir, "backups");
}

function directorySize(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(candidate);
    else if (entry.isFile()) total += fs.statSync(candidate).size;
  }
  return total;
}

function timestampUtc(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

export function backupDatabase(opts: BackupOptions = {}): BackupResult {
  const backupDir = opts.backupDir ?? defaultBackupDir();
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const ts = opts.timestamp ?? timestampUtc();

  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `agentic-${ts}.db`);

  const sqlite = getRawSqlite();
  // `VACUUM INTO` requires the target file NOT to exist. Allow caller to
  // pre-position it by deleting first (idempotent on retries within the
  // same second).
  if (fs.existsSync(target)) fs.unlinkSync(target);

  // VACUUM INTO with a string literal — sqlite doesn't accept parameters
  // here; escape single quotes to be safe.
  const literal = target.replace(/'/g, "''");
  sqlite.exec(`VACUUM INTO '${literal}'`);

  // Verify the snapshot has rows in sqlite_master.
  const Database = sqlite.constructor as new (
    p: string,
    opts?: object,
  ) => typeof sqlite;
  const probe = new Database(target, { readonly: true });
  try {
    const row = probe
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master")
      .get() as { c: number } | undefined;
    if (!row || row.c === 0) {
      probe.close();
      fs.unlinkSync(target);
      throw new Error("backup verification failed: 0 schema rows in snapshot");
    }
  } finally {
    probe.close();
  }

  const stat = fs.statSync(target);
  const includeEvidence = opts.includeEvidence ?? true;
  const evidenceTarget = includeEvidence
    ? path.join(backupDir, `agentic-${ts}-evidence`)
    : null;
  if (evidenceTarget) {
    fs.rmSync(evidenceTarget, { recursive: true, force: true });
    fs.mkdirSync(evidenceTarget, { recursive: true });
    const evidenceRoots = [
      {
        name: "logs",
        source: path.resolve(process.env.AGENTIC_LOGS_DIR ?? "./logs"),
      },
      {
        name: "artifacts",
        source: path.resolve(
          process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts",
        ),
      },
    ];
    for (const root of evidenceRoots) {
      if (!fs.existsSync(root.source)) continue;
      fs.cpSync(root.source, path.join(evidenceTarget, root.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    fs.writeFileSync(
      path.join(evidenceTarget, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          database: path.basename(target),
          evidence: evidenceRoots.map((root) => ({
            name: root.name,
            source: root.source,
            included: fs.existsSync(root.source),
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  // Retention sweep — delete files older than retentionDays.
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const removed: string[] = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.startsWith("agentic-") || !name.endsWith(".db")) continue;
    const p = path.join(backupDir, name);
    try {
      const s = fs.statSync(p);
      if (s.mtimeMs < cutoff) {
        fs.unlinkSync(p);
        removed.push(p);
        const matchingEvidence = path.join(
          backupDir,
          `${name.slice(0, -3)}-evidence`,
        );
        if (fs.existsSync(matchingEvidence)) {
          fs.rmSync(matchingEvidence, { recursive: true, force: true });
          removed.push(matchingEvidence);
        }
      }
    } catch {
      /* race with concurrent prune — ignore */
    }
  }

  return {
    target,
    sizeBytes: stat.size,
    removed,
    evidenceTarget,
    evidenceSizeBytes: evidenceTarget ? directorySize(evidenceTarget) : 0,
  };
}

// CLI entrypoint — `pnpm --filter @agentic/db exec tsx src/backup.ts`.
const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const res = backupDatabase({ retentionDays: configuredRetentionDays() });
    console.log(
      `[db:backup] ok target=${res.target} size=${res.sizeBytes} evidence=${res.evidenceTarget ?? "disabled"} evidence_size=${res.evidenceSizeBytes} pruned=${res.removed.length}`,
    );
    closeDb();
  } catch (err) {
    console.error("[db:backup] FAILED", err);
    process.exit(1);
  }
}
