"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GenerateWorkflowResponseSchema,
  ManifestImportCommit,
  WorkflowAgentPromptResponseSchema,
  WorkflowDetailSchema,
  WorkflowDocumentFoldersResponseSchema,
  WorkflowListResponseSchema,
  WorkflowRunProfileSchema,
  WorkflowTemplateCatalogResponseSchema,
  WorkflowTestRunResponseSchema,
  WorkflowValidationResponseSchema,
  type CreateWorkflowBody,
  type GenerateWorkflowBody,
  type SaveWorkflowBody,
  type ValidateWorkflowBody,
  type WorkflowAgentPromptBody,
  type WorkflowDetail,
  type WorkflowRunProfileTarget,
  type WorkflowTestRunBody,
  WorkflowGenerationProgressSchema,
  type WorkflowGenerationProgress,
  type GenerateWorkflowResponse,
} from "@agentic/contracts";
import { z, type ZodType } from "zod";
import { tenantHeader } from "./tenant-header";
import { usageAttributionHeaders } from "./usage-attribution";

interface ApiOk {
  ok: true;
  data: unknown;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: unknown };
}

/**
 * A generation failure with the server's coded reason attached, so the modal
 * can show why it failed instead of "HTTP 500".
 */
export class WorkflowGenerationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowGenerationError";
  }
}

export class WorkflowAuthoringApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowAuthoringApiError";
  }
}

type WorkflowAuthoringClientErrorCode =
  | "networkUnavailable"
  | "requestFailed"
  | "invalidResponse"
  | "workflowRequired"
  | "agentRequired";

export class WorkflowAuthoringClientError extends Error {
  constructor(
    public readonly clientCode: WorkflowAuthoringClientErrorCode,
    fallback: string,
    public readonly status?: number,
  ) {
    super(fallback);
    this.name = "WorkflowAuthoringClientError";
  }
}

/**
 * Publish answers 409 with a bare confirmation envelope rather than the usual
 * `{ok:false,error}` shape, because the operator has to see WHICH live agents
 * a publish would drop before deciding. Carry the diff instead of collapsing
 * it into an opaque "HTTP 409".
 */
export class WorkflowPublishOverwriteRequiredError extends Error {
  constructor(
    public readonly reason: "removes_agents" | "modifies_threshold",
    public readonly removed: string[],
    public readonly modified: string[],
  ) {
    super(`workflow_publish_requires_confirmation: ${reason}`);
    this.name = "WorkflowPublishOverwriteRequiredError";
  }
}

/** Returns the typed conflict when `body` is the 409 confirmation envelope. */
export function workflowOverwriteConflict(
  status: number,
  body: unknown,
): WorkflowPublishOverwriteRequiredError | null {
  if (status !== 409 || !body || typeof body !== "object") return null;
  const envelope = body as {
    requires_confirmation?: unknown;
    reason?: unknown;
    diff?: { removed?: unknown; modified?: unknown };
  };
  if (envelope.requires_confirmation !== true) return null;
  if (
    envelope.reason !== "removes_agents" &&
    envelope.reason !== "modifies_threshold"
  ) {
    return null;
  }
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return new WorkflowPublishOverwriteRequiredError(
    envelope.reason,
    names(envelope.diff?.removed),
    names(envelope.diff?.modified),
  );
}

type WorkflowAuthoringTranslate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function formatWorkflowAuthoringError(
  error: unknown,
  t?: WorkflowAuthoringTranslate,
): string {
  if (error instanceof WorkflowAuthoringClientError && t) {
    return t(`workflowAuthoringError.${error.clientCode}`, {
      status: error.status ?? "—",
    });
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Download the annotated starter manifest as a file.
 *
 * A raw fetch rather than `callV1`, deliberately: that helper unwraps the
 * `{ok,data}` envelope, and the bytes we want on disk are the manifest itself —
 * an envelope would not re-import.
 */
export async function downloadWorkflowTemplateFile(
  templateId = "blank",
): Promise<string> {
  const response = await fetch(
    `/v1/workflow-templates/${encodeURIComponent(templateId)}/download`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...tenantHeader() },
    },
  );
  if (!response.ok) {
    throw new WorkflowAuthoringClientError(
      "requestFailed",
      `Template download failed (${response.status})`,
      response.status,
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename =
    /filename="([^"]+)"/.exec(disposition)?.[1] ?? "workflow-template.json";
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  try {
    const anchorEl = document.createElement("a");
    anchorEl.href = href;
    anchorEl.download = filename;
    document.body.appendChild(anchorEl);
    anchorEl.click();
    anchorEl.remove();
  } finally {
    URL.revokeObjectURL(href);
  }
  return filename;
}

async function callV1<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const { headers: initialHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...usageAttributionHeaders("workflow-authoring"),
    ...(initialHeaders as Record<string, string> | undefined),
  };
  if (rest.body != null && !headers["Content-Type"]) {
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
    throw new WorkflowAuthoringClientError(
      "networkUnavailable",
      "Could not reach the workflow authoring service.",
    );
  }
  const body = (await response.json().catch(() => null)) as
    | ApiOk
    | ApiErr
    | null;
  if (!response.ok || !body || body.ok !== true) {
    const conflict = workflowOverwriteConflict(response.status, body);
    if (conflict) throw conflict;
    const error = body && body.ok === false ? body.error : null;
    if (!error) {
      throw new WorkflowAuthoringClientError(
        response.ok ? "invalidResponse" : "requestFailed",
        response.ok
          ? "The workflow authoring service returned an invalid response."
          : `Workflow authoring request failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    const code = error.code;
    throw new WorkflowAuthoringApiError(
      code,
      `${code}: ${error.message}${error.hint ? ` — ${error.hint}` : ""}`,
      error.details,
    );
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    throw new WorkflowAuthoringClientError(
      "invalidResponse",
      "The workflow authoring service returned an invalid response.",
      response.status,
    );
  }
  return parsed.data;
}

export const WORKFLOW_AUTHORING_KEYS = {
  all: ["workflow-authoring"] as const,
  list: ["workflow-authoring", "list"] as const,
  templates: ["workflow-authoring", "templates"] as const,
  detail: (slug: string) => ["workflow-authoring", "detail", slug] as const,
  runProfile: (slug: string, target: WorkflowRunProfileTarget) =>
    ["workflow-authoring", "run-profile", slug, target] as const,
  folders: ["workflow-authoring", "document-folders"] as const,
};

async function refreshWorkflowQueries(
  client: ReturnType<typeof useQueryClient>,
) {
  await Promise.all([
    client.invalidateQueries({ queryKey: WORKFLOW_AUTHORING_KEYS.all }),
    client.invalidateQueries({ queryKey: ["workflows"] }),
    client.invalidateQueries({ queryKey: ["agents"] }),
    client.invalidateQueries({ queryKey: ["deployments"] }),
  ]);
}

export function useWorkflowTemplates() {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.templates,
    queryFn: () =>
      callV1("/v1/workflow-templates", WorkflowTemplateCatalogResponseSchema),
    staleTime: 60_000,
  });
}

export function useWorkflowCatalog() {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.list,
    queryFn: () => callV1("/v1/workflows", WorkflowListResponseSchema),
    staleTime: 5_000,
  });
}

export function useWorkflowDetail(slug?: string | null) {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.detail(slug ?? "__none__"),
    queryFn: () =>
      callV1(
        `/v1/workflows/${encodeURIComponent(slug!)}`,
        WorkflowDetailSchema,
      ),
    enabled: Boolean(slug),
    staleTime: 3_000,
  });
}

export function useWorkflowDocumentFolders() {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.folders,
    queryFn: () =>
      callV1(
        "/v1/workflow-document-folders",
        WorkflowDocumentFoldersResponseSchema,
      ),
    staleTime: 15_000,
  });
}

export function useWorkflowRunProfile(
  slug: string | null | undefined,
  target: WorkflowRunProfileTarget,
  enabled = true,
) {
  return useQuery({
    queryKey: WORKFLOW_AUTHORING_KEYS.runProfile(slug ?? "__none__", target),
    queryFn: () =>
      callV1(
        `/v1/workflows/${encodeURIComponent(slug!)}/run-profile?target=${encodeURIComponent(target)}`,
        WorkflowRunProfileSchema,
      ),
    enabled: Boolean(slug) && enabled,
    staleTime: target === "live" ? 5_000 : 2_000,
  });
}

export function useGenerateWorkflow() {
  return useMutation({
    mutationFn: (body: GenerateWorkflowBody) =>
      callV1("/v1/workflows/generate", GenerateWorkflowResponseSchema, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

/**
 * Streaming generation: same result as `useGenerateWorkflow`, but reports the
 * server's real stage transitions while it runs.
 *
 * Falls back to the plain endpoint when the stream cannot be opened at all, so
 * a proxy that buffers or blocks event-streams degrades to today's behaviour
 * rather than breaking generation.
 */
export async function generateWorkflowStreamed(
  body: GenerateWorkflowBody,
  onProgress: (event: WorkflowGenerationProgress) => void,
  signal?: AbortSignal,
): Promise<GenerateWorkflowResponse> {
  let response: Response;
  try {
    response = await fetch("/v1/workflows/generate/stream", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...tenantHeader(),
        ...usageAttributionHeaders("workflow-authoring"),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return callV1("/v1/workflows/generate", GenerateWorkflowResponseSchema, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  if (!response.ok || !response.body) {
    // A non-2xx here is a normal JSON envelope (the route parses the body
    // before hijacking), so surface it the way every other call does.
    let envelope: ApiErr | null = null;
    try {
      envelope = (await response.json()) as ApiErr;
    } catch {
      envelope = null;
    }
    throw new WorkflowGenerationError(
      envelope?.error?.code ?? "requestFailed",
      envelope?.error?.message ?? `Generation failed (${response.status})`,
      envelope?.error?.hint,
      envelope?.error?.details,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: GenerateWorkflowResponse | null = null;
  let failure: WorkflowGenerationError | null = null;

  const consumeFrame = (frame: string): void => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "progress") {
      const progress = WorkflowGenerationProgressSchema.safeParse(parsed);
      if (progress.success) onProgress(progress.data);
      return;
    }
    if (event === "result") {
      const finalResult = GenerateWorkflowResponseSchema.safeParse(parsed);
      if (finalResult.success) result = finalResult.data;
      else
        failure = new WorkflowGenerationError(
          "invalidResponse",
          "The server returned a workflow this client could not read.",
        );
      return;
    }
    if (event === "failed") {
      const shape = parsed as {
        code?: string;
        message?: string;
        hint?: string;
        details?: unknown;
      };
      failure = new WorkflowGenerationError(
        shape.code ?? "generation_failed",
        shape.message ?? "Generation failed.",
        shape.hint,
        shape.details,
      );
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      consumeFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) consumeFrame(buffer);

  if (failure) throw failure;
  if (!result) {
    throw new WorkflowGenerationError(
      "streamTruncated",
      "The connection closed before the workflow finished generating.",
      "Try again — nothing was created.",
    );
  }
  return result;
}

export function useRunWorkflowTest(slug?: string | null) {
  return useMutation({
    mutationFn: (body: WorkflowTestRunBody) => {
      if (!slug) {
        throw new WorkflowAuthoringClientError(
          "workflowRequired",
          "A workflow must be selected.",
        );
      }
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}/test-runs`,
        WorkflowTestRunResponseSchema,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
    },
  });
}

export function useGenerateWorkflowAgentPrompt(
  slug?: string | null,
  agentId?: string | null,
) {
  return useMutation({
    mutationFn: (body: WorkflowAgentPromptBody) => {
      if (!slug) {
        throw new WorkflowAuthoringClientError(
          "workflowRequired",
          "A workflow must be selected.",
        );
      }
      if (!agentId) {
        throw new WorkflowAuthoringClientError(
          "agentRequired",
          "An agent must be selected.",
        );
      }
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/generate-instructions`,
        WorkflowAgentPromptResponseSchema,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
    },
  });
}

export function useCreateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkflowBody) =>
      callV1("/v1/workflows", WorkflowDetailSchema, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

export function useSaveWorkflow(slug?: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveWorkflowBody) => {
      if (!slug) {
        throw new WorkflowAuthoringClientError(
          "workflowRequired",
          "A workflow must be selected.",
        );
      }
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}`,
        WorkflowDetailSchema,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

export function useValidateWorkflow(slug?: string | null) {
  return useMutation({
    mutationFn: (body: ValidateWorkflowBody = {}) => {
      if (!slug) {
        throw new WorkflowAuthoringClientError(
          "workflowRequired",
          "A workflow must be selected.",
        );
      }
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}/validate`,
        WorkflowValidationResponseSchema,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
  });
}

export function usePublishWorkflow(slug?: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      body: {
        versionId?: string;
        note?: string;
        confirmOverwrite?: boolean;
      } = {},
    ) => {
      if (!slug) {
        throw new WorkflowAuthoringClientError(
          "workflowRequired",
          "A workflow must be selected.",
        );
      }
      return callV1(
        `/v1/workflows/${encodeURIComponent(slug)}/publish`,
        ManifestImportCommit,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

export function useDeleteWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      callV1(
        `/v1/workflows/${encodeURIComponent(slug)}`,
        // Keep the tiny response local; no domain contract is needed.
        WorkflowDeleteResponse,
        { method: "DELETE" },
      ),
    onSuccess: async () => refreshWorkflowQueries(client),
  });
}

const WorkflowDeleteResponse = z.object({
  deleted: z.literal(true),
  slug: z.string(),
});

export type { WorkflowDetail };
