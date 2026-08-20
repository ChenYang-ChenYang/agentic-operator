/**
 * browser.* — session-based computer-use tools over playwright-core + the
 * system Chrome/Chromium (design §G5). No bundled browser is downloaded; the
 * executable resolution and child isolation posture mirror document/convert.ts.
 *
 * Flow: browser.openSession → (navigate/read/click/fill/screenshot)* →
 * browser.closeSession, all keyed by the returned sessionId. Idle sessions
 * are reaped after 5 minutes; at most 4 sessions are live at once.
 *
 * Args come from ctx.event.data (the runtime substitutes the tool-call input
 * there); screenshots are persisted under data/browser-shots/<tenant>/ and
 * returned as a path, never as base64 through the model.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";

import { resolveDataRoot } from "../fs/_shared";
import { browserSessions } from "./session-manager";

type JsonRecord = Record<string, unknown>;

const READ_CAP_BYTES = 30 * 1024;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

function args(ctx: ToolContext): JsonRecord {
  return (ctx.event?.data ?? {}) as JsonRecord;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`browser tools: '${field}' must be a non-empty string`);
  }
  return value.trim();
}

function assertHttpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`browser tools: '${raw}' is not a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `browser tools: only http/https URLs are supported (got '${parsed.protocol}')`,
    );
  }
  return parsed.toString();
}

function capText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= READ_CAP_BYTES) {
    return { text, truncated: false };
  }
  // Cut on the byte budget, then drop a possibly torn trailing code point.
  const bytes = Buffer.from(text, "utf8").subarray(0, READ_CAP_BYTES);
  return {
    text: bytes.toString("utf8").replace(/�+$/u, ""),
    truncated: true,
  };
}

export const browserOpenSession = defineTool({
  name: "browser.openSession",
  description:
    "Open a new headless browser session (system Chrome/Chromium via playwright-core) and " +
    "optionally navigate to {url}. Returns {sessionId,title,url}; thread the sessionId " +
    "through subsequent browser.* calls. Sessions idle >5min are closed automatically; " +
    "at most 4 sessions may be open.",
  output: z.object({
    sessionId: z.string(),
    title: z.string(),
    url: z.string(),
  }),
  async handler(ctx) {
    const input = args(ctx);
    const url =
      input.url === undefined || input.url === null || input.url === ""
        ? undefined
        : assertHttpUrl(requiredString(input.url, "url"));
    const session = await browserSessions.open(url);
    return {
      data: {
        sessionId: session.sessionId,
        title: await session.page.title(),
        url: session.page.url(),
      },
      meta: { openSessions: browserSessions.size },
    };
  },
});

export const browserNavigate = defineTool({
  name: "browser.navigate",
  description:
    "Navigate an open browser session to {url} (http/https only). Returns the resulting " +
    "{title,url} after DOMContentLoaded.",
  output: z.object({ sessionId: z.string(), title: z.string(), url: z.string() }),
  async handler(ctx) {
    const input = args(ctx);
    const sessionId = requiredString(input.sessionId, "sessionId");
    const url = assertHttpUrl(requiredString(input.url, "url"));
    const session = browserSessions.touch(sessionId);
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_ACTION_TIMEOUT_MS,
    });
    return {
      data: { sessionId, title: await session.page.title(), url: session.page.url() },
    };
  },
});

export const browserRead = defineTool({
  name: "browser.read",
  description:
    "Read the current page of a browser session. mode 'text' (default) returns the " +
    "rendered inner text; mode 'a11y' returns the ARIA accessibility snapshot (roles + " +
    "names — the stable way to find click targets). Output is capped at 30KB.",
  output: z.object({
    sessionId: z.string(),
    mode: z.enum(["text", "a11y"]),
    title: z.string(),
    url: z.string(),
    content: z.string(),
    truncated: z.boolean(),
  }),
  async handler(ctx) {
    const input = args(ctx);
    const sessionId = requiredString(input.sessionId, "sessionId");
    const mode = input.mode === undefined ? "text" : input.mode;
    if (mode !== "text" && mode !== "a11y") {
      throw new Error("browser.read: mode must be 'text' or 'a11y'");
    }
    const session = browserSessions.touch(sessionId);
    const raw =
      mode === "a11y"
        ? await session.page.locator("body").ariaSnapshot()
        : await session.page.evaluate(() => document.body?.innerText ?? "");
    const { text, truncated } = capText(raw);
    return {
      data: {
        sessionId,
        mode,
        title: await session.page.title(),
        url: session.page.url(),
        content: text,
        truncated,
      },
    };
  },
});

/** Locate a click target either by CSS selector or by ARIA role+name. */
function clickTarget(
  session: ReturnType<typeof browserSessions.touch>,
  input: JsonRecord,
) {
  if (typeof input.selector === "string" && input.selector.trim()) {
    return session.page.locator(input.selector.trim()).first();
  }
  if (typeof input.role === "string" && input.role.trim()) {
    const name =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : undefined;
    return session.page
      .getByRole(input.role.trim() as Parameters<typeof session.page.getByRole>[0], {
        ...(name ? { name } : {}),
      })
      .first();
  }
  throw new Error(
    "browser.click: provide either {selector} or {role[, name]} to identify the element",
  );
}

export const browserClick = defineTool({
  name: "browser.click",
  description:
    "Click an element in a browser session, addressed by CSS {selector} or by ARIA " +
    "{role, name} (e.g. role='button', name='创建调拨单'). Waits for the element to be " +
    "actionable (10s timeout).",
  output: z.object({
    sessionId: z.string(),
    clicked: z.literal(true),
    title: z.string(),
    url: z.string(),
  }),
  async handler(ctx) {
    const input = args(ctx);
    const sessionId = requiredString(input.sessionId, "sessionId");
    const session = browserSessions.touch(sessionId);
    await clickTarget(session, input).click({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
    return {
      data: {
        sessionId,
        clicked: true as const,
        title: await session.page.title(),
        url: session.page.url(),
      },
    };
  },
});

export const browserFill = defineTool({
  name: "browser.fill",
  description:
    "Fill a form control in a browser session: CSS {selector} + string {value}. Clears " +
    "the field first (Playwright fill semantics).",
  output: z.object({
    sessionId: z.string(),
    filled: z.literal(true),
    selector: z.string(),
  }),
  async handler(ctx) {
    const input = args(ctx);
    const sessionId = requiredString(input.sessionId, "sessionId");
    const selector = requiredString(input.selector, "selector");
    if (typeof input.value !== "string" && typeof input.value !== "number") {
      throw new Error("browser.fill: 'value' must be a string (or number)");
    }
    const session = browserSessions.touch(sessionId);
    await session.page.fill(selector, String(input.value), {
      timeout: DEFAULT_ACTION_TIMEOUT_MS,
    });
    return { data: { sessionId, filled: true as const, selector } };
  },
});

export const browserScreenshot = defineTool({
  name: "browser.screenshot",
  description:
    "Capture a PNG screenshot of the session's current page and persist it under " +
    "data/browser-shots/<tenant>/. Returns the absolute file path (never base64).",
  output: z.object({
    sessionId: z.string(),
    path: z.string(),
    bytes: z.number().int().positive(),
    url: z.string(),
  }),
  async handler(ctx) {
    const input = args(ctx);
    const sessionId = requiredString(input.sessionId, "sessionId");
    const session = browserSessions.touch(sessionId);
    const png = await session.page.screenshot({ type: "png", fullPage: false });
    // ToolContext has no artifact helper seam today; the documented fallback
    // location is data/browser-shots/<tenant>/ (design §G5 artifact sidecar).
    const dir = path.join(
      resolveDataRoot(),
      "browser-shots",
      ctx.tenantSlug || "unknown-tenant",
    );
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(
      dir,
      `shot-${stamp}-${randomBytes(3).toString("hex")}.png`,
    );
    await writeFile(file, png);
    return {
      data: { sessionId, path: file, bytes: png.length, url: session.page.url() },
    };
  },
});

export const browserCloseSession = defineTool({
  name: "browser.closeSession",
  description:
    "Close a browser session and release its Chrome process. Idempotent — closing an " +
    "unknown/already-closed sessionId returns {closed:false}.",
  output: z.object({ sessionId: z.string(), closed: z.boolean() }),
  async handler(ctx) {
    const input = args(ctx);
    const sessionId = requiredString(input.sessionId, "sessionId");
    const closed = await browserSessions.close(sessionId);
    return { data: { sessionId, closed } };
  },
});
