import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeConfigurationTasks,
  ontocodeHarnessJobs,
  ontocodeProjects,
  ontocodeSessionEvents,
  tenants,
} from "@agentic/db";
import type { DomainOntology } from "@agentic/agent-factory";
import { factorySourceOntologyHash } from "@agentic/agent-factory";
import { OntoCodeStructuredQuestionSchema } from "@agentic/contracts";
import {
  cancelOntoCodeSessionJob,
  createOntoCodeArtifact,
  createOntoCodeCommand,
  createOntoCodeHarnessJob,
  createOntoCodeProject,
  createOntoCodeSession,
  createOntoCodeTurn,
  decideOntoCodeCommand,
  getOntoCodeHarnessJob,
  getOntoCodeSession,
} from "../src/services/ontocode-session-store";
import {
  setOntoCodeConfigurationTaskVerifier,
  verifyOntoCodeConfigurationTask,
  type OntoCodeConfigurationTaskVerifier,
} from "../src/services/ontocode-configuration-task-store";
import { createOntoCodeConfigurationTaskVerifier } from "../src/services/ontocode-configuration-task-verifier";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  buildStructuredWaitingQuestion,
  compactFactoryReadiness,
  createConfigurationTaskForWaitingJob,
  OntoCodeHarnessWorkerAdapter,
  type OntoCodeFactoryHarnessAdapter,
} from "../src/services/ontocode-harness-worker";
import { buildTestEnv } from "./harness";

const ontology: DomainOntology = {
  domainId: "ontocode-build-budget-test",
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
  ],
  events: [
    {
      name: "CANDIDATE_RECEIVED",
      consumers: ["screenCandidate"],
      payload: {
        source_action: null,
        event_data: [
          { name: "candidate", type: "object", target_object: "Candidate" },
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
          { name: "result", type: "object", target_object: "Candidate" },
        ],
        state_mutations: [],
      },
    },
  ],
  workflow: [],
};

const ontologyHash = factorySourceOntologyHash(ontology);

function successfulBuildReceipt(factoryRunId = "fake-run"): {
  outcome: "succeeded";
  receipt: Record<string, unknown>;
} {
  return {
    outcome: "succeeded",
    receipt: {
      factoryRunId,
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
  };
}

function fakeFactory(
  overrides: Partial<OntoCodeFactoryHarnessAdapter> = {},
): OntoCodeFactoryHarnessAdapter {
  return {
    fetchOntology: vi.fn(async () => ontology),
    recommendScope: vi.fn(async () => {
      throw new Error("scope recommendation is not part of this test");
    }),
    runBuild: vi.fn(async (input) =>
      successfulBuildReceipt(input.engineRunId ?? "fake-run"),
    ),
    ...overrides,
  };
}

const sourceRequirementId = "9-1:integration:6";
const blockedSystem = "GoHire_System";

function credentialGapWaitingReceipt(): Record<string, unknown> {
  return {
    schema: "ontocode-build-receipt/v1",
    status: "waiting_human",
    completionKind: "awaiting_input",
    ontologyHash,
    interaction: {
      kind: "clarify",
      awaitingAnswer: true,
      question: "请为 GoHire_System 提供已授权的 Tool/API 契约。",
    },
    readiness: {
      schema: "ontocode-factory-readiness/v1",
      source: "ontology.agent_actions",
      reason: "catalog_readiness_requires_authoritative_input",
      next: "ask_user",
      totals: {
        total: 1,
        ready: 0,
        blocked: 1,
        readyActions: [],
        blockedActions: ["screenCandidate"],
      },
      actions: [
        {
          action: "screenCandidate",
          ready: false,
          stages: { authoring: false, sandbox: false, promotion: false },
          unresolvedBindings: [
            {
              requirementId: sourceRequirementId,
              system: blockedSystem,
              kind: "external_api",
              role: "execute",
              status: "missing",
              executionSurface: null,
              reason: "No authorized capability covers candidate.screening",
            },
          ],
        },
      ],
    },
  };
}

function toolProfileGapWaitingReceipt(): Record<string, unknown> {
  return {
    schema: "ontocode-build-receipt/v1",
    status: "waiting_human",
    completionKind: "awaiting_input",
    ontologyHash,
    agents: [
      {
        slug: "screen-candidate",
        actionName: "screenCandidate",
        name: "Candidate screener",
      },
    ],
    interaction: {
      kind: "clarify",
      awaitingAnswer: true,
      question:
        "screenCandidate 已可生成草稿，但 GoHire_System 的 sandbox Tool Profile 尚未配置。",
    },
    readiness: {
      schema: "ontocode-factory-readiness/v1",
      source: "generation.directive.agent_actions",
      reason: "catalog_readiness_requires_authoritative_input",
      next: "ask_user",
      totals: {
        total: 1,
        ready: 1,
        blocked: 0,
        readyActions: ["screenCandidate"],
        blockedActions: [],
      },
      actions: [
        {
          action: "screenCandidate",
          ready: true,
          stages: { authoring: true, sandbox: false, promotion: false },
          unresolvedBindings: [
            {
              requirementId: sourceRequirementId,
              system: blockedSystem,
              kind: "external_api",
              role: "execute",
              status: "needs_config",
              executionSurface: "generateJdApi",
              configuration: {
                kind: "tool_profile",
                toolName: "generateJdApi",
                environment: "sandbox",
                profileKey: "ontocode-screencandidate-gohire-system",
                fields: [
                  {
                    key: "api_key_env",
                    type: "string",
                    required: true,
                    description: "API key environment variable name",
                    allowedValues: [],
                  },
                  {
                    key: "base_url_env",
                    type: "string",
                    required: true,
                    description: "Base URL environment variable name",
                    allowedValues: [],
                  },
                ],
              },
              reason:
                "generateJdApi has no confirmed sandbox integration profile",
            },
          ],
        },
      ],
    },
  };
}

describe("OntoCode Harness build budget + structured waiting", () => {
  let tenantId: string;
  let originalBinding: FactoryDomainBinding | null;
  const projectIds: string[] = [];

  it("preserves an action-scoped readiness result as an exact Tool Profile receipt", () => {
    const compact = compactFactoryReadiness({
      t: "tool.result",
      id: "readiness-1",
      name: "inspect_action_readiness",
      ok: true,
      summary: "authoring ready; sandbox profile missing",
      output: JSON.stringify({
        action: "screenCandidate",
        ready: true,
        readOnly: true,
        compact: {
          action: "screenCandidate",
          ready: true,
          readOnly: true,
          stages: {
            authoring: true,
            sandbox: false,
            promotion: false,
          },
          blockers: {
            integration: {
              unresolvedBindings: [
                {
                  requirementId: sourceRequirementId,
                  system: blockedSystem,
                  kind: "external_api",
                  role: "execute",
                  status: "needs_config",
                  executionSurface: "generateJdApi",
                  configuration: {
                    kind: "tool_profile",
                    toolName: "generateJdApi",
                    environment: "sandbox",
                    profileKey: "ontocode-screencandidate-gohire-system",
                    fields: [
                      {
                        key: "api_key_env",
                        type: "string",
                        required: true,
                        description: "Server env reference",
                        allowedValues: [],
                      },
                    ],
                  },
                  reason: "sandbox profile missing",
                },
              ],
            },
          },
        },
      }),
    });

    expect(compact).toMatchObject({
      source: "inspect_action_readiness",
      totals: {
        total: 1,
        ready: 1,
        blocked: 0,
        readyActions: ["screenCandidate"],
      },
      actions: [
        {
          action: "screenCandidate",
          ready: true,
          stages: {
            authoring: true,
            sandbox: false,
            promotion: false,
          },
          unresolvedBindings: [
            {
              requirementId: sourceRequirementId,
              executionSurface: "generateJdApi",
              configuration: {
                kind: "tool_profile",
                toolName: "generateJdApi",
                profileKey: "ontocode-screencandidate-gohire-system",
                fields: [{ key: "api_key_env" }],
              },
            },
          ],
        },
      ],
    });
  });

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
      { id: ontology.domainId, name: "OntoCode build budget test Ontology" },
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
    kind: "build" | "simulation";
    budget?: { maxWallClockMs?: number };
  }) {
    const suffix = randomUUID().slice(0, 8);
    const ctx = { tenantId, actorId: "test-fde" };
    const { project } = createOntoCodeProject(ctx, {
      domain: ontology.domainId,
      name: `Budget test ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Budget session ${suffix}`,
      goal: "Screen candidates",
      autonomyMode: "copilot",
      ontologySnapshotHash: ontologyHash,
    });
    const { command, sessionRevision } = createOntoCodeCommand(
      ctx,
      session.id,
      {
        type:
          input.kind === "build" ? "generate_package" : "verify_configuration",
        arguments:
          input.kind === "build" ? { actionIds: ["screen-candidate"] } : {},
        expectedSessionRevision: session.revision,
        affectedSemanticPaths: [],
        riskClass: input.kind === "build" ? "draft_change" : "read_only",
        requestedCapabilities: [],
        requiresHuman: input.kind === "build",
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
    const { job } = createOntoCodeHarnessJob(ctx, session.id, {
      commandId: command.id,
      kind: input.kind,
      expectedSessionRevision: revision,
      idempotencyKey: `job-${suffix}`,
      ...(input.budget ? { budget: input.budget } : {}),
    });
    return { ctx, project, session, command, job };
  }

  it("budgets a follow-up Build turn for the scope it continues, not for its own label", () => {
    // A live six-Action Build lost its generated agents here: the FDE's "save
    // the draft" turn was routed to `patch_artifact`, whose flat 8/20/120s
    // allowance overwrote the running conversation's 30/74/900s budget and the
    // terminal `save_draft` never got a turn.
    const suffix = randomUUID().slice(0, 8);
    const ctx = { tenantId, actorId: "test-fde" };
    const { project } = createOntoCodeProject(ctx, {
      domain: ontology.domainId,
      name: `Continuation budget ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Continuation budget session ${suffix}`,
      goal: "Generate the full recruiting fleet",
      autonomyMode: "sandbox_autopilot",
      ontologySnapshotHash: ontologyHash,
    });

    // The immutable Action scope lives in the server-produced Scope receipt —
    // the same place a real follow-up turn has to recover it from.
    createOntoCodeArtifact(ctx, session.id, {
      expectedSessionRevision: getOntoCodeSession(ctx, session.id).revision,
      logicalName: "harness/scope/receipt",
      kind: "harness_receipt",
      semanticPath: "/harness/scope",
      content: JSON.stringify({
        scope: {
          actionIds: [
            "createJD",
            "processResume",
            "ruleCheckForCandidateIdentity",
            "ruleCheckForMatchResume",
            "matchResume",
            "inviteInternalInterview",
          ],
        },
      }),
      contentType: "application/json",
      metadata: {},
      idempotencyKey: `scope-receipt-${suffix}`,
    });

    const turn = createOntoCodeTurn(ctx, session.id, {
      text: "保存上一轮设计的 6 个 Agent 草稿",
      behavior: "execute",
      action: "patch_artifact",
      arguments: { instruction: "保存上一轮设计的 6 个 Agent 草稿" },
      affectedSemanticPaths: [],
      requestedCapabilities: [],
      expectedSessionRevision: getOntoCodeSession(ctx, session.id).revision,
      idempotencyKey: `continuation-turn-${suffix}`,
    });

    expect(turn.command?.type).toBe("patch_artifact");
    expect(turn.job?.kind).toBe("build");
    expect(turn.job?.budget).toEqual({
      maxWallClockMs: 900_000,
      maxModelCalls: 30,
      maxToolCalls: 74,
    });

    // This suite's other cases claim work with `worker.runNext()`; leaving this
    // job queued would hand them the wrong job.
    cancelOntoCodeSessionJob(ctx, session.id, { jobId: turn.job!.id });
  });

  function jobEvents(
    jobId: string,
  ): Array<{ type: string; payload: Record<string, unknown> }> {
    return getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, jobId))
      .all()
      .map((row) => ({
        type: row.type,
        payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
      }));
  }

  function sessionConfigurationTasks(sessionId: string) {
    return getDb()
      .select()
      .from(ontocodeConfigurationTasks)
      .where(
        and(
          eq(ontocodeConfigurationTasks.tenantId, tenantId),
          eq(ontocodeConfigurationTasks.sessionId, sessionId),
        ),
      )
      .all();
  }

  it("warns once on a build wall-clock overrun and lets the job finish", async () => {
    const fixture = makeQueuedJob({
      kind: "build",
      budget: { maxWallClockMs: 10 },
    });
    const factory = fakeFactory({
      runBuild: vi.fn(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return successfulBuildReceipt(input.engineRunId ?? "fake-run");
      }),
    });
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id).status).toBe(
      "succeeded",
    );

    const warnings = jobEvents(fixture.job.id).filter(
      (event) => event.type === "harness.job.budget_warning",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.payload).toMatchObject({
      jobId: fixture.job.id,
      kind: "build",
      limitMs: 10,
    });
    expect(warnings[0]!.payload.elapsedMs).toBeGreaterThanOrEqual(10);
  });

  it("still kills a kill-policy kind on wall-clock overrun", async () => {
    const fixture = makeQueuedJob({
      kind: "simulation",
      budget: { maxWallClockMs: 20 },
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 3,
      executors: {
        simulation: () => new Promise(() => {}),
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
    const types = jobEvents(fixture.job.id).map((event) => event.type);
    expect(types).not.toContain("harness.job.budget_warning");
    expect(types).not.toContain("harness.job.retry_scheduled");
    expect(types).toContain("harness.job.failed");
  });

  it("wraps a waiting clarification into a structured decision question", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const message =
      "动作「processResume」目前还不能生成可靠草稿。请确认哪些真实工具负责连接这些系统（processResume）";
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message,
          receipt: {
            schema: "ontocode-build-receipt/v1",
            status: "waiting_human",
            completionKind: "awaiting_input",
            ontologyHash,
            interaction: {
              kind: "clarify",
              awaitingAnswer: true,
              question: message,
            },
          },
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      status: "waiting_user",
      errorMessage: message,
    });

    const waiting = jobEvents(fixture.job.id).find(
      (event) => event.type === "harness.build.waiting_user",
    );
    expect(waiting).toBeTruthy();
    const question = OntoCodeStructuredQuestionSchema.parse(
      waiting!.payload.question,
    );
    expect(question).toMatchObject({
      kind: "decision",
      allowOther: true,
      question: message,
      systems: [],
    });
    expect(sessionConfigurationTasks(fixture.session.id)).toHaveLength(0);
  });

  it("classifies credential wording as a config question without inventing a task", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const message =
      "RoboHire_System 的 API key 凭证未配置，请在集成设置中补齐后继续。";
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message,
          receipt: {
            schema: "ontocode-build-receipt/v1",
            status: "waiting_human",
            completionKind: "awaiting_input",
            ontologyHash,
            interaction: {
              kind: "clarify",
              awaitingAnswer: true,
              question: message,
            },
          },
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    const waiting = jobEvents(fixture.job.id).find(
      (event) => event.type === "harness.build.waiting_user",
    );
    const question = OntoCodeStructuredQuestionSchema.parse(
      waiting!.payload.question,
    );
    expect(question.kind).toBe("config");
    expect(question.systems).toContain("RoboHire_System");
    // Prose alone must not authorize a Configuration Task: the immutable
    // receipt carries no unresolved requirement, so nothing is created.
    expect(sessionConfigurationTasks(fixture.session.id)).toHaveLength(0);
  });

  it("maps batch configuration items to named systems instead of array position", () => {
    const question = buildStructuredWaitingQuestion(
      "build",
      "RAAS_System、GoHire_System、Allmeta_Ontology_System 的 sandbox API key 配置待确认；Job_Posting 是业务对象。",
      {
        interaction: {
          kind: "clarify",
          awaitingAnswer: true,
          items: [
            { question: "RAAS 读写 sandbox 怎么继续？" },
            { question: "GoHire sandbox 怎么处理？" },
            { question: "Allmeta 镜像写入如何推进？" },
          ],
        },
      },
    );

    expect(question.items?.map((item) => item.systems)).toEqual([
      ["RAAS_System"],
      ["GoHire_System"],
      ["Allmeta_Ontology_System"],
    ]);
  });

  it("uses an executor-provided structured question verbatim", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const provided = {
      id: "q-fixed",
      kind: "authorization" as const,
      question: "确认允许对生产环境执行此变更？",
      options: [{ label: "允许", value: "approve", recommended: true }],
      allowOther: false,
      systems: [],
    };
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message: "需要你的授权决定。",
          question: provided,
          receipt: {
            schema: "ontocode-build-receipt/v1",
            status: "waiting_human",
            completionKind: "awaiting_input",
            ontologyHash,
          },
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    const waiting = jobEvents(fixture.job.id).find(
      (event) => event.type === "harness.build.waiting_user",
    );
    expect(
      OntoCodeStructuredQuestionSchema.parse(waiting!.payload.question),
    ).toEqual(provided);
  });

  it("creates one resumable configuration task for a receipt-authorized credential gap", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const message =
      "系统「GoHire_System」的 gohire 凭证未配置，动作 screenCandidate 暂时无法生成可靠草稿。";
    const receipt = credentialGapWaitingReceipt();
    const factory = fakeFactory({
      runBuild: vi.fn(async (input) => ({
        outcome: "waiting_user" as const,
        message,
        receipt: {
          ...receipt,
          factoryRunId: input.engineRunId!,
        },
      })),
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });

    const tasks = sessionConfigurationTasks(fixture.session.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({
      status: "open",
      waitingHarnessJobId: fixture.job.id,
      sourceRequirementId,
      sourceActionName: "screenCandidate",
      resumeAction: "generate_package",
      idempotencyKey: `worker:${fixture.job.id}:config`,
    });
    expect(JSON.parse(task.targetJson)).toMatchObject({
      kind: "tool",
      system: blockedSystem,
      desiredToolName: null,
      requirementKind: "external_api",
      requirementRole: "execute",
    });
    expect(JSON.parse(task.verificationPolicyJson)).toEqual({
      kind: "tool_contract",
    });

    // A repeated waiting finalization derives the identical task input and
    // attaches to the existing row instead of duplicating it.
    const again = createConfigurationTaskForWaitingJob({
      tenantId,
      actorId: "test-fde",
      sessionId: fixture.session.id,
      jobId: fixture.job.id,
      jobKind: "build",
      receipt,
      question: buildStructuredWaitingQuestion("build", message, receipt),
    });
    expect(again).toMatchObject({ taskId: task.id, mode: "attached" });
    expect(sessionConfigurationTasks(fixture.session.id)).toHaveLength(1);

    // The four resume fields must actually satisfy the resume guard: a passed
    // verification resumes the exact waiting operation.
    const passedVerifier: OntoCodeConfigurationTaskVerifier = {
      verify: async () => ({
        outcome: "passed",
        code: "tool_contract_verified",
        summary:
          "One persisted executable Tool now covers the exact system, integration kind, and role.",
        resourceDigest: "d".repeat(64),
        refs: [`configuration-task:${task.id}`],
      }),
    };
    setOntoCodeConfigurationTaskVerifier(passedVerifier);
    try {
      const verified = await verifyOntoCodeConfigurationTask(
        { tenantId, actorId: "test-fde" },
        task.id,
        {
          expectedRevision: task.revision,
          idempotencyKey: `verify-${fixture.job.id}`,
        },
      );
      expect(verified.resumed).toBe(true);
      expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id).status).toBe(
        "cancelled",
      );
      const jobs = getDb()
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, fixture.session.id))
        .all();
      expect(jobs).toHaveLength(2);
      const continuation = jobs.find((row) => row.id !== fixture.job.id);
      expect(continuation).toMatchObject({
        kind: "build",
        // copilot confirms every mutating continuation, including a
        // configuration-triggered resume.
        status: "waiting_user",
      });
      // Park the continuation so later fixtures' runNext claims its own job.
      getDb()
        .update(ontocodeHarnessJobs)
        .set({ status: "cancelled" })
        .where(eq(ontocodeHarnessJobs.id, continuation!.id))
        .run();
    } finally {
      setOntoCodeConfigurationTaskVerifier(
        createOntoCodeConfigurationTaskVerifier(),
      );
    }
  });

  it("creates an exact Tool Profile task for an authorable action whose sandbox is not configured", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const receipt = toolProfileGapWaitingReceipt();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message:
            "screenCandidate 已可生成草稿，但 GoHire_System 的 sandbox Tool Profile 尚未配置。",
          receipt,
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });

    const tasks = sessionConfigurationTasks(fixture.session.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({
      waitingHarnessJobId: fixture.job.id,
      sourceRequirementId,
      sourceActionName: "screenCandidate",
      resumeAction: "generate_package",
    });
    expect(JSON.parse(task.targetJson)).toEqual({
      kind: "tool_profile",
      toolName: "generateJdApi",
      environment: "sandbox",
      profileKey: "ontocode-screencandidate-gohire-system",
    });
    expect(JSON.parse(task.verificationPolicyJson)).toEqual({
      kind: "tool_profile",
      toolName: "generateJdApi",
      environment: "sandbox",
      profileKey: "ontocode-screencandidate-gohire-system",
    });
    expect(JSON.parse(task.requirementJson)).toMatchObject({
      missingFields: [
        { key: "api_key_env", kind: "env_only", source: "tool" },
        { key: "base_url_env", kind: "env_only", source: "tool" },
      ],
    });
  });

  it("selects the exact receipt gap named by the waiting question instead of the first gap", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const receipt = toolProfileGapWaitingReceipt();
    const readiness = receipt.readiness as {
      actions: Array<{ unresolvedBindings: Array<Record<string, unknown>> }>;
    };
    readiness.actions[0]!.unresolvedBindings.unshift({
      requirementId: "9-1:integration:raas-read",
      system: "RAAS_System",
      kind: "database",
      role: "read",
      status: "needs_config",
      executionSurface: "facts.query",
      configuration: {
        kind: "tool_profile",
        toolName: "facts.query",
        environment: "sandbox",
        profileKey: "ontocode-screencandidate-raas-system",
        fields: [
          {
            key: "connection_url_env",
            type: "string",
            required: true,
            description: "Server env reference",
            allowedValues: [],
          },
        ],
      },
      reason: "sandbox profile missing",
    });
    const message =
      "请配置 generateJdApi 的 sandbox profile；GoHire base_url_env 和 api_key_env 只填服务器环境变量名。";
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message,
          receipt,
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    const tasks = sessionConfigurationTasks(fixture.session.id);
    expect(tasks).toHaveLength(1);
    expect(JSON.parse(tasks[0]!.targetJson)).toEqual({
      kind: "tool_profile",
      toolName: "generateJdApi",
      environment: "sandbox",
      profileKey: "ontocode-screencandidate-gohire-system",
    });
  });

  it("does not create a post-authoring Tool Profile task when the receipt has no authored agent", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const receipt = toolProfileGapWaitingReceipt();
    delete receipt.agents;
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message:
            "screenCandidate 的 sandbox Tool Profile 尚未配置，但没有设计产物。",
          receipt,
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(sessionConfigurationTasks(fixture.session.id)).toHaveLength(0);
  });

  it("skips task creation when the receipt names an execution surface or another blocker class", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const message = "系统「GoHire_System」的凭证未配置，无法继续。";
    const receipt = credentialGapWaitingReceipt();
    const readiness = receipt.readiness as {
      actions: Array<{ unresolvedBindings: Array<Record<string, unknown>> }>;
    };
    // An unauthorized-but-surfaced binding is a credentials/authorization
    // problem for a KNOWN surface; the store only authorizes missing
    // tool-contract gaps, so the worker must fail closed.
    readiness.actions[0]!.unresolvedBindings[0]!.executionSurface =
      "gohireMatchResumeApi";
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message,
          receipt,
        }),
      },
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    const waiting = jobEvents(fixture.job.id).find(
      (event) => event.type === "harness.build.waiting_user",
    );
    const question = OntoCodeStructuredQuestionSchema.parse(
      waiting!.payload.question,
    );
    expect(question.kind).toBe("config");
    expect(question.systems).toContain(blockedSystem);
    expect(sessionConfigurationTasks(fixture.session.id)).toHaveLength(0);
  });

  it("does not silently drop readiness gaps past its own scan limit", () => {
    /**
     * `waitingReadinessGaps` is the only structured credential-gap source — it
     * decides which configuration questions the FDE is ever asked. It scanned
     * `actions.slice(0, 200)` with no named constant, no override and NO
     * truncation signal, so a domain with more than 200 Actions lost the tail
     * entirely while the receipt still read as a complete check.
     *
     * The file already holds the right precedent: the telemetry budget emits a
     * `telemetry_truncated` notice because "a silently truncated trace reads as
     * 'the brain did this little', which is a lie about the run". A silently
     * truncated readiness scan tells the same lie about the delivery gate.
     */
    // The bound is now a named, env-overridable constant read at module load,
    // so the honest way to exercise the overflow path is to exceed the value
    // this process was started with rather than to hardcode 200 again here.
    const limit = Number(process.env.ONTOCODE_READINESS_MAX_ACTIONS) || 2_000;
    const actions = Array.from({ length: limit + 60 }, (_, i) => ({
      action: `action_${String(i).padStart(3, "0")}`,
      stages: { authoring: true },
      unresolvedBindings: [
        {
          requirementId: `req-${i}`,
          system: `System_${i}`,
          kind: "external_api",
          role: "execute",
          status: "needs_config",
          executionSurface: "sandbox",
        },
      ],
    }));

    const question = buildStructuredWaitingQuestion(
      "build",
      "多个系统的 sandbox 配置待确认。",
      {
        interaction: { kind: "clarify", awaitingAnswer: true },
        readiness: {
          schema: "ontocode-factory-readiness/v1",
          actions,
        },
      },
    );

    // The gaps past the boundary must not vanish without a word.
    // Coverage counts Actions AND their bindings: a binding dropped by the
    // per-action bound is a credential gap the FDE is never asked about, so it
    // has to move the same signal.
    expect(question.coverage).toMatchObject({ truncated: true });
    expect(question.coverage!.scanned).toBeLessThan(question.coverage!.total);
    expect(question.coverage!.total).toBeGreaterThanOrEqual(limit + 60);
  });
});
