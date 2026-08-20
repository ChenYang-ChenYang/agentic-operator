import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifacts,
  ontocodeHarnessJobs,
  ontocodeProjects,
  tenants,
} from "@agentic/db";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  setOntoCodeConfigurationTaskVerifier,
  type OntoCodeConfigurationTaskVerifier,
} from "../src/services/ontocode-configuration-task-store";
import { createOntoCodeConfigurationTaskVerifier } from "../src/services/ontocode-configuration-task-verifier";
import { OntoCodeHarnessWorkerAdapter } from "../src/services/ontocode-harness-worker";
import { buildTestEnv, type TestEnv } from "./harness";
import { installOntoCodeTestOntology } from "./ontocode-ontology-fixture";

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

interface WaitingFixture {
  projectId: string;
  sessionId: string;
  sessionRevision: number;
  commandId: string;
  jobId: string;
}

interface ConfigurationTask {
  id: string;
  tenantId: string;
  sessionId: string;
  waitingHarnessJobId: string | null;
  sourceRequirementId: string | null;
  sourceActionName: string | null;
  sourceReceiptDigest: string | null;
  target:
    | {
        kind: "tool";
        system: string;
        desiredToolName: string | null;
        requirementKind: string | null;
        requirementRole: string | null;
      }
    | Record<string, unknown>;
  verificationPolicy: { kind: "tool_contract" } | Record<string, unknown>;
  status: "open" | "verifying" | "satisfied" | "cancelled" | "superseded";
  revision: number;
}

async function success<T>(response: Response): Promise<T> {
  return ((await response.json()) as SuccessEnvelope<T>).data;
}

async function failure(response: Response): Promise<ErrorEnvelope["error"]> {
  return ((await response.json()) as ErrorEnvelope).error;
}

describe("OntoCode Configuration Task receipt boundary", () => {
  let env: TestEnv;
  let tenantId: string;
  let projectId: string;
  let originalBinding: FactoryDomainBinding | null;
  let removeOntology: () => Promise<void>;

  const suffix = randomUUID().slice(0, 8);
  const domain = `ontocode-config-task-${suffix}`;
  let ontologyHash: string;
  const sourceActionName = "processResume";
  const sourceRequirementId = "9-1:integration:6";
  const blockedSystem = "Internal_Recruitment_System";

  beforeAll(async () => {
    env = await buildTestEnv();
    const tenant = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get();
    if (!tenant) throw new Error("__system test tenant is missing");
    tenantId = tenant.id;
    originalBinding = getFactoryDomainBinding(tenantId);
    const installed = await installOntoCodeTestOntology({
      tenantSlug: "__system",
      domainId: domain,
      name: "Configuration Task route test Ontology",
      actionName: sourceActionName,
    });
    ontologyHash = installed.ontologyHash;
    removeOntology = installed.remove;
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "Configuration Task route test Ontology" },
      "upload",
    );
    const projectResponse = await env.fetch("/v1/ontocode/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain,
        name: `Configuration Task project ${suffix}`,
      }),
    });
    expect(projectResponse.status).toBe(201);
    const project = await success<{ project: { id: string } }>(projectResponse);
    projectId = project.project.id;
  });

  afterAll(async () => {
    setOntoCodeConfigurationTaskVerifier(
      createOntoCodeConfigurationTaskVerifier(),
    );
    if (projectId) {
      getDb()
        .delete(ontocodeProjects)
        .where(eq(ontocodeProjects.id, projectId))
        .run();
    }
    await removeOntology?.();
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
    await env.cleanup();
  });

  async function createWaitingFixture(): Promise<WaitingFixture> {
    const fixtureSuffix = randomUUID().slice(0, 8);
    const sessionResponse = await env.fetch("/v1/ontocode/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        title: `Configuration Task session ${fixtureSuffix}`,
        goal: "Generate the Ontology-bound recruiting Agents",
        autonomyMode: "sandbox_autopilot",
        ontologySnapshotHash: ontologyHash,
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await success<{ session: { id: string } }>(sessionResponse);

    const turnResponse = await env.fetch(
      `/v1/ontocode/sessions/${session.session.id}/turns`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `config-task-turn-${fixtureSuffix}`,
        },
        body: JSON.stringify({
          text: "Generate the current Ontology package in the sandbox",
          behavior: "execute",
          action: "generate_package",
          arguments: { actionIds: ["process-resume"] },
          affectedSemanticPaths: [`ontology-action:${sourceActionName}`],
        }),
      },
    );
    expect(turnResponse.status).toBe(201);
    const turn = await success<{
      command: { id: string };
      job: { id: string };
    }>(turnResponse);

    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          phase: "build",
          message:
            "The external API has no authorized execution surface or Tool contract.",
          receipt: {
            schema: "ontocode-build-receipt/v1",
            status: "waiting_human",
            completionKind: "awaiting_input",
            ontologyHash,
            interaction: {
              kind: "clarify",
              awaitingAnswer: true,
              question:
                "Please provide an approved Tool/API contract for the recruiting system.",
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
                blockedActions: [sourceActionName],
              },
              actions: [
                {
                  action: sourceActionName,
                  ready: false,
                  stages: {
                    authoring: false,
                    sandbox: false,
                    promotion: false,
                  },
                  unresolvedBindings: [
                    {
                      requirementId: sourceRequirementId,
                      system: blockedSystem,
                      kind: "external_api",
                      role: "execute",
                      status: "missing",
                      executionSurface: null,
                      reason:
                        "No authorized capability covers candidate.lock_check",
                    },
                  ],
                },
              ],
            },
          },
        }),
      },
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: turn.job.id,
      status: "waiting_user",
    });

    const currentSessionResponse = await env.fetch(
      `/v1/ontocode/sessions/${session.session.id}`,
    );
    expect(currentSessionResponse.status).toBe(200);
    const current = await success<{
      session: { revision: number };
    }>(currentSessionResponse);
    return {
      projectId,
      sessionId: session.session.id,
      sessionRevision: current.session.revision,
      commandId: turn.command.id,
      jobId: turn.job.id,
    };
  }

  function taskRequest(
    fixture: WaitingFixture,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      expectedSessionRevision: fixture.sessionRevision,
      sourceCommandId: fixture.commandId,
      waitingHarnessJobId: fixture.jobId,
      sourceRequirementId,
      sourceActionName,
      blockerKey: `integration:${sourceRequirementId}`,
      title: `Provide the ${blockedSystem} Tool/API contract`,
      target: {
        kind: "tool",
        system: blockedSystem,
        desiredToolName: null,
        requirementKind: "external_api",
        requirementRole: "execute",
      },
      requirement: {
        summary:
          "An approved Tool/API contract is required before this Agent can be generated.",
        reason:
          "No authorized execution surface exists in the readiness receipt.",
        missingFields: [],
        sourceRefs: [
          `harness-job:${fixture.jobId}`,
          `ontology-action:${sourceActionName}`,
          `integration-requirement:${sourceRequirementId}`,
        ],
      },
      verificationPolicy: {
        kind: "tool_contract",
      },
      resumeAction: "generate_package",
      ontologyHash,
      ...overrides,
    };
  }

  async function createTask(
    fixture: WaitingFixture,
    key: string,
  ): Promise<{
    task: ConfigurationTask;
    sessionRevision: number;
  }> {
    const response = await env.fetch(
      `/v1/ontocode/sessions/${fixture.sessionId}/configuration-tasks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(taskRequest(fixture)),
      },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return success(response);
  }

  it("derives an exact tool-contract task from a real waiting Harness receipt artifact", async () => {
    const fixture = await createWaitingFixture();
    const receiptArtifact = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(
        eq(
          ontocodeArtifacts.logicalName,
          `harness/build/${fixture.jobId}/receipt.json`,
        ),
      )
      .get();
    expect(receiptArtifact).toMatchObject({
      tenantId,
      projectId: fixture.projectId,
      sessionId: fixture.sessionId,
      kind: "harness_receipt",
    });

    const created = await createTask(
      fixture,
      `config-task-create-${randomUUID()}`,
    );
    expect(created.task).toMatchObject({
      tenantId,
      sessionId: fixture.sessionId,
      waitingHarnessJobId: fixture.jobId,
      sourceRequirementId,
      sourceActionName,
      target: {
        kind: "tool",
        system: blockedSystem,
        desiredToolName: null,
        requirementKind: "external_api",
        requirementRole: "execute",
      },
      verificationPolicy: { kind: "tool_contract" },
      status: "open",
      revision: 1,
    });
    expect(created.task.sourceReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a client attempt to disguise the same missing/no-surface receipt as integration credentials", async () => {
    const fixture = await createWaitingFixture();
    const response = await env.fetch(
      `/v1/ontocode/sessions/${fixture.sessionId}/configuration-tasks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `config-task-spoof-${randomUUID()}`,
        },
        body: JSON.stringify(
          taskRequest(fixture, {
            target: {
              kind: "integration",
              provider: "internal-recruitment-system",
              system: blockedSystem,
            },
            verificationPolicy: {
              kind: "derived_requirement",
              provider: "internal-recruitment-system",
            },
          }),
        ),
      },
    );

    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({
      code: "ontocode_configuration_target_receipt_mismatch",
    });
    const listResponse = await env.fetch(
      `/v1/ontocode/sessions/${fixture.sessionId}/configuration-tasks`,
    );
    expect(
      await success<{ count: number; items: unknown[] }>(listResponse),
    ).toMatchObject({ count: 0, items: [] });
  });

  it("keeps the opaque task tenant-scoped on its direct route", async () => {
    const fixture = await createWaitingFixture();
    const created = await createTask(
      fixture,
      `config-task-isolation-${randomUUID()}`,
    );

    const foreignResponse = await env.fetch(
      `/v1/ontocode/configuration-tasks/${created.task.id}`,
      { headers: { "x-agentic-tenant": "raas" } },
    );
    expect(foreignResponse.status).toBe(404);
    expect(await failure(foreignResponse)).toMatchObject({
      code: "ontocode_configuration_task_not_found",
    });
  });

  it("leaves the exact Harness Job waiting when authoritative verification fails", async () => {
    const fixture = await createWaitingFixture();
    const created = await createTask(
      fixture,
      `config-task-verify-${randomUUID()}`,
    );
    const failedVerifier: OntoCodeConfigurationTaskVerifier = {
      verify: async () => ({
        outcome: "failed",
        code: "tool_contract_not_verified",
        summary:
          "No approved Tool/API contract is available for this external system.",
        resourceDigest: null,
        refs: [`harness-job:${fixture.jobId}`],
      }),
    };
    setOntoCodeConfigurationTaskVerifier(failedVerifier);

    try {
      const verifyResponse = await env.fetch(
        `/v1/ontocode/configuration-tasks/${created.task.id}/verify`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `config-task-verification-${randomUUID()}`,
          },
          body: JSON.stringify({ expectedRevision: created.task.revision }),
        },
      );
      expect(verifyResponse.status).toBe(200);
      const verified = await success<{
        task: ConfigurationTask;
        event: { type: string };
        verification: { outcome: string; code: string };
        resumed: boolean;
      }>(verifyResponse);
      expect(verified).toMatchObject({
        task: { status: "open" },
        event: { type: "configuration.task.verification_failed" },
        verification: {
          outcome: "failed",
          code: "tool_contract_not_verified",
        },
        resumed: false,
      });
    } finally {
      setOntoCodeConfigurationTaskVerifier(
        createOntoCodeConfigurationTaskVerifier(),
      );
    }

    const jobs = getDb()
      .select()
      .from(ontocodeHarnessJobs)
      .where(eq(ontocodeHarnessJobs.sessionId, fixture.sessionId))
      .all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: fixture.jobId,
      tenantId,
      status: "waiting_user",
    });
  });

  it("resumes the exact waiting operation once after authoritative verification passes", async () => {
    const fixture = await createWaitingFixture();
    const created = await createTask(
      fixture,
      `config-task-pass-${randomUUID()}`,
    );
    const verificationDigest = "d".repeat(64);
    const passedVerifier: OntoCodeConfigurationTaskVerifier = {
      verify: async () => ({
        outcome: "passed",
        code: "tool_contract_verified",
        summary:
          "One persisted executable Tool now covers the exact system, integration kind, and role.",
        resourceDigest: verificationDigest,
        refs: [
          `configuration-task:${created.task.id}`,
          `harness-job:${fixture.jobId}`,
          "tool:internal-recruitment-lock-check",
        ],
      }),
    };
    setOntoCodeConfigurationTaskVerifier(passedVerifier);

    try {
      const firstResponse = await env.fetch(
        `/v1/ontocode/configuration-tasks/${created.task.id}/verify`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `config-task-pass-first-${randomUUID()}`,
          },
          body: JSON.stringify({ expectedRevision: created.task.revision }),
        },
      );
      expect(firstResponse.status).toBe(200);
      const first = await success<{
        task: ConfigurationTask;
        event: { type: string };
        verification: {
          outcome: string;
          code: string;
          resourceDigest: string | null;
        };
        mode: string;
        resumed: boolean;
      }>(firstResponse);
      expect(first).toMatchObject({
        task: { status: "satisfied" },
        event: { type: "configuration.task.verified" },
        verification: {
          outcome: "passed",
          code: "tool_contract_verified",
          resourceDigest: verificationDigest,
        },
        mode: "started",
        resumed: true,
      });

      const jobsAfterFirst = getDb()
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, fixture.sessionId))
        .all();
      expect(jobsAfterFirst).toHaveLength(2);
      expect(
        jobsAfterFirst.find((job) => job.id === fixture.jobId),
      ).toMatchObject({
        kind: "build",
        status: "cancelled",
      });
      const continuationJob = jobsAfterFirst.find(
        (job) => job.id !== fixture.jobId,
      );
      expect(continuationJob).toMatchObject({
        kind: "build",
        status: "queued",
      });

      const messagesAfterFirstResponse = await env.fetch(
        `/v1/ontocode/sessions/${fixture.sessionId}/messages?limit=100`,
      );
      expect(messagesAfterFirstResponse.status).toBe(200);
      const messagesAfterFirst = await success<{
        items: Array<{
          id: string;
          role: string;
          content: Record<string, unknown>;
        }>;
        count: number;
      }>(messagesAfterFirstResponse);
      const continuationMessages = messagesAfterFirst.items.filter(
        (message) =>
          message.role === "system" &&
          message.content.text ===
            "Automatic continuation after configuration verification",
      );
      expect(continuationMessages).toEqual([
        expect.objectContaining({
          role: "system",
          content: expect.objectContaining({
            configurationTask: expect.objectContaining({
              id: created.task.id,
              verificationCode: "tool_contract_verified",
              resourceDigest: verificationDigest,
            }),
          }),
        }),
      ]);

      const retryResponse = await env.fetch(
        `/v1/ontocode/configuration-tasks/${created.task.id}/verify`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `config-task-pass-retry-${randomUUID()}`,
          },
          body: JSON.stringify({ expectedRevision: first.task.revision }),
        },
      );
      expect(retryResponse.status).toBe(200);
      expect(
        await success<{
          task: ConfigurationTask;
          event: null;
          mode: string;
          resumed: boolean;
        }>(retryResponse),
      ).toMatchObject({
        task: { status: "satisfied" },
        event: null,
        mode: "attached",
        resumed: true,
      });

      const jobsAfterRetry = getDb()
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, fixture.sessionId))
        .all();
      expect(jobsAfterRetry.map((job) => job.id).sort()).toEqual(
        jobsAfterFirst.map((job) => job.id).sort(),
      );
      const messagesAfterRetryResponse = await env.fetch(
        `/v1/ontocode/sessions/${fixture.sessionId}/messages?limit=100`,
      );
      const messagesAfterRetry = await success<{
        items: Array<{ id: string }>;
        count: number;
      }>(messagesAfterRetryResponse);
      expect(messagesAfterRetry.count).toBe(messagesAfterFirst.count);
      expect(messagesAfterRetry.items.map((message) => message.id)).toEqual(
        messagesAfterFirst.items.map((message) => message.id),
      );
    } finally {
      setOntoCodeConfigurationTaskVerifier(
        createOntoCodeConfigurationTaskVerifier(),
      );
    }
  });

  // #VERIFY-CONFIG — `verify_configuration` queues a `simulation` job. That job
  // kind had no executor, so asking the assistant to "go check the config"
  // failed with an internal error instead of checking anything.
  it("verifies this Session's open Configuration Tasks through a simulation job", async () => {
    // An earlier test resumes a waiting Job, leaving it queued. Drain first so
    // this test's worker claims its own simulation job, not that leftover.
    const drain = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      executors: {
        build: async () => ({
          outcome: "waiting_user",
          message: "drained",
          receipt: { schema: "ontocode-build-receipt/v1" },
        }),
      },
    });
    for (let i = 0; i < 10; i += 1) {
      const drained = await drain.runNext();
      if (!drained.claimed) break;
    }
    const fixture = await createWaitingFixture();
    const created = await createTask(
      fixture,
      `config-task-simulation-${randomUUID()}`,
    );
    const failing: OntoCodeConfigurationTaskVerifier = {
      verify: async () => ({
        outcome: "failed",
        code: "tool_contract_not_verified",
        summary: "还没有获批的工具契约。",
        resourceDigest: null,
        refs: [`configuration-task:${created.task.id}`],
      }),
    };
    setOntoCodeConfigurationTaskVerifier(failing);
    try {
      const turnResponse = await env.fetch(
        `/v1/ontocode/sessions/${fixture.sessionId}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `config-verify-turn-${randomUUID()}`,
          },
          body: JSON.stringify({
            text: "检查一下配置好了没有",
            behavior: "execute",
            action: "verify_configuration",
            arguments: {},
            affectedSemanticPaths: [],
          }),
        },
      );
      expect(turnResponse.status, await turnResponse.clone().text()).toBe(201);

      const worker = new OntoCodeHarnessWorkerAdapter({ tenantId });
      await expect(worker.runNext()).resolves.toMatchObject({
        status: "succeeded",
      });

      // The verdict is the real one — a failing check is reported as failing.
      const taskResponse = await env.fetch(
        `/v1/ontocode/configuration-tasks/${created.task.id}`,
      );
      const after = await success<{ task: ConfigurationTask }>(taskResponse);
      expect(after.task.status).not.toBe("satisfied");

      const messagesResponse = await env.fetch(
        `/v1/ontocode/sessions/${fixture.sessionId}/messages?limit=100`,
      );
      const messages = await success<{
        items: Array<{ content: Record<string, unknown> }>;
      }>(messagesResponse);
      expect(
        messages.items.some((message) =>
          JSON.stringify(message.content).includes("还没有获批的工具契约"),
        ),
      ).toBe(true);
    } finally {
      setOntoCodeConfigurationTaskVerifier(
        createOntoCodeConfigurationTaskVerifier(),
      );
    }
  });
});
