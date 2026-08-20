import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type MockErpApp } from "../src/app.js";

let ctx: MockErpApp;
let stateDir: string;

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-erp-test-"));
  ctx = buildApp({ stateDir });
  await ctx.app.ready();
});

afterAll(async () => {
  await ctx.app.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("boot + health", () => {
  it("loads all stub entities and both op catalogs", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.entities).toBe(24);
    expect(body.ops.query).toBe(24);
    expect(body.ops.write).toBe(15);
  });
});

describe("query ops", () => {
  it("returns all stub rows without filters", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/metaerp/openapi/v1/queryRequisitions",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { rows } = res.json();
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveProperty("REQ_ID");
  });

  it("applies exact-match body filters", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/metaerp/openapi/v1/queryInventoryLots",
      payload: { STATUS: "available", WAREHOUSE_ID: "Warehouse-ST-01" },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = res.json();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.STATUS).toBe("available");
      expect(row.WAREHOUSE_ID).toBe("Warehouse-ST-01");
    }
  });

  it("404s an unknown operation", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/metaerp/openapi/v1/queryNothing",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("write ops", () => {
  it("createTransferOrder appends a proposed row and journals it", async () => {
    const before = await ctx.app
      .inject({ method: "POST", url: "/metaerp/openapi/v1/queryTransferOrders", payload: {} })
      .then((r) => r.json().rows.length);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/metaerp/openapi/v1/createTransferOrder",
      payload: {
        material_id: "MAT-ST-P12",
        from_warehouse: "Warehouse-WZ-01",
        to_warehouse: "Warehouse-ST-01",
        qty: 1200,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^TRF-/);
    expect(body.row.STATUS).toBe("proposed");
    expect(body.row.MATERIAL_CODE).toBe("MAT-ST-P12");
    expect(body.row.QTY).toBe(1200);

    const after = await ctx.app
      .inject({ method: "POST", url: "/metaerp/openapi/v1/queryTransferOrders", payload: {} })
      .then((r) => r.json().rows.length);
    expect(after).toBe(before + 1);

    const journal = await ctx.app
      .inject({ method: "GET", url: "/__journal" })
      .then((r) => r.json());
    const entry = journal.entries.find(
      (e: { op: string; result: { id?: string } }) =>
        e.op === "createTransferOrder" && e.result.id === body.id,
    );
    expect(entry).toBeDefined();
    expect(entry.payload.qty).toBe(1200);
  });

  it("suspendRequisition flips STATUS on the matched row", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/metaerp/openapi/v1/suspendRequisition",
      payload: { REQ_ID: "REQ-2026-1101" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().row.STATUS).toBe("suspended");

    const rows = await ctx.app
      .inject({
        method: "POST",
        url: "/metaerp/openapi/v1/queryRequisitions",
        payload: { REQ_ID: "REQ-2026-1101" },
      })
      .then((r) => r.json().rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].STATUS).toBe("suspended");
  });

  it("404s a modify op targeting a missing row", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/metaerp/openapi/v1/lockInventoryLot",
      payload: { LOT_ID: "InventoryLot-does-not-exist" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().ok).toBe(false);
  });
});

describe("reset", () => {
  it("restores pristine stub rows and truncates the journal", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/__reset" });
    expect(res.statusCode).toBe(200);

    const transfers = await ctx.app
      .inject({ method: "POST", url: "/metaerp/openapi/v1/queryTransferOrders", payload: {} })
      .then((r) => r.json().rows);
    expect(transfers).toHaveLength(2);

    const reqs = await ctx.app
      .inject({
        method: "POST",
        url: "/metaerp/openapi/v1/queryRequisitions",
        payload: { REQ_ID: "REQ-2026-1101" },
      })
      .then((r) => r.json().rows);
    expect(reqs[0].STATUS).toBe("approved");

    const journal = await ctx.app
      .inject({ method: "GET", url: "/__journal" })
      .then((r) => r.json());
    expect(journal.entries).toHaveLength(0);
  });
});

describe("ui", () => {
  it("serves the transfers page with table + create form", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/ui/transfers" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("TRF-2026-0301");
    expect(res.body).toContain("create-transfer");
    expect(res.body).toContain("createTransferOrder");
  });

  it("serves the requisitions page with suspend buttons", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/ui/requisitions" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("REQ-2026-1101");
    expect(res.body).toContain("suspendRequisition");
  });
});
