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
  createOntoCodeCommand,
  createOntoCodeHarnessJob,
  createOntoCodeProject,
  createOntoCodeSession,
  decideOntoCodeCommand,
  getOntoCodeHarnessJob,
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

function successfulBuildReceipt(): {
  outcome: "succeeded";
  receipt: Record<string, unknown>;
} {
  return {
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
    runBuild: vi.fn(async () => successfulBuildReceipt()),
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

describe("OntoCode Harness build budget + structured waiting", () => {
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
        requiresHuman: false,
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

  function jobEvents(jobId: string): Array<{ type: string; payload: Record<string, unknown> }> {
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
      runBuild: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return successfulBuildReceipt();
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
      expect(continuation).toMatchObject({ kind: "build", status: "queued" });
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
});
