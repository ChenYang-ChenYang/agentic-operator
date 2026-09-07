#!/usr/bin/env node
/**
 * Stage the immutable Ontology Package `procurement-hc-formal@0.1.8`（业务领域
 * 采购-HC-Formal：场景一「采购全链路执行偏差三级预警」+ 场景二「数字化员工的
 * 智能作业实践」）into the layout the platform's ontology compiler and the
 * mock Meta ERP both consume.
 *
 *   node scripts/stage-procurement-hc-formal-ontology.mjs \
 *     [--source ontology-packages/procurement-hc-formal/source/package.json] \
 *     [--out ontology-packages/procurement-hc-formal/package]
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/stage-hc-procurement-ontology.mjs stages the earlier Studio *export*
 * of the same domain (六件套 v0_1_004, 场景一 only). This package is the
 * formal, IMMUTABLE 3.2.0 archive: one `package.json` carrying
 * `artifacts.{objects,rules,actions,events,links,workflows}` as bare arrays
 * plus a hash-bound `manifest`, and a sidecar `manifest.json`. The archive is
 * never edited here — its sha256 is verified first, then a projection is
 * written next to it. The compiler still needs the same four things the
 * Studio export lacked:
 *
 *   1. envelopes  — compiler wants `actions` as a bare array, `objects`/`rules`
 *                   under `.payload`, `events` under `.events`.
 *   2. layout     — `studio-models/<ns>/<domain>/` + `transform-maps/`.
 *   3. impl kind  — compiler knows `prompt` | `external`; the archive writes
 *                   `http` (executable:false) and `typescript` (a module this
 *                   repo does not ship — those actions ARE the agent's reasoning).
 *   4. transform-maps — the archive ships none. ACTION_MAP / OBJECT_MAP below
 *                   author that half, binding every ontology endpoint to the
 *                   metaERP statement-catalog idiom (`/metaerp/openapi/v1/<op>`)
 *                   that `metaerp.invoke` and apps/mock-erp speak. The real
 *                   APIG registrations (from the metaerp-openapi-call skill's
 *                   reference) are recorded separately in
 *                   `transform-maps/metaerp-api-bindings.json` for the day the
 *                   VPN is up; nothing here calls them.
 *
 * The ontology's own `tool_use[]` / `side_effects` are the authority for what
 * an action may call; ACTION_MAP restates them in the compiler's query/write
 * vocabulary (`query*` prefix for reads — the compiler drops anything else)
 * and adds nothing an action did not declare at the action or input level.
 * Every mapping is a declared table, output is byte-stable for a fixed input.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMESPACE = "allmeta";
const DOMAIN = "procurement-hc-formal";
const CATALOG_BASE = "/metaerp/openapi/v1";
/** Family file tag; the compiler picks the lexicographically last `<family>_v*.json`. */
const FAMILY_TAG = "v0_1_008";

// ── Actions ↔ ERP APIs (transformation map #2) ───────────────────────────────
// `kind` is the COMPILER kind, not the archive kind:
//   prompt   → one LLM `logic` step; `queries` become read-scoped metaerp.invoke
//   external → rule gates + manual steps + ONE write-scoped metaerp.invoke
//
// 场景一 (15) is carried over verbatim from stage-hc-procurement-ontology.mjs so
// the two tenants stay behaviourally identical on the deviation chain.
// 场景二 (14): `typescript` actions whose action_steps are all `logic` compile
// to prompt agents; anything that declares a `manual` step or an ERP write
// compiles to external (the only path that can express a human gate / write).
const ACTION_MAP = {
  // ═══ 场景一 · 采购全链路执行偏差三级预警 ═══════════════════════════════════
  collectChainExecutionData: {
    kind: "prompt",
    queries: [
      { operation: "queryOpenPbpHeader", description: "查询在途采购计划头（状态=已批准）。" },
      { operation: "queryOpenPbpLine", description: "查询采购计划行——需求到货日期来源。" },
      { operation: "queryAllPbpLinePage", description: "分页查询计划头行关系，防止行重复归集（本体 tool_use 名 getAllPbpLinePageByQuery；编译器只识别 query* 前缀的只读 op）。" },
      { operation: "queryPr", description: "采集立项节点状态与审批通过时间。" },
      { operation: "queryProcPackageLineExecuteMode", description: "采集组包节点状态与组包完成时间。" },
      { operation: "queryRfxList", description: "采集询价节点状态、询价生效/发标/截标时间。" },
      { operation: "queryAwardList", description: "采集定标节点中标日期与中标供应商。" },
      { operation: "querySpaList", description: "采集价格协议——合同的前置凭据（本体 tool_use 名 getSpaByQuery）。" },
      { operation: "queryContract", description: "采集合同节点签署/生效状态与日期（本体 tool_use 名 getContractByQuery）。" },
      { operation: "queryPoHeader", description: "采集订单节点审批时间与生效日期。" },
      { operation: "queryPoLineShipment", description: "采集到货进度：订单数量与已接收数量。" },
      { operation: "queryAcceptHeader", description: "采集验收单与验收行接收数量。" },
      { operation: "queryAcceptTransaction", description: "采集验收交易记录与交易时间。" },
    ],
  },
  calculateExecutionDeviation: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "按业务类型取七个节点的标准周期（BR-PLAN-01 的配置来源；本体 tool_use 名 getStageCycleConfig）。" },
      { operation: "queryAlertThresholdConfig", description: "取时间/进度偏差判定阈值（BR-DEV-02：阈值必须来自配置，不得写死）。" },
    ],
  },
  archiveDeviationMonitoring: { kind: "prompt", queries: [] },
  scoreOnTimeProbability: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "汇总当前节点之后各节点标准周期，得到剩余天数。" },
      { operation: "queryHistoricalOnTimeRate", description: "统计同业务类型历史已完结单的按期达成率与样本量。" },
      { operation: "queryAlertThresholdConfig", description: "取红/黄概率分界阈值。" },
    ],
  },
  raiseDeviationAlert: { kind: "external", operation: "pushAlert", target: "Deviation_Alert" },
  handleBlueAlertLocally: { kind: "external", operation: "closeBlueAlert", target: "Deviation_Alert" },
  generateAdjustmentOptions: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "后续节点标准周期，方案①的可压缩空间。" },
      { operation: "queryTransferableStock", description: "定位可调库点与可调数量，方案③的调拨来源。" },
    ],
  },
  approveAdjustmentOption: { kind: "external", operation: "approveAdjustmentOption", target: "Adjustment_Option" },
  escalateOverdueAlert: { kind: "external", operation: "escalateAlert", target: "Deviation_Alert" },
  compressDownstreamCycle: { kind: "external", operation: "changePbp", target: "Chain_Stage_Progress" },
  adjustRequiredArrivalDate: { kind: "external", operation: "changePbpLine", target: "Procurement_Plan_Line" },
  createStockTransferRequest: { kind: "external", operation: "createTransactionOrder", target: "Stock_Transfer_Request" },
  trackTransferFulfillment: { kind: "external", operation: "updateTransactionOrder", target: "Stock_Transfer_Request" },
  closeDeviationHandling: { kind: "external", operation: "writeEventLog", target: "Alert_Handling_Record" },
  recycleFalseAlarm: { kind: "external", operation: "createReviewItem", target: "Rule_Review_Item" },

  // ═══ 场景二 · 数字化员工的智能作业实践 ═════════════════════════════════════
  // ①查 —— 每日扫描已审批需求计划
  scanApprovedDemandPlan: {
    kind: "prompt",
    queries: [
      { operation: "queryPbpHeader", description: "查询采购业务计划头（本体 tool_use 名 queryPbpHeader）。过滤列（精确匹配）：STATUS / PLAN_CATEGORY / BUSINESS_TYPE / PBP_HEADER_ID / IS_DELETED；已批准需求计划用 {\"STATUS\":\"已批准\",\"PLAN_CATEGORY\":\"需求计划\",\"IS_DELETED\":\"N\"}。" },
      { operation: "queryPbpLine", description: "按计划头拉取采购业务计划行，取需求合并所需字段。过滤列：PBP_HEADER_ID / PBP_LINE_ID / ITEM_CODE / IS_CANCELLED / IS_DELETED；取消/删除行按 BR2-SCAN-01 在推理里剔除。" },
    ],
  },
  // ②析 —— 需求合并聚类（纯推理：clusterDemandLines / scoreMergeConfidence 是 Agent 的推理本身）
  analyzeDemandMerge: { kind: "prompt", queries: [] },
  // ③行 —— 拆分超限需求（计划员确认后落单据）
  splitOversizedDemand: { kind: "external", operation: "splitDemandLine", target: "Demand_Merge_Suggestion" },
  // ④析 —— 库存校验（三个只读接口）
  verifyInventoryAvailability: {
    kind: "prompt",
    queries: [
      { operation: "queryOnhandQuantity", description: "库存现有量（本体 tool_use 名 multiOnhandQuantityQuery）。过滤列：MATERIAL_CODE（可传数组=IN）/ INVENTORY_ORGANIZATION / INVENTORY_STATUS；建议 {\"INVENTORY_STATUS\":\"合格\"} 取全部合格库存后按物料+组织汇总。" },
      { operation: "queryReservation", description: "库存预留量，可用量 = 现有量合计 − 已预留量合计。过滤列：MATERIAL_CODE（可传数组）/ INVENTORY_ORGANIZATION；可不带过滤取全表。" },
      { operation: "queryItemMinMaxLevel", description: "物料最大/最小库存水位（安全库存）。过滤列：MATERIAL_CODE（可传数组）/ INVENTORY_ORGANIZATION / IS_ENABLED；用 {\"IS_ENABLED\":\"Y\"}。" },
    ],
  },
  // ⑤行 —— 可调度 → 调拨申请单（与场景一共用 createTransactionOrder，以 transfer_reason 区分来路）
  createInventoryTransferOrder: { kind: "external", operation: "createTransactionOrder", target: "Stock_Transfer_Request" },
  // ⑥算 —— 倒排工期
  derivePurchaseSchedule: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "阶段周期配置（本体 tool_use 名 getStageCycleConfig）。过滤列：BUSINESS_TYPE（物资|工程）/ STAGE_NODE；用 {\"BUSINESS_TYPE\":\"物资\"} 一次取七个节点；缺配置的节点不予推算（BR-PLAN-01）。" },
    ],
  },
  // ⑦行 —— 执行计划草稿（createPbp 建头行并写来源映射）
  generateExecutionPlanDraft: { kind: "external", operation: "createPbp", target: "Procurement_Plan" },
  // ⑧审 —— 四类校验
  auditAnnualPlanCompliance: {
    kind: "prompt",
    queries: [
      { operation: "queryAuditThresholdConfig", description: "校验阈值配置（本体 tool_use 名 getAuditThresholdConfig）。过滤列：RULE_KEY / IS_ENABLED；用 {\"IS_ENABLED\":\"Y\"} 取全部有效阈值（价格软预警/升级、查重窗口、组包跨度/重叠度），BR2-THRESH-01 不得写死。" },
      { operation: "queryCentralCatalogConfig", description: "集采目录（本体 tool_use 名 getCentralCatalogConfig）。过滤列：MATERIAL_CODE（可传数组）/ IS_ENABLED；用 {\"IS_ENABLED\":\"Y\"} 取有效目录，判「应集采未集采」（BR2-CENTRAL-01）。" },
      { operation: "queryPoLine", description: "采购订单行（本体 tool_use 名 queryPoLine）。过滤列：ITEM_CODE（可传数组）/ MANAGEMENT_UNIT / IS_CANCELLED；用 {\"IS_CANCELLED\":\"N\"} 取全部后按 CREATION_DATE 倒序每管理单元取最近 3 条算历史均价。" },
      { operation: "queryContract", description: "历史采购合同做供应商与价格参考（本体 tool_use 名 getContractByQuery）。过滤列：CONTRACT_ID / ITEM_CODE / CONTRACT_STATUS；可不带过滤取全表。" },
    ],
  },
  // ⑨警 —— 退回整改（申请人整改后回流复核）
  returnPlanForRectification: { kind: "external", operation: "pushTask", target: "Digital_Employee_Task" },
  // ⑩析 —— 组包推荐
  recommendPackagingScheme: {
    kind: "prompt",
    queries: [
      { operation: "queryAuditThresholdConfig", description: "组包跨度阈值与交付重叠度阈值（BR2-PKG-02/03）。过滤列：RULE_KEY / IS_ENABLED；用 {\"IS_ENABLED\":\"Y\"}。" },
      { operation: "queryPurchaseCategory", description: "品类主数据（本体 inputs 声明 Purchase_Category）。过滤列：CATEGORY_ID（可传数组）/ BUSINESS_TYPE；按品类业务类型判包内是否混有工程/物资/服务（BR2-PKG-01）。" },
    ],
  },
  // ⑪行 —— 框架/集采标注并生成采购包行（框架命中与集采层级在 ERP 写边界内判定）
  annotateFrameAndCentralPurchase: { kind: "external", operation: "createProcPackageLines", target: "Sourcing_Package" },
  // ⑫警 —— 组包预警待办
  raisePackagingComplianceAlert: { kind: "external", operation: "pushTask", target: "Digital_Employee_Task" },
  // ⑬断 —— 计划员确认草稿并选定组包方案
  confirmPlanAndPackage: { kind: "external", operation: "writeOperationLog", target: "Package_Scheme" },
  // ⑭行 —— 提交审批并封存留痕
  submitPlanForApproval: { kind: "external", operation: "submitApproval", target: "Procurement_Plan" },
};

// ── Data Objects ↔ ERP entities (transformation map #1) ──────────────────────
// Every Data Object gets a query op: an object exists only if some decision
// must SEE it, and apps/mock-erp only materialises a table for entities listed
// in `_index.json` — an entity that is written but never listed would make its
// write op fail with "unknown ERP entity".
const OBJECT_MAP = {
  // 场景一（与 hc-procurement 一致）
  Procurement_Plan: { entity: "ss_pbp_header_t", query: "queryOpenPbpHeader" },
  Procurement_Plan_Line: { entity: "ss_pbp_line_t", query: "queryOpenPbpLine" },
  Procurement_Chain: { entity: "emg_procurement_chain_t", query: "queryProcurementChains" },
  Chain_Stage_Progress: { entity: "emg_chain_stage_progress_t", query: "queryChainStageProgress" },
  Purchase_Requisition: { entity: "pr_header_t", query: "queryPr" },
  Sourcing_Package: { entity: "ss_proc_package_header_t", query: "queryProcPackageLineExecuteMode" },
  Inquiry_Notice: { entity: "ss_rfx_header_t", query: "queryRfxList" },
  Bid_Award: { entity: "ss_bid_header_t", query: "queryAwardList" },
  Purchase_Contract: { entity: "clm_contract_t", query: "queryContract" },
  Purchase_Order: { entity: "po_header_t", query: "queryPoHeader" },
  Goods_Acceptance: { entity: "ac_header_t", query: "queryAcceptHeader" },
  Stage_Cycle_Standard: { entity: "cfg_stage_cycle_standard_t", query: "queryStageCycleConfig" },
  Alert_Threshold_Setting: { entity: "cfg_alert_threshold_t", query: "queryAlertThresholdConfig" },
  Execution_Deviation: { entity: "dev_execution_deviation_t", query: "queryExecutionDeviations" },
  Delivery_Probability_Assessment: { entity: "dev_probability_assessment_t", query: "queryProbabilityAssessments" },
  Deviation_Alert: { entity: "dev_deviation_alert_t", query: "queryDeviationAlerts" },
  Adjustment_Option: { entity: "dev_adjustment_option_t", query: "queryAdjustmentOptions" },
  Stock_Transfer_Request: { entity: "inv_transaction_order_t", query: "queryTransactionOrders" },
  Alert_Handling_Record: { entity: "dev_alert_handling_record_t", query: "queryAlertHandlingRecords" },
  Rule_Review_Item: { entity: "dev_rule_review_item_t", query: "queryRuleReviewItems" },
  // 场景二 · ERP 侧真实台账
  Inventory_Onhand_Balance: { entity: "inv_onhand_quantity_t", query: "queryOnhandQuantity" },
  Inventory_Reservation: { entity: "inv_reservation_t", query: "queryReservation" },
  Inventory_MinMax_Level: { entity: "inv_item_min_max_level_t", query: "queryItemMinMaxLevel" },
  Central_Purchase_Catalog: { entity: "cfg_central_purchase_catalog_t", query: "queryCentralCatalogConfig" },
  Audit_Threshold_Setting: { entity: "cfg_audit_threshold_t", query: "queryAuditThresholdConfig" },
  Frame_Agreement: { entity: "ss_spa_header_t", query: "querySpaList" },
  Frame_Agreement_Item: { entity: "ss_spa_line_t", query: "querySpaLine" },
  Purchase_Category: { entity: "cfg_purchase_category_t", query: "queryPurchaseCategory" },
  Sourcing_Package_Line: { entity: "ss_proc_package_line_t", query: "queryProcPackageLines" },
  // 场景二 · 数字员工的决策/作业对象（起始为空，由 agent 写入）
  Demand_Merge_Suggestion: { entity: "de_demand_merge_suggestion_t", query: "queryDemandMergeSuggestions" },
  Stock_Check_Result: { entity: "de_stock_check_result_t", query: "queryStockCheckResults" },
  Backward_Schedule_Plan: { entity: "de_backward_schedule_plan_t", query: "queryBackwardSchedulePlans" },
  Backward_Schedule_Stage: { entity: "de_backward_schedule_stage_t", query: "queryBackwardScheduleStages" },
  Package_Scheme: { entity: "de_package_scheme_t", query: "queryPackageSchemes" },
  Plan_Audit_Opinion: { entity: "de_plan_audit_opinion_t", query: "queryPlanAuditOpinions" },
  Plan_Audit_Finding: { entity: "de_plan_audit_finding_t", query: "queryPlanAuditFindings" },
  Packaging_Compliance_Finding: { entity: "de_packaging_compliance_finding_t", query: "queryPackagingComplianceFindings" },
  Digital_Employee_Task: { entity: "de_digital_employee_task_t", query: "queryDigitalEmployeeTasks" },
  Digital_Employee_Operation_Log: { entity: "de_operation_log_t", query: "queryOperationLogs" },
};

// Read ops with no owning Data Object: ERP ledgers, derived statistics and the
// 场景二 read-shapes of tables 场景一 already owns (queryPbpHeader vs
// queryOpenPbpHeader hit the same table with a different filter contract).
const EXTRA_QUERY_OPS = {
  queryAllPbpLinePage: { entity: "ss_pbp_rel_t", label: "计划头行关系（防止行重复归集）" },
  queryPoLineShipment: { entity: "po_line_shipment_t", label: "订单行发运/到货台账（进度偏差的分子分母）" },
  queryAcceptTransaction: { entity: "ac_transaction_t", label: "验收交易台账" },
  queryHistoricalOnTimeRate: { entity: "stat_historical_on_time_rate_t", label: "同业务类型历史按期达成率统计" },
  queryTransferableStock: { entity: "inv_transferable_stock_t", label: "可调拨库存（方案③的调出库点与可调数量）" },
  queryPbpHeader: { entity: "ss_pbp_header_t", label: "采购业务计划头（场景二：已批准需求计划扫描）" },
  queryPbpLine: { entity: "ss_pbp_line_t", label: "采购业务计划行（场景二：需求合并字段）" },
  queryPoLine: { entity: "po_line_t", label: "采购订单行（历史采购单价基准）" },
};

/**
 * Real MetaERP registrations for the ops above (from the metaerp-openapi-call
 * skill's `reference/ppm-scenario2-apis.md`, 2026-09-04). Documentation for
 * the future real adapter ONLY — `metaerp.invoke` speaks the statement catalog
 * against METAERP_BASE_URL (mock ERP) and nothing here is called. `form`:
 * openapi = IAM token + x-renter-id; ui = portal session (call_uiapi.py);
 * platform = decision/config object with no MetaERP API (lives in AO / the
 * mock's config tables).
 */
const REAL_API_BINDINGS = {
  queryPbpHeader: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryPbpHeader" },
  queryOpenPbpHeader: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryPbpHeader", note: "同 queryPbpHeader，STATUS=已批准过滤" },
  queryPbpLine: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryPbpLine" },
  queryOpenPbpLine: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryPbpLine" },
  queryAllPbpLinePage: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryAllPbpLinePage" },
  queryPr: { form: "openapi", path: "/beta/hpo/mpr/openapi/v1/queryPr" },
  queryProcPackageLineExecuteMode: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryProcPackageLineExecuteMode" },
  queryRfxList: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryRfxList" },
  queryAwardList: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryAwardList" },
  querySpaList: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/querySPAList" },
  querySpaLine: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/querySPAList", note: "协议行随头返回" },
  queryContract: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/queryContract" },
  queryPoHeader: { form: "ui", path: "/beta/gateway/hpo/poquery/services/ui/queryPoService/v1/poHeader/{pageSize}/{curPage}" },
  queryPoLineShipment: { form: "ui", path: "/beta/gateway/hpo/poquery/services/ui/queryPoService/v1/poShipment/{pageSize}/{curPage}" },
  queryPoLine: { form: "openapi", path: "/beta/hpo/mpo/openapi/v1/queryPoLine", note: "注册形态与文档路径不同形，参数需实测" },
  queryAcceptHeader: { form: "openapi", path: "/beta/hpo/mpo/openapi/v1/queryAcceptanceHeader" },
  queryAcceptTransaction: { form: "openapi", path: "/beta/hpo/mpo/openapi/v1/queryAcTransaction" },
  queryOnhandQuantity: { form: "openapi", path: "/beta/hinv/minv/openapi/v1/multiOnhandQuantityQuery" },
  queryReservation: { form: "ui", path: "/beta/gateway/hinv/minv/services/queryReservation", note: "openapi 无注册；最接近的 openapi 为 queryMaterialReservation，未实证" },
  queryItemMinMaxLevel: { form: "ui", path: "/beta/gateway/hinv/minv/services/getPlanItemLevel", note: "openapi 无注册，未实证" },
  createPbp: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/createPbp" },
  createProcPackageLines: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/createProcPackageLines" },
  createTransactionOrder: { form: "openapi", path: "/beta/hinv/minv/openapi/v1/createTransactionOrder" },
  updateTransactionOrder: { form: "openapi", path: "/beta/hinv/minv/openapi/v1/createTransactionOrderFulfill", note: "调拨单状态回传" },
  changePbp: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/changePbp" },
  changePbpLine: { form: "openapi", path: "/beta/hsrm/srm/openapi/v1/changePbp", note: "行变更走 pbpChangeLineReqDTOList" },
};

// ── stub tables for apps/mock-erp ────────────────────────────────────────────
// 场景一 rows are verbatim from stage-hc-procurement-ontology.mjs (one worked
// example: PBP-2026-0873 断路器计划行停在询价 26 天，红色预警链路). 场景二 adds
// a second worked example threaded end to end: 年度需求计划 PBP-2026-1102
// (华东检修分公司, 已批准) with four lines —
//   01/02  M-CT-110 互感器 20+10 台，需求日期相差 15 天 → 可合并（BR2-MERGE-01）；
//          可用量 4 < 30 → 需采购，缺口 26（BR2-STOCK-02）→ 倒排 → 草稿 → 审核 →
//          组包 → 命中框架协议 SPA-2026-0338（BR2-FRAME-01）→ 计划员确认 → 提交审批
//   03     M-BRK-126 断路器 4 台，单行；命中一级集采目录而集采层级未标识 →
//          应集采未集采（BR2-CENTRAL-01 拦截）→ 退回整改
//   04     M-CBL-YJV 电缆 3000 m；现有量 5000 ≥ 最大库存 4000 且非紧急 →
//          可调度（BR2-STOCK-01 硬拦截）→ 调拨申请单
const STUB_TABLES = {
  ss_pbp_header_t: [
    {
      PBP_HEADER_ID: "PBP-2026-0873",
      PLAN_NO: "PBP-2026-0873",
      PLAN_CATEGORY: "执行计划",
      BUSINESS_TYPE: "物资",
      PLAN_TYPE: "大修专项",
      STATUS: "已批准",
      UNIT_CODE: "001",
      MANAGEMENT_UNIT: "华东检修分公司",
      DEMAND_ORGANIZATION: "华东检修分公司",
      PLAN_PERIOD: "2026",
      IS_DELETED: "N",
      PLANNER: "张计划",
      DEPARTMENT_LEADER: "李部长",
      DIVISION_LEADER: "王分管",
      SUBMITTED_AT: "2026-06-20T09:00:00+08:00",
      APPROVED_AT: "2026-06-28T16:30:00+08:00",
    },
    {
      PBP_HEADER_ID: "PBP-2026-0914",
      PLAN_NO: "PBP-2026-0914",
      PLAN_CATEGORY: "执行计划",
      BUSINESS_TYPE: "物资",
      PLAN_TYPE: "年度计划",
      STATUS: "已批准",
      UNIT_CODE: "002",
      MANAGEMENT_UNIT: "华南检修分公司",
      DEMAND_ORGANIZATION: "华南检修分公司",
      PLAN_PERIOD: "2026",
      IS_DELETED: "N",
      PLANNER: "赵计划",
      DEPARTMENT_LEADER: "李部长",
      DIVISION_LEADER: "王分管",
      SUBMITTED_AT: "2026-05-11T09:00:00+08:00",
      APPROVED_AT: "2026-05-19T10:10:00+08:00",
    },
    {
      PBP_HEADER_ID: "PBP-2026-1102",
      PLAN_NO: "PBP-2026-1102",
      PLAN_CATEGORY: "需求计划",
      BUSINESS_TYPE: "物资",
      PLAN_TYPE: "年度计划",
      STATUS: "已批准",
      UNIT_CODE: "001",
      MANAGEMENT_UNIT: "华东检修分公司",
      DEMAND_ORGANIZATION: "华东检修分公司",
      PLAN_PERIOD: "2027",
      IS_DELETED: "N",
      PLANNER: "张计划",
      DEPARTMENT_LEADER: "李部长",
      DIVISION_LEADER: "王分管",
      SUBMITTED_AT: "2026-08-28T09:00:00+08:00",
      APPROVED_AT: "2026-09-05T16:00:00+08:00",
    },
    {
      PBP_HEADER_ID: "PBP-2026-1090",
      PLAN_NO: "PBP-2026-1090",
      PLAN_CATEGORY: "需求计划",
      BUSINESS_TYPE: "物资",
      PLAN_TYPE: "年度计划",
      STATUS: "草稿",
      UNIT_CODE: "001",
      MANAGEMENT_UNIT: "华东检修分公司",
      DEMAND_ORGANIZATION: "华东检修分公司",
      PLAN_PERIOD: "2027",
      IS_DELETED: "N",
      PLANNER: "张计划",
      DEPARTMENT_LEADER: "李部长",
      DIVISION_LEADER: "王分管",
      SUBMITTED_AT: "",
      APPROVED_AT: "",
    },
  ],
  ss_pbp_line_t: [
    {
      PBP_LINE_ID: "PBPL-2026-0873-01",
      PBP_LINE_NUMBER: "1",
      PBP_HEADER_ID: "PBP-2026-0873",
      ITEM_CODE: "M-BRK-126",
      ITEM_NAME: "126kV SF6 断路器",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-BRK",
      QUANTITY: 12,
      UNIT: "台",
      UNIT_PRICE: 380000,
      NEED_BY_DATE: "2026-11-30",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 4560000,
      DEMAND_DEPARTMENT: "检修一部",
      USAGE_SCENARIO: "大修",
      INVENTORY_ORGANIZATION: "ORG-HD",
      RECEIVING_REGION: "华东",
      IS_CANCELLED: "N",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "一级集采",
      ATTACHMENT_COMPLETE: "Y",
    },
    {
      PBP_LINE_ID: "PBPL-2026-0914-03",
      PBP_LINE_NUMBER: "3",
      PBP_HEADER_ID: "PBP-2026-0914",
      ITEM_CODE: "M-CT-110",
      ITEM_NAME: "110kV 电流互感器",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-CT",
      QUANTITY: 30,
      UNIT: "台",
      UNIT_PRICE: 58000,
      NEED_BY_DATE: "2027-01-20",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 1740000,
      DEMAND_DEPARTMENT: "检修二部",
      USAGE_SCENARIO: "生产",
      INVENTORY_ORGANIZATION: "ORG-HN",
      RECEIVING_REGION: "华南",
      IS_CANCELLED: "N",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      ATTACHMENT_COMPLETE: "Y",
    },
    {
      PBP_LINE_ID: "PBPL-2026-1102-01",
      PBP_LINE_NUMBER: "1",
      PBP_HEADER_ID: "PBP-2026-1102",
      ITEM_CODE: "M-CT-110",
      ITEM_NAME: "110kV 电流互感器",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-CT",
      QUANTITY: 20,
      UNIT: "台",
      UNIT_PRICE: 58000,
      NEED_BY_DATE: "2027-03-10",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 1160000,
      DEMAND_DEPARTMENT: "检修一部",
      USAGE_SCENARIO: "生产",
      INVENTORY_ORGANIZATION: "ORG-HD",
      RECEIVING_REGION: "华东",
      IS_CANCELLED: "N",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      ATTACHMENT_COMPLETE: "Y",
    },
    {
      PBP_LINE_ID: "PBPL-2026-1102-02",
      PBP_LINE_NUMBER: "2",
      PBP_HEADER_ID: "PBP-2026-1102",
      ITEM_CODE: "M-CT-110",
      ITEM_NAME: "110kV 电流互感器",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-CT",
      QUANTITY: 10,
      UNIT: "台",
      UNIT_PRICE: 59500,
      NEED_BY_DATE: "2027-03-25",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 595000,
      DEMAND_DEPARTMENT: "检修三部",
      USAGE_SCENARIO: "生产",
      INVENTORY_ORGANIZATION: "ORG-HD",
      RECEIVING_REGION: "华东",
      IS_CANCELLED: "N",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      ATTACHMENT_COMPLETE: "Y",
    },
    {
      PBP_LINE_ID: "PBPL-2026-1102-03",
      PBP_LINE_NUMBER: "3",
      PBP_HEADER_ID: "PBP-2026-1102",
      ITEM_CODE: "M-BRK-126",
      ITEM_NAME: "126kV SF6 断路器",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-BRK",
      QUANTITY: 4,
      UNIT: "台",
      UNIT_PRICE: 385000,
      NEED_BY_DATE: "2027-05-30",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 1540000,
      DEMAND_DEPARTMENT: "检修一部",
      USAGE_SCENARIO: "大修",
      INVENTORY_ORGANIZATION: "ORG-HD",
      RECEIVING_REGION: "华东",
      IS_CANCELLED: "N",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      ATTACHMENT_COMPLETE: "N",
    },
    {
      PBP_LINE_ID: "PBPL-2026-1102-04",
      PBP_LINE_NUMBER: "4",
      PBP_HEADER_ID: "PBP-2026-1102",
      ITEM_CODE: "M-CBL-YJV",
      ITEM_NAME: "YJV22 10kV 电力电缆 3×240",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-CBL",
      QUANTITY: 3000,
      UNIT: "m",
      UNIT_PRICE: 320,
      NEED_BY_DATE: "2027-01-15",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 960000,
      DEMAND_DEPARTMENT: "检修二部",
      USAGE_SCENARIO: "生产",
      INVENTORY_ORGANIZATION: "ORG-HD",
      RECEIVING_REGION: "华东",
      IS_CANCELLED: "N",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      ATTACHMENT_COMPLETE: "Y",
    },
    {
      PBP_LINE_ID: "PBPL-2026-1102-05",
      PBP_LINE_NUMBER: "5",
      PBP_HEADER_ID: "PBP-2026-1102",
      ITEM_CODE: "M-CT-110",
      ITEM_NAME: "110kV 电流互感器",
      PBP_LINE_TYPE_CODE: "物资",
      CATEGORY_ID: "CAT-EL-CT",
      QUANTITY: 6,
      UNIT: "台",
      UNIT_PRICE: 58000,
      NEED_BY_DATE: "2027-03-12",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 348000,
      DEMAND_DEPARTMENT: "检修一部",
      USAGE_SCENARIO: "生产",
      INVENTORY_ORGANIZATION: "ORG-HD",
      RECEIVING_REGION: "华东",
      IS_CANCELLED: "Y",
      IS_DELETED: "N",
      IS_URGENT: "N",
      IS_SPLIT: "N",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      ATTACHMENT_COMPLETE: "Y",
    },
  ],
  ss_pbp_rel_t: [
    { PBP_REL_ID: "REL-0873-01", PBP_HEADER_ID: "PBP-2026-0873", PBP_LINE_ID: "PBPL-2026-0873-01" },
    { PBP_REL_ID: "REL-0914-03", PBP_HEADER_ID: "PBP-2026-0914", PBP_LINE_ID: "PBPL-2026-0914-03" },
  ],
  pr_header_t: [
    {
      PR_HEADER_ID: "PR-2026-11832",
      PR_NUMBER: "PR-2026-11832",
      PR_HEADER_STATUS: "已审批",
      APPROVED_AT: "2026-07-06T11:20:00+08:00",
      ITEM_CODE: "M-BRK-126",
      SOURCE_DOC_HEADER_ID: "PBP-2026-0873",
      SOURCE_DOC_LINE_ID: "PBPL-2026-0873-01",
      DEMAND_DEPARTMENT: "检修一部",
    },
    {
      PR_HEADER_ID: "PR-2026-11907",
      PR_NUMBER: "PR-2026-11907",
      PR_HEADER_STATUS: "已审批",
      APPROVED_AT: "2026-06-02T09:40:00+08:00",
      ITEM_CODE: "M-CT-110",
      SOURCE_DOC_HEADER_ID: "PBP-2026-0914",
      SOURCE_DOC_LINE_ID: "PBPL-2026-0914-03",
      DEMAND_DEPARTMENT: "检修二部",
    },
  ],
  ss_proc_package_header_t: [
    {
      PROC_PACKAGE_HEADER_ID: "PKG-2026-0451",
      PROC_PACKAGE_LINE_ID: "PKGL-2026-0451-01",
      PACKAGE_NO: "PKG-2026-0451",
      PACKAGE_NAME: "断路器大修专项采购包",
      SOURCE_OBJECT_ID: "PR-2026-11832",
      ITEM_CODE: "M-BRK-126",
      STATUS: "有效",
      PURCHASING_GROUP_NO: "PG-HD-01",
      CENTRAL_PURCHASE_LEVEL: "一级集采",
      LAST_UPDATE_DATE: "2026-07-21T15:05:00+08:00",
      EXPECTED_FINISH_SOURCING_DATE: "2026-09-05",
    },
    {
      PROC_PACKAGE_HEADER_ID: "PKG-2026-0488",
      PROC_PACKAGE_LINE_ID: "PKGL-2026-0488-02",
      PACKAGE_NO: "PKG-2026-0488",
      PACKAGE_NAME: "互感器年度采购包",
      SOURCE_OBJECT_ID: "PR-2026-11907",
      ITEM_CODE: "M-CT-110",
      STATUS: "有效",
      PURCHASING_GROUP_NO: "PG-HN-02",
      CENTRAL_PURCHASE_LEVEL: "未标识",
      LAST_UPDATE_DATE: "2026-06-18T10:00:00+08:00",
      EXPECTED_FINISH_SOURCING_DATE: "2026-08-10",
    },
  ],
  ss_proc_package_line_t: [
    {
      PACKAGE_LINE_ID: "PKGL-2026-0488-02",
      PACKAGE_ID: "PKG-2026-0488",
      PLAN_LINE_ID: "PBPL-2026-0914-03",
      SOURCE_OBJECT_TYPE: "PBP_LINE",
      MATERIAL_CODE: "M-CT-110",
      MANAGEMENT_UNIT: "华南检修分公司",
      INVENTORY_ORGANIZATION: "ORG-HN",
      CATEGORY_ID: "CAT-EL-CT",
      QUANTITY: 30,
      REQUIRED_ARRIVAL_DATE: "2027-01-20",
      SOURCING_METHOD: "公开询价",
      PLANNER: "赵计划",
      FRAME_HIT: "N",
    },
  ],
  ss_rfx_header_t: [
    {
      RFX_HEADER_ID: "RFX-2026-0662",
      RFX_NO: "RFX-2026-0662",
      SOURCE_OBJECT_ID: "PKG-2026-0451",
      RFX_STATUS: "激活",
      EFFECTIVE_DATE: "2026-07-29T09:00:00+08:00",
      PUBLISH_DATE: "2026-07-30T09:00:00+08:00",
      CLOSE_BIDDING_DATE: "2026-08-13T17:00:00+08:00",
      REBID_COUNT: 1,
    },
    {
      RFX_HEADER_ID: "RFX-2026-0701",
      RFX_NO: "RFX-2026-0701",
      SOURCE_OBJECT_ID: "PKG-2026-0488",
      RFX_STATUS: "定标完成",
      EFFECTIVE_DATE: "2026-06-25T09:00:00+08:00",
      PUBLISH_DATE: "2026-06-26T09:00:00+08:00",
      CLOSE_BIDDING_DATE: "2026-07-08T17:00:00+08:00",
      REBID_COUNT: 0,
    },
  ],
  // 断路器这一单没有定标行——询价发标后流标重招，至今未中标，这是 26 天滞留的根因。
  ss_bid_header_t: [
    {
      BID_HEADER_ID: "BID-2026-0533",
      RFX_HEADER_ID: "RFX-2026-0701",
      BID_STATUS: "激活",
      AWARD_DATE: "2026-07-14T16:00:00+08:00",
      SUPPLIER_NAME: "华东互感器制造有限公司",
    },
  ],
  // 价格协议 = 框架协议台账（场景一读它做合同前置凭据，场景二读它做框架命中）。
  ss_spa_header_t: [
    {
      SPA_HEADER_ID: "SPA-2026-0338",
      SPA_NUMBER: "SPA-2026-0338",
      AGREEMENT_NO: "SPA-2026-0338",
      SUPPLIER_CODE: "SUP-HD-CT-01",
      SUPPLIER_NAME: "华东互感器制造有限公司",
      AGREEMENT_TYPE: "框架协议",
      MANAGEMENT_UNIT: "华东检修分公司",
      SOURCE_OBJECT_ID: "RFX-2026-0701",
      CONTRACT_ID: "CT-2026-0912",
      EFFECTIVE_DATE: "2026-07-28",
      DISABLE_DATE: "2027-07-27",
      CLOSED_STATUS: "未关闭",
      TOTAL_AMOUNT: 6000000,
      USED_AMOUNT: 1740000,
      AVAILABLE_AMOUNT: 4260000,
      IS_VALID: "Y",
    },
    {
      SPA_HEADER_ID: "SPA-2025-0207",
      SPA_NUMBER: "SPA-2025-0207",
      AGREEMENT_NO: "SPA-2025-0207",
      SUPPLIER_CODE: "SUP-HD-CBL-03",
      SUPPLIER_NAME: "华东电缆集团有限公司",
      AGREEMENT_TYPE: "框架协议",
      MANAGEMENT_UNIT: "华东检修分公司",
      SOURCE_OBJECT_ID: "RFX-2025-0311",
      CONTRACT_ID: "CT-2025-0640",
      EFFECTIVE_DATE: "2025-05-01",
      DISABLE_DATE: "2026-04-30",
      CLOSED_STATUS: "已关闭",
      TOTAL_AMOUNT: 2000000,
      USED_AMOUNT: 1980000,
      AVAILABLE_AMOUNT: 20000,
      IS_VALID: "N",
    },
  ],
  ss_spa_line_t: [
    {
      SPA_LINE_ID: "SPAL-2026-0338-01",
      SPA_HEADER_ID: "SPA-2026-0338",
      MATERIAL_CODE: "M-CT-110",
      CATEGORY_ID: "CAT-EL-CT",
      AGREEMENT_PRICE: 56500,
      AGREEMENT_QUANTITY: 100,
    },
    {
      SPA_LINE_ID: "SPAL-2025-0207-01",
      SPA_HEADER_ID: "SPA-2025-0207",
      MATERIAL_CODE: "M-CBL-YJV",
      CATEGORY_ID: "CAT-EL-CBL",
      AGREEMENT_PRICE: 310,
      AGREEMENT_QUANTITY: 6000,
    },
  ],
  clm_contract_t: [
    {
      CONTRACT_ID: "CT-2026-0912",
      CONTRACT_NO: "CT-2026-0912",
      AWARD_ID: "BID-2026-0533",
      SPA_NUMBER: "SPA-2026-0338",
      CONTRACT_STATUS: "已生效",
      SIGNING_STATUS: "已签署",
      SIGNING_DATE: "2026-07-25T14:00:00+08:00",
      EFFECTIVE_DATE: "2026-07-28T00:00:00+08:00",
      SUPPLIER_NAME: "华东互感器制造有限公司",
      ITEM_CODE: "M-CT-110",
      CONTRACT_AMOUNT: 1740000,
    },
  ],
  po_header_t: [
    {
      PO_HEADER_ID: "PO-2026-20487",
      PO_NUMBER: "PO-2026-20487",
      CONTRACT_ID: "CT-2026-0912",
      SOURCE_DOC_HEADER_ID: "PR-2026-11907",
      SUPPLIER_NAME: "华东互感器制造有限公司",
      APPROVAL_STATUS: "已审批",
      APPROVED_DATE: "2026-08-03T10:30:00+08:00",
      EFFECTIVE_DATE: "2026-08-05T00:00:00+08:00",
      INCURRED_AMOUNT: 1740000,
    },
  ],
  po_line_t: [
    { PO_LINE_ID: "POL-2026-20487-01", PO_HEADER_ID: "PO-2026-20487", ITEM_CODE: "M-CT-110", UNIT_CODE: "001", MANAGEMENT_UNIT: "华东检修分公司", UNIT_PRICE: 57500, QUANTITY: 30, CREATION_DATE: "2026-08-03", IS_CANCELLED: "N" },
    { PO_LINE_ID: "POL-2026-19902-02", PO_HEADER_ID: "PO-2026-19902", ITEM_CODE: "M-CT-110", UNIT_CODE: "001", MANAGEMENT_UNIT: "华东检修分公司", UNIT_PRICE: 56000, QUANTITY: 12, CREATION_DATE: "2026-05-14", IS_CANCELLED: "N" },
    { PO_LINE_ID: "POL-2026-18771-01", PO_HEADER_ID: "PO-2026-18771", ITEM_CODE: "M-CT-110", UNIT_CODE: "001", MANAGEMENT_UNIT: "华东检修分公司", UNIT_PRICE: 55000, QUANTITY: 20, CREATION_DATE: "2026-02-09", IS_CANCELLED: "N" },
    { PO_LINE_ID: "POL-2026-19310-03", PO_HEADER_ID: "PO-2026-19310", ITEM_CODE: "M-BRK-126", UNIT_CODE: "001", MANAGEMENT_UNIT: "华东检修分公司", UNIT_PRICE: 372000, QUANTITY: 6, CREATION_DATE: "2026-03-30", IS_CANCELLED: "N" },
    { PO_LINE_ID: "POL-2025-17206-01", PO_HEADER_ID: "PO-2025-17206", ITEM_CODE: "M-BRK-126", UNIT_CODE: "001", MANAGEMENT_UNIT: "华东检修分公司", UNIT_PRICE: 365000, QUANTITY: 8, CREATION_DATE: "2025-11-12", IS_CANCELLED: "N" },
    { PO_LINE_ID: "POL-2026-19044-02", PO_HEADER_ID: "PO-2026-19044", ITEM_CODE: "M-CBL-YJV", UNIT_CODE: "001", MANAGEMENT_UNIT: "华东检修分公司", UNIT_PRICE: 315, QUANTITY: 4000, CREATION_DATE: "2026-03-02", IS_CANCELLED: "N" },
  ],
  po_line_shipment_t: [
    {
      PO_LINE_SHIPMENT_ID: "POS-2026-20487-01",
      PO_HEADER_ID: "PO-2026-20487",
      ITEM_CODE: "M-CT-110",
      QUANTITY: 30,
      RECEIVED_QUANTITY: 18,
      NEED_BY_DATE: "2026-12-20",
    },
  ],
  ac_header_t: [
    {
      AC_HEADER_ID: "AC-2026-7741",
      ACCEPTANCE_NO: "AC-2026-7741",
      SOURCE_DOC_HEADER_ID: "PO-2026-20487",
      APPROVAL_STATUS: "已审批",
      RECEIVED_QUANTITY: 18,
      ACCEPTANCE_RESULT: "部分接收",
      ACCEPTED_AT: "2026-08-19T15:20:00+08:00",
    },
  ],
  ac_transaction_t: [
    {
      AC_TRANSACTION_ID: "ACT-2026-8890",
      AC_HEADER_ID: "AC-2026-7741",
      TRANSACTION_TYPE: "正常验收",
      TRANSACTION_DATE: "2026-08-19T15:20:00+08:00",
      RECEIVED_QUANTITY: 18,
    },
  ],
  // 七节点标准周期：物资合计 155 天，从需求到货日期倒排；MIN_CYCLE_DAYS 供紧急采购绿色通道（BR2-SCHED-02）。
  cfg_stage_cycle_standard_t: [
    { CYCLE_STANDARD_ID: "CYC-WZ-1", BUSINESS_TYPE: "物资", STAGE_NODE: "立项", STAGE_SEQUENCE: 1, STANDARD_CYCLE_DAYS: 10, MIN_CYCLE_DAYS: 5, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-WZ-2", BUSINESS_TYPE: "物资", STAGE_NODE: "组包", STAGE_SEQUENCE: 2, STANDARD_CYCLE_DAYS: 15, MIN_CYCLE_DAYS: 7, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-WZ-3", BUSINESS_TYPE: "物资", STAGE_NODE: "询价", STAGE_SEQUENCE: 3, STANDARD_CYCLE_DAYS: 20, MIN_CYCLE_DAYS: 10, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-WZ-4", BUSINESS_TYPE: "物资", STAGE_NODE: "定标", STAGE_SEQUENCE: 4, STANDARD_CYCLE_DAYS: 15, MIN_CYCLE_DAYS: 7, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-WZ-5", BUSINESS_TYPE: "物资", STAGE_NODE: "合同", STAGE_SEQUENCE: 5, STANDARD_CYCLE_DAYS: 15, MIN_CYCLE_DAYS: 7, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-WZ-6", BUSINESS_TYPE: "物资", STAGE_NODE: "订单", STAGE_SEQUENCE: 6, STANDARD_CYCLE_DAYS: 10, MIN_CYCLE_DAYS: 5, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-WZ-7", BUSINESS_TYPE: "物资", STAGE_NODE: "到货", STAGE_SEQUENCE: 7, STANDARD_CYCLE_DAYS: 70, MIN_CYCLE_DAYS: 45, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-1", BUSINESS_TYPE: "工程", STAGE_NODE: "立项", STAGE_SEQUENCE: 1, STANDARD_CYCLE_DAYS: 15, MIN_CYCLE_DAYS: 7, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-2", BUSINESS_TYPE: "工程", STAGE_NODE: "组包", STAGE_SEQUENCE: 2, STANDARD_CYCLE_DAYS: 20, MIN_CYCLE_DAYS: 10, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-3", BUSINESS_TYPE: "工程", STAGE_NODE: "询价", STAGE_SEQUENCE: 3, STANDARD_CYCLE_DAYS: 25, MIN_CYCLE_DAYS: 12, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-4", BUSINESS_TYPE: "工程", STAGE_NODE: "定标", STAGE_SEQUENCE: 4, STANDARD_CYCLE_DAYS: 20, MIN_CYCLE_DAYS: 10, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-5", BUSINESS_TYPE: "工程", STAGE_NODE: "合同", STAGE_SEQUENCE: 5, STANDARD_CYCLE_DAYS: 20, MIN_CYCLE_DAYS: 10, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-6", BUSINESS_TYPE: "工程", STAGE_NODE: "订单", STAGE_SEQUENCE: 6, STANDARD_CYCLE_DAYS: 15, MIN_CYCLE_DAYS: 7, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
    { CYCLE_STANDARD_ID: "CYC-GC-7", BUSINESS_TYPE: "工程", STAGE_NODE: "到货", STAGE_SEQUENCE: 7, STANDARD_CYCLE_DAYS: 90, MIN_CYCLE_DAYS: 60, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31" },
  ],
  // BR-DEV-02：判定阈值必须取自配置，不得在规则或代码里写死。阈值 0 = 超期即预警。
  cfg_alert_threshold_t: [
    { THRESHOLD_ID: "TH-TIME-0D", THRESHOLD_CODE: "时间偏差天数", THRESHOLD_NAME: "时间偏差判定阈值（超期即预警）", THRESHOLD_VALUE: 0, UNIT: "天", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
    { THRESHOLD_ID: "TH-SCHED-20", THRESHOLD_CODE: "进度偏差比例", THRESHOLD_NAME: "进度偏差判定阈值", THRESHOLD_VALUE: 0.2, UNIT: "比例", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
    { THRESHOLD_ID: "TH-PROB-RED", THRESHOLD_CODE: "红色概率上限", THRESHOLD_NAME: "红色分级概率上限", THRESHOLD_VALUE: 0.6, UNIT: "比例", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
    { THRESHOLD_ID: "TH-PROB-YELLOW", THRESHOLD_CODE: "黄色概率下限", THRESHOLD_NAME: "黄色分级概率下限", THRESHOLD_VALUE: 0.85, UNIT: "比例", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
  ],
  // BR2-THRESH-01：审核与组包的阈值必须来自这张表（与场景一的预警阈值各管各的）。
  cfg_audit_threshold_t: [
    { AUDIT_THRESHOLD_ID: "ATH-PRICE-SOFT", RULE_KEY: "price_deviation_soft", RULE_NAME: "价格偏差软预警阈值", THRESHOLD_VALUE: 0.2, ALERT_LEVEL: "软预警", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-PRICE-ESC", RULE_KEY: "price_deviation_escalate", RULE_NAME: "价格偏差升级阈值", THRESHOLD_VALUE: 0.5, ALERT_LEVEL: "升级", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-DUP-WINDOW", RULE_KEY: "duplicate_window_days", RULE_NAME: "重复申报查重窗口", THRESHOLD_VALUE: 30, ALERT_LEVEL: "软预警", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-MERGE-GAP", RULE_KEY: "merge_date_gap_days", RULE_NAME: "需求合并日期差上限", THRESHOLD_VALUE: 30, ALERT_LEVEL: "提示", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-SPLIT-GAP", RULE_KEY: "split_date_gap_days", RULE_NAME: "需求拆分日期差下限", THRESHOLD_VALUE: 60, ALERT_LEVEL: "提示", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-PKG-SPAN", RULE_KEY: "delivery_span_days", RULE_NAME: "组包交货跨度上限", THRESHOLD_VALUE: 90, ALERT_LEVEL: "拆包建议", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-PKG-OVERLAP", RULE_KEY: "delivery_overlap_rate", RULE_NAME: "交付周期重叠度下限", THRESHOLD_VALUE: 0.7, ALERT_LEVEL: "提示", EXEMPTION: "", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
    { AUDIT_THRESHOLD_ID: "ATH-PRICE-OLD", RULE_KEY: "price_deviation_soft", RULE_NAME: "价格偏差软预警阈值（旧）", THRESHOLD_VALUE: 0.3, ALERT_LEVEL: "软预警", EXEMPTION: "", EFFECTIVE_DATE: "2025-01-01", DISABLE_DATE: "2025-12-31", IS_ENABLED: "N", MANAGEMENT_UNIT: "全集团", MAINTAINER: "集采管理岗" },
  ],
  // 集采目录：断路器与电缆必须走集采；互感器不在目录内。
  cfg_central_purchase_catalog_t: [
    { CATALOG_ID: "CPC-0001", MATERIAL_CODE: "M-BRK-126", MATERIAL_NAME: "126kV SF6 断路器", CATEGORY_ID: "CAT-EL-BRK", CENTRAL_LEVEL: "一级集采", CENTRAL_PATTERN: "集团统谈统签", APPROVE_FLOW_CODE: "FLOW-GRP-L1", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "全集团", TENANT_ID: "T-HD", MAINTAINER: "集采管理岗" },
    { CATALOG_ID: "CPC-0002", MATERIAL_CODE: "M-CBL-YJV", MATERIAL_NAME: "YJV22 10kV 电力电缆 3×240", CATEGORY_ID: "CAT-EL-CBL", CENTRAL_LEVEL: "二级集采", CENTRAL_PATTERN: "分公司集中采购", APPROVE_FLOW_CODE: "FLOW-BU-L2", EFFECTIVE_DATE: "2026-01-01", DISABLE_DATE: "2099-12-31", IS_ENABLED: "Y", MANAGEMENT_UNIT: "华东检修分公司", TENANT_ID: "T-HD", MAINTAINER: "集采管理岗" },
    { CATALOG_ID: "CPC-0003", MATERIAL_CODE: "M-CT-110", MATERIAL_NAME: "110kV 电流互感器", CATEGORY_ID: "CAT-EL-CT", CENTRAL_LEVEL: "二级集采", CENTRAL_PATTERN: "分公司集中采购", APPROVE_FLOW_CODE: "FLOW-BU-L2", EFFECTIVE_DATE: "2024-01-01", DISABLE_DATE: "2025-06-30", IS_ENABLED: "N", MANAGEMENT_UNIT: "华东检修分公司", TENANT_ID: "T-HD", MAINTAINER: "集采管理岗" },
  ],
  cfg_purchase_category_t: [
    { CATEGORY_ID: "CAT-EL-CT", CATEGORY_USAGE_ID: "PU-CT", CATEGORY_PATH: "电气设备/一次设备/互感器", BUSINESS_TYPE: "物资", DIMENSION_TYPE: "采购品类", IS_ENABLED: "Y" },
    { CATEGORY_ID: "CAT-EL-BRK", CATEGORY_USAGE_ID: "PU-BRK", CATEGORY_PATH: "电气设备/一次设备/断路器", BUSINESS_TYPE: "物资", DIMENSION_TYPE: "采购品类", IS_ENABLED: "Y" },
    { CATEGORY_ID: "CAT-EL-CBL", CATEGORY_USAGE_ID: "PU-CBL", CATEGORY_PATH: "电气设备/线缆/电力电缆", BUSINESS_TYPE: "物资", DIMENSION_TYPE: "采购品类", IS_ENABLED: "Y" },
    { CATEGORY_ID: "CAT-SVC-TEST", CATEGORY_USAGE_ID: "PU-TEST", CATEGORY_PATH: "服务/检测试验/预防性试验", BUSINESS_TYPE: "服务", DIMENSION_TYPE: "采购品类", IS_ENABLED: "Y" },
  ],
  inv_onhand_quantity_t: [
    { ONHAND_BALANCE_ID: "OH-HD-CT-01", MATERIAL_CODE: "M-CT-110", INVENTORY_ORGANIZATION: "ORG-HD", STOREHOUSE_CODE: "WH-HD-02", ONHAND_QUANTITY: 6, PRIMARY_UOM: "台", INVENTORY_STATUS: "合格", SNAPSHOT_AT: "2026-09-07T06:00:00+08:00" },
    { ONHAND_BALANCE_ID: "OH-HD-CT-02", MATERIAL_CODE: "M-CT-110", INVENTORY_ORGANIZATION: "ORG-HD", STOREHOUSE_CODE: "WH-HD-02", ONHAND_QUANTITY: 3, PRIMARY_UOM: "台", INVENTORY_STATUS: "待检", SNAPSHOT_AT: "2026-09-07T06:00:00+08:00" },
    { ONHAND_BALANCE_ID: "OH-HD-CBL-01", MATERIAL_CODE: "M-CBL-YJV", INVENTORY_ORGANIZATION: "ORG-HD", STOREHOUSE_CODE: "WH-HD-02", ONHAND_QUANTITY: 5000, PRIMARY_UOM: "m", INVENTORY_STATUS: "合格", SNAPSHOT_AT: "2026-09-07T06:00:00+08:00" },
    { ONHAND_BALANCE_ID: "OH-HB-CBL-01", MATERIAL_CODE: "M-CBL-YJV", INVENTORY_ORGANIZATION: "ORG-HB", STOREHOUSE_CODE: "WH-HB-01", ONHAND_QUANTITY: 1200, PRIMARY_UOM: "m", INVENTORY_STATUS: "合格", SNAPSHOT_AT: "2026-09-07T06:00:00+08:00" },
    { ONHAND_BALANCE_ID: "OH-HD-BRK-01", MATERIAL_CODE: "M-BRK-126", INVENTORY_ORGANIZATION: "ORG-HD", STOREHOUSE_CODE: "WH-HD-02", ONHAND_QUANTITY: 0, PRIMARY_UOM: "台", INVENTORY_STATUS: "合格", SNAPSHOT_AT: "2026-09-07T06:00:00+08:00" },
  ],
  inv_reservation_t: [
    { RESERVATION_RECORD_ID: "RSV-HD-CT-01", MATERIAL_CODE: "M-CT-110", INVENTORY_ORGANIZATION: "ORG-HD", RESERVED_PRIMARY_QUANTITY: 2, RESERVATION_QUANTITY: 2, REQUIRED_DATE: "2026-10-15" },
    { RESERVATION_RECORD_ID: "RSV-HD-CBL-01", MATERIAL_CODE: "M-CBL-YJV", INVENTORY_ORGANIZATION: "ORG-HD", RESERVED_PRIMARY_QUANTITY: 500, RESERVATION_QUANTITY: 500, REQUIRED_DATE: "2026-11-01" },
  ],
  inv_item_min_max_level_t: [
    { MIN_MAX_LEVEL_ID: "MML-HD-CT", MATERIAL_CODE: "M-CT-110", INVENTORY_ORGANIZATION: "ORG-HD", MAX_STOCK_QUANTITY: 40, SAFETY_STOCK_QUANTITY: 4, IS_ENABLED: "Y", MAINTAINER: "库存计划员" },
    { MIN_MAX_LEVEL_ID: "MML-HD-CBL", MATERIAL_CODE: "M-CBL-YJV", INVENTORY_ORGANIZATION: "ORG-HD", MAX_STOCK_QUANTITY: 4000, SAFETY_STOCK_QUANTITY: 800, IS_ENABLED: "Y", MAINTAINER: "库存计划员" },
    { MIN_MAX_LEVEL_ID: "MML-HD-BRK", MATERIAL_CODE: "M-BRK-126", INVENTORY_ORGANIZATION: "ORG-HD", MAX_STOCK_QUANTITY: 6, SAFETY_STOCK_QUANTITY: 1, IS_ENABLED: "Y", MAINTAINER: "库存计划员" },
  ],
  stat_historical_on_time_rate_t: [
    { STAT_ID: "STAT-WZ-BRK", BUSINESS_TYPE: "物资", ITEM_CATEGORY: "断路器", STAGE_NODE: "询价", ON_TIME_RATE: 0.62, SAMPLE_SIZE: 18, WINDOW: "近 24 个月" },
    { STAT_ID: "STAT-WZ-CT", BUSINESS_TYPE: "物资", ITEM_CATEGORY: "互感器", STAGE_NODE: "订单", ON_TIME_RATE: 0.81, SAMPLE_SIZE: 34, WINDOW: "近 24 个月" },
    { STAT_ID: "STAT-WZ-ALL", BUSINESS_TYPE: "物资", ITEM_CATEGORY: "全部", STAGE_NODE: "全部", ON_TIME_RATE: 0.74, SAMPLE_SIZE: 126, WINDOW: "近 24 个月" },
  ],
  inv_transferable_stock_t: [
    { STOCK_ID: "TS-001", ITEM_CODE: "M-BRK-126", WAREHOUSE_ID: "WH-HD-02", WAREHOUSE_NAME: "华东中心库", AVAILABLE_QTY: 5, UNIT: "台", TRANSFER_LEAD_DAYS: 7 },
    { STOCK_ID: "TS-002", ITEM_CODE: "M-BRK-126", WAREHOUSE_ID: "WH-HB-01", WAREHOUSE_NAME: "华北中心库", AVAILABLE_QTY: 9, UNIT: "台", TRANSFER_LEAD_DAYS: 12 },
    { STOCK_ID: "TS-003", ITEM_CODE: "M-CT-110", WAREHOUSE_ID: "WH-HD-02", WAREHOUSE_NAME: "华东中心库", AVAILABLE_QTY: 22, UNIT: "台", TRANSFER_LEAD_DAYS: 5 },
  ],
  // 以下为本域自有的决策/处置/作业对象，起始为空，由 agent 写入。
  emg_procurement_chain_t: [],
  emg_chain_stage_progress_t: [],
  dev_execution_deviation_t: [],
  dev_probability_assessment_t: [],
  dev_deviation_alert_t: [],
  dev_adjustment_option_t: [],
  inv_transaction_order_t: [],
  dev_alert_handling_record_t: [],
  dev_rule_review_item_t: [],
  de_demand_merge_suggestion_t: [],
  de_stock_check_result_t: [],
  de_backward_schedule_plan_t: [],
  de_backward_schedule_stage_t: [],
  de_package_scheme_t: [],
  de_plan_audit_opinion_t: [],
  de_plan_audit_finding_t: [],
  de_packaging_compliance_finding_t: [],
  de_digital_employee_task_t: [],
  de_operation_log_t: [],
};

/**
 * Guard bindings promoted to `precondition` so the compiler turns them into a
 * real entry gate. Listed per action so the deviation from the authored phase
 * stays visible (see stage-hc-procurement-ontology.mjs for the BR-ALERT-03
 * rationale: without it red/yellow alerts would open a 计划员自行处置 task).
 */
const GUARD_AS_PRECONDITION = {
  handleBlueAlertLocally: ["BR-ALERT-03"],
};

/**
 * Precondition bindings DEMOTED to a non-gate phase. The compiler compiles
 * every `precondition && mandatory` binding of an external action into an
 * entry gate that must already hold on the trigger event — which is exactly
 * wrong for these two, and listing them here is what keeps the deviation
 * reviewable (the original phase is kept as `studio_phase`):
 *
 *  - splitOversizedDemand · BR2-HITL-01「未经计划员确认不得提交」— the planner
 *    confirmation this rule asks for is COLLECTED BY this action's own manual
 *    step (confirmSplitByPlanner). Gating on it beforehand deadlocks the branch
 *    on its first run. The rule still holds: the write step depends on the
 *    manual step, so nothing is written without the confirmation.
 *  - generateExecutionPlanDraft · BR2-MERGE-04「未写入来源映射不得生成合并计划」
 *    — the source mapping is WRITTEN BY this action's createPbp call. It is a
 *    contract on the write, not on the trigger; apps/mock-erp enforces it at
 *    that boundary (createPbp refuses a merged draft with no source lines).
 */
const PRECONDITION_DEMOTIONS = {
  splitOversizedDemand: { "BR2-HITL-01": "approval" },
  generateExecutionPlanDraft: { "BR2-MERGE-04": "postcondition" },
};

/**
 * Manual `action_steps` the ontology declares but should not — C-06 / C-07 /
 * C-08 in docs/hc-procurement-ontology-corrections.md are still present in
 * 0.1.8 (verified against the archive), plus one 场景二 sibling of C-08:
 *
 *  - confirmPlanAndPackage.captureRejectionReason asks the SAME 计划员, one
 *    screen after confirmByPlanner, for the reason of a rejection that step
 *    already recorded. The reason is a field on the confirm form instead
 *    (required when decision=rejected, BR2-FEEDBACK-01), so one decision is
 *    one click. Remove these entries once the ontology JSON itself is fixed —
 *    projectActionSteps fails loudly if a listed step no longer exists.
 */
const DROP_MANUAL_STEPS = {
  approveAdjustmentOption: ["reviewOptions", "confirmHighRisk"],
  closeDeviationHandling: ["collectVerification"],
  compressDownstreamCycle: ["confirmByPlanner"],
  adjustRequiredArrivalDate: ["confirmByPlanner"],
  createStockTransferRequest: ["confirmByPlanner"],
  confirmPlanAndPackage: ["captureRejectionReason"],
};

const PARALLEL_LINE = (ops) =>
  `【并发取数（硬性）】本步的查询彼此独立、没有先后依赖，请在**同一轮**里一次性发出全部 metaerp.invoke 调用：${ops.join("、")}。运行时支持一轮多调用；串行来回会把这一步拖成十几分钟。`;

/**
 * 取数协议：写进 action.description（编译进 action_prompt 的步骤区），不是
 * output_contracts——实测模型会把放在字段说明里的协议当成「一个要输出的字段」照抄。
 */
const PROMPT_PREAMBLE = {
  collectChainExecutionData: [
    "",
    "【取数步骤（在产出 JSON 之前必须先按此执行）】",
    "",
    "第 0 步 · 定范围：看触发事件负载有没有 plan_id 或 plan_no。有就**只处理这一个计划**——",
    "调用 queryOpenPbpHeader 时必须带过滤条件 {\"PBP_HEADER_ID\": \"<该值>\"}，不得拉全量再自己筛。",
    "没有才按 BR-COV-01 处理全部状态=已批准且在途的计划（PLAN_CATEGORY=需求计划 的行是场景二的需求计划，",
    "尚未进入采购执行链路，本链路只盯 PLAN_CATEGORY=执行计划 的在途计划）。",
    "",
    "第 1 步 · 寻源段（7 个调用，必发，**同一轮一次性并发全部发出**，不要一个一个串行）：",
    "queryOpenPbpHeader、queryOpenPbpLine、queryAllPbpLinePage、queryPr、",
    "queryProcPackageLineExecuteMode、queryRfxList、queryAwardList",
    "拿到结果后判定每条链路的 立项 / 组包 / 询价 / 定标 四个节点是否完成。",
    "",
    "第 2 步 · 早停判据：链路是严格串行的——价格协议、合同、订单、验收全部是定标的下游，",
    "没有定标就一定没有它们。**只有当范围内至少一条链路的定标节点已完成**",
    "（queryAwardList 查到其询价单对应的定标行且有 AWARD_DATE）时，才允许进入第 3 步。",
    "若范围内所有链路都停在定标或更早：**立即停止取数，禁止发出执行段那 6 个调用中的任何一个**，",
    "把停滞节点及其之后的所有节点写成 stage_status='未开始'、actual_finish_date=null，",
    "该链路的 stalled_at 填停滞节点名，query_rounds_used 填 1，然后直接产出 JSON。",
    "",
    "第 3 步 · 执行段（6 个调用，仅在第 2 步放行时发，同样一轮并发全发）：",
    "querySpaList、queryContract、queryPoHeader、queryPoLineShipment、",
    "queryAcceptHeader、queryAcceptTransaction",
    "此时 query_rounds_used 填 2。",
  ].join("\n"),
  scanApprovedDemandPlan: [
    "",
    "【取数步骤（在产出 JSON 之前必须先按此执行）】",
    "",
    "第 0 步 · 锚定扫描日：scan_date 只取触发事件负载里的值，原样照抄；后续所有日期差、查重窗口、",
    "倒排「当前日期」都以它为准，禁止用系统当下时间。",
    "",
    "【过滤纪律】metaerp.invoke 的 payload 是按返回行的列名精确匹配（列名为大写下划线，如 MATERIAL_CODE；值可为数组=IN）；",
    "不确定列名就不带过滤、取全表后在推理里筛，不要自造 *_LIST / *Id 之类的入参名——自造的键会匹配不到任何行。",
    "",
    "第 1 步 · 两个调用**同一轮并发发出**：queryPbpHeader 带过滤 {\"STATUS\":\"已批准\",\"IS_DELETED\":\"N\"}；",
    "queryPbpLine 拉全部计划行。若事件带 plan_id，两个调用都只处理该计划（queryPbpLine 带 {\"PBP_HEADER_ID\":\"<plan_id>\"}）。",
    "",
    "第 2 步 · 圈范围（BR2-SCAN-01）：只保留 计划头 STATUS=已批准 且 PLAN_CATEGORY=需求计划、",
    "行 IS_CANCELLED=N 且 IS_DELETED=N 的计划行；被过滤掉的行计入 filtered_line_count，命中的计入 in_scope_line_count。",
    "PLAN_CATEGORY=执行计划 的头是场景一盯防的在途执行计划，不是本轮要合并的需求计划，不纳入。",
    "",
    "第 3 步 · 留痕：operation_log 写清扫描范围、命中条数、过滤条数（BR2-AUDIT-01 四要素：角色、时间、依据、结论）。",
  ].join("\n"),
  verifyInventoryAvailability: [
    "",
    "【取数步骤（在产出 JSON 之前必须先按此执行）】",
    "",
    "【过滤纪律】payload 按返回行的列名精确匹配（大写下划线，如 MATERIAL_CODE，值可为数组=IN）；不要自造 *_LIST 之类的入参名。",
    "三个调用**同一轮并发发出**：queryOnhandQuantity {\"INVENTORY_STATUS\":\"合格\"}、queryReservation（不带过滤）、queryItemMinMaxLevel {\"IS_ENABLED\":\"Y\"}，",
    "拿到全表后按 MATERIAL_CODE + INVENTORY_ORGANIZATION 在推理里汇总。",
    "汇总口径：现有量只计 INVENTORY_STATUS=合格 的行（待检/不合格/冻结不计）；可用量 = 现有量合计 − 已预留量合计；",
    "水位只取 IS_ENABLED=Y。每条待校验需求（合并组或单行）各出一条 Stock_Check_Result。",
    "判定（BR2-STOCK-01~03）：现有量合计 ≥ 最大库存且 is_urgent_demand=false → 可调度（硬拦截，不建采购计划，转调拨）；",
    "可用量 < 需求数量 → 需采购，缺口 = 需求数量 − 可用量；总量够但 现有量 − 安全库存 < 需求数量 → 触及安全库存。",
    "建议采购批量 = 缺口量 + 安全库存回补量。",
  ].join("\n"),
  auditAnnualPlanCompliance: [
    "",
    "【取数步骤（在产出 JSON 之前必须先按此执行）】",
    "",
    "【过滤纪律】payload 按返回行的列名精确匹配（大写下划线，值可为数组=IN）；不要自造入参名。",
    "四个调用**同一轮并发发出**：queryAuditThresholdConfig {\"IS_ENABLED\":\"Y\"}、queryCentralCatalogConfig {\"IS_ENABLED\":\"Y\"}、",
    "queryPoLine {\"IS_CANCELLED\":\"N\"}（按 CREATION_DATE 倒序每管理单元取最近 3 条同物料行）、queryContract（不带过滤）。",
    "四类校验并行做完再汇总（BR2-CENTRAL-01 / BR2-PRICE-01~03 / BR2-DUP-01 / BR2-ATTACH-01），阈值一律取自配置表（BR2-THRESH-01）。",
    "价格偏差率 = (本次预估单价 − 历史均价) / 历史均价；含价格预警时必须附按管理单元划分的历史价格曲线（BR2-PRICE-03）。",
    "只要有任一硬拦截项（应集采未集采、技术附件缺失）就置 intercept=true，不进入组包。",
  ].join("\n"),
  recommendPackagingScheme: [
    "",
    "【取数步骤（在产出 JSON 之前必须先按此执行）】",
    "",
    "两个调用**同一轮并发发出**：queryAuditThresholdConfig {\"IS_ENABLED\":\"Y\"}（组包跨度与重叠度阈值，BR2-THRESH-01）、queryPurchaseCategory（不带过滤，品类业务类型）。",
    "【过滤纪律】payload 按返回行的列名精确匹配（大写下划线，值可为数组=IN）；不要自造入参名。",
    "至少给出 2 套、至多 3 套方案（BR2-PKG-04：不足两套不推送）；类型混包为硬拦截（BR2-PKG-01）；",
    "交货跨度超阈值给拆包建议（BR2-PKG-03）；同地域且重叠度达标优先合并（BR2-PKG-02）。",
  ].join("\n"),
};

// ── helpers ──────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`[stage-procurement-hc-formal] ${message}`);
  process.exit(1);
}

/** Deterministic JSON: recursively sorted object keys, 2-space indent, trailing NL. */
function stableJson(value) {
  const sortKeys = (node) => {
    if (Array.isArray(node)) return node.map(sortKeys);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.keys(node)
          .sort((a, b) => a.localeCompare(b, "en"))
          .map((key) => [key, sortKeys(node[key])]),
      );
    }
    return node;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stableJson(value), "utf8");
}

const catalogPath = (operation) => `${CATALOG_BASE}/${operation}`;

/**
 * Read the immutable archive and verify it is the file its sidecar manifest
 * describes. The archive is hash-bound: a staged projection of a package that
 * does not match its own digest would be a projection of nothing.
 */
function readArchive(sourceFile) {
  let bytes;
  try {
    bytes = readFileSync(sourceFile);
  } catch (error) {
    fail(`cannot read ${sourceFile}: ${error.message}`);
  }
  const sidecarPath = path.join(path.dirname(sourceFile), "manifest.json");
  let sidecar = null;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    sidecar = null;
  }
  if (sidecar) {
    const sha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (sidecar.file?.sha256 && sidecar.file.sha256 !== sha) {
      fail(`${sourceFile} sha256 ${sha} does not match manifest.json file.sha256 ${sidecar.file.sha256}`);
    }
  }
  const archive = JSON.parse(bytes.toString("utf8"));
  const manifest = archive.manifest;
  if (!manifest || !archive.artifacts) fail(`${sourceFile} is not an ontology package archive (missing manifest/artifacts)`);
  if (manifest.package_id !== DOMAIN) {
    fail(`archive package_id "${manifest.package_id}" is not "${DOMAIN}" — this stage script is bound to one package`);
  }
  if (sidecar?.package_digest && sidecar.package_digest !== manifest.package_hash) {
    fail(`manifest.json package_digest ${sidecar.package_digest} != manifest.package_hash ${manifest.package_hash}`);
  }
  for (const family of ["actions", "events", "objects", "rules", "workflows", "links"]) {
    if (!Array.isArray(archive.artifacts[family])) fail(`artifacts.${family} must be an array`);
  }
  return archive;
}

/**
 * The ontology's actor vocabulary is Agent | Human | System | External; the
 * platform manifest's is Agent | Human, because that enum answers exactly one
 * runtime question — does this step wait for a person?
 */
function projectActors(actors) {
  const mapped = (actors ?? []).map((actor) => (actor === "Human" ? "Human" : "Agent"));
  const unique = [...new Set(mapped)];
  return unique.length ? unique : ["Agent"];
}

// ── action projection ────────────────────────────────────────────────────────

function projectActionSteps(action) {
  const dropped = new Set(DROP_MANUAL_STEPS[action.id] ?? []);
  for (const name of dropped) {
    if (!(action.action_steps ?? []).some((step) => step.name === name)) {
      fail(`${action.id}: DROP_MANUAL_STEPS names "${name}", which the ontology no longer declares — the correction has landed, remove the entry`);
    }
  }
  if (dropped.size === 0) return action.action_steps ?? [];
  return (action.action_steps ?? []).filter(
    (step) => !(step.object_type === "manual" && dropped.has(step.name)),
  );
}

function projectRuleBindings(action) {
  const promoted = new Set(GUARD_AS_PRECONDITION[action.id] ?? []);
  const demotions = PRECONDITION_DEMOTIONS[action.id] ?? {};
  for (const ruleId of [...promoted, ...Object.keys(demotions)]) {
    if (!(action.rule_bindings ?? []).some((binding) => binding.rule_id === ruleId)) {
      fail(`${action.id}: phase override names ${ruleId}, which the action does not bind`);
    }
  }
  return (action.rule_bindings ?? []).map((binding) => {
    if (promoted.has(binding.rule_id) && binding.phase === "guard") {
      return { ...binding, phase: "precondition", studio_phase: "guard" };
    }
    const demoted = demotions[binding.rule_id];
    if (demoted && binding.phase === "precondition") {
      return { ...binding, phase: demoted, studio_phase: "precondition" };
    }
    return binding;
  });
}

function projectActions(rawActions) {
  const seen = new Set();
  const projected = rawActions.map((action) => {
    const map = ACTION_MAP[action.id];
    if (!map) fail(`action ${action.id} has no ACTION_MAP entry — add one before staging`);
    seen.add(action.id);

    // `SCHEDULED`/`TIMER`/`MANUAL` are cadences, not event names (0.1.8 no
    // longer emits them, the filter stays so a future release cannot regress).
    const trigger = (action.trigger ?? []).filter(
      (entry) => entry !== "SCHEDULED" && entry !== "TIMER" && entry !== "MANUAL",
    );

    const sideEffects = { ...(action.side_effects ?? {}) };
    if (map.kind === "prompt") {
      sideEffects.external_calls = (map.queries ?? []).map((query) => ({
        system: "metaERP",
        endpoint: catalogPath(query.operation),
        method: "POST",
        description: query.description,
      }));
    } else {
      sideEffects.external_calls = [
        {
          system: "metaERP",
          endpoint: catalogPath(map.operation),
          method: "POST",
          description:
            (action.side_effects?.external_calls ?? []).find(
              (call) => (call.endpoint ?? "").split("/").pop() === map.operation,
            )?.description ??
            (action.side_effects?.external_calls ?? [])[0]?.description ??
            `${map.operation}：${action.name} 写回 metaERP。`,
        },
      ];
    }

    const implementation =
      map.kind === "prompt"
        ? { kind: "prompt", executable: true }
        : {
            kind: "external",
            executable: true,
            operation_id: map.operation,
            endpoint: catalogPath(map.operation),
            method: "POST",
          };

    const preamble = PROMPT_PREAMBLE[action.id];

    return {
      ...action,
      actor: projectActors(action.actor),
      action_steps: projectActionSteps(action),
      description: preamble ? `${action.description ?? action.name}\n${preamble}` : action.description,
      rule_bindings: projectRuleBindings(action),
      trigger,
      side_effects: sideEffects,
      implementation,
      // Keep the archive original for provenance — the compiler passes the whole
      // actions file through to models/<tenant>-v1/actions_v1.json.
      studio_implementation: action.implementation ?? null,
    };
  });
  for (const id of Object.keys(ACTION_MAP)) {
    if (!seen.has(id)) fail(`ACTION_MAP names ${id}, which the archive does not declare`);
  }
  return projected;
}

function buildTransformMaps(objects, actions) {
  const seenObjects = new Set();
  const objectMaps = objects.map((object) => {
    const map = OBJECT_MAP[object.id];
    if (!map) fail(`object ${object.id} has no OBJECT_MAP entry — add one before staging`);
    seenObjects.add(object.id);
    return {
      object_id: object.id,
      object_name: object.name,
      erp_entity: map.entity,
      fetch: { method: "POST", path: catalogPath(map.query) },
    };
  });
  for (const id of Object.keys(OBJECT_MAP)) {
    if (!seenObjects.has(id)) fail(`OBJECT_MAP names ${id}, which the archive does not declare`);
  }

  // Ledger reads still need an object_map row — that is the only place the
  // compiler harvests `kind:"query"` catalog entries from.
  for (const [operation, ledger] of Object.entries(EXTRA_QUERY_OPS)) {
    objectMaps.push({
      object_id: ledger.entity,
      object_name: ledger.label,
      erp_entity: ledger.entity,
      fetch: { method: "POST", path: catalogPath(operation) },
    });
  }

  const actionMaps = actions.map((action) => {
    const map = ACTION_MAP[action.id];
    return map.kind === "external"
      ? {
          action_id: action.id,
          action_name: action.name,
          kind: "external",
          operation_id: map.operation,
          endpoint: catalogPath(map.operation),
          method: "POST",
          data_changes: [{ target_object: map.target }],
        }
      : {
          action_id: action.id,
          action_name: action.name,
          kind: "prompt",
          queries: (map.queries ?? []).map((query) => query.operation),
        };
  });

  return { object_maps: objectMaps, action_maps: actionMaps };
}

/** apps/mock-erp reads `_index.json` for its query ops + table stubs. */
function buildMockErpIndex(objects) {
  const endpoints = [];
  const seen = new Set();
  const push = (operation, entity, objectId) => {
    if (seen.has(operation)) return;
    seen.add(operation);
    if (!(entity in STUB_TABLES)) fail(`entity ${entity} (op ${operation}) has no STUB_TABLES entry`);
    endpoints.push({ operation, entity, object_id: objectId, file: `${entity}.json` });
  };
  for (const object of objects) {
    const map = OBJECT_MAP[object.id];
    push(map.query, map.entity, object.id);
  }
  for (const [operation, ledger] of Object.entries(EXTRA_QUERY_OPS)) {
    push(operation, ledger.entity, ledger.entity);
  }
  endpoints.sort((a, b) => a.operation.localeCompare(b.operation, "en"));
  return { base_path: CATALOG_BASE, endpoints };
}

function buildRealApiBindings(actions) {
  const ops = new Set();
  for (const action of actions) {
    const map = ACTION_MAP[action.id];
    if (map.kind === "external") ops.add(map.operation);
    for (const query of map.queries ?? []) ops.add(query.operation);
  }
  for (const map of Object.values(OBJECT_MAP)) ops.add(map.query);
  for (const operation of Object.keys(EXTRA_QUERY_OPS)) ops.add(operation);
  const bindings = {};
  for (const operation of [...ops].sort((a, b) => a.localeCompare(b, "en"))) {
    bindings[operation] = REAL_API_BINDINGS[operation] ?? {
      form: "platform",
      path: null,
      note: "决策对象 / 配置表：MetaERP 无对应 API，由 Agentic Operator 的数据面（当前为 apps/mock-erp）承载",
    };
  }
  return {
    source: "metaerp-openapi-call skill · reference/ppm-scenario2-apis.md (2026-09-04)",
    environments: {
      beta: { apigw: "https://apigw.his-beta.chinasoftinc.com", prefix: "/beta" },
      v15: { apigw: "https://apigw.his.chinasoftinc.com", prefix: "/v15", note: "把注册路径的 /beta/ 换成 /v15/" },
    },
    forms: {
      openapi: "IAM token + x-renter-id（scripts/call_openapi.py）",
      ui: "门户会话 + x-csrf-token + Referer（scripts/call_uiapi.py）",
      platform: "MetaERP 无此 API；由平台数据面承载",
    },
    catalog_base: CATALOG_BASE,
    bindings,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(arg === "--" && index === 0)),
  options: {
    source: { type: "string", default: "ontology-packages/procurement-hc-formal/source/package.json" },
    out: { type: "string", default: "ontology-packages/procurement-hc-formal/package" },
  },
  allowPositionals: false,
});

const sourceFile = path.resolve(ROOT, values.source);
const outDir = path.resolve(ROOT, values.out);
const domainDir = path.join(outDir, "studio-models", NAMESPACE, DOMAIN);

const archive = readArchive(sourceFile);
const { artifacts, manifest } = archive;
const objects = artifacts.objects;
const rules = artifacts.rules;
const actions = projectActions(artifacts.actions);

const familyMetadata = (family) => ({
  package_id: manifest.package_id,
  release: manifest.release,
  schema_bundle_version: manifest.schema_bundle_version,
  package_hash: manifest.package_hash,
  family,
  source_filename: manifest.families?.[family]?.filename ?? null,
  content_hash: manifest.families?.[family]?.content_hash ?? null,
  artifact_count: artifacts[family].length,
  staged_by: "scripts/stage-procurement-hc-formal-ontology.mjs",
});

rmSync(outDir, { recursive: true, force: true });

// 1. studio-models: compiler envelopes (actions bare array, objects/rules .payload)
writeJson(path.join(domainDir, `actions_${FAMILY_TAG}.json`), actions);
writeJson(path.join(domainDir, `events_${FAMILY_TAG}.json`), {
  metadata: familyMetadata("events"),
  events: artifacts.events,
});
writeJson(path.join(domainDir, `objects_${FAMILY_TAG}.json`), {
  metadata: familyMetadata("objects"),
  payload: objects,
});
writeJson(path.join(domainDir, `rules_${FAMILY_TAG}.json`), {
  metadata: familyMetadata("rules"),
  payload: rules,
});
writeJson(path.join(domainDir, `workflows_${FAMILY_TAG}.json`), {
  metadata: familyMetadata("workflows"),
  workflows: artifacts.workflows,
});
// Links are not consumed by the compiler; carried for graph import / provenance.
writeJson(path.join(domainDir, `links_${FAMILY_TAG}.json`), {
  metadata: familyMetadata("links"),
  links: artifacts.links,
});

// 2. transform maps (the half the archive omits) + the real-API ledger
writeJson(path.join(outDir, "transform-maps", "transform-maps.json"), buildTransformMaps(objects, actions));
writeJson(path.join(outDir, "transform-maps", "metaerp-api-bindings.json"), buildRealApiBindings(actions));

// 3. mock Meta ERP data plane
writeJson(path.join(outDir, "mock-erp", "_index.json"), buildMockErpIndex(objects));
for (const [entity, rows] of Object.entries(STUB_TABLES)) {
  writeJson(path.join(outDir, "mock-erp", `${entity}.json`), { rows });
}

const promptCount = Object.values(ACTION_MAP).filter((m) => m.kind === "prompt").length;
console.log(
  `[stage-procurement-hc-formal] ${manifest.package_id}@${manifest.release} (${manifest.package_hash.slice(0, 19)}…) staged ${actions.length} actions (${promptCount} prompt / ${
    actions.length - promptCount
  } external), ${artifacts.events.length} events, ${objects.length} objects, ${rules.length} rules, ${
    artifacts.workflows.length
  } workflows, ${artifacts.links.length} links → ${path.relative(ROOT, outDir)}`,
);
