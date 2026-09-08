/**
 * 采购-HC-Formal · 场景二「数字化员工的智能作业实践」end-to-end cascade.
 *
 * Drives the REAL engine (registerAgent + step-engine) over the ontology-
 * compiled manifest (models/procurement-hc-formal-v1/workflow_v1.json, from the
 * immutable package procurement-hc-formal@0.1.8) with:
 *   - the real in-process mock Meta ERP (@agentic/mock-erp) loaded with the
 *     checked-in 采购-HC-Formal data plane, on an ephemeral port,
 *   - a scripted fake LLM gateway keyed by request.purpose (the analysis
 *     agents' JSON contracts, plus one real metaerp.invoke tool round),
 *   - a fake Inngest step whose waitForEvent fills the human forms the way
 *     the resolve API would (计划员确认 / 申请人整改 / 拆分确认),
 *   - a breadth-first cascade driver that redelivers emitted events to the
 *     manifest subscribers, mirroring Inngest name-based fan-out.
 *
 * Chain under test (the worked example staged in the package):
 *   DAILY_DEMAND_PLAN_SCAN_SCHEDULED
 *     → scanApprovedDemandPlan            (logic + metaerp query tool loop)
 *     → APPROVED_DEMAND_PLAN_SCANNED → analyzeDemandMerge
 *     → DEMAND_MERGE_ANALYZED → verifyInventoryAvailability
 *        ├ STOCK_SUFFICIENT_FOR_DEMAND → createInventoryTransferOrder (BR2-STOCK-01 gate → ERP write)
 *        └ PURCHASE_REQUIRED_CONFIRMED → derivePurchaseSchedule
 *           → PURCHASE_SCHEDULE_DERIVED → generateExecutionPlanDraft (createPbp, BR2-MERGE-04 at the write)
 *           → EXECUTION_PLAN_DRAFT_GENERATED → auditAnnualPlanCompliance
 *           → ANNUAL_PLAN_AUDITED → recommendPackagingScheme
 *           → PACKAGING_SCHEME_RECOMMENDED → annotateFrameAndCentralPurchase (createProcPackageLines)
 *           → FRAME_AND_CENTRAL_ANNOTATED → confirmPlanAndPackage (计划员 HITL → writeOperationLog)
 *           → PLAN_AND_PACKAGE_CONFIRMED → submitPlanForApproval (BR2-HITL-01 gate → submitApproval)
 *           → PLAN_SUBMITTED_FOR_APPROVAL
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { StepError } from "inngest";
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
const tenantSlug = `hcf-e2e-${suffix}`;

const SCAN_DATE = "2026-09-07";
const PLAN_ID = "PBP-2026-1102";
const UNIT = "华东检修分公司";

interface SentEvent {
  name: string;
  data: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry === name) return full;
  }
  return null;
}

// ── scripted analysis outputs (each satisfies its overlay output contract) ───

const LINES: Row[] = [
  { plan_line_id: "PBPL-2026-1102-01", plan_line_no: "1", material_code: "M-CT-110", material_name: "110kV 电流互感器", line_type_code: "物资", category_id: "CAT-EL-CT", quantity: 20, unit: "台", unit_price: 58000, required_arrival_date: "2027-03-10", demand_department: "检修一部", inventory_organization: "ORG-HD", receiving_region: "华东", attachment_complete: true },
  { plan_line_id: "PBPL-2026-1102-02", plan_line_no: "2", material_code: "M-CT-110", material_name: "110kV 电流互感器", line_type_code: "物资", category_id: "CAT-EL-CT", quantity: 10, unit: "台", unit_price: 59500, required_arrival_date: "2027-03-25", demand_department: "检修三部", inventory_organization: "ORG-HD", receiving_region: "华东", attachment_complete: true },
  { plan_line_id: "PBPL-2026-1102-03", plan_line_no: "3", material_code: "M-BRK-126", material_name: "126kV SF6 断路器", line_type_code: "物资", category_id: "CAT-EL-BRK", quantity: 4, unit: "台", unit_price: 385000, required_arrival_date: "2027-05-30", demand_department: "检修一部", inventory_organization: "ORG-HD", receiving_region: "华东", attachment_complete: false },
  { plan_line_id: "PBPL-2026-1102-04", plan_line_no: "4", material_code: "M-CBL-YJV", material_name: "YJV22 10kV 电力电缆 3×240", line_type_code: "物资", category_id: "CAT-EL-CBL", quantity: 3000, unit: "m", unit_price: 320, required_arrival_date: "2027-01-15", demand_department: "检修二部", inventory_organization: "ORG-HD", receiving_region: "华东", attachment_complete: true },
].map((line) => ({ plan_id: PLAN_ID, plan_no: PLAN_ID, management_unit: UNIT, is_urgent: false, is_cancelled: false, is_deleted: false, central_purchase_level: "未标识", ...line }));

const log = (operation_type: string, extra: Row = {}): Row => ({
  operation_type,
  operator_role: "采购数字员工",
  occurred_at: `${SCAN_DATE}T01:00:00+08:00`,
  auditable: true,
  ...extra,
});

function scanResult(): Row {
  return {
    scan_date: SCAN_DATE,
    scan_batch_id: "SCAN-2026-09-07-01",
    plan_id: PLAN_ID,
    in_scope_line_count: 4,
    filtered_line_count: 1,
    procurement_plan: [{ plan_id: PLAN_ID, plan_no: PLAN_ID, plan_category: "需求计划", plan_status: "已批准", business_type: "物资", plan_type: "年度计划", management_unit: UNIT, unit_code: "001", plan_period: "2027", planner: "张计划", approved_at: "2026-09-05T16:00:00+08:00" }],
    scan_scope: LINES,
    operation_log: log("需求扫描", { api_called: ["queryPbpHeader", "queryPbpLine"] }),
    _parallel_tool_calls: "已在同一轮并发发出 queryPbpHeader 与 queryPbpLine",
  };
}

const MS_CT = "MS-2026-09-07-1";
const MS_BRK = "MS-2026-09-07-2";
const MS_CBL = "MS-2026-09-07-3";

function mergeResult(): Row {
  const group = (id: string, groupNo: string, lines: Row[], type: string, gap: number, score: number, reason: string) => ({
    merge_suggestion_id: id,
    merge_group_id: `MG-2026-09-07-${groupNo}`,
    merge_key: `${lines[0]!.material_code}|物资`,
    material_code: lines[0]!.material_code,
    material_name: lines[0]!.material_name,
    line_type_code: "物资",
    category_id: lines[0]!.category_id,
    business_type: "物资",
    management_unit: UNIT,
    inventory_organization: "ORG-HD",
    receiving_region: "华东",
    suggestion_type: type,
    max_date_gap_days: gap,
    merge_score: score,
    merge_reason: reason,
    merged_quantity: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
    weighted_unit_price: lines.length > 1 ? 58500 : Number(lines[0]!.unit_price),
    merged_amount: lines.length > 1 ? 1755000 : Number(lines[0]!.quantity) * Number(lines[0]!.unit_price),
    merged_required_date: lines[0]!.required_arrival_date,
    source_plan_line_ids: lines.map((line) => line.plan_line_id),
    source_plan_header_id: PLAN_ID,
    source_plan_no: PLAN_ID,
    is_urgent_demand: false,
    unit: lines[0]!.unit,
    plan_lines: lines,
  });
  const suggestions = [
    group(MS_CT, "1", [LINES[0]!, LINES[1]!], "可合并", 15, 96, "同物料同类型，需求日期差 15 天 ≤ 30 天（BR2-MERGE-01）"),
    group(MS_BRK, "2", [LINES[2]!], "单行", 0, 100, "组内仅一行"),
    group(MS_CBL, "3", [LINES[3]!], "单行", 0, 100, "组内仅一行"),
  ];
  return {
    scan_date: SCAN_DATE,
    scan_batch_id: "SCAN-2026-09-07-01",
    merge_suggestions: suggestions,
    merge_ready: true,
    split_required: false,
    split_request: null,
    stock_check_requests: suggestions.map((s) => ({
      merge_suggestion_id: s.merge_suggestion_id,
      plan_line_id: s.source_plan_line_ids[0],
      material_code: s.material_code,
      inventory_organization: "ORG-HD",
      management_unit: UNIT,
      demand_quantity: s.merged_quantity,
      required_arrival_date: s.merged_required_date,
      is_urgent_demand: false,
      business_type: "物资",
      category_id: s.category_id,
      unit_price: s.weighted_unit_price,
      unit: s.unit,
      source_plan_line_ids: s.source_plan_line_ids,
    })),
    operation_log: log("需求合并分析", { rule_hit: ["BR2-MERGE-01"] }),
  };
}

const SC_CT = "SC-2026-09-07-1";
const SC_CBL = "SC-2026-09-07-2";

function verifyResult(): Row {
  const ct = { stock_check_id: SC_CT, plan_line_id: "PBPL-2026-1102-01", merge_suggestion_id: MS_CT, material_code: "M-CT-110", inventory_organization: "ORG-HD", demand_quantity: 30, onhand_total_quantity: 6, reserved_total_quantity: 2, available_quantity: 4, max_stock_quantity: 40, safety_stock_quantity: 4, safety_stock_breached: true, is_urgent_demand: false, stock_check_flag: "需采购", shortage_quantity: 26, suggested_purchase_quantity: 30, checked_at: `${SCAN_DATE}T01:05:00+08:00` };
  const cbl = { stock_check_id: SC_CBL, plan_line_id: "PBPL-2026-1102-04", merge_suggestion_id: MS_CBL, material_code: "M-CBL-YJV", inventory_organization: "ORG-HD", demand_quantity: 3000, onhand_total_quantity: 5000, reserved_total_quantity: 500, available_quantity: 4500, max_stock_quantity: 4000, safety_stock_quantity: 800, safety_stock_breached: false, is_urgent_demand: false, stock_check_flag: "可调度", shortage_quantity: 0, suggested_purchase_quantity: 0, checked_at: `${SCAN_DATE}T01:05:00+08:00` };
  const brk = { stock_check_id: "SC-2026-09-07-3", plan_line_id: "PBPL-2026-1102-03", merge_suggestion_id: MS_BRK, material_code: "M-BRK-126", inventory_organization: "ORG-HD", demand_quantity: 4, onhand_total_quantity: 0, reserved_total_quantity: 0, available_quantity: 0, max_stock_quantity: 6, safety_stock_quantity: 1, safety_stock_breached: true, is_urgent_demand: false, stock_check_flag: "需采购", shortage_quantity: 4, suggested_purchase_quantity: 5, checked_at: `${SCAN_DATE}T01:05:00+08:00` };
  return {
    scan_date: SCAN_DATE,
    merge_suggestions: (mergeResult().merge_suggestions as Row[]),
    stock_check_results: [ct, cbl, brk],
    transfer_required: true,
    transfer_context: {
      stock_check_id: SC_CBL,
      plan_line_id: "PBPL-2026-1102-04",
      merge_suggestion_id: MS_CBL,
      material_code: "M-CBL-YJV",
      material_name: "YJV22 10kV 电力电缆 3×240",
      inventory_organization: "ORG-HD",
      onhand_total_quantity: 5000,
      max_stock_quantity: 4000,
      demand_quantity: 3000,
      transfer_quantity: 3000,
      is_urgent_demand: false,
      stock_check_flag: "可调度",
      source_warehouse: "WH-HD-02",
      target_warehouse: "需求单位库",
      required_date: "2027-01-15",
      transfer_reason: "库存可调度",
      scan_date: SCAN_DATE,
    },
    purchase_required: true,
    stock_check_id: SC_CT,
    plan_line_id: "PBPL-2026-1102-01",
    shortage_quantity: 26,
    suggested_purchase_quantity: 30,
    purchase_requests: [
      { stock_check_id: SC_CT, plan_line_id: "PBPL-2026-1102-01", merge_suggestion_id: MS_CT, merge_group_id: "MG-2026-09-07-1", material_code: "M-CT-110", material_name: "110kV 电流互感器", inventory_organization: "ORG-HD", management_unit: UNIT, business_type: "物资", category_id: "CAT-EL-CT", demand_quantity: 30, shortage_quantity: 26, suggested_purchase_quantity: 30, required_arrival_date: "2027-03-10", is_urgent_demand: false, unit: "台", unit_price: 58500, source_plan_line_ids: ["PBPL-2026-1102-01", "PBPL-2026-1102-02"], source_plan_header_id: PLAN_ID, source_plan_no: PLAN_ID },
    ],
    operation_log: log("库存校验", { rule_hit: ["BR2-STOCK-01", "BR2-STOCK-02"], api_called: ["queryOnhandQuantity", "queryReservation", "queryItemMinMaxLevel"] }),
    _parallel_tool_calls: "三个查询已在同一轮并发发出",
  };
}

function deriveResult(): Row {
  const stages = [
    ["立项", 1, 10, "2026-10-07", "2026-10-16"],
    ["组包", 2, 15, "2026-10-17", "2026-10-31"],
    ["询价", 3, 20, "2026-11-01", "2026-11-20"],
    ["定标", 4, 15, "2026-11-21", "2026-12-05"],
    ["合同", 5, 15, "2026-12-06", "2026-12-20"],
    ["订单", 6, 10, "2026-12-21", "2026-12-30"],
    ["到货", 7, 70, "2026-12-31", "2027-03-10"],
  ].map(([node, seq, days, start, finish]) => ({
    schedule_stage_id: `BSS-2026-09-07-1-${seq}`,
    schedule_plan_id: "BSP-2026-09-07-1",
    cycle_standard_id: `CYC-WZ-${seq}`,
    stage_node: node,
    stage_sequence: seq,
    standard_cycle_days: days,
    min_cycle_days: Math.ceil(Number(days) / 2),
    applied_cycle_days: days,
    planned_start_date: start,
    planned_finish_date: finish,
    derived_by_formula: true,
  }));
  const request = (verifyResult().purchase_requests as Row[])[0]!;
  return {
    scan_date: SCAN_DATE,
    purchase_request: request,
    schedule_plan: { schedule_plan_id: "BSP-2026-09-07-1", plan_line_id: "PBPL-2026-1102-01", stock_check_id: SC_CT, merge_suggestion_id: MS_CT, business_type: "物资", required_arrival_date: "2027-03-10", total_cycle_days: 155, earliest_start_date: "2026-10-07", time_conflict: false, conflict_gap_days: -29, adjust_scheme: "无", green_channel: false, escalated_to_leader: false, scheduled_at: `${SCAN_DATE}T01:10:00+08:00`, schedule_date_basis: "需求到货日期倒排" },
    schedule_stages: stages,
    time_conflict: false,
    schedule_plan_id: "BSP-2026-09-07-1",
    total_cycle_days: 155,
    stage_count: 7,
    conflict_context: null,
    draft_request: {
      business_type: "物资",
      plan_type: "执行计划",
      management_unit: UNIT,
      unit_code: "001",
      plan_period: "2027",
      merge_group_id: "MG-2026-09-07-1",
      merge_suggestion_id: MS_CT,
      scan_date: SCAN_DATE,
      lines: [{ item_code: "M-CT-110", item_name: "110kV 电流互感器", line_type_code: "物资", category_id: "CAT-EL-CT", quantity: 30, unit: "台", unit_price: 58500, need_by_date: "2027-03-10", inventory_organization: "ORG-HD", sourcing_method: "公开询价", is_urgent: false, source_plan_line_ids: ["PBPL-2026-1102-01", "PBPL-2026-1102-02"] }],
      source_plan_line_ids: ["PBPL-2026-1102-01", "PBPL-2026-1102-02"],
      source_plan_header_id: PLAN_ID,
      source_plan_no: PLAN_ID,
      stage_schedule: stages.map((stage) => ({ stage_node: stage.stage_node, planned_start_date: stage.planned_start_date, planned_finish_date: stage.planned_finish_date })),
    },
    blocking_note: "",
    operation_log: log("倒排工期", { rule_hit: ["BR-PLAN-01", "BR2-SCHED-01"] }),
  };
}

/** Exactly what the live model returned on 2026-09-07 16:07 when the mock ERP
 * answered `rows: []` for the cycle configuration: an honest BR-PLAN-01
 * refusal — no stages, no draft request, a blocking note. */
function deriveBlockedResult(): Row {
  const request = (verifyResult().purchase_requests as Row[])[0]!;
  return {
    scan_date: SCAN_DATE,
    purchase_request: request,
    schedule_plan: null,
    schedule_stages: [],
    time_conflict: false,
    schedule_plan_id: "",
    total_cycle_days: 0,
    stage_count: 0,
    conflict_context: null,
    draft_request: null,
    blocking_note: "无法获取业务类型【物资】的阶段周期配置，根据BR-PLAN-01不予推算。",
    operation_log: { operation_type: "倒排工期", operator_role: "采购数字员工", occurred_at: `${SCAN_DATE}T01:10:00+08:00`, rule_hit: ["BR-PLAN-01"], threshold_snapshot: {}, output_digest: "blocked", auditable: true },
  };
}

function auditResult(planId: string, planLineId: string, intercept: boolean): Row {
  const opinionId = intercept ? "AO-2026-09-07-9" : "AO-2026-09-07-1";
  const findings = [
    { audit_finding_id: `${opinionId}-F1`, audit_opinion_id: opinionId, plan_line_id: planLineId, check_item: "集采目录", conclusion: intercept ? "拦截" : "通过", hit_data: intercept ? "M-BRK-126 命中 CPC-0001（一级集采）" : "M-CT-110 目录行 CPC-0003 已失效", catalog_id: intercept ? "CPC-0001" : "", suggested_central_level: intercept ? "一级集采" : "", non_central_reason_provided: false, rectify_advice: intercept ? "标识集采层级或录入不按集采采购原因" : "" },
    { audit_finding_id: `${opinionId}-F2`, audit_opinion_id: opinionId, plan_line_id: planLineId, check_item: "价格异常", conclusion: "通过", current_unit_price: 58500, historical_avg_price: 56166.67, historical_sample_size: 3, price_deviation_ratio: 0.0415, audit_threshold_id: "ATH-PRICE-SOFT", threshold_value: 0.2, actual_value: 0.0415 },
    { audit_finding_id: `${opinionId}-F3`, audit_opinion_id: opinionId, plan_line_id: planLineId, check_item: "重复申报", conclusion: "通过", duplicate_plan_no: "", duplicate_window_days: 30, duplicate_gap_days: 0 },
    { audit_finding_id: `${opinionId}-F4`, audit_opinion_id: opinionId, plan_line_id: planLineId, check_item: "技术附件", conclusion: intercept ? "拦截" : "通过", attachment_complete: !intercept, rectify_advice: intercept ? "补齐技术附件" : "" },
  ];
  return {
    scan_date: SCAN_DATE,
    plan_id: planId,
    plan_line_id: planLineId,
    plan_lines: [{ plan_id: planId, plan_line_id: planLineId, material_code: intercept ? "M-BRK-126" : "M-CT-110", material_name: intercept ? "126kV SF6 断路器" : "110kV 电流互感器", line_type_code: "物资", category_id: intercept ? "CAT-EL-BRK" : "CAT-EL-CT", quantity: intercept ? 4 : 30, unit: "台", unit_price: intercept ? 385000 : 58500, required_arrival_date: intercept ? "2027-05-30" : "2027-03-10", management_unit: UNIT, inventory_organization: "ORG-HD", receiving_region: "华东", central_purchase_level: "未标识", attachment_complete: !intercept, is_urgent: false, source_plan_line_ids: intercept ? ["PBPL-2026-1102-03"] : ["PBPL-2026-1102-01", "PBPL-2026-1102-02"] }],
    thresholds_used: { price_deviation_soft: 0.2, price_deviation_escalate: 0.5, duplicate_window_days: 30, audit_threshold_ids: ["ATH-PRICE-SOFT", "ATH-PRICE-ESC", "ATH-DUP-WINDOW"] },
    audit_opinion: { audit_opinion_id: opinionId, plan_id: planId, plan_line_id: planLineId, audit_result: intercept ? "拦截" : "通过", intercept, finding_count: 4, price_curve: [{ management_unit: UNIT, points: [{ creation_date: "2026-02-09", unit_price: 55000 }, { creation_date: "2026-05-14", unit_price: 56000 }, { creation_date: "2026-08-03", unit_price: 57500 }] }], price_curve_attached: true, rectify_advice: intercept ? "应集采未集采：标识集采层级或录入不按集采采购原因；技术附件缺失：补齐后重新提交" : "", audited_at: `${SCAN_DATE}T01:20:00+08:00`, opinion_status: intercept ? "待整改" : "已通过", submitted_by: "采购数字员工" },
    audit_findings: findings,
    intercept,
    audit_opinion_id: opinionId,
    audit_result: intercept ? "拦截" : "通过",
    finding_count: 4,
    audited_at: `${SCAN_DATE}T01:20:00+08:00`,
    intercept_context: intercept
      ? { audit_opinion_id: opinionId, plan_id: planId, plan_line_id: planLineId, intercept_items: "应集采未集采,技术附件缺失", rectify_advice: "标识集采层级或录入不按集采采购原因；补齐技术附件", suggested_central_level: "一级集采", scan_date: SCAN_DATE }
      : null,
    operation_log: log("年度计划审核", { rule_hit: ["BR2-CENTRAL-01", "BR2-PRICE-01", "BR2-DUP-01", "BR2-ATTACH-01"] }),
    _parallel_tool_calls: "四个查询已在同一轮并发发出",
  };
}

function recommendResult(planId: string, planLineId: string): Row {
  const line = { plan_line_id: planLineId, material_code: "M-CT-110", material_name: "110kV 电流互感器", management_unit: UNIT, inventory_organization: "ORG-HD", category_id: "CAT-EL-CT", quantity: 30, unit_price: 58500, required_arrival_date: "2027-03-10", sourcing_method: "公开询价" };
  const scheme = (id: string, score: number, recommended: boolean) => ({
    package_scheme_id: id,
    scheme_no: id,
    plan_id: planId,
    purchasing_group_no: "PG-HD-01",
    business_type: "物资",
    category_id: "CAT-EL-CT",
    scenario_code: "常规寻源",
    match_score: score,
    line_count: 1,
    total_amount: 1755000,
    region_similarity: 1,
    delivery_overlap_rate: 1,
    delivery_span_days: 0,
    mixed_type_detected: false,
    split_advice: "",
    special_sourcing_method: "无",
    is_recommended: recommended,
    sibling_scheme_count: 2,
    scheme_status: "待选择",
    management_unit: UNIT,
    package_lines: [line],
    recommendation_basis: recommended ? "同品类同地域，框架协议在效，匹配度最高" : "按采购组拆分的备选方案",
  });
  const schemes = [scheme("PS-2026-09-07-1", 92, true), scheme("PS-2026-09-07-2", 74, false)];
  return {
    scan_date: SCAN_DATE,
    plan_id: planId,
    plan_lines: [line],
    thresholds_used: { delivery_span_days: 90, delivery_overlap_rate: 0.7, audit_threshold_ids: ["ATH-PKG-SPAN", "ATH-PKG-OVERLAP"] },
    package_schemes: schemes,
    recommended_scheme: schemes[0],
    compliance_violated: false,
    compliance_findings: [
      { pkg_finding_id: "PCF-2026-09-07-1", package_scheme_id: "PS-2026-09-07-1", check_item: "类型一致", conclusion: "通过", detected_types: ["物资"], resolved: true },
      { pkg_finding_id: "PCF-2026-09-07-2", package_scheme_id: "PS-2026-09-07-1", check_item: "交货跨度", conclusion: "通过", delivery_span_days: 0, threshold_value: 90, resolved: true },
      { pkg_finding_id: "PCF-2026-09-07-3", package_scheme_id: "PS-2026-09-07-1", check_item: "特殊采购方式", conclusion: "通过", special_sourcing_method: "无", resolved: true },
    ],
    violation_context: null,
    package_scheme_id: "PS-2026-09-07-1",
    scheme_no: "PS-2026-09-07-1",
    match_score: 92,
    sibling_scheme_count: 2,
    is_recommended: true,
    operation_log: log("组包推荐", { rule_hit: ["BR2-PKG-01", "BR2-PKG-02", "BR2-PKG-03", "BR2-PKG-04"] }),
    _parallel_tool_calls: "两个查询已在同一轮并发发出",
  };
}

describe.sequential("采购-HC-Formal 场景二 digital-employee cascade (E2E)", () => {
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
  /** Live stream frames with an error field — the step-engine refusal reason
   * (meta.error) only survives on this channel. */
  const streamErrors: string[] = [];
  let unsubscribeStream: (() => void) | undefined;
  const agentDbIds = new Map<string, string>();

  // gateway scripting state
  let scanCalls = 0;
  let verifyCalls = 0;
  let auditCalls = 0;
  let auditInterceptFirst = false;
  /** derivePurchaseSchedule reports BR-PLAN-01 "no cycle config" instead of a schedule. */
  let deriveBlocked = false;
  /** Explicit plan reference for audit/recommend when no createPbp preceded them. */
  let auditPlanRef: { plan_id: string; plan_line_id: string } | null = null;
  let plannerDecision: "approved" | "rejected" = "approved";

  async function latestDraft(): Promise<{ plan_id: string; plan_line_id: string }> {
    if (auditPlanRef) return auditPlanRef;
    const entries = await journalOps();
    const draft = [...entries].reverse().find((entry) => entry.op === "createPbp");
    if (!draft) throw new Error("audit scripted before any createPbp journal entry");
    const context = (draft.result as { draft_context?: { plan_id: string; plan_line_id: string } }).draft_context;
    if (!context) throw new Error("createPbp journal entry carries no draft_context");
    return { plan_id: context.plan_id, plan_line_id: context.plan_line_id };
  }

  const scriptedGateway = {
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const purpose = request.purpose ?? "";
      const base = { provider: "mock", model: "scripted", tokensIn: 100, tokensOut: 50, finishReason: "stop", latencyMs: 1 };
      const answer = (value: Row): ChatResponse => ({ ...base, text: JSON.stringify(value) }) as ChatResponse;
      if (purpose.includes("scanApprovedDemandPlan")) {
        scanCalls += 1;
        if (scanCalls === 1) {
          // First turn: exercise the merged multi-operation query tool for real.
          return {
            ...base,
            text: "",
            toolCalls: [{ id: "call-scan-1", name: "metaerp.invoke", input: { operation: "queryPbpLine", payload: { PBP_HEADER_ID: PLAN_ID } } }],
          } as unknown as ChatResponse;
        }
        return answer(scanResult());
      }
      if (purpose.includes("analyzeDemandMerge")) return answer(mergeResult());
      if (purpose.includes("verifyInventoryAvailability")) {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          return {
            ...base,
            text: "",
            toolCalls: [
              { id: "call-onhand", name: "metaerp.invoke", input: { operation: "queryOnhandQuantity", payload: { INVENTORY_STATUS: "合格" } } },
              { id: "call-minmax", name: "metaerp.invoke", input: { operation: "queryItemMinMaxLevel", payload: { IS_ENABLED: "Y" } } },
            ],
          } as unknown as ChatResponse;
        }
        return answer(verifyResult());
      }
      if (purpose.includes("derivePurchaseSchedule")) return answer(deriveBlocked ? deriveBlockedResult() : deriveResult());
      if (purpose.includes("auditAnnualPlanCompliance")) {
        auditCalls += 1;
        const ref = await latestDraft();
        const intercept = auditInterceptFirst && auditCalls === 1;
        return answer(auditResult(ref.plan_id, ref.plan_line_id, intercept));
      }
      if (purpose.includes("recommendPackagingScheme")) {
        const ref = await latestDraft();
        return answer(recommendResult(ref.plan_id, ref.plan_line_id));
      }
      return answer({});
    },
  } as unknown as LLMGateway;

  beforeAll(async () => {
    // 1) mock Meta ERP on an ephemeral port, loaded with the 采购-HC-Formal data plane
    erp = buildApp({
      dataDir: path.join(PACKAGE_DIR, "mock-erp"),
      transformMapsPath: path.join(PACKAGE_DIR, "transform-maps/transform-maps.json"),
      stateDir: mkdtempSync(path.join(tmpdir(), "hcf-e2e-erp-")),
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
    db.insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "采购-HC-Formal E2E" }).run();
    unsubscribeStream = subscribeStream(tenantId, (frame) => {
      const record = frame as unknown as Record<string, unknown>;
      if (record.error) {
        streamErrors.push(`${String(record.type)} ${String(record.name ?? "")}: ${String(record.error)}`);
      }
    });
    db.insert(workflows)
      .values({ id: workflowId, tenantId, slug: "procurement-hc-formal", name: "采购计划编制与执行偏差预警" })
      .run();

    // 3) register every compiled manifest agent against the REAL engine
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
    db.delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  /** The human forms, filled the way the portal would from the task's trigger context. */
  function formFor(eventName: string, data: Record<string, unknown>): Record<string, unknown> {
    if (eventName === "FRAME_AND_CENTRAL_ANNOTATED") {
      return {
        decision: plannerDecision,
        selected_by: "张计划",
        package_scheme_id: data.package_scheme_id,
        scheme_no: data.scheme_no,
        plan_id: data.plan_id,
        plan_line_id: data.plan_line_id,
        package_id: data.package_id,
        rejection_reason: plannerDecision === "rejected" ? "备选方案交货节奏更贴合检修窗口" : "",
        comment: "确认草稿并选定推荐方案",
      };
    }
    if (eventName === "PLAN_AUDIT_INTERCEPTED") {
      return {
        decision: "approved",
        rectified_by: "王申请",
        audit_opinion_id: data.audit_opinion_id,
        plan_id: data.plan_id,
        plan_line_id: data.plan_line_id,
        non_central_reason: "一级集采目录物料已按集团框架协议执行",
        response_note: "技术附件已补齐",
      };
    }
    if (eventName === "DEMAND_SPLIT_REQUIRED") {
      return {
        decision: "approved",
        confirmed_by: "张计划",
        merge_suggestion_id: data.merge_suggestion_id,
        plan_line_ids: data.plan_line_ids ?? [data.plan_line_id],
        remark: "日期差超限，拆为独立计划",
      };
    }
    return { decision: "approved" };
  }

  /** Fake Inngest invocation: step.run executes, sendEvent records, and
   * waitForEvent resolves the HITL task with the filled form exactly like
   * POST /v1/tasks/:id/resolve would (status open→resolving + resumeMarker). */
  function invocation(
    eventName: string,
    data: Record<string, unknown>,
    sink: SentEvent[],
    attempt = 0,
    opts: { stepErrorOnFailure?: boolean } = {},
  ) {
    return {
      event: { name: `${tenantSlug}/${eventName}`, data },
      // Inngest's zero-indexed FUNCTION attempt counter (step retries never
      // move it — the runtime also finalizes on the SDK's StepError).
      attempt,
      step: {
        run: async (id: string | { id: string }, fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          try {
            return await fn(...args);
          } catch (error) {
            // The real SDK surfaces a step's failure to user code only once
            // the step has exhausted its retries, wrapped as a StepError.
            if (opts.stepErrorOnFailure) throw new StepError(typeof id === "string" ? id : id.id, error);
            throw error;
          }
        },
        sendEvent: async (_id: string, payload: { name: string; data?: Record<string, unknown> }) => {
          // Inngest serialises every event to JSON on the wire. Mirror that
          // here: the envelope assembler reuses object instances between the
          // top-level carry and `last_result`, and an explicit
          // `tool_arguments` mapping of the whole `event.data` rejects shared
          // references (`cloneJsonConstant` treats a DAG as a cycle) — a
          // failure that can only happen in an in-memory harness.
          sink.push({ name: payload.name, data: JSON.parse(JSON.stringify(payload.data ?? {})) as Record<string, unknown> });
        },
        sleep: async () => undefined,
        waitForEvent: async (_id: string, opts: { if?: string }) => {
          const cond = opts?.if ?? "";
          const taskId = /async\.data\.taskId == "([^"]+)"/.exec(cond)?.[1];
          const resumeMarker = /async\.data\.resumeMarker == "([^"]+)"/.exec(cond)?.[1];
          if (!taskId || !resumeMarker) throw new Error(`unparseable waitForEvent condition: ${cond}`);
          db.update(tasksTable).set({ status: "resolving" }).where(eq(tasksTable.id, taskId)).run();
          return { data: { taskId, tenantId, resumeMarker, decision: "approve", payload: formFor(eventName, data) } };
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
      if (++hops > 60) throw new Error("cascade runaway");
      const evt = queue.shift()!;
      const bare = evt.name.includes("/") ? evt.name.split("/").slice(1).join("/") : evt.name;
      delivered.push(bare);
      const listeners = registeredByTrigger.get(bare) ?? [];
      for (const listener of listeners) {
        if (opts?.only && !opts.only.includes(listener.name)) continue;
        const sink: SentEvent[] = [];
        try {
          await listener.fn(invocation(bare, { subject: String(rootData.subject ?? "hcf"), ...evt.data }, sink));
        } catch (error) {
          // Name the agent, the failed step's own error and the last ERP
          // exchange: "metaerp.invoke returned ok=false" on its own says
          // nothing about which write failed or why.
          const failedStep = db
            .select()
            .from(stepsTable)
            .where(eq(stepsTable.status, "failed"))
            .orderBy(desc(stepsTable.startedAt))
            .limit(1)
            .all()[0];
          const output = failedStep?.outputRef && existsSync(String(failedStep.outputRef)) ? readFileSync(String(failedStep.outputRef), "utf8").slice(0, 1500) : "(no output artifact)";
          const logsDir = process.env.AGENTIC_LOGS_DIR ?? "";
          const runId = String(failedStep?.runId ?? "");
          const logFile = logsDir && runId ? findFile(logsDir, runId + ".log") : null;
          const runLog = logFile ? readFileSync(logFile, "utf8").split("\n").filter((line) => /fail|error|refus|gate/i.test(line)).slice(-6).join("\n  ") : "(no run log)";
          const artifactDir = failedStep?.outputRef ? path.dirname(String(failedStep.outputRef)) : "";
          const artifacts =
            artifactDir && existsSync(artifactDir)
              ? readdirSync(artifactDir)
                  .map((name) => {
                    const text = readFileSync(path.join(artifactDir, name), "utf8");
                    try {
                      // Everything except the (huge) dispatched input: the
                      // refusal reason lives in the sibling fields.
                      const parsed = JSON.parse(text) as Record<string, unknown>;
                      const { input: _input, action_data: _data, action: _action, ...rest } = parsed ?? {};
                      return `${name}: ${JSON.stringify(rest).slice(0, 1500)}`;
                    } catch {
                      return `${name}: ${text.slice(0, 300)}`;
                    }
                  })
                  .join("\n  ")
              : "(no artifacts)";
          // Replay the explicit tool_arguments materialisation on the recorded
          // step input so an unresolved/invalid mapping names its own reason.
          let replay = "(no step input)";
          const inputRef = failedStep?.inputRef ? String(failedStep.inputRef) : "";
          if (inputRef && existsSync(inputRef)) {
            try {
              const recorded = JSON.parse(readFileSync(inputRef, "utf8")) as { action?: { tool_arguments?: Record<string, never> }; action_data?: Record<string, unknown> };
              const { materializeToolArguments } = await import("../../../packages/runtime/src/action-plan.ts");
              const refs = (readFileSync(inputRef, "utf8").match(/"__ref"/g) ?? []).length;
              const dataKeys = Object.entries(recorded.action_data ?? {}).map(([key, value]) => `${key}:${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
              const materialized = recorded.action?.tool_arguments
                ? materializeToolArguments(recorded.action.tool_arguments, { event: { name: bare, data: recorded.action_data }, input: recorded.action_data, lastResult: recorded.action_data, results: {}, locals: {} } as never)
                : null;
              replay = `blob refs in input: ${refs}; action_data keys: ${dataKeys.join(", ")}; materialize → ${JSON.stringify(materialized && !materialized.ok ? materialized : { ok: materialized?.ok ?? null })}`;
            } catch (replayError) {
              replay = `replay failed: ${(replayError as Error).message}`;
            }
          }
          const tail = (await journalOps()).slice(-2).map((entry) => `${entry.op} ← ${JSON.stringify(entry.payload).slice(0, 300)} → ${JSON.stringify(entry.result).slice(0, 300)}`);
          throw new Error(
            `${listener.name} on ${bare} failed: ${(error as Error).message}\n  failed step: ${failedStep?.name ?? "?"} (${failedStep?.error ?? ""})\n  step output: ${output}\n  run log:\n  ${runLog}\n  stream errors: ${streamErrors.slice(-4).join(" | ")}\n  replay: ${replay}\n  artifacts:\n  ${artifacts}\n  journal tail:\n  ${tail.join("\n  ")}`,
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

  async function journalOps(): Promise<Array<{ op: string; payload: Record<string, unknown>; result: Record<string, any> }>> {
    const res = await fetch(`${erpBase}/__journal`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { entries?: unknown[] } | unknown[];
    const entries = Array.isArray(body) ? body : (body.entries ?? []);
    return entries as Array<{ op: string; payload: Record<string, unknown>; result: Record<string, any> }>;
  }

  function emittedBy(runId: string): string[] {
    return db.select().from(eventStore).where(eq(eventStore.sourceRunId, runId)).all().map((row) => row.name);
  }

  it("runs the whole 数字员工 chain: scan → merge → stock check → (transfer | schedule → draft → audit → packaging → annotate → 计划员确认 → submit)", async () => {
    scanCalls = 0;
    verifyCalls = 0;
    auditCalls = 0;
    auditInterceptFirst = false;
    auditPlanRef = null;
    deriveBlocked = false;
    plannerDecision = "approved";
    await fetch(`${erpBase}/__reset`, { method: "POST" });

    const delivered = await dispatchCascade("DAILY_DEMAND_PLAN_SCAN_SCHEDULED", {
      subject: "demand-scan-2026-09-07",
      scan_date: SCAN_DATE,
      scan_batch_id: "SCAN-2026-09-07-01",
      scan_scope: "全集团",
    });

    for (const expected of [
      "DAILY_DEMAND_PLAN_SCAN_SCHEDULED",
      "APPROVED_DEMAND_PLAN_SCANNED",
      "DEMAND_MERGE_ANALYZED",
      "INVENTORY_AVAILABILITY_VERIFIED",
      "STOCK_SUFFICIENT_FOR_DEMAND",
      "INVENTORY_TRANSFER_ORDER_CREATED",
      "PURCHASE_REQUIRED_CONFIRMED",
      "PURCHASE_SCHEDULE_DERIVED",
      "EXECUTION_PLAN_DRAFT_GENERATED",
      "ANNUAL_PLAN_AUDITED",
      "PACKAGING_SCHEME_RECOMMENDED",
      "FRAME_AND_CENTRAL_ANNOTATED",
      "PLAN_AND_PACKAGE_CONFIRMED",
      "PLAN_SUBMITTED_FOR_APPROVAL",
    ]) {
      expect(delivered, `event ${expected} delivered`).toContain(expected);
    }
    // Branches that must NOT fire on the happy path.
    for (const absent of ["DEMAND_SPLIT_REQUIRED", "SCHEDULE_TIME_CONFLICT_DETECTED", "PLAN_AUDIT_INTERCEPTED", "PACKAGING_COMPLIANCE_VIOLATED", "PLAN_AND_PACKAGE_REJECTED"]) {
      expect(delivered, `event ${absent} absent`).not.toContain(absent);
    }

    // The scan and stock-check agents really exercised the merged query tool (2 LLM turns each).
    expect(scanCalls).toBe(2);
    expect(verifyCalls).toBe(2);
    expect(auditCalls).toBe(1);

    // Every agent in the chain completed ok against the real engine.
    for (const name of [
      "scanApprovedDemandPlan",
      "analyzeDemandMerge",
      "verifyInventoryAvailability",
      "createInventoryTransferOrder",
      "derivePurchaseSchedule",
      "generateExecutionPlanDraft",
      "auditAnnualPlanCompliance",
      "recommendPackagingScheme",
      "annotateFrameAndCentralPurchase",
      "confirmPlanAndPackage",
      "submitPlanForApproval",
    ]) {
      const [latest] = runsFor(name);
      expect(latest, `run row for ${name}`).toBeDefined();
      expect(latest!.status, `status of ${name}`).toBe("ok");
    }

    // HITL: the 计划员确认 task was created and resolved with the filled form.
    const taskRows = db.select().from(tasksTable).where(eq(tasksTable.tenantId, tenantId)).all();
    expect(taskRows.length).toBeGreaterThanOrEqual(1);
    for (const task of taskRows) expect(["resolved", "resolving"]).toContain(task.status);
    expect(taskRows.some((task) => task.type === "plan.package-confirm")).toBe(true);

    // Real ERP side effects, in order, with id propagation draft → package → submission.
    const ops = await journalOps();
    const opNames = ops.map((entry) => entry.op);
    expect(opNames).toEqual(
      expect.arrayContaining(["createTransactionOrder", "createPbp", "createProcPackageLines", "writeOperationLog", "submitApproval"]),
    );
    const transfer = ops.find((entry) => entry.op === "createTransactionOrder")!;
    expect(transfer.result.applied).toBe(true);
    expect(transfer.result.transfer_context).toMatchObject({ transfer_reason: "库存可调度", transfer_quantity: 3000, plan_line_id: "PBPL-2026-1102-04" });

    const draft = ops.find((entry) => entry.op === "createPbp")!;
    expect(draft.result.source_mapping_written).toBe(true);
    expect(draft.result.draft_context).toMatchObject({ draft_line_count: 1, merge_group_id: "MG-2026-09-07-1" });
    const planId = draft.result.id as string;

    const annotate = ops.find((entry) => entry.op === "createProcPackageLines")!;
    expect(annotate.result.annotation_context).toMatchObject({
      package_scheme_id: "PS-2026-09-07-1",
      plan_id: planId,
      frame_hit: true,
      frame_agreement_no: "SPA-2026-0338",
      central_level: "非集采",
    });
    const packageId = annotate.result.id as string;

    const confirm = ops.find((entry) => entry.op === "writeOperationLog")!;
    expect(confirm.payload).toMatchObject({ decision: "approved", selected_by: "张计划", package_scheme_id: "PS-2026-09-07-1", plan_id: planId, package_id: packageId });

    const submit = ops.find((entry) => entry.op === "submitApproval")!;
    expect(submit.result.submission_context).toMatchObject({ plan_id: planId, package_id: packageId, trace_sealed: true });

    // The ERP state moved: draft header 审批中, package 审批中, scheme 已生成采购包.
    const headerRes = await fetch(`${erpBase}/metaerp/openapi/v1/queryPbpHeader`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ PBP_HEADER_ID: planId }) });
    const header = ((await headerRes.json()) as { rows: Row[] }).rows[0]!;
    expect(header).toMatchObject({ PLAN_CATEGORY: "执行计划", STATUS: "审批中" });

    // Durable event records exist for the emitted chain (event_store rows).
    const storeNames = new Set(db.select().from(eventStore).where(eq(eventStore.tenantId, tenantId)).all().map((row) => row.name));
    for (const expected of ["APPROVED_DEMAND_PLAN_SCANNED", "STOCK_SUFFICIENT_FOR_DEMAND", "EXECUTION_PLAN_DRAFT_GENERATED", "FRAME_AND_CENTRAL_ANNOTATED", "PLAN_SUBMITTED_FOR_APPROVAL"]) {
      expect(storeNames.has(expected), `event_store has ${expected}`).toBe(true);
    }
  });

  it("intercepts an 应集采未集采 draft, routes it through 申请人整改, and re-audits on PLAN_RECTIFICATION_SUBMITTED", async () => {
    auditCalls = 0;
    auditInterceptFirst = true;
    auditPlanRef = { plan_id: PLAN_ID, plan_line_id: "PBPL-2026-1102-03" };
    await fetch(`${erpBase}/__reset`, { method: "POST" });

    const delivered = await dispatchCascade(
      "EXECUTION_PLAN_DRAFT_GENERATED",
      {
        subject: "intercept-brk-003",
        plan_id: PLAN_ID,
        plan_no: PLAN_ID,
        plan_line_id: "PBPL-2026-1102-03",
        draft_line_count: 1,
        source_mapping_written: true,
        scan_date: SCAN_DATE,
        plan_lines: [LINES[2]],
      },
      { only: ["auditAnnualPlanCompliance", "returnPlanForRectification"] },
    );

    expect(delivered).toContain("PLAN_AUDIT_INTERCEPTED");
    expect(delivered).toContain("PLAN_RETURNED_FOR_RECTIFICATION");
    expect(delivered).toContain("PLAN_RECTIFICATION_SUBMITTED");
    expect(delivered).toContain("ANNUAL_PLAN_AUDITED"); // second audit, after rectification
    expect(auditCalls).toBe(2);

    const [rectify] = runsFor("returnPlanForRectification");
    expect(rectify!.status).toBe("ok");
    const auditRuns = runsFor("auditAnnualPlanCompliance");
    expect(auditRuns.length).toBeGreaterThanOrEqual(2);
    expect(emittedBy(auditRuns[1]!.id)).toContain("PLAN_AUDIT_INTERCEPTED");
    expect(emittedBy(auditRuns[0]!.id)).toContain("ANNUAL_PLAN_AUDITED");

    const ops = await journalOps();
    const task = ops.find((entry) => entry.op === "pushTask")!;
    expect(task).toBeDefined();
    expect(task.payload).toMatchObject({ audit_opinion_id: "AO-2026-09-07-9", rectified_by: "王申请", decision: "approved" });
    expect(task.result.rectification_context).toMatchObject({ non_central_reason: "一级集采目录物料已按集团框架协议执行", plan_line_id: "PBPL-2026-1102-03" });
    const tasks = db.select().from(tasksTable).where(eq(tasksTable.tenantId, tenantId)).all();
    expect(tasks.some((row) => row.type === "plan.rectification-accept")).toBe(true);
  });

  it("BR2-STOCK-01 gate: a stock check that is not 可调度 performs no transfer and emits nothing", async () => {
    await fetch(`${erpBase}/__reset`, { method: "POST" });
    await dispatchCascade(
      "STOCK_SUFFICIENT_FOR_DEMAND",
      { subject: "gate-stock-01", ...(verifyResult().transfer_context as Row), stock_check_flag: "需采购" },
      { only: ["createInventoryTransferOrder"] },
    );
    const [latest] = runsFor("createInventoryTransferOrder");
    expect(latest!.status).toBe("ok"); // blocked-by-gate runs finish; write + emit are skipped
    const ops = await journalOps();
    expect(ops.map((entry) => entry.op)).not.toContain("createTransactionOrder");
    expect(emittedBy(latest!.id)).not.toContain("INVENTORY_TRANSFER_ORDER_CREATED");
  });

  it("BR2-HITL-01 gate: a confirmation without the planner's name never reaches submitApproval", async () => {
    await fetch(`${erpBase}/__reset`, { method: "POST" });
    await dispatchCascade(
      "PLAN_AND_PACKAGE_CONFIRMED",
      { subject: "gate-hitl-01", package_scheme_id: "PS-2026-09-07-1", plan_id: "PBP-EXEC-X", plan_line_id: "PBP-EXEC-X-01", selected_at: `${SCAN_DATE}T02:00:00+08:00` },
      { only: ["submitPlanForApproval"] },
    );
    const [latest] = runsFor("submitPlanForApproval");
    expect(latest!.status).toBe("ok");
    const ops = await journalOps();
    expect(ops.map((entry) => entry.op)).not.toContain("submitApproval");
    expect(emittedBy(latest!.id)).not.toContain("PLAN_SUBMITTED_FOR_APPROVAL");
  });

  it("a 计划员 rejection records the reason and branches to PLAN_AND_PACKAGE_REJECTED instead of CONFIRMED", async () => {
    plannerDecision = "rejected";
    await fetch(`${erpBase}/__reset`, { method: "POST" });
    const delivered = await dispatchCascade(
      "FRAME_AND_CENTRAL_ANNOTATED",
      { subject: "planner-rejects", package_scheme_id: "PS-2026-09-07-1", scheme_no: "PS-2026-09-07-1", plan_id: PLAN_ID, plan_line_id: "PBPL-2026-1102-01", package_id: "PKG-X", frame_hit: true, central_level: "非集采" },
      { only: ["confirmPlanAndPackage"] },
    );
    plannerDecision = "approved";
    expect(delivered).toContain("PLAN_AND_PACKAGE_REJECTED");
    expect(delivered).not.toContain("PLAN_AND_PACKAGE_CONFIRMED");
    const ops = await journalOps();
    const confirm = ops.find((entry) => entry.op === "writeOperationLog")!;
    expect(confirm.result.rejection_context).toMatchObject({ rejection_reason: "备选方案交货节奏更贴合检修窗口", rejected_by: "张计划" });
  });

  // ── 2026-09-07 live defect: "跑不了" ────────────────────────────────────────
  // derivePurchaseSchedule honestly reported BR-PLAN-01 (no cycle config) yet
  // emitted PURCHASE_SCHEDULE_DERIVED; generateExecutionPlanDraft then sent
  // `draft_request: null` to createPbp, got HTTP 400, and was retried for six
  // minutes while the canvas said "running". Three guards, all exercised on
  // the real engine below: blocking outcome → failed run, 4xx → terminal,
  // last attempt → run row finalized.

  it("a blocked 倒排 (BR-PLAN-01) FAILS its run with the model's own reason and emits nothing — createPbp never runs", async () => {
    deriveBlocked = true;
    await fetch(`${erpBase}/__reset`, { method: "POST" });
    const listener = (registeredByTrigger.get("PURCHASE_REQUIRED_CONFIRMED") ?? []).find((entry) => entry.name === "derivePurchaseSchedule");
    expect(listener).toBeDefined();
    const sink: SentEvent[] = [];
    const before = new Set(runsFor("derivePurchaseSchedule").map((row) => row.id));
    try {
      await expect(
        listener!.fn(invocation("PURCHASE_REQUIRED_CONFIRMED", { subject: "schedule-blocked", ...verifyResult(), stock_check_id: SC_CT }, sink)),
      ).rejects.toThrow(/schedule_blocked|blocked_outcome/);
    } finally {
      deriveBlocked = false;
    }
    const run = runsFor("derivePurchaseSchedule").find((row) => !before.has(row.id));
    expect(run, "run row for the blocked derivePurchaseSchedule").toBeDefined();
    expect(run!.status).toBe("failed");
    expect(run!.errorMessage).toContain("无法获取业务类型【物资】的阶段周期配置");
    expect(sink.map((event) => event.name)).toEqual([]);
    expect(emittedBy(run!.id)).toEqual([]);
    expect((await journalOps()).map((entry) => entry.op)).not.toContain("createPbp");
  });

  it("a null draft reaching createPbp is terminal at once (HTTP 400 is not retried) and the run row is failed", async () => {
    await fetch(`${erpBase}/__reset`, { method: "POST" });
    const listener = (registeredByTrigger.get("PURCHASE_SCHEDULE_DERIVED") ?? []).find((entry) => entry.name === "generateExecutionPlanDraft");
    expect(listener).toBeDefined();
    const before = new Set(runsFor("generateExecutionPlanDraft").map((row) => row.id));
    const blockedUpstream = { subject: "null-draft", ...deriveBlockedResult() };
    await expect(listener!.fn(invocation("PURCHASE_SCHEDULE_DERIVED", blockedUpstream, [], 0))).rejects.toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/HTTP 400/),
    });
    const run = runsFor("generateExecutionPlanDraft").find((row) => !before.has(row.id));
    expect(run!.status).toBe("failed");
    expect(run!.errorMessage).toMatch(/HTTP 400.*at least one plan line/);
  });

  it("an unreachable Meta ERP is retried while attempts remain and finalizes the run as failed on the last one — no zombie 'running' row", async () => {
    const listener = (registeredByTrigger.get("PURCHASE_SCHEDULE_DERIVED") ?? []).find((entry) => entry.name === "generateExecutionPlanDraft");
    expect(listener).toBeDefined();
    const trigger = { subject: "erp-down", ...deriveResult() };
    const liveBase = process.env.METAERP_BASE_URL;
    process.env.METAERP_BASE_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
    try {
      // Attempt 0 of a 3-retry budget: retriable, so the row is left for Inngest's next attempt.
      const beforeFirst = new Set(runsFor("generateExecutionPlanDraft").map((row) => row.id));
      await expect(listener!.fn(invocation("PURCHASE_SCHEDULE_DERIVED", trigger, [], 0))).rejects.toThrow(/integration_unreachable/);
      const pending = runsFor("generateExecutionPlanDraft").find((row) => !beforeFirst.has(row.id));
      expect(pending!.status).toBe("running");
      // Last attempt (retries = 3 → attempt index 3): the same failure is the final word.
      const beforeLast = new Set(runsFor("generateExecutionPlanDraft").map((row) => row.id));
      await expect(listener!.fn(invocation("PURCHASE_SCHEDULE_DERIVED", trigger, [], 3))).rejects.toThrow(/integration_unreachable/);
      const final = runsFor("generateExecutionPlanDraft").find((row) => !beforeLast.has(row.id));
      expect(final!.status).toBe("failed");
      expect(final!.errorMessage).toMatch(/Meta ERP 接口不可达|integration_unreachable/);
      expect(final!.errorMessage).toContain("METAERP_BASE_URL=http://127.0.0.1:9");
      // What the real SDK does (verified live 2026-09-07): step retries never
      // move the function-level attempt counter; user code sees the exhausted
      // step as a StepError on a fresh invocation with attempt 0.
      const beforeStepError = new Set(runsFor("generateExecutionPlanDraft").map((row) => row.id));
      await expect(
        listener!.fn(invocation("PURCHASE_SCHEDULE_DERIVED", trigger, [], 0, { stepErrorOnFailure: true })),
      ).rejects.toThrow(/integration_unreachable/);
      const viaStepError = runsFor("generateExecutionPlanDraft").find((row) => !beforeStepError.has(row.id));
      expect(viaStepError!.status).toBe("failed");
      expect(viaStepError!.errorMessage).toMatch(/integration_unreachable/);
    } finally {
      process.env.METAERP_BASE_URL = liveBase;
    }
  });
});
