import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import { metaerpInvoke, _clearMetaerpCatalogCacheForTests } from "./invoke";

let server: http.Server;
let base = "";
let tmpDir = "";
let catalogPath = "";
const requests: Array<{ url: string; body: unknown }> = [];

const CATALOG = {
  metadata: { tenant: "power-scm", schema: "erp-operations/v1" },
  operations: [
    {
      operation: "queryInventoryLots",
      path: "/metaerp/openapi/v1/queryInventoryLots",
      method: "POST",
      kind: "query",
      description: "按区域拉取实时库存",
    },
    {
      operation: "createTransferOrder",
      path: "/metaerp/openapi/v1/createTransferOrder",
      method: "POST",
      kind: "write",
      description: "创建调拨单",
    },
  ],
};

function ctx(
  args: Record<string, unknown>,
  config: Record<string, unknown>,
): ToolContext {
  return {
    agentName: "agent-lock-inventory",
    actionName: "metaerp.invoke",
    correlationId: "cor-metaerp-1",
    tenantSlug: "power-scm",
    event: { name: "PSCM_TEST", data: args },
    config,
  } as ToolContext;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "metaerp-invoke-"));
  catalogPath = path.join(tmpDir, "erp-operations.json");
  fs.writeFileSync(catalogPath, JSON.stringify(CATALOG), "utf8");

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({
        url: req.url ?? "",
        body: bodyText ? JSON.parse(bodyText) : null,
      });
      if (req.url === "/metaerp/openapi/v1/queryInventoryLots") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ rows: [{ LOT_ID: "LOT-1", STATUS: "AVAILABLE" }] }),
        );
        return;
      }
      if (req.url === "/metaerp/openapi/v1/createTransferOrder") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "TRF-0001" }));
        return;
      }
      if (req.url === "/metaerp/openapi/v1/broken") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  requests.length = 0;
  delete process.env.METAERP_BASE_URL;
  delete process.env.METAERP_TEST_ALT_URL;
  _clearMetaerpCatalogCacheForTests();
});

describe("metaerp.invoke", () => {
  it("happy path: posts the payload to the catalog path and returns parsed JSON + kind meta", async () => {
    process.env.METAERP_BASE_URL = base;
    const result = await metaerpInvoke.handler(
      ctx(
        { operation: "queryInventoryLots", payload: { REGION_NAME: "华东" } },
        { catalog_path: catalogPath },
      ),
    );
    expect(result.data).toEqual({
      rows: [{ LOT_ID: "LOT-1", STATUS: "AVAILABLE" }],
    });
    expect(result.meta).toMatchObject({
      operation: "queryInventoryLots",
      kind: "query",
      status: 200,
    });
    expect(requests).toEqual([
      {
        url: "/metaerp/openapi/v1/queryInventoryLots",
        body: { REGION_NAME: "华东" },
      },
    ]);
  });

  it("config.operation pin overrides args and classifies write ops", async () => {
    process.env.METAERP_BASE_URL = base;
    const result = await metaerpInvoke.handler(
      ctx(
        { payload: { FROM_WH: "WH-01", TO_WH: "WH-02" } },
        { catalog_path: catalogPath, operation: "createTransferOrder" },
      ),
    );
    expect(result.data).toEqual({ ok: true, id: "TRF-0001" });
    expect(result.meta).toMatchObject({
      operation: "createTransferOrder",
      kind: "write",
    });
  });

  it("rejects a call whose args.operation conflicts with the pinned operation", async () => {
    process.env.METAERP_BASE_URL = base;
    await expect(
      metaerpInvoke.handler(
        ctx(
          { operation: "queryInventoryLots" },
          { catalog_path: catalogPath, operation: "createTransferOrder" },
        ),
      ),
    ).rejects.toThrow(/pinned to operation 'createTransferOrder'/);
    expect(requests).toHaveLength(0);
  });

  it("enforces catalog membership — unknown operations never reach the wire", async () => {
    process.env.METAERP_BASE_URL = base;
    await expect(
      metaerpInvoke.handler(
        ctx({ operation: "dropAllTables" }, { catalog_path: catalogPath }),
      ),
    ).rejects.toThrow(/not in the catalog/);
    expect(requests).toHaveLength(0);
  });

  it("fails closed when the base-url env var is unset", async () => {
    await expect(
      metaerpInvoke.handler(
        ctx({ operation: "queryInventoryLots" }, { catalog_path: catalogPath }),
      ),
    ).rejects.toThrow(/METAERP_BASE_URL' is not set/);
    expect(requests).toHaveLength(0);
  });

  it("honours config.base_url_env as the env NAME", async () => {
    process.env.METAERP_TEST_ALT_URL = base;
    const result = await metaerpInvoke.handler(
      ctx(
        { operation: "queryInventoryLots" },
        { catalog_path: catalogPath, base_url_env: "METAERP_TEST_ALT_URL" },
      ),
    );
    expect(result.meta).toMatchObject({ status: 200 });
  });

  it("fails closed when the catalog file is missing", async () => {
    process.env.METAERP_BASE_URL = base;
    await expect(
      metaerpInvoke.handler(
        ctx(
          { operation: "queryInventoryLots" },
          { catalog_path: path.join(tmpDir, "does-not-exist.json") },
        ),
      ),
    ).rejects.toThrow(/operation catalog not readable/);
  });

  it("fails closed when config.catalog_path is absent", async () => {
    process.env.METAERP_BASE_URL = base;
    await expect(
      metaerpInvoke.handler(ctx({ operation: "queryInventoryLots" }, {})),
    ).rejects.toThrow(/catalog_path is required/);
  });

  it("throws a bounded diagnostic on non-2xx upstream responses", async () => {
    process.env.METAERP_BASE_URL = base;
    const brokenCatalog = path.join(tmpDir, "broken-catalog.json");
    fs.writeFileSync(
      brokenCatalog,
      JSON.stringify([
        { operation: "brokenOp", path: "/metaerp/openapi/v1/broken", kind: "query" },
      ]),
      "utf8",
    );
    await expect(
      metaerpInvoke.handler(
        ctx({ operation: "brokenOp" }, { catalog_path: brokenCatalog }),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("accepts a bare-array catalog and defaults the payload to {}", async () => {
    process.env.METAERP_BASE_URL = base;
    const bareCatalog = path.join(tmpDir, "bare-catalog.json");
    fs.writeFileSync(
      bareCatalog,
      JSON.stringify([
        {
          operation_id: "queryInventoryLots",
          endpoint: "/metaerp/openapi/v1/queryInventoryLots",
          kind: "read",
        },
      ]),
      "utf8",
    );
    const result = await metaerpInvoke.handler(
      ctx({ operation: "queryInventoryLots" }, { catalog_path: bareCatalog }),
    );
    expect(result.meta).toMatchObject({ kind: "query" });
    expect(requests[0]?.body).toEqual({});
  });
});

describe("metaerp.invoke · call receipt", () => {
  it("reports the URL it called and the body it sent", async () => {
    // An operator asked to trust that the ERP was written to needs to see the
    // request, not a claim that one happened.
    process.env.METAERP_BASE_URL = base;
    const result = await metaerpInvoke.handler(
      ctx(
        { operation: "createTransferOrder", payload: { LOT_ID: "LOT-1", QTY: 12 } },
        { catalog_path: catalogPath },
      ),
    );
    expect(result.meta).toMatchObject({
      url: `${base}/metaerp/openapi/v1/createTransferOrder`,
      request: { LOT_ID: "LOT-1", QTY: 12 },
      status: 200,
    });
  });
});
