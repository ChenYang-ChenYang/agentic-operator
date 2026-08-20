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
};
