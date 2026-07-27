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
  type SQL,
} from "drizzle-orm";
import {
  businessOntologyDomains,
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeCandidateHeads,
  ontocodeChangeSetOperations,
  ontocodeChangeSets,
  ontocodeCommands,
  ontocodeConfigurationTasks,
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
    ontologyDomainRegistrationId:
      row.ontologyDomainRegistrationId ?? null,
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
    invalidatedByPackageVersionId:
      row.invalidatedByPackageVersionId ?? null,
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
        sessionRuntimeProfileVersionId:
          session.runtimeProfileVersionId ?? null,
        projectRuntimeProfileVersionId:
          project.runtimeProfileVersionId ?? null,
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
            eq(
              ontocodeProjects.ontologyDomainRegistrationId,
              registration.id,
            ),
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
            eq(
              ontocodeProjects.ontologyDomainRegistrationId,
              registration.id,
            ),
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
          ontologyDomainRegistrationId:
            project.ontologyDomainRegistrationId,
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

function turnAssistantAcknowledgement(
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
      ? `已按你的要求切换右侧工作区：“${input.text.slice(0, 200)}”。这次只改变视图，没有创建 Command 或 Harness Job。`
      : `I switched the right-hand workspace for “${input.text.slice(0, 200)}”. This changed only the view; no Command or Harness Job was created.`;
  }
  if (directive.behavior === "explain") {
    return chinese
      ? `当前 Session 位于 ${session.phase}，活动状态为 ${session.activityState}。我会留在对话区解释持久化结果；这次没有执行或修改任何工件。`
      : `This Session is in ${session.phase} with activity ${session.activityState}. I will keep the explanation in chat; this turn did not execute or change any artifact.`;
  }
  if (directive.behavior === "clarify") {
    return chinese
      ? "我还不能安全判断你是想查看结果、了解原因，还是启动真实执行。请明确说“打开测试结果”“解释当前阻塞”或“运行测试”。在你明确前，我不会创建 Command 或 Job。"
      : "I cannot safely tell whether you want to inspect results, understand the state, or start a real execution. Try “open test results”, “explain the current blocker”, or “run tests”. I will not create a Command or Job until that is clear.";
  }
  if (directive.requiresHuman) {
    return chinese
      ? `已准备 ${directive.action}，但服务器策略要求 FDE 审批。Command ${directive.commandId} 与等待中的 Harness Job ${directive.harnessJobId} 已持久化，审批前不会执行。`
      : `I prepared ${directive.action}, but server policy requires FDE approval. Command ${directive.commandId} and waiting Harness Job ${directive.harnessJobId} are persisted and will not execute before approval.`;
  }
  return chinese
    ? `已接收 ${directive.action}。Command ${directive.commandId} 与 Harness Job ${directive.harnessJobId} 已按服务器策略入队；右侧执行托盘会显示真实进度与结果。`
    : `I accepted ${directive.action}. Command ${directive.commandId} and Harness Job ${directive.harnessJobId} were queued under server policy; the execution tray will show real progress and results.`;
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
        status: policy.requiresHuman ? "awaiting_approval" : "queued",
        requiresHuman: policy.requiresHuman,
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
        runtimeProfileVersionId:
          session.runtimeProfileVersionId ?? null,
        kind: policy.jobKind,
        status: policy.requiresHuman ? "waiting_user" : "queued",
        idempotencyKey: turnChildIdempotencyKey(input.idempotencyKey, "job"),
        inputHash: candidateInputHash,
        budgetJson: canonicalEvidenceJson(policy.budget),
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
      job = harnessJobFromRow(
        jobRow as typeof ontocodeHarnessJobs.$inferSelect,
      );
      appendEvent(
        tx,
        ctx,
        {
          projectId: session.projectId,
          sessionId,
          type: policy.requiresHuman
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

      const resumeWaitingUserJobId =
        typeof input.arguments.resumeWaitingUserJobId === "string"
          ? input.arguments.resumeWaitingUserJobId.trim()
          : "";
      if (resumeWaitingUserJobId) {
        const waitingRow = tx
          .select()
          .from(ontocodeHarnessJobs)
          .where(
            tenantScope(
              ctx,
              ontocodeHarnessJobs,
            )(
              and(
                eq(ontocodeHarnessJobs.id, resumeWaitingUserJobId),
                eq(ontocodeHarnessJobs.sessionId, sessionId),
              ),
            ),
          )
          .get();
        if (!waitingRow || waitingRow.status !== "waiting_user") {
          throw new OntoCodeStoreError(
            "ontocode_waiting_job_not_resumable",
            "The referenced Harness Job is not waiting for input in this Session",
            409,
            { resumeWaitingUserJobId },
          );
        }
        if (waitingRow.kind !== policy.jobKind) {
          throw new OntoCodeStoreError(
            "ontocode_waiting_job_kind_mismatch",
            "The follow-up action does not match the waiting Harness operation",
            409,
            {
              resumeWaitingUserJobId,
              waitingJobKind: waitingRow.kind,
              followUpJobKind: policy.jobKind,
            },
          );
        }
        tx.update(ontocodeHarnessJobs)
          .set({
            status: "cancelled",
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            tenantScope(
              ctx,
              ontocodeHarnessJobs,
            )(
              and(
                eq(ontocodeHarnessJobs.id, resumeWaitingUserJobId),
                eq(ontocodeHarnessJobs.status, "waiting_user"),
              ),
            ),
          )
          .run();
        appendEvent(
          tx,
          ctx,
          {
            projectId: session.projectId,
            sessionId,
            type: "harness.job.input_resolved",
            payload: {
              waitingJobId: resumeWaitingUserJobId,
              followUpJobId: jobId,
              sourceMessageId: userMessageId,
            },
            correlationId,
            causationId: userMessageId,
            commandId,
            harnessJobId: jobId,
          },
          now,
        );
      }
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
        requiresHuman: policy.requiresHuman,
        budget: policy.budget,
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
        payload: { directive, assistantMessageId },
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
    ...(requested?.headRevision &&
    requested.headRevision !== head.revision
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
      if (!sameHarnessJobRequest(job, input)) {
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

    requireExpectedRevision(session, input.expectedSessionRevision);
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
      if (command.status !== "approved") {
        throw new OntoCodeStoreError(
          "ontocode_command_not_approved",
          "The command must be approved before a harness job can start",
          409,
          { commandId: command.id, status: command.status },
        );
      }
    }

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
      kind: input.kind,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      inputHash: canonicalInputHash,
      budgetJson:
        input.budget === undefined ? null : canonicalEvidenceJson(input.budget),
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
    const job = harnessJobFromRow(
      row as typeof ontocodeHarnessJobs.$inferSelect,
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
          eq(ontocodeSessionEvents.visibility, input.visibility),
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
