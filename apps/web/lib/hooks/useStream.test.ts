/**
 * Tests for useStream's cache dispatch logic (P1-FE-02).
 *
 * Verifies that each SSE `RunStreamEvent` variant invalidates the right
 * TanStack Query keys so consumers (`useRuns`, `useEvents`, `useTasks`,
 * `useAgents`, `useCounts`) automatically refetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  dispatch,
  AGENT_KEYS,
  AUDIT_KEYS,
  COUNT_KEYS,
  DEPLOYMENT_KEYS,
  EVENT_KEYS,
  RUN_KEYS,
  TASK_KEYS,
  USAGE_KEYS,
  streamPathWithCursor,
  resetInvalidationQueue,
} from "./useStream";

function makeClient() {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  return { client, spy };
}

/**
 * Flush the coalescing window, then read what was invalidated.
 *
 * dispatch() no longer invalidates synchronously: keys are collected and
 * flushed once per window so a burst of frames costs one refetch per key
 * instead of one per frame. Every assertion therefore has to advance timers
 * first — reading the spy without flushing sees an empty list.
 */
function invalidatedKeys(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  vi.runOnlyPendingTimers();
  return spy.mock.calls.map((call: unknown[]) => {
    const arg = call[0] as { queryKey: unknown } | undefined;
    return arg?.queryKey;
  });
}

describe("dispatch — SSE events → query cache invalidations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInvalidationQueue();
  });
  afterEach(() => {
    resetInvalidationQueue();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("run.started invalidates runs.all, counts, and the run detail", () => {
    const { client, spy } = makeClient();
    dispatch(
      {
        type: "run.started",
        tenantId: "t1",
        at: 1,
        runId: "run-001",
        agentName: "matchResume",
        triggerEvent: "RESUME_PROCESSED",
        subject: "CAN-1",
        correlationId: "corr-1",
        testRun: false,
      },
      client,
    );
    const keys = invalidatedKeys(spy as never);
    expect(keys).toContainEqual(RUN_KEYS.all);
    expect(keys).toContainEqual(COUNT_KEYS.tenant);
    expect(keys).toContainEqual(RUN_KEYS.detail("run-001"));
    expect(keys).toContainEqual(USAGE_KEYS.all);
  });

  it("run.step.completed invalidates ONLY that run's detail", () => {
    const { client, spy } = makeClient();
    dispatch(
      {
        type: "run.step.completed",
        tenantId: "t1",
        at: 2,
        runId: "run-001",
        stepId: "stp-1",
        ord: 2,
        name: "matchHardRequirements",
        stepType: "logic",
        status: "ok",
        durationMs: 2103,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        tokensIn: 4128,
        tokensOut: 612,
        error: null,
      },
      client,
    );
    const keys = invalidatedKeys(spy as never);
    expect(keys).toContainEqual(RUN_KEYS.detail("run-001"));
    // Deliberately NOT the ["runs"] prefix or any list key. Step frames are the
    // highest-volume event on the stream; invalidating the list per frame is
    // what exhausted the api's read budget. The list is repaired by the run
    // lifecycle handlers and by useRuns' own refetchInterval.
    expect(keys).not.toContainEqual(RUN_KEYS.all);
    expect(keys).not.toContainEqual(RUN_KEYS.list());
  });

  it("coalesces a burst so repeated keys cost one invalidation", () => {
    const { client, spy } = makeClient();
    const frame = (ord: number) =>
      ({
        type: "run.step.completed",
        tenantId: "t1",
        at: ord,
        runId: "run-001",
        stepId: `stp-${ord}`,
        ord,
        name: "matchHardRequirements",
        stepType: "logic",
        status: "ok",
        durationMs: 12,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        tokensIn: 10,
        tokensOut: 5,
        error: null,
      }) as const;

    // A fan-out burst: many frames for the same run inside one window.
    for (let ord = 1; ord <= 40; ord += 1) dispatch(frame(ord), client);

    // Nothing has fired yet — the window is still open.
    expect(spy).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();

    // 40 frames collapse to the single distinct key they all touch.
    const keys = spy.mock.calls.map(
      (call: unknown[]) => (call[0] as { queryKey: unknown }).queryKey,
    );
    expect(keys).toEqual([RUN_KEYS.detail("run-001")]);
  });

  it("event.emitted invalidates events.all + counts", () => {
    const { client, spy } = makeClient();
    dispatch(
      {
        type: "event.emitted",
        tenantId: "t1",
        at: 3,
        eventId: "evt-1",
        name: "MATCH_PASSED_NEED_INTERVIEW",
        subject: "CAN-1",
        sourceRunId: "run-001",
      },
      client,
    );
    const keys = invalidatedKeys(spy as never);
    expect(keys).toContainEqual(EVENT_KEYS.all);
    expect(keys).toContainEqual(COUNT_KEYS.tenant);
  });

  it("task.created and task.resolved invalidate tasks + counts", () => {
    {
      const { client, spy } = makeClient();
      dispatch(
        {
          type: "task.created",
          tenantId: "t1",
          at: 4,
          taskId: "TASK-1",
          runId: "run-001",
          taskType: "jdReview",
          title: "Review JD",
        },
        client,
      );
      const keys = invalidatedKeys(spy as never);
      expect(keys).toContainEqual(TASK_KEYS.all);
      expect(keys).toContainEqual(COUNT_KEYS.tenant);
    }
    {
      const { client, spy } = makeClient();
      dispatch(
        {
          type: "task.resolved",
          tenantId: "t1",
          at: 5,
          taskId: "TASK-1",
          decision: "approve",
        },
        client,
      );
      const keys = invalidatedKeys(spy as never);
      expect(keys).toContainEqual(TASK_KEYS.all);
      expect(keys).toContainEqual(COUNT_KEYS.tenant);
    }
  });

  it("run.failed bumps both the list and the specific detail key", () => {
    const { client, spy } = makeClient();
    dispatch(
      {
        type: "run.failed",
        tenantId: "t1",
        at: 6,
        runId: "run-002",
        errorMessage: "tool timeout",
      },
      client,
    );
    const keys = invalidatedKeys(spy as never);
    expect(keys).toContainEqual(RUN_KEYS.detail("run-002"));
    expect(keys).toContainEqual(RUN_KEYS.all);
    expect(keys).toContainEqual(COUNT_KEYS.tenant);
    expect(keys).toContainEqual(USAGE_KEYS.all);
  });

  it("deployment.created refreshes deployments, agents, and canonical counts", () => {
    const { client, spy } = makeClient();
    dispatch(
      {
        type: "deployment.created",
        tenantId: "t1",
        at: 7,
        deploymentId: "dep-1",
        kind: "manifest",
        version: "1",
        workflowSlug: "default",
      },
      client,
    );
    const keys = invalidatedKeys(spy as never);
    expect(keys).toContainEqual(DEPLOYMENT_KEYS.list);
    expect(keys).toContainEqual(AGENT_KEYS.all);
    expect(keys).toContainEqual(COUNT_KEYS.tenant);
  });

  it("observability variants refresh their durable read models", () => {
    const { client, spy } = makeClient();
    dispatch(
      {
        type: "audit.recorded",
        tenantId: "t1",
        at: 7,
        auditId: "audit-1",
        action: "run.cancel",
        actorUserId: "user-1",
        targetType: "run",
        targetId: "run-1",
        decision: "allow",
      },
      client,
    );
    dispatch(
      {
        type: "llm.call.completed",
        tenantId: "t1",
        at: 8,
        callId: "llm-1",
        purpose: "agent-step",
        provider: "openai",
        requestedModel: "gpt-4.1-mini",
        servedModel: "gpt-4.1-mini",
        tokensIn: 100,
        tokensOut: 20,
        latencyMs: 90,
        fallback: false,
        ok: true,
        failureReason: null,
      },
      client,
    );
    const keys = invalidatedKeys(spy as never);
    expect(keys).toContainEqual(AUDIT_KEYS.all);
    expect(keys).toContainEqual(USAGE_KEYS.all);
  });

  it("AGENT_KEYS export is available for invalidation by mutations", () => {
    // Sanity — useInvokeAgent / useUploadManifest will key off this.
    expect(AGENT_KEYS.list).toEqual(["agents", "list"]);
    expect(AGENT_KEYS.detail("match-resume")).toEqual([
      "agents",
      "detail",
      "match-resume",
    ]);
  });
});

describe("streamPathWithCursor", () => {
  it("preserves existing proxy parameters and URL-encodes the durable cursor", () => {
    expect(
      streamPathWithCursor(
        "/livefeed?tenant=raas&backfill=1000",
        "llm:call-123",
      ),
    ).toBe(
      "/livefeed?tenant=raas&backfill=1000&lastEventId=llm%3Acall-123",
    );
  });

  it("does not mutate paths before the first event arrives", () => {
    expect(streamPathWithCursor("/livefeed?tenant=raas", "")).toBe(
      "/livefeed?tenant=raas",
    );
  });
});
