/**
 * 采购-HC-Formal · 场景一「采购链路执行偏差预警」end-to-end cascade.
 *
 * Every one of the 15 deviation-chain agents runs on the REAL engine
 * (registerAgent + step-engine) over the ontology-compiled manifest
 * (models/procurement-hc-formal-v1/workflow_v1.json), with the same harness
 * as the 场景二 suite: the in-process mock Meta ERP loaded with the checked-in
 * data plane, a scripted LLM gateway keyed by request.purpose (the analysis
 * agents' JSON contracts), a fake Inngest step whose waitForEvent fills the
 * human forms by task type, and a breadth-first cascade driver.
 *
 * Chain under test:
 *   DAILY_DEVIATION_SCAN_SCHEDULED
 *     → collectChainExecutionData       (logic + one real merged-query tool round)
 *     → CHAIN_PROGRESS_SYNCED → calculateExecutionDeviation
 *        ├ NO_DEVIATION_CONFIRMED → archiveDeviationMonitoring → CHAIN_MONITORING_ARCHIVED
 *        └ DEVIATION_DETECTED → scoreOnTimeProbability
 *           → ON_TIME_PROBABILITY_SCORED → raiseDeviationAlert (pushAlert)
 *           → DEVIATION_ALERT_RAISED
 *              ├ handleBlueAlertLocally (BR-ALERT-03 gate → 计划员 ×2 → closeBlueAlert)
 *              └ generateAdjustmentOptions (BR-OPT-01: 蓝色 → nothing)
 *                 → ADJUSTMENT_OPTIONS_GENERATED → approveAdjustmentOption (领导拍板 → 计划员确认 → ERP)
 *                 → ADJUSTMENT_OPTION_APPROVED
 *                    ├ compressDownstreamCycle   (submission gate 压缩后续周期, BR-OPT-05)
 *                    ├ adjustRequiredArrivalDate (submission gate 调整需求日期, BR-OPT-05)
 *                    └ createStockTransferRequest (submission gate 执行调拨, BR-OPT-05)
 *                       → STOCK_TRANSFER_REQUEST_CREATED → trackTransferFulfillment
 *                 → … → closeDeviationHandling (writeEventLog) → DEVIATION_HANDLING_CLOSED
 *                 → recycleFalseAlarm (BR-FB-01 gate → 规则评审组 → createReviewItem)
 *   ALERT_TIMEOUT_SCAN_SCHEDULED → escalateOverdueAlert (escalateAlert) → DEVIATION_ALERT_ESCALATED
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
  subscribe as subscribeStream,
  type RegisterContext,
} from "@agentic/runtime";
import type { ChatRequest, ChatResponse, LLMGateway } from "@agentic/llm-gateway";
import { buildApp } from "@agentic/mock-erp";
import {
  agents as agentsTable,
  eventStore,
  getDb,
  runs,
  steps as stepsTable,
  tasks as tasksTable,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "models/procurement-hc-formal-v1/workflow_v1.json");
const PACKAGE_DIR = path.join(REPO_ROOT, "ontology-packages/procurement-hc-formal/package");

const suffix = Date.now().toString(36).toLowerCase();
const tenantSlug = `hcf1-e2e-${suffix}`;

const SCAN_DATE = "2026-09-07";
const PLAN_ID = "PBP-2026-0873";
const PLAN_LINE_ID = "PBPL-2026-0873-01";
const CHAIN_ID = "CHN-2026-0873-01";
const DEVIATION_ID = "DEV-2026-09-07-1";

interface SentEvent {
  name: string;
  data: Record<string, unknown>;
}
type Row = Record<string, unknown>;

const SCENARIO_ONE = [
  "collectChainExecutionData",
  "calculateExecutionDeviation",
  "archiveDeviationMonitoring",
  "scoreOnTimeProbability",
  "raiseDeviationAlert",
  "handleBlueAlertLocally",
  "generateAdjustmentOptions",
  "approveAdjustmentOption",
  "escalateOverdueAlert",
  "compressDownstreamCycle",
  "adjustRequiredArrivalDate",
  "createStockTransferRequest",
  "trackTransferFulfillment",
  "closeDeviationHandling",
  "recycleFalseAlarm",
];

// ── scripted analysis outputs (each satisfies its overlay output contract) ───

const STAGES = ["立项", "组包", "询价", "定标", "合同", "订单", "到货"] as const;

function chain(): Row {
  return {
    chain_id: CHAIN_ID,
    plan_id: PLAN_ID,
    plan_line_id: PLAN_LINE_ID,
    business_type: "物资",
    material_code: "M-CT-110",
    material_name: "110kV 电流互感器",
    quantity: 20,
    unit: "台",
    required_arrival_date: "2026-11-30",
    current_stage: "询价",
    chain_status: "在途",
    planner: "张计划",
    buyer: "李采购",
    demand_department: "检修一部",
    forecast_arrival_date: "2026-12-20",
    last_synced_at: `${SCAN_DATE}T01:00:00+08:00`,
    stalled_at: "询价",
  };
}

function collectResult(): Row {
  const finished = ["2026-07-10", "2026-07-28", null, null, null, null, null];
  return {
    scan_date: SCAN_DATE,
    procurement_chain: [chain()],
    stage_progress_list: STAGES.map((node, index) => ({
      stage_progress_id: `SPG-${CHAIN_ID}-${index + 1}`,
      chain_id: CHAIN_ID,
      stage_node: node,
      stage_sequence: index + 1,
      actual_finish_date: finished[index],
      stage_status: finished[index] ? "已完成" : index === 2 ? "进行中" : "未开始",
      source_document_type: ["采购申请", "采购包", "询价单", "定标", "合同", "订单", "验收"][index],
      source_document_no: finished[index] ? `DOC-${index + 1}` : "",
      stage_started_at: index <= 2 ? "2026-07-01" : null,
      synced_at: `${SCAN_DATE}T01:00:00+08:00`,
    })),
    synced_stage_count: 7,
    coverage_note: `按事件指定范围只处理 ${PLAN_ID}`,
    identifier_discipline: "所有编码取自 metaERP 原值",
    query_rounds_used: 1,
    queried_operations: ["queryOpenPbpHeader"],
  };
}

function deviationResult(found: boolean): Row {
  return {
    scan_date: SCAN_DATE,
    procurement_chain: [chain()],
    planned_dates: STAGES.map((node, index) => ({
      stage_node: node,
      stage_sequence: index + 1,
      standard_cycle_days: [10, 15, 20, 15, 15, 10, 70][index],
      planned_finish_date: ["2026-06-01", "2026-06-16", "2026-07-06", "2026-07-21", "2026-08-05", "2026-08-15", "2026-11-30"][index],
      planned_date_derived: true,
    })),
    thresholds_used: { time_deviation_days: 3, schedule_deviation_ratio: 0.1, threshold_ids: ["THR-001", "THR-002"] },
    execution_deviation: [
      {
        deviation_id: DEVIATION_ID,
        chain_id: CHAIN_ID,
        stage_progress_id: `SPG-${CHAIN_ID}-3`,
        stage_node: "询价",
        planned_finish_date: "2026-07-06",
        actual_finish_date: null,
        time_deviation_days: found ? 63 : 1,
        schedule_deviation_ratio: found ? 0.42 : 0,
        amount_deviation_ratio: null,
        has_deviation: found,
        deviation_level: "待定级",
        cause_tag: found ? "供应商响应慢" : "",
        cause_explanation: found ? "询价阶段已滞留 63 天" : "未达阈值",
        cause_clarification_status: "待澄清",
        dwell_days: found ? 63 : 1,
        disposal_state: "待评分",
        evaluated_at: `${SCAN_DATE}T01:05:00+08:00`,
      },
    ],
    blocking_note: "",
    _parallel_tool_calls: "已在同一轮发出 queryStageCycleConfig、queryAlertThresholdConfig",
    deviation_found: found,
  };
}

function deviationBlockedResult(): Row {
  return {
    ...deviationResult(false),
    planned_dates: [],
    execution_deviation: [],
    blocking_note: "无法获取业务类型【物资】×节点【询价】的周期配置，根据 BR-PLAN-01 不予推算。",
    deviation_found: false,
  };
}

function scoreResult(level: "红色" | "黄色" | "蓝色"): Row {
  const deviation = (deviationResult(true).execution_deviation as Row[])[0]!;
  return {
    scan_date: SCAN_DATE,
    execution_deviation: [deviation],
    procurement_chain: [chain()],
    probability_assessment: [
      {
        assessment_id: "ASM-2026-09-07-1",
        deviation_id: DEVIATION_ID,
        chain_id: CHAIN_ID,
        current_stage: "询价",
        remaining_standard_cycle_days: 110,
        days_to_required_arrival: 84,
        dwell_days: 63,
        historical_on_time_rate: 0.62,
        historical_sample_size: 40,
        on_time_probability: level === "红色" ? 0.12 : level === "黄色" ? 0.45 : 0.86,
        probability_grade: level,
        explanation: "剩余标准周期 110 天已超过距需求到货 84 天，历史按期率 62%",
      },
    ],
    alert_level: level,
    _parallel_tool_calls: "已在同一轮发出三个查询",
  };
}

function optionsResult(alert: Row, generated: boolean): Row {
  const base = { alert_id: alert.alert_id, chain_id: CHAIN_ID, arrival_impact_simulated: true, option_status: "待决策", decision_role: "分管领导" };
  const options = generated
    ? [
        { ...base, option_id: "OPT-1", option_type: "压缩后续周期", option_summary: "定标/合同并行压缩 12 天", expected_arrival_date_after: "2026-12-08", arrival_impact_days: -12, feasibility_note: "供应商已确认", is_recommended: false, is_high_risk: false },
        { ...base, option_id: "OPT-2", option_type: "调整需求日期", option_summary: "需求日期顺延至 2026-12-20", expected_arrival_date_after: "2026-12-20", arrival_impact_days: 20, feasibility_note: "需检修计划配合", is_recommended: false, is_high_risk: false },
        { ...base, option_id: "OPT-3", option_type: "执行调拨", option_summary: "自华北仓调拨 20 台", expected_arrival_date_after: "2026-09-15", arrival_impact_days: -76, feasibility_note: "可调库存 24 台", is_recommended: true, is_high_risk: false },
      ]
    : [];
  return {
    options_generated: generated,
    options,
    recommended_option: generated ? { ...options[2]!, recommendation_basis: "到货最早且无高危动作" } : null,
    transfer_source: { warehouse_id: "WH-HB-01", warehouse_name: "华北中心仓", item_code: "M-CT-110", available_qty: 24, transfer_lead_days: 7, transfer_quantity: 20 },
    alert_context: { alert_id: alert.alert_id, chain_id: CHAIN_ID, deviation_id: DEVIATION_ID, alert_level: alert.alert_level, notified_role: alert.notified_role },
    _parallel_tool_calls: "已在同一轮发出 queryStageCycleConfig、queryTransferableStock",
  };
}

function archiveResult(): Row {
  return {
    archived_deviation: { deviation_id: DEVIATION_ID, chain_id: CHAIN_ID, disposal_state: "已归档", archived_at: `${SCAN_DATE}T01:10:00+08:00` },
    monitoring_note: "时间偏差 1 天、进度偏差 0，均未达阈值，链路继续在途盯防",
  };
}

// ── harness ───────────────────────────────────────────────────────────────────

describe("采购-HC-Formal 场景一 deviation-alert cascade (E2E)", () => {
  let erp: ReturnType<typeof buildApp>;
  let erpBase = "";
  let tenantId = "";
  let unsubscribeStream: (() => void) | undefined;
  const streamErrors: string[] = [];
  const db = getDb();
  const registeredByTrigger = new Map<string, Array<{ name: string; fn: (input: unknown) => Promise<unknown> }>>();
  const agentDbIds = new Map<string, string>();
  const priorGateway = (() => {
    try {
      return getRuntimeGateway();
    } catch {
      return null;
    }
  })();

  // gateway scripting state
  let collectCalls = 0;
  let deviationFound = true;
  let deviationBlocked = false;
  let alertLevel: "红色" | "黄色" | "蓝色" = "红色";
  let chosenOption: "压缩后续周期" | "调整需求日期" | "执行调拨" = "执行调拨";

  const scriptedGateway = {
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const purpose = request.purpose ?? "";
      const base = { provider: "mock", model: "scripted", tokensIn: 100, tokensOut: 50, finishReason: "stop", latencyMs: 1 };
      const answer = (value: Row): ChatResponse => ({ ...base, text: JSON.stringify(value) }) as ChatResponse;
      if (purpose.includes("collectChainExecutionData")) {
        collectCalls += 1;
        if (collectCalls === 1) {
          // First turn: exercise the merged multi-operation query tool for real.
          return {
            ...base,
            text: "",
            toolCalls: [{ id: "call-collect-1", name: "metaerp.invoke", input: { operation: "queryOpenPbpHeader", payload: { PBP_HEADER_ID: PLAN_ID } } }],
          } as unknown as ChatResponse;
        }
        return answer(collectResult());
      }
      if (purpose.includes("calculateExecutionDeviation")) return answer(deviationBlocked ? deviationBlockedResult() : deviationResult(deviationFound));
      if (purpose.includes("archiveDeviationMonitoring")) return answer(archiveResult());
      if (purpose.includes("scoreOnTimeProbability")) return answer(scoreResult(alertLevel));
      if (purpose.includes("generateAdjustmentOptions")) {
        const alertContext = (request.messages ?? [])
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n");
        const alertId = /"alert_id"\s*:\s*"([^"]+)"/.exec(alertContext)?.[1] ?? "ALT-UNKNOWN";
        const level = /"alert_level"\s*:\s*"([^"]+)"/.exec(alertContext)?.[1] ?? alertLevel;
        return answer(optionsResult({ alert_id: alertId, alert_level: level, notified_role: level === "红色" ? "分管领导" : level === "黄色" ? "部门领导" : "计划员" }, level !== "蓝色"));
      }
      return answer({});
    },
  } as unknown as LLMGateway;

  /** Human forms by task type — filled the way the portal would from the task's context. */
  function formFor(taskType: string, data: Record<string, unknown>): Record<string, unknown> {
    switch (taskType) {
      case "adjustment.select":
        return {
          option_id: chosenOption === "压缩后续周期" ? "OPT-1" : chosenOption === "调整需求日期" ? "OPT-2" : "OPT-3",
          option_type: chosenOption,
          decision_role: "分管领导",
          decided_by: "王分管",
          comment: "按推荐方案执行",
          is_high_risk: false,
          high_risk_confirmed_by: "",
        };
      case "adjustment.planner-confirm":
        return {
          decision: "approved",
          planner_confirmed_by: "张计划",
          alert_id: data.alert_id,
          chain_id: data.chain_id ?? CHAIN_ID,
          option_id: chosenOption === "压缩后续周期" ? "OPT-1" : chosenOption === "调整需求日期" ? "OPT-2" : "OPT-3",
          option_type: chosenOption,
          remark: "计划员已确认执行",
        };
      case "blue-alert.review":
        return { reviewed: true, note: "已查看偏差画像与按期概率" };
      case "blue-alert.decide":
        return { alert_id: data.alert_id, handling_action: "仅继续监控", remark: "蓝色预警，计划员自行盯防" };
      case "feedback.classify":
        return { false_alarm_cause: "阈值过严", suggested_threshold_value: 5, remark: "询价阶段 3 天阈值偏严" };
      default:
        return { decision: "approved" };
    }
  }

  function invocation(eventName: string, data: Record<string, unknown>, sink: SentEvent[], attempt = 0) {
    return {
      event: { name: `${tenantSlug}/${eventName}`, data },
      attempt,
      step: {
        run: async (_id: string | { id: string }, fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
        sendEvent: async (_id: string, payload: { name: string; data?: Record<string, unknown> }) => {
          // Inngest serialises every event to JSON on the wire; mirror that so
          // shared object references never reach the next agent.
          sink.push({ name: payload.name, data: JSON.parse(JSON.stringify(payload.data ?? {})) as Record<string, unknown> });
        },
        sleep: async () => undefined,
        waitForEvent: async (_id: string, opts: { if?: string }) => {
          const cond = opts?.if ?? "";
          const taskId = /async\.data\.taskId == "([^"]+)"/.exec(cond)?.[1];
          const resumeMarker = /async\.data\.resumeMarker == "([^"]+)"/.exec(cond)?.[1];
          if (!taskId || !resumeMarker) throw new Error(`unparseable waitForEvent condition: ${cond}`);
          const task = db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).all()[0];
          if (!task) throw new Error(`waitForEvent names unknown task ${taskId}`);
          db.update(tasksTable).set({ status: "resolving" }).where(eq(tasksTable.id, taskId)).run();
          return { data: { taskId, tenantId, resumeMarker, decision: "approve", payload: formFor(String(task.type), data) } };
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
  }

  /** Breadth-first cascade: deliver an event to every subscribed agent, then redeliver what they emitted. */
  async function dispatchCascade(rootEvent: string, rootData: Record<string, unknown>, opts?: { only?: string[] }): Promise<string[]> {
    const delivered: string[] = [];
    const queue: SentEvent[] = [{ name: rootEvent, data: rootData }];
    let hops = 0;
    while (queue.length > 0) {
      if (++hops > 60) throw new Error("cascade runaway");
      const evt = queue.shift()!;
      const bare = evt.name.includes("/") ? evt.name.split("/").slice(1).join("/") : evt.name;
      delivered.push(bare);
      for (const listener of registeredByTrigger.get(bare) ?? []) {
        if (opts?.only && !opts.only.includes(listener.name)) continue;
        const sink: SentEvent[] = [];
        try {
          await listener.fn(invocation(bare, { subject: String(rootData.subject ?? "hcf1"), ...evt.data }, sink));
        } catch (error) {
          const failedStep = db.select().from(stepsTable).where(eq(stepsTable.status, "failed")).orderBy(desc(stepsTable.startedAt)).limit(1).all()[0];
          const tail = (await journalOps()).slice(-2).map((entry) => `${entry.op} ← ${JSON.stringify(entry.payload).slice(0, 400)} → ${JSON.stringify(entry.result).slice(0, 300)}`);
          throw new Error(
            `${listener.name} on ${bare} failed: ${(error as Error).message}\n  failed step: ${failedStep?.name ?? "?"} (${failedStep?.error ?? ""})\n  stream errors: ${streamErrors.slice(-4).join(" | ")}\n  journal tail:\n  ${tail.join("\n  ")}`,
          );
        }
        queue.push(...sink);
      }
    }
    return delivered;
  }

  function runsFor(agentName: string) {
    const agentDbId = agentDbIds.get(agentName);
    if (!agentDbId) throw new Error(`unknown agent ${agentName}`);
    return db.select().from(runs).where(eq(runs.agentId, agentDbId)).orderBy(desc(runs.startedAt)).all();
  }

  async function journalOps(): Promise<Array<{ op: string; payload: Row; result: Row }>> {
    const res = await fetch(`${erpBase}/__journal`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { entries?: unknown[] } | unknown[];
    const entries = Array.isArray(body) ? body : (body.entries ?? []);
    return entries as Array<{ op: string; payload: Row; result: Row }>;
  }

  function emittedBy(runId: string): string[] {
    return db.select().from(eventStore).where(eq(eventStore.sourceRunId, runId)).all().map((row) => row.name);
  }

  function taskTypes(): string[] {
    return db.select().from(tasksTable).where(eq(tasksTable.tenantId, tenantId)).all().map((row) => String(row.type));
  }

  async function reset(): Promise<void> {
    await fetch(`${erpBase}/__reset`, { method: "POST" });
    collectCalls = 0;
    deviationFound = true;
    deviationBlocked = false;
    alertLevel = "红色";
    chosenOption = "执行调拨";
  }

  /** The alert context raiseDeviationAlert emits, replayed from the journal for direct-entry tests. */
  async function raiseRedAlert(): Promise<Row> {
    await dispatchCascade("ON_TIME_PROBABILITY_SCORED", { subject: "alert-seed", ...scoreResult("红色") }, { only: ["raiseDeviationAlert"] });
    const pushed = (await journalOps()).find((entry) => entry.op === "pushAlert");
    expect(pushed, "pushAlert journal entry").toBeDefined();
    return pushed!.result.alert_context as Row;
  }

  beforeAll(async () => {
    erp = buildApp({
      dataDir: path.join(PACKAGE_DIR, "mock-erp"),
      transformMapsPath: path.join(PACKAGE_DIR, "transform-maps/transform-maps.json"),
      stateDir: mkdtempSync(path.join(tmpdir(), "hcf1-e2e-erp-")),
      logger: false,
    });
    await erp.app.listen({ port: 0, host: "127.0.0.1" });
    const address = erp.app.server.address();
    if (!address || typeof address === "string") throw new Error("mock-erp address unavailable");
    erpBase = `http://127.0.0.1:${address.port}`;
    process.env.METAERP_BASE_URL = erpBase;

    tenantId = makeId("ten");
    const workflowId = makeId("wf");
    db.insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "采购-HC-Formal 场景一 E2E" }).run();
    unsubscribeStream = subscribeStream(tenantId, (frame) => {
      const record = frame as unknown as Record<string, unknown>;
      if (record.error) streamErrors.push(`${String(record.type)} ${String(record.name ?? "")}: ${String(record.error)}`);
    });
    db.insert(workflows).values({ id: workflowId, tenantId, slug: "procurement-hc-formal", name: "采购链路执行偏差预警" }).run();

    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
    const manifestAgents: unknown[] = Array.isArray(raw) ? raw : ((raw as { agents?: unknown[] }).agents ?? []);
    expect(manifestAgents.length).toBe(29);
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
        .values({ id: agentDbId, workflowId, kebabId: agent.name, name: agent.name, actor: "Agent", kind: "manifest", enabled: true, createdAt: new Date(), updatedAt: new Date() })
        .run();
      const registered = registerAgent(agent, context) as unknown as { fn: (i: unknown) => Promise<unknown> } | null;
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
    unsubscribeStream?.();
    if (priorGateway) setRuntimeGateway(priorGateway);
    await erp.app.close();
  });

  it("registers all 15 场景一 agents against the real engine", () => {
    for (const name of SCENARIO_ONE) {
      expect(agentDbIds.has(name), name).toBe(true);
    }
    expect((registeredByTrigger.get("DAILY_DEVIATION_SCAN_SCHEDULED") ?? []).map((l) => l.name)).toEqual(["collectChainExecutionData"]);
    expect((registeredByTrigger.get("ADJUSTMENT_OPTION_APPROVED") ?? []).map((l) => l.name).sort()).toEqual(["adjustRequiredArrivalDate", "compressDownstreamCycle", "createStockTransferRequest"]);
  });

  it("runs the red-alert chain end to end: scan → deviation → score → alert → options → 领导拍板/计划员确认 → 执行调拨 → 到货 → 闭环", async () => {
    await reset();
    const delivered = await dispatchCascade("DAILY_DEVIATION_SCAN_SCHEDULED", {
      subject: "deviation-scan-red",
      scan_date: SCAN_DATE,
      scan_batch_id: "SCAN-2026-09-07-S1",
      chain_scope: "指定计划",
      plan_id: PLAN_ID,
      plan_no: PLAN_ID,
    });

    for (const expected of [
      "DAILY_DEVIATION_SCAN_SCHEDULED",
      "CHAIN_PROGRESS_SYNCED",
      "EXECUTION_DEVIATION_CALCULATED",
      "DEVIATION_DETECTED",
      "ON_TIME_PROBABILITY_SCORED",
      "DEVIATION_ALERT_RAISED",
      "ADJUSTMENT_OPTIONS_GENERATED",
      "ADJUSTMENT_OPTION_APPROVED",
      "STOCK_TRANSFER_REQUEST_CREATED",
      "STOCK_TRANSFER_FULFILLED",
      "DEVIATION_HANDLING_CLOSED",
    ]) {
      expect(delivered, `event ${expected} delivered`).toContain(expected);
    }
    for (const absent of ["NO_DEVIATION_CONFIRMED", "CHAIN_MONITORING_ARCHIVED", "BLUE_ALERT_SELF_HANDLED", "CHAIN_PLAN_SCHEDULE_COMPRESSED", "REQUIRED_ARRIVAL_DATE_ADJUSTED", "FALSE_ALARM_RECYCLED", "THRESHOLD_REVIEW_ITEM_CREATED"]) {
      expect(delivered, `event ${absent} absent`).not.toContain(absent);
    }
    // The collector really exercised the merged query tool (2 LLM turns).
    expect(collectCalls).toBe(2);

    // Every agent on the path completed ok — including the ones whose gates
    // legitimately skipped their work (a skipped branch is a finished run).
    for (const name of [
      "collectChainExecutionData",
      "calculateExecutionDeviation",
      "scoreOnTimeProbability",
      "raiseDeviationAlert",
      "handleBlueAlertLocally",
      "generateAdjustmentOptions",
      "approveAdjustmentOption",
      "compressDownstreamCycle",
      "adjustRequiredArrivalDate",
      "createStockTransferRequest",
      "trackTransferFulfillment",
      "closeDeviationHandling",
      "recycleFalseAlarm",
    ]) {
      const [latest] = runsFor(name);
      expect(latest, `run row for ${name}`).toBeDefined();
      expect(latest!.status, `status of ${name}`).toBe("ok");
    }
    // Gated-off branches wrote nothing and emitted nothing.
    const ops = (await journalOps()).map((entry) => entry.op);
    for (const written of ["pushAlert", "approveAdjustmentOption", "createTransactionOrder", "updateTransactionOrder", "writeEventLog"]) {
      expect(ops, `ERP op ${written}`).toContain(written);
    }
    for (const notWritten of ["closeBlueAlert", "changePbp", "changePbpLine", "createReviewItem"]) {
      expect(ops, `ERP op ${notWritten} absent`).not.toContain(notWritten);
    }
    for (const gated of ["handleBlueAlertLocally", "compressDownstreamCycle", "adjustRequiredArrivalDate", "recycleFalseAlarm"]) {
      expect(emittedBy(runsFor(gated)[0]!.id), `${gated} emitted nothing`).toEqual([]);
    }
    // HITL: 领导拍板 + 计划员确认 were created and resolved with the filled forms.
    const types = taskTypes();
    expect(types).toContain("adjustment.select");
    expect(types).toContain("adjustment.planner-confirm");
    for (const task of db.select().from(tasksTable).where(eq(tasksTable.tenantId, tenantId)).all()) {
      expect(["resolved", "resolving"]).toContain(task.status);
    }
    // The ERP saw the planner's confirmation (BR-OPT-05) and the chosen option.
    const approval = (await journalOps()).find((entry) => entry.op === "approveAdjustmentOption")!;
    expect(approval.result.decision_context).toMatchObject({ option_type: "执行调拨", planner_confirmed_by: "张计划", decided_by: "王分管" });
    const closure = (await journalOps()).find((entry) => entry.op === "writeEventLog")!;
    expect(closure.result.closure_context).toMatchObject({ chain_id: CHAIN_ID });
  });

  it("archives a chain with no deviation instead of alerting anyone", async () => {
    await reset();
    deviationFound = false;
    const delivered = await dispatchCascade("CHAIN_PROGRESS_SYNCED", { subject: "no-deviation", ...collectResult() });
    expect(delivered).toContain("NO_DEVIATION_CONFIRMED");
    expect(delivered).toContain("CHAIN_MONITORING_ARCHIVED");
    expect(delivered).not.toContain("DEVIATION_DETECTED");
    expect(runsFor("archiveDeviationMonitoring")[0]!.status).toBe("ok");
    expect((await journalOps()).map((entry) => entry.op)).not.toContain("pushAlert");
  });

  it("a deviation calculation blocked by BR-PLAN-01 FAILS its run with the reported reason and emits nothing (never archives as 'no deviation')", async () => {
    await reset();
    deviationBlocked = true;
    const listener = (registeredByTrigger.get("CHAIN_PROGRESS_SYNCED") ?? []).find((entry) => entry.name === "calculateExecutionDeviation")!;
    const sink: SentEvent[] = [];
    const before = new Set(runsFor("calculateExecutionDeviation").map((row) => row.id));
    try {
      await expect(listener.fn(invocation("CHAIN_PROGRESS_SYNCED", { subject: "blocked-calc", ...collectResult() }, sink))).rejects.toThrow(/deviation_calc_blocked|blocked_outcome/);
    } finally {
      deviationBlocked = false;
    }
    const run = runsFor("calculateExecutionDeviation").find((row) => !before.has(row.id))!;
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("BR-PLAN-01");
    expect(sink).toEqual([]);
    expect(emittedBy(run.id)).toEqual([]);
  });

  it("a blue alert is self-handled by the 计划员 (BR-ALERT-03) and generates no adjustment options (BR-OPT-01)", async () => {
    await reset();
    alertLevel = "蓝色";
    const delivered = await dispatchCascade("ON_TIME_PROBABILITY_SCORED", { subject: "blue-alert", ...scoreResult("蓝色") });
    expect(delivered).toContain("DEVIATION_ALERT_RAISED");
    expect(delivered).toContain("BLUE_ALERT_SELF_HANDLED");
    expect(delivered).not.toContain("ADJUSTMENT_OPTIONS_GENERATED");
    const ops = (await journalOps()).map((entry) => entry.op);
    expect(ops).toContain("pushAlert");
    expect(ops).toContain("closeBlueAlert");
    expect(ops).not.toContain("approveAdjustmentOption");
    const types = taskTypes();
    expect(types).toContain("blue-alert.review");
    expect(types).toContain("blue-alert.decide");
    expect(runsFor("generateAdjustmentOptions")[0]!.status).toBe("ok");
    expect(emittedBy(runsFor("generateAdjustmentOptions")[0]!.id)).toEqual([]);
  });

  it("压缩后续周期: only compressDownstreamCycle acts on the approved option and the deviation is closed", async () => {
    await reset();
    const alert = await raiseRedAlert();
    const delivered = await dispatchCascade("ADJUSTMENT_OPTION_APPROVED", {
      subject: "branch-compress",
      option_id: "OPT-1",
      option_type: "压缩后续周期",
      alert_id: alert.alert_id,
      chain_id: CHAIN_ID,
      decided_by: "王分管",
      planner_confirmed_by: "张计划",
      planned_dates: deviationResult(true).planned_dates,
      compressed_days: 12,
    });
    expect(delivered).toContain("CHAIN_PLAN_SCHEDULE_COMPRESSED");
    expect(delivered).toContain("DEVIATION_HANDLING_CLOSED");
    expect(delivered).not.toContain("REQUIRED_ARRIVAL_DATE_ADJUSTED");
    expect(delivered).not.toContain("STOCK_TRANSFER_REQUEST_CREATED");
    const ops = (await journalOps()).map((entry) => entry.op);
    expect(ops).toContain("changePbp");
    expect(ops).not.toContain("changePbpLine");
    expect(ops).not.toContain("createTransactionOrder");
    expect(ops).toContain("writeEventLog");
  });

  it("调整需求日期: only adjustRequiredArrivalDate acts on the approved option", async () => {
    await reset();
    const alert = await raiseRedAlert();
    // Exactly what the live chain carries: the decision context plus the
    // upstream options (the ERP derives the new date from the chosen option's
    // simulated arrival — no form in the ontology carries a date).
    const upstream = optionsResult({ alert_id: alert.alert_id, alert_level: "红色", notified_role: "分管领导" }, true);
    const delivered = await dispatchCascade("ADJUSTMENT_OPTION_APPROVED", {
      subject: "branch-adjust",
      ...upstream,
      option_id: "OPT-2",
      option_type: "调整需求日期",
      alert_id: alert.alert_id,
      chain_id: CHAIN_ID,
      plan_line_id: PLAN_LINE_ID,
      decided_by: "王分管",
      planner_confirmed_by: "张计划",
    });
    expect(delivered).toContain("REQUIRED_ARRIVAL_DATE_ADJUSTED");
    expect(delivered).toContain("DEVIATION_HANDLING_CLOSED");
    expect(delivered).not.toContain("CHAIN_PLAN_SCHEDULE_COMPRESSED");
    const ops = (await journalOps()).map((entry) => entry.op);
    expect(ops).toContain("changePbpLine");
    expect(ops).not.toContain("changePbp");
    expect(ops).not.toContain("createTransactionOrder");
    const change = (await journalOps()).find((entry) => entry.op === "changePbpLine")!;
    expect(change.result).toMatchObject({ applied: true, plan_line_id: PLAN_LINE_ID, required_arrival_date: "2026-12-20" });
  });

  it("BR-OPT-05: an approved option without the planner's confirmation reaches no ERP write on any branch", async () => {
    await reset();
    const alert = await raiseRedAlert();
    const delivered = await dispatchCascade("ADJUSTMENT_OPTION_APPROVED", {
      subject: "gate-opt-05",
      option_id: "OPT-3",
      option_type: "执行调拨",
      alert_id: alert.alert_id,
      chain_id: CHAIN_ID,
      decided_by: "王分管",
      transfer_source: { warehouse_id: "WH-HB-01", item_code: "M-CT-110", transfer_quantity: 20, transfer_lead_days: 7 },
    });
    expect(delivered).toEqual(["ADJUSTMENT_OPTION_APPROVED"]);
    for (const branch of ["compressDownstreamCycle", "adjustRequiredArrivalDate", "createStockTransferRequest"]) {
      expect(runsFor(branch)[0]!.status, branch).toBe("ok");
      expect(emittedBy(runsFor(branch)[0]!.id), `${branch} emitted nothing`).toEqual([]);
    }
    const ops = (await journalOps()).map((entry) => entry.op);
    for (const op of ["changePbp", "changePbpLine", "createTransactionOrder"]) expect(ops).not.toContain(op);
  });

  it("a false alarm (BR-FB-01) is classified by the 规则评审组 and becomes a threshold review item", async () => {
    await reset();
    const alert = await raiseRedAlert();
    const delivered = await dispatchCascade("DEVIATION_HANDLING_CLOSED", {
      subject: "false-alarm",
      alert_id: alert.alert_id,
      chain_id: CHAIN_ID,
      deviation_id: DEVIATION_ID,
      deviation_eliminated: false,
      verification_result: "误报",
      closed_at: `${SCAN_DATE}T03:00:00+08:00`,
    });
    expect(delivered).toContain("FALSE_ALARM_RECYCLED");
    expect(delivered).toContain("THRESHOLD_REVIEW_ITEM_CREATED");
    expect(taskTypes()).toContain("feedback.classify");
    const review = (await journalOps()).find((entry) => entry.op === "createReviewItem")!;
    expect(review.result.review_item).toMatchObject({ false_alarm_cause: "阈值过严", suggested_threshold_value: 5 });
  });

  it("overdue-alert escalation emits DEVIATION_ALERT_ESCALATED exactly when the ERP escalated something", async () => {
    await reset();
    const delivered = await dispatchCascade("ALERT_TIMEOUT_SCAN_SCHEDULED", { subject: "timeout-scan", scan_date: SCAN_DATE, scanned_at: `${SCAN_DATE}T04:00:00+08:00` }, { only: ["escalateOverdueAlert"] });
    const escalation = (await journalOps()).find((entry) => entry.op === "escalateAlert")!;
    expect(escalation, "escalateAlert journal entry").toBeDefined();
    expect(runsFor("escalateOverdueAlert")[0]!.status).toBe("ok");
    expect(delivered.includes("DEVIATION_ALERT_ESCALATED")).toBe(escalation.result.escalated === true);
  });
});
