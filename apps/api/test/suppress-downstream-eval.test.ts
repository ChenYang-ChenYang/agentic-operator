/**
 * §G2 suppressDownstream (redesign 2026-08-19) — when the TRIGGER event
 * payload carries `__eval_suppress_downstream: true`, the run must still
 * persist every emission record (events row, event_store row,
 * run_emitted_events link) but must NOT fan the events out via
 * step.sendEvent, so eval executions never cascade into live subscribers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { AgentSchema, registerAgent, type RegisterContext } from "@agentic/runtime";
import type { ToolContext, ToolDescriptor } from "@agentic/agent-kit";
import {
  agents,
  events,
  eventStore,
  getDb,
  runEmittedEvents,
  runs,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";

const suffix = Date.now().toString(36).toLowerCase();
const tenantSlug = `eval-suppress-${suffix}`;
const EMITTED = "EVAL_SUPPRESS_DONE";

describe.sequential("suppressDownstream eval flag", () => {
  let tenantId: string;
  let agentId: string;
  let registered: { fn: (ctx: Record<string, unknown>) => Promise<unknown> };
  const sentEvents: Array<{ id: string; name: string }> = [];

  beforeAll(() => {
    const db = getDb();
    tenantId = makeId("ten");
    agentId = makeId("agt");
    const workflowId = makeId("wf");
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "Eval suppress E2E" })
      .run();
    db.insert(workflows)
      .values({ id: workflowId, tenantId, slug: "eval-suppress", name: "Eval suppress" })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        workflowId,
        kebabId: "eval-suppress-agent",
        name: "evalSuppressAgent",
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const agent = AgentSchema.parse({
      id: "eval-suppress-agent",
      name: "evalSuppressAgent",
      actor: ["Agent"],
      trigger: ["EVAL_SUPPRESS_START"],
      triggered_event: [EMITTED],
      tool_use: [{ name: "noopProbe" }],
      actions: [{ order: "1", name: "noopProbe", type: "tool", result_key: "noop" }],
    });
    const noopTool: ToolDescriptor = {
      kind: "tool",
      name: "noopProbe",
      async handler(_ctx: ToolContext) {
        return { data: { done: true } };
      },
    };
    const context: RegisterContext = {
      tenantId,
      tenantSlug,
      workflowVersionId: makeId("wfv"),
      tenantRegistry: { tools: { noopProbe: noopTool } },
    };
    registered = registerAgent(agent, context) as unknown as typeof registered;
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  const invocation = (data: Record<string, unknown>) => ({
    event: { name: `${tenantSlug}/EVAL_SUPPRESS_START`, data },
    step: {
      run: async (
        _id: string | { id: string },
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => fn(...args),
      sendEvent: async (
        _id: string,
        payload: { id: string; name: string },
      ) => {
        sentEvents.push({ id: payload.id, name: payload.name });
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  function latestRun() {
    return getDb()
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(desc(runs.startedAt))
      .all()[0];
  }

  function emissionRowsFor(runId: string) {
    const db = getDb();
    return {
      eventRows: db.select().from(events).where(eq(events.tenantId, tenantId)).all(),
      storeRows: db
        .select()
        .from(eventStore)
        .where(eq(eventStore.sourceRunId, runId))
        .all(),
      linkRows: db
        .select()
        .from(runEmittedEvents)
        .where(eq(runEmittedEvents.runId, runId))
        .all(),
    };
  }

  it("baseline: without the flag the emitted event is persisted AND dispatched", async () => {
    sentEvents.length = 0;
    await expect(
      registered.fn(invocation({ subject: "baseline-1" })),
    ).resolves.toMatchObject({ ok: true });
    const run = latestRun();
    expect(run?.status).toBe("ok");
    const { storeRows, linkRows } = emissionRowsFor(run!.id);
    expect(storeRows).toHaveLength(1);
    expect(storeRows[0]).toMatchObject({ name: EMITTED });
    expect(linkRows).toHaveLength(1);
    const dispatched = sentEvents.filter((entry) =>
      entry.name.endsWith(`/${EMITTED}`),
    );
    expect(dispatched).toHaveLength(1);
  });

  it("__eval_suppress_downstream keeps all persistence but skips step.sendEvent fan-out", async () => {
    sentEvents.length = 0;
    await expect(
      registered.fn(
        invocation({ subject: "eval-1", __eval_suppress_downstream: true }),
      ),
    ).resolves.toMatchObject({ ok: true });
    const run = latestRun();
    expect(run?.status).toBe("ok");
    expect(run?.emittedEventId).toBeTruthy();
    const { eventRows, storeRows, linkRows } = emissionRowsFor(run!.id);
    // Full persistence: events row, event_store row, run_emitted_events link.
    expect(eventRows.some((row) => row.id === run!.emittedEventId)).toBe(true);
    expect(storeRows).toHaveLength(1);
    expect(storeRows[0]).toMatchObject({ name: EMITTED, sourceRunId: run!.id });
    expect(linkRows).toHaveLength(1);
    // But zero downstream dispatch.
    expect(sentEvents).toHaveLength(0);
  });
});
