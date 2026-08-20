import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDatabaseEnvironment,
  databaseCommands,
  repositoryRoot,
} from "./run-db-command.mjs";

function temporaryRepository(t) {
  const root = mkdtempSync(path.join(tmpdir(), "agentic db env "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("caller DATABASE_URL and credentials take precedence over root .env", (t) => {
  const root = temporaryRepository(t);
  writeFileSync(
    path.join(root, ".env"),
    [
      "DATABASE_URL=file:/from env/development.db",
      "AGENTIC_BOOTSTRAP_ADMIN_PASSWORD=local-secret",
      "ROOT_ENV_ONLY=loaded",
    ].join("\n"),
  );

  const environment = buildDatabaseEnvironment({
    root,
    callerEnvironment: {
      DATABASE_URL: "file:/deployment volume/production.db",
      AGENTIC_BOOTSTRAP_ADMIN_PASSWORD: "deployment-secret",
    },
  });

  assert.equal(
    environment.DATABASE_URL,
    "file:/deployment volume/production.db",
  );
  assert.equal(
    environment.AGENTIC_BOOTSTRAP_ADMIN_PASSWORD,
    "deployment-secret",
  );
  assert.equal(environment.ROOT_ENV_ONLY, "loaded");
});

test("root .env is loaded when the caller does not provide DATABASE_URL", (t) => {
  const root = temporaryRepository(t);
  writeFileSync(
    path.join(root, ".env"),
    "DATABASE_URL=file:/env path/agentic.db\n",
  );

  const environment = buildDatabaseEnvironment({ root, callerEnvironment: {} });

  assert.equal(environment.DATABASE_URL, "file:/env path/agentic.db");
});

test("missing DATABASE_URL falls back to the absolute repository data path", (t) => {
  const root = temporaryRepository(t);

  const environment = buildDatabaseEnvironment({ root, callerEnvironment: {} });

  assert.equal(
    environment.DATABASE_URL,
    `file:${path.join(root, "data", "agentic.db")}`,
  );
  assert.equal(environment.AGENTIC_DATA_DIR, path.join(root, "data"));
  assert.match(environment.DATABASE_URL, /agentic db env /);
});

test("all root database operations use binaries plus argv (never shell strings)", () => {
  assert.deepEqual(Object.keys(databaseCommands).sort(), [
    "backup",
    "generate",
    "migrate",
    "prune-deployments",
    // Recovery is deliberately absent from the supervised roster below: it has
    // to run precisely when the writer lease cannot be acquired.
    "recover-writer-lease",
    "seed",
    "studio",
    "wipe-runtime",
  ]);
  for (const command of Object.values(databaseCommands)) {
    assert.match(command.binary, /^(node|tsx|drizzle-kit)$/);
    assert.ok(Array.isArray(command.args));
    assert.ok(command.args.every((arg) => typeof arg === "string"));
  }
});

test("every root command that opens SQLite runs under the canonical writer supervisor", () => {
  for (const operation of [
    "backup",
    "seed",
    "wipe-runtime",
    "prune-deployments",
    "studio",
  ]) {
    const command = databaseCommands[operation];
    assert.equal(command.binary, "node");
    assert.deepEqual(command.args.slice(-2), ["--db-command", operation]);
    assert.ok(command.args.includes("../../apps/api/scripts/sqlite-writer-supervisor.ts"));
  }
});

test("package-local database writer commands use the same supervisor", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, "packages", "db", "package.json"), "utf8"),
  );
  for (const operation of [
    "backup",
    "seed",
    "wipe-runtime",
    "prune-deployments",
    "studio",
  ]) {
    assert.match(
      manifest.scripts[operation],
      new RegExp(`sqlite-writer-supervisor\\.ts --db-command ${operation}$`),
    );
  }
});

test("the cron backup wrapper delegates to the supervised root command", () => {
  const wrapper = readFileSync(
    path.join(repositoryRoot, "scripts", "db-backup.sh"),
    "utf8",
  );
  assert.match(wrapper, /run-db-command\.mjs" backup/);
  assert.doesNotMatch(wrapper, /\bsqlite3\b|VACUUM INTO/);
});
