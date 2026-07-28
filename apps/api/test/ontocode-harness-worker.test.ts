import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  businessOntologyDomains,
  factoryDomainBindings,
  ontocodeCandidateHeads,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeEvidenceRecords,
  ontocodePackageVersions,
  getDb,
  ontocodeProjects,
  ontocodeSandboxAttempts,
  ontocodeSessionEvents,
  tenants,
} from "@agentic/db";
import type {
  DomainOntology,
  FactoryScopeRecommendation,
  SandboxDeployResult,
} from "@agentic/agent-factory";
import {
  factoryScopeRecommendationId,
  factorySourceOntologyHash,
} from "@agentic/agent-factory";
import type { OntoCodeCandidateTestCase } from "@agentic/contracts";
import {
  createOntoCodeCommand,
  createOntoCodeChangeSet,
  createOntoCodeHarnessJob,
  createOntoCodeProject,
  createOntoCodeSession,
  decideOntoCodeCommand,
  getOntoCodeCommand,
  getOntoCodeHarnessJob,
  getOntoCodeSession,
  listOntoCodeMessages,
} from "../src/services/ontocode-session-store";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  applyDeferredGenerationScope,
  OntoCodeHarnessExecutionError,
  OntoCodeHarnessWorkerAdapter,
  runFactoryBuild,
  type OntoCodeFactoryHarnessAdapter,
  type OntoCodeFactoryRunRuntime,
} from "../src/services/ontocode-harness-worker";
import { buildTestEnv } from "./harness";

const ontology: DomainOntology = {
  domainId: "ontocode-worker-test",
  source: "snapshot",
  objects: [
    {
      id: "Candidate",
      name: "Candidate",
      properties: [{ name: "id", type: "string", required: true }],
    },
  ],
  rules: [],
  actions: [
    {
      id: "screen-candidate",
      name: "screenCandidate",
      description: "Screen one candidate against an approved rubric",
      actor: ["Agent"],
      category: "screening",
      trigger: ["CANDIDATE_RECEIVED"],
      triggered_event: ["CANDIDATE_SCREENED"],
      target_objects: ["Candidate"],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
    },
    {
      id: "approve-candidate",
      name: "approveCandidate",
      description: "A human hiring decision that must not become an Agent",
      actor: ["Human"],
      category: "approval",
      trigger: ["CANDIDATE_SCREENED"],
      triggered_event: [],
      target_objects: ["Candidate"],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
    },
  ],
  events: [
    {
      name: "CANDIDATE_RECEIVED",
      consumers: ["screenCandidate"],
      payload: {
        source_action: null,
        event_data: [
          {
            name: "candidate",
            type: "object",
            target_object: "Candidate",
          },
        ],
        state_mutations: [],
      },
    },
    {
      name: "CANDIDATE_SCREENED",
      producers: ["screenCandidate"],
      payload: {
        source_action: "screenCandidate",
        event_data: [
          {
            name: "result",
            type: "object",
            target_object: "Candidate",
          },
        ],
        state_mutations: [],
      },
    },
  ],
  workflow: [],
};

const scopeRecommendation: FactoryScopeRecommendation = {
  recommendationId: "rec_test",
  ontologyHash: factorySourceOntologyHash(ontology),
  mode: "action_selection",
  scenario: "Screen candidates",
  actionIds: ["screen-candidate"],
  actions: [
    {
      id: "screen-candidate",
      name: "screenCandidate",
      reason: "It is the authoritative screening action",
    },
  ],
  reasoningSummary: "The scenario needs the screening action only.",
  confidence: 1,
};

function fakeFactory(
  overrides: Partial<OntoCodeFactoryHarnessAdapter> = {},
): OntoCodeFactoryHarnessAdapter {
  return {
    fetchOntology: vi.fn(async () => ontology),
    recommendScope: vi.fn(async (input) => ({
      ...scopeRecommendation,
      scenario: input.scenario,
      ontologyHash: factorySourceOntologyHash(input.ontology),
      recommendationId: factoryScopeRecommendationId({
        scopeKey: input.scopeKey,
        domain: input.ontology.domainId,
        ontologyHash: factorySourceOntologyHash(input.ontology),
        scenario: input.scenario,
      }),
    })),
    runBuild: vi.fn(async () => ({
      outcome: "succeeded",
      receipt: {
        factoryRunId: "fake-run",
        status: "finished",
        completionKind: "delivery",
        agents: [
          {
            slug: "screen-candidate-agent",
            actionName: "screenCandidate",
            name: "Candidate screening",
            spec: {
              slug: "screen-candidate-agent",
              actionName: "screenCandidate",
              generatedCode:
                "export const screenCandidateAgent = { async handler(input) { return input; } };",
            },
            generatedCode:
              "export const screenCandidateAgent = { async handler(input) { return input; } };",
          },
        ],
      },
    })),
    ...overrides,
  };
}

describe("OntoCode deferred Action scope", () => {
  const ontologyWithDeferredAction: DomainOntology = {
    ...ontology,
    actions: [
      ...ontology.actions,
      {
        id: "process-resume",
        name: "processResume",
        description:
          "Process a resume after its external lock contract is bound",
        actor: ["Agent"],
        category: "resume",
        trigger: ["RESUME_DOWNLOADED"],
        triggered_event: ["RESUME_PROCESSED"],
        target_objects: ["Candidate"],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
      },
    ],
  };

  it("keeps independently buildable Actions while recording the exact deferred Ontology Action", () => {
    const result = applyDeferredGenerationScope(
      ontologyWithDeferredAction,
      {
        actionIds: ["screen-candidate", "process-resume"],
        scenario: "Build the approved recruitment Agents",
        forceVirtual: false,
        source: "blueprint",
        deferredActions: [],
      },
      { deferActionNames: ["processResume"] },
    );

    expect(result).toEqual({
      actionIds: ["screen-candidate"],
      scenario: "Build the approved recruitment Agents",
      forceVirtual: false,
      source: "command",
      deferredActions: [{ id: "process-resume", name: "processResume" }],
    });
  });

  it("refuses to defer an Action outside the approved scope or empty the Build", () => {
    const scope = {
      actionIds: ["screen-candidate"],
      scenario: "Screen candidates",
      forceVirtual: false,
      source: "blueprint" as const,
      deferredActions: [],
    };

    expect(() =>
      applyDeferredGenerationScope(ontologyWithDeferredAction, scope, {
        deferActionNames: ["processResume"],
      }),
    ).toThrow("not in the approved generation scope");
    expect(() =>
      applyDeferredGenerationScope(ontologyWithDeferredAction, scope, {
        deferActionNames: ["screenCandidate"],
      }),
    ).toThrow("At least one approved Ontology Action must remain");
  });
});

describe("OntoCode Harness Worker Adapter", () => {
  let tenantId: string;
  let originalBinding: FactoryDomainBinding | null;
  const projectIds: string[] = [];

  beforeAll(async () => {
    await buildTestEnv();
    const tenant = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get();
    if (!tenant) throw new Error("__system test tenant is missing");
    tenantId = tenant.id;
    originalBinding = getFactoryDomainBinding(tenantId);
    setFactoryDomainBinding(
      tenantId,
      { id: ontology.domainId, name: "OntoCode worker test Ontology" },
      "explicit",
    );
  });

  afterAll(() => {
    for (const projectId of projectIds) {
      getDb()
        .delete(ontocodeProjects)
        .where(eq(ontocodeProjects.id, projectId))
        .run();
    }
    if (originalBinding) {
      setFactoryDomainBinding(
        tenantId,
        {
          id: originalBinding.ontologyDomainId,
          name:
            originalBinding.ontologyDomainName ??
            originalBinding.ontologyDomainId,
        },
        originalBinding.source,
      );
    } else {
      clearFactoryDomainBinding(tenantId);
    }
  });

  function makeQueuedJob(input: {
    kind:
      | "scope"
      | "blueprint"
      | "build"
      | "test"
      | "debug"
      | "regression"
      | "deploy";
    commandArguments?: Record<string, unknown>;
    requiresHuman?: boolean;
    riskClass?:
      | "read_only"
      | "draft_change"
      | "sandbox_effect"
      | "production_deploy";
    commandType?:
      | "analyze_scope"
      | "propose_blueprint"
      | "generate_package"
      | "run_tests"
      | "debug_failure"
      | "deploy_release";
    budget?: {
      maxTokens?: number;
      maxCostUsd?: number;
      maxWallClockMs?: number;
      maxModelCalls?: number;
      maxToolCalls?: number;
    };
    withChangeSet?: boolean;
  }) {
    const suffix = randomUUID().slice(0, 8);
    const ctx = { tenantId, actorId: "test-fde" };
    const { project } = createOntoCodeProject(ctx, {
      domain: ontology.domainId,
      name: `Worker test ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Worker session ${suffix}`,
      goal: "Screen candidates",
      autonomyMode: "copilot",
      ...(["build", "test", "debug", "regression"].includes(input.kind)
        ? { ontologySnapshotHash: factorySourceOntologyHash(ontology) }
        : {}),
    });
    const { command, sessionRevision } = createOntoCodeCommand(
      ctx,
      session.id,
      {
        type:
          input.commandType ??
          (input.kind === "scope"
            ? "analyze_scope"
            : input.kind === "blueprint"
              ? "propose_blueprint"
              : input.kind === "build"
                ? "generate_package"
                : input.kind === "test" || input.kind === "regression"
                  ? "run_tests"
                  : input.kind === "debug"
                    ? "debug_failure"
                    : "deploy_release"),
        arguments:
          input.commandArguments ??
          (["blueprint", "build", "test", "debug", "regression"].includes(
            input.kind,
          )
            ? { actionIds: ["screen-candidate"] }
            : {}),
        expectedSessionRevision: session.revision,
        affectedSemanticPaths: [],
        riskClass:
          input.riskClass ??
          (input.kind === "deploy" ? "production_deploy" : "draft_change"),
        requestedCapabilities: [],
        requiresHuman: input.requiresHuman ?? input.kind === "deploy",
        rationaleSummary: `Run ${input.kind}`,
        idempotencyKey: `command-${suffix}`,
      },
    );
    let revision = sessionRevision;
    if (command.status === "awaiting_approval") {
      revision = decideOntoCodeCommand(ctx, command.id, "approve", {
        expectedSessionRevision: revision,
      }).sessionRevision;
    }
    let changeSetId: string | null = null;
    if (input.withChangeSet) {
      const created = createOntoCodeChangeSet(ctx, session.id, {
        commandId: command.id,
        summary: `Apply ${input.kind} generated Agent artifacts`,
        baseOntologyHash: factorySourceOntologyHash(ontology),
        expectedSessionRevision: revision,
        operations: [
          {
            operation: "replace",
            semanticPath: "/agents/screen-candidate-agent",
            beforeValue: null,
            afterValue: { source: "harness" },
            sourceRefs: [`ontology-action:${ontology.actions[0]!.id}`],
            invalidates: ["tests:screen-candidate-agent"],
          },
        ],
        idempotencyKey: `changeset-${suffix}`,
      });
      revision = created.sessionRevision;
      changeSetId = created.changeSet.id;
    }
    const { job } = createOntoCodeHarnessJob(ctx, session.id, {
      commandId: command.id,
      kind: input.kind,
      expectedSessionRevision: revision,
      idempotencyKey: `job-${suffix}`,
      ...(input.budget ? { budget: input.budget } : {}),
    });
    return { ctx, project, session, command, job, changeSetId };
  }

  async function buildExactCandidate() {
    const fixture = makeQueuedJob({ kind: "build" });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    const packageVersion = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(
        and(
          eq(ontocodePackageVersions.tenantId, tenantId),
          eq(ontocodePackageVersions.sessionId, fixture.session.id),
        ),
      )
      .get();
    const head = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(
        and(
          eq(ontocodeCandidateHeads.tenantId, tenantId),
          eq(ontocodeCandidateHeads.sessionId, fixture.session.id),
        ),
      )
      .get();
    if (!packageVersion || !head) {
      throw new Error("Build did not persist an exact Candidate target");
    }
    return { fixture, buildFactory: factory, packageVersion, head };
  }

  function queueExactCandidateTest(
    built: Awaited<ReturnType<typeof buildExactCandidate>>,
    input: {
      kind?: "test" | "regression";
      testCases?: OntoCodeCandidateTestCase[];
    } = {},
  ) {
    const kind = input.kind ?? "test";
    const suffix = randomUUID().slice(0, 8);
    const current = getOntoCodeSession(
      { tenantId },
      built.fixture.session.id,
    );
    const { command, sessionRevision } = createOntoCodeCommand(
      built.fixture.ctx,
      built.fixture.session.id,
      {
        type: "run_tests",
        arguments: {
          candidatePackageVersionId: built.packageVersion.id,
          testCaseCount: input.testCases?.length ?? 0,
        },
        expectedSessionRevision: current.revision,
        baseOntologyHash: built.packageVersion.ontologyHash,
        basePackageVersionId: built.packageVersion.id,
        affectedSemanticPaths: ["/candidate/tests"],
        riskClass: "sandbox_effect",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: `Verify the immutable Candidate with ${kind}`,
        idempotencyKey: `command-candidate-${kind}-${suffix}`,
      },
    );
    const { job } = createOntoCodeHarnessJob(
      built.fixture.ctx,
      built.fixture.session.id,
      {
        commandId: command.id,
        kind,
        expectedSessionRevision: sessionRevision,
        candidatePackageVersionId: built.packageVersion.id,
        candidateDependencyRoot: built.packageVersion.dependencyRoot,
        candidateHeadRevision: built.head.revision,
        ...(input.testCases ? { testCases: input.testCases } : {}),
        idempotencyKey: `job-candidate-${kind}-${suffix}`,
      },
    );
    return { command, job };
  }

  function successfulDevelopmentSandbox(
    dependencyRoot: string,
  ): SandboxDeployResult {
    return {
      appId: `candidate-test-${randomUUID().slice(0, 8)}`,
      functionsRegistered: 1,
      ran: 1,
      deployed: 1,
      reachedSuccessTerminal: true,
      fullChainRan: true,
      degradedAgents: [],
      runs: [{ id: "run-candidate-test", status: "completed" }],
      fingerprint: dependencyRoot,
      simulated: false,
      caseVerdicts: {
        allPass: true,
        results: [
          {
            caseId: "candidate-happy",
            kind: "pass",
            pass: true,
            reason: "Reached the expected terminal",
          },
        ],
        byKind: { pass: { total: 1, passed: 1 } },
      },
      candidateFingerprint: dependencyRoot,
      targetDomainId: ontology.domainId,
      sandboxAttemptId: `factory-attempt-${randomUUID().slice(0, 8)}`,
      sandboxTenantSlug: "candidate-test-sandbox",
      cleanupVerified: false,
    };
  }

  it("claims a queued job once with a durable fenced lease", () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    const now = 2_000_000_000_000;
    const first = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      now: () => now,
    });
    const second = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      now: () => now,
    });

    const claim = first.claimNextJob();
    expect(claim).toMatchObject({
      jobId: fixture.job.id,
      tenantId,
      previousStatus: "queued",
      recovered: false,
      leaseToken: now,
    });
    expect(second.claimNextJob()).toBeNull();
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      status: "leased",
      startedAt: now,
    });
    const leased = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.job.leased"),
        ),
      )
      .get();
    expect(leased).toBeTruthy();
  });

  it("keeps Harness execution pinned to the Project registration when the same Domain id has another source", async () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    const registrationId = `bod-harness-alt-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    getDb()
      .insert(businessOntologyDomains)
      .values({
        id: registrationId,
        tenantId,
        ontologyDomainId: ontology.domainId,
        displayName: "Same id from an independent upload",
        source: "upload",
        status: "active",
        isDefault: false,
        catalogMetadataJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    try {
      const worker = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory: fakeFactory(),
      });
      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
    } finally {
      getDb()
        .delete(businessOntologyDomains)
        .where(eq(businessOntologyDomains.id, registrationId))
        .run();
    }
  });

  it("keeps using the Session registration when the legacy Factory default drifts", async () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    getDb()
      .update(factoryDomainBindings)
      .set({
        ontologyDomainId: "drifted-ontology",
        ontologyDomainName: "Drifted Ontology",
        updatedAt: new Date(),
      })
      .where(eq(factoryDomainBindings.tenantId, tenantId))
      .run();
    try {
      const worker = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory: fakeFactory(),
        maxAttempts: 1,
      });
      await expect(worker.runNext()).resolves.toMatchObject({
        claimed: true,
        jobId: fixture.job.id,
        status: "succeeded",
      });
      const failed = getDb()
        .select({ payloadJson: ontocodeSessionEvents.payloadJson })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.job.failed"),
          ),
        )
        .get();
      expect(failed).toBeUndefined();
    } finally {
      getDb()
        .update(factoryDomainBindings)
        .set({
          ontologyDomainId: ontology.domainId,
          ontologyDomainName: "OntoCode worker test Ontology",
          updatedAt: new Date(),
        })
        .where(eq(factoryDomainBindings.tenantId, tenantId))
        .run();
    }
  });

  it("runs bounded scope recommendation against the authoritative snapshot", async () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(getOntoCodeSession({ tenantId }, fixture.session.id)).toMatchObject({
      phase: "scope",
      activityState: "idle",
      ontologySnapshotHash: factorySourceOntologyHash(ontology),
    });
    expect(
      listOntoCodeMessages({ tenantId }, fixture.session.id, {
        limit: 20,
        offset: 0,
      }).items,
    ).toEqual([
      expect.objectContaining({
        role: "assistant",
        type: "receipt",
        content: expect.objectContaining({
          jobId: fixture.job.id,
          status: "succeeded",
        }),
      }),
    ]);
  });

  it.each([
    {
      scopeMode: "full_domain",
      actionIds: [] as string[],
      label: "full-domain",
    },
    {
      scopeMode: "selected_actions",
      actionIds: ["screen-candidate"],
      label: "selected-actions",
    },
  ])(
    "honors the explicit $label scope without asking the model to guess",
    async ({ scopeMode, actionIds }) => {
      const fixture = makeQueuedJob({
        kind: "scope",
        commandArguments: {
          scopeMode,
          actionIds,
          scenario: "Screen candidates",
        },
      });
      const factory = fakeFactory();
      const worker = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory,
      });

      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
      expect(factory.recommendScope).not.toHaveBeenCalled();
      const completed = getDb()
        .select({ payloadJson: ontocodeSessionEvents.payloadJson })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.scope.completed"),
          ),
        )
        .get();
      expect(completed).toBeTruthy();
      expect(JSON.parse(completed!.payloadJson)).toMatchObject({
        receipt: {
          recommendation: {
            mode: "action_selection",
            actionIds: ["screen-candidate"],
            confidence: 1,
          },
        },
      });
    },
  );

  it("rejects a Human-owned Ontology Action as an Agent generation scope", async () => {
    const fixture = makeQueuedJob({
      kind: "scope",
      commandArguments: {
        scopeMode: "selected_actions",
        actionIds: ["approve-candidate"],
        scenario: "Approve a candidate",
      },
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      maxAttempts: 1,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    const failed = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.job.failed"),
        ),
      )
      .get();
    expect(JSON.parse(failed?.payloadJson ?? "{}")).toMatchObject({
      error: {
        code: "ontology_action_not_agent_owned",
        retryable: false,
      },
    });
  });

  it("builds and persists an ontology-grounded blueprint", async () => {
    const fixture = makeQueuedJob({ kind: "blueprint" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      claimed: true,
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id).status).toBe(
      "succeeded",
    );
    expect(getOntoCodeCommand({ tenantId }, fixture.command.id).status).toBe(
      "succeeded",
    );
    expect(getOntoCodeSession({ tenantId }, fixture.session.id)).toMatchObject({
      phase: "blueprint",
      activityState: "idle",
    });
    const types = getDb()
      .select({ type: ontocodeSessionEvents.type })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all()
      .map((row) => row.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "harness.job.leased",
        "harness.job.started",
        "harness.blueprint.grounded",
        "harness.blueprint.completed",
        "harness.job.succeeded",
      ]),
    );
  });

  it("delegates a snapshot-bound build to the sandbox Factory adapter", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(factory.runBuild).toHaveBeenCalledTimes(1);
    expect(factory.runBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        domain: ontology.domainId,
        directive: expect.objectContaining({
          requestedActionIds: ["screen-candidate"],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        }),
      }),
    );
    expect(getOntoCodeSession({ tenantId }, fixture.session.id)).toMatchObject({
      phase: "verify",
      activityState: "idle",
    });
  });

  it("parks immediately on a Factory clarification, records waiting evidence, then stops the old run", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const interactionId = "hitl_11111111-1111-4111-8111-111111111111";
    const unsubscribe = vi.fn();
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "tool.result",
            id: "readiness-1",
            name: "inspect_all_action_readiness",
            ok: true,
            summary: "5 ready, 1 blocked",
            output: JSON.stringify({
              readOnly: true,
              source: "ontology.agent_actions",
              reason: "catalog_readiness_requires_authoritative_input",
              next: "ask_user",
              totals: {
                total: 6,
                ready: 5,
                blocked: 1,
                readyActions: ["createJD", "matchResume"],
                blockedActions: ["processResume"],
              },
              actions: [
                {
                  action: "processResume",
                  ready: false,
                  stages: {
                    authoring: false,
                    sandbox: false,
                    promotion: false,
                  },
                  blockers: {
                    integration: {
                      unresolvedBindings: [
                        {
                          requirementId: "9-1:integration:6",
                          system: "Internal_Recruitment_System",
                          kind: "external_api",
                          role: "execute",
                          status: "missing",
                          reason:
                            "No authorized capability covers candidate.lock_check",
                        },
                      ],
                    },
                  },
                },
              ],
            }),
          });
          callback({
            t: "clarify",
            question: "候选人评分低于多少时需要人工复核？",
            context: "该阈值会进入 Agent 的决策分支。",
            options: [
              { label: "低于 60 分", value: "60", recommended: true },
              { label: "低于 70 分", value: "70" },
            ],
            awaitingAnswer: true,
            interactionId,
          });
          return unsubscribe;
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;
    const factory = fakeFactory({
      runBuild: vi.fn((input) => runFactoryBuild(input, runtime)),
    });
    const stopFactoryRun = vi.fn((runId: string, stopTenantId: string) => {
      // Cleanup is deliberately downstream of the receipt/evidence commit.
      const evidence = getDb()
        .select()
        .from(ontocodeEvidenceRecords)
        .where(
          and(
            eq(ontocodeEvidenceRecords.tenantId, tenantId),
            eq(ontocodeEvidenceRecords.harnessJobId, fixture.job.id),
          ),
        )
        .get();
      expect(evidence).toBeTruthy();
      expect(
        JSON.parse(evidence!.validityPredicateJson) as Record<string, unknown>,
      ).toMatchObject({ jobStatus: "waiting_user" });
      return runtime.abortRun(runId, stopTenantId);
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
      stopFactoryRun,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });

    const expectedRunId = `ocf-${fixture.job.id}-a1`;
    expect(stopFactoryRun).toHaveBeenCalledWith(expectedRunId, tenantId);
    expect(runtime.abortRun).toHaveBeenCalledWith(expectedRunId, tenantId);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      status: "waiting_user",
      errorMessage: expect.stringContaining("候选人评分低于多少时需要人工复核"),
    });

    const artifacts = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(eq(ontocodeArtifacts.sessionId, fixture.session.id))
      .all();
    expect(artifacts).toEqual([
      expect.objectContaining({
        logicalName: `harness/build/${fixture.job.id}/receipt.json`,
        kind: "harness_receipt",
      }),
    ]);
    const receiptVersion = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(eq(ontocodeArtifactVersions.artifactId, artifacts[0]!.id))
      .get();
    const receiptBlob = getDb()
      .select()
      .from(ontocodeArtifactBlobs)
      .where(eq(ontocodeArtifactBlobs.id, receiptVersion!.blobId))
      .get();
    const receipt = JSON.parse(receiptBlob!.contentText) as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({
      schema: "ontocode-build-receipt/v1",
      status: "waiting_human",
      completionKind: "awaiting_input",
      interaction: {
        kind: "clarify",
        awaitingAnswer: true,
        interactionId,
        question: "候选人评分低于多少时需要人工复核？",
        context: "该阈值会进入 Agent 的决策分支。",
        options: [
          { label: "低于 60 分", value: "60", recommended: true },
          { label: "低于 70 分", value: "70" },
        ],
      },
      readiness: {
        schema: "ontocode-factory-readiness/v1",
        source: "ontology.agent_actions",
        reason: "catalog_readiness_requires_authoritative_input",
        next: "ask_user",
        totals: {
          total: 6,
          ready: 5,
          blocked: 1,
          readyActions: ["createJD", "matchResume"],
          blockedActions: ["processResume"],
        },
        actions: [
          {
            action: "processResume",
            ready: false,
            stages: {
              authoring: false,
              sandbox: false,
              promotion: false,
            },
            unresolvedBindings: [
              {
                requirementId: "9-1:integration:6",
                system: "Internal_Recruitment_System",
                kind: "external_api",
                role: "execute",
                status: "missing",
                executionSurface: null,
                reason: "No authorized capability covers candidate.lock_check",
              },
            ],
          },
        ],
      },
    });

    const evidence = getDb()
      .select()
      .from(ontocodeEvidenceRecords)
      .where(eq(ontocodeEvidenceRecords.harnessJobId, fixture.job.id))
      .get();
    expect(evidence).toMatchObject({
      outcome: "informational",
      subjectDigest: receiptVersion!.blobHash,
      summary: expect.stringContaining("does not claim completion or success"),
    });
    expect(
      JSON.parse(evidence!.validityPredicateJson) as Record<string, unknown>,
    ).toMatchObject({
      jobStatus: "waiting_user",
      immutableReceiptHash: receiptVersion!.blobHash,
    });

    const messages = listOntoCodeMessages({ tenantId }, fixture.session.id, {
      limit: 20,
      offset: 0,
    }).items;
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        type: "recommendation",
        content: expect.objectContaining({
          status: "waiting_user",
          text: expect.stringContaining("1. 低于 60 分（推荐） — 回复：60"),
          receipt: expect.objectContaining({
            interaction: expect.objectContaining({ interactionId }),
          }),
        }),
      }),
    ]);
  });

  it("treats a legacy Factory answer as waiting input, never as a Build delivery", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const finalQuestion =
      "请确认外部工具绑定、人工边界，以及 ontology.fetchActionRules 的运行时来源。";
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({ t: "message", text: finalQuestion });
          callback({
            t: "done",
            status: "incomplete",
            completionKind: "answer",
            reachedTerminal: false,
            tokensUsed: 100,
            turns: 2,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;
    const factory = fakeFactory({
      runBuild: vi.fn((input) => runFactoryBuild(input, runtime)),
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      status: "waiting_user",
      errorMessage: finalQuestion,
    });
    expect(getOntoCodeSession({ tenantId }, fixture.session.id)).toMatchObject({
      activityState: "needs_user",
    });

    const receiptArtifact = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(
        and(
          eq(ontocodeArtifacts.sessionId, fixture.session.id),
          eq(
            ontocodeArtifacts.logicalName,
            `harness/build/${fixture.job.id}/receipt.json`,
          ),
        ),
      )
      .get();
    expect(receiptArtifact).toBeTruthy();
    expect(
      getDb()
        .select()
        .from(ontocodeEvidenceRecords)
        .where(eq(ontocodeEvidenceRecords.harnessJobId, fixture.job.id))
        .get(),
    ).toMatchObject({ outcome: "informational" });
    expect(
      getDb()
        .select()
        .from(ontocodeArtifacts)
        .where(
          and(
            eq(ontocodeArtifacts.sessionId, fixture.session.id),
            eq(ontocodeArtifacts.kind, "agent_code"),
          ),
        )
        .all(),
    ).toHaveLength(0);
  });

  it("uses a bounded follow-up instruction while preserving the completed Blueprint scope", async () => {
    const blueprintFixture = makeQueuedJob({ kind: "blueprint" });
    const blueprintWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });
    await expect(blueprintWorker.runNext()).resolves.toMatchObject({
      jobId: blueprintFixture.job.id,
      status: "succeeded",
    });

    const current = getOntoCodeSession(
      { tenantId },
      blueprintFixture.session.id,
    );
    const suffix = randomUUID().slice(0, 8);
    const oversizedInstruction =
      `FDE answer: keep the scoring threshold at 60. ` +
      "x".repeat(5_000) +
      "DO_NOT_INCLUDE_TAIL";
    const { command, sessionRevision } = createOntoCodeCommand(
      blueprintFixture.ctx,
      blueprintFixture.session.id,
      {
        type: "generate_package",
        arguments: { instruction: oversizedInstruction },
        expectedSessionRevision: current.revision,
        baseOntologyHash: factorySourceOntologyHash(ontology),
        affectedSemanticPaths: ["/agents/screen-candidate-agent"],
        riskClass: "draft_change",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: "Apply the FDE clarification to the Blueprint",
        idempotencyKey: `command-follow-up-${suffix}`,
      },
    );
    const { job } = createOntoCodeHarnessJob(
      blueprintFixture.ctx,
      blueprintFixture.session.id,
      {
        commandId: command.id,
        kind: "build",
        expectedSessionRevision: sessionRevision,
        idempotencyKey: `job-follow-up-${suffix}`,
      },
    );
    const factory = fakeFactory();
    const buildWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(buildWorker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "succeeded",
    });
    expect(factory.runBuild).toHaveBeenCalledTimes(1);
    const buildInput = vi.mocked(factory.runBuild).mock.calls[0]![0];
    expect(buildInput.directive.requestedActionIds).toEqual([
      "screen-candidate",
    ]);
    const instructionMarker = "[OntoCode FDE follow-up instruction]\n";
    expect(buildInput.goal).toContain(instructionMarker);
    const forwardedInstruction = buildInput.goal.split(instructionMarker)[1];
    expect(forwardedInstruction).toHaveLength(4_000);
    expect(forwardedInstruction).toContain(
      "FDE answer: keep the scoring threshold at 60.",
    );
    expect(buildInput.goal).not.toContain("DO_NOT_INCLUDE_TAIL");

    const completedEvent = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, job.id),
          eq(ontocodeSessionEvents.type, "harness.build.completed"),
        ),
      )
      .get();
    const completedPayload = JSON.parse(completedEvent!.payloadJson) as {
      receipt: { scope: { source: string; actionIds: string[] } };
    };
    expect(completedPayload.receipt.scope).toEqual(
      expect.objectContaining({
        source: "blueprint",
        actionIds: ["screen-candidate"],
      }),
    );
  });

  it("atomically preserves generated code/spec artifacts and job evidence", async () => {
    const fixture = makeQueuedJob({ kind: "build", withChangeSet: true });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });

    const artifacts = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(
        and(
          eq(ontocodeArtifacts.tenantId, tenantId),
          eq(ontocodeArtifacts.sessionId, fixture.session.id),
        ),
      )
      .all();
    expect(artifacts.map((artifact) => artifact.logicalName).sort()).toEqual([
      "agents/screen-candidate-agent/agent.ts",
      "agents/screen-candidate-agent/spec.json",
      `harness/build/${fixture.job.id}/receipt.json`,
      "package/factory-draft.json",
      "package/manifest.json",
      "package/runtime-config.json",
    ]);

    const versions = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(
        and(
          eq(ontocodeArtifactVersions.tenantId, tenantId),
          eq(ontocodeArtifactVersions.sessionId, fixture.session.id),
        ),
      )
      .all();
    expect(versions).toHaveLength(6);
    expect(
      versions.every((version) => version.changeSetId === fixture.changeSetId),
    ).toBe(true);
    const codeArtifact = artifacts.find(
      (artifact) => artifact.kind === "agent_code",
    );
    const codeVersion = versions.find(
      (version) => version.artifactId === codeArtifact?.id,
    );
    const codeBlob = getDb()
      .select()
      .from(ontocodeArtifactBlobs)
      .where(eq(ontocodeArtifactBlobs.id, codeVersion!.blobId))
      .get();
    expect(codeBlob?.contentText).toBe(
      "export const screenCandidateAgent = { async handler(input) { return input; } };",
    );
    expect(codeVersion?.blobHash).toBe(codeBlob?.sha256);

    const candidatePackage = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(
        and(
          eq(ontocodePackageVersions.tenantId, tenantId),
          eq(ontocodePackageVersions.sessionId, fixture.session.id),
        ),
      )
      .get();
    const candidateHead = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(
        and(
          eq(ontocodeCandidateHeads.tenantId, tenantId),
          eq(ontocodeCandidateHeads.sessionId, fixture.session.id),
        ),
      )
      .get();
    expect(candidatePackage).toMatchObject({
      sourceHarnessJobId: fixture.job.id,
      ontologyHash: factorySourceOntologyHash(ontology),
      status: "candidate_ready",
    });
    expect(candidatePackage?.dependencyRoot).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(candidatePackage!.executionOwnersJson)).toEqual({
      "screen-candidate-agent": "declarative_manifest",
    });
    expect(JSON.parse(candidatePackage!.artifactRefsJson)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent_spec" }),
        expect.objectContaining({ kind: "agent_code" }),
        expect.objectContaining({ kind: "agent_manifest" }),
        expect.objectContaining({ kind: "agent_config" }),
      ]),
    );
    expect(JSON.parse(candidatePackage!.validationJson)).toMatchObject({
      passed: true,
      sandboxEvidenceIncluded: false,
      releaseEligible: false,
    });
    expect(candidateHead).toMatchObject({
      packageVersionId: candidatePackage?.id,
      revision: 1,
    });

    const evidence = getDb()
      .select()
      .from(ontocodeEvidenceRecords)
      .where(
        and(
          eq(ontocodeEvidenceRecords.tenantId, tenantId),
          eq(ontocodeEvidenceRecords.harnessJobId, fixture.job.id),
        ),
      )
      .all();
    expect(evidence).toEqual([
      expect.objectContaining({
        sessionId: fixture.session.id,
        changeSetId: fixture.changeSetId,
        kind: "harness_build",
        outcome: "informational",
        state: "valid",
        subjectType: "candidate_package",
        subjectId: candidatePackage?.id,
        subjectDigest: candidatePackage?.dependencyRoot,
        producer: "ontocode-harness-worker/v1",
      }),
    ]);
    expect(JSON.parse(evidence[0]!.dependencySetJson)).toMatchObject({
      candidatePackageVersionId: candidatePackage?.id,
      candidateDependencyRoot: candidatePackage?.dependencyRoot,
    });
    expect(
      versions.some((version) => version.id === evidence[0]!.artifactVersionId),
    ).toBe(true);

    const countsBeforeReplay = {
      artifacts: artifacts.length,
      versions: versions.length,
      evidence: evidence.length,
      packages: 1,
      heads: 1,
    };
    await expect(worker.runNext()).resolves.toEqual({ claimed: false });
    expect(
      getDb()
        .select()
        .from(ontocodeArtifacts)
        .where(eq(ontocodeArtifacts.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(countsBeforeReplay.artifacts);
    expect(
      getDb()
        .select()
        .from(ontocodeArtifactVersions)
        .where(eq(ontocodeArtifactVersions.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(countsBeforeReplay.versions);
    expect(
      getDb()
        .select()
        .from(ontocodeEvidenceRecords)
        .where(eq(ontocodeEvidenceRecords.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(countsBeforeReplay.evidence);
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(countsBeforeReplay.packages);
    expect(
      getDb()
        .select()
        .from(ontocodeCandidateHeads)
        .where(eq(ontocodeCandidateHeads.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(countsBeforeReplay.heads);
  });

  it("never marks an incomplete Agent artifact set candidate_ready", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async () => ({
          outcome: "succeeded",
          receipt: {
            factoryRunId: "fake-incomplete-candidate",
            status: "finished",
            completionKind: "delivery",
            agents: [
              {
                slug: "screen-candidate-agent",
                actionName: "screenCandidate",
                spec: {
                  slug: "screen-candidate-agent",
                  actionName: "screenCandidate",
                },
              },
            ],
          },
        })),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(ontocodeCandidateHeads)
        .where(eq(ontocodeCandidateHeads.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(0);
  });

  /** Read one Candidate artifact's durable content by its logical name. */
  function readCandidateArtifact(sessionId: string, logicalName: string) {
    const artifact = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(
        and(
          eq(ontocodeArtifacts.sessionId, sessionId),
          eq(ontocodeArtifacts.logicalName, logicalName),
        ),
      )
      .get();
    if (!artifact) throw new Error(`missing Candidate artifact ${logicalName}`);
    const version = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(eq(ontocodeArtifactVersions.artifactId, artifact.id))
      .get();
    const blob = getDb()
      .select()
      .from(ontocodeArtifactBlobs)
      .where(eq(ontocodeArtifactBlobs.id, version!.blobId))
      .get();
    return blob!.contentText;
  }

  // #STRICT-DELIVERY — a Candidate Package claims these Agents can do the work.
  // An external system that is only "configurable later", "probe pending" or
  // "a human will do it" means they cannot, so the package must not be written.
  function buildReceiptWithBinding(
    binding: Record<string, unknown>,
    tools: string[] = [],
  ) {
    return vi.fn(async () => ({
      outcome: "succeeded" as const,
      receipt: {
        factoryRunId: "fake-integration-binding",
        status: "finished",
        completionKind: "delivery",
        agents: [
          {
            slug: "screen-candidate-agent",
            actionName: "screenCandidate",
            spec: {
              slug: "screen-candidate-agent",
              actionName: "screenCandidate",
              tools,
              generatedCode:
                "export const screenCandidateAgent = { async handler(input) { return input; } };",
              integrationBindings: [binding],
            },
          },
        ],
      },
    }));
  }

  async function expectCandidateRefused(binding: Record<string, unknown>) {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({ runBuild: buildReceiptWithBinding(binding) }),
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(0);
    return fixture;
  }

  it.each([
    ["needs_config", "凭证还没配"],
    ["needs_probe", "还没探通"],
    ["missing", "根本没有工具"],
    // A human boundary is an honest answer, but it is not an executable Agent.
    ["human_boundary", "人工来做"],
  ])(
    "refuses to write a Candidate Package when an integration is %s",
    async (status, reason) => {
      await expectCandidateRefused({
        requirement: {
          id: "req-1",
          actionName: "screenCandidate",
          system: "Internal_Recruitment_System",
          role: "write",
        },
        status,
        reason,
      });
    },
  );

  it("refuses a binding that claims resolved but carries no tool the Agent holds", async () => {
    await expectCandidateRefused({
      requirement: {
        id: "req-1",
        actionName: "screenCandidate",
        system: "Internal_Recruitment_System",
        role: "write",
      },
      status: "resolved",
      bindingKind: "tool",
      toolName: "recruitment.write",
      reason: "claimed",
    });
  });

  it("records the exact resolved binding in the Candidate config artifact", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: buildReceiptWithBinding(
          {
            requirement: {
              id: "req-1",
              actionName: "screenCandidate",
              system: "Internal_Recruitment_System",
              role: "write",
            },
            status: "resolved",
            bindingKind: "tool",
            toolName: "recruitment.write",
            reason: "bound to an authorized capability",
          },
          ["recruitment.write"],
        ),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    const config = JSON.parse(
      readCandidateArtifact(fixture.session.id, "package/runtime-config.json"),
    ) as {
      toolBindings: Array<{
        integrations: Array<Record<string, unknown>>;
      }>;
    };
    expect(config.toolBindings[0]?.integrations).toEqual([
      {
        requirementId: "req-1",
        system: "Internal_Recruitment_System",
        role: "write",
        status: "resolved",
        bindingKind: "tool",
        toolName: "recruitment.write",
        reason: "bound to an authorized capability",
      },
    ]);
  });

  // #DRAFT-BINDING — deploy promotes an on-disk draft version, so the Candidate
  // must name exactly which one it is, per Agent, or say plainly that it cannot.
  it("binds the Candidate to the exact Factory draft version it came from", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async () => ({
          outcome: "succeeded" as const,
          receipt: {
            factoryRunId: "fake-draft-bound",
            status: "finished",
            completionKind: "delivery",
            agents: [
              {
                slug: "screen-candidate-agent",
                actionName: "screenCandidate",
                draftVersionId: "v-20260728120000000-abcd1234",
                spec: {
                  slug: "screen-candidate-agent",
                  actionName: "screenCandidate",
                  generatedCode:
                    "export const screenCandidateAgent = { async handler(input) { return input; } };",
                },
              },
            ],
          },
        })),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      status: "succeeded",
    });
    const binding = JSON.parse(
      readCandidateArtifact(fixture.session.id, "package/factory-draft.json"),
    ) as {
      bound: boolean;
      draftVersionIds: string[];
      agents: Array<{ slug: string; draftVersionId: string }>;
    };
    expect(binding.bound).toBe(true);
    expect(binding.draftVersionIds).toEqual(["v-20260728120000000-abcd1234"]);
    expect(binding.agents[0]).toMatchObject({
      slug: "screen-candidate-agent",
      draftVersionId: "v-20260728120000000-abcd1234",
    });
  });

  it("records an unbound Candidate honestly instead of inventing a draft version", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      status: "succeeded",
    });
    const binding = JSON.parse(
      readCandidateArtifact(fixture.session.id, "package/factory-draft.json"),
    ) as { bound: boolean; unboundAgents: string[]; unboundReason: string };
    expect(binding.bound).toBe(false);
    expect(binding.unboundAgents).toEqual(["screen-candidate-agent"]);
    expect(binding.unboundReason).toContain("draft");
  });

  it("adds immutable versions to stable Agent artifacts across build iterations", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const firstWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });
    await expect(firstWorker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });

    const current = getOntoCodeSession({ tenantId }, fixture.session.id);
    const suffix = randomUUID().slice(0, 8);
    const { command, sessionRevision } = createOntoCodeCommand(
      fixture.ctx,
      fixture.session.id,
      {
        type: "generate_package",
        arguments: { actionIds: ["screen-candidate"] },
        expectedSessionRevision: current.revision,
        baseOntologyHash: factorySourceOntologyHash(ontology),
        affectedSemanticPaths: ["/agents/screen-candidate-agent"],
        riskClass: "draft_change",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: "Regenerate the candidate screening Agent",
        idempotencyKey: `command-iteration-${suffix}`,
      },
    );
    const { job } = createOntoCodeHarnessJob(fixture.ctx, fixture.session.id, {
      commandId: command.id,
      kind: "build",
      expectedSessionRevision: sessionRevision,
      idempotencyKey: `job-iteration-${suffix}`,
    });
    const revisedCode =
      "\nexport const screenCandidateAgent = { async handler(input) { return { ...input, revised: true }; } };\n";
    const secondWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async () => ({
          outcome: "succeeded",
          receipt: {
            factoryRunId: "fake-run-v2",
            status: "finished",
            completionKind: "delivery",
            agents: [
              {
                slug: "screen-candidate-agent",
                actionName: "screenCandidate",
                spec: {
                  slug: "screen-candidate-agent",
                  actionName: "screenCandidate",
                  generatedCode: revisedCode,
                },
              },
            ],
          },
        })),
      }),
    });
    await expect(secondWorker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "succeeded",
    });

    const codeArtifact = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(
        and(
          eq(ontocodeArtifacts.sessionId, fixture.session.id),
          eq(
            ontocodeArtifacts.logicalName,
            "agents/screen-candidate-agent/agent.ts",
          ),
        ),
      )
      .get();
    const versions = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(eq(ontocodeArtifactVersions.artifactId, codeArtifact!.id))
      .all()
      .sort((a, b) => a.version - b.version);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    const latestBlob = getDb()
      .select()
      .from(ontocodeArtifactBlobs)
      .where(eq(ontocodeArtifactBlobs.id, versions[1]!.blobId))
      .get();
    expect(latestBlob?.contentText).toBe(revisedCode);
    expect(latestBlob?.sha256).not.toBe(versions[0]!.blobHash);
    const packages = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .all()
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      );
    expect(packages).toHaveLength(2);
    expect(packages[1]?.parentVersionId).toBe(packages[0]?.id);
    expect(packages[1]?.dependencyRoot).not.toBe(packages[0]?.dependencyRoot);
    expect(
      getDb()
        .select()
        .from(ontocodeCandidateHeads)
        .where(eq(ontocodeCandidateHeads.sessionId, fixture.session.id))
        .get(),
    ).toMatchObject({
      packageVersionId: packages[1]?.id,
      revision: 2,
    });
  });

  it("asks for failure evidence before starting an automatic debug iteration", async () => {
    const fixture = makeQueuedJob({ kind: "debug" });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(factory.runBuild).not.toHaveBeenCalled();
    expect(getOntoCodeSession({ tenantId }, fixture.session.id)).toMatchObject({
      phase: "debug",
      activityState: "needs_user",
    });
    expect(
      listOntoCodeMessages({ tenantId }, fixture.session.id, {
        limit: 20,
        offset: 0,
      }).items,
    ).toEqual([
      expect.objectContaining({
        role: "assistant",
        type: "recommendation",
        content: expect.objectContaining({
          jobId: fixture.job.id,
          status: "waiting_user",
        }),
      }),
    ]);
  });

  it("refuses to queue Candidate verification before a Candidate Head exists", () => {
    let error: unknown;
    try {
      makeQueuedJob({ kind: "test" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "ontocode_candidate_head_missing",
      statusCode: 409,
    });
  });

  it("runs regression against the pinned Package refs without rebuilding or moving Candidate Head", async () => {
    const built = await buildExactCandidate();
    const packageRefs = JSON.parse(
      built.packageVersion.artifactRefsJson,
    ) as Array<{
      artifactId: string;
      artifactVersionId: string;
      logicalName: string;
      kind: string;
      blobHash: string;
    }>;
    const codeRef = packageRefs.find((ref) => ref.kind === "agent_code");
    if (!codeRef) throw new Error("Candidate package has no Agent Code ref");
    const exactVersion = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(eq(ontocodeArtifactVersions.id, codeRef.artifactVersionId))
      .get();
    const exactBlob = exactVersion
      ? getDb()
          .select()
          .from(ontocodeArtifactBlobs)
          .where(eq(ontocodeArtifactBlobs.id, exactVersion.blobId))
          .get()
      : null;
    if (!exactVersion || !exactBlob) {
      throw new Error("Candidate package Code ref does not resolve");
    }

    // Prove the worker reads Package.artifactRefs, not the numerically latest
    // version of the stable Artifact. This version is intentionally unheaded.
    const unheadedCode =
      "export const screenCandidateAgent = { async handler() { throw new Error('unheaded'); } };";
    const unheadedHash = createHash("sha256")
      .update(unheadedCode)
      .digest("hex");
    const unheadedBlobId = `ocb-unheaded-${randomUUID()}`;
    getDb()
      .insert(ontocodeArtifactBlobs)
      .values({
        id: unheadedBlobId,
        tenantId,
        sha256: unheadedHash,
        sizeBytes: Buffer.byteLength(unheadedCode),
        contentText: unheadedCode,
        createdAt: new Date(),
      })
      .run();
    getDb()
      .insert(ontocodeArtifactVersions)
      .values({
        id: `ocav-unheaded-${randomUUID()}`,
        tenantId,
        artifactId: codeRef.artifactId,
        sessionId: built.fixture.session.id,
        changeSetId: null,
        blobId: unheadedBlobId,
        version: exactVersion.version + 1,
        blobHash: unheadedHash,
        contentType: "text/typescript",
        sizeBytes: Buffer.byteLength(unheadedCode),
        metadataJson: JSON.stringify({ testOnly: "unheaded-version" }),
        idempotencyKey: `test-unheaded-${randomUUID()}`,
        createdBy: "test-fde",
        createdAt: new Date(),
      })
      .run();

    const testCases: OntoCodeCandidateTestCase[] = [
      {
        id: "candidate-happy",
        entryEvent: "CANDIDATE_RECEIVED",
        payload: { subject: "candidate-001" },
        kind: "pass",
        expectedEvent: "CANDIDATE_SCREENED",
      },
    ];
    const { job } = queueExactCandidateTest(built, {
      kind: "regression",
      testCases,
    });
    expect(job).toMatchObject({
      candidatePackageVersionId: built.packageVersion.id,
      candidateDependencyRoot: built.packageVersion.dependencyRoot,
      candidateHeadId: built.head.id,
      candidateHeadRevision: built.head.revision,
      testCases,
    });

    const agentArtifactsBefore = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(eq(ontocodeArtifacts.sessionId, built.fixture.session.id))
      .all()
      .filter((artifact) =>
        ["agent_spec", "agent_code", "agent_manifest", "agent_config"].includes(
          artifact.kind,
        ),
      );
    const agentArtifactIds = new Set(
      agentArtifactsBefore.map((artifact) => artifact.id),
    );
    const agentVersionCountBefore = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(
        eq(
          ontocodeArtifactVersions.sessionId,
          built.fixture.session.id,
        ),
      )
      .all()
      .filter((version) => agentArtifactIds.has(version.artifactId)).length;
    const headBefore = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, built.head.id))
      .get();

    const runCandidateTest = vi.fn(
      async (input: Parameters<
        NonNullable<OntoCodeFactoryHarnessAdapter["runCandidateTest"]>
      >[0]) => {
        expect(input).toMatchObject({
          packageVersionId: built.packageVersion.id,
          dependencyRoot: built.packageVersion.dependencyRoot,
          domain: ontology.domainId,
          testCases,
        });
        expect(input.specs).toEqual([
          expect.objectContaining({
            slug: "screen-candidate-agent",
            generatedCode: exactBlob.contentText,
          }),
        ]);
        expect(input.specs[0]?.generatedCode).not.toBe(unheadedCode);
        return successfulDevelopmentSandbox(
          built.packageVersion.dependencyRoot,
        );
      },
    );
    const factory = fakeFactory({ runCandidateTest });
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "succeeded",
    });
    expect(runCandidateTest).toHaveBeenCalledTimes(1);
    expect(factory.runBuild).not.toHaveBeenCalled();

    const headAfter = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, built.head.id))
      .get();
    expect(headAfter).toMatchObject({
      id: headBefore?.id,
      packageVersionId: headBefore?.packageVersionId,
      revision: headBefore?.revision,
    });
    expect(
      getDb()
        .select()
        .from(ontocodeArtifacts)
        .where(eq(ontocodeArtifacts.sessionId, built.fixture.session.id))
        .all()
        .filter((artifact) =>
          ["agent_spec", "agent_code", "agent_manifest", "agent_config"].includes(
            artifact.kind,
          ),
        ),
    ).toHaveLength(agentArtifactsBefore.length);
    expect(
      getDb()
        .select()
        .from(ontocodeArtifactVersions)
        .where(
          eq(
            ontocodeArtifactVersions.sessionId,
            built.fixture.session.id,
          ),
        )
        .all()
        .filter((version) => agentArtifactIds.has(version.artifactId)),
    ).toHaveLength(agentVersionCountBefore);

    const evidence = getDb()
      .select()
      .from(ontocodeEvidenceRecords)
      .where(eq(ontocodeEvidenceRecords.harnessJobId, job.id))
      .get();
    expect(evidence).toMatchObject({
      kind: "harness_regression",
      outcome: "passed",
      state: "valid",
      subjectType: "candidate_package",
      subjectId: built.packageVersion.id,
      subjectDigest: built.packageVersion.dependencyRoot,
    });
    expect(JSON.parse(evidence!.dependencySetJson)).toMatchObject({
      candidatePackageVersionId: built.packageVersion.id,
      candidateDependencyRoot: built.packageVersion.dependencyRoot,
      candidateHeadId: built.head.id,
      candidateHeadRevision: built.head.revision,
      testSuiteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ontocodeSandboxAttemptId: expect.stringMatching(/^ocsa-/),
      sandboxQualification: "development_only",
    });
    expect(
      getDb()
        .select()
        .from(ontocodeSandboxAttempts)
        .where(eq(ontocodeSandboxAttempts.harnessJobId, job.id))
        .get(),
    ).toMatchObject({
      packageVersionId: built.packageVersion.id,
      dependencyRoot: built.packageVersion.dependencyRoot,
      status: "succeeded",
      qualification: "development_only",
    });
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.id, built.packageVersion.id))
        .get(),
    ).toMatchObject({ status: "candidate_ready" });
  });

  it("waits for explicit Candidate Test Cases without invoking the Sandbox", async () => {
    const built = await buildExactCandidate();
    const { job } = queueExactCandidateTest(built);
    expect(job).toMatchObject({
      candidatePackageVersionId: built.packageVersion.id,
      candidateDependencyRoot: built.packageVersion.dependencyRoot,
      candidateHeadId: built.head.id,
      candidateHeadRevision: built.head.revision,
      testCases: [],
    });
    const headBefore = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, built.head.id))
      .get();
    const runCandidateTest = vi.fn(async () =>
      successfulDevelopmentSandbox(built.packageVersion.dependencyRoot),
    );
    const factory = fakeFactory({ runCandidateTest });
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "waiting_user",
    });
    expect(runCandidateTest).not.toHaveBeenCalled();
    expect(factory.runBuild).not.toHaveBeenCalled();
    expect(
      getDb()
        .select()
        .from(ontocodeSandboxAttempts)
        .where(eq(ontocodeSandboxAttempts.harnessJobId, job.id))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(ontocodeCandidateHeads)
        .where(eq(ontocodeCandidateHeads.id, built.head.id))
        .get(),
    ).toMatchObject({
      packageVersionId: headBefore?.packageVersionId,
      revision: headBefore?.revision,
    });
    expect(
      getDb()
        .select()
        .from(ontocodeEvidenceRecords)
        .where(eq(ontocodeEvidenceRecords.harnessJobId, job.id))
        .get(),
    ).toMatchObject({
      outcome: "informational",
      state: "valid",
      subjectType: "candidate_package",
      subjectId: built.packageVersion.id,
      subjectDigest: built.packageVersion.dependencyRoot,
    });
  });

  it("rejects Candidate Head drift before any execution or evidence side effect", async () => {
    const built = await buildExactCandidate();
    const { job } = queueExactCandidateTest(built, {
      testCases: [
        {
          id: "candidate-happy",
          entryEvent: "CANDIDATE_RECEIVED",
          payload: { subject: "candidate-drift" },
          kind: "pass",
        },
      ],
    });
    getDb()
      .update(ontocodeCandidateHeads)
      .set({
        revision: built.head.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(ontocodeCandidateHeads.id, built.head.id))
      .run();

    const runCandidateTest = vi.fn(async () =>
      successfulDevelopmentSandbox(built.packageVersion.dependencyRoot),
    );
    const factory = fakeFactory({ runCandidateTest });
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "failed_recoverable",
    });
    expect(factory.fetchOntology).not.toHaveBeenCalled();
    expect(factory.runBuild).not.toHaveBeenCalled();
    expect(runCandidateTest).not.toHaveBeenCalled();
    expect(
      getDb()
        .select()
        .from(ontocodeSandboxAttempts)
        .where(eq(ontocodeSandboxAttempts.harnessJobId, job.id))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(ontocodeEvidenceRecords)
        .where(eq(ontocodeEvidenceRecords.harnessJobId, job.id))
        .all(),
    ).toHaveLength(0);
    const failureEvent = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, job.id),
          eq(ontocodeSessionEvents.type, "harness.job.failed"),
        ),
      )
      .get();
    expect(JSON.parse(failureEvent!.payloadJson)).toMatchObject({
      executionStarted: false,
      error: {
        code: "candidate_head_drift",
        retryable: false,
      },
    });
  });

  it("retries transient executor failures and stops at maxAttempts", async () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    // Keep the independently leased fixture from the first test younger than
    // the worker's stale-lease window.
    let now = 2_000_000_000_500;
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 2,
      now: () => now,
      executors: {
        scope: async () => {
          throw new OntoCodeHarnessExecutionError(
            "temporary_model_failure",
            "The scope model is temporarily unavailable",
            { recoverable: true, retryable: true },
          );
        },
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "retry_scheduled",
    });
    expect(
      getDb()
        .select({ id: ontocodeSessionEvents.id })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.job.started"),
          ),
        )
        .all(),
    ).toHaveLength(1);
    now += 1;
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id).status).toBe(
      "failed_recoverable",
    );
    const types = getDb()
      .select({ type: ontocodeSessionEvents.type })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all()
      .map((row) => row.type);
    expect(types.filter((type) => type === "harness.job.started")).toHaveLength(
      2,
    );
    expect(types).toContain("harness.job.retry_scheduled");
    expect(types).toContain("harness.job.failed");
  });

  it("fails a wall-clock timeout once instead of replaying the same expensive work", async () => {
    // Generative kinds now only warn on wall-clock overruns
    // (resolveWallClockPolicy); deploy keeps the hard kill this test pins.
    const fixture = makeQueuedJob({
      kind: "deploy",
      budget: {
        maxWallClockMs: 20,
        maxModelCalls: 1,
        maxToolCalls: 1,
      },
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 3,
      executors: {
        deploy: () => new Promise(() => {}),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      status: "failed_recoverable",
      errorMessage: expect.stringContaining("wall-clock budget"),
    });
    const types = getDb()
      .select({ type: ontocodeSessionEvents.type })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all()
      .map((row) => row.type);
    expect(types.filter((type) => type === "harness.job.started")).toHaveLength(
      1,
    );
    expect(types).not.toContain("harness.job.retry_scheduled");
    expect(types).toContain("harness.job.failed");
  });

  // #RELEASE — deploy used to die with `executor_not_available`, an internal
  // error that told the FDE nothing. It now evaluates the real preconditions and
  // parks on what is actually missing, without promoting anything.
  it("requires durable approval, then parks deploy on the real unmet precondition", async () => {
    const fixture = makeQueuedJob({
      kind: "deploy",
      requiresHuman: true,
      riskClass: "production_deploy",
      commandType: "deploy_release",
    });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(factory.runBuild).not.toHaveBeenCalled();
    // Nothing was promoted: there is no candidate to promote in the first place.
    const events = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.sessionId, fixture.session.id))
      .all();
    const preflight = events.find(
      (event) => event.type === "harness.deploy.preflight",
    );
    expect(preflight).toBeDefined();
    expect(JSON.parse(preflight!.payloadJson)).toMatchObject({
      deployable: false,
      blockers: ["no_candidate"],
    });
    expect(
      events.some((event) => event.type === "harness.deploy.promoted"),
    ).toBe(false);
  });

  it("asks for a human review receipt instead of promoting an unreviewed version", async () => {
    // Everything else clears; only the human signature is missing. The worker
    // can never mint that receipt, so the honest outcome is to ask for it.
    const built = await buildExactCandidate();
    getDb()
      .update(ontocodePackageVersions)
      .set({ status: "verified_candidate" })
      .where(eq(ontocodePackageVersions.id, built.packageVersion.id))
      .run();
    const suffix = randomUUID().slice(0, 8);
    const current = getOntoCodeSession({ tenantId }, built.fixture.session.id);
    const { command, sessionRevision } = createOntoCodeCommand(
      built.fixture.ctx,
      built.fixture.session.id,
      {
        type: "deploy_release",
        arguments: {},
        expectedSessionRevision: current.revision,
        affectedSemanticPaths: [],
        riskClass: "production_deploy",
        requestedCapabilities: [],
        requiresHuman: true,
        rationaleSummary: "Deploy",
        idempotencyKey: `deploy-cmd-${suffix}`,
      },
    );
    const revision = decideOntoCodeCommand(
      built.fixture.ctx,
      command.id,
      "approve",
      { expectedSessionRevision: sessionRevision },
    ).sessionRevision;
    getDb()
      .insert(ontocodeSandboxAttempts)
      .values({
        id: `ocsa-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        tenantId,
        projectId: built.fixture.project.id,
        sessionId: built.fixture.session.id,
        harnessJobId: built.fixture.job.id,
        ordinal: 9,
        packageVersionId: built.packageVersion.id,
        dependencyRoot: built.packageVersion.dependencyRoot,
        ontologyHash: built.packageVersion.ontologyHash,
        testSuiteHash: "d".repeat(64),
        candidateFingerprint: built.packageVersion.dependencyRoot,
        status: "succeeded",
        qualification: "promotable",
        executionOrigin: "remote",
        isolationTier: "dedicated_host",
        idempotencyKey: `deploy-att-${suffix}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    createOntoCodeHarnessJob(built.fixture.ctx, built.fixture.session.id, {
      commandId: command.id,
      kind: "deploy",
      expectedSessionRevision: revision,
      idempotencyKey: `deploy-job-${suffix}`,
    });

    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      status: "waiting_user",
    });
    const promoted = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.sessionId, built.fixture.session.id))
      .all()
      .some((event) => event.type === "harness.deploy.promoted");
    expect(promoted).toBe(false);
    // The candidate is untouched — no release was recorded.
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.id, built.packageVersion.id))
        .get()?.status,
    ).toBe("verified_candidate");
  });
});
