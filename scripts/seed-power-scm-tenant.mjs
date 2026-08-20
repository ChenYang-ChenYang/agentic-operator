/**
 * Idempotently ensure the `power-scm` tenant row exists
 * (电力供应链数字孪生 — the ontology-compiled power supply-chain demo domain,
 * see docs/redesign-ontology-execution-2026-08-19.md §G1).
 *
 * Deliberately narrower than `pnpm db:seed`: it creates NO users and NO
 * memberships — only the tenant row, keyed by slug exactly like
 * packages/db/src/seed.ts does. Re-running is a no-op.
 *
 * Environment precedence mirrors scripts/run-db-command.mjs
 * (caller env → root .env → repo-local SQLite default). The DB layer is
 * TypeScript, so this launcher re-executes itself under the tsx loader with
 * cwd=packages/db (where tsx + better-sqlite3 are installed).
 *
 * Usage: node scripts/seed-power-scm-tenant.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");

const TENANT = {
  slug: "power-scm",
  name: "电力供应链数字孪生",
  subtitle: "Ontology-compiled power supply-chain demo (allmeta-power-scm)",
  color: "#38bdf8",
};

async function seedTenant() {
  // Runs under the tsx loader with cwd=packages/db (see launch() below), so
  // the TypeScript DB layer and its native better-sqlite3 resolve normally.
  const dbPkg = path.join(repositoryRoot, "packages", "db");
  const { getDb, closeDb } = await import(
    pathToFileURL(path.join(dbPkg, "src", "client.ts")).href
  );
  const { tenants } = await import(
    pathToFileURL(path.join(dbPkg, "src", "schema.ts")).href
  );
  // Bare specifiers resolve relative to the IMPORTING file (scripts/ is not a
  // workspace package), so resolve them through packages/db's own dependency
  // tree / sibling source instead.
  const { makeId } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "packages", "shared", "src", "id.ts"),
    ).href
  );
  const { createRequire } = await import("node:module");
  const requireFromDb = createRequire(path.join(dbPkg, "package.json"));
  const { eq } = requireFromDb("drizzle-orm");

  const db = getDb();
  try {
    const existing = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, TENANT.slug))
      .all()[0];
    if (existing) {
      console.log(
        `[seed-power-scm] tenant '${TENANT.slug}' already exists → ${existing.id} (nothing to do)`,
      );
      return;
    }
    const id = makeId("ten");
    db.insert(tenants).values({ id, ...TENANT }).run();
    console.log(
      `[seed-power-scm] created tenant '${TENANT.slug}' (${TENANT.name}) → ${id}`,
    );
  } finally {
    closeDb();
  }
}

function launch() {
  // Parent mode: build the env exactly like the root db:* scripts do, then
  // re-run this file under tsx, WRAPPED IN THE SQLITE WRITER SUPERVISOR —
  // packages/db enforces a single-writer lease, so any direct writer must be
  // launched exactly like `pnpm db:seed` (supervisor acquires the lease, runs
  // migrations, then hands off to the supplied command).
  return import(
    pathToFileURL(path.join(here, "run-db-command.mjs")).href
  ).then(({ buildDatabaseEnvironment }) => {
    const env = {
      ...buildDatabaseEnvironment(),
      SEED_POWER_SCM_CHILD: "1",
    };
    const workspace = path.join(repositoryRoot, "packages", "db");
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "apps", "api", "scripts", "sqlite-writer-supervisor.ts"),
          "--",
          process.execPath,
          "--import",
          "tsx",
          fileURLToPath(import.meta.url),
        ],
        { cwd: workspace, env, shell: false, stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve(undefined)
          : reject(new Error(`seed-power-scm child exited with code ${code}`)),
      );
    });
  });
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const run = process.env.SEED_POWER_SCM_CHILD === "1" ? seedTenant() : launch();
  run.catch((error) => {
    console.error("[seed-power-scm] failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
