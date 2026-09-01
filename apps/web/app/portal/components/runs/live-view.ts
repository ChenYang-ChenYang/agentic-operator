/**
 * Pure logic for the Runs page's live workflow view.
 *
 * The Workflows page is the workflow's BUILD TIME surface — the canvas you
 * design on. This view is its RUNTIME counterpart: the same node/edge graph,
 * but read-only and coloured by what is happening right now, with an activity
 * feed beside it. Everything here is a pure function so vitest can drive it
 * with a scripted event sequence — no EventSource, no react-query.
 *
 * Node state comes from `useWorkflowLiveState` (already keyed by manifest agent
 * name). This module adds what that hook does not: the feed projection, and the
 * node → visual-treatment mapping.
 *
 * The feed's job is to show what an agent is actually DOING, not merely that it
 * is busy — the steps it walks, the tools it dispatches, the model calls it
 * makes, the log lines it writes. Every field name below comes from
 * `RunStreamEvent` in @agentic/contracts; read that before adding a variant,
 * because a wrong key here fails silently, as a row that simply never appears.
 */

import type { RunStreamEvent as StreamEvent } from "@agentic/contracts";
import type { AgentLiveStatus } from "@/lib/hooks/useWorkflowLiveState";
import { fmtDur, fmtNum } from "@/app/portal/lib/format";

/**
 * Newest last, like a log tail. Bounded so a long-running tenant cannot grow it
 * forever — generous, because log lines and tool calls arrive far faster than
 * run lifecycle frames.
 */
export const MAX_FEED_ENTRIES = 600;

export type FeedKind =
  | "run.started"
  | "step.started"
  | "step.completed"
  | "tool"
  | "llm"
  | "log"
  | "event"
  | "task.created"
  | "task.resolved"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export type FeedTone = "neutral" | "running" | "ok" | "failed" | "waiting";

export interface FeedEntry {
  /** Stable key for React; the stream gives no id we can rely on across kinds. */
  id: string;
  kind: FeedKind;
  /** Manifest agent name when the frame carries one — the feed groups by it. */
  agent: string | null;
  /** The action itself: a step name, tool name, model, event name, log event. */
  label: string | null;
  /** What happened, in one line. Already localised by the caller's copy fn. */
  detail: string;
  /** Dim trailing facts — duration, model, tokens, subject. */
  meta: string | null;
  runId: string | null;
  at: number;
  tone: FeedTone;
  /** Chatty frames, hidden until the operator asks for detail. */
  verbose: boolean;
}

type Copy = (zh: string, en: string) => string;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Join the non-empty parts of a dim meta line. */
function meta(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part?.trim()));
  return kept.length ? kept.join(" · ") : null;
}

/** `↑1.2K ↓340` — omitted entirely when the frame carried no token counts. */
export function fmtTokens(
  tokensIn: number | null,
  tokensOut: number | null,
): string | null {
  if (tokensIn == null && tokensOut == null) return null;
  const up = tokensIn == null ? "—" : fmtNum(tokensIn);
  const down = tokensOut == null ? "—" : fmtNum(tokensOut);
  return `↑${up} ↓${down}`;
}

/**
 * A persisted log line, as `<ts> <LEVEL> <event> k=v k=v …`.
 *
 * Matches the parser in apps/api/src/queries/activity.ts so both halves of the
 * stream — the durable backfill and the live broadcast — are read the same way.
 */
const LOG_LINE = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(\S+)(?:\s+(.*))?$/;

/** Row-level identifiers the feed already conveys by position. */
const REDUNDANT_LOG_FIELDS = /(?:^|\s)(?:run_id|correlation_id)=\S+/g;

/**
 * Reduce a log line to the part worth reading.
 *
 * `message` on the wire is the WHOLE rendered line — timestamp, level, event
 * name, then the fields — and `fields` is that same tail re-encoded (or, on the
 * durable-backfill path, pure bookkeeping: run_id, correlation_id, persisted,
 * raw). Rendering message and fields together therefore prints each log line
 * two or three times over. Strip the prefix the row already shows in its own
 * columns and keep just the content.
 */
export function fmtLogMessage(message: string, event: string | null): string {
  const match = message.match(LOG_LINE);
  // A line in some other shape is content as-is; better an odd row than none.
  if (!match) return message.trim();
  const tail = (match[4] ?? "").replace(REDUNDANT_LOG_FIELDS, "").trim();
  // Nothing but identifiers left: the row's own label already names the event.
  return tail || (event ? "" : match[3]!);
}

/**
 * Runtime log events that restate a lifecycle frame the feed already renders
 * as its own row — with better formatting, since those rows carry ord, step
 * type, duration and token counts that the log line does not.
 *
 * Showing both prints every step and every call twice. These are demoted to
 * verbose rather than dropped, so 详细 still gets you the raw tail.
 *
 * Deliberately NOT listed, because each carries something no lifecycle frame
 * does: `step.skip` (why the gate rejected it), `emit.envelope` (which payload
 * keys were carried, offloaded or missing) and `run.completion-evidence` (the
 * qualification audit).
 */
const MIRRORED_LOG_EVENTS = new Set([
  "run.start",
  "run.end",
  "step.start",
  "step.ok",
  "tool.call",
  "llm.call",
  "event.emit",
]);

/**
 * Project one stream frame into at most one feed row.
 *
 * Frames that describe the platform rather than the workflow (audit records,
 * deployments) return null rather than being filtered by the caller — keeping
 * the decision here means the feed's vocabulary is defined in exactly one place.
 */
export function toFeedEntry(
  event: StreamEvent,
  seq: number,
  copy: Copy,
): FeedEntry | null {
  const frame = event as Record<string, unknown>;
  const type = str(frame.type);
  if (!type) return null;

  const at = num(frame.at) ?? Date.now();
  const runId = str(frame.runId);
  const base = {
    id: `${type}:${runId ?? "-"}:${seq}`,
    agent: str(frame.agentName),
    runId,
    at,
    label: null as string | null,
    meta: null as string | null,
    verbose: false,
  };

  switch (type) {
    case "run.started":
      return {
        ...base,
        kind: "run.started",
        tone: "running",
        detail: copy("开始运行", "run started"),
        meta: meta(str(frame.triggerEvent), str(frame.subject)),
      };

    // ── inside the agent ────────────────────────────────────────────────────
    case "run.step.started": {
      const name = str(frame.name);
      if (!name) return null;
      const ord = num(frame.ord);
      return {
        ...base,
        kind: "step.started",
        tone: "running",
        label: name,
        detail: copy("步骤开始", "step started"),
        meta: meta(ord == null ? null : `#${ord}`, str(frame.stepType)),
      };
    }
    case "run.step.completed": {
      const name = str(frame.name);
      if (!name) return null;
      const ord = num(frame.ord);
      const status = str(frame.status);
      const failed = status === "failed";
      const skipped = status === "skipped";
      return {
        ...base,
        kind: "step.completed",
        tone: failed ? "failed" : skipped ? "neutral" : "ok",
        label: name,
        detail: failed
          ? (str(frame.error) ?? copy("步骤失败", "step failed"))
          : skipped
            ? copy("步骤跳过", "step skipped")
            : copy("步骤完成", "step done"),
        meta: meta(
          ord == null ? null : `#${ord}`,
          str(frame.stepType),
          num(frame.durationMs) == null ? null : fmtDur(num(frame.durationMs)),
          str(frame.model),
          fmtTokens(num(frame.tokensIn), num(frame.tokensOut)),
        ),
      };
    }
    case "tool.call.completed": {
      const toolName = str(frame.toolName);
      if (!toolName) return null;
      const ok = frame.ok !== false;
      return {
        ...base,
        kind: "tool",
        tone: ok ? "ok" : "failed",
        label: toolName,
        detail: ok
          ? copy("完成", "done")
          : (str(frame.error) ?? copy("工具调用失败", "tool call failed")),
        meta: meta(
          str(frame.stepName),
          num(frame.durationMs) == null ? null : fmtDur(num(frame.durationMs)),
        ),
      };
    }
    case "llm.call.completed": {
      const model = str(frame.servedModel) ?? str(frame.requestedModel);
      const ok = frame.ok !== false;
      return {
        ...base,
        kind: "llm",
        tone: ok ? "ok" : "failed",
        label: model ?? str(frame.provider) ?? copy("模型调用", "model call"),
        detail: ok
          ? (str(frame.purpose) ?? copy("完成", "done"))
          : (str(frame.failureReason) ??
            copy("模型调用失败", "model call failed")),
        meta: meta(
          str(frame.provider),
          num(frame.latencyMs) == null ? null : fmtDur(num(frame.latencyMs)),
          fmtTokens(num(frame.tokensIn), num(frame.tokensOut)),
          frame.fallback === true ? copy("已降级", "fallback") : null,
        ),
      };
    }
    case "log.line": {
      const message = str(frame.message);
      const level = str(frame.level);
      if (!message) return null;
      const event = str(frame.event);
      return {
        ...base,
        kind: "log",
        tone:
          level === "ERROR" ? "failed" : level === "WARN" ? "waiting" : "neutral",
        label: event,
        detail: fmtLogMessage(message, event),
        // DEBUG is the runtime talking to itself, and a mirrored event is a
        // row the feed already shows. Real content either way, but both would
        // bury the business lines an operator opened this view to read.
        verbose: level === "DEBUG" || (event != null && MIRRORED_LOG_EVENTS.has(event)),
      };
    }

    // ── between agents ──────────────────────────────────────────────────────
    case "event.emitted": {
      const name = str(frame.name);
      if (!name) return null;
      return {
        ...base,
        kind: "event",
        tone: "neutral",
        // Attribute the row to the run that produced it — `event.emitted`
        // carries a sourceRunId but no agentName of its own.
        runId: str(frame.sourceRunId),
        label: name,
        detail: copy("发出事件", "event emitted"),
        meta: str(frame.subject),
      };
    }
    case "task.created":
      return {
        ...base,
        kind: "task.created",
        tone: "waiting",
        label: str(frame.taskType),
        detail: str(frame.title) ?? copy("等待人工处理", "waiting for a person"),
        meta: str(frame.taskId),
      };
    case "task.resolved":
      return {
        ...base,
        kind: "task.resolved",
        tone: "ok",
        label: str(frame.decision),
        detail: copy("人工已处理，流程继续", "resolved — the flow continues"),
        meta: str(frame.taskId),
      };

    // ── run outcome ─────────────────────────────────────────────────────────
    case "run.completed":
      return {
        ...base,
        kind: "run.completed",
        tone: "ok",
        detail: copy("运行完成", "run completed"),
        meta: meta(
          num(frame.durationMs) == null ? null : fmtDur(num(frame.durationMs)),
          fmtTokens(num(frame.tokensIn), num(frame.tokensOut)),
        ),
      };
    case "run.failed":
      return {
        ...base,
        kind: "run.failed",
        tone: "failed",
        detail: str(frame.errorMessage) ?? copy("运行失败", "run failed"),
      };
    case "run.cancelled":
      return {
        ...base,
        kind: "run.cancelled",
        tone: "neutral",
        detail: copy("已取消", "cancelled"),
        meta: str(frame.reason),
      };
    default:
      return null;
  }
}

/**
 * Fill in the agent name on frames that omit it.
 *
 * Steps, tool calls, model calls, emitted events and terminal frames identify
 * their run but not always their agent, so those rows would read as
 * unattributed actions. The `run.started` for the same run does name the agent,
 * so the feed remembers it per run and backfills. Records as well as
 * resolves — one pass per frame.
 */
export function linkRunAgent(
  runAgents: Map<string, string>,
  entry: FeedEntry,
): FeedEntry {
  if (!entry.runId) return entry;
  if (entry.agent) {
    runAgents.set(entry.runId, entry.agent);
    return entry;
  }
  const known = runAgents.get(entry.runId);
  return known ? { ...entry, agent: known } : entry;
}

/** Append with the bound applied — oldest rows fall off the front. */
export function appendFeed(
  feed: readonly FeedEntry[],
  entry: FeedEntry,
): FeedEntry[] {
  const next = [...feed, entry];
  return next.length > MAX_FEED_ENTRIES
    ? next.slice(next.length - MAX_FEED_ENTRIES)
    : next;
}

/**
 * The rows the operator has asked to see: everything by default, DEBUG only on
 * request, and narrowed to one agent while a node is selected.
 */
export function visibleFeed(
  feed: readonly FeedEntry[],
  options: { verbose: boolean; agent?: string | null },
): FeedEntry[] {
  return feed.filter(
    (entry) =>
      (options.verbose || !entry.verbose) &&
      (!options.agent || entry.agent === options.agent),
  );
}

export interface NodeVisual {
  /** CSS custom property name carrying the accent colour. */
  accent: string;
  /** Border/label treatment — `strong` for states an operator must notice. */
  emphasis: "quiet" | "strong";
  /** True while the node should animate (a run is in flight). */
  pulse: boolean;
  /** True when clicking the node opens the human-task panel. */
  actionable: boolean;
}

/**
 * Map a live status to how the node is drawn.
 *
 * `waiting_human` is the one state an operator has to act on, so it is the only
 * one that is both `strong` and `actionable` — the view makes it clickable and
 * the node carries a task badge.
 */
export function nodeVisual(status: AgentLiveStatus | undefined): NodeVisual {
  switch (status) {
    case "running":
      return {
        accent: "var(--signal)",
        emphasis: "strong",
        pulse: true,
        actionable: false,
      };
    case "waiting_human":
      return {
        accent: "var(--amber)",
        emphasis: "strong",
        pulse: false,
        actionable: true,
      };
    case "failed":
      return {
        accent: "var(--red)",
        emphasis: "strong",
        pulse: false,
        actionable: false,
      };
    case "ok":
      return {
        accent: "var(--green)",
        emphasis: "quiet",
        pulse: false,
        actionable: false,
      };
    default:
      return {
        accent: "var(--border-2)",
        emphasis: "quiet",
        pulse: false,
        actionable: false,
      };
  }
}

/** Summary counters for the view header. */
export interface LiveCounts {
  running: number;
  waiting: number;
  failed: number;
  ok: number;
  idle: number;
}

export function countStates(
  agents: readonly { name: string }[],
  states: Record<string, { state: AgentLiveStatus } | undefined>,
): LiveCounts {
  const counts: LiveCounts = {
    running: 0,
    waiting: 0,
    failed: 0,
    ok: 0,
    idle: 0,
  };
  for (const agent of agents) {
    const state = states[agent.name]?.state ?? "idle";
    if (state === "running") counts.running += 1;
    else if (state === "waiting_human") counts.waiting += 1;
    else if (state === "failed") counts.failed += 1;
    else if (state === "ok") counts.ok += 1;
    else counts.idle += 1;
  }
  return counts;
}
