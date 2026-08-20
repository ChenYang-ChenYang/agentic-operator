/**
 * useTools — TanStack Query wrapper around GET /v1/tools.
 *
 * Returns the catalog of every globally-registered tool in
 * @agentic/tools, including per-tenant config schema + a copy-paste
 * config example. Used by the portal's Tools view so manifest authors
 * can browse what's available without grepping the codebase.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { fetchApiData } from "@/lib/api-response";
import { tenantHeader } from "./tenant-header";

export interface ToolFieldSchema {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
}

export interface ToolCatalogEntry {
  name: string;
  category: string;
  summary: string;
  description?: string;
  /** Shape of the LLM-supplied arguments. */
  argsSchema?: Record<string, ToolFieldSchema>;
  argsExample?: Record<string, unknown>;
  /** Per-tenant config keys from manifest tool_use[].config. */
  configSchema?: Record<string, ToolFieldSchema>;
  configExample?: Record<string, unknown>;
  /** Shape of the success return value. */
  returnsSchema?: Record<string, ToolFieldSchema>;
  returnsExample?: unknown;
  /** Tools this one chains with via ctx.lastResult. */
  chainsWith?: string[];
  aliases?: string[];
  sourcePath: string;
  /** "global" = built-in @agentic/tools; "created" = a persisted declarative 造工具 tool. */
  origin?: "global" | "created";
  /** #SCALE-TOOLS — empirical sandbox effectiveness from tool_stats (present once the tool has run). */
  invoked?: number;
  succeeded?: number;
  successRate?: number;
  sideEffect?: ToolSideEffect;
  operation?: ToolOperation;
  effectScope?: ToolEffectScope;
  sandboxPolicy?: ToolSandboxPolicy;
  activeRevisionId?: string;
  activeRevisionDomainId?: string | null;
  managedLifecycle?: boolean;
  deactivationBlocker?: ToolLifecycleBlocker;
  probeStatus?: "verified" | "failed" | "required";
  probeEvidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
  productionProbeVerified?: boolean;
  verifiedAt?: string;
  integrationProfiles?: ToolIntegrationProfile[];
}

export interface ToolCatalogPayload {
  tools: ToolCatalogEntry[];
  count: number;
  createdCount?: number;
  categories: string[];
}

export type ToolSideEffect = "read" | "write" | "dual";
export type ToolOperation = "read" | "compute" | "write" | "read_write";
export type ToolEffectScope = "external";
export type ToolSandboxPolicy =
  | "live_external"
  | "requires_attempt_grant";

export interface ToolCapabilityDescriptor {
  systems: string[];
  kinds: string[];
  roles: string[];
  operations?: string[];
  objectTypes?: string[];
  probeRequired?: boolean;
}

export interface ToolLifecycleBlocker {
  code: string;
  message: string;
  next?: string;
}

export type ToolIntegrationProfileEnvironment = "sandbox" | "production";

export interface ToolIntegrationConfigIssue {
  code: string;
  path: string;
  message: string;
}

export interface ToolIntegrationConfigValidation {
  valid: boolean;
  /** Server-side env references resolve. This is readiness, not probe evidence. */
  ready: boolean;
  config: Record<string, unknown>;
  issues: ToolIntegrationConfigIssue[];
  missingConfigKeys: string[];
  invalidConfigKeys: string[];
  envRefs: string[];
  missingEnvRefs: string[];
}

export interface ToolIntegrationProfile {
  id: string;
  tenantId?: string;
  profileKey: string;
  toolName: string;
  domainId: string;
  environment: ToolIntegrationProfileEnvironment;
  config: Record<string, unknown>;
  confirmedBy: string;
  toolDefinitionDigest: string;
  configDigest: string;
  authorizationProtocolVersion: number;
  confirmedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ToolIntegrationProfileRecord
  extends ToolIntegrationProfile {
  /** Present on GET /profiles; the catalog's compact projection omits it. */
  validation?: ToolIntegrationConfigValidation;
}

export interface ToolIntegrationProfilesPayload {
  profiles: ToolIntegrationProfileRecord[];
  count: number;
}

export interface SaveToolIntegrationProfileInput {
  name: string;
  profileKey: string;
  environment: ToolIntegrationProfileEnvironment;
  config: Record<string, unknown>;
}

export interface DeleteToolIntegrationProfileInput {
  name: string;
  profileKey: string;
  environment: ToolIntegrationProfileEnvironment;
}

/** A draft HTTP-tool contract returned by POST /v1/tools/generate-from-doc. */
export interface ToolDraft {
  name?: string;
  description?: string;
  method?: string;
  url_template?: string;
  headers?: Record<string, string>;
  body_template?: string;
  request_spec?: Record<string, unknown>;
  response_spec?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
  side_effect?: ToolSideEffect;
  operation?: ToolOperation;
  effect_scope?: ToolEffectScope;
  sandbox_policy?: ToolSandboxPolicy;
  params_schema?: Record<string, unknown>;
  returns_schema?: Record<string, unknown>;
  capabilities?: ToolCapabilityDescriptor[];
  auth_hint?: string;
  confidence?: number;
  notes?: string;
}

export interface SaveToolBody {
  name: string;
  description: string;
  method: string;
  url_template: string;
  headers?: Record<string, string>;
  body_template?: string;
  request_spec?: Record<string, unknown>;
  response_spec?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
  side_effect: ToolSideEffect;
  operation: ToolOperation;
  effect_scope: ToolEffectScope;
  sandbox_policy: ToolSandboxPolicy;
  params_schema: Record<string, unknown>;
  returns_schema: Record<string, unknown>;
  capabilities: ToolCapabilityDescriptor[];
}

export type ToolRevisionStatus = "draft" | "active" | "retired" | "rejected";

export interface ManagedToolRevision {
  id: string;
  tenantId: string;
  domainId: string | null;
  name: string;
  version: number;
  status: ToolRevisionStatus;
  definitionHash: string;
  definition: Record<string, unknown>;
  validation: {
    schema: string;
    passed: boolean;
    checks: string[];
    issues: string[];
    validatedAt: string;
  };
  source: "ontocode" | "manual" | "api_import";
  createdBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  activatedAt?: string;
  retiredAt?: string;
  activationProbeHash?: string;
  supersedesRevisionId?: string;
  activationEvidence?: Record<string, unknown>;
  activation: {
    eligible: boolean;
    blockers: ToolLifecycleBlocker[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface ToolRevisionPage {
  revisions: ManagedToolRevision[];
  nextCursor?: string;
}

async function callV1<T>(path: string): Promise<T> {
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...tenantHeader() },
  });
}

async function sendV1<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  payload?: unknown,
): Promise<T> {
  return fetchApiData<T>(path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...tenantHeader(),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

export function useTools(): UseQueryResult<ToolCatalogPayload> {
  return useQuery({
    queryKey: ["tools", "catalog"] as const,
    queryFn: () => callV1<ToolCatalogPayload>("/v1/tools"),
    // The catalog is process-stable (boot-time registry) — refetch on
    // window focus is wasteful. 5 minutes is generous; the operator can
    // hard-refresh if the api ships a new tool.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Exact, tenant/domain-scoped Factory profiles for one executable tool. */
export function useToolIntegrationProfiles(
  name: string,
  options?: { enabled?: boolean },
): UseQueryResult<ToolIntegrationProfilesPayload> {
  return useQuery({
    queryKey: ["tools", "profiles", name] as const,
    queryFn: () =>
      callV1<ToolIntegrationProfilesPayload>(
        `/v1/tools/${encodeURIComponent(name)}/profiles`,
      ),
    enabled: Boolean(name) && (options?.enabled ?? true),
    staleTime: 10_000,
  });
}

/** Upsert one secret-free profile. Saving is not probe verification. */
export function useSaveToolIntegrationProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveToolIntegrationProfileInput) =>
      sendV1<{
        profile: ToolIntegrationProfile;
        validation: ToolIntegrationConfigValidation;
      }>(
        `/v1/tools/${encodeURIComponent(input.name)}/profiles/${encodeURIComponent(input.profileKey)}`,
        "PUT",
        {
          environment: input.environment,
          config: input.config,
        },
      ),
    onSuccess: (_receipt, input) => {
      void qc.invalidateQueries({
        queryKey: ["tools", "profiles", input.name],
      });
      void qc.invalidateQueries({ queryKey: ["tools", "catalog"] });
    },
  });
}

/** Delete exactly one environment-scoped profile; DELETE deliberately has no body. */
export function useDeleteToolIntegrationProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteToolIntegrationProfileInput) => {
      const query = new URLSearchParams({ environment: input.environment });
      return sendV1<{
        deleted: true;
        name: string;
        profileKey: string;
        environment: ToolIntegrationProfileEnvironment;
      }>(
        `/v1/tools/${encodeURIComponent(input.name)}/profiles/${encodeURIComponent(input.profileKey)}?${query.toString()}`,
        "DELETE",
      );
    },
    onSuccess: (_receipt, input) => {
      void qc.invalidateQueries({
        queryKey: ["tools", "profiles", input.name],
      });
      void qc.invalidateQueries({ queryKey: ["tools", "catalog"] });
    },
  });
}

/** Managed revisions are review state, intentionally separate from runtime tools. */
export function useToolRevisions(input?: {
  name?: string;
  status?: ToolRevisionStatus;
  domainId?: string;
  limit?: number;
}): UseQueryResult<ToolRevisionPage> {
  const query = new URLSearchParams();
  if (input?.name) query.set("name", input.name);
  if (input?.status) query.set("status", input.status);
  if (input?.domainId) query.set("domain_id", input.domainId);
  query.set("limit", String(input?.limit ?? 50));
  return useQuery({
    queryKey: [
      "tools",
      "revisions",
      input?.name ?? null,
      input?.status ?? null,
      input?.domainId ?? null,
      input?.limit ?? 50,
    ] as const,
    queryFn: () =>
      callV1<ToolRevisionPage>(`/v1/tools/revisions?${query.toString()}`),
    staleTime: 5_000,
  });
}

/** Tool-Smith: fetch a public API doc (or take pasted text) and LLM-extract a draft contract. */
export function useGenerateToolFromDoc() {
  return useMutation({
    mutationFn: (body: { url?: string; text?: string; intent: string }) =>
      sendV1<{ draft: ToolDraft }>("/v1/tools/generate-from-doc", "POST", body),
  });
}

/** Save a declarative tool to the shared library (then refresh the catalog). */
export function useSaveTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveToolBody) =>
      sendV1<{
        saved: boolean;
        draft: boolean;
        name: string;
        revisionId?: string;
        version?: number;
        definitionHash?: string;
        lifecycle: "draft";
        runtimeActive: boolean;
        activation: {
          eligible: boolean;
          blockers: ToolLifecycleBlocker[];
        };
        sideEffect: ToolSideEffect;
        operation: ToolOperation;
        effectScope: ToolEffectScope;
        sandboxPolicy: ToolSandboxPolicy;
      }>("/v1/tools", "POST", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tools", "catalog"] });
      void qc.invalidateQueries({ queryKey: ["tools", "revisions"] });
    },
  });
}

export interface ToolProbeReceipt {
  verified: boolean;
  status: string;
  classification: string;
  definitionHash?: string;
  schemaHash?: string;
  durationMs?: number;
  error?: string;
}

/** Probe the exact immutable draft revision. */
export function useProbeToolRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      revisionId: string;
      revisionDomainId: string;
      args: Record<string, unknown>;
      config?: Record<string, unknown>;
    }) =>
      sendV1<ToolProbeReceipt>(
        `/v1/tools/${encodeURIComponent(input.name)}/probe`,
        "POST",
        {
          revision_id: input.revisionId,
          revision_domain_id: input.revisionDomainId,
          args: input.args,
          ...(input.config ? { config: input.config } : {}),
          persist_cassette: true,
        },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["tools", "revisions"] }),
  });
}

/** Human activation with an exact optimistic-concurrency observation. */
export function useActivateToolRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      revisionId: string;
      revisionDomainId: string;
      expectedActiveRevisionId: string | null;
    }) =>
      sendV1<{ activated: true; revision: ManagedToolRevision }>(
        `/v1/tools/${encodeURIComponent(input.name)}/revisions/${encodeURIComponent(input.revisionId)}/activate`,
        "POST",
        {
          revisionDomainId: input.revisionDomainId,
          expectedActiveRevisionId: input.expectedActiveRevisionId,
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tools", "catalog"] });
      void qc.invalidateQueries({ queryKey: ["tools", "revisions"] });
    },
  });
}

export function useRejectToolRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      revisionId: string;
      revisionDomainId: string;
    }) =>
      sendV1<{ rejected: true; revision: ManagedToolRevision }>(
        `/v1/tools/${encodeURIComponent(input.name)}/revisions/${encodeURIComponent(input.revisionId)}/reject`,
        "POST",
        { revisionDomainId: input.revisionDomainId },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["tools", "revisions"] }),
  });
}

/** CAS-deactivate a created tool; immutable revision history is retained. */
export function useDeleteTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      expectedActiveRevisionId: string;
      revisionDomainId: string;
    }) => {
      const query = new URLSearchParams({
        expectedActiveRevisionId: input.expectedActiveRevisionId,
        revisionDomainId: input.revisionDomainId,
      });
      return sendV1<{
        deactivated: true;
        deleted: false;
        retainedHistory: true;
        name: string;
        revision: ManagedToolRevision;
      }>(
        `/v1/tools/${encodeURIComponent(input.name)}?${query.toString()}`,
        "DELETE",
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tools", "catalog"] });
      void qc.invalidateQueries({ queryKey: ["tools", "revisions"] });
    },
  });
}
