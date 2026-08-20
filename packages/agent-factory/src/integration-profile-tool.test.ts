import { describe, expect, it, vi } from "vitest";
import { catalogToolDefinitionHash } from "./declarative-tool-hash";
import type { BrainCtx } from "./brain-types";
import type { IntegrationProfile } from "./integration-profile";
import {
  type FactoryAuthorizationChallenge,
  type FactoryAuthorizationChallengeStore,
} from "./authorization-challenge";
import {
  integrationProfileConfigDigest,
  INTEGRATION_PROFILE_AUTHORIZATION_CONTEXT_PREFIX,
  INTEGRATION_PROFILE_AUTHORIZATION_DECLINE_PREFIX,
  INTEGRATION_PROFILE_AUTHORIZATION_PREFIX,
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  integrationProfileToolDefinitionDigest,
} from "./integration-profile-authorization";
import type { DomainOntology } from "./ontology-types";
import type { RealTool } from "./tool-catalog";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";

const confirmProfile = FACTORY_TOOLS.find((tool) => tool.name === "confirm_integration_profile")!;
const designAgent = FACTORY_TOOLS.find((tool) => tool.name === "design_agent")!;

function fixture() {
  const config = { region: "cn" };
  const capabilities = [{
    systems: ["Vendor"],
    kinds: ["external_api"],
    roles: ["reads"],
    operations: ["lookup"],
    objectTypes: ["Work"],
    probeRequired: true,
  }];
  const catalogDefinition = {
    name: "vendor.lookup",
    category: "vendor",
    sideEffect: "read",
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
    argsSchema: { work_id: { type: "string", required: true } },
    returnsSchema: { result: { type: "string", required: true } },
    configSchema: { region: { type: "string", required: true } },
    capabilities,
  };
  const profiles: IntegrationProfile[] = [];
  const tool: RealTool = {
    name: catalogDefinition.name,
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    catalogDefinition,
    capabilities,
    verifiedDefinitionHashes: [catalogToolDefinitionHash(catalogDefinition, config, {})],
  };
  const ontology: DomainOntology = {
    domainId: "test-domain",
    source: "allmeta",
    objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
    rules: [],
    events: [
      { name: "WORK_REQUESTED", payload: { source_action: null, event_data: [{ name: "work_id", type: "String", target_object: "Work" }], state_mutations: [] } },
      { name: "WORK_DONE", payload: { source_action: "doWork", event_data: [{ name: "result", type: "String", target_object: "Work" }], state_mutations: [{ target_object: "Work", mutation_type: "MODIFY", impacted_properties: ["result"] }] } },
    ],
    actions: [{
      id: "do-work",
      name: "doWork",
      actor: ["Agent"],
      trigger: ["WORK_REQUESTED"],
      triggered_event: ["WORK_DONE"],
      target_objects: ["Work"],
      tool_use: [tool.name],
      system_prompt: "",
      user_prompt: "",
      inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" }],
      outputs: [{ name: "result", type: "String" }],
      action_steps: [{ id: "lookup", name: "lookup", type: "tool" }],
      integration: { systems: [{ name: "Vendor", kind: "external_api", role: "reads", capability: "GET /lookup", objects: ["Work"] }] },
    }],
    workflow: [{ id: "flow" }],
  } as unknown as DomainOntology;
  const save = vi.fn(async (_domain: string, input: {
    profileKey: string;
    environment: "sandbox" | "production";
    tool: RealTool;
    config: Record<string, unknown>;
    authorization: { actor: string };
    execution: { runId: string; conversationId: string };
  }) => {
    const profile: IntegrationProfile = {
      id: `profile-${input.environment}`,
      profileKey: input.profileKey,
      toolName: input.tool.name,
      domainId: "test-domain",
      environment: input.environment,
      config: input.config,
      confirmedBy: input.authorization.actor,
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(input.tool),
      configDigest: integrationProfileConfigDigest(input.config),
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      confirmedAt: "2026-07-13T00:00:00.000Z",
    };
    const prior = profiles.findIndex((candidate) => candidate.profileKey === profile.profileKey && candidate.environment === profile.environment);
    if (prior >= 0) profiles.splice(prior, 1, profile);
    else profiles.push(profile);
    return profile;
  });
  let issued: FactoryAuthorizationChallenge | undefined;
  let consumed = false;
  const authorizationChallenges: FactoryAuthorizationChallengeStore = {
    issue: vi.fn(async (_domain, input) => {
      const digest = input.subjectDigest;
      consumed = false;
      const token = `${INTEGRATION_PROFILE_AUTHORIZATION_PREFIX}${digest}`;
      const challenge: FactoryAuthorizationChallenge = {
        id: "challenge-1",
        kind: input.kind,
        protocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
        digest,
        subjectDigest: input.subjectDigest,
        token,
        question: input.question,
        context: `${INTEGRATION_PROFILE_AUTHORIZATION_CONTEXT_PREFIX}${digest}`,
        options: [
          { label: input.declineLabel, value: `${INTEGRATION_PROFILE_AUTHORIZATION_DECLINE_PREFIX}${digest}`, recommended: true },
          { label: input.confirmLabel, value: token, recommended: false },
        ],
        runId: input.runId,
        conversationId: input.conversationId,
        expiresAt: "2099-07-13T00:15:00.000Z",
      };
      issued = challenge;
      return challenge;
    }),
    restore: vi.fn(async (_domain, input) => issued && !consumed && issued.id === input.id ? issued : null),
    consume: vi.fn(async (_domain, input) => {
      if (!issued || input.challenge.id !== issued.id || consumed) throw new Error("challenge invalid or consumed");
      consumed = true;
      return {
        challengeId: issued.id,
        kind: issued.kind,
        protocolVersion: issued.protocolVersion,
        digest: issued.digest,
        subjectDigest: issued.subjectDigest,
        authorizationDigest: "authorization-digest",
        actor: input.actor,
        runId: issued.runId,
        conversationId: issued.conversationId,
        consumedAt: "2026-07-13T00:00:00.000Z",
        expiresAt: issued.expiresAt,
      };
    }),
  };
  const ctx = {
    domain: "test-domain",
    goal: "build",
    conversationId: "conv-1",
    emit: () => {},
    specs: [],
    ontology,
    currentPlan: null,
    toolCatalog: [tool.name],
    realTools: [tool],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    priorReflections: [],
    humanDirectives: [],
    lastSandbox: null,
    lastValidation: null,
    budget: { maxTokens: null, maxTurns: 20 },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    askedQuestions: {},
    ports: {
      toolRegistry: { list: async () => [{ ...tool, integrationProfiles: [...profiles] }] },
      integrationProfiles: { save },
      authorizationChallenges,
    },
  } as unknown as BrainCtx;
  return { ctx, config, profiles, save, tool, authorizationChallenges };
}

const designInput = {
  action: "doWork",
  system_prompt: "按已确认的集成配置读取 Vendor，并只输出本体字段。",
  decision_logic: "读取成功 emit WORK_DONE；失败按错误策略终止。",
  tools: ["vendor.lookup"],
  plan: [{ stepId: "lookup", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
};

describe("confirm_integration_profile and design profile gate", () => {
  it("rejects direct tool_configs injection in design_agent", async () => {
    const { ctx } = fixture();
    const result = await designAgent.execute({
      ...designInput,
      tool_configs: { "vendor.lookup": { region: "cn" } },
    }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("tool_configs 已关闭");
    expect(ctx.specs).toHaveLength(0);
  });

  it("binds confirmation to one environment and requires separate sandbox/production profiles", async () => {
    const { ctx, config, save } = fixture();
    const request = { tool_name: "vendor.lookup", profile_key: "primary", environment: "production", config };
    const pending = await confirmProfile.execute(request, ctx);
    const authorization = pending.output as { review: string[] };
    const challenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    expect(pending.ok).toBe(true);
    expect(challenge.token).toMatch(/^authorize_integration_profile:v3:[a-f0-9]{64}$/);
    expect(challenge.context).toMatch(/^integration_profile_authorization:v3:[a-f0-9]{64}$/);
    expect(challenge.options.find((option) => option.value === challenge.token)?.recommended).toBe(false);
    expect(JSON.stringify(pending.output)).not.toContain(challenge.token);
    expect(authorization.review).toContain("region：cn");
    expect(save).not.toHaveBeenCalled();

    const unauthorized = await confirmProfile.execute({ ...request, confirmed: true }, ctx);
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.summary).toContain("用户确认");
    expect(save).not.toHaveBeenCalled();

    const changed = await confirmProfile.execute({ ...request, config: { region: "us" }, confirmed: true }, ctx);
    expect(changed.ok).toBe(false);
    expect(changed.summary).toContain("完全一致的服务端 challenge");
    expect(save).not.toHaveBeenCalled();

    const changedEnvironment = await confirmProfile.execute({ ...request, environment: "sandbox", confirmed: true }, ctx);
    expect(changedEnvironment.ok).toBe(false);
    expect(changedEnvironment.summary).toContain("完全一致的服务端 challenge");
    expect(save).not.toHaveBeenCalled();

    ctx.clarificationAnswerEvidence = {
      [normalizeQuestion(challenge.question)]: {
        question: challenge.question,
        context: challenge.context,
        options: challenge.options,
        answer: challenge.token,
        actor: "usr-human",
        answeredAt: Date.now(),
      },
    };
    const confirmed = await confirmProfile.execute({ ...request, confirmed: true }, ctx);
    expect(confirmed.ok).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("test-domain", expect.objectContaining({
      environment: "production",
      execution: { runId: "conv-1", conversationId: "conv-1" },
    }));
    expect(confirmed.output).toMatchObject({
      profile: { id: "profile-production", profileKey: "primary", environment: "production", confirmedBy: "usr-human" },
    });

    const replay = await confirmProfile.execute({ ...request, confirmed: true }, ctx);
    expect(replay.ok).toBe(false);
    expect(replay.summary).toContain("使用过");
    expect(save).toHaveBeenCalledOnce();

    const missingSandbox = await designAgent.execute({
      ...designInput,
      production_tool_profiles: { "vendor.lookup": "primary" },
    }, ctx);
    expect(missingSandbox.ok).toBe(true);
    expect(missingSandbox.output).toMatchObject({
      readiness: {
        schema: "agent-factory-execution-readiness/v1",
        authoringReady: true,
        sandboxReady: false,
        promotionReady: false,
        missingSandboxProfiles: ["vendor.lookup"],
        externalApis: [
          expect.objectContaining({
            tool: "vendor.lookup",
            systems: ["Vendor"],
            sandboxReady: false,
            promotionReady: false,
            missingSandboxProfile: true,
          }),
        ],
      },
    });
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.specs[0]?.generatedCode).toContain("export");
    expect(ctx.specs[0]?.executionReadiness).toMatchObject({
      authoringReady: true,
      sandboxReady: false,
      promotionReady: false,
      externalApis: [
        expect.objectContaining({
          tool: "vendor.lookup",
          systems: ["Vendor"],
        }),
      ],
    });

    const sandboxConfig = { region: "sandbox-cn" };
    const sandboxRequest = {
      tool_name: "vendor.lookup",
      profile_key: "primary",
      environment: "sandbox",
      config: sandboxConfig,
    };
    const sandboxPending = await confirmProfile.execute(sandboxRequest, ctx);
    expect(sandboxPending.ok).toBe(true);
    const sandboxChallenge = Object.values(ctx.pendingAuthorizationChallenges ?? {})[0]!;
    expect(sandboxChallenge.token).toMatch(/^authorize_integration_profile:v3:/);
    ctx.clarificationAnswerEvidence![normalizeQuestion(sandboxChallenge.question)] = {
      question: sandboxChallenge.question,
      context: sandboxChallenge.context,
      options: sandboxChallenge.options,
      answer: sandboxChallenge.token,
      actor: "usr-human",
      answeredAt: Date.now(),
    };
    const sandboxConfirmed = await confirmProfile.execute({ ...sandboxRequest, confirmed: true }, ctx);
    expect(sandboxConfirmed).toMatchObject({
      ok: true,
      output: { profile: { id: "profile-sandbox", environment: "sandbox" } },
    });

    const designed = await designAgent.execute({
      ...designInput,
      production_tool_profiles: { "vendor.lookup": "primary" },
      sandbox_tool_profiles: { "vendor.lookup": "primary" },
    }, ctx);
    expect(designed.ok).toBe(true);
    expect(ctx.specs[0]).toMatchObject({
      toolConfigs: { "vendor.lookup": config },
      toolProfileRefs: { "vendor.lookup": "profile-production" },
      sandboxToolConfigs: { "vendor.lookup": sandboxConfig },
      sandboxToolProfileRefs: { "vendor.lookup": "profile-sandbox" },
      integrationBindings: [{ status: "resolved", toolName: "vendor.lookup" }],
    });
  });
});
