/**
 * vitest setup — runs once per worker before any test file.
 *
 * Forces test-friendly env defaults:
 *   - LLM_DEFAULT_PROVIDER=mock + LLM_DEFAULT_MODEL=mock-model-v1
 *   - AGENTIC_LOGS_DIR / AGENTIC_ARTIFACTS_DIR redirected to data/test-logs etc.
 *   - DATABASE_URL pointed at a consistent snapshot of the dev DB. Tests can
 *     read realistic seeded data without writing test rows into the operator's
 *     live audit, run, usage, or event history.
 *
 * Also drains accumulated test-tenant residue. The 2026-05-20 QA found 286
 * test-residue rows in `tenants` from suites that never cleaned up (the
 * sidebar was unusable once the production switcher was wired). Each well-
 * known prefix corresponds to a suite; budget-* / evt-tester-* / etc. are
 * deleted on setup so the dev DB stays browsable. We never touch real
 * tenants — `raas`, `__system`, `zhaopin`, `agents-generation` are explicitly
 * preserved (and the prefix list makes incidental matches impossible).
 *
 * Individual tests can override via env when needed (e.g. TC-1 forces
 * ANTHROPIC_API_KEY to flip its `hasKey` to true).
 */

import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { getRawSqlite, closeDb, runMigrations } from "@agentic/db";
// @agentic/db reads `DATABASE_URL` lazily inside `getDb()` — the env
// vars below are set before we invoke `getRawSqlite`, so the import
// itself is safe.

const repoRoot = path.resolve(__dirname, "../../..");
const testRunRoot =
  process.env.AGENTIC_API_TEST_RUN_ROOT?.trim() ||
  path.join(repoRoot, "data", "test-runs", String(process.pid));

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
// Promotion services fail closed in every non-production process. Unit tests
// that exercise the pure promotion pipeline opt in explicitly, and the service
// additionally requires Vitest's own process marker. NODE_ENV=test alone must
// never turn a reachable test API into a production writer.
process.env.FACTORY_ALLOW_TEST_PROMOTION = "1";
// Writable fixture access is an explicit client capability. The DB client also
// proves every filesystem database remains under this invocation's test root;
// NODE_ENV=test by itself never bypasses the production writer lease.
process.env.AGENTIC_SQLITE_TEST_WRITER = "1";
process.env.AUTH_MODE = "dev";
process.env.AGENTIC_DEV_TENANT = "__system";
// Tests use an isolated, explicitly test-only principal. It is provisioned in
// the worker snapshot below and never depends on (or leaks into) the real
// bootstrap administrator configured by a deployment.
const testOperatorEmail =
  process.env.AGENTIC_TEST_ADMIN_EMAIL?.trim().toLowerCase() ||
  "test-platform-admin@agentic.invalid";
process.env.AGENTIC_DEV_USER_EMAIL = testOperatorEmail;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

process.env.LLM_DEFAULT_PROVIDER = "mock";
process.env.LLM_DEFAULT_MODEL = "mock-model-v1";
// Fastify-inject unit tests have no listening serve URL or Inngest process.
// This explicit test-only switch prevents network calls without teaching
// NODE_ENV=test to fake a successful broker sync (E2E also uses test fixtures
// and must exercise the real broker).
process.env.INNGEST_SYNC_DISABLED = "1";
// The checked-in RAAS manifest uses an env-backed schedule. Tests configure
// an inert-but-valid cadence explicitly so generic health assertions exercise
// a configured schedule; dedicated scheduler tests cover the unconfigured
// readiness state.
process.env.RAAS_REQUIREMENTS_SYNC_CRON = "@hourly";
process.env.RAAS_REQUIREMENTS_SYNC_TIMEZONE = "UTC";

// Redirect file artifacts away from the dev workspace so we can clean them up.
// Factory stores, import staging and tenant-code paths also resolve through the
// canonical data root. Without these values, store-level tests that do not run
// the API bootstrap fall back to apps/api/data and pollute production-looking
// state inside the source tree.
process.env.AGENTIC_DATA_ROOT = testRunRoot;
process.env.AGENTIC_DATA_DIR = testRunRoot;
process.env.AGENTIC_TENANTS_DIR = path.join(testRunRoot, "tenants");
process.env.AGENTIC_LOGS_DIR = path.join(testRunRoot, "logs");
process.env.AGENTIC_ARTIFACTS_DIR = path.join(testRunRoot, "artifacts");
// Keep import staging inside the invocation-scoped models tree, matching the
// production same-filesystem atomic-rename contract and overriding any path
// inherited from a developer shell.
process.env.AGENTIC_IMPORTS_DIR = path.join(
  process.env.AGENTIC_MODELS_DIR ?? path.join(testRunRoot, "models"),
  ".imports",
);
// File-backed runtime configuration must never reuse the developer vault/fleet
// beside agentic.db. The test process uses a different encryption secret and
// would otherwise fail to decrypt—or mutate—the real operator configuration.
process.env.AGENTIC_KEY_VAULT_PATH = path.join(testRunRoot, "provider-keys.json");
process.env.AGENTIC_MODEL_FLEET_PATH = path.join(testRunRoot, "model-fleet.json");
process.env.AGENTIC_LLM_TELEMETRY_SPOOL_PATH = path.join(testRunRoot, "llm-telemetry.ndjson");
// AI routing settings and their managed env mirror are one write unit. Pin
// both halves to this invocation so a test that initializes settings can never
// rewrite the developer's apps/api/.env.local.
process.env.AGENTIC_LLM_SETTINGS_PATH = path.join(
  testRunRoot,
  "llm-settings.json",
);
process.env.AGENTIC_LLM_ENV_MIRROR_PATH = path.join(
  testRunRoot,
  "llm-settings.env.local",
);

// Clone the migrated database once per Vitest worker. better-sqlite3's backup
// API includes committed WAL pages, so the snapshot is consistent even while
// the local API is running. `setup.ts` can be re-evaluated for each test file;
// the marker prevents a 60+ MB backup on every file in the single-fork pool.
const devDbPath = path.join(repoRoot, "data", "agentic.db");
const snapshotPath = path.join(testRunRoot, "agentic.db");
const requestedTestUrl = process.env.AGENTIC_TEST_DATABASE_URL;
const existingSnapshotUrl = process.env.AGENTIC_VITEST_DATABASE_URL;
const inheritedUrl = process.env.DATABASE_URL ?? `file:${devDbPath}`;
// Vitest restores process.env between test files. DATABASE_URL can therefore
// still point at the worker snapshot while our in-process marker has already
// been reset. Never treat that snapshot as its own source (doing so used to
// unlink it and then create an empty database halfway through the suite).
const inheritedPath = inheritedUrl.replace(/^file:/, "");
const sourceUrl = path.resolve(inheritedPath) === snapshotPath
  ? `file:${devDbPath}`
  : inheritedUrl;

let databaseUrl = requestedTestUrl;
if (!databaseUrl) {
  // global-setup removes this run root once at the start. Once the first
  // worker has cloned it, every later sequential worker reuses it even if
  // Vitest reset AGENTIC_VITEST_DATABASE_URL between files.
  const reusableSnapshot =
    (existingSnapshotUrl && existsSync(existingSnapshotUrl.replace(/^file:/, ""))
      ? existingSnapshotUrl
      : existsSync(snapshotPath)
        ? `file:${snapshotPath}`
        : undefined);
  if (reusableSnapshot) {
    databaseUrl = reusableSnapshot;
  }
}
if (!databaseUrl) {
  const sourceValue = sourceUrl.replace(/^file:/, "");
  const sourcePath = path.isAbsolute(sourceValue)
    ? sourceValue
    : path.resolve(process.cwd(), sourceValue);

  if (sourceValue !== ":memory:" && existsSync(sourcePath)) {
    // The process-wide global teardown owns cleanup. Per-worker exit hooks
    // must not unlink this shared snapshot while later files are still queued.
    rmSync(snapshotPath, { force: true });
    rmSync(`${snapshotPath}-shm`, { force: true });
    rmSync(`${snapshotPath}-wal`, { force: true });

    process.env.DATABASE_URL = sourceUrl;
    const previousReadonly = process.env.AGENTIC_DATABASE_READONLY;
    process.env.AGENTIC_DATABASE_READONLY = "1";
    try {
      const sourceDb = getRawSqlite();
      await sourceDb.backup(snapshotPath);
    } finally {
      closeDb();
      if (previousReadonly === undefined) delete process.env.AGENTIC_DATABASE_READONLY;
      else process.env.AGENTIC_DATABASE_READONLY = previousReadonly;
    }

    databaseUrl = `file:${snapshotPath}`;
    process.env.AGENTIC_VITEST_DATABASE_URL = databaseUrl;
  } else {
    // Preserve the historical first-run behaviour: tests surface the missing
    // migration/database error instead of silently creating an empty schema.
    databaseUrl = sourceUrl;
  }
}

process.env.DATABASE_URL = databaseUrl;
process.env.AGENTIC_DATABASE_READONLY = "0";
const dbPath = databaseUrl.replace(/^file:/, "");

// The developer database may legitimately be one or more migrations behind
// the checked-out code. Tests must exercise the current schema, but must never
// upgrade that live database as a side effect. Apply pending migrations only
// after DATABASE_URL has been switched to the worker's isolated clone (or an
// explicitly supplied AGENTIC_TEST_DATABASE_URL).
const isIsolatedTestDatabase =
  databaseUrl !== sourceUrl ||
  Boolean(existingSnapshotUrl) ||
  Boolean(requestedTestUrl);
if (isIsolatedTestDatabase && existsSync(dbPath)) {
  runMigrations(path.join(repoRoot, "packages", "db", "drizzle"));
  // Re-open lazily for the first test so every suite sees the post-migration
  // schema rather than a singleton created by the migrator.
  closeDb();
}

// One-time test-tenant residue sweep. Runs synchronously at setup time so
// the first test suite's `beforeAll` sees a drained tenants table — the
// QA at 2026-05-20 found 286 residue rows that made the sidebar switcher
// unusable. Skip if the dev DB hasn't been migrated yet so first-time
// contributors see the migration error instead of a swallow.
function dropTestTenantResidue(): void {
  if (!existsSync(dbPath)) return;
  // Suite-prefixed slugs we know are residue. The compound `NOT IN`
  // safety-pins the four real slugs even if a future suite reuses one.
  const prefixes = [
    "budget-",
    "aud-",
    "webhook-tenant-",
    "mem-",
    "evt-tester",
    "mi-",
    "micommit",
    "miconc",
    "miconf",
    "miog",
    "qa-probe-",
  ];
  try {
    const sqlite = getRawSqlite();
    try {
      const orClauses = prefixes.map(() => "slug LIKE ?").join(" OR ");
      const params = prefixes.map((p) => `${p}%`);
      // Foreign keys are ON DELETE CASCADE across the schema, so deleting
      // the tenant row also drains memberships / api_tokens / runs / etc.
      // The NOT IN clause pins the four real slugs.
      sqlite
        .prepare(
          `DELETE FROM tenants WHERE (${orClauses}) AND slug NOT IN ('raas', '__system', 'zhaopin', 'agents-generation')`,
        )
        .run(...params);
    } finally {
      // Close so the test suites' first getDb() builds a fresh handle —
      // avoids stale-cache surprises between worker startup and the
      // first beforeAll. (Re-open is cheap with WAL.)
      closeDb();
    }
  } catch {
    // Best-effort: if the schema isn't ready yet, leave residue and let
    // tests fail with a clearer error than a setup crash.
  }
}

dropTestTenantResidue();

function provisionTestOperator(): void {
  if (!isIsolatedTestDatabase || !existsSync(dbPath)) return;
  const sqlite = getRawSqlite();
  try {
    const now = Date.now();
    const existing = sqlite
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(testOperatorEmail) as { id: string } | undefined;
    const userId = existing?.id ?? `usr-test-${process.pid}`;
    if (existing) {
      sqlite
        .prepare(
          "UPDATE users SET name = ?, platform_role = 'superadmin', status = 'active', updated_at = ? WHERE id = ?",
        )
        .run("API Test Platform Administrator", now, userId);
    } else {
      sqlite
        .prepare(
          "INSERT INTO users (id, email, name, platform_role, status, created_at, updated_at) VALUES (?, ?, ?, 'superadmin', 'active', ?, ?)",
        )
        .run(
          userId,
          testOperatorEmail,
          "API Test Platform Administrator",
          now,
          now,
        );
    }

    const tenantRows = sqlite.prepare("SELECT id FROM tenants").all() as Array<{ id: string }>;
    const grant = sqlite.prepare(
      "INSERT OR IGNORE INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'admin', ?)",
    );
    for (const tenant of tenantRows) grant.run(userId, tenant.id, now);
  } finally {
    closeDb();
  }
}

provisionTestOperator();
