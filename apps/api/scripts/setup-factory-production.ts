/**
 * Provision a reproducible single-host Agent Factory runtime.
 *
 * The script derives active tenant Inngest identities from the database,
 * creates independent primary/sandbox secrets, resolves infrastructure tags
 * to platform-specific immutable digests, builds the seven repository images,
 * and writes the git-ignored `.env.production` contract consumed by
 * docker-compose.production.yml.  It never prints secret values.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { isIP } from "node:net";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeProductionEnvLine,
  parseProductionEnvText,
} from "./production-env-file";
import {
  acquireSqliteWriterLease,
  inspectSqliteWriterLease,
  recoverSqliteWriterLeaseAfterProof,
  sqliteWriterLeasePath,
  type SqliteWriterLease,
} from "../../../packages/db/src/writer-lease";
import {
  productionImageAttestationKeyId,
  type FactoryProductionImageTopology,
} from "../src/services/agent-factory/production-image-attestation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envPath = path.join(root, ".env.production");
const sourceEnvPath = path.join(root, ".env");
const secretsRoot = path.join(root, ".secrets", "agent-factory");
const apiSecrets = path.join(secretsRoot, "api");
const primaryBrokerSecrets = path.join(secretsRoot, "primary-broker");
const sandboxSecrets = path.join(secretsRoot, "sandbox");
const sandboxBrokerSecrets = path.join(secretsRoot, "sandbox-broker");
const codeactExecutorSecrets = path.join(secretsRoot, "codeact-executor");
const productionImageAttestationTrustRoot = path.join(
  secretsRoot,
  "production-image-attestation",
);
const dataRoot = path.join(root, "data");
const setupLockPath = path.join(dataRoot, ".factory-production-setup.lock");

const SETUP_LOCK_VERSION = 1 as const;
const SETUP_LOCK_HEARTBEAT_MS = 10_000;
const SETUP_LOCK_INCOMPLETE_GRACE_MS = 120_000;

interface SetupLockOwner {
  version: typeof SETUP_LOCK_VERSION;
  token: string;
  pid: number;
  processIdentity: string;
  acquiredAt: string;
  heartbeatAt: string;
}

type OwnerState = "active" | "dead" | "unknown";

export interface ProductionSetupLock {
  readonly path: string;
  /** Aborts as soon as the heartbeat proves this process no longer owns the lock. */
  readonly signal: AbortSignal;
  /** Synchronous ownership fence for every mutation boundary. */
  assertOwned(): void;
  heartbeat(): void;
  release(): void;
}

export interface SetupLockOptions {
  pid?: number;
  now?: () => Date;
  processIdentity?: (pid: number) => string;
  ownerState?: (owner: SetupLockOwner) => OwnerState;
  heartbeatMs?: number;
  incompleteGraceMs?: number;
  startHeartbeat?: boolean;
}

export interface CommandObservation {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export type CommandObserver = (command: string, args: string[]) => CommandObservation;

export interface DatabaseInspection {
  integrity: string[];
  foreignKeyViolations: number;
}

export interface ProductionSetupSafetyDependencies {
  observeCommand?: CommandObserver;
  inspectDatabase?: (filename: string) => Promise<DatabaseInspection>;
  platform?: NodeJS.Platform;
  /** Explicit operator authority. Heartbeat age alone is never sufficient. */
  recoverWriterLease?: boolean;
  /** Setup holds this lease across its long build transaction. */
  ownedWriterLease?: SqliteWriterLease;
}

interface SetupOptions {
  build: boolean;
  pull: boolean;
  forceSecrets: boolean;
  recoverWriterLease: boolean;
}

function options(argv: string[]): SetupOptions {
  const known = new Set([
    "--skip-build",
    "--skip-pull",
    "--rotate-secrets",
    "--recover-sqlite-writer-lease",
  ]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length) throw new Error(`unknown setup argument(s): ${unknown.join(", ")}`);
  return {
    build: !argv.includes("--skip-build"),
    pull: !argv.includes("--skip-pull"),
    forceSecrets: argv.includes("--rotate-secrets"),
    recoverWriterLease: argv.includes("--recover-sqlite-writer-lease"),
  };
}

function hostProcessIdentity(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process id is invalid");
  if (process.platform === "linux") {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const startTimeTicks = afterName[19];
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
      throw new Error(`could not determine Linux start time for pid ${pid}`);
    }
    return `linux:${startTimeTicks}`;
  }
  if (process.platform === "darwin") {
    const observed = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (observed.error) throw observed.error;
    const started = observed.stdout.trim().replace(/\s+/g, " ");
    if (observed.status !== 0 || !started) {
      throw new Error(`could not determine macOS start time for pid ${pid}`);
    }
    return `darwin:${started}`;
  }
  throw new Error(
    `factory production setup locking supports macOS and Linux, not ${process.platform}`,
  );
}

function defaultOwnerState(owner: SetupLockOwner): OwnerState {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
  try {
    return hostProcessIdentity(owner.pid) === owner.processIdentity ? "active" : "dead";
  } catch {
    // A live PID whose start identity cannot be inspected is never safe to
    // reclaim: doing so could let two setup processes mutate the same files.
    return "unknown";
  }
}

function validSetupLockOwner(value: unknown): value is SetupLockOwner {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SetupLockOwner>;
  return row.version === SETUP_LOCK_VERSION
    && typeof row.token === "string"
    && /^[a-f0-9]{64}$/.test(row.token)
    && Number.isSafeInteger(row.pid)
    && Number(row.pid) > 0
    && typeof row.processIdentity === "string"
    && row.processIdentity.length > 0
    && typeof row.acquiredAt === "string"
    && Number.isFinite(Date.parse(row.acquiredAt))
    && typeof row.heartbeatAt === "string"
    && Number.isFinite(Date.parse(row.heartbeatAt));
}

function readSetupLockOwner(lockDir: string): SetupLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    return validSetupLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSetupLockOwner(lockDir: string, owner: SetupLockOwner): void {
  const temporary = path.join(lockDir, `.owner-${owner.token}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path.join(lockDir, "owner.json"));
}

/**
 * Owns the complete setup transaction. A directory create is the portable
 * atomic primitive shared by macOS and Linux; PID start identity prevents PID
 * reuse from making a crashed owner look live. Invalid/incomplete records are
 * held for a grace window, while a valid dead owner is recoverable immediately.
 */
export function acquireProductionSetupLock(
  lockDir: string,
  options: SetupLockOptions = {},
): ProductionSetupLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const identityFor = options.processIdentity ?? hostProcessIdentity;
  const ownerState = options.ownerState ?? defaultOwnerState;
  const heartbeatMs = options.heartbeatMs ?? SETUP_LOCK_HEARTBEAT_MS;
  const incompleteGraceMs = options.incompleteGraceMs ?? SETUP_LOCK_INCOMPLETE_GRACE_MS;
  const token = randomBytes(32).toString("hex");
  const processIdentity = identityFor(pid);
  mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  let owner: SetupLockOwner | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      const timestamp = now().toISOString();
      owner = {
        version: SETUP_LOCK_VERSION,
        token,
        pid,
        processIdentity,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
      };
      try {
        writeSetupLockOwner(lockDir, owner);
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readSetupLockOwner(lockDir);
      if (existing) {
        const state = ownerState(existing);
        if (state === "active") {
          throw new Error(
            `factory production setup is already running (pid ${existing.pid}); wait for it to finish`,
          );
        }
        if (state === "unknown") {
          throw new Error(
            `factory production setup lock owner pid ${existing.pid} cannot be verified; refusing to steal the lock`,
          );
        }
      } else {
        let ageMs = 0;
        try {
          ageMs = Math.max(0, now().getTime() - statSync(lockDir).mtimeMs);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error("factory production setup lock exists but cannot be inspected");
        }
        if (ageMs < incompleteGraceMs) {
          throw new Error(
            "factory production setup lock is incomplete or malformed; retry after its recovery grace window",
          );
        }
      }

      const stalePath = `${lockDir}.stale-${token}`;
      try {
        renameSync(lockDir, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("crashed factory production setup lock could not be reclaimed safely");
      }
      rmSync(stalePath, { recursive: true, force: true });
    }
  }
  if (!owner) throw new Error("factory production setup lock contention did not converge");

  let released = false;
  let heartbeatFailure: Error | undefined;
  const ownershipAbort = new AbortController();
  const recordOwnershipFailure = (error: unknown): Error => {
    const failure = error instanceof Error ? error : new Error(String(error));
    heartbeatFailure ??= failure;
    if (!ownershipAbort.signal.aborted) ownershipAbort.abort(heartbeatFailure);
    return heartbeatFailure;
  };
  const assertOwned = () => {
    if (released) throw new Error("factory production setup lock was already released");
    if (heartbeatFailure) throw heartbeatFailure;
    const observed = readSetupLockOwner(lockDir);
    if (!observed || observed.token !== token) {
      throw recordOwnershipFailure(
        new Error("factory production setup lock ownership changed unexpectedly"),
      );
    }
  };
  const heartbeat = () => {
    if (released) return;
    try {
      assertOwned();
      owner = { ...owner!, heartbeatAt: now().toISOString() };
      writeSetupLockOwner(lockDir, owner);
    } catch (error) {
      throw recordOwnershipFailure(error);
    }
  };
  const timer = options.startHeartbeat === false || heartbeatMs <= 0
    ? undefined
    : setInterval(() => {
      try {
        heartbeat();
      } catch (error) {
        recordOwnershipFailure(error);
      }
    }, heartbeatMs);
  timer?.unref();

  return {
    path: lockDir,
    signal: ownershipAbort.signal,
    assertOwned,
    heartbeat,
    release() {
      if (released) return;
      if (timer) clearInterval(timer);
      if (heartbeatFailure) throw heartbeatFailure;
      const observed = readSetupLockOwner(lockDir);
      if (!observed || observed.token !== token) {
        throw recordOwnershipFailure(
          new Error("factory production setup lock cannot be released by a non-owner"),
        );
      }
      const releasingPath = `${lockDir}.release-${token}`;
      renameSync(lockDir, releasingPath);
      released = true;
      rmSync(releasingPath, { recursive: true, force: true });
    },
  };
}

function defaultCommandObserver(command: string, args: string[]): CommandObservation {
  const observed = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: observed.status,
    stdout: observed.stdout ?? "",
    stderr: observed.stderr ?? "",
    error: observed.error,
  };
}

export interface OpenDatabaseFile {
  pid: string;
  command: string;
  descriptor: string;
  filename: string;
  canonicalPath: string;
  /** Textual marker retained as evidence only. macOS lsof normally omits it;
   * authorization never depends on this field. */
  deleted: boolean;
}

export interface HostDatabaseUserOptions {
  platform?: NodeJS.Platform;
  /** Set only by the composite gate immediately after a complete Docker
   * running-container mount inventory succeeds. */
  dockerMountInventoryVerified?: boolean;
}

const DARWIN_DOCKER_FILE_SHARING_PROXY_COMMANDS = new Set([
  // Docker Desktop's Virtualization.framework task is truncated to the first
  // value by some macOS `lsof` versions and emitted in full by others.
  "com.apple.Virtualization.Virtua",
  "com.apple.Virtualization.VirtualMachine",
]);

export function parseOpenDatabaseFiles(
  lsofOutput: string,
  database: string,
): OpenDatabaseFile[] {
  let canonicalDatabase = path.resolve(database);
  try {
    canonicalDatabase = realpathSync(database);
  } catch {
    // The caller performs the existence/type check. Keeping the lexical path
    // here makes the parser independently testable and still fail-safe there.
  }
  const suffixes = ["", "-wal", "-shm"];
  const targets = [...new Map([
    path.resolve(database),
    canonicalDatabase,
  ].flatMap((observedDatabase) => suffixes.map((suffix) => {
    const observedPath = `${observedDatabase}${suffix}`;
    return [observedPath, {
      observedPath,
      canonicalPath: `${canonicalDatabase}${suffix}`,
    }] as const;
  }))).values()].sort((a, b) => b.observedPath.length - a.observedPath.length);
  let pid = "unknown";
  let command = "unknown";
  let descriptor = "unknown";
  const matches: OpenDatabaseFile[] = [];
  for (const line of lsofOutput.split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") pid = value || "unknown";
    else if (field === "c") command = value || "unknown";
    else if (field === "f") descriptor = value || "unknown";
    else if (field === "n") {
      const target = targets.find((candidate) =>
        value === candidate.observedPath || value.startsWith(`${candidate.observedPath} `));
      if (target) matches.push({
        pid,
        command,
        descriptor,
        filename: path.basename(target.canonicalPath),
        canonicalPath: target.canonicalPath,
        deleted: value === `${target.observedPath} (deleted)`,
      });
    }
  }
  return [...new Map(matches.map((row) => [
    `${row.pid}\0${row.command}\0${row.descriptor}\0${row.canonicalPath}\0${row.deleted}`,
    row,
  ])).values()];
}

function databaseFileIdentity(row: OpenDatabaseFile): string {
  return `${row.pid}\0${row.command}\0${row.descriptor}\0${row.canonicalPath}`;
}

function isDarwinDockerFileSharingCandidate(
  row: OpenDatabaseFile,
  database: string,
  options: HostDatabaseUserOptions,
): boolean {
  if (
    options.platform !== "darwin"
    || options.dockerMountInventoryVerified !== true
    || !/^\d+$/.test(row.pid)
    || row.descriptor === "unknown"
    || !DARWIN_DOCKER_FILE_SHARING_PROXY_COMMANDS.has(row.command)
  ) return false;
  const databaseName = path.basename(database);
  // The main DB is deliberately absent: even an unlinked main database handle
  // can represent an active writer generation and must always fail closed.
  return row.filename === `${databaseName}-wal` || row.filename === `${databaseName}-shm`;
}

export function assertNoHostDatabaseUsers(
  database: string,
  observe: CommandObserver = defaultCommandObserver,
  options: HostDatabaseUserOptions = {},
): void {
  // First retain the complete open-descriptor inventory. macOS does not append
  // "(deleted)" to the `n` field, so link-count-zero status is proven by a
  // separate +L1 inventory below and never inferred from filename text.
  const result = observe("lsof", ["-nP", "-Fpcfn"]);
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "lsof is required to prove that agentic.db/WAL/SHM are unused; install lsof and rerun setup",
    );
  }
  if (result.error || result.status !== 0) {
    throw new Error(
      "lsof could not complete the host SQLite ownership check; setup refuses to continue",
    );
  }
  const open = parseOpenDatabaseFiles(result.stdout, database);
  const candidates = open.filter((row) =>
    isDarwinDockerFileSharingCandidate(row, database, options));
  let unlinkedIdentities = new Set<string>();
  if (candidates.length) {
    const unlinked = observe("lsof", ["+L1", "-nP", "-Fpcfn"]);
    if (
      unlinked.error
      || unlinked.status !== 0
      || unlinked.stderr.trim().length > 0
    ) {
      throw new Error(
        "lsof +L1 could not provide a clean link-count-zero inventory for the macOS Docker file-sharing proxy; setup refuses to continue",
      );
    }
    unlinkedIdentities = new Set(
      parseOpenDatabaseFiles(unlinked.stdout, database).map(databaseFileIdentity),
    );
  }
  const unsafe = open.filter((row) =>
    !isDarwinDockerFileSharingCandidate(row, database, options)
    || !unlinkedIdentities.has(databaseFileIdentity(row)));
  if (!unsafe.length) return;
  const owners = unsafe.map((row) =>
    `pid=${row.pid} command=${row.command.slice(0, 80)} file=${row.filename}${row.deleted ? " (deleted)" : ""}`)
    .join("; ");
  throw new Error(
    `host process(es) still have the production SQLite database open (${owners}); stop them explicitly and rerun setup`,
  );
}

function pathCoversDatabase(source: string, database: string): boolean {
  let canonicalSource: string;
  let canonicalDatabase: string;
  try {
    canonicalSource = realpathSync(source);
  } catch {
    throw new Error(
      `Docker bind source cannot be canonicalized safely: ${source}`,
    );
  }
  try {
    canonicalDatabase = realpathSync(database);
  } catch {
    throw new Error(
      `production database cannot be canonicalized safely: ${database}`,
    );
  }
  const relative = path.relative(canonicalSource, canonicalDatabase);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertNoRunningDockerDatabaseMounts(
  database: string,
  observe: CommandObserver = defaultCommandObserver,
): void {
  const listed = observe("docker", ["ps", "--quiet", "--no-trunc"]);
  if (listed.error?.code === "ENOENT") {
    throw new Error(
      "Docker CLI is required to prove no running container can write the production data directory",
    );
  }
  if (listed.error || listed.status !== 0) {
    throw new Error(
      "Docker daemon/container inventory is unavailable; setup refuses to assume the database is unused",
    );
  }
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  const inspected = observe("docker", ["inspect", "--type", "container", ...ids]);
  if (inspected.error || inspected.status !== 0) {
    throw new Error(
      "running Docker containers changed or could not be inspected; stop the database writer and rerun setup",
    );
  }
  let containers: Array<{
    Id?: string;
    Name?: string;
    State?: { Running?: boolean };
    Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
  }>;
  try {
    const parsed: unknown = JSON.parse(inspected.stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    containers = parsed;
  } catch {
    throw new Error("Docker returned an invalid running-container inventory");
  }
  const requestedIds = new Set(ids);
  const inspectedIds = new Set(containers.map((container) => container.Id));
  if (
    requestedIds.size !== ids.length
    || inspectedIds.size !== containers.length
    || inspectedIds.size !== requestedIds.size
    || [...requestedIds].some((id) => !inspectedIds.has(id))
    || containers.some((container) =>
      typeof container.Id !== "string"
      || typeof container.State?.Running !== "boolean"
      || !Array.isArray(container.Mounts)
      || container.Mounts.some((mount) =>
        typeof mount.Type !== "string"
        || typeof mount.RW !== "boolean"
        || (mount.Type === "bind" && typeof mount.Source !== "string")))
  ) {
    throw new Error(
      "Docker running-container mount inventory was incomplete; setup refuses stale-handle exceptions",
    );
  }
  const conflicts = containers.flatMap((container) => {
    if (container.State?.Running === false) return [];
    return (container.Mounts ?? [])
      .filter((mount) => mount.Type === "bind"
        && mount.RW !== false
        && typeof mount.Source === "string"
        && pathCoversDatabase(mount.Source, database))
      .map((mount) => ({
        container: (container.Name ?? container.Id ?? "unknown").replace(/^\//, "").slice(0, 80),
        source: mount.Source!,
        destination: mount.Destination ?? "unknown",
      }));
  });
  if (!conflicts.length) return;
  const details = conflicts.map((row) =>
    `container=${row.container} source=${row.source} destination=${row.destination}`).join("; ");
  throw new Error(
    `running Docker container(s) can write the production SQLite data surface (${details}); stop them explicitly and rerun setup`,
  );
}

async function inspectSqliteDatabase(filename: string): Promise<DatabaseInspection> {
  const previousUrl = process.env.DATABASE_URL;
  const previousReadonly = process.env.AGENTIC_DATABASE_READONLY;
  process.env.DATABASE_URL = `file:${filename}`;
  process.env.AGENTIC_DATABASE_READONLY = "1";
  const { closeDb, getRawSqlite } = await import("@agentic/db");
  try {
    const sqlite = getRawSqlite();
    const integrityRows = sqlite.pragma("integrity_check(100)") as Array<Record<string, unknown>>;
    const foreignKeyRows = sqlite.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    return {
      integrity: integrityRows.map((row) => String(row.integrity_check ?? "")),
      foreignKeyViolations: foreignKeyRows.length,
    };
  } finally {
    closeDb();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousReadonly === undefined) delete process.env.AGENTIC_DATABASE_READONLY;
    else process.env.AGENTIC_DATABASE_READONLY = previousReadonly;
  }
}

export function assertDatabaseInspectionHealthy(inspection: DatabaseInspection): void {
  if (inspection.integrity.length !== 1 || inspection.integrity[0]?.toLowerCase() !== "ok") {
    const summary = inspection.integrity.filter(Boolean).slice(0, 3).join("; ") || "no result";
    throw new Error(`production SQLite integrity_check failed (${summary}); repair from a verified backup before setup`);
  }
  if (!Number.isSafeInteger(inspection.foreignKeyViolations)
    || inspection.foreignKeyViolations !== 0) {
    throw new Error(
      `production SQLite foreign_key_check found ${inspection.foreignKeyViolations} violation(s); repair them before setup`,
    );
  }
}

/** Read-only fail-closed gate run before tenant discovery, secret generation or
 * image construction. Repeating ownership checks around SQLite inspection
 * narrows the window in which a concurrently-starting writer could appear. */
export async function assertProductionSetupSafety(
  dataDir: string,
  dependencies: ProductionSetupSafetyDependencies = {},
): Promise<void> {
  const database = path.join(dataDir, "agentic.db");
  if (!existsSync(database)) {
    throw new Error(
      `production database does not exist at ${database}; initialize and validate it before running setup`,
    );
  }
  const stat = lstatSync(database);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`production database must be a regular, non-symlink file: ${database}`);
  }
  const observe = dependencies.observeCommand ?? defaultCommandObserver;
  const inspect = dependencies.inspectDatabase ?? inspectSqliteDatabase;
  const assertDatabaseWriteSurfaceUnused = () => {
    // The Docker inventory must be the immediately preceding proof: the only
    // lsof exception depends on knowing that no currently-running container
    // can reach this host database through a writable bind mount.
    assertNoRunningDockerDatabaseMounts(database, observe);
    assertNoHostDatabaseUsers(database, observe, {
      platform: dependencies.platform ?? process.platform,
      dockerMountInventoryVerified: true,
    });
  };
  const leasePath = sqliteWriterLeasePath(database);
  const leaseExists = existsSync(leasePath);
  if (dependencies.ownedWriterLease) {
    const observed = inspectSqliteWriterLease(database);
    if (
      !observed
      || observed.leasePath !== dependencies.ownedWriterLease.leasePath
      || observed.owner.token !== dependencies.ownedWriterLease.token
      || observed.owner.pid !== process.pid
    ) {
      throw new Error("production setup lost its canonical SQLite writer lease");
    }
    dependencies.ownedWriterLease.heartbeat();
  } else if (leaseExists && !dependencies.recoverWriterLease) {
    // Validate symlink/malformed state for an actionable fail-closed error,
    // then require an explicit recovery invocation even if the heartbeat is
    // old or its PID appears dead.
    inspectSqliteWriterLease(database);
    throw new Error(
      `SQLite writer lease exists at ${leasePath}; stop/prove every writer, then rerun setup with --recover-sqlite-writer-lease`,
    );
  }
  assertDatabaseWriteSurfaceUnused();
  assertDatabaseInspectionHealthy(await inspect(database));
  assertDatabaseWriteSurfaceUnused();
  if (leaseExists && !dependencies.ownedWriterLease) {
    recoverSqliteWriterLeaseAfterProof(database);
    // Recovery authority is single-use and bounded by fresh proofs on both
    // sides. A writer appearing during recovery makes setup fail immediately.
    assertDatabaseWriteSurfaceUnused();
    assertDatabaseInspectionHealthy(await inspect(database));
  }
}

function parseEnvFile(filename: string): Record<string, string> {
  if (!existsSync(filename)) return {};
  return parseProductionEnvText(readFileSync(filename, "utf8"));
}

function safeWrite(filename: string, value: string, rotate: boolean): string {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (!rotate && existsSync(filename)) {
    const existing = readFileSync(filename, "utf8").trim();
    if (existing) return existing;
  }
  // Finalized bind-mounted secrets are deliberately read-only. Restore the
  // owner's write bit only for the short rotation window; permissions are
  // reduced again before Compose can consume the files.
  if (existsSync(filename)) chmodSync(filename, 0o600);
  writeFileSync(filename, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filename, 0o600);
  return value;
}

export interface ProductionImageAttestationKeyPair {
  privateKeyFile: string;
  publicKeyFile: string;
  keyId: string;
}

/** Persistent host trust root. The private half never enters a Compose env or
 * bind mount; only the derived public key is mounted read-only into the API. */
export function ensureProductionImageAttestationKeyPair(
  directory: string,
): ProductionImageAttestationKeyPair {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const privateKeyFile = path.join(directory, "private.pem");
  const publicKeyFile = path.join(directory, "public.pem");

  const assertRegular = (filename: string, label: string): void => {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a regular, non-symlink file`);
    }
  };
  if (!existsSync(privateKeyFile) && existsSync(publicKeyFile)) {
    throw new Error("production image public trust root exists without its host-only private key");
  }

  let privateKey: ReturnType<typeof createPrivateKey>;
  if (existsSync(privateKeyFile)) {
    assertRegular(privateKeyFile, "production image attestation private key");
    try {
      privateKey = createPrivateKey(readFileSync(privateKeyFile));
    } catch {
      throw new Error("production image attestation private key is malformed");
    }
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("production image attestation private key must use Ed25519");
    }
  } else {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    writeFileSync(
      privateKeyFile,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600, flag: "wx" },
    );
  }
  chmodSync(privateKeyFile, 0o600);

  const derivedPublic = createPublicKey(
    // Runtime accepts a private KeyObject to derive its public half; bridge
    // the @types/node 26 narrowed input union.
    privateKey as unknown as Parameters<typeof createPublicKey>[0],
  ).export({
    type: "spki",
    format: "pem",
  }).toString();
  const derivedKeyId = productionImageAttestationKeyId(derivedPublic);
  if (existsSync(publicKeyFile)) {
    assertRegular(publicKeyFile, "production image attestation public key");
    const existingPublic = readFileSync(publicKeyFile);
    if (productionImageAttestationKeyId(existingPublic) !== derivedKeyId) {
      throw new Error("production image attestation public key does not match the host-only private key");
    }
  } else {
    writeFileSync(publicKeyFile, derivedPublic, { mode: 0o444, flag: "wx" });
  }
  chmodSync(publicKeyFile, 0o444);
  return { privateKeyFile, publicKeyFile, keyId: derivedKeyId };
}

/** Derived broker files are not independent secrets. Reusing an old copy can
 * split API and broker identities after a tenant is added or a setup run was
 * interrupted, so always reconcile them from the canonical secret files. */
export function writeDerivedSecretFile(filename: string, value: string): void {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (existsSync(filename)) chmodSync(filename, 0o600);
  writeFileSync(filename, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filename, 0o600);
}

/**
 * Docker bind mounts retain source ownership/mode. The services consuming
 * these files all run as different non-root UIDs, so host-owner-only 0700/
 * 0600 files are unreadable inside the containers. The parent
 * `.secrets/agent-factory` directory remains 0700 (blocking every other host
 * user); only each leaf mounted into a dedicated container becomes
 * traversable/readable and never writable.
 */
export function finalizeBindSecretPermissions(dirs: string[]): void {
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        throw new Error(`unexpected non-file entry in secret directory: ${path.join(dir, entry.name)}`);
      }
      chmodSync(path.join(dir, entry.name), 0o404);
    }
    chmodSync(dir, 0o505);
  }
}

function hostStorageIdentity(): { uid: string; gid: string } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid! <= 0 || gid! < 0) {
    throw new Error(
      "factory production setup must run as the non-root host user that owns ./data and ./models",
    );
  }
  return { uid: String(uid), gid: String(gid) };
}

/** The production API runs under this exact host identity. Verify the two bind
 * roots now, instead of letting SQLite migration or manifest promotion fail
 * after the stack has started. */
function verifyHostStorageWritable(): void {
  const paths = [path.join(root, "data"), path.join(root, "models")];
  for (const dir of paths) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    const probe = path.join(dir, `.factory-setup-write-probe-${process.pid}`);
    try {
      writeFileSync(probe, "ok\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    } finally {
      if (existsSync(probe)) unlinkSync(probe);
    }
  }
  const database = path.join(root, "data", "agentic.db");
  if (existsSync(database)) accessSync(database, fsConstants.R_OK | fsConstants.W_OK);
}

export function validHexSecret(value: string, bytes = 32): boolean {
  return value.length >= bytes * 2
    && value.length % 2 === 0
    && /^[a-f0-9]+$/i.test(value);
}

function secret(filename: string, rotate: boolean, bytes = 32): string {
  const value = safeWrite(filename, randomBytes(bytes).toString("hex"), rotate);
  if (!validHexSecret(value, bytes)) {
    throw new Error(
      `existing secret ${path.relative(root, filename)} is malformed or weaker than ${bytes} bytes; rerun with --rotate-secrets`,
    );
  }
  return value;
}

function persistedSessionSecret(filename: string, rotate: boolean): string {
  const value = safeWrite(filename, randomBytes(32).toString("hex"), rotate);
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(
      `existing secret ${path.relative(root, filename)} is shorter than 32 bytes; rerun with --rotate-secrets`,
    );
  }
  return value;
}

/** The official Postgres image applies POSTGRES_PASSWORD_FILE only while
 * initializing an empty volume. Rotating this file behind an existing volume
 * would make both brokers permanently fail authentication. Keep it stable;
 * database-password rotation is a coordinated SQL operation, not part of the
 * generic file-secret switch. */
function persistentDatabaseSecret(filename: string): string {
  const value = safeWrite(filename, randomBytes(32).toString("hex"), false);
  if (!validHexSecret(value)) {
    throw new Error(
      `database secret ${path.relative(root, filename)} is malformed; repair it together with the persisted Postgres role password`,
    );
  }
  return value;
}

/** Integrity-protected control records outlive service restarts and are
 * MAC-verified before they can authorize cleanup, recovery or promotion.
 * Rotating one of these keys independently would make durable records
 * unreadable exactly when they are needed, so preserve it across the generic
 * --rotate-secrets operation. A future rotation must migrate/re-sign those
 * records as one coordinated operation. */
export function persistentIntegritySecret(filename: string, purpose: string): string {
  const value = safeWrite(filename, randomBytes(32).toString("hex"), false);
  if (!validHexSecret(value)) {
    throw new Error(
      `${purpose} integrity secret ${path.relative(root, filename)} is malformed; repair it together with its persisted records`,
    );
  }
  return value;
}

export interface ProductionSetupCommandOptions {
  capture?: boolean;
  signal?: AbortSignal;
}

export type ProductionSetupCommandRunner = (
  command: string,
  args: string[],
  options?: ProductionSetupCommandOptions,
) => Promise<string>;

/** Async command boundary used by Docker/git setup work. A lost setup lock
 * terminates the in-flight CLI before the setup transaction can advance. */
export async function runProductionSetupCommand(
  command: string,
  args: string[],
  options: ProductionSetupCommandOptions = {},
): Promise<string> {
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("factory production setup command aborted");
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBuffer = 128 * 1024 * 1024;
    let capturedBytes = 0;
    let bufferFailure: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      killTimer.unref?.();
    };
    const onAbort = () => terminate();
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    const collect = (target: Buffer[], chunk: Buffer | string) => {
      if (bufferFailure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capturedBytes += bytes.length;
      if (capturedBytes > maxBuffer) {
        bufferFailure = new Error(
          `factory production setup command exceeded ${maxBuffer} captured bytes: ${command}`,
        );
        terminate();
        return;
      }
      target.push(bytes);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.aborted && signal.reason instanceof Error ? signal.reason : error);
    });
    child.once("close", (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason instanceof Error
          ? signal.reason
          : new Error("factory production setup command aborted"));
        return;
      }
      if (bufferFailure) {
        reject(bufferFailure);
        return;
      }
      if (code !== 0) {
        const errorOutput = options.capture
          ? Buffer.concat(stderr).toString("utf8").trim().slice(-4_000)
          : "";
        reject(new Error(
          `${command} exited with ${code ?? terminationSignal ?? "unknown status"}${errorOutput ? `: ${errorOutput}` : ""}`,
        ));
        return;
      }
      resolve(options.capture ? Buffer.concat(stdout).toString("utf8").trim() : "");
    });
  });
}

export interface ProductionSetupExecution {
  readonly signal: AbortSignal;
  assertOwned(): void;
  runCommand(command: string, args: string[], options?: { capture?: boolean }): Promise<string>;
  mutate<T>(phase: string, callback: () => T): T;
}

/** One ownership fence shared by commands and filesystem mutation phases. */
export function createProductionSetupExecution(
  lock: ProductionSetupLock,
  commandRunner: ProductionSetupCommandRunner = runProductionSetupCommand,
): ProductionSetupExecution {
  return {
    signal: lock.signal,
    assertOwned: () => lock.assertOwned(),
    async runCommand(command, args, options = {}) {
      lock.assertOwned();
      const output = await commandRunner(command, args, {
        ...options,
        signal: lock.signal,
      });
      lock.assertOwned();
      return output;
    },
    mutate(_phase, callback) {
      lock.assertOwned();
      const result = callback();
      lock.assertOwned();
      return result;
    },
  };
}

async function dockerArch(run: ProductionSetupExecution["runCommand"]): Promise<string> {
  const arch = await run("docker", ["version", "--format", "{{.Server.Arch}}"], { capture: true });
  if (arch === "x86_64") return "amd64";
  if (arch === "aarch64") return "arm64";
  return arch;
}

async function dockerSocketHostPath(
  run: ProductionSetupExecution["runCommand"],
  configuredValue?: string,
): Promise<{ path: string; gid: string }> {
  const configured = configuredValue?.trim();
  let contextEndpoint = "";
  try {
    contextEndpoint = await run(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { capture: true },
    );
  } catch {
    // `docker version` above already proves the daemon is reachable. Fall
    // through to standard Unix socket locations for older Docker CLIs.
  }
  const endpointPath = contextEndpoint.startsWith("unix://")
    ? contextEndpoint.slice("unix://".length)
    : "";
  const home = process.env.HOME?.trim() || "";
  const runtime = process.env.XDG_RUNTIME_DIR?.trim() || "";
  const candidates = [...new Set([
    configured,
    endpointPath,
    "/var/run/docker.sock",
    home ? path.join(home, ".docker", "run", "docker.sock") : "",
    home ? path.join(home, ".colima", "default", "docker.sock") : "",
    runtime ? path.join(runtime, "docker.sock") : "",
  ].filter((value): value is string => Boolean(value)))];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      const stat = statSync(resolved);
      if (stat.isSocket()) return { path: resolved, gid: String(stat.gid) };
    } catch {
      // Try the next exact path; setup never manufactures a socket path.
    }
  }
  if (contextEndpoint && !contextEndpoint.startsWith("unix://")) {
    throw new Error(
      `Docker context uses ${contextEndpoint}; sandbox workload requires a bind-mountable Unix socket`,
    );
  }
  throw new Error(
    `Docker daemon is reachable but no bind-mountable Unix socket was found (${candidates.join(", ")})`,
  );
}

function repositoryWithoutTag(image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

async function immutableImage(
  run: ProductionSetupExecution["runCommand"],
  image: string,
  arch: string,
  pull: boolean,
): Promise<string> {
  const alreadyPinned = image.match(/^(.+)@(sha256:[a-f0-9]{64})$/);
  if (alreadyPinned) {
    let inspected = "";
    try {
      inspected = await run("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"], { capture: true });
    } catch {
      if (!pull) throw new Error(`immutable image is not available locally: ${image}`);
      await run("docker", ["pull", image]);
      inspected = await run("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"], { capture: true });
    }
    const normalized = inspected === "x86_64" ? "amd64" : inspected === "aarch64" ? "arm64" : inspected;
    if (normalized !== arch) {
      throw new Error(`immutable image ${image} is ${normalized || "unknown"}, expected linux/${arch}`);
    }
    return image;
  }
  if (!pull) {
    try {
      const inspected = JSON.parse(await run("docker", ["image", "inspect", image], { capture: true })) as Array<{
        Architecture?: string;
        RepoDigests?: string[];
      }>;
      const row = inspected[0];
      const normalized = row?.Architecture === "x86_64"
        ? "amd64"
        : row?.Architecture === "aarch64"
          ? "arm64"
          : row?.Architecture;
      const exactRepoPrefix = `${repositoryWithoutTag(image)}@`;
      const pinned = row?.RepoDigests?.find((value) =>
        value.startsWith(exactRepoPrefix) && /@sha256:[a-f0-9]{64}$/.test(value))
        ?? row?.RepoDigests?.find((value) => /@sha256:[a-f0-9]{64}$/.test(value));
      if (normalized === arch && pinned) return pinned;
    } catch {
      // Emit the single, actionable error below rather than leaking Docker's
      // registry/local-cache details into setup output.
    }
    throw new Error(
      `--skip-pull requires a locally available immutable linux/${arch} image for ${image}`,
    );
  }
  const raw = await run("docker", ["manifest", "inspect", image], { capture: true });
  const manifest = JSON.parse(raw) as {
    digest?: string;
    manifests?: Array<{
      digest?: string;
      platform?: { os?: string; architecture?: string };
    }>;
  };
  const digest = manifest.manifests?.find(
    (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === arch,
  )?.digest ?? manifest.digest;
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`could not resolve an immutable linux/${arch} digest for ${image}`);
  }
  const pinned = `${repositoryWithoutTag(image)}@${digest}`;
  if (pull) await run("docker", ["pull", pinned]);
  return pinned;
}

async function sourceFingerprint(run: ProductionSetupExecution["runCommand"]): Promise<string> {
  const head = await run("git", ["rev-parse", "HEAD"], { capture: true });
  // Hash the bytes Docker will consume, not only an unstaged diff.  The old
  // HEAD+git-diff scheme missed staged changes, untracked source files and
  // root build inputs such as the lockfile/scripts/models, so one attested
  // build id could name multiple different runner images.
  const listed = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { capture: true },
  );
  const files = listed.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(`agentic-build-context/v2\0${head}\0`, "utf8");
  for (const relative of files) {
    const filename = path.join(root, relative);
    hash.update(relative, "utf8").update("\0");
    if (!existsSync(filename)) {
      hash.update("deleted\0");
      continue;
    }
    const stat = lstatSync(filename);
    hash.update(`${stat.mode & 0o7777}\0`, "utf8");
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(readlinkSync(filename), "utf8").update("\0");
    } else if (stat.isFile()) {
      hash.update("file\0").update(readFileSync(filename)).update("\0");
    } else {
      hash.update("other\0");
    }
  }
  return hash.digest("hex").slice(0, 20);
}

/** Fence every long build/inspection against a moving Docker build context.
 * A mixed seven-target build must never be labelled as one immutable release. */
export async function runWithStableSourceFingerprint<T>(input: {
  expected: string;
  phase: string;
  operation: () => Promise<T>;
  observeFingerprint: () => Promise<string>;
}): Promise<T> {
  const value = await input.operation();
  const observed = await input.observeFingerprint();
  if (observed !== input.expected) {
    throw new Error(
      `source changed during ${input.phase}; refusing a mixed-image production release`,
    );
  }
  return value;
}

async function buildImage(run: ProductionSetupExecution["runCommand"], input: {
  tag: string;
  dockerfile: string;
  target: string;
  buildId: string;
  buildArgs?: Record<string, string>;
}): Promise<string> {
  const args = [
    "build",
    "--file", input.dockerfile,
    "--target", input.target,
    "--tag", input.tag,
    "--build-arg", `AGENTIC_BUILD_ID=${input.buildId}`,
    "--build-arg", "AGENTIC_SOURCE_REPOSITORY=local-worktree",
  ];
  for (const [name, value] of Object.entries(input.buildArgs ?? {})) {
    args.push("--build-arg", `${name}=${value}`);
  }
  args.push(".");
  await run("docker", args);
  return await run("docker", ["image", "inspect", input.tag, "--format", "{{.Id}}"], { capture: true });
}

function containerOrigin(value: string): string {
  if (!value.trim()) return value;
  try {
    const url = new URL(value);
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      url.hostname = "host.docker.internal";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export interface ProductionSandboxDeploymentConfig {
  topology: FactoryProductionImageTopology;
  runnerUrl: string;
  runnerHttpAllowedHosts: string;
  keyId: string;
  runnerId: string;
  /** Exact remote build allowlist consumed by signed execution-receipt verification. */
  allowedBuildIds: string;
  /** Exact remote workload allowlist consumed by signed execution-receipt verification. */
  allowedImageDigests: string;
  runtimeImageDigest: string;
  /*
   * 执行面证明校验所需的完整引用。缺任何一项，
   * loadRemoteSandboxConnectionConfig 就整体拒绝配置，/health 报
   * sandbox_runner_unreachable_or_misconfigured —— 即使网络与 TLS 全都正常
   * （2026-08-06 实测：8 项引用不足，必须 17 项齐备）。
   *
   * 身份哈希是【否定性】判据：用来证明执行面不共享主平面的主机/Docker 身份。
   * 全部由运维在 operator .env 里显式提供；setup 不发明身份。
   */
  executionPlaneId?: string;
  executionPlaneTrustDomain?: string;
  platformAttestorKeyId?: string;
  platformAttestorPublicKeyFile?: string;
  platformAttestorPublicHostFile?: string;
  primaryHostIdentityHash?: string;
  primaryDockerDaemonIdentityHash?: string;
  allowedControlHostIdentityHashes?: string;
  allowedWorkloadHostIdentityHashes?: string;
  allowedDockerDaemonIdentityHashes?: string;
  /** 外部执行面的解析地址与私有 CA（容器靠它们连上并校验 TLS）。 */
  vmAddress?: string;
  caHostFile?: string;
}

function deploymentSetting(
  name: string,
  sources: Array<Record<string, string | undefined>>,
): string {
  for (const source of sources) {
    const value = source[name]?.trim();
    if (value) return value;
  }
  return "";
}

function exactSingletonSetting(
  raw: string,
  name: string,
  predicate: (value: string) => boolean = () => true,
): string {
  let values: unknown;
  try {
    values = raw.trim().startsWith("[") ? JSON.parse(raw) : raw.split(",");
  } catch {
    throw new Error(`${name} must be a JSON array or comma-separated list`);
  }
  if (
    !Array.isArray(values)
    || values.length !== 1
    || typeof values[0] !== "string"
    || !values[0].trim()
    || !predicate(values[0].trim())
  ) {
    throw new Error(`${name} must contain exactly one trusted identity`);
  }
  return values[0].trim();
}

function exactDeploymentIdentity(value: string, name: string): string {
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be an explicit identity of at most 200 characters`);
  }
  return value;
}

/**
 * Resolve the primary-host topology without guessing a remote execution
 * identity. `single_host_compose` is deliberately useful only as a local
 * diagnostic. Selecting `external_sandbox` requires the operator to supply
 * the independently deployed runner's exact URL, key/runner identities and
 * singleton build/workload allowlists. The setup process does not claim that
 * copying local image identities created an external execution plane.
 */
export function resolveProductionSandboxDeployment(input: {
  ambient?: Record<string, string | undefined>;
  source?: Record<string, string | undefined>;
  previous?: Record<string, string | undefined>;
  localBuildId: string;
  localWorkloadDigest: string;
  fingerprint: string;
}): ProductionSandboxDeploymentConfig {
  const ambient = input.ambient ?? process.env;
  const source = input.source ?? {};
  const previous = input.previous ?? {};
  const operatorSources = [ambient, source];
  const sources = [...operatorSources, previous];
  const topologyRaw = deploymentSetting(
    "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY",
    sources,
  ) || "single_host_compose";
  if (topologyRaw !== "single_host_compose" && topologyRaw !== "external_sandbox") {
    throw new Error(
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY must be external_sandbox or single_host_compose",
    );
  }
  if (topologyRaw === "single_host_compose") {
    return {
      topology: topologyRaw,
      runnerUrl: "http://sandbox-runner:3560",
      runnerHttpAllowedHosts: "sandbox-runner",
      keyId: `factory-sandbox-${input.fingerprint}`,
      runnerId: `factory-sandbox-runner-${input.fingerprint}`,
      allowedBuildIds: JSON.stringify([input.localBuildId]),
      allowedImageDigests: JSON.stringify([input.localWorkloadDigest]),
      runtimeImageDigest: input.localWorkloadDigest,
    };
  }

  // A prior single-host output is not authority for an external deployment.
  // Only retain generated values across reruns when the previous output was
  // already explicitly external; switching topology requires fresh operator
  // input for every remote identity.
  const externalSources = previous.FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY?.trim()
    === "external_sandbox"
    ? sources
    : operatorSources;
  const explicitUrl = deploymentSetting("FACTORY_SB_RUNNER_URL", operatorSources);
  const rawUrl = deploymentSetting("FACTORY_SB_RUNNER_URL", externalSources);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      "external_sandbox requires an explicit absolute FACTORY_SB_RUNNER_URL",
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(
      "external FACTORY_SB_RUNNER_URL must use HTTPS without credentials, query or fragment",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    [
      "localhost",
      "sandbox-runner",
      "host.docker.internal",
      "api",
      "0.0.0.0",
      "::",
      "::1",
    ].includes(hostname)
    || /^127(?:\.|$)/.test(hostname)
  ) {
    throw new Error(
      "external_sandbox runner URL must not resolve through the primary host or its Compose service names",
    );
  }
  const configuredHosts = deploymentSetting(
    "FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS",
    explicitUrl ? operatorSources : externalSources,
  );
  if (configuredHosts) {
    const hosts = configuredHosts.split(",").map((entry) => entry.trim().toLowerCase());
    if (hosts.length !== 1 || hosts[0] !== hostname) {
      throw new Error(
        "FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS must contain only the exact external runner hostname",
      );
    }
  }
  const imagePattern = /^sha256:[a-f0-9]{64}$/;
  const allowedBuild = exactSingletonSetting(
    deploymentSetting("FACTORY_SB_ALLOWED_BUILD_IDS", externalSources),
    "FACTORY_SB_ALLOWED_BUILD_IDS",
    (value) => value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value),
  );
  const allowedImage = exactSingletonSetting(
    deploymentSetting("FACTORY_SB_ALLOWED_IMAGE_DIGESTS", externalSources),
    "FACTORY_SB_ALLOWED_IMAGE_DIGESTS",
    (value) => imagePattern.test(value),
  );
  const configuredRuntimeImage = deploymentSetting(
    "FACTORY_SB_RUNTIME_IMAGE_DIGEST",
    operatorSources,
  );
  if (configuredRuntimeImage && configuredRuntimeImage !== allowedImage) {
    throw new Error(
      "FACTORY_SB_RUNTIME_IMAGE_DIGEST must equal the exact external workload allowlist",
    );
  }
  return {
    topology: topologyRaw,
    runnerUrl: `${url.origin}${url.pathname.replace(/\/$/, "")}`,
    runnerHttpAllowedHosts: hostname,
    keyId: exactDeploymentIdentity(
      deploymentSetting("FACTORY_SB_KEY_ID", externalSources),
      "FACTORY_SB_KEY_ID",
    ),
    runnerId: exactDeploymentIdentity(
      deploymentSetting("FACTORY_SB_RUNNER_ID", externalSources),
      "FACTORY_SB_RUNNER_ID",
    ),
    allowedBuildIds: JSON.stringify([allowedBuild]),
    allowedImageDigests: JSON.stringify([allowedImage]),
    runtimeImageDigest: allowedImage,
    executionPlaneId: exactDeploymentIdentity(
      deploymentSetting("FACTORY_SB_EXECUTION_PLANE_ID", externalSources),
      "FACTORY_SB_EXECUTION_PLANE_ID",
    ),
    executionPlaneTrustDomain: exactDeploymentIdentity(
      deploymentSetting(
        "FACTORY_SB_EXECUTION_PLANE_TRUST_DOMAIN",
        externalSources,
      ),
      "FACTORY_SB_EXECUTION_PLANE_TRUST_DOMAIN",
    ),
    platformAttestorKeyId: exactDeploymentIdentity(
      deploymentSetting("FACTORY_SB_PLATFORM_ATTESTOR_KEY_ID", externalSources),
      "FACTORY_SB_PLATFORM_ATTESTOR_KEY_ID",
    ),
    platformAttestorPublicKeyFile:
      "/run/secrets/external-sandbox-attestor-public.pem",
    platformAttestorPublicHostFile: absoluteDeploymentPath(
      deploymentSetting(
        "EXTERNAL_SANDBOX_ATTESTOR_PUBLIC_HOST_FILE",
        externalSources,
      ),
      "EXTERNAL_SANDBOX_ATTESTOR_PUBLIC_HOST_FILE",
    ),
    primaryHostIdentityHash: exactIdentityHash(
      deploymentSetting("FACTORY_PRIMARY_HOST_IDENTITY_HASH", externalSources),
      "FACTORY_PRIMARY_HOST_IDENTITY_HASH",
    ),
    primaryDockerDaemonIdentityHash: exactIdentityHash(
      deploymentSetting(
        "FACTORY_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH",
        externalSources,
      ),
      "FACTORY_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH",
    ),
    allowedControlHostIdentityHashes: JSON.stringify([
      exactSingletonSetting(
      deploymentSetting(
        "FACTORY_SB_ALLOWED_CONTROL_HOST_IDENTITY_HASHES",
        externalSources,
      ),
      "FACTORY_SB_ALLOWED_CONTROL_HOST_IDENTITY_HASHES",
      (value) => IDENTITY_HASH_PATTERN.test(value),
      ),
    ]),
    allowedWorkloadHostIdentityHashes: JSON.stringify([
      exactSingletonSetting(
      deploymentSetting(
        "FACTORY_SB_ALLOWED_WORKLOAD_HOST_IDENTITY_HASHES",
        externalSources,
      ),
      "FACTORY_SB_ALLOWED_WORKLOAD_HOST_IDENTITY_HASHES",
      (value) => IDENTITY_HASH_PATTERN.test(value),
      ),
    ]),
    allowedDockerDaemonIdentityHashes: JSON.stringify([
      exactSingletonSetting(
      deploymentSetting(
        "FACTORY_SB_ALLOWED_DOCKER_DAEMON_IDENTITY_HASHES",
        externalSources,
      ),
      "FACTORY_SB_ALLOWED_DOCKER_DAEMON_IDENTITY_HASHES",
      (value) => IDENTITY_HASH_PATTERN.test(value),
      ),
    ]),
    vmAddress: exactDeploymentIdentity(
      deploymentSetting("EXTERNAL_SANDBOX_VM_ADDRESS", externalSources),
      "EXTERNAL_SANDBOX_VM_ADDRESS",
    ),
    caHostFile: absoluteDeploymentPath(
      deploymentSetting("EXTERNAL_SANDBOX_CA_HOST_FILE", externalSources),
      "EXTERNAL_SANDBOX_CA_HOST_FILE",
    ),
  };
}

/** sha256:<64 hex> —— 执行面身份哈希的唯一合法形状。 */
const IDENTITY_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** 单个身份哈希：形状必须精确，setup 不接受占位或截断值。 */
function exactIdentityHash(raw: string, name: string): string {
  const value = raw.trim();
  if (!IDENTITY_HASH_PATTERN.test(value)) {
    throw new Error(`${name} must be an exact sha256:<64 hex> identity hash`);
  }
  return value;
}

/** 宿主侧挂载源必须是绝对路径；setup 从不代运维猜一个位置。 */
function absoluteDeploymentPath(raw: string, name: string): string {
  const value = raw.trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute host path`);
  }
  return value;
}

function envNameForTenant(slug: string): string {
  const stem = slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "TENANT";
  const suffix = createHash("sha256").update(slug, "utf8").digest("hex").slice(0, 8).toUpperCase();
  return `TENANT_${stem.slice(0, 40)}_${suffix}`;
}

function enabledTenantSlugs(source: Record<string, string>): Set<string> | null {
  const raw = process.env.AGENTIC_ENABLED_TENANTS?.trim()
    || source.AGENTIC_ENABLED_TENANTS?.trim()
    || "";
  if (!raw) return null;
  const slugs = raw.split(",").map((slug) => slug.trim()).filter(Boolean);
  return slugs.length ? new Set(slugs) : null;
}

async function activeTenantSlugs(source: Record<string, string>): Promise<string[]> {
  process.env.DATABASE_URL = `file:${path.join(root, "data", "agentic.db")}`;
  process.env.AGENTIC_DATABASE_READONLY = "1";
  const { closeDb, getDb, tenants } = await import("@agentic/db");
  const enabled = enabledTenantSlugs(source);
  try {
    const active = getDb().select({ slug: tenants.slug, archivedAt: tenants.archivedAt })
      .from(tenants)
      .all()
      .filter((row) => row.slug !== "__system" && !row.archivedAt)
      .map((row) => row.slug)
      .sort();
    return enabled ? active.filter((slug) => enabled.has(slug)) : active;
  } finally {
    closeDb();
  }
}

export function copyRuntimeSettings(source: Record<string, string>): Array<[string, string]> {
  // `.env` is explicit operator input, not the ambient shell environment.
  // Carry its application/integration values generically so adding a new
  // Ontology-selected tool does not require teaching this installer a vendor
  // name. Deployment-owned identities, paths and sandbox authorities are
  // regenerated below and must never be inherited from a dev stack.
  const reserved = new Set([
    "NODE_ENV", "NODE_OPTIONS", "PATH", "HOME", "HOST", "PORT", "API_PORT",
    "DATABASE_URL", "AUTH_MODE", "AUTH_SESSION_SECRET",
    "API_BIND_ADDRESS", "WEB_BIND_ADDRESS", "WEB_PORT", "WEB_ORIGIN", "AGENTIC_API_URL",
    "AGENTIC_API_NODE_ENV", "AGENTIC_API_IMAGE", "AGENTIC_WEB_IMAGE",
    "AGENTIC_BUILD_ID", "AGENTIC_ENABLED_TENANTS",
    "AGENTIC_RUNTIME_UID", "AGENTIC_RUNTIME_GID",
    "AGENTIC_PROCESS_ROLE", "AGENTIC_DATABASE_READONLY",
    "AGENTIC_NODE_BASE_IMAGE", "AGENTIC_NODE_BASE_SOURCE_IMAGE",
    "AGENTIC_DATA_DIR", "AGENTIC_DATA_ROOT", "AGENTIC_MODELS_DIR",
    "AGENTIC_IMPORTS_DIR", "AGENTIC_LOGS_DIR", "AGENTIC_ARTIFACTS_DIR",
    "AGENTIC_TENANTS_DIR",
  ]);
  const reservedPrefixes = [
    "LD_", "DYLD_", "AGENTIC_DEV_", "INNGEST_", "PRIMARY_", "TENANT_",
    "SANDBOX_", "FACTORY_", "PRODUCTION_",
  ];
  return Object.entries(source)
    .filter(([name, value]) => value && !reserved.has(name)
      && (
        name.startsWith("FACTORY_MODEL_")
        || name.startsWith("FACTORY_BRAIN_")
        || !reservedPrefixes.some((prefix) => name.startsWith(prefix))
      ))
    .map(([name, value]) => [
      name,
      /(?:_BASE_URL|_URL|_URI|_ENDPOINT)$/.test(name) ? containerOrigin(value) : value,
    ]);
}

async function runSetup(
  opts: SetupOptions,
  writerLease: SqliteWriterLease,
  setupLock: ProductionSetupLock,
): Promise<void> {
  const execution = createProductionSetupExecution(setupLock);
  const guardedSecret = (filename: string, rotate: boolean, bytes?: number) =>
    execution.mutate("secret file", () => secret(filename, rotate, bytes));
  const guardedDerivedSecret = (filename: string, value: string) =>
    execution.mutate("derived secret file", () => writeDerivedSecretFile(filename, value));
  const guardedDatabaseSecret = (filename: string) =>
    execution.mutate("database secret file", () => persistentDatabaseSecret(filename));
  execution.assertOwned();
  const source = parseEnvFile(sourceEnvPath);
  const previousGenerated = parseEnvFile(envPath);
  const storageIdentity = hostStorageIdentity();
  execution.mutate("host storage probe", () => verifyHostStorageWritable());
  const tenants = await activeTenantSlugs(source);
  execution.assertOwned();
  if (!tenants.length) throw new Error("no active business tenants exist in data/agentic.db");

  execution.mutate("secret directory preparation", () => {
    mkdirSync(secretsRoot, { recursive: true, mode: 0o700 });
    chmodSync(secretsRoot, 0o700);
    for (const dir of [
      apiSecrets,
      primaryBrokerSecrets,
      sandboxSecrets,
      sandboxBrokerSecrets,
      codeactExecutorSecrets,
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  });
  const productionImageTrustRoot = execution.mutate(
    "production image trust root",
    () => ensureProductionImageAttestationKeyPair(productionImageAttestationTrustRoot),
  );

  execution.assertOwned();
  const systemEventKey = guardedSecret(path.join(apiSecrets, "system-event-key"), opts.forceSecrets);
  const signingKey = guardedSecret(path.join(apiSecrets, "signing-key"), opts.forceSecrets);
  const factoryProductionProbeToken = guardedSecret(
    path.join(apiSecrets, "factory-production-probe-token"),
    opts.forceSecrets,
  );
  guardedDerivedSecret(path.join(primaryBrokerSecrets, "primary-signing-key"), signingKey);
  const primaryPostgresPassword = guardedDatabaseSecret(
    path.join(primaryBrokerSecrets, "primary-postgres-password"),
  );
  const primaryRedisPassword = guardedSecret(path.join(primaryBrokerSecrets, "primary-redis-password"), opts.forceSecrets);
  guardedDerivedSecret(
    path.join(primaryBrokerSecrets, "primary-redis-acl"),
    `user default on >${primaryRedisPassword} ~* &* +@all`,
  );

  const tenantRefs: Record<string, Record<string, string>> = {};
  const tenantEnv: Array<[string, string]> = [];
  const eventKeys = [systemEventKey];
  for (const slug of tenants) {
    execution.assertOwned();
    const envName = `${envNameForTenant(slug)}_INNGEST_EVENT_KEY`;
    const filename = `tenant-${createHash("sha256").update(slug).digest("hex").slice(0, 16)}-event-key`;
    const key = guardedSecret(path.join(apiSecrets, filename), opts.forceSecrets);
    eventKeys.push(key);
    tenantEnv.push([`${envName}_FILE`, `/run/secrets/agentic-primary/${filename}`]);
    tenantRefs[slug] = {
      eventKeyEnv: envName,
      signingKeyEnv: "INNGEST_SIGNING_KEY",
      serveOriginEnv: "PRIMARY_TENANT_INNGEST_SERVE_ORIGIN",
      baseUrlEnv: "PRIMARY_TENANT_INNGEST_BASE_URL",
    };
  }
  execution.assertOwned();
  guardedDerivedSecret(path.join(primaryBrokerSecrets, "primary-event-keys"), eventKeys.join("\n"));

  execution.assertOwned();
  const sandboxEventKey = guardedSecret(path.join(sandboxSecrets, "event-key"), opts.forceSecrets);
  const sandboxSigningKey = guardedSecret(path.join(sandboxSecrets, "signing-key"), opts.forceSecrets);
  const sandboxControlBearer = guardedSecret(path.join(sandboxSecrets, "control-bearer"), opts.forceSecrets);
  const sandboxWorkloadToken = guardedSecret(path.join(sandboxSecrets, "workload-token"), opts.forceSecrets);
  const sandboxModelProxyToken = guardedSecret(path.join(sandboxSecrets, "model-proxy-token"), opts.forceSecrets);
  execution.assertOwned();
  const sandboxCancelFenceIntegrityKey = persistentIntegritySecret(
    path.join(sandboxSecrets, "cancel-fence-hmac"),
    "cancel-fence",
  );
  execution.assertOwned();
  const sandboxGatewayTombstoneIntegrityKey = persistentIntegritySecret(
    path.join(sandboxSecrets, "gateway-tombstone-hmac"),
    "gateway tombstone",
  );
  const codeactExecutorToken = guardedSecret(path.join(codeactExecutorSecrets, "token"), opts.forceSecrets);
  // The request key also authenticates consumed-nonces.ndjson.  That ledger is
  // durable anti-replay state, so rotating this key independently would make a
  // healthy control volume unreadable on the next restart.  A future online
  // rotation must use a versioned keyring and atomically re-sign the ledger;
  // the generic --rotate-secrets switch must preserve it in the meantime.
  execution.assertOwned();
  const requestHmac = persistentIntegritySecret(
    path.join(sandboxSecrets, "request-hmac"),
    "sandbox request nonce ledger",
  );
  execution.assertOwned();
  const resultHmac = persistentIntegritySecret(
    path.join(sandboxSecrets, "result-hmac"),
    "sandbox result journal",
  );
  execution.assertOwned();
  const receiptHmac = persistentIntegritySecret(
    path.join(sandboxSecrets, "receipt-hmac"),
    "sandbox execution receipts",
  );
  guardedDerivedSecret(path.join(sandboxBrokerSecrets, "sandbox-event-keys"), sandboxEventKey);
  guardedDerivedSecret(path.join(sandboxBrokerSecrets, "sandbox-signing-key"), sandboxSigningKey);
  const sandboxPostgresPassword = guardedDatabaseSecret(
    path.join(sandboxBrokerSecrets, "sandbox-postgres-password"),
  );
  const sandboxRedisPassword = guardedSecret(path.join(sandboxBrokerSecrets, "sandbox-redis-password"), opts.forceSecrets);
  guardedDerivedSecret(
    path.join(sandboxBrokerSecrets, "sandbox-redis-acl"),
    `user default on >${sandboxRedisPassword} ~* &* +@all`,
  );

  execution.assertOwned();
  const arch = await dockerArch(execution.runCommand);
  const dockerSocket = await dockerSocketHostPath(
    execution.runCommand,
    process.env.FACTORY_CODEACT_DOCKER_SOCKET_HOST_PATH
      ?? source.FACTORY_CODEACT_DOCKER_SOCKET_HOST_PATH,
  );
  const inngestImage = await immutableImage(
    execution.runCommand,
    process.env.PRIMARY_INNGEST_SOURCE_IMAGE
      ?? source.PRIMARY_INNGEST_SOURCE_IMAGE
      ?? previousGenerated.PRIMARY_INNGEST_IMAGE
      ?? "inngest/inngest:v1.22.0",
    arch,
    opts.pull,
  );
  const postgresImage = await immutableImage(
    execution.runCommand,
    process.env.PRIMARY_POSTGRES_SOURCE_IMAGE
      ?? source.PRIMARY_POSTGRES_SOURCE_IMAGE
      ?? previousGenerated.PRIMARY_POSTGRES_IMAGE
      ?? "postgres:17-alpine",
    arch,
    opts.pull,
  );
  const redisImage = await immutableImage(
    execution.runCommand,
    process.env.PRIMARY_REDIS_SOURCE_IMAGE
      ?? source.PRIMARY_REDIS_SOURCE_IMAGE
      ?? previousGenerated.PRIMARY_REDIS_IMAGE
      ?? "redis:7.4-alpine",
    arch,
    opts.pull,
  );
  const nodeBaseImage = await immutableImage(
    execution.runCommand,
    process.env.AGENTIC_NODE_BASE_SOURCE_IMAGE
      ?? source.AGENTIC_NODE_BASE_SOURCE_IMAGE
      ?? previousGenerated.AGENTIC_NODE_BASE_IMAGE
      ?? "node:26-slim",
    arch,
    opts.pull,
  );

  const treeFingerprint = await sourceFingerprint(execution.runCommand);
  const sourceStable = <T>(phase: string, operation: () => Promise<T>) =>
    runWithStableSourceFingerprint({
      expected: treeFingerprint,
      phase,
      operation,
      observeFingerprint: () => sourceFingerprint(execution.runCommand),
    });
  const fingerprint = createHash("sha256")
    .update(`agentic-local-image-set/v1\0${treeFingerprint}\0${nodeBaseImage}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  const buildId = `local-${fingerprint}`;
  const tags = {
    api: `agentic-api:production-${fingerprint}`,
    web: `agentic-web:production-${fingerprint}`,
    control: `agentic-sandbox-control:production-${fingerprint}`,
    workload: `agentic-sandbox-workload:production-${fingerprint}`,
    candidate: `agentic-codeact-candidate:production-${fingerprint}`,
    executor: `agentic-production-codeact-executor:production-${fingerprint}`,
    gateway: `agentic-sandbox-gateway:production-${fingerprint}`,
  };
  const imageIds: Record<keyof typeof tags, string> = {
    api: "",
    web: "",
    control: "",
    workload: "",
    candidate: "",
    executor: "",
    gateway: "",
  };
  if (opts.build) {
    execution.assertOwned();
    const baseBuildArgs = { NODE_BASE_IMAGE: nodeBaseImage };
    imageIds.api = await sourceStable("api image build", () => buildImage(execution.runCommand, { tag: tags.api, dockerfile: "apps/api/Dockerfile", target: "api-runtime", buildId, buildArgs: baseBuildArgs }));
    imageIds.web = await sourceStable("web image build", () => buildImage(execution.runCommand, { tag: tags.web, dockerfile: "apps/web/Dockerfile", target: "runtime", buildId, buildArgs: { ...baseBuildArgs, AGENTIC_API_URL: "http://api:3501" } }));
    imageIds.control = await sourceStable("sandbox control image build", () => buildImage(execution.runCommand, { tag: tags.control, dockerfile: "apps/api/Dockerfile", target: "sandbox-control", buildId, buildArgs: baseBuildArgs }));
    imageIds.workload = await sourceStable("sandbox workload image build", () => buildImage(execution.runCommand, { tag: tags.workload, dockerfile: "apps/api/Dockerfile", target: "sandbox-workload", buildId, buildArgs: baseBuildArgs }));
    imageIds.candidate = await sourceStable("CodeAct candidate image build", () => buildImage(execution.runCommand, { tag: tags.candidate, dockerfile: "apps/api/Dockerfile", target: "codeact-candidate", buildId, buildArgs: baseBuildArgs }));
    imageIds.executor = await sourceStable("production CodeAct executor image build", () => buildImage(execution.runCommand, { tag: tags.executor, dockerfile: "apps/api/Dockerfile", target: "production-codeact-executor", buildId, buildArgs: baseBuildArgs }));
    imageIds.gateway = await sourceStable("sandbox gateway image build", () => buildImage(execution.runCommand, { tag: tags.gateway, dockerfile: "apps/api/Dockerfile", target: "sandbox-broker-gateway", buildId, buildArgs: baseBuildArgs }));
  } else {
    for (const name of Object.keys(tags) as Array<keyof typeof tags>) {
      imageIds[name] = await sourceStable(`${name} existing image lookup`, () =>
        execution.runCommand(
          "docker",
          ["image", "inspect", tags[name], "--format", "{{.Id}}"],
          { capture: true },
        ));
    }
  }
  const imageRoles: Record<keyof typeof tags, string> = {
    api: "api",
    web: "web",
    control: "control",
    workload: "workload",
    candidate: "codeact-candidate",
    executor: "production-codeact-executor",
    gateway: "gateway",
  };
  for (const name of Object.keys(tags) as Array<keyof typeof tags>) {
    const imageId = imageIds[name];
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new Error(`${name} image did not resolve to an immutable local image id`);
    }
    const inspected = JSON.parse(await sourceStable(`${name} image label inspection`, () =>
      execution.runCommand("docker", ["image", "inspect", tags[name]], { capture: true }))) as Array<{
      Id?: string;
      Config?: { Labels?: Record<string, string> };
    }>;
    const actual = inspected[0];
    if (
      actual?.Id !== imageId
      || actual.Config?.Labels?.["org.opencontainers.image.revision"] !== buildId
      || actual.Config?.Labels?.["io.agentic.sandbox.role"] !== imageRoles[name]
    ) {
      throw new Error(`${name} tag/image/build/role binding changed after the curated build`);
    }
  }
  if (new Set(Object.values(imageIds)).size !== Object.keys(imageIds).length) {
    throw new Error("curated production targets must resolve to distinct image IDs");
  }
  // Builds may take many minutes. A host supervisor or Compose policy could
  // restart the old API after the initial gate, so re-prove exclusive database
  // ownership before producing the deployable environment contract. This does
  // not stop anything automatically; a conflict aborts with operator action.
  await assertProductionSetupSafety(dataRoot, { ownedWriterLease: writerLease });
  execution.assertOwned();
  const workloadDigest = imageIds.workload;
  const candidateDigest = imageIds.candidate;
  const executorDigest = imageIds.executor;
  const explicitSessionSecret = process.env.AUTH_SESSION_SECRET?.trim()
    || source.AUTH_SESSION_SECRET?.trim()
    || "";
  if (explicitSessionSecret && explicitSessionSecret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters");
  }
  const sessionSecretFile = path.join(apiSecrets, "auth-session-secret");
  execution.assertOwned();
  if (
    !explicitSessionSecret
    && !existsSync(sessionSecretFile)
    && (previousGenerated.AUTH_SESSION_SECRET?.trim().length ?? 0) >= 32
  ) {
    execution.mutate("session secret migration", () =>
      safeWrite(sessionSecretFile, previousGenerated.AUTH_SESSION_SECRET!.trim(), false));
  }
  const sessionSecret = explicitSessionSecret
    ? (guardedDerivedSecret(sessionSecretFile, explicitSessionSecret), explicitSessionSecret)
    : execution.mutate("session secret file", () =>
      persistedSessionSecret(sessionSecretFile, opts.forceSecrets));
  execution.assertOwned();
  const webBindAddress = process.env.WEB_BIND_ADDRESS?.trim()
    || source.WEB_BIND_ADDRESS?.trim()
    || "127.0.0.1";
  const webPort = process.env.WEB_PORT?.trim()
    || source.WEB_PORT?.trim()
    || "3599";
  const webOrigin = process.env.WEB_ORIGIN?.trim()
    || source.WEB_ORIGIN?.trim()
    || `http://localhost:${webPort}`;
  const apiBindAddress = process.env.API_BIND_ADDRESS?.trim()
    || source.API_BIND_ADDRESS?.trim()
    || "127.0.0.1";
  const apiPort = process.env.API_PORT?.trim()
    || source.API_PORT?.trim()
    || "3501";
  if (isIP(apiBindAddress) !== 4) {
    throw new Error("API_BIND_ADDRESS must be an explicit IPv4 address");
  }
  if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65_535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }
  const sandboxDeployment = resolveProductionSandboxDeployment({
    ambient: process.env,
    source,
    previous: previousGenerated,
    localBuildId: buildId,
    localWorkloadDigest: workloadDigest,
    fingerprint,
  });
  const lines: Array<[string, string]> = [
    // Application/vendor settings are intentionally first. Every deployment
    // authority below wins even if the deny-list misses a newly introduced
    // internal variable in an operator's old .env file.
    ...copyRuntimeSettings(source),
    ["NODE_ENV", "production"],
    ["AGENTIC_API_NODE_ENV", "production"],
    ["AGENTIC_BUILD_ID", buildId],
    ["AUTH_MODE", "production"],
    ["AUTH_SESSION_SECRET", sessionSecret],
    ["AGENTIC_RUNTIME_UID", storageIdentity.uid],
    ["AGENTIC_RUNTIME_GID", storageIdentity.gid],
    ["API_BIND_ADDRESS", apiBindAddress],
    ["API_PORT", apiPort],
    ["WEB_BIND_ADDRESS", webBindAddress],
    ["WEB_PORT", webPort],
    ["WEB_ORIGIN", webOrigin],
    [
      "AGENTIC_API_URL",
      process.env.AGENTIC_API_URL?.trim()
        || source.AGENTIC_API_URL?.trim()
        || `http://localhost:${apiPort}`,
    ],
    ["AGENTIC_ENABLED_TENANTS", tenants.join(",")],
    ["DATABASE_URL", "file:/app/data/agentic.db"],
    ["INNGEST_DEV", "0"],
    ["INNGEST_BASE_URL", "http://inngest:8288"],
    ["INNGEST_SERVE_ORIGIN", "http://api:3501"],
    ["INNGEST_EVENT_KEY_FILE", "/run/secrets/agentic-primary/system-event-key"],
    ["INNGEST_SIGNING_KEY_FILE", "/run/secrets/agentic-primary/signing-key"],
    ["INNGEST_TENANT_CONFIG_REFS", JSON.stringify(tenantRefs)],
    ["PRIMARY_TENANT_INNGEST_SERVE_ORIGIN", "http://api:3501"],
    ["PRIMARY_TENANT_INNGEST_BASE_URL", "http://inngest:8288"],
    ["INNGEST_RECONCILE_MS", "60000"],
    ["PRIMARY_INNGEST_IMAGE", inngestImage],
    ["PRIMARY_POSTGRES_IMAGE", postgresImage],
    ["PRIMARY_REDIS_IMAGE", redisImage],
    ["AGENTIC_API_IMAGE", imageIds.api],
    ["AGENTIC_WEB_IMAGE", imageIds.web],
    ["AGENTIC_NODE_BASE_IMAGE", nodeBaseImage],
    ["SANDBOX_INNGEST_IMAGE", inngestImage],
    ["SANDBOX_POSTGRES_IMAGE", postgresImage],
    ["SANDBOX_REDIS_IMAGE", redisImage],
    ["FACTORY_SANDBOX_REMOTE_CONFIG_REFS", JSON.stringify({
      runnerUrlEnv: "FACTORY_SB_RUNNER_URL",
      requestSigningKeyEnv: "FACTORY_SB_REQUEST_HMAC",
      resultSigningKeyEnv: "FACTORY_SB_RESULT_HMAC",
      receiptSigningKeyEnv: "FACTORY_SB_RECEIPT_HMAC",
      keyIdEnv: "FACTORY_SB_KEY_ID",
      runnerIdEnv: "FACTORY_SB_RUNNER_ID",
      allowedBuildIdsEnv: "FACTORY_SB_ALLOWED_BUILD_IDS",
      allowedImageDigestsEnv: "FACTORY_SB_ALLOWED_IMAGE_DIGESTS",
    })],
    ["FACTORY_SB_RUNNER_URL", sandboxDeployment.runnerUrl],
    ["FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS", sandboxDeployment.runnerHttpAllowedHosts],
    ["FACTORY_SB_REQUEST_HMAC_FILE", "/run/secrets/factory-sandbox/request-hmac"],
    ["FACTORY_SB_REQUEST_HMAC_HOST_FILE", path.join(sandboxSecrets, "request-hmac")],
    ["FACTORY_SB_RESULT_HMAC_FILE", "/run/secrets/factory-sandbox/result-hmac"],
    ["FACTORY_SB_RESULT_HMAC_HOST_FILE", path.join(sandboxSecrets, "result-hmac")],
    ["FACTORY_SB_RECEIPT_HMAC_FILE", "/run/secrets/factory-sandbox/receipt-hmac"],
    ["FACTORY_SB_RECEIPT_HMAC_HOST_FILE", path.join(sandboxSecrets, "receipt-hmac")],
    ["FACTORY_SB_MODEL_PROXY_TOKEN_FILE", "/run/secrets/factory-sandbox/model-proxy-token"],
    ["FACTORY_SB_MODEL_PROXY_TOKEN_HOST_FILE", path.join(sandboxSecrets, "model-proxy-token")],
    ["SANDBOX_CANCEL_FENCE_HMAC_FILE", "/run/secrets/factory-sandbox/cancel-fence-hmac"],
    ["SANDBOX_CANCEL_FENCE_HMAC_HOST_FILE", path.join(sandboxSecrets, "cancel-fence-hmac")],
    ["SANDBOX_CANCEL_FENCE_MAX_ENTRIES", "10000"],
    ["SANDBOX_GATEWAY_TOMBSTONE_HMAC_FILE", "/run/secrets/factory-sandbox/gateway-tombstone-hmac"],
    ["SANDBOX_GATEWAY_TOMBSTONE_HMAC_HOST_FILE", path.join(sandboxSecrets, "gateway-tombstone-hmac")],
    ["SANDBOX_GATEWAY_TOMBSTONE_MAX_ENTRIES", "10000"],
    ["SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS", "api"],
    ["FACTORY_SB_KEY_ID", sandboxDeployment.keyId],
    ["FACTORY_SB_RUNNER_ID", sandboxDeployment.runnerId],
    // This identity configures only the optional same-host diagnostic runner.
    // The external runner proves its independently allowlisted build in each
    // signed health/execution receipt.
    ["FACTORY_SB_RUNNER_BUILD_ID", buildId],
    ["FACTORY_SB_RUNTIME_IMAGE_DIGEST", sandboxDeployment.runtimeImageDigest],
    ["SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER", "same_host_container"],
    ["FACTORY_SB_ALLOWED_BUILD_IDS", sandboxDeployment.allowedBuildIds],
    ["FACTORY_SB_ALLOWED_IMAGE_DIGESTS", sandboxDeployment.allowedImageDigests],
    // 执行面证明校验的完整引用（见 ProductionSandboxDeploymentConfig 注释）。
    ["FACTORY_SB_EXECUTION_PLANE_ID", sandboxDeployment.executionPlaneId ?? ""],
    ["FACTORY_SB_EXECUTION_PLANE_TRUST_DOMAIN", sandboxDeployment.executionPlaneTrustDomain ?? ""],
    ["FACTORY_SB_PLATFORM_ATTESTOR_KEY_ID", sandboxDeployment.platformAttestorKeyId ?? ""],
    ["FACTORY_SB_PLATFORM_ATTESTOR_PUBLIC_KEY_FILE", sandboxDeployment.platformAttestorPublicKeyFile ?? ""],
    ["EXTERNAL_SANDBOX_ATTESTOR_PUBLIC_HOST_FILE", sandboxDeployment.platformAttestorPublicHostFile ?? ""],
    ["FACTORY_PRIMARY_HOST_IDENTITY_HASH", sandboxDeployment.primaryHostIdentityHash ?? ""],
    ["FACTORY_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH", sandboxDeployment.primaryDockerDaemonIdentityHash ?? ""],
    ["FACTORY_SB_ALLOWED_CONTROL_HOST_IDENTITY_HASHES", sandboxDeployment.allowedControlHostIdentityHashes ?? ""],
    ["FACTORY_SB_ALLOWED_WORKLOAD_HOST_IDENTITY_HASHES", sandboxDeployment.allowedWorkloadHostIdentityHashes ?? ""],
    ["FACTORY_SB_ALLOWED_DOCKER_DAEMON_IDENTITY_HASHES", sandboxDeployment.allowedDockerDaemonIdentityHashes ?? ""],
    ["EXTERNAL_SANDBOX_VM_ADDRESS", sandboxDeployment.vmAddress ?? ""],
    ["EXTERNAL_SANDBOX_CA_HOST_FILE", sandboxDeployment.caHostFile ?? ""],
    ["FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE", "/app/data/factory-production-image-attestation.json"],
    ["FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY", sandboxDeployment.topology],
    ["FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE", "/run/secrets/factory-production-image-attestation-public.pem"],
    ["FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_HOST_FILE", productionImageTrustRoot.publicKeyFile],
    ["FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS", "300000"],
    ["FACTORY_PRODUCTION_PROBE_TOKEN_FILE", "/run/secrets/agentic-primary/factory-production-probe-token"],
    ["FACTORY_PRODUCTION_PROBE_TOKEN_HOST_FILE", path.join(apiSecrets, "factory-production-probe-token")],
    ["FACTORY_SANDBOX_BUDGET_TOKENS", "500000"],
    ["FACTORY_EXEC_GENERATED", "1"],
    ["FACTORY_CODEACT_CANDIDATE_IMAGE", candidateDigest],
    ["FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS", JSON.stringify([candidateDigest])],
    ["FACTORY_CODEACT_DOCKER_SOCKET_HOST_PATH", dockerSocket.path],
    ["FACTORY_CODEACT_DOCKER_SOCKET_GID", dockerSocket.gid],
    ["PRODUCTION_CODEACT_EXECUTOR_ENABLED", "1"],
    ["PRODUCTION_CODEACT_EXECUTOR_IMAGE", imageIds.executor],
    ["PRODUCTION_CODEACT_EXECUTOR_URL", "http://codeact-executor:3570"],
    ["PRODUCTION_CODEACT_EXECUTOR_TOKEN_FILE", "/run/secrets/codeact-executor/token"],
    ["PRODUCTION_CODEACT_EXECUTOR_TOKEN_HOST_FILE", path.join(codeactExecutorSecrets, "token")],
    ["PRODUCTION_CODEACT_EXECUTOR_HTTP_ALLOWED_HOSTS", "codeact-executor"],
    ["PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID", `production-codeact-${buildId}`],
    ["PRODUCTION_CODEACT_EXPECTED_BUILD_ID", buildId],
    ["PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS", JSON.stringify([candidateDigest])],
    ["PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS", JSON.stringify([candidateDigest])],
    ["PRODUCTION_CODEACT_REAPER_INTERVAL_MS", "30000"],
    ["PRODUCTION_CODEACT_ORPHAN_GRACE_MS", "120000"],
    ["PRODUCTION_CODEACT_DRAIN_TIMEOUT_MS", "15000"],
    ["FACTORY_SANDBOX_CONTROL_IMAGE", imageIds.control],
    ["FACTORY_SANDBOX_WORKLOAD_IMAGE", imageIds.workload],
    ["FACTORY_SANDBOX_GATEWAY_IMAGE", imageIds.gateway],
    ["FACTORY_SANDBOX_CONTROL_PULL_POLICY", "never"],
    ["FACTORY_SANDBOX_WORKLOAD_PULL_POLICY", "never"],
    ["FACTORY_SANDBOX_GATEWAY_PULL_POLICY", "never"],
    ["SANDBOX_WORKLOAD_TOKEN_FILE", "/run/secrets/factory-sandbox/workload-token"],
    ["SANDBOX_WORKLOAD_TOKEN_HOST_FILE", path.join(sandboxSecrets, "workload-token")],
    ["SANDBOX_INNGEST_CONTROL_BEARER_FILE", "/run/secrets/factory-sandbox/control-bearer"],
    ["SANDBOX_INNGEST_CONTROL_BEARER_HOST_FILE", path.join(sandboxSecrets, "control-bearer")],
    ["SANDBOX_INNGEST_EVENT_KEY_FILE", "/run/secrets/factory-sandbox/event-key"],
    ["SANDBOX_INNGEST_SIGNING_KEY_FILE", "/run/secrets/factory-sandbox/signing-key"],
    ["SANDBOX_INNGEST_DEV_MODE", "0"],
    ["SANDBOX_INNGEST_BASE_URL", "http://sandbox-broker-gateway:3562"],
    ["SANDBOX_INNGEST_WORKLOAD_SERVE_ORIGIN", "http://sandbox-broker-gateway:3562"],
    ["SANDBOX_INNGEST_APP_PREFIX", "agentic-factory-sandbox"],
    ["SANDBOX_INNGEST_DELETE_URL", "http://sandbox-runner:3560/internal/inngest/apps/{appId}"],
    ["FACTORY_SANDBOX_ATTEMPT_LEASE_MS", "180000"],
    ["FACTORY_SANDBOX_ATTEMPT_HEARTBEAT_MS", "30000"],
    ["FACTORY_SANDBOX_JOB_TTL_MS", "1080000"],
    ["FACTORY_SANDBOX_REAPER_MS", "60000"],
    ["FACTORY_SANDBOX_DELETE_VERIFY_MS", "8000"],
    ...tenantEnv,
  ];

  // Last writer wins while preserving deterministic output order.
  const merged = new Map<string, string>();
  for (const [name, value] of lines) merged.set(name, value);
  const output = [
    "# Generated by apps/api/scripts/setup-factory-production.ts.",
    "# Secret values live under .secrets/agent-factory and are not printed.",
    ...[...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
      ([name, value]) => encodeProductionEnvLine(name, value),
    ),
    "",
  ].join("\n");
  await sourceStable("final production environment write", async () => undefined);
  execution.assertOwned();
  execution.mutate("production env file", () => {
    writeFileSync(envPath, output, { encoding: "utf8", mode: 0o600 });
    chmodSync(envPath, 0o600);
  });
  execution.mutate("bind secret permissions", () => finalizeBindSecretPermissions([
    apiSecrets,
    primaryBrokerSecrets,
    sandboxSecrets,
    sandboxBrokerSecrets,
    codeactExecutorSecrets,
  ]));

  // Keep the raw values alive only long enough to ensure files were written;
  // output intentionally contains paths/identities, never these secrets.
  void primaryPostgresPassword;
  void factoryProductionProbeToken;
  void sandboxPostgresPassword;
  void requestHmac;
  void resultHmac;
  void receiptHmac;
  void sandboxControlBearer;
  void sandboxWorkloadToken;
  void sandboxModelProxyToken;
  void sandboxCancelFenceIntegrityKey;
  void sandboxGatewayTombstoneIntegrityKey;
  void codeactExecutorToken;
  console.log(JSON.stringify({
    ok: true,
    envFile: path.relative(root, envPath),
    tenants,
    buildId,
    sandboxTopology: sandboxDeployment.topology,
    sandboxRunnerUrl: sandboxDeployment.runnerUrl,
    workloadDigest,
    candidateDigest,
    executorDigest,
    dockerSocket: { path: dockerSocket.path, gid: dockerSocket.gid },
    postgresPasswordsPreserved: true,
    images: {
      node: nodeBaseImage,
      inngest: inngestImage,
      postgres: postgresImage,
      redis: redisImage,
      ...imageIds,
    },
    diagnosticTags: tags,
  }, null, 2));
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const setupLock = acquireProductionSetupLock(setupLockPath);
  let writerLease: SqliteWriterLease | undefined;
  try {
    setupLock.assertOwned();
    await assertProductionSetupSafety(dataRoot, {
      recoverWriterLease: opts.recoverWriterLease,
    });
    setupLock.assertOwned();
    // Acquire immediately after the external proof. If an API supervisor wins
    // this race, acquisition fails and setup performs no mutation. Once setup
    // wins, the same shared lease blocks host and container writers throughout
    // the potentially long image-build transaction.
    writerLease = acquireSqliteWriterLease(`file:${path.join(dataRoot, "agentic.db")}`);
    setupLock.assertOwned();
    await runSetup(opts, writerLease, setupLock);
  } finally {
    try {
      writerLease?.release();
    } finally {
      setupLock.release();
    }
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[factory-production-setup] ${String((error as Error)?.message ?? error)}`);
    process.exitCode = 1;
  });
}
