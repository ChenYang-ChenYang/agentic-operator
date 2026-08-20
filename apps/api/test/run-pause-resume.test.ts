/**
 * §G4 — run pause/resume: /v1/runs/:id/pause|resume routes + the runtime's
 * pause parking (packages/runtime/src/register.ts `pause-check-<ord>` /
 * `pause-wait-<ord>` / `pause-resume-<ord>`).
 *
 * Drives a 2-action manifest agent through the REAL engine with a fake
 * Inngest step. The scripted gateway PAUSES the run via the real route while
 * action 1 is executing; the engine's memoized pause gate before action 2
 * then parks on waitForEvent, the resume route (real inject) emits
 * `${slug}/run.resume`, and the run completes ok.
 */

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  AgentSchema,
  getRuntimeGateway,
  registerAgent,
  setRuntimeGateway,
  inngest,
  type RegisterContext,
} from "@agentic/runtime";
import type { ChatRequest, ChatResponse, LLMGateway } from "@agentic/llm-gateway";
import {
  agents as agentsTable,
  auditLog,
  getDb,
  memberships,
  runs,
  tenants,
  users,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { registerEnvelope } from "../src/plugins/error";
import { registerAuth } from "../src/plugins/auth";
import { runsRoutes } from "../src/routes/v1/runs";

const suffix = Date.now().toString(36).toLowerCase();
const tenantSlug = `pause-e2e-${suffix}`;
const AGENT_NAME = "pause-two-step";

interface SentEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

interface OkEnvelope<T> {
  ok: boolean;
  data: T;
}

describe.sequential("run pause/resume (§G4 backend)", () => {
  const db = getDb();
  const app = Fastify({ logger: false });
  const priorGateway = (() => {
    try {
      return getRuntimeGateway();
    } catch {
      return undefined;
    }
  })();

  const brokerSends: SentEvent[] = [];
  const proto = Object.getPrototypeOf(inngest) as { send: typeof inngest.send };
  const originalSend = proto.send;

  let tenantId = "";
  let agentDbId = "";
  let agentFn: ((i: unknown) => Promise<unknown>) | null = null;

  // Observed sequencing across the scripted gateway + fake step.
  const timeline: string[] = [];
  let activeRunId = "";
  let parkedAtStep = "";
  let pauseRouteBody: { paused?: boolean; status?: string } | null = null;
  let resumeRouteBody: { resumed?: boolean; status?: string } | null = null;

  const headers = { "x-agentic-tenant": tenantSlug };

  const scriptedGateway = {
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const purpose = request.purpose ?? "";
      const base = {
        provider: "mock",
        model: "scripted",
        tokensIn: 10,
        tokensOut: 5,
        finishReason: "stop",
        latencyMs: 1,
      };
      if (purpose.includes("step-one")) {
        timeline.push("action-1");
        // Operator clicks Pause while action 1 is still executing: the REAL
        // route flips the durable row; the engine's pause-check-2 gate reads
        // it before action 2.
        const row = db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.agentId, agentDbId))
          .orderBy(desc(runs.startedAt))
          .all()[0];
        activeRunId = row!.id;
        const res = await app.inject({
          method: "POST",
          url: `/v1/runs/${activeRunId}/pause`,
          headers,
        });
        pauseRouteBody = (res.json() as OkEnvelope<typeof pauseRouteBody>).data;
        timeline.push("paused-via-route");
      }
      if (purpose.includes("step-two")) {
        timeline.push("action-2");
      }
      return { ...base, text: "{}" } as ChatResponse;
    },
  } as unknown as LLMGateway;

  beforeAll(async () => {
    proto.send = (async (payload: SentEvent | SentEvent[]) => {
      const list = Array.isArray(payload) ? payload : [payload];
      brokerSends.push(...list);
      return { ids: list.map((entry) => entry.id ?? makeId("evt")) };
    }) as typeof inngest.send;

    tenantId = makeId("ten");
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "pause/resume E2E" })
      .run();
    // The AUTH_MODE=dev principal (superadmin) passes RBAC for any tenant the
    // x-agentic-tenant header selects; seed it if this snapshot lacks it.
    const devEmail = (
      process.env.AGENTIC_DEV_USER_EMAIL ?? "test-platform-admin@agentic.invalid"
    ).toLowerCase();
    const devUser = db.select().from(users).where(eq(users.email, devEmail)).all()[0];
    if (!devUser) {
      db.insert(users)
        .values({
          id: makeId("usr"),
          email: devEmail,
          name: "pause test admin",
          platformRole: "superadmin",
          status: "active",
        })
        .run();
    }

    const workflowId = makeId("wf");
    db.insert(workflows)
      .values({ id: workflowId, tenantId, slug: "pause-flow", name: "pause flow" })
      .run();
    agentDbId = makeId("agt");
    db.insert(agentsTable)
      .values({
        id: agentDbId,
        workflowId,
        kebabId: AGENT_NAME,
        name: AGENT_NAME,
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const agent = AgentSchema.parse({
      id: AGENT_NAME,
      name: AGENT_NAME,
      title: "两步暂停验证",
      description: "two logic actions with a pause gate between them",
      actor: ["Agent"],
      generated: true,
      trigger: ["PAUSE_TEST_START"],
      triggered_event: ["PAUSE_TEST_DONE"],
      retries: 0,
      actions: [
        {
          name: "step-one",
          description: "first logic step",
          type: "logic",
          order: "1",
          result_key: "one",
        },
        {
          name: "step-two",
          description: "second logic step",
          type: "logic",
          order: "2",
          result_key: "two",
        },
      ],
    });
    const context: RegisterContext = {
      tenantId,
      tenantSlug,
      workflowVersionId: makeId("wfv"),
      tenantRegistry: { tools: {} },
    } as unknown as RegisterContext;
    const registered = registerAgent(agent, context) as unknown as {
      fn: (i: unknown) => Promise<unknown>;
    } | null;
    agentFn = registered?.fn ?? null;
    setRuntimeGateway(scriptedGateway);

    await registerEnvelope(app);
    await registerAuth(app);
    await app.register(runsRoutes, { prefix: "/v1" });
    await app.ready();
  });

  afterAll(async () => {
    proto.send = originalSend;
    if (priorGateway) setRuntimeGateway(priorGateway);
    await app.close();
    db.delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  /** Fake Inngest invocation whose waitForEvent services the pause park by
   * calling the REAL resume route, mirroring what an operator click does. */
  function invocation(data: Record<string, unknown>, sink: SentEvent[]) {
    return {
      event: { name: `${tenantSlug}/PAUSE_TEST_START`, data },
      step: {
        run: async (
          _id: string | { id: string },
          fn: (...args: unknown[]) => unknown,
          ...args: unknown[]
        ) => fn(...args),
        sendEvent: async (
          _id: string,
          payload: { name: string; data?: Record<string, unknown> },
        ) => {
          sink.push({ name: payload.name, data: payload.data ?? {} });
        },
        sleep: async () => undefined,
        waitForEvent: async (id: string, opts: { event?: string; if?: string }) => {
          if (!id.startsWith("pause-wait-")) {
            throw new Error(`unexpected waitForEvent ${id}`);
          }
          parkedAtStep = id;
          timeline.push("parked");
          expect(opts.event).toBe(`${tenantSlug}/run.resume`);
          const runId = /async\.data\.runId == "([^"]+)"/.exec(opts.if ?? "")?.[1];
          expect(runId).toBe(activeRunId);
          // Durable row really is paused while parked.
          const row = db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId!))
            .all()[0];
          expect(row?.status).toBe("paused");
          // Operator resumes through the REAL route → status running +
          // tenant run.resume event (captured by the patched broker send).
          const before = brokerSends.length;
          const res = await app.inject({
            method: "POST",
            url: `/v1/runs/${runId}/resume`,
            headers,
          });
          resumeRouteBody = (res.json() as OkEnvelope<typeof resumeRouteBody>).data;
          timeline.push("resumed-via-route");
          const resumeEvents = brokerSends.slice(before);
          expect(resumeEvents).toHaveLength(1);
          expect(resumeEvents[0]!.name).toBe(`${tenantSlug}/run.resume`);
          expect(resumeEvents[0]!.data.runId).toBe(runId);
          return { data: resumeEvents[0]!.data };
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
  }

  it("parks between actions when paused, resumes via the route, and completes ok", async () => {
    expect(agentFn).toBeTruthy();
    const sink: SentEvent[] = [];
    await agentFn!(invocation({ subject: "pause-subject-1" }, sink));

    // Ordering proof: action 1 → pause committed → park → resume → action 2.
    expect(timeline).toEqual([
      "action-1",
      "paused-via-route",
      "parked",
      "resumed-via-route",
      "action-2",
    ]);
    expect(parkedAtStep).toBe("pause-wait-2");
    expect(pauseRouteBody?.paused).toBe(true);
    expect(pauseRouteBody?.status).toBe("paused");
    expect(resumeRouteBody?.resumed).toBe(true);
    expect(resumeRouteBody?.status).toBe("running");

    const run = db.select().from(runs).where(eq(runs.id, activeRunId)).all()[0];
    expect(run?.status).toBe("ok");
    // The implicit success emission still fired after the resume.
    expect(sink.map((entry) => entry.name)).toContain(
      `${tenantSlug}/PAUSE_TEST_DONE`,
    );

    // Audit evidence for both operator actions.
    const audits = db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, activeRunId))
      .all()
      .map((row) => row.action);
    expect(audits).toContain("run.pause");
    expect(audits).toContain("run.resume");
  });

  it("pause is a no-op on terminal runs; resume is a no-op when not paused", async () => {
    const pauseTerminal = await app.inject({
      method: "POST",
      url: `/v1/runs/${activeRunId}/pause`,
      headers,
    });
    expect(pauseTerminal.statusCode).toBe(200);
    const pauseBody = (pauseTerminal.json() as OkEnvelope<{ paused: boolean; status: string }>).data;
    expect(pauseBody.paused).toBe(false);
    expect(pauseBody.status).toBe("ok");

    const resumeNotPaused = await app.inject({
      method: "POST",
      url: `/v1/runs/${activeRunId}/resume`,
      headers,
    });
    expect(resumeNotPaused.statusCode).toBe(200);
    const resumeBody = (resumeNotPaused.json() as OkEnvelope<{ resumed: boolean }>).data;
    expect(resumeBody.resumed).toBe(false);

    const missing = await app.inject({
      method: "POST",
      url: "/v1/runs/run-does-not-exist/pause",
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("memberships table sanity: suite did not depend on a membership row", () => {
    // The dev principal is a superadmin; RBAC passes without membership.
    const rows = db
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))
      .all();
    expect(rows).toHaveLength(0);
  });
});
