/**
 * Boot-time wiring: runs `bootstrapAll()` from @agentic/runtime which reads
 * manifests from `models/<slug>/` and returns an array of Inngest functions,
 * then exposes them via the `inngest/fastify` adapter.
 *
 * Tenant code wiring lives HERE (not in @agentic/runtime) because pnpm's
 * isolated module resolution requires each package to declare its own deps.
 * To add a new tenant with custom tools/prompts:
 *   1. Create `tenants/<slug>/` (see tenants/raas/ as the template)
 *   2. Add `"@tenants/<slug>": "workspace:*"` to apps/api/package.json
 *   3. Import + register here
 *   4. Drop `models/<slug>/` for the manifest
 *
 * Pure-declarative tenants (manifest only, no custom code) skip steps 1-3
 * and just need a `models/<slug>/` folder — bootstrap auto-discovers them
 * and they run with the generic @agentic/tools fallbacks.
 */

import {
  bootstrapAllByTenant,
  bootstrapTenantBySlug,
  helloFn,
  inngest,
  setRuntimeGateway,
  setRuntimeMetrics,
  setMemoryDriver,
  createLocalVectorDriver,
  openaiEmbedder,
  assertConfiguredBlobBackendReady,
  loadLiveTenants,
  loadTenant,
  resolveLiveVersion,
  retentionSweepFunctions,
  type TenantRegistries,
} from "@agentic/runtime";
import type { Inngest, InngestFunction } from "inngest";
import raasTenant from "@tenants/raas";
import robohireTenant from "@tenants/robohire";
import northwindTenant from "@tenants/northwind";
import insightlabTenant from "@tenants/insightlab";
import zhaopinTenant from "@tenants/zhaopin";
import agentsGenerationTenant from "@tenants/agents-generation";
import {
  bootstrapCodeAgents,
  setGateway as setAgentGateway,
} from "@agentic/agents";
import { setIntegrationResolver } from "@agentic/tools";
import { resolveCredsByTenantSlug } from "./services/integration-store";
import "@agentic/agents/system";
import type { TenantRegistry } from "@agentic/agent-kit";
import {
  getMcpManager,
  McpServerConfigSchema,
  type McpServerConfig,
} from "@agentic/mcp";
import { buildSkillTools, type SkillDescriptor } from "@agentic/skills";
import {
  assertDefaultLLMProviderReachable,
  assertRealLLMGateway,
  getLLMGateway,
} from "./services/llm";
import { wireLlmTelemetry } from "./services/agent-factory/llm-telemetry";
import { metrics } from "./services/metrics";
import { reconcileImports } from "./services/reconcile-imports";
import { getDb, pruneRolledBackDeployments, tenants } from "@agentic/db";
import {
  initInngestRegistry,
  reregisterInngest,
} from "./services/inngest-registry";
import { startGovernanceRunner } from "./services/agent-factory/fleet-governance-runner.js";
import { assertConfiguredMemoryEmbedderReady } from "./services/memory-pgvector";
import { ensureCanonicalDataPaths } from "./config/data-paths";
import { syncTenantReasoningConfigs } from "./services/reasoning/tenant-config";
import { assertZhaopinProductionRuntimeConfig } from "./config/zhaopin-runtime";
import {
  getRuntimeTenantRegistrySnapshot,
  publishRuntimeTenantRegistrySnapshot,
} from "./services/agent-factory/tenant-native-tool-provider";
import { getFactorySandboxTenantRegistryAlias } from "./services/agent-factory/sandbox-tenant-registry-alias";
import { createSandboxModelProxyGateway } from "./services/agent-factory/sandbox-model-client";
import { installProductionGeneratedAgentAuthorizationVerifier } from "./services/agent-factory/production-codeact-authorization";
import { studioRunnerFn } from "./services/studio-runner";
import { enabledTenantDeploymentScope } from "./services/tenant-deployment-scope";

/**
 * v4 typing: TS2742 surfaces because `InngestFunction` references internal
 * `api/api` symbols. Pin the return type so consumers don't need to import
 * package internals.
 */
export interface BootstrapResult {
  inngest: Inngest.Any;
  functions: InngestFunction.Any[];
}

/** The exact function slice served on the __system Inngest app. Exported so
 * startup contract tests can prove env-controlled schedules are registered. */
export function buildSystemBaseFns(
  env: Record<string, string | undefined> = process.env,
): InngestFunction.Any[] {
  // Studio runs execute on the platform (__system) app: studioRunnerFn is
  // built on the same shared Inngest client as helloFn and serves every
  // tenant's Agent Studio test runs.
  return [helloFn, studioRunnerFn, ...retentionSweepFunctions(env)];
}

export class RuntimeStartupRecoveryError extends Error {
  constructor(component: string, detail: string) {
    super(`${component} startup recovery failed: ${detail}`);
    this.name = "RuntimeStartupRecoveryError";
  }
}

/**
 * Map of tenant slug → tenant code registry. Keys MUST match the slug
 * derived from each `models/<folder>/` directory (e.g. "RAAS-v1" → "raas").
 *
 * Test-fixture registries are deliberately absent from this production map.
 * Tests load them dynamically in `tenantRegistriesForProcess`; a runnable
 * server must never import or register `__system` / `tenant-test1` fixture
 * prompts and tools.
 */
const PRODUCTION_TENANT_REGISTRIES: TenantRegistries = {
  raas: raasTenant,
  robohire: robohireTenant,
  northwind: northwindTenant,
  insightlab: insightlabTenant,
  zhaopin: zhaopinTenant,
  "agents-generation": agentsGenerationTenant,
};

function enabledTenantScope(): Set<string> | null {
  return enabledTenantDeploymentScope();
}

function isTenantEnabled(slug: string, scope = enabledTenantScope()): boolean {
  return !scope || scope.has(slug);
}

function filterTenantRegistriesForScope(
  registries: TenantRegistries,
  scope = enabledTenantScope(),
): TenantRegistries {
  if (!scope) return registries;
  return Object.fromEntries(
    Object.entries(registries).filter(([slug]) => scope.has(slug)),
  ) as TenantRegistries;
}

/** Exact code version paired with each runtime registry snapshot. Dynamic
 * tenant-code selections overwrite the workspace declaration below. */
const selectedTenantRegistryVersions = new Map<string, string>();

/**
 * Read-only CLI composition seam. Normal API startup publishes the expanded
 * registry snapshots during bootstrap; the standalone Factory preflight does
 * not bootstrap Inngest, so it must explicitly load the exact selected
 * registry before asking makeFactoryPorts for tenant-native tools.
 */
export async function ensureTenantRegistrySnapshotForReadOnlyPreflight(
  tenantSlug: string,
): Promise<ReturnType<typeof getRuntimeTenantRegistrySnapshot>> {
  const existing = getRuntimeTenantRegistrySnapshot(tenantSlug);
  if (existing) return existing;

  const dynamicVersion = await resolveLiveVersion(tenantSlug);
  const dynamic = dynamicVersion
    ? await loadTenant(tenantSlug, dynamicVersion)
    : null;
  const registry = dynamic?.registry ?? PRODUCTION_TENANT_REGISTRIES[tenantSlug];
  if (!registry) return undefined;
  const selectedVersion = dynamic?.registry
    ? dynamicVersion!
    : registry.factory?.source.version || "workspace-unversioned";
  publishRuntimeTenantRegistrySnapshot({
    tenantSlug,
    selectedVersion,
    registry,
  });
  selectedTenantRegistryVersions.set(tenantSlug, selectedVersion);
  return getRuntimeTenantRegistrySnapshot(tenantSlug);
}

async function tenantRegistriesForProcess(): Promise<TenantRegistries> {
  const scope = enabledTenantScope();
  const registries: TenantRegistries = filterTenantRegistriesForScope(
    { ...PRODUCTION_TENANT_REGISTRIES },
    scope,
  );
  for (const [slug, registry] of Object.entries(registries)) {
    selectedTenantRegistryVersions.set(
      slug,
      registry?.factory?.source.version || "workspace-unversioned",
    );
  }
  if (process.env.NODE_ENV === "test") {
    const [{ default: systemTenant }, { default: tenantTest1 }] =
      await Promise.all([
        import("@tenants/__system"),
        import("@tenants/tenant-test1"),
      ]);
    registries.__system = systemTenant;
    registries["tenant-test1"] = tenantTest1;
  }
  // Dynamically uploaded tenant-code deployments are selected by their LIVE
  // deployment pointer. Loading them here makes that pointer durable across a
  // process restart; previously only the hard-wired workspace registries were
  // considered, so tenant-code deploy/rollback history was control-plane only.
  // API tests clone deployment history but intentionally redirect tenant-code
  // artifacts to a fresh temp root. Loading historical pointers during test
  // boot would therefore report a false integrity failure before a test can
  // upload its fixture. Scoped hot swaps still exercise dynamic selection.
  if (process.env.NODE_ENV !== "test") {
    const dynamic = await loadLiveTenants();
    for (const [slug, loaded] of dynamic) {
      if (!isTenantEnabled(slug, scope)) continue;
      if (loaded.registry) {
        registries[slug] = loaded.registry as TenantRegistry;
        selectedTenantRegistryVersions.set(slug, loaded.version);
      }
    }
  }
  return registries;
}

/**
 * The MCP/Skills-expanded tenant registries, captured at boot so a runtime
 * re-register (deploy / undeploy / archive) can re-run `bootstrapAll` against
 * the SAME registries without re-connecting MCP servers. `rebuildTenantFns`
 * reads this. Empty until `bootstrapRuntime` populates it.
 */
let cachedExpanded: TenantRegistries = {};

/**
 * Resolve the exact tenant registry used by live manifest functions. Studio
 * runs use this read-only seam so prompt overrides, tenant tool overrides,
 * MCP tools, and Skills tools follow the same resolution order as production.
 */
export function getExpandedTenantRegistry(
  tenantSlug: string,
): TenantRegistry | undefined {
  return cachedExpanded[tenantSlug];
}

/**
 * Re-run the manifest bootstrap and return the fresh tenant Inngest function
 * set. Called by `reregisterInngest({ scope: "tenant" })` (via dynamic import
 * to dodge the circular dep). This is what makes 上线/下线 actually hot-swap:
 *
 *   - 上线 (deploy): the import wizard renames the new manifest onto disk, then
 *     reregisters → `bootstrapAll` re-reads disk → the new agent set is served.
 *   - 下线 (disable): a route flips `agents.enabled=false`, then reregisters →
 *     `bootstrapTenant` skips disabled agents → their functions drop out.
 *   - archive: an archived tenant is skipped entirely (see runtime bootstrap).
 *
 * `bootstrapAll` is idempotent (upserts by primary key), so re-running it on a
 * live process only changes the returned function array, never the DB.
 */
export async function rebuildTenantFns(
  slug?: string,
): Promise<InngestFunction.Any[]> {
  // Scoped to one tenant app when a slug is given (the registry's common path);
  // no slug → every tenant's functions flat (back-compat for callers/tests that
  // want the whole fleet).
  if (slug) {
    // A generated candidate must run with the same tenant-native tool registry
    // it would receive after promotion, while its manifest/DB/App identities
    // remain nonce-scoped.  The execution plane installs this generic alias
    // from the signed job; no domain or tool name is hard-coded here.
    const sandboxAlias = getFactorySandboxTenantRegistryAlias(slug);
    if (sandboxAlias) {
      const targetRegistry = sandboxAlias.replayRegistry
        ?? cachedExpanded[sandboxAlias.targetTenantSlug];
      const targetSnapshot = sandboxAlias.replayRegistry
        ? undefined
        : getRuntimeTenantRegistrySnapshot(sandboxAlias.targetTenantSlug);
      if (!targetRegistry || (!sandboxAlias.replayRegistry && !targetSnapshot)) {
        throw new Error(
          `sandbox target registry is unavailable: ${sandboxAlias.targetTenantSlug}`,
        );
      }
      if (
        !sandboxAlias.replayRegistry
        && sandboxAlias.expectedRegistryVersion
        && targetSnapshot!.selectedVersion !== sandboxAlias.expectedRegistryVersion
      ) {
        throw new Error(
          `sandbox target registry version mismatch: expected ${sandboxAlias.expectedRegistryVersion}, got ${targetSnapshot!.selectedVersion}`,
        );
      }
      const projected = { ...cachedExpanded, [slug]: targetRegistry };
      syncTenantReasoningConfigs(projected);
      return bootstrapTenantBySlug(slug, projected);
    }
    // AGENTIC_ENABLED_TENANTS is the process ownership ceiling. A scoped hot
    // swap must honor it too; otherwise a UI/API call could make this shard
    // start serving a tenant assigned to another process.
    if (!isTenantEnabled(slug)) {
      throw new Error(
        `tenant "${slug}" is outside this process's AGENTIC_ENABLED_TENANTS deployment scope`,
      );
    }
    // Refresh the code registry from the DB-selected tenant-code version on
    // every scoped hot swap. This is required for both deploy and rollback:
    // retaining the boot-time cached registry would rebuild the workflow with
    // the old code even though the live pointer had changed successfully.
    const selectedVersion = await resolveLiveVersion(slug);
    const selected = selectedVersion
      ? (await loadTenant(slug, selectedVersion))?.registry
      : null;
    if (selected) {
      const expanded = await expandTenantRegistry(slug, selected as TenantRegistry);
      cachedExpanded = { ...cachedExpanded, [slug]: expanded };
      if (expanded) {
        publishRuntimeTenantRegistrySnapshot({
          tenantSlug: slug,
          selectedVersion: selectedVersion!,
          registry: expanded,
        });
      }
    }
    syncTenantReasoningConfigs(cachedExpanded);
    return bootstrapTenantBySlug(slug, cachedExpanded);
  }
  syncTenantReasoningConfigs(cachedExpanded);
  return [...(await bootstrapAllByTenant(cachedExpanded, {
    enabledTenantSlugs: enabledTenantScope() ?? undefined,
  })).values()].flat();
}

/**
 * Full per-tenant rebuild — every tenant's functions, grouped by slug. Used by
 * `reregisterInngest({ scope: "tenant" })` with no slug (archive/restore that
 * don't carry a slug, or a global refresh). The scoped single-slug path
 * (`rebuildTenantFns`) is preferred for deploy / 上线·下线.
 */
export async function rebuildAllTenantFnsByTenant(): Promise<
  Map<string, InngestFunction.Any[]>
> {
  syncTenantReasoningConfigs(cachedExpanded);
  return bootstrapAllByTenant(cachedExpanded, {
    enabledTenantSlugs: enabledTenantScope() ?? undefined,
  });
}

/**
 * Re-run the code-agent bootstrap and rebuild its durable Inngest consumers.
 */
export async function rebuildCodeAgentFns(): Promise<InngestFunction.Any[]> {
  const summary = await bootstrapCodeAgents();
  return summary.codeAgentFns;
}

export interface BootstrapRuntimeOptions {
  processRole?: "api" | "sandbox-runner";
}

/** Minimal boot path for the remote candidate workload.
 *
 * It deliberately does not discover the image's production model tree, load a
 * live tenant-code deployment pointer, register system/code agents, reconcile
 * production data, or open MCP transports. Candidate manifests are staged from
 * the signed bundle by ManifestSandboxDeployer after this process is ready.
 * The packaged tenant registries are made available only as version-checked
 * native adapter code for the explicitly signed target tenant. */
export async function bootstrapSandboxWorkloadRuntime(): Promise<BootstrapResult> {
  const dataPaths = ensureCanonicalDataPaths();
  console.log(
    `[bootstrap] isolated sandbox workload data root — ${dataPaths.dataRoot} (source=${dataPaths.source})`,
  );
  // The signed remote-bundle contract accepts only exact generated CodeAct
  // candidates. Their deterministic replay must not require or inherit the
  // production LLM gateway: the workload network denies public egress and the
  // candidate worker itself receives env: {}. A manifest that unexpectedly
  // reaches an LLM step therefore fails closed at execution time instead of
  // making workload readiness depend on production provider credentials.
  setMemoryDriver(createLocalVectorDriver());
  setRuntimeMetrics(metrics);
  // Real semantic execution is proxied back to the primary API. Provider
  // credentials never enter the workload/candidate; the per-attempt context
  // installed by the signed bundle executor supplies tenant/budget identity.
  setRuntimeGateway(createSandboxModelProxyGateway());

  const registries: TenantRegistries = { ...PRODUCTION_TENANT_REGISTRIES };
  for (const [slug, registry] of Object.entries(registries)) {
    if (!registry) continue;
    const selectedVersion = registry.factory?.source.version || "workspace-unversioned";
    selectedTenantRegistryVersions.set(slug, selectedVersion);
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion,
      registry,
    });
  }
  cachedExpanded = registries;
  syncTenantReasoningConfigs(cachedExpanded);
  console.log(
    `[bootstrap] isolated sandbox workload ready — ${Object.keys(registries).length} version-bound native adapter registry entries; zero production manifests`,
  );
  return { inngest, functions: [] };
}

export async function bootstrapRuntime(
  options: BootstrapRuntimeOptions = {},
): Promise<BootstrapResult> {
  const sandboxRunner = options.processRole === "sandbox-runner";
  // Reconcile durable sandbox attempts before model discovery can load a stale
  // ephemeral manifest or register it as a normal tenant app. Tests exercise
  // this service in isolation and never call a real Inngest/Allmeta endpoint.
  if (process.env.NODE_ENV !== "test") {
    const { reconcileFactorySandboxOrphans } = await import(
      "./services/agent-factory/sandbox-reaper"
    );
    await reconcileFactorySandboxOrphans({ startup: true });
  }
  if (
    !sandboxRunner &&
    process.env.NODE_ENV === "production" &&
    getDb()
      .select({ slug: tenants.slug })
      .from(tenants)
      .all()
      .some((tenant) => tenant.slug === "zhaopin" && isTenantEnabled(tenant.slug))
  ) {
    assertZhaopinProductionRuntimeConfig();
  }
  const dataPaths = ensureCanonicalDataPaths();
  // Install the production generated-Agent verifier before any tenant
  // manifest is composed. Missing/tampered durable authority then fails
  // tenant bootstrap for both declarative and CodeAct generated functions.
  if (!sandboxRunner) installProductionGeneratedAgentAuthorizationVerifier();

  // Recover the distributed promotion checkpoint before the first manifest
  // bootstrap. The runtime verifier intentionally rejects pending ledger
  // records outside the exact in-process activation window, so doing this
  // later would make a recoverable crash look like an unauthorized tenant.
  let protectedFactoryDeploymentIds: string[] = [];
  if (!sandboxRunner && process.env.NODE_ENV !== "test") {
    const { reconcilePendingFactoryPromotions } = await import(
      "./services/agent-factory/promotion-recovery"
    );
    const promotionRecovery = await reconcilePendingFactoryPromotions({
      startupExclusive: true,
    });
    protectedFactoryDeploymentIds = promotionRecovery.protectedDeploymentIds;
    if (promotionRecovery.pendingSeen > 0 || promotionRecovery.failures > 0) {
      console.log(
        `[bootstrap] factory promotion reconcile — finalized ${promotionRecovery.finalized}, aborted pre-commit ${promotionRecovery.abortedBeforeCommit}, retained ${promotionRecovery.retained}, failures ${promotionRecovery.failures}`,
      );
    }
    if (promotionRecovery.failures > 0 || promotionRecovery.retained > 0) {
      throw new RuntimeStartupRecoveryError(
        "factory promotion",
        `${promotionRecovery.failures} failed and ${promotionRecovery.retained} remained unresolved`,
      );
    }
  }
  console.log(
    `[bootstrap] durable data root — ${dataPaths.dataRoot} (source=${dataPaths.source})`,
  );
  // 1. Construct LLM gateway once and wire it into both consumers
  //    (agents package for BaseAgent.run, runtime package for step-engine logic actions).
  const gateway = getLLMGateway();
  if (!sandboxRunner) {
    assertRealLLMGateway("API bootstrap", gateway);
    await assertDefaultLLMProviderReachable("API bootstrap");
  } else {
    // The runner has no public egress by default. Exact CodeAct candidates do
    // not call a model and are admitted by ManifestSandboxDeployer only when
    // every function carries reviewed handler bytes. A declarative/LLM-backed
    // candidate still fails its sandbox gate until an internal allowlisted
    // model gateway is configured; a mock response is never graded as real.
    console.log(
      `[bootstrap] sandbox runner gateway loaded without connectivity probe — provider=${gateway.defaultProvider}`,
    );
  }
  setAgentGateway(gateway);
  setRuntimeGateway(gateway);
  // Wire the integration credential resolver so DB-backed integrations
  // (Settings → Integrations, e.g. GoHire) reach the global tool family at
  // dispatch time. @agentic/tools stays DB-free — it just calls this seam.
  setIntegrationResolver((tenantSlug, provider) =>
    resolveCredsByTenantSlug(tenantSlug, provider),
  );
  // Vector-recall memory: register a real driver so ctx.memory.search() returns cosine-ranked hits
  // instead of NoMemoryDriverError. Prefer a gateway embed model when MEMORY_EMBED_MODEL is set,
  // else the self-contained local (offline, deterministic) embedder. Opt out with MEMORY_VECTOR=off.
  const pgvectorConfigured = Boolean(process.env.AGENTIC_PGVECTOR_URL?.trim());
  const remoteEmbedderConfigured = Boolean(
    process.env.MEMORY_EMBED_MODEL?.trim(),
  );
  if (
    process.env.MEMORY_VECTOR === "off" &&
    (pgvectorConfigured || remoteEmbedderConfigured)
  ) {
    throw new Error(
      "Invalid infrastructure configuration: vector backend/embedder is configured while MEMORY_VECTOR=off",
    );
  }
  if (process.env.MEMORY_VECTOR !== "off") {
    if (
      pgvectorConfigured &&
      remoteEmbedderConfigured &&
      process.env.MEMORY_EMBED_DIMENSIONS?.trim() !== "256"
    ) {
      throw new Error(
        "pgvector uses vector(256); set MEMORY_EMBED_DIMENSIONS=256 for the configured remote embedder",
      );
    }
    const embed = openaiEmbedder() ?? undefined;
    await assertConfiguredMemoryEmbedderReady(embed);
    setMemoryDriver(createLocalVectorDriver(embed ? { embed } : {}));
    // #SCALE-PGVECTOR — upgrade vector recall to Postgres/pgvector when AGENTIC_PGVECTOR_URL is set
    // SQLite remains the KV system of record, while pgvector is a hard search/index contract.
    // Configuration is a deployment promise: backend or embedder failure aborts boot and live
    // operations never silently substitute local/empty search results.
    let memoryBackend = embed
      ? `local+gateway(${process.env.MEMORY_EMBED_MODEL})`
      : "local";
    if (pgvectorConfigured) {
      const { wirePgVectorMemory } = await import("./services/memory-pgvector");
      const wired = await wirePgVectorMemory(embed);
      if (!wired) {
        throw new Error(
          "AGENTIC_PGVECTOR_URL is configured but pgvector wiring returned inactive",
        );
      }
      memoryBackend = `pgvector+${embed ? `gateway(${process.env.MEMORY_EMBED_MODEL})` : "local"}`;
    }
    console.log(
      `[bootstrap] memory vector driver — ${memoryBackend} embeddings`,
    );
  }
  // #P0-3 — persist raw LLM telemetry (model/routing/latency/size) to the llm_calls table.
  wireLlmTelemetry();
  // #SCALE-FANOUT — cross-instance SSE fanout via Redis. Unconfigured local fanout is valid;
  // REDIS_URL is a hard deployment contract and must be reachable before the API reports ready.
  if (process.env.REDIS_URL?.trim()) {
    const { wireRedisFanout } = await import("./services/fanout-redis");
    const wired = await wireRedisFanout();
    if (!wired)
      throw new Error(
        "REDIS_URL is configured but Redis fanout wiring returned inactive",
      );
  }
  // #SCALE-BLOB — local fs is a valid single-instance backend. Once a remote backend is
  // configured, prove real PUT + GET before accepting traffic; partial credentials/config abort.
  const blobHealth = await assertConfiguredBlobBackendReady();
  console.log(
    `[bootstrap] blob backend — ${blobHealth.driver}${blobHealth.configured ? " (read/write verified)" : ""}`,
  );
  // #SCALE-RESUME — re-attach factory runs interrupted by a crash/restart (conversation checkpoint).
  // A failed recovery scan is not optional: otherwise durable rows remain "running" while the
  // process advertises readiness. Per-row failures are aggregated by autoResumeCrashedRuns().
  const { autoResumeCrashedRuns } =
    await import("./services/agent-factory/run-registry");
  autoResumeCrashedRuns();
  // UC-V11-22 / AR-GAP-07 — wire the prometheus metrics registry into
  // the manifest engine. Without this the registry exists but
  // `runs_total`, `run_duration_ms` stay flat for any traffic the
  // manifest engine handles (i.e. all RAAS runs).
  setRuntimeMetrics(metrics);
  console.log(
    `[bootstrap] LLM gateway online — default provider=${gateway.defaultProvider}, default model=${gateway.defaultModel ?? "(adapter default)"}, ${gateway.listProviders().length} providers registered`,
  );

  // 2. Bootstrap code-defined agents (writes agents/agent_versions/deployments rows).
  const codeSummary = await bootstrapCodeAgents();
  console.log(
    `[bootstrap] code agents ready — ${codeSummary.agentCount} registered, ${codeSummary.deploymentsWritten} new deployment(s), ` +
      `${codeSummary.staleAgentsDisabled} stale binding(s) disabled, ${codeSummary.deploymentsRolledBack} impossible live deployment(s) rolled back`,
  );

  // 3. Expand each tenant registry with MCP-bridged tools + Skills tools
  //    BEFORE handing the map to `bootstrapAll`. This keeps `@agentic/runtime`
  //    blissfully unaware of MCP/Skills — the runtime sees a single
  //    `tenantRegistry.tools` map and dispatches as usual.
  const expanded: TenantRegistries = {};
  const tenantRegistries = await tenantRegistriesForProcess();
  for (const [slug, base] of Object.entries(tenantRegistries)) {
    // Do not open tenant-declared MCP transports from the no-egress runner.
    // Native registry handlers are already inside the allowlisted image and
    // are version-bound in the candidate bundle; remote/MCP tools must arrive
    // as declarative definitions plus replay evidence instead.
    expanded[slug] = sandboxRunner ? base : await expandTenantRegistry(slug, base);
    if (expanded[slug]) {
      publishRuntimeTenantRegistrySnapshot({
        tenantSlug: slug,
        selectedVersion:
          selectedTenantRegistryVersions.get(slug)
          ?? expanded[slug]!.factory?.source.version
          ?? "workspace-unversioned",
        registry: expanded[slug]!,
      });
    }
  }
  // Capture for runtime re-registration (deploy / undeploy / archive). See
  // `rebuildTenantFns`.
  cachedExpanded = expanded;
  syncTenantReasoningConfigs(expanded);

  // 4. Manifest-driven (RAAS etc) Inngest functions, GROUPED BY tenant so each
  //    tenant becomes its own Inngest app (`agentic-operator-<slug>`).
  const tenantFnsByTenant = await bootstrapAllByTenant(expanded, {
    enabledTenantSlugs: enabledTenantScope() ?? undefined,
  });
  const tenantFns = [...tenantFnsByTenant.values()].flat();
  const systemBaseFns = buildSystemBaseFns();
  // Index 0 = helloFn, index 1 = studioRunnerFn; everything after is an
  // env-controlled schedule (retention sweeps).
  const systemScheduledFns = systemBaseFns.slice(2);
  const allFns = [...systemBaseFns, ...codeSummary.codeAgentFns, ...tenantFns];
  console.log(
    `[bootstrap] api serving ${allFns.length} Inngest function(s) across ${tenantFnsByTenant.size} tenant app(s) + __system (${tenantFns.length} from tenant manifests, ${systemScheduledFns.length} system schedule(s))`,
  );

  // 4a. Seed the MUTABLE per-app Inngest registry so each `/inngest[/:slug]`
  //     route serves a function set that `reregisterInngest()` can swap at
  //     runtime without a restart. The platform app (__system) carries helloFn
  //     (systemBase); code agents are sync-invoked (none yet); every tenant
  //     gets its own app entry. Before this the registry was never initialized
  //     and every re-register silently no-op'd.
  initInngestRegistry({
    systemBase: systemBaseFns,
    systemCodeAgent: codeSummary.codeAgentFns,
    tenants: [...tenantFnsByTenant.entries()].map(([slug, fns]) => ({
      slug,
      fns,
    })),
  });

  // 4a-bis. Inngest dev/cloud sync is started from server.ts AFTER Fastify is
  //     actually listening. Doing it here used to PUT http://localhost:<PORT>
  //     before the route existed, so tenant apps often never appeared until a
  //     later reconciler tick.

  // 4. Crash recovery for the manifest-import wizard (per review C1).
  //    `reconcileImports` does three things:
  //      a. Drop expired `status='pending'` rows + their staging dirs.
  //      b. Complete crashed renames: rows where `file_path` still points at
  //         `AGENTIC_IMPORTS_DIR/...` (phase 4 didn't finish) get renamed into
  //         `models/<slug>-vN/workflow_v<N+1>.json` and the row updated.
  //         If the rename causes a live agent set change, re-register that
  //         tenant's Inngest functions.
  //      c. Re-emit on-disk manifests that were manually deleted, using
  //         `workflow_versions.manifest_json` as the source of truth.
  //    Idempotent; safe to run every boot. Any failed repair blocks readiness so operators never
  //    receive a healthy process whose live deployment and manifest file disagree.
  const sweptImports = await reconcileImports(getDb(), {
    reregister: async (tenantSlug) => {
      await reregisterInngest({ tenantSlug, scope: "tenant" });
    },
  });
  if (
    sweptImports.expired_pruned > 0 ||
    sweptImports.rename_completed > 0 ||
    sweptImports.missing_file_repaired > 0 ||
    sweptImports.failures > 0
  ) {
    console.log(
      `[bootstrap] import reconcile — pruned ${sweptImports.expired_pruned}, repaired ${sweptImports.rename_completed} crashed rename(s), re-emitted ${sweptImports.missing_file_repaired} missing file(s), ${sweptImports.failures} failure(s)`,
    );
  }
  if (sweptImports.failures > 0) {
    throw new RuntimeStartupRecoveryError(
      "manifest import",
      `${sweptImports.failures} recovery operation(s) did not complete`,
    );
  }

  // A Factory promotion spans the target manifest/DB/Inngest activation and
  // the portable regression catalog. If the process died between those two
  // durable commits, reconcile by exact production provenance before serving
  // traffic. The returned deployment ids are immutable CI anchors and must
  // not be removed by generic rolled-back-history compaction below.
  // Factory promotion recovery ran before tenant composition so CodeAct
  // authorization could fail closed without rejecting a recoverable pending
  // checkpoint. `protectedFactoryDeploymentIds` remains in scope for history
  // pruning below.

  // 4b. Deployment-history retention. Every (re)deploy correctly tombstones
  //     the prior live row, but forced re-bootstraps + legacy churn leave the
  //     Deployments page flooded with near-identical rolled_back rows. Cap
  //     each (tenant, target, note) group to the most recent N tombstones,
  //     keeping all live/pending rows and every distinct-note history entry.
  //     Idempotent; runs every boot so the table stays bounded. Skipped under
  //     NODE_ENV=test so vitest's deployment row-count assertions don't flake.
  if (process.env.NODE_ENV !== "test") {
    try {
      const pruned = pruneRolledBackDeployments(
        undefined,
        protectedFactoryDeploymentIds,
      );
      if (pruned.deleted > 0) {
        console.log(
          `[bootstrap] deployment history pruned — removed ${pruned.deleted} rolled_back row(s), kept ${pruned.after} (≤${pruned.retainPerNote} per tenant/target/note)`,
        );
      }
    } catch (err) {
      console.warn("[bootstrap] pruneRolledBackDeployments failed", err);
    }
  }

  // 4b. Stuck-run reconcile — one-shot startup sweep. Inngest dev is not
  //     crash-safe: an api restart drops in-flight handlers so their runs never
  //     reach failRun and stay `running` forever. This reaps every orphan
  //     accumulated while the process was down (HITL-safe — see reconcile-runs).
  if (process.env.NODE_ENV !== "test") {
    const { reconcileRuntimeState } = await import("./services/reconcile-runs");
    const swept = await reconcileRuntimeState({
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
    });
    if (swept.reaped > 0) {
      console.log(
        `[bootstrap] stuck-run reconcile — marked ${swept.reaped} orphaned run(s) failed`,
      );
    }
    if (swept.hitl.retried > 0 || swept.hitl.failed > 0) {
      console.log(
        `[bootstrap] HITL reconcile — retried ${swept.hitl.retried}, failed ${swept.hitl.failed}`,
      );
    }
  }

  // #P7-infra — 治理巡检:定时对每个租户的已交付 function 聚合近 14 天生产战绩 → 建议返工(待人签核,
  // 不自动开)。内部 gated(AGENTIC_GOVERNANCE=1 且非 test),无条件调用安全(默认 no-op)。
  if (!sandboxRunner) await startGovernanceRunner({
    tenantSlugs: () => {
      return getDb()
        .select({ slug: tenants.slug })
        .from(tenants)
        .all()
        .map((row) => row.slug)
        .filter(Boolean);
    },
  });

  return { inngest, functions: allFns };
}

/**
 * Merge MCP-bridged tools (one shim per advertised MCP tool, name
 * qualified as `<server>.<tool>`) and Skills tools (`skills.list_skills`,
 * `skills.load_skill`) into the tenant's existing tools map. Native tools
 * declared in the tenant package WIN on name collisions so a tenant can
 * override an MCP shim by re-defining it locally.
 *
 * MCP failures are tolerated only when the server config explicitly declares
 * `optional: true`. Required-by-default failures abort API composition.
 */
export async function expandTenantRegistry(
  slug: string,
  base: TenantRegistry | undefined,
): Promise<TenantRegistry | undefined> {
  if (!base) return base;

  // --- MCP servers -------------------------------------------------------
  // TenantRegistry keeps this type structural to avoid pulling the SDK into
  // every tenant package. Parse at the composition edge so schema defaults
  // (`optional: false`) and required transport fields are real, not comments.
  let mcpConfigs: McpServerConfig[];
  try {
    mcpConfigs = (base.mcpServers ?? []).map((config) =>
      McpServerConfigSchema.parse(config),
    ) as McpServerConfig[];
  } catch {
    // Zod's input may contain auth headers/env. Do not allow a parse error to
    // serialize the declaration into startup logs.
    throw new Error(`invalid MCP declaration for tenant '${slug}'`);
  }
  let mcpTools: Record<string, import("@agentic/agent-kit").ToolDescriptor> =
    {};
  if (mcpConfigs.length > 0) {
    const mgr = getMcpManager();
    try {
      await mgr.connectAll(mcpConfigs, slug);
      // Never merge the process-wide singleton's other tenants into this
      // registry. Connections and tool maps are tenant-scoped independently.
      mcpTools = mgr.toolMap({ scope: slug });
      const statuses = mgr.describe(slug);
      const summary = statuses
        .map((s) => `${s.name}=${s.connected ? `ok(${s.toolCount})` : "fail"}`)
        .join(", ");
      console.log(`[bootstrap] mcp(${slug}): ${summary}`);
    } catch {
      // connectAll already absorbs optional failures. Reaching this catch
      // means a required server or the declaration itself failed. Do not log
      // transport errors because URLs/stdio stderr may contain credentials.
      const names = mcpConfigs.map((config) => config.name).join(", ");
      throw new Error(
        `required MCP bootstrap failed for tenant '${slug}' (servers: ${names})`,
      );
    }
  }

  // --- Skills ------------------------------------------------------------
  const skillDescriptors = (base.skills ?? []) as SkillDescriptor[];
  let skillTools: Record<string, import("@agentic/agent-kit").ToolDescriptor> =
    {};
  if (skillDescriptors.length > 0) {
    skillTools = buildSkillTools(skillDescriptors);
    console.log(
      `[bootstrap] skills(${slug}): ${skillDescriptors.length} skill(s) — ${skillDescriptors
        .map((s) => s.name)
        .join(", ")}`,
    );
  }

  if (mcpConfigs.length === 0 && skillDescriptors.length === 0) return base;

  return {
    ...base,
    tools: {
      // MCP + Skills tools first, native tenant tools last so the tenant
      // always wins on collisions.
      ...mcpTools,
      ...skillTools,
      ...(base.tools ?? {}),
    },
  };
}
