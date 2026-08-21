/**
 * Pixel-diff harness for the App Router portal.
 *
 * Captures a 1440×900 screenshot of each of the 9 nav views and compares
 * it against a stored reference under `./v1_1-reference/<view>.png` with
 * a 0.1 % pixel-diff tolerance (FR-PORT-3).
 *
 * Reference images are checked in once and treated as the
 *   "design-locked" baseline. Re-generating requires an explicit
 *   `--update-snapshots` invocation by a human reviewer.
 *
 * Strategy:
 *   - Each view runs in its own `test()` so a single drift doesn't
 *     blast the whole suite.
 *   - We wait on `networkidle` to give SSE / TanStack hydration a
 *     chance to paint. The dashboard's event ticker is animated; we
 *     freeze it by setting `reducedMotion=reduce` AND injecting a
 *     CSS rule that pauses every animation.
 *   - Auth: the portal is gated. Tests sign in through the real password
 *     form using the explicitly configured bootstrap administrator.
 */

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const NAV_VIEWS = [
  "dashboard",
  "workflows",
  "agents",
  "runs",
  "events",
  "tasks",
  "logs",
  "deployments",
  "settings",
] as const;
type NavView = (typeof NAV_VIEWS)[number];

const NEW_PORTAL_PATH = (view: NavView): string =>
  `/portal/raas/${view}`;

/**
 * Freeze animations. The dashboard event ticker advances every 1.5 s
 * which would otherwise create flaky diffs; the runs page has subtle
 * status dots; the workflows page has live `<animateMotion>` dots.
 * Injecting `* { animation: none !important; transition: none !important; }`
 * deterministically pins the layout to the post-mount state.
 */
async function freezeAnimations(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const css =
    "*, *::before, *::after { animation-duration: 0s !important;" +
    " animation-delay: 0s !important; animation-iteration-count: 1 !important;" +
    " transition-duration: 0s !important; transition-delay: 0s !important; }" +
    " animateMotion, animate, animateTransform { begin: 999999s !important; }";
  await page.addStyleTag({ content: css });
}

async function prepareDevAuth(page: Page): Promise<void> {
  const email = process.env.AGENTIC_BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = process.env.AGENTIC_BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "AGENTIC_BOOTSTRAP_ADMIN_EMAIL and AGENTIC_BOOTSTRAP_ADMIN_PASSWORD are required for visual tests",
    );
  }
  await page.goto("/sign-in?return=/portal/raas/dashboard");
  await page.getByLabel(/email|邮箱/i).fill(email);
  // Constrained to the input: the reveal toggle beside it carries aria-label
  // "Show password"/"显示密码", which this pattern also matches.
  await page
    .getByLabel(/password|密码/i)
    .and(page.locator("input"))
    .fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/portal\//, { timeout: 15_000 });
}

// Use `mode: "default"` so a failing test does NOT mark subsequent tests
// as skipped — we want a per-view tally even when several drift.
test.describe.configure({ mode: "default" });

test.describe("Portal v1_1 pixel parity", () => {
  test.beforeEach(async ({ page }) => {
    await prepareDevAuth(page);
  });

  for (const view of NAV_VIEWS) {
    test(`view: ${view}`, async ({ page }) => {
      await page.goto(NEW_PORTAL_PATH(view));
      // Allow ChartJS / SVG / monaco to settle. We don't wait for
      // `networkidle` exclusively because SSE keeps the connection open
      // forever; instead, wait for the main nav shell to render then
      // pause briefly.
      await page.waitForSelector("nav", { timeout: 15_000 });
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);
      await freezeAnimations(page);
      await page.waitForTimeout(200);

      // Compare against `./v1_1-reference/<view>.png`. Playwright reads
      // the file path relative to the spec; we pass an absolute project
      // path so the path is stable regardless of test parallelism.
      await expect(page).toHaveScreenshot(
        ["v1_1-reference", `${view}.png`],
        {
          fullPage: false,
          // The portal is mostly static once hydrated; the only
          // intentional movement was animation, which freezeAnimations
          // already silenced.
          animations: "disabled",
        },
      );
    });
  }
});
