import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { defineTool, type TenantRegistry } from "@agentic/agent-kit";
import {
  catalogToolDefinitionHash,
  createProbeAuthorizationBinding,
  type DomainOntology,
  resolveIntegrationBindings,
  type OntologyAction,
} from "@agentic/agent-factory";
import {
  factoryAuthorizationChallenges,
  factoryToolProbes,
  getDb,
  tenants,
} from "@agentic/db";
import zhaopinRegistry from "@tenants/zhaopin";
import raasRegistry from "@tenants/raas";
import agentsGenerationRegistry, {
  agentsGenerationReasoningConfig,
} from "@tenants/agents-generation";
import {
  executeFactsQuery,
  RECRUITMENT_ONTOLOGY_CAPABILITY_NAMES,
  RECRUITMENT_RAAS_CAPABILITY_NAMES,
} from "@agentic/recruitment-capabilities";
import { ensureTenantRegistrySnapshotForReadOnlyPreflight } from "../src/bootstrap";
import { summarizeFactoryDomainPreflight } from "../scripts/factory-domain-preflight";
import { makeFactoryPorts } from "../src/services/agent-factory";
import { currentFactoryExecutionTools } from "../src/services/agent-factory/execution-resource-snapshot";
import { probeGlobalIntegration } from "../src/services/agent-factory/integration-probe";
import { DrizzleFactoryAuthorizationChallengeStore } from "../src/services/agent-factory/authorization-challenge-store";
import {
  publishRuntimeTenantRegistrySnapshot,
  removeRuntimeTenantRegistrySnapshot,
  resolveTenantNativeFactoryTool,
} from "../src/services/agent-factory/tenant-native-tool-provider";
import { registryWriteProbeLifecycleProvider } from "../src/services/agent-factory/write-probe-lifecycle-provider";

const slug = "factory-native-test";
const tenantId = "tenant-native-test-id";
const domain = "Agents-generation";

const writeProbeSafety = {
  testDataContract: {
    kind: "synthetic_canary" as const,
    marker: {
      kind: "argument" as const,
      path: "probe.marker",
      valuePrefix: "factory-canary-",
    },
  },
  idempotency: {
    kind: "argument" as const,
    path: "probe.idempotency_key",
    valuePrefix: "factory-idem-",
  },
  isolation: {
    namespace: {
      kind: "argument" as const,
      path: "probe.namespace",
      valuePrefix: "factory-ns-",
    },
    target: {
      kind: "argument" as const,
      path: "probe.target",
      valuePrefix: "factory-target-",
    },
  },
  cleanup: { kind: "handler" as const, handler: "test.disposable.cleanup" },
  absenceProof: {
    kind: "handler" as const,
    handler: "test.disposable.readback",
  },
};

const disposableCanaries = new Set<string>();
const lifecycleOrder: string[] = [];

function disposableWriter(revision: string) {
  return defineTool({
    name: "tenant.disposable-write",
    factory: {
      category: "test",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      probeSafety: writeProbeSafety,
      returnsSchema: { created: { type: "boolean", required: true } },
      capabilities: [
        {
          systems: ["TestBoundary"],
          kinds: ["test_store"],
          roles: ["write"],
          operations: ["create"],
          probeRequired: true,
        },
      ],
      source: { modulePath: "test/disposable-writer.ts", revision },
    },
    factoryWriteProbeLifecycle: {
      identity: { id: "test/disposable-writer-lifecycle", revision },
      async cleanup({ canary }) {
        lifecycleOrder.push("cleanup");
        return { completed: disposableCanaries.delete(canary.target) };
      },
      async readback({ canary }) {
        lifecycleOrder.push("readback");
        return { absent: !disposableCanaries.has(canary.target) };
      },
    },
    async handler(ctx) {
      lifecycleOrder.push("create");
      const probe = ctx.event?.data.probe as
        | Record<string, unknown>
        | undefined;
      const target = typeof probe?.target === "string" ? probe.target : "";
      if (!target) throw new Error("test canary target is required");
      disposableCanaries.add(target);
      return { data: { created: true } };
    },
  });
}

const disposableWriterV1 = disposableWriter("1");
const writerWithoutLifecycle = defineTool({
  name: "tenant.write-without-lifecycle",
  factory: {
    category: "test",
    sideEffect: "write",
    operation: "write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    probeSafety: writeProbeSafety,
    capabilities: [
      {
        systems: ["TestBoundary"],
        kinds: ["test_store"],
        roles: ["write"],
        probeRequired: true,
      },
    ],
    source: { modulePath: "test/write-without-lifecycle.ts" },
  },
  async handler() {
    throw new Error("must not run without lifecycle wiring");
  },
});

const localRoute = defineTool({
  name: "tenant.route",
  description: "route without replacing the runtime handler",
  factory: {
    category: "test",
    sideEffect: "call",
    operation: "compute",
    effectScope: "none",
    sandboxPolicy: "pure",
    capabilities: [
      {
        systems: ["Runtime"],
        kinds: ["compute"],
        roles: ["route"],
        operations: ["route"],
        probeRequired: false,
      },
    ],
    source: { modulePath: "test/tenant-route.ts", exportName: "localRoute" },
  },
  async handler() {
    return { data: { routed: true } };
  },
});

const externalWriter = defineTool({
  name: "tenant.write",
  factory: {
    category: "test",
    sideEffect: "write",
    operation: "write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    configSchema: {
      tenant_slug: { type: "string", required: true },
    },
    capabilities: [
      {
        systems: ["External"],
        kinds: ["database"],
        roles: ["write"],
        // A stale declaration cannot disable evidence for a risky policy.
        probeRequired: false,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    source: {
      modulePath: "test/tenant-write.ts",
      exportName: "externalWriter",
    },
  },
  async handler() {
    return { data: { written: true } };
  },
});

const hidden = defineTool({
  name: "tenant.hidden",
  async handler() {
    return { data: {} };
  },
});

const registry: TenantRegistry = {
  tools: {
    "tenant.route": localRoute,
    "tenant.write": externalWriter,
    "tenant.hidden": hidden,
    "tenant.disposable-write": disposableWriterV1,
    "tenant.write-without-lifecycle": writerWithoutLifecycle,
  },
  factory: {
    source: {
      kind: "test_bundle",
      id: "factory-native-test",
      version: "1.0.0",
    },
  },
};

afterEach(() => {
  removeRuntimeTenantRegistrySnapshot(slug);
  removeRuntimeTenantRegistrySnapshot("agents-generation");
  disposableCanaries.clear();
  lifecycleOrder.length = 0;
});

describe("tenant-native Agent Factory tool provider", () => {
  beforeAll(() => {
    getDb()
      .insert(tenants)
      .values({
        id: tenantId,
        slug,
        name: "Tenant native lifecycle wiring test",
      })
      .onConflictDoNothing()
      .run();
  });

  afterAll(() => {
    getDb()
      .delete(factoryAuthorizationChallenges)
      .where(eq(factoryAuthorizationChallenges.tenantId, tenantId))
      .run();
    getDb()
      .delete(factoryToolProbes)
      .where(eq(factoryToolProbes.tenantId, tenantId))
      .run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("surfaces the actual runtime descriptor with hashable versioned source identity", () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    const first = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.route",
    })!;
    expect(first.descriptor).toBe(localRoute);
    expect(first.realTool.probeStatus).toBeUndefined();
    expect(first.realTool.catalogDefinition?.sourceIdentity).toMatchObject({
      provider: "tenant_registry",
      tenantSlug: slug,
      selectedVersion: "1.0.0",
    });
    const firstHash = catalogToolDefinitionHash(
      first.realTool.catalogDefinition!,
    );

    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "2.0.0",
      registry,
    });
    const second = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.route",
    })!;
    expect(
      catalogToolDefinitionHash(second.realTool.catalogDefinition!),
    ).not.toBe(firstHash);
    expect(() =>
      resolveTenantNativeFactoryTool({
        tenantSlug: slug,
        name: "tenant.route",
        expectedVersion: "1.0.0",
      }),
    ).toThrow(/version mismatch/);
  });

  it("omits undeclared tools and keeps risky tools unverified and fail-closed", () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    expect(
      resolveTenantNativeFactoryTool({
        tenantSlug: slug,
        name: "tenant.hidden",
      }),
    ).toBeUndefined();
    const writer = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.write",
    })!;
    expect(writer.realTool.probeStatus).toBe("required");
    expect(writer.realTool.capabilities?.[0]?.probeRequired).toBe(true);
    expect(writer.realTool.catalogDefinition?.probeSafety).toBeUndefined();
    expect(writer.realTool.catalogDefinition?.profileScope).toEqual({
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    });
  });

  it("resolves a code-owned lifecycle and completes create, cleanup and absence readback", async () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    const resolved = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.disposable-write",
    })!;
    const lifecycle = registryWriteProbeLifecycleProvider.resolve({
      source: "tenant_registry",
      descriptor: resolved.descriptor,
      catalogSourceIdentity: resolved.catalog.sourceIdentity,
    });
    expect(lifecycle).toBe(disposableWriterV1.factoryWriteProbeLifecycle);
    const result = await probeGlobalIntegration({
      catalog: resolved.catalog,
      descriptor: resolved.descriptor,
      args: {},
      tenantSlug: slug,
      persistCassette: false,
      canarySeed: "a".repeat(64),
      authorization: { actor: "test-human", allowSideEffects: true },
      writeProbeLifecycle: lifecycle,
    });
    expect(result).toMatchObject({
      verified: true,
      classification: "verified",
      writeProbeProof: {
        create: { completed: true },
        cleanup: { completed: true },
        absence: { verified: true },
      },
    });
    expect(lifecycleOrder).toEqual(["create", "cleanup", "readback"]);
    expect(disposableCanaries.size).toBe(0);
  });

  it("DrizzleToolStore resolves the current descriptor lifecycle without manual injection", async () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    const resolved = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.disposable-write",
    })!;
    const execution = {
      runId: "lifecycle-wiring-run",
      conversationId: "lifecycle-wiring-conversation",
    };
    const subject = createProbeAuthorizationBinding(
      resolved.realTool,
      {},
      {},
      process.env,
      { domainId: domain, ...execution },
    )!;
    const challengeStore = new DrizzleFactoryAuthorizationChallengeStore(
      tenantId,
      domain,
    );
    const challenge = await challengeStore.issue(domain, {
      kind: "probe",
      subjectDigest: subject.digest,
      ...execution,
      question: "Run this test-only disposable write canary once?",
      declineLabel: "No",
      confirmLabel: "Run once",
    });
    const authorization = await challengeStore.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "test-human",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    const result = await makeFactoryPorts(slug, tenantId, domain).tools.probe!({
      domain,
      name: "tenant.disposable-write",
      args: {},
      authorization,
      execution,
      expectedDefinitionHash: subject.definitionHash,
    });
    expect(result).toMatchObject({
      verified: true,
      classification: "verified",
      definitionHash: subject.definitionHash,
      writeProbeProof: {
        cleanup: { completed: true },
        absence: { verified: true },
      },
    });
    const catalogAfterProbe = await makeFactoryPorts(
      slug,
      tenantId,
      domain,
    ).toolRegistry!.list();
    expect(
      catalogAfterProbe.find((tool) => tool.name === "tenant.disposable-write"),
    ).toMatchObject({
      verifiedDefinitionHashes: [subject.definitionHash],
      productionVerifiedDefinitionHashes: [subject.definitionHash],
      probeEvidenceMode: "live-probe",
    });
    expect(lifecycleOrder).toEqual(["create", "cleanup", "readback"]);
    expect(disposableCanaries.size).toBe(0);
  });

  it("keeps a complete safety contract blocked when executable lifecycle wiring is absent", async () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    const resolved = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.write-without-lifecycle",
    })!;
    const lifecycle = registryWriteProbeLifecycleProvider.resolve({
      source: "tenant_registry",
      descriptor: resolved.descriptor,
      catalogSourceIdentity: resolved.catalog.sourceIdentity,
    });
    expect(lifecycle).toBeUndefined();
    const result = await probeGlobalIntegration({
      catalog: resolved.catalog,
      descriptor: resolved.descriptor,
      args: {},
      tenantSlug: slug,
      persistCassette: false,
      canarySeed: "b".repeat(64),
      authorization: { actor: "test-human", allowSideEffects: true },
      writeProbeLifecycle: lifecycle,
    });
    expect(result).toMatchObject({
      verified: false,
      classification: "needs_config",
      next: "ask_user",
      missing: ["cleanup_wiring", "absence_readback_wiring"],
    });
  });

  it("invalidates the definition identity when lifecycle code or revision drifts", () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    const first = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.disposable-write",
    })!;
    const firstHash = catalogToolDefinitionHash(
      first.realTool.catalogDefinition!,
    );
    const writerV2 = disposableWriter("2");
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry: {
        ...registry,
        tools: { ...registry.tools, "tenant.disposable-write": writerV2 },
      },
    });
    const second = resolveTenantNativeFactoryTool({
      tenantSlug: slug,
      name: "tenant.disposable-write",
    })!;
    expect(
      catalogToolDefinitionHash(second.realTool.catalogDefinition!),
    ).not.toBe(firstHash);
    expect(() =>
      registryWriteProbeLifecycleProvider.resolve({
        source: "tenant_registry",
        descriptor: second.descriptor,
        catalogSourceIdentity: first.catalog.sourceIdentity,
      }),
    ).toThrow(/does not match the selected tool definition/);
    expect(second.realTool.catalogDefinition?.sourceIdentity).toMatchObject({
      writeProbeLifecycle: {
        schema: "agentic-write-probe-lifecycle/v1",
        id: "test/disposable-writer-lifecycle",
        revision: "2",
        cleanupHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        readbackHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("is used by both live Factory ports and promotion resource snapshots", async () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: slug,
      selectedVersion: "1.0.0",
      registry,
    });
    const ports = makeFactoryPorts(slug, tenantId, domain);
    const catalog = await ports.toolRegistry!.list();
    expect(
      catalog.find((tool) => tool.name === "tenant.route")?.catalogDefinition
        ?.sourceIdentity,
    ).toMatchObject({ tenantSlug: slug, selectedVersion: "1.0.0" });
    expect(
      catalog.find((tool) => tool.name === "tenant.disposable-write")
        ?.catalogDefinition?.sourceIdentity,
    ).toMatchObject({
      writeProbeLifecycle: {
        schema: "agentic-write-probe-lifecycle/v1",
        id: "test/disposable-writer-lifecycle",
        revision: "1",
      },
    });

    const snapshot = await currentFactoryExecutionTools({
      tenantId,
      tenantSlug: slug,
      tenantVersion: "1.0.0",
      domainId: domain,
    });
    expect(snapshot.some((tool) => tool.name === "tenant.route")).toBe(true);
    expect(snapshot.some((tool) => tool.name === "tenant.hidden")).toBe(false);
    expect(
      snapshot.find((tool) => tool.name === "tenant.disposable-write")
        ?.catalogDefinition?.sourceIdentity,
    ).toMatchObject({
      writeProbeLifecycle: {
        id: "test/disposable-writer-lifecycle",
        revision: "1",
      },
    });
  });

  it("zhaopin declares the nine native six-Agent tools while global tools stay global", () => {
    const expected = [...RECRUITMENT_RAAS_CAPABILITY_NAMES];
    for (const name of expected)
      expect(zhaopinRegistry.tools?.[name]?.factory).toBeDefined();
    for (const name of [
      "generateJdApi",
      "parseResumeApi",
      "matchResumeApi",
      "inviteCandidateApi",
      "records.upsert",
    ]) {
      expect(zhaopinRegistry.tools?.[name]?.factory).toBeUndefined();
    }
  });

  it("keeps legacy RAAS decisions in zhaopin but removes them from Agents-generation", async () => {
    expect(Object.keys(agentsGenerationRegistry.tools ?? {}).sort()).toEqual(
      [...RECRUITMENT_ONTOLOGY_CAPABILITY_NAMES].sort(),
    );
    for (const legacyDecisionTool of [
      "candidateDedupLookup",
      "routeResumeProcessed",
      "routeMatchOutcome",
      "routeInterviewInvitation",
      "persistRaasEntities",
    ]) {
      expect(
        agentsGenerationRegistry.tools?.[legacyDecisionTool],
      ).toBeUndefined();
      expect(zhaopinRegistry.tools?.[legacyDecisionTool]).toBeDefined();
    }
    expect(raasRegistry.tools?.candidateDedupLookup).toBeDefined();
    expect(raasRegistry.tools?.routeInterviewInvitation).toBeDefined();
    expect(agentsGenerationReasoningConfig.ontology.domainId).toBe(
      "Agents-generation",
    );
    expect(
      agentsGenerationRegistry.tools?.["facts.query"]?.factory?.source
        .modulePath,
    ).toBe("packages/recruitment-capabilities/src/tools/raas-facts.ts");
    expect(
      agentsGenerationRegistry.tools?.["facts.query"]?.factory,
    ).toMatchObject({
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      configSchema: {
        tenant_slug: { required: true },
        system_name: { required: true },
        connection_url_env: { required: true },
        statement_catalog_env: { required: true },
        allowed_operations: { required: true },
      },
    });
    expect(
      agentsGenerationRegistry.tools?.["reasoning.evaluateRules"]?.factory,
    ).toMatchObject({
      operation: "compute",
      effectScope: "external",
      sandboxPolicy: "live_external",
      argsSchema: {
        context: { type: "object" },
        facts: { type: "object|array" },
        rules: { type: "array" },
      },
      returnsSchema: {
        data: { type: "object", required: true },
        meta: { type: "object", required: true },
      },
    });
    await expect(
      agentsGenerationRegistry.tools!["facts.query"]!.handler({
        agentName: "processResume",
        actionName: "facts.query",
        correlationId: "cor-explicit-profile",
        tenantSlug: "agents-generation",
        event: {
          name: "RESUME_DOWNLOADED",
          data: { operation: "candidate.raw", values: {} },
        },
      }),
    ).rejects.toThrow(/config\.tenant_slug is required/);

    await expect(
      agentsGenerationRegistry.tools!["facts.query"]!.handler({
        agentName: "processResume",
        actionName: "facts.query",
        correlationId: "cor-no-prose-authority",
        tenantSlug: "agents-generation",
        event: {
          name: "RESUME_DOWNLOADED",
          data: {
            operation: "candidate.raw",
            values: {},
            _emit: "CANDIDATE_IDENTITY_CHECKED",
          },
        },
        config: {
          tenant_slug: "agents-generation",
          system_name: "RAAS_System",
          connection_url_env: "RAAS_TEST_URL",
          statement_catalog_env: "RAAS_TEST_STATEMENTS",
          allowed_operations: ["candidate.raw"],
        },
      }),
    ).rejects.toThrow(/input must contain exactly operation, values/);
  });

  it("executes the Agents-generation fact primitive read-only and returns no verdict", async () => {
    const calls: unknown[] = [];
    const result = await executeFactsQuery(
      {
        operation: "candidate.rawByPhone",
        values: { phone: "+86 13800000000" },
      },
      {
        tenant_slug: "agents-generation",
        system_name: "RAAS_System",
        connection_url_env: "RAAS_TEST_URL",
        statement_catalog_env: "RAAS_TEST_STATEMENTS",
        allowed_operations: ["candidate.rawByPhone"],
      },
      {
        env: {
          RAAS_TEST_URL: "postgres://user:pass@db.test:5432/raas",
          RAAS_TEST_STATEMENTS: JSON.stringify({
            "candidate.rawByPhone": {
              sql: "SELECT candidate_id, phone, employee_id FROM candidate WHERE phone = $1 LIMIT 5",
              params: ["phone"],
              mode: "read",
              max_rows: 5,
            },
          }),
        },
        poolFactory: () => ({
          async connect() {
            return {
              async query(query: unknown) {
                calls.push(query);
                if (typeof query === "object") {
                  return {
                    command: "SELECT",
                    rowCount: 1,
                    rows: [
                      {
                        candidate_id: "cand-existing",
                        phone: "+86 13800000000",
                        employee_id: "emp-owner",
                      },
                    ],
                  };
                }
                return { command: String(query), rowCount: 0, rows: [] };
              },
              release() {},
            };
          },
          async end() {},
        }),
      },
    );

    expect(calls[0]).toBe("BEGIN READ ONLY");
    expect(calls.at(-1)).toBe("COMMIT");
    expect(result).toEqual({
      operation: "candidate.rawByPhone",
      row_count: 1,
      rows: [
        {
          candidate_id: "cand-existing",
          phone: "+86 13800000000",
          employee_id: "emp-owner",
        },
      ],
      source: "postgres-statement-catalog",
    });
    expect(result).not.toHaveProperty("verdict");
    expect(result).not.toHaveProperty("sameAsCandidateId");
    expect(result).not.toHaveProperty("lockConflict");

    await expect(
      executeFactsQuery(
        { operation: "candidate.upsert", values: { candidate_id: "x" } },
        {
          tenant_slug: "agents-generation",
          system_name: "RAAS_System",
          connection_url_env: "RAAS_TEST_URL",
          statement_catalog_env: "RAAS_WRITE_STATEMENTS",
          allowed_operations: ["candidate.upsert"],
        },
        {
          env: {
            RAAS_TEST_URL: "postgres://user:pass@db.test:5432/raas",
            RAAS_WRITE_STATEMENTS: JSON.stringify({
              "candidate.upsert": {
                sql: "UPDATE candidate SET updated_at = NOW() WHERE candidate_id = $1",
                params: ["candidate_id"],
                mode: "write",
              },
            }),
          },
          poolFactory: () => {
            throw new Error("write query must be rejected before connecting");
          },
        },
      ),
    ).rejects.toThrow(/requires trusted config\.allow_write=true/);
  });

  it("read-only preflight binds RAAS fact lookup without reintroducing a business-decision tool", async () => {
    publishRuntimeTenantRegistrySnapshot({
      tenantSlug: "agents-generation",
      selectedVersion: "0.1.0",
      registry: agentsGenerationRegistry,
    });
    const executionTools = await currentFactoryExecutionTools({
      tenantId,
      tenantSlug: "agents-generation",
      tenantVersion: "0.1.0",
      domainId: domain,
    });
    expect(
      executionTools.find((tool) => tool.name === "ontology.query"),
    ).toMatchObject({
      operation: "read",
      effectScope: "external",
      capabilities: [
        expect.objectContaining({
          systems: expect.arrayContaining(["Allmeta_Ontology_System"]),
          kinds: expect.arrayContaining(["graph_db"]),
          roles: expect.arrayContaining(["read"]),
          operations: expect.arrayContaining(["query", "graph.verify"]),
          objectTypes: ["*"],
        }),
      ],
      catalogDefinition: {
        capabilities: [
          expect.objectContaining({
            systems: expect.arrayContaining(["Allmeta_Ontology_System"]),
            kinds: expect.arrayContaining(["graph_db"]),
          }),
        ],
      },
    });
    const factTools = executionTools.filter(
      (tool) => tool.name === "facts.query",
    );
    expect(factTools).toHaveLength(1);

    const ontology: DomainOntology = {
      domainId: domain,
      source: "allmeta",
      objects: [
        {
          id: "Candidate",
          name: "Candidate",
          primary_key: "candidate_id",
          properties: [{ name: "candidate_id", type: "String" }],
        },
      ],
      rules: [],
      actions: [
        {
          id: "candidate-identity",
          name: "resolveCandidateIdentity",
          actor: ["Agent"],
          trigger: ["CANDIDATE_IDENTITY_REQUESTED"],
          triggered_event: ["CANDIDATE_IDENTITY_CHECKED"],
          target_objects: ["Candidate"],
          tool_use: [],
          system_prompt: "Load facts, then evaluate linked ontology rules.",
          user_prompt: "Use the event candidate facts.",
          inputs: [],
          outputs: [],
          side_effects: {
            notifications: [{ triggered_event: "CANDIDATE_IDENTITY_CHECKED" }],
          },
          integration: {
            systems: [
              {
                name: "RAAS_System",
                kind: "database",
                role: "lookup",
                capability: "candidate.identity_facts.query",
                objects: ["Candidate"],
              },
            ],
          },
        },
      ],
      events: [
        {
          name: "CANDIDATE_IDENTITY_REQUESTED",
          payload: {
            source_action: "humanUpload",
            event_data: [],
            state_mutations: [],
          },
        },
        {
          name: "CANDIDATE_IDENTITY_CHECKED",
          payload: {
            source_action: "resolveCandidateIdentity",
            event_data: [],
            state_mutations: [],
          },
        },
      ],
      workflow: [],
    };
    const report = summarizeFactoryDomainPreflight({
      scope: {
        tenantId,
        tenantSlug: "agents-generation",
        domain,
      },
      ontology,
      globalTools: factTools,
      declarativeTools: [],
      runtimeProviders: [],
      envPresence: {},
    });
    expect(report.integrationBindings.counts.missing).toBe(0);
    expect(report.integrationBindings.groups.tool).toMatchObject([
      {
        bindingId: "facts.query",
        status: "needs_config",
      },
    ]);
    expect(
      report.integrationBindings.groups.tool.some(
        (binding) => binding.bindingId === "candidateDedupLookup",
      ),
    ).toBe(false);
  });

  it("loads the selected registry snapshot for standalone read-only preflight", async () => {
    const snapshot =
      await ensureTenantRegistrySnapshotForReadOnlyPreflight(
        "agents-generation",
      );
    expect(snapshot).toMatchObject({
      tenantSlug: "agents-generation",
      selectedVersion: "0.1.0",
    });
    expect(snapshot?.registry.tools?.["facts.query"]).toBeDefined();
    expect(snapshot?.registry.tools?.candidateDedupLookup).toBeUndefined();
  });

  it("advertises the host reason and durable agent-invoke primitives as runtime capabilities", async () => {
    const providers = await makeFactoryPorts(
      slug,
      "tenant-native-test-id",
      "Agents-generation",
    ).integrationCapabilities!.list();
    const action = (system: Record<string, unknown>): OntologyAction => ({
      id: "runtime-action",
      name: "runtimeAction",
      actor: ["Agent"],
      trigger: [],
      triggered_event: [],
      target_objects: [],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
      integration: { systems: [system] },
    });

    expect(
      resolveIntegrationBindings(
        action({
          name: "LLM_Gateway",
          kind: "llm",
          role: "execute",
          objects: ["Candidate"],
        }),
        [],
        { capabilityProviders: providers },
      ).bindings[0],
    ).toMatchObject({
      bindingKind: "runtime",
      bindingId: "agent-runtime.reason",
    });
    for (const capability of [
      "rules.judge — Prompt Compiler 编译后逐条判定",
      "field.semantic_equivalence — 模糊身份字段语义等价判定",
    ]) {
      expect(
        resolveIntegrationBindings(
          action({
            name: "LLM_Gateway",
            kind: "llm",
            role: "execute",
            capability,
            objects: ["Candidate"],
          }),
          [],
          { capabilityProviders: providers },
        ).bindings[0],
      ).toMatchObject({
        bindingKind: "runtime",
        bindingId: "agent-runtime.reason",
      });
    }
    expect(
      resolveIntegrationBindings(
        action({
          name: "AO_Internal",
          kind: "internal_invoke",
          role: "execute",
          objects: ["Candidate", "Candidate_Identity_Result"],
        }),
        [],
        { capabilityProviders: providers },
      ).bindings[0],
    ).toMatchObject({
      bindingKind: "runtime",
      bindingId: "agent-runtime.invoke",
      status: "resolved",
    });
  });
});
