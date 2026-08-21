/**
 * Shared helpers for the Phase 4 E2E suite.
 *
 * Centralises a few constants so a `PW_API_BASE` override is honoured
 * everywhere, and exposes a thin `apiFetch` wrapper that defaults to the
 * dev tenant (`raas`) cookie so unauthenticated 401s don't masquerade as
 * functional bugs.
 *
 * The fixtures here are deliberately small — most assertions live inside
 * the spec files so a CI failure links the user straight to the relevant
 * file:line.
 */

import type { Page } from "@playwright/test";

export const API_BASE = process.env.PW_API_BASE ?? "http://localhost:3540";
export const WEB_BASE = process.env.PW_WEB_BASE ?? "http://localhost:3599";
const bootstrapEmail = process.env.AGENTIC_BOOTSTRAP_ADMIN_EMAIL?.trim();
const bootstrapPassword = process.env.AGENTIC_BOOTSTRAP_ADMIN_PASSWORD;
if (!bootstrapEmail || !bootstrapPassword) {
  throw new Error(
    "AGENTIC_BOOTSTRAP_ADMIN_EMAIL and AGENTIC_BOOTSTRAP_ADMIN_PASSWORD are required for authenticated E2E tests",
  );
}
export const BOOTSTRAP_ADMIN_EMAIL = bootstrapEmail;
export const BOOTSTRAP_ADMIN_PASSWORD = bootstrapPassword;

/** Sign in through the same password endpoint and form used by operators. */
export async function loginBootstrapAdmin(
  page: Page,
  returnPath = "/portal/raas/dashboard",
): Promise<void> {
  await page.goto(`/sign-in?return=${encodeURIComponent(returnPath)}`);
  await page.getByLabel(/email|邮箱/i).fill(BOOTSTRAP_ADMIN_EMAIL);
  // Constrained to the input on purpose: the field's reveal toggle carries
  // aria-label "Show password"/"显示密码", which this same pattern matches, and
  // two hits is a strict-mode violation rather than a wrong-element bug.
  await page
    .getByLabel(/password|密码/i)
    .and(page.locator("input"))
    .fill(BOOTSTRAP_ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/portal\//, { timeout: 15_000 });
}

interface JsonOk<T> {
  ok: true;
  data: T;
}
interface JsonErr {
  ok: false;
  error: { code: string; message: string; hint?: string };
}
export type Envelope<T> = JsonOk<T> | JsonErr;

/**
 * Issue a JSON request to apps/api.
 *
 * Authentication: CI starts the API in explicit NODE_ENV=test/AUTH_MODE=dev
 * and pins the explicitly configured bootstrap database user. Pass
 * `tenantSlug` when a request must
 * select a tenant different from the configured test tenant.
 *
 * Returns parsed JSON envelope or throws if the body isn't JSON.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit & { tenantSlug?: string } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const { tenantSlug, ...rest } = init;
  const headers = new Headers(rest.headers ?? {});
  if (!headers.has("content-type") && rest.body != null) {
    headers.set("content-type", "application/json");
  }
  if (tenantSlug) {
    // The dev auth plugin reads AGENTIC_DEV_TENANT process-wide, but
    headers.set("x-agentic-tenant", tenantSlug);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
  });
  const text = await res.text();
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(
      `apiFetch: response was not JSON (status=${res.status}, body=${text.slice(0, 200)})`,
    );
  }
  return { status: res.status, body };
}

/**
 * Poll a predicate until it returns truthy or the timeout elapses.
 * Used for "wait until the run/event/task row shows up" patterns. Each
 * iteration sleeps `intervalMs` (default 200 ms) so a 10 s timeout is
 * ~50 attempts.
 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const label = opts.label ?? "predicate";
  if (lastErr instanceof Error) {
    throw new Error(`waitFor(${label}) timed out: ${lastErr.message}`);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

/**
 * Probe a single SSE event matching a predicate. Resolves with the parsed
 * event, or rejects on timeout. Useful for asserting that a `run.completed`
 * SSE frame fires after an invoke.
 */
export async function readSseUntil(
  url: string,
  match: (evt: { event: string; data: string }) => boolean,
  timeoutMs = 20_000,
): Promise<{ event: string; data: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE upstream returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream closed before match");
      buf += decoder.decode(value, { stream: true });
      // SSE frames are double-newline-terminated.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split("\n");
        let event = "message";
        let data = "";
        for (const ln of lines) {
          if (ln.startsWith("event:")) event = ln.slice(6).trim();
          else if (ln.startsWith("data:")) data += ln.slice(5).trim();
        }
        const evt = { event, data };
        if (match(evt)) {
          ac.abort();
          return evt;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tiny `sleep(ms)` wrapper for spec-local pacing. Prefer `waitFor` over
 * raw sleeps; this exists for boot-pause cases where we genuinely need
 * to give the inngest dev runner a beat to wire up.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
