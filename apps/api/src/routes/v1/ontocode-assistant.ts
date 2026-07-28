import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ListOntoCodeAssistantRunsQuerySchema,
  OntoCodeAssistantRunGetReceiptSchema,
  OntoCodeAssistantRunListReceiptSchema,
  ONTOCODE_COMMAND_POLICY,
  OntoCodeTurnReceiptSchema,
} from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import {
  createOntoCodeTurn,
  getOntoCodeProject,
  getOntoCodeSession,
  listOntoCodeArtifacts,
  listOntoCodeHarnessJobs,
  listLatestOntoCodeMessages,
  makeOntoCodeIdempotencyKey,
  OntoCodeStoreError,
} from "../../services/ontocode-session-store";
import {
  acceptOntoCodeAssistantRun,
  assistantTerminalResponse,
  completeOntoCodeAssistantRun,
  completeOntoCodeAssistantStep,
  failOntoCodeAssistantRun,
  getOntoCodeAssistantRun,
  listOntoCodeAssistantRuns,
  persistOntoCodeCompiledContext,
  startOntoCodeAssistantStep,
} from "../../services/ontocode-assistant-run-store";
import {
  analyzeOntologyStructure,
  renderAnalysisForModel,
} from "@agentic/agent-factory";
import { createDefaultOntoCodeFactoryAdapter } from "../../services/ontocode-harness-worker";
import {
  compileOntoCodeContext,
  normalizeOntoCodeContextCompilerError,
} from "../../services/ontocode-context-compiler";
import {
  OntoCodeAssistantReadinessSchema,
  OntoCodeAssistantPlannerError,
  planOntoCodeAssistantTurn,
} from "../../services/ontocode-assistant-planner";

const AssistantPlanRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(50_000),
    contextRefs: z
      .array(z.string().trim().min(1).max(1_000))
      .max(20)
      .default([]),
    idempotencyKey: z.string().trim().min(8).max(256).optional(),
  })
  .strict();

function requestIdempotencyKey(
  headerValue: string | string[] | undefined,
  bodyValue: string | undefined,
): string {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return z
    .string()
    .trim()
    .min(8)
    .max(256)
    .parse(header?.trim() || bodyValue || makeOntoCodeIdempotencyKey());
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assistantReadiness(
  messages: ReturnType<typeof listLatestOntoCodeMessages>,
  jobs: ReturnType<typeof listOntoCodeHarnessJobs>["items"],
) {
  for (const message of [...messages].reverse()) {
    const sourceJob = message.commandId
      ? jobs.find((job) => job.commandId === message.commandId)
      : undefined;
    if (!sourceJob) continue;
    const receipt = objectValue(message.content.receipt);
    const readiness = objectValue(receipt?.readiness);
    const totals = objectValue(readiness?.totals);
    if (
      readiness?.schema !== "ontocode-factory-readiness/v1" ||
      !totals ||
      !Array.isArray(readiness.actions) ||
      typeof receipt?.ontologyHash !== "string"
    ) {
      continue;
    }
    const candidate = {
      jobId: sourceJob.id,
      ontologyHash: receipt.ontologyHash,
      readyActions: Array.isArray(totals.readyActions)
        ? totals.readyActions
        : [],
      blockedActions: Array.isArray(totals.blockedActions)
        ? totals.blockedActions
        : [],
      blockers: readiness.actions.flatMap((rawAction) => {
        const action = objectValue(rawAction);
        if (
          typeof action?.action !== "string" ||
          !Array.isArray(action.unresolvedBindings) ||
          action.unresolvedBindings.length === 0
        ) {
          return [];
        }
        return [
          {
            actionName: action.action,
            bindings: action.unresolvedBindings.flatMap((rawBinding) => {
              const binding = objectValue(rawBinding);
              if (
                typeof binding?.requirementId !== "string" ||
                typeof binding.system !== "string" ||
                typeof binding.status !== "string" ||
                typeof binding.reason !== "string"
              ) {
                return [];
              }
              return [
                {
                  requirementId: binding.requirementId,
                  system: binding.system,
                  kind: typeof binding.kind === "string" ? binding.kind : null,
                  role: typeof binding.role === "string" ? binding.role : null,
                  status: binding.status,
                  executionSurface:
                    typeof binding.executionSurface === "string"
                      ? binding.executionSurface
                      : null,
                  reason: binding.reason,
                },
              ];
            }),
          },
        ];
      }),
    };
    const parsed = OntoCodeAssistantReadinessSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Read-only AI planning endpoint. It does not create a Command or Harness Job;
 * the accepted plan must still enter through the atomic OntoCode turn route.
 *
 * Register this plugin beside `ontocodeRoutes` at the `/v1` scope.
 */
/** #ONTOLOGY-FACTS —— 本 Session 快照的结构化摘要，供助手直接回答领域事实类问题。
 *
 *  这条路径是确定性的：读本体 → 结构分析 → 紧凑渲染。不调模型、不排作业，所以「这个域有哪些
 *  动作」「哪些规则会卡住流程」不再需要跑一次完整的 harness。
 *  载入失败【不抛】：助手照常回答，只是上下文里会写明「没拿到摘要」，而不是让人以为它看过。 */
async function loadOntologyDigest(input: {
  tenantId: string;
  tenantSlug: string;
  project: { domain: string; ontologyDomainRegistrationId: string | null };
}): Promise<string | undefined> {
  try {
    const ontology = await createDefaultOntoCodeFactoryAdapter().fetchOntology({
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      domain: input.project.domain,
      ontologyDomainRegistrationId: input.project.ontologyDomainRegistrationId,
    });
    return renderAnalysisForModel(analyzeOntologyStructure(ontology));
  } catch {
    return undefined;
  }
}

export async function ontocodeAssistantRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/assistant-plan",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const input = AssistantPlanRequestSchema.parse(req.body);
      const ctx = { tenantId: auth.tenantId };
      const session = getOntoCodeSession(ctx, req.params.sessionId);
      const project = getOntoCodeProject(ctx, session.projectId);
      const jobs = listOntoCodeHarnessJobs(ctx, session.id, {
        limit: 20,
        offset: 0,
      }).items;
      const messages = listLatestOntoCodeMessages(ctx, session.id, 24);
      const readiness = assistantReadiness(messages, jobs);
      const artifacts = listOntoCodeArtifacts(ctx, session.id, {
        limit: 200,
        offset: 0,
      }).items;
      const artifactCounts: Record<string, number> = {};
      for (const item of artifacts) {
        artifactCounts[item.artifact.kind] =
          (artifactCounts[item.artifact.kind] ?? 0) + 1;
      }

      try {
        const compiled = compileOntoCodeContext({
          ctx,
          project,
          session,
          requestedRefs: input.contextRefs,
          ontologyDigest: await loadOntologyDigest({
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
            project,
          }),
        });
        const result = await planOntoCodeAssistantTurn({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          userText: input.text,
          contextRefs: input.contextRefs,
          session: {
            id: session.id,
            projectId: session.projectId,
            domain: project.domain,
            title: session.title,
            goal: session.goal,
            phase: session.phase,
            activityState: session.activityState,
            autonomyMode: session.autonomyMode,
            revision: session.revision,
            ontologySnapshotHash: session.ontologySnapshotHash,
            environmentProfileVersionId: session.environmentProfileVersionId,
          },
          jobs: jobs.map((job) => ({
            id: job.id,
            kind: job.kind,
            status: job.status,
            errorMessage: job.errorMessage,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          })),
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            type: message.type,
            text:
              typeof message.content.text === "string"
                ? message.content.text
                : "",
            createdAt: message.createdAt,
          })),
          readiness,
          artifactCounts,
          compiledContext: {
            contextHash: compiled.contextHash,
            manifest: compiled.manifest,
            refs: compiled.refs.map((ref) => ({
              kind: ref.kind,
              canonicalRef: ref.canonicalRef,
              contentHash: ref.contentHash,
              content: ref.content,
              truncated: ref.truncated,
              redacted: ref.redacted,
              metadata: ref.metadata,
            })),
          },
        });
        reply.header("Cache-Control", "no-store");
        return reply.ok(result);
      } catch (error) {
        const contextError = normalizeOntoCodeContextCompilerError(error);
        if (contextError) {
          return reply.fail(
            contextError.code,
            contextError.message,
            contextError.statusCode,
            undefined,
            contextError.details,
          );
        }
        if (error instanceof OntoCodeAssistantPlannerError) {
          return reply.fail(
            error.code,
            error.message,
            error.code === "ontocode_assistant_planner_unavailable" ? 503 : 502,
          );
        }
        throw error;
      }
    },
  );

  /**
   * Canonical conversational entry point. The model may recommend one bounded
   * action, but server policy still derives command risk, budget, approval and
   * Harness kind. User message, validated AI reply, directive, Command and Job
   * are then committed by the existing atomic turn transaction.
   */
  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/assistant-turns",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const input = AssistantPlanRequestSchema.parse(req.body);
      const idempotencyKey = requestIdempotencyKey(
        req.headers["idempotency-key"],
        input.idempotencyKey,
      );
      const ctx = {
        tenantId: auth.tenantId,
        actorId: auth.userId ?? auth.credentialId ?? null,
      };
      let assistantRunId: string | null = null;
      let activeStepId: string | undefined;

      try {
        // The accepted user message and Assistant Run are committed before any
        // model/provider call. A planner outage therefore remains visible and
        // retryable instead of silently losing the FDE's turn.
        const acceptance = acceptOntoCodeAssistantRun(
          ctx,
          req.params.sessionId,
          {
            text: input.text,
            contextRefs: input.contextRefs,
            idempotencyKey,
          },
        );
        assistantRunId = acceptance.run.id;
        const terminal = assistantTerminalResponse(acceptance.run);
        if (terminal) {
          const receipt = OntoCodeTurnReceiptSchema.parse({
            ...terminal,
            mode: "attached",
          });
          return reply.ok(receipt);
        }
        if (
          acceptance.run.status === "failed" ||
          acceptance.run.status === "cancelled"
        ) {
          return reply.fail(
            acceptance.run.errorCode ?? "ontocode_assistant_run_terminal",
            acceptance.run.errorMessage ??
              "This Assistant Run is terminal; retry with a new idempotency key",
            409,
            undefined,
            { assistantRunId: acceptance.run.id },
          );
        }

        // Re-read after durable acceptance because accepting the turn advances
        // the Session revision and changes its activity to ai_planning.
        const session = getOntoCodeSession(ctx, req.params.sessionId);
        const project = getOntoCodeProject(ctx, session.projectId);
        const jobs = listOntoCodeHarnessJobs(ctx, session.id, {
          limit: 20,
          offset: 0,
        }).items;
        const messages = listLatestOntoCodeMessages(ctx, session.id, 24);
        const readiness = assistantReadiness(messages, jobs);
        const artifacts = listOntoCodeArtifacts(ctx, session.id, {
          limit: 200,
          offset: 0,
        }).items;
        const artifactCounts: Record<string, number> = {};
        for (const item of artifacts) {
          artifactCounts[item.artifact.kind] =
            (artifactCounts[item.artifact.kind] ?? 0) + 1;
        }

        const contextStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
          ordinal: 1,
          kind: "context_compile",
          input: {
            sourceMessageId: acceptance.sourceMessage.id,
            sessionRevision: session.revision,
            requestedRefs: input.contextRefs,
          },
        });
        activeStepId = contextStep.id;
        const compiled = compileOntoCodeContext({
          ctx,
          project,
          session,
          requestedRefs: input.contextRefs,
          ontologyDigest: await loadOntologyDigest({
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
            project,
          }),
        });
        persistOntoCodeCompiledContext(ctx, acceptance.run.id, compiled);
        completeOntoCodeAssistantStep(ctx, contextStep.id, {
          schema: compiled.schema,
          contextHash: compiled.contextHash,
          manifest: compiled.manifest,
        });

        const modelStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
          ordinal: 2,
          kind: "model_plan",
          input: {
            sourceMessageId: acceptance.sourceMessage.id,
            contextHash: compiled.contextHash,
            plannerContract: "ontocode-assistant-plan/v1",
          },
        });
        activeStepId = modelStep.id;
        const planner = await planOntoCodeAssistantTurn({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          userText: input.text,
          contextRefs: input.contextRefs,
          session: {
            id: session.id,
            projectId: session.projectId,
            domain: project.domain,
            title: session.title,
            goal: session.goal,
            phase: session.phase,
            activityState: session.activityState,
            autonomyMode: session.autonomyMode,
            revision: session.revision,
            ontologySnapshotHash: session.ontologySnapshotHash,
            environmentProfileVersionId: session.environmentProfileVersionId,
          },
          jobs: jobs.map((job) => ({
            id: job.id,
            kind: job.kind,
            status: job.status,
            errorMessage: job.errorMessage,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          })),
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            type: message.type,
            text:
              typeof message.content.text === "string"
                ? message.content.text
                : "",
            createdAt: message.createdAt,
          })),
          readiness,
          artifactCounts,
          compiledContext: {
            contextHash: compiled.contextHash,
            manifest: compiled.manifest,
            refs: compiled.refs.map((ref) => ({
              kind: ref.kind,
              canonicalRef: ref.canonicalRef,
              contentHash: ref.contentHash,
              content: ref.content,
              truncated: ref.truncated,
              redacted: ref.redacted,
              metadata: ref.metadata,
            })),
          },
        });
        const plan = planner.plan;
        completeOntoCodeAssistantStep(ctx, modelStep.id, {
          behavior: plan.behavior,
          action: plan.behavior === "execute" ? plan.action : null,
          target: plan.behavior === "navigate" ? plan.target : null,
          model: planner.model,
          confidence: plan.confidence,
          recommendationCount: plan.recommendations.length,
          redactedInputPaths: planner.redactedInputPaths,
        });

        const waitingJob =
          plan.behavior === "execute"
            ? jobs.find(
                (job) =>
                  job.status === "waiting_user" &&
                  job.kind === ONTOCODE_COMMAND_POLICY[plan.action].jobKind,
              )
            : undefined;
        const turn: Parameters<typeof createOntoCodeTurn>[2] = {
          text: input.text,
          behavior: plan.behavior,
          ...(plan.behavior === "execute" ? { action: plan.action } : {}),
          arguments:
            plan.behavior === "execute"
              ? {
                  instruction: input.text,
                  source: "ontocode-assistant",
                  assistantPlanModel: planner.model,
                  assistantPlanConfidence: plan.confidence,
                  ...(waitingJob
                    ? {
                        clarificationAnswer: input.text,
                        resumeWaitingUserJobId: waitingJob.id,
                      }
                    : {}),
                }
              : {},
          affectedSemanticPaths:
            plan.behavior === "execute" ? input.contextRefs : [],
          requestedCapabilities: [],
          idempotencyKey,
          assistantText: plan.assistantText,
          assistantRecommendations: plan.recommendations,
          ...(plan.behavior === "navigate"
            ? { directiveTarget: plan.target }
            : {}),
          persistedRequestContent: {
            text: input.text,
            turn: {
              behavior: "assistant",
              contextRefs: input.contextRefs,
            },
          },
        };

        const policyStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
          ordinal: 3,
          kind: "policy_commit",
          input: {
            behavior: plan.behavior,
            action: plan.behavior === "execute" ? plan.action : null,
            contextHash: compiled.contextHash,
            sessionRevision: session.revision,
          },
        });
        activeStepId = policyStep.id;
        const receipt = OntoCodeTurnReceiptSchema.parse(
          createOntoCodeTurn(ctx, session.id, turn),
        );
        completeOntoCodeAssistantStep(ctx, policyStep.id, {
          directiveId: receipt.directive.id,
          behavior: receipt.directive.behavior,
          commandId: receipt.command?.id ?? null,
          harnessJobId: receipt.job?.id ?? null,
          sessionRevision: receipt.sessionRevision,
          policyDerived: true,
        });
        completeOntoCodeAssistantRun(ctx, acceptance.run.id, {
          model: planner.model,
          terminalResponse: receipt,
        });
        return reply.ok(receipt, receipt.mode === "created" ? 201 : 200);
      } catch (error) {
        if (assistantRunId) {
          try {
            failOntoCodeAssistantRun(ctx, assistantRunId, error, activeStepId);
          } catch {
            // Preserve the original error response. The run store is itself
            // tenant scoped and the API log will still capture an unexpected
            // secondary persistence failure.
          }
        }
        const contextError = normalizeOntoCodeContextCompilerError(error);
        if (contextError) {
          return reply.fail(
            contextError.code,
            contextError.message,
            contextError.statusCode,
            undefined,
            {
              ...contextError.details,
              ...(assistantRunId ? { assistantRunId } : {}),
            },
          );
        }
        if (error instanceof OntoCodeAssistantPlannerError) {
          return reply.fail(
            error.code,
            error.message,
            error.code === "ontocode_assistant_planner_unavailable" ? 503 : 502,
            undefined,
            assistantRunId ? { assistantRunId } : undefined,
          );
        }
        if (error instanceof OntoCodeStoreError) {
          return reply.fail(
            error.code,
            error.message,
            error.statusCode,
            undefined,
            error.details,
          );
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/assistant-runs",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.read");
      const query = ListOntoCodeAssistantRunsQuerySchema.parse(req.query);
      const receipt = OntoCodeAssistantRunListReceiptSchema.parse(
        listOntoCodeAssistantRuns(
          { tenantId: auth.tenantId },
          req.params.sessionId,
          query,
        ),
      );
      reply.header("Cache-Control", "no-store");
      return reply.ok(receipt);
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/ontocode/assistant-runs/:runId",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.read");
      try {
        const receipt = OntoCodeAssistantRunGetReceiptSchema.parse(
          getOntoCodeAssistantRun(
            { tenantId: auth.tenantId },
            req.params.runId,
          ),
        );
        reply.header("Cache-Control", "no-store");
        return reply.ok(receipt);
      } catch (error) {
        if (error instanceof OntoCodeStoreError) {
          return reply.fail(
            error.code,
            error.message,
            error.statusCode,
            undefined,
            error.details,
          );
        }
        throw error;
      }
    },
  );
}
