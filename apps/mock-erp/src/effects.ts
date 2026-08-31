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
    const planLineId = String(required(payload, "PLAN_LINE_ID", "plan_line_id"));
    const newDate = String(required(payload, "REQUIRED_ARRIVAL_DATE", "required_arrival_date"));
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

  /** ⑥行 方案③ — 生成调拨申请单并取得 ERP 正式单号。 */
  createTransactionOrder: (store, payload) => {
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
};
