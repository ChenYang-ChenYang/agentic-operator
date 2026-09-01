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
 * name). This module adds the two things that view needs on top of it: the feed
 * projection, and the node → visual-treatment mapping.
 */

import type { RunStreamEvent as StreamEvent } from "@agentic/contracts";
import type { AgentLiveStatus } from "@/lib/hooks/useWorkflowLiveState";

/** Newest last, like a log tail. Bounded so a long-running tenant cannot grow it forever. */
export const MAX_FEED_ENTRIES = 400;

export type FeedKind =
  | "run.started"
  | "step"
  | "event"
  | "task.created"
  | "task.resolved"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface FeedEntry {
  /** Stable key for React; the stream gives no id we can rely on across kinds. */
  id: string;
  kind: FeedKind;
  /** Manifest agent name when the frame carries one — the feed groups by it. */
  agent: string | null;
  /** One-line human-readable summary; already localised by the caller's copy fn. */
  detail: string;
  runId: string | null;
  at: number;
  /** Drives the row's accent colour. */
  tone: "neutral" | "running" | "ok" | "failed" | "waiting";
}

interface RawFrame {
  type?: unknown;
  agentName?: unknown;
  runId?: unknown;
  stepName?: unknown;
  status?: unknown;
  eventName?: unknown;
  taskId?: unknown;
  title?: unknown;
  error?: unknown;
  at?: unknown;
  ts?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Project one stream frame into at most one feed row.
 *
 * Frames the view has no use for (log lines, audit records, llm/tool call
 * telemetry) return null rather than being filtered by the caller — keeping the
 * decision here means the feed's vocabulary is defined in exactly one place.
 */
export function toFeedEntry(
  event: StreamEvent,
  seq: number,
  copy: (zh: string, en: string) => string,
): FeedEntry | null {
  const frame = event as RawFrame;
  const type = str(frame.type);
  if (!type) return null;

  const agent = str(frame.agentName);
  const runId = str(frame.runId);
  const at =
    typeof frame.at === "number"
      ? frame.at
      : typeof frame.ts === "number"
        ? frame.ts
        : Date.now();
  const id = `${type}:${runId ?? "-"}:${seq}`;
  const base = { id, agent, runId, at } as const;

  switch (type) {
    case "run.started":
      return {
        ...base,
        kind: "run.started",
        tone: "running",
        detail: copy("开始运行", "started"),
      };
    case "run.step.started": {
      const step = str(frame.stepName);
      return step
        ? {
            ...base,
            kind: "step",
            tone: "running",
            detail: copy(`步骤 ${step} 开始`, `step ${step} started`),
          }
        : null;
    }
    case "run.step.completed": {
      const step = str(frame.stepName);
      if (!step) return null;
      const failed = str(frame.status) === "failed";
      return {
        ...base,
        kind: "step",
        tone: failed ? "failed" : "ok",
        detail: failed
          ? copy(`步骤 ${step} 失败`, `step ${step} failed`)
          : copy(`步骤 ${step} 完成`, `step ${step} done`),
      };
    }
    case "event.emitted": {
      const name = str(frame.eventName);
      return name
        ? {
            ...base,
            kind: "event",
            tone: "neutral",
            detail: copy(`发出事件 ${name}`, `emitted ${name}`),
          }
        : null;
    }
    case "task.created":
      return {
        ...base,
        kind: "task.created",
        tone: "waiting",
        detail: copy("等待人工处理", "waiting for a person"),
      };
    case "task.resolved":
      return {
        ...base,
        kind: "task.resolved",
        tone: "ok",
        detail: copy("人工已处理，流程继续", "resolved — flow continues"),
      };
    case "run.completed":
      return {
        ...base,
        kind: "run.completed",
        tone: "ok",
        detail: copy("运行完成", "completed"),
      };
    case "run.failed":
      return {
        ...base,
        kind: "run.failed",
        tone: "failed",
        detail: str(frame.error) ?? copy("运行失败", "failed"),
      };
    case "run.cancelled":
      return {
        ...base,
        kind: "run.cancelled",
        tone: "neutral",
        detail: copy("已取消", "cancelled"),
      };
    default:
      return null;
  }
}

/**
 * Fill in the agent name on frames that omit it.
 *
 * `run.completed` / `run.failed` carry only a runId, so those rows would read
 * as a bare "completed" with nothing to attribute it to. The earlier
 * `run.started` for the same run does name the agent, so the feed remembers it
 * per run and backfills. Records as well as resolves — one pass per frame.
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
