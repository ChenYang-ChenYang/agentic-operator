import type { MockErpStore, Row } from "./store.js";

/** HTTP-mappable failure for a write op (missing row, missing field, …). */
export class MockErpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "MockErpError";
  }
}

export interface EffectResult {
  ok: true;
  id?: string;
  row?: Row;
  rows?: Row[];
}

export type Effect = (store: MockErpStore, payload: Row) => EffectResult;

/**
 * Case/style-insensitive payload field lookup: `pick(p, "MATERIAL_CODE",
 * "material_id")` matches `MATERIAL_CODE`, `material_code`, `materialCode`,
 * `material_id`, … Callers list aliases in priority order.
 */
function pick(payload: Row, ...names: string[]): unknown {
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(payload)) {
    normalized.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), value);
  }
  for (const name of names) {
    const hit = normalized.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (hit !== undefined && hit !== null && hit !== "") return hit;
  }
  return undefined;
}

function required(payload: Row, ...names: string[]): unknown {
  const value = pick(payload, ...names);
  if (value === undefined) {
    throw new MockErpError(400, `missing required field: ${names[0]}`);
  }
  return value;
}

function num(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

let seq = 0;
/** Timestamp-based unique id, e.g. TRF-1755650000123-1. */
function makeId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function findRow(
  store: MockErpStore,
  entity: string,
  idField: string,
  id: unknown,
): Row {
  const row = store.rows(entity).find((r) => r[idField] === id);
  if (!row) {
    throw new MockErpError(404, `${entity}: no row with ${idField}=${String(id)}`);
  }
  return row;
}

function isoNow(): string {
  return new Date().toISOString();
}

function arr(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => Boolean(item) && typeof item === "object")
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : typeof value === "string" && value
      ? [value]
      : [];
}

/** Rows of a table the loaded package may or may not declare (empty if absent). */
function rowsIfTable(store: MockErpStore, entity: string): Row[] {
  return store.tables.get(entity) ?? [];
}

/** Append a row to a table only when the loaded package declares it — the
 * 场景二 作业留痕 / 待办 tables exist in procurement-hc-formal but not in the
 * older hc-procurement package, and a write op must not fail on the ledger. */
function appendIfTable(store: MockErpStore, entity: string, row: Row): boolean {
  const rows = store.tables.get(entity);
  if (!rows) return false;
  rows.push(row);
  return true;
}

/** Replace-or-insert by id column; returns the live row. */
function upsertRow(
  store: MockErpStore,
  entity: string,
  idField: string,
  id: string,
  patch: Row,
): Row | null {
  const rows = store.tables.get(entity);
  if (!rows) return null;
  const existing = rows.find((row) => row[idField] === id);
  if (existing) {
    Object.assign(existing, patch);
    return existing;
  }
  const row: Row = { [idField]: id, ...patch };
  rows.push(row);
  return row;
}

/** 场景二 数字员工作业留痕（BR2-AUDIT-01：角色、时间、依据、结论四要素）。 */
function operationLog(
  store: MockErpStore,
  entry: {
    operation_type: string;
    operator_role: string;
    operator?: string;
    plan_line_id?: unknown;
    related_object_type?: string;
    related_object_id?: unknown;
    rule_hit?: string[];
    api_called?: string;
    decision_note?: string;
  },
): string {
  const id = makeId("OPL");
  appendIfTable(store, "de_operation_log_t", {
    OPERATION_LOG_ID: id,
    OPERATION_TYPE: entry.operation_type,
    OPERATOR_ROLE: entry.operator_role,
    OPERATOR: entry.operator ?? "",
    OCCURRED_AT: isoNow(),
    PLAN_LINE_ID: entry.plan_line_id ?? "",
    RELATED_OBJECT_TYPE: entry.related_object_type ?? "",
    RELATED_OBJECT_ID: entry.related_object_id ?? "",
    RULE_HIT: entry.rule_hit ?? [],
    API_CALLED: entry.api_called ?? "",
    DECISION_NOTE: entry.decision_note ?? "",
    AUDITABLE: true,
  });
  return id;
}

/**
 * 场景二 ⑤行 — 库存判为「可调度」时不建采购计划，直接生成调拨申请单
 * （BR2-STOCK-01 硬拦截分支）。与场景一由偏差调整方案落地的调拨共用同一张
 * 调拨申请（inv_transaction_order_t），以 TRANSFER_REASON 区分来路。
 */
function createDemandTransfer(store: MockErpStore, payload: Row): EffectResult & Row {
  const flag = String(pick(payload, "stock_check_flag") ?? "可调度");
  if (flag !== "可调度") {
    throw new MockErpError(400, `BR2-STOCK-01: stock_check_flag must be 可调度, got ${flag}`);
  }
  if (pick(payload, "is_urgent_demand") === true) {
    throw new MockErpError(400, "BR2-STOCK-01: urgent demand is not transferable");
  }
  const material = String(required(payload, "MATERIAL_CODE", "material_code"));
  const quantity = num(required(payload, "TRANSFER_QUANTITY", "transfer_quantity", "demand_quantity")) ?? 0;
  const planLineId = String(pick(payload, "plan_line_id") ?? "");
  const stockCheckId = String(pick(payload, "stock_check_id") ?? "");
  const sourceWarehouse = String(pick(payload, "source_warehouse", "storehouse_code") ?? "WH-HD-02");
  const targetWarehouse = String(pick(payload, "target_warehouse") ?? "需求单位库");
  const organization = String(pick(payload, "inventory_organization") ?? "");
  const id = makeId("TRO");
  const createdAt = isoNow();
  const expected = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const row: Row = {
    TRANSFER_REQUEST_ID: id,
    TRANSFER_NO: id,
    PLAN_LINE_ID: planLineId,
    STOCK_CHECK_ID: stockCheckId,
    MATERIAL_CODE: material,
    TRANSFER_QUANTITY: quantity,
    SOURCE_WAREHOUSE: sourceWarehouse,
    TARGET_WAREHOUSE: targetWarehouse,
    INVENTORY_ORGANIZATION: organization,
    TRANSFER_REASON: "库存可调度",
    REQUEST_STATUS: "已提交",
    EXPECTED_ARRIVAL_DATE: expected,
    CREATED_AT: createdAt,
  };
  store.rows("inv_transaction_order_t").push(row);
  operationLog(store, {
    operation_type: "调拨转办",
    operator_role: "采购数字员工",
    plan_line_id: planLineId,
    related_object_type: "Stock_Transfer_Request",
    related_object_id: id,
    rule_hit: ["BR2-STOCK-01"],
    api_called: "createTransactionOrder",
    decision_note: `库存可调度：${material} × ${quantity} 从 ${sourceWarehouse} 调拨，不建采购计划`,
  });
  return {
    ok: true,
    id,
    row,
    applied: true,
    transfer_context: {
      transfer_request_id: id,
      transfer_no: id,
      transfer_reason: "库存可调度",
      transfer_quantity: quantity,
      expected_arrival_date: expected,
      plan_line_id: planLineId,
      stock_check_id: stockCheckId,
      material_code: material,
      source_warehouse: sourceWarehouse,
      target_warehouse: targetWarehouse,
      created_at: createdAt,
    },
  };
}

/**
 * Hand-written ERP semantics for the 15 write operations declared in
 * transform-maps action_maps (operation_id present). CREATE ops append a row
 * shaped like the stub table's columns; MODIFY ops flip STATUS on the matched
 * row. Every op's result is journaled by the route handler.
 */
export const WRITE_EFFECTS: Record<string, Effect> = {
  // ---- inventory -----------------------------------------------------------
  lockInventoryLot: (store, payload) => {
    const lotId = required(payload, "LOT_ID", "lot_id");
    const row = findRow(store, "wm_inventory_lot_t", "LOT_ID", lotId);
    row["STATUS"] = "locked";
    return { ok: true, id: String(lotId), row };
  },

  releaseInventoryLot: (store, payload) => {
    const lotId = required(payload, "LOT_ID", "lot_id");
    const row = findRow(store, "wm_inventory_lot_t", "LOT_ID", lotId);
    row["STATUS"] = "available";
    return { ok: true, id: String(lotId), row };
  },

  // ---- stock transfer ------------------------------------------------------
  createTransferOrder: (store, payload) => {
    const id = makeId("TRF");
    const row: Row = {
      TRANSFER_ID: id,
      MATERIAL_CODE: required(payload, "MATERIAL_CODE", "material_id", "material"),
      FROM_WH: required(payload, "FROM_WH", "from_warehouse", "from"),
      TO_WH: required(payload, "TO_WH", "to_warehouse", "to"),
      WO_ID: pick(payload, "WO_ID", "work_order_id") ?? "",
      QTY: num(required(payload, "QTY", "quantity")) ?? 0,
      STATUS: "proposed",
      ETA_HOURS: num(pick(payload, "ETA_HOURS")) ?? 48,
    };
    store.rows("wm_transfer_order_t").push(row);
    return { ok: true, id, row };
  },

  createShipmentTask: (store, payload) => {
    const transferId = required(payload, "TRANSFER_ID", "transfer_id");
    const row = findRow(store, "wm_transfer_order_t", "TRANSFER_ID", transferId);
    row["STATUS"] = "in_transit";
    const carrier = pick(payload, "CARRIER", "carrier_id");
    if (carrier !== undefined) row["CARRIER"] = carrier;
    return { ok: true, id: makeId("SHP"), row };
  },

  // ---- purchasing ----------------------------------------------------------
  createEmergencyPo: (store, payload) => {
    const id = makeId("PO-EMG");
    const row: Row = {
      PO_ID: id,
      REQ_ID: pick(payload, "REQ_ID") ?? "",
      SUPPLIER_ID: required(payload, "SUPPLIER_ID", "supplier"),
      AGREEMENT_ID: pick(payload, "AGREEMENT_ID") ?? "",
      MATERIAL_CODE: required(payload, "MATERIAL_CODE", "material_id", "material"),
      ORDER_QTY: num(required(payload, "ORDER_QTY", "QTY", "quantity")) ?? 0,
      ORDER_AMT: num(pick(payload, "ORDER_AMT", "amount")) ?? 0,
      PROMISED_DATE: pick(payload, "PROMISED_DATE", "need_by_date") ?? "",
      EMERGENCY_FLAG: true,
      STATUS: "created",
    };
    store.rows("po_order_header_t").push(row);
    return { ok: true, id, row };
  },

  createRequisitionBatch: (store, payload) => {
    const rawItems = pick(payload, "items", "requisitions", "rows");
    const items: Row[] = Array.isArray(rawItems)
      ? (rawItems as Row[])
      : [payload];
    const created: Row[] = [];
    for (const item of items) {
      const row: Row = {
        REQ_ID: makeId("REQ"),
        MATERIAL_CODE: required(item, "MATERIAL_CODE", "material_id", "material"),
        REQ_ORG_ID: pick(item, "REQ_ORG_ID", "org_id") ?? "",
        REQ_BY: pick(item, "REQ_BY", "requested_by") ?? "",
        REQ_QTY: num(required(item, "REQ_QTY", "QTY", "quantity")) ?? 0,
        BUDGET_AMT: num(pick(item, "BUDGET_AMT", "budget")) ?? 0,
        NEED_BY_DATE: pick(item, "NEED_BY_DATE") ?? "",
        STATUS: "pending_approval",
        REASON: pick(item, "REASON") ?? "补库采购计划",
      };
      store.rows("po_requisition_t").push(row);
      created.push(row);
    }
    return { ok: true, id: String(created[0]?.["REQ_ID"] ?? ""), rows: created };
  },

  suspendRequisition: (store, payload) => {
    const reqId = required(payload, "REQ_ID", "requisition_id");
    const row = findRow(store, "po_requisition_t", "REQ_ID", reqId);
    row["STATUS"] = "suspended";
    const reason = pick(payload, "REASON", "suspend_reason");
    if (reason !== undefined) row["SUSPEND_REASON"] = reason;
    return { ok: true, id: String(reqId), row };
  },

  sendExpediteNotice: (store, payload) => {
    const id = makeId("EXP");
    const row: Row = {
      NOTICE_ID: id,
      PO_ID: required(payload, "PO_ID", "po_id"),
      SUPPLIER_ID: pick(payload, "SUPPLIER_ID") ?? "",
      STATUS: "sent",
      LEGAL_FLAG: Boolean(pick(payload, "LEGAL_FLAG") ?? false),
      SENT_AT: today(),
    };
    store.rows("po_expedite_notice_t").push(row);
    return { ok: true, id, row };
  },

  // ---- quality / sourcing / supplier risk ---------------------------------
  createInspectionTask: (store, payload) => {
    const id = makeId("INS");
    const row: Row = {
      INSPECTION_ID: id,
      PO_ID: pick(payload, "PO_ID") ?? "",
      SUPPLIER_ID: required(payload, "SUPPLIER_ID", "supplier"),
      STATUS: "scheduled",
      RESULT: "",
      INSPECTED_AT: "",
    };
    store.rows("qm_inspection_t").push(row);
    return { ok: true, id, row };
  },

  createRfq: (store, payload) => {
    const id = makeId("RFQ");
    const row: Row = {
      RFQ_ID: id,
      SUPPLIER_ID: required(payload, "SUPPLIER_ID", "supplier"),
      MATERIAL_CODE: required(payload, "MATERIAL_CODE", "material_id", "material"),
      QTY: num(pick(payload, "QTY", "quantity")) ?? 0,
      DEADLINE: pick(payload, "DEADLINE") ?? "",
      STATUS: "sent",
    };
    store.rows("srm_rfq_t").push(row);
    return { ok: true, id, row };
  },

  addRiskFlag: (store, payload) => {
    const id = makeId("RF");
    const row: Row = {
      FLAG_ID: id,
      SUPPLIER_ID: required(payload, "SUPPLIER_ID", "supplier"),
      FLAG_TYPE: pick(payload, "FLAG_TYPE", "type") ?? "risk",
      SEVERITY: pick(payload, "SEVERITY") ?? "high",
      EVIDENCE: pick(payload, "EVIDENCE", "reason") ?? "",
      FLAGGED_AT: today(),
    };
    store.rows("srm_risk_flag_t").push(row);
    return { ok: true, id, row };
  },

  // ---- cross-org collaboration / allocation / disposal ---------------------
  createCollabRequest: (_store, payload) => {
    // No ERP table behind cross-unit collab requests (transform-maps declares
    // no data_changes) — the journal is the system of record.
    const id = makeId("COLLAB");
    return {
      ok: true,
      id,
      row: {
        COLLAB_ID: id,
        FROM_ORG: pick(payload, "FROM_ORG", "requesting_org") ?? "",
        TO_ORG: pick(payload, "TO_ORG", "target_org") ?? "",
        TOPIC: pick(payload, "TOPIC", "subject", "reason") ?? "",
        STATUS: "requested",
        REQUESTED_AT: today(),
      },
    };
  },

  createAllocation: (store, payload) => {
    const id = makeId("ALC");
    const row: Row = {
      ALLOC_ID: id,
      REQ_ID: pick(payload, "REQ_ID", "requisition_id") ?? "",
      LOT_ID: required(payload, "LOT_ID", "lot_id"),
      FROM_ORG: required(payload, "FROM_ORG", "from_org_id"),
      TO_ORG: required(payload, "TO_ORG", "to_org_id"),
      QTY: num(required(payload, "QTY", "quantity")) ?? 0,
      SAVINGS_AMT: num(pick(payload, "SAVINGS_AMT", "savings")) ?? 0,
      STATUS: "proposed",
    };
    store.rows("wm_allocation_order_t").push(row);
    return { ok: true, id, row };
  },

  confirmAllocation: (store, payload) => {
    const allocId = required(payload, "ALLOC_ID", "allocation_id");
    const row = findRow(store, "wm_allocation_order_t", "ALLOC_ID", allocId);
    // Bilateral confirmation: proposed → confirmed_both → executed.
    row["STATUS"] = row["STATUS"] === "confirmed_both" ? "executed" : "confirmed_both";
    return { ok: true, id: String(allocId), row };
  },

  createDisposal: (store, payload) => {
    const id = makeId("DSP");
    const row: Row = {
      DISPOSAL_ID: id,
      LOT_ID: required(payload, "LOT_ID", "lot_id"),
      ORG_ID: pick(payload, "ORG_ID", "owner_org_id") ?? "",
      METHOD: pick(payload, "METHOD") ?? "auction",
      EST_VALUE: num(pick(payload, "EST_VALUE", "estimated_value")) ?? 0,
      STATUS: "draft",
    };
    store.rows("wm_disposal_order_t").push(row);
    return { ok: true, id, row };
  },

  // ---- HC-采购 · 采购全链路执行偏差三级预警 --------------------------------
  // Operation ids are distinct from the power-scm block above: this map is keyed
  // by operation id across every loaded package, and the two demo packages have
  // different field contracts and different target entities.
  //
  // Several ops deliberately ECHO their decision context back to the caller.
  // The agent chain hops through the ERP between「领导拍板」and「回写单据」, and
  // the ⑥行 write agents read their branch condition (option_type) and their
  // BR-OPT-05 gate input (planner_confirmed_by) out of the emitted event — an
  // ERP that only returned its own row id would strip both.

  /** ④警 — 生成并推送三级预警，按等级定推送角色（BR-ALERT-01~03）。 */
  pushAlert: (store, payload) => {
    const assessment = (pick(payload, "probability_assessment") ?? {}) as Row;
    const deviation = (pick(payload, "execution_deviation") ?? {}) as Row;
    const chain = (pick(payload, "procurement_chain") ?? {}) as Row;
    const level = String(
      pick(payload, "alert_level") ?? pick(assessment, "probability_grade") ?? "",
    );
    const roleByLevel: Record<string, string> = {
      红色: "分管领导",
      黄色: "部门领导",
      蓝色: "计划员",
    };
    const role = roleByLevel[level];
    if (!role) {
      throw new MockErpError(400, `unsupported alert level: ${level || "(empty)"}`);
    }
    const id = makeId("ALT");
    const raisedAt = new Date().toISOString();
    const row: Row = {
      ALERT_ID: id,
      ALERT_NO: id,
      DEVIATION_ID: pick(deviation, "deviation_id") ?? "",
      ASSESSMENT_ID: pick(assessment, "assessment_id") ?? "",
      CHAIN_ID: pick(chain, "chain_id") ?? pick(payload, "chain_id") ?? "",
      ALERT_LEVEL: level,
      NOTIFIED_ROLE: role,
      NOTIFIED_TO: pick(payload, "notified_to") ?? role,
      RAISED_AT: raisedAt,
      HANDLING_STATUS: "待处理",
      ESCALATION_COUNT: 0,
      VERIFICATION_RESULT: "待核实",
      GENERATED_OPTION_COUNT: 0,
    };
    store.rows("dev_deviation_alert_t").push(row);
    store.rows("dev_alert_handling_record_t").push({
      HANDLING_RECORD_ID: makeId("AHR"),
      ALERT_ID: id,
      HANDLING_ACTION: "预警推送",
      OPERATOR_ROLE: role,
      OCCURRED_AT: raisedAt,
      REMARK: `${level}预警推送${role}`,
    });
    return {
      ok: true,
      id,
      row,
      // Downstream ⑤断 needs the whole decision picture, not just the alert row.
      alert_context: {
        ...payload,
        alert_id: id,
        alert_level: level,
        notified_role: role,
        raised_at: raisedAt,
      },
    };
  },

  /** 蓝色预警由计划员就地闭环（BR-ALERT-03 / BR-CLOSE-02）。 */
  closeBlueAlert: (store, payload) => {
    const alertId = String(required(payload, "ALERT_ID", "alert_id"));
    const row = findRow(store, "dev_deviation_alert_t", "ALERT_ID", alertId);
    const closedAt = new Date().toISOString();
    row["HANDLING_STATUS"] = "已闭环";
    row["CLOSED_AT"] = closedAt;
    const recordId = makeId("AHR");
    store.rows("dev_alert_handling_record_t").push({
      HANDLING_RECORD_ID: recordId,
      ALERT_ID: alertId,
      HANDLING_ACTION: "闭环归档",
      OPERATOR_ROLE: "计划员",
      OPERATOR: pick(payload, "operator", "planner") ?? "计划员",
      OCCURRED_AT: closedAt,
      REMARK: String(pick(payload, "handling_action", "remark") ?? "计划员自行处置"),
    });
    return {
      ok: true,
      id: alertId,
      row,
      alert_id: alertId,
      chain_id: row["CHAIN_ID"],
      handling_record_id: recordId,
      closed_at: closedAt,
    };
  },

  /** ⑤断 — 领导拍板 + 高危确认 + 计划员确认后落库，回执执行决策上下文。 */
  approveAdjustmentOption: (store, payload) => {
    const decision = String(pick(payload, "DECISION", "decision") ?? "approved");
    if (decision !== "approved" && decision !== "rejected") {
      throw new MockErpError(400, `unsupported decision: ${decision}`);
    }
    const optionId = String(required(payload, "OPTION_ID", "option_id"));
    const optionType = String(required(payload, "OPTION_TYPE", "option_type"));
    const plannerConfirmedBy = String(
      required(payload, "PLANNER_CONFIRMED_BY", "planner_confirmed_by"),
    );
    const alertId = String(required(payload, "ALERT_ID", "alert_id"));
    const decidedAt = new Date().toISOString();
    const row: Row = {
      OPTION_ID: optionId,
      ALERT_ID: alertId,
      CHAIN_ID: pick(payload, "CHAIN_ID", "chain_id") ?? "",
      OPTION_TYPE: optionType,
      OPTION_STATUS: decision === "approved" ? "已选定" : "未采纳",
      DECIDED_BY: pick(payload, "DECIDED_BY", "decided_by") ?? "",
      DECIDED_AT: decidedAt,
      HIGH_RISK_CONFIRMED_BY: pick(payload, "HIGH_RISK_CONFIRMED_BY", "high_risk_confirmed_by") ?? "",
      PLANNER_CONFIRMED_BY: plannerConfirmedBy,
      PLANNER_CONFIRMED_AT: decidedAt,
    };
    store.rows("dev_adjustment_option_t").push(row);
    const alert = store
      .rows("dev_deviation_alert_t")
      .find((candidate) => candidate["ALERT_ID"] === alertId);
    if (alert) {
      alert["HANDLING_STATUS"] = "处理中";
      alert["ACKNOWLEDGED_AT"] = decidedAt;
    }
    store.rows("dev_alert_handling_record_t").push({
      HANDLING_RECORD_ID: makeId("AHR"),
      ALERT_ID: alertId,
      HANDLING_ACTION: "方案选定",
      OPERATOR_ROLE: String(pick(payload, "decision_role") ?? "部门领导"),
      OPERATOR: String(pick(payload, "decided_by") ?? ""),
      OCCURRED_AT: decidedAt,
      REMARK: `${optionType}（${decision}）`,
    });
    return {
      ok: true,
      id: optionId,
      row,
      // The three ⑥行 branches all subscribe to ADJUSTMENT_OPTION_APPROVED and
      // pick themselves out by option_type; BR-OPT-05's gate reads
      // planner_confirmed_by straight off this payload.
      decision_context: {
        option_id: optionId,
        option_type: optionType,
        alert_id: alertId,
        chain_id: row["CHAIN_ID"],
        decided_by: row["DECIDED_BY"],
        decided_at: decidedAt,
        high_risk_confirmed_by: row["HIGH_RISK_CONFIRMED_BY"],
        planner_confirmed_by: plannerConfirmedBy,
      },
    };
  },

  /**
   * ⑦升 — 扫描超时预警：黄>48h 升红，红>24h 上报分管领导（BR-ESC-01~03）。
   * 扫描面是整张预警表，扫描请求本身不带筛选条件，所以不读 payload。
   */
  escalateAlert: (store, _payload) => {
    const now = Date.now();
    const hoursSince = (value: unknown): number => {
      const raised = Date.parse(String(value ?? ""));
      return Number.isFinite(raised) ? (now - raised) / 3_600_000 : 0;
    };
    const escalatedAt = new Date().toISOString();
    const escalated: Row[] = [];
    for (const alert of store.rows("dev_deviation_alert_t")) {
      const status = String(alert["HANDLING_STATUS"] ?? "");
      const level = String(alert["ALERT_LEVEL"] ?? "");
      const overdue = hoursSince(alert["RAISED_AT"]);
      let toLevel: string | null = null;
      let toRole: string | null = null;
      if (level === "黄色" && status === "待处理" && overdue > 48) {
        toLevel = "红色";
        toRole = "分管领导";
      } else if (level === "红色" && status !== "已闭环" && overdue > 24) {
        toLevel = "红色";
        toRole = "分管领导";
      }
      if (!toLevel || !toRole) continue;
      const fromLevel = level;
      alert["ALERT_LEVEL"] = toLevel;
      alert["NOTIFIED_ROLE"] = toRole;
      alert["NOTIFIED_TO"] = toRole;
      alert["HANDLING_STATUS"] = "已升级";
      alert["ESCALATED_AT"] = escalatedAt;
      alert["ESCALATION_COUNT"] = (num(alert["ESCALATION_COUNT"]) ?? 0) + 1;
      store.rows("dev_alert_handling_record_t").push({
        HANDLING_RECORD_ID: makeId("AHR"),
        ALERT_ID: alert["ALERT_ID"],
        HANDLING_ACTION: "超时升级",
        OPERATOR_ROLE: toRole,
        OCCURRED_AT: escalatedAt,
        REMARK: `${fromLevel}→${toLevel}，滞留 ${overdue.toFixed(1)} 小时`,
      });
      escalated.push({ ...alert, FROM_LEVEL: fromLevel, TO_LEVEL: toLevel });
    }
    const first = escalated[0];
    return {
      ok: true,
      id: String(first?.["ALERT_ID"] ?? "NONE"),
      rows: escalated,
      escalated: escalated.length > 0,
      alert_context: first
        ? {
            alert_id: first["ALERT_ID"],
            chain_id: first["CHAIN_ID"],
            from_level: first["FROM_LEVEL"],
            to_level: first["TO_LEVEL"],
            alert_level: first["TO_LEVEL"],
            notified_role: first["NOTIFIED_ROLE"],
            escalated_at: escalatedAt,
            escalated_count: escalated.length,
          }
        : { escalated_count: 0, scanned_at: escalatedAt },
    };
  },

  /** ⑥行 方案① — 回写各节点计划完成时间。非压缩方案原样放行、不改单据。 */
  changePbp: (store, payload) => {
    const optionType = String(pick(payload, "option_type") ?? "");
    if (optionType !== "压缩后续周期") {
      return { ok: true, id: "SKIPPED", applied: false, skipped_reason: optionType };
    }
    const chainId = String(required(payload, "CHAIN_ID", "chain_id"));
    const rawLines = pick(payload, "compressed_schedule", "planned_dates", "stage_progress");
    const lines: Row[] = Array.isArray(rawLines) ? (rawLines as Row[]) : [];
    const id = makeId("PBPCHG");
    const updated: Row[] = [];
    for (const line of lines) {
      const row: Row = {
        STAGE_PROGRESS_ID: makeId("CSP"),
        CHANGE_ID: id,
        CHAIN_ID: chainId,
        STAGE_NODE: required(line, "STAGE_NODE", "stage_node"),
        STANDARD_CYCLE_DAYS: num(pick(line, "STANDARD_CYCLE_DAYS", "standard_cycle_days")) ?? 0,
        PLANNED_FINISH_DATE: required(line, "PLANNED_FINISH_DATE", "planned_finish_date"),
        CHANGE_REASON: pick(payload, "reason", "remark") ?? "偏差处置·压缩后续周期",
        OPERATOR: pick(payload, "planner_confirmed_by") ?? "",
        CHANGED_AT: new Date().toISOString(),
      };
      store.rows("emg_chain_stage_progress_t").push(row);
      updated.push(row);
    }
    return {
      ok: true,
      id,
      rows: updated,
      applied: true,
      option_id: pick(payload, "option_id") ?? "",
      chain_id: chainId,
      compressed_days: num(pick(payload, "compressed_days")) ?? 0,
      executed_at: new Date().toISOString(),
    };
  },

  /** ⑥行 方案② — 改写计划行需求到货日期，原始日期留痕。 */
  changePbpLine: (store, payload) => {
    const optionType = String(pick(payload, "option_type") ?? "");
    if (optionType !== "调整需求日期") {
      return { ok: true, id: "SKIPPED", applied: false, skipped_reason: optionType };
    }
    // The approval context names the option, not the date: the new required
    // date is the option's simulated arrival (expected_arrival_date_after),
    // carried forward from ADJUSTMENT_OPTIONS_GENERATED. An explicit date
    // still wins when a caller supplies one.
    const optionId = String(pick(payload, "option_id") ?? "");
    const carriedOptions = arr(pick(payload, "options"));
    const selectedOption =
      (carriedOptions.find((option) => String(pick(option, "option_id") ?? "") === optionId) as Row | undefined) ??
      (pick(payload, "recommended_option") as Row | undefined);
    const planLineId = String(
      pick(payload, "PLAN_LINE_ID", "plan_line_id") ??
        pick(selectedOption ?? {}, "plan_line_id") ??
        pick((arr(pick(payload, "procurement_chain"))[0] ?? {}) as Row, "plan_line_id") ??
        required(payload, "PLAN_LINE_ID", "plan_line_id"),
    );
    const newDateValue =
      pick(payload, "REQUIRED_ARRIVAL_DATE", "required_arrival_date", "new_required_arrival_date") ??
      pick(selectedOption ?? {}, "expected_arrival_date_after");
    if (newDateValue === undefined || newDateValue === null || String(newDateValue) === "") {
      throw new MockErpError(
        400,
        "changePbpLine: missing required field: REQUIRED_ARRIVAL_DATE (no explicit date and the selected option carries no expected_arrival_date_after)",
      );
    }
    const newDate = String(newDateValue);
    const row = findRow(store, "ss_pbp_line_t", "PBP_LINE_ID", planLineId);
    const original = String(row["ORIGINAL_NEED_BY_DATE"] ?? "") || String(row["NEED_BY_DATE"] ?? "");
    row["ORIGINAL_NEED_BY_DATE"] = original;
    row["NEED_BY_DATE"] = newDate;
    return {
      ok: true,
      id: planLineId,
      row,
      applied: true,
      option_id: pick(payload, "option_id") ?? "",
      chain_id: pick(payload, "chain_id") ?? "",
      plan_line_id: planLineId,
      original_required_arrival_date: original,
      required_arrival_date: newDate,
      executed_at: new Date().toISOString(),
    };
  },

  /**
   * ⑥行 方案③ — 生成调拨申请单并取得 ERP 正式单号。
   *
   * Two callers share this op id: 场景一 createStockTransferRequest sends the
   * decision context (option_type present — only「执行调拨」applies), 场景二
   * createInventoryTransferOrder sends a stock-check context with no
   * option_type at all. The payload shape, not a flag, picks the semantics.
   */
  createTransactionOrder: (store, payload) => {
    if (pick(payload, "option_type") === undefined) {
      return createDemandTransfer(store, payload);
    }
    const optionType = String(pick(payload, "option_type") ?? "");
    if (optionType !== "执行调拨") {
      return { ok: true, id: "SKIPPED", applied: false, skipped_reason: optionType };
    }
    const source = (pick(payload, "transfer_source") ?? payload) as Row;
    const id = makeId("TRO");
    const leadDays = num(pick(source, "TRANSFER_LEAD_DAYS", "transfer_lead_days")) ?? 7;
    const expected = new Date(Date.now() + leadDays * 86_400_000).toISOString().slice(0, 10);
    const row: Row = {
      TRANSFER_REQUEST_ID: id,
      TRANSFER_NO: id,
      OPTION_ID: pick(payload, "option_id") ?? "",
      CHAIN_ID: pick(payload, "chain_id") ?? "",
      MATERIAL_CODE: required(source, "ITEM_CODE", "item_code", "material_code"),
      TRANSFER_QUANTITY: num(required(source, "TRANSFER_QUANTITY", "transfer_quantity")) ?? 0,
      SOURCE_WAREHOUSE: required(source, "WAREHOUSE_ID", "warehouse_id", "source_warehouse"),
      TARGET_WAREHOUSE: pick(payload, "target_warehouse") ?? "需求单位库",
      REQUEST_STATUS: "已提交",
      EXPECTED_ARRIVAL_DATE: expected,
      CREATED_AT: new Date().toISOString(),
    };
    store.rows("inv_transaction_order_t").push(row);
    return {
      ok: true,
      id,
      row,
      applied: true,
      transfer_request_id: id,
      transfer_no: id,
      option_id: row["OPTION_ID"],
      chain_id: row["CHAIN_ID"],
      transfer_quantity: row["TRANSFER_QUANTITY"],
      expected_arrival_date: expected,
    };
  },

  /** ⑥行 — 跟踪调拨到货与归还，刷新链路预计到货日期。 */
  updateTransactionOrder: (store, payload) => {
    const transferId = String(
      required(payload, "TRANSFER_REQUEST_ID", "transfer_request_id", "transfer_no"),
    );
    const row = findRow(store, "inv_transaction_order_t", "TRANSFER_REQUEST_ID", transferId);
    const arrived = new Date().toISOString().slice(0, 10);
    row["REQUEST_STATUS"] = "已到货";
    row["ACTUAL_ARRIVAL_DATE"] = arrived;
    row["RETURNED_AT"] = pick(payload, "returned_at") ?? "";
    return {
      ok: true,
      id: transferId,
      row,
      fulfilled: true,
      transfer_request_id: transferId,
      chain_id: row["CHAIN_ID"],
      request_status: row["REQUEST_STATUS"],
      actual_arrival_date: arrived,
    };
  },

  /** ⑧闭环 — 写闭环留痕（BR-CLOSE-02：无留痕不予闭环）。 */
  writeEventLog: (store, payload) => {
    const alertId = String(required(payload, "ALERT_ID", "alert_id"));
    const eliminated = pick(payload, "deviation_eliminated") === true;
    const verification = String(pick(payload, "verification_result") ?? "待核实");
    const closedAt = new Date().toISOString();
    const id = makeId("AHR");
    store.rows("dev_alert_handling_record_t").push({
      HANDLING_RECORD_ID: id,
      ALERT_ID: alertId,
      HANDLING_ACTION: "闭环归档",
      OPERATOR_ROLE: "计划员",
      OCCURRED_AT: closedAt,
      DEVIATION_ELIMINATED: eliminated,
      VERIFICATION_RESULT: verification,
      REMARK: String(pick(payload, "remark") ?? ""),
    });
    const alert = store
      .rows("dev_deviation_alert_t")
      .find((candidate) => candidate["ALERT_ID"] === alertId);
    if (alert) {
      alert["HANDLING_STATUS"] = verification === "误报" ? "已撤销" : "已闭环";
      alert["CLOSED_AT"] = closedAt;
      alert["VERIFICATION_RESULT"] = verification;
    }
    return {
      ok: true,
      id,
      closure_context: {
        alert_id: alertId,
        deviation_id: pick(payload, "deviation_id") ?? "",
        chain_id: pick(payload, "chain_id") ?? alert?.["CHAIN_ID"] ?? "",
        deviation_eliminated: eliminated,
        verification_result: verification,
        closed_at: closedAt,
      },
    };
  },

  /** ⑨馈 — 误报归因回流阈值评审队列（BR-FB-02/03）。 */
  createReviewItem: (store, payload) => {
    const cause = String(required(payload, "FALSE_ALARM_CAUSE", "false_alarm_cause"));
    const alerts = store.rows("dev_deviation_alert_t");
    const closed = alerts.filter((alert) =>
      ["已闭环", "已撤销"].includes(String(alert["HANDLING_STATUS"] ?? "")),
    );
    const falseAlarms = closed.filter((alert) => alert["VERIFICATION_RESULT"] === "误报");
    const rate = closed.length ? falseAlarms.length / closed.length : 0;
    const threshold = store
      .rows("cfg_alert_threshold_t")
      .find((row) => row["THRESHOLD_CODE"] === "时间偏差天数");
    const id = makeId("RRI");
    const submittedAt = new Date().toISOString();
    const row: Row = {
      REVIEW_ITEM_ID: id,
      THRESHOLD_ID: threshold?.["THRESHOLD_ID"] ?? "",
      FALSE_ALARM_CAUSE: cause,
      CURRENT_THRESHOLD_VALUE: num(threshold?.["THRESHOLD_VALUE"]) ?? 0,
      SUGGESTED_THRESHOLD_VALUE:
        num(pick(payload, "suggested_threshold_value")) ??
        (num(threshold?.["THRESHOLD_VALUE"]) ?? 0) + 3,
      FALSE_ALARM_RATE: Number(rate.toFixed(4)),
      REVIEW_STATUS: "待评审",
      SUBMITTED_AT: submittedAt,
      REMARK: String(pick(payload, "remark") ?? ""),
    };
    store.rows("dev_rule_review_item_t").push(row);
    if (threshold) {
      threshold["LAST_TUNED_AT"] = submittedAt;
      threshold["TUNING_REASON"] = cause;
    }
    return {
      ok: true,
      id,
      row,
      review_item_created: true,
      recycle_context: {
        alert_id: pick(payload, "alert_id") ?? "",
        chain_id: pick(payload, "chain_id") ?? "",
        false_alarm_cause: cause,
        false_alarm_rate: row["FALSE_ALARM_RATE"],
        recycled_at: submittedAt,
      },
      review_item: {
        review_item_id: id,
        threshold_id: row["THRESHOLD_ID"],
        false_alarm_cause: cause,
        current_threshold_value: row["CURRENT_THRESHOLD_VALUE"],
        suggested_threshold_value: row["SUGGESTED_THRESHOLD_VALUE"],
        false_alarm_rate: row["FALSE_ALARM_RATE"],
        submitted_at: submittedAt,
      },
    };
  },

  // ---- 采购-HC-Formal · 场景二 数字化员工的智能作业实践 ----------------------
  // The seven ops below are declared by procurement-hc-formal@0.1.8 only. The
  // package's 决策/作业 objects (de_*) start empty and are written here; every
  // op leaves a de_operation_log_t row (BR2-AUDIT-01) and echoes the context
  // the next agent in the chain reads out of its trigger event.

  /** ③行 — 计划员确认拆分后，把超限组合拆为独立计划行（BR2-MERGE-02/03）。 */
  splitDemandLine: (store, payload) => {
    const decision = String(pick(payload, "decision") ?? "approved");
    if (decision !== "approved") {
      return { ok: true, id: "SKIPPED", applied: false, skipped_reason: decision };
    }
    const suggestionId = String(required(payload, "MERGE_SUGGESTION_ID", "merge_suggestion_id"));
    const confirmedBy = String(required(payload, "CONFIRMED_BY", "confirmed_by"));
    const lineIds = strings(pick(payload, "plan_line_ids", "source_plan_line_ids"));
    const single = pick(payload, "plan_line_id");
    if (lineIds.length === 0 && single !== undefined) lineIds.push(String(single));
    const confirmedAt = isoNow();
    let splitCount = 0;
    for (const lineId of lineIds) {
      const line = rowsIfTable(store, "ss_pbp_line_t").find((row) => row["PBP_LINE_ID"] === lineId);
      if (!line) continue;
      line["IS_SPLIT"] = "Y";
      line["MERGE_GROUP_ID"] = String(pick(payload, "merge_group_id") ?? "");
      line["SOURCE_OBJECT_TYPE"] = "PBP_LINE";
      line["SOURCE_OBJECT_LINE_ID"] = lineId;
      splitCount += 1;
    }
    upsertRow(store, "de_demand_merge_suggestion_t", "MERGE_SUGGESTION_ID", suggestionId, {
      SUGGESTION_STATUS: "已拆分",
      SUGGESTION_TYPE: "需拆分",
      CONFIRMED_BY: confirmedBy,
      CONFIRMED_AT: confirmedAt,
      SOURCE_PLAN_LINE_IDS: lineIds,
      SPLIT_LINE_COUNT: splitCount,
    });
    const logId = operationLog(store, {
      operation_type: "需求拆分",
      operator_role: "采购计划员",
      operator: confirmedBy,
      plan_line_id: lineIds[0] ?? "",
      related_object_type: "Demand_Merge_Suggestion",
      related_object_id: suggestionId,
      rule_hit: ["BR2-MERGE-02", "BR2-MERGE-03"],
      decision_note: String(pick(payload, "remark") ?? "计划员确认拆分为独立计划行"),
    });
    return {
      ok: true,
      id: suggestionId,
      applied: true,
      operation_log_id: logId,
      split_context: {
        merge_suggestion_id: suggestionId,
        split_line_count: splitCount,
        confirmed_by: confirmedBy,
        confirmed_at: confirmedAt,
        plan_line_ids: lineIds,
        plan_line_id: lineIds[0] ?? "",
      },
    };
  },

  /**
   * ④行 — 执行计划草稿：createPbp 建执行计划头行，并把来源需求行映射写入
   * 采购业务计划关系表（BR2-MERGE-04：合并计划没有来源映射不得生成）。
   */
  createPbp: (store, payload) => {
    const draft = (pick(payload, "draft_request") ?? payload) as Row;
    const lines = arr(pick(draft, "lines", "plan_lines", "pbpCreateLineDTOList"));
    if (lines.length === 0) {
      throw new MockErpError(400, "createPbp: at least one plan line is required");
    }
    const sourceLineIds = new Set<string>(strings(pick(draft, "source_plan_line_ids")));
    for (const line of lines) for (const id of strings(pick(line, "source_plan_line_ids"))) sourceLineIds.add(id);
    const merged =
      sourceLineIds.size > 1 || lines.some((line) => strings(pick(line, "source_plan_line_ids")).length > 1);
    if (merged && sourceLineIds.size === 0) {
      throw new MockErpError(400, "BR2-MERGE-04: merged execution plan needs source_plan_line_ids (来源需求行映射未写入)");
    }
    const headerId = makeId("PBP-EXEC");
    const createdAt = isoNow();
    const businessType = String(pick(draft, "business_type") ?? "物资");
    const managementUnit = String(pick(draft, "management_unit") ?? "");
    const mergeGroupId = String(pick(draft, "merge_group_id") ?? "");
    const header: Row = {
      PBP_HEADER_ID: headerId,
      PLAN_NO: headerId,
      PLAN_CATEGORY: "执行计划",
      BUSINESS_TYPE: businessType,
      PLAN_TYPE: String(pick(draft, "plan_type") ?? "执行计划"),
      STATUS: "草稿",
      IS_EXECUTION_PLAN_DRAFT: "Y",
      UNIT_CODE: String(pick(draft, "unit_code") ?? ""),
      MANAGEMENT_UNIT: managementUnit,
      PLAN_PERIOD: String(pick(draft, "plan_period") ?? ""),
      MERGE_GROUP_ID: mergeGroupId,
      IS_DELETED: "N",
      CREATED_AT: createdAt,
    };
    store.rows("ss_pbp_header_t").push(header);
    const lineRows: Row[] = [];
    lines.forEach((line, index) => {
      const lineId = `${headerId}-${String(index + 1).padStart(2, "0")}`;
      const lineSources = strings(pick(line, "source_plan_line_ids"));
      const sources = lineSources.length ? lineSources : [...sourceLineIds];
      const row: Row = {
        PBP_LINE_ID: lineId,
        PBP_LINE_NUMBER: String(index + 1),
        PBP_HEADER_ID: headerId,
        ITEM_CODE: String(required(line, "ITEM_CODE", "item_code", "material_code")),
        ITEM_NAME: String(pick(line, "item_name", "material_name") ?? ""),
        PBP_LINE_TYPE_CODE: String(pick(line, "line_type_code") ?? "物资"),
        CATEGORY_ID: String(pick(line, "category_id") ?? ""),
        QUANTITY: num(required(line, "QUANTITY", "quantity")) ?? 0,
        UNIT: String(pick(line, "unit") ?? ""),
        UNIT_PRICE: num(pick(line, "unit_price")) ?? 0,
        NEED_BY_DATE: String(pick(line, "need_by_date", "required_arrival_date") ?? ""),
        INVENTORY_ORGANIZATION: String(pick(line, "inventory_organization") ?? ""),
        SOURCING_METHOD: String(pick(line, "sourcing_method") ?? "公开询价"),
        IS_EXECUTION_PLAN_DRAFT: "Y",
        MERGE_GROUP_ID: mergeGroupId,
        SOURCE_OBJECT_TYPE: "PBP_LINE",
        SOURCE_OBJECT_LINE_ID: sources[0] ?? "",
        SOURCE_PLAN_LINE_IDS: sources,
        LINE_STATUS: "草稿",
        IS_CANCELLED: "N",
        IS_DELETED: "N",
        IS_URGENT: pick(line, "is_urgent") === true ? "Y" : "N",
        CENTRAL_PURCHASE_LEVEL: "未标识",
        ATTACHMENT_COMPLETE: "Y",
      };
      store.rows("ss_pbp_line_t").push(row);
      lineRows.push(row);
      const relations = rowsIfTable(store, "ss_pbp_rel_t");
      for (const source of sources) {
        relations.push({
          PBP_REL_ID: makeId("REL"),
          PBP_HEADER_ID: headerId,
          PBP_LINE_ID: lineId,
          SOURCE_PLAN_LINE_ID: source,
          SOURCE_PLAN_HEADER_ID: String(pick(draft, "source_plan_header_id") ?? ""),
        });
      }
    });
    const suggestionId = String(pick(draft, "merge_suggestion_id") ?? "");
    if (suggestionId) {
      upsertRow(store, "de_demand_merge_suggestion_t", "MERGE_SUGGESTION_ID", suggestionId, {
        MERGE_GROUP_ID: mergeGroupId,
        SOURCE_PLAN_LINE_IDS: [...sourceLineIds],
        SOURCE_PLAN_HEADER_ID: headerId,
        SOURCE_PLAN_NO: headerId,
        RELATION_RECORD_ID: headerId,
        SOURCE_MAPPING_WRITTEN: true,
        SUGGESTION_STATUS: "已采纳",
      });
    }
    const taskId = makeId("TSK");
    appendIfTable(store, "de_digital_employee_task_t", {
      TASK_ID: taskId,
      TASK_TYPE: "草稿确认",
      ASSIGNED_ROLE: "采购计划员",
      ASSIGNEE: "",
      PLAN_LINE_ID: lineRows[0]?.["PBP_LINE_ID"] ?? "",
      RELATED_OBJECT_TYPE: "Procurement_Plan",
      RELATED_OBJECT_ID: headerId,
      TASK_SUMMARY: `执行计划草稿 ${headerId} 待确认（${lineRows.length} 行）`,
      TASK_STATUS: "待处理",
      CREATED_AT: createdAt,
    });
    const logId = operationLog(store, {
      operation_type: "执行计划草稿生成",
      operator_role: "采购数字员工",
      plan_line_id: lineRows[0]?.["PBP_LINE_ID"] ?? "",
      related_object_type: "Procurement_Plan",
      related_object_id: headerId,
      rule_hit: ["BR2-MERGE-04"],
      api_called: "createPbp",
      decision_note: `来源行 ${[...sourceLineIds].join("、") || "（单行）"} → ${headerId}`,
    });
    const planLines = lineRows.map((row) => ({
      plan_id: headerId,
      plan_no: headerId,
      plan_line_id: row["PBP_LINE_ID"],
      plan_line_no: row["PBP_LINE_NUMBER"],
      material_code: row["ITEM_CODE"],
      material_name: row["ITEM_NAME"],
      line_type_code: row["PBP_LINE_TYPE_CODE"],
      category_id: row["CATEGORY_ID"],
      quantity: row["QUANTITY"],
      unit: row["UNIT"],
      unit_price: row["UNIT_PRICE"],
      required_arrival_date: row["NEED_BY_DATE"],
      management_unit: managementUnit,
      inventory_organization: row["INVENTORY_ORGANIZATION"],
      sourcing_method: row["SOURCING_METHOD"],
      central_purchase_level: row["CENTRAL_PURCHASE_LEVEL"],
      attachment_complete: true,
      is_urgent: row["IS_URGENT"] === "Y",
      source_plan_line_ids: row["SOURCE_PLAN_LINE_IDS"],
    }));
    return {
      ok: true,
      id: headerId,
      row: header,
      rows: lineRows,
      source_mapping_written: true,
      operation_log_id: logId,
      draft_context: {
        plan_id: headerId,
        plan_no: headerId,
        draft_line_count: lineRows.length,
        merge_group_id: mergeGroupId,
        merge_suggestion_id: suggestionId,
        source_mapping_written: true,
        plan_line_id: lineRows[0]?.["PBP_LINE_ID"] ?? "",
        plan_lines: planLines,
        business_type: businessType,
        management_unit: managementUnit,
        source_plan_line_ids: [...sourceLineIds],
        task_id: taskId,
        scan_date: pick(payload, "scan_date") ?? "",
        schedule_plan: pick(payload, "schedule_plan") ?? null,
        stage_schedule: pick(draft, "stage_schedule") ?? [],
      },
    };
  },

  /**
   * 待办推送 — two callers: ⑨警 returnPlanForRectification (payload is the
   * applicant's rectification form: audit_opinion_id present) and ⑫警
   * raisePackagingComplianceAlert (payload is the compliance violation). Both
   * open a 数字员工待办; the rectification caller also moves the audit opinion.
   */
  pushTask: (store, payload) => {
    const id = makeId("TSK");
    const now = isoNow();
    const auditOpinionId = pick(payload, "audit_opinion_id");
    const isRectification = auditOpinionId !== undefined;
    const decision = String(pick(payload, "decision") ?? "");
    const special = String(pick(payload, "special_sourcing_method") ?? "无");
    const assignedRole = String(
      pick(payload, "assigned_role") ??
        (isRectification ? "需求申请人" : special !== "无" ? "集采管理岗" : "采购计划员"),
    );
    const taskType = String(pick(payload, "task_type") ?? (isRectification ? "整改退回" : "组包预警"));
    const planLineId = pick(payload, "plan_line_id") ?? "";
    const relatedId = isRectification ? auditOpinionId : (pick(payload, "pkg_finding_id") ?? "");
    const summary = String(
      pick(payload, "task_summary", "rectify_advice", "intercept_items", "conclusion") ?? "",
    );
    const row: Row = {
      TASK_ID: id,
      TASK_TYPE: taskType,
      ASSIGNED_ROLE: assignedRole,
      ASSIGNEE: pick(payload, "assignee", "rectified_by") ?? "",
      PLAN_LINE_ID: planLineId,
      RELATED_OBJECT_TYPE: isRectification ? "Plan_Audit_Opinion" : "Packaging_Compliance_Finding",
      RELATED_OBJECT_ID: relatedId,
      TASK_SUMMARY: summary,
      TASK_STATUS: isRectification && decision === "approved" ? "已完成" : "待处理",
      CREATED_AT: now,
      DUE_AT: "",
      COMPLETED_AT: isRectification && decision === "approved" ? now : "",
      RESPONSE_NOTE: pick(payload, "response_note", "non_central_reason") ?? "",
      REJECTION_REASON: decision === "rejected" ? String(pick(payload, "response_note") ?? "撤回申报") : "",
    };
    appendIfTable(store, "de_digital_employee_task_t", row);
    if (isRectification) {
      upsertRow(store, "de_plan_audit_opinion_t", "AUDIT_OPINION_ID", String(auditOpinionId), {
        PLAN_ID: pick(payload, "plan_id") ?? "",
        PLAN_LINE_ID: planLineId,
        OPINION_STATUS: decision === "approved" ? "已整改" : decision === "rejected" ? "已撤回" : "待整改",
        RECTIFY_ADVICE: pick(payload, "rectify_advice", "intercept_items") ?? "",
        RECTIFIED_AT: decision === "approved" ? now : "",
        SUBMITTED_BY: pick(payload, "rectified_by") ?? "",
        NON_CENTRAL_REASON: pick(payload, "non_central_reason") ?? "",
      });
    } else {
      const findingId = String(pick(payload, "pkg_finding_id") ?? makeId("PCF"));
      upsertRow(store, "de_packaging_compliance_finding_t", "PKG_FINDING_ID", findingId, {
        PACKAGE_SCHEME_ID: pick(payload, "package_scheme_id") ?? "",
        CHECK_ITEM: pick(payload, "check_item") ?? "",
        CONCLUSION: pick(payload, "conclusion") ?? "",
        SPLIT_ADVICE: pick(payload, "split_advice") ?? "",
        SPECIAL_SOURCING_METHOD: special,
        SUPPLEMENT_TASK_CREATED: true,
        RECTIFY_ADVICE: pick(payload, "rectify_advice") ?? "",
        RESOLVED: false,
      });
      const schemeId = pick(payload, "package_scheme_id");
      if (schemeId !== undefined) {
        upsertRow(store, "de_package_scheme_t", "PACKAGE_SCHEME_ID", String(schemeId), {
          SCHEME_STATUS: "待调整",
          SPLIT_ADVICE: pick(payload, "split_advice") ?? "",
        });
      }
    }
    const logId = operationLog(store, {
      operation_type: isRectification ? "退回整改" : "组包预警推送",
      operator_role: isRectification ? "需求申请人" : "采购数字员工",
      operator: String(pick(payload, "rectified_by") ?? ""),
      plan_line_id: planLineId,
      related_object_type: row["RELATED_OBJECT_TYPE"] as string,
      related_object_id: relatedId,
      rule_hit: isRectification ? ["BR2-CENTRAL-03"] : ["BR2-PKG-01", "BR2-PKG-03", "BR2-FRAME-03"],
      api_called: "pushTask",
      decision_note: summary,
    });
    return {
      ok: true,
      id,
      row,
      operation_log_id: logId,
      task_context: {
        task_id: id,
        task_type: taskType,
        assigned_role: assignedRole,
        pkg_finding_id: pick(payload, "pkg_finding_id") ?? "",
        package_scheme_id: pick(payload, "package_scheme_id") ?? "",
        check_item: pick(payload, "check_item") ?? "",
        rectify_advice: pick(payload, "rectify_advice") ?? "",
        split_advice: pick(payload, "split_advice") ?? "",
        special_sourcing_method: special,
        plan_id: pick(payload, "plan_id") ?? "",
        plan_line_id: planLineId,
        scan_date: pick(payload, "scan_date") ?? "",
      },
      return_context: {
        audit_opinion_id: auditOpinionId ?? "",
        task_id: id,
        assigned_role: assignedRole,
        returned_at: now,
        plan_id: pick(payload, "plan_id") ?? "",
        plan_line_id: planLineId,
        intercept_items: pick(payload, "intercept_items") ?? "",
        rectify_advice: pick(payload, "rectify_advice") ?? "",
      },
      rectification_context: {
        audit_opinion_id: auditOpinionId ?? "",
        task_id: id,
        non_central_reason: pick(payload, "non_central_reason") ?? "",
        rectified_at: now,
        rectified_by: pick(payload, "rectified_by") ?? "",
        response_note: pick(payload, "response_note") ?? "",
        plan_id: pick(payload, "plan_id") ?? "",
        plan_line_id: planLineId,
        scan_date: pick(payload, "scan_date") ?? "",
      },
    };
  },

  /** ⑧断 — 计划员确认草稿并选定组包方案（BR2-HITL-01）；驳回必须带原因（BR2-FEEDBACK-01）。 */
  writeOperationLog: (store, payload) => {
    const decision = String(pick(payload, "decision") ?? "approved");
    if (decision !== "approved" && decision !== "rejected") {
      throw new MockErpError(400, `unsupported decision: ${decision}`);
    }
    const schemeId = String(required(payload, "PACKAGE_SCHEME_ID", "package_scheme_id"));
    const actor = String(pick(payload, "selected_by", "rejected_by", "operator") ?? "");
    const reason = String(pick(payload, "rejection_reason") ?? "");
    if (decision === "approved" && !actor) {
      throw new MockErpError(400, "BR2-HITL-01: selected_by is required to confirm the draft");
    }
    if (decision === "rejected" && !reason) {
      throw new MockErpError(400, "BR2-FEEDBACK-01: rejection_reason is required when rejecting");
    }
    const now = isoNow();
    const planId = String(pick(payload, "plan_id") ?? "");
    const planLineId = String(pick(payload, "plan_line_id") ?? "");
    upsertRow(store, "de_package_scheme_t", "PACKAGE_SCHEME_ID", schemeId, {
      SCHEME_NO: pick(payload, "scheme_no") ?? schemeId,
      PLAN_ID: planId,
      SCHEME_STATUS: decision === "approved" ? "已选定" : "未采纳",
      SELECTED_BY: decision === "approved" ? actor : "",
      SELECTED_AT: decision === "approved" ? now : "",
      REJECTION_REASON: reason,
    });
    if (decision === "approved" && planLineId) {
      const line = rowsIfTable(store, "ss_pbp_line_t").find((row) => row["PBP_LINE_ID"] === planLineId);
      if (line) {
        line["DRAFT_CONFIRMED_BY"] = actor;
        line["DRAFT_CONFIRMED_AT"] = now;
        line["LINE_STATUS"] = "已确认";
      }
    }
    for (const task of rowsIfTable(store, "de_digital_employee_task_t")) {
      if (task["RELATED_OBJECT_ID"] === planId && task["TASK_STATUS"] === "待处理") {
        task["TASK_STATUS"] = "已完成";
        task["COMPLETED_AT"] = now;
        task["RESPONSE_NOTE"] = decision === "approved" ? `选定 ${schemeId}` : reason;
      }
    }
    const logId = operationLog(store, {
      operation_type: "确认草稿与组包方案",
      operator_role: "采购计划员",
      operator: actor,
      plan_line_id: planLineId,
      related_object_type: "Package_Scheme",
      related_object_id: schemeId,
      rule_hit: decision === "approved" ? ["BR2-HITL-01"] : ["BR2-FEEDBACK-01"],
      api_called: "writeOperationLog",
      decision_note: decision === "approved" ? `确认草稿并选定 ${schemeId}` : `驳回：${reason}`,
    });
    return {
      ok: true,
      id: logId,
      decision,
      confirm_context: {
        package_scheme_id: schemeId,
        scheme_no: pick(payload, "scheme_no") ?? "",
        plan_id: planId,
        plan_line_id: planLineId,
        package_id: pick(payload, "package_id") ?? "",
        selected_by: actor,
        selected_at: now,
        comment: pick(payload, "comment") ?? "",
      },
      rejection_context: {
        package_scheme_id: schemeId,
        rejection_reason: reason,
        rejected_by: actor,
        rejected_at: now,
        plan_id: planId,
        plan_line_id: planLineId,
      },
    };
  },

  /**
   * ⑦行 — 按推荐方案生成采购包头行，并在 ERP 写边界内做框架协议命中
   * （BR2-FRAME-01/02）、集采层级与审批流程模板标注（BR2-CENTRAL-02/04）、
   * 特殊采购方式待办（BR2-FRAME-03）。
   */
  createProcPackageLines: (store, payload) => {
    const schemes = arr(pick(payload, "package_schemes"));
    const scheme = ((pick(payload, "recommended_scheme") as Row | undefined) ??
      schemes.find((candidate) => pick(candidate, "is_recommended") === true) ??
      schemes[0]) as Row | undefined;
    if (!scheme) throw new MockErpError(400, "createProcPackageLines: no package scheme in payload");
    const lines = arr(pick(scheme, "package_lines", "lines"));
    if (lines.length === 0) throw new MockErpError(400, "createProcPackageLines: package scheme has no lines");
    const schemeId = String(pick(scheme, "package_scheme_id") ?? pick(payload, "package_scheme_id") ?? makeId("PS"));
    const unit = String(pick(scheme, "management_unit") ?? pick(lines[0]!, "management_unit") ?? "");
    const todayIso = String(pick(payload, "scan_date") ?? today());
    const now = isoNow();

    // BR2-FRAME-01/02 — frame agreement match by material + management unit.
    const spaHeaders = rowsIfTable(store, "ss_spa_header_t");
    const spaLines = rowsIfTable(store, "ss_spa_line_t");
    let frameHit = false;
    let frameNo = "";
    let frameHeaderId = "";
    let frameLineId = "";
    let quotaSufficient = true;
    let demandAmount = 0;
    for (const line of lines) {
      const material = String(pick(line, "material_code", "item_code") ?? "");
      const quantity = num(pick(line, "quantity")) ?? 0;
      const price = num(pick(line, "unit_price")) ?? 0;
      demandAmount += quantity * price;
      for (const spaLine of spaLines) {
        if (spaLine["MATERIAL_CODE"] !== material) continue;
        const header = spaHeaders.find((candidate) => candidate["SPA_HEADER_ID"] === spaLine["SPA_HEADER_ID"]);
        if (!header) continue;
        const valid =
          header["IS_VALID"] === "Y" &&
          header["CLOSED_STATUS"] === "未关闭" &&
          String(header["DISABLE_DATE"] ?? "") > todayIso &&
          (!unit || header["MANAGEMENT_UNIT"] === unit);
        if (!valid) continue;
        frameHit = true;
        frameNo = String(header["AGREEMENT_NO"] ?? header["SPA_NUMBER"] ?? "");
        frameHeaderId = String(header["SPA_HEADER_ID"] ?? "");
        frameLineId = String(spaLine["SPA_LINE_ID"] ?? "");
        quotaSufficient = (num(header["AVAILABLE_AMOUNT"]) ?? 0) >= demandAmount;
      }
    }

    // BR2-CENTRAL-02/04 — central catalog annotation on the package header.
    const catalog = rowsIfTable(store, "cfg_central_purchase_catalog_t").filter(
      (row) => row["IS_ENABLED"] === "Y" && lines.some((line) => pick(line, "material_code", "item_code") === row["MATERIAL_CODE"]),
    );
    const rank = (level: unknown): number => (level === "一级集采" ? 2 : level === "二级集采" ? 1 : 0);
    const top = catalog.reduce<Row | null>((best, row) => (!best || rank(row["CENTRAL_LEVEL"]) > rank(best["CENTRAL_LEVEL"]) ? row : best), null);
    const centralLevel = String(top?.["CENTRAL_LEVEL"] ?? "非集采");
    const centralPattern = String(top?.["CENTRAL_PATTERN"] ?? "常规采购");
    const approveFlow = String(top?.["APPROVE_FLOW_CODE"] ?? "FLOW-BU-STD");
    if (centralLevel === "一级集采" && !approveFlow) {
      throw new MockErpError(400, "BR2-CENTRAL-04: 一级集采 requires a group-level approve_flow_code");
    }
    const special = String(pick(scheme, "special_sourcing_method") ?? "无");

    const packageId = makeId("PKG");
    const header: Row = {
      PROC_PACKAGE_HEADER_ID: packageId,
      PACKAGE_NO: packageId,
      PACKAGE_NAME: String(pick(scheme, "scheme_no") ?? schemeId),
      PACKAGE_SCHEME_ID: schemeId,
      PURCHASING_GROUP_NO: String(pick(scheme, "purchasing_group_no") ?? ""),
      SCENARIO_CODE: String(pick(scheme, "scenario_code") ?? "常规寻源"),
      STATUS: "草稿",
      CENTRAL_PURCHASE_LEVEL: centralLevel,
      CENTRAL_PURCHASE_PATTERN: centralPattern,
      APPROVE_FLOW_CODE: approveFlow,
      SPECIAL_SOURCING_METHOD: special,
      FRAME_HIT: frameHit ? "Y" : "N",
      FRAME_AGREEMENT_NO: frameNo,
      LAST_UPDATE_DATE: now,
      EXPECTED_FINISH_SOURCING_DATE: "",
    };
    store.rows("ss_proc_package_header_t").push(header);
    const packageLines = rowsIfTable(store, "ss_proc_package_line_t");
    let firstPlanLineId = "";
    lines.forEach((line, index) => {
      const planLineId = String(pick(line, "plan_line_id") ?? "");
      if (!firstPlanLineId) firstPlanLineId = planLineId;
      packageLines.push({
        PACKAGE_LINE_ID: `${packageId}-${String(index + 1).padStart(2, "0")}`,
        PACKAGE_ID: packageId,
        PLAN_LINE_ID: planLineId,
        SOURCE_OBJECT_TYPE: "PBP_LINE",
        MATERIAL_CODE: String(pick(line, "material_code", "item_code") ?? ""),
        MANAGEMENT_UNIT: String(pick(line, "management_unit") ?? unit),
        INVENTORY_ORGANIZATION: String(pick(line, "inventory_organization") ?? ""),
        CATEGORY_ID: String(pick(line, "category_id") ?? ""),
        QUANTITY: num(pick(line, "quantity")) ?? 0,
        REQUIRED_ARRIVAL_DATE: String(pick(line, "required_arrival_date") ?? ""),
        SOURCING_METHOD: String(pick(line, "sourcing_method") ?? "公开询价"),
        PLANNER: String(pick(payload, "planner") ?? ""),
        FRAME_AGREEMENT_ID: frameHit ? frameHeaderId : "",
        FRAME_AGREEMENT_ITEM_ID: frameHit ? frameLineId : "",
        FRAME_AGREEMENT_NO: frameNo,
        FRAME_HIT: frameHit ? "Y" : "N",
      });
    });
    upsertRow(store, "de_package_scheme_t", "PACKAGE_SCHEME_ID", schemeId, {
      SCHEME_NO: pick(scheme, "scheme_no") ?? schemeId,
      PLAN_ID: pick(scheme, "plan_id") ?? pick(payload, "plan_id") ?? "",
      MATCH_SCORE: num(pick(scheme, "match_score")) ?? 0,
      LINE_COUNT: lines.length,
      TOTAL_AMOUNT: demandAmount,
      FRAME_HIT: frameHit,
      FRAME_AGREEMENT_NO: frameNo,
      FRAME_QUOTA_SUFFICIENT: quotaSufficient,
      CENTRAL_LEVEL: centralLevel,
      CENTRAL_PATTERN: centralPattern,
      APPROVE_FLOW_CODE: approveFlow,
      SPECIAL_SOURCING_METHOD: special,
      SCHEME_STATUS: "待选择",
      GENERATED_PACKAGE_ID: packageId,
      SIBLING_SCHEME_COUNT: num(pick(scheme, "sibling_scheme_count")) ?? schemes.length,
      IS_RECOMMENDED: true,
    });
    let supplementTaskId = "";
    if (special !== "无") {
      supplementTaskId = makeId("TSK");
      appendIfTable(store, "de_digital_employee_task_t", {
        TASK_ID: supplementTaskId,
        TASK_TYPE: "特殊采购方式补充说明",
        ASSIGNED_ROLE: "集采管理岗",
        ASSIGNEE: "",
        PLAN_LINE_ID: firstPlanLineId,
        RELATED_OBJECT_TYPE: "Package_Scheme",
        RELATED_OBJECT_ID: schemeId,
        TASK_SUMMARY: `方案 ${schemeId} 识别为 ${special}，需集采管理岗补充说明（BR2-FRAME-03）`,
        TASK_STATUS: "待处理",
        CREATED_AT: now,
      });
    }
    const logId = operationLog(store, {
      operation_type: "框架集采标注与采购包生成",
      operator_role: "采购数字员工",
      plan_line_id: firstPlanLineId,
      related_object_type: "Sourcing_Package",
      related_object_id: packageId,
      rule_hit: ["BR2-FRAME-01", "BR2-FRAME-02", "BR2-CENTRAL-02", "BR2-CENTRAL-04", "BR2-FRAME-03"],
      api_called: "createProcPackageLines",
      decision_note: `框架命中=${frameHit ? frameNo : "无"}，集采层级=${centralLevel}，审批流程=${approveFlow}`,
    });
    return {
      ok: true,
      id: packageId,
      row: header,
      applied: true,
      operation_log_id: logId,
      annotation_context: {
        package_scheme_id: schemeId,
        scheme_no: pick(scheme, "scheme_no") ?? schemeId,
        plan_id: pick(scheme, "plan_id") ?? pick(payload, "plan_id") ?? "",
        plan_line_id: firstPlanLineId,
        package_id: packageId,
        line_count: lines.length,
        frame_hit: frameHit,
        frame_agreement_no: frameNo,
        frame_quota_sufficient: quotaSufficient,
        central_level: centralLevel,
        central_pattern: centralPattern,
        approve_flow_code: approveFlow,
        special_sourcing_method: special,
        supplement_task_id: supplementTaskId,
        match_score: num(pick(scheme, "match_score")) ?? 0,
        sibling_scheme_count: num(pick(scheme, "sibling_scheme_count")) ?? schemes.length,
        scan_date: pick(payload, "scan_date") ?? "",
      },
    };
  },

  /** ⑨行 — 确认后的执行计划与采购包提交审批，并封存本轮作业留痕（BR2-HITL-01 / BR2-AUDIT-01）。 */
  submitApproval: (store, payload) => {
    const planId = String(required(payload, "PLAN_ID", "plan_id"));
    if (!pick(payload, "selected_by")) {
      throw new MockErpError(400, "BR2-HITL-01: selected_by is required — 未经计划员确认不得提交审批");
    }
    const schemeId = String(pick(payload, "package_scheme_id") ?? "");
    const now = isoNow();
    const header = rowsIfTable(store, "ss_pbp_header_t").find((row) => row["PBP_HEADER_ID"] === planId);
    if (!header) throw new MockErpError(404, `ss_pbp_header_t: no row with PBP_HEADER_ID=${planId}`);
    header["STATUS"] = "审批中";
    header["SUBMITTED_AT"] = now;
    const packages = rowsIfTable(store, "ss_proc_package_header_t");
    const explicitPackageId = String(pick(payload, "package_id") ?? "");
    const pkg =
      packages.find((row) => explicitPackageId && row["PROC_PACKAGE_HEADER_ID"] === explicitPackageId) ??
      packages.find((row) => schemeId && row["PACKAGE_SCHEME_ID"] === schemeId);
    if (pkg) {
      pkg["STATUS"] = "审批中";
      pkg["PACKAGED_AT"] = now;
    }
    const approveFlow = String(pkg?.["APPROVE_FLOW_CODE"] ?? pick(payload, "approve_flow_code") ?? "");
    if (schemeId) {
      upsertRow(store, "de_package_scheme_t", "PACKAGE_SCHEME_ID", schemeId, {
        SCHEME_STATUS: "已生成采购包",
        GENERATED_PACKAGE_ID: pkg?.["PROC_PACKAGE_HEADER_ID"] ?? "",
        GENERATED_AT: now,
      });
    }
    const logId = operationLog(store, {
      operation_type: "提交审批并封存留痕",
      operator_role: "采购数字员工",
      operator: String(pick(payload, "selected_by") ?? ""),
      plan_line_id: pick(payload, "plan_line_id") ?? "",
      related_object_type: "Procurement_Plan",
      related_object_id: planId,
      rule_hit: ["BR2-HITL-01", "BR2-AUDIT-01"],
      api_called: "submitApproval",
      decision_note: `执行计划 ${planId} 与采购包 ${pkg?.["PROC_PACKAGE_HEADER_ID"] ?? "（无）"} 提交审批，审批流程 ${approveFlow || "（默认）"}`,
    });
    return {
      ok: true,
      id: planId,
      row: header,
      operation_log_id: logId,
      submission_context: {
        plan_id: planId,
        package_id: pkg?.["PROC_PACKAGE_HEADER_ID"] ?? "",
        package_scheme_id: schemeId,
        approve_flow_code: approveFlow,
        submitted_at: now,
        trace_sealed: true,
      },
    };
  },
};
