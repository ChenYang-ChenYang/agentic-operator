import {
  getDb,
  tenantRuntimeNamespaces,
  tenants,
  eq,
  and,
} from "@agentic/db";
import {
  BootstrapRecruitmentRuntimeProfilesReceiptSchema,
  type BootstrapRecruitmentRuntimeProfilesRequest,
} from "@agentic/contracts";
import { registerBusinessOntologyDomain } from "./business-ontology-domain-store";
import { createRuntimeProfile } from "./runtime-profile-store";

export class CanonicalRecruitmentBootstrapError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CanonicalRecruitmentBootstrapError";
  }
}

/**
 * Idempotently attaches authoritative Allmeta identities and reviewed legacy
 * adapter coordinates to an already-provisioned canonical Business Domain.
 *
 * This deliberately does not create tenants, memberships, tokens, budgets,
 * Integrations, provider keys or secrets. It also never moves or rewrites
 * historical rows in compatibility namespaces.
 */
export async function bootstrapCanonicalRecruitmentRuntimeProfiles(
  input: BootstrapRecruitmentRuntimeProfilesRequest,
  actorId: string | null,
) {
  const canonical = getDb()
    .select()
    .from(tenants)
    .where(
      and(
        eq(tenants.slug, input.businessDomainSlug),
      ),
    )
    .get();
  if (!canonical || canonical.archivedAt !== null) {
    throw new CanonicalRecruitmentBootstrapError(
      "canonical_business_domain_not_found",
      "Provision the canonical Recruitment Business Domain before bootstrapping Runtime Profiles",
      404,
      { businessDomainSlug: input.businessDomainSlug },
    );
  }
  const namespaceMarker = getDb()
    .select()
    .from(tenantRuntimeNamespaces)
    .where(eq(tenantRuntimeNamespaces.tenantId, canonical.id))
    .get();
  if (namespaceMarker?.status === "active") {
    throw new CanonicalRecruitmentBootstrapError(
      "canonical_business_domain_is_runtime_namespace",
      "The selected canonical Business Domain is currently classified as a compatibility execution namespace",
      409,
      {
        businessDomainSlug: input.businessDomainSlug,
        businessDomainTenantId: canonical.id,
      },
    );
  }

  const context = {
    tenantId: canonical.id,
    tenantSlug: canonical.slug,
    actorId,
  };
  const items = [];
  for (const requested of input.registrations) {
    const runtime = createRuntimeProfile(context, {
      name: requested.profileName,
      description: `Explicit compatibility adapter for ${requested.ontologyDomainId}; credentials remain owned by ${canonical.slug}`,
      adapter: requested.adapter,
    });
    const registration = await registerBusinessOntologyDomain(context, {
      ontologyDomainId: requested.ontologyDomainId,
      displayName: requested.displayName,
      source: "allmeta",
      makeDefault: false,
      runtimeProfileVersionId: runtime.version.id,
    });
    items.push({
      ontologyDomainRegistrationId: registration.domain.id,
      ontologyDomainId: registration.domain.ontologyDomainId,
      runtimeProfileId: runtime.profile.id,
      runtimeProfileVersionId: runtime.version.id,
      executionState: "adapter_resolver_required" as const,
    });
  }

  return BootstrapRecruitmentRuntimeProfilesReceiptSchema.parse({
    businessDomainTenantId: canonical.id,
    businessDomainSlug: canonical.slug,
    credentialScope: "business_domain",
    items,
  });
}

