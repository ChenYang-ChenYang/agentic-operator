/**
 * Golden compile of the immutable package procurement-hc-formal@0.1.8
 * (业务领域 采购-HC-Formal: 场景一 偏差三级预警 + 场景二 数字化员工) as staged
 * by scripts/stage-procurement-hc-formal-ontology.mjs, against the REAL
 * runtime manifest contract, plus a drift check against the committed
 * models/procurement-hc-formal-v1/ output.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkflowManifestSchema } from "@agentic/runtime/manifest";
import { evaluateCondition } from "@agentic/runtime";
import { canonicalJson } from "../src/canonical-json.ts";
import { compile, serializeCompileResult } from "../src/compile.ts";
import { loadStudioDomain } from "../src/load.ts";
import type { CompiledAgent, CompiledStep, CompilerOverlay } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..", "..");
const SOURCE = path.join(REPO_ROOT, "ontology-packages", "procurement-hc-formal", "package");
const OVERLAY = path.join(REPO_ROOT, "overlays", "procurement-hc-formal.json");
const MODELS = path.join(REPO_ROOT, "models", "procurement-hc-formal-v1");
const HC_MODELS = path.join(REPO_ROOT, "models", "hc-procurement-v1");

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
const SCENARIO_TWO = [
  "scanApprovedDemandPlan",
  "analyzeDemandMerge",
  "splitOversizedDemand",
  "verifyInventoryAvailability",
  "createInventoryTransferOrder",
  "derivePurchaseSchedule",
  "generateExecutionPlanDraft",
  "auditAnnualPlanCompliance",
  "returnPlanForRectification",
  "recommendPackagingScheme",
  "annotateFrameAndCentralPurchase",
  "raisePackagingComplianceAlert",
  "confirmPlanAndPackage",
  "submitPlanForApproval",
];

function compileDomain() {
  const model = loadStudioDomain(SOURCE);
  const overlay = JSON.parse(readFileSync(OVERLAY, "utf8")) as CompilerOverlay;
  return compile(model, overlay, { tenant: "procurement-hc-formal" });
}

function agentById(workflow: CompiledAgent[], id: string): CompiledAgent {
  const agent = workflow.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`missing agent ${id}`);
  return agent;
}

function stepNames(agent: CompiledAgent): string[] {
  return agent.actions.map((step) => step.name);
}

function step(agent: CompiledAgent, name: string): CompiledStep {
  const found = agent.actions.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${agent.id}: missing step ${name}`);
  return found;
}

describe("ontology-compiler golden compile (procurement-hc-formal@0.1.8)", () => {
  const result = compileDomain();

  it("emits one AgentSpec per ontology action (15 场景一 + 14 场景二 = 29)", () => {
    expect(result.workflow).toHaveLength(29);
    const ids = result.workflow.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(29);
    for (const id of [...SCENARIO_ONE, ...SCENARIO_TWO]) expect(ids).toContain(id);
    for (const agent of result.workflow) {
      expect(agent.name).toBe(agent.id);
      expect(agent.retries).toBe(3);
      expect(agent.generated).toBe(true);
    }
  });

  it("every emitted AgentSpec parses through the real WorkflowManifestSchema", () => {
    const raw = JSON.parse(canonicalJson(result.workflow));
    const parsed = WorkflowManifestSchema.parse(raw);
    expect(parsed).toHaveLength(29);
  });

  it("keeps the 场景一 deviation chain structurally identical to hc-procurement-v1", () => {
    const hcPath = path.join(HC_MODELS, "workflow_v1.json");
    if (!existsSync(hcPath)) return;
    const hc = JSON.parse(readFileSync(hcPath, "utf8")) as CompiledAgent[];
    // HC-Formal additionally compiles honest blocking outcomes (overlay
    // `blocking_outcomes`: condition + control.fail) into its analysis
    // agents; hc-procurement-v1 predates them. Everything else must match.
    const withoutBlocking = (agent: CompiledAgent): string[] =>
      stepNames(agent).filter(
        (name) => !name.startsWith("blocked-when:") && name !== "control.fail",
      );
    for (const id of SCENARIO_ONE) {
      const mine = agentById(result.workflow, id);
      const theirs = agentById(hc, id);
      expect(withoutBlocking(mine), id).toEqual(withoutBlocking(theirs));
      expect(mine.trigger, id).toEqual(theirs.trigger);
      expect(mine.triggered_event, id).toEqual(theirs.triggered_event);
      const erpBindings = (agent: CompiledAgent): string[] =>
        agent.tool_use
          .filter((entry) => entry.name === "metaerp.invoke")
          .map((entry) => entry.config.operation ?? "(merged)");
      expect(erpBindings(mine), id).toEqual(erpBindings(theirs));
    }
    // The only intended difference: every metaerp.invoke points at THIS
    // tenant's catalog, never at hc-procurement's.
    for (const agent of result.workflow) {
      for (const entry of agent.tool_use) {
        if (entry.name === "metaerp.invoke") {
          expect(entry.config.catalog_path).toBe("models/procurement-hc-formal-v1/erp-operations.json");
        }
      }
    }
  });

  it("wires 场景二 triggers: daily scan / approval / submission entry points", () => {
    expect(agentById(result.workflow, "scanApprovedDemandPlan").trigger).toEqual([
      "DAILY_DEMAND_PLAN_SCAN_SCHEDULED",
      "DEMAND_PLAN_APPROVED",
    ]);
    expect(agentById(result.workflow, "auditAnnualPlanCompliance").trigger).toEqual([
      "EXECUTION_PLAN_DRAFT_GENERATED",
      "DEMAND_PLAN_SUBMITTED_FOR_APPROVAL",
      "PLAN_RECTIFICATION_SUBMITTED",
    ]);
    expect(agentById(result.workflow, "recommendPackagingScheme").trigger).toEqual([
      "ANNUAL_PLAN_AUDITED",
      "PACKAGING_ALERT_RAISED",
      "PLAN_AND_PACKAGE_REJECTED",
    ]);
    // The scan agent's input ports come from the trigger payloads, so the run
    // console asks for the scan_date every downstream date is anchored on.
    const scanInputs = agentById(result.workflow, "scanApprovedDemandPlan").inputs;
    expect(scanInputs.find((port) => port.id === "scan_date")?.required).toBe(true);
    expect(scanInputs.map((port) => port.id)).toContain("plan_id");
  });

  it("compiles the read-only analysis agents with query* tools only (compiler drops non-query op ids)", () => {
    const verify = agentById(result.workflow, "verifyInventoryAvailability");
    expect(verify.tool_use).toHaveLength(1);
    const enumOps = (verify.tool_use[0]!.input_schema as { properties: { operation: { enum: string[] } } })
      .properties.operation.enum;
    expect(enumOps).toEqual(["queryOnhandQuantity", "queryReservation", "queryItemMinMaxLevel"]);
    expect(stepNames(verify)).toEqual([
      "analyze",
      "emit:INVENTORY_AVAILABILITY_VERIFIED",
      "emit-when:STOCK_SUFFICIENT_FOR_DEMAND",
      "emit:STOCK_SUFFICIENT_FOR_DEMAND",
      "emit-when:PURCHASE_REQUIRED_CONFIRMED",
      "emit:PURCHASE_REQUIRED_CONFIRMED",
      "suppress-implicit-emit",
    ]);
    expect(step(verify, "emit:STOCK_SUFFICIENT_FOR_DEMAND").emit_payload_from).toBe(
      "results.verifyInventoryAvailability.transfer_context",
    );

    const audit = agentById(result.workflow, "auditAnnualPlanCompliance");
    const auditOps = (audit.tool_use[0]!.input_schema as { properties: { operation: { enum: string[] } } })
      .properties.operation.enum;
    expect(auditOps).toEqual(["queryAuditThresholdConfig", "queryCentralCatalogConfig", "queryPoLine", "queryContract"]);
    expect(step(audit, "emit-when:PLAN_AUDIT_INTERCEPTED").condition).toBe("lastResult.intercept == true");

    // Pure-reasoning actions (typescript modules this repo does not ship) carry no ERP tool at all.
    expect(agentById(result.workflow, "analyzeDemandMerge").tool_use).toEqual([]);
    expect(step(agentById(result.workflow, "analyzeDemandMerge"), "emit:DEMAND_SPLIT_REQUIRED").emit_payload_from).toBe(
      "results.analyzeDemandMerge.split_request",
    );
  });

  it("gates the transfer branch on BR2-STOCK-01 as a deterministic condition before the ERP write", () => {
    const transfer = agentById(result.workflow, "createInventoryTransferOrder");
    expect(stepNames(transfer)).toEqual([
      "rule-gate:BR2-STOCK-01",
      "metaerp.invoke",
      "emit-when:INVENTORY_TRANSFER_ORDER_CREATED",
      "emit:INVENTORY_TRANSFER_ORDER_CREATED",
      "suppress-implicit-emit",
    ]);
    const gate = step(transfer, "rule-gate:BR2-STOCK-01");
    expect(gate.type).toBe("condition");
    expect(gate.condition).toBe("input.stock_check_flag == '可调度' && input.is_urgent_demand == false");
    const write = step(transfer, "metaerp.invoke");
    expect(write.depends_on).toEqual(["rule-gate-BR2-STOCK-01"]);
    expect(transfer.tool_use[0]!.config.operation).toBe("createTransactionOrder");
    expect(transfer.tool_use[0]!.side_effect).toBe("write");
  });

  it("demotes the two preconditions that would deadlock their own action (recorded as studio_phase)", () => {
    // splitOversizedDemand collects the BR2-HITL-01 confirmation itself.
    const split = agentById(result.workflow, "splitOversizedDemand");
    expect(stepNames(split).filter((name) => name.startsWith("rule-gate:"))).toEqual([]);
    expect(stepNames(split)).toEqual([
      "confirmSplitByPlanner",
      "metaerp.invoke",
      "emit-when:DEMAND_SPLIT_CONFIRMED",
      "emit:DEMAND_SPLIT_CONFIRMED",
      "suppress-implicit-emit",
    ]);
    const confirm = step(split, "confirmSplitByPlanner");
    expect(confirm.type).toBe("manual");
    expect(confirm.result_key).toBe("manual-3");
    expect(confirm.task_type).toBe("demand.split-confirm");
    expect(confirm.awaiting_role).toBe("采购计划员");
    expect(split.tool_use[0]!.config.operation).toBe("splitDemandLine");
    expect(step(split, "metaerp.invoke").tool_arguments).toEqual({ payload: { from: "results.manual-3" } });

    // generateExecutionPlanDraft writes the BR2-MERGE-04 source mapping itself.
    const draft = agentById(result.workflow, "generateExecutionPlanDraft");
    expect(stepNames(draft)).toEqual([
      "metaerp.invoke",
      "emit-when:EXECUTION_PLAN_DRAFT_GENERATED",
      "emit:EXECUTION_PLAN_DRAFT_GENERATED",
      "suppress-implicit-emit",
    ]);
    expect(draft.tool_use[0]!.config.operation).toBe("createPbp");

    const actions = result.actions as Array<{ id: string; rule_bindings: Array<Record<string, unknown>> }>;
    const splitBinding = actions
      .find((action) => action.id === "splitOversizedDemand")!
      .rule_bindings.find((binding) => binding.rule_id === "BR2-HITL-01")!;
    expect(splitBinding.phase).toBe("approval");
    expect(splitBinding.studio_phase).toBe("precondition");
    const draftBinding = actions
      .find((action) => action.id === "generateExecutionPlanDraft")!
      .rule_bindings.find((binding) => binding.rule_id === "BR2-MERGE-04")!;
    expect(draftBinding.phase).toBe("postcondition");
    expect(draftBinding.studio_phase).toBe("precondition");
  });

  it("keeps BR2-HITL-01 as a real gate where the confirmation arrives from upstream (submitPlanForApproval)", () => {
    const submit = agentById(result.workflow, "submitPlanForApproval");
    expect(stepNames(submit)).toEqual([
      "rule-gate:BR2-HITL-01",
      "metaerp.invoke",
      "emit:PLAN_SUBMITTED_FOR_APPROVAL",
      "suppress-implicit-emit",
    ]);
    expect(step(submit, "rule-gate:BR2-HITL-01").condition).toBe("input.selected_by && input.package_scheme_id");
    expect(step(submit, "emit:PLAN_SUBMITTED_FOR_APPROVAL").depends_on).toEqual(["submitPlanForApproval"]);
    expect(submit.tool_use[0]!.config.operation).toBe("submitApproval");
  });

  it("folds the planner decision into ONE manual step and branches confirm/reject on the form decision", () => {
    const confirm = agentById(result.workflow, "confirmPlanAndPackage");
    const manuals = confirm.actions.filter((entry) => entry.type === "manual");
    expect(manuals.map((entry) => entry.name)).toEqual(["confirmByPlanner"]);
    expect(manuals[0]!.result_key).toBe("manual-2");
    expect(manuals[0]!.task_type).toBe("plan.package-confirm");
    const form = manuals[0]!.form_schema as { required: string[]; properties: Record<string, unknown> };
    expect(form.required).toEqual(["decision", "selected_by", "package_scheme_id", "plan_id"]);
    expect(Object.keys(form.properties)).toContain("rejection_reason");
    expect(step(confirm, "emit-when:PLAN_AND_PACKAGE_CONFIRMED").condition).toBe("results.manual-2.decision == 'approved'");
    expect(step(confirm, "emit-when:PLAN_AND_PACKAGE_REJECTED").condition).toBe("results.manual-2.decision == 'rejected'");
    expect(step(confirm, "emit:PLAN_AND_PACKAGE_CONFIRMED").emit_payload_from).toBe("lastResult.confirm_context");
    expect(confirm.tool_use[0]!.config.operation).toBe("writeOperationLog");
    expect(step(confirm, "metaerp.invoke").tool_arguments).toEqual({ payload: { from: "results.manual-2" } });
  });

  it("routes the intercept branch through a human rectification step and back to audit", () => {
    const back = agentById(result.workflow, "returnPlanForRectification");
    const manual = step(back, "acceptRectification");
    expect(manual.type).toBe("manual");
    expect(manual.result_key).toBe("manual-4");
    expect(manual.awaiting_role).toBe("需求申请人/需求部门");
    expect(back.tool_use[0]!.config.operation).toBe("pushTask");
    expect(step(back, "emit:PLAN_RETURNED_FOR_RECTIFICATION").emit_payload_from).toBe("lastResult.return_context");
    expect(step(back, "emit-when:PLAN_RECTIFICATION_SUBMITTED").condition).toBe("results.manual-4.decision == 'approved'");
    expect(back.triggered_event).toEqual(["PLAN_RETURNED_FOR_RECTIFICATION", "PLAN_RECTIFICATION_SUBMITTED"]);
  });

  it("builds the ERP operation catalog for both scenarios (63 ops = 47 reads + 16 writes; createTransactionOrder shared once)", () => {
    expect(result.erpOperations).toHaveLength(63);
    const byId = new Map(result.erpOperations.map((op) => [op.operation_id, op]));
    expect(byId.get("createTransactionOrder")).toMatchObject({ kind: "write", entity: "inv_transaction_order_t" });
    expect(byId.get("createPbp")).toMatchObject({ kind: "write", entity: "ss_pbp_header_t" });
    expect(byId.get("createProcPackageLines")).toMatchObject({ kind: "write", entity: "ss_proc_package_header_t" });
    expect(byId.get("pushTask")).toMatchObject({ kind: "write", entity: "de_digital_employee_task_t" });
    expect(byId.get("writeOperationLog")).toMatchObject({ kind: "write", entity: "de_package_scheme_t" });
    expect(byId.get("submitApproval")).toMatchObject({ kind: "write", entity: "ss_pbp_header_t" });
    expect(byId.get("splitDemandLine")).toMatchObject({ kind: "write", entity: "de_demand_merge_suggestion_t" });
    expect(byId.get("queryOnhandQuantity")).toMatchObject({ kind: "query", entity: "inv_onhand_quantity_t" });
    expect(byId.get("querySpaList")).toMatchObject({ kind: "query", entity: "ss_spa_header_t" });
    expect(byId.get("queryCentralCatalogConfig")).toMatchObject({ kind: "query", entity: "cfg_central_purchase_catalog_t" });
    expect(byId.get("queryPbpHeader")).toMatchObject({ kind: "query", entity: "ss_pbp_header_t" });
    expect(byId.get("queryOpenPbpHeader")).toMatchObject({ kind: "query", entity: "ss_pbp_header_t" });
    const writes = result.erpOperations.filter((op) => op.kind === "write").map((op) => op.operation_id);
    expect(writes).toHaveLength(16);
    expect(result.erpOperations.filter((op) => op.kind === "query")).toHaveLength(47);
  });

  it("passes the archive families through with the staging provenance intact", () => {
    const actions = result.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(29);
    for (const action of actions) {
      const implementation = action.implementation as { kind: string; executable: boolean };
      expect(["prompt", "external"]).toContain(implementation.kind);
      expect(implementation.executable).toBe(true);
      expect(action.studio_implementation).toBeTruthy();
    }
    const events = result.events as { metadata?: Record<string, unknown>; events: unknown[] };
    expect(events.events).toHaveLength(46);
    expect(events.metadata).toMatchObject({ package_id: "procurement-hc-formal", release: "0.1.8", family: "events" });
    expect((result.objects as { payload: unknown[] }).payload).toHaveLength(39);
    expect((result.rules as { payload: unknown[] }).payload).toHaveLength(58);
  });

  it("names every agent in Chinese by default and carries the English title for the portal language toggle", () => {
    for (const agent of result.workflow) {
      expect(agent.title_i18n, agent.id).toBeDefined();
      expect(agent.title_i18n!.zh, agent.id).toBeTruthy();
      expect(agent.title_i18n!.en, agent.id).toBeTruthy();
      expect(agent.title, agent.id).toBe(agent.title_i18n!.zh);
      expect(agent.title, agent.id).not.toBe(agent.id);
    }
    const verify = agentById(result.workflow, "verifyInventoryAvailability");
    expect(verify.title).toBe("库存校验");
    expect(verify.title_i18n).toEqual({ en: "Verify Inventory Availability", zh: "库存校验" });
    // The titles come from the package's own workflow step names.
    expect(agentById(result.workflow, "confirmPlanAndPackage").title).toBe("计划员确认计划与组包方案");
  });

  it("refuses overlay titles that name an action the package does not declare", () => {
    const model = loadStudioDomain(SOURCE);
    expect(() =>
      compile(model, { titles: { notAnAction: { zh: "幽灵" } } }, { tenant: "procurement-hc-formal" }),
    ).toThrow(/overlay titles references unknown action notAnAction/);
    expect(() =>
      compile(model, { titles: { scanApprovedDemandPlan: { "not a locale": "x" } } }, { tenant: "procurement-hc-formal" }),
    ).toThrow(/invalid locale/);
  });

  it("puts the reviewed failure ladder on every Meta ERP write step: 4xx terminal, unreachable/5xx retry", () => {
    const writeSteps = result.workflow.flatMap((agent) =>
      agent.actions.filter((step) => step.type === "tool" && step.name === "metaerp.invoke"),
    );
    expect(writeSteps.length).toBeGreaterThan(0);
    for (const step of writeSteps) {
      expect(step.on_error, step.description).toEqual([
        { when: "kind == integration_unreachable || code == integration_unreachable", do: "retry" },
        { when: "status >= 400 && status < 500", do: "terminal" },
        { default: "retry" },
      ]);
    }
    // Same-tenant guard against the 2026-09-07 defect: the createPbp step
    // that was retried 4× on a deterministic HTTP 400 now carries the ladder.
    expect(step(agentById(result.workflow, "generateExecutionPlanDraft"), "metaerp.invoke").on_error).toHaveLength(3);
  });

  it("compiles blocking outcomes into condition → control.fail (terminal) BEFORE the success emissions", () => {
    const derive = agentById(result.workflow, "derivePurchaseSchedule");
    expect(stepNames(derive)).toEqual([
      "analyze",
      "blocked-when:schedule_blocked",
      "control.fail",
      "emit:PURCHASE_SCHEDULE_DERIVED",
      "emit-when:SCHEDULE_TIME_CONFLICT_DETECTED",
      "emit:SCHEDULE_TIME_CONFLICT_DETECTED",
      "suppress-implicit-emit",
    ]);
    const gate = step(derive, "blocked-when:schedule_blocked");
    expect(gate).toMatchObject({ type: "condition", result_key: "blocked-when-schedule_blocked" });
    const stop = step(derive, "control.fail");
    expect(stop).toMatchObject({
      type: "tool",
      on_error: "terminal",
      allowed_tools: ["control.fail"],
      depends_on: ["blocked-when-schedule_blocked"],
      tool_arguments: {
        code: { const: "schedule_blocked" },
        message: { from: "lastResult.blocking_note", required: false },
      },
    });
    // The tool is allow-listed with the registry's reviewed pure policy.
    expect(derive.tool_use.find((entry) => entry.name === "control.fail")).toMatchObject({
      side_effect: "read",
      execution_policy: { operation: "compute", effect_scope: "none", sandbox_policy: "pure" },
    });
    // The deviation calculator gets the same treatment (BR-PLAN-01 missing
    // cycle config must not archive as "no deviation").
    expect(stepNames(agentById(result.workflow, "calculateExecutionDeviation"))).toContain(
      "blocked-when:deviation_calc_blocked",
    );
    // Agents without declared blocking outcomes are untouched.
    expect(agentById(result.workflow, "scanApprovedDemandPlan").tool_use.some((e) => e.name === "control.fail")).toBe(false);
  });

  it("blocking conditions fire on the exact JSON the model reported in the failed live run, and stay quiet on a derived schedule", () => {
    const when = step(agentById(result.workflow, "derivePurchaseSchedule"), "blocked-when:schedule_blocked").condition!;
    const event = { name: "PURCHASE_REQUIRED_CONFIRMED", data: {} };
    // 2026-09-07 16:07 live run: blocked, emitted PURCHASE_SCHEDULE_DERIVED anyway, downstream createPbp → HTTP 400.
    expect(
      evaluateCondition(when, {
        lastResult: { blocking_note: "无法获取业务类型【物资】的阶段周期配置，根据BR-PLAN-01不予推算。", stage_count: 0, draft_request: null },
        event,
      }),
    ).toBe(true);
    // Any single structural signal is enough.
    expect(evaluateCondition(when, { lastResult: { blocking_note: "", stage_count: 7, draft_request: null }, event })).toBe(true);
    expect(evaluateCondition(when, { lastResult: { blocking_note: "", stage_count: 0, draft_request: { lines: [{}] } }, event })).toBe(true);
    // The healthy 16:15 run: seven stages, a draft request, no note.
    expect(
      evaluateCondition(when, { lastResult: { blocking_note: "", stage_count: 7, draft_request: { lines: [{}] } }, event }),
    ).toBe(false);
    const deviation = step(agentById(result.workflow, "calculateExecutionDeviation"), "blocked-when:deviation_calc_blocked").condition!;
    expect(evaluateCondition(deviation, { lastResult: { blocking_note: "缺 物资×询价 周期配置", deviation_found: false }, event })).toBe(true);
    expect(evaluateCondition(deviation, { lastResult: { blocking_note: "", deviation_found: true }, event })).toBe(false);
  });

  it("refuses blocking outcomes that could not fire the way they read", () => {
    const model = loadStudioDomain(SOURCE);
    const overlay = JSON.parse(readFileSync(OVERLAY, "utf8")) as CompilerOverlay;
    const withBlocking = (blocking: CompilerOverlay["blocking_outcomes"]) =>
      compile(model, { ...overlay, blocking_outcomes: blocking }, { tenant: "procurement-hc-formal" });
    expect(() => withBlocking({ noSuchAction: [{ when: "lastResult.x", code: "x", message: "m" }] })).toThrow(/unknown action noSuchAction/);
    expect(() => withBlocking({ generateExecutionPlanDraft: [{ when: "lastResult.x", code: "x", message: "m" }] })).toThrow(/external action/);
    expect(() => withBlocking({ derivePurchaseSchedule: [{ when: "lastResult.x", code: "Bad Code", message: "m" }] })).toThrow(/invalid code/);
    expect(() => withBlocking({ derivePurchaseSchedule: [{ when: "lastResult.x", code: "x" }] })).toThrow(/exactly one of message_from \/ message/);
    expect(() => withBlocking({ derivePurchaseSchedule: [{ when: "lastResult.x", code: "x", message_from: "event.data.note" }] })).toThrow(/must read the analysis result/);
    expect(() =>
      withBlocking({ derivePurchaseSchedule: [{ when: "lastResult.x", code: "x", message: "m" }, { when: "lastResult.y", code: "x", message: "m" }] }),
    ).toThrow(/repeats code/);
  });

  it("matches the committed models/procurement-hc-formal-v1/ output byte for byte (run `pnpm hcf:compile` after editing the overlay or stage tables)", () => {
    for (const [fileName, value] of serializeCompileResult(result)) {
      const target = path.join(MODELS, fileName);
      expect(existsSync(target), `${fileName} committed`).toBe(true);
      expect(readFileSync(target, "utf8"), fileName).toBe(canonicalJson(value));
    }
  });
});
