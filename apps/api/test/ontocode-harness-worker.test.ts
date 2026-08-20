import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  businessOntologyDomains,
  factoryConversations,
  factoryDomainBindings,
  factoryRuns,
  factoryTools,
  ontocodeCandidateHeads,
  ontocodeBuildExecutions,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeCommands,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodePackageVersions,
  getDb,
  ontocodeProjects,
  ontocodeSandboxAttempts,
  ontocodeSessionEvents,
  ontocodeSessions,
  tenants,
} from "@agentic/db";
import type {
  DomainOntology,
  FactoryScopeRecommendation,
  GeneratedAgentSpec,
  RealTool,
  SandboxDeployResult,
} from "@agentic/agent-factory";
import {
  BLUEPRINT_REASONING_STRUCTURE_MARKER,
  createFactoryGenerationDirective,
  factoryScopeRecommendationId,
  factorySourceOntologyHash,
  FactoryScopeRecommendationError,
  getLlmCallContext,
  ontologyContentHash,
  setFactoryModelAdapter,
  specsFingerprint,
} from "@agentic/agent-factory";
import type { OntoCodeCandidateTestCase } from "@agentic/contracts";
import { ONTOCODE_COMMAND_POLICY } from "@agentic/contracts";
import { canonicalEvidenceJson } from "@agentic/shared";
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
  retryOntoCodeSessionJob,
} from "../src/services/ontocode-session-store";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  __resolveFactoryRunContinuationAncestryForTest,
  applyDeferredGenerationScope,
  buildStructuredWaitingQuestion,
  OntoCodeHarnessExecutionError,
  createDefaultOntoCodeFactoryAdapter,
  createDefaultOntoCodeHarnessExecutors,
  OntoCodeHarnessWorkerAdapter,
  resolveBlueprintReasoningBudget,
  runFactoryBuild,
  type OntoCodeFactoryBuildInput,
  type OntoCodeFactoryHarnessAdapter,
  type OntoCodeFactoryRunRuntime,
} from "../src/services/ontocode-harness-worker";
import { buildTestEnv } from "./harness";
import { createOntoCodeAutopilotBuildPipeline } from "../src/services/ontocode-autopilot-build-pipeline";
import { makeFactoryPorts } from "../src/services/agent-factory";
import { DrizzleToolStore } from "../src/services/agent-factory/stores";

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

function fakeContractTool(
  name: string,
  policy: Pick<RealTool, "operation" | "effectScope" | "sandboxPolicy"> = {
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
  },
): RealTool {
  return {
    name,
    summary: `Test contract for ${name}`,
    sideEffect: policy.operation === "write" ? "write" : "read",
    ...policy,
    capabilities: [
      {
        systems: ["*"],
        kinds: ["external_api"],
        roles: ["read", "write"],
        operations: ["lookup", "write"],
      },
    ],
    catalogDefinition: {
      name,
      category: "test",
      sourcePath: `test/${name}.ts`,
      sourceIdentity: { provider: "test", tool: name },
      sideEffect: policy.operation === "write" ? "write" : "read",
      operation: policy.operation!,
      effectScope: policy.effectScope!,
      sandboxPolicy: policy.sandboxPolicy!,
      argsSchema: { input: { type: "string", required: true } },
      returnsSchema: { output: { type: "string" } },
      capabilities: [
        {
          systems: ["*"],
          kinds: ["external_api"],
          roles: ["read", "write"],
          operations: ["lookup", "write"],
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
    listExecutionResources: vi.fn(async () => ({
      tools: [
        fakeContractTool("vendor.lookup"),
        fakeContractTool("recruitment.write", {
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
        }),
      ],
      capabilityProviders: [],
      systemAliasGroups: [],
    })),
    runBuild: vi.fn(async (input) => ({
      outcome: "succeeded",
      receipt: {
        factoryRunId: input.engineRunId ?? "fake-run",
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

describe("OntoCode Factory generated-unverified handoff", () => {
  it("does not start a detached Factory run after the Harness signal was already cancelled", async () => {
    const controller = new AbortController();
    const stopped = new OntoCodeHarnessExecutionError(
      "worker_stopped",
      "Harness worker stopped before Factory startup",
      { recoverable: true, retryable: true },
    );
    controller.abort(stopped);
    const startRun = vi.fn(() => ({}));
    const subscribeRun = vi.fn(() => vi.fn());
    const runtime = {
      startRun,
      subscribeRun,
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;

    await expect(
      runFactoryBuild(
        {
          jobId: "ocj-stopped-before-factory",
          attempt: 1,
          operation: "build",
          tenantId: "tenant-test",
          tenantSlug: "agents-generation",
          domain: ontology.domainId,
          ontologyDomainRegistrationId: null,
          runtimeProfileVersionId: null,
          goal: "Generate Agent code",
          actorId: "fde-test",
          interactionPolicy: "autopilot",
          directive: {
            schema: "agent-factory-generation-directive/v1",
            mode: "action_selection",
            requestedActionIds: ["screen-candidate"],
            requestedActionNames: ["screenCandidate"],
            requestedActions: [
              { id: "screen-candidate", name: "screenCandidate" },
            ],
            sourceOntologyHash: factorySourceOntologyHash(ontology),
          },
          budget: {},
          signal: controller.signal,
          onProgress: vi.fn(async () => undefined),
        },
        runtime,
      ),
    ).rejects.toBe(stopped);
    expect(startRun).not.toHaveBeenCalled();
    expect(subscribeRun).not.toHaveBeenCalled();
  });

  it("routes an OntoCode execution-readiness answer as an ordinary marked turn instead of forging a private human gate", async () => {
    const startRun = vi.fn(() => ({}));
    const enqueueHumanMessage = vi.fn(() => "rejected" as const);
    const acceptStableContinuation = vi.fn(() => "queued" as const);
    const onAnswerDelivery = vi.fn();
    const checkpointedCard = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      short: "ScreenCandidateAgent",
      nameZh: "候选人筛选",
      trigger: ["CANDIDATE_RECEIVED"],
      emit: ["CANDIDATE_SCREENED"],
      tools: [],
      unresolved: [],
      isSubAgent: false,
    };
    const runtime = {
      startRun,
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "agent.created",
            spec: checkpointedCard,
            design: {
              code: "export async function handler(input) { return { revalidated: true, input }; }",
            },
          });
          callback({
            t: "done",
            status: "waiting_human",
            completionKind: "incomplete",
            tokensUsed: 12,
            turns: 1,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
      enqueueHumanMessage,
      acceptStableContinuation,
      isActiveRun: vi.fn(() => false),
    } as unknown as OntoCodeFactoryRunRuntime;
    const answerId = "ocm-readiness-answer";
    const answer = "Revalidate every saved spec against the current Ontology.";
    const result = await runFactoryBuild(
      {
        buildExecutionId: "ocx-readiness-continuation",
        engineRunId: "ocf-ocx-readiness-continuation",
        jobId: "ocj-readiness-continuation",
        attempt: 1,
        operation: "build",
        tenantId: "tenant-test",
        tenantSlug: "agents-generation",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: null,
        runtimeProfileVersionId: null,
        goal: "Internal build goal",
        actorId: "fde-test",
        interactionPolicy: "autopilot",
        directive: {
          schema: "agent-factory-generation-directive/v1",
          mode: "action_selection",
          requestedActionIds: ["screen-candidate"],
          requestedActionNames: ["screenCandidate"],
          requestedActions: [
            { id: "screen-candidate", name: "screenCandidate" },
          ],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        },
        budget: { maxModelCalls: 20, maxToolCalls: 40 },
        resume: {
          waitingJobId: "ocj-readiness-parent",
          factoryRunId: "ocf-ocx-readiness-continuation",
          interactionId: "oci-readiness",
          interactionKind: "execution_readiness",
          answerId,
          answer,
          persistGoal: "Original stable build goal",
          capturedAgents: [
            {
              slug: checkpointedCard.slug,
              actionName: checkpointedCard.actionName,
              name: checkpointedCard.nameZh,
              card: checkpointedCard,
              design: {
                code: "export async function handler(input) { return input; }",
              },
              generatedCode:
                "export async function handler(input) { return input; }",
            },
          ],
        },
        onAnswerDelivery,
        signal: new AbortController().signal,
        onProgress: vi.fn(async () => undefined),
      },
      runtime,
    );

    expect(result).toMatchObject({ outcome: "waiting_user" });
    expect(enqueueHumanMessage).not.toHaveBeenCalled();
    expect(onAnswerDelivery).toHaveBeenCalledWith("queued");
    expect(acceptStableContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        buildExecutionId: "ocx-readiness-continuation",
        engineRunId: "ocf-ocx-readiness-continuation",
        answerId,
        answer,
      }),
    );
    const start = startRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(start).toMatchObject({
      runId: "ocf-ocx-readiness-continuation",
      conversationId: "ocf-ocx-readiness-continuation",
      persistGoal: "Original stable build goal",
      goal: "Original stable build goal",
      continuationMode: "crash_resume",
    });
    expect(result.receipt.agentPreviews).toEqual([
      expect.objectContaining({
        slug: checkpointedCard.slug,
        actionName: checkpointedCard.actionName,
        generatedCode: expect.stringContaining("revalidated: true"),
      }),
    ]);
  });

  it("preserves a transient Factory brain error as retryable", async () => {
    const progress: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "error",
            message: "custom error: Request timed out.",
            retryable: true,
          });
          callback({
            t: "done",
            status: "errored",
            completionKind: "incomplete",
            tokensUsed: 120,
            turns: 3,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;

    await expect(
      runFactoryBuild(
        {
          jobId: "ocj-transient-factory-error",
          attempt: 1,
          operation: "build",
          tenantId: "tenant-test",
          tenantSlug: "agents-generation",
          domain: ontology.domainId,
          ontologyDomainRegistrationId: null,
          runtimeProfileVersionId: null,
          goal: "Generate Agent code",
          actorId: "fde-test",
          interactionPolicy: "autopilot",
          directive: {
            schema: "agent-factory-generation-directive/v1",
            mode: "action_selection",
            requestedActionIds: ["screen-candidate"],
            requestedActionNames: ["screenCandidate"],
            requestedActions: [
              { id: "screen-candidate", name: "screenCandidate" },
            ],
            sourceOntologyHash: factorySourceOntologyHash(ontology),
          },
          budget: {},
          signal: new AbortController().signal,
          onProgress: async (type, payload) => {
            progress.push({ type, payload });
          },
        },
        runtime,
      ),
    ).rejects.toMatchObject({
      code: "factory_build_incomplete",
      options: {
        recoverable: true,
        retryable: true,
      },
    });
    expect(progress).toContainEqual({
      type: "harness.build.brain_error",
      payload: expect.objectContaining({ retryable: true }),
    });
  });

  it("keeps generated function code when an external API is offline and never reports it as a verified delivery", async () => {
    const progress: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "agent.created",
            spec: {
              slug: "screen-candidate-agent",
              actionName: "screenCandidate",
              short: "ScreenCandidateAgent",
              nameZh: "候选人筛选",
              trigger: ["CANDIDATE_RECEIVED"],
              emit: ["CANDIDATE_SCREENED"],
              tools: ["vendor.lookup"],
              unresolved: [],
              isSubAgent: false,
            },
            design: {
              code: "export async function handler(input) { return input; }",
              executionReadiness: {
                schema: "agent-factory-execution-readiness/v1",
                authoringReady: true,
                sandboxReady: false,
                promotionReady: false,
                externalApis: [
                  {
                    tool: "vendor.lookup",
                    systems: ["Vendor"],
                    sandboxReady: false,
                    promotionReady: false,
                    sandboxReasons: ["probe_not_verified"],
                    promotionReasons: ["live_probe_required_for_promotion"],
                  },
                ],
              },
            },
          });
          callback({
            t: "tool.result",
            id: "readiness",
            name: "inspect_all_action_readiness",
            ok: true,
            summary: "authoring ready; execution unresolved",
            output: JSON.stringify({
              readOnly: true,
              source: "generation.directive.agent_actions",
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
                  stages: {
                    authoring: true,
                    sandbox: false,
                    promotion: false,
                  },
                  blockers: {
                    integration: {
                      unresolvedBindings: [
                        {
                          requirementId: "screen-candidate:integration:1",
                          system: "Vendor",
                          kind: "external_api",
                          role: "read",
                          status: "needs_probe",
                          executionSurface: "vendor.lookup",
                          reason: "external platform is temporarily offline",
                        },
                      ],
                    },
                  },
                },
              ],
            }),
          });
          callback({
            t: "tool.result",
            id: "draft",
            name: "save_draft",
            ok: true,
            summary: "function code saved as generated_unverified",
            output: JSON.stringify({
              persisted: 1,
              scope: "full",
              coveredAgents: ["screenCandidate"],
              missedActions: [],
              executionReadiness: {
                schema: "agent-factory-draft-readiness/v1",
                state: "generated_unverified",
                sandboxEvidence: "not_run",
                sandboxPrerequisitesReady: false,
                promotionPrerequisitesReady: false,
                unverifiedApis: [
                  {
                    actionName: "screenCandidate",
                    tool: "vendor.lookup",
                    systems: ["Vendor"],
                    statuses: ["sandbox_unresolved", "promotion_unresolved"],
                    reasons: [
                      "probe_not_verified",
                      "live_probe_required_for_promotion",
                    ],
                  },
                ],
                blockers: ["screenCandidate：vendor.lookup 缺少 sandbox probe"],
              },
            }),
          });
          callback({
            t: "done",
            status: "incomplete",
            completionKind: "incomplete",
            tokensUsed: 120,
            turns: 3,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;

    const result = await runFactoryBuild(
      {
        jobId: "ocj-draft-offline",
        attempt: 1,
        operation: "build",
        tenantId: "tenant-test",
        tenantSlug: "agents-generation",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: null,
        runtimeProfileVersionId: null,
        goal: "Generate the selected function even if Vendor is offline",
        actorId: "fde-test",
        interactionPolicy: "strict",
        directive: {
          schema: "agent-factory-generation-directive/v1",
          mode: "action_selection",
          requestedActionIds: ["screen-candidate"],
          requestedActionNames: ["screenCandidate"],
          requestedActions: [
            { id: "screen-candidate", name: "screenCandidate" },
          ],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        },
        budget: {},
        signal: new AbortController().signal,
        onProgress: async (type, payload) => {
          progress.push({ type, payload });
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      outcome: "waiting_user",
      message: expect.stringContaining("已生成并持久化 1 个 function 代码草稿"),
      receipt: {
        status: "drafted_unverified",
        completionKind: "incomplete",
        verificationState: "generated_unverified",
        agents: [],
        candidateEligibility: "non_candidate_preview",
        agentPreviews: [
          expect.objectContaining({
            actionName: "screenCandidate",
            generatedCode:
              "export async function handler(input) { return input; }",
          }),
        ],
        draftCheckpoint: {
          schema: "agent-factory-draft-checkpoint/v1",
          executionReadiness: {
            sandboxEvidence: "not_run",
            unverifiedApis: [
              expect.objectContaining({
                tool: "vendor.lookup",
                systems: ["Vendor"],
              }),
            ],
          },
        },
      },
    });
    expect(result.message).toContain("旧版无不可变版本身份");
    expect(result.message).toContain("不会按当前 latest 或代码相似度");
    expect(result.message).toContain("不是 runnable/verified candidate");
    expect(result.message).toContain("Sandbox、probe、finish 与 promotion");
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: "harness.build.draft_generated",
        payload: expect.objectContaining({
          verificationState: "generated_unverified",
        }),
      }),
    );
    expect(result).not.toMatchObject({
      outcome: "succeeded",
      receipt: { completionKind: "delivery" },
    });
  });

  it("drains save_draft and terminal events after clarify before settling the Build", async () => {
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "agent.created",
            spec: {
              slug: "screen-candidate-agent",
              actionName: "screenCandidate",
              short: "ScreenCandidateAgent",
              nameZh: "候选人筛选",
              trigger: ["CANDIDATE_RECEIVED"],
              emit: ["CANDIDATE_SCREENED"],
              tools: [],
              unresolved: [],
              isSubAgent: false,
            },
            design: {
              code: "export async function handler(input) { return input; }",
            },
          });
          callback({
            t: "clarify",
            question: "请确认尚未连通的外部 API 由 FDE 后续配置。",
            options: [
              {
                label: "保留草稿并继续",
                value: "keep_draft",
                recommended: true,
              },
            ],
            awaitingAnswer: true,
            interactionId: "hitl-drain-before-settle",
          });
          callback({
            t: "tool.result",
            id: "save-draft-after-clarify",
            name: "save_draft",
            ok: true,
            summary: "durable draft persisted",
            output: JSON.stringify({
              persisted: 1,
              scope: "full",
              coveredAgents: ["screenCandidate"],
              executionReadiness: {
                schema: "agent-factory-draft-readiness/v1",
                state: "generated_unverified",
                sandboxEvidence: "not_run",
                sandboxPrerequisitesReady: true,
                promotionPrerequisitesReady: false,
                unverifiedApis: [],
                blockers: [],
              },
            }),
          });
          callback({
            t: "done",
            status: "waiting_human",
            completionKind: "awaiting_input",
            tokensUsed: 50,
            turns: 2,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;

    const result = await runFactoryBuild(
      {
        jobId: "ocj-clarify-drain",
        attempt: 1,
        operation: "build",
        tenantId: "tenant-test",
        tenantSlug: "agents-generation",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: null,
        runtimeProfileVersionId: null,
        goal: "Generate the selected function",
        actorId: "fde-test",
        interactionPolicy: "strict",
        directive: {
          schema: "agent-factory-generation-directive/v1",
          mode: "action_selection",
          requestedActionIds: ["screen-candidate"],
          requestedActionNames: ["screenCandidate"],
          requestedActions: [
            { id: "screen-candidate", name: "screenCandidate" },
          ],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        },
        budget: {},
        signal: new AbortController().signal,
        onProgress: vi.fn(async () => undefined),
      },
      runtime,
    );

    expect(result).toMatchObject({
      outcome: "waiting_user",
      message: expect.stringContaining("已生成并持久化 1 个 function 代码草稿"),
      receipt: {
        status: "waiting_human",
        completionKind: "awaiting_input",
        verificationState: "generated_unverified",
        agents: [],
        candidateEligibility: "non_candidate_preview",
        agentPreviews: [
          expect.objectContaining({ actionName: "screenCandidate" }),
        ],
        draftCheckpoint: {
          persisted: 1,
          scope: "full",
          coveredAgents: ["screenCandidate"],
          executionReadiness: {
            sandboxEvidence: "not_run",
            blockers: [],
          },
        },
        interaction: expect.objectContaining({
          interactionId: "hitl-drain-before-settle",
        }),
      },
    });
  });

  it("projects a final-turn Factory clarification as OntoCode waiting_user", async () => {
    const interactionId = "hitl_44444444-4444-4444-8444-444444444444";
    const question =
      "processResume 应该使用哪个真实执行面，还是保留为人工边界？";
    const context = "权威 Ontology 没有给出可调用接口，不能猜测数据源。";
    const options = [
      {
        label: "确认人工边界",
        value: "confirm_manual_boundary",
        recommended: true,
      },
    ];
    const progress: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "clarify",
            question,
            context,
            options,
            items: [],
            awaitingAnswer: true,
            interactionId,
          });
          callback({
            t: "done",
            status: "turns_exhausted",
            completionKind: "incomplete",
            tokensUsed: 120,
            conversationTokensUsed: 240,
            turns: 8,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;

    const result = await runFactoryBuild(
      {
        jobId: "ocj-final-turn-clarification",
        attempt: 1,
        operation: "build",
        tenantId: "tenant-test",
        tenantSlug: "agents-generation",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: null,
        runtimeProfileVersionId: null,
        goal: "Generate processResume without inventing an integration",
        actorId: "fde-test",
        interactionPolicy: "strict",
        directive: {
          schema: "agent-factory-generation-directive/v1",
          mode: "action_selection",
          requestedActionIds: ["screen-candidate"],
          requestedActionNames: ["screenCandidate"],
          requestedActions: [
            { id: "screen-candidate", name: "screenCandidate" },
          ],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        },
        budget: {},
        signal: new AbortController().signal,
        onProgress: async (type, payload) => {
          progress.push({ type, payload });
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      outcome: "waiting_user",
      message: expect.stringContaining(question),
      receipt: {
        status: "waiting_human",
        completionKind: "incomplete",
        interaction: {
          kind: "clarify",
          awaitingAnswer: true,
          interactionId,
          question,
          context,
          options,
          items: [],
        },
      },
    });
    const internalEngineStatus = result.receipt.internalEngineStatus;
    if (internalEngineStatus !== undefined) {
      expect(internalEngineStatus).toBe("turns_exhausted");
    }
    expect(progress).toContainEqual({
      type: "harness.build.clarification",
      payload: {
        factoryRunId: "ocf-ocj-final-turn-clarification-a1",
        kind: "clarify",
        awaitingAnswer: true,
        interactionId,
        question,
        context,
        options,
        items: [],
      },
    });
  });

  it("projects a parked test-suite approval with a draft-only exit", async () => {
    const progress: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "test.cases",
            cases: [{ id: "happy-1" }, { id: "branch-1" }],
            awaitingApproval: true,
            interactionId: "hitl-test-approval",
            coverage: {
              required: ["happy:START", "branch:route(A|B)"],
              covered: ["happy:START"],
              backfilled: [],
              uncoveredNeedingData: ["branch:route(A|B)"],
            },
          });
          callback({
            t: "done",
            status: "waiting_human",
            completionKind: "incomplete",
            tokensUsed: 30,
            turns: 1,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;

    const result = await runFactoryBuild(
      {
        jobId: "ocj-test-approval",
        attempt: 1,
        operation: "build",
        tenantId: "tenant-test",
        tenantSlug: "agents-generation",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: null,
        runtimeProfileVersionId: null,
        goal: "Generate and test the selected function",
        actorId: "fde-test",
        interactionPolicy: "strict",
        directive: {
          schema: "agent-factory-generation-directive/v1",
          mode: "action_selection",
          requestedActionIds: ["screen-candidate"],
          requestedActionNames: ["screenCandidate"],
          requestedActions: [
            { id: "screen-candidate", name: "screenCandidate" },
          ],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        },
        budget: {},
        signal: new AbortController().signal,
        onProgress: async (type, payload) => {
          progress.push({ type, payload });
        },
      },
      runtime,
    );

    expect(result).toMatchObject({
      outcome: "waiting_user",
      message: expect.stringContaining("已生成 2 个测试用例"),
      receipt: {
        status: "waiting_human",
        interaction: {
          kind: "test_approval",
          awaitingAnswer: true,
          interactionId: "hitl-test-approval",
          allowOther: false,
          options: [
            {
              label: "执行当前用例",
              value: "[测试用例决策: 执行]",
            },
            {
              label: "重新生成用例",
              value: "[测试用例决策: 重新生成]",
            },
            {
              label: "补充测试数据",
              value: "[测试用例决策: 补数据]",
              recommended: true,
            },
            {
              label: "保存未验证设计稿",
              value: "[测试用例决策: 保存设计稿]",
            },
          ],
        },
      },
    });
    const question = buildStructuredWaitingQuestion(
      "build",
      result.message ?? "",
      result.receipt,
    );
    expect(question).toMatchObject({
      kind: "decision",
      allowOther: false,
      options: [
        { value: "[测试用例决策: 执行]" },
        { value: "[测试用例决策: 重新生成]" },
        { value: "[测试用例决策: 补数据]", recommended: true },
        { value: "[测试用例决策: 保存设计稿]" },
      ],
    });
    expect(progress).toContainEqual(
      expect.objectContaining({
        type: "harness.build.test_cases",
        payload: expect.objectContaining({
          interaction: expect.objectContaining({
            kind: "test_approval",
            allowOther: false,
          }),
        }),
      }),
    );
  });

  it("resumes the exact parked Factory run, keeps five checkpointed specs, and adds only the sixth Agent", async () => {
    const actionNames = [
      "ruleCheckForMatchResume",
      "matchResume",
      "inviteInternalInterview",
      "processResume",
      "createJD",
      "ruleCheckForCandidateIdentity",
    ];
    const capturedAgents = actionNames.slice(0, 5).map((actionName, index) => ({
      slug: `agent-${index + 1}`,
      actionName,
      name: actionName,
      card: {
        slug: `agent-${index + 1}`,
        actionName,
        tools: [],
        plan: [],
      },
      design: {
        code: `export async function ${actionName}(input) { return input; }`,
      },
      generatedCode: `export async function ${actionName}(input) { return input; }`,
    }));
    const startRunSpy = vi.fn(() => ({}));
    const enqueueSpy = vi.fn(() => "queued" as const);
    const runtime = {
      startRun: startRunSpy,
      enqueueHumanMessage: enqueueSpy,
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          const actionName = actionNames[5]!;
          callback({
            t: "agent.created",
            spec: {
              slug: "agent-6",
              actionName,
              short: actionName,
              tools: [],
              plan: [],
            },
            design: {
              code: `export async function ${actionName}(input) { return input; }`,
            },
          });
          callback({
            t: "done",
            status: "finished",
            completionKind: "delivery",
            tokensUsed: 25,
            turns: 1,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
      loadDurableAgents: vi.fn(
        async (
          _input: unknown,
          _runId: string,
          agents: Array<{
            slug: string;
            actionName: string;
            name: string;
            card: Record<string, unknown>;
            design: Record<string, unknown> | null;
            generatedCode: string | null;
          }>,
        ) =>
          agents.map((agent, index) => ({
            ...agent,
            draftVersionId: "draft-resumed-six",
            spec: {
              ...agent.card,
              slug: agent.slug,
              actionName: agent.actionName,
              generatedCode: agent.generatedCode,
              codeExecuted: false,
              tools: [],
              plan: [],
              inputBindings: [],
              decisionTables: [],
            },
            ordinal: index + 1,
          })),
      ),
    } as unknown as OntoCodeFactoryRunRuntime;
    const factoryRunId = "ocf-ocj-waiting-five-a1";
    const answerDelivery = vi.fn();
    const buildInput: OntoCodeFactoryBuildInput = {
      buildExecutionId: "ocx-follow-up-six",
      jobId: "ocj-follow-up-six",
      attempt: 1,
      operation: "build",
      tenantId: "tenant-test",
      tenantSlug: "agents-generation",
      domain: ontology.domainId,
      ontologyDomainRegistrationId: "registration-pinned",
      runtimeProfileVersionId: "runtime-pinned",
      goal: "Continue after the exact FDE answer",
      actorId: "fde-test",
      interactionPolicy: "strict",
      directive: {
        schema: "agent-factory-generation-directive/v1",
        mode: "action_selection",
        requestedActionIds: actionNames.map(
          (_actionName, index) => `action-${index + 1}`,
        ),
        requestedActionNames: actionNames,
        requestedActions: actionNames.map((name, index) => ({
          id: `action-${index + 1}`,
          name,
        })),
        sourceOntologyHash: factorySourceOntologyHash(ontology),
      },
      budget: { maxModelCalls: 30, maxToolCalls: 74 },
      resume: {
        waitingJobId: "ocj-waiting-five",
        factoryRunId,
        interactionId: "hitl-resume-six",
        interactionKind: "clarify",
        answer: "Internal Recruitment remains a human boundary.",
        persistGoal: "Generate the complete six-Agent package",
        capturedAgents,
      },
      onAnswerDelivery: answerDelivery,
      signal: new AbortController().signal,
      onProgress: vi.fn(async () => undefined),
    };
    const result = await runFactoryBuild(buildInput, runtime);

    expect(startRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: factoryRunId,
        conversationId: factoryRunId,
        continuationMode: "human_gate_resume",
        persistGoal: "Generate the complete six-Agent package",
        executionBudget: {
          maxTurns: 30,
          maxToolCalls: 74,
          stableExecutionId: "ocx-follow-up-six",
        },
      }),
    );
    expect(enqueueSpy).toHaveBeenCalledWith(
      factoryRunId,
      "[澄清回答] Internal Recruitment remains a human boundary.",
      "tenant-test",
      "fde-test",
      { interactionId: "hitl-resume-six", gateKind: "clarify" },
    );
    expect(answerDelivery).toHaveBeenCalledWith("queued");
    expect(result).toMatchObject({
      outcome: "succeeded",
      receipt: {
        factoryRunId,
        status: "finished",
        completionKind: "delivery",
      },
    });
    expect(result.receipt.agentPreviews).toBeUndefined();
    expect(
      (result.receipt.agents as Array<Record<string, unknown>>).map(
        (agent) => agent.actionName,
      ),
    ).toEqual(actionNames);
    expect(runtime.loadDurableAgents).toHaveBeenCalledWith(
      expect.anything(),
      factoryRunId,
      expect.arrayContaining([
        expect.objectContaining({ actionName: actionNames[0] }),
        expect.objectContaining({ actionName: actionNames[5] }),
      ]),
      null,
      true,
    );

    enqueueSpy.mockReturnValueOnce("duplicate_interaction");
    answerDelivery.mockClear();
    await expect(runFactoryBuild(buildInput, runtime)).resolves.toMatchObject({
      outcome: "succeeded",
      receipt: { factoryRunId },
    });
    expect(answerDelivery).toHaveBeenCalledWith("duplicate_interaction");
  });

  it("reattaches an active crash-recovered Factory driver without restarting it or replaying a human answer", async () => {
    const factoryRunId = "ocf-ocj-crash-reattach-a1";
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const capturedAgent = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      name: "Candidate screening",
      card: {
        slug: "screen-candidate-agent",
        actionName: "screenCandidate",
        tools: [],
        plan: [],
      },
      design: { code: generatedCode },
      generatedCode,
    };
    const startRunSpy = vi.fn(() => ({}));
    const enqueueSpy = vi.fn(() => "queued" as const);
    const runtime = {
      startRun: startRunSpy,
      isActiveRun: vi.fn(() => true),
      enqueueHumanMessage: enqueueSpy,
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "done",
            status: "finished",
            completionKind: "delivery",
            tokensUsed: 25,
            turns: 1,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
      loadDurableAgents: vi.fn(
        async (
          _input: unknown,
          _runId: string,
          agents: Array<typeof capturedAgent>,
        ) =>
          agents.map((agent) => ({
            ...agent,
            draftVersionId: "draft-crash-reattach",
            spec: {
              ...agent.card,
              generatedCode: agent.generatedCode,
              codeExecuted: false,
              inputBindings: [],
              decisionTables: [],
            },
          })),
      ),
    } as unknown as OntoCodeFactoryRunRuntime;

    const result = await runFactoryBuild(
      {
        jobId: "ocj-crash-reattach",
        attempt: 2,
        operation: "build",
        tenantId: "tenant-test",
        tenantSlug: "agents-generation",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: "registration-pinned",
        runtimeProfileVersionId: "runtime-pinned",
        goal: "Keep generating the exact selected Agent",
        actorId: "fde-test",
        interactionPolicy: "autopilot",
        directive: {
          schema: "agent-factory-generation-directive/v1",
          mode: "action_selection",
          requestedActionIds: ["screen-candidate"],
          requestedActionNames: ["screenCandidate"],
          requestedActions: [
            { id: "screen-candidate", name: "screenCandidate" },
          ],
          sourceOntologyHash: factorySourceOntologyHash(ontology),
        },
        budget: { maxModelCalls: 10, maxToolCalls: 20 },
        reconnect: {
          mode: "reattach",
          factoryRunId,
          persistGoal: "Generate the exact selected Agent",
          capturedAgents: [capturedAgent],
        },
        signal: new AbortController().signal,
        onProgress: vi.fn(async () => undefined),
      },
      runtime,
    );

    expect(runtime.isActiveRun).toHaveBeenCalledWith(factoryRunId);
    expect(startRunSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "succeeded",
      receipt: {
        factoryRunId,
        agents: [
          expect.objectContaining({
            actionName: "screenCandidate",
            generatedCode,
          }),
        ],
      },
    });
  });

  it("carries the stable OntoCode execution budget into a stopped-driver reattach", async () => {
    const factoryRunId = "ocf-ocx-stopped-driver-budget";
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const capturedAgent = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      name: "Candidate screening",
      card: {
        slug: "screen-candidate-agent",
        actionName: "screenCandidate",
        tools: [],
        plan: [],
      },
      design: { code: generatedCode },
      generatedCode,
    };
    const startRunSpy = vi.fn(() => ({}));
    const runtime = {
      startRun: startRunSpy,
      isActiveRun: vi.fn(() => false),
      enqueueHumanMessage: vi.fn(() => "queued" as const),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "agent.created",
            spec: {
              ...capturedAgent.card,
              generatedCode,
            },
          });
          callback({
            t: "done",
            status: "finished",
            completionKind: "delivery",
            tokensUsed: 25,
            turns: 9,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
      loadDurableAgents: vi.fn(async () => [
        {
          ...capturedAgent,
          draftVersionId: "draft-stopped-driver-budget",
          spec: {
            ...capturedAgent.card,
            generatedCode,
            codeExecuted: false,
            inputBindings: [],
            decisionTables: [],
          },
        },
      ]),
    } as unknown as OntoCodeFactoryRunRuntime;

    await expect(
      runFactoryBuild(
        {
          buildExecutionId: "ocx-stopped-driver-budget",
          engineRunId: factoryRunId,
          jobId: "ocj-stopped-driver-budget",
          attempt: 2,
          operation: "build",
          tenantId: "tenant-test",
          tenantSlug: "agents-generation",
          domain: ontology.domainId,
          ontologyDomainRegistrationId: "registration-pinned",
          runtimeProfileVersionId: "runtime-pinned",
          goal: "Continue the same partial generation checkpoint",
          actorId: "fde-test",
          interactionPolicy: "autopilot",
          directive: {
            schema: "agent-factory-generation-directive/v1",
            mode: "action_selection",
            requestedActionIds: ["screen-candidate"],
            requestedActionNames: ["screenCandidate"],
            requestedActions: [
              { id: "screen-candidate", name: "screenCandidate" },
            ],
            sourceOntologyHash: factorySourceOntologyHash(ontology),
          },
          budget: { maxModelCalls: 30, maxToolCalls: 74 },
          reconnect: {
            mode: "reattach",
            factoryRunId,
            persistGoal: "Generate the selected Agent",
            capturedAgents: [capturedAgent],
          },
          signal: new AbortController().signal,
          onProgress: vi.fn(async () => undefined),
        },
        runtime,
      ),
    ).resolves.toMatchObject({ outcome: "succeeded" });

    expect(startRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: factoryRunId,
        conversationId: factoryRunId,
        continuationMode: "crash_resume",
        executionBudget: {
          maxTurns: 30,
          maxToolCalls: 74,
          stableExecutionId: "ocx-stopped-driver-budget",
        },
      }),
    );
  });
});

describe("OntoCode Harness Worker Adapter", () => {
  let tenantId: string;
  let originalBinding: FactoryDomainBinding | null;
  const projectIds: string[] = [];
  const factoryRunIds: string[] = [];

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
    for (const factoryRunId of factoryRunIds) {
      getDb()
        .delete(factoryConversations)
        .where(eq(factoryConversations.id, factoryRunId))
        .run();
      getDb().delete(factoryRuns).where(eq(factoryRuns.id, factoryRunId)).run();
    }
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
      | "generate_tests"
      | "run_tests"
      | "debug_failure"
      | "compare_candidate"
      | "deploy_release";
    budget?: {
      maxTokens?: number;
      maxCostUsd?: number;
      maxWallClockMs?: number;
      maxModelCalls?: number;
      maxToolCalls?: number;
    };
    sessionGoal?: string;
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
      goal: input.sessionGoal ?? "Screen candidates",
      autonomyMode: "sandbox_autopilot",
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

  it("accepts one Factory run across chained follow-up Builds and rejects a forked audit link", () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const rootJobId = fixture.job.id;
    const middleJobId = `ocj-middle-${randomUUID().slice(0, 8)}`;
    const leafJobId = `ocj-leaf-${randomUUID().slice(0, 8)}`;
    const factoryRunId = `ocf-${rootJobId}-a1`;
    const now = Date.now();
    const rootCreatedAt = new Date(now - 3_000);
    const middleCreatedAt = new Date(now - 2_000);
    const leafCreatedAt = new Date(now - 1_000);

    getDb()
      .update(ontocodeHarnessJobs)
      .set({
        status: "cancelled",
        createdAt: rootCreatedAt,
        finishedAt: new Date(now - 2_500),
        updatedAt: new Date(now - 2_500),
      })
      .where(eq(ontocodeHarnessJobs.id, rootJobId))
      .run();
    getDb()
      .insert(ontocodeHarnessJobs)
      .values([
        {
          id: middleJobId,
          tenantId,
          sessionId: fixture.session.id,
          kind: "build",
          status: "cancelled",
          idempotencyKey: `job-middle-${middleJobId}`,
          testCasesJson: "[]",
          createdBy: "test-fde",
          createdAt: middleCreatedAt,
          finishedAt: new Date(now - 1_500),
          updatedAt: new Date(now - 1_500),
        },
        {
          id: leafJobId,
          tenantId,
          sessionId: fixture.session.id,
          kind: "build",
          status: "cancelled",
          idempotencyKey: `job-leaf-${leafJobId}`,
          testCasesJson: "[]",
          createdBy: "test-fde",
          createdAt: leafCreatedAt,
          finishedAt: new Date(now - 500),
          updatedAt: new Date(now - 500),
        },
      ])
      .run();

    let seq =
      Math.max(
        0,
        ...getDb()
          .select({ seq: ontocodeSessionEvents.seq })
          .from(ontocodeSessionEvents)
          .where(eq(ontocodeSessionEvents.sessionId, fixture.session.id))
          .all()
          .map((event) => event.seq),
      ) + 1;
    const appendChainEvent = (
      harnessJobId: string,
      type: string,
      payload: Record<string, unknown>,
    ) => {
      getDb()
        .insert(ontocodeSessionEvents)
        .values({
          id: `oce-chain-${randomUUID()}`,
          tenantId,
          projectId: fixture.project.id,
          sessionId: fixture.session.id,
          seq,
          type,
          payloadJson: JSON.stringify(payload),
          harnessJobId,
          correlationId: `ocw-${harnessJobId}`,
          causationId: `chain-${seq}`,
          createdAt: new Date(now - 400 + seq),
        })
        .run();
      seq += 1;
    };
    appendChainEvent(rootJobId, "harness.build.waiting_user", {
      jobId: rootJobId,
      kind: "build",
      attempt: 1,
      receipt: { factoryRunId },
    });
    appendChainEvent(middleJobId, "harness.job.input_resolved", {
      waitingJobId: rootJobId,
      followUpJobId: middleJobId,
    });
    appendChainEvent(middleJobId, "harness.build.factory_started", {
      jobId: middleJobId,
      resumedFromWaitingJobId: rootJobId,
      factoryRunId,
    });
    appendChainEvent(middleJobId, "harness.build.waiting_user", {
      jobId: middleJobId,
      kind: "build",
      attempt: 1,
      receipt: { factoryRunId },
    });
    appendChainEvent(leafJobId, "harness.job.input_resolved", {
      waitingJobId: middleJobId,
      followUpJobId: leafJobId,
    });
    appendChainEvent(leafJobId, "harness.build.factory_started", {
      jobId: leafJobId,
      resumedFromWaitingJobId: middleJobId,
      factoryRunId,
    });

    expect(
      __resolveFactoryRunContinuationAncestryForTest({
        tenantId,
        sessionId: fixture.session.id,
        waitingJobId: leafJobId,
        waitingAttempt: 1,
        factoryRunId,
      }),
    ).toEqual({
      ok: true,
      rootWaitingJobId: rootJobId,
      chain: [leafJobId, middleJobId, rootJobId],
    });

    appendChainEvent(leafJobId, "harness.job.input_resolved", {
      waitingJobId: rootJobId,
      followUpJobId: leafJobId,
    });
    expect(
      __resolveFactoryRunContinuationAncestryForTest({
        tenantId,
        sessionId: fixture.session.id,
        waitingJobId: leafJobId,
        waitingAttempt: 1,
        factoryRunId,
      }),
    ).toMatchObject({
      ok: false,
      reason:
        "continuation parent/child does not have one exact input-resolution link",
      chain: [leafJobId, middleJobId],
    });
  });

  it("accepts only the exact reconciled legacy root bound to a stable Build execution", () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const rootJobId = fixture.job.id;
    const buildExecutionId = `ocx-legacy-root-${randomUUID().slice(0, 8)}`;
    const factoryRunId = `ocf-${rootJobId}-a1`;
    const ontologyHash = factorySourceOntologyHash(ontology);
    const now = Date.now();
    const waitingReceipt = {
      schema: "ontocode-build-receipt/v1",
      ontologyHash,
      scope: {
        actionIds: ["screen-candidate"],
        actionNames: ["screenCandidate"],
      },
      factoryRunId,
      buildExecutionId,
      status: "waiting_human",
      recovery: {
        schema: "ontocode-build-final-turn-gate-reconciliation/v1",
        mode: "legacy_final_turn_gate",
        recoveredAttempt: 1,
        finalizedAttempt: 3,
        replayedHumanAnswer: false,
      },
    };
    const waitingPayload = {
      jobId: rootJobId,
      kind: "build",
      attempt: 3,
      receipt: waitingReceipt,
    };
    const directiveJson = canonicalEvidenceJson({
      schema: "agent-factory-generation-directive/v1",
      sourceOntologyHash: ontologyHash,
      requestedActionIds: ["screen-candidate"],
    });
    const sha256 = (value: unknown) =>
      createHash("sha256").update(canonicalEvidenceJson(value)).digest("hex");

    getDb()
      .insert(ontocodeBuildExecutions)
      .values({
        id: buildExecutionId,
        tenantId,
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        state: "resuming",
        ontologyHash,
        directiveJson,
        directiveHash: sha256(JSON.parse(directiveJson) as unknown),
        engineKind: "agent_factory",
        engineRunId: factoryRunId,
        checkpointDigest: sha256(waitingPayload),
        checkpointRevision: 1,
        revision: 1,
        createdAt: new Date(now - 2_000),
        updatedAt: new Date(now - 500),
      })
      .run();
    getDb()
      .update(ontocodeHarnessJobs)
      .set({
        status: "cancelled",
        attemptNo: 3,
        buildExecutionId,
        finishedAt: new Date(now - 250),
        updatedAt: new Date(now - 250),
      })
      .where(eq(ontocodeHarnessJobs.id, rootJobId))
      .run();

    let seq =
      Math.max(
        0,
        ...getDb()
          .select({ seq: ontocodeSessionEvents.seq })
          .from(ontocodeSessionEvents)
          .where(eq(ontocodeSessionEvents.sessionId, fixture.session.id))
          .all()
          .map((event) => event.seq),
      ) + 1;
    const appendEvent = (type: string, payload: Record<string, unknown>) => {
      const id = `oce-legacy-root-${randomUUID()}`;
      getDb()
        .insert(ontocodeSessionEvents)
        .values({
          id,
          tenantId,
          projectId: fixture.project.id,
          sessionId: fixture.session.id,
          seq,
          type,
          payloadJson: canonicalEvidenceJson(payload),
          harnessJobId: rootJobId,
          correlationId: `ocw-${rootJobId}`,
          causationId: `legacy-root-${seq}`,
          createdAt: new Date(now - 200 + seq),
        })
        .run();
      seq += 1;
      return id;
    };
    appendEvent("harness.build.factory_started", {
      jobId: rootJobId,
      ontologyHash,
      attempt: 1,
      factoryRunId,
    });
    const waitingEventId = appendEvent(
      "harness.build.waiting_user",
      waitingPayload,
    );
    const resolve = () =>
      __resolveFactoryRunContinuationAncestryForTest({
        tenantId,
        sessionId: fixture.session.id,
        waitingJobId: rootJobId,
        waitingAttempt: 3,
        factoryRunId,
        buildExecutionId,
      });

    expect(resolve()).toEqual({
      ok: true,
      rootWaitingJobId: rootJobId,
      chain: [rootJobId],
    });

    getDb()
      .update(ontocodeSessionEvents)
      .set({
        payloadJson: canonicalEvidenceJson({
          ...waitingPayload,
          receipt: {
            ...waitingReceipt,
            recovery: {
              ...waitingReceipt.recovery,
              schema: "ontocode-factory-waiting-checkpoint-recovery/v1",
            },
          },
        }),
      })
      .where(eq(ontocodeSessionEvents.id, waitingEventId))
      .run();
    expect(resolve()).toMatchObject({
      ok: false,
      reason:
        "continuation child does not have one matching Build-execution start receipt",
    });

    getDb()
      .update(ontocodeSessionEvents)
      .set({ payloadJson: canonicalEvidenceJson(waitingPayload) })
      .where(eq(ontocodeSessionEvents.id, waitingEventId))
      .run();
    appendEvent("harness.build.factory_started", {
      jobId: rootJobId,
      ontologyHash,
      attempt: 1,
      factoryRunId,
    });
    expect(resolve()).toMatchObject({
      ok: false,
      reason:
        "continuation child does not have one matching Build-execution start receipt",
    });
  });

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

  it("recovers the exact save_draft version when a later version keeps the same code but changes prompt/tools/policies", async () => {
    const sourceJobId = `ocj-source-draft-${randomUUID().slice(0, 8)}`;
    const factoryRunId = `ocf-${sourceJobId}-a1`;
    const fixture = makeQueuedJob({
      kind: "build",
      commandArguments: {
        actionIds: ["screen-candidate"],
        recoverFactoryDraftRunId: factoryRunId,
      },
    });
    factoryRunIds.push(factoryRunId);
    const ontologyHash = factorySourceOntologyHash(ontology);
    getDb()
      .update(ontocodeCommands)
      .set({ baseOntologyHash: ontologyHash })
      .where(eq(ontocodeCommands.id, fixture.command.id))
      .run();

    const sourceCreatedAt = new Date(
      new Date(fixture.job.createdAt).getTime() - 10_000,
    );
    getDb()
      .insert(ontocodeHarnessJobs)
      .values({
        id: sourceJobId,
        tenantId,
        sessionId: fixture.session.id,
        kind: "build",
        status: "failed_recoverable",
        runtimeProfileVersionId: fixture.job.runtimeProfileVersionId,
        idempotencyKey: `source-draft-${sourceJobId}`,
        testCasesJson: "[]",
        createdBy: "test-fde",
        createdAt: sourceCreatedAt,
        startedAt: sourceCreatedAt,
        finishedAt: new Date(sourceCreatedAt.getTime() + 1_000),
        updatedAt: new Date(sourceCreatedAt.getTime() + 1_000),
      })
      .run();
    const nextSeq =
      Math.max(
        0,
        ...getDb()
          .select({ seq: ontocodeSessionEvents.seq })
          .from(ontocodeSessionEvents)
          .where(eq(ontocodeSessionEvents.sessionId, fixture.session.id))
          .all()
          .map((event) => event.seq),
      ) + 1;
    getDb()
      .insert(ontocodeSessionEvents)
      .values({
        id: `oce-source-draft-${randomUUID()}`,
        tenantId,
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        seq: nextSeq,
        type: "harness.job.started",
        payloadJson: canonicalEvidenceJson({
          jobId: sourceJobId,
          kind: "build",
          attempt: 1,
          maxAttempts: 3,
        }),
        harnessJobId: sourceJobId,
        correlationId: `ocw-${sourceJobId}`,
        causationId: `${sourceJobId}:1`,
        createdAt: sourceCreatedAt,
      })
      .run();

    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const spec = {
      key: "screenCandidate",
      actionName: "screenCandidate",
      slug: `recovered-screen-${randomUUID().slice(0, 8)}`,
      short: "ScreenCandidateAgent",
      domainId: ontology.domainId,
      nameZh: "候选人筛选",
      kind: "llm",
      trigger: ["CANDIDATE_RECEIVED"],
      emit: ["CANDIDATE_SCREENED"],
      tools: [],
      unresolvedTools: [],
      objects: ["Candidate"],
      systemPrompt: "Screen one candidate against the authoritative policy.",
      userPrompt: "",
      steps: [],
      ruleRefs: [],
      retries: 1,
      hitl: false,
      confidence: 1,
      promptSource: "llm",
      generatedCode,
      codeSource: "ai",
      codeExecuted: false,
      toolPolicies: {},
      executionReadiness: {
        schema: "agent-factory-execution-readiness/v1",
        authoringReady: true,
        sandboxReady: true,
        promotionReady: false,
        sandboxBlockers: [],
        promotionBlockers: ["Sandbox evidence has not run"],
        missingSandboxProfiles: [],
        missingProductionProfiles: [],
        probeGaps: [],
        externalApis: [],
      },
    } as GeneratedAgentSpec;
    const directive = createFactoryGenerationDirective({
      ontology,
      actionIds: ["screen-candidate"],
      scenario: fixture.session.goal,
      forceVirtual: false,
    });
    const draftCheckpointBase = {
      persisted: 1,
      scope: "full",
      coveredAgents: ["screenCandidate"],
      missedActions: [],
      executionReadiness: {
        schema: "agent-factory-draft-readiness/v1",
        state: "generated_unverified",
        sandboxEvidence: "not_run",
        sandboxPrerequisitesReady: true,
        promotionPrerequisitesReady: false,
        unverifiedApis: [],
        blockers: [],
      },
    };

    const previousDataRoot = process.env.AGENTIC_DATA_ROOT;
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ontocode-draft-recovery-"),
    );
    process.env.AGENTIC_DATA_ROOT = dataRoot;
    try {
      const ports = makeFactoryPorts(
        "__system",
        tenantId,
        ontology.domainId,
        "test-fde",
        fixture.project.ontologyDomainRegistrationId,
        fixture.job.runtimeProfileVersionId,
      );
      expect(ports.drafts).toBeTruthy();
      expect(ports.drafts!.saveWithReceipt).toBeTypeOf("function");
      const sourceSaveReceipt = await ports.drafts!.saveWithReceipt!(
        ontology.domainId,
        [spec],
      );
      const draftVersionId = sourceSaveReceipt.versionId;
      const laterSpec = {
        ...spec,
        systemPrompt:
          "A later FDE edit changes prompt, tools and policy but deliberately keeps the same generated source.",
        tools: ["vendor.lookup"],
        toolPolicies: {
          "vendor.lookup": {
            operation: "read",
            effectScope: "external",
            sandboxPolicy: "live_external",
          },
        },
      } as GeneratedAgentSpec;
      const laterSaveReceipt = await ports.drafts!.saveWithReceipt!(
        ontology.domainId,
        [laterSpec],
      );
      expect(laterSaveReceipt.versionId).not.toBe(draftVersionId);
      expect(laterSaveReceipt.specsFingerprint).not.toBe(
        sourceSaveReceipt.specsFingerprint,
      );
      expect(laterSpec.generatedCode).toBe(spec.generatedCode);
      const draftCheckpoint = {
        ...draftCheckpointBase,
        draftVersionId,
        specsFingerprint: sourceSaveReceipt.specsFingerprint,
      };

      const now = new Date();
      getDb()
        .insert(factoryRuns)
        .values({
          id: factoryRunId,
          tenantId,
          domain: ontology.domainId,
          ontologyDomainRegistrationId:
            fixture.project.ontologyDomainRegistrationId,
          runtimeProfileVersionId: fixture.job.runtimeProfileVersionId,
          goal: fixture.session.goal,
          status: "done",
          tokensUsed: 321,
          turns: 7,
          agentsCount: 1,
          reachedTerminal: false,
          transcriptJson: [
            {
              t: "tool.result",
              id: "save-draft-complete",
              name: "save_draft",
              ok: true,
              summary: "full generated-unverified draft saved",
              output: JSON.stringify(draftCheckpoint),
            },
            {
              t: "done",
              status: "incomplete",
              completionKind: "incomplete",
              tokensUsed: 321,
              turns: 7,
            },
          ],
          createdAt: sourceCreatedAt,
          updatedAt: now,
        })
        .run();
      getDb()
        .insert(factoryConversations)
        .values({
          id: factoryRunId,
          tenantId,
          domain: ontology.domainId,
          messagesJson: [],
          ctxJson: {
            domain: ontology.domainId,
            ontology,
            generationDirective: directive,
            specs: [spec],
          },
          createdAt: sourceCreatedAt,
          updatedAt: now,
        })
        .run();

      const runBuild = vi.fn(async () => {
        throw new Error("Factory must not restart during draft recovery");
      });
      const worker = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory: fakeFactory({ runBuild }),
      });
      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
      expect(runBuild).not.toHaveBeenCalled();

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
      expect(head).toMatchObject({
        packageVersionId: packageVersion?.id,
      });
      expect(packageVersion).toMatchObject({
        status: "candidate_ready",
      });

      const persistedJob = getOntoCodeHarnessJob({ tenantId }, fixture.job.id);
      expect(persistedJob).toMatchObject({
        status: "succeeded",
        candidatePackageVersionId: packageVersion?.id,
      });
      expect(
        getDb()
          .select()
          .from(ontocodeBuildExecutions)
          .where(eq(ontocodeBuildExecutions.id, persistedJob.buildExecutionId!))
          .get(),
      ).toMatchObject({
        state: "candidate_ready",
        pendingInteractionId: null,
        pendingInteractionKind: null,
        pendingAnswerId: null,
        pendingAnswerStatus: null,
      });

      const completed = getDb()
        .select({ payloadJson: ontocodeSessionEvents.payloadJson })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.build.completed"),
          ),
        )
        .get();
      expect(JSON.parse(completed!.payloadJson)).toMatchObject({
        deliveryState: "candidate_ready",
        receipt: {
          factoryRunId,
          sourceFactoryRunId: factoryRunId,
          status: "candidate_ready",
          completionKind: "delivery",
          verificationState: "generated_unverified",
          sandboxEvidence: "not_run",
          releaseEligible: false,
          draftVersionId,
          draftCheckpoint: {
            scope: "full",
            coveredAgents: ["screenCandidate"],
          },
          agents: [
            expect.objectContaining({
              draftVersionId,
              spec: expect.objectContaining({
                actionName: "screenCandidate",
                generatedCode,
                systemPrompt:
                  "Screen one candidate against the authoritative policy.",
                tools: [],
              }),
            }),
          ],
          recovery: {
            schema: "ontocode-factory-draft-checkpoint-recovery/v1",
            sourceHarnessJobId: sourceJobId,
            sourceHarnessAttempt: 1,
            restartedFactory: false,
          },
        },
      });
      expect(JSON.parse(completed!.payloadJson).receipt).not.toHaveProperty(
        "interaction",
      );
      expect(
        getDb()
          .select()
          .from(ontocodeEvidenceRecords)
          .where(eq(ontocodeEvidenceRecords.harnessJobId, fixture.job.id))
          .get(),
      ).toMatchObject({
        outcome: "informational",
        subjectType: "candidate_package",
        subjectId: packageVersion?.id,
        summary:
          "build Harness completed and its immutable receipt was recorded.",
        validityPredicateJson: expect.stringContaining(
          '"jobStatus":"succeeded"',
        ),
      });
    } finally {
      if (previousDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
      else process.env.AGENTIC_DATA_ROOT = previousDataRoot;
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  function queueExactCandidateTest(
    built: Awaited<ReturnType<typeof buildExactCandidate>>,
    input: {
      kind?: "test" | "regression";
      commandType?: "generate_tests" | "run_tests" | "compare_candidate";
      testCases?: OntoCodeCandidateTestCase[];
    } = {},
  ) {
    const kind = input.kind ?? "test";
    const commandType =
      input.commandType ??
      (kind === "regression" ? "compare_candidate" : "run_tests");
    const suffix = randomUUID().slice(0, 8);
    const current = getOntoCodeSession({ tenantId }, built.fixture.session.id);
    const { command, sessionRevision } = createOntoCodeCommand(
      built.fixture.ctx,
      built.fixture.session.id,
      {
        type: commandType,
        arguments: {
          candidatePackageVersionId: built.packageVersion.id,
          testCaseCount: input.testCases?.length ?? 0,
        },
        expectedSessionRevision: current.revision,
        baseOntologyHash: built.packageVersion.ontologyHash,
        basePackageVersionId: built.packageVersion.id,
        affectedSemanticPaths: ["/candidate/tests"],
        riskClass:
          commandType === "generate_tests" ? "draft_change" : "sandbox_effect",
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

  function generatedUnverifiedBuildResult(
    scope: "full" | "partial",
    engineRunId: string,
  ) {
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const draftVersionId = `v-generated-unverified-${scope}`;
    const generatedSpec = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      trigger: ["CANDIDATE_RECEIVED"],
      emit: ["CANDIDATE_SCREENED"],
      tools: [],
      unresolvedTools: [],
      toolPolicies: {},
      generatedCode,
      executionReadiness: {
        schema: "agent-factory-execution-readiness/v1",
        authoringReady: true,
        sandboxReady: true,
        promotionReady: false,
        sandboxBlockers: [],
        promotionBlockers: ["Sandbox evidence has not run"],
        missingSandboxProfiles: [],
        missingProductionProfiles: [],
        probeGaps: [],
        externalApis: [],
      },
    } as unknown as GeneratedAgentSpec;
    return {
      outcome: "waiting_user" as const,
      message: "代码已持久化；尚未运行 Sandbox。",
      receipt: {
        factoryRunId: engineRunId,
        status: "drafted_unverified",
        completionKind: "incomplete",
        verificationState: "generated_unverified",
        agents: [
          {
            slug: "screen-candidate-agent",
            actionName: "screenCandidate",
            draftVersionId,
            generatedCode,
            spec: generatedSpec,
          },
        ],
        draftCheckpoint: {
          schema: "agent-factory-draft-checkpoint/v2",
          persisted: 1,
          scope,
          coveredAgents: ["screenCandidate"],
          draftVersionId,
          specsFingerprint: specsFingerprint([generatedSpec]),
          executionReadiness: {
            state: "generated_unverified",
            sandboxEvidence: "not_run",
            sandboxPrerequisitesReady: true,
            promotionPrerequisitesReady: false,
            unverifiedApis: [],
            blockers: [],
          },
        },
      },
    };
  }

  it("fails closed before executing a non-read-only commandless job", async () => {
    const suffix = randomUUID().slice(0, 8);
    const ctx = { tenantId, actorId: "test-fde" };
    const { project } = createOntoCodeProject(ctx, {
      domain: ontology.domainId,
      name: `Commandless worker guard ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Commandless worker guard ${suffix}`,
      goal: "Must not build without a policy-derived Command",
      autonomyMode: "sandbox_autopilot",
      ontologySnapshotHash: factorySourceOntologyHash(ontology),
    });
    const { job } = createOntoCodeHarnessJob(ctx, session.id, {
      kind: "build",
      expectedSessionRevision: session.revision,
      idempotencyKey: `commandless-build-${suffix}`,
    });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
      maxAttempts: 1,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "failed_terminal",
    });
    expect(factory.fetchOntology).not.toHaveBeenCalled();
    expect(factory.runBuild).not.toHaveBeenCalled();
    const failed = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, job.id),
          eq(ontocodeSessionEvents.type, "harness.job.failed"),
        ),
      )
      .get();
    expect(JSON.parse(failed?.payloadJson ?? "{}")).toMatchObject({
      error: {
        code: "non_read_only_command_required",
        recoverable: false,
        retryable: false,
      },
    });
  });

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

  it("renews the exact fenced lease when durable progress is written", async () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    let now = Date.now();
    let releaseExecutor!: () => void;
    let progressPersisted!: () => void;
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const progressGate = new Promise<void>((resolve) => {
      progressPersisted = resolve;
    });
    const first = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      leaseTimeoutMs: 1_000,
      now: () => now,
      executors: {
        scope: async (context) => {
          // Model/tool progress can arrive after a delayed timer turn. The
          // progress row itself is incontrovertible activity and must renew
          // the same started_at fencing epoch atomically.
          now += 1_500;
          await context.progress("harness.scope.tool_call", {
            tool: "ontology.read",
            reasoning: "Continue the same live scope pass",
          });
          progressPersisted();
          await executorGate;
          return { outcome: "succeeded", receipt: { ok: true } };
        },
      },
    });
    const running = first.runNext();
    await progressGate;

    const second = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      leaseTimeoutMs: 1_000,
      now: () => now,
    });
    expect(second.claimNextJob()).toBeNull();

    releaseExecutor();
    await expect(running).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
  });

  it("heartbeats a silent long-running executor past the stale window", async () => {
    vi.useFakeTimers();
    const fixture = makeQueuedJob({ kind: "scope" });
    let now = Date.now();
    let releaseExecutor!: () => void;
    let executorStarted!: () => void;
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const startedGate = new Promise<void>((resolve) => {
      executorStarted = resolve;
    });
    const first = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      leaseTimeoutMs: 1_000,
      now: () => now,
      executors: {
        scope: async () => {
          executorStarted();
          await executorGate;
          return { outcome: "succeeded", receipt: { ok: true } };
        },
      },
    });

    try {
      const running = first.runNext();
      await startedGate;
      // No model/tool frame is emitted while the external call is pending.
      // The periodic heartbeat alone must keep this exact lease current.
      now += 1_500;
      await vi.advanceTimersByTimeAsync(400);

      const second = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory: fakeFactory(),
        leaseTimeoutMs: 1_000,
        now: () => now,
      });
      expect(second.claimNextJob()).toBeNull();

      releaseExecutor();
      await expect(running).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
    } finally {
      releaseExecutor();
      vi.useRealTimers();
    }
  });

  it("reclaims a stale running lease when its worker stopped heartbeating", () => {
    const fixture = makeQueuedJob({ kind: "scope" });
    let now = Date.now();
    const stoppedWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      leaseTimeoutMs: 1_000,
      now: () => now,
    });
    const stoppedClaim = stoppedWorker.claimNextJob();
    expect(stoppedClaim?.jobId).toBe(fixture.job.id);
    getDb()
      .update(ontocodeHarnessJobs)
      .set({ status: "running", updatedAt: new Date(now) })
      .where(
        and(
          eq(ontocodeHarnessJobs.id, fixture.job.id),
          eq(ontocodeHarnessJobs.startedAt, new Date(stoppedClaim!.leaseToken)),
        ),
      )
      .run();

    now += 1_001;
    const recoveryWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      leaseTimeoutMs: 1_000,
      now: () => now,
    });
    expect(recoveryWorker.claimNextJob()).toMatchObject({
      jobId: fixture.job.id,
      recovered: true,
      previousStatus: "running",
    });

    // This test exercises only the claim boundary; do not leave its synthetic
    // recovery lease eligible for a later test in this shared DB suite.
    getDb()
      .update(ontocodeHarnessJobs)
      .set({
        status: "cancelled",
        finishedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(eq(ontocodeHarnessJobs.id, fixture.job.id))
      .run();
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

  it("analyzes the current FDE instruction instead of a stale session goal", async () => {
    const instruction =
      "请根据我们的 Ontology 直接生成需要的 agents，请开始设计和写 coding。";
    const fixture = makeQueuedJob({
      kind: "scope",
      sessionGoal: "你好",
      commandArguments: { instruction, source: "ontocode-assistant" },
    });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(factory.recommendScope).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: instruction }),
    );
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

  it("durably chains an explicit autonomous full Build through Scope, Blueprint and Package only", async () => {
    // The blueprint leg reasons for real now (no gateway ⇒ honest failure), so
    // the chain needs a reachable test gateway. Prose without the structure
    // marker keeps every phase mechanical — honestly labelled — and succeeds.
    setFactoryModelAdapter(async () => ({
      text: "按触发事件读取目标对象，再发出下游事件。",
      provider: "test-adapter",
      model: "test-model",
      tokensIn: 5,
      tokensOut: 10,
    }));
    try {
      const pipeline = createOntoCodeAutopilotBuildPipeline(
        `ocar-worker-${randomUUID().slice(0, 8)}`,
      );
      const fixture = makeQueuedJob({
        kind: "scope",
        riskClass: "read_only",
        commandArguments: {
          scopeMode: "full_domain",
          scenario: "Build every Agent-owned Action",
          autopilotBuildPipeline: pipeline,
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
      let rows = getDb()
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, fixture.session.id))
        .all();
      expect(rows.map((row) => [row.kind, row.status])).toEqual(
        expect.arrayContaining([
          ["scope", "succeeded"],
          ["blueprint", "queued"],
        ]),
      );
      const blueprintJob = rows.find((row) => row.kind === "blueprint");
      expect(blueprintJob).toBeTruthy();
      const blueprintCommand = getDb()
        .select()
        .from(ontocodeCommands)
        .where(eq(ontocodeCommands.id, blueprintJob!.commandId!))
        .get();
      expect(blueprintCommand).toMatchObject({
        type: "propose_blueprint",
        riskClass: "draft_change",
        status: "queued",
        requiresHuman: false,
      });
      expect(JSON.parse(blueprintCommand!.argumentsJson)).toMatchObject({
        source: "ontocode-autopilot-continuation",
        autopilotBuildPipeline: pipeline,
      });

      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: blueprintJob!.id,
        status: "succeeded",
      });
      rows = getDb()
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, fixture.session.id))
        .all();
      const buildJob = rows.find((row) => row.kind === "build");
      expect(buildJob).toBeTruthy();
      expect(buildJob).toMatchObject({ status: "queued" });
      const buildCommand = getDb()
        .select()
        .from(ontocodeCommands)
        .where(eq(ontocodeCommands.id, buildJob!.commandId!))
        .get();
      expect(buildCommand).toMatchObject({
        type: "generate_package",
        riskClass: "draft_change",
        status: "queued",
        requiresHuman: false,
      });
      expect(JSON.parse(buildJob!.budgetJson ?? "{}")).toEqual({
        maxWallClockMs: 600_000,
        maxModelCalls: 10,
        maxToolCalls: 24,
      });

      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: buildJob!.id,
        status: "succeeded",
      });
      rows = getDb()
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, fixture.session.id))
        .all();
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.kind).sort()).toEqual([
        "blueprint",
        "build",
        "scope",
      ]);
      expect(rows.every((row) => row.status === "succeeded")).toBe(true);
      expect(
        rows.some((row) =>
          ["test", "regression", "promotion", "deploy"].includes(row.kind),
        ),
      ).toBe(false);
      expect(
        getDb()
          .select()
          .from(ontocodeSessionEvents)
          .where(
            and(
              eq(ontocodeSessionEvents.sessionId, fixture.session.id),
              eq(
                ontocodeSessionEvents.type,
                "harness.autopilot.continuation.queued",
              ),
            ),
          )
          .all(),
      ).toHaveLength(2);
      expect(
        getOntoCodeSession({ tenantId }, fixture.session.id),
      ).toMatchObject({
        phase: "verify",
        activityState: "idle",
      });
    } finally {
      setFactoryModelAdapter(null);
    }
  });

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

  it("fails the blueprint honestly when no model gateway is available — the mechanical skeleton is input, never a deliverable", async () => {
    // 产品铁律（用户两次明示）：不要降级，全都用 AI 来推理。此前无网关时这个执行器
    // 交付一份确定性的机械蓝图并在回执里标 status:"unavailable"——机械骨架被当成了
    // 交付物。现在锁死的行为：无网关 ⇒ 作业按既有失败回执纪律如实失败。
    const fixture = makeQueuedJob({ kind: "blueprint" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      claimed: true,
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    const job = getOntoCodeHarnessJob({ tenantId }, fixture.job.id);
    expect(job.status).toBe("failed_recoverable");
    expect(String(job.errorMessage ?? "")).toContain("模型网关");
    expect(getOntoCodeCommand({ tenantId }, fixture.command.id).status).toBe(
      "failed",
    );
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
        // The mechanical derivation stays visible as reasoning INPUT…
        "harness.blueprint.grounded",
        "harness.job.failed",
      ]),
    );
    // …but it never becomes a deliverable.
    expect(types).not.toContain("harness.blueprint.completed");
  });

  it("reasons the blueprint per phase when a gateway is reachable, and refuses the ids it invents", async () => {
    // #BLUEPRINT-REASON — the FDE's complaint was that a blueprint appeared in
    // one second with zero model calls. With a reachable gateway the stage must
    // actually derive each phase's business logic, stream that derivation, and
    // still refuse anything that does not exist in the authoritative Ontology.
    const calls: Array<{ purpose?: string }> = [];
    setFactoryModelAdapter(async (input) => {
      calls.push({ purpose: input.purpose });
      return {
        text: [
          "触发事件先到达，再读取目标对象，最后写结论并发出下游事件。",
          BLUEPRINT_REASONING_STRUCTURE_MARKER,
          JSON.stringify({
            steps: [
              {
                label: "Load the target object named on the trigger event",
                // `Ghost` does not exist: it must be refused, not rendered.
                reads: ["Candidate", "Ghost"],
                anchors: [{ kind: "action", id: "screen-candidate" }],
              },
              {
                label: "Emit the downstream event",
                emits: ["CANDIDATE_SCREENED"],
                anchors: [{ kind: "event", id: "CANDIDATE_SCREENED" }],
              },
            ],
          }),
        ].join("\n"),
        provider: "test-adapter",
        model: "test-model",
        tokensIn: 10,
        tokensOut: 20,
      };
    });
    try {
      const fixture = makeQueuedJob({ kind: "blueprint" });
      const worker = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory: fakeFactory(),
      });

      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
      expect(calls.length).toBeGreaterThan(0);

      const events = getDb()
        .select({
          type: ontocodeSessionEvents.type,
          payloadJson: ontocodeSessionEvents.payloadJson,
        })
        .from(ontocodeSessionEvents)
        .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
        .all();
      expect(events.map((row) => row.type)).toEqual(
        expect.arrayContaining([
          "harness.blueprint.strategy",
          "harness.blueprint.reasoning_step",
          "harness.blueprint.deliberation",
        ]),
      );
      const reasoningStep = JSON.parse(
        events.find((row) => row.type === "harness.blueprint.reasoning_step")!
          .payloadJson,
      );
      expect(reasoningStep).toMatchObject({ index: 0, total: 1 });
      expect(String(reasoningStep.output)).toContain("触发事件先到达");

      const receipt = JSON.parse(
        events.find((row) => row.type === "harness.blueprint.completed")!
          .payloadJson,
      ).receipt;
      expect(receipt.reasoning.status).toBe("completed");
      expect(receipt.reasoning.coverage).toMatchObject({
        phases: 1,
        phasesReasoned: 1,
        rejectedReferences: 1,
      });
      const phase = receipt.model.phases[0];
      expect(phase.steps.map((step: { label: string }) => step.label)).toEqual([
        "Load the target object named on the trigger event",
        "Emit the downstream event",
      ]);
      expect(phase.steps[0].reads).toEqual(["Candidate"]);
      expect(phase.deliberation).toContain("触发事件先到达");
      // The fabricated id is named as a gap, never rendered as a fact.
      expect(
        receipt.model.unresolved.flatMap(
          (entry: { citedAnchors: Array<{ id: string }> }) =>
            entry.citedAnchors.map((anchor) => anchor.id),
        ),
      ).toContain("Ghost");
    } finally {
      setFactoryModelAdapter(null);
    }
  });

  it("anchors the blueprint reasoning deadline at the JOB's start, not the pass's start", () => {
    // blueprint-reasoning now honours budget.deadlineAt (absolute unix-ms):
    // pass deadline = min(passStart + maxWallClockMs, deadlineAt). The worker
    // must hand it the same anchor its own wall-clock timer uses —
    // claim.leaseToken — so time spent before the reasoning pass cannot let
    // the pass overrun the job's stated budget.
    const policy = ONTOCODE_COMMAND_POLICY.propose_blueprint;
    const leaseToken = 1_722_000_000_000;
    const tightened = Math.min(120_000, policy.budget.maxWallClockMs);
    const budget = resolveBlueprintReasoningBudget({
      claim: { leaseToken },
      job: { budget: { maxWallClockMs: 120_000, maxModelCalls: 3 } },
      command: { type: "propose_blueprint" },
    } as never);
    expect(budget).toMatchObject({
      maxModelCalls: Math.min(3, policy.budget.maxModelCalls),
      maxWallClockMs: tightened,
      deadlineAt: leaseToken + tightened,
    });
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
        budget: {
          maxWallClockMs: 600_000,
          maxModelCalls: 10,
          maxToolCalls: 24,
        },
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

  it("parks on the Factory terminal waiting state, records clarification evidence, then stops the old run", async () => {
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
          callback({
            t: "done",
            status: "waiting_human",
            completionKind: "awaiting_input",
            tokensUsed: 40,
            turns: 2,
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

    const persistedJob = getOntoCodeHarnessJob({ tenantId }, fixture.job.id);
    expect(persistedJob.buildExecutionId).toMatch(/^ocx-/);
    const expectedRunId = `ocf-${persistedJob.buildExecutionId}`;
    expect(runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expectedRunId,
        executionBudget: {
          maxTurns: 10,
          maxToolCalls: 24,
          stableExecutionId: persistedJob.buildExecutionId,
        },
      }),
    );
    expect(stopFactoryRun).toHaveBeenCalledWith(expectedRunId, tenantId);
    expect(runtime.abortRun).toHaveBeenCalledWith(expectedRunId, tenantId);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(persistedJob).toMatchObject({
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

  it("recovers the exact test-approval gate from a legacy waiting receipt that omitted interaction", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    getDb()
      .update(ontocodeCommands)
      .set({ baseOntologyHash: factorySourceOntologyHash(ontology) })
      .where(eq(ontocodeCommands.id, fixture.command.id))
      .run();
    const factoryRunId = `ocf-ocx-${fixture.job.id.replace(/^ocj-/, "")}`;
    factoryRunIds.push(factoryRunId);
    const interactionId = "hitl_33333333-3333-4333-8333-333333333333";
    const testCases = [{ id: "happy-1" }, { id: "branch-1" }];
    const coverage = {
      required: ["happy:START", "branch:route(A|B)"],
      covered: ["happy:START"],
      backfilled: [],
      uncoveredNeedingData: ["branch:route(A|B)"],
    };
    let rootBuildInput:
      | Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0]
      | undefined;
    const rootFactory = fakeFactory({
      runBuild: vi.fn(async (input) => {
        rootBuildInput = input;
        await input.onProgress("harness.build.test_cases", {
          factoryRunId,
          count: testCases.length,
          awaitingApproval: true,
          coverage,
        });
        const now = new Date();
        getDb()
          .insert(factoryRuns)
          .values({
            id: factoryRunId,
            tenantId,
            domain: ontology.domainId,
            ontologyDomainRegistrationId:
              fixture.project.ontologyDomainRegistrationId,
            runtimeProfileVersionId: fixture.job.runtimeProfileVersionId,
            goal: fixture.session.goal,
            status: "waiting_human",
            tokensUsed: 30,
            turns: 1,
            agentsCount: 0,
            reachedTerminal: false,
            transcriptJson: [],
            createdAt: now,
            updatedAt: now,
          })
          .run();
        getDb()
          .insert(factoryConversations)
          .values({
            id: factoryRunId,
            tenantId,
            domain: ontology.domainId,
            messagesJson: [],
            ctxJson: {
              domain: ontology.domainId,
              generationDirective: input.directive,
              specs: [],
              awaitingApproval: true,
              testDataSupplementPending: false,
              testCases,
              testCoverage: coverage,
              humanInteractions: {
                test_approval: {
                  interactionId,
                  kind: "test_approval",
                  // The in-memory subject may have contained optional undefined
                  // fields which JSON checkpointing dropped. Recovery must bind
                  // to the active gate + exact progress row, not recompute this
                  // pre-serialization digest from a lossy restored object.
                  subjectDigest: "a".repeat(64),
                  createdAt: now.getTime(),
                },
              },
            },
            createdAt: now,
            updatedAt: now,
          })
          .run();
        // Historical bug shape: the Factory checkpoint has the exact gate,
        // but this receipt dropped it and therefore projected no buttons.
        return {
          outcome: "waiting_user",
          message:
            "Agent Factory needs an FDE decision or configuration before continuing",
          receipt: {
            factoryRunId,
            status: "waiting_human",
            completionKind: "incomplete",
            agents: [],
          },
        };
      }),
    });
    const rootWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: rootFactory,
      stopFactoryRun: vi.fn(() => true),
    });
    await expect(rootWorker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(rootBuildInput).toBeTruthy();

    const current = getOntoCodeSession({ tenantId }, fixture.session.id);
    const followUpCommand = createOntoCodeCommand(
      fixture.ctx,
      fixture.session.id,
      {
        type: "generate_package",
        arguments: {
          actionIds: ["screen-candidate"],
          resumeWaitingUserJobId: fixture.job.id,
          clarificationAnswer: "[测试用例决策: 补数据]",
        },
        expectedSessionRevision: current.revision,
        baseOntologyHash: factorySourceOntologyHash(ontology),
        affectedSemanticPaths: [],
        riskClass: "draft_change",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: "Resume the exact parked test approval",
        idempotencyKey: `command-test-gate-follow-up-${randomUUID()}`,
      },
    );
    const followUp = createOntoCodeHarnessJob(fixture.ctx, fixture.session.id, {
      commandId: followUpCommand.command.id,
      kind: "build",
      expectedSessionRevision: followUpCommand.sessionRevision,
      idempotencyKey: `job-test-gate-follow-up-${randomUUID()}`,
    });

    const resumedBuild = vi.fn(
      async (
        input: Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0],
      ) => {
        expect(input.resume).toMatchObject({
          waitingJobId: fixture.job.id,
          factoryRunId,
          interactionId,
          interactionKind: "test_approval",
          answer: "[测试用例决策: 补数据]",
        });
        return fakeFactory().runBuild(input);
      },
    );
    const followUpWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({ runBuild: resumedBuild }),
    });
    const resumed = await followUpWorker.runNext();
    expect(getOntoCodeHarnessJob({ tenantId }, followUp.job.id)).toMatchObject({
      status: "succeeded",
      errorMessage: null,
    });
    expect(resumed).toMatchObject({
      jobId: followUp.job.id,
      status: "succeeded",
    });
    expect(resumedBuild).toHaveBeenCalledTimes(1);
  });

  async function prepareHistoricalOperatorRetryClarification(
    input: {
      checkpointInteractionId?: string;
    } = {},
  ) {
    const fixture = makeQueuedJob({ kind: "build" });
    const factoryRunId = `ocf-${fixture.job.id}-a1`;
    factoryRunIds.push(factoryRunId);
    const eventInteractionId = `hitl-${randomUUID()}`;
    const checkpointInteractionId =
      input.checkpointInteractionId ?? eventInteractionId;
    const question =
      "processResume 应由哪个真实执行面连接 Internal_Recruitment_System/execute？";
    const context =
      "如果该连接尚未建设，可以确认人工边界；设计稿可继续，执行与晋升仍保持关闭。";
    const options = [
      {
        label: "确认人工边界",
        value: "confirm_manual_boundary",
        recommended: true,
      },
    ];
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const checkpointSpec = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      nameZh: "Candidate screening",
      tools: [],
      plan: [],
      generatedCode,
    };
    let invocation = 0;
    const runBuild = vi.fn(
      async (
        buildInput: Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0],
      ) => {
        invocation += 1;
        if (invocation !== 1) {
          throw new Error(
            "historical clarification checkpoint must be reconciled without replaying runBuild",
          );
        }
        const now = new Date();
        getDb()
          .insert(factoryRuns)
          .values({
            id: factoryRunId,
            tenantId,
            domain: ontology.domainId,
            ontologyDomainRegistrationId:
              fixture.project.ontologyDomainRegistrationId,
            runtimeProfileVersionId: fixture.job.runtimeProfileVersionId,
            goal: buildInput.goal,
            status: "failed",
            tokensUsed: 180,
            turns: 8,
            agentsCount: 1,
            reachedTerminal: false,
            errorMessage: "Agent Factory ended with turns_exhausted/incomplete",
            transcriptJson: [
              {
                t: "clarify",
                question,
                context,
                options,
                items: [],
                awaitingAnswer: true,
                interactionId: eventInteractionId,
              },
              {
                t: "done",
                tokensUsed: 180,
                conversationTokensUsed: 180,
                turns: 8,
                status: "turns_exhausted",
                completionKind: "incomplete",
              },
            ],
            createdAt: now,
            updatedAt: now,
          })
          .run();
        getDb()
          .insert(factoryConversations)
          .values({
            id: factoryRunId,
            tenantId,
            domain: ontology.domainId,
            messagesJson: [],
            ctxJson: {
              domain: ontology.domainId,
              ontology,
              generationDirective: buildInput.directive,
              specs: [checkpointSpec],
              awaitingClarify: true,
              clarifyPrompt: {
                question,
                context,
                options,
                items: [],
              },
              humanInteractions: {
                clarify: {
                  interactionId: checkpointInteractionId,
                  kind: "clarify",
                  subjectDigest: createHash("sha256")
                    .update(
                      canonicalEvidenceJson({ question, context, options }),
                    )
                    .digest("hex"),
                  createdAt: now.getTime(),
                },
              },
            },
            createdAt: now,
            updatedAt: now,
          })
          .run();
        // This fixture represents a checkpoint written by the pre-execution-
        // identity worker. The current worker emits its provisional stable
        // engine id before invoking the adapter, so restore the historical
        // factory_started payload that the recovery protocol is meant to read.
        const startedEvent = getDb()
          .select({
            id: ontocodeSessionEvents.id,
            payloadJson: ontocodeSessionEvents.payloadJson,
          })
          .from(ontocodeSessionEvents)
          .where(
            and(
              eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
              eq(ontocodeSessionEvents.type, "harness.build.factory_started"),
            ),
          )
          .get();
        expect(startedEvent).toBeTruthy();
        getDb()
          .update(ontocodeSessionEvents)
          .set({
            payloadJson: canonicalEvidenceJson({
              ...(JSON.parse(startedEvent!.payloadJson) as Record<
                string,
                unknown
              >),
              factoryRunId,
            }),
          })
          .where(eq(ontocodeSessionEvents.id, startedEvent!.id))
          .run();
        await buildInput.onProgress("harness.build.clarification", {
          factoryRunId,
          kind: "clarify",
          awaitingAnswer: true,
          interactionId: eventInteractionId,
          question,
          context,
          options,
          items: [],
        });
        throw new OntoCodeHarnessExecutionError(
          "factory_build_incomplete",
          "Agent Factory ended with turns_exhausted/incomplete",
          {
            recoverable: true,
            retryable: false,
            details: {
              factoryRunId,
              status: "turns_exhausted",
              completionKind: "incomplete",
            },
          },
        );
      },
    );
    const factory = fakeFactory({ runBuild });
    const firstWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
    });

    await expect(firstWorker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    const failedJob = getOntoCodeHarnessJob({ tenantId }, fixture.job.id);
    expect(failedJob).toMatchObject({
      status: "failed_recoverable",
      buildExecutionId: expect.stringMatching(/^ocx-/),
    });
    // The failed frame above is produced through today's worker only to build
    // the historical transcript. Remove today's product identity before the
    // retry so the recovery path sees the same pre-integration database shape
    // as the deployed final-turn defect: old Factory events, no execution FK.
    getDb()
      .update(ontocodeHarnessJobs)
      .set({ buildExecutionId: null, updatedAt: new Date() })
      .where(eq(ontocodeHarnessJobs.id, fixture.job.id))
      .run();
    getDb()
      .delete(ontocodeBuildExecutions)
      .where(eq(ontocodeBuildExecutions.id, failedJob.buildExecutionId!))
      .run();
    expect(
      retryOntoCodeSessionJob(fixture.ctx, fixture.session.id, fixture.job.id),
    ).toMatchObject({
      retried: true,
      jobId: fixture.job.id,
      attempt: 1,
      event: {
        type: "harness.job.retry_scheduled",
        payload: {
          source: "fde",
          error: { code: "operator_retry" },
        },
      },
    });

    return {
      fixture,
      factory,
      factoryRunId,
      runBuild,
      checkpointSpec,
      eventInteractionId,
      question,
      options,
    };
  }

  it("reconciles an exact final-turn Factory clarification after an operator retry without rerunning Build", async () => {
    const prepared = await prepareHistoricalOperatorRetryClarification();
    const retryWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: prepared.factory,
      retryDelayMs: 0,
    });

    await expect(retryWorker.runNext()).resolves.toMatchObject({
      jobId: prepared.fixture.job.id,
      status: "waiting_user",
    });
    expect(prepared.runBuild).toHaveBeenCalledTimes(1);
    expect(
      getDb()
        .select({ id: factoryRuns.id })
        .from(factoryRuns)
        .where(eq(factoryRuns.id, `${prepared.factoryRunId.slice(0, -2)}a2`))
        .get(),
    ).toBeUndefined();

    const rows = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payloadJson: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, prepared.fixture.job.id))
      .all();
    expect(
      rows.filter((row) => row.type === "harness.build.factory_started"),
    ).toHaveLength(1);
    const waitingRows = rows.filter(
      (row) => row.type === "harness.build.waiting_user",
    );
    expect(waitingRows).toHaveLength(1);
    expect(JSON.parse(waitingRows[0]!.payloadJson)).toMatchObject({
      attempt: 2,
      receipt: {
        factoryRunId: prepared.factoryRunId,
        status: "waiting_human",
        agentPreviews: [
          expect.objectContaining({
            slug: prepared.checkpointSpec.slug,
            actionName: prepared.checkpointSpec.actionName,
            generatedCode: prepared.checkpointSpec.generatedCode,
          }),
        ],
        interaction: {
          interactionId: prepared.eventInteractionId,
          question: prepared.question,
          options: prepared.options,
        },
      },
    });
  });

  it("keeps a historical operator-retry clarification fail-closed when the durable interaction id differs", async () => {
    const prepared = await prepareHistoricalOperatorRetryClarification({
      checkpointInteractionId: `hitl-${randomUUID()}`,
    });
    const retryWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: prepared.factory,
      retryDelayMs: 0,
    });

    await expect(retryWorker.runNext()).resolves.toMatchObject({
      jobId: prepared.fixture.job.id,
      status: "failed_recoverable",
    });
    expect(prepared.runBuild).toHaveBeenCalledTimes(1);
    expect(
      getDb()
        .select({ id: factoryRuns.id })
        .from(factoryRuns)
        .where(eq(factoryRuns.id, `${prepared.factoryRunId.slice(0, -2)}a2`))
        .get(),
    ).toBeUndefined();

    const failures = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, prepared.fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.job.failed"),
        ),
      )
      .all()
      .map((row) => JSON.parse(row.payloadJson) as Record<string, unknown>);
    const controlFailure = failures.at(-1)!;
    const rawCode = String(
      (controlFailure.error as Record<string, unknown>).code,
    );
    expect(rawCode).toMatch(/^factory_/);
    const productCode = rawCode.replace(/^factory_/, "ontocode_engine_");
    expect(controlFailure).toMatchObject({
      attempt: 2,
      status: "failed_recoverable",
      error: {
        code: rawCode,
        recoverable: true,
        retryable: false,
      },
    });
    const failedJob = getOntoCodeHarnessJob(
      { tenantId },
      prepared.fixture.job.id,
    );
    expect(String(failedJob.errorMessage)).not.toMatch(
      /Agent Factory|\bFactory\b|factory_/i,
    );
    const buildFailure = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, prepared.fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.build.failed"),
        ),
      )
      .all()
      .map((row) => JSON.parse(row.payloadJson) as Record<string, unknown>)
      .find(
        (payload) =>
          (
            (payload.receipt as Record<string, unknown>)?.error as
              | Record<string, unknown>
              | undefined
          )?.code === rawCode,
      );
    expect(buildFailure).toBeDefined();
    expect(String(buildFailure!.message)).not.toMatch(
      /Agent Factory|\bFactory\b|factory_/i,
    );
    const failureMessages = listOntoCodeMessages(
      { tenantId },
      prepared.fixture.session.id,
      { limit: 20, offset: 0 },
    ).items.filter((message) => message.type === "error");
    const failureMessage = failureMessages.find((message) => {
      const receipt = message.content.receipt as
        | Record<string, unknown>
        | undefined;
      return (
        (receipt?.error as Record<string, unknown> | undefined)?.code ===
        rawCode
      );
    });
    expect(failureMessage).toBeDefined();
    expect(failureMessage!.content.error).toMatchObject({ code: productCode });
    expect(JSON.stringify(failureMessage!.content.error)).not.toMatch(
      /Agent Factory|\bFactory\b|factory_/i,
    );
    // The raw engine error remains available inside the immutable receipt and
    // the durable harness.job.* recovery control record, never the chat view.
    expect(failureMessage!.content.receipt).toMatchObject({
      error: {
        code: rawCode,
        message: expect.any(String),
      },
    });
    const privateEngineReceiptMessage = failureMessages.find((message) => {
      const receipt = message.content.receipt as
        | Record<string, unknown>
        | undefined;
      const error = receipt?.error as Record<string, unknown> | undefined;
      return /Agent Factory|\bFactory\b|factory_/i.test(
        `${String(error?.code ?? "")} ${String(error?.message ?? "")}`,
      );
    });
    expect(privateEngineReceiptMessage).toBeDefined();
    expect(
      JSON.stringify(privateEngineReceiptMessage!.content.error),
    ).not.toMatch(/Agent Factory|\bFactory\b|factory_/i);
    const failureText = String(failureMessage?.content.text ?? "");
    expect(failureText).toContain("OntoCode 无法完成代码生成");
    expect(failureText).not.toMatch(/Agent Factory|\bFactory\b|\bHarness\b/);
    expect(failureText).not.toContain(rawCode);
    expect(
      getDb()
        .select({ id: ontocodeSessionEvents.id })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, prepared.fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
          ),
        )
        .get(),
    ).toBeUndefined();
  });

  it("recovers a stable OntoCode waiting checkpoint after worker_stopped without reconstructing attempt events or replaying the old answer", async () => {
    const actionNames = [
      "ruleCheckForMatchResume",
      "matchResume",
      "inviteInternalInterview",
      "createJD",
      "processResume",
      "ruleCheckForCandidateIdentity",
    ];
    const actionIds = actionNames.map(
      (_actionName, index) => `crash-action-${index + 1}`,
    );
    const crashOntology: DomainOntology = {
      ...ontology,
      actions: actionNames.map((name, index) => ({
        ...ontology.actions[0]!,
        id: actionIds[index]!,
        name,
        description: `Generate ${name}`,
      })),
    };
    const ontologyHash = factorySourceOntologyHash(crashOntology);
    const fixture = makeQueuedJob({
      kind: "build",
      commandArguments: { actionIds },
    });
    getDb()
      .update(ontocodeSessions)
      .set({ ontologySnapshotHash: ontologyHash })
      .where(eq(ontocodeSessions.id, fixture.session.id))
      .run();
    getDb()
      .update(ontocodeCommands)
      .set({ baseOntologyHash: ontologyHash })
      .where(eq(ontocodeCommands.id, fixture.command.id))
      .run();

    const previewSpecs = actionNames.slice(0, 5).map((actionName, index) => {
      const generatedCode = `export async function ${actionName}(input: unknown) { return input; }`;
      return {
        slug: `checkpoint-agent-${index + 1}`,
        actionName,
        nameZh: actionName,
        tools: [],
        plan: [],
        generatedCode,
      };
    });
    const previewAgents = previewSpecs.map((spec) => ({
      slug: spec.slug,
      actionName: spec.actionName,
      name: spec.nameZh,
      card: { ...spec },
      design: { code: spec.generatedCode },
      generatedCode: spec.generatedCode,
    }));
    const oldInteractionId = "hitl_11111111-aaaa-4111-8111-111111111111";
    const oldQuestion = "请选择第一个真实连接。";
    const oldOptions = [
      {
        label: "Allmeta Ontology",
        value: "integration-selection:v1:old",
      },
    ];
    let rootBuildInput:
      | Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0]
      | undefined;
    const factoryRunId = `ocf-ocx-${fixture.job.id.replace(/^ocj-/, "")}`;
    factoryRunIds.push(factoryRunId);
    const rootFactory = fakeFactory({
      fetchOntology: vi.fn(async () => crashOntology),
      runBuild: vi.fn(async (input) => {
        rootBuildInput = input;
        return {
          outcome: "waiting_user",
          message: oldQuestion,
          receipt: {
            factoryRunId,
            status: "waiting_human",
            completionKind: "awaiting_input",
            agents: [],
            agentPreviews: previewAgents,
            candidateEligibility: "non_candidate_preview",
            interaction: {
              kind: "clarify",
              awaitingAnswer: true,
              interactionId: oldInteractionId,
              question: oldQuestion,
              options: oldOptions,
              items: [],
              context: null,
            },
          },
        };
      }),
    });
    const rootWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: rootFactory,
      stopFactoryRun: vi.fn(() => true),
    });
    await expect(rootWorker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
    });
    expect(rootBuildInput).toBeTruthy();

    const now = new Date();
    getDb()
      .insert(factoryRuns)
      .values({
        id: factoryRunId,
        tenantId,
        domain: crashOntology.domainId,
        ontologyDomainRegistrationId:
          fixture.project.ontologyDomainRegistrationId,
        runtimeProfileVersionId: fixture.project.runtimeProfileVersionId,
        goal: fixture.session.goal,
        status: "waiting_human",
        tokensUsed: 100,
        turns: 4,
        agentsCount: 5,
        reachedTerminal: false,
        transcriptJson: [],
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getDb()
      .insert(factoryConversations)
      .values({
        id: factoryRunId,
        tenantId,
        domain: crashOntology.domainId,
        messagesJson: [],
        ctxJson: {
          domain: crashOntology.domainId,
          generationDirective: rootBuildInput!.directive,
          specs: previewSpecs,
          awaitingClarify: true,
          clarifyPrompt: {
            question: oldQuestion,
            options: oldOptions,
          },
          humanInteractions: {
            clarify: {
              interactionId: oldInteractionId,
              kind: "clarify",
              subjectDigest: createHash("sha256")
                .update(
                  canonicalEvidenceJson({
                    question: oldQuestion,
                    context: null,
                    options: oldOptions,
                  }),
                )
                .digest("hex"),
              createdAt: now.getTime(),
            },
          },
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const sessionBeforeFollowUp = getOntoCodeSession(
      { tenantId },
      fixture.session.id,
    );
    const followUpCommandResult = createOntoCodeCommand(
      fixture.ctx,
      fixture.session.id,
      {
        type: "generate_package",
        arguments: {
          actionIds,
          resumeWaitingUserJobId: fixture.job.id,
          clarificationAnswer: oldOptions[0]!.value,
        },
        expectedSessionRevision: sessionBeforeFollowUp.revision,
        baseOntologyHash: ontologyHash,
        affectedSemanticPaths: [],
        riskClass: "draft_change",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: "Resume the exact parked Factory interaction",
        idempotencyKey: `command-crash-follow-up-${randomUUID()}`,
      },
    );
    const followUp = createOntoCodeHarnessJob(fixture.ctx, fixture.session.id, {
      commandId: followUpCommandResult.command.id,
      kind: "build",
      expectedSessionRevision: followUpCommandResult.sessionRevision,
      idempotencyKey: `job-crash-follow-up-${randomUUID()}`,
    });
    const nextInteractionId = "hitl_22222222-bbbb-4222-8222-222222222222";
    const nextQuestion =
      "ruleCheckForCandidateIdentity 应该使用哪个真实连接方式？";
    const nextContext = "必须由 FDE 选择经过审查的运行时能力。";
    const nextOptions = [
      {
        label: "ontology.fetchActionRules",
        value: "integration-selection:v1:new",
        recommended: true,
      },
    ];
    let releaseCheckpoint!: () => void;
    const checkpointPersisted = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const runBuild = vi.fn(
      async (
        input: Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0],
      ) => {
        expect(input.resume).toMatchObject({
          waitingJobId: fixture.job.id,
          factoryRunId,
          interactionId: oldInteractionId,
          answer: oldOptions[0]!.value,
          capturedAgents: expect.arrayContaining([
            expect.objectContaining({
              actionName: previewSpecs[0]!.actionName,
            }),
          ]),
        });
        input.onAnswerDelivery?.("queued");
        getDb()
          .update(factoryRuns)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(factoryRuns.id, factoryRunId))
          .run();
        getDb()
          .update(factoryConversations)
          .set({
            ctxJson: {
              domain: crashOntology.domainId,
              ontology: crashOntology,
              generationDirective: input.directive,
              specs: previewSpecs,
              awaitingClarify: true,
              clarifyPrompt: {
                question: nextQuestion,
                context: nextContext,
                options: nextOptions,
                items: [],
              },
              pendingIntegrationSelectionAsk: {
                ontologyHash: ontologyContentHash(crashOntology),
                actionName: actionNames[5],
                options: [
                  {
                    token: nextOptions[0]!.value,
                    requirementId: "identity:integration:1",
                    bindingKind: "tool",
                    bindingId: "ontology.fetchActionRules",
                  },
                ],
              },
              humanInteractions: {
                clarify: {
                  interactionId: nextInteractionId,
                  kind: "clarify",
                  subjectDigest: createHash("sha256")
                    .update(
                      canonicalEvidenceJson({
                        question: nextQuestion,
                        context: nextContext,
                        options: nextOptions,
                      }),
                    )
                    .digest("hex"),
                  createdAt: Date.now(),
                },
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(factoryConversations.id, factoryRunId))
          .run();
        await input.onProgress("harness.build.clarification", {
          factoryRunId,
          kind: "clarify",
          awaitingAnswer: true,
          interactionId: nextInteractionId,
          question: nextQuestion,
          context: nextContext,
          options: nextOptions,
          items: [],
        });
        // This is the boot-recovery contract: the row is atomically settled,
        // but neither a synthetic done nor a mirrored clarify is required.
        getDb()
          .update(factoryRuns)
          .set({
            status: "waiting_human",
            tokensUsed: 180,
            turns: 6,
            agentsCount: 5,
            transcriptJson: [],
            updatedAt: new Date(),
          })
          .where(eq(factoryRuns.id, factoryRunId))
          .run();
        releaseCheckpoint();
        return new Promise<never>((_resolve, reject) => {
          const stop = () => reject(input.signal.reason);
          if (input.signal.aborted) stop();
          else input.signal.addEventListener("abort", stop, { once: true });
        });
      },
    );
    const stopFactoryRun = vi.fn(() => true);
    const factory = fakeFactory({
      fetchOntology: vi.fn(async () => crashOntology),
      runBuild,
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
      stopFactoryRun,
      retryDelayMs: 0,
      maxAttempts: 5,
    });
    const workerStop = new AbortController();
    const firstAttempt = worker.runNext({ signal: workerStop.signal });
    await checkpointPersisted;
    workerStop.abort(
      new OntoCodeHarnessExecutionError(
        "worker_stopped",
        "OntoCode Harness Worker stopped before the waiting receipt commit",
        { recoverable: true, retryable: true },
      ),
    );
    await expect(firstAttempt).resolves.toMatchObject({
      jobId: followUp.job.id,
      status: "retry_scheduled",
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: followUp.job.id,
      status: "waiting_user",
    });
    expect(runBuild).toHaveBeenCalledTimes(1);
    expect(stopFactoryRun).toHaveBeenCalledWith(factoryRunId, tenantId);

    const waitingRows = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, followUp.job.id),
          eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
        ),
      )
      .all();
    expect(waitingRows).toHaveLength(1);
    const waitingReceipt = JSON.parse(waitingRows[0]!.payloadJson) as {
      attempt: number;
      receipt: Record<string, unknown>;
    };
    expect(waitingReceipt).toMatchObject({
      attempt: 2,
      receipt: {
        factoryRunId,
        status: "waiting_human",
        agentPreviews: previewSpecs.map((spec) =>
          expect.objectContaining({
            slug: spec.slug,
            actionName: spec.actionName,
            generatedCode: spec.generatedCode,
          }),
        ),
        interaction: {
          interactionId: nextInteractionId,
          question: nextQuestion,
          options: nextOptions,
        },
        recovery: {
          schema: "ontocode-build-stable-checkpoint-recovery/v1",
          buildExecutionId: followUp.job.buildExecutionId,
          finalizedByJobId: followUp.job.id,
          finalizedByAttempt: 2,
          replayedHumanAnswer: false,
        },
      },
    });
  });

  it("reattaches the same Factory run after worker_stopped before its first clarification", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const factoryRunId = `ocf-ocx-${fixture.job.id.replace(/^ocj-/, "")}`;
    factoryRunIds.push(factoryRunId);
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const checkpointSpec = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      nameZh: "Candidate screening",
      tools: [],
      plan: [],
      generatedCode,
    };
    let releaseCheckpoint!: () => void;
    const checkpointPersisted = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let invocation = 0;
    const runBuild = vi.fn(
      async (
        input: Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0],
      ) => {
        invocation += 1;
        if (invocation === 1) {
          const now = new Date();
          getDb()
            .insert(factoryRuns)
            .values({
              id: factoryRunId,
              tenantId,
              domain: ontology.domainId,
              ontologyDomainRegistrationId:
                fixture.project.ontologyDomainRegistrationId,
              runtimeProfileVersionId: fixture.project.runtimeProfileVersionId,
              goal: input.goal,
              status: "running",
              tokensUsed: 75,
              turns: 3,
              agentsCount: 1,
              reachedTerminal: false,
              transcriptJson: [],
              createdAt: now,
              updatedAt: now,
            })
            .run();
          getDb()
            .insert(factoryConversations)
            .values({
              id: factoryRunId,
              tenantId,
              domain: ontology.domainId,
              messagesJson: [],
              ctxJson: {
                domain: ontology.domainId,
                generationDirective: input.directive,
                specs: [checkpointSpec],
              },
              createdAt: now,
              updatedAt: now,
            })
            .run();
          releaseCheckpoint();
          return new Promise<never>((_resolve, reject) => {
            const stop = () => reject(input.signal.reason);
            if (input.signal.aborted) stop();
            else input.signal.addEventListener("abort", stop, { once: true });
          });
        }

        expect(input.resume).toBeUndefined();
        expect(input.reconnect).toEqual({
          mode: "reattach",
          factoryRunId,
          persistGoal: expect.any(String),
          capturedAgents: [
            expect.objectContaining({
              slug: checkpointSpec.slug,
              actionName: checkpointSpec.actionName,
              generatedCode,
            }),
          ],
        });
        return {
          outcome: "succeeded",
          receipt: {
            factoryRunId,
            status: "finished",
            completionKind: "delivery",
            agents: [
              {
                slug: checkpointSpec.slug,
                actionName: checkpointSpec.actionName,
                name: checkpointSpec.nameZh,
                spec: checkpointSpec,
                generatedCode,
              },
            ],
          },
        };
      },
    );
    const stopFactoryRun = vi.fn(() => true);
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({ runBuild }),
      stopFactoryRun,
      retryDelayMs: 0,
      maxAttempts: 3,
    });
    const workerStop = new AbortController();
    const firstAttempt = worker.runNext({ signal: workerStop.signal });
    await checkpointPersisted;
    workerStop.abort(
      new OntoCodeHarnessExecutionError(
        "worker_stopped",
        "OntoCode Harness Worker stopped while Factory was still generating",
        { recoverable: true, retryable: true },
      ),
    );
    await expect(firstAttempt).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "retry_scheduled",
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(runBuild).toHaveBeenCalledTimes(2);
    expect(stopFactoryRun).not.toHaveBeenCalled();

    const recoveryEvents = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payloadJson: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all();
    expect(
      recoveryEvents.filter(
        (event) => event.type === "harness.build.factory_started",
      ),
    ).toHaveLength(1);
    expect(
      recoveryEvents.filter(
        (event) => event.type === "harness.build.factory_reconnected",
      ),
    ).toHaveLength(1);
    expect(
      recoveryEvents.some((event) =>
        event.payloadJson.includes("factory_waiting_checkpoint_ambiguous"),
      ),
    ).toBe(false);
  });

  it("reattaches the same Factory checkpoint after a retryable transient build failure", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const factoryRunId = `ocf-ocx-${fixture.job.id.replace(/^ocj-/, "")}`;
    factoryRunIds.push(factoryRunId);
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const checkpointSpec = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      nameZh: "Candidate screening",
      tools: [],
      plan: [],
      generatedCode,
    };
    let invocation = 0;
    const runBuild = vi.fn(
      async (
        input: Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0],
      ) => {
        invocation += 1;
        if (invocation === 1) {
          expect(input.reconnect).toBeUndefined();
          const now = new Date();
          getDb()
            .insert(factoryRuns)
            .values({
              id: factoryRunId,
              tenantId,
              domain: ontology.domainId,
              ontologyDomainRegistrationId:
                fixture.project.ontologyDomainRegistrationId,
              runtimeProfileVersionId: fixture.project.runtimeProfileVersionId,
              goal: input.goal,
              status: "error",
              tokensUsed: 75,
              turns: 3,
              agentsCount: 1,
              reachedTerminal: true,
              errorMessage: "custom error: Request timed out.",
              transcriptJson: [],
              createdAt: now,
              updatedAt: now,
            })
            .run();
          getDb()
            .insert(factoryConversations)
            .values({
              id: factoryRunId,
              tenantId,
              domain: ontology.domainId,
              messagesJson: [],
              ctxJson: {
                domain: ontology.domainId,
                generationDirective: input.directive,
                specs: [checkpointSpec],
              },
              createdAt: now,
              updatedAt: now,
            })
            .run();
          throw new OntoCodeHarnessExecutionError(
            "factory_build_incomplete",
            "custom error: Request timed out.",
            { recoverable: true, retryable: true },
          );
        }

        expect(input.resume).toBeUndefined();
        expect(input.reconnect).toEqual({
          mode: "reattach",
          factoryRunId,
          persistGoal: expect.any(String),
          capturedAgents: [
            expect.objectContaining({
              slug: checkpointSpec.slug,
              actionName: checkpointSpec.actionName,
              generatedCode,
            }),
          ],
        });
        return {
          outcome: "succeeded",
          receipt: {
            factoryRunId,
            status: "finished",
            completionKind: "delivery",
            agents: [
              {
                slug: checkpointSpec.slug,
                actionName: checkpointSpec.actionName,
                name: checkpointSpec.nameZh,
                spec: checkpointSpec,
                generatedCode,
              },
            ],
          },
        };
      },
    );
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({ runBuild }),
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "retry_scheduled",
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(runBuild).toHaveBeenCalledTimes(2);

    const recoveryEvents = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payloadJson: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all();
    expect(
      recoveryEvents.filter(
        (event) => event.type === "harness.build.factory_started",
      ),
    ).toHaveLength(1);
    expect(
      recoveryEvents.filter(
        (event) => event.type === "harness.build.factory_reconnected",
      ),
    ).toHaveLength(1);
    expect(
      recoveryEvents.some(
        (event) =>
          event.type === "harness.job.retry_scheduled" &&
          event.payloadJson.includes('"code":"factory_build_incomplete"') &&
          event.payloadJson.includes('"retryable":true'),
      ),
    ).toBe(true);
    expect(
      recoveryEvents.some((event) =>
        event.payloadJson.includes("factory_waiting_checkpoint_ambiguous"),
      ),
    ).toBe(false);
  });

  it("persists offline-API function code as candidate_ready with explicit runtime and verification blockers", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const generatedCode =
      "export async function screenCandidate(input: unknown) { return input; }";
    const draftVersionId = "v-offline-api-draft-0001";
    const offlineSpec = {
      slug: "screen-candidate-agent",
      actionName: "screenCandidate",
      tools: ["vendor.lookup"],
      unresolvedTools: [],
      toolPolicies: {
        "vendor.lookup": {
          operation: "read",
          effectScope: "external",
          sandboxPolicy: "live_external",
        },
      },
      integrationBindings: [
        {
          requirement: {
            id: "screen-candidate:integration:1",
            actionName: "screenCandidate",
            system: "Vendor",
            kind: "external_api",
            role: "read",
            capability: "GET /api/candidates/:id",
            operations: ["lookup"],
            objectTypes: ["Candidate"],
            replayable: true,
          },
          bindingKind: "tool",
          bindingId: "vendor.lookup",
          toolName: "vendor.lookup",
          status: "needs_probe",
          reason: "external platform is temporarily offline",
        },
      ],
      generatedCode,
      executionReadiness: {
        schema: "agent-factory-execution-readiness/v1",
        authoringReady: true,
        sandboxReady: false,
        promotionReady: false,
        sandboxBlockers: ["vendor.lookup 缺少 sandbox probe"],
        promotionBlockers: [
          "vendor.lookup 缺少 sandbox probe",
          "vendor.lookup 缺少 live probe",
        ],
        missingSandboxProfiles: [],
        missingProductionProfiles: [],
        probeGaps: [
          {
            tool: "vendor.lookup",
            sandboxReasons: ["probe_not_verified"],
            promotionReasons: ["live_probe_required_for_promotion"],
          },
        ],
        externalApis: [
          {
            tool: "vendor.lookup",
            systems: ["Vendor"],
            bindingStatuses: ["needs_probe"],
            sandboxReady: false,
            promotionReady: false,
            sandboxReasons: ["probe_not_verified"],
            promotionReasons: ["live_probe_required_for_promotion"],
          },
        ],
      },
    } as unknown as GeneratedAgentSpec;
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async (input) => ({
          outcome: "waiting_user",
          message:
            "代码草稿已生成；Vendor API 尚未验证，等待 FDE 配置后再运行 sandbox。",
          receipt: {
            factoryRunId: input.engineRunId!,
            status: "drafted_unverified",
            completionKind: "incomplete",
            verificationState: "generated_unverified",
            agents: [
              {
                slug: "screen-candidate-agent",
                actionName: "screenCandidate",
                draftVersionId,
                generatedCode,
                spec: offlineSpec,
              },
            ],
            draftCheckpoint: {
              schema: "agent-factory-draft-checkpoint/v2",
              persisted: 1,
              scope: "full",
              coveredAgents: ["screenCandidate"],
              draftVersionId,
              specsFingerprint: specsFingerprint([offlineSpec]),
              executionReadiness: {
                state: "generated_unverified",
                sandboxEvidence: "not_run",
                sandboxPrerequisitesReady: false,
                promotionPrerequisitesReady: false,
                unverifiedApis: [
                  {
                    actionName: "screenCandidate",
                    tool: "vendor.lookup",
                    systems: ["Vendor"],
                    statuses: ["sandbox_unresolved", "promotion_unresolved"],
                    reasons: [
                      "probe_not_verified",
                      "live_probe_required_for_promotion",
                    ],
                  },
                ],
                blockers: ["screenCandidate：vendor.lookup 缺少 sandbox probe"],
              },
            },
          },
        })),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });

    const artifacts = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(eq(ontocodeArtifacts.sessionId, fixture.session.id))
      .all();
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "harness_receipt" }),
        expect.objectContaining({
          logicalName: "agents/screen-candidate-agent/agent.ts",
          kind: "agent_code",
          semanticPath: "/agents/screen-candidate-agent/generatedCode",
        }),
      ]),
    );
    expect(
      artifacts.filter((artifact) =>
        ["agent_spec", "agent_code"].includes(artifact.kind),
      ),
    ).toHaveLength(2);

    const codeArtifact = artifacts.find(
      (artifact) => artifact.kind === "agent_code",
    )!;
    const codeVersion = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(eq(ontocodeArtifactVersions.artifactId, codeArtifact.id))
      .get()!;
    const codeBlob = getDb()
      .select()
      .from(ontocodeArtifactBlobs)
      .where(eq(ontocodeArtifactBlobs.id, codeVersion.blobId))
      .get()!;
    expect(codeBlob.contentText).toBe(generatedCode);
    const packageVersion = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .get()!;
    expect(packageVersion.status).toBe("candidate_ready");
    expect(JSON.parse(packageVersion.validationJson)).toMatchObject({
      schema: "ontocode-candidate-validation/v2",
      runtimeReady: false,
      verificationPrerequisitesReady: false,
      runtimeBlockers: [
        expect.objectContaining({
          code: "external_api_runtime_not_ready",
          toolName: "vendor.lookup",
        }),
      ],
      verificationBlockers: [
        expect.objectContaining({
          code: "integration_probe_missing",
          toolName: "vendor.lookup",
        }),
      ],
    });
    expect(
      getDb()
        .select()
        .from(ontocodeCandidateHeads)
        .where(eq(ontocodeCandidateHeads.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
          ),
        )
        .all(),
    ).toHaveLength(0);
  });

  it("creates candidate_ready from a complete zero-blocker generated-unverified checkpoint", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async (input) =>
          generatedUnverifiedBuildResult("full", input.engineRunId!),
        ),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });

    const packageVersion = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .get();
    const head = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.sessionId, fixture.session.id))
      .get();
    expect(packageVersion).toMatchObject({ status: "candidate_ready" });
    expect(JSON.parse(packageVersion!.validationJson)).toMatchObject({
      schema: "ontocode-candidate-validation/v2",
      runtimeReady: true,
      verificationPrerequisitesReady: true,
      runtimeBlockers: [],
      verificationBlockers: [],
      sandboxEvidenceIncluded: false,
      releaseEligible: false,
    });
    expect(head).toMatchObject({
      packageVersionId: packageVersion?.id,
      revision: 1,
    });
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      status: "succeeded",
      candidatePackageVersionId: packageVersion?.id,
      candidateDependencyRoot: packageVersion?.dependencyRoot,
      candidateHeadId: head?.id,
      candidateHeadRevision: head?.revision,
    });
    expect(
      getDb()
        .select()
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
          ),
        )
        .all(),
    ).toHaveLength(0);
  });

  it("keeps a partial generated-unverified checkpoint non-candidate", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async (input) =>
          generatedUnverifiedBuildResult("partial", input.engineRunId!),
        ),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "waiting_user",
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
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      candidatePackageVersionId: null,
      candidateDependencyRoot: null,
      candidateHeadId: null,
      candidateHeadRevision: null,
    });
    const draftArtifacts = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(eq(ontocodeArtifacts.sessionId, fixture.session.id))
      .all()
      .filter((artifact) => artifact.kind === "agent_code_draft");
    expect(draftArtifacts).toHaveLength(1);
    const draftVersion = getDb()
      .select()
      .from(ontocodeArtifactVersions)
      .where(eq(ontocodeArtifactVersions.artifactId, draftArtifacts[0]!.id))
      .get();
    expect(JSON.parse(draftVersion!.metadataJson)).toMatchObject({
      verificationState: "generated_unverified",
      candidateEligible: false,
    });
  });

  it("bridges explicit harness decisions without persisting assistant deltas or PII (#HARNESS-TELEMETRY)", async () => {
    // The gap this closes: the Factory brain streams strategy summaries, tool
    // calls with their stated reason, and tool results — and this bridge used
    // to forward only stage markers plus the rare readiness-bearing result. A
    // Session therefore recorded a handful of coarse phase events, and the
    // workbench's reasoning panel had nothing to show while the brain was in
    // fact selecting a strategy and calling tools.
    const fixture = makeQueuedJob({ kind: "build" });
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          // `think` is a legacy name for normal assistant output deltas. It
          // must not be persisted or represented as hidden chain-of-thought.
          callback({
            t: "think",
            delta: "联系 qa.engineer@example.test 后先读本体。",
          });
          callback({
            t: "strategy",
            mode: "react",
            steps: ["读取 Ontology", "核对工具契约", "生成并验证"],
            chosenBy: "policy",
            rationale: "外部 API 未验证，因此先做可离线完成的代码生成。",
          });
          callback({
            t: "tool.call",
            id: "c1",
            name: "read_ontology",
            reasoning: "需要真实动作清单才能定范围",
            input: {
              domain: "Agents-generation",
              api_key: "literal-production-secret",
              candidateEmail: "qa.engineer@example.test",
            },
          });
          callback({
            t: "tool.result",
            id: "c1",
            name: "read_ontology",
            ok: true,
            summary: "16 actions, 24 events",
          });
          callback({
            t: "message",
            text: "范围已确认；联系人 qa.engineer@example.test，开始设计。",
          });
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
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn((input) => runFactoryBuild(input, runtime)),
      }),
    });
    await worker.runNext();

    const emitted = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payloadJson: ontocodeSessionEvents.payloadJson,
        visibility: ontocodeSessionEvents.visibility,
      })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, tenantId),
          eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
        ),
      )
      .all();
    const byType = new Map(emitted.map((row) => [row.type, row]));

    expect(byType.has("harness.build.thinking")).toBe(false);
    expect(
      JSON.parse(byType.get("harness.build.strategy")!.payloadJson),
    ).toMatchObject({
      mode: "react",
      steps: ["读取 Ontology", "核对工具契约", "生成并验证"],
    });

    // The tool call carries the brain's own stated reason. That sentence is
    // the single most useful line in the trace.
    const call = byType.get("harness.build.tool_call");
    expect(call).toBeTruthy();
    const callPayload = JSON.parse(call!.payloadJson);
    expect(callPayload).toMatchObject({
      tool: "read_ontology",
      reasoning: "需要真实动作清单才能定范围",
    });
    expect(callPayload.input).toContain("[REDACTED]");
    expect(callPayload.input).toContain("[REDACTED_EMAIL]");
    expect(callPayload.input).not.toContain("literal-production-secret");
    expect(callPayload.input).not.toContain("qa.engineer@example.test");

    // Every result is recorded, not only readiness-bearing ones.
    expect(
      JSON.parse(byType.get("harness.build.tool_result")!.payloadJson),
    ).toMatchObject({ tool: "read_ontology", ok: true });

    // Intermediate narration used to be captured only as the final message.
    expect(
      JSON.parse(byType.get("harness.build.narration")!.payloadJson).text,
    ).toBe("范围已确认；联系人 [REDACTED_EMAIL]，开始设计。");

    // High-volume frames land as `debug` so the default「只看关键」log stays
    // readable; the reasoning panel and「显示全部」read them via the floor.
    expect(call!.visibility).toBe("debug");
  });

  it("bridges the brain's acceptance checklist to the durable session stream", async () => {
    /**
     * Audit C5: the event bridge recognized 21 frame kinds but dropped
     * `acceptance` — the harness-owned checklist the brain cannot edit was
     * emitted on every finish attempt and destroyed at this boundary, leaving
     * the FDE unable to see WHICH acceptance criterion held a build back.
     */
    const fixture = makeQueuedJob({ kind: "build" });
    const runtime = {
      startRun: vi.fn(() => ({})),
      subscribeRun: vi.fn(
        (
          _runId: string,
          callback: (event: Record<string, unknown>) => void,
        ) => {
          callback({
            t: "acceptance",
            allPass: false,
            criteria: [
              {
                key: "code_really_ran",
                label: "代码真实执行",
                pass: false,
                detail: "沙箱执行证据缺失",
              },
            ],
            perAgent: [
              {
                slug: "screen-candidate-agent",
                short: "screen",
                pass: false,
                items: [
                  {
                    key: "spec_complete",
                    label: "规格完整",
                    pass: true,
                    detail: "ok",
                  },
                ],
              },
            ],
          });
          callback({
            t: "done",
            status: "incomplete",
            completionKind: "answer",
            reachedTerminal: false,
            tokensUsed: 10,
            turns: 1,
          });
          return vi.fn();
        },
      ),
      abortRun: vi.fn(() => true),
    } as unknown as OntoCodeFactoryRunRuntime;
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn((input) => runFactoryBuild(input, runtime)),
      }),
    });
    await worker.runNext();

    const row = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.build.acceptance"),
        ),
      )
      .get();
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.payloadJson)).toMatchObject({
      allPass: false,
      // `criterionKey`, not `key`: a bare `key` property is credential-named
      // at the redaction boundary and would be blanked.
      criteria: [
        expect.objectContaining({
          criterionKey: "code_really_ran",
          pass: false,
        }),
      ],
      criteriaTotal: 1,
      perAgent: [
        expect.objectContaining({
          slug: "screen-candidate-agent",
          pass: false,
          items: [
            expect.objectContaining({
              criterionKey: "spec_complete",
              pass: true,
            }),
          ],
        }),
      ],
      perAgentTotal: 1,
    });
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
    // Blueprint requires a reachable gateway now (no gateway ⇒ honest failure).
    setFactoryModelAdapter(async () => ({
      text: "按触发事件读取目标对象，再发出下游事件。",
      provider: "test-adapter",
      model: "test-model",
      tokensIn: 5,
      tokensOut: 10,
    }));
    try {
      await expect(blueprintWorker.runNext()).resolves.toMatchObject({
        jobId: blueprintFixture.job.id,
        status: "succeeded",
      });
    } finally {
      setFactoryModelAdapter(null);
    }

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
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id)).toMatchObject({
      candidatePackageVersionId: candidatePackage?.id,
      candidateDependencyRoot: candidatePackage?.dependencyRoot,
      candidateHeadId: candidateHead?.id,
      candidateHeadRevision: candidateHead?.revision,
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
      candidateHeadId: candidateHead?.id,
      candidateHeadRevision: candidateHead?.revision,
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

  // A Candidate Package is immutable authoring output. Runtime/probe gaps are
  // persisted on it, while an unknown capability or undefined authority still
  // cannot acquire a Candidate Head.
  const completeIntegrationRequirement = {
    id: "req-1",
    actionName: "screenCandidate",
    system: "Internal_Recruitment_System",
    kind: "external_api",
    role: "write",
    capability: "POST /api/write",
    operations: ["write"],
    objectTypes: ["Candidate"],
    replayable: false,
  };

  function buildReceiptWithBinding(
    binding: Record<string, unknown>,
    tools: string[] = [],
    specOverrides: Record<string, unknown> = {},
  ) {
    return vi.fn(
      async (
        input: Parameters<OntoCodeFactoryHarnessAdapter["runBuild"]>[0],
      ) => ({
        outcome: "succeeded" as const,
        receipt: {
          factoryRunId: input.engineRunId ?? "fake-integration-binding",
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
                unresolvedTools: [],
                toolPolicies: Object.fromEntries(
                  tools.map((tool) => [
                    tool,
                    tool === "recruitment.write"
                      ? {
                          operation: "write",
                          effectScope: "external",
                          sandboxPolicy: "requires_attempt_grant",
                        }
                      : {
                          operation: "read",
                          effectScope: "external",
                          sandboxPolicy: "live_external",
                        },
                  ]),
                ),
                generatedCode:
                  "export const screenCandidateAgent = { async handler(input) { return input; } };",
                ...specOverrides,
                integrationBindings: [binding],
              },
            },
          ],
        },
      }),
    );
  }

  async function expectCandidateRefused(
    binding: Record<string, unknown>,
    tools: string[] = [],
  ) {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: buildReceiptWithBinding(binding, tools),
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
    return fixture;
  }

  it.each([["missing", "根本没有工具"]])(
    "refuses to write a Candidate Package when an integration is %s",
    async (status, reason) => {
      await expectCandidateRefused({
        requirement: completeIntegrationRequirement,
        status,
        reason,
      });
    },
  );

  it("requires a durable pause/resume gate before a human boundary can enter a Candidate", async () => {
    await expectCandidateRefused({
      requirement: completeIntegrationRequirement,
      status: "human_boundary",
      reason: "人工来做",
    });
  });

  it("persists a human-owned boundary as an explicit Candidate blocker when the Agent has a durable HITL gate", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: buildReceiptWithBinding(
          {
            requirement: completeIntegrationRequirement,
            status: "human_boundary",
            reason: "经 FDE 确认为人工边界",
          },
          [],
          { hitl: true },
        ),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      status: "succeeded",
    });
    const packageVersion = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .get();
    expect(packageVersion).toMatchObject({ status: "candidate_ready" });
    expect(JSON.parse(packageVersion!.validationJson)).toMatchObject({
      runtimeReady: false,
      verificationPrerequisitesReady: false,
      runtimeBlockers: [
        expect.objectContaining({
          code: "human_boundary_pending",
          system: "Internal_Recruitment_System",
        }),
      ],
      verificationBlockers: [
        expect.objectContaining({ code: "human_boundary_pending" }),
      ],
    });
  });

  it.each([
    [
      "needs_config",
      "凭证还没配",
      "integration_profile_missing",
      "runtimeBlockers",
    ],
    [
      "needs_probe",
      "外部平台暂时不可用，尚未探通",
      "integration_probe_missing",
      "verificationBlockers",
    ],
  ] as const)(
    "persists candidate_ready with structured blockers when an exact tool is %s",
    async (status, reason, blockerCode, blockerField) => {
      const fixture = makeQueuedJob({ kind: "build" });
      const worker = new OntoCodeHarnessWorkerAdapter({
        tenantId,
        factory: fakeFactory({
          runBuild: buildReceiptWithBinding(
            {
              requirement: completeIntegrationRequirement,
              status,
              bindingKind: "tool",
              bindingId: "recruitment.write",
              toolName: "recruitment.write",
              ...(status === "needs_config"
                ? { missingConfigKeys: ["api_key_env"] }
                : {}),
              reason,
            },
            ["recruitment.write"],
          ),
        }),
      });

      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
      const packageVersion = getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
        .get();
      expect(packageVersion).toMatchObject({ status: "candidate_ready" });
      const validation = JSON.parse(packageVersion!.validationJson) as Record<
        string,
        unknown
      >;
      expect(validation).toMatchObject({
        schema: "ontocode-candidate-validation/v2",
        packageIntegrityPassed: true,
        sandboxEvidenceIncluded: false,
        [blockerField]: [
          expect.objectContaining({
            code: blockerCode,
            toolName: "recruitment.write",
            system: "Internal_Recruitment_System",
          }),
        ],
      });
    },
  );

  it("keeps a missing write-probe lifecycle as an explicit Candidate blocker instead of discarding generated code", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: buildReceiptWithBinding(
          {
            requirement: completeIntegrationRequirement,
            status: "needs_probe",
            bindingKind: "tool",
            bindingId: "recruitment.write",
            toolName: "recruitment.write",
            missingSafety: [
              "test_data_contract",
              "idempotency_key",
              "canary_namespace",
              "canary_target",
              "cleanup",
              "absence_readback",
            ],
            reason: "写入工具尚无可回收 canary 探针生命周期",
          },
          ["recruitment.write"],
        ),
      }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      status: "succeeded",
    });
    const packageVersion = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .get();
    expect(packageVersion).toMatchObject({ status: "candidate_ready" });
    expect(JSON.parse(packageVersion!.validationJson)).toMatchObject({
      runtimeBlockers: expect.arrayContaining([
        expect.objectContaining({
          code: "write_probe_contract_missing",
          missing: expect.arrayContaining(["cleanup", "absence_readback"]),
        }),
      ]),
      verificationBlockers: expect.arrayContaining([
        expect.objectContaining({ code: "write_probe_contract_missing" }),
      ]),
    });
  });

  it("fails closed when a selected tool is absent from the real registry", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: buildReceiptWithBinding(
          {
            requirement: completeIntegrationRequirement,
            status: "needs_probe",
            bindingKind: "tool",
            bindingId: "unknown.vendorTool",
            toolName: "unknown.vendorTool",
            reason: "probe pending",
          },
          ["unknown.vendorTool"],
        ),
      }),
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      status: "failed_recoverable",
    });
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(0);
  });

  it("snapshots a persisted declarative tool with a real contract status instead of unknown", async () => {
    /**
     * Audit C4: the default adapter's listExecutionResources read only the
     * registry tiers (global + tenant-native) — `ports.tools` (the persisted
     * declarative tier) was never read, despite the comment claiming parity
     * with Build. An FDE-authored tool therefore bound in Build but packaging
     * snapshotted it status:"unknown" → hardBlocker candidate_tool_unknown →
     * the candidate could never get a Head.
     */
    const declarativeName = `ocw.declarative.${randomUUID().slice(0, 8)}`;
    const store = new DrizzleToolStore(tenantId, ontology.domainId, "__system");
    await store.save({
      name: declarativeName,
      description: "FDE-authored declarative HTTP lookup",
      method: "GET",
      urlTemplate: "https://api.example.test/v1/lookup/{id}",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      domain: ontology.domainId,
      paramsSchema: { id: { type: "string", required: true } },
      returnsSchema: { result: { type: "object" } },
    } as never);
    try {
      const adapter = createDefaultOntoCodeFactoryAdapter();
      const resources = await adapter.listExecutionResources!({
        tenantId,
        tenantSlug: "__system",
        domain: ontology.domainId,
        ontologyDomainRegistrationId: null,
      });
      const declarative = resources.tools.find(
        (tool) => tool.name === declarativeName,
      );
      expect(declarative).toBeTruthy();
      expect(declarative!.declarativeDefinition).toMatchObject({
        name: declarativeName,
      });
      // The registry tiers are still present alongside the declarative overlay.
      expect(
        resources.tools.some((tool) => tool.name !== declarativeName),
      ).toBe(true);

      const fixture = makeQueuedJob({ kind: "build" });
      const factory = fakeFactory({
        listExecutionResources: (input) =>
          adapter.listExecutionResources!(input),
        runBuild: vi.fn(async (input) => ({
          outcome: "succeeded" as const,
          receipt: {
            factoryRunId: input.engineRunId!,
            status: "finished",
            completionKind: "delivery",
            agents: [
              {
                slug: "screen-candidate-agent",
                actionName: "screenCandidate",
                spec: {
                  slug: "screen-candidate-agent",
                  actionName: "screenCandidate",
                  tools: [declarativeName],
                  unresolvedTools: [],
                  toolPolicies: {
                    [declarativeName]: {
                      operation: "read",
                      effectScope: "external",
                      sandboxPolicy: "live_external",
                    },
                  },
                  generatedCode:
                    "export const screenCandidateAgent = { async handler(input) { return input; } };",
                },
              },
            ],
          },
        })),
      });
      const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });
      await expect(worker.runNext()).resolves.toMatchObject({
        jobId: fixture.job.id,
        status: "succeeded",
      });
      const completed = getDb()
        .select({ payloadJson: ontocodeSessionEvents.payloadJson })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
            eq(ontocodeSessionEvents.type, "harness.build.completed"),
          ),
        )
        .get();
      const contracts = JSON.parse(completed!.payloadJson).receipt
        .candidateToolContracts as Array<Record<string, unknown>>;
      expect(contracts).toEqual([
        expect.objectContaining({
          toolName: declarativeName,
          resolvedName: declarativeName,
          status: "resolved",
        }),
      ]);
    } finally {
      getDb()
        .delete(factoryTools)
        .where(eq(factoryTools.name, declarativeName))
        .run();
    }
  });

  it("excludes sub-agents from the exact Action coverage set while still packaging them", async () => {
    /**
     * Audit C5: every `agent.created` lands in the candidate agent set, and
     * candidateAgentsCoverExactScope demanded exact equality with the requested
     * Action ids — so a brain that decomposed via design_subagent structurally
     * killed its own candidate (`candidate_scope_incomplete`). Sub-agents are
     * implementation details of a parent that covers the Action: they are
     * packaged, but never counted against the exact scope.
     */
    const fixture = makeQueuedJob({ kind: "build" });
    const code =
      "export const screenCandidateAgent = { async handler(input) { return input; } };";
    const factory = fakeFactory({
      runBuild: vi.fn(async (input) => ({
        outcome: "succeeded" as const,
        receipt: {
          factoryRunId: input.engineRunId!,
          status: "finished",
          completionKind: "delivery",
          agents: [
            {
              slug: "screen-candidate-agent",
              actionName: "screenCandidate",
              spec: {
                slug: "screen-candidate-agent",
                actionName: "screenCandidate",
                tools: [],
                unresolvedTools: [],
                toolPolicies: {},
                generatedCode: code,
              },
            },
            {
              slug: "screen-candidate-agent-sub-parse",
              actionName: "screenCandidate·子[解析简历]",
              spec: {
                slug: "screen-candidate-agent-sub-parse",
                actionName: "screenCandidate·子[解析简历]",
                isSubAgent: true,
                parentAction: "screenCandidate",
                tools: [],
                unresolvedTools: [],
                toolPolicies: {},
                generatedCode: code,
              },
            },
          ],
        },
      })),
    });
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    // The whole decomposition is packaged — the sub-agent is not dropped.
    const versions = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .all();
    expect(versions).toHaveLength(1);
    const logicalNames = (
      JSON.parse(versions[0]!.artifactRefsJson) as Array<{
        logicalName: string;
      }>
    ).map((ref) => ref.logicalName);
    expect(logicalNames).toEqual(
      expect.arrayContaining([
        "agents/screen-candidate-agent/spec.json",
        "agents/screen-candidate-agent-sub-parse/spec.json",
      ]),
    );
  });

  it("fails closed when an external binding has no operation or capability contract", async () => {
    await expectCandidateRefused(
      {
        requirement: {
          ...completeIntegrationRequirement,
          capability: undefined,
          operations: [],
        },
        status: "needs_probe",
        bindingKind: "tool",
        bindingId: "recruitment.write",
        toolName: "recruitment.write",
        reason: "probe pending",
      },
      ["recruitment.write"],
    );
  });

  it("fails closed when a selected external tool has no reviewed execution policy", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const runBuild = buildReceiptWithBinding(
      {
        requirement: completeIntegrationRequirement,
        status: "needs_probe",
        bindingKind: "tool",
        bindingId: "recruitment.write",
        toolName: "recruitment.write",
        reason: "probe pending",
      },
      ["recruitment.write"],
    );
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({
        runBuild: vi.fn(async (...args) => {
          const result = await runBuild(...args);
          const agent = (
            result.receipt.agents as Array<{
              spec: Record<string, unknown>;
            }>
          )[0]!;
          delete agent.spec.toolPolicies;
          return result;
        }),
      }),
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      status: "failed_recoverable",
    });
    expect(
      getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
        .all(),
    ).toHaveLength(0);
  });

  it("refuses a binding that claims resolved but carries no tool the Agent holds", async () => {
    await expectCandidateRefused({
      requirement: completeIntegrationRequirement,
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
              ...completeIntegrationRequirement,
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
        requirementKind: "external_api",
        role: "write",
        capability: "POST /api/write",
        operations: ["write"],
        objectTypes: ["Candidate"],
        status: "resolved",
        bindingKind: "tool",
        toolName: "recruitment.write",
        selectionRequired: false,
        missingCredentialEnv: [],
        missingConfigKeys: [],
        invalidConfigKeys: [],
        missingSafety: [],
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
        runBuild: vi.fn(async (input) => ({
          outcome: "succeeded" as const,
          receipt: {
            factoryRunId: input.engineRunId!,
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
        runBuild: vi.fn(async (input) => ({
          outcome: "succeeded",
          receipt: {
            factoryRunId: input.engineRunId!,
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

  it("parks exact Candidate verification before creating a SandboxAttempt when profile/probe blockers remain", async () => {
    const fixture = makeQueuedJob({ kind: "build" });
    const buildFactory = fakeFactory({
      runBuild: buildReceiptWithBinding(
        {
          requirement: completeIntegrationRequirement,
          status: "needs_probe",
          bindingKind: "tool",
          bindingId: "recruitment.write",
          toolName: "recruitment.write",
          reason: "current profile has no verified probe",
        },
        ["recruitment.write"],
      ),
    });
    const buildWorker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: buildFactory,
    });
    await expect(buildWorker.runNext()).resolves.toMatchObject({
      status: "succeeded",
    });
    const packageVersion = getDb()
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.sessionId, fixture.session.id))
      .get()!;
    const head = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.sessionId, fixture.session.id))
      .get()!;
    const built = { fixture, buildFactory, packageVersion, head };
    const { job } = queueExactCandidateTest(built, {
      testCases: [
        {
          id: "blocked-before-sandbox",
          entryEvent: "CANDIDATE_RECEIVED",
          payload: { subject: "candidate-001" },
          kind: "pass",
          expectedEvent: "CANDIDATE_SCREENED",
        },
      ],
    });
    const runCandidateTest = vi.fn(async () =>
      successfulDevelopmentSandbox(packageVersion.dependencyRoot),
    );
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({ runCandidateTest }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "waiting_user",
    });
    expect(runCandidateTest).not.toHaveBeenCalled();
    expect(
      getDb()
        .select()
        .from(ontocodeSandboxAttempts)
        .where(eq(ontocodeSandboxAttempts.harnessJobId, job.id))
        .all(),
    ).toHaveLength(0);
    const blockedMessage = listOntoCodeMessages(
      { tenantId },
      fixture.session.id,
      {
        limit: 20,
        offset: 0,
      },
    ).items.find(
      (message) =>
        (message.content.receipt as { schema?: string } | undefined)?.schema ===
        "ontocode-candidate-verification-blocked/v1",
    );
    expect(blockedMessage).toMatchObject({
      content: expect.objectContaining({
        receipt: expect.objectContaining({
          schema: "ontocode-candidate-verification-blocked/v1",
          verificationBlockers: [
            expect.objectContaining({ code: "integration_probe_missing" }),
          ],
        }),
      }),
    });
  });

  it("authors Candidate test blueprints without executing Sandbox", async () => {
    const built = await buildExactCandidate();
    const testCases: OntoCodeCandidateTestCase[] = [
      {
        id: "candidate-authoring-happy",
        entryEvent: "CANDIDATE_RECEIVED",
        payload: { subject: "candidate-001" },
        kind: "pass",
        expectedEvent: "CANDIDATE_SCREENED",
      },
    ];
    const { job } = queueExactCandidateTest(built, {
      commandType: "generate_tests",
      testCases,
    });
    const runCandidateTest = vi.fn(async () =>
      successfulDevelopmentSandbox(built.packageVersion.dependencyRoot),
    );
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory({ runCandidateTest }),
    });

    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "succeeded",
    });
    expect(runCandidateTest).not.toHaveBeenCalled();
    expect(
      getDb()
        .select()
        .from(ontocodeSandboxAttempts)
        .where(eq(ontocodeSandboxAttempts.harnessJobId, job.id))
        .all(),
    ).toHaveLength(0);
    const receiptMessage = listOntoCodeMessages(
      { tenantId },
      built.fixture.session.id,
      { limit: 30, offset: 0 },
    ).items.find(
      (message) =>
        (message.content.receipt as { schema?: string } | undefined)?.schema ===
        "ontocode-candidate-test-authoring-receipt/v1",
    );
    expect(receiptMessage).toMatchObject({
      content: expect.objectContaining({
        receipt: expect.objectContaining({
          operation: "generate_tests",
          candidatePackageVersionId: built.packageVersion.id,
          candidateDependencyRoot: built.packageVersion.dependencyRoot,
          sandboxExecuted: false,
          readyForRun: true,
          executableTestCaseCount: 1,
          blueprints: [
            expect.objectContaining({
              agentSlug: "screen-candidate-agent",
              actionName: "screenCandidate",
              entryEvent: "CANDIDATE_RECEIVED",
              expectedEvents: ["CANDIDATE_SCREENED"],
              requiredPayloadFields: [
                expect.objectContaining({ name: "candidate" }),
              ],
            }),
          ],
        }),
      }),
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
      .where(eq(ontocodeArtifactVersions.sessionId, built.fixture.session.id))
      .all()
      .filter((version) => agentArtifactIds.has(version.artifactId)).length;
    const headBefore = getDb()
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, built.head.id))
      .get();

    const runCandidateTest = vi.fn(
      async (
        input: Parameters<
          NonNullable<OntoCodeFactoryHarnessAdapter["runCandidateTest"]>
        >[0],
      ) => {
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
          [
            "agent_spec",
            "agent_code",
            "agent_manifest",
            "agent_config",
          ].includes(artifact.kind),
        ),
    ).toHaveLength(agentArtifactsBefore.length);
    expect(
      getDb()
        .select()
        .from(ontocodeArtifactVersions)
        .where(eq(ontocodeArtifactVersions.sessionId, built.fixture.session.id))
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

  it("scrubs a failure's structured cause everywhere it is written, not just in the receipt", async () => {
    /**
     * Found by adversarially reviewing this session's own change.
     *
     * `FactoryScopeRecommendationError.cause` was added so a refusal keeps its
     * reason. But for a `no_json` / `invalid_json` failure that reason is a
     * VERBATIM excerpt of the model's answer, and the model answers about the
     * FDE's own scenario text. `finalizeFailure` writes the same failure object
     * to three sinks in one transaction: the receipt (scrubbed at :4257), the
     * durable `harness.job.failed` event, and the assistant chat message —
     * and only the first crossed the redaction boundary.
     *
     * So the artifact would read [REDACTED] while the chat transcript beside it
     * carried the raw text. All three must be byte-identical and scrubbed.
     */
    const fixture = makeQueuedJob({ kind: "scope" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: {
        scope: async () => {
          throw new FactoryScopeRecommendationError(
            "scope_recommendation_unavailable",
            "模型没有返回可验证的结构化结果。",
            false,
            "模型未返回可解析 JSON：建议先做候选人筛选，细节找 fde@acme.com 确认。",
          );
        },
      },
    });

    await worker.runNext();

    const failedEvent = getDb()
      .select({ payload: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.job.failed"),
        ),
      )
      .get();
    expect(failedEvent).toBeTruthy();
    expect(failedEvent!.payload).not.toContain("fde@acme.com");
    // The diagnostic itself must survive — scrubbing must not eat the reason.
    expect(failedEvent!.payload).toContain("模型未返回可解析 JSON");

    const messages = listOntoCodeMessages({ tenantId }, fixture.session.id, 50);
    expect(JSON.stringify(messages)).not.toContain("fde@acme.com");
  });

  it("does not let generation inherit a scope the model said it could not resolve", async () => {
    /**
     * `unresolved[]` is the ONLY channel by which the scope model can say "I was
     * asked about something I could not place in this Ontology". It was
     * validated, capped, counted into a frame and written into audit meta — and
     * then `resolveGenerationScope` read only actionIds/scenario/mode, so Build
     * proceeded as though the scope were clean.
     *
     * This is the same shape as two defects already fixed in this codebase:
     * `mandatory[]` computed with no consumer, and `next_action:"block"`
     * persisted but never enforced. A declared gap that nothing reads is not a
     * safeguard — it is a receipt that says we knew.
     */
    // No explicit actionIds on the command — this is the real "Blueprint follows
    // the Scope job" path, which is the one that reads the receipt.
    const fixture = makeQueuedJob({ kind: "blueprint", commandArguments: {} });
    // A scope receipt already on this Session, exactly as a real scope job
    // would have written it — with the model's declared gap intact.
    getDb()
      .insert(ontocodeSessionEvents)
      .values({
        id: `oce-${randomUUID().slice(0, 12)}`,
        tenantId,
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        seq: Date.now(),
        type: "harness.scope.completed",
        visibility: "user",
        payloadJson: JSON.stringify({
          receipt: {
            schema: "ontocode-scope-receipt/v1",
            ontologyHash: factorySourceOntologyHash(ontology),
            recommendation: {
              actionIds: ["screen-candidate"],
              scenario: "Screen candidates",
              mode: "action_selection",
              unresolved: ["合规复核环节在本体里找不到对应 Action"],
            },
          },
        }),
        createdAt: new Date(),
      } as never)
      .run();

    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: createDefaultOntoCodeHarnessExecutors(fakeFactory()),
    });

    await worker.runNext();

    const job = getOntoCodeHarnessJob({ tenantId }, fixture.job.id);
    expect(job.status).not.toBe("succeeded");
    expect(String(job.errorMessage ?? "")).toContain("合规复核");
  });

  /** Seed a completed-receipt session event exactly as a real job would write it. */
  function seedReceiptEvent(
    fixture: { project: { id: string }; session: { id: string } },
    type: string,
    receipt: Record<string, unknown>,
    seq: number,
  ): void {
    getDb()
      .insert(ontocodeSessionEvents)
      .values({
        id: `oce-${randomUUID().slice(0, 12)}`,
        tenantId,
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        seq,
        type,
        visibility: "user",
        payloadJson: JSON.stringify({ receipt }),
        createdAt: new Date(),
      } as never)
      .run();
  }

  it("gates a Build resolved from a blueprint receipt on the scope's declared gaps", async () => {
    /**
     * Adversarially-confirmed: the `unresolved[]` gate sat only on the LAST
     * branch of resolveGenerationScope. A blueprint or build receipt
     * short-circuits ahead of it, so a scope whose model declared gaps still
     * fed generation whenever a later-stage receipt existed. Every branch that
     * ultimately rests on the scope model's recommendation must gate.
     */
    const fixture = makeQueuedJob({ kind: "build", commandArguments: {} });
    seedReceiptEvent(
      fixture,
      "harness.scope.completed",
      {
        schema: "ontocode-scope-receipt/v1",
        ontologyHash: factorySourceOntologyHash(ontology),
        recommendation: {
          actionIds: ["screen-candidate"],
          scenario: "Screen candidates",
          mode: "action_selection",
          unresolved: ["合规复核环节在本体里找不到对应 Action"],
        },
      },
      Date.now(),
    );
    seedReceiptEvent(
      fixture,
      "harness.blueprint.completed",
      {
        schema: "ontocode-blueprint-receipt/v1",
        ontologyHash: factorySourceOntologyHash(ontology),
        scope: {
          actionIds: ["screen-candidate"],
          actionNames: ["screenCandidate"],
          scenario: "Screen candidates",
          forceVirtual: false,
          source: "scope",
        },
      },
      Date.now() + 1,
    );

    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    expect(
      String(
        getOntoCodeHarnessJob({ tenantId }, fixture.job.id).errorMessage ?? "",
      ),
    ).toContain("合规复核");
    // The gate fired before any generation was attempted.
    expect(factory.runBuild).not.toHaveBeenCalled();
  });

  it("gates a Build resumed from a build receipt that rests on the gappy scope", async () => {
    const fixture = makeQueuedJob({ kind: "build", commandArguments: {} });
    seedReceiptEvent(
      fixture,
      "harness.scope.completed",
      {
        schema: "ontocode-scope-receipt/v1",
        ontologyHash: factorySourceOntologyHash(ontology),
        recommendation: {
          actionIds: ["screen-candidate"],
          scenario: "Screen candidates",
          mode: "action_selection",
          unresolved: ["合规复核环节在本体里找不到对应 Action"],
        },
      },
      Date.now(),
    );
    seedReceiptEvent(
      fixture,
      "harness.build.completed",
      {
        schema: "ontocode-build-receipt/v1",
        ontologyHash: factorySourceOntologyHash(ontology),
        scope: {
          actionIds: ["screen-candidate"],
          actionNames: ["screenCandidate"],
          deferredActions: [],
          scenario: "Screen candidates",
          forceVirtual: false,
          source: "scope",
        },
      },
      Date.now() + 1,
    );

    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "failed_recoverable",
    });
    expect(
      String(
        getOntoCodeHarnessJob({ tenantId }, fixture.job.id).errorMessage ?? "",
      ),
    ).toContain("合规复核");
    expect(factory.runBuild).not.toHaveBeenCalled();
  });

  it("keeps an FDE-explicit blueprint chain buildable when a scope receipt declared gaps", async () => {
    // The FDE's explicit selection IS the adjudication: a blueprint whose scope
    // came from command arguments does not rest on the scope model, so a gappy
    // scope receipt must not falsely block it.
    const fixture = makeQueuedJob({ kind: "build", commandArguments: {} });
    seedReceiptEvent(
      fixture,
      "harness.scope.completed",
      {
        schema: "ontocode-scope-receipt/v1",
        ontologyHash: factorySourceOntologyHash(ontology),
        recommendation: {
          actionIds: ["screen-candidate"],
          scenario: "Screen candidates",
          mode: "action_selection",
          unresolved: ["合规复核环节在本体里找不到对应 Action"],
        },
      },
      Date.now(),
    );
    seedReceiptEvent(
      fixture,
      "harness.blueprint.completed",
      {
        schema: "ontocode-blueprint-receipt/v1",
        ontologyHash: factorySourceOntologyHash(ontology),
        scope: {
          actionIds: ["screen-candidate"],
          actionNames: ["screenCandidate"],
          scenario: "Screen candidates",
          forceVirtual: false,
          source: "command",
        },
      },
      Date.now() + 1,
    );

    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({ tenantId, factory });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: fixture.job.id,
      status: "succeeded",
    });
    expect(factory.runBuild).toHaveBeenCalledTimes(1);
  });

  it("shows the reasoning and the check behind a scope decision", async () => {
    /**
     * The FDE's complaint: "I never see the brain reason, call tools or review."
     * For a Build job that is untrue — 304 tool_call / 304 tool_result frames are
     * bridged. But the FIRST kinds anyone runs (scope, ontology_analysis) emitted
     * only stage markers, so the workspace looked inert exactly when trust is
     * being formed.
     *
     * Nothing here is invented: the model already returns a reasoning summary,
     * a per-Action reason and a confidence, and the server already revalidates
     * every returned id against the authoritative catalog. Those facts simply
     * never reached the reasoning stream.
     */
    const fixture = makeQueuedJob({ kind: "scope" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: createDefaultOntoCodeHarnessExecutors(fakeFactory()),
    });

    await worker.runNext();

    const events = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payload: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all();
    const types = events.map((e) => e.type);

    expect(types).toContain("harness.scope.reasoning_step");
    expect(types).toContain("harness.scope.validation");

    const reasoning = events.find(
      (e) => e.type === "harness.scope.reasoning_step",
    );
    expect(JSON.parse(reasoning!.payload)).toMatchObject({
      summary: "The scenario needs the screening action only.",
      confidence: 1,
    });

    // The check reports the fact it actually measured — exact catalog
    // resolution — and nothing else. The model's own declared gaps are a
    // different fact and get their own frame, so a clean revalidation can never
    // be read as "the model had no doubts".
    const validation = events.find(
      (e) => e.type === "harness.scope.validation",
    );
    expect(JSON.parse(validation!.payload)).toMatchObject({
      selected: 1,
      resolved: 1,
    });
    expect(types).not.toContain("harness.scope.declared_gap");
  });

  it("funds the scope decision from the policy budget and streams what it read", async () => {
    /**
     * #SCOPE-INQUIRY — the scope stage used to be ONE bounded classification
     * call with `tools: []`: the server pre-selected everything the model saw
     * (each field clipped), so on the live domain it "decided" in ~5s from a
     * 24,656-token flattened prompt and could not ask for anything.
     *
     * Two facts are asserted here, because both are how the FDE can tell the
     * difference: the allowance comes from the SERVER-OWNED command policy
     * (never invented at the call site), and whatever the recommender actually
     * did reaches the session log under the SAME frame vocabulary the analysis
     * path already uses.
     */
    const fixture = makeQueuedJob({ kind: "scope" });
    let seenBudget: unknown;
    const factory = fakeFactory({
      recommendScope: vi.fn(async (input) => {
        seenBudget = input.budget;
        await input.onFrame?.({
          type: "reasoning_step",
          index: 1,
          total: input.budget?.maxModelCalls ?? 0,
          output: "先把候选 Action 的完整契约读出来。",
        });
        await input.onFrame?.({
          type: "tool_call",
          tool: "read_action",
          reasoning: "读完整契约再判断范围。",
        });
        await input.onFrame?.({
          type: "tool_result",
          tool: "read_action",
          ok: true,
          summary: "完整契约",
        });
        await input.onFrame?.({
          type: "deliberation",
          status: "completed",
          path: "tool_loop",
          detail: "范围结论由只读工具循环得出。",
          modelCalls: 2,
          toolCalls: 2,
          budget: input.budget ?? null,
        });
        return {
          ...scopeRecommendation,
          scenario: input.scenario,
          ontologyHash: factorySourceOntologyHash(input.ontology),
          recommendationId: factoryScopeRecommendationId({
            scopeKey: input.scopeKey,
            domain: input.ontology.domainId,
            ontologyHash: factorySourceOntologyHash(input.ontology),
            scenario: input.scenario,
          }),
          decisionPath: "tool_loop" as const,
          catalogAccess: "tools" as const,
          modelCalls: 2,
          toolCalls: 2,
        };
      }),
    });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: createDefaultOntoCodeHarnessExecutors(factory),
    });

    await worker.runNext();

    expect(seenBudget).toEqual(ONTOCODE_COMMAND_POLICY.analyze_scope.budget);

    const events = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payload: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all();
    const types = events.map((e) => e.type);
    expect(types).toContain("harness.scope.tool_call");
    expect(types).toContain("harness.scope.tool_result");
    expect(types).toContain("harness.scope.deliberation");

    const deliberation = events.find(
      (e) => e.type === "harness.scope.deliberation",
    );
    expect(JSON.parse(deliberation!.payload)).toMatchObject({
      status: "completed",
      path: "tool_loop",
      modelCalls: 2,
      toolCalls: 2,
    });
    // The conclusion says HOW it was reached, right next to what it concluded.
    const conclusion = events
      .filter((e) => e.type === "harness.scope.reasoning_step")
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((payload) => payload.phase === "conclusion");
    expect(conclusion).toMatchObject({
      decisionPath: "tool_loop",
      catalogAccess: "tools",
    });
  });

  it("says plainly that an explicit FDE selection ran no reasoning at all", async () => {
    /**
     * Deterministic ≠ dishonest. When the FDE picks the Actions themselves no
     * model runs — and without a frame saying so, a 1-second scope result reads
     * exactly like fast thinking.
     */
    const fixture = makeQueuedJob({
      kind: "scope",
      commandType: "analyze_scope",
      commandArguments: {
        scopeMode: "selected_actions",
        actionIds: ["screen-candidate"],
      },
    });
    const factory = fakeFactory();
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory,
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: createDefaultOntoCodeHarnessExecutors(factory),
    });

    await worker.runNext();

    expect(factory.recommendScope).not.toHaveBeenCalled();
    const events = getDb()
      .select({
        type: ontocodeSessionEvents.type,
        payload: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.harnessJobId, fixture.job.id))
      .all();
    const deliberation = events.find(
      (e) => e.type === "harness.scope.deliberation",
    );
    expect(JSON.parse(deliberation!.payload)).toMatchObject({
      status: "deterministic",
      path: "explicit_selection",
      modelCalls: 0,
      toolCalls: 0,
    });
  });

  it("runs the executor inside the job's LLM attribution scope", async () => {
    /**
     * The Factory model adapter refuses any central-gateway call that carries
     * no tenant (unscoped usage cannot be billed or audited). Attribution
     * reaches the Factory through `runWithLlmCallContext`, which the Factory
     * RUN path owns for a whole run — but the OntoCode Harness is a SEPARATE
     * entry point, and its executors reach the same models.
     *
     * Live shape of the bug: harness job ocj-68c886e3fef54426 (kind=scope,
     * 2026-07-31) died as `scope_recommendation_unavailable` with no ledger row
     * and no telemetry row at all — the adapter threw before the provider was
     * ever called. Wrapping at the single executor seam covers every kind,
     * including the ones (ontology_analysis, blueprint) that had simply not run
     * again yet.
     */
    const fixture = makeQueuedJob({ kind: "scope" });
    let seenTenantId: string | undefined;
    let seenSlug: string | undefined;
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: {
        scope: async () => {
          const ctx = getLlmCallContext();
          seenTenantId = ctx.tenantId;
          seenSlug = ctx.tenantSlug;
          return { outcome: "succeeded", receipt: { attributed: true } };
        },
      },
    });

    await worker.runNext();

    expect(seenTenantId).toBe(tenantId);
    expect(seenSlug).toBe("__system");
    expect(getOntoCodeHarnessJob({ tenantId }, fixture.job.id).status).toBe(
      "succeeded",
    );
  });

  it("keeps the real reason a scope failure carried, instead of only the prose", async () => {
    /**
     * The FDE-facing sentence deliberately names no cause it cannot prove. That
     * only helps if the cause it DOES have survives to the durable receipt —
     * otherwise the honest message is just a less useful wrong one.
     */
    const fixture = makeQueuedJob({ kind: "scope" });
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: fakeFactory(),
      retryDelayMs: 0,
      maxAttempts: 1,
      executors: {
        scope: async () => {
          throw new FactoryScopeRecommendationError(
            "scope_recommendation_unavailable",
            "Action 范围推荐的模型调用失败；具体原因见本次回执，不做推测。",
            false,
            "Agent Factory model call is missing tenantId; refusing an unscoped central-gateway request",
          );
        },
      },
    });

    await worker.runNext();

    const failed = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.harnessJobId, fixture.job.id),
          eq(ontocodeSessionEvents.type, "harness.job.failed"),
        ),
      )
      .get();
    expect(JSON.parse(failed!.payloadJson)).toMatchObject({
      error: {
        code: "scope_recommendation_unavailable",
        details: { cause: expect.stringContaining("missing tenantId") },
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
