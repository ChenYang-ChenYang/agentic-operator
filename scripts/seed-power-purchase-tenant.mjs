/**
 * Idempotently ensure the `power-purchase` Business Domain (tenant) row exists.
 *
 * This seed is intentionally narrow: it creates NO users and NO memberships.
 * Re-running it is a no-op once the tenant slug exists.
 *
 * Environment precedence mirrors scripts/run-db-command.mjs. The child runs
 * under the packages/db tsx loader and SQLite writer supervisor so it uses the
 * repository's normal database configuration and single-writer discipline.
 *
 * Usage: node scripts/seed-power-purchase-tenant.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");

const TENANT = {
  slug: "power-purchase",
  name: "Power-Purchase",
  subtitle:
    "采购全链路执行偏差三级预警 — Shadow + Decision Assist, pinned to power-purchase@1.0.3",
  color: "#f59e0b",
};

async function seedTenant() {
  const dbPkg = path.join(repositoryRoot, "packages", "db");
  const { getDb, closeDb } = await import(
    pathToFileURL(path.join(dbPkg, "src", "client.ts")).href
  );
  const { tenants } = await import(
    pathToFileURL(path.join(dbPkg, "src", "schema.ts")).href
  );
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
        `[seed-power-purchase] tenant '${TENANT.slug}' already exists -> ${existing.id} (nothing to do)`,
      );
      return;
    }

    const id = makeId("ten");
    db.insert(tenants)
      .values({ id, ...TENANT })
      .run();
    console.log(
      `[seed-power-purchase] created tenant '${TENANT.slug}' (${TENANT.name}) -> ${id}`,
    );
  } finally {
    closeDb();
  }
}

function launch() {
  return import(pathToFileURL(path.join(here, "run-db-command.mjs")).href).then(
    ({ buildDatabaseEnvironment }) => {
      const env = {
        ...buildDatabaseEnvironment(),
        SEED_POWER_PURCHASE_CHILD: "1",
      };
      const workspace = path.join(repositoryRoot, "packages", "db");
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            path.join(
              repositoryRoot,
              "apps",
              "api",
              "scripts",
              "sqlite-writer-supervisor.ts",
            ),
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
            : reject(
                new Error(`seed-power-purchase child exited with code ${code}`),
              ),
        );
      });
    },
  );
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const run =
    process.env.SEED_POWER_PURCHASE_CHILD === "1" ? seedTenant() : launch();
  run.catch((error) => {
    console.error("[seed-power-purchase] failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
