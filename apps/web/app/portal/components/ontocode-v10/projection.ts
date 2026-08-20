// OntoCode v10 · 投影层：把服务端记录投影成「人话」视图模型。
// 词汇白名单在此层强制——内部对象名词（裸 id、存储语义、状态机词）不得进入任何 label/sub/title 字段。
import { ONTOCODE_COMMAND_POLICY } from "@agentic/contracts";
import type {
  OntoCodeBuildSession,
  OntoCodeConfigurationTask,
  OntoCodeHarnessJob,
  OntoCodeHarnessJobKind,
  OntoCodeMessage,
  OntoCodeSessionEvent,
  OntoCodeCommand,
} from "@agentic/contracts";
import { productFacingOntoCodeText } from "./product-vocabulary";
import {
  parseAssistantCitations,
  type AssistantCitation,
} from "./citations";

/** 任何投影输出的用户可见字段都不允许命中这个表达式（测试守卫）。 */
export const FORBIDDEN_VOCABULARY =
  /(ocj-|ocav-|oca-|occ-|OCS-[0-9A-F]|dependencyRoot|blobHash|Candidate Package|Change Set|CAS\b|activityState|needs_user|failed_recoverable|failed_terminal|retry_scheduled|awaiting_approval|superseded|review_required|waiting_user)/;

export type SessionTone = "ok" | "warn" | "run" | "idle" | "bad";

export interface SessionRowVM {
  id: string;
  title: string;
  tone: SessionTone;
  label: string;
  sub: string;
  needsAttention: number;
  updatedAt: number;
}

export interface SessionRowFacts {
  latestQuestion?: string;
  runningJobKind?: OntoCodeHarnessJobKind;
  overview?: { agents: number; ready: number; blocked: number };
  openConfigCount?: number;
}

const JOB_KIND_VERB: Record<string, string> = {
  scope: "正在分析范围",
  blueprint: "正在生成蓝图",
  build: "正在生成代码",
  simulation: "正在推演",
  test: "正在验证",
  debug: "正在定位修复",
  regression: "正在回归对比",
  promotion: "正在准备上线",
  deploy: "正在部署",
  production_analysis: "正在分析线上运行",
};

const JOB_KIND_DONE: Record<string, string> = {
  scope: "范围分析",
  blueprint: "蓝图",
  build: "代码生成",
  simulation: "推演",
  test: "验证",
  debug: "修复",
  regression: "回归对比",
  promotion: "上线准备",
  deploy: "部署",
  production_analysis: "线上分析",
};

function truncate(text: string, max = 42): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 引擎内部称谓不出现在用户可见文本（Agent Factory 等一律剥掉）。 */
function stripEnginePrefix(text: string): string {
  return text.replace(/^Agent Factory 需要你的回答[:：]\s*/u, "").trim();
}

/**
 * Action-card copy can come from immutable historical rows. Keep submitted
 * values and typed recommendation actions byte-for-byte intact, but project
 * every display-only string through the OntoCode product vocabulary.
 */
function productFacingCardText(text: string): string {
  return productFacingOntoCodeText(stripEnginePrefix(text));
}

/** 服务端英文只读提示 → 人话，并暴露检测器给容器（出路=用活跃域新建）。 */
const REGISTRATION_RETIRED_EN =
  /read-only because its exact Ontology Domain registration is no longer active/i;

export function isRegistrationRetiredMessage(text: string): boolean {
  return REGISTRATION_RETIRED_EN.test(text);
}

export const REGISTRATION_RETIRED_ZH =
  "该会话绑定的本体注册项已被停用，为保证快照与证据一致，会话已转为只读。历史产物仍可查看；要继续这项工作，请用当前活跃的域新建一个会话。";

/** 同一事实的短形态——用于 placeholder 等寸土空间；消息正文仍用完整版。 */
export const REGISTRATION_RETIRED_SHORT_ZH = "已只读——注册项已停用";

function humanizeAssistantText(text: string): string {
  if (isRegistrationRetiredMessage(text)) return REGISTRATION_RETIRED_ZH;
  return productFacingOntoCodeText(text);
}

export function projectSessionRow(
  session: OntoCodeBuildSession,
  facts: SessionRowFacts = {},
): SessionRowVM {
  const base = {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    needsAttention: 0,
  };
  if (session.phase === "completed") {
    return { ...base, tone: "ok", label: "已完成", sub: "" };
  }
  if (session.phase === "observe") {
    return { ...base, tone: "ok", label: "已上线观察中", sub: "" };
  }
  switch (session.activityState) {
    case "needs_user": {
      const q = facts.latestQuestion
        ? truncate(productFacingCardText(facts.latestQuestion))
        : "";
      return {
        ...base,
        tone: "warn",
        label: "等你决定",
        sub: q,
        needsAttention: 1,
      };
    }
    case "blocked_external": {
      const n = facts.openConfigCount ?? 1;
      return {
        ...base,
        tone: "warn",
        label: "等外部配置",
        sub: `${n} 项待配置`,
        needsAttention: n,
      };
    }
    case "failed_recoverable":
      return {
        ...base,
        tone: "bad",
        label: "构建受阻",
        sub: "",
        needsAttention: 1,
      };
    case "review_required":
      return {
        ...base,
        tone: "warn",
        label: "等你审批",
        sub: "",
        needsAttention: 1,
      };
    case "ai_planning":
    case "queued":
    case "running": {
      const verb = facts.runningJobKind
        ? (JOB_KIND_VERB[facts.runningJobKind] ?? "进行中")
        : "进行中";
      return { ...base, tone: "run", label: "进行中", sub: verb };
    }
    case "paused":
    case "cancelled":
      return { ...base, tone: "idle", label: "已暂停", sub: "" };
    default: {
      if (facts.overview && facts.overview.agents > 0) {
        const { agents, ready, blocked } = facts.overview;
        const blockedPart = blocked > 0 ? ` · ${blocked} 待处理` : "";
        return {
          ...base,
          tone: "idle",
          label: "可继续",
          sub: `${agents} 个 agent · ${ready} 就绪${blockedPart}`,
        };
      }
      return { ...base, tone: "idle", label: "可继续", sub: "" };
    }
  }
}

/* ------------------------------ 引导流投影 ------------------------------ */

export interface CardOptionVM {
  label: string;
  value: string;
  recommended?: boolean;
}

export interface QuestionItemVM {
  id: string;
  question: string;
  context?: string;
  options: CardOptionVM[];
  allowOther?: boolean;
  /** One batch item normally corresponds to one blocked external system. */
  system?: string;
}

export type AssistantRecommendationKindVM =
  | "configuration"
  | "decision"
  | "execution"
  | "inspection"
  | "navigation";

export type AssistantRecommendationActionVM =
  | {
      type: "navigate";
      label: string;
      target: "chat" | "map" | "changes" | "tests" | "evidence" | "harness";
    }
  | {
      type: "configure";
      label: string;
      destination:
        | "integrations"
        | "system_profiles"
        | "tool_authoring"
        | "ontology_editor"
        | "environment_profiles";
      providerId?: string;
      systemName?: string;
      toolName?: string;
      toolIntent?: string;
      ontologyDomain?: string;
      waitingHarnessJobId?: string;
      sourceActionName?: string;
      sourceRequirementId?: string;
      readinessStatus?: string;
      executionSurface?: string;
      requirementKind?: string;
      requirementRole?: string;
      verificationAction?: "verify_configuration";
    }
  | {
      type: "execute";
      label: string;
      turnAction:
        | "analyze_ontology"
        | "analyze_scope"
        | "propose_blueprint"
        | "generate_package"
        | "patch_artifact"
        | "generate_tests"
        | "run_tests"
        | "debug_failure"
        | "compare_candidate";
    }
  | { type: "reply"; label: string; value: string };

export interface AssistantRecommendationVM {
  id: string;
  kind: AssistantRecommendationKindVM;
  recommended: boolean;
  sourceMessageId: string;
  /** Exact persisted user turn correlated to the assistant recommendation. */
  sourceUserMessageId?: string;
  sourceUserIntent?: string;
  blockerKey: string;
  action: AssistantRecommendationActionVM;
}

/**
 * 一张卡是谁生出来的。生命周期判定必须先知道来源——同一条落库事实对不同来源
 * 的卡意义完全不同（作业跑完 ≠ 配置任务做完）。
 */
export type ActionCardOrigin =
  | "assistant_recommendation"
  | "harness_question"
  | "configuration_task"
  | "command_approval"
  | "workspace_notice";

/**
 * 卡片的执行状态。全部从落库事实推导——没有计时器，没有乐观本地标记。
 * proposed  = 没有任何证据说这件事已经发生，按钮照常给。
 * running   = 这件事正在发生。
 * done      = 有一条明确归属于这张卡的执行，且已成功。
 * failed    = 有一条明确归属于这张卡的执行，且已失败/被取消。
 * superseded= 同类阶段在这张卡之后跑过，但无法归因到这张卡本身。
 */
export type ActionCardLifecycleState =
  | "proposed"
  | "running"
  | "done"
  | "failed"
  | "superseded";

export interface ActionCardLifecycleVM {
  state: ActionCardLifecycleState;
  /** chip 文案。proposed 不产 chip——没发生的事不占屏。 */
  label?: string;
  /**
   * 判据强度，如实标注，绝不冒充：
   * exact = 有一条落库 Command 自称由这张卡发起；
   * stage = 只知道同类阶段跑过，归因不成立；
   * job   = 这张卡指名的那个作业本身离开了等待状态。
   */
  basis?: "exact" | "stage" | "job";
}

export interface ActionCardVM {
  kind: "config" | "decision" | "authorization" | "deploy_confirm" | "system";
  /** 卡片来源。投影层在构造点写死，判定层据此选取有效证据。 */
  origin?: ActionCardOrigin;
  /** 由 deriveActionCardLifecycle 从落库事实算出，投影层最后一遍统一挂上。 */
  lifecycle?: ActionCardLifecycleVM;
  refId: string;
  title: string;
  why?: string;
  impact?: string;
  options?: CardOptionVM[];
  allowOther?: boolean;
  questionId?: string;
  configTaskId?: string;
  commandId?: string;
  jobId?: string;
  /** 该阻塞涉及的系统（无已授权工具/运行时）。 */
  systems?: string[];
  /** A batch clarification stays structured instead of becoming one Markdown blob. */
  items?: QuestionItemVM[];
  /** Assistant navigation recommendations resolve to a real inspector tab. */
  inspectorTarget?:
    | "artifacts"
    | "map"
    | "changes"
    | "tests"
    | "evidence"
    | "connections"
    | "log"
    | "reasoning";
  /** Button copy is supplied by a validated assistant recommendation. */
  primaryLabel?: string;
  /** Safe, typed action retained from the persisted assistant plan. */
  recommendation?: AssistantRecommendationVM;
  /** true = 可确认为人工边界（config 阻塞、有系统、无真实配置任务）。 */
  boundaryEligible?: boolean;
}

export type FlowItemVM =
  | { kind: "user"; id: string; text: string; at: number }
  | {
      kind: "aiText";
      id: string;
      text: string;
      /**
       * 落库消息 content.charts 里的服务端聚合图表规格（未校验原样透传，
       * 渲染处用 OntoCodeChartSpecSchema 把关——不合规就如实说未通过校验）。
       */
      charts?: unknown[];
      /**
       * #ASSISTANT-CITE —— 这条回答自称站在哪些产物上。服务端已强制校验
       * （编造引用会让整个计划被拒），这里只负责让 FDE 打得开。
       */
      citations?: AssistantCitation[];
      at: number;
    }
  | {
      kind: "execGroup";
      id: string;
      title: string;
      steps: string[];
      stageDocKind?: "analysis" | "scope" | "blueprint";
      /** The original recoverable Job id; retry must not create a replacement. */
      retryJobId?: string;
      at: number;
    }
  | { kind: "actionCard"; id: string; card: ActionCardVM; at: number }
  | { kind: "receipt"; id: string; text: string; at: number }
  | { kind: "statusLine"; id: string; text: string; at: number };

export interface FlowInput {
  session: OntoCodeBuildSession;
  messages: OntoCodeMessage[];
  jobs: OntoCodeHarnessJob[];
  events: OntoCodeSessionEvent[];
  configTasks: OntoCodeConfigurationTask[];
  commands: OntoCodeCommand[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asBoundedText(value: unknown, maxLength: number): string | null {
  const text = asText(value);
  return text && text.length <= maxLength ? text : null;
}

/**
 * Assistant recommendations are persisted JSON. Re-validate every selector at
 * the browser boundary before it can become a Configuration Task target.
 */
function asIdentifier(value: unknown, maxLength = 160): string | null {
  const text = asBoundedText(value, maxLength);
  return text && /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(text) ? text : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const RECOMMENDATION_KINDS = new Set<AssistantRecommendationKindVM>([
  "configuration",
  "decision",
  "execution",
  "inspection",
  "navigation",
]);

const CONFIGURATION_DESTINATIONS = new Set<
  Extract<AssistantRecommendationActionVM, { type: "configure" }>["destination"]
>([
  "integrations",
  "system_profiles",
  "tool_authoring",
  "ontology_editor",
  "environment_profiles",
]);

const EXECUTABLE_RECOMMENDATION_ACTIONS = new Set<
  Extract<AssistantRecommendationActionVM, { type: "execute" }>["turnAction"]
>([
  "analyze_ontology",
  "analyze_scope",
  "propose_blueprint",
  "generate_package",
  "patch_artifact",
  "generate_tests",
  "run_tests",
  "debug_failure",
  "compare_candidate",
]);

const NAVIGATION_TARGETS = new Set<
  Extract<AssistantRecommendationActionVM, { type: "navigate" }>["target"]
>(["chat", "map", "changes", "tests", "evidence", "harness"]);

function optionalIdentifier(
  value: unknown,
  maxLength = 160,
): string | undefined | null {
  if (value === undefined) return undefined;
  return asIdentifier(value, maxLength);
}

function optionalBoundedText(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  return asBoundedText(value, maxLength);
}

function recommendationActionFromUnknown(
  value: unknown,
): AssistantRecommendationActionVM | null {
  if (!isRecord(value)) return null;
  const type = asText(value.type);
  const label = asBoundedText(value.label, 120);
  if (!type || !label) return null;

  if (type === "navigate") {
    if (!hasOnlyKeys(value, ["type", "label", "target"])) return null;
    const target = asText(value.target);
    if (
      !target ||
      !NAVIGATION_TARGETS.has(
        target as Extract<
          AssistantRecommendationActionVM,
          { type: "navigate" }
        >["target"],
      )
    ) {
      return null;
    }
    return {
      type,
      label,
      target: target as Extract<
        AssistantRecommendationActionVM,
        { type: "navigate" }
      >["target"],
    };
  }

  if (type === "execute") {
    if (!hasOnlyKeys(value, ["type", "label", "turnAction"])) return null;
    const turnAction = asText(value.turnAction);
    if (
      !turnAction ||
      !EXECUTABLE_RECOMMENDATION_ACTIONS.has(
        turnAction as Extract<
          AssistantRecommendationActionVM,
          { type: "execute" }
        >["turnAction"],
      )
    ) {
      return null;
    }
    return {
      type,
      label,
      turnAction: turnAction as Extract<
        AssistantRecommendationActionVM,
        { type: "execute" }
      >["turnAction"],
    };
  }

  if (type === "reply") {
    if (!hasOnlyKeys(value, ["type", "label", "value"])) return null;
    const replyValue = asBoundedText(value.value, 1_000);
    return replyValue ? { type, label, value: replyValue } : null;
  }

  if (type !== "configure") return null;
  if (
    !hasOnlyKeys(value, [
      "type",
      "label",
      "destination",
      "providerId",
      "systemName",
      "toolName",
      "toolIntent",
      "ontologyDomain",
      "waitingHarnessJobId",
      "sourceActionName",
      "sourceRequirementId",
      "readinessStatus",
      "executionSurface",
      "requirementKind",
      "requirementRole",
      "verificationAction",
    ])
  ) {
    return null;
  }
  const destination = asText(value.destination);
  if (
    !destination ||
    !CONFIGURATION_DESTINATIONS.has(
      destination as Extract<
        AssistantRecommendationActionVM,
        { type: "configure" }
      >["destination"],
    )
  ) {
    return null;
  }
  const providerId = optionalIdentifier(value.providerId);
  const systemName = optionalIdentifier(value.systemName);
  const toolName = optionalIdentifier(value.toolName);
  const ontologyDomain = optionalIdentifier(value.ontologyDomain);
  const waitingHarnessJobId = optionalIdentifier(value.waitingHarnessJobId);
  const sourceActionName = optionalIdentifier(value.sourceActionName);
  const sourceRequirementId = optionalIdentifier(value.sourceRequirementId);
  const readinessStatus = optionalIdentifier(value.readinessStatus, 100);
  const requirementKind = optionalIdentifier(value.requirementKind, 120);
  const requirementRole = optionalIdentifier(value.requirementRole, 120);
  const toolIntent = optionalBoundedText(value.toolIntent, 4_000);
  const executionSurface = optionalBoundedText(value.executionSurface, 240);
  const verificationAction =
    value.verificationAction === undefined
      ? undefined
      : value.verificationAction === "verify_configuration"
        ? "verify_configuration"
        : null;
  if (
    [
      providerId,
      systemName,
      toolName,
      ontologyDomain,
      waitingHarnessJobId,
      sourceActionName,
      sourceRequirementId,
      readinessStatus,
      requirementKind,
      requirementRole,
      toolIntent,
      executionSurface,
      verificationAction,
    ].includes(null)
  ) {
    return null;
  }
  return {
    type,
    label,
    destination: destination as Extract<
      AssistantRecommendationActionVM,
      { type: "configure" }
    >["destination"],
    ...(providerId ? { providerId } : {}),
    ...(systemName ? { systemName } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolIntent ? { toolIntent } : {}),
    ...(ontologyDomain ? { ontologyDomain } : {}),
    ...(waitingHarnessJobId ? { waitingHarnessJobId } : {}),
    ...(sourceActionName ? { sourceActionName } : {}),
    ...(sourceRequirementId ? { sourceRequirementId } : {}),
    ...(readinessStatus ? { readinessStatus } : {}),
    ...(executionSurface ? { executionSurface } : {}),
    ...(requirementKind ? { requirementKind } : {}),
    ...(requirementRole ? { requirementRole } : {}),
    ...(verificationAction ? { verificationAction } : {}),
  };
}

function recommendationBlockerKey(
  sourceMessageId: string,
  recommendationId: string,
  action: AssistantRecommendationActionVM,
): string {
  if (
    action.type === "configure" &&
    action.waitingHarnessJobId &&
    action.sourceActionName &&
    action.sourceRequirementId
  ) {
    return `${action.waitingHarnessJobId}:${action.sourceActionName}:${action.sourceRequirementId}`.slice(
      0,
      240,
    );
  }
  return `assistant:${sourceMessageId}:${recommendationId}`.slice(0, 240);
}

function inspectorTargetForNavigation(
  target: Extract<
    AssistantRecommendationActionVM,
    { type: "navigate" }
  >["target"],
): NonNullable<ActionCardVM["inspectorTarget"]> {
  if (target === "chat") return "log";
  if (target === "harness") return "reasoning";
  // These are real, read-only inspector surfaces backed by persisted session
  // records. Keep the target exact so clicking from the default artifact tab
  // always produces an observable navigation.
  return target;
}

function recommendationCardFromUnknown(input: {
  raw: unknown;
  assistantMessageId: string;
  sourceUserMessageId?: string;
  sourceUserIntent?: string;
}): ActionCardVM | null {
  if (!isRecord(input.raw)) return null;
  if (
    !hasOnlyKeys(input.raw, [
      "id",
      "kind",
      "title",
      "reason",
      "impact",
      "recommended",
      "action",
    ])
  ) {
    return null;
  }
  const id = asIdentifier(input.raw.id, 120);
  const kind = asText(input.raw.kind);
  const title = asBoundedText(input.raw.title, 200);
  const reason = asBoundedText(input.raw.reason, 1_500);
  const impact =
    input.raw.impact === undefined
      ? undefined
      : asBoundedText(input.raw.impact, 1_500);
  const action = recommendationActionFromUnknown(input.raw.action);
  if (
    !id ||
    !kind ||
    !RECOMMENDATION_KINDS.has(kind as AssistantRecommendationKindVM) ||
    !title ||
    !reason ||
    impact === null ||
    !action
  ) {
    return null;
  }
  const semanticMatch =
    (action.type === "configure" && kind === "configuration") ||
    (action.type === "execute" && kind === "execution") ||
    (action.type === "reply" && kind === "decision") ||
    (action.type === "navigate" &&
      (kind === "inspection" || kind === "navigation"));
  if (!semanticMatch) return null;

  const recommendation: AssistantRecommendationVM = {
    id,
    kind: kind as AssistantRecommendationKindVM,
    recommended: input.raw.recommended === true,
    sourceMessageId: input.assistantMessageId,
    ...(input.sourceUserMessageId
      ? { sourceUserMessageId: input.sourceUserMessageId }
      : {}),
    ...(input.sourceUserIntent
      ? { sourceUserIntent: input.sourceUserIntent }
      : {}),
    blockerKey: recommendationBlockerKey(input.assistantMessageId, id, action),
    action,
  };
  const common = {
    origin: "assistant_recommendation" as const,
    refId: id,
    title: productFacingCardText(title),
    why: productFacingCardText(reason),
    ...(impact ? { impact: productFacingCardText(impact) } : {}),
    primaryLabel: productFacingCardText(action.label),
    recommendation,
  };
  if (action.type === "configure") {
    return {
      kind: "config",
      ...common,
      systems: action.systemName ? [action.systemName] : [],
    };
  }
  if (action.type === "reply") {
    return {
      kind: "decision",
      ...common,
      options: [
        {
          label: productFacingCardText(action.label),
          value: action.value,
          recommended: recommendation.recommended,
        },
      ],
      allowOther: false,
    };
  }
  if (action.type === "navigate") {
    return {
      kind: "system",
      ...common,
      inspectorTarget: inspectorTargetForNavigation(action.target),
      options: [
        { label: productFacingCardText(action.label), value: action.target },
      ],
    };
  }
  return {
    kind: "system",
    ...common,
    options: [
      { label: productFacingCardText(action.label), value: action.turnAction },
    ],
  };
}

function optionFromUnknown(value: unknown): CardOptionVM | null {
  if (!isRecord(value)) return null;
  const rawLabel = asText(value.label);
  if (!rawLabel) return null;
  return {
    label: productFacingCardText(rawLabel),
    // The value is protocol input, not copy. Historical rows without an
    // explicit value used the original label as their answer payload.
    value: asText(value.value) ?? rawLabel,
    recommended: value.recommended === true,
  };
}

const GENERIC_SYSTEM_TOKENS = new Set([
  "api",
  "integration",
  "ontology",
  "profile",
  "sandbox",
  "service",
  "system",
]);

function inferSystemForText(
  text: string,
  systems: string[],
): string | undefined {
  const corpus = text.toLocaleLowerCase();
  const matches = systems.filter((system) => {
    const fragments = system
      .split(/[^A-Za-z0-9]+/u)
      .map((fragment) => fragment.toLocaleLowerCase())
      .filter(
        (fragment) =>
          fragment.length >= 3 && !GENERIC_SYSTEM_TOKENS.has(fragment),
      );
    return fragments.some((fragment) => corpus.includes(fragment));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function compactConfigQuestion(rawQuestion: string): string {
  const source = productFacingCardText(rawQuestion)
    .replace(/\*\*/gu, "")
    .trim();
  const [firstPart] = source.split(
    /(?:\r?\n|\s{2,}|\s)(?:背景|可选回答|请直接回复|交互编号)[:：]/u,
    1,
  );
  const withoutMetadata = (firstPart ?? source).trim();
  const firstQuestionMark = withoutMetadata.search(/[？?]/u);
  return firstQuestionMark >= 0
    ? withoutMetadata.slice(0, firstQuestionMark + 1).trim()
    : withoutMetadata;
}

/**
 * Old ask_user_batch records only retained the rendered Markdown question.
 * Parse that durable legacy shape so existing waiting Sessions immediately get
 * the same decision UI as newly-created structured questions.
 */
function parseLegacyBatchQuestion(
  rawQuestion: string,
  systems: string[],
): QuestionItemVM[] {
  // Parse the immutable source so the legacy synthesized answer value remains
  // byte-compatible; productize each display field only after parsing it.
  const source = stripEnginePrefix(rawQuestion);
  const block =
    /\*\*(\d+)\.\s*(.*?)\*\*\s*([\s\S]*?)(?=\n\s*\*\*\d+\.\s*|\n背景：批量决策|\n请直接回复|\n交互编号：|$)/gu;
  const items: QuestionItemVM[] = [];
  for (const match of source.matchAll(block)) {
    const ordinal = Number(match[1]);
    const body = match[3] ?? "";
    const options: CardOptionVM[] = [];
    const optionPattern = /(?:^|\n)\s*([A-D])[.、]\s*([^\n]+)/gu;
    for (const optionMatch of body.matchAll(optionPattern)) {
      const letter = optionMatch[1]!;
      const rawLabel = optionMatch[2]!.trim();
      const recommended = /(?:★推荐|[（(]推荐[）)])/u.test(rawLabel);
      const answerLabel = rawLabel
        .replace(/\s*★推荐\s*/gu, "")
        .replace(/\s*[（(]推荐[）)]\s*/gu, "")
        .trim();
      options.push({
        label: productFacingCardText(answerLabel),
        // Preserve the historical answer contract while humanizing only the
        // rendered label.
        value: `${letter}：${answerLabel}`,
        ...(recommended ? { recommended: true } : {}),
      });
    }
    const firstOption = body.search(/(?:^|\n)\s*[A-D][.、]\s*/u);
    const rawContext = (firstOption >= 0 ? body.slice(0, firstOption) : body)
      .replace(/^\s*背景[:：]\s*/u, "")
      .replace(/\s*（自由回答）\s*$/u, "")
      .trim();
    const rawTitle = (match[2] ?? "").trim();
    const question = rawTitle
      .replace(new RegExp(`^${ordinal}\\.\\s*`, "u"), "")
      .trim();
    if (!question) continue;
    const system = inferSystemForText(`${question}\n${rawContext}`, systems);
    items.push({
      id: `batch-${ordinal}`,
      question: productFacingCardText(question),
      ...(rawContext
        ? { context: productFacingCardText(rawContext) }
        : {}),
      options,
      allowOther: true,
      ...(system ? { system } : {}),
    });
  }
  return items;
}

function structuredQuestionItems(
  q: Record<string, unknown>,
  question: string,
  systems: string[],
  globalOptions: CardOptionVM[],
): QuestionItemVM[] {
  const structured = Array.isArray(q.items)
    ? q.items.flatMap((value, index) => {
        if (!isRecord(value)) return [];
        const itemQuestion = asText(value.question);
        if (!itemQuestion) return [];
        const itemSystems = Array.isArray(value.systems)
          ? value.systems.filter(
              (system): system is string =>
                typeof system === "string" && system.trim().length > 0,
            )
          : [];
        const context = asText(value.context);
        const system =
          itemSystems[0] ??
          inferSystemForText(`${itemQuestion}\n${context ?? ""}`, systems);
        return [
          {
            id: asText(value.id) ?? `item-${index + 1}`,
            question: productFacingCardText(itemQuestion),
            ...(context
              ? { context: productFacingCardText(context) }
              : {}),
            options: Array.isArray(value.options)
              ? value.options.flatMap((option) => {
                  const parsed = optionFromUnknown(option);
                  return parsed ? [parsed] : [];
                })
              : [],
            allowOther: value.allowOther !== false,
            ...(system ? { system } : {}),
          },
        ];
      })
    : [];
  if (structured.length > 0) return structured;
  const legacy = parseLegacyBatchQuestion(question, systems);
  if (legacy.length > 0) return legacy;
  if (globalOptions.length > 0) {
    const compactQuestion = compactConfigQuestion(question);
    const system =
      inferSystemForText(compactQuestion, systems) ??
      (systems.length === 1 ? systems[0] : undefined);
    return [
      {
        id: "item-1",
        question: compactQuestion,
        options: globalOptions,
        allowOther: q.allowOther !== false,
        ...(system ? { system } : {}),
      },
    ];
  }
  return [];
}

function questionFromPayload(payload: unknown): ActionCardVM | null {
  if (!isRecord(payload) || !isRecord(payload.question)) return null;
  const q = payload.question;
  const question = asText(q.question);
  if (!question) return null;
  const kindRaw = asText(q.kind);
  const kind: ActionCardVM["kind"] =
    kindRaw === "config" || kindRaw === "authorization" ? kindRaw : "decision";
  const options: CardOptionVM[] = Array.isArray(q.options)
    ? q.options.flatMap((option) => {
        const parsed = optionFromUnknown(option);
        return parsed ? [parsed] : [];
      })
    : [];
  const systems = Array.isArray(q.systems)
    ? q.systems.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  const questionItems =
    kind === "config"
      ? structuredQuestionItems(q, question, systems, options)
      : [];
  const why = asText(q.why);
  const impact = asText(q.impact);
  const title =
    questionItems.length > 1
      ? `${questionItems.length} 项配置`
      : questionItems.length === 1
        ? questionItems[0]!.question
        : productFacingCardText(question);
  return {
    kind,
    origin: "harness_question",
    refId: asText(q.id) ?? "question",
    questionId: asText(q.id) ?? undefined,
    title,
    why: why ? productFacingCardText(why) : undefined,
    impact: impact ? productFacingCardText(impact) : undefined,
    options,
    allowOther: q.allowOther !== false,
    systems,
    ...(questionItems.length > 0 ? { items: questionItems } : {}),
    // config 阻塞 + 有涉及系统 + 来自等待问题（无真实配置任务）= 可确认人工边界
    boundaryEligible: kind === "config" && systems.length > 0,
  };
}

function configTaskCard(task: OntoCodeConfigurationTask): ActionCardVM {
  const t = task as unknown as Record<string, unknown>;
  const requirement = isRecord(t.requirement) ? t.requirement : {};
  const title = asText(t.title);
  const summary = asText(requirement.summary);
  return {
    kind: "config",
    // 配置任务的存续只由它自己的 status 决定——等待作业跑完不代表配置做完了。
    origin: "configuration_task",
    refId: String(t.id ?? "config"),
    configTaskId: typeof t.id === "string" ? t.id : undefined,
    jobId:
      typeof t.waitingHarnessJobId === "string"
        ? t.waitingHarnessJobId
        : undefined,
    title: title ? productFacingCardText(title) : "需要一项配置",
    why: summary ? productFacingCardText(summary) : undefined,
  };
}

/* --------------------- 行动卡生命周期（纯函数判定） --------------------- */

/**
 * 点「执行」时写进 Command.arguments 的归属键。服务端对 arguments 原样落库
 * （canonicalEvidenceJson），所以这是浏览器能留下的、可回读的真实执行凭证。
 * 后端一旦给出一等的来源字段，这里就该换成读那个字段。
 */
export const RECOMMENDATION_COMMAND_ARGUMENT_KEY = "recommendationKey";

/** chip 文案常量——不散落在分支里，改词只有一个地方。 */
export const CARD_LIFECYCLE_LABEL = {
  running: "进行中",
  waitingUser: "等你回答",
  waitingApproval: "等你批准",
  done: "已完成",
  answered: "已回答",
  handled: "已处理",
  failed: "失败",
  cancelled: "已取消",
  rejected: "已拒绝",
  superseded: "已执行过",
} as const;

/** failed 卡上的恢复动作文案。 */
export const RETRY_PRIMARY_LABEL = "重试";

const IN_FLIGHT_JOB_STATUSES = new Set([
  "queued",
  "leased",
  "running",
  "retry_scheduled",
]);

const TERMINAL_JOB_STATUSES = new Set([
  "succeeded",
  "failed_terminal",
  "failed_recoverable",
  "cancelled",
]);

/** 阶段名后缀：`已完成 · 范围分析`。没有已知阶段名时只留状态词。 */
function withStage(base: string, jobKind: string | null): string {
  const stage = jobKind ? JOB_KIND_DONE[jobKind] : null;
  return stage ? `${base} · ${stage}` : base;
}

function lifecycleFromJobStatus(
  status: OntoCodeHarnessJob["status"],
  jobKind: string | null,
  basis: NonNullable<ActionCardLifecycleVM["basis"]>,
): ActionCardLifecycleVM {
  if (status === "succeeded") {
    return {
      state: "done",
      label: withStage(CARD_LIFECYCLE_LABEL.done, jobKind),
      basis,
    };
  }
  if (status === "failed_terminal" || status === "failed_recoverable") {
    return {
      state: "failed",
      label: withStage(CARD_LIFECYCLE_LABEL.failed, jobKind),
      basis,
    };
  }
  if (status === "cancelled") {
    return {
      state: "failed",
      label: withStage(CARD_LIFECYCLE_LABEL.cancelled, jobKind),
      basis,
    };
  }
  if (status === "waiting_user") {
    return {
      state: "running",
      label: CARD_LIFECYCLE_LABEL.waitingUser,
      basis,
    };
  }
  return { state: "running", label: CARD_LIFECYCLE_LABEL.running, basis };
}

function lifecycleFromCommandStatus(
  status: OntoCodeCommand["status"],
): ActionCardLifecycleVM {
  if (status === "succeeded") {
    return { state: "done", label: CARD_LIFECYCLE_LABEL.done, basis: "exact" };
  }
  if (status === "failed") {
    return {
      state: "failed",
      label: CARD_LIFECYCLE_LABEL.failed,
      basis: "exact",
    };
  }
  if (status === "rejected") {
    return {
      state: "failed",
      label: CARD_LIFECYCLE_LABEL.rejected,
      basis: "exact",
    };
  }
  if (status === "cancelled") {
    return {
      state: "failed",
      label: CARD_LIFECYCLE_LABEL.cancelled,
      basis: "exact",
    };
  }
  if (status === "awaiting_approval") {
    return {
      state: "running",
      label: CARD_LIFECYCLE_LABEL.waitingApproval,
      basis: "exact",
    };
  }
  return {
    state: "running",
    label: CARD_LIFECYCLE_LABEL.running,
    basis: "exact",
  };
}

/** 这条 Command 自称由哪张卡发起（浏览器点击时写入，服务端原样落库）。 */
function stampedRecommendationKey(command: OntoCodeCommand): string | null {
  const args = command.arguments as Record<string, unknown>;
  return asText(args?.[RECOMMENDATION_COMMAND_ARGUMENT_KEY]);
}

function newestBy<T>(items: T[], at: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) => (!best || at(item) > at(best) ? item : best),
    undefined,
  );
}

/**
 * 服务端在「问题被回答」时落的那条记录。回答一个等待中的作业会把它置为
 * cancelled 并另起一个作业，所以只看 status 会把「已回答」说成「已取消」。
 */
export const QUESTION_RESOLVED_EVENT_TYPE = "harness.job.input_resolved";

export interface ActionCardLifecycleInput {
  card: ActionCardVM;
  /** 卡片被提出的时刻（流条目时间）。晚于它的同类阶段才可能是它引发的。 */
  proposedAt: number;
  jobs: OntoCodeHarnessJob[];
  commands: OntoCodeCommand[];
  /** 已被回答的等待作业 id（由 QUESTION_RESOLVED_EVENT_TYPE 事件给出）。 */
  resolvedQuestionJobIds?: ReadonlySet<string>;
}

/** 从落库事件里读出「哪些等待中的提问已经被回答」。 */
export function resolvedQuestionJobIds(
  events: OntoCodeSessionEvent[],
): Set<string> {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type !== QUESTION_RESOLVED_EVENT_TYPE) continue;
    const waitingJobId = asText(
      isRecord(event.payload) ? event.payload.waitingJobId : null,
    );
    if (waitingJobId) resolved.add(waitingJobId);
  }
  return resolved;
}

/**
 * 从落库事实推导一张卡的执行状态。
 *
 * 判定顺序刻意是「先要精确归属，拿不到才退到阶段证据，再拿不到就承认不知道」：
 * 宁可多留一个按钮，也不假称某件事已经做过。
 */
export function deriveActionCardLifecycle(
  input: ActionCardLifecycleInput,
): ActionCardLifecycleVM {
  const { card, jobs, commands, proposedAt } = input;

  if (card.origin === "harness_question") {
    // 这张卡指名了一个作业。作业不在已加载的这一页里 → 什么都不知道，不编造。
    if (!card.jobId) return { state: "proposed" };
    const job = jobs.find((candidate) => candidate.id === card.jobId);
    if (!job) return { state: "proposed" };
    // 回答这件事有一条独立的落库记录，优先于作业状态：被回答的作业恰好会
    // 变成 cancelled，只读 status 会把「已回答」错写成「已取消」。
    if (input.resolvedQuestionJobIds?.has(card.jobId)) {
      return {
        state: "done",
        label: CARD_LIFECYCLE_LABEL.answered,
        basis: "job",
      };
    }
    // 还在等人回答 → 问题依然有效，按钮照常给。
    if (job.status === "waiting_user") return { state: "proposed" };
    if (job.status === "succeeded") {
      return {
        state: "done",
        label: CARD_LIFECYCLE_LABEL.handled,
        basis: "job",
      };
    }
    return lifecycleFromJobStatus(job.status, job.kind, "job");
  }

  if (card.origin !== "assistant_recommendation") return { state: "proposed" };
  const action = card.recommendation?.action;
  // 只有「执行」类建议才对应一次可观测的运行；导航/回复/配置没有作业可依。
  if (!action || action.type !== "execute") return { state: "proposed" };

  const key = card.recommendation?.blockerKey;
  const linkedCommand = key
    ? newestBy(
        commands.filter((command) => stampedRecommendationKey(command) === key),
        (command) => command.createdAt,
      )
    : undefined;
  if (linkedCommand) {
    const linkedJob = newestBy(
      jobs.filter((job) => job.commandId === linkedCommand.id),
      (job) => job.createdAt,
    );
    return linkedJob
      ? lifecycleFromJobStatus(linkedJob.status, linkedJob.kind, "exact")
      : lifecycleFromCommandStatus(linkedCommand.status);
  }

  // 没有归属凭证。剩下的只有「同类阶段」这一层弱证据。
  const jobKind = ONTOCODE_COMMAND_POLICY[action.turnAction]?.jobKind;
  if (!jobKind) return { state: "proposed" };
  const sameKind = jobs.filter((job) => job.kind === jobKind);

  const inFlight = sameKind.find((job) =>
    IN_FLIGHT_JOB_STATUSES.has(job.status),
  );
  if (inFlight) {
    return {
      state: "running",
      label: CARD_LIFECYCLE_LABEL.running,
      basis: "stage",
    };
  }
  const waiting = sameKind.find((job) => job.status === "waiting_user");
  if (waiting) {
    return {
      state: "running",
      label: CARD_LIFECYCLE_LABEL.waitingUser,
      basis: "stage",
    };
  }
  // 严格晚于本卡：更早跑完的那次不是这张卡请求的工作。
  const settledAfter = sameKind.filter(
    (job) =>
      TERMINAL_JOB_STATUSES.has(job.status) && job.createdAt > proposedAt,
  );
  // 「已执行过」是一句陈述：这一步真的成功跑过。只有 succeeded 配得上——
  // 失败/取消的尝试不是执行记录，拿它 supersede 会把按钮吞掉，恰好复活
  // 「按钮与事实不符」的原始缺陷。真实存在的成功不因之后一次失败的重试注销。
  if (settledAfter.some((job) => job.status === "succeeded")) {
    return {
      state: "superseded",
      label: withStage(CARD_LIFECYCLE_LABEL.superseded, jobKind),
      basis: "stage",
    };
  }
  // 只剩失败/取消：如实标 failed（最新一次尝试的结局），卡片保留 failed 态的
  // 恢复动作（重试按钮）。什么都推不出来就承认不知道。
  const failedAfter = newestBy(settledAfter, (job) => job.createdAt);
  if (failedAfter) {
    return lifecycleFromJobStatus(failedAfter.status, jobKind, "stage");
  }
  return { state: "proposed" };
}

export function projectFlow(input: FlowInput): FlowItemVM[] {
  const items: FlowItemVM[] = [];
  const userMessagesByCorrelation = new Map<
    string,
    { id: string; text: string; createdAt: number }
  >();
  for (const message of input.messages) {
    if (message.role !== "user") continue;
    const text = asText(
      isRecord(message.content) ? message.content.text : undefined,
    );
    const correlationId = asIdentifier(message.correlationId);
    if (!text || !correlationId) continue;
    const previous = userMessagesByCorrelation.get(correlationId);
    if (!previous || message.createdAt > previous.createdAt) {
      userMessagesByCorrelation.set(correlationId, {
        id: message.id,
        text,
        createdAt: message.createdAt,
      });
    }
  }

  for (const m of input.messages) {
    const content = isRecord(m.content) ? m.content : {};
    const text = asText(content.text);
    if (m.role === "user") {
      if (text) items.push({ kind: "user", id: m.id, text, at: m.createdAt });
      continue;
    }
    // assistant / system：只渲染人话正文；指令/产物回执类噪声不进流（其信号由执行组与卡片承载）。
    const isWaitingReceipt =
      content.status === "waiting_user" ||
      content.completionKind === "awaiting_input";
    // 分析回答可以带服务端聚合图表（content.charts）。正文为空但图表在场时
    // 消息仍然要进流——图表不允许被静默丢弃。
    const charts =
      Array.isArray(content.charts) && content.charts.length > 0
        ? content.charts
        : undefined;
    const citations = parseAssistantCitations(content);
    if ((text || charts) && !isWaitingReceipt)
      items.push({
        kind: "aiText",
        id: m.id,
        text: text ? humanizeAssistantText(text) : "",
        ...(charts ? { charts } : {}),
        ...(citations.length > 0 ? { citations } : {}),
        at: m.createdAt,
      });
    // Recommendations are durable assistant output. Project only a strict,
    // semantically-matched action shape; malformed selectors disappear rather
    // than becoming browser authority.
    if (Array.isArray(content.recommendations)) {
      const correlationId = asIdentifier(m.correlationId);
      const sourceUser = correlationId
        ? userMessagesByCorrelation.get(correlationId)
        : undefined;
      content.recommendations.slice(0, 6).forEach((raw, index) => {
        const card = recommendationCardFromUnknown({
          raw,
          assistantMessageId: m.id,
          ...(sourceUser && sourceUser.createdAt <= m.createdAt
            ? {
                sourceUserMessageId: sourceUser.id,
                sourceUserIntent: sourceUser.text,
              }
            : {}),
        });
        if (!card) return;
        if (
          card.recommendation?.action.type === "configure" &&
          card.recommendation.action.destination === "tool_authoring" &&
          input.configTasks.some(
            (task) =>
              task.blockerKey === card.recommendation?.blockerKey &&
              task.status !== "cancelled" &&
              task.status !== "superseded",
          )
        ) {
          return;
        }
        items.push({
          kind: "actionCard",
          id: `recommendation-${m.id}-${index}`,
          card,
          at: m.createdAt + index + 0.01,
        });
      });
    }
  }

  const stageEventsByJob = new Map<string, OntoCodeSessionEvent[]>();
  for (const ev of input.events) {
    if (ev.harnessJobId && /^harness\./.test(ev.type)) {
      const list = stageEventsByJob.get(ev.harnessJobId) ?? [];
      list.push(ev);
      stageEventsByJob.set(ev.harnessJobId, list);
    }
  }

  for (const job of input.jobs) {
    const doneName = JOB_KIND_DONE[job.kind] ?? "执行";
    // A Candidate-bearing sibling is durable proof that this stable Build
    // execution already produced reviewable code. Keep any later failed Job
    // visible as historical audit, but do not offer a same-execution retry:
    // that would resume an obsolete private checkpoint instead of reviewing
    // the immutable Candidate that is already present.
    const buildExecutionHasCandidateSibling =
      job.kind === "build" &&
      typeof job.buildExecutionId === "string" &&
      input.jobs.some(
        (candidate) =>
          candidate.id !== job.id &&
          candidate.kind === "build" &&
          candidate.buildExecutionId === job.buildExecutionId &&
          candidate.candidatePackageVersionId !== null,
      );
    if (
      job.status === "succeeded" ||
      job.status === "failed_terminal" ||
      job.status === "failed_recoverable" ||
      job.status === "cancelled"
    ) {
      const evs = stageEventsByJob.get(job.id) ?? [];
      const steps = evs
        .map((e) => asText(isRecord(e.payload) ? e.payload.stage : null))
        .filter((s): s is string => s !== null);
      const secs =
        job.finishedAt && job.startedAt
          ? Math.max(1, Math.round((job.finishedAt - job.startedAt) / 1000))
          : null;
      const title =
        job.status === "succeeded"
          ? `${doneName}完成${secs ? ` · ${secs}s` : ""}`
          : job.status === "cancelled"
            ? `${doneName}已取消`
            : job.status === "failed_recoverable"
              ? `${doneName}失败（可修复）`
              : `${doneName}失败`;
      items.push({
        kind: "execGroup",
        id: `exec-${job.id}`,
        title,
        steps,
        ...(job.status === "succeeded" &&
        (job.kind === "ontology_analysis" ||
          job.kind === "scope" ||
          job.kind === "blueprint")
          ? {
              stageDocKind:
                job.kind === "ontology_analysis" ? "analysis" : job.kind,
            }
          : {}),
        ...(job.status === "failed_recoverable" &&
        !buildExecutionHasCandidateSibling
          ? { retryJobId: job.id }
          : {}),
        at: job.finishedAt ?? job.updatedAt,
      });
    } else if (
      job.status === "running" ||
      job.status === "leased" ||
      job.status === "queued" ||
      job.status === "retry_scheduled"
    ) {
      const verb = JOB_KIND_VERB[job.kind] ?? "进行中";
      const suffix =
        job.status === "queued" || job.status === "retry_scheduled"
          ? "（排队中）"
          : "";
      items.push({
        kind: "statusLine",
        id: `status-${job.id}`,
        text: `${verb}${suffix}`,
        at: Number.MAX_SAFE_INTEGER, // 状态行永远排最后且只应有一个
      });
    }
  }

  // 结构化提问（waiting_user 事件）→ 行动卡
  const seenQuestionIds = new Set<string>();
  const jobsWithStructuredQuestion = new Set<string>();
  for (const ev of input.events) {
    if (!/waiting_user$/.test(ev.type)) continue;
    const card = questionFromPayload(ev.payload);
    if (!card) continue;
    const key = card.questionId ?? ev.id;
    if (seenQuestionIds.has(key)) continue;
    seenQuestionIds.add(key);
    if (ev.harnessJobId) jobsWithStructuredQuestion.add(ev.harnessJobId);
    items.push({
      kind: "actionCard",
      id: `card-${ev.id}`,
      card: { ...card, jobId: ev.harnessJobId ?? undefined },
      at: ev.createdAt,
    });
  }

  // 兜底：waiting_user 作业没有结构化事件时（旧数据/后端未升级），
  // 把作业上的提问原文投影成可回答的决策卡——问题永远不能只躺在错误字段里。
  for (const job of input.jobs) {
    if (job.status !== "waiting_user") continue;
    if (jobsWithStructuredQuestion.has(job.id)) continue;
    const raw = asText(job.errorMessage);
    if (!raw) continue;
    items.push({
      kind: "actionCard",
      id: `card-jobq-${job.id}`,
      card: {
        kind: "decision",
        origin: "harness_question",
        refId: job.id,
        jobId: job.id,
        title: truncate(productFacingCardText(raw), 180),
        allowOther: true,
        options: [],
      },
      at: job.updatedAt,
    });
  }

  for (const task of input.configTasks) {
    const status = (task as unknown as Record<string, unknown>).status;
    if (status !== "open" && status !== "verifying") continue;
    items.push({
      kind: "actionCard",
      id: `card-config-${(task as unknown as { id: string }).id}`,
      card: configTaskCard(task),
      at:
        typeof (task as unknown as Record<string, unknown>).createdAt ===
        "number"
          ? (task as unknown as { createdAt: number }).createdAt
          : 0,
    });
  }

  for (const cmd of input.commands) {
    if (cmd.status !== "awaiting_approval" || !cmd.requiresHuman) continue;
    items.push({
      kind: "actionCard",
      id: `card-cmd-${cmd.id}`,
      card: {
        kind:
          cmd.riskClass === "production_deploy"
            ? "deploy_confirm"
            : "authorization",
        // 这些卡本来就只在 awaiting_approval 时投影，批准掉就不再出现。
        origin: "command_approval",
        refId: cmd.id,
        commandId: cmd.id,
        title: productFacingCardText(cmd.rationaleSummary),
      },
      at: cmd.createdAt,
    });
  }

  // 只保留一条状态行（多 running 作业时取最新）。
  const statusLines = items.filter((i) => i.kind === "statusLine");
  const rest: FlowItemVM[] = items.filter((i) => i.kind !== "statusLine");
  rest.sort((a, b) => a.at - b.at);
  const lastStatus = statusLines[statusLines.length - 1];
  if (lastStatus !== undefined) rest.push(lastStatus);
  // 最后一遍：把每张卡对上它真正发生过什么。提出这张卡的那条消息不知道后来
  // 的事，只有这里同时看得见 jobs / commands / 事件与卡片被提出的时刻。
  const resolvedQuestions = resolvedQuestionJobIds(input.events);
  return rest.map((item) =>
    item.kind === "actionCard"
      ? {
          ...item,
          card: {
            ...item.card,
            lifecycle: deriveActionCardLifecycle({
              card: item.card,
              proposedAt: item.at,
              jobs: input.jobs,
              commands: input.commands,
              resolvedQuestionJobIds: resolvedQuestions,
            }),
          },
        }
      : item,
  );
}

/**
 * waiting_user 作业的确定性续跑映射：答复以低层 execute turn 直发，
 * action 必须与等待中作业的 kind 匹配（服务端 409 兜底校验）。
 */
export function resumeActionForJobKind(kind: string): string | null {
  switch (kind) {
    case "scope":
      return "analyze_scope";
    case "blueprint":
      return "propose_blueprint";
    case "build":
      return "generate_package";
    case "test":
      return "run_tests";
    case "debug":
      return "debug_failure";
    case "regression":
      return "compare_candidate";
    default:
      return null;
  }
}

/**
 * 提取所有「用户可见」文本（label/title/sub/why/impact/text/steps/选项文案）。
 * 词汇白名单守卫只对这份文本生效——id 类接线字段不属于可见面。
 */
export function collectVisibleText(
  items: Array<FlowItemVM | SessionRowVM>,
): string {
  const parts: string[] = [];
  for (const item of items) {
    if ("label" in item) {
      parts.push(item.title, item.label, item.sub);
      continue;
    }
    switch (item.kind) {
      case "user":
      case "aiText":
      case "receipt":
      case "statusLine":
        parts.push(item.text);
        break;
      case "execGroup":
        parts.push(item.title, ...item.steps);
        break;
      case "actionCard": {
        const c = item.card;
        parts.push(
          c.title,
          c.why ?? "",
          c.impact ?? "",
          c.primaryLabel ?? "",
          c.lifecycle?.label ?? "",
        );
        for (const o of c.options ?? []) parts.push(o.label);
        for (const question of c.items ?? []) {
          parts.push(question.question, question.context ?? "");
          for (const option of question.options) parts.push(option.label);
        }
        break;
      }
    }
  }
  return parts.join("\n");
}
