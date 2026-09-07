/**
 * useAgents — TanStack Query wrappers around `/v1/agents` and
 * `/v1/agents/:kebab`, plus `/v1/counts` and `/v1/workflows/dag`.
 *
 * The agent set rarely mutates outside of a deploy, so we let cache age more
 * gracefully than runs/events. The dashboard counts ride alongside since
 * they're refreshed by the same SSE events (run.*, event.emitted, task.*).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AgentSpec } from "@agentic/contracts";
import { AGENT_KEYS, COUNT_KEYS } from "./useStream";
import { fetchApiData } from "@/lib/api-response";
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

export interface AgentListRow {
  id: string;
  kebabId: string;
  name: string;
  title: string | null;
  description: string | null;
  actor: "Agent" | "Human";
  kind: "code" | "manifest";
  enabled: boolean;
  runCount: number;
  errorCount: number;
  lastRunAt: string | null;
}

export interface AgentDetail {
  id: string;
  kebabId: string;
  name: string;
  title: string | null;
  description: string | null;
  actor: "Agent" | "Human";
  kind: "code" | "manifest";
  enabled: boolean;
  triggers: string[];
  triggeredEvents: string[];
  actions: Array<{
    order: string;
    name: string;
    type:
      | "tool"
      | "logic"
      | "manual"
      | "condition"
      | "delay"
      | "subflow"
      | "invoke"
      | "foreach"
      | "emit";
    description?: string;
    condition?: string;
    task_type?: string;
    [key: string]: unknown;
  }>;
  workflowSlug: string;
  workflowVersion: string | null;
  input_data: Record<string, unknown> | null;
  ontology_instructions: string | null;
  tool_use: Array<{
    name: string;
    description?: string;
    input_schema?: unknown;
    config?: Record<string, unknown>;
    [key: string]: unknown;
  }> | null;
  typescript_code: string | null;
  sourceUnavailable: boolean;
  deployedSource: {
    deploymentId: string;
    deploymentTarget: "workflow" | "agent" | "code_agent";
    deployedAt: string;
    agentVersionId: string;
    workflowVersionId: string;
    storage: "agent_versions.manifest_json";
  } | null;
  recentRuns: Array<{
    id: string;
    status: string;
    subject: string | null;
    startedAt: string | null;
    durationMs: number | null;
  }>;
}

/** Imperative detail read used by the workflow editor's safe round-trip. */
export function fetchAgentDetail(kebab: string): Promise<AgentDetail> {
  return callV1<AgentDetail>(`/v1/agents/${encodeURIComponent(kebab)}`);
}

export interface TenantCounts {
  agents: number;
  runningRuns: number;
  okRuns24h: number;
  failedRuns24h: number;
  events24h: number;
  openTasks: number;
  totalRuns: number;
}

export interface DagAgent {
  id: string;
  kebabId: string;
  name: string;
  title: string;
  /** Localized titles from the manifest (title_i18n), when declared. */
  titleI18n?: Record<string, string>;
  actor: "Agent" | "Human";
  triggers: string[];
  emits: string[];
  stage: number;
  recentRunCount: number;
  isLive: boolean;
  definition?: AgentSpec;
  position?: { x: number; y: number };
}

export interface DagPayload {
  agents: DagAgent[];
  edges: Array<{
    fromAgent: string;
    toAgent: string;
    event: string;
    active: boolean;
  }>;
  workflowVersion: string;
  workflowVersionId: string | null;
  workflowSlug: string | null;
  workflowName: string | null;
  workflowIsLive: boolean;
}

export function useAgents(opts?: {
  kind?: "code" | "manifest" | "all";
}): UseQueryResult<AgentListRow[]> {
  const kind = opts?.kind ?? "all";
  return useQuery({
    queryKey: [...AGENT_KEYS.list, kind] as const,
    queryFn: () => callV1<AgentListRow[]>(`/v1/agents?kind=${kind}`),
    staleTime: 5_000,
  });
}

export function useAgent(
  kebab: string | null | undefined,
): UseQueryResult<AgentDetail> {
  return useQuery({
    queryKey: kebab
      ? AGENT_KEYS.detail(kebab)
      : (["agents", "detail", "__none__"] as const),
    queryFn: () => fetchAgentDetail(kebab!),
    enabled: Boolean(kebab),
  });
}

export function useCounts(): UseQueryResult<TenantCounts> {
  return useQuery({
    queryKey: COUNT_KEYS.tenant,
    queryFn: () => callV1<TenantCounts>("/v1/counts"),
    staleTime: 2_000,
  });
}

export function useDag(
  workflowSlug?: string | null,
): UseQueryResult<DagPayload> {
  const query = workflowSlug
    ? `?workflow=${encodeURIComponent(workflowSlug)}`
    : "";
  return useQuery({
    queryKey: ["workflows", "dag", workflowSlug ?? "__live__"] as const,
    queryFn: () => callV1<DagPayload>(`/v1/workflows/dag${query}`),
    staleTime: 5_000,
  });
}

export interface ThroughputAgent {
  kebabId: string;
  name: string;
  title: string;
  subjects: number;
  runs: number;
}

export interface ThroughputResult {
  window: string;
  windowMs: number;
  agents: ThroughputAgent[];
}

/**
 * Per-agent throughput (`GET /v1/throughput`). For the live workflow, the
 * distinct subjects + run count each agent processed in the window. `window`
 * is "1h" | "24h" | "7d"; the backend echoes the resolved window back. Rides
 * the same SSE-driven invalidation as the other dashboard reads.
 */
export function useThroughput(
  window: "1h" | "24h" | "7d" = "24h",
): UseQueryResult<ThroughputResult> {
  return useQuery({
    queryKey: ["workflows", "throughput", window] as const,
    queryFn: () => callV1<ThroughputResult>(`/v1/throughput?window=${window}`),
    staleTime: 10_000,
  });
}

/**
 * Enable / disable an agent: `PATCH /v1/agents/:kebab { enabled }`.
 *
 * 下线 (disable) flips the row + re-registers the tenant so a manifest agent's
 * Inngest function is dropped from the live serve handler without a restart;
 * 上线 (enable) reverses it. Invalidates the agent list + detail so the toggle
 * reflects the new state immediately.
 */
export function useSetAgentEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { kebabId: string; enabled: boolean }) =>
      callV1<{
        kebabId: string;
        name: string;
        kind: "code" | "manifest";
        enabled: boolean;
        reregistered: boolean;
        fnCount?: number;
      }>(`/v1/agents/${encodeURIComponent(vars.kebabId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: vars.enabled }),
      }),
    onSettled: (_data, _err, vars) => {
      void client.invalidateQueries({ queryKey: AGENT_KEYS.list });
      void client.invalidateQueries({
        queryKey: AGENT_KEYS.detail(vars.kebabId),
      });
    },
  });
}

/** Rename an agent's display title: `PATCH /v1/agents/:kebab { title }`. */
export function useRenameAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { kebabId: string; title: string }) =>
      callV1<{ kebabId: string; title: string }>(
        `/v1/agents/${encodeURIComponent(vars.kebabId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: vars.title }),
        },
      ),
    onSettled: (_data, _err, vars) => {
      void client.invalidateQueries({ queryKey: AGENT_KEYS.list });
      void client.invalidateQueries({
        queryKey: AGENT_KEYS.detail(vars.kebabId),
      });
    },
  });
}

/** Delete an agent: `DELETE /v1/agents/:kebab` (soft-disables if it has run history unless force). */
export function useDeleteAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { kebabId: string; force?: boolean }) =>
      callV1<{
        kebabId: string;
        deleted: boolean;
        disabled: boolean;
        runCount: number;
        note?: string;
      }>(
        `/v1/agents/${encodeURIComponent(vars.kebabId)}${vars.force ? "?force=1" : ""}`,
        { method: "DELETE" },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: AGENT_KEYS.list });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}

/** Invoke an agent: `POST /v1/agents/:name/invoke`. */
export function useInvokeAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      input?: unknown;
      async?: boolean;
      testRun?: boolean;
    }) => {
      const sp = new URLSearchParams();
      if (vars.async) sp.set("async", "1");
      if (vars.testRun) sp.set("testRun", "1");
      const qs = sp.toString();
      const path = `/v1/agents/${encodeURIComponent(vars.name)}/invoke${qs ? `?${qs}` : ""}`;
      // The route returns one of two shapes:
      //   * code-agent (sync):  { runId, status: 'ok'|'failed', output, ... }
      //   * manifest fallback:  { kind: 'manifest', status: 'queued', eventId, eventName, correlationId, ... }
      // Both are typed here so callers can branch without `as` casts.
      return callV1<{
        runId?: string;
        run_id?: string;
        result?: unknown;
        output?: unknown;
        status?: string;
        kind?: "code" | "manifest";
        eventId?: string;
        eventName?: string;
        subject?: string;
        correlationId?: string;
        provider?: string;
        model?: string;
        tokensIn?: number | null;
        tokensOut?: number | null;
        durationMs?: number;
      }>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: vars.input ?? {} }),
      });
    },
    onSettled: () => {
      // A successful invoke creates a run. Touch the run list + counts so
      // dashboards reflect the new state. SSE `run.started` will then push.
      void client.invalidateQueries({ queryKey: ["runs"] as const });
      void client.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
    },
  });
}
