import { randomUUID } from "node:crypto";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeCommands,
  ontocodeConfigurationTasks,
  ontocodeHarnessJobs,
  ontocodeSessionEvents,
  ontocodeSessions,
  tenantScope,
} from "@agentic/db";
import { canonicalEvidenceJson } from "@agentic/shared";
import {
  ONTOCODE_COMMAND_POLICY,
  OntoCodeConfigurationTaskSchema,
  OntoCodeConfigurationVerificationResultSchema,
  OntoCodeSessionEventSchema,
  type CancelOntoCodeConfigurationTaskRequest,
  type CreateOntoCodeConfigurationTaskRequest,
  type ListOntoCodeConfigurationTasksQuery,
  type OntoCodeConfigurationTask,
  type OntoCodeConfigurationTaskCancelReceipt,
  type OntoCodeConfigurationTaskCreateReceipt,
  type OntoCodeConfigurationTaskListReceipt,
  type OntoCodeConfigurationTaskVerifyReceipt,
  type OntoCodeConfigurationVerificationResult,
  type OntoCodeSessionEvent,
  type VerifyOntoCodeConfigurationTaskRequest,
} from "@agentic/contracts";
import {
  createOntoCodeTurn,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
} from "./ontocode-session-store";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

type CreateTaskInput = Omit<
  CreateOntoCodeConfigurationTaskRequest,
  "idempotencyKey"
> & {
  idempotencyKey: string;
};

type CancelTaskInput = Omit<
  CancelOntoCodeConfigurationTaskRequest,
  "idempotencyKey"
> & {
  idempotencyKey: string;
};

type VerifyTaskInput = Omit<
  VerifyOntoCodeConfigurationTaskRequest,
  "idempotencyKey"
> & {
  idempotencyKey: string;
};

export interface OntoCodeConfigurationTaskVerifier {
  verify(input: { task: OntoCodeConfigurationTask }): Promise<
    Omit<OntoCodeConfigurationVerificationResult, "checkedAt"> & {
      checkedAt?: number;
    }
  >;
}

let registeredVerifier: OntoCodeConfigurationTaskVerifier | null = null;

/**
 * Bootstrap seam for the future real verifier. Registering a verifier does
 * not grant it authority to resume Harness; this P0 store only records a
 * bounded verification receipt.
 */
export function setOntoCodeConfigurationTaskVerifier(
  verifier: OntoCodeConfigurationTaskVerifier | null,
): void {
  registeredVerifier = verifier;
}

function opaqueTaskId(): string {
  return `ocfg-${randomUUID().replaceAll("-", "")}`;
}

function eventId(): string {
  return `oce-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function normalizeSha256(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_configuration_task_corrupt",
      "A Configuration Task contains invalid persisted JSON",
      500,
    );
  }
}

function taskFromRow(
  row: typeof ontocodeConfigurationTasks.$inferSelect,
): OntoCodeConfigurationTask {
  return OntoCodeConfigurationTaskSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    sourceCommandId: row.sourceCommandId ?? null,
    waitingHarnessJobId: row.waitingHarnessJobId ?? null,
    sourceRequirementId: row.sourceRequirementId ?? null,
    sourceActionName: row.sourceActionName ?? null,
    sourceReceiptDigest: row.sourceReceiptDigest ?? null,
    blockerKey: row.blockerKey,
    title: row.title,
    target: parseJson(row.targetJson),
    requirement: parseJson(row.requirementJson),
    verificationPolicy: parseJson(row.verificationPolicyJson),
    resumeAction: row.resumeAction ?? null,
    ontologyHash: row.ontologyHash,
    status: row.status,
    revision: row.revision,
    lastVerification: row.lastVerificationJson
      ? parseJson(row.lastVerificationJson)
      : null,
    resolutionNote: row.resolutionNote ?? null,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    verificationStartedAt: timestamp(row.verificationStartedAt),
    verifiedAt: timestamp(row.verifiedAt),
    cancelledAt: timestamp(row.cancelledAt),
  });
}

function eventFromRow(
  row: typeof ontocodeSessionEvents.$inferSelect,
): OntoCodeSessionEvent {
  return OntoCodeSessionEventSchema.parse({
    id: row.id,
    seq: row.seq,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    harnessJobId: row.harnessJobId ?? null,
    commandId: row.commandId ?? null,
    correlationId: row.correlationId,
    causationId: row.causationId ?? null,
    type: row.type,
    visibility: row.visibility,
    payload: parseJson(row.payloadJson),
    createdAt: timestamp(row.createdAt),
  });
}

function requireTaskRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  taskId: string,
): typeof ontocodeConfigurationTasks.$inferSelect {
  const row = db
    .select()
    .from(ontocodeConfigurationTasks)
    .where(
      tenantScope(
        ctx,
        ontocodeConfigurationTasks,
      )(eq(ontocodeConfigurationTasks.id, taskId)),
    )
    .get();
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_task_not_found",
      "Configuration Task not found",
      404,
    );
  }
  return row;
}

function requireSessionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): typeof ontocodeSessions.$inferSelect {
  const row = db
    .select()
    .from(ontocodeSessions)
    .where(
      tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
    )
    .get();
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_session_not_found",
      "OntoCode Session not found",
      404,
    );
  }
  return row;
}

function nextEventSeq(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): number {
  const latest = db
    .select({ seq: ontocodeSessionEvents.seq })
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(eq(ontocodeSessionEvents.sessionId, sessionId)),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .limit(1)
    .get();
  return (latest?.seq ?? 0) + 1;
}

function appendTaskEvent(
  db: DbLike,
  ctx: OntoCodeStoreContext,
  input: {
    task: OntoCodeConfigurationTask;
    type: string;
    payload: Record<string, unknown>;
    causationId: string;
  },
  now: Date,
): OntoCodeSessionEvent {
  const row: typeof ontocodeSessionEvents.$inferInsert = {
    id: eventId(),
    tenantId: ctx.tenantId,
    projectId: input.task.projectId,
    sessionId: input.task.sessionId,
    seq: nextEventSeq(db, ctx, input.task.sessionId),
    type: input.type,
    visibility: "user",
    payloadJson: canonicalEvidenceJson(input.payload),
    commandId: input.task.sourceCommandId,
    harnessJobId: input.task.waitingHarnessJobId,
    correlationId: input.task.id,
    causationId: input.causationId,
    createdAt: now,
  };
  db.insert(ontocodeSessionEvents).values(row).run();
  return eventFromRow(row as typeof ontocodeSessionEvents.$inferSelect);
}

function sessionRevision(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): number {
  return requireSessionRow(db, ctx, sessionId).revision;
}

function bumpSessionRevision(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  now: Date,
  expectedRevision?: number,
): number {
  const predicate =
    expectedRevision === undefined
      ? eq(ontocodeSessions.id, sessionId)
      : and(
          eq(ontocodeSessions.id, sessionId),
          eq(ontocodeSessions.revision, expectedRevision),
        );
  const result = db
    .update(ontocodeSessions)
    .set({
      revision: sql`${ontocodeSessions.revision} + 1`,
      updatedAt: now,
    })
    .where(tenantScope(ctx, ontocodeSessions)(predicate))
    .run();
  if (result.changes !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_revision_conflict",
      "The OntoCode Session changed before the Configuration Task update",
      409,
      expectedRevision === undefined ? undefined : { expectedRevision },
    );
  }
  return sessionRevision(db, ctx, sessionId);
}

const LITERAL_SECRET =
  /(?:bearer\s+[a-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|password|client[_ -]?secret|authorization)\s*[:=]\s*[^\s,;]{8,})/i;

/**
 * Contracts deliberately contain no value bag. This second server boundary
 * rejects obvious credential literals accidentally pasted into labels,
 * summaries, refs, or manual instructions.
 */
function assertSecretFree(value: unknown, path = "configurationTask"): void {
  if (typeof value === "string") {
    if (LITERAL_SECRET.test(value)) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_task_secret_rejected",
        `Credential-like literal rejected at ${path}; Configuration Tasks may store field shapes and references only`,
        400,
        { path },
      );
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          throw new OntoCodeStoreError(
            "ontocode_configuration_task_secret_rejected",
            `Credential-bearing URL rejected at ${path}`,
            400,
            { path },
          );
        }
      } catch (error) {
        if (error instanceof OntoCodeStoreError) throw error;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSecretFree(item, `${path}.${key}`);
    }
  }
}

function validateTargetPolicy(input: CreateTaskInput): void {
  const { target, verificationPolicy: policy } = input;
  const allowedPolicyKinds: Record<
    typeof target.kind,
    Array<typeof policy.kind>
  > = {
    integration: ["derived_requirement", "manual_external"],
    system_profile: ["system_probe", "manual_external"],
    tool: ["tool_contract", "manual_external"],
    tool_profile: ["tool_profile", "manual_external"],
    llm_gateway: ["gateway_configuration", "manual_external"],
    environment: ["environment_presence", "manual_external"],
  };
  if (!allowedPolicyKinds[target.kind].includes(policy.kind)) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_target_policy_mismatch",
      `Verification policy ${policy.kind} cannot verify a ${target.kind} target`,
      400,
    );
  }
  if (
    target.kind === "integration" &&
    policy.kind === "derived_requirement" &&
    target.provider !== policy.provider
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_target_policy_mismatch",
      "Integration target and derived-requirement provider must match",
      400,
    );
  }
  if (
    target.kind === "system_profile" &&
    policy.kind === "system_probe" &&
    target.profileId !== policy.profileId
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_target_policy_mismatch",
      "System-profile target and verification policy must bind the same profile",
      400,
    );
  }
  if (
    target.kind === "tool_profile" &&
    policy.kind === "tool_profile" &&
    (target.toolName !== policy.toolName ||
      target.environment !== policy.environment ||
      target.profileKey !== policy.profileKey)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_target_policy_mismatch",
      "Tool-profile target and verification policy must bind the same tool, environment, and profile key",
      400,
    );
  }
  if (
    target.kind === "environment" &&
    policy.kind === "environment_presence" &&
    canonicalEvidenceJson([...target.envRefs].sort()) !==
      canonicalEvidenceJson([...policy.envRefs].sort())
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_target_policy_mismatch",
      "Environment target and verification policy must bind the same env refs",
      400,
    );
  }
}

function comparableCreateInput(input: CreateTaskInput): string {
  return canonicalEvidenceJson({
    sourceCommandId: input.sourceCommandId ?? null,
    waitingHarnessJobId: input.waitingHarnessJobId ?? null,
    sourceRequirementId: input.sourceRequirementId ?? null,
    sourceActionName: input.sourceActionName ?? null,
    blockerKey: input.blockerKey,
    title: input.title,
    target: input.target,
    requirement: input.requirement,
    verificationPolicy: input.verificationPolicy,
    resumeAction: input.resumeAction ?? null,
    ontologyHash: normalizeSha256(input.ontologyHash),
  });
}

function comparableTask(task: OntoCodeConfigurationTask): string {
  return canonicalEvidenceJson({
    sourceCommandId: task.sourceCommandId,
    waitingHarnessJobId: task.waitingHarnessJobId,
    sourceRequirementId: task.sourceRequirementId,
    sourceActionName: task.sourceActionName,
    blockerKey: task.blockerKey,
    title: task.title,
    target: task.target,
    requirement: task.requirement,
    verificationPolicy: task.verificationPolicy,
    resumeAction: task.resumeAction,
    ontologyHash: normalizeSha256(task.ontologyHash),
  });
}

function findTaskEvent(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  task: OntoCodeConfigurationTask,
  type: string,
): OntoCodeSessionEvent | null {
  const row = db
    .select()
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, task.sessionId),
          eq(ontocodeSessionEvents.type, type),
          eq(ontocodeSessionEvents.causationId, task.id),
        ),
      ),
    )
    .orderBy(desc(ontocodeSessionEvents.seq))
    .limit(1)
    .get();
  return row ? eventFromRow(row) : null;
}

interface WaitingReceiptBinding {
  requirementId: string;
  actionName: string;
  system: string;
  kind: string | null;
  role: string | null;
  status: string;
  executionSurface: string | null;
  reason: string;
  receiptDigest: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A waiting Job row only proves lifecycle state. Configuration authority comes
 * from the compact readiness section in its immutable Harness receipt.
 */
function requireWaitingReceiptBinding(
  db: DbLike,
  ctx: OntoCodeStoreContext,
  sessionId: string,
  waitingJob: typeof ontocodeHarnessJobs.$inferSelect,
  input: CreateTaskInput,
  ontologyHash: string,
): WaitingReceiptBinding {
  const requirementId = input.sourceRequirementId;
  const actionName = input.sourceActionName;
  if (!requirementId || !actionName) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_receipt_binding_required",
      "A waiting Harness Configuration Task requires an exact source requirement and Ontology action",
      400,
    );
  }

  const artifact = db
    .select()
    .from(ontocodeArtifacts)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifacts,
      )(
        and(
          eq(ontocodeArtifacts.sessionId, sessionId),
          eq(
            ontocodeArtifacts.logicalName,
            `harness/${waitingJob.kind}/${waitingJob.id}/receipt.json`,
          ),
          eq(ontocodeArtifacts.kind, "harness_receipt"),
        ),
      ),
    )
    .get();
  if (!artifact) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_waiting_receipt_missing",
      "The waiting Harness Job has no immutable receipt to authorize this Configuration Task",
      409,
    );
  }
  const version = db
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactVersions,
      )(eq(ontocodeArtifactVersions.artifactId, artifact.id)),
    )
    .orderBy(desc(ontocodeArtifactVersions.version))
    .limit(1)
    .get();
  const blob = version
    ? db
        .select()
        .from(ontocodeArtifactBlobs)
        .where(
          tenantScope(
            ctx,
            ontocodeArtifactBlobs,
          )(eq(ontocodeArtifactBlobs.id, version.blobId)),
        )
        .get()
    : null;
  if (!version || !blob || blob.sha256 !== version.blobHash) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_waiting_receipt_corrupt",
      "The immutable waiting Harness receipt cannot be verified",
      500,
    );
  }

  const receipt = asRecord(parseJson(blob.contentText));
  const readiness = asRecord(receipt?.readiness);
  if (
    !receipt ||
    receipt.status !== "waiting_human" ||
    normalizeSha256(String(receipt.ontologyHash ?? "")) !== ontologyHash ||
    readiness?.schema !== "ontocode-factory-readiness/v1" ||
    !Array.isArray(readiness.actions)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_waiting_receipt_mismatch",
      "The immutable Harness receipt is not a snapshot-bound configuration readiness receipt",
      409,
    );
  }

  const authoritativeAction = readiness.actions
    .map(asRecord)
    .find((action) => action?.action === actionName);
  const authoritativeStages = asRecord(authoritativeAction?.stages);
  if (
    !authoritativeAction ||
    authoritativeStages?.sandbox === true ||
    !Array.isArray(authoritativeAction.unresolvedBindings)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_action_not_blocked",
      "The selected Ontology action has no sandbox-stage configuration blocker in the immutable readiness receipt",
      409,
    );
  }
  const matches = authoritativeAction.unresolvedBindings
    .map(asRecord)
    .filter((binding) => binding?.requirementId === requirementId);
  if (matches.length !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_requirement_mismatch",
      "The selected requirement is missing or ambiguous in the immutable readiness receipt",
      409,
    );
  }
  const authoritativeBinding = matches[0]!;
  const system =
    typeof authoritativeBinding.system === "string"
      ? authoritativeBinding.system.trim()
      : "";
  const status =
    typeof authoritativeBinding.status === "string"
      ? authoritativeBinding.status.trim()
      : "";
  const reason =
    typeof authoritativeBinding.reason === "string"
      ? authoritativeBinding.reason.trim()
      : "";
  const kind =
    typeof authoritativeBinding.kind === "string"
      ? authoritativeBinding.kind.trim() || null
      : null;
  const role =
    typeof authoritativeBinding.role === "string"
      ? authoritativeBinding.role.trim() || null
      : null;
  const executionSurface =
    typeof authoritativeBinding.executionSurface === "string"
      ? authoritativeBinding.executionSurface.trim() || null
      : null;
  const configuration = asRecord(authoritativeBinding.configuration);
  if (!system || !status || !reason || status === "resolved") {
    throw new OntoCodeStoreError(
      "ontocode_configuration_requirement_mismatch",
      "The immutable readiness receipt does not contain a current unresolved system binding",
      409,
    );
  }

  // `missing` + no execution surface means the Factory found no explicit Tool
  // capable of satisfying this API requirement. It is a Tool-authoring task,
  // not a credentials form for a guessed provider. Other blocker classes stay
  // fail-closed until the compact receipt carries an unambiguous provider or
  // Tool Profile identity.
  const missingToolIdentity =
    status === "missing" &&
    executionSurface === null &&
    kind === "external_api";
  const configuredToolName =
    configuration?.kind === "tool_profile" &&
    typeof configuration.toolName === "string"
      ? configuration.toolName.trim()
      : "";
  const configuredEnvironment =
    configuration?.environment === "sandbox" ||
    configuration?.environment === "production"
      ? configuration.environment
      : null;
  const configuredProfileKey =
    typeof configuration?.profileKey === "string"
      ? configuration.profileKey.trim()
      : "";
  const exactToolProfileIdentity =
    (status === "needs_config" || status === "needs_probe") &&
    executionSurface !== null &&
    configuredToolName === executionSurface &&
    configuredEnvironment !== null &&
    configuredProfileKey.length > 0;
  const targetMatches =
    (missingToolIdentity &&
      input.target.kind === "tool" &&
      input.target.system === system &&
      input.target.desiredToolName === null &&
      input.target.requirementKind === kind &&
      input.target.requirementRole === role &&
      input.verificationPolicy.kind === "tool_contract") ||
    (exactToolProfileIdentity &&
      input.target.kind === "tool_profile" &&
      input.target.toolName === configuredToolName &&
      input.target.environment === configuredEnvironment &&
      input.target.profileKey === configuredProfileKey &&
      input.verificationPolicy.kind === "tool_profile" &&
      input.verificationPolicy.toolName === configuredToolName &&
      input.verificationPolicy.environment === configuredEnvironment &&
      input.verificationPolicy.profileKey === configuredProfileKey);
  if (!targetMatches) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_target_receipt_mismatch",
      missingToolIdentity
        ? "This readiness receipt authorizes a Tool/API-contract task for the exact system; it does not authorize an Integration credential target"
        : exactToolProfileIdentity
          ? "This readiness receipt authorizes only the exact Tool Profile identity carried by the Factory"
          : "The immutable readiness receipt does not yet identify a safe concrete configuration surface for this blocker",
      409,
    );
  }

  return {
    requirementId,
    actionName,
    system,
    kind,
    role,
    status,
    executionSurface,
    reason,
    receiptDigest: version.blobHash,
  };
}

function assertTaskBindings(
  db: DbLike,
  ctx: OntoCodeStoreContext,
  session: typeof ontocodeSessions.$inferSelect,
  input: CreateTaskInput,
): string | null {
  const ontologyHash = normalizeSha256(input.ontologyHash);
  const sessionHash = session.ontologySnapshotHash
    ? normalizeSha256(session.ontologySnapshotHash)
    : null;
  if (!sessionHash || sessionHash !== ontologyHash) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_ontology_mismatch",
      "Configuration Task must bind the Session's exact pinned Ontology snapshot",
      409,
      {
        requestedOntologyHash: ontologyHash,
        sessionOntologyHash: sessionHash,
      },
    );
  }

  let sourceCommand: typeof ontocodeCommands.$inferSelect | undefined;
  if (input.sourceCommandId) {
    sourceCommand = db
      .select()
      .from(ontocodeCommands)
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(
          and(
            eq(ontocodeCommands.id, input.sourceCommandId),
            eq(ontocodeCommands.sessionId, session.id),
          ),
        ),
      )
      .get();
    if (!sourceCommand) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_command_mismatch",
        "The source Command does not belong to this tenant and Session",
        409,
      );
    }
    if (
      sourceCommand.baseOntologyHash &&
      normalizeSha256(sourceCommand.baseOntologyHash) !== ontologyHash
    ) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_command_ontology_mismatch",
        "The source Command is bound to a different Ontology snapshot",
        409,
      );
    }
  }

  if (!input.waitingHarnessJobId) return null;
  if (!input.resumeAction) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_resume_action_required",
      "A Configuration Task bound to a waiting Harness Job requires an exact resume action",
      400,
    );
  }
  const waitingJob = db
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, input.waitingHarnessJobId),
          eq(ontocodeHarnessJobs.sessionId, session.id),
        ),
      ),
    )
    .get();
  if (!waitingJob || waitingJob.status !== "waiting_user") {
    throw new OntoCodeStoreError(
      "ontocode_configuration_waiting_job_mismatch",
      "The bound Harness Job is not waiting for input in this tenant and Session",
      409,
    );
  }
  const receiptBinding = requireWaitingReceiptBinding(
    db,
    ctx,
    session.id,
    waitingJob,
    input,
    ontologyHash,
  );
  const expectedKind = ONTOCODE_COMMAND_POLICY[input.resumeAction].jobKind;
  if (waitingJob.kind !== expectedKind) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_resume_action_mismatch",
      "The resume action does not match the waiting Harness Job kind",
      409,
      {
        waitingJobKind: waitingJob.kind,
        expectedJobKind: expectedKind,
        resumeAction: input.resumeAction,
      },
    );
  }
  if (
    sourceCommand &&
    waitingJob.commandId &&
    waitingJob.commandId !== sourceCommand.id
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_command_job_mismatch",
      "The source Command and waiting Harness Job do not belong to the same operation",
      409,
    );
  }
  return receiptBinding.receiptDigest;
}

function assertWaitingBindingCurrent(
  db: DbLike,
  ctx: OntoCodeStoreContext,
  session: typeof ontocodeSessions.$inferSelect,
  task: OntoCodeConfigurationTask,
): void {
  if (!task.waitingHarnessJobId) return;
  if (
    !task.sourceRequirementId ||
    !task.sourceActionName ||
    !task.sourceReceiptDigest ||
    !task.resumeAction
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_task_corrupt",
      "The waiting Configuration Task is missing its immutable continuation binding",
      500,
    );
  }
  const waitingJob = db
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, task.waitingHarnessJobId),
          eq(ontocodeHarnessJobs.sessionId, session.id),
        ),
      ),
    )
    .get();
  if (!waitingJob || waitingJob.status !== "waiting_user") {
    throw new OntoCodeStoreError(
      "ontocode_configuration_waiting_job_mismatch",
      "Configuration verification cannot start because the bound Harness Job is no longer waiting",
      409,
    );
  }
  const binding = requireWaitingReceiptBinding(
    db,
    ctx,
    session.id,
    waitingJob,
    {
      expectedSessionRevision: session.revision,
      sourceCommandId: task.sourceCommandId ?? undefined,
      waitingHarnessJobId: task.waitingHarnessJobId,
      sourceRequirementId: task.sourceRequirementId,
      sourceActionName: task.sourceActionName,
      blockerKey: task.blockerKey,
      title: task.title,
      target: task.target,
      requirement: task.requirement,
      verificationPolicy: task.verificationPolicy,
      resumeAction: task.resumeAction,
      ontologyHash: task.ontologyHash,
      idempotencyKey: task.idempotencyKey,
    },
    normalizeSha256(task.ontologyHash),
  );
  if (
    normalizeSha256(binding.receiptDigest) !==
    normalizeSha256(task.sourceReceiptDigest)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_waiting_receipt_changed",
      "Configuration verification cannot start because the immutable waiting receipt binding changed",
      409,
    );
  }
}

export function createOntoCodeConfigurationTask(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateTaskInput,
): OntoCodeConfigurationTaskCreateReceipt {
  assertSecretFree(input);
  validateTargetPolicy(input);

  return getDb().transaction((tx) => {
    const existing = tx
      .select()
      .from(ontocodeConfigurationTasks)
      .where(
        tenantScope(
          ctx,
          ontocodeConfigurationTasks,
        )(
          and(
            eq(ontocodeConfigurationTasks.sessionId, sessionId),
            eq(ontocodeConfigurationTasks.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existing) {
      const task = taskFromRow(existing);
      if (comparableTask(task) !== comparableCreateInput(input)) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different Configuration Task",
          409,
        );
      }
      const event = findTaskEvent(tx, ctx, task, "configuration.task.created");
      if (!event) {
        throw new OntoCodeStoreError(
          "ontocode_configuration_task_corrupt",
          "The idempotent Configuration Task is missing its creation event",
          500,
        );
      }
      return {
        task,
        event,
        sessionRevision: sessionRevision(tx, ctx, sessionId),
        mode: "attached" as const,
      };
    }

    const session = requireSessionRow(tx, ctx, sessionId);
    if (session.revision !== input.expectedSessionRevision) {
      throw new OntoCodeStoreError(
        "ontocode_revision_conflict",
        "The OntoCode Session changed before the Configuration Task was created",
        409,
        {
          expectedRevision: input.expectedSessionRevision,
          actualRevision: session.revision,
        },
      );
    }
    const sourceReceiptDigest = assertTaskBindings(tx, ctx, session, input);

    const now = new Date();
    const row: typeof ontocodeConfigurationTasks.$inferInsert = {
      id: opaqueTaskId(),
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      sourceCommandId: input.sourceCommandId ?? null,
      waitingHarnessJobId: input.waitingHarnessJobId ?? null,
      sourceRequirementId: input.sourceRequirementId ?? null,
      sourceActionName: input.sourceActionName ?? null,
      sourceReceiptDigest,
      blockerKey: input.blockerKey,
      title: input.title,
      targetKind: input.target.kind,
      targetJson: canonicalEvidenceJson(input.target),
      requirementJson: canonicalEvidenceJson(input.requirement),
      verificationPolicyJson: canonicalEvidenceJson(input.verificationPolicy),
      resumeAction: input.resumeAction ?? null,
      ontologyHash: normalizeSha256(input.ontologyHash),
      status: "open",
      revision: 1,
      lastVerificationJson: null,
      lastVerificationIdempotencyKey: null,
      resolutionNote: null,
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
      verificationStartedAt: null,
      verifiedAt: null,
      cancelledAt: null,
    };
    tx.insert(ontocodeConfigurationTasks).values(row).run();
    const task = taskFromRow(
      row as typeof ontocodeConfigurationTasks.$inferSelect,
    );
    const event = appendTaskEvent(
      tx,
      ctx,
      {
        task,
        type: "configuration.task.created",
        payload: {
          task,
          secretFree: true,
          harnessResumeDeferred: true,
        },
        causationId: task.id,
      },
      now,
    );
    const revision = bumpSessionRevision(
      tx,
      ctx,
      sessionId,
      now,
      input.expectedSessionRevision,
    );
    return { task, event, sessionRevision: revision, mode: "created" };
  });
}

export function listOntoCodeConfigurationTasks(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  query: ListOntoCodeConfigurationTasksQuery,
): OntoCodeConfigurationTaskListReceipt {
  requireSessionRow(getDb(), ctx, sessionId);
  const filters: SQL[] = [eq(ontocodeConfigurationTasks.sessionId, sessionId)];
  if (query.status) {
    filters.push(eq(ontocodeConfigurationTasks.status, query.status));
  }
  if (query.kind) {
    filters.push(eq(ontocodeConfigurationTasks.targetKind, query.kind));
  }
  const scoped = tenantScope(ctx, ontocodeConfigurationTasks)(and(...filters));
  const db = getDb();
  const count =
    db
      .select({ value: sql<number>`count(*)` })
      .from(ontocodeConfigurationTasks)
      .where(scoped)
      .get()?.value ?? 0;
  const rows = db
    .select()
    .from(ontocodeConfigurationTasks)
    .where(scoped)
    .orderBy(desc(ontocodeConfigurationTasks.updatedAt))
    .limit(query.limit)
    .offset(query.offset)
    .all();
  return {
    items: rows.map(taskFromRow),
    count: Number(count),
    nextOffset:
      query.offset + rows.length < Number(count)
        ? query.offset + rows.length
        : null,
  };
}

export function getOntoCodeConfigurationTask(
  ctx: OntoCodeStoreContext,
  taskId: string,
): OntoCodeConfigurationTask {
  return taskFromRow(requireTaskRow(getDb(), ctx, taskId));
}

export function cancelOntoCodeConfigurationTask(
  ctx: OntoCodeStoreContext,
  taskId: string,
  input: CancelTaskInput,
): OntoCodeConfigurationTaskCancelReceipt {
  assertSecretFree(input.note ?? "");
  return getDb().transaction((tx) => {
    const current = taskFromRow(requireTaskRow(tx, ctx, taskId));
    if (current.status === "cancelled") {
      return {
        task: current,
        event: findTaskEvent(tx, ctx, current, "configuration.task.cancelled"),
        sessionRevision: sessionRevision(tx, ctx, current.sessionId),
        mode: "attached" as const,
      };
    }
    if (current.status === "satisfied" || current.status === "superseded") {
      throw new OntoCodeStoreError(
        "ontocode_configuration_task_terminal",
        `A ${current.status} Configuration Task cannot be cancelled`,
        409,
      );
    }
    if (current.status === "verifying") {
      throw new OntoCodeStoreError(
        "ontocode_configuration_verification_active",
        "Configuration verification is already in progress",
        409,
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_task_revision_conflict",
        "The Configuration Task changed before cancellation",
        409,
        {
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        },
      );
    }

    const now = new Date();
    const result = tx
      .update(ontocodeConfigurationTasks)
      .set({
        status: "cancelled",
        revision: current.revision + 1,
        resolutionNote: input.note ?? "Cancelled by the FDE",
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeConfigurationTasks,
        )(
          and(
            eq(ontocodeConfigurationTasks.id, taskId),
            eq(ontocodeConfigurationTasks.revision, current.revision),
          ),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_task_revision_conflict",
        "The Configuration Task changed before cancellation",
        409,
      );
    }
    const task = taskFromRow(requireTaskRow(tx, ctx, taskId));
    const event = appendTaskEvent(
      tx,
      ctx,
      {
        task,
        type: "configuration.task.cancelled",
        payload: {
          taskId,
          status: task.status,
          note: task.resolutionNote,
        },
        causationId: task.id,
      },
      now,
    );
    const revision = bumpSessionRevision(tx, ctx, task.sessionId, now);
    return {
      task,
      event,
      sessionRevision: revision,
      mode: "cancelled",
    };
  });
}

const VERIFY_STALE_AFTER_MS = 5 * 60_000;

function inProgressVerification(
  task: OntoCodeConfigurationTask,
): OntoCodeConfigurationVerificationResult {
  return OntoCodeConfigurationVerificationResultSchema.parse({
    outcome: "pending",
    code: "verification_in_progress",
    summary: "Configuration verification is already in progress.",
    checkedAt: Date.now(),
    resourceDigest: null,
    refs: [`configuration-task:${task.id}`],
  });
}

function previousVerification(
  task: OntoCodeConfigurationTask,
): OntoCodeConfigurationVerificationResult {
  return (
    task.lastVerification ??
    OntoCodeConfigurationVerificationResultSchema.parse({
      outcome: "pending",
      code: "verification_not_started",
      summary: "Configuration verification has not produced a result yet.",
      checkedAt: Date.now(),
      resourceDigest: null,
      refs: [`configuration-task:${task.id}`],
    })
  );
}

async function runVerifier(
  task: OntoCodeConfigurationTask,
): Promise<OntoCodeConfigurationVerificationResult> {
  if (!registeredVerifier) {
    return OntoCodeConfigurationVerificationResultSchema.parse({
      outcome: "pending",
      code: "verifier_not_registered",
      summary:
        "No authoritative Configuration Task verifier is registered yet; the task remains open and Harness was not resumed.",
      checkedAt: Date.now(),
      resourceDigest: null,
      refs: [`configuration-task:${task.id}`],
    });
  }
  try {
    const result = await registeredVerifier.verify({ task });
    assertSecretFree(result);
    return OntoCodeConfigurationVerificationResultSchema.parse({
      ...result,
      checkedAt: result.checkedAt ?? Date.now(),
    });
  } catch {
    return OntoCodeConfigurationVerificationResultSchema.parse({
      outcome: "failed",
      code: "verifier_failed",
      summary:
        "The authoritative verifier failed without producing a safe verification receipt; the task remains open.",
      checkedAt: Date.now(),
      resourceDigest: null,
      refs: [`configuration-task:${task.id}`],
    });
  }
}

function resumeVerifiedConfiguration(
  ctx: OntoCodeStoreContext,
  task: OntoCodeConfigurationTask,
  verification: OntoCodeConfigurationVerificationResult,
): boolean {
  if (
    verification.outcome !== "passed" ||
    !task.waitingHarnessJobId ||
    !task.resumeAction ||
    !task.sourceRequirementId ||
    !task.sourceActionName
  ) {
    return false;
  }
  const idempotencyKey = `configuration-resume:${task.id}:${normalizeSha256(
    task.sourceReceiptDigest ?? task.ontologyHash,
  ).slice(0, 32)}`;
  try {
    const receipt = createOntoCodeTurn(ctx, task.sessionId, {
      text: `Configuration Task ${task.id} passed authoritative verification; resume ${task.sourceActionName}.`,
      behavior: "execute",
      action: task.resumeAction,
      arguments: {
        instruction:
          "Continue the exact waiting Harness operation after authoritative Configuration Task verification. Re-evaluate all readiness gates; do not assume downstream sandbox or promotion readiness.",
        source: "configuration-task-verification",
        configurationTaskId: task.id,
        configurationVerificationCode: verification.code,
        configurationResourceDigest: verification.resourceDigest,
        clarificationAnswer: verification.summary,
        resumeWaitingUserJobId: task.waitingHarnessJobId,
      },
      affectedSemanticPaths: [
        `ontology-action:${task.sourceActionName}`,
        `integration-requirement:${task.sourceRequirementId}`,
      ],
      requestedCapabilities: [],
      idempotencyKey,
      assistantText:
        "The configuration passed authoritative verification. I resumed the exact waiting Harness operation; the workspace will show its real readiness checks and outputs.",
      persistedRequestContent: {
        text: "Automatic continuation after configuration verification",
        configurationTask: {
          id: task.id,
          verificationCode: verification.code,
          resourceDigest: verification.resourceDigest,
          sourceReceiptDigest: task.sourceReceiptDigest,
        },
      },
      requestRole: "system",
    });
    return receipt.job !== null;
  } catch (error) {
    // A concurrent continuation may have already consumed the waiting row.
    // The deterministic turn idempotency key makes an exact retry attach; a
    // genuinely stale/mismatched continuation remains visible as not resumed.
    if (
      error instanceof OntoCodeStoreError &&
      (error.code === "ontocode_waiting_job_not_resumable" ||
        error.code === "ontocode_waiting_job_kind_mismatch" ||
        error.code === "ontocode_stale_revision")
    ) {
      return false;
    }
    throw error;
  }
}

export async function verifyOntoCodeConfigurationTask(
  ctx: OntoCodeStoreContext,
  taskId: string,
  input: VerifyTaskInput,
): Promise<OntoCodeConfigurationTaskVerifyReceipt> {
  const initialRow = requireTaskRow(getDb(), ctx, taskId);
  const initial = taskFromRow(initialRow);

  if (
    initialRow.lastVerificationIdempotencyKey === input.idempotencyKey &&
    initial.status !== "verifying"
  ) {
    const verification = previousVerification(initial);
    const resumed = resumeVerifiedConfiguration(ctx, initial, verification);
    return {
      task: initial,
      event: null,
      sessionRevision: sessionRevision(getDb(), ctx, initial.sessionId),
      verification,
      mode: "attached",
      resumed,
    };
  }
  if (initial.status === "satisfied") {
    const verification = previousVerification(initial);
    const resumed = resumeVerifiedConfiguration(ctx, initial, verification);
    return {
      task: initial,
      event: null,
      sessionRevision: sessionRevision(getDb(), ctx, initial.sessionId),
      verification,
      mode: "attached",
      resumed,
    };
  }
  if (initial.status === "cancelled" || initial.status === "superseded") {
    throw new OntoCodeStoreError(
      "ontocode_configuration_task_terminal",
      `A ${initial.status} Configuration Task cannot be verified`,
      409,
    );
  }
  if (initial.status === "verifying") {
    if (initialRow.lastVerificationIdempotencyKey === input.idempotencyKey) {
      return {
        task: initial,
        event: null,
        sessionRevision: sessionRevision(getDb(), ctx, initial.sessionId),
        verification: inProgressVerification(initial),
        mode: "attached",
        resumed: false,
      };
    }
    const startedAt = initial.verificationStartedAt ?? initial.updatedAt;
    if (Date.now() - startedAt < VERIFY_STALE_AFTER_MS) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_verification_active",
        "Another Configuration verification is already in progress",
        409,
      );
    }
  }
  if (initial.revision !== input.expectedRevision) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_task_revision_conflict",
      "The Configuration Task changed before verification",
      409,
      {
        expectedRevision: input.expectedRevision,
        actualRevision: initial.revision,
      },
    );
  }
  const initialSession = requireSessionRow(getDb(), ctx, initial.sessionId);
  const initialSessionHash = initialSession.ontologySnapshotHash
    ? normalizeSha256(initialSession.ontologySnapshotHash)
    : null;
  if (
    initialSessionHash === null ||
    initialSessionHash !== normalizeSha256(initial.ontologyHash)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_configuration_ontology_mismatch",
      "Configuration verification cannot start because the Session Ontology snapshot no longer matches this task",
      409,
      {
        taskOntologyHash: normalizeSha256(initial.ontologyHash),
        sessionOntologyHash: initialSessionHash,
      },
    );
  }
  assertWaitingBindingCurrent(getDb(), ctx, initialSession, initial);

  const claimTime = new Date();
  const claimed = getDb().transaction((tx) => {
    const result = tx
      .update(ontocodeConfigurationTasks)
      .set({
        status: "verifying",
        revision: initial.revision + 1,
        lastVerificationIdempotencyKey: input.idempotencyKey,
        verificationStartedAt: claimTime,
        updatedAt: claimTime,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeConfigurationTasks,
        )(
          and(
            eq(ontocodeConfigurationTasks.id, taskId),
            eq(ontocodeConfigurationTasks.revision, initial.revision),
          ),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_task_revision_conflict",
        "The Configuration Task changed before verification could start",
        409,
      );
    }
    return taskFromRow(requireTaskRow(tx, ctx, taskId));
  });

  let verification = await runVerifier(claimed);
  assertSecretFree(verification);

  const finalized = getDb().transaction((tx) => {
    const currentRow = requireTaskRow(tx, ctx, taskId);
    const current = taskFromRow(currentRow);
    if (
      current.status !== "verifying" ||
      currentRow.lastVerificationIdempotencyKey !== input.idempotencyKey
    ) {
      return {
        task: current,
        event: null,
        sessionRevision: sessionRevision(tx, ctx, current.sessionId),
        verification: previousVerification(current),
        mode: "attached" as const,
        resumed: false as const,
      };
    }

    const session = requireSessionRow(tx, ctx, current.sessionId);
    const sessionHash = session.ontologySnapshotHash
      ? normalizeSha256(session.ontologySnapshotHash)
      : null;
    const ontologyDrift =
      sessionHash === null ||
      sessionHash !== normalizeSha256(current.ontologyHash);
    if (ontologyDrift) {
      verification = OntoCodeConfigurationVerificationResultSchema.parse({
        outcome: "failed",
        code: "ontology_snapshot_drift",
        summary:
          "The Session Ontology snapshot changed while configuration was being verified; this task was superseded and Harness was not resumed.",
        checkedAt: Date.now(),
        resourceDigest: null,
        refs: [`configuration-task:${current.id}`],
      });
    }

    const now = new Date();
    const nextStatus = ontologyDrift
      ? ("superseded" as const)
      : verification.outcome === "passed"
        ? ("satisfied" as const)
        : ("open" as const);
    const update = tx
      .update(ontocodeConfigurationTasks)
      .set({
        status: nextStatus,
        revision: current.revision + 1,
        lastVerificationJson: canonicalEvidenceJson(verification),
        resolutionNote:
          verification.outcome === "passed" ? verification.summary : null,
        verificationStartedAt: null,
        verifiedAt: verification.outcome === "passed" ? now : null,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeConfigurationTasks,
        )(
          and(
            eq(ontocodeConfigurationTasks.id, taskId),
            eq(ontocodeConfigurationTasks.revision, current.revision),
            eq(ontocodeConfigurationTasks.status, "verifying"),
          ),
        ),
      )
      .run();
    if (update.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_configuration_task_revision_conflict",
        "The Configuration Task changed before verification was finalized",
        409,
      );
    }
    const task = taskFromRow(requireTaskRow(tx, ctx, taskId));
    const eventType = ontologyDrift
      ? "configuration.task.superseded"
      : verification.outcome === "passed"
        ? "configuration.task.verified"
        : verification.outcome === "failed"
          ? "configuration.task.verification_failed"
          : "configuration.task.verification_pending";
    const event = appendTaskEvent(
      tx,
      ctx,
      {
        task,
        type: eventType,
        payload: {
          taskId: task.id,
          status: task.status,
          verification,
          resumed: false,
          waitingHarnessJobId: task.waitingHarnessJobId,
        },
        causationId: task.id,
      },
      now,
    );
    const revision = bumpSessionRevision(tx, ctx, task.sessionId, now);
    return {
      task,
      event,
      sessionRevision: revision,
      verification,
      mode: "started" as const,
      resumed: false,
    };
  });
  const resumed = resumeVerifiedConfiguration(
    ctx,
    finalized.task,
    finalized.verification,
  );
  return {
    ...finalized,
    sessionRevision: resumed
      ? sessionRevision(getDb(), ctx, finalized.task.sessionId)
      : finalized.sessionRevision,
    resumed,
  };
}
