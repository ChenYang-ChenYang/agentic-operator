import { readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { alias } from "drizzle-orm/sqlite-core";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  agents,
  events,
  eventTypes,
  getDb,
  llmCalls,
  runs,
  steps,
  tenants,
} from "@agentic/db";
import type {
  EventRow,
  RunBusinessResult,
  RunRow,
  RunUsageSummary,
  StepRow,
} from "@agentic/contracts";

const gunzipAsync = promisify(gunzip);

/**
 * Resolve a stored payload reference to its real JSON, for the run-detail
 * IO/Events tabs. Two ref formats coexist:
 *   - event ledger: "<file>#<byteOffset>" → the NDJSON line's `.data`
 *   - step artifact: "<file>"             → the whole JSON file
 * Bounded to MAX_PAYLOAD_BYTES so a base64 résumé can't bloat the response;
 * an oversized payload collapses to a small preview marker. A persisted ref
 * that cannot be resolved is a data-integrity failure, not an empty payload.
 */
const MAX_PAYLOAD_BYTES = 24_000;

function capPayload(
  value: unknown,
  maxPayloadBytes = MAX_PAYLOAD_BYTES,
): unknown {
  if (value == null) return value;
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= maxPayloadBytes) return value;
  return {
    _truncated: true,
    _bytes: bytes,
    _preview: serialized.slice(0, 4000),
  };
}

export async function resolvePayloadRef(
  ref: string | null | undefined,
  maxPayloadBytes = MAX_PAYLOAD_BYTES,
): Promise<unknown> {
  if (!ref) return null;
  const hashIdx = ref.lastIndexOf("#");
  if (hashIdx === -1) {
    // step artifact — the whole file is the payload. Best-effort: a missing
    // artifact file (ENOENT) resolves to null instead of throwing, so a run
    // whose step artifact was pruned/absent doesn't 500 the whole run-detail /
    // reasoning-agent / run-summary / events read that shares this resolver.
    try {
      return capPayload(
        JSON.parse(await readTextFileOrGzip(ref)),
        maxPayloadBytes,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  }
  // event ledger ref "<file>#<offset>" → the line's `.data`
  const filePath = ref.slice(0, hashIdx);
  const offset = Number(ref.slice(hashIdx + 1));
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`invalid payload ledger offset in ref ${ref}`);
  }
  const buf = await readBufferFileOrGzip(filePath);
  if (offset >= buf.length)
    throw new Error(`payload ledger offset is beyond EOF in ref ${ref}`);
  const nl = buf.indexOf(0x0a, offset);
  const line = buf.toString("utf8", offset, nl === -1 ? undefined : nl);
  const parsed = JSON.parse(line) as { data?: unknown };
  return capPayload(parsed.data ?? parsed, maxPayloadBytes);
}

async function readBufferFileOrGzip(filePath: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return gunzipAsync(await readFile(`${filePath}.gz`));
  }
}

async function readTextFileOrGzip(filePath: string): Promise<string> {
  return (await readBufferFileOrGzip(filePath)).toString("utf8");
}

// UC-V11-21 / AR-GAP-06 — two `events` joins on the same query (the
// trigger event AND the emitted event) need aliases or Drizzle's
// JOIN-builder collapses them to the same table reference. The trigger
// join keeps the bare `events` table for backwards compat with the
// existing `triggerEvent: events.name` selection.
const emittedEventsAlias = alias(events, "emitted_events");

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  const row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  return row?.id ?? null;
}

/**
 * Hydrate the current-step + step-count fields on a list of runs.
 * Issues two batched queries (1 for step counts per run, 1 for running step
 * name+ord per active run). Much cheaper than N+1 lookups.
 */
function hydrateStepInfo(rows: Array<RunRow & { id: string }>): RunRow[] {
  if (rows.length === 0) return rows;
  const db = getDb();
  const runIds = rows.map((r) => r.id);

  // Total step count per run
  const countMap = new Map<string, number>();
  for (const row of db
    .select({ runId: steps.runId, c: sql<number>`count(*)` })
    .from(steps)
    .where(
      sql`${steps.runId} IN (${sql.join(
        runIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(steps.runId)
    .all()) {
    countMap.set(row.runId, Number(row.c));
  }

  // For runs in "running"/"waiting"/"queued" status: find current in-flight step.
  const liveIds = rows
    .filter(
      (r) =>
        r.status === "running" ||
        r.status === "waiting" ||
        r.status === "queued",
    )
    .map((r) => r.id);
  const currentMap = new Map<string, { name: string; ord: number }>();
  if (liveIds.length > 0) {
    // Pick highest ord still in non-terminal state
    for (const row of db
      .select({
        runId: steps.runId,
        name: steps.name,
        ord: steps.ord,
        status: steps.status,
      })
      .from(steps)
      .where(
        sql`${steps.runId} IN (${sql.join(
          liveIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .orderBy(steps.runId, desc(steps.ord))
      .all()) {
      if (!currentMap.has(row.runId)) {
        currentMap.set(row.runId, { name: row.name, ord: row.ord });
      }
    }
  }

  return rows.map((r) => {
    const cur = currentMap.get(r.id);
    return {
      ...r,
      currentStepName: cur?.name ?? null,
      currentStepOrd: cur?.ord ?? null,
      stepCount: countMap.get(r.id) ?? null,
    };
  });
}

const VALID_STATUSES = [
  "queued",
  "running",
  "ok",
  "failed",
  "waiting",
  "cancelled",
] as const;

/**
 * Statuses that mean the run is still in flight. Delete/cleanup actions never
 * touch these — you can't tombstone a run that's mid-execution (the live
 * handler would keep writing to a tombstoned row).
 */
const ACTIVE_STATUSES = ["queued", "running", "waiting"] as const;

export interface RunFilterOpts {
  status?: string;
  agentName?: string;
  query?: string;
  parentRunId?: string;
  triggerEvent?: string;
  invocationSource?: "studio" | "event" | "api" | "replay" | "demo";
  businessResult?: RunBusinessResult;
  testRun?: boolean;
  from?: number;
  to?: number;
  /** true → only tombstoned rows (recycle bin); default/false → only live rows. */
  deleted?: boolean;
}

const businessResultSql = sql<RunBusinessResult>`
  CASE
    WHEN ${runs.status} IN ('queued', 'running', 'waiting') THEN 'pending'
    WHEN ${runs.status} IN ('failed', 'cancelled') THEN 'failed'
    WHEN ${runs.outputValid} = 0 THEN 'invalid'
    WHEN ${runs.emittedEventId} IS NOT NULL THEN 'produced'
    WHEN ${runs.outputValid} = 1 THEN 'completed'
    WHEN ${runs.status} = 'ok' THEN 'no_output'
    ELSE 'completed'
  END
`;

function businessResultWhere(result: RunBusinessResult) {
  switch (result) {
    case "pending":
      return inArray(runs.status, [...ACTIVE_STATUSES]);
    case "failed":
      return inArray(runs.status, ["failed", "cancelled"]);
    case "invalid":
      return and(
        notInArray(runs.status, ["failed", "cancelled"]),
        eq(runs.outputValid, false),
      )!;
    case "produced":
      return and(
        notInArray(runs.status, [...ACTIVE_STATUSES, "failed", "cancelled"]),
        isNotNull(runs.emittedEventId),
      )!;
    case "completed":
      return and(
        notInArray(runs.status, [...ACTIVE_STATUSES, "failed", "cancelled"]),
        isNull(runs.emittedEventId),
        eq(runs.outputValid, true),
      )!;
    case "no_output":
      return and(
        eq(runs.status, "ok"),
        isNull(runs.emittedEventId),
        isNull(runs.outputValid),
      )!;
  }
}

/**
 * Build the shared WHERE predicate for the runs list surfaces. Always applies
 * the tenant scope + the soft-delete lens (live rows by default, tombstoned
 * rows when `deleted`), plus the optional status / agent / free-text / parent
 * filters. Centralising this fixed a latent bug where `listRecentRuns` never
 * filtered `deleted_at`, so soft-deleted runs kept surfacing in the operator UI.
 */
function buildRunWhere(tenantId: string, opts: RunFilterOpts) {
  const whereParts = [
    eq(runs.tenantId, tenantId),
    opts.deleted ? isNotNull(runs.deletedAt) : isNull(runs.deletedAt),
  ];
  if (opts.parentRunId) {
    whereParts.push(eq(runs.parentRunId, opts.parentRunId));
  }
  if (
    opts.status &&
    opts.status !== "all" &&
    (VALID_STATUSES as readonly string[]).includes(opts.status)
  ) {
    whereParts.push(
      eq(runs.status, opts.status as (typeof VALID_STATUSES)[number]),
    );
  }
  if (opts.agentName) {
    whereParts.push(eq(agents.name, opts.agentName));
  }
  if (opts.triggerEvent) {
    whereParts.push(eq(events.name, opts.triggerEvent));
  }
  if (opts.invocationSource) {
    whereParts.push(eq(runs.invocationSource, opts.invocationSource));
  }
  if (opts.businessResult) {
    whereParts.push(businessResultWhere(opts.businessResult));
  }
  if (opts.testRun !== undefined) {
    whereParts.push(eq(runs.isTest, opts.testRun));
  }
  if (opts.from !== undefined) {
    whereParts.push(gte(runs.queuedAt, new Date(opts.from)));
  }
  if (opts.to !== undefined) {
    whereParts.push(lte(runs.queuedAt, new Date(opts.to)));
  }
  if (opts.query) {
    const q = `%${opts.query}%`;
    whereParts.push(
      or(
        like(runs.id, q),
        like(runs.subject, q),
        like(runs.correlationId, q),
        like(agents.name, q),
        like(agents.title, q),
        like(events.name, q),
      )!,
    );
  }
  return whereParts;
}

export async function listRecentRuns(
  tenantSlug: string,
  opts: {
    limit?: number;
    status?: string;
    agentName?: string;
    query?: string;
    parentRunId?: string;
    triggerEvent?: string;
    invocationSource?: "studio" | "event" | "api" | "replay" | "demo";
    businessResult?: RunBusinessResult;
    testRun?: boolean;
    from?: number;
    to?: number;
    deleted?: boolean;
  } = {},
): Promise<RunRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  const whereParts = buildRunWhere(tenantId, opts);

  const rows = db
    .select({
      id: runs.id,
      status: runs.status,
      sessionId: runs.sessionId,
      agentVersionId: runs.agentVersionId,
      draftRevisionId: runs.draftRevisionId,
      invocationSource: runs.invocationSource,
      businessResult: businessResultSql,
      definitionHash: runs.definitionHash,
      outputValid: runs.outputValid,
      sideEffectMode: runs.sideEffectMode,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      triggerEvent: events.name,
      emittedEvent: emittedEventsAlias.name,
      queuedAt: runs.queuedAt,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      provider: runs.provider,
      model: runs.model,
      correlationId: runs.correlationId,
      errorMessage: runs.errorMessage,
      logPath: runs.logPath,
      codeRan: runs.codeRan,
      codeExecuted: runs.codeExecuted,
      codeIsolation: runs.codeIsolation,
      codeSha256: runs.codeSha256,
      codeAttestation: runs.codeAttestation,
      codeExecutionFailure: runs.codeExecutionFailure,
      // Surfacing parentRunId lets the list render a REPLAY/child badge and
      // lets the trace tree fetch a run's children via ?parentRunId=.
      parentRunId: runs.parentRunId,
      // P2-FE-18 — `testRun` lets cold-loaded views render the TEST badge
      // without a follow-up SSE roundtrip. The column is non-null in the
      // schema (default false) but we still coerce defensively.
      isTest: runs.isTest,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      emittedEventsAlias,
      eq(emittedEventsAlias.id, runs.emittedEventId),
    )
    .where(and(...whereParts))
    .orderBy(desc(runs.queuedAt))
    .limit(opts.limit ?? 50)
    .all()
    .map((r) => ({
      ...r,
      // P2-FE-18 — surface both spellings; `errorMessage` is the legacy field
      // hit by tc-18 fixtures, `error` is the shorter alias the portal reads.
      error: r.errorMessage,
      testRun: r.isTest === true,
      currentStepName: null,
      currentStepOrd: null,
      stepCount: null,
    })) as RunRow[];

  return hydrateStepInfo(rows);
}

/**
 * Server-side keyset-free paginated listing (1-indexed `page`, `pageSize`
 * rows). Returns the current page plus the full filtered `total` so the UI can
 * render page controls. OFFSET pagination is fine here — operators keep at most
 * a few thousand runs and prune old ones, and the `(tenant_id, started_at)`
 * index backs the ORDER BY. Shares the exact filter predicate with
 * `listRecentRuns` via `buildRunWhere`, including the soft-delete lens.
 */
export async function listRunsPaged(
  tenantSlug: string,
  opts: {
    page?: number;
    pageSize?: number;
    status?: string;
    agentName?: string;
    query?: string;
    parentRunId?: string;
    triggerEvent?: string;
    invocationSource?: "studio" | "event" | "api" | "replay" | "demo";
    businessResult?: RunBusinessResult;
    testRun?: boolean;
    from?: number;
    to?: number;
    deleted?: boolean;
  } = {},
): Promise<{ rows: RunRow[]; total: number; page: number; pageSize: number }> {
  const db = getDb();
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(opts.pageSize ?? 50)));
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return { rows: [], total: 0, page, pageSize };

  const whereParts = buildRunWhere(tenantId, opts);

  // Total is joined through `agents` because the free-text / agent filters
  // reference `agents.name`. The events joins aren't needed for a count.
  const totalRow = db
    .select({ c: sql<number>`count(*)` })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .where(and(...whereParts))
    .all()[0];
  const total = Number(totalRow?.c ?? 0);

  const rows = db
    .select({
      id: runs.id,
      status: runs.status,
      invocationSource: runs.invocationSource,
      businessResult: businessResultSql,
      outputValid: runs.outputValid,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      triggerEvent: events.name,
      emittedEvent: emittedEventsAlias.name,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      model: runs.model,
      correlationId: runs.correlationId,
      errorMessage: runs.errorMessage,
      logPath: runs.logPath,
      codeRan: runs.codeRan,
      codeExecuted: runs.codeExecuted,
      codeIsolation: runs.codeIsolation,
      codeSha256: runs.codeSha256,
      codeAttestation: runs.codeAttestation,
      codeExecutionFailure: runs.codeExecutionFailure,
      parentRunId: runs.parentRunId,
      isTest: runs.isTest,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      emittedEventsAlias,
      eq(emittedEventsAlias.id, runs.emittedEventId),
    )
    .where(and(...whereParts))
    .orderBy(desc(runs.startedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()
    .map((r) => ({
      ...r,
      error: r.errorMessage,
      testRun: r.isTest === true,
      currentStepName: null,
      currentStepOrd: null,
      stepCount: null,
    })) as RunRow[];

  return { rows: hydrateStepInfo(rows), total, page, pageSize };
}

/** Outcome codes for {@link softDeleteRun} so the route can pick the HTTP status. */
export type DeleteRunReason = "ok" | "not_found" | "active" | "already_deleted";

/**
 * Soft-delete (tombstone) a single run — recoverable via {@link restoreRun}.
 * Tenant-scoped (a run the caller doesn't own resolves to `not_found`, never
 * leaking existence) and refuses to touch an in-flight run. Idempotent:
 * re-deleting an already-tombstoned run reports `already_deleted` (the route
 * treats it as a 200 no-op).
 */
export function softDeleteRun(
  tenantId: string,
  runId: string,
): DeleteRunReason {
  const db = getDb();
  const row = db
    .select({
      tenantId: runs.tenantId,
      status: runs.status,
      deletedAt: runs.deletedAt,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .all()[0];
  if (!row || row.tenantId !== tenantId) return "not_found";
  if ((ACTIVE_STATUSES as readonly string[]).includes(row.status))
    return "active";
  if (row.deletedAt) return "already_deleted";
  db.update(runs)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.tenantId, tenantId),
        isNull(runs.deletedAt),
      ),
    )
    .run();
  return "ok";
}

/** Un-tombstone a soft-deleted run. Returns false if nothing was restored
 *  (wrong tenant, not found, or not currently deleted). */
export function restoreRun(tenantId: string, runId: string): boolean {
  const db = getDb();
  const res = db
    .update(runs)
    .set({ deletedAt: null })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.tenantId, tenantId),
        isNotNull(runs.deletedAt),
      ),
    )
    .run() as { changes?: number };
  return (res?.changes ?? 0) > 0;
}

/**
 * Bulk soft-delete finished runs for a tenant. `scope: "all"` tombstones every
 * finished (non-active, non-deleted) run; `scope: "oldest"` tombstones the `n`
 * oldest by `started_at`. Never touches an in-flight run. Returns the count.
 */
export function bulkSoftDeleteRuns(
  tenantId: string,
  scope: "all" | "oldest",
  n?: number,
): number {
  const db = getDb();
  const base = [
    eq(runs.tenantId, tenantId),
    isNull(runs.deletedAt),
    notInArray(runs.status, [...ACTIVE_STATUSES]),
  ];

  if (scope === "oldest") {
    const count = Math.max(0, Math.trunc(n ?? 0));
    if (count === 0) return 0;
    // Two-step so we tombstone exactly the N oldest — SQLite's UPDATE has no
    // ORDER BY/LIMIT, so resolve the ids first (oldest started_at first; NULL
    // started_at sorts first under SQLite, i.e. treated as oldest — fine, those
    // are the most stale rows to clear).
    const ids = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(...base))
      .orderBy(asc(runs.startedAt))
      .limit(count)
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    const res = db
      .update(runs)
      .set({ deletedAt: new Date() })
      .where(inArray(runs.id, ids))
      .run() as { changes?: number };
    return res?.changes ?? 0;
  }

  const res = db
    .update(runs)
    .set({ deletedAt: new Date() })
    .where(and(...base))
    .run() as { changes?: number };
  return res?.changes ?? 0;
}

/**
 * Resolve a stable, tenant-scoped selection for bulk operations. The caller
 * supplies either explicit ids or a filter snapshot; this helper powers the
 * portal's "select all matching" mode without sending every id through the
 * browser.
 */
export function selectRunIds(
  tenantId: string,
  opts: RunFilterOpts,
  excludeIds: string[] = [],
  limit = 10_001,
): string[] {
  const db = getDb();
  const whereParts = buildRunWhere(tenantId, opts);
  if (excludeIds.length > 0) {
    whereParts.push(notInArray(runs.id, excludeIds));
  }
  return db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .where(and(...whereParts))
    .orderBy(desc(runs.queuedAt), desc(runs.id))
    .limit(limit)
    .all()
    .map((row) => row.id);
}

export function bulkSoftDeleteRunIds(
  tenantId: string,
  runIds: string[],
): number {
  if (runIds.length === 0) return 0;
  const result = getDb()
    .update(runs)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(runs.tenantId, tenantId),
        inArray(runs.id, runIds),
        isNull(runs.deletedAt),
        notInArray(runs.status, [...ACTIVE_STATUSES]),
      ),
    )
    .run() as { changes?: number };
  return result.changes ?? 0;
}

export function bulkRestoreRunIds(tenantId: string, runIds: string[]): number {
  if (runIds.length === 0) return 0;
  const result = getDb()
    .update(runs)
    .set({ deletedAt: null })
    .where(
      and(
        eq(runs.tenantId, tenantId),
        inArray(runs.id, runIds),
        isNotNull(runs.deletedAt),
      ),
    )
    .run() as { changes?: number };
  return result.changes ?? 0;
}

async function unlinkRunLog(logPath: string): Promise<void> {
  for (const candidate of [logPath, `${logPath}.gz`]) {
    try {
      await unlink(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function purgeRunIds(
  tenantId: string,
  runIds: string[],
): Promise<number> {
  if (runIds.length === 0) return 0;
  const db = getDb();
  const doomed = db
    .select({ id: runs.id, logPath: runs.logPath })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, tenantId),
        inArray(runs.id, runIds),
        isNotNull(runs.deletedAt),
      ),
    )
    .all();
  if (doomed.length === 0) return 0;

  await Promise.all(
    doomed
      .filter((row) => row.logPath)
      .map((row) => unlinkRunLog(row.logPath as string)),
  );

  const artifactRoot = path.resolve(
    process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts",
  );
  await Promise.all(
    doomed.map(async ({ id }) => {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
        throw new Error(`refusing to purge malformed run artifact id '${id}'`);
      }
      const directory = path.resolve(artifactRoot, id);
      if (path.dirname(directory) !== artifactRoot) {
        throw new Error(
          `run artifact path escapes configured root for '${id}'`,
        );
      }
      await rm(directory, { recursive: true, force: true });
    }),
  );

  const result = db
    .delete(runs)
    .where(
      and(
        eq(runs.tenantId, tenantId),
        inArray(
          runs.id,
          doomed.map((row) => row.id),
        ),
        isNotNull(runs.deletedAt),
      ),
    )
    .run() as { changes?: number };
  return result.changes ?? 0;
}

/**
 * HARD-delete every already-tombstoned run for a tenant (empty the recycle
 * bin). Irreversible: drops the run rows (FK cascade takes steps / tasks /
 * artifacts / short-term memory / llm_turns / run_summaries with them) and
 * unlinks each run's `.log` file, which no cascade covers. Never
 * touches a live (non-deleted) run. Returns the number of run rows removed.
 */
export async function purgeDeletedRuns(tenantId: string): Promise<number> {
  const db = getDb();
  const doomed = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.tenantId, tenantId), isNotNull(runs.deletedAt)))
    .all();
  return purgeRunIds(
    tenantId,
    doomed.map((row) => row.id),
  );
}

export async function getRun(
  tenantSlug: string,
  runId: string,
): Promise<RunRow | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;
  const row = db
    .select({
      id: runs.id,
      status: runs.status,
      sessionId: runs.sessionId,
      agentVersionId: runs.agentVersionId,
      draftRevisionId: runs.draftRevisionId,
      invocationSource: runs.invocationSource,
      definitionHash: runs.definitionHash,
      outputValid: runs.outputValid,
      sideEffectMode: runs.sideEffectMode,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      triggerEvent: events.name,
      emittedEvent: emittedEventsAlias.name,
      queuedAt: runs.queuedAt,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      provider: runs.provider,
      model: runs.model,
      correlationId: runs.correlationId,
      errorMessage: runs.errorMessage,
      logPath: runs.logPath,
      codeRan: runs.codeRan,
      codeExecuted: runs.codeExecuted,
      codeIsolation: runs.codeIsolation,
      codeSha256: runs.codeSha256,
      codeAttestation: runs.codeAttestation,
      codeExecutionFailure: runs.codeExecutionFailure,
      parentRunId: runs.parentRunId,
      isTest: runs.isTest,
      // Real payloads for the run-detail IO/Events tabs: the trigger event is
      // the run's INPUT, the emitted event its OUTPUT. Resolved below.
      triggerPayloadRef: events.payloadRef,
      emittedPayloadRef: emittedEventsAlias.payloadRef,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      emittedEventsAlias,
      eq(emittedEventsAlias.id, runs.emittedEventId),
    )
    .where(
      and(
        eq(runs.tenantId, tenantId),
        eq(runs.id, runId),
        isNull(runs.deletedAt),
      ),
    )
    .all()[0];
  if (!row) return null;
  const { triggerPayloadRef, emittedPayloadRef, ...runFields } = row;
  // Resolve the real input (trigger) + output (emitted) payloads from the
  // ledger — detail-only (the list endpoint never reads files).
  const [inputPayload, outputPayload] = await Promise.all([
    resolvePayloadRef(triggerPayloadRef),
    resolvePayloadRef(emittedPayloadRef),
  ]);
  // P2-FE-18 — mirror errorMessage→error and surface isTest→testRun so the
  // detail surface matches the list surface and cold-loads paint the badge.
  const enriched = {
    ...runFields,
    error: runFields.errorMessage,
    testRun: runFields.isTest === true,
    currentStepName: null,
    currentStepOrd: null,
    stepCount: null,
    inputPayload,
    outputPayload,
  } as RunRow;
  const hydrated = hydrateStepInfo([enriched]);
  return hydrated[0] ?? null;
}

export interface RunChainRow {
  id: string;
  agentName: string;
  agentTitle: string | null;
  status: string;
  subject: string | null;
  triggerEvent: string | null;
  emittedEvent: string | null;
  startedAt: Date | null;
  durationMs: number | null;
  parentRunId: string | null;
  correlationId: string;
}

/**
 * The whole cross-run cascade sharing an anchor run's correlationId, in
 * pipeline order (ascending startedAt). The zhaopin 6-agent pipeline chains
 * runs by re-emitting events with the same correlationId (NOT parentRunId), so
 * the parentRunId-based trace tree shows nothing — this surfaces the real chain.
 * Strictly tenant-scoped: a run id the caller doesn't own resolves to null (→
 * 404) and never leaks another tenant's chain.
 */
export async function listRunChain(
  tenantSlug: string,
  runId: string,
): Promise<{ correlationId: string; runs: RunChainRow[] } | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;

  const anchor = db
    .select({ correlationId: runs.correlationId })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, tenantId),
        eq(runs.id, runId),
        isNull(runs.deletedAt),
      ),
    )
    .all()[0];
  if (!anchor) return null;

  const rows = db
    .select({
      id: runs.id,
      status: runs.status,
      agentName: agents.name,
      agentTitle: agents.title,
      subject: runs.subject,
      triggerEvent: events.name,
      emittedEvent: emittedEventsAlias.name,
      startedAt: runs.startedAt,
      durationMs: runs.durationMs,
      parentRunId: runs.parentRunId,
      correlationId: runs.correlationId,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(events, eq(events.id, runs.triggerEventId))
    .leftJoin(
      emittedEventsAlias,
      eq(emittedEventsAlias.id, runs.emittedEventId),
    )
    .where(
      and(
        eq(runs.tenantId, tenantId),
        eq(runs.correlationId, anchor.correlationId),
        isNull(runs.deletedAt),
      ),
    )
    .orderBy(runs.startedAt)
    .all() as RunChainRow[];

  return { correlationId: anchor.correlationId, runs: rows };
}

export async function listSteps(
  runId: string,
  maxPayloadBytes = MAX_PAYLOAD_BYTES,
): Promise<StepRow[]> {
  const db = getDb();
  const rows = db
    .select({
      id: steps.id,
      ord: steps.ord,
      name: steps.name,
      type: steps.type,
      status: steps.status,
      startedAt: steps.startedAt,
      endedAt: steps.endedAt,
      durationMs: steps.durationMs,
      inputRef: steps.inputRef,
      outputRef: steps.outputRef,
      error: steps.error,
      provider: steps.provider,
      model: steps.model,
      tokensIn: steps.tokensIn,
      tokensOut: steps.tokensOut,
      attempts: steps.attempts,
      codeRan: steps.codeRan,
      codeExecuted: steps.codeExecuted,
      codeIsolation: steps.codeIsolation,
      codeSha256: steps.codeSha256,
      codeAttestation: steps.codeAttestation,
      codeExecutionFailure: steps.codeExecutionFailure,
    })
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(steps.ord)
    .all();
  // Resolve each step's real input/output artifact for the Timeline/Trace/IO
  // tabs (Inngest-style per-step 📥/📤). Detail-only file reads.
  return Promise.all(
    rows.map(async ({ inputRef, outputRef, ...step }) => ({
      ...step,
      inputRef,
      outputRef,
      input: await resolvePayloadRef(inputRef, maxPayloadBytes),
      output: await resolvePayloadRef(outputRef, maxPayloadBytes),
    })),
  ) as Promise<StepRow[]>;
}

/**
 * Return a tenant-scoped, operator-safe usage summary for a single run.
 * Raw ledger rows remain on the tenant-admin usage surface; Test Lab only
 * needs live counts, authoritative token totals, and exact recorded cost.
 */
export function getRunUsageSummary(
  tenantId: string,
  runId: string,
): RunUsageSummary {
  const rows = getDb()
    .select({
      logicalCallId: llmCalls.logicalCallId,
      status: llmCalls.status,
      provider: llmCalls.provider,
      requestedModel: llmCalls.requestedModel,
      responseModel: llmCalls.responseModel,
      inputTokens: llmCalls.inputTokens,
      outputTokens: llmCalls.outputTokens,
      cachedInputTokens: llmCalls.cachedInputTokens,
      reasoningTokens: llmCalls.reasoningTokens,
      costUsdNanos: llmCalls.costUsdNanos,
      startedAt: llmCalls.startedAt,
      attempt: llmCalls.attempt,
    })
    .from(llmCalls)
    .where(and(eq(llmCalls.tenantId, tenantId), eq(llmCalls.runId, runId)))
    .orderBy(desc(llmCalls.startedAt), desc(llmCalls.attempt))
    .all();

  const priced = rows.filter((row) => row.costUsdNanos !== null);
  const providers = Array.from(new Set(rows.map((row) => row.provider)));
  const models = Array.from(
    new Set(rows.map((row) => row.responseModel ?? row.requestedModel)),
  );
  const latest = rows[0];
  return {
    logicalCalls: new Set(rows.map((row) => row.logicalCallId)).size,
    attempts: rows.length,
    succeeded: rows.filter((row) => row.status === "ok").length,
    failed: rows.filter((row) => row.status === "failed").length,
    inFlight: rows.filter((row) => row.status === "started").length,
    tokensIn: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    tokensOut: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    cachedInputTokens: rows.reduce(
      (sum, row) => sum + (row.cachedInputTokens ?? 0),
      0,
    ),
    reasoningTokens: rows.reduce(
      (sum, row) => sum + (row.reasoningTokens ?? 0),
      0,
    ),
    costUsdNanos:
      priced.length === 0
        ? null
        : priced.reduce((sum, row) => sum + row.costUsdNanos!, 0),
    pricedCalls: priced.length,
    unpricedCalls: rows.filter(
      (row) => row.status === "ok" && row.costUsdNanos === null,
    ).length,
    providers,
    models,
    latestProvider: latest?.provider ?? null,
    latestModel: latest
      ? (latest.responseModel ?? latest.requestedModel)
      : null,
  };
}

export async function listRecentEvents(
  tenantSlug: string,
  opts: { limit?: number; name?: string } = {},
): Promise<EventRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  // Soft-deleted events are invisible to operator views. The SSE live tail
  // (fetchEventsSince) applies the same filter — both surfaces must agree
  // or the catch-up GET and the live socket disagree on what's "current".
  const whereParts = [eq(events.tenantId, tenantId), isNull(events.deletedAt)];
  if (opts.name) whereParts.push(eq(events.name, opts.name));

  const rows = db
    .select({
      id: events.id,
      name: events.name,
      subject: events.subject,
      category: events.category,
      color: eventTypes.color,
      receivedAt: events.receivedAt,
      sourceAgentName: agents.name,
      sourceAgentTitle: agents.title,
      payloadRef: events.payloadRef,
    })
    .from(events)
    .leftJoin(agents, eq(agents.id, events.sourceAgentId))
    .leftJoin(
      eventTypes,
      and(
        eq(eventTypes.tenantId, events.tenantId),
        eq(eventTypes.name, events.name),
      ),
    )
    .where(and(...whereParts))
    .orderBy(desc(events.receivedAt))
    .limit(opts.limit ?? 30)
    .all();

  return hydrateEventConsumers(rows);
}

/**
 * Attach `consumers[]` to each event by looking up `runs` whose
 * `trigger_event_id` matches an event id in the page. One batched IN query
 * regardless of page size, so the cost is O(events + runs-for-this-page),
 * not O(events × runs).
 *
 * Why join through trigger_event_id instead of (name, subject)? The
 * (name, subject) pair is non-unique: when a workflow runs the same agent
 * for the same subject twice (replay, retry-with-new-event), each instance
 * gets its own (event_id, run_id) pair — joining on name/subject would
 * fold them all into one event and misattribute consumer chips. The FK is
 * exact and respects test/replay semantics.
 */
function hydrateEventConsumers(
  rows: Array<Omit<EventRow, "consumers"> & { id: string }>,
): EventRow[] {
  if (rows.length === 0) return rows;
  const db = getDb();
  const ids = rows.map((r) => r.id);

  const consumerRows = db
    .select({
      eventId: runs.triggerEventId,
      runId: runs.id,
      status: runs.status,
      agentName: agents.name,
      agentTitle: agents.title,
    })
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(
      sql`${runs.triggerEventId} IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    )
    .all();

  const byEvent = new Map<
    string,
    Array<{
      runId: string;
      agentName: string | null;
      agentTitle: string | null;
      status: string;
    }>
  >();
  for (const c of consumerRows) {
    if (!c.eventId) continue;
    const arr = byEvent.get(c.eventId) ?? [];
    arr.push({
      runId: c.runId,
      agentName: c.agentName ?? null,
      agentTitle: c.agentTitle ?? null,
      status: c.status,
    });
    byEvent.set(c.eventId, arr);
  }

  return rows.map((r) => ({ ...r, consumers: byEvent.get(r.id) ?? [] }));
}
