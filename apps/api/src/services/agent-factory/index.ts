// Composition root for the Agent Factory ports — wires the brain (@agentic/agent-factory)
// to the new arch's concrete infrastructure (models/ ontology, real sandbox,
// Drizzle stores). The SSE route constructs these and hands them to runBrain.

import {
  createIntegrationProfileAuthorizationBinding,
  GENERAL_MEMORY_SUBJECT,
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  type FactoryPorts,
  type IntegrationCapabilityProvider,
  type SandboxDeployer,
  SandboxLifecycleBlockedError,
  syntheticResumePdf,
} from "@agentic/agent-factory";
import { ManifestOntologySource } from "./ontology-source";
import { AllmetaOntologySource } from "./allmeta-ontology-source";
import { CompositeOntologySource } from "./composite-ontology-source";
import { ManifestSandboxDeployer, ProbingSandboxDeployer } from "./sandbox-deployer";
import { DrizzleConversationStore, DrizzleDomainInsightStore, DrizzleReflectionWriter, DrizzleSkillStore, DrizzleToolStore, DrizzleAcceptanceRecorder, DrizzleToolStatsStore } from "./stores";
import { FsAgentDraftStore } from "./agent-draft-store";
import { FsConversationArchiveStore } from "./conversation-archive-store";
import { FsPolicyStatsStore } from "./policy-stats-store";
import { UploadedOntologySource, UploadedFirstOntologySource } from "./uploaded-ontology-source";
import { listGlobalTools } from "@agentic/tools";
import { listGlobalToolProbeReceipts, summarizeGlobalToolProbeReceiptsByTool } from "./tool-probe-store";
import { DrizzleHumanMemoryStore } from "./human-memory-store";
import { governanceWindowDays } from "./fleet-governance-runner";
import { getLLMGateway } from "../llm";
import { listIntegrationProfiles, saveIntegrationProfile } from "./integration-profile-store";
import {
  DrizzleFactoryAuthorizationChallengeStore,
  verifyConsumedFactoryAuthorization,
} from "./authorization-challenge-store";
import { FsFactoryFixtureAssetStore } from "./fixture-asset-store";
import {
  listTenantNativeFactoryTools,
  listTenantNativeFactoryToolsFromSnapshot,
  getRuntimeTenantRegistrySnapshot,
  type RuntimeTenantRegistrySnapshot,
} from "./tenant-native-tool-provider";
import {
  loadRemoteSandboxConnectionConfig,
  RemoteSandboxDeployer,
} from "./remote-sandbox-deployer";
import { createSandboxBundleToolSnapshotResolver } from "./sandbox-bundle-tool-snapshot";
import {
  containsFactoryFixtureAssetReference,
  materializeFactoryFixturePayload,
} from "./fixture-materializer";
import {
  tenantInngestDiagnosticIsolationIdentity,
  tenantInngestIsolationIdentity,
} from "@agentic/runtime";
import { makeBoundFactoryOntologySource } from "./bound-ontology-source";
import { resolveRuntimeProfileExecutionContext } from "../runtime-profile-adapter-resolver";

export {
  FACTORY_FIXTURE_ASSET_DEFAULT_TTL_SECONDS,
  FACTORY_FIXTURE_ASSET_MAX_BYTES,
  FACTORY_FIXTURE_ASSET_MAX_TTL_SECONDS,
  FactoryFixtureAssetError,
  FsFactoryFixtureAssetStore,
  type FactoryFixtureAssetMetadata,
  type FactoryFixtureAssetPutInput,
  type FactoryFixtureAssetReadResult,
  type FactoryFixtureAssetScope,
} from "./fixture-asset-store";

const REASON_RUNTIME_CAPABILITIES: IntegrationCapabilityProvider["capabilities"] = [{
  systems: ["LLM Gateway", "LLM 网关", "model gateway", "模型网关"],
  kinds: ["external_api", "llm", "llm_gateway", "model_gateway"],
  roles: ["call", "calls", "invoke", "execute"],
  operations: [
    "reason",
    "chat",
    "completion",
    "generateText",
    "invoke",
    // Exact namespaced coordinates used by the live Agents-generation
    // Ontology. These are ordinary reason-RPC workloads; publishing them here
    // prevents strict operation matching from inventing a separate LLM tool.
    "rules.judge",
    "field.semantic_equivalence",
  ],
  objectTypes: ["*"],
  probeRequired: false,
}];

const INVOKE_RUNTIME_CAPABILITIES: IntegrationCapabilityProvider["capabilities"] = [{
  systems: ["AO_Internal", "Agent Runtime", "Agentic Operator Runtime"],
  kinds: ["internal_invoke", "agent_invoke"],
  roles: ["call", "invoke", "execute"],
  operations: ["invoke-agent"],
  objectTypes: ["*"],
  probeRequired: false,
}];

const invokeRuntimeProvider = (): IntegrationCapabilityProvider => ({
  id: "agent-runtime.invoke",
  capabilities: INVOKE_RUNTIME_CAPABILITIES,
  status: "available",
  reason: "Generated runtime supports durable invoke steps against the reviewed fleet graph",
});

/** Every system name the platform's own RUNTIME capabilities satisfy (LLM
 * gateway reason RPC, internal agent invoke). These are provided by the
 * Agentic Operator runtime — an FDE never builds an external connection for
 * them, so coverage treats them as covered (not "未建档"). Exported so the
 * system-coverage route can fold them in like it folds tool_use systems. */
export function runtimeProvidedSystemNames(): string[] {
  return [
    ...new Set(
      listRuntimeIntegrationCapabilities()
        .flatMap((provider) => provider.capabilities)
        .flatMap((capability) => capability.systems)
        .filter((system) => system && system !== "*"),
    ),
  ];
}

/** The generated runtime already exposes `reason` as a host RPC.  Surface it
 * as a runtime capability (not a fake tool), and prove the backing gateway is
 * usable each time the factory snapshots integration evidence. */
function listRuntimeIntegrationCapabilities(): IntegrationCapabilityProvider[] {
  try {
    const gateway = getLLMGateway();
    const provider = gateway.defaultProvider;
    const model = gateway.defaultModel?.trim() ?? "";
    const providerInfo = gateway.listProviders().find((item) => item.id === provider);
    const mock = provider === "mock" || /(^|[\s/_-])mock([\s/_-]|$)/i.test(model);
    const testMockAllowed = process.env.NODE_ENV === "test" && mock && Boolean(model);
    const available = testMockAllowed || (!mock && Boolean(model) && providerInfo?.hasKey === true);
    return [
      {
        id: "agent-runtime.reason",
        capabilities: REASON_RUNTIME_CAPABILITIES,
        status: available ? "available" : "needs_config",
        reason: available
          ? `LLM gateway ${provider}/${model} 可用`
          : `LLM gateway 未配置可用真实 provider/model/credential（provider=${provider || "unset"}, model=${model || "unset"}）`,
      },
      invokeRuntimeProvider(),
    ];
  } catch (error) {
    return [
      {
        id: "agent-runtime.reason",
        capabilities: REASON_RUNTIME_CAPABILITIES,
        status: "needs_config",
        reason: `LLM gateway 初始化失败：${String((error as Error)?.message ?? error).slice(0, 160)}`,
      },
      invokeRuntimeProvider(),
    ];
  }
}

class UnavailableRemoteSandboxDeployer implements SandboxDeployer {
  constructor(private readonly reason: string) {}

  async deployAndObserve(): Promise<never> {
    throw new SandboxLifecycleBlockedError({
      code: "sandbox_config_missing",
      next: "ask_user",
      question: "外部隔离测试环境还没准备好，所以我停在 sandbox 这一步；前面的 Agent 草稿不会丢，也不会退回主 API 进程试跑。请配置或修复专用 runner 后再继续。",
      missing: [this.reason.slice(0, 240)],
    });
  }

  async teardown(): Promise<void> {
    // No remote job was accepted when configuration could not be resolved.
  }
}

/** Factory verification defaults to a signed external runner. Local execution
 * is an explicit development diagnostic and is never promotion-qualified. */
function makeSandboxDeployer(scope?: { tenantId: string; tenantSlug: string }): SandboxDeployer {
  const mode = process.env.FACTORY_SANDBOX_EXECUTION_MODE?.trim()
    || (process.env.NODE_ENV === "test" ? "local-dev" : "remote");
  if (mode === "local-dev") {
    if (process.env.NODE_ENV === "production") {
      return new UnavailableRemoteSandboxDeployer(
        "FACTORY_SANDBOX_EXECUTION_MODE=local-dev is forbidden in production",
      );
    }
    return new ProbingSandboxDeployer(scope);
  }
  if (mode !== "remote") {
    return new UnavailableRemoteSandboxDeployer(
      `FACTORY_SANDBOX_EXECUTION_MODE must be remote or local-dev; got ${mode}`,
    );
  }
  try {
    const connection = loadRemoteSandboxConnectionConfig();
    const buildId = process.env.AGENTIC_BUILD_ID?.trim()
      || process.env.GIT_SHA?.trim();
    if (!buildId) throw new Error("AGENTIC_BUILD_ID or GIT_SHA is required for a signed candidate bundle");
    const registryVersion = scope
      ? getRuntimeTenantRegistrySnapshot(scope.tenantSlug)?.selectedVersion
      : undefined;
    const fixtureStore = new FsFactoryFixtureAssetStore();
    return new RemoteSandboxDeployer({
      tenantScope: scope ? { ...scope, ...(registryVersion ? { registryVersion } : {}) } : undefined,
      connection,
      ...(scope
        ? {
            targetInngestIsolation:
              process.env.NODE_ENV === "production"
                ? tenantInngestIsolationIdentity(scope.tenantSlug)
                : tenantInngestDiagnosticIsolationIdentity(scope.tenantSlug),
          }
        : {}),
      controlPlaneBuildId: buildId,
      // A development API has no production image-attestation document, but
      // its signed same-host Docker runner is still useful as explicitly
      // non-promotable diagnostic evidence.  Tell the verifier to accept that
      // receipt and downgrade it; production keeps the strict attestation path.
      ...(process.env.NODE_ENV === "production"
        ? {}
        : {
            productionImageTrust: () => ({
              configured: false,
              ok: true,
              state: "disabled" as const,
              topology: "single_host_compose" as const,
              diagnosticOnly: true,
            }),
          }),
      resolveToolEvidence: createSandboxBundleToolSnapshotResolver(),
      materializeTestCases: async ({
        targetDomainId,
        targetTenant,
        conversationId,
        testCases,
      }) => {
        if (!testCases.some((testCase) => containsFactoryFixtureAssetReference(testCase.payload))) {
          return testCases;
        }
        if (!conversationId?.trim()) throw new Error("binary fixture conversation scope is missing");
        return Promise.all(testCases.map(async (testCase) => ({
          ...testCase,
          payload: await materializeFactoryFixturePayload({
            payload: testCase.payload,
            caseId: testCase.id ?? "",
            domain: targetDomainId,
            conversationId,
            tenantId: targetTenant.tenantId,
            store: fixtureStore,
          }),
        })));
      },
    });
  } catch (error) {
    return new UnavailableRemoteSandboxDeployer(
      String((error as Error)?.message ?? error),
    );
  }
}

/**
 * Select the ontology transport from the persisted binding provenance.
 *
 * New catalog selections are authoritative Allmeta API identities.  They never
 * read Neo4j directly, fall back to models/, or get shadowed by a later same-id
 * upload.  Upload bindings are equally strict to their tenant-owned bundle.
 * `auto` is the one migration-only compatibility mode for installations that
 * predate explicit binding; it is never written by the current binding route.
 */
/** `tenantSlug` scopes the uploaded-ontology layer to the caller's tenant — pass it from the route
 *  (req.auth.tenantSlug) / the run (its tenant) so uploads stay tenant-private. */
export function makeFactoryPorts(
  tenantSlug?: string,
  tenantId?: string,
  ontologyDomainId?: string,
  confirmedActor?: string,
  ontologyDomainRegistrationId?: string | null,
  runtimeProfileVersionId?: string | null,
): FactoryPorts {
  const tenantScope = tenantSlug && tenantId ? { tenantSlug, tenantId } : undefined;
  const fileScope = tenantScope ? { ...tenantScope, ontologyDomainId } : undefined;
  const runtimeProfileContext =
    tenantScope && runtimeProfileVersionId
      ? resolveRuntimeProfileExecutionContext({
          businessTenantId: tenantScope.tenantId,
          businessTenantSlug: tenantScope.tenantSlug,
          runtimeProfileVersionId,
        })
      : undefined;
  const runtimeAdapterSnapshot: RuntimeTenantRegistrySnapshot | undefined =
    runtimeProfileContext
      ? {
          tenantSlug:
            runtimeProfileContext.adapter.adapterRegistrySlug,
          selectedVersion:
            runtimeProfileContext.adapter.adapterRegistryVersion,
          registry: runtimeProfileContext.reviewedAdapter.registry,
        }
      : undefined;
  const assertExpectedDomain = (domain: string) => {
    if (ontologyDomainId && domain !== ontologyDomainId) {
      throw new Error(`factory ontology domain mismatch: expected ${ontologyDomainId}, got ${domain}`);
    }
  };
  const draftStore = new FsAgentDraftStore(fileScope);
  const fixtureAssetStore = tenantId && ontologyDomainId ? new FsFactoryFixtureAssetStore() : null;
  const toolStore = new DrizzleToolStore(
    tenantId,
    ontologyDomainId,
    tenantSlug,
    runtimeAdapterSnapshot,
    confirmedActor,
  );
  const resolveFactoryTenant = async () => {
    const { getDb, tenants, eq } = await import("@agentic/db");
    const row = tenantId
      ? getDb().select().from(tenants).where(eq(tenants.id, tenantId)).all()[0]
      : tenantSlug
        ? getDb().select().from(tenants).where(eq(tenants.slug, tenantSlug)).all()[0]
        : undefined;
    if (!row) return undefined;
    // The immutable tenant id is the authority. Slug remains a filesystem /
    // display coordinate and must agree; it must never redirect a scoped port
    // to a different row.
    if (tenantId && row.id !== tenantId) throw new Error("factory tenant identity mismatch");
    if (tenantSlug && row.slug !== tenantSlug) throw new Error("factory tenant slug/id mismatch");
    return row;
  };
  return {
    factoryScope: tenantScope,
    ontology: tenantSlug && tenantId
      ? makeBoundFactoryOntologySource(
          tenantSlug,
          tenantId,
          ontologyDomainRegistrationId,
          ontologyDomainId,
        )
      : new UploadedFirstOntologySource(
          new UploadedOntologySource(tenantSlug),
          new AllmetaOntologySource(),
        ),
    sandbox: makeSandboxDeployer(tenantScope),
    conversation: new DrizzleConversationStore(tenantId, ontologyDomainId),
    // #CONV-ARCHIVE — durable verbatim retention for compaction-dropped turns (+ recall tool).
    // Tenant+domain scoped like the conversation itself; absent scope → no archive (legacy fold).
    conversationArchive: tenantId && ontologyDomainId
      ? new FsConversationArchiveStore(tenantId, ontologyDomainId)
      : undefined,
    fixtureAssets: fixtureAssetStore && tenantId && ontologyDomainId
      ? {
          readExact: async ({ assetId, domainId, conversationId }) => {
            assertExpectedDomain(domainId);
            const stored = await fixtureAssetStore.read({
              tenantId,
              domain: ontologyDomainId,
              conversationId,
            }, assetId);
            if (!stored) return null;
            return {
              assetId: stored.assetId,
              caseId: stored.caseId,
              path: stored.path,
              content: Buffer.from(stored.base64, "base64"),
              sha256: stored.sha256,
              bytes: stored.bytes,
              mimeType: stored.mimeType,
              filename: stored.filename,
              expiresAt: stored.expiresAt,
              provenance: stored.provenance,
            };
          },
          createSyntheticResume: async ({ domainId, conversationId, caseId, path, persona }) => {
            assertExpectedDomain(domainId);
            const fixture = syntheticResumePdf(persona);
            const metadata = await fixtureAssetStore.put({
              tenantId,
              domain: ontologyDomainId,
              conversationId,
            }, {
              caseId,
              path,
              base64: fixture.base64,
              mimeType: "application/pdf",
              filename: `synthetic-resume-${caseId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80)}.pdf`,
              provenance: "synthetic_resume_pdf",
            });
            return {
              ...metadata,
              caseId,
              path,
              content: fixture.bytes,
              provenance: "synthetic_resume_pdf",
            };
          },
        }
      : undefined,
    humanMemory: tenantId && ontologyDomainId
      ? new DrizzleHumanMemoryStore(tenantId, ontologyDomainId)
      : undefined,
    // #KNOW-PACK (P1-A) — 跨会话领域分析包：understand_ontology/read_ontology 读穿写穿。
    domainInsights: tenantId && ontologyDomainId
      ? new DrizzleDomainInsightStore(tenantId, ontologyDomainId)
      : undefined,
    reflection: new DrizzleReflectionWriter(tenantId, ontologyDomainId),
    skills: new DrizzleSkillStore(tenantId, ontologyDomainId),
    tools: toolStore,
    sandboxEvidencePlans: tenantId && ontologyDomainId && tenantSlug
      ? {
          prepare: (request) => toolStore.prepareSandboxEvidencePlan(request),
          commit: (request) => toolStore.commitSandboxEvidencePlan(request),
        }
      : undefined,
    integrationProfiles: tenantId && ontologyDomainId
      ? {
          save: async (domain, input) => {
            assertExpectedDomain(domain);
            if (
              input.authorization.runId !== input.execution.runId
              || input.authorization.conversationId !== input.execution.conversationId
            ) {
              throw new Error("integration profile authorization receipt does not belong to the current execution");
            }
            const subject = createIntegrationProfileAuthorizationBinding({
              tool: input.tool,
              domainId: domain,
              profileKey: input.profileKey,
              environment: input.environment,
              config: input.config,
              scope: input.execution,
            });
            if (!verifyConsumedFactoryAuthorization({
              tenantId,
              domain,
              receipt: input.authorization,
              kind: "integration_profile",
              subjectDigest: subject.digest,
            })) throw new Error("integration profile authorization receipt is missing, stale, or belongs to another actor/scope");
            const result = saveIntegrationProfile({
              tenantId,
              domainId: ontologyDomainId,
              profileKey: input.profileKey,
              environment: input.environment,
              tool: input.tool,
              config: input.config,
              confirmedBy: input.authorization.actor,
              // The generic durable challenge receipt has its own protocol.
              // Profile v3 is the reviewed subject contract that includes the
              // explicit sandbox/production environment.
              authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
            });
            if (!result.ok) throw new Error(result.error);
            return result.profile;
          },
        }
      : undefined,
    authorizationChallenges: tenantId && ontologyDomainId
      ? new DrizzleFactoryAuthorizationChallengeStore(tenantId, ontologyDomainId)
      : undefined,
    // #C: the REAL global tool registry → the brain can recommend real tools (parseResumeApi,
    // fs.*) by semantic rank + know what config to supply, even when the ontology declared none.
    toolRegistry: {
      // #SCALE-TOOLS — enrich each real tool with its empirical sandbox success rate so ranking can
      // demote tools that keep failing in practice (not just match semantically).
      list: async () => {
        const stats = await new DrizzleToolStatsStore(tenantId, ontologyDomainId).successRates();
        const probeReceipts = tenantId
          ? summarizeGlobalToolProbeReceiptsByTool(listGlobalToolProbeReceipts(tenantId, ontologyDomainId))
          : new Map();
        const integrationProfiles = new Map<string, ReturnType<typeof listIntegrationProfiles>>();
        for (const profile of tenantId ? listIntegrationProfiles(tenantId, ontologyDomainId) : []) {
          const current = integrationProfiles.get(profile.toolName) ?? [];
          current.push(profile);
          integrationProfiles.set(profile.toolName, current);
        }
        const globals = listGlobalTools().map((t) => {
          const st = stats[t.name];
          const probe = probeReceipts.get(t.name);
          // A catalog entry must not opt a risky executable surface out of
          // evidence merely by omitting capability.probeRequired. Keep this
          // aligned with tenant-native discovery: external access and every
          // write/read-write tool require definition-bound probe evidence.
          const probeRequired =
            t.effectScope === "external" ||
            t.operation === "write" ||
            t.operation === "read_write" ||
            t.sideEffect === "write" ||
            t.sideEffect === "dual" ||
            t.capabilities?.some((capability) => capability.probeRequired) === true;
          return {
            name: t.name,
            summary: t.summary,
            aliases: t.aliases,
            category: t.category,
            sideEffect: t.sideEffect ?? "call",
            operation: t.operation,
            effectScope: t.effectScope,
            sandboxPolicy: t.sandboxPolicy,
            configKeys: t.configSchema ? Object.keys(t.configSchema) : [],
            // #KEY-GAP — the tool's self-declared REQUIRED credential env(s), so the factory can
            // detect (generically) when a BOUND tool's key isn't configured and ask_user about it.
            credentialEnv: t.credentialEnv ?? [],
            capabilities: t.capabilities ?? [],
            probeStatus: probeRequired ? (probe?.status ?? "required") : "verified" as const,
            definitionHash: probe?.definitionHash,
            verifiedDefinitionHashes: probe?.verifiedDefinitionHashes,
            productionVerifiedDefinitionHashes:
              probe?.productionVerifiedDefinitionHashes,
            probeEvidenceMode: probe?.evidenceMode,
            integrationProfiles: integrationProfiles.get(t.name) ?? [],
            catalogDefinition: {
              name: t.name,
              category: t.category,
              sourcePath: t.sourcePath,
              ...(t.sourceIdentity !== undefined ? { sourceIdentity: t.sourceIdentity } : {}),
              sideEffect: t.sideEffect,
              operation: t.operation,
              effectScope: t.effectScope,
              sandboxPolicy: t.sandboxPolicy,
              argsSchema: t.argsSchema,
              returnsSchema: t.returnsSchema,
              configSchema: t.configSchema,
              ...(t.configContract !== undefined ? { configContract: t.configContract } : {}),
              capabilities: t.capabilities,
              probeSafety: t.probeSafety,
              profileScope: t.profileScope,
            },
            invoked: st?.invoked,
            successRate: st && st.invoked > 0 ? st.succeeded / st.invoked : undefined,
          };
        });
        const tenantNative = runtimeAdapterSnapshot || tenantSlug
          ? (
              runtimeAdapterSnapshot
                ? listTenantNativeFactoryToolsFromSnapshot({
                    snapshot: runtimeAdapterSnapshot,
                    expectedVersion: runtimeAdapterSnapshot.selectedVersion,
                    probesByTool: probeReceipts,
                  })
                : listTenantNativeFactoryTools({
                    tenantSlug: tenantSlug!,
                    probesByTool: probeReceipts,
                  })
            ).map((tool) => {
              const st = stats[tool.name];
              return {
                ...tool,
                integrationProfiles: integrationProfiles.get(tool.name) ?? [],
                invoked: st?.invoked,
                successRate: st && st.invoked > 0
                  ? st.succeeded / st.invoked
                  : undefined,
              };
            })
          : [];
        // Runtime dispatch resolves tenantRegistry.tools before the global
        // registry. Mirror that precedence in the factory catalog.
        const nativeNames = new Set(tenantNative.flatMap((tool) => [
          tool.name,
          ...(tool.aliases ?? []),
        ]));
        return [
          ...globals.filter((tool) =>
            !nativeNames.has(tool.name)
            && !(tool.aliases ?? []).some((alias) => nativeNames.has(alias))),
          ...tenantNative,
        ];
      },
    },
    integrationCapabilities: {
      list: async () => listRuntimeIntegrationCapabilities(),
    },
    // 外部系统档案别名组 — the human-confirmed synonym source for system
    // matching (System Profiles). Read per call so a newly confirmed profile
    // takes effect on the next readiness/design pass without a restart.
    systemAliases: tenantId
      ? {
          list: async () => {
            const { tenantSystemAliasGroups } = await import("../system-profile-store");
            try {
              return tenantSystemAliasGroups(tenantId);
            } catch {
              return []; // pre-migration DB — alias matching simply stays exact-label
            }
          },
        }
      : undefined,
    // A3 — systems a person confirmed as deliberate manual boundaries in a
    // System Profile; pre-seeds design-time human-boundary so they are not
    // re-asked every run. Read per call so a newly confirmed profile takes
    // effect on the next design pass without a restart.
    systemHumanBoundaries: tenantId
      ? {
          list: async () => {
            const { tenantHumanBoundarySystems } = await import("../system-profile-store");
            try {
              return tenantHumanBoundarySystems(tenantId);
            } catch {
              return []; // pre-migration DB — no pre-seed, run-time clarify still works
            }
          },
        }
      : undefined,
    // Persist a finished run's agents as durable, reviewable drafts (OLD syncDomainDrafts).
    drafts: draftStore,
    // #POLICY-LEARN — 前置路由 arm 统计（选路证据偏置 ← run 结果回喂）。
    policyStats: new FsPolicyStatsStore(fileScope),
    // #P1-6 — persist per-criterion acceptance verdicts for trend dashboards.
    acceptance: new DrizzleAcceptanceRecorder(),
    // #MEM-WRITE (P0-5) — 工厂长期记忆 port：包 runtime 的 createMemoryHandle（agent_memory_long +
    // 向量驱动）。这是审计标记的"建成但零调用方"写路径的复活点——conductor 收尾的 Mem0 式整合经
    // 此写入。agentName 固定 "factory"、subject=domain：同租户同域的记忆跨 run 累积、跨域隔离。
    memory: tenantScope
      ? (() => {
          // #MEM-GENERAL — __general__ 哨兵豁免域校验：通用道运载跨域方法论，本就不属于任何
          // 单一 ontology 域。租户隔离不受影响（tenantId 仍是硬作用域）。
          const assertMemoryDomain = (domain: string) => {
            if (domain !== GENERAL_MEMORY_SUBJECT) assertExpectedDomain(domain);
          };
          return {
          search: async (domain, query, k) => {
            assertMemoryDomain(domain);
            const [{ getMemoryDriver }, t] = await Promise.all([import("@agentic/runtime"), resolveFactoryTenant()]);
            if (!t) throw new Error(`factory tenant ${tenantId ?? tenantSlug ?? "(unscoped)"} no longer exists`);
            const driver = getMemoryDriver();
            if (!driver) throw new Error("factory memory search requires a configured vector driver");
            const hits = await driver.search(query, k, {
              tenantId: t.id,
              agentName: "factory",
              subject: domain,
              subjectExact: true,
            });
            return hits.map((x) => {
              const key = x.meta?.key;
              const subject = x.meta?.subject;
              if (typeof key !== "string" || subject !== domain) {
                throw new Error("factory memory driver returned a hit outside the exact domain/key contract");
              }
              return { key, value: typeof x.value === "string" ? x.value : JSON.stringify(x.value), score: x.score };
            });
          },
          put: async (domain, key, value) => {
            assertMemoryDomain(domain);
            const [{ createMemoryHandle }, { getDb, agentMemoryLong, and, eq }, t] = await Promise.all([
              import("@agentic/runtime"),
              import("@agentic/db"),
              resolveFactoryTenant(),
            ]);
            if (!t) throw new Error(`factory tenant ${tenantId ?? tenantSlug ?? "(unscoped)"} no longer exists`);
            // #MEM-CAP — #MEM-RECALL 打通读路径后，无界的每域事实增长会稀释召回质量。语义：
            // 新 key 且已达上限 → 按 updatedAt 逐出最旧行补位；UPDATE 既有 key 永不逐出。
            // 质量仲裁仍归 decideMemoryOps（Mem0 原则），这里只兜容量。默认 200。
            const capRaw = Number(process.env.FACTORY_MEMORY_MAX_FACTS);
            const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 200;
            const db = getDb();
            const memScope = and(
              eq(agentMemoryLong.tenantId, t.id),
              eq(agentMemoryLong.agentName, "factory"),
              eq(agentMemoryLong.subject, domain),
            );
            const existing = db
              .select({ key: agentMemoryLong.key, updatedAt: agentMemoryLong.updatedAt })
              .from(agentMemoryLong)
              .where(memScope)
              .all();
            if (!existing.some((r) => r.key === key) && existing.length >= cap) {
              const victims = existing
                .sort((a, b) => new Date(a.updatedAt as unknown as string | number).getTime() - new Date(b.updatedAt as unknown as string | number).getTime())
                .slice(0, existing.length - cap + 1);
              for (const victim of victims) {
                db.delete(agentMemoryLong).where(and(memScope, eq(agentMemoryLong.key, victim.key))).run();
              }
            }
            await createMemoryHandle({ tenantId: t.id, agentName: "factory", subject: domain, runId: "factory" }).put(key, value);
          },
          del: async (domain, key) => {
            assertMemoryDomain(domain);
            const [{ createMemoryHandle }, t] = await Promise.all([import("@agentic/runtime"), resolveFactoryTenant()]);
            if (!t) throw new Error(`factory tenant ${tenantId ?? tenantSlug ?? "(unscoped)"} no longer exists`);
            await createMemoryHandle({ tenantId: t.id, agentName: "factory", subject: domain, runId: "factory" }).delete(key);
          },
          };
        })()
      : undefined,
    // #SCALE-TOOLS — per-tool sandbox effectiveness recording.
    toolStats: new DrizzleToolStatsStore(tenantId, ontologyDomainId),
    // 领域分析报告管线（brain 的 generate_report 工具 → report-jobs → reportGenerator agent →
    // artifacts）。动态 import：report-jobs 反向 import 本模块的 makeFactoryPorts，静态互引会循环。
    report: tenantSlug && tenantId
      ? {
          start: async (o) => {
            assertExpectedDomain(o.domain);
            const [{ startOntologyReportJob }, row] = await Promise.all([import("./report-jobs"), resolveFactoryTenant()]);
            if (!row) throw new Error(`租户「${tenantSlug}」不存在`);
            const job = startOntologyReportJob({ tenantId: row.id, tenantSlug, domain: o.domain, format: o.format, focus: o.focus, ...(o.extraHtml ? { extraHtml: o.extraHtml } : {}) });
            return { id: job.id };
          },
          status: async (id) => {
            const { getReportJob } = await import("./report-jobs");
            const j = getReportJob(id, tenantId);
            return j ? { status: j.status, phase: j.phase, error: j.error, note: j.note, title: j.title, artifacts: j.artifacts } : null;
          },
        }
      : undefined,
    // G1 能力解析门的「复用面」——舰队目录：本租户已交付的 functions（agents 表 ⋈ workflows），
    // trigger/emit 取自各自最新 agent_version 的 manifest。capability_resolve 据此判「复用/组合/新造」。
    // G2 回流飞轮（系统 B → 系统 A）：附带近 14 天生产战绩（prodRuns/prodFailRate），并对
    // 反复翻车的 agent 落一条当日反思（幂等，靠 [生产回流:slug:日期] 标记去重）——大脑下次
    // 开局会读到「XX 在生产上连续失败」这条教训。Stats and reflux are supervision data:
    // configured storage failures propagate instead of being converted into an empty/healthy fleet.
    fleet: tenantScope
      ? {
          list: async () => {
            const { getDb, workflows, agents, agentVersions, runs, eq } = await import("@agentic/db");
            const { and, gte, inArray } = await import("drizzle-orm");
            const db = getDb();
            const t = await resolveFactoryTenant();
            if (!t) return [];
            const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : []);
            const rows: Array<{ agentDbId: string; kebabId: string; name: string; title?: string; enabled: boolean; trigger: string[]; emit: string[] }> = [];
            for (const wf of db.select().from(workflows).where(eq(workflows.tenantId, t.id)).all()) {
              for (const a of db.select().from(agents).where(eq(agents.workflowId, wf.id)).all()) {
                const av = db.select().from(agentVersions).where(eq(agentVersions.agentId, a.id)).all().pop();
                const m = (av?.manifestJson ?? {}) as Record<string, unknown>;
                rows.push({ agentDbId: a.id, kebabId: a.kebabId, name: a.name, title: a.title ?? undefined, enabled: a.enabled !== false, trigger: asArr(m.trigger), emit: asArr(m.triggered_event ?? m.emit) });
              }
            }
            // 近 N 天生产战绩聚合（一次查询，JS 归并）——窗口与主动治理巡检共享同一常量。
            const stats = new Map<string, { total: number; failed: number }>();
            const since = new Date(Date.now() - governanceWindowDays() * 24 * 3600 * 1000);
            const ids = rows.map((r) => r.agentDbId);
            if (ids.length) {
              for (const r of db
                .select({ agentId: runs.agentId, status: runs.status })
                .from(runs)
                .where(and(eq(runs.tenantId, t.id), gte(runs.startedAt, since), inArray(runs.agentId, ids)))
                .all()) {
                const s = stats.get(r.agentId) ?? { total: 0, failed: 0 };
                s.total++;
                const st = String(r.status); // schema 联合类型窄于实际写入面（failed/error 由引擎写入）
                if (st === "failed" || st === "error") s.failed++;
                stats.set(r.agentId, s);
              }
            }
            // 反复翻车 → 当日一条反思回流。Only inspect this tenant's bound
            // ontology draft store. The store owns exact provenance, collision-safe
            // paths and the narrowly-scoped legacy policy; do not reconstruct its
            // paths or aliases here.
            const bad = rows.filter((r) => {
              const s = stats.get(r.agentDbId);
              return s && s.total >= 3 && s.failed / s.total >= 0.5;
            });
            if (bad.length && ontologyDomainId) {
              const ownedDraftSlugs = new Set((await draftStore.list(ontologyDomainId)).map((draft) => draft.slug));
              const today = new Date().toISOString().slice(0, 10);
              const writer = new DrizzleReflectionWriter(t.id, ontologyDomainId);
              const existing = await writer.list(ontologyDomainId);
              for (const b of bad) {
                if (!ownedDraftSlugs.has(b.kebabId)) continue;
                const marker = `[生产回流:${b.kebabId}:${today}]`;
                if (existing.some((r) => String((r as { lesson?: string }).lesson ?? "").includes(marker))) continue;
                const s = stats.get(b.agentDbId)!;
                await writer.record(ontologyDomainId, {
                  summary: `生产运行回流：「${b.name}」近 14 天 ${s.total} 次运行失败 ${s.failed} 次`,
                  lesson: `${marker} 已上线的「${b.name}」(${b.kebabId}) 生产失败率 ${Math.round((s.failed / s.total) * 100)}%（${s.failed}/${s.total}）。复用它前先查失败原因（运行记录/日志）；重生成该动作时优先修根因而不是换提示词。`,
                  failedStep: `production:${b.kebabId}`,
                  kind: "caveat",
                });
              }
            }
            return rows.map(({ agentDbId, ...r }) => {
              const s = stats.get(agentDbId);
              return { ...r, ...(s && s.total > 0 ? { prodRuns: s.total, prodFailRate: +(s.failed / s.total).toFixed(2) } : {}) };
            });
          },
        }
      : undefined,
    // web search intentionally omitted (no provider configured) → web_search no-ops honestly
  };
}

/** List the durable agent drafts a domain's finished runs produced (for the API + UI). */
export function listAgentDrafts(domain: string, scope?: { tenantId: string; tenantSlug: string; ontologyDomainId?: string }) {
  return new FsAgentDraftStore(scope).list(domain);
}

export { ManifestOntologySource, AllmetaOntologySource, CompositeOntologySource, ManifestSandboxDeployer, ProbingSandboxDeployer, DrizzleConversationStore, DrizzleDomainInsightStore, DrizzleReflectionWriter, DrizzleSkillStore, DrizzleToolStore, DrizzleHumanMemoryStore };
export { humanMemoryFromInjectedMessage } from "./human-memory-store";
export { recordRunStart, recordRunFinish, recordRunProgress, listRuns, getRun, deleteRun, restoreRun, deleteRunsByDomain, markRunAborted, listRunningRuns, factoryRunExecutionEvidence, factoryRunEvidenceStatus, type RunRecord } from "./stores";
