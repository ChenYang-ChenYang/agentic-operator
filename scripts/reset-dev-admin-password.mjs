#!/usr/bin/env node
/**
 * Dev convenience: reset the seeded admin's password to a known value so the
 * portal can be driven locally. Supervisor-wrapped like the other db scripts.
 *   node scripts/reset-dev-admin-password.mjs <email> <new-password>
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const [email, newPassword] = process.argv.slice(2);
if (!email || !newPassword) {
  console.error("usage: node scripts/reset-dev-admin-password.mjs <email> <new-password>");
  process.exit(2);
}

async function reset() {
  const dbPkg = path.join(repositoryRoot, "packages", "db");
  const { getDb, closeDb } = await import(pathToFileURL(path.join(dbPkg, "src", "client.ts")).href);
  const { users } = await import(pathToFileURL(path.join(dbPkg, "src", "schema.ts")).href);
  const { hashPassword } = await import(
    pathToFileURL(path.join(dbPkg, "src", "password.ts")).href
  );
  if (!hashPassword) throw new Error("hashPassword export not found");
  const { createRequire } = await import("node:module");
  const requireFromDb = createRequire(path.join(dbPkg, "package.json"));
  const { eq } = requireFromDb("drizzle-orm");
  const db = getDb();
  try {
    const u = db.select().from(users).where(eq(users.email, email)).all()[0];
    if (!u) throw new Error(`user ${email} not found`);
    db.update(users).set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, u.id)).run();
    console.log(`[reset] password updated for ${email}`);
  } finally {
    closeDb?.();
  }
}

if (process.env.__RESET_CHILD === "1") {
  await reset();
} else {
  const { buildDatabaseEnvironment } = await import(pathToFileURL(path.join(here, "run-db-command.mjs")).href);
  const env = { ...buildDatabaseEnvironment(), __RESET_CHILD: "1" };
  const dbPkg = path.join(repositoryRoot, "packages", "db");
  const child = spawn(process.execPath, [
    "--import", "tsx",
    path.join(repositoryRoot, "apps", "api", "scripts", "sqlite-writer-supervisor.ts"),
    "--",
    process.execPath, "--import", "tsx", fileURLToPath(import.meta.url),
    email, newPassword,
  ], { cwd: dbPkg, env, shell: false, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
