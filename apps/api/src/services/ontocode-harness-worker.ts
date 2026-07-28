import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  getDb,
  ontocodeCandidateHeads,
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
  assertFactoryScopeRecommendationCurrent,
  blueprintIsGrounded,
  buildOntologyAnchorIndex,
  createFactoryGenerationDirective,
  factoryScopeRecommendationId,
  factoryGenerationGoal,
  factorySourceOntologyHash,
  generatedSpecExecutionOwnership,
  groundBlueprint,
  recommendFactoryActionScope,
  FactoryScopeRecommendationError,
  SandboxLifecycleBlockedError,
  type BrainEvent,
  type DomainOntology,
  type FactoryGenerationDirective,
  type FactoryScopeRecommendation,
  type GeneratedAgentSpec,
  type IntegrationCapabilityProvider,
  type RealTool,
  type SandboxDeployResult,
} from "@agentic/agent-factory";
import {
  OntoCodeStructuredQuestionSchema,
  resolveWallClockPolicy,
  type OntoCodeBuildSession,
  type OntoCodeCommand,
  type OntoCodeHarnessJob,
  type OntoCodeHarnessJobKind,
  type OntoCodeProject,
  type OntoCodePackageVersion,
  type OntoCodeExecutionOwner,
  type OntoCodeSessionActivity,
  type OntoCodeSessionPhase,
  type OntoCodeStructuredQuestion,
  type OntoCodeTurnAction,
} from "@agentic/contracts";
import { canonicalEvidenceJson } from "@agentic/shared";
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
import { abortRun, startRun, subscribeRun } from "./agent-factory/run-registry";
import { getRuntimeTenantRegistrySnapshot } from "./agent-factory/tenant-native-tool-provider";
import { assertRuntimeProfileVersionForTenant } from "./runtime-profile-store";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

const ACTIVE_JOB_STATUSES = ["leased", "running"] as const;
const PENDING_JOB_STATUSES = ["queued", "retry_scheduled"] as const;
const PRODUCTION_JOB_KINDS = new Set<OntoCodeHarnessJobKind>([
  "promotion",
  "deploy",
]);
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
  if (explicitMessage?.trim()) return explicitMessage.trim();
  const labels: Record<OntoCodeHarnessJobKind, string> = {
    ontology_analysis:
      "Ontology 分析已完成：已读取真实关系图并给出可核查的结论。可在右侧「产物」查看。",
    scope:
      "Ontology 范围分析已完成。你可以检查推荐范围，然后继续生成 Blueprint。",
    blueprint:
      "Agent Blueprint 已生成并绑定当前 Ontology snapshot。你可以审查职责与依赖后开始构建。",
    build: "Agent Package 已完成真实构建，生成结果和 Harness 回执已保存。",
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
  candidateHeadId: string | null;
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
      visibility: "audit",
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
  // the immutable receipt, but must not become candidate code artifacts until
  // the Factory has delivered a successful, durable draft.
  if (result.outcome !== "succeeded") return [];
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

/** What an Agent's spec claims about one external-system requirement. The
 * Candidate Package records this verbatim so a reader can check the claim
 * against the Ontology without re-running the build. */
interface CandidateIntegrationBinding {
  requirementId: string;
  system: string;
  role: string;
  status: string;
  bindingKind: string | null;
  toolName: string | null;
  reason: string | null;
}

interface CandidateAgentDescriptor {
  slug: string;
  actionName: string | null;
  executionOwner: "declarative_manifest" | "codeact";
  specLogicalName: string;
  codeLogicalName: string;
  tools: string[];
  integrations: CandidateIntegrationBinding[];
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
      role: nonEmptyString(requirement?.role) ?? "",
      status: nonEmptyString(binding.status) ?? "missing",
      bindingKind: nonEmptyString(binding.bindingKind),
      toolName: nonEmptyString(binding.toolName),
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
      executionOwner: codeExecuted ? "codeact" : "declarative_manifest",
      specLogicalName: `agents/${segment}/spec.json`,
      codeLogicalName: `agents/${segment}/agent.ts`,
      tools: Array.isArray(spec.tools)
        ? spec.tools.flatMap((tool) =>
            typeof tool === "string" && tool.trim() ? [tool.trim()] : [],
          )
        : [],
      integrations: candidateIntegrationBindings(spec),
      draftVersionId: nonEmptyString(agent.draftVersionId),
      codeSha256: sha256Text(code),
    });
  }
  return descriptors;
}

/** #STRICT-DELIVERY — a Candidate Package is a claim that these Agents can do
 * the work. An external-system requirement that is unresolved, awaiting config,
 * awaiting a probe, or marked as a manual human boundary means the opposite:
 * the Agent cannot do that part. Such a package must never reach
 * `candidate_ready`, because everything downstream (verify, sandbox, deploy)
 * treats a candidate as executable. This is enforced here, at the durable write,
 * rather than only in the build's own gates — a bypassed or future executor
 * still cannot write a package that overstates what was built. */
function assertCandidateIntegrationsBound(
  agents: CandidateAgentDescriptor[],
): void {
  const unbound: Array<Record<string, unknown>> = [];
  for (const agent of agents) {
    for (const binding of agent.integrations) {
      if (binding.status === "resolved") {
        // A tool binding is only real if the Agent actually carries that tool.
        const kind = binding.bindingKind ?? (binding.toolName ? "tool" : null);
        if (
          kind === "tool" &&
          (!binding.toolName || !agent.tools.includes(binding.toolName))
        ) {
          unbound.push({
            slug: agent.slug,
            system: binding.system,
            role: binding.role,
            status: "resolved_without_tool",
            toolName: binding.toolName,
          });
        }
        continue;
      }
      unbound.push({
        slug: agent.slug,
        system: binding.system,
        role: binding.role,
        status: binding.status,
        reason: binding.reason,
      });
    }
  }
  if (unbound.length === 0) return;
  const systems = [
    ...new Set(unbound.map((entry) => String(entry.system)).filter(Boolean)),
  ];
  throw new OntoCodeHarnessExecutionError(
    "candidate_integration_unbound",
    systems.length > 0
      ? `候选包不能交付：${systems.join("、")} 还没有真实可执行的工具绑定`
      : "候选包不能交付：存在没有真实可执行绑定的外部系统要求",
    {
      recoverable: true,
      retryable: false,
      details: { unbound, systems },
    },
  );
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
  assertCandidateIntegrationsBound(agents);
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
      };
    }),
  });
  const configContent = canonicalEvidenceJson({
    schema: "ontocode-candidate-config/v1",
    ontologyHash,
    environmentProfileVersionId: data.session.environmentProfileVersionId,
    toolBindings: agents.map((agent) => ({
      slug: agent.slug,
      tools: agent.tools,
      integrations: agent.integrations,
    })),
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
        validationJson: canonicalEvidenceJson({
          schema: "ontocode-candidate-validation/v1",
          passed: true,
          requiredArtifactKinds: [
            "agent_spec",
            "agent_code",
            "agent_manifest",
            "agent_config",
          ],
          agentCount: agents.length,
          executionOwnerCount: Object.keys(executionOwners).length,
          sandboxEvidenceIncluded: false,
          releaseEligible: false,
        }),
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
    // A clarification can arrive after Factory has emitted an in-memory
    // `agent.created` preview. Until the Job reaches a successful durable
    // delivery those previews are audit context, not publishable Agent
    // artifacts.
    ...(result.outcome === "succeeded"
      ? harnessAgentArtifacts(result, claim.jobId, data.job.kind)
      : []),
  ];
  const artifacts = inputs.map((input) =>
    persistHarnessArtifactVersion(tx, claim, data, changeSetId, input, now),
  );
  const candidate =
    data.job.kind === "build" && result.outcome === "succeeded"
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
          candidatePackageVersionId:
            boundPackageVersionId,
          candidateDependencyRoot: boundDependencyRoot,
          candidateHeadId: data.job.candidateHeadId ?? null,
          candidateHeadRevision: data.job.candidateHeadRevision ?? null,
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
          subjectType: candidateBound
            ? "candidate_package"
            : "harness_job",
          subjectId: boundPackageVersionId ?? claim.jobId,
          subjectDigest: boundDependencyRoot ?? receiptArtifact.blobHash,
          harnessJobId: claim.jobId,
          changeSetId,
          artifactVersionId: receiptArtifact.artifactVersionId,
        },
        visibility: "audit",
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
    candidateHeadId: candidate?.candidateHeadId ?? null,
    deliveryState: candidate ? "candidate_ready" : null,
  };
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
  return raw.normalize("NFKC").trim().slice(0, 8_000);
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
        ? getRuntimeTenantRegistrySnapshot(
            version.adapter.adapterRegistrySlug,
          )
        : undefined;
      if (
        !version ||
        !snapshot ||
        snapshot.selectedVersion !==
          version.adapter.adapterRegistryVersion
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
              adapterRegistrySlug:
                version?.adapter.adapterRegistrySlug ?? null,
              expectedAdapterRegistryVersion:
                version?.adapter.adapterRegistryVersion ?? null,
              selectedAdapterRegistryVersion:
                snapshot?.selectedVersion ?? null,
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
      const starts = tx
        .select({ id: ontocodeSessionEvents.id })
        .from(ontocodeSessionEvents)
        .where(
          and(
            eq(ontocodeSessionEvents.tenantId, claim.tenantId),
            eq(ontocodeSessionEvents.harnessJobId, claim.jobId),
            eq(ontocodeSessionEvents.type, "harness.job.started"),
          ),
        )
        .all().length;
      const attempt = starts + 1;
      const candidateFailure = exactCandidateTargetFailure(tx, data);
      if (candidateFailure) {
        const rejected = tx
          .update(ontocodeHarnessJobs)
          .set({
            status: "failed_recoverable",
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
            text: `Harness 未启动候选测试：${candidateFailure.message}`,
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
        .set({ status: "running", updatedAt: now })
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

  private async appendProgress(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    type: string,
    payload: Record<string, unknown>,
    visibility: "user" | "debug" | "audit" = "user",
  ): Promise<void> {
    const now = new Date(this.now());
    getDb().transaction((tx) => {
      const owned = tx
        .select({ id: ontocodeHarnessJobs.id })
        .from(ontocodeHarnessJobs)
        .where(
          and(
            eq(ontocodeHarnessJobs.tenantId, claim.tenantId),
            eq(ontocodeHarnessJobs.id, claim.jobId),
            eq(ontocodeHarnessJobs.status, "running"),
            eq(ontocodeHarnessJobs.startedAt, new Date(claim.leaseToken)),
          ),
        )
        .get();
      if (!owned) throw new OntoCodeHarnessLostLeaseError(claim.jobId);
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
            candidateHeadId: persisted.candidateHeadId,
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
            receipt: result.receipt,
            artifacts: persisted.artifacts,
            evidenceId: persisted.evidenceId,
            evidenceOutcome: persisted.evidenceOutcome,
            candidatePackageVersionId: persisted.candidatePackageVersionId,
            candidateHeadId: persisted.candidateHeadId,
            deliveryState: persisted.deliveryState,
          },
        },
        now,
      );
    });
  }

  private finalizeWaiting(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    attempt: number,
    result: OntoCodeHarnessExecutorResult,
  ): void {
    const now = new Date(this.now());
    const message =
      result.message?.trim() ||
      "The Harness needs additional user input before it can continue.";
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
            candidateHeadId: persisted.candidateHeadId,
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
            candidateHeadId: persisted.candidateHeadId,
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

  private finalizeFailure(
    claim: OntoCodeHarnessClaim,
    data: ReturnType<OntoCodeHarnessWorkerAdapter["loadContext"]>,
    attempt: number,
    failure: NormalizedExecutionFailure,
  ): void {
    const retry = failure.retryable && attempt < this.maxAttempts;
    const status: OntoCodeHarnessJob["status"] = retry
      ? "retry_scheduled"
      : failure.recoverable
        ? "failed_recoverable"
        : "failed_terminal";
    const now = new Date(this.now());
    getDb().transaction((tx) => {
      const update = tx
        .update(ontocodeHarnessJobs)
        .set({
          status,
          errorMessage: failure.message,
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
            error: {
              code: failure.code,
              message: failure.message,
              recoverable: failure.recoverable,
              retryable: failure.retryable,
              ...(failure.details ? { details: failure.details } : {}),
            },
            ...(retry ? { retryAfterMs: this.retryDelayMs } : {}),
          },
          causationId: `${claim.jobId}:${claim.leaseToken}:${status}`,
        },
        now,
      );
      if (!retry) {
        appendAssistantMessage(
          tx,
          {
            tenantId: claim.tenantId,
            sessionId: claim.sessionId,
            jobId: claim.jobId,
            commandId: data.command?.id ?? null,
            leaseToken: claim.leaseToken,
            type: "error",
            text: `Harness 无法完成 ${data.job.kind}：${failure.message}`,
            content: {
              kind: data.job.kind,
              status,
              error: {
                code: failure.code,
                message: failure.message,
                recoverable: failure.recoverable,
                retryable: failure.retryable,
                ...(failure.details ? { details: failure.details } : {}),
              },
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
    };

    try {
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
      const result = await Promise.race([
        Promise.resolve().then(() => executor(executionContext)),
        abortPromise,
      ]);
      if (result.outcome === "waiting_user") {
        this.finalizeWaiting(claim, data, attempt, result);
        // The OntoCode receipt/evidence transaction is now committed. Only
        // after that durable handoff do we stop the parked Factory run, so a
        // server crash cannot leave the user with neither a prompt nor a run.
        const factoryRunId = nonEmptyString(result.receipt.factoryRunId);
        if (factoryRunId) {
          this.stopFactoryRun(factoryRunId, claim.tenantId);
        }
      } else {
        this.finalizeSuccess(claim, data, attempt, result);
      }
    } catch (error) {
      if (
        error instanceof OntoCodeHarnessLostLeaseError ||
        abortReason instanceof OntoCodeHarnessLostLeaseError
      ) {
        return { claimed: true, jobId: claim.jobId, status: "lost_lease" };
      }
      try {
        this.finalizeFailure(claim, data, attempt, normalizeFailure(error));
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
}

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
function compactFactoryReadiness(
  event: Extract<BrainEvent, { t: "tool.result" }>,
): CompactFactoryReadiness | null {
  if (
    event.name !== "inspect_all_action_readiness" ||
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
  const totals = asRecord(root?.totals);
  if (!root || !totals || root.readOnly !== true) return null;

  const actions = Array.isArray(root.actions)
    ? root.actions.slice(0, 200).flatMap((rawAction) => {
        const action = asRecord(rawAction);
        const actionName = boundedText(action?.action, 200);
        const stages = asRecord(action?.stages);
        const blockers = asRecord(action?.blockers);
        const integration = asRecord(blockers?.integration);
        if (!actionName || !stages) return [];
        const unresolvedBindings = Array.isArray(
          integration?.unresolvedBindings,
        )
          ? integration.unresolvedBindings.slice(0, 200).flatMap((raw) => {
              const binding = asRecord(raw);
              const requirementId = boundedText(binding?.requirementId, 240);
              const system = boundedText(binding?.system, 240);
              const status = boundedText(binding?.status, 100);
              const reason = boundedText(binding?.reason, 2_000);
              if (!requirementId || !system || !status || !reason) return [];
              return [
                {
                  requirementId,
                  system,
                  kind: boundedText(binding?.kind, 120),
                  role: boundedText(binding?.role, 120),
                  status,
                  executionSurface: boundedText(binding?.executionSurface, 240),
                  reason,
                } satisfies CompactFactoryReadinessBinding,
              ];
            })
          : [];
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
      })
    : [];

  const numeric = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : 0;
  return {
    schema: "ontocode-factory-readiness/v1",
    source: boundedText(root.source, 240),
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
  };
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

function clarificationAssistantText(
  event: Extract<BrainEvent, { t: "clarify" }>,
): string {
  const lines = [`Agent Factory 需要你的回答：${event.question.trim()}`];
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
  if (event.interactionId) {
    lines.push(`交互编号：${event.interactionId}`);
  }
  return lines.join("\n");
}

const CONFIG_QUESTION_PATTERN = /凭证|密钥|未配置|credential|api[\s_-]?key/i;
// System-ish identifiers such as "GoHire_System" / "Internal_Recruitment_System".
const SYSTEMISH_TOKEN_PATTERN = /\b[A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;

interface WaitingReadinessGap {
  actionName: string;
  requirementId: string;
  system: string;
  requirementKind: string | null;
  requirementRole: string | null;
  status: string;
  executionSurface: string | null;
  reason: string | null;
}

/**
 * Reads the compact readiness section of a waiting Harness receipt back into
 * the unresolved integration bindings it asserts. This is the only structured
 * credential-gap source; prose never authorizes configuration surfaces.
 */
function waitingReadinessGaps(
  receipt: Record<string, unknown>,
): WaitingReadinessGap[] {
  const readiness = asRecord(receipt.readiness);
  if (
    !readiness ||
    readiness.schema !== "ontocode-factory-readiness/v1" ||
    !Array.isArray(readiness.actions)
  ) {
    return [];
  }
  const gaps: WaitingReadinessGap[] = [];
  for (const rawAction of readiness.actions.slice(0, 200)) {
    const action = asRecord(rawAction);
    const actionName = nonEmptyString(action?.action);
    if (!action || !actionName || action.ready === true) continue;
    const bindings = Array.isArray(action.unresolvedBindings)
      ? action.unresolvedBindings
      : [];
    for (const rawBinding of bindings.slice(0, 200)) {
      const binding = asRecord(rawBinding);
      const requirementId = nonEmptyString(binding?.requirementId);
      const system = nonEmptyString(binding?.system);
      const status = nonEmptyString(binding?.status);
      if (!binding || !requirementId || !system || !status) continue;
      if (status === "resolved") continue;
      gaps.push({
        actionName,
        requirementId,
        system,
        requirementKind: nonEmptyString(binding.kind),
        requirementRole: nonEmptyString(binding.role),
        status,
        executionSurface: nonEmptyString(binding.executionSurface),
        reason: nonEmptyString(binding.reason),
      });
    }
  }
  return gaps;
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
  const gaps = waitingReadinessGaps(receipt);
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
  const systems = [
    ...new Set([
      ...(isConfig ? gaps.map((gap) => gap.system) : []),
      ...messageTokens,
    ]),
  ]
    .slice(0, 20)
    .map((system) => system.slice(0, 200));

  const options = Array.isArray(interaction?.options)
    ? interaction.options.slice(0, 12).flatMap((rawOption) => {
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
      })
    : [];
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
    allowOther: true,
    ...(impact ? { impact } : {}),
    systems,
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
  const gaps = waitingReadinessGaps(input.receipt);
  const gap = gaps.find(
    (candidate) =>
      candidate.status === "missing" &&
      candidate.executionSurface === null &&
      candidate.requirementKind === "external_api" &&
      candidate.requirementRole !== null &&
      // The store requires the requirement to be unambiguous in the receipt.
      gaps.filter(
        (other) =>
          other.actionName === candidate.actionName &&
          other.requirementId === candidate.requirementId,
      ).length === 1,
  );
  if (!gap) return null;
  const ctx = { tenantId: input.tenantId, actorId: input.actorId };
  const session = getOntoCodeSession(ctx, input.sessionId);
  const created = createOntoCodeConfigurationTask(ctx, input.sessionId, {
    expectedSessionRevision: session.revision,
    waitingHarnessJobId: input.jobId,
    sourceRequirementId: gap.requirementId,
    sourceActionName: gap.actionName,
    blockerKey: `integration:${gap.requirementId}`.slice(0, 240),
    title: `为 ${gap.system} 提供可执行的 Tool/API 契约`.slice(0, 300),
    target: {
      kind: "tool",
      system: gap.system,
      desiredToolName: null,
      requirementKind: gap.requirementKind,
      requirementRole: gap.requirementRole,
    },
    requirement: {
      summary:
        `动作「${gap.actionName}」缺少覆盖 ${gap.system}（${gap.requirementKind}/${gap.requirementRole}）的已授权 Tool，Harness 已暂停等待配置。`.slice(
          0,
          4_000,
        ),
      reason: gap.reason,
      missingFields: [],
      sourceRefs: [
        `harness-job:${input.jobId}`,
        `ontology-action:${gap.actionName}`,
        `integration-requirement:${gap.requirementId}`,
      ],
    },
    verificationPolicy: { kind: "tool_contract" },
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
}

const DEFAULT_FACTORY_RUN_RUNTIME: OntoCodeFactoryRunRuntime = {
  startRun,
  subscribeRun,
  abortRun,
};

export async function runFactoryBuild(
  input: OntoCodeFactoryBuildInput,
  runtime: OntoCodeFactoryRunRuntime = DEFAULT_FACTORY_RUN_RUNTIME,
): Promise<OntoCodeFactoryBuildResult> {
  const runId = `ocf-${input.jobId}-a${input.attempt}`;
  const agents = new Map<
    string,
    {
      slug: string;
      actionName: string;
      name: string;
      card: Record<string, unknown>;
      design: Record<string, unknown> | null;
      generatedCode: string | null;
    }
  >();
  let sandbox: Record<string, unknown> | null = null;
  let readiness: CompactFactoryReadiness | null = null;
  let lastError: string | null = null;
  let lastMessage: string | null = null;

  runtime.startRun({
    domain: input.domain,
    goal: input.goal,
    persistGoal: input.goal,
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    ontologyDomainRegistrationId: input.ontologyDomainRegistrationId,
    runtimeProfileVersionId: input.runtimeProfileVersionId,
    confirmedActor: input.actorId ?? undefined,
    conversationId: runId,
    runId,
    interactionPolicy: input.interactionPolicy,
    generationDirective: input.directive,
  });

  return new Promise<OntoCodeFactoryBuildResult>((resolve, reject) => {
    let settled = false;
    let waitingForUser = false;
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
      progressTail = progressTail
        .then(() => input.onProgress(type, payload, visibility))
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
    // The Factory brain streams a real harness loop: reasoning tokens, tool
    // calls with their stated reason, heartbeats, tool results. Until now this
    // bridge forwarded only stage markers, agent.created, sandbox and the rare
    // readiness-bearing tool.result — so an OntoCode Session recorded a handful
    // of coarse phase events and the reasoning panel had nothing to show. The
    // work was happening; the evidence was being thrown away at this boundary.
    //
    // Two constraints shape what follows:
    //  · `think` arrives per token. Persisting each delta as a row would be
    //    absurd, so deltas are buffered and flushed at a real boundary (a tool
    //    call, a result, or a size threshold) — one row per reasoning burst.
    //  · Everything is bounded, and a hit bound SAYS SO. A silently truncated
    //    trace reads as "the brain did this little", which is a lie about the
    //    run. When the budget runs out we emit one explicit notice and stop.
    const TELEMETRY_BUDGET = 400;
    const THINK_FLUSH_CHARS = 1_200;
    let telemetryEmitted = 0;
    let telemetryExhausted = false;
    let thinkBuffer = "";
    let thinkTurns = 0;

    /** Bounded emit. Returns false once the budget is spent, having said so once. */
    const emitTelemetry = (
      type: string,
      payload: Record<string, unknown>,
    ): boolean => {
      if (telemetryExhausted) return false;
      if (telemetryEmitted >= TELEMETRY_BUDGET) {
        telemetryExhausted = true;
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

    /** Flush the buffered reasoning burst as one frame. */
    const flushThinking = (): void => {
      const text = thinkBuffer.trim();
      thinkBuffer = "";
      if (!text) return;
      thinkTurns += 1;
      emitTelemetry(`harness.${input.operation}.thinking`, {
        factoryRunId: runId,
        turn: thinkTurns,
        text: text.slice(0, 4_000),
        truncated: text.length > 4_000,
      });
    };

    /** Compact a tool argument blob to something a human can read in a log row.
     *  Never the full payload: a resume base64 would bury the trace. */
    const compactToolInput = (value: unknown): string | null => {
      if (value == null) return null;
      let text: string;
      try {
        text = typeof value === "string" ? value : JSON.stringify(value);
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
        if (settled || waitingForUser || event.t === "run.started") return;
        // #HARNESS-TELEMETRY — the real loop, bridged. Reasoning first: buffer
        // the token stream and let a tool boundary decide where a burst ends.
        if (event.t === "think") {
          thinkBuffer += event.delta;
          if (thinkBuffer.length >= THINK_FLUSH_CHARS) flushThinking();
          return;
        }
        if (event.t === "tool.call") {
          flushThinking();
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
          flushThinking();
          queueProgress(`harness.${input.operation}.stage`, {
            factoryRunId: runId,
            stage: event.stage,
            status: event.status,
            detail: event.detail ?? null,
          });
          return;
        }
        if (event.t === "agent.created") {
          agents.set(event.spec.slug, {
            slug: event.spec.slug,
            actionName: event.spec.actionName,
            name: event.spec.nameZh || event.spec.short,
            card: { ...event.spec },
            design: event.design ? { ...event.design } : null,
            generatedCode: nonEmptySourceText(event.design?.code),
          });
          queueProgress(`harness.${input.operation}.agent_created`, {
            factoryRunId: runId,
            agent: {
              slug: event.spec.slug,
              actionName: event.spec.actionName,
              name: event.spec.nameZh || event.spec.short,
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
          queueProgress(`harness.${input.operation}.test_cases`, {
            factoryRunId: runId,
            count: event.cases.length,
            awaitingApproval: event.awaitingApproval,
            coverage: event.coverage ?? null,
          });
          return;
        }
        if (event.t === "tool.result") {
          flushThinking();
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
          return;
        }
        if (event.t === "clarify" && event.awaitingAnswer) {
          flushThinking();
          waitingForUser = true;
          const options = (event.options ?? []).map((option) => ({
            ...option,
          }));
          const interaction = {
            kind: "clarify",
            awaitingAnswer: true,
            interactionId: event.interactionId ?? null,
            question: event.question,
            options,
            context: event.context ?? null,
          };
          queueProgress(`harness.${input.operation}.clarification`, {
            factoryRunId: runId,
            ...interaction,
          });
          void progressTail
            .then(() => {
              succeed({
                outcome: "waiting_user",
                message: clarificationAssistantText(event),
                receipt: {
                  factoryRunId: runId,
                  status: "waiting_human",
                  completionKind: "awaiting_input",
                  actionIds: [...input.directive.requestedActionIds],
                  actionNames: [...input.directive.requestedActionNames],
                  agents: [...agents.values()],
                  sandbox,
                  readiness,
                  interaction,
                },
              });
            })
            .catch(fail);
          return;
        }
        if (event.t === "error") {
          flushThinking();
          lastError = event.message.slice(0, 2_000);
          // A brain-level error used to be captured for the failure message and
          // otherwise vanish, so an FDE watching a run saw nothing go wrong
          // until the whole job ended.
          emitTelemetry(`harness.${input.operation}.brain_error`, {
            factoryRunId: runId,
            message: lastError,
          });
          return;
        }
        if (event.t === "message") {
          flushThinking();
          const text = event.text.trim();
          if (text) {
            lastMessage = text.slice(0, 8_000);
            // The brain's own narration. Only the final one used to survive,
            // as the job message; every intermediate explanation was dropped.
            emitTelemetry(`harness.${input.operation}.narration`, {
              factoryRunId: runId,
              text: lastMessage,
            });
          }
          return;
        }
        if (event.t !== "done") return;
        flushThinking();
        // A dropped telemetry row is reported, never swallowed. Otherwise a
        // partial trace reads as a complete one — the same lie as a silent cap.
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

        void progressTail
          .then(async () => {
            const capturedAgents = [...agents.values()];
            const durableAgents: Array<Record<string, unknown>> = [];
            if (
              event.status === "finished" &&
              event.completionKind === "delivery"
            ) {
              const drafts = await makeFactoryPorts(
                input.tenantSlug,
                input.tenantId,
                input.domain,
                input.actorId ?? undefined,
                input.ontologyDomainRegistrationId,
                input.runtimeProfileVersionId,
              ).drafts?.list(input.domain);
              for (const captured of capturedAgents) {
                const draft = drafts?.find(
                  (candidate) => candidate.slug === captured.slug,
                );
                if (!draft) {
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
              if (durableAgents.length === 0) {
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
            }
            const receipt: Record<string, unknown> = {
              factoryRunId: runId,
              status: event.status,
              completionKind: event.completionKind,
              actionIds: [...input.directive.requestedActionIds],
              actionNames: [...input.directive.requestedActionNames],
              agents: durableAgents.length > 0 ? durableAgents : capturedAgents,
              sandbox,
              readiness,
              usage: {
                tokensUsed: event.tokensUsed,
                conversationTokensUsed:
                  event.conversationTokensUsed ?? event.tokensUsed,
                turns: event.turns,
              },
            };
            if (event.status === "waiting_human") {
              succeed({
                outcome: "waiting_user",
                message:
                  "Agent Factory needs an FDE decision or configuration before continuing",
                receipt,
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
                  "Agent Factory returned guidance instead of a deliverable and needs an FDE decision before Build can continue.",
                receipt: {
                  ...receipt,
                  status: "waiting_human",
                  interaction: {
                    kind: "legacy_answer",
                    awaitingAnswer: true,
                    question:
                      lastMessage ??
                      "Review the Factory guidance and provide the missing decision.",
                  },
                },
              });
              return;
            }
            fail(
              new OntoCodeHarnessExecutionError(
                "factory_build_incomplete",
                lastError ||
                  `Agent Factory ended with ${event.status}/${event.completionKind}`,
                {
                  recoverable: true,
                  retryable: false,
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
      const [tools, capabilityProviders, systemAliasGroups] = await Promise.all([
        ports.toolRegistry ? ports.toolRegistry.list() : Promise.resolve([]),
        ports.integrationCapabilities
          ? ports.integrationCapabilities.list()
          : Promise.resolve([]),
        ports.systemAliases ? ports.systemAliases.list() : Promise.resolve([]),
      ]);
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
      runtimeProfileVersionId:
        context.job.runtimeProfileVersionId ?? null,
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
    failOntoCodeSandboxAttempt(
      { tenantId: context.job.tenantId },
      attempt.id,
      {
        status,
        code:
          block?.code ??
          (error instanceof OntoCodeHarnessExecutionError
            ? error.code
            : "sandbox_execution_failed"),
        message: error instanceof Error ? error.message : String(error),
      },
    );
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
    ontologyDomainRegistrationId:
      context.project.ontologyDomainRegistrationId,
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

  const failureSummary =
    nonEmptyString(context.command?.arguments.failureSummary) ??
    nonEmptyString(context.command?.arguments.error);
  if (kind === "debug" && !failureSummary) {
    return {
      outcome: "waiting_user",
      phase: "debug",
      message:
        "Provide the failing test/run evidence or a concise failureSummary before automatic debugging",
      receipt: {
        schema: "ontocode-debug-input-request/v1",
        ontologyHash,
        requiredConfiguration: ["failureSummary"],
        acceptedEvidence: [
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
  await context.progress(`harness.${kind}.factory_started`, {
    ontologyHash,
    sourceFactoryRunId: nonEmptyString(priorBuild?.factoryRunId),
    actionIds: [...directive.requestedActionIds],
    actionNames: [...directive.requestedActionNames],
  });
  const result = await factory.runBuild({
    jobId: context.job.id,
    attempt: context.attempt,
    operation: kind,
    tenantId: context.job.tenantId,
    tenantSlug: context.tenantSlug,
    domain: context.project.domain,
    ontologyDomainRegistrationId:
      context.project.ontologyDomainRegistrationId,
    runtimeProfileVersionId:
      context.job.runtimeProfileVersionId ?? null,
    goal: `${factoryGenerationGoal(directive, context.session.goal)}\n\n[OntoCode ${kind} iteration]\n${operationGoal}`,
    actorId: context.job.createdBy,
    interactionPolicy:
      context.session.autonomyMode === "sandbox_autopilot"
        ? "autopilot"
        : "strict",
    directive,
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
      const receipt = await analyzeOntology(ontology, {
        ontologyHash,
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
      const confirmed = receipt.findings.filter(
        (f) => f.verdict === "confirmed",
      ).length;
      return {
        outcome: "succeeded",
        receipt: receipt as unknown as Record<string, unknown>,
        message:
          `已分析 ${receipt.structure.counts.objects} 个对象 · ${receipt.structure.counts.links} 条真实关系边，得出 ${confirmed} 条可核查结论。`
          + (receipt.toolRequirements
            ? ` 工具需求 ${receipt.toolRequirements.total} 条：已覆盖 ${receipt.toolRequirements.covered}，待配置 ${receipt.toolRequirements.needsConfig}，待选 ${receipt.toolRequirements.ambiguous}，真缺 ${receipt.toolRequirements.gaps}${receipt.toolRequirements.gaps ? `（${receipt.toolRequirements.gapSystems.join("、")}）` : ""}。`
            : " 本次未读到工具目录，缺哪些工具未作判断。")
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
      const open = listOntoCodeConfigurationTasks(storeCtx, context.session.id, {
        limit: 50,
        offset: 0,
      }).items.filter((task) =>
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
                .map((entry) => `${entry.title}（${entry.detail ?? entry.reasonCode ?? "原因未知"}）`)
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
            eq(ontocodePackageVersions.id, preflight.candidate.packageVersionId),
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
      const scenario =
        nonEmptyString(context.command?.arguments.scenario) ??
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
          });
      assertFactoryScopeRecommendationCurrent({
        scopeKey,
        domain: context.project.domain,
        ontology,
        scenario,
        recommendationId: recommendation.recommendationId,
        ontologyHash: recommendation.ontologyHash,
      });
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
      });
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
          model,
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
      await context.progress("harness.build.factory_started", {
        ontologyHash,
        mode: directive.mode,
        actionIds: [...directive.requestedActionIds],
        actionNames: [...directive.requestedActionNames],
      });
      const result = await factory.runBuild({
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
        signal: context.signal,
        onProgress: (type, payload, visibility) =>
          context.progress(type, payload, visibility),
      });
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
          ...result.receipt,
        },
      };
    },

    test: (context) => executeExactCandidateTest(factory, context, "test"),
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
    this.concurrency =
      Number.isFinite(configured) && configured >= 1
        ? Math.min(Math.floor(configured), 8)
        : 3;
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
