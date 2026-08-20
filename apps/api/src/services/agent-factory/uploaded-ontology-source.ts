// UploadedOntologySource — an OntologySource backed by FsUploadedOntologyStore, so a user-uploaded
// ontology bundle behaves like any other domain: it appears in the domain switcher and the factory
// reads it via read_ontology. Composed AHEAD of the live/manifest sources so an uploaded domain (and
// an uploaded override of an existing id) wins.

import type { OntologySource, DomainOntology } from "@agentic/agent-factory";
import { FsUploadedOntologyStore } from "./uploaded-ontology-store";
import { OntologyTransportError } from "./ontology-transport-error";
import {
  describeOntologyTransport,
  type OntologyTransportDescriptor,
} from "./ontology-transport-descriptor";

/**
 * Which side of the uploaded-first chain actually answers for a domain, and
 * whether that answer was CHOSEN or merely won a silent race.
 *
 * `base` is the concrete transport behind the base source, or null when it was
 * not consulted / could not describe itself.
 */
export interface OntologyResolutionDescription {
  servedBy: "upload" | "base";
  shadowed: boolean;
  base: OntologyTransportDescriptor | null;
}

/** TENANT-SCOPED uploaded-ontology source. `tenant` is required to surface anything — a missing
 *  tenant (an unscoped port) sees NO uploads (so the catalog can never leak another tenant's). */
export class UploadedOntologySource implements OntologySource {
  constructor(
    private readonly tenant: string | undefined,
    private readonly store = new FsUploadedOntologyStore(),
  ) {}

  async listDomains() {
    if (!this.tenant) return [];
    // Decorate idempotently. The stored name may already carry the marker (an
    // earlier re-upload echoed the decorated display name back and persisted
    // it); strip any trailing run before re-appending exactly one so the
    // switcher/binding/goal-suggestions never show「…（上传）（上传）」.
    return (await this.store.list(this.tenant)).map((m) => {
      const base = m.name.replace(/(（上传）)+$/u, "").trimEnd();
      return {
        id: m.id,
        name: `${base}（上传）`,
        counts: m.counts,
        source: "upload" as const,
      };
    });
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    const o = this.tenant ? await this.store.get(this.tenant, domainId) : null;
    if (!o)
      throw new OntologyTransportError(
        `上传的本体里找不到业务域「${domainId}」。`,
        { failure: "uploaded_bundle_missing", transport: "upload", domainId },
      );
    return o;
  }

  async fetchActionRules(
    domainId: string,
    actionName: string,
  ): Promise<unknown[]> {
    const o = this.tenant ? await this.store.get(this.tenant, domainId) : null;
    if (!o)
      throw new Error(
        `上传的本体里找不到业务域「${domainId}」，无法读取 action rules。`,
      );
    const action = o.actions.find(
      (a) => a.name === actionName || a.id === actionName,
    );
    // Preferred: rules nested under the action's steps (same contract as ManifestOntologySource).
    const steps = (
      action as unknown as { action_steps?: Array<Record<string, unknown>> }
    )?.action_steps;
    if (Array.isArray(steps))
      return steps.flatMap((s) =>
        Array.isArray(s.rules) ? (s.rules as unknown[]) : [],
      );
    // Fallback: prefix-match rules on the action's hierarchical id (action "3" owns "3-1"…).
    if (action?.id)
      return o.rules.filter(
        (r) =>
          typeof (r as { id?: unknown })?.id === "string" &&
          (r as { id: string }).id.startsWith(`${action.id}-`),
      );
    return [];
  }

  /** True if an uploaded bundle exists for this domain id (used for priority routing). */
  async has(domainId: string): Promise<boolean> {
    if (!this.tenant) return false;
    return (await this.store.ids(this.tenant)).has(domainId);
  }
}

/** Wrap a base OntologySource so an UPLOADED domain (by id) takes priority, while every other
 *  domain falls through to the base (manifest / Allmeta) unchanged. listDomains() unions them,
 *  uploaded first; a duplicate id is reported once (uploaded wins). */
export class UploadedFirstOntologySource implements OntologySource {
  constructor(
    private readonly uploaded: UploadedOntologySource,
    private readonly base: OntologySource,
    /** A binding created by upload must not silently fall through to a same-id
     * base ontology when its tenant file is missing/corrupt. */
    private readonly strictUploadedDomainId?: string,
    /** A binding created from the authoritative catalog must not be shadowed
     * later by a tenant upload that happens to reuse the same id.  Binding
     * provenance is part of ontology identity, not a source-priority hint. */
    private readonly strictBaseDomainId?: string,
  ) {}

  async listDomains() {
    const up = await this.uploaded.listDomains();
    // A persisted upload binding is a complete authoritative source in its own
    // right. Do not make reads of that binding depend on the availability of a
    // separate catalog transport (for example Allmeta). Binding repair and
    // source switching use the independent discovery path, so there is no
    // reason for the normal bound-domain read to fail merely because an
    // unrelated source is offline.
    if (this.strictUploadedDomainId) return up;
    const seen = new Set(up.map((d) => d.id));
    const baseList = await this.base.listDomains();
    return [...up, ...baseList.filter((d) => !seen.has(d.id))];
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    if (this.strictUploadedDomainId === domainId)
      return this.uploaded.fetchOntology(domainId);
    if (this.strictBaseDomainId === domainId)
      return this.base.fetchOntology(domainId);
    return (await this.uploaded.has(domainId))
      ? this.uploaded.fetchOntology(domainId)
      : this.base.fetchOntology(domainId);
  }

  /**
   * Report which side serves this domain WITHOUT changing which side serves:
   * the predicate order below is the same one `fetchOntology` runs, so the
   * reported provenance cannot drift from the actual read.
   *
   * `shadowed` is the one thing an FDE cannot otherwise see. It is true ONLY in
   * the unbound-fallback case — no strict argument pinned a side, an uploaded
   * bundle happened to exist for this id, and the base transport is configured
   * and would have answered. A pinned side is a DECISION, not shadowing; an
   * unconfigured base is nothing to shadow.
   */
  async describeResolution(
    domainId: string,
  ): Promise<OntologyResolutionDescription> {
    if (this.strictUploadedDomainId === domainId)
      return { servedBy: "upload", shadowed: false, base: null };
    if (this.strictBaseDomainId === domainId) {
      return {
        servedBy: "base",
        shadowed: false,
        base: await describeOntologyTransport(this.base, domainId),
      };
    }
    const base = await describeOntologyTransport(this.base, domainId);
    if (await this.uploaded.has(domainId)) {
      return {
        servedBy: "upload",
        shadowed: base?.configured === true,
        base,
      };
    }
    return { servedBy: "base", shadowed: false, base };
  }

  async fetchActionRules(
    domainId: string,
    actionName: string,
  ): Promise<unknown[]> {
    if (this.strictUploadedDomainId === domainId)
      return this.uploaded.fetchActionRules(domainId, actionName);
    if (this.strictBaseDomainId === domainId)
      return this.base.fetchActionRules(domainId, actionName);
    return (await this.uploaded.has(domainId))
      ? this.uploaded.fetchActionRules(domainId, actionName)
      : this.base.fetchActionRules(domainId, actionName);
  }

  async listInstances(
    domainId: string,
    objectType: string,
    opts: { limit: number },
  ) {
    if (this.strictUploadedDomainId === domainId) {
      throw new Error(
        `Uploaded ontology ${domainId} carries schema only and does not support instance reads`,
      );
    }
    if (this.strictBaseDomainId === domainId) {
      if (!this.base.listInstances) {
        throw new Error(
          `Ontology source for ${domainId} does not support instance reads`,
        );
      }
      return this.base.listInstances(domainId, objectType, opts);
    }
    if (await this.uploaded.has(domainId)) {
      throw new Error(
        `Uploaded ontology ${domainId} carries schema only and does not support instance reads`,
      );
    }
    if (!this.base.listInstances) {
      throw new Error(
        `Ontology source for ${domainId} does not support instance reads`,
      );
    }
    return this.base.listInstances(domainId, objectType, opts);
  }
}
