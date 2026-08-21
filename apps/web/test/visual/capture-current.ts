/**
 * Capture screenshots of the *current* App Router portal under
 * `./current-snapshots/`, useful for ad-hoc visual review without
 * running the full Playwright pixel-diff suite.
 *
 * For the canonical pixel-diff pipeline use `pnpm test:visual` (which
 * reads from `./portal.spec.ts-snapshots/v1_1-reference/` and writes
 * diff artifacts to `./test-results/`).
 *
 * Each new-portal route is `/portal/raas/<view>`. Pre-auth uses the real
 * password form with the explicitly configured bootstrap administrator.
 */

import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "current-snapshots");
fs.mkdirSync(OUT_DIR, { recursive: true });
const BASE_URL = process.env.PW_BASE_URL ?? "http://localhost:3599";

const VIEWS = [
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

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  animateMotion, animate, animateTransform { begin: 999999s !important; }
`;

async function capture(): Promise<void> {
  const email = process.env.AGENTIC_BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = process.env.AGENTIC_BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "AGENTIC_BOOTSTRAP_ADMIN_EMAIL and AGENTIC_BOOTSTRAP_ADMIN_PASSWORD are required for authenticated captures",
    );
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/sign-in?return=/portal/raas/dashboard`);
    await page.getByLabel(/email|邮箱/i).fill(email);
    // Constrained to the input: the reveal toggle beside it carries aria-label
  // "Show password"/"显示密码", which this pattern also matches.
  await page
    .getByLabel(/password|密码/i)
    .and(page.locator("input"))
    .fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/portal\//, { timeout: 30_000 });

    for (const v of VIEWS) {
      console.log(`[current] capturing ${v}`);
      await page.goto(`${BASE_URL}/portal/raas/${v}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(1500);
      await page.addStyleTag({ content: FREEZE_CSS });
      await page.waitForTimeout(200);
      await page.screenshot({
        path: path.join(OUT_DIR, `${v}.png`),
        fullPage: false,
      });
    }
  } finally {
    await browser.close();
  }
}

capture()
  .then(() => {
    console.log("[current] done");
    process.exit(0);
  })
  .catch((e) => {
    console.error("[current] failed:", e);
    process.exit(1);
  });
