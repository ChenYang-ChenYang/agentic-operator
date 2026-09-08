#!/usr/bin/env node
/**
 * Run the mock Meta ERP against the checked-in 采购-HC-Formal package
 * (procurement-hc-formal@0.1.8) instead of the compiled-in default.
 *
 *   node scripts/run-procurement-hc-formal-erp.mjs      # or: pnpm hcf:erp
 *
 * Pins the two env vars that select a package so the data plane needs no
 * shell boilerplate:
 *
 *   MOCK_ERP_DATA_DIR        ontology-packages/procurement-hc-formal/package/mock-erp
 *   MOCK_ERP_TRANSFORM_MAPS  ontology-packages/procurement-hc-formal/package/transform-maps/transform-maps.json
 *
 * START ORDER MATTERS: bring this up AFTER the api. The root `predev` runs
 * scripts/stop-dev.sh, whose kill patterns include `tsx.*src/server\.ts` —
 * exactly this service's argv — so an ERP started first is killed by the next
 * restart, and while it is down the write agents burn their Inngest retries.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = path.join(ROOT, "ontology-packages", "procurement-hc-formal", "package");
const dataDir = path.join(PACKAGE_DIR, "mock-erp");
const transformMaps = path.join(PACKAGE_DIR, "transform-maps", "transform-maps.json");

for (const required of [path.join(dataDir, "_index.json"), transformMaps]) {
  if (!existsSync(required)) {
    console.error(
      `[hcf-erp] missing ${path.relative(ROOT, required)} — run \`pnpm hcf:compile\` first`,
    );
    process.exit(1);
  }
}

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@agentic/mock-erp", "run", "start"],
  {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      MOCK_ERP_DATA_DIR: dataDir,
      MOCK_ERP_TRANSFORM_MAPS: transformMaps,
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 0));
