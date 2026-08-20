"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  CommitOntoCodeChangeSetRequest,
  CommitOntoCodeWorkspacePatchRequest,
  CloseOntoCodeSessionRequest,
  CreateOntoCodeArtifactRequest,
  CreateOntoCodeArtifactVersionRequest,
  CreateOntoCodeChangeSetRequest,
  CreateOntoCodeCommandRequest,
  CreateOntoCodeConfigurationTaskRequest,
  CreateOntoCodeEvidenceRecordRequest,
  CreateOntoCodeHarnessJobRequest,
  CreateOntoCodeProjectRequest,
  CreateOntoCodeSessionRequest,
  DecideOntoCodeCommandRequest,
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeAssistantRun,
  OntoCodeBuildSession,
  OntoCodeCandidateHead,
  OntoCodeChangeSet,
  OntoCodeChangeSetOperation,
  OntoCodeCommand,
  OntoCodeEvidenceRecord,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeOntologyFreshness,
  OntoCodePackageVersion,
  OntoCodeSandboxAttempt,
  OntoCodeWorkspacePatchCommitReceipt,
  OntoCodeProject,
  OntoCodeConfigurationTask,
  OntoCodeConfigurationTaskCreateReceipt,
  OntoCodeConfigurationTaskGetReceipt,
  OntoCodeConfigurationTaskVerifyReceipt,
  OntoCodeTurnReceipt,
  OntoCodeSessionCloseReceipt,
  OntoCodeSessionEvent,
  OntoCodeSuiteOverview,
  PostOntoCodeMessageRequest,
  PostOntoCodeTurnRequest,
  UpdateOntoCodeSessionRequest,
} from "@agentic/contracts";
import { OntoCodeOntologyFreshnessSchema } from "@agentic/contracts";
import { ApiResponseError, fetchApiData } from "@/lib/api-response";

export interface Page<T> {
  items: T[];
  count: number;
  nextOffset: number | null;
}

/** messages 路由的单页上限（服务端 PaginationQuerySchema 的 max=200）。 */
const MESSAGES_PAGE_LIMIT = 200;
/**
 * 翻页上限（20 页 × 200 = 4000 条封顶），防御游标异常时的死循环。
 * 命中上限时返回的 nextOffset 保持非 null，如实暴露「还没取完」。
 */
export const ONTOCODE_MESSAGES_MAX_PAGES = 20;

/**
 * 逐页取全一个 asc(createdAt) 排序的列表。以前 messages 只取一页
 * limit=200 offset=0：会话一旦超过 200 行，最新的消息——包括每一条分析
 * 完成消息——永远到不了客户端，直播气泡的交接判定等不到权威答案，
 * 落库的回答也永远渲染不出来。服务端契约：nextOffset 非 null 即还有下一页
 * （见 api 侧 page() helper），没有 hasMore 字段。
 */
export async function fetchAllOntoCodeMessagePages<T>(
  fetchPage: (offset: number) => Promise<Page<T>>,
  maxPages: number = ONTOCODE_MESSAGES_MAX_PAGES,
): Promise<Page<T>> {
  const items: T[] = [];
  let nextOffset: number | null = 0;
  let pages = 0;
  while (nextOffset !== null && pages < maxPages) {
    const page: Page<T> = await fetchPage(nextOffset);
    items.push(...page.items);
    pages += 1;
    if (page.nextOffset !== null && page.nextOffset <= nextOffset) {
      // 不前进的游标只可能是服务端缺陷；立即停下，保留非 null 的 nextOffset
      // 如实标记「未取完」，绝不无限循环。
      nextOffset = page.nextOffset;
      break;
    }
    nextOffset = page.nextOffset;
  }
  return { items, count: items.length, nextOffset };
}

interface SessionCreateReceipt {
  session: OntoCodeBuildSession;
}

interface SessionGetReceipt {
  session: OntoCodeBuildSession;
}

interface SessionUpdateReceipt extends SessionGetReceipt {
  event: unknown;
}

interface ProjectCreateReceipt {
  project: OntoCodeProject;
  mode: "created" | "attached";
}

interface MessagePostReceipt {
  message: OntoCodeMessage;
  sessionRevision: number;
  mode: "created" | "attached";
}

interface CommandCreateReceipt {
  command: OntoCodeCommand;
  sessionRevision: number;
  mode: "created" | "attached";
}

interface CommandDecisionReceipt {
  command: OntoCodeCommand;
  sessionRevision: number;
  decision: "approve" | "reject";
  mode: "resolved" | "attached";
}

interface HarnessJobCreateReceipt {
  job: OntoCodeHarnessJob;
  sessionRevision: number;
  mode: "created" | "attached";
}

export interface OntoCodeHarnessJobRetryReceipt {
  retried: true;
  sessionId: string;
  jobId: string;
  attempt: number;
  sessionRevision: number;
  event: OntoCodeSessionEvent;
}

export interface BootstrapOntoCodeSessionInput {
  sessionId: string;
  goal: string;
  scopeMode?: "full_domain" | "scenario" | "selected_actions";
  actionIds?: string[];
}

export interface SendOntoCodeAssistantTurnInput {
  text: string;
  contextRefs?: string[];
}

/**
 * `command`/`job` are nullable on purpose. When bootstrap goes through the
 * conversational planner, a question-shaped goal legitimately resolves to an
 * `explain`/`clarify` directive with no Command and no Harness Job: the Session
 * opens with an assistant reply and waits for the FDE. That is a successful
 * bootstrap, not a failure, so callers must not assume a Job exists.
 */
export interface BootstrapOntoCodeSessionReceipt {
  message: OntoCodeMessage;
  command: OntoCodeCommand | null;
  job: OntoCodeHarnessJob | null;
  sessionRevision: number;
}

export type BootstrapRoute = "explicit_scope" | "planner";

/**
 * Decides which bootstrap path a new Session takes — and deliberately decides
 * it WITHOUT reading the goal sentence.
 *
 * The live defect this replaces: bootstrap hardcoded an `analyze_scope` Command
 * and a `scope` Harness Job for every new Session, so an FDE who typed
 * 「帮我分析所有 event」 got back a list of Actions — the wrong shape of answer.
 * The conversational planner already owns this routing rule in its system
 * prompt (`analyze_ontology` for "understand/analyse the domain", `analyze_scope`
 * only for an explicit full-domain Build request), so free text must reach the
 * planner instead of being classified here. Adding keyword matching to this
 * function would recreate the same two-authorities bug it exists to remove.
 *
 * The only thing that keeps the legacy path is an explicit scope the FDE
 * actually picked in the advanced workspace's scope picker: `full_domain`,
 * `selected_actions`, or a non-empty action selection. A `scenario` mode with
 * no chosen actions is free text by construction and goes to the planner.
 */
export function bootstrapRouteFor(
  input: BootstrapOntoCodeSessionInput,
): BootstrapRoute {
  if (
    input.scopeMode === "full_domain" ||
    input.scopeMode === "selected_actions"
  ) {
    return "explicit_scope";
  }
  return (input.actionIds?.length ?? 0) > 0 ? "explicit_scope" : "planner";
}

export interface OntoCodeArtifactSummaryItem {
  artifact: OntoCodeArtifact;
  latestVersion: OntoCodeArtifactVersion;
}

interface ChangeSetGetReceipt {
  changeSet: OntoCodeChangeSet;
  operations: OntoCodeChangeSetOperation[];
}

interface ChangeSetCreateReceipt extends ChangeSetGetReceipt {
  sessionRevision: number;
  mode: "created" | "attached";
}

interface ChangeSetCommitReceipt {
  changeSet: OntoCodeChangeSet;
  sessionRevision: number;
  mode: "committed" | "attached";
}

interface ArtifactCreateReceipt {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  sessionRevision: number;
  mode: "created" | "attached";
}

export interface OntoCodeArtifactVersionContentReceipt {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  content: string;
}

interface EvidenceCreateReceipt {
  evidence: OntoCodeEvidenceRecord;
  sessionRevision: number;
  mode: "created" | "attached";
}

interface CandidateHeadGetReceipt {
  head: OntoCodeCandidateHead | null;
  packageVersion: OntoCodePackageVersion | null;
}

function safeConfigurationSegment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized ||
    normalized.length > 160 ||
    /[\u0000-\u001f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Provider identity comes only from the tenant-scoped task returned by API. */
export function ontocodeConfigurationTaskProvider(
  task: OntoCodeConfigurationTask,
): string | null {
  switch (task.target.kind) {
    case "integration":
    case "llm_gateway":
    case "environment":
      return safeConfigurationSegment(task.target.provider);
    default:
      return null;
  }
}

export function ontocodeConfigurationTaskSystemName(
  task: OntoCodeConfigurationTask,
): string | null {
  switch (task.target.kind) {
    case "integration":
    case "system_profile":
    case "tool":
      return safeConfigurationSegment(task.target.system);
    case "tool_profile":
      return safeConfigurationSegment(task.target.toolName);
    default:
      return null;
  }
}

/** Return location is derived from the task, never from an open redirect. */
export function ontocodeConfigurationTaskSessionHref(
  tenant: string,
  task: Pick<OntoCodeConfigurationTask, "id" | "sessionId">,
): string {
  return `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(
    task.sessionId,
  )}?configTask=${encodeURIComponent(task.id)}`;
}

/**
 * Settings receives only the opaque task id. It resolves the provider from
 * the same server-owned task again so query-string tampering cannot select a
 * different credential form.
 */
export function ontocodeConfigurationTaskSettingsHref(
  tenant: string,
  task: Pick<OntoCodeConfigurationTask, "id">,
): string {
  return `/portal/${encodeURIComponent(
    tenant,
  )}/settings?section=integrations&configTask=${encodeURIComponent(task.id)}`;
}

/**
 * Tool authoring is a reviewed builder flow, not a credential form. Keep this
 * routing decision derived from the server-owned task target.
 */
export function ontocodeConfigurationTaskPrimaryHref(
  tenant: string,
  task: Pick<OntoCodeConfigurationTask, "id" | "target">,
): string {
  // `tool_profile` belongs here too: it has no credential provider by
  // construction, so Settings could only resolve `provider = null` and show an
  // error banner — while /configure/[taskId] renders the ToolProfileConfiguration
  // form that actually owns those keys.
  if (task.target.kind === "tool" || task.target.kind === "tool_profile") {
    return `/portal/${encodeURIComponent(
      tenant,
    )}/configure/${encodeURIComponent(task.id)}`;
  }
  return ontocodeConfigurationTaskSettingsHref(tenant, task);
}

function jsonHeaders(
  tenant: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-agentic-tenant": tenant,
    ...extra,
  };
}

/**
 * 请求头。**只有真的带请求体时才声明请求体的类型。**
 *
 * Fastify 对「声明了 application/json 却没有 body」的请求一律 400
 * （FST_ERR_CTP_EMPTY_JSON_BODY）。这里原本无条件加 Content-Type，于是每一个
 * 无 body 的 DELETE 在进路由之前就被拒了——删除 Session 的按钮点下去什么也不
 * 会发生，服务端连一行日志都没有。仓库里其它 hook（useModelFleet /
 * useApiTokens / useIntegrations / useBusinessOntologyDomains）都做了这个判断，
 * 只有这里没有。
 */
export function ontocodeRequestHeaders(
  tenant: string,
  init: Pick<RequestInit, "body" | "headers"> = {},
): Record<string, string> {
  const merged: Record<string, string> = {
    ...jsonHeaders(tenant),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body === undefined || init.body === null) {
    delete merged["Content-Type"];
  }
  return merged;
}

async function callV1<T>(
  tenant: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { headers, ...rest } = init;
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: ontocodeRequestHeaders(tenant, { body: rest.body, headers }),
  });
}

export async function saveOntoCodeToolProfile(
  tenant: string,
  target: Extract<
    OntoCodeConfigurationTask["target"],
    { kind: "tool_profile" }
  >,
  config: Record<string, unknown>,
): Promise<{
  profile: Record<string, unknown>;
  validation: {
    valid: boolean;
    ready: boolean;
    missingConfigKeys: string[];
    invalidConfigKeys: string[];
    missingEnvRefs: string[];
  };
}> {
  return callV1(
    tenant,
    `/v1/tools/${encodeURIComponent(target.toolName)}/profiles/${encodeURIComponent(target.profileKey)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        environment: target.environment,
        config,
      }),
    },
  );
}

function idempotencyKey(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export const ONTOCODE_KEYS = {
  projects: (tenant: string) => ["ontocode", tenant, "projects"] as const,
  sessions: (tenant: string) => ["ontocode", tenant, "sessions"] as const,
  session: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId] as const,
  messages: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "messages"] as const,
  assistantRuns: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "assistant-runs"] as const,
  commands: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "commands"] as const,
  jobs: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "jobs"] as const,
  changeSets: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "changesets"] as const,
  changeSet: (tenant: string, sessionId: string, changeSetId: string) =>
    [
      "ontocode",
      tenant,
      "session",
      sessionId,
      "changeset",
      changeSetId,
    ] as const,
  artifacts: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "artifacts"] as const,
  artifactVersions: (tenant: string, sessionId: string, artifactId: string) =>
    [
      "ontocode",
      tenant,
      "session",
      sessionId,
      "artifact",
      artifactId,
      "versions",
    ] as const,
  artifactVersionContent: (tenant: string, versionId: string) =>
    ["ontocode", tenant, "artifact-version", versionId, "content"] as const,
  evidence: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "evidence"] as const,
  candidateHead: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "candidate-head"] as const,
  configurationGaps: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "configuration-gaps"] as const,
  sandboxAttempts: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "sandbox-attempts"] as const,
  configurationTask: (tenant: string, taskId: string) =>
    ["ontocode", tenant, "configuration-task", taskId] as const,
  configurationTasks: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "configuration-tasks"] as const,
  events: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "events"] as const,
  suiteOverview: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "suite-overview"] as const,
  ontologyFreshness: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "ontology-freshness"] as const,
};

/**
 * 本体新鲜度的轮询周期（5 分钟）。
 *
 * 这个答案是服务端【当场回源测量】出来的，不缓存——所以每一次请求都真的
 * 打一次本体源。它只是「两次作业之间的可见性」，不是热路径：挂载时取一次、
 * 手动刷新时取一次，再加这个低频兜底就够了，秒级轮询只会把上游打疼。
 */
export const ONTOCODE_ONTOLOGY_FRESHNESS_REFETCH_MS = 300_000;

/**
 * 读一次「Session 锁定的本体是否还是源现在提供的那份」。
 *
 * 用契约 schema 严格解析：一个缺字段的载荷绝不能被当成「已核对」。
 * 路由不存在（旧版 api，404）时安静降级成 null＝「未核对」，由 UI 保留
 * 原来的「已锁定」；而 500 之类的真实故障照旧抛出去，不装作没事。
 */
export async function fetchOntoCodeOntologyFreshness(
  tenant: string,
  sessionId: string,
): Promise<OntoCodeOntologyFreshness | null> {
  try {
    const raw = await callV1<unknown>(
      tenant,
      `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/ontology-freshness`,
    );
    return OntoCodeOntologyFreshnessSchema.parse(raw);
  } catch (error) {
    if (error instanceof ApiResponseError && error.status === 404) return null;
    throw error;
  }
}

export function useOntoCodeOntologyFreshness(
  tenant: string,
  sessionId: string,
): UseQueryResult<OntoCodeOntologyFreshness | null> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.ontologyFreshness(tenant, sessionId),
    queryFn: () => fetchOntoCodeOntologyFreshness(tenant, sessionId),
    enabled: Boolean(tenant && sessionId),
    staleTime: ONTOCODE_ONTOLOGY_FRESHNESS_REFETCH_MS,
    // 只在 Session 打开着（hook 挂载着）时低频复测；后台标签页不复测。
    refetchInterval: ONTOCODE_ONTOLOGY_FRESHNESS_REFETCH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
}

export function useOntoCodeProjects(
  tenant: string,
): UseQueryResult<Page<OntoCodeProject>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.projects(tenant),
    queryFn: () =>
      callV1<Page<OntoCodeProject>>(tenant, "/v1/ontocode/projects?limit=200"),
    enabled: Boolean(tenant),
    staleTime: 5_000,
  });
}

export function useOntoCodeSessions(
  tenant: string,
): UseQueryResult<Page<OntoCodeBuildSession>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.sessions(tenant),
    queryFn: () =>
      callV1<Page<OntoCodeBuildSession>>(
        tenant,
        "/v1/ontocode/sessions?limit=200",
      ),
    enabled: Boolean(tenant),
    staleTime: 2_000,
  });
}

export function useOntoCodeSession(
  tenant: string,
  sessionId: string,
): UseQueryResult<SessionGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
    queryFn: () =>
      callV1<SessionGetReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 1_000,
  });
}

export function useOntoCodeMessages(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeMessage>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.messages(tenant, sessionId),
    queryFn: () =>
      fetchAllOntoCodeMessagePages((offset) =>
        callV1<Page<OntoCodeMessage>>(
          tenant,
          `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/messages` +
            `?limit=${MESSAGES_PAGE_LIMIT}&offset=${offset}`,
        ),
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export interface SystemConnectionRow {
  system: string;
  profileId: string | null;
  humanBoundary: boolean;
  runtimeProvided: boolean;
  hasTool: boolean;
  credentialProvider: string | null;
  credentialConfigured: boolean;
  probeOk: boolean | null;
  probeSupported: boolean;
  probeKind: "provider_health" | "allmeta_ontology_read" | null;
}

/**
 * 连接成熟度查询：某域下这些系统各自「差几步能用」——provider 映射、
 * 凭证是否已配、探针是否通。供行动卡把「去配置」变成指到具体 provider 的深链。
 */
export function useSystemConnections(
  tenant: string,
  domain: string | null,
  systems: string[],
): UseQueryResult<{ systems: SystemConnectionRow[] }> {
  const key = systems.slice().sort().join(",");
  return useQuery({
    queryKey: ["system-connections", tenant, domain ?? "", key] as const,
    queryFn: () => {
      const params = new URLSearchParams({ domain: domain ?? "" });
      for (const s of systems) params.append("systems", s);
      return callV1<{ systems: SystemConnectionRow[] }>(
        tenant,
        `/v1/system-profiles/coverage?${params.toString()}`,
      );
    },
    enabled: Boolean(tenant && domain && systems.length > 0),
    staleTime: 5_000,
  });
}

/** One referenced system's connection maturity, straight from the server. */
export interface SystemCoverageItem {
  system: string;
  referencedByActions: string[];
  referencedVia: string[];
  profileId: string | null;
  humanBoundary: boolean;
  runtimeProvided: boolean;
  hasTool: boolean;
  credentialProvider: string | null;
  credentialConfigured: boolean;
  probeOk: boolean | null;
  probeAt: number | null;
  /** True only when the server has a probe path that can actually execute for
   * this profile (provider health or strict Allmeta Ontology read). */
  probeSupported: boolean;
  probeKind: "provider_health" | "allmeta_ontology_read" | null;
  availability: "live" | "planned";
  plannedFallback: "human_boundary" | "block";
  configRequirement?: {
    provider: string | null;
    posture:
      | "fields"
      | "none"
      | "env_only"
      | "server_managed"
      | "planned"
      | "unsupported";
    satisfied: boolean;
    fields: Array<{
      key: string;
      label: string;
      kind: string;
      required: boolean;
      satisfied: boolean;
      envPresent?: boolean;
    }>;
    note?: string;
  };
}

export interface SystemCoverageReceipt {
  systems: SystemCoverageItem[];
  totals: {
    referenced: number;
    profiled: number;
    humanBoundary: number;
    unprofiled: number;
  };
}

/** Every system the bound Ontology domain references — not just the blocking one. */
export function useSystemCoverage(
  tenant: string,
  domain: string | null,
): UseQueryResult<SystemCoverageReceipt> {
  return useQuery({
    queryKey: ["ontocode", tenant, "system-coverage", domain] as const,
    queryFn: () =>
      callV1<SystemCoverageReceipt>(
        tenant,
        `/v1/system-profiles/coverage?domain=${encodeURIComponent(domain ?? "")}`,
      ),
    enabled: Boolean(tenant && domain),
    staleTime: 5_000,
    retry: false,
  });
}

export function useProbeSystemConnection(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      callV1<{ profile: unknown }>(
        tenant,
        `/v1/system-profiles/${encodeURIComponent(profileId)}/probe`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["ontocode", tenant, "system-coverage"],
      });
      void client.invalidateQueries({
        queryKey: ["system-connections", tenant],
      });
    },
  });
}

export function useMarkSystemsHumanBoundary(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { systems: string[]; note?: string }) =>
      callV1<{ marked: string[]; systems: string[] }>(
        tenant,
        "/v1/system-profiles/human-boundary",
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["ontocode", tenant, "system-coverage"],
      });
    },
  });
}

export interface OntoCodeSessionDeleteReceipt {
  deleted: true;
  sessionId: string;
  title: string;
  cancelledJobs: number;
  /** 外部存储的清除结果；服务端未采集到足迹时为 null。 */
  purge: {
    id: string;
    status: "completed" | "partial";
    removed: number;
    bytesRemoved: number;
    failures: Array<{ kind: string; ref: string; error: string }>;
    /** 刻意保留的东西 + 理由。删除必须说清自己没删什么。 */
    retained: Array<{ what: string; why: string }>;
  } | null;
}

export function useDeleteOntoCodeSession(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      callV1<OntoCodeSessionDeleteReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      ),
    onSuccess: (receipt) => {
      // 以前只清了 session 这一个 key，其余十来个 session 作用域的查询（消息、
      // 作业、事件、命令、产物、配置任务、助手运行、候选头、变更集、套件概览）
      // 全部留在缓存里：回到这个 id 仍然渲染已删内容，后台重取还会打到一个不
      // 存在的 Session。删干净就要连缓存一起删干净。
      // 每个 session 作用域的 key 都是 ["ontocode", tenant, "session", id, …]，
      // 所以按前缀一次清干净——逐个列举迟早会漏掉一个，而漏掉一个就复活一片。
      client.removeQueries({
        queryKey: ["ontocode", tenant, "session", receipt.sessionId],
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

/** 停下正在跑的作业，但保留 Session。
 *  在此之前，眼看作业跑飞了的唯一出路是删掉整个 Session——连带消息、事件、
 *  产物、证据一起没了。「停下这一步」和「这次尝试作废」是两个意图。 */
export function useCancelOntoCodeJob(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { jobId?: string } = {}) =>
      callV1<{ cancelled: boolean; sessionId: string; jobIds: string[] }>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/cancel-job`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.events(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

/** Re-run one recoverable failure under its original Job and Command ids. */
export function useRetryOntoCodeJob(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { jobId: string }) =>
      callV1<OntoCodeHarnessJobRetryReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/retry-job`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.commands(tenant, sessionId),
        ONTOCODE_KEYS.events(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useConfirmOntoCodeHumanBoundary(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { waitingJobId?: string; note?: string }) =>
      callV1<{
        systems: string[];
        markedProfiles: string[];
        resumed: boolean;
        resumeAction: string | null;
        waitingJobId: string;
      }>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/confirm-human-boundary`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("human-boundary") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.messages(tenant, sessionId),
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.events(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useOntoCodeSuiteOverview(
  tenant: string,
  sessionId: string,
): UseQueryResult<{ overview: OntoCodeSuiteOverview }> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.suiteOverview(tenant, sessionId),
    queryFn: () =>
      callV1<{ overview: OntoCodeSuiteOverview }>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/suite-overview`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 1_000,
  });
}

/** 事件端点的真实返回形状（不是通用 Page：它按 seq 游标翻页）。 */
interface EventPage {
  items: OntoCodeSessionEvent[];
  lastSeq: number;
  hasMore: boolean;
}

const EVENTS_PAGE_SIZE = 500;
/** 翻页上限。命中即如实上报，绝不悄悄只显示开头一段。 */
const EVENTS_MAX_PAGES = 8;

export function useOntoCodeSessionEvents(
  tenant: string,
  sessionId: string,
): UseQueryResult<EventPage & { truncated: boolean }> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.events(tenant, sessionId),
    queryFn: async () => {
      // 以前是「取前 200 条，忽略 hasMore」。事件按 seq 升序，所以一旦超过
      // 200 条，看到的永远是最早的 200 条——恰好把结论丢在视野外。接入真实
      // harness 轨迹后一次 Build 就能写几百条，第二次 Build 必然踩到。
      //
      // visibility 是下限而非精确匹配：debug 返回 user+debug，一次拿到完整
      // 有序轨迹（以前不带这个参数默认 user，推理与工具帧一条也到不了前端，
      // 「显示全部」按钮筛的列表里根本没有非 user 事件）。
      const items: OntoCodeSessionEvent[] = [];
      let after = 0;
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < EVENTS_MAX_PAGES) {
        const page = await callV1<EventPage>(
          tenant,
          `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/events` +
            `?limit=${EVENTS_PAGE_SIZE}&visibility=debug&after=${after}`,
        );
        items.push(...page.items);
        hasMore = page.hasMore;
        after = page.lastSeq;
        pages += 1;
      }
      return { items, lastSeq: after, hasMore, truncated: hasMore };
    },
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeConfigurationTasks(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeConfigurationTask>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.configurationTasks(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeConfigurationTask>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/configuration-tasks?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeAssistantRuns(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeAssistantRun>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeAssistantRun>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/assistant-runs?limit=20`,
      ),
    enabled: Boolean(tenant && sessionId),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (run) => run.status === "accepted" || run.status === "planning",
      )
        ? 1_500
        : false,
    staleTime: 2_500,
  });
}

/**
 * #CONFIG-GAPS — what THIS Build still needs connected.
 *
 * Secret-free by construction: the server returns field NAMES, provenance and
 * satisfaction, never values. `surface` says where each system is actually
 * resolved, so the page can stop sending an operator to a Settings form that
 * has nothing left to fill.
 */
export type OntoCodeGapSurface =
  | "integration"
  | "tool_profile"
  | "env"
  | "human_boundary"
  | "runtime";

export interface OntoCodeConfigurationGapsReceipt {
  sessionId: string;
  packageVersionId: string | null;
  packageStatus: string | null;
  candidateAbsent: boolean;
  systems: Array<{
    system: string;
    surface: OntoCodeGapSurface;
    provider: string | null;
    posture: string;
    satisfied: boolean;
    note: string | null;
    fields: Array<{
      key: string;
      label?: string;
      kind?: string;
      required?: boolean;
      satisfied?: boolean;
      envPresent?: boolean;
    }>;
    missingConfigKeys: string[];
    blockers: Array<{
      actionName: string | null;
      toolName: string | null;
      role: string | null;
      status: string | null;
      code: string | null;
      requirementId: string | null;
      missing: string[];
      reason: string | null;
    }>;
  }>;
}

export function useOntoCodeConfigurationGaps(
  tenant: string,
  sessionId: string,
): UseQueryResult<OntoCodeConfigurationGapsReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.configurationGaps(tenant, sessionId),
    queryFn: () =>
      callV1<OntoCodeConfigurationGapsReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/configuration-gaps`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 5_000,
  });
}

export function useOntoCodeCandidateHead(
  tenant: string,
  sessionId: string,
): UseQueryResult<CandidateHeadGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.candidateHead(tenant, sessionId),
    queryFn: () =>
      callV1<CandidateHeadGetReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/candidate-head`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 1_000,
  });
}

export function useOntoCodeSandboxAttempts(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeSandboxAttempt>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.sandboxAttempts(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeSandboxAttempt>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/sandbox-attempts?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (attempt) =>
          attempt.status === "queued" || attempt.status === "running",
      )
        ? 2_000
        : false,
    staleTime: 1_000,
  });
}

export function useOntoCodeHarnessJobs(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeHarnessJob>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.jobs(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeHarnessJob>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/harness-jobs?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    refetchInterval: 4_000,
  });
}

export function useOntoCodeCommands(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeCommand>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeCommand>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/commands?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeChangeSets(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeChangeSet>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.changeSets(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeChangeSet>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/changesets?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeChangeSet(
  tenant: string,
  sessionId: string,
  changeSetId: string,
): UseQueryResult<ChangeSetGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.changeSet(tenant, sessionId, changeSetId),
    queryFn: () =>
      callV1<ChangeSetGetReceipt>(
        tenant,
        `/v1/ontocode/changesets/${encodeURIComponent(changeSetId)}`,
      ),
    enabled: Boolean(tenant && sessionId && changeSetId),
    staleTime: 2_500,
  });
}

export function useOntoCodeArtifacts(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeArtifactSummaryItem>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.artifacts(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeArtifactSummaryItem>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/artifacts?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeArtifactVersions(
  tenant: string,
  sessionId: string,
  artifactId: string,
): UseQueryResult<Page<OntoCodeArtifactVersion>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.artifactVersions(tenant, sessionId, artifactId),
    queryFn: () =>
      callV1<Page<OntoCodeArtifactVersion>>(
        tenant,
        `/v1/ontocode/artifacts/${encodeURIComponent(artifactId)}/versions?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId && artifactId),
    staleTime: 1_000,
  });
}

export function fetchOntoCodeArtifactVersionContent(
  tenant: string,
  versionId: string,
): Promise<OntoCodeArtifactVersionContentReceipt> {
  return callV1<OntoCodeArtifactVersionContentReceipt>(
    tenant,
    `/v1/ontocode/artifact-versions/${encodeURIComponent(versionId)}`,
  );
}

/**
 * Loads immutable version content on demand. A content-addressed version
 * cannot change, so React Query can safely retain the successful response.
 */
export function useLoadOntoCodeArtifactVersionContent(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      client.fetchQuery({
        queryKey: ONTOCODE_KEYS.artifactVersionContent(tenant, versionId),
        queryFn: () => fetchOntoCodeArtifactVersionContent(tenant, versionId),
        staleTime: Number.POSITIVE_INFINITY,
      }),
  });
}

export function useOntoCodeEvidence(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeEvidenceRecord>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.evidence(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeEvidenceRecord>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/evidence?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeConfigurationTask(
  tenant: string,
  taskId: string,
): UseQueryResult<OntoCodeConfigurationTaskGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.configurationTask(tenant, taskId),
    queryFn: () =>
      callV1<OntoCodeConfigurationTaskGetReceipt>(
        tenant,
        `/v1/ontocode/configuration-tasks/${encodeURIComponent(taskId)}`,
      ),
    enabled: Boolean(tenant && taskId),
    staleTime: 1_000,
  });
}

export function useCreateOntoCodeConfigurationTask(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeConfigurationTaskRequest) =>
      callV1<OntoCodeConfigurationTaskCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/configuration-tasks`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key":
              input.idempotencyKey?.trim() ||
              idempotencyKey("configuration-create"),
          },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (receipt) => {
      void client.setQueryData(
        ONTOCODE_KEYS.configurationTask(tenant, receipt.task.id),
        {
          task: receipt.task,
        } satisfies OntoCodeConfigurationTaskGetReceipt,
      );
      for (const queryKey of [
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
        ONTOCODE_KEYS.messages(tenant, sessionId),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useVerifyOntoCodeConfigurationTask(
  tenant: string,
  taskId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (expectedRevision?: number) => {
      const latest = await callV1<OntoCodeConfigurationTaskGetReceipt>(
        tenant,
        `/v1/ontocode/configuration-tasks/${encodeURIComponent(taskId)}`,
      );
      return callV1<OntoCodeConfigurationTaskVerifyReceipt>(
        tenant,
        `/v1/ontocode/configuration-tasks/${encodeURIComponent(taskId)}/verify`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey("configuration-verify"),
          },
          body: JSON.stringify({
            expectedRevision: expectedRevision ?? latest.task.revision,
          }),
        },
      );
    },
    onSuccess: (receipt) => {
      void client.setQueryData(
        ONTOCODE_KEYS.configurationTask(tenant, taskId),
        {
          task: receipt.task,
        } satisfies OntoCodeConfigurationTaskGetReceipt,
      );
      for (const queryKey of [
        ONTOCODE_KEYS.session(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.sessions(tenant),
        ONTOCODE_KEYS.messages(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.commands(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.jobs(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.artifacts(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.evidence(tenant, receipt.task.sessionId),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useCreateOntoCodeProject(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeProjectRequest) =>
      callV1<ProjectCreateReceipt>(tenant, "/v1/ontocode/projects", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ONTOCODE_KEYS.projects(tenant) }),
  });
}

export function useCreateOntoCodeSession(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeSessionRequest) =>
      callV1<SessionCreateReceipt>(tenant, "/v1/ontocode/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ONTOCODE_KEYS.sessions(tenant) }),
  });
}

/**
 * Opens a newly-created Session with its first real turn.
 *
 * Two paths, chosen by `bootstrapRouteFor` — never by inspecting the goal text:
 *
 * - **Explicit scope** (the advanced workspace's scope picker): the FDE already
 *   chose what to generate, so the three writes stay in one mutation and the UI
 *   stays honest — the Session is not presented as "running" until its user
 *   goal, auditable Command, and durable Harness Job all exist.
 * - **Free-text goal** (the v10 create panel sends only a sentence): the goal
 *   goes to the conversational planner, which is the single authority for
 *   routing free text to an action. It persists the user message itself, so
 *   the goal is deliberately NOT also posted to `/messages`.
 */
export function useBootstrapOntoCodeSession(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: BootstrapOntoCodeSessionInput,
    ): Promise<BootstrapOntoCodeSessionReceipt> => {
      if (bootstrapRouteFor(input) === "planner") {
        // Stable, session-derived key: a retried bootstrap attaches to the same
        // Assistant Run instead of minting a second goal turn. Kept distinct
        // from the legacy `session-goal-` message key because the two paths
        // persist different message envelopes under a unique
        // (session, idempotency_key) index.
        const turn = await callV1<OntoCodeTurnReceipt>(
          tenant,
          `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/assistant-turns`,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": `session-goal-turn-${input.sessionId}`,
            },
            body: JSON.stringify({ text: input.goal, contextRefs: [] }),
          },
        );
        // command/job are null for an explain/clarify answer. Passed through
        // as-is: inventing a Job here would be the same lie the hardcoded
        // scope path told.
        return {
          message: turn.userMessage,
          command: turn.command,
          job: turn.job,
          sessionRevision: turn.sessionRevision,
        };
      }

      const messageKey = `session-goal-${input.sessionId}`;
      const commandKey = `initial-scope-command-${input.sessionId}`;
      const jobKey = `initial-scope-job-${input.sessionId}`;
      const messageReceipt = await callV1<MessagePostReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": messageKey,
          },
          body: JSON.stringify({ text: input.goal }),
        },
      );
      const existingCommands = await callV1<Page<OntoCodeCommand>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/commands?limit=200`,
      );
      const attachedCommand = existingCommands.items.find(
        (command) => command.idempotencyKey === commandKey,
      );
      const commandReceipt = attachedCommand
        ? {
            command: attachedCommand,
            sessionRevision: (
              await callV1<SessionGetReceipt>(
                tenant,
                `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}`,
              )
            ).session.revision,
            mode: "attached" as const,
          }
        : await callV1<CommandCreateReceipt>(
            tenant,
            `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/commands`,
            {
              method: "POST",
              headers: {
                "Idempotency-Key": commandKey,
              },
              body: JSON.stringify({
                type: "analyze_scope",
                arguments: {
                  messageId: messageReceipt.message.id,
                  scenario: input.goal,
                  scopeMode: input.scopeMode ?? "scenario",
                  actionIds: input.actionIds ?? [],
                  source: "ontocode-session-create",
                },
                expectedSessionRevision: messageReceipt.sessionRevision,
                affectedSemanticPaths: (input.actionIds ?? []).map(
                  (actionId) => `actions.${actionId}`,
                ),
                riskClass: "read_only",
                requestedCapabilities: [],
                requiresHuman: false,
                rationaleSummary:
                  "读取租户已绑定的权威 Ontology，固定本 Session 的生成范围与不可变基线。",
              }),
            },
          );
      const existingJobs = await callV1<Page<OntoCodeHarnessJob>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/harness-jobs?limit=100`,
      );
      const attachedJob = existingJobs.items.find(
        (job) => job.idempotencyKey === jobKey,
      );
      const jobReceipt = attachedJob
        ? {
            job: attachedJob,
            sessionRevision: commandReceipt.sessionRevision,
            mode: "attached" as const,
          }
        : await callV1<HarnessJobCreateReceipt>(
            tenant,
            `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/harness-jobs`,
            {
              method: "POST",
              headers: {
                "Idempotency-Key": jobKey,
              },
              body: JSON.stringify({
                commandId: commandReceipt.command.id,
                kind: "scope",
                expectedSessionRevision: commandReceipt.sessionRevision,
                budget: {
                  maxWallClockMs: 300_000,
                  maxModelCalls: 8,
                  maxToolCalls: 16,
                },
              }),
            },
          );
      return {
        message: messageReceipt.message,
        command: commandReceipt.command,
        job: jobReceipt.job,
        sessionRevision: jobReceipt.sessionRevision,
      };
    },
    onSuccess: (_receipt, input) => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, input.sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.messages(tenant, input.sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.commands(tenant, input.sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.jobs(tenant, input.sessionId),
      });
      // The planner path opens the Session with an Assistant Run; without this
      // the first assistant reply would not surface until the next poll.
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.assistantRuns(tenant, input.sessionId),
      });
    },
  });
}

export function useUpdateOntoCodeSession(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOntoCodeSessionRequest) =>
      callV1<SessionUpdateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

export function useCloseOntoCodeSession(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CloseOntoCodeSessionRequest) =>
      callV1<OntoCodeSessionCloseReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/close`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("session-close") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

export function usePostOntoCodeMessage(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PostOntoCodeMessageRequest) =>
      callV1<MessagePostReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("message") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.messages(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

/**
 * Sends one durable conversational turn. The API owns command policy, risk,
 * approval, budget, and Message/Command/Job atomicity; the browser only
 * provides a conservative intent classification and renders the receipt.
 */
export function useSendOntoCodeTurn(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PostOntoCodeTurnRequest) =>
      callV1<OntoCodeTurnReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("turn") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.messages(tenant, sessionId),
        ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
        ONTOCODE_KEYS.commands(tenant, sessionId),
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.candidateHead(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * Canonical free-form chat entry. The browser sends only the user's text and
 * visible context refs; the server-side assistant plans the turn and the
 * existing policy atomically commits its Message/Command/Harness effects.
 */
export function useSendOntoCodeAssistantTurn(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SendOntoCodeAssistantTurnInput) =>
      callV1<OntoCodeTurnReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/assistant-turns`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey("assistant-turn"),
          },
          body: JSON.stringify({
            text: input.text,
            contextRefs: input.contextRefs ?? [],
          }),
        },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.messages(tenant, sessionId),
        ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
        ONTOCODE_KEYS.commands(tenant, sessionId),
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.candidateHead(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useCreateOntoCodeCommand(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeCommandRequest) =>
      callV1<CommandCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/commands`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("command") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
    },
  });
}

export function useDecideOntoCodeCommand(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      commandId: string;
      decision: "approve" | "reject";
      request: DecideOntoCodeCommandRequest;
    }) =>
      callV1<CommandDecisionReceipt>(
        tenant,
        `/v1/ontocode/commands/${encodeURIComponent(input.commandId)}/${input.decision}`,
        {
          method: "POST",
          body: JSON.stringify(input.request),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

export function useCreateOntoCodeHarnessJob(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeHarnessJobRequest) =>
      callV1<HarnessJobCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/harness-jobs`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("job") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.jobs(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
    },
  });
}

function invalidateOntoCodeWorkspaceProjection(
  client: ReturnType<typeof useQueryClient>,
  tenant: string,
  sessionId: string,
): void {
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.sessions(tenant),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.changeSets(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.artifacts(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.evidence(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.candidateHead(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.sandboxAttempts(tenant, sessionId),
  });
}

/**
 * Applies full-content edits against the exact Candidate Head in one server
 * transaction. The API revalidates Session revision, Head revision, Package
 * dependency root, Artifact Version id, and blob hash before writing anything.
 */
export function useCommitOntoCodeWorkspacePatch(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CommitOntoCodeWorkspacePatchRequest) =>
      callV1<OntoCodeWorkspacePatchCommitReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/workspace-patches`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key":
              input.idempotencyKey ?? idempotencyKey("workspace-patch"),
          },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (receipt) => {
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId);
      void client.setQueryData(ONTOCODE_KEYS.candidateHead(tenant, sessionId), {
        head: receipt.head,
        packageVersion: receipt.packageVersion,
      } satisfies CandidateHeadGetReceipt);
      for (const version of receipt.versions) {
        void client.invalidateQueries({
          queryKey: ONTOCODE_KEYS.artifactVersions(
            tenant,
            sessionId,
            version.artifactId,
          ),
        });
      }
    },
  });
}

export function useCreateOntoCodeChangeSet(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeChangeSetRequest) =>
      callV1<ChangeSetCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/changesets`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("changeset") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () =>
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId),
  });
}

export function useCommitOntoCodeChangeSet(
  tenant: string,
  sessionId: string,
  changeSetId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CommitOntoCodeChangeSetRequest) =>
      callV1<ChangeSetCommitReceipt>(
        tenant,
        `/v1/ontocode/changesets/${encodeURIComponent(changeSetId)}/commit`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId);
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.changeSet(tenant, sessionId, changeSetId),
      });
    },
  });
}

export function useCreateOntoCodeArtifact(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeArtifactRequest) =>
      callV1<ArtifactCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/artifacts`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("artifact") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () =>
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId),
  });
}

export function useCreateOntoCodeArtifactVersion(
  tenant: string,
  sessionId: string,
  artifactId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeArtifactVersionRequest) =>
      callV1<ArtifactCreateReceipt>(
        tenant,
        `/v1/ontocode/artifacts/${encodeURIComponent(artifactId)}/versions`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("artifact-version") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId);
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.artifactVersions(tenant, sessionId, artifactId),
      });
    },
  });
}

export function useCreateOntoCodeEvidence(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeEvidenceRecordRequest) =>
      callV1<EvidenceCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/evidence`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("evidence") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () =>
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId),
  });
}
