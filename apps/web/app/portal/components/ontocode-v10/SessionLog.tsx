"use client";
// OntoCode v10 · 右栏「日志」与「推理」。
//
// 中栏刻意极简——只留目标、结论和需要你决定的事。全过程（每条消息、每个作业、
// 每个阶段事件）在这里完整呈现，一条都不丢，而不是塞回聊天里。
import React, { useMemo, useState } from "react";
import type {
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import { Markdown } from "@/app/portal/components/markdown";
import styles from "./workbench.module.css";

const JOB_LABEL: Record<string, string> = {
  ontology_analysis: "Ontology 理解",
  scope: "范围分析",
  blueprint: "蓝图",
  build: "代码生成",
  test: "测试",
  debug: "修复",
  regression: "回归",
  simulation: "推演",
  promotion: "上线准备",
  deploy: "部署",
  production_analysis: "线上分析",
};

/** 事件类型 → 人话。未知类型如实显示原始类型，不吞掉信息。 */
export function eventLabel(type: string): string {
  const map: Record<string, string> = {
    "session.created": "会话创建",
    "session.message.appended": "消息",
    "session.phase.changed": "阶段变化",
    "ai.plan.proposed": "AI 计划",
    "harness.job.queued": "作业入队",
    "harness.job.leased": "作业领取",
    "harness.job.started": "作业开始",
    "harness.job.succeeded": "作业完成",
    "harness.job.failed": "作业失败",
    "harness.job.waiting_user": "等待你回答",
    "harness.job.budget_warning": "超出预算（继续执行）",
    "harness.job.retry_scheduled": "安排重试",
    "harness.job.recovered": "作业恢复",
    "artifact.created": "产物写入",
    "evidence.recorded": "证据记录",
    "workspace.directive.emitted": "界面指令",
  };
  if (map[type]) return map[type]!;
  if (/^harness\.ontology_analysis\./.test(type)) {
    const phase = type.split(".").pop() ?? "";
    const phases: Record<string, string> = {
      plan: "分析 · 读取结构",
      observation: "分析 · 探针观察",
      synthesis: "分析 · 归纳结论",
      interpret_started: "分析 · 开始解释（调模型）",
      interpret_completed: "分析 · 解释完成",
    };
    return phases[phase] ?? `分析 · ${phase}`;
  }
  // #HARNESS-TELEMETRY —— 大脑真实回合的帧。以前这些事件根本没被桥接过来，
  // 「推理」页只能显示阶段标记，看上去像什么都没发生。
  const step = type.match(/^harness\.[a-z_]+\.([a-z_]+)$/)?.[1];
  const steps: Record<string, string> = {
    stage: "阶段进展",
    thinking: "思考",
    tool_call: "调用工具",
    tool_progress: "工具执行中",
    tool_result: "工具结果",
    plan: "制定计划",
    validation: "校验",
    ontology_read: "读取 Ontology",
    narration: "说明",
    brain_error: "出错",
    telemetry_truncated: "明细记录已达上限",
    agent_created: "生成 Agent",
    readiness: "就绪度评估",
    test_cases: "测试用例",
    sandbox: "沙箱执行",
    clarification: "需要你决定",
  };
  if (step && steps[step]) return steps[step]!;
  return type;
}

function timeOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function messageText(m: OntoCodeMessage): string | null {
  const content = m.content as { text?: unknown };
  return typeof content?.text === "string" && content.text.trim()
    ? content.text.trim()
    : null;
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
  | { at: number; kind: "event"; id: string; type: string; detail: string };

/** 事件 payload 里可读的一行摘要——不 dump 整个 JSON。 */
function eventDetail(event: OntoCodeSessionEvent): string {
  const p = event.payload as Record<string, unknown>;
  const bits: string[] = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) bits.push(`${label}${value}`);
    else if (typeof value === "number") bits.push(`${label}${value}`);
  };
  // 工具帧：工具名 + 大脑自陈的调用理由/结果摘要，这是整条轨迹里最有用的一行。
  if (typeof p?.tool === "string") {
    bits.push(p.tool);
    if (p.ok === false) bits.push("失败");
    push("", p.reasoning);
    push("", p.note);
  }
  if (typeof p?.text === "string" && p.text.trim()) {
    const text = p.text.trim().replace(/\s+/g, " ");
    bits.push(text.length > 160 ? `${text.slice(0, 160)}…` : text);
  }
  push("", p?.stage);
  push("", p?.summary);
  push("", p?.message);
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
  return bits.filter(Boolean).slice(0, 3).join(" · ");
}

export function SessionLogView(props: SessionLogViewProps) {
  const [showDebug, setShowDebug] = useState(false);

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
      if (!showDebug && e.visibility !== "user") continue;
      list.push({
        at: e.createdAt,
        kind: "event",
        id: e.id,
        type: e.type,
        detail: eventDetail(e),
      });
    }
    list.sort((a, b) => a.at - b.at);
    return list;
  }, [props.messages, props.events, showDebug]);

  return (
    <div>
      {/* The toolbar stays even when the filter empties the list — otherwise
          hiding debug events also hides the control that brings them back. */}
      <div className={styles.ovSum}>
        <span className={styles.ovChip}>{props.messages.length} 条消息</span>
        <span className={styles.ovChip}>
          {props.events.length} 个事件{props.truncated ? "（未取完）" : ""}
        </span>
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
          {props.events.length > 0
            ? "关键记录为空——点「显示全部」查看全部执行事件。"
            : "这个 Session 还没有可显示的记录。"}
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
            <span className={styles.logEventType}>
              {eventLabel(entry.type)}
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

const STATUS_TEXT: Record<string, string> = {
  succeeded: "完成",
  failed_terminal: "失败",
  failed_recoverable: "失败（可修复）",
  cancelled: "已取消",
  waiting_user: "等你回答",
  running: "进行中",
  leased: "进行中",
  queued: "排队中",
  retry_scheduled: "待重试",
};

const MAX_FLOW_STEPS = 60;

/**
 * 推理流程：每个 Harness 作业是一个节点，节点内是它真实走过的步骤，按时间
 * 纵向连成一条链。不编造中间步骤，也不省略——步骤来自后端桥接过来的大脑
 * 事件（思考burst / 工具调用与理由 / 工具结果 / 校验 / 出错）。
 */
export function ReasoningFlowView(props: ReasoningFlowViewProps) {
  const stepsByJob = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of props.events) {
      if (!e.harnessJobId) continue;
      if (!/^harness\./.test(e.type)) continue;
      if (/^harness\.job\./.test(e.type)) continue;
      const label = eventLabel(e.type);
      const detail = eventDetail(e);
      const list = map.get(e.harnessJobId) ?? [];
      list.push(detail ? `${label} · ${detail}` : label);
      map.set(e.harnessJobId, list);
    }
    return map;
  }, [props.events]);

  const ordered = useMemo(
    () => [...props.jobs].sort((a, b) => a.createdAt - b.createdAt),
    [props.jobs],
  );

  if (ordered.length === 0) {
    return (
      <div className={styles.iEmpty}>
        还没有执行过任何推理步骤。在左侧说一句业务目标即可开始。
      </div>
    );
  }

  return (
    <div className={styles.flowWrap}>
      {props.truncated ? (
        <div className={styles.iEmpty}>
          事件数超过单次取回上限，下面这条链不完整——较早的步骤未列出。
        </div>
      ) : null}
      {ordered.map((job, index) => {
        const steps = stepsByJob.get(job.id) ?? [];
        const tone = STATUS_TONE[job.status] ?? "flowIdle";
        return (
          <div key={job.id} className={styles.flowNodeWrap}>
            {index > 0 ? <div className={styles.flowConnector} /> : null}
            <div className={`${styles.flowNode} ${styles[tone]}`}>
              <div className={styles.flowNodeHead}>
                <span className={styles.flowNodeTitle}>
                  {JOB_LABEL[job.kind] ?? job.kind}
                </span>
                <span className={styles.flowNodeStatus}>
                  {STATUS_TEXT[job.status] ?? job.status}
                </span>
              </div>
              {steps.length > 0 ? (
                <div className={styles.flowSteps}>
                  {/* 现在这里是大脑真实的回合流（思考 / 调工具 / 结果），
                      不再只有阶段标记，所以 8 步的旧上限会把整条轨迹截没。 */}
                  {steps.slice(0, MAX_FLOW_STEPS).map((s, i) => (
                    <div key={i} className={styles.flowStep}>
                      {s}
                    </div>
                  ))}
                  {steps.length > MAX_FLOW_STEPS ? (
                    <div className={styles.flowStep}>
                      … 另有 {steps.length - MAX_FLOW_STEPS} 步
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
