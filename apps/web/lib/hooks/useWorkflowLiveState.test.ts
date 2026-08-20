/**
 * Reducer tests for the §G4 workflow monitor live-state fold.
 *
 * Drives `workflowLiveReducer` (pure) with a scripted RunStreamEvent
 * sequence mirroring a power-scm style run: start → steps → HITL task →
 * resolve → complete, plus failure/cancel paths and edge-pulse expiry.
 */
import { describe, expect, it } from "vitest";
import type { RunStreamEvent } from "@agentic/contracts";
import {
  EDGE_PULSE_WINDOW_MS,
  initialWorkflowLiveState,
  workflowLiveReducer,
  type WorkflowLiveState,
} from "./useWorkflowLiveState";

const T0 = 1_700_000_000_000;

function feed(
  state: WorkflowLiveState,
  events: RunStreamEvent[],
): WorkflowLiveState {
  return events.reduce(
    (acc, event) => workflowLiveReducer(acc, { kind: "stream", event }),
    state,
  );
}

function runStarted(
  runId: string,
  agentName: string,
  at = T0,
): RunStreamEvent {
  return {
    type: "run.started",
    tenantId: "tn-1",
    at,
    runId,
    agentName,
    triggerEvent: "PSCM_TYPHOON_WARNING",
    subject: "subj-1",
    correlationId: "cor-1",
  };
}

function stepCompleted(
  runId: string,
  overrides: Partial<{
    status: string;
    tokensIn: number | null;
    tokensOut: number | null;
    error: string | null;
  }> = {},
): RunStreamEvent {
  return {
    type: "run.step.completed",
    tenantId: "tn-1",
    at: T0 + 100,
    runId,
    stepId: "stp-1",
    ord: 1,
    name: "rule-gate:EMG-002",
    stepType: "logic",
    status: overrides.status ?? "ok",
    durationMs: 42,
    provider: "mock",
    model: "mock-1",
    tokensIn: overrides.tokensIn ?? null,
    tokensOut: overrides.tokensOut ?? null,
    error: overrides.error ?? null,
  };
}

describe("workflowLiveReducer", () => {
  it("run.started marks the agent running and registers the run", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "action-forecast-typhoon-impact"),
    ]);
    const agent = state.agents["action-forecast-typhoon-impact"]!;
    expect(agent.state).toBe("running");
    expect(agent.activeRunId).toBe("run-1");
    expect(agent.runningCount).toBe(1);
    expect(state.runAgent["run-1"]).toBe("action-forecast-typhoon-impact");
  });

  it("run.step.completed accumulates tokens and tolerates nulls", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      stepCompleted("run-1", { tokensIn: 120, tokensOut: 30 }),
      stepCompleted("run-1", { tokensIn: null, tokensOut: null }),
      stepCompleted("run-1", { tokensIn: 80, tokensOut: 20 }),
    ]);
    const agent = state.agents["a1"]!;
    expect(agent.tokensIn).toBe(200);
    expect(agent.tokensOut).toBe(50);
    expect(agent.state).toBe("running");
  });

  it("a failed step records lastError without resolving the run", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      stepCompleted("run-1", { status: "failed", error: "tool exploded" }),
    ]);
    expect(state.agents["a1"]!.lastError).toBe("tool exploded");
    expect(state.agents["a1"]!.state).toBe("running");
  });

  it("task.created flips to waiting_human; task.resolved returns to running", () => {
    let state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      {
        type: "task.created",
        tenantId: "tn-1",
        at: T0 + 200,
        taskId: "tsk-1",
        runId: "run-1",
        taskType: "approval",
        title: "审批调拨单",
      },
    ]);
    expect(state.agents["a1"]!.state).toBe("waiting_human");
    expect(state.agents["a1"]!.waitingTaskIds).toEqual(["tsk-1"]);

    state = feed(state, [
      {
        type: "task.resolved",
        tenantId: "tn-1",
        at: T0 + 300,
        taskId: "tsk-1",
        decision: "approve",
      },
    ]);
    expect(state.agents["a1"]!.state).toBe("running");
    expect(state.agents["a1"]!.waitingTaskIds).toEqual([]);
  });

  it("run.completed settles to ok and clears the active run", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      {
        type: "run.completed",
        tenantId: "tn-1",
        at: T0 + 500,
        runId: "run-1",
        durationMs: 500,
        tokensIn: 200,
        tokensOut: 50,
        emittedEventId: "evt-9",
      },
    ]);
    const agent = state.agents["a1"]!;
    expect(agent.state).toBe("ok");
    expect(agent.runningCount).toBe(0);
    expect(agent.activeRunId).toBeNull();
    expect(agent.lastRunId).toBe("run-1");
    // Tokens come from step frames only — run totals must not double-count.
    expect(agent.tokensIn).toBe(0);
  });

  it("run.failed settles to failed with the error message", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      {
        type: "run.failed",
        tenantId: "tn-1",
        at: T0 + 500,
        runId: "run-1",
        errorMessage: "gate violation EMG-002",
      },
    ]);
    expect(state.agents["a1"]!.state).toBe("failed");
    expect(state.agents["a1"]!.lastError).toBe("gate violation EMG-002");
  });

  it("run.cancelled settles to idle", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      {
        type: "run.cancelled",
        tenantId: "tn-1",
        at: T0 + 500,
        runId: "run-1",
        reason: "operator stop",
      },
    ]);
    expect(state.agents["a1"]!.state).toBe("idle");
  });

  it("a fresh run.started clears a prior failed state", () => {
    const state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      {
        type: "run.failed",
        tenantId: "tn-1",
        at: T0 + 500,
        runId: "run-1",
        errorMessage: "boom",
      },
      runStarted("run-2", "a1", T0 + 600),
    ]);
    expect(state.agents["a1"]!.state).toBe("running");
    expect(state.agents["a1"]!.lastError).toBeNull();
  });

  it("overlapping runs stay running until the last one resolves", () => {
    let state = feed(initialWorkflowLiveState(), [
      runStarted("run-1", "a1"),
      runStarted("run-2", "a1", T0 + 10),
    ]);
    expect(state.agents["a1"]!.runningCount).toBe(2);
    state = feed(state, [
      {
        type: "run.completed",
        tenantId: "tn-1",
        at: T0 + 500,
        runId: "run-1",
        durationMs: 500,
        tokensIn: null,
        tokensOut: null,
        emittedEventId: null,
      },
    ]);
    expect(state.agents["a1"]!.state).toBe("running");
    expect(state.agents["a1"]!.runningCount).toBe(1);
  });

  it("events for unknown runs are ignored without state churn", () => {
    const initial = initialWorkflowLiveState();
    const next = feed(initial, [stepCompleted("run-unknown")]);
    expect(next).toBe(initial);
  });

  it("task.created without a runId is ignored", () => {
    const initial = initialWorkflowLiveState();
    const next = feed(initial, [
      {
        type: "task.created",
        tenantId: "tn-1",
        at: T0,
        taskId: "tsk-1",
        runId: null,
        taskType: "approval",
        title: "orphan",
      },
    ]);
    expect(next).toBe(initial);
  });

  it("event.emitted records edge pulses and tick expires them", () => {
    let state = feed(initialWorkflowLiveState(), [
      {
        type: "event.emitted",
        tenantId: "tn-1",
        at: T0,
        eventId: "evt-1",
        name: "PSCM_SUPPLY_GAP_IDENTIFIED",
        subject: "subj-1",
        sourceRunId: "run-1",
      },
    ]);
    expect(state.pulses).toEqual([
      { eventName: "PSCM_SUPPLY_GAP_IDENTIFIED", at: T0 },
    ]);

    // A tick inside the window keeps the pulse (and the same reference).
    const inWindow = workflowLiveReducer(state, {
      kind: "tick",
      now: T0 + EDGE_PULSE_WINDOW_MS - 1,
    });
    expect(inWindow).toBe(state);

    // A tick past the window drops it.
    state = workflowLiveReducer(state, {
      kind: "tick",
      now: T0 + EDGE_PULSE_WINDOW_MS + 1,
    });
    expect(state.pulses).toEqual([]);
  });

  it("full scenario-1 style cascade: forecast ok → gap event → transfer waits on HITL", () => {
    let state = feed(initialWorkflowLiveState(), [
      runStarted("run-f", "action-forecast-typhoon-impact"),
      stepCompleted("run-f", { tokensIn: 500, tokensOut: 120 }),
      {
        type: "event.emitted",
        tenantId: "tn-1",
        at: T0 + 400,
        eventId: "evt-gap",
        name: "PSCM_SUPPLY_GAP_IDENTIFIED",
        subject: "subj-1",
        sourceRunId: "run-f",
      },
      {
        type: "run.completed",
        tenantId: "tn-1",
        at: T0 + 450,
        runId: "run-f",
        durationMs: 450,
        tokensIn: 500,
        tokensOut: 120,
        emittedEventId: "evt-gap",
      },
      runStarted("run-t", "action-create-stock-transfer", T0 + 500),
      {
        type: "task.created",
        tenantId: "tn-1",
        at: T0 + 700,
        taskId: "tsk-approve",
        runId: "run-t",
        taskType: "approval",
        title: "审批调拨单",
      },
    ]);
    expect(state.agents["action-forecast-typhoon-impact"]!.state).toBe("ok");
    expect(state.agents["action-create-stock-transfer"]!.state).toBe(
      "waiting_human",
    );
    expect(state.pulses.map((p) => p.eventName)).toContain(
      "PSCM_SUPPLY_GAP_IDENTIFIED",
    );

    state = feed(state, [
      {
        type: "task.resolved",
        tenantId: "tn-1",
        at: T0 + 900,
        taskId: "tsk-approve",
        decision: "approve",
      },
      {
        type: "run.completed",
        tenantId: "tn-1",
        at: T0 + 1000,
        runId: "run-t",
        durationMs: 500,
        tokensIn: null,
        tokensOut: null,
        emittedEventId: null,
      },
    ]);
    expect(state.agents["action-create-stock-transfer"]!.state).toBe("ok");
  });
});
