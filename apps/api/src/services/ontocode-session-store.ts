import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  businessOntologyDomains,
  factoryConversations,
  factoryRuns,
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeBuildExecutions,
  ontocodeCandidateHeads,
  ontocodeChangeSetOperations,
  ontocodeChangeSets,
  ontocodeCommands,
  ontocodeConfigurationTasks,
  ontocodeEvidenceInvalidations,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodePackageVersions,
  ontocodeProjects,
  ontocodeSessionEvents,
  ontocodeSessionMessages,
  ontocodeSessions,
  tenants,
  tenantScope,
} from "@agentic/db";
import { canonicalEvidenceJson } from "@agentic/shared";
import {
  ONTOCODE_COMMAND_POLICY,
  resolveOntoCodeAutonomyActionPolicy,
  resolveOntoCodeCommandBudget,
  OntoCodeArtifactSchema,
  OntoCodeArtifactVersionSchema,
  OntoCodeBuildSessionSchema,
  OntoCodeChangeSetOperationSchema,
  OntoCodeChangeSetSchema,
  OntoCodeCommandSchema,
  OntoCodeEvidenceRecordSchema,
  OntoCodeHarnessJobSchema,
  OntoCodeCandidateTestCaseSchema,
  OntoCodeMessageSchema,
  OntoCodeProjectSchema,
  OntoCodeSessionEventSchema,
  OntoCodeWorkspaceDirectiveSchema,
  type CommitOntoCodeChangeSetRequest,
  type CloseOntoCodeSessionRequest,
  type CreateOntoCodeArtifactRequest,
  type CreateOntoCodeArtifactVersionRequest,
  type CreateOntoCodeChangeSetRequest,
  type CreateOntoCodeCommandRequest,
  type CreateOntoCodeEvidenceRecordRequest,
  type CreateOntoCodeHarnessJobRequest,
  type CreateOntoCodeProjectRequest,
  type CreateOntoCodeSessionRequest,
  type DecideOntoCodeCommandRequest,
  type OntoCodeArtifact,
  type OntoCodeArtifactVersion,
  type OntoCodeBuildSession,
  type OntoCodeChangeSet,
  type OntoCodeChangeSetOperation,
  type OntoCodeCommand,
  type OntoCodeEvidenceRecord,
  type OntoCodeHarnessJob,
  type OntoCodeCandidateTestCase,
  type OntoCodeMessage,
  type OntoCodeProject,
  type OntoCodeSessionCloseDisposition,
  type OntoCodeSessionEvent,
  type PostOntoCodeMessageRequest,
  type PostOntoCodeTurnRequest,
  type OntoCodeTurnAction,
  type OntoCodeTurnReceipt,
  type OntoCodeWorkspaceDirective,
  type UpdateOntoCodeSessionRequest,
} from "@agentic/contracts";
import { computeOntoCodeCandidateJobInputHash } from "./ontocode-candidate-digest";
import {
  assertRuntimeProfileVersionForTenant,
  RuntimeProfileStoreError,
} from "./runtime-profile-store";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

export interface OntoCodeStoreContext {
  tenantId: string;
  actorId: string | null;
}

export interface Page<T> {
  items: T[];
  count: number;
  nextOffset: number | null;
}

export class OntoCodeStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OntoCodeStoreError";
  }
}

function makeOntoCodeId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function makeOntoCodeIdempotencyKey(): string {
  return makeOntoCodeId("idem");
}

function requireBoundOntologyDomain(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  requestedDomain: string,
  registrationId?: string | null,
  pinnedRuntimeProfileVersionId?: string | null,
) {
  const registrations = db
    .select()
    .from(businessOntologyDomains)
    .where(
      and(
        eq(businessOntologyDomains.tenantId, ctx.tenantId),
        eq(businessOntologyDomains.ontologyDomainId, requestedDomain),
        eq(businessOntologyDomains.status, "active"),
        ...(registrationId
          ? [eq(businessOntologyDomains.id, registrationId)]
          : []),
      ),
    )
    .limit(2)
    .all()
    .filter((row) => row.archivedAt === null);

  if (registrations.length === 0) {
    throw new OntoCodeStoreError(
      "ontocode_ontology_domain_registration_required",
      "Register this exact Ontology Domain under the current Business Domain before creating or mutating OntoCode work",
      409,
      {
        tenantId: ctx.tenantId,
        requestedDomain,
        registrationId: registrationId ?? null,
      },
    );
  }
  if (registrations.length > 1) {
    throw new OntoCodeStoreError(
      "ontocode_ontology_domain_source_ambiguous",
      "This Ontology Domain id is registered from multiple sources; select its exact registration",
      409,
      {
        tenantId: ctx.tenantId,
        requestedDomain,
        registrationIds: registrations.map((row) => row.id),
        sources: registrations.map((row) => row.source),
      },
    );
  }
  const registration = registrations[0]!;
  if (registration.source === "manifest_legacy") {
    throw new OntoCodeStoreError(
      "ontocode_ontology_domain_explicit_required",
      "A migration-only Domain registration must be re-registered from Allmeta or tenant upload before starting a new semantic lineage",
      409,
      {
        tenantId: ctx.tenantId,
        requestedDomain,
        registrationId: registration.id,
        source: registration.source,
      },
    );
  }
  const tenant = db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId))
    .get();
  if (!tenant) {
    throw new OntoCodeStoreError(
      "ontocode_business_domain_not_found",
      "The OntoCode Business Domain no longer exists",
      409,
      { tenantId: ctx.tenantId },
    );
  }
  const usesPinnedLineage = pinnedRuntimeProfileVersionId !== undefined;
  const runtimeProfileVersionId = usesPinnedLineage
    ? pinnedRuntimeProfileVersionId
    : registration.runtimeProfileVersionId;
  if (
    !usesPinnedLineage &&
    registration.runtimeBindingMode === "profile_pinned" &&
    !runtimeProfileVersionId
  ) {
    throw new OntoCodeStoreError(
      "ontocode_runtime_profile_required",
      "Bind an immutable Runtime Profile version before creating OntoCode work for this Ontology Domain",
      409,
      {
        tenantId: ctx.tenantId,
        requestedDomain,
        registrationId: registration.id,
      },
    );
  }
  if (runtimeProfileVersionId) {
    try {
      const projection = assertRuntimeProfileVersionForTenant(
        db,
        { tenantId: ctx.tenantId, tenantSlug: tenant.slug },
        runtimeProfileVersionId,
      );
      if (
        projection.readiness.state === "profile_archived" ||
        projection.readiness.state === "invalid"
      ) {
        throw new RuntimeProfileStoreError(
          projection.readiness.code,
          projection.readiness.message,
          409,
        );
      }
    } catch (error) {
      if (error instanceof OntoCodeStoreError) throw error;
      if (!(error instanceof RuntimeProfileStoreError)) throw error;
      throw new OntoCodeStoreError(
        "ontocode_runtime_profile_invalid",
        error.message,
        error.statusCode,
        {
          tenantId: ctx.tenantId,
          requestedDomain,
          registrationId: registration.id,
          runtimeProfileVersionId,
          cause: error.code,
        },
      );
    }
  }
  return registration;
}

/**
 * Fail-closed guard shared by product entrypoints which need to prove that an
 * OntoCode Project is still pinned to an active, exact Ontology Domain
 * registration under its Business Domain.
 */
export function assertOntoCodeOntologyBinding(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  requestedDomain: string,
  registrationId?: string | null,
  runtimeProfileVersionId?: string | null,
): void {
  requireBoundOntologyDomain(
    getDb(),
    ctx,
    requestedDomain,
    registrationId,
    runtimeProfileVersionId,
  );
}

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

function requiredTimestamp(
  value: Date | number | null | undefined,
  field: string,
): number {
  const parsed = timestamp(value);
  if (parsed === null || !Number.isFinite(parsed)) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `OntoCode row has an invalid ${field}`,
      500,
    );
  }
  return parsed;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `OntoCode row has invalid JSON in ${field}`,
      500,
    );
  }
}

function projectFromRow(
  row: typeof ontocodeProjects.$inferSelect,
): OntoCodeProject {
  return OntoCodeProjectSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    ontologyDomainRegistrationId: row.ontologyDomainRegistrationId ?? null,
    runtimeProfileVersionId: row.runtimeProfileVersionId ?? null,
    domain: row.domain,
    name: row.name,
    description: row.description ?? null,
    activePackageVersionId: row.activePackageVersionId ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "project.createdAt"),
    updatedAt: requiredTimestamp(row.updatedAt, "project.updatedAt"),
  });
}

function sessionFromRow(
  row: typeof ontocodeSessions.$inferSelect,
): OntoCodeBuildSession {
  return OntoCodeBuildSessionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    runtimeProfileVersionId: row.runtimeProfileVersionId ?? null,
    title: row.title,
    goal: row.goal,
    phase: row.phase,
    activityState: row.activityState,
    autonomyMode: row.autonomyMode,
    revision: row.revision,
    ontologySnapshotHash: row.ontologySnapshotHash ?? null,
    basePackageVersionId: row.basePackageVersionId ?? null,
    environmentProfileVersionId: row.environmentProfileVersionId ?? null,
    ownerUserId: row.ownerUserId ?? null,
    createdAt: requiredTimestamp(row.createdAt, "session.createdAt"),
    updatedAt: requiredTimestamp(row.updatedAt, "session.updatedAt"),
  });
}

function messageFromRow(
  row: typeof ontocodeSessionMessages.$inferSelect,
): OntoCodeMessage {
  return OntoCodeMessageSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    role: row.role,
    type: row.type,
    content: parseJson(row.contentJson, "message.contentJson"),
    commandId: row.commandId ?? null,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey ?? null,
    createdAt: requiredTimestamp(row.createdAt, "message.createdAt"),
  });
}

function commandFromRow(
  row: typeof ontocodeCommands.$inferSelect,
): OntoCodeCommand {
  return OntoCodeCommandSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    type: row.type,
    arguments: parseJson(row.argumentsJson, "command.argumentsJson"),
    expectedSessionRevision: row.expectedSessionRevision,
    baseOntologyHash: row.baseOntologyHash ?? null,
    basePackageVersionId: row.basePackageVersionId ?? null,
    affectedSemanticPaths: parseJson(
      row.affectedSemanticPathsJson,
      "command.affectedSemanticPathsJson",
    ),
    riskClass: row.riskClass,
    requestedCapabilities: parseJson(
      row.requestedCapabilitiesJson,
      "command.requestedCapabilitiesJson",
    ),
    status: row.status,
    requiresHuman: row.requiresHuman,
    rationaleSummary: row.rationaleSummary,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "command.createdAt"),
    updatedAt: requiredTimestamp(row.updatedAt, "command.updatedAt"),
  });
}

function harnessJobFromRow(
  row: typeof ontocodeHarnessJobs.$inferSelect,
): OntoCodeHarnessJob {
  return OntoCodeHarnessJobSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    commandId: row.commandId ?? null,
    runtimeProfileVersionId: row.runtimeProfileVersionId ?? null,
    buildExecutionId: row.buildExecutionId ?? null,
    attemptNo: row.attemptNo,
    kind: row.kind,
    status: row.status,
    inputHash: row.inputHash ?? null,
    budget:
      row.budgetJson === null
        ? null
        : parseJson(row.budgetJson, "harnessJob.budgetJson"),
    candidatePackageVersionId: row.candidatePackageVersionId ?? null,
    candidateDependencyRoot: row.candidateDependencyRoot ?? null,
    candidateHeadId: row.candidateHeadId ?? null,
    candidateHeadRevision: row.candidateHeadRevision ?? null,
    testCases: parseJson(row.testCasesJson, "harnessJob.testCasesJson"),
    idempotencyKey: row.idempotencyKey,
    errorMessage: row.errorMessage ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "harnessJob.createdAt"),
    startedAt: timestamp(row.startedAt),
    finishedAt: timestamp(row.finishedAt),
    updatedAt: requiredTimestamp(row.updatedAt, "harnessJob.updatedAt"),
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
    payload: parseJson(row.payloadJson, "event.payloadJson"),
    createdAt: requiredTimestamp(row.createdAt, "event.createdAt"),
  });
}

function changeSetFromRow(
  row: typeof ontocodeChangeSets.$inferSelect,
): OntoCodeChangeSet {
  return OntoCodeChangeSetSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    commandId: row.commandId ?? null,
    status: row.status,
    summary: row.summary,
    baseOntologyHash: row.baseOntologyHash ?? null,
    basePackageVersionId: row.basePackageVersionId ?? null,
    expectedSessionRevision: row.expectedSessionRevision,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "changeSet.createdAt"),
    updatedAt: requiredTimestamp(row.updatedAt, "changeSet.updatedAt"),
    committedAt: timestamp(row.committedAt),
  });
}

function changeSetOperationFromRow(
  row: typeof ontocodeChangeSetOperations.$inferSelect,
): OntoCodeChangeSetOperation {
  return OntoCodeChangeSetOperationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    changeSetId: row.changeSetId,
    ordinal: row.ordinal,
    operation: row.operation,
    semanticPath: row.semanticPath,
    fromSemanticPath: row.fromSemanticPath ?? null,
    beforeValue: parseJson(row.beforeJson, "changeSetOperation.beforeJson"),
    afterValue: parseJson(row.afterJson, "changeSetOperation.afterJson"),
    sourceRefs: parseJson(
      row.sourceRefsJson,
      "changeSetOperation.sourceRefsJson",
    ),
    invalidates: parseJson(
      row.invalidatesJson,
      "changeSetOperation.invalidatesJson",
    ),
    createdAt: requiredTimestamp(row.createdAt, "changeSetOperation.createdAt"),
  });
}

function artifactFromRow(
  row: typeof ontocodeArtifacts.$inferSelect,
): OntoCodeArtifact {
  return OntoCodeArtifactSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    logicalName: row.logicalName,
    kind: row.kind,
    semanticPath: row.semanticPath ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "artifact.createdAt"),
  });
}

function artifactVersionFromRow(
  row: typeof ontocodeArtifactVersions.$inferSelect,
): OntoCodeArtifactVersion {
  return OntoCodeArtifactVersionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    artifactId: row.artifactId,
    sessionId: row.sessionId,
    changeSetId: row.changeSetId ?? null,
    version: row.version,
    blobHash: row.blobHash,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    metadata: parseJson(row.metadataJson, "artifactVersion.metadataJson"),
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "artifactVersion.createdAt"),
  });
}

function evidenceFromRow(
  row: typeof ontocodeEvidenceRecords.$inferSelect,
): OntoCodeEvidenceRecord {
  return OntoCodeEvidenceRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    harnessJobId: row.harnessJobId ?? null,
    changeSetId: row.changeSetId ?? null,
    artifactVersionId: row.artifactVersionId ?? null,
    kind: row.kind,
    outcome: row.outcome,
    state: row.state,
    staleReason: row.staleReason ?? null,
    invalidatedByPackageVersionId: row.invalidatedByPackageVersionId ?? null,
    invalidatedAt: timestamp(row.invalidatedAt),
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectDigest: row.subjectDigest,
    dependencySet: parseJson(
      row.dependencySetJson,
      "evidence.dependencySetJson",
    ),
    validityPredicate: parseJson(
      row.validityPredicateJson,
      "evidence.validityPredicateJson",
    ),
    refs: parseJson(row.refsJson, "evidence.refsJson"),
    summary: row.summary,
    producer: row.producer,
    idempotencyKey: row.idempotencyKey,
    recordedBy: row.recordedBy ?? null,
    createdAt: requiredTimestamp(row.createdAt, "evidence.createdAt"),
  });
}

function page<T>(rows: T[], limit: number, offset: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    count: items.length,
    nextOffset: hasMore ? offset + items.length : null,
  };
}

function getProjectRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  projectId: string,
) {
  return db
    .select()
    .from(ontocodeProjects)
    .where(
      tenantScope(ctx, ontocodeProjects)(eq(ontocodeProjects.id, projectId)),
    )
    .get();
}

function requireProjectRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  projectId: string,
) {
  const row = getProjectRow(db, ctx, projectId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_project_not_found",
      "OntoCode project not found",
      404,
    );
  }
  return row;
}

function getSessionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
) {
  return db
    .select()
    .from(ontocodeSessions)
    .where(
      tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
    )
    .get();
}

function requireSessionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
) {
  const row = getSessionRow(db, ctx, sessionId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_session_not_found",
      "OntoCode build session not found",
      404,
    );
  }
  return row;
}

/**
 * Historical sessions remain readable for audit, but become immutable as soon
 * as their Project's exact Ontology Domain registration is no longer active
 * under the Business Domain. Keeping this guard in the store prevents routes,
 * workers, and future callers from accidentally continuing an old semantic
 * lineage.
 */
function requireWritableSessionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
) {
  const session = requireSessionRow(db, ctx, sessionId);
  const project = requireProjectRow(db, ctx, session.projectId);
  if (
    (session.runtimeProfileVersionId ?? null) !==
    (project.runtimeProfileVersionId ?? null)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_runtime_profile_lineage_corrupt",
      "The Session and Project do not pin the same Runtime Profile version",
      500,
      {
        sessionId: session.id,
        projectId: project.id,
        sessionRuntimeProfileVersionId: session.runtimeProfileVersionId ?? null,
        projectRuntimeProfileVersionId: project.runtimeProfileVersionId ?? null,
      },
    );
  }
  try {
    requireBoundOntologyDomain(
      db,
      ctx,
      project.domain,
      project.ontologyDomainRegistrationId,
      project.runtimeProfileVersionId,
    );
  } catch (error) {
    if (!(error instanceof OntoCodeStoreError)) throw error;
    throw new OntoCodeStoreError(
      "ontocode_session_ontology_stale",
      "This OntoCode session is read-only because its exact Ontology Domain registration is no longer active under the Business Domain",
      409,
      {
        tenantId: ctx.tenantId,
        sessionId: session.id,
        projectId: project.id,
        projectDomain: project.domain,
        registrationId: project.ontologyDomainRegistrationId,
        cause: error.code,
      },
    );
  }
  if (session.phase === "completed" || session.activityState === "cancelled") {
    throw new OntoCodeStoreError(
      "ontocode_session_closed",
      "This OntoCode session is closed and remains available as read-only history",
      409,
      {
        tenantId: ctx.tenantId,
        sessionId: session.id,
        phase: session.phase,
        activityState: session.activityState,
      },
    );
  }
  return session;
}

function requireExpectedRevision(
  session: typeof ontocodeSessions.$inferSelect,
  expectedRevision: number,
): void {
  if (session.revision !== expectedRevision) {
    throw new OntoCodeStoreError(
      "ontocode_stale_revision",
      "The build session changed after this operation was prepared",
      409,
      {
        expectedRevision,
        currentRevision: session.revision,
        sessionId: session.id,
      },
    );
  }
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

interface AppendEventInput {
  projectId: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId?: string | null;
  commandId?: string | null;
  harnessJobId?: string | null;
  visibility?: "user" | "debug" | "audit";
}

function appendEvent(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  input: AppendEventInput,
  now: Date,
): OntoCodeSessionEvent {
  const row: typeof ontocodeSessionEvents.$inferInsert = {
    id: makeOntoCodeId("oce"),
    tenantId: ctx.tenantId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    seq: nextEventSeq(db, ctx, input.sessionId),
    type: input.type,
    visibility: input.visibility ?? "user",
    payloadJson: canonicalEvidenceJson(input.payload),
    commandId: input.commandId ?? null,
    harnessJobId: input.harnessJobId ?? null,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    createdAt: now,
  };
  db.insert(ontocodeSessionEvents).values(row).run();
  return eventFromRow(row as typeof ontocodeSessionEvents.$inferSelect);
}

function eventForCausation(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  causationId: string,
) {
  return db
    .select()
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, sessionId),
          eq(ontocodeSessionEvents.causationId, causationId),
        ),
      ),
    )
    .orderBy(asc(ontocodeSessionEvents.seq))
    .limit(1)
    .get();
}

function eventForCausationAndType(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  causationId: string,
  type: string,
) {
  return db
    .select()
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, sessionId),
          eq(ontocodeSessionEvents.causationId, causationId),
          eq(ontocodeSessionEvents.type, type),
        ),
      ),
    )
    .orderBy(asc(ontocodeSessionEvents.seq))
    .limit(1)
    .get();
}

function requireCausationEvent(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  causationId: string,
): OntoCodeSessionEvent {
  const row = eventForCausation(db, ctx, sessionId, causationId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "The idempotent record is missing its durable session event",
      500,
      { sessionId, causationId },
    );
  }
  return eventFromRow(row);
}

export function createOntoCodeProject(
  ctx: OntoCodeStoreContext,
  input: CreateOntoCodeProjectRequest,
): { project: OntoCodeProject; mode: "created" | "attached" } {
  return getDb().transaction((tx) => {
    const registration = requireBoundOntologyDomain(
      tx,
      ctx,
      input.domain,
      input.ontologyDomainRegistrationId,
    );
    const runtimeProfileVersionId =
      registration.runtimeBindingMode === "profile_pinned"
        ? registration.runtimeProfileVersionId
        : null;

    const existing = tx
      .select()
      .from(ontocodeProjects)
      .where(
        tenantScope(
          ctx,
          ontocodeProjects,
        )(
          and(
            eq(ontocodeProjects.ontologyDomainRegistrationId, registration.id),
            runtimeProfileVersionId
              ? eq(
                  ontocodeProjects.runtimeProfileVersionId,
                  runtimeProfileVersionId,
                )
              : isNull(ontocodeProjects.runtimeProfileVersionId),
          ),
        ),
      )
      .get();
    if (existing) {
      return { project: projectFromRow(existing), mode: "attached" as const };
    }

    const now = new Date();
    const row: typeof ontocodeProjects.$inferInsert = {
      id: makeOntoCodeId("ocp"),
      tenantId: ctx.tenantId,
      ontologyDomainRegistrationId: registration.id,
      runtimeProfileVersionId,
      domain: input.domain,
      name: input.name,
      description: input.description ?? null,
      activePackageVersionId: null,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = tx
      .insert(ontocodeProjects)
      .values(row)
      .onConflictDoNothing()
      .run() as { changes?: number };
    const persisted = tx
      .select()
      .from(ontocodeProjects)
      .where(
        tenantScope(
          ctx,
          ontocodeProjects,
        )(
          and(
            eq(ontocodeProjects.ontologyDomainRegistrationId, registration.id),
            runtimeProfileVersionId
              ? eq(
                  ontocodeProjects.runtimeProfileVersionId,
                  runtimeProfileVersionId,
                )
              : isNull(ontocodeProjects.runtimeProfileVersionId),
          ),
        ),
      )
      .get();
    if (!persisted) {
      throw new OntoCodeStoreError(
        "ontocode_project_create_failed",
        "The OntoCode project could not be durably created",
        500,
        { tenantId: ctx.tenantId, domain: input.domain },
      );
    }
    return {
      project: projectFromRow(persisted),
      mode: (inserted.changes ?? 0) > 0 ? "created" : "attached",
    };
  });
}

export function listOntoCodeProjects(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  input: {
    limit: number;
    offset: number;
    domain?: string;
    search?: string;
  },
): Page<OntoCodeProject> {
  const filters: SQL[] = [];
  if (input.domain) filters.push(eq(ontocodeProjects.domain, input.domain));
  if (input.search) {
    filters.push(
      or(
        like(ontocodeProjects.name, `%${input.search}%`),
        like(ontocodeProjects.domain, `%${input.search}%`),
      )!,
    );
  }
  const extra = filters.length ? and(...filters) : undefined;
  const rows = getDb()
    .select()
    .from(ontocodeProjects)
    .where(tenantScope(ctx, ontocodeProjects)(extra))
    .orderBy(desc(ontocodeProjects.updatedAt), desc(ontocodeProjects.id))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(projectFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeProject(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  projectId: string,
): OntoCodeProject {
  return projectFromRow(requireProjectRow(getDb(), ctx, projectId));
}

export function createOntoCodeSession(
  ctx: OntoCodeStoreContext,
  input: CreateOntoCodeSessionRequest,
): { session: OntoCodeBuildSession; event: OntoCodeSessionEvent } {
  return getDb().transaction((tx) => {
    const project = requireProjectRow(tx, ctx, input.projectId);
    requireBoundOntologyDomain(
      tx,
      ctx,
      project.domain,
      project.ontologyDomainRegistrationId,
      project.runtimeProfileVersionId,
    );
    const now = new Date();
    const id = makeOntoCodeId("ocs");
    const row: typeof ontocodeSessions.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      runtimeProfileVersionId: project.runtimeProfileVersionId ?? null,
      title: input.title,
      goal: input.goal,
      phase: "intake",
      activityState: "idle",
      autonomyMode: input.autonomyMode,
      revision: 1,
      ontologySnapshotHash: input.ontologySnapshotHash ?? null,
      basePackageVersionId: input.basePackageVersionId ?? null,
      environmentProfileVersionId: input.environmentProfileVersionId ?? null,
      ownerUserId: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(ontocodeSessions).values(row).run();
    const session = sessionFromRow(row as typeof ontocodeSessions.$inferSelect);
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: input.projectId,
        sessionId: id,
        type: "session.created",
        payload: {
          sessionId: id,
          projectId: input.projectId,
          ontologyDomainRegistrationId: project.ontologyDomainRegistrationId,
          runtimeProfileVersionId: project.runtimeProfileVersionId ?? null,
          ontologyDomainId: project.domain,
          ontologySnapshotHash: session.ontologySnapshotHash,
          phase: session.phase,
          activityState: session.activityState,
          revision: session.revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: id,
      },
      now,
    );
    return { session, event };
  });
}

export function listOntoCodeSessions(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  input: {
    limit: number;
    offset: number;
    projectId?: string;
    phase?: OntoCodeBuildSession["phase"];
    activityState?: OntoCodeBuildSession["activityState"];
  },
): Page<OntoCodeBuildSession> {
  const filters: SQL[] = [];
  if (input.projectId) {
    filters.push(eq(ontocodeSessions.projectId, input.projectId));
  }
  if (input.phase) filters.push(eq(ontocodeSessions.phase, input.phase));
  if (input.activityState) {
    filters.push(eq(ontocodeSessions.activityState, input.activityState));
  }
  const extra = filters.length ? and(...filters) : undefined;
  const rows = getDb()
    .select()
    .from(ontocodeSessions)
    .where(tenantScope(ctx, ontocodeSessions)(extra))
    .orderBy(desc(ontocodeSessions.updatedAt), desc(ontocodeSessions.id))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(sessionFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeSession(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): OntoCodeBuildSession {
  return sessionFromRow(requireSessionRow(getDb(), ctx, sessionId));
}

export const ONTOCODE_ONTOLOGY_SHADOWED_EVENT = "ontology.source.shadowed";

/**
 * #ONTOLOGY-SHADOW —— 一次「静默切换」的持久记录。
 *
 * 无绑定回退路径上，同 id 的上传包会盖过一个已配置的在线源，而【谁都看不见】：
 * 读到的本体是上传的那份，配置里写的却是 Allmeta。平台不改谁赢——那是 FDE 的
 * 裁量——但不能继续替它隐瞒。所以新鲜度读取一旦测到这件事，就在 Session 的事件
 * 账本里留一条 user 可见的记录。
 *
 * 幂等：同一个 Session/域/被盖过的传输只记一次，否则前端轮询会把账本刷爆。返回
 * null 表示这条事实早就在账本里了。
 */
export function recordOntoCodeOntologyShadowing(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    ontologyDomainId: string;
    baseTransport: "allmeta" | "manifest" | null;
    currentHash: string | null;
  },
): OntoCodeSessionEvent | null {
  return getDb().transaction((tx) => {
    const session = requireSessionRow(tx, ctx, sessionId);
    const existing = tx
      .select()
      .from(ontocodeSessionEvents)
      .where(
        tenantScope(
          ctx,
          ontocodeSessionEvents,
        )(
          and(
            eq(ontocodeSessionEvents.sessionId, sessionId),
            eq(ontocodeSessionEvents.type, ONTOCODE_ONTOLOGY_SHADOWED_EVENT),
          ),
        ),
      )
      .all()
      .find((row) => {
        const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
        return (
          payload.ontologyDomainId === input.ontologyDomainId &&
          (payload.baseTransport ?? null) === input.baseTransport
        );
      });
    if (existing) return null;
    return appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: ONTOCODE_ONTOLOGY_SHADOWED_EVENT,
        payload: {
          sessionId,
          projectId: session.projectId,
          ontologyDomainId: input.ontologyDomainId,
          servedBy: "upload",
          baseTransport: input.baseTransport,
          currentHash: input.currentHash,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: sessionId,
        visibility: "user",
      },
      new Date(),
    );
  });
}

const AUTONOMY_CHANGE_BLOCKING_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_user",
  "retry_scheduled",
] as const;

const AUTONOMY_CHANGE_BLOCKING_COMMAND_STATUSES = [
  "proposed",
  "awaiting_approval",
  "approved",
  "queued",
  "running",
] as const;

export function updateOntoCodeSession(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: UpdateOntoCodeSessionRequest,
): { session: OntoCodeBuildSession; event: OntoCodeSessionEvent } {
  return getDb().transaction((tx) => {
    const current = requireWritableSessionRow(tx, ctx, sessionId);
    requireExpectedRevision(current, input.expectedRevision);
    if (input.phase === "completed" || input.activityState === "cancelled") {
      throw new OntoCodeStoreError(
        "ontocode_session_close_required",
        "Use the dedicated Session close operation to retire or complete an OntoCode session",
        409,
        { sessionId },
      );
    }
    if (
      input.autonomyMode !== undefined &&
      input.autonomyMode !== current.autonomyMode
    ) {
      // A mode switch cannot retroactively add/remove approval from an already
      // accepted Command, and a running Factory conversation treats its
      // interaction policy as immutable. Refuse the switch while either kind
      // of work is live instead of letting UI state diverge from execution.
      const blockingJob = tx
        .select({
          id: ontocodeHarnessJobs.id,
          kind: ontocodeHarnessJobs.kind,
          status: ontocodeHarnessJobs.status,
        })
        .from(ontocodeHarnessJobs)
        .where(
          tenantScope(
            ctx,
            ontocodeHarnessJobs,
          )(
            and(
              eq(ontocodeHarnessJobs.sessionId, sessionId),
              inArray(
                ontocodeHarnessJobs.status,
                AUTONOMY_CHANGE_BLOCKING_JOB_STATUSES,
              ),
            ),
          ),
        )
        .orderBy(
          desc(ontocodeHarnessJobs.updatedAt),
          desc(ontocodeHarnessJobs.id),
        )
        .limit(1)
        .get();
      const blockingCommand = tx
        .select({
          id: ontocodeCommands.id,
          type: ontocodeCommands.type,
          status: ontocodeCommands.status,
        })
        .from(ontocodeCommands)
        .where(
          tenantScope(
            ctx,
            ontocodeCommands,
          )(
            and(
              eq(ontocodeCommands.sessionId, sessionId),
              inArray(
                ontocodeCommands.status,
                AUTONOMY_CHANGE_BLOCKING_COMMAND_STATUSES,
              ),
            ),
          ),
        )
        .orderBy(desc(ontocodeCommands.updatedAt), desc(ontocodeCommands.id))
        .limit(1)
        .get();
      if (blockingJob || blockingCommand) {
        throw new OntoCodeStoreError(
          "ontocode_autonomy_change_blocked",
          "Cannot change autonomy mode while this Session has a live Harness Job or pending Command",
          409,
          {
            sessionId,
            currentAutonomyMode: current.autonomyMode,
            requestedAutonomyMode: input.autonomyMode,
            blockingJob: blockingJob ?? null,
            blockingCommand: blockingCommand ?? null,
          },
        );
      }
    }
    const now = new Date();
    const revision = current.revision + 1;
    const changedFields = Object.keys(input).filter(
      (key) => key !== "expectedRevision",
    );
    const result = tx
      .update(ontocodeSessions)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
        ...(input.activityState !== undefined
          ? { activityState: input.activityState }
          : {}),
        ...(input.autonomyMode !== undefined
          ? { autonomyMode: input.autonomyMode }
          : {}),
        ...(input.basePackageVersionId !== undefined
          ? { basePackageVersionId: input.basePackageVersionId }
          : {}),
        ...(input.environmentProfileVersionId !== undefined
          ? {
              environmentProfileVersionId: input.environmentProfileVersionId,
            }
          : {}),
        revision,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, input.expectedRevision),
          ),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_stale_revision",
        "The build session changed while this update was committed",
        409,
      );
    }
    const updated = requireSessionRow(tx, ctx, sessionId);
    const session = sessionFromRow(updated);
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: current.projectId,
        sessionId,
        type:
          input.phase !== undefined && input.phase !== current.phase
            ? "session.phase.changed"
            : "session.updated",
        payload: {
          sessionId,
          previousRevision: current.revision,
          revision,
          changedFields,
          previousPhase: current.phase,
          phase: session.phase,
          activityState: session.activityState,
          previousAutonomyMode: current.autonomyMode,
          autonomyMode: session.autonomyMode,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: sessionId,
      },
      now,
    );
    return { session, event };
  });
}

const SESSION_CLOSE_BLOCKING_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_user",
  "retry_scheduled",
] as const;

const SESSION_CLOSE_BLOCKING_CONFIGURATION_STATUSES = [
  "open",
  "verifying",
] as const;

/**
 * Close one idle Session without deleting any of its conversation, commands,
 * artifacts, evidence, or Harness history.
 *
 * Retiring and completing intentionally have different truth semantics:
 * unfinished work is retired (activity=cancelled), while only an idle
 * release/observe Session may claim completion. Once closed, every mutating
 * store path rejects the Session but all list/get APIs remain available.
 */
export function closeOntoCodeSession(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CloseOntoCodeSessionRequest,
): {
  session: OntoCodeBuildSession;
  event: OntoCodeSessionEvent;
  disposition: OntoCodeSessionCloseDisposition;
} {
  return getDb().transaction((tx) => {
    const current = requireWritableSessionRow(tx, ctx, sessionId);
    requireExpectedRevision(current, input.expectedRevision);

    const blockingJob = tx
      .select({
        id: ontocodeHarnessJobs.id,
        status: ontocodeHarnessJobs.status,
      })
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.sessionId, sessionId),
            inArray(
              ontocodeHarnessJobs.status,
              SESSION_CLOSE_BLOCKING_JOB_STATUSES,
            ),
          ),
        ),
      )
      .orderBy(desc(ontocodeHarnessJobs.updatedAt))
      .limit(1)
      .get();
    if (blockingJob) {
      throw new OntoCodeStoreError(
        "ontocode_session_has_active_work",
        "Finish or cancel the active Harness work before closing this OntoCode session",
        409,
        {
          sessionId,
          blockerType: "harness_job",
          blockerId: blockingJob.id,
          blockerStatus: blockingJob.status,
        },
      );
    }

    const blockingConfigurationTask = tx
      .select({
        id: ontocodeConfigurationTasks.id,
        status: ontocodeConfigurationTasks.status,
      })
      .from(ontocodeConfigurationTasks)
      .where(
        tenantScope(
          ctx,
          ontocodeConfigurationTasks,
        )(
          and(
            eq(ontocodeConfigurationTasks.sessionId, sessionId),
            inArray(
              ontocodeConfigurationTasks.status,
              SESSION_CLOSE_BLOCKING_CONFIGURATION_STATUSES,
            ),
          ),
        ),
      )
      .orderBy(desc(ontocodeConfigurationTasks.updatedAt))
      .limit(1)
      .get();
    if (blockingConfigurationTask) {
      throw new OntoCodeStoreError(
        "ontocode_session_has_active_work",
        "Resolve or cancel the open configuration task before closing this OntoCode session",
        409,
        {
          sessionId,
          blockerType: "configuration_task",
          blockerId: blockingConfigurationTask.id,
          blockerStatus: blockingConfigurationTask.status,
        },
      );
    }

    if (current.activityState !== "idle") {
      throw new OntoCodeStoreError(
        "ontocode_session_not_idle",
        "Only an idle OntoCode session can be retired or completed",
        409,
        {
          sessionId,
          activityState: current.activityState,
        },
      );
    }
    if (
      input.disposition === "completed" &&
      current.phase !== "release" &&
      current.phase !== "observe"
    ) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_completable",
        "Only an idle release or observe Session can be marked completed; retire unfinished work instead",
        409,
        {
          sessionId,
          phase: current.phase,
        },
      );
    }

    const now = new Date();
    const revision = current.revision + 1;
    const update = tx
      .update(ontocodeSessions)
      .set(
        input.disposition === "completed"
          ? {
              phase: "completed",
              activityState: "idle",
              revision,
              updatedAt: now,
            }
          : {
              activityState: "cancelled",
              revision,
              updatedAt: now,
            },
      )
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, input.expectedRevision),
          ),
        ),
      )
      .run();
    if (update.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_stale_revision",
        "The build session changed while it was being closed",
        409,
        { sessionId, expectedRevision: input.expectedRevision },
      );
    }

    const session = sessionFromRow(requireSessionRow(tx, ctx, sessionId));
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: current.projectId,
        sessionId,
        type:
          input.disposition === "completed"
            ? "session.completed"
            : "session.retired",
        payload: {
          sessionId,
          disposition: input.disposition,
          previousPhase: current.phase,
          phase: session.phase,
          previousActivityState: current.activityState,
          activityState: session.activityState,
          previousRevision: current.revision,
          revision,
          reason: input.reason ?? null,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: sessionId,
      },
      now,
    );
    return {
      session,
      event,
      disposition: input.disposition,
    };
  });
}

/**
 * Stop the Session's live Harness job, keeping the Session and everything in it.
 *
 * Until this existed, an FDE watching a job run away had exactly one escape:
 * delete the whole Session — which cascades away its messages, events,
 * artifacts and evidence. "Stop this step" and "throw away this attempt" are
 * different intentions and must not share a button.
 *
 * No new abort plumbing is needed. The worker's heartbeat re-asserts ownership
 * with `status = 'running' AND startedAt = leaseToken`; flipping the row to
 * `cancelled` makes that predicate stop matching, and the worker aborts itself
 * within one heartbeat interval. Cancelling is therefore a fact about the job
 * row, not a request the worker may ignore.
 */
export function cancelOntoCodeSessionJob(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  opts: { jobId?: string } = {},
): {
  cancelled: boolean;
  sessionId: string;
  jobIds: string[];
} {
  return getDb().transaction((tx) => {
    const session = tx
      .select({ id: ontocodeSessions.id })
      .from(ontocodeSessions)
      .where(
        tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
      )
      .get();
    if (!session) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "This OntoCode Session does not exist in the current Business Domain",
        404,
        { sessionId },
      );
    }
    // `waiting_user` is deliberately NOT cancellable here: it is not running,
    // it is waiting for this very person, and answering it is the normal way
    // forward. Scrapping a parked Session remains `deleteOntoCodeSession`.
    const live = tx
      .select({
        id: ontocodeHarnessJobs.id,
        buildExecutionId: ontocodeHarnessJobs.buildExecutionId,
      })
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.sessionId, sessionId),
            inArray(ontocodeHarnessJobs.status, [
              "queued",
              "leased",
              "running",
              "retry_scheduled",
            ]),
            ...(opts.jobId ? [eq(ontocodeHarnessJobs.id, opts.jobId)] : []),
          ),
        ),
      )
      .all();
    if (live.length === 0) {
      // Idempotent: re-cancelling a job that already stopped is not an error,
      // it is the state the caller asked for.
      return { cancelled: false, sessionId, jobIds: [] };
    }
    const now = new Date();
    const jobIds = live.map((row) => row.id);
    tx.update(ontocodeHarnessJobs)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorMessage: "已由使用者停止",
      })
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(inArray(ontocodeHarnessJobs.id, jobIds)),
      )
      .run();
    const buildExecutionIds = [
      ...new Set(
        live.flatMap((job) =>
          job.buildExecutionId ? [job.buildExecutionId] : [],
        ),
      ),
    ];
    if (buildExecutionIds.length > 0) {
      const executionUpdate = tx
        .update(ontocodeBuildExecutions)
        .set({
          state: "cancelled",
          pendingInteractionId: null,
          pendingInteractionKind: null,
          pendingInteractionSubjectDigest: null,
          pendingAnswerId: null,
          pendingAnswerDigest: null,
          pendingAnswerStatus: null,
          revision: sql`${ontocodeBuildExecutions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          tenantScope(
            ctx,
            ontocodeBuildExecutions,
          )(
            and(
              eq(ontocodeBuildExecutions.sessionId, sessionId),
              inArray(ontocodeBuildExecutions.id, buildExecutionIds),
            ),
          ),
        )
        .run();
      if (executionUpdate.changes !== buildExecutionIds.length) {
        throw new OntoCodeStoreError(
          "ontocode_build_execution_cancel_raced",
          "A live Build execution changed while cancellation was being committed",
          409,
          { sessionId, jobIds, buildExecutionIds },
        );
      }
    }
    tx.update(ontocodeSessions)
      .set({ activityState: "idle", updatedAt: now })
      .where(
        tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
      )
      .run();
    return { cancelled: true, sessionId, jobIds };
  });
}

/**
 * Explicitly retry one recoverable Harness failure without creating a second
 * Command or Job identity. Keeping both identities is essential for Factory
 * human-gate recovery: the original input_resolved audit edge points at this
 * exact Job, and replacing it would make a valid checkpoint look stale.
 */
export function retryOntoCodeSessionJob(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  jobId: string,
): {
  retried: true;
  sessionId: string;
  jobId: string;
  attempt: number;
  sessionRevision: number;
  event: OntoCodeSessionEvent;
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const job = tx
      .select()
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.id, jobId),
            eq(ontocodeHarnessJobs.sessionId, sessionId),
          ),
        ),
      )
      .get();
    if (!job) {
      throw new OntoCodeStoreError(
        "ontocode_harness_job_not_found",
        "The Harness Job does not belong to this Session",
        404,
        { sessionId, jobId },
      );
    }
    if (job.status !== "failed_recoverable") {
      throw new OntoCodeStoreError(
        "ontocode_harness_job_not_retryable",
        "Only a recoverable failed Harness Job can be explicitly retried",
        409,
        { sessionId, jobId, status: job.status },
      );
    }
    if (!job.commandId) {
      throw new OntoCodeStoreError(
        "ontocode_harness_retry_command_missing",
        "A user-requested Harness retry requires its original policy-derived Command",
        409,
        { sessionId, jobId },
      );
    }
    const live = tx
      .select({ id: ontocodeHarnessJobs.id })
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.sessionId, sessionId),
            inArray(ontocodeHarnessJobs.status, [
              "queued",
              "leased",
              "running",
              "retry_scheduled",
            ]),
          ),
        ),
      )
      .get();
    if (live) {
      throw new OntoCodeStoreError(
        "ontocode_harness_retry_conflict",
        "Another Harness Job is already active in this Session",
        409,
        { sessionId, jobId, activeJobId: live.id },
      );
    }
    const command = tx
      .select()
      .from(ontocodeCommands)
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(
          and(
            eq(ontocodeCommands.id, job.commandId),
            eq(ontocodeCommands.sessionId, sessionId),
          ),
        ),
      )
      .get();
    if (!command || command.status !== "failed") {
      throw new OntoCodeStoreError(
        "ontocode_harness_retry_command_stale",
        "The failed Harness Job's original Command is missing or no longer failed",
        409,
        {
          sessionId,
          jobId,
          commandId: job.commandId,
          commandStatus: command?.status ?? null,
        },
      );
    }
    // Attempt identity is owned by the Job row. Session events are immutable
    // audit output and must not be counted to reconstruct mutable state.
    const attempt = job.attemptNo;
    if (attempt < 1) {
      throw new OntoCodeStoreError(
        "ontocode_harness_retry_attempt_missing",
        "The failed Harness Job has no durable started attempt to retry",
        409,
        { sessionId, jobId },
      );
    }

    const now = new Date();
    const sessionRevision = session.revision + 1;
    const buildExecution = job.buildExecutionId
      ? tx
          .select()
          .from(ontocodeBuildExecutions)
          .where(
            tenantScope(
              ctx,
              ontocodeBuildExecutions,
            )(
              and(
                eq(ontocodeBuildExecutions.id, job.buildExecutionId),
                eq(ontocodeBuildExecutions.sessionId, sessionId),
              ),
            ),
          )
          .get()
      : null;
    if (
      job.buildExecutionId &&
      (!buildExecution ||
        buildExecution.projectId !== session.projectId ||
        buildExecution.state !== "failed_recoverable" ||
        (buildExecution.runtimeProfileVersionId ?? null) !==
          (job.runtimeProfileVersionId ?? null))
    ) {
      throw new OntoCodeStoreError(
        "ontocode_build_execution_retry_stale",
        "The recoverable Job is no longer bound to an exact failed OntoCode Build execution",
        409,
        {
          sessionId,
          jobId,
          buildExecutionId: job.buildExecutionId,
          executionState: buildExecution?.state ?? null,
        },
      );
    }
    const jobUpdate = tx
      .update(ontocodeHarnessJobs)
      .set({
        status: "retry_scheduled",
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.id, jobId),
            eq(ontocodeHarnessJobs.status, "failed_recoverable"),
          ),
        ),
      )
      .run();
    const executionUpdate = buildExecution
      ? tx
          .update(ontocodeBuildExecutions)
          .set({
            state: "resuming",
            revision: sql`${ontocodeBuildExecutions.revision} + 1`,
            updatedAt: now,
          })
          .where(
            tenantScope(
              ctx,
              ontocodeBuildExecutions,
            )(
              and(
                eq(ontocodeBuildExecutions.id, buildExecution.id),
                eq(ontocodeBuildExecutions.sessionId, sessionId),
                eq(ontocodeBuildExecutions.revision, buildExecution.revision),
                eq(ontocodeBuildExecutions.state, "failed_recoverable"),
              ),
            ),
          )
          .run()
      : null;
    const commandUpdate = tx
      .update(ontocodeCommands)
      .set({ status: "queued", updatedAt: now })
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(
          and(
            eq(ontocodeCommands.id, command.id),
            eq(ontocodeCommands.status, "failed"),
          ),
        ),
      )
      .run();
    const sessionUpdate = tx
      .update(ontocodeSessions)
      .set({
        activityState: "queued",
        revision: sessionRevision,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, session.revision),
          ),
        ),
      )
      .run();
    if (
      jobUpdate.changes !== 1 ||
      commandUpdate.changes !== 1 ||
      sessionUpdate.changes !== 1 ||
      (executionUpdate !== null && executionUpdate.changes !== 1)
    ) {
      throw new OntoCodeStoreError(
        "ontocode_harness_retry_raced",
        "The Harness Job changed while its retry was being scheduled",
        409,
        { sessionId, jobId },
      );
    }
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "harness.job.retry_scheduled",
        payload: {
          jobId,
          kind: job.kind,
          attempt,
          status: "retry_scheduled",
          retryAfterMs: 0,
          source: "fde",
          error: {
            code: "operator_retry",
            message:
              "The FDE explicitly retried this recoverable Harness failure",
            recoverable: true,
            retryable: true,
          },
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: jobId,
        commandId: command.id,
        harnessJobId: jobId,
      },
      now,
    );
    return {
      retried: true,
      sessionId,
      jobId,
      attempt,
      sessionRevision,
      event,
    };
  });
}

/**
 * Hard-delete a Build Session and everything scoped to it.
 *
 * `closeOntoCodeSession` is the graceful path and deliberately refuses to run
 * while work is live (idle-only, no blocking job/task) — which leaves parked
 * `needs_user` / `failed_recoverable` sessions permanently un-removable. Deleting
 * is the FDE's explicit "this attempt is scrap" verdict, so it must work from ANY
 * state. Live jobs are cancelled first inside the same transaction so a leased
 * worker cannot finalize against a row that is about to disappear; every child
 * table declares `onDelete: "cascade"` on its session FK (and the client sets
 * `foreign_keys = ON`), so the single row delete removes messages, events,
 * commands, jobs, artifacts, evidence, packages and configuration tasks with it.
 *
 * Content-addressed artifact blobs are intentionally NOT swept here: they are
 * shared, deduplicated by hash, and orphan sweeping is a separate GC concern.
 */
export function deleteOntoCodeSession(
  ctx: OntoCodeStoreContext,
  sessionId: string,
): {
  deleted: true;
  sessionId: string;
  title: string;
  cancelledJobs: number;
} {
  return getDb().transaction((tx) => {
    const current = tx
      .select()
      .from(ontocodeSessions)
      .where(
        tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
      )
      .get();
    if (!current) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "This OntoCode Session does not exist in the current Business Domain",
        404,
        { sessionId },
      );
    }
    const now = new Date();
    const cancelled = tx
      .update(ontocodeHarnessJobs)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.sessionId, sessionId),
            inArray(ontocodeHarnessJobs.status, [
              "queued",
              "leased",
              "running",
              "waiting_user",
              "retry_scheduled",
            ]),
          ),
        ),
      )
      .run();
    // #DELETE-RESTRICT —— SQLite 在做级联清扫【之前】就先判 ON DELETE RESTRICT，
    // 所以任何一条没被显式扫掉的 RESTRICT 边都会让整次删除直接失败。
    //
    // ontocode_evidence_invalidations 是唯一够不着的那条：它自己【没有】
    // session_id（只有 tenant/evidence/changeset/package_version），所以一阶
    // 级联永远碰不到它；而它对 ontocode_package_versions 的外键是 RESTRICT。
    // 后果：一个产出过候选包的 Session——也就是一次【成功 Build 之后】的
    // Session——根本删不掉，报的还是一句没有上下文的 FOREIGN KEY constraint
    // failed。今天库里 0 个候选包，所以这颗雷是哑的；第一次 Build 成功那天
    // 它就会响。已在库副本上实测：造出 package_version + evidence +
    // invalidation 后删 session 必失败，先扫掉 invalidation 再删即成功。
    //
    // 三条来路各扫一遍（证据 / 变更集 / 候选包），因为只按其中一条扫是不够的。
    const packageVersionIds = tx
      .select({ id: ontocodePackageVersions.id })
      .from(ontocodePackageVersions)
      .where(
        tenantScope(
          ctx,
          ontocodePackageVersions,
        )(eq(ontocodePackageVersions.sessionId, sessionId)),
      )
      .all()
      .map((row) => row.id);
    const changeSetIds = tx
      .select({ id: ontocodeChangeSets.id })
      .from(ontocodeChangeSets)
      .where(
        tenantScope(
          ctx,
          ontocodeChangeSets,
        )(eq(ontocodeChangeSets.sessionId, sessionId)),
      )
      .all()
      .map((row) => row.id);
    const evidenceIds = tx
      .select({ id: ontocodeEvidenceRecords.id })
      .from(ontocodeEvidenceRecords)
      .where(
        tenantScope(
          ctx,
          ontocodeEvidenceRecords,
        )(eq(ontocodeEvidenceRecords.sessionId, sessionId)),
      )
      .all()
      .map((row) => row.id);
    const invalidationPredicates = [
      packageVersionIds.length
        ? inArray(
            ontocodeEvidenceInvalidations.causedByPackageVersionId,
            packageVersionIds,
          )
        : undefined,
      changeSetIds.length
        ? inArray(
            ontocodeEvidenceInvalidations.causedByChangeSetId,
            changeSetIds,
          )
        : undefined,
      evidenceIds.length
        ? inArray(ontocodeEvidenceInvalidations.evidenceId, evidenceIds)
        : undefined,
    ].filter(Boolean);
    if (invalidationPredicates.length > 0) {
      tx.delete(ontocodeEvidenceInvalidations)
        .where(
          tenantScope(
            ctx,
            ontocodeEvidenceInvalidations,
          )(or(...invalidationPredicates)),
        )
        .run();
    }

    tx.delete(ontocodeSessions)
      .where(
        tenantScope(ctx, ontocodeSessions)(eq(ontocodeSessions.id, sessionId)),
      )
      .run();
    return {
      deleted: true as const,
      sessionId,
      title: current.title,
      cancelledJobs: cancelled.changes,
    };
  });
}

export function appendOntoCodeUserMessage(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: PostOntoCodeMessageRequest & { idempotencyKey: string },
): {
  message: OntoCodeMessage;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const existing = tx
      .select()
      .from(ontocodeSessionMessages)
      .where(
        tenantScope(
          ctx,
          ontocodeSessionMessages,
        )(
          and(
            eq(ontocodeSessionMessages.sessionId, sessionId),
            eq(ontocodeSessionMessages.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existing) {
      const message = messageFromRow(existing);
      if (message.content.text !== input.text || message.role !== "user") {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different message",
          409,
        );
      }
      return {
        message,
        event: requireCausationEvent(tx, ctx, sessionId, message.id),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    const now = new Date();
    const id = makeOntoCodeId("ocm");
    const correlationId = input.correlationId ?? makeOntoCodeId("cor");
    const row: typeof ontocodeSessionMessages.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      sessionId,
      role: "user",
      type: "text",
      contentJson: canonicalEvidenceJson({ text: input.text }),
      idempotencyKey: input.idempotencyKey,
      commandId: null,
      correlationId,
      createdAt: now,
    };
    tx.insert(ontocodeSessionMessages).values(row).run();
    const revision = session.revision + 1;
    tx.update(ontocodeSessions)
      .set({ revision, updatedAt: now, activityState: "ai_planning" })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, session.revision),
          ),
        ),
      )
      .run();
    const message = messageFromRow(
      row as typeof ontocodeSessionMessages.$inferSelect,
    );
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "session.message.appended",
        payload: { message },
        correlationId,
        causationId: id,
      },
      now,
    );
    return { message, event, sessionRevision: revision, mode: "created" };
  });
}

function turnChildIdempotencyKey(
  turnKey: string,
  child: "assistant" | "command" | "job",
): string {
  return `turn-${child}-${createHash("sha256").update(turnKey).digest("hex")}`;
}

interface CreateOntoCodeTurnServerInput extends PostOntoCodeTurnRequest {
  idempotencyKey: string;
  /**
   * Server-authored assistant output from the tenant LLM planner. These fields
   * are never accepted by the public turn schema and never influence command
   * policy; they only persist the already validated conversational plan.
   */
  assistantText?: string;
  assistantRecommendations?: Array<Record<string, unknown>>;
  /**
   * The compiled-context refs the answer stands on. Persisted as data so the
   * workspace can resolve them into links, instead of the model spelling
   * machine ids into the FDE's prose.
   */
  assistantCitedRefs?: string[];
  directiveTarget?: string;
  persistedRequestContent?: Record<string, unknown>;
  /** Server-only actor for automatic continuations such as verified config. */
  requestRole?: "user" | "system";
}

function turnRequestContent(input: CreateOntoCodeTurnServerInput) {
  if (input.persistedRequestContent) return input.persistedRequestContent;
  return {
    text: input.text,
    turn: {
      behavior: input.behavior,
      action: input.action ?? null,
      arguments: input.arguments,
      affectedSemanticPaths: input.affectedSemanticPaths,
      requestedCapabilities: input.requestedCapabilities,
    },
  };
}

/**
 * What each action is called when an FDE is the reader.
 *
 * The workspace already renders this vocabulary for job kinds; the server had
 * no equivalent and was spelling the raw command token (`propose_blueprint`)
 * straight into chat. One map, kept small, keyed on the action itself rather
 * than on the job kind — several actions share a job kind and would otherwise
 * be described as work they are not.
 */
const TURN_ACTION_LABEL: Record<
  OntoCodeTurnAction,
  { zh: string; en: string }
> = {
  analyze_ontology: { zh: "本体解读", en: "Reading the ontology" },
  analyze_scope: { zh: "范围分析", en: "The scope analysis" },
  propose_blueprint: { zh: "蓝图", en: "The blueprint" },
  create_configuration_task: {
    zh: "配置准备",
    en: "The configuration setup",
  },
  verify_configuration: { zh: "配置验证", en: "The configuration check" },
  generate_package: { zh: "代码生成", en: "The code generation" },
  patch_artifact: { zh: "改动", en: "The edit" },
  generate_tests: { zh: "测试编写", en: "Writing the tests" },
  run_tests: { zh: "验证", en: "The test run" },
  debug_failure: { zh: "修复", en: "The fix" },
  compare_candidate: { zh: "回归对比", en: "The regression comparison" },
  prepare_release: { zh: "上线准备", en: "The release preparation" },
  deploy_release: { zh: "部署", en: "The deployment" },
};

/**
 * The fallback acknowledgement, used whenever the planner authored no text.
 * Exported so #HUMAN-TEXT-GUARD can be applied to every branch it can produce.
 *
 * Every branch is written for the FDE: no ids, no engine object names, no
 * instructions about where to look. What survives is what is load-bearing —
 * whether anything was executed, and whether it will wait for approval.
 */
export function turnAssistantAcknowledgement(
  input: CreateOntoCodeTurnServerInput,
  session: OntoCodeBuildSession,
  directive: OntoCodeWorkspaceDirective,
): string {
  if (input.assistantText?.trim()) {
    return input.assistantText.normalize("NFKC").trim().slice(0, 4_000);
  }
  const chinese = /[\u3400-\u9fff]/u.test(`${input.text}\n${session.goal}`);
  if (directive.behavior === "navigate") {
    return chinese
      ? `已切换视图：“${input.text.slice(0, 200)}”，没有执行任何操作。`
      : `Switched the view to “${input.text.slice(0, 200)}”; nothing was executed.`;
  }
  if (directive.behavior === "explain") {
    // The Session's phase and activity are state-machine tokens; they used to be
    // printed raw. What the FDE needs from this turn is that nothing ran.
    return chinese
      ? "我在这里回答，不会执行或改动任何东西。"
      : "I am answering here; nothing was executed or changed.";
  }
  if (directive.behavior === "clarify") {
    return chinese
      ? "我还分不清你是想看结果、想听解释，还是要真的跑一次；在你说清楚之前，我不会执行任何操作。"
      : "I cannot tell yet whether you want to see results, hear an explanation, or actually run something, so I will not do anything until you say which.";
  }
  const label = TURN_ACTION_LABEL[directive.action];
  if (directive.requiresHuman) {
    // Load-bearing: this will not run until the FDE approves it.
    return chinese
      ? `${label.zh}已就绪，你批准之后才会执行。`
      : `${label.en} is ready and will not run until you approve it.`;
  }
  return chinese ? `${label.zh}已排队执行。` : `${label.en} is queued to run.`;
}

const LEGACY_BUILD_EXECUTION_ADOPTION_SCHEMA =
  "ontocode-legacy-build-execution-adoption/v1" as const;

type PendingBuildInteractionKind =
  | "clarify"
  | "test_approval"
  | "boundary"
  | "execution_readiness"
  | "legacy_answer";

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
    kind: PendingBuildInteractionKind;
    subjectDigest: string;
  };
}

function nonEmptyStoreString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256StoreValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(value))
    .digest("hex");
}

function isSha256StoreValue(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function parseLegacyWaitingEventPayload(
  payloadJson: string,
  waitingJobId: string,
): Record<string, unknown> {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = recordValue(JSON.parse(payloadJson) as unknown);
  } catch {
    // Fall through to the fail-closed error below. A malformed audit row is
    // not a source from which a product lifecycle may be reconstructed.
  }
  if (!payload || payload.jobId !== waitingJobId || payload.kind !== "build") {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_waiting_receipt_invalid",
      "The legacy waiting Build does not have one valid server-authored waiting receipt",
      409,
      { waitingJobId },
    );
  }
  return payload;
}

function interactionKindForLegacyWaitingReceipt(
  interaction: Record<string, unknown> | null,
  question: Record<string, unknown> | null,
): PendingBuildInteractionKind {
  const kind = nonEmptyStoreString(interaction?.kind);
  if (
    kind === "clarify" ||
    kind === "test_approval" ||
    kind === "boundary" ||
    kind === "execution_readiness" ||
    kind === "legacy_answer"
  ) {
    return kind;
  }
  return question?.kind === "config" ? "execution_readiness" : "clarify";
}

function legacyInteractionEnvelope(input: {
  waitingJobId: string;
  payload: Record<string, unknown>;
}): {
  id: string;
  kind: PendingBuildInteractionKind;
  subjectDigest: string;
} {
  const receipt = recordValue(input.payload.receipt);
  const interaction = recordValue(receipt?.interaction);
  const question = recordValue(input.payload.question);
  if (!interaction && !question) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_interaction_missing",
      "The legacy waiting Build has no exact interaction envelope to answer",
      409,
      { waitingJobId: input.waitingJobId },
    );
  }
  if (interaction && interaction.awaitingAnswer !== true) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_interaction_invalid",
      "The legacy Build receipt does not identify an active pending interaction",
      409,
      { waitingJobId: input.waitingJobId },
    );
  }

  const receiptInteractionId = nonEmptyStoreString(interaction?.interactionId);
  const questionId = nonEmptyStoreString(question?.id);
  if (
    receiptInteractionId &&
    questionId &&
    receiptInteractionId !== questionId
  ) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_interaction_ambiguous",
      "The legacy waiting receipt names two different pending interactions",
      409,
      {
        waitingJobId: input.waitingJobId,
        receiptInteractionId,
        questionId,
      },
    );
  }

  // Prefer the engine-facing envelope because the resume bridge validates the
  // same digest against the private checkpoint. A pre-execution structured
  // question has no such envelope, so its complete server-authored object is
  // the immutable subject instead.
  const subject = interaction
    ? {
        question: nonEmptyStoreString(interaction.question) ?? "OntoCode input",
        context: interaction.context ?? null,
        options: Array.isArray(interaction.options) ? interaction.options : [],
        items: Array.isArray(interaction.items) ? interaction.items : [],
      }
    : question!;
  const subjectDigest = sha256StoreValue(subject);
  const id =
    receiptInteractionId ?? questionId ?? `oci-${subjectDigest.slice(0, 16)}`;
  return {
    id,
    kind: interactionKindForLegacyWaitingReceipt(interaction, question),
    subjectDigest,
  };
}

function validateExistingLegacyExecutionDirective(input: {
  execution: typeof ontocodeBuildExecutions.$inferSelect;
  descriptor: LegacyBuildExecutionAdoptionDescriptor;
  requestedActionIds: string[];
}): void {
  let directive: Record<string, unknown> | null = null;
  try {
    directive = recordValue(
      JSON.parse(input.execution.directiveJson) as unknown,
    );
  } catch {
    // Handled below.
  }
  const computedHash = directive ? sha256StoreValue(directive) : null;
  const descriptorMatches =
    directive?.schema === LEGACY_BUILD_EXECUTION_ADOPTION_SCHEMA &&
    computedHash === input.execution.directiveHash &&
    canonicalEvidenceJson(directive) ===
      canonicalEvidenceJson(input.descriptor);
  const directiveActionIds = Array.isArray(directive?.requestedActionIds)
    ? directive.requestedActionIds.flatMap((value) =>
        typeof value === "string" && value.trim() ? [value.trim()] : [],
      )
    : [];
  const expectedActions = new Set(input.requestedActionIds);
  const existingActions = new Set(directiveActionIds);
  const modernDirectiveMatches =
    directive?.schema === "agent-factory-generation-directive/v1" &&
    directive.sourceOntologyHash === input.descriptor.ontologyHash &&
    (input.requestedActionIds.length === 0 ||
      (expectedActions.size === existingActions.size &&
        [...expectedActions].every((id) => existingActions.has(id))));
  if (!descriptorMatches && !modernDirectiveMatches) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_execution_conflict",
      "An existing OntoCode Build execution has a different immutable generation directive",
      409,
      { buildExecutionId: input.execution.id },
    );
  }
}

/**
 * Adopt the one pre-execution-identity waiting Build shape that can be proven
 * from durable server records. This is intentionally transaction-local: a
 * half-created execution must never escape if the answer transfer later loses
 * its CAS.
 */
function adoptLegacyWaitingBuildExecution(
  tx: Transaction,
  ctx: OntoCodeStoreContext,
  input: {
    session: typeof ontocodeSessions.$inferSelect;
    command: typeof ontocodeCommands.$inferSelect;
    childJob: typeof ontocodeHarnessJobs.$inferSelect;
    waitingJob: typeof ontocodeHarnessJobs.$inferSelect;
    now: Date;
  },
): string {
  const waitingEvents = tx
    .select({ payloadJson: ontocodeSessionEvents.payloadJson })
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, input.session.id),
          eq(ontocodeSessionEvents.harnessJobId, input.waitingJob.id),
          eq(ontocodeSessionEvents.type, "harness.build.waiting_user"),
        ),
      ),
    )
    .all();
  if (waitingEvents.length !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_waiting_receipt_ambiguous",
      "A legacy waiting Build must have exactly one durable waiting receipt",
      409,
      {
        waitingJobId: input.waitingJob.id,
        waitingReceiptCount: waitingEvents.length,
      },
    );
  }
  const waitingPayload = parseLegacyWaitingEventPayload(
    waitingEvents[0]!.payloadJson,
    input.waitingJob.id,
  );
  const receipt = recordValue(waitingPayload.receipt);
  if (
    receipt &&
    (receipt.schema !== "ontocode-build-receipt/v1" ||
      receipt.status !== "waiting_human")
  ) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_waiting_receipt_invalid",
      "The legacy Build receipt is not an OntoCode waiting-human receipt",
      409,
      { waitingJobId: input.waitingJob.id },
    );
  }
  const interaction = legacyInteractionEnvelope({
    waitingJobId: input.waitingJob.id,
    payload: waitingPayload,
  });

  const project = tx
    .select()
    .from(ontocodeProjects)
    .where(
      tenantScope(
        ctx,
        ontocodeProjects,
      )(eq(ontocodeProjects.id, input.session.projectId)),
    )
    .get();
  if (!project || !project.ontologyDomainRegistrationId) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_project_binding_missing",
      "The legacy waiting Build is not pinned to one exact Ontology Domain registration",
      409,
      { waitingJobId: input.waitingJob.id },
    );
  }
  const registration = tx
    .select()
    .from(businessOntologyDomains)
    .where(
      and(
        eq(businessOntologyDomains.tenantId, ctx.tenantId),
        eq(businessOntologyDomains.id, project.ontologyDomainRegistrationId),
        eq(businessOntologyDomains.ontologyDomainId, project.domain),
        eq(businessOntologyDomains.status, "active"),
        isNull(businessOntologyDomains.archivedAt),
      ),
    )
    .get();
  if (!registration) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_project_binding_stale",
      "The legacy waiting Build's exact Ontology Domain registration is no longer active",
      409,
      { waitingJobId: input.waitingJob.id },
    );
  }

  const runtimeProfileVersionId = input.session.runtimeProfileVersionId ?? null;
  const runtimeBindings = [
    project.runtimeProfileVersionId ?? null,
    registration.runtimeProfileVersionId ?? null,
    input.waitingJob.runtimeProfileVersionId ?? null,
    input.childJob.runtimeProfileVersionId ?? null,
  ];
  if (runtimeBindings.some((value) => value !== runtimeProfileVersionId)) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_runtime_changed",
      "The legacy waiting Build is not pinned to the Session's exact Runtime Profile",
      409,
      {
        waitingJobId: input.waitingJob.id,
        sessionRuntimeProfileVersionId: runtimeProfileVersionId,
        projectRuntimeProfileVersionId: project.runtimeProfileVersionId ?? null,
        registrationRuntimeProfileVersionId:
          registration.runtimeProfileVersionId ?? null,
        waitingRuntimeProfileVersionId:
          input.waitingJob.runtimeProfileVersionId ?? null,
        followUpRuntimeProfileVersionId:
          input.childJob.runtimeProfileVersionId ?? null,
      },
    );
  }

  const waitingCommand = input.waitingJob.commandId
    ? tx
        .select()
        .from(ontocodeCommands)
        .where(
          tenantScope(
            ctx,
            ontocodeCommands,
          )(
            and(
              eq(ontocodeCommands.id, input.waitingJob.commandId),
              eq(ontocodeCommands.sessionId, input.session.id),
            ),
          ),
        )
        .get()
    : null;
  if (input.waitingJob.commandId && !waitingCommand) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_command_missing",
      "The legacy waiting Build's source Command no longer exists",
      409,
      { waitingJobId: input.waitingJob.id },
    );
  }
  if (waitingCommand && waitingCommand.type !== "generate_package") {
    throw new OntoCodeStoreError(
      "ontocode_waiting_job_kind_mismatch",
      "The legacy waiting Build is not owned by a code-generation Command",
      409,
      { waitingJobId: input.waitingJob.id, commandType: waitingCommand.type },
    );
  }

  const ontologyCandidates = [
    input.session.ontologySnapshotHash,
    input.command.baseOntologyHash,
    waitingCommand?.baseOntologyHash,
    registration.ontologySnapshotHash,
    nonEmptyStoreString(receipt?.ontologyHash),
    nonEmptyStoreString(waitingPayload.ontologyHash),
  ].flatMap((value) => (value ? [value] : []));
  if (
    ontologyCandidates.length === 0 ||
    ontologyCandidates.some((value) => !isSha256StoreValue(value)) ||
    new Set(ontologyCandidates).size !== 1
  ) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_ontology_ambiguous",
      "The legacy waiting Build cannot be bound to one exact authoritative Ontology snapshot",
      409,
      {
        waitingJobId: input.waitingJob.id,
        ontologyHashes: [...new Set(ontologyCandidates)],
      },
    );
  }
  const ontologyHash = ontologyCandidates[0]!;

  const factoryStartedRows = tx
    .select({ payloadJson: ontocodeSessionEvents.payloadJson })
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, input.session.id),
          eq(ontocodeSessionEvents.harnessJobId, input.waitingJob.id),
          eq(ontocodeSessionEvents.type, "harness.build.factory_started"),
        ),
      ),
    )
    .all();
  const factoryRunCandidates = [
    nonEmptyStoreString(receipt?.factoryRunId),
    ...factoryStartedRows.map((row) => {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = recordValue(JSON.parse(row.payloadJson) as unknown);
      } catch {
        // Rejected immediately below.
      }
      if (!payload || payload.jobId !== input.waitingJob.id) {
        throw new OntoCodeStoreError(
          "ontocode_legacy_build_engine_evidence_invalid",
          "A legacy Build start record does not belong to the exact waiting Job",
          409,
          { waitingJobId: input.waitingJob.id },
        );
      }
      const runId = nonEmptyStoreString(payload.factoryRunId);
      if (!runId) {
        throw new OntoCodeStoreError(
          "ontocode_legacy_build_engine_evidence_invalid",
          "A legacy Build start record does not identify its private generation run",
          409,
          { waitingJobId: input.waitingJob.id },
        );
      }
      return runId;
    }),
  ].flatMap((value) => (value ? [value] : []));
  const distinctFactoryRunIds = [...new Set(factoryRunCandidates)];
  if (distinctFactoryRunIds.length > 1) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_engine_ambiguous",
      "The legacy waiting Build names more than one private generation run",
      409,
      {
        waitingJobId: input.waitingJob.id,
        factoryRunIds: distinctFactoryRunIds,
      },
    );
  }
  const engineRunId = distinctFactoryRunIds[0] ?? null;
  if (engineRunId) {
    const factoryRun = tx
      .select()
      .from(factoryRuns)
      .where(eq(factoryRuns.id, engineRunId))
      .get();
    const conversation = tx
      .select({
        tenantId: factoryConversations.tenantId,
        domain: factoryConversations.domain,
      })
      .from(factoryConversations)
      .where(eq(factoryConversations.id, engineRunId))
      .get();
    if (
      !factoryRun ||
      factoryRun.tenantId !== ctx.tenantId ||
      factoryRun.domain !== project.domain ||
      factoryRun.status !== "waiting_human" ||
      factoryRun.deletedAt !== null ||
      (factoryRun.ontologyDomainRegistrationId ?? null) !==
        project.ontologyDomainRegistrationId ||
      (factoryRun.runtimeProfileVersionId ?? null) !==
        runtimeProfileVersionId ||
      !conversation ||
      conversation.tenantId !== ctx.tenantId ||
      conversation.domain !== project.domain
    ) {
      throw new OntoCodeStoreError(
        "ontocode_legacy_build_engine_stale",
        "The legacy waiting Build's private generation checkpoint is missing or bound to different immutable inputs",
        409,
        { waitingJobId: input.waitingJob.id, engineRunId },
      );
    }
  }

  const rawRequestedActionIds = commandFromRow(input.command).arguments
    .actionIds;
  const requestedActionIds = Array.isArray(rawRequestedActionIds)
    ? rawRequestedActionIds.flatMap((value: unknown) =>
        typeof value === "string" && value.trim() ? [value.trim()] : [],
      )
    : [];
  const descriptor: LegacyBuildExecutionAdoptionDescriptor = {
    schema: LEGACY_BUILD_EXECUTION_ADOPTION_SCHEMA,
    sourceHarnessJobId: input.waitingJob.id,
    projectId: project.id,
    sessionId: input.session.id,
    ontologyHash,
    runtimeProfileVersionId,
    engineRunId,
    interaction,
  };
  const deterministicExecutionId = `ocx-${input.waitingJob.id.replace(
    /^ocj-/,
    "",
  )}`;
  const receiptExecutionId = nonEmptyStoreString(receipt?.buildExecutionId);
  const engineOwner = engineRunId
    ? tx
        .select()
        .from(ontocodeBuildExecutions)
        .where(
          and(
            eq(ontocodeBuildExecutions.tenantId, ctx.tenantId),
            eq(ontocodeBuildExecutions.engineKind, "agent_factory"),
            eq(ontocodeBuildExecutions.engineRunId, engineRunId),
          ),
        )
        .get()
    : null;
  const deterministicExecution = tx
    .select()
    .from(ontocodeBuildExecutions)
    .where(
      and(
        eq(ontocodeBuildExecutions.tenantId, ctx.tenantId),
        eq(ontocodeBuildExecutions.id, deterministicExecutionId),
      ),
    )
    .get();
  const receiptExecution = receiptExecutionId
    ? tx
        .select()
        .from(ontocodeBuildExecutions)
        .where(
          and(
            eq(ontocodeBuildExecutions.tenantId, ctx.tenantId),
            eq(ontocodeBuildExecutions.id, receiptExecutionId),
          ),
        )
        .get()
    : null;
  if (receiptExecutionId && !receiptExecution) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_execution_conflict",
      "The waiting receipt names an OntoCode Build execution that no longer exists",
      409,
      {
        waitingJobId: input.waitingJob.id,
        buildExecutionId: receiptExecutionId,
      },
    );
  }
  const existingCandidates = [
    engineOwner,
    deterministicExecution,
    receiptExecution,
  ].flatMap((value) => (value ? [value] : []));
  if (new Set(existingCandidates.map((row) => row.id)).size > 1) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_execution_conflict",
      "The legacy waiting Build points at conflicting OntoCode executions",
      409,
      {
        waitingJobId: input.waitingJob.id,
        buildExecutionIds: [
          ...new Set(existingCandidates.map((row) => row.id)),
        ],
      },
    );
  }
  const existing = existingCandidates[0] ?? null;
  const executionId = existing?.id ?? deterministicExecutionId;

  if (existing) {
    if (
      existing.projectId !== project.id ||
      existing.sessionId !== input.session.id ||
      existing.state !== "waiting_user" ||
      existing.ontologyHash !== ontologyHash ||
      existing.engineKind !== "agent_factory" ||
      (existing.engineRunId ?? null) !== engineRunId ||
      (existing.runtimeProfileVersionId ?? null) !== runtimeProfileVersionId ||
      existing.pendingInteractionId !== interaction.id ||
      existing.pendingInteractionKind !== interaction.kind ||
      existing.pendingInteractionSubjectDigest !== interaction.subjectDigest ||
      existing.pendingAnswerId !== null ||
      existing.pendingAnswerDigest !== null ||
      existing.pendingAnswerStatus !== null
    ) {
      throw new OntoCodeStoreError(
        "ontocode_legacy_build_execution_conflict",
        "An existing OntoCode Build execution does not match the exact legacy waiting checkpoint",
        409,
        { waitingJobId: input.waitingJob.id, buildExecutionId: existing.id },
      );
    }
    validateExistingLegacyExecutionDirective({
      execution: existing,
      descriptor,
      requestedActionIds,
    });
  } else {
    const descriptorJson = canonicalEvidenceJson(descriptor);
    tx.insert(ontocodeBuildExecutions)
      .values({
        id: executionId,
        tenantId: ctx.tenantId,
        projectId: project.id,
        sessionId: input.session.id,
        state: "waiting_user",
        ontologyHash,
        directiveJson: descriptorJson,
        directiveHash: sha256StoreValue(descriptor),
        runtimeProfileVersionId,
        engineKind: "agent_factory",
        // No historical private run is invented here. The worker may create
        // the first one later; it may never create a second one by guessing.
        engineRunId,
        checkpointDigest: sha256StoreValue(waitingPayload),
        checkpointRevision:
          Number.isSafeInteger(waitingPayload.attempt) &&
          Number(waitingPayload.attempt) > 0
            ? Number(waitingPayload.attempt)
            : Math.max(1, input.waitingJob.attemptNo),
        pendingInteractionId: interaction.id,
        pendingInteractionKind: interaction.kind,
        pendingInteractionSubjectDigest: interaction.subjectDigest,
        pendingAnswerId: null,
        pendingAnswerDigest: null,
        pendingAnswerStatus: null,
        revision: 1,
        createdAt: input.waitingJob.createdAt,
        updatedAt: input.now,
      })
      .run();
  }

  const otherExecutionJobs = tx
    .select({ id: ontocodeHarnessJobs.id })
    .from(ontocodeHarnessJobs)
    .where(
      and(
        eq(ontocodeHarnessJobs.tenantId, ctx.tenantId),
        eq(ontocodeHarnessJobs.buildExecutionId, executionId),
      ),
    )
    .all()
    .filter((row) => row.id !== input.waitingJob.id);
  if (otherExecutionJobs.length > 0) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_execution_conflict",
      "The adopted OntoCode Build execution is already owned by another Harness Job",
      409,
      {
        waitingJobId: input.waitingJob.id,
        buildExecutionId: executionId,
        conflictingJobIds: otherExecutionJobs.map((row) => row.id),
      },
    );
  }

  const parentBinding = tx
    .update(ontocodeHarnessJobs)
    .set({ buildExecutionId: executionId, updatedAt: input.now })
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, input.waitingJob.id),
          eq(ontocodeHarnessJobs.sessionId, input.session.id),
          eq(ontocodeHarnessJobs.kind, "build"),
          eq(ontocodeHarnessJobs.status, "waiting_user"),
          isNull(ontocodeHarnessJobs.buildExecutionId),
        ),
      ),
    )
    .run();
  if (parentBinding.changes !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_legacy_build_execution_changed",
      "The legacy waiting Build changed while its OntoCode execution was being adopted",
      409,
      { waitingJobId: input.waitingJob.id },
    );
  }

  if (!input.session.ontologySnapshotHash) {
    const pinned = tx
      .update(ontocodeSessions)
      .set({ ontologySnapshotHash: ontologyHash, updatedAt: input.now })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, input.session.id),
            isNull(ontocodeSessions.ontologySnapshotHash),
          ),
        ),
      )
      .run();
    if (pinned.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_legacy_build_ontology_changed",
        "The Session Ontology pin changed while the legacy Build was being adopted",
        409,
        { waitingJobId: input.waitingJob.id },
      );
    }
  }
  for (const commandRow of [input.command, waitingCommand].filter(
    (row): row is typeof ontocodeCommands.$inferSelect =>
      Boolean(row && !row.baseOntologyHash),
  )) {
    const pinned = tx
      .update(ontocodeCommands)
      .set({ baseOntologyHash: ontologyHash, updatedAt: input.now })
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(
          and(
            eq(ontocodeCommands.id, commandRow.id),
            eq(ontocodeCommands.sessionId, input.session.id),
            isNull(ontocodeCommands.baseOntologyHash),
          ),
        ),
      )
      .run();
    if (pinned.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_legacy_build_ontology_changed",
        "A Build Command's Ontology pin changed during legacy adoption",
        409,
        { waitingJobId: input.waitingJob.id, commandId: commandRow.id },
      );
    }
  }
  return executionId;
}

/**
 * Atomically move one exact OntoCode Build human gate onto its follow-up Job.
 *
 * Both the chat-turn API and the lower-level Command + Harness Job API can
 * create continuations. Keeping this transaction-local prevents those entry
 * points from disagreeing about the stable Build identity or reconstructing a
 * one-shot answer from audit events.
 */
function attachOntoCodeBuildContinuation(
  tx: Transaction,
  ctx: OntoCodeStoreContext,
  input: {
    session: typeof ontocodeSessions.$inferSelect;
    command: typeof ontocodeCommands.$inferSelect | null;
    childJobId: string;
    childJobKind: OntoCodeHarnessJob["kind"];
    answerReferenceId: string;
    sourceMessageId?: string;
    correlationId: string;
    causationId: string;
    now: Date;
  },
): typeof ontocodeHarnessJobs.$inferSelect | null {
  if (!input.command) return null;
  let command = commandFromRow(input.command);
  const commandArguments = command.arguments;
  const hasWaitingJobArgument = Object.prototype.hasOwnProperty.call(
    commandArguments,
    "resumeWaitingUserJobId",
  );
  const hasAnswerArgument = Object.prototype.hasOwnProperty.call(
    commandArguments,
    "clarificationAnswer",
  );
  if (!hasWaitingJobArgument && !hasAnswerArgument) return null;

  const resumeWaitingUserJobId =
    typeof commandArguments.resumeWaitingUserJobId === "string"
      ? commandArguments.resumeWaitingUserJobId.trim()
      : "";
  const clarificationAnswer =
    typeof commandArguments.clarificationAnswer === "string"
      ? commandArguments.clarificationAnswer.trim()
      : "";
  if (!resumeWaitingUserJobId) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_parent_missing",
      "A Build clarification answer must reference the exact waiting OntoCode Job",
      409,
      { commandId: command.id },
    );
  }
  if (!clarificationAnswer) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_answer_missing",
      "The Build continuation must answer the exact pending OntoCode interaction",
      409,
      { resumeWaitingUserJobId },
    );
  }
  if (command.type !== "generate_package" || input.childJobKind !== "build") {
    throw new OntoCodeStoreError(
      "ontocode_waiting_job_kind_mismatch",
      "Only a Build Command may continue a waiting OntoCode Build interaction",
      409,
      {
        commandId: command.id,
        commandType: command.type,
        followUpJobKind: input.childJobKind,
      },
    );
  }
  if (resumeWaitingUserJobId === input.childJobId) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_parent_cycle",
      "A Build continuation must reference a different waiting OntoCode Job",
      409,
      { resumeWaitingUserJobId, childJobId: input.childJobId },
    );
  }

  const childJob = tx
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, input.childJobId),
          eq(ontocodeHarnessJobs.sessionId, input.session.id),
        ),
      ),
    )
    .get();
  if (!childJob || childJob.kind !== "build") {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_job_missing",
      "The follow-up Build Job disappeared before its execution could be attached",
      409,
      { childJobId: input.childJobId },
    );
  }
  let waitingJob = tx
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, resumeWaitingUserJobId),
          eq(ontocodeHarnessJobs.sessionId, input.session.id),
        ),
      ),
    )
    .get();
  if (!waitingJob || waitingJob.status !== "waiting_user") {
    throw new OntoCodeStoreError(
      "ontocode_waiting_job_not_resumable",
      "The referenced Harness Job is not waiting for input in this Session",
      409,
      { resumeWaitingUserJobId },
    );
  }
  if (waitingJob.kind !== "build") {
    throw new OntoCodeStoreError(
      "ontocode_waiting_job_kind_mismatch",
      "The referenced waiting Job is not an OntoCode Build",
      409,
      {
        resumeWaitingUserJobId,
        waitingJobKind: waitingJob.kind,
        followUpJobKind: childJob.kind,
      },
    );
  }
  if (!waitingJob.buildExecutionId) {
    adoptLegacyWaitingBuildExecution(tx, ctx, {
      session: input.session,
      command: input.command,
      childJob,
      waitingJob,
      now: input.now,
    });
    waitingJob = tx
      .select()
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.id, resumeWaitingUserJobId),
            eq(ontocodeHarnessJobs.sessionId, input.session.id),
          ),
        ),
      )
      .get()!;
    const reboundCommand = tx
      .select()
      .from(ontocodeCommands)
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(eq(ontocodeCommands.id, input.command.id)),
      )
      .get();
    if (!reboundCommand || !waitingJob.buildExecutionId) {
      throw new OntoCodeStoreError(
        "ontocode_build_execution_missing",
        "The waiting Build could not be bound to its stable OntoCode execution",
        409,
        { resumeWaitingUserJobId },
      );
    }
    command = commandFromRow(reboundCommand);
  }
  const runtimeProfileVersionId = input.session.runtimeProfileVersionId ?? null;
  if (
    (waitingJob.runtimeProfileVersionId ?? null) !== runtimeProfileVersionId ||
    (childJob.runtimeProfileVersionId ?? null) !== runtimeProfileVersionId
  ) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_runtime_changed",
      "The waiting and follow-up Builds are not pinned to the same Runtime Profile",
      409,
      {
        buildExecutionId: waitingJob.buildExecutionId,
        waitingRuntimeProfileVersionId:
          waitingJob.runtimeProfileVersionId ?? null,
        followUpRuntimeProfileVersionId:
          childJob.runtimeProfileVersionId ?? null,
        sessionRuntimeProfileVersionId: runtimeProfileVersionId,
      },
    );
  }

  const execution = tx
    .select()
    .from(ontocodeBuildExecutions)
    .where(
      tenantScope(
        ctx,
        ontocodeBuildExecutions,
      )(
        and(
          eq(ontocodeBuildExecutions.id, waitingJob.buildExecutionId),
          eq(ontocodeBuildExecutions.sessionId, input.session.id),
        ),
      ),
    )
    .get();
  if (
    !execution ||
    execution.projectId !== input.session.projectId ||
    execution.engineKind !== "agent_factory" ||
    (execution.runtimeProfileVersionId ?? null) !== runtimeProfileVersionId ||
    command.baseOntologyHash !== execution.ontologyHash
  ) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_binding_mismatch",
      "The pending OntoCode Build no longer matches this Session, Ontology, or Runtime Profile",
      409,
      {
        buildExecutionId: waitingJob.buildExecutionId,
        commandOntologyHash: command.baseOntologyHash,
        executionOntologyHash: execution?.ontologyHash ?? null,
      },
    );
  }
  if (
    execution.state !== "waiting_user" ||
    !execution.pendingInteractionId ||
    !execution.pendingInteractionKind ||
    !execution.pendingInteractionSubjectDigest ||
    execution.pendingAnswerId !== null ||
    execution.pendingAnswerDigest !== null ||
    execution.pendingAnswerStatus !== null
  ) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_interaction_changed",
      "The pending OntoCode Build interaction changed before this answer could be attached",
      409,
      {
        buildExecutionId: execution.id,
        resumeWaitingUserJobId,
      },
    );
  }

  const answerDigest = createHash("sha256")
    .update(clarificationAnswer)
    .digest("hex");
  const executionUpdate = tx
    .update(ontocodeBuildExecutions)
    .set({
      state: "resuming",
      pendingAnswerId: input.answerReferenceId,
      pendingAnswerDigest: answerDigest,
      pendingAnswerStatus: "pending",
      revision: sql`${ontocodeBuildExecutions.revision} + 1`,
      updatedAt: input.now,
    })
    .where(
      tenantScope(
        ctx,
        ontocodeBuildExecutions,
      )(
        and(
          eq(ontocodeBuildExecutions.id, execution.id),
          eq(ontocodeBuildExecutions.sessionId, input.session.id),
          eq(ontocodeBuildExecutions.revision, execution.revision),
          eq(ontocodeBuildExecutions.state, "waiting_user"),
          eq(
            ontocodeBuildExecutions.pendingInteractionId,
            execution.pendingInteractionId,
          ),
          isNull(ontocodeBuildExecutions.pendingAnswerId),
          isNull(ontocodeBuildExecutions.pendingAnswerDigest),
          isNull(ontocodeBuildExecutions.pendingAnswerStatus),
        ),
      ),
    )
    .run();
  if (executionUpdate.changes !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_interaction_changed",
      "The pending OntoCode Build interaction changed before this answer could be attached",
      409,
      {
        buildExecutionId: execution.id,
        resumeWaitingUserJobId,
      },
    );
  }

  const childUpdate = tx
    .update(ontocodeHarnessJobs)
    .set({ buildExecutionId: execution.id, updatedAt: input.now })
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, childJob.id),
          eq(ontocodeHarnessJobs.sessionId, input.session.id),
          eq(ontocodeHarnessJobs.kind, "build"),
          isNull(ontocodeHarnessJobs.buildExecutionId),
        ),
      ),
    )
    .run();
  if (childUpdate.changes !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_job_binding_changed",
      "The follow-up Job changed while its OntoCode Build execution was being attached",
      409,
      { buildExecutionId: execution.id, childJobId: childJob.id },
    );
  }

  const parentUpdate = tx
    .update(ontocodeHarnessJobs)
    .set({
      status: "cancelled",
      finishedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(
        and(
          eq(ontocodeHarnessJobs.id, waitingJob.id),
          eq(ontocodeHarnessJobs.sessionId, input.session.id),
          eq(ontocodeHarnessJobs.status, "waiting_user"),
          eq(ontocodeHarnessJobs.buildExecutionId, execution.id),
        ),
      ),
    )
    .run();
  if (parentUpdate.changes !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_parent_changed",
      "The waiting Build changed before its follow-up Job could take ownership",
      409,
      { buildExecutionId: execution.id, resumeWaitingUserJobId },
    );
  }

  const existingResolution = tx
    .select({ id: ontocodeSessionEvents.id })
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, input.session.id),
          eq(ontocodeSessionEvents.harnessJobId, childJob.id),
          eq(ontocodeSessionEvents.type, "harness.job.input_resolved"),
        ),
      ),
    )
    .get();
  if (existingResolution) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_resolution_ambiguous",
      "The follow-up Build already has an input-resolution audit link",
      409,
      { buildExecutionId: execution.id, childJobId: childJob.id },
    );
  }
  appendEvent(
    tx,
    ctx,
    {
      projectId: input.session.projectId,
      sessionId: input.session.id,
      type: "harness.job.input_resolved",
      payload: {
        waitingJobId: waitingJob.id,
        followUpJobId: childJob.id,
        buildExecutionId: execution.id,
        interactionId: execution.pendingInteractionId,
        pendingAnswerId: input.answerReferenceId,
        ...(input.sourceMessageId
          ? { sourceMessageId: input.sourceMessageId }
          : {}),
      },
      correlationId: input.correlationId,
      causationId: input.causationId,
      commandId: command.id,
      harnessJobId: childJob.id,
    },
    input.now,
  );

  const reboundJob = tx
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(
        ctx,
        ontocodeHarnessJobs,
      )(eq(ontocodeHarnessJobs.id, childJob.id)),
    )
    .get();
  if (!reboundJob) {
    throw new OntoCodeStoreError(
      "ontocode_build_execution_job_missing",
      "The follow-up Build Job disappeared while its execution was attached",
      409,
      { childJobId: childJob.id },
    );
  }
  return reboundJob;
}

/**
 * A complete chat turn is committed in one SQLite transaction: user message,
 * optional command/job, durable workspace directive, assistant acknowledgement,
 * events, and the session revision. This is deliberately not a best-effort
 * composition of the public message/command/job functions.
 */
export function createOntoCodeTurn(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateOntoCodeTurnServerInput,
): OntoCodeTurnReceipt {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const expectedUserContent = turnRequestContent(input);
    const requestRole = input.requestRole ?? "user";
    const existingUserRow = tx
      .select()
      .from(ontocodeSessionMessages)
      .where(
        tenantScope(
          ctx,
          ontocodeSessionMessages,
        )(
          and(
            eq(ontocodeSessionMessages.sessionId, sessionId),
            eq(ontocodeSessionMessages.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();

    const now = new Date();
    let correlationId = input.correlationId ?? makeOntoCodeId("cor");
    let userMessageId: string;
    let userMessage: OntoCodeMessage;

    if (existingUserRow) {
      userMessage = messageFromRow(existingUserRow);
      if (
        userMessage.role !== requestRole ||
        canonicalEvidenceJson(userMessage.content) !==
          canonicalEvidenceJson(expectedUserContent)
      ) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different chat turn",
          409,
        );
      }
      const assistantRow = tx
        .select()
        .from(ontocodeSessionMessages)
        .where(
          tenantScope(
            ctx,
            ontocodeSessionMessages,
          )(
            and(
              eq(ontocodeSessionMessages.sessionId, sessionId),
              eq(
                ontocodeSessionMessages.idempotencyKey,
                turnChildIdempotencyKey(input.idempotencyKey, "assistant"),
              ),
            ),
          ),
        )
        .get();
      if (assistantRow) {
        const assistantMessage = messageFromRow(assistantRow);
        const directive = OntoCodeWorkspaceDirectiveSchema.parse(
          assistantMessage.content.directive,
        );
        let command: OntoCodeCommand | null = null;
        let job: OntoCodeHarnessJob | null = null;
        if (directive.behavior === "execute") {
          const commandRow = tx
            .select()
            .from(ontocodeCommands)
            .where(
              tenantScope(
                ctx,
                ontocodeCommands,
              )(eq(ontocodeCommands.id, directive.commandId)),
            )
            .get();
          const jobRow = tx
            .select()
            .from(ontocodeHarnessJobs)
            .where(
              tenantScope(
                ctx,
                ontocodeHarnessJobs,
              )(eq(ontocodeHarnessJobs.id, directive.harnessJobId)),
            )
            .get();
          if (!commandRow || !jobRow) {
            throw new OntoCodeStoreError(
              "ontocode_data_corrupt",
              "The idempotent execute turn is missing its command or job",
              500,
            );
          }
          command = commandFromRow(commandRow);
          job = harnessJobFromRow(jobRow);
        }
        return {
          userMessage,
          assistantMessage,
          directive,
          command,
          job,
          sessionRevision: session.revision,
          mode: "attached" as const,
        };
      }
      // A durable Assistant Run deliberately writes the user message before
      // calling the model. If no acknowledgement exists yet, resume the same
      // idempotent turn here instead of treating the crash-safe boundary as
      // data corruption.
      userMessageId = existingUserRow.id;
      correlationId = existingUserRow.correlationId ?? correlationId;
    } else {
      userMessageId = makeOntoCodeId("ocm");
      const userRow: typeof ontocodeSessionMessages.$inferInsert = {
        id: userMessageId,
        tenantId: ctx.tenantId,
        sessionId,
        role: requestRole,
        type: "text",
        contentJson: canonicalEvidenceJson(expectedUserContent),
        idempotencyKey: input.idempotencyKey,
        commandId: null,
        correlationId,
        createdAt: now,
      };
      tx.insert(ontocodeSessionMessages).values(userRow).run();
      userMessage = messageFromRow(
        userRow as typeof ontocodeSessionMessages.$inferSelect,
      );
      appendEvent(
        tx,
        ctx,
        {
          projectId: session.projectId,
          sessionId,
          type: "session.message.appended",
          payload: { message: userMessage, turnBehavior: input.behavior },
          correlationId,
          causationId: userMessageId,
        },
        now,
      );
    }

    let command: OntoCodeCommand | null = null;
    let job: OntoCodeHarnessJob | null = null;
    if (input.behavior === "execute") {
      if (!input.action) {
        throw new OntoCodeStoreError(
          "ontocode_turn_action_required",
          "An execute turn requires an explicit action",
          400,
        );
      }
      const policy = ONTOCODE_COMMAND_POLICY[input.action];
      const commandBudget = resolveSessionCommandBudget(
        tx,
        ctx,
        session.id,
        input.action,
        input.arguments,
      );
      const autonomyPolicy = resolveOntoCodeAutonomyActionPolicy(
        session.autonomyMode,
        input.action,
      );
      if (!autonomyPolicy.allowed) {
        throw new OntoCodeStoreError(
          "ontocode_autonomy_analysis_only",
          "This Session is in analysis-only mode and cannot create a mutating or sandbox Command",
          409,
          {
            sessionId,
            autonomyMode: session.autonomyMode,
            action: input.action,
            riskClass: policy.riskClass,
          },
        );
      }
      const requiresHuman = autonomyPolicy.requiresHuman;
      const candidateTestCases = parseCandidateTestCases(
        input.arguments.testCases,
      );
      const candidateTarget = resolveExactCandidateJobTarget(
        tx,
        ctx,
        sessionId,
        policy.jobKind,
      );
      const commandId = makeOntoCodeId("occ");
      const commandRow: typeof ontocodeCommands.$inferInsert = {
        id: commandId,
        tenantId: ctx.tenantId,
        sessionId,
        type: policy.commandType,
        argumentsJson: canonicalEvidenceJson(input.arguments),
        expectedSessionRevision: session.revision,
        baseOntologyHash: session.ontologySnapshotHash ?? null,
        basePackageVersionId:
          candidateTarget?.packageVersionId ??
          session.basePackageVersionId ??
          null,
        affectedSemanticPathsJson: canonicalEvidenceJson(
          input.affectedSemanticPaths,
        ),
        requestedCapabilitiesJson: canonicalEvidenceJson(
          input.requestedCapabilities,
        ),
        riskClass: policy.riskClass,
        status: requiresHuman ? "awaiting_approval" : "queued",
        requiresHuman,
        rationaleSummary: input.text.slice(0, 4_000),
        idempotencyKey: turnChildIdempotencyKey(
          input.idempotencyKey,
          "command",
        ),
        createdBy: ctx.actorId,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(ontocodeCommands).values(commandRow).run();
      command = commandFromRow(
        commandRow as typeof ontocodeCommands.$inferSelect,
      );
      appendEvent(
        tx,
        ctx,
        {
          projectId: session.projectId,
          sessionId,
          type: "ai.plan.proposed",
          payload: {
            command,
            sourceMessageId: userMessageId,
            policyDerived: true,
          },
          correlationId,
          causationId: userMessageId,
          commandId,
        },
        now,
      );

      const jobId = makeOntoCodeId("ocj");
      const candidateInputHash = candidateTarget
        ? computeOntoCodeCandidateJobInputHash({
            kind: policy.jobKind,
            commandId,
            candidatePackageVersionId: candidateTarget.packageVersionId,
            candidateDependencyRoot: candidateTarget.dependencyRoot,
            candidateHeadId: candidateTarget.headId,
            candidateHeadRevision: candidateTarget.headRevision,
            testCases: candidateTestCases,
          })
        : null;
      const jobRow: typeof ontocodeHarnessJobs.$inferInsert = {
        id: jobId,
        tenantId: ctx.tenantId,
        sessionId,
        commandId,
        runtimeProfileVersionId: session.runtimeProfileVersionId ?? null,
        buildExecutionId: null,
        attemptNo: 0,
        kind: policy.jobKind,
        status: requiresHuman ? "waiting_user" : "queued",
        idempotencyKey: turnChildIdempotencyKey(input.idempotencyKey, "job"),
        inputHash: candidateInputHash,
        budgetJson: canonicalEvidenceJson(commandBudget),
        candidatePackageVersionId: candidateTarget?.packageVersionId ?? null,
        candidateDependencyRoot: candidateTarget?.dependencyRoot ?? null,
        candidateHeadId: candidateTarget?.headId ?? null,
        candidateHeadRevision: candidateTarget?.headRevision ?? null,
        testCasesJson: canonicalEvidenceJson(candidateTestCases),
        errorMessage: null,
        createdBy: ctx.actorId,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      };
      tx.insert(ontocodeHarnessJobs).values(jobRow).run();
      const continuationJob = attachOntoCodeBuildContinuation(tx, ctx, {
        session,
        command: commandRow as typeof ontocodeCommands.$inferSelect,
        childJobId: jobId,
        childJobKind: policy.jobKind,
        answerReferenceId: userMessageId,
        sourceMessageId: userMessageId,
        correlationId,
        causationId: userMessageId,
        now,
      });
      job = harnessJobFromRow(
        continuationJob ?? (jobRow as typeof ontocodeHarnessJobs.$inferSelect),
      );
      appendEvent(
        tx,
        ctx,
        {
          projectId: session.projectId,
          sessionId,
          type: requiresHuman
            ? "harness.job.waiting_user"
            : "harness.job.queued",
          payload: { job, policyDerived: true },
          correlationId,
          causationId: commandId,
          commandId,
          harnessJobId: jobId,
        },
        now,
      );
    }

    const directiveId = makeOntoCodeId("ocd");
    const eventSeq = nextEventSeq(tx, ctx, sessionId);
    let directive: OntoCodeWorkspaceDirective;
    if (input.behavior === "navigate") {
      directive = {
        id: directiveId,
        sessionId,
        sourceMessageId: userMessageId,
        eventSeq,
        behavior: "navigate",
        target: input.directiveTarget?.trim() || input.text,
      };
    } else if (input.behavior === "explain") {
      directive = {
        id: directiveId,
        sessionId,
        sourceMessageId: userMessageId,
        eventSeq,
        behavior: "explain",
        topic: input.text,
      };
    } else if (input.behavior === "clarify") {
      directive = {
        id: directiveId,
        sessionId,
        sourceMessageId: userMessageId,
        eventSeq,
        behavior: "clarify",
        question: input.text,
      };
    } else {
      if (!input.action || !command || !job) {
        throw new OntoCodeStoreError(
          "ontocode_turn_incomplete",
          "The execute turn could not derive its command and job",
          500,
        );
      }
      const policy = ONTOCODE_COMMAND_POLICY[input.action];
      const autonomyPolicy = resolveOntoCodeAutonomyActionPolicy(
        session.autonomyMode,
        input.action,
      );
      directive = {
        id: directiveId,
        sessionId,
        sourceMessageId: userMessageId,
        eventSeq,
        behavior: "execute",
        action: input.action,
        commandId: command.id,
        harnessJobId: job.id,
        commandType: policy.commandType,
        jobKind: policy.jobKind,
        riskClass: policy.riskClass,
        requiresHuman: autonomyPolicy.requiresHuman,
        budget: job.budget ?? resolveOntoCodeCommandBudget(input.action),
      };
    }
    directive = OntoCodeWorkspaceDirectiveSchema.parse(directive);

    const assistantMessageId = makeOntoCodeId("ocm");
    const acknowledgement = turnAssistantAcknowledgement(
      input,
      sessionFromRow(session),
      directive,
    );
    const assistantRow: typeof ontocodeSessionMessages.$inferInsert = {
      id: assistantMessageId,
      tenantId: ctx.tenantId,
      sessionId,
      role: "assistant",
      type: directive.behavior === "execute" ? "receipt" : "text",
      contentJson: canonicalEvidenceJson({
        text: acknowledgement,
        directive,
        ...(input.assistantRecommendations?.length
          ? {
              recommendations: input.assistantRecommendations,
              recommendationSchema: "ontocode-assistant-recommendations/v1",
            }
          : {}),
        ...(input.assistantCitedRefs?.length
          ? {
              citedRefs: input.assistantCitedRefs,
              citationSchema: "ontocode-assistant-citations/v1",
            }
          : {}),
      }),
      idempotencyKey: turnChildIdempotencyKey(
        input.idempotencyKey,
        "assistant",
      ),
      commandId: command?.id ?? null,
      correlationId,
      createdAt: now,
    };
    tx.insert(ontocodeSessionMessages).values(assistantRow).run();
    const assistantMessage = messageFromRow(
      assistantRow as typeof ontocodeSessionMessages.$inferSelect,
    );
    const directiveEvent = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "workspace.directive.emitted",
        // `sourceMessageId` 提到顶层：推理面板按顶层字段把事件归到某一轮对话，
        // 不递归进 `directive`。嵌着的时候这条指令帧永远落进兜底泳道。
        payload: {
          directive,
          assistantMessageId,
          sourceMessageId: directive.sourceMessageId,
        },
        correlationId,
        causationId: directiveId,
        commandId: command?.id ?? null,
        harnessJobId: job?.id ?? null,
      },
      now,
    );
    if (directiveEvent.seq !== directive.eventSeq) {
      throw new OntoCodeStoreError(
        "ontocode_event_sequence_conflict",
        "The workspace directive event sequence changed during commit",
        409,
      );
    }

    const revision = session.revision + 1;
    const update = tx
      .update(ontocodeSessions)
      .set({
        revision,
        updatedAt: now,
        activityState:
          directive.behavior !== "execute"
            ? "idle"
            : directive.requiresHuman
              ? "review_required"
              : "queued",
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, session.revision),
          ),
        ),
      )
      .run();
    if (update.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_stale_revision",
        "The chat turn lost its session revision race",
        409,
      );
    }
    return {
      userMessage,
      assistantMessage,
      directive,
      command,
      job,
      sessionRevision: revision,
      mode: "created" as const,
    };
  });
}

export function listOntoCodeMessages(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: { limit: number; offset: number },
): Page<OntoCodeMessage> {
  requireSessionRow(getDb(), ctx, sessionId);
  const rows = getDb()
    .select()
    .from(ontocodeSessionMessages)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionMessages,
      )(eq(ontocodeSessionMessages.sessionId, sessionId)),
    )
    .orderBy(
      asc(ontocodeSessionMessages.createdAt),
      asc(ontocodeSessionMessages.id),
    )
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(messageFromRow);
  return page(rows, input.limit, input.offset);
}

/**
 * Planner/worker context needs the newest messages, not the first page of a
 * long-running Session. Fetch descending for efficiency, then restore
 * chronological order for model input and UI projections.
 */
export function listLatestOntoCodeMessages(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  limit: number,
): OntoCodeMessage[] {
  requireSessionRow(getDb(), ctx, sessionId);
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  return getDb()
    .select()
    .from(ontocodeSessionMessages)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionMessages,
      )(eq(ontocodeSessionMessages.sessionId, sessionId)),
    )
    .orderBy(
      desc(ontocodeSessionMessages.createdAt),
      desc(ontocodeSessionMessages.id),
    )
    .limit(boundedLimit)
    .all()
    .reverse()
    .map(messageFromRow);
}

function sameCommandRequest(
  command: OntoCodeCommand,
  input: CreateOntoCodeCommandRequest,
): boolean {
  return (
    command.type === input.type &&
    command.expectedSessionRevision === input.expectedSessionRevision &&
    command.baseOntologyHash === (input.baseOntologyHash ?? null) &&
    command.basePackageVersionId === (input.basePackageVersionId ?? null) &&
    command.riskClass === input.riskClass &&
    command.requiresHuman === input.requiresHuman &&
    command.rationaleSummary === input.rationaleSummary &&
    canonicalEvidenceJson(command.arguments) ===
      canonicalEvidenceJson(input.arguments) &&
    canonicalEvidenceJson(command.affectedSemanticPaths) ===
      canonicalEvidenceJson(input.affectedSemanticPaths) &&
    canonicalEvidenceJson(command.requestedCapabilities) ===
      canonicalEvidenceJson(input.requestedCapabilities)
  );
}

export function createOntoCodeCommand(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateOntoCodeCommandRequest & { idempotencyKey: string },
): {
  command: OntoCodeCommand;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const existing = tx
      .select()
      .from(ontocodeCommands)
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(
          and(
            eq(ontocodeCommands.sessionId, sessionId),
            eq(ontocodeCommands.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existing) {
      const command = commandFromRow(existing);
      if (!sameCommandRequest(command, input)) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different command",
          409,
        );
      }
      return {
        command,
        event: requireCausationEvent(tx, ctx, sessionId, command.id),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    requireExpectedRevision(session, input.expectedSessionRevision);
    const autonomyPolicy = resolveOntoCodeAutonomyActionPolicy(
      session.autonomyMode,
      input.type,
    );
    if (!autonomyPolicy.allowed) {
      throw new OntoCodeStoreError(
        "ontocode_autonomy_analysis_only",
        "This Session is in analysis-only mode and cannot create a mutating or sandbox Command",
        409,
        {
          sessionId,
          autonomyMode: session.autonomyMode,
          action: input.type,
          riskClass: input.riskClass,
        },
      );
    }
    if (input.requiresHuman !== autonomyPolicy.requiresHuman) {
      throw new OntoCodeStoreError(
        "ontocode_autonomy_policy_mismatch",
        "Command approval does not match the Session autonomy mode",
        409,
        {
          sessionId,
          autonomyMode: session.autonomyMode,
          action: input.type,
          expectedRequiresHuman: autonomyPolicy.requiresHuman,
          receivedRequiresHuman: input.requiresHuman,
        },
      );
    }
    const now = new Date();
    const id = makeOntoCodeId("occ");
    const correlationId = makeOntoCodeId("cor");
    const row: typeof ontocodeCommands.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      sessionId,
      type: input.type,
      argumentsJson: canonicalEvidenceJson(input.arguments),
      expectedSessionRevision: input.expectedSessionRevision,
      baseOntologyHash: input.baseOntologyHash ?? null,
      basePackageVersionId: input.basePackageVersionId ?? null,
      affectedSemanticPathsJson: canonicalEvidenceJson(
        input.affectedSemanticPaths,
      ),
      requestedCapabilitiesJson: canonicalEvidenceJson(
        input.requestedCapabilities,
      ),
      riskClass: input.riskClass,
      status: input.requiresHuman ? "awaiting_approval" : "approved",
      requiresHuman: input.requiresHuman,
      rationaleSummary: input.rationaleSummary,
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(ontocodeCommands).values(row).run();
    const revision = session.revision + 1;
    tx.update(ontocodeSessions)
      .set({
        revision,
        updatedAt: now,
        activityState: input.requiresHuman ? "review_required" : "idle",
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, session.revision),
          ),
        ),
      )
      .run();
    const command = commandFromRow(row as typeof ontocodeCommands.$inferSelect);
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "ai.plan.proposed",
        payload: {
          command,
          requiresHuman: command.requiresHuman,
          status: command.status,
        },
        correlationId,
        causationId: id,
        commandId: id,
      },
      now,
    );
    return { command, event, sessionRevision: revision, mode: "created" };
  });
}

export function listOntoCodeCommands(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    status?: OntoCodeCommand["status"];
  },
): Page<OntoCodeCommand> {
  requireSessionRow(getDb(), ctx, sessionId);
  const extra = input.status
    ? and(
        eq(ontocodeCommands.sessionId, sessionId),
        eq(ontocodeCommands.status, input.status),
      )
    : eq(ontocodeCommands.sessionId, sessionId);
  const rows = getDb()
    .select()
    .from(ontocodeCommands)
    .where(tenantScope(ctx, ontocodeCommands)(extra))
    .orderBy(desc(ontocodeCommands.createdAt), desc(ontocodeCommands.id))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(commandFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeCommand(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  commandId: string,
): OntoCodeCommand {
  const row = getDb()
    .select()
    .from(ontocodeCommands)
    .where(
      tenantScope(ctx, ontocodeCommands)(eq(ontocodeCommands.id, commandId)),
    )
    .get();
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_command_not_found",
      "OntoCode command not found",
      404,
    );
  }
  return commandFromRow(row);
}

export function decideOntoCodeCommand(
  ctx: OntoCodeStoreContext,
  commandId: string,
  decision: "approve" | "reject",
  input: DecideOntoCodeCommandRequest,
): {
  command: OntoCodeCommand;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  decision: "approve" | "reject";
  mode: "resolved" | "attached";
} {
  return getDb().transaction((tx) => {
    const commandRow = tx
      .select()
      .from(ontocodeCommands)
      .where(
        tenantScope(ctx, ontocodeCommands)(eq(ontocodeCommands.id, commandId)),
      )
      .get();
    if (!commandRow) {
      throw new OntoCodeStoreError(
        "ontocode_command_not_found",
        "OntoCode command not found",
        404,
      );
    }
    const session = requireWritableSessionRow(tx, ctx, commandRow.sessionId);
    const targetStatus = decision === "approve" ? "approved" : "rejected";
    if (commandRow.status === targetStatus) {
      const eventRow = eventForCausationAndType(
        tx,
        ctx,
        commandRow.sessionId,
        commandId,
        "decision.resolved",
      );
      if (!eventRow) {
        throw new OntoCodeStoreError(
          "ontocode_data_corrupt",
          "The resolved command is missing its durable decision event",
          500,
        );
      }
      return {
        command: commandFromRow(commandRow),
        event: eventFromRow(eventRow),
        sessionRevision: session.revision,
        decision,
        mode: "attached" as const,
      };
    }
    if (
      commandRow.status !== "awaiting_approval" &&
      commandRow.status !== "proposed"
    ) {
      throw new OntoCodeStoreError(
        "ontocode_command_not_decidable",
        `Command in status ${commandRow.status} cannot accept this decision`,
        409,
        { commandId, status: commandRow.status },
      );
    }
    requireExpectedRevision(session, input.expectedSessionRevision);

    const now = new Date();
    const linkedJobRow = tx
      .select()
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.sessionId, session.id),
            eq(ontocodeHarnessJobs.commandId, commandId),
          ),
        ),
      )
      .get();
    tx.update(ontocodeCommands)
      .set({ status: targetStatus, updatedAt: now })
      .where(
        tenantScope(
          ctx,
          ontocodeCommands,
        )(
          and(
            eq(ontocodeCommands.id, commandId),
            eq(ontocodeCommands.status, commandRow.status),
          ),
        ),
      )
      .run();
    if (linkedJobRow?.status === "waiting_user") {
      tx.update(ontocodeHarnessJobs)
        .set(
          decision === "approve"
            ? {
                status: "queued",
                errorMessage: null,
                startedAt: null,
                finishedAt: null,
                updatedAt: now,
              }
            : {
                status: "cancelled",
                errorMessage: "The linked command was rejected by the FDE.",
                finishedAt: now,
                updatedAt: now,
              },
        )
        .where(
          tenantScope(
            ctx,
            ontocodeHarnessJobs,
          )(
            and(
              eq(ontocodeHarnessJobs.id, linkedJobRow.id),
              eq(ontocodeHarnessJobs.status, "waiting_user"),
            ),
          ),
        )
        .run();
    }
    const revision = session.revision + 1;
    tx.update(ontocodeSessions)
      .set({
        revision,
        updatedAt: now,
        activityState:
          decision === "approve" && linkedJobRow?.status === "waiting_user"
            ? "queued"
            : decision === "approve"
              ? "idle"
              : "needs_user",
      })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, session.id),
            eq(ontocodeSessions.revision, session.revision),
          ),
        ),
      )
      .run();
    const updatedCommand = tx
      .select()
      .from(ontocodeCommands)
      .where(
        tenantScope(ctx, ontocodeCommands)(eq(ontocodeCommands.id, commandId)),
      )
      .get();
    if (!updatedCommand) {
      throw new OntoCodeStoreError(
        "ontocode_data_corrupt",
        "Command disappeared while its decision was committed",
        500,
      );
    }
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId: session.id,
        type: "decision.resolved",
        payload: {
          commandId,
          decision,
          status: targetStatus,
          actorId: ctx.actorId,
          note: input.note ?? null,
          revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: commandId,
        commandId,
      },
      now,
    );
    if (linkedJobRow?.status === "waiting_user") {
      const updatedJobRow = tx
        .select()
        .from(ontocodeHarnessJobs)
        .where(
          tenantScope(
            ctx,
            ontocodeHarnessJobs,
          )(eq(ontocodeHarnessJobs.id, linkedJobRow.id)),
        )
        .get();
      if (!updatedJobRow) {
        throw new OntoCodeStoreError(
          "ontocode_data_corrupt",
          "The command decision lost its linked Harness job",
          500,
        );
      }
      appendEvent(
        tx,
        ctx,
        {
          projectId: session.projectId,
          sessionId: session.id,
          type:
            decision === "approve"
              ? "harness.job.queued"
              : "harness.job.cancelled",
          payload: {
            job: harnessJobFromRow(updatedJobRow),
            source: "command_decision",
            decision,
          },
          correlationId: event.correlationId,
          causationId: event.id,
          commandId,
          harnessJobId: linkedJobRow.id,
        },
        now,
      );
    }
    return {
      command: commandFromRow(updatedCommand),
      event,
      sessionRevision: revision,
      decision,
      mode: "resolved" as const,
    };
  });
}

function sameHarnessJobRequest(
  job: OntoCodeHarnessJob,
  input: CreateOntoCodeHarnessJobRequest,
): boolean {
  const testCases = input.testCases ?? [];
  return (
    job.commandId === (input.commandId ?? null) &&
    job.kind === input.kind &&
    (!input.inputHash || job.inputHash === input.inputHash) &&
    (!input.candidatePackageVersionId ||
      job.candidatePackageVersionId === input.candidatePackageVersionId) &&
    (!input.candidateDependencyRoot ||
      job.candidateDependencyRoot === input.candidateDependencyRoot) &&
    (!input.candidateHeadRevision ||
      job.candidateHeadRevision === input.candidateHeadRevision) &&
    canonicalEvidenceJson(job.testCases) === canonicalEvidenceJson(testCases) &&
    canonicalEvidenceJson(job.budget) ===
      canonicalEvidenceJson(input.budget ?? null)
  );
}

const EXACT_CANDIDATE_JOB_KINDS = new Set<OntoCodeHarnessJob["kind"]>([
  "test",
  "regression",
]);

interface ResolvedCandidateJobTarget {
  packageVersionId: string;
  dependencyRoot: string;
  headId: string;
  headRevision: number;
}

function parseCandidateTestCases(value: unknown): OntoCodeCandidateTestCase[] {
  if (value === undefined) return [];
  return OntoCodeCandidateTestCaseSchema.array().max(500).parse(value);
}

function resolveExactCandidateJobTarget(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  kind: OntoCodeHarnessJob["kind"],
  requested?: {
    packageVersionId?: string;
    dependencyRoot?: string;
    headRevision?: number;
  },
): ResolvedCandidateJobTarget | null {
  if (!EXACT_CANDIDATE_JOB_KINDS.has(kind)) return null;
  const head = db
    .select()
    .from(ontocodeCandidateHeads)
    .where(
      tenantScope(
        ctx,
        ontocodeCandidateHeads,
      )(eq(ontocodeCandidateHeads.sessionId, sessionId)),
    )
    .get();
  if (!head) {
    throw new OntoCodeStoreError(
      "ontocode_candidate_head_missing",
      "An exact Candidate must be built before this Harness operation can be queued",
      409,
      { sessionId, kind },
    );
  }
  const packageVersion = db
    .select()
    .from(ontocodePackageVersions)
    .where(
      tenantScope(
        ctx,
        ontocodePackageVersions,
      )(
        and(
          eq(ontocodePackageVersions.id, head.packageVersionId),
          eq(ontocodePackageVersions.sessionId, sessionId),
          eq(ontocodePackageVersions.projectId, head.projectId),
        ),
      ),
    )
    .get();
  if (!packageVersion) {
    throw new OntoCodeStoreError(
      "ontocode_candidate_package_missing",
      "The Candidate Head references a missing Package Version",
      500,
      { candidateHeadId: head.id, packageVersionId: head.packageVersionId },
    );
  }
  const mismatches = {
    ...(requested?.packageVersionId &&
    requested.packageVersionId !== packageVersion.id
      ? {
          packageVersionId: {
            expected: packageVersion.id,
            received: requested.packageVersionId,
          },
        }
      : {}),
    ...(requested?.dependencyRoot &&
    requested.dependencyRoot !== packageVersion.dependencyRoot
      ? {
          dependencyRoot: {
            expected: packageVersion.dependencyRoot,
            received: requested.dependencyRoot,
          },
        }
      : {}),
    ...(requested?.headRevision && requested.headRevision !== head.revision
      ? {
          headRevision: {
            expected: head.revision,
            received: requested.headRevision,
          },
        }
      : {}),
  };
  if (Object.keys(mismatches).length > 0) {
    throw new OntoCodeStoreError(
      "ontocode_candidate_head_drift",
      "The requested Candidate no longer matches the current Candidate Head",
      409,
      {
        candidateHeadId: head.id,
        currentPackageVersionId: packageVersion.id,
        currentDependencyRoot: packageVersion.dependencyRoot,
        currentHeadRevision: head.revision,
        mismatches,
      },
    );
  }
  return {
    packageVersionId: packageVersion.id,
    dependencyRoot: packageVersion.dependencyRoot,
    headId: head.id,
    headRevision: head.revision,
  };
}

export function createOntoCodeHarnessJob(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateOntoCodeHarnessJobRequest & { idempotencyKey: string },
): {
  job: OntoCodeHarnessJob;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    let command: typeof ontocodeCommands.$inferSelect | undefined;
    if (input.commandId) {
      command = tx
        .select()
        .from(ontocodeCommands)
        .where(
          tenantScope(
            ctx,
            ontocodeCommands,
          )(
            and(
              eq(ontocodeCommands.id, input.commandId),
              eq(ontocodeCommands.sessionId, sessionId),
            ),
          ),
        )
        .get();
      if (!command) {
        throw new OntoCodeStoreError(
          "ontocode_command_not_found",
          "The harness job command does not belong to this session",
          404,
        );
      }
    }
    // Command policy is the server-owned ceiling. An omitted request gets the
    // policy default; a caller may tighten individual limits but cannot widen
    // them and accidentally turn a bounded Harness job into an unbounded run.
    const parsedCommand = command ? commandFromRow(command) : null;
    const policyBudget = parsedCommand
      ? resolveSessionCommandBudget(
          tx,
          ctx,
          sessionId,
          parsedCommand.type,
          parsedCommand.arguments,
        )
      : null;
    const effectiveBudget: OntoCodeHarnessJob["budget"] = policyBudget
      ? {
          ...(input.budget?.maxTokens === undefined
            ? {}
            : { maxTokens: input.budget.maxTokens }),
          ...(input.budget?.maxCostUsd === undefined
            ? {}
            : { maxCostUsd: input.budget.maxCostUsd }),
          maxWallClockMs: Math.min(
            input.budget?.maxWallClockMs ?? policyBudget.maxWallClockMs,
            policyBudget.maxWallClockMs,
          ),
          maxModelCalls: Math.min(
            input.budget?.maxModelCalls ?? policyBudget.maxModelCalls,
            policyBudget.maxModelCalls,
          ),
          maxToolCalls: Math.min(
            input.budget?.maxToolCalls ?? policyBudget.maxToolCalls,
            policyBudget.maxToolCalls,
          ),
        }
      : (input.budget ?? null);
    const existing = tx
      .select()
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(
          and(
            eq(ontocodeHarnessJobs.sessionId, sessionId),
            eq(ontocodeHarnessJobs.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existing) {
      const job = harnessJobFromRow(existing);
      if (
        !sameHarnessJobRequest(job, {
          ...input,
          ...(effectiveBudget === null ? {} : { budget: effectiveBudget }),
        })
      ) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different harness job",
          409,
        );
      }
      return {
        job,
        event: requireCausationEvent(tx, ctx, sessionId, job.id),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    if (command && command.status !== "approved") {
      throw new OntoCodeStoreError(
        "ontocode_command_not_approved",
        "The command must be approved before a harness job can start",
        409,
        { commandId: command.id, status: command.status },
      );
    }
    requireExpectedRevision(session, input.expectedSessionRevision);

    const testCases = parseCandidateTestCases(input.testCases);
    const candidateTarget = resolveExactCandidateJobTarget(
      tx,
      ctx,
      sessionId,
      input.kind,
      {
        packageVersionId: input.candidatePackageVersionId,
        dependencyRoot: input.candidateDependencyRoot,
        headRevision: input.candidateHeadRevision,
      },
    );
    if (
      candidateTarget &&
      command?.basePackageVersionId &&
      command.basePackageVersionId !== candidateTarget.packageVersionId
    ) {
      throw new OntoCodeStoreError(
        "ontocode_command_candidate_mismatch",
        "The linked Command is bound to a different Candidate Package",
        409,
        {
          commandId: command.id,
          commandPackageVersionId: command.basePackageVersionId,
          candidatePackageVersionId: candidateTarget.packageVersionId,
        },
      );
    }
    const canonicalInputHash = candidateTarget
      ? computeOntoCodeCandidateJobInputHash({
          kind: input.kind,
          commandId: input.commandId ?? null,
          candidatePackageVersionId: candidateTarget.packageVersionId,
          candidateDependencyRoot: candidateTarget.dependencyRoot,
          candidateHeadId: candidateTarget.headId,
          candidateHeadRevision: candidateTarget.headRevision,
          testCases,
        })
      : (input.inputHash ?? null);
    if (
      candidateTarget &&
      input.inputHash &&
      input.inputHash !== canonicalInputHash
    ) {
      throw new OntoCodeStoreError(
        "ontocode_candidate_input_hash_mismatch",
        "Candidate-bound Harness inputHash is computed by the server",
        409,
        { expectedInputHash: canonicalInputHash },
      );
    }

    const now = new Date();
    const id = makeOntoCodeId("ocj");
    const correlationId = makeOntoCodeId("cor");
    const row: typeof ontocodeHarnessJobs.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      sessionId,
      commandId: input.commandId ?? null,
      runtimeProfileVersionId: session.runtimeProfileVersionId ?? null,
      buildExecutionId: null,
      attemptNo: 0,
      kind: input.kind,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      inputHash: canonicalInputHash,
      budgetJson:
        effectiveBudget === null
          ? null
          : canonicalEvidenceJson(effectiveBudget),
      candidatePackageVersionId: candidateTarget?.packageVersionId ?? null,
      candidateDependencyRoot: candidateTarget?.dependencyRoot ?? null,
      candidateHeadId: candidateTarget?.headId ?? null,
      candidateHeadRevision: candidateTarget?.headRevision ?? null,
      testCasesJson: canonicalEvidenceJson(testCases),
      errorMessage: null,
      createdBy: ctx.actorId,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    tx.insert(ontocodeHarnessJobs).values(row).run();
    if (command) {
      tx.update(ontocodeCommands)
        .set({ status: "queued", updatedAt: now })
        .where(
          tenantScope(
            ctx,
            ontocodeCommands,
          )(eq(ontocodeCommands.id, command.id)),
        )
        .run();
    }
    const revision = session.revision + 1;
    tx.update(ontocodeSessions)
      .set({ revision, updatedAt: now, activityState: "queued" })
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(
          and(
            eq(ontocodeSessions.id, sessionId),
            eq(ontocodeSessions.revision, session.revision),
          ),
        ),
      )
      .run();
    const continuationJob = attachOntoCodeBuildContinuation(tx, ctx, {
      session,
      command: command ?? null,
      childJobId: id,
      childJobKind: input.kind,
      answerReferenceId: command?.id ?? id,
      correlationId,
      causationId: command?.id ?? id,
      now,
    });
    const job = harnessJobFromRow(
      continuationJob ?? (row as typeof ontocodeHarnessJobs.$inferSelect),
    );
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "harness.job.queued",
        payload: { job },
        correlationId,
        causationId: id,
        commandId: input.commandId ?? null,
        harnessJobId: id,
      },
      now,
    );
    return { job, event, sessionRevision: revision, mode: "created" };
  });
}

export function listOntoCodeHarnessJobs(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    kind?: OntoCodeHarnessJob["kind"];
    status?: OntoCodeHarnessJob["status"];
  },
): Page<OntoCodeHarnessJob> {
  requireSessionRow(getDb(), ctx, sessionId);
  const filters: SQL[] = [eq(ontocodeHarnessJobs.sessionId, sessionId)];
  if (input.kind) filters.push(eq(ontocodeHarnessJobs.kind, input.kind));
  if (input.status) {
    filters.push(eq(ontocodeHarnessJobs.status, input.status));
  }
  const rows = getDb()
    .select()
    .from(ontocodeHarnessJobs)
    .where(tenantScope(ctx, ontocodeHarnessJobs)(and(...filters)))
    .orderBy(desc(ontocodeHarnessJobs.createdAt), desc(ontocodeHarnessJobs.id))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(harnessJobFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeHarnessJob(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  jobId: string,
): OntoCodeHarnessJob {
  const row = getDb()
    .select()
    .from(ontocodeHarnessJobs)
    .where(
      tenantScope(ctx, ontocodeHarnessJobs)(eq(ontocodeHarnessJobs.id, jobId)),
    )
    .get();
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_harness_job_not_found",
      "OntoCode harness job not found",
      404,
    );
  }
  return harnessJobFromRow(row);
}

export function listOntoCodeEvents(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    after: number;
    limit: number;
    visibility: "user" | "debug" | "audit";
  },
): {
  items: OntoCodeSessionEvent[];
  lastSeq: number;
  hasMore: boolean;
} {
  requireSessionRow(getDb(), ctx, sessionId);
  // Visibility is a FLOOR, not an exact match. It used to be `eq(...)`, which
  // meant asking for `debug` returned ONLY debug rows — never the user-visible
  // ones interleaved with them — so a caller could not get a complete ordered
  // trace at any level, and the workspace's「显示全部」toggle filtered a list
  // that by construction contained nothing but `user` rows: a dead control.
  const VISIBILITY_AT_OR_BELOW: Record<
    string,
    Array<"user" | "debug" | "audit">
  > = {
    user: ["user"],
    debug: ["user", "debug"],
    audit: ["user", "debug", "audit"],
  };
  const rows = getDb()
    .select()
    .from(ontocodeSessionEvents)
    .where(
      tenantScope(
        ctx,
        ontocodeSessionEvents,
      )(
        and(
          eq(ontocodeSessionEvents.sessionId, sessionId),
          inArray(
            ontocodeSessionEvents.visibility,
            VISIBILITY_AT_OR_BELOW[input.visibility] ?? ["user"],
          ),
          gt(ontocodeSessionEvents.seq, input.after),
        ),
      ),
    )
    .orderBy(asc(ontocodeSessionEvents.seq))
    .limit(input.limit + 1)
    .all();
  const hasMore = rows.length > input.limit;
  const visible = hasMore ? rows.slice(0, input.limit) : rows;
  const items = visible.map(eventFromRow);
  return {
    items,
    lastSeq: items.at(-1)?.seq ?? input.after,
    hasMore,
  };
}

function bumpOntoCodeSessionRevision(
  tx: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  session: typeof ontocodeSessions.$inferSelect,
  now: Date,
): number {
  const revision = session.revision + 1;
  const result = tx
    .update(ontocodeSessions)
    .set({ revision, updatedAt: now })
    .where(
      tenantScope(
        ctx,
        ontocodeSessions,
      )(
        and(
          eq(ontocodeSessions.id, session.id),
          eq(ontocodeSessions.revision, session.revision),
        ),
      ),
    )
    .run();
  if (result.changes !== 1) {
    throw new OntoCodeStoreError(
      "ontocode_stale_revision",
      "The build session changed while this operation was committed",
      409,
      { sessionId: session.id, expectedRevision: session.revision },
    );
  }
  return revision;
}

function getChangeSetRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  changeSetId: string,
) {
  return db
    .select()
    .from(ontocodeChangeSets)
    .where(
      tenantScope(
        ctx,
        ontocodeChangeSets,
      )(eq(ontocodeChangeSets.id, changeSetId)),
    )
    .get();
}

function requireChangeSetRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  changeSetId: string,
) {
  const row = getChangeSetRow(db, ctx, changeSetId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_changeset_not_found",
      "OntoCode change set not found",
      404,
    );
  }
  return row;
}

function listChangeSetOperationRows(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  changeSetId: string,
) {
  return db
    .select()
    .from(ontocodeChangeSetOperations)
    .where(
      tenantScope(
        ctx,
        ontocodeChangeSetOperations,
      )(eq(ontocodeChangeSetOperations.changeSetId, changeSetId)),
    )
    .orderBy(asc(ontocodeChangeSetOperations.ordinal))
    .all();
}

function sameChangeSetRequest(
  changeSet: OntoCodeChangeSet,
  operations: OntoCodeChangeSetOperation[],
  input: CreateOntoCodeChangeSetRequest,
): boolean {
  const normalizedOperations = operations.map((operation) => ({
    operation: operation.operation,
    semanticPath: operation.semanticPath,
    fromSemanticPath: operation.fromSemanticPath,
    beforeValue: operation.beforeValue,
    afterValue: operation.afterValue,
    sourceRefs: operation.sourceRefs,
    invalidates: operation.invalidates,
  }));
  return (
    changeSet.commandId === (input.commandId ?? null) &&
    changeSet.summary === input.summary &&
    changeSet.baseOntologyHash === (input.baseOntologyHash ?? null) &&
    changeSet.basePackageVersionId === (input.basePackageVersionId ?? null) &&
    changeSet.expectedSessionRevision === input.expectedSessionRevision &&
    canonicalEvidenceJson(normalizedOperations) ===
      canonicalEvidenceJson(input.operations)
  );
}

export function createOntoCodeChangeSet(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateOntoCodeChangeSetRequest & { idempotencyKey: string },
): {
  changeSet: OntoCodeChangeSet;
  operations: OntoCodeChangeSetOperation[];
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const existing = tx
      .select()
      .from(ontocodeChangeSets)
      .where(
        tenantScope(
          ctx,
          ontocodeChangeSets,
        )(
          and(
            eq(ontocodeChangeSets.sessionId, sessionId),
            eq(ontocodeChangeSets.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existing) {
      const changeSet = changeSetFromRow(existing);
      const operations = listChangeSetOperationRows(tx, ctx, existing.id).map(
        changeSetOperationFromRow,
      );
      if (!sameChangeSetRequest(changeSet, operations, input)) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different change set",
          409,
        );
      }
      return {
        changeSet,
        operations,
        event: requireCausationEvent(tx, ctx, sessionId, changeSet.id),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    requireExpectedRevision(session, input.expectedSessionRevision);
    if (input.commandId) {
      const command = tx
        .select({ id: ontocodeCommands.id })
        .from(ontocodeCommands)
        .where(
          tenantScope(
            ctx,
            ontocodeCommands,
          )(
            and(
              eq(ontocodeCommands.id, input.commandId),
              eq(ontocodeCommands.sessionId, sessionId),
            ),
          ),
        )
        .get();
      if (!command) {
        throw new OntoCodeStoreError(
          "ontocode_command_not_found",
          "The change set command does not belong to this session",
          404,
        );
      }
    }

    const now = new Date();
    const id = makeOntoCodeId("ocx");
    const row: typeof ontocodeChangeSets.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      commandId: input.commandId ?? null,
      status: "proposed",
      summary: input.summary,
      baseOntologyHash: input.baseOntologyHash ?? null,
      basePackageVersionId: input.basePackageVersionId ?? null,
      expectedSessionRevision: input.expectedSessionRevision,
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
      committedAt: null,
    };
    tx.insert(ontocodeChangeSets).values(row).run();
    const operationRows = input.operations.map(
      (
        operation,
        ordinal,
      ): typeof ontocodeChangeSetOperations.$inferInsert => ({
        id: makeOntoCodeId("ocxo"),
        tenantId: ctx.tenantId,
        changeSetId: id,
        ordinal,
        operation: operation.operation,
        semanticPath: operation.semanticPath,
        fromSemanticPath: operation.fromSemanticPath,
        beforeJson: canonicalEvidenceJson(operation.beforeValue),
        afterJson: canonicalEvidenceJson(operation.afterValue),
        sourceRefsJson: canonicalEvidenceJson(operation.sourceRefs),
        invalidatesJson: canonicalEvidenceJson(operation.invalidates),
        createdAt: now,
      }),
    );
    tx.insert(ontocodeChangeSetOperations).values(operationRows).run();
    const revision = bumpOntoCodeSessionRevision(tx, ctx, session, now);
    const changeSet = changeSetFromRow(
      row as typeof ontocodeChangeSets.$inferSelect,
    );
    const operations = operationRows.map((operation) =>
      changeSetOperationFromRow(
        operation as typeof ontocodeChangeSetOperations.$inferSelect,
      ),
    );
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "changeset.created",
        payload: {
          changeSetId: id,
          status: changeSet.status,
          summary: changeSet.summary,
          operationCount: operations.length,
          revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: id,
        commandId: input.commandId ?? null,
      },
      now,
    );
    return {
      changeSet,
      operations,
      event,
      sessionRevision: revision,
      mode: "created" as const,
    };
  });
}

export function listOntoCodeChangeSets(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    status?: OntoCodeChangeSet["status"];
  },
): Page<OntoCodeChangeSet> {
  requireSessionRow(getDb(), ctx, sessionId);
  const filters: SQL[] = [eq(ontocodeChangeSets.sessionId, sessionId)];
  if (input.status) {
    filters.push(eq(ontocodeChangeSets.status, input.status));
  }
  const rows = getDb()
    .select()
    .from(ontocodeChangeSets)
    .where(tenantScope(ctx, ontocodeChangeSets)(and(...filters)))
    .orderBy(desc(ontocodeChangeSets.createdAt), desc(ontocodeChangeSets.id))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(changeSetFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeChangeSet(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  changeSetId: string,
): {
  changeSet: OntoCodeChangeSet;
  operations: OntoCodeChangeSetOperation[];
} {
  const db = getDb();
  const row = requireChangeSetRow(db, ctx, changeSetId);
  return {
    changeSet: changeSetFromRow(row),
    operations: listChangeSetOperationRows(db, ctx, changeSetId).map(
      changeSetOperationFromRow,
    ),
  };
}

export function commitOntoCodeChangeSet(
  ctx: OntoCodeStoreContext,
  changeSetId: string,
  input: CommitOntoCodeChangeSetRequest,
): {
  changeSet: OntoCodeChangeSet;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "committed" | "attached";
} {
  return getDb().transaction((tx) => {
    const current = requireChangeSetRow(tx, ctx, changeSetId);
    const session = requireWritableSessionRow(tx, ctx, current.sessionId);
    if (current.status === "committed") {
      const eventRow = eventForCausationAndType(
        tx,
        ctx,
        current.sessionId,
        changeSetId,
        "changeset.committed",
      );
      if (!eventRow) {
        throw new OntoCodeStoreError(
          "ontocode_data_corrupt",
          "The committed change set is missing its durable session event",
          500,
        );
      }
      return {
        changeSet: changeSetFromRow(current),
        event: eventFromRow(eventRow),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }
    if (current.status !== "proposed" && current.status !== "validated") {
      throw new OntoCodeStoreError(
        "ontocode_changeset_not_committable",
        `Change set in status ${current.status} cannot be committed`,
        409,
        { changeSetId, status: current.status },
      );
    }
    requireExpectedRevision(session, input.expectedSessionRevision);

    const now = new Date();
    const result = tx
      .update(ontocodeChangeSets)
      .set({ status: "committed", committedAt: now, updatedAt: now })
      .where(
        tenantScope(
          ctx,
          ontocodeChangeSets,
        )(
          and(
            eq(ontocodeChangeSets.id, changeSetId),
            eq(ontocodeChangeSets.status, current.status),
          ),
        ),
      )
      .run();
    if (result.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_changeset_conflict",
        "The change set changed while it was being committed",
        409,
      );
    }
    const revision = bumpOntoCodeSessionRevision(tx, ctx, session, now);
    const updated = requireChangeSetRow(tx, ctx, changeSetId);
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId: session.id,
        type: "changeset.committed",
        payload: {
          changeSetId,
          status: "committed",
          actorId: ctx.actorId,
          revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: changeSetId,
        commandId: current.commandId ?? null,
      },
      now,
    );
    return {
      changeSet: changeSetFromRow(updated),
      event,
      sessionRevision: revision,
      mode: "committed" as const,
    };
  });
}

function getArtifactRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  artifactId: string,
) {
  return db
    .select()
    .from(ontocodeArtifacts)
    .where(
      tenantScope(ctx, ontocodeArtifacts)(eq(ontocodeArtifacts.id, artifactId)),
    )
    .get();
}

function requireArtifactRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  artifactId: string,
) {
  const row = getArtifactRow(db, ctx, artifactId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_artifact_not_found",
      "OntoCode artifact not found",
      404,
    );
  }
  return row;
}

function getArtifactVersionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  versionId: string,
) {
  return db
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactVersions,
      )(eq(ontocodeArtifactVersions.id, versionId)),
    )
    .get();
}

function requireArtifactVersionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  versionId: string,
) {
  const row = getArtifactVersionRow(db, ctx, versionId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_artifact_version_not_found",
      "OntoCode artifact version not found",
      404,
    );
  }
  return row;
}

function latestArtifactVersionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  artifactId: string,
) {
  return db
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactVersions,
      )(eq(ontocodeArtifactVersions.artifactId, artifactId)),
    )
    .orderBy(
      desc(ontocodeArtifactVersions.version),
      desc(ontocodeArtifactVersions.id),
    )
    .limit(1)
    .get();
}

function requireLatestArtifactVersionRow(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  artifactId: string,
) {
  const row = latestArtifactVersionRow(db, ctx, artifactId);
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "The artifact is missing its initial immutable version",
      500,
      { artifactId },
    );
  }
  return row;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function actionCountFromHarnessReceipt(content: string): number | null {
  let root: Record<string, unknown> | null = null;
  try {
    root = recordValue(JSON.parse(content) as unknown);
  } catch {
    return null;
  }
  if (!root) return null;
  const candidates = [
    root.actionIds,
    recordValue(root.scope)?.actionIds,
    recordValue(root.recommendation)?.actionIds,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const count = new Set(
      candidate
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ).size;
    if (count > 0) return count;
  }
  return null;
}

/**
 * Follow-up Build commands intentionally carry only the FDE's answer and the
 * waiting Job id. Their immutable Action scope lives in prior server-produced
 * receipts, so budget sizing must recover it there instead of trusting a
 * client-supplied count or falling back to the one-Action allowance.
 */
function authoritativeSessionBuildActionCount(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): number | null {
  const receipts = db
    .select()
    .from(ontocodeArtifacts)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifacts,
      )(
        and(
          eq(ontocodeArtifacts.sessionId, sessionId),
          eq(ontocodeArtifacts.kind, "harness_receipt"),
        ),
      ),
    )
    .orderBy(desc(ontocodeArtifacts.createdAt), desc(ontocodeArtifacts.id))
    .limit(50)
    .all();
  for (const artifact of receipts) {
    if (!artifact.logicalName.startsWith("harness/")) continue;
    const version = latestArtifactVersionRow(db, ctx, artifact.id);
    if (!version) continue;
    const blob = db
      .select()
      .from(ontocodeArtifactBlobs)
      .where(
        tenantScope(
          ctx,
          ontocodeArtifactBlobs,
        )(eq(ontocodeArtifactBlobs.id, version.blobId)),
      )
      .get();
    if (!blob || blob.sha256 !== version.blobHash) continue;
    const count = actionCountFromHarnessReceipt(blob.contentText);
    if (count !== null) return count;
  }
  return null;
}

function resolveSessionCommandBudget(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  action: OntoCodeCommand["type"],
  args: Record<string, unknown>,
) {
  // #BUDGET-FOLLOWS-WORK — every Build-kind Command drives the same per-Action
  // generation harness, including the follow-up turns ("save the draft",
  // "continue") an FDE issues against an unfinished Build. Recovering the
  // Session's immutable Action scope for all of them keeps a continuation from
  // being budgeted as if it were a one-off edit.
  return resolveOntoCodeCommandBudget(action, args, {
    authoritativeActionCount:
      ONTOCODE_COMMAND_POLICY[action].jobKind === "build"
        ? authoritativeSessionBuildActionCount(db, ctx, sessionId)
        : null,
  });
}

function artifactContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureArtifactBlob(
  tx: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  content: string,
  now: Date,
) {
  const sha256 = artifactContentHash(content);
  const existing = tx
    .select()
    .from(ontocodeArtifactBlobs)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactBlobs,
      )(eq(ontocodeArtifactBlobs.sha256, sha256)),
    )
    .get();
  if (existing) {
    if (
      existing.contentText !== content ||
      existing.sizeBytes !== Buffer.byteLength(content, "utf8")
    ) {
      throw new OntoCodeStoreError(
        "ontocode_artifact_hash_collision",
        "Artifact content does not match the existing content-addressed blob",
        409,
        { sha256 },
      );
    }
    return existing;
  }
  const row: typeof ontocodeArtifactBlobs.$inferInsert = {
    id: makeOntoCodeId("ocb"),
    tenantId: ctx.tenantId,
    sha256,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    contentText: content,
    createdAt: now,
  };
  tx.insert(ontocodeArtifactBlobs).values(row).run();
  return row as typeof ontocodeArtifactBlobs.$inferSelect;
}

function requireChangeSetForSession(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  changeSetId: string | undefined,
): typeof ontocodeChangeSets.$inferSelect | undefined {
  if (!changeSetId) return undefined;
  const row = getChangeSetRow(db, ctx, changeSetId);
  if (!row || row.sessionId !== sessionId) {
    throw new OntoCodeStoreError(
      "ontocode_changeset_not_found",
      "The change set does not belong to this build session",
      404,
    );
  }
  return row;
}

function sameArtifactVersionRequest(
  version: OntoCodeArtifactVersion,
  input: CreateOntoCodeArtifactRequest | CreateOntoCodeArtifactVersionRequest,
): boolean {
  return (
    version.changeSetId === (input.changeSetId ?? null) &&
    version.blobHash === artifactContentHash(input.content) &&
    version.contentType === input.contentType &&
    canonicalEvidenceJson(version.metadata) ===
      canonicalEvidenceJson(input.metadata)
  );
}

function artifactVersionForIdempotency(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  idempotencyKey: string,
) {
  return db
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactVersions,
      )(
        and(
          eq(ontocodeArtifactVersions.sessionId, sessionId),
          eq(ontocodeArtifactVersions.idempotencyKey, idempotencyKey),
        ),
      ),
    )
    .get();
}

export function createOntoCodeArtifact(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateOntoCodeArtifactRequest & { idempotencyKey: string },
): {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const existingVersion = artifactVersionForIdempotency(
      tx,
      ctx,
      sessionId,
      input.idempotencyKey,
    );
    if (existingVersion) {
      const artifactRow = requireArtifactRow(
        tx,
        ctx,
        existingVersion.artifactId,
      );
      const artifact = artifactFromRow(artifactRow);
      const version = artifactVersionFromRow(existingVersion);
      if (
        artifact.logicalName !== input.logicalName ||
        artifact.kind !== input.kind ||
        artifact.semanticPath !== (input.semanticPath ?? null) ||
        !sameArtifactVersionRequest(version, input)
      ) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different artifact",
          409,
        );
      }
      return {
        artifact,
        version,
        event: requireCausationEvent(tx, ctx, sessionId, version.id),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    requireExpectedRevision(session, input.expectedSessionRevision);
    const logicalConflict = tx
      .select({ id: ontocodeArtifacts.id })
      .from(ontocodeArtifacts)
      .where(
        tenantScope(
          ctx,
          ontocodeArtifacts,
        )(
          and(
            eq(ontocodeArtifacts.sessionId, sessionId),
            eq(ontocodeArtifacts.logicalName, input.logicalName),
          ),
        ),
      )
      .get();
    if (logicalConflict) {
      throw new OntoCodeStoreError(
        "ontocode_artifact_conflict",
        "An artifact with this logical name already exists; create a new immutable version instead",
        409,
        { artifactId: logicalConflict.id, logicalName: input.logicalName },
      );
    }
    requireChangeSetForSession(tx, ctx, sessionId, input.changeSetId);

    const now = new Date();
    const artifactId = makeOntoCodeId("oca");
    const artifactRow: typeof ontocodeArtifacts.$inferInsert = {
      id: artifactId,
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      logicalName: input.logicalName,
      kind: input.kind,
      semanticPath: input.semanticPath ?? null,
      createdBy: ctx.actorId,
      createdAt: now,
    };
    tx.insert(ontocodeArtifacts).values(artifactRow).run();
    const blob = ensureArtifactBlob(tx, ctx, input.content, now);
    const versionId = makeOntoCodeId("ocav");
    const versionRow: typeof ontocodeArtifactVersions.$inferInsert = {
      id: versionId,
      tenantId: ctx.tenantId,
      artifactId,
      sessionId,
      changeSetId: input.changeSetId ?? null,
      blobId: blob.id,
      version: 1,
      blobHash: blob.sha256,
      contentType: input.contentType,
      sizeBytes: blob.sizeBytes,
      metadataJson: canonicalEvidenceJson(input.metadata),
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
    };
    tx.insert(ontocodeArtifactVersions).values(versionRow).run();
    const revision = bumpOntoCodeSessionRevision(tx, ctx, session, now);
    const artifact = artifactFromRow(
      artifactRow as typeof ontocodeArtifacts.$inferSelect,
    );
    const version = artifactVersionFromRow(
      versionRow as typeof ontocodeArtifactVersions.$inferSelect,
    );
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "artifact.created",
        payload: {
          artifactId,
          artifactVersionId: versionId,
          logicalName: artifact.logicalName,
          kind: artifact.kind,
          version: version.version,
          blobHash: version.blobHash,
          changeSetId: version.changeSetId,
          revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: versionId,
      },
      now,
    );
    return {
      artifact,
      version,
      event,
      sessionRevision: revision,
      mode: "created" as const,
    };
  });
}

export function createOntoCodeArtifactVersion(
  ctx: OntoCodeStoreContext,
  artifactId: string,
  input: CreateOntoCodeArtifactVersionRequest & {
    idempotencyKey: string;
  },
): {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const artifactRow = requireArtifactRow(tx, ctx, artifactId);
    const session = requireWritableSessionRow(tx, ctx, artifactRow.sessionId);
    const existingVersion = artifactVersionForIdempotency(
      tx,
      ctx,
      artifactRow.sessionId,
      input.idempotencyKey,
    );
    if (existingVersion) {
      const version = artifactVersionFromRow(existingVersion);
      if (
        existingVersion.artifactId !== artifactId ||
        !sameArtifactVersionRequest(version, input)
      ) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for a different artifact version",
          409,
        );
      }
      return {
        artifact: artifactFromRow(artifactRow),
        version,
        event: requireCausationEvent(
          tx,
          ctx,
          artifactRow.sessionId,
          version.id,
        ),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    requireExpectedRevision(session, input.expectedSessionRevision);
    requireChangeSetForSession(
      tx,
      ctx,
      artifactRow.sessionId,
      input.changeSetId,
    );
    const candidateHead = tx
      .select({ packageVersionId: ontocodeCandidateHeads.packageVersionId })
      .from(ontocodeCandidateHeads)
      .where(
        tenantScope(
          ctx,
          ontocodeCandidateHeads,
        )(eq(ontocodeCandidateHeads.sessionId, artifactRow.sessionId)),
      )
      .get();
    if (candidateHead) {
      const packageRow = tx
        .select({ artifactRefsJson: ontocodePackageVersions.artifactRefsJson })
        .from(ontocodePackageVersions)
        .where(
          tenantScope(
            ctx,
            ontocodePackageVersions,
          )(eq(ontocodePackageVersions.id, candidateHead.packageVersionId)),
        )
        .get();
      const refs = packageRow
        ? parseJson(
            packageRow.artifactRefsJson,
            "candidatePackage.artifactRefsJson",
          )
        : [];
      if (
        Array.isArray(refs) &&
        refs.some(
          (ref) =>
            ref !== null &&
            typeof ref === "object" &&
            !Array.isArray(ref) &&
            (ref as Record<string, unknown>).artifactId === artifactId,
        )
      ) {
        throw new OntoCodeStoreError(
          "ontocode_workspace_patch_required",
          "Candidate-managed Artifacts must be changed through the atomic Workspace CAS Patch endpoint",
          409,
          {
            artifactId,
            candidatePackageVersionId: candidateHead.packageVersionId,
          },
        );
      }
    }

    const previous = requireLatestArtifactVersionRow(tx, ctx, artifactId);
    const now = new Date();
    const blob = ensureArtifactBlob(tx, ctx, input.content, now);
    const versionId = makeOntoCodeId("ocav");
    const versionRow: typeof ontocodeArtifactVersions.$inferInsert = {
      id: versionId,
      tenantId: ctx.tenantId,
      artifactId,
      sessionId: artifactRow.sessionId,
      changeSetId: input.changeSetId ?? null,
      blobId: blob.id,
      version: previous.version + 1,
      blobHash: blob.sha256,
      contentType: input.contentType,
      sizeBytes: blob.sizeBytes,
      metadataJson: canonicalEvidenceJson(input.metadata),
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
    };
    tx.insert(ontocodeArtifactVersions).values(versionRow).run();
    const revision = bumpOntoCodeSessionRevision(tx, ctx, session, now);
    const artifact = artifactFromRow(artifactRow);
    const version = artifactVersionFromRow(
      versionRow as typeof ontocodeArtifactVersions.$inferSelect,
    );
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId: session.id,
        type: "artifact.version.created",
        payload: {
          artifactId,
          artifactVersionId: versionId,
          previousVersionId: previous.id,
          logicalName: artifact.logicalName,
          kind: artifact.kind,
          version: version.version,
          blobHash: version.blobHash,
          changeSetId: version.changeSetId,
          revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: versionId,
      },
      now,
    );
    return {
      artifact,
      version,
      event,
      sessionRevision: revision,
      mode: "created" as const,
    };
  });
}

export function listOntoCodeArtifacts(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: { limit: number; offset: number; kind?: string },
): Page<{
  artifact: OntoCodeArtifact;
  latestVersion: OntoCodeArtifactVersion;
}> {
  const db = getDb();
  requireSessionRow(db, ctx, sessionId);
  const filters: SQL[] = [eq(ontocodeArtifacts.sessionId, sessionId)];
  if (input.kind) filters.push(eq(ontocodeArtifacts.kind, input.kind));
  const rows = db
    .select()
    .from(ontocodeArtifacts)
    .where(tenantScope(ctx, ontocodeArtifacts)(and(...filters)))
    .orderBy(desc(ontocodeArtifacts.createdAt), desc(ontocodeArtifacts.id))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all();
  return page(
    rows.map((row) => ({
      artifact: artifactFromRow(row),
      latestVersion: artifactVersionFromRow(
        requireLatestArtifactVersionRow(db, ctx, row.id),
      ),
    })),
    input.limit,
    input.offset,
  );
}

export function getOntoCodeArtifact(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  artifactId: string,
): {
  artifact: OntoCodeArtifact;
  latestVersion: OntoCodeArtifactVersion;
} {
  const db = getDb();
  const row = requireArtifactRow(db, ctx, artifactId);
  return {
    artifact: artifactFromRow(row),
    latestVersion: artifactVersionFromRow(
      requireLatestArtifactVersionRow(db, ctx, artifactId),
    ),
  };
}

export function listOntoCodeArtifactVersions(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  artifactId: string,
  input: { limit: number; offset: number },
): Page<OntoCodeArtifactVersion> {
  const db = getDb();
  requireArtifactRow(db, ctx, artifactId);
  const rows = db
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactVersions,
      )(eq(ontocodeArtifactVersions.artifactId, artifactId)),
    )
    .orderBy(desc(ontocodeArtifactVersions.version))
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(artifactVersionFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeArtifactVersion(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  versionId: string,
): {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  content: string;
} {
  const db = getDb();
  const versionRow = requireArtifactVersionRow(db, ctx, versionId);
  const artifactRow = requireArtifactRow(db, ctx, versionRow.artifactId);
  const blob = db
    .select()
    .from(ontocodeArtifactBlobs)
    .where(
      tenantScope(
        ctx,
        ontocodeArtifactBlobs,
      )(eq(ontocodeArtifactBlobs.id, versionRow.blobId)),
    )
    .get();
  if (!blob || blob.sha256 !== versionRow.blobHash) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "The immutable artifact version is missing its content-addressed blob",
      500,
      { versionId },
    );
  }
  return {
    artifact: artifactFromRow(artifactRow),
    version: artifactVersionFromRow(versionRow),
    content: blob.contentText,
  };
}

function sameEvidenceRequest(
  evidence: OntoCodeEvidenceRecord,
  input: CreateOntoCodeEvidenceRecordRequest,
): boolean {
  return (
    evidence.harnessJobId === (input.harnessJobId ?? null) &&
    evidence.changeSetId === (input.changeSetId ?? null) &&
    evidence.artifactVersionId === (input.artifactVersionId ?? null) &&
    evidence.kind === input.kind &&
    evidence.outcome === input.outcome &&
    evidence.subjectType === input.subjectType &&
    evidence.subjectId === input.subjectId &&
    evidence.subjectDigest === input.subjectDigest &&
    evidence.summary === input.summary &&
    evidence.producer === input.producer &&
    canonicalEvidenceJson(evidence.dependencySet) ===
      canonicalEvidenceJson(input.dependencySet) &&
    canonicalEvidenceJson(evidence.validityPredicate) ===
      canonicalEvidenceJson(input.validityPredicate) &&
    canonicalEvidenceJson(evidence.refs) === canonicalEvidenceJson(input.refs)
  );
}

function validateEvidenceAssociations(
  db: DbLike,
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: CreateOntoCodeEvidenceRecordRequest,
): void {
  if (input.harnessJobId) {
    const row = db
      .select({ sessionId: ontocodeHarnessJobs.sessionId })
      .from(ontocodeHarnessJobs)
      .where(
        tenantScope(
          ctx,
          ontocodeHarnessJobs,
        )(eq(ontocodeHarnessJobs.id, input.harnessJobId)),
      )
      .get();
    if (!row || row.sessionId !== sessionId) {
      throw new OntoCodeStoreError(
        "ontocode_harness_job_not_found",
        "The evidence harness job does not belong to this build session",
        404,
      );
    }
  }
  if (input.changeSetId) {
    requireChangeSetForSession(db, ctx, sessionId, input.changeSetId);
  }
  if (input.artifactVersionId) {
    const row = getArtifactVersionRow(db, ctx, input.artifactVersionId);
    if (!row || row.sessionId !== sessionId) {
      throw new OntoCodeStoreError(
        "ontocode_artifact_version_not_found",
        "The evidence artifact version does not belong to this build session",
        404,
      );
    }
  }
}

export function createOntoCodeEvidenceRecord(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CreateOntoCodeEvidenceRecordRequest & {
    idempotencyKey: string;
  },
): {
  evidence: OntoCodeEvidenceRecord;
  event: OntoCodeSessionEvent;
  sessionRevision: number;
  mode: "created" | "attached";
} {
  return getDb().transaction((tx) => {
    const session = requireWritableSessionRow(tx, ctx, sessionId);
    const existing = tx
      .select()
      .from(ontocodeEvidenceRecords)
      .where(
        tenantScope(
          ctx,
          ontocodeEvidenceRecords,
        )(
          and(
            eq(ontocodeEvidenceRecords.sessionId, sessionId),
            eq(ontocodeEvidenceRecords.idempotencyKey, input.idempotencyKey),
          ),
        ),
      )
      .get();
    if (existing) {
      const evidence = evidenceFromRow(existing);
      if (!sameEvidenceRequest(evidence, input)) {
        throw new OntoCodeStoreError(
          "ontocode_idempotency_conflict",
          "This idempotency key was already used for different evidence",
          409,
        );
      }
      return {
        evidence,
        event: requireCausationEvent(tx, ctx, sessionId, evidence.id),
        sessionRevision: session.revision,
        mode: "attached" as const,
      };
    }

    requireExpectedRevision(session, input.expectedSessionRevision);
    validateEvidenceAssociations(tx, ctx, sessionId, input);
    const now = new Date();
    const id = makeOntoCodeId("ocev");
    const row: typeof ontocodeEvidenceRecords.$inferInsert = {
      id,
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      harnessJobId: input.harnessJobId ?? null,
      changeSetId: input.changeSetId ?? null,
      artifactVersionId: input.artifactVersionId ?? null,
      kind: input.kind,
      outcome: input.outcome,
      state: "valid",
      staleReason: null,
      invalidatedByPackageVersionId: null,
      invalidatedAt: null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectDigest: input.subjectDigest,
      dependencySetJson: canonicalEvidenceJson(input.dependencySet),
      validityPredicateJson: canonicalEvidenceJson(input.validityPredicate),
      refsJson: canonicalEvidenceJson(input.refs),
      summary: input.summary,
      producer: input.producer,
      idempotencyKey: input.idempotencyKey,
      recordedBy: ctx.actorId,
      createdAt: now,
    };
    tx.insert(ontocodeEvidenceRecords).values(row).run();
    const revision = bumpOntoCodeSessionRevision(tx, ctx, session, now);
    const evidence = evidenceFromRow(
      row as typeof ontocodeEvidenceRecords.$inferSelect,
    );
    const event = appendEvent(
      tx,
      ctx,
      {
        projectId: session.projectId,
        sessionId,
        type: "evidence.recorded",
        payload: {
          evidenceId: id,
          kind: evidence.kind,
          outcome: evidence.outcome,
          subjectType: evidence.subjectType,
          subjectId: evidence.subjectId,
          subjectDigest: evidence.subjectDigest,
          harnessJobId: evidence.harnessJobId,
          changeSetId: evidence.changeSetId,
          artifactVersionId: evidence.artifactVersionId,
          revision,
        },
        correlationId: makeOntoCodeId("cor"),
        causationId: id,
        harnessJobId: input.harnessJobId ?? null,
      },
      now,
    );
    return {
      evidence,
      event,
      sessionRevision: revision,
      mode: "created" as const,
    };
  });
}

export function listOntoCodeEvidenceRecords(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    kind?: string;
    outcome?: OntoCodeEvidenceRecord["outcome"];
    state?: OntoCodeEvidenceRecord["state"];
  },
): Page<OntoCodeEvidenceRecord> {
  const db = getDb();
  requireSessionRow(db, ctx, sessionId);
  const filters: SQL[] = [eq(ontocodeEvidenceRecords.sessionId, sessionId)];
  if (input.kind) {
    filters.push(eq(ontocodeEvidenceRecords.kind, input.kind));
  }
  if (input.outcome) {
    filters.push(eq(ontocodeEvidenceRecords.outcome, input.outcome));
  }
  if (input.state) {
    filters.push(eq(ontocodeEvidenceRecords.state, input.state));
  }
  const rows = db
    .select()
    .from(ontocodeEvidenceRecords)
    .where(tenantScope(ctx, ontocodeEvidenceRecords)(and(...filters)))
    .orderBy(
      desc(ontocodeEvidenceRecords.createdAt),
      desc(ontocodeEvidenceRecords.id),
    )
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(evidenceFromRow);
  return page(rows, input.limit, input.offset);
}

export function getOntoCodeEvidenceRecord(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  evidenceId: string,
): OntoCodeEvidenceRecord {
  const row = getDb()
    .select()
    .from(ontocodeEvidenceRecords)
    .where(
      tenantScope(
        ctx,
        ontocodeEvidenceRecords,
      )(eq(ontocodeEvidenceRecords.id, evidenceId)),
    )
    .get();
  if (!row) {
    throw new OntoCodeStoreError(
      "ontocode_evidence_not_found",
      "OntoCode evidence record not found",
      404,
    );
  }
  return evidenceFromRow(row);
}
