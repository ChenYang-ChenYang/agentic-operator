"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AgentDraftResponseSchema,
  AgentEditorResponseSchema,
  CreateAgentDraftBodySchema,
  CreateAgentRunBodySchema,
  CreateAgentRunResponseSchema,
  GenerateDraftInstructionsBodySchema,
  GenerateDraftInstructionsResponseSchema,
  GetRunSessionResponseSchema,
  GetRunTraceResponseSchema,
  ListAgentRunsResponseSchema,
  ListAgentVersionsResponseSchema,
  PatchAgentDraftBodySchema,
  PublishAgentDraftBodySchema,
  PublishAgentDraftResponseSchema,
  RunOutputResponseSchema,
  ValidateAgentDraftResponseSchema,
  type AgentDraftRecord,
  type AgentEditorResponse as ContractAgentEditorResponse,
  type AgentRunHistoryRow,
  type AgentValidationIssue,
  type AgentVersionSummary,
  type CreateAgentRunBody as ContractCreateAgentRunBody,
  type CreateAgentRunResponse as ContractCreateAgentRunResponse,
  type GenerateDraftInstructionsBody as ContractGenerateDraftInstructionsBody,
  type GenerateDraftInstructionsResponse as ContractGenerateDraftInstructionsResponse,
  type GetRunSessionResponse as ContractGetRunSessionResponse,
  type GetRunTraceResponse as ContractGetRunTraceResponse,
  type PublishAgentDraftResponse as ContractPublishAgentDraftResponse,
  type RunOutputResponse as ContractRunOutputResponse,
  type RunTraceEvent as ContractRunTraceEvent,
} from "@agentic/contracts";
import { tenantHeader } from "./tenant-header";
import { usageAttributionHeaders } from "./usage-attribution";
import type { StudioDefinition } from "@/app/portal/components/agent-studio/model";

interface ApiOk<T> {
  ok: true;
  data: T;
}

interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    details?: unknown;
  };
}

export class AgentStudioApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    hint?: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "AgentStudioApiError";
    this.status = args.status;
    this.code = args.code;
    this.hint = args.hint;
    this.details = args.details;
  }
}

type AgentStudioTranslate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

type AgentStudioClientErrorCode =
  | "draftRequiredSave"
  | "draftRequiredValidate"
  | "draftRequiredGenerate"
  | "draftRequiredPublish"
  | "serviceUnavailable"
  | "invalidResponse";

export class AgentStudioClientError extends Error {
  readonly code: AgentStudioClientErrorCode;

  constructor(code: AgentStudioClientErrorCode, fallback: string) {
    super(fallback);
    this.name = "AgentStudioClientError";
    this.code = code;
  }
}

/**
 * Turn an API failure into a useful operator-facing message.
 *
 * The backend deliberately separates the stable error code, plain-language
 * message, and recovery hint. Keeping all three in the toast makes publish
 * failures actionable without asking an operator to inspect DevTools.
 */
export function formatAgentStudioError(
  error: unknown,
  t?: AgentStudioTranslate,
): string {
  if (error instanceof AgentStudioClientError) {
    return t ? t(`agentStudioError.${error.code}`) : error.message;
  }
  if (error instanceof AgentStudioApiError) {
    const parts = [
      error.message,
      t
        ? t("agentStudioError.errorCode", { code: error.code })
        : `Error code: ${error.code}`,
    ];
    if (error.hint) {
      parts.push(
        t
          ? t("agentStudioError.whatToDo", { hint: error.hint })
          : `What to do: ${error.hint}`,
      );
    }
    return parts.join(" · ");
  }
  return error instanceof Error ? error.message : String(error);
}

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...usageAttributionHeaders("agent-studio"),
    ...(initHeaders as Record<string, string> | undefined),
  };
  if (
    rest.body !== undefined &&
    rest.body !== null &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...rest,
      headers,
    });
  } catch {
    throw new AgentStudioClientError(
      "serviceUnavailable",
      "Could not reach Agent Studio. Check the connection and retry.",
    );
  }
  let body: ApiOk<T> | ApiErr | null = null;
  try {
    body = (await response.json()) as ApiOk<T> | ApiErr;
  } catch {
    if (!response.ok) {
      throw new AgentStudioApiError({
        status: response.status,
        code: `http_${response.status}`,
        message: `${path}: HTTP ${response.status}`,
      });
    }
  }

  if (!response.ok || (body && !body.ok)) {
    const error = body && !body.ok ? body.error : null;
    throw new AgentStudioApiError({
      status: response.status,
      code: error?.code ?? `http_${response.status}`,
      message: error?.message ?? `${path}: HTTP ${response.status}`,
      hint: error?.hint,
      details: error?.details,
    });
  }

  if (!body || !body.ok) {
    throw new AgentStudioClientError(
      "invalidResponse",
      `${path}: expected a JSON API envelope`,
    );
  }
  return body.data;
}

export type AgentEditorResponse = ContractAgentEditorResponse;
export type AgentStudioDraft = AgentDraftRecord;
export type StudioValidationIssue = AgentValidationIssue;
export type GenerateInstructionsRequest = ContractGenerateDraftInstructionsBody;
export type GenerateInstructionsResponse =
  ContractGenerateDraftInstructionsResponse;
export type PublishDraftResponse = ContractPublishAgentDraftResponse;
export type CreateAgentRunRequest = ContractCreateAgentRunBody;
export type CreateAgentRunResponse = ContractCreateAgentRunResponse;

export type AgentStudioRunRow = AgentRunHistoryRow;

export interface AgentRunHistoryPage {
  items: AgentStudioRunRow[];
  nextCursor: string | null;
}

export type AgentVersionRow = AgentVersionSummary;

export interface AgentVersionPage {
  items: AgentVersionRow[];
  nextCursor: string | null;
}

export type RunTraceEvent = ContractRunTraceEvent;
export type RunTracePage = ContractGetRunTraceResponse;
export type RunOutputResponse = ContractRunOutputResponse;
export type RunSessionResponse = ContractGetRunSessionResponse;

export const AGENT_STUDIO_KEYS = {
  all: ["agent-studio"] as const,
  editor: (id: string, draftId?: string | null) =>
    ["agent-studio", "editor", id, draftId ?? "current"] as const,
  history: (id: string, query: string) =>
    ["agent-studio", "history", id, query] as const,
  versions: (id: string, query: string) =>
    ["agent-studio", "versions", id, query] as const,
  trace: (runId: string, after: number) =>
    ["agent-studio", "trace", runId, after] as const,
  traceAll: (runId: string) => ["agent-studio", "trace-all", runId] as const,
  output: (runId: string) => ["agent-studio", "output", runId] as const,
  session: (sessionId: string) =>
    ["agent-studio", "session", sessionId] as const,
};

function prepareDefinition(definition: StudioDefinition): unknown {
  const value = JSON.parse(JSON.stringify(definition)) as Record<
    string,
    unknown
  >;
  if (value.provider === "") delete value.provider;
  if (value.model === "") delete value.model;
  if (value.cron === "") value.cron = null;
  if (value.cron_timezone === "") value.cron_timezone = null;
  return value;
}

export function useAgentEditor(
  agentId: string | null | undefined,
  draftId?: string | null,
) {
  const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
  return useQuery({
    queryKey: agentId
      ? AGENT_STUDIO_KEYS.editor(agentId, draftId)
      : (["agent-studio", "editor", "__none__"] as const),
    queryFn: async () =>
      AgentEditorResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId!)}/editor${query}`,
        ),
      ),
    enabled: Boolean(agentId),
    staleTime: 2_000,
  });
}

export function useCreateAgentDraft(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      definition?: StudioDefinition;
      baseAgentVersionId?: string;
      baseWorkflowVersionId?: string;
    }) => {
      const payload = CreateAgentDraftBodySchema.parse({
        ...body,
        ...(body.definition
          ? { definition: prepareDefinition(body.definition) }
          : {}),
      });
      return AgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId)}/drafts`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: AGENT_STUDIO_KEYS.all });
    },
  });
}

/**
 * Create an exact Agent Studio handoff draft from a workflow version.
 *
 * The agent id is supplied per mutation because a canvas can open any node.
 * Passing the workflow's complete definition avoids accidentally reopening an
 * older Agent Studio draft whose base version no longer matches the canvas.
 */
export function useCreateWorkflowAgentDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      agentId: string;
      definition: StudioDefinition;
      baseWorkflowVersionId: string;
      workflowSlug: string;
    }) => {
      const payload = CreateAgentDraftBodySchema.parse({
        definition: prepareDefinition(input.definition),
        baseWorkflowVersionId: input.baseWorkflowVersionId,
        workflowSlug: input.workflowSlug,
      });
      return AgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(input.agentId)}/drafts`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    onSuccess: async (_result, input) => {
      await client.invalidateQueries({
        queryKey: ["agent-studio", "editor", input.agentId],
      });
    },
  });
}

export function useCreateNewAgentDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      definition: StudioDefinition;
      workflowSlug?: string;
    }) => {
      const payload = CreateAgentDraftBodySchema.parse({
        definition: prepareDefinition(body.definition),
        workflowSlug: body.workflowSlug,
      });
      return AgentDraftResponseSchema.parse(
        await callV1<unknown>("/v1/agents/drafts", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: AGENT_STUDIO_KEYS.all }),
        client.invalidateQueries({ queryKey: ["agents"] }),
        client.invalidateQueries({ queryKey: ["workflows"] }),
      ]);
    },
  });
}

export function useSaveAgentDraft(draftId: string | null | undefined) {
  return useMutation({
    mutationFn: async (vars: {
      definition: StudioDefinition;
      revision: number;
    }) => {
      if (!draftId) {
        throw new AgentStudioClientError(
          "draftRequiredSave",
          "Create a draft before saving changes.",
        );
      }
      const payload = PatchAgentDraftBodySchema.parse({
        definition: prepareDefinition(vars.definition),
      });
      return AgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agent-drafts/${encodeURIComponent(draftId)}`,
          {
            method: "PATCH",
            headers: { "If-Match": String(vars.revision) },
            body: JSON.stringify(payload),
          },
        ),
      );
    },
  });
}

export function useValidateAgentDraft(
  agentId: string,
  draftId: string | null | undefined,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!draftId) {
        throw new AgentStudioClientError(
          "draftRequiredValidate",
          "Create a draft before validating it.",
        );
      }
      return callV1<unknown>(
        `/v1/agent-drafts/${encodeURIComponent(draftId)}/validate`,
        { method: "POST" },
      ).then((value) => ValidateAgentDraftResponseSchema.parse(value));
    },
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ["agent-studio", "editor", agentId],
      });
    },
  });
}

export function useGenerateDraftInstructions(
  draftId: string | null | undefined,
) {
  return useMutation({
    mutationFn: async (body: GenerateInstructionsRequest) => {
      if (!draftId) {
        throw new AgentStudioClientError(
          "draftRequiredGenerate",
          "Create a draft before generating instructions.",
        );
      }
      const payload = GenerateDraftInstructionsBodySchema.parse(body);
      return GenerateDraftInstructionsResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agent-drafts/${encodeURIComponent(draftId)}/generate-instructions`,
          { method: "POST", body: JSON.stringify(payload) },
        ),
      );
    },
  });
}

export function usePublishAgentDraft(
  _agentId: string,
  draftId: string | null | undefined,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: { note?: string; confirmImpact?: boolean } = {},
    ) => {
      if (!draftId) {
        throw new AgentStudioClientError(
          "draftRequiredPublish",
          "Create a draft before publishing it.",
        );
      }
      const payload = PublishAgentDraftBodySchema.parse(body);
      return PublishAgentDraftResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agent-drafts/${encodeURIComponent(draftId)}/publish`,
          { method: "POST", body: JSON.stringify(payload) },
        ),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: AGENT_STUDIO_KEYS.all }),
        client.invalidateQueries({ queryKey: ["agents"] }),
        client.invalidateQueries({ queryKey: ["workflows"] }),
        client.invalidateQueries({ queryKey: ["deployments"] }),
      ]);
    },
  });
}

export function useCreateAgentRun(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateAgentRunRequest) => {
      const payload = CreateAgentRunBodySchema.parse(body);
      return CreateAgentRunResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId)}/runs`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        ),
      );
    },
    onSettled: async (response) => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["agent-studio", "history", agentId],
        }),
        ...(response
          ? [
              client.invalidateQueries({
                queryKey: AGENT_STUDIO_KEYS.session(response.sessionId),
              }),
            ]
          : []),
        client.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
  });
}

export function useRunSession(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: sessionId
      ? AGENT_STUDIO_KEYS.session(sessionId)
      : (["agent-studio", "session", "__none__"] as const),
    queryFn: async () =>
      GetRunSessionResponseSchema.parse(
        await callV1<unknown>(
          `/v1/run-sessions/${encodeURIComponent(sessionId!)}`,
        ),
      ),
    enabled: Boolean(sessionId),
    staleTime: 500,
    refetchInterval: (queryState) => {
      const session = queryState.state.data as RunSessionResponse | undefined;
      return session?.runs.some(
        (run) => !["ok", "failed", "cancelled"].includes(run.status),
      )
        ? 1_000
        : false;
    },
  });
}

export interface AgentRunHistoryFilter {
  cursor?: string;
  versionId?: string;
  sessionId?: string;
  source?: string;
  status?: string;
  limit?: number;
}

function makeQuery(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

export function useAgentRunHistory(
  agentId: string | null | undefined,
  filter: AgentRunHistoryFilter = {},
) {
  const query = makeQuery({ ...filter, limit: filter.limit ?? 30 });
  return useQuery({
    queryKey: agentId
      ? AGENT_STUDIO_KEYS.history(agentId, query)
      : (["agent-studio", "history", "__none__"] as const),
    queryFn: async () => {
      const data = ListAgentRunsResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId!)}/runs${query ? `?${query}` : ""}`,
        ),
      );
      return { items: data.runs, nextCursor: data.nextCursor };
    },
    enabled: Boolean(agentId),
    staleTime: 2_000,
    refetchInterval: (queryState) => {
      const page = queryState.state.data as AgentRunHistoryPage | undefined;
      return page?.items.some(
        (run) => !["ok", "failed", "cancelled"].includes(run.status),
      )
        ? 1_500
        : false;
    },
  });
}

export function useAgentVersions(
  agentId: string | null | undefined,
  cursor?: string,
) {
  const query = makeQuery({ cursor, limit: 30 });
  return useQuery({
    queryKey: agentId
      ? AGENT_STUDIO_KEYS.versions(agentId, query)
      : (["agent-studio", "versions", "__none__"] as const),
    queryFn: async () => {
      const data = ListAgentVersionsResponseSchema.parse(
        await callV1<unknown>(
          `/v1/agents/${encodeURIComponent(agentId!)}/versions${query ? `?${query}` : ""}`,
        ),
      );
      return { items: data.versions, nextCursor: data.nextCursor };
    },
    enabled: Boolean(agentId),
    staleTime: 5_000,
  });
}

export function useRunTrace(
  runId: string | null | undefined,
  after = 0,
  live = false,
) {
  const query = makeQuery({ after, limit: 1_000 });
  return useQuery({
    queryKey: runId
      ? AGENT_STUDIO_KEYS.trace(runId, after)
      : (["agent-studio", "trace", "__none__"] as const),
    queryFn: async () =>
      GetRunTraceResponseSchema.parse(
        await callV1<unknown>(
          `/v1/runs/${encodeURIComponent(runId!)}/trace${query ? `?${query}` : ""}`,
        ),
      ),
    enabled: Boolean(runId),
    staleTime: live ? 0 : 2_000,
    refetchInterval: live ? 1_500 : false,
  });
}

/**
 * Resolve the entire durable trace ledger for one run. The API deliberately
 * caps each response at 1,000 entries; this hook follows `nextAfter` so the
 * operator trace tree never silently stops at the first page.
 */
export function useRunTraceAll(runId: string | null | undefined, live = false) {
  return useQuery({
    queryKey: runId
      ? AGENT_STUDIO_KEYS.traceAll(runId)
      : (["agent-studio", "trace-all", "__none__"] as const),
    queryFn: async (): Promise<RunTracePage> => {
      const events: RunTraceEvent[] = [];
      let after = 0;
      let nextAfter: number | null = null;
      do {
        const query = makeQuery({ after, limit: 1_000 });
        const page = GetRunTraceResponseSchema.parse(
          await callV1<unknown>(
            `/v1/runs/${encodeURIComponent(runId!)}/trace${query ? `?${query}` : ""}`,
          ),
        );
        events.push(...page.events);
        nextAfter = page.nextAfter;
        if (nextAfter !== null) {
          if (nextAfter <= after) {
            throw new Error("Trace pagination cursor did not advance");
          }
          after = nextAfter;
        }
      } while (nextAfter !== null);
      return { events, nextAfter: null };
    },
    enabled: Boolean(runId),
    staleTime: live ? 0 : 2_000,
    refetchInterval: live ? 1_500 : false,
  });
}

export function useRunOutput(runId: string | null | undefined, live = false) {
  return useQuery({
    queryKey: runId
      ? AGENT_STUDIO_KEYS.output(runId)
      : (["agent-studio", "output", "__none__"] as const),
    queryFn: async () =>
      RunOutputResponseSchema.parse(
        await callV1<unknown>(`/v1/runs/${encodeURIComponent(runId!)}/output`),
      ),
    enabled: Boolean(runId),
    retry: (count, error) => {
      if (error instanceof AgentStudioApiError && error.status === 404)
        return count < 10;
      return count < 2;
    },
    retryDelay: 1_000,
    refetchInterval: live ? 1_500 : false,
  });
}
