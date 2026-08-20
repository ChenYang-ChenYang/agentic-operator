/**
 * Soft-delete + retention sweep (P1-API-04b).
 *
 * Tombstones (sets `deleted_at`) on rows in `events`, `runs`, `tasks` that are
 * older than the configured retention window. Hard-delete is intentionally
 * separate — the sweep keeps rows queryable through their retention window so
 * compliance + audit can read them; a later vacuum-style step (out of scope
 * for v1) can drop tombstoned rows after a grace period.
 *
 * The sweep is exposed two ways:
 *
 *   1. `runRetentionSweep()` — direct invocation. The API server's nightly
 *      Inngest cron calls this; tests call it inline.
 *
 *   2. `retentionSweepFn` — an Inngest scheduled function that the API
 *      bootstrap registers alongside agent functions. Runs at 03:30 UTC daily.
 *
 * Idempotency: only rows with `deleted_at IS NULL` are considered. Re-running
 * the sweep is a no-op for already-tombstoned rows.
 *
 * Configuration:
 *   - `AGENTIC_RETENTION_DAYS` — events + tasks window (default 30 days).
 *   - `AGENTIC_RUN_RETENTION_DAYS` — RUNS window, governed separately and
 *     **defaulting to 0 (keep runs forever)**. Operators asked that run
 *     monitoring records persist indefinitely and be pruned only by the
 *     user-driven delete/cleanup actions (DELETE /v1/runs). Set a positive
 *     number to re-enable an automatic run sweep. Set either to `0` to disable
 *     that table's auto-tombstoning.
 */

import { events, idempotencyKeys, runs, tasks, getDb } from "@agentic/db";
import { and, isNull, lt, sql } from "drizzle-orm";
import { inngest } from "./client";
import { validateCronExpression } from "./scheduler";
import { walkAndRotate } from "./log-rotate";

export interface RetentionResult {
  events: { tombstoned: number };
  runs: { tombstoned: number };
  tasks: { tombstoned: number };
  /**
   * UC-V11-32 / PF-GAP-10 — idempotency cache purge. Reports how many
   * expired `idempotency_keys` rows were deleted on this run. Always
   * runs (does not respect `AGENTIC_RETENTION_DAYS=0`) because the
   * 24h TTL is intrinsic to the idempotency contract, not a tenant
   * retention policy.
   */
  idempotencyKeys: { purged: number };
  ranAt: number;
  cutoffAt: number;
  /** Events + tasks retention window (days). */
  retentionDays: number;
  /** Runs retention window (days). 0 = keep runs forever (the default). */
  runRetentionDays: number;
}

function retentionDays(): number {
  const raw = process.env.AGENTIC_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/**
 * Runs retention window, governed independently of events/tasks and
 * **defaulting to 0 (permanent)**. Operators prune runs via the user-driven
 * delete/cleanup actions, not an automatic sweep — see file header.
 */
function runRetentionDays(): number {
  const raw = process.env.AGENTIC_RUN_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function runRetentionSweep(): Promise<RetentionResult> {
  const days = retentionDays();
  const runDays = runRetentionDays();
  const ranAt = Date.now();
  const cutoffAt = ranAt - days * 24 * 60 * 60 * 1000;

  // Fully disabled: report 0 rows touched but still purge the idempotency
  // cache so it doesn't grow without bound.
  if (days === 0 && runDays === 0) {
    return {
      events: { tombstoned: 0 },
      runs: { tombstoned: 0 },
      tasks: { tombstoned: 0 },
      idempotencyKeys: { purged: purgeExpiredIdempotency(ranAt) },
      ranAt,
      cutoffAt,
      retentionDays: 0,
      runRetentionDays: runDays,
    };
  }

  const db = getDb();
  const cutoffDate = new Date(cutoffAt);
  const now = new Date(ranAt);

  // events: tombstone rows where received_at < cutoff AND not yet tombstoned.
  // Skipped entirely when the events/tasks window is disabled (days === 0).
  const eventsChanges =
    days === 0
      ? 0
      : Number(
          db
            .update(events)
            .set({ deletedAt: now })
            .where(
              and(isNull(events.deletedAt), lt(events.receivedAt, cutoffDate)),
            )
            .run().changes ?? 0,
        );

  // runs: ended_at < run-cutoff (don't tombstone unfinished runs). Governed by
  // AGENTIC_RUN_RETENTION_DAYS — 0 (default) means the auto-sweep never touches
  // runs; they persist until an operator deletes them.
  const runsChanges =
    runDays === 0
      ? 0
      : Number(
          db
            .update(runs)
            .set({ deletedAt: now })
            .where(
              and(
                isNull(runs.deletedAt),
                sql`${runs.endedAt} IS NOT NULL`,
                lt(
                  runs.endedAt,
                  new Date(ranAt - runDays * 24 * 60 * 60 * 1000),
                ),
              ),
            )
            .run().changes ?? 0,
        );

  // tasks: never tombstone OPEN or RESOLVING rows. A decision is not terminal
  // until the parked Inngest wait has durably acknowledged its resume marker.
  const tasksChanges =
    days === 0
      ? 0
      : Number(
          db
            .update(tasks)
            .set({ deletedAt: now })
            .where(
              and(
                isNull(tasks.deletedAt),
                lt(tasks.createdAt, cutoffDate),
                sql`${tasks.status} NOT IN ('open', 'resolving')`,
              ),
            )
            .run().changes ?? 0,
        );

  return {
    events: { tombstoned: eventsChanges },
    runs: { tombstoned: runsChanges },
    tasks: { tombstoned: tasksChanges },
    idempotencyKeys: { purged: purgeExpiredIdempotency(ranAt) },
    ranAt,
    cutoffAt,
    retentionDays: days,
    runRetentionDays: runDays,
  };
}

/**
 * Hard-delete `idempotency_keys` rows whose 24h TTL has expired.
 *
 * Unlike the tenant tables we don't tombstone — the cache is by
 * construction transient and a 25h-old row would just be a missed-cache
 * lookup anyway. We DELETE outright so the table stays small. Returns
 * the row count for the retention log line.
 */
function purgeExpiredIdempotency(nowMs: number): number {
  const db = getDb();
  const result = db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, new Date(nowMs)))
    .run();
  return Number((result as unknown as { changes?: number }).changes ?? 0);
}

/**
 * Inngest scheduled function. Registered alongside agent functions in
 * `apps/api/src/bootstrap.ts` so it ships in the same Inngest worker.
 *
 * Cron defaults to 0 3 * * * and is controlled by AGENTIC_SYSTEM_CRON.
 * AGENTIC_SYSTEM_CRON_DISABLED=1 removes the function from the system app.
 */
import type { InngestFunction } from "inngest";

const DEFAULT_SYSTEM_CRON = "0 3 * * *";

export interface SystemCronConfig {
  disabled: boolean;
  cron: string | null;
}

export function resolveSystemCronConfig(
  env: Record<string, string | undefined> = process.env,
): SystemCronConfig {
  const disabledRaw = env.AGENTIC_SYSTEM_CRON_DISABLED?.trim() ?? "";
  if (disabledRaw && disabledRaw !== "0" && disabledRaw !== "1") {
    throw new Error("AGENTIC_SYSTEM_CRON_DISABLED must be 0 or 1");
  }
  if (disabledRaw === "1") return { disabled: true, cron: null };
  const cron = env.AGENTIC_SYSTEM_CRON?.trim() || DEFAULT_SYSTEM_CRON;
  const validated = validateCronExpression(cron);
  if (!validated.valid) {
    throw new Error(`AGENTIC_SYSTEM_CRON is invalid: ${validated.reason}`);
  }
  return { disabled: false, cron };
}

function createRetentionSweepFn(cron: string): InngestFunction.Any {
  return inngest.createFunction(
    {
      id: "agentic.retention.sweep",
      name: "Retention sweep (P1-API-04b)",
      triggers: [{ cron }],
    },
    async () => {
      const result = await runRetentionSweep();
      const logRotation = await walkAndRotate(
        process.env.AGENTIC_LOGS_DIR ?? "./logs",
      );
      console.log(
        `[retention] sweep: events=${result.events.tombstoned} runs=${result.runs.tombstoned} tasks=${result.tasks.tombstoned} idempotency_keys=${result.idempotencyKeys.purged} logs_rotated=${logRotation.rotated} (events/tasks cutoff ${result.retentionDays}d, runs cutoff ${result.runRetentionDays === 0 ? "off — permanent" : `${result.runRetentionDays}d`})`,
      );
      return { ...result, logRotation };
    },
  );
}

const initialSystemCron = resolveSystemCronConfig();

/** Compatibility export for callers that inspect the function directly.
 * bootstrap uses retentionSweepFunctions(), which is what enforces disable. */
export const retentionSweepFn: InngestFunction.Any = createRetentionSweepFn(
  initialSystemCron.cron ?? DEFAULT_SYSTEM_CRON,
);

export function retentionSweepFunctions(
  env: Record<string, string | undefined> = process.env,
): InngestFunction.Any[] {
  const config = resolveSystemCronConfig(env);
  if (config.disabled || !config.cron) return [];
  if (config.cron === initialSystemCron.cron) return [retentionSweepFn];
  return [createRetentionSweepFn(config.cron)];
}
