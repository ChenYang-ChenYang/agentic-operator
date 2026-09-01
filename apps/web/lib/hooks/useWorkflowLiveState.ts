/**
 * useWorkflowLiveState — live per-agent execution state for the workflow
 * monitor canvas (design §G4, req #9).
 *
 * A pure reducer folds the tenant SSE stream (`useStream` onEvent) into a
 * per-agent live-state map keyed by the manifest agent name (the same
 * `agents.name` the runtime broadcasts on `run.started` and the `/v1/runs`
 * list returns as `agentName`):
 *
 *   run.started            → running (+ runId→agent registration)
 *   run.step.completed     → token accumulators (+ lastError on step failure)
 *   task.created           → waiting_human (task.resolved clears)
 *   run.completed          → ok (quiet green)   run.failed → failed
 *   run.cancelled          → idle
 *   event.emitted          → edge-pulse ring buffer {eventName, at}
 *
 * The reducer is exported as a pure function so vitest can drive it with a
 * scripted event sequence without any EventSource/react-query scaffolding.
 */
"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { RunStreamEvent } from "@agentic/contracts";
import { useStream } from "./useStream";

export type AgentLiveStatus =
  | "idle"
  | "running"
  | "ok"
  | "failed"
  | "waiting_human";

export interface AgentLiveState {
  state: AgentLiveStatus;
  /** Most recently started, still-unresolved run (best effort under overlap). */
  activeRunId: string | null;
  /** Most recently resolved run (completed/failed/cancelled). */
  lastRunId: string | null;
  /** In-flight run count — an agent can process several subjects at once. */
  runningCount: number;
  /** Session token accumulators (from run.step.completed frames). */
  tokensIn: number;
  tokensOut: number;
  lastError: string | null;
  lastEventAt: number | null;
  /** Open HITL tasks blocking this agent's runs. */
  waitingTaskIds: string[];
}

export interface EdgePulse {
  eventName: string;
  at: number;
}

export interface WorkflowLiveState {
  /** Keyed by manifest agent name (stream `agentName`). */
  agents: Record<string, AgentLiveState>;
  /** runId → agentName registry (bounded to MAX_TRACKED_RUNS). */
  runAgent: Record<string, string>;
  /** Insertion order of runAgent keys, for bounded pruning. */
  runOrder: string[];
  /** taskId → agentName so task.resolved can clear the badge. */
  taskAgent: Record<string, string>;
  /** Ring buffer of recent event emissions (edge animation source). */
  pulses: EdgePulse[];
}

/** An edge animates while its event name pulsed within this window. */
export const EDGE_PULSE_WINDOW_MS = 8_000;
const MAX_TRACKED_RUNS = 500;
const MAX_PULSES = 200;

export type WorkflowLiveAction =
  | { kind: "stream"; event: RunStreamEvent }
  | { kind: "tick"; now: number };

export function initialWorkflowLiveState(): WorkflowLiveState {
  return { agents: {}, runAgent: {}, runOrder: [], taskAgent: {}, pulses: [] };
}

function emptyAgent(): AgentLiveState {
  return {
    state: "idle",
    activeRunId: null,
    lastRunId: null,
    runningCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastError: null,
    lastEventAt: null,
    waitingTaskIds: [],
  };
}

function withAgent(
  state: WorkflowLiveState,
  name: string,
  update: (agent: AgentLiveState) => AgentLiveState,
): WorkflowLiveState {
  const current = state.agents[name] ?? emptyAgent();
  return { ...state, agents: { ...state.agents, [name]: update(current) } };
}

/** Resolved-state helper: waiting tasks trump everything; otherwise still
 * running if other runs are in flight; otherwise the provided settled state. */
function settledState(
  agent: AgentLiveState,
  settled: AgentLiveStatus,
): AgentLiveStatus {
  if (agent.waitingTaskIds.length > 0) return "waiting_human";
  if (agent.runningCount > 0) return "running";
  return settled;
}

function registerRun(
  state: WorkflowLiveState,
  runId: string,
  agentName: string,
): WorkflowLiveState {
  if (state.runAgent[runId] === agentName) return state;
  const runAgent = { ...state.runAgent, [runId]: agentName };
  const runOrder = [...state.runOrder, runId];
  while (runOrder.length > MAX_TRACKED_RUNS) {
    const evicted = runOrder.shift();
    if (evicted) delete runAgent[evicted];
  }
  return { ...state, runAgent, runOrder };
}

function prunePulses(pulses: EdgePulse[], now: number): EdgePulse[] {
  const cutoff = now - EDGE_PULSE_WINDOW_MS;
  const kept = pulses.filter((pulse) => pulse.at >= cutoff);
  return kept.length > MAX_PULSES ? kept.slice(kept.length - MAX_PULSES) : kept;
}

/** Fold a run's terminal frame into its agent's live state. */
function resolveRun(
  state: WorkflowLiveState,
  runId: string,
  at: number,
  settled: AgentLiveStatus,
  error: string | null,
): WorkflowLiveState {
  const agentName = state.runAgent[runId];
  if (!agentName) return state;
  return withAgent(state, agentName, (agent) => {
    const next: AgentLiveState = {
      ...agent,
      runningCount: Math.max(0, agent.runningCount - 1),
      lastRunId: runId,
      activeRunId: agent.activeRunId === runId ? null : agent.activeRunId,
      lastEventAt: at,
    };
    if (error) next.lastError = error;
    // failed is sticky (red until the next run starts); ok/idle defer to
    // still-running siblings and open HITL tasks.
    next.state = settled === "failed" ? "failed" : settledState(next, settled);
    return next;
  });
}

export function workflowLiveReducer(
  state: WorkflowLiveState,
  action: WorkflowLiveAction,
): WorkflowLiveState {
  if (action.kind === "tick") {
    const pruned = prunePulses(state.pulses, action.now);
    return pruned.length === state.pulses.length
      ? state
      : { ...state, pulses: pruned };
  }
  const event = action.event;
  switch (event.type) {
    case "run.started": {
      const next = registerRun(state, event.runId, event.agentName);
      return withAgent(next, event.agentName, (agent) => ({
        ...agent,
        runningCount: agent.runningCount + 1,
        activeRunId: event.runId,
        lastError: null,
        lastEventAt: event.at,
        state:
          agent.waitingTaskIds.length > 0 ? "waiting_human" : "running",
      }));
    }
    case "run.step.started": {
      const agentName = state.runAgent[event.runId];
      if (!agentName) return state;
      return withAgent(state, agentName, (agent) => ({
        ...agent,
        lastEventAt: event.at,
      }));
    }
    case "run.step.completed": {
      const agentName = state.runAgent[event.runId];
      if (!agentName) return state;
      return withAgent(state, agentName, (agent) => ({
        ...agent,
        tokensIn: agent.tokensIn + (event.tokensIn ?? 0),
        tokensOut: agent.tokensOut + (event.tokensOut ?? 0),
        lastError: event.status === "failed" ? event.error : agent.lastError,
        lastEventAt: event.at,
      }));
    }
    case "run.completed":
      return resolveRun(state, event.runId, event.at, "ok", null);
    case "run.failed":
      return resolveRun(
        state,
        event.runId,
        event.at,
        "failed",
        event.errorMessage,
      );
    case "run.cancelled":
      return resolveRun(state, event.runId, event.at, "idle", null);
    case "task.created": {
      const agentName = event.runId ? state.runAgent[event.runId] : undefined;
      if (!agentName) return state;
      const next: WorkflowLiveState = {
        ...state,
        taskAgent: { ...state.taskAgent, [event.taskId]: agentName },
      };
      return withAgent(next, agentName, (agent) => ({
        ...agent,
        waitingTaskIds: agent.waitingTaskIds.includes(event.taskId)
          ? agent.waitingTaskIds
          : [...agent.waitingTaskIds, event.taskId],
        state: "waiting_human",
        lastEventAt: event.at,
      }));
    }
    case "task.resolved": {
      const agentName = state.taskAgent[event.taskId];
      if (!agentName) return state;
      const taskAgent = { ...state.taskAgent };
      delete taskAgent[event.taskId];
      const next = { ...state, taskAgent };
      return withAgent(next, agentName, (agent) => {
        const waitingTaskIds = agent.waitingTaskIds.filter(
          (id) => id !== event.taskId,
        );
        const cleared: AgentLiveState = {
          ...agent,
          waitingTaskIds,
          lastEventAt: event.at,
        };
        cleared.state = settledState(cleared, "ok");
        return cleared;
      });
    }
    case "event.emitted": {
      const pulses = prunePulses(
        [...state.pulses, { eventName: event.name, at: event.at }],
        event.at,
      );
      return { ...state, pulses };
    }
    default:
      return state;
  }
}

export interface UseWorkflowLiveStateResult {
  /** Keyed by manifest agent name. */
  agents: Record<string, AgentLiveState>;
  pulses: EdgePulse[];
  /** Event names with a pulse inside EDGE_PULSE_WINDOW_MS — animate those edges. */
  activeEventNames: Set<string>;
}

export function useWorkflowLiveState(
  tenant?: string,
  /**
   * Optional tap on the same frames the reducer folds. The Runs page's live
   * view builds an activity feed from them; giving it a passthrough here keeps
   * the page on ONE EventSource. Its own `useStream` would have to repeat the
   * `/livefeed` path below — and pointing it at the default `/v1/stream`
   * silently yields nothing, because that route is buffered.
   */
  onFrame?: (event: RunStreamEvent) => void,
): UseWorkflowLiveStateResult {
  const [state, dispatch] = useReducer(
    workflowLiveReducer,
    undefined,
    initialWorkflowLiveState,
  );
  // Held in a ref so a caller passing an inline closure cannot tear down and
  // reopen the EventSource on every render.
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);
  const onEvent = useCallback((event: RunStreamEvent) => {
    dispatch({ kind: "stream", event });
    onFrameRef.current?.(event);
  }, []);
  // Connect through the unbuffered `/livefeed` route handler, NOT the default
  // `/v1/stream`: the `/v1/:path*` rewrite in next.config.mjs buffers SSE
  // response bodies, so an EventSource pointed there receives the handshake
  // frame and nothing else — every run/step frame this reducer exists to
  // animate silently never arrives. Same reason chrome.tsx and
  // TerminalLogTab.tsx take this route. The tenant rides as a query param
  // because EventSource cannot set the x-agentic-tenant header; the proxy
  // promotes it to the header upstream, so the canvas animates for the tenant
  // being viewed rather than the session default.
  useStream({
    path: tenant ? `/livefeed?tenant=${encodeURIComponent(tenant)}` : "/livefeed",
    onEvent,
  });

  // Expire edge pulses. The interval only runs while pulses exist so an idle
  // canvas costs nothing; the reducer returns the same reference when nothing
  // expired, so React skips the re-render.
  const hasPulses = state.pulses.length > 0;
  useEffect(() => {
    if (!hasPulses) return;
    const timer = setInterval(
      () => dispatch({ kind: "tick", now: Date.now() }),
      1_000,
    );
    return () => clearInterval(timer);
  }, [hasPulses]);

  const activeEventNames = useMemo(
    () => new Set(state.pulses.map((pulse) => pulse.eventName)),
    [state.pulses],
  );

  return { agents: state.agents, pulses: state.pulses, activeEventNames };
}
