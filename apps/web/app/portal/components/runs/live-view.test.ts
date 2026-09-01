import { describe, expect, it } from "vitest";
import type { RunStreamEvent as StreamEvent } from "@agentic/contracts";
import {
  MAX_FEED_ENTRIES,
  appendFeed,
  countStates,
  fmtLogMessage,
  fmtTokens,
  linkRunAgent,
  nodeVisual,
  toFeedEntry,
  visibleFeed,
  type FeedEntry,
} from "./live-view";

const copy = (zh: string, _en: string) => zh;
const frame = (value: Record<string, unknown>) => value as unknown as StreamEvent;
const project = (value: Record<string, unknown>, seq = 0) =>
  toFeedEntry(frame(value), seq, copy);

describe("toFeedEntry", () => {
  it("projects the frames the runtime view speaks and drops the rest", () => {
    const kept = [
      { type: "run.started", agentName: "collect", runId: "run-1", at: 1 },
      { type: "run.step.started", runId: "run-1", name: "analyze", ord: 1, stepType: "logic", at: 2 },
      { type: "tool.call.completed", runId: "run-1", toolName: "metaerp.invoke", ok: true, at: 3 },
      { type: "llm.call.completed", runId: "run-1", servedModel: "kimi-k2", ok: true, at: 4 },
      { type: "log.line", runId: "run-1", level: "INFO", event: "chain.synced", message: "已同步 12 条链路", at: 5 },
      { type: "event.emitted", name: "CHAIN_SYNCED", sourceRunId: "run-1", at: 6 },
      { type: "task.created", runId: "run-1", taskType: "approval", title: "确认调整方案", at: 7 },
      { type: "run.completed", runId: "run-1", at: 8 },
    ].map((value, index) => project(value, index));
    expect(kept.every((entry) => entry !== null)).toBe(true);

    // Platform bookkeeping, not workflow activity — it would only add noise.
    for (const type of ["audit.recorded", "deployment.created"]) {
      expect(project({ type, at: 1 })).toBeNull();
    }
    expect(project({ at: 1 })).toBeNull();
  });

  // Every one of these keys was read wrong at first, and a wrong key here fails
  // silently: toFeedEntry returns null and the row simply never appears.
  it("reads the contract's field names, not plausible-looking ones", () => {
    // `name`, not `stepName`
    expect(project({ type: "run.step.started", name: "analyze", ord: 2, stepType: "logic", at: 1 })?.label).toBe("analyze");
    expect(project({ type: "run.step.started", stepName: "analyze", at: 1 })).toBeNull();
    // `name`, not `eventName`
    expect(project({ type: "event.emitted", name: "CHAIN_SYNCED", at: 1 })?.label).toBe("CHAIN_SYNCED");
    expect(project({ type: "event.emitted", eventName: "CHAIN_SYNCED", at: 1 })).toBeNull();
    // `errorMessage`, not `error`
    expect(project({ type: "run.failed", errorMessage: "metaerp.invoke failed", at: 1 })?.detail).toBe(
      "metaerp.invoke failed",
    );
  });

  it("says which step ran, of what type, and what it cost", () => {
    const entry = project({
      type: "run.step.completed",
      runId: "run-1",
      name: "analyze",
      ord: 3,
      stepType: "logic",
      status: "ok",
      durationMs: 12_400,
      model: "kimi-k2",
      tokensIn: 3200,
      tokensOut: 480,
      at: 1,
    });
    expect(entry?.label).toBe("analyze");
    expect(entry?.tone).toBe("ok");
    expect(entry?.meta).toBe("#3 · logic · 12.40s · kimi-k2 · ↑3.2K ↓480");
  });

  it("separates failed, skipped and completed steps", () => {
    expect(project({ type: "run.step.completed", name: "a", status: "ok", at: 1 })?.tone).toBe("ok");
    expect(project({ type: "run.step.completed", name: "a", status: "skipped", at: 1 })?.tone).toBe("neutral");
    const failed = project({
      type: "run.step.completed",
      name: "a",
      status: "failed",
      error: "gate BR-DEV-01 rejected",
      at: 1,
    });
    expect(failed?.tone).toBe("failed");
    expect(failed?.detail).toBe("gate BR-DEV-01 rejected");
  });

  it("names the tool an agent dispatched and surfaces its failure", () => {
    const ok = project({
      type: "tool.call.completed",
      runId: "run-1",
      toolName: "metaerp.invoke",
      stepName: "queryAllPbpLinePage",
      durationMs: 340,
      ok: true,
      at: 1,
    });
    expect(ok?.label).toBe("metaerp.invoke");
    expect(ok?.meta).toBe("queryAllPbpLinePage · 340ms");

    const bad = project({
      type: "tool.call.completed",
      toolName: "metaerp.invoke",
      ok: false,
      error: "fetch failed",
      at: 2,
    });
    expect(bad?.tone).toBe("failed");
    expect(bad?.detail).toBe("fetch failed");
  });

  it("reports the model that served a call, falling back to what was requested", () => {
    const served = project({
      type: "llm.call.completed",
      runId: "run-1",
      provider: "moonshot",
      requestedModel: "kimi-k2",
      servedModel: "kimi-k2-0905",
      purpose: "analyze",
      latencyMs: 8_200,
      tokensIn: 12_000,
      tokensOut: 900,
      ok: true,
      fallback: true,
      at: 1,
    });
    expect(served?.label).toBe("kimi-k2-0905");
    expect(served?.detail).toBe("analyze");
    expect(served?.meta).toBe("moonshot · 8.20s · ↑12.0K ↓900 · 已降级");

    expect(project({ type: "llm.call.completed", requestedModel: "kimi-k2", ok: true, at: 1 })?.label).toBe("kimi-k2");
  });

  it("carries a log line's content and hides only DEBUG", () => {
    const info = project({
      type: "log.line",
      runId: "run-1",
      level: "INFO",
      event: "chain.synced",
      message:
        "2026-09-01T04:31:08.134Z INFO chain.synced run_id=run-1 correlation_id=cor-1 chains=12 stage=询价",
      // The wire repeats the tail here (live) or sends bookkeeping (backfill);
      // either way the row must not print the same line twice.
      fields: { run_id: "run-1", correlation_id: "cor-1", persisted: true, raw: "chains=12" },
      at: 1,
    });
    expect(info?.label).toBe("chain.synced");
    expect(info?.detail).toBe("chains=12 stage=询价");
    expect(info?.meta).toBeNull();
    expect(info?.verbose).toBe(false);

    expect(project({ type: "log.line", level: "WARN", message: "m", at: 1 })?.tone).toBe("waiting");
    expect(project({ type: "log.line", level: "ERROR", message: "m", at: 1 })?.tone).toBe("failed");
    expect(project({ type: "log.line", level: "DEBUG", message: "m", at: 1 })?.verbose).toBe(true);
  });

  it("demotes log lines that merely restate a row the feed already draws", () => {
    const verbose = (event: string) =>
      project({ type: "log.line", level: "INFO", event, message: "m", at: 1 })?.verbose;
    // Each of these has a first-class row carrying ord, duration or tokens.
    for (const event of ["run.start", "run.end", "step.start", "step.ok", "tool.call", "llm.call", "event.emit"]) {
      expect(verbose(event)).toBe(true);
    }
    // These carry something no lifecycle frame does, so they stay in view.
    for (const event of ["step.skip", "emit.envelope", "run.completion-evidence", "chain.synced"]) {
      expect(verbose(event)).toBe(false);
    }
  });

  it("attributes an emitted event to the run that produced it", () => {
    const entry = project({
      type: "event.emitted",
      name: "CHAIN_PROGRESS_SYNCED",
      subject: "SCAN-2026-09-01",
      sourceRunId: "run-1",
      at: 1,
    });
    expect(entry?.runId).toBe("run-1");
    expect(entry?.meta).toBe("SCAN-2026-09-01");
  });

  it("shows the human task's own title rather than a generic label", () => {
    const entry = project({
      type: "task.created",
      runId: "run-1",
      taskId: "tsk-1",
      taskType: "approval",
      title: "确认 OPT-C 调整方案",
      at: 1,
    });
    expect(entry?.tone).toBe("waiting");
    expect(entry?.label).toBe("approval");
    expect(entry?.detail).toBe("确认 OPT-C 调整方案");
  });

  it("gives every row a distinct key even for identical repeated frames", () => {
    const one = project({ type: "run.started", runId: "run-1", at: 1 }, 0);
    const two = project({ type: "run.started", runId: "run-1", at: 1 }, 1);
    expect(one?.id).not.toBe(two?.id);
  });
});

describe("fmtTokens", () => {
  it("renders both directions and disappears when neither was reported", () => {
    expect(fmtTokens(3200, 480)).toBe("↑3.2K ↓480");
    expect(fmtTokens(null, 480)).toBe("↑— ↓480");
    expect(fmtTokens(null, null)).toBeNull();
  });
});

describe("fmtLogMessage", () => {
  const line = (tail: string) =>
    `2026-09-01T04:31:08.166Z WARN  run.completion-evidence run_id=run-1 correlation_id=cor-1 ${tail}`;

  it("keeps the content and drops the prefix the row already shows", () => {
    expect(fmtLogMessage(line("outcome=qualified tool_calls=2"), "run.completion-evidence")).toBe(
      "outcome=qualified tool_calls=2",
    );
  });

  it("renders nothing when the line carried only identifiers", () => {
    expect(fmtLogMessage(line(""), "run.completion-evidence")).toBe("");
  });

  it("falls back to the event name when the row has no label to show it", () => {
    expect(fmtLogMessage(line(""), null)).toBe("run.completion-evidence");
  });

  it("passes a line in some other shape through untouched", () => {
    expect(fmtLogMessage("  已同步 12 条采购链路  ", "chain.synced")).toBe("已同步 12 条采购链路");
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
        label: null,
        detail: String(i),
        meta: null,
        runId: null,
        at: i,
        tone: "neutral",
        verbose: false,
      });
    }
    expect(feed).toHaveLength(MAX_FEED_ENTRIES);
    expect(feed[feed.length - 1]!.detail).toBe(String(MAX_FEED_ENTRIES + 24));
    expect(feed[0]!.detail).toBe("25");
  });
});

describe("linkRunAgent", () => {
  it("backfills the agent on frames that only carry a runId", () => {
    const runAgents = new Map<string, string>();
    const started = linkRunAgent(
      runAgents,
      project({ type: "run.started", agentName: "collect", runId: "run-1", at: 1 }, 0)!,
    );
    const tool = linkRunAgent(
      runAgents,
      project({ type: "tool.call.completed", runId: "run-1", toolName: "metaerp.invoke", ok: true, at: 2 }, 1)!,
    );
    const finished = linkRunAgent(
      runAgents,
      project({ type: "run.completed", runId: "run-1", at: 3 }, 2)!,
    );
    expect(started.agent).toBe("collect");
    expect(tool.agent).toBe("collect");
    expect(finished.agent).toBe("collect");
  });

  it("leaves a frame alone when the run was never named", () => {
    const entry = linkRunAgent(new Map(), project({ type: "run.completed", runId: "run-x", at: 1 })!);
    expect(entry.agent).toBeNull();
  });

  it("does not attribute one run's agent to another", () => {
    const runAgents = new Map<string, string>();
    linkRunAgent(runAgents, project({ type: "run.started", agentName: "collect", runId: "run-1", at: 1 })!);
    const other = linkRunAgent(runAgents, project({ type: "run.completed", runId: "run-2", at: 2 })!);
    expect(other.agent).toBeNull();
  });
});

describe("visibleFeed", () => {
  const row = (over: Partial<FeedEntry>): FeedEntry => ({
    id: "e",
    kind: "log",
    agent: "collect",
    label: null,
    detail: "d",
    meta: null,
    runId: "run-1",
    at: 1,
    tone: "neutral",
    verbose: false,
    ...over,
  });

  it("hides DEBUG rows until they are asked for", () => {
    const feed = [row({ id: "a" }), row({ id: "b", verbose: true })];
    expect(visibleFeed(feed, { verbose: false })).toHaveLength(1);
    expect(visibleFeed(feed, { verbose: true })).toHaveLength(2);
  });

  it("narrows to one agent while a node is selected", () => {
    const feed = [row({ id: "a" }), row({ id: "b", agent: "calculate" }), row({ id: "c", agent: null })];
    const only = visibleFeed(feed, { verbose: true, agent: "collect" });
    expect(only.map((entry) => entry.id)).toEqual(["a"]);
    expect(visibleFeed(feed, { verbose: true, agent: null })).toHaveLength(3);
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
