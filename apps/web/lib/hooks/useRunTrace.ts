"use client";

/**
 * useRunTrace — the per-run execution trace behind the monitor timeline (§G4).
 *
 * Reads GET /v1/runs/:id/trace, which returns every recorded step, LLM turn and
 * tool call for one run in `seq` order. The panel folds that flat list into a
 * tree with buildRunTraceTree; this hook only owns fetching and freshness.
 *
 * Polling is deliberately state-aware rather than a fixed interval. An active
 * run is worth a tight poll because the timeline is the thing people watch; a
 * terminal run never changes again, so polling it is pure waste against an api
 * that allows 600 reads/min per user and is shared with the canvas, the run
 * list and the counts badge. Terminal runs therefore stop entirely and are
 * served from cache.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import type { RunTraceEvent } from "@/app/portal/components/workflow-monitor/trace-tree";
import { tenantHeader } from "./tenant-header";

export const RUN_TRACE_KEYS = {
  all: ["run-trace"] as const,
  detail: (runId: string) => ["run-trace", "detail", runId] as const,
};

interface RunTraceResponse {
  events: RunTraceEvent[];
  nextAfter?: number | null;
  truncated?: boolean;
}

/**
 * Upper bound on rows pulled in one request. A long agent loop can run to
 * several hundred trace rows; the timeline virtualises nothing yet, and beyond
 * this the panel is unreadable long before it is slow.
 */
const TRACE_LIMIT = 500;

async function fetchRunTrace(runId: string): Promise<RunTraceResponse> {
  return fetchApiData<RunTraceResponse>(
    `/v1/runs/${encodeURIComponent(runId)}/trace?limit=${TRACE_LIMIT}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...tenantHeader() },
    },
  );
}

/** Run states the api can still append trace rows for. */
function isLive(status: string | null | undefined): boolean {
  if (!status) return false;
  return !["ok", "failed", "cancelled"].includes(status);
}

export function useRunTrace(
  runId: string | null,
  runStatus?: string | null,
): {
  events: RunTraceEvent[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} {
  const live = isLive(runStatus);
  const query = useQuery({
    queryKey: RUN_TRACE_KEYS.detail(runId ?? ""),
    queryFn: () => fetchRunTrace(runId as string),
    enabled: Boolean(runId),
    // A terminal run's trace is immutable, so it never needs refetching; an
    // active one is stale the moment it lands.
    staleTime: live ? 0 : Infinity,
    refetchInterval: live ? 2_000 : false,
    refetchIntervalInBackground: false,
    // The stream already nudges the caches; a refetch on every window focus on
    // top of that is noise the read budget cannot spare.
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    events: query.data?.events ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
