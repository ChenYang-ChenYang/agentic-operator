#!/usr/bin/env node
/**
 * Grant every existing active user an admin membership in the hc-procurement
 * tenant so the dev portal (AUTH_MODE=dev) can switch into it via the
 * x-agentic-tenant header. Idempotent; dev convenience only.
 * Run with the writer lease free (dev stack stopped):
 *   node scripts/grant-hc-procurement-membership.mjs
 * Mirrors scripts/seed-hc-procurement-tenant.mjs: file-URL imports of the DB layer
 * under the tsx loader with cwd=packages/db so better-sqlite3 resolves.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");

async function grant() {
  const dbPkg = path.join(repositoryRoot, "packages", "db");
  const { getDb, closeDb } = await import(
    pathToFileURL(path.join(dbPkg, "src", "client.ts")).href
  );
  const { tenants, users, memberships } = await import(
    pathToFileURL(path.join(dbPkg, "src", "schema.ts")).href
  );
  const { makeId } = await import(
    pathToFileURL(path.join(repositoryRoot, "packages", "shared", "src", "id.ts")).href
  );
  const { createRequire } = await import("node:module");
  const requireFromDb = createRequire(path.join(dbPkg, "package.json"));
  const { and, eq } = requireFromDb("drizzle-orm");

  const db = getDb();
  try {
    const tenant = db.select().from(tenants).where(eq(tenants.slug, "hc-procurement")).all()[0];
    if (!tenant) throw new Error("tenant hc-procurement not found — run seed-hc-procurement-tenant.mjs first");
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
      console.log(`[grant] ${user.email ?? user.id} → hc-procurement admin`);
    }
    console.log(
      `[grant] done — ${granted} new membership(s), ${activeUsers.length} active user(s) total`,
    );
  } finally {
    closeDb?.();
  }
}

if (process.env.__GRANT_CHILD === "1") {
  await grant();
} else {
  // Same launch shape as seed-hc-procurement-tenant.mjs: the single-writer lease is
  // enforced by packages/db, so re-run this file under tsx WRAPPED IN THE
  // SQLITE WRITER SUPERVISOR (which acquires the lease, runs migrations, then
  // hands off).
  const { buildDatabaseEnvironment } = await import(
    pathToFileURL(path.join(here, "run-db-command.mjs")).href
  );
  const env = { ...buildDatabaseEnvironment(), __GRANT_CHILD: "1" };
  const dbPkg = path.join(repositoryRoot, "packages", "db");
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
    { cwd: dbPkg, env, shell: false, stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
}
