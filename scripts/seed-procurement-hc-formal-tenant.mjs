/**
 * Idempotently ensure the `procurement-hc-formal` Business Domain (tenant) row
 * exists — 采购-HC-Formal, compiled from the immutable ontology package
 * procurement-hc-formal@0.1.8 (场景一 采购全链路执行偏差三级预警 + 场景二
 * 数字化员工的智能作业实践) into models/procurement-hc-formal-v1/.
 *
 * Deliberately narrower than `pnpm db:seed`: it creates NO users. It creates
 * the tenant row (keyed by slug exactly like packages/db/src/seed.ts) and,
 * with `--grant-memberships` (the default for dev convenience), an admin
 * membership for every existing active user so the portal switcher and the
 * AUTH_MODE=dev principal can enter the domain. Re-running is a no-op.
 *
 * Run with the SQLite writer lease free (dev stack stopped):
 *   node scripts/seed-procurement-hc-formal-tenant.mjs [--no-grant-memberships]
 *
 * Environment precedence mirrors scripts/run-db-command.mjs (caller env →
 * root .env → repo-local SQLite default). The DB layer is TypeScript, so this
 * launcher re-executes itself under the tsx loader with cwd=packages/db,
 * wrapped in the SQLite writer supervisor (single-writer lease + migrations).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");

export const TENANT = Object.freeze({
  slug: "procurement-hc-formal",
  name: "采购-HC-Formal",
  subtitle:
    "采购计划编制与执行偏差预警 — ontology-compiled from procurement-hc-formal@0.1.8（场景一 偏差三级预警 + 场景二 数字化员工）",
  color: "#0f9d8a",
});

const GRANT_FLAG = "--no-grant-memberships";

async function seed({ grantMemberships }) {
  const dbPkg = path.join(repositoryRoot, "packages", "db");
  const { getDb, closeDb } = await import(pathToFileURL(path.join(dbPkg, "src", "client.ts")).href);
  const { tenants, users, memberships } = await import(
    pathToFileURL(path.join(dbPkg, "src", "schema.ts")).href
  );
  // Bare specifiers resolve relative to the IMPORTING file (scripts/ is not a
  // workspace package), so resolve them through packages/db's own dependency
  // tree / sibling source instead.
  const { makeId } = await import(
    pathToFileURL(path.join(repositoryRoot, "packages", "shared", "src", "id.ts")).href
  );
  const { createRequire } = await import("node:module");
  const requireFromDb = createRequire(path.join(dbPkg, "package.json"));
  const { and, eq } = requireFromDb("drizzle-orm");

  const db = getDb();
  try {
    let tenant = db.select().from(tenants).where(eq(tenants.slug, TENANT.slug)).all()[0];
    if (tenant) {
      console.log(`[seed-procurement-hc-formal] tenant '${TENANT.slug}' already exists → ${tenant.id}`);
    } else {
      const id = makeId("ten");
      db.insert(tenants).values({ id, ...TENANT }).run();
      tenant = db.select().from(tenants).where(eq(tenants.id, id)).all()[0];
      console.log(`[seed-procurement-hc-formal] created tenant '${TENANT.slug}' (${TENANT.name}) → ${id}`);
    }
    if (!grantMemberships) return;

    const activeUsers = db.select().from(users).where(eq(users.status, "active")).all();
    let granted = 0;
    for (const user of activeUsers) {
      const existing = db
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id)))
        .all()[0];
      if (existing) continue;
      db.insert(memberships)
        .values({ id: makeId("mem"), tenantId: tenant.id, userId: user.id, role: "admin" })
        .run();
      granted += 1;
      console.log(`[seed-procurement-hc-formal] ${user.email ?? user.id} → ${TENANT.slug} admin`);
    }
    console.log(
      `[seed-procurement-hc-formal] memberships — ${granted} new, ${activeUsers.length} active user(s) total`,
    );
  } finally {
    closeDb?.();
  }
}

function launch(argv) {
  // Parent mode: build the env exactly like the root db:* scripts do, then
  // re-run this file under tsx WRAPPED IN THE SQLITE WRITER SUPERVISOR —
  // packages/db enforces a single-writer lease, so any direct writer must be
  // launched exactly like `pnpm db:seed` (supervisor acquires the lease, runs
  // migrations, then hands off to the supplied command).
  return import(pathToFileURL(path.join(here, "run-db-command.mjs")).href).then(
    ({ buildDatabaseEnvironment }) => {
      const env = { ...buildDatabaseEnvironment(), SEED_PROCUREMENT_HC_FORMAL_CHILD: "1" };
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
            ...argv,
          ],
          { cwd: workspace, env, shell: false, stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve(undefined)
            : reject(new Error(`seed-procurement-hc-formal child exited with code ${code}`)),
        );
      });
    },
  );
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const argv = process.argv.slice(2).filter((arg, index) => !(arg === "--" && index === 0));
  const grantMemberships = !argv.includes(GRANT_FLAG);
  const run =
    process.env.SEED_PROCUREMENT_HC_FORMAL_CHILD === "1" ? seed({ grantMemberships }) : launch(argv);
  run.catch((error) => {
    console.error("[seed-procurement-hc-formal] failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
