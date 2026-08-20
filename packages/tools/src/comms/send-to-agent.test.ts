/**
 * comms.sendToAgent — unit tests against an in-process HTTP server that
 * mimics the API's POST /v1/events envelope ({ok:true,data:{event_id,name}}).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  commsSendToAgent,
  defaultEventNameForAgent,
  sendToAgent,
} from "./send-to-agent";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

let server: http.Server;
let baseUrl: string;
const captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } = {
  status: 200,
  body: { ok: true, data: { event_id: "evt-test-1", name: "PSCM_TEST" } },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
      });
      res.writeHead(nextResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENTIC_SELF_BASE_URL: baseUrl,
    AGENTIC_SELF_API_TOKEN: "tok-secret-123",
    ...overrides,
  };
}

const ctx = { subject: "WO-2026-0812", correlationId: "corr-a2a-1" };

describe("comms.sendToAgent", () => {
  it("POSTs the durable ingest body with bearer + deterministic idempotency key", async () => {
    captured.length = 0;
    nextResponse = {
      status: 200,
      body: { ok: true, data: { event_id: "evt-abc", name: "PSCM_STOCK_GAP_CONFIRMED" } },
    };
    const result = await sendToAgent(
      {
        agent: "action-create-stock-transfer",
        event: "PSCM_STOCK_GAP_CONFIRMED",
        payload: { material_id: "MAT-ST-P12", gap_qty: 1200 },
      },
      ctx,
      {},
      env(),
    );
    expect(result).toEqual({
      eventId: "evt-abc",
      name: "PSCM_STOCK_GAP_CONFIRMED",
      agent: "action-create-stock-transfer",
      subject: "WO-2026-0812",
    });
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/events");
    expect(req.headers.authorization).toBe("Bearer tok-secret-123");
    expect(req.headers["idempotency-key"]).toBe(
      "a2a-corr-a2a-1-action-create-stock-transfer-PSCM_STOCK_GAP_CONFIRMED-WO-2026-0812",
    );
    expect(req.body).toEqual({
      name: "PSCM_STOCK_GAP_CONFIRMED",
      subject: "WO-2026-0812",
      payload: { material_id: "MAT-ST-P12", gap_qty: 1200 },
      source: "system",
      targetAgent: "action-create-stock-transfer",
    });
  });

  it("defaults the event name to the synthetic manual trigger and payload to {}", async () => {
    captured.length = 0;
    nextResponse = {
      status: 200,
      body: {
        ok: true,
        data: { event_id: "evt-def", name: "MANUAL_ACTION_LOCK_SAFETY_STOCK" },
      },
    };
    const result = await sendToAgent(
      { agent: "action-lock-safety-stock" },
      ctx,
      {},
      env(),
    );
    expect(defaultEventNameForAgent("action-lock-safety-stock")).toBe(
      "MANUAL_ACTION_LOCK_SAFETY_STOCK",
    );
    expect(result.eventId).toBe("evt-def");
    expect((captured[0]!.body as { name: string }).name).toBe(
      "MANUAL_ACTION_LOCK_SAFETY_STOCK",
    );
    expect((captured[0]!.body as { payload: unknown }).payload).toEqual({});
  });

  it("fails closed when the origin or token env var is unset", async () => {
    await expect(
      sendToAgent({ agent: "a" }, ctx, {}, { AGENTIC_SELF_API_TOKEN: "x" }),
    ).rejects.toThrow(/unset or empty server environment variable/);
    await expect(
      sendToAgent({ agent: "a" }, ctx, {}, { AGENTIC_SELF_BASE_URL: baseUrl }),
    ).rejects.toThrow(/unset or empty server environment variable/);
  });

  it("honours config-selected env names and custom timeout", async () => {
    captured.length = 0;
    nextResponse = {
      status: 200,
      body: { ok: true, data: { event_id: "evt-cfg", name: "X" } },
    };
    const result = await sendToAgent(
      { agent: "agent-x", event: "X", subject: "S-1" },
      ctx,
      { base_url_env: "MY_ORIGIN", api_key_env: "MY_TOKEN", timeout_ms: 5000 },
      { MY_ORIGIN: `${baseUrl}/`, MY_TOKEN: "tok-2" },
    );
    expect(result.eventId).toBe("evt-cfg");
    expect(captured[0]!.headers.authorization).toBe("Bearer tok-2");
    // Trailing slash on the origin must not produce //v1/events.
    expect(captured[0]!.url).toBe("/v1/events");
  });

  it("surfaces a non-2xx ingest rejection as a tool error with the diagnostic body", async () => {
    nextResponse = {
      status: 409,
      body: { ok: false, error: { code: "agent_not_live", message: "Agent 'ghost' is not in the live workflow" } },
    };
    await expect(
      sendToAgent({ agent: "ghost" }, ctx, {}, env()),
    ).rejects.toThrow(/HTTP 409.*agent_not_live/s);
  });

  it("rejects a non-object payload before any network call", async () => {
    await expect(
      sendToAgent({ agent: "a", payload: [1, 2] }, ctx, {}, env()),
    ).rejects.toThrow(/'payload' must be a JSON object/);
  });

  it("the registered descriptor reads args from ctx.event.data and config from ctx.config", async () => {
    captured.length = 0;
    nextResponse = {
      status: 200,
      body: { ok: true, data: { event_id: "evt-desc", name: "Y" } },
    };
    const previousOrigin = process.env.AGENTIC_SELF_BASE_URL;
    const previousToken = process.env.AGENTIC_SELF_API_TOKEN;
    process.env.AGENTIC_SELF_BASE_URL = baseUrl;
    process.env.AGENTIC_SELF_API_TOKEN = "tok-desc";
    try {
      const result = await commsSendToAgent.handler({
        agentName: "t",
        actionName: "comms.sendToAgent",
        correlationId: "corr-desc",
        tenantSlug: "power-scm",
        subject: "S-9",
        event: { name: "TOOL_CALL", data: { agent: "agent-y", event: "Y" } },
      });
      expect((result.data as { eventId: string }).eventId).toBe("evt-desc");
      expect((captured[0]!.body as { subject: string }).subject).toBe("S-9");
    } finally {
      if (previousOrigin === undefined) delete process.env.AGENTIC_SELF_BASE_URL;
      else process.env.AGENTIC_SELF_BASE_URL = previousOrigin;
      if (previousToken === undefined) delete process.env.AGENTIC_SELF_API_TOKEN;
      else process.env.AGENTIC_SELF_API_TOKEN = previousToken;
    }
  });
});
