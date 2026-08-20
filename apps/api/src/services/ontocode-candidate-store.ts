import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeCandidateHeads,
  ontocodePackageVersions,
  tenantScope,
} from "@agentic/db";
import {
  OntoCodeCandidateHeadSchema,
  OntoCodePackageVersionSchema,
  type OntoCodeCandidateHead,
  type OntoCodePackageVersion,
} from "@agentic/contracts";
import {
  getOntoCodeSession,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
  type Page,
} from "./ontocode-session-store";

function timestamp(value: Date | number | null | undefined): number {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "OntoCode Candidate row has an invalid timestamp",
      500,
    );
  }
  return result;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      `OntoCode Candidate row has invalid JSON in ${field}`,
      500,
    );
  }
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
    artifactRefs: parseJson(
      row.artifactRefsJson,
      "packageVersion.artifactRefsJson",
    ),
    executionOwners: parseJson(
      row.executionOwnersJson,
      "packageVersion.executionOwnersJson",
    ),
    status: row.status,
    validation: parseJson(row.validationJson, "packageVersion.validationJson"),
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

export function getOntoCodeCandidateHead(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
): {
  head: OntoCodeCandidateHead | null;
  packageVersion: OntoCodePackageVersion | null;
} {
  getOntoCodeSession(ctx, sessionId);
  const headRow = getDb()
    .select()
    .from(ontocodeCandidateHeads)
    .where(
      tenantScope(
        ctx,
        ontocodeCandidateHeads,
      )(eq(ontocodeCandidateHeads.sessionId, sessionId)),
    )
    .get();
  if (!headRow) return { head: null, packageVersion: null };
  const packageRow = getDb()
    .select()
    .from(ontocodePackageVersions)
    .where(
      tenantScope(
        ctx,
        ontocodePackageVersions,
      )(
        and(
          eq(ontocodePackageVersions.id, headRow.packageVersionId),
          eq(ontocodePackageVersions.sessionId, sessionId),
        ),
      ),
    )
    .get();
  if (!packageRow) {
    throw new OntoCodeStoreError(
      "ontocode_data_corrupt",
      "OntoCode Candidate Head references a missing Package Version",
      500,
      { candidateHeadId: headRow.id },
    );
  }
  return {
    head: headFromRow(headRow),
    packageVersion: packageFromRow(packageRow),
  };
}

export function listOntoCodePackageVersions(
  ctx: Pick<OntoCodeStoreContext, "tenantId">,
  sessionId: string,
  input: {
    limit: number;
    offset: number;
    status?: OntoCodePackageVersion["status"];
  },
): Page<OntoCodePackageVersion> {
  getOntoCodeSession(ctx, sessionId);
  const conditions = [eq(ontocodePackageVersions.sessionId, sessionId)];
  if (input.status) {
    conditions.push(eq(ontocodePackageVersions.status, input.status));
  }
  const rows = getDb()
    .select()
    .from(ontocodePackageVersions)
    .where(tenantScope(ctx, ontocodePackageVersions)(and(...conditions)))
    .orderBy(
      desc(ontocodePackageVersions.createdAt),
      desc(ontocodePackageVersions.id),
    )
    .limit(input.limit + 1)
    .offset(input.offset)
    .all()
    .map(packageFromRow);
  const hasNext = rows.length > input.limit;
  const items = hasNext ? rows.slice(0, input.limit) : rows;
  return {
    items,
    count: items.length,
    nextOffset: hasNext ? input.offset + input.limit : null,
  };
}
