import { describe, expect, it } from "vitest";
import type { RunStreamEvent as StreamEvent } from "@agentic/contracts";
import {
  MAX_FEED_ENTRIES,
  appendFeed,
  countStates,
  linkRunAgent,
  nodeVisual,
  toFeedEntry,
  type FeedEntry,
} from "./live-view";

const copy = (zh: string, _en: string) => zh;
const frame = (value: Record<string, unknown>) => value as unknown as StreamEvent;

describe("toFeedEntry", () => {
  it("projects the frames the runtime view speaks and drops the rest", () => {
    const kept = [
      frame({ type: "run.started", agentName: "collect", runId: "run-1", at: 1 }),
      frame({ type: "event.emitted", eventName: "CHAIN_SYNCED", runId: "run-1", at: 2 }),
      frame({ type: "task.created", agentName: "approve", taskId: "tsk-1", at: 3 }),
      frame({ type: "run.completed", agentName: "collect", runId: "run-1", at: 4 }),
    ].map((event, index) => toFeedEntry(event, index, copy));
    expect(kept.every((entry) => entry !== null)).toBe(true);

    // Telemetry and log frames are the majority of the stream; the feed would be
    // unreadable if they landed in it.
    for (const type of ["log.line", "audit.recorded", "llm.call.completed", "tool.call.completed"]) {
      expect(toFeedEntry(frame({ type, at: 1 }), 0, copy)).toBeNull();
    }
    expect(toFeedEntry(frame({ at: 1 }), 0, copy)).toBeNull();
  });

  it("separates a failed step from a completed one", () => {
    const ok = toFeedEntry(
      frame({ type: "run.step.completed", stepName: "analyze", status: "ok", at: 1 }),
      0,
      copy,
    );
    const bad = toFeedEntry(
      frame({ type: "run.step.completed", stepName: "analyze", status: "failed", at: 2 }),
      1,
      copy,
    );
    expect(ok?.tone).toBe("ok");
    expect(bad?.tone).toBe("failed");
  });

  it("surfaces the error text on a failed run, not a generic label", () => {
    const entry = toFeedEntry(
      frame({ type: "run.failed", agentName: "push", error: "metaerp.invoke failed", at: 9 }),
      0,
      copy,
    );
    expect(entry?.detail).toBe("metaerp.invoke failed");
    expect(entry?.tone).toBe("failed");
  });

  it("marks a created task as waiting so the row is scannable", () => {
    const entry = toFeedEntry(frame({ type: "task.created", agentName: "approve", at: 1 }), 0, copy);
    expect(entry?.tone).toBe("waiting");
    expect(entry?.agent).toBe("approve");
  });

  it("gives every row a distinct key even for identical repeated frames", () => {
    const one = toFeedEntry(frame({ type: "run.started", runId: "run-1", at: 1 }), 0, copy);
    const two = toFeedEntry(frame({ type: "run.started", runId: "run-1", at: 1 }), 1, copy);
    expect(one?.id).not.toBe(two?.id);
  });
});

describe("appendFeed", () => {
  it("keeps newest last and drops the oldest past the bound", () => {
    let feed: FeedEntry[] = [];
    for (let i = 0; i < MAX_FEED_ENTRIES + 25; i += 1) {
      feed = appendFeed(feed, {
        id: `e-${i}`,
        kind: "event",
        agent: null,
        detail: String(i),
        runId: null,
        at: i,
        tone: "neutral",
      });
    }
    expect(feed).toHaveLength(MAX_FEED_ENTRIES);
    expect(feed[feed.length - 1]!.detail).toBe(String(MAX_FEED_ENTRIES + 24));
    expect(feed[0]!.detail).toBe("25");
  });
});

describe("nodeVisual", () => {
  it("makes waiting_human the only clickable state", () => {
    expect(nodeVisual("waiting_human").actionable).toBe(true);
    for (const state of ["idle", "running", "ok", "failed"] as const) {
      expect(nodeVisual(state).actionable).toBe(false);
    }
  });

  it("animates only while a run is in flight", () => {
    expect(nodeVisual("running").pulse).toBe(true);
    expect(nodeVisual("waiting_human").pulse).toBe(false);
    expect(nodeVisual("ok").pulse).toBe(false);
  });

  it("emphasises the states an operator must notice", () => {
    expect(nodeVisual("running").emphasis).toBe("strong");
    expect(nodeVisual("waiting_human").emphasis).toBe("strong");
    expect(nodeVisual("failed").emphasis).toBe("strong");
    expect(nodeVisual("ok").emphasis).toBe("quiet");
    expect(nodeVisual(undefined).emphasis).toBe("quiet");
  });
});

describe("countStates", () => {
  it("counts an agent with no live state as idle rather than dropping it", () => {
    const counts = countStates(
      [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      {
        a: { state: "running" },
        b: { state: "waiting_human" },
        c: { state: "failed" },
      },
    );
    expect(counts).toEqual({ running: 1, waiting: 1, failed: 1, ok: 0, idle: 1 });
  });
});

describe("linkRunAgent", () => {
  it("backfills the agent on frames that only carry a runId", () => {
    const runAgents = new Map<string, string>();
    const started = linkRunAgent(
      runAgents,
      toFeedEntry(frame({ type: "run.started", agentName: "collect", runId: "run-1", at: 1 }), 0, copy)!,
    );
    const finished = linkRunAgent(
      runAgents,
      toFeedEntry(frame({ type: "run.completed", runId: "run-1", at: 2 }), 1, copy)!,
    );
    expect(started.agent).toBe("collect");
    expect(finished.agent).toBe("collect");
  });

  it("leaves a frame alone when the run was never named", () => {
    const entry = linkRunAgent(
      new Map(),
      toFeedEntry(frame({ type: "run.completed", runId: "run-x", at: 1 }), 0, copy)!,
    );
    expect(entry.agent).toBeNull();
  });

  it("does not attribute one run's agent to another", () => {
    const runAgents = new Map<string, string>();
    linkRunAgent(
      runAgents,
      toFeedEntry(frame({ type: "run.started", agentName: "collect", runId: "run-1", at: 1 }), 0, copy)!,
    );
    const other = linkRunAgent(
      runAgents,
      toFeedEntry(frame({ type: "run.completed", runId: "run-2", at: 2 }), 1, copy)!,
    );
    expect(other.agent).toBeNull();
  });
});
