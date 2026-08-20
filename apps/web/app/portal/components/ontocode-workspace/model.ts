import type {
  CommitOntoCodeWorkspacePatchRequest,
  OntoCodeAutonomyMode,
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeWorkspacePatchCommitReceipt,
} from "@agentic/contracts";
import type { IconName } from "@/app/portal/components/Icon";

export const WORKSPACE_PHASES = [
  "scope",
  "blueprint",
  "build",
  "tests",
  "debug",
  "review",
  "release",
] as const;

export type WorkspacePhase = (typeof WORKSPACE_PHASES)[number];
export type WorkspaceMode = "conversation" | "balanced" | "artifacts";
export type ArtifactView = "map" | "changes" | "tests" | "evidence";
export type SessionStatus =
  | "needs_action"
  | "running"
  | "ready"
  | "released"
  | "paused";
export type StepStatus = "complete" | "running" | "blocked" | "queued";

export interface WorkspaceSession {
  id: string;
  title: string;
  /** Business Domain identity. It is deliberately separate from Ontology. */
  tenantSlug?: string;
  tenantName?: string;
  domain: string;
  /** Authoritative transport for this Session's current exact binding. */
  ontologySource?: "allmeta" | "upload" | "historical" | "unknown";
  ontology: string;
  phase: WorkspacePhase;
  status: SessionStatus;
  statusLabel: string;
  updatedLabel: string;
  owner: string;
  progress: number;
  agents: number;
  testSummary: string;
  goal: string;
}

export interface CreateWorkspaceSessionInput {
  title: string;
  goal: string;
  autonomyMode: OntoCodeAutonomyMode;
  /** Stable registration selected from the current Business Domain registry. */
  ontologyDomainRegistrationId: string;
  domain: string;
  /**
   * Describes the FDE's intended build boundary. The backend can persist this
   * as session intake metadata without guessing scope from the session title.
   */
  scopeMode?: WorkspaceSessionScopeMode;
  /**
   * Only populated for `selected_actions`; every id must come from the
   * selected Business Domain registration's exact Ontology inventory.
   */
  actionIds?: string[];
}

export type WorkspaceSessionScopeMode =
  | "full_domain"
  | "scenario"
  | "selected_actions";

export interface WorkspaceTenantIdentity {
  id: string;
  name: string;
  slug?: string;
}

export interface WorkspaceBoundOntology {
  /** Stable tenant-scoped registry identity, not the remote Domain id. */
  registrationId: string;
  id: string;
  name: string;
  source?: string | null;
  isDefault?: boolean;
  /** Exact immutable adapter version pinned by this registration. */
  runtimeProfileVersionId?: string | null;
  runtimeProfileLabel?: string | null;
  /**
   * Undefined only for older embedded/test callers. The connected product
   * always projects the server's fail-closed execution readiness.
   */
  runtimeExecutable?: boolean;
  runtimeReadinessState?: string | null;
  runtimeReadinessMessage?: string | null;
  counts?: {
    actions?: number;
    events?: number;
    objects?: number;
    rules?: number;
  };
}

export interface WorkspaceBoundAction {
  id: string;
  name: string;
  description?: string | null;
  actors?: string[];
}

export interface WorkspaceHubReadiness {
  bindingState?: "loading" | "ready" | "missing" | "error";
  gatewayConfigured: boolean;
  gatewayLabel?: string | null;
  configurationState?: "ready" | "checked_in_session" | "blocked";
  configurationLabel?: string | null;
  ontologySettingsHref?: string;
  gatewaySettingsHref?: string;
  configurationHref?: string;
  runtimeProfileSettingsHref?: string;
}

export interface WorkspaceSessionCreationContext {
  tenant: WorkspaceTenantIdentity | null;
  ontology: WorkspaceBoundOntology | null;
  actions: WorkspaceBoundAction[];
  readiness: WorkspaceHubReadiness;
  hasCreateHandler: boolean;
}

export interface WorkspaceSessionBindingAccess {
  verificationState: "loading" | "ready" | "error";
  projectRegistrationId: string | null;
  activeRegistrationId: string | null;
  projectDomain?: string | null;
}

/**
 * A Build Session is writable while its exact tenant-scoped Ontology Domain
 * registration remains active. Changing the Business Domain's default
 * Ontology must not make another registered Domain's Sessions read-only.
 */
export function workspaceSessionReadOnlyReason(
  access: WorkspaceSessionBindingAccess,
): string | null {
  if (access.verificationState === "loading") {
    return "正在核验该 Session 的 Project 与当前权威 Ontology 绑定；核验完成前暂停所有写操作。";
  }
  if (access.verificationState === "error") {
    return "当前无法核验权威 Ontology 绑定。为避免写入错误语义链路，本 Session 暂时只读。";
  }
  if (!access.projectRegistrationId) {
    return "无法确认该 Session 所属 Project 的 Ontology Domain 注册身份；在身份恢复前，本 Session 只读。";
  }
  if (!access.activeRegistrationId) {
    return `该 Session 所属的 Ontology Domain${access.projectDomain ? `（${access.projectDomain}）` : ""}已归档、不可用或不属于当前 Business Domain。历史数据仍可审计，但不能继续执行。`;
  }
  if (access.activeRegistrationId !== access.projectRegistrationId) {
    return "该 Session 的 Project 与当前核验到的 Ontology Domain 注册身份不一致。为避免跨 Ontology 语义写入，消息、Command、Harness 与工件操作均已禁用。";
  }
  return null;
}

export function workspaceSessionCreationBlockers(
  context: WorkspaceSessionCreationContext,
): string[] {
  const blockers: string[] = [];
  if (!context.tenant) {
    blockers.push(
      "无法确认当前 Business Domain，请从 Business Domain 工作区重新进入 OntoCode。",
    );
  }
  if (context.readiness.bindingState === "loading") {
    blockers.push("正在读取当前 Business Domain 的 Ontology Domain 注册表。");
  } else if (context.readiness.bindingState === "error") {
    blockers.push("Ontology Domain 注册表读取失败，请先恢复 Ontology 服务。");
  } else if (!context.ontology) {
    blockers.push(
      "当前 Business Domain 尚未注册可用的 Ontology Domain，请先完成注册。",
    );
  } else if (
    context.ontology.source !== "allmeta" &&
    context.ontology.source !== "upload"
  ) {
    blockers.push(
      "当前 Ontology Domain 来自旧版推断关系；请在 Business Domain 管理中显式注册 Allmeta Domain，或显式上传 Ontology。",
    );
  } else if (context.ontology.runtimeExecutable === false) {
    blockers.push(
      context.ontology.runtimeReadinessMessage ||
        "当前 Ontology Domain 尚未绑定可执行的 Runtime Profile；完成精确 adapter 配置后才能创建真实 Build Session。",
    );
  }
  if (!context.readiness.gatewayConfigured) {
    blockers.push("LLM Gateway 尚未配置，完成模型连接后才能启动 Harness。");
  }
  if (!context.hasCreateHandler) {
    blockers.push("Build Session API 尚未连接，当前页面不能创建真实 Session。");
  }
  return blockers;
}

export function workspaceScopeGoal(
  mode: WorkspaceSessionScopeMode,
  ontology: WorkspaceBoundOntology | null,
  selectedActions: WorkspaceBoundAction[],
  language: "en" | "zh" = "zh",
): string {
  const ontologyName = ontology?.name.trim();
  if (!ontologyName) return "";

  if (mode === "full_domain") {
    return language === "en"
      ? `Analyze Agent boundaries across all executable Actions in ${ontologyName}, then generate testable and reviewable Agent Packages.`
      : `基于 ${ontologyName} 的全部可执行 Actions，分析 Agent 边界并生成可测试、可审查的 Agent Packages。`;
  }
  if (mode === "selected_actions" && selectedActions.length > 0) {
    const actionNames = selectedActions.map((action) => action.name);
    return language === "en"
      ? `Generate Agent Packages for the selected Actions in ${ontologyName} (${actionNames.join(", ")}), then complete Harness validation.`
      : `基于 ${ontologyName} 中已选择的 Actions（${actionNames.join("、")}），生成对应的 Agent Packages 并完成 Harness 验证。`;
  }
  return "";
}

export interface ConversationMessage {
  id: string;
  actor: "user" | "assistant";
  /**
   * Distinguishes persisted assistant, tool and system output without changing
   * the conversational left/right alignment. Omitted values are normal chat.
   */
  source?: "assistant" | "tool" | "system";
  /**
   * `failed` is only used when the real assistant request failed. The UI never
   * infers success from local timing; persisted messages default to complete.
   */
  status?: "complete" | "failed";
  name: string;
  time: string;
  body: string;
  receipt?: string;
  recommendations?: ConversationRecommendation[];
}

export interface ConversationRecommendation {
  id: string;
  kind:
    | "configuration"
    | "decision"
    | "execution"
    | "inspection"
    | "navigation";
  title: string;
  reason: string;
  impact?: string;
  recommended?: boolean;
  action?: WorkspaceGuidanceAction;
}

/**
 * A safe, client-side view instruction returned by the conversational
 * controller. It may focus persisted facts, but it never mutates those facts.
 * All semantic changes still travel through Message → Command → Harness Job.
 */
export interface WorkspaceDirective {
  /** Persisted provenance from `workspace.directive.emitted`. */
  id: string;
  sessionId: string;
  sourceMessageId: string;
  eventSeq: number;
  behavior: "navigate" | "explain" | "clarify" | "execute";
  phase?: WorkspacePhase;
  artifactView?: ArtifactView;
  artifactId?: string;
  mode?: WorkspaceMode;
  harnessExpanded?: boolean;
  focus?: "chat" | "workspace" | "harness";
  notice?: string;
}

export interface SendWorkspaceMessageResult {
  message?: ConversationMessage;
  directive?: WorkspaceDirective;
}

export interface HarnessStep {
  id: string;
  order: number;
  title: string;
  detail: string;
  time: string;
  status: StepStatus;
}

export interface WorkspacePrimaryAction {
  type:
    | "configure"
    | "open_configuration_task"
    | "confirm_configuration"
    | "execute_recommendation"
    | "navigate_recommendation"
    | "reply_recommendation"
    | "adjust_plan"
    | "continue_ready_actions"
    | "confirm_manual_boundary"
    | "run_tests"
    | "apply_patch"
    | "prepare_release"
    | "deploy"
    | "approve_command"
    | "reject_command"
    | "pause_harness"
    | "resume_harness";
  sessionId: string;
  phase: WorkspacePhase;
  payload?: Record<string, unknown>;
}

export interface ArtifactNode {
  id: string;
  title: string;
  subtitle: string;
  version?: string;
  status: "complete" | "running" | "blocked" | "queued";
  icon: IconName;
  meta?: string;
}

export interface ArtifactLane {
  id: string;
  title: string;
  subtitle: string;
  nodes: ArtifactNode[];
}

export interface SelectedArtifact {
  id: string;
  title: string;
  version: string;
  /** Exact immutable version selected in the live artifact map. */
  versionId?: string;
  contentType?: string;
  blobHash?: string;
  sizeBytes?: number;
  source: string;
  contract: string;
  tests: string;
  blockedBy?: string;
  /**
   * Present only when this exact immutable Artifact Version is a member of the
   * exact Candidate Head returned by the backend. The editor must never infer
   * these CAS values from "latest" UI state.
   */
  candidatePatchContext?: WorkspaceArtifactPatchContext;
  /** Truthful reason why this version cannot enter Workspace edit mode. */
  editBlockedReason?: string;
}

export interface WorkspaceArtifactPatchContext {
  expectedSessionRevision: number;
  expectedCandidateHeadRevision: number;
  basePackageVersionId: string;
  baseDependencyRoot: string;
}

export type SaveWorkspaceArtifactPatch = (
  input: CommitOntoCodeWorkspacePatchRequest,
) => Promise<OntoCodeWorkspacePatchCommitReceipt>;

/**
 * Content-addressed payload returned by the artifact-version endpoint.
 * OntoCode renders it read-only; changes go through chat and Harness.
 */
export interface WorkspaceArtifactVersionContent {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  content: string;
}

export interface WorkspaceContextOption {
  value: string;
  label?: string;
}

export interface WorkspaceContextField {
  value: string;
  options?: WorkspaceContextOption[];
}

export interface WorkspaceActivity {
  label: string;
  detail: string;
  tone?: "neutral" | "running" | "warning" | "success";
  icon?: IconName;
}

export interface WorkspaceContextBar {
  domain?: WorkspaceContextField;
  project?: WorkspaceContextField;
  session?: WorkspaceContextField;
  ontologySnapshot?: WorkspaceContextField;
  changeSet?: WorkspaceContextField;
  environment?: WorkspaceContextField;
  autonomy?: WorkspaceContextField;
  activity?: WorkspaceActivity;
}

export interface WorkspaceGuidanceAction {
  label: string;
  type: WorkspacePrimaryAction["type"];
  payload?: Record<string, unknown>;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}

export interface WorkspaceGuidanceItem {
  id: string;
  title: string;
  detail: string;
  statusLabel?: string;
  status?: "ready" | "blocked" | "configuration" | "decision" | "running";
  actions?: WorkspaceGuidanceAction[];
}

export interface WorkspaceGuidance {
  id: string;
  title: string;
  statusLabel: string;
  status?: "attention" | "resolved" | "informational";
  reason?: string;
  impact?: string;
  recommendation?: string;
  items?: WorkspaceGuidanceItem[];
  actions?: WorkspaceGuidanceAction[];
}

export interface WorkspaceReceipt {
  id: string;
  label: string;
  status?: "complete" | "running" | "warning" | "neutral";
  icon?: IconName;
}

export interface WorkspaceChangeRow {
  id: string;
  operation: string;
  target: string;
  summary: string;
  status: "ready" | "blocked" | "applied" | "pending";
  statusLabel?: string;
}

export interface WorkspaceChangeSetView {
  title: string;
  subtitle: string;
  rows: WorkspaceChangeRow[];
  emptyLabel?: string;
}

export interface WorkspaceTestMetric {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}

export interface WorkspaceTestSuite {
  id: string;
  name: string;
  total: string | number;
  passed: string | number;
  failed: string | number;
  blocked: string | number;
}

export interface WorkspaceSandboxReceiptSummary {
  id: "registration" | "execution" | "test" | "drain" | "cleanup";
  label: string;
  detail: string;
  status: "recorded" | "missing";
}

export interface WorkspaceSandboxAttemptView {
  id: string;
  ordinal: number;
  packageVersionId: string;
  dependencyRoot: string;
  testSuiteHash: string;
  status: string;
  qualification: "development_only" | "promotable";
  executionOrigin: "local" | "remote" | null;
  isolationTier: string | null;
  candidateFingerprint: string;
  bundleHash: string | null;
  errorMessage?: string | null;
  receipts: WorkspaceSandboxReceiptSummary[];
}

export interface WorkspaceTestView {
  title: string;
  subtitle: string;
  metrics: WorkspaceTestMetric[];
  suites: WorkspaceTestSuite[];
  sandboxAttempts?: WorkspaceSandboxAttemptView[];
  allowRun?: boolean;
  allowDebug?: boolean;
}

export interface WorkspaceEvidenceItem {
  id: string;
  title: string;
  detail: string;
  status: "complete" | "warning" | "pending";
  icon?: IconName;
}

export interface WorkspaceReleaseGate {
  label: string;
  title: string;
  detail: string;
  status?: "ready" | "conditional" | "complete" | "pending";
  action?: WorkspaceGuidanceAction;
}

export interface WorkspaceEvidenceView {
  title: string;
  subtitle: string;
  items: WorkspaceEvidenceItem[];
  sandboxAttempts?: WorkspaceSandboxAttemptView[];
  gate?: WorkspaceReleaseGate;
}

export interface WorkspaceMapOrigin {
  title: string;
  slug: string;
  icon?: IconName;
}

export interface WorkspacePhaseSummary {
  title: string;
  description: string;
  statusLabel?: string;
  tone?: "neutral" | "success" | "warning";
}

/** Durable control-plane state projected into the conversational workspace. */
export interface WorkspaceProjection {
  context?: WorkspaceContextBar;
  contextRefs?: string[];
  /**
   * Persisted workflow milestones only. This is deliberately separate from
   * the locally selected workspace view so browsing a future phase cannot
   * manufacture green completion states.
   */
  completedPhases?: WorkspacePhase[];
  guidance?: WorkspaceGuidance | null;
  receipts?: WorkspaceReceipt[];
  tabCounts?: Partial<Record<ArtifactView, number | string | null>>;
  changeSet?: WorkspaceChangeSetView | null;
  testRun?: {
    ready: boolean;
    blocker?: string;
  };
  tests?: WorkspaceTestView | null;
  evidence?: WorkspaceEvidenceView | null;
  selectedArtifact?: SelectedArtifact | null;
  artifactDetails?: Record<string, SelectedArtifact>;
  mapOrigin?: WorkspaceMapOrigin;
  phaseSummaries?: Partial<Record<WorkspacePhase, WorkspacePhaseSummary>>;
  artifactTitle?: string;
  artifactSubtitle?: string;
}

export const PHASE_LABELS: Record<WorkspacePhase, string> = {
  scope: "Scope",
  blueprint: "Blueprint",
  build: "Build",
  tests: "Tests",
  debug: "Debug",
  review: "Review",
  release: "Release",
};

export const PHASE_ICONS: Record<WorkspacePhase, IconName> = {
  scope: "workflow",
  blueprint: "task",
  build: "deploy",
  tests: "task",
  debug: "code",
  review: "logs",
  release: "deploy",
};

export const SESSION_STATUS_ICONS: Record<SessionStatus, IconName> = {
  needs_action: "alert",
  running: "replay",
  ready: "check",
  released: "deploy",
  paused: "pause",
};

export function phaseIndex(phase: WorkspacePhase): number {
  return WORKSPACE_PHASES.indexOf(phase);
}

export function phaseProgress(phase: WorkspacePhase): number {
  return Math.round(((phaseIndex(phase) + 1) / WORKSPACE_PHASES.length) * 100);
}

export function nextPhase(phase: WorkspacePhase): WorkspacePhase {
  const index = phaseIndex(phase);
  return WORKSPACE_PHASES[Math.min(index + 1, WORKSPACE_PHASES.length - 1)]!;
}

export function defaultArtifactView(phase: WorkspacePhase): ArtifactView {
  if (phase === "tests") return "tests";
  if (phase === "review" || phase === "release") return "evidence";
  return "map";
}

export function harnessStatusLabel(status: StepStatus): string {
  switch (status) {
    case "complete":
      return "已完成";
    case "running":
      return "运行中";
    case "blocked":
      return "需要处理";
    case "queued":
      return "等待中";
  }
}

export function commandReply(
  phase: WorkspacePhase,
  command: string,
): Pick<ConversationMessage, "body" | "receipt"> {
  const compact = command.trim();
  const prefix = compact ? `我已收到：“${compact}”。` : "我已收到你的指令。";
  const guidance: Record<WorkspacePhase, string> = {
    scope:
      "我会先对照固定的 Ontology snapshot 分析边界、缺失事实和需要 FDE 确认的假设，再生成可审查的 Scope Change Set。",
    blueprint:
      "我会把 Ontology Actions 编译为 Agent 边界、事件契约和工具需求，并标出跨系统写操作与人工审批点。",
    build:
      "我会基于当前 Change Set 生成 Agent Package，调用 Harness 做静态检查、契约验证和 Sandbox 测试；任何外部写入都不会直接执行。",
    tests:
      "我会补齐单元、契约、模拟和回归测试，并把失败项关联回 Agent、Ontology rule 与工具配置。",
    debug:
      "我会从失败证据推导最小修复补丁，先在分支中验证，再请你决定是否合入候选版本。",
    review:
      "我会汇总变更、风险、测试覆盖和授权证据，生成面向上线审批的 Release Gate 摘要。",
    release:
      "我会准备不可变 Release Candidate，并在你明确批准后才向 Agentic Operator 部署和执行 Smoke Test。",
  };

  return {
    body: `${prefix}${guidance[phase]}`,
    receipt: `计划已记录 · ${PHASE_LABELS[phase]} · 不包含未授权副作用`,
  };
}
