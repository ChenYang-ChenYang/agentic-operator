/**
 * P2-FE-24 — axe-core sweep across every nav view.
 *
 * Goal (FR-PORT-3 / R-6): zero critical violations per view.
 *
 * The spec drives each view, runs axe-core's WCAG 2.1 AA ruleset, and
 * fails if any node reports a `critical` impact. Lower impacts
 * (serious / moderate / minor) are logged as `console.warn` so the
 * Foundation engineer can see them in CI, but don't fail the suite —
 * those typically need design-team input rather than a quick code fix.
 *
 * Why critical-only as the failing bar: axe's `critical` impact maps to
 * issues that *break* the experience for assistive-tech users (e.g. a
 * button with no accessible name, an `<img>` with no alt). `serious`
 * is "the experience is degraded" (e.g. low contrast), and tweaking
 * those without breaking the design language is post-v1 work tracked
 * separately.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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

test.describe.configure({ mode: "default" });

test.describe("axe-core sweep", () => {
  test.beforeEach(async ({ page }) => {
    const email = process.env.AGENTIC_BOOTSTRAP_ADMIN_EMAIL?.trim();
    const password = process.env.AGENTIC_BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) {
      throw new Error(
        "AGENTIC_BOOTSTRAP_ADMIN_EMAIL and AGENTIC_BOOTSTRAP_ADMIN_PASSWORD are required for accessibility tests",
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
    await page.waitForURL(/\/portal\//, { timeout: 30_000 });
  });

  for (const view of NAV_VIEWS) {
    test(`a11y: ${view}`, async ({ page }) => {
      await page.goto(`/portal/raas/${view}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("nav", { timeout: 15_000 });
      await page.waitForTimeout(1000);

      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      // Tally critical vs other impacts. We dump everything to the
      // console so a CI run that fails has the violation list inline.
      const critical = accessibilityScanResults.violations.filter(
        (v) => v.impact === "critical",
      );
      const serious = accessibilityScanResults.violations.filter(
        (v) => v.impact === "serious",
      );
      const moderate = accessibilityScanResults.violations.filter(
        (v) => v.impact === "moderate",
      );
      const minor = accessibilityScanResults.violations.filter(
        (v) => v.impact === "minor",
      );

      if (critical.length > 0) {
        // Surface details in the test report.
        for (const v of critical) {
          console.error(`[axe:critical] ${v.id}: ${v.description}`);
          for (const n of v.nodes.slice(0, 3)) {
            console.error(`  target: ${n.target.join(" ")}`);
            console.error(`  html:   ${n.html.slice(0, 200)}`);
          }
        }
      }
      if (serious.length > 0 || moderate.length > 0 || minor.length > 0) {
        console.warn(
          `[axe:${view}] non-critical violations:`,
          `serious=${serious.length}`,
          `moderate=${moderate.length}`,
          `minor=${minor.length}`,
        );
        for (const v of [...serious, ...moderate, ...minor]) {
          console.warn(`  ${v.impact}: ${v.id} — ${v.description}`);
        }
      }

      expect(critical, "no critical axe violations").toHaveLength(0);
    });
  }
});
