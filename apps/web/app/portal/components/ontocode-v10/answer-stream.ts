// OntoCode v10 · 分析回答的实时流缓冲（纯 reducer，无 DOM）。
//
// 服务端一边推理一边发 durable 事件：answer_delta（分片，ordinal 1 起连续）、
// tool_call / tool_result（工具活动）、chart（服务端聚合图表）、
// answer_delta_truncated（分片达上限）。本模块只做累积 / 去重 / 交接判定，
// 渲染归 GuidedFlow。权威永远是最终落库的 assistant 消息：一旦它出现，
// 直播缓冲整体丢弃（answerHandedOff + dropAnswerStreamJob），绝不双份渲染。
import type { OntoCodeSessionEvent } from "@agentic/contracts";

/** 分析作业的实时流事件类型（固定契约）。 */
export const ANSWER_STREAM_TYPES = {
  toolCall: "harness.ontology_analysis.tool_call",
  toolResult: "harness.ontology_analysis.tool_result",
  answerDelta: "harness.ontology_analysis.answer_delta",
  answerDeltaTruncated: "harness.ontology_analysis.answer_delta_truncated",
  chart: "harness.ontology_analysis.chart",
  // #INQUIRY-DELIBERATION —— 大脑声明并真的执行一套推理方法。一次 debate 会烧
  // 掉数次模型调用、跑上分钟；不认这三种帧，活动行就停在最后一次工具调用上，
  // 恰好在最贵的推理进行时看上去像卡死。
  strategy: "harness.ontology_analysis.strategy",
  reasoningStep: "harness.ontology_analysis.reasoning_step",
  deliberation: "harness.ontology_analysis.deliberation",
  // #ONTOCODE-MEM / #ONTOCODE-COMPREHEND —— 这次分析【继承了什么】。三条都是
  // 服务端早就在发的硬事实，此前没有映射，于是只能靠回执的 limitations 兜底：
  // FDE 分不出「重新读了整个本体」「沿用了既有理解」「被更早会话的结论预置过」
  // 这三种完全不同的运行。它们进独立的常驻槽，不进活动行——活动行下一次工具
  // 调用就会覆盖，而这类信息必须整场可见。
  comprehension: "harness.ontology_analysis.comprehension",
  memoryRecall: "harness.ontology_analysis.memory_recall",
  contextFold: "harness.ontology_analysis.context_fold",
} as const;

/** 这次分析对本体的既有理解用了多少、丢了多少。每个数都是真实计数。 */
export interface AnswerComprehensionProvenance {
  /** 本体版本未变，整段理解直接沿用，本次没有重新理解本体。 */
  reused: boolean;
  anchorsTotal: number;
  understood: number;
  carriedForward: number;
  reestablished: number;
  /** 旧理解因实体结构已变而未被沿用、且本次也没能重读的数量。 */
  staleDiscarded: number;
  /** 旧理解因实体已不存在而被撤回的数量。 */
  withdrawn: number;
  /** 未完成的部分，按名字与真实条数。空数组表示确实没有未完成的。 */
  refused: ReadonlyArray<{ kind: string; count: number; detail?: string }>;
}

/** 这次分析被更早会话的结论预置了多少。 */
export interface AnswerRecallProvenance {
  recalled: number;
  refused: number;
  belowScore: number;
  scanned: number;
  sources: readonly string[];
  failure: string | null;
}

export interface AnswerProvenance {
  comprehension: AnswerComprehensionProvenance | null;
  recall: AnswerRecallProvenance | null;
  /** 真正发生过的上下文折叠次数。 */
  folds: number;
  /** 被拒绝的折叠，按理由。拒绝不是折叠，两者绝不合并计数。 */
  foldRefusals: readonly string[];
}

export interface AnswerStreamToolActivity {
  kind: "tool_call" | "tool_result";
  tool: string;
  /** tool_call 的 reasoning / argsSummary，或 tool_result 的 summary。 */
  detail: string | null;
  /** 仅 tool_result 有真假；tool_call 为 null。 */
  ok: boolean | null;
  /** 事件全局序号——重放的旧帧不允许倒退覆盖新活动。 */
  seq: number;
}

/** 审议活动：声明 / 某个方法执行完 / 结果。与工具活动共用同一个槽和同一条
 * seq 规则——谁的序号新谁上，两边都不许被重放的旧帧盖掉。 */
export interface AnswerStreamDeliberationActivity {
  kind: "deliberation";
  phase: "declared" | "step" | "outcome";
  /**
   * declared：声明的方法链；step：这一步真正跑的方法（被降级时写成
   * 「声明名 → 通用推理」，绝不单独顶着声明名冒充）；outcome：真跑完的链。
   */
  strategy: string;
  /** 仅 step：第几步 / 共几步，1 起。 */
  index: number | null;
  total: number | null;
  /** 仅 outcome：completed / refused / downgraded / failed / …。 */
  status: string | null;
  /** 仅 step：这一步的失败原因。 */
  detail: string | null;
  seq: number;
}

export type AnswerStreamActivity =
  | AnswerStreamToolActivity
  | AnswerStreamDeliberationActivity;

export interface AnswerStreamJob {
  harnessJobId: string;
  /** ordinal → 分片文本。渲染只取从 1 开始的连续前缀。 */
  deltas: Readonly<Record<number, string>>;
  truncation: { emitted: number; dropped: number } | null;
  /** 图表按到达顺序追加，按事件 id 去重；spec 在渲染处校验。 */
  charts: ReadonlyArray<{ eventId: string; spec: unknown }>;
  activity: AnswerStreamActivity | null;
  /** 常驻：这次分析继承了什么。`null` = 本次运行一条都没报过。 */
  provenance: AnswerProvenance | null;
  /** 该作业流事件携带过的 correlationId——交接判定的关联键之一。 */
  correlationIds: readonly string[];
  /** 无法解析的分片帧数。不静默吞掉：气泡里如实提示以最终消息为准。 */
  invalidFrames: number;
  firstEventAt: number;
  lastEventAt: number;
  /** 最新分片的时间——早于它的消息不可能是完整答案。 */
  lastDeltaAt: number | null;
}

export interface AnswerStreamState {
  jobs: Readonly<Record<string, AnswerStreamJob>>;
}

export const EMPTY_ANSWER_STREAM: AnswerStreamState = { jobs: {} };

const STREAM_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(ANSWER_STREAM_TYPES),
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function emptyJob(harnessJobId: string, at: number): AnswerStreamJob {
  return {
    harnessJobId,
    deltas: {},
    truncation: null,
    charts: [],
    activity: null,
    provenance: null,
    correlationIds: [],
    invalidFrames: 0,
    firstEventAt: at,
    lastEventAt: at,
    lastDeltaAt: null,
  };
}

function withCorrelation(
  job: AnswerStreamJob,
  correlationId: string,
): AnswerStreamJob {
  if (job.correlationIds.includes(correlationId)) return job;
  return { ...job, correlationIds: [...job.correlationIds, correlationId] };
}

/**
 * 把一条 durable 会话事件并入直播缓冲。纯函数；与本流无关（或已并入过）的
 * 事件必须原样返回同一个 state 引用——上层用引用相等做 setState 短路。
 */
/** 作业新一轮尝试开始：分片会重新从 ordinal 1 发，旧缓冲必须整体清掉。 */
const JOB_ATTEMPT_STARTED_TYPE = "harness.job.started";

export function reduceAnswerStream(
  state: AnswerStreamState,
  event: OntoCodeSessionEvent,
): AnswerStreamState {
  if (!event.harnessJobId) return state;
  if (event.type === JOB_ATTEMPT_STARTED_TYPE) {
    return dropAnswerStreamJob(state, event.harnessJobId);
  }
  if (!STREAM_TYPE_SET.has(event.type)) return state;

  const existing = state.jobs[event.harnessJobId];
  const base = existing ?? emptyJob(event.harnessJobId, event.createdAt);
  const payload = isRecord(event.payload) ? event.payload : {};
  let job = withCorrelation(base, event.correlationId);

  if (event.type === ANSWER_STREAM_TYPES.answerDelta) {
    const ordinal =
      typeof payload.ordinal === "number" &&
      Number.isInteger(payload.ordinal) &&
      payload.ordinal >= 1
        ? payload.ordinal
        : null;
    const text = typeof payload.text === "string" ? payload.text : null;
    if (ordinal === null || text === null) {
      job = { ...job, invalidFrames: job.invalidFrames + 1 };
    } else if (job.deltas[ordinal] !== undefined) {
      // SSE 重连会重放——同 ordinal 即同分片，保留首见即可。
      if (job === base) return state;
    } else {
      job = {
        ...job,
        deltas: { ...job.deltas, [ordinal]: text },
        lastDeltaAt: Math.max(job.lastDeltaAt ?? 0, event.createdAt),
      };
    }
  } else if (event.type === ANSWER_STREAM_TYPES.answerDeltaTruncated) {
    const emitted = typeof payload.emitted === "number" ? payload.emitted : 0;
    const dropped = typeof payload.dropped === "number" ? payload.dropped : 0;
    if (job.truncation && job === base) return state;
    job = { ...job, truncation: job.truncation ?? { emitted, dropped } };
  } else if (
    event.type === ANSWER_STREAM_TYPES.toolCall ||
    event.type === ANSWER_STREAM_TYPES.toolResult ||
    event.type === ANSWER_STREAM_TYPES.strategy ||
    event.type === ANSWER_STREAM_TYPES.reasoningStep ||
    event.type === ANSWER_STREAM_TYPES.deliberation
  ) {
    // 工具活动与审议活动共用一个槽：同一条 seq 规则守住两个方向，重放的旧帧
    // 不论出自哪一侧都盖不掉更新的活动。
    if (job.activity && job.activity.seq >= event.seq) {
      if (job === base) return state;
    } else {
      job = { ...job, activity: activityOf(event.type, payload, event.seq) };
    }
  } else if (
    event.type === ANSWER_STREAM_TYPES.comprehension ||
    event.type === ANSWER_STREAM_TYPES.memoryRecall ||
    event.type === ANSWER_STREAM_TYPES.contextFold
  ) {
    const merged = mergeProvenance(job.provenance, event.type, payload);
    if (merged === job.provenance) {
      if (job === base) return state;
    } else {
      job = { ...job, provenance: merged };
    }
  } else if (event.type === ANSWER_STREAM_TYPES.chart) {
    if (job.charts.some((chart) => chart.eventId === event.id)) {
      if (job === base) return state;
    } else {
      job = {
        ...job,
        charts: [...job.charts, { eventId: event.id, spec: payload.chart }],
      };
    }
  }

  job = { ...job, lastEventAt: Math.max(job.lastEventAt, event.createdAt) };
  return { jobs: { ...state.jobs, [event.harnessJobId]: job } };
}

function combineResultDetail(payload: Record<string, unknown>): string | null {
  const summary = asText(payload.summary);
  if (!summary) return null;
  return payload.truncated === true ? `${summary}（摘要已截断）` : summary;
}

function asChain(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const names = v.filter((item): item is string => typeof item === "string");
  return names.length > 0 ? names.join(" → ") : null;
}

function asCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 生产端把降级标记写在 payload 顶层；`meta` 是内核事件的原始位置。两处都认，
 * 免得桥接层改一次形状这条信息就整个消失。
 */
export function readDegradedFrom(
  payload: Record<string, unknown>,
): string | null {
  const top = asText(payload.degradedFrom);
  if (top) return top;
  const meta = isRecord(payload.meta) ? payload.meta : null;
  return meta ? asText(meta.degradedFrom) : null;
}

export function readStepError(payload: Record<string, unknown>): string | null {
  const top = asText(payload.error);
  if (top) return top;
  const meta = isRecord(payload.meta) ? payload.meta : null;
  return meta ? asText(meta.error) : null;
}

/**
 * 一个推理步该显示成什么名字。内核遇到不认识的方法名会跑一遍通用推理，却把
 * 声明名原样带回来——只印声明名就等于谎称那个方法真的跑了。
 */
export function reasoningStepName(payload: Record<string, unknown>): string {
  const declared = asText(payload.strategy) ?? "推理";
  const degradedFrom = readDegradedFrom(payload);
  return degradedFrom ? `${degradedFrom} → 通用推理` : declared;
}

function activityOf(
  type: string,
  payload: Record<string, unknown>,
  seq: number,
): AnswerStreamActivity {
  if (
    type === ANSWER_STREAM_TYPES.toolCall ||
    type === ANSWER_STREAM_TYPES.toolResult
  ) {
    const isCall = type === ANSWER_STREAM_TYPES.toolCall;
    return {
      kind: isCall ? "tool_call" : "tool_result",
      tool: asText(payload.tool) ?? "工具",
      detail: isCall
        ? (asText(payload.reasoning) ?? asText(payload.argsSummary))
        : combineResultDetail(payload),
      ok: isCall ? null : payload.ok !== false,
      seq,
    };
  }
  if (type === ANSWER_STREAM_TYPES.strategy) {
    return {
      kind: "deliberation",
      phase: "declared",
      strategy: asChain(payload.steps) ?? "未声明",
      index: null,
      total: null,
      status: null,
      detail: null,
      seq,
    };
  }
  if (type === ANSWER_STREAM_TYPES.reasoningStep) {
    const index = asCount(payload.index);
    const total = asCount(payload.total);
    return {
      kind: "deliberation",
      phase: "step",
      strategy: reasoningStepName(payload),
      // 内核的 index 从 0 起；进度行按人的读法从 1 起。
      index: index === null ? null : index + 1,
      total,
      status: null,
      detail: readStepError(payload),
      seq,
    };
  }
  return {
    kind: "deliberation",
    phase: "outcome",
    strategy: asChain(payload.executed) ?? "",
    index: null,
    total: null,
    status: asText(payload.status),
    detail: null,
    seq,
  };
}

/** 权威消息（或作业终态）接管后丢弃直播缓冲。未知作业原样返回同一引用。 */
export function dropAnswerStreamJob(
  state: AnswerStreamState,
  harnessJobId: string,
): AnswerStreamState {
  if (!(harnessJobId in state.jobs)) return state;
  const jobs = { ...state.jobs };
  delete jobs[harnessJobId];
  return { jobs };
}

/* ------------------------------- 选择器 ------------------------------- */

export interface LiveAnswerActivityVM {
  text: string;
  /** true = 最近一帧是 tool_call，工具仍在跑。 */
  busy: boolean;
}

export interface LiveAnswerVM {
  jobId: string;
  /** 从 ordinal 1 起的连续前缀。缺口之后的分片先押着，不渲染乱序文本。 */
  markdown: string;
  /** 已收到但还接不上前缀的分片数（缺口未补齐）。 */
  pendingFragments: number;
  charts: readonly unknown[];
  activity: LiveAnswerActivityVM | null;
  truncated: boolean;
  invalidFrames: number;
  lastEventAt: number;
}

/** 审议结果状态 → 人话。未知状态如实带出原值，不吞掉信息。 */
export const DELIBERATION_STATUS_TEXT: Record<string, string> = {
  completed: "审议完成",
  refused: "未执行审议",
  downgraded: "审议已降级",
  failed: "审议失败",
  ambient: "未另行推理",
  empty: "审议无产出",
  // #BLUEPRINT-REASON —— 蓝图审议帧的两个新状态。缺条目会以「审议 degraded」
  // 这种中英夹生的形式漏出去。
  degraded: "审议部分完成",
  unavailable: "审议未启用",
};

export function deliberationStatusText(status: string | null): string {
  if (!status) return "审议结束";
  return DELIBERATION_STATUS_TEXT[status] ?? `审议 ${status}`;
}

export function formatAnswerActivity(activity: AnswerStreamActivity): string {
  if (activity.kind === "deliberation") {
    if (activity.phase === "declared") {
      return `已声明推理方法：${activity.strategy}`;
    }
    if (activity.phase === "step") {
      const at =
        activity.index !== null && activity.total !== null
          ? `（${activity.strategy} ${activity.index}/${activity.total}）`
          : `（${activity.strategy}）`;
      return activity.detail
        ? `审议步骤失败${at}：${activity.detail}`
        : `正在审议${at}`;
    }
    const head = deliberationStatusText(activity.status);
    return activity.strategy ? `${head}（${activity.strategy}）` : head;
  }
  const detail = activity.detail ? `：${activity.detail}` : "";
  if (activity.kind === "tool_call") {
    return `正在调用 ${activity.tool}${detail}`;
  }
  return activity.ok === false
    ? `${activity.tool} 失败${detail}`
    : `${activity.tool} 完成${detail}`;
}

/**
 * 转圈只代表「还有东西在跑」。声明发生在工具循环里，此刻没有推理步在执行；
 * 降级帧则是在任何一步开跑之前就发出的，后面还有步骤要跑。
 */
export function answerActivityBusy(activity: AnswerStreamActivity): boolean {
  if (activity.kind === "deliberation") {
    if (activity.phase === "step") return true;
    if (activity.phase === "outcome") return activity.status === "downgraded";
    return false;
  }
  return activity.kind === "tool_call";
}

function contiguousMarkdown(deltas: Readonly<Record<number, string>>): {
  markdown: string;
  pendingFragments: number;
} {
  const parts: string[] = [];
  let next = 1;
  while (deltas[next] !== undefined) {
    parts.push(deltas[next]!);
    next += 1;
  }
  const received = Object.keys(deltas).length;
  return {
    markdown: parts.join(""),
    pendingFragments: received - parts.length,
  };
}

export function selectLiveAnswers(state: AnswerStreamState): LiveAnswerVM[] {
  return Object.values(state.jobs)
    .map((job): LiveAnswerVM => {
      const { markdown, pendingFragments } = contiguousMarkdown(job.deltas);
      return {
        jobId: job.harnessJobId,
        markdown,
        pendingFragments,
        charts: job.charts.map((chart) => chart.spec),
        activity: job.activity
          ? {
              text: formatAnswerActivity(job.activity),
              busy: answerActivityBusy(job.activity),
            }
          : null,
        truncated: job.truncation !== null,
        invalidFrames: job.invalidFrames,
        lastEventAt: job.lastEventAt,
      };
    })
    .sort((a, b) => a.lastEventAt - b.lastEventAt);
}

/**
 * eventsQ 的历史回放只为「还会继续产出」的作业重建缓冲（页面中途刷新 / SSE
 * 断档）。终局作业的答案已由 durable 消息承载，重放它们只会复活僵尸气泡。
 */
const REPLAY_ELIGIBLE_JOB_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "leased",
  "running",
  "retry_scheduled",
  "waiting_user",
]);

export function answerStreamReplayEligible(status: string): boolean {
  return REPLAY_ELIGIBLE_JOB_STATUSES.has(status);
}

/* ------------------------------ 交接判定 ------------------------------ */

export interface HandoffJobLike {
  id: string;
  commandId: string | null;
  status: string;
  finishedAt: number | null;
  updatedAt: number;
}

export interface HandoffMessageLike {
  role: string;
  commandId?: string | null;
  correlationId?: string;
  createdAt: number;
  content: unknown;
}

/**
 * 消息与作业各自的时钟都在服务端，但「作业标记完成」与「答案消息落库」的先后
 * 没有契约保证——succeeded 兜底比对时间戳时留一点宽限，避免刚好写在
 * finishedAt 前几毫秒的答案被漏认、直播气泡与权威消息双份渲染。
 */
const DURABLE_MESSAGE_GRACE_MS = 30_000;

function isAnswerContent(content: unknown): boolean {
  if (!isRecord(content)) return false;
  // 等待回答的回执不是答案（与 projectFlow 的 isWaitingReceipt 同判据）。
  if (
    content.status === "waiting_user" ||
    content.completionKind === "awaiting_input"
  ) {
    return false;
  }
  // 回合受理回执（content 带 directive，用户每发一句话服务端就写一条）不是
  // 分析完成消息。它有非空 text，若不在这里挡住，恰好落进 succeeded 宽限
  // 窗口的回执会把直播缓冲整体丢弃——真正的完成消息还没到，答案直接白屏。
  if ("directive" in content) return false;
  if (asText(content.text)) return true;
  return Array.isArray(content.charts) && content.charts.length > 0;
}

/**
 * 该作业的权威落库消息是否已经到场（或作业已终局失败/取消）。
 * true ⇒ 丢弃直播缓冲，只渲染 durable 消息——两者绝不同屏。
 */
export function answerHandedOff(
  streamJob: AnswerStreamJob,
  jobs: readonly HandoffJobLike[],
  messages: readonly HandoffMessageLike[],
): boolean {
  const job = jobs.find((candidate) => candidate.id === streamJob.harnessJobId);
  if (job && (job.status === "failed_terminal" || job.status === "cancelled")) {
    return true;
  }
  // 完整答案只可能出现在最新分片之后。
  const anchor = streamJob.lastDeltaAt ?? streamJob.lastEventAt;
  for (const message of messages) {
    if (message.role === "user") continue;
    if (!isAnswerContent(message.content)) continue;
    // 生产端在完成消息 content 上盖了作业 id（服务端 e2e 断言）。有章就精确判：
    // 指名本作业 ⇒ 交接；下面的 commandId/correlation/宽限期启发式只服务没有章的
    // 旧消息与其它消息类型。
    if (isRecord(message.content)) {
      const stamped = asText(message.content.harnessJobId);
      if (stamped) {
        if (stamped === streamJob.harnessJobId) return true;
        continue; // 指名别的作业的答案，绝不拿来交接本作业。
      }
    }
    if (
      job?.commandId &&
      message.commandId === job.commandId &&
      message.createdAt >= anchor
    ) {
      return true;
    }
    if (
      message.correlationId &&
      streamJob.correlationIds.includes(message.correlationId) &&
      message.createdAt >= anchor
    ) {
      return true;
    }
    // 宽限兜底同样受 anchor 约束：完整答案只可能出现在最新分片之后，早于它的
    // 消息（比如上一轮的旧回执）绝不允许拿来交接。
    if (
      job?.status === "succeeded" &&
      message.createdAt >= anchor &&
      message.createdAt >= (job.finishedAt ?? anchor) - DURABLE_MESSAGE_GRACE_MS
    ) {
      return true;
    }
  }
  return false;
}

// ── #ONTOCODE-MEM / #ONTOCODE-COMPREHEND: 继承来源 ────────────────────────────

const EMPTY_PROVENANCE: AnswerProvenance = {
  comprehension: null,
  recall: null,
  folds: 0,
  foldRefusals: [],
};

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function asRefusals(
  v: unknown,
): Array<{ kind: string; count: number; detail?: string }> {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item) => {
    if (!isRecord(item) || typeof item.kind !== "string") return [];
    const detail = asText(item.detail);
    return [{ kind: item.kind, count: asNumber(item.count), ...(detail ? { detail } : {}) }];
  });
}

/**
 * 把一条继承来源帧并入常驻槽。
 *
 * 折叠与【被拒绝的】折叠分开计数：拒绝意味着没有无损归档、因此根本没有折叠，
 * 把它算进折叠数会凭空捏造一次遗忘；反过来只记折叠、丢掉拒绝理由，又会让
 * 「为什么这次没压缩就停了」永远说不清。
 */
export function mergeProvenance(
  current: AnswerProvenance | null,
  type: string,
  payload: Record<string, unknown>,
): AnswerProvenance | null {
  const base = current ?? EMPTY_PROVENANCE;
  if (type === ANSWER_STREAM_TYPES.comprehension) {
    return {
      ...base,
      comprehension: {
        reused: payload.reused === true,
        anchorsTotal: asNumber(payload.anchorsTotal),
        understood: asNumber(payload.understood),
        carriedForward: asNumber(payload.carriedForward),
        reestablished: asNumber(payload.reestablished),
        staleDiscarded: asNumber(payload.staleDiscarded),
        withdrawn: asNumber(payload.withdrawn),
        refused: asRefusals(payload.refused),
      },
    };
  }
  if (type === ANSWER_STREAM_TYPES.memoryRecall) {
    return {
      ...base,
      recall: {
        recalled: asNumber(payload.recalled),
        refused: asNumber(payload.refused),
        belowScore: asNumber(payload.belowScore),
        scanned: asNumber(payload.scanned),
        sources: asStrings(payload.sources),
        failure: asText(payload.failure),
      },
    };
  }
  if (type === ANSWER_STREAM_TYPES.contextFold) {
    if (payload.status === "refused") {
      const reason = asText(payload.reason) ?? "unknown";
      return { ...base, foldRefusals: [...base.foldRefusals, reason] };
    }
    return { ...base, folds: base.folds + 1 };
  }
  return current;
}

/**
 * 一行人话。规则：省下来的读取要说，丢掉的理解也要说，未完成的必须带真实条数
 * ——只报好消息会让一次半途而废的理解看起来和一次完整理解一样。
 */
export function formatAnswerProvenance(provenance: AnswerProvenance): string {
  const parts: string[] = [];
  const comprehension = provenance.comprehension;
  if (comprehension) {
    parts.push(
      comprehension.reused
        ? `沿用了对本体的既有理解 ${comprehension.understood}/${comprehension.anchorsTotal} 项，本次没有重新理解本体`
        : `对本体的理解可用 ${comprehension.understood}/${comprehension.anchorsTotal} 项（沿用 ${comprehension.carriedForward}、本次新读 ${comprehension.reestablished}）`,
    );
    if (comprehension.staleDiscarded > 0) {
      parts.push(`${comprehension.staleDiscarded} 项因本体已变而未沿用旧理解`);
    }
    if (comprehension.withdrawn > 0) {
      parts.push(`${comprehension.withdrawn} 项因实体已不存在而撤回旧理解`);
    }
    for (const refusal of comprehension.refused) {
      parts.push(`${refusal.count} 项未完成理解（${refusal.kind}）`);
    }
  }
  const recall = provenance.recall;
  if (recall) {
    if (recall.recalled > 0) {
      parts.push(
        `被 ${recall.recalled} 条更早会话的结论预置为背景（未在本次本体上重新核对）`,
      );
    }
    if (recall.refused > 0) {
      parts.push(`另有 ${recall.refused} 条历史结论因出处不符被拒绝载入`);
    }
    if (recall.failure) parts.push(`历史结论读取失败：${recall.failure}`);
  }
  if (provenance.folds > 0) {
    parts.push(`本次分析经历过 ${provenance.folds} 次上下文压缩`);
  }
  for (const reason of provenance.foldRefusals) {
    parts.push(`一次上下文压缩被拒绝（${reason}），本次没有压缩`);
  }
  return parts.join("；");
}
