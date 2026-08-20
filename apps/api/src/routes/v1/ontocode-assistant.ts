import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ListOntoCodeAssistantRunsQuerySchema,
  OntoCodeAssistantRunGetReceiptSchema,
  OntoCodeAssistantRunListReceiptSchema,
  ONTOCODE_COMMAND_POLICY,
  resolveOntoCodeAutonomyActionPolicy,
  OntoCodeTurnReceiptSchema,
  type OntoCodeAutonomyMode,
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
  listRecentOntoCodeAssistantStepObservations,
  appendOntoCodeAssistantProgress,
  persistOntoCodeCompiledContext,
  startOntoCodeAssistantStep,
} from "../../services/ontocode-assistant-run-store";
import {
  assistantBudgetFramePayload,
  assistantPlanFramePayload,
  assistantPolicyFramePayload,
  assistantSourceScopeFramePayload,
  createOntoCodeAssistantProgressBridge,
  ONTOCODE_ASSISTANT_PROGRESS_FRAMES,
} from "../../services/ontocode-assistant-progress";
import {
  analyzeOntologyStructure,
  renderAnalysisForModel,
  type DomainOntology,
  type OntologyStructuralAnalysis,
} from "@agentic/agent-factory";
import { createDefaultOntoCodeFactoryAdapter } from "../../services/ontocode-harness-worker";
import {
  compileOntoCodeContext,
  normalizeOntoCodeContextCompilerError,
  resolveOntoCodeAssistantContextRefs,
} from "../../services/ontocode-context-compiler";
import {
  isOntoCodeHarnessAssistantAction,
  OntoCodeAssistantReadinessSchema,
  OntoCodeAssistantPlannerError,
  planOntoCodeAssistantTurn,
  projectOntoCodeAssistantPlannerHistory,
  withoutImmediateExecutionRecommendation,
  type OntoCodeAssistantPlan,
  type OntoCodeAssistantPlannerInput,
} from "../../services/ontocode-assistant-planner";
import {
  hasWaitingOntoCodeBuildInteraction,
  normalizeOntoCodeWaitingBuildContinuation,
} from "../../services/ontocode-assistant-continuation";
import {
  ontoCodeAutopilotBuildRationaleSummary,
  ontoCodeAutopilotBuildStartText,
  resolveOntoCodeAutopilotBuildStart,
} from "../../services/ontocode-autopilot-build-pipeline";
import {
  applyConfigurationProposal,
  buildConfigurationProposal,
  deriveConfigurationSurface,
  parseConfigurationConfirmation,
  ONTOCODE_CONFIGURATION_APPLY_SCHEMA,
  ONTOCODE_CONFIGURATION_PROPOSAL_SCHEMA,
  type ConfigurationProposal,
} from "../../services/ontocode-assistant-configuration";
import {
  assistantRecommendationRecords,
  defaultConfigurationPorts,
  renderConfigurationApply,
  renderConfigurationProposal,
  type ConfigurationTurnRendering,
} from "../../services/ontocode-assistant-configuration-turn";

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

/**
 * 一句给人看的失败原因。
 *
 * 只说确定的事：契约化的失败自带 FDE 可读的句子（上下文编译、运行库、计划器
 * 三类），照原样用；剩下的未知异常**不许**把 `error.message` 摊到屏幕上——那
 * 是内部堆栈的措辞，还可能夹带请求正文。真实原因走结构化字段与服务端日志。
 */
function assistantFailureSentence(
  error: unknown,
  contextError: { message: string } | null,
): string {
  if (contextError) return contextError.message;
  if (
    error instanceof OntoCodeAssistantPlannerError ||
    error instanceof OntoCodeStoreError
  ) {
    return error.message;
  }
  return "这一轮在服务端中断了，没有任何改动被提交。可以直接重试。";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function applyAssistantAutonomyPolicy(
  mode: OntoCodeAutonomyMode,
  plan: OntoCodeAssistantPlan,
  userText: string,
): OntoCodeAssistantPlan {
  const recommendations = plan.recommendations.filter((recommendation) => {
    if (recommendation.action?.type !== "execute") return true;
    // A server-owned, non-Harness action creates no Command and no Job. Its own
    // gate (an explicit in-band confirmation, plus the guide-mode refusal on
    // the apply path) is stricter than the Command risk table, so the Command
    // autonomy filter does not apply to it.
    if (!isOntoCodeHarnessAssistantAction(recommendation.action.turnAction)) {
      return true;
    }
    return resolveOntoCodeAutonomyActionPolicy(
      mode,
      recommendation.action.turnAction,
    ).allowed;
  });
  if (plan.behavior !== "execute") {
    return recommendations.length === plan.recommendations.length
      ? plan
      : { ...plan, recommendations };
  }
  if (!isOntoCodeHarnessAssistantAction(plan.action)) {
    return recommendations.length === plan.recommendations.length
      ? plan
      : { ...plan, recommendations };
  }
  const autonomy = resolveOntoCodeAutonomyActionPolicy(mode, plan.action);
  if (autonomy.allowed) {
    return recommendations.length === plan.recommendations.length
      ? plan
      : { ...plan, recommendations };
  }
  const chinese = /[\u3400-\u9fff]/u.test(userText);
  return {
    behavior: "explain",
    assistantText: chinese
      ? `${plan.assistantText}\n\n当前 Session 是“仅分析”模式；我没有创建会修改工件或运行沙箱的 Command。切换到“每步确认”或“自主执行”后才能继续这一步。`
      : `${plan.assistantText}\n\nThis Session is in analysis-only mode. I did not create a Command that would change artifacts or run a sandbox. Switch to confirm-each-step or autonomous mode to continue.`,
    rationaleSummary: `${plan.rationaleSummary}; blocked by analysis-only autonomy policy`,
    confidence: plan.confidence,
    recommendations,
    // The evidence the answer stood on does not change because policy blocked
    // the action; dropping it here would make a downgraded turn look ungrounded.
    citedRefs: plan.citedRefs,
  };
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
}): Promise<{
  digest: string | undefined;
  /** The structural scale this turn actually stood on, or null when the digest
   * did not load. Absent stays absent — reporting zeros for an unread ontology
   * would claim an empty domain. */
  counts: OntologyStructuralAnalysis["counts"] | null;
  /**
   * #ASSISTANT-INQUIRY —— the resolved ontology OBJECT, kept rather than
   * discarded after the digest is rendered.
   *
   * It is what the conversation's read-only tool closure is built over: the
   * planner never re-fetches and never receives a domain or tenant, so the read
   * boundary is exactly this one already-authorized object.
   */
  ontology: DomainOntology | null;
}> {
  try {
    const ontology = await createDefaultOntoCodeFactoryAdapter().fetchOntology({
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      domain: input.project.domain,
      ontologyDomainRegistrationId: input.project.ontologyDomainRegistrationId,
    });
    const analysis = analyzeOntologyStructure(ontology);
    return {
      digest: renderAnalysisForModel(analysis),
      counts: analysis.counts,
      ontology,
    };
  } catch {
    return { digest: undefined, counts: null, ontology: null };
  }
}

/**
 * Bounded projection of one field-schema record (argsSchema / returnsSchema /
 * configSchema / declarative paramsSchema) for the planner. Named caps; env
 * may widen the field cap up to the contract schema's hard ceiling. Cutting is
 * never silent — the contract carries `truncated`.
 */
const PLANNER_TOOL_CONTRACT_MAX_FIELDS_ENV =
  "ONTOCODE_PLANNER_TOOL_CONTRACT_MAX_FIELDS";
const PLANNER_TOOL_CONTRACT_MAX_FIELDS_DEFAULT = 40;
/** Hard ceiling of PlannerToolContractSchema — env cannot exceed it. */
const PLANNER_TOOL_CONTRACT_MAX_FIELDS_CEILING = 100;
const PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES_ENV =
  "ONTOCODE_PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES";
const PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES_DEFAULT = 20;
const PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES_CEILING = 40;
const PLANNER_TOOL_CONTRACT_MAX_DESCRIPTION_CHARS = 240;

function plannerContractCap(
  name: string,
  fallback: number,
  ceiling: number,
): number {
  const raw = Number(process.env[name]);
  const requested =
    Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
  return Math.min(requested, ceiling);
}

type PlannerContractField = {
  key: string;
  type: string;
  required: boolean;
  description?: string;
  allowedValues?: Array<string | number | boolean>;
};

function plannerContractSection(
  raw: unknown,
  state: { truncated: boolean },
): PlannerContractField[] | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const maxFields = plannerContractCap(
    PLANNER_TOOL_CONTRACT_MAX_FIELDS_ENV,
    PLANNER_TOOL_CONTRACT_MAX_FIELDS_DEFAULT,
    PLANNER_TOOL_CONTRACT_MAX_FIELDS_CEILING,
  );
  const maxValues = plannerContractCap(
    PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES_ENV,
    PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES_DEFAULT,
    PLANNER_TOOL_CONTRACT_MAX_ALLOWED_VALUES_CEILING,
  );
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key]) => key.trim().length > 0 && key.trim().length <= 160,
  );
  if (entries.length > maxFields) state.truncated = true;
  return entries.slice(0, maxFields).map(([key, value]) => {
    const spec = objectValue(value);
    const type =
      typeof value === "string" && value.trim()
        ? value.trim().slice(0, 80)
        : typeof spec?.type === "string" && spec.type.trim()
          ? spec.type.trim().slice(0, 80)
          : "unknown";
    const description =
      typeof spec?.description === "string" && spec.description.trim()
        ? spec.description
            .trim()
            .slice(0, PLANNER_TOOL_CONTRACT_MAX_DESCRIPTION_CHARS)
        : undefined;
    const rawValues = Array.isArray(spec?.allowedValues)
      ? spec.allowedValues.filter(
          (entry): entry is string | number | boolean =>
            typeof entry === "boolean" ||
            typeof entry === "number" ||
            (typeof entry === "string" && entry.length <= 200),
        )
      : [];
    if (rawValues.length > maxValues) state.truncated = true;
    return {
      key: key.trim(),
      type,
      required: spec?.required === true,
      ...(description ? { description } : {}),
      ...(rawValues.length > 0
        ? { allowedValues: rawValues.slice(0, maxValues) }
        : {}),
    };
  });
}

/**
 * Give the planner the same tenant-effective, runtime-active tool inventory
 * that Build reads. Only bounded contract metadata and environment-variable
 * names cross this boundary; profiles, config values and probe bodies do not.
 *
 * Draft revisions intentionally stay absent. A model must not treat a proposed
 * tool as executable merely because Tool-Smith persisted it.
 *
 * Exported for tests: the projection is where a persisted declarative tool
 * becomes `origin:"generated_active"` and where the tool's ACTUAL contract
 * (argsSchema/returnsSchema/configSchema) reaches the planner, so it can judge
 * reuse-vs-author from the contract instead of a name and a summary.
 */
export async function loadPlannerToolCatalog(input: {
  tenantId: string;
  tenantSlug: string;
  project: { domain: string; ontologyDomainRegistrationId: string | null };
}): Promise<{
  status: OntoCodeAssistantPlannerInput["toolCatalogStatus"];
  tools: OntoCodeAssistantPlannerInput["toolCatalog"];
}> {
  try {
    const resources =
      await createDefaultOntoCodeFactoryAdapter().listExecutionResources?.({
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        domain: input.project.domain,
        ontologyDomainRegistrationId:
          input.project.ontologyDomainRegistrationId,
      });
    if (!resources) return { status: "unavailable", tools: [] };
    const boundedStrings = (
      values: string[] | undefined,
      max: number,
      length: number,
    ) =>
      [...new Set(values ?? [])]
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= length)
        .slice(0, max);
    return {
      status: "loaded",
      tools: [...resources.tools]
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 200)
        .map((tool) => {
          // The actual contract, whichever tier owns it: catalog definitions
          // for global/tenant-native tools, the persisted declarative
          // definition for FDE-authored ones.
          const contractState = { truncated: false };
          const args = plannerContractSection(
            tool.catalogDefinition?.argsSchema ??
              tool.declarativeDefinition?.paramsSchema ??
              null,
            contractState,
          );
          const returns = plannerContractSection(
            tool.catalogDefinition?.returnsSchema ??
              tool.declarativeDefinition?.returnsSchema ??
              null,
            contractState,
          );
          const config = plannerContractSection(
            tool.catalogDefinition?.configSchema ?? null,
            contractState,
          );
          return {
            name: tool.name.slice(0, 240),
            summary: (tool.summary?.trim() || tool.name).slice(0, 500),
            origin: tool.declarativeDefinition
              ? ("generated_active" as const)
              : tool.category === "tenant"
                ? ("tenant" as const)
                : ("global" as const),
            runtimeActive: true as const,
            operation: tool.operation ?? null,
            effectScope: tool.effectScope ?? null,
            sandboxPolicy: tool.sandboxPolicy ?? null,
            probeStatus: tool.probeStatus ?? "unknown",
            configKeys: boundedStrings(tool.configKeys, 40, 160),
            credentialEnv: boundedStrings(tool.credentialEnv, 40, 160).filter(
              (value) => /^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value),
            ),
            capabilities: (tool.capabilities ?? [])
              .slice(0, 20)
              .map((capability) => ({
                systems: boundedStrings(capability.systems, 20, 240),
                kinds: boundedStrings(capability.kinds, 20, 120),
                roles: boundedStrings(capability.roles, 20, 120),
                operations: boundedStrings(capability.operations, 40, 160),
                objectTypes: boundedStrings(capability.objectTypes, 40, 200),
              })),
            contract:
              args === null && returns === null && config === null
                ? null
                : {
                    args: args ?? [],
                    returns: returns ?? [],
                    config: config ?? [],
                    truncated: contractState.truncated,
                  },
          };
        }),
    };
  } catch {
    // Missing inventory is represented as an empty bounded fact set. The
    // prompt forbids turning that absence into a claim that no tools exist.
    return { status: "unavailable", tools: [] };
  }
}

/**
 * The tenant's confirmed, configurable external systems, reduced to what a
 * planner may safely see: names, provider key, declared field SHAPES and a
 * satisfied boolean. No value, masked value or probe body crosses this line —
 * presence is derived through the same `requirementFor` layering Settings uses.
 *
 * This is what makes "never invent a provider or field" enforceable: the model
 * can only name a system that already exists here, and the executor re-resolves
 * that name against the real profiles anyway.
 */
async function loadConfigurableSystems(input: {
  tenantId: string;
  tenantSlug: string;
  domain: string;
}): Promise<OntoCodeAssistantPlannerInput["configurableSystems"]> {
  try {
    const ports = defaultConfigurationPorts();
    const profiles = ports.listSystemProfiles(input.tenantId);
    if (profiles.length === 0) return [];
    const toolEntries = await ports.listToolEntries(input);
    return profiles.slice(0, 50).map((profile) => {
      const provider = profile.credential?.provider?.trim() || null;
      const surface = deriveConfigurationSurface({
        system: profile.name,
        profiles,
        toolEntries,
        integration: provider
          ? ports.getIntegrationSnapshot(input.tenantId, provider)
          : null,
        envPresent: ports.envPresent,
      });
      return {
        system: profile.name,
        profileId: profile.id,
        aliases: profile.aliases.slice(0, 20),
        provider: surface.requirement.provider,
        posture: surface.requirement.posture,
        fields: surface.fields.slice(0, 40).map((field) => ({
          key: field.key,
          kind: field.kind,
          required: field.required,
          secret: field.secret,
          envRef: field.envRef,
          satisfied: field.satisfied,
        })),
      };
    });
  } catch {
    // Absence is represented as an empty list; the prompt forbids reading that
    // as proof that the tenant has no configurable system.
    return [];
  }
}

/**
 * A planner failure's HTTP status turns on whose fault it is. `unavailable`
 * and `invalid_response` are upstream-model conditions (503/502). An invalid
 * planner INPUT is a request this server failed to assemble — a 5xx of our
 * own, and reporting it as a gateway error would point the operator at the
 * model channel instead of at us.
 */
function plannerErrorStatus(
  code: OntoCodeAssistantPlannerError["code"],
): number {
  if (code === "ontocode_assistant_planner_unavailable") return 503;
  if (code === "ontocode_assistant_planner_input_invalid") return 500;
  return 502;
}

/** Locate the persisted proposal a server-minted confirmation refers to. */
function findPersistedConfigurationProposal(
  ctx: { tenantId: string },
  sessionId: string,
  digest: string,
): ConfigurationProposal | null {
  for (const observation of listRecentOntoCodeAssistantStepObservations(
    ctx,
    sessionId,
    { kind: "result_review", limit: 24 },
  )) {
    if (observation.schema !== ONTOCODE_CONFIGURATION_PROPOSAL_SCHEMA) continue;
    const proposal = observation.proposal;
    if (
      proposal &&
      typeof proposal === "object" &&
      !Array.isArray(proposal) &&
      (proposal as ConfigurationProposal).digest === digest &&
      (proposal as ConfigurationProposal).sessionId === sessionId
    ) {
      return proposal as ConfigurationProposal;
    }
  }
  return null;
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
      // #HISTORY-BUDGET — never hand the planner raw persisted text. Readiness
      // is still derived from the FULL messages above; only what crosses to the
      // model is budgeted.
      const history = projectOntoCodeAssistantPlannerHistory({
        messages,
        jobs,
      });
      const artifacts = listOntoCodeArtifacts(ctx, session.id, {
        limit: 200,
        offset: 0,
      }).items;
      const artifactCounts: Record<string, number> = {};
      for (const item of artifacts) {
        artifactCounts[item.artifact.kind] =
          (artifactCounts[item.artifact.kind] ?? 0) + 1;
      }
      const effectiveContextRefs = resolveOntoCodeAssistantContextRefs(
        input.contextRefs,
        artifacts,
      );

      try {
        const [ontologyDigest, toolCatalog, configurableSystems] =
          await Promise.all([
            loadOntologyDigest({
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              project,
            }),
            loadPlannerToolCatalog({
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              project,
            }),
            loadConfigurableSystems({
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              domain: project.domain,
            }),
          ]);
        const compiled = compileOntoCodeContext({
          ctx,
          project,
          session,
          requestedRefs: effectiveContextRefs,
          ontologyDigest: ontologyDigest.digest,
        });
        const result = await planOntoCodeAssistantTurn({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          userText: input.text,
          contextRefs: effectiveContextRefs,
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
          jobs: history.jobs,
          messages: history.messages,
          readiness,
          toolCatalogStatus: toolCatalog.status,
          toolCatalog: toolCatalog.tools,
          artifactCounts,
          configurableSystems,
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
            plannerErrorStatus(error.code),
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
      /**
       * #ASSISTANT-PROGRESS —— 每轮新建，绝不跨轮复用：预算与序号都活在这一轮
       * 里。`runId` 在受理之后才有，所以桥先建、写入时再解引用；受理之前发不出
       * 帧，这本身就是对的——那时还没有任何事实发生。
       */
      const progress = createOntoCodeAssistantProgressBridge({
        write: ({ type, payload }) => {
          // 受理失败时根本没有 Run，也就没有可挂帧的轨迹。这里**抛**而不是静默
          // 返回：静默返回会被桥记成「已发出」，屏幕上少一行、账上却是满的。
          if (!assistantRunId) {
            throw new Error(
              "no accepted Assistant Run to attach a progress frame to",
            );
          }
          appendOntoCodeAssistantProgress(ctx, {
            runId: assistantRunId,
            type,
            payload,
          });
        },
      });

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

        // ── In-band configuration confirmation ───────────────────────────
        // A server-minted directive is deterministic authority, so it is
        // handled BEFORE any planning: a confirmation must never be
        // re-interpreted — or invented — by the model. The write itself still
        // goes through the existing System Profile / Integration stores and is
        // signed with this Session's real owner.
        const confirmation = parseConfigurationConfirmation(input.text);
        if (confirmation) {
          const applyStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
            ordinal: 1,
            kind: "result_review",
            input: {
              operation: "configuration_apply",
              digest: confirmation.digest,
              pick: confirmation.pick,
              sessionRevision: session.revision,
              sourceMessageId: acceptance.sourceMessage.id,
            },
          });
          activeStepId = applyStep.id;
          const outcome =
            session.autonomyMode === "guide"
              ? ({
                  kind: "refused",
                  code: "autonomy_analysis_only",
                  message:
                    "当前 Session 是“仅分析”模式，我不会在这个模式下改动租户配置。切换到“每步确认”或“自主执行”后再确认这次变更。",
                } as const)
              : await applyConfigurationProposal(
                  {
                    tenantId: auth.tenantId,
                    tenantSlug: auth.tenantSlug,
                    domain: project.domain,
                    sessionId: session.id,
                    ownerUserId: session.ownerUserId,
                    directive: confirmation,
                    proposal: findPersistedConfigurationProposal(
                      ctx,
                      session.id,
                      confirmation.digest,
                    ),
                  },
                  defaultConfigurationPorts(),
                );
          completeOntoCodeAssistantStep(ctx, applyStep.id, {
            schema: ONTOCODE_CONFIGURATION_APPLY_SCHEMA,
            outcome,
          });
          const rendering: ConfigurationTurnRendering =
            renderConfigurationApply(outcome);
          const applyReceipt = OntoCodeTurnReceiptSchema.parse(
            createOntoCodeTurn(ctx, session.id, {
              text: input.text,
              behavior: "explain",
              arguments: {},
              affectedSemanticPaths: [],
              requestedCapabilities: [],
              idempotencyKey,
              assistantText: rendering.text,
              assistantRecommendations: assistantRecommendationRecords(
                rendering.recommendations,
              ),
              persistedRequestContent: {
                text: input.text,
                turn: {
                  behavior: "assistant",
                  contextRefs: input.contextRefs,
                },
              },
            }),
          );
          completeOntoCodeAssistantRun(ctx, acceptance.run.id, {
            model: null,
            terminalResponse: applyReceipt,
          });
          return reply.ok(
            applyReceipt,
            applyReceipt.mode === "created" ? 201 : 200,
          );
        }

        const jobs = listOntoCodeHarnessJobs(ctx, session.id, {
          limit: 20,
          offset: 0,
        }).items;
        const messages = listLatestOntoCodeMessages(ctx, session.id, 24);
        const readiness = assistantReadiness(messages, jobs);
        // #HISTORY-BUDGET — same shared projection as the plan route; see there.
        const history = projectOntoCodeAssistantPlannerHistory({
          messages,
          jobs,
        });
        const artifacts = listOntoCodeArtifacts(ctx, session.id, {
          limit: 200,
          offset: 0,
        }).items;
        const artifactCounts: Record<string, number> = {};
        for (const item of artifacts) {
          artifactCounts[item.artifact.kind] =
            (artifactCounts[item.artifact.kind] ?? 0) + 1;
        }
        const effectiveContextRefs = resolveOntoCodeAssistantContextRefs(
          input.contextRefs,
          artifacts,
        );

        const contextStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
          ordinal: 1,
          kind: "context_compile",
          input: {
            sourceMessageId: acceptance.sourceMessage.id,
            sessionRevision: session.revision,
            requestedRefs: input.contextRefs,
            effectiveRefs: effectiveContextRefs,
            refSource:
              input.contextRefs.length > 0
                ? "request"
                : "latest_stage_artifacts",
          },
        });
        activeStepId = contextStep.id;
        const [ontologyDigest, toolCatalog, configurableSystems] =
          await Promise.all([
            loadOntologyDigest({
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              project,
            }),
            loadPlannerToolCatalog({
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              project,
            }),
            loadConfigurableSystems({
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              domain: project.domain,
            }),
          ]);
        // 三路并发**已经**全部 resolve：下面报的是这一轮真正取用到的规模。
        await progress.emit(
          ONTOCODE_ASSISTANT_PROGRESS_FRAMES.sourceScope,
          assistantSourceScopeFramePayload({
            ontologyCounts: ontologyDigest.counts,
            toolCatalogStatus: toolCatalog.status,
            toolCount: toolCatalog.tools.length,
            configurableSystemCount: configurableSystems.length,
          }),
        );
        const compiled = compileOntoCodeContext({
          ctx,
          project,
          session,
          requestedRefs: effectiveContextRefs,
          ontologyDigest: ontologyDigest.digest,
        });
        persistOntoCodeCompiledContext(ctx, acceptance.run.id, compiled);
        completeOntoCodeAssistantStep(ctx, contextStep.id, {
          schema: compiled.schema,
          contextHash: compiled.contextHash,
          manifest: compiled.manifest,
        });
        // 上下文已经编译并落库：丢了多少字是既成事实，现在报得出真数。
        // 什么都没被折叠、也没有附件引用时构造器返回 null——那一帧只会写出
        // 「丢弃字符 0 · 历史消息 1」，占一行却什么都没说。不发比发废话好。
        const budgetPayload = assistantBudgetFramePayload({
          history,
          contextRefCount: compiled.refs.length,
        });
        if (budgetPayload) {
          await progress.emit(
            ONTOCODE_ASSISTANT_PROGRESS_FRAMES.budget,
            budgetPayload,
          );
        }

        const modelStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
          ordinal: 2,
          kind: "model_plan",
          input: {
            sourceMessageId: acceptance.sourceMessage.id,
            contextHash: compiled.contextHash,
            plannerContract: "ontocode-assistant-plan/v1",
            // How much history the model did NOT see, on the record. A budget
            // that reports nothing is a silent truncation by another name.
            historyCondensedMessages: history.condensedMessages,
            historyCondensedJobErrors: history.condensedJobErrors,
            historyRawChars: history.totalRawChars,
            historyDroppedChars: history.droppedChars,
          },
        });
        activeStepId = modelStep.id;
        const planner = await planOntoCodeAssistantTurn(
          {
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
            userText: input.text,
            contextRefs: effectiveContextRefs,
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
            jobs: history.jobs,
            messages: history.messages,
            readiness,
            toolCatalogStatus: toolCatalog.status,
            toolCatalog: toolCatalog.tools,
            artifactCounts,
            configurableSystems,
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
          },
          {
            // 计划器的帧同样只在事实之后发：provider 已返回、契约已校验、重整
            // 已经因为一次真实的解析失败而被决定。
            onProgress: (type, payload) => progress.emit(type, payload),
            // #ASSISTANT-INQUIRY —— 把这一轮已经解析好的**那一个**本体交给
            // 计划器，只读工具随之被广告给模型。查不查、查几次由大脑判断；
            // 本体没加载出来时这一项缺席，行为与改动前完全一致。
            ...(ontologyDigest.ontology
              ? { ontology: ontologyDigest.ontology }
              : {}),
          },
        );
        const modelPlan = planner.plan;
        // 计划解析成功——把模型自陈的判断理由摆出来。它此前被 100% 丢弃：既不
        // 进 step observation，也不进任何事件，而它正是 FDE 想看的「推理」。
        await progress.emit(
          ONTOCODE_ASSISTANT_PROGRESS_FRAMES.plan,
          assistantPlanFramePayload({ plan: modelPlan }),
        );
        const autonomyPlan = applyAssistantAutonomyPolicy(
          session.autonomyMode,
          modelPlan,
          input.text,
        );
        // 自主度裁决完成。「模型想执行、策略把它降成解释」此前在屏幕上完全
        // 看不出来——而策略什么都没改时，构造器返回 null：那一帧只能重复计划
        // 帧已经说过的话，多印一遍只会让真正被降级的那一次不再显眼。
        const policyPayload = assistantPolicyFramePayload({
          modelBehavior: modelPlan.behavior,
          modelAction:
            modelPlan.behavior === "execute" ? modelPlan.action : null,
          policyBehavior: autonomyPlan.behavior,
          policyAction:
            autonomyPlan.behavior === "execute" ? autonomyPlan.action : null,
          autonomyMode: session.autonomyMode,
        });
        if (policyPayload) {
          await progress.emit(
            ONTOCODE_ASSISTANT_PROGRESS_FRAMES.policy,
            policyPayload,
          );
        }

        // ── Configuration proposal ───────────────────────────────────────
        // `configure_integration` has no Harness executor and creates no
        // Command/Job. It resolves the target from the tenant's confirmed
        // System Profiles, reads only the DECLARED fields, and returns a
        // secret-free diff plus the exact confirmation that would authorize
        // it. Nothing is written on this turn.
        if (
          autonomyPlan.behavior === "execute" &&
          !isOntoCodeHarnessAssistantAction(autonomyPlan.action)
        ) {
          completeOntoCodeAssistantStep(ctx, modelStep.id, {
            behavior: modelPlan.behavior,
            action: autonomyPlan.action,
            policyBehavior: "explain",
            autonomyMode: session.autonomyMode,
            autonomyAdjusted: false,
            model: planner.model,
            confidence: modelPlan.confidence,
            recommendationCount: autonomyPlan.recommendations.length,
            redactedInputPaths: planner.redactedInputPaths,
          });
          const proposalStep = startOntoCodeAssistantStep(
            ctx,
            acceptance.run.id,
            {
              ordinal: 3,
              kind: "result_review",
              input: {
                operation: "configuration_proposal",
                action: autonomyPlan.action,
                sessionRevision: session.revision,
                sourceMessageId: acceptance.sourceMessage.id,
              },
            },
          );
          activeStepId = proposalStep.id;
          const outcome = await buildConfigurationProposal(
            {
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              sessionId: session.id,
              domain: project.domain,
              userText: input.text,
              ...(autonomyPlan.configuration?.system
                ? { requestedSystem: autonomyPlan.configuration.system }
                : {}),
              ...(autonomyPlan.configuration?.fieldKeys
                ? { requestedFieldKeys: autonomyPlan.configuration.fieldKeys }
                : {}),
            },
            defaultConfigurationPorts(),
          );
          completeOntoCodeAssistantStep(ctx, proposalStep.id, {
            schema: ONTOCODE_CONFIGURATION_PROPOSAL_SCHEMA,
            outcomeKind: outcome.kind,
            ...(outcome.kind === "proposal"
              ? {
                  proposal: outcome.proposal,
                  confirmations: outcome.confirmations,
                }
              : {}),
            ...(outcome.kind === "clarify"
              ? { clarifyCode: outcome.code }
              : {}),
            ...(outcome.kind === "secret_in_chat"
              ? {
                  refused: "secret_in_chat",
                  envRefs: outcome.envRefs,
                  fieldKeys: outcome.fieldKeys,
                }
              : {}),
          });
          const rendering: ConfigurationTurnRendering =
            renderConfigurationProposal(outcome);
          const proposalReceipt = OntoCodeTurnReceiptSchema.parse(
            createOntoCodeTurn(ctx, session.id, {
              text: input.text,
              behavior: outcome.kind === "clarify" ? "clarify" : "explain",
              arguments: {},
              affectedSemanticPaths: [],
              requestedCapabilities: [],
              idempotencyKey,
              assistantText: rendering.text,
              assistantRecommendations: assistantRecommendationRecords(
                rendering.recommendations,
              ),
              persistedRequestContent: {
                text: input.text,
                turn: {
                  behavior: "assistant",
                  contextRefs: input.contextRefs,
                },
              },
            }),
          );
          completeOntoCodeAssistantRun(ctx, acceptance.run.id, {
            model: planner.model,
            terminalResponse: proposalReceipt,
          });
          return reply.ok(
            proposalReceipt,
            proposalReceipt.mode === "created" ? 201 : 200,
          );
        }

        // An unfinished Build is a product interaction, not authority to start
        // a second Build. Bind the model's Build-kind reply to that stable
        // execution before considering the Scope -> Blueprint bootstrap.
        const continuationPlan = normalizeOntoCodeWaitingBuildContinuation(
          autonomyPlan,
          jobs,
        );
        const autopilotBuild = resolveOntoCodeAutopilotBuildStart({
          autonomyMode: session.autonomyMode,
          userText: input.text,
          ...(continuationPlan.behavior === "execute" &&
          isOntoCodeHarnessAssistantAction(continuationPlan.action)
            ? { plannerAction: continuationPlan.action }
            : {}),
          plannerBehavior: continuationPlan.behavior,
          pipelineId: acceptance.run.id,
          waitingBuildInteraction: hasWaitingOntoCodeBuildInteraction(jobs),
        });
        const normalizedPlan: OntoCodeAssistantPlan = autopilotBuild
          ? {
              ...continuationPlan,
              behavior: "execute",
              action: autopilotBuild.action,
              assistantText: /[\u3400-\u9fff]/u.test(input.text)
                ? ontoCodeAutopilotBuildStartText(true)
                : ontoCodeAutopilotBuildStartText(false),
              rationaleSummary: ontoCodeAutopilotBuildRationaleSummary(
                continuationPlan.rationaleSummary,
              ),
            }
          : continuationPlan;
        const plan = withoutImmediateExecutionRecommendation(normalizedPlan);
        completeOntoCodeAssistantStep(ctx, modelStep.id, {
          behavior: modelPlan.behavior,
          action: modelPlan.behavior === "execute" ? modelPlan.action : null,
          target: modelPlan.behavior === "navigate" ? modelPlan.target : null,
          policyBehavior: plan.behavior,
          autonomyMode: session.autonomyMode,
          autonomyAdjusted:
            modelPlan.behavior !== plan.behavior ||
            (modelPlan.behavior === "execute" &&
              plan.behavior === "execute" &&
              modelPlan.action !== plan.action) ||
            modelPlan.recommendations.length !== plan.recommendations.length,
          model: planner.model,
          confidence: modelPlan.confidence,
          recommendationCount: plan.recommendations.length,
          redactedInputPaths: planner.redactedInputPaths,
        });

        // Every server-owned (non-Harness) execute action already returned
        // above, so an execute plan here is always Command/Job backed. The
        // narrowing is explicit rather than assumed.
        const harnessAction =
          plan.behavior === "execute" &&
          isOntoCodeHarnessAssistantAction(plan.action)
            ? plan.action
            : null;
        const waitingJob = harnessAction
          ? jobs.find(
              (job) =>
                job.status === "waiting_user" &&
                job.kind === ONTOCODE_COMMAND_POLICY[harnessAction].jobKind,
            )
          : undefined;
        const turn: Parameters<typeof createOntoCodeTurn>[2] = {
          text: input.text,
          behavior: harnessAction ? "execute" : plan.behavior,
          ...(harnessAction ? { action: harnessAction } : {}),
          arguments: harnessAction
            ? {
                instruction: input.text,
                source: "ontocode-assistant",
                assistantPlanModel: planner.model,
                assistantPlanConfidence: plan.confidence,
                ...(autopilotBuild
                  ? {
                      scopeMode: autopilotBuild.pipeline.scopeMode,
                      autopilotBuildPipeline: autopilotBuild.pipeline,
                    }
                  : {}),
                ...(waitingJob
                  ? {
                      clarificationAnswer: input.text,
                      resumeWaitingUserJobId: waitingJob.id,
                    }
                  : {}),
              }
            : {},
          affectedSemanticPaths: harnessAction ? input.contextRefs : [],
          requestedCapabilities: [],
          idempotencyKey,
          assistantText: plan.assistantText,
          assistantRecommendations: plan.recommendations,
          assistantCitedRefs: plan.citedRefs,
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
        const contextError = normalizeOntoCodeContextCompilerError(error);
        // 失败也留下一行「大脑到底怎么了」。桥保证一轮只留一条——计划器已经在
        // 它自己那一层写过更精确的阶段时，这里不会再盖一遍。受理本身就失败时
        // 没有可挂的轨迹，HTTP 错误响应才是那一次的记录。
        if (assistantRunId) {
          await progress.emitBrainErrorOnce({
            errorMessage: assistantFailureSentence(error, contextError),
            phase: "这一轮对话",
          });
          try {
            failOntoCodeAssistantRun(ctx, assistantRunId, error, activeStepId);
          } catch {
            // Preserve the original error response. The run store is itself
            // tenant scoped and the API log will still capture an unexpected
            // secondary persistence failure.
          }
        }
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
            plannerErrorStatus(error.code),
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
      } finally {
        // 轮次收尾。丢弃为 0 时什么都不发；丢过帧就必须把真实条数说出来——
        // 一次沉默的截断和一段完整的轨迹在屏幕上长得一模一样。
        const closing = await progress.finish();
        if (!closing.reported) {
          // 连「丢了多少」都没写进去：帧通道本身坏了，桥没有第二条通道可用。
          // 说出来的地方可以换成服务端日志，说不说不能换。
          req.log.error(
            {
              assistantRunId,
              droppedProgressFrames: closing.dropped,
              sessionId: req.params.sessionId,
            },
            "ontocode assistant progress frames were dropped and the closing frame could not be written",
          );
        }
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
