/**
 * power-scm scenario 1 「风暴 72 小时」 end-to-end cascade (redesign 2026-08-19).
 *
 * Drives the REAL engine (registerAgent + step-engine) over the ontology-
 * compiled manifest (models/power-scm-v1/workflow_v1.json) with:
 *   - a real in-process mock Meta ERP (@agentic/mock-erp) on an ephemeral port,
 *   - a scripted fake LLM gateway keyed by request.purpose,
 *   - a fake Inngest step whose waitForEvent auto-approves HITL tasks the way
 *     the resolve API would (status open→resolving + matching resumeMarker),
 *   - a breadth-first cascade driver that redelivers emitted events to the
 *     manifest subscribers, mirroring Inngest name-based fan-out.
 *
 * Chain under test:
 *   PSCM_TYPHOON_ALERT_RECEIVED
 *     → action-forecast-typhoon-impact   (logic + metaerp query tool loop)
 *     → PSCM_STOCK_GAP_IDENTIFIED
 *       → action-lock-inventory          (EMG-002 gate → ERP write)
 *       → action-create-stock-transfer   (gate → 应急审批 manual → ERP write)
 *       → action-create-emergency-po     (EMG-002 + EMG-004 judge → manual → write)
 *       → action-create-collab-request   (ERP write)
 *     → PSCM_STOCK_TRANSFER_CREATED → action-dispatch-logistics (ERP write)
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  AgentSchema,
  getRuntimeGateway,
  registerAgent,
  setRuntimeGateway,
  type RegisterContext,
} from "@agentic/runtime";
import type { LLMGateway } from "@agentic/llm-gateway";
import type { ChatRequest, ChatResponse } from "@agentic/llm-gateway";
import { buildApp } from "@agentic/mock-erp";
import {
  agents as agentsTable,
  eventStore,
  getDb,
  runs,
  tasks as tasksTable,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "models/power-scm-v1/workflow_v1.json");
const ALLMETA_DIST = "/Users/kenny/CSI-AICOE/allmetaOntology/demo-packages/power-scm/dist";

const suffix = Date.now().toString(36).toLowerCase();
const tenantSlug = `pscm-e2e-${suffix}`;

interface SentEvent {
  name: string;
  data: Record<string, unknown>;
}

/** Forecast result satisfying the overlay output contract + downstream arg maps. */
function forecastResult(overrides?: { emergencyClause?: boolean; gapExists?: boolean }) {
  const emergencyClause = overrides?.emergencyClause ?? true;
  const gapExists = overrides?.gapExists ?? true;
  return {
    gap_report: {
      gap_exists: gapExists,
      forecast_qty: gapExists ? 3200 : 1000,
      available_qty: 1800,
      transfer: {
        material_id: "MAT-ST-P12",
        from_warehouse: "Warehouse-WZ-01",
        to_warehouse: "Warehouse-ST-01",
        qty: 1200,
      },
      lock: { lot_id: "InventoryLot-001", qty: 900 },
      recommended_po: {
        agreement_id: "FA-001",
        supplier_id: "SUP-004",
        material_id: "MAT-ST-P12",
        qty: 800,
      },
      agreement: {
        agreement_id: "FA-001",
        valid_from: "2025-10-24",
        valid_to: "2027-10-24",
        emergency_clause: emergencyClause,
      },
      collab: { target_entity_id: "LegalEntity-JY-001", material_id: "MAT-ST-P12", qty: 400 },
    },
    affected_regions: [
      { region_id: "GridRegion-ST-Chenghai", region_name: "汕头澄海网格", risk_level: "red" },
    ],
  };
}

describe.sequential("power-scm scenario 1 storm-72h cascade (E2E)", () => {
  const db = getDb();
  const priorGateway = (() => {
    try {
      return getRuntimeGateway();
    } catch {
      return undefined;
    }
  })();

  let tenantId: string;
  let erp: ReturnType<typeof buildApp>;
  let erpBase = "";
  const registeredByTrigger = new Map<string, Array<{ name: string; fn: (i: unknown) => Promise<unknown> }>>();
  const agentDbIds = new Map<string, string>();

  // gateway scripting state
  let forecastCalls = 0;
  let emg004Verdict: "pass" | "violation" = "pass";
  let forecastOverrides: { emergencyClause?: boolean; gapExists?: boolean } | undefined;

  const scriptedGateway = {
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const purpose = request.purpose ?? "";
      const base = {
        provider: "mock",
        model: "scripted",
        tokensIn: 100,
        tokensOut: 50,
        finishReason: "stop",
        latencyMs: 1,
      };
      if (purpose.includes("action-forecast-typhoon-impact")) {
        forecastCalls += 1;
        if (forecastCalls === 1) {
          // First turn: exercise the merged multi-operation query tool for real.
          return {
            ...base,
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "metaerp.invoke",
                input: { operation: "queryInventoryLots", payload: { MATERIAL_CODE: "MAT-ST-P12" } },
              },
            ],
          } as unknown as ChatResponse;
        }
        return { ...base, text: JSON.stringify(forecastResult(forecastOverrides)) } as ChatResponse;
      }
      if (purpose.includes("rule-gate:PSCM-EMG-004")) {
        return {
          ...base,
          text: JSON.stringify({
            ruleId: "PSCM-EMG-004",
            status: emg004Verdict,
            reason:
              emg004Verdict === "pass"
                ? "框架协议在效且含应急供货条款"
                : "框架协议不含应急供货条款",
          }),
        } as ChatResponse;
      }
      return { ...base, text: "{}" } as ChatResponse;
    },
  } as unknown as LLMGateway;

  beforeAll(async () => {
    // 1) mock Meta ERP on an ephemeral port
    erp = buildApp({
      dataDir: path.join(ALLMETA_DIST, "mock-erp"),
      transformMapsPath: path.join(ALLMETA_DIST, "transform-maps/transform-maps.json"),
      stateDir: mkdtempSync(path.join(tmpdir(), "pscm-e2e-erp-")),
      logger: false,
    });
    await erp.app.listen({ port: 0, host: "127.0.0.1" });
    const address = erp.app.server.address();
    if (!address || typeof address === "string") throw new Error("mock-erp address unavailable");
    erpBase = `http://127.0.0.1:${address.port}`;
    process.env.METAERP_BASE_URL = erpBase;

    // 2) tenant + workflow + agents rows
    tenantId = makeId("ten");
    const workflowId = makeId("wf");
    db.insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "power-scm E2E" }).run();
    db.insert(workflows)
      .values({ id: workflowId, tenantId, slug: "power-scm", name: "电力供应链数字孪生" })
      .run();

    // 3) register every compiled manifest agent against the REAL engine
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
    const manifestAgents: unknown[] = Array.isArray(raw)
      ? raw
      : ((raw as { agents?: unknown[] }).agents ?? []);
    expect(manifestAgents.length).toBe(19);
    const context: RegisterContext = {
      tenantId,
      tenantSlug,
      workflowVersionId: makeId("wfv"),
      tenantRegistry: { tools: {} },
    } as unknown as RegisterContext;
    for (const entry of manifestAgents) {
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
      if (!registered) continue;
      for (const trigger of agent.trigger) {
        const list = registeredByTrigger.get(trigger) ?? [];
        list.push({ name: agent.name, fn: registered.fn });
        registeredByTrigger.set(trigger, list);
      }
    }
    setRuntimeGateway(scriptedGateway);
  });

  afterAll(async () => {
    if (priorGateway) setRuntimeGateway(priorGateway);
    await erp.app.close();
    db.delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  /** Fake Inngest invocation: step.run executes, sendEvent records, and
   * waitForEvent auto-approves the HITL task exactly like the resolve API. */
  function invocation(eventName: string, data: Record<string, unknown>, sink: SentEvent[]) {
    return {
      event: { name: `${tenantSlug}/${eventName}`, data },
      step: {
        run: async (
          _id: string | { id: string },
          fn: (...args: unknown[]) => unknown,
          ...args: unknown[]
        ) => fn(...args),
        sendEvent: async (_id: string, payload: { name: string; data?: Record<string, unknown> }) => {
          sink.push({ name: payload.name, data: payload.data ?? {} });
        },
        sleep: async () => undefined,
        waitForEvent: async (_id: string, opts: { if?: string }) => {
          const cond = opts?.if ?? "";
          const taskId = /async\.data\.taskId == "([^"]+)"/.exec(cond)?.[1];
          const resumeMarker = /async\.data\.resumeMarker == "([^"]+)"/.exec(cond)?.[1];
          if (!taskId || !resumeMarker) throw new Error(`unparseable waitForEvent condition: ${cond}`);
          // Mirror POST /v1/tasks/:id/resolve persistence: open → resolving.
          db.update(tasksTable)
            .set({ status: "resolving" })
            .where(eq(tasksTable.id, taskId))
            .run();
          return {
            data: { taskId, tenantId, resumeMarker, decision: "approve", payload: null },
          };
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
  }

  /** Breadth-first cascade: deliver an event to every subscribed agent, then
   * redeliver whatever they emitted (Inngest name-based fan-out stand-in). */
  async function dispatchCascade(
    rootEvent: string,
    rootData: Record<string, unknown>,
    opts?: { only?: string[] },
  ): Promise<string[]> {
    const delivered: string[] = [];
    const queue: SentEvent[] = [{ name: rootEvent, data: rootData }];
    let hops = 0;
    while (queue.length > 0) {
      if (++hops > 40) throw new Error("cascade runaway");
      const evt = queue.shift()!;
      const bare = evt.name.includes("/") ? evt.name.split("/").slice(1).join("/") : evt.name;
      delivered.push(bare);
      const listeners = registeredByTrigger.get(bare) ?? [];
      for (const listener of listeners) {
        if (opts?.only && !opts.only.includes(listener.name)) continue;
        const sink: SentEvent[] = [];
        await listener.fn(
          invocation(bare, { subject: String(rootData.subject ?? "storm"), ...evt.data }, sink),
        );
        queue.push(...sink);
      }
    }
    return delivered;
  }

  function runsFor(agentName: string) {
    const agentDbId = agentDbIds.get(agentName);
    if (!agentDbId) throw new Error(`unknown agent ${agentName}`);
    return db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentDbId))
      .orderBy(desc(runs.startedAt))
      .all();
  }

  async function journalOps(): Promise<Array<{ op: string; payload: Record<string, unknown>; result: { ok?: boolean; id?: string } }>> {
    const res = await fetch(`${erpBase}/__journal`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { entries?: unknown[] } | unknown[];
    const entries = Array.isArray(body) ? body : (body.entries ?? []);
    return entries as Array<{ op: string; payload: Record<string, unknown>; result: { ok?: boolean; id?: string } }>;
  }

  it("runs the full storm cascade: forecast → lock/transfer/po/collab → logistics, with HITL approvals and real ERP writes", async () => {
    forecastCalls = 0;
    emg004Verdict = "pass";
    forecastOverrides = undefined;
    await fetch(`${erpBase}/__reset`, { method: "POST" });

    const delivered = await dispatchCascade("PSCM_TYPHOON_ALERT_RECEIVED", {
      subject: "typhoon-haiyan-001",
      typhoon_event: {
        event_id: "EV-TYPHOON-HAIYAN",
        severity: "red",
        landfall_eta_hours: 48,
      },
    });

    // Event chain reached every stage of the storm scenario.
    expect(delivered).toContain("PSCM_TYPHOON_ALERT_RECEIVED");
    expect(delivered).toContain("PSCM_STOCK_GAP_IDENTIFIED");
    expect(delivered).toContain("PSCM_INVENTORY_LOCKED");
    expect(delivered).toContain("PSCM_STOCK_TRANSFER_CREATED");
    expect(delivered).toContain("PSCM_EMERGENCY_PO_CREATED");
    expect(delivered).toContain("PSCM_COLLAB_REQUESTED");
    expect(delivered).toContain("PSCM_LOGISTICS_DISPATCHED");

    // The forecast agent really exercised the merged query tool (2 LLM turns).
    expect(forecastCalls).toBe(2);

    // Every agent in the chain completed ok against the real engine.
    for (const name of [
      "action-forecast-typhoon-impact",
      "action-lock-inventory",
      "action-create-stock-transfer",
      "action-create-emergency-po",
      "action-create-collab-request",
      "action-dispatch-logistics",
    ]) {
      const [latest] = runsFor(name);
      expect(latest, `run row for ${name}`).toBeDefined();
      expect(latest!.status, `status of ${name}`).toBe("ok");
    }

    // HITL: 应急审批 tasks were created and auto-approved (transfer + PO).
    const taskRows = db.select().from(tasksTable).where(eq(tasksTable.tenantId, tenantId)).all();
    expect(taskRows.length).toBeGreaterThanOrEqual(2);
    for (const task of taskRows) expect(["resolved", "resolving"]).toContain(task.status);

    // Real ERP side effects, in order, with id propagation transfer → shipment.
    const ops = await journalOps();
    const opNames = ops.map((entry) => entry.op);
    expect(opNames).toContain("lockInventoryLot");
    expect(opNames).toContain("createTransferOrder");
    expect(opNames).toContain("createEmergencyPo");
    expect(opNames).toContain("createCollabRequest");
    expect(opNames).toContain("createShipmentTask");
    const transferEntry = ops.find((entry) => entry.op === "createTransferOrder")!;
    const shipmentEntry = ops.find((entry) => entry.op === "createShipmentTask")!;
    expect(transferEntry.result.id).toBeTruthy();
    expect(String(shipmentEntry.payload.transfer_id ?? shipmentEntry.payload.TRANSFER_ID)).toBe(
      String(transferEntry.result.id),
    );

    // Durable event records exist for the emitted chain (event_store rows).
    const storeRows = db
      .select()
      .from(eventStore)
      .where(eq(eventStore.tenantId, tenantId))
      .all();
    const storeNames = new Set(storeRows.map((row) => row.name));
    for (const expected of [
      "PSCM_STOCK_GAP_IDENTIFIED",
      "PSCM_STOCK_TRANSFER_CREATED",
      "PSCM_EMERGENCY_PO_CREATED",
      "PSCM_LOGISTICS_DISPATCHED",
    ]) {
      expect(storeNames.has(expected), `event_store has ${expected}`).toBe(true);
    }
  });

  it("blocks the emergency PO when the EMG-004 judge rules violation: no ERP write, no downstream emission", async () => {
    forecastCalls = 0;
    emg004Verdict = "violation";
    await fetch(`${erpBase}/__reset`, { method: "POST" });

    const gapPayload = {
      subject: "storm-blocked-po",
      ...forecastResult({ emergencyClause: false }),
    };
    await dispatchCascade("PSCM_STOCK_GAP_IDENTIFIED", gapPayload, {
      only: ["action-create-emergency-po"],
    });

    const [latest] = runsFor("action-create-emergency-po");
    expect(latest).toBeDefined();
    // Blocked-by-gate runs finish (gates recorded, write/emit skipped).
    expect(latest!.status).toBe("ok");

    const ops = await journalOps();
    expect(ops.map((entry) => entry.op)).not.toContain("createEmergencyPo");

    const emitted = db
      .select()
      .from(eventStore)
      .where(eq(eventStore.sourceRunId, latest!.id))
      .all();
    expect(emitted.map((row) => row.name)).not.toContain("PSCM_EMERGENCY_PO_CREATED");
  });

  it("skips the whole gap-response branch when EMG-002 finds no gap (condition gate false)", async () => {
    emg004Verdict = "pass";
    await fetch(`${erpBase}/__reset`, { method: "POST" });

    const noGap = {
      subject: "storm-no-gap",
      ...forecastResult({ gapExists: false }),
    };
    // available 1800 >= forecast 1000 → EMG-002 condition false → skip chain.
    noGap.gap_report.available_qty = 1800;
    noGap.gap_report.forecast_qty = 1000;
    await dispatchCascade("PSCM_STOCK_GAP_IDENTIFIED", noGap, {
      only: ["action-create-stock-transfer"],
    });

    const [latest] = runsFor("action-create-stock-transfer");
    expect(latest!.status).toBe("ok");
    const ops = await journalOps();
    expect(ops.map((entry) => entry.op)).not.toContain("createTransferOrder");
    // No HITL task for this subject: the manual step sat behind the gate.
    const taskRows = db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.tenantId, tenantId))
      .all();
    const blockedSubjectTasks = taskRows.filter((task) =>
      String(task.payloadJson ?? "").includes("storm-no-gap"),
    );
    expect(blockedSubjectTasks).toHaveLength(0);
  });
});
