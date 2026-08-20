/**
 * BrowserSessionManager — module-level registry of live Playwright sessions
 * used by the browser.* computer-use tool family (design §G5).
 *
 * One session = one Chromium browser + context + page. Sessions are addressed
 * by an opaque `sessionId` that the LLM threads through subsequent calls
 * (navigate / read / click / fill / screenshot / closeSession).
 *
 * Lifecycle guarantees:
 *   - max 4 concurrent sessions (opening a 5th throws with a clear message);
 *   - an idle session is reaped after 5 minutes (TTL measured from the last
 *     tool call that touched it); the reaper timer is unref'd so it never
 *     keeps the process alive;
 *   - headless by default (BROWSER_TOOLS_HEADFUL=1 flips it for local demos).
 *
 * Executable resolution (fail closed when nothing is found):
 *   1. env BROWSER_TOOLS_EXECUTABLE — absolute path, validated executable;
 *   2. Playwright channel "chrome" (a locally installed Google Chrome);
 *   3. /Applications/Google Chrome.app (macOS default install);
 *   4. /usr/bin/chromium* / /usr/bin/google-chrome* (Linux distros).
 *
 * The same child-isolation posture as document/convert.ts applies: system
 * Chromium via playwright-core (no bundled browser download), headless, no
 * sandbox surprises for containerized runs.
 */

import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright-core";

export const BROWSER_SESSION_TTL_MS = 5 * 60 * 1000;
export const BROWSER_SESSION_MAX = 4;

const EXECUTABLE_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

const NO_BROWSER_MESSAGE =
  "browser tools: no Chrome/Chromium executable found. Set BROWSER_TOOLS_EXECUTABLE " +
  "to an absolute browser path, install Google Chrome, or install a system chromium " +
  "(checked: BROWSER_TOOLS_EXECUTABLE, Playwright channel 'chrome', " +
  EXECUTABLE_CANDIDATES.join(", ") + ").";

function executable(pathname: string): boolean {
  if (!path.isAbsolute(pathname) || !existsSync(pathname)) return false;
  try {
    accessSync(pathname, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type BrowserLaunchPlan =
  | { kind: "executable"; executablePath: string }
  | { kind: "channel"; channel: "chrome" };

/**
 * Deterministic part of the resolution order. Returns null when neither the
 * env override nor a known filesystem candidate exists — the launcher then
 * still tries Playwright channel "chrome" before failing closed, because a
 * Chrome install can live at a non-default path Playwright knows about.
 */
export function resolveBrowserExecutable(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.BROWSER_TOOLS_EXECUTABLE?.trim();
  if (configured) {
    if (!executable(configured)) {
      throw new Error(
        `browser tools: BROWSER_TOOLS_EXECUTABLE ('${configured}') is not an executable absolute path.`,
      );
    }
    return configured;
  }
  for (const candidate of EXECUTABLE_CANDIDATES) {
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** True when SOME launch strategy is plausible on this machine (used by the
 * vitest E2E to skip explicitly instead of failing on CI boxes without any
 * browser). channel "chrome" is only plausible when a real Chrome exists. */
export function browserToolsAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    return resolveBrowserExecutable(env) !== null;
  } catch {
    return false;
  }
}

export interface BrowserSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

const LAUNCH_ARGS = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--no-default-browser-check",
  "--no-first-run",
  "--no-sandbox",
];

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private reaper: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(opts: { ttlMs?: number; maxSessions?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? BROWSER_SESSION_TTL_MS;
    this.maxSessions = opts.maxSessions ?? BROWSER_SESSION_MAX;
  }

  get size(): number {
    return this.sessions.size;
  }

  async open(
    url: string | undefined,
    env: Record<string, string | undefined> = process.env,
  ): Promise<BrowserSession> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `browser tools: session limit reached (${this.maxSessions}); close an ` +
          "existing session with browser.closeSession before opening another.",
      );
    }
    const headless = env.BROWSER_TOOLS_HEADFUL !== "1";
    const playwright = await import("playwright-core");
    const resolved = resolveBrowserExecutable(env);
    let browser: Browser;
    if (resolved) {
      browser = await playwright.chromium.launch({
        executablePath: resolved,
        headless,
        args: LAUNCH_ARGS,
      });
    } else {
      // Last resort before failing closed: let Playwright locate an installed
      // Google Chrome ("channel"); it throws when none is registered.
      try {
        browser = await playwright.chromium.launch({
          channel: "chrome",
          headless,
          args: LAUNCH_ARGS,
        });
      } catch (cause) {
        throw new Error(NO_BROWSER_MESSAGE, { cause });
      }
    }
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
      const session: BrowserSession = {
        sessionId: `bses-${randomBytes(8).toString("hex")}`,
        browser,
        context,
        page,
        lastUsedAt: Date.now(),
      };
      this.sessions.set(session.sessionId, session);
      this.ensureReaper();
      return session;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  /** Look up a live session and refresh its TTL. Unknown ids fail closed. */
  touch(sessionId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `browser tools: unknown or expired sessionId '${sessionId}'. Open a new ` +
          "session with browser.openSession (idle sessions are closed after 5 minutes).",
      );
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    await session.browser.close().catch(() => undefined);
    if (this.sessions.size === 0 && this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    return true;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastUsedAt > this.ttlMs) {
          this.sessions.delete(id);
          void session.browser.close().catch(() => undefined);
        }
      }
      if (this.sessions.size === 0 && this.reaper) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }, 30_000);
    // Never keep the api process (or vitest) alive just for the reaper.
    this.reaper.unref?.();
  }
}

/** Module-level singleton used by the registered browser.* tools. */
export const browserSessions = new BrowserSessionManager();
