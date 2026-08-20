// ConversationStore + ReflectionWriter ports, backed by @agentic/db (Drizzle/SQLite).
//
// Replaces the OLD repo's Postgres factory_conversation + FailureReflection. The
// conversation store is what lets a follow-up message resume a build mid-flight (and
// survive a server restart); the reflection writer makes each run start wiser.
// better-sqlite3 is synchronous — no `await` on the drizzle calls.

import { getDb, businessOntologyDomains, runtimeProfiles, runtimeProfileVersions, factoryDomainBindings, factoryConversations, factoryDomainInsights, factoryReflections, factoryRuns, factorySkills, factoryTools, factoryToolProbes, factoryIntegrationProfiles, acceptanceScores, toolStats, eq, and, or, desc, sql } from "@agentic/db";
import { inArray, isNull, isNotNull } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { ConversationStore, ReflectionWriter, SkillStore, LibrarySkill, ToolStore, DeclarativeTool, AcceptanceRecorder, DomainInsightPack, DomainInsightStore, FactoryHumanMessage, FactorySignedFixtureRequest, FactorySignedFixturePreparation, SandboxEvidencePlanRequest, SandboxEvidencePlanPreparation, SandboxEvidencePlanReceipt } from "@agentic/agent-factory";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  catalogToolDefinitionHash,
  createProbeAuthorizationBinding,
  declarativeToolDefinitionHash,
  findSensitiveInputPath,
  integrationProfileConfigDigest,
  integrationProfileScopeIssues,
  integrationProfileToolDefinitionDigest,
  isGeneratedToolExecutionPolicy,
  realToolExecutionPolicy,
  sandboxEvidencePlanSubject,
  writeProbeCanarySeed,
  persistedToolAsRealTool,
  validateIntegrationToolConfig,
  type FactoryHumanAuthorizationReceipt,
} from "@agentic/agent-factory";
import {
  ackHumanMessages as ackMailbox,
  drainHumanMessages as drainMailbox,
  nackHumanMessages as nackMailbox,
} from "./mailbox";
import { inspectWriteProbeSafety } from "@agentic/shared";
import { makeToolCassetteEntry, stableJson, type CanonicalCassetteEntry } from "@agentic/shared/cassette";
import { globalToolRegistry, listGlobalTools, validateToolSchema } from "@agentic/tools";
import { integrationProbeScope, persistCassette, persistCassetteTracked, probeDeclarativeIntegration, probeGlobalIntegration } from "./integration-probe";
import {
  attestLiveProbeCassette,
  cassetteConfigHash,
  createAuthorizedSandboxEvidencePlanCassette,
  createAuthorizedSignedFixtureCassette,
  signedFixtureAuthorizationSubject,
} from "./cassette-evidence-attestation";
import {
  listGlobalToolProbeReceipts,
  isProductionLiveToolProbeReceipt,
  saveGlobalToolProbeReceipt,
  summarizeGlobalToolProbeReceiptsByTool,
  type GlobalToolProbeSummary,
} from "./tool-probe-store";
import { verifyConsumedFactoryAuthorization } from "./authorization-challenge-store";
import {
  hasAnyFactoryActiveWork,
  hasFactoryActiveWork,
} from "./active-work";
import { listIntegrationProfiles } from "./integration-profile-store";
import {
  resolveTenantNativeFactoryTool,
  resolveTenantNativeFactoryToolFromSnapshot,
  type RuntimeTenantRegistrySnapshot,
} from "./tenant-native-tool-provider";
import {
  registryWriteProbeLifecycleProvider,
} from "./write-probe-lifecycle-provider";
import {
  createToolDraft,
  getToolRevision,
} from "./tool-revision-store";

type ScopedFactoryAsset = { id: string; scopeKey: string; domainKey: string };

const factoryAssetDomainKey = (domain: string | null | undefined): string => domain ?? "";

/** A domain-exact tenant asset wins over tenant-general, then shared-exact,
 * then shared-general. Keeping this order in one place prevents a duplicate
 * slug/name from being resolved differently by list vs effectiveness writes. */
function factoryAssetRank(row: ScopedFactoryAsset, tenantId: string | undefined, domainKey: string): number {
  const owner = tenantId && row.scopeKey === tenantId ? 20 : row.scopeKey === "shared" ? 10 : 0;
  const specificity = domainKey && row.domainKey === domainKey ? 2 : row.domainKey === "" ? 1 : 0;
  return owner + specificity;
}

function preferredFactoryAssets<T extends ScopedFactoryAsset>(
  rows: T[],
  identity: (row: T) => string,
  tenantId: string | undefined,
  domainKey: string,
): T[] {
  const selected = new Map<string, T>();
  for (const row of [...rows].sort((a, b) => factoryAssetRank(b, tenantId, domainKey) - factoryAssetRank(a, tenantId, domainKey))) {
    if (!selected.has(identity(row))) selected.set(identity(row), row);
  }
  return [...selected.values()];
}

function persistedFactoryTool(row: typeof factoryTools.$inferSelect): DeclarativeTool {
  const executionPolicy = {
    operation: row.operation,
    effectScope: row.effectScope,
    sandboxPolicy: row.sandboxPolicy,
  };
  if (!isGeneratedToolExecutionPolicy(executionPolicy)) {
    throw new Error(
      `declarative tool ${row.name} requires explicit operation/effect_scope/sandbox_policy migration; side_effect and HTTP method are not migration defaults`,
    );
  }
  return {
    name: row.name,
    description: row.description,
    method: row.method,
    urlTemplate: row.urlTemplate,
    headers: (row.headers as Record<string, string>) ?? undefined,
    bodyTemplate: row.bodyTemplate ?? undefined,
    requestSpec: (row.requestSpec as DeclarativeTool["requestSpec"]) ?? undefined,
    responseSpec: (row.responseSpec as DeclarativeTool["responseSpec"]) ?? undefined,
    examples: (row.examples as DeclarativeTool["examples"]) ?? undefined,
    sideEffect: row.sideEffect,
    ...executionPolicy,
    domain: row.domain,
    paramsSchema: (row.paramsSchema as Record<string, unknown>) ?? undefined,
    returnsSchema: (row.returnsSchema as Record<string, unknown>) ?? undefined,
    capabilities: (row.capabilities as DeclarativeTool["capabilities"]) ?? undefined,
    probeStatus: row.probeStatus as DeclarativeTool["probeStatus"],
    definitionHash: row.definitionHash ?? undefined,
    probeEvidence: (row.probeEvidence as Record<string, unknown>) ?? undefined,
    verifiedAt: row.verifiedAt?.toISOString(),
  };
}

/** Replace the legacy single-row evidence projection with the authoritative
 * tenant/domain receipt summary. Definition/config matching still happens
 * against the full hash arrays, never against the representative fields. */
function receiptBackedFactoryTool(
  tool: DeclarativeTool,
  summary: GlobalToolProbeSummary | undefined,
): DeclarativeTool {
  return {
    ...tool,
    probeStatus: summary?.status ?? "required",
    definitionHash: summary?.definitionHash,
    verifiedDefinitionHashes: summary?.verifiedDefinitionHashes ?? [],
    productionVerifiedDefinitionHashes:
      summary?.productionVerifiedDefinitionHashes ?? [],
    probeEvidenceMode: summary?.evidenceMode,
    probeEvidence: summary?.evidence,
    verifiedAt: summary?.verifiedAt,
  };
}

// #P1-6 — persist per-criterion acceptance verdicts (one row per criterion per run) for trend
// dashboards. Acceptance cannot be reported as supervised if this durable write fails.
export class DrizzleAcceptanceRecorder implements AcceptanceRecorder {
  async record(runId: string, domain: string, tenantId: string | undefined, criteria: Array<{ key: string; label: string; pass: boolean; detail: string }>): Promise<void> {
    const db = getDb();
    for (const c of criteria) {
      db.insert(acceptanceScores).values({
        id: makeId("art"),
        runId,
        tenantId: tenantId ?? null,
        domain,
        criterionKey: c.key,
        label: c.label,
        pass: c.pass,
        detail: c.detail,
      }).run();
    }
  }
}

/** Persistent AI-authored tool library (Tool-Smith create_tool). */
export class DrizzleToolStore implements ToolStore {
  /** Deliberately not constructor-injectable: callers may scope storage, but
   * cannot replace the code-owned lifecycle trust root for one probe. */
  private readonly writeProbeLifecycleProvider = registryWriteProbeLifecycleProvider;

  constructor(
    private readonly tenantId?: string,
    private readonly expectedDomain?: string,
    private readonly tenantSlug?: string,
    private readonly runtimeAdapterSnapshot?: RuntimeTenantRegistrySnapshot,
    private readonly authorActor?: string,
  ) {}

  private resolveTenantNative(name: string) {
    if (this.runtimeAdapterSnapshot) {
      return resolveTenantNativeFactoryToolFromSnapshot({
        snapshot: this.runtimeAdapterSnapshot,
        name,
        expectedVersion: this.runtimeAdapterSnapshot.selectedVersion,
      });
    }
    return this.tenantSlug
      ? resolveTenantNativeFactoryTool({ tenantSlug: this.tenantSlug, name })
      : undefined;
  }

  private visibleRows(domain: string): Array<typeof factoryTools.$inferSelect> {
    if (this.expectedDomain && domain !== this.expectedDomain) return [];
    // Tenant-authored tools are ontology-bound. Only explicitly shared tools may
    // be domain-neutral; otherwise a rebind would inherit the old ontology's tools.
    const ownership = this.tenantId
      ? or(
          and(eq(factoryTools.scopeKey, this.tenantId), or(eq(factoryTools.domainKey, domain), eq(factoryTools.domainKey, ""))),
          and(eq(factoryTools.scopeKey, "shared"), or(eq(factoryTools.domainKey, domain), eq(factoryTools.domainKey, ""))),
        )
      : and(eq(factoryTools.scopeKey, "shared"), or(eq(factoryTools.domainKey, domain), eq(factoryTools.domainKey, "")));
    return getDb()
      .select()
      .from(factoryTools)
      .where(ownership)
      .all();
  }

  async list(domain: string): Promise<DeclarativeTool[]> {
    const probeSummaries = this.tenantId
      ? summarizeGlobalToolProbeReceiptsByTool(
          listGlobalToolProbeReceipts(this.tenantId, domain),
        )
      : new Map<string, GlobalToolProbeSummary>();
    const profilesByTool = new Map<string, ReturnType<typeof listIntegrationProfiles>>();
    for (const profile of this.tenantId
      ? listIntegrationProfiles(this.tenantId, domain)
      : []) {
      const current = profilesByTool.get(profile.toolName) ?? [];
      current.push(profile);
      profilesByTool.set(profile.toolName, current);
    }
    return preferredFactoryAssets(this.visibleRows(domain), (r) => r.name, this.tenantId, domain)
      .map((row) => {
        const tool = persistedFactoryTool(row);
        return {
          ...receiptBackedFactoryTool(tool, probeSummaries.get(tool.name)),
          integrationProfiles: profilesByTool.get(tool.name) ?? [],
        };
      });
  }

  async saveDraft(tool: DeclarativeTool) {
    if (!this.tenantId) {
      throw new Error(
        "AI-authored tool drafts require an explicit tenant; they are never written to the shared/global library",
      );
    }
    const revision = createToolDraft({
      tenantId: this.tenantId,
      domainId: this.expectedDomain ?? tool.domain,
      tool,
      actor: this.authorActor ?? "ontocode",
      source: "ontocode",
    });
    return {
      revisionId: revision.id,
      version: revision.version,
      definitionHash: revision.definitionHash,
      status: revision.status,
      activation: revision.activation,
    };
  }

  /** Trusted migration/test seam for pre-governance active projections.
   * Deliberately absent from the model-facing ToolStore interface: OntoCode
   * can only call saveDraft and can never select this path through wiring. */
  async save(tool: DeclarativeTool): Promise<void> {
    if (this.expectedDomain && tool.domain && tool.domain !== this.expectedDomain) {
      throw new Error(`tool domain mismatch: expected ${this.expectedDomain}, got ${tool.domain}`);
    }
    if (!isGeneratedToolExecutionPolicy(tool)) {
      throw new Error("declarative tool requires a complete reviewed operation/effectScope/sandboxPolicy; no legacy inference is allowed");
    }
    if (
      this.tenantId
        ? hasFactoryActiveWork(this.tenantId)
        : hasAnyFactoryActiveWork()
    ) {
      throw new Error(
        "FACTORY_EXECUTION_ACTIVE: declarative tool definitions are immutable while sandbox/report/promotion work is active",
      );
    }
    const now = new Date();
    const scopeKey = this.tenantId ?? "shared";
    const domain = this.expectedDomain ?? tool.domain ?? null;
    const cols = { scopeKey, domainKey: factoryAssetDomainKey(domain), tenantId: this.tenantId ?? null, description: tool.description, method: tool.method, urlTemplate: tool.urlTemplate, headers: tool.headers ?? null, bodyTemplate: tool.bodyTemplate ?? null, requestSpec: tool.requestSpec ?? null, responseSpec: tool.responseSpec ?? null, examples: tool.examples ?? null, sideEffect: tool.sideEffect, operation: tool.operation, effectScope: tool.effectScope, sandboxPolicy: tool.sandboxPolicy, domain, paramsSchema: tool.paramsSchema ?? null, returnsSchema: tool.returnsSchema ?? null, capabilities: tool.capabilities ?? null, probeStatus: tool.probeStatus ?? "required", definitionHash: tool.definitionHash ?? null, probeEvidence: tool.probeEvidence ?? null, verifiedAt: tool.verifiedAt ? new Date(tool.verifiedAt) : null };
    getDb()
      .insert(factoryTools)
      .values({ id: `tol-${randomUUID()}`, name: tool.name, ...cols, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [factoryTools.scopeKey, factoryTools.domainKey, factoryTools.name], set: { ...cols, updatedAt: now } })
      .run();
  }

  /** Resolve and normalize a sandbox fixture proposal without trusting any
   * definition/schema hashes supplied by the caller. The same routine is run
   * again after human confirmation, so registry/config drift changes the
   * subject and invalidates the one-shot receipt. */
  private resolveSignedFixtureProposal(
    request: FactorySignedFixtureRequest,
    options: { allowSandboxLocal?: boolean } = {},
  ) {
    if (this.expectedDomain && request.domain !== this.expectedDomain) {
      throw new Error(`signed fixture domain mismatch: expected ${this.expectedDomain}, got ${request.domain}`);
    }
    if (!this.tenantId || !this.tenantSlug) {
      throw new Error("signed fixture requires an explicit tenant id and tenant slug");
    }
    const name = request.name.trim();
    if (!name) throw new Error("signed fixture tool name is required");
    const config = request.config ?? {};
    const sensitive = findSensitiveInputPath(
      { config, exchanges: request.exchanges },
      "signed_fixture",
    );
    if (sensitive) {
      throw new Error(`${sensitive} looks like a literal credential; use a server-side *_env reference or [REDACTED]`);
    }
    if (!Array.isArray(request.exchanges) || request.exchanges.length < 1 || request.exchanges.length > 50) {
      throw new Error("signed fixture requires between 1 and 50 exact exchanges");
    }
    if (stableJson({ config, exchanges: request.exchanges }).length > 256_000) {
      throw new Error("signed fixture proposal is too large");
    }

    const recordedMs = Date.parse(request.recordedAt);
    const expiresMs = Date.parse(request.expiresAt);
    const now = Date.now();
    if (!Number.isFinite(recordedMs) || recordedMs > now + 30_000) {
      throw new Error("signed fixture recordedAt must be a valid time that is not in the future");
    }
    if (
      !Number.isFinite(expiresMs)
      || expiresMs <= now
      || expiresMs <= recordedMs
      || expiresMs - now > 90 * 24 * 60 * 60_000
    ) {
      throw new Error("signed fixture expiresAt must be after recordedAt, in the future, and no more than 90 days away");
    }
    const recordedAt = new Date(recordedMs).toISOString();
    const expiresAt = new Date(expiresMs).toISOString();

    const persistedRow = preferredFactoryAssets(
      this.visibleRows(request.domain).filter((row) => row.name === name),
      (row) => row.name,
      this.tenantId,
      request.domain,
    )[0];
    const persisted = persistedRow ? persistedFactoryTool(persistedRow) : undefined;
    const tenantNative = !persisted
      ? this.resolveTenantNative(name)
      : undefined;
    const globalCatalog = persisted || tenantNative
      ? undefined
      : listGlobalTools().find((tool) => tool.name === name);
    const realTool = persisted
      ? persistedToolAsRealTool(persisted)
      : tenantNative
        ? tenantNative.realTool
        : globalCatalog
          ? {
              name: globalCatalog.name,
              sideEffect: globalCatalog.sideEffect ?? "call" as const,
              operation: globalCatalog.operation,
              effectScope: globalCatalog.effectScope,
              sandboxPolicy: globalCatalog.sandboxPolicy,
              configKeys: globalCatalog.configSchema ? Object.keys(globalCatalog.configSchema) : [],
              credentialEnv: globalCatalog.credentialEnv ?? [],
              capabilities: globalCatalog.capabilities ?? [],
              catalogDefinition: {
                name: globalCatalog.name,
                category: globalCatalog.category,
                sourcePath: globalCatalog.sourcePath,
                ...(globalCatalog.sourceIdentity !== undefined
                  ? { sourceIdentity: globalCatalog.sourceIdentity }
                  : {}),
                sideEffect: globalCatalog.sideEffect,
                operation: globalCatalog.operation,
                effectScope: globalCatalog.effectScope,
                sandboxPolicy: globalCatalog.sandboxPolicy,
                argsSchema: globalCatalog.argsSchema,
                returnsSchema: globalCatalog.returnsSchema,
                configSchema: globalCatalog.configSchema,
                ...(globalCatalog.configContract !== undefined
                  ? { configContract: globalCatalog.configContract }
                  : {}),
                capabilities: globalCatalog.capabilities,
                profileScope: globalCatalog.profileScope,
                probeSafety: globalCatalog.probeSafety,
              },
            }
          : undefined;
    if (!realTool) throw new Error(`unknown signed fixture tool ${name}`);
    const executionPolicy = realToolExecutionPolicy(realTool);
    if (
      !executionPolicy
      || (
        executionPolicy.effectScope !== "external"
        && !(options.allowSandboxLocal && executionPolicy.effectScope === "sandbox_local")
      )
    ) {
      throw new Error(`signed fixture tool ${name} must declare an external${options.allowSandboxLocal ? " or sandbox_local" : ""} execution policy`);
    }
    const configValidation = validateIntegrationToolConfig(realTool, config, {
      rejectUnknownKeys: true,
    });
    if (!configValidation.valid) {
      throw new Error(`signed fixture config is invalid: ${configValidation.issues.map((issue) => issue.message).join("; ")}`);
    }
    const normalizedConfig = configValidation.config;
    const definitionHash = persisted
      ? declarativeToolDefinitionHash(persisted, normalizedConfig)
      : tenantNative
        ? catalogToolDefinitionHash(tenantNative.realTool.catalogDefinition!, normalizedConfig)
        : globalCatalog
          ? catalogToolDefinitionHash(globalCatalog, normalizedConfig)
          : undefined;
    if (!definitionHash) throw new Error(`signed fixture tool ${name} has no stable definition identity`);
    const argsSchema = persisted
      ? persisted.paramsSchema
      : realTool.catalogDefinition?.argsSchema;
    const returnsSchema = persisted
      ? persisted.returnsSchema
      : realTool.catalogDefinition?.returnsSchema;
    const schemaHash = createHash("sha256").update(stableJson({
      args: argsSchema ?? {},
      returns: returnsSchema ?? {},
    })).digest("hex");
    const entries: CanonicalCassetteEntry[] = request.exchanges.map((exchange, index) => {
      if (!exchange || typeof exchange !== "object" || Array.isArray(exchange)) {
        throw new Error(`signed fixture exchange ${index + 1} is invalid`);
      }
      if (!exchange.args || typeof exchange.args !== "object" || Array.isArray(exchange.args)) {
        throw new Error(`signed fixture exchange ${index + 1} args must be an object`);
      }
      if (!Number.isInteger(exchange.status) || exchange.status < 100 || exchange.status > 599) {
        throw new Error(`signed fixture exchange ${index + 1} status must be an HTTP status`);
      }
      if (exchange.body === undefined) {
        throw new Error(`signed fixture exchange ${index + 1} body is required; use null for an empty body`);
      }
      if (exchange.headers && (
        typeof exchange.headers !== "object"
        || Array.isArray(exchange.headers)
        || Object.values(exchange.headers).some((value) => typeof value !== "string")
      )) {
        throw new Error(`signed fixture exchange ${index + 1} headers must contain string values`);
      }
      const argIssues = validateToolSchema(exchange.args, argsSchema as Record<string, unknown> | undefined);
      if (argIssues.length) {
        throw new Error(`signed fixture exchange ${index + 1} args do not match the tool schema: ${argIssues.slice(0, 5).map((issue) => `${issue.path} expected ${issue.expected}`).join("; ")}`);
      }
      if (exchange.status >= 200 && exchange.status < 300) {
        const returnIssues = validateToolSchema(exchange.body, returnsSchema as Record<string, unknown> | undefined);
        if (returnIssues.length) {
          throw new Error(`signed fixture exchange ${index + 1} body does not match the tool schema: ${returnIssues.slice(0, 5).map((issue) => `${issue.path} expected ${issue.expected}`).join("; ")}`);
        }
      }
      return makeToolCassetteEntry({
        toolName: name,
        args: exchange.args,
        status: exchange.status,
        body: exchange.body,
        ...(exchange.headers ? { headers: exchange.headers } : {}),
        recordedAt,
      });
    });
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
      throw new Error("signed fixture contains duplicate tool arguments with ambiguous responses");
    }
    const subjectDigest = signedFixtureAuthorizationSubject({
      tenantId: this.tenantId,
      tenantSlug: this.tenantSlug,
      domainId: request.domain,
      toolName: name,
      definitionHash,
      schemaHash,
      config: normalizedConfig,
      entries,
      recordedAt,
      expiresAt,
    });
    const preparation: FactorySignedFixturePreparation = {
      subjectDigest,
      definitionHash,
      schemaHash,
      configHash: cassetteConfigHash(normalizedConfig),
      recordedAt,
      expiresAt,
      review: entries.map((entry, index) => {
        const requestHash = entry.request.kind === "tool" ? entry.request.argsHash : entry.key;
        const preview = stableJson(entry.response.body).slice(0, 160);
        return `#${index + 1} input ${requestHash} → HTTP ${entry.response.status}; response ${preview}${stableJson(entry.response.body).length > 160 ? "…" : ""}`;
      }),
    };
    return {
      preparation,
      entries,
      normalizedConfig,
      persistedRow,
      persisted,
      realTool,
      toolName: name,
    };
  }

  async prepareSignedFixture(
    request: FactorySignedFixtureRequest,
  ): Promise<FactorySignedFixturePreparation> {
    return this.resolveSignedFixtureProposal(request).preparation;
  }

  private resolveSandboxEvidencePlan(request: SandboxEvidencePlanRequest) {
    if (this.expectedDomain && request.domain !== this.expectedDomain) {
      throw new Error(`sandbox evidence plan domain mismatch: expected ${this.expectedDomain}, got ${request.domain}`);
    }
    if (!this.tenantId || !this.tenantSlug) {
      throw new Error("sandbox evidence plan requires an explicit tenant id and tenant slug");
    }
    if (!request.execution?.runId?.trim() || !request.execution?.conversationId?.trim()) {
      throw new Error("sandbox evidence plan requires the current run and conversation identity");
    }
    if (!Array.isArray(request.bindings) || request.bindings.length < 1 || request.bindings.length > 50) {
      throw new Error("sandbox evidence plan requires between 1 and 50 bindings");
    }
    const totalExchanges = request.bindings.reduce(
      (sum, binding) => sum + (Array.isArray(binding?.exchanges) ? binding.exchanges.length : 0),
      0,
    );
    if (totalExchanges > 200) {
      throw new Error("sandbox evidence plan cannot contain more than 200 total exchanges");
    }
    if (stableJson(request.bindings).length > 512_000) {
      throw new Error("sandbox evidence plan is too large");
    }
    const proposals = request.bindings.map((binding, index) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new Error(`sandbox evidence plan binding ${index + 1} is invalid`);
      }
      const uses = [...(binding.uses ?? [])].map((use, useIndex) => {
        const actionName = use?.actionName?.trim();
        if (!actionName) throw new Error(`sandbox evidence plan binding ${index + 1} use ${useIndex + 1} requires actionName`);
        return {
          actionName,
          ...(use.requiredObjects?.length
            ? { requiredObjects: [...new Set(use.requiredObjects.map((value) => value.trim()).filter(Boolean))].sort() }
            : {}),
        };
      }).sort((left, right) =>
        left.actionName.localeCompare(right.actionName)
        || stableJson(left.requiredObjects ?? []).localeCompare(stableJson(right.requiredObjects ?? [])));
      if (uses.length === 0) throw new Error(`sandbox evidence plan binding ${index + 1} requires at least one exact Action use`);
      const proposal = this.resolveSignedFixtureProposal({
        domain: request.domain,
        name: binding.toolName,
        config: binding.config,
        exchanges: binding.exchanges,
        recordedAt: request.recordedAt,
        expiresAt: request.expiresAt,
      }, { allowSandboxLocal: true });
      const profileKey = binding.profileKey?.trim();
      const configRequired = Object.keys(proposal.normalizedConfig).length > 0
        || (proposal.realTool.configKeys?.length ?? 0) > 0
        || Boolean(proposal.realTool.catalogDefinition?.profileScope);
      if (configRequired && !profileKey) {
        throw new Error(`sandbox evidence plan binding ${proposal.toolName} requires a sandbox profileKey`);
      }
      if (profileKey && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileKey)) {
        throw new Error(`sandbox evidence plan profileKey for ${proposal.toolName} is invalid`);
      }
      if (profileKey) {
        const now = new Date().toISOString();
        const profile = {
          id: "sandbox-evidence-plan-preview",
          tenantId: this.tenantId!,
          profileKey,
          toolName: proposal.toolName,
          domainId: request.domain,
          environment: "sandbox" as const,
          config: proposal.normalizedConfig,
          confirmedBy: "pending-human-confirmation",
          toolDefinitionDigest: integrationProfileToolDefinitionDigest(proposal.realTool),
          configDigest: integrationProfileConfigDigest(proposal.normalizedConfig),
          authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
          confirmedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        const scopeIssues = uses.flatMap((use) => integrationProfileScopeIssues(
          profile,
          proposal.realTool,
          {
            tenantId: this.tenantId,
            tenantSlug: this.tenantSlug,
            domainId: request.domain,
            environment: "sandbox",
            actionName: use.actionName,
            requiredObjects: use.requiredObjects,
          },
        ));
        if (scopeIssues.length) {
          throw new Error(`sandbox evidence plan profile ${profileKey} is out of scope: ${[...new Set(scopeIssues)].join("; ")}`);
        }
      }
      return { proposal, profileKey, uses };
    });
    const duplicateKeys = proposals.map(({ proposal }) =>
      `${proposal.toolName}\u0000${proposal.preparation.configHash}`);
    if (new Set(duplicateKeys).size !== duplicateKeys.length) {
      throw new Error("sandbox evidence plan contains duplicate tool/config bindings");
    }
    proposals.sort((left, right) =>
      left.proposal.toolName.localeCompare(right.proposal.toolName)
      || left.proposal.preparation.configHash.localeCompare(right.proposal.preparation.configHash));
    const preparedBindings = proposals.map(({ proposal, profileKey, uses }) => ({
      toolName: proposal.toolName,
      ...(profileKey ? { profileKey } : {}),
      definitionHash: proposal.preparation.definitionHash,
      schemaHash: proposal.preparation.schemaHash,
      configHash: proposal.preparation.configHash,
      uses,
      fixtureSubjectDigest: proposal.preparation.subjectDigest,
      review: proposal.preparation.review,
    }));
    const preparationBase = {
      schema: "agent-factory-sandbox-evidence-plan/v1" as const,
      domain: request.domain,
      runId: request.execution.runId,
      conversationId: request.execution.conversationId,
      recordedAt: proposals[0]!.proposal.preparation.recordedAt,
      expiresAt: proposals[0]!.proposal.preparation.expiresAt,
      bindings: preparedBindings,
      sandboxOnly: true as const,
      promotionAllowed: false as const,
    };
    const subjectDigest = sandboxEvidencePlanSubject({
      tenantId: this.tenantId,
      tenantSlug: this.tenantSlug,
      preparation: preparationBase,
    });
    const preparation: SandboxEvidencePlanPreparation = {
      ...preparationBase,
      subjectDigest,
      review: preparedBindings.flatMap((binding) => [
        `${binding.toolName}${binding.profileKey ? ` / ${binding.profileKey}` : ""}: ${binding.uses.map((use) => use.actionName).join(", ")}`,
        ...binding.review.map((line) => `  ${line}`),
      ]),
    };
    return { preparation, proposals };
  }

  async prepareSandboxEvidencePlan(
    request: SandboxEvidencePlanRequest,
  ): Promise<SandboxEvidencePlanPreparation> {
    return this.resolveSandboxEvidencePlan(request).preparation;
  }

  async commitSandboxEvidencePlan(
    request: SandboxEvidencePlanRequest & {
      expectedSubjectDigest: string;
      authorization: FactoryHumanAuthorizationReceipt;
    },
  ): Promise<SandboxEvidencePlanReceipt> {
    const resolved = this.resolveSandboxEvidencePlan(request);
    if (resolved.preparation.subjectDigest !== request.expectedSubjectDigest) {
      throw new Error(`sandbox evidence plan content changed after human review (${request.expectedSubjectDigest.slice(0, 12)} != ${resolved.preparation.subjectDigest.slice(0, 12)})`);
    }
    if (
      request.authorization.runId !== request.execution.runId
      || request.authorization.conversationId !== request.execution.conversationId
    ) {
      throw new Error("sandbox evidence plan authorization does not belong to the current execution");
    }
    const fixtures: Array<{
      item: (typeof resolved.proposals)[number];
      cassettePath: string;
      cassetteCreated: boolean;
      attestationKeyId: string;
      attestationExpiresAt: string;
    }> = [];
    try {
      for (const item of resolved.proposals) {
      const cassette = createAuthorizedSandboxEvidencePlanCassette({
        tenantId: this.tenantId!,
        tenantSlug: this.tenantSlug!,
        domainId: request.domain,
        toolName: item.proposal.toolName,
        definitionHash: item.proposal.preparation.definitionHash,
        schemaHash: item.proposal.preparation.schemaHash,
        config: item.proposal.normalizedConfig,
        entries: item.proposal.entries,
        recordedAt: item.proposal.preparation.recordedAt,
        expiresAt: item.proposal.preparation.expiresAt,
        authorization: request.authorization,
        execution: request.execution,
        planSubjectDigest: resolved.preparation.subjectDigest,
      });
      const persistedCassette = await persistCassetteTracked(
        cassette,
        process.env.AGENTIC_DATA_ROOT?.trim() || "./data",
        integrationProbeScope({ tenantId: this.tenantId!, domainId: request.domain }),
        item.proposal.toolName,
      );
        fixtures.push({
        item,
        cassettePath: persistedCassette.path,
        cassetteCreated: persistedCassette.created,
        attestationKeyId: cassette.evidence!.attestation!.keyId,
        attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
        });
      }
      const now = new Date();
      getDb().transaction((tx) => {
        for (const fixture of fixtures) {
          const { item } = fixture;
          if (item.profileKey) {
          tx.insert(factoryIntegrationProfiles).values({
            id: `ipr-${randomUUID()}`,
            tenantId: this.tenantId!,
            domainKey: request.domain,
            toolName: item.proposal.toolName,
            profileKey: item.profileKey,
            environment: "sandbox",
            configJson: item.proposal.normalizedConfig,
            confirmedBy: request.authorization.actor,
            toolDefinitionDigest: integrationProfileToolDefinitionDigest(item.proposal.realTool),
            configDigest: integrationProfileConfigDigest(item.proposal.normalizedConfig),
            authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
            confirmedAt: now,
            updatedAt: now,
          }).onConflictDoUpdate({
            target: [
              factoryIntegrationProfiles.tenantId,
              factoryIntegrationProfiles.domainKey,
              factoryIntegrationProfiles.toolName,
              factoryIntegrationProfiles.profileKey,
              factoryIntegrationProfiles.environment,
            ],
            set: {
              configJson: item.proposal.normalizedConfig,
              confirmedBy: request.authorization.actor,
              toolDefinitionDigest: integrationProfileToolDefinitionDigest(item.proposal.realTool),
              configDigest: integrationProfileConfigDigest(item.proposal.normalizedConfig),
              authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
              confirmedAt: now,
              updatedAt: now,
            },
          }).run();
          }
          const evidence = {
          classification: "verified",
          durationMs: 0,
          schemaHash: item.proposal.preparation.schemaHash,
          cassettePath: fixture.cassettePath,
          evidenceMode: "signed-fixture",
          attestationKeyId: fixture.attestationKeyId,
          attestationExpiresAt: fixture.attestationExpiresAt,
          actor: request.authorization.actor,
          at: now.toISOString(),
          sandboxOnly: true,
          promotionAllowed: false,
          sandboxEvidencePlanSubject: resolved.preparation.subjectDigest,
        };
          const existing = tx.select().from(factoryToolProbes).where(and(
          eq(factoryToolProbes.tenantId, this.tenantId!),
          eq(factoryToolProbes.domainKey, request.domain),
          eq(factoryToolProbes.toolName, item.proposal.toolName),
          eq(factoryToolProbes.definitionHash, item.proposal.preparation.definitionHash),
        )).get();
          const existingLive = existing ? isProductionLiveToolProbeReceipt({
          toolName: existing.toolName,
          status: existing.status === "verified" || existing.status === "failed"
            ? existing.status
            : "required",
          definitionHash: existing.definitionHash,
          schemaHash: existing.schemaHash ?? undefined,
          evidence: (existing.evidence as Record<string, unknown>) ?? undefined,
          verifiedAt: existing.verifiedAt?.toISOString(),
        }, now.getTime()) : false;
          if (!existingLive) {
            tx.insert(factoryToolProbes).values({
            id: `tpr-${randomUUID()}`,
            tenantId: this.tenantId!,
            domainKey: request.domain,
            toolName: item.proposal.toolName,
            status: "verified",
            definitionHash: item.proposal.preparation.definitionHash,
            schemaHash: item.proposal.preparation.schemaHash,
            evidence,
            verifiedAt: now,
            updatedAt: now,
          }).onConflictDoUpdate({
            target: [
              factoryToolProbes.tenantId,
              factoryToolProbes.domainKey,
              factoryToolProbes.toolName,
              factoryToolProbes.definitionHash,
            ],
            set: {
              status: "verified",
              schemaHash: item.proposal.preparation.schemaHash,
              evidence,
              verifiedAt: now,
              updatedAt: now,
            },
            }).run();
          }
        }
      });
    } catch (error) {
      await Promise.all(fixtures
        .filter((fixture) => fixture.cassetteCreated)
        .map((fixture) => fs.unlink(fixture.cassettePath).catch(() => undefined)));
      throw error;
    }
    return {
      ...resolved.preparation,
      status: "ready",
      confirmedBy: request.authorization.actor,
      profiles: resolved.proposals.flatMap(({ proposal, profileKey }) => profileKey ? [{
        profileKey,
        toolName: proposal.toolName,
        configHash: proposal.preparation.configHash,
        environment: "sandbox" as const,
      }] : []),
      fixtures: fixtures.map(({ item, cassettePath, attestationKeyId, attestationExpiresAt }) => ({
        toolName: item.proposal.toolName,
        definitionHash: item.proposal.preparation.definitionHash,
        configHash: item.proposal.preparation.configHash,
        cassettePath,
        attestationKeyId,
        attestationExpiresAt,
      })),
    };
  }

  async createSignedFixture(request: FactorySignedFixtureRequest & {
    expectedDefinitionHash: string;
    expectedSubjectDigest: string;
    authorization: FactoryHumanAuthorizationReceipt;
    execution: import("@agentic/agent-factory").FactoryExecutionScope;
  }) {
    const proposal = this.resolveSignedFixtureProposal(request);
    if (
      proposal.preparation.definitionHash !== request.expectedDefinitionHash
      || proposal.preparation.subjectDigest !== request.expectedSubjectDigest
    ) {
      throw new Error("signed fixture definition, config, entries, or expiry changed after human review");
    }
    const cassette = createAuthorizedSignedFixtureCassette({
      tenantId: this.tenantId!,
      tenantSlug: this.tenantSlug!,
      domainId: request.domain,
      toolName: proposal.toolName,
      definitionHash: proposal.preparation.definitionHash,
      schemaHash: proposal.preparation.schemaHash,
      config: proposal.normalizedConfig,
      entries: proposal.entries,
      recordedAt: proposal.preparation.recordedAt,
      expiresAt: proposal.preparation.expiresAt,
      authorization: request.authorization,
      execution: request.execution,
    });
    const probeScope = integrationProbeScope({
      tenantId: this.tenantId!,
      domainId: request.domain,
    });
    const cassettePath = await persistCassette(
      cassette,
      process.env.AGENTIC_DATA_ROOT?.trim() || "./data",
      probeScope,
      proposal.toolName,
    );
    const at = new Date().toISOString();
    const evidence = {
      classification: "verified",
      durationMs: 0,
      schemaHash: proposal.preparation.schemaHash,
      cassettePath,
      evidenceMode: "signed-fixture" as const,
      attestationKeyId: cassette.evidence!.attestation!.keyId,
      attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
      actor: request.authorization.actor,
      at,
    };
    if (proposal.persisted && proposal.persistedRow) {
      const updated = getDb()
        .update(factoryTools)
        .set({
          probeStatus: "verified",
          definitionHash: proposal.preparation.definitionHash,
          probeEvidence: evidence,
          verifiedAt: new Date(at),
          updatedAt: new Date(),
        })
        .where(and(
          eq(factoryTools.id, proposal.persistedRow.id),
          eq(factoryTools.updatedAt, proposal.persistedRow.updatedAt),
        ))
        .run() as { changes?: number };
      if ((updated.changes ?? 0) !== 1) {
        throw new Error("signed fixture CAS failed because the declarative tool changed during signing; discard the fixture and review again");
      }
    }
    // Persist every source kind in the multi-receipt store. factory_tools is a
    // representative display projection only and cannot represent two configs.
    saveGlobalToolProbeReceipt(this.tenantId!, request.domain, {
      toolName: proposal.toolName,
      status: "verified",
      definitionHash: proposal.preparation.definitionHash,
      schemaHash: proposal.preparation.schemaHash,
      evidence,
      verifiedAt: at,
    });
    return {
      ...proposal.preparation,
      verified: true as const,
      evidenceMode: "signed-fixture" as const,
      cassettePath,
      attestationKeyId: cassette.evidence!.attestation!.keyId,
      attestationExpiresAt: cassette.evidence!.attestation!.expiresAt,
      confirmedBy: request.authorization.actor,
    };
  }

  async probe(request: {
    domain: string;
    name: string;
    revisionId?: string;
    args: Record<string, unknown>;
    config?: Record<string, unknown>;
    actor?: string;
    authorization?: FactoryHumanAuthorizationReceipt;
    execution?: import("@agentic/agent-factory").FactoryExecutionScope;
    expectedDefinitionHash?: string;
  }) {
    if (this.expectedDomain && request.domain !== this.expectedDomain) {
      throw new Error(`tool probe domain mismatch: expected ${this.expectedDomain}, got ${request.domain}`);
    }
    const draftRevision = request.revisionId && this.tenantId
      ? getToolRevision({
          tenantId: this.tenantId,
          domainId: request.domain,
          revisionId: request.revisionId,
          name: request.name,
        })
      : undefined;
    if (request.revisionId && !draftRevision) {
      throw new Error(
        `unknown tenant/domain tool revision ${request.revisionId}`,
      );
    }
    if (
      draftRevision &&
      draftRevision.status !== "draft" &&
      draftRevision.status !== "retired"
    ) {
      throw new Error(
        `tool revision ${draftRevision.id} is ${draftRevision.status}; probe only draft/retired revisions through the revision path`,
      );
    }
    const persistedRow = draftRevision
      ? undefined
      : preferredFactoryAssets(
          this.visibleRows(request.domain).filter((row) => row.name === request.name),
          (row) => row.name,
          this.tenantId,
          request.domain,
        )[0];
    const persisted = draftRevision?.definition
      ?? (persistedRow ? persistedFactoryTool(persistedRow) : undefined);
    const tenantNative = !persisted
      ? this.resolveTenantNative(request.name)
      : undefined;
    const globalCatalog = persisted || tenantNative
      ? undefined
      : listGlobalTools().find((tool) => tool.name === request.name);
    const globalDescriptor = globalCatalog
      ? globalToolRegistry.get(globalCatalog.name)
      : undefined;
    const currentDefinitionHash = persisted
      ? declarativeToolDefinitionHash(persisted, request.config)
      : tenantNative
        ? catalogToolDefinitionHash(tenantNative.realTool.catalogDefinition!, request.config)
      : globalCatalog
        ? catalogToolDefinitionHash(globalCatalog, request.config)
        : undefined;
    if (request.expectedDefinitionHash && currentDefinitionHash !== request.expectedDefinitionHash) {
      throw new Error("probe authorization definition/config hash no longer matches current tool");
    }
    const realTool = persisted
      ? persistedToolAsRealTool(persisted)
      : tenantNative
        ? tenantNative.realTool
        : globalCatalog
          ? {
            name: globalCatalog.name,
            sideEffect: globalCatalog.sideEffect ?? "call" as const,
            operation: globalCatalog.operation,
            effectScope: globalCatalog.effectScope,
            sandboxPolicy: globalCatalog.sandboxPolicy,
            configKeys: globalCatalog.configSchema ? Object.keys(globalCatalog.configSchema) : [],
            credentialEnv: globalCatalog.credentialEnv ?? [],
            capabilities: globalCatalog.capabilities ?? [],
            catalogDefinition: {
              name: globalCatalog.name,
              category: globalCatalog.category,
              sourcePath: globalCatalog.sourcePath,
              ...(globalCatalog.sourceIdentity !== undefined
                ? { sourceIdentity: globalCatalog.sourceIdentity }
                : {}),
              sideEffect: globalCatalog.sideEffect,
              operation: globalCatalog.operation,
              effectScope: globalCatalog.effectScope,
              sandboxPolicy: globalCatalog.sandboxPolicy,
              argsSchema: globalCatalog.argsSchema,
              returnsSchema: globalCatalog.returnsSchema,
              configSchema: globalCatalog.configSchema,
              ...(globalCatalog.configContract !== undefined ? { configContract: globalCatalog.configContract } : {}),
              capabilities: globalCatalog.capabilities,
              profileScope: globalCatalog.profileScope,
              probeSafety: globalCatalog.probeSafety,
            },
            }
          : undefined;
    if (!realTool) throw new Error(`unknown probe tool ${request.name}`);
    const executionPolicy = realToolExecutionPolicy(realTool);
    if (!executionPolicy) {
      throw new Error(
        `probe tool ${request.name} requires explicit operation/effectScope/sandboxPolicy; sideEffect and HTTP method are not authorization defaults`,
      );
    }
    const writeCapable = executionPolicy.sandboxPolicy === "requires_attempt_grant";
    if (draftRevision && writeCapable) {
      return {
        verified: false,
        classification: "write_lifecycle_unavailable",
        definitionHash: currentDefinitionHash ?? "",
        schemaHash: "",
        status: undefined,
        durationMs: 0,
        error: draftRevision.activation.blockers[0]!.message,
        blockerCode: "managed_write_probe_lifecycle_unavailable" as const,
        blockers: draftRevision.activation.blockers,
      };
    }
    const safety = inspectWriteProbeSafety(
      realTool.sideEffect,
      realTool.catalogDefinition?.probeSafety ?? realTool.declarativeDefinition?.probeSafety,
    );
    const lifecycle = !writeCapable || persisted
      ? undefined
      : tenantNative
        ? this.writeProbeLifecycleProvider.resolve({
            source: "tenant_registry",
            descriptor: tenantNative.descriptor,
            catalogSourceIdentity: tenantNative.catalog.sourceIdentity,
          })
        : globalCatalog && globalDescriptor
          ? this.writeProbeLifecycleProvider.resolve({
              source: "global_registry",
              descriptor: globalDescriptor,
              catalogSourceIdentity: globalCatalog.sourceIdentity,
            })
          : undefined;
    const writeBoundaryReady = !writeCapable || (
      safety.status === "ready"
      && !!request.execution
      && !!currentDefinitionHash
      && !!lifecycle
    );
    const requiresAuthorization = writeCapable && writeBoundaryReady;
    if (requiresAuthorization && (
      !request.execution
      || request.authorization?.runId !== request.execution.runId
      || request.authorization?.conversationId !== request.execution.conversationId
    )) {
      throw new Error("requires_attempt_grant probe authorization does not belong to the current execution");
    }
    const subject = requiresAuthorization
      ? createProbeAuthorizationBinding(realTool, request.args, request.config ?? {}, process.env, {
          domainId: request.domain,
          ...request.execution,
        })
      : undefined;
    if (requiresAuthorization && (
      !this.tenantId
      || !request.authorization
      || !subject
      || !verifyConsumedFactoryAuthorization({
        tenantId: this.tenantId,
        domain: request.domain,
        receipt: request.authorization,
        kind: "probe",
        subjectDigest: subject.digest,
      })
    )) throw new Error("requires_attempt_grant probe requires an exact consumed human authorization receipt");
    const actor = requiresAuthorization ? request.authorization!.actor : (request.actor ?? "agent-factory-preflight");
    const authorization = { actor, allowSideEffects: requiresAuthorization };
    const canarySeed = writeCapable && currentDefinitionHash && request.execution
      ? writeProbeCanarySeed({
          definitionHash: currentDefinitionHash,
          domainId: request.domain,
          ...request.execution,
        })
      : undefined;
    const probeScope = integrationProbeScope({
      tenantId: this.tenantId ?? this.tenantSlug ?? "",
      domainId: request.domain,
    });
    const result = persisted
      ? await probeDeclarativeIntegration({
          tool: persisted,
          args: request.args,
          config: request.config,
          tenantSlug: probeScope,
          authorization,
          // The raw probe document is not durable evidence until the API has
          // added its tenant/domain/config attestation below.
          persistCassette: false,
          canarySeed,
          writeProbeLifecycle: lifecycle,
        })
      : await (async () => {
          const descriptor = tenantNative?.descriptor
            ?? globalDescriptor;
          const catalog = tenantNative?.catalog ?? globalCatalog;
          if (!catalog || !descriptor) throw new Error(`unknown probe tool ${request.name}`);
          const readonlyTenantNative = Boolean(
            tenantNative
            && executionPolicy.effectScope === "external"
            && (executionPolicy.operation === "read" || executionPolicy.operation === "compute"),
          );
          return probeGlobalIntegration({
            catalog,
            descriptor,
            args: request.args,
            config: request.config,
            tenantSlug: readonlyTenantNative ? this.tenantSlug! : probeScope,
            authorization,
            persistCassette: false,
            canarySeed,
            writeProbeLifecycle: lifecycle,
          });
        })();
    if (result.cassette) {
      if (!this.tenantId) {
        throw new Error("probe cassette cannot become evidence without a tenant scope");
      }
      // Revision identity must be inside the HMAC-covered cassette. Database
      // receipt JSON is only an index and can never authorize activation.
      const cassetteForAttestation = draftRevision
        ? {
            ...result.cassette,
            evidence: {
              ...result.cassette.evidence!,
              toolRevision: {
                id: draftRevision.id,
                definitionHash: draftRevision.definitionHash,
              },
            },
          }
        : result.cassette;
      const attestedCassette = attestLiveProbeCassette(cassetteForAttestation, {
        tenantId: this.tenantId,
        tenantSlug: this.tenantSlug ?? this.tenantId,
        domainId: request.domain,
        toolName: realTool.name,
        definitionHash: result.definitionHash,
        config: request.config ?? {},
        actor,
      });
      result.cassette = attestedCassette;
      result.cassettePath = await persistCassette(
        attestedCassette,
        process.env.AGENTIC_DATA_ROOT?.trim() || "./data",
        probeScope,
        realTool.name,
      );
    } else if (result.verified) {
      throw new Error("verified probe result is missing an API-attestable cassette");
    }
    const at = new Date().toISOString();
    const evidence = {
      classification: result.classification,
      status: result.status,
      durationMs: result.durationMs,
      schemaHash: result.schemaHash,
      cassettePath: result.cassettePath,
      error: result.error,
      observedEvidence: result.observedEvidence,
      next: result.next,
      missing: result.missing,
      writeProbeProof: result.writeProbeProof,
      evidenceMode: result.cassette?.evidence?.mode,
      attestationKeyId: result.cassette?.evidence?.attestation?.keyId,
      attestationExpiresAt: result.cassette?.evidence?.attestation?.expiresAt,
      actor,
      at,
      ...(draftRevision
        ? {
            revisionId: draftRevision.id,
            revisionDefinitionHash: draftRevision.definitionHash,
          }
        : {}),
    };
    if (persisted && persistedRow) {
      // Evidence is mutable, the adapter definition is not. Bind the receipt
      // to the exact definition+resolved-config digest used for I/O, then use
      // the row revision as a single-statement CAS. This path updates only
      // receipt columns and therefore cannot bypass save()'s active-work
      // definition immutability guard.
      if (!currentDefinitionHash || result.definitionHash !== currentDefinitionHash) {
        throw new Error("probe result definition/config hash does not match the definition used for execution");
      }
      const updated = getDb()
        .update(factoryTools)
        .set({
          probeStatus: result.verified ? "verified" : "failed",
          definitionHash: result.definitionHash,
          probeEvidence: evidence,
          verifiedAt: result.verified ? new Date(at) : null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(factoryTools.id, persistedRow.id),
          eq(factoryTools.updatedAt, persistedRow.updatedAt),
        ))
        .run() as { changes?: number };
      if ((updated.changes ?? 0) !== 1) {
        throw new Error("probe evidence CAS failed because the declarative tool changed during execution; discard this receipt and probe again");
      }
    }
    if (!this.tenantId) throw new Error("tool probe requires a tenant scope");
    // Persist declarative receipts here too: one factory_tools row cannot be
    // the authority for the same executable definition under multiple configs.
    saveGlobalToolProbeReceipt(this.tenantId, request.domain, {
      toolName: realTool.name,
      status: result.verified ? "verified" : "failed",
      definitionHash: result.definitionHash,
      schemaHash: result.schemaHash,
      evidence,
      verifiedAt: result.verified ? at : undefined,
    });
    return result;
  }
}

export class DrizzleConversationStore implements ConversationStore {
  constructor(private readonly tenantId?: string, private readonly expectedDomain?: string) {}

  private where(id: string) {
    const clauses = [eq(factoryConversations.id, id)];
    if (this.tenantId) clauses.push(eq(factoryConversations.tenantId, this.tenantId));
    if (this.expectedDomain) clauses.push(eq(factoryConversations.domain, this.expectedDomain));
    return clauses.length === 1 ? clauses[0]! : and(...clauses)!;
  }

  async has(id: string): Promise<boolean> {
    const row = getDb().select({ id: factoryConversations.id }).from(factoryConversations).where(this.where(id)).all()[0];
    return !!row;
  }

  async load(id: string): Promise<{ messages: unknown[]; ctx: Record<string, unknown> } | null> {
    const row = getDb().select().from(factoryConversations).where(this.where(id)).all()[0];
    if (!row) return null;
    return {
      messages: (row.messagesJson as unknown[]) ?? [],
      ctx: (row.ctxJson as Record<string, unknown>) ?? {},
    };
  }

  async save(id: string, snap: { domain: string; messages: unknown[]; ctx: Record<string, unknown> }): Promise<void> {
    if (this.expectedDomain && snap.domain !== this.expectedDomain) {
      throw new Error(`conversation domain mismatch: expected ${this.expectedDomain}, got ${snap.domain}`);
    }
    const now = new Date();
    const existing = getDb().select().from(factoryConversations).where(eq(factoryConversations.id, id)).all()[0];
    if (existing && existing.tenantId !== (this.tenantId ?? null)) {
      throw new Error("conversation belongs to another tenant");
    }
    if (existing && this.expectedDomain && existing.domain !== this.expectedDomain) {
      throw new Error("conversation belongs to another ontology domain");
    }
    getDb()
      .insert(factoryConversations)
      .values({ id, tenantId: this.tenantId ?? null, domain: snap.domain, messagesJson: snap.messages, ctxJson: snap.ctx, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: factoryConversations.id, set: { tenantId: this.tenantId ?? null, domain: snap.domain, messagesJson: snap.messages, ctxJson: snap.ctx, updatedAt: now } })
      .run();
  }

  // HITL: drain any messages a human injected via POST /v1/agent-factory/inject.
  async drainHumanMessages(id: string): Promise<FactoryHumanMessage[]> {
    return drainMailbox(id, this.tenantId);
  }

  async ackHumanMessages(id: string, deliveryId: string): Promise<void> {
    if (!ackMailbox(id, deliveryId, this.tenantId)) {
      throw new Error(`factory mailbox acknowledgement rejected for ${id}/${deliveryId}`);
    }
  }

  async nackHumanMessages(id: string, deliveryId: string): Promise<void> {
    if (!nackMailbox(id, deliveryId, this.tenantId)) {
      throw new Error(`factory mailbox negative acknowledgement rejected for ${id}/${deliveryId}`);
    }
  }
}

export class DrizzleReflectionWriter implements ReflectionWriter {
  constructor(private readonly tenantId?: string, private readonly expectedDomain?: string) {}

  async record(domain: string, r: { summary: string; lesson: string; failedStep?: string; kind?: "failure" | "success" | "caveat" }): Promise<void> {
    if (this.expectedDomain && domain !== this.expectedDomain) return;
    getDb()
      .insert(factoryReflections)
      .values({
        id: makeId("rfl"),
        tenantId: this.tenantId ?? null,
        domain,
        kind: r.kind ?? "caveat",
        summary: r.summary,
        rootCause: r.failedStep ?? null,
        lesson: r.lesson,
        createdAt: new Date(),
      })
      .run();
  }

  async list(domain: string) {
    if (this.expectedDomain && domain !== this.expectedDomain) return [];
    return getDb()
      .select()
      .from(factoryReflections)
      .where(
        this.tenantId
          ? and(eq(factoryReflections.tenantId, this.tenantId), eq(factoryReflections.domain, domain))
          : and(isNull(factoryReflections.tenantId), eq(factoryReflections.domain, domain)),
      )
      .orderBy(desc(factoryReflections.createdAt))
      .limit(20)
      .all()
      .map((r) => ({
        kind: (r.kind as "failure" | "success" | "caveat") ?? "caveat",
        summary: r.summary,
        rootCause: r.rootCause ?? undefined,
        lesson: r.lesson,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      }));
  }
}

/** Persistent skills library — backs create_skill / use_skill + effectiveness ranking. */
export class DrizzleSkillStore implements SkillStore {
  constructor(private readonly tenantId?: string, private readonly expectedDomain?: string) {}

  async list(domain: string): Promise<LibrarySkill[]> {
    if (this.expectedDomain && domain !== this.expectedDomain) return [];
    const scoped = this.tenantId
      ? or(
          and(eq(factorySkills.scopeKey, this.tenantId), or(eq(factorySkills.domainKey, domain), eq(factorySkills.domainKey, ""))),
          and(eq(factorySkills.scopeKey, "shared"), or(eq(factorySkills.domainKey, domain), eq(factorySkills.domainKey, ""))),
        )
      : and(eq(factorySkills.scopeKey, "shared"), or(eq(factorySkills.domainKey, domain), eq(factorySkills.domainKey, "")));
    const rows = getDb()
      .select()
      .from(factorySkills)
      .where(scoped)
      .all();
    const eff = (r: { successCount: number; evalCount: number }) => (r.successCount + 1) / (r.evalCount + 2);
    return preferredFactoryAssets(rows, (r) => r.slug, this.tenantId, domain)
      .map((r) => ({ slug: r.slug, name: r.name, purpose: r.purpose, promptFragment: r.promptFragment, tools: (r.tools as string[]) ?? [], decisionRule: r.decisionRule, domain: r.domain, useCount: r.useCount, evalCount: r.evalCount, successCount: r.successCount }))
      .sort((a, b) => eff(b) - eff(a) || b.useCount - a.useCount);
  }

  async save(skill: Omit<LibrarySkill, "useCount" | "evalCount" | "successCount">): Promise<void> {
    if (this.expectedDomain && skill.domain && skill.domain !== this.expectedDomain) {
      throw new Error(`skill domain mismatch: expected ${this.expectedDomain}, got ${skill.domain}`);
    }
    const now = new Date();
    const scopeKey = this.tenantId ?? "shared";
    const domain = this.expectedDomain ?? skill.domain ?? null;
    const domainKey = factoryAssetDomainKey(domain);
    getDb()
      .insert(factorySkills)
      .values({ id: `skl-${randomUUID()}`, scopeKey, domainKey, slug: skill.slug, tenantId: this.tenantId ?? null, name: skill.name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [factorySkills.scopeKey, factorySkills.domainKey, factorySkills.slug], set: { tenantId: this.tenantId ?? null, name: skill.name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain, updatedAt: now } })
      .run();
  }

  async bumpUse(slug: string): Promise<void> {
    const row = this.preferredSkill(slug);
    if (!row) return;
    getDb().update(factorySkills).set({ useCount: sql`${factorySkills.useCount} + 1`, updatedAt: new Date() }).where(eq(factorySkills.id, row.id)).run();
  }

  async recordEval(slug: string, ok: boolean): Promise<void> {
    const row = this.preferredSkill(slug);
    if (!row) return;
    getDb()
      .update(factorySkills)
      .set({ evalCount: sql`${factorySkills.evalCount} + 1`, successCount: sql`${factorySkills.successCount} + ${ok ? 1 : 0}`, updatedAt: new Date() })
      .where(eq(factorySkills.id, row.id))
      .run();
  }

  private preferredSkill(slug: string) {
    const domainKey = this.expectedDomain ?? "";
    const owner = this.tenantId
      ? or(eq(factorySkills.scopeKey, this.tenantId), eq(factorySkills.scopeKey, "shared"))
      : eq(factorySkills.scopeKey, "shared");
    const rows = getDb()
      .select()
      .from(factorySkills)
      .where(and(eq(factorySkills.slug, slug), owner, or(eq(factorySkills.domainKey, domainKey), eq(factorySkills.domainKey, ""))))
      .all();
    return preferredFactoryAssets(rows, (r) => r.slug, this.tenantId, domainKey)[0];
  }
}

// ── domain insight packs (#KNOW-PACK P1-A) ─────────────────────────────────────
/** 每 (tenant, domain) 只留最新 N 个本体版本的分析包——旧版本按当前哈希永远查不到，纯占地。 */
const INSIGHT_KEEP_SIGS = 5;

export class DrizzleDomainInsightStore implements DomainInsightStore {
  constructor(
    private readonly tenantId: string,
    private readonly expectedDomain?: string,
  ) {}

  async load(domain: string, ontologySig: string): Promise<DomainInsightPack | null> {
    // Load 侧域不匹配返回 null 而非 throw：读钩是 best-effort 的 advisory 路径。
    if (this.expectedDomain && domain !== this.expectedDomain) return null;
    const row = getDb()
      .select()
      .from(factoryDomainInsights)
      .where(and(
        eq(factoryDomainInsights.tenantId, this.tenantId),
        eq(factoryDomainInsights.domain, domain),
        eq(factoryDomainInsights.ontologySig, ontologySig),
      ))
      .all()[0];
    if (!row) return null;
    return {
      domain: row.domain,
      ontologySig: row.ontologySig,
      mode: row.mode === "deep" ? "deep" : "shallow",
      digest: row.digest,
      coverage: (row.coverageJson as DomainInsightPack["coverage"]) ?? undefined,
      perspectives: (row.perspectivesJson as DomainInsightPack["perspectives"]) ?? undefined,
      ambiguityCount: row.ambiguityCount,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt as unknown as number).toISOString(),
    };
  }

  async save(pack: Omit<DomainInsightPack, "updatedAt">): Promise<void> {
    if (this.expectedDomain && pack.domain !== this.expectedDomain) {
      throw new Error(`domain insight mismatch: expected ${this.expectedDomain}, got ${pack.domain}`);
    }
    const db = getDb();
    const scope = and(
      eq(factoryDomainInsights.tenantId, this.tenantId),
      eq(factoryDomainInsights.domain, pack.domain),
    );
    // 防降级：同 sig 已有 deep 行时，shallow 写入是无意义的信息损失（brain 显式 deep=false 重读
    // 之类），直接跳过；deep 覆盖 shallow（升级）与 deep 覆盖 deep（等价刷新）照常。
    if (pack.mode === "shallow") {
      const existing = db
        .select({ mode: factoryDomainInsights.mode })
        .from(factoryDomainInsights)
        .where(and(scope, eq(factoryDomainInsights.ontologySig, pack.ontologySig)))
        .all()[0];
      if (existing?.mode === "deep") return;
    }
    const nowTs = new Date();
    db.insert(factoryDomainInsights)
      .values({
        id: `fdi-${randomUUID()}`,
        tenantId: this.tenantId,
        domain: pack.domain,
        ontologySig: pack.ontologySig,
        mode: pack.mode,
        digest: pack.digest.slice(0, 10_000),
        coverageJson: pack.coverage ?? null,
        perspectivesJson: pack.perspectives ?? null,
        ambiguityCount: pack.ambiguityCount ?? 0,
        createdAt: nowTs,
        updatedAt: nowTs,
      })
      .onConflictDoUpdate({
        target: [factoryDomainInsights.tenantId, factoryDomainInsights.domain, factoryDomainInsights.ontologySig],
        set: {
          mode: pack.mode,
          digest: pack.digest.slice(0, 10_000),
          coverageJson: pack.coverage ?? null,
          perspectivesJson: pack.perspectives ?? null,
          ambiguityCount: pack.ambiguityCount ?? 0,
          updatedAt: nowTs,
        },
      })
      .run();
    // 存留修剪：只留最新 N 个 sig。updated_at 同毫秒并列时用 rowid（插入序）打破平局，保证确定性。
    db.run(sql`DELETE FROM factory_domain_insights
      WHERE tenant_id = ${this.tenantId} AND domain = ${pack.domain}
      AND id NOT IN (
        SELECT id FROM factory_domain_insights
        WHERE tenant_id = ${this.tenantId} AND domain = ${pack.domain}
        ORDER BY updated_at DESC, rowid DESC LIMIT ${INSIGHT_KEEP_SIGS}
      )`);
  }
}

// ── run history (历史运行) ──────────────────────────────────────────────────────
export interface RunRecord {
  id: string;
  domain: string;
  goal: string;
  status: string;
  /**
   * Immutable execution bindings. They are intentionally returned by getRun
   * so a parked HITL conversation can resume under the exact registration and
   * Runtime Profile that created it instead of falling back to the mutable
   * tenant default.
   */
  ontologyDomainRegistrationId: string | null;
  runtimeProfileVersionId: string | null;
  tokensUsed: number;
  turns: number;
  agentsCount: number;
  reachedTerminal: boolean;
  evidenceStatus: "real" | "simulated_only" | "none";
  realExecutionSucceeded: boolean;
  completionKind: "delivery" | "answer" | "incomplete" | "legacy_unknown";
  createdAt: string;
}

function factoryRunCompletionKind(
  transcript: unknown,
): RunRecord["completionKind"] {
  if (!Array.isArray(transcript)) return "legacy_unknown";
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (!item || typeof item !== "object") continue;
    const event = item as { t?: unknown; status?: unknown; completionKind?: unknown };
    if (event.t !== "done") continue;
    if (
      event.completionKind === "delivery" ||
      event.completionKind === "answer" ||
      event.completionKind === "incomplete"
    ) return event.completionKind;
    // Acceptance-gated historical finish events are deliveries. Historical
    // incomplete frames are ambiguous and must remain explicitly unknown.
    return event.status === "finished" ? "delivery" : "legacy_unknown";
  }
  return "legacy_unknown";
}

export function factoryRunExecutionEvidence(
  transcript: unknown,
): Pick<RunRecord, "evidenceStatus" | "realExecutionSucceeded"> {
  if (!Array.isArray(transcript)) {
    return { evidenceStatus: "none", realExecutionSucceeded: false };
  }
  let sawSimulated = false;
  let lastReal:
    | { success?: unknown; fullChainRan?: unknown }
    | undefined;
  for (const item of transcript) {
    if (!item || typeof item !== "object") continue;
    const event = item as {
      t?: unknown;
      simulated?: unknown;
      success?: unknown;
      fullChainRan?: unknown;
    };
    if (event.t !== "sandbox") continue;
    if (event.simulated === true) sawSimulated = true;
    else lastReal = event;
  }
  if (lastReal) {
    return {
      evidenceStatus: "real",
      // Use the LAST real sandbox so a later failed verification revokes an
      // older green result. `success` supports newer normalized transcripts;
      // fullChainRan is the current durable BrainEvent contract.
      realExecutionSucceeded:
        lastReal.success === true || lastReal.fullChainRan === true,
    };
  }
  return {
    evidenceStatus: sawSimulated ? "simulated_only" : "none",
    realExecutionSucceeded: false,
  };
}

export function factoryRunEvidenceStatus(
  transcript: unknown,
): RunRecord["evidenceStatus"] {
  return factoryRunExecutionEvidence(transcript).evidenceStatus;
}

/** Open a run row at stream start; returns its id. Pass `id` to control it (the
 *  run-registry uses the same id as the registry key + conversation id). tenant_id is
 *  NOT NULL (0021) — an unscoped run is never persisted (the stream route guarantees a
 *  tenant via requirePermission, so this only guards the degenerate no-auth path). */
export function recordRunStart(
  domain: string,
  goal: string,
  tenantId: string | undefined,
  id: string = makeId("frn"),
  ontologyDomainRegistrationId?: string | null,
  runtimeProfileVersionId?: string | null,
): string {
  if (!tenantId) {
    throw new Error(`cannot start factory run ${id}: tenantId is required for durable persistence`);
  }
  const now = new Date();
  // Exact registration verification and run creation share one synchronous DB
  // transaction. OntoCode therefore never falls back to the mutable legacy
  // singleton between its route guard and durable run creation.
  getDb().transaction((tx) => {
    const requestedRegistrationId = ontologyDomainRegistrationId ?? null;
    const requestedRuntimeProfileVersionId =
      runtimeProfileVersionId ?? null;
    if (requestedRegistrationId) {
      const registration = tx
        .select({
          tenantId: businessOntologyDomains.tenantId,
          ontologyDomainId: businessOntologyDomains.ontologyDomainId,
          status: businessOntologyDomains.status,
          archivedAt: businessOntologyDomains.archivedAt,
        })
        .from(businessOntologyDomains)
        .where(eq(businessOntologyDomains.id, requestedRegistrationId))
        .all()[0];
      if (!registration || registration.tenantId !== tenantId) {
        throw new Error(
          `ontology domain registration ${requestedRegistrationId} does not belong to this tenant`,
        );
      }
      if (
        registration.status !== "active" ||
        registration.archivedAt !== null
      ) {
        throw new Error(
          `ontology domain registration ${requestedRegistrationId} is not active`,
        );
      }
      if (registration.ontologyDomainId !== domain) {
        throw new Error(
          `ontology domain registration mismatch: registered ${registration.ontologyDomainId}, got ${domain}`,
        );
      }
    } else {
      // Compatibility path for the standalone Agent Factory UI. New OntoCode
      // work always supplies an immutable registration id.
      const binding = tx
        .select({ ontologyDomainId: factoryDomainBindings.ontologyDomainId })
        .from(factoryDomainBindings)
        .where(eq(factoryDomainBindings.tenantId, tenantId))
        .all()[0];
      if (!binding) throw new Error("factory domain is not bound for this tenant");
      if (binding.ontologyDomainId !== domain) {
        throw new Error(`factory domain mismatch: bound ${binding.ontologyDomainId}, got ${domain}`);
      }
    }
    if (requestedRuntimeProfileVersionId) {
      const runtimeVersion = tx
        .select({
          tenantId: runtimeProfileVersions.tenantId,
          profileStatus: runtimeProfiles.status,
          profileArchivedAt: runtimeProfiles.archivedAt,
        })
        .from(runtimeProfileVersions)
        .innerJoin(
          runtimeProfiles,
          and(
            eq(runtimeProfiles.id, runtimeProfileVersions.profileId),
            eq(
              runtimeProfiles.tenantId,
              runtimeProfileVersions.tenantId,
            ),
          ),
        )
        .where(
          eq(
            runtimeProfileVersions.id,
            requestedRuntimeProfileVersionId,
          ),
        )
        .get();
      if (!runtimeVersion || runtimeVersion.tenantId !== tenantId) {
        throw new Error(
          `runtime profile version ${requestedRuntimeProfileVersionId} does not belong to this tenant`,
        );
      }
      if (
        runtimeVersion.profileStatus !== "active" ||
        runtimeVersion.profileArchivedAt !== null
      ) {
        throw new Error(
          `runtime profile version ${requestedRuntimeProfileVersionId} is archived`,
        );
      }
    }
    // A caller-controlled conversation id is also the run primary key. Refuse a
    // foreign (or old-domain) row before the UPSERT; swallowing this would let one
    // tenant reset another tenant's durable run to `running`.
    const existing = tx
      .select({
        tenantId: factoryRuns.tenantId,
        domain: factoryRuns.domain,
        ontologyDomainRegistrationId:
          factoryRuns.ontologyDomainRegistrationId,
        runtimeProfileVersionId: factoryRuns.runtimeProfileVersionId,
      })
      .from(factoryRuns)
      .where(eq(factoryRuns.id, id))
      .all()[0];
    if (existing && existing.tenantId !== tenantId) throw new Error("run belongs to another tenant");
    if (existing && existing.domain !== domain) throw new Error("run belongs to another ontology domain");
    if (
      existing &&
      (existing.ontologyDomainRegistrationId ?? null) !==
        requestedRegistrationId
    ) {
      throw new Error("run belongs to another ontology domain registration");
    }
    if (
      existing &&
      (existing.runtimeProfileVersionId ?? null) !==
        requestedRuntimeProfileVersionId
    ) {
      throw new Error("run belongs to another runtime profile version");
    }
    // #CRASH-CKPT — UPSERT, not insert-and-swallow: a FOLLOW-UP message reuses the conversation's
    // run id, and the old silent PK-conflict left the row on its previous terminal status ("done").
    // autoResumeCrashedRuns() only re-attaches rows stuck "running", so a follow-up killed mid-run
    // was INVISIBLE to crash-resume (and the history list lied). Flipping the row back to running
    // makes resume + UI truthful; recordRunFinish overwrites with the new verdict as before.
    tx
      .insert(factoryRuns)
      .values({
        id,
        tenantId,
        domain,
        ontologyDomainRegistrationId: requestedRegistrationId,
        runtimeProfileVersionId: requestedRuntimeProfileVersionId,
        goal,
        status: "running",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: factoryRuns.id,
        set: {
          tenantId,
          domain,
          ontologyDomainRegistrationId: requestedRegistrationId,
          runtimeProfileVersionId: requestedRuntimeProfileVersionId,
          status: "running",
          goal,
          tokensUsed: 0,
          turns: 0,
          agentsCount: 0,
          reachedTerminal: false,
          errorMessage: null,
          transcriptJson: [],
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      })
      .run();
  });
  return id;
}

/** Finalize a run row with the terminal verdict + the full transcript for replay. */
export function recordRunFinish(id: string, fields: { status: string; tokensUsed: number; turns: number; agentsCount: number; reachedTerminal: boolean; errorMessage?: string; transcript: unknown[] }, tenantId?: string): void {
  const conds = [eq(factoryRuns.id, id)];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const result = getDb()
    .update(factoryRuns)
    .set({ status: fields.status, tokensUsed: fields.tokensUsed, turns: fields.turns, agentsCount: fields.agentsCount, reachedTerminal: fields.reachedTerminal, errorMessage: fields.errorMessage ?? null, transcriptJson: fields.transcript, updatedAt: new Date() })
    .where(and(...conds))
    .run() as { changes?: number };
  if ((result.changes ?? 0) !== 1) {
    throw new Error(`factory run ${id} could not be finalized in durable storage`);
  }
}

/** Persist live supervision counters together with their matching transcript.
 * A provider-usage frame and its token total become visible in one SQLite
 * commit; a restart cannot replay the event while showing stale spend. */
export function recordRunProgress(
  id: string,
  fields: {
    transcript: unknown[];
    tokensUsed: number;
    turns: number;
    agentsCount: number;
    reachedTerminal: boolean;
  },
  tenantId?: string,
): void {
  const conds = [eq(factoryRuns.id, id)];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const result = getDb()
    .update(factoryRuns)
    .set({
      transcriptJson: fields.transcript,
      tokensUsed: fields.tokensUsed,
      turns: fields.turns,
      agentsCount: fields.agentsCount,
      reachedTerminal: fields.reachedTerminal,
      updatedAt: new Date(),
    })
    .where(and(...conds))
    .run() as { changes?: number };
  if ((result.changes ?? 0) !== 1) {
    throw new Error(`factory run ${id} progress could not be persisted`);
  }
}

const toISO = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

/** History list. Scoped to a tenant (0021 — was unfiltered, leaking runs across tenants) and
 *  hides soft-deleted rows. `tenantId` is optional only so internal callers without an auth
 *  context still work; the route always passes it. */
export function listRuns(domain: string | null, tenantId?: string, limit = 30, opts?: { deleted?: boolean }): RunRecord[] {
  const conds = [opts?.deleted ? isNotNull(factoryRuns.deletedAt) : isNull(factoryRuns.deletedAt)];
  if (domain) conds.push(eq(factoryRuns.domain, domain));
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const rows = getDb().select().from(factoryRuns).where(and(...conds)).orderBy(desc(factoryRuns.createdAt)).limit(limit).all();
  return rows.map((r) => {
    const evidence = factoryRunExecutionEvidence(r.transcriptJson);
    return {
      id: r.id,
      domain: r.domain,
      goal: r.goal,
      status: r.status,
      ontologyDomainRegistrationId:
        r.ontologyDomainRegistrationId ?? null,
      runtimeProfileVersionId: r.runtimeProfileVersionId ?? null,
      tokensUsed: r.tokensUsed,
      turns: r.turns,
      agentsCount: r.agentsCount,
      reachedTerminal: r.reachedTerminal,
      ...evidence,
      completionKind: factoryRunCompletionKind(r.transcriptJson),
      createdAt: toISO(r.createdAt),
    };
  });
}

/** Single run incl. transcript for replay. Tenant-scoped when an id is given a tenant; returns
 *  soft-deleted rows too (with `deletedAt` set) so a reconnect can replay a tombstone and a
 *  restore flow can preview — list callers exclude them, so the only path here is by-id. */
export function getRun(id: string, tenantId?: string): (RunRecord & { transcript: unknown[]; deletedAt: string | null }) | null {
  const conds = [eq(factoryRuns.id, id)];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const r = getDb().select().from(factoryRuns).where(and(...conds)).all()[0];
  if (!r) return null;
  return { id: r.id, domain: r.domain, goal: r.goal, status: r.status, ontologyDomainRegistrationId: r.ontologyDomainRegistrationId ?? null, runtimeProfileVersionId: r.runtimeProfileVersionId ?? null, tokensUsed: r.tokensUsed, turns: r.turns, agentsCount: r.agentsCount, reachedTerminal: r.reachedTerminal, ...factoryRunExecutionEvidence(r.transcriptJson), completionKind: factoryRunCompletionKind(r.transcriptJson), createdAt: toISO(r.createdAt), deletedAt: r.deletedAt ? toISO(r.deletedAt) : null, transcript: (r.transcriptJson as unknown[]) ?? [] };
}

/** Soft-delete a run (历史运行 trash). Guards: tenant match, not already deleted, and never a
 *  live 'running' row (can't delete a run mid-flight). Recoverable via restoreRun. */
export function deleteRun(id: string, tenantId?: string): boolean {
  const conds = [eq(factoryRuns.id, id), isNull(factoryRuns.deletedAt), sql`${factoryRuns.status} != 'running'`];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const res = getDb().update(factoryRuns).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(...conds)).run() as { changes?: number };
  return (res?.changes ?? 0) > 0;
}

/** Un-delete a soft-deleted run. */
export function restoreRun(id: string, tenantId?: string): boolean {
  const conds = [eq(factoryRuns.id, id), sql`${factoryRuns.deletedAt} IS NOT NULL`];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const res = getDb().update(factoryRuns).set({ deletedAt: null, updatedAt: new Date() }).where(and(...conds)).run() as { changes?: number };
  return (res?.changes ?? 0) > 0;
}

/** Bulk soft-delete every terminal run for a domain (清空已完成). A durable
 * `waiting_human` run is unfinished work just like a live driver and must not be
 * swept by a bulk cleanup. Returns how many were cleared. */
export function deleteRunsByDomain(domain: string, tenantId?: string): number {
  const conds = [
    eq(factoryRuns.domain, domain),
    isNull(factoryRuns.deletedAt),
    sql`${factoryRuns.status} NOT IN ('running', 'waiting_human')`,
  ];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const res = getDb().update(factoryRuns).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(...conds)).run() as { changes?: number };
  return res?.changes ?? 0;
}

/** Flip a single unfinished durable run row to `aborted`.
 *
 * A `waiting_human` row has no live conductor after its terminal
 * `waiting_human` receipt is persisted, but it is still unfinished work and
 * blocks ontology rebinding. The explicit Stop action must therefore be able
 * to close either state while preserving the complete run history.
 */
export function markRunAborted(id: string, errorMessage?: string, tenantId?: string): boolean {
  const conds = [
    eq(factoryRuns.id, id),
    inArray(factoryRuns.status, ["running", "waiting_human"]),
  ];
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const res = getDb()
    .update(factoryRuns)
    .set({ status: "aborted", errorMessage: errorMessage ?? null, updatedAt: new Date() })
    .where(and(...conds))
    .run() as { changes?: number };
  return (res?.changes ?? 0) > 0;
}

/** Durable rows still marked 'running' (optionally for one domain/tenant), with their createdAt
 *  in unix-ms — the zombie sweep cross-checks these against the live run registry. Skips
 *  soft-deleted rows. */
export function listRunningRuns(domain: string | null, tenantId?: string): Array<{ id: string; createdAt: number }> {
  const conds = [eq(factoryRuns.status, "running"), isNull(factoryRuns.deletedAt)];
  if (domain) conds.push(eq(factoryRuns.domain, domain));
  if (tenantId) conds.push(eq(factoryRuns.tenantId, tenantId));
  const rows = getDb().select({ id: factoryRuns.id, createdAt: factoryRuns.createdAt }).from(factoryRuns).where(and(...conds)).all();
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt as unknown as string).getTime() }));
}

// #SCALE-TOOLS — per-tool sandbox effectiveness store (upsert counts; ranking demotes empirically).
export class DrizzleToolStatsStore {
  constructor(private readonly tenantId?: string, private readonly expectedDomain?: string) {}

  async record(toolName: string, ok: boolean): Promise<void> {
    const scopeKey = this.tenantId ?? "shared";
    const domainKey = this.expectedDomain ?? "";
    getDb()
      .insert(toolStats)
      .values({ id: `tst-${randomUUID()}`, scopeKey, domainKey, tenantId: this.tenantId ?? null, toolName, invoked: 1, succeeded: ok ? 1 : 0 })
      .onConflictDoUpdate({ target: [toolStats.scopeKey, toolStats.domainKey, toolStats.toolName], set: { invoked: sql`${toolStats.invoked} + 1`, succeeded: sql`${toolStats.succeeded} + ${ok ? 1 : 0}`, updatedAt: new Date() } })
      .run();
  }
  async successRates(): Promise<Record<string, { invoked: number; succeeded: number }>> {
    const rows = getDb()
      .select()
      .from(toolStats)
      .where(and(
        eq(toolStats.scopeKey, this.tenantId ?? "shared"),
        eq(toolStats.domainKey, this.expectedDomain ?? ""),
      ))
      .all();
    return Object.fromEntries(rows.map((r) => [r.toolName, { invoked: r.invoked, succeeded: r.succeeded }]));
  }
}
