import { and, eq } from "drizzle-orm";
import { businessOntologyDomains, getDb } from "@agentic/db";

import { AllmetaOntologySource } from "./allmeta-ontology-source";
import { CompositeOntologySource } from "./composite-ontology-source";
import { getFactoryDomainBinding } from "./domain-binding";
import { ManifestOntologySource } from "./ontology-source";
import {
  UploadedFirstOntologySource,
  UploadedOntologySource,
} from "./uploaded-ontology-source";

/**
 * Select the authoritative Ontology transport from persisted binding
 * provenance. This is shared by normal Factory execution and the independent
 * preview/promotion TOCTOU guards; callers cannot inject a different reader.
 *
 * The concrete return type is deliberate: every branch below builds an
 * UploadedFirstOntologySource, and a caller that needs to REPORT which side
 * served (`describeResolution`) must not have to downcast or guess.
 */
export function makeBoundFactoryOntologySource(
  tenantSlug: string,
  tenantId: string,
  ontologyDomainRegistrationId?: string | null,
  expectedOntologyDomainId?: string,
): UploadedFirstOntologySource {
  const binding = getFactoryDomainBinding(tenantId);
  const manifest = new ManifestOntologySource();
  // A bound id is already a canonical catalog identity. Never let a later
  // catalog/display-name alias redirect this tenant to a different graph.
  const allmeta = new AllmetaOntologySource(undefined, {
    domainIdentity: "exact",
  });
  const uploaded = new UploadedOntologySource(tenantSlug);
  if (ontologyDomainRegistrationId) {
    const registration = getDb()
      .select()
      .from(businessOntologyDomains)
      .where(
        and(
          eq(businessOntologyDomains.id, ontologyDomainRegistrationId),
          eq(businessOntologyDomains.tenantId, tenantId),
          eq(businessOntologyDomains.status, "active"),
        ),
      )
      .get();
    if (!registration || registration.archivedAt !== null) {
      throw new Error(
        `ontology domain registration ${ontologyDomainRegistrationId} is not active for tenant ${tenantId}`,
      );
    }
    if (
      expectedOntologyDomainId &&
      registration.ontologyDomainId !== expectedOntologyDomainId
    ) {
      throw new Error(
        `ontology domain registration mismatch: expected ${expectedOntologyDomainId}, got ${registration.ontologyDomainId}`,
      );
    }
    if (registration.source === "upload") {
      return new UploadedFirstOntologySource(
        uploaded,
        allmeta,
        registration.ontologyDomainId,
      );
    }
    if (registration.source === "allmeta") {
      return new UploadedFirstOntologySource(
        uploaded,
        allmeta,
        undefined,
        registration.ontologyDomainId,
      );
    }
    const legacyBase = allmeta.configured
      ? new CompositeOntologySource(allmeta, manifest)
      : manifest;
    return new UploadedFirstOntologySource(
      uploaded,
      legacyBase,
      undefined,
      registration.ontologyDomainId,
    );
  }

  if (binding?.source === "upload") {
    return new UploadedFirstOntologySource(
      uploaded,
      allmeta,
      binding.ontologyDomainId,
    );
  }
  if (binding?.source === "explicit") {
    return new UploadedFirstOntologySource(
      uploaded,
      allmeta,
      undefined,
      binding.ontologyDomainId,
    );
  }
  if (binding?.source === "auto") {
    const legacyBase = allmeta.configured
      ? new CompositeOntologySource(allmeta, manifest)
      : manifest;
    return new UploadedFirstOntologySource(uploaded, legacyBase);
  }
  return new UploadedFirstOntologySource(uploaded, allmeta);
}
