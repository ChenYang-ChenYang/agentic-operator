// OntoCode v10 · 投影层：把服务端记录投影成「人话」视图模型。
// 词汇白名单在此层强制——内部对象名词（裸 id、存储语义、状态机词）不得进入任何 label/sub/title 字段。
import type {
  OntoCodeBuildSession,
  OntoCodeConfigurationTask,
  OntoCodeHarnessJob,
  OntoCodeHarnessJobKind,
  OntoCodeMessage,
  OntoCodeSessionEvent,
  OntoCodeCommand,
} from "@agentic/contracts";

/** 任何投影输出的用户可见字段都不允许命中这个表达式（测试守卫）。 */
export const FORBIDDEN_VOCABULARY =
  /(ocj-|ocav-|oca-|occ-|OCS-[0-9A-F]|dependencyRoot|blobHash|Candidate Package|Change Set|CAS\b|activityState|needs_user|failed_recoverable|review_required|waiting_user)/;

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
    return { ...base, tone: "ok", label: "已完成", sub: "全流程走完，可回看产物与证据" };
  }
  if (session.phase === "observe") {
    return { ...base, tone: "ok", label: "已上线观察中", sub: "生产运行监控中" };
  }
  switch (session.activityState) {
    case "needs_user": {
      const q = facts.latestQuestion
        ? truncate(facts.latestQuestion)
        : "有 1 个待回答的问题";
      return { ...base, tone: "warn", label: "等你决定", sub: q, needsAttention: 1 };
    }
    case "blocked_external": {
      const n = facts.openConfigCount ?? 1;
      return {
        ...base,
        tone: "warn",
        label: "等外部配置",
        sub: `${n} 项配置待完成，完成后自动继续`,
        needsAttention: n,
      };
    }
    case "failed_recoverable":
      return {
        ...base,
        tone: "bad",
        label: "构建受阻",
        sub: "可修复——进入会话查看原因并重试",
        needsAttention: 1,
      };
    case "review_required":
      return { ...base, tone: "warn", label: "等你审批", sub: "有 1 项待你批准的操作", needsAttention: 1 };
    case "ai_planning":
    case "queued":
    case "running": {
      const verb = facts.runningJobKind
        ? JOB_KIND_VERB[facts.runningJobKind] ?? "进行中"
        : "进行中";
      return { ...base, tone: "run", label: "进行中", sub: verb };
    }
    case "paused":
    case "cancelled":
      return { ...base, tone: "idle", label: "已暂停", sub: "随时可继续" };
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
      return { ...base, tone: "idle", label: "可继续", sub: "等你下一步指示" };
    }
  }
}

/* ------------------------------ 引导流投影 ------------------------------ */

export interface CardOptionVM {
  label: string;
  value: string;
  recommended?: boolean;
}

export interface ActionCardVM {
  kind: "config" | "decision" | "authorization" | "deploy_confirm" | "system";
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
}

export type FlowItemVM =
  | { kind: "user"; id: string; text: string; at: number }
  | { kind: "aiText"; id: string; text: string; at: number }
  | {
      kind: "execGroup";
      id: string;
      title: string;
      steps: string[];
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

function questionFromPayload(payload: unknown): ActionCardVM | null {
  if (!isRecord(payload) || !isRecord(payload.question)) return null;
  const q = payload.question;
  const question = asText(q.question);
  if (!question) return null;
  const kindRaw = asText(q.kind);
  const kind: ActionCardVM["kind"] =
    kindRaw === "config" || kindRaw === "authorization" ? kindRaw : "decision";
  const options: CardOptionVM[] = Array.isArray(q.options)
    ? q.options.flatMap((o) => {
        if (!isRecord(o)) return [];
        const label = asText(o.label);
        if (!label) return [];
        return [
          {
            label,
            value: asText(o.value) ?? label,
            recommended: o.recommended === true,
          },
        ];
      })
    : [];
  return {
    kind,
    refId: asText(q.id) ?? "question",
    questionId: asText(q.id) ?? undefined,
    title: question,
    why: asText(q.why) ?? undefined,
    impact: asText(q.impact) ?? undefined,
    options,
    allowOther: q.allowOther !== false,
  };
}

function configTaskCard(task: OntoCodeConfigurationTask): ActionCardVM {
  const t = task as unknown as Record<string, unknown>;
  const requirement = isRecord(t.requirement) ? t.requirement : {};
  return {
    kind: "config",
    refId: String(t.id ?? "config"),
    configTaskId: typeof t.id === "string" ? t.id : undefined,
    jobId: typeof t.waitingHarnessJobId === "string" ? t.waitingHarnessJobId : undefined,
    title: asText(t.title) ?? "需要一项配置",
    why: asText(requirement.summary) ?? undefined,
  };
}

export function projectFlow(input: FlowInput): FlowItemVM[] {
  const items: FlowItemVM[] = [];

  for (const m of input.messages) {
    const text = asText(isRecord(m.content) ? m.content.text : null);
    if (m.role === "user") {
      if (text) items.push({ kind: "user", id: m.id, text, at: m.createdAt });
      continue;
    }
    // assistant / system：只渲染人话正文；指令/产物回执类噪声不进流（其信号由执行组与卡片承载）。
    if (text) items.push({ kind: "aiText", id: m.id, text, at: m.createdAt });
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
  for (const ev of input.events) {
    if (!/waiting_user$/.test(ev.type)) continue;
    const card = questionFromPayload(ev.payload);
    if (!card) continue;
    const key = card.questionId ?? ev.id;
    if (seenQuestionIds.has(key)) continue;
    seenQuestionIds.add(key);
    items.push({
      kind: "actionCard",
      id: `card-${ev.id}`,
      card: { ...card, jobId: ev.harnessJobId ?? undefined },
      at: ev.createdAt,
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
        typeof (task as unknown as Record<string, unknown>).createdAt === "number"
          ? ((task as unknown as { createdAt: number }).createdAt)
          : 0,
    });
  }

  for (const cmd of input.commands) {
    if (cmd.status !== "awaiting_approval" || !cmd.requiresHuman) continue;
    items.push({
      kind: "actionCard",
      id: `card-cmd-${cmd.id}`,
      card: {
        kind: cmd.riskClass === "production_deploy" ? "deploy_confirm" : "authorization",
        refId: cmd.id,
        commandId: cmd.id,
        title: cmd.rationaleSummary,
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
  return rest;
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
        parts.push(c.title, c.why ?? "", c.impact ?? "");
        for (const o of c.options ?? []) parts.push(o.label);
        break;
      }
    }
  }
  return parts.join("\n");
}
