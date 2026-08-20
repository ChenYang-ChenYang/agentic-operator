import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
  ontocodeCandidateHeads,
  ontocodeChangeSetOperations,
  ontocodeChangeSets,
  ontocodeCommands,
  ontocodeEvidenceInvalidations,
  ontocodeEvidenceRecords,
  ontocodePackageVersions,
  ontocodeSessionEvents,
  ontocodeSessions,
  tenantScope,
} from "@agentic/db";
import {
  OntoCodeArtifactVersionSchema,
  OntoCodeCandidateHeadSchema,
  OntoCodeChangeSetOperationSchema,
  OntoCodeChangeSetSchema,
  OntoCodePackageVersionSchema,
  OntoCodeSessionEventSchema,
  type CommitOntoCodeWorkspacePatchRequest,
  type OntoCodeArtifactVersion,
  type OntoCodeCandidateHead,
  type OntoCodeChangeSet,
  type OntoCodeChangeSetOperation,
  type OntoCodeExecutionOwner,
  type OntoCodePackageVersion,
  type OntoCodeSessionEvent,
  type OntoCodeWorkspacePatchCommitReceipt,
} from "@agentic/contracts";
import {
  specToAgentCode,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";
import { canonicalEvidenceJson } from "@agentic/shared";
import { computeOntoCodeCandidateDependencyRoot } from "./ontocode-candidate-digest";
import {
  OntoCodeStoreError,
  type OntoCodeStoreContext,
} from "./ontocode-session-store";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function id(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

function parseObject(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `Invalid JSON in ${field}`,
      500,
    );
  }
}

function parseArtifactRefs(
  value: string,
): OntoCodePackageVersion["artifactRefs"] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return OntoCodePackageVersionSchema.shape.artifactRefs.parse(parsed);
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "Candidate Package has invalid Artifact refs",
      500,
    );
  }
}

function parseExecutionOwners(
  value: string,
): Record<string, OntoCodeExecutionOwner> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return OntoCodePackageVersionSchema.shape.executionOwners.parse(parsed);
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "Candidate Package has invalid Execution Owners",
      500,
    );
  }
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
    metadata: parseObject(row.metadataJson, "artifactVersion.metadataJson"),
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
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
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    committedAt: timestamp(row.committedAt),
  });
}

function operationFromRow(
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
    beforeValue: JSON.parse(row.beforeJson) as unknown,
    afterValue: JSON.parse(row.afterJson) as unknown,
    sourceRefs: JSON.parse(row.sourceRefsJson) as unknown,
    invalidates: JSON.parse(row.invalidatesJson) as unknown,
    createdAt: timestamp(row.createdAt),
  });
}

function packageFromRow(
  row: typeof ontocodePackageVersions.$inferSelect,
): OntoCodePackageVersion {
  return OntoCodePackageVersionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    parentVersionId: row.parentVersionId ?? null,
    sourceHarnessJobId: row.sourceHarnessJobId ?? null,
    ontologyHash: row.ontologyHash,
    dependencyRoot: row.dependencyRoot,
    artifactRefs: parseArtifactRefs(row.artifactRefsJson),
    executionOwners: parseExecutionOwners(row.executionOwnersJson),
    status: row.status,
    validation: parseObject(row.validationJson, "package.validationJson"),
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  });
}

function headFromRow(
  row: typeof ontocodeCandidateHeads.$inferSelect,
): OntoCodeCandidateHead {
  return OntoCodeCandidateHeadSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    packageVersionId: row.packageVersionId,
    revision: row.revision,
    updatedBy: row.updatedBy ?? null,
    updatedAt: timestamp(row.updatedAt),
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
    payload: parseObject(row.payloadJson, "event.payloadJson"),
    createdAt: timestamp(row.createdAt),
  });
}

function nextEventSeq(
  tx: Transaction,
  tenantId: string,
  sessionId: string,
): number {
  const latest = tx
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

function ensureBlob(
  tx: Transaction,
  tenantId: string,
  content: string,
  now: Date,
): typeof ontocodeArtifactBlobs.$inferSelect {
  const digest = sha256(content);
  const existing = tx
    .select()
    .from(ontocodeArtifactBlobs)
    .where(
      and(
        eq(ontocodeArtifactBlobs.tenantId, tenantId),
        eq(ontocodeArtifactBlobs.sha256, digest),
      ),
    )
    .get();
  if (existing) {
    if (
      existing.contentText !== content ||
      existing.sizeBytes !== Buffer.byteLength(content, "utf8")
    ) {
      throw new OntoCodeStoreError(
        "ontocode_blob_hash_collision",
        "Content-addressed Artifact blob does not match its digest",
        500,
      );
    }
    return existing;
  }
  const row: typeof ontocodeArtifactBlobs.$inferInsert = {
    id: id("ocb"),
    tenantId,
    sha256: digest,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    contentText: content,
    createdAt: now,
  };
  tx.insert(ontocodeArtifactBlobs).values(row).run();
  return row as typeof ontocodeArtifactBlobs.$inferSelect;
}

function readVersionContent(
  tx: Transaction,
  tenantId: string,
  versionId: string,
  expectedArtifactId: string,
  expectedHash: string,
): {
  version: typeof ontocodeArtifactVersions.$inferSelect;
  content: string;
} {
  const version = tx
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      and(
        eq(ontocodeArtifactVersions.tenantId, tenantId),
        eq(ontocodeArtifactVersions.id, versionId),
        eq(ontocodeArtifactVersions.artifactId, expectedArtifactId),
        eq(ontocodeArtifactVersions.blobHash, expectedHash),
      ),
    )
    .get();
  if (!version) {
    throw new OntoCodeStoreError(
      "ontocode_workspace_cas_conflict",
      "Artifact base version or blob hash no longer matches",
      409,
      { expectedArtifactId, versionId, expectedHash },
    );
  }
  const blob = tx
    .select()
    .from(ontocodeArtifactBlobs)
    .where(
      and(
        eq(ontocodeArtifactBlobs.tenantId, tenantId),
        eq(ontocodeArtifactBlobs.id, version.blobId),
        eq(ontocodeArtifactBlobs.sha256, expectedHash),
      ),
    )
    .get();
  if (!blob || sha256(blob.contentText) !== expectedHash) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "Artifact base blob failed content-addressed readback",
      500,
      { versionId, expectedHash },
    );
  }
  return { version, content: blob.contentText };
}

function requestFingerprint(
  input: CommitOntoCodeWorkspacePatchRequest & { idempotencyKey: string },
): string {
  return sha256(
    canonicalEvidenceJson({
      expectedSessionRevision: input.expectedSessionRevision,
      expectedCandidateHeadRevision: input.expectedCandidateHeadRevision,
      basePackageVersionId: input.basePackageVersionId,
      baseDependencyRoot: input.baseDependencyRoot,
      commandId: input.commandId ?? null,
      summary: input.summary,
      patches: input.patches.map((patch) => ({
        artifactId: patch.artifactId,
        baseArtifactVersionId: patch.baseArtifactVersionId,
        baseBlobHash: patch.baseBlobHash,
        nextBlobHash: sha256(patch.content),
        contentType: patch.contentType ?? null,
        metadata: patch.metadata,
      })),
    }),
  );
}

function attachedReceipt(
  tx: Transaction,
  ctx: OntoCodeStoreContext,
  sessionId: string,
  changeSetRow: typeof ontocodeChangeSets.$inferSelect,
  requestHash: string,
): OntoCodeWorkspacePatchCommitReceipt {
  const operations = tx
    .select()
    .from(ontocodeChangeSetOperations)
    .where(
      and(
        eq(ontocodeChangeSetOperations.tenantId, ctx.tenantId),
        eq(ontocodeChangeSetOperations.changeSetId, changeSetRow.id),
      ),
    )
    .orderBy(ontocodeChangeSetOperations.ordinal)
    .all();
  const sourceRefs = operations[0]
    ? (JSON.parse(operations[0].sourceRefsJson) as unknown)
    : null;
  if (
    !Array.isArray(sourceRefs) ||
    !sourceRefs.includes(`workspace-request:${requestHash}`)
  ) {
    throw new OntoCodeStoreError(
      "ontocode_idempotency_conflict",
      "This idempotency key was already used for a different Workspace patch",
      409,
    );
  }
  const packageRow = tx
    .select()
    .from(ontocodePackageVersions)
    .where(
      and(
        eq(ontocodePackageVersions.tenantId, ctx.tenantId),
        eq(ontocodePackageVersions.sessionId, sessionId),
        eq(
          ontocodePackageVersions.idempotencyKey,
          `workspace:${changeSetRow.idempotencyKey}`,
        ),
      ),
    )
    .get();
  const headRow = tx
    .select()
    .from(ontocodeCandidateHeads)
    .where(
      and(
        eq(ontocodeCandidateHeads.tenantId, ctx.tenantId),
        eq(ontocodeCandidateHeads.sessionId, sessionId),
      ),
    )
    .get();
  const eventRow = tx
    .select()
    .from(ontocodeSessionEvents)
    .where(
      and(
        eq(ontocodeSessionEvents.tenantId, ctx.tenantId),
        eq(ontocodeSessionEvents.sessionId, sessionId),
        eq(ontocodeSessionEvents.causationId, changeSetRow.id),
        eq(ontocodeSessionEvents.type, "workspace.patch.committed"),
      ),
    )
    .get();
  const session = tx
    .select({ revision: ontocodeSessions.revision })
    .from(ontocodeSessions)
    .where(
      and(
        eq(ontocodeSessions.tenantId, ctx.tenantId),
        eq(ontocodeSessions.id, sessionId),
      ),
    )
    .get();
  if (!packageRow || !headRow || !eventRow || !session) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "Committed Workspace patch is missing its Package, Head or event",
      500,
    );
  }
  const versions = tx
    .select()
    .from(ontocodeArtifactVersions)
    .where(
      and(
        eq(ontocodeArtifactVersions.tenantId, ctx.tenantId),
        eq(ontocodeArtifactVersions.changeSetId, changeSetRow.id),
      ),
    )
    .orderBy(ontocodeArtifactVersions.version)
    .all()
    .map(artifactVersionFromRow);
  const staleEvidenceIds = tx
    .select({ evidenceId: ontocodeEvidenceInvalidations.evidenceId })
    .from(ontocodeEvidenceInvalidations)
    .where(
      and(
        eq(ontocodeEvidenceInvalidations.tenantId, ctx.tenantId),
        eq(
          ontocodeEvidenceInvalidations.causedByChangeSetId,
          changeSetRow.id,
        ),
      ),
    )
    .all()
    .map((row) => row.evidenceId);
  return {
    changeSet: changeSetFromRow(changeSetRow),
    operations: operations.map(operationFromRow),
    versions,
    packageVersion: packageFromRow(packageRow),
    head: headFromRow(headRow),
    staleEvidenceIds,
    event: eventFromRow(eventRow),
    sessionRevision: session.revision,
    mode: "attached",
  };
}

export function commitOntoCodeWorkspacePatch(
  ctx: OntoCodeStoreContext,
  sessionId: string,
  input: CommitOntoCodeWorkspacePatchRequest & { idempotencyKey: string },
): OntoCodeWorkspacePatchCommitReceipt {
  const requestHash = requestFingerprint(input);
  return getDb().transaction((tx) => {
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
      if (existing.status !== "committed") {
        throw new OntoCodeStoreError(
          "ontocode_workspace_patch_incomplete",
          "An earlier Workspace patch with this idempotency key did not commit",
          409,
        );
      }
      return attachedReceipt(tx, ctx, sessionId, existing, requestHash);
    }

    const session = tx
      .select()
      .from(ontocodeSessions)
      .where(
        tenantScope(
          ctx,
          ontocodeSessions,
        )(eq(ontocodeSessions.id, sessionId)),
      )
      .get();
    if (!session) {
      throw new OntoCodeStoreError(
        "ontocode_session_not_found",
        "OntoCode session not found",
        404,
      );
    }
    if (
      session.activityState === "cancelled" ||
      session.phase === "completed"
    ) {
      throw new OntoCodeStoreError(
        "ontocode_session_closed",
        "Closed OntoCode sessions are immutable",
        409,
      );
    }
    if (session.revision !== input.expectedSessionRevision) {
      throw new OntoCodeStoreError(
        "ontocode_workspace_cas_conflict",
        "Session revision changed before the Workspace patch committed",
        409,
        {
          expectedSessionRevision: input.expectedSessionRevision,
          currentSessionRevision: session.revision,
        },
      );
    }
    const head = tx
      .select()
      .from(ontocodeCandidateHeads)
      .where(
        tenantScope(
          ctx,
          ontocodeCandidateHeads,
        )(eq(ontocodeCandidateHeads.sessionId, sessionId)),
      )
      .get();
    if (
      !head ||
      head.revision !== input.expectedCandidateHeadRevision ||
      head.packageVersionId !== input.basePackageVersionId
    ) {
      throw new OntoCodeStoreError(
        "ontocode_workspace_cas_conflict",
        "Candidate Head moved before the Workspace patch committed",
        409,
        {
          reason: "head_moved",
          expectedHeadRevision: input.expectedCandidateHeadRevision,
          currentHeadRevision: head?.revision ?? null,
          expectedPackageVersionId: input.basePackageVersionId,
          currentPackageVersionId: head?.packageVersionId ?? null,
        },
      );
    }
    const baseRow = tx
      .select()
      .from(ontocodePackageVersions)
      .where(
        tenantScope(
          ctx,
          ontocodePackageVersions,
        )(
          and(
            eq(ontocodePackageVersions.id, input.basePackageVersionId),
            eq(ontocodePackageVersions.sessionId, sessionId),
            eq(ontocodePackageVersions.projectId, session.projectId),
          ),
        ),
      )
      .get();
    if (
      !baseRow ||
      baseRow.dependencyRoot !== input.baseDependencyRoot ||
      baseRow.ontologyHash !== session.ontologySnapshotHash
    ) {
      throw new OntoCodeStoreError(
        "ontocode_workspace_cas_conflict",
        "Base Candidate identity no longer matches the Session",
        409,
        {
          reason: "candidate_digest_mismatch",
          expectedDependencyRoot: input.baseDependencyRoot,
          currentDependencyRoot: baseRow?.dependencyRoot ?? null,
        },
      );
    }
    if (input.commandId) {
      const command = tx
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
      if (!command || command.type !== "patch_artifact") {
        throw new OntoCodeStoreError(
          "ontocode_patch_command_invalid",
          "Workspace patch Command does not belong to this Session",
          409,
        );
      }
    }

    const baseRefs = parseArtifactRefs(baseRow.artifactRefsJson);
    const executionOwners = parseExecutionOwners(
      baseRow.executionOwnersJson,
    );
    const baseRoot = computeOntoCodeCandidateDependencyRoot({
      ontologyHash: baseRow.ontologyHash,
      environmentProfileVersionId:
        session.environmentProfileVersionId ?? null,
      artifactRefs: baseRefs,
      executionOwners,
    });
    if (baseRoot !== baseRow.dependencyRoot) {
      throw new OntoCodeStoreError(
        "ontocode_candidate_dependency_root_invalid",
        "Base Candidate dependency root failed readback",
        500,
      );
    }
    const byArtifactId = new Map(baseRefs.map((ref) => [ref.artifactId, ref]));
    const manifestRef = baseRefs.find(
      (ref) => ref.kind === "agent_manifest",
    );
    if (!manifestRef) {
      throw new OntoCodeStoreError(
        "ontocode_candidate_manifest_missing",
        "Candidate Package has no authoritative manifest",
        500,
      );
    }
    const manifestRead = readVersionContent(
      tx,
      ctx.tenantId,
      manifestRef.artifactVersionId,
      manifestRef.artifactId,
      manifestRef.blobHash,
    );
    const manifest = parseObject(
      manifestRead.content,
      "candidate manifest",
    );
    const manifestAgents = Array.isArray(manifest.agents)
      ? manifest.agents.flatMap((value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [value as Record<string, unknown>]
            : [],
        )
      : [];
    const manifestByArtifactId = new Map<
      string,
      { agent: Record<string, unknown>; role: "spec" | "code" }
    >();
    for (const agent of manifestAgents) {
      const spec =
        agent.spec && typeof agent.spec === "object" && !Array.isArray(agent.spec)
          ? (agent.spec as Record<string, unknown>)
          : null;
      const code =
        agent.code && typeof agent.code === "object" && !Array.isArray(agent.code)
          ? (agent.code as Record<string, unknown>)
          : null;
      const specRef = baseRefs.find(
        (ref) => ref.artifactVersionId === spec?.artifactVersionId,
      );
      const codeRef = baseRefs.find(
        (ref) => ref.artifactVersionId === code?.artifactVersionId,
      );
      if (specRef) {
        manifestByArtifactId.set(specRef.artifactId, { agent, role: "spec" });
      }
      if (codeRef) {
        manifestByArtifactId.set(codeRef.artifactId, { agent, role: "code" });
      }
    }

    type ExpandedPatch = {
      artifactId: string;
      baseArtifactVersionId: string;
      baseBlobHash: string;
      content: string;
      contentType?: string;
      metadata: Record<string, unknown>;
      source: "user" | "derived_projection";
    };
    const expanded = new Map<string, ExpandedPatch>();
    for (const patch of input.patches) {
      const ref = byArtifactId.get(patch.artifactId);
      if (
        !ref ||
        ref.artifactVersionId !== patch.baseArtifactVersionId ||
        ref.blobHash !== patch.baseBlobHash
      ) {
        throw new OntoCodeStoreError(
          "ontocode_workspace_cas_conflict",
          "Patch target is not the exact Artifact Version in the base Candidate",
          409,
          { reason: "artifact_base_moved", artifactId: patch.artifactId },
        );
      }
      if (ref.kind === "agent_manifest") {
        throw new OntoCodeStoreError(
          "ontocode_manifest_managed",
          "Candidate manifest is rebuilt by the Workspace service and cannot be patched directly",
          409,
          { artifactId: ref.artifactId },
        );
      }
      const manifestBinding = manifestByArtifactId.get(ref.artifactId);
      const slug =
        typeof manifestBinding?.agent.slug === "string"
          ? manifestBinding.agent.slug
          : null;
      const owner =
        slug && Object.hasOwn(executionOwners, slug)
          ? executionOwners[slug]
          : null;
      if (
        ref.kind === "agent_code" &&
        owner === "declarative_manifest"
      ) {
        throw new OntoCodeStoreError(
          "ontocode_representation_only_artifact",
          "This TypeScript file is a read-only projection; edit its Agent Spec instead",
          409,
          { artifactId: ref.artifactId, executionOwner: owner },
        );
      }
      expanded.set(ref.artifactId, {
        ...patch,
        metadata: patch.metadata,
        source: "user",
      });

      if (
        ref.kind === "agent_spec" &&
        owner === "declarative_manifest" &&
        manifestBinding
      ) {
        let nextSpec: GeneratedAgentSpec;
        try {
          nextSpec = JSON.parse(patch.content) as GeneratedAgentSpec;
          if (
            nextSpec.slug !== slug ||
            nextSpec.codeExecuted === true
          ) {
            throw new Error(
              "Spec cannot change slug or declarative execution ownership",
            );
          }
        } catch (error) {
          throw new OntoCodeStoreError(
            "ontocode_agent_spec_invalid",
            error instanceof Error ? error.message : "Invalid Agent Spec JSON",
            409,
            { artifactId: ref.artifactId },
          );
        }
        const codeVersionId =
          (
            manifestBinding.agent.code as Record<string, unknown> | undefined
          )?.artifactVersionId;
        const codeRef = baseRefs.find(
          (candidate) =>
            candidate.artifactVersionId === codeVersionId &&
            candidate.kind === "agent_code",
        );
        if (!codeRef) {
          throw new OntoCodeStoreError(
            "ontocode_candidate_manifest_mismatch",
            `Declarative Agent ${slug} has no projected Code ref`,
            500,
          );
        }
        const generatedCode = specToAgentCode({
          ...nextSpec,
          generatedCode: undefined,
          codeExecuted: false,
          codeSource: "render",
        });
        if (sha256(generatedCode) !== codeRef.blobHash) {
          expanded.set(codeRef.artifactId, {
            artifactId: codeRef.artifactId,
            baseArtifactVersionId: codeRef.artifactVersionId,
            baseBlobHash: codeRef.blobHash,
            content: generatedCode,
            contentType: "text/typescript",
            metadata: {
              derivedFromArtifactId: ref.artifactId,
              renderer: "specToAgentCode",
            },
            source: "derived_projection",
          });
        }
      }
    }

    const now = new Date();
    const changeSetId = id("ocs");
    const changeSetRow: typeof ontocodeChangeSets.$inferInsert = {
      id: changeSetId,
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      commandId: input.commandId ?? null,
      status: "committed",
      summary: input.summary,
      baseOntologyHash: baseRow.ontologyHash,
      basePackageVersionId: baseRow.id,
      expectedSessionRevision: input.expectedSessionRevision,
      idempotencyKey: input.idempotencyKey,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
      committedAt: now,
    };
    tx.insert(ontocodeChangeSets).values(changeSetRow).run();

    const replacements = new Map<
      string,
      OntoCodePackageVersion["artifactRefs"][number]
    >();
    const versionRows: Array<typeof ontocodeArtifactVersions.$inferSelect> = [];
    const operationRows: Array<
      typeof ontocodeChangeSetOperations.$inferSelect
    > = [];
    let ordinal = 0;
    for (const patch of expanded.values()) {
      const ref = byArtifactId.get(patch.artifactId)!;
      const artifact = tx
        .select()
        .from(ontocodeArtifacts)
        .where(
          and(
            eq(ontocodeArtifacts.tenantId, ctx.tenantId),
            eq(ontocodeArtifacts.sessionId, sessionId),
            eq(ontocodeArtifacts.id, patch.artifactId),
          ),
        )
        .get();
      const latest = tx
        .select()
        .from(ontocodeArtifactVersions)
        .where(
          and(
            eq(ontocodeArtifactVersions.tenantId, ctx.tenantId),
            eq(ontocodeArtifactVersions.artifactId, patch.artifactId),
          ),
        )
        .orderBy(desc(ontocodeArtifactVersions.version))
        .limit(1)
        .get();
      if (
        !artifact ||
        !latest ||
        latest.id !== patch.baseArtifactVersionId ||
        latest.blobHash !== patch.baseBlobHash
      ) {
        throw new OntoCodeStoreError(
          "ontocode_workspace_cas_conflict",
          "Artifact changed outside the current Candidate before commit",
          409,
          {
            reason: "artifact_latest_moved",
            artifactId: patch.artifactId,
            currentArtifactVersionId: latest?.id ?? null,
            currentBlobHash: latest?.blobHash ?? null,
          },
        );
      }
      const blob = ensureBlob(tx, ctx.tenantId, patch.content, now);
      if (blob.sha256 === patch.baseBlobHash) {
        throw new OntoCodeStoreError(
          "ontocode_workspace_patch_noop",
          "Workspace patch does not change Artifact content",
          409,
          { artifactId: patch.artifactId },
        );
      }
      const versionId = id("ocav");
      const versionRow: typeof ontocodeArtifactVersions.$inferInsert = {
        id: versionId,
        tenantId: ctx.tenantId,
        artifactId: patch.artifactId,
        sessionId,
        changeSetId,
        blobId: blob.id,
        version: latest.version + 1,
        blobHash: blob.sha256,
        contentType: patch.contentType ?? latest.contentType,
        sizeBytes: blob.sizeBytes,
        metadataJson: canonicalEvidenceJson({
          ...patch.metadata,
          author: ctx.actorId ? "human_or_service_actor" : "service",
          patchSource: patch.source,
          baseArtifactVersionId: patch.baseArtifactVersionId,
          baseBlobHash: patch.baseBlobHash,
        }),
        idempotencyKey: `${input.idempotencyKey}:artifact:${patch.artifactId}`,
        createdBy: ctx.actorId,
        createdAt: now,
      };
      tx.insert(ontocodeArtifactVersions).values(versionRow).run();
      const selected =
        versionRow as typeof ontocodeArtifactVersions.$inferSelect;
      versionRows.push(selected);
      replacements.set(patch.artifactId, {
        ...ref,
        artifactVersionId: versionId,
        blobHash: blob.sha256,
      });
      const operationRow: typeof ontocodeChangeSetOperations.$inferInsert = {
        id: id("ocso"),
        tenantId: ctx.tenantId,
        changeSetId,
        ordinal,
        operation: "replace",
        semanticPath:
          artifact.semanticPath ?? `/artifacts/${artifact.logicalName}`,
        fromSemanticPath: null,
        beforeJson: canonicalEvidenceJson({
          artifactId: patch.artifactId,
          artifactVersionId: patch.baseArtifactVersionId,
          blobHash: patch.baseBlobHash,
        }),
        afterJson: canonicalEvidenceJson({
          artifactId: patch.artifactId,
          artifactVersionId: versionId,
          blobHash: blob.sha256,
          source: patch.source,
        }),
        sourceRefsJson: canonicalEvidenceJson([
          `workspace-request:${requestHash}`,
          `ontocode-artifact-version:${patch.baseArtifactVersionId}`,
        ]),
        invalidatesJson: canonicalEvidenceJson([
          `candidate-package:${baseRow.id}`,
          `candidate-dependency-root:${baseRow.dependencyRoot}`,
        ]),
        createdAt: now,
      };
      tx.insert(ontocodeChangeSetOperations).values(operationRow).run();
      operationRows.push(
        operationRow as typeof ontocodeChangeSetOperations.$inferSelect,
      );
      ordinal += 1;
    }

    let manifestChanged = false;
    for (const agent of manifestAgents) {
      for (const role of ["spec", "code"] as const) {
        const binding =
          agent[role] &&
          typeof agent[role] === "object" &&
          !Array.isArray(agent[role])
            ? (agent[role] as Record<string, unknown>)
            : null;
        const oldRef = baseRefs.find(
          (ref) => ref.artifactVersionId === binding?.artifactVersionId,
        );
        const replacement = oldRef
          ? replacements.get(oldRef.artifactId)
          : null;
        if (binding && replacement) {
          binding.artifactVersionId = replacement.artifactVersionId;
          binding.blobHash = replacement.blobHash;
          manifestChanged = true;
        }
      }
      const owner =
        typeof agent.slug === "string" ? executionOwners[agent.slug] : null;
      const authority =
        owner === "codeact"
          ? (agent.code as Record<string, unknown> | undefined)
          : (agent.spec as Record<string, unknown> | undefined);
      if (authority?.artifactVersionId) {
        agent.authoritativeArtifactVersionId = authority.artifactVersionId;
      }
    }
    if (manifestChanged) {
      manifest.sourceChangeSetId = changeSetId;
      manifest.parentPackageVersionId = baseRow.id;
      const content = canonicalEvidenceJson(manifest);
      const blob = ensureBlob(tx, ctx.tenantId, content, now);
      const latest = tx
        .select()
        .from(ontocodeArtifactVersions)
        .where(
          and(
            eq(ontocodeArtifactVersions.tenantId, ctx.tenantId),
            eq(ontocodeArtifactVersions.artifactId, manifestRef.artifactId),
          ),
        )
        .orderBy(desc(ontocodeArtifactVersions.version))
        .limit(1)
        .get();
      if (!latest || latest.id !== manifestRef.artifactVersionId) {
        throw new OntoCodeStoreError(
          "ontocode_workspace_cas_conflict",
          "Candidate manifest changed before it could be rebuilt",
          409,
          { reason: "manifest_moved" },
        );
      }
      const versionId = id("ocav");
      const versionRow: typeof ontocodeArtifactVersions.$inferInsert = {
        id: versionId,
        tenantId: ctx.tenantId,
        artifactId: manifestRef.artifactId,
        sessionId,
        changeSetId,
        blobId: blob.id,
        version: latest.version + 1,
        blobHash: blob.sha256,
        contentType: latest.contentType,
        sizeBytes: blob.sizeBytes,
        metadataJson: canonicalEvidenceJson({
          patchSource: "managed_manifest_rebuild",
          baseArtifactVersionId: manifestRef.artifactVersionId,
          baseBlobHash: manifestRef.blobHash,
        }),
        idempotencyKey: `${input.idempotencyKey}:managed-manifest`,
        createdBy: ctx.actorId,
        createdAt: now,
      };
      tx.insert(ontocodeArtifactVersions).values(versionRow).run();
      versionRows.push(
        versionRow as typeof ontocodeArtifactVersions.$inferSelect,
      );
      replacements.set(manifestRef.artifactId, {
        ...manifestRef,
        artifactVersionId: versionId,
        blobHash: blob.sha256,
      });
      const operationRow: typeof ontocodeChangeSetOperations.$inferInsert = {
        id: id("ocso"),
        tenantId: ctx.tenantId,
        changeSetId,
        ordinal,
        operation: "replace",
        semanticPath: "/package/manifest",
        fromSemanticPath: null,
        beforeJson: canonicalEvidenceJson({
          artifactId: manifestRef.artifactId,
          artifactVersionId: manifestRef.artifactVersionId,
          blobHash: manifestRef.blobHash,
        }),
        afterJson: canonicalEvidenceJson({
          artifactId: manifestRef.artifactId,
          artifactVersionId: versionId,
          blobHash: blob.sha256,
          source: "managed_manifest_rebuild",
        }),
        sourceRefsJson: canonicalEvidenceJson([
          `workspace-request:${requestHash}`,
          `ontocode-artifact-version:${manifestRef.artifactVersionId}`,
        ]),
        invalidatesJson: canonicalEvidenceJson([
          `candidate-package:${baseRow.id}`,
          `candidate-dependency-root:${baseRow.dependencyRoot}`,
        ]),
        createdAt: now,
      };
      tx.insert(ontocodeChangeSetOperations).values(operationRow).run();
      operationRows.push(
        operationRow as typeof ontocodeChangeSetOperations.$inferSelect,
      );
    }

    const nextRefs = baseRefs
      .map((ref) => replacements.get(ref.artifactId) ?? ref)
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName));
    const dependencyRoot = computeOntoCodeCandidateDependencyRoot({
      ontologyHash: baseRow.ontologyHash,
      environmentProfileVersionId:
        session.environmentProfileVersionId ?? null,
      artifactRefs: nextRefs,
      executionOwners,
    });
    const packageId = id("ocpv");
    const packageRow: typeof ontocodePackageVersions.$inferInsert = {
      id: packageId,
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      parentVersionId: baseRow.id,
      sourceHarnessJobId: null,
      ontologyHash: baseRow.ontologyHash,
      dependencyRoot,
      artifactRefsJson: canonicalEvidenceJson(nextRefs),
      executionOwnersJson: canonicalEvidenceJson(executionOwners),
      status: "candidate_ready",
      validationJson: canonicalEvidenceJson({
        ...parseObject(baseRow.validationJson, "package.validationJson"),
        schema: "ontocode-candidate-validation/v1",
        passed: true,
        sourceChangeSetId: changeSetId,
        parentPackageVersionId: baseRow.id,
        sandboxEvidenceIncluded: false,
        releaseEligible: false,
      }),
      idempotencyKey: `workspace:${input.idempotencyKey}`,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(ontocodePackageVersions).values(packageRow).run();
    const moved = tx
      .update(ontocodeCandidateHeads)
      .set({
        packageVersionId: packageId,
        revision: head.revision + 1,
        updatedBy: ctx.actorId,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          ontocodeCandidateHeads,
        )(
          and(
            eq(ontocodeCandidateHeads.id, head.id),
            eq(ontocodeCandidateHeads.revision, head.revision),
            eq(ontocodeCandidateHeads.packageVersionId, baseRow.id),
          ),
        ),
      )
      .run();
    if (moved.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_workspace_cas_conflict",
        "Candidate Head lost its compare-and-swap race",
        409,
        { reason: "head_cas_failed" },
      );
    }

    const staleEvidenceIds: string[] = [];
    const evidenceRows = tx
      .select()
      .from(ontocodeEvidenceRecords)
      .where(
        and(
          eq(ontocodeEvidenceRecords.tenantId, ctx.tenantId),
          eq(ontocodeEvidenceRecords.sessionId, sessionId),
          eq(ontocodeEvidenceRecords.state, "valid"),
        ),
      )
      .all();
    for (const evidence of evidenceRows) {
      const dependencySet = parseObject(
        evidence.dependencySetJson,
        "evidence.dependencySetJson",
      );
      const matchedKeys = [
        dependencySet.candidatePackageVersionId === baseRow.id
          ? "candidatePackageVersionId"
          : null,
        dependencySet.candidateDependencyRoot === baseRow.dependencyRoot
          ? "candidateDependencyRoot"
          : null,
      ].filter((value): value is string => Boolean(value));
      if (matchedKeys.length === 0) continue;
      tx.update(ontocodeEvidenceRecords)
        .set({
          state: "stale",
          staleReason: "Candidate Package changed by an atomic Workspace patch",
          invalidatedByPackageVersionId: packageId,
          invalidatedAt: now,
        })
        .where(
          and(
            eq(ontocodeEvidenceRecords.tenantId, ctx.tenantId),
            eq(ontocodeEvidenceRecords.id, evidence.id),
            eq(ontocodeEvidenceRecords.state, "valid"),
          ),
        )
        .run();
      tx.insert(ontocodeEvidenceInvalidations)
        .values({
          id: id("ocei"),
          tenantId: ctx.tenantId,
          evidenceId: evidence.id,
          causedByChangeSetId: changeSetId,
          causedByPackageVersionId: packageId,
          reason: "candidate_dependency_changed",
          dependencyKeysJson: canonicalEvidenceJson(matchedKeys),
          createdAt: now,
        })
        .run();
      staleEvidenceIds.push(evidence.id);
    }

    const sessionRevision = session.revision + 1;
    const bumped = tx
      .update(ontocodeSessions)
      .set({
        revision: sessionRevision,
        phase: "build",
        activityState: "idle",
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
    if (bumped.changes !== 1) {
      throw new OntoCodeStoreError(
        "ontocode_workspace_cas_conflict",
        "Session lost its revision race during Workspace commit",
        409,
      );
    }
    const eventRow: typeof ontocodeSessionEvents.$inferInsert = {
      id: id("oce"),
      tenantId: ctx.tenantId,
      projectId: session.projectId,
      sessionId,
      seq: nextEventSeq(tx, ctx.tenantId, sessionId),
      type: "workspace.patch.committed",
      visibility: "user",
      payloadJson: canonicalEvidenceJson({
        changeSetId,
        basePackageVersionId: baseRow.id,
        packageVersionId: packageId,
        dependencyRoot,
        candidateHeadId: head.id,
        candidateHeadRevision: head.revision + 1,
        artifactVersionIds: versionRows.map((row) => row.id),
        staleEvidenceIds,
      }),
      commandId: input.commandId ?? null,
      harnessJobId: null,
      correlationId: id("cor"),
      causationId: changeSetId,
      createdAt: now,
    };
    tx.insert(ontocodeSessionEvents).values(eventRow).run();
    const updatedHead = tx
      .select()
      .from(ontocodeCandidateHeads)
      .where(eq(ontocodeCandidateHeads.id, head.id))
      .get()!;
    return {
      changeSet: changeSetFromRow(
        changeSetRow as typeof ontocodeChangeSets.$inferSelect,
      ),
      operations: operationRows.map(operationFromRow),
      versions: versionRows.map(artifactVersionFromRow),
      packageVersion: packageFromRow(
        packageRow as typeof ontocodePackageVersions.$inferSelect,
      ),
      head: headFromRow(updatedHead),
      staleEvidenceIds,
      event: eventFromRow(
        eventRow as typeof ontocodeSessionEvents.$inferSelect,
      ),
      sessionRevision,
      mode: "committed",
    };
  });
}
