import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  businessOntologyDomains,
  getDb,
  ontocodeProjects,
  ontocodeSessions,
  tenantScope,
} from "@agentic/db";
import {
  BusinessOntologyDomainOntologyReceiptSchema,
  BusinessOntologyDomainSchema,
  type BusinessOntologyDomain,
  type BusinessOntologyDomainCatalogItem,
  type BusinessOntologyDomainOntologyReceipt,
  type CreateBusinessOntologyDomainRequest,
  type RuntimeExecutionReadiness,
  type UpdateBusinessOntologyDomainRequest,
} from "@agentic/contracts";
import { factorySourceOntologyHash } from "@agentic/agent-factory";
import { canonicalEvidenceJson } from "@agentic/shared";
import {
  discoverFactoryDomainBindingCandidate,
  makeFactoryDomainDiscoverySources,
} from "./agent-factory/factory-domain-discovery";
import { makeBoundFactoryOntologySource } from "./agent-factory/bound-ontology-source";
import {
  assertRuntimeProfileVersionForTenant,
  runtimeProfileBindingProjections,
} from "./runtime-profile-store";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

export interface BusinessOntologyDomainContext {
  tenantId: string;
  tenantSlug: string;
  actorId: string | null;
}

export class BusinessOntologyDomainStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BusinessOntologyDomainStoreError";
  }
}

function makeRegistrationId(): string {
  return `bod-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_data_corrupt",
      "Business Ontology Domain has an invalid timestamp",
      500,
    );
  }
  return result;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metadata is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_data_corrupt",
      "Business Ontology Domain has invalid catalog metadata",
      500,
    );
  }
}

function domainFromRow(
  db: DbLike,
  ctx: Pick<BusinessOntologyDomainContext, "tenantId" | "tenantSlug">,
  row: typeof businessOntologyDomains.$inferSelect,
): BusinessOntologyDomain {
  const runtimeProjection = row.runtimeProfileVersionId
    ? runtimeProfileBindingProjections(db, ctx, [
        row.runtimeProfileVersionId,
      ]).get(row.runtimeProfileVersionId)
    : undefined;
  let executionReadiness: RuntimeExecutionReadiness;
  if (row.runtimeBindingMode === "legacy_native") {
    executionReadiness = {
      state: "legacy_compatible",
      code: "runtime_profile_legacy_native",
      message:
        "This pre-migration registration continues to use its tenant-native runtime path",
      executable: true,
    };
  } else if (!row.runtimeProfileVersionId) {
    executionReadiness = {
      state: "configuration_required",
      code: "runtime_profile_version_required",
      message:
        "Bind an immutable Runtime Profile version before starting OntoCode execution",
      executable: false,
    };
  } else if (!runtimeProjection) {
    executionReadiness = {
      state: "invalid",
      code: "runtime_profile_version_invalid",
      message:
        "The pinned Runtime Profile version is missing or belongs to another Business Domain",
      executable: false,
    };
  } else {
    executionReadiness = runtimeProjection.readiness;
  }
  return BusinessOntologyDomainSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    runtimeProfileVersionId: row.runtimeProfileVersionId ?? null,
    runtimeBindingMode: row.runtimeBindingMode,
    runtimeProfileVersion: runtimeProjection?.version ?? null,
    executionReadiness,
    ontologyDomainId: row.ontologyDomainId,
    displayName: row.displayName,
    source: row.source,
    status: row.status,
    isDefault: row.isDefault,
    ontologySnapshotHash: row.ontologySnapshotHash ?? null,
    catalogMetadata: parseMetadata(row.catalogMetadataJson),
    lastVerifiedAt: timestamp(row.lastVerifiedAt),
    lastError: row.lastError ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    archivedAt: timestamp(row.archivedAt),
  });
}

function getRowById(
  db: DbLike,
  ctx: Pick<BusinessOntologyDomainContext, "tenantId">,
  id: string,
) {
  return db
    .select()
    .from(businessOntologyDomains)
    .where(
      tenantScope(
        ctx,
        businessOntologyDomains,
      )(eq(businessOntologyDomains.id, id)),
    )
    .get();
}

function requireRowById(
  db: DbLike,
  ctx: Pick<BusinessOntologyDomainContext, "tenantId">,
  id: string,
) {
  const row = getRowById(db, ctx, id);
  if (!row) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_not_found",
      "Ontology Domain registration was not found in this Business Domain",
      404,
      { registrationId: id },
    );
  }
  return row;
}

export function getBusinessOntologyDomain(
  ctx: Pick<BusinessOntologyDomainContext, "tenantId" | "tenantSlug">,
  id: string,
): BusinessOntologyDomain {
  const db = getDb();
  return domainFromRow(db, ctx, requireRowById(db, ctx, id));
}

/**
 * Read one exact registered Ontology identity for Session scope selection.
 *
 * The registration, rather than an external domain id or legacy default
 * binding, selects the transport. This deliberately rejects migration-only,
 * unavailable, and archived registrations and never uses source priority or
 * fallback.
 */
export async function readBusinessOntologyDomainOntology(
  ctx: BusinessOntologyDomainContext,
  registrationId: string,
): Promise<BusinessOntologyDomainOntologyReceipt> {
  const row = requireRowById(getDb(), ctx, registrationId);
  if (row.status !== "active" || row.archivedAt !== null) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_inactive",
      "This Ontology Domain registration is not active and cannot be used to select an OntoCode scope",
      409,
      {
        registrationId: row.id,
        ontologyDomainId: row.ontologyDomainId,
        status: row.status,
      },
    );
  }
  if (row.source === "manifest_legacy") {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_source_legacy",
      "A migration-only manifest registration must be re-registered from Allmeta or upload before it can be used in OntoCode",
      409,
      {
        registrationId: row.id,
        ontologyDomainId: row.ontologyDomainId,
      },
    );
  }

  let ontology;
  try {
    const source = makeBoundFactoryOntologySource(
      ctx.tenantSlug,
      ctx.tenantId,
      row.id,
      row.ontologyDomainId,
    );
    ontology = await source.fetchOntology(row.ontologyDomainId);
  } catch (error) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_unavailable",
      "The registered Ontology Domain could not be read from its exact authoritative source",
      503,
      {
        registrationId: row.id,
        ontologyDomainId: row.ontologyDomainId,
        source: row.source,
        reason: String((error as Error)?.message ?? error).slice(0, 500),
      },
    );
  }
  if (ontology.domainId !== row.ontologyDomainId) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_identity_mismatch",
      "The authoritative source returned a different Ontology Domain identity",
      409,
      {
        registrationId: row.id,
        requestedDomain: row.ontologyDomainId,
        returnedDomain: ontology.domainId,
        source: row.source,
      },
    );
  }

  const actionIds = new Set<string>();
  for (const action of ontology.actions) {
    if (actionIds.has(action.id)) {
      throw new BusinessOntologyDomainStoreError(
        "business_ontology_domain_invalid",
        "The authoritative Ontology contains duplicate Action ids and cannot define an exact selected-actions scope",
        502,
        {
          registrationId: row.id,
          ontologyDomainId: row.ontologyDomainId,
          actionId: action.id,
        },
      );
    }
    actionIds.add(action.id);
  }

  const snapshotHash = factorySourceOntologyHash(ontology);
  return BusinessOntologyDomainOntologyReceiptSchema.parse({
    registration: domainFromRow(getDb(), ctx, row),
    ontology: {
      domainId: ontology.domainId,
      authoritativeSource: row.source,
      normalizedSource: ontology.source,
      snapshotHash,
      registeredSnapshotHash: row.ontologySnapshotHash ?? null,
      snapshotMatchesRegistration:
        row.ontologySnapshotHash !== null &&
        row.ontologySnapshotHash === snapshotHash,
      counts: {
        actions: ontology.actions.length,
        events: ontology.events.length,
        objects: ontology.objects.length,
        rules: ontology.rules.length,
        links: ontology.links?.length ?? 0,
        workflow: ontology.workflow.length,
      },
      actions: ontology.actions
        .map((action) => ({
          id: action.id,
          name: action.name,
          description: action.description ?? null,
          category: action.category ?? null,
          actor: action.actor,
          trigger: action.trigger,
          triggeredEvent: action.triggered_event,
          targetObjects: action.target_objects,
          toolUse: action.tool_use,
        }))
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        ),
      fetchedAt: Date.now(),
    },
  });
}

export function findBusinessOntologyDomainByIdentity(
  db: DbLike,
  ctx: Pick<BusinessOntologyDomainContext, "tenantId">,
  ontologyDomainId: string,
  input: {
    source?: BusinessOntologyDomain["source"];
    requireActive?: boolean;
  } = {},
) {
  const rows = db
    .select()
    .from(businessOntologyDomains)
    .where(
      tenantScope(
        ctx,
        businessOntologyDomains,
      )(
        and(
          eq(businessOntologyDomains.ontologyDomainId, ontologyDomainId),
          ...(input.source
            ? [eq(businessOntologyDomains.source, input.source)]
            : []),
          ...(input.requireActive
            ? [
                eq(businessOntologyDomains.status, "active"),
                isNull(businessOntologyDomains.archivedAt),
              ]
            : []),
        ),
      ),
    )
    .limit(2)
    .all();
  if (rows.length > 1) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_source_ambiguous",
      "This Ontology Domain id is registered from multiple sources; select its exact registration",
      409,
      {
        ontologyDomainId,
        registrationIds: rows.map((row) => row.id),
        sources: rows.map((row) => row.source),
      },
    );
  }
  return rows[0];
}

export function requireActiveBusinessOntologyDomain(
  db: DbLike,
  ctx: Pick<BusinessOntologyDomainContext, "tenantId">,
  input: {
    registrationId?: string | null;
    ontologyDomainId: string;
  },
) {
  const row = input.registrationId
    ? getRowById(db, ctx, input.registrationId)
    : findBusinessOntologyDomainByIdentity(db, ctx, input.ontologyDomainId);
  if (!row) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_not_registered",
      "This Ontology Domain is not registered under the current Business Domain",
      409,
      {
        registrationId: input.registrationId ?? null,
        ontologyDomainId: input.ontologyDomainId,
      },
    );
  }
  if (row.ontologyDomainId !== input.ontologyDomainId) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_identity_mismatch",
      "The selected registration belongs to a different Ontology Domain",
      409,
      {
        registrationId: row.id,
        requestedDomain: input.ontologyDomainId,
        registeredDomain: row.ontologyDomainId,
      },
    );
  }
  if (row.status !== "active" || row.archivedAt !== null) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_inactive",
      "This Ontology Domain registration is not active and cannot start or mutate an OntoCode workflow",
      409,
      {
        registrationId: row.id,
        ontologyDomainId: row.ontologyDomainId,
        status: row.status,
      },
    );
  }
  return row;
}

export function listBusinessOntologyDomains(
  ctx: Pick<BusinessOntologyDomainContext, "tenantId" | "tenantSlug">,
  input: { includeArchived: boolean; includeUnavailable: boolean },
): { items: BusinessOntologyDomain[]; count: number } {
  const filters = [];
  if (!input.includeArchived) {
    filters.push(isNull(businessOntologyDomains.archivedAt));
    filters.push(ne(businessOntologyDomains.status, "archived"));
  }
  if (!input.includeUnavailable) {
    filters.push(eq(businessOntologyDomains.status, "active"));
  }
  const db = getDb();
  const persisted = db
    .select()
    .from(businessOntologyDomains)
    .where(
      tenantScope(
        ctx,
        businessOntologyDomains,
      )(filters.length ? and(...filters) : undefined),
    )
    .orderBy(
      desc(businessOntologyDomains.isDefault),
      desc(businessOntologyDomains.updatedAt),
      desc(businessOntologyDomains.id),
    )
    .all();
  const runtimeProjections = runtimeProfileBindingProjections(
    db,
    ctx,
    persisted.map((row) => row.runtimeProfileVersionId),
  );
  const rows = persisted.map((row) => {
    const projection = row.runtimeProfileVersionId
      ? runtimeProjections.get(row.runtimeProfileVersionId)
      : undefined;
    let executionReadiness: RuntimeExecutionReadiness;
    if (row.runtimeBindingMode === "legacy_native") {
      executionReadiness = {
        state: "legacy_compatible",
        code: "runtime_profile_legacy_native",
        message:
          "This pre-migration registration continues to use its tenant-native runtime path",
        executable: true,
      };
    } else if (!row.runtimeProfileVersionId) {
      executionReadiness = {
        state: "configuration_required",
        code: "runtime_profile_version_required",
        message:
          "Bind an immutable Runtime Profile version before starting OntoCode execution",
        executable: false,
      };
    } else if (!projection) {
      executionReadiness = {
        state: "invalid",
        code: "runtime_profile_version_invalid",
        message:
          "The pinned Runtime Profile version is missing or belongs to another Business Domain",
        executable: false,
      };
    } else {
      executionReadiness = projection.readiness;
    }
    return BusinessOntologyDomainSchema.parse({
      id: row.id,
      tenantId: row.tenantId,
      runtimeProfileVersionId: row.runtimeProfileVersionId ?? null,
      runtimeBindingMode: row.runtimeBindingMode,
      runtimeProfileVersion: projection?.version ?? null,
      executionReadiness,
      ontologyDomainId: row.ontologyDomainId,
      displayName: row.displayName,
      source: row.source,
      status: row.status,
      isDefault: row.isDefault,
      ontologySnapshotHash: row.ontologySnapshotHash ?? null,
      catalogMetadata: parseMetadata(row.catalogMetadataJson),
      lastVerifiedAt: timestamp(row.lastVerifiedAt),
      lastError: row.lastError ?? null,
      createdBy: row.createdBy ?? null,
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
      archivedAt: timestamp(row.archivedAt),
    });
  });
  return { items: rows, count: rows.length };
}

export async function listBusinessOntologyDomainCatalog(
  ctx: BusinessOntologyDomainContext,
): Promise<{
  items: BusinessOntologyDomainCatalogItem[];
  count: number;
  catalogError: string | null;
}> {
  const registrations = listBusinessOntologyDomains(ctx, {
    includeArchived: true,
    includeUnavailable: true,
  }).items;
  const byDomain = new Map(
    registrations
      .filter((registration) => registration.source === "allmeta")
      .map((registration) => [registration.ontologyDomainId, registration]),
  );
  const allmeta = makeFactoryDomainDiscoverySources(ctx.tenantSlug).allmeta;
  if (!allmeta) {
    return {
      items: [],
      count: 0,
      catalogError: "AllmetaOntology is not configured",
    };
  }
  try {
    const domains = await allmeta.listDomains();
    const items = domains
      .map((domain) => {
        const registration = byDomain.get(domain.id);
        return {
          ontologyDomainId: domain.id,
          displayName: domain.name ?? domain.id,
          source: "allmeta" as const,
          counts: domain.counts ?? {},
          registrationId: registration?.id ?? null,
          registrationStatus: registration?.status ?? null,
        };
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    return { items, count: items.length, catalogError: null };
  } catch (error) {
    return {
      items: [],
      count: 0,
      catalogError: String((error as Error)?.message ?? error).slice(0, 500),
    };
  }
}

async function verifiedCandidate(
  ctx: BusinessOntologyDomainContext,
  input: Pick<
    CreateBusinessOntologyDomainRequest,
    "ontologyDomainId" | "source"
  >,
): Promise<{
  displayName: string;
  ontologySnapshotHash: string;
  catalogMetadata: Record<string, unknown>;
}> {
  let candidate;
  try {
    candidate = await discoverFactoryDomainBindingCandidate({
      requestedId: input.ontologyDomainId,
      requestedSource: input.source,
      sources: makeFactoryDomainDiscoverySources(ctx.tenantSlug),
    });
  } catch (error) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_catalog_lookup_failed",
      String((error as Error)?.message ?? error),
      409,
      { ontologyDomainId: input.ontologyDomainId, source: input.source },
    );
  }
  let ontology;
  try {
    ontology = await candidate.ontology.fetchOntology(candidate.domain.id);
  } catch (error) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_unavailable",
      "The selected Ontology Domain could not be read from its authoritative source",
      503,
      {
        ontologyDomainId: candidate.domain.id,
        source: input.source,
        reason: String((error as Error)?.message ?? error).slice(0, 500),
      },
    );
  }
  if (ontology.domainId !== candidate.domain.id) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_identity_mismatch",
      "The authoritative source returned a different Ontology Domain identity",
      409,
      {
        requestedDomain: candidate.domain.id,
        returnedDomain: ontology.domainId,
      },
    );
  }
  return {
    displayName: candidate.domain.name ?? candidate.domain.id,
    ontologySnapshotHash: factorySourceOntologyHash(ontology),
    catalogMetadata: {
      counts: candidate.domain.counts ?? {},
      source: input.source,
    },
  };
}

export async function registerBusinessOntologyDomain(
  ctx: BusinessOntologyDomainContext,
  input: CreateBusinessOntologyDomainRequest,
): Promise<{
  domain: BusinessOntologyDomain;
  mode: "created" | "attached";
}> {
  if (input.runtimeProfileVersionId) {
    assertRuntimeProfileVersionForTenant(
      getDb(),
      ctx,
      input.runtimeProfileVersionId,
    );
  }
  const verified = await verifiedCandidate(ctx, input);
  const now = new Date();
  return getDb().transaction((tx) => {
    const existing = findBusinessOntologyDomainByIdentity(
      tx,
      ctx,
      input.ontologyDomainId,
      { source: input.source },
    );
    if (existing) {
      if (
        existing.source !== input.source &&
        existing.source !== "manifest_legacy"
      ) {
        throw new BusinessOntologyDomainStoreError(
          "business_ontology_domain_source_conflict",
          "This exact Ontology Domain id is already registered from another authoritative source",
          409,
          {
            registrationId: existing.id,
            ontologyDomainId: existing.ontologyDomainId,
            existingSource: existing.source,
            requestedSource: input.source,
          },
        );
      }
      if (input.makeDefault) {
        tx.update(businessOntologyDomains)
          .set({ isDefault: false, updatedAt: now })
          .where(
            and(
              eq(businessOntologyDomains.tenantId, ctx.tenantId),
              ne(businessOntologyDomains.id, existing.id),
            ),
          )
          .run();
      }
      tx.update(businessOntologyDomains)
        .set({
          displayName: input.displayName ?? verified.displayName,
          source: input.source,
          ...(input.runtimeProfileVersionId
            ? {
                runtimeProfileVersionId: input.runtimeProfileVersionId,
                runtimeBindingMode: "profile_pinned" as const,
              }
            : {}),
          status: "active",
          isDefault: input.makeDefault ? true : existing.isDefault,
          ontologySnapshotHash: verified.ontologySnapshotHash,
          catalogMetadataJson: canonicalEvidenceJson(verified.catalogMetadata),
          lastVerifiedAt: now,
          lastError: null,
          archivedAt: null,
          updatedAt: now,
        })
        .where(eq(businessOntologyDomains.id, existing.id))
        .run();
      return {
        domain: domainFromRow(
          tx,
          ctx,
          requireRowById(tx, ctx, existing.id),
        ),
        mode: "attached" as const,
      };
    }
    const activeCount = tx
      .select({ id: businessOntologyDomains.id })
      .from(businessOntologyDomains)
      .where(
        tenantScope(
          ctx,
          businessOntologyDomains,
        )(
          and(
            eq(businessOntologyDomains.status, "active"),
            isNull(businessOntologyDomains.archivedAt),
          ),
        ),
      )
      .all().length;
    const isDefault = input.makeDefault || activeCount === 0;
    if (isDefault) {
      tx.update(businessOntologyDomains)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(businessOntologyDomains.tenantId, ctx.tenantId))
        .run();
    }
    const row: typeof businessOntologyDomains.$inferInsert = {
      id: makeRegistrationId(),
      tenantId: ctx.tenantId,
      runtimeProfileVersionId: input.runtimeProfileVersionId ?? null,
      runtimeBindingMode: "profile_pinned",
      ontologyDomainId: input.ontologyDomainId,
      displayName: input.displayName ?? verified.displayName,
      source: input.source,
      status: "active",
      isDefault,
      ontologySnapshotHash: verified.ontologySnapshotHash,
      catalogMetadataJson: canonicalEvidenceJson(verified.catalogMetadata),
      lastVerifiedAt: now,
      lastError: null,
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    tx.insert(businessOntologyDomains).values(row).run();
    return {
      domain: domainFromRow(
        tx,
        ctx,
        row as typeof businessOntologyDomains.$inferSelect,
      ),
      mode: "created" as const,
    };
  });
}

export async function verifyBusinessOntologyDomain(
  ctx: BusinessOntologyDomainContext,
  registrationId: string,
): Promise<{
  domain: BusinessOntologyDomain;
  mode: "verified";
}> {
  const current = requireRowById(getDb(), ctx, registrationId);
  if (current.status === "archived" || current.archivedAt !== null) {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_archived",
      "An archived Ontology Domain association cannot be restored by verification; register it again explicitly",
      409,
      {
        registrationId,
        ontologyDomainId: current.ontologyDomainId,
      },
    );
  }
  if (current.source === "manifest_legacy") {
    throw new BusinessOntologyDomainStoreError(
      "business_ontology_domain_source_legacy",
      "A migration-only manifest registration must be re-registered from Allmeta or upload before verification",
      409,
      { registrationId, ontologyDomainId: current.ontologyDomainId },
    );
  }
  try {
    const verified = await verifiedCandidate(ctx, {
      ontologyDomainId: current.ontologyDomainId,
      source: current.source,
    });
    const now = new Date();
    getDb()
      .update(businessOntologyDomains)
      .set({
        status: "active",
        ontologySnapshotHash: verified.ontologySnapshotHash,
        catalogMetadataJson: canonicalEvidenceJson(verified.catalogMetadata),
        lastVerifiedAt: now,
        lastError: null,
        archivedAt: null,
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          businessOntologyDomains,
        )(eq(businessOntologyDomains.id, registrationId)),
      )
      .run();
    return {
      domain: getBusinessOntologyDomain(ctx, registrationId),
      mode: "verified",
    };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 2_000);
    getDb()
      .update(businessOntologyDomains)
      .set({
        status: "unavailable",
        isDefault: false,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(
        tenantScope(
          ctx,
          businessOntologyDomains,
        )(eq(businessOntologyDomains.id, registrationId)),
      )
      .run();
    throw error;
  }
}

export function updateBusinessOntologyDomain(
  ctx: Pick<
    BusinessOntologyDomainContext,
    "tenantId" | "tenantSlug"
  >,
  registrationId: string,
  input: UpdateBusinessOntologyDomainRequest,
): {
  domain: BusinessOntologyDomain;
  mode: "updated";
} {
  const now = new Date();
  getDb().transaction((tx) => {
    const current = requireRowById(tx, ctx, registrationId);
    if (
      input.makeDefault &&
      (current.status !== "active" || current.archivedAt !== null)
    ) {
      throw new BusinessOntologyDomainStoreError(
        "business_ontology_domain_inactive",
        "Only an active verified Ontology Domain can become the default",
        409,
      );
    }
    if (input.makeDefault) {
      tx.update(businessOntologyDomains)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(businessOntologyDomains.tenantId, ctx.tenantId),
            ne(businessOntologyDomains.id, registrationId),
          ),
        )
        .run();
    }
    tx.update(businessOntologyDomains)
      .set({
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
        ...(input.makeDefault ? { isDefault: true } : {}),
        updatedAt: now,
      })
      .where(
        tenantScope(
          ctx,
          businessOntologyDomains,
        )(eq(businessOntologyDomains.id, registrationId)),
      )
      .run();
  });
  return {
    domain: getBusinessOntologyDomain(ctx, registrationId),
    mode: "updated",
  };
}

export function bindBusinessOntologyDomainRuntimeProfile(
  ctx: Pick<
    BusinessOntologyDomainContext,
    "tenantId" | "tenantSlug"
  >,
  registrationId: string,
  runtimeProfileVersionId: string,
): {
  domain: BusinessOntologyDomain;
  mode: "runtime_bound";
} {
  const now = new Date();
  getDb().transaction((tx) => {
    const registration = requireRowById(tx, ctx, registrationId);
    if (
      registration.status !== "active" ||
      registration.archivedAt !== null
    ) {
      throw new BusinessOntologyDomainStoreError(
        "business_ontology_domain_inactive",
        "Only an active Ontology Domain registration can bind a Runtime Profile",
        409,
        { registrationId },
      );
    }
    try {
      assertRuntimeProfileVersionForTenant(
        tx,
        ctx,
        runtimeProfileVersionId,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new BusinessOntologyDomainStoreError(
        "business_ontology_domain_runtime_profile_invalid",
        error.message,
        "statusCode" in error &&
            typeof (error as { statusCode?: unknown }).statusCode ===
              "number"
          ? (error as { statusCode: number }).statusCode
          : 409,
        {
          registrationId,
          runtimeProfileVersionId,
        },
      );
    }
    tx.update(businessOntologyDomains)
      .set({
        runtimeProfileVersionId,
        runtimeBindingMode: "profile_pinned",
        updatedAt: now,
      })
      .where(
        and(
          eq(businessOntologyDomains.id, registrationId),
          eq(businessOntologyDomains.tenantId, ctx.tenantId),
        ),
      )
      .run();
  });
  return {
    domain: getBusinessOntologyDomain(ctx, registrationId),
    mode: "runtime_bound",
  };
}

export function archiveBusinessOntologyDomain(
  ctx: Pick<
    BusinessOntologyDomainContext,
    "tenantId" | "tenantSlug"
  >,
  registrationId: string,
  confirmOntologyDomainId: string,
): {
  domain: BusinessOntologyDomain;
  mode: "archived";
} {
  const now = new Date();
  getDb().transaction((tx) => {
    const current = requireRowById(tx, ctx, registrationId);
    if (current.ontologyDomainId !== confirmOntologyDomainId) {
      throw new BusinessOntologyDomainStoreError(
        "business_ontology_domain_confirmation_mismatch",
        "The confirmation must exactly match the Ontology Domain id",
        409,
      );
    }
    const projects = tx
      .select({ id: ontocodeProjects.id })
      .from(ontocodeProjects)
      .where(
        tenantScope(
          ctx,
          ontocodeProjects,
        )(
          or(
            eq(ontocodeProjects.ontologyDomainRegistrationId, registrationId),
            and(
              isNull(ontocodeProjects.ontologyDomainRegistrationId),
              eq(ontocodeProjects.domain, current.ontologyDomainId),
            ),
          ),
        ),
      )
      .all();
    if (projects.length > 0) {
      const open = tx
        .select({
          id: ontocodeSessions.id,
          phase: ontocodeSessions.phase,
          activityState: ontocodeSessions.activityState,
        })
        .from(ontocodeSessions)
        .where(
          tenantScope(
            ctx,
            ontocodeSessions,
          )(
            and(
              inArray(
                ontocodeSessions.projectId,
                projects.map((project) => project.id),
              ),
              ne(ontocodeSessions.phase, "completed"),
              ne(ontocodeSessions.activityState, "cancelled"),
            ),
          ),
        )
        .orderBy(desc(ontocodeSessions.updatedAt))
        .limit(1)
        .get();
      if (open) {
        throw new BusinessOntologyDomainStoreError(
          "business_ontology_domain_in_use",
          "Complete or cancel open OntoCode Sessions before archiving this Ontology Domain",
          409,
          {
            registrationId,
            sessionId: open.id,
            phase: open.phase,
            activityState: open.activityState,
          },
        );
      }
    }
    tx.update(businessOntologyDomains)
      .set({
        status: "archived",
        isDefault: false,
        archivedAt: now,
        updatedAt: now,
      })
      .where(eq(businessOntologyDomains.id, registrationId))
      .run();
    if (current.isDefault) {
      const replacement = tx
        .select({ id: businessOntologyDomains.id })
        .from(businessOntologyDomains)
        .where(
          tenantScope(
            ctx,
            businessOntologyDomains,
          )(
            and(
              ne(businessOntologyDomains.id, registrationId),
              eq(businessOntologyDomains.status, "active"),
              isNull(businessOntologyDomains.archivedAt),
            ),
          ),
        )
        .orderBy(desc(businessOntologyDomains.updatedAt))
        .limit(1)
        .get();
      if (replacement) {
        tx.update(businessOntologyDomains)
          .set({ isDefault: true, updatedAt: now })
          .where(eq(businessOntologyDomains.id, replacement.id))
          .run();
      }
    }
  });
  return {
    domain: getBusinessOntologyDomain(ctx, registrationId),
    mode: "archived",
  };
}
