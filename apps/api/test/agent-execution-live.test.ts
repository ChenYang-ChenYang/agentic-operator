/**
 * §G2 — agent-execution LIVE window (routes/agent-execution.ts).
 *
 * Fastify-inject conformance suite for the Studio eval-test contract
 * (@agentic/contracts/agent-execution-live, contractVersion "1.0"):
 *   - auth: AO_API_KEY bearer/x-api-key, constant-time; 401/500 mapping,
 *   - capabilities: the 19 power-scm agents from models/power-scm-v1/,
 *   - POST executions: strict body validation + idempotent clientRequestId,
 *   - GET envelope for a finished run driven through the REAL engine
 *     (registerAgent + fake Inngest step, scripted gateway) with
 *     suppressDownstream verified (persisted emissions, NO fan-out send).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
  agentExecutions,
  agents as agentsTable,
  eventStore,
  events as eventsTable,
  getDb,
  runs,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  AoLiveCapabilitiesSchema,
  AoLiveEnvelopeSchema,
} from "@agentic/contracts";
import { agentExecutionRoutes } from "../src/routes/agent-execution";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "models/power-scm-v1/workflow_v1.json");

const WINDOW_TENANT = "power-scm";
const API_KEY = `test-ao-live-key-${Date.now().toString(36)}`;
const DIGEST = `sha256:${"ab".repeat(32)}`;

interface SentEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

function authed(extra?: Record<string, string>) {
  return { authorization: `Bearer ${API_KEY}`, ...(extra ?? {}) };
}

function executionBody(input: {
  clientRequestId: string;
  agent: string;
  eventData: Record<string, unknown>;
  suppressDownstream?: boolean;
  ontologySnapshotDigest?: string;
}) {
  return {
    contractVersion: "1.0",
    clientRequestId: input.clientRequestId,
    correlation: { runId: "eval-run-1", testCaseId: "case-1" },
    agent: input.agent,
    inputs: { eventData: input.eventData },
    config: {
      timeoutMs: 60_000,
      ...(input.suppressDownstream ? { suppressDownstream: true } : {}),
      ...(input.ontologySnapshotDigest
        ? { ontologySnapshotDigest: input.ontologySnapshotDigest }
        : {}),
    },
  };
}

/** Forecast output matching the overlay contract (mirrors the P1 E2E). */
function forecastResult() {
  return {
    gap_report: {
      gap_exists: true,
      forecast_qty: 3200,
      available_qty: 1800,
      lock: { lot_id: "InventoryLot-001", qty: 900 },
    },
    affected_regions: [
      { region_id: "GridRegion-ST-Chenghai", region_name: "汕头澄海网格", risk_level: "red" },
    ],
  };
}

describe.sequential("agent-execution live window (§G2)", () => {
  const db = getDb();
  const app = Fastify({ logger: false });
  const priorGateway = (() => {
    try {
      return getRuntimeGateway();
    } catch {
      return undefined;
    }
  })();
  const priorEnv = {
    AO_API_KEY: process.env.AO_API_KEY,
    AO_EXECUTION_TENANT: process.env.AO_EXECUTION_TENANT,
  };

  // Every getTenantInngest client shares this prototype — patching it captures
  // the route's trigger publishes without a live Inngest (event-tester idiom).
  const brokerSends: SentEvent[] = [];
  const proto = Object.getPrototypeOf(inngest) as { send: typeof inngest.send };
  const originalSend = proto.send;

  let tenantId = "";
  let createdTenant = false;
  let workflowId = "";
  const agentDbIds = new Map<string, string>();
  const registeredFns = new Map<string, (i: unknown) => Promise<unknown>>();
  const clientRequestIds: string[] = [];
  const executionIds: string[] = [];

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
      if (purpose.includes("action-forecast-typhoon-impact")) {
        return { ...base, text: JSON.stringify(forecastResult()) } as ChatResponse;
      }
      return { ...base, text: "{}" } as ChatResponse;
    },
  } as unknown as LLMGateway;

  beforeAll(async () => {
    process.env.AO_API_KEY = API_KEY;
    process.env.AO_EXECUTION_TENANT = WINDOW_TENANT;

    proto.send = (async (payload: SentEvent | SentEvent[]) => {
      const list = Array.isArray(payload) ? payload : [payload];
      brokerSends.push(...list);
      return { ids: list.map((entry) => entry.id ?? makeId("evt")) };
    }) as typeof inngest.send;

    // Window tenant row (reuse the seeded one when present).
    const existingTenant = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, WINDOW_TENANT))
      .all()[0];
    if (existingTenant) {
      tenantId = existingTenant.id;
    } else {
      tenantId = makeId("ten");
      createdTenant = true;
      db.insert(tenants)
        .values({ id: tenantId, slug: WINDOW_TENANT, name: "power-scm live window" })
        .run();
    }

    // Register the compiled manifest agents against the REAL engine so the
    // POST route's published event can be executed by the fake-step harness.
    workflowId = makeId("wf");
    db.insert(workflows)
      .values({ id: workflowId, tenantId, slug: `pscm-live-${Date.now().toString(36)}`, name: "live window E2E" })
      .run();
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown[];
    const context: RegisterContext = {
      tenantId,
      tenantSlug: WINDOW_TENANT,
      workflowVersionId: makeId("wfv"),
      tenantRegistry: { tools: {} },
    } as unknown as RegisterContext;
    for (const entry of raw) {
      const agent = AgentSchema.parse(entry);
      const agentDbId = makeId("agt");
      agentDbIds.set(agent.name, agentDbId);
      db.insert(agentsTable)
        .values({
          id: agentDbId,
          workflowId,
          kebabId: agent.name,
          name: agent.name,
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      const registered = registerAgent(agent, context) as unknown as {
        fn: (i: unknown) => Promise<unknown>;
      } | null;
      if (registered) registeredFns.set(agent.name, registered.fn);
    }
    setRuntimeGateway(scriptedGateway);

    await app.register(agentExecutionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    proto.send = originalSend;
    if (priorGateway) setRuntimeGateway(priorGateway);
    process.env.AO_API_KEY = priorEnv.AO_API_KEY;
    process.env.AO_EXECUTION_TENANT = priorEnv.AO_EXECUTION_TENANT;
    await app.close();
    // Targeted cleanup (the power-scm tenant may be a real seeded row, and a
    // prior full-bootstrap suite may have upserted its own power-scm agent
    // rows — register.ts init can attribute our runs to those, so delete runs
    // by OUR trigger event ids as well as by our agent rows).
    const agentIds = [...agentDbIds.values()];
    if (agentIds.length) {
      db.delete(runs).where(inArray(runs.agentId, agentIds)).run();
    }
    if (executionIds.length) {
      const myEventIds = db
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(inArray(eventsTable.subject, executionIds))
        .all()
        .map((row) => row.id);
      if (myEventIds.length) {
        db.delete(runs).where(inArray(runs.triggerEventId, myEventIds)).run();
      }
      db.delete(eventsTable).where(inArray(eventsTable.subject, executionIds)).run();
      db.delete(eventStore).where(inArray(eventStore.subject, executionIds)).run();
    }
    if (clientRequestIds.length) {
      db.delete(agentExecutions)
        .where(
          and(
            eq(agentExecutions.tenantSlug, WINDOW_TENANT),
            inArray(agentExecutions.clientRequestId, clientRequestIds),
          ),
        )
        .run();
    }
    if (agentIds.length) {
      db.delete(agentsTable).where(inArray(agentsTable.id, agentIds)).run();
    }
    db.delete(workflows).where(eq(workflows.id, workflowId)).run();
    if (createdTenant) db.delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  /** Fake Inngest invocation mirroring the P1 E2E harness. */
  function invocation(eventName: string, data: Record<string, unknown>, sink: SentEvent[]) {
    return {
      event: { name: eventName, data },
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
        waitForEvent: async () => {
          throw new Error("unexpected waitForEvent in this suite");
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
  }

  async function submitAndRun(body: ReturnType<typeof executionBody>): Promise<{
    executionId: string;
    fanout: SentEvent[];
  }> {
    clientRequestIds.push(body.clientRequestId);
    const before = brokerSends.length;
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-execution/live/executions",
      headers: authed({ "content-type": "application/json" }),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const { executionId } = res.json() as { executionId: string };
    expect(executionId).toMatch(/^exe-/);
    executionIds.push(executionId);
    const published = brokerSends.slice(before);
    expect(published).toHaveLength(1);
    const fn = registeredFns.get(body.agent);
    expect(fn, `registered fn for ${body.agent}`).toBeDefined();
    const fanout: SentEvent[] = [];
    await fn!(invocation(published[0]!.name, published[0]!.data, fanout));
    return { executionId, fanout };
  }

  it("rejects a missing/wrong key with 401 and reports 500 when AO_API_KEY is unset", async () => {
    const noKey = await app.inject({ method: "GET", url: "/api/agent-execution/live/capabilities" });
    expect(noKey.statusCode).toBe(401);
    expect((noKey.json() as { error: { code: string } }).error.code).toBe("unauthorized");

    const wrongKey = await app.inject({
      method: "GET",
      url: "/api/agent-execution/live/capabilities",
      headers: { "x-api-key": "not-the-key" },
    });
    expect(wrongKey.statusCode).toBe(401);

    delete process.env.AO_API_KEY;
    try {
      const unset = await app.inject({
        method: "GET",
        url: "/api/agent-execution/live/capabilities",
        headers: authed(),
      });
      expect(unset.statusCode).toBe(500);
      expect((unset.json() as { error: { code: string } }).error.code).toBe(
        "server_misconfigured",
      );
    } finally {
      process.env.AO_API_KEY = API_KEY;
    }
  });

  it("capabilities lists the 19 power-scm manifest agents and the default model route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/agent-execution/live/capabilities",
      headers: { "x-api-key": API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = AoLiveCapabilitiesSchema.parse(res.json());
    expect(body.contractVersion).toBe("1.0");
    expect(body.mode).toBe("live");
    expect(body.agents).toHaveLength(19);
    const forecast = body.agents.find((a) => a.agent === "action-forecast-typhoon-impact");
    expect(forecast).toBeDefined();
    expect(forecast!.wsId).toBe("action-forecast-typhoon-impact");
    expect(forecast!.triggerEvent).toBe("PSCM_TYPHOON_ALERT_RECEIVED");
    expect(forecast!.emitsEvents).toContain("PSCM_STOCK_GAP_IDENTIFIED");
    expect(forecast!.inngestId).toBe("power-scm.action-forecast-typhoon-impact");
    expect(body.modelCapabilities?.length).toBeGreaterThan(0);
    expect(body.modelCapabilities![0]!.available).toBe(true);
  });

  it("rejects a non-contract body (strict) and an unknown agent", async () => {
    const missingVersion = await app.inject({
      method: "POST",
      url: "/api/agent-execution/live/executions",
      headers: authed({ "content-type": "application/json" }),
      payload: { clientRequestId: "x", agent: "y", inputs: { eventData: {} }, config: { timeoutMs: 1000 } },
    });
    expect(missingVersion.statusCode).toBe(400);
    expect((missingVersion.json() as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );

    const extraKey = await app.inject({
      method: "POST",
      url: "/api/agent-execution/live/executions",
      headers: authed({ "content-type": "application/json" }),
      payload: { ...executionBody({ clientRequestId: "x2", agent: "action-lock-inventory", eventData: {} }), rogue: 1 },
    });
    expect(extraKey.statusCode).toBe(400);

    const unknownAgent = await app.inject({
      method: "POST",
      url: "/api/agent-execution/live/executions",
      headers: authed({ "content-type": "application/json" }),
      payload: executionBody({ clientRequestId: `unknown-${Date.now()}`, agent: "no-such-agent", eventData: {} }),
    });
    expect(unknownAgent.statusCode).toBe(404);
    expect((unknownAgent.json() as { error: { code: string } }).error.code).toBe(
      "unknown_agent",
    );
  });

  it("is idempotent on clientRequestId: same executionId, exactly one broker publish", async () => {
    const clientRequestId = `idem-${Date.now().toString(36)}`;
    clientRequestIds.push(clientRequestId);
    const body = executionBody({
      clientRequestId,
      agent: "action-lock-inventory",
      eventData: { gap_report: { available_qty: 1800, forecast_qty: 1000 } },
      suppressDownstream: true,
    });
    const before = brokerSends.length;
    const first = await app.inject({
      method: "POST",
      url: "/api/agent-execution/live/executions",
      headers: authed({ "content-type": "application/json" }),
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as { executionId: string }).executionId;
    executionIds.push(firstId);
    const replay = await app.inject({
      method: "POST",
      url: "/api/agent-execution/live/executions",
      headers: authed({ "content-type": "application/json" }),
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { executionId: string }).executionId).toBe(firstId);
    expect(brokerSends.length - before).toBe(1);
    // Envelope before any run exists: pending, with the ontology attestation.
    const pending = await app.inject({
      method: "GET",
      url: `/api/agent-execution/live/executions/${firstId}`,
      headers: authed(),
    });
    expect(pending.statusCode).toBe(200);
    const envelope = AoLiveEnvelopeSchema.parse(pending.json());
    expect(envelope.status).toBe("pending");
    expect(envelope.meta?.ontologyLoaded?.domain).toBe("power-scm");
    expect(envelope.meta?.ontologyLoaded?.version).toBe("v1");
    expect(envelope.meta?.ontologyLoaded?.ruleCount).toBe(11);
  });

  it("returns the full envelope for a finished run, with suppressDownstream keeping fan-out silent", async () => {
    const { executionId, fanout } = await submitAndRun(
      executionBody({
        clientRequestId: `forecast-${Date.now().toString(36)}`,
        agent: "action-forecast-typhoon-impact",
        eventData: {
          typhoon_event: { event_id: "EV-TYPHOON-1", severity: "red", landfall_eta_hours: 48 },
        },
        suppressDownstream: true,
        ontologySnapshotDigest: DIGEST,
      }),
    );
    // §G2 engine semantics: emission persisted, downstream send suppressed.
    expect(fanout).toHaveLength(0);

    const res = await app.inject({
      method: "GET",
      url: `/api/agent-execution/live/executions/${executionId}`,
      headers: authed(),
    });
    expect(res.statusCode).toBe(200);
    const envelope = AoLiveEnvelopeSchema.parse(res.json());
    expect(envelope.status).toBe("succeeded");
    expect(envelope.trace?.runId).toMatch(/^run-/);
    expect(envelope.trace?.functionSlug).toBe("power-scm.action-forecast-typhoon-impact");
    expect(envelope.trace?.steps.length).toBeGreaterThan(0);
    expect(envelope.trace?.steps.every((s) => s.status === "ok")).toBe(true);
    expect(envelope.trace?.emittedEvents).toContain("PSCM_STOCK_GAP_IDENTIFIED");
    const output = envelope.result?.output as { gap_report?: { forecast_qty?: number } } | null;
    expect(output?.gap_report?.forecast_qty).toBe(3200);
    expect(envelope.meta?.agent).toBe("action-forecast-typhoon-impact");
    expect(envelope.meta?.triggerEvent).toBe("PSCM_TYPHOON_ALERT_RECEIVED");
    expect(envelope.meta?.eventIds.length).toBeGreaterThanOrEqual(2);
    expect(envelope.meta?.startedAt).toBeTruthy();
    expect(envelope.meta?.finishedAt).toBeTruthy();
    expect(envelope.meta?.ontologyLoaded?.snapshotDigest).toBe(DIGEST);
    expect(envelope.meta?.ontologyLoaded?.liveConsistency).toBeNull();
    expect(envelope.error ?? null).toBeNull();
  });

  it("harvests rule-gate:* condition verdicts into ruleEvaluations", async () => {
    // available >= forecast → EMG-002 condition false → the write/emit chain
    // is skipped; the deterministic gate itself records evaluated_violated.
    const { executionId } = await submitAndRun(
      executionBody({
        clientRequestId: `gate-${Date.now().toString(36)}`,
        agent: "action-lock-inventory",
        eventData: {
          gap_report: {
            available_qty: 1800,
            forecast_qty: 1000,
            lock: { lot_id: "InventoryLot-001", qty: 900 },
          },
        },
        suppressDownstream: true,
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/agent-execution/live/executions/${executionId}`,
      headers: authed(),
    });
    const envelope = AoLiveEnvelopeSchema.parse(res.json());
    expect(envelope.status).toBe("succeeded");
    const gate = envelope.trace?.ruleEvaluations.find(
      (entry) => entry.ruleId === "PSCM-EMG-002",
    );
    expect(gate).toBeDefined();
    expect(gate!.status).toBe("evaluated_violated");
    expect(gate!.reason).toBe("deterministic condition");
    // The gated ERP write never ran.
    expect(
      envelope.trace?.steps.map((s) => s.name),
    ).not.toContain("metaerp.invoke");
    expect(envelope.trace?.emittedEvents).not.toContain("PSCM_INVENTORY_LOCKED");
  });
});
