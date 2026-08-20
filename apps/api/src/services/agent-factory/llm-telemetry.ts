/**
 * Durable LLM telemetry.
 *
 * Every record is first written to llm_calls. If SQLite is temporarily
 * unavailable, the exact same idempotent envelope is fsync'd to an NDJSON
 * outbox and replayed later. A provider result is allowed to escape only when
 * one of those two durability paths succeeds.
 */

import path from "node:path";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { setLlmCallSink, type LlmCallRecord } from "@agentic/agent-factory";
import { getDb, llmCallTelemetry, runs } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { publishStreamEvent } from "@agentic/runtime";
import { and, eq } from "drizzle-orm";

const OUTBOX_VERSION = 1 as const;
const STALE_LOCK_MS = 30_000;

interface LlmTelemetryEnvelope {
  version: typeof OUTBOX_VERSION;
  id: string;
  createdAt: number;
  record: LlmCallRecord;
}

export interface LlmTelemetryStatus {
  /** True when the last record reached either SQLite or the fsync'd outbox. */
  ok: boolean;
  degraded: boolean;
  storage: "database" | "spool" | "unavailable";
  /** Primary SQLite write failures, including failures safely spooled. */
  totalFailures: number;
  consecutiveFailures: number;
  /** Times neither SQLite nor the outbox could make a record durable. */
  durabilityFailures: number;
  /**
   * Fan-out attempts skipped because the record carried no tenant. The row is
   * still persisted — a tenant is never invented to make it publishable — but
   * no live subscriber can be addressed, so the count is the observable signal
   * that some caller is producing unattributable spend. Counted per attempt: a
   * spool replay of the same record legitimately skips again.
   */
  unattributedFanoutSkips: number;
  spooledRecords: number;
  replayedRecords: number;
  pendingSpoolRecords: number;
  lastError?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  lastSpoolAt?: number;
  lastReplayAt?: number;
  spoolPath: string;
}

export class LlmTelemetryDurabilityError extends Error {
  override readonly name = "LlmTelemetryDurabilityError";
  readonly code = "llm_telemetry_unavailable";

  constructor(
    readonly databaseError: unknown,
    readonly spoolError: unknown,
  ) {
    super(
      "LLM telemetry could not be persisted to SQLite or the durable outbox",
      {
        cause: new AggregateError([databaseError, spoolError]),
      },
    );
  }
}

const telemetryStatus: Omit<LlmTelemetryStatus, "spoolPath"> = {
  ok: true,
  degraded: false,
  storage: "database",
  totalFailures: 0,
  consecutiveFailures: 0,
  durabilityFailures: 0,
  unattributedFanoutSkips: 0,
  spooledRecords: 0,
  replayedRecords: 0,
  pendingSpoolRecords: 0,
};

interface TelemetryTestHooks {
  persistEnvelope?: (envelope: LlmTelemetryEnvelope) => void;
  appendEnvelope?: (envelope: LlmTelemetryEnvelope, spoolPath: string) => void;
}

let testHooks: TelemetryTestHooks = {};

/** Fault-injection seam; production never sets this. */
export function _setLlmTelemetryTestHooks(
  hooks: TelemetryTestHooks | null,
): void {
  testHooks = hooks ?? {};
}

export function _resetLlmTelemetryStatusForTests(): void {
  Object.assign(telemetryStatus, {
    ok: true,
    degraded: false,
    storage: "database",
    totalFailures: 0,
    consecutiveFailures: 0,
    durabilityFailures: 0,
    unattributedFanoutSkips: 0,
    spooledRecords: 0,
    replayedRecords: 0,
    pendingSpoolRecords: 0,
    lastError: undefined,
    lastFailureAt: undefined,
    lastSuccessAt: undefined,
    lastSpoolAt: undefined,
    lastReplayAt: undefined,
  });
}

function outboxPath(): string {
  const configured = process.env.AGENTIC_LLM_TELEMETRY_SPOOL_PATH?.trim();
  if (configured) return path.resolve(configured);

  const rawDb = process.env.DATABASE_URL?.replace(/^file:/, "");
  if (rawDb && rawDb !== ":memory:") {
    const dbPath = path.isAbsolute(rawDb)
      ? rawDb
      : path.resolve(process.cwd(), rawDb);
    return `${dbPath}.llm-telemetry.ndjson`;
  }
  return path.resolve(process.cwd(), "data", "llm-telemetry-spool.ndjson");
}

export function getLlmTelemetryStatus(): LlmTelemetryStatus {
  return { ...telemetryStatus, spoolPath: outboxPath() };
}

/**
 * `llm_call_telemetry.run_id` belongs exclusively to the canonical runtime
 * `runs` table. Factory executions use `factory_runs` and are correlated by
 * their conversation/correlation attribution instead. Validate the reference
 * before both initial persistence and spool replay so a stale or cross-tenant
 * id cannot poison the durable outbox forever.
 */
function canonicalRuntimeRunId(rec: LlmCallRecord): string | null {
  if (!rec.runId || !rec.tenantId) return null;
  const row = getDb()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, rec.runId), eq(runs.tenantId, rec.tenantId)))
    .all()[0];
  return row?.id ?? null;
}

function envelopeValues(envelope: LlmTelemetryEnvelope) {
  const rec = envelope.record;
  return {
    id: envelope.id,
    tenantId: rec.tenantId ?? null,
    runId: canonicalRuntimeRunId(rec),
    domain: rec.domain ?? null,
    conversationId: rec.conversationId ?? null,
    purpose: rec.purpose ?? null,
    requestedModel: rec.requestedModel ?? null,
    servedModel: rec.servedModel ?? null,
    provider: rec.provider ?? null,
    fallback: rec.fallback ?? null,
    requestedTier: rec.requestedTier ?? null,
    modelPreference: rec.modelPreference ?? null,
    preferenceSatisfied: rec.preferenceSatisfied ?? null,
    preferenceReason: rec.preferenceReason ?? null,
    promptChars: rec.promptChars,
    completionChars: rec.completionChars,
    approxTokensIn: rec.approxTokensIn,
    approxTokensOut: rec.approxTokensOut,
    tokenSource: rec.tokenSource ?? null,
    latencyMs: rec.latencyMs,
    ok: rec.ok,
    failureReason: rec.failureReason ?? null,
    createdAt: new Date(envelope.createdAt),
  };
}

function persistEnvelope(envelope: LlmTelemetryEnvelope): void {
  if (testHooks.persistEnvelope) {
    testHooks.persistEnvelope(envelope);
    return;
  }
  getDb()
    .insert(llmCallTelemetry)
    .values(envelopeValues(envelope))
    .onConflictDoNothing({ target: llmCallTelemetry.id })
    .run();
}

function publishEnvelope(envelope: LlmTelemetryEnvelope): void {
  const rec = envelope.record;
  // An SSE/Redis frame is addressed to a tenant; there is nothing to address
  // here. Count the skip instead of returning silently — 78% of the historic
  // telemetry table was unattributed and this guard was why nobody saw it.
  if (!rec.tenantId) {
    telemetryStatus.unattributedFanoutSkips += 1;
    return;
  }
  const runtimeRunId = canonicalRuntimeRunId(rec);
  try {
    publishStreamEvent({
      type: "llm.call.completed",
      tenantId: rec.tenantId,
      at: envelope.createdAt,
      callId: envelope.id,
      runId: runtimeRunId,
      purpose: rec.purpose ?? null,
      provider: rec.provider ?? null,
      requestedModel: rec.requestedModel ?? null,
      servedModel: rec.servedModel ?? null,
      tokensIn: rec.approxTokensIn ?? null,
      tokensOut: rec.approxTokensOut ?? null,
      tokenSource: rec.tokenSource ?? null,
      latencyMs: rec.latencyMs ?? null,
      fallback: rec.fallback ?? null,
      ok: rec.ok,
      failureReason: rec.failureReason ?? null,
    });
  } catch {
    // The durable row is authoritative; SSE/Redis fan-out is recoverable and
    // must not cause a duplicate telemetry envelope.
  }
}

function ensureOutboxDirectory(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms/filesystems reject fsync on a directory. File fsync is
    // still mandatory and already completed; do not turn portability into
    // false data loss.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireOutboxLock(filePath: string): { fd: number; lockPath: string } {
  ensureOutboxDirectory(filePath);
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`, undefined, "utf8");
        fsyncSync(fd);
        return { fd, lockPath };
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original write/fsync error.
        }
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      sleepSync(10);
    }
  }
  throw new Error(`timed out acquiring telemetry outbox lock ${lockPath}`);
}

function releaseOutboxLock(lock: { fd: number; lockPath: string }): void {
  closeSync(lock.fd);
  try {
    unlinkSync(lock.lockPath);
    fsyncDirectory(path.dirname(lock.lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function appendEnvelopeToOutbox(
  envelope: LlmTelemetryEnvelope,
  filePath = outboxPath(),
): void {
  if (testHooks.appendEnvelope) {
    testHooks.appendEnvelope(envelope, filePath);
    return;
  }
  const lock = acquireOutboxLock(filePath);
  try {
    const existed = existsSync(filePath);
    const fd = openSync(filePath, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(envelope)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!existed) fsyncDirectory(path.dirname(filePath));
  } finally {
    releaseOutboxLock(lock);
  }
}

function isEnvelope(value: unknown): value is LlmTelemetryEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LlmTelemetryEnvelope>;
  return (
    candidate.version === OUTBOX_VERSION &&
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "number" &&
    !!candidate.record &&
    typeof candidate.record === "object"
  );
}

function replaceOutbox(filePath: string, lines: string[]): void {
  if (lines.length === 0) {
    try {
      unlinkSync(filePath);
      fsyncDirectory(path.dirname(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${lines.join("\n")}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

/** Replay every valid outbox line idempotently. Failed/malformed lines stay
 * durable for a later operator-assisted retry instead of being discarded. */
export function replayLlmTelemetrySpool(): {
  replayed: number;
  pending: number;
} {
  const filePath = outboxPath();
  if (!existsSync(filePath)) {
    telemetryStatus.pendingSpoolRecords = 0;
    telemetryStatus.degraded = false;
    telemetryStatus.storage = "database";
    return { replayed: 0, pending: 0 };
  }

  const lock = acquireOutboxLock(filePath);
  let replayed = 0;
  const remaining: string[] = [];
  try {
    const lines = readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const decoded: unknown = JSON.parse(line);
        if (!isEnvelope(decoded)) throw new Error("invalid telemetry envelope");
        persistEnvelope(decoded);
        publishEnvelope(decoded);
        replayed += 1;
      } catch (error) {
        remaining.push(line);
        telemetryStatus.lastError = String(
          error instanceof Error ? error.message : error,
        ).slice(0, 500);
      }
    }
    replaceOutbox(filePath, remaining);
  } finally {
    releaseOutboxLock(lock);
  }

  telemetryStatus.replayedRecords += replayed;
  telemetryStatus.pendingSpoolRecords = remaining.length;
  telemetryStatus.lastReplayAt = Date.now();
  telemetryStatus.degraded = remaining.length > 0;
  telemetryStatus.storage = remaining.length > 0 ? "spool" : "database";
  telemetryStatus.ok = true;
  if (replayed > 0) {
    telemetryStatus.consecutiveFailures = 0;
    telemetryStatus.lastSuccessAt = telemetryStatus.lastReplayAt;
  }
  return { replayed, pending: remaining.length };
}

function recordPrimaryFailure(error: unknown): void {
  telemetryStatus.totalFailures += 1;
  telemetryStatus.consecutiveFailures += 1;
  telemetryStatus.lastError = String(
    error instanceof Error ? error.message : error,
  ).slice(0, 500);
  telemetryStatus.lastFailureAt = Date.now();
}

/** Persist one record, falling back to the fsync'd outbox. Throws only when
 * neither path can guarantee durability. */
export function writeLlmCall(rec: LlmCallRecord): void {
  const envelope: LlmTelemetryEnvelope = {
    version: OUTBOX_VERSION,
    id: makeId("llm"),
    createdAt: Date.now(),
    record: rec,
  };

  try {
    persistEnvelope(envelope);
    publishEnvelope(envelope);
    telemetryStatus.ok = true;
    telemetryStatus.consecutiveFailures = 0;
    telemetryStatus.lastSuccessAt = envelope.createdAt;
    telemetryStatus.storage = "database";
    try {
      const replay = replayLlmTelemetrySpool();
      telemetryStatus.degraded = replay.pending > 0;
    } catch (replayError) {
      telemetryStatus.degraded = true;
      telemetryStatus.storage = "spool";
      telemetryStatus.lastError = String(
        replayError instanceof Error ? replayError.message : replayError,
      ).slice(0, 500);
    }
    return;
  } catch (databaseError) {
    recordPrimaryFailure(databaseError);
    try {
      appendEnvelopeToOutbox(envelope);
      telemetryStatus.ok = true;
      telemetryStatus.degraded = true;
      telemetryStatus.storage = "spool";
      telemetryStatus.spooledRecords += 1;
      telemetryStatus.pendingSpoolRecords += 1;
      telemetryStatus.lastSpoolAt = Date.now();
      console.error(
        JSON.stringify({
          level: "warn",
          component: "llm-telemetry",
          event: "persist.spooled",
          error: telemetryStatus.lastError,
          outbox: outboxPath(),
          at: telemetryStatus.lastSpoolAt,
        }),
      );
      return;
    } catch (spoolError) {
      telemetryStatus.ok = false;
      telemetryStatus.degraded = true;
      telemetryStatus.storage = "unavailable";
      telemetryStatus.durabilityFailures += 1;
      telemetryStatus.lastError =
        `${telemetryStatus.lastError}; outbox: ${String(
          spoolError instanceof Error ? spoolError.message : spoolError,
        )}`.slice(0, 500);
      console.error(
        JSON.stringify({
          level: "error",
          component: "llm-telemetry",
          event: "durability.failed",
          error: telemetryStatus.lastError,
          at: Date.now(),
        }),
      );
      throw new LlmTelemetryDurabilityError(databaseError, spoolError);
    }
  }
}

let wired = false;
export function wireLlmTelemetry(): void {
  if (wired) return;
  // Replay before accepting new provider calls. A still-unavailable database
  // leaves the durable lines in place and health exposes the degraded state.
  try {
    replayLlmTelemetrySpool();
  } catch (error) {
    telemetryStatus.degraded = true;
    telemetryStatus.storage = "spool";
    telemetryStatus.lastError = String(
      error instanceof Error ? error.message : error,
    ).slice(0, 500);
  }
  setLlmCallSink(writeLlmCall);
  wired = true;
}
