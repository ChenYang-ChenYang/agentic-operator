#!/usr/bin/env node
/**
 * Stage the「采购全链路执行偏差三级预警」ontology package (业务领域 HC-采购,
 * 场景一) into the layout the platform's ontology compiler and the mock Meta
 * ERP both consume.
 *
 *   node scripts/stage-hc-procurement-ontology.mjs \
 *     [--source ontology-packages/hc-procurement/source] \
 *     [--out ontology-packages/hc-procurement/package]
 *
 * WHY THIS EXISTS
 * ---------------
 * The authored package is an allmetaOntology *Studio* export
 * (`{actions,events,objects,rules,workflows,links}_v0_*.json`).
 * `packages/ontology-compiler` expects a *dist* export, which differs in three
 * mechanical ways plus one substantive one:
 *
 *   1. envelopes  — compiler wants `actions` as a bare array, `objects`/`rules`
 *                   under `.payload`; Studio ships `{metadata, actions|payload}`.
 *   2. layout     — compiler wants `studio-models/<ns>/<domain>/` + `transform-maps/`.
 *   3. impl kind  — compiler knows `prompt` | `external`; Studio writes `http`
 *                   and `typescript` (the latter naming a module that does not
 *                   exist in this repo — those actions ARE the agent's reasoning).
 *   4. transform-maps — the Studio export does NOT ship them. Per the Beyond-ERP
 *                   whitepaper §六 an ontology package is completed by two
 *                   transformation maps (Data Objects ↔ ERP fields, Actions ↔ ERP
 *                   APIs). This script authors that missing half, binding each
 *                   ontology endpoint to the metaERP statement-catalog idiom
 *                   (`/metaerp/openapi/v1/<operationId>`) that `metaerp.invoke`
 *                   and apps/mock-erp both speak.
 *
 * The ontology's own `tool_use[]` lists are the authority for which operations
 * an action may call; ACTION_MAP below restates them in the compiler's
 * query/write vocabulary and adds nothing an action did not declare.
 *
 * Every mapping is a declared table, not an inference, so the projection from
 * ontology → runnable manifest stays reviewable. Output is byte-stable for a
 * fixed input (sorted keys, no timestamps), so `ontology:compile --check`
 * keeps working as a drift detector.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMESPACE = "allmeta";
const DOMAIN = "hc-procurement";
const CATALOG_BASE = "/metaerp/openapi/v1";

// ── Actions ↔ ERP APIs (transformation map #2) ───────────────────────────────
// `kind` is the COMPILER kind, not the Studio kind:
//   prompt   → one LLM `logic` step; `queries` become a read-scoped metaerp.invoke
//   external → rule gates + manual steps + a write-scoped metaerp.invoke
//
// Studio `typescript` actions name `@allmeta/procurement-chain-deviation/actions`,
// a module this repo does not ship. Their `action_steps` are all `logic` — the
//推理 itself — so they compile to prompt agents, EXCEPT where the ontology also
// declares `manual` steps: a human gate can only be expressed by the external
// path (rule gates → manual steps → one ERP write), so those carry the write
// their own `side_effects.data_changes` already declare.
const ACTION_MAP = {
  // ①查 —— 13 个只读接口拉全链路七节点进度
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
  // ②析 —— 双向推算计划时间、三项偏差、成因标签
  calculateExecutionDeviation: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "按业务类型取七个节点的标准周期（BR-PLAN-01 的配置来源；本体 tool_use 名 getStageCycleConfig）。" },
      { operation: "queryAlertThresholdConfig", description: "取时间/进度偏差判定阈值（BR-DEV-02：阈值必须来自配置，不得写死）。" },
    ],
  },
  archiveDeviationMonitoring: { kind: "prompt", queries: [] },
  // ④评 —— 按期达成概率与红黄蓝定级
  scoreOnTimeProbability: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "汇总当前节点之后各节点标准周期，得到剩余天数。" },
      { operation: "queryHistoricalOnTimeRate", description: "统计同业务类型历史已完结单的按期达成率与样本量。" },
      { operation: "queryAlertThresholdConfig", description: "取红/黄概率分界阈值。" },
    ],
  },
  // ③警 —— 按等级推送
  raiseDeviationAlert: {
    kind: "external",
    operation: "pushAlert",
    target: "Deviation_Alert",
  },
  // 蓝色：计划员自行处置（两个人工步骤）
  handleBlueAlertLocally: {
    kind: "external",
    operation: "closeBlueAlert",
    target: "Deviation_Alert",
  },
  // ④断 —— 三个可执行方案
  generateAdjustmentOptions: {
    kind: "prompt",
    queries: [
      { operation: "queryStageCycleConfig", description: "后续节点标准周期，方案①的可压缩空间。" },
      { operation: "queryTransferableStock", description: "定位可调库点与可调数量，方案③的调拨来源。" },
    ],
  },
  // ④断 —— 领导拍板 + 高危确认 + 计划员确认（三个人工步骤）
  approveAdjustmentOption: {
    kind: "external",
    operation: "approveAdjustmentOption",
    target: "Adjustment_Option",
  },
  // ⑥升 —— 超时自动升级
  escalateOverdueAlert: {
    kind: "external",
    operation: "escalateAlert",
    target: "Deviation_Alert",
  },
  // ⑤行 —— 方案①压缩后续周期
  compressDownstreamCycle: {
    kind: "external",
    operation: "changePbp",
    target: "Chain_Stage_Progress",
  },
  // ⑤行 —— 方案②调整需求日期（ontology tool_use 声明的是 changePbpLine）
  adjustRequiredArrivalDate: {
    kind: "external",
    operation: "changePbpLine",
    target: "Procurement_Plan_Line",
  },
  // ⑤行 —— 方案③执行调拨
  createStockTransferRequest: {
    kind: "external",
    operation: "createTransactionOrder",
    target: "Stock_Transfer_Request",
  },
  trackTransferFulfillment: {
    kind: "external",
    operation: "updateTransactionOrder",
    target: "Stock_Transfer_Request",
  },
  // ⑦闭环 —— 重算校验偏差是否消除（含一个人工核实步骤）
  closeDeviationHandling: {
    kind: "external",
    operation: "writeEventLog",
    target: "Alert_Handling_Record",
  },
  // ⑧馈 —— 误报归因并回流阈值评审队列
  recycleFalseAlarm: {
    kind: "external",
    operation: "createReviewItem",
    target: "Rule_Review_Item",
  },
};

// ── Data Objects ↔ ERP entities (transformation map #1) ──────────────────────
// Every Data Object gets a query op: the whitepaper's rule is that an object
// exists only if some decision must SEE it, and apps/mock-erp only materialises
// a table for entities listed in `_index.json` — an entity that is written but
// never listed would make its write op fail with "unknown ERP entity".
const OBJECT_MAP = {
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
  Delivery_Probability_Assessment: {
    entity: "dev_probability_assessment_t",
    query: "queryProbabilityAssessments",
  },
  Deviation_Alert: { entity: "dev_deviation_alert_t", query: "queryDeviationAlerts" },
  Adjustment_Option: { entity: "dev_adjustment_option_t", query: "queryAdjustmentOptions" },
  Stock_Transfer_Request: { entity: "inv_transaction_order_t", query: "queryTransactionOrders" },
  Alert_Handling_Record: { entity: "dev_alert_handling_record_t", query: "queryAlertHandlingRecords" },
  Rule_Review_Item: { entity: "dev_rule_review_item_t", query: "queryRuleReviewItems" },
};

// Read ops with no owning Data Object. These are ERP ledgers and derived
// statistics, not decision objects, so the ontology deliberately does not model
// them (whitepaper §六: only build what a decision must SEE). They still need a
// catalog entry, because the analysis agents read them.
const EXTRA_QUERY_OPS = {
  queryAllPbpLinePage: {
    entity: "ss_pbp_rel_t",
    label: "计划头行关系（防止行重复归集）",
  },
  querySpaList: {
    entity: "ss_spa_header_t",
    label: "价格协议台账（合同前置凭据）",
  },
  queryPoLineShipment: {
    entity: "po_line_shipment_t",
    label: "订单行发运/到货台账（进度偏差的分子分母）",
  },
  queryAcceptTransaction: {
    entity: "ac_transaction_t",
    label: "验收交易台账",
  },
  queryHistoricalOnTimeRate: {
    entity: "stat_historical_on_time_rate_t",
    label: "同业务类型历史按期达成率统计",
  },
  queryTransferableStock: {
    entity: "inv_transferable_stock_t",
    label: "可调拨库存（方案③的调出库点与可调数量）",
  },
};

// ── stub tables for apps/mock-erp ────────────────────────────────────────────
// One worked example threaded end to end: 大修专项计划 PBP-2026-0873 的一条
// 断路器计划行，需求到货 2026-11-30，链路停在「询价」——询价生效后 26 天没有
// 定标，供应商迟迟不报价。按物资类标准周期倒排，询价节点计划完成 2026-08-18，
// 实际到今天仍未完成，时间偏差远超 7 天阈值；订单尚未生成，进度偏差 1.0。
const STUB_TABLES = {
  ss_pbp_header_t: [
    {
      PBP_HEADER_ID: "PBP-2026-0873",
      PLAN_NO: "PBP-2026-0873",
      BUSINESS_TYPE: "物资",
      PLAN_TYPE: "大修专项",
      STATUS: "已批准",
      DEMAND_ORGANIZATION: "华东检修分公司",
      PLANNER: "张计划",
      DEPARTMENT_LEADER: "李部长",
      DIVISION_LEADER: "王分管",
      SUBMITTED_AT: "2026-06-20T09:00:00+08:00",
      APPROVED_AT: "2026-06-28T16:30:00+08:00",
    },
    {
      PBP_HEADER_ID: "PBP-2026-0914",
      PLAN_NO: "PBP-2026-0914",
      BUSINESS_TYPE: "物资",
      PLAN_TYPE: "年度计划",
      STATUS: "已批准",
      DEMAND_ORGANIZATION: "华南检修分公司",
      PLANNER: "赵计划",
      DEPARTMENT_LEADER: "李部长",
      DIVISION_LEADER: "王分管",
      SUBMITTED_AT: "2026-05-11T09:00:00+08:00",
      APPROVED_AT: "2026-05-19T10:10:00+08:00",
    },
  ],
  ss_pbp_line_t: [
    {
      PBP_LINE_ID: "PBPL-2026-0873-01",
      PBP_HEADER_ID: "PBP-2026-0873",
      ITEM_CODE: "M-BRK-126",
      ITEM_NAME: "126kV SF6 断路器",
      QUANTITY: 12,
      UNIT: "台",
      NEED_BY_DATE: "2026-11-30",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 4560000,
      DEMAND_DEPARTMENT: "检修一部",
      USAGE_SCENARIO: "大修",
    },
    {
      PBP_LINE_ID: "PBPL-2026-0914-03",
      PBP_HEADER_ID: "PBP-2026-0914",
      ITEM_CODE: "M-CT-110",
      ITEM_NAME: "110kV 电流互感器",
      QUANTITY: 30,
      UNIT: "台",
      NEED_BY_DATE: "2027-01-20",
      ORIGINAL_NEED_BY_DATE: "",
      PLANNED_AMOUNT: 1740000,
      DEMAND_DEPARTMENT: "检修二部",
      USAGE_SCENARIO: "生产",
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
      SOURCE_OBJECT_ID: "PR-2026-11832",
      ITEM_CODE: "M-BRK-126",
      STATUS: "有效",
      LAST_UPDATE_DATE: "2026-07-21T15:05:00+08:00",
      EXPECTED_FINISH_SOURCING_DATE: "2026-09-05",
    },
    {
      PROC_PACKAGE_HEADER_ID: "PKG-2026-0488",
      PROC_PACKAGE_LINE_ID: "PKGL-2026-0488-02",
      PACKAGE_NO: "PKG-2026-0488",
      SOURCE_OBJECT_ID: "PR-2026-11907",
      ITEM_CODE: "M-CT-110",
      STATUS: "有效",
      LAST_UPDATE_DATE: "2026-06-18T10:00:00+08:00",
      EXPECTED_FINISH_SOURCING_DATE: "2026-08-10",
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
  ss_spa_header_t: [
    {
      SPA_HEADER_ID: "SPA-2026-0338",
      SPA_NUMBER: "SPA-2026-0338",
      SOURCE_OBJECT_ID: "RFX-2026-0701",
      CONTRACT_ID: "CT-2026-0912",
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
  // 七节点标准周期：物资合计 155 天，从需求到货日期倒排。
  cfg_stage_cycle_standard_t: [
    { CYCLE_STANDARD_ID: "CYC-WZ-1", BUSINESS_TYPE: "物资", STAGE_NODE: "立项", STAGE_SEQUENCE: 1, STANDARD_CYCLE_DAYS: 10, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-WZ-2", BUSINESS_TYPE: "物资", STAGE_NODE: "组包", STAGE_SEQUENCE: 2, STANDARD_CYCLE_DAYS: 15, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-WZ-3", BUSINESS_TYPE: "物资", STAGE_NODE: "询价", STAGE_SEQUENCE: 3, STANDARD_CYCLE_DAYS: 20, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-WZ-4", BUSINESS_TYPE: "物资", STAGE_NODE: "定标", STAGE_SEQUENCE: 4, STANDARD_CYCLE_DAYS: 15, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-WZ-5", BUSINESS_TYPE: "物资", STAGE_NODE: "合同", STAGE_SEQUENCE: 5, STANDARD_CYCLE_DAYS: 15, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-WZ-6", BUSINESS_TYPE: "物资", STAGE_NODE: "订单", STAGE_SEQUENCE: 6, STANDARD_CYCLE_DAYS: 10, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-WZ-7", BUSINESS_TYPE: "物资", STAGE_NODE: "到货", STAGE_SEQUENCE: 7, STANDARD_CYCLE_DAYS: 70, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-1", BUSINESS_TYPE: "工程", STAGE_NODE: "立项", STAGE_SEQUENCE: 1, STANDARD_CYCLE_DAYS: 15, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-2", BUSINESS_TYPE: "工程", STAGE_NODE: "组包", STAGE_SEQUENCE: 2, STANDARD_CYCLE_DAYS: 20, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-3", BUSINESS_TYPE: "工程", STAGE_NODE: "询价", STAGE_SEQUENCE: 3, STANDARD_CYCLE_DAYS: 25, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-4", BUSINESS_TYPE: "工程", STAGE_NODE: "定标", STAGE_SEQUENCE: 4, STANDARD_CYCLE_DAYS: 20, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-5", BUSINESS_TYPE: "工程", STAGE_NODE: "合同", STAGE_SEQUENCE: 5, STANDARD_CYCLE_DAYS: 20, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-6", BUSINESS_TYPE: "工程", STAGE_NODE: "订单", STAGE_SEQUENCE: 6, STANDARD_CYCLE_DAYS: 15, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
    { CYCLE_STANDARD_ID: "CYC-GC-7", BUSINESS_TYPE: "工程", STAGE_NODE: "到货", STAGE_SEQUENCE: 7, STANDARD_CYCLE_DAYS: 90, MAINTAINER: "系统管理员", EFFECTIVE_DATE: "2026-01-01" },
  ],
  // BR-DEV-02：判定阈值必须取自配置，不得在规则或代码里写死。
  cfg_alert_threshold_t: [
    // 超过当前节点的计划完成时间点即为延期——阈值 0 表示「超期即预警」，不留容忍窗口。
    // BR-DEV-02 要求阈值必须来自本表，所以这是配置值而不是代码里的常量。
    { THRESHOLD_ID: "TH-TIME-0D", THRESHOLD_CODE: "时间偏差天数", THRESHOLD_NAME: "时间偏差判定阈值（超期即预警）", THRESHOLD_VALUE: 0, UNIT: "天", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
    { THRESHOLD_ID: "TH-SCHED-20", THRESHOLD_CODE: "进度偏差比例", THRESHOLD_NAME: "进度偏差判定阈值", THRESHOLD_VALUE: 0.2, UNIT: "比例", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
    { THRESHOLD_ID: "TH-PROB-RED", THRESHOLD_CODE: "红色概率上限", THRESHOLD_NAME: "红色分级概率上限", THRESHOLD_VALUE: 0.6, UNIT: "比例", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
    { THRESHOLD_ID: "TH-PROB-YELLOW", THRESHOLD_CODE: "黄色概率下限", THRESHOLD_NAME: "黄色分级概率下限", THRESHOLD_VALUE: 0.85, UNIT: "比例", MAINTAINER: "规则评审组", EFFECTIVE_DATE: "2026-01-01" },
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
  // 以下为本场景自有的决策/处置对象，起始为空，由 agent 写入。
  emg_procurement_chain_t: [],
  emg_chain_stage_progress_t: [],
  dev_execution_deviation_t: [],
  dev_probability_assessment_t: [],
  dev_deviation_alert_t: [],
  dev_adjustment_option_t: [],
  inv_transaction_order_t: [],
  dev_alert_handling_record_t: [],
  dev_rule_review_item_t: [],
};

/**
 * Guard bindings promoted to `precondition` so the compiler turns them into a
 * real entry gate.
 *
 * The compiler only compiles `phase:"precondition" && enforcement:"mandatory"`
 * bindings into gate steps. A few of this ontology's `guard` bindings are
 * semantically entry conditions on a HUMAN-gated action, where the difference
 * is not cosmetic: without the gate, `DEVIATION_ALERT_RAISED` would open a
 * 计划员自行处置 task for red and yellow alerts too, which BR-ALERT-03 exists
 * precisely to prevent. Promotion is listed per action so the deviation from
 * the authored phase is visible.
 */
const GUARD_AS_PRECONDITION = {
  // BR-ALERT-03「蓝色预警仅提示计划员」— 只有蓝色才走计划员自行处置。
  handleBlueAlertLocally: ["BR-ALERT-03"],
};

/**
 * 取数协议：写进 action.description，不是写进 output_contracts。
 *
 * 编译器把 `description` 放在 action_prompt 的第一段（buildAnalysisPrompt 的
 * `parts[0]`），而 overlay 的 output_contracts 字段一律渲染成「字段说明」下的
 * `- <name>: …` —— 实测模型会把放在那里的协议当成「一个要输出的 JSON 字段」照抄，
 * 而不是当成要遵守的取数步骤（它甚至如实自述了 query_rounds_used=2）。步骤必须
 * 出现在步骤区。
 */
const PROMPT_PREAMBLE = {
  collectChainExecutionData: [
    "",
    "【取数步骤（在产出 JSON 之前必须先按此执行）】",
    "",
    "第 0 步 · 定范围：看触发事件负载有没有 plan_id 或 plan_no。有就**只处理这一个计划**——",
    "调用 queryOpenPbpHeader 时必须带过滤条件 {\"PBP_HEADER_ID\": \"<该值>\"}，不得拉全量再自己筛。",
    "没有才按 BR-COV-01 处理全部状态=已批准且在途的计划。",
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
};

// ── helpers ──────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`[stage-hc-procurement] ${message}`);
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

/** Resolve `<family>_v*.json` inside the Studio export directory. */
function familyFile(sourceDir, family) {
  const matches = readdirSync(sourceDir)
    .filter((file) => file.startsWith(`${family}_v`) && file.endsWith(".json"))
    .sort();
  if (!matches.length) fail(`no ${family}_v*.json under ${sourceDir}`);
  return path.join(sourceDir, matches[matches.length - 1]);
}

function readFamily(sourceDir, family) {
  return JSON.parse(readFileSync(familyFile(sourceDir, family), "utf8"));
}

const catalogPath = (operation) => `${CATALOG_BASE}/${operation}`;

/**
 * The ontology's actor vocabulary is Agent | Human | System | External; the
 * platform manifest's is Agent | Human, because that enum answers exactly one
 * runtime question — does this step wait for a person? `System` and `External`
 * are both machine-executed, so both project to `Agent`. `Human` is preserved
 * verbatim: it is what opens a task for an operator.
 */
/**
 * Manual `action_steps` the ontology declares but should not — see
 * docs/hc-procurement-ontology-corrections.md C-06 and C-07. Dropped here so
 * the compiled workflow stops one place for a person instead of five; remove
 * these entries once the ontology JSON itself is corrected.
 *
 * C-06 `closeDeviationHandling.collectVerification` contradicts its own action:
 *   the actor is ["Agent","System"] with no Human, and the description says the
 *   agent RECOMPUTES the deviation to check it cleared. Collecting that verdict
 *   from a person is the opposite of what the action says it does — and because
 *   the step carries no rule gate, it stopped every single run.
 *
 * C-07 the three `confirmByPlanner` steps all cite BR-OPT-05, which
 *   `approveAdjustmentOption.plannerConfirm` already satisfies once, upstream
 *   and by name. Re-asking the same planner for the same confirmation in each
 *   execution branch is the same approval collected four times.
 *
 * C-08 `approveAdjustmentOption.reviewOptions` and `.confirmHighRisk` ask the
 *   SAME 部门领导, in the same sitting, either side of the one question that
 *   carries information — which option. `reviewOptions` records only that the
 *   options were looked at, which choosing one already demonstrates.
 *   `confirmHighRisk` re-asks whether the option just chosen is high-risk, and
 *   the option itself carries `is_high_risk`; the confirmation BR-OPT-06 wants
 *   is recorded from the selection and the person who made it, rather than
 *   asked again one screen later. Three clicks for one decision is what this
 *   removes — the 计划员's separate BR-OPT-05 confirmation is a different role
 *   and deliberately stays.
 */
const DROP_MANUAL_STEPS = {
  approveAdjustmentOption: ["reviewOptions", "confirmHighRisk"],
  closeDeviationHandling: ["collectVerification"],
  compressDownstreamCycle: ["confirmByPlanner"],
  adjustRequiredArrivalDate: ["confirmByPlanner"],
  createStockTransferRequest: ["confirmByPlanner"],
};

function projectActors(actors) {
  const mapped = (actors ?? []).map((actor) => (actor === "Human" ? "Human" : "Agent"));
  const unique = [...new Set(mapped)];
  return unique.length ? unique : ["Agent"];
}

// ── action projection ────────────────────────────────────────────────────────

function projectActionSteps(action) {
  const dropped = new Set(DROP_MANUAL_STEPS[action.id] ?? []);
  if (dropped.size === 0) return action.action_steps ?? [];
  const kept = (action.action_steps ?? []).filter(
    (step) => !(step.object_type === "manual" && dropped.has(step.name)),
  );
  for (const name of dropped) {
    if (!(action.action_steps ?? []).some((step) => step.name === name)) {
      fail(`${action.id}: DROP_MANUAL_STEPS names "${name}", which the ontology no longer declares — the correction has landed, remove the entry`);
    }
  }
  return kept;
}

function projectActions(rawActions) {
  return rawActions.map((action) => {
    const map = ACTION_MAP[action.id];
    if (!map) fail(`action ${action.id} has no ACTION_MAP entry — add one before staging`);

    // `SCHEDULED`/`TIMER` are cadences, not event names. Dropping them lets the
    // compiler install its synthetic MANUAL_<action> trigger so the agent stays
    // invocable; the ontology's own scheduled events (DAILY_DEVIATION_SCAN_
    // SCHEDULED, ALERT_TIMEOUT_SCAN_SCHEDULED) are real events and are kept.
    const trigger = (action.trigger ?? []).filter(
      (entry) => entry !== "SCHEDULED" && entry !== "TIMER" && entry !== "MANUAL",
    );

    const sideEffects = { ...(action.side_effects ?? {}) };
    if (map.kind === "prompt") {
      // The compiler grants a read-scoped metaerp.invoke for every external_call
      // whose op id starts with `query`/`get`. Restate the ontology's declared
      // reads in the catalog vocabulary; a prompt agent never writes.
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

    const promoted = new Set(GUARD_AS_PRECONDITION[action.id] ?? []);
    const ruleBindings = (action.rule_bindings ?? []).map((binding) =>
      promoted.has(binding.rule_id) && binding.phase === "guard"
        ? { ...binding, phase: "precondition", studio_phase: "guard" }
        : binding,
    );

    const preamble = PROMPT_PREAMBLE[action.id];

    return {
      ...action,
      actor: projectActors(action.actor),
      action_steps: projectActionSteps(action),
      description: preamble
        ? `${action.description ?? action.name}\n${preamble}`
        : action.description,
      rule_bindings: ruleBindings,
      trigger,
      side_effects: sideEffects,
      implementation,
      // Keep the Studio original for provenance — the compiler passes the whole
      // actions file through to models/<tenant>-v1/actions_v1.json.
      studio_implementation: action.implementation ?? null,
    };
  });
}

function buildTransformMaps(objects, actions) {
  const objectMaps = objects.map((object) => {
    const map = OBJECT_MAP[object.id];
    if (!map) fail(`object ${object.id} has no OBJECT_MAP entry — add one before staging`);
    return {
      object_id: object.id,
      object_name: object.name,
      erp_entity: map.entity,
      fetch: { method: "POST", path: catalogPath(map.query) },
    };
  });

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
  for (const object of objects) {
    const map = OBJECT_MAP[object.id];
    if (seen.has(map.query)) continue;
    seen.add(map.query);
    endpoints.push({
      operation: map.query,
      entity: map.entity,
      object_id: object.id,
      file: `${map.entity}.json`,
    });
  }
  for (const [operation, ledger] of Object.entries(EXTRA_QUERY_OPS)) {
    if (seen.has(operation)) continue;
    seen.add(operation);
    endpoints.push({
      operation,
      entity: ledger.entity,
      object_id: ledger.entity,
      file: `${ledger.entity}.json`,
    });
  }
  endpoints.sort((a, b) => a.operation.localeCompare(b.operation, "en"));
  return { base_path: CATALOG_BASE, endpoints };
}

// ── main ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(arg === "--" && index === 0)),
  options: {
    source: { type: "string", default: "ontology-packages/hc-procurement/source" },
    out: { type: "string", default: "ontology-packages/hc-procurement/package" },
  },
  allowPositionals: false,
});

const sourceDir = path.resolve(ROOT, values.source);
const outDir = path.resolve(ROOT, values.out);
const domainDir = path.join(outDir, "studio-models", NAMESPACE, DOMAIN);

const rawActionsFile = readFamily(sourceDir, "actions");
const rawEvents = readFamily(sourceDir, "events");
const rawObjects = readFamily(sourceDir, "objects");
const rawRules = readFamily(sourceDir, "rules");
const rawWorkflows = readFamily(sourceDir, "workflows");
const rawLinks = readFamily(sourceDir, "links");

// The actions family is a bare array in this export; other families wrap theirs.
const rawActions = Array.isArray(rawActionsFile) ? rawActionsFile : rawActionsFile.actions;
const objects = rawObjects.payload ?? rawObjects.objects;
const rules = rawRules.payload ?? rawRules.rules;
const actions = projectActions(rawActions);

rmSync(outDir, { recursive: true, force: true });

// 1. studio-models: compiler envelopes (actions bare array, objects/rules .payload)
writeJson(path.join(domainDir, "actions_v0_1_004.json"), actions);
writeJson(path.join(domainDir, "events_v0_1_004.json"), {
  metadata: rawEvents.metadata,
  events: rawEvents.events,
});
writeJson(path.join(domainDir, "objects_v0_1_004.json"), {
  metadata: rawObjects.metadata,
  payload: objects,
});
writeJson(path.join(domainDir, "rules_v0_2_004.json"), {
  metadata: rawRules.metadata,
  payload: rules,
});
writeJson(path.join(domainDir, "workflows_v0_1_004.json"), {
  metadata: rawWorkflows.metadata,
  workflows: rawWorkflows.workflows,
});
// Links are not consumed by the compiler; carried for graph import / provenance.
writeJson(path.join(domainDir, "links_v0_1_004.json"), {
  metadata: rawLinks.metadata,
  links: rawLinks.links ?? rawLinks.payload,
});

// 2. transform maps (the half the Studio export omits)
writeJson(
  path.join(outDir, "transform-maps", "transform-maps.json"),
  buildTransformMaps(objects, actions),
);

// 3. mock Meta ERP data plane
writeJson(path.join(outDir, "mock-erp", "_index.json"), buildMockErpIndex(objects));
for (const [entity, rows] of Object.entries(STUB_TABLES)) {
  writeJson(path.join(outDir, "mock-erp", `${entity}.json`), { rows });
}

const promptCount = Object.values(ACTION_MAP).filter((m) => m.kind === "prompt").length;
console.log(
  `[stage-hc-procurement] staged ${actions.length} actions (${promptCount} prompt / ${
    actions.length - promptCount
  } external), ${rawEvents.events.length} events, ${objects.length} objects, ${
    rules.length
  } rules, ${rawWorkflows.workflows.length} workflow → ${path.relative(ROOT, outDir)}`,
);
