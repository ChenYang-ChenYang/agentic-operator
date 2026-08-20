// CompositeOntologySource — routes OntologySource calls between the live Allmeta
// source and the local manifest source, so the factory sees BOTH live AllmetaOntology
// domains and the existing local models/<slug>/ domains.
//
// Routing (regression-free):
//   • A domain that has a LOCAL models/ folder  → manifest (unchanged behavior for
//     legacy local ontology folders).
//   • Any other domain Allmeta serves           → Allmeta, STRICT live (throws on
//     unreachable / empty).
//
// listDomains() returns the UNION (deduped by exact canonical id). Both sources are
// strict: an unavailable configured source is surfaced rather than silently making
// domains disappear from the operator catalog.

import type { OntologySource, DomainOntology } from "@agentic/agent-factory";
import {
  describeOntologyTransport,
  type OntologyTransportDescriptor,
} from "./ontology-transport-descriptor";

export class CompositeOntologySource implements OntologySource {
  constructor(
    private readonly allmeta: OntologySource,
    private readonly manifest: OntologySource,
  ) {}

  /** Exact catalog ids of domains backed by a local models/ folder (a REAL ontology folder — the
   *  manifest source already drops `-sb` + ontology-less deployment artifacts, so a stale promoted
   *  artifact like `agents-generation-v1` is NOT here and therefore routes to live Allmeta). */
  private async localIds(): Promise<Set<string>> {
    const local = await this.manifest.listDomains();
    return new Set(local.map((d) => d.id));
  }

  /** A domain is served by Allmeta unless it has a (real) local folder. Local ontology folders keep
   *  winning in migration-only auto mode — we only let Allmeta serve a domain
   *  whose local presence is a DEPLOYMENT ARTIFACT that the manifest source already filtered out. */
  private async isAllmetaDomain(domainId: string): Promise<boolean> {
    return !(await this.localIds()).has(domainId);
  }

  async listDomains() {
    // Manifest first so local domains keep their cheap counts; append Allmeta domains not already
    // present (the manifest source drops `-sb` + artifact folders, so a live domain like
    // an exact live Allmeta identity is no longer shadowed).
    const local = await this.manifest.listDomains();
    const seen = new Set(local.map((d) => d.id));
    const remote = await this.allmeta.listDomains();
    const merged = [...local];
    for (const d of remote) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push(d);
    }
    return merged;
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    if (!(await this.isAllmetaDomain(domainId))) return this.manifest.fetchOntology(domainId);
    return this.allmeta.fetchOntology(domainId);
  }

  /** Describe whichever side THIS domain routes to — the same predicate the
   *  fetch uses, so provenance can never disagree with what served. */
  async describeTransport(
    domainId: string,
  ): Promise<OntologyTransportDescriptor | null> {
    const target = (await this.isAllmetaDomain(domainId))
      ? this.allmeta
      : this.manifest;
    return describeOntologyTransport(target, domainId);
  }

  async fetchActionRules(domainId: string, actionName: string): Promise<unknown[]> {
    return (await this.isAllmetaDomain(domainId))
      ? this.allmeta.fetchActionRules(domainId, actionName)
      : this.manifest.fetchActionRules(domainId, actionName);
  }

  async listInstances(
    domainId: string,
    objectType: string,
    opts: { limit: number },
  ) {
    const source = (await this.isAllmetaDomain(domainId))
      ? this.allmeta
      : this.manifest;
    if (!source.listInstances) {
      throw new Error(
        `Ontology source for ${domainId} does not support instance reads`,
      );
    }
    return source.listInstances(domainId, objectType, opts);
  }
}
