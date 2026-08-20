import { describe, expect, it } from "vitest";
import type { OntologyAction } from "./ontology-types";
import type { RealTool } from "./tool-catalog";
import { applyIntegrationHumanBoundaries, deriveIntegrationRequirements, resolveIntegrationBindings } from "./integration-binding";
import { declarativeToolDefinitionHash } from "./declarative-tool-hash";
import { catalogToolDefinitionHash } from "./declarative-tool-hash";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
} from "./integration-profile-authorization";
import type { IntegrationProfile } from "./integration-profile";

const writeProbeSafety = {
  testDataContract: {
    kind: "synthetic_canary" as const,
    marker: { kind: "argument" as const, path: "probe.marker", valuePrefix: "factory-canary-" },
  },
  idempotency: { kind: "argument" as const, path: "probe.idempotency_key", valuePrefix: "factory-idem-" },
  isolation: {
    namespace: { kind: "argument" as const, path: "probe.namespace", valuePrefix: "factory-ns-" },
    target: { kind: "argument" as const, path: "probe.target", valuePrefix: "factory-target-" },
  },
  cleanup: { kind: "handler" as const, handler: "probe.cleanupCanary" },
  absenceProof: { kind: "handler" as const, handler: "probe.readCanary" },
};

const action: OntologyAction = {
  id: "resume",
  name: "processResume",
  actor: ["Agent"],
  trigger: [],
  triggered_event: [],
  target_objects: ["Resume"],
  tool_use: [],
  system_prompt: "",
  user_prompt: "",
  integration: {
    systems: [
      { name: "RoboHire", kind: "external_api", role: "calls", capability: "POST /parse-resume", objects: ["Resume"] },
      { name: "Partner PG", kind: "datastore", role: "writes", objects: ["Resume", "Candidate"] },
    ],
  },
};

const tools: RealTool[] = [
  {
    name: "matchResumeApi",
    capabilities: [{ systems: ["RoboHire"], kinds: ["external_api"], roles: ["calls"], operations: ["match-resume"], objectTypes: ["Resume"], probeRequired: true }],
  },
  {
    name: "parseResumeApi",
    credentialEnv: ["ROBO_KEY"],
    probeStatus: "verified",
    capabilities: [{ systems: ["RoboHire"], kinds: ["external_api"], roles: ["calls"], operations: ["parse-resume"], objectTypes: ["Resume"], probeRequired: true }],
  },
  {
    name: "records.upsert",
    capabilities: [{ systems: ["local records"], kinds: ["datastore"], roles: ["writes"], objectTypes: ["Resume", "Candidate"] }],
  },
];

describe("integration bindings", () => {
  it("derives stable structured requirements", () => {
    expect(deriveIntegrationRequirements(action)).toEqual([
      expect.objectContaining({ id: "resume:integration:1", system: "RoboHire", kind: "external_api", role: "calls", objectTypes: ["Resume"], replayable: true }),
      expect.objectContaining({ id: "resume:integration:2", system: "Partner PG", kind: "datastore", role: "writes", objectTypes: ["Resume", "Candidate"], replayable: true }),
    ]);
  });

  it("uses namespaced graph operations to distinguish a rule reader from a generic graph query SDK", () => {
    const graphAction = {
      ...action,
      integration: {
        systems: [
          {
            name: "Allmeta_Ontology_System",
            kind: "graph_db",
            role: "read",
            capability:
              "rules.fetch — 拉取身份/查重现行规则补充审计依据",
            objects: ["Candidate_Identity_Result"],
          },
        ],
      },
    } satisfies OntologyAction;
    expect(deriveIntegrationRequirements(graphAction)[0]).toMatchObject({
      operations: ["rules.fetch"],
    });

    const ruleReader: RealTool = {
      name: "ontology.fetchActionRules",
      capabilities: [
        {
          systems: ["Allmeta_Ontology_System"],
          kinds: ["graph_db"],
          roles: ["read"],
          operations: ["rules.fetch", "rules.select"],
          objectTypes: ["*"],
        },
      ],
    };
    const genericGraphQuery: RealTool = {
      name: "ontology.query",
      capabilities: [
        {
          systems: ["Allmeta_Ontology_System"],
          kinds: ["graph_db"],
          roles: ["read"],
          operations: ["query", "search_nodes", "get_node"],
          objectTypes: ["*"],
        },
      ],
    };

    expect(
      resolveIntegrationBindings(graphAction, [
        genericGraphQuery,
        ruleReader,
      ]).bindings[0],
    ).toMatchObject({
      status: "resolved",
      toolName: "ontology.fetchActionRules",
    });
    expect(
      resolveIntegrationBindings(graphAction, [genericGraphQuery]).bindings[0],
    ).toMatchObject({ status: "missing" });
  });

  it("prefers complete compound-operation coverage over a partial rules-only match", () => {
    const compoundAction = {
      ...action,
      integration: {
        systems: [
          {
            name: "Allmeta_Ontology_System",
            kind: "graph_db",
            role: "read",
            capability:
              "rules.select + graph.verify — 选规则并核验图事实",
            objects: ["Candidate_Match_Result"],
          },
        ],
      },
    } satisfies OntologyAction;

    const report = resolveIntegrationBindings(compoundAction, [
      {
        name: "ontology.fetchActionRules",
        capabilities: [
          {
            systems: ["Allmeta_Ontology_System"],
            kinds: ["graph_db"],
            roles: ["read"],
            operations: ["rules.select"],
            objectTypes: ["*"],
          },
        ],
      },
      {
        name: "reasoning.evaluateRules",
        capabilities: [
          {
            systems: ["Allmeta_Ontology_System"],
            kinds: ["graph_db"],
            roles: ["read"],
            operations: ["rules.select", "graph.verify"],
            objectTypes: ["*"],
          },
        ],
      },
    ]);

    expect(report.bindings[0]).toMatchObject({
      status: "resolved",
      toolName: "reasoning.evaluateRules",
    });
    expect(report.bindings[0]?.selectionRequired).not.toBe(true);
  });

  it("joins a live default-off integration to its exact namespaced capability operation instead of ambiguous call order", () => {
    const liveAction = {
      ...action,
      action_steps: [
        {
          order: 5,
          step_id: "optional_ownership_lock_check",
          name: "optionalOwnershipLockCheck",
          type: "logic",
          condition: "LOCK_CHECK_ENABLED=1（默认关，关闭时跳过整步）",
          description: "查询内部招聘系统 RMHR 的归属锁。",
        },
        {
          order: 6,
          step_id: "persist_candidate_result",
          name: "persistCandidateResult",
          type: "tool",
          condition: "always",
        },
      ],
      integration: {
        systems: [
          {
            call_order: 6,
            name: "Internal_Recruitment_System",
            kind: "external_api",
            role: "execute",
            capability: "candidate.lock_check — RMHR 归属锁查询",
            objects: ["Candidate"],
          },
        ],
      },
    } satisfies OntologyAction;

    expect(deriveIntegrationRequirements(liveAction)).toEqual([
      expect.objectContaining({
        id: "resume:integration:1",
        system: "Internal_Recruitment_System",
        authoringOptional: {
          reason: "disabled_by_default",
          source: "action_step.condition",
          evidence: "LOCK_CHECK_ENABLED=1（默认关，关闭时跳过整步）",
          stepId: "optional_ownership_lock_check",
        },
      }),
    ]);
  });

  it("requires exact declared capability instead of semantic name similarity", () => {
    const report = resolveIntegrationBindings(action, tools, { env: { ROBO_KEY: "secret" } });
    expect(report.bindings[0]).toMatchObject({ status: "resolved", toolName: "parseResumeApi" });
    expect(report.bindings[1]).toMatchObject({ status: "missing" });
    expect(report.ready).toBe(false);
  });

  it("allows a generic system only through an exact confirmed profile while kind and role still match", () => {
    const factAction = {
      ...action,
      integration: {
        systems: [
          {
            name: "RAAS_System",
            kind: "database",
            role: "reads",
            objects: ["Resume"],
          },
        ],
      },
    } satisfies OntologyAction;
    const genericFactTool: RealTool = {
      name: "facts.query",
      capabilities: [
        {
          systems: ["*"],
          systemConfigKey: "system_name",
          kinds: ["database"],
          roles: ["read", "reads"],
          objectTypes: ["*"],
        },
      ],
    };
    const config = { system_name: "RAAS_System" };
    const profile: IntegrationProfile = {
      id: "profile-facts-raas",
      tenantId: "tenant-agents-generation",
      profileKey: "facts-raas",
      toolName: genericFactTool.name,
      domainId: "Agents-generation",
      environment: "production",
      config,
      confirmedBy: "reviewer@example.test",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(genericFactTool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-13T00:00:00.000Z",
    };

    expect(
      resolveIntegrationBindings(factAction, [genericFactTool], {
        boundToolNames: ["facts.query"],
        toolProfiles: { "facts.query": profile },
        executionScope: {
          tenantId: "tenant-agents-generation",
          tenantSlug: "agents-generation",
          domainId: "Agents-generation",
        },
      }).bindings[0],
    ).toMatchObject({
      status: "resolved",
      toolName: "facts.query",
      genericSystemBinding: true,
    });
    expect(
      resolveIntegrationBindings(factAction, [genericFactTool], {
        boundToolNames: ["facts.query"],
      }).bindings[0],
    ).toMatchObject({ status: "needs_config", next: "ask_user" });
    expect(
      resolveIntegrationBindings(
        {
          ...factAction,
          integration: {
            systems: [
              {
                name: "RAAS_System",
                kind: "external_api",
                role: "reads",
                objects: ["Resume"],
              },
            ],
          },
        },
        [genericFactTool],
        { boundToolNames: ["facts.query"] },
      ).bindings[0],
    ).toMatchObject({ status: "missing" });
  });

  it("does not let one generic-tool profile impersonate multiple ontology systems", () => {
    const multiSystemAction = {
      ...action,
      integration: {
        systems: [
          { name: "Applicant_DB", kind: "database", role: "reads", objects: ["Resume"] },
          { name: "Requirement_DB", kind: "database", role: "reads", objects: ["Candidate"] },
        ],
      },
    } satisfies OntologyAction;
    const genericFactTool: RealTool = {
      name: "facts.query",
      capabilities: [{
        systems: ["*"],
        systemConfigKey: "system_name",
        kinds: ["database"],
        roles: ["reads"],
        objectTypes: ["*"],
      }],
    };
    const config = { system_name: "Applicant_DB" };
    const profile: IntegrationProfile = {
      id: "profile-facts-shared",
      tenantId: "tenant-agents-generation",
      profileKey: "facts-shared",
      toolName: genericFactTool.name,
      domainId: "Agents-generation",
      environment: "production",
      config,
      confirmedBy: "reviewer@example.test",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(genericFactTool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-13T00:00:00.000Z",
    };
    const report = resolveIntegrationBindings(multiSystemAction, [genericFactTool], {
      boundToolNames: [genericFactTool.name],
      toolProfiles: { [genericFactTool.name]: profile },
      executionScope: {
        tenantId: "tenant-agents-generation",
        tenantSlug: "agents-generation",
        domainId: "Agents-generation",
      },
    });

    expect(report.ready).toBe(false);
    expect(report.bindings).toHaveLength(2);
    expect(report.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "resolved" }),
      expect.objectContaining({
        status: "needs_config",
        next: "ask_user",
        invalidConfigKeys: ["system_name"],
        reason: expect.stringContaining("Requirement_DB"),
      }),
    ]));
  });

  it("binds a resolved capability to the exact generated plan step", () => {
    const resolved = resolveIntegrationBindings(action, tools, {
      boundToolNames: ["parseResumeApi"],
      env: { ROBO_KEY: "secret" },
      plan: [{ stepId: "parse-resume", kind: "tool", tool: "parseResumeApi" }],
    });
    expect(resolved.bindings[0]).toMatchObject({
      status: "resolved",
      executionRef: {
        kind: "tool",
        toolName: "parseResumeApi",
        planStepIds: ["parse-resume"],
      },
    });

    const unrelated = resolveIntegrationBindings(action, tools, {
      boundToolNames: ["parseResumeApi"],
      env: { ROBO_KEY: "secret" },
      plan: [{ stepId: "unrelated", kind: "tool", tool: "matchResumeApi" }],
    });
    expect(unrelated.bindings[0]).toMatchObject({
      status: "missing",
      next: "ask_user",
    });
    expect(unrelated.bindings[0]?.reason).toContain("plan");
  });

  it("distinguishes missing config and missing probe", () => {
    expect(resolveIntegrationBindings(action, tools, { env: {} }).bindings[0]).toMatchObject({ status: "needs_config" });
    const unprobed = tools.map((tool) => tool.name === "parseResumeApi" ? { ...tool, probeStatus: "required" as const } : tool);
    expect(resolveIntegrationBindings(action, unprobed, { env: { ROBO_KEY: "secret" } }).bindings[0]).toMatchObject({ status: "needs_probe" });
  });

  it("can validate only the tools actually selected by a spec", () => {
    const report = resolveIntegrationBindings(action, tools, { boundToolNames: ["records.upsert"], env: { ROBO_KEY: "secret" } });
    expect(report.bindings[0]!.status).toBe("missing");
  });

  it("does not pick the alphabetically first tool/provider when top capability scores tie", () => {
    const lookupAction = {
      ...action,
      integration: {
        systems: [{ name: "Directory", kind: "external_api", role: "reads", objects: ["Resume"] }],
      },
    } satisfies OntologyAction;
    const capability = {
      systems: ["Directory"],
      kinds: ["external_api"],
      roles: ["reads"],
      objectTypes: ["Resume"],
    };
    const alpha: RealTool = { name: "directory.alpha", capabilities: [capability] };
    const beta: RealTool = { name: "directory.beta", capabilities: [capability] };
    const provider = { id: "runtime.directory", status: "available" as const, capabilities: [capability] };

    const ambiguous = resolveIntegrationBindings(lookupAction, [alpha, beta], {
      capabilityProviders: [provider],
    });
    expect(ambiguous).toMatchObject({ ready: false, counts: { missing: 1 } });
    expect(ambiguous.bindings[0]).toMatchObject({
      status: "missing",
      selectionRequired: true,
      selectionCandidates: [
        { bindingKind: "runtime", bindingId: "runtime.directory", score: 105 },
        { bindingKind: "tool", bindingId: "directory.alpha", toolName: "directory.alpha", score: 105 },
        { bindingKind: "tool", bindingId: "directory.beta", toolName: "directory.beta", score: 105 },
      ],
    });

    const explicitlyBound = resolveIntegrationBindings(lookupAction, [alpha, beta], {
      boundToolNames: ["directory.beta"],
      capabilityProviders: [provider],
    });
    expect(explicitlyBound.bindings[0]).toMatchObject({
      status: "resolved",
      toolName: "directory.beta",
    });

    const humanSelected = resolveIntegrationBindings(
      lookupAction,
      [alpha, beta],
      {
        capabilityProviders: [provider],
        bindingSelections: [
          {
            actionName: lookupAction.name,
            requirementId: "resume:integration:1",
            bindingKind: "tool",
            bindingId: "directory.beta",
          },
        ],
      },
    );
    expect(humanSelected.bindings[0]).toMatchObject({
      status: "resolved",
      toolName: "directory.beta",
    });
  });

  it("treats via_tool and action_step_id as exact fail-closed constraints", () => {
    const capability = {
      systems: ["Directory"],
      kinds: ["external_api"],
      roles: ["reads"],
      objectTypes: ["Resume"],
    };
    const alpha: RealTool = {
      name: "directory.alpha",
      capabilities: [capability],
    };
    const beta: RealTool = {
      name: "directory.beta",
      capabilities: [capability],
    };
    const constrained = {
      ...action,
      action_steps: [
        {
          step_id: "directory_read",
          type: "tool",
          tool: "directory.beta",
        },
      ],
      integration: {
        systems: [
          {
            name: "Directory",
            kind: "external_api",
            role: "reads",
            objects: ["Resume"],
            via_tool: "directory.beta",
            action_step_id: "directory_read",
          },
        ],
      },
    } satisfies OntologyAction;

    expect(deriveIntegrationRequirements(constrained)[0]).toMatchObject({
      toolBindingConstraint: {
        viaTool: "directory.beta",
        actionStepId: "directory_read",
        actionStepTool: "directory.beta",
      },
    });
    expect(
      resolveIntegrationBindings(constrained, [alpha, beta]).bindings[0],
    ).toMatchObject({
      status: "resolved",
      toolName: "directory.beta",
    });

    const pointerOnly = structuredClone(constrained);
    delete (
      (pointerOnly.integration!.systems as Array<Record<string, unknown>>)[0]!
    ).via_tool;
    expect(
      resolveIntegrationBindings(pointerOnly, [alpha, beta]).bindings[0],
    ).toMatchObject({ status: "resolved", toolName: "directory.beta" });

    const unknown = structuredClone(constrained);
    (
      (unknown.integration!.systems as Array<Record<string, unknown>>)[0]!
    ).via_tool = "directory.unknown";
    expect(
      resolveIntegrationBindings(unknown, [alpha, beta]).bindings[0],
    ).toMatchObject({ status: "missing" });

    const mismatch = structuredClone(constrained);
    (
      (mismatch.integration!.systems as Array<Record<string, unknown>>)[0]!
    ).via_tool = "directory.alpha";
    expect(
      resolveIntegrationBindings(mismatch, [alpha, beta]).bindings[0],
    ).toMatchObject({ status: "missing" });

    const wrongCapability: RealTool = {
      name: "directory.beta",
      capabilities: [
        {
          ...capability,
          systems: ["OtherDirectory"],
        },
      ],
    };
    expect(
      resolveIntegrationBindings(constrained, [alpha, wrongCapability])
        .bindings[0],
    ).toMatchObject({ status: "missing" });
  });

  it("invalidates declarative probe evidence when selected config changes", () => {
    const definition = {
      name: "vendor.parse",
      method: "POST",
      urlTemplate: "https://api.example.com/parse",
      sideEffect: "read",
      operation: "read" as const,
      effectScope: "external" as const,
      sandboxPolicy: "live_external" as const,
      capabilities: [{ systems: ["RoboHire"], kinds: ["external_api"], roles: ["calls"], operations: ["parse-resume"], objectTypes: ["Resume"], probeRequired: true }],
    };
    const probedConfig = { api_key_env: "KEY_A" };
    const tool: RealTool = {
      name: definition.name,
      probeStatus: "verified",
      capabilities: definition.capabilities,
      declarativeDefinition: definition,
      definitionHash: declarativeToolDefinitionHash(definition, probedConfig, { KEY_A: "secret-a" }),
    };
    expect(resolveIntegrationBindings(action, [tool], { boundToolNames: [tool.name], toolConfigs: probedConfig && { [tool.name]: probedConfig }, env: { KEY_A: "secret-a" } }).bindings[0]).toMatchObject({ status: "resolved" });
    expect(resolveIntegrationBindings(action, [tool], { boundToolNames: [tool.name], toolConfigs: { [tool.name]: { api_key_env: "KEY_B" } }, env: { KEY_B: "secret-b" } }).bindings[0]).toMatchObject({ status: "needs_probe" });
  });

  it("resolves two verified Allmeta configs for ontology.writeInstance and rejects an unprobed hash", () => {
    const allmetaAction = (name: string, objectType: string): OntologyAction => ({
      id: name,
      name,
      actor: ["Agent"],
      trigger: [],
      triggered_event: [],
      target_objects: [objectType],
      tool_use: ["ontology.writeInstance"],
      system_prompt: "",
      user_prompt: "",
      integration: {
        systems: [{ name: "Allmeta", kind: "ontology", role: "writes", objects: [objectType] }],
      },
    });
    const capabilities = [{
      systems: ["Allmeta", "AllmetaOntology"],
      kinds: ["ontology", "datastore"],
      roles: ["write", "writes"],
      objectTypes: ["*"],
      probeRequired: true,
    }];
    const catalogDefinition = {
      name: "ontology.writeInstance",
      category: "ontology",
      sourcePath: "packages/tools/src/ontology/write-instance.ts",
      sideEffect: "write",
      probeSafety: writeProbeSafety,
      configSchema: {
        base_url_env: { type: "string", required: true },
        api_key_env: { type: "string", required: true },
        domain: { type: "string", required: true },
        action: { type: "string", required: true },
        allowed_objects: { type: "string[]", required: true },
      },
      capabilities,
    };
    const candidateConfig = {
      base_url_env: "ALLMETA_BASE_URL",
      api_key_env: "ALLMETA_API_KEY",
      domain: "RAAS-v1",
      action: "processResume",
      allowed_objects: ["Candidate", "Resume"],
    };
    const jobConfig = {
      base_url_env: "ALLMETA_BASE_URL",
      api_key_env: "ALLMETA_API_KEY",
      domain: "RAAS-v1",
      action: "createJD",
      allowed_objects: ["Job_Posting"],
    };
    const staleConfig = {
      ...jobConfig,
      action: "inviteInterview",
      allowed_objects: ["Interview"],
    };
    const env = {
      ALLMETA_BASE_URL: "https://allmeta.example.test",
      ALLMETA_API_KEY: "tenant-secret",
    };
    const candidateHash = catalogToolDefinitionHash(catalogDefinition, candidateConfig, env);
    const jobHash = catalogToolDefinitionHash(catalogDefinition, jobConfig, env);
    const tool: RealTool = {
      name: catalogDefinition.name,
      sideEffect: "write",
      capabilities,
      catalogDefinition,
      probeStatus: "verified",
      definitionHash: candidateHash,
      verifiedDefinitionHashes: [candidateHash, jobHash],
    };
    const resolve = (ontologyAction: OntologyAction, config: Record<string, unknown>) =>
      resolveIntegrationBindings(ontologyAction, [tool], {
        boundToolNames: [tool.name],
        toolConfigs: { [tool.name]: config },
        env,
      }).bindings[0];

    expect(resolve(allmetaAction("processResume", "Candidate"), candidateConfig)).toMatchObject({ status: "resolved" });
    expect(resolve(allmetaAction("createJD", "Job_Posting"), jobConfig)).toMatchObject({ status: "resolved" });
    expect(resolve(allmetaAction("inviteInterview", "Interview"), staleConfig)).toMatchObject({ status: "needs_probe" });
  });

  it("rejects a confirmed rule profile when it is reused by a different ontology Action", () => {
    const actionFor = (name: string): OntologyAction => ({
      id: name,
      name,
      actor: ["Agent"],
      trigger: [],
      triggered_event: [],
      target_objects: ["Rule"],
      tool_use: ["ontology.fetchActionRules"],
      system_prompt: "",
      user_prompt: "",
      integration: {
        systems: [{ name: "Allmeta", kind: "rulebase", role: "reads", objects: ["Rule"] }],
      },
    });
    const config = {
      base_url_env: "RULES_URL",
      api_key_env: "RULES_KEY",
      domain: "RAAS-v1",
      action: "ruleCheckForMatchResume",
    };
    const tool: RealTool = {
      name: "ontology.fetchActionRules",
      catalogDefinition: {
        name: "ontology.fetchActionRules",
        configSchema: {
          base_url_env: { type: "string", required: true },
          api_key_env: { type: "string", required: true },
          domain: { type: "string", required: true },
          action: { type: "string", required: true },
        },
        profileScope: {
          exact: [
            { configKey: "domain", source: "domain" },
            { configKey: "action", source: "action" },
          ],
        },
      },
      capabilities: [{
        systems: ["Allmeta"],
        kinds: ["rulebase"],
        roles: ["reads"],
        objectTypes: ["Rule"],
      }],
    };
    const profile: IntegrationProfile = {
      id: "profile-match-rules",
      tenantId: "tenant-raas",
      profileKey: "match-rules",
      toolName: tool.name,
      domainId: "RAAS-v1",
      environment: "production",
      config,
      confirmedBy: "reviewer@example.test",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-13T00:00:00.000Z",
    };
    const resolve = (ontologyAction: OntologyAction) => resolveIntegrationBindings(
      ontologyAction,
      [tool],
      {
        boundToolNames: [tool.name],
        toolConfigs: { [tool.name]: config },
        toolProfiles: { [tool.name]: profile },
        executionScope: {
          tenantId: "tenant-raas",
          tenantSlug: "raas",
          domainId: "RAAS-v1",
        },
        env: { RULES_URL: "https://allmeta.example.test", RULES_KEY: "secret" },
      },
    );

    expect(resolve(actionFor("ruleCheckForMatchResume")).bindings[0]).toMatchObject({ status: "resolved" });
    expect(resolve(actionFor("ruleCheckForInterviewInvitation")).bindings[0]).toMatchObject({
      status: "needs_config",
      reason: expect.stringContaining("action scope"),
    });
  });

  it("binds a PostgreSQL adapter only when its capability metadata explicitly declares the ontology system", () => {
    const catalogDefinition = {
      name: "postgres.executeStatement",
      category: "postgres",
      sideEffect: "dual",
      probeSafety: writeProbeSafety,
      configSchema: {
        connection_url_env: { type: "string", required: true },
        statement_catalog_env: { type: "string", required: true },
      },
      capabilities: [],
    };
    const config = {
      connection_url_env: "TENANT_PG_URL",
      statement_catalog_env: "TENANT_PG_STATEMENTS",
    };
    const env = { TENANT_PG_URL: "postgres://example/db", TENANT_PG_STATEMENTS: "{}" };
    const postgres: RealTool = {
      name: "postgres.executeStatement",
      sideEffect: "dual",
      probeStatus: "verified",
      capabilities: [{ systems: ["PostgreSQL", "Partner PG"], kinds: ["datastore"], roles: ["writes"], objectTypes: ["*"], probeRequired: true }],
      catalogDefinition,
      definitionHash: catalogToolDefinitionHash(catalogDefinition, config, env),
    };

    const report = resolveIntegrationBindings(action, [postgres], {
      boundToolNames: [postgres.name],
      toolConfigs: { [postgres.name]: config },
      env,
    });
    expect(report.bindings[1]).toMatchObject({ status: "resolved", toolName: postgres.name });
  });

  it("ignores a historical verified receipt when a write tool lacks the complete canary cleanup contract", () => {
    const config = {
      connection_url_env: "TENANT_PG_URL",
      statement_catalog_env: "TENANT_PG_STATEMENTS",
    };
    const env = { TENANT_PG_URL: "postgres://example/db", TENANT_PG_STATEMENTS: "{}" };
    const catalogDefinition = {
      name: "postgres.executeStatement",
      category: "postgres",
      sideEffect: "dual",
      configSchema: {
        connection_url_env: { type: "string", required: true },
        statement_catalog_env: { type: "string", required: true },
      },
    };
    const definitionHash = catalogToolDefinitionHash(catalogDefinition, config, env);
    const postgres: RealTool = {
      name: catalogDefinition.name,
      sideEffect: "dual",
      probeStatus: "verified",
      definitionHash,
      verifiedDefinitionHashes: [definitionHash],
      capabilities: [{ systems: ["Partner PG"], kinds: ["datastore"], roles: ["writes"], objectTypes: ["*"], probeRequired: true }],
      catalogDefinition,
    };
    const binding = resolveIntegrationBindings(action, [postgres], {
      boundToolNames: [postgres.name],
      toolConfigs: { [postgres.name]: config },
      env,
    }).bindings[1];
    expect(binding).toMatchObject({
      status: "needs_config",
      next: "ask_user",
      missingSafety: expect.arrayContaining(["test_data_contract", "idempotency_key", "cleanup", "absence_readback"]),
    });
  });

  it("requires every explicitly selected env reference and required catalog config", () => {
    const catalogDefinition = {
      name: "postgres.executeStatement",
      configSchema: {
        connection_url_env: { type: "string", required: true },
        statement_catalog_env: { type: "string", required: true },
      },
    };
    const postgres: RealTool = {
      name: "postgres.executeStatement",
      probeStatus: "verified",
      capabilities: [{ systems: ["Postgres", "Partner PG"], kinds: ["datastore"], roles: ["writes"], objectTypes: ["*"], probeRequired: true }],
      catalogDefinition,
    };
    expect(resolveIntegrationBindings(action, [postgres], {
      boundToolNames: [postgres.name],
      toolConfigs: { [postgres.name]: { connection_url_env: "PG_URL" } },
      env: { PG_URL: "postgres://example/db" },
    }).bindings[1]).toMatchObject({
      status: "needs_config",
      missingConfigKeys: ["statement_catalog_env"],
    });

    expect(resolveIntegrationBindings(action, [postgres], {
      boundToolNames: [postgres.name],
      toolConfigs: { [postgres.name]: { connection_url_env: "PG_URL", statement_catalog_env: "PG_STATEMENTS" } },
      env: { PG_URL: "postgres://example/db" },
    }).bindings[1]).toMatchObject({
      status: "needs_config",
      missingCredentialEnv: ["PG_STATEMENTS"],
    });
  });

  it("binds an S3-compatible adapter only through an explicitly declared system alias", () => {
    const s3Action = {
      ...action,
      integration: { systems: [{ name: "AWS S3 compatible archive", kind: "object_store", role: "reads", objects: ["Resume"] }] },
    } satisfies OntologyAction;
    const objectStore: RealTool = {
      name: "objectStore.getObject",
      probeStatus: "verified",
      capabilities: [{ systems: ["MinIO", "AWS S3 compatible archive"], kinds: ["object_store"], roles: ["reads"], objectTypes: ["*"], probeRequired: false }],
    };
    expect(resolveIntegrationBindings(s3Action, [objectStore]).bindings[0]).toMatchObject({ status: "resolved" });
  });

  it("binds an explicit notification boundary to its ontology event, not a fake notification tool", () => {
    const notificationAction = {
      ...action,
      triggered_event: ["JD_GENERATED"],
      side_effects: { notifications: [{ triggered_event: "JD_GENERATED" }] },
      integration: { systems: [{ name: "RAAS", kind: "event_bus", role: "notifies", objects: ["Job"] }] },
    } satisfies OntologyAction;
    const [requirement] = deriveIntegrationRequirements(notificationAction);
    expect(requirement?.eventNames).toEqual(["JD_GENERATED"]);
    expect(resolveIntegrationBindings(notificationAction, [])).toMatchObject({
      ready: true,
      bindings: [{ bindingKind: "event", bindingId: "JD_GENERATED", status: "resolved" }],
    });
  });

  it("keeps an event-shaped integration missing when the ontology omitted its exact event", () => {
    const incompleteNotification = {
      ...action,
      integration: { systems: [{ name: "RAAS", kind: "event_bus", role: "notifies" }] },
    } satisfies OntologyAction;
    expect(resolveIntegrationBindings(incompleteNotification, []).bindings[0]).toMatchObject({
      bindingKind: "event",
      status: "missing",
    });
  });

  it("binds LLM work to an injected runtime provider and fails closed when it is unconfigured", () => {
    const llmAction = {
      ...action,
      integration: { systems: [{ name: "LLM Gateway", kind: "external_api", role: "calls", objects: ["Resume"] }] },
    } satisfies OntologyAction;
    const capabilities = [{
      systems: ["LLM Gateway"],
      kinds: ["external_api"],
      roles: ["calls"],
      objectTypes: ["*"],
    }];
    expect(resolveIntegrationBindings(llmAction, [], {
      capabilityProviders: [{ id: "agent-runtime.reason", status: "available", capabilities }],
    }).bindings[0]).toMatchObject({
      bindingKind: "runtime",
      bindingId: "agent-runtime.reason",
      status: "resolved",
    });
    expect(resolveIntegrationBindings(llmAction, [], {
      capabilityProviders: [{ id: "agent-runtime.reason", status: "needs_config", reason: "missing model", capabilities }],
    }).bindings[0]).toMatchObject({ bindingKind: "runtime", status: "needs_config" });
  });
});

describe("system profile alias groups (外部系统档案)", () => {
  const raasAction: OntologyAction = {
    ...action,
    id: "createjd",
    name: "createJD",
    integration: {
      systems: [
        { name: "RAAS_System", kind: "external_api", role: "calls", capability: "POST /parse-resume", objects: ["Resume"] },
      ],
    },
  };

  it("stays fail-closed without alias groups (exact-label only)", () => {
    const report = resolveIntegrationBindings(raasAction, tools, {});
    expect(report.bindings[0]).toMatchObject({ status: "missing" });
  });

  it("cross-binds through one confirmed alias group", () => {
    const report = resolveIntegrationBindings(raasAction, tools, {
      systemAliasGroups: [["raas-platform", "RAAS_System", "RoboHire"]],
    });
    const binding = report.bindings[0]!;
    expect(binding.toolName).toBe("parseResumeApi");
    expect(binding.status).not.toBe("missing");
  });

  it("never cross-binds names that sit in different groups", () => {
    const report = resolveIntegrationBindings(raasAction, tools, {
      systemAliasGroups: [
        ["RAAS_System", "Internal_HR"],
        ["RoboHire", "GoHire"],
      ],
    });
    expect(report.bindings[0]).toMatchObject({ status: "missing" });
  });
});

describe("A3 profile-seeded human boundaries", () => {
  const boundary = (system: string) => ({ system, mode: "all", actor: "system-profile", confirmedAt: 1 });

  it("flips an identity-gap binding to human_boundary when the profile marks the system", () => {
    const gap = {
      requirement: { id: "r1", actionName: "createJD", system: "Internal_Recruitment_System", kind: "external_api", role: "calls", operations: [], objectTypes: [], replayable: true },
      status: "missing" as const,
      reason: "no candidate",
    };
    const out = applyIntegrationHumanBoundaries([gap], [boundary("Internal_Recruitment_System")]);
    expect(out[0]!.status).toBe("human_boundary");
    expect(out[0]!.humanBoundary?.actor).toBe("system-profile");
  });

  it("does NOT touch a binding that already has a tool (not an identity gap)", () => {
    const bound = {
      requirement: { id: "r2", actionName: "matchResume", system: "GoHire_System", kind: "external_api", role: "calls", operations: [], objectTypes: [], replayable: true },
      status: "needs_config" as const,
      toolName: "gohireMatchResumeApi",
      bindingId: "gohireMatchResumeApi",
      reason: "missing key",
    };
    const out = applyIntegrationHumanBoundaries([bound], [boundary("GoHire_System")]);
    expect(out[0]!.status).toBe("needs_config"); // untouched — a real tool exists
  });
})
