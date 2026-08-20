import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFT_SANDBOX_TEST_SENTINELS } from "@agentic/contracts";

import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_BROKER_REGISTRATION_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
  sandboxCleanupReceiptHash,
  sandboxRunDrainReceiptHash,
  type AgentDraft,
  type AgentDraftRegressionEvidence,
  type DomainOntology,
  type FactoryAuthorizationChallenge,
  type FactoryAuthorizationChallengeStore,
  type FactoryPorts,
  type GeneratedAgentSpec,
  type RealTool,
  type SandboxCleanupReceipt,
  type SandboxDeployResult,
} from "@agentic/agent-factory";

import type {
  FsAgentDraftStore,
  SandboxedDraftVersion,
} from "../src/services/agent-factory/agent-draft-store";
import {
  DraftSandboxError,
  finishDraftSandbox,
  getDraftSandboxInputContract,
  prepareDraftSandboxReview,
} from "../src/services/agent-factory/draft-sandbox-finish";
import { makePromotableSandboxExecutionEvidence } from "./factory-sandbox-execution-fixture";

const domain = "draft-sandbox-domain";
const baseVersionId = "v-base-version-0001";
const scope = {
  tenantId: "ten-draft-sandbox",
  tenantSlug: "draft-sandbox-tenant",
  ontologyDomainId: domain,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function spec(): GeneratedAgentSpec {
  return {
    key: "processWork",
    actionName: "processWork",
    slug: "process-work-agent",
    short: "ProcessWorkAgent",
    domainId: domain,
    nameZh: "处理工作",
    kind: "llm",
    trigger: ["WORK_REQUESTED"],
    emit: ["WORK_COMPLETED"],
    tools: [],
    toolSideEffects: {},
    toolPolicies: {},
    toolConfigs: {},
    unresolvedTools: [],
    objects: [],
    systemPrompt: "按事件契约处理工作并发出完成事件。",
    userPrompt: "",
    decisionLogic: "收到请求后发出 WORK_COMPLETED。",
    steps: [],
    plan: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    inputSchema: [{ field: "work_id", type: "string" }],
    outputSchema: [{ field: "work_id", type: "string" }],
    generatedCode: "export async function handler(input: { work_id: string }) { return { work_id: input.work_id }; }",
    codeSource: "ai",
    codeExecuted: false,
  };
}

function sandboxOnlyProfileFixture(): {
  generatedSpec: GeneratedAgentSpec;
  tool: RealTool;
} {
  const toolName = "vendor.lookup";
  const config = { endpoint_env: "VENDOR_SANDBOX_ENDPOINT" };
  const tool: RealTool = {
    name: toolName,
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    catalogDefinition: {
      name: toolName,
      configSchema: {
        endpoint_env: { type: "string", required: true },
      },
    },
  };
  const profile = {
    id: "profile-sandbox-only",
    tenantId: scope.tenantId,
    profileKey: "sandbox-only",
    toolName,
    domainId: domain,
    environment: "sandbox" as const,
    config,
    confirmedBy: "usr-human-reviewer",
    toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
    configDigest: integrationProfileConfigDigest(config),
    authorizationProtocolVersion:
      INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
    confirmedAt: "2026-07-15T00:00:00.000Z",
  };
  tool.integrationProfiles = [profile];
  return {
    tool,
    generatedSpec: {
      ...spec(),
      tools: [toolName],
      toolSideEffects: { [toolName]: "read" },
      toolPolicies: {
        [toolName]: {
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
        },
      },
      toolConfigs: {},
      toolProfileRefs: {},
      sandboxToolConfigs: { [toolName]: config },
      sandboxToolProfileRefs: { [toolName]: profile.id },
    },
  };
}

function ontology(): DomainOntology {
  return {
    domainId: domain,
    source: "allmeta",
    objects: [],
    rules: [],
    workflow: [],
    actions: [{
      id: "action-process-work",
      name: "processWork",
      actor: ["Agent"],
      trigger: ["WORK_REQUESTED"],
      triggered_event: ["WORK_COMPLETED"],
      target_objects: [],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
    }],
    events: [
      {
        name: "WORK_REQUESTED",
        payload: { event_data: [{ name: "work_id", type: "string", required: true }] },
      },
      {
        name: "WORK_COMPLETED",
        payload: { event_data: [{ name: "work_id", type: "string", required: true }] },
      },
    ],
  } as DomainOntology;
}

function testCases() {
  return [{
    id: "manual-happy",
    name: "正常处理",
    scenario: "收到有效工作编号并跑到成功终态",
    kind: "pass",
    entryEvent: "WORK_REQUESTED",
    payload: { work_id: "work-001", "~key": "ordinary-business-value" },
    expectedOutcome: "发出 WORK_COMPLETED",
    expectedEvent: "WORK_COMPLETED",
  }];
}

function challengeStore(): FactoryAuthorizationChallengeStore {
  let current: FactoryAuthorizationChallenge | null = null;
  return {
    async issue(_requestedDomain, input) {
      const digest = createHash("sha256").update(`${input.subjectDigest}:${input.runId}`).digest("hex");
      const token = `authorize_sandbox_design_review:v1:${digest}`;
      current = {
        id: `fac-${digest.slice(0, 20)}`,
        kind: input.kind,
        protocolVersion: 1,
        digest,
        subjectDigest: input.subjectDigest,
        token,
        question: input.question,
        context: `sandbox_design_review_authorization:v1:${digest}`,
        options: [
          { label: input.declineLabel, value: `decline_sandbox_design_review:v1:${digest}`, recommended: true },
          { label: input.confirmLabel, value: token, recommended: false },
        ],
        runId: input.runId,
        conversationId: input.conversationId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      return current;
    },
    async restore(_requestedDomain, input) {
      return current
        && current.id === input.id
        && current.digest === input.digest
        && current.subjectDigest === input.subjectDigest
        ? current
        : null;
    },
    async consume(_requestedDomain, input) {
      if (!current || input.challenge.id !== current.id || input.answer !== current.token) {
        throw new Error("challenge mismatch");
      }
      const consumed = current;
      current = null;
      return {
        challengeId: consumed.id,
        kind: consumed.kind,
        protocolVersion: consumed.protocolVersion,
        digest: consumed.digest,
        subjectDigest: consumed.subjectDigest,
        authorizationDigest: consumed.digest,
        actor: input.actor,
        runId: consumed.runId,
        conversationId: consumed.conversationId,
        consumedAt: new Date().toISOString(),
        expiresAt: consumed.expiresAt,
      };
    },
  };
}

function cleanupReceipt(input: {
  fingerprint: string;
  appId: string;
  attemptId: string;
  tenantSlug: string;
}): SandboxCleanupReceipt {
  const now = new Date().toISOString();
  const drainBody = {
    schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
    sandboxAttemptId: input.attemptId,
    appId: input.appId,
    sandboxTenantSlug: input.tenantSlug,
    startedAt: now,
    completedAt: now,
    observedRuns: [],
  };
  const body: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
    schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
    appId: input.appId,
    sandboxTenantSlug: input.tenantSlug,
    sandboxAttemptId: input.attemptId,
    candidateFingerprint: input.fingerprint,
    targetDomainId: domain,
    runDrain: { ...drainBody, evidenceHash: sandboxRunDrainReceiptHash(drainBody) },
    deletedAt: now,
    absence: { connected: false, functionCount: null, registryState: "not_registered" },
  };
  return { ...body, absenceProbeHash: sandboxCleanupReceiptHash(body) };
}

interface Harness {
  store: FsAgentDraftStore;
  ports: FactoryPorts;
  deploy: ReturnType<typeof vi.fn>;
  createSandboxedVersion: ReturnType<typeof vi.fn>;
  replayRegression: ReturnType<typeof vi.fn>;
  publishValidatedVersion: ReturnType<typeof vi.fn>;
  writeReviewReceipt: ReturnType<typeof vi.fn>;
  ontologyState: { current: DomainOntology };
}

function harness(options: {
  generatedSpec?: GeneratedAgentSpec;
  registryTools?: RealTool[];
} = {}): Harness {
  const generatedSpec = options.generatedSpec ?? spec();
  const baseDraft: AgentDraft = {
    domain,
    slug: generatedSpec.slug,
    spec: generatedSpec,
    createdAt: "2026-07-15T00:00:00.000Z",
    versionId: baseVersionId,
  };
  const ontologyState = { current: ontology() };
  const createSandboxedVersion = vi.fn(async (
    requestedDomain: string,
    requestedVersion: string,
    evidence: AgentDraftRegressionEvidence,
  ): Promise<SandboxedDraftVersion> => {
    expect(requestedDomain).toBe(domain);
    expect(requestedVersion).toBe(baseVersionId);
    expect(evidence.evidenceFingerprint).toMatch(/^sandbox-evidence:v\d+:[a-f0-9]{64}$/);
    expect(evidence.cleanupReceipt.candidateFingerprint).toBe(evidence.evidenceFingerprint);
    expect(evidence.executionReceipt?.candidateFingerprint).toBe(evidence.evidenceFingerprint);
    expect(evidence.sandboxDesignReview.receipt.actor).toBe("usr-human-reviewer");
    const versionId = "v-sandboxed-version-0002";
    return {
      domain,
      baseVersionId,
      versionId,
      regressionReady: false,
      regressionStatus: "pending_replay",
      drafts: [{
        ...baseDraft,
        versionId,
        regression: {
          artifact: `versions/${versionId}/regression.json`,
          evidenceFingerprint: evidence.evidenceFingerprint,
          suiteFingerprint: "suite-fresh",
          cleanupReceiptHash: evidence.cleanupReceipt.absenceProbeHash,
        },
      }],
    };
  });
  const replayRegression = vi.fn(async () => ({
    pass: true,
    artifact: "regression.json",
    results: [{ id: "manual-happy", pass: true }],
    errors: [],
    suiteFingerprint: "suite-fresh",
  }));
  const publishValidatedVersion = vi.fn(async () => undefined);
  const writeReviewReceipt = vi.fn(async () => undefined);
  const store = {
    getVersion: vi.fn(async (_requestedDomain: string, requestedVersion: string) =>
      requestedVersion === baseVersionId ? [baseDraft] : []),
    createSandboxedVersion,
    validateSandboxedRegression: replayRegression,
    publishValidatedVersion,
    writeReviewReceipt,
  } as unknown as FsAgentDraftStore;

  const deploy = vi.fn(async (
    requestedDomain: string,
    specs: GeneratedAgentSpec[],
    options?: { candidateFingerprint?: string; testCases?: unknown[] },
  ): Promise<SandboxDeployResult> => {
    expect(requestedDomain).toBe(domain);
    expect(specs).toEqual([generatedSpec]);
    expect(options?.testCases).toEqual([expect.objectContaining({ id: "manual-happy", entryEvent: "WORK_REQUESTED" })]);
    const fingerprint = options?.candidateFingerprint ?? "";
    const appId = "factory-test-af-sbx-fresh";
    const attemptId = "77777777-7777-4777-8777-777777777777";
    const tenantSlug = "af-sbx-77777777-88888888-999999999999-sb";
    return {
      appId,
      functionsRegistered: 1,
      ran: 1,
      deployed: 1,
      reachedSuccessTerminal: true,
      fullChainRan: true,
      caseVerdicts: {
        allPass: true,
        results: [{ caseId: "manual-happy", kind: "pass", pass: true, reason: "expected event observed" }],
        byKind: { pass: { total: 1, passed: 1 } },
      },
      degradedAgents: [],
      runs: [{ id: generatedSpec.slug, status: "Completed" }],
      fingerprint: "deployment-hash",
      simulated: false,
      fires: [{ event: "WORK_REQUESTED", ok: true }],
      committedManifestFunctionIds: [generatedSpec.slug],
      brokerRegistration: {
        schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
        appId,
        expectedFunctionCount: 1,
        observedFunctionCount: 1,
        connected: true,
        verified: true,
        evidence: "dev_graphql",
        checkedAt: new Date(0).toISOString(),
      },
      appReady: true,
      uncoveredExternalInputs: [],
      functionTester: [{
        short: generatedSpec.short,
        pass: true,
        ran: true,
        emitNames: ["WORK_COMPLETED"],
        reasons: [],
        tier: "worker",
        fixtureMode: "scripted",
        qualification: "promotable",
      }],
      agentRuns: [{
        agentSlug: generatedSpec.slug,
        agentShort: generatedSpec.short,
        status: "Completed",
        degraded: false,
        triggerEvent: "WORK_REQUESTED",
        inputPayload: { work_id: "work-001" },
        tools: [],
        outputEvent: "WORK_COMPLETED",
        reasoning: "done",
        outputPayload: { work_id: "work-001" },
        runId: "run-fresh-1",
      }],
      toolMode: "evidence_replay",
      externalLiveCalls: 0,
      replayReceipts: [],
      sandboxReplayEvidenceComplete: true,
      candidateFingerprint: fingerprint,
      targetDomainId: domain,
      sandboxAttemptId: attemptId,
      sandboxTenantSlug: tenantSlug,
      cleanupVerified: true,
      cleanupReceipt: cleanupReceipt({ fingerprint, appId, attemptId, tenantSlug }),
      ...makePromotableSandboxExecutionEvidence({
        candidateFingerprint: fingerprint,
        targetDomainId: domain,
        targetTenantId: scope.tenantId,
        targetTenantSlug: scope.tenantSlug,
        sandboxAttemptId: attemptId,
        agentRefs: [generatedSpec.slug],
      }),
    };
  });

  const ports = {
    ontology: { fetchOntology: vi.fn(async () => ontologyState.current) },
    toolRegistry: { list: vi.fn(async () => options.registryTools ?? []) },
    tools: { list: vi.fn(async () => []) },
    integrationCapabilities: { list: vi.fn(async () => []) },
    authorizationChallenges: challengeStore(),
    sandbox: { deployAndObserve: deploy, teardown: vi.fn(async () => undefined) },
  } as unknown as FactoryPorts;
  return {
    store,
    ports,
    deploy,
    createSandboxedVersion,
    replayRegression,
    publishValidatedVersion,
    writeReviewReceipt,
    ontologyState,
  };
}

function reviewRequest(h: Harness) {
  return {
    scope,
    domain,
    versionId: baseVersionId,
    slug: spec().slug,
    testCases: testCases(),
    boundaryEvents: [],
    ports: h.ports,
    store: h.store,
  };
}

function useSameHostDiagnosticResult(h: Harness): void {
  const originalDeploy = h.ports.sandbox.deployAndObserve;
  h.ports.sandbox.deployAndObserve = vi.fn(async (...args) => {
    const result = await originalDeploy(...args);
    return {
      ...result,
      degradedAgents: ["same_host_container_diagnostic_only"],
      functionTester: result.functionTester?.map((entry) => ({
        ...entry,
        qualification: "development_only" as const,
        reasons: [
          ...entry.reasons,
          "同宿主容器只用于诊断；需要 external_sandbox 才能形成可晋升证据。",
        ],
      })),
      ...makePromotableSandboxExecutionEvidence({
        candidateFingerprint: result.candidateFingerprint!,
        targetDomainId: domain,
        targetTenantId: scope.tenantId,
        targetTenantSlug: scope.tenantSlug,
        sandboxAttemptId: result.sandboxAttemptId!,
        agentRefs: [spec().slug],
        isolationTier: "same_host_container",
      }),
    };
  });
}

describe("field-edited draft exact-version sandbox finish", () => {
  it("refuses untouched Web template sentinels instead of running them as evidence", async () => {
    const variants = [
      { scenario: DRAFT_SANDBOX_TEST_SENTINELS.scenario },
      { expectedOutcome: DRAFT_SANDBOX_TEST_SENTINELS.expectedOutcome },
      { payload: { work_id: DRAFT_SANDBOX_TEST_SENTINELS.value } },
    ];
    for (const replacement of variants) {
      const h = harness();
      const incomplete = [{ ...testCases()[0], ...replacement }];
      await expect(prepareDraftSandboxReview({ ...reviewRequest(h), testCases: incomplete })).rejects.toMatchObject({
        code: "test_template_incomplete",
        publicMessage: expect.stringContaining("模板占位"),
      } satisfies Partial<DraftSandboxError>);
      expect(h.deploy).not.toHaveBeenCalled();
      expect(h.createSandboxedVersion).not.toHaveBeenCalled();
    }
  });

  it("requires only the sandbox profile at the sandbox lifecycle stage", async () => {
    const fixture = sandboxOnlyProfileFixture();
    const sandboxOnly = harness({
      generatedSpec: fixture.generatedSpec,
      registryTools: [fixture.tool],
    });
    await expect(
      prepareDraftSandboxReview(reviewRequest(sandboxOnly)),
    ).resolves.toMatchObject({
      schema: "agent-factory-draft-sandbox-review/v1",
    });

    const missingSandbox = harness({
      generatedSpec: {
        ...fixture.generatedSpec,
        sandboxToolConfigs: {},
        sandboxToolProfileRefs: {},
      },
      registryTools: [fixture.tool],
    });
    await expect(
      prepareDraftSandboxReview(reviewRequest(missingSandbox)),
    ).rejects.toMatchObject({
      code: "integration_profile_drift",
      publicMessage: expect.stringContaining("sandbox integration profile"),
    } satisfies Partial<DraftSandboxError>);
  });

  it("persists a same-host green run only as an explicit development diagnostic", async () => {
    const h = harness();
    useSameHostDiagnosticResult(h);
    const review = await prepareDraftSandboxReview(reviewRequest(h));

    const receipt = await finishDraftSandbox({
      ...reviewRequest(h),
      challengeRef: review.challenge,
      answer: review.challenge.token,
      actor: "usr-human-reviewer",
    });

    expect(receipt).toMatchObject({
      schema: "agent-factory-draft-sandbox-finish/v1",
      baseVersionId,
      versionId: baseVersionId,
      regressionReady: false,
      diagnosticOnly: true,
      qualification: "development_only",
      sandbox: {
        cleanupVerified: true,
        qualification: "development_only",
        isolationTier: "same_host_container",
      },
      diagnosticEvidence: {
        schema: "agent-factory-draft-sandbox-diagnostic/v1",
        persisted: true,
        promotionBlockers: expect.arrayContaining([
          expect.stringContaining("不能证明独立执行平面"),
        ]),
      },
      regressionReplay: { pass: false, skipped: true },
    });
    expect(h.writeReviewReceipt).toHaveBeenCalledWith(
      domain,
      expect.stringMatching(/^review-[a-f0-9-]+$/),
      expect.objectContaining({
        schema: "agent-factory-draft-sandbox-diagnostic/v1",
        qualification: "development_only",
        sandbox: expect.objectContaining({
          isolationTier: "same_host_container",
        }),
      }),
    );
    expect(h.createSandboxedVersion).not.toHaveBeenCalled();
    expect(h.replayRegression).not.toHaveBeenCalled();
    expect(h.publishValidatedVersion).not.toHaveBeenCalled();
  });

  it("does not relax cleanup, tester, replay, model-ledger, or zero-live-call gates for same-host diagnostics", async () => {
    const corruptions: Array<
      [string, (result: SandboxDeployResult) => SandboxDeployResult]
    > = [
      ["cleanup", (result) => ({ ...result, cleanupVerified: false })],
      [
        "tester",
        (result) => ({
          ...result,
          functionTester: result.functionTester?.map((entry) => ({
            ...entry,
            ran: false,
          })),
        }),
      ],
      [
        "replay",
        (result) => ({
          ...result,
          sandboxReplayEvidenceComplete: false,
        }),
      ],
      ["model", (result) => ({ ...result, modelUsage: undefined })],
      ["live call", (result) => ({ ...result, externalLiveCalls: 1 })],
    ];

    for (const [_label, corrupt] of corruptions) {
      const h = harness();
      useSameHostDiagnosticResult(h);
      const diagnosticDeploy = h.ports.sandbox.deployAndObserve;
      h.ports.sandbox.deployAndObserve = vi.fn(async (...args) =>
        corrupt(await diagnosticDeploy(...args)));
      const review = await prepareDraftSandboxReview(reviewRequest(h));
      await expect(finishDraftSandbox({
        ...reviewRequest(h),
        challengeRef: review.challenge,
        answer: review.challenge.token,
        actor: "usr-human-reviewer",
      })).rejects.toMatchObject({
        code: "sandbox_not_green",
      } satisfies Partial<DraftSandboxError>);
      expect(h.writeReviewReceipt).not.toHaveBeenCalled();
      expect(h.createSandboxedVersion).not.toHaveBeenCalled();
    }
  });

  it("re-enters the exact immutable version through the real sandbox port and saves only fresh evidence", async () => {
    const h = harness();
    const input = await getDraftSandboxInputContract({
      scope,
      domain,
      versionId: baseVersionId,
      slug: spec().slug,
      ports: h.ports,
      store: h.store,
    });
    expect(input.scope.versionId).toBe(baseVersionId);
    expect(input.entryEvents).toEqual([expect.objectContaining({
      event: "WORK_REQUESTED",
      fields: [expect.objectContaining({ name: "work_id", required: true })],
    })]);

    const review = await prepareDraftSandboxReview(reviewRequest(h));
    expect(review.scope.versionId).toBe(baseVersionId);
    expect(review.challenge.question).toContain("测试数据会经内部代理发送给目标 tenant 当前配置的真实模型提供商");
    expect(review.challenge.question).toContain("externalLiveCalls=0 只表示外部工具没有直连，不表示模型调用为 0");
    expect(review.testCases[0]?.payload).toEqual(expect.objectContaining({ "~key": "ordinary-business-value" }));
    expect(h.deploy).not.toHaveBeenCalled();

    const receipt = await finishDraftSandbox({
      ...reviewRequest(h),
      challengeRef: {
        id: review.challenge.id,
        kind: review.challenge.kind,
        protocolVersion: review.challenge.protocolVersion,
        digest: review.challenge.digest,
        subjectDigest: review.challenge.subjectDigest,
        runId: review.challenge.runId,
        conversationId: review.challenge.conversationId,
        expiresAt: review.challenge.expiresAt,
      },
      answer: review.challenge.token,
      actor: "usr-human-reviewer",
    });

    expect(h.deploy).toHaveBeenCalledTimes(1);
    expect(h.createSandboxedVersion).toHaveBeenCalledTimes(1);
    expect(h.replayRegression).toHaveBeenCalledWith(domain, [spec().slug], "v-sandboxed-version-0002");
    expect(h.publishValidatedVersion).toHaveBeenCalledWith(domain, "v-sandboxed-version-0002", baseVersionId);
    expect(receipt).toMatchObject({
      schema: "agent-factory-draft-sandbox-finish/v1",
      baseVersionId,
      versionId: "v-sandboxed-version-0002",
      regressionReady: true,
      sandbox: { appId: "factory-test-af-sbx-fresh", cleanupVerified: true },
      regressionReplay: { pass: true, suiteFingerprint: "suite-fresh", results: 1 },
    });
  });

  it("threads the attempt-bound execution receipt into production acceptance", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const h = harness();
    const review = await prepareDraftSandboxReview(reviewRequest(h));

    await expect(finishDraftSandbox({
      ...reviewRequest(h),
      challengeRef: review.challenge,
      answer: review.challenge.token,
      actor: "usr-human-reviewer",
    })).resolves.toMatchObject({
      regressionReady: true,
      sandbox: {
        attemptId: "77777777-7777-4777-8777-777777777777",
      },
    });

    expect(h.createSandboxedVersion).toHaveBeenCalledTimes(1);
  });

  it("does not create an app for a declined review and discards a green run if Ontology drifts", async () => {
    const declined = harness();
    const declinedReview = await prepareDraftSandboxReview(reviewRequest(declined));
    await expect(finishDraftSandbox({
      ...reviewRequest(declined),
      challengeRef: declinedReview.challenge,
      answer: declinedReview.challenge.options.find((option) => option.value !== declinedReview.challenge.token)!.value,
      actor: "usr-human-reviewer",
    })).rejects.toMatchObject({ code: "sandbox_review_declined" } satisfies Partial<DraftSandboxError>);
    expect(declined.deploy).not.toHaveBeenCalled();
    expect(declined.createSandboxedVersion).not.toHaveBeenCalled();

    const drifted = harness();
    const driftReview = await prepareDraftSandboxReview(reviewRequest(drifted));
    const originalDeploy = drifted.ports.sandbox.deployAndObserve;
    drifted.ports.sandbox.deployAndObserve = vi.fn(async (...args) => {
      const result = await originalDeploy(...args);
      drifted.ontologyState.current = {
        ...drifted.ontologyState.current,
        events: drifted.ontologyState.current.events.map((event) => event.name === "WORK_COMPLETED"
          ? { ...event, description: "changed while sandbox was running" }
          : event),
      };
      return result;
    });
    await expect(finishDraftSandbox({
      ...reviewRequest(drifted),
      challengeRef: driftReview.challenge,
      answer: driftReview.challenge.token,
      actor: "usr-human-reviewer",
    })).rejects.toMatchObject({ code: "sandbox_evidence_drift" } satisfies Partial<DraftSandboxError>);
    expect(drifted.createSandboxedVersion).not.toHaveBeenCalled();
    expect(drifted.replayRegression).not.toHaveBeenCalled();
  });

  it("never returns a ready receipt when the freshly persisted artifact replay fails", async () => {
    const h = harness();
    h.replayRegression.mockResolvedValueOnce({
      pass: false,
      artifact: "regression.json",
      results: [],
      errors: ["fresh replay failed"],
    });
    const review = await prepareDraftSandboxReview(reviewRequest(h));
    await expect(finishDraftSandbox({
      ...reviewRequest(h),
      challengeRef: review.challenge,
      answer: review.challenge.token,
      actor: "usr-human-reviewer",
    })).rejects.toMatchObject({
      code: "regression_materialization_failed",
      publicMessage: expect.stringContaining("不会被当作可晋升证据"),
    } satisfies Partial<DraftSandboxError>);
    expect(h.deploy).toHaveBeenCalledTimes(1);
    expect(h.createSandboxedVersion).toHaveBeenCalledTimes(1);
    expect(h.replayRegression).toHaveBeenCalledTimes(1);
    expect(h.publishValidatedVersion).not.toHaveBeenCalled();
  });

  it("accepts the exact approved-case roster when only fullChainRan is a late projection", async () => {
    const h = harness();
    const originalDeploy = h.ports.sandbox.deployAndObserve;
    h.ports.sandbox.deployAndObserve = vi.fn(async (...args) => ({
      ...(await originalDeploy(...args)),
      fullChainRan: false,
      reachedSuccessTerminal: true,
    }));
    const review = await prepareDraftSandboxReview(reviewRequest(h));
    await expect(finishDraftSandbox({
      ...reviewRequest(h),
      challengeRef: review.challenge,
      answer: review.challenge.token,
      actor: "usr-human-reviewer",
    })).resolves.toMatchObject({ regressionReady: true });
  });

  it("rejects a short successful branch when neither aggregate nor exact-case evidence proves the complete suite", async () => {
    const h = harness();
    const originalDeploy = h.ports.sandbox.deployAndObserve;
    h.ports.sandbox.deployAndObserve = vi.fn(async (...args) => ({
      ...(await originalDeploy(...args)),
      fullChainRan: false,
      reachedSuccessTerminal: true,
      caseVerdicts: {
        allPass: true,
        results: [{ caseId: "different-case", kind: "pass", pass: true, reason: "unrelated branch" }],
        byKind: { pass: { total: 1, passed: 1 } },
      },
    }));
    const review = await prepareDraftSandboxReview(reviewRequest(h));
    await expect(finishDraftSandbox({
      ...reviewRequest(h),
      challengeRef: review.challenge,
      answer: review.challenge.token,
      actor: "usr-human-reviewer",
    })).rejects.toMatchObject({
      code: "sandbox_not_green",
      publicMessage: expect.stringContaining("完整测试套件未通过"),
    } satisfies Partial<DraftSandboxError>);
    expect(h.createSandboxedVersion).not.toHaveBeenCalled();
  });
});
