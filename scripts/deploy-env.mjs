#!/usr/bin/env node
/**
 * scripts/deploy-env.mjs — environment-profile deploy driver (design §2).
 *
 * Selects a profile from deploy/environments/<env>.env, assembles the matching
 * docker compose invocation (compose files + profiles + env file + services),
 * optionally builds first, and health-verifies /health endpoints after an
 * actual `up`.
 *
 *   node scripts/deploy-env.mjs --env dev|sandbox|production [--build] [--down]
 *
 * SAFETY DEFAULT: dry-run. Unless DEPLOY_DRY_RUN=0 is set in the environment,
 * the script runs `docker compose … config --quiet` (a topology/interpolation
 * check) instead of `up`, and prints the exact command it WOULD run. Set
 * DEPLOY_DRY_RUN=0 to actually deploy. (DEPLOY_DRY_RUN=1 forces dry-run.)
 *
 * The `dev` profile declares no compose files — that environment is the
 * host-run `pnpm dev` stack, so the script verifies health (when up) and
 * prints the host commands instead of touching docker.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`deploy-env: ${message}`);
  process.exit(1);
}

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
let envName = null;
let build = false;
let down = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--env") envName = args[++i];
  else if (arg.startsWith("--env=")) envName = arg.slice("--env=".length);
  else if (arg === "--build") build = true;
  else if (arg === "--down") down = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(
      "usage: node scripts/deploy-env.mjs --env dev|sandbox|production [--build] [--down]\n" +
        "       DEPLOY_DRY_RUN=0 …   actually run docker compose up (default is a config dry-run)",
    );
    process.exit(0);
  } else fail(`unknown argument '${arg}'`);
}
if (!envName || !["dev", "sandbox", "production"].includes(envName)) {
  fail("--env must be one of: dev, sandbox, production");
}

// ---- profile ---------------------------------------------------------------
const profilePath = path.join(repoRoot, "deploy", "environments", `${envName}.env`);
if (!fs.existsSync(profilePath)) fail(`profile not found: ${profilePath}`);

/** Minimal .env parser: KEY=VALUE lines, '#' comments, no quoting games. */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const profile = parseEnvFile(fs.readFileSync(profilePath, "utf8"));
const composeFiles = (profile.DEPLOY_COMPOSE_FILES ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const composeProfiles = (profile.DEPLOY_COMPOSE_PROFILES ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const composeServices = (profile.DEPLOY_COMPOSE_SERVICES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const composeEnvFile = profile.DEPLOY_ENV_FILE || null;
const healthUrls = (profile.DEPLOY_HEALTH_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

// Dry-run-safe default: only DEPLOY_DRY_RUN=0 performs a real up/down.
const dryRun = process.env.DEPLOY_DRY_RUN !== "0";

// Profile values become process env for compose interpolation; the ambient
// environment (real secrets) still wins on conflicts.
const childEnv = { ...profile, ...process.env };

function run(command, argv, opts = {}) {
  console.log(`\n$ ${command} ${argv.join(" ")}`);
  const result = spawnSync(command, argv, {
    cwd: repoRoot,
    stdio: "inherit",
    env: childEnv,
    ...opts,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

async function verifyHealth() {
  for (const url of healthUrls) {
    process.stdout.write(`health ${url} … `);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      console.log(res.ok ? "OK" : `HTTP ${res.status} (NOT healthy)`);
      if (!res.ok) process.exitCode = 1;
    } catch (error) {
      console.log(`UNREACHABLE (${error.message})`);
      process.exitCode = 1;
    }
  }
}

console.log(`deploy-env: environment '${envName}' (profile ${path.relative(repoRoot, profilePath)})`);
console.log(`deploy-env: mode ${dryRun ? "DRY-RUN (set DEPLOY_DRY_RUN=0 to execute)" : "EXECUTE"}`);

// ---- host-run dev environment (no compose files) -----------------------------
if (composeFiles.length === 0) {
  console.log(
    "\nThis profile is the HOST-RUN dev stack — no docker compose topology.\n" +
      "  start : corepack pnpm dev            (web :3599 + api :3540 + inngest :8488)\n" +
      "  erp   : corepack pnpm --filter @agentic/mock-erp dev   (mock Meta ERP :3620)\n" +
      "  stop  : ./scripts/stop-dev.sh",
  );
  if (down) {
    console.log("\n--down for dev: run ./scripts/stop-dev.sh");
  } else if (dryRun) {
    console.log(`\nDRY-RUN — would verify health: ${healthUrls.join(", ")}`);
  } else {
    await verifyHealth();
  }
  process.exit(process.exitCode ?? 0);
}

// ---- compose-backed environments ---------------------------------------------
for (const file of composeFiles) {
  if (!fs.existsSync(path.join(repoRoot, file))) fail(`compose file missing: ${file}`);
}
if (composeEnvFile && !fs.existsSync(path.join(repoRoot, composeEnvFile))) {
  console.warn(
    `deploy-env: WARNING — compose env file '${composeEnvFile}' does not exist yet; ` +
      "copy its .example and fill the required values before a real deploy.",
  );
}

const composeArgs = [];
if (composeEnvFile && fs.existsSync(path.join(repoRoot, composeEnvFile))) {
  composeArgs.push("--env-file", composeEnvFile);
}
for (const p of composeProfiles) composeArgs.push("--profile", p);
for (const file of composeFiles) composeArgs.push("-f", file);

if (down) {
  if (dryRun) {
    console.log(`\nDRY-RUN — would run: docker compose ${composeArgs.join(" ")} down`);
  } else {
    run("docker", ["compose", ...composeArgs, "down"]);
  }
  process.exit(0);
}

// Production builds the workspaces before composing images.
if (build && envName === "production") {
  if (dryRun) console.log("\nDRY-RUN — would run: corepack pnpm build");
  else run("corepack", ["pnpm", "build"]);
}

if (dryRun) {
  // Topology + interpolation check instead of up. Interpolation needs the
  // real compose env file; without it the check can only fail, so skip it
  // with an explicit message instead of reporting a false topology error.
  if (!composeEnvFile || fs.existsSync(path.join(repoRoot, composeEnvFile))) {
    run("docker", ["compose", ...composeArgs, "config", "--quiet"]);
  } else {
    console.log(
      `\nSKIPPED docker compose config check — '${composeEnvFile}' is missing, ` +
        "so required-variable interpolation cannot be validated on this machine.",
    );
  }
  const upArgs = ["compose", ...composeArgs, "up", "-d"];
  if (build) upArgs.push("--build");
  upArgs.push(...composeServices);
  console.log(`\nDRY-RUN OK — would run: docker ${upArgs.join(" ")}`);
  console.log("Set DEPLOY_DRY_RUN=0 to execute, then health checks run automatically.");
} else {
  const upArgs = ["compose", ...composeArgs, "up", "-d"];
  if (build) upArgs.push("--build");
  upArgs.push(...composeServices);
  run("docker", upArgs);
  await verifyHealth();
}
