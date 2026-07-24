import type { FastifyInstance } from "fastify";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, statfs, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertInheritedSqliteWriterLease,
  getDb,
  getRawSqlite,
  getTenantInngestDeploymentEnabledMap,
  tenants,
} from "@agentic/db";
import type { HealthReport } from "@agentic/contracts";
import {
  CURRENT_SCHEMA_VERSION,
  SYSTEM_SLUG,
  blobBackendHealth,
  inngestDeploymentStatus,
  runtimeScheduleHealth,
  tenantInngestConfigStatus,
} from "@agentic/runtime";
import { getLLMGateway } from "../services/llm";
import { probeDefaultLLMProvider } from "../services/llm";
import { fanoutHealth, fanoutStatus } from "../services/fanout-redis";
import {
  memoryDriverHealth,
  memoryDriverStatus,
} from "../services/memory-pgvector";
import { getLlmTelemetryStatus } from "../services/agent-factory/llm-telemetry";
import { listRegisteredApps } from "../services/inngest-registry";
import {
  inngestCloudRegistrationFreshness,
  inngestRegistrationStatus,
} from "../services/inngest-sync";
import { getMcpManager, type McpServerStatus } from "@agentic/mcp";
import {
  checkFactorySandboxRunner,
  checkProductionCodeActExecutor,
} from "../services/execution-plane-health";
import { checkFactoryProductionImageTrust } from "../services/agent-factory/production-image-attestation";

/** apps/api/package.json — used for the `version` field on the report. */
const apiPackageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);

let _cachedVersion: string | null = null;
export async function readApiBuildStatus(
  packageJsonPath = apiPackageJsonPath,
): Promise<{ ok: boolean; version?: string; note?: string }> {
  if (packageJsonPath === apiPackageJsonPath && _cachedVersion) {
    return { ok: true, version: _cachedVersion };
  }
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    const version =
      typeof parsed.version === "string" ? parsed.version.trim() : "";
    if (!version) throw new Error("missing package version");
    if (packageJsonPath === apiPackageJsonPath) _cachedVersion = version;
    return { ok: true, version };
  } catch {
    // A synthetic 0.0.0 used to make broken/missing release metadata look
    // valid. Keep the response non-sensitive and mark readiness false.
    return { ok: false, note: "api package metadata is missing or invalid" };
  }
}

function enabledTenantScope(): Set<string> | null {
  const raw = process.env.AGENTIC_ENABLED_TENANTS?.trim();
  if (!raw) return null;
  const slugs = raw.split(",").map((slug) => slug.trim()).filter(Boolean);
  return slugs.length ? new Set(slugs) : null;
}

/**
 * GET /health — unauthenticated, suitable for load balancers / uptime checks.
 * Per DESIGN.md §12, extended for P4-API-04 with `version`, `schemaVersion`,
 * and an `llmGateway` subsystem block so support can confirm a hot-deploy
 * picked up the env override.
 */
export async function healthRoute(app: FastifyInstance) {
  // Process liveness deliberately has no database/network/image-attestation
  // dependency. Docker uses it to break the first-attestation bootstrap cycle;
  // operators and load balancers must continue to use /health for readiness.
  app.get("/live", async () => ({
    schema: "agentic-api-liveness/v1",
    live: true,
    processRole: process.env.AGENTIC_PROCESS_ROLE?.trim() || "api",
    uptime: Math.round(process.uptime()),
  }));

  app.get("/health", async (_req, reply) => {
    let tenantSlugs = [SYSTEM_SLUG];
    try {
      const enabled = enabledTenantScope();
      // Inngest readiness describes the apps this process actually serves, not
      // every control-plane tenant row. DB-only tenants (for example an
      // interrupted test fixture or a newly-created tenant with no manifest)
      // have no Inngest app and must not inflate degradedTenants. Conversely,
      // intersecting with the live registry keeps a real zombie app visible
      // until the sandbox/tenant teardown unregisters it.
      const registeredSlugs = new Set(
        listRegisteredApps().map((registered) => registered.slug),
      );
      const tenantRows = getDb()
        .select({
          id: tenants.id,
          slug: tenants.slug,
          archivedAt: tenants.archivedAt,
        })
        .from(tenants)
        .all();
      const inngestEnabledByTenant = getTenantInngestDeploymentEnabledMap(
        tenantRows.map((tenant) => tenant.id),
      );
      tenantSlugs = [
        SYSTEM_SLUG,
        ...tenantRows
          .filter(
            (tenant) =>
              tenant.archivedAt === null &&
              inngestEnabledByTenant.get(tenant.id) !== false &&
              registeredSlugs.has(tenant.slug) &&
              (!enabled || enabled.has(tenant.slug)),
          )
          .map((tenant) => tenant.slug),
      ];
    } catch {
      // checkSqlite below reports the schema failure. Health itself must still
      // return a structured 503 instead of crashing before subsystem checks.
    }
    const [
      inngest,
      sqlite,
      disk,
      llmGateway,
      build,
      redisFanout,
      pgvectorMemory,
      sharedBlob,
      mcp,
      productionCodeActExecutor,
      factorySandboxRunner,
      productionImageTrust,
    ] = await Promise.all([
      checkInngest(fetch, [...new Set(tenantSlugs)]),
      checkSqlite(),
      checkDisk(),
      checkLLMGateway(),
      readApiBuildStatus(),
      fanoutHealth(),
      memoryDriverHealth(),
      blobBackendHealth(),
      checkMcp(),
      checkProductionCodeActExecutor(),
      checkFactorySandboxRunner(),
      Promise.resolve(checkFactoryProductionImageTrust()),
    ]);
    const schedules = runtimeScheduleHealth();
    const llmTelemetry = getLlmTelemetryStatus();
    const ok =
      inngest.ok &&
      sqlite.ok &&
      disk.ok &&
      llmGateway.ok &&
      llmTelemetry.ok &&
      build.ok &&
      mcp.ok &&
      redisFanout.ok &&
      pgvectorMemory.ok &&
      sharedBlob.ok;
    const executionPlanesReady =
      productionCodeActExecutor.ok && factorySandboxRunner.ok;
    const ready = ok && schedules.ok && executionPlanesReady && productionImageTrust.ok;
    const report: HealthReport = {
      ok: ready,
      ts: Date.now(),
      uptime: Math.round(process.uptime()),
      ...(build.version ? { version: build.version } : {}),
      build,
      schemaVersion: String(CURRENT_SCHEMA_VERSION),
      inngest,
      sqlite,
      disk,
      schedules,
      llmGateway,
      llmTelemetry,
      mcp,
      // #SCALE — pluggable-backend status (config-flip verification from one curl).
      blobBackend: sharedBlob.driver,
      fanout: fanoutStatus(),
      memoryDriver: memoryDriverStatus(),
      configuredBackends: {
        ok: redisFanout.ok && pgvectorMemory.ok && sharedBlob.ok,
        redisFanout,
        pgvectorMemory,
        sharedBlob,
      },
      productionCodeActExecutor,
      factorySandboxRunner,
      productionImageTrust,
    };
    return reply.status(ready ? 200 : 503).send(report);
  });
}

async function checkLLMGateway(): Promise<
  NonNullable<HealthReport["llmGateway"]>
> {
  try {
    const g = getLLMGateway();
    const mock =
      g.defaultProvider === "mock" || /mock/i.test(g.defaultModel ?? "");
    const configured =
      g.listProviders().find((p) => p.id === g.defaultProvider)?.hasKey ===
      true;
    const live = await probeDefaultLLMProvider({ maxAgeMs: 60_000 });
    return {
      ok:
        (process.env.NODE_ENV === "test"
          ? true
          : !mock && configured && !!g.defaultModel) && live.ok,
      defaultProvider: g.defaultProvider,
      defaultModel: g.defaultModel ?? undefined,
      providers: g.listProviders().length,
      reachable: live.reachable,
      lastCheckedAt: live.checkedAt,
      latencyMs: live.latencyMs,
      statusCode: live.statusCode,
      ...(live.note ? { note: live.note } : {}),
      // #NOMOCK — explicit flag so a mock runtime can never masquerade as real (one curl reveals it).
      mock,
    };
  } catch {
    return { ok: false };
  }
}

export function summarizeMcp(
  statuses: McpServerStatus[],
  checkedAt: number,
): NonNullable<HealthReport["mcp"]> {
  const label = (status: McpServerStatus) =>
    status.scope ? `${status.scope}:${status.name}` : status.name;
  const requiredUnavailable = statuses
    .filter((status) => !status.connected && status.optional === false)
    .map(label);
  const optionalUnavailable = statuses
    .filter((status) => !status.connected && status.optional !== false)
    .map(label);
  return {
    ok: requiredUnavailable.length === 0,
    degraded: optionalUnavailable.length > 0,
    configured: statuses.length,
    connected: statuses.filter((status) => status.connected).length,
    requiredUnavailable,
    optionalUnavailable,
    checkedAt,
  };
}

export async function checkMcp(): Promise<NonNullable<HealthReport["mcp"]>> {
  const manager = getMcpManager();
  const checkedAt = Date.now();
  if (manager.describe().length === 0) return summarizeMcp([], checkedAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const statuses = await Promise.race([
      manager.probeAll(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("mcp readiness probe timed out")),
          2_000,
        );
      }),
    ]);
    return summarizeMcp(statuses, checkedAt);
  } catch {
    // probeAll updates individual status before rejecting/timeout. Do not
    // expose transport errors because server URLs/stdio may carry secrets.
    const statuses = manager
      .describe()
      .map((status) => ({ ...status, connected: false }));
    return summarizeMcp(statuses, checkedAt);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkInngest(
  fetchImpl: typeof fetch = fetch,
  tenantSlugs?: string[],
): Promise<HealthReport["inngest"]> {
  const statuses = tenantSlugs?.map(tenantInngestConfigStatus) ?? [];
  const blockedTenants = statuses
    .filter((status) => status.readiness === "blocked")
    .map((status) => status.slug);
  const degradedTenants = statuses
    .filter((status) => status.readiness === "degraded")
    .map((status) => status.slug);
  const statusModes = [...new Set(statuses.map((status) => status.mode))];
  const deployment = inngestDeploymentStatus();
  const mode: NonNullable<HealthReport["inngest"]["mode"]> = tenantSlugs
    ? statusModes.length === 1
      ? statusModes[0]!
      : statusModes.length > 1
        ? "mixed"
        : deployment.mode
    : deployment.mode;
  const configFields = tenantSlugs
    ? {
        mode,
        readiness: (blockedTenants.length
          ? "blocked"
          : degradedTenants.length
            ? "degraded"
            : "ready") as "ready" | "degraded" | "blocked",
        configuredTenants: statuses.length,
        degradedTenants,
        blockedTenants,
      }
    : { mode };
  const registeredApps = tenantSlugs ? listRegisteredApps() : [];
  const emptyApps = registeredApps
    .filter((app) => app.fnCount === 0)
    .map((app) => app.appId);
  const registration = tenantSlugs
    ? inngestRegistrationStatus(registeredApps)
    : null;
  const registrationFields = registration
    ? {
        registrationOk: registration.ok,
        expectedApps: registration.expectedApps,
        syncedApps: registration.syncedApps,
        ...(emptyApps.length > 0 ? { emptyApps } : {}),
        ...(registration.lastSyncAt != null
          ? { lastSyncAt: registration.lastSyncAt }
          : {}),
      }
    : {};
  if (blockedTenants.length) {
    return {
      ok: false,
      reachable: false,
      ...configFields,
      ...registrationFields,
      note: `tenant Inngest configuration blocked: ${blockedTenants.join(", ")}`,
    };
  }

  // Fastify-inject tests explicitly disable broker sync because they have no
  // listening port. NODE_ENV=test alone cannot skip this probe: browser/E2E
  // stacks also use test fixtures and still need a real broker health proof.
  // `tenantSlugs` is supplied by the real /health route. Omitted slugs mean a
  // focused network-probe unit call, which must not inherit the test harness's
  // sync-disable flag.
  if (tenantSlugs && process.env.INNGEST_SYNC_DISABLED === "1") {
    if (process.env.NODE_ENV !== "test") {
      return {
        ok: false,
        reachable: false,
        ...configFields,
        ...registrationFields,
        note: "INNGEST_SYNC_DISABLED is allowed only in isolated tests",
      };
    }
    return {
      ok: true,
      ...configFields,
      ...registrationFields,
      note: degradedTenants.length
        ? "isolated test process; network probe explicitly disabled; tenant configuration degraded"
        : "isolated test process; network probe explicitly disabled",
    };
  }

  const configuredBases = tenantSlugs
    ? [
        ...new Set(
          statuses
            .filter((status) => status.mode !== "cloud")
            .map((status) => status.baseUrl)
            .filter((url): url is string => Boolean(url)),
        ),
      ]
    : deployment.baseUrl
      ? [deployment.baseUrl]
      : [];
  const hasCloud = tenantSlugs
    ? statuses.some((status) => status.mode === "cloud")
    : deployment.mode === "cloud";
  if (!configuredBases.length && !hasCloud) {
    return {
      ok: false,
      reachable: false,
      ...configFields,
      ...registrationFields,
      note: "a development/self-hosted Inngest profile requires INNGEST_BASE_URL",
    };
  }

  // A successful Cloud sync is itself a signed, live control-plane exchange.
  // Cloud has no single INNGEST_BASE_URL to poll because its API and Event API
  // use distinct managed origins.
  let anyReachable = hasCloud && registration?.ok === true;
  for (const configuredBase of configuredBases) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(configuredBase);
      if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      return {
        ok: false,
        reachable: false,
        ...configFields,
        ...registrationFields,
        note: `Inngest base URL is invalid: ${configuredBase}`,
      };
    }

    const base = baseUrl.toString().replace(/\/+$/, "");
    const candidates = [`${base}/health`, base];
    let baseHealthy = false;
    let lastStatus: number | undefined;
    for (const url of candidates) {
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(2000),
        });
        anyReachable = true;
        lastStatus = response.status;
        if (response.ok) {
          baseHealthy = true;
          break;
        }
      } catch {
        // Try the broker root as a compatibility probe after /health.
      }
    }
    if (!baseHealthy) {
      return {
        ok: false,
        reachable: anyReachable,
        ...configFields,
        ...registrationFields,
        note: anyReachable
          ? `Inngest at ${base} responded with HTTP ${lastStatus ?? "error"}`
          : `Inngest at ${base} is unreachable`,
      };
    }
  }

  if (registration && !registration.ok) {
    return {
      ok: false,
      reachable: anyReachable,
      ...configFields,
      ...registrationFields,
      note: `Inngest app sync has no current acceptance proof for: ${registration.unsynced.join(", ") || "registry"}`,
    };
  }

  if (hasCloud && tenantSlugs) {
    const freshness = inngestCloudRegistrationFreshness(
      statuses
        .filter((status) => status.mode === "cloud")
        .map((status) => status.slug),
    );
    if (!freshness.ok) {
      return {
        ok: false,
        reachable: false,
        ...configFields,
        ...registrationFields,
        note: `Inngest Cloud sync proof is stale or missing for: ${freshness.stale.join(", ")}`,
      };
    }
  }

  // The local/self-hosted broker exposes app registration state. Reachability
  // alone is insufficient: a healthy broker with zero synced functions still
  // drops every business event. Cloud deployments may not expose this dev
  // GraphQL surface, so their mandatory proof remains the successful PUT sync
  // performed during startup and on every mutation.
  if (process.env.INNGEST_DEV === "1" && tenantSlugs) {
    const expected = registeredApps;
    if (expected.length === 0) {
      return {
        ok: false,
        reachable: true,
        ...configFields,
        ...registrationFields,
        note: "Inngest is reachable but the local runtime registry has no apps",
      };
    }
    // An app with no functions has nothing to dispatch, and Inngest therefore
    // does not establish a dispatch session for it (`connected:false` is the
    // stable, valid broker state). Its successful PUT/sync receipt above still
    // proves that the empty registration was accepted; only non-empty apps
    // need the independent connected/function-count dispatch proof below.
    const dispatchApps = expected.filter((app) => app.fnCount > 0);
    const statusBySlug = new Map(
      statuses.map((status) => [status.slug, status]),
    );
    const appsByBase = new Map<string, typeof dispatchApps>();
    for (const app of dispatchApps) {
      const base = (
        statusBySlug.get(app.slug)?.baseUrl ?? configuredBases[0]!
      ).replace(/\/+$/, "");
      appsByBase.set(base, [...(appsByBase.get(base) ?? []), app]);
    }
    const unhealthy: string[] = [];
    for (const [base, brokerApps] of appsByBase) {
      try {
        const response = await fetchImpl(`${base}/v0/gql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: "{ apps { name connected functionCount error } }",
          }),
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) {
          unhealthy.push(`${base}:registry-http-${response.status}`);
          continue;
        }
        const payload = (await response.json()) as {
          data?: {
            apps?: Array<{
              name?: string;
              connected?: boolean;
              functionCount?: number;
              error?: string | null;
            }>;
          };
        };
        const actual = new Map(
          (payload.data?.apps ?? []).map((entry) => [entry.name, entry]),
        );
        for (const app of brokerApps) {
          const registered = actual.get(app.appId);
          if (!registered) unhealthy.push(`${app.appId}:missing`);
          else if (registered.connected !== true)
            unhealthy.push(`${app.appId}:disconnected`);
          else if (registered.error)
            unhealthy.push(`${app.appId}:${registered.error}`);
          else if (
            !Number.isFinite(registered.functionCount) ||
            registered.functionCount !== app.fnCount
          ) {
            unhealthy.push(
              `${app.appId}:functions=${registered.functionCount ?? "unknown"}/${app.fnCount}`,
            );
          }
        }
      } catch (error) {
        unhealthy.push(
          `${base}:registry-probe-failed:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (unhealthy.length > 0) {
      return {
        ok: false,
        reachable: true,
        ...configFields,
        ...registrationFields,
        note: `Inngest tenant apps are not dispatch-ready: ${unhealthy.join(", ")}`,
      };
    }
    return {
      ok: true,
      reachable: true,
      ...configFields,
      ...registrationFields,
      note:
        `${dispatchApps.length} dispatchable Inngest app(s) connected with registered functions across ${appsByBase.size} broker(s)` +
        (emptyApps.length > 0
          ? `; ${emptyApps.length} empty app(s) require no dispatch session`
          : ""),
    };
  }

  return {
    ok: true,
    reachable: true,
    ...configFields,
    ...registrationFields,
    ...(hasCloud && !degradedTenants.length
      ? {
          note: "Inngest Cloud accepted the current app/function registration set",
        }
      : degradedTenants.length
        ? {
            note: `tenant Inngest configuration degraded: ${degradedTenants.join(", ")}`,
          }
        : {}),
  };
}

export async function checkSqlite(): Promise<HealthReport["sqlite"]> {
  try {
    const dbPath =
      process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./agentic.db";
    if (
      process.env.AGENTIC_SQLITE_WRITER_SUPERVISED?.trim() === "1"
      && process.env.AGENTIC_DATABASE_READONLY?.trim() !== "1"
      && process.env.AGENTIC_DATABASE_READONLY?.trim().toLowerCase() !== "true"
    ) {
      // Re-prove the canonical token on every readiness probe. If an owner
      // record changes, health turns non-ready immediately instead of waiting
      // for the supervisor heartbeat interval to terminate this process.
      assertInheritedSqliteWriterLease(
        process.env.DATABASE_URL?.trim() || `file:${dbPath}`,
      );
    }
    const st = await stat(dbPath);
    const sql = getRawSqlite();
    const mode = sql.pragma("journal_mode", { simple: true }) as string;
    // SELECT 1 made an empty, accidentally-created SQLite file look healthy.
    // Prove the migrated control-plane schema and basic file integrity instead.
    sql.prepare("SELECT 1 FROM tenants LIMIT 1").get();
    const schema = sql
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value?: unknown } | undefined;
    if (typeof schema?.value !== "string" || !schema.value.trim()) {
      throw new Error("sqlite schema metadata is missing");
    }
    const migration = sql
      .prepare("SELECT 1 AS ok FROM __drizzle_migrations LIMIT 1")
      .get() as { ok?: unknown } | undefined;
    if (migration?.ok !== 1)
      throw new Error("sqlite migration ledger is empty");
    const quickCheck = sql.pragma("quick_check(1)", { simple: true }) as string;
    if (quickCheck !== "ok") throw new Error("sqlite quick_check failed");
    return { ok: true, sizeBytes: st.size, journalMode: mode };
  } catch {
    return {
      ok: false,
      note: "database file is missing, unmigrated, or failed integrity checks",
    };
  }
}

async function checkDisk(): Promise<HealthReport["disk"]> {
  const logsDir = process.env.AGENTIC_LOGS_DIR ?? "./logs";
  const resolved = path.resolve(logsDir);
  const probePath = path.join(
    resolved,
    `.agentic-log-write-probe-${process.pid}-${randomUUID()}`,
  );
  try {
    await mkdir(resolved, { recursive: true });
    const handle = await open(probePath, "wx", 0o600);
    try {
      await handle.writeFile("agentic-log-readiness\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
      await unlink(probePath).catch(() => undefined);
    }
    const sfs = await statfs(resolved);
    return {
      ok: true,
      logsDir,
      freeBytes: Number(sfs.bavail) * sfs.bsize,
    };
  } catch {
    await unlink(probePath).catch(() => undefined);
    return {
      ok: false,
      logsDir,
      note: "log storage is not writable or could not be fsynced",
    };
  }
}
