/**
 * #ASSISTANT-PROGRESS —— 对话推理的过程帧。
 *
 * 这条路径此前在「已受理」和「模型回复完成」之间一帧不发：
 * `startOntoCodeAssistantStep` / `completeOntoCodeAssistantStep` 只写
 * `ontocode_assistant_steps`，不产生任何会话事件。于是 5–9 秒的模型调用在
 * 推理面板上是纯黑盒——旁边的 Ontology 分析却逐行长出来，因为它是 Harness
 * 作业，有 `progress()` 通道。
 *
 * ── 一帧 = 一次真实完成的工作 ─────────────────────────────────────────
 *
 * 这个模块唯一的纪律是：**一帧只能在一次真实的 await 已经 resolve、或一次真实
 * 的模型回合已经返回之后发出，payload 只许记录已经发生的事实。**
 *
 * 所以这里没有、也永远不会有计时器。中央网关到 provider 全链路是单发调用
 * (`ProviderAdapter.chat(): Promise<ChatResponse>`，`stream: false`)，拿不到
 * token 增量；把一段已经生成完的文本切片后定时吐出去是假流式。屏幕上是「一步
 * 一步」出现，不是「一个字一个字」出现——这两件事必须被如实区分。
 *
 * ── 命名空间 ─────────────────────────────────────────────────────────
 *
 * 帧类型走 `harness.assistant.<后缀>`，`harnessJobId` 恒为 null。`harness.`
 * 在这里是**帧词汇**的命名空间，不是作业运行器的命名空间：前端两条泳道的分流
 * 键是 `harnessJobId`，为 null 就进对话泳道，不会被误当成一个 Harness 作业。
 * 收益是决定性的——后缀全部取自既有的 `HARNESS_TELEMETRY_FRAME_SUFFIXES`，
 * 前端的通用后缀标签、正文读取与推理计数立刻覆盖对话路径，不必发明第三套方言。
 */

import {
  ONTOCODE_COMMAND_POLICY,
  type OntoCodeAutonomyMode,
} from "@agentic/contracts";
import type { OntologyStructuralAnalysis } from "@agentic/agent-factory";
import type {
  OntoCodeAssistantPlan,
  OntoCodeAssistantPlannerHistoryProjection,
} from "./ontocode-assistant-planner";
import { redactOntoCodeTurnText } from "./ontocode-assistant-run-store";

/**
 * 对话推理这一轮会发的全部帧类型。
 *
 * 每个后缀都已在前端 `HARNESS_TELEMETRY_FRAME_SUFFIXES` 里、已有中文标签、
 * 且 `eventDetail` 已经会读它的字段——新增一个不在清单里的后缀会让
 * `harness-frames.test.ts` 当场变红，这正是这份常量表存在的意义。
 */
export const ONTOCODE_ASSISTANT_PROGRESS_FRAMES = {
  /** 本轮取用的 Ontology 与工具目录规模。三路并发全部 resolve 之后。 */
  sourceScope: "harness.assistant.source_scope",
  /** 历史预算与真实丢弃字数。上下文编译 + 持久化返回之后。 */
  budget: "harness.assistant.budget",
  /**
   * 大脑决定去查一件事，并说清为什么。发在 provider 已经把这次工具调用返回
   * 之后——一帧 = 一次真实的模型回合，绝不是把一次调用切成几片。
   *
   * 这一帧就是黑箱的解药：单次 JSON 调用没有中间态可报，多回合有。
   */
  toolCall: "harness.assistant.tool_call",
  /** 工具执行完之后立即发，带真实结果摘要与它自陈的截断。 */
  toolResult: "harness.assistant.tool_result",
  /*
   * 这里曾经有 strategy / reasoning_step / deliberation 三种帧：模型在计划 JSON
   * 里声明一种推理方法，服务端真的跑一遍推理内核。它们已经被**删掉**，因为在
   * 对话场景里那条路不可达也没人走——
   *   · 出厂 maxModelCalls=3 时审议额度恒为 1（永远给收尾留一次），reflection
   *     要 2、debate/tot 要 branches+1=4，全部 refused；只剩 cot 能跑，而 cot 的
   *     子步帧与方法级帧内容重合，多花一个往返换不来一个字。
   *   · 33 轮真实对话（上一轮 25 + 本轮实测 8）里模型一次都没声明过非 react。
   *   · 让它可达就得加预算，而单次往返实测中位 5.4 秒——为一个没人用的机制让
   *     FDE 多等十几秒，方向是反的。
   * 分析路径（ontology_analysis / blueprint / scope）的推理内核不受影响：那里
   * 是后台作业，没有人在聊天框前面等。
   */
  /** 每一次 provider 返回之后——ordinal 即第几次真实调用。 */
  model: "harness.assistant.model",
  /** 契约 + 引用校验完成之后。 */
  validation: "harness.assistant.validation",
  /** 解析失败、重整调用发起之前。 */
  refine: "harness.assistant.refine",
  /** 计划解析成功之后：模型自陈的判断理由。 */
  plan: "harness.assistant.plan",
  /** 自主度裁决之后：模型想做什么 vs 实际会做什么。 */
  policy: "harness.assistant.policy",
  /** 任一失败路径。一轮只留一条——第一条才是根因。 */
  brainError: "harness.assistant.brain_error",
  /** 超出本轮帧预算时的收尾帧，带真实丢弃条数。 */
  budgetDropped: "harness.assistant.telemetry_budget_dropped",
} as const;

export type OntoCodeAssistantProgressFrameType =
  (typeof ONTOCODE_ASSISTANT_PROGRESS_FRAMES)[keyof typeof ONTOCODE_ASSISTANT_PROGRESS_FRAMES];

export const ONTOCODE_ASSISTANT_MAX_PROGRESS_FRAMES_ENV =
  "ONTOCODE_ASSISTANT_MAX_PROGRESS_FRAMES";
/**
 * 一轮对话实际只发 6–8 帧。40 是给后续真工具循环留的头寸，不是用来卡 M1 的。
 */
export const ONTOCODE_ASSISTANT_MAX_PROGRESS_FRAMES_DEFAULT = 40;

export function resolveOntoCodeAssistantMaxProgressFrames(): number {
  const raw = Number(process.env[ONTOCODE_ASSISTANT_MAX_PROGRESS_FRAMES_ENV]);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : ONTOCODE_ASSISTANT_MAX_PROGRESS_FRAMES_DEFAULT;
}

export interface OntoCodeAssistantProgressWriteInput {
  type: string;
  payload: Record<string, unknown>;
}

/** 落库动作。桥只负责预算与顺序纪律，持久化归调用方。 */
export type OntoCodeAssistantProgressWriter = (
  input: OntoCodeAssistantProgressWriteInput,
) => void | Promise<void>;

export interface OntoCodeAssistantProgressBridge {
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
  /** 一轮只留一条出错帧：第一条是根因，后面的都是它的回声。 */
  emitBrainErrorOnce(input: {
    errorMessage: string;
    phase: string;
  }): Promise<void>;
  /** 轮次收尾。有丢弃就发且只发一条收尾帧，把真实条数报出来。 */
  finish(): Promise<OntoCodeAssistantProgressFinish>;
  stats(): { emitted: number; dropped: number };
}

/**
 * 收尾的回执。
 *
 * `reported:false` 是「连『丢了多少』这句话都没写进去」——收尾帧自己也被丢了。
 * 以前这条路径上 `write()` 的返回值被无视，于是最后一层honesty有个洞：一次
 * 帧通道故障会让轨迹看起来完整无缺。桥自己没有别的通道可用（它唯一能做的事
 * 就是写帧，而写帧正好坏了），所以它把这个事实【返回】给调用方，由调用方写进
 * 服务端日志——说出来的地方可以换，说不说不能换。
 */
export interface OntoCodeAssistantProgressFinish {
  /** 本轮真实丢弃的帧数，包含收尾帧自身没写成的那一条。 */
  dropped: number;
  /** 丢弃条数是否真的落到了轨迹上。dropped===0 时恒为 true（无需上报）。 */
  reported: boolean;
}

/**
 * 每轮新建一个。ordinal 与预算计数都活在这一轮里，绝不跨轮复用——跨轮复用会让
 * 第二轮的序号从第一轮的尾巴接着长，读者永远对不上「这是第几次调用」。
 */
export function createOntoCodeAssistantProgressBridge(input: {
  write: OntoCodeAssistantProgressWriter;
  maxFrames?: number;
}): OntoCodeAssistantProgressBridge {
  const maxFrames =
    input.maxFrames !== undefined && Number.isFinite(input.maxFrames)
      ? Math.max(1, Math.floor(input.maxFrames))
      : resolveOntoCodeAssistantMaxProgressFrames();
  let emitted = 0;
  let dropped = 0;
  let brainErrorEmitted = false;

  const write = async (
    type: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await input.write({ type, payload });
      return true;
    } catch {
      // 发帧失败不许拖垮这一轮对话——但也不许静默：它进丢弃计数，收尾帧照报。
      return false;
    }
  };

  return {
    emit: async (type, payload) => {
      if (
        type === ONTOCODE_ASSISTANT_PROGRESS_FRAMES.brainError &&
        brainErrorEmitted
      ) {
        return;
      }
      if (emitted >= maxFrames) {
        dropped += 1;
        return;
      }
      if (type === ONTOCODE_ASSISTANT_PROGRESS_FRAMES.brainError) {
        brainErrorEmitted = true;
      }
      // 先 await 落库、成功了才计数。反过来会让一次写入失败静默吞掉一帧而计数
      // 仍然连续——下游连个洞都看不见。
      if (await write(type, payload)) emitted += 1;
      else dropped += 1;
    },
    emitBrainErrorOnce: async ({ errorMessage, phase }) => {
      if (brainErrorEmitted) return;
      brainErrorEmitted = true;
      if (emitted >= maxFrames) {
        dropped += 1;
        return;
      }
      if (
        await write(ONTOCODE_ASSISTANT_PROGRESS_FRAMES.brainError, {
          errorMessage,
          phase,
        })
      ) {
        emitted += 1;
      } else {
        dropped += 1;
      }
    },
    finish: async () => {
      if (dropped <= 0) return { dropped: 0, reported: true };
      // 这一条不受预算约束：它存在的全部理由就是把预算吃掉的数量说出来。
      const reported = await write(
        ONTOCODE_ASSISTANT_PROGRESS_FRAMES.budgetDropped,
        { dropped },
      );
      // 收尾帧自己没写成，它也是一条被丢掉的帧——计进去，并把「没报出去」如实
      // 交回调用方。静默地少一条，和完整的一条，在屏幕上长得一模一样。
      if (!reported) dropped += 1;
      return { dropped, reported };
    },
    stats: () => ({ emitted, dropped }),
  };
}

/* ── payload 构造器 ────────────────────────────────────────────────────────
 *
 * 全部是纯函数，且全部只接受**已经算出来的真实数字**。它们不去读库、不发起
 * 调用、也没有任何默认值兜底：拿不到的东西保持缺席（`undefined`），绝不写 0。
 * 「0」和「没记录」在屏幕上长得一样，但一个是事实、一个是谎。
 * ------------------------------------------------------------------------ */

const BEHAVIOR_LABEL: Record<string, string> = {
  explain: "解释",
  clarify: "反问",
  navigate: "带你去对应位置",
  execute: "执行",
};

const AUTONOMY_LABEL: Record<OntoCodeAutonomyMode, string> = {
  guide: "仅分析",
  copilot: "每步确认",
  sandbox_autopilot: "自主执行",
};

/* 每一处截断都有名字。裸字面量会让「这一行为什么只有这么长」无处可查。 */
const ASSISTANT_TOOL_NAME_CHARS = 120;
const ASSISTANT_TOOL_REASONING_CHARS = 300;
const ASSISTANT_TOOL_ARGS_CHARS = 200;
const ASSISTANT_TOOL_SUMMARY_CHARS = 400;

function clip(value: string, max: number): string {
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 模型写的自然语言在进帧之前照样过脱敏——证据不许成为泄漏点。 */
function humanText(value: string, max: number): string {
  return clip(redactOntoCodeTurnText(value), max);
}

export function assistantSourceScopeFramePayload(input: {
  ontologyCounts: OntologyStructuralAnalysis["counts"] | null;
  toolCatalogStatus: "loaded" | "unavailable";
  toolCount: number;
  configurableSystemCount: number;
}): Record<string, unknown> {
  const notes: string[] = [];
  if (input.ontologyCounts === null) {
    notes.push("本轮没拿到 Ontology 摘要，下面的判断不以它为依据");
  }
  if (input.toolCatalogStatus === "unavailable") {
    notes.push("工具清单这次没读到，不代表这个域没有工具");
  }
  if (input.configurableSystemCount > 0) {
    notes.push(`可接入的外部系统 ${input.configurableSystemCount} 个`);
  }
  return {
    ...(input.ontologyCounts
      ? {
          counts: {
            动作: input.ontologyCounts.actions,
            事件: input.ontologyCounts.events,
            对象: input.ontologyCounts.objects,
            关系: input.ontologyCounts.links,
            工具: input.toolCount,
          },
        }
      : {}),
    ...(notes.length > 0 ? { note: notes.join("；") } : {}),
  };
}

/**
 * 历史预算帧。**没有可说的就返回 null**，调用方据此不发。
 *
 * 首轮对话上这一帧长这样：「丢弃字符 0 · 历史消息 1」——它占掉推理轨迹上一整
 * 行，却没有回答任何人会问的问题。这一帧存在的理由只有一个：**这一轮有东西没
 * 进模型视野**。没有折叠、没有丢字、也没有附件引用时，它什么都没说，而一行
 * 废话比不写更糟：它把「过程可见」稀释成「过程有噪音」。
 */
export function assistantBudgetFramePayload(input: {
  history: OntoCodeAssistantPlannerHistoryProjection;
  contextRefCount: number;
}): Record<string, unknown> | null {
  const { history } = input;
  const condensed = history.condensedMessages + history.condensedJobErrors;
  if (history.droppedChars <= 0 && condensed <= 0 && input.contextRefCount <= 0) {
    return null;
  }
  return {
    counts: {
      历史消息: history.messages.length,
      原始字符: history.totalRawChars,
      丢弃字符: history.droppedChars,
      附件引用: input.contextRefCount,
      ...(condensed > 0 ? { 已折叠条目: condensed } : {}),
    },
    ...(history.droppedChars > 0
      ? {
          note: "超出预算的历史已折叠，被丢弃的部分不在本轮判断依据内",
        }
      : {}),
  };
}

/**
 * 本轮预算把查证拦住了。
 *
 * 与上面那条历史预算帧同名不同事：那条说的是「有多少历史没进模型视野」，这条
 * 说的是「这一轮不再继续查了，因为额度到顶」。它**只在真的被拦住时**才发，且
 * 必须同时给出已经花掉的真实数量——一句「预算用尽」而不说花了多少，等于把一次
 * 半途而废说成一次完整回答。
 */
/**
 * 本轮预算收口。
 *
 * 两处诚实性在这里被修过（2026-08-04 实测）：
 *  1. 文案与自身计数打架——文案写「已达上限 5 次」，counts 却写「模型调用 4」。
 *     根因是这一帧发在**收尾那次调用之前**，所以计数恒定比上限少 1。现在文案不
 *     再说「已达」，而是说「再调一次就会用满」，并且计数明确标注不含收尾那次。
 *  2. 被预算拦下的查证在轨迹上完全不存在——超预算时只往 results 塞一条
 *     is_error 回给模型，counts 只报已执行的次数。于是「大脑还想查、被我们拦
 *     了」这件事永久不可见。现在多一格「被拦下的查证」；**不新造帧类型**，因为
 *     一个独立的帧会被读成「执行了一次什么」。
 */
export function assistantTurnBudgetFramePayload(input: {
  reason: "tool_calls" | "model_calls" | "tokens" | "wall_clock";
  modelCalls: number;
  toolCalls: number;
  blockedToolCalls?: number;
  tokens?: number;
  elapsedMs: number;
  limit: number;
}): Record<string, unknown> {
  /*
   * `model_calls` 这一句必须与循环真正的预留数对得上。循环留两次（收尾一次、
   * 万一收尾回复不合规的重整一次），所以这一帧发出时离上限还有两次——写「再调用
   * 一次就会用满」在数上就是错的，而这一帧的全部价值就是它的数是真的。
   */
  const remaining = Math.max(0, input.limit - input.modelCalls);
  const REASON_NOTE: Record<string, string> = {
    tool_calls: `本轮 ${input.limit} 次查证的上限已经用满，不再继续查；下面的回答只基于已经查到的部分`,
    model_calls: `本轮 ${input.limit} 次模型调用只剩 ${remaining} 次，要留给把话说完（以及万一要重说一遍），所以不再继续查；下面的回答只基于已经查到的部分`,
    tokens: `本轮已用掉 ${input.tokens ?? 0} 个 token，达到 ${input.limit} 的上限，不再继续查；下面的回答只基于已经查到的部分`,
    wall_clock: `本轮已用满 ${input.limit} 毫秒的时间上限，不再继续查；下面的回答只基于已经查到的部分`,
  };
  return {
    note: REASON_NOTE[input.reason]!,
    counts: {
      "模型调用（不含随后那次收尾调用）": input.modelCalls,
      工具调用: input.toolCalls,
      // 0 也要写出来：缺席会被读成「没统计」，而「一次都没被拦」是一个结论。
      被拦下的查证: input.blockedToolCalls ?? 0,
      ...(typeof input.tokens === "number" ? { 已用token: input.tokens } : {}),
      耗时毫秒: input.elapsedMs,
    },
  };
}

/**
 * 一次工具调用。`reasoning` 是模型自己写的、这一步为什么要做——工具的参数
 * schema 强制它必须给（见 `inquiryParams`），所以它不是提示词里的一句请求，
 * 而是契约。分析路径上那句「列出所有 Action 以确认 actor 是否包含 Agent」就是
 * 这个字段；对话路径此前一个字都没有。
 */
export function assistantToolCallFramePayload(input: {
  tool: string;
  reasoning: string;
  argsSummary?: string;
}): Record<string, unknown> {
  return {
    tool: clip(input.tool, ASSISTANT_TOOL_NAME_CHARS),
    reasoning: humanText(input.reasoning, ASSISTANT_TOOL_REASONING_CHARS),
    ...(input.argsSummary?.trim()
      ? { argsSummary: humanText(input.argsSummary, ASSISTANT_TOOL_ARGS_CHARS) }
      : {}),
  };
}

/** 一次工具返回。`truncated` 只在工具自陈被截断时写——沉默的截断是谎。 */
export function assistantToolResultFramePayload(input: {
  tool: string;
  ok: boolean;
  summary: string;
  truncated?: boolean;
}): Record<string, unknown> {
  return {
    tool: clip(input.tool, ASSISTANT_TOOL_NAME_CHARS),
    ok: input.ok,
    summary: humanText(input.summary, ASSISTANT_TOOL_SUMMARY_CHARS),
    ...(input.truncated ? { truncated: true } : {}),
  };
}

export function assistantModelFramePayload(input: {
  /** 第几次真实的 provider 调用，本轮内从 1 起。 */
  ordinal: number;
  model: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
}): Record<string, unknown> {
  const numeric = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const tokensIn = numeric(input.tokensIn);
  const tokensOut = numeric(input.tokensOut);
  const latencyMs = numeric(input.latencyMs);
  const hasAccounting =
    tokensIn !== null || tokensOut !== null || latencyMs !== null;
  return {
    ordinal: input.ordinal,
    ...(input.model ? { model: input.model } : {}),
    // provider 没报用量就保持缺席。写 0 会被读成「这次什么都没看」——而实测
    // 同一轮 `llm_calls.input_tokens` 是 19_459。
    ...(hasAccounting
      ? {
          counts: {
            ...(tokensIn !== null ? { 输入tokens: tokensIn } : {}),
            ...(tokensOut !== null ? { 输出tokens: tokensOut } : {}),
            ...(latencyMs !== null ? { 耗时毫秒: latencyMs } : {}),
          },
        }
      : {}),
  };
}

export function assistantValidationFramePayload(input: {
  citationValid: number;
  citationUnverified: number;
  /** #HUMAN-TEXT-GUARD-REPLY —— 引擎词汇漏进对话正文的条数。0 也要写：缺席会被
   *  读成「没检查」，而「查了、一条都没有」是一个结论。 */
  vocabularyLeaks?: number;
  issues: readonly string[];
}): Record<string, unknown> {
  return {
    check: "回复契约与引用",
    citationValid: input.citationValid,
    citationUnverified: input.citationUnverified,
    ...(typeof input.vocabularyLeaks === "number"
      ? { vocabularyLeaks: input.vocabularyLeaks }
      : {}),
    count: input.issues.length,
  };
}

export function assistantRefineFramePayload(input: {
  issues: readonly string[];
}): Record<string, unknown> {
  return {
    note: humanText(
      `回复不符合规格：${input.issues.slice(0, 2).join("；")}`,
      300,
    ),
    count: input.issues.length,
  };
}

export function assistantPlanFramePayload(input: {
  plan: OntoCodeAssistantPlan;
}): Record<string, unknown> {
  const { plan } = input;
  // `configure_integration` 是服务端自有动作，没有 Harness 执行器、也不在命令
  // 策略表里。查不到就不写这一格——不是每个 execute 都对应一种作业。
  const jobKind =
    plan.behavior === "execute"
      ? (ONTOCODE_COMMAND_POLICY as Record<string, { jobKind: string }>)[
          plan.action
        ]?.jobKind
      : undefined;
  return {
    summary: humanText(plan.rationaleSummary, 400),
    note: BEHAVIOR_LABEL[plan.behavior] ?? plan.behavior,
    ...(jobKind ? { kind: jobKind } : {}),
    ...(plan.recommendations.length > 0
      ? { counts: { 建议: plan.recommendations.length } }
      : {}),
  };
}

/**
 * 自主度裁决帧。**策略什么都没改就返回 null**，调用方据此不发。
 *
 * 这一帧的全部价值在于「模型想做的事和实际发生的事不一样」。没有差异时它只能
 * 写出「这一轮按「执行」处理」——而同一条轨迹上的计划帧已经用 `note` 说了同一
 * 件事。重复一遍不会让人更明白，只会让真正被降级的那一次不再显眼。
 */
export function assistantPolicyFramePayload(input: {
  modelBehavior: string;
  modelAction: string | null;
  policyBehavior: string;
  policyAction: string | null;
  autonomyMode: OntoCodeAutonomyMode;
}): Record<string, unknown> | null {
  const adjusted =
    input.modelBehavior !== input.policyBehavior ||
    input.modelAction !== input.policyAction;
  if (!adjusted) return null;
  const acted = BEHAVIOR_LABEL[input.policyBehavior] ?? input.policyBehavior;
  const proposed = BEHAVIOR_LABEL[input.modelBehavior] ?? input.modelBehavior;
  return {
    // 「模型想执行、策略把它降成解释」这件事此前在屏幕上完全看不出来。
    summary: `模型建议「${proposed}」，这一轮实际按「${acted}」处理`,
    note: `当前会话是「${AUTONOMY_LABEL[input.autonomyMode]}」，所以先征求你确认，没有直接动手`,
  };
}
