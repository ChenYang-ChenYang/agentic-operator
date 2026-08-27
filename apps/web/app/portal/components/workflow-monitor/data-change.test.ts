/**
 * Tests for the evidence → business-language reading (§G4, ask 3).
 *
 * The shapes below are copied from real power-scm evidence artifacts, so the
 * read/write discrimination is pinned against what the runtime actually emits
 * rather than against an idealised contract.
 */
import { describe, expect, it } from "vitest";
import { readDataChange } from "./data-change";

describe("readDataChange", () => {
  it("reads a mutation receipt as a write, with its document id and row", () => {
    const change = readDataChange({
      name: "metaerp.invoke",
      input: { operation: "createTransferOrder", payload: { qty: 400 } },
      output: {
        ok: true,
        id: "TRF-1787283461532-45",
        row: {
          TRANSFER_ID: "TRF-1787283461532-45",
          MATERIAL_CODE: "MAT-ST-P12",
          FROM_WH: "Warehouse-WZ-01",
          EMPTY_FIELD: "",
        },
      },
      dispatch: { sandbox_decision: "live" },
    });

    expect(change?.kind).toBe("write");
    expect(change?.operation).toBe("createTransferOrder");
    expect(change?.documentId).toBe("TRF-1787283461532-45");
    expect(change?.live).toBe(true);
    // Empty columns are dropped; order follows the row, not the alphabet.
    expect(change?.fields.map((f) => f.key)).toEqual([
      "TRANSFER_ID",
      "MATERIAL_CODE",
      "FROM_WH",
    ]);
  });

  it("reads a query as a read, with the count and a first-row preview", () => {
    const change = readDataChange({
      input: { operation: "queryContracts", payload: { SUPPLIER_ID: "SUP-001" } },
      output: {
        rows: [
          { CONTRACT_ID: "CT-2026-101", CONTRACT_AMT: 9800000 },
          { CONTRACT_ID: "CT-2026-102", CONTRACT_AMT: 5200000 },
        ],
      },
      dispatch: { sandbox_decision: "live" },
    });

    expect(change?.kind).toBe("read");
    expect(change?.rowCount).toBe(2);
    expect(change?.fields).toEqual([
      { key: "CONTRACT_ID", value: "CT-2026-101" },
      { key: "CONTRACT_AMT", value: "9800000" },
    ]);
  });

  it("reports an empty query as a read of zero rows, not as unknown", () => {
    const change = readDataChange({
      input: { operation: "queryContracts" },
      output: { rows: [] },
    });
    expect(change?.kind).toBe("read");
    expect(change?.rowCount).toBe(0);
    expect(change?.fields).toEqual([]);
  });

  it("surfaces an errored call as an error with its message", () => {
    const change = readDataChange({
      input: { operation: "createEmergencyPo" },
      is_error: true,
      output: { error: "supplier not found" },
    });
    expect(change?.kind).toBe("error");
    expect(change?.errorText).toBe("supplier not found");
  });

  it("marks a sandboxed call as not live", () => {
    const change = readDataChange({
      input: { operation: "createRfq" },
      output: { ok: true, id: "RFQ-1" },
      dispatch: { sandbox_decision: "sandbox" },
    });
    expect(change?.live).toBe(false);
  });

  it("falls back to the request when the output shape is unrecognised", () => {
    const change = readDataChange({
      input: { operation: "weirdOp", payload: { LOT_ID: "InventoryLot-008" } },
      output: "just a string",
    });
    expect(change?.kind).toBe("unknown");
    expect(change?.operation).toBe("weirdOp");
    expect(change?.fields).toEqual([{ key: "LOT_ID", value: "InventoryLot-008" }]);
  });

  it("returns null for a missing artifact rather than throwing", () => {
    expect(readDataChange(null)).toBeNull();
    expect(readDataChange(undefined)).toBeNull();
  });
});
