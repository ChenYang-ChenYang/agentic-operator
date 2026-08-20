import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  businessOntologyDomains,
  getDb,
  runtimeProfiles,
  runtimeProfileVersions,
  tenantRuntimeNamespaces,
  tenants,
} from "@agentic/db";
import {
  RuntimeProfileSchema,
  RuntimeProfileVersionSchema,
  type CreateRuntimeProfileRequest,
  type CreateRuntimeProfileVersionRequest,
  type RuntimeAdapterCoordinates,
  type RuntimeExecutionReadiness,
  type RuntimeProfile,
  type RuntimeProfileVersion,
} from "@agentic/contracts";
import { getRuntimeTenantRegistrySnapshot } from "./agent-factory/tenant-native-tool-provider";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

export interface RuntimeProfileContext {
  tenantId: string;
  tenantSlug: string;
  actorId: string | null;
}

export class RuntimeProfileStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeProfileStoreError";
  }
}

function makeRuntimeId(prefix: "rtp" | "rtv"): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function timestamp(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_data_corrupt",
      "Runtime Profile has an invalid timestamp",
      500,
    );
  }
  return result;
}

function profileFromRow(
  row: typeof runtimeProfiles.$inferSelect,
): RuntimeProfile {
  return RuntimeProfileSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    archivedAt: timestamp(row.archivedAt),
  });
}

function versionFromRow(
  row: typeof runtimeProfileVersions.$inferSelect,
): RuntimeProfileVersion {
  return RuntimeProfileVersionSchema.parse({
    id: row.id,
    profileId: row.profileId,
    tenantId: row.tenantId,
    version: row.version,
    adapter: {
      kind: row.adapterKind,
      adapterRegistrySlug: row.adapterRegistrySlug,
      adapterRegistryVersion: row.adapterRegistryVersion,
      eventNamespace: row.eventNamespace,
      compatibilityTenantSlug:
        row.adapterKind === "tenant_registry_compat"
          ? row.adapterRegistrySlug
          : null,
    },
    compatibilityTenantId: row.compatibilityTenantId ?? null,
    credentialScope: "business_domain",
    createdBy: row.createdBy ?? null,
    createdAt: timestamp(row.createdAt),
  });
}

function requireProfileRow(
  db: DbLike,
  ctx: Pick<RuntimeProfileContext, "tenantId">,
  profileId: string,
) {
  const row = db
    .select()
    .from(runtimeProfiles)
    .where(
      and(
        eq(runtimeProfiles.id, profileId),
        eq(runtimeProfiles.tenantId, ctx.tenantId),
      ),
    )
    .get();
  if (!row) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_not_found",
      "Runtime Profile was not found in this Business Domain",
      404,
      { profileId },
    );
  }
  return row;
}

function requireVersionRow(
  db: DbLike,
  ctx: Pick<RuntimeProfileContext, "tenantId">,
  versionId: string,
) {
  const row = db
    .select()
    .from(runtimeProfileVersions)
    .where(
      and(
        eq(runtimeProfileVersions.id, versionId),
        eq(runtimeProfileVersions.tenantId, ctx.tenantId),
      ),
    )
    .get();
  if (!row) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_version_not_found",
      "Runtime Profile version was not found in this Business Domain",
      404,
      { runtimeProfileVersionId: versionId },
    );
  }
  const profile = requireProfileRow(db, ctx, row.profileId);
  return { row, profile };
}

function coordinatesEqual(
  row: typeof runtimeProfileVersions.$inferSelect,
  adapter: RuntimeAdapterCoordinates,
  compatibilityTenantId: string | null,
): boolean {
  return (
    row.adapterKind === adapter.kind &&
    row.adapterRegistrySlug === adapter.adapterRegistrySlug &&
    row.adapterRegistryVersion === adapter.adapterRegistryVersion &&
    row.eventNamespace === adapter.eventNamespace &&
    (row.compatibilityTenantId ?? null) === compatibilityTenantId
  );
}

function resolveAdapterTarget(
  db: DbLike,
  ctx: RuntimeProfileContext,
  adapter: RuntimeAdapterCoordinates,
): { compatibilityTenantId: string | null } {
  if (adapter.kind === "native") {
    if (adapter.adapterRegistrySlug !== ctx.tenantSlug) {
      throw new RuntimeProfileStoreError(
        "runtime_profile_native_slug_mismatch",
        "A native Runtime Profile must select the owning Business Domain registry slug",
        409,
        {
          businessTenantSlug: ctx.tenantSlug,
          adapterRegistrySlug: adapter.adapterRegistrySlug,
        },
      );
    }
    return { compatibilityTenantId: null };
  }

  const compatibilitySlug = adapter.compatibilityTenantSlug;
  if (
    !compatibilitySlug ||
    compatibilitySlug !== adapter.adapterRegistrySlug
  ) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_compatibility_identity_mismatch",
      "The compatibility tenant and adapter registry slug must be the same explicit identity",
      409,
    );
  }
  if (compatibilitySlug === ctx.tenantSlug) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_compatibility_self_reference",
      "Use a native Runtime Profile when the adapter belongs to this Business Domain",
      409,
    );
  }
  const target = db
    .select()
    .from(tenants)
    .where(
      and(eq(tenants.slug, compatibilitySlug), isNull(tenants.archivedAt)),
    )
    .get();
  if (!target) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_compatibility_tenant_not_found",
      "The explicit compatibility execution namespace does not exist or is archived",
      404,
      { compatibilityTenantSlug: compatibilitySlug },
    );
  }
  const marker = db
    .select()
    .from(tenantRuntimeNamespaces)
    .where(eq(tenantRuntimeNamespaces.tenantId, target.id))
    .get();
  if (
    marker &&
    marker.businessDomainTenantId !== ctx.tenantId
  ) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_namespace_owned_elsewhere",
      "This compatibility execution namespace is already assigned to another Business Domain",
      409,
      {
        compatibilityTenantSlug: compatibilitySlug,
        assignedBusinessDomainTenantId: marker.businessDomainTenantId,
      },
    );
  }
  const now = new Date();
  if (marker) {
    db.update(tenantRuntimeNamespaces)
      .set({
        status: "active",
        archivedAt: null,
        updatedAt: now,
      })
      .where(eq(tenantRuntimeNamespaces.tenantId, target.id))
      .run();
  } else {
    db.insert(tenantRuntimeNamespaces)
      .values({
        tenantId: target.id,
        businessDomainTenantId: ctx.tenantId,
        status: "active",
        createdBy: ctx.actorId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      .run();
  }
  return { compatibilityTenantId: target.id };
}

function insertVersion(
  db: Transaction,
  ctx: RuntimeProfileContext,
  profile: typeof runtimeProfiles.$inferSelect,
  adapter: RuntimeAdapterCoordinates,
): RuntimeProfileVersion {
  if (profile.status !== "active" || profile.archivedAt !== null) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_archived",
      "An archived Runtime Profile cannot receive a new version",
      409,
      { profileId: profile.id },
    );
  }
  const { compatibilityTenantId } = resolveAdapterTarget(db, ctx, adapter);
  const latest = db
    .select({ version: runtimeProfileVersions.version })
    .from(runtimeProfileVersions)
    .where(
      and(
        eq(runtimeProfileVersions.tenantId, ctx.tenantId),
        eq(runtimeProfileVersions.profileId, profile.id),
      ),
    )
    .orderBy(desc(runtimeProfileVersions.version))
    .limit(1)
    .get();
  const row: typeof runtimeProfileVersions.$inferInsert = {
    id: makeRuntimeId("rtv"),
    profileId: profile.id,
    tenantId: ctx.tenantId,
    version: (latest?.version ?? 0) + 1,
    adapterKind: adapter.kind,
    adapterRegistrySlug: adapter.adapterRegistrySlug,
    adapterRegistryVersion: adapter.adapterRegistryVersion,
    eventNamespace: adapter.eventNamespace,
    compatibilityTenantId,
    createdBy: ctx.actorId,
    createdAt: new Date(),
  };
  db.insert(runtimeProfileVersions).values(row).run();
  return versionFromRow(row as typeof runtimeProfileVersions.$inferSelect);
}

export function listRuntimeProfiles(
  ctx: Pick<RuntimeProfileContext, "tenantId">,
  input: { includeArchived: boolean },
): Array<{ profile: RuntimeProfile; versions: RuntimeProfileVersion[] }> {
  const profileRows = getDb()
    .select()
    .from(runtimeProfiles)
    .where(
      input.includeArchived
        ? eq(runtimeProfiles.tenantId, ctx.tenantId)
        : and(
            eq(runtimeProfiles.tenantId, ctx.tenantId),
            eq(runtimeProfiles.status, "active"),
            isNull(runtimeProfiles.archivedAt),
          ),
    )
    .orderBy(asc(runtimeProfiles.name), asc(runtimeProfiles.id))
    .all();
  if (profileRows.length === 0) return [];
  const profileIds = profileRows.map((row) => row.id);
  const versions = getDb()
    .select()
    .from(runtimeProfileVersions)
    .where(
      and(
        eq(runtimeProfileVersions.tenantId, ctx.tenantId),
        inArray(runtimeProfileVersions.profileId, profileIds),
      ),
    )
    .orderBy(asc(runtimeProfileVersions.profileId), desc(runtimeProfileVersions.version))
    .all();
  const byProfile = new Map<string, RuntimeProfileVersion[]>();
  for (const row of versions) {
    const current = byProfile.get(row.profileId) ?? [];
    current.push(versionFromRow(row));
    byProfile.set(row.profileId, current);
  }
  return profileRows.map((row) => ({
    profile: profileFromRow(row),
    versions: byProfile.get(row.id) ?? [],
  }));
}

export function getRuntimeProfileVersion(
  ctx: Pick<RuntimeProfileContext, "tenantId">,
  versionId: string,
): { profile: RuntimeProfile; version: RuntimeProfileVersion } {
  const { row, profile } = requireVersionRow(getDb(), ctx, versionId);
  return {
    profile: profileFromRow(profile),
    version: versionFromRow(row),
  };
}

export function createRuntimeProfile(
  ctx: RuntimeProfileContext,
  input: CreateRuntimeProfileRequest,
): {
  profile: RuntimeProfile;
  version: RuntimeProfileVersion;
  mode: "created";
} {
  return getDb().transaction((tx) => {
    const existing = tx
      .select()
      .from(runtimeProfiles)
      .where(
        and(
          eq(runtimeProfiles.tenantId, ctx.tenantId),
          eq(runtimeProfiles.name, input.name),
        ),
      )
      .get();
    if (existing) {
      if (existing.status !== "active" || existing.archivedAt !== null) {
        throw new RuntimeProfileStoreError(
          "runtime_profile_name_archived",
          "An archived Runtime Profile already owns this name",
          409,
          { profileId: existing.id, name: input.name },
        );
      }
      const target = resolveAdapterTarget(tx, ctx, input.adapter);
      const matching = tx
        .select()
        .from(runtimeProfileVersions)
        .where(
          and(
            eq(runtimeProfileVersions.tenantId, ctx.tenantId),
            eq(runtimeProfileVersions.profileId, existing.id),
          ),
        )
        .orderBy(desc(runtimeProfileVersions.version))
        .all()
        .find((row) =>
          coordinatesEqual(row, input.adapter, target.compatibilityTenantId),
        );
      if (!matching) {
        throw new RuntimeProfileStoreError(
          "runtime_profile_name_conflict",
          "This Runtime Profile name already exists with different immutable adapter coordinates; create a new version explicitly",
          409,
          { profileId: existing.id, name: input.name },
        );
      }
      return {
        profile: profileFromRow(existing),
        version: versionFromRow(matching),
        mode: "created" as const,
      };
    }
    const now = new Date();
    const row: typeof runtimeProfiles.$inferInsert = {
      id: makeRuntimeId("rtp"),
      tenantId: ctx.tenantId,
      name: input.name,
      description: input.description ?? null,
      status: "active",
      createdBy: ctx.actorId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    tx.insert(runtimeProfiles).values(row).run();
    const version = insertVersion(
      tx,
      ctx,
      row as typeof runtimeProfiles.$inferSelect,
      input.adapter,
    );
    return {
      profile: profileFromRow(row as typeof runtimeProfiles.$inferSelect),
      version,
      mode: "created" as const,
    };
  });
}

export function createRuntimeProfileVersion(
  ctx: RuntimeProfileContext,
  profileId: string,
  input: CreateRuntimeProfileVersionRequest,
): {
  profile: RuntimeProfile;
  version: RuntimeProfileVersion;
  mode: "version_created";
} {
  return getDb().transaction((tx) => {
    const profile = requireProfileRow(tx, ctx, profileId);
    const version = insertVersion(tx, ctx, profile, input.adapter);
    tx.update(runtimeProfiles)
      .set({ updatedAt: new Date() })
      .where(eq(runtimeProfiles.id, profile.id))
      .run();
    return {
      profile: profileFromRow(
        requireProfileRow(tx, ctx, profileId),
      ),
      version,
      mode: "version_created" as const,
    };
  });
}

export function archiveRuntimeProfile(
  ctx: Pick<RuntimeProfileContext, "tenantId">,
  profileId: string,
  confirmName: string,
): {
  profile: RuntimeProfile;
  version: null;
  mode: "archived";
} {
  return getDb().transaction((tx) => {
    const profile = requireProfileRow(tx, ctx, profileId);
    if (profile.name !== confirmName) {
      throw new RuntimeProfileStoreError(
        "runtime_profile_confirmation_mismatch",
        "The confirmation must exactly match the Runtime Profile name",
        409,
      );
    }
    const versionIds = tx
      .select({ id: runtimeProfileVersions.id })
      .from(runtimeProfileVersions)
      .where(
        and(
          eq(runtimeProfileVersions.tenantId, ctx.tenantId),
          eq(runtimeProfileVersions.profileId, profileId),
        ),
      )
      .all()
      .map((row) => row.id);
    if (versionIds.length > 0) {
      const activeBinding = tx
        .select({ id: businessOntologyDomains.id })
        .from(businessOntologyDomains)
        .where(
          and(
            eq(businessOntologyDomains.tenantId, ctx.tenantId),
            inArray(
              businessOntologyDomains.runtimeProfileVersionId,
              versionIds,
            ),
            ne(businessOntologyDomains.status, "archived"),
            isNull(businessOntologyDomains.archivedAt),
          ),
        )
        .limit(1)
        .get();
      if (activeBinding) {
        throw new RuntimeProfileStoreError(
          "runtime_profile_in_use",
          "Archive or rebind active Ontology Domain registrations before archiving this Runtime Profile",
          409,
          {
            profileId,
            ontologyDomainRegistrationId: activeBinding.id,
          },
        );
      }
    }
    const now = new Date();
    tx.update(runtimeProfiles)
      .set({
        status: "archived",
        archivedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runtimeProfiles.id, profileId),
          eq(runtimeProfiles.tenantId, ctx.tenantId),
        ),
      )
      .run();
    return {
      profile: profileFromRow(requireProfileRow(tx, ctx, profileId)),
      version: null,
      mode: "archived" as const,
    };
  });
}

export interface RuntimeProfileBindingProjection {
  version: RuntimeProfileVersion | null;
  readiness: RuntimeExecutionReadiness;
}

export function runtimeProfileBindingProjections(
  db: DbLike,
  ctx: Pick<RuntimeProfileContext, "tenantId" | "tenantSlug">,
  versionIds: Array<string | null | undefined>,
): Map<string, RuntimeProfileBindingProjection> {
  const ids = [...new Set(versionIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      version: runtimeProfileVersions,
      profileStatus: runtimeProfiles.status,
      profileArchivedAt: runtimeProfiles.archivedAt,
    })
    .from(runtimeProfileVersions)
    .innerJoin(
      runtimeProfiles,
      and(
        eq(runtimeProfiles.id, runtimeProfileVersions.profileId),
        eq(runtimeProfiles.tenantId, runtimeProfileVersions.tenantId),
      ),
    )
    .where(
      and(
        eq(runtimeProfileVersions.tenantId, ctx.tenantId),
        inArray(runtimeProfileVersions.id, ids),
      ),
    )
    .all();
  return new Map(
    rows.map((joined) => {
      const version = versionFromRow(joined.version);
      let readiness: RuntimeExecutionReadiness;
      if (
        joined.profileStatus !== "active" ||
        joined.profileArchivedAt !== null
      ) {
        readiness = {
          state: "profile_archived",
          code: "runtime_profile_archived",
          message: "The pinned Runtime Profile is archived",
          executable: false,
        };
      } else if (version.adapter.kind === "tenant_registry_compat") {
        readiness = {
          state: "adapter_resolver_required",
          code: "runtime_profile_adapter_resolver_required",
          message:
            "The compatibility adapter is pinned, but cross-namespace execution remains blocked until the dedicated adapter resolver is enabled",
          executable: false,
        };
      } else if (
        version.adapter.adapterRegistrySlug !== ctx.tenantSlug
      ) {
        readiness = {
          state: "invalid",
          code: "runtime_profile_native_slug_mismatch",
          message:
            "The native adapter registry does not match the owning Business Domain",
          executable: false,
        };
      } else {
        const selected = getRuntimeTenantRegistrySnapshot(
          version.adapter.adapterRegistrySlug,
        );
        readiness =
          selected?.selectedVersion ===
          version.adapter.adapterRegistryVersion
            ? {
                state: "ready",
                code: "runtime_profile_ready",
                message:
                  "The Business Domain owns execution scope and the exact native adapter version is loaded",
                executable: true,
              }
            : {
                state: "configuration_required",
                code: "runtime_profile_adapter_version_unavailable",
                message:
                  "The exact native adapter version pinned by this Runtime Profile is not loaded",
                executable: false,
              };
      }
      return [version.id, { version, readiness }] as const;
    }),
  );
}

export function assertRuntimeProfileVersionForTenant(
  db: DbLike,
  ctx: Pick<RuntimeProfileContext, "tenantId" | "tenantSlug">,
  versionId: string,
): RuntimeProfileBindingProjection {
  const projection = runtimeProfileBindingProjections(db, ctx, [versionId]).get(
    versionId,
  );
  if (!projection) {
    throw new RuntimeProfileStoreError(
      "runtime_profile_version_not_found",
      "Runtime Profile version was not found in this Business Domain",
      404,
      { runtimeProfileVersionId: versionId },
    );
  }
  return projection;
}
