import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  factoryConversations,
  factoryRuns,
  getDb,
  ontocodeCandidateHeads,
  ontocodeBuildExecutions,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeChangeSets,
  ontocodeCommands,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodePackageVersions,
  ontocodeSessionMessages,
  ontocodeSessionEvents,
  ontocodeSessions,
  tenants,
} from "@agentic/db";
import {
  applyFactoryGenerationOverlay,
  activeHumanInteraction,
  activeHumanInteractionKind,
  humanInteractionMatchesSubject,
  assertFactoryScopeRecommendationCurrent,
  blueprintIsGrounded,
  buildOntologyAnchorIndex,
  createFactoryGenerationDirective,
  factoryGenerationDirectiveFingerprint,
  factoryScopeRecommendationId,
  factoryGenerationGoal,
  factorySourceOntologyHash,
  generatedSpecExecutionOwnership,
  groundBlueprint,
  generatedToolPoliciesEqual,
  isGeneratedToolExecutionPolicy,
  ontologyContentHash,
  persistedToolAsRealTool,
  reasonBlueprintPhases,
  recommendFactoryActionScope,
  runWithLlmCallContext,
  sanitizeSensitiveInput,
  specsFingerprint,
  FactoryScopeRecommendationError,
  SandboxLifecycleBlockedError,
  type AgentDraft,
  type BrainEvent,
  type DomainOntology,
  type FactoryHumanInteractionKind,
  type FactoryGenerationDirective,
  type BlueprintReasoningFrame,
  type FactoryScopeInquiryBudget,
  type FactoryScopeReasoningFrame,
  type FactoryScopeRecommendation,
  type GeneratedAgentSpec,
  type GeneratedToolExecutionPolicy,
  type IntegrationCapabilityProvider,
  type RealTool,
  type SandboxDeployResult,
} from "@agentic/agent-factory";
import {
  ONTOCODE_COMMAND_POLICY,
  OntoCodeCandidateValidationV2Schema,
  OntoCodeChartSpecSchema,
  OntoCodeStructuredQuestionSchema,
  OntoCodeTableSpecSchema,
  resolveOntoCodeCommandBudget,
  resolveWallClockPolicy,
  type OntoCodeBuildSession,
  type OntoCodeCandidateBlocker,
  type OntoCodeChartSpec,
  type OntoCodeCommand,
  type OntoCodeHarnessJob,
  type OntoCodeHarnessJobKind,
  type OntoCodeProject,
  type OntoCodeTableSpec,
  type OntoCodePackageVersion,
  type OntoCodeExecutionOwner,
  type OntoCodeSessionActivity,
  type OntoCodeSessionPhase,
  type OntoCodeStructuredQuestion,
  type OntoCodeTurnAction,
} from "@agentic/contracts";
import { canonicalEvidenceJson } from "@agentic/shared";
import {
  redactHarnessTelemetryPayload,
  redactHarnessTelemetryText,
} from "./ontocode-telemetry-redaction";
import {
  assertOntoCodeOntologyBinding,
  getOntoCodeCommand,
  getOntoCodeHarnessJob,
  getOntoCodeProject,
  getOntoCodeSession,
} from "./ontocode-session-store";
import {
  computeOntoCodeCandidateDependencyRoot,
  computeOntoCodeTestSuiteHash,
} from "./ontocode-candidate-digest";
import {
  createOntoCodeConfigurationTask,
  listOntoCodeConfigurationTasks,
  verifyOntoCodeConfigurationTask,
} from "./ontocode-configuration-task-store";
import { analyzeOntology } from "./ontocode-ontology-analyst";
import {
  ONTOCODE_FAILURE_RECEIPT_SCHEMA,
  buildOntoCodeFailureReceipt,
  renderFailureReceiptGrounding,
  summarizeOntoCodeFailureReceipt,
} from "./ontocode-failure-receipt";
import {
  markOntoCodeCandidateReleased,
  preflightOntoCodeDeploy,
  summarizePreflight,
} from "./ontocode-deploy";
import { promoteDrafts } from "./agent-factory/promote";
import {
  completeOntoCodeSandboxAttempt,
  createOntoCodeSandboxAttempt,
  failOntoCodeSandboxAttempt,
} from "./ontocode-sandbox-attempt-store";
import { makeFactoryPorts } from "./agent-factory/index";
import {
  enqueueHumanMessage,
  type HumanMessageEnqueueResult,
} from "./agent-factory/mailbox";
import {
  abortRun,
  isActiveRun,
  startRun,
  subscribeRun,
} from "./agent-factory/run-registry";
import { getRun as getFactoryRun } from "./agent-factory/stores";
import { getRuntimeTenantRegistrySnapshot } from "./agent-factory/tenant-native-tool-provider";
import { assertRuntimeProfileVersionForTenant } from "./runtime-profile-store";
import {
  mayAutonomouslyContinueBuildPipeline,
  nextOntoCodeAutopilotBuildAction,
  readOntoCodeAutopilotBuildPipeline,
  type OntoCodeAutopilotBuildPipeline,
} from "./ontocode-autopilot-build-pipeline";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

const ACTIVE_JOB_STATUSES = ["leased", "running"] as const;
const PENDING_JOB_STATUSES = ["queued", "retry_scheduled"] as const;
const PRODUCTION_JOB_KINDS = new Set<OntoCodeHarnessJobKind>([
  "promotion",
  "deploy",
]);
const COMMAND_POLICIES = Object.values(ONTOCODE_COMMAND_POLICY);
/**
 * The scope stage's shared allowance — the server-owned policy budget, read
 * from ONE place so the loop, its reads and its final decision are all spent
 * out of the same counter the rest of the platform already publishes.
 */
const SCOPE_INQUIRY_BUDGET: FactoryScopeInquiryBudget = {
  maxModelCalls: ONTOCODE_COMMAND_POLICY.analyze_scope.budget.maxModelCalls,
  maxToolCalls: ONTOCODE_COMMAND_POLICY.analyze_scope.budget.maxToolCalls,
  maxWallClockMs: ONTOCODE_COMMAND_POLICY.analyze_scope.budget.maxWallClockMs,
};

/**
 * Bridge the scope recommender's frames onto the durable-progress contract.
 *
 * Deliberately MIRRORS the analysis path's vocabulary
 * (`harness.ontology_analysis.{tool_call,tool_result,reasoning_step,deliberation}`)
 * under the scope namespace, rather than inventing a third one: the FDE reads
 * both surfaces in the same session log.
 */
function bridgeScopeReasoningFrame(
  context: OntoCodeHarnessExecutionContext,
  frame: FactoryScopeReasoningFrame,
): Promise<void> {
  switch (frame.type) {
    case "tool_call":
      return context.progress("harness.scope.tool_call", {
        tool: frame.tool,
        reasoning: frame.reasoning,
        ...(frame.argsSummary ? { argsSummary: frame.argsSummary } : {}),
      });
    case "tool_result":
      return context.progress("harness.scope.tool_result", {
        tool: frame.tool,
        ok: frame.ok,
        summary: frame.summary,
        ...(frame.truncated ? { truncated: true } : {}),
      });
    case "reasoning_step":
      return context.progress("harness.scope.reasoning_step", {
        // Same frame name as the decision below — two moments of ONE reasoning
        // stream, told apart by `phase` rather than by a second vocabulary.
        phase: "turn",
        index: frame.index,
        total: frame.total,
        output: frame.output,
        // Real pre-cap length whenever the narration was cut — a clipped step
        // must never read as a short one.
        ...(frame.truncated
          ? { truncated: true, outputChars: frame.outputChars }
          : {}),
      });
    case "deliberation":
      return context.progress("harness.scope.deliberation", {
        status: frame.status,
        path: frame.path,
        detail: frame.detail,
        modelCalls: frame.modelCalls,
        toolCalls: frame.toolCalls,
        budget: frame.budget,
        ...(frame.exhausted ? { exhausted: frame.exhausted } : {}),
      });
  }
}
const COMMANDLESS_READ_ONLY_JOB_KINDS = new Set<OntoCodeHarnessJobKind>(
  COMMAND_POLICIES.filter((candidate) =>
    COMMAND_POLICIES.filter(
      (policy) => policy.jobKind === candidate.jobKind,
    ).every((policy) => policy.riskClass === "read_only"),
  ).map((policy) => policy.jobKind),
);
const EXACT_CANDIDATE_JOB_KINDS = new Set<OntoCodeHarnessJobKind>([
  "test",
  "regression",
]);

export interface OntoCodeHarnessClaim {
  jobId: string;
  tenantId: string;
  sessionId: string;
  leaseToken: number;
  recovered: boolean;
  previousStatus: OntoCodeHarnessJob["status"];
}

export interface OntoCodeHarnessExecutorResult {
  outcome: "succeeded" | "waiting_user";
  receipt: Record<string, unknown>;
  phase?: OntoCodeSessionPhase;
  message?: string;
  /**
   * Server-computed chart specs to attach to the completion assistant message
   * content (alongside `text`). Rows in every spec were computed by the server
   * from the authoritative Ontology — never model-authored numbers.
   */
  charts?: OntoCodeChartSpec[];
  /**
   * Server-derived table specs to attach to the completion assistant message
   * content (alongside `text` and `charts`). Columns and cells in every spec
   * were computed by the server from the authoritative Ontology — never
   * model-authored rows.
   */
  tables?: OntoCodeTableSpec[];
  /**
   * Optional pre-structured waiting question. When present and valid it is
   * used verbatim; otherwise the worker derives one from message + receipt.
   */
  question?: OntoCodeStructuredQuestion;
}

export interface OntoCodeHarnessExecutionContext {
  claim: OntoCodeHarnessClaim;
  job: OntoCodeHarnessJob;
  session: OntoCodeBuildSession;
  project: OntoCodeProject;
  command: OntoCodeCommand | null;
  tenantSlug: string;
  attempt: number;
  signal: AbortSignal;
  progress(
    type: string,
    payload: Record<string, unknown>,
    visibility?: "user" | "debug" | "audit",
  ): Promise<void>;
  latestReceipt(type: string): Promise<Record<string, unknown> | null>;
  /**
   * #FAILURE-RECEIPT — 本 Session 最近一次【终态失败】的持久回执（跨作业类型）。
   * 没有就是 null；调用方据此如实拒绝，绝不拿别的东西凑一个「原因」。
   */
  latestFailureReceipt(): Promise<Record<string, unknown> | null>;
}

interface OntoCodeHarnessLoadedContext {
  job: OntoCodeHarnessJob;
  session: OntoCodeBuildSession;
  project: OntoCodeProject;
  command: OntoCodeCommand | null;
  tenantSlug: string;
}

export type OntoCodeHarnessExecutor = (
  context: OntoCodeHarnessExecutionContext,
) => Promise<OntoCodeHarnessExecutorResult>;

export type OntoCodeHarnessExecutorRegistry = Partial<
  Record<OntoCodeHarnessJobKind, OntoCodeHarnessExecutor>
>;

export interface OntoCodeFactoryBuildInput {
  /** Stable product identity owned by OntoCode across Jobs and retries. */
  buildExecutionId?: string;
  /** Private generation-kernel binding. Never use as the product identity. */
  engineRunId?: string;
  jobId: string;
  attempt: number;
  operation: "build" | "test" | "debug" | "regression";
  tenantId: string;
  tenantSlug: string;
  domain: string;
  ontologyDomainRegistrationId: string | null;
  runtimeProfileVersionId: string | null;
  goal: string;
  actorId: string | null;
  interactionPolicy: "strict" | "autopilot";
  directive: FactoryGenerationDirective;
  budget: OntoCodeHarnessJob["budget"];
  /**
   * Persist the one-shot OntoCode answer envelope after the private engine has
   * durably accepted it. The callback is intentionally adapter-internal.
   */
  onAnswerDelivery?: (
    result: Extract<
      HumanMessageEnqueueResult,
      "queued" | "duplicate_interaction"
    >,
  ) => void;
  /**
   * Exact durable continuation of one previously parked Factory conversation.
   * This object is assembled only by the worker after it has checked the
   * waiting receipt, input-resolution audit link, immutable Ontology/runtime
   * pins, Factory run, and persisted conversation checkpoint.
   */
  resume?: {
    waitingJobId: string;
    factoryRunId: string;
    interactionId: string;
    /** `execution_readiness` is an OntoCode-owned follow-up turn, not a
     * private-engine human gate. The adapter deliberately routes it as an
     * ordinary same-conversation instruction instead of forging a clarify. */
    interactionKind: FactoryHumanInteractionKind | "execution_readiness";
    /** Durable user-message/command id used as the exactly-once continuation
     * marker for OntoCode-owned interactions. */
    answerId?: string;
    answer: string;
    persistGoal: string;
    capturedAgents: Array<{
      slug: string;
      actionName: string;
      name: string;
      card: Record<string, unknown>;
      design: Record<string, unknown> | null;
      generatedCode: string | null;
    }>;
  };
  /**
   * Re-attach after the Harness worker stopped while the detached Factory run
   * kept (or crash-resumed) the same durable conversation. Unlike `resume`,
   * this path never enqueues a human answer: any accepted answer is already in
   * the at-least-once mailbox and must be redelivered under its original id.
   */
  reconnect?: {
    mode: "reattach" | "restart_from_command";
    factoryRunId: string;
    persistGoal: string;
    capturedAgents: Array<{
      slug: string;
      actionName: string;
      name: string;
      card: Record<string, unknown>;
      design: Record<string, unknown> | null;
      generatedCode: string | null;
    }>;
  };
  signal: AbortSignal;
  /** `visibility` lets the high-volume reasoning/tool telemetry land as `debug`
   *  so the默认「只看关键」视图不被淹没, while「显示全部」still shows every turn. */
  onProgress(
    type: string,
    payload: Record<string, unknown>,
    visibility?: "user" | "debug" | "audit",
  ): Promise<void>;
}

export interface OntoCodeFactoryBuildResult {
  outcome: "succeeded" | "waiting_user";
  receipt: Record<string, unknown>;
  message?: string;
}

export interface OntoCodeFactoryCandidateTestInput {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  ontologyDomainRegistrationId: string | null;
  runtimeProfileVersionId: string | null;
  packageVersionId: string;
  dependencyRoot: string;
  specs: GeneratedAgentSpec[];
  testCases: OntoCodeHarnessJob["testCases"];
  signal: AbortSignal;
}

/**
 * Narrow adapter around the existing Agent Factory. It deliberately exposes
 * ontology reads, bounded scope recommendation, and sandbox generation only;
 * promotion/deployment are not part of this interface.
 */
export interface OntoCodeFactoryHarnessAdapter {
  fetchOntology(input: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    ontologyDomainRegistrationId: string | null;
  }): Promise<DomainOntology>;
  recommendScope(input: {
    ontology: DomainOntology;
    scenario: string;
    scopeKey: string;
    signal: AbortSignal;
    /** The job's shared allowance, read from ONTOCODE_COMMAND_POLICY by the
     * executor. Funds the read-only tool loop that makes this stage reason
     * instead of classifying a flattened prompt. */
    budget?: FactoryScopeInquiryBudget;
    /** Durable visibility for that reasoning, bridged onto `harness.scope.*`. */
    onFrame?: (frame: FactoryScopeReasoningFrame) => void | Promise<void>;
  }): Promise<FactoryScopeRecommendation>;
  runBuild(
    input: OntoCodeFactoryBuildInput,
  ): Promise<OntoCodeFactoryBuildResult>;
  /**
   * Exact Candidate verification is deliberately separate from runBuild:
   * this method may execute the supplied immutable specs but may not generate,
   * refine, or persist a replacement Candidate.
   */
  runCandidateTest?(
    input: OntoCodeFactoryCandidateTestInput,
  ): Promise<SandboxDeployResult>;
  /**
   * Live rule bindings for one Action, straight from the bound source. Optional
   * because not every source can serve them — and the Analyst reports "could not
   * check" rather than "no rules" when it is absent.
   */
  fetchActionRules?(input: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    ontologyDomainRegistrationId: string | null;
    actionName: string;
  }): Promise<unknown[]>;
  /**
   * Optional real-data sampling surface for Analyst. The bound ontology source
   * owns transport selection; uploaded/manifest-only sources report unsupported.
   */
  listInstances?(input: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    ontologyDomainRegistrationId: string | null;
    objectType: string;
    limit: number;
  }): Promise<{
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  }>;
  /**
   * #TOOL-REQ — the same tool catalogue and matching inputs Build uses, read at
   * analysis time. This is what lets the Analyst answer "which tools does this
   * Action need, do we have them, which ones, what is missing" BEFORE the FDE
   * commits to a Build, instead of discovering it mid-generation.
   *
   * Optional so a stubbed adapter degrades to "we did not check" — never to
   * "there is nothing missing".
   */
  listExecutionResources?(input: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    ontologyDomainRegistrationId: string | null;
  }): Promise<{
    tools: RealTool[];
    capabilityProviders: IntegrationCapabilityProvider[];
    systemAliasGroups: string[][];
  }>;
}

export interface OntoCodeHarnessWorkerOptions {
  executors?: OntoCodeHarnessExecutorRegistry;
  factory?: OntoCodeFactoryHarnessAdapter;
  /**
   * Stops a Factory run only after a waiting-user Harness receipt has been
   * committed. Injectable so the persistence/cleanup ordering is testable.
   */
  stopFactoryRun?: (runId: string, tenantId: string) => boolean;
  tenantId?: string;
  leaseTimeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface OntoCodeHarnessRunResult {
  claimed: boolean;
  jobId?: string;
  status?: OntoCodeHarnessJob["status"] | "lost_lease";
}

export class OntoCodeHarnessExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      recoverable: boolean;
      retryable: boolean;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "OntoCodeHarnessExecutionError";
  }
}

export class OntoCodeHarnessLostLeaseError extends Error {
  constructor(readonly jobId: string) {
    super(`OntoCode harness job ${jobId} no longer belongs to this worker`);
    this.name = "OntoCodeHarnessLostLeaseError";
  }
}

interface NormalizedExecutionFailure {
  code: string;
  message: string;
  recoverable: boolean;
  retryable: boolean;
  details?: Record<string, unknown>;
}

function makeWorkerEventId(): string {
  return `oce-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function makeWorkerMessageId(): string {
  return `ocm-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function appendAssistantMessage(
  db: DbLike,
  input: {
    tenantId: string;
    sessionId: string;
    jobId: string;
    commandId: string | null;
    leaseToken: number;
    type: "receipt" | "recommendation" | "error";
    text: string;
    content: Record<string, unknown>;
  },
  now: Date,
): void {
  const idempotencyKey = `worker:${input.jobId}:${input.leaseToken}:${input.type}`;
  const existing = db
    .select({ id: ontocodeSessionMessages.id })
    .from(ontocodeSessionMessages)
    .where(
      and(
        eq(ontocodeSessionMessages.tenantId, input.tenantId),
        eq(ontocodeSessionMessages.sessionId, input.sessionId),
        eq(ontocodeSessionMessages.idempotencyKey, idempotencyKey),
      ),
    )
    .get();
  if (existing) return;
  db.insert(ontocodeSessionMessages)
    .values({
      id: makeWorkerMessageId(),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      role: "assistant",
      type: input.type,
      contentJson: canonicalEvidenceJson({
        text: input.text,
        jobId: input.jobId,
        // Explicit consumer handoff key: the durable completion message names
        // the exact Harness job whose streamed frames it finalizes, so the
        // live-stream → durable-message switch needs no heuristics.
        harnessJobId: input.jobId,
        ...input.content,
      }),
      idempotencyKey,
      commandId: input.commandId,
      correlationId: `ocw-${input.jobId}`,
      createdAt: now,
    })
    .run();
}

function completedAssistantText(
  kind: OntoCodeHarnessJobKind,
  explicitMessage: string | undefined,
): string {
  if (explicitMessage?.trim()) {
    return productFacingOntoCodeText(explicitMessage);
  }
  const labels: Record<OntoCodeHarnessJobKind, string> = {
    ontology_analysis:
      "Ontology 分析已完成：已读取真实关系图并给出可核查的结论。可在右侧「产物」查看。",
    scope:
      "Ontology 范围分析已完成。你可以检查推荐范围，然后继续生成 Blueprint。",
    blueprint:
      "Agent Blueprint 已生成并绑定当前 Ontology snapshot。你可以审查职责与依赖后开始构建。",
    build: "Agent Package 已完成真实构建，生成结果和 OntoCode 回执已保存。",
    simulation: "Simulation 已完成，结果已写入本 Session 的证据记录。",
    test: "测试执行已完成。请在 Tests 与 Evidence 中检查结果。",
    debug: "调试迭代已完成，修复结果和验证回执已保存。",
    regression: "候选版本回归比较已完成。请检查发布门禁证据。",
    promotion: "候选版本准备已完成，仍需按发布策略完成审批。",
    deploy: "发布执行已完成，部署回执已保存。",
    production_analysis: "生产证据分析已完成。",
  };
  return labels[kind];
}

/**
 * Keep implementation-engine vocabulary out of the OntoCode conversation.
 * Match only the private ASCII tokens: normalizing the whole sentence with
 * NFKC would also rewrite user-authored Chinese punctuation such as （），：？.
 */
function productFacingOntoCodeText(value: string): string {
  return value
    .trim()
    .replace(/\bOntoCode Harness\b/gi, "OntoCode")
    .replace(/\bAgent Factory\b/gi, "OntoCode 内部生成引擎")
    .replace(/\bFactory\b/gi, "内部生成引擎")
    .replace(/\bHarness\b/gi, "OntoCode")
    .replace(/\bfactory_/gi, "ontocode_engine_");
}

function productFacingOntoCodePayload(value: unknown): unknown {
  if (typeof value === "string") return productFacingOntoCodeText(value);
  if (Array.isArray(value)) return value.map(productFacingOntoCodePayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      productFacingOntoCodePayload(child),
    ]),
  );
}

/**
 * #FAILURE-RECEIPT — 失败消息正文。第一行仍然是终态错误原文（旧行为不变），第二行把回执里
 * 那条【已核对过的】证据口径带上：读到了什么、或者为什么读不到。两行都来自已记录事实。
 */
function failedAssistantText(
  kind: OntoCodeHarnessJobKind,
  message: string,
  receipt: Record<string, unknown> | null,
): string {
  const labels: Record<OntoCodeHarnessJobKind, string> = {
    ontology_analysis: "Ontology 分析",
    scope: "范围分析",
    blueprint: "蓝图生成",
    build: "代码生成",
    simulation: "模拟",
    test: "测试",
    debug: "调试",
    regression: "回归验证",
    promotion: "候选发布准备",
    deploy: "部署",
    production_analysis: "生产证据分析",
  };
  const head = `OntoCode 无法完成${labels[kind]}：${message}`;
  const summary = receipt ? summarizeOntoCodeFailureReceipt(receipt) : null;
  return productFacingOntoCodeText(summary ? `${head}\n${summary}` : head);
}

type AutopilotBuildContinuation =
  | {
      state: "queued";
      created: boolean;
      pipeline: OntoCodeAutopilotBuildPipeline;
      action: "propose_blueprint" | "generate_package";
      commandId: string;
      jobId: string;
      jobKind: "blueprint" | "build";
    }
  | {
      state: "blocked";
      pipeline: OntoCodeAutopilotBuildPipeline;
      action: "propose_blueprint" | "generate_package";
      conflictingJobIds: string[];
    };

/**
 * Persist the next safe stage in the same transaction that commits the current
 * success. A crash therefore leaves either both the completed stage and its
 * continuation, or neither. Deterministic idempotency keys make lease recovery
 * attach to the same Command/Job instead of duplicating a stage.
 */
function prepareAutopilotBuildContinuation(
  tx: Transaction,
  claim: OntoCodeHarnessClaim,
  data: OntoCodeHarnessLoadedContext,
  result: OntoCodeHarnessExecutorResult,
  now: Date,
): AutopilotBuildContinuation | null {
  const pipeline = readOntoCodeAutopilotBuildPipeline(
    data.command?.arguments.autopilotBuildPipeline,
  );
  if (!pipeline || !data.command) return null;
  const nextAction = nextOntoCodeAutopilotBuildAction(data.command.type);
  if (
    !nextAction ||
    !mayAutonomouslyContinueBuildPipeline(data.session.autonomyMode, nextAction)
  ) {
    return null;
  }
  const nextPolicy = ONTOCODE_COMMAND_POLICY[nextAction];
  const pipelineDigest = createHash("sha256")
    .update(pipeline.pipelineId)
    .digest("hex");
  const commandIdempotencyKey = `autopilot-build:${pipelineDigest}:${nextAction}:command`;
  const jobIdempotencyKey = `autopilot-build:${pipelineDigest}:${nextAction}:job`;
  const existingCommand = tx
    .select({ id: ontocodeCommands.id })
    .from(ontocodeCommands)
    .where(
      and(
        eq(ontocodeCommands.tenantId, claim.tenantId),
        eq(ontocodeCommands.sessionId, claim.sessionId),
        eq(ontocodeCommands.idempotencyKey, commandIdempotencyKey),
      ),
    )
    .get();
  const existingJob = tx
    .select({ id: ontocodeHarnessJobs.id })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
        eq(ontocodeHarnessJobs.sessionId, claim.sessionId),
        eq(ontocodeHarnessJobs.idempotencyKey, jobIdempotencyKey),
      ),
    )
    .get();
  if (existingCommand && existingJob) {
    return {
      state: "queued",
      created: false,
      pipeline,
      action: nextAction,
      commandId: existingCommand.id,
      jobId: existingJob.id,
      jobKind: nextPolicy.jobKind as "blueprint" | "build",
    };
  }
  if (existingCommand || existingJob) {
    return {
      state: "blocked",
      pipeline,
      action: nextAction,
      conflictingJobIds: [...(existingJob ? [existingJob.id] : [])],
    };
  }

  const conflictingJobs = tx
    .select({ id: ontocodeHarnessJobs.id })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
        eq(ontocodeHarnessJobs.sessionId, claim.sessionId),
        ne(ontocodeHarnessJobs.id, claim.jobId),
        inArray(ontocodeHarnessJobs.status, [
          ...ACTIVE_JOB_STATUSES,
          ...PENDING_JOB_STATUSES,
        ]),
      ),
    )
    .all();
  if (conflictingJobs.length > 0) {
    return {
      state: "blocked",
      pipeline,
      action: nextAction,
      conflictingJobIds: conflictingJobs.map((job) => job.id),
    };
  }

  const sessionRow = tx
    .select({ revision: ontocodeSessions.revision })
    .from(ontocodeSessions)
    .where(
      and(
        eq(ontocodeSessions.tenantId, claim.tenantId),
        eq(ontocodeSessions.id, claim.sessionId),
      ),
    )
    .get();
  if (!sessionRow) return null;
  const commandId = `occ-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const jobId = `ocj-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const ontologyHash =
    nonEmptyString(result.receipt.ontologyHash) ??
    data.session.ontologySnapshotHash;
  const scopeReceipt =
    asRecord(result.receipt.scope) ?? asRecord(result.receipt.recommendation);
  const authoritativeActionCount = stringList(scopeReceipt?.actionIds).length;
  const commandArguments = {
    instruction:
      nextAction === "propose_blueprint"
        ? "Continue the explicit full Build pipeline from its completed Scope."
        : "Continue the explicit full Build pipeline from its completed Blueprint.",
    source: "ontocode-autopilot-continuation",
    scopeMode: pipeline.scopeMode,
    autopilotBuildPipeline: pipeline,
  };
  const budget = resolveOntoCodeCommandBudget(
    nextAction,
    commandArguments,
    authoritativeActionCount > 0 ? { authoritativeActionCount } : undefined,
  );

  tx.insert(ontocodeCommands)
    .values({
      id: commandId,
      tenantId: claim.tenantId,
      sessionId: claim.sessionId,
      type: nextPolicy.commandType,
      argumentsJson: canonicalEvidenceJson(commandArguments),
      expectedSessionRevision: sessionRow.revision,
      baseOntologyHash: ontologyHash,
      basePackageVersionId: data.session.basePackageVersionId ?? null,
      affectedSemanticPathsJson: "[]",
      requestedCapabilitiesJson: "[]",
      riskClass: nextPolicy.riskClass,
      status: "queued",
      requiresHuman: false,
      rationaleSummary: `Autonomous full Build continuation after successful ${data.job.kind}`,
      idempotencyKey: commandIdempotencyKey,
      createdBy: data.command.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  tx.insert(ontocodeHarnessJobs)
    .values({
      id: jobId,
      tenantId: claim.tenantId,
      sessionId: claim.sessionId,
      commandId,
      runtimeProfileVersionId: data.job.runtimeProfileVersionId ?? null,
      kind: nextPolicy.jobKind,
      status: "queued",
      idempotencyKey: jobIdempotencyKey,
      inputHash: null,
      budgetJson: canonicalEvidenceJson(budget),
      candidatePackageVersionId: null,
      candidateDependencyRoot: null,
      candidateHeadId: null,
      candidateHeadRevision: null,
      testCasesJson: "[]",
      errorMessage: null,
      createdBy: data.command.createdBy,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    })
    .run();
  return {
    state: "queued",
    created: true,
    pipeline,
    action: nextAction,
    commandId,
    jobId,
    jobKind: nextPolicy.jobKind as "blueprint" | "build",
  };
}

function appendAutopilotBuildContinuation(
  tx: Transaction,
  claim: OntoCodeHarnessClaim,
  data: OntoCodeHarnessLoadedContext,
  continuation: AutopilotBuildContinuation,
  now: Date,
): void {
  if (continuation.state === "blocked") {
    appendWorkerEvent(
      tx,
      {
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        jobId: claim.jobId,
        commandId: data.command?.id ?? null,
        type: "harness.autopilot.continuation.blocked",
        payload: {
          pipelineId: continuation.pipeline.pipelineId,
          nextAction: continuation.action,
          conflictingJobIds: continuation.conflictingJobIds,
          reason: "another live or partially persisted job requires review",
        },
        causationId: `${claim.jobId}:${claim.leaseToken}:autopilot-blocked`,
      },
      now,
    );
    appendAssistantMessage(
      tx,
      {
        tenantId: claim.tenantId,
        sessionId: claim.sessionId,
        jobId: claim.jobId,
        commandId: data.command?.id ?? null,
        leaseToken: claim.leaseToken,
        type: "recommendation",
        text: `自主 Build 已在 ${data.job.kind} 后安全暂停：检测到其它活动 Job，未自动创建 ${continuation.action}。`,
        content: {
          status: "autopilot_continuation_blocked",
          pipelineId: continuation.pipeline.pipelineId,
          nextAction: continuation.action,
          conflictingJobIds: continuation.conflictingJobIds,
        },
      },
      now,
    );
    return;
  }
  if (!continuation.created) return;
  appendWorkerEvent(
    tx,
    {
      tenantId: claim.tenantId,
      projectId: data.project.id,
      sessionId: claim.sessionId,
      jobId: continuation.jobId,
      commandId: continuation.commandId,
      type: "ai.plan.proposed",
      payload: {
        pipelineId: continuation.pipeline.pipelineId,
        sourceHarnessJobId: claim.jobId,
        commandId: continuation.commandId,
        action: continuation.action,
        policyDerived: true,
        autonomousContinuation: true,
      },
      causationId: `${claim.jobId}:${claim.leaseToken}:autopilot-command`,
    },
    now,
  );
  appendWorkerEvent(
    tx,
    {
      tenantId: claim.tenantId,
      projectId: data.project.id,
      sessionId: claim.sessionId,
      jobId: continuation.jobId,
      commandId: continuation.commandId,
      type: "harness.job.queued",
      payload: {
        jobId: continuation.jobId,
        kind: continuation.jobKind,
        pipelineId: continuation.pipeline.pipelineId,
        sourceHarnessJobId: claim.jobId,
        policyDerived: true,
        autonomousContinuation: true,
      },
      causationId: continuation.commandId,
    },
    now,
  );
  appendWorkerEvent(
    tx,
    {
      tenantId: claim.tenantId,
      projectId: data.project.id,
      sessionId: claim.sessionId,
      jobId: continuation.jobId,
      commandId: continuation.commandId,
      type: "harness.autopilot.continuation.queued",
      payload: {
        pipelineId: continuation.pipeline.pipelineId,
        sourceHarnessJobId: claim.jobId,
        nextAction: continuation.action,
        commandId: continuation.commandId,
        jobId: continuation.jobId,
      },
      causationId: `${claim.jobId}:${claim.leaseToken}:autopilot-next`,
    },
    now,
  );
  appendAssistantMessage(
    tx,
    {
      tenantId: claim.tenantId,
      sessionId: claim.sessionId,
      jobId: continuation.jobId,
      commandId: continuation.commandId,
      leaseToken: claim.leaseToken,
      type: "recommendation",
      text:
        continuation.action === "propose_blueprint"
          ? "Scope 已完成；自主 Build 已创建独立 Blueprint Command/Job 并入队。"
          : "Blueprint 已完成；自主 Build 已创建独立 Package Build Command/Job 并入队。测试、比较与发布不会自动执行。",
      content: {
        status: "autopilot_continuation_queued",
        pipelineId: continuation.pipeline.pipelineId,
        sourceHarnessJobId: claim.jobId,
        nextAction: continuation.action,
      },
    },
    now,
  );
}

type HarnessEvidenceOutcome =
  | "passed"
  | "failed"
  | "inconclusive"
  | "informational";

interface PersistedHarnessArtifactRef {
  artifactId: string;
  artifactVersionId: string;
  logicalName: string;
  kind: string;
  version: number;
  blobHash: string;
}

interface PersistedHarnessResult {
  artifacts: PersistedHarnessArtifactRef[];
  evidenceId: string;
  evidenceOutcome: HarnessEvidenceOutcome;
  changeSetId: string | null;
  candidatePackageVersionId: string | null;
  candidateDependencyRoot: string | null;
  candidateHeadId: string | null;
  candidateHeadRevision: number | null;
  deliveryState: "candidate_ready" | null;
}

interface HarnessArtifactInput {
  logicalName: string;
  kind: string;
  semanticPath: string;
  content: string;
  contentType: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

function makeWorkerStorageId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifactSegment(value: string): string {
  const source = value.normalize("NFKC").trim();
  const safe = source
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  const base = safe || "agent";
  return base === source ? base : `${base}-${sha256Text(source).slice(0, 8)}`;
}

function latestCommandChangeSetId(
  tx: Transaction,
  data: OntoCodeHarnessLoadedContext,
): string | null {
  if (!data.command) return null;
  return (
    tx
      .select({ id: ontocodeChangeSets.id })
      .from(ontocodeChangeSets)
      .where(
        and(
          eq(ontocodeChangeSets.tenantId, data.job.tenantId),
          eq(ontocodeChangeSets.sessionId, data.job.sessionId),
          eq(ontocodeChangeSets.commandId, data.command.id),
        ),
      )
      .orderBy(desc(ontocodeChangeSets.updatedAt), desc(ontocodeChangeSets.id))
      .limit(1)
      .get()?.id ?? null
  );
}

function ensureHarnessBlob(
  tx: Transaction,
  tenantId: string,
  content: string,
  now: Date,
): typeof ontocodeArtifactBlobs.$inferSelect {
  const sha256 = sha256Text(content);
  const existing = tx
    .select()
    .from(ontocodeArtifactBlobs)
    .where(
      and(
        eq(ontocodeArtifactBlobs.tenantId, tenantId),
        eq(ontocodeArtifactBlobs.sha256, sha256),
      ),
    )
    .get();
  if (existing) {
    if (existing.contentText !== content) {
      throw new OntoCodeHarnessExecutionError(
        "artifact_hash_collision",
        "A content-addressed OntoCode artifact blob did not match its SHA-256",
        { recoverable: false, retryable: false, details: { sha256 } },
      );
    }
    return existing;
  }
  const row: typeof ontocodeArtifactBlobs.$inferInsert = {
    id: makeWorkerStorageId("ocb"),
    tenantId,
    sha256,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    contentText: content,
    createdAt: now,
  };
  tx.insert(ontocodeArtifactBlobs).values(row).run();
  return row as typeof ontocodeArtifactBlobs.$inferSelect;
}

function persistHarnessArtifactVersion(
  tx: Transaction,
  claim: OntoCodeHarnessClaim,
  data: OntoCodeHarnessLoadedContext,
  changeSetId: string | null,
  input: HarnessArtifactInput,
  now: Date,
): PersistedHarnessArtifactRef {
  if (input.content.length > 2_000_000) {
    throw new OntoCodeHarnessExecutionError(
      "harness_artifact_too_large",
      `Harness artifact ${input.logicalName} exceeds the 2,000,000-character product limit`,
      {
        recoverable: true,
        retryable: false,
        details: {
          logicalName: input.logicalName,
          characterCount: input.content.length,
        },
      },
    );
  }
  const existingVersion = tx
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      and(
        eq(ontocodeArtifactVersions.tenantId, claim.tenantId),
        eq(ontocodeArtifactVersions.sessionId, claim.sessionId),
        eq(ontocodeArtifactVersions.idempotencyKey, input.idempotencyKey),
      ),
    )
    .get();
  if (existingVersion) {
    const artifact = tx
      .select()
      .from(ontocodeArtifacts)
      .where(
        and(
          eq(ontocodeArtifacts.tenantId, claim.tenantId),
          eq(ontocodeArtifacts.id, existingVersion.artifactId),
        ),
      )
      .get();
    if (
      !artifact ||
      artifact.sessionId !== claim.sessionId ||
      artifact.logicalName !== input.logicalName ||
      existingVersion.blobHash !== sha256Text(input.content)
    ) {
      throw new OntoCodeHarnessExecutionError(
        "artifact_idempotency_conflict",
        "A Harness artifact idempotency key was already used for different content",
        {
          recoverable: false,
          retryable: false,
          details: { idempotencyKey: input.idempotencyKey },
        },
      );
    }
    return {
      artifactId: artifact.id,
      artifactVersionId: existingVersion.id,
      logicalName: artifact.logicalName,
      kind: artifact.kind,
      version: existingVersion.version,
      blobHash: existingVersion.blobHash,
    };
  }

  let artifact = tx
    .select()
    .from(ontocodeArtifacts)
    .where(
      and(
        eq(ontocodeArtifacts.tenantId, claim.tenantId),
        eq(ontocodeArtifacts.sessionId, claim.sessionId),
        eq(ontocodeArtifacts.logicalName, input.logicalName),
      ),
    )
    .get();
  const created = !artifact;
  if (!artifact) {
    const row: typeof ontocodeArtifacts.$inferInsert = {
      id: makeWorkerStorageId("oca"),
      tenantId: claim.tenantId,
      projectId: data.project.id,
      sessionId: claim.sessionId,
      logicalName: input.logicalName,
      kind: input.kind,
      semanticPath: input.semanticPath,
      createdBy: data.job.createdBy,
      createdAt: now,
    };
    tx.insert(ontocodeArtifacts).values(row).run();
    artifact = row as typeof ontocodeArtifacts.$inferSelect;
  } else if (
    artifact.kind !== input.kind ||
    artifact.semanticPath !== input.semanticPath
  ) {
    throw new OntoCodeHarnessExecutionError(
      "artifact_logical_name_conflict",
      `Artifact ${input.logicalName} already represents a different semantic artifact`,
      {
        recoverable: false,
        retryable: false,
        details: { artifactId: artifact.id },
      },
    );
  }

  const previous = tx
    .select({ version: ontocodeArtifactVersions.version })
    .from(ontocodeArtifactVersions)
    .where(
      and(
        eq(ontocodeArtifactVersions.tenantId, claim.tenantId),
        eq(ontocodeArtifactVersions.artifactId, artifact.id),
      ),
    )
    .orderBy(desc(ontocodeArtifactVersions.version))
    .limit(1)
    .get();
  const blob = ensureHarnessBlob(tx, claim.tenantId, input.content, now);
  const version = (previous?.version ?? 0) + 1;
  const versionId = makeWorkerStorageId("ocav");
  tx.insert(ontocodeArtifactVersions)
    .values({
      id: versionId,
      tenantId: claim.tenantId,
      artifactId: artifact.id,
      sessionId: claim.sessionId,
      changeSetId,
      blobId: blob.id,
      version,
      blobHash: blob.sha256,
      contentType: input.contentType,
      sizeBytes: blob.sizeBytes,
      metadataJson: canonicalEvidenceJson(input.metadata),
      idempotencyKey: input.idempotencyKey,
      createdBy: data.job.createdBy,
      createdAt: now,
    })
    .run();
  appendWorkerEvent(
    tx,
    {
      tenantId: claim.tenantId,
      projectId: data.project.id,
      sessionId: claim.sessionId,
      jobId: claim.jobId,
      commandId: data.command?.id ?? null,
      type: created ? "artifact.created" : "artifact.version.created",
      payload: {
        artifactId: artifact.id,
        artifactVersionId: versionId,
        logicalName: input.logicalName,
        kind: input.kind,
        version,
        blobHash: blob.sha256,
        changeSetId,
      },
      // The evidence chain's own seam. This was `audit`, a tier gated on the
      // admin-only `audit.read`, so the row that says WHERE a receipt landed was
      // unreadable by the FDE the receipt exists for. It is workspace content,
      // not audit material — lease/recovery bookkeeping below stays `audit`.
      visibility: "debug",
      causationId: versionId,
    },
    now,
  );
  return {
    artifactId: artifact.id,
    artifactVersionId: versionId,
    logicalName: input.logicalName,
    kind: input.kind,
    version,
    blobHash: blob.sha256,
  };
}

function verificationOutcome(
  kind: OntoCodeHarnessJobKind,
  receipt: Record<string, unknown>,
): HarnessEvidenceOutcome {
  if (!["simulation", "test", "debug", "regression"].includes(kind)) {
    return "informational";
  }
  const sandbox = asRecord(receipt.sandbox);
  const verdicts = asRecord(sandbox?.caseVerdicts);
  return typeof verdicts?.allPass === "boolean"
    ? verdicts.allPass
      ? "passed"
      : "failed"
    : "inconclusive";
}

function harnessAgentArtifacts(
  result: OntoCodeHarnessExecutorResult,
  jobId: string,
  kind: OntoCodeHarnessJobKind,
): HarnessArtifactInput[] {
  // Verification and diagnosis consume an immutable Candidate. They may emit
  // receipts or patch proposals, but must never create unheaded Agent
  // Artifact Versions as a side effect of "testing".
  if (kind !== "build") return [];
  // A paused Factory turn may have emitted partial Agent frames. They remain in
  // the immutable receipt, but only a complete, contract-safe
  // generated-unverified checkpoint may cross into candidate_ready.
  if (
    result.outcome !== "succeeded" &&
    !generatedUnverifiedCandidateIsSafe(result)
  ) {
    return [];
  }
  if (!Array.isArray(result.receipt.agents)) return [];
  const artifacts: HarnessArtifactInput[] = [];
  for (const rawAgent of result.receipt.agents) {
    const agent = asRecord(rawAgent);
    if (!agent) continue;
    const spec = asRecord(agent.spec) ?? agent;
    const card = asRecord(agent.card);
    const design = asRecord(agent.design);
    const slug =
      nonEmptyString(spec.slug) ??
      nonEmptyString(card?.slug) ??
      nonEmptyString(agent.slug);
    if (!slug) continue;
    const segment = artifactSegment(slug);
    const code =
      nonEmptySourceText(spec.generatedCode) ??
      nonEmptySourceText(agent.generatedCode) ??
      nonEmptySourceText(design?.code);
    const metadata = {
      jobId,
      kind,
      slug,
      actionName:
        nonEmptyString(spec.actionName) ??
        nonEmptyString(card?.actionName) ??
        null,
      factoryRunId: nonEmptyString(result.receipt.factoryRunId),
      ontologyHash: nonEmptyString(result.receipt.ontologyHash),
      draftVersionId: nonEmptyString(agent.draftVersionId),
    };
    artifacts.push({
      logicalName: `agents/${segment}/spec.json`,
      kind: "agent_spec",
      semanticPath: `/agents/${slug}`,
      content: canonicalEvidenceJson(spec),
      contentType: "application/json",
      metadata,
      idempotencyKey: `worker:${jobId}:agent-spec:${segment}`,
    });
    if (code) {
      artifacts.push({
        logicalName: `agents/${segment}/agent.ts`,
        kind: "agent_code",
        semanticPath: `/agents/${slug}/generatedCode`,
        content: code,
        contentType: "text/typescript",
        metadata: {
          ...metadata,
          codeSha256: sha256Text(code),
        },
        idempotencyKey: `worker:${jobId}:agent-code:${segment}`,
      });
    }
  }
  return artifacts;
}

/**
 * Persist code authored before an external execution dependency became ready
 * as an explicitly non-candidate review artifact when it cannot satisfy the
 * authoring-safe Candidate boundary. A complete checkpoint with exact tool
 * contracts may instead cross into `candidate_ready`; incomplete or unsafe
 * output remains visible to the FDE without acquiring Candidate, test, or
 * promotion semantics.
 */
function harnessGeneratedUnverifiedDraftArtifacts(
  result: OntoCodeHarnessExecutorResult,
  jobId: string,
  kind: OntoCodeHarnessJobKind,
): HarnessArtifactInput[] {
  if (kind !== "build" || result.outcome !== "waiting_user") return [];
  if (generatedUnverifiedCandidateIsSafe(result)) return [];
  if (result.receipt.verificationState !== "generated_unverified") return [];
  const checkpoint = asRecord(result.receipt.draftCheckpoint);
  const readiness = asRecord(checkpoint?.executionReadiness);
  const durableAgents = Array.isArray(result.receipt.agents)
    ? result.receipt.agents
    : [];
  const nonCandidatePreviews = Array.isArray(result.receipt.agentPreviews)
    ? result.receipt.agentPreviews
    : [];
  const sourceAgents =
    durableAgents.length > 0 ? durableAgents : nonCandidatePreviews;
  const persisted =
    typeof checkpoint?.persisted === "number" &&
    Number.isSafeInteger(checkpoint.persisted) &&
    checkpoint.persisted > 0
      ? checkpoint.persisted
      : 0;
  if (
    (checkpoint?.schema !== "agent-factory-draft-checkpoint/v1" &&
      checkpoint?.schema !== "agent-factory-draft-checkpoint/v2") ||
    persisted === 0 ||
    readiness?.state !== "generated_unverified" ||
    readiness.sandboxEvidence !== "not_run" ||
    sourceAgents.length === 0
  ) {
    return [];
  }

  const coveredAgents = new Set(stringList(checkpoint.coveredAgents));
  const unverifiedApis = Array.isArray(readiness.unverifiedApis)
    ? readiness.unverifiedApis
    : [];
  const artifacts: HarnessArtifactInput[] = [];
  for (const rawAgent of sourceAgents) {
    if (artifacts.length >= persisted) break;
    const agent = asRecord(rawAgent);
    if (!agent) continue;
    const spec = asRecord(agent.spec) ?? asRecord(agent.card) ?? agent;
    const card = asRecord(agent.card);
    const design = asRecord(agent.design);
    const slug =
      nonEmptyString(spec.slug) ??
      nonEmptyString(card?.slug) ??
      nonEmptyString(agent.slug);
    const actionName =
      nonEmptyString(spec.actionName) ??
      nonEmptyString(card?.actionName) ??
      nonEmptyString(agent.actionName);
    if (!slug || !actionName || !coveredAgents.has(actionName)) continue;
    const code =
      nonEmptySourceText(spec.generatedCode) ??
      nonEmptySourceText(agent.generatedCode) ??
      nonEmptySourceText(design?.code);
    if (!code) continue;

    const segment = artifactSegment(slug);
    const agentReadiness =
      asRecord(spec.executionReadiness) ??
      asRecord(design?.executionReadiness) ??
      null;
    artifacts.push({
      logicalName: `drafts/agents/${segment}/agent.ts`,
      kind: "agent_code_draft",
      semanticPath: `/drafts/agents/${slug}/generatedCode`,
      content: code,
      contentType: "text/typescript",
      metadata: {
        jobId,
        kind,
        slug,
        actionName,
        factoryRunId: nonEmptyString(result.receipt.factoryRunId),
        ontologyHash: nonEmptyString(result.receipt.ontologyHash),
        draftVersionId: nonEmptyString(agent.draftVersionId),
        verificationState: "generated_unverified",
        sandboxEvidence: "not_run",
        runnable: false,
        verified: false,
        candidateEligible: false,
        executionReadiness: agentReadiness,
        unverifiedApis: unverifiedApis.filter(
          (rawApi) => asRecord(rawApi)?.actionName === actionName,
        ),
        codeSha256: sha256Text(code),
      },
      idempotencyKey: `worker:${jobId}:agent-code-draft:${segment}`,
    });
  }
  return artifacts;
}

/** What an Agent's spec claims about one external-system requirement. The
 * Candidate Package records this verbatim so a reader can check the claim
 * against the Ontology without re-running the build. */
interface CandidateIntegrationBinding {
  requirementId: string;
  system: string;
  requirementKind: string;
  role: string;
  capability: string | null;
  operations: string[];
  objectTypes: string[];
  status: string;
  bindingKind: string | null;
  toolName: string | null;
  selectionRequired: boolean;
  missingCredentialEnv: string[];
  missingConfigKeys: string[];
  invalidConfigKeys: string[];
  missingSafety: string[];
  reason: string | null;
}

interface CandidateToolContractSnapshot {
  toolName: string;
  resolvedName: string | null;
  status: "resolved" | "unknown" | "ambiguous" | "contract_missing";
  policy: GeneratedToolExecutionPolicy | null;
  inputContractHash: string | null;
  outputContractHash: string | null;
  contractHash: string | null;
}

interface CandidateAgentDescriptor {
  slug: string;
  actionName: string | null;
  /** design_subagent provenance (spec.isSubAgent / card.isSubAgent). A
   * sub-agent is an implementation detail of the parent that covers the
   * Ontology Action: it is packaged, but its synthetic actionName never
   * counts against the exact requested-Action coverage set. */
  isSubAgent: boolean;
  executionOwner: "declarative_manifest" | "codeact";
  specLogicalName: string;
  codeLogicalName: string;
  tools: string[];
  unresolvedTools: string[];
  toolPolicies: Record<string, unknown>;
  executionReadiness: Record<string, unknown> | null;
  integrations: CandidateIntegrationBinding[];
  hasDurableHumanGate: boolean;
  /** #DRAFT-BINDING — the immutable on-disk Factory draft version this Agent
   * came from. Deployment promotes a draft version, so a Candidate that cannot
   * name its exact draft is reviewable but not deployable. */
  draftVersionId: string | null;
  codeSha256: string;
}

function candidateIntegrationBindings(
  spec: Record<string, unknown>,
): CandidateIntegrationBinding[] {
  const raw = spec.integrationBindings;
  if (!Array.isArray(raw)) return [];
  const bindings: CandidateIntegrationBinding[] = [];
  for (const entry of raw) {
    const binding = asRecord(entry);
    if (!binding) continue;
    const requirement = asRecord(binding.requirement);
    bindings.push({
      requirementId: nonEmptyString(requirement?.id) ?? "",
      system: nonEmptyString(requirement?.system) ?? "",
      requirementKind: nonEmptyString(requirement?.kind) ?? "",
      role: nonEmptyString(requirement?.role) ?? "",
      capability: nonEmptyString(requirement?.capability),
      operations: stringList(requirement?.operations),
      objectTypes: stringList(requirement?.objectTypes),
      status: nonEmptyString(binding.status) ?? "missing",
      bindingKind: nonEmptyString(binding.bindingKind),
      toolName: nonEmptyString(binding.toolName),
      selectionRequired: binding.selectionRequired === true,
      missingCredentialEnv: stringList(binding.missingCredentialEnv),
      missingConfigKeys: stringList(binding.missingConfigKeys),
      invalidConfigKeys: stringList(binding.invalidConfigKeys),
      missingSafety: stringList(binding.missingSafety),
      reason: nonEmptyString(binding.reason),
    });
  }
  return bindings;
}

function candidateAgentDescriptors(
  result: OntoCodeHarnessExecutorResult,
): CandidateAgentDescriptor[] {
  if (!Array.isArray(result.receipt.agents)) return [];
  const descriptors: CandidateAgentDescriptor[] = [];
  for (const rawAgent of result.receipt.agents) {
    const agent = asRecord(rawAgent);
    const spec = asRecord(agent?.spec) ?? agent;
    if (!agent || !spec) continue;
    const card = asRecord(agent.card);
    const design = asRecord(agent.design);
    const slug =
      nonEmptyString(spec.slug) ??
      nonEmptyString(card?.slug) ??
      nonEmptyString(agent.slug);
    if (!slug) continue;
    const code =
      nonEmptySourceText(spec.generatedCode) ??
      nonEmptySourceText(agent.generatedCode) ??
      nonEmptySourceText(design?.code);
    if (!code) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_agent_code_missing",
        `Candidate Agent ${slug} has no durable generated code`,
        {
          recoverable: true,
          retryable: false,
          details: { slug },
        },
      );
    }
    const typedSpec = {
      ...spec,
      tools: Array.isArray(spec.tools) ? spec.tools : [],
      plan: Array.isArray(spec.plan) ? spec.plan : [],
      inputBindings: Array.isArray(spec.inputBindings)
        ? spec.inputBindings
        : [],
      decisionTables: Array.isArray(spec.decisionTables)
        ? spec.decisionTables
        : [],
    } as unknown as GeneratedAgentSpec;
    const ownership = generatedSpecExecutionOwnership(typedSpec, code);
    const codeExecuted = spec.codeExecuted === true;
    if (codeExecuted && !ownership.codeActEligible) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_execution_owner_invalid",
        `Candidate Agent ${slug} requests CodeAct but requires the declarative runtime`,
        {
          recoverable: false,
          retryable: false,
          details: {
            slug,
            requiredOwner: ownership.owner,
            blockers: ownership.blockers,
          },
        },
      );
    }
    const segment = artifactSegment(slug);
    descriptors.push({
      slug,
      actionName:
        nonEmptyString(spec.actionName) ??
        nonEmptyString(card?.actionName) ??
        null,
      isSubAgent: spec.isSubAgent === true || card?.isSubAgent === true,
      executionOwner: codeExecuted ? "codeact" : "declarative_manifest",
      specLogicalName: `agents/${segment}/spec.json`,
      codeLogicalName: `agents/${segment}/agent.ts`,
      tools: Array.isArray(spec.tools)
        ? spec.tools.flatMap((tool) =>
            typeof tool === "string" && tool.trim() ? [tool.trim()] : [],
          )
        : [],
      unresolvedTools: stringList(spec.unresolvedTools),
      toolPolicies: asRecord(spec.toolPolicies) ?? {},
      executionReadiness: asRecord(spec.executionReadiness),
      integrations: candidateIntegrationBindings(spec),
      hasDurableHumanGate:
        spec.hitl === true ||
        (Array.isArray(spec.inputBindings) &&
          spec.inputBindings.some(
            (binding) => asRecord(binding)?.kind === "human_input",
          )),
      draftVersionId: nonEmptyString(agent.draftVersionId),
      codeSha256: sha256Text(code),
    });
  }
  return descriptors;
}

interface CandidateReadinessAssessment {
  hardBlockers: Array<Record<string, unknown>>;
  runtimeBlockers: OntoCodeCandidateBlocker[];
  verificationBlockers: OntoCodeCandidateBlocker[];
}

function candidateToolContractSnapshots(
  result: OntoCodeHarnessExecutorResult,
): CandidateToolContractSnapshot[] {
  const raw = result.receipt.candidateToolContracts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const snapshot = asRecord(entry);
    const toolName = nonEmptyString(snapshot?.toolName);
    const status =
      snapshot?.status === "resolved" ||
      snapshot?.status === "unknown" ||
      snapshot?.status === "ambiguous" ||
      snapshot?.status === "contract_missing"
        ? snapshot.status
        : null;
    if (!snapshot || !toolName || !status) return [];
    return [
      {
        toolName,
        resolvedName: nonEmptyString(snapshot.resolvedName),
        status,
        policy: isGeneratedToolExecutionPolicy(snapshot.policy)
          ? snapshot.policy
          : null,
        inputContractHash: nonEmptyString(snapshot.inputContractHash),
        outputContractHash: nonEmptyString(snapshot.outputContractHash),
        contractHash: nonEmptyString(snapshot.contractHash),
      } satisfies CandidateToolContractSnapshot,
    ];
  });
}

function candidateBlocker(input: {
  code: OntoCodeCandidateBlocker["code"];
  stage: OntoCodeCandidateBlocker["stage"];
  agent: CandidateAgentDescriptor;
  binding?: CandidateIntegrationBinding;
  toolName?: string | null;
  reason: string;
  missing?: string[];
}): OntoCodeCandidateBlocker {
  return {
    code: input.code,
    stage: input.stage,
    agentSlug: input.agent.slug,
    actionName: input.agent.actionName,
    requirementId: input.binding?.requirementId || null,
    system: input.binding?.system || null,
    toolName: input.toolName ?? input.binding?.toolName ?? null,
    bindingStatus: input.binding?.status ?? null,
    reason: input.reason.slice(0, 2_000),
    missing: [...new Set(input.missing ?? [])].slice(0, 100),
  };
}

function dedupeCandidateBlockers(
  blockers: OntoCodeCandidateBlocker[],
): OntoCodeCandidateBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = canonicalEvidenceJson(blocker);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Candidate-ready means "immutable, structurally safe input to later gates",
 * not "runnable now". Missing profiles, credentials, probes, or a temporarily
 * unavailable API therefore become durable stage blockers. Unknown surfaces,
 * ambiguous/missing I/O contracts, and incomplete execution authority remain
 * hard authoring failures and can never acquire a Candidate Head.
 */
function assessCandidateReadiness(
  agents: CandidateAgentDescriptor[],
  contracts: CandidateToolContractSnapshot[],
): CandidateReadinessAssessment {
  const hardBlockers: Array<Record<string, unknown>> = [];
  const runtimeBlockers: OntoCodeCandidateBlocker[] = [];
  const verificationBlockers: OntoCodeCandidateBlocker[] = [];
  const contractByName = new Map(
    contracts.map((contract) => [contract.toolName, contract]),
  );

  for (const agent of agents) {
    for (const unresolvedTool of agent.unresolvedTools) {
      hardBlockers.push({
        code: "candidate_tool_unknown",
        slug: agent.slug,
        toolName: unresolvedTool,
      });
    }
    for (const toolName of agent.tools) {
      const capturedPolicy = agent.toolPolicies[toolName];
      const contract = contractByName.get(toolName);
      if (!isGeneratedToolExecutionPolicy(capturedPolicy)) {
        hardBlockers.push({
          code: "candidate_tool_policy_missing",
          slug: agent.slug,
          toolName,
        });
      }
      if (!contract || contract.status === "unknown") {
        hardBlockers.push({
          code: "candidate_tool_unknown",
          slug: agent.slug,
          toolName,
        });
      } else if (contract.status === "ambiguous") {
        hardBlockers.push({
          code: "candidate_tool_identity_ambiguous",
          slug: agent.slug,
          toolName,
        });
      } else if (
        contract.status === "contract_missing" ||
        !contract.inputContractHash ||
        !contract.outputContractHash ||
        !contract.contractHash
      ) {
        hardBlockers.push({
          code: "candidate_tool_io_contract_missing",
          slug: agent.slug,
          toolName,
        });
      } else if (
        !contract.policy ||
        !isGeneratedToolExecutionPolicy(capturedPolicy) ||
        !generatedToolPoliciesEqual(capturedPolicy, contract.policy)
      ) {
        hardBlockers.push({
          code: "candidate_tool_policy_drift",
          slug: agent.slug,
          toolName,
        });
      }
    }

    for (const binding of agent.integrations) {
      const requirementComplete =
        Boolean(binding.requirementId) &&
        Boolean(binding.system) &&
        Boolean(binding.requirementKind) &&
        Boolean(binding.role);
      const externalContractComplete =
        binding.requirementKind !== "external_api" ||
        binding.operations.length > 0 ||
        Boolean(binding.capability);
      if (!requirementComplete || !externalContractComplete) {
        hardBlockers.push({
          code: "candidate_integration_io_contract_missing",
          slug: agent.slug,
          requirementId: binding.requirementId || null,
          system: binding.system || null,
          requirementKind: binding.requirementKind || null,
          role: binding.role || null,
        });
        continue;
      }
      if (binding.selectionRequired || binding.invalidConfigKeys.length > 0) {
        hardBlockers.push({
          code: "candidate_integration_authority_undefined",
          slug: agent.slug,
          requirementId: binding.requirementId,
          toolName: binding.toolName,
          selectionRequired: binding.selectionRequired,
          missingSafety: binding.missingSafety,
          invalidConfigKeys: binding.invalidConfigKeys,
        });
        continue;
      }
      if (binding.missingSafety.length > 0) {
        runtimeBlockers.push(
          candidateBlocker({
            code: "write_probe_contract_missing",
            stage: "runtime",
            agent,
            binding,
            reason:
              binding.reason ??
              "The external write tool has no complete disposable-canary, idempotency, cleanup and absence-readback contract.",
            missing: binding.missingSafety,
          }),
        );
        verificationBlockers.push(
          candidateBlocker({
            code: "write_probe_contract_missing",
            stage: "verification",
            agent,
            binding,
            reason:
              binding.reason ??
              "A write-capable integration cannot be verified until its complete disposable probe lifecycle is authored.",
            missing: binding.missingSafety,
          }),
        );
      }

      if (binding.status === "resolved") {
        // A tool binding is only real if the Agent actually carries that tool.
        const kind = binding.bindingKind ?? (binding.toolName ? "tool" : null);
        if (
          kind === "tool" &&
          (!binding.toolName || !agent.tools.includes(binding.toolName))
        ) {
          hardBlockers.push({
            code: "candidate_integration_resolved_without_tool",
            slug: agent.slug,
            system: binding.system,
            role: binding.role,
            status: "resolved_without_tool",
            toolName: binding.toolName,
          });
        }
        continue;
      }

      if (binding.status === "human_boundary") {
        if (!agent.hasDurableHumanGate) {
          hardBlockers.push({
            code: "candidate_human_boundary_without_durable_gate",
            slug: agent.slug,
            system: binding.system,
            role: binding.role,
            requirementId: binding.requirementId,
          });
          continue;
        }
        runtimeBlockers.push(
          candidateBlocker({
            code: "human_boundary_pending",
            stage: "runtime",
            agent,
            binding,
            reason:
              binding.reason ??
              "This requirement is explicitly owned by a durable human gate and cannot execute autonomously.",
          }),
        );
        verificationBlockers.push(
          candidateBlocker({
            code: "human_boundary_pending",
            stage: "verification",
            agent,
            binding,
            reason:
              binding.reason ??
              "Sandbox verification cannot impersonate the confirmed human-owned integration boundary.",
          }),
        );
        continue;
      }

      if (
        (binding.status === "needs_config" ||
          binding.status === "needs_probe") &&
        binding.bindingKind === "tool" &&
        binding.toolName &&
        agent.tools.includes(binding.toolName) &&
        contractByName.get(binding.toolName)?.status === "resolved"
      ) {
        if (binding.status === "needs_config") {
          const missing = [
            ...binding.missingCredentialEnv,
            ...binding.missingConfigKeys,
          ];
          runtimeBlockers.push(
            candidateBlocker({
              code:
                binding.missingCredentialEnv.length > 0
                  ? "credential_reference_unavailable"
                  : "integration_profile_missing",
              stage: "runtime",
              agent,
              binding,
              reason:
                binding.reason ??
                "The selected tool has no complete sandbox integration profile.",
              missing,
            }),
          );
          verificationBlockers.push(
            candidateBlocker({
              code: "integration_profile_missing",
              stage: "verification",
              agent,
              binding,
              reason:
                binding.reason ??
                "Verification requires a complete sandbox integration profile.",
              missing,
            }),
          );
        }
        if (binding.status === "needs_probe") {
          verificationBlockers.push(
            candidateBlocker({
              code: "integration_probe_missing",
              stage: "verification",
              agent,
              binding,
              reason:
                binding.reason ??
                "The exact tool definition and profile have no current probe evidence.",
            }),
          );
        }
        continue;
      }

      hardBlockers.push({
        code: "candidate_integration_unbound",
        slug: agent.slug,
        system: binding.system,
        role: binding.role,
        status: binding.status,
        toolName: binding.toolName,
        reason: binding.reason,
      });
    }

    const readiness = agent.executionReadiness;
    if (
      readiness?.schema === "agent-factory-execution-readiness/v1" &&
      Array.isArray(readiness.externalApis)
    ) {
      for (const rawApi of readiness.externalApis) {
        const api = asRecord(rawApi);
        const toolName = nonEmptyString(api?.tool);
        if (!api || !toolName || api.sandboxReady === true) continue;
        const binding = agent.integrations.find(
          (candidate) => candidate.toolName === toolName,
        );
        const missingCredentialEnv = stringList(api.missingCredentialEnv);
        const missingProfile = api.missingSandboxProfile === true;
        runtimeBlockers.push(
          candidateBlocker({
            code:
              missingCredentialEnv.length > 0
                ? "credential_reference_unavailable"
                : missingProfile
                  ? "integration_profile_missing"
                  : "external_api_runtime_not_ready",
            stage: "runtime",
            agent,
            binding,
            toolName,
            reason:
              stringList(api.sandboxReasons).join("；") ||
              "The external API is not currently ready for sandbox execution.",
            missing: missingCredentialEnv,
          }),
        );
      }
    }
  }
  return {
    hardBlockers,
    runtimeBlockers: dedupeCandidateBlockers(runtimeBlockers),
    verificationBlockers: dedupeCandidateBlockers(verificationBlockers),
  };
}

function assertCandidateAuthoringSafe(
  assessment: CandidateReadinessAssessment,
): void {
  if (assessment.hardBlockers.length === 0) return;
  throw new OntoCodeHarnessExecutionError(
    "candidate_authoring_contract_incomplete",
    "候选包不能交付：存在未知工具、缺失 I/O 契约或未定义的执行权限",
    {
      recoverable: true,
      retryable: false,
      details: { blockers: assessment.hardBlockers },
    },
  );
}

function exactCandidateScopeActionNames(
  result: OntoCodeHarnessExecutorResult,
): string[] {
  const scope = asRecord(result.receipt.scope);
  const scoped = stringList(scope?.actionNames);
  return scoped.length > 0 ? scoped : stringList(result.receipt.actionNames);
}

function sameUniqueStrings(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    left.length === leftSet.size &&
    right.length === rightSet.size &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function candidateAgentsCoverExactScope(
  result: OntoCodeHarnessExecutorResult,
  agents: CandidateAgentDescriptor[],
): boolean {
  const requestedActionNames = exactCandidateScopeActionNames(result);
  const agentActionNames = agents.flatMap((agent) =>
    agent.actionName ? [agent.actionName] : [],
  );
  // #C5 — sub-agents (design_subagent) carry synthetic action names and are
  // implementation details of the parent that covers the requested Action.
  // They stay in the package, but only PRIMARY agents are compared against the
  // server-locked scope; counting subs made a brain that decomposed its work
  // structurally kill its own candidate (candidate_scope_incomplete).
  const primaryActionNames = agents.flatMap((agent) =>
    !agent.isSubAgent && agent.actionName ? [agent.actionName] : [],
  );
  return (
    requestedActionNames.length > 0 &&
    agentActionNames.length === agents.length &&
    sameUniqueStrings(primaryActionNames, requestedActionNames)
  );
}

function assertCandidateScopeComplete(
  result: OntoCodeHarnessExecutorResult,
  agents: CandidateAgentDescriptor[],
): void {
  if (candidateAgentsCoverExactScope(result, agents)) return;
  throw new OntoCodeHarnessExecutionError(
    "candidate_scope_incomplete",
    "候选包不能交付：持久化 Agent 集合与服务器锁定的完整 Build Action 范围不一致",
    {
      recoverable: true,
      retryable: false,
      details: {
        requestedActionNames: exactCandidateScopeActionNames(result),
        persistedActionNames: agents.map((agent) => agent.actionName),
      },
    },
  );
}

function generatedUnverifiedCandidateIsSafe(
  result: OntoCodeHarnessExecutorResult,
): boolean {
  if (
    result.outcome !== "waiting_user" ||
    result.receipt.verificationState !== "generated_unverified"
  ) {
    return false;
  }
  const checkpoint = asRecord(result.receipt.draftCheckpoint);
  const executionReadiness = asRecord(checkpoint?.executionReadiness);
  if (
    checkpoint?.schema !== "agent-factory-draft-checkpoint/v2" ||
    !/^v-[A-Za-z0-9-]{3,120}$/.test(
      nonEmptyString(checkpoint.draftVersionId) ?? "",
    ) ||
    !/^specs:v2:[a-f0-9]{64}$/.test(
      nonEmptyString(checkpoint.specsFingerprint) ?? "",
    ) ||
    executionReadiness?.state !== "generated_unverified" ||
    executionReadiness.sandboxEvidence !== "not_run"
  ) {
    return false;
  }
  try {
    const agents = candidateAgentDescriptors(result);
    if (
      checkpoint.scope !== "full" ||
      agents.length === 0 ||
      checkpoint.persisted !== agents.length ||
      agents.some(
        (agent) => agent.draftVersionId !== checkpoint.draftVersionId,
      ) ||
      !candidateAgentsCoverExactScope(result, agents)
    ) {
      return false;
    }
    const receiptSpecs = Array.isArray(result.receipt.agents)
      ? result.receipt.agents.flatMap((rawAgent) => {
          const spec = asRecord(asRecord(rawAgent)?.spec);
          return spec ? [spec as unknown as GeneratedAgentSpec] : [];
        })
      : [];
    if (
      receiptSpecs.length !== agents.length ||
      specsFingerprint(receiptSpecs) !== checkpoint.specsFingerprint
    ) {
      return false;
    }
    const coveredAgents = new Set(stringList(checkpoint.coveredAgents));
    const requestedActionNames = exactCandidateScopeActionNames(result);
    // save_draft records EVERY spec's actionName as covered — sub-agents
    // included, under their synthetic names. The exact-scope bijection is
    // asserted over the PRIMARY names only; every agent (sub or primary) must
    // still be covered by the checkpoint, so nothing is dropped silently.
    const subActionNames = new Set(
      agents.flatMap((agent) =>
        agent.isSubAgent && agent.actionName ? [agent.actionName] : [],
      ),
    );
    const coveredPrimary = [...coveredAgents].filter(
      (actionName) => !subActionNames.has(actionName),
    );
    if (
      coveredPrimary.length !== requestedActionNames.length ||
      requestedActionNames.some(
        (actionName) => !coveredAgents.has(actionName),
      ) ||
      agents.some(
        (agent) => !agent.actionName || !coveredAgents.has(agent.actionName),
      )
    ) {
      return false;
    }
    const assessment = assessCandidateReadiness(
      agents,
      candidateToolContractSnapshots(result),
    );
    return assessment.hardBlockers.length === 0;
  } catch {
    return false;
  }
}

/**
 * A complete authoring-safe Candidate is the terminal product of a Build even
 * when the private generation kernel parked after `save_draft` to suggest a
 * later Sandbox step. Keeping that kernel checkpoint as `waiting_user` makes
 * OntoCode advertise a continuation that cannot add anything to generation;
 * the eventual resume then fails against an already-finalized checkpoint.
 *
 * This promotion is deliberately narrow: the same full-scope, immutable-draft
 * and tool-contract predicate that authorizes Candidate persistence must pass.
 * It only completes code generation. The Candidate validation written below
 * still records no Sandbox evidence and `releaseEligible: false`, so testing,
 * verification and promotion remain separate fail-closed operations.
 */
function terminalizeGeneratedUnverifiedBuild(
  kind: OntoCodeHarnessJobKind,
  result: OntoCodeHarnessExecutorResult,
): OntoCodeHarnessExecutorResult {
  if (kind !== "build" || !generatedUnverifiedCandidateIsSafe(result)) {
    return result;
  }
  const { interaction: _supersededInteraction, ...receipt } = result.receipt;
  return {
    outcome: "succeeded",
    receipt: {
      ...receipt,
      status: "candidate_ready",
      completionKind: "delivery",
      verificationState: "generated_unverified",
      sandboxEvidence: "not_run",
      releaseEligible: false,
    },
    ...(result.phase ? { phase: result.phase } : {}),
    message:
      "Agent 代码生成已完成，已保存为“已生成、未验证”的候选版本；尚未运行沙箱或测试，当前不可发布。",
    ...(result.charts ? { charts: result.charts } : {}),
    ...(result.tables ? { tables: result.tables } : {}),
  };
}

function persistCandidatePackage(
  tx: Transaction,
  claim: OntoCodeHarnessClaim,
  data: OntoCodeHarnessLoadedContext,
  result: OntoCodeHarnessExecutorResult,
  changeSetId: string | null,
  existingArtifacts: PersistedHarnessArtifactRef[],
  now: Date,
): {
  artifacts: PersistedHarnessArtifactRef[];
  candidatePackageVersionId: string;
  candidateHeadId: string;
  candidateHeadRevision: number;
  dependencyRoot: string;
} {
  const ontologyHash =
    nonEmptyString(result.receipt.ontologyHash) ??
    data.session.ontologySnapshotHash;
  if (!ontologyHash) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_ontology_hash_missing",
      "A Candidate Package requires the exact authoritative Ontology hash",
      { recoverable: false, retryable: false },
    );
  }
  const agents = candidateAgentDescriptors(result);
  if (agents.length === 0) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_agents_missing",
      "A successful Build must persist at least one Agent before candidate_ready",
      { recoverable: true, retryable: false },
    );
  }
  assertCandidateScopeComplete(result, agents);
  const readiness = assessCandidateReadiness(
    agents,
    candidateToolContractSnapshots(result),
  );
  assertCandidateAuthoringSafe(readiness);
  const byLogicalName = new Map(
    existingArtifacts.map((artifact) => [artifact.logicalName, artifact]),
  );
  for (const agent of agents) {
    if (
      !byLogicalName.has(agent.specLogicalName) ||
      !byLogicalName.has(agent.codeLogicalName)
    ) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_artifact_set_incomplete",
        `Candidate Agent ${agent.slug} is missing its exact Spec or Code Artifact Version`,
        {
          recoverable: false,
          retryable: false,
          details: {
            slug: agent.slug,
            specLogicalName: agent.specLogicalName,
            codeLogicalName: agent.codeLogicalName,
          },
        },
      );
    }
  }

  const manifestContent = canonicalEvidenceJson({
    schema: "ontocode-candidate-manifest/v1",
    ontologyHash,
    sourceHarnessJobId: claim.jobId,
    sourceFactoryRunId: nonEmptyString(result.receipt.factoryRunId),
    agents: agents.map((agent) => {
      const spec = byLogicalName.get(agent.specLogicalName)!;
      const code = byLogicalName.get(agent.codeLogicalName)!;
      return {
        slug: agent.slug,
        actionName: agent.actionName,
        executionOwner: agent.executionOwner,
        authoritativeArtifactVersionId:
          agent.executionOwner === "codeact"
            ? code.artifactVersionId
            : spec.artifactVersionId,
        spec: {
          artifactVersionId: spec.artifactVersionId,
          blobHash: spec.blobHash,
        },
        code: {
          artifactVersionId: code.artifactVersionId,
          blobHash: code.blobHash,
          authority:
            agent.executionOwner === "codeact"
              ? "runtime_source"
              : "reviewable_projection",
        },
        tools: agent.tools,
        hasDurableHumanGate: agent.hasDurableHumanGate,
      };
    }),
  });
  const configContent = canonicalEvidenceJson({
    schema: "ontocode-candidate-config/v2",
    ontologyHash,
    environmentProfileVersionId: data.session.environmentProfileVersionId,
    toolBindings: agents.map((agent) => ({
      slug: agent.slug,
      tools: agent.tools,
      hasDurableHumanGate: agent.hasDurableHumanGate,
      integrations: agent.integrations,
    })),
    runtimeReady: readiness.runtimeBlockers.length === 0,
    verificationPrerequisitesReady: readiness.verificationBlockers.length === 0,
    runtimeBlockers: readiness.runtimeBlockers,
    verificationBlockers: readiness.verificationBlockers,
    releaseEligible: false,
    sandboxVerificationRequired: true,
  });
  // #DRAFT-BINDING — deployment promotes an immutable on-disk Factory draft
  // version, while the Candidate Package is content-addressed in the database.
  // Recording both identities together, per Agent, is what lets a later deploy
  // prove the thing it promotes is the exact thing that was reviewed and
  // sandbox-verified. A Candidate whose Agents cannot all name one draft
  // version is still reviewable — it just cannot be deployed, and the preflight
  // says exactly that instead of promoting something unverifiable.
  const draftVersionIds = [
    ...new Set(
      agents.flatMap((agent) =>
        agent.draftVersionId ? [agent.draftVersionId] : [],
      ),
    ),
  ];
  const unboundAgents = agents
    .filter((agent) => !agent.draftVersionId)
    .map((agent) => agent.slug);
  const draftBinding = {
    schema: "ontocode-candidate-factory-draft/v1" as const,
    ontologyHash,
    domain: data.project.domain,
    sourceHarnessJobId: claim.jobId,
    sourceFactoryRunId: nonEmptyString(result.receipt.factoryRunId),
    draftVersionIds,
    bound: unboundAgents.length === 0 && draftVersionIds.length === 1,
    unboundAgents,
    unboundReason:
      unboundAgents.length > 0
        ? "至少一个 Agent 没有对应的不可变 Factory draft 版本"
        : draftVersionIds.length > 1
          ? "这些 Agent 分散在多个 draft 版本里，无法作为一个整体促升"
          : draftVersionIds.length === 0
            ? "本次构建没有留下 Factory draft 版本"
            : null,
    agents: agents.map((agent) => ({
      slug: agent.slug,
      actionName: agent.actionName,
      draftVersionId: agent.draftVersionId,
      codeSha256: agent.codeSha256,
      codeArtifactVersionId: byLogicalName.get(agent.codeLogicalName)!
        .artifactVersionId,
      codeBlobHash: byLogicalName.get(agent.codeLogicalName)!.blobHash,
    })),
  };
  const draftBindingContent = canonicalEvidenceJson(draftBinding);
  const packageArtifacts = [
    persistHarnessArtifactVersion(
      tx,
      claim,
      data,
      changeSetId,
      {
        logicalName: "package/manifest.json",
        kind: "agent_manifest",
        semanticPath: "/package/manifest",
        content: manifestContent,
        contentType: "application/json",
        metadata: {
          jobId: claim.jobId,
          ontologyHash,
          candidateRole: "manifest",
        },
        idempotencyKey: `worker:${claim.jobId}:candidate-manifest`,
      },
      now,
    ),
    persistHarnessArtifactVersion(
      tx,
      claim,
      data,
      changeSetId,
      {
        logicalName: "package/runtime-config.json",
        kind: "agent_config",
        semanticPath: "/package/runtimeConfig",
        content: configContent,
        contentType: "application/json",
        metadata: {
          jobId: claim.jobId,
          ontologyHash,
          candidateRole: "runtime_config",
        },
        idempotencyKey: `worker:${claim.jobId}:candidate-config`,
      },
      now,
    ),
    persistHarnessArtifactVersion(
      tx,
      claim,
      data,
      changeSetId,
      {
        logicalName: "package/factory-draft.json",
        kind: "agent_config",
        semanticPath: "/package/factoryDraft",
        content: draftBindingContent,
        contentType: "application/json",
        metadata: {
          jobId: claim.jobId,
          ontologyHash,
          candidateRole: "factory_draft_binding",
          bound: String(draftBinding.bound),
        },
        idempotencyKey: `worker:${claim.jobId}:candidate-factory-draft`,
      },
      now,
    ),
  ];
  const candidateArtifacts = [
    ...existingArtifacts.filter(
      (artifact) =>
        artifact.kind === "agent_spec" || artifact.kind === "agent_code",
    ),
    ...packageArtifacts,
  ].sort((left, right) => left.logicalName.localeCompare(right.logicalName));
  const executionOwners = Object.fromEntries(
    agents.map((agent) => [agent.slug, agent.executionOwner]),
  );
  const dependencyRoot = computeOntoCodeCandidateDependencyRoot({
    ontologyHash,
    environmentProfileVersionId:
      data.session.environmentProfileVersionId ?? null,
    artifactRefs: candidateArtifacts.map((artifact) => ({
      logicalName: artifact.logicalName,
      kind: artifact.kind,
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.artifactVersionId,
      blobHash: artifact.blobHash,
    })),
    executionOwners,
  });
  const packageIdempotencyKey = `worker:${claim.jobId}:candidate-package`;
  let packageRow = tx
    .select()
    .from(ontocodePackageVersions)
    .where(
      and(
        eq(ontocodePackageVersions.tenantId, claim.tenantId),
        eq(ontocodePackageVersions.sessionId, claim.sessionId),
        eq(ontocodePackageVersions.idempotencyKey, packageIdempotencyKey),
      ),
    )
    .get();
  if (packageRow && packageRow.dependencyRoot !== dependencyRoot) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_idempotency_conflict",
      "The Build Job already persisted a different Candidate dependency root",
      {
        recoverable: false,
        retryable: false,
        details: { packageVersionId: packageRow.id },
      },
    );
  }
  if (!packageRow) {
    const currentHead = tx
      .select()
      .from(ontocodeCandidateHeads)
      .where(
        and(
          eq(ontocodeCandidateHeads.tenantId, claim.tenantId),
          eq(ontocodeCandidateHeads.sessionId, claim.sessionId),
        ),
      )
      .get();
    const packageVersionId = makeWorkerStorageId("ocpv");
    tx.insert(ontocodePackageVersions)
      .values({
        id: packageVersionId,
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        parentVersionId: currentHead?.packageVersionId ?? null,
        sourceHarnessJobId: claim.jobId,
        ontologyHash,
        dependencyRoot,
        artifactRefsJson: canonicalEvidenceJson(
          candidateArtifacts.map((artifact) => ({
            logicalName: artifact.logicalName,
            kind: artifact.kind,
            artifactId: artifact.artifactId,
            artifactVersionId: artifact.artifactVersionId,
            blobHash: artifact.blobHash,
          })),
        ),
        executionOwnersJson: canonicalEvidenceJson(executionOwners),
        status: "candidate_ready",
        validationJson: canonicalEvidenceJson(
          OntoCodeCandidateValidationV2Schema.parse({
            schema: "ontocode-candidate-validation/v2",
            passed: true,
            packageIntegrityPassed: true,
            requiredArtifactKinds: [
              "agent_spec",
              "agent_code",
              "agent_manifest",
              "agent_config",
            ],
            agentCount: agents.length,
            executionOwnerCount: Object.keys(executionOwners).length,
            runtimeReady: readiness.runtimeBlockers.length === 0,
            verificationPrerequisitesReady:
              readiness.verificationBlockers.length === 0,
            runtimeBlockers: readiness.runtimeBlockers,
            verificationBlockers: readiness.verificationBlockers,
            sandboxEvidenceIncluded: false,
            releaseEligible: false,
          }),
        ),
        idempotencyKey: packageIdempotencyKey,
        createdBy: data.job.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    packageRow = tx
      .select()
      .from(ontocodePackageVersions)
      .where(eq(ontocodePackageVersions.id, packageVersionId))
      .get()!;
    appendWorkerEvent(
      tx,
      {
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        jobId: claim.jobId,
        commandId: data.command?.id ?? null,
        type: "candidate.package.created",
        payload: {
          packageVersionId,
          dependencyRoot,
          ontologyHash,
          status: "candidate_ready",
          agentCount: agents.length,
          runtimeReady: readiness.runtimeBlockers.length === 0,
          verificationPrerequisitesReady:
            readiness.verificationBlockers.length === 0,
          runtimeBlockerCount: readiness.runtimeBlockers.length,
          verificationBlockerCount: readiness.verificationBlockers.length,
          artifactVersionIds: candidateArtifacts.map(
            (artifact) => artifact.artifactVersionId,
          ),
        },
        visibility: "user",
        causationId: packageVersionId,
      },
      now,
    );
  }

  let headRow = tx
    .select()
    .from(ontocodeCandidateHeads)
    .where(
      and(
        eq(ontocodeCandidateHeads.tenantId, claim.tenantId),
        eq(ontocodeCandidateHeads.sessionId, claim.sessionId),
      ),
    )
    .get();
  if (!headRow) {
    const headId = makeWorkerStorageId("och");
    tx.insert(ontocodeCandidateHeads)
      .values({
        id: headId,
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        packageVersionId: packageRow.id,
        revision: 1,
        updatedBy: data.job.createdBy,
        updatedAt: now,
      })
      .run();
    headRow = tx
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, headId))
      .get()!;
  } else if (headRow.packageVersionId !== packageRow.id) {
    const moved = tx
      .update(ontocodeCandidateHeads)
      .set({
        packageVersionId: packageRow.id,
        revision: headRow.revision + 1,
        updatedBy: data.job.createdBy,
        updatedAt: now,
      })
      .where(
        and(
          eq(ontocodeCandidateHeads.tenantId, claim.tenantId),
          eq(ontocodeCandidateHeads.id, headRow.id),
          eq(ontocodeCandidateHeads.revision, headRow.revision),
        ),
      )
      .run();
    if (moved.changes !== 1) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_head_cas_conflict",
        "Candidate Head moved while the Build result was being committed",
        {
          recoverable: true,
          retryable: false,
          details: {
            candidateHeadId: headRow.id,
            expectedRevision: headRow.revision,
          },
        },
      );
    }
    headRow = tx
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, headRow.id))
      .get()!;
  }
  appendWorkerEvent(
    tx,
    {
      tenantId: claim.tenantId,
      projectId: data.project.id,
      sessionId: claim.sessionId,
      jobId: claim.jobId,
      commandId: data.command?.id ?? null,
      type: "candidate.head.moved",
      payload: {
        candidateHeadId: headRow.id,
        packageVersionId: packageRow.id,
        dependencyRoot,
        revision: headRow.revision,
        status: "candidate_ready",
      },
      visibility: "user",
      causationId: headRow.id,
    },
    now,
  );
  return {
    artifacts: packageArtifacts,
    candidatePackageVersionId: packageRow.id,
    candidateHeadId: headRow.id,
    candidateHeadRevision: headRow.revision,
    dependencyRoot,
  };
}

function persistHarnessResult(
  tx: Transaction,
  claim: OntoCodeHarnessClaim,
  data: OntoCodeHarnessLoadedContext,
  result: OntoCodeHarnessExecutorResult,
  now: Date,
): PersistedHarnessResult {
  const changeSetId = latestCommandChangeSetId(tx, data);
  const receiptContent = canonicalEvidenceJson(result.receipt);
  const inputs: HarnessArtifactInput[] = [
    {
      logicalName: `harness/${data.job.kind}/${claim.jobId}/receipt.json`,
      kind: "harness_receipt",
      semanticPath: `/harness/jobs/${claim.jobId}/receipt`,
      content: receiptContent,
      contentType: "application/json",
      metadata: {
        jobId: claim.jobId,
        kind: data.job.kind,
        commandId: data.command?.id ?? null,
        factoryRunId: nonEmptyString(result.receipt.factoryRunId),
        ontologyHash: nonEmptyString(result.receipt.ontologyHash),
      },
      idempotencyKey: `worker:${claim.jobId}:receipt`,
    },
    // Ontology comprehension is a first-class Session artifact, not merely a
    // JSON field buried in a generic Harness receipt.  Its versioned
    // presentation blocks can be rendered by Analyst clients and pinned into
    // later Assistant turns without re-running the model.
    ...(data.job.kind === "ontology_analysis" && result.outcome === "succeeded"
      ? [
          {
            logicalName: "analysis/ontology.json",
            kind: "ontology_analysis",
            semanticPath: "/analysis/ontology",
            content: receiptContent,
            contentType: "application/json",
            metadata: {
              jobId: claim.jobId,
              kind: data.job.kind,
              commandId: data.command?.id ?? null,
              ontologyHash: nonEmptyString(result.receipt.ontologyHash),
              presentationSchema:
                asRecord(result.receipt.presentation)?.schema ?? null,
            },
            idempotencyKey: `worker:${claim.jobId}:ontology-analysis`,
          } satisfies HarnessArtifactInput,
        ]
      : []),
    // A clarification can arrive after Factory has emitted an in-memory
    // `agent.created` preview. Only a complete, durable, authoring-safe
    // checkpoint becomes a Candidate; other previews remain audit context.
    ...harnessAgentArtifacts(result, claim.jobId, data.job.kind),
    // If a parked Build cannot meet the authoring-safe Candidate boundary,
    // surface its code only as an FDE-reviewable draft. The safe path above
    // owns Candidate/head creation; verification and promotion stay closed.
    ...harnessGeneratedUnverifiedDraftArtifacts(
      result,
      claim.jobId,
      data.job.kind,
    ),
  ];
  const artifacts = inputs.map((input) =>
    persistHarnessArtifactVersion(tx, claim, data, changeSetId, input, now),
  );
  const candidate =
    data.job.kind === "build" &&
    (result.outcome === "succeeded" ||
      generatedUnverifiedCandidateIsSafe(result))
      ? persistCandidatePackage(
          tx,
          claim,
          data,
          result,
          changeSetId,
          artifacts,
          now,
        )
      : null;
  if (candidate) artifacts.push(...candidate.artifacts);
  if (candidate) {
    const bound = tx
      .update(ontocodeHarnessJobs)
      .set({
        candidatePackageVersionId: candidate.candidatePackageVersionId,
        candidateDependencyRoot: candidate.dependencyRoot,
        candidateHeadId: candidate.candidateHeadId,
        candidateHeadRevision: candidate.candidateHeadRevision,
        updatedAt: now,
      })
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
          eq(ontocodeHarnessJobs.id, claim.jobId),
        ),
      )
      .run();
    if (bound.changes !== 1) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_job_binding_failed",
        "Candidate Package was created but could not be bound to its Build job",
        { recoverable: false, retryable: false },
      );
    }
  }
  const receiptArtifact = artifacts[0]!;
  const evidenceOutcome =
    result.outcome === "waiting_user"
      ? "informational"
      : verificationOutcome(data.job.kind, result.receipt);
  const jobStatus =
    result.outcome === "waiting_user" ? "waiting_user" : "succeeded";
  const evidenceKey = `worker:${claim.jobId}:evidence`;
  const existingEvidence = tx
    .select({ id: ontocodeEvidenceRecords.id })
    .from(ontocodeEvidenceRecords)
    .where(
      and(
        eq(ontocodeEvidenceRecords.tenantId, claim.tenantId),
        eq(ontocodeEvidenceRecords.sessionId, claim.sessionId),
        eq(ontocodeEvidenceRecords.idempotencyKey, evidenceKey),
      ),
    )
    .get();
  const evidenceId = existingEvidence?.id ?? makeWorkerStorageId("ocev");
  if (!existingEvidence) {
    const boundPackageVersionId =
      candidate?.candidatePackageVersionId ??
      data.job.candidatePackageVersionId ??
      null;
    const boundDependencyRoot =
      candidate?.dependencyRoot ?? data.job.candidateDependencyRoot ?? null;
    const boundHeadId =
      candidate?.candidateHeadId ?? data.job.candidateHeadId ?? null;
    const boundHeadRevision =
      candidate?.candidateHeadRevision ??
      data.job.candidateHeadRevision ??
      null;
    const candidateBound =
      Boolean(boundPackageVersionId) && Boolean(boundDependencyRoot);
    tx.insert(ontocodeEvidenceRecords)
      .values({
        id: evidenceId,
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        harnessJobId: claim.jobId,
        changeSetId,
        artifactVersionId: receiptArtifact.artifactVersionId,
        kind: `harness_${data.job.kind}`,
        outcome: evidenceOutcome,
        state: "valid",
        staleReason: null,
        invalidatedByPackageVersionId: null,
        invalidatedAt: null,
        subjectType: candidateBound ? "candidate_package" : "harness_job",
        subjectId: boundPackageVersionId ?? claim.jobId,
        subjectDigest: boundDependencyRoot ?? receiptArtifact.blobHash,
        dependencySetJson: canonicalEvidenceJson({
          ontologyHash:
            nonEmptyString(result.receipt.ontologyHash) ??
            data.session.ontologySnapshotHash,
          factoryRunId: nonEmptyString(result.receipt.factoryRunId),
          sourceFactoryRunId: nonEmptyString(result.receipt.sourceFactoryRunId),
          commandId: data.command?.id ?? null,
          changeSetId,
          candidatePackageVersionId: boundPackageVersionId,
          candidateDependencyRoot: boundDependencyRoot,
          candidateHeadId: boundHeadId,
          candidateHeadRevision: boundHeadRevision,
          testSuiteHash: nonEmptyString(result.receipt.testSuiteHash),
          ontocodeSandboxAttemptId: nonEmptyString(
            result.receipt.ontocodeSandboxAttemptId,
          ),
          sandboxQualification: nonEmptyString(
            result.receipt.sandboxQualification,
          ),
        }),
        validityPredicateJson: canonicalEvidenceJson({
          jobStatus,
          immutableReceiptHash: receiptArtifact.blobHash,
          candidatePackageVersionId: boundPackageVersionId,
          candidateDependencyRoot: boundDependencyRoot,
          sandboxQualification: nonEmptyString(
            result.receipt.sandboxQualification,
          ),
          verificationVerdict:
            evidenceOutcome === "passed"
              ? "all_cases_passed"
              : evidenceOutcome === "failed"
                ? "one_or_more_cases_failed"
                : evidenceOutcome,
        }),
        refsJson: canonicalEvidenceJson(
          artifacts.map(
            (artifact) =>
              `ontocode-artifact-version:${artifact.artifactVersionId}`,
          ),
        ),
        summary:
          result.outcome === "waiting_user"
            ? `${data.job.kind} Harness paused for required FDE input; this receipt does not claim completion or success.`
            : evidenceOutcome === "passed"
              ? `${data.job.kind} Harness completed with all recorded cases passing.`
              : evidenceOutcome === "failed"
                ? `${data.job.kind} Harness completed, but one or more recorded cases failed.`
                : evidenceOutcome === "inconclusive"
                  ? `${data.job.kind} Harness completed without a conclusive case verdict.`
                  : `${data.job.kind} Harness completed and its immutable receipt was recorded.`,
        producer: "ontocode-harness-worker/v1",
        idempotencyKey: evidenceKey,
        recordedBy: data.job.createdBy,
        createdAt: now,
      })
      .run();
    appendWorkerEvent(
      tx,
      {
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        jobId: claim.jobId,
        commandId: data.command?.id ?? null,
        type: "evidence.recorded",
        payload: {
          evidenceId,
          kind: `harness_${data.job.kind}`,
          outcome: evidenceOutcome,
          subjectType: candidateBound ? "candidate_package" : "harness_job",
          subjectId: boundPackageVersionId ?? claim.jobId,
          subjectDigest: boundDependencyRoot ?? receiptArtifact.blobHash,
          harnessJobId: claim.jobId,
          changeSetId,
          artifactVersionId: receiptArtifact.artifactVersionId,
        },
        // Same demotion as artifact.created, and for the same reason: this row
        // is how an FDE walks from a conclusion back to the record behind it.
        visibility: "debug",
        causationId: evidenceId,
      },
      now,
    );
  }
  return {
    artifacts,
    evidenceId,
    evidenceOutcome,
    changeSetId,
    candidatePackageVersionId: candidate?.candidatePackageVersionId ?? null,
    candidateDependencyRoot: candidate?.dependencyRoot ?? null,
    candidateHeadId: candidate?.candidateHeadId ?? null,
    candidateHeadRevision: candidate?.candidateHeadRevision ?? null,
    deliveryState: candidate ? "candidate_ready" : null,
  };
}

interface PersistedHarnessFailure {
  artifacts: PersistedHarnessArtifactRef[];
  evidenceId: string;
  changeSetId: string | null;
}

/**
 * #FAILURE-RECEIPT — 把失败终态回执按【成功路径同样的纪律】落成不可变产物 + 证据记录。
 *
 * 刻意不复用 persistHarnessResult：那条路径会创建 Agent 产物、Candidate Package 并移动
 * Candidate Head。一次失败不得产出任何候选物——它只产出「这次为什么停了」的可核验记录。
 *
 * 证据 outcome 用 `inconclusive` 而不是 `failed`：`failed` 在本系统里的意思是「跑过用例、
 * 有用例没过」。作业根本没跑到判定就断了，冒用 `failed` 会让一份不存在的验证结论看起来存在。
 * 真正的失败事实写在 summary 与 validityPredicate.jobStatus 上。evidence kind 也刻意不叫
 * `harness_test` —— 那是套件总览统计测试判定的白名单键，失败回执绝不能混进去。
 */
function persistHarnessFailureResult(
  tx: Transaction,
  claim: OntoCodeHarnessClaim,
  data: OntoCodeHarnessLoadedContext,
  attempt: number,
  status: "failed_recoverable" | "failed_terminal",
  receipt: Record<string, unknown>,
  now: Date,
): PersistedHarnessFailure {
  const changeSetId = latestCommandChangeSetId(tx, data);
  const receiptContent = canonicalEvidenceJson(receipt);
  const artifacts = [
    persistHarnessArtifactVersion(
      tx,
      claim,
      data,
      changeSetId,
      {
        logicalName: `harness/${data.job.kind}/${claim.jobId}/failure-receipt.json`,
        kind: "harness_failure_receipt",
        semanticPath: `/harness/jobs/${claim.jobId}/failure-receipt`,
        content: receiptContent,
        contentType: "application/json",
        metadata: {
          jobId: claim.jobId,
          kind: data.job.kind,
          attempt,
          status,
          commandId: data.command?.id ?? null,
          errorCode: nonEmptyString(asRecord(receipt.error)?.code),
          evidenceStatus: nonEmptyString(asRecord(receipt.evidence)?.status),
        },
        // 尝试号进 key：一次作业可能先 retry_scheduled 再终态失败，同一把钥匙配不同内容
        // 会撞 artifact_idempotency_conflict，而那会把「记录失败」本身变成一次失败。
        idempotencyKey: `worker:${claim.jobId}:a${attempt}:failure-receipt`,
      },
      now,
    ),
  ];
  const receiptArtifact = artifacts[0]!;
  const evidenceKey = `worker:${claim.jobId}:a${attempt}:failure-evidence`;
  const existingEvidence = tx
    .select({ id: ontocodeEvidenceRecords.id })
    .from(ontocodeEvidenceRecords)
    .where(
      and(
        eq(ontocodeEvidenceRecords.tenantId, claim.tenantId),
        eq(ontocodeEvidenceRecords.sessionId, claim.sessionId),
        eq(ontocodeEvidenceRecords.idempotencyKey, evidenceKey),
      ),
    )
    .get();
  const evidenceId = existingEvidence?.id ?? makeWorkerStorageId("ocev");
  if (!existingEvidence) {
    const error = asRecord(receipt.error);
    const evidenceSection = asRecord(receipt.evidence);
    tx.insert(ontocodeEvidenceRecords)
      .values({
        id: evidenceId,
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        harnessJobId: claim.jobId,
        changeSetId,
        artifactVersionId: receiptArtifact.artifactVersionId,
        kind: `harness_${data.job.kind}_failure`,
        outcome: "inconclusive",
        state: "valid",
        staleReason: null,
        invalidatedByPackageVersionId: null,
        invalidatedAt: null,
        subjectType: "harness_job",
        subjectId: claim.jobId,
        subjectDigest: receiptArtifact.blobHash,
        dependencySetJson: canonicalEvidenceJson({
          ontologyHash:
            nonEmptyString(receipt.ontologyHash) ??
            data.session.ontologySnapshotHash,
          commandId: data.command?.id ?? null,
          changeSetId,
          attempt,
          factoryRunId: nonEmptyString(evidenceSection?.runId),
        }),
        validityPredicateJson: canonicalEvidenceJson({
          jobStatus: status,
          immutableReceiptHash: receiptArtifact.blobHash,
          errorCode: nonEmptyString(error?.code),
          verificationVerdict: "not_reached",
        }),
        refsJson: canonicalEvidenceJson(
          artifacts.map(
            (artifact) =>
              `ontocode-artifact-version:${artifact.artifactVersionId}`,
          ),
        ),
        summary: `${data.job.kind} Harness 未能完成（${nonEmptyString(error?.code) ?? "unknown_error"}）。本记录只保存终态错误与可核验的运行证据，不构成任何验证结论。`,
        producer: "ontocode-harness-worker/v1",
        idempotencyKey: evidenceKey,
        recordedBy: data.job.createdBy,
        createdAt: now,
      })
      .run();
    appendWorkerEvent(
      tx,
      {
        tenantId: claim.tenantId,
        projectId: data.project.id,
        sessionId: claim.sessionId,
        jobId: claim.jobId,
        commandId: data.command?.id ?? null,
        type: "evidence.recorded",
        payload: {
          evidenceId,
          kind: `harness_${data.job.kind}_failure`,
          outcome: "inconclusive",
          subjectType: "harness_job",
          subjectId: claim.jobId,
          subjectDigest: receiptArtifact.blobHash,
          harnessJobId: claim.jobId,
          changeSetId,
          artifactVersionId: receiptArtifact.artifactVersionId,
        },
        // Same demotion as artifact.created, and for the same reason: this row
        // is how an FDE walks from a conclusion back to the record behind it.
        visibility: "debug",
        causationId: evidenceId,
      },
      now,
    );
  }
  return { artifacts, evidenceId, changeSetId };
}

function nextEventSeq(db: DbLike, tenantId: string, sessionId: string): number {
  const latest = db
    .select({ seq: ontocodeSessionEvents.seq })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .limit(1)
    .get();
  return (latest?.seq ?? 0) + 1;
}

function appendWorkerEvent(
  db: DbLike,
  input: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    jobId: string;
    commandId: string | null;
    type: string;
    payload: Record<string, unknown>;
    visibility?: "user" | "debug" | "audit";
    causationId?: string;
  },
  now: Date,
): void {
  db.insert(ontocodeSessionEvents)
    .values({
      id: makeWorkerEventId(),
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      seq: nextEventSeq(db, input.tenantId, input.sessionId),
      type: input.type,
      visibility: input.visibility ?? "user",
      payloadJson: canonicalEvidenceJson(input.payload),
      commandId: input.commandId,
      harnessJobId: input.jobId,
      correlationId: `ocw-${input.jobId}`,
      causationId: input.causationId ?? input.jobId,
      createdAt: now,
    })
    .run();
}

function parseEventPayload(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clippedMessage(value: unknown): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "OntoCode harness execution failed";
  // This feeds both the immutable receipt and the product projection. Preserve
  // the author's Unicode punctuation; whole-string NFKC is not a safe clip.
  return raw.trim().slice(0, 8_000);
}

function normalizeFailure(error: unknown): NormalizedExecutionFailure {
  if (error instanceof OntoCodeHarnessExecutionError) {
    return {
      code: error.code,
      message: clippedMessage(error),
      recoverable: error.options.recoverable,
      retryable: error.options.retryable,
      ...(error.options.details ? { details: error.options.details } : {}),
    };
  }
  if (error instanceof FactoryScopeRecommendationError) {
    return {
      code: error.code,
      message: clippedMessage(error),
      recoverable: true,
      retryable: error.retryable,
      // The FDE-facing message names no cause it cannot prove; the verbatim
      // reason travels here so the durable receipt still answers "why".
      ...(error.cause ? { details: { cause: error.cause } } : {}),
    };
  }
  return {
    code: "unexpected_executor_error",
    message: clippedMessage(error),
    recoverable: true,
    retryable: true,
  };
}

function phaseForJob(kind: OntoCodeHarnessJobKind): OntoCodeSessionPhase {
  switch (kind) {
    // Comprehension is a read; it must not advance the delivery phase.
    case "ontology_analysis":
      return "intake";
    case "scope":
      return "scope";
    case "blueprint":
      return "blueprint";
    case "build":
      return "build";
    case "simulation":
    case "test":
    case "regression":
      return "verify";
    case "debug":
      return "debug";
    case "promotion":
    case "deploy":
      return "release";
    case "production_analysis":
      return "observe";
  }
}

function hasApprovedDecision(
  db: DbLike,
  tenantId: string,
  sessionId: string,
  commandId: string,
): boolean {
  const rows = db
    .select({ payloadJson: ontocodeSessionEvents.payloadJson })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
        eq(ontocodeSessionEvents.commandId, commandId),
        eq(ontocodeSessionEvents.type, "decision.resolved"),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .all();
  return rows.some(
    (row) => parseEventPayload(row.payloadJson)?.decision === "approve",
  );
}

function enforceProductionAuthorization(
  context: OntoCodeHarnessExecutionContext,
): void {
  const productionRisk =
    context.command?.riskClass === "external_irreversible" ||
    context.command?.riskClass === "production_deploy";
  if (!PRODUCTION_JOB_KINDS.has(context.job.kind) && !productionRisk) return;
  if (!context.command) {
    throw new OntoCodeHarnessExecutionError(
      "production_command_required",
      "Production-capable jobs require an attached command",
      { recoverable: false, retryable: false },
    );
  }
  if (!context.command.requiresHuman) {
    throw new OntoCodeHarnessExecutionError(
      "production_human_approval_required",
      "Production-capable jobs require a human-approved command",
      { recoverable: false, retryable: false },
    );
  }
  if (
    !hasApprovedDecision(
      getDb(),
      context.job.tenantId,
      context.job.sessionId,
      context.command.id,
    )
  ) {
    throw new OntoCodeHarnessExecutionError(
      "production_approval_evidence_missing",
      "The command has no durable human approval receipt",
      { recoverable: false, retryable: false },
    );
  }
}

function enforceCommandAuthorization(
  context: OntoCodeHarnessExecutionContext,
): void {
  if (
    context.command ||
    COMMANDLESS_READ_ONLY_JOB_KINDS.has(context.job.kind)
  ) {
    return;
  }
  throw new OntoCodeHarnessExecutionError(
    "non_read_only_command_required",
    "Non-read-only Harness jobs require an attached, policy-derived OntoCode Command",
    {
      recoverable: false,
      retryable: false,
      details: {
        jobId: context.job.id,
        jobKind: context.job.kind,
        autonomyMode: context.session.autonomyMode,
      },
    },
  );
}

function exactCandidateTargetFailure(
  db: DbLike,
  data: OntoCodeHarnessLoadedContext,
): NormalizedExecutionFailure | null {
  if (!EXACT_CANDIDATE_JOB_KINDS.has(data.job.kind)) return null;
  const job = data.job;
  if (
    !job.candidatePackageVersionId ||
    !job.candidateDependencyRoot ||
    !job.candidateHeadId ||
    job.candidateHeadRevision === null
  ) {
    return {
      code: "candidate_target_missing",
      message:
        "This verification Job was not pinned to an immutable Candidate Package",
      recoverable: true,
      retryable: false,
    };
  }
  const head = db
    .select()
    .from(ontocodeCandidateHeads)
    .where(
      and(
        eq(ontocodeCandidateHeads.tenantId, job.tenantId),
        eq(ontocodeCandidateHeads.sessionId, job.sessionId),
      ),
    )
    .get();
  if (
    !head ||
    head.id !== job.candidateHeadId ||
    head.revision !== job.candidateHeadRevision ||
    head.packageVersionId !== job.candidatePackageVersionId
  ) {
    return {
      code: "candidate_head_drift",
      message:
        "The Candidate Head moved after this verification Job was queued",
      recoverable: true,
      retryable: false,
      details: {
        expectedHeadId: job.candidateHeadId,
        expectedHeadRevision: job.candidateHeadRevision,
        expectedPackageVersionId: job.candidatePackageVersionId,
        currentHeadId: head?.id ?? null,
        currentHeadRevision: head?.revision ?? null,
        currentPackageVersionId: head?.packageVersionId ?? null,
      },
    };
  }
  const packageVersion = db
    .select()
    .from(ontocodePackageVersions)
    .where(
      and(
        eq(ontocodePackageVersions.tenantId, job.tenantId),
        eq(ontocodePackageVersions.sessionId, job.sessionId),
        eq(ontocodePackageVersions.id, job.candidatePackageVersionId),
      ),
    )
    .get();
  if (
    !packageVersion ||
    packageVersion.projectId !== data.project.id ||
    packageVersion.dependencyRoot !== job.candidateDependencyRoot
  ) {
    return {
      code: "candidate_digest_mismatch",
      message:
        "The pinned Candidate Package is missing or its dependency root changed",
      recoverable: false,
      retryable: false,
      details: {
        packageVersionId: job.candidatePackageVersionId,
        expectedDependencyRoot: job.candidateDependencyRoot,
        currentDependencyRoot: packageVersion?.dependencyRoot ?? null,
      },
    };
  }
  try {
    const artifactRefs = JSON.parse(
      packageVersion.artifactRefsJson,
    ) as OntoCodePackageVersion["artifactRefs"];
    const executionOwners = JSON.parse(
      packageVersion.executionOwnersJson,
    ) as Record<string, OntoCodeExecutionOwner>;
    const recomputed = computeOntoCodeCandidateDependencyRoot({
      ontologyHash: packageVersion.ontologyHash,
      environmentProfileVersionId:
        data.session.environmentProfileVersionId ?? null,
      artifactRefs,
      executionOwners,
    });
    if (recomputed !== packageVersion.dependencyRoot) {
      return {
        code: "candidate_dependency_root_invalid",
        message:
          "The Candidate Package dependency root does not match its immutable inputs",
        recoverable: false,
        retryable: false,
        details: {
          packageVersionId: packageVersion.id,
          expectedDependencyRoot: packageVersion.dependencyRoot,
          recomputedDependencyRoot: recomputed,
        },
      };
    }
  } catch (error) {
    return {
      code: "candidate_package_corrupt",
      message: `The Candidate Package cannot be decoded: ${clippedMessage(error)}`,
      recoverable: false,
      retryable: false,
    };
  }
  return null;
}

function activityAfterSuccess(
  tx: Transaction,
  tenantId: string,
  sessionId: string,
  currentJobId: string,
): OntoCodeSessionActivity {
  const currentJob = tx
    .select({ createdAt: ontocodeHarnessJobs.createdAt })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, tenantId),
        eq(ontocodeHarnessJobs.id, currentJobId),
      ),
    )
    .get();
  const otherJobs = tx
    .select({
      status: ontocodeHarnessJobs.status,
      createdAt: ontocodeHarnessJobs.createdAt,
    })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, tenantId),
        eq(ontocodeHarnessJobs.sessionId, sessionId),
        ne(ontocodeHarnessJobs.id, currentJobId),
      ),
    )
    .all();
  if (
    otherJobs.some((row) =>
      (ACTIVE_JOB_STATUSES as readonly string[]).includes(row.status),
    )
  ) {
    return "running";
  }
  if (
    otherJobs.some((row) =>
      (PENDING_JOB_STATUSES as readonly string[]).includes(row.status),
    )
  ) {
    return "queued";
  }
  // A newer successful Job is the durable follow-up to an older Factory
  // question. Historical waiting rows remain auditable but must not return the
  // whole Session to needs_user after that follow-up has completed.
  if (
    otherJobs.some(
      (row) =>
        row.status === "waiting_user" &&
        (!currentJob || row.createdAt > currentJob.createdAt),
    )
  ) {
    return "needs_user";
  }
  const pendingDecision = tx
    .select({ id: ontocodeCommands.id })
    .from(ontocodeCommands)
    .where(
      and(
        eq(ontocodeCommands.tenantId, tenantId),
        eq(ontocodeCommands.sessionId, sessionId),
        inArray(ontocodeCommands.status, ["proposed", "awaiting_approval"]),
      ),
    )
    .limit(1)
    .get();
  return pendingDecision ? "review_required" : "idle";
}

function projectOntoCodeBuildExecution(
  tx: DbLike,
  input: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    jobId: string;
    receipt?: Record<string, unknown> | null;
    state:
      | "resuming"
      | "waiting_user"
      | "generated_unverified"
      | "candidate_ready"
      | "failed_recoverable"
      | "failed_terminal";
    now: Date;
  },
): void {
  const receiptExecutionId = nonEmptyString(input.receipt?.buildExecutionId);
  const jobBinding = tx
    .select({ buildExecutionId: ontocodeHarnessJobs.buildExecutionId })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, input.tenantId),
        eq(ontocodeHarnessJobs.id, input.jobId),
      ),
    )
    .get()?.buildExecutionId;
  if (!jobBinding) {
    if (receiptExecutionId) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_execution_job_unbound",
        "The Build result named an execution that is not bound to its Harness Job",
        { recoverable: true, retryable: false },
      );
    }
    return;
  }
  if (receiptExecutionId && receiptExecutionId !== jobBinding) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_receipt_mismatch",
      "The Build result belongs to a different OntoCode execution",
      {
        recoverable: true,
        retryable: false,
        details: {
          jobBuildExecutionId: jobBinding,
          receiptBuildExecutionId: receiptExecutionId,
        },
      },
    );
  }
  const buildExecutionId = jobBinding;
  const execution = tx
    .select({
      state: ontocodeBuildExecutions.state,
      revision: ontocodeBuildExecutions.revision,
      engineRunId: ontocodeBuildExecutions.engineRunId,
    })
    .from(ontocodeBuildExecutions)
    .where(
      and(
        eq(ontocodeBuildExecutions.tenantId, input.tenantId),
        eq(ontocodeBuildExecutions.id, buildExecutionId),
        eq(ontocodeBuildExecutions.projectId, input.projectId),
        eq(ontocodeBuildExecutions.sessionId, input.sessionId),
      ),
    )
    .get();
  if (!execution) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_missing",
      "The Harness Job's OntoCode Build execution no longer exists",
      { recoverable: true, retryable: false },
    );
  }

  const interaction = asRecord(input.receipt?.interaction);
  const checkpointInteraction =
    input.state === "waiting_user" &&
    !interaction &&
    input.receipt?.status === "waiting_human" &&
    execution.engineRunId
      ? (() => {
          const conversation = tx
            .select({
              tenantId: factoryConversations.tenantId,
              ctxJson: factoryConversations.ctxJson,
            })
            .from(factoryConversations)
            .where(eq(factoryConversations.id, execution.engineRunId!))
            .get();
          if (!conversation || conversation.tenantId !== input.tenantId) {
            return null;
          }
          return activeHumanInteraction(
            conversation.ctxJson as Parameters<
              typeof activeHumanInteraction
            >[0],
          );
        })()
      : null;
  const rawKind =
    nonEmptyString(interaction?.kind) ?? checkpointInteraction?.kind ?? null;
  const interactionKind =
    rawKind === "clarify" ||
    rawKind === "test_approval" ||
    rawKind === "boundary" ||
    rawKind === "execution_readiness" ||
    rawKind === "legacy_answer"
      ? rawKind
      : interaction
        ? "execution_readiness"
        : null;
  const interactionSubject = interaction
    ? {
        question: nonEmptyString(interaction.question) ?? "OntoCode input",
        context: interaction.context ?? null,
        options: Array.isArray(interaction.options) ? interaction.options : [],
        items: Array.isArray(interaction.items) ? interaction.items : [],
      }
    : null;
  const interactionDigest = interactionSubject
    ? createHash("sha256")
        .update(canonicalEvidenceJson(interactionSubject))
        .digest("hex")
    : (nonEmptyString(checkpointInteraction?.subjectDigest) ?? null);
  const interactionId =
    (interaction
      ? (nonEmptyString(interaction.interactionId) ??
        (interactionDigest ? `oci-${interactionDigest.slice(0, 16)}` : null))
      : null) ??
    checkpointInteraction?.interactionId ??
    null;
  const isWaiting = input.state === "waiting_user";
  // A recoverable failure is still the same logical Build and may be retried
  // after its external blocker is repaired. Keep the exact interaction/answer
  // envelope across that boundary; otherwise an explicit retry returns to
  // `resuming` without the one-shot answer that authorizes the continuation.
  // Terminal outcomes still fall through to the clearing branch below.
  const preservePendingEnvelope =
    input.state === "resuming" || input.state === "failed_recoverable";
  const update = tx
    .update(ontocodeBuildExecutions)
    .set({
      state: input.state,
      // The engine-checkpoint commit owns checkpointDigest/revision. Lifecycle
      // projection must not count the same receipt as a second checkpoint.
      ...(preservePendingEnvelope
        ? {}
        : {
            pendingInteractionId: isWaiting ? interactionId : null,
            pendingInteractionKind: isWaiting ? interactionKind : null,
            pendingInteractionSubjectDigest: isWaiting
              ? interactionDigest
              : null,
            pendingAnswerId: null,
            pendingAnswerDigest: null,
            pendingAnswerStatus: null,
          }),
      revision: sql`${ontocodeBuildExecutions.revision} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(ontocodeBuildExecutions.tenantId, input.tenantId),
        eq(ontocodeBuildExecutions.id, buildExecutionId),
        eq(ontocodeBuildExecutions.projectId, input.projectId),
        eq(ontocodeBuildExecutions.sessionId, input.sessionId),
        eq(ontocodeBuildExecutions.revision, execution.revision),
        eq(ontocodeBuildExecutions.state, execution.state),
      ),
    )
    .run() as { changes?: number };
  if ((update.changes ?? 0) !== 1) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_projection_failed",
      "OntoCode could not atomically project the Build lifecycle",
      { recoverable: true, retryable: true },
    );
  }
}

export class OntoCodeHarnessWorkerAdapter {
  readonly leaseTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;

  private readonly tenantId?: string;
  private readonly now: () => number;
  private readonly executors: OntoCodeHarnessExecutorRegistry;
  private readonly stopFactoryRun: (runId: string, tenantId: string) => boolean;

  constructor(options: OntoCodeHarnessWorkerOptions = {}) {
    this.leaseTimeoutMs = Math.max(1_000, options.leaseTimeoutMs ?? 60_000);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 5_000);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1_000);
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.stopFactoryRun = options.stopFactoryRun ?? abortRun;
    const factory = options.factory ?? createDefaultOntoCodeFactoryAdapter();
    this.executors = {
      ...createDefaultOntoCodeHarnessExecutors(factory),
      ...(options.executors ?? {}),
    };
  }

  /**
   * Atomically leases one eligible job. `started_at` is intentionally used as
   * the per-claim fencing epoch because the first OntoCode migration has no
   * lease-owner/token columns. Every later write compares this exact epoch.
   */
  claimNextJob(): OntoCodeHarnessClaim | null {
    const nowMs = this.now();
    const now = new Date(nowMs);
    const staleBefore = new Date(nowMs - this.leaseTimeoutMs);
    const retryBefore = new Date(nowMs - this.retryDelayMs);
    const db = getDb();

    return db.transaction((tx) => {
      const tenantFilter = this.tenantId
        ? eq(ontocodeHarnessJobs.tenantId, this.tenantId)
        : undefined;
      const eligibility = or(
        eq(ontocodeHarnessJobs.status, "queued"),
        and(
          eq(ontocodeHarnessJobs.status, "retry_scheduled"),
          lte(ontocodeHarnessJobs.updatedAt, retryBefore),
        ),
        and(
          inArray(ontocodeHarnessJobs.status, ["leased", "running"]),
          lte(ontocodeHarnessJobs.updatedAt, staleBefore),
        ),
      );
      const candidates = tx
        .select()
        .from(ontocodeHarnessJobs)
        .where(tenantFilter ? and(tenantFilter, eligibility) : eligibility)
        .orderBy(
          asc(ontocodeHarnessJobs.updatedAt),
          asc(ontocodeHarnessJobs.createdAt),
          asc(ontocodeHarnessJobs.id),
        )
        .limit(50)
        .all();

      for (const candidate of candidates) {
        // One session is one conversational engineering flow. Serialize its
        // Harness jobs so two workers cannot race session phase/activity state.
        const sibling = tx
          .select({ id: ontocodeHarnessJobs.id })
          .from(ontocodeHarnessJobs)
          .where(
            and(
              eq(ontocodeHarnessJobs.tenantId, candidate.tenantId),
              eq(ontocodeHarnessJobs.sessionId, candidate.sessionId),
              ne(ontocodeHarnessJobs.id, candidate.id),
              inArray(ontocodeHarnessJobs.status, ["leased", "running"]),
            ),
          )
          .limit(1)
          .get();
        if (sibling) continue;

        const session = tx
          .select({
            projectId: ontocodeSessions.projectId,
          })
          .from(ontocodeSessions)
          .where(
            and(
              eq(ontocodeSessions.tenantId, candidate.tenantId),
              eq(ontocodeSessions.id, candidate.sessionId),
            ),
          )
          .get();
        if (!session) continue;

        const previousStatus = candidate.status;
        const previousLease =
          candidate.startedAt instanceof Date
            ? candidate.startedAt.getTime()
            : -1;
        const leaseToken = Math.max(nowMs, previousLease + 1);
        const update = tx
          .update(ontocodeHarnessJobs)
          .set({
            status: "leased",
            startedAt: new Date(leaseToken),
            finishedAt: null,
            errorMessage: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(ontocodeHarnessJobs.tenantId, candidate.tenantId),
              eq(ontocodeHarnessJobs.id, candidate.id),
              eq(ontocodeHarnessJobs.status, candidate.status),
              eq(ontocodeHarnessJobs.updatedAt, candidate.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) continue;

        const recovered =
          previousStatus === "leased" || previousStatus === "running";
        if (recovered) {
          appendWorkerEvent(
            tx,
            {
              tenantId: candidate.tenantId,
              projectId: session.projectId,
              sessionId: candidate.sessionId,
              jobId: candidate.id,
              commandId: candidate.commandId ?? null,
              type: "harness.job.recovered",
              visibility: "audit",
              payload: {
                jobId: candidate.id,
                previousStatus,
                previousLeaseToken: previousLease >= 0 ? previousLease : null,
                leaseToken,
              },
              causationId: `${candidate.id}:${leaseToken}`,
            },
            now,
          );
        }
        appendWorkerEvent(
          tx,
          {
            tenantId: candidate.tenantId,
            projectId: session.projectId,
            sessionId: candidate.sessionId,
            jobId: candidate.id,
            commandId: candidate.commandId ?? null,
            type: "harness.job.leased",
            visibility: "audit",
            payload: {
              jobId: candidate.id,
              previousStatus,
              recovered,
              leaseToken,
            },
            causationId: `${candidate.id}:${leaseToken}`,
          },
          now,
        );
        return {
          jobId: candidate.id,
          tenantId: candidate.tenantId,
          sessionId: candidate.sessionId,
          leaseToken,
          recovered,
          previousStatus,
        };
      }
      return null;
    });
  }

  heartbeat(claim: OntoCodeHarnessClaim): boolean {
    const result = getDb()
      .update(ontocodeHarnessJobs)
      .set({ updatedAt: new Date(this.now()) })
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
          eq(ontocodeHarnessJobs.id, claim.jobId),
          eq(ontocodeHarnessJobs.status, "running"),
          eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
        ),
      )
      .run();
    return result.changes === 1;
  }

  private loadContext(
    claim: OntoCodeHarnessClaim,
  ): OntoCodeHarnessLoadedContext {
    const scope = { tenantId: claim.tenantId };
    const job = getOntoCodeHarnessJob(scope, claim.jobId);
    const session = getOntoCodeSession(scope, job.sessionId);
    const project = getOntoCodeProject(scope, session.projectId);
    const command = job.commandId
      ? getOntoCodeCommand(scope, job.commandId)
      : null;
    const tenant = getDb()
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, claim.tenantId))
      .get();
    if (
      !tenant ||
      job.tenantId !== claim.tenantId ||
      job.sessionId !== claim.sessionId ||
      session.tenantId !== claim.tenantId ||
      project.tenantId !== claim.tenantId ||
      project.id !== session.projectId ||
      (job.runtimeProfileVersionId ?? null) !==
        (session.runtimeProfileVersionId ?? null) ||
      (session.runtimeProfileVersionId ?? null) !==
        (project.runtimeProfileVersionId ?? null) ||
      (command &&
        (command.tenantId !== claim.tenantId ||
          command.sessionId !== session.id))
    ) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_job_scope_corrupt",
        "The claimed job does not resolve to one tenant-scoped OntoCode session",
        { recoverable: false, retryable: false },
      );
    }
    if (job.runtimeProfileVersionId) {
      const binding = assertRuntimeProfileVersionForTenant(
        getDb(),
        { tenantId: claim.tenantId, tenantSlug: tenant.slug },
        job.runtimeProfileVersionId,
      );
      if (!binding.readiness.executable) {
        throw new OntoCodeHarnessExecutionError(
          binding.readiness.code,
          binding.readiness.message,
          {
            recoverable: true,
            retryable: false,
            details: {
              tenantId: claim.tenantId,
              businessTenantSlug: tenant.slug,
              runtimeProfileVersionId: binding.version?.id ?? null,
              adapterRegistrySlug:
                binding.version?.adapter.adapterRegistrySlug ?? null,
              credentialScope: "business_domain",
            },
          },
        );
      }
      const version = binding.version;
      const snapshot = version
        ? getRuntimeTenantRegistrySnapshot(version.adapter.adapterRegistrySlug)
        : undefined;
      if (
        !version ||
        !snapshot ||
        snapshot.selectedVersion !== version.adapter.adapterRegistryVersion
      ) {
        throw new OntoCodeHarnessExecutionError(
          "runtime_profile_adapter_version_unavailable",
          "The exact Runtime Profile adapter version is not loaded in this process",
          {
            recoverable: true,
            retryable: false,
            details: {
              tenantId: claim.tenantId,
              businessTenantSlug: tenant.slug,
              runtimeProfileVersionId: job.runtimeProfileVersionId,
              adapterRegistrySlug: version?.adapter.adapterRegistrySlug ?? null,
              expectedAdapterRegistryVersion:
                version?.adapter.adapterRegistryVersion ?? null,
              selectedAdapterRegistryVersion: snapshot?.selectedVersion ?? null,
            },
          },
        );
      }
    }
    return { job, session, project, command, tenantSlug: tenant.slug };
  }

  private markRunning(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
  ): number | null {
    const now = new Date(this.now());
    return getDb().transaction((tx) => {
      const durableJob = tx
        .select({ attemptNo: ontocodeHarnessJobs.attemptNo })
        .from(ontocodeHarnessJobs)
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "leased"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .get();
      if (!durableJob) throw new OntoCodeHarnessLostLeaseError(claim.jobId);
      // OntoCode owns the logical attempt counter. Session events mirror it for
      // audit, but recovery never reconstructs state by counting those rows.
      const attempt = durableJob.attemptNo + 1;
      const candidateFailure = exactCandidateTargetFailure(tx, data);
      if (candidateFailure) {
        const rejected = tx
          .update(ontocodeHarnessJobs)
          .set({
            status: "failed_recoverable",
            attemptNo: attempt,
            errorMessage: candidateFailure.message,
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
              eq(ontocodeHarnessJobs.id, claim.jobId),
              eq(ontocodeHarnessJobs.status, "leased"),
              eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
            ),
          )
          .run();
        if (rejected.changes !== 1) {
          throw new OntoCodeHarnessLostLeaseError(claim.jobId);
        }
        if (data.command) {
          tx.update(ontocodeCommands)
            .set({ status: "failed", updatedAt: now })
            .where(
              and(
                eq(ontocodeCommands.tenantId, claim.tenantId),
                eq(ontocodeCommands.id, data.command.id),
              ),
            )
            .run();
        }
        tx.update(ontocodeSessions)
          .set({
            phase: phaseForJob(data.job.kind),
            activityState: "failed_recoverable",
            revision: sql`${ontocodeSessions.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(ontocodeSessions.tenantId, claim.tenantId),
              eq(ontocodeSessions.id, claim.sessionId),
            ),
          )
          .run();
        appendWorkerEvent(
          tx,
          {
            tenantId: claim.tenantId,
            projectId: data.project.id,
            sessionId: claim.sessionId,
            jobId: claim.jobId,
            commandId: data.command?.id ?? null,
            type: "harness.job.failed",
            payload: {
              jobId: claim.jobId,
              kind: data.job.kind,
              attempt,
              status: "failed_recoverable",
              error: candidateFailure,
              executionStarted: false,
            },
            causationId: `${claim.jobId}:${claim.leaseToken}:candidate-gate`,
          },
          now,
        );
        appendAssistantMessage(
          tx,
          {
            tenantId: claim.tenantId,
            sessionId: claim.sessionId,
            jobId: claim.jobId,
            commandId: data.command?.id ?? null,
            leaseToken: claim.leaseToken,
            type: "error",
            text: productFacingOntoCodeText(
              `OntoCode 未启动候选测试：${candidateFailure.message}`,
            ),
            content: {
              kind: data.job.kind,
              status: "failed_recoverable",
              error: candidateFailure,
            },
          },
          now,
        );
        return null;
      }
      const update = tx
        .update(ontocodeHarnessJobs)
        .set({ status: "running", attemptNo: attempt, updatedAt: now })
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "leased"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .run();
      if (update.changes !== 1) {
        throw new OntoCodeHarnessLostLeaseError(claim.jobId);
      }
      if (data.command) {
        tx.update(ontocodeCommands)
          .set({ status: "running", updatedAt: now })
          .where(
            and(
              eq(ontocodeCommands.tenantId, claim.tenantId),
              eq(ontocodeCommands.id, data.command.id),
            ),
          )
          .run();
      }
      tx.update(ontocodeSessions)
        .set({
          phase: phaseForJob(data.job.kind),
          activityState: "running",
          revision: sql`${ontocodeSessions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeSessions.tenantId, claim.tenantId),
            eq(ontocodeSessions.id, claim.sessionId),
          ),
        )
        .run();
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type: "harness.job.started",
          payload: {
            jobId: claim.jobId,
            kind: data.job.kind,
            attempt,
            maxAttempts: this.maxAttempts,
            recovered: claim.recovered,
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:start`,
        },
        now,
      );
      return attempt;
    });
  }

  private async latestReceipt(
    claim: OntoCodeHarnessClaim,
    type: string,
  ): Promise<Record<string, unknown> | null> {
    const row = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, claim.tenantId),
          eq(ontocodeSessionEvents.sessionId, claim.sessionId),
          eq(ontocodeSessionEvents.type, type),
        ),
      )
      .orderBy(desc(ontocodeSessionEvents.seq))
      .limit(1)
      .get();
    const payload = row ? parseEventPayload(row.payloadJson) : null;
    const receipt = payload?.receipt;
    return receipt !== null &&
      typeof receipt === "object" &&
      !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>)
      : null;
  }

  /**
   * #FAILURE-RECEIPT — 本 Session 最近一条带失败回执的终态事件。
   *
   * 认的是【回执自己声明的 schema】，不是一张事件类型白名单：`harness.job.failed` 与
   * `harness.<kind>.failed` 同样匹配类型模式，但只有后者带回执；将来新增任何终态失败事件
   * 类型也不需要改这里。扫描有界（最近 SCAN 条），扫不到就是 null。
   */
  private async latestFailureReceipt(
    claim: OntoCodeHarnessClaim,
  ): Promise<Record<string, unknown> | null> {
    const SCAN = 20;
    const rows = getDb()
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, claim.tenantId),
          eq(ontocodeSessionEvents.sessionId, claim.sessionId),
          like(ontocodeSessionEvents.type, "harness.%.failed"),
        ),
      )
      .orderBy(desc(ontocodeSessionEvents.seq))
      .limit(SCAN)
      .all();
    for (const row of rows) {
      const receipt = asRecord(parseEventPayload(row.payloadJson)?.receipt);
      if (receipt?.schema === ONTOCODE_FAILURE_RECEIPT_SCHEMA) return receipt;
    }
    return null;
  }

  private async appendProgress(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    type: string,
    payload: Record<string, unknown>,
    visibility: "user" | "debug" | "audit" = "user",
  ): Promise<void> {
    const now = new Date(this.now());
    getDb().transaction((tx) => {
      // A durable progress frame is also an unambiguous liveness signal from
      // this exact fenced owner. Renew the lease in the SAME transaction as
      // the frame: a delayed timer callback must not leave a job reclaimable
      // immediately after it recorded fresh model/tool activity.
      //
      // Use UPDATE rather than a read-then-write so the started_at fencing
      // epoch remains the single CAS. If another worker already reclaimed the
      // row, neither the lease nor the stale owner's progress event is written.
      const owned = tx
        .update(ontocodeHarnessJobs)
        .set({ updatedAt: now })
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "running"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .run();
      if (owned.changes !== 1) {
        throw new OntoCodeHarnessLostLeaseError(claim.jobId);
      }
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type,
          payload: { jobId: claim.jobId, ...payload },
          visibility,
          causationId: `${claim.jobId}:${claim.leaseToken}:${type}`,
        },
        now,
      );
    });
  }

  private finalizeSuccess(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    attempt: number,
    result: OntoCodeHarnessExecutorResult,
  ): void {
    const now = new Date(this.now());
    getDb().transaction((tx) => {
      const update = tx
        .update(ontocodeHarnessJobs)
        .set({
          status: "succeeded",
          errorMessage: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "running"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .run();
      if (update.changes !== 1) {
        throw new OntoCodeHarnessLostLeaseError(claim.jobId);
      }
      if (data.command) {
        tx.update(ontocodeCommands)
          .set({ status: "succeeded", updatedAt: now })
          .where(
            and(
              eq(ontocodeCommands.tenantId, claim.tenantId),
              eq(ontocodeCommands.id, data.command.id),
            ),
          )
          .run();
      }
      const continuation = prepareAutopilotBuildContinuation(
        tx,
        claim,
        data,
        result,
        now,
      );
      const activityState = activityAfterSuccess(
        tx,
        claim.tenantId,
        claim.sessionId,
        claim.jobId,
      );
      tx.update(ontocodeSessions)
        .set({
          ...(result.phase ? { phase: result.phase } : {}),
          activityState,
          ...(typeof result.receipt.ontologyHash === "string"
            ? {
                ontologySnapshotHash: result.receipt.ontologyHash,
              }
            : {}),
          revision: sql`${ontocodeSessions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeSessions.tenantId, claim.tenantId),
            eq(ontocodeSessions.id, claim.sessionId),
          ),
        )
        .run();
      const persisted = persistHarnessResult(tx, claim, data, result, now);
      if (data.job.kind === "build") {
        projectOntoCodeBuildExecution(tx, {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          receipt: result.receipt,
          state: persisted.candidatePackageVersionId
            ? "candidate_ready"
            : "generated_unverified",
          now,
        });
      }
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type: `harness.${data.job.kind}.completed`,
          payload: {
            jobId: claim.jobId,
            kind: data.job.kind,
            attempt,
            receipt: result.receipt,
            artifacts: persisted.artifacts,
            evidenceId: persisted.evidenceId,
            evidenceOutcome: persisted.evidenceOutcome,
            changeSetId: persisted.changeSetId,
            candidatePackageVersionId: persisted.candidatePackageVersionId,
            candidateDependencyRoot: persisted.candidateDependencyRoot,
            candidateHeadId: persisted.candidateHeadId,
            candidateHeadRevision: persisted.candidateHeadRevision,
            deliveryState: persisted.deliveryState,
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:result`,
        },
        now,
      );
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type: "harness.job.succeeded",
          payload: {
            jobId: claim.jobId,
            kind: data.job.kind,
            attempt,
            phase: result.phase ?? phaseForJob(data.job.kind),
            activityState,
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:success`,
        },
        now,
      );
      appendAssistantMessage(
        tx,
        {
          tenantId: claim.tenantId,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          leaseToken: claim.leaseToken,
          type: "receipt",
          text: completedAssistantText(data.job.kind, result.message),
          content: {
            kind: data.job.kind,
            status: "succeeded",
            ...(result.charts?.length ? { charts: result.charts } : {}),
            ...(result.tables?.length ? { tables: result.tables } : {}),
            receipt: result.receipt,
            artifacts: persisted.artifacts,
            evidenceId: persisted.evidenceId,
            evidenceOutcome: persisted.evidenceOutcome,
            candidatePackageVersionId: persisted.candidatePackageVersionId,
            candidateDependencyRoot: persisted.candidateDependencyRoot,
            candidateHeadId: persisted.candidateHeadId,
            candidateHeadRevision: persisted.candidateHeadRevision,
            deliveryState: persisted.deliveryState,
          },
        },
        now,
      );
      if (continuation) {
        appendAutopilotBuildContinuation(tx, claim, data, continuation, now);
      }
    });
  }

  private finalizeWaiting(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    attempt: number,
    result: OntoCodeHarnessExecutorResult,
  ): void {
    const now = new Date(this.now());
    const message = productFacingOntoCodeText(
      result.message?.trim() ||
        "OntoCode needs additional user input before it can continue.",
    );
    const question = resolveStructuredWaitingQuestion(
      data.job.kind,
      message,
      result,
    );
    getDb().transaction((tx) => {
      const update = tx
        .update(ontocodeHarnessJobs)
        .set({
          status: "waiting_user",
          errorMessage: message,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "running"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .run();
      if (update.changes !== 1) {
        throw new OntoCodeHarnessLostLeaseError(claim.jobId);
      }
      if (data.command) {
        // Command status has no waiting state. Returning to approved allows the
        // conversation to attach a new, idempotent job after the FDE answers.
        tx.update(ontocodeCommands)
          .set({ status: "approved", updatedAt: now })
          .where(
            and(
              eq(ontocodeCommands.tenantId, claim.tenantId),
              eq(ontocodeCommands.id, data.command.id),
            ),
          )
          .run();
      }
      tx.update(ontocodeSessions)
        .set({
          ...(result.phase ? { phase: result.phase } : {}),
          activityState: "needs_user",
          revision: sql`${ontocodeSessions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeSessions.tenantId, claim.tenantId),
            eq(ontocodeSessions.id, claim.sessionId),
          ),
        )
        .run();
      const persisted = persistHarnessResult(tx, claim, data, result, now);
      if (data.job.kind === "build") {
        projectOntoCodeBuildExecution(tx, {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          receipt: result.receipt,
          state: "waiting_user",
          now,
        });
      }
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type: `harness.${data.job.kind}.waiting_user`,
          payload: {
            jobId: claim.jobId,
            kind: data.job.kind,
            attempt,
            message,
            question,
            receipt: result.receipt,
            artifacts: persisted.artifacts,
            evidenceId: persisted.evidenceId,
            evidenceOutcome: persisted.evidenceOutcome,
            changeSetId: persisted.changeSetId,
            candidatePackageVersionId: persisted.candidatePackageVersionId,
            candidateDependencyRoot: persisted.candidateDependencyRoot,
            candidateHeadId: persisted.candidateHeadId,
            candidateHeadRevision: persisted.candidateHeadRevision,
            deliveryState: persisted.deliveryState,
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:waiting`,
        },
        now,
      );
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type: "harness.job.waiting_user",
          payload: {
            jobId: claim.jobId,
            attempt,
            message,
            evidenceId: persisted.evidenceId,
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:waiting-state`,
        },
        now,
      );
      appendAssistantMessage(
        tx,
        {
          tenantId: claim.tenantId,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          leaseToken: claim.leaseToken,
          type: "recommendation",
          text: message,
          content: {
            kind: data.job.kind,
            status: "waiting_user",
            receipt: result.receipt,
            artifacts: persisted.artifacts,
            evidenceId: persisted.evidenceId,
            evidenceOutcome: persisted.evidenceOutcome,
            candidatePackageVersionId: persisted.candidatePackageVersionId,
            candidateDependencyRoot: persisted.candidateDependencyRoot,
            candidateHeadId: persisted.candidateHeadId,
            candidateHeadRevision: persisted.candidateHeadRevision,
            deliveryState: persisted.deliveryState,
          },
        },
        now,
      );
    });
    // The durable waiting receipt is committed above. Deriving a Configuration
    // Task from it is best-effort and fail-closed: on any refusal the
    // structured question card remains the FDE's authoritative fallback path.
    try {
      createConfigurationTaskForWaitingJob({
        tenantId: claim.tenantId,
        actorId: data.job.createdBy ?? null,
        sessionId: claim.sessionId,
        jobId: claim.jobId,
        jobKind: data.job.kind,
        receipt: result.receipt,
        question,
      });
    } catch {
      // A failed auto-derivation must never disturb the parked waiting state.
    }
  }

  private async finalizeFailure(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    attempt: number,
    failure: NormalizedExecutionFailure,
  ): Promise<void> {
    const retry = failure.retryable && attempt < this.maxAttempts;
    const status: OntoCodeHarnessJob["status"] = retry
      ? "retry_scheduled"
      : failure.recoverable
        ? "failed_recoverable"
        : "failed_terminal";
    const now = new Date(this.now());
    // #FAILURE-RECEIPT — 终态失败和 done / waiting_user 一样必须留下不可变回执。证据收集在
    // 事务【之外】完成：它要读盘上的 NDJSON 转录，而 better-sqlite3 的事务是同步的；同时也
    // 保证一次读不到证据绝不会连带回滚「这个作业失败了」这条事实。
    // 回执要落成不可变产物并进聊天流，而转录里的失败帧原文完全可能带着简历里的邮箱/电话。
    // 所以它和其它 Factory 来源的持久行走【同一道】脱敏边界（密钥形值由证据读路径先扫过一遍，
    // 这里再补一遍常见联系方式 PII）。
    // `failure.details` can carry a VERBATIM excerpt of a model answer (a
    // no_json/invalid_json cause quotes what the model wrote about the FDE's own
    // scenario). It is written to three sinks in this one transaction — the
    // receipt, the durable failed event, and the assistant chat message — and
    // only the receipt crossed the redaction boundary, so the artifact could say
    // [REDACTED] while the transcript beside it carried the raw text. One
    // scrubbed object, used everywhere, keeps all three byte-identical.
    const safeDetails = failure.details
      ? (redactHarnessTelemetryPayload(failure.details) as Record<
          string,
          unknown
        >)
      : undefined;
    const productDetails = safeDetails
      ? (productFacingOntoCodePayload(safeDetails) as Record<string, unknown>)
      : undefined;
    const productFailure = {
      code: productFacingOntoCodeText(failure.code),
      message: productFacingOntoCodeText(failure.message),
      recoverable: failure.recoverable,
      retryable: failure.retryable,
      ...(productDetails ? { details: productDetails } : {}),
    };
    const rawReceipt = retry
      ? null
      : await buildOntoCodeFailureReceipt({
          tenantId: claim.tenantId,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          jobKind: data.job.kind,
          attempt,
          maxAttempts: this.maxAttempts,
          status: status as "failed_recoverable" | "failed_terminal",
          targetPhase: phaseForJob(data.job.kind),
          sessionPhase: data.session.phase,
          ontologyHash: data.session.ontologySnapshotHash,
          commandId: data.command?.id ?? null,
          error: {
            code: failure.code,
            message: failure.message,
            recoverable: failure.recoverable,
            retryable: failure.retryable,
            ...(safeDetails ? { details: safeDetails } : {}),
          },
          finishedAt: now.getTime(),
        });
    const receipt = rawReceipt
      ? redactHarnessTelemetryPayload(rawReceipt)
      : null;
    getDb().transaction((tx) => {
      const update = tx
        .update(ontocodeHarnessJobs)
        .set({
          status,
          errorMessage: productFailure.message,
          finishedAt: retry ? null : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "running"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .run();
      if (update.changes !== 1) {
        throw new OntoCodeHarnessLostLeaseError(claim.jobId);
      }
      if (data.job.kind === "build") {
        projectOntoCodeBuildExecution(tx, {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          state: retry
            ? "resuming"
            : status === "failed_terminal"
              ? "failed_terminal"
              : "failed_recoverable",
          now,
        });
      }
      if (data.command) {
        tx.update(ontocodeCommands)
          .set({
            status: retry ? "queued" : "failed",
            updatedAt: now,
          })
          .where(
            and(
              eq(ontocodeCommands.tenantId, claim.tenantId),
              eq(ontocodeCommands.id, data.command.id),
            ),
          )
          .run();
      }
      tx.update(ontocodeSessions)
        .set({
          activityState: retry ? "queued" : "failed_recoverable",
          revision: sql`${ontocodeSessions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(ontocodeSessions.tenantId, claim.tenantId),
            eq(ontocodeSessions.id, claim.sessionId),
          ),
        )
        .run();
      appendWorkerEvent(
        tx,
        {
          tenantId: claim.tenantId,
          projectId: data.project.id,
          sessionId: claim.sessionId,
          jobId: claim.jobId,
          commandId: data.command?.id ?? null,
          type: retry ? "harness.job.retry_scheduled" : "harness.job.failed",
          payload: {
            jobId: claim.jobId,
            kind: data.job.kind,
            attempt,
            maxAttempts: this.maxAttempts,
            status,
            // Durable recovery protocol input, not a conversation projection.
            // Reconcile/reattach must keep matching the exact engine code.
            error: {
              code: failure.code,
              message: failure.message,
              recoverable: failure.recoverable,
              retryable: failure.retryable,
              ...(safeDetails ? { details: safeDetails } : {}),
            },
            ...(retry ? { retryAfterMs: this.retryDelayMs } : {}),
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:${status}`,
        },
        now,
      );
      if (!retry) {
        // 与 harness.<kind>.completed / harness.<kind>.waiting_user 同一条路：不可变回执
        // 进产物 + 证据记录，再随 kind 级终态事件与助手消息一起送到 FDE 面前。
        // 回执缺席（理论上只可能是未来某次改动漏了构造）不得连带吞掉「作业失败了」这条
        // 消息本身——那才是 FDE 最起码要看到的一句。
        const persisted = receipt
          ? persistHarnessFailureResult(
              tx,
              claim,
              data,
              attempt,
              status as "failed_recoverable" | "failed_terminal",
              receipt,
              now,
            )
          : null;
        if (receipt && persisted) {
          appendWorkerEvent(
            tx,
            {
              tenantId: claim.tenantId,
              projectId: data.project.id,
              sessionId: claim.sessionId,
              jobId: claim.jobId,
              commandId: data.command?.id ?? null,
              type: `harness.${data.job.kind}.failed`,
              payload: {
                jobId: claim.jobId,
                kind: data.job.kind,
                attempt,
                status,
                message: productFailure.message,
                receipt,
                artifacts: persisted.artifacts,
                evidenceId: persisted.evidenceId,
                changeSetId: persisted.changeSetId,
              },
              causationId: `${claim.jobId}:${claim.leaseToken}:failure-receipt`,
            },
            now,
          );
        }
        appendAssistantMessage(
          tx,
          {
            tenantId: claim.tenantId,
            sessionId: claim.sessionId,
            jobId: claim.jobId,
            commandId: data.command?.id ?? null,
            leaseToken: claim.leaseToken,
            type: "error",
            text: failedAssistantText(
              data.job.kind,
              productFailure.message,
              receipt,
            ),
            content: {
              kind: data.job.kind,
              status,
              error: productFailure,
              ...(receipt ? { receipt } : {}),
              ...(persisted
                ? {
                    artifacts: persisted.artifacts,
                    evidenceId: persisted.evidenceId,
                  }
                : {}),
            },
          },
          now,
        );
      }
    });
  }

  async runNext(
    options: { signal?: AbortSignal } = {},
  ): Promise<OntoCodeHarnessRunResult> {
    const claim = this.claimNextJob();
    if (!claim) return { claimed: false };

    let data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>;
    let attempt: number | null;
    try {
      data = this.loadContext(claim);
      attempt = this.markRunning(claim, data);
      if (attempt === null) {
        return {
          claimed: true,
          jobId: claim.jobId,
          status: "failed_recoverable",
        };
      }
    } catch (error) {
      if (error instanceof OntoCodeHarnessLostLeaseError) {
        return { claimed: true, jobId: claim.jobId, status: "lost_lease" };
      }
      // Broken FK/tenant state is not safe to guess around. Leave the lease to
      // expire so an operator can inspect the durable claim events.
      throw error;
    }

    const executor = this.executors[data.job.kind];
    const controller = new AbortController();
    let abortReason: unknown;
    const abort = (reason: unknown): void => {
      if (controller.signal.aborted) return;
      abortReason = reason;
      controller.abort(reason);
    };
    const onParentAbort = () =>
      abort(
        options.signal?.reason ??
          new OntoCodeHarnessExecutionError(
            "worker_stopped",
            "OntoCode Harness Worker is stopping; the job will be retried",
            { recoverable: true, retryable: true },
          ),
      );
    if (options.signal?.aborted) onParentAbort();
    else
      options.signal?.addEventListener("abort", onParentAbort, { once: true });

    const maxWallClockMs = data.job.budget?.maxWallClockMs;
    const wallClockPolicy = resolveWallClockPolicy(data.job.kind);
    let budgetWarned = false;
    const timeout =
      maxWallClockMs === undefined
        ? null
        : setTimeout(() => {
            if (wallClockPolicy === "warn") {
              // Generative kinds treat the wall clock as advisory: one durable
              // warning event, no abort (spec §5.1; staged checkpoints are an
              // M3 concern). Heartbeats keep renewing the lease as before.
              if (budgetWarned) return;
              budgetWarned = true;
              try {
                getDb().transaction((tx) => {
                  appendWorkerEvent(
                    tx,
                    {
                      tenantId: claim.tenantId,
                      projectId: data.project.id,
                      sessionId: claim.sessionId,
                      jobId: claim.jobId,
                      commandId: data.command?.id ?? null,
                      type: "harness.job.budget_warning",
                      payload: {
                        jobId: claim.jobId,
                        kind: data.job.kind,
                        elapsedMs: Math.max(0, this.now() - claim.leaseToken),
                        limitMs: maxWallClockMs,
                      },
                      causationId: `${claim.jobId}:${claim.leaseToken}:budget-warning`,
                    },
                    new Date(this.now()),
                  );
                });
              } catch {
                // The warning is advisory; a failed event write must never
                // affect the still-running job.
              }
              return;
            }
            abort(
              new OntoCodeHarnessExecutionError(
                "wall_clock_budget_exceeded",
                `Harness execution exceeded its ${maxWallClockMs}ms wall-clock budget`,
                {
                  recoverable: true,
                  // Retrying the same deterministic workflow with the same
                  // fixed deadline only repeats an expensive timeout. The
                  // FDE can retry after changing the budget, model route, or
                  // workflow inputs.
                  retryable: false,
                },
              ),
            );
          }, maxWallClockMs);
    timeout?.unref?.();
    const heartbeatEvery = Math.max(
      250,
      Math.min(10_000, Math.floor(this.leaseTimeoutMs / 3)),
    );
    // The heartbeat runs a synchronous better-sqlite3 UPDATE inside a timer
    // callback. Unguarded, a throw here — a WAL checkpoint stall, writer-lease
    // contention, a transient SQLITE_BUSY — escapes as an uncaughtException and
    // takes down the whole API process. This repo has documented history with
    // writer-lease stalls, so that is not a hypothetical trigger.
    //
    // A throw and a lost lease are different facts and must be treated
    // differently: `changes !== 1` PROVES another worker owns the job, so abort.
    // A throw proves nothing about ownership — keep running, and only give up
    // after enough consecutive failures that the DB is clearly not coming back.
    const MAX_CONSECUTIVE_HEARTBEAT_FAULTS = 5;
    let heartbeatFaults = 0;
    const heartbeatTimer = setInterval(() => {
      let owned: boolean;
      try {
        owned = this.heartbeat(claim);
        heartbeatFaults = 0;
      } catch (error) {
        heartbeatFaults += 1;
        if (heartbeatFaults >= MAX_CONSECUTIVE_HEARTBEAT_FAULTS) {
          abort(
            new OntoCodeHarnessExecutionError(
              "harness_heartbeat_unavailable",
              `The harness lease heartbeat failed ${heartbeatFaults} times in a row: ${error instanceof Error ? error.message : String(error)}`,
              { recoverable: true, retryable: true },
            ),
          );
        }
        return;
      }
      if (!owned) abort(new OntoCodeHarnessLostLeaseError(claim.jobId));
    }, heartbeatEvery);
    heartbeatTimer.unref?.();

    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortReason ?? controller.signal.reason);
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => reject(abortReason ?? controller.signal.reason),
        { once: true },
      );
    });

    const executionContext: OntoCodeHarnessExecutionContext = {
      claim,
      ...data,
      attempt,
      signal: controller.signal,
      progress: (type, payload, visibility) =>
        this.appendProgress(claim, data, type, payload, visibility),
      latestReceipt: (type) => this.latestReceipt(claim, type),
      latestFailureReceipt: () => this.latestFailureReceipt(claim),
    };

    try {
      enforceCommandAuthorization(executionContext);
      try {
        assertOntoCodeOntologyBinding(
          { tenantId: claim.tenantId },
          data.project.domain,
          data.project.ontologyDomainRegistrationId,
          data.project.runtimeProfileVersionId,
        );
      } catch (error) {
        throw new OntoCodeHarnessExecutionError(
          "ontocode_ontology_binding_drift",
          error instanceof Error
            ? error.message
            : "The Session Project's exact Ontology Domain registration is no longer active under this Business Domain",
          {
            recoverable: true,
            retryable: false,
            details: {
              tenantId: claim.tenantId,
              projectId: data.project.id,
              projectDomain: data.project.domain,
            },
          },
        );
      }
      enforceProductionAuthorization(executionContext);
      if (!executor) {
        throw new OntoCodeHarnessExecutionError(
          "executor_not_available",
          `OntoCode Harness has no safe executor for job kind ${data.job.kind}`,
          {
            recoverable: true,
            retryable: false,
            details: {
              supportedKinds: Object.keys(this.executors).sort(),
            },
          },
        );
      }
      // Own the LLM attribution scope for this whole job. The Factory model
      // adapter refuses an unscoped central-gateway call, and the Harness is a
      // separate entry point from the Factory RUN path that owns the only other
      // scope — so without this every model-using kind (scope, ontology_analysis,
      // blueprint, …) fails before the provider is reached. Wrapping the single
      // executor seam covers the kinds that exist and the ones added later.
      const result = await Promise.race([
        Promise.resolve().then(() =>
          runWithLlmCallContext(
            {
              tenantId: claim.tenantId,
              tenantSlug: data.tenantSlug,
              domain: data.project.domain,
              conversationId: claim.sessionId,
            },
            () => executor(executionContext),
          ),
        ),
        abortPromise,
      ]);
      const finalResult = terminalizeGeneratedUnverifiedBuild(
        data.job.kind,
        result,
      );
      if (finalResult.outcome === "waiting_user") {
        this.finalizeWaiting(claim, data, attempt, finalResult);
        // The OntoCode receipt/evidence transaction is now committed. Only
        // after that durable handoff do we stop the parked Factory run, so a
        // server crash cannot leave the user with neither a prompt nor a run.
        const factoryRunId = nonEmptyString(finalResult.receipt.factoryRunId);
        if (factoryRunId) {
          this.stopFactoryRun(factoryRunId, claim.tenantId);
        }
      } else {
        this.finalizeSuccess(claim, data, attempt, finalResult);
        // A complete generated-unverified Candidate can be terminal for the
        // OntoCode Build while its private kernel is still parked at an
        // execution-readiness suggestion. Stop that superseded private wait
        // only after the Candidate and completed Build are durable.
        if (result.outcome === "waiting_user") {
          const factoryRunId = nonEmptyString(result.receipt.factoryRunId);
          if (factoryRunId) {
            this.stopFactoryRun(factoryRunId, claim.tenantId);
          }
        }
      }
    } catch (error) {
      if (
        error instanceof OntoCodeHarnessLostLeaseError ||
        abortReason instanceof OntoCodeHarnessLostLeaseError
      ) {
        return { claimed: true, jobId: claim.jobId, status: "lost_lease" };
      }
      try {
        await this.finalizeFailure(
          claim,
          data,
          attempt,
          normalizeFailure(error),
        );
      } catch (finalizeError) {
        if (finalizeError instanceof OntoCodeHarnessLostLeaseError) {
          return { claimed: true, jobId: claim.jobId, status: "lost_lease" };
        }
        throw finalizeError;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      clearInterval(heartbeatTimer);
      options.signal?.removeEventListener("abort", onParentAbort);
    }

    return {
      claimed: true,
      jobId: claim.jobId,
      status: getOntoCodeHarnessJob({ tenantId: claim.tenantId }, claim.jobId)
        .status,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonEmptySourceText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function requireCurrentOntology(
  context: OntoCodeHarnessExecutionContext,
  ontology: DomainOntology,
  options: { requireSnapshot: boolean },
): string {
  if (ontology.domainId !== context.project.domain) {
    throw new OntoCodeHarnessExecutionError(
      "ontology_domain_mismatch",
      `The bound Ontology returned ${ontology.domainId}, expected ${context.project.domain}`,
      { recoverable: false, retryable: false },
    );
  }
  const ontologyHash = factorySourceOntologyHash(ontology);
  const expectedHashes = [
    context.command?.baseOntologyHash ?? null,
    context.session.ontologySnapshotHash,
  ].filter((value): value is string => Boolean(value));
  if (expectedHashes.some((expected) => expected !== ontologyHash)) {
    throw new OntoCodeHarnessExecutionError(
      "ontology_snapshot_stale",
      "The authoritative Ontology changed after this operation was prepared",
      {
        recoverable: true,
        retryable: false,
        details: {
          currentOntologyHash: ontologyHash,
          expectedOntologyHashes: expectedHashes,
        },
      },
    );
  }
  if (options.requireSnapshot && expectedHashes.length === 0) {
    throw new OntoCodeHarnessExecutionError(
      "ontology_snapshot_required",
      "Build requires a scope or blueprint bound to an authoritative Ontology snapshot",
      { recoverable: true, retryable: false },
    );
  }
  return ontologyHash;
}

/**
 * #BLUEPRINT-REASON — the command policy this stage is allowed to spend against.
 *
 * The allowance is server-owned: it comes from ONTOCODE_COMMAND_POLICY for the
 * Command that produced this blueprint Job (two Command types share the
 * `blueprint` job kind), and the Job's own stored budget may only TIGHTEN it,
 * never widen it — the same direction `resolveOntoCodeCommandBudget` allows.
 */
const BLUEPRINT_REASONING_POLICY_FALLBACK = "propose_blueprint" as const;

export function resolveBlueprintReasoningBudget(
  context: OntoCodeHarnessExecutionContext,
): { maxModelCalls: number; maxWallClockMs: number; deadlineAt: number } {
  const commandType = context.command?.type;
  const policy =
    commandType && ONTOCODE_COMMAND_POLICY[commandType]?.jobKind === "blueprint"
      ? ONTOCODE_COMMAND_POLICY[commandType]
      : ONTOCODE_COMMAND_POLICY[BLUEPRINT_REASONING_POLICY_FALLBACK];
  const jobBudget = context.job.budget;
  const tighten = (allowed: number, requested: number | undefined): number =>
    typeof requested === "number" && requested > 0
      ? Math.min(allowed, requested)
      : allowed;
  const maxWallClockMs = tighten(
    policy.budget.maxWallClockMs,
    jobBudget?.maxWallClockMs,
  );
  return {
    maxModelCalls: tighten(
      policy.budget.maxModelCalls,
      jobBudget?.maxModelCalls,
    ),
    maxWallClockMs,
    // The reasoning pass anchors its wall clock at the JOB's start — the same
    // anchor the worker's own wall-clock timer uses (claim.leaseToken) — so
    // time spent before the pass cannot let the pass overrun the job budget.
    deadlineAt: context.claim.leaseToken + maxWallClockMs,
  };
}

/**
 * Bridge the reasoning pass's frames onto the durable session event stream,
 * mirroring the analysis path's `harness.ontology_analysis.{strategy,
 * reasoning_step,deliberation}` vocabulary so the FDE reads ONE reasoning
 * surface rather than a per-stage dialect.
 */
async function emitBlueprintReasoningFrame(
  context: OntoCodeHarnessExecutionContext,
  frame: BlueprintReasoningFrame,
): Promise<void> {
  const { type, ...payload } = frame;
  await context.progress(
    `harness.blueprint.${type}`,
    payload as unknown as Record<string, unknown>,
  );
}

export interface ResolvedGenerationScope {
  actionIds: string[];
  scenario: string;
  forceVirtual: boolean;
  source: "command" | "blueprint" | "build" | "scope";
  deferredActions: Array<{
    id: string;
    name: string;
  }>;
}

/** How many declared scope gaps the failure MESSAGE quotes (count always stated). */
const MAX_UNRESOLVED_IN_MESSAGE = 5;
/** How many declared scope gaps the failure receipt's details carry. */
const MAX_UNRESOLVED_IN_DETAILS = 20;

function generationScopeUnresolvedError(
  unresolved: string[],
  source: ResolvedGenerationScope["source"],
): OntoCodeHarnessExecutionError {
  return new OntoCodeHarnessExecutionError(
    "generation_scope_unresolved",
    `范围分析里有 ${unresolved.length} 项没能落到本体上，需要你先裁决再生成：${unresolved
      .slice(0, MAX_UNRESOLVED_IN_MESSAGE)
      .join("；")}`,
    {
      recoverable: true,
      retryable: false,
      details: {
        unresolved: unresolved.slice(0, MAX_UNRESOLVED_IN_DETAILS),
        unresolvedTotal: unresolved.length,
        source,
      },
    },
  );
}

/**
 * Whether a receipt-resolved generation scope ultimately rests on the scope
 * MODEL's recommendation (as opposed to an explicit FDE command selection).
 *
 * Receipts record only the branch they resolved from (`scope.source`), so the
 * origin is recovered by walking latest receipts one hop at a time:
 * `command` = the FDE picked the Actions themselves — that IS the
 * adjudication; `scope` = the model's recommendation. A chain whose provenance
 * cannot be established (legacy receipt without `source`, or a build→build
 * self-reference that only the mutable `latest` view can express) is treated
 * conservatively as resting on the recommendation — the FDE gets asked once
 * more rather than the platform guessing.
 */
async function generationScopeRestsOnRecommendation(
  context: OntoCodeHarnessExecutionContext,
  initialSource: ResolvedGenerationScope["source"],
): Promise<boolean> {
  let source = initialSource;
  const walked = new Set<string>();
  while (!walked.has(source)) {
    walked.add(source);
    if (source === "command") return false;
    if (source === "scope") return true;
    const receipt = await context.latestReceipt(
      source === "build"
        ? "harness.build.completed"
        : "harness.blueprint.completed",
    );
    const next = nonEmptyString(asRecord(receipt?.scope)?.source);
    if (
      next !== "command" &&
      next !== "scope" &&
      next !== "blueprint" &&
      next !== "build"
    ) {
      return true;
    }
    source = next;
  }
  return true;
}

/**
 * #B1 — the `unresolved[]` generation gate, applied to EVERY branch that rests
 * on the scope model's recommendation. It used to sit only on the last branch
 * of resolveGenerationScope, so a blueprint/build receipt short-circuited past
 * it and a scope whose model declared gaps still fed generation. Blueprint and
 * build receipts do not embed the scope's unresolved entries (going forward
 * they cannot even be created over a gappy scope, so threading the field would
 * persist a constant empty list); the latest scope receipt is read alongside
 * instead — which is also the only mechanism that covers receipts created
 * BEFORE this gate existed.
 */
async function assertGenerationScopeGapsAdjudicated(
  context: OntoCodeHarnessExecutionContext,
  source: "build" | "blueprint",
): Promise<void> {
  if (!(await generationScopeRestsOnRecommendation(context, source))) return;
  const scopeReceipt = await context.latestReceipt("harness.scope.completed");
  const unresolved = stringList(
    asRecord(scopeReceipt?.recommendation)?.unresolved,
  );
  if (unresolved.length === 0) return;
  throw generationScopeUnresolvedError(unresolved, source);
}

async function resolveGenerationScope(
  context: OntoCodeHarnessExecutionContext,
): Promise<ResolvedGenerationScope> {
  const args = context.command?.arguments ?? {};
  const commandActionIds = stringList(args.actionIds);
  const commandScenario = nonEmptyString(args.scenario);
  if (commandActionIds.length || commandScenario) {
    return {
      actionIds: commandActionIds,
      scenario: commandScenario ?? context.session.goal,
      forceVirtual: args.forceVirtual === true,
      source: "command",
      deferredActions: [],
    };
  }

  const build = await context.latestReceipt("harness.build.completed");
  const buildScope = asRecord(build?.scope);
  if (buildScope) {
    await assertGenerationScopeGapsAdjudicated(context, "build");
    const deferredActions = Array.isArray(buildScope.deferredActions)
      ? buildScope.deferredActions.flatMap((value) => {
          const action = asRecord(value);
          const id = nonEmptyString(action?.id);
          const name = nonEmptyString(action?.name);
          return id && name ? [{ id, name }] : [];
        })
      : [];
    return {
      actionIds: stringList(buildScope.actionIds),
      scenario: nonEmptyString(buildScope.scenario) ?? context.session.goal,
      forceVirtual: buildScope.forceVirtual === true,
      source: "build",
      deferredActions,
    };
  }

  const blueprint = await context.latestReceipt("harness.blueprint.completed");
  const blueprintScope = asRecord(blueprint?.scope);
  if (blueprintScope) {
    await assertGenerationScopeGapsAdjudicated(context, "blueprint");
    return {
      actionIds: stringList(blueprintScope.actionIds),
      scenario: nonEmptyString(blueprintScope.scenario) ?? context.session.goal,
      forceVirtual: blueprintScope.forceVirtual === true,
      source: "blueprint",
      deferredActions: [],
    };
  }

  const scope = await context.latestReceipt("harness.scope.completed");
  const recommendation = asRecord(scope?.recommendation);
  if (recommendation) {
    // `unresolved[]` is the ONLY way the scope model can say "you asked me about
    // something I could not place in this Ontology". It was validated, capped,
    // counted into a frame and written to audit meta — and then dropped here, so
    // generation proceeded as if the scope were clean. That is the same shape as
    // `mandatory[]` and `next_action:"block"`: computed, persisted, never read.
    // A declared gap that nothing consumes is not a safeguard, it is a receipt
    // saying we knew. The FDE decides — the platform does not decide for them.
    const unresolved = stringList(recommendation.unresolved);
    if (unresolved.length > 0) {
      throw generationScopeUnresolvedError(unresolved, "scope");
    }
    return {
      actionIds: stringList(recommendation.actionIds),
      scenario: nonEmptyString(recommendation.scenario) ?? context.session.goal,
      forceVirtual:
        recommendation.mode === "virtual_scenario" ||
        asRecord(recommendation.virtualAction) !== null,
      source: "scope",
      deferredActions: [],
    };
  }

  throw new OntoCodeHarnessExecutionError(
    "generation_scope_required",
    "Run scope analysis first, or provide explicit actionIds/scenario on the approved command",
    { recoverable: true, retryable: false },
  );
}

/**
 * Apply an FDE-authored defer decision to an already pinned generation scope.
 *
 * This is deliberately narrower than a free-form scope rewrite: only Actions
 * that are already in the approved Scope/Blueprint can be deferred, at least
 * one Action must remain, and the authoritative Ontology name/id pair is
 * persisted in the Build receipt. It lets a missing external contract park
 * one Agent without pretending that the dependency is configured or blocking
 * every other independently buildable Agent in the Session.
 */
export function applyDeferredGenerationScope(
  ontology: DomainOntology,
  scope: ResolvedGenerationScope,
  commandArguments: Record<string, unknown> | null | undefined,
): ResolvedGenerationScope {
  const requestedNames = stringList(
    commandArguments?.deferActionNames ?? commandArguments?.deferredActionNames,
  );
  if (requestedNames.length === 0) return scope;

  const selected = scope.actionIds.map((id) => {
    const action = ontology.actions.find((candidate) => candidate.id === id);
    if (!action) {
      throw new OntoCodeHarnessExecutionError(
        "generation_scope_action_not_found",
        `The approved generation scope references missing Ontology Action ${id}`,
        {
          recoverable: true,
          retryable: false,
          details: { actionId: id },
        },
      );
    }
    return action;
  });
  const selectedByName = new Map(
    selected.map((action) => [action.name.trim().toLowerCase(), action]),
  );
  const deferred = requestedNames.map((requestedName) => {
    const action = selectedByName.get(requestedName.trim().toLowerCase());
    if (!action) {
      throw new OntoCodeHarnessExecutionError(
        "deferred_action_not_in_scope",
        `Cannot defer ${requestedName}; it is not in the approved generation scope`,
        {
          recoverable: true,
          retryable: false,
          details: {
            requestedAction: requestedName,
            approvedActions: selected.map((candidate) => candidate.name),
          },
        },
      );
    }
    return { id: action.id, name: action.name };
  });
  const deferredIds = new Set(deferred.map((action) => action.id));
  const actionIds = scope.actionIds.filter((id) => !deferredIds.has(id));
  if (actionIds.length === 0) {
    throw new OntoCodeHarnessExecutionError(
      "generation_scope_empty_after_defer",
      "At least one approved Ontology Action must remain in this Build",
      {
        recoverable: true,
        retryable: false,
        details: { deferredActions: deferred },
      },
    );
  }
  return {
    ...scope,
    actionIds,
    source: "command",
    deferredActions: [
      ...new Map(deferred.map((action) => [action.id, action])).values(),
    ],
  };
}

function compactSandboxReceipt(
  event: Extract<BrainEvent, { t: "sandbox" }>,
): Record<string, unknown> {
  return {
    ran: event.ran,
    reachedTerminal: event.reachedTerminal,
    reachedSuccessTerminal: event.reachedSuccessTerminal ?? false,
    agents: [...event.agents],
    events: [...event.events],
    fullChainRan: event.fullChainRan ?? false,
    simulated: event.simulated ?? false,
    codeRanAgents: [...(event.codeRanAgents ?? [])],
    degradedAgents: [...(event.degradedAgents ?? [])],
    fidelityFailures: [...(event.fidelityFailures ?? [])],
    caseVerdicts: event.caseVerdicts
      ? {
          allPass: event.caseVerdicts.allPass,
          byKind: event.caseVerdicts.byKind,
        }
      : null,
  };
}

interface CompactFactoryReadinessBinding {
  requirementId: string;
  system: string;
  kind: string | null;
  role: string | null;
  status: string;
  executionSurface: string | null;
  configuration: {
    kind: "tool_profile";
    toolName: string;
    environment: "sandbox" | "production";
    profileKey: string;
    fields: Array<{
      key: string;
      type: string;
      required: boolean;
      description: string | null;
      allowedValues: Array<string | number | boolean>;
    }>;
    /** Real pre-cap field count — present only when the cap cut the list, so
     * a Configuration Task can say the field list is incomplete instead of
     * silently hiding a required credential field. */
    fieldsTotal?: number;
  } | null;
  reason: string;
}

interface CompactFactoryReadinessAction {
  action: string;
  ready: boolean;
  stages: {
    authoring: boolean;
    sandbox: boolean;
    promotion: boolean;
  };
  unresolvedBindings: CompactFactoryReadinessBinding[];
}

interface CompactFactoryReadiness {
  schema: "ontocode-factory-readiness/v1";
  source: string | null;
  reason: string | null;
  next: string | null;
  totals: {
    total: number;
    ready: number;
    blocked: number;
    readyActions: string[];
    blockedActions: string[];
  };
  actions: CompactFactoryReadinessAction[];
  /** What the receipt-construction caps dropped — present only when non-zero
   * somewhere. The waiting-question scan folds these into its coverage so a
   * cut receipt can never read as a complete check. */
  truncation?: {
    actionsDropped: number;
    bindingsDropped: number;
    fieldsDropped: number;
    allowedValuesDropped: number;
  };
}

interface CompactFactoryDraftCheckpointBase {
  persisted: number;
  scope: string | null;
  coveredAgents: string[];
  executionReadiness: {
    state: "generated_unverified";
    sandboxEvidence: "not_run";
    sandboxPrerequisitesReady: boolean;
    promotionPrerequisitesReady: boolean;
    unverifiedApis: Array<{
      actionName: string;
      tool: string | null;
      systems: string[];
      statuses: string[];
      reasons: string[];
    }>;
    blockers: string[];
  };
}

interface CompactFactoryDraftCheckpointV1 extends CompactFactoryDraftCheckpointBase {
  /** Legacy review-only checkpoint. It cannot be rebound to mutable `latest`
   * and is never Candidate-eligible. */
  schema: "agent-factory-draft-checkpoint/v1";
}

interface CompactFactoryDraftCheckpointV2 extends CompactFactoryDraftCheckpointBase {
  schema: "agent-factory-draft-checkpoint/v2";
  draftVersionId: string;
  specsFingerprint: string;
}

type CompactFactoryDraftCheckpoint =
  | CompactFactoryDraftCheckpointV1
  | CompactFactoryDraftCheckpointV2;

function boundedText(value: unknown, max = 1_000): string | null {
  return typeof value === "string" && value.trim()
    ? value.normalize("NFKC").trim().slice(0, max)
    : null;
}

/**
 * Preserve the Factory's read-only readiness result as a compact,
 * secret-free receipt. This is the structured source for conversational
 * recommendations and configuration tasks; the UI must not reverse-engineer
 * provider/profile targets from prose.
 */
export function compactFactoryReadiness(
  event: Extract<BrainEvent, { t: "tool.result" }>,
): CompactFactoryReadiness | null {
  if (
    (event.name !== "inspect_all_action_readiness" &&
      event.name !== "inspect_action_readiness") ||
    !event.ok ||
    !event.output
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.output);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root || root.readOnly !== true) return null;
  const scopedAction =
    event.name === "inspect_action_readiness" ? asRecord(root.compact) : null;
  const rawActions =
    event.name === "inspect_action_readiness"
      ? scopedAction
        ? [scopedAction]
        : []
      : Array.isArray(root.actions)
        ? root.actions
        : [];
  const catalogTotals = asRecord(root.totals);
  if (event.name === "inspect_all_action_readiness" && !catalogTotals) {
    return null;
  }

  const actionsDropped = Math.max(
    0,
    rawActions.length - MAX_READINESS_RECEIPT_ACTIONS,
  );
  let bindingsDropped = 0;
  let fieldsDropped = 0;
  let allowedValuesDropped = 0;
  const actions = rawActions
    .slice(0, MAX_READINESS_RECEIPT_ACTIONS)
    .flatMap((rawAction) => {
      const action = asRecord(rawAction);
      const actionName = boundedText(action?.action, 200);
      const stages = asRecord(action?.stages);
      const blockers = asRecord(action?.blockers);
      const integration = asRecord(blockers?.integration);
      if (!actionName || !stages) return [];
      const rawBindings = Array.isArray(integration?.unresolvedBindings)
        ? integration.unresolvedBindings
        : [];
      bindingsDropped += Math.max(
        0,
        rawBindings.length - MAX_READINESS_RECEIPT_BINDINGS,
      );
      const unresolvedBindings = rawBindings
        .slice(0, MAX_READINESS_RECEIPT_BINDINGS)
        .flatMap((raw) => {
          const binding = asRecord(raw);
          const requirementId = boundedText(binding?.requirementId, 240);
          const system = boundedText(binding?.system, 240);
          const status = boundedText(binding?.status, 100);
          const reason = boundedText(binding?.reason, 2_000);
          if (!requirementId || !system || !status || !reason) return [];
          const rawConfiguration = asRecord(binding?.configuration);
          const configurationEnvironment =
            rawConfiguration?.environment === "sandbox" ||
            rawConfiguration?.environment === "production"
              ? rawConfiguration.environment
              : null;
          const rawFields = Array.isArray(rawConfiguration?.fields)
            ? rawConfiguration.fields
            : [];
          const fieldsCut = Math.max(
            0,
            rawFields.length - MAX_TOOL_PROFILE_FIELDS,
          );
          const configuration: CompactFactoryReadinessBinding["configuration"] =
            rawConfiguration?.kind === "tool_profile" &&
            boundedText(rawConfiguration.toolName, 200) &&
            configurationEnvironment &&
            boundedText(rawConfiguration.profileKey, 200)
              ? {
                  kind: "tool_profile" as const,
                  toolName: boundedText(rawConfiguration.toolName, 200)!,
                  environment: configurationEnvironment,
                  profileKey: boundedText(rawConfiguration.profileKey, 200)!,
                  fields: rawFields
                    .slice(0, MAX_TOOL_PROFILE_FIELDS)
                    .flatMap((rawField) => {
                      const field = asRecord(rawField);
                      const key = boundedText(field?.key, 120);
                      const type = boundedText(field?.type, 80);
                      if (!field || !key || !type) return [];
                      const rawValues = Array.isArray(field.allowedValues)
                        ? field.allowedValues.filter(
                            (value): value is string | number | boolean =>
                              typeof value === "string" ||
                              typeof value === "number" ||
                              typeof value === "boolean",
                          )
                        : [];
                      allowedValuesDropped += Math.max(
                        0,
                        rawValues.length - MAX_TOOL_PROFILE_ALLOWED_VALUES,
                      );
                      return [
                        {
                          key,
                          type,
                          required: field.required === true,
                          description: boundedText(field.description, 300),
                          allowedValues: rawValues.slice(
                            0,
                            MAX_TOOL_PROFILE_ALLOWED_VALUES,
                          ),
                        },
                      ];
                    }),
                  ...(fieldsCut > 0 ? { fieldsTotal: rawFields.length } : {}),
                }
              : null;
          if (configuration) fieldsDropped += fieldsCut;
          return [
            {
              requirementId,
              system,
              kind: boundedText(binding?.kind, 120),
              role: boundedText(binding?.role, 120),
              status,
              executionSurface: boundedText(binding?.executionSurface, 240),
              configuration,
              reason,
            } satisfies CompactFactoryReadinessBinding,
          ];
        });
      return [
        {
          action: actionName,
          ready: action?.ready === true,
          stages: {
            authoring: stages.authoring === true,
            sandbox: stages.sandbox === true,
            promotion: stages.promotion === true,
          },
          unresolvedBindings,
        } satisfies CompactFactoryReadinessAction,
      ];
    });
  if (event.name === "inspect_action_readiness" && actions.length !== 1) {
    return null;
  }

  const numeric = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : 0;
  const totals =
    catalogTotals ??
    ({
      total: actions.length,
      ready: actions.filter((action) => action.ready).length,
      blocked: actions.filter((action) => !action.ready).length,
      readyActions: actions
        .filter((action) => action.ready)
        .map((action) => action.action),
      blockedActions: actions
        .filter((action) => !action.ready)
        .map((action) => action.action),
    } satisfies Record<string, unknown>);
  return {
    schema: "ontocode-factory-readiness/v1",
    source:
      event.name === "inspect_action_readiness"
        ? "inspect_action_readiness"
        : boundedText(root.source, 240),
    reason: boundedText(root.reason, 240),
    next: boundedText(root.next, 120),
    totals: {
      total: numeric(totals.total),
      ready: numeric(totals.ready),
      blocked: numeric(totals.blocked),
      readyActions: stringList(totals.readyActions).slice(0, 200),
      blockedActions: stringList(totals.blockedActions).slice(0, 200),
    },
    actions,
    ...(actionsDropped +
      bindingsDropped +
      fieldsDropped +
      allowedValuesDropped >
    0
      ? {
          truncation: {
            actionsDropped,
            bindingsDropped,
            fieldsDropped,
            allowedValuesDropped,
          },
        }
      : {}),
  };
}

function compactFactoryDraftCheckpoint(
  event: Extract<BrainEvent, { t: "tool.result" }>,
): CompactFactoryDraftCheckpoint | null {
  if (event.name !== "save_draft" || !event.ok || !event.output) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.output);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const hasDraftVersionId = Object.prototype.hasOwnProperty.call(
    root,
    "draftVersionId",
  );
  const hasSpecsFingerprint = Object.prototype.hasOwnProperty.call(
    root,
    "specsFingerprint",
  );
  const draftVersionId = boundedText(root.draftVersionId, 160);
  const draftSpecsFingerprint = boundedText(root.specsFingerprint, 160);
  if (
    hasDraftVersionId !== hasSpecsFingerprint ||
    (hasDraftVersionId &&
      (!draftVersionId ||
        !/^v-[A-Za-z0-9-]{3,120}$/.test(draftVersionId) ||
        !draftSpecsFingerprint ||
        !/^specs:v2:[a-f0-9]{64}$/.test(draftSpecsFingerprint)))
  ) {
    // A malformed or partial lineage claim is not downgraded to a legacy
    // checkpoint. That would turn corruption into permission to guess.
    return null;
  }
  const scope = boundedText(root.scope, 80);
  const coveredAgents = stringList(root.coveredAgents).slice(0, 200);
  const readiness = asRecord(root.executionReadiness);
  const persisted =
    typeof root.persisted === "number" &&
    Number.isSafeInteger(root.persisted) &&
    root.persisted > 0
      ? root.persisted
      : 0;
  if (
    persisted === 0 ||
    readiness?.schema !== "agent-factory-draft-readiness/v1" ||
    readiness.state !== "generated_unverified" ||
    readiness.sandboxEvidence !== "not_run"
  ) {
    return null;
  }
  const unverifiedApis = Array.isArray(readiness.unverifiedApis)
    ? readiness.unverifiedApis.slice(0, 200).flatMap((rawApi) => {
        const api = asRecord(rawApi);
        const actionName = boundedText(api?.actionName, 200);
        if (!api || !actionName) return [];
        return [
          {
            actionName,
            tool: boundedText(api.tool, 200),
            systems: stringList(api.systems).slice(0, 40),
            statuses: stringList(api.statuses).slice(0, 20),
            reasons: stringList(api.reasons)
              .slice(0, 40)
              .map((reason) => reason.slice(0, 300)),
          },
        ];
      })
    : [];
  const base: CompactFactoryDraftCheckpointBase = {
    persisted,
    scope,
    coveredAgents,
    executionReadiness: {
      state: "generated_unverified",
      sandboxEvidence: "not_run",
      sandboxPrerequisitesReady: readiness.sandboxPrerequisitesReady === true,
      promotionPrerequisitesReady:
        readiness.promotionPrerequisitesReady === true,
      unverifiedApis,
      blockers: stringList(readiness.blockers)
        .slice(0, 200)
        .map((blocker) => blocker.slice(0, 500)),
    },
  };
  return draftVersionId && draftSpecsFingerprint
    ? {
        schema: "agent-factory-draft-checkpoint/v2",
        ...base,
        draftVersionId,
        specsFingerprint: draftSpecsFingerprint,
      }
    : {
        schema: "agent-factory-draft-checkpoint/v1",
        ...base,
      };
}

function factoryDraftWaitingMessage(
  checkpoint: CompactFactoryDraftCheckpoint,
): string {
  const apis = checkpoint.executionReadiness.unverifiedApis;
  const apiSummary =
    apis.length > 0
      ? apis
          .slice(0, 8)
          .map((api) => {
            const target = api.systems.join("/") || api.tool || api.actionName;
            return `${target}${api.tool ? `（${api.tool}）` : ""}`;
          })
          .join("、") + (apis.length > 8 ? "…" : "")
      : "当前没有可归因到单一 API 的配置缺口";
  return [
    `已生成并持久化 ${checkpoint.persisted} 个 function 代码草稿。`,
    checkpoint.schema === "agent-factory-draft-checkpoint/v2"
      ? `这些草稿已绑定不可变 OntoCode 构建版本 ${checkpoint.draftVersionId}；完整 specs 摘要为 ${checkpoint.specsFingerprint}。`
      : "这是旧版无不可变版本身份的草稿回执；OntoCode 只保留审阅预览，不会按当前 latest 或代码相似度把它恢复成 Candidate。",
    "这些产物的 execution readiness 仍为 unresolved；它们不是 runnable/verified candidate，也没有沙箱运行证据。",
    `待配置或待验证 API：${apiSummary}。`,
    "FDE 可以先审阅和继续修改代码；待 profile、credential、probe 或外部平台恢复后再重新运行 Build/Sandbox。Sandbox、probe、finish 与 promotion 仍保持 fail-closed。",
  ].join("\n");
}

const MAX_FACTORY_FDE_INSTRUCTION_CHARS = 4_000;

function boundedFdeInstruction(command: OntoCodeCommand | null): string | null {
  const instruction = nonEmptyString(command?.arguments.instruction);
  return instruction
    ? instruction.slice(0, MAX_FACTORY_FDE_INSTRUCTION_CHARS)
    : null;
}

function factoryBuildGoal(
  directive: FactoryGenerationDirective,
  sessionGoal: string,
  command: OntoCodeCommand | null,
): string {
  const baseGoal = factoryGenerationGoal(directive, sessionGoal);
  const instruction = boundedFdeInstruction(command);
  if (!instruction) return baseGoal;
  return `${baseGoal}\n\n[OntoCode FDE follow-up instruction]\n${instruction}`;
}

function contractObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashContract(value: Record<string, unknown> | null): string | null {
  return value ? sha256Text(canonicalEvidenceJson(value)) : null;
}

function selectedCandidateToolNames(
  receipt: Record<string, unknown>,
): string[] {
  if (!Array.isArray(receipt.agents)) return [];
  const names = new Set<string>();
  for (const rawAgent of receipt.agents) {
    const agent = asRecord(rawAgent);
    const spec = asRecord(agent?.spec) ?? agent;
    for (const toolName of stringList(spec?.tools)) names.add(toolName);
  }
  return [...names].sort();
}

/**
 * Freeze only non-secret contract identity. Runtime configuration values and
 * credentials are deliberately excluded; the Candidate records schema/policy
 * hashes while profile/probe readiness remains a separately repairable gate.
 */
async function captureCandidateToolContracts(
  factory: OntoCodeFactoryHarnessAdapter,
  input: Pick<
    OntoCodeFactoryBuildInput,
    "tenantId" | "tenantSlug" | "domain" | "ontologyDomainRegistrationId"
  >,
  receipt: Record<string, unknown>,
): Promise<CandidateToolContractSnapshot[]> {
  const selectedNames = selectedCandidateToolNames(receipt);
  if (selectedNames.length === 0) return [];
  let tools: RealTool[] = [];
  try {
    tools =
      (
        await factory.listExecutionResources?.({
          tenantId: input.tenantId,
          tenantSlug: input.tenantSlug,
          domain: input.domain,
          ontologyDomainRegistrationId: input.ontologyDomainRegistrationId,
        })
      )?.tools ?? [];
  } catch {
    // The immutable snapshot below records unknown. Candidate authoring then
    // fails closed, while a generated-unverified draft remains reviewable.
  }

  return selectedNames.map((toolName) => {
    const matches = tools.filter(
      (tool) => tool.name === toolName || tool.aliases?.includes(toolName),
    );
    if (matches.length === 0) {
      return {
        toolName,
        resolvedName: null,
        status: "unknown",
        policy: null,
        inputContractHash: null,
        outputContractHash: null,
        contractHash: null,
      };
    }
    if (matches.length > 1) {
      return {
        toolName,
        resolvedName: null,
        status: "ambiguous",
        policy: null,
        inputContractHash: null,
        outputContractHash: null,
        contractHash: null,
      };
    }
    const tool = matches[0]!;
    const policyCandidate = {
      operation: tool.operation,
      effectScope: tool.effectScope,
      sandboxPolicy: tool.sandboxPolicy,
    };
    const policy = isGeneratedToolExecutionPolicy(policyCandidate)
      ? policyCandidate
      : null;
    const inputContract =
      contractObject(tool.catalogDefinition?.argsSchema) ??
      contractObject(tool.declarativeDefinition?.paramsSchema) ??
      contractObject(tool.declarativeDefinition?.requestSpec);
    const outputContract =
      contractObject(tool.catalogDefinition?.returnsSchema) ??
      contractObject(tool.declarativeDefinition?.returnsSchema) ??
      contractObject(tool.declarativeDefinition?.responseSpec);
    const inputContractHash = hashContract(inputContract);
    const outputContractHash = hashContract(outputContract);
    const contractHash =
      policy && inputContract && outputContract
        ? sha256Text(
            canonicalEvidenceJson({
              schema: "ontocode-candidate-tool-contract/v1",
              requestedName: toolName,
              resolvedName: tool.name,
              policy,
              inputContract,
              outputContract,
              capabilities: tool.capabilities ?? [],
            }),
          )
        : null;
    return {
      toolName,
      resolvedName: tool.name,
      status:
        policy && inputContractHash && outputContractHash && contractHash
          ? "resolved"
          : "contract_missing",
      policy,
      inputContractHash,
      outputContractHash,
      contractHash,
    };
  });
}

/**
 * The waiting question an FDE actually reads in chat. Exported so
 * #HUMAN-TEXT-GUARD can be applied to every branch it can produce.
 */
export function clarificationAssistantText(
  event: Extract<BrainEvent, { t: "clarify" }>,
): string {
  // The interaction id used to be printed as a `交互编号：…` line. It never
  // routed anything from here: the answer is matched against the id persisted
  // on the waiting job's immutable receipt, and it also travels to the UI as
  // OntoCodeStructuredQuestion.id. So the line was a machine id shown to a
  // human for no purpose, and it is gone.
  if (event.items && event.items.length > 0) {
    return [
      `有 ${event.items.length} 项需要你先拍板：`,
      ...event.items.map(
        (item, index) => `${index + 1}. ${item.question.trim()}`,
      ),
      "密钥请放在集成设置里，不要发到会话里。",
    ].join("\n");
  }
  const lines = [event.question.trim()];
  if (event.context?.trim()) {
    lines.push(`背景：${event.context.trim()}`);
  }
  const options = event.options ?? [];
  if (options.length > 0) {
    lines.push(
      "可选回答：",
      ...options.map(
        (option, index) =>
          `${index + 1}. ${option.label}${option.recommended ? "（推荐）" : ""} — 回复：${option.value}`,
      ),
    );
  } else {
    lines.push("请直接回复你的决定或所需配置信息，我会用它发起下一次 Build。");
  }
  return lines.join("\n");
}

const CONFIG_QUESTION_PATTERN = /凭证|密钥|未配置|credential|api[\s_-]?key/i;
// System-ish identifiers such as "GoHire_System" / "Internal_Recruitment_System".
const SYSTEMISH_TOKEN_PATTERN = /\b[A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;
const GENERIC_SYSTEM_TOKENS = new Set([
  "api",
  "integration",
  "ontology",
  "profile",
  "sandbox",
  "service",
  "system",
]);

function inferWaitingItemSystem(
  text: string,
  systems: string[],
): string | null {
  const corpus = text.toLocaleLowerCase();
  const matches = systems.filter((system) =>
    system
      .split(/[^A-Za-z0-9]+/u)
      .map((fragment) => fragment.toLocaleLowerCase())
      .filter(
        (fragment) =>
          fragment.length >= 3 && !GENERIC_SYSTEM_TOKENS.has(fragment),
      )
      .some((fragment) => corpus.includes(fragment)),
  );
  return matches.length === 1 ? matches[0]! : null;
}

interface WaitingReadinessGap {
  actionName: string;
  authoringReady: boolean;
  requirementId: string;
  system: string;
  requirementKind: string | null;
  requirementRole: string | null;
  status: string;
  executionSurface: string | null;
  configuration: CompactFactoryReadinessBinding["configuration"];
  reason: string | null;
}

/**
 * Concurrent Harness jobs per process. The ceiling is a guardrail against a
 * typo'd env value, not a policy the operator may not see: exceeding it warns
 * rather than quietly serving a different number.
 */
const MAX_HARNESS_CONCURRENCY = 8;
const DEFAULT_HARNESS_CONCURRENCY = 3;

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

/**
 * How many Actions / per-Action bindings a readiness scan will read. Bounded so
 * a malformed receipt cannot spin, but NEVER silently: exceeding the bound is
 * reported, because this is the only structured credential-gap source and a
 * truncated scan otherwise reads as "there are no more gaps".
 */
const MAX_READINESS_ACTIONS = envInt(
  "ONTOCODE_READINESS_MAX_ACTIONS",
  2_000,
  1,
);
const MAX_READINESS_BINDINGS = envInt(
  "ONTOCODE_READINESS_MAX_BINDINGS",
  2_000,
  1,
);
/**
 * Tool-profile configuration bounds, shared by the receipt CONSTRUCTION
 * (compactFactoryReadiness) and the receipt SCAN (waitingReadinessScan) so the
 * two sides agree on one bound. Exceeding them is never silent: the receipt
 * records what it dropped and the scan folds the loss into question coverage —
 * a cap here can otherwise hide a required credential field or an allowed
 * value the FDE is then never asked about.
 */
const MAX_TOOL_PROFILE_FIELDS = envInt(
  "ONTOCODE_READINESS_MAX_TOOL_PROFILE_FIELDS",
  100,
  1,
);
const MAX_TOOL_PROFILE_ALLOWED_VALUES = envInt(
  "ONTOCODE_READINESS_MAX_TOOL_PROFILE_ALLOWED_VALUES",
  40,
  1,
);
/** Readiness-receipt construction caps (actions / per-action bindings kept). */
const MAX_READINESS_RECEIPT_ACTIONS = envInt(
  "ONTOCODE_READINESS_RECEIPT_MAX_ACTIONS",
  200,
  1,
);
const MAX_READINESS_RECEIPT_BINDINGS = envInt(
  "ONTOCODE_READINESS_RECEIPT_MAX_BINDINGS",
  200,
  1,
);
/**
 * Structured-question interaction bounds. These mirror the hard ceilings of
 * OntoCodeStructuredQuestionSchema (options ≤ 12, items ≤ 8, per-item options
 * ≤ 4, systems ≤ 20) — raising them requires a contract change. Cutting is
 * reported through the question's `coverage`, never silent.
 */
const MAX_WAITING_QUESTION_OPTIONS = 12;
const MAX_WAITING_QUESTION_ITEMS = 8;
const MAX_WAITING_QUESTION_ITEM_OPTIONS = 4;
const MAX_WAITING_QUESTION_SYSTEMS = 20;
/** Bounded acceptance-checklist bridge (pre-cap totals always on the frame). */
const MAX_ACCEPTANCE_CRITERIA = 40;
const MAX_ACCEPTANCE_AGENTS = 40;
const MAX_ACCEPTANCE_ITEMS_PER_AGENT = 40;
const MAX_ACCEPTANCE_LABEL_CHARS = 200;
const MAX_ACCEPTANCE_DETAIL_CHARS = 500;

export interface WaitingReadinessScan {
  gaps: WaitingReadinessGap[];
  scanned: number;
  total: number;
  scannedBindings: number;
  totalBindings: number;
  /** tool_profile configuration units (fields + allowed values) read vs
   * offered — including losses the receipt itself declared at construction
   * time via its `truncation` record. */
  configurationKept: number;
  configurationTotal: number;
  truncated: boolean;
}

/**
 * Reads the compact readiness section of a waiting Harness receipt back into
 * the unresolved integration bindings it asserts. This is the only structured
 * credential-gap source; prose never authorizes configuration surfaces.
 */
function waitingReadinessScan(
  receipt: Record<string, unknown>,
): WaitingReadinessScan {
  const readiness = asRecord(receipt.readiness);
  if (
    !readiness ||
    readiness.schema !== "ontocode-factory-readiness/v1" ||
    !Array.isArray(readiness.actions)
  ) {
    return {
      gaps: [],
      scanned: 0,
      total: 0,
      scannedBindings: 0,
      totalBindings: 0,
      configurationKept: 0,
      configurationTotal: 0,
      truncated: false,
    };
  }
  // Losses the receipt CONSTRUCTION already declared (compactFactoryReadiness
  // `truncation`): the content is gone, but the loss itself is durable and is
  // folded into this scan's totals so coverage stays truthful end to end.
  const declared = asRecord(readiness.truncation);
  const declaredCount = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : 0;
  const total =
    readiness.actions.length + declaredCount(declared?.actionsDropped);
  const scanned = Math.min(readiness.actions.length, MAX_READINESS_ACTIONS);
  // Bindings are bounded PER ACTION, so an action-level count alone cannot see
  // a dropped binding — and a dropped binding is a credential gap the FDE is
  // then never asked about, while the receipt still reads as a complete check.
  let scannedBindings = 0;
  let totalBindings = declaredCount(declared?.bindingsDropped);
  // Same failure mode one level down: a dropped tool_profile FIELD can hide a
  // required credential the FDE is then never asked for, and a dropped
  // allowedValue can hide the only correct option.
  let configurationKept = 0;
  let configurationTotal =
    declaredCount(declared?.fieldsDropped) +
    declaredCount(declared?.allowedValuesDropped);
  const gaps: WaitingReadinessGap[] = [];
  for (const rawAction of readiness.actions.slice(0, scanned)) {
    const action = asRecord(rawAction);
    const actionName = nonEmptyString(action?.action);
    if (!action || !actionName) continue;
    const stages = asRecord(action.stages);
    const authoringReady = stages?.authoring === true;
    const bindings = Array.isArray(action.unresolvedBindings)
      ? action.unresolvedBindings
      : [];
    totalBindings += bindings.length;
    scannedBindings += Math.min(bindings.length, MAX_READINESS_BINDINGS);
    for (const rawBinding of bindings.slice(0, MAX_READINESS_BINDINGS)) {
      const binding = asRecord(rawBinding);
      const requirementId = nonEmptyString(binding?.requirementId);
      const system = nonEmptyString(binding?.system);
      const status = nonEmptyString(binding?.status);
      if (!binding || !requirementId || !system || !status) continue;
      if (status === "resolved") continue;
      gaps.push({
        actionName,
        authoringReady,
        requirementId,
        system,
        requirementKind: nonEmptyString(binding.kind),
        requirementRole: nonEmptyString(binding.role),
        status,
        executionSurface: nonEmptyString(binding.executionSurface),
        configuration: (() => {
          const raw = asRecord(binding.configuration);
          const toolName = nonEmptyString(raw?.toolName);
          const profileKey = nonEmptyString(raw?.profileKey);
          if (
            raw?.kind !== "tool_profile" ||
            !toolName ||
            !profileKey ||
            (raw.environment !== "sandbox" && raw.environment !== "production")
          ) {
            return null;
          }
          const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
          const keptFieldWindow = Math.min(
            rawFields.length,
            MAX_TOOL_PROFILE_FIELDS,
          );
          configurationKept += keptFieldWindow;
          configurationTotal += rawFields.length;
          const receiptFieldsTotal =
            typeof raw.fieldsTotal === "number" &&
            Number.isSafeInteger(raw.fieldsTotal) &&
            raw.fieldsTotal > rawFields.length
              ? raw.fieldsTotal
              : null;
          const scanFieldsCut = rawFields.length > keptFieldWindow;
          return {
            kind: "tool_profile" as const,
            toolName,
            environment: raw.environment,
            profileKey,
            fields: rawFields
              .slice(0, MAX_TOOL_PROFILE_FIELDS)
              .flatMap((rawField) => {
                const field = asRecord(rawField);
                const key = nonEmptyString(field?.key);
                const type = nonEmptyString(field?.type);
                if (!field || !key || !type) return [];
                const rawValues = Array.isArray(field.allowedValues)
                  ? field.allowedValues.filter(
                      (value): value is string | number | boolean =>
                        typeof value === "string" ||
                        typeof value === "number" ||
                        typeof value === "boolean",
                    )
                  : [];
                configurationKept += Math.min(
                  rawValues.length,
                  MAX_TOOL_PROFILE_ALLOWED_VALUES,
                );
                configurationTotal += rawValues.length;
                return [
                  {
                    key,
                    type,
                    required: field.required === true,
                    description: nonEmptyString(field.description),
                    allowedValues: rawValues.slice(
                      0,
                      MAX_TOOL_PROFILE_ALLOWED_VALUES,
                    ),
                  },
                ];
              }),
            // Keep the honest pre-cap size on the gap, whichever side cut it,
            // so a Configuration Task can say the field list is incomplete.
            ...(receiptFieldsTotal !== null
              ? { fieldsTotal: receiptFieldsTotal }
              : scanFieldsCut
                ? { fieldsTotal: rawFields.length }
                : {}),
          };
        })(),
        reason: nonEmptyString(binding.reason),
      });
    }
  }
  return {
    gaps,
    scanned,
    total,
    scannedBindings,
    totalBindings,
    configurationKept,
    configurationTotal,
    truncated:
      scanned < total ||
      scannedBindings < totalBindings ||
      configurationKept < configurationTotal,
  };
}

/**
 * Wraps a waiting message + immutable receipt into a structured question the
 * workspace can render as an action card. Pure and deterministic; exported for
 * tests. The fallback is still structured: an unclassifiable message becomes a
 * "decision" question quoting the original text.
 */
export function buildStructuredWaitingQuestion(
  jobKind: OntoCodeHarnessJobKind,
  message: string,
  receipt: Record<string, unknown>,
): OntoCodeStructuredQuestion {
  const interaction = asRecord(receipt.interaction);
  const scan = waitingReadinessScan(receipt);
  const gaps = scan.gaps;
  const messageTokens = [
    ...new Set(message.match(SYSTEMISH_TOKEN_PATTERN) ?? []),
  ];
  const lowerMessage = message.toLowerCase();
  const referencesGap = gaps.some(
    (gap) =>
      lowerMessage.includes(gap.actionName.toLowerCase()) ||
      lowerMessage.includes(gap.system.toLowerCase()),
  );
  const isConfig = CONFIG_QUESTION_PATTERN.test(message) || referencesGap;
  const receiptSystems = [...new Set(gaps.map((gap) => gap.system))];
  const systems = [
    ...new Set([
      ...(isConfig && receiptSystems.length > 0
        ? receiptSystems
        : messageTokens),
    ]),
  ]
    .slice(0, MAX_WAITING_QUESTION_SYSTEMS)
    .map((system) => system.slice(0, 200));

  // #B2 — the interaction structures used to be truncated with no flag while
  // the readiness scan beside them reported coverage honestly. A dropped
  // option changes what the FDE can pick, so kept-vs-offered is counted with
  // the same window convention the scan uses and folded into `coverage`.
  let interactionKept = 0;
  let interactionOffered = 0;
  const countWindow = (offered: number, cap: number): void => {
    interactionOffered += offered;
    interactionKept += Math.min(offered, cap);
  };

  const rawOptions = Array.isArray(interaction?.options)
    ? interaction.options
    : [];
  countWindow(rawOptions.length, MAX_WAITING_QUESTION_OPTIONS);
  const options = rawOptions
    .slice(0, MAX_WAITING_QUESTION_OPTIONS)
    .flatMap((rawOption) => {
      const option = asRecord(rawOption);
      const label = nonEmptyString(option?.label)?.slice(0, 200);
      const value = nonEmptyString(option?.value)?.slice(0, 500);
      if (!label || !value) return [];
      return [
        {
          label,
          value,
          ...(option?.recommended === true ? { recommended: true } : {}),
        },
      ];
    });
  const rawItems = Array.isArray(interaction?.items) ? interaction.items : [];
  countWindow(rawItems.length, MAX_WAITING_QUESTION_ITEMS);
  const items = rawItems
    .slice(0, MAX_WAITING_QUESTION_ITEMS)
    .flatMap((rawItem, index) => {
      const item = asRecord(rawItem);
      const question = nonEmptyString(item?.question)?.slice(0, 1_000);
      if (!item || !question) return [];
      const rawItemOptions = Array.isArray(item.options) ? item.options : [];
      countWindow(rawItemOptions.length, MAX_WAITING_QUESTION_ITEM_OPTIONS);
      const itemOptions = rawItemOptions
        .slice(0, MAX_WAITING_QUESTION_ITEM_OPTIONS)
        .flatMap((rawOption) => {
          const option = asRecord(rawOption);
          const label = nonEmptyString(option?.label)?.slice(0, 200);
          const value = nonEmptyString(option?.value)?.slice(0, 500);
          if (!label || !value) return [];
          return [
            {
              label,
              value,
              ...(option?.recommended === true ? { recommended: true } : {}),
            },
          ];
        });
      const context = nonEmptyString(item.context);
      const system = inferWaitingItemSystem(
        `${question}\n${context ?? ""}`,
        systems,
      );
      return [
        {
          id: `item-${index + 1}`,
          question,
          ...(context ? { context: context.slice(0, 2_000) } : {}),
          options: itemOptions,
          allowOther: true,
          systems: system ? [system] : [],
        },
      ];
    });
  const why = nonEmptyString(interaction?.context)?.slice(0, 2_000);
  const totals = asRecord(asRecord(receipt.readiness)?.totals);
  const blocked =
    typeof totals?.blocked === "number" && totals.blocked > 0
      ? totals.blocked
      : 0;
  const total = typeof totals?.total === "number" ? totals.total : 0;
  const blockedActionNames = [...new Set(gaps.map((gap) => gap.actionName))];
  const impact =
    blocked > 0
      ? `${blocked}/${total} 个 Ontology 动作被就绪检查阻塞${
          blockedActionNames.length > 0
            ? `：${blockedActionNames.slice(0, 5).join("、")}`
            : ""
        }`.slice(0, 1_000)
      : undefined;
  const id =
    nonEmptyString(interaction?.interactionId) ??
    `waiting-${jobKind}-${createHash("sha256").update(message).digest("hex").slice(0, 16)}`;
  return OntoCodeStructuredQuestionSchema.parse({
    id: id.slice(0, 200),
    kind: isConfig ? "config" : "decision",
    question: message.slice(0, 4_000),
    ...(why ? { why } : {}),
    options,
    items,
    allowOther: interaction?.allowOther !== false,
    ...(impact ? { impact } : {}),
    systems,
    // Only when something was actually cut short — the readiness scan, the
    // receipt's own declared construction losses, or the interaction
    // structures above. Absence therefore still means "complete", which is
    // the only reading that stays true.
    ...(scan.truncated || interactionKept < interactionOffered
      ? {
          coverage: {
            scanned:
              scan.scanned +
              scan.scannedBindings +
              scan.configurationKept +
              interactionKept,
            total:
              scan.total +
              scan.totalBindings +
              scan.configurationTotal +
              interactionOffered,
            truncated: true as const,
          },
        }
      : {}),
  });
}

function resolveStructuredWaitingQuestion(
  jobKind: OntoCodeHarnessJobKind,
  message: string,
  result: OntoCodeHarnessExecutorResult,
): OntoCodeStructuredQuestion {
  if (result.question) {
    const provided = OntoCodeStructuredQuestionSchema.safeParse(
      result.question,
    );
    if (provided.success) return provided.data;
  }
  return buildStructuredWaitingQuestion(jobKind, message, result.receipt);
}

const RESUME_ACTION_BY_JOB_KIND: Partial<
  Record<OntoCodeHarnessJobKind, OntoCodeTurnAction>
> = {
  scope: "analyze_scope",
  blueprint: "propose_blueprint",
  build: "generate_package",
  test: "run_tests",
  debug: "debug_failure",
  regression: "compare_candidate",
};

/**
 * Auto-derives one Configuration Task from a waiting Harness receipt.
 *
 * Fail-closed by design: a task is only created when the question classified
 * as "config" AND the immutable receipt itself names an unresolved
 * `external_api` requirement with no execution surface — the single blocker
 * class the Configuration Task store authorizes for waiting-bound tasks
 * (tool target + tool_contract verification). All four resume fields come
 * from the receipt so a passed verification really resumes the exact waiting
 * operation. Exported for tests.
 */
export function createConfigurationTaskForWaitingJob(input: {
  tenantId: string;
  actorId: string | null;
  sessionId: string;
  jobId: string;
  jobKind: OntoCodeHarnessJobKind;
  receipt: Record<string, unknown>;
  question: OntoCodeStructuredQuestion;
}): { taskId: string; mode: "created" | "attached" } | null {
  if (input.question.kind !== "config") return null;
  const resumeAction = RESUME_ACTION_BY_JOB_KIND[input.jobKind];
  const ontologyHash = nonEmptyString(input.receipt.ontologyHash);
  if (!resumeAction || !ontologyHash) return null;
  const gaps = waitingReadinessScan(input.receipt).gaps;
  const isUnambiguous = (candidate: WaitingReadinessGap): boolean =>
    gaps.filter(
      (other) =>
        other.actionName === candidate.actionName &&
        other.requirementId === candidate.requirementId,
    ).length === 1;
  const eligibleGaps = gaps.filter(
    (candidate) =>
      (candidate.status === "needs_config" ||
        candidate.status === "needs_probe") &&
      candidate.executionSurface !== null &&
      candidate.configuration?.kind === "tool_profile" &&
      candidate.configuration.toolName === candidate.executionSurface &&
      isUnambiguous(candidate),
  );
  const eligibleMissingToolGaps = gaps.filter(
    (candidate) =>
      candidate.status === "missing" &&
      candidate.executionSurface === null &&
      candidate.requirementKind === "external_api" &&
      candidate.requirementRole !== null &&
      isUnambiguous(candidate),
  );
  const candidates =
    eligibleGaps.length > 0 ? eligibleGaps : eligibleMissingToolGaps;
  const questionCorpus = [
    input.question.question,
    input.question.why ?? "",
    ...input.question.options.flatMap((option) => [option.label, option.value]),
  ]
    .join("\n")
    .normalize("NFKC")
    .toLowerCase();
  const namedByExactSurface = candidates.filter((candidate) =>
    [
      candidate.executionSurface,
      candidate.configuration?.toolName,
      candidate.configuration?.profileKey,
    ].some(
      (token) =>
        typeof token === "string" &&
        token.length > 0 &&
        questionCorpus.includes(token.normalize("NFKC").toLowerCase()),
    ),
  );
  const namedByUniqueSystem = candidates.filter((candidate) =>
    questionCorpus.includes(candidate.system.normalize("NFKC").toLowerCase()),
  );
  const gap =
    namedByExactSurface.length === 1
      ? namedByExactSurface[0]
      : namedByUniqueSystem.length === 1
        ? namedByUniqueSystem[0]
        : candidates[0];
  if (!gap) return null;
  if (input.jobKind === "build" && gap.authoringReady) {
    const hasMatchingAuthoredAgent =
      Array.isArray(input.receipt.agents) &&
      input.receipt.agents.some((rawAgent) => {
        const agent = asRecord(rawAgent);
        return nonEmptyString(agent?.actionName) === gap.actionName;
      });
    if (!hasMatchingAuthoredAgent) return null;
  }
  const profile = gap.configuration;
  const missingFields =
    profile?.fields
      .filter((field) => field.required && /^[a-z][a-z0-9_]*$/.test(field.key))
      .map((field) => ({
        key: field.key,
        label: (field.description ?? field.key).slice(0, 200),
        kind: field.key.endsWith("_env")
          ? ("env_only" as const)
          : field.allowedValues.length > 0
            ? ("select" as const)
            : /base[_-]?url/i.test(field.key)
              ? ("base_url" as const)
              : /api[_-]?key/i.test(field.key)
                ? ("api_key" as const)
                : /secret|token/i.test(field.key)
                  ? ("secret" as const)
                  : ("text" as const),
        required: true,
        envRef: null,
        source: "tool" as const,
      })) ?? [];
  const ctx = { tenantId: input.tenantId, actorId: input.actorId };
  const session = getOntoCodeSession(ctx, input.sessionId);
  const created = createOntoCodeConfigurationTask(ctx, input.sessionId, {
    expectedSessionRevision: session.revision,
    waitingHarnessJobId: input.jobId,
    sourceRequirementId: gap.requirementId,
    sourceActionName: gap.actionName,
    blockerKey: `integration:${gap.requirementId}`.slice(0, 240),
    title: profile
      ? `配置 ${profile.toolName} 的 ${profile.environment} Tool Profile`.slice(
          0,
          300,
        )
      : `为 ${gap.system} 提供可执行的 Tool/API 契约`.slice(0, 300),
    target: profile
      ? {
          kind: "tool_profile",
          toolName: profile.toolName,
          environment: profile.environment,
          profileKey: profile.profileKey,
        }
      : {
          kind: "tool",
          system: gap.system,
          desiredToolName: null,
          requirementKind: gap.requirementKind,
          requirementRole: gap.requirementRole,
        },
    requirement: {
      summary: profile
        ? `动作「${gap.actionName}」已绑定 ${profile.toolName}，但 ${profile.environment} Tool Profile 尚未通过配置与 probe 闸门，OntoCode 已暂停。${
            // #B3 — a capped field list must say so, or a required credential
            // field beyond the cap silently never gets asked for.
            typeof profile.fieldsTotal === "number" &&
            profile.fieldsTotal > profile.fields.length
              ? `注意：工具声明了 ${profile.fieldsTotal} 个配置字段，本任务仅读取到前 ${profile.fields.length} 个，字段清单不完整。`
              : ""
          }`.slice(0, 4_000)
        : `动作「${gap.actionName}」缺少覆盖 ${gap.system}（${gap.requirementKind}/${gap.requirementRole}）的已授权 Tool，OntoCode 已暂停等待配置。`.slice(
            0,
            4_000,
          ),
      reason: gap.reason,
      missingFields,
      sourceRefs: [
        `harness-job:${input.jobId}`,
        `ontology-action:${gap.actionName}`,
        `integration-requirement:${gap.requirementId}`,
        ...(profile ? [`tool:${profile.toolName}`] : []),
      ],
    },
    verificationPolicy: profile
      ? {
          kind: "tool_profile",
          toolName: profile.toolName,
          environment: profile.environment,
          profileKey: profile.profileKey,
        }
      : { kind: "tool_contract" },
    resumeAction,
    ontologyHash,
    idempotencyKey: `worker:${input.jobId}:config`,
  });
  return { taskId: created.task.id, mode: created.mode };
}

export interface OntoCodeFactoryRunRuntime {
  startRun: typeof startRun;
  subscribeRun: typeof subscribeRun;
  abortRun: typeof abortRun;
  enqueueHumanMessage: typeof enqueueHumanMessage;
  /** Durable ordinary-continuation dispatch + serialized ctx ledger. */
  acceptStableContinuation?: typeof acceptOntoCodeStableContinuation;
  /** Exact live-driver check used by crash reconnects. */
  isActiveRun?: typeof isActiveRun;
  /** Test/adapter seam for the durable draft projection; production uses the
   * exact Factory draft store below. */
  loadDurableAgents?: typeof loadDurableFactoryAgents;
}

const DEFAULT_FACTORY_RUN_RUNTIME: OntoCodeFactoryRunRuntime = {
  startRun,
  subscribeRun,
  abortRun,
  enqueueHumanMessage,
  acceptStableContinuation: acceptOntoCodeStableContinuation,
  isActiveRun,
};

interface CapturedFactoryAgent {
  slug: string;
  actionName: string;
  name: string;
  card: Record<string, unknown>;
  design: Record<string, unknown> | null;
  generatedCode: string | null;
  /** Parent action name when this agent came from design_subagent. */
  parentAgent?: string;
}

async function loadDurableFactoryAgents(
  input: OntoCodeFactoryBuildInput,
  runId: string,
  capturedAgents: CapturedFactoryAgent[],
  checkpoint: CompactFactoryDraftCheckpoint | null,
  requireDelivery: boolean,
): Promise<Array<Record<string, unknown>>> {
  const covered = checkpoint ? new Set(checkpoint.coveredAgents) : null;
  const selected = requireDelivery
    ? capturedAgents
    : capturedAgents.filter((agent) => covered?.has(agent.actionName));
  if (selected.length === 0) return [];
  const draftStore = makeFactoryPorts(
    input.tenantSlug,
    input.tenantId,
    input.domain,
    input.actorId ?? undefined,
    input.ontologyDomainRegistrationId,
    input.runtimeProfileVersionId,
  ).drafts;
  if (!draftStore) {
    if (!requireDelivery) return [];
    throw new OntoCodeHarnessExecutionError(
      "factory_draft_store_missing",
      "Agent Factory did not expose the durable draft store",
      {
        recoverable: true,
        retryable: false,
        details: { factoryRunId: runId },
      },
    );
  }
  if (checkpoint?.schema === "agent-factory-draft-checkpoint/v1") {
    // A pre-lineage checkpoint can still render its captured Agent preview,
    // but it must never consult mutable `latest` and acquire Candidate
    // semantics. Explicit recovery reports a more specific refusal before
    // reaching this loader.
    if (!requireDelivery) return [];
    throw new OntoCodeHarnessExecutionError(
      "factory_draft_lineage_missing",
      "The Factory draft checkpoint predates immutable version lineage and cannot be safely rebound",
      {
        recoverable: true,
        retryable: false,
        details: { factoryRunId: runId },
      },
    );
  }
  let drafts: AgentDraft[];
  if (checkpoint) {
    if (!draftStore.getVersion) {
      throw new OntoCodeHarnessExecutionError(
        "factory_draft_exact_read_unavailable",
        "The draft store cannot read the exact immutable version recorded by save_draft",
        {
          recoverable: false,
          retryable: false,
          details: {
            factoryRunId: runId,
            draftVersionId: checkpoint.draftVersionId,
          },
        },
      );
    }
    drafts = await draftStore.getVersion(
      input.domain,
      checkpoint.draftVersionId,
    );
    const actualSpecsFingerprint = specsFingerprint(
      drafts.map((draft) => draft.spec),
    );
    if (
      drafts.length !== checkpoint.persisted ||
      drafts.some((draft) => draft.versionId !== checkpoint.draftVersionId) ||
      actualSpecsFingerprint !== checkpoint.specsFingerprint
    ) {
      throw new OntoCodeHarnessExecutionError(
        "factory_draft_lineage_mismatch",
        "The immutable Factory draft does not match the version and complete-spec digest recorded by save_draft",
        {
          recoverable: false,
          retryable: false,
          details: {
            factoryRunId: runId,
            draftVersionId: checkpoint.draftVersionId,
            expectedSpecsFingerprint: checkpoint.specsFingerprint,
            actualSpecsFingerprint,
            persisted: checkpoint.persisted,
            actualDraftCount: drafts.length,
          },
        },
      );
    }
  } else {
    drafts = await draftStore.list(input.domain);
  }
  const durableAgents: Array<Record<string, unknown>> = [];
  for (const captured of selected) {
    const draft = drafts?.find((candidate) => candidate.slug === captured.slug);
    if (!draft) {
      if (!requireDelivery) return [];
      throw new OntoCodeHarnessExecutionError(
        "factory_draft_missing",
        `Agent Factory delivered ${captured.slug} without a durable generated spec`,
        {
          recoverable: true,
          retryable: false,
          details: { factoryRunId: runId, slug: captured.slug },
        },
      );
    }
    if (draft.spec.actionName !== captured.actionName) {
      throw new OntoCodeHarnessExecutionError(
        "factory_draft_action_mismatch",
        `The durable generated spec for ${captured.slug} belongs to a different Ontology Action`,
        {
          recoverable: false,
          retryable: false,
          details: {
            factoryRunId: runId,
            slug: captured.slug,
            capturedActionName: captured.actionName,
            durableActionName: draft.spec.actionName,
          },
        },
      );
    }
    if (
      captured.generatedCode &&
      draft.spec.generatedCode !== captured.generatedCode
    ) {
      throw new OntoCodeHarnessExecutionError(
        "factory_draft_code_mismatch",
        `The durable generated code for ${captured.slug} differs from the delivered Factory event`,
        {
          recoverable: false,
          retryable: false,
          details: { factoryRunId: runId, slug: captured.slug },
        },
      );
    }
    durableAgents.push({
      slug: captured.slug,
      actionName: captured.actionName,
      name: captured.name,
      card: captured.card,
      design: captured.design,
      draftVersionId: draft.versionId ?? null,
      spec: draft.spec,
      generatedCode: draft.spec.generatedCode ?? null,
    });
  }
  return durableAgents;
}

/**
 * OntoCode stores the user's answer as the interaction-card value, while the
 * Factory mailbox routes human messages by an explicit protocol tag. Keep that
 * transport detail inside the adapter: an FDE selecting a structured option
 * must not have to know or type `[澄清回答]`, and a strict durable delivery must
 * never be rejected as an untyped chat message.
 */
function factoryHumanGateAnswer(
  kind: FactoryHumanInteractionKind,
  answer: string,
): string {
  const trimmed = answer.trim();
  if (kind !== "clarify" || /^\[澄清回答\]\s*/.test(trimmed)) return trimmed;
  return `[澄清回答] ${trimmed}`;
}

const ONTOCODE_CONTINUATION_MARKER_PREFIX = "[OntoCode stable continuation]";

function ontocodeContinuationMarker(answerId: string): string {
  return `${ONTOCODE_CONTINUATION_MARKER_PREFIX} ${answerId}`;
}

const ONTOCODE_STABLE_CONTINUATION_LEDGER_LIMIT = 64;
const ONTOCODE_STABLE_CONTINUATION_LEDGER_KEY =
  "ontocodeStableContinuationLedger";

type OntoCodeStableContinuationLedgerEntry = {
  schema: "ontocode-stable-continuation/v1";
  answerId: string;
  answerDigest: string;
  acceptedAt: number;
};

function stableContinuationLedger(
  checkpoint: Record<string, unknown>,
): OntoCodeStableContinuationLedgerEntry[] | null {
  const raw = checkpoint[ONTOCODE_STABLE_CONTINUATION_LEDGER_KEY];
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.length > ONTOCODE_STABLE_CONTINUATION_LEDGER_LIMIT
  ) {
    return null;
  }
  const entries: OntoCodeStableContinuationLedgerEntry[] = [];
  for (const value of raw) {
    const entry = asRecord(value);
    const answerId = nonEmptyString(entry?.answerId);
    const answerDigest = nonEmptyString(entry?.answerDigest);
    if (
      entry?.schema !== "ontocode-stable-continuation/v1" ||
      !answerId ||
      !answerDigest ||
      !/^[a-f0-9]{64}$/.test(answerDigest) ||
      !Number.isSafeInteger(entry.acceptedAt) ||
      Number(entry.acceptedAt) < 1
    ) {
      return null;
    }
    entries.push({
      schema: "ontocode-stable-continuation/v1",
      answerId,
      answerDigest,
      acceptedAt: Number(entry.acceptedAt),
    });
  }
  if (new Set(entries.map((entry) => entry.answerId)).size !== entries.length) {
    return null;
  }
  return entries;
}

function checkpointHasOntoCodeContinuation(
  checkpoint: Record<string, unknown>,
  answerId: string,
  answerDigest: string,
): boolean {
  return Boolean(
    stableContinuationLedger(checkpoint)?.some(
      (entry) =>
        entry.answerId === answerId && entry.answerDigest === answerDigest,
    ),
  );
}

/**
 * Commit an ordinary OntoCode continuation to the same at-least-once mailbox
 * used by the conductor, then bind its server id + digest into the serialized
 * conversation ctx. The mailbox delivery id remains the consumption boundary;
 * this bounded ledger is the product-level dispatch/idempotency authority.
 */
function acceptOntoCodeStableContinuation(input: {
  tenantId: string;
  domain: string;
  buildExecutionId: string;
  engineRunId: string;
  interactionId: string;
  answerId: string;
  answer: string;
  actorId?: string;
}): Extract<HumanMessageEnqueueResult, "queued" | "duplicate_interaction"> {
  const answerDigest = createHash("sha256").update(input.answer).digest("hex");
  const deliveryKey = `ontocode:${input.buildExecutionId}:${input.answerId}:${answerDigest}`;
  const queued = enqueueHumanMessage(
    input.engineRunId,
    `${ontocodeContinuationMarker(input.answerId)}\n${input.answer}`,
    input.tenantId,
    input.actorId,
    undefined,
    { deliveryKey },
  );
  if (queued === "rejected") {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_continuation_rejected",
      "OntoCode 的继续执行指令未能写入耐久队列",
      { recoverable: true, retryable: true },
    );
  }

  const db = getDb();
  db.transaction((tx) => {
    const conversation = tx
      .select({
        tenantId: factoryConversations.tenantId,
        domain: factoryConversations.domain,
        ctxJson: factoryConversations.ctxJson,
        updatedAt: factoryConversations.updatedAt,
      })
      .from(factoryConversations)
      .where(eq(factoryConversations.id, input.engineRunId))
      .get();
    const checkpoint = asRecord(conversation?.ctxJson);
    const ledger = checkpoint ? stableContinuationLedger(checkpoint) : null;
    const execution = tx
      .select({
        engineRunId: ontocodeBuildExecutions.engineRunId,
        state: ontocodeBuildExecutions.state,
        pendingInteractionId: ontocodeBuildExecutions.pendingInteractionId,
        pendingAnswerId: ontocodeBuildExecutions.pendingAnswerId,
        pendingAnswerDigest: ontocodeBuildExecutions.pendingAnswerDigest,
        pendingAnswerStatus: ontocodeBuildExecutions.pendingAnswerStatus,
        revision: ontocodeBuildExecutions.revision,
      })
      .from(ontocodeBuildExecutions)
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, input.tenantId),
          eq(ontocodeBuildExecutions.id, input.buildExecutionId),
        ),
      )
      .get();
    if (
      !conversation ||
      conversation.tenantId !== input.tenantId ||
      conversation.domain !== input.domain ||
      !checkpoint ||
      !ledger ||
      activeHumanInteraction(
        checkpoint as Parameters<typeof activeHumanInteraction>[0],
      ) !== null ||
      activeHumanInteractionKind(
        checkpoint as Parameters<typeof activeHumanInteractionKind>[0],
      ) !== null ||
      !execution ||
      execution.engineRunId !== input.engineRunId ||
      (execution.state !== "running" && execution.state !== "resuming") ||
      execution.pendingInteractionId !== input.interactionId ||
      execution.pendingAnswerId !== input.answerId ||
      execution.pendingAnswerDigest !== answerDigest ||
      (execution.pendingAnswerStatus !== "pending" &&
        execution.pendingAnswerStatus !== "delivered")
    ) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_continuation_checkpoint_mismatch",
        "OntoCode 的继续执行指令不再匹配当前稳定构建检查点",
        { recoverable: true, retryable: false },
      );
    }
    const sameId = ledger.find((entry) => entry.answerId === input.answerId);
    if (sameId && sameId.answerDigest !== answerDigest) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_continuation_digest_mismatch",
        "同一个 OntoCode 继续执行标识绑定了不同答案",
        { recoverable: true, retryable: false },
      );
    }
    if (sameId && execution.pendingAnswerStatus === "delivered") return;

    const nextLedger = sameId
      ? ledger
      : [
          ...ledger,
          {
            schema: "ontocode-stable-continuation/v1" as const,
            answerId: input.answerId,
            answerDigest,
            acceptedAt: Date.now(),
          },
        ].slice(-ONTOCODE_STABLE_CONTINUATION_LEDGER_LIMIT);
    const now = new Date();
    const conversationUpdate = tx
      .update(factoryConversations)
      .set({
        ctxJson: {
          ...checkpoint,
          [ONTOCODE_STABLE_CONTINUATION_LEDGER_KEY]: nextLedger,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(factoryConversations.id, input.engineRunId),
          eq(factoryConversations.tenantId, input.tenantId),
          eq(factoryConversations.domain, input.domain),
          eq(factoryConversations.updatedAt, conversation.updatedAt),
        ),
      )
      .run() as { changes?: number };
    const executionUpdate = tx
      .update(ontocodeBuildExecutions)
      .set({
        pendingAnswerStatus: "delivered",
        revision: sql`${ontocodeBuildExecutions.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, input.tenantId),
          eq(ontocodeBuildExecutions.id, input.buildExecutionId),
          eq(ontocodeBuildExecutions.revision, execution.revision),
          inArray(ontocodeBuildExecutions.pendingAnswerStatus, [
            "pending",
            "delivered",
          ]),
        ),
      )
      .run() as { changes?: number };
    if (
      (conversationUpdate.changes ?? 0) !== 1 ||
      (executionUpdate.changes ?? 0) !== 1
    ) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_continuation_changed",
        "OntoCode 的继续执行检查点在提交时发生变化",
        { recoverable: true, retryable: true },
      );
    }
  });
  return queued;
}

export async function runFactoryBuild(
  input: OntoCodeFactoryBuildInput,
  runtime: OntoCodeFactoryRunRuntime = DEFAULT_FACTORY_RUN_RUNTIME,
): Promise<OntoCodeFactoryBuildResult> {
  // The worker races its executor against cancellation. The losing executor
  // promise is still allowed to unwind in JavaScript, so it can arrive here
  // after the Harness job has already been retried or finalized. Starting a
  // detached Factory driver before observing that stale signal creates an
  // orphan run with no Session bridge and can spend LLM tokens behind a failed
  // job. Refuse before any durable Factory row or driver is created.
  if (input.signal.aborted) {
    throw (
      input.signal.reason ??
      new OntoCodeHarnessExecutionError(
        "factory_build_aborted",
        "The Agent Factory build was aborted before it started",
        { recoverable: true, retryable: true },
      )
    );
  }
  const runId =
    input.resume?.factoryRunId ??
    input.reconnect?.factoryRunId ??
    input.engineRunId ??
    `ocf-${input.jobId}-a${input.attempt}`;
  const agents = new Map<string, CapturedFactoryAgent>();
  const actionNames = new Set<string>();
  const checkpointedAgents =
    input.resume?.capturedAgents ?? input.reconnect?.capturedAgents ?? [];
  for (const captured of checkpointedAgents) {
    if (agents.has(captured.slug) || actionNames.has(captured.actionName)) {
      throw new OntoCodeHarnessExecutionError(
        "factory_resume_agent_duplicate",
        "The parked Factory checkpoint contains duplicate Agent identity",
        {
          recoverable: true,
          retryable: false,
          details: {
            waitingJobId: input.resume?.waitingJobId,
            factoryRunId: runId,
            slug: captured.slug,
            actionName: captured.actionName,
          },
        },
      );
    }
    agents.set(captured.slug, {
      slug: captured.slug,
      actionName: captured.actionName,
      name: captured.name,
      card: { ...captured.card },
      design: captured.design ? { ...captured.design } : null,
      generatedCode: captured.generatedCode,
    });
    actionNames.add(captured.actionName);
  }
  const seededSlugs = new Set(agents.keys());
  const seededActionNames = new Set(actionNames);
  let sandbox: Record<string, unknown> | null = null;
  let readiness: CompactFactoryReadiness | null = null;
  let draftCheckpoint: CompactFactoryDraftCheckpoint | null = null;
  let lastError: string | null = null;
  let lastRetryableError: string | null = null;
  let lastMessage: string | null = null;
  let pendingClarification: {
    interaction: Record<string, unknown>;
    message: string;
  } | null = null;

  const resumesExecutionReadiness =
    input.resume?.interactionKind === "execution_readiness";
  const reconnectingActiveRun = Boolean(
    input.reconnect?.mode === "reattach" && runtime.isActiveRun?.(runId),
  );
  if (resumesExecutionReadiness && runtime.isActiveRun?.(runId)) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_readiness_continuation_active",
      "OntoCode 的上一轮内部生成仍在运行，当前继续指令尚未投递",
      { recoverable: true, retryable: true },
    );
  }
  if (
    input.buildExecutionId &&
    (input.budget?.maxModelCalls === undefined ||
      input.budget.maxToolCalls === undefined)
  ) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_budget_missing",
      "The stable OntoCode Build execution is missing its explicit model or tool-call limit",
      { recoverable: true, retryable: false },
    );
  }
  if (resumesExecutionReadiness) {
    if (
      !input.buildExecutionId ||
      !input.resume?.answerId ||
      !runtime.acceptStableContinuation
    ) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_continuation_dispatch_unavailable",
        "OntoCode 的稳定继续执行通道不可用",
        { recoverable: true, retryable: false },
      );
    }
    const accepted = runtime.acceptStableContinuation({
      tenantId: input.tenantId,
      domain: input.domain,
      buildExecutionId: input.buildExecutionId,
      engineRunId: runId,
      interactionId: input.resume.interactionId,
      answerId: input.resume.answerId,
      answer: input.resume.answer,
      ...(input.actorId ? { actorId: input.actorId } : {}),
    });
    try {
      input.onAnswerDelivery?.(accepted);
    } catch (error) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_answer_delivery_uncommitted",
        `OntoCode could not commit the accepted Build answer: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          recoverable: true,
          retryable: true,
          details: {
            waitingJobId: input.resume.waitingJobId,
            buildExecutionId: input.buildExecutionId,
            interactionId: input.resume.interactionId,
            enqueueResult: accepted,
          },
        },
      );
    }
  }
  if (!reconnectingActiveRun) {
    runtime.startRun({
      domain: input.domain,
      goal: resumesExecutionReadiness ? input.resume!.persistGoal : input.goal,
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      ontologyDomainRegistrationId: input.ontologyDomainRegistrationId,
      runtimeProfileVersionId: input.runtimeProfileVersionId,
      confirmedActor: input.actorId ?? undefined,
      conversationId: runId,
      runId,
      // A reconnect inherits interaction policy and generation scope from the
      // exact conversation checkpoint. The stable, server-owned Job budget is
      // deliberately re-supplied below: it is an absolute execution cap, and
      // a stopped driver must not fall back to a legacy checkpoint's smaller
      // internal default (nor reset cumulative spend).
      ...(input.reconnect?.mode === "reattach"
        ? {}
        : { interactionPolicy: input.interactionPolicy }),
      ...(input.resume && !resumesExecutionReadiness
        ? {
            continuationMode: "human_gate_resume" as const,
            persistGoal: input.resume.persistGoal,
          }
        : resumesExecutionReadiness
          ? {
              continuationMode: "crash_resume" as const,
              persistGoal: input.resume!.persistGoal,
            }
          : input.reconnect?.mode === "reattach"
            ? {
                continuationMode: "crash_resume" as const,
                persistGoal: input.reconnect.persistGoal,
              }
            : { persistGoal: input.goal }),
      ...(input.reconnect?.mode === "reattach"
        ? {}
        : { generationDirective: input.directive }),
      executionBudget: {
        ...(input.budget?.maxModelCalls === undefined
          ? {}
          : { maxTurns: input.budget.maxModelCalls }),
        ...(input.budget?.maxToolCalls === undefined
          ? {}
          : { maxToolCalls: input.budget.maxToolCalls }),
        ...(input.buildExecutionId
          ? { stableExecutionId: input.buildExecutionId }
          : {}),
      },
    });
  }
  if (input.resume && !resumesExecutionReadiness) {
    let enqueueResult: HumanMessageEnqueueResult;
    const gateResume = input.resume as typeof input.resume & {
      interactionKind: FactoryHumanInteractionKind;
    };
    try {
      enqueueResult = runtime.enqueueHumanMessage(
        runId,
        factoryHumanGateAnswer(gateResume.interactionKind, gateResume.answer),
        input.tenantId,
        input.actorId ?? undefined,
        {
          interactionId: gateResume.interactionId,
          gateKind: gateResume.interactionKind,
        },
      );
    } catch (error) {
      runtime.abortRun(runId, input.tenantId);
      throw new OntoCodeHarnessExecutionError(
        "factory_resume_message_unavailable",
        `The exact human-gate answer could not be durably queued: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          recoverable: true,
          retryable: false,
          details: {
            waitingJobId: input.resume.waitingJobId,
            factoryRunId: runId,
            interactionId: input.resume.interactionId,
          },
        },
      );
    }
    if (enqueueResult === "rejected") {
      runtime.abortRun(runId, input.tenantId);
      throw new OntoCodeHarnessExecutionError(
        "factory_resume_message_rejected",
        "The internal generation engine rejected the exact human-gate answer",
        {
          recoverable: true,
          retryable: false,
          details: {
            waitingJobId: input.resume.waitingJobId,
            factoryRunId: runId,
            interactionId: input.resume.interactionId,
            enqueueResult,
          },
        },
      );
    }
    try {
      input.onAnswerDelivery?.(enqueueResult);
    } catch (error) {
      runtime.abortRun(runId, input.tenantId);
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_answer_delivery_uncommitted",
        `OntoCode could not commit the accepted Build answer: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          recoverable: true,
          retryable: true,
          details: {
            waitingJobId: input.resume.waitingJobId,
            buildExecutionId: input.buildExecutionId ?? null,
            interactionId: input.resume.interactionId,
            enqueueResult,
          },
        },
      );
    }
  }

  return new Promise<OntoCodeFactoryBuildResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let progressTail: Promise<void> = Promise.resolve();

    const cleanup = (): void => {
      unsubscribe();
      input.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (result: OntoCodeFactoryBuildResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    // A failed progress write used to abort the run, unconditionally. That was
    // defensible when a build wrote ~14 progress rows, all of them carrying job
    // outcome. With the telemetry bridge below it writes up to four hundred, and
    // an observability row is not worth a live build: losing the trace of a
    // successful build is bad, killing the build to protect the trace is worse.
    //
    // So the policy splits by what the row MEANS, not by how it failed. Rows
    // that carry outcome (stage, agent_created, sandbox, clarification,
    // readiness, and every non-telemetry caller) still abort — if we cannot
    // record that a sandbox ran, we must not proceed as though it did. Pure
    // telemetry counts the loss and reports it at the end. Never silently.
    let telemetryWritesLost = 0;
    const queueProgress = (
      type: string,
      payload: Record<string, unknown>,
      visibility?: "user" | "debug" | "audit",
      opts: { telemetryOnly?: boolean } = {},
    ): void => {
      const safePayload = redactHarnessTelemetryPayload(payload);
      progressTail = progressTail
        .then(() => input.onProgress(type, safePayload, visibility))
        .catch((error) => {
          // Losing the lease is a correctness signal, not a write failure: this
          // worker no longer owns the job and must stop regardless of the row.
          if (
            !opts.telemetryOnly ||
            error instanceof OntoCodeHarnessLostLeaseError
          ) {
            runtime.abortRun(runId, input.tenantId);
            fail(error);
            return;
          }
          telemetryWritesLost += 1;
        });
    };

    // ── #HARNESS-TELEMETRY ───────────────────────────────────────────────────
    // The Factory brain streams a real harness loop: policy/strategy summaries,
    // explicit reasoning-step summaries, tool calls with their stated reason,
    // heartbeats, and tool results. Until now this
    // bridge forwarded only stage markers, agent.created, sandbox and the rare
    // readiness-bearing tool.result — so an OntoCode Session recorded a handful
    // of coarse phase events and the reasoning panel had nothing to show. The
    // work was happening; the evidence was being thrown away at this boundary.
    //
    // Two constraints shape what follows:
    //  · The legacy stream calls ordinary assistant-content deltas `think`.
    //    Those are NOT provider-private reasoning or ReAct evidence. We ignore
    //    them here and persist the final `message` once, instead of relabelling
    //    normal answer text as hidden thinking.
    //  · Everything is bounded, and a hit bound SAYS SO. A silently truncated
    //    trace reads as "the brain did this little", which is a lie about the
    //    run. When the budget runs out we emit one explicit notice and stop.
    const TELEMETRY_BUDGET = 400;
    let telemetryEmitted = 0;
    let telemetryExhausted = false;
    // What the cap actually cost, per row type. The notice below has always
    // reported the count it had ALREADY written — an honest number, but not the
    // one being asked for. "Some more happened" makes a run that lost three
    // rows read exactly like a run that lost three hundred.
    const budgetDroppedFrames = new Map<string, number>();

    /** Bounded emit. Returns false once the budget is spent, having said so once. */
    const emitTelemetry = (
      type: string,
      payload: Record<string, unknown>,
    ): boolean => {
      if (telemetryExhausted) {
        budgetDroppedFrames.set(type, (budgetDroppedFrames.get(type) ?? 0) + 1);
        return false;
      }
      if (telemetryEmitted >= TELEMETRY_BUDGET) {
        telemetryExhausted = true;
        // The row that TRIPS the cap is dropped like every row after it, and
        // is counted like them. Exempting it would understate the loss by one
        // on every capped run.
        budgetDroppedFrames.set(type, (budgetDroppedFrames.get(type) ?? 0) + 1);
        queueProgress(
          `harness.${input.operation}.telemetry_truncated`,
          {
            factoryRunId: runId,
            emitted: telemetryEmitted,
            lost: telemetryWritesLost,
            note: "本次运行的推理/工具明细超过单次记录上限，后续步骤不再逐条记录；作业结论与产物不受影响。",
          },
          "user",
        );
        return false;
      }
      telemetryEmitted += 1;
      queueProgress(type, payload, "debug", { telemetryOnly: true });
      return true;
    };

    // ── Frame accounting ────────────────────────────────────────────────────
    // This bridge used to end with `if (event.t !== "done") return;`, which
    // discarded every frame it did not explicitly recognise — no counter, no
    // notice, nothing to read afterwards. Two ledgers replace that silence:
    //
    //  · `suppressedFrames` — frames we deliberately do not persist, each with
    //    the reason. A decision to drop is legitimate; hiding that it happened
    //    is not, so the count and the reason ride out with the trace.
    //  · `unbridgedFrames` — frames this bridge does not recognise at all. That
    //    is a wiring gap, and it must announce itself rather than wait for
    //    someone to notice an empty panel months later.
    const suppressedFrames = new Map<
      string,
      {
        count: number;
        reason: string;
        /** Evaluated when the ledger is written, so a reason that makes a claim
         *  about ANOTHER row can be checked against what the run really did
         *  instead of being taken on faith. */
        evidence?: () => Record<string, unknown>;
      }
    >();
    const unbridgedFrames = new Map<string, number>();
    /** Narration rows this run really wrote. The evidence behind the `think`
     *  suppression reason — measured, never assumed. */
    let narrationRowsRecorded = 0;
    const suppressFrame = (
      frame: string,
      reason: string,
      evidence?: () => Record<string, unknown>,
    ): void => {
      const entry = suppressedFrames.get(frame);
      if (entry) entry.count += 1;
      else
        suppressedFrames.set(frame, {
          count: 1,
          reason,
          ...(evidence ? { evidence } : {}),
        });
    };
    const recordUnbridgedFrame = (frame: string): void => {
      unbridgedFrames.set(frame, (unbridgedFrames.get(frame) ?? 0) + 1);
    };
    /** Report both ledgers once, at the end. Never conditional on success —
     *  an incomplete or waiting run still says what it did not carry across.
     *  A hard abort (`onAbort`) is the one path that skips this: it tears the
     *  subscription down mid-flight, and that run's account of itself is the
     *  failure receipt, not a partial ledger. */
    const reportFrameAccounting = (): void => {
      if (suppressedFrames.size > 0) {
        let total = 0;
        const byType = [...suppressedFrames.entries()].map(([frame, entry]) => {
          total += entry.count;
          return {
            frame,
            count: entry.count,
            reason: entry.reason,
            ...(entry.evidence ? entry.evidence() : {}),
          };
        });
        queueProgress(
          `harness.${input.operation}.telemetry_suppressed`,
          { factoryRunId: runId, total, byType },
          "debug",
        );
      }
      if (budgetDroppedFrames.size > 0) {
        let dropped = 0;
        // Keyed by the SESSION EVENT type, not the brain frame name: this
        // ledger counts rows the cap refused to write, and that is the name
        // they would have been written under.
        const byType = [...budgetDroppedFrames.entries()].map(
          ([eventType, count]) => {
            dropped += count;
            return { eventType, count };
          },
        );
        queueProgress(
          `harness.${input.operation}.telemetry_budget_dropped`,
          { factoryRunId: runId, emitted: telemetryEmitted, dropped, byType },
          "debug",
        );
      }
      if (unbridgedFrames.size > 0) {
        let total = 0;
        const byType = [...unbridgedFrames.entries()].map(([frame, count]) => {
          total += count;
          return { frame, count };
        });
        queueProgress(
          `harness.${input.operation}.telemetry_unbridged`,
          { factoryRunId: runId, total, byType },
          "debug",
        );
      }
    };

    /** Free text on its way into a persisted trace row. Bounded and redacted:
     *  a brain sentence can quote a credential it just read. */
    const traceText = (value: unknown, max: number): string | null => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      const safe = redactHarnessTelemetryText(trimmed);
      return safe.length > max ? `${safe.slice(0, max)}…（已截断）` : safe;
    };

    /** Compact a tool argument blob to something a human can read in a log row.
     *  Never the full payload: a resume base64 would bury the trace. */
    const compactToolInput = (value: unknown): string | null => {
      if (value == null) return null;
      let text: string;
      try {
        const safeValue =
          value && typeof value === "object" && !Array.isArray(value)
            ? redactHarnessTelemetryPayload(value as Record<string, unknown>)
            : sanitizeSensitiveInput(value, "harness.tool_input").sanitized;
        text =
          typeof safeValue === "string"
            ? redactHarnessTelemetryText(safeValue)
            : JSON.stringify(safeValue);
      } catch {
        return null;
      }
      if (!text) return null;
      return text.length > 600 ? `${text.slice(0, 600)}…（已截断）` : text;
    };
    const onAbort = (): void => {
      runtime.abortRun(runId, input.tenantId);
      fail(
        input.signal.reason ??
          new OntoCodeHarnessExecutionError(
            "factory_build_aborted",
            "The Agent Factory build was aborted",
            { recoverable: true, retryable: true },
          ),
      );
    };
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    input.signal.addEventListener("abort", onAbort, { once: true });

    const subscription = runtime.subscribeRun(
      runId,
      (event) => {
        if (settled) return;
        if (event.t === "run.started") {
          // The job's own start is already an outcome-bearing row
          // (`harness.job.started`); a second one would say nothing new.
          suppressFrame("run.started", "job_start_recorded_by_worker");
          return;
        }
        // #HARNESS-TELEMETRY — the real loop, bridged. A legacy `think` frame
        // is ordinary streamed assistant text, not proof of private reasoning,
        // and it arrives one delta at a time. This bridge does not persist a
        // delta: a row per token would bury the trace it exists to make
        // readable.
        //
        // The reason recorded here used to go further and CLAIM the same text
        // was landing as narration. That is a statement about a different frame
        // — the producer's `message` — and nothing here could check it, so a
        // run where no `message` ever arrived reported a reassuring reason for
        // text that had in fact been dropped. The reason now describes only
        // what this bridge does, and carries the MEASURED number of narration
        // rows the run actually wrote so a reader can see for themselves
        // whether the streamed text survived.
        if (event.t === "think") {
          suppressFrame(
            "think",
            "streaming_delta_not_persisted_per_frame",
            () => ({
              narrationRowsRecorded,
            }),
          );
          return;
        }
        if (event.t === "policy") {
          emitTelemetry(`harness.${input.operation}.policy`, {
            factoryRunId: runId,
            pipeline: event.pipeline,
            strategy: event.strategy ?? null,
            band: event.band,
            deepUnderstand: event.deepUnderstand,
            deepCritique: event.deepCritique,
            tierBias: event.tierBias ?? null,
            reasons: event.reasons
              .slice(0, 12)
              .map((reason) => reason.slice(0, 500)),
          });
          return;
        }
        if (event.t === "strategy") {
          emitTelemetry(`harness.${input.operation}.strategy`, {
            factoryRunId: runId,
            mode: event.mode,
            steps: event.steps.slice(0, 12),
            chosenBy: event.chosenBy,
            rationale: event.rationale.slice(0, 1_000),
            forAgent: event.forAgent ?? null,
          });
          return;
        }
        if (event.t === "reasoning.step") {
          emitTelemetry(`harness.${input.operation}.reasoning_step`, {
            factoryRunId: runId,
            strategy: event.strategy,
            index: event.index,
            total: event.total,
            // The reasoning kernel emits a deliberately user-visible summary;
            // provider-private chain-of-thought is never requested or stored.
            summary: event.output.slice(0, 4_000),
            forAgent: event.forAgent ?? null,
          });
          return;
        }
        if (event.t === "model") {
          emitTelemetry(`harness.${input.operation}.model`, {
            factoryRunId: runId,
            model: event.model,
            tier: event.tier,
            turn: event.turn,
            provider: event.provider ?? null,
            route: event.route ?? null,
            // Whether the tenant's routes could actually serve the requested
            // difficulty. The router states this on every turn and the
            // telemetry table stores it; dropping it here made a downgraded
            // turn indistinguishable from a normal one in the Session.
            // `null` means the router said nothing — NOT that it was met.
            preferenceSatisfied: event.preferenceSatisfied ?? null,
            preferenceReason: event.preferenceReason ?? null,
          });
          return;
        }
        if (event.t === "reflect") {
          emitTelemetry(`harness.${input.operation}.reflection`, {
            factoryRunId: runId,
            kind: event.kind,
            summary: event.lesson.slice(0, 2_000),
            count: event.count ?? null,
          });
          return;
        }
        if (event.t === "flow.blueprint") {
          const model = asRecord(event.model);
          const phases = Array.isArray(model?.phases) ? model.phases : [];
          const diagrams = Array.isArray(model?.diagrams) ? model.diagrams : [];
          const unresolved = Array.isArray(model?.unresolved)
            ? model.unresolved
            : [];
          emitTelemetry(`harness.${input.operation}.flow_blueprint`, {
            factoryRunId: runId,
            phaseCount: phases.length,
            diagramCount: diagrams.length,
            unresolvedCount: unresolved.length,
            phases: phases.slice(0, 40).flatMap((rawPhase) => {
              const phase = asRecord(rawPhase);
              const id = nonEmptyString(phase?.id);
              const title = nonEmptyString(phase?.title);
              return id || title
                ? [{ id: id ?? null, title: title ?? null }]
                : [];
            }),
          });
          return;
        }
        if (event.t === "tool.call") {
          emitTelemetry(`harness.${input.operation}.tool_call`, {
            factoryRunId: runId,
            callId: event.id,
            tool: event.name,
            // The brain states WHY before it calls. That sentence is the most
            // useful thing in the whole trace — it is never dropped.
            reasoning: event.reasoning?.slice(0, 1_000) ?? null,
            input: compactToolInput(event.input),
            forAgent: event.forAgent ?? null,
            role: event.role ?? null,
          });
          return;
        }
        if (event.t === "tool.progress") {
          // Heartbeats fire every ~15s; only the escalation notes carry news.
          // The rest would be pure noise in a persisted log.
          if (!event.note) return;
          emitTelemetry(`harness.${input.operation}.tool_progress`, {
            factoryRunId: runId,
            callId: event.id,
            tool: event.name,
            elapsedS: event.elapsedS,
            note: event.note,
          });
          return;
        }
        if (event.t === "plan") {
          emitTelemetry(`harness.${input.operation}.plan`, {
            factoryRunId: runId,
            plan: event.plan,
          });
          return;
        }
        if (event.t === "validation") {
          emitTelemetry(`harness.${input.operation}.validation`, {
            factoryRunId: runId,
            ok: event.ok,
            issues: event.issues.slice(0, 20),
            issueCount: event.issues.length,
          });
          return;
        }
        if (event.t === "catalog") {
          emitTelemetry(`harness.${input.operation}.ontology_read`, {
            factoryRunId: runId,
            domain: event.domain,
            actions: event.actions,
            events: event.events,
            agentActions: event.agentActions,
          });
          return;
        }
        if (event.t === "stage") {
          queueProgress(`harness.${input.operation}.stage`, {
            factoryRunId: runId,
            stage: event.stage,
            status: event.status,
            detail: event.detail ?? null,
          });
          return;
        }
        if (event.t === "agent.created") {
          const replaysCheckpointedIdentity = Boolean(
            input.resume &&
            (seededSlugs.has(event.spec.slug) ||
              seededActionNames.has(event.spec.actionName)),
          );
          if (input.resume && replaysCheckpointedIdentity) {
            const checkpointedBySlug = agents.get(event.spec.slug);
            const checkpointedByAction = [...agents.values()].find(
              (agent) => agent.actionName === event.spec.actionName,
            );
            const exactReadinessReplacement = Boolean(
              resumesExecutionReadiness &&
              checkpointedBySlug?.actionName === event.spec.actionName &&
              checkpointedByAction?.slug === event.spec.slug &&
              input.directive.requestedActionNames.includes(
                event.spec.actionName,
              ),
            );
            if (!exactReadinessReplacement) {
              runtime.abortRun(runId, input.tenantId);
              fail(
                new OntoCodeHarnessExecutionError(
                  resumesExecutionReadiness
                    ? "ontocode_build_readiness_identity_mismatch"
                    : "factory_resume_replayed_agent",
                  resumesExecutionReadiness
                    ? `OntoCode continuation attempted to replace Agent ${event.spec.actionName} under a different or out-of-scope identity`
                    : `Factory resume attempted to redesign already-checkpointed Agent ${event.spec.actionName}`,
                  {
                    recoverable: true,
                    retryable: false,
                    details: {
                      waitingJobId: input.resume.waitingJobId,
                      factoryRunId: runId,
                      slug: event.spec.slug,
                      actionName: event.spec.actionName,
                      checkpointedSlug: checkpointedByAction?.slug ?? null,
                      checkpointedActionName:
                        checkpointedBySlug?.actionName ?? null,
                    },
                  },
                ),
              );
              return;
            }
          }
          agents.set(event.spec.slug, {
            slug: event.spec.slug,
            actionName: event.spec.actionName,
            name: event.spec.nameZh || event.spec.short,
            card: { ...event.spec },
            design: event.design ? { ...event.design } : null,
            generatedCode: nonEmptySourceText(event.design?.code),
            ...(event.parentAgent ? { parentAgent: event.parentAgent } : {}),
          });
          actionNames.add(event.spec.actionName);
          queueProgress(`harness.${input.operation}.agent_created`, {
            factoryRunId: runId,
            agent: {
              slug: event.spec.slug,
              actionName: event.spec.actionName,
              name: event.spec.nameZh || event.spec.short,
              // design_subagent provenance, so the FDE can tell a decomposed
              // helper from a scope-covering primary in the live stream.
              ...(event.spec.isSubAgent === true ? { isSubAgent: true } : {}),
              ...(event.parentAgent ? { parentAgent: event.parentAgent } : {}),
            },
          });
          return;
        }
        if (event.t === "sandbox") {
          sandbox = compactSandboxReceipt(event);
          queueProgress(`harness.${input.operation}.sandbox`, {
            factoryRunId: runId,
            sandbox,
          });
          return;
        }
        if (event.t === "test.cases") {
          const uncovered = event.coverage?.uncoveredNeedingData ?? [];
          const question = `已生成 ${event.cases.length} 个测试用例。请选择执行当前用例、重新生成、补充测试数据，或只保存未验证设计稿。`;
          const interaction = event.awaitingApproval
            ? {
                kind: "test_approval",
                awaitingAnswer: true,
                interactionId: event.interactionId ?? null,
                question,
                options: [
                  {
                    label: "执行当前用例",
                    value: "[测试用例决策: 执行]",
                    ...(uncovered.length === 0 ? { recommended: true } : {}),
                  },
                  {
                    label: "重新生成用例",
                    value: "[测试用例决策: 重新生成]",
                  },
                  {
                    label: "补充测试数据",
                    value: "[测试用例决策: 补数据]",
                    ...(uncovered.length > 0 ? { recommended: true } : {}),
                  },
                  {
                    label: "保存未验证设计稿",
                    value: "[测试用例决策: 保存设计稿]",
                  },
                ],
                allowOther: false,
                context:
                  uncovered.length > 0
                    ? `覆盖矩阵仍有 ${uncovered.length} 项需要真实数据：${uncovered.slice(0, 8).join("、")}`
                    : "覆盖矩阵已齐全；确认后才会进入沙箱执行。",
              }
            : null;
          if (interaction) {
            pendingClarification = {
              interaction,
              message: [question, interaction.context].join("\n"),
            };
          }
          queueProgress(`harness.${input.operation}.test_cases`, {
            factoryRunId: runId,
            count: event.cases.length,
            awaitingApproval: event.awaitingApproval,
            coverage: event.coverage ?? null,
            ...(interaction ? { interaction } : {}),
          });
          return;
        }
        if (event.t === "tool.result") {
          // Every result is recorded, not just the readiness-bearing ones. The
          // previous behaviour meant a run could make forty tool calls and
          // leave zero trace of thirty-nine of them.
          emitTelemetry(`harness.${input.operation}.tool_result`, {
            factoryRunId: runId,
            callId: event.id,
            tool: event.name,
            ok: event.ok,
            summary: event.summary?.slice(0, 1_000) ?? null,
            forAgent: event.forAgent ?? null,
          });
          const nextReadiness = compactFactoryReadiness(event);
          if (nextReadiness) {
            readiness = nextReadiness;
            queueProgress(`harness.${input.operation}.readiness`, {
              factoryRunId: runId,
              readiness: nextReadiness,
            });
          }
          const nextDraftCheckpoint = compactFactoryDraftCheckpoint(event);
          if (nextDraftCheckpoint) {
            draftCheckpoint = nextDraftCheckpoint;
            queueProgress(`harness.${input.operation}.draft_generated`, {
              factoryRunId: runId,
              draft: nextDraftCheckpoint,
              verificationState: "generated_unverified",
            });
          }
          return;
        }
        if (event.t === "clarify" && event.awaitingAnswer) {
          const options = (event.options ?? []).map((option) => ({
            ...option,
          }));
          const interaction = {
            kind: "clarify",
            awaitingAnswer: true,
            interactionId: event.interactionId ?? null,
            question: event.question,
            options,
            items: (event.items ?? []).map((item) => ({
              question: item.question,
              ...(item.context ? { context: item.context } : {}),
              ...(item.options
                ? {
                    options: item.options.map((option) => ({
                      ...option,
                    })),
                  }
                : {}),
            })),
            context: event.context ?? null,
          };
          pendingClarification = {
            interaction,
            message: clarificationAssistantText(event),
          };
          queueProgress(`harness.${input.operation}.clarification`, {
            factoryRunId: runId,
            ...interaction,
          });
          // A clarification is an intermediate Factory event. The conductor
          // may still drain authoritative tool results (notably save_draft)
          // before its terminal `done`. Settling here used to unsubscribe and
          // silently discard that durable checkpoint, leaving Build at 0/8.
          return;
        }
        if (event.t === "clarify") {
          pendingClarification = null;
          // A clarification that is NOT parking the run still happened — the
          // brain raised a question and moved on. Dropping it made the trace
          // read as though the question was never asked.
          emitTelemetry(`harness.${input.operation}.clarification_resolved`, {
            factoryRunId: runId,
            interactionId: event.interactionId ?? null,
            question: traceText(event.question, 1_000),
            optionCount: (event.options ?? []).length,
            itemCount: (event.items ?? []).length,
          });
          return;
        }
        if (event.t === "error") {
          lastError = event.message.slice(0, 2_000);
          if (event.retryable === true) lastRetryableError = lastError;
          // A brain-level error used to be captured for the failure message and
          // otherwise vanish, so an FDE watching a run saw nothing go wrong
          // until the whole job ended.
          emitTelemetry(`harness.${input.operation}.brain_error`, {
            factoryRunId: runId,
            message: lastError,
            retryable: event.retryable === true,
          });
          return;
        }
        if (event.t === "message") {
          const text = event.text.trim();
          if (text) {
            lastMessage = text.slice(0, 8_000);
            // The brain's own narration. Only the final one used to survive,
            // as the job message; every intermediate explanation was dropped.
            // Counted only when the row was actually WRITTEN (the budget can
            // refuse it) — this number is the evidence behind the `think`
            // suppression reason, so an optimistic count would be the same
            // unchecked claim in a new place.
            if (
              emitTelemetry(`harness.${input.operation}.narration`, {
                factoryRunId: runId,
                text: lastMessage,
              })
            ) {
              narrationRowsRecorded += 1;
            }
          }
          return;
        }
        if (event.t === "acceptance") {
          // #C5 — the harness-owned acceptance checklist, emitted on every
          // finish attempt, used to be dropped at this boundary: the FDE could
          // not see WHICH criterion held a build back. It carries outcome, so
          // it rides queueProgress (a lost row aborts) rather than telemetry.
          queueProgress(`harness.${input.operation}.acceptance`, {
            factoryRunId: runId,
            allPass: event.allPass,
            // `criterionKey`, not `key`: the redaction boundary treats a bare
            // `key` property as credential-named and would blank the criterion
            // identifier the FDE needs to read.
            criteria: event.criteria
              .slice(0, MAX_ACCEPTANCE_CRITERIA)
              .map((criterion) => ({
                criterionKey: criterion.key.slice(
                  0,
                  MAX_ACCEPTANCE_LABEL_CHARS,
                ),
                label: criterion.label.slice(0, MAX_ACCEPTANCE_LABEL_CHARS),
                pass: criterion.pass,
                detail: criterion.detail.slice(0, MAX_ACCEPTANCE_DETAIL_CHARS),
              })),
            criteriaTotal: event.criteria.length,
            perAgent: event.perAgent
              .slice(0, MAX_ACCEPTANCE_AGENTS)
              .map((agent) => ({
                slug: agent.slug,
                short: agent.short,
                pass: agent.pass,
                items: agent.items
                  .slice(0, MAX_ACCEPTANCE_ITEMS_PER_AGENT)
                  .map((item) => ({
                    criterionKey: item.key.slice(0, MAX_ACCEPTANCE_LABEL_CHARS),
                    label: item.label.slice(0, MAX_ACCEPTANCE_LABEL_CHARS),
                    pass: item.pass,
                    detail: item.detail.slice(0, MAX_ACCEPTANCE_DETAIL_CHARS),
                  })),
                itemsTotal: agent.items.length,
              })),
            perAgentTotal: event.perAgent.length,
          });
          return;
        }
        // ── The self-correction loop ────────────────────────────────────────
        // "What was the brain thinking?" is mostly THIS: it critiqued its own
        // draft, changed it, watched the score move, and sometimes rolled back.
        // None of it had a route to the Session before.
        if (event.t === "refine") {
          emitTelemetry(`harness.${input.operation}.refine`, {
            factoryRunId: runId,
            actionName: event.actionName,
            critique: traceText(event.critique, 2_000),
            systemPromptChanged: event.diff?.systemPromptChanged ?? null,
            toolsAdded: (event.diff?.toolsAdded ?? []).slice(0, 20),
            toolsRemoved: (event.diff?.toolsRemoved ?? []).slice(0, 20),
            decisionLogicChanged: event.diff?.decisionLogicChanged ?? null,
          });
          return;
        }
        if (event.t === "score.delta") {
          emitTelemetry(`harness.${input.operation}.score_delta`, {
            factoryRunId: runId,
            actionName: event.actionName,
            priorTotal: event.priorTotal,
            newTotal: event.newTotal,
            delta: event.delta,
            regression: event.regression,
            dimensions: event.dimensions,
          });
          return;
        }
        if (event.t === "revert") {
          emitTelemetry(`harness.${input.operation}.revert`, {
            factoryRunId: runId,
            actionName: event.actionName,
            revertedToAttempt: event.revertedToAttempt,
          });
          return;
        }
        if (event.t === "inspect") {
          emitTelemetry(`harness.${input.operation}.inspect`, {
            factoryRunId: runId,
            runId: event.runId,
            agentSlug: event.agentSlug,
            status: event.status,
            degraded: event.degraded ?? null,
            error: traceText(event.error, 1_000),
          });
          return;
        }
        // ── What changed ────────────────────────────────────────────────────
        // The generated source itself is persisted through the draft/agent
        // path; carrying a second full copy in the trace would bury it. What
        // the trace owes the reader is that code WAS produced for this action,
        // how much, and a digest that ties this row to the stored source.
        if (event.t === "code") {
          const source = typeof event.code === "string" ? event.code : "";
          emitTelemetry(`harness.${input.operation}.code`, {
            factoryRunId: runId,
            actionName: event.actionName,
            codeSource: event.codeSource,
            chars: source.length,
            lines: source ? source.trimEnd().split("\n").length : 0,
            sha256: createHash("sha256").update(source, "utf8").digest("hex"),
          });
          return;
        }
        // ── Delegation ──────────────────────────────────────────────────────
        if (event.t === "subagent.start") {
          emitTelemetry(`harness.${input.operation}.subagent_start`, {
            factoryRunId: runId,
            task: traceText(event.task, 1_000),
            role: event.role ?? null,
            parentAgent: event.parentAgent ?? null,
            groupId: event.groupId ?? null,
          });
          return;
        }
        if (event.t === "subagent.done") {
          emitTelemetry(`harness.${input.operation}.subagent_done`, {
            factoryRunId: runId,
            task: traceText(event.task, 1_000),
            summary: traceText(event.summary, 2_000),
            parentAgent: event.parentAgent ?? null,
            groupId: event.groupId ?? null,
          });
          return;
        }
        if (event.t === "group.start") {
          emitTelemetry(`harness.${input.operation}.group_start`, {
            factoryRunId: runId,
            groupId: event.groupId,
            label: traceText(event.label, 300),
            members: event.members,
            mode: event.mode,
          });
          return;
        }
        if (event.t === "group.done") {
          emitTelemetry(`harness.${input.operation}.group_done`, {
            factoryRunId: runId,
            groupId: event.groupId,
            label: traceText(event.label, 300),
            ok: event.ok,
            total: event.total,
            summary: traceText(event.summary, 2_000),
          });
          return;
        }
        // ── Tests and the human boundary ────────────────────────────────────
        if (event.t === "test.decision") {
          emitTelemetry(`harness.${input.operation}.test_decision`, {
            factoryRunId: runId,
            decision: event.decision,
            interactionId: event.interactionId ?? null,
            note: traceText(event.note, 1_000),
          });
          return;
        }
        if (event.t === "boundary.cases") {
          emitTelemetry(`harness.${input.operation}.boundary_cases`, {
            factoryRunId: runId,
            awaitingDecision: event.awaitingDecision,
            interactionId: event.interactionId ?? null,
            proposalCount: event.proposals.length,
            proposals: event.proposals.slice(0, 40),
          });
          return;
        }
        if (event.t === "boundary.decided") {
          emitTelemetry(`harness.${input.operation}.boundary_decided`, {
            factoryRunId: runId,
            interactionId: event.interactionId ?? null,
            eventCount: event.events.length,
            events: event.events.slice(0, 40),
          });
          return;
        }
        // ── Why it stopped ──────────────────────────────────────────────────
        if (event.t === "budget") {
          emitTelemetry(`harness.${input.operation}.budget`, {
            factoryRunId: runId,
            turn: event.turn,
            maxTurns: event.maxTurns,
            tokens: event.tokens,
            conversationTokens: event.conversationTokens ?? null,
            maxTokens: event.maxTokens,
            specsBuilt: event.specsBuilt,
            sandboxRuns: event.sandboxRuns ?? null,
            level: event.level ?? null,
            costNote: traceText(event.costNote, 500),
            stopReason: event.stopReason ?? null,
          });
          return;
        }
        if (event.t === "compaction") {
          // Compaction is precisely where earlier context stops being readable.
          // The notice must survive even though the folded state does not: the
          // full snapshot is the brain's working memory, not a trace row.
          emitTelemetry(`harness.${input.operation}.compaction`, {
            factoryRunId: runId,
            summary: traceText(event.summary, 2_000),
            stateChars:
              typeof event.state === "string" ? event.state.length : 0,
          });
          return;
        }
        // ── Tool authoring and discovery ────────────────────────────────────
        if (event.t === "tool.created") {
          emitTelemetry(`harness.${input.operation}.tool_created`, {
            factoryRunId: runId,
            tool: event.name,
            description: traceText(event.description, 1_000),
            revisionId: event.revisionId ?? null,
            status: event.status,
            runtimeActive: event.runtimeActive,
          });
          return;
        }
        if (event.t === "tool.search") {
          emitTelemetry(`harness.${input.operation}.tool_search`, {
            factoryRunId: runId,
            query: traceText(event.query, 500),
            resultCount: event.results.length,
            results: event.results.slice(0, 20).map((result) => ({
              name: result.name,
              summary: traceText(result.summary, 300),
              sideEffect: result.sideEffect,
            })),
          });
          return;
        }
        if (event.t === "tool.schema") {
          emitTelemetry(`harness.${input.operation}.tool_schema`, {
            factoryRunId: runId,
            tool: event.name,
            method: event.method,
            url: traceText(event.url, 500),
            fields: event.fields,
          });
          return;
        }
        if (event.t === "skill.created") {
          emitTelemetry(`harness.${input.operation}.skill_created`, {
            factoryRunId: runId,
            name: event.name,
            purpose: traceText(event.purpose, 1_000),
          });
          return;
        }
        if (event.t === "web.result") {
          emitTelemetry(`harness.${input.operation}.web_result`, {
            factoryRunId: runId,
            query: traceText(event.query, 500),
            resultCount: event.results.length,
            results: event.results.slice(0, 10).map((result) => ({
              title: traceText(result.title, 300),
              url: traceText(result.url, 500),
              snippet: traceText(result.snippet, 500),
            })),
          });
          return;
        }
        // ── Ontology provenance ─────────────────────────────────────────────
        if (event.t === "source.scope") {
          emitTelemetry(`harness.${input.operation}.source_scope`, {
            factoryRunId: runId,
            domain: event.domain,
            mode: event.mode,
            actionIds: event.actionIds.slice(0, 100),
            actionNames: event.actionNames.slice(0, 100),
            actionCount: event.actionIds.length,
            sourceOntologyHash: event.sourceOntologyHash,
            scenario: traceText(event.scenario, 1_000),
          });
          return;
        }
        if (event.t === "virtual_action.created") {
          emitTelemetry(`harness.${input.operation}.virtual_action_created`, {
            factoryRunId: runId,
            actionId: event.actionId,
            name: event.name,
            trigger: event.trigger.slice(0, 40),
            emit: event.emit.slice(0, 40),
            scenario: traceText(event.scenario, 1_000),
          });
          return;
        }
        if (event.t === "ontology.revision") {
          emitTelemetry(`harness.${input.operation}.ontology_revision`, {
            factoryRunId: runId,
            proposalCount: event.proposals.length,
            proposals: event.proposals.slice(0, 40).map((proposal) => ({
              kind: proposal.kind,
              event: proposal.event,
              field: proposal.field,
              observedType: proposal.observedType,
              canonicalType: proposal.canonicalType ?? null,
              occurrences: proposal.occurrences,
              evidence: traceText(proposal.evidence, 500),
            })),
          });
          return;
        }
        if (event.t === "ontology.heal") {
          emitTelemetry(`harness.${input.operation}.ontology_heal`, {
            factoryRunId: runId,
            source: event.source,
            changeCount: event.changes.length,
            changes: event.changes.slice(0, 40).map((change) => ({
              code: change.code,
              detail: traceText(change.detail, 500),
            })),
            blockingBefore: event.blockingBefore ?? null,
            blockingAfter: event.blockingAfter ?? null,
          });
          return;
        }
        if (event.t === "flow.business") {
          const model = asRecord(event.model);
          const agentsModelled = Array.isArray(model?.agents)
            ? model.agents.length
            : 0;
          const platforms = Array.isArray(model?.platforms)
            ? model.platforms.length
            : 0;
          emitTelemetry(`harness.${input.operation}.flow_business`, {
            factoryRunId: runId,
            agents: agentsModelled,
            platforms,
          });
          return;
        }
        if (event.t === "assumption.applied") {
          // The brain filling a gap on its own is exactly the kind of decision
          // an FDE must be able to find afterwards.
          emitTelemetry(`harness.${input.operation}.assumption_applied`, {
            factoryRunId: runId,
            summary: traceText(event.summary, 1_000),
            assumption: event.assumption,
          });
          return;
        }
        if (event.t === "user.message") {
          emitTelemetry(`harness.${input.operation}.user_message`, {
            factoryRunId: runId,
            text: traceText(event.text, 4_000),
          });
          return;
        }
        if (event.t !== "done") {
          // Not recognised by name — a wiring gap, not a decision. It is
          // counted and announced; it is never dropped in silence.
          recordUnbridgedFrame(
            typeof (event as { t?: unknown }).t === "string"
              ? (event as { t: string }).t
              : "unknown",
          );
          return;
        }
        reportFrameAccounting();

        void progressTail
          // A dropped telemetry row is reported, never swallowed. Otherwise a
          // partial trace reads as a complete one — the same lie as a silent
          // cap. `telemetryWritesLost` is incremented in the write tail's
          // `.catch`, so reading it in this frame's own tick reads it BEFORE
          // the rows queued moments ago have settled: exactly the losses at the
          // end of a run — the ones most likely caused by whatever ended it —
          // were the ones that could never be reported. Drain first, then count.
          .then(() => {
            if (telemetryWritesLost > 0) {
              queueProgress(
                `harness.${input.operation}.telemetry_incomplete`,
                {
                  factoryRunId: runId,
                  lost: telemetryWritesLost,
                  note: "部分推理/工具明细写入失败，本次轨迹不完整；作业结论与产物不受影响。",
                },
                "user",
              );
            }
            // `queueProgress` extends the tail; await the extension so the
            // notice is durable before the verdict below is computed.
            return progressTail;
          })
          .then(async () => {
            const capturedAgents = [...agents.values()];
            const isDelivery =
              event.status === "finished" &&
              event.completionKind === "delivery";
            const durableAgents =
              isDelivery || draftCheckpoint
                ? await (runtime.loadDurableAgents ?? loadDurableFactoryAgents)(
                    input,
                    runId,
                    capturedAgents,
                    draftCheckpoint,
                    isDelivery,
                  )
                : [];
            if (isDelivery && durableAgents.length === 0) {
              throw new OntoCodeHarnessExecutionError(
                "factory_delivery_empty",
                "Agent Factory reported delivery without a durable generated Agent",
                {
                  recoverable: true,
                  retryable: false,
                  details: { factoryRunId: runId },
                },
              );
            }
            const durableSlugs = new Set(
              durableAgents.flatMap((rawAgent) => {
                const agent = asRecord(rawAgent);
                const spec = asRecord(agent?.spec);
                const card = asRecord(agent?.card);
                const slug =
                  nonEmptyString(spec?.slug) ??
                  nonEmptyString(card?.slug) ??
                  nonEmptyString(agent?.slug);
                return slug ? [slug] : [];
              }),
            );
            const agentPreviews = capturedAgents.filter(
              (agent) => !durableSlugs.has(agent.slug),
            );
            // OntoCode owns the user-visible Build lifecycle. A durable human
            // interaction is therefore a waiting Build even if an older
            // generation kernel reports `turns_exhausted` after opening the
            // gate on its last admitted turn. Keep the internal verdict only
            // as audit metadata; never turn an exact pending interaction into
            // a user-visible Build failure.
            const projectsWaitingUser = pendingClarification !== null;
            const receipt: Record<string, unknown> = {
              ...(input.buildExecutionId
                ? { buildExecutionId: input.buildExecutionId }
                : {}),
              factoryRunId: runId,
              status:
                event.status === "waiting_human" || projectsWaitingUser
                  ? "waiting_human"
                  : event.status,
              completionKind: event.completionKind,
              ...(projectsWaitingUser && event.status !== "waiting_human"
                ? { internalEngineStatus: event.status }
                : {}),
              actionIds: [...input.directive.requestedActionIds],
              actionNames: [...input.directive.requestedActionNames],
              // `agents` is the Candidate-bearing field. Never populate it
              // from transient agent.created frames.
              agents: durableAgents,
              ...(agentPreviews.length > 0
                ? {
                    agentPreviews,
                    candidateEligibility: "non_candidate_preview",
                  }
                : {}),
              sandbox,
              readiness,
              draftCheckpoint,
              ...(pendingClarification
                ? { interaction: pendingClarification.interaction }
                : {}),
              usage: {
                tokensUsed: event.tokensUsed,
                conversationTokensUsed:
                  event.conversationTokensUsed ?? event.tokensUsed,
                turns: event.turns,
              },
            };
            if (event.status === "waiting_human" || projectsWaitingUser) {
              const draftMessage = draftCheckpoint
                ? factoryDraftWaitingMessage(draftCheckpoint)
                : null;
              succeed({
                outcome: "waiting_user",
                message:
                  draftMessage && pendingClarification
                    ? `${draftMessage}\n\n${pendingClarification.message}`
                    : (draftMessage ??
                      pendingClarification?.message ??
                      "OntoCode 需要你的决定或配置后才能继续本次构建"),
                receipt: {
                  ...receipt,
                  ...(draftCheckpoint
                    ? {
                        verificationState: "generated_unverified",
                      }
                    : {}),
                },
              });
              return;
            }
            if (
              event.status === "finished" &&
              event.completionKind === "delivery"
            ) {
              succeed({ outcome: "succeeded", receipt });
              return;
            }
            if (draftCheckpoint && capturedAgents.length > 0) {
              const message = factoryDraftWaitingMessage(draftCheckpoint);
              succeed({
                outcome: "waiting_user",
                message: pendingClarification
                  ? `${message}\n\n${pendingClarification.message}`
                  : message,
                receipt: {
                  ...receipt,
                  status: "drafted_unverified",
                  completionKind: "incomplete",
                  verificationState: "generated_unverified",
                  interaction: pendingClarification?.interaction ?? {
                    kind: "execution_readiness",
                    awaitingAnswer: true,
                    question: message,
                    options: [
                      {
                        label: "先保留代码草稿",
                        value: "keep_generated_unverified_draft",
                        recommended: true,
                      },
                      {
                        label: "配置后重新验证",
                        value: "configure_and_retry_verification",
                      },
                    ],
                  },
                },
              });
              return;
            }
            if (
              event.completionKind === "answer" &&
              durableAgents.length === 0
            ) {
              // Legacy Factory paths occasionally ask the FDE in a final
              // narration message instead of emitting structured `clarify`.
              // A Build answer is never a code delivery. Preserve the text as
              // an informational waiting receipt so Chat can collect a real
              // answer and resume, without misreporting success or collapsing
              // the question into a generic recoverable error.
              succeed({
                outcome: "waiting_user",
                message:
                  lastMessage ??
                  "OntoCode 返回了说明而不是可交付代码；请补充所需决定后继续构建。",
                receipt: {
                  ...receipt,
                  status: "waiting_human",
                  interaction: {
                    kind: "legacy_answer",
                    awaitingAnswer: true,
                    question:
                      lastMessage ??
                      "Review the OntoCode guidance and provide the missing decision.",
                  },
                },
              });
              return;
            }
            fail(
              new OntoCodeHarnessExecutionError(
                "factory_build_incomplete",
                lastRetryableError ||
                  lastError ||
                  `Agent Factory ended with ${event.status}/${event.completionKind}`,
                {
                  recoverable: true,
                  retryable: lastRetryableError !== null,
                  details: {
                    factoryRunId: runId,
                    status: event.status,
                    completionKind: event.completionKind,
                  },
                },
              ),
            );
          })
          .catch(fail);
      },
      input.tenantId,
    );
    if (!subscription) {
      fail(
        new OntoCodeHarnessExecutionError(
          "factory_run_subscription_failed",
          "The Agent Factory run started but could not be attached",
          { recoverable: true, retryable: true },
        ),
      );
      return;
    }
    unsubscribe = subscription;
  });
}

export function createDefaultOntoCodeFactoryAdapter(): OntoCodeFactoryHarnessAdapter {
  return {
    async fetchOntology(input) {
      return makeFactoryPorts(
        input.tenantSlug,
        input.tenantId,
        input.domain,
        undefined,
        input.ontologyDomainRegistrationId,
      ).ontology.fetchOntology(input.domain);
    },
    recommendScope(input) {
      return recommendFactoryActionScope(input);
    },
    runBuild: runFactoryBuild,
    runCandidateTest(input) {
      return makeFactoryPorts(
        input.tenantSlug,
        input.tenantId,
        input.domain,
        undefined,
        input.ontologyDomainRegistrationId,
        input.runtimeProfileVersionId,
      ).sandbox.deployAndObserve(input.domain, input.specs, {
        candidateFingerprint: input.dependencyRoot,
        testCases: input.testCases,
        signal: input.signal,
      });
    },
    fetchActionRules(input) {
      return makeFactoryPorts(
        input.tenantSlug,
        input.tenantId,
        input.domain,
        undefined,
        input.ontologyDomainRegistrationId,
      ).ontology.fetchActionRules(input.domain, input.actionName);
    },
    listInstances(input) {
      const ontology = makeFactoryPorts(
        input.tenantSlug,
        input.tenantId,
        input.domain,
        undefined,
        input.ontologyDomainRegistrationId,
      ).ontology;
      if (!ontology.listInstances) {
        throw new Error(
          `Ontology source for ${input.domain} does not support instance reads`,
        );
      }
      return ontology.listInstances(input.domain, input.objectType, {
        limit: input.limit,
      });
    },
    // #TOOL-REQ — exactly the surfaces Build reads, read at analysis time.
    // A port that is absent (older tenant scope) yields an empty list for that
    // surface; the Analyst reports the catalogue size so a thin read is visible
    // as a thin read rather than as "nothing is missing".
    async listExecutionResources(input) {
      const ports = makeFactoryPorts(
        input.tenantSlug,
        input.tenantId,
        input.domain,
        undefined,
        input.ontologyDomainRegistrationId,
      );
      const [
        registryTools,
        declarativeRows,
        capabilityProviders,
        systemAliasGroups,
      ] = await Promise.all([
        ports.toolRegistry ? ports.toolRegistry.list() : Promise.resolve([]),
        ports.tools ? ports.tools.list(input.domain) : Promise.resolve([]),
        ports.integrationCapabilities
          ? ports.integrationCapabilities.list()
          : Promise.resolve([]),
        ports.systemAliases ? ports.systemAliases.list() : Promise.resolve([]),
      ]);
      // #C4 — mirror the Build-side three-tier merge (`currentExecutionResources`
      // in packages/agent-factory/src/tools.ts): global + tenant-native come
      // pre-merged from toolRegistry.list() (alias shadowing applied there);
      // the persisted declarative tier overlays the names the registry does
      // NOT already own. Build keeps the registry tool on a name collision, so
      // packaging and the planner must see the same winner — otherwise an
      // FDE-authored tool binds in Build but snapshots as status:"unknown"
      // (hardBlocker candidate_tool_unknown) and the candidate can never get a
      // Head.
      const registryNames = new Set(registryTools.map((tool) => tool.name));
      const tools = [
        ...registryTools,
        ...declarativeRows
          .filter((tool) => !registryNames.has(tool.name))
          .map((tool) => persistedToolAsRealTool(tool)),
      ];
      return { tools, capabilityProviders, systemAliasGroups };
    },
  };
}

function readExactCandidateArtifact(
  context: OntoCodeHarnessExecutionContext,
  ref: OntoCodePackageVersion["artifactRefs"][number],
): string {
  const version = getDb()
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      and(
        eq(ontocodeArtifactVersions.tenantId, context.job.tenantId),
        eq(ontocodeArtifactVersions.sessionId, context.job.sessionId),
        eq(ontocodeArtifactVersions.id, ref.artifactVersionId),
        eq(ontocodeArtifactVersions.artifactId, ref.artifactId),
        eq(ontocodeArtifactVersions.blobHash, ref.blobHash),
      ),
    )
    .get();
  if (!version) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_artifact_version_mismatch",
      `Candidate artifact ${ref.logicalName} no longer resolves to its immutable version`,
      {
        recoverable: false,
        retryable: false,
        details: {
          artifactId: ref.artifactId,
          artifactVersionId: ref.artifactVersionId,
          blobHash: ref.blobHash,
        },
      },
    );
  }
  const blob = getDb()
    .select()
    .from(ontocodeArtifactBlobs)
    .where(
      and(
        eq(ontocodeArtifactBlobs.tenantId, context.job.tenantId),
        eq(ontocodeArtifactBlobs.id, version.blobId),
        eq(ontocodeArtifactBlobs.sha256, ref.blobHash),
      ),
    )
    .get();
  if (!blob || sha256Text(blob.contentText) !== ref.blobHash) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_artifact_blob_mismatch",
      `Candidate artifact ${ref.logicalName} failed its content-addressed readback`,
      {
        recoverable: false,
        retryable: false,
        details: {
          artifactVersionId: ref.artifactVersionId,
          expectedBlobHash: ref.blobHash,
        },
      },
    );
  }
  return blob.contentText;
}

function exactCandidateSpecs(context: OntoCodeHarnessExecutionContext): {
  packageVersion: OntoCodePackageVersion;
  specs: GeneratedAgentSpec[];
} {
  const packageVersionId = context.job.candidatePackageVersionId;
  const dependencyRoot = context.job.candidateDependencyRoot;
  if (!packageVersionId || !dependencyRoot) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_target_missing",
      "Candidate verification requires an immutable Package Version and dependency root",
      { recoverable: true, retryable: false },
    );
  }
  const row = getDb()
    .select()
    .from(ontocodePackageVersions)
    .where(
      and(
        eq(ontocodePackageVersions.tenantId, context.job.tenantId),
        eq(ontocodePackageVersions.sessionId, context.job.sessionId),
        eq(ontocodePackageVersions.id, packageVersionId),
      ),
    )
    .get();
  if (!row || row.dependencyRoot !== dependencyRoot) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_digest_mismatch",
      "The exact Candidate Package cannot be read with its pinned dependency root",
      { recoverable: false, retryable: false },
    );
  }
  let artifactRefs: OntoCodePackageVersion["artifactRefs"];
  let executionOwners: OntoCodePackageVersion["executionOwners"];
  let validation: OntoCodePackageVersion["validation"];
  try {
    artifactRefs = JSON.parse(
      row.artifactRefsJson,
    ) as OntoCodePackageVersion["artifactRefs"];
    executionOwners = JSON.parse(
      row.executionOwnersJson,
    ) as OntoCodePackageVersion["executionOwners"];
    validation = JSON.parse(
      row.validationJson,
    ) as OntoCodePackageVersion["validation"];
  } catch {
    throw new OntoCodeHarnessExecutionError(
      "candidate_package_corrupt",
      "The exact Candidate Package contains invalid persisted JSON",
      { recoverable: false, retryable: false },
    );
  }
  const packageVersion: OntoCodePackageVersion = {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    parentVersionId: row.parentVersionId ?? null,
    sourceHarnessJobId: row.sourceHarnessJobId ?? null,
    ontologyHash: row.ontologyHash,
    dependencyRoot: row.dependencyRoot,
    artifactRefs,
    executionOwners,
    status: row.status,
    validation,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
  };
  const recomputed = computeOntoCodeCandidateDependencyRoot({
    ontologyHash: packageVersion.ontologyHash,
    environmentProfileVersionId:
      context.session.environmentProfileVersionId ?? null,
    artifactRefs,
    executionOwners,
  });
  if (recomputed !== dependencyRoot) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_dependency_root_invalid",
      "The Candidate dependency root no longer matches its immutable Artifact set",
      {
        recoverable: false,
        retryable: false,
        details: { expected: dependencyRoot, recomputed },
      },
    );
  }

  const contentByLogicalName = new Map(
    artifactRefs.map((ref) => [
      ref.logicalName,
      { ref, content: readExactCandidateArtifact(context, ref) },
    ]),
  );
  const manifestEntry = artifactRefs.find(
    (ref) => ref.kind === "agent_manifest",
  );
  if (!manifestEntry) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_manifest_missing",
      "The Candidate Package has no immutable manifest",
      { recoverable: false, retryable: false },
    );
  }
  const manifest = asRecord(
    JSON.parse(contentByLogicalName.get(manifestEntry.logicalName)!.content),
  );
  const manifestAgents = Array.isArray(manifest?.agents)
    ? manifest.agents.flatMap((value) => {
        const agent = asRecord(value);
        return agent ? [agent] : [];
      })
    : [];
  const specs: GeneratedAgentSpec[] = [];
  for (const specRef of artifactRefs.filter(
    (ref) => ref.kind === "agent_spec",
  )) {
    const record = contentByLogicalName.get(specRef.logicalName)!;
    const raw = asRecord(JSON.parse(record.content));
    const slug = nonEmptyString(raw?.slug);
    if (!raw || !slug) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_spec_invalid",
        `Candidate Spec ${specRef.logicalName} has no stable slug`,
        { recoverable: false, retryable: false },
      );
    }
    const codeLogicalName = specRef.logicalName.replace(
      /\/spec\.json$/u,
      "/agent.ts",
    );
    const code = contentByLogicalName.get(codeLogicalName);
    if (!code || code.ref.kind !== "agent_code") {
      throw new OntoCodeHarnessExecutionError(
        "candidate_code_missing",
        `Candidate Agent ${slug} has no exact Code Artifact`,
        { recoverable: false, retryable: false },
      );
    }
    const owner = executionOwners[slug];
    if (!owner) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_execution_owner_missing",
        `Candidate Agent ${slug} has no Execution Owner`,
        { recoverable: false, retryable: false },
      );
    }
    if (
      (owner === "codeact" && raw.codeExecuted !== true) ||
      (owner === "declarative_manifest" && raw.codeExecuted === true)
    ) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_execution_owner_mismatch",
        `Candidate Agent ${slug} changed execution semantics after packaging`,
        { recoverable: false, retryable: false },
      );
    }
    const manifestAgent = manifestAgents.find(
      (agent) => nonEmptyString(agent.slug) === slug,
    );
    const manifestSpec = asRecord(manifestAgent?.spec);
    const manifestCode = asRecord(manifestAgent?.code);
    if (
      !manifestAgent ||
      manifestAgent.executionOwner !== owner ||
      manifestSpec?.artifactVersionId !== specRef.artifactVersionId ||
      manifestSpec?.blobHash !== specRef.blobHash ||
      manifestCode?.artifactVersionId !== code.ref.artifactVersionId ||
      manifestCode?.blobHash !== code.ref.blobHash
    ) {
      throw new OntoCodeHarnessExecutionError(
        "candidate_manifest_mismatch",
        `Candidate manifest does not bind the exact Spec and Code for ${slug}`,
        { recoverable: false, retryable: false },
      );
    }
    specs.push({
      ...(raw as unknown as GeneratedAgentSpec),
      generatedCode: code.content,
    });
  }
  if (
    specs.length === 0 ||
    specs.length !== Object.keys(executionOwners).length ||
    manifestAgents.length !== specs.length
  ) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_agent_set_incomplete",
      "Candidate Spec, Manifest and Execution Owner counts do not agree",
      {
        recoverable: false,
        retryable: false,
        details: {
          specs: specs.length,
          manifestAgents: manifestAgents.length,
          executionOwners: Object.keys(executionOwners).length,
        },
      },
    );
  }
  return { packageVersion, specs };
}

function exactCandidateTestBlueprints(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology,
): Array<Record<string, unknown>> {
  return specs.flatMap((spec) => {
    const action = ontology.actions.find(
      (candidate) => candidate.name === spec.actionName,
    );
    const specTriggers = stringList(spec.trigger);
    const specEmits = stringList(spec.emit);
    const entryEvents =
      specTriggers.length > 0 ? specTriggers : (action?.trigger ?? []);
    const expectedEvents =
      specEmits.length > 0 ? specEmits : (action?.triggered_event ?? []);
    return entryEvents.map((entryEvent) => {
      const event = ontology.events.find(
        (candidate) => candidate.name === entryEvent,
      );
      return {
        id: `${spec.slug}:${entryEvent}`,
        agentSlug: spec.slug,
        actionName: spec.actionName,
        entryEvent,
        expectedEvents,
        requiredPayloadFields:
          event?.payload.event_data
            .filter((field) => field.required !== false)
            .map((field) => ({
              name: field.name,
              type: field.type,
              targetObject: field.target_object,
            })) ?? [],
        suggestedKinds: ["pass", "reject", "timeout"],
        ontologyRefs: [
          `action:${spec.actionName}`,
          `event:${entryEvent}`,
          ...expectedEvents.map((name) => `event:${name}`),
        ],
      };
    });
  });
}

/**
 * Author a secret-free, exact-Candidate test plan without executing code.
 * `generate_tests` used to share the Sandbox executor with `run_tests`, making
 * a draft_change command create a real SandboxAttempt. The immutable Candidate
 * is still read back and verified here, but execution remains a separate,
 * explicitly sandbox_effect command.
 */
async function executeCandidateTestAuthoring(
  factory: OntoCodeFactoryHarnessAdapter,
  context: OntoCodeHarnessExecutionContext,
): Promise<OntoCodeHarnessExecutorResult> {
  const { packageVersion, specs } = exactCandidateSpecs(context);
  const ontology = await factory.fetchOntology({
    tenantId: context.job.tenantId,
    tenantSlug: context.tenantSlug,
    domain: context.project.domain,
    ontologyDomainRegistrationId: context.project.ontologyDomainRegistrationId,
  });
  const ontologyHash = requireCurrentOntology(context, ontology, {
    requireSnapshot: true,
  });
  if (ontologyHash !== packageVersion.ontologyHash) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_ontology_mismatch",
      "The Candidate Package does not target the current authoritative Ontology snapshot",
      { recoverable: true, retryable: false },
    );
  }

  const blueprints = exactCandidateTestBlueprints(specs, ontology);
  const hasExecutableCases = context.job.testCases.length > 0;
  const receipt: Record<string, unknown> = {
    schema: "ontocode-candidate-test-authoring-receipt/v1",
    operation: "generate_tests",
    ontologyHash,
    candidatePackageVersionId: packageVersion.id,
    candidateDependencyRoot: packageVersion.dependencyRoot,
    candidateHeadId: context.job.candidateHeadId,
    candidateHeadRevision: context.job.candidateHeadRevision,
    blueprints,
    sandboxExecuted: false,
    executableTestCaseCount: context.job.testCases.length,
    ...(hasExecutableCases
      ? {
          testSuiteHash: computeOntoCodeTestSuiteHash(context.job.testCases),
          readyForRun: true,
        }
      : {
          readyForRun: false,
          requiredConfiguration: ["testCases"],
        }),
  };
  if (!hasExecutableCases) {
    return {
      outcome: "waiting_user",
      phase: "verify",
      message:
        "已根据精确 Candidate 与 Ontology 生成测试蓝图；请由 FDE 补充真实 payload 后再运行 Sandbox，系统不会伪造业务数据。",
      receipt,
    };
  }
  return {
    outcome: "succeeded",
    phase: "verify",
    message:
      "已生成并绑定精确 Candidate 的测试蓝图与测试集哈希；本步骤未运行 Sandbox。",
    receipt,
  };
}

async function executeExactCandidateTest(
  factory: OntoCodeFactoryHarnessAdapter,
  context: OntoCodeHarnessExecutionContext,
  kind: "test" | "regression",
): Promise<OntoCodeHarnessExecutorResult> {
  if (!factory.runCandidateTest) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_test_executor_unavailable",
      "The Harness has no exact Candidate Sandbox executor",
      { recoverable: true, retryable: false },
    );
  }
  const { packageVersion, specs } = exactCandidateSpecs(context);
  const validation = OntoCodeCandidateValidationV2Schema.safeParse(
    packageVersion.validation,
  );
  if (
    validation.success &&
    (validation.data.runtimeBlockers.length > 0 ||
      validation.data.verificationBlockers.length > 0)
  ) {
    const blockers = [
      ...validation.data.runtimeBlockers,
      ...validation.data.verificationBlockers,
    ];
    return {
      outcome: "waiting_user",
      phase: "verify",
      message:
        `Candidate Package 已保存，但还有 ${blockers.length} 项运行/验证前置条件。` +
        "请先完成对应 Integration Profile、凭证引用或 Tool Probe，然后重新 Build 以生成新的精确 Candidate。",
      receipt: {
        schema: "ontocode-candidate-verification-blocked/v1",
        operation: kind,
        candidatePackageVersionId: packageVersion.id,
        candidateDependencyRoot: packageVersion.dependencyRoot,
        runtimeReady: validation.data.runtimeReady,
        verificationPrerequisitesReady:
          validation.data.verificationPrerequisitesReady,
        runtimeBlockers: validation.data.runtimeBlockers,
        verificationBlockers: validation.data.verificationBlockers,
        next: "resolve_blockers_and_rebuild",
      },
    };
  }
  const ontology = await factory.fetchOntology({
    tenantId: context.job.tenantId,
    tenantSlug: context.tenantSlug,
    domain: context.project.domain,
    ontologyDomainRegistrationId: context.project.ontologyDomainRegistrationId,
  });
  const ontologyHash = requireCurrentOntology(context, ontology, {
    requireSnapshot: true,
  });
  if (ontologyHash !== packageVersion.ontologyHash) {
    throw new OntoCodeHarnessExecutionError(
      "candidate_ontology_mismatch",
      "The Candidate Package does not target the current authoritative Ontology snapshot",
      { recoverable: true, retryable: false },
    );
  }
  if (context.job.testCases.length === 0) {
    return {
      outcome: "waiting_user",
      phase: "verify",
      message:
        "请先提供并确认至少一个真实 Candidate Test Case（entryEvent、payload、kind），Harness 不会伪造空输入。",
      receipt: {
        schema: "ontocode-candidate-test-input-request/v1",
        operation: kind,
        ontologyHash,
        candidatePackageVersionId: packageVersion.id,
        candidateDependencyRoot: packageVersion.dependencyRoot,
        requiredConfiguration: ["testCases"],
      },
    };
  }
  const testSuiteHash = computeOntoCodeTestSuiteHash(context.job.testCases);
  const attempt = createOntoCodeSandboxAttempt(
    {
      tenantId: context.job.tenantId,
      actorId: context.job.createdBy,
    },
    {
      projectId: context.project.id,
      sessionId: context.session.id,
      harnessJobId: context.job.id,
      ordinal: context.attempt,
      packageVersionId: packageVersion.id,
      dependencyRoot: packageVersion.dependencyRoot,
      ontologyHash,
      testSuiteHash,
      environmentProfileVersionId:
        context.session.environmentProfileVersionId ?? null,
    },
  );
  await context.progress(`harness.${kind}.sandbox_attempt_started`, {
    sandboxAttemptId: attempt.id,
    candidatePackageVersionId: packageVersion.id,
    candidateDependencyRoot: packageVersion.dependencyRoot,
    testSuiteHash,
    testCaseCount: context.job.testCases.length,
  });
  try {
    const sandbox = await factory.runCandidateTest({
      tenantId: context.job.tenantId,
      tenantSlug: context.tenantSlug,
      domain: context.project.domain,
      ontologyDomainRegistrationId:
        context.project.ontologyDomainRegistrationId,
      runtimeProfileVersionId: context.job.runtimeProfileVersionId ?? null,
      packageVersionId: packageVersion.id,
      dependencyRoot: packageVersion.dependencyRoot,
      specs,
      testCases: context.job.testCases,
      signal: context.signal,
    });
    if (
      sandbox.candidateFingerprint !== packageVersion.dependencyRoot ||
      sandbox.targetDomainId !== context.project.domain
    ) {
      throw new OntoCodeHarnessExecutionError(
        "sandbox_candidate_receipt_mismatch",
        "Sandbox returned evidence for a different Candidate or Ontology Domain",
        { recoverable: false, retryable: false },
      );
    }
    const completed = completeOntoCodeSandboxAttempt(
      { tenantId: context.job.tenantId },
      attempt.id,
      sandbox,
    );
    return {
      outcome: "succeeded",
      phase: "verify",
      message:
        completed.qualification === "promotable"
          ? "精确 Candidate 已在合格远程 Sandbox 中完成验证。"
          : "精确 Candidate 已完成 Sandbox 诊断；当前隔离或回执不具备晋级资格。",
      receipt: {
        schema: `ontocode-exact-candidate-${kind}-receipt/v1`,
        operation: kind,
        ontologyHash,
        candidatePackageVersionId: packageVersion.id,
        candidateDependencyRoot: packageVersion.dependencyRoot,
        candidateHeadId: context.job.candidateHeadId,
        candidateHeadRevision: context.job.candidateHeadRevision,
        testSuiteHash,
        ontocodeSandboxAttemptId: completed.id,
        sandboxQualification: completed.qualification,
        sandbox,
      },
    };
  } catch (error) {
    const block =
      error instanceof SandboxLifecycleBlockedError ? error.block : null;
    const status =
      block?.code === "sandbox_cleanup_failed"
        ? "cleanup_failed"
        : block
          ? "blocked"
          : "failed";
    failOntoCodeSandboxAttempt({ tenantId: context.job.tenantId }, attempt.id, {
      status,
      code:
        block?.code ??
        (error instanceof OntoCodeHarnessExecutionError
          ? error.code
          : "sandbox_execution_failed"),
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof OntoCodeHarnessExecutionError) throw error;
    throw new OntoCodeHarnessExecutionError(
      block?.code ?? "sandbox_execution_failed",
      error instanceof Error ? error.message : String(error),
      {
        recoverable: true,
        retryable: false,
        ...(block ? { details: { missing: block.missing } } : {}),
      },
    );
  }
}

async function executeFactoryIteration(
  factory: OntoCodeFactoryHarnessAdapter,
  context: OntoCodeHarnessExecutionContext,
  kind: "test" | "debug" | "regression",
): Promise<OntoCodeHarnessExecutorResult> {
  const ontology = await factory.fetchOntology({
    tenantId: context.job.tenantId,
    tenantSlug: context.tenantSlug,
    domain: context.project.domain,
    ontologyDomainRegistrationId: context.project.ontologyDomainRegistrationId,
  });
  const ontologyHash = requireCurrentOntology(context, ontology, {
    requireSnapshot: true,
  });
  const scope = await resolveGenerationScope(context);
  const directive = createFactoryGenerationDirective({
    ontology,
    actionIds: scope.actionIds,
    scenario: scope.scenario,
    forceVirtual: scope.forceVirtual,
  });
  const priorBuild = await context.latestReceipt("harness.build.completed");
  if ((kind === "test" || kind === "regression") && !priorBuild) {
    throw new OntoCodeHarnessExecutionError(
      `${kind}_build_receipt_required`,
      `${kind} requires a completed, snapshot-bound build receipt`,
      {
        recoverable: true,
        retryable: false,
        details: {
          nextStep: "Run a build job before requesting this Harness operation",
        },
      },
    );
  }

  // #FAILURE-RECEIPT — 「为什么失败」是 FDE 来问我们的问题，不该反过来要 FDE 手写一段
  // 失败摘要。命令参数里有就用命令参数；没有就先去读平台【自己已经写下】的失败回执，把
  // 终态错误、带字节偏移的失败帧、失败前的持久事件原样接地进来。真的什么都读不到时，依然
  // 如实拒绝——但要说清查过哪里，而不是笼统地把球踢回去。
  const suppliedFailureSummary =
    nonEmptyString(context.command?.arguments.failureSummary) ??
    nonEmptyString(context.command?.arguments.error);
  const durableFailureReceipt =
    kind === "debug" && !suppliedFailureSummary
      ? await context.latestFailureReceipt()
      : null;
  const groundedFailureSummary = durableFailureReceipt
    ? renderFailureReceiptGrounding(durableFailureReceipt)
    : null;
  const failureSummary = suppliedFailureSummary ?? groundedFailureSummary;
  const failureSummarySource = suppliedFailureSummary
    ? "command_arguments"
    : groundedFailureSummary
      ? "durable_failure_receipt"
      : null;
  if (kind === "debug" && !failureSummary) {
    return {
      outcome: "waiting_user",
      phase: "debug",
      message:
        "本 Session 里没有任何可读的持久失败证据（既没有 Harness 失败回执，命令参数里也没有 failureSummary），无法凭空定位失败。请先跑一次会产生失败回执的作业，或直接给出失败摘要。",
      receipt: {
        schema: "ontocode-debug-input-request/v1",
        ontologyHash,
        requiredConfiguration: ["failureSummary"],
        // 拒绝前真的查过什么——这是「诚实拒绝」和「懒得查」的区别。
        searchedEvidence: [
          `durable failure receipts in this Session (${ONTOCODE_FAILURE_RECEIPT_SCHEMA})`,
          "command arguments failureSummary/error",
        ],
        acceptedEvidence: [
          "Harness failure receipt",
          "Harness test receipt",
          "Factory sandbox receipt",
          "run or step error summary",
        ],
      },
    };
  }

  const operationGoal =
    kind === "test"
      ? "对当前候选 Agent 运行并补全沙箱测试；不要部署到生产。只根据真实测试与执行证据给出结论。"
      : kind === "regression"
        ? "对当前候选 Agent 运行沙箱回归；复核 Ontology 事件、工具和端到端链路，不得部署到生产。"
        : `分析并修复当前候选 Agent 的失败，然后在沙箱重新验证；不得部署到生产。失败摘要：${failureSummary}`;
  const failureGrounding = failureSummarySource
    ? {
        source: failureSummarySource,
        ...(durableFailureReceipt &&
        failureSummarySource === "durable_failure_receipt"
          ? {
              sourceJobId: nonEmptyString(durableFailureReceipt.jobId),
              sourceOperation: nonEmptyString(durableFailureReceipt.operation),
              errorCode: nonEmptyString(
                asRecord(durableFailureReceipt.error)?.code,
              ),
              evidenceStatus: nonEmptyString(
                asRecord(durableFailureReceipt.evidence)?.status,
              ),
              factoryRunId: nonEmptyString(
                asRecord(durableFailureReceipt.evidence)?.runId,
              ),
            }
          : {}),
      }
    : null;
  await context.progress(`harness.${kind}.factory_started`, {
    ontologyHash,
    sourceFactoryRunId: nonEmptyString(priorBuild?.factoryRunId),
    actionIds: [...directive.requestedActionIds],
    actionNames: [...directive.requestedActionNames],
    ...(failureGrounding ? { failureGrounding } : {}),
  });
  const result = await factory.runBuild({
    jobId: context.job.id,
    attempt: context.attempt,
    operation: kind,
    tenantId: context.job.tenantId,
    tenantSlug: context.tenantSlug,
    domain: context.project.domain,
    ontologyDomainRegistrationId: context.project.ontologyDomainRegistrationId,
    runtimeProfileVersionId: context.job.runtimeProfileVersionId ?? null,
    goal: `${factoryGenerationGoal(directive, context.session.goal)}\n\n[OntoCode ${kind} iteration]\n${operationGoal}`,
    actorId: context.job.createdBy,
    interactionPolicy:
      context.session.autonomyMode === "sandbox_autopilot"
        ? "autopilot"
        : "strict",
    directive,
    budget: context.job.budget,
    signal: context.signal,
    onProgress: (type, payload, visibility) =>
      context.progress(type, payload, visibility),
  });
  return {
    outcome: result.outcome,
    phase:
      result.outcome === "succeeded"
        ? "verify"
        : kind === "debug"
          ? "debug"
          : "verify",
    message: result.message,
    receipt: {
      schema: `ontocode-${kind}-receipt/v1`,
      operation: kind,
      ontologyHash,
      sourceFactoryRunId: nonEmptyString(priorBuild?.factoryRunId),
      // 这次调试的失败摘要是从哪来的——FDE 手写的，还是平台自己的失败回执。
      ...(failureGrounding ? { failureGrounding } : {}),
      scope: {
        actionIds: [...directive.requestedActionIds],
        actionNames: [...directive.requestedActionNames],
        scenario: directive.scenario ?? scope.scenario,
        forceVirtual: directive.mode === "virtual_scenario",
        source: scope.source,
      },
      ...result.receipt,
    },
  };
}

type OntoCodeFactoryBuildResume = NonNullable<
  OntoCodeFactoryBuildInput["resume"]
>;

function factoryResumeRefusal(
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new OntoCodeHarnessExecutionError(code, message, {
    recoverable: true,
    retryable: false,
    details,
  });
}

function capturedFactoryAgent(value: unknown): CapturedFactoryAgent | null {
  const agent = asRecord(value);
  if (!agent) return null;
  const spec = asRecord(agent.spec) ?? asRecord(agent.card) ?? agent;
  const card = asRecord(agent.card) ?? spec;
  const design = asRecord(agent.design);
  const slug =
    nonEmptyString(spec.slug) ??
    nonEmptyString(card.slug) ??
    nonEmptyString(agent.slug);
  const actionName =
    nonEmptyString(spec.actionName) ??
    nonEmptyString(card.actionName) ??
    nonEmptyString(agent.actionName);
  if (!slug || !actionName) return null;
  return {
    slug,
    actionName,
    name:
      nonEmptyString(spec.nameZh) ??
      nonEmptyString(spec.short) ??
      nonEmptyString(spec.name) ??
      nonEmptyString(agent.name) ??
      actionName,
    card: { ...card },
    design: design ? { ...design } : null,
    generatedCode:
      nonEmptySourceText(spec.generatedCode) ??
      nonEmptySourceText(agent.generatedCode) ??
      nonEmptySourceText(design?.code),
  };
}

type FactoryRunContinuationAncestry =
  | { ok: true; rootWaitingJobId: string; chain: string[] }
  | {
      ok: false;
      reason: string;
      chain: string[];
    };

interface FactoryRunContinuationAncestryInput {
  tenantId: string;
  sessionId: string;
  waitingJobId: string;
  waitingAttempt: number;
  factoryRunId: string;
  /**
   * New OntoCode-owned lineage. When present, this FK plus the execution's
   * private engine binding is authoritative; an encoded Job/attempt run id is
   * only a compatibility protocol for rows which predate Build executions.
   */
  buildExecutionId?: string | null;
}

function resolveStableFactoryRunContinuationAncestry(
  input: FactoryRunContinuationAncestryInput & { buildExecutionId: string },
): FactoryRunContinuationAncestry {
  const db = getDb();
  const execution = db
    .select({
      engineKind: ontocodeBuildExecutions.engineKind,
      engineRunId: ontocodeBuildExecutions.engineRunId,
      ontologyHash: ontocodeBuildExecutions.ontologyHash,
      checkpointDigest: ontocodeBuildExecutions.checkpointDigest,
      checkpointRevision: ontocodeBuildExecutions.checkpointRevision,
    })
    .from(ontocodeBuildExecutions)
    .where(
      and(
        eq(ontocodeBuildExecutions.tenantId, input.tenantId),
        eq(ontocodeBuildExecutions.sessionId, input.sessionId),
        eq(ontocodeBuildExecutions.id, input.buildExecutionId),
      ),
    )
    .get();
  if (
    !execution ||
    execution.engineKind !== "agent_factory" ||
    execution.engineRunId !== input.factoryRunId
  ) {
    return {
      ok: false,
      reason:
        "stable Build execution does not own the referenced private engine run",
      chain: [input.waitingJobId],
    };
  }

  const seen = new Set<string>();
  const chain: string[] = [];
  let childJobId = input.waitingJobId;

  for (let depth = 0; depth < 20; depth += 1) {
    if (seen.has(childJobId)) {
      return {
        ok: false,
        reason: "continuation ancestry contains a cycle",
        chain,
      };
    }
    seen.add(childJobId);
    chain.push(childJobId);

    const childJob = db
      .select({
        id: ontocodeHarnessJobs.id,
        kind: ontocodeHarnessJobs.kind,
        status: ontocodeHarnessJobs.status,
        attemptNo: ontocodeHarnessJobs.attemptNo,
        buildExecutionId: ontocodeHarnessJobs.buildExecutionId,
        createdAt: ontocodeHarnessJobs.createdAt,
      })
      .from(ontocodeHarnessJobs)
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, input.tenantId),
          eq(ontocodeHarnessJobs.sessionId, input.sessionId),
          eq(ontocodeHarnessJobs.id, childJobId),
        ),
      )
      .get();
    if (
      !childJob ||
      childJob.kind !== "build" ||
      childJob.status !== "cancelled" ||
      childJob.buildExecutionId !== input.buildExecutionId
    ) {
      return {
        ok: false,
        reason:
          "continuation child is missing, is not a cancelled Build, or belongs to another Build execution",
        chain,
      };
    }

    const startRows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, input.tenantId),
          eq(ontocodeSessionEvents.sessionId, input.sessionId),
          eq(ontocodeSessionEvents.harnessJobId, childJobId),
          eq(ontocodeSessionEvents.type, "harness.build.factory_started"),
        ),
      )
      .all();
    const parsedStarts = startRows.map((row) =>
      parseEventPayload(row.payloadJson),
    );
    const matchingStarts = parsedStarts.flatMap((payload) =>
      payload?.jobId === childJobId &&
      payload.factoryRunId === input.factoryRunId &&
      payload.buildExecutionId === input.buildExecutionId
        ? [payload]
        : [],
    );
    if (matchingStarts.length !== 1) {
      const legacyStart =
        parsedStarts.length === 1 ? (parsedStarts[0] ?? null) : null;
      const legacyStartAttempt = legacyStart?.attempt;
      const legacyWaitingRows = db
        .select({ payloadJson: ontocodeSessionEvents.payloadJson })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.tenantId, input.tenantId),
            eq(ontocodeSessionEvents.sessionId, input.sessionId),
            eq(ontocodeSessionEvents.harnessJobId, childJobId),
            eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
          ),
        )
        .all();
      const legacyWaitingPayload =
        legacyWaitingRows.length === 1
          ? parseEventPayload(legacyWaitingRows[0]!.payloadJson)
          : null;
      const legacyWaitingReceipt = asRecord(legacyWaitingPayload?.receipt);
      const legacyRecovery = asRecord(legacyWaitingReceipt?.recovery);
      const legacyEngineReceipt = legacyWaitingReceipt
        ? { ...legacyWaitingReceipt }
        : null;
      if (legacyEngineReceipt) {
        // The product wrapper is added after the private checkpoint digest is
        // committed. Remove only those wrapper fields to reconstruct that
        // exact engine receipt; adoption itself instead digests the complete
        // immutable waiting payload, so both proven forms are accepted below.
        delete legacyEngineReceipt.schema;
        delete legacyEngineReceipt.ontologyHash;
        delete legacyEngineReceipt.scope;
        delete legacyEngineReceipt.candidateToolContracts;
      }
      const exactCheckpointDigests = new Set(
        [
          legacyWaitingPayload
            ? buildExecutionCheckpointDigest(legacyWaitingPayload)
            : null,
          legacyEngineReceipt
            ? buildExecutionCheckpointDigest(legacyEngineReceipt)
            : null,
        ].flatMap((digest) => (digest ? [digest] : [])),
      );
      const isExactReconciledLegacyRoot = Boolean(
        matchingStarts.length === 0 &&
        legacyStart &&
        legacyStart.jobId === childJobId &&
        legacyStart.factoryRunId === input.factoryRunId &&
        legacyStart.buildExecutionId === undefined &&
        (legacyStart.resumedFromWaitingJobId === undefined ||
          legacyStart.resumedFromWaitingJobId === null) &&
        Number.isSafeInteger(legacyStartAttempt) &&
        Number(legacyStartAttempt) >= 1 &&
        legacyStart.ontologyHash === execution.ontologyHash &&
        legacyWaitingPayload?.jobId === childJobId &&
        legacyWaitingPayload.kind === "build" &&
        Number.isSafeInteger(legacyWaitingPayload.attempt) &&
        legacyWaitingPayload.attempt === childJob.attemptNo &&
        legacyWaitingReceipt?.schema === "ontocode-build-receipt/v1" &&
        legacyWaitingReceipt.status === "waiting_human" &&
        legacyWaitingReceipt.buildExecutionId === input.buildExecutionId &&
        legacyWaitingReceipt.factoryRunId === input.factoryRunId &&
        legacyWaitingReceipt.ontologyHash === execution.ontologyHash &&
        legacyRecovery?.schema ===
          "ontocode-build-final-turn-gate-reconciliation/v1" &&
        legacyRecovery.mode === "legacy_final_turn_gate" &&
        legacyRecovery.recoveredAttempt === legacyStartAttempt &&
        legacyRecovery.finalizedAttempt === legacyWaitingPayload.attempt &&
        legacyRecovery.replayedHumanAnswer === false &&
        execution.checkpointRevision >= 1 &&
        execution.checkpointDigest !== null &&
        exactCheckpointDigests.has(execution.checkpointDigest),
      );
      if (isExactReconciledLegacyRoot) {
        return {
          ok: true,
          rootWaitingJobId: childJobId,
          chain,
        };
      }
      return {
        ok: false,
        reason:
          "continuation child does not have one matching Build-execution start receipt",
        chain,
      };
    }
    const parentJobId = nonEmptyString(
      matchingStarts[0]?.resumedFromWaitingJobId,
    );
    if (!parentJobId) {
      return {
        ok: true,
        rootWaitingJobId: childJobId,
        chain,
      };
    }
    if (seen.has(parentJobId)) {
      return {
        ok: false,
        reason: "continuation Build-execution start receipt contains a cycle",
        chain,
      };
    }

    const parentJob = db
      .select({
        id: ontocodeHarnessJobs.id,
        kind: ontocodeHarnessJobs.kind,
        status: ontocodeHarnessJobs.status,
        buildExecutionId: ontocodeHarnessJobs.buildExecutionId,
        createdAt: ontocodeHarnessJobs.createdAt,
      })
      .from(ontocodeHarnessJobs)
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, input.tenantId),
          eq(ontocodeHarnessJobs.sessionId, input.sessionId),
          eq(ontocodeHarnessJobs.id, parentJobId),
        ),
      )
      .get();
    if (
      !parentJob ||
      parentJob.kind !== "build" ||
      parentJob.status !== "cancelled" ||
      parentJob.buildExecutionId !== input.buildExecutionId ||
      parentJob.createdAt.getTime() >= childJob.createdAt.getTime()
    ) {
      return {
        ok: false,
        reason:
          "continuation parent is missing, stale, or belongs to another Build execution",
        chain,
      };
    }

    const resolutionLinks = db
      .select({
        harnessJobId: ontocodeSessionEvents.harnessJobId,
        payloadJson: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, input.tenantId),
          eq(ontocodeSessionEvents.sessionId, input.sessionId),
          eq(ontocodeSessionEvents.type, "harness.job.input_resolved"),
        ),
      )
      .all()
      .flatMap((row) => {
        const payload = parseEventPayload(row.payloadJson);
        return payload?.waitingJobId === parentJobId
          ? [{ harnessJobId: row.harnessJobId, payload }]
          : [];
      });
    if (
      resolutionLinks.length !== 1 ||
      resolutionLinks[0]?.harnessJobId !== childJobId ||
      resolutionLinks[0]?.payload.followUpJobId !== childJobId
    ) {
      return {
        ok: false,
        reason:
          "continuation parent/child does not have one exact input-resolution link",
        chain,
      };
    }

    const parentWaitingReceiptRows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, input.tenantId),
          eq(ontocodeSessionEvents.sessionId, input.sessionId),
          eq(ontocodeSessionEvents.harnessJobId, parentJobId),
          eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
        ),
      )
      .all();
    const parentWaitingReceipt =
      parentWaitingReceiptRows.length === 1
        ? parseEventPayload(parentWaitingReceiptRows[0]!.payloadJson)
        : null;
    const parentReceipt = asRecord(parentWaitingReceipt?.receipt);
    const parentReceiptRunId = nonEmptyString(parentReceipt?.factoryRunId);
    if (
      !parentWaitingReceipt ||
      parentReceipt?.buildExecutionId !== input.buildExecutionId ||
      (parentReceiptRunId !== null && parentReceiptRunId !== input.factoryRunId)
    ) {
      return {
        ok: false,
        reason:
          "continuation parent does not have one matching durable Build-execution waiting receipt",
        chain,
      };
    }
    childJobId = parentJobId;
  }

  return {
    ok: false,
    reason: "continuation ancestry exceeded the maximum supported depth",
    chain,
  };
}

function resolveFactoryRunContinuationAncestry(
  input: FactoryRunContinuationAncestryInput,
): FactoryRunContinuationAncestry {
  if (input.buildExecutionId) {
    return resolveStableFactoryRunContinuationAncestry({
      ...input,
      buildExecutionId: input.buildExecutionId,
    });
  }
  const db = getDb();
  const seen = new Set<string>();
  const chain: string[] = [];
  let childJobId = input.waitingJobId;
  let childAttempt = input.waitingAttempt;

  for (let depth = 0; depth < 20; depth += 1) {
    if (seen.has(childJobId)) {
      return {
        ok: false,
        reason: "continuation ancestry contains a cycle",
        chain,
      };
    }
    seen.add(childJobId);
    chain.push(childJobId);
    if (input.factoryRunId === `ocf-${childJobId}-a${String(childAttempt)}`) {
      return {
        ok: true,
        rootWaitingJobId: childJobId,
        chain,
      };
    }

    const childJob = db
      .select({
        id: ontocodeHarnessJobs.id,
        kind: ontocodeHarnessJobs.kind,
        status: ontocodeHarnessJobs.status,
        createdAt: ontocodeHarnessJobs.createdAt,
      })
      .from(ontocodeHarnessJobs)
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, input.tenantId),
          eq(ontocodeHarnessJobs.sessionId, input.sessionId),
          eq(ontocodeHarnessJobs.id, childJobId),
        ),
      )
      .get();
    if (
      !childJob ||
      childJob.kind !== "build" ||
      childJob.status !== "cancelled"
    ) {
      return {
        ok: false,
        reason: "continuation child is missing or is not a cancelled Build",
        chain,
      };
    }

    const startedRows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, input.tenantId),
          eq(ontocodeSessionEvents.sessionId, input.sessionId),
          eq(ontocodeSessionEvents.harnessJobId, childJobId),
          eq(ontocodeSessionEvents.type, "harness.build.factory_started"),
        ),
      )
      .all();
    const started =
      startedRows.length === 1
        ? parseEventPayload(startedRows[0]!.payloadJson)
        : null;
    if (!started || started.factoryRunId !== input.factoryRunId) {
      return {
        ok: false,
        reason:
          "continuation child does not have one matching Factory-start receipt",
        chain,
      };
    }
    const parentJobId = nonEmptyString(started.resumedFromWaitingJobId);
    if (!parentJobId || seen.has(parentJobId)) {
      return {
        ok: false,
        reason: "continuation Factory-start receipt has no valid parent",
        chain,
      };
    }

    const parentJob = db
      .select({
        id: ontocodeHarnessJobs.id,
        kind: ontocodeHarnessJobs.kind,
        status: ontocodeHarnessJobs.status,
        createdAt: ontocodeHarnessJobs.createdAt,
      })
      .from(ontocodeHarnessJobs)
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, input.tenantId),
          eq(ontocodeHarnessJobs.sessionId, input.sessionId),
          eq(ontocodeHarnessJobs.id, parentJobId),
        ),
      )
      .get();
    if (
      !parentJob ||
      parentJob.kind !== "build" ||
      parentJob.status !== "cancelled" ||
      parentJob.createdAt.getTime() >= childJob.createdAt.getTime()
    ) {
      return {
        ok: false,
        reason:
          "continuation parent is missing, stale, or not a cancelled Build",
        chain,
      };
    }

    const resolutionLinks = db
      .select({
        harnessJobId: ontocodeSessionEvents.harnessJobId,
        payloadJson: ontocodeSessionEvents.payloadJson,
      })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, input.tenantId),
          eq(ontocodeSessionEvents.sessionId, input.sessionId),
          eq(ontocodeSessionEvents.type, "harness.job.input_resolved"),
        ),
      )
      .all()
      .flatMap((row) => {
        const payload = parseEventPayload(row.payloadJson);
        return payload?.waitingJobId === parentJobId
          ? [{ harnessJobId: row.harnessJobId, payload }]
          : [];
      });
    if (
      resolutionLinks.length !== 1 ||
      resolutionLinks[0]?.harnessJobId !== childJobId ||
      resolutionLinks[0]?.payload.followUpJobId !== childJobId
    ) {
      return {
        ok: false,
        reason:
          "continuation parent/child does not have one exact input-resolution link",
        chain,
      };
    }

    const parentWaitingReceiptRows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, input.tenantId),
          eq(ontocodeSessionEvents.sessionId, input.sessionId),
          eq(ontocodeSessionEvents.harnessJobId, parentJobId),
          eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
        ),
      )
      .all();
    const parentWaitingReceipt =
      parentWaitingReceiptRows.length === 1
        ? parseEventPayload(parentWaitingReceiptRows[0]!.payloadJson)
        : null;
    const parentReceipt = asRecord(parentWaitingReceipt?.receipt);
    const parentAttempt = parentWaitingReceipt?.attempt;
    if (
      !parentWaitingReceipt ||
      parentReceipt?.factoryRunId !== input.factoryRunId ||
      !Number.isSafeInteger(parentAttempt) ||
      Number(parentAttempt) < 1
    ) {
      return {
        ok: false,
        reason:
          "continuation parent does not have one matching durable waiting receipt",
        chain,
      };
    }
    childJobId = parentJobId;
    childAttempt = Number(parentAttempt);
  }

  return {
    ok: false,
    reason: "continuation ancestry exceeded the maximum supported depth",
    chain,
  };
}

export const __resolveFactoryRunContinuationAncestryForTest =
  resolveFactoryRunContinuationAncestry;

type FactoryClarificationOption = {
  label: string;
  value: string;
  recommended?: boolean;
};

type FactoryClarificationItem = {
  question: string;
  context?: string;
  options?: FactoryClarificationOption[];
};

function exactClarificationOptions(
  value: unknown,
): FactoryClarificationOption[] | null {
  if (!Array.isArray(value)) return null;
  const options: FactoryClarificationOption[] = [];
  for (const rawOption of value) {
    const option = asRecord(rawOption);
    const label = nonEmptyString(option?.label);
    const optionValue = nonEmptyString(option?.value);
    if (
      !option ||
      !label ||
      !optionValue ||
      (option.recommended !== undefined &&
        typeof option.recommended !== "boolean")
    ) {
      return null;
    }
    options.push({
      label,
      value: optionValue,
      ...(typeof option.recommended === "boolean"
        ? { recommended: option.recommended }
        : {}),
    });
  }
  return options;
}

function exactClarificationItems(
  value: unknown,
): FactoryClarificationItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: FactoryClarificationItem[] = [];
  for (const rawItem of value) {
    const item = asRecord(rawItem);
    const question = nonEmptyString(item?.question);
    const context =
      item?.context === undefined ? undefined : nonEmptyString(item.context);
    const options =
      item?.options === undefined
        ? undefined
        : exactClarificationOptions(item.options);
    if (
      !item ||
      !question ||
      (item.context !== undefined && !context) ||
      (item.options !== undefined && !options)
    ) {
      return null;
    }
    items.push({
      question,
      ...(context ? { context } : {}),
      ...(options ? { options } : {}),
    });
  }
  return items;
}

function exactOrderedStrings(value: unknown, expected: readonly string[]) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every(
      (entry, index) => typeof entry === "string" && entry === expected[index],
    )
  );
}

type StableBuildCheckpointRecovery = {
  result?: OntoCodeFactoryBuildResult;
  reconnect?: FactoryStartOnlyRecovery;
};

type StableCheckpointInteraction = {
  interaction: Record<string, unknown>;
  message: string;
  subjectDigest: string;
};

/**
 * Rebuild the public interaction card from the private, durable checkpoint.
 * The private interaction id is accepted only when it still hashes to the
 * checkpoint-owned subject; display copy is derived afterwards and never
 * participates in engine routing.
 */
function stableCheckpointInteraction(
  checkpoint: Record<string, unknown>,
  active: NonNullable<ReturnType<typeof activeHumanInteraction>>,
): StableCheckpointInteraction | null {
  if (active.kind === "clarify") {
    const prompt = asRecord(checkpoint.clarifyPrompt);
    const question = nonEmptyString(prompt?.question);
    const context =
      prompt?.context === undefined || prompt?.context === null
        ? null
        : nonEmptyString(prompt.context);
    const rawOptions = prompt?.options;
    const options =
      rawOptions === undefined || rawOptions === null
        ? []
        : exactClarificationOptions(rawOptions);
    const rawItems = prompt?.items;
    const items =
      rawItems === undefined || rawItems === null
        ? []
        : exactClarificationItems(rawItems);
    if (
      !question ||
      (prompt?.context !== undefined && prompt.context !== null && !context) ||
      !options ||
      !items ||
      !humanInteractionMatchesSubject(active, "clarify", {
        question,
        context,
        options:
          rawOptions === undefined || rawOptions === null ? null : options,
      })
    ) {
      return null;
    }
    const interaction = {
      kind: "clarify",
      awaitingAnswer: true,
      interactionId: active.interactionId,
      question,
      context,
      options,
      items,
    };
    return {
      interaction,
      message: clarificationAssistantText({
        t: "clarify",
        question,
        ...(context ? { context } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(items.length > 0 ? { items } : {}),
        awaitingAnswer: true,
        interactionId: active.interactionId,
      }),
      subjectDigest: createHash("sha256")
        .update(canonicalEvidenceJson({ question, context, options, items }))
        .digest("hex"),
    };
  }

  if (active.kind === "test_approval") {
    const cases = Array.isArray(checkpoint.testCases)
      ? checkpoint.testCases
      : null;
    const coverage = checkpoint.testCoverage ?? null;
    if (
      !cases ||
      !humanInteractionMatchesSubject(active, "test_approval", {
        cases,
        coverage,
      })
    ) {
      return null;
    }
    const uncovered = stringList(asRecord(coverage)?.uncoveredNeedingData);
    const question = `已生成 ${cases.length} 个测试用例。请选择执行当前用例、重新生成、补充测试数据，或只保存未验证设计稿。`;
    const context =
      uncovered.length > 0
        ? `覆盖矩阵仍有 ${uncovered.length} 项需要真实数据：${uncovered.slice(0, 8).join("、")}`
        : "覆盖矩阵已齐全；确认后才会进入沙箱执行。";
    const options = [
      {
        label: "执行当前用例",
        value: "[测试用例决策: 执行]",
        ...(uncovered.length === 0 ? { recommended: true } : {}),
      },
      { label: "重新生成用例", value: "[测试用例决策: 重新生成]" },
      {
        label: "补充测试数据",
        value: "[测试用例决策: 补数据]",
        ...(uncovered.length > 0 ? { recommended: true } : {}),
      },
      { label: "保存未验证设计稿", value: "[测试用例决策: 保存设计稿]" },
    ];
    const interaction = {
      kind: "test_approval",
      awaitingAnswer: true,
      interactionId: active.interactionId,
      question,
      context,
      options,
      allowOther: false,
    };
    return {
      interaction,
      message: `${question}\n${context}`,
      subjectDigest: createHash("sha256")
        .update(
          canonicalEvidenceJson({
            question,
            context,
            options,
            items: [],
          }),
        )
        .digest("hex"),
    };
  }

  if (active.kind === "boundary") {
    const proposals = Array.isArray(checkpoint.boundaryProposals)
      ? checkpoint.boundaryProposals
      : null;
    if (
      !proposals ||
      !humanInteractionMatchesSubject(active, "boundary", proposals)
    ) {
      return null;
    }
    const decisions = proposals.flatMap((rawProposal) => {
      const proposal = asRecord(rawProposal);
      const event = nonEmptyString(proposal?.event);
      const kind =
        proposal?.suggestedKind === "external" ||
        proposal?.suggestedKind === "terminal" ||
        proposal?.suggestedKind === "break"
          ? proposal.suggestedKind
          : null;
      return event && kind
        ? [
            {
              event,
              kind,
              ...(nonEmptyString(proposal?.consumer)
                ? { consumer: nonEmptyString(proposal?.consumer)! }
                : {}),
              ...(nonEmptyString(proposal?.payloadContract)
                ? {
                    payloadContract: nonEmptyString(proposal?.payloadContract)!,
                  }
                : {}),
            },
          ]
        : [];
    });
    if (decisions.length !== proposals.length || decisions.length === 0) {
      return null;
    }
    const question = "请确认 OntoCode 建议的边界事件分类";
    const context =
      "该选择会决定哪些事件离开当前 Agent 流程；确认前不会继续生成或执行。";
    const options = [
      {
        label: "采用建议分类",
        value: `[边界事件决策] ${JSON.stringify(decisions)}`,
        ...(decisions.every((decision) => decision.kind !== "break")
          ? { recommended: true }
          : {}),
      },
    ];
    const interaction = {
      kind: "boundary",
      awaitingAnswer: true,
      interactionId: active.interactionId,
      question,
      context,
      options,
      allowOther: true,
    };
    return {
      interaction,
      message: `${question}\n${context}`,
      subjectDigest: createHash("sha256")
        .update(
          canonicalEvidenceJson({
            question,
            context,
            options,
            items: [],
          }),
        )
        .digest("hex"),
    };
  }

  return null;
}

/**
 * Recover a modern Build from its OntoCode-owned execution row. Harness Jobs
 * and attempts are transport leases, so their progress-row topology is not an
 * execution identity and is deliberately not consulted here.
 */
function resolveStableBuildCheckpointRecovery(
  context: OntoCodeHarnessExecutionContext,
  buildExecution: OntoCodeBuildExecutionBinding,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
): StableBuildCheckpointRecovery | undefined {
  if (
    context.job.kind !== "build" ||
    context.attempt < 2 ||
    context.claim.previousStatus !== "retry_scheduled" ||
    context.job.buildExecutionId !== buildExecution.id
  ) {
    return undefined;
  }

  const db = getDb();
  const jobBinding = db
    .select({ buildExecutionId: ontocodeHarnessJobs.buildExecutionId })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
        eq(ontocodeHarnessJobs.sessionId, context.session.id),
        eq(ontocodeHarnessJobs.id, context.job.id),
      ),
    )
    .get()?.buildExecutionId;
  const execution = db
    .select()
    .from(ontocodeBuildExecutions)
    .where(
      and(
        eq(ontocodeBuildExecutions.tenantId, context.job.tenantId),
        eq(ontocodeBuildExecutions.id, buildExecution.id),
        eq(ontocodeBuildExecutions.projectId, context.project.id),
        eq(ontocodeBuildExecutions.sessionId, context.session.id),
      ),
    )
    .get();
  const directiveJson = canonicalEvidenceJson(directive);
  const directiveHash = factoryGenerationDirectiveFingerprint(directive);
  const baseDetails = {
    jobId: context.job.id,
    attempt: context.attempt,
    buildExecutionId: buildExecution.id,
    engineRunId: buildExecution.engineRunId,
  };
  if (
    jobBinding !== buildExecution.id ||
    !execution ||
    execution.state !== "running" ||
    execution.ontologyHash !== ontologyHash ||
    execution.directiveHash !== directiveHash ||
    execution.directiveJson !== directiveJson ||
    (execution.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null) ||
    execution.engineKind !== "agent_factory" ||
    execution.engineRunId !== buildExecution.engineRunId
  ) {
    return factoryResumeRefusal(
      "ontocode_build_checkpoint_binding_mismatch",
      "OntoCode 的稳定构建记录不再匹配当前本体、运行时或内部生成检查点",
      baseDetails,
    );
  }

  const pendingEnvelopeValues = [
    execution.pendingInteractionId,
    execution.pendingInteractionKind,
    execution.pendingInteractionSubjectDigest,
    execution.pendingAnswerId,
    execution.pendingAnswerDigest,
    execution.pendingAnswerStatus,
  ];
  const hasPendingEnvelope = pendingEnvelopeValues.some(
    (value) => value !== null,
  );
  const completePendingEnvelope = Boolean(
    execution.pendingInteractionId &&
    execution.pendingInteractionKind &&
    execution.pendingInteractionSubjectDigest &&
    execution.pendingAnswerId &&
    execution.pendingAnswerDigest &&
    (execution.pendingAnswerStatus === "pending" ||
      execution.pendingAnswerStatus === "delivered"),
  );
  const commandAnswer = nonEmptyString(
    context.command?.arguments.clarificationAnswer,
  );
  if (
    (hasPendingEnvelope && !completePendingEnvelope) ||
    (completePendingEnvelope &&
      (!commandAnswer ||
        createHash("sha256").update(commandAnswer).digest("hex") !==
          execution.pendingAnswerDigest))
  ) {
    return factoryResumeRefusal(
      "ontocode_build_answer_envelope_mismatch",
      "OntoCode 无法把本次重试绑定到唯一、完整的人机交互答案",
      baseDetails,
    );
  }

  const factoryRun = getFactoryRun(
    buildExecution.engineRunId,
    context.job.tenantId,
  );
  const conversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      messagesJson: factoryConversations.messagesJson,
      ctxJson: factoryConversations.ctxJson,
      updatedAt: factoryConversations.updatedAt,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, buildExecution.engineRunId))
    .get();

  if (!conversation) {
    if (factoryRun || hasPendingEnvelope) {
      return factoryResumeRefusal(
        "ontocode_build_checkpoint_missing",
        "OntoCode 的内部生成记录缺少可恢复的持久检查点",
        baseDetails,
      );
    }
    return {
      reconnect: {
        sourceAttempt: Math.max(1, context.attempt - 1),
        reconnect: {
          mode: "restart_from_command",
          factoryRunId: buildExecution.engineRunId,
          persistGoal: factoryBuildGoal(
            directive,
            context.session.goal,
            context.command,
          ),
          capturedAgents: [],
        },
      },
    };
  }

  const checkpoint = asRecord(conversation.ctxJson);
  let checkpointFingerprint: string | null = null;
  try {
    checkpointFingerprint = factoryGenerationDirectiveFingerprint(
      asRecord(checkpoint?.generationDirective) as unknown as
        | FactoryGenerationDirective
        | undefined,
    );
  } catch {
    checkpointFingerprint = null;
  }
  if (
    !factoryRun ||
    factoryRun.deletedAt !== null ||
    factoryRun.domain !== context.project.domain ||
    (factoryRun.ontologyDomainRegistrationId ?? null) !==
      (context.project.ontologyDomainRegistrationId ?? null) ||
    (factoryRun.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null) ||
    conversation.tenantId !== context.job.tenantId ||
    conversation.domain !== context.project.domain ||
    !checkpoint ||
    nonEmptyString(checkpoint.domain) !== context.project.domain ||
    checkpointFingerprint !== directiveHash
  ) {
    return factoryResumeRefusal(
      "ontocode_build_checkpoint_stale",
      "OntoCode 的内部生成检查点不再匹配当前租户、领域、本体范围或运行时",
      {
        ...baseDetails,
        engineStatus: factoryRun?.status ?? null,
      },
    );
  }

  const rawSpecs = Array.isArray(checkpoint.specs) ? checkpoint.specs : [];
  const capturedAgents = rawSpecs.flatMap((value) => {
    const captured = capturedFactoryAgent(value);
    return captured ? [captured] : [];
  });
  const agentKeys = capturedAgents.map(
    (agent) => `${agent.slug}\u0000${agent.actionName}`,
  );
  if (
    capturedAgents.length !== rawSpecs.length ||
    new Set(agentKeys).size !== agentKeys.length ||
    new Set(capturedAgents.map((agent) => agent.slug)).size !==
      capturedAgents.length ||
    new Set(capturedAgents.map((agent) => agent.actionName)).size !==
      capturedAgents.length ||
    capturedAgents.some(
      (agent) => !directive.requestedActionNames.includes(agent.actionName),
    )
  ) {
    return factoryResumeRefusal(
      "ontocode_build_checkpoint_agents_mismatch",
      "OntoCode 的持久检查点包含重复、损坏或超出当前范围的 Agent 设计",
      {
        ...baseDetails,
        checkpointAgentCount: rawSpecs.length,
      },
    );
  }

  const active = activeHumanInteraction(
    checkpoint as Parameters<typeof activeHumanInteraction>[0],
  );
  const activeKind = activeHumanInteractionKind(
    checkpoint as Parameters<typeof activeHumanInteractionKind>[0],
  );
  if (active) {
    const projected = stableCheckpointInteraction(checkpoint, active);
    if (!projected) {
      return factoryResumeRefusal(
        "ontocode_build_interaction_checkpoint_invalid",
        "OntoCode 的持久交互与内部生成检查点不一致，已停止恢复以避免应用错误答案",
        {
          ...baseDetails,
          interactionId: active.interactionId,
          interactionKind: active.kind,
        },
      );
    }

    const sameAnsweredInteraction = Boolean(
      completePendingEnvelope &&
      execution.pendingInteractionId === active.interactionId,
    );
    if (
      sameAnsweredInteraction &&
      execution.pendingInteractionSubjectDigest !== projected.subjectDigest
    ) {
      return factoryResumeRefusal(
        "ontocode_build_interaction_envelope_mismatch",
        "OntoCode 的待处理交互已变化，本次重试不会重复应用旧答案",
        {
          ...baseDetails,
          interactionId: active.interactionId,
        },
      );
    }
    if (
      completePendingEnvelope &&
      !sameAnsweredInteraction &&
      execution.pendingAnswerStatus !== "delivered"
    ) {
      return factoryResumeRefusal(
        "ontocode_build_answer_not_delivered",
        "旧答案尚未被持久接收，OntoCode 不会跳到新的交互检查点",
        baseDetails,
      );
    }

    // An answer that still targets this gate must be redelivered/resumed from
    // its one-shot envelope. It is not evidence that the user must answer the
    // same question again.
    if (sameAnsweredInteraction) {
      return execution.pendingAnswerStatus === "pending"
        ? undefined
        : {
            reconnect: {
              sourceAttempt: Math.max(1, context.attempt - 1),
              reconnect: {
                mode: "reattach",
                factoryRunId: buildExecution.engineRunId,
                persistGoal: factoryRun.goal,
                capturedAgents,
              },
            },
          };
    }

    const terminalDone = factoryRun.transcript
      .filter((event) => asRecord(event)?.t === "done")
      .map(asRecord)
      .at(-1);
    const legacyFailedAtDurableGate = Boolean(
      factoryRun.status === "failed" &&
      terminalDone?.status === "turns_exhausted" &&
      terminalDone.completionKind === "incomplete",
    );
    if (legacyFailedAtDurableGate) {
      const normalized = db
        .update(factoryRuns)
        .set({
          status: "waiting_human",
          reachedTerminal: false,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(factoryRuns.id, buildExecution.engineRunId),
            eq(factoryRuns.tenantId, context.job.tenantId),
            eq(factoryRuns.status, "failed"),
            isNull(factoryRuns.deletedAt),
          ),
        )
        .run() as { changes?: number };
      if ((normalized.changes ?? 0) !== 1) {
        return factoryResumeRefusal(
          "ontocode_build_checkpoint_changed",
          "OntoCode 的内部生成检查点在恢复时发生了变化",
          baseDetails,
        );
      }
    } else if (factoryRun.status !== "waiting_human") {
      return {
        reconnect: {
          sourceAttempt: Math.max(1, context.attempt - 1),
          reconnect: {
            mode: "reattach",
            factoryRunId: buildExecution.engineRunId,
            persistGoal: factoryRun.goal,
            capturedAgents,
          },
        },
      };
    }

    const currentConversation = db
      .select({
        ctxJson: factoryConversations.ctxJson,
        updatedAt: factoryConversations.updatedAt,
      })
      .from(factoryConversations)
      .where(eq(factoryConversations.id, buildExecution.engineRunId))
      .get();
    const currentRun = getFactoryRun(
      buildExecution.engineRunId,
      context.job.tenantId,
    );
    if (
      !currentRun ||
      currentRun.status !== "waiting_human" ||
      !currentConversation ||
      currentConversation.updatedAt.getTime() !==
        conversation.updatedAt.getTime() ||
      canonicalEvidenceJson(currentConversation.ctxJson) !==
        canonicalEvidenceJson(conversation.ctxJson)
    ) {
      return factoryResumeRefusal(
        "ontocode_build_checkpoint_changed",
        "OntoCode 的内部生成检查点在恢复时发生了变化",
        baseDetails,
      );
    }

    return {
      result: {
        outcome: "waiting_user",
        message: projected.message,
        receipt: {
          factoryRunId: buildExecution.engineRunId,
          status: "waiting_human",
          completionKind: factoryRun.completionKind,
          actionIds: [...directive.requestedActionIds],
          actionNames: [...directive.requestedActionNames],
          agents: [],
          ...(capturedAgents.length > 0
            ? {
                agentPreviews: capturedAgents,
                candidateEligibility: "non_candidate_preview",
              }
            : {}),
          interaction: projected.interaction,
          usage: {
            tokensUsed: factoryRun.tokensUsed,
            conversationTokensUsed: factoryRun.tokensUsed,
            turns: factoryRun.turns,
          },
          recovery: {
            schema: "ontocode-build-stable-checkpoint-recovery/v1",
            buildExecutionId: buildExecution.id,
            finalizedByJobId: context.job.id,
            finalizedByAttempt: context.attempt,
            replayedHumanAnswer: false,
          },
        },
      },
    };
  }

  if (
    completePendingEnvelope &&
    execution.pendingInteractionKind === "execution_readiness"
  ) {
    if (activeKind !== null) {
      return factoryResumeRefusal(
        "ontocode_build_continuation_gate_mismatch",
        "OntoCode 的审阅继续指令不能覆盖内部人机交互等待状态",
        {
          ...baseDetails,
          activeInteractionKind: activeKind,
        },
      );
    }
    const ledger = stableContinuationLedger(checkpoint);
    if (!ledger) {
      return factoryResumeRefusal(
        "ontocode_build_continuation_ledger_invalid",
        "OntoCode 的稳定继续执行记录已损坏",
        baseDetails,
      );
    }
    if (
      !checkpointHasOntoCodeContinuation(
        checkpoint,
        execution.pendingAnswerId!,
        execution.pendingAnswerDigest!,
      )
    ) {
      // `delivered` only means dispatch was accepted. Without the serialized
      // ctx ledger, the ordinary continuation still has to enter the durable
      // mailbox; a message-history marker is diagnostic, never authority.
      return undefined;
    }
    return {
      reconnect: {
        sourceAttempt: Math.max(1, context.attempt - 1),
        reconnect: {
          mode: "reattach",
          factoryRunId: buildExecution.engineRunId,
          persistGoal: factoryRun.goal,
          capturedAgents,
        },
      },
    };
  }

  if (factoryRun.status === "waiting_human" || factoryRun.status === "done") {
    return factoryResumeRefusal(
      "ontocode_build_checkpoint_terminal_without_interaction",
      "OntoCode 的内部生成记录已停止，但没有可恢复的人机交互或交付回执",
      { ...baseDetails, engineStatus: factoryRun.status },
    );
  }

  return {
    reconnect: {
      sourceAttempt: Math.max(1, context.attempt - 1),
      reconnect: {
        mode: "reattach",
        factoryRunId: buildExecution.engineRunId,
        persistGoal: factoryRun.goal,
        capturedAgents,
      },
    },
  };
}

type StableBuildContinuation = {
  resume?: OntoCodeFactoryBuildResume;
  reconnect?: FactoryStartOnlyRecovery;
};

/**
 * Resolve the first delivery (and any idempotent retry) of an answer owned by
 * a modern OntoCode Build execution. This deliberately does not inspect
 * Factory-start or per-attempt ancestry events: the atomically-bound parent,
 * child, input-resolution row, answer envelope and one private engine binding
 * are the complete product protocol.
 */
function resolveStableBuildContinuation(
  context: OntoCodeHarnessExecutionContext,
  buildExecution: OntoCodeBuildExecutionBinding,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
): StableBuildContinuation | undefined {
  if (
    context.job.kind !== "build" ||
    context.job.buildExecutionId !== buildExecution.id
  ) {
    return undefined;
  }
  const waitingJobId = nonEmptyString(
    context.command?.arguments.resumeWaitingUserJobId,
  );
  const answer = nonEmptyString(context.command?.arguments.clarificationAnswer);
  if (!waitingJobId && !answer) return undefined;
  const baseDetails = {
    jobId: context.job.id,
    waitingJobId,
    buildExecutionId: buildExecution.id,
    engineRunId: buildExecution.engineRunId,
  };
  if (!context.command || !waitingJobId || !answer) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_incomplete",
      "OntoCode 的继续执行请求没有同时绑定原等待任务和确切答案",
      baseDetails,
    );
  }

  const db = getDb();
  const currentJob = db
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
        eq(ontocodeHarnessJobs.sessionId, context.session.id),
        eq(ontocodeHarnessJobs.id, context.job.id),
      ),
    )
    .get();
  const waitingJob = db
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
        eq(ontocodeHarnessJobs.sessionId, context.session.id),
        eq(ontocodeHarnessJobs.id, waitingJobId),
      ),
    )
    .get();
  if (
    !currentJob ||
    currentJob.kind !== "build" ||
    currentJob.status !== "running" ||
    currentJob.buildExecutionId !== buildExecution.id ||
    !waitingJob ||
    waitingJob.kind !== "build" ||
    waitingJob.status !== "cancelled" ||
    waitingJob.buildExecutionId !== buildExecution.id ||
    waitingJob.createdAt.getTime() >= currentJob.createdAt.getTime() ||
    (waitingJob.runtimeProfileVersionId ?? null) !==
      (currentJob.runtimeProfileVersionId ?? null)
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_owner_mismatch",
      "OntoCode 的等待任务、继续任务或稳定构建归属不一致",
      baseDetails,
    );
  }

  const resolutionRows = db
    .select({
      harnessJobId: ontocodeSessionEvents.harnessJobId,
      payloadJson: ontocodeSessionEvents.payloadJson,
    })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
        eq(ontocodeSessionEvents.sessionId, context.session.id),
        eq(ontocodeSessionEvents.type, "harness.job.input_resolved"),
      ),
    )
    .all()
    .flatMap((row) => {
      const payload = parseEventPayload(row.payloadJson);
      return payload?.waitingJobId === waitingJobId
        ? [{ harnessJobId: row.harnessJobId, payload }]
        : [];
    });
  if (
    resolutionRows.length !== 1 ||
    resolutionRows[0]?.harnessJobId !== currentJob.id ||
    resolutionRows[0]?.payload.followUpJobId !== currentJob.id ||
    resolutionRows[0]?.payload.buildExecutionId !== buildExecution.id
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_resolution_mismatch",
      "OntoCode 找不到唯一、原子提交的人机交互续接记录",
      { ...baseDetails, resolutionCount: resolutionRows.length },
    );
  }

  const execution = db
    .select()
    .from(ontocodeBuildExecutions)
    .where(
      and(
        eq(ontocodeBuildExecutions.tenantId, context.job.tenantId),
        eq(ontocodeBuildExecutions.id, buildExecution.id),
        eq(ontocodeBuildExecutions.projectId, context.project.id),
        eq(ontocodeBuildExecutions.sessionId, context.session.id),
      ),
    )
    .get();
  const answerDigest = createHash("sha256").update(answer).digest("hex");
  const directiveHash = factoryGenerationDirectiveFingerprint(directive);
  if (
    !execution ||
    execution.state !== "running" ||
    execution.ontologyHash !== ontologyHash ||
    execution.directiveHash !== directiveHash ||
    execution.directiveJson !== canonicalEvidenceJson(directive) ||
    execution.engineKind !== "agent_factory" ||
    execution.engineRunId !== buildExecution.engineRunId ||
    (execution.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null) ||
    !execution.pendingInteractionId ||
    !execution.pendingInteractionKind ||
    !execution.pendingInteractionSubjectDigest ||
    !execution.pendingAnswerId ||
    execution.pendingAnswerDigest !== answerDigest ||
    (execution.pendingAnswerStatus !== "pending" &&
      execution.pendingAnswerStatus !== "delivered") ||
    resolutionRows[0]?.payload.interactionId !==
      execution.pendingInteractionId ||
    resolutionRows[0]?.payload.pendingAnswerId !== execution.pendingAnswerId ||
    context.command.baseOntologyHash !== ontologyHash
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_envelope_mismatch",
      "OntoCode 的稳定构建范围或待投递答案已经变化",
      baseDetails,
    );
  }

  const factoryRun = getFactoryRun(
    buildExecution.engineRunId,
    context.job.tenantId,
  );
  const conversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      messagesJson: factoryConversations.messagesJson,
      ctxJson: factoryConversations.ctxJson,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, buildExecution.engineRunId))
    .get();
  const checkpoint = asRecord(conversation?.ctxJson);
  let checkpointFingerprint: string | null = null;
  try {
    checkpointFingerprint = factoryGenerationDirectiveFingerprint(
      asRecord(checkpoint?.generationDirective) as unknown as
        | FactoryGenerationDirective
        | undefined,
    );
  } catch {
    checkpointFingerprint = null;
  }
  if (
    !factoryRun ||
    factoryRun.deletedAt !== null ||
    factoryRun.domain !== context.project.domain ||
    (factoryRun.ontologyDomainRegistrationId ?? null) !==
      (context.project.ontologyDomainRegistrationId ?? null) ||
    (factoryRun.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null) ||
    !conversation ||
    conversation.tenantId !== context.job.tenantId ||
    conversation.domain !== context.project.domain ||
    !checkpoint ||
    nonEmptyString(checkpoint.domain) !== context.project.domain ||
    checkpointFingerprint !== directiveHash
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_checkpoint_stale",
      "OntoCode 的内部生成检查点不再匹配当前稳定构建",
      { ...baseDetails, engineStatus: factoryRun?.status ?? null },
    );
  }

  const rawSpecs = Array.isArray(checkpoint.specs) ? checkpoint.specs : [];
  const capturedAgents = rawSpecs.flatMap((value) => {
    const captured = capturedFactoryAgent(value);
    return captured ? [captured] : [];
  });
  const identities = capturedAgents.map(
    (agent) => `${agent.slug}\u0000${agent.actionName}`,
  );
  if (
    capturedAgents.length !== rawSpecs.length ||
    new Set(identities).size !== identities.length ||
    new Set(capturedAgents.map((agent) => agent.slug)).size !==
      capturedAgents.length ||
    new Set(capturedAgents.map((agent) => agent.actionName)).size !==
      capturedAgents.length ||
    capturedAgents.some(
      (agent) => !directive.requestedActionNames.includes(agent.actionName),
    )
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_agents_mismatch",
      "OntoCode 的内部生成检查点包含重复、损坏或超出范围的 Agent 设计",
      baseDetails,
    );
  }

  const active = activeHumanInteraction(
    checkpoint as Parameters<typeof activeHumanInteraction>[0],
  );
  const activeKind = activeHumanInteractionKind(
    checkpoint as Parameters<typeof activeHumanInteractionKind>[0],
  );
  if (execution.pendingInteractionKind === "execution_readiness") {
    if (active !== null || activeKind !== null) {
      return factoryResumeRefusal(
        "ontocode_build_continuation_gate_mismatch",
        "OntoCode 的审阅继续指令不能覆盖一个新的内部人机交互",
        {
          ...baseDetails,
          activeInteractionId: active?.interactionId ?? null,
          activeInteractionKind: activeKind,
        },
      );
    }
    const alreadyCheckpointed = checkpointHasOntoCodeContinuation(
      checkpoint,
      execution.pendingAnswerId,
      execution.pendingAnswerDigest,
    );
    if (!stableContinuationLedger(checkpoint)) {
      return factoryResumeRefusal(
        "ontocode_build_continuation_ledger_invalid",
        "OntoCode 的稳定继续执行记录已损坏",
        baseDetails,
      );
    }
    if (alreadyCheckpointed) {
      return {
        reconnect: {
          sourceAttempt: Math.max(1, context.attempt - 1),
          reconnect: {
            mode: "reattach",
            factoryRunId: buildExecution.engineRunId,
            persistGoal: factoryRun.goal,
            capturedAgents,
          },
        },
      };
    }
    return {
      resume: {
        waitingJobId,
        factoryRunId: buildExecution.engineRunId,
        interactionId: execution.pendingInteractionId,
        interactionKind: "execution_readiness",
        answerId: execution.pendingAnswerId,
        answer,
        persistGoal: factoryRun.goal,
        capturedAgents,
      },
    };
  }

  if (
    !active ||
    active.interactionId !== execution.pendingInteractionId ||
    active.kind !== execution.pendingInteractionKind ||
    factoryRun.status !== "waiting_human"
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_gate_mismatch",
      "OntoCode 的待处理交互不再匹配内部生成检查点",
      {
        ...baseDetails,
        activeInteractionId: active?.interactionId ?? null,
        activeInteractionKind: active?.kind ?? null,
      },
    );
  }
  const legacyTestApprovalCheckpointMatches = (() => {
    const legacyTestCases = Array.isArray(checkpoint.testCases)
      ? checkpoint.testCases
      : null;
    if (
      active.kind !== "test_approval" ||
      execution.pendingInteractionKind !== "test_approval" ||
      checkpoint.awaitingApproval !== true ||
      checkpoint.testDataSupplementPending === true ||
      !legacyTestCases
    ) {
      return false;
    }

    const waitingRows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
          eq(ontocodeSessionEvents.sessionId, context.session.id),
          eq(ontocodeSessionEvents.harnessJobId, waitingJobId),
          eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
        ),
      )
      .all();
    if (waitingRows.length !== 1) return false;
    const waitingPayload = parseEventPayload(waitingRows[0]!.payloadJson);
    const priorReceipt = asRecord(waitingPayload?.receipt);
    const priorScope = asRecord(priorReceipt?.scope);
    if (
      waitingPayload?.jobId !== waitingJobId ||
      waitingPayload?.kind !== "build" ||
      !Number.isSafeInteger(waitingPayload?.attempt) ||
      priorReceipt?.schema !== "ontocode-build-receipt/v1" ||
      priorReceipt.ontologyHash !== ontologyHash ||
      priorReceipt.factoryRunId !== buildExecution.engineRunId ||
      priorReceipt.status !== "waiting_human" ||
      priorReceipt.interaction !== undefined ||
      !sameUniqueStrings(stringList(priorScope?.actionIds), [
        ...directive.requestedActionIds,
      ]) ||
      !sameUniqueStrings(stringList(priorScope?.actionNames), [
        ...directive.requestedActionNames,
      ])
    ) {
      return false;
    }

    const matchingTestCaseRows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
          eq(ontocodeSessionEvents.sessionId, context.session.id),
          eq(ontocodeSessionEvents.harnessJobId, waitingJobId),
          eq(ontocodeSessionEvents.type, "harness.build.test_cases"),
        ),
      )
      .all()
      .flatMap((row) => {
        const payload = parseEventPayload(row.payloadJson);
        return payload?.jobId === waitingJobId &&
          payload.factoryRunId === buildExecution.engineRunId &&
          payload.awaitingApproval === true &&
          payload.count === legacyTestCases.length &&
          canonicalEvidenceJson(payload.coverage ?? null) ===
            canonicalEvidenceJson(checkpoint.testCoverage ?? null)
          ? [payload]
          : [];
      });
    return matchingTestCaseRows.length === 1;
  })();
  const projected = stableCheckpointInteraction(checkpoint, active);
  if (
    (!projected ||
      projected.subjectDigest !== execution.pendingInteractionSubjectDigest) &&
    !legacyTestApprovalCheckpointMatches
  ) {
    return factoryResumeRefusal(
      "ontocode_build_continuation_subject_mismatch",
      "OntoCode 的交互内容已经变化，旧答案不会被应用",
      baseDetails,
    );
  }
  return {
    resume: {
      waitingJobId,
      factoryRunId: buildExecution.engineRunId,
      interactionId: active.interactionId,
      interactionKind: active.kind,
      answerId: execution.pendingAnswerId,
      answer,
      persistGoal: factoryRun.goal,
      capturedAgents,
    },
  };
}

/**
 * Recover a complete immutable Factory draft after the Factory committed
 * `save_draft`, but the owning Harness process detached before it could turn
 * that checkpoint into a Candidate.
 *
 * This is intentionally an explicit, read-only recovery command. It never
 * starts or resumes the Factory. The run id must resolve back to one earlier
 * Build Job in this exact Session, and every mutable projection is re-read
 * after the draft store lookup so concurrent drift fails closed.
 */
async function recoverFactoryDraftCheckpoint(
  context: OntoCodeHarnessExecutionContext,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
): Promise<OntoCodeFactoryBuildResult | undefined> {
  const commandArguments = context.command?.arguments;
  if (
    !commandArguments ||
    !Object.prototype.hasOwnProperty.call(
      commandArguments,
      "recoverFactoryDraftRunId",
    )
  ) {
    return undefined;
  }
  const factoryRunId = nonEmptyString(
    commandArguments.recoverFactoryDraftRunId,
  );
  const requestedActionIds = stringList(commandArguments.actionIds);
  const baseDetails = {
    jobId: context.job.id,
    sessionId: context.session.id,
    factoryRunId,
  };
  if (
    context.job.kind !== "build" ||
    context.command?.type !== "generate_package" ||
    !factoryRunId ||
    nonEmptyString(commandArguments.resumeWaitingUserJobId) ||
    nonEmptyString(commandArguments.clarificationAnswer) ||
    stringList(commandArguments.deferActionNames).length > 0 ||
    !sameUniqueStrings(requestedActionIds, directive.requestedActionIds) ||
    context.command.baseOntologyHash !== ontologyHash
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_command_invalid",
      "Factory draft recovery requires one explicit run id and the exact current Build Action scope",
      {
        ...baseDetails,
        requestedActionIds,
        directiveActionIds: [...directive.requestedActionIds],
      },
    );
  }

  const runIdentity = /^ocf-(ocj-.+)-a([1-9]\d*)$/.exec(factoryRunId);
  const sourceJobId = runIdentity?.[1] ?? null;
  const sourceAttempt = runIdentity ? Number(runIdentity[2]) : null;
  const db = getDb();
  const sourceJob = sourceJobId
    ? db
        .select({
          id: ontocodeHarnessJobs.id,
          tenantId: ontocodeHarnessJobs.tenantId,
          sessionId: ontocodeHarnessJobs.sessionId,
          kind: ontocodeHarnessJobs.kind,
          runtimeProfileVersionId: ontocodeHarnessJobs.runtimeProfileVersionId,
          createdAt: ontocodeHarnessJobs.createdAt,
        })
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.id, sourceJobId))
        .get()
    : null;
  const sourceStartRows =
    sourceJobId && sourceAttempt
      ? db
          .select({ payloadJson: ontocodeSessionEvents.payloadJson })
          .from(ontocodeSessionEvents)
          .where(
            and(
              eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
              eq(ontocodeSessionEvents.sessionId, context.session.id),
              eq(ontocodeSessionEvents.harnessJobId, sourceJobId),
              eq(ontocodeSessionEvents.type, "harness.job.started"),
            ),
          )
          .all()
          .filter(
            (row) =>
              parseEventPayload(row.payloadJson)?.attempt === sourceAttempt,
          )
      : [];
  if (
    !sourceJob ||
    sourceJob.tenantId !== context.job.tenantId ||
    sourceJob.sessionId !== context.session.id ||
    sourceJob.kind !== "build" ||
    sourceJob.createdAt.getTime() >=
      new Date(context.job.createdAt).getTime() ||
    (sourceJob.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null) ||
    sourceStartRows.length !== 1
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_session_mismatch",
      "The Factory run does not resolve to one earlier Build attempt in this exact tenant Session",
      {
        ...baseDetails,
        sourceJobId,
        sourceAttempt,
        sourceStartCount: sourceStartRows.length,
      },
    );
  }

  const factoryRun = getFactoryRun(factoryRunId, context.job.tenantId);
  if (
    !factoryRun ||
    factoryRun.deletedAt !== null ||
    factoryRun.status === "running" ||
    factoryRun.domain !== context.project.domain ||
    (factoryRun.ontologyDomainRegistrationId ?? null) !==
      (context.project.ontologyDomainRegistrationId ?? null) ||
    (factoryRun.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null)
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_run_stale",
      "The source Factory run is missing, active, deleted, or bound to different immutable execution coordinates",
      {
        ...baseDetails,
        sourceJobId,
        factoryRunStatus: factoryRun?.status ?? null,
        actualDomain: factoryRun?.domain ?? null,
      },
    );
  }

  const conversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      ctxJson: factoryConversations.ctxJson,
      updatedAt: factoryConversations.updatedAt,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, factoryRunId))
    .get();
  const checkpoint = asRecord(conversation?.ctxJson);
  let checkpointFingerprint: string | null = null;
  let checkpointOntologyHash: string | null = null;
  try {
    checkpointFingerprint = factoryGenerationDirectiveFingerprint(
      asRecord(checkpoint?.generationDirective) as unknown as
        | FactoryGenerationDirective
        | undefined,
    );
    const checkpointOntology = asRecord(checkpoint?.ontology);
    checkpointOntologyHash = checkpointOntology
      ? factorySourceOntologyHash(
          checkpointOntology as unknown as DomainOntology,
        )
      : null;
  } catch {
    checkpointFingerprint = null;
    checkpointOntologyHash = null;
  }
  if (
    !conversation ||
    conversation.tenantId !== context.job.tenantId ||
    conversation.domain !== context.project.domain ||
    !checkpoint ||
    nonEmptyString(checkpoint.domain) !== context.project.domain ||
    checkpointOntologyHash !== ontologyHash ||
    checkpointFingerprint !== factoryGenerationDirectiveFingerprint(directive)
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_conversation_stale",
      "The Factory conversation no longer matches the exact tenant, domain, Ontology, or generation directive",
      {
        ...baseDetails,
        sourceJobId,
        expectedOntologyHash: ontologyHash,
        checkpointOntologyHash,
      },
    );
  }

  const saveDraftEvents = factoryRun.transcript.filter((rawEvent) => {
    const event = asRecord(rawEvent);
    return event?.t === "tool.result" && event.name === "save_draft";
  });
  const saveDraftEvent = saveDraftEvents[0] as
    | Extract<BrainEvent, { t: "tool.result" }>
    | undefined;
  const draftCheckpoint =
    saveDraftEvents.length === 1 && saveDraftEvent
      ? compactFactoryDraftCheckpoint(saveDraftEvent)
      : null;
  if (draftCheckpoint?.schema === "agent-factory-draft-checkpoint/v1") {
    return factoryResumeRefusal(
      "factory_draft_recovery_lineage_missing",
      "The source save_draft checkpoint predates immutable version lineage; recovery will not guess from the current draft projection",
      {
        ...baseDetails,
        sourceJobId,
        saveDraftEventCount: saveDraftEvents.length,
      },
    );
  }
  if (
    !draftCheckpoint ||
    draftCheckpoint.scope !== "full" ||
    draftCheckpoint.persisted !== directive.requestedActionNames.length ||
    !sameUniqueStrings(
      draftCheckpoint.coveredAgents,
      directive.requestedActionNames,
    )
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_checkpoint_ambiguous",
      "The source transcript must contain exactly one successful full-scope generated-unverified save_draft checkpoint",
      {
        ...baseDetails,
        sourceJobId,
        saveDraftEventCount: saveDraftEvents.length,
        checkpointScope: draftCheckpoint?.scope ?? null,
        coveredAgents: draftCheckpoint?.coveredAgents ?? [],
      },
    );
  }

  const rawSpecs = Array.isArray(checkpoint.specs) ? checkpoint.specs : [];
  const capturedAgents = rawSpecs.flatMap((value) => {
    const captured = capturedFactoryAgent(value);
    return captured ? [captured] : [];
  });
  const capturedSlugs = capturedAgents.map((agent) => agent.slug);
  const capturedActionNames = capturedAgents.map((agent) => agent.actionName);
  const capturedSpecsFingerprint = specsFingerprint(
    rawSpecs as GeneratedAgentSpec[],
  );
  if (
    capturedAgents.length !== rawSpecs.length ||
    capturedAgents.length !== directive.requestedActionNames.length ||
    new Set(capturedSlugs).size !== capturedSlugs.length ||
    !sameUniqueStrings(capturedActionNames, directive.requestedActionNames) ||
    capturedAgents.some((agent) => !agent.generatedCode) ||
    capturedSpecsFingerprint !== draftCheckpoint.specsFingerprint
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_specs_mismatch",
      "The Factory conversation must contain exactly one generated-code spec per requested Action",
      {
        ...baseDetails,
        sourceJobId,
        requestedActionNames: [...directive.requestedActionNames],
        capturedActionNames,
        expectedSpecsFingerprint: draftCheckpoint.specsFingerprint,
        capturedSpecsFingerprint,
      },
    );
  }

  const loadInput: OntoCodeFactoryBuildInput = {
    jobId: context.job.id,
    attempt: context.attempt,
    operation: "build",
    tenantId: context.job.tenantId,
    tenantSlug: context.tenantSlug,
    domain: context.project.domain,
    ontologyDomainRegistrationId: context.project.ontologyDomainRegistrationId,
    runtimeProfileVersionId: context.job.runtimeProfileVersionId ?? null,
    goal: factoryRun.goal,
    actorId: context.job.createdBy,
    interactionPolicy:
      context.session.autonomyMode === "sandbox_autopilot"
        ? "autopilot"
        : "strict",
    directive,
    budget: context.job.budget,
    signal: context.signal,
    onProgress: (type, payload, visibility) =>
      context.progress(type, payload, visibility),
  };
  const durableAgents = await loadDurableFactoryAgents(
    loadInput,
    factoryRunId,
    capturedAgents,
    draftCheckpoint,
    true,
  );
  const draftVersionIds = durableAgents.flatMap((rawAgent) => {
    const agent = asRecord(rawAgent);
    const versionId = nonEmptyString(agent?.draftVersionId);
    return versionId ? [versionId] : [];
  });
  const durableActionNames = durableAgents.flatMap((rawAgent) => {
    const agent = asRecord(rawAgent);
    const spec = asRecord(agent?.spec);
    const actionName = nonEmptyString(spec?.actionName);
    const slug = nonEmptyString(spec?.slug);
    return actionName && slug ? [actionName] : [];
  });
  if (
    durableAgents.length !== capturedAgents.length ||
    draftVersionIds.length !== durableAgents.length ||
    new Set(draftVersionIds).size !== 1 ||
    draftVersionIds[0] !== draftCheckpoint.draftVersionId ||
    !sameUniqueStrings(durableActionNames, directive.requestedActionNames)
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_version_mismatch",
      "The durable Factory agents do not resolve to one common immutable draft version and exact Action scope",
      {
        ...baseDetails,
        sourceJobId,
        draftVersionIds,
        durableActionNames,
      },
    );
  }

  // Re-read both mutable projections after the filesystem lookup. Recovery
  // cannot package a checkpoint that changed while it was being inspected.
  const currentFactoryRun = getFactoryRun(factoryRunId, context.job.tenantId);
  const currentConversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      ctxJson: factoryConversations.ctxJson,
      updatedAt: factoryConversations.updatedAt,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, factoryRunId))
    .get();
  if (
    !currentFactoryRun ||
    currentFactoryRun.deletedAt !== null ||
    currentFactoryRun.status === "running" ||
    canonicalEvidenceJson(currentFactoryRun.transcript) !==
      canonicalEvidenceJson(factoryRun.transcript) ||
    !currentConversation ||
    currentConversation.tenantId !== conversation.tenantId ||
    currentConversation.domain !== conversation.domain ||
    currentConversation.updatedAt.getTime() !==
      conversation.updatedAt.getTime() ||
    canonicalEvidenceJson(currentConversation.ctxJson) !==
      canonicalEvidenceJson(conversation.ctxJson)
  ) {
    return factoryResumeRefusal(
      "factory_draft_recovery_drifted",
      "The Factory run or conversation changed while its durable draft was being recovered",
      { ...baseDetails, sourceJobId },
    );
  }

  const draftVersionId = draftVersionIds[0]!;
  const message = factoryDraftWaitingMessage(draftCheckpoint);
  return {
    outcome: "waiting_user",
    message,
    receipt: {
      factoryRunId,
      sourceFactoryRunId: factoryRunId,
      status: "drafted_unverified",
      completionKind: "incomplete",
      actionIds: [...directive.requestedActionIds],
      actionNames: [...directive.requestedActionNames],
      agents: durableAgents,
      draftVersionId,
      draftCheckpoint,
      verificationState: "generated_unverified",
      usage: {
        tokensUsed: factoryRun.tokensUsed,
        conversationTokensUsed: factoryRun.tokensUsed,
        turns: factoryRun.turns,
      },
      interaction: {
        kind: "execution_readiness",
        awaitingAnswer: true,
        question: message,
        options: [
          {
            label: "查看 generated-unverified Candidate",
            value: "review_generated_unverified_candidate",
            recommended: true,
          },
          {
            label: "配置后运行 Sandbox",
            value: "configure_and_run_sandbox",
          },
        ],
      },
      recovery: {
        schema: "ontocode-factory-draft-checkpoint-recovery/v1",
        sourceHarnessJobId: sourceJobId,
        sourceHarnessAttempt: sourceAttempt,
        restartedFactory: false,
      },
    },
  };
}

type FactoryStartOnlyRecovery = {
  sourceAttempt: number;
  reconnect: NonNullable<OntoCodeFactoryBuildInput["reconnect"]>;
};

/**
 * Recover the wider crash window where Factory was started but no
 * clarification/outcome row reached the Harness before its worker stopped.
 *
 * The detached Factory driver may already have been crash-resumed by API boot,
 * so opening `a<N+1>` is unsafe. Reconnect to the exact durable conversation
 * without re-enqueueing an answer. Only a fresh Build that crashed before its
 * first conversation checkpoint may restart from the immutable command, and
 * even then it reuses the same deterministic Factory run id.
 */
function resolveFactoryStartOnlyRecovery(
  context: OntoCodeHarnessExecutionContext,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
): FactoryStartOnlyRecovery | undefined {
  if (
    context.job.kind !== "build" ||
    context.attempt < 2 ||
    context.claim.previousStatus !== "retry_scheduled"
  ) {
    return undefined;
  }

  const db = getDb();
  const rows = db
    .select({
      seq: ontocodeSessionEvents.seq,
      type: ontocodeSessionEvents.type,
      payloadJson: ontocodeSessionEvents.payloadJson,
    })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
        eq(ontocodeSessionEvents.sessionId, context.session.id),
        eq(ontocodeSessionEvents.harnessJobId, context.job.id),
        inArray(ontocodeSessionEvents.type, [
          "harness.job.started",
          "harness.job.retry_scheduled",
          "harness.build.factory_started",
          "harness.build.clarification",
          "harness.build.waiting_user",
          "harness.build.completed",
        ]),
      ),
    )
    .orderBy(asc(ontocodeSessionEvents.seq))
    .all()
    .map((row) => ({ ...row, payload: parseEventPayload(row.payloadJson) }));
  const factoryStarts = rows.filter(
    (row) => row.type === "harness.build.factory_started",
  );
  const clarifications = rows.filter(
    (row) => row.type === "harness.build.clarification",
  );

  if (factoryStarts.length === 0 || clarifications.length > 0) {
    return undefined;
  }
  const baseDetails = {
    jobId: context.job.id,
    attempt: context.attempt,
    factoryStartCount: factoryStarts.length,
    clarificationCount: clarifications.length,
  };
  if (
    factoryStarts.length !== 1 ||
    rows.some(
      (row) =>
        row.type === "harness.build.waiting_user" ||
        row.type === "harness.build.completed",
    )
  ) {
    return factoryResumeRefusal(
      "factory_start_only_checkpoint_ambiguous",
      "The retry does not have one unfinalized Factory start-only checkpoint",
      baseDetails,
    );
  }

  const factoryStart = factoryStarts[0]!;
  const sourceStart = rows
    .filter(
      (row) => row.type === "harness.job.started" && row.seq < factoryStart.seq,
    )
    .at(-1);
  const sourceAttempt = Number(sourceStart?.payload?.attempt);
  const currentStarts = rows.filter(
    (row) =>
      row.type === "harness.job.started" &&
      row.payload?.attempt === context.attempt,
  );
  const retryBoundaries: Array<{
    attempt: number;
    startedSeq: number;
    retrySeq: number;
    errorCode: string;
  }> = [];
  if (Number.isSafeInteger(sourceAttempt)) {
    for (let attempt = sourceAttempt; attempt < context.attempt; attempt += 1) {
      const starts = rows.filter(
        (row) =>
          row.type === "harness.job.started" &&
          row.payload?.attempt === attempt,
      );
      const retries = rows.filter((row) => {
        if (
          row.type !== "harness.job.retry_scheduled" ||
          row.payload?.attempt !== attempt
        ) {
          return false;
        }
        const error = asRecord(row.payload?.error);
        return (
          error?.code === "worker_stopped" ||
          (error?.code === "operator_retry" &&
            error.recoverable === true &&
            error.retryable === true) ||
          (error?.code === "factory_build_incomplete" &&
            error.recoverable === true &&
            error.retryable === true)
        );
      });
      if (starts.length !== 1 || retries.length !== 1) break;
      retryBoundaries.push({
        attempt,
        startedSeq: starts[0]!.seq,
        retrySeq: retries[0]!.seq,
        errorCode: String(asRecord(retries[0]!.payload?.error)?.code),
      });
    }
  }
  const exactRetryChain =
    Number.isSafeInteger(sourceAttempt) &&
    sourceAttempt >= 1 &&
    sourceAttempt < context.attempt &&
    retryBoundaries.length === context.attempt - sourceAttempt &&
    retryBoundaries.every((entry, index) => {
      const priorBoundary =
        index === 0
          ? Number.NEGATIVE_INFINITY
          : retryBoundaries[index - 1]!.retrySeq;
      return (
        priorBoundary < entry.startedSeq && entry.startedSeq < entry.retrySeq
      );
    }) &&
    Boolean(sourceStart) &&
    currentStarts.length === 1 &&
    sourceStart!.seq < factoryStart.seq &&
    factoryStart.seq < retryBoundaries[0]!.retrySeq &&
    retryBoundaries.at(-1)!.retrySeq < currentStarts[0]!.seq;
  if (!exactRetryChain) {
    return factoryResumeRefusal(
      "factory_start_only_checkpoint_attempt_mismatch",
      "The Factory start-only checkpoint is not bounded by an exact recoverable retry chain",
      {
        ...baseDetails,
        sourceAttempt: Number.isSafeInteger(sourceAttempt)
          ? sourceAttempt
          : null,
        retryBoundaries: retryBoundaries.map((entry) => ({
          attempt: entry.attempt,
          errorCode: entry.errorCode,
        })),
      },
    );
  }

  const started = factoryStart.payload;
  const resumeWaitingUserJobId = nonEmptyString(
    context.command?.arguments.resumeWaitingUserJobId,
  );
  const startedParent = nonEmptyString(started?.resumedFromWaitingJobId);
  const checkpointedAgentCount = Number(started?.checkpointedAgentCount);
  const factoryRunId =
    nonEmptyString(started?.factoryRunId) ??
    (!resumeWaitingUserJobId
      ? `ocf-${context.job.id}-a${String(sourceAttempt)}`
      : null);
  if (
    !context.command ||
    !started ||
    (nonEmptyString(started.jobId) !== null &&
      started.jobId !== context.job.id) ||
    started.ontologyHash !== ontologyHash ||
    started.mode !== directive.mode ||
    !exactOrderedStrings(started.actionIds, directive.requestedActionIds) ||
    !exactOrderedStrings(started.actionNames, directive.requestedActionNames) ||
    startedParent !== resumeWaitingUserJobId ||
    (resumeWaitingUserJobId !== null &&
      !nonEmptyString(context.command.arguments.clarificationAnswer)) ||
    !factoryRunId ||
    !Number.isSafeInteger(checkpointedAgentCount) ||
    checkpointedAgentCount < 0
  ) {
    return factoryResumeRefusal(
      "factory_start_only_checkpoint_scope_mismatch",
      "The Factory start-only checkpoint is not bound to this exact Build scope",
      {
        ...baseDetails,
        sourceAttempt,
        factoryRunId,
        expectedWaitingJobId: resumeWaitingUserJobId ?? null,
        actualWaitingJobId: startedParent ?? null,
      },
    );
  }

  const factoryRun = getFactoryRun(factoryRunId, context.job.tenantId);
  const conversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      ctxJson: factoryConversations.ctxJson,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, factoryRunId))
    .get();
  const checkpoint = asRecord(conversation?.ctxJson);

  // Before the first conversation save, an in-process Factory driver is still
  // authoritative and can be observed directly. If no driver survived, only
  // a fresh Build may restart from its immutable command. A continuation may
  // already have consumed its one-shot answer, so reconstructing that command
  // would risk duplicate delivery.
  if (!conversation) {
    if (resumeWaitingUserJobId) {
      return factoryResumeRefusal(
        "factory_start_only_checkpoint_missing",
        "The interrupted Factory continuation has no durable conversation checkpoint",
        { ...baseDetails, sourceAttempt, factoryRunId },
      );
    }
    if (factoryRun && isActiveRun(factoryRunId)) {
      return {
        sourceAttempt,
        reconnect: {
          mode: "reattach",
          factoryRunId,
          persistGoal: factoryRun.goal,
          capturedAgents: [],
        },
      };
    }
    abortRun(factoryRunId, context.job.tenantId);
    return {
      sourceAttempt,
      reconnect: {
        mode: "restart_from_command",
        factoryRunId,
        persistGoal: factoryBuildGoal(
          directive,
          context.session.goal,
          context.command,
        ),
        capturedAgents: [],
      },
    };
  }
  if (!factoryRun || !checkpoint) {
    return factoryResumeRefusal(
      "factory_start_only_checkpoint_invalid",
      "The interrupted Factory conversation exists without a valid matching run checkpoint",
      { ...baseDetails, sourceAttempt, factoryRunId },
    );
  }

  let checkpointFingerprint: string | null = null;
  try {
    checkpointFingerprint = factoryGenerationDirectiveFingerprint(
      asRecord(checkpoint.generationDirective) as unknown as
        | FactoryGenerationDirective
        | undefined,
    );
  } catch {
    checkpointFingerprint = null;
  }
  if (
    factoryRun.deletedAt !== null ||
    factoryRun.domain !== context.project.domain ||
    (factoryRun.ontologyDomainRegistrationId ?? null) !==
      (context.project.ontologyDomainRegistrationId ?? null) ||
    (factoryRun.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null) ||
    conversation.tenantId !== context.job.tenantId ||
    conversation.domain !== context.project.domain ||
    checkpointFingerprint !== factoryGenerationDirectiveFingerprint(directive)
  ) {
    return factoryResumeRefusal(
      "factory_start_only_checkpoint_stale",
      "The interrupted Factory run or conversation no longer matches the immutable Build bindings",
      {
        ...baseDetails,
        sourceAttempt,
        factoryRunId,
        factoryRunStatus: factoryRun.status,
      },
    );
  }
  if (factoryRun.status === "done") {
    return factoryResumeRefusal(
      "factory_start_only_terminal_without_delivery",
      "The interrupted Factory run is already terminal but has no recoverable durable draft",
      { ...baseDetails, sourceAttempt, factoryRunId },
    );
  }

  const rawSpecs = Array.isArray(checkpoint.specs) ? checkpoint.specs : [];
  const capturedAgents = rawSpecs.flatMap((value) => {
    const captured = capturedFactoryAgent(value);
    return captured ? [captured] : [];
  });
  const identities = capturedAgents.map(
    (agent) => `${agent.slug}\u0000${agent.actionName}`,
  );
  if (
    capturedAgents.length !== rawSpecs.length ||
    capturedAgents.length < checkpointedAgentCount ||
    new Set(identities).size !== identities.length ||
    new Set(capturedAgents.map((agent) => agent.slug)).size !==
      capturedAgents.length ||
    new Set(capturedAgents.map((agent) => agent.actionName)).size !==
      capturedAgents.length ||
    capturedAgents.some(
      (agent) => !directive.requestedActionNames.includes(agent.actionName),
    )
  ) {
    return factoryResumeRefusal(
      "factory_start_only_checkpoint_agents_mismatch",
      "The interrupted Factory checkpoint contains ambiguous or out-of-scope Agent previews",
      {
        ...baseDetails,
        sourceAttempt,
        factoryRunId,
        rawSpecCount: rawSpecs.length,
        capturedAgentCount: capturedAgents.length,
      },
    );
  }

  return {
    sourceAttempt,
    reconnect: {
      mode: "reattach",
      factoryRunId,
      persistGoal: factoryRun.goal,
      capturedAgents,
    },
  };
}

/**
 * Reconcile an exact durable human gate into OntoCode's waiting state.
 *
 * Two protocols share the immutable checkpoint validation below but retain
 * distinct attempt boundaries: (1) an answered follow-up interrupted by a
 * worker stop, and (2) the historical final-turn defect that mislabeled a
 * newly-opened gate as turns_exhausted before an operator retried the same
 * OntoCode Job. The latter never replays an answer or restarts generation.
 */
function resolveFactoryWaitingCheckpointRecovery(
  context: OntoCodeHarnessExecutionContext,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
): OntoCodeFactoryBuildResult | undefined {
  if (
    context.job.kind !== "build" ||
    context.attempt < 2 ||
    context.claim.previousStatus !== "retry_scheduled"
  ) {
    return undefined;
  }

  const resumeWaitingUserJobId = nonEmptyString(
    context.command?.arguments.resumeWaitingUserJobId,
  );
  const clarificationAnswer = nonEmptyString(
    context.command?.arguments.clarificationAnswer,
  );
  // Keep the two recovery protocols distinct. A follow-up Build has already
  // delivered an answer and may only cross the worker-stopped crash boundary.
  // A same-Job operator retry carries no answer; it is admitted solely for the
  // historical final-turn defect where an exact durable gate was mislabeled
  // as turns_exhausted/incomplete.
  const recoveryMode =
    resumeWaitingUserJobId && clarificationAnswer
      ? "answered_gate_worker_crash"
      : !resumeWaitingUserJobId && !clarificationAnswer
        ? "legacy_final_turn_gate"
        : null;
  if (!recoveryMode) return undefined;

  const db = getDb();
  const checkpointRows = db
    .select({
      seq: ontocodeSessionEvents.seq,
      type: ontocodeSessionEvents.type,
      payloadJson: ontocodeSessionEvents.payloadJson,
    })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
        eq(ontocodeSessionEvents.sessionId, context.session.id),
        eq(ontocodeSessionEvents.harnessJobId, context.job.id),
        inArray(ontocodeSessionEvents.type, [
          "harness.job.started",
          "harness.job.retry_scheduled",
          "harness.job.failed",
          "harness.build.factory_started",
          "harness.build.clarification",
          "harness.build.waiting_user",
          "harness.build.completed",
        ]),
      ),
    )
    .orderBy(asc(ontocodeSessionEvents.seq))
    .all()
    .map((row) => ({ ...row, payload: parseEventPayload(row.payloadJson) }));
  const factoryStarts = checkpointRows.filter(
    (row) => row.type === "harness.build.factory_started",
  );
  const clarifications = checkpointRows.filter(
    (row) => row.type === "harness.build.clarification",
  );

  // A start-only interruption belongs to the separate reconnect path. This
  // reconciler owns only an observed, durable human gate.
  if (clarifications.length === 0) {
    return undefined;
  }
  const baseDetails = {
    jobId: context.job.id,
    attempt: context.attempt,
    factoryStartCount: factoryStarts.length,
    clarificationCount: clarifications.length,
  };
  if (
    factoryStarts.length !== 1 ||
    clarifications.length !== 1 ||
    checkpointRows.some(
      (row) =>
        row.type === "harness.build.waiting_user" ||
        row.type === "harness.build.completed",
    )
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_ambiguous",
      "The retry does not have one unfinalized Factory-start/clarification checkpoint",
      baseDetails,
    );
  }

  const factoryStartRow = factoryStarts[0]!;
  const clarificationRow = clarifications[0]!;
  const checkpointStartCandidates = checkpointRows.filter(
    (row) =>
      row.type === "harness.job.started" && row.seq < factoryStartRow.seq,
  );
  const checkpointStart = checkpointStartCandidates.at(-1);
  const checkpointAttempt = Number(checkpointStart?.payload?.attempt);
  const checkpointStarts = checkpointRows.filter(
    (row) =>
      row.type === "harness.job.started" &&
      row.payload?.attempt === checkpointAttempt,
  );
  const currentStarts = checkpointRows.filter(
    (row) =>
      row.type === "harness.job.started" &&
      row.payload?.attempt === context.attempt,
  );
  const workerStops = checkpointRows.filter((row) => {
    if (row.type !== "harness.job.retry_scheduled") return false;
    const error = asRecord(row.payload?.error);
    return (
      row.payload?.attempt === checkpointAttempt &&
      error?.code === "worker_stopped"
    );
  });
  const operatorRetries = checkpointRows.filter((row) => {
    if (row.type !== "harness.job.retry_scheduled") return false;
    const error = asRecord(row.payload?.error);
    return (
      error?.code === "operator_retry" &&
      error.recoverable === true &&
      error.retryable === true
    );
  });
  const originalLegacyFailures = checkpointRows.filter((row) => {
    if (row.type !== "harness.job.failed") return false;
    const error = asRecord(row.payload?.error);
    const details = asRecord(error?.details);
    return (
      row.payload?.attempt === checkpointAttempt &&
      row.payload?.status === "failed_recoverable" &&
      error?.code === "factory_build_incomplete" &&
      error.recoverable === true &&
      error.retryable === false &&
      details?.status === "turns_exhausted" &&
      details.completionKind === "incomplete"
    );
  });
  const checkpointRetryBoundaries =
    recoveryMode === "answered_gate_worker_crash"
      ? workerStops
      : operatorRetries.filter(
          (row) => row.payload?.attempt === checkpointAttempt,
        );
  const upgradeFailureCodes = new Set([
    "factory_resume_run_stale",
    "factory_waiting_checkpoint_run_stale",
    "factory_waiting_checkpoint_options_mismatch",
    // One deployed worker consumed an attempt by applying the crash-only
    // guard to this legacy final-turn chain. Treat only that exact migration
    // refusal as an intermediate upgrade failure.
    "factory_waiting_checkpoint_attempt_mismatch",
  ]);
  const intermediateAttempts = Number.isSafeInteger(checkpointAttempt)
    ? Array.from(
        {
          length: Math.max(0, context.attempt - checkpointAttempt - 1),
        },
        (_unused, index) => checkpointAttempt + index + 1,
      )
    : [];
  let priorBoundarySeq = checkpointRetryBoundaries[0]?.seq ?? -1;
  const invalidUpgradeAttempt = intermediateAttempts.find((attempt) => {
    const starts = checkpointRows.filter(
      (row) =>
        row.type === "harness.job.started" && row.payload?.attempt === attempt,
    );
    const failures = checkpointRows.filter((row) => {
      if (row.type !== "harness.job.failed") return false;
      const error = asRecord(row.payload?.error);
      return (
        row.payload?.attempt === attempt &&
        row.payload?.status === "failed_recoverable" &&
        typeof error?.code === "string" &&
        upgradeFailureCodes.has(error.code)
      );
    });
    const retries = operatorRetries.filter(
      (row) => row.payload?.attempt === attempt,
    );
    const valid =
      starts.length === 1 &&
      failures.length === 1 &&
      priorBoundarySeq < starts[0]!.seq &&
      starts[0]!.seq < failures[0]!.seq &&
      (recoveryMode === "answered_gate_worker_crash" ||
        (retries.length === 1 && failures[0]!.seq < retries[0]!.seq));
    if (valid) {
      priorBoundarySeq =
        recoveryMode === "answered_gate_worker_crash"
          ? failures[0]!.seq
          : retries[0]!.seq;
    }
    return !valid;
  });
  const suffixRows = Number.isSafeInteger(checkpointAttempt)
    ? checkpointRows.filter(
        (row) =>
          row.seq >
            (checkpointRetryBoundaries[0]?.seq ?? Number.MAX_SAFE_INTEGER) &&
          row.seq < (currentStarts[0]?.seq ?? -1) &&
          (row.type === "harness.job.started" ||
            row.type === "harness.job.failed" ||
            (recoveryMode === "legacy_final_turn_gate" &&
              row.type === "harness.job.retry_scheduled")),
      )
    : [];
  const expectedSuffixRows =
    intermediateAttempts.length *
    (recoveryMode === "legacy_final_turn_gate" ? 3 : 2);
  const originalLegacyFailure = originalLegacyFailures[0];
  if (
    !Number.isSafeInteger(checkpointAttempt) ||
    checkpointAttempt < 1 ||
    checkpointAttempt >= context.attempt ||
    checkpointStarts.length !== 1 ||
    currentStarts.length !== 1 ||
    checkpointRetryBoundaries.length !== 1 ||
    (recoveryMode === "legacy_final_turn_gate" &&
      originalLegacyFailures.length !== 1) ||
    invalidUpgradeAttempt !== undefined ||
    suffixRows.length !== expectedSuffixRows ||
    !checkpointStart?.payload ||
    !currentStarts[0]!.payload ||
    !factoryStartRow.payload ||
    !clarificationRow.payload ||
    !(
      checkpointStart.seq < factoryStartRow.seq &&
      factoryStartRow.seq < clarificationRow.seq &&
      (recoveryMode === "answered_gate_worker_crash"
        ? clarificationRow.seq < checkpointRetryBoundaries[0]!.seq
        : clarificationRow.seq < originalLegacyFailure!.seq &&
          originalLegacyFailure!.seq < checkpointRetryBoundaries[0]!.seq) &&
      priorBoundarySeq < currentStarts[0]!.seq
    )
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_attempt_mismatch",
      recoveryMode === "answered_gate_worker_crash"
        ? "The internal waiting checkpoint is not bounded by one exact worker-stopped retry attempt"
        : "The historical final-turn gate is not bounded by one exact failed-Build/operator-retry chain",
      {
        ...baseDetails,
        checkpointAttempt: Number.isSafeInteger(checkpointAttempt)
          ? checkpointAttempt
          : null,
        checkpointStartedCount: checkpointStarts.length,
        currentStartedCount: currentStarts.length,
        workerStoppedCount: workerStops.length,
        operatorRetryCount: operatorRetries.length,
        originalLegacyFailureCount: originalLegacyFailures.length,
        recoveryMode,
        invalidUpgradeAttempt: invalidUpgradeAttempt ?? null,
      },
    );
  }

  const started = factoryStartRow.payload;
  const clarification = clarificationRow.payload;
  const factoryRunId = nonEmptyString(started.factoryRunId);
  const checkpointedAgentCount = Number(started.checkpointedAgentCount);
  if (
    !context.command ||
    (recoveryMode === "answered_gate_worker_crash" &&
      (!resumeWaitingUserJobId || !clarificationAnswer)) ||
    started.jobId !== context.job.id ||
    started.ontologyHash !== ontologyHash ||
    started.mode !== directive.mode ||
    !exactOrderedStrings(started.actionIds, directive.requestedActionIds) ||
    !exactOrderedStrings(started.actionNames, directive.requestedActionNames) ||
    (recoveryMode === "legacy_final_turn_gate" &&
      (started.attempt !== checkpointAttempt ||
        factoryRunId !==
          `ocf-${context.job.id}-a${String(checkpointAttempt)}`)) ||
    (recoveryMode === "answered_gate_worker_crash"
      ? started.resumedFromWaitingJobId !== resumeWaitingUserJobId
      : started.resumedFromWaitingJobId !== null &&
        started.resumedFromWaitingJobId !== undefined) ||
    !factoryRunId ||
    !Number.isSafeInteger(checkpointedAgentCount) ||
    checkpointedAgentCount < 0 ||
    clarification.jobId !== context.job.id ||
    clarification.factoryRunId !== factoryRunId ||
    clarification.kind !== "clarify" ||
    clarification.awaitingAnswer !== true
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_scope_mismatch",
      "The persisted Factory waiting checkpoint is not bound to this exact follow-up Build scope",
      {
        ...baseDetails,
        factoryRunId,
        expectedOntologyHash: ontologyHash,
        actualOntologyHash: started.ontologyHash ?? null,
        expectedWaitingJobId:
          recoveryMode === "answered_gate_worker_crash"
            ? resumeWaitingUserJobId
            : null,
        actualWaitingJobId: started.resumedFromWaitingJobId ?? null,
      },
    );
  }

  const factoryRun = getFactoryRun(factoryRunId, context.job.tenantId);
  const runClarifications = Array.isArray(factoryRun?.transcript)
    ? factoryRun.transcript.filter((event) => asRecord(event)?.t === "clarify")
    : [];
  const terminalDone = Array.isArray(factoryRun?.transcript)
    ? factoryRun.transcript
        .filter((event) => asRecord(event)?.t === "done")
        .map(asRecord)
        .at(-1)
    : null;
  const legacyFailedAtDurableGate = Boolean(
    recoveryMode === "legacy_final_turn_gate" &&
    factoryRun?.status === "failed" &&
    terminalDone?.status === "turns_exhausted" &&
    terminalDone.completionKind === "incomplete",
  );
  if (
    !factoryRun ||
    factoryRun.deletedAt !== null ||
    (factoryRun.status !== "waiting_human" && !legacyFailedAtDurableGate) ||
    factoryRun.domain !== context.project.domain ||
    (factoryRun.ontologyDomainRegistrationId ?? null) !==
      (context.project.ontologyDomainRegistrationId ?? null) ||
    (factoryRun.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null)
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_run_stale",
      "The internal generation run is not parked at the exact durable human gate",
      {
        ...baseDetails,
        factoryRunId,
        factoryRunStatus: factoryRun?.status ?? null,
        runClarificationCount: runClarifications.length,
      },
    );
  }

  const conversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      ctxJson: factoryConversations.ctxJson,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, factoryRunId))
    .get();
  const checkpoint = asRecord(conversation?.ctxJson);
  let checkpointFingerprint: string | null = null;
  try {
    checkpointFingerprint = factoryGenerationDirectiveFingerprint(
      asRecord(checkpoint?.generationDirective) as unknown as
        | FactoryGenerationDirective
        | undefined,
    );
  } catch {
    checkpointFingerprint = null;
  }
  if (
    !conversation ||
    conversation.tenantId !== context.job.tenantId ||
    conversation.domain !== context.project.domain ||
    !checkpoint ||
    checkpointFingerprint !== factoryGenerationDirectiveFingerprint(directive)
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_conversation_stale",
      "The Factory conversation checkpoint does not match this tenant, domain, or immutable generation directive",
      { ...baseDetails, factoryRunId },
    );
  }

  const interaction = activeHumanInteraction(
    checkpoint as Parameters<typeof activeHumanInteraction>[0],
  );
  const interactionId = nonEmptyString(clarification.interactionId);
  const question = nonEmptyString(clarification.question);
  const clarificationContext =
    clarification.context === null
      ? null
      : nonEmptyString(clarification.context);
  const options = exactClarificationOptions(clarification.options);
  const items = exactClarificationItems(clarification.items);
  const prompt = asRecord(checkpoint.clarifyPrompt);
  const promptQuestion = nonEmptyString(prompt?.question);
  const promptContext =
    prompt?.context === undefined ? null : nonEmptyString(prompt.context);
  const promptOptions =
    prompt?.options === undefined
      ? []
      : exactClarificationOptions(prompt.options);
  const promptItems =
    prompt?.items === undefined ? [] : exactClarificationItems(prompt.items);
  const normalizedEventPrompt =
    question && options && items
      ? {
          question,
          context: clarificationContext,
          options,
          items,
        }
      : null;
  const normalizedCheckpointPrompt =
    promptQuestion && promptOptions && promptItems
      ? {
          question: promptQuestion,
          context: promptContext,
          options: promptOptions,
          items: promptItems,
        }
      : null;
  const interactionMatchesPrompt =
    normalizedCheckpointPrompt &&
    interaction &&
    humanInteractionMatchesSubject(interaction, "clarify", {
      question: normalizedCheckpointPrompt.question,
      context: normalizedCheckpointPrompt.context,
      options:
        prompt?.options === undefined
          ? null
          : normalizedCheckpointPrompt.options,
    });
  if (
    checkpoint.awaitingClarify !== true ||
    !interaction ||
    interaction.kind !== "clarify" ||
    !interactionId ||
    interaction.interactionId !== interactionId ||
    !normalizedEventPrompt ||
    !normalizedCheckpointPrompt ||
    canonicalEvidenceJson(normalizedEventPrompt) !==
      canonicalEvidenceJson(normalizedCheckpointPrompt) ||
    !interactionMatchesPrompt
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_interaction_mismatch",
      "The Factory conversation's active interaction no longer matches the exact persisted clarification",
      {
        ...baseDetails,
        factoryRunId,
        eventInteractionId: interactionId,
        checkpointInteractionId: interaction?.interactionId ?? null,
      },
    );
  }
  const exactEventPrompt = normalizedEventPrompt;

  // The boot recovery's atomic settlement intentionally does not synthesize a
  // `done` frame and may run before the 5s transcript mirror catches the
  // clarification. The status transition plus the conversation checkpoint are
  // authoritative. If a clarification did reach the optional transcript
  // mirror, however, it must agree with that checkpoint rather than weakening
  // it.
  if (runClarifications.length > 0) {
    const runClarification = asRecord(runClarifications.at(-1));
    const runInteractionId = nonEmptyString(runClarification?.interactionId);
    const runQuestion = nonEmptyString(runClarification?.question);
    const runContext =
      runClarification?.context === undefined
        ? null
        : nonEmptyString(runClarification.context);
    const runOptions =
      runClarification?.options === undefined
        ? []
        : exactClarificationOptions(runClarification.options);
    const runItems =
      runClarification?.items === undefined
        ? []
        : exactClarificationItems(runClarification.items);
    if (
      runInteractionId !== interactionId ||
      !runQuestion ||
      !runOptions ||
      !runItems ||
      canonicalEvidenceJson({
        question: runQuestion,
        context: runContext,
        options: runOptions,
        items: runItems,
      }) !== canonicalEvidenceJson(exactEventPrompt)
    ) {
      return factoryResumeRefusal(
        "factory_waiting_checkpoint_run_interaction_mismatch",
        "The mirrored Factory clarification and Harness checkpoint name different human gates",
        { ...baseDetails, factoryRunId, runInteractionId, interactionId },
      );
    }
  }

  const eventOptionValues = exactEventPrompt.options.map(
    (option) => option.value,
  );
  const pendingSelection = asRecord(checkpoint.pendingIntegrationSelectionAsk);
  let checkpointOntologyHash: string | null = null;
  try {
    const checkpointOntology = asRecord(checkpoint.ontology);
    checkpointOntologyHash = checkpointOntology
      ? ontologyContentHash(checkpointOntology as unknown as DomainOntology)
      : null;
  } catch {
    checkpointOntologyHash = null;
  }
  const rawPendingSelectionOptions = Array.isArray(pendingSelection?.options)
    ? pendingSelection.options
    : [];
  const pendingSelectionOptions = rawPendingSelectionOptions.length
    ? rawPendingSelectionOptions.flatMap((value) => {
        const option = asRecord(value);
        const token = nonEmptyString(option?.token);
        const requirementId = nonEmptyString(option?.requirementId);
        const bindingId = nonEmptyString(option?.bindingId);
        const bindingKind =
          option?.bindingKind === "tool" ||
          option?.bindingKind === "capability_provider"
            ? option.bindingKind
            : null;
        return token && requirementId && bindingId && bindingKind
          ? [{ token, requirementId, bindingId, bindingKind }]
          : [];
      })
    : [];
  const hasIntegrationSelectionTokens = eventOptionValues.some((value) =>
    value.startsWith("integration-selection:v1:"),
  );
  if (
    (pendingSelection &&
      (pendingSelection.ontologyHash !== checkpointOntologyHash ||
        checkpointOntologyHash === null ||
        !directive.requestedActionNames.includes(
          nonEmptyString(pendingSelection.actionName) ?? "",
        ) ||
        pendingSelectionOptions.length !== rawPendingSelectionOptions.length ||
        !exactOrderedStrings(
          eventOptionValues,
          pendingSelectionOptions.map((option) => option.token),
        ))) ||
    (hasIntegrationSelectionTokens && !pendingSelection)
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_options_mismatch",
      "The persisted clarification options no longer match the server-owned integration choices",
      { ...baseDetails, factoryRunId },
    );
  }

  const rawSpecs = Array.isArray(checkpoint.specs) ? checkpoint.specs : [];
  const checkpointAgents = rawSpecs.flatMap((value) => {
    const captured = capturedFactoryAgent(value);
    return captured ? [captured] : [];
  });
  const checkpointKeys = checkpointAgents.map(
    (agent) => `${agent.slug}\u0000${agent.actionName}`,
  );
  if (
    checkpointAgents.length !== rawSpecs.length ||
    (recoveryMode === "answered_gate_worker_crash" &&
      checkpointAgents.length !== checkpointedAgentCount) ||
    new Set(checkpointKeys).size !== checkpointKeys.length ||
    checkpointAgents.some(
      (agent) =>
        !directive.requestedActionNames.includes(agent.actionName) ||
        !agent.generatedCode,
    )
  ) {
    return factoryResumeRefusal(
      "factory_waiting_checkpoint_agents_mismatch",
      "The Factory checkpoint no longer contains the exact generated Agent previews recorded at resume",
      {
        ...baseDetails,
        factoryRunId,
        checkpointedAgentCount,
        actualAgentCount: checkpointAgents.length,
      },
    );
  }

  if (legacyFailedAtDurableGate) {
    // Compatibility for the deployed final-turn defect only. The checks above
    // bind the OntoCode Job, immutable scope, engine run, conversation,
    // terminal verdict, interaction digest and every generated preview. Once
    // all of them agree, repair the private engine projection with a CAS. No
    // model is called, no answer is replayed, and no new engine run is made.
    const normalized = db
      .update(factoryRuns)
      .set({
        status: "waiting_human",
        reachedTerminal: false,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(factoryRuns.id, factoryRunId),
          eq(factoryRuns.tenantId, context.job.tenantId),
          eq(factoryRuns.status, "failed"),
          isNull(factoryRuns.deletedAt),
        ),
      )
      .run() as { changes?: number };
    if ((normalized.changes ?? 0) !== 1) {
      const currentRun = getFactoryRun(factoryRunId, context.job.tenantId);
      if (currentRun?.status !== "waiting_human") {
        return factoryResumeRefusal(
          "factory_waiting_checkpoint_run_changed",
          "The internal generation checkpoint changed before OntoCode could reconcile its waiting state",
          {
            ...baseDetails,
            factoryRunId,
            currentStatus: currentRun?.status ?? null,
          },
        );
      }
    }
  }

  const recoveredInteraction = {
    kind: "clarify",
    awaitingAnswer: true,
    interactionId,
    question: exactEventPrompt.question,
    options: exactEventPrompt.options,
    items: exactEventPrompt.items,
    context: exactEventPrompt.context,
  };
  const message = clarificationAssistantText({
    t: "clarify",
    question: exactEventPrompt.question,
    ...(exactEventPrompt.context ? { context: exactEventPrompt.context } : {}),
    ...(exactEventPrompt.options.length > 0
      ? { options: exactEventPrompt.options }
      : {}),
    ...(exactEventPrompt.items.length > 0
      ? { items: exactEventPrompt.items }
      : {}),
    awaitingAnswer: true,
    interactionId,
  });
  return {
    outcome: "waiting_user",
    message,
    receipt: {
      factoryRunId,
      status: "waiting_human",
      completionKind: factoryRun.completionKind,
      actionIds: [...directive.requestedActionIds],
      actionNames: [...directive.requestedActionNames],
      agents: [],
      agentPreviews: checkpointAgents.map((agent) => ({
        slug: agent.slug,
        actionName: agent.actionName,
        name: agent.name,
        card: { ...agent.card },
        design: agent.design ? { ...agent.design } : null,
        generatedCode: agent.generatedCode,
      })),
      candidateEligibility: "non_candidate_preview",
      interaction: recoveredInteraction,
      usage: {
        tokensUsed: factoryRun.tokensUsed,
        conversationTokensUsed: factoryRun.tokensUsed,
        turns: factoryRun.turns,
      },
      recovery: {
        schema:
          recoveryMode === "legacy_final_turn_gate"
            ? "ontocode-build-final-turn-gate-reconciliation/v1"
            : "ontocode-factory-waiting-checkpoint-recovery/v1",
        mode: recoveryMode,
        recoveredAttempt: checkpointAttempt,
        finalizedAttempt: context.attempt,
        replayedHumanAnswer: false,
      },
    },
  };
}

/**
 * Reconstruct a continuation only from an exact server-authored waiting chain.
 *
 * The new Harness Job remains a separate audit record, while the Factory
 * conversation is resumed under the old run id. Every mutable identity is
 * cross-checked before the human answer is allowed near the Factory mailbox:
 * the input-resolution event, old waiting receipt, Ontology hash/scope,
 * registration/runtime pins, run row, conversation gate, and checkpointed
 * specs must all agree. A missing or duplicate link fails closed.
 */
function resolveFactoryBuildResume(
  context: OntoCodeHarnessExecutionContext,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
): OntoCodeFactoryBuildResume | undefined {
  const resumeWaitingUserJobId = nonEmptyString(
    context.command?.arguments.resumeWaitingUserJobId,
  );
  if (!resumeWaitingUserJobId) return undefined;
  const baseDetails = {
    waitingJobId: resumeWaitingUserJobId,
    followUpJobId: context.job.id,
  };
  if (
    !context.command ||
    context.job.kind !== "build" ||
    resumeWaitingUserJobId === context.job.id
  ) {
    return factoryResumeRefusal(
      "factory_resume_invalid_target",
      "A Factory continuation must reference a different waiting Build Job",
      baseDetails,
    );
  }
  const answer = nonEmptyString(context.command.arguments.clarificationAnswer);
  if (!answer) {
    return factoryResumeRefusal(
      "factory_resume_answer_required",
      "The follow-up Build does not contain an exact clarification answer",
      baseDetails,
    );
  }

  const db = getDb();
  const waitingJob = db
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
        eq(ontocodeHarnessJobs.sessionId, context.session.id),
        eq(ontocodeHarnessJobs.id, resumeWaitingUserJobId),
      ),
    )
    .get();
  if (
    !waitingJob ||
    waitingJob.kind !== "build" ||
    waitingJob.status !== "cancelled" ||
    !waitingJob.finishedAt ||
    waitingJob.createdAt.getTime() >= context.job.createdAt ||
    (waitingJob.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null)
  ) {
    return factoryResumeRefusal(
      "factory_resume_waiting_job_stale",
      "The referenced waiting Build is missing, stale, or pinned to a different Runtime Profile",
      {
        ...baseDetails,
        waitingStatus: waitingJob?.status ?? null,
        waitingKind: waitingJob?.kind ?? null,
      },
    );
  }

  const resolutionRows = db
    .select({
      payloadJson: ontocodeSessionEvents.payloadJson,
    })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
        eq(ontocodeSessionEvents.sessionId, context.session.id),
        eq(ontocodeSessionEvents.type, "harness.job.input_resolved"),
      ),
    )
    .all()
    .flatMap((row) => {
      const payload = parseEventPayload(row.payloadJson);
      return payload?.waitingJobId === resumeWaitingUserJobId ? [payload] : [];
    });
  if (
    resolutionRows.length !== 1 ||
    resolutionRows[0]?.followUpJobId !== context.job.id
  ) {
    return factoryResumeRefusal(
      "factory_resume_resolution_ambiguous",
      "The waiting Build does not have one exact input-resolution audit link to this follow-up Job",
      {
        ...baseDetails,
        resolutionCount: resolutionRows.length,
        resolvedFollowUpJobIds: resolutionRows.map(
          (payload) => payload.followUpJobId ?? null,
        ),
      },
    );
  }

  const waitingEvents = db
    .select({
      payloadJson: ontocodeSessionEvents.payloadJson,
    })
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
        eq(ontocodeSessionEvents.sessionId, context.session.id),
        eq(ontocodeSessionEvents.harnessJobId, resumeWaitingUserJobId),
        eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
      ),
    )
    .all();
  if (waitingEvents.length !== 1) {
    return factoryResumeRefusal(
      "factory_resume_receipt_ambiguous",
      "The referenced Build must have exactly one durable waiting receipt",
      { ...baseDetails, waitingReceiptCount: waitingEvents.length },
    );
  }
  const waitingPayload = parseEventPayload(waitingEvents[0]!.payloadJson);
  const priorReceipt = asRecord(waitingPayload?.receipt);
  const priorScope = asRecord(priorReceipt?.scope);
  const priorAttempt = waitingPayload?.attempt;
  if (
    waitingPayload?.jobId !== resumeWaitingUserJobId ||
    waitingPayload?.kind !== "build" ||
    priorReceipt?.schema !== "ontocode-build-receipt/v1" ||
    priorReceipt.ontologyHash !== ontologyHash ||
    !Number.isSafeInteger(priorAttempt) ||
    Number(priorAttempt) < 1 ||
    !sameUniqueStrings(stringList(priorScope?.actionIds), [
      ...directive.requestedActionIds,
    ]) ||
    !sameUniqueStrings(stringList(priorScope?.actionNames), [
      ...directive.requestedActionNames,
    ])
  ) {
    return factoryResumeRefusal(
      "factory_resume_receipt_stale",
      "The waiting receipt is not bound to this exact Ontology snapshot and generation scope",
      {
        ...baseDetails,
        expectedOntologyHash: ontologyHash,
        receiptOntologyHash: priorReceipt?.ontologyHash ?? null,
      },
    );
  }

  // Product-owned lineage supersedes the historical convention which encoded
  // a Job id and attempt into the private engine run id. Read the current Job
  // again because `ensureOntoCodeBuildExecution` may have attached a legacy
  // follow-up after this worker loaded its claim context.
  const currentJobBinding = db
    .select({ buildExecutionId: ontocodeHarnessJobs.buildExecutionId })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
        eq(ontocodeHarnessJobs.sessionId, context.session.id),
        eq(ontocodeHarnessJobs.id, context.job.id),
      ),
    )
    .get()?.buildExecutionId;
  const waitingBuildExecutionId = waitingJob.buildExecutionId;
  const hasStableExecution = Boolean(
    currentJobBinding || waitingBuildExecutionId,
  );
  if (
    hasStableExecution &&
    (!currentJobBinding ||
      !waitingBuildExecutionId ||
      currentJobBinding !== waitingBuildExecutionId)
  ) {
    return factoryResumeRefusal(
      "factory_resume_build_execution_mismatch",
      "The waiting and follow-up Builds do not belong to the same stable OntoCode execution",
      {
        ...baseDetails,
        waitingBuildExecutionId: waitingBuildExecutionId ?? null,
        followUpBuildExecutionId: currentJobBinding ?? null,
      },
    );
  }

  const buildExecutionId = hasStableExecution
    ? (currentJobBinding ?? null)
    : null;
  const receiptBuildExecutionId = nonEmptyString(priorReceipt.buildExecutionId);
  const receiptFactoryRunId = nonEmptyString(priorReceipt.factoryRunId);
  let factoryRunId = receiptFactoryRunId;
  let stableExecution: {
    pendingInteractionId: string;
    pendingInteractionSubjectDigest: string;
  } | null = null;
  if (buildExecutionId) {
    const execution = db
      .select({
        engineKind: ontocodeBuildExecutions.engineKind,
        engineRunId: ontocodeBuildExecutions.engineRunId,
        state: ontocodeBuildExecutions.state,
        pendingInteractionId: ontocodeBuildExecutions.pendingInteractionId,
        pendingInteractionSubjectDigest:
          ontocodeBuildExecutions.pendingInteractionSubjectDigest,
        pendingAnswerId: ontocodeBuildExecutions.pendingAnswerId,
        pendingAnswerDigest: ontocodeBuildExecutions.pendingAnswerDigest,
        pendingAnswerStatus: ontocodeBuildExecutions.pendingAnswerStatus,
      })
      .from(ontocodeBuildExecutions)
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, context.job.tenantId),
          eq(ontocodeBuildExecutions.sessionId, context.session.id),
          eq(ontocodeBuildExecutions.id, buildExecutionId),
        ),
      )
      .get();
    if (
      !execution ||
      execution.engineKind !== "agent_factory" ||
      !execution.engineRunId ||
      (execution.state !== "running" && execution.state !== "resuming") ||
      !execution.pendingInteractionId ||
      !execution.pendingInteractionSubjectDigest ||
      !execution.pendingAnswerId ||
      execution.pendingAnswerDigest !==
        createHash("sha256").update(answer).digest("hex") ||
      (execution.pendingAnswerStatus !== "pending" &&
        execution.pendingAnswerStatus !== "delivered") ||
      receiptBuildExecutionId !== buildExecutionId ||
      (receiptFactoryRunId !== null &&
        receiptFactoryRunId !== execution.engineRunId)
    ) {
      return factoryResumeRefusal(
        "factory_resume_build_execution_stale",
        "The stable OntoCode Build execution no longer owns the waiting checkpoint",
        {
          ...baseDetails,
          buildExecutionId,
          receiptBuildExecutionId,
          receiptFactoryRunId,
          boundEngineRunId: execution?.engineRunId ?? null,
        },
      );
    }
    // The private binding is authoritative. The public waiting receipt is only
    // cross-checked above and is not allowed to select an engine run.
    factoryRunId = execution.engineRunId;
    stableExecution = {
      pendingInteractionId: execution.pendingInteractionId,
      pendingInteractionSubjectDigest:
        execution.pendingInteractionSubjectDigest,
    };
  } else if (receiptBuildExecutionId !== null) {
    // Never downgrade a partially-bound modern lineage into the legacy
    // Job/attempt run-id protocol.
    return factoryResumeRefusal(
      "factory_resume_build_execution_missing",
      "The waiting receipt names an OntoCode Build execution but its Jobs are not bound to it",
      {
        ...baseDetails,
        receiptBuildExecutionId,
      },
    );
  }
  const ancestry = factoryRunId
    ? resolveFactoryRunContinuationAncestry({
        tenantId: context.job.tenantId,
        sessionId: context.session.id,
        waitingJobId: resumeWaitingUserJobId,
        waitingAttempt: Number(priorAttempt),
        factoryRunId,
        buildExecutionId,
      })
    : {
        ok: false as const,
        reason: "waiting receipt has no Factory run id",
        chain: [resumeWaitingUserJobId],
      };
  if (!factoryRunId || !ancestry.ok) {
    return factoryResumeRefusal(
      "factory_resume_run_identity_mismatch",
      "The waiting receipt does not name a Factory run with a complete, server-authored continuation ancestry",
      {
        ...baseDetails,
        factoryRunId,
        ancestryReason: ancestry.ok ? null : ancestry.reason,
        continuationChain: ancestry.chain,
      },
    );
  }
  const factoryRun = getFactoryRun(factoryRunId, context.job.tenantId);
  if (
    !factoryRun ||
    factoryRun.deletedAt !== null ||
    factoryRun.status !== "waiting_human" ||
    factoryRun.domain !== context.project.domain ||
    (factoryRun.ontologyDomainRegistrationId ?? null) !==
      (context.project.ontologyDomainRegistrationId ?? null) ||
    (factoryRun.runtimeProfileVersionId ?? null) !==
      (context.job.runtimeProfileVersionId ?? null)
  ) {
    return factoryResumeRefusal(
      "factory_resume_run_stale",
      "The parked Factory run is unavailable or its immutable execution bindings changed",
      {
        ...baseDetails,
        factoryRunId,
        factoryRunStatus: factoryRun?.status ?? null,
        expectedDomain: context.project.domain,
        actualDomain: factoryRun?.domain ?? null,
      },
    );
  }

  const waitingCommand = waitingJob.commandId
    ? db
        .select({
          baseOntologyHash: ontocodeCommands.baseOntologyHash,
        })
        .from(ontocodeCommands)
        .where(
          and(
            eq(ontocodeCommands.tenantId, context.job.tenantId),
            eq(ontocodeCommands.id, waitingJob.commandId),
          ),
        )
        .get()
    : null;
  if (
    !waitingCommand ||
    waitingCommand.baseOntologyHash !== ontologyHash ||
    context.command.baseOntologyHash !== ontologyHash
  ) {
    return factoryResumeRefusal(
      "factory_resume_command_stale",
      "The original and follow-up Commands are not bound to the same authoritative Ontology snapshot",
      baseDetails,
    );
  }

  const conversation = db
    .select({
      tenantId: factoryConversations.tenantId,
      domain: factoryConversations.domain,
      ctxJson: factoryConversations.ctxJson,
    })
    .from(factoryConversations)
    .where(eq(factoryConversations.id, factoryRunId))
    .get();
  const checkpoint = asRecord(conversation?.ctxJson);
  if (
    !conversation ||
    conversation.tenantId !== context.job.tenantId ||
    conversation.domain !== context.project.domain ||
    !checkpoint
  ) {
    return factoryResumeRefusal(
      "factory_resume_checkpoint_missing",
      "The exact tenant/domain Factory conversation checkpoint is unavailable",
      { ...baseDetails, factoryRunId },
    );
  }
  let checkpointFingerprint: string | null = null;
  try {
    checkpointFingerprint = factoryGenerationDirectiveFingerprint(
      asRecord(checkpoint.generationDirective) as unknown as
        | FactoryGenerationDirective
        | undefined,
    );
  } catch {
    checkpointFingerprint = null;
  }
  if (
    checkpointFingerprint !== factoryGenerationDirectiveFingerprint(directive)
  ) {
    return factoryResumeRefusal(
      "factory_resume_checkpoint_scope_mismatch",
      "The Factory checkpoint was created for a different immutable generation scope",
      { ...baseDetails, factoryRunId },
    );
  }

  const interaction = activeHumanInteraction(
    checkpoint as Parameters<typeof activeHumanInteraction>[0],
  );
  const receiptInteraction = asRecord(priorReceipt.interaction);
  const legacyTestCases = Array.isArray(checkpoint.testCases)
    ? checkpoint.testCases
    : null;
  const legacyTestApprovalCheckpointMatches = Boolean(
    priorReceipt.interaction === undefined &&
    priorReceipt.status === "waiting_human" &&
    checkpoint.awaitingApproval === true &&
    checkpoint.testDataSupplementPending !== true &&
    interaction?.kind === "test_approval" &&
    legacyTestCases &&
    nonEmptyString(interaction.subjectDigest),
  );
  const legacyTestApprovalEvents = legacyTestApprovalCheckpointMatches
    ? db
        .select({ payloadJson: ontocodeSessionEvents.payloadJson })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
            eq(ontocodeSessionEvents.sessionId, context.session.id),
            eq(ontocodeSessionEvents.harnessJobId, resumeWaitingUserJobId),
            eq(ontocodeSessionEvents.type, "harness.build.test_cases"),
          ),
        )
        .all()
        .flatMap((row) => {
          const payload = parseEventPayload(row.payloadJson);
          return payload?.jobId === resumeWaitingUserJobId &&
            payload.factoryRunId === factoryRunId &&
            payload.awaitingApproval === true &&
            payload.count === legacyTestCases!.length &&
            canonicalEvidenceJson(payload.coverage ?? null) ===
              canonicalEvidenceJson(checkpoint.testCoverage ?? null)
            ? [payload]
            : [];
        })
    : [];
  // Compatibility for the one historical bridge defect fixed above: the
  // Factory checkpoint and Session test_cases event both durably identify the
  // exact test-approval gate, but the waiting receipt omitted `interaction`.
  // The persisted subject can contain fewer keys than the in-memory event
  // which created its digest (JSON drops `undefined`), so do not recompute that
  // digest from the restored cases. Instead require the current authoritative
  // gate plus one same-job/run progress row whose count and coverage exactly
  // match the restored checkpoint. Any mismatch or duplicate still fails
  // closed below.
  const recoveredLegacyTestApproval =
    legacyTestApprovalEvents.length === 1 &&
    interaction?.kind === "test_approval";
  const receiptInteractionId =
    nonEmptyString(receiptInteraction?.interactionId) ??
    (recoveredLegacyTestApproval ? interaction.interactionId : null);
  const receiptInteractionKind =
    receiptInteraction?.kind === "clarify" ||
    receiptInteraction?.kind === "boundary" ||
    receiptInteraction?.kind === "test_approval"
      ? receiptInteraction.kind
      : recoveredLegacyTestApproval
        ? "test_approval"
        : null;
  const receiptAwaitingAnswer =
    receiptInteraction?.awaitingAnswer === true || recoveredLegacyTestApproval;
  if (
    !interaction ||
    !receiptInteractionId ||
    !receiptInteractionKind ||
    !receiptAwaitingAnswer ||
    interaction.interactionId !== receiptInteractionId ||
    interaction.kind !== receiptInteractionKind
  ) {
    return factoryResumeRefusal(
      "factory_resume_interaction_stale",
      "The durable waiting receipt no longer matches the Factory checkpoint's active human gate",
      {
        ...baseDetails,
        factoryRunId,
        receiptInteractionId,
        checkpointInteractionId: interaction?.interactionId ?? null,
      },
    );
  }
  if (stableExecution) {
    const expectedSubjectDigest = receiptInteraction
      ? createHash("sha256")
          .update(
            canonicalEvidenceJson({
              question:
                nonEmptyString(receiptInteraction.question) ?? "OntoCode input",
              context: receiptInteraction.context ?? null,
              options: Array.isArray(receiptInteraction.options)
                ? receiptInteraction.options
                : [],
              items: Array.isArray(receiptInteraction.items)
                ? receiptInteraction.items
                : [],
            }),
          )
          .digest("hex")
      : nonEmptyString(interaction.subjectDigest);
    if (
      stableExecution.pendingInteractionId !== receiptInteractionId ||
      !expectedSubjectDigest ||
      stableExecution.pendingInteractionSubjectDigest !== expectedSubjectDigest
    ) {
      return factoryResumeRefusal(
        "ontocode_build_interaction_envelope_mismatch",
        "The pending OntoCode interaction no longer matches the durable generation checkpoint",
        {
          ...baseDetails,
          buildExecutionId,
          receiptInteractionId,
        },
      );
    }
  }

  const receiptAgents = [
    ...(Array.isArray(priorReceipt.agents) ? priorReceipt.agents : []),
    ...(Array.isArray(priorReceipt.agentPreviews)
      ? priorReceipt.agentPreviews
      : []),
  ].flatMap((value) => {
    const captured = capturedFactoryAgent(value);
    return captured ? [captured] : [];
  });
  const checkpointAgents = Array.isArray(checkpoint.specs)
    ? checkpoint.specs.flatMap((value) => {
        const captured = capturedFactoryAgent(value);
        return captured &&
          directive.requestedActionNames.includes(captured.actionName)
          ? [captured]
          : [];
      })
    : [];
  const receiptKeys = receiptAgents.map(
    (agent) => `${agent.slug}\u0000${agent.actionName}`,
  );
  const checkpointKeys = checkpointAgents.map(
    (agent) => `${agent.slug}\u0000${agent.actionName}`,
  );
  if (
    !sameUniqueStrings(receiptKeys, checkpointKeys) ||
    new Set(receiptAgents.map((agent) => agent.slug)).size !==
      receiptAgents.length ||
    new Set(receiptAgents.map((agent) => agent.actionName)).size !==
      receiptAgents.length
  ) {
    return factoryResumeRefusal(
      "factory_resume_agent_checkpoint_mismatch",
      "The waiting receipt's partial Agents do not exactly match the authoritative Factory checkpoint",
      {
        ...baseDetails,
        factoryRunId,
        receiptAgentCount: receiptAgents.length,
        checkpointAgentCount: checkpointAgents.length,
      },
    );
  }
  const receiptByKey = new Map(
    receiptAgents.map((agent) => [
      `${agent.slug}\u0000${agent.actionName}`,
      agent,
    ]),
  );
  const capturedAgents = checkpointAgents.map((checkpointAgent) => {
    const key = `${checkpointAgent.slug}\u0000${checkpointAgent.actionName}`;
    const receiptAgent = receiptByKey.get(key)!;
    if (
      checkpointAgent.generatedCode &&
      receiptAgent.generatedCode &&
      checkpointAgent.generatedCode !== receiptAgent.generatedCode
    ) {
      return factoryResumeRefusal(
        "factory_resume_agent_code_mismatch",
        `Checkpointed code for ${checkpointAgent.actionName} differs from the waiting receipt`,
        {
          ...baseDetails,
          factoryRunId,
          slug: checkpointAgent.slug,
          actionName: checkpointAgent.actionName,
        },
      );
    }
    return {
      ...checkpointAgent,
      name: receiptAgent.name || checkpointAgent.name,
      design: receiptAgent.design
        ? { ...receiptAgent.design }
        : checkpointAgent.generatedCode
          ? { code: checkpointAgent.generatedCode }
          : null,
      generatedCode:
        checkpointAgent.generatedCode ?? receiptAgent.generatedCode,
    };
  });

  return {
    waitingJobId: resumeWaitingUserJobId,
    factoryRunId,
    interactionId: receiptInteractionId,
    interactionKind: receiptInteractionKind,
    answer,
    persistGoal: factoryRun.goal,
    capturedAgents,
  };
}

interface OntoCodeBuildExecutionBinding {
  id: string;
  engineRunId: string;
}

const LEGACY_BUILD_EXECUTION_ADOPTION_SCHEMA =
  "ontocode-legacy-build-execution-adoption/v1" as const;

interface LegacyBuildExecutionAdoptionDescriptor {
  schema: typeof LEGACY_BUILD_EXECUTION_ADOPTION_SCHEMA;
  sourceHarnessJobId: string;
  projectId: string;
  sessionId: string;
  ontologyHash: string;
  runtimeProfileVersionId: string | null;
  engineRunId: string | null;
  interaction: {
    id: string;
    kind:
      | "clarify"
      | "test_approval"
      | "boundary"
      | "execution_readiness"
      | "legacy_answer";
    subjectDigest: string;
  };
}

function legacyBuildExecutionAdoptionDescriptor(
  execution: typeof ontocodeBuildExecutions.$inferSelect,
): LegacyBuildExecutionAdoptionDescriptor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(execution.directiveJson) as unknown;
  } catch {
    return null;
  }
  const root = asRecord(raw);
  const interaction = asRecord(root?.interaction);
  const kind = nonEmptyString(interaction?.kind);
  if (
    root?.schema !== LEGACY_BUILD_EXECUTION_ADOPTION_SCHEMA ||
    !nonEmptyString(root.sourceHarnessJobId) ||
    !nonEmptyString(root.projectId) ||
    !nonEmptyString(root.sessionId) ||
    !/^[a-f0-9]{64}$/.test(nonEmptyString(root.ontologyHash) ?? "") ||
    (root.runtimeProfileVersionId !== null &&
      !nonEmptyString(root.runtimeProfileVersionId)) ||
    (root.engineRunId !== null && !nonEmptyString(root.engineRunId)) ||
    !interaction ||
    !nonEmptyString(interaction.id) ||
    (kind !== "clarify" &&
      kind !== "test_approval" &&
      kind !== "boundary" &&
      kind !== "execution_readiness" &&
      kind !== "legacy_answer") ||
    !/^[a-f0-9]{64}$/.test(nonEmptyString(interaction.subjectDigest) ?? "") ||
    sha256Text(canonicalEvidenceJson(root)) !== execution.directiveHash
  ) {
    return null;
  }
  return root as unknown as LegacyBuildExecutionAdoptionDescriptor;
}

function buildExecutionCheckpointDigest(
  receipt: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(receipt))
    .digest("hex");
}

/**
 * Read-only bridge for executions created before OntoCode owned a stable Build
 * id. It may suggest one private engine handle, but the dedicated recovery
 * routines still have to prove the complete checkpoint lineage before that
 * handle is used. Ambiguous history deliberately returns no hint.
 */
function legacyBuildEngineRunHint(
  context: OntoCodeHarnessExecutionContext,
): string | null {
  const explicitDraftRunId = nonEmptyString(
    context.command?.arguments.recoverFactoryDraftRunId,
  );
  if (explicitDraftRunId) return explicitDraftRunId;

  const parentJobId = nonEmptyString(
    context.command?.arguments.resumeWaitingUserJobId,
  );
  const db = getDb();
  if (parentJobId) {
    const rows = db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
          eq(ontocodeSessionEvents.sessionId, context.session.id),
          eq(ontocodeSessionEvents.harnessJobId, parentJobId),
          eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
        ),
      )
      .all();
    const runIds = new Set(
      rows.flatMap((row) => {
        const payload = parseEventPayload(row.payloadJson);
        const receipt = asRecord(payload?.receipt);
        const runId = nonEmptyString(receipt?.factoryRunId);
        return runId ? [runId] : [];
      }),
    );
    return runIds.size === 1 ? [...runIds][0]! : null;
  }

  const runIds = new Set(
    db
      .select({ payloadJson: ontocodeSessionEvents.payloadJson })
      .from(ontocodeSessionEvents)
      .where(
        and(
          eq(ontocodeSessionEvents.tenantId, context.job.tenantId),
          eq(ontocodeSessionEvents.sessionId, context.session.id),
          eq(ontocodeSessionEvents.harnessJobId, context.job.id),
          eq(ontocodeSessionEvents.type, "harness.build.factory_started"),
        ),
      )
      .all()
      .flatMap((row) => {
        const runId = nonEmptyString(
          parseEventPayload(row.payloadJson)?.factoryRunId,
        );
        return runId ? [runId] : [];
      }),
  );
  return runIds.size === 1 ? [...runIds][0]! : null;
}

/**
 * Materialize the stable OntoCode Build identity after the authoritative
 * Ontology scope is known. Harness Jobs and their attempts are replaceable;
 * this row is the product lifecycle. The generation kernel gets only the
 * private `engineRunId` returned here.
 */
function ensureOntoCodeBuildExecution(
  context: OntoCodeHarnessExecutionContext,
  ontologyHash: string,
  directive: FactoryGenerationDirective,
  engineRunHint: string | null = null,
): OntoCodeBuildExecutionBinding {
  const db = getDb();
  const directiveJson = canonicalEvidenceJson(directive);
  const directiveHash = factoryGenerationDirectiveFingerprint(directive);
  if (!directiveHash) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_directive_invalid",
      "OntoCode could not fingerprint the immutable Build directive",
      { recoverable: true, retryable: false },
    );
  }
  const parentJobId = nonEmptyString(
    context.command?.arguments.resumeWaitingUserJobId,
  );
  const parentBinding = parentJobId
    ? (db
        .select({ buildExecutionId: ontocodeHarnessJobs.buildExecutionId })
        .from(ontocodeHarnessJobs)
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
            eq(ontocodeHarnessJobs.sessionId, context.session.id),
            eq(ontocodeHarnessJobs.id, parentJobId),
          ),
        )
        .get()?.buildExecutionId ?? null)
    : null;
  if (
    context.job.buildExecutionId &&
    parentBinding &&
    context.job.buildExecutionId !== parentBinding
  ) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_parent_mismatch",
      "The follow-up Harness Job is attached to a different OntoCode Build execution",
      { recoverable: true, retryable: false },
    );
  }
  if (
    parentJobId &&
    Boolean(context.job.buildExecutionId) !== Boolean(parentBinding)
  ) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_partial_binding",
      "The waiting and follow-up Jobs have only a partial stable Build binding",
      { recoverable: true, retryable: false },
    );
  }
  const requestedId = context.job.buildExecutionId ?? parentBinding;
  // A legacy event hint can select a private run only while no stable product
  // identity exists. Once either Job is bound, the execution row is the sole
  // engine authority and historical per-attempt events cannot override it.
  const hintedEngineRunId = requestedId ? null : nonEmptyString(engineRunHint);
  const leaseStartedAt = context.job.startedAt;
  if (!leaseStartedAt) {
    throw new OntoCodeHarnessExecutionError(
      "ontocode_build_execution_lease_missing",
      "OntoCode cannot bind a Build execution without the current Harness lease",
      { recoverable: true, retryable: true },
    );
  }

  try {
    return db.transaction((tx) => {
      const engineOwner = hintedEngineRunId
        ? tx
            .select()
            .from(ontocodeBuildExecutions)
            .where(
              and(
                eq(ontocodeBuildExecutions.tenantId, context.job.tenantId),
                eq(ontocodeBuildExecutions.engineKind, "agent_factory"),
                eq(ontocodeBuildExecutions.engineRunId, hintedEngineRunId),
              ),
            )
            .get()
        : undefined;
      if (requestedId && engineOwner && engineOwner.id !== requestedId) {
        throw new OntoCodeHarnessExecutionError(
          "ontocode_build_engine_owner_mismatch",
          "The internal generation checkpoint already belongs to another OntoCode Build execution",
          { recoverable: true, retryable: false },
        );
      }
      const executionId =
        requestedId ??
        engineOwner?.id ??
        `ocx-${context.job.id.replace(/^ocj-/, "")}`;
      const existing = tx
        .select()
        .from(ontocodeBuildExecutions)
        .where(
          and(
            eq(ontocodeBuildExecutions.tenantId, context.job.tenantId),
            eq(ontocodeBuildExecutions.id, executionId),
          ),
        )
        .get();
      const selectedEngineRunId =
        hintedEngineRunId ?? existing?.engineRunId ?? `ocf-${executionId}`;
      if (existing) {
        const legacyAdoption = legacyBuildExecutionAdoptionDescriptor(existing);
        const canUpgradeLegacyDirective = Boolean(
          legacyAdoption &&
          parentJobId &&
          legacyAdoption.sourceHarnessJobId === parentJobId &&
          legacyAdoption.projectId === context.project.id &&
          legacyAdoption.sessionId === context.session.id &&
          legacyAdoption.ontologyHash === ontologyHash &&
          (legacyAdoption.runtimeProfileVersionId ?? null) ===
            (context.job.runtimeProfileVersionId ?? null) &&
          (legacyAdoption.engineRunId ?? null) ===
            (existing.engineRunId ?? null) &&
          existing.pendingInteractionId === legacyAdoption.interaction.id &&
          existing.pendingInteractionKind === legacyAdoption.interaction.kind &&
          existing.pendingInteractionSubjectDigest ===
            legacyAdoption.interaction.subjectDigest &&
          existing.pendingAnswerId !== null &&
          existing.pendingAnswerDigest !== null &&
          (existing.pendingAnswerStatus === "pending" ||
            existing.pendingAnswerStatus === "delivered") &&
          (existing.state === "resuming" || existing.state === "running"),
        );
        if (
          existing.projectId !== context.project.id ||
          existing.sessionId !== context.session.id ||
          existing.ontologyHash !== ontologyHash ||
          (!canUpgradeLegacyDirective &&
            (existing.directiveHash !== directiveHash ||
              existing.directiveJson !== directiveJson)) ||
          (existing.runtimeProfileVersionId ?? null) !==
            (context.job.runtimeProfileVersionId ?? null) ||
          existing.engineKind !== "agent_factory" ||
          (existing.engineRunId !== null &&
            existing.engineRunId !== selectedEngineRunId) ||
          existing.state === "cancelled" ||
          existing.state === "failed_terminal" ||
          existing.state === "candidate_ready"
        ) {
          throw new OntoCodeHarnessExecutionError(
            "ontocode_build_execution_binding_mismatch",
            "The stable OntoCode Build execution no longer matches this immutable Ontology scope",
            {
              recoverable: true,
              retryable: false,
              details: { buildExecutionId: executionId },
            },
          );
        }
        const executionUpdate = tx
          .update(ontocodeBuildExecutions)
          .set({
            state:
              existing.state === "waiting_user" ||
              existing.state === "failed_recoverable" ||
              existing.state === "generated_unverified"
                ? "resuming"
                : "running",
            ...(canUpgradeLegacyDirective
              ? { directiveJson, directiveHash }
              : {}),
            engineRunId: selectedEngineRunId,
            revision: sql`${ontocodeBuildExecutions.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ontocodeBuildExecutions.tenantId, context.job.tenantId),
              eq(ontocodeBuildExecutions.id, executionId),
              eq(ontocodeBuildExecutions.revision, existing.revision),
            ),
          )
          .run() as { changes?: number };
        if ((executionUpdate.changes ?? 0) !== 1) {
          throw new OntoCodeHarnessExecutionError(
            "ontocode_build_execution_changed",
            "The OntoCode Build execution changed while this Harness attempt was starting",
            { recoverable: true, retryable: true },
          );
        }
      } else {
        tx.insert(ontocodeBuildExecutions)
          .values({
            id: executionId,
            tenantId: context.job.tenantId,
            projectId: context.project.id,
            sessionId: context.session.id,
            state: "running",
            ontologyHash,
            directiveJson,
            directiveHash,
            runtimeProfileVersionId:
              context.job.runtimeProfileVersionId ?? null,
            engineKind: "agent_factory",
            engineRunId: selectedEngineRunId,
            checkpointDigest: null,
            checkpointRevision: 0,
            revision: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .run();
      }

      const bound = tx
        .update(ontocodeHarnessJobs)
        .set({ buildExecutionId: executionId, updatedAt: new Date() })
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, context.job.tenantId),
            eq(ontocodeHarnessJobs.id, context.job.id),
            eq(ontocodeHarnessJobs.status, "running"),
            eq(ontocodeHarnessJobs.startedAt, new Date(leaseStartedAt)),
            or(
              isNull(ontocodeHarnessJobs.buildExecutionId),
              eq(ontocodeHarnessJobs.buildExecutionId, executionId),
            ),
          ),
        )
        .run() as { changes?: number };
      if ((bound.changes ?? 0) !== 1) {
        throw new OntoCodeHarnessExecutionError(
          "ontocode_build_execution_job_binding_changed",
          "The Harness Job changed Build execution while it was being bound",
          { recoverable: true, retryable: false },
        );
      }
      return {
        id: executionId,
        engineRunId: selectedEngineRunId,
      };
    });
  } catch (error) {
    if (error instanceof OntoCodeHarnessExecutionError) throw error;
    if (
      (error as { code?: unknown } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_engine_owner_conflict",
        "The internal generation checkpoint was concurrently claimed by another OntoCode Build execution",
        { recoverable: true, retryable: true },
      );
    }
    throw error;
  }
}

function bindOntoCodeBuildEngineCheckpoint(input: {
  tenantId: string;
  buildExecutionId: string;
  engineRunId: string;
  receipt: Record<string, unknown>;
}): void {
  const db = getDb();
  db.transaction((tx) => {
    const execution = tx
      .select({
        engineRunId: ontocodeBuildExecutions.engineRunId,
        revision: ontocodeBuildExecutions.revision,
      })
      .from(ontocodeBuildExecutions)
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, input.tenantId),
          eq(ontocodeBuildExecutions.id, input.buildExecutionId),
        ),
      )
      .get();
    if (!execution || execution.engineRunId !== input.engineRunId) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_engine_binding_mismatch",
        "The internal generation checkpoint is bound to another OntoCode Build execution",
        { recoverable: true, retryable: false },
      );
    }
    const updated = tx
      .update(ontocodeBuildExecutions)
      .set({
        checkpointDigest: buildExecutionCheckpointDigest(input.receipt),
        checkpointRevision: sql`${ontocodeBuildExecutions.checkpointRevision} + 1`,
        revision: sql`${ontocodeBuildExecutions.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, input.tenantId),
          eq(ontocodeBuildExecutions.id, input.buildExecutionId),
          eq(ontocodeBuildExecutions.revision, execution.revision),
        ),
      )
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_execution_changed",
        "The OntoCode Build execution changed while its checkpoint was committed",
        { recoverable: true, retryable: true },
      );
    }
  });
}

function markOntoCodeBuildAnswerDelivered(input: {
  tenantId: string;
  buildExecutionId: string;
  interactionId: string;
  answer: string;
}): void {
  const answerDigest = createHash("sha256").update(input.answer).digest("hex");
  getDb().transaction((tx) => {
    const execution = tx
      .select({
        state: ontocodeBuildExecutions.state,
        pendingInteractionId: ontocodeBuildExecutions.pendingInteractionId,
        pendingAnswerId: ontocodeBuildExecutions.pendingAnswerId,
        pendingAnswerDigest: ontocodeBuildExecutions.pendingAnswerDigest,
        pendingAnswerStatus: ontocodeBuildExecutions.pendingAnswerStatus,
        revision: ontocodeBuildExecutions.revision,
      })
      .from(ontocodeBuildExecutions)
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, input.tenantId),
          eq(ontocodeBuildExecutions.id, input.buildExecutionId),
        ),
      )
      .get();
    if (
      !execution ||
      (execution.state !== "running" && execution.state !== "resuming") ||
      execution.pendingInteractionId !== input.interactionId ||
      !execution.pendingAnswerId ||
      execution.pendingAnswerDigest !== answerDigest ||
      (execution.pendingAnswerStatus !== "pending" &&
        execution.pendingAnswerStatus !== "delivered")
    ) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_answer_envelope_mismatch",
        "The accepted answer no longer matches the pending OntoCode Build interaction",
        { recoverable: true, retryable: false },
      );
    }
    if (execution.pendingAnswerStatus === "delivered") return;
    const updated = tx
      .update(ontocodeBuildExecutions)
      .set({
        pendingAnswerStatus: "delivered",
        revision: sql`${ontocodeBuildExecutions.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ontocodeBuildExecutions.tenantId, input.tenantId),
          eq(ontocodeBuildExecutions.id, input.buildExecutionId),
          eq(ontocodeBuildExecutions.revision, execution.revision),
          eq(ontocodeBuildExecutions.pendingAnswerStatus, "pending"),
        ),
      )
      .run() as { changes?: number };
    if ((updated.changes ?? 0) !== 1) {
      throw new OntoCodeHarnessExecutionError(
        "ontocode_build_answer_delivery_raced",
        "The OntoCode Build answer changed while its delivery was being committed",
        { recoverable: true, retryable: true },
      );
    }
  });
}

export function createDefaultOntoCodeHarnessExecutors(
  factory: OntoCodeFactoryHarnessAdapter,
): OntoCodeHarnessExecutorRegistry {
  return {
    // Read-only comprehension over the bound Ontology. Runs the deterministic
    // structural analysis (which finally exposes the compiled relationship graph
    // instead of a bare count), probes the live source, then has the model
    // interpret ONLY those facts — every citation is re-checked before it ships.
    ontology_analysis: async (context) => {
      const ontology = await factory.fetchOntology({
        tenantId: context.job.tenantId,
        tenantSlug: context.tenantSlug,
        domain: context.project.domain,
        ontologyDomainRegistrationId:
          context.project.ontologyDomainRegistrationId,
      });
      const ontologyHash = requireCurrentOntology(context, ontology, {
        requireSnapshot: false,
      });
      const analysisArguments = context.command?.arguments ?? {};
      const analysisFocus =
        nonEmptyString(analysisArguments.focus) ??
        stringList(analysisArguments.focus);
      const analysisPresentation =
        nonEmptyString(analysisArguments.presentation) ??
        stringList(analysisArguments.presentation);
      const receipt = await analyzeOntology(ontology, {
        ontologyHash,
        tenantId: context.job.tenantId,
        tenantSlug: context.tenantSlug,
        // #ONTOCODE-MEM — the citation a later session gets when it recalls a
        // conclusion this analysis established. The tenant+domain scope of that
        // memory is derived inside from (tenantId, ontology.domainId); it is
        // deliberately NOT passed in, so no call site can widen it.
        analysisRunId: context.job.id,
        // #INQUIRY-COMPACT — with the job id this names the loop's lossless
        // fold archive (`ocf-<jobId>-a<attempt>`), the same file-name shape
        // Session deletion collects. Both halves come from the claimed job, so
        // nothing a model emits can select which archive is read or written.
        analysisAttempt: context.attempt,
        signal: context.signal,
        question:
          nonEmptyString(analysisArguments.instruction) ??
          nonEmptyString(context.command?.rationaleSummary),
        focus: analysisFocus,
        presentation: analysisPresentation,
        onProgress: (type, payload, visibility) =>
          context.progress(type, payload, visibility),
        // Live rule bindings, when the bound source can serve them. Absent is
        // reported as "could not check", never as "there are no rules".
        ...(factory.fetchActionRules
          ? {
              fetchActionRules: (_domain: string, actionName: string) =>
                factory.fetchActionRules!({
                  tenantId: context.job.tenantId,
                  tenantSlug: context.tenantSlug,
                  domain: context.project.domain,
                  ontologyDomainRegistrationId:
                    context.project.ontologyDomainRegistrationId,
                  actionName,
                }),
            }
          : {}),
        ...(factory.listInstances
          ? {
              listInstances: (
                _domain: string,
                objectType: string,
                options: { limit: number },
              ) =>
                factory.listInstances!({
                  tenantId: context.job.tenantId,
                  tenantSlug: context.tenantSlug,
                  domain: context.project.domain,
                  ontologyDomainRegistrationId:
                    context.project.ontologyDomainRegistrationId,
                  objectType,
                  limit: options.limit,
                }),
            }
          : {}),
        // #TOOL-REQ — 工具需求分析用 Build 期同一套目录与匹配，只是前移且只读。
        ...(factory.listExecutionResources
          ? {
              listExecutionResources: () =>
                factory.listExecutionResources!({
                  tenantId: context.job.tenantId,
                  tenantSlug: context.tenantSlug,
                  domain: context.project.domain,
                  ontologyDomainRegistrationId:
                    context.project.ontologyDomainRegistrationId,
                }),
            }
          : {}),
      });
      const citationValid = receipt.findings.filter(
        (finding) => finding.verdict === "citation_valid",
      ).length;
      // The review step the FDE could not see. Every model interpretation has
      // its cited ids re-checked against the loaded graph before it ships; that
      // verdict existed only inside the receipt's prose summary.
      await context.progress("harness.ontology_analysis.validation", {
        check: "每条模型解释的引用 ID 是否存在于本次载入的关系图",
        interpretations: receipt.findings.length,
        citationValid,
        citationUnverified: receipt.findings.length - citationValid,
        note: "引用可校验 ≠ 解释语义已被证实",
      });
      // When the bounded inquiry loop authored the answer, the completion chat
      // message IS that answer (the exact concatenation of every streamed
      // answer_delta), with its server-computed charts and tables attached.
      // Both are re-validated so the durable message can never carry a spec
      // the chart / table contract would reject.
      const inquiryAnswer = receipt.inquiry?.answer.trim();
      if (receipt.inquiry && inquiryAnswer) {
        const validCharts = receipt.inquiry.charts.flatMap((chart) => {
          const parsed = OntoCodeChartSpecSchema.safeParse(chart);
          return parsed.success ? [parsed.data] : [];
        });
        const validTables = (receipt.inquiry.tables ?? []).flatMap((table) => {
          const parsed = OntoCodeTableSpecSchema.safeParse(table);
          return parsed.success ? [parsed.data] : [];
        });
        // A transport-interrupted partial keeps every streamed section in the
        // durable message, prefixed with an explicit label — the handoff must
        // never replace text the FDE watched stream with a contentless
        // fallback.
        const interrupted = receipt.inquiry.terminated === "transport_error";
        return {
          outcome: "succeeded",
          receipt: receipt as unknown as Record<string, unknown>,
          message: interrupted
            ? `部分答案（分析中断：${receipt.inquiry.terminationError ?? "模型传输失败"}）\n\n${receipt.inquiry.answer}`
            : receipt.inquiry.answer,
          ...(validCharts.length > 0 ? { charts: validCharts } : {}),
          ...(validTables.length > 0 ? { tables: validTables } : {}),
        };
      }
      return {
        outcome: "succeeded",
        receipt: receipt as unknown as Record<string, unknown>,
        message:
          `已分析 ${receipt.structure.counts.objects} 个对象 · ${receipt.structure.counts.links} 条真实关系边，得出 ${receipt.findings.length} 条模型解释，其中 ${citationValid} 条引用 ID 已校验（不代表解释语义已被证实）。` +
          (receipt.substrate.interpretation === "available"
            ? " LLM 解释已完成；请结合确定性结构与原始数据复核业务判断。"
            : ` 结构分析已完成，但 LLM 解释未完成；${receipt.limitations.at(-1) ?? "请查看分析限制。"} `) +
          (receipt.toolRequirements
            ? ` 工具需求 ${receipt.toolRequirements.total} 条：已覆盖 ${receipt.toolRequirements.covered}，待配置 ${receipt.toolRequirements.needsConfig}，待选 ${receipt.toolRequirements.ambiguous}，真缺 ${receipt.toolRequirements.gaps}${receipt.toolRequirements.gaps ? `（${receipt.toolRequirements.gapSystems.join("、")}）` : ""}。`
            : " 本次未读到工具目录，缺哪些工具未作判断。"),
      };
    },
    // Release preparation. Previously a promotion job died with
    // `executor_not_available` — an internal error that told the FDE nothing.
    // It now evaluates the real preconditions and reports precisely which ones
    // are unmet. It never relaxes a gate and never claims a deploy happened.
    promotion: async (context) => {
      const preflight = preflightOntoCodeDeploy(
        { tenantId: context.job.tenantId, actorId: null },
        context.session.id,
      );
      await context.progress("harness.promotion.preflight", {
        deployable: preflight.deployable,
        blockers: preflight.blockers.map((b) => b.code),
        candidate: preflight.candidate,
        sandbox: preflight.sandbox,
      });
      const receipt = {
        schema: "ontocode-release-preflight/v1",
        ...preflight,
      } as unknown as Record<string, unknown>;
      if (preflight.deployable) {
        return {
          outcome: "succeeded",
          receipt,
          message: summarizePreflight(preflight),
        };
      }
      // Unmet preconditions are the FDE's decision to act on, not a crash.
      return {
        outcome: "waiting_user",
        receipt,
        message: summarizePreflight(preflight),
        question: {
          id: `release-preflight-${context.job.id}`,
          kind: "decision",
          question: "上线前置条件尚未满足",
          why: preflight.blockers.map((b) => b.detail).join(" "),
          options: [],
          allowOther: true,
          impact: preflight.blockers.map((b) => b.remedy).join(" "),
          systems: [],
        },
      };
    },
    // #VERIFY-CONFIG — `verify_configuration` maps to a `simulation` job, which
    // had no executor: planning "go verify the config you just filled in" died
    // with an internal error instead of checking anything. It re-verifies this
    // Session's open Configuration Tasks through the same verifier the
    // Configuration route uses — no second implementation, no relaxed check.
    simulation: async (context) => {
      const storeCtx = { tenantId: context.job.tenantId, actorId: null };
      const requestedTaskId = nonEmptyString(
        context.command?.arguments.configurationTaskId,
      );
      const open = listOntoCodeConfigurationTasks(
        storeCtx,
        context.session.id,
        {
          limit: 50,
          offset: 0,
        },
      ).items.filter((task) =>
        requestedTaskId
          ? task.id === requestedTaskId
          : task.status === "open" || task.status === "verifying",
      );
      if (open.length === 0) {
        return {
          outcome: "succeeded",
          receipt: {
            schema: "ontocode-configuration-verification/v1",
            verified: [],
          },
          message: requestedTaskId
            ? "找不到这条配置任务，没有可验证的内容。"
            : "这个 Session 没有待验证的配置项。",
        };
      }
      const verified: Array<Record<string, unknown>> = [];
      for (const task of open) {
        // One task's failure is a result, not a reason to abandon the rest.
        try {
          const receipt = await verifyOntoCodeConfigurationTask(
            storeCtx,
            task.id,
            {
              expectedRevision: task.revision,
              idempotencyKey: `harness:${context.job.id}:verify:${task.id}`,
            },
          );
          verified.push({
            taskId: task.id,
            title: task.title,
            status: receipt.task.status,
            outcome: receipt.verification?.outcome ?? null,
            reasonCode: receipt.verification?.code ?? null,
            detail: receipt.verification?.summary ?? null,
          });
        } catch (error) {
          verified.push({
            taskId: task.id,
            title: task.title,
            status: "error",
            outcome: "failed",
            reasonCode: "verification_error",
            detail: (error as Error).message,
          });
        }
      }
      await context.progress("harness.simulation.configuration_verified", {
        verified,
      });
      const satisfied = verified.filter(
        (entry) => entry.status === "satisfied",
      ).length;
      const outstanding = verified.length - satisfied;
      return {
        outcome: "succeeded",
        receipt: {
          schema: "ontocode-configuration-verification/v1",
          verified,
          satisfied,
          outstanding,
        },
        message:
          outstanding === 0
            ? `${satisfied} 项配置已验证通过。`
            : `${satisfied} 项通过、${outstanding} 项仍未通过：${verified
                .filter((entry) => entry.status !== "satisfied")
                .map(
                  (entry) =>
                    `${entry.title}（${entry.detail ?? entry.reasonCode ?? "原因未知"}）`,
                )
                .join("；")}`,
      };
    },
    // #RELEASE — the actual deploy. It reuses the legacy promotion kernel
    // verbatim (~20 fail-closed gates: signed sandbox execution receipt, human
    // HMAC review receipt, no-mock, whole-version-only, production integration
    // probes). Nothing here relaxes a gate: the executor only decides what to
    // promote, hands it over, and records honestly what came back.
    deploy: async (context) => {
      const storeCtx = { tenantId: context.job.tenantId, actorId: null };
      const preflight = preflightOntoCodeDeploy(storeCtx, context.session.id);
      await context.progress("harness.deploy.preflight", {
        deployable: preflight.deployable,
        blockers: preflight.blockers.map((b) => b.code),
        candidate: preflight.candidate,
        draftVersionIds: preflight.draftBinding?.draftVersionIds ?? [],
      });
      const baseReceipt = {
        schema: "ontocode-release/v1",
        preflight,
      } as unknown as Record<string, unknown>;
      if (!preflight.deployable || !preflight.candidate) {
        return {
          outcome: "waiting_user",
          receipt: baseReceipt,
          message: summarizePreflight(preflight),
          question: {
            id: `release-blocked-${context.job.id}`,
            kind: "decision",
            question: "还不能部署",
            why: preflight.blockers.map((b) => b.detail).join(" "),
            options: [],
            allowOther: true,
            impact: preflight.blockers.map((b) => b.remedy).join(" "),
            systems: [],
          },
        };
      }

      // The human review receipt is minted by an interactive person against the
      // exact draft version. The worker can never create one — if it is absent,
      // the honest move is to ask, not to promote something unreviewed.
      const reviewReceiptId = nonEmptyString(
        context.command?.arguments.reviewReceiptId,
      );
      const draftVersionId = preflight.draftBinding!.draftVersionIds[0]!;
      if (!reviewReceiptId) {
        return {
          outcome: "waiting_user",
          receipt: {
            ...baseReceipt,
            draftVersionId,
            reason: "review_receipt_missing",
          },
          message:
            "部署需要一份由真人签署的审核回执。请在发布审核里核对这一版代码并签署，然后把回执 id 填回来。",
          question: {
            id: `release-review-${context.job.id}`,
            kind: "authorization",
            question: `请提供 draft 版本 ${draftVersionId} 的人工审核回执 id`,
            why: "促升会把生成的代码接到真实系统上，必须有人看过并签字。回执由交互式审核流程签发，工厂自己不能生成。",
            options: [],
            allowOther: true,
            impact: "签署后即可执行部署。",
            systems: [],
          },
        };
      }

      const promotion = await promoteDrafts(
        context.project.domain,
        { versionId: draftVersionId, receiptId: reviewReceiptId },
        {
          tenantId: context.job.tenantId,
          tenantSlug: context.tenantSlug,
        },
      );
      await context.progress("harness.deploy.promoted", {
        draftVersionId,
        promoted: promotion.promoted,
        functionsRegistered: promotion.functionsRegistered,
        liveAgents: promotion.liveAgents,
        deploymentId: promotion.deploymentId ?? null,
      });

      // A partial promotion is not a release. Say so rather than reporting
      // success for a version that is only half live.
      if (
        promotion.total <= 0 ||
        promotion.promoted.length !== promotion.total ||
        promotion.functionsRegistered <= 0
      ) {
        throw new OntoCodeHarnessExecutionError(
          "release_incomplete",
          `促升没有让这一版的全部 Agent 上线（选中 ${promotion.total}、已促升 ${promotion.promoted.length}、注册函数 ${promotion.functionsRegistered}）`,
          {
            recoverable: true,
            retryable: false,
            details: { draftVersionId, promotion },
          },
        );
      }

      const releasedAt = new Date();
      const packageRow = getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(
          and(
            eq(ontocodePackageVersions.tenantId, context.job.tenantId),
            eq(
              ontocodePackageVersions.id,
              preflight.candidate.packageVersionId,
            ),
          ),
        )
        .get();
      const released = packageRow
        ? markOntoCodeCandidateReleased(storeCtx, {
            packageVersionId: packageRow.id,
            dependencyRoot: packageRow.dependencyRoot,
            draftVersionId,
            reviewReceiptId,
            deploymentId: promotion.deploymentId ?? null,
            promotedSlugs: promotion.promoted,
            functionsRegistered: promotion.functionsRegistered,
            liveAgents: promotion.liveAgents,
            releasedAt,
          })
        : false;

      const receipt = {
        ...baseReceipt,
        draftVersionId,
        reviewReceiptId,
        promotion,
        released,
        releasedAt: releasedAt.toISOString(),
        rollback: promotion.deploymentId
          ? {
              // Promotion creates an exact deployment row; rolling back means
              // re-promoting the previous one, never editing live code in place.
              deploymentId: promotion.deploymentId,
              instruction:
                "回滚 = 促升上一版 deployment。生产代码不做就地修改。",
            }
          : null,
      } as unknown as Record<string, unknown>;

      return {
        outcome: "succeeded",
        receipt,
        message: released
          ? `已部署：${promotion.promoted.length} 个 Agent 上线，注册 ${promotion.functionsRegistered} 个 Inngest 函数，租户现有 ${promotion.liveAgents} 个 Agent。`
          : `代码已促升上线（${promotion.promoted.length} 个 Agent），但候选包状态没能标记为 released——候选包在部署期间发生了变化，请核对后再操作。`,
      };
    },
    scope: async (context) => {
      const ontology = await factory.fetchOntology({
        tenantId: context.job.tenantId,
        tenantSlug: context.tenantSlug,
        domain: context.project.domain,
        ontologyDomainRegistrationId:
          context.project.ontologyDomainRegistrationId,
      });
      const ontologyHash = requireCurrentOntology(context, ontology, {
        requireSnapshot: false,
      });
      await context.progress("harness.scope.ontology_loaded", {
        domain: ontology.domainId,
        source: ontology.source,
        ontologyHash,
        counts: {
          objects: ontology.objects.length,
          actions: ontology.actions.length,
          events: ontology.events.length,
          rules: ontology.rules.length,
        },
      });
      // Assistant-created scope Commands carry the current FDE turn as the
      // instruction; the Session goal may just be the text that opened Chat.
      const scenario =
        nonEmptyString(context.command?.arguments.scenario) ??
        boundedFdeInstruction(context.command) ??
        context.session.goal;
      const scopeKey = `${context.job.tenantId}:${context.session.id}`;
      const requestedMode = nonEmptyString(
        context.command?.arguments.scopeMode,
      );
      const explicitActionIds = stringList(
        context.command?.arguments.actionIds,
      );
      const agentOwnedActions = ontology.actions.filter((action) =>
        action.actor.some((actor) => actor.trim().toLowerCase() === "agent"),
      );
      const explicitActions =
        requestedMode === "full_domain"
          ? agentOwnedActions
          : requestedMode === "selected_actions"
            ? explicitActionIds.map((actionId) => {
                const action = ontology.actions.find(
                  (candidate) => candidate.id === actionId,
                );
                if (!action) {
                  throw new OntoCodeHarnessExecutionError(
                    "ontology_action_not_found",
                    `Selected Ontology Action ${actionId} is not present in the authoritative snapshot`,
                    {
                      recoverable: true,
                      retryable: false,
                      details: { actionId, ontologyHash },
                    },
                  );
                }
                if (
                  !action.actor.some(
                    (actor) => actor.trim().toLowerCase() === "agent",
                  )
                ) {
                  throw new OntoCodeHarnessExecutionError(
                    "ontology_action_not_agent_owned",
                    `Selected Ontology Action ${actionId} is not assigned to an Agent actor`,
                    {
                      recoverable: true,
                      retryable: false,
                      details: {
                        actionId,
                        actors: action.actor,
                        ontologyHash,
                      },
                    },
                  );
                }
                return action;
              })
            : null;
      if (
        (requestedMode === "selected_actions" ||
          requestedMode === "full_domain") &&
        explicitActions?.length === 0
      ) {
        throw new OntoCodeHarnessExecutionError(
          "selected_actions_required",
          requestedMode === "full_domain"
            ? "The bound Ontology has no Actions assigned to an Agent actor"
            : "selected_actions scope requires at least one authoritative Ontology Action id",
          { recoverable: true, retryable: false },
        );
      }
      const recommendation: FactoryScopeRecommendation = explicitActions
        ? {
            recommendationId: factoryScopeRecommendationId({
              scopeKey,
              domain: context.project.domain,
              ontologyHash,
              scenario,
            }),
            ontologyHash,
            mode: "action_selection",
            scenario,
            actionIds: explicitActions.map((action) => action.id),
            actions: explicitActions.map((action) => ({
              id: action.id,
              name: action.name,
              reason:
                requestedMode === "full_domain"
                  ? "Included because the FDE selected full-domain generation."
                  : "Explicitly selected by the FDE from the bound Ontology.",
            })),
            reasoningSummary:
              requestedMode === "full_domain"
                ? `The FDE selected the complete bound Ontology scope (${explicitActions.length} Actions).`
                : `The FDE explicitly selected ${explicitActions.length} authoritative Ontology Actions.`,
            confidence: 1,
          }
        : await factory.recommendScope({
            ontology,
            scenario,
            scopeKey,
            signal: context.signal,
            // Server-owned allowance, never invented at the call site. It funds
            // the read-only tool loop that lets this stage READ whole Action
            // contracts instead of classifying a pre-clipped prompt — and when
            // it cannot fund it, the recommender says so in a frame rather than
            // silently shipping the cheap path as if it had reasoned.
            budget: SCOPE_INQUIRY_BUDGET,
            onFrame: (frame) => bridgeScopeReasoningFrame(context, frame),
          });
      if (explicitActions) {
        // Deterministic ≠ dishonest. An FDE's explicit selection runs no model
        // at all; saying so plainly is the only way a 1-second result does not
        // read as fast thinking.
        await context.progress("harness.scope.deliberation", {
          status: "deterministic",
          path: "explicit_selection",
          detail:
            requestedMode === "full_domain"
              ? "本次范围由 FDE 直接选定为整域，没有模型参与推理；下面的理由是这条选择本身，不是分析结论。"
              : "本次范围由 FDE 逐个指定，没有模型参与推理；下面的理由是这条选择本身，不是分析结论。",
          modelCalls: 0,
          toolCalls: 0,
          budget: null,
        });
      }
      // Make the decision legible. The reasoning, the per-Action justification
      // and the exact-revalidation outcome are all already computed here; until
      // now they only reached the receipt, so the reasoning stream showed a
      // scope Job as two bare stage markers and looked like nothing had thought.
      await context.progress("harness.scope.reasoning_step", {
        phase: "conclusion",
        summary: recommendation.reasoningSummary,
        confidence: recommendation.confidence,
        mode: recommendation.mode,
        // HOW this conclusion was reached, carried next to the conclusion
        // itself: a deterministic or degraded decision must never be readable
        // as a reasoned one just because it arrived fast.
        ...(recommendation.decisionPath
          ? { decisionPath: recommendation.decisionPath }
          : {}),
        ...(recommendation.catalogAccess
          ? { catalogAccess: recommendation.catalogAccess }
          : {}),
        actions: recommendation.actions.map((action) => ({
          name: action.name,
          reason: action.reason,
        })),
      });

      assertFactoryScopeRecommendationCurrent({
        scopeKey,
        domain: context.project.domain,
        ontology,
        scenario,
        recommendationId: recommendation.recommendationId,
        ontologyHash: recommendation.ontologyHash,
      });

      // What the check actually established — not merely that it ran. Anything
      // the model named that does not resolve in the authoritative catalog is
      // reported, never silently dropped.
      // Two DIFFERENT facts, previously filed under one name. The catalog
      // revalidation throws on any unknown id, so it can only ever report zero
      // failures — reporting the model's own scenario gaps under its heading
      // made "unresolved: 0" look like that check had found nothing wrong.
      await context.progress("harness.scope.validation", {
        check: "每个选中的 Action 都能在当前 Ontology 目录里精确解析",
        selected: recommendation.actionIds.length,
        resolved: recommendation.actionIds.length,
        ontologyHash,
      });
      if (recommendation.unresolved?.length) {
        await context.progress("harness.scope.declared_gap", {
          note: "模型声明：场景里有内容没能落到本体上。生成前需要你裁决。",
          count: recommendation.unresolved.length,
          items: recommendation.unresolved.slice(0, 20),
        });
      }

      return {
        outcome: "succeeded",
        phase: "scope",
        receipt: {
          schema: "ontocode-scope-receipt/v1",
          ontologyHash,
          recommendation,
        },
      };
    },

    blueprint: async (context) => {
      const ontology = await factory.fetchOntology({
        tenantId: context.job.tenantId,
        tenantSlug: context.tenantSlug,
        domain: context.project.domain,
        ontologyDomainRegistrationId:
          context.project.ontologyDomainRegistrationId,
      });
      const ontologyHash = requireCurrentOntology(context, ontology, {
        requireSnapshot: false,
      });
      const scope = await resolveGenerationScope(context);
      const directive = createFactoryGenerationDirective({
        ontology,
        actionIds: scope.actionIds,
        scenario: scope.scenario,
        forceVirtual: scope.forceVirtual,
      });
      const workingOntology = applyFactoryGenerationOverlay(
        ontology,
        directive,
      );
      const selected = directive.requestedActionIds
        .map((id) =>
          workingOntology.actions.find((candidate) => candidate.id === id),
        )
        .filter((action): action is DomainOntology["actions"][number] =>
          Boolean(action),
        );
      const model = groundBlueprint(
        {
          domain: workingOntology.domainId,
          ontologySig: ontologyHash,
          phases: selected.map((action, index) => ({
            id: `agent-${index + 1}-${action.id}`
              .replace(/[^a-zA-Z0-9_-]+/g, "-")
              .slice(0, 120),
            title: action.name,
            intent: action.description,
            anchors: [
              {
                kind: "action" as const,
                id: action.id,
                evidence: "Selected authoritative Ontology Action",
              },
            ],
            steps: [
              {
                label: `Generate and verify ${action.name}`,
                agent: action.name,
                emits: [...action.triggered_event],
                anchors: [
                  {
                    kind: "action" as const,
                    id: action.id,
                    evidence: action.description,
                  },
                  ...action.triggered_event.map((event) => ({
                    kind: "event" as const,
                    id: event,
                    evidence: "Authoritative emitted event",
                  })),
                ],
              },
            ],
          })),
        },
        buildOntologyAnchorIndex(workingOntology),
      );
      if (!blueprintIsGrounded(model)) {
        throw new OntoCodeHarnessExecutionError(
          "blueprint_not_grounded",
          "No proposed Agent phase could be grounded in the authoritative Ontology",
          {
            recoverable: true,
            retryable: false,
            details: { unresolved: model.unresolved },
          },
        );
      }
      await context.progress("harness.blueprint.grounded", {
        ontologyHash,
        phaseCount: model.phases.length,
        unresolvedCount: model.unresolved.length,
        // The skeleton above is MECHANICAL: one phase per selected Action, one
        // step per phase, `intent` copied from the Action's own description.
        // Saying so here is what stops a one-second result from reading as
        // fast thinking before the reasoning pass below has had its say.
        derivation: "mechanical_skeleton",
      });
      // #BLUEPRINT-REASON — the half this stage was missing. Same discipline as
      // the analysis path: server-owned budget, one shared model-call counter,
      // a visible frame per phase, and every reasoned element re-grounded so an
      // invented id lands in `unresolved` instead of in the blueprint.
      const reasoned = await reasonBlueprintPhases({
        model,
        ontology: workingOntology,
        budget: resolveBlueprintReasoningBudget(context),
        onFrame: (frame) => emitBlueprintReasoningFrame(context, frame),
        signal: context.signal,
      });
      if (reasoned.record.status === "unavailable") {
        // 产品铁律：不要降级，全都用 AI 来推理。无网关时机械骨架只是推理【输入】，
        // 绝不能作为交付物出厂——作业按失败回执纪律如实失败，原因带在回执里。
        // 预算耗尽（网关可用但推理只覆盖部分阶段）不走这里：那仍是 AI 产出，
        // 且 record 已如实标注哪些阶段保留机械骨架。
        throw new OntoCodeHarnessExecutionError(
          "blueprint_reasoning_gateway_unavailable",
          "Blueprint 推理需要可用的模型网关；机械派生的骨架只是推理输入，不能作为交付物。请先在设置中配置模型 Provider，再重新运行 Blueprint。",
          {
            recoverable: true,
            retryable: false,
            details: {
              reasoningStatus: reasoned.record.status,
              reason: reasoned.record.detail,
              phases: reasoned.record.coverage.phases,
              modelCalls: reasoned.record.coverage.modelCalls,
              maxModelCalls: reasoned.record.coverage.maxModelCalls,
            },
          },
        );
      }
      return {
        outcome: "succeeded",
        phase: "blueprint",
        receipt: {
          schema: "ontocode-blueprint-receipt/v1",
          ontologyHash,
          scope: {
            actionIds: [...directive.requestedActionIds],
            actionNames: [...directive.requestedActionNames],
            scenario: directive.scenario ?? scope.scenario,
            forceVirtual: directive.mode === "virtual_scenario",
            source: scope.source,
          },
          model: reasoned.model,
          reasoning: reasoned.record,
        },
      };
    },

    build: async (context) => {
      const ontology = await factory.fetchOntology({
        tenantId: context.job.tenantId,
        tenantSlug: context.tenantSlug,
        domain: context.project.domain,
        ontologyDomainRegistrationId:
          context.project.ontologyDomainRegistrationId,
      });
      const ontologyHash = requireCurrentOntology(context, ontology, {
        requireSnapshot: true,
      });
      const scope = applyDeferredGenerationScope(
        ontology,
        await resolveGenerationScope(context),
        context.command?.arguments,
      );
      const directive = createFactoryGenerationDirective({
        ontology,
        actionIds: scope.actionIds,
        scenario: scope.scenario,
        forceVirtual: scope.forceVirtual,
      });
      if (directive.sourceOntologyHash !== ontologyHash) {
        throw new OntoCodeHarnessExecutionError(
          "generation_directive_stale",
          "The generated scope is not bound to the current authoritative Ontology",
          { recoverable: true, retryable: false },
        );
      }
      const buildExecution = ensureOntoCodeBuildExecution(
        context,
        ontologyHash,
        directive,
        legacyBuildEngineRunHint(context),
      );
      const recoveredDraft = await recoverFactoryDraftCheckpoint(
        context,
        ontologyHash,
        directive,
      );
      // A Job that was already attached when claimed belongs to the modern
      // OntoCode lifecycle. Its stable execution + private checkpoint are the
      // authority; per-attempt progress rows are audit evidence only. Keep the
      // historical event-chain reconciler solely for unbound legacy Jobs.
      const stableRecovery = recoveredDraft
        ? undefined
        : resolveStableBuildCheckpointRecovery(
            context,
            buildExecution,
            ontologyHash,
            directive,
          );
      const recoveredWaiting =
        stableRecovery?.result ??
        (recoveredDraft || context.job.buildExecutionId
          ? undefined
          : resolveFactoryWaitingCheckpointRecovery(
              context,
              ontologyHash,
              directive,
            ));
      const startOnlyRecovery =
        recoveredDraft || recoveredWaiting
          ? undefined
          : (stableRecovery?.reconnect ??
            (context.job.buildExecutionId
              ? undefined
              : resolveFactoryStartOnlyRecovery(
                  context,
                  ontologyHash,
                  directive,
                )));
      const result =
        recoveredDraft ??
        recoveredWaiting ??
        (await (async () => {
          const stableContinuation =
            !startOnlyRecovery && context.job.buildExecutionId
              ? resolveStableBuildContinuation(
                  context,
                  buildExecution,
                  ontologyHash,
                  directive,
                )
              : undefined;
          const reconnectRecovery =
            startOnlyRecovery ?? stableContinuation?.reconnect;
          const reconnect = reconnectRecovery?.reconnect;
          const resume = reconnect
            ? undefined
            : (stableContinuation?.resume ??
              (context.job.buildExecutionId
                ? undefined
                : resolveFactoryBuildResume(context, ontologyHash, directive)));
          if (reconnect) {
            await context.progress("harness.build.factory_reconnected", {
              buildExecutionId: buildExecution.id,
              ontologyHash,
              factoryRunId: reconnect.factoryRunId,
              recoveryMode: reconnect.mode,
              recoveredFromAttempt: reconnectRecovery!.sourceAttempt,
              finalizedByAttempt: context.attempt,
              checkpointedAgentCount: reconnect.capturedAgents.length,
              replayedHumanAnswer: false,
            });
          } else {
            await context.progress("harness.build.factory_started", {
              buildExecutionId: buildExecution.id,
              jobId: context.job.id,
              ontologyHash,
              mode: directive.mode,
              actionIds: [...directive.requestedActionIds],
              actionNames: [...directive.requestedActionNames],
              attempt: context.attempt,
              resumedFromWaitingJobId: resume?.waitingJobId ?? null,
              factoryRunId: resume?.factoryRunId ?? buildExecution.engineRunId,
              checkpointedAgentCount: resume?.capturedAgents.length ?? 0,
            });
          }
          return factory.runBuild({
            buildExecutionId: buildExecution.id,
            engineRunId:
              resume?.factoryRunId ??
              reconnect?.factoryRunId ??
              buildExecution.engineRunId,
            jobId: context.job.id,
            attempt: context.attempt,
            operation: "build",
            tenantId: context.job.tenantId,
            tenantSlug: context.tenantSlug,
            domain: context.project.domain,
            ontologyDomainRegistrationId:
              context.project.ontologyDomainRegistrationId,
            runtimeProfileVersionId:
              context.job.runtimeProfileVersionId ?? null,
            goal: factoryBuildGoal(
              directive,
              context.session.goal,
              context.command,
            ),
            actorId: context.job.createdBy,
            interactionPolicy:
              context.session.autonomyMode === "sandbox_autopilot"
                ? "autopilot"
                : "strict",
            directive,
            budget: context.job.budget,
            ...(resume
              ? {
                  resume,
                  onAnswerDelivery: () =>
                    markOntoCodeBuildAnswerDelivered({
                      tenantId: context.job.tenantId,
                      buildExecutionId: buildExecution.id,
                      interactionId: resume.interactionId,
                      answer: resume.answer,
                    }),
                }
              : {}),
            ...(reconnect ? { reconnect } : {}),
            signal: context.signal,
            onProgress: (type, payload, visibility) =>
              context.progress(type, payload, visibility),
          });
        })());
      const engineRunId = nonEmptyString(result.receipt.factoryRunId);
      if (!engineRunId) {
        throw new OntoCodeHarnessExecutionError(
          "ontocode_build_engine_receipt_missing",
          "The internal generation engine did not identify the checkpoint it returned",
          { recoverable: true, retryable: false },
        );
      }
      if (engineRunId !== buildExecution.engineRunId) {
        throw new OntoCodeHarnessExecutionError(
          "ontocode_build_engine_receipt_mismatch",
          "The internal generation engine returned a checkpoint from another OntoCode Build execution",
          {
            recoverable: true,
            retryable: false,
            details: {
              buildExecutionId: buildExecution.id,
              expectedEngineRunId: buildExecution.engineRunId,
              actualEngineRunId: engineRunId,
            },
          },
        );
      }
      const executionReceipt = {
        ...result.receipt,
        buildExecutionId: buildExecution.id,
      };
      bindOntoCodeBuildEngineCheckpoint({
        tenantId: context.job.tenantId,
        buildExecutionId: buildExecution.id,
        engineRunId,
        receipt: executionReceipt,
      });
      const candidateToolContracts = await captureCandidateToolContracts(
        factory,
        {
          tenantId: context.job.tenantId,
          tenantSlug: context.tenantSlug,
          domain: context.project.domain,
          ontologyDomainRegistrationId:
            context.project.ontologyDomainRegistrationId,
        },
        executionReceipt,
      );
      return {
        outcome: result.outcome,
        phase: result.outcome === "succeeded" ? "verify" : "build",
        message: result.message,
        receipt: {
          schema: "ontocode-build-receipt/v1",
          ontologyHash,
          scope: {
            actionIds: [...directive.requestedActionIds],
            actionNames: [...directive.requestedActionNames],
            deferredActions: scope.deferredActions.map((action) => ({
              ...action,
            })),
            scenario: directive.scenario ?? scope.scenario,
            forceVirtual: directive.mode === "virtual_scenario",
            source: scope.source,
          },
          ...executionReceipt,
          candidateToolContracts,
        },
      };
    },

    test: (context) =>
      context.command?.type === "generate_tests"
        ? executeCandidateTestAuthoring(factory, context)
        : executeExactCandidateTest(factory, context, "test"),
    debug: (context) => executeFactoryIteration(factory, context, "debug"),
    regression: (context) =>
      executeExactCandidateTest(factory, context, "regression"),
  };
}

export interface OntoCodeHarnessWorkerController {
  readonly adapter: OntoCodeHarnessWorkerAdapter;
  readonly running: boolean;
  start(): void;
  runOnce(): Promise<OntoCodeHarnessRunResult>;
  stop(options?: { abortActive?: boolean }): Promise<void>;
}

class DefaultOntoCodeHarnessWorkerController implements OntoCodeHarnessWorkerController {
  readonly adapter: OntoCodeHarnessWorkerAdapter;

  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Jobs currently executing. Was a single slot: one long Build starved every
   *  session of every tenant, and the FDE's only escape was deleting the
   *  Session — which cascades away its messages, events, artifacts and evidence.
   *  `claimNextJob` is already an atomic compare-and-swap and already refuses to
   *  claim a second job for a session that has one in flight, so widening the
   *  pool changes throughput without weakening either guarantee. */
  private readonly inFlight = new Set<Promise<OntoCodeHarnessRunResult>>();
  private readonly concurrency: number;
  private lifecycleAbort = new AbortController();

  constructor(options: OntoCodeHarnessWorkerOptions) {
    this.adapter = new OntoCodeHarnessWorkerAdapter(options);
    const configured = Number(process.env.ONTOCODE_HARNESS_CONCURRENCY);
    if (Number.isFinite(configured) && configured >= 1) {
      const requested = Math.floor(configured);
      this.concurrency = Math.min(requested, MAX_HARNESS_CONCURRENCY);
      // Silently serving 8 to an operator who asked for 16 makes the setting
      // look broken and the ceiling invisible. Say what was applied and why.
      if (requested > MAX_HARNESS_CONCURRENCY) {
        console.warn(
          `[ontocode-harness] ONTOCODE_HARNESS_CONCURRENCY=${requested} exceeds the ${MAX_HARNESS_CONCURRENCY} ceiling; running ${this.concurrency}`,
        );
      }
    } else {
      this.concurrency = DEFAULT_HARNESS_CONCURRENCY;
    }
  }

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    if (this.lifecycleAbort.signal.aborted) {
      this.lifecycleAbort = new AbortController();
    }
    this.schedule(0);
  }

  async runOnce(): Promise<OntoCodeHarnessRunResult> {
    // All slots busy: report "nothing claimed" rather than queueing behind a
    // long job — the scheduler then simply retries on its poll interval.
    if (this.inFlight.size >= this.concurrency) {
      const settled = await Promise.race([...this.inFlight]).catch(() => null);
      return settled ?? { claimed: false };
    }
    const run = this.adapter
      .runNext({ signal: this.lifecycleAbort.signal })
      .finally(() => {
        this.inFlight.delete(run);
      });
    this.inFlight.add(run);
    return run;
  }

  async stop(options: { abortActive?: boolean } = {}): Promise<void> {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (options.abortActive ?? true) {
      this.lifecycleAbort.abort(
        new OntoCodeHarnessExecutionError(
          "worker_stopped",
          "OntoCode Harness Worker stopped before the job completed",
          { recoverable: true, retryable: true },
        ),
      );
    }
    await Promise.allSettled([...this.inFlight]);
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .then((result) => {
          // Claimed one and a slot is still free → look for the next job at
          // once; that is what makes the pool actually parallel rather than
          // just a deeper queue.
          const canTakeMore =
            result.claimed && this.inFlight.size < this.concurrency;
          this.schedule(canTakeMore ? 0 : this.adapter.pollIntervalMs);
        })
        .catch(() => {
          // A job-state failure is intentionally durable and handled inside
          // runNext. An infrastructure failure pauses only this poll cycle.
          this.schedule(this.adapter.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}

/**
 * Lifecycle seam for Fastify/bootstrap. Construction has no side effects;
 * call `start()` after DB migrations/bootstrap and await `stop()` from onClose.
 */
export function createOntoCodeHarnessWorker(
  options: OntoCodeHarnessWorkerOptions = {},
): OntoCodeHarnessWorkerController {
  return new DefaultOntoCodeHarnessWorkerController(options);
}

/** Convenience form for composition roots that want immediate polling. */
export function startOntoCodeHarnessWorker(
  options: OntoCodeHarnessWorkerOptions = {},
): OntoCodeHarnessWorkerController {
  const worker = createOntoCodeHarnessWorker(options);
  worker.start();
  return worker;
}
