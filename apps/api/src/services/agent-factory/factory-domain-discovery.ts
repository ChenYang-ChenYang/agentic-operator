import type { OntologySource } from "@agentic/agent-factory";
import { AllmetaOntologySource } from "./allmeta-ontology-source";
import {
  type FactoryDomainBinding,
  type OntologyDomainListItem,
} from "./domain-binding";
import { UploadedOntologySource } from "./uploaded-ontology-source";

/** Public API vocabulary. `explicit` remains the persisted provenance value,
 * but callers should name the authoritative transport they actually chose. */
export type FactoryDomainRequestedSource = "allmeta" | "upload";

export interface FactoryDomainDiscoverySources {
  upload: OntologySource;
  /** `null` means Allmeta is intentionally not configured, not that a request
   * failed. A configured-but-unreachable catalog still fails closed. */
  allmeta: OntologySource | null;
}

export interface FactoryDomainBindingCandidate {
  domain: OntologyDomainListItem;
  requestedSource: FactoryDomainRequestedSource;
  bindingSource: FactoryDomainBinding["source"];
  ontology: OntologySource;
}

export class FactoryDomainDiscoveryError extends Error {
  constructor(
    readonly code: "domain_not_found" | "domain_source_ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "FactoryDomainDiscoveryError";
  }
}

/**
 * Build a catalog that is deliberately independent of the current persisted
 * binding. Runtime reads must stay strict to that provenance; binding repair
 * cannot, otherwise a stale upload pointer makes its own repair endpoint
 * unreachable.
 */
export function makeFactoryDomainDiscoverySources(
  tenantSlug: string,
): FactoryDomainDiscoverySources {
  const allmeta = new AllmetaOntologySource();
  return {
    upload: new UploadedOntologySource(tenantSlug),
    allmeta: allmeta.configured ? allmeta : null,
  };
}

function persistedSource(
  source: FactoryDomainRequestedSource,
): FactoryDomainBinding["source"] {
  return source === "allmeta" ? "explicit" : "upload";
}

/**
 * Resolve one requested id against each independently named source.
 *
 * An unspecified source is convenient only when exactly one transport owns the
 * id. Same-id upload/Allmeta rows are different ontology identities; choosing
 * by source order would silently change provenance, so ambiguity is returned
 * to the caller instead.
 */
export async function discoverFactoryDomainBindingCandidate(input: {
  requestedId: string;
  requestedSource?: FactoryDomainRequestedSource;
  sources: FactoryDomainDiscoverySources;
}): Promise<FactoryDomainBindingCandidate> {
  const available: Array<{
    requestedSource: FactoryDomainRequestedSource;
    ontology: OntologySource;
  }> = [
    { requestedSource: "upload", ontology: input.sources.upload },
    ...(input.sources.allmeta
      ? [
          {
            requestedSource: "allmeta" as const,
            ontology: input.sources.allmeta,
          },
        ]
      : []),
  ];
  const selectedSources = input.requestedSource
    ? available.filter(
        (candidate) => candidate.requestedSource === input.requestedSource,
      )
    : available;

  const matches = (
    await Promise.all(
      selectedSources.map(async (candidate) => ({
        ...candidate,
        // The picker submits a catalog id, not free text. Case-folding or
        // display-name matching here would turn a typo/stale UI value into a
        // different persisted Ontology identity.
        domain:
          (await candidate.ontology.listDomains()).find(
            (domain) => domain.id === input.requestedId,
          ) ?? null,
      })),
    )
  ).filter(
    (
      candidate,
    ): candidate is typeof candidate & { domain: OntologyDomainListItem } =>
      candidate.domain !== null,
  );

  if (matches.length === 0) {
    const suffix = input.requestedSource
      ? `（source=${input.requestedSource}）`
      : "";
    throw new FactoryDomainDiscoveryError(
      "domain_not_found",
      `本体目录里找不到「${input.requestedId}」${suffix}。`,
    );
  }
  if (matches.length > 1) {
    throw new FactoryDomainDiscoveryError(
      "domain_source_ambiguous",
      `本体「${input.requestedId}」同时存在于 tenant upload 与 Allmeta；请明确指定 source=upload 或 source=allmeta。`,
    );
  }

  const match = matches[0]!;
  return {
    domain: match.domain,
    requestedSource: match.requestedSource,
    bindingSource: persistedSource(match.requestedSource),
    ontology: match.ontology,
  };
}
