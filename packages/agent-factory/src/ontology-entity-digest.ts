// #ONTOCODE-COMPREHEND — per-entity content digest and the anchor index built
// from it.
//
// `ontologyContentHash` (evidence-fingerprint.ts) already content-addresses the
// WHOLE graph with `sortedCanonical` + `canonicalEvidenceJson`. That is the right
// granularity for sandbox evidence — any drift at all must invalidate a green
// run — but it is the wrong granularity for a prior UNDERSTANDING: one edited
// rule would throw away everything the previous analysis worked out about the
// other 147 entities, and the only way to avoid that is to re-read them all.
//
// So this module narrows the SAME normalisation to a single entity. Nothing new
// is invented: a per-entity digest is `canonicalEvidenceJson` of that entity,
// which is exactly the per-item normalisation `sortedCanonical` already applies
// before hashing the graph. That keeps one definition of "changed" across the
// evidence lane and the comprehension lane.
//
// The design (address by content, let a version bump miss naturally rather than
// running an eviction job) is taken from the Build lane's `factory_domain_insights`
// / `DomainInsightStore`, which is keyed on `(tenant_id, domain, ontology_sig)`.
// That table is NOT reused — see ontology-comprehension.ts for why.

import { createHash } from "node:crypto";
import { canonicalEvidenceJson } from "@agentic/shared";
import type {
  DomainOntology,
  OntologyAction,
  OntologyEvent,
  OntologyLink,
  OntologyObject,
  OntologyRule,
} from "./ontology-types";

export type OntologyEntityAnchorKind = "action" | "event" | "object" | "rule" | "link";

export const ONTOLOGY_ENTITY_ANCHOR_KINDS: readonly OntologyEntityAnchorKind[] = [
  "action",
  "event",
  "object",
  "rule",
  "link",
] as const;

export interface OntologyEntityAnchorEntry {
  kind: OntologyEntityAnchorKind;
  digest: string;
}

export interface OntologyEntityAnchorIndex {
  /** Anchor id → kind + digest. Only entities with a STABLE declared id appear. */
  anchors: Map<string, OntologyEntityAnchorEntry>;
  /** How many entities of each kind the ontology declares (anchored or not). */
  totals: Record<OntologyEntityAnchorKind, number>;
  /** Sum of `totals`. The honest denominator for coverage. */
  anchorsTotal: number;
  /** Entities REFUSED an anchor because they declare no stable id, by kind and
   *  real count. They are never given an ordinal: an ordinal is a position, not
   *  an identity, and it silently re-points at a different entity when the list
   *  changes. */
  unanchored: Array<{ kind: OntologyEntityAnchorKind; count: number }>;
  /** Link endpoints that resolve to no ontology entity. Reported, never dropped:
   *  whether every endpoint resolves has not been verified on real data. */
  unresolvedLinkEndpoints: number;
  /** Denominator for the line above. */
  linkEndpointsTotal: number;
  /** One id claimed by more than one kind. Recorded rather than resolved by
   *  first-wins, because either binding could be the one a reader means. */
  collisions: Array<{ id: string; kinds: OntologyEntityAnchorKind[] }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Content digest of ONE ontology entity. Field order is not semantic; every
 *  value is. The kind is part of the digest so a body that appears under two
 *  kinds cannot be mistaken for the same anchor. */
export function ontologyEntityDigest(
  kind: OntologyEntityAnchorKind,
  entity: OntologyAction | OntologyEvent | OntologyObject | OntologyRule | OntologyLink,
): string {
  return sha256(canonicalEvidenceJson({ kind, entity })).slice(0, 32);
}

function declaredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The declared id of a rule, or `null`. Deliberately has NO ordinal fallback. */
export function declaredRuleAnchorId(rule: OntologyRule): string | null {
  const record = rule as Record<string, unknown>;
  return (
    declaredText(record.id) ??
    declaredText(record.rule_id) ??
    declaredText(record.name)
  );
}

/**
 * Build the anchor index for an ontology snapshot. Pure and deterministic —
 * no model call, no I/O.
 */
export function indexOntologyAnchors(
  ontology: DomainOntology | null | undefined,
): OntologyEntityAnchorIndex {
  const anchors = new Map<string, OntologyEntityAnchorEntry>();
  const totals: Record<OntologyEntityAnchorKind, number> = {
    action: 0,
    event: 0,
    object: 0,
    rule: 0,
    link: 0,
  };
  const unanchoredCounts: Record<OntologyEntityAnchorKind, number> = {
    action: 0,
    event: 0,
    object: 0,
    rule: 0,
    link: 0,
  };
  const collisions = new Map<string, OntologyEntityAnchorKind[]>();

  const add = (kind: OntologyEntityAnchorKind, id: string | null, entity: never): void => {
    totals[kind] += 1;
    if (!id) {
      unanchoredCounts[kind] += 1;
      return;
    }
    const existing = anchors.get(id);
    if (existing) {
      const kinds = collisions.get(id) ?? [existing.kind];
      kinds.push(kind);
      collisions.set(id, kinds);
      return;
    }
    anchors.set(id, { kind, digest: ontologyEntityDigest(kind, entity) });
  };

  for (const object of ontology?.objects ?? []) {
    add("object", declaredText(object.id) ?? declaredText(object.name), object as never);
  }
  for (const action of ontology?.actions ?? []) {
    add("action", declaredText(action.name) ?? declaredText(action.id), action as never);
  }
  for (const event of ontology?.events ?? []) {
    add("event", declaredText(event.name), event as never);
  }
  for (const rule of ontology?.rules ?? []) {
    add("rule", declaredRuleAnchorId(rule), rule as never);
  }
  for (const link of ontology?.links ?? []) {
    add("link", declaredText(link.id), link as never);
  }

  // Link endpoints are resolved AFTER every entity anchor exists, so ordering
  // cannot make a real endpoint look unresolved.
  let linkEndpointsTotal = 0;
  let unresolvedLinkEndpoints = 0;
  for (const link of ontology?.links ?? []) {
    for (const endpoint of [link.from, link.to]) {
      linkEndpointsTotal += 1;
      const id = declaredText(endpoint?.id);
      if (!id || !anchors.has(id)) unresolvedLinkEndpoints += 1;
    }
  }

  return {
    anchors,
    totals,
    anchorsTotal: ONTOLOGY_ENTITY_ANCHOR_KINDS.reduce((sum, kind) => sum + totals[kind], 0),
    unanchored: ONTOLOGY_ENTITY_ANCHOR_KINDS.filter((kind) => unanchoredCounts[kind] > 0).map(
      (kind) => ({ kind, count: unanchoredCounts[kind] }),
    ),
    unresolvedLinkEndpoints,
    linkEndpointsTotal,
    collisions: [...collisions.entries()].map(([id, kinds]) => ({ id, kinds })),
  };
}
