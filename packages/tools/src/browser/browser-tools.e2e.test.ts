/**
 * browser.* E2E against a LOCAL page: boots apps/mock-erp (buildApp) on an
 * ephemeral port and drives the 创建调拨单 form on /ui/transfers with the real
 * system Chrome/Chromium. Skips explicitly (with a message) when no browser
 * executable exists on this machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type MockErpApp } from "@agentic/mock-erp";
import type { ToolContext } from "@agentic/agent-kit";

import {
  browserOpenSession,
  browserNavigate,
  browserRead,
  browserClick,
  browserFill,
  browserScreenshot,
  browserCloseSession,
} from "./tools";
import { browserSessions, browserToolsAvailable } from "./session-manager";

const available = browserToolsAvailable();

function ctx(input: Record<string, unknown>): ToolContext {
  return {
    agentName: "browser-e2e",
    actionName: "browser.tool",
    correlationId: "corr-browser-e2e",
    tenantSlug: "power-scm",
    event: { name: "TOOL_CALL", data: input },
  };
}

async function pollUntil<T>(
  probe: () => T | null,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("pollUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

if (!available) {
  // Make the skip loud in the reporter output instead of silently green.
  // eslint-disable-next-line no-console
  console.warn(
    "[browser-tools.e2e] SKIPPED: no Chrome/Chromium executable found " +
      "(BROWSER_TOOLS_EXECUTABLE unset, no /Applications/Google Chrome.app, no /usr/bin/chromium*).",
  );
}

describe.skipIf(!available)("browser.* E2E — drives mock-erp /ui/transfers", () => {
  let erp: MockErpApp;
  let baseUrl: string;
  let stateDir: string;
  let dataRoot: string;
  let previousDataRoot: string | undefined;
  let sessionId: string;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-e2e-erp-"));
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "browser-e2e-data-"));
    previousDataRoot = process.env.AGENTIC_DATA_ROOT;
    process.env.AGENTIC_DATA_ROOT = dataRoot;
    erp = buildApp({ stateDir });
    baseUrl = await erp.app.listen({ port: 0, host: "127.0.0.1" });
  }, 30_000);

  afterAll(async () => {
    await browserSessions.closeAll();
    await erp?.app.close();
    if (previousDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
    else process.env.AGENTIC_DATA_ROOT = previousDataRoot;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("opens a session on the transfers page", async () => {
    const result = await browserOpenSession.handler(
      ctx({ url: `${baseUrl}/ui/transfers` }),
    );
    const data = result.data as { sessionId: string; title: string; url: string };
    sessionId = data.sessionId;
    expect(sessionId).toMatch(/^bses-/);
    expect(data.title).toContain("调拨单");
    expect(data.url).toContain("/ui/transfers");
  }, 30_000);

  it("reads the page (text + a11y) and sees the create form", async () => {
    const text = await browserRead.handler(ctx({ sessionId, mode: "text" }));
    expect((text.data as { content: string }).content).toContain("创建调拨单");
    const a11y = await browserRead.handler(ctx({ sessionId, mode: "a11y" }));
    const snapshot = (a11y.data as { content: string }).content;
    expect(snapshot).toContain("创建调拨单");
    expect((a11y.data as { truncated: boolean }).truncated).toBe(false);
  }, 20_000);

  it("fills the 创建调拨单 form, submits, and the write lands in the ERP store + journal", async () => {
    const before = erp.store.rows("wm_transfer_order_t").length;
    const form = "#create-transfer";
    await browserFill.handler(
      ctx({ sessionId, selector: `${form} input[name='material_id']`, value: "MAT-BROWSER-E2E" }),
    );
    await browserFill.handler(
      ctx({ sessionId, selector: `${form} input[name='from_warehouse']`, value: "Warehouse-WZ-01" }),
    );
    await browserFill.handler(
      ctx({ sessionId, selector: `${form} input[name='to_warehouse']`, value: "Warehouse-ST-01" }),
    );
    await browserFill.handler(
      ctx({ sessionId, selector: `${form} input[name='qty']`, value: "1200" }),
    );
    const clicked = await browserClick.handler(
      ctx({ sessionId, role: "button", name: "创建调拨单" }),
    );
    expect((clicked.data as { clicked: boolean }).clicked).toBe(true);

    // The form posts via fetch to /metaerp/openapi/v1/createTransferOrder.
    const entry = await pollUntil(() => {
      const journal = erp.store.readJournal();
      return (
        journal.find(
          (row) =>
            row.op === "createTransferOrder" &&
            (row.payload as Record<string, unknown>).material_id === "MAT-BROWSER-E2E",
        ) ?? null
      );
    }, 8_000);
    expect((entry.result as { ok: boolean }).ok).toBe(true);
    expect(erp.store.rows("wm_transfer_order_t").length).toBe(before + 1);
    const created = erp.store
      .rows("wm_transfer_order_t")
      .find((row) => row.MATERIAL_CODE === "MAT-BROWSER-E2E" || row.material_id === "MAT-BROWSER-E2E");
    expect(created).toBeDefined();
  }, 30_000);

  it("captures a screenshot under data/browser-shots/<tenant>/", async () => {
    const shot = await browserScreenshot.handler(ctx({ sessionId }));
    const data = shot.data as { path: string; bytes: number };
    expect(data.path).toContain(path.join("browser-shots", "power-scm"));
    expect(fs.existsSync(data.path)).toBe(true);
    expect(data.bytes).toBeGreaterThan(1_000);
    // PNG magic bytes.
    const head = fs.readFileSync(data.path).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }, 20_000);

  it("navigates to another page within the same session", async () => {
    const nav = await browserNavigate.handler(
      ctx({ sessionId, url: `${baseUrl}/ui/requisitions` }),
    );
    expect((nav.data as { title: string }).title).toContain("采购需求");
  }, 20_000);

  it("closes the session idempotently", async () => {
    const first = await browserCloseSession.handler(ctx({ sessionId }));
    expect((first.data as { closed: boolean }).closed).toBe(true);
    const second = await browserCloseSession.handler(ctx({ sessionId }));
    expect((second.data as { closed: boolean }).closed).toBe(false);
  }, 20_000);

  it("fails closed on an unknown sessionId", async () => {
    await expect(
      browserRead.handler(ctx({ sessionId: "bses-does-not-exist" })),
    ).rejects.toThrow(/unknown or expired sessionId/);
  });
});
