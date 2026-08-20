/**
 * OntoCode — thin API layer over the factory endpoints.
 *
 * Same transport rules as the factory page: tenant header on every call, the
 * shared `decodeFactoryResponse` envelope decoder, and no JSON content-type on
 * empty bodies (Fastify rejects `content-type: application/json` + empty body).
 */

import type { Translate } from "@/app/portal/lib/preferences-context";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import {
  buildHumanInteractionSubmission,
  decodeFactoryResponse,
  factoryNetworkFailure,
  type FactoryApiResult,
  type HumanInteractionKind,
} from "../factory/factory-api";
import {
  isFactoryRunStartReceipt,
  type FactoryRunStartReceipt,
} from "../factory/factory-run-start";
import type { DraftRow, RunRow } from "../factory/model";

function tenantHeaders(tenant: string): Record<string, string> {
  return { ...tenantHeader(), "x-agentic-tenant": tenant };
}

export type ScopeRecommendationMode =
  | "action_selection"
  | "scenario_match"
  | "virtual_scenario";

export interface ScopeRecommendationAction {
  id: string;
  name: string;
  reason: string;
}

/**
 * Server-owned Ontology scope recommendation. The UI deliberately does not
 * infer this scope from labels or select every Action as a fallback.
 */
export interface OntoCodeScopeRecommendation {
  recommendationId: string;
  ontologyHash: string;
  mode: ScopeRecommendationMode;
  scenario: string;
  actionIds: string[];
  actions: ScopeRecommendationAction[];
  reasoningSummary: string;
  confidence: number;
  unresolved?: string[];
  virtualAction?: {
    id: string;
    name: string;
    reason: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isOntoCodeScopeRecommendation(
  value: unknown,
): value is OntoCodeScopeRecommendation {
  if (!isRecord(value)) return false;
  const mode = value.mode;
  if (
    mode !== "action_selection" &&
    mode !== "scenario_match" &&
    mode !== "virtual_scenario"
  ) {
    return false;
  }
  if (
    typeof value.recommendationId !== "string" ||
    !/^rec_[a-f0-9]{32}$/.test(value.recommendationId) ||
    typeof value.ontologyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.ontologyHash) ||
    typeof value.scenario !== "string" ||
    !value.scenario.trim() ||
    !Array.isArray(value.actionIds) ||
    !value.actionIds.every((id) => typeof id === "string" && id.trim()) ||
    !Array.isArray(value.actions) ||
    !value.actions.every(
      (action) =>
        isRecord(action) &&
        typeof action.id === "string" &&
        Boolean(action.id.trim()) &&
        typeof action.name === "string" &&
        Boolean(action.name.trim()) &&
        typeof action.reason === "string" &&
        Boolean(action.reason.trim()),
    ) ||
    typeof value.reasoningSummary !== "string" ||
    !value.reasoningSummary.trim() ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return false;
  }
  if (
    value.unresolved !== undefined &&
    (!Array.isArray(value.unresolved) ||
      !value.unresolved.every(
        (item) => typeof item === "string" && Boolean(item.trim()),
      ))
  ) {
    return false;
  }
  if (
    value.virtualAction !== undefined &&
    (!isRecord(value.virtualAction) ||
      typeof value.virtualAction.id !== "string" ||
      !value.virtualAction.id.trim() ||
      typeof value.virtualAction.name !== "string" ||
      !value.virtualAction.name.trim() ||
      typeof value.virtualAction.reason !== "string" ||
      !value.virtualAction.reason.trim())
  ) {
    return false;
  }
  const uniqueActionIds = new Set(value.actionIds);
  const responseActionIds = new Set(
    value.actions.map((action) => (action as ScopeRecommendationAction).id),
  );
  if (
    uniqueActionIds.size !== value.actionIds.length ||
    responseActionIds.size !== value.actions.length ||
    uniqueActionIds.size !== responseActionIds.size ||
    [...uniqueActionIds].some((id) => !responseActionIds.has(id))
  ) {
    return false;
  }
  if (mode === "virtual_scenario") {
    return value.actionIds.length === 0 && value.virtualAction !== undefined;
  }
  if (value.virtualAction !== undefined || value.actionIds.length === 0) {
    return false;
  }
  return true;
}

export async function ocGet<T>(
  t: Translate,
  tenant: string,
  path: string,
): Promise<FactoryApiResult<T>> {
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...tenantHeaders(tenant) },
    });
    return await decodeFactoryResponse<T>(t, response);
  } catch (error) {
    return factoryNetworkFailure(t, error);
  }
}

export async function ocSend<T>(
  t: Translate,
  tenant: string,
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<FactoryApiResult<T>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeaders(tenant),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await decodeFactoryResponse<T>(t, response);
  } catch (error) {
    return factoryNetworkFailure(t, error);
  }
}

export async function startFactoryRun(
  t: Translate,
  tenant: string,
  input: {
    domain: string;
    /** Human-readable compatibility/audit field. */
    goal?: string;
    conversation?: string;
    /** IDs are resolved against the currently bound Ontology domain. */
    actionIds?: string[];
    /** Optional FDE-described scenario; it need not map to an existing Action. */
    scenario?: string;
    /** Pins a server recommendation to the Ontology snapshot it analyzed. */
    recommendationId?: string;
    ontologyHash?: string;
    interactionPolicy: "autopilot";
  },
): Promise<FactoryApiResult<FactoryRunStartReceipt>> {
  const result = await ocSend<FactoryRunStartReceipt>(
    t,
    tenant,
    "/v1/agent-factory/runs/start",
    "POST",
    {
      domain: input.domain,
      ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.actionIds?.length ? { actionIds: input.actionIds } : {}),
      ...(input.scenario?.trim() ? { scenario: input.scenario.trim() } : {}),
      ...(input.recommendationId
        ? { recommendationId: input.recommendationId }
        : {}),
      ...(input.ontologyHash ? { ontologyHash: input.ontologyHash } : {}),
      interactionPolicy: input.interactionPolicy,
    },
  );
  if (result.ok && !isFactoryRunStartReceipt(result.data)) {
    return {
      ok: false,
      status: result.status,
      message: "start receipt malformed",
    };
  }
  return result;
}

/**
 * Ask the server to read the bound Ontology and propose the smallest useful
 * Action scope for an FDE-described scenario. A malformed response is rejected
 * instead of silently widening scope.
 */
export async function recommendOntoCodeScope(
  t: Translate,
  tenant: string,
  input: { domain: string; scenario: string },
): Promise<FactoryApiResult<OntoCodeScopeRecommendation>> {
  const request = () =>
    ocSend<unknown>(
      t,
      tenant,
      "/v1/agent-factory/scope-recommendation",
      "POST",
      {
        domain: input.domain,
        scenario: input.scenario.trim(),
      },
    );
  let result = await request();
  // Scope analysis is read-like and issues a replaceable TTL receipt, so it
  // is safe to absorb the short Node watch restart window without asking the
  // FDE to click again. Mutation endpoints intentionally do not share this
  // retry: a lost mutation response is ambiguous until it has an idempotency
  // contract.
  for (const delayMs of [700, 1_500, 2_500]) {
    if (result.ok || result.code !== "api_restarting") break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await request();
  }
  if (!result.ok) return result;
  if (!isOntoCodeScopeRecommendation(result.data)) {
    return {
      ok: false,
      status: result.status,
      message: "Ontology 范围建议响应不完整，请重试",
    };
  }
  return { ok: true, status: result.status, data: result.data };
}

/** Answer a parked gate. The wire tags live in oc-model (byte-identical to factory). */
export async function injectGateAnswer(
  t: Translate,
  tenant: string,
  input: {
    conversation: string;
    interactionId: string;
    kind: HumanInteractionKind;
    text: string;
  },
): Promise<FactoryApiResult<unknown>> {
  const submission = buildHumanInteractionSubmission(t, input);
  return ocSend(t, tenant, "/v1/agent-factory/inject", "POST", submission);
}

export async function fetchFactoryRuns(
  t: Translate,
  tenant: string,
  domain: string,
): Promise<FactoryApiResult<{ runs: RunRow[] }>> {
  return ocGet<{ runs: RunRow[] }>(
    t,
    tenant,
    `/v1/agent-factory/runs?domain=${encodeURIComponent(domain)}`,
  );
}

// ── 部署（晋升）流程 — 与工厂页同一后端契约 ────────────────────────────────────

export async function fetchFactoryDrafts(
  t: Translate,
  tenant: string,
  domain: string,
): Promise<FactoryApiResult<{ drafts: DraftRow[] }>> {
  return ocGet<{ drafts: DraftRow[] }>(
    t,
    tenant,
    `/v1/agent-factory/drafts?domain=${encodeURIComponent(domain)}`,
  );
}

export async function requestPromotionPreview(
  t: Translate,
  tenant: string,
  input: { domain: string; versionId: string; slugs: string[] },
): Promise<FactoryApiResult<unknown>> {
  return ocSend(
    t,
    tenant,
    "/v1/agent-factory/drafts/promotion-preview",
    "POST",
    input,
  );
}

export async function fetchDraftCode(
  t: Translate,
  tenant: string,
  input: { domain: string; slug: string; versionId: string },
): Promise<
  FactoryApiResult<{
    domain: string;
    slug: string;
    code: string;
    filename: string;
  }>
> {
  return ocGet(
    t,
    tenant,
    `/v1/agent-factory/drafts/code?domain=${encodeURIComponent(input.domain)}&slug=${encodeURIComponent(input.slug)}&versionId=${encodeURIComponent(input.versionId)}`,
  );
}

export async function submitPromotionSignoff(
  t: Translate,
  tenant: string,
  input: {
    domain: string;
    versionId: string;
    slugs: string[];
    reviewChallenge: string;
  },
): Promise<FactoryApiResult<{ receipt: { receiptId: string } }>> {
  return ocSend(t, tenant, "/v1/agent-factory/drafts/reviews", "POST", {
    ...input,
    decision: "approve_code_and_design",
    codeReviewed: true,
    designReviewed: true,
  });
}

// ── Tool-Smith（文档 → 声明式工具 → 入库） ─────────────────────────────────────

export async function draftToolFromDoc(
  t: Translate,
  tenant: string,
  input: { text?: string; url?: string; intent: string },
): Promise<FactoryApiResult<{ draft: Record<string, unknown> }>> {
  return ocSend(t, tenant, "/v1/tools/generate-from-doc", "POST", input);
}

export interface SavedToolDraftReceipt {
  saved: true;
  draft: boolean;
  name: string;
  revisionId?: string;
  version?: number;
  definitionHash?: string;
  lifecycle: "draft";
  runtimeActive: boolean;
  activation?: {
    eligible: boolean;
    blockers: Array<{ code: string; message: string; next?: string }>;
  };
  sideEffect?: string;
  operation?: string;
  effectScope?: string;
  sandboxPolicy?: string;
}

export async function saveToolToLibrary(
  t: Translate,
  tenant: string,
  tool: unknown,
): Promise<FactoryApiResult<SavedToolDraftReceipt>> {
  return ocSend(t, tenant, "/v1/tools", "POST", tool);
}

// ── 外部系统档案（System Profiles） ────────────────────────────────────────────

export interface SystemProfileDoc {
  $schemaVersion: number;
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  capabilities: {
    api: Array<{
      operation: string;
      toolName?: string;
      description?: string;
      objectTypes?: string[];
    }>;
    events: Array<{
      direction: "inbound" | "outbound";
      eventName: string;
      payloadContract?: string;
      description?: string;
    }>;
    data: Array<{
      objectType: string;
      mode: "read" | "write" | "readwrite";
      via?: string;
    }>;
  };
  credential?: {
    provider?: string;
    envRefs?: string[];
    /** Health-check relative path for the generic probe (default "/health"). */
    healthPath?: string;
    /** Operator-config field SPECS (shapes only; never values). */
    fields?: Array<{
      key: string;
      label: string;
      kind?: "base_url" | "api_key" | "secret" | "text" | "select" | "env_only";
      required?: boolean;
      secret?: boolean;
      envRef?: string;
      placeholder?: string;
      hint?: string;
      options?: string[];
    }>;
  };
  governance?: { humanBoundary?: boolean; notes?: string };
  /** "planned" = ontology references it but the platform is not built yet. */
  availability?: "live" | "planned";
  plannedFallback?: "human_boundary" | "block";
  provenance: {
    mode: "manual" | "ai-drafted" | "imported";
    confirmedBy?: string;
    confirmedAt?: number;
    sourceNote?: string;
  };
}

export async function fetchSystemProfiles(
  t: Translate,
  tenant: string,
): Promise<FactoryApiResult<{ profiles: SystemProfileDoc[] }>> {
  return ocGet(t, tenant, "/v1/system-profiles");
}

export async function saveSystemProfile(
  t: Translate,
  tenant: string,
  profile: unknown,
): Promise<FactoryApiResult<{ profile: SystemProfileDoc }>> {
  return ocSend(t, tenant, "/v1/system-profiles", "PUT", profile);
}

export async function removeSystemProfile(
  t: Translate,
  tenant: string,
  profileId: string,
): Promise<FactoryApiResult<{ deleted: boolean }>> {
  return ocSend(
    t,
    tenant,
    `/v1/system-profiles/${encodeURIComponent(profileId)}`,
    "DELETE",
  );
}

/** One derived config field (mirrors @agentic/contracts DerivedConfigField). */
export interface OcConfigField {
  key: string;
  label: string;
  kind: "base_url" | "api_key" | "secret" | "text" | "select" | "env_only";
  required: boolean;
  secret?: boolean;
  envRef?: string;
  placeholder?: string;
  hint?: string;
  options?: string[];
  source: "profile" | "tool" | "catalog" | "default";
  satisfied: boolean;
  envPresent?: boolean;
}

/** The system's derived configuration posture (secret-free, server-derived). */
export interface OcConfigRequirement {
  provider: string | null;
  posture:
    | "fields"
    | "none"
    | "env_only"
    | "server_managed"
    | "planned"
    | "unsupported";
  fields: OcConfigField[];
  satisfied: boolean;
  note?: string;
}

export interface SystemCoverageRow {
  system: string;
  referencedByActions: string[];
  referencedVia: Array<"ontology" | "tool">;
  profileId: string | null;
  humanBoundary: boolean;
  /** satisfied by a platform runtime capability — no external connection needed */
  runtimeProvided: boolean;
  /** connection-ladder enrichment (from the coverage route) */
  hasTool: boolean;
  credentialProvider: string | null;
  credentialConfigured: boolean;
  /** last connection-probe result (null = never probed) */
  probeOk: boolean | null;
  probeAt: number | null;
  /** lifecycle: "planned" = ontology references it, platform not built yet */
  availability?: "live" | "planned";
  plannedFallback?: "human_boundary" | "block";
  /** dynamic config requirement (fields + satisfaction) for 去配置/工作台③ */
  configRequirement?: OcConfigRequirement;
}

/** Run a REAL credentialed connection probe for a system's provider (reuses the
 *  provider health tool). Validates 凭证+API 连得上 — not business logic. */
export async function probeSystemConnection(
  t: Translate,
  tenant: string,
  profileId: string,
): Promise<
  FactoryApiResult<{
    ok: boolean;
    provider: string;
    at: number;
    detail?: string;
  }>
> {
  return ocSend(
    t,
    tenant,
    `/v1/system-profiles/${encodeURIComponent(profileId)}/probe`,
    "POST",
  );
}

export interface SystemCoverage {
  systems: SystemCoverageRow[];
  totals: {
    referenced: number;
    profiled: number;
    humanBoundary: number;
    unprofiled: number;
  };
}

/** Kebab-case profile id from a system's business name. */
function systemToProfileId(system: string): string {
  return (
    system
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "system"
  );
}

/** Fetch the tenant profile that answers to this system name (id/name/alias
 *  match, same normalization as the server's coverage matching). One-click
 *  markers MUST read-merge-write through this — a blind minimal PUT would
 *  overwrite a rich existing profile and drop its capabilities. */
async function fetchProfileBySystemName(
  t: Translate,
  tenant: string,
  system: string,
): Promise<SystemProfileDoc | null> {
  const r = await ocGet<{ profiles: SystemProfileDoc[] }>(
    t,
    tenant,
    "/v1/system-profiles",
  );
  if (!r.ok) return null;
  const normName = (v: string): string =>
    v
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s_.:/()-]+/g, "");
  const k = normName(system);
  return (
    r.data.profiles.find((p) => {
      const names = [
        String(p.id ?? ""),
        String(p.name ?? ""),
        ...((p.aliases as string[] | undefined) ?? []),
      ];
      return names.some((n) => n && normName(n) === k);
    }) ?? null
  );
}

/** Minimal skeleton when the system has no profile yet. */
function minimalProfileFor(system: string, notes: string): SystemProfileDoc {
  return {
    id: systemToProfileId(system),
    name: system,
    aliases: [system],
    governance: { notes },
    provenance: { mode: "manual" },
  } as SystemProfileDoc;
}

/** One-click: mark a referenced system as a deliberate human boundary — merged
 *  onto the existing profile when one exists (A3 then honors it so the binding
 *  gate stops re-asking). */
export async function markSystemHumanBoundary(
  t: Translate,
  tenant: string,
  system: string,
): Promise<FactoryApiResult<{ profile: SystemProfileDoc }>> {
  const existing = await fetchProfileBySystemName(t, tenant, system);
  const base =
    existing ??
    minimalProfileFor(system, "标记为人工边界（由系统连接工作台一键创建）");
  const governance = {
    ...((base.governance as Record<string, unknown> | undefined) ?? {}),
    humanBoundary: true,
  };
  return saveSystemProfile(t, tenant, { ...base, governance });
}

/** Mark a system as PLANNED (ontology references it; platform not built yet)
 *  with the chosen fallback for actions that touch it. Read-merge-write. */
export async function markSystemPlanned(
  t: Translate,
  tenant: string,
  system: string,
  fallback: "human_boundary" | "block",
): Promise<FactoryApiResult<{ profile: SystemProfileDoc }>> {
  const existing = await fetchProfileBySystemName(t, tenant, system);
  const base =
    existing ??
    minimalProfileFor(system, "本体已规划、系统未建成（由系统连接工作台标记）");
  return saveSystemProfile(t, tenant, {
    ...base,
    availability: "planned",
    plannedFallback: fallback,
  });
}

/** The system got built — flip it back to live (keeps everything else). */
export async function markSystemLive(
  t: Translate,
  tenant: string,
  system: string,
): Promise<FactoryApiResult<{ profile: SystemProfileDoc }>> {
  const existing = await fetchProfileBySystemName(t, tenant, system);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      message: "找不到该系统的档案——无法翻回 live",
    };
  }
  return saveSystemProfile(t, tenant, { ...existing, availability: "live" });
}

export async function fetchSystemCoverage(
  t: Translate,
  tenant: string,
  domain: string,
  scope?: { actionIds?: string[]; agentSlugs?: string[] },
): Promise<FactoryApiResult<SystemCoverage>> {
  const query = new URLSearchParams({ domain });
  for (const actionId of scope?.actionIds ?? [])
    query.append("actionIds", actionId);
  for (const agentSlug of scope?.agentSlugs ?? [])
    query.append("agentSlugs", agentSlug);
  return ocGet(t, tenant, `/v1/system-profiles/coverage?${query.toString()}`);
}

export async function draftSystemProfile(
  t: Translate,
  tenant: string,
  input: { text?: string; url?: string; hint?: string },
): Promise<FactoryApiResult<{ draft: SystemProfileDoc; imported: boolean }>> {
  return ocSend(t, tenant, "/v1/system-profiles/draft-from-doc", "POST", input);
}

// ── 域绑定 / 本体上传 / 运行管理 — 与工厂页同一后端契约 ─────────────────────────

export async function bindFactoryDomain(
  t: Translate,
  tenant: string,
  input: { ontologyDomainId: string; confirmRebind: boolean },
): Promise<FactoryApiResult<{ binding: unknown; boundDomain: unknown }>> {
  return ocSend(t, tenant, "/v1/agent-factory/domain-binding", "PUT", input);
}

export async function fetchOntologyUploads(
  t: Translate,
  tenant: string,
): Promise<FactoryApiResult<{ uploads: Array<{ id: string }> }>> {
  return ocGet(t, tenant, "/v1/agent-factory/ontology-uploads");
}

export async function uploadOntologyBundle(
  t: Translate,
  tenant: string,
  input: { name: string; ontology: unknown; domainId?: string },
): Promise<FactoryApiResult<{ uploaded?: { id?: string; name?: string } }>> {
  return ocSend(t, tenant, "/v1/agent-factory/ontology-upload", "POST", {
    name: input.name,
    ontology: input.ontology,
    ...(input.domainId ? { domainId: input.domainId } : {}),
  });
}

export async function deleteOntologyUpload(
  t: Translate,
  tenant: string,
  id: string,
): Promise<FactoryApiResult<{ deleted: boolean }>> {
  return ocSend(
    t,
    tenant,
    `/v1/agent-factory/ontology-uploads/${encodeURIComponent(id)}`,
    "DELETE",
  );
}

export async function deleteFactoryRun(
  t: Translate,
  tenant: string,
  id: string,
): Promise<FactoryApiResult<{ deleted: boolean }>> {
  return ocSend(
    t,
    tenant,
    `/v1/agent-factory/runs/${encodeURIComponent(id)}`,
    "DELETE",
  );
}

export async function promoteDraftSet(
  t: Translate,
  tenant: string,
  input: {
    domain: string;
    versionId: string;
    receiptId: string;
    slugs: string[];
  },
): Promise<
  FactoryApiResult<{
    promoted: string[];
    functionsRegistered: number;
    liveAgents: number;
  }>
> {
  return ocSend(t, tenant, "/v1/agent-factory/drafts/promote", "POST", input);
}
