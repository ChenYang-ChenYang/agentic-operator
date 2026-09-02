import { describe, expect, it } from "vitest";
import type { RunStreamEvent as StreamEvent } from "@agentic/contracts";
import {
  MAX_FEED_ENTRIES,
  appendFeed,
  FRESH_WINDOW_MS,
  agentSubtitle,
  countStates,
  edgeVisual,
  fmtLogMessage,
  fmtTokens,
  linkRunAgent,
  nextFollowState,
  nodeFreshness,
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
    // A tool-only agent reports 0/0 on every run — a column of noise.
    expect(fmtTokens(0, 0)).toBeNull();
    expect(fmtTokens(0, 12)).toBe("↑0 ↓12");
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

describe("nodeFreshness", () => {
  const T0 = 1_800_000_000_000;

  it("treats anything in flight as current, however old its last frame", () => {
    expect(nodeFreshness("running", T0 - 86_400_000, T0)).toBe("live");
    expect(nodeFreshness("waiting_human", T0 - 86_400_000, T0)).toBe("live");
  });

  it("keeps a finished run current only inside the window", () => {
    expect(nodeFreshness("ok", T0 - 1_000, T0)).toBe("recent");
    expect(nodeFreshness("ok", T0 - FRESH_WINDOW_MS, T0)).toBe("recent");
    expect(nodeFreshness("ok", T0 - FRESH_WINDOW_MS - 1, T0)).toBe("stale");
    expect(nodeFreshness("failed", T0 - FRESH_WINDOW_MS - 1, T0)).toBe("stale");
  });

  it("is stale when the agent never ran, or ran at an unknown time", () => {
    expect(nodeFreshness("idle", T0, T0)).toBe("stale");
    expect(nodeFreshness(undefined, T0, T0)).toBe("stale");
    expect(nodeFreshness("ok", null, T0)).toBe("stale");
  });
});

describe("nodeVisual", () => {
  it("makes waiting_human the only clickable state", () => {
    expect(nodeVisual("waiting_human", "live").actionable).toBe(true);
    for (const state of ["idle", "running", "ok", "failed"] as const) {
      expect(nodeVisual(state, "recent").actionable).toBe(false);
    }
  });

  it("animates only while a run is in flight", () => {
    expect(nodeVisual("running", "live").pulse).toBe(true);
    expect(nodeVisual("waiting_human", "live").pulse).toBe(false);
    expect(nodeVisual("ok", "recent").pulse).toBe(false);
  });

  it("emphasises the states an operator must notice", () => {
    expect(nodeVisual("running", "live").emphasis).toBe("strong");
    expect(nodeVisual("waiting_human", "live").emphasis).toBe("strong");
    expect(nodeVisual("failed", "recent").emphasis).toBe("strong");
    expect(nodeVisual("ok", "recent").emphasis).toBe("quiet");
    expect(nodeVisual(undefined, "stale").emphasis).toBe("quiet");
  });

  // A run that took 175 ms starts and finishes between two frames: there is no
  // pulse to catch, only the colour it leaves behind. That colour has to mean
  // "just now", which is only true while it is fresh.
  it("keeps a just-finished run coloured and lets an old one fade to idle", () => {
    expect(nodeVisual("ok", "recent").accent).toBe("var(--green)");
    expect(nodeVisual("failed", "recent").accent).toBe("var(--red)");

    const idle = nodeVisual("idle", "stale").accent;
    expect(nodeVisual("ok", "stale").accent).toBe(idle);
    expect(nodeVisual("failed", "stale").accent).toBe(idle);
    expect(nodeVisual("failed", "stale").emphasis).toBe("quiet");
  });
});

describe("countStates", () => {
  const T0 = 1_800_000_000_000;

  it("counts an agent with no live state as idle rather than dropping it", () => {
    const counts = countStates(
      [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      {
        a: { state: "running", lastEventAt: T0 },
        b: { state: "waiting_human", lastEventAt: T0 },
        c: { state: "failed", lastEventAt: T0 },
      },
      T0,
    );
    expect(counts).toEqual({ running: 1, waiting: 1, failed: 1, ok: 0, idle: 1 });
  });

  // Otherwise the header reads "已完成 6" off runs that ended hours ago while
  // the canvas has already faded them — the two must tell the same story.
  it("stops counting finished runs once the canvas has faded them", () => {
    const agents = [{ name: "a" }, { name: "b" }];
    const states = {
      a: { state: "ok" as const, lastEventAt: T0 - FRESH_WINDOW_MS - 1 },
      b: { state: "running" as const, lastEventAt: T0 - 86_400_000 },
    };
    expect(countStates(agents, states, T0)).toEqual({
      running: 1,
      waiting: 0,
      failed: 0,
      ok: 0,
      idle: 1,
    });
  });
});

describe("edgeVisual", () => {
  const edge = (over: Partial<Parameters<typeof edgeVisual>[0]> = {}) =>
    edgeVisual({ hot: false, traversed: false, declared: true, ...over });

  it("marks a hop this session watched the chain take", () => {
    expect(edge({ traversed: true }).stroke).toBe("var(--green)");
    expect(edge().stroke).toBe("var(--border-2)");
  });

  it("lets a just-fired event outshine an already-traversed hop", () => {
    expect(edge({ hot: true, traversed: true }).stroke).toBe("var(--signal)");
    expect(edge({ hot: true }).width).toBeGreaterThan(edge({ traversed: true }).width);
  });

  it("dims a hop the published graph declares but nothing has run", () => {
    expect(edge({ declared: false }).opacity).toBeLessThan(edge().opacity);
  });
});

describe("nextFollowState", () => {
  const at = (over: Partial<Parameters<typeof nextFollowState>[0]> = {}) =>
    nextFollowState({
      follow: true,
      scrollTop: 900,
      scrollHeight: 1000,
      clientHeight: 100,
      pinnedTop: null,
      ...over,
    });

  // Pinning the tail causes a scroll event, and during a burst of log lines the
  // next row lands before that event is delivered — so the handler measures a
  // container that has grown since and concludes the operator scrolled up.
  // That switched following off exactly when the run was busiest.
  it("ignores the scroll its own pinning caused, even after the feed grew", () => {
    expect(
      at({ follow: true, scrollTop: 900, scrollHeight: 1400, pinnedTop: 900 }),
    ).toBe(true);
  });

  it("stops following when the operator actually scrolls up", () => {
    expect(
      at({ follow: true, scrollTop: 200, scrollHeight: 1000, pinnedTop: 900 }),
    ).toBe(false);
  });

  it("resumes following when they scroll back to the bottom", () => {
    expect(
      at({ follow: false, scrollTop: 900, scrollHeight: 1000, pinnedTop: 200 }),
    ).toBe(true);
  });

  it("treats a near-bottom position as the bottom", () => {
    expect(at({ follow: false, scrollTop: 880, pinnedTop: 0 })).toBe(true);
    expect(at({ follow: false, scrollTop: 700, pinnedTop: 0 })).toBe(false);
  });

  it("measures normally before anything has been pinned", () => {
    expect(at({ follow: false, scrollTop: 900, pinnedTop: null })).toBe(true);
    expect(at({ follow: true, scrollTop: 100, pinnedTop: null })).toBe(false);
  });
});

describe("agentSubtitle", () => {
  // The canvas shows manifest names, which say what an agent is CALLED. The
  // description says what it does — but it is a paragraph, so take its opening
  // clause and drop the compiler's 【查】/【算】 category prefix.
  it("takes the opening clause and drops the category prefix", () => {
    expect(agentSubtitle("【行】无偏差链路不打扰任何人：直接归档为监控留痕，等待下一次每日扫描。")).toBe(
      "无偏差链路不打扰任何人",
    );
    expect(agentSubtitle("【查】按日定时触发，拉取全集团在途采购计划")).toBe("按日定时触发");
  });

  it("splits on a dash as readily as on a comma", () => {
    expect(agentSubtitle("【评】超期天数支撑不了决策——超3天但剩余周期充足不要紧")).toBe(
      "超期天数支撑不了决策",
    );
  });

  it("clips an opening clause that is really prose", () => {
    const long =
      agentSubtitle("【行】把预警按等级分发给分管领导并同步抄送计划员与采购员以便各方同时知悉进展") ?? "";
    expect(long.length).toBeLessThanOrEqual(23);
    expect(long.endsWith("…")).toBe(true);
  });

  it("handles Latin punctuation and plain descriptions", () => {
    expect(agentSubtitle("Collects the chain, then writes it back")).toBe(
      "Collects the chain",
    );
  });

  // A node with no subtitle beats a node with a misleading one.
  it("returns null when there is nothing to say", () => {
    expect(agentSubtitle(undefined)).toBeNull();
    expect(agentSubtitle("")).toBeNull();
    expect(agentSubtitle("   ")).toBeNull();
    expect(agentSubtitle("【查】")).toBeNull();
  });
});
