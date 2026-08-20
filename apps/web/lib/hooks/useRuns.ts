/**
 * useRuns — TanStack Query wrappers around `/v1/runs` and `/v1/runs/:id`.
 *
 * Cache invalidation is driven by `useStream()` (see useStream.ts). Components
 * that read this hook automatically re-render on `run.started`,
 * `run.step.{started,completed}`, `run.completed`, and `run.failed` SSE
 * events — no window listeners required.
 */
"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import type { RunUsageSummary } from "@agentic/contracts";
import { RUN_KEYS, COUNT_KEYS } from "./useStream";
import { tenantHeader } from "./tenant-header";

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...tenantHeader(),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
}

export interface RunListFilter {
  status?: string;
  agent?: string;
  q?: string;
  triggerEvent?: string;
  invocationSource?: RunInvocationSource;
  businessResult?: RunBusinessResult;
  testRun?: boolean;
  from?: number;
  to?: number;
  limit?: number;
  /**
   * P3-FE-04 — only runs whose `parentRunId` matches this. Used by the
   * trace-tree view to load the children of the current run.
   */
  parentRunId?: string;
}

export type CodeActAttestationStatus =
  | "production_verified"
  | "sandbox_verified"
  | "sandbox_not_required"
  | "not_authorized"
  | "missing"
  | "mismatch"
  | "not_checked";

/** Runtime-authored CodeAct receipt columns. Absence/null means the runtime
 * emitted no receipt; it must not be inferred from deployed agent metadata. */
export interface CodeActReceiptFields {
  codeRan?: boolean | null;
  codeExecuted?: boolean | null;
  codeIsolation?:
    | "worker_thread"
    | "isolated_subprocess"
    | "isolated_container"
    | null;
  codeSha256?: string | null;
  codeAttestation?: CodeActAttestationStatus | null;
  codeExecutionFailure?: string | null;
}

function buildQuery(filter: RunListFilter | undefined): string {
  if (!filter) return "";
  const sp = new URLSearchParams();
  if (filter.status) sp.set("status", filter.status);
  if (filter.agent) sp.set("agent", filter.agent);
  if (filter.q) sp.set("q", filter.q);
  if (filter.triggerEvent) sp.set("triggerEvent", filter.triggerEvent);
  if (filter.invocationSource)
    sp.set("invocationSource", filter.invocationSource);
  if (filter.businessResult) sp.set("businessResult", filter.businessResult);
  if (filter.testRun !== undefined)
    sp.set("testRun", filter.testRun ? "1" : "0");
  if (filter.from !== undefined) sp.set("from", String(filter.from));
  if (filter.to !== undefined) sp.set("to", String(filter.to));
  if (filter.limit) sp.set("limit", String(filter.limit));
  if (filter.parentRunId) sp.set("parentRunId", filter.parentRunId);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface RunListRow extends CodeActReceiptFields {
  id: string;
  status: string;
  invocationSource?: RunInvocationSource;
  businessResult?: RunBusinessResult;
  outputValid?: boolean | null;
  agentName: string;
  agentTitle: string | null;
  subject: string | null;
  triggerEvent: string | null;
  /** Name of the event emitted by this run. The list endpoint hydrates this
   *  so observability views can prove producer → consumer relationships. */
  emittedEvent?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  provider?: string | null;
  model: string | null;
  currentStepName: string | null;
  currentStepOrd: number | null;
  stepCount: number | null;
  /** P3-FE-04 — id of the parent run when this run is a sub-run. */
  parentRunId?: string | null;
  /** P2-FE-18 — TEST RUN badge driver. */
  testRun?: boolean;
  error?: string | null;
  /** Correlation id linking this run to others in the same workflow chain. */
  correlationId?: string | null;
  /** Run-detail only: real trigger-event payload (input) + emitted-event
   *  payload (output), resolved server-side. Undefined on the list endpoint. */
  inputPayload?: unknown;
  outputPayload?: unknown;
}

export function useRuns(filter?: RunListFilter): UseQueryResult<RunListRow[]> {
  const query = buildQuery(filter);
  return useQuery({
    queryKey: filter
      ? RUN_KEYS.list(filter as Record<string, unknown>)
      : RUN_KEYS.list(),
    queryFn: () => callV1<RunListRow[]>(`/v1/runs${query}`),
    staleTime: 2_000,
    // SSE invalidation is primary; polling is a bounded resilience fallback.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

// ─── Server-side pagination + delete (W1) ─────────────────────────────────

/** Server-side paginated runs envelope (`GET /v1/runs?page=…`). */
export interface PaginatedRuns {
  rows: RunListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RunPageFilter {
  /** Single status, or "all"/undefined for no status filter. */
  status?: string;
  q?: string;
  agent?: string;
  triggerEvent?: string;
  invocationSource?: RunInvocationSource;
  businessResult?: RunBusinessResult;
  testRun?: boolean;
  from?: number;
  to?: number;
  /** 1-indexed. */
  page: number;
  pageSize: number;
  /** Recycle-bin lens — only tombstoned runs. */
  deleted?: boolean;
}

function buildPageQuery(f: RunPageFilter): string {
  const sp = new URLSearchParams();
  sp.set("page", String(f.page));
  sp.set("pageSize", String(f.pageSize));
  if (f.status && f.status !== "all") sp.set("status", f.status);
  if (f.q) sp.set("q", f.q);
  if (f.agent) sp.set("agent", f.agent);
  if (f.triggerEvent) sp.set("triggerEvent", f.triggerEvent);
  if (f.invocationSource) sp.set("invocationSource", f.invocationSource);
  if (f.businessResult) sp.set("businessResult", f.businessResult);
  if (f.testRun !== undefined) sp.set("testRun", f.testRun ? "1" : "0");
  if (f.from !== undefined) sp.set("from", String(f.from));
  if (f.to !== undefined) sp.set("to", String(f.to));
  if (f.deleted) sp.set("deleted", "1");
  return `?${sp.toString()}`;
}

/**
 * Paginated runs list. `placeholderData: keepPreviousData` keeps the previous
 * page visible during a page/filter change so the list doesn't flash empty.
 */
export function useRunsPaged(
  filter: RunPageFilter,
): UseQueryResult<PaginatedRuns> {
  const query = buildPageQuery(filter);
  return useQuery({
    queryKey: RUN_KEYS.list({ paged: true, ...filter } as Record<
      string,
      unknown
    >),
    queryFn: () => callV1<PaginatedRuns>(`/v1/runs${query}`),
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  });
}

/** Soft-delete a run (recoverable): `DELETE /v1/runs/:id`. */
export function useDeleteRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<{ id: string; deleted: boolean; note: string }>(
        `/v1/runs/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

/** Restore a soft-deleted run: `POST /v1/runs/:id/restore`. */
export function useRestoreRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<{ id: string; restored: boolean; note: string }>(
        `/v1/runs/${encodeURIComponent(id)}/restore`,
        { method: "POST" },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

export type BulkDeleteArg =
  | { scope: "oldest"; n: number }
  | { scope: "all" }
  | { scope: "purge" };

/** Bulk cleanup: `DELETE /v1/runs?scope=oldest&n=` / `?scope=all` / `?scope=purge`. */
export function useBulkDeleteRuns() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (arg: BulkDeleteArg) => {
      const sp = new URLSearchParams();
      sp.set("scope", arg.scope);
      if (arg.scope === "oldest") sp.set("n", String(arg.n));
      return callV1<{ scope: string; deleted: number; note: string }>(
        `/v1/runs?${sp.toString()}`,
        { method: "DELETE" },
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

export type RunInvocationSource =
  | "studio"
  | "event"
  | "api"
  | "replay"
  | "demo";

export type RunBusinessResult =
  | "pending"
  | "produced"
  | "completed"
  | "no_output"
  | "invalid"
  | "failed";

export type BulkRunAction = "delete" | "restore" | "purge" | "replay";

export type BulkRunSelection =
  | { mode: "ids"; ids: string[] }
  | {
      mode: "filter";
      filter: {
        status?: string;
        agent?: string;
        q?: string;
        triggerEvent?: string;
        invocationSource?: RunInvocationSource;
        businessResult?: RunBusinessResult;
        testRun?: boolean;
        from?: number;
        to?: number;
        deleted?: boolean;
      };
      excludeIds: string[];
    };

export interface BulkRunActionResult {
  action: BulkRunAction;
  matched: number;
  affected: number;
  skipped: number;
  replayedRunIds?: string[];
  failures?: Array<{ runId: string; error: string }>;
  note: string;
}

/** Arbitrary selected rows or all rows matching the current server filters. */
export function useBulkRunAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (arg: { action: BulkRunAction; selection: BulkRunSelection }) =>
      callV1<BulkRunActionResult>("/v1/runs/bulk-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(arg),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

// ─── AI run summary (W2) ──────────────────────────────────────────────────

export interface RunSummary {
  scored: boolean;
  status: string;
  headline: string;
  narrative: string;
  businessDetails: string[];
  problem: string | null;
  likelyCauses: string[];
  suggestions: string[];
  model: string;
  digest: string;
  createdAt?: string | null;
}

const SUMMARY_KEY = (id: string) => ["runs", "summary", id] as const;

/** Cached AI summary for a run (`GET /v1/runs/:id/summary`). null until generated. */
export function useRunSummary(
  id: string | null | undefined,
): UseQueryResult<{ summary: RunSummary | null }> {
  return useQuery({
    queryKey: id ? SUMMARY_KEY(id) : (["runs", "summary", "__none__"] as const),
    queryFn: () =>
      callV1<{ summary: RunSummary | null }>(
        `/v1/runs/${encodeURIComponent(id!)}/summary`,
      ),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

/** Generate (or regenerate) a run's AI summary: `POST /v1/runs/:id/summary`. */
export function useGenerateRunSummary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<{ summary: RunSummary }>(
        `/v1/runs/${encodeURIComponent(id)}/summary`,
        { method: "POST" },
      ),
    onSuccess: (data, id) => {
      client.setQueryData(SUMMARY_KEY(id), data);
    },
  });
}

export interface StepRow extends CodeActReceiptFields {
  id: string;
  ord: number;
  name: string;
  type: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputRef?: string | null;
  outputRef?: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Execution attempt count (>1 = retried in place). Defaults to 1. */
  attempts?: number;
  /** Run-detail only: resolved real input/output payloads for this step. */
  input?: unknown;
  output?: unknown;
}

/** A human task the run is currently blocked on (HITL waitForEvent). */
export interface RunWaitingTask {
  id: string;
  title: string;
  awaitingRole: string | null;
  createdAt: string | null;
}

export interface RunDetail {
  run: RunListRow;
  steps: StepRow[];
  /** Present + non-null while the run is blocked on a human task. */
  waitingTask?: RunWaitingTask | null;
  usage: RunUsageSummary;
}

export function useRun(
  id: string | null | undefined,
  options: { live?: boolean } = {},
): UseQueryResult<RunDetail> {
  return useQuery({
    queryKey: id
      ? RUN_KEYS.detail(id)
      : (["runs", "detail", "__none__"] as const),
    queryFn: () => callV1<RunDetail>(`/v1/runs/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: options.live
      ? (queryState) => {
          const detail = queryState.state.data as RunDetail | undefined;
          return detail &&
            ["ok", "failed", "cancelled"].includes(detail.run.status)
            ? false
            : 1_000;
        }
      : false,
  });
}

/** One run in the cross-run correlationId chain (GET /v1/runs/:id/chain). */
export interface RunChainRow {
  id: string;
  agentName: string;
  agentTitle: string | null;
  status: string;
  subject: string | null;
  triggerEvent: string | null;
  emittedEvent: string | null;
  startedAt: string | null;
  durationMs: number | null;
  parentRunId: string | null;
  correlationId: string;
}
export interface RunChain {
  correlationId: string;
  runs: RunChainRow[];
}

/** The whole cross-run cascade sharing this run's correlationId, in pipeline
 *  order — the zhaopin 6-agent chain the parentRunId-based trace tree can't show. */
export function useRunChain(
  id: string | null | undefined,
): UseQueryResult<RunChain> {
  return useQuery({
    queryKey: id
      ? (["runs", "chain", id] as const)
      : (["runs", "chain", "__none__"] as const),
    queryFn: () =>
      callV1<RunChain>(`/v1/runs/${encodeURIComponent(id!)}/chain`),
    enabled: Boolean(id),
    staleTime: 2_000,
  });
}

export interface RunArtifact {
  id: string;
  kind: string;
  stepId?: string | null;
  role?: string;
  logicalName?: string | null;
  contentType?: string | null;
  size: number;
  createdAt: string;
  downloadPath: string;
}

export function useRunArtifacts(
  id: string | null | undefined,
): UseQueryResult<RunArtifact[]> {
  return useQuery({
    queryKey: id
      ? [...RUN_KEYS.detail(id), "artifacts"]
      : (["runs", "artifacts", "__none__"] as const),
    queryFn: () =>
      callV1<RunArtifact[]>(`/v1/runs/${encodeURIComponent(id!)}/artifacts`),
    enabled: Boolean(id),
  });
}

export interface LegacyReplayRunResult {
  replayed_run: string;
  new_event_id: string;
}

export interface StudioReplayRunResult {
  runId: string;
  sessionId: string;
  status: "queued";
  definitionHash: string;
  traceUrl: string;
  outputUrl: string;
}

export type ReplayRunResult = LegacyReplayRunResult | StudioReplayRunResult;

/** Replay a run: Studio runs return the new run, legacy runs return the new event. */
export function useReplayRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<ReplayRunResult>(`/v1/runs/${encodeURIComponent(id)}/replay`, {
        method: "POST",
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

export interface CancelRunResult {
  runId: string;
  status: string;
  cancelled: boolean;
  note: string;
}

/**
 * Cancel an in-flight run: `POST /v1/runs/:id/cancel`.
 *
 * Idempotent on the server side — re-cancelling a terminal run returns 200
 * with `cancelled:false` and a no-op note. The hook treats both shapes as
 * success (the variable shape lets the caller surface the right toast).
 *
 * On settle we invalidate both the list and the detail query keys so the
 * runs index + the detail header repaint to the cancelled state without
 * an extra reload.
 */
export function useCancelRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callV1<CancelRunResult>(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      }),
    onSettled: (_data, _err, id) => {
      void client.invalidateQueries({ queryKey: RUN_KEYS.detail(id) });
      void client.invalidateQueries({ queryKey: RUN_KEYS.all });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}
