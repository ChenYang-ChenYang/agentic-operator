import { and, eq, isNull } from "drizzle-orm";
import {
  getDb,
  runtimeProfiles,
  runtimeProfileVersions,
  tenantRuntimeNamespaces,
  tenants,
} from "@agentic/db";
import type {
  TenantEventAdapter,
  TenantRegistry,
  TenantRegistryFactoryMetadata,
  ToolDescriptor,
  PromptDescriptor,
} from "@agentic/agent-kit";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Transaction;

export interface ReviewedRuntimeProfileAdapterRegistry {
  readonly tools: Readonly<Record<string, ToolDescriptor>>;
  readonly prompts: Readonly<Record<string, PromptDescriptor>>;
  readonly eventAdapter?: TenantEventAdapter;
  readonly factory?: TenantRegistryFactoryMetadata;
}

export interface ReviewedRuntimeProfileAdapter {
  readonly adapterRegistrySlug: string;
  readonly adapterRegistryVersion: string;
  readonly registry: ReviewedRuntimeProfileAdapterRegistry;
}

export interface RuntimeProfileExecutionContext {
  /** The only authorization, data, credential, Integration, log and file owner. */
  readonly businessTenantId: string;
  readonly businessTenantSlug: string;
  readonly runtimeProfileId: string;
  readonly runtimeProfileVersionId: string;
  readonly adapter: {
    readonly kind: "native" | "tenant_registry_compat";
    readonly adapterRegistrySlug: string;
    readonly adapterRegistryVersion: string;
    readonly eventNamespace: string;
  };
  readonly credentialScope: "business_domain";
  /**
   * Reviewed executable code only. This projection intentionally cannot carry
   * tenant MCP credentials, skill paths or a tenant-owned reasoning config.
   */
  readonly reviewedAdapter: ReviewedRuntimeProfileAdapter;
}

export class RuntimeProfileAdapterResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeProfileAdapterResolutionError";
  }
}

const reviewedAdapters = new Map<string, ReviewedRuntimeProfileAdapter>();

function coordinate(value: string, name: string): string {
  const result = value.trim();
  if (!result) {
    throw new RuntimeProfileAdapterResolutionError(
      "runtime_profile_adapter_coordinate_invalid",
      `${name} is required`,
      500,
    );
  }
  return result;
}

function adapterKey(slug: string, version: string): string {
  return `${slug}\u0000${version}`;
}

function projectRegistry(
  registry: TenantRegistry,
): ReviewedRuntimeProfileAdapterRegistry {
  const tools = Object.freeze({ ...(registry.tools ?? {}) });
  const prompts = Object.freeze({ ...(registry.prompts ?? {}) });
  return Object.freeze({
    tools,
    prompts,
    ...(registry.eventAdapter ? { eventAdapter: registry.eventAdapter } : {}),
    ...(registry.factory ? { factory: registry.factory } : {}),
  });
}

/**
 * Publish code that has been reviewed as a Runtime Profile adapter.
 *
 * Calling publishRuntimeTenantRegistrySnapshot is deliberately insufficient:
 * hot-loaded tenant code, expanded MCP tools and tenant skill paths must never
 * become cross-Business-Domain executable code by accident.
 */
export function publishReviewedRuntimeProfileAdapter(input: {
  adapterRegistrySlug: string;
  adapterRegistryVersion: string;
  registry: TenantRegistry;
}): ReviewedRuntimeProfileAdapter {
  const adapterRegistrySlug = coordinate(
    input.adapterRegistrySlug,
    "adapterRegistrySlug",
  );
  const adapterRegistryVersion = coordinate(
    input.adapterRegistryVersion,
    "adapterRegistryVersion",
  );
  const declaredVersion = input.registry.factory?.source.version?.trim();
  if (!declaredVersion || declaredVersion !== adapterRegistryVersion) {
    throw new RuntimeProfileAdapterResolutionError(
      "runtime_profile_adapter_release_identity_mismatch",
      "A reviewed Runtime Profile adapter must declare the exact immutable release version being published",
      500,
      {
        adapterRegistrySlug,
        adapterRegistryVersion,
        declaredVersion: declaredVersion || null,
      },
    );
  }
  const key = adapterKey(adapterRegistrySlug, adapterRegistryVersion);
  const existing = reviewedAdapters.get(key);
  if (existing) {
    if (existing.registry.factory !== input.registry.factory) {
      throw new RuntimeProfileAdapterResolutionError(
        "runtime_profile_adapter_release_redefinition",
        "A reviewed Runtime Profile adapter release cannot be replaced in-process",
        500,
        { adapterRegistrySlug, adapterRegistryVersion },
      );
    }
    return existing;
  }
  const published = Object.freeze({
    adapterRegistrySlug,
    adapterRegistryVersion,
    registry: projectRegistry(input.registry),
  });
  reviewedAdapters.set(key, published);
  return published;
}

/** Exact immutable lookup. There is intentionally no latest/current fallback. */
export function resolveReviewedRuntimeProfileAdapter(input: {
  adapterRegistrySlug: string;
  adapterRegistryVersion: string;
}): ReviewedRuntimeProfileAdapter {
  const adapterRegistrySlug = coordinate(
    input.adapterRegistrySlug,
    "adapterRegistrySlug",
  );
  const adapterRegistryVersion = coordinate(
    input.adapterRegistryVersion,
    "adapterRegistryVersion",
  );
  const adapter = reviewedAdapters.get(
    adapterKey(adapterRegistrySlug, adapterRegistryVersion),
  );
  if (!adapter) {
    const availableVersions = [...reviewedAdapters.values()]
      .filter((item) => item.adapterRegistrySlug === adapterRegistrySlug)
      .map((item) => item.adapterRegistryVersion)
      .sort();
    throw new RuntimeProfileAdapterResolutionError(
      "runtime_profile_adapter_version_unavailable",
      availableVersions.length > 0
        ? "The pinned Runtime Profile adapter version is not in the reviewed runtime allowlist"
        : "The pinned Runtime Profile adapter is not in the reviewed runtime allowlist",
      409,
      {
        adapterRegistrySlug,
        adapterRegistryVersion,
        availableVersions,
      },
    );
  }
  return adapter;
}

export function isReviewedRuntimeProfileAdapterAvailable(input: {
  adapterRegistrySlug: string;
  adapterRegistryVersion: string;
}): boolean {
  try {
    resolveReviewedRuntimeProfileAdapter(input);
    return true;
  } catch (error) {
    if (error instanceof RuntimeProfileAdapterResolutionError) return false;
    throw error;
  }
}

/** Test-only reset. Production bootstrap publishes immutable releases once. */
export function clearReviewedRuntimeProfileAdapters(): void {
  reviewedAdapters.clear();
}

/**
 * Resolve one pinned Runtime Profile without changing the Business Domain
 * execution identity. Compatibility tenant rows are checked only as
 * control-plane ownership markers and are never returned as runtime scope.
 */
export function resolveRuntimeProfileExecutionContext(
  input: {
    businessTenantId: string;
    businessTenantSlug: string;
    runtimeProfileVersionId: string;
  },
  db: DbLike = getDb(),
): RuntimeProfileExecutionContext {
  const businessTenant = db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(
      and(
        eq(tenants.id, input.businessTenantId),
        eq(tenants.slug, input.businessTenantSlug),
        isNull(tenants.archivedAt),
      ),
    )
    .get();
  if (!businessTenant) {
    throw new RuntimeProfileAdapterResolutionError(
      "runtime_profile_business_domain_not_found",
      "The owning Business Domain does not exist, is archived, or its slug/id pair does not match",
      404,
      {
        businessTenantId: input.businessTenantId,
        businessTenantSlug: input.businessTenantSlug,
      },
    );
  }

  const joined = db
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
        eq(runtimeProfileVersions.id, input.runtimeProfileVersionId),
        eq(runtimeProfileVersions.tenantId, businessTenant.id),
      ),
    )
    .get();
  if (!joined) {
    throw new RuntimeProfileAdapterResolutionError(
      "runtime_profile_version_not_found",
      "The pinned Runtime Profile version does not belong to this Business Domain",
      404,
      { runtimeProfileVersionId: input.runtimeProfileVersionId },
    );
  }
  if (
    joined.profileStatus !== "active"
    || joined.profileArchivedAt !== null
  ) {
    throw new RuntimeProfileAdapterResolutionError(
      "runtime_profile_archived",
      "The pinned Runtime Profile is archived",
      409,
      { runtimeProfileVersionId: input.runtimeProfileVersionId },
    );
  }

  const version = joined.version;
  if (version.adapterKind === "native") {
    if (
      version.adapterRegistrySlug !== businessTenant.slug
      || version.compatibilityTenantId !== null
    ) {
      throw new RuntimeProfileAdapterResolutionError(
        "runtime_profile_native_scope_invalid",
        "A native Runtime Profile must select the owning Business Domain registry and cannot reference a compatibility tenant",
        409,
        { runtimeProfileVersionId: version.id },
      );
    }
  } else {
    if (
      !version.compatibilityTenantId
      || version.adapterRegistrySlug === businessTenant.slug
    ) {
      throw new RuntimeProfileAdapterResolutionError(
        "runtime_profile_compatibility_scope_invalid",
        "The compatibility Runtime Profile has an invalid execution namespace binding",
        409,
        { runtimeProfileVersionId: version.id },
      );
    }
    const namespace = db
      .select({
        tenantId: tenantRuntimeNamespaces.tenantId,
        ownerId: tenantRuntimeNamespaces.businessDomainTenantId,
        status: tenantRuntimeNamespaces.status,
        archivedAt: tenantRuntimeNamespaces.archivedAt,
        tenantSlug: tenants.slug,
        tenantArchivedAt: tenants.archivedAt,
      })
      .from(tenantRuntimeNamespaces)
      .innerJoin(
        tenants,
        eq(tenants.id, tenantRuntimeNamespaces.tenantId),
      )
      .where(
        and(
          eq(
            tenantRuntimeNamespaces.tenantId,
            version.compatibilityTenantId,
          ),
          eq(
            tenantRuntimeNamespaces.businessDomainTenantId,
            businessTenant.id,
          ),
        ),
      )
      .get();
    if (
      !namespace
      || namespace.status !== "active"
      || namespace.archivedAt !== null
      || namespace.tenantArchivedAt !== null
      || namespace.tenantSlug !== version.adapterRegistrySlug
    ) {
      throw new RuntimeProfileAdapterResolutionError(
        "runtime_profile_compatibility_namespace_unavailable",
        "The compatibility execution namespace is missing, archived, owned elsewhere, or does not match the pinned adapter registry",
        409,
        { runtimeProfileVersionId: version.id },
      );
    }
  }

  const reviewedAdapter = resolveReviewedRuntimeProfileAdapter({
    adapterRegistrySlug: version.adapterRegistrySlug,
    adapterRegistryVersion: version.adapterRegistryVersion,
  });
  return Object.freeze({
    businessTenantId: businessTenant.id,
    businessTenantSlug: businessTenant.slug,
    runtimeProfileId: version.profileId,
    runtimeProfileVersionId: version.id,
    adapter: Object.freeze({
      kind: version.adapterKind,
      adapterRegistrySlug: version.adapterRegistrySlug,
      adapterRegistryVersion: version.adapterRegistryVersion,
      eventNamespace: version.eventNamespace,
    }),
    credentialScope: "business_domain" as const,
    reviewedAdapter,
  });
}
