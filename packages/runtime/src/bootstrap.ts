/**
 * Bootstrap — on import, auto-discover every tenant model dir under
 * `AGENTIC_MODELS_DIR`, upsert the ontology (event_types + entity_types
 * tables) for each tenant, and register all agent functions with Inngest.
 *
 * Convention: each subdir of AGENTIC_MODELS_DIR is one tenant's ontology
 * version. The directory name encodes the tenant + optional version, e.g.
 * `RAAS-v1`, `supportflow-v3`. The slug is derived (lowercase, strip -vN
 * suffix) and must match a row in the `tenants` table (seeded via
 * `pnpm db:seed`).
 */

import crypto from "node:crypto";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  agents,
  agentVersions,
  deployments,
  entityTypes,
  eventListeners,
  eventTypes,
  tenants,
  workflows,
  workflowVersions,
  factoryTools,
  getDb,
  getTenantInngestDeploymentEnabledMap,
  isTenantInngestDeploymentEnabled,
} from "@agentic/db";
import {
  buildDeclarativeOverlay,
  globalToolRegistry,
  isToolExecutionPolicy,
  listGlobalTools,
} from "@agentic/tools";
import { assessRisk, makeId, type RiskFacets } from "@agentic/shared";
import { and, eq } from "drizzle-orm";
import {
  loadModelsFromDisk,
  flattenActionSpecs,
  tenantSlugFromFolder,
  type LoadedModels,
  type WorkflowManifest,
} from "./manifest";
import {
  RuleGateDeclarationSchema,
  ruleBindingsFromActions,
  unboundMandatoryRules,
  type RuleGateDeclaration,
} from "./rule-guard";
import {
  findMissingTenantPrompts,
  formatMissingPromptsError,
  registerAgent,
  resolveAgentTriggerNames,
} from "./register";
import {
  authorizeProductionGeneratedAgent,
  productionCodeActManifestSha256,
  type ProductionCodeActCapability,
} from "./production-codeact-authorization";
import type { TenantRegistry, ToolDescriptor } from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";
import { resolveModelsRoot, shouldDiscoverModelFolder } from "./models-root";
import { isFactorySandboxTenant } from "./sandbox-mode";
import {
  canonicalWorkflowVersionId,
  legacyWorkflowVersionId,
  workflowVersionContentMatches,
} from "./workflow-version-identity";
import {
  assertCronManifestValid,
  clearRuntimeScheduleStatusForTenant,
  InvalidCronExpressionError,
  registerCronTriggers,
} from "./scheduler";
import { resolveTenantEventAdapter } from "./event-adapter";
import { commitTenantEventAdapter } from "./event-name";

/**
 * What `bootstrapTenant` returns. Spelled out so TS 6 doesn't try to infer
 * a type that references Inngest v4 internal `api/api` symbols (TS2883).
 */
export interface BootstrapTenantResult {
  tenant: { id: string; slug: string };
  workflow: { id: string; slug: string };
  workflowVersion: { id: string; version: string };
  functions: InngestFunction.Any[];
  agentCount: number;
  registeredCount: number;
  cronCount: number;
  /** Agents whose declared cron expression was rejected as malformed. Always 0
   * on a successful bootstrap — `assertCronManifestValid` throws first — but
   * kept in the result contract for authoring-side status consumers. */
  invalidCronCount: number;
  scheduleUnconfiguredCount: number;
  scheduleDisabledCount: number;
  eventTypeCount: number;
  entityTypeCount: number;
  tenantTools: number;
  tenantPrompts: number;
  hasTenantPackage: boolean;
  /**
   * True when this call wrote a new `deployments` row (either because no live
   * row existed for this tenant/workflow_version, or `AGENTIC_REBOOTSTRAP=force`
   * forced a fresh insert). P0-RT-07: must be false for no-op reboots.
   */
  deploymentInserted: boolean;
}

/**
 * Map of tenant slug → tenant code registry, passed in by the api server.
 *
 * The runtime stays tenant-agnostic: it doesn't `import("@tenants/<slug>")`
 * itself because that would force `@agentic/runtime` to depend on every
 * tenant package (or sidestep pnpm's isolated-module resolution). Instead
 * `apps/api/src/bootstrap.ts` imports tenants it ships with and hands the
 * registries in here. Pure-declarative tenants just don't get an entry.
 */
export type TenantRegistries = Record<string, TenantRegistry | undefined>;

type FactoryToolRow = typeof factoryTools.$inferSelect;

/** Marker for a boot failure that must escape per-tenant isolation.  Continuing
 * would make the process report healthy while a declared runtime capability is
 * absent or unreadable. */
export class FatalRuntimeBootstrapError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FatalRuntimeBootstrapError";
  }
}

/** An active database tenant is part of the advertised runtime surface. Skipping its broken
 * manifest would let /health report green while that tenant has zero executable functions. */
export class ActiveTenantBootstrapError extends FatalRuntimeBootstrapError {
  constructor(tenantSlug: string, modelFolder: string, cause: unknown) {
    super(
      `[bootstrap] active tenant ${tenantSlug} could not load model folder ${modelFolder}; refusing partial runtime readiness`,
      cause,
    );
    this.name = "ActiveTenantBootstrapError";
  }
}

/** One tenant slug must resolve to one canonical model folder. Concatenating version folders
 * registers duplicate Inngest identities and makes readdir order decide which manifest is live. */
export class DuplicateTenantModelFolderError extends FatalRuntimeBootstrapError {
  constructor(tenantSlug: string, folders: string[]) {
    super(
      `[bootstrap] tenant ${tenantSlug} maps to multiple model folders (${folders.sort().join(", ")}); retain one canonical folder and version workflow files inside it`,
    );
    this.name = "DuplicateTenantModelFolderError";
  }
}

export class PersistedFactoryToolLoadError extends FatalRuntimeBootstrapError {
  constructor(tenantSlug: string, cause: unknown) {
    super(
      `[bootstrap] tenant ${tenantSlug}: failed to read persisted factory tools; runtime tool resolution cannot be verified`,
      cause,
    );
    this.name = "PersistedFactoryToolLoadError";
  }
}

export class PersistedFactoryToolDescriptorError extends FatalRuntimeBootstrapError {
  constructor(tenantSlug: string, cause: unknown) {
    super(
      `[bootstrap] tenant ${tenantSlug}: persisted factory tool descriptors are invalid and cannot be registered`,
      cause,
    );
    this.name = "PersistedFactoryToolDescriptorError";
  }
}

export interface ManifestToolRef {
  agentId: string;
  agentName: string;
  toolName: string;
  source: "action" | "tool_use";
  actionOrder?: string;
}

export class ManifestToolResolutionError extends FatalRuntimeBootstrapError {
  readonly tenantSlug: string;
  readonly unresolved: ManifestToolRef[];

  constructor(tenantSlug: string, unresolved: ManifestToolRef[]) {
    const detail = unresolved
      .map(
        (ref) =>
          `${ref.agentId}/${ref.agentName} ${ref.source}${ref.actionOrder ? `#${ref.actionOrder}` : ""} -> ${ref.toolName}`,
      )
      .join("; ");
    super(
      `[bootstrap] tenant ${tenantSlug}: ${unresolved.length} manifest tool reference(s) do not resolve to a callable tenant, persisted, or global descriptor: ${detail}`,
    );
    this.name = "ManifestToolResolutionError";
    this.tenantSlug = tenantSlug;
    this.unresolved = unresolved;
  }
}

export interface ManifestInvokeIssue {
  agentId: string;
  agentName: string;
  actionName: string;
  actionOrder: string;
  target: string;
  reason: string;
}

export class ManifestInvokeConfigurationError extends FatalRuntimeBootstrapError {
  readonly tenantSlug: string;
  readonly issues: ManifestInvokeIssue[];

  constructor(tenantSlug: string, issues: ManifestInvokeIssue[]) {
    super(
      `[bootstrap] tenant ${tenantSlug}: invalid invoke configuration — ${issues
        .map(
          (issue) =>
            `${issue.agentId}/${issue.agentName} action#${issue.actionOrder} ${issue.actionName} -> ${issue.target || "<missing>"}: ${issue.reason}`,
        )
        .join("; ")}`,
    );
    this.name = "ManifestInvokeConfigurationError";
    this.tenantSlug = tenantSlug;
    this.issues = issues;
  }
}

/** A tenant-level runtime registry cannot safely host two different persisted
 * implementations under the same tool name. Surface the ambiguity at boot
 * instead of depending on DB row order (or silently starting without tools). */
export class FactoryToolDomainConflictError extends FatalRuntimeBootstrapError {
  constructor(message: string) {
    super(message);
    this.name = "FactoryToolDomainConflictError";
  }
}

function manifestToolRefs(manifest: WorkflowManifest): ManifestToolRef[] {
  const refs: ManifestToolRef[] = [];
  for (const agent of manifest) {
    for (const entry of agent.tool_use ?? []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (name?.trim()) {
        refs.push({
          agentId: agent.id,
          agentName: agent.name,
          toolName: name.trim(),
          source: "tool_use",
        });
      }
    }
    for (const action of flattenActionSpecs(agent.actions ?? [])) {
      if (action.type === "tool" && action.name?.trim()) {
        refs.push({
          agentId: agent.id,
          agentName: agent.name,
          toolName: action.name.trim(),
          source: "action",
          actionOrder: action.order,
        });
      }
    }
  }
  return refs;
}

function isCallableToolDescriptor(value: unknown): value is ToolDescriptor {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { handler?: unknown }).handler === "function"
  );
}

/** Boot-time mirror of the step-engine's real resolution chain.  This checks
 * both directly dispatched `type:"tool"` actions and LLM-advertised
 * `tool_use[]` entries, including aliases already materialised in the global
 * registry. */
export function assertManifestToolsResolvable(spec: {
  tenantSlug: string;
  manifest: WorkflowManifest;
  tenantRegistry?: TenantRegistry;
  declarativeTools?: Record<string, ToolDescriptor>;
  globalRegistry?: ReadonlyMap<string, ToolDescriptor>;
}): void {
  const globals = spec.globalRegistry ?? globalToolRegistry;
  const unresolved = manifestToolRefs(spec.manifest).filter((ref) => {
    // register.ts constructs the effective tenant map as tenant first,
    // declarative overlay second, so a persisted descriptor wins on collision.
    const descriptor =
      spec.declarativeTools?.[ref.toolName] ??
      spec.tenantRegistry?.tools?.[ref.toolName] ??
      globals.get(ref.toolName);
    return !isCallableToolDescriptor(descriptor);
  });
  if (unresolved.length > 0) {
    throw new ManifestToolResolutionError(spec.tenantSlug, unresolved);
  }
}

/**
 * Every name one manifest agent can be invoked by, in the exact set
 * `fnRegistry` is keyed on.
 *
 * A generated agent carries two names for a single function: the manifest
 * `name` (its short name, e.g. `RuleCheckForCandidateIdentityAgent`) and
 * `factory_action_name` (the Ontology Action that authorised it, e.g.
 * `ruleCheckForCandidateIdentity`). Generated plans reference the Action —
 * that is the identity the business speaks — so the Action name has to be a
 * first-class invoke reference. Before this, a six-agent generated fleet threw
 * `ManifestInvokeConfigurationError` at boot and took the whole tenant's
 * registration down: one plan step's reference blanked five healthy siblings.
 *
 * The identities are NOT interchangeable elsewhere: `factory_action_name`
 * remains the business-Action provenance (manifest.ts), never a substitute for
 * the tool-call name or the function id.
 */
function invokeTargetNames(
  tenantSlug: string,
  agent: WorkflowManifest[number],
): string[] {
  const names = [agent.name, `${tenantSlug}.${agent.name}`];
  const actionName = agent.factory_action_name?.trim();
  if (actionName && actionName !== agent.name) {
    names.push(actionName, `${tenantSlug}.${actionName}`);
  }
  return names;
}

/** Validate the exact synchronous invoke surface that bootstrap's fnRegistry
 * can resolve. Invokes are terminal by default; soft continuation is legal
 * only when the author explicitly supplies a fallback value. */
export function assertManifestInvokesValid(spec: {
  tenantSlug: string;
  manifest: WorkflowManifest;
}): void {
  const callableTargets = new Set<string>();
  for (const agent of spec.manifest) {
    // registerAgent returns null for trigger-less agents, so such an entry
    // cannot be a real step.invoke target in the current runtime.
    if ((agent.trigger ?? []).length === 0) continue;
    for (const name of invokeTargetNames(spec.tenantSlug, agent)) {
      callableTargets.add(name);
    }
  }

  const issues: ManifestInvokeIssue[] = [];
  for (const agent of spec.manifest) {
    for (const action of flattenActionSpecs(agent.actions ?? [])) {
      if (action.type !== "invoke") continue;
      const target = action.invoke?.trim() ?? "";
      const hasDefault = Object.prototype.hasOwnProperty.call(
        action,
        "default_result",
      );
      const legacyPolicy =
        typeof action.on_error === "string" ? action.on_error : undefined;
      const ladderPolicy = Array.isArray(action.on_error)
        ? action.on_error
        : undefined;
      let reason = "";
      if (!target) reason = "invoke target is required";
      else if (!callableTargets.has(target))
        reason = "target is not an enabled, trigger-backed manifest function";
      else if (legacyPolicy === "soft" && !hasDefault)
        reason = "on_error=soft requires an explicit default_result";
      else if (legacyPolicy && legacyPolicy !== "soft" && hasDefault)
        reason =
          "default_result is only valid with on_error=soft or an error-policy continue rule";
      else if (!legacyPolicy && !ladderPolicy && hasDefault)
        reason =
          "default_result requires on_error=soft or an error-policy continue rule";
      if (reason) {
        issues.push({
          agentId: agent.id,
          agentName: agent.name,
          actionName: action.name,
          actionOrder: action.order,
          target,
          reason,
        });
      }
    }
  }
  if (issues.length > 0) {
    throw new ManifestInvokeConfigurationError(spec.tenantSlug, issues);
  }
}

function factoryToolRank(
  row: FactoryToolRow,
  tenantId: string,
  domainId: string | null,
): number {
  const owner =
    row.scopeKey === tenantId ? 20 : row.scopeKey === "shared" ? 10 : 0;
  const specificity =
    domainId && row.domainKey === domainId ? 2 : row.domainKey === "" ? 1 : 0;
  return owner + specificity;
}

function manifestToolNames(agent: WorkflowManifest[number]): Set<string> {
  const names = new Set<string>();
  for (const entry of agent.tool_use ?? []) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (name?.trim()) names.add(name.trim());
  }
  for (const action of flattenActionSpecs(agent.actions ?? [])) {
    if (action.type === "tool" && action.name?.trim())
      names.add(action.name.trim());
  }
  return names;
}

/** Resolve only the declarative rows actually declared by live agents.
 *
 * - marked factory agents see exact-domain + general rows;
 * - old/unmarked agents see general rows only;
 * - tenant rows override shared rows;
 * - if two live agents resolve one name to different rows, boot fails closed
 *   and the author must namespace the tools.
 */
export function selectFactoryToolsForManifest(
  rows: FactoryToolRow[],
  manifest: WorkflowManifest,
  tenantId: string,
  opts: { sandboxCloneOnly?: boolean } = {},
): FactoryToolRow[] {
  // Factory sandboxes receive content-addressed tenant-owned clones before
  // manifest commit. They must not resolve a production/shared source row
  // directly, even when the name/domain would otherwise match.
  const owned = rows.filter(
    (row) =>
      row.scopeKey === tenantId ||
      (!opts.sandboxCloneOnly && row.scopeKey === "shared"),
  );
  const selected = new Map<
    string,
    { row: FactoryToolRow; agentId: string; domainId: string | null }
  >();

  for (const agent of manifest) {
    const marker = agent.factory_domain_id?.trim();
    const domainId = marker || null;
    for (const name of manifestToolNames(agent)) {
      const candidates = owned.filter((row) => row.name === name);
      if (!candidates.length) continue; // built-in/global/tenant-code tool
      const eligible = candidates
        .filter(
          (row) =>
            row.domainKey === "" || (!!domainId && row.domainKey === domainId),
        )
        .sort(
          (a, b) =>
            factoryToolRank(b, tenantId, domainId) -
            factoryToolRank(a, tenantId, domainId),
        );
      const chosen = eligible[0];
      if (!chosen) {
        const available = [
          ...new Set(candidates.map((row) => row.domainKey || "<general>")),
        ].join(", ");
        throw new FactoryToolDomainConflictError(
          `[bootstrap] agent ${agent.id} (${domainId ?? "unmarked/general"}) declares tool ${name}, ` +
            `but the persisted implementations belong to other ontology domains: ${available}`,
        );
      }
      const prior = selected.get(name);
      if (prior && prior.row.id !== chosen.id) {
        throw new FactoryToolDomainConflictError(
          `[bootstrap] declarative tool ${name} is ambiguous across live agents: ` +
            `${prior.agentId} (${prior.domainId ?? "unmarked/general"}) resolves ${prior.row.id}, ` +
            `while ${agent.id} (${domainId ?? "unmarked/general"}) resolves ${chosen.id}. ` +
            `Use ontology-namespaced tool names before booting this additive manifest.`,
        );
      }
      selected.set(name, { row: chosen, agentId: agent.id, domainId });
    }
  }

  return [...selected.values()].map((entry) => entry.row);
}

async function discoverTenantFolders(
  options: { includeScopedSandboxSlug?: string } = {},
): Promise<Array<{ folder: string; slug: string; dir: string }>> {
  const root = resolveModelsRoot();
  if (!root) {
    throw new FatalRuntimeBootstrapError(
      "[bootstrap] no models root found: configure AGENTIC_MODELS_DIR or run inside a pnpm workspace containing ./models",
    );
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    throw new FatalRuntimeBootstrapError(
      `[bootstrap] AGENTIC_MODELS_DIR is not readable: ${root}`,
      err,
    );
  }
  const found: Array<{ folder: string; slug: string; dir: string }> = [];
  for (const folder of entries) {
    const folderSlug = tenantSlugFromFolder(folder);
    const isExactActiveSandbox =
      isFactorySandboxTenant(options.includeScopedSandboxSlug) &&
      folderSlug === options.includeScopedSandboxSlug;
    // Ordinary startup must not resurrect stale sandbox artifacts. A scoped
    // re-register for the exact active sandbox is different: it is the real
    // execution path immediately after deploy and must be discoverable.
    if (!isExactActiveSandbox && !shouldDiscoverModelFolder(folder)) continue;
    const dir = path.join(root, folder);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    found.push({ folder, slug: folderSlug, dir });
  }
  return found;
}

export async function bootstrapTenant(spec: {
  tenantSlug: string;
  modelDir: string;
  tenantRegistry?: TenantRegistry;
}): Promise<BootstrapTenantResult> {
  const db = getDb();
  const loaded = await loadModelsFromDisk(spec.modelDir);
  const { manifest } = loaded;

  // UC-V11-25 / AR-GAP-13 — refuse-to-boot when any `logic` action lacks
  // a tenant `definePrompt`. The legacy fallback shipped
  // `${action.name}: ${action.description}` as the LLM user message —
  // for RAAS that streams a Chinese description to the model. Strict
  // validation per `docs/tech-design/ar-tool.md` § Option B. The throw
  // bubbles to `bootstrapAll`'s per-tenant try/catch so OTHER tenants
  // still boot.
  const missingPrompts = findMissingTenantPrompts({
    manifest,
    tenantRegistry: spec.tenantRegistry,
  });
  if (missingPrompts.length > 0) {
    throw new Error(formatMissingPromptsError(spec.tenantSlug, missingPrompts));
  }

  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, spec.tenantSlug))
    .all()[0];
  if (!tenant) {
    throw new Error(
      `[bootstrap] tenant slug=${spec.tenantSlug} not seeded — run \`pnpm db:seed\` first`,
    );
  }

  // Resolve the complete runtime tool surface BEFORE writing workflow/version/
  // deployment rows. A failed registry validation must leave no half-promoted
  // deployment behind.
  const tenantRegistry = spec.tenantRegistry;
  const eventAdapter = resolveTenantEventAdapter({ tenantRegistry });
  let persistedFactoryTools: FactoryToolRow[];
  try {
    persistedFactoryTools = db.select().from(factoryTools).all();
  } catch (err) {
    throw new PersistedFactoryToolLoadError(spec.tenantSlug, err);
  }
  const matched = selectFactoryToolsForManifest(
    persistedFactoryTools,
    manifest,
    tenant.id,
    { sandboxCloneOnly: isFactorySandboxTenant(spec.tenantSlug) },
  );
  // #DISPATCH-VERIFY (D8) — carry each persisted tool's probe standing to the
  // dispatcher. `buildDeclarativeOverlay` deliberately rebuilds only the request
  // template plus the policy triple, so probeStatus/definitionHash/verifiedAt
  // never reached run time and an expired or failed probe still executed.
  const factoryToolProbeState: Record<
    string,
    { probeStatus?: string | null; definitionHash?: string | null; verifiedAt?: number | null }
  > = {};
  for (const row of matched) {
    // #PROBE-DEFER — carry WHAT THE PROBE SAW, not just that it failed. A
    // service that never answered may simply not be deployed yet, and an FDE
    // holding a valid credential must not be blocked on that; a service that
    // answered and refused is a configuration defect and still blocks.
    const evidence =
      row.probeEvidence && typeof row.probeEvidence === "object"
        ? (row.probeEvidence as Record<string, unknown>)
        : undefined;
    const classification =
      typeof evidence?.classification === "string" ? evidence.classification : undefined;
    factoryToolProbeState[row.name] = {
      probeStatus: row.probeStatus,
      definitionHash: row.definitionHash,
      verifiedAt: row.verifiedAt ? row.verifiedAt.getTime() : null,
      ...(classification ? { classification } : {}),
      // Inferred, and only from an actual probe attempt: the probe emits
      // `needs_config` precisely when no credential was available, so any other
      // recorded classification means one was present and used. With no evidence
      // at all this stays undefined, which is not deferrable — fail closed.
      ...(classification ? { credentialConfigured: classification !== "needs_config" } : {}),
    };
  }
  let declarativeTools: Record<string, ToolDescriptor> | undefined;
  if (matched.length > 0) {
    try {
      declarativeTools = buildDeclarativeOverlay(
        matched.map((r) => {
          const executionPolicy = {
            operation: r.operation,
            effectScope: r.effectScope,
            sandboxPolicy: r.sandboxPolicy,
          };
          if (!isToolExecutionPolicy(executionPolicy)) {
            throw new Error(
              `persisted factory tool ${r.name} is missing a valid operation/effectScope/sandboxPolicy; migrate the tool explicitly before execution`,
            );
          }
          return {
            name: r.name,
            description: r.description ?? undefined,
            method: r.method,
            urlTemplate: r.urlTemplate,
            headers: (r.headers as Record<string, string> | null) ?? undefined,
            bodyTemplate: r.bodyTemplate ?? undefined,
            requestSpec: (r.requestSpec as never) ?? undefined,
            responseSpec: (r.responseSpec as never) ?? undefined,
            examples: (r.examples as never) ?? undefined,
            sideEffect: r.sideEffect,
            ...executionPolicy,
            paramsSchema:
              (r.paramsSchema as Record<string, unknown> | null) ?? undefined,
            returnsSchema:
              (r.returnsSchema as Record<string, unknown> | null) ?? undefined,
          };
        }),
      );
    } catch (err) {
      throw new PersistedFactoryToolDescriptorError(spec.tenantSlug, err);
    }
  }
  assertManifestToolsResolvable({
    tenantSlug: spec.tenantSlug,
    manifest,
    tenantRegistry,
    declarativeTools,
  });
  assertManifestInvokesValid({ tenantSlug: spec.tenantSlug, manifest });

  // Resolve every generated production agent before writing/upserting runtime
  // catalog rows or registering functions. The resolver verifies durable
  // promotion state and immutable evidence; manifest provenance strings are
  // deliberately not authority. CodeAct receives the opaque capability at its
  // final action boundary; every generated Agent is also revalidated before
  // each real run, after this bootstrap check succeeds for its exact manifest.
  const productionCodeActCapabilities = new Map<
    string,
    ProductionCodeActCapability
  >();
  const productionCodeActManifestHashes = new Map<string, string>();
  const productionGeneratedAgentCapabilities = new Map<
    string,
    ProductionCodeActCapability
  >();
  const productionGeneratedAgentManifestHashes = new Map<string, string>();
  const productionWorkflowManifestSha256 =
    productionCodeActManifestSha256(manifest);
  if (!isFactorySandboxTenant(spec.tenantSlug)) {
    for (const agent of manifest) {
      if (agent.generated !== true) continue;
      // A bare declarative `generated` agent (e.g. Agent Studio's
      // derived-from-legacy marker) carries no factory provenance and no
      // executable code — it runs the same declarative step-engine path as a
      // hand-authored agent, so it needs no production-promotion receipt. Only
      // agents that CLAIM factory production (any factory_* identity field or
      // executable code) must prove COMPLETE provenance below. This mirrors the
      // manifest-import quarantine gate so the two surfaces agree.
      const claimsFactoryProduction =
        !!agent.factory_domain_id ||
        !!agent.factory_target_domain_id ||
        !!agent.factory_promotion_version_id ||
        !!agent.factory_regression_suite_fingerprint ||
        !!agent.factory_execution_scope ||
        agent.codeExecuted === true ||
        !!agent.typescript_code;
      if (!claimsFactoryProduction) continue;
      if (
        !agent.factory_domain_id ||
        agent.factory_target_domain_id !== agent.factory_domain_id ||
        !agent.factory_promotion_version_id ||
        !agent.factory_regression_suite_fingerprint ||
        agent.factory_execution_scope?.kind !== "production" ||
        agent.factory_execution_scope.target_domain_id !==
          agent.factory_domain_id
      ) {
        throw new Error(
          `[bootstrap] generated production Agent provenance is incomplete for ${spec.tenantSlug}/${agent.id}`,
        );
      }
      const agentManifestSha256 = productionCodeActManifestSha256(agent);
      if (agent.codeExecuted === true && !agent.typescript_code) {
        throw new Error(
          `[bootstrap] production CodeAct handler is missing for ${spec.tenantSlug}/${agent.id}`,
        );
      }
      const executionKind =
        agent.codeExecuted === true
          ? ("codeact" as const)
          : ("declarative" as const);
      const codeSha256 =
        agent.codeExecuted === true
          ? crypto
              .createHash("sha256")
              .update(agent.typescript_code!, "utf8")
              .digest("hex")
          : agentManifestSha256;
      const capability = await authorizeProductionGeneratedAgent({
        executionKind,
        tenantId: tenant.id,
        tenantSlug: spec.tenantSlug,
        domainId: agent.factory_domain_id,
        agentSlug: agent.id,
        promotionVersionId: agent.factory_promotion_version_id,
        regressionSuiteFingerprint: agent.factory_regression_suite_fingerprint,
        codeSha256,
        agentManifestSha256,
        workflowManifestSha256: productionWorkflowManifestSha256,
      });
      productionGeneratedAgentCapabilities.set(agent.id, capability);
      productionGeneratedAgentManifestHashes.set(agent.id, agentManifestSha256);
      if (executionKind === "codeact") {
        productionCodeActCapabilities.set(agent.id, capability);
        productionCodeActManifestHashes.set(agent.id, agentManifestSha256);
      }
    }
  }

  // Validate schedules before DB promotion. Registration happens after the
  // enabled/disabled state has been read, so disabled agents do not keep a
  // live cron producer behind them.
  assertCronManifestValid({
    tenantSlug: spec.tenantSlug,
    manifest,
  });

  const versionStr = canonicalWorkflowVersionId(manifest, loaded.actionsExt);
  const legacyVersionStr = legacyWorkflowVersionId(manifest);

  // Authoring can publish a NAMED workflow into the tenant's single live
  // runtime lane. If a live deployment's version already matches the disk
  // manifest (by version identity or exact content), keep that named
  // workflow/version as the bootstrap owner. Falling back to
  // `<tenant>-default` here used to immediately supersede a successful named
  // publish during hot registration.
  const liveCandidates = db
    .select({
      workflowId: workflows.id,
      workflowVersionId: workflowVersions.id,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, tenant.id),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
      ),
    )
    .all();
  let matchingLive:
    | { workflowId: string; workflowVersionId: string }
    | undefined;
  for (const candidate of liveCandidates) {
    const liveVersion = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, candidate.workflowVersionId))
      .all()[0];
    if (!liveVersion) continue;
    if (
      liveVersion.version === versionStr ||
      // A legacy-labeled live row must NOT be adopted on label alone — that
      // would overwrite a colliding row. It qualifies only on a canonical
      // version match (above) or a real content match (below). See
      // workflow-version-identity.ts:50-54.
      workflowVersionContentMatches(liveVersion, manifest, loaded.actionsExt)
    ) {
      matchingLive = candidate;
      break;
    }
  }

  const workflowSlug = `${spec.tenantSlug}-default`;
  let workflow = matchingLive
    ? db
        .select()
        .from(workflows)
        .where(eq(workflows.id, matchingLive.workflowId))
        .all()[0]
    : db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.tenantId, tenant.id),
            eq(workflows.slug, workflowSlug),
          ),
        )
        .all()[0];
  if (!workflow) {
    const id = makeId("wf");
    db.insert(workflows)
      .values({
        id,
        tenantId: tenant.id,
        slug: workflowSlug,
        name: workflowSlug,
      })
      .run();
    workflow = db
      .select()
      .from(workflows)
      .where(eq(workflows.id, id))
      .all()[0]!;
  }

  const forceRebootstrap = process.env.AGENTIC_REBOOTSTRAP === "force";
  let deploymentInserted = false;
  let workflowVersion = matchingLive
    ? db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, matchingLive.workflowVersionId))
        .all()[0]
    : db
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, workflow.id),
            eq(workflowVersions.version, versionStr),
          ),
        )
        .all()[0];
  if (
    workflowVersion &&
    !workflowVersionContentMatches(workflowVersion, manifest, loaded.actionsExt)
  ) {
    throw new FatalRuntimeBootstrapError(
      `[bootstrap] full workflow version digest collision for ${spec.tenantSlug}`,
    );
  }
  if (!workflowVersion) {
    const legacy = db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workflowId, workflow.id),
          eq(workflowVersions.version, legacyVersionStr),
        ),
      )
      .all()[0];
    if (
      legacy &&
      workflowVersionContentMatches(legacy, manifest, loaded.actionsExt)
    ) {
      workflowVersion = legacy;
    }
  }
  const isNewVersion = !workflowVersion;
  if (!workflowVersion) {
    const wfvId = makeId("wfv");
    db.insert(workflowVersions)
      .values({
        id: wfvId,
        workflowId: workflow.id,
        version: versionStr,
        manifestJson: manifest as unknown as object,
        actionsJson: loaded.actionsExt as unknown as object,
      })
      .run();
    workflowVersion = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wfvId))
      .all()[0]!;
  }

  // Tenant code registry comes from the caller (api server). Pure-declarative
  // tenants pass nothing; that's expected.
  const toolCount = Object.keys(tenantRegistry?.tools ?? {}).length;
  const promptCount = Object.keys(tenantRegistry?.prompts ?? {}).length;

  // Upsert agents + agent_versions + event_listeners
  const registered = [];
  const enabledManifest: WorkflowManifest = [];
  // Phase 1a — sibling-function registry for synchronous `type:"invoke"` steps. Populated as
  // each function is built; the resolver closure reads it lazily at handler-run time (after boot
  // finishes), so an invoke action can resolve a sibling agent registered later in this loop.
  const fnRegistry = new Map<string, InngestFunction.Any>();
  const resolveFunction = (ref: string): InngestFunction.Any | undefined =>
    fnRegistry.get(ref);
  // #RULE-GATE — resolved once for the whole domain, before any function is
  // registered, so every agent is judged against the same corpus.
  const ontologyRuleContext = resolveOntologyRuleContext(loaded);
  if (ontologyRuleContext.ontologyRules.length > 0) {
    // An uncovered obligation that nobody mentions is indistinguishable from a
    // satisfied one, so both coverage gaps are stated at boot.
    const coverage = reportRuleGateCoverage({
      tenantSlug: spec.tenantSlug,
      manifest,
      context: ontologyRuleContext,
    });
    if (coverage.ruleRefsWithoutTool.length > 0) {
      console.warn(
        `[rule-gate] ${spec.tenantSlug}: ${coverage.ruleRefsWithoutTool.length} ontology rule reference(s) hang off steps that name no tool and cannot be enforced at a tool boundary: ${coverage.ruleRefsWithoutTool.join(", ")}`,
      );
    }
    if (coverage.unboundBlocking.length > 0) {
      console.warn(
        `[rule-gate] ${spec.tenantSlug}: ${coverage.unboundBlocking.length} blocking rule(s) are bound by no gate, so no dispatch consults them: ${coverage.unboundBlocking.join(", ")}`,
      );
    }
    if (coverage.ungatedMutatingTools.length > 0) {
      console.warn(
        `[rule-gate] ${spec.tenantSlug}: ${coverage.ungatedMutatingTools.length} mutating tool call(s) are covered by no rule gate: ${coverage.ungatedMutatingTools
          .map((t) => `${t.agent}/${t.tool}(${t.tier})`)
          .join(", ")}`,
      );
    }
  }
  for (const a of manifest) {
    let agentRow = db
      .select()
      .from(agents)
      .where(and(eq(agents.workflowId, workflow.id), eq(agents.kebabId, a.id)))
      .all()[0];
    if (!agentRow) {
      const agentId = makeId("agt");
      const now = new Date();
      db.insert(agents)
        .values({
          id: agentId,
          workflowId: workflow.id,
          kebabId: a.id,
          name: a.name,
          title: a.title ?? a.name,
          actor: a.actor[0] === "Human" ? "Human" : "Agent",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      agentRow = db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .all()[0]!;
    } else if (
      a.title &&
      a.title !== agentRow.title &&
      agentRow.title === agentRow.name
    ) {
      // The row still carries the manifest-name default (no operator ever
      // renamed it via PATCH /v1/agents), so a recompiled manifest's display
      // title is the better default. An operator-authored title is left alone.
      db.update(agents)
        .set({ title: a.title, updatedAt: new Date() })
        .where(eq(agents.id, agentRow.id))
        .run();
      agentRow = { ...agentRow, title: a.title };
    }

    const existingAv = db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, agentRow.id),
          eq(agentVersions.workflowVersionId, workflowVersion.id),
        ),
      )
      .all()[0];
    if (!existingAv) {
      db.insert(agentVersions)
        .values({
          id: makeId("agv"),
          agentId: agentRow.id,
          workflowVersionId: workflowVersion.id,
          manifestJson: a as unknown as object,
        })
        .run();
    }

    // Cron-only agents register a listener for their synthetic schedule
    // event too, so the catalog graph shows them as reachable instead of
    // orphaned (resolveAgentTriggerNames mirrors registerAgent's triggers).
    for (const trigger of resolveAgentTriggerNames(a)) {
      const exists = db
        .select()
        .from(eventListeners)
        .where(
          and(
            eq(eventListeners.eventName, trigger),
            eq(eventListeners.agentId, agentRow.id),
          ),
        )
        .all()[0];
      if (!exists) {
        db.insert(eventListeners)
          .values({ eventName: trigger, agentId: agentRow.id })
          .run();
      }
    }

    // 下线 (disable): a disabled agent stays in the catalog — its agents /
    // agent_versions / event_listeners rows are upserted above — but its
    // Inngest function is NOT registered, so no event routes to it until it is
    // re-enabled and the tenant re-registers. `enabled` defaults to true, so
    // this is a no-op for every agent that was never explicitly disabled.
    if (agentRow.enabled !== false) {
      enabledManifest.push(a);
      const fn = registerAgent(a, {
        tenantId: tenant.id,
        tenantSlug: spec.tenantSlug,
        workflowVersionId: workflowVersion.id,
        tenantRegistry: tenantRegistry ?? undefined,
        eventAdapter,
        resolveFunction,
        declarativeTools,
        // #RULE-GATE — the consumer `rules.json` never had. Resolved once per
        // boot above; every registered agent in this domain is judged against
        // the same server-authored corpus.
        ontologyRules: ontologyRuleContext.ontologyRules,
        ontologyRuleBindings: ontologyRuleContext.ontologyRuleBindings,
        factoryToolProbeState,
        productionCodeActCapability: productionCodeActCapabilities.get(a.id),
        productionCodeActManifestSha256: productionCodeActManifestHashes.get(
          a.id,
        ),
        productionCodeActWorkflowManifestSha256:
          productionWorkflowManifestSha256,
        productionGeneratedAgentCapability:
          productionGeneratedAgentCapabilities.get(a.id),
        productionGeneratedAgentManifestSha256:
          productionGeneratedAgentManifestHashes.get(a.id),
        productionGeneratedWorkflowManifestSha256:
          productionWorkflowManifestSha256,
      });
      if (fn) {
        registered.push(fn);
        // Index by every name assertManifestInvokesValid accepts (agent name,
        // namespaced fn id, and the business Action name a generated plan
        // references) so validation and resolution can never disagree.
        for (const target of invokeTargetNames(spec.tenantSlug, a)) {
          fnRegistry.set(target, fn as InngestFunction.Any);
        }
      }
    }
  }

  // Upsert ontology catalogs (RF-1.4 additive tables)
  upsertEventTypes(tenant.id, loaded);
  upsertEntityTypes(tenant.id, loaded);

  const cronTriggers = registerCronTriggers({
    tenantSlug: spec.tenantSlug,
    manifest: enabledManifest,
    eventAdapter,
  });
  // Re-check against enabled functions. This catches an enabled parent whose
  // sibling target was disabled in the DB after the manifest was authored.
  assertManifestInvokesValid({
    tenantSlug: spec.tenantSlug,
    manifest: enabledManifest,
  });

  // P0-RT-07: promote only after every enabled function, tool, invoke target,
  // and schedule has validated. A no-op reboot leaves the existing live row
  // in place; a failed validation never tombstones the last-good deployment.
  if (isNewVersion || forceRebootstrap) {
    db.update(deployments)
      .set({ status: "rolled_back" })
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .run();
    db.insert(deployments)
      .values({
        id: makeId("dpl"),
        tenantId: tenant.id,
        target: "workflow",
        versionId: workflowVersion.id,
        status: "live",
        note: `auto-bootstrapped from ${path.basename(spec.modelDir)}${
          forceRebootstrap ? " (forced)" : ""
        }`,
      })
      .run();
    deploymentInserted = true;
  }

  // Publish transport naming only after the complete tenant bootstrap has
  // validated and committed. A failed hot load must keep HTTP producers and
  // recovery workers on the same last-good adapter as the still-served
  // Inngest function set.
  commitTenantEventAdapter(spec.tenantSlug, eventAdapter);

  return {
    tenant,
    workflow,
    workflowVersion,
    functions: [...registered, ...cronTriggers.functions],
    agentCount: manifest.length,
    registeredCount: registered.length,
    cronCount: cronTriggers.functions.length,
    invalidCronCount: cronTriggers.invalidCron,
    scheduleUnconfiguredCount: cronTriggers.unconfiguredAgents.length,
    scheduleDisabledCount: cronTriggers.disabledAgents.length,
    eventTypeCount: loaded.events.events?.length ?? 0,
    entityTypeCount: loaded.objects.payload?.length ?? 0,
    tenantTools: toolCount,
    tenantPrompts: promptCount,
    hasTenantPackage: tenantRegistry !== null,
    deploymentInserted,
  };
}

/**
 * #RULE-GATE — turn the loaded ontology into the rule context the runtime needs.
 *
 * `loadModelsFromDisk` has always returned `rules`, and until now nothing read
 * it: there were `upsertEventTypes` and `upsertEntityTypes` and no rules
 * consumer at all, so 248 RAAS rows and 17 zhaopin rows were parsed at every
 * boot and dropped. This is the consumer. Both halves are SERVER-authored — the
 * corpus from `rules.json` and the tool bindings from `actions.json`'s own
 * `action_steps[].rules[]` — so a manifest can neither shrink the rule set that
 * governs it nor exempt a tool by declining to declare a gate.
 */
export function resolveOntologyRuleContext(loaded: LoadedModels): {
  ontologyRules: unknown[];
  ontologyRuleBindings: Record<string, string[]>;
  /** Rule ids the ontology attached to a step with no tool: unenforceable at a
   * tool boundary, so surfaced rather than silently counted as covered. */
  ruleRefsWithoutTool: string[];
} {
  const ontologyRules = Array.isArray(loaded.rules?.payload)
    ? (loaded.rules.payload as unknown[])
    : [];
  // With no corpus there is nothing to enforce, and a binding pointing at an
  // absent rule would demand a verdict nobody can produce.
  if (ontologyRules.length === 0) {
    return { ontologyRules: [], ontologyRuleBindings: {}, ruleRefsWithoutTool: [] };
  }
  const bindings = ruleBindingsFromActions(
    Array.isArray(loaded.actionsExt) ? (loaded.actionsExt as unknown[]) : [],
  );
  // Merge the step-name route in. A `type:"tool"` action dispatches under its own
  // action name, which equals the ontology step name, so this reaches rules the
  // ontology attached to a step it never gave a tool name — without inventing a
  // binding: an explicit tool name always wins.
  const merged: Record<string, string[]> = { ...bindings.byStepName };
  for (const [tool, ids] of Object.entries(bindings.byTool)) {
    const bucket = (merged[tool] ??= []);
    for (const id of ids) if (!bucket.includes(id)) bucket.push(id);
  }
  return {
    ontologyRules,
    ontologyRuleBindings: merged,
    ruleRefsWithoutTool: bindings.withoutTool,
  };
}

/**
 * #RULE-GATE — coverage honesty at boot.
 *
 * Two ways a rule obligation can be silently uncovered, both of which look
 * identical to "compliant" if nobody says them out loud:
 *   - a blocking rule that no gate binds, so no dispatch ever consults it;
 *   - a rule the ontology attached to a step that names no tool, which a
 *     tool-boundary gate structurally cannot reach.
 * Measured on the live corpora at the time of writing: zhaopin has 1 of the
 * second kind, RAAS has 144 — which is the real reason RAAS is not enforceable
 * today, and it is a data/authoring fact rather than a code defect.
 */
export function reportRuleGateCoverage(args: {
  tenantSlug: string;
  manifest: WorkflowManifest;
  context: ReturnType<typeof resolveOntologyRuleContext>;
}): {
  unboundBlocking: string[];
  ruleRefsWithoutTool: string[];
  ontologyBoundRuleIds: string[];
  /** #RISK-TIER — declared-mutating tools that no gate covers. The tier table
   * decides which tools need one, so this is not a hand-kept list. */
  ungatedMutatingTools: Array<{
    agent: string;
    tool: string;
    tier: string;
    reason: string;
  }>;
  /** Tools whose blast radius neither the manifest nor the catalog declares —
   * reported as undeclared rather than guessed into a tier. */
  undeclaredEffectTools: Array<{ agent: string; tool: string }>;
} {
  const { manifest, context } = args;
  const declarations: RuleGateDeclaration[] = [];
  for (const agent of manifest) {
    for (const entry of agent.tool_use ?? []) {
      const raw = (entry as { rule_gate?: unknown }).rule_gate;
      if (raw == null) continue;
      const parsed = RuleGateDeclarationSchema.safeParse(raw);
      if (parsed.success) declarations.push(parsed.data);
    }
  }
  // An ontology-derived binding is coverage too — it needs no manifest line.
  const ontologyBoundRuleIds = [
    ...new Set(Object.values(context.ontologyRuleBindings).flat()),
  ];
  if (ontologyBoundRuleIds.length > 0) {
    declarations.push(
      RuleGateDeclarationSchema.parse({
        rules: { ids: ontologyBoundRuleIds },
        verdict_from: ["results", "lastResult"],
      }),
    );
  }
  const unbound = unboundMandatoryRules(context.ontologyRules, declarations);

  // #RISK-TIER — which tools SHOULD be gated is derived from what each tool
  // declares, never from a maintained name list. A tool the tier table says
  // needs a rule check, with neither a manifest gate nor an ontology binding,
  // is a coverage gap worth naming.
  const ungatedMutatingTools: Array<{
    agent: string;
    tool: string;
    tier: string;
    reason: string;
  }> = [];
  const undeclaredEffectTools: Array<{ agent: string; tool: string }> = [];
  // The reviewed global catalog is authoritative for any tool it registers, so
  // a hand-authored manifest that omits the policy triple is not "unknown" —
  // it is simply not repeating what the registry already declares. Without this
  // fallback a plain read like `fs.readFromInbox` lands in the conservative
  // bucket and gets reported as an external write, which is worse than useless.
  const catalogFacets = new Map<string, RiskFacets>();
  for (const entry of listGlobalTools()) {
    const facets: RiskFacets = {
      sideEffect: entry.sideEffect,
      operation: entry.operation,
      effectScope: entry.effectScope,
    };
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      if (typeof name === "string") catalogFacets.set(name, facets);
    }
  }

  for (const agent of manifest) {
    for (const entry of agent.tool_use ?? []) {
      const declaredGate = (entry as { rule_gate?: unknown }).rule_gate != null;
      const ontologyBound = (context.ontologyRuleBindings[entry.name] ?? []).length > 0;
      if (declaredGate || ontologyBound) continue;
      const policy = (entry as { execution_policy?: Record<string, unknown> }).execution_policy;
      const declared: RiskFacets = {
        sideEffect: (entry as { side_effect?: string }).side_effect,
        operation: policy?.operation as string | undefined,
        effectScope: policy?.effectScope as string | undefined,
      };
      const assessment = assessRisk(
        assessRisk(declared).undetermined ? (catalogFacets.get(entry.name) ?? declared) : declared,
      );
      if (assessment.undetermined) {
        // A tenant tool the catalog does not know and the manifest does not
        // describe. Reported as its own thing rather than guessed into a tier.
        undeclaredEffectTools.push({ agent: agent.name, tool: entry.name });
        continue;
      }
      if (!assessment.controls.includes("rule_check")) continue;
      ungatedMutatingTools.push({
        agent: agent.name,
        tool: entry.name,
        tier: assessment.tier,
        reason: assessment.reason,
      });
    }
  }

  return {
    unboundBlocking: unbound.map((facts) => facts.id).filter(Boolean),
    ruleRefsWithoutTool: context.ruleRefsWithoutTool,
    ontologyBoundRuleIds,
    ungatedMutatingTools,
    undeclaredEffectTools,
  };
}

function upsertEventTypes(tenantId: string, loaded: LoadedModels) {
  const db = getDb();
  const list = loaded.events.events ?? [];
  for (const e of list) {
    const existing = db
      .select()
      .from(eventTypes)
      .where(
        and(eq(eventTypes.tenantId, tenantId), eq(eventTypes.name, e.name)),
      )
      .all()[0];
    const row = {
      tenantId,
      name: e.name,
      category: e.category ?? null,
      color: e.color ?? null,
      description: e.description ?? null,
      payloadJson: (e.payload ?? null) as never,
    };
    if (existing) {
      db.update(eventTypes)
        .set(row)
        .where(
          and(eq(eventTypes.tenantId, tenantId), eq(eventTypes.name, e.name)),
        )
        .run();
    } else {
      db.insert(eventTypes).values(row).run();
    }
  }
}

function upsertEntityTypes(tenantId: string, loaded: LoadedModels) {
  const db = getDb();
  const list = loaded.objects.payload ?? [];
  for (const o of list) {
    const existing = db
      .select()
      .from(entityTypes)
      .where(
        and(eq(entityTypes.tenantId, tenantId), eq(entityTypes.entityId, o.id)),
      )
      .all()[0];
    const row = {
      tenantId,
      entityId: o.id,
      name: o.name ?? o.id,
      description: o.description ?? null,
      primaryKeyName: o.primary_key ?? null,
      propertiesJson: (o.properties ?? null) as never,
    };
    if (existing) {
      db.update(entityTypes)
        .set(row)
        .where(
          and(
            eq(entityTypes.tenantId, tenantId),
            eq(entityTypes.entityId, o.id),
          ),
        )
        .run();
    } else {
      db.insert(entityTypes).values(row).run();
    }
  }
}

/**
 * Bootstrap every discovered tenant, returning their Inngest functions GROUPED
 * BY slug. This is the per-app boot path: one Inngest app per tenant, so the
 * api boot (`apps/api/src/bootstrap.ts`) hands each slug's functions to its own
 * `serve()` handler. Folders with no database tenant are inert artifacts and
 * ignored. A declared, non-archived tenant whose manifest throws blocks
 * startup; otherwise /health would advertise a real runtime while that tenant
 * silently has no executable functions.
 */
export interface BootstrapAllByTenantOptions {
  enabledTenantSlugs?: Iterable<string>;
}

export async function bootstrapAllByTenant(
  tenantRegistries: TenantRegistries = {},
  options: BootstrapAllByTenantOptions = {},
): Promise<Map<string, InngestFunction.Any[]>> {
  const byTenant = new Map<string, InngestFunction.Any[]>();
  const enabledTenantSlugs = options.enabledTenantSlugs
    ? new Set([...options.enabledTenantSlugs].filter(Boolean))
    : null;
  const folders = await discoverTenantFolders();
  if (folders.length === 0) {
    const root = resolveModelsRoot();
    throw new FatalRuntimeBootstrapError(
      `[bootstrap] no tenant model folders found in ${root ?? "<unconfigured models root>"}`,
    );
  }

  const tenantRows = getDb()
    .select({
      id: tenants.id,
      slug: tenants.slug,
      archivedAt: tenants.archivedAt,
    })
    .from(tenants)
    .all();
  const knownSlugs = new Set(tenantRows.map((row) => row.slug));
  const inngestEnabledByTenant = getTenantInngestDeploymentEnabledMap(
    tenantRows.map((row) => row.id),
  );

  // archive (tenant-level 下线): an archived tenant is taken fully offline —
  // none of its agents register, so its app serves zero functions. The rows
  // stay in the DB; clearing `archived_at` (restore) + a re-register brings it
  // back. Read once per bootstrap so a re-register reflects the latest state.
  const archivedSlugs = new Set(
    tenantRows.filter((row) => row.archivedAt != null).map((row) => row.slug),
  );
  const operatorDisabledSlugs = new Set(
    tenantRows
      .filter((row) => !inngestEnabledByTenant.get(row.id))
      .map((row) => row.slug),
  );

  const activeFolders = folders.filter((folder) => {
    if (!knownSlugs.has(folder.slug)) {
      console.log(
        `[bootstrap] ${folder.folder}: no database tenant ${folder.slug} — inert model artifact ignored`,
      );
      return false;
    }
    if (enabledTenantSlugs && !enabledTenantSlugs.has(folder.slug)) {
      clearRuntimeScheduleStatusForTenant(folder.slug);
      console.log(
        `[bootstrap] ${folder.slug} (${folder.folder}): outside enabled tenant deployment scope — skipped`,
      );
      return false;
    }
    if (operatorDisabledSlugs.has(folder.slug)) {
      clearRuntimeScheduleStatusForTenant(folder.slug);
      return false;
    }
    return !archivedSlugs.has(folder.slug);
  });
  const foldersBySlug = new Map<string, string[]>();
  for (const folder of activeFolders) {
    const grouped = foldersBySlug.get(folder.slug) ?? [];
    grouped.push(folder.folder);
    foldersBySlug.set(folder.slug, grouped);
  }
  for (const [slug, grouped] of foldersBySlug) {
    if (grouped.length > 1)
      throw new DuplicateTenantModelFolderError(slug, grouped);
  }

  for (const f of folders) {
    if (enabledTenantSlugs && !enabledTenantSlugs.has(f.slug)) continue;
    if (archivedSlugs.has(f.slug)) {
      clearRuntimeScheduleStatusForTenant(f.slug);
      console.log(`[bootstrap] ${f.slug} (${f.folder}): archived — skipped`);
      continue;
    }
    if (operatorDisabledSlugs.has(f.slug)) {
      clearRuntimeScheduleStatusForTenant(f.slug);
      // Keep an empty app in the process registry so startup sync removes any
      // stale broker-side functions left from the previously deployed state.
      byTenant.set(f.slug, []);
      console.log(
        `[bootstrap] ${f.slug} (${f.folder}): Inngest deployment stopped by operator — 0 functions`,
      );
      continue;
    }
    if (!knownSlugs.has(f.slug)) continue;
    try {
      const result = await bootstrapTenant({
        tenantSlug: f.slug,
        modelDir: f.dir,
        tenantRegistry: tenantRegistries[f.slug],
      });
      const arr = byTenant.get(f.slug) ?? [];
      arr.push(...result.functions);
      byTenant.set(f.slug, arr);
      const tenantPkgNote = result.hasTenantPackage
        ? `· tenant pkg: ${result.tenantTools} tools, ${result.tenantPrompts} prompts`
        : "· no tenant pkg (declarative)";
      console.log(
        `[bootstrap] ${f.slug} (${f.folder}): ${result.registeredCount}/${result.agentCount} agents · ${result.cronCount} cron triggers` +
          `${result.scheduleUnconfiguredCount ? ` · ${result.scheduleUnconfiguredCount} schedule(s) unconfigured` : ""}` +
          `${result.scheduleDisabledCount ? ` · ${result.scheduleDisabledCount} schedule(s) disabled` : ""}` +
          ` · ${result.eventTypeCount} event types · ${result.entityTypeCount} entities ${tenantPkgNote}`,
      );
    } catch (err) {
      console.error(`[bootstrap] failed to load ${f.folder}:`, err);
      if (
        err instanceof FatalRuntimeBootstrapError ||
        err instanceof InvalidCronExpressionError
      ) {
        throw err;
      }
      throw new ActiveTenantBootstrapError(f.slug, f.folder, err);
    }
  }
  return byTenant;
}

/**
 * Flat-array boot path, kept for back-compat. Delegates to
 * `bootstrapAllByTenant` and flattens. Callers that need the per-app grouping
 * (the api registry) should use `bootstrapAllByTenant` directly.
 */
export async function bootstrapAll(
  tenantRegistries: TenantRegistries = {},
): Promise<InngestFunction.Any[]> {
  const byTenant = await bootstrapAllByTenant(tenantRegistries);
  return [...byTenant.values()].flat();
}

/**
 * Rebuild ONE tenant's Inngest functions — the scoped counterpart to
 * `bootstrapAll`. `reregisterInngest({ tenantSlug })` calls this so a deploy /
 * agent enable-disable / archive of tenant X only re-reads X's manifest + DB
 * and only touches X's app, never the whole fleet.
 *
 *   - Archived or unknown slug → `[]` (the caller serves zero functions for
 *     that app = tenant 下线 / app offline).
 *   - A broken manifest → THROWS, so the registry keeps the tenant's
 *     last-good function set (a failed re-register must never drop a tenant
 *     that was previously live). One tenant's bad deploy cannot affect another:
 *     this only ever reads/rebuilds the requested slug.
 *
 * A slug must map to exactly one canonical model folder. Workflow revisions
 * live as versioned files inside that folder; multiple folders are rejected
 * rather than concatenated into duplicate Inngest function identities.
 */
export async function bootstrapTenantBySlug(
  slug: string,
  tenantRegistries: TenantRegistries = {},
): Promise<InngestFunction.Any[]> {
  const folders = (
    await discoverTenantFolders({ includeScopedSandboxSlug: slug })
  ).filter((f) => f.slug === slug);
  if (folders.length === 0) {
    clearRuntimeScheduleStatusForTenant(slug);
    return [];
  }
  const tenantState = getDb()
    .select({
      id: tenants.id,
      slug: tenants.slug,
      archivedAt: tenants.archivedAt,
    })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .all()[0];
  if (
    !tenantState ||
    tenantState.archivedAt != null ||
    !isTenantInngestDeploymentEnabled(tenantState.id)
  ) {
    clearRuntimeScheduleStatusForTenant(slug);
    return [];
  }
  if (folders.length > 1) {
    throw new DuplicateTenantModelFolderError(
      slug,
      folders.map((folder) => folder.folder),
    );
  }
  const fns: InngestFunction.Any[] = [];
  for (const f of folders) {
    const result = await bootstrapTenant({
      tenantSlug: f.slug,
      modelDir: f.dir,
      tenantRegistry: tenantRegistries[f.slug],
    });
    fns.push(...result.functions);
  }
  return fns;
}
