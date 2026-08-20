import { z } from "zod";

export const RunStatus = z.enum([
  "queued",
  "running",
  "ok",
  "failed",
  "waiting",
  // §G4 — operator hold; the runtime parks before its next action until
  // POST /v1/runs/:id/resume emits the tenant run.resume event.
  "paused",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const CodeActAttestationStatus = z.enum([
  "production_verified",
  "sandbox_verified",
  "sandbox_not_required",
  "not_authorized",
  "missing",
  "mismatch",
  "not_checked",
]);
export type CodeActAttestationStatus = z.infer<typeof CodeActAttestationStatus>;

/** Runtime receipt columns shared by run and step detail rows. Optional keeps
 * legacy fixtures compatible; the API query layer always returns them. */
const CodeActReceiptFields = {
  codeRan: z.boolean().nullable().optional(),
  codeExecuted: z.boolean().nullable().optional(),
  codeIsolation: z.enum(["worker_thread", "isolated_subprocess", "isolated_container"]).nullable().optional(),
  codeSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  codeAttestation: CodeActAttestationStatus.nullable().optional(),
  codeExecutionFailure: z.string().nullable().optional(),
} as const;

export const StepType = z.enum([
  "tool",
  "logic",
  "manual",
  "condition",
  "delay",
  "subflow",
  "invoke",
  "foreach",
  "emit",
  "decision",
]);
export const StepStatus = z.enum([
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
]);

export const RunRow = z.object({
  ...CodeActReceiptFields,
  id: z.string(),
  status: RunStatus,
  /** Agent Studio pinning/history metadata (optional for legacy responses). */
  sessionId: z.string().nullable().optional(),
  agentVersionId: z.string().nullable().optional(),
  draftRevisionId: z.string().nullable().optional(),
  invocationSource: z
    .enum(["studio", "event", "api", "replay", "demo"])
    .optional(),
  definitionHash: z.string().nullable().optional(),
  outputValid: z.boolean().nullable().optional(),
  sideEffectMode: z.enum(["suppressed", "safe", "live"]).optional(),
  agentName: z.string(),
  agentTitle: z.string().nullable(),
  subject: z.string().nullable(),
  triggerEvent: z.string().nullable(),
  /**
   * UC-V11-21 / AR-GAP-06 — name of the downstream event the run emitted on
   * success. Hydrated by a `LEFT JOIN events ON events.id = runs.emitted_event_id`
   * in `apps/api/src/queries/runs.ts`. Null while the run is still in flight
   * or when the agent has no `triggered_event` in its manifest.
   */
  emittedEvent: z.string().nullable(),
  queuedAt: z.coerce.date().optional(),
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable(),
  correlationId: z.string(),
  errorMessage: z.string().nullable(),
  /**
   * P2-FE-18 — alias of `errorMessage` surfaced on the wire under the shorter
   * key the portal `runs/[id]/page.tsx` already reads. Optional so existing
   * fixtures (which only set `errorMessage`) keep parsing. The query layer
   * mirrors `errorMessage → error` so both are always populated together.
   */
  error: z.string().nullable().optional(),
  logPath: z.string().nullable(),
  /** For Active Runs: in-flight step's name + ord + total step count. */
  currentStepName: z.string().nullable(),
  currentStepOrd: z.number().nullable(),
  stepCount: z.number().nullable(),
  /**
   * P2-FE-18 — surfaces `runs.is_test` so cold-loaded run-detail views can
   * paint the TEST badge without waiting for the SSE `run.started` event.
   * Optional so legacy fixtures parse; the API query layer always populates
   * it (defaulting to false when the column is null/absent).
   */
  testRun: z.boolean().optional(),
  /**
   * Parent run id when this run was spawned as a subflow/child (or is a
   * replay descendant). Lets the list paint a child/REPLAY badge and the
   * trace tree fetch children via `?parentRunId=`. Null for top-level runs.
   */
  parentRunId: z.string().nullable().optional(),
  /**
   * Resolved real payloads for the run-detail IO/Events tabs — the trigger
   * event payload (the run's INPUT) and the emitted event payload (its
   * OUTPUT). Detail-only: the list endpoint never reads payload files, so
   * these stay undefined there. Bounded server-side (oversized payloads
   * collapse to a `{ _truncated, _preview }` marker).
   */
  inputPayload: z.unknown().optional(),
  outputPayload: z.unknown().optional(),
});
export type RunRow = z.infer<typeof RunRow>;

export const StepRow = z.object({
  ...CodeActReceiptFields,
  id: z.string(),
  ord: z.number(),
  name: z.string(),
  type: StepType,
  status: StepStatus,
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().nullable(),
  inputRef: z.string().nullable().optional(),
  outputRef: z.string().nullable().optional(),
  error: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  /**
   * Execution attempt count. >1 means Inngest retried this step's body in
   * place (the run viewer renders an "attempt N" badge). Defaults to 1.
   */
  attempts: z.number().optional(),
  // Resolved real input/output payloads for this step (run-detail only — the
  // list endpoint leaves these undefined). Powers the Timeline/Trace/IO tabs'
  // Inngest-style per-step 📥 input / 📤 output.
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});
export type StepRow = z.infer<typeof StepRow>;

/**
 * Provider-attempt usage for one run.
 *
 * This is intentionally a safe aggregate rather than the raw `llm_calls`
 * ledger. Test Lab users can inspect the run they are allowed to execute
 * without receiving tenant-admin billing metadata or provider request IDs.
 * `costUsdNanos` stays null when no attempt has an authoritative price so the
 * UI can distinguish "unpriced" from a real zero-dollar call.
 */
export const RunUsageSummary = z.object({
  logicalCalls: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsdNanos: z.number().int().nonnegative().nullable(),
  pricedCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  providers: z.array(z.string()),
  models: z.array(z.string()),
  latestProvider: z.string().nullable(),
  latestModel: z.string().nullable(),
});
export type RunUsageSummary = z.infer<typeof RunUsageSummary>;

export const ListRunsQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  status: z.string().optional(),
  agent: z.string().optional(),
  q: z.string().optional(),
  /** Filter to a parent run's children (trace-tree lazy expand). */
  parentRunId: z.string().optional(),
  /**
   * Pagination (opt-in). When `page` is present the list endpoint returns a
   * {@link PaginatedRuns} envelope instead of a bare array — 1-indexed page,
   * `pageSize` rows each (default 50, capped 200). Existing callers that omit
   * `page` keep getting the legacy bare array, so nothing breaks.
   */
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  /**
   * Recycle-bin lens. `"1"`/`"true"` returns ONLY soft-deleted (tombstoned)
   * runs; anything else (or absent) returns only live runs. String-typed
   * because query params arrive as strings and `z.coerce.boolean` treats the
   * literal `"false"` as truthy.
   */
  deleted: z.enum(["1", "true", "0", "false"]).optional(),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuery>;

/**
 * Server-side paginated runs envelope. Returned by `GET /v1/runs?page=…`.
 * `total` is the full filtered row count (for page-count math); `rows` is the
 * current page.
 */
export const PaginatedRuns = z.object({
  rows: z.array(RunRow),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type PaginatedRuns = z.infer<typeof PaginatedRuns>;

/** Response of `DELETE /v1/runs/:id` — soft-delete (recoverable via restore). */
export const DeleteRunResponse = z.object({
  id: z.string(),
  deleted: z.boolean(),
  note: z.string(),
});
export type DeleteRunResponse = z.infer<typeof DeleteRunResponse>;

/** Response of `POST /v1/runs/:id/restore` — un-tombstone a soft-deleted run. */
export const RestoreRunResponse = z.object({
  id: z.string(),
  restored: z.boolean(),
  note: z.string(),
});
export type RestoreRunResponse = z.infer<typeof RestoreRunResponse>;

/**
 * Response of the bulk `DELETE /v1/runs?scope=…` maintenance actions.
 *   - `oldest` — soft-delete the N oldest finished runs (清理最旧 N 条)
 *   - `all`    — soft-delete every finished run for the tenant (一键清空)
 *   - `purge`  — HARD-delete every already-tombstoned run + its log files
 *                (清空回收站; irreversible)
 */
export const BulkDeleteRunsResponse = z.object({
  scope: z.enum(["oldest", "all", "purge"]),
  deleted: z.number(),
  note: z.string(),
});
export type BulkDeleteRunsResponse = z.infer<typeof BulkDeleteRunsResponse>;

/**
 * A human task this run is currently blocked on (HITL `waitForEvent`). Lets
 * the run viewer show an Inngest-style "waiting for event/approval" state and
 * deep-link to the task inbox instead of going dark.
 */
export const RunWaitingTask = z.object({
  id: z.string(),
  title: z.string(),
  awaitingRole: z.string().nullable(),
  createdAt: z.coerce.date().nullable(),
});
export type RunWaitingTask = z.infer<typeof RunWaitingTask>;

export const GetRunResponse = z.object({
  run: RunRow,
  steps: z.array(StepRow),
  /** Present + non-null while the run is blocked on a human task. */
  waitingTask: RunWaitingTask.nullable().optional(),
  usage: RunUsageSummary,
});

export const ReplayRunResponse = z.object({
  replayed_run: z.string(),
  new_event_id: z.string(),
});

/**
 * Response of `POST /v1/runs/:id/cancel` — operator kill-switch.
 *
 * `cancelled` is true when this call flipped the row from an active state
 * (running / waiting / queued) to `cancelled`. It is false on the no-op
 * idempotent paths (run is already terminal — `ok`, `failed`, or already
 * `cancelled`). `note` is a human-readable summary of what the route did
 * (e.g. "Inngest cancel signal sent; manifest fn will exit at next
 * checkpoint" vs. "Run already terminal; no-op").
 */
export const CancelRunResponse = z.object({
  runId: z.string(),
  status: RunStatus,
  cancelled: z.boolean(),
  note: z.string(),
});
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

/**
 * AI summary of a run (W2). Lazily generated on first open and cached in
 * `run_summaries`. On success `businessDetails` describes the business outcome;
 * on failure `problem` + `likelyCauses` (guessed from the error) + `suggestions`
 * describe what went wrong and how to fix it. `scored=false` + empty findings
 * means digest-only (no LLM gateway) — the `digest` still carries the raw
 * activity narrative.
 */
export const RunSummary = z.object({
  scored: z.boolean(),
  status: z.string(),
  headline: z.string(),
  narrative: z.string(),
  businessDetails: z.array(z.string()),
  problem: z.string().nullable(),
  likelyCauses: z.array(z.string()),
  suggestions: z.array(z.string()),
  model: z.string(),
  digest: z.string(),
  createdAt: z.coerce.date().nullable().optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** `GET /v1/runs/:id/summary` (cached, may be null) + `POST` (generate). */
export const RunSummaryResponse = z.object({ summary: RunSummary.nullable() });
export type RunSummaryResponse = z.infer<typeof RunSummaryResponse>;
