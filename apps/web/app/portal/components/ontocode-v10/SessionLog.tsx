"use client";
// OntoCode v10 · 右栏「日志」与「推理」。
//
// 中栏刻意极简——只留目标、结论和需要你决定的事。全过程（每条消息、每个作业、
// 每个阶段事件）在这里完整呈现，一条都不丢，而不是塞回聊天里。
import React, { useMemo, useState } from "react";
import type {
  OntoCodeAssistantRun,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import { Markdown } from "@/app/portal/components/markdown";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";
import {
  ANSWER_STREAM_TYPES,
  deliberationStatusText,
  reasoningStepName,
  readDegradedFrom,
  readStepError,
} from "./answer-stream";
import {
  JOB_LABEL,
  JOB_STATUS_TEXT,
  jobFailed,
  jobFailureReason,
} from "./job-labels";
import { reasoningPhaseName } from "./reasoning-phase";
import { productFacingOntoCodeText } from "./product-vocabulary";

/**
 * answer_delta 会一场几百条地进日志。逐条列出只会淹没其它事件，
 * 所以同一作业连续的分片折叠成一行「生成回答 · N 片」；分片正文不进日志
 * ——完整回答由聊天里的最终消息承载。
 */
function collapsedDeltaLabel(count: number): string {
  return `生成回答 · ${count} 片`;
}

/**
 * 连续的推理步同理折叠。但只折叠「正常跑完」的步：被降级或失败的那一步是这条
 * 轨迹上最该看见的一行，折进计数里等于把它抹掉。单独一步不折叠——那时摘要还在，
 * 换成计数只会丢信息。
 */
function collapsedStepLabel(count: number): string {
  return `推理步骤 · ${count} 步`;
}

function collapsibleReasoningStep(event: OntoCodeSessionEvent): boolean {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  return !readDegradedFrom(p) && !readStepError(p);
}

/**
 * #INQUIRY-DELIBERATION 的三种帧是跨阶段契约：analysis / blueprint / scope 都在
 * 各自的命名空间下按同一 payload 形状发（服务端两处 emitter 都明说 mirror the
 * analysis vocabulary）。识别按后缀而不是逐命名空间枚举——未来新增阶段自动获得
 * 同样的标签、正文与折叠纪律，这正是不变量测试锁住的结构性质。
 */
const DELIBERATION_FRAME_RE =
  /^harness\.[a-z_]+\.(strategy|reasoning_step|deliberation)$/;

type DeliberationFrameKind = "strategy" | "reasoning_step" | "deliberation";

function deliberationFrameKind(type: string): DeliberationFrameKind | null {
  const match = DELIBERATION_FRAME_RE.exec(type);
  return match ? (match[1] as DeliberationFrameKind) : null;
}

function isReasoningStepFrame(type: string): boolean {
  return deliberationFrameKind(type) === "reasoning_step";
}

/**
 * 未知帧的兜底文案。以前这里返回原始类型，`harness.build.factory_started`
 * 这类内部标识就这么印在 FDE 眼前。棘轮（harness-frames.ts + panel-content
 * 测试）保证服务端在发的每一种帧都有真标签，所以这句只会落在「服务端新加了
 * 帧但标签还没跟上」的窗口期，而不是日常。
 */
export const UNLABELLED_EVENT_LABEL = "其它事件";

/** 事件类型 → 人话。 */
export function eventLabel(type: string): string {
  const map: Record<string, string> = {
    "session.created": "会话创建",
    "session.updated": "会话更新",
    "session.completed": "会话完成",
    "session.retired": "会话归档",
    "session.message.appended": "消息",
    "session.phase.changed": "阶段变化",
    "ai.plan.proposed": "AI 计划",
    // 对话侧（非 Harness 作业）的助手运行。这些事件的 harnessJobId 恒为 null。
    "assistant.run.accepted": "对话 · 已受理",
    "assistant.run.succeeded": "对话 · 模型回复完成",
    "assistant.run.failed": "对话 · 模型回复失败",
    "configuration.task.created": "配置任务",
    "configuration.task.cancelled": "配置任务已取消",
    "configuration.task.superseded": "配置任务被替代",
    "configuration.task.verification_pending": "配置校验中",
    "configuration.task.verification_failed": "配置校验失败",
    "configuration.task.verified": "配置已通过校验",
    "harness.job.queued": "作业入队",
    "harness.job.leased": "作业领取",
    "harness.job.started": "作业开始",
    "harness.job.succeeded": "作业完成",
    "harness.job.failed": "作业失败",
    "harness.job.cancelled": "作业已取消",
    "harness.job.waiting_user": "等待你回答",
    "harness.job.budget_warning": "超出预算（继续执行）",
    "harness.job.retry_scheduled": "安排重试",
    "harness.job.recovered": "作业恢复",
    "harness.job.input_resolved": "输入已确定",
    "artifact.created": "产物写入",
    "artifact.version.created": "产物版本写入",
    "evidence.recorded": "证据记录",
    "changeset.created": "变更记录建立",
    "changeset.committed": "变更已提交",
    "candidate.package.created": "候选包生成",
    "candidate.head.moved": "候选包更新",
    "ontology.revision": "本体修订",
    "ontology.heal": "本体自愈",
    "ontology.source.shadowed": "本体来源被覆盖",
    "workspace.directive.emitted": "界面指令",
    "workspace.patch.committed": "工作区改动已提交",
  };
  if (map[type]) return map[type]!;
  if (/^harness\.ontology_analysis\./.test(type)) {
    const phase = type.split(".").pop() ?? "";
    const phases: Record<string, string> = {
      plan: "分析 · 读取结构",
      observation: "分析 · 探针观察",
      // Emitted by the analysis executor's citation re-check. Without an entry
      // here the phase branch swallows it before the generic step map is
      // consulted, and the row renders as "分析 · validation".
      validation: "分析 · 引用校验",
      synthesis: "分析 · 归纳结论",
      interpret_started: "分析 · 开始解释（调模型）",
      interpret_completed: "分析 · 解释完成",
      interpret_failed: "分析 · 模型解释未完成",
      // 流式回答帧。这个分支在通用 step 映射之前拦截，缺条目就会渲染成
      // "分析 · tool_call" 这样的半生不熟标签。
      tool_call: "分析 · 调用工具",
      tool_result: "分析 · 工具结果",
      chart: "分析 · 生成图表",
      // table 以前不在这张表里——于是它渲染成「分析 · table」，正是这条分支
      // 顶上那段注释警告过的半生不熟标签。
      table: "分析 · 生成表格",
      context_fold: "分析 · 折叠上下文",
      memory_recall: "分析 · 召回记忆",
      // 「本体没变就不重新理解」是后端真做到的事。它以前也落在「其它事件」里，
      // 于是省下的那趟推理在屏幕上无从证实。
      comprehension: "分析 · 本体理解",
      answer_delta: "分析 · 生成回答",
      answer_delta_truncated: "回答分片已达上限（完整内容在最终消息里）",
      // 大脑声明并真的执行的推理方法。同样被这个分支先拦下，缺条目就渲染成
      // 「分析 · strategy」这种半生不熟的标签。
      strategy: "分析 · 推理方法",
      reasoning_step: "分析 · 推理步骤",
      deliberation: "分析 · 审议结果",
    };
    // 命中才返回。以前这里兜底成「分析 · <phase>」——看着像标签，其实是把
    // 内部帧名拼进了正文。认不出就继续走下面的通用映射，再兜底成中性文案。
    if (phases[phase]) return phases[phase]!;
  }
  // #BLUEPRINT-REASON —— 蓝图阶段自己的帧。命中才返回；其余（stage 等通用帧）
  // 继续走下面的通用映射，不因这个分支反而变生。
  if (/^harness\.blueprint\./.test(type)) {
    const phase = type.split(".").pop() ?? "";
    const phases: Record<string, string> = {
      // 骨架是机械派生的（服务端在 payload 里自陈 derivation），标签必须说明，
      // 免得一秒钟出来的结构被读成飞快的思考。
      grounded: "蓝图 · 基于本体",
      strategy: "蓝图 · 推理方法",
      reasoning_step: "蓝图 · 推理步骤",
      deliberation: "蓝图 · 审议结果",
    };
    if (phases[phase]) return phases[phase]!;
  }
  // #HARNESS-TELEMETRY —— Harness 真实决策与工具帧。以前这些事件没有被桥接，
  // 「推理」页只能显示阶段标记，看上去像什么都没发生。
  const step = type.match(/^harness\.[a-z_]+\.([a-z_]+)$/)?.[1];
  const steps: Record<string, string> = {
    stage: "阶段进展",
    // Older runs persisted ordinary assistant deltas under this misleading
    // name. Keep them readable, but never call them hidden reasoning.
    thinking: "历史模型输出片段（非推理）",
    tool_call: "调用工具",
    tool_progress: "工具执行中",
    tool_result: "工具结果",
    plan: "制定计划",
    validation: "校验",
    ontology_read: "读取本体",
    narration: "说明",
    brain_error: "出错",
    telemetry_truncated: "明细记录已达上限",
    agent_created: "生成 Agent",
    readiness: "就绪度评估",
    test_cases: "测试用例",
    sandbox: "沙箱执行",
    clarification: "需要你决定",
    policy: "执行策略",
    strategy: "推理方法",
    reasoning_step: "推理摘要",
    // 任何命名空间的审议结果帧都不许以原始类型示人——scope 今天就在发，
    // 未来的阶段照样兜得住。
    deliberation: "审议结果",
    declared_gap: "模型声明的缺口",
    model: "模型路由",
    reflection: "反思",
    flow_blueprint: "蓝图生成",
    // 以下都是服务端在发、但以前没有标签的帧：它们过去直接以原始类型示人。
    completed: "阶段完成",
    waiting_user: "等待你回答",
    factory_started: "开始生成",
    factory_reconnected: "恢复代码生成",
    acceptance: "验收判定",
    telemetry_incomplete: "明细记录不完整",
    ontology_loaded: "已读取本体",
    continuation: "自动继续",
    preflight: "上线前检查",
    promoted: "已上线",
    configuration_verified: "配置已验证",
    // ── 自我修正回路 ──
    // 「大脑到底在想什么」大半就是这几行：它评了自己的草稿、改了、看着分数
    // 动、有时又退回去。这些帧服务端一直在发，前端一个都不认识，于是三十多
    // 种推理活动在推理面板上排成一列一模一样的「其它事件」。
    refine: "自我修正",
    score_delta: "评分变化",
    revert: "回退到上一版",
    inspect: "查看运行结果",
    code: "生成代码",
    draft_generated: "生成草稿",
    // ── 委派 ──
    subagent_start: "委派子任务",
    subagent_done: "子任务完成",
    group_start: "并行小组开始",
    group_done: "并行小组完成",
    // ── 测试与人工边界 ──
    test_decision: "测试判定",
    boundary_cases: "人工边界待确认",
    boundary_decided: "人工边界已确认",
    clarification_resolved: "你的回答已采纳",
    user_message: "你的消息",
    // ── 为什么停下来 ──
    budget: "预算与用量",
    compaction: "折叠上下文",
    failed: "阶段失败",
    // ── 造工具与检索 ──
    tool_created: "新建工具",
    tool_search: "检索工具",
    tool_schema: "读取工具参数",
    skill_created: "沉淀技能",
    web_result: "联网检索结果",
    // ── Ontology 出处与改动 ──
    source_scope: "本次取用的本体范围",
    virtual_action_created: "新建虚拟动作",
    ontology_revision: "本体修订建议",
    ontology_heal: "本体自愈",
    flow_business: "业务流程建模",
    assumption_applied: "自行补齐的假设",
    sandbox_attempt_started: "沙箱执行开始",
    // ── 记录本身的缺口 ──
    // 明细丢了多少必须说出来；一条不完整的轨迹看起来和一条完整的轨迹一样。
    telemetry_suppressed: "部分明细未记录",
    telemetry_budget_dropped: "明细超出上限（部分未记录）",
    telemetry_unbridged: "有明细未接入界面",
  };
  if (step && steps[step]) return steps[step]!;
  return UNLABELLED_EVENT_LABEL;
}

/**
 * 未知帧的原始类型。信息不丢，但它是内部标识——按本仓一贯做法降级为 hover，
 * 不占正文那一行。已识别的帧返回 null（没有可补的东西）。
 */
export function eventTypeHint(type: string): string | null {
  return eventLabel(type) === UNLABELLED_EVENT_LABEL ? type : null;
}

function timeOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function messageText(m: OntoCodeMessage): string | null {
  const content = m.content as { text?: unknown };
  if (typeof content?.text !== "string" || !content.text.trim()) return null;
  const text = content.text.trim();
  return m.role === "user" ? text : productFacingOntoCodeText(text);
}

export interface SessionLogViewProps {
  messages: OntoCodeMessage[];
  events: OntoCodeSessionEvent[];
  jobs: OntoCodeHarnessJob[];
  /** 事件超过取回上限：显示的不是全部，必须说出来。 */
  truncated?: boolean;
}

type LogEntry =
  | { at: number; kind: "message"; id: string; role: string; text: string }
  | {
      at: number;
      kind: "event";
      id: string;
      type: string;
      detail: string;
      harnessJobId: string | null;
      /** 仅 answer_delta：这一行折叠了多少个连续分片。 */
      deltaCount?: number;
      /** 仅 reasoning_step：这一行折叠了多少个连续的正常推理步。 */
      stepCount?: number;
      /** 仅 reasoning_step：这一步没有降级、没有失败，可以被折叠。 */
      collapsible?: boolean;
    };

function clipText(v: unknown, max = 160): string | null {
  if (typeof v !== "string") return null;
  const text = v.trim().replace(/\s+/g, " ");
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function chainOf(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const names = v.filter((item): item is string => typeof item === "string");
  return names.length > 0 ? names.join(" → ") : null;
}

/**
 * #INQUIRY-DELIBERATION 三种帧的正文。通用读法一个字段都对不上（既没有 tool，
 * 也没有 text / summary / counts），不专门认就整行只剩一个标签。按后缀识别：
 * blueprint / scope 的同名帧按契约同形，共用同一套读法。
 */
function deliberationDetail(event: OntoCodeSessionEvent): string | null {
  const kind = deliberationFrameKind(event.type);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const bits: (string | null)[] = [];

  if (kind === "strategy") {
    const chain = chainOf(p.steps);
    bits.push(chain);
    // 服务端先验只是建议。模型改了主意、还是照单全收，是两回事。
    const suggestion = typeof p.suggestion === "string" ? p.suggestion : null;
    if (p.chosenBy === "default") bits.push("沿用默认");
    else if (p.chosenBy === "ai") {
      bits.push(
        suggestion && chain !== suggestion
          ? `模型自选（建议 ${suggestion}）`
          : "模型采纳建议",
      );
    }
    bits.push(clipText(p.rationale));
  } else if (kind === "reasoning_step") {
    const name = reasoningStepName(p);
    const index = typeof p.index === "number" ? p.index + 1 : null;
    const total = typeof p.total === "number" ? p.total : null;
    // 内核子步的角色（起草 / 自审 / 重写 / 论证 2 / …）。没有它，一次 reflection
    // 的三次真实模型调用在屏幕上是三行一模一样的「reflection 1/3、2/3、3/3」。
    // 认不出的角色宁可缺席也不印原值——它是引擎内部标识；内核多一个角色时
    // `reasoning-phase.test.ts` 会当场变红，那才是补名字的地方。
    const phase =
      typeof p.phase === "string" ? reasoningPhaseName(p.phase) : null;
    const head = phase ? `${name} ${phase}` : name;
    bits.push(
      index !== null && total !== null ? `${head} ${index}/${total}` : head,
    );
    const error = readStepError(p);
    if (error) bits.push(`失败：${clipText(error, 80)}`);
    bits.push(clipText(p.output));
  } else if (kind === "deliberation") {
    bits.push(
      deliberationStatusText(typeof p.status === "string" ? p.status : null),
    );
    const executed = chainOf(p.executed);
    if (executed) bits.push(`执行 ${executed}`);
    bits.push(clipText(p.detail));
  } else {
    return null;
  }

  const text = bits.filter((bit): bit is string => Boolean(bit)).slice(0, 3);
  return text.length > 0 ? text.join(" · ") : null;
}

/**
 * 本体理解帧的正文。这一帧的全部意义在于「这次到底重新理解了没有」——
 * 它自陈 `reused`，正文就必须把这个判断摆在第一位，否则界面证实不了后端
 * 真的省下了那趟推理。
 */
function comprehensionDetail(p: Record<string, unknown>): string[] {
  if (typeof p.anchorsTotal !== "number" || typeof p.reused !== "boolean") {
    return [];
  }
  const bits = [p.reused ? "沿用既有理解" : "重新理解本体"];
  if (typeof p.understood === "number") {
    bits.push(`已理解 ${p.understood}/${p.anchorsTotal}`);
  }
  // 结构变了而没沿用的、以及已经消失的，都是这次要重新读的东西。
  const stale = typeof p.staleDiscarded === "number" ? p.staleDiscarded : 0;
  const withdrawn = typeof p.withdrawn === "number" ? p.withdrawn : 0;
  if (stale > 0 || withdrawn > 0) {
    bits.push(`${stale} 项已变更 · ${withdrawn} 项已消失`);
  }
  return bits;
}

function intOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 按帧种类读它自己的字段。
 *
 * 通用读法（tool / summary / count / …）对不上这些帧的任何一个字段，于是
 * 「评分变化」旁边没有分数、「明细超出上限」不说丢了几条——标签有了，信息
 * 还是没有。每条只读服务端真的在发的字段，读不到就不写。
 */
function frameFacts(type: string, p: Record<string, unknown>): string[] {
  const suffix = type.match(/^harness\.[a-z_]+\.([a-z_]+)$/)?.[1] ?? "";
  const bits: (string | null)[] = [];
  const action = clipText(p.actionName, 80);
  switch (suffix) {
    case "refine":
      bits.push(action, clipText(p.critique, 120));
      break;
    case "score_delta": {
      const prior = intOf(p.priorTotal);
      const next = intOf(p.newTotal);
      bits.push(action);
      if (prior !== null && next !== null) bits.push(`${prior} → ${next}`);
      if (p.regression === true) bits.push("比上一版更差");
      break;
    }
    case "revert": {
      const attempt = intOf(p.revertedToAttempt);
      bits.push(action, attempt !== null ? `退回第 ${attempt} 次尝试` : null);
      break;
    }
    case "inspect":
      bits.push(
        clipText(p.agentSlug, 80),
        typeof p.status === "string" ? `运行 ${p.status}` : null,
        clipText(p.error, 120),
      );
      break;
    case "code": {
      const lines = intOf(p.lines);
      bits.push(action, lines !== null ? `${lines} 行` : null);
      break;
    }
    case "subagent_start":
    case "subagent_done":
      bits.push(clipText(p.task, 120), clipText(p.role, 60));
      break;
    case "group_start": {
      const members = intOf(p.members);
      bits.push(
        clipText(p.label, 80),
        members !== null ? `${members} 名成员` : null,
      );
      break;
    }
    case "group_done": {
      const total = intOf(p.total);
      bits.push(
        clipText(p.label, 80),
        typeof p.ok === "boolean" ? (p.ok ? "全部完成" : "有成员未完成") : null,
        total !== null ? `${total} 名成员` : null,
      );
      break;
    }
    case "budget": {
      const turn = intOf(p.turn);
      const maxTurns = intOf(p.maxTurns);
      const tokens = intOf(p.tokens);
      if (turn !== null && maxTurns !== null)
        bits.push(`第 ${turn}/${maxTurns} 轮`);
      if (tokens !== null) bits.push(`${tokens.toLocaleString()} tokens`);
      bits.push(clipText(p.stopReason, 80));
      break;
    }
    case "boundary_cases": {
      const proposals = intOf(p.proposalCount);
      bits.push(
        proposals !== null ? `${proposals} 条待确认` : null,
        p.awaitingDecision === true ? "等你裁决" : null,
      );
      break;
    }
    case "boundary_decided": {
      const decided = intOf(p.eventCount);
      bits.push(decided !== null ? `${decided} 条已确认` : null);
      break;
    }
    case "tool_search":
    case "web_result": {
      const results = intOf(p.resultCount);
      bits.push(
        clipText(p.query, 120),
        results !== null ? `${results} 条结果` : null,
      );
      break;
    }
    case "tool_schema":
      bits.push(clipText(p.method, 20), clipText(p.url, 120));
      break;
    case "tool_created":
      bits.push(
        clipText(p.status, 40),
        p.runtimeActive === false ? "尚未生效" : null,
      );
      break;
    case "skill_created":
      bits.push(clipText(p.name, 80), clipText(p.purpose, 120));
      break;
    case "source_scope": {
      const actions = intOf(p.actionCount);
      bits.push(
        clipText(p.domain, 80),
        actions !== null ? `${actions} 个动作` : null,
        clipText(p.mode, 40),
      );
      break;
    }
    case "virtual_action_created":
      bits.push(clipText(p.name, 80));
      break;
    case "ontology_revision": {
      const proposals = intOf(p.proposalCount);
      bits.push(proposals !== null ? `${proposals} 条建议` : null);
      break;
    }
    case "ontology_heal": {
      const changes = intOf(p.changeCount);
      bits.push(
        changes !== null ? `${changes} 处修补` : null,
        clipText(p.source, 60),
      );
      break;
    }
    case "flow_business": {
      const agents = intOf(p.agents);
      const platforms = intOf(p.platforms);
      if (agents !== null) bits.push(`${agents} 个 Agent`);
      if (platforms !== null) bits.push(`${platforms} 个平台`);
      break;
    }
    case "flow_blueprint": {
      const phases = intOf(p.phaseCount);
      const unresolved = intOf(p.unresolvedCount);
      if (phases !== null) bits.push(`${phases} 个阶段`);
      if (unresolved) bits.push(`${unresolved} 处未接地`);
      break;
    }
    case "sandbox_attempt_started": {
      const attempt = intOf(p.attempt);
      bits.push(attempt !== null ? `第 ${attempt} 次尝试` : null);
      break;
    }
    case "acceptance": {
      const agents = intOf(p.perAgentTotal);
      bits.push(agents !== null ? `${agents} 个 Agent 受检` : null);
      break;
    }
    // 记录本身丢了多少，是这几行存在的全部理由。没有数字就是又一次沉默截断。
    case "telemetry_budget_dropped": {
      const dropped = intOf(p.dropped);
      bits.push(dropped !== null ? `丢弃 ${dropped} 条` : null);
      break;
    }
    case "telemetry_suppressed":
    case "telemetry_unbridged": {
      const total = intOf(p.total);
      bits.push(total !== null ? `${total} 条` : null);
      break;
    }
    default:
      break;
  }
  return bits.filter((bit): bit is string => Boolean(bit));
}

/** 事件 payload 里可读的一行摘要——不 dump 整个 JSON。 */
export function eventDetail(event: OntoCodeSessionEvent): string {
  const deliberation = deliberationDetail(event);
  if (deliberation !== null) return deliberation;
  const p = event.payload as Record<string, unknown>;
  const bits: string[] = [
    ...comprehensionDetail(p),
    ...frameFacts(event.type, p),
  ];
  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim())
      bits.push(`${label}${value}`);
    else if (typeof value === "number") bits.push(`${label}${value}`);
  };
  // 工具帧：工具名 + 大脑自陈的调用理由/结果摘要，这是整条轨迹里最有用的一行。
  if (typeof p?.tool === "string") {
    bits.push(p.tool);
    if (p.ok === false) bits.push("失败");
    push("", p.reasoning);
    push("", p.argsSummary);
    push("", p.note);
  }
  // 图表帧：标题是服务端聚合的自述，比 dump JSON 有用。
  if (p?.chart && typeof p.chart === "object" && !Array.isArray(p.chart)) {
    push("", (p.chart as Record<string, unknown>).title);
  }
  if (typeof p?.pipeline === "string") {
    bits.push(
      [
        p.pipeline,
        typeof p.strategy === "string" ? p.strategy : null,
        typeof p.band === "string" ? p.band : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (Array.isArray(p.reasons)) {
      const reasons = p.reasons
        .filter((reason): reason is string => typeof reason === "string")
        .slice(0, 2)
        .join("；");
      if (reasons) bits.push(reasons);
    }
  }
  if (Array.isArray(p?.steps)) {
    const methods = p.steps
      .filter((step): step is string => typeof step === "string")
      .join(" → ");
    if (methods) bits.push(methods);
    push("", p?.rationale);
  }
  if (typeof p?.model === "string") {
    bits.push(`${p.model}${typeof p.tier === "string" ? ` · ${p.tier}` : ""}`);
    // 难度路由没被满足：这一轮跑的不是这个难度该得的模型。服务端把判定和原因
    // 都放在回执上了，界面不说，等于把一次降级当成一次正常轮次。
    // 字段缺席时保持沉默——「没声明」不等于「满足了」。
    if (p.preferenceSatisfied === false) {
      const why = clipText(p.preferenceReason, 200);
      bits.push(why ? `难度档未满足：${why}` : "难度档未满足（未记录原因）");
    }
  }
  if (
    event.type === "harness.ontology_analysis.interpret_failed" &&
    typeof p?.failureKind === "string"
  ) {
    bits.push(`失败类型 ${p.failureKind}`);
  }
  if (typeof p?.text === "string" && p.text.trim()) {
    const text = p.text.trim().replace(/\s+/g, " ");
    bits.push(text.length > 160 ? `${text.slice(0, 160)}…` : text);
  }
  push("", p?.stage);
  push("", p?.summary);
  push("", p?.message);
  // 校验/声明缺口帧：说清「查了什么、查出什么」，否则这两行只剩一个标签。
  push("", p?.check);
  push("", p?.note);
  if (typeof p?.selected === "number" && typeof p?.resolved === "number") {
    bits.push(`选中 ${p.selected} · 解析通过 ${p.resolved}`);
  }
  if (typeof p?.citationValid === "number") {
    bits.push(
      `引用已校验 ${p.citationValid}${
        typeof p.citationUnverified === "number"
          ? ` · 未校验 ${p.citationUnverified}`
          : ""
      }`,
    );
  }
  if (typeof p?.count === "number") {
    // 校验帧（自陈 `check`：查了什么）上的 count 数的是「查出几处不合规」。
    // 通用的「N 项」在这里读不出主语——`0 项` 尤其糟：它看着像一次没测出东西
    // 的检查，实际是一次全部通过的检查。没有 `check` 的帧维持原读法。
    const checked = typeof p?.check === "string" && p.check.trim().length > 0;
    // #HUMAN-TEXT-GUARD-REPLY —— 引擎词汇漏进对话正文的条数。服务端刻意不在
    // 运行时改写措辞（改写会让缺陷不可见，而多烧一次重整调用去修一句话正是这
    // 一轮要消灭的延迟），它选择如实计数。前端吞掉这个数，这条链就断在最后一
    // 米。0 也写出来：缺席会被读成「没查」，而「查了、一条都没有」是一个结论。
    //
    // 它跟契约结论并成同一格而不是各占一格：这一行只留 3 格，另起一格会把
    // 「查出几处不合规」挤出去——用一个新数字换掉一个旧数字不是诚实，是换个
    // 地方沉默。这一格同时也把「全部通过」拆开：只有契约一项被查过时说「全部」
    // 是过度声明，而两项都查过时读者有权知道是哪两项。
    const leaks = intOf(p?.vocabularyLeaks);
    const contract =
      leaks === null
        ? checked
          ? p.count > 0
            ? `${p.count} 处不符合`
            : "全部通过"
          : `${p.count} 项`
        : p.count > 0
          ? `${p.count} 处不符合`
          : "契约通过";
    bits.push(
      leaks === null
        ? contract
        : leaks > 0
          ? `${contract} · 措辞泄漏 ${leaks} 处`
          : `${contract} · 措辞通过`,
    );
  }
  if (typeof p?.kind === "string") bits.push(JOB_LABEL[p.kind] ?? p.kind);
  if (p?.counts && typeof p.counts === "object") {
    const c = p.counts as Record<string, unknown>;
    const parts = Object.entries(c)
      .filter(([, v]) => typeof v === "number")
      .slice(0, 5)
      .map(([k, v]) => `${k} ${v}`);
    if (parts.length) bits.push(parts.join(" · "));
  }
  if (typeof p?.findings === "number") bits.push(`结论 ${p.findings}`);
  if (typeof p?.probes === "number") bits.push(`探针 ${p.probes}`);
  // 追加在末尾：只会给原本不足 3 条摘要的事件补信息，不会挤掉已有的。
  // 助手运行失败的原因是「大脑到底怎么了」最直接的一行。
  push("", p?.errorMessage);
  push("", p?.phase);
  const shown = bits.filter(Boolean).slice(0, 3);
  // 服务端自陈这条工具结果被截断了。这一行永远保留——摘要看起来完整、实际
  // 只有开头一段，是最容易把人骗过去的一种沉默截断。
  if (p?.truncated === true) shown.push("结果已截断");
  return productFacingOntoCodeText(shown.join(" · "));
}

/**
 * 「只看关键」会滤掉明细帧。滤掉多少条必须报出来——否则这个过滤器和一次
 * 静默丢弃在屏幕上长得一模一样。
 */
function keyEventsFilterHides(event: OntoCodeSessionEvent): boolean {
  if (event.visibility === "user") return false;
  return event.type !== "harness.ontology_analysis.interpret_failed";
}

export function SessionLogView(props: SessionLogViewProps) {
  const [showDebug, setShowDebug] = useState(false);
  const hiddenCount = useMemo(
    () => props.events.filter(keyEventsFilterHides).length,
    [props.events],
  );

  const entries = useMemo<LogEntry[]>(() => {
    const list: LogEntry[] = [];
    for (const m of props.messages) {
      const text = messageText(m);
      if (!text) continue;
      list.push({
        at: m.createdAt,
        kind: "message",
        id: m.id,
        role: m.role,
        text,
      });
    }
    for (const e of props.events) {
      // Analyst may still finish its deterministic structure pass when the
      // model interpretation fails. That is a user-visible partial failure,
      // even if an older producer stamped the telemetry frame as debug.
      const isInterpretFailure =
        e.type === "harness.ontology_analysis.interpret_failed";
      if (!showDebug && e.visibility !== "user" && !isInterpretFailure)
        continue;
      list.push({
        at: e.createdAt,
        kind: "event",
        id: e.id,
        type: e.type,
        // 分片正文永不进日志——几百条 delta 的内容由最终消息完整承载。
        detail:
          e.type === ANSWER_STREAM_TYPES.answerDelta ? "" : eventDetail(e),
        harnessJobId: e.harnessJobId,
        ...(isReasoningStepFrame(e.type)
          ? { collapsible: collapsibleReasoningStep(e) }
          : {}),
      });
    }
    list.sort((a, b) => a.at - b.at);
    // 同一作业连续的 answer_delta 折叠成一行；被其它帧隔断则各自成段。
    const merged: LogEntry[] = [];
    for (const entry of list) {
      const prev = merged[merged.length - 1];
      if (
        entry.kind === "event" &&
        entry.type === ANSWER_STREAM_TYPES.answerDelta &&
        prev?.kind === "event" &&
        prev.type === ANSWER_STREAM_TYPES.answerDelta &&
        prev.harnessJobId === entry.harnessJobId
      ) {
        prev.deltaCount = (prev.deltaCount ?? 1) + 1;
        continue;
      }
      // 正常推理步同理。降级步 / 失败步的 collapsible 为 false，两侧都挡住，
      // 它们既不会被吞进计数行，也不会把后面的步吞进自己这一行。
      if (
        entry.kind === "event" &&
        isReasoningStepFrame(entry.type) &&
        entry.collapsible === true &&
        prev?.kind === "event" &&
        isReasoningStepFrame(prev.type) &&
        prev.collapsible === true &&
        prev.harnessJobId === entry.harnessJobId
      ) {
        prev.stepCount = (prev.stepCount ?? 1) + 1;
        // 折叠后这一行代表多步，首步的摘要不再能代表它。
        prev.detail = "";
        continue;
      }
      merged.push(
        entry.kind === "event" && entry.type === ANSWER_STREAM_TYPES.answerDelta
          ? { ...entry, deltaCount: 1 }
          : entry.kind === "event" && isReasoningStepFrame(entry.type)
            ? { ...entry, stepCount: 1 }
            : entry,
      );
    }
    return merged;
  }, [props.messages, props.events, showDebug]);

  return (
    <div>
      {/* The toolbar stays even when the filter empties the list — otherwise
          hiding debug events also hides the control that brings them back. */}
      <div className={styles.ovSum}>
        <span className={styles.ovChip}>{props.messages.length} 消息</span>
        <span className={styles.ovChip}>
          {props.events.length} 事件{props.truncated ? "（未取完）" : ""}
        </span>
        {!showDebug && hiddenCount > 0 ? (
          <span className={styles.ovChip}>已隐藏 {hiddenCount} 条明细</span>
        ) : null}
        <button
          type="button"
          className={styles.mini}
          onClick={() => setShowDebug((v) => !v)}
        >
          {showDebug ? "只看关键" : "显示全部"}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className={styles.iEmpty}>
          {props.events.length > 0 ? "无关键记录" : "暂无记录"}
        </div>
      ) : null}
      {entries.map((entry) =>
        entry.kind === "message" ? (
          <div key={entry.id} className={styles.logMsg}>
            <div className={styles.logHead}>
              <span
                className={
                  entry.role === "user" ? styles.logWho : styles.logWhoAi
                }
              >
                {entry.role === "user" ? "你" : "OntoCode"}
              </span>
              <span className={styles.logTime}>{timeOf(entry.at)}</span>
            </div>
            <div className={styles.logBody}>
              <Markdown>{entry.text}</Markdown>
            </div>
          </div>
        ) : (
          <div key={entry.id} className={styles.logEvent}>
            <span className={styles.logTime}>{timeOf(entry.at)}</span>
            <span
              className={styles.logEventType}
              title={eventTypeHint(entry.type) ?? undefined}
            >
              {entry.type === ANSWER_STREAM_TYPES.answerDelta
                ? collapsedDeltaLabel(entry.deltaCount ?? 1)
                : isReasoningStepFrame(entry.type) && (entry.stepCount ?? 1) > 1
                  ? collapsedStepLabel(entry.stepCount ?? 1)
                  : eventLabel(entry.type)}
            </span>
            {entry.detail ? (
              <span className={styles.logEventDetail}>{entry.detail}</span>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}

/* ------------------------------ 推理流程 ------------------------------ */

export interface ReasoningFlowViewProps {
  jobs: OntoCodeHarnessJob[];
  events: OntoCodeSessionEvent[];
  assistantRuns?: OntoCodeAssistantRun[];
  llmRuntime?: {
    ok: boolean;
    reachable?: boolean;
    provider?: string;
    model?: string;
    latencyMs?: number;
    mock?: boolean;
    lastCheckedAt?: number;
    factoryCentralRouting?: boolean;
  } | null;
  /** 事件超过取回上限：这条链是不完整的，别让人以为看到了全部。 */
  truncated?: boolean;
}

const STATUS_TONE: Record<string, string> = {
  succeeded: "flowOk",
  failed_terminal: "flowBad",
  failed_recoverable: "flowBad",
  cancelled: "flowOff",
  waiting_user: "flowWarn",
  running: "flowRun",
  leased: "flowRun",
  queued: "flowIdle",
  retry_scheduled: "flowIdle",
};

const STATUS_TEXT = JOB_STATUS_TEXT;

const MAX_FLOW_STEPS = 60;

/** 「最近模型调用」列多少条。截断必须连同真实总数一起报出来。 */
const MAX_MODEL_RUNS = 4;

/**
 * 没有步骤时说清是哪一种「没有」：还没开始 / 正在跑还没记 / 跑完了一步都没记。
 * 一句通用的「暂无数据」会把这三件完全不同的事说成同一件。
 */
function emptyStepsText(job: OntoCodeHarnessJob): string {
  if (job.status === "queued" || job.status === "retry_scheduled") {
    return "尚未开始";
  }
  // 蓝图确实不产生 ReAct 轨迹，但只有它真的跑过才配这么说——排队中的蓝图
  // 先落在上面那句「尚未开始」。
  if (job.kind === "blueprint") {
    return "确定性接地，不会产生 ReAct 轨迹；结果见「产物」。";
  }
  if (job.status === "running" || job.status === "leased") {
    return "进行中，尚未记录步骤";
  }
  if (job.status === "waiting_user") {
    return "等待回答，尚未记录步骤";
  }
  return "没有记录逐步过程";
}

const TOOL_CALL_FRAME_RE = /^harness\.[a-z_]+\.tool_call$/;
/**
 * 自我修正数的是「改」这个动作本身。`score_delta` 描述一次修正的结果、
 * `inspect` 是修正前的查证——把它们也计进去，一次修正会被数成三次。
 */
const SELF_CORRECTION_FRAME_RE = /^harness\.[a-z_]+\.(refine|revert)$/;
/** 委派同理只数「派出去」，`*_done` 是同一次委派的另一半。 */
const DELEGATION_FRAME_RE = /^harness\.[a-z_]+\.(subagent_start|group_start)$/;

/**
 * 这条轨迹上真的发生过多少活动——不是估的，是数出来的。
 *
 * 以前只认工具调用与推理步，于是一个三十多帧的作业顶上写着「1 次工具调用 /
 * 1 步推理」：大脑改自己的产出、派出子任务这些真活动一律不计。四个桶互斥，
 * 每一帧至多进一个，数字才对得上轨迹本身。
 */
export function reasoningActivity(events: OntoCodeSessionEvent[]): {
  toolCalls: number;
  reasoningSteps: number;
  selfCorrections: number;
  delegations: number;
} {
  let toolCalls = 0;
  let reasoningSteps = 0;
  let selfCorrections = 0;
  let delegations = 0;
  for (const event of events) {
    if (TOOL_CALL_FRAME_RE.test(event.type)) toolCalls += 1;
    else if (isReasoningStepFrame(event.type)) reasoningSteps += 1;
    else if (SELF_CORRECTION_FRAME_RE.test(event.type)) selfCorrections += 1;
    else if (DELEGATION_FRAME_RE.test(event.type)) delegations += 1;
  }
  return { toolCalls, reasoningSteps, selfCorrections, delegations };
}

/**
 * 一次助手运行的上下文清单里，真正可读的那一格。
 *
 * `contextManifest.totalBytes` 只累加**显式附件引用**的字节：系统提示、响应契约、
 * 事实块（含最多 200 个工具及其契约）一律不计。实测同一轮它是 0，而这一轮的
 * `input_tokens` 是 19_459——把这个 0 写成「上下文 0B」，读者只会读成「模型什么
 * 都没看到」。值本身诚实，词义是错的。
 *
 * 所以这里改成说它真的在数的东西：附件引用有几项、共多少字节。一项都没有时整格
 * 不渲染——「0 项附件」是事实，「上下文 0B」是误导。模型这一轮真正吃进去多少，
 * 由 `harness.assistant.model` 帧上的 token 数承载，那是 provider 的回执。
 */
export function contextAttachments(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const m = manifest as Record<string, unknown>;
  const refs = Array.isArray(m.refs) ? m.refs.length : 0;
  if (refs === 0) return null;
  const bytes = typeof m.totalBytes === "number" ? m.totalBytes : null;
  return `附件引用 ${refs} 项${
    bytes !== null ? ` · ${bytes.toLocaleString()}B` : ""
  }`;
}

/** 助手运行状态 → 节点色调 / 人话。与 Harness 作业分开，枚举本来就不同。 */
const ASSISTANT_TONE: Record<string, string> = {
  succeeded: "flowOk",
  failed: "flowBad",
  cancelled: "flowOff",
  accepted: "flowRun",
  planning: "flowRun",
};

const ASSISTANT_TEXT: Record<string, string> = {
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  accepted: "已受理",
  planning: "推理中",
};

/** 无法归属到某次助手运行时，所有事件落进这一条按时间排的泳道。 */
const CONVERSATION_LANE_KEY = "__conversation__";

interface AssistantLane {
  key: string;
  /** null = 兜底「对话」泳道，不是某一次助手运行。 */
  runId: string | null;
  at: number;
  status: string | null;
  model: string | null;
  /** 这条泳道上真实到达的帧，按到达顺序。折叠在渲染前统一做。 */
  events: OntoCodeSessionEvent[];
  steps: FlowStepRow[];
}

/** 一条轨迹行：正文 + 可选 hover（未识别帧的原始类型降级到这里）。 */
export interface FlowStepRow {
  text: string;
  title?: string;
  /**
   * 这一行代表几条真实的过程记录。折叠行 > 1。
   *
   * 存在的唯一理由是超出显示上限时能报出真实条数：只数行，一行折叠了 9 步的
   * 计数行会被算成 1，截断当场变成一次静默丢弃。
   */
  frames: number;
}

/**
 * 一条泳道上按到达顺序排好的帧 → 可读的行。
 *
 * 折叠纪律在这里唯一实现：连续 answer_delta 合成一行、连续「正常」推理步合成
 * 一行、被降级或失败的那一步永不折叠（它是整条轨迹上最该被看见的一行）。
 *
 * 以前这段逻辑只长在 Harness 作业泳道里，对话泳道一帧一行——同一串帧在两条
 * 泳道上长得不一样。对话路径改成真多回合之后，一轮就能发出几十条过程记录，
 * 60 行的显示上限当场被挤爆。
 *
 * 「哪些帧进这条泳道」留在调用方：两条泳道的入选规则本来就不同（作业泳道只收
 * `harness.*` 且排掉作业生命周期帧，对话泳道要收 `assistant.run.*`）。
 */
export function collapseFlowRows(
  events: OntoCodeSessionEvent[],
): FlowStepRow[] {
  /** 折叠中的行：deltas / steps 记住它代表几帧，text 只在没折叠时才用。 */
  type Pending = FlowStepRow & { deltas?: number; steps?: number };
  const list: Pending[] = [];
  for (const e of events) {
    const last = list[list.length - 1];
    // 分片洪水折叠：连续 delta 合并为「生成回答 · N 片」。分片正文不进轨迹
    // ——完整回答由聊天里的最终消息承载。
    if (e.type === ANSWER_STREAM_TYPES.answerDelta) {
      if (last?.deltas) {
        last.deltas += 1;
        last.frames = last.deltas;
      } else {
        list.push({ text: "", deltas: 1, frames: 1 });
      }
      continue;
    }
    const label = eventLabel(e.type);
    const detail = eventDetail(e);
    const hint = eventTypeHint(e.type);
    const text = detail ? `${label} · ${detail}` : label;
    const row: Pending = { text, frames: 1, ...(hint ? { title: hint } : {}) };
    if (isReasoningStepFrame(e.type) && collapsibleReasoningStep(e)) {
      if (last?.steps) {
        last.steps += 1;
        last.frames = last.steps;
      } else {
        list.push({ ...row, steps: 1 });
      }
      continue;
    }
    list.push(row);
  }
  return list.map((row) =>
    row.deltas
      ? { text: collapsedDeltaLabel(row.deltas), frames: row.deltas }
      : row.steps && row.steps > 1
        ? { text: collapsedStepLabel(row.steps), frames: row.steps }
        : {
            text: row.text,
            frames: row.frames,
            ...(row.title ? { title: row.title } : {}),
          },
  );
}

/**
 * 对话泳道：`harnessJobId` 为 null 的事件。
 *
 * 助手自己的事件（受理 / 计划 / 失败）落库时 harnessJobId 恒为 null，以前在这个
 * 视图里被整条丢掉——不管后端发了什么，「推理」页都不可能显示大脑做过的事。
 *
 * 分组键只用事件里真实存在的字段：
 *   1. `payload.assistantRunId`（assistant.run.* 直接带）；
 *   2. `payload.sourceMessageId` → 助手运行 id（用已取回的 assistant runs 或
 *      同时带两个 id 的事件建索引；ai.plan.proposed 只带前者）。
 * 两个都推不出来就进兜底泳道，按时间排——不编造分组键。
 */
function buildAssistantLanes(
  events: OntoCodeSessionEvent[],
  runs: OntoCodeAssistantRun[],
): AssistantLane[] {
  const runIdBySourceMessage = new Map<string, string>();
  for (const run of runs) runIdBySourceMessage.set(run.sourceMessageId, run.id);
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (
      typeof p?.assistantRunId === "string" &&
      typeof p?.sourceMessageId === "string"
    ) {
      runIdBySourceMessage.set(p.sourceMessageId, p.assistantRunId);
    }
  }
  const runById = new Map(runs.map((run) => [run.id, run] as const));

  const lanes = new Map<string, AssistantLane>();
  const ordered = [...events].sort(
    (a, b) => a.createdAt - b.createdAt || a.seq - b.seq,
  );
  for (const e of ordered) {
    if (e.harnessJobId) continue;
    const p = e.payload as Record<string, unknown>;
    const runId =
      (typeof p?.assistantRunId === "string" ? p.assistantRunId : null) ??
      (typeof p?.sourceMessageId === "string"
        ? (runIdBySourceMessage.get(p.sourceMessageId) ?? null)
        : null);
    const key = runId ?? CONVERSATION_LANE_KEY;
    const run = runId ? runById.get(runId) : undefined;
    const lane: AssistantLane = lanes.get(key) ?? {
      key,
      runId,
      at: e.createdAt,
      status: run?.status ?? null,
      model: run?.model ?? null,
      events: [],
      steps: [],
    };
    if (runId) {
      // 终态事件优先于 run 列表：run 列表可能没取到，或还停在 accepted。
      if (e.type === "assistant.run.succeeded") lane.status = "succeeded";
      else if (e.type === "assistant.run.failed") lane.status = "failed";
      else if (lane.status === null && e.type === "assistant.run.accepted")
        lane.status = "accepted";
      if (!lane.model && typeof p?.model === "string") lane.model = p.model;
    }
    lane.events.push(e);
    lanes.set(key, lane);
  }
  // 折叠与作业泳道共用同一份实现——两条泳道的折叠决策才不会各走各的。
  for (const lane of lanes.values()) lane.steps = collapseFlowRows(lane.events);
  return [...lanes.values()].sort((a, b) => a.at - b.at);
}

type FlowNode = { at: number; key: string } & (
  | { job: OntoCodeHarnessJob; lane?: undefined }
  | { lane: AssistantLane; job?: undefined }
);

/**
 * 显示上限截掉的部分有多少。
 *
 * 数的是过程记录而不是行：被截掉的行里可能有折叠行，一行代表 9 步，只数行会
 * 把 9 说成 1——一次截断说成另一个更小的数字，比不说更糟。
 */
function overflowText(steps: FlowStepRow[]): string {
  const omitted = steps.slice(MAX_FLOW_STEPS);
  const records = omitted.reduce((sum, row) => sum + row.frames, 0);
  return `… 另有 ${records} 条过程记录`;
}

/** 步骤列表：两种泳道共用同一套行渲染，标签才不会两处漂移。 */
function FlowSteps(props: { steps: FlowStepRow[]; empty: string }) {
  if (props.steps.length === 0) {
    return <div className={styles.flowEmptyStep}>{props.empty}</div>;
  }
  return (
    <div className={styles.flowSteps}>
      {/* 这里是可审计的决策摘要与动作流（策略 / 调工具 / 结果），
          不再只有阶段标记，所以 8 步的旧上限会把整条轨迹截没。 */}
      {props.steps.slice(0, MAX_FLOW_STEPS).map((s, i) => (
        <div key={i} className={styles.flowStep} title={s.title}>
          {s.text}
        </div>
      ))}
      {props.steps.length > MAX_FLOW_STEPS ? (
        <div className={styles.flowStep}>{overflowText(props.steps)}</div>
      ) : null}
    </div>
  );
}

const TERMINAL_JOB_STATUS = new Set([
  "succeeded",
  "failed_terminal",
  "failed_recoverable",
  "cancelled",
]);

function numberOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 审议结果帧 → 方法栏文案。声明的方法名只有在结局证实时才配单独示人：
 * 零方法真的跑过 → 「声明链 · 未执行（N 阶段机械推导）」；跑了但没跑全 →
 * 真跑的链 + 状态 + 推理阶段比例；只有 completed 才显示裸链。
 */
function methodFromOutcome(
  declared: string | null,
  outcome: Record<string, unknown> | undefined,
): string | null {
  if (!outcome) return null;
  const status = typeof outcome.status === "string" ? outcome.status : null;
  const executed = chainOf(outcome.executed);
  const declaredChain = declared ?? chainOf(outcome.declared);
  const coverage =
    outcome.context &&
    typeof outcome.context === "object" &&
    !Array.isArray(outcome.context)
      ? (outcome.context as Record<string, unknown>)
      : null;
  if (status === "completed" && executed) return executed;
  if (!executed) {
    if (!declaredChain) return null;
    const mechanical = numberOf(coverage?.phasesMechanical);
    return `${declaredChain} · 未执行${
      mechanical !== null ? `（${mechanical} 阶段机械推导）` : ""
    }`;
  }
  const reasoned = numberOf(coverage?.phasesReasoned);
  const phases = numberOf(coverage?.phases);
  const ratio =
    reasoned !== null && phases !== null
      ? `（${reasoned}/${phases} 阶段推理）`
      : "";
  return `${executed} · ${deliberationStatusText(status)}${ratio}`;
}

/** 阶段方法论说明。引擎内部称谓（Agent Factory 等）不得出现在返回值里。 */
function jobMethod(
  job: OntoCodeHarnessJob,
  events: OntoCodeSessionEvent[],
): string {
  const jobEvents = events.filter((event) => event.harnessJobId === job.id);
  const strategy = jobEvents.find((event) => /\.strategy$/.test(event.type))
    ?.payload as Record<string, unknown> | undefined;
  const declared = chainOf(strategy?.steps);
  // #BLUEPRINT-REASON —— strategy 帧无条件先发，它只是声明；deliberation 帧
  // 才是结局。取最新一帧：重试后旧结局不许盖过新结局。
  const outcome = jobEvents
    .filter((event) => /\.deliberation$/.test(event.type))
    .reduce<
      OntoCodeSessionEvent | undefined
    >((best, event) => (!best || event.createdAt > best.createdAt || (event.createdAt === best.createdAt && event.seq > best.seq) ? event : best), undefined);
  const outcomeMethod = methodFromOutcome(
    declared,
    outcome?.payload as Record<string, unknown> | undefined,
  );
  if (outcomeMethod) return outcomeMethod;
  if (declared) {
    // 没有结局帧时，推理步帧是「真跑过」的直接证据。作业已终局却一步都没见
    // 到，声明就只是声明——不许顶着方法名冒充跑过。运行中则如实显示声明。
    if (jobEvents.some((event) => isReasoningStepFrame(event.type))) {
      return declared;
    }
    return TERMINAL_JOB_STATUS.has(job.status)
      ? `${declared} · 未见执行步骤`
      : declared;
  }
  const policy = jobEvents.find((event) => /\.policy$/.test(event.type))
    ?.payload as Record<string, unknown> | undefined;
  if (typeof policy?.strategy === "string") {
    return policy.strategy;
  }
  if (job.kind === "scope") return "LLM 范围建议 + 确定性校验";
  if (job.kind === "blueprint") return "确定性本体接地 · 非 ReAct";
  if (job.kind === "ontology_analysis") return "结构探针 + LLM 解释";
  if (job.kind === "build") return "等待策略事件";
  return "确定性 OntoCode 阶段";
}

/**
 * 推理流程：每个 Harness 作业是一个节点，节点内是它真实走过的步骤，按时间
 * 纵向连成一条链。不编造中间步骤，也不省略——步骤来自后端桥接过来的大脑
 * 事件（策略与推理摘要 / 工具调用与理由 / 工具结果 / 校验 / 出错）。
 */
export function ReasoningFlowView(props: ReasoningFlowViewProps) {
  const stepsByJob = useMemo(() => {
    const byJob = new Map<string, OntoCodeSessionEvent[]>();
    for (const e of props.events) {
      if (!e.harnessJobId) continue;
      if (!/^harness\./.test(e.type)) continue;
      if (/^harness\.job\./.test(e.type)) continue;
      const list = byJob.get(e.harnessJobId) ?? [];
      list.push(e);
      byJob.set(e.harnessJobId, list);
    }
    const map = new Map<string, FlowStepRow[]>();
    // 折叠与对话泳道共用同一份实现（`collapseFlowRows`）。
    for (const [jobId, list] of byJob) map.set(jobId, collapseFlowRows(list));
    return map;
  }, [props.events]);

  const ordered = useMemo(
    () => [...props.jobs].sort((a, b) => a.createdAt - b.createdAt),
    [props.jobs],
  );
  const lanes = useMemo(
    () => buildAssistantLanes(props.events, props.assistantRuns ?? []),
    [props.events, props.assistantRuns],
  );
  /** 两种泳道混排成一条时间链——对话发生在哪两个作业之间，看得出来。 */
  const nodes = useMemo<FlowNode[]>(
    () =>
      [
        ...ordered.map(
          (job): FlowNode => ({ at: job.createdAt, key: job.id, job }),
        ),
        ...lanes.map(
          (lane): FlowNode => ({ at: lane.at, key: lane.key, lane }),
        ),
      ].sort((a, b) => a.at - b.at),
    [ordered, lanes],
  );
  const activity = useMemo(
    () => reasoningActivity(props.events),
    [props.events],
  );
  const failedJobs = useMemo(
    () => ordered.filter((job) => jobFailed(job.status)).length,
    [ordered],
  );
  const latestJob = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  const latestLlmBlocker =
    latestJob?.status === "failed_recoverable" ||
    latestJob?.status === "failed_terminal"
      ? /insufficient credits|openrouter_credits|api[ _-]?key|authentication|unauthori[sz]ed|llm accounting|model-call|response storage through chat completions/iu.test(
          latestJob.errorMessage ?? "",
        )
        ? /insufficient credits|openrouter_credits/iu.test(
            latestJob.errorMessage ?? "",
          )
          ? "最近代码生成：模型额度不足"
          : "最近代码生成：模型推理失败"
        : null
      : null;
  const routeHealthy =
    props.llmRuntime?.ok === true &&
    props.llmRuntime.reachable !== false &&
    props.llmRuntime.mock !== true &&
    props.llmRuntime.factoryCentralRouting === true;

  return (
    <div className={styles.flowWrap}>
      {activity.toolCalls > 0 ||
      activity.reasoningSteps > 0 ||
      activity.selfCorrections > 0 ||
      activity.delegations > 0 ||
      failedJobs > 0 ? (
        <div className={styles.flowSummary}>
          {activity.toolCalls > 0 ? (
            <span className={styles.ovChip}>
              {activity.toolCalls} 次工具调用
            </span>
          ) : null}
          {activity.reasoningSteps > 0 ? (
            <span className={styles.ovChip}>
              {activity.reasoningSteps} 步推理
            </span>
          ) : null}
          {activity.selfCorrections > 0 ? (
            <span className={styles.ovChip}>
              {activity.selfCorrections} 次自我修正
            </span>
          ) : null}
          {activity.delegations > 0 ? (
            <span className={styles.ovChip}>{activity.delegations} 次委派</span>
          ) : null}
          {failedJobs > 0 ? (
            <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
              {failedJobs} 个阶段失败
            </span>
          ) : null}
        </div>
      ) : null}
      {props.llmRuntime ? (
        <div
          className={`${styles.llmStatusCard} ${
            routeHealthy && !latestLlmBlocker
              ? styles.llmStatusOk
              : styles.llmStatusBad
          }`}
          // 内部路由明细（provider / model / 时延 / 中央路由）降级为 hover。
          title={[
            props.llmRuntime.provider ?? "provider 未知",
            props.llmRuntime.model ?? null,
            typeof props.llmRuntime.latencyMs === "number"
              ? `${props.llmRuntime.latencyMs}ms`
              : null,
            props.llmRuntime.factoryCentralRouting === true
              ? "OntoCode 生成走中央租户路由"
              : "OntoCode 生成中央路由未证明",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <div className={styles.llmStatusHead}>
            <span>默认 LLM Gateway</span>
            <strong>
              {props.llmRuntime.mock
                ? "Mock"
                : latestLlmBlocker
                  ? "推理受阻"
                  : routeHealthy
                    ? "路由可达"
                    : "不可用"}
            </strong>
          </div>
          {props.llmRuntime.factoryCentralRouting !== true ||
          latestLlmBlocker ? (
            <div className={styles.llmStatusMeta}>
              {[
                props.llmRuntime.factoryCentralRouting !== true
                  ? "路由未证明"
                  : null,
                latestLlmBlocker,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
          <div className={styles.llmStatusNote}>
            不代表每个 Job 都成功
            <HelpTip>
              {`这里只证明默认路由的实时无 token 探针可达，不代表每个 OntoCode Job 都成功${
                typeof props.llmRuntime.lastCheckedAt === "number"
                  ? `；检查于 ${timeOf(props.llmRuntime.lastCheckedAt)}`
                  : ""
              }。界面不会显示密钥，探针仅在服务端使用已配置凭据。`}
            </HelpTip>
          </div>
        </div>
      ) : null}
      {props.assistantRuns && props.assistantRuns.length > 0 ? (
        <div className={styles.modelRuns}>
          <div className={styles.modelRunsTitle}>最近模型调用</div>
          {props.assistantRuns.slice(0, MAX_MODEL_RUNS).map((run) => {
            const attachments = contextAttachments(run.contextManifest);
            return (
              <div key={run.id} className={styles.modelRun}>
                <span
                  className={
                    run.status === "succeeded"
                      ? styles.modelRunOk
                      : run.status === "failed"
                        ? styles.modelRunBad
                        : styles.modelRunIdle
                  }
                />
                <span className={styles.modelRunName}>
                  {run.model ?? "模型待路由"}
                </span>
                <span className={styles.modelRunMeta}>
                  {run.status === "succeeded"
                    ? "成功"
                    : run.status === "failed"
                      ? "失败"
                      : "进行中"}
                  {attachments ? ` · ${attachments}` : ""}
                </span>
              </div>
            );
          })}
          {/* 同一个文件里的日志过滤器早就会报「已隐藏 N 条明细」，这里却只
              截前几条、既不报总数也不报剩几条——一次静默截断。 */}
          {props.assistantRuns.length > MAX_MODEL_RUNS ? (
            <div className={styles.modelRun}>
              <span />
              <span className={styles.modelRunName}>
                共 {props.assistantRuns.length} 次
              </span>
              <span className={styles.modelRunMeta}>
                已隐藏 {props.assistantRuns.length - MAX_MODEL_RUNS} 次
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {nodes.length === 0 ? (
        <div className={styles.iEmpty}>暂无步骤</div>
      ) : null}
      {props.truncated ? <div className={styles.iEmpty}>记录已截断</div> : null}
      {nodes.map((node, index) => {
        const connector =
          index > 0 ? <div className={styles.flowConnector} /> : null;
        if (node.lane) {
          const lane = node.lane;
          const tone = lane.status
            ? (ASSISTANT_TONE[lane.status] ?? "flowIdle")
            : "flowConv";
          return (
            <div key={lane.key} className={styles.flowNodeWrap}>
              {connector}
              <div
                className={`${styles.flowNode} ${styles.flowAssistant} ${styles[tone]}`}
              >
                <div className={styles.flowNodeHead}>
                  <span className={styles.flowNodeTitle}>
                    {lane.runId ? "对话推理" : "对话"}
                  </span>
                  {lane.status ? (
                    <span className={styles.flowNodeStatus}>
                      {ASSISTANT_TEXT[lane.status] ?? lane.status}
                    </span>
                  ) : null}
                </div>
                <div className={styles.flowMethod}>
                  {lane.runId ? (lane.model ?? "模型未记录") : "按时间排列"}
                </div>
                <FlowSteps steps={lane.steps} empty="无事件" />
              </div>
            </div>
          );
        }
        const job = node.job;
        const steps = stepsByJob.get(job.id) ?? [];
        const interpretationFailed = props.events.some(
          (event) =>
            event.harnessJobId === job.id &&
            event.type === "harness.ontology_analysis.interpret_failed",
        );
        const tone =
          interpretationFailed && job.status === "succeeded"
            ? "flowWarn"
            : (STATUS_TONE[job.status] ?? "flowIdle");
        const statusText =
          interpretationFailed && job.status === "succeeded"
            ? "结构完成 · 模型解释失败"
            : (STATUS_TEXT[job.status] ?? job.status);
        return (
          <div key={job.id} className={styles.flowNodeWrap}>
            {connector}
            {/* 阶段方法论说明降级为 hover——默认视图只留阶段名与状态。 */}
            <div
              className={`${styles.flowNode} ${styles[tone]}`}
              title={jobMethod(job, props.events)}
            >
              <div className={styles.flowNodeHead}>
                <span className={styles.flowNodeTitle}>
                  {JOB_LABEL[job.kind] ?? job.kind}
                </span>
                <span className={styles.flowNodeStatus}>{statusText}</span>
              </div>
              {jobFailed(job.status) ? (
                // 「为什么失败」以前在这个面板上完全答不出来——节点只写「失败」
                // 两个字，真实原因躺在作业行里没有任何渲染路径。
                <div
                  className={styles.flowError}
                  title={jobFailureReason(job)}
                >
                  {jobFailureReason(job)}
                </div>
              ) : null}
              <FlowSteps steps={steps} empty={emptyStepsText(job)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
