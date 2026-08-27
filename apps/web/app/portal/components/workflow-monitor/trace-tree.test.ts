/**
 * Tests for the trace fold (§G4 monitor timeline).
 *
 * Two halves. The synthetic cases pin each contract in isolation — attempt
 * boundaries, turn grouping, evidence joining, the degrade path. The fixture
 * case runs the real 183-event trace of a power-scm supplier-risk run that
 * failed once and succeeded on retry, which is the shape that actually has to
 * render on stage; it is the case a synthetic test would most plausibly get
 * subtly wrong.
 */
import { describe, expect, it } from "vitest";
import {
  buildRunTraceTree,
  mergeStepRows,
  type RunTraceEvent,
} from "./trace-tree";
import fixture from "./__fixtures__/run-trace.sample.json";

/** Index into a collection the test asserts is populated, with a real message. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`expected ${what} at index ${index}, got ${items.length} item(s)`);
  }
  return value;
}

let seq = 0;
function ev(partial: Partial<RunTraceEvent>): RunTraceEvent {
  seq += 1;
  return {
    id: `trc-${seq}`,
    runId: "run-1",
    stepId: "stp-1",
    parentId: null,
    seq,
    kind: "tool",
    level: "standard",
    name: "tool.call",
    status: "ok",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    summary: null,
    data: null,
    artifactId: null,
    visibility: "operator",
    createdAt: "2026-08-20T20:09:02.000Z",
    ...partial,
  };
}

describe("buildRunTraceTree", () => {
  it("opens a new attempt on each step 'running' row under the same stepId", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "analyze", status: "running", data: { type: "logic" } }),
      ev({ kind: "step", name: "analyze", status: "failed", durationMs: 900 }),
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ kind: "step", name: "analyze", status: "ok", durationMs: 400 }),
    ]);

    expect(tree.steps).toHaveLength(1);
    const step = at(tree.steps, 0, "step");
    expect(step.type).toBe("logic");
    // Retried in place under one stepId — two attempts, not two steps and not
    // four rows collapsed into one.
    expect(step.attempts.map((a) => [a.attempt, a.status, a.durationMs])).toEqual([
      [1, "failed", 900],
      [2, "ok", 400],
    ]);
  });

  it("groups llm and tool rows into turns by data.iteration", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ kind: "llm", name: "llm.call", data: { iteration: 1, provider: "openrouter", model: "gpt-5.6", tokensIn: 100, tokensOut: 20, finishReason: "tool_calls" } }),
      ev({ name: "ontology.query", data: { iteration: 1, callIndex: 1 } }),
      ev({ name: "ontology.query", data: { iteration: 1, callIndex: 2 } }),
      ev({ kind: "llm", name: "llm.call", data: { iteration: 2, provider: "openrouter", model: "gpt-5.6", tokensIn: 300, tokensOut: 40, finishReason: "stop" } }),
      ev({ kind: "step", name: "analyze", status: "ok" }),
    ]);

    const attempt = at(at(tree.steps, 0, "step").attempts, 0, "attempt");
    expect(attempt.turns.map((t) => t.iteration)).toEqual([1, 2]);
    expect(at(attempt.turns, 0, "turn").toolCalls).toHaveLength(2);
    expect(at(attempt.turns, 0, "turn").model).toBe("gpt-5.6");
    expect(at(attempt.turns, 1, "turn").finishReason).toBe("stop");
    // Attempt totals accumulate across turns.
    expect([attempt.tokensIn, attempt.tokensOut]).toEqual([400, 60]);
  });

  it("joins an .evidence row to its call by callIndex, not by order", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ name: "metaerp.invoke", data: { iteration: 1, callIndex: 1 } }),
      ev({ name: "metaerp.invoke", data: { iteration: 1, callIndex: 2 } }),
      // Evidence arrives out of order and carries no iteration.
      ev({ name: "metaerp.invoke.evidence", artifactId: "art-two", data: { callIndex: 2, isError: true } }),
      ev({ name: "metaerp.invoke.evidence", artifactId: "art-one", data: { callIndex: 1 } }),
      ev({ kind: "step", name: "analyze", status: "ok" }),
    ]);

    const calls = at(at(at(tree.steps, 0, "step").attempts, 0, "attempt").turns, 0, "turn").toolCalls;
    expect(calls.map((c) => [c.callIndex, c.evidenceArtifactId])).toEqual([
      [1, "art-one"],
      [2, "art-two"],
    ]);
    // isError rides in on the evidence row, not the call row.
    expect(at(calls, 1, "call").isError).toBe(true);
    // The `.evidence` row is not itself a visible call.
    expect(calls).toHaveLength(2);
  });

  it("scopes callIndex to its attempt so a retry does not steal evidence", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ name: "metaerp.invoke", data: { iteration: 1, callIndex: 1 } }),
      ev({ name: "metaerp.invoke.evidence", artifactId: "art-a1", data: { callIndex: 1 } }),
      ev({ kind: "step", name: "analyze", status: "failed" }),
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ name: "metaerp.invoke", data: { iteration: 1, callIndex: 1 } }),
      ev({ name: "metaerp.invoke.evidence", artifactId: "art-a2", data: { callIndex: 1 } }),
      ev({ kind: "step", name: "analyze", status: "ok" }),
    ]);

    const attempts = at(tree.steps, 0, "step").attempts;
    const first = at(attempts, 0, "attempt");
    const second = at(attempts, 1, "attempt");
    expect(at(at(first.turns, 0, "turn").toolCalls, 0, "call").evidenceArtifactId).toBe("art-a1");
    expect(at(at(second.turns, 0, "turn").toolCalls, 0, "call").evidenceArtifactId).toBe("art-a2");
  });

  it("degrades to flat when tools carry no iteration", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ name: "legacy.tool", data: { callIndex: 1 } }),
      ev({ kind: "step", name: "analyze", status: "ok" }),
    ]);

    expect(tree.degraded).toBe(true);
    const attempt = at(at(tree.steps, 0, "step").attempts, 0, "attempt");
    expect(attempt.turns).toHaveLength(0);
    expect(attempt.looseToolCalls).toHaveLength(1);
  });

  it("is not degraded when there are no tools at all", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "decide", status: "running" }),
      ev({ kind: "step", name: "decide", status: "ok" }),
    ]);
    expect(tree.degraded).toBe(false);
  });

  it("tolerates an unsorted list and a trace trimmed by the `after` cursor", () => {
    seq = 0;
    const rows = [
      ev({ kind: "llm", name: "llm.call", seq: 30, data: { iteration: 1, tokensIn: 5, tokensOut: 1 } }),
      // Terminal row with no opening row — the cursor cut the head off.
      ev({ kind: "step", name: "analyze", seq: 40, status: "ok", durationMs: 12 }),
    ];
    const tree = buildRunTraceTree([
      at(rows, 1, "row"),
      at(rows, 0, "row"),
    ]);
    const only = at(at(tree.steps, 0, "step").attempts, 0, "attempt");
    expect(only.status).toBe("ok");
    expect(at(only.turns, 0, "turn").tokensIn).toBe(5);
  });

  describe("against the real power-scm supplier-risk trace", () => {
    const tree = buildRunTraceTree(fixture as RunTraceEvent[]);

    it("recovers the failed-then-retried attempt pair", () => {
      expect(tree.steps).toHaveLength(1);
      const step = at(tree.steps, 0, "step");
      expect(step.name).toBe("analyze");
      expect(step.attempts.map((a) => [a.attempt, a.status])).toEqual([
        [1, "failed"],
        [2, "ok"],
      ]);
    });

    it("nests every tool call under a turn — nothing falls out of the tree", () => {
      expect(tree.degraded).toBe(false);
      for (const attempt of at(tree.steps, 0, "step").attempts) {
        expect(attempt.turns.length).toBeGreaterThan(0);
        expect(attempt.looseToolCalls).toHaveLength(0);
        // Iterations are contiguous from 1 — a gap means rows were dropped.
        expect(attempt.turns.map((t) => t.iteration)).toEqual(
          attempt.turns.map((_, i) => i + 1),
        );
      }
    });

    it("carries the model and token metrics the panel renders", () => {
      const firstTurn = at(at(at(tree.steps, 0, "step").attempts, 0, "attempt").turns, 0, "turn");
      expect(firstTurn.model).toBeTruthy();
      expect(firstTurn.provider).toBeTruthy();
      expect(firstTurn.tokensIn ?? 0).toBeGreaterThan(0);
      expect(tree.totals.tokensIn).toBeGreaterThan(0);
      expect(tree.totals.toolCalls).toBeGreaterThan(0);
    });

    it("counts each real tool call exactly once, excluding evidence rows", () => {
      const rows = fixture as RunTraceEvent[];
      const realCalls = rows.filter(
        (r) => r.kind === "tool" && !r.name.endsWith(".evidence"),
      ).length;
      expect(tree.totals.toolCalls).toBe(realCalls);
    });

    it("keeps the run lifecycle rows separate from the step tree", () => {
      expect(tree.runLevel.length).toBeGreaterThan(0);
      expect(tree.runLevel.every((r) => r.kind === "run")).toBe(true);
    });
  });
});

describe("mergeStepRows", () => {
  it("adds skipped steps the trace never recorded, in ordinal order", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", stepId: "s-a", name: "rule-gate", status: "running" }),
      ev({ kind: "step", stepId: "s-a", name: "rule-gate", status: "ok", durationMs: 5400 }),
    ]);
    // The steps table sees three more, all skipped because the gate failed —
    // the human approval among them, which is the point of the demo.
    const merged = mergeStepRows(tree, [
      { ord: 1, name: "rule-gate", type: "logic", status: "ok", durationMs: 5400, error: null, tokensIn: 1242, tokensOut: 210 },
      { ord: 2, name: "\u5e94\u6025\u5ba1\u6279", type: "manual", status: "skipped", durationMs: null, error: null, tokensIn: null, tokensOut: null },
      { ord: 3, name: "metaerp.invoke", type: "tool", status: "skipped", durationMs: null, error: null, tokensIn: null, tokensOut: null },
    ]);

    expect(merged.steps.map((s) => [s.name, s.type])).toEqual([
      ["rule-gate", "logic"],
      ["\u5e94\u6025\u5ba1\u6279", "manual"],
      ["metaerp.invoke", "tool"],
    ]);
    // The traced step keeps its rich node, not the flat table row.
    expect(at(merged.steps, 0, "step").attempts).toHaveLength(1);
    expect(at(at(merged.steps, 1, "step").attempts, 0, "attempt").status).toBe(
      "skipped",
    );
  });

  it("returns the tree untouched when the table adds nothing", () => {
    seq = 0;
    const tree = buildRunTraceTree([
      ev({ kind: "step", name: "analyze", status: "running" }),
      ev({ kind: "step", name: "analyze", status: "ok" }),
    ]);
    const merged = mergeStepRows(tree, [
      { ord: 1, name: "analyze", type: "logic", status: "ok", durationMs: 1, error: null, tokensIn: null, tokensOut: null },
    ]);
    expect(merged.steps).toHaveLength(1);
    expect(merged).toEqual(tree);
  });

  it("is a no-op on an empty step list", () => {
    seq = 0;
    const tree = buildRunTraceTree([ev({ kind: "step", name: "x", status: "ok" })]);
    expect(mergeStepRows(tree, [])).toBe(tree);
  });
});
