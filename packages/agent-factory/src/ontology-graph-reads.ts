// Deterministic, DOMAIN-NEUTRAL READ derivations over a DomainOntology.
//
// These are the reads the analysis loop could not perform. The gap they close
// is the one this repo already named once and then reproduced one layer up:
// `read_ontology` handed the model `links: <count>` — a compiled relationship
// graph fetched and discarded before anyone reasoned over it. The inquiry loop
// did the same: the seed prompt announced「关系边 N」and no tool could read a
// single edge. Same for `workflow`, and rules had no whole-text read at all.
//
// Discipline, identical to ontology-aggregates.ts / ontology-tables.ts:
//   · nothing here inspects a business value — only ontology structure
//     (objects / actions / events / rules / links / workflow);
//   · every bounded list reports its PRE-cap total and self-reports truncation.
//     A read that quietly shortens its answer is worse than no read at all,
//     because the model cannot tell a complete answer from a cut one;
//   · a reference that resolves to NO ontology entity is counted and named, not
//     dropped. The link endpoints are authored elsewhere and this module does
//     not assume they all land — nor that they all even carry an id: an
//     endpoint with nothing addressable in it is its own reported category
//     rather than a silent third outcome between resolved and unresolved;
//   · a completeness COUNT is taken before the page cap. Counting after it
//     would make the same graph answer differently depending on where the page
//     boundary fell, and answer "0 dangling endpoints" whenever they all sat
//     past the cap. Only the id LISTS are bounded, each with its own pre-cap
//     total beside it;
//   · a rule with no declared id is addressed by ORDINAL and says so. An
//     ordinal is a position in one export, not an identity — presenting it as
//     an id would make a cross-version claim this module cannot support.
//
// Everything here is a pure function of the ontology it is handed: the caller
// owns the caps (the inquiry loop reads them from env), so this module has no
// hidden configuration and no ambient state.

import { ruleEnforcementLevelValue } from "./ontology-aggregates";
import {
  actionEventSides,
  actionKey,
  objectKey,
  stepRuleRefs,
} from "./ontology-tables";
import type {
  DomainOntology,
  OntologyAction,
  OntologyEvent,
  OntologyLink,
} from "./ontology-types";

/** Default number of relationship edges one read returns. */
export const ONTOLOGY_LINK_READ_CAP_DEFAULT = 60;
/** Default number of ids one bounded id list returns. */
export const ONTOLOGY_ID_LIST_CAP_DEFAULT = 40;
/** Default number of workflow entries one listing returns. */
export const ONTOLOGY_WORKFLOW_LIST_CAP_DEFAULT = 60;
/** Default number of addressable ids offered back after a miss. */
export const ONTOLOGY_AVAILABLE_CAP_DEFAULT = 200;
/** Default number of field names summarised for one workflow entry. */
export const ONTOLOGY_WORKFLOW_FIELD_CAP_DEFAULT = 60;
/** Hard ceiling on anchored traversal depth. A deeper walk is refused with the
 * effective depth reported, never silently performed at another distance. */
export const ONTOLOGY_LINK_MAX_DEPTH = 5;

export type OntologyEntityKind = "object" | "action" | "event" | "rule";

/** A bounded list of ids that always carries the pre-cap truth. */
export interface OntologyBoundedIds {
  ids: string[];
  total: number;
  truncated: boolean;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Codepoint order — deterministic and locale-independent. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundedIds(values: Iterable<string>, cap: number): OntologyBoundedIds {
  const all = [...new Set(values)].sort(compareText);
  const limit = Math.max(0, cap);
  return {
    ids: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
  };
}

function eventPayload(event: OntologyEvent): OntologyEvent["payload"] {
  return event.payload && typeof event.payload === "object"
    ? event.payload
    : { source_action: null, event_data: [], state_mutations: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Every addressable id in the ontology mapped to the kind that declared it.
 *
 * Both the id and the display name are indexed, because both appear as
 * references elsewhere (an event's `target_object`, a link endpoint). The FIRST
 * declaring kind wins so the mapping is a function of the ontology and not of
 * iteration luck.
 */
export function indexOntologyEntityKinds(
  ontology: DomainOntology,
): Map<string, OntologyEntityKind> {
  const index = new Map<string, OntologyEntityKind>();
  const put = (id: string | null, kind: OntologyEntityKind) => {
    if (!id || index.has(id)) return;
    index.set(id, kind);
  };
  for (const object of ontology.objects ?? []) {
    put(textValue(object.id), "object");
    put(textValue(object.name), "object");
  }
  for (const action of ontology.actions ?? []) {
    put(textValue(action.name), "action");
    put(textValue(action.id), "action");
  }
  for (const event of ontology.events ?? []) {
    put(textValue(event.name), "event");
  }
  for (const address of ontologyRuleAddresses(ontology)) {
    if (address.declared) put(address.id, "rule");
  }
  return index;
}

// ── rules ────────────────────────────────────────────────────────────────────

/** How one rule is addressed, and whether that address was DECLARED. */
export interface OntologyRuleAddress {
  id: string;
  /** false ⇒ `id` is the ordinal fallback, which is unstable across versions. */
  declared: boolean;
  /** 0-based position in the ontology's rule list. */
  index: number;
}

/**
 * The ONE rule-addressing rule, shared by every consumer.
 *
 * The seed prompt already advertised `rule:<n>` for a rule that declares no id;
 * a reader that generated its own scheme would advertise one address and answer
 * to another. So this is the single site, and it reports `declared` so callers
 * can say out loud which of the two happened.
 */
export function ontologyRuleAddress(
  rule: Record<string, unknown>,
  index: number,
): OntologyRuleAddress {
  const declaredId =
    textValue(rule.id) ?? textValue(rule.rule_id) ?? textValue(rule.name);
  return declaredId
    ? { id: declaredId, declared: true, index }
    : { id: `rule:${index + 1}`, declared: false, index };
}

export function ontologyRuleAddresses(
  ontology: DomainOntology,
): OntologyRuleAddress[] {
  return (ontology.rules ?? []).map((rule, index) =>
    ontologyRuleAddress((asRecord(rule) ?? {}) as Record<string, unknown>, index),
  );
}

/** Rule ids referenced through `action_steps[].rules[]`, by referencing action. */
function ruleBindings(ontology: DomainOntology): Map<string, Set<string>> {
  const boundBy = new Map<string, Set<string>>();
  for (const action of ontology.actions ?? []) {
    const name = actionKey(action);
    if (!name) continue;
    for (const ref of stepRuleRefs(action)) {
      const set = boundBy.get(ref) ?? new Set<string>();
      set.add(name);
      boundBy.set(ref, set);
    }
  }
  return boundBy;
}

export interface OntologyRuleMatch {
  index: number;
  /** null ⇒ this rule declares no id; it was reached by ordinal. */
  declaredId: string | null;
  /** null ⇒ the rule declares no enforcement level. Never defaulted. */
  enforcementLevel: string | null;
  /** The whole rule record, verbatim. */
  rule: Record<string, unknown>;
  boundActions: string[];
  boundActionsTotal: number;
  boundActionsTruncated: boolean;
}

export interface OntologyRuleReadResult {
  found: boolean;
  /** How the reference was resolved — null when nothing matched. */
  addressedBy: "declared_id" | "ordinal" | null;
  matches: OntologyRuleMatch[];
  /** Real number of rules the reference matched, before any cap. */
  matchTotal: number;
  matchTruncated: boolean;
  /** How many rules the ontology declares. Reported alongside `available`
   * because distinct ADDRESSES and RULES are not the same number when two
   * rules declare the same id — quoting either one alone would mislead. */
  rulesTotal: number;
  /** Present only on a miss: what CAN be addressed. */
  available?: OntologyBoundedIds;
}

const ORDINAL_RE = /^(?:rule:)?(\d+)$/u;

export function readOntologyRule(
  ontology: DomainOntology,
  reference: string,
  opts: { idCap?: number; matchCap?: number; availableCap?: number } = {},
): OntologyRuleReadResult {
  const idCap = opts.idCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const matchCap = opts.matchCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const availableCap = opts.availableCap ?? ONTOLOGY_AVAILABLE_CAP_DEFAULT;
  const rules = (ontology.rules ?? []).map(
    (rule) => (asRecord(rule) ?? {}) as Record<string, unknown>,
  );
  const addresses = rules.map((rule, index) => ontologyRuleAddress(rule, index));
  const boundBy = ruleBindings(ontology);
  const ref = reference.trim();

  const toMatch = (index: number): OntologyRuleMatch => {
    const address = addresses[index]!;
    const bound = address.declared
      ? boundedIds(boundBy.get(address.id) ?? [], idCap)
      : { ids: [], total: 0, truncated: false };
    return {
      index,
      declaredId: address.declared ? address.id : null,
      enforcementLevel: ruleEnforcementLevelValue(rules[index]!),
      rule: rules[index]!,
      boundActions: bound.ids,
      boundActionsTotal: bound.total,
      boundActionsTruncated: bound.truncated,
    };
  };

  // A DECLARED id always wins over an ordinal reading of the same text.
  const declaredHits = addresses
    .filter((address) => address.declared && address.id === ref)
    .map((address) => address.index);
  if (declaredHits.length > 0) {
    return {
      found: true,
      addressedBy: "declared_id",
      matches: declaredHits.slice(0, Math.max(0, matchCap)).map(toMatch),
      matchTotal: declaredHits.length,
      matchTruncated: declaredHits.length > Math.max(0, matchCap),
      rulesTotal: rules.length,
    };
  }

  const ordinal = ORDINAL_RE.exec(ref);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (index >= 0 && index < rules.length) {
      return {
        found: true,
        addressedBy: "ordinal",
        matches: [toMatch(index)],
        matchTotal: 1,
        matchTruncated: false,
        rulesTotal: rules.length,
      };
    }
  }

  return {
    found: false,
    addressedBy: null,
    matches: [],
    matchTotal: 0,
    matchTruncated: false,
    rulesTotal: rules.length,
    available: boundedIds(
      addresses.map((address) => address.id),
      availableCap,
    ),
  };
}

// ── links ────────────────────────────────────────────────────────────────────

export interface OntologyLinkEndpointRead {
  type: string;
  /** "" ⇒ the endpoint declared no readable id; see `addressable`. */
  id: string;
  /** false ⇒ this endpoint names nothing in this ontology. Counted, not hidden. */
  resolved: boolean;
  /** false ⇒ this endpoint is not a `{ id }` record at all (a bare string, an
   *  object without `id`, an absent side), so there is no id to resolve. It is
   *  a THIRD state, counted separately: reading a bare string as an id would
   *  invent a contract the export never declared, and dropping it silently is
   *  how a structural hole hides itself. */
  addressable: boolean;
}

export interface OntologyLinkRead {
  id: string;
  kind: string;
  from: OntologyLinkEndpointRead;
  to: OntologyLinkEndpointRead;
  status?: string;
}

export interface OntologyLinksReadResult {
  /** false ⇒ the ontology never declared a link collection at all. Distinct
   * from a declared-but-empty one, and the difference is the difference between
   * "this domain has no relationship graph" and "this export predates it". */
  linksDeclared: boolean;
  totalInOntology: number;
  /** Edges matching the filter, before the cap. */
  matched: number;
  truncated: boolean;
  links: OntologyLinkRead[];
  /** Endpoint OCCURRENCES that resolve to nothing, over every MATCHED edge —
   * counted BEFORE the page cap. Counting over the returned page instead would
   * make the same graph report a different number depending on where the page
   * boundary fell, and report zero whenever every dangling endpoint sat past
   * the cap. The cap trims the id LIST below; it never trims this number. */
  unresolvedEndpoints: number;
  /** The distinct ids behind that count, bounded like every other id list. */
  unresolvedEndpointIds: string[];
  /** Distinct unresolved ids before `unresolvedEndpointIds` was capped. */
  unresolvedEndpointIdsTotal: number;
  unresolvedEndpointIdsTruncated: boolean;
  /** Endpoint OCCURRENCES over every MATCHED edge that carry no readable id at
   * all. Same pre-cap discipline as `unresolvedEndpoints`. */
  unaddressableEndpoints: number;
  /** The ids of the EDGES carrying them (the endpoint itself has no id to
   * name), bounded, with the pre-cap total beside it. */
  unaddressableEndpointLinkIds: string[];
  unaddressableEndpointLinkIdsTotal: number;
  unaddressableEndpointLinkIdsTruncated: boolean;
  /** Every edge kind present in the WHOLE graph (not just the filtered slice). */
  kinds: OntologyBoundedIds;
  anchor?: {
    id: string;
    /** null ⇒ the anchor names no entity in this ontology. */
    resolvedAs: OntologyEntityKind | null;
    /** The depth actually walked. */
    depth: number;
    /** Present only when the requested depth was above the ceiling. */
    depthRequested?: number;
    reached: string[];
    reachedTotal: number;
    reachedTruncated: boolean;
  };
}

function linkEndpoint(
  raw: unknown,
  index: Map<string, OntologyEntityKind>,
): OntologyLinkEndpointRead {
  const record = asRecord(raw);
  const id = textValue(record?.id) ?? "";
  const addressable = id.length > 0;
  return {
    type: textValue(record?.type) ?? "",
    id,
    resolved: addressable && index.has(id),
    addressable,
  };
}

export function readOntologyLinks(
  ontology: DomainOntology,
  opts: {
    anchor?: string;
    kind?: string;
    depth?: number;
    cap?: number;
    kindCap?: number;
    reachedCap?: number;
    /** Cap on the two completeness id lists. Their COUNTS are never capped. */
    unresolvedCap?: number;
  },
): OntologyLinksReadResult {
  const cap = opts.cap ?? ONTOLOGY_LINK_READ_CAP_DEFAULT;
  const kindCap = opts.kindCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const reachedCap = opts.reachedCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const unresolvedCap = opts.unresolvedCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const linksDeclared = Array.isArray(ontology.links);
  const links: OntologyLink[] = ontology.links ?? [];
  const index = indexOntologyEntityKinds(ontology);
  const kindFilter = textValue(opts.kind);

  const decorated = links
    .map((link, position) => {
      const record = link as unknown as Record<string, unknown>;
      return {
        read: {
          id: textValue(record.id) ?? `link:${position + 1}`,
          kind: textValue(record.kind) ?? "",
          from: linkEndpoint(record.from, index),
          to: linkEndpoint(record.to, index),
          ...(textValue(record.status) ? { status: textValue(record.status)! } : {}),
        } satisfies OntologyLinkRead,
      };
    })
    .sort((a, b) => compareText(a.read.id, b.read.id));

  const kinds = boundedIds(
    decorated.map((entry) => entry.read.kind).filter((kind) => kind.length > 0),
    kindCap,
  );

  const kindMatches = (link: OntologyLinkRead) =>
    !kindFilter || link.kind === kindFilter;

  const anchorId = textValue(opts.anchor);
  let selected: OntologyLinkRead[];
  let anchorReport: OntologyLinksReadResult["anchor"];

  if (anchorId) {
    const requestedDepth = Math.max(1, Math.floor(opts.depth ?? 1));
    const depth = Math.min(requestedDepth, ONTOLOGY_LINK_MAX_DEPTH);
    let frontier = new Set<string>([anchorId]);
    const visited = new Set<string>([anchorId]);
    const chosen = new Map<string, OntologyLinkRead>();
    for (let step = 0; step < depth && frontier.size > 0; step += 1) {
      const next = new Set<string>();
      for (const entry of decorated) {
        const link = entry.read;
        if (!kindMatches(link)) continue;
        const touchesFrom = frontier.has(link.from.id);
        const touchesTo = frontier.has(link.to.id);
        if (!touchesFrom && !touchesTo) continue;
        chosen.set(link.id, link);
        for (const id of [link.from.id, link.to.id]) {
          if (!id || visited.has(id)) continue;
          visited.add(id);
          next.add(id);
        }
      }
      frontier = next;
    }
    const reached = boundedIds(
      [...visited].filter((id) => id !== anchorId),
      reachedCap,
    );
    selected = [...chosen.values()].sort((a, b) => compareText(a.id, b.id));
    anchorReport = {
      id: anchorId,
      resolvedAs: index.get(anchorId) ?? null,
      depth,
      ...(requestedDepth > depth ? { depthRequested: requestedDepth } : {}),
      reached: reached.ids,
      reachedTotal: reached.total,
      reachedTruncated: reached.truncated,
    };
  } else {
    selected = decorated.map((entry) => entry.read).filter(kindMatches);
  }

  const limit = Math.max(0, cap);
  const shown = selected.slice(0, limit);
  // Counted over `selected` (every matched edge), NOT over `shown`: the page
  // cap decides how much is quoted back, never how much is true.
  const unresolved: string[] = [];
  const unaddressableLinkIds: string[] = [];
  let unresolvedEndpoints = 0;
  let unaddressableEndpoints = 0;
  for (const link of selected) {
    for (const endpoint of [link.from, link.to]) {
      if (!endpoint.addressable) {
        unaddressableEndpoints += 1;
        unaddressableLinkIds.push(link.id);
        continue;
      }
      if (endpoint.resolved) continue;
      unresolvedEndpoints += 1;
      unresolved.push(endpoint.id);
    }
  }
  const unresolvedIds = boundedIds(unresolved, unresolvedCap);
  const unaddressableIds = boundedIds(unaddressableLinkIds, unresolvedCap);

  return {
    linksDeclared,
    totalInOntology: links.length,
    matched: selected.length,
    truncated: selected.length > limit,
    links: shown,
    unresolvedEndpoints,
    unresolvedEndpointIds: unresolvedIds.ids,
    unresolvedEndpointIdsTotal: unresolvedIds.total,
    unresolvedEndpointIdsTruncated: unresolvedIds.truncated,
    unaddressableEndpoints,
    unaddressableEndpointLinkIds: unaddressableIds.ids,
    unaddressableEndpointLinkIdsTotal: unaddressableIds.total,
    unaddressableEndpointLinkIdsTruncated: unaddressableIds.truncated,
    kinds,
    ...(anchorReport ? { anchor: anchorReport } : {}),
  };
}

// ── workflow ─────────────────────────────────────────────────────────────────

export interface OntologyWorkflowEntrySummary {
  index: number;
  /** null ⇒ the entry declares no such field. Never inferred. */
  id: string | null;
  name: string | null;
  fields: string[];
  fieldsTotal: number;
  fieldsTruncated: boolean;
}

export interface OntologyWorkflowReadResult {
  found: boolean;
  total: number;
  items?: OntologyWorkflowEntrySummary[];
  shown?: number;
  truncated?: boolean;
  item?: { index: number; value: Record<string, unknown> };
  outOfRange?: { requested: number; total: number };
}

export function readOntologyWorkflow(
  ontology: DomainOntology,
  opts: { index?: number; cap?: number; fieldCap?: number },
): OntologyWorkflowReadResult {
  const cap = opts.cap ?? ONTOLOGY_WORKFLOW_LIST_CAP_DEFAULT;
  const fieldCap = opts.fieldCap ?? ONTOLOGY_WORKFLOW_FIELD_CAP_DEFAULT;
  const entries = ontology.workflow ?? [];
  const total = entries.length;

  if (opts.index !== undefined) {
    const index = Math.floor(opts.index);
    if (!Number.isFinite(index) || index < 0 || index >= total) {
      return { found: false, total, outOfRange: { requested: opts.index, total } };
    }
    return {
      found: true,
      total,
      item: {
        index,
        value: (asRecord(entries[index]) ?? {}) as Record<string, unknown>,
      },
    };
  }

  const limit = Math.max(0, cap);
  const items = entries.slice(0, limit).map((entry, index) => {
    const record = asRecord(entry);
    const fields = boundedIds(record ? Object.keys(record) : [], fieldCap);
    return {
      index,
      id: textValue(record?.id),
      name: textValue(record?.name),
      fields: fields.ids,
      fieldsTotal: fields.total,
      fieldsTruncated: fields.truncated,
    };
  });
  return {
    found: true,
    total,
    items,
    shown: items.length,
    truncated: total > limit,
  };
}

// ── coverage gaps ────────────────────────────────────────────────────────────

export interface OntologyGapGroup {
  kind: string;
  total: number;
  ids: string[];
  truncated: boolean;
}

export interface OntologyCoverageGapsResult {
  groups: OntologyGapGroup[];
  /** Endpoints that DECLARE an id naming nothing in this ontology. `total` is
   * the distinct-id count; `occurrences` is how many endpoints carried them. */
  unresolvedLinkEndpoints: OntologyBoundedIds & {
    linksDeclared: boolean;
    occurrences: number;
  };
  /** Endpoints that declare no readable id at all, addressed by the id of the
   * EDGE that carries them. Previously invisible in both directions — neither
   * resolved nor unresolved — which is the one thing a completeness report may
   * never do with a structural hole. */
  unaddressableLinkEndpoints: OntologyBoundedIds & {
    linksDeclared: boolean;
    occurrences: number;
  };
}

/**
 * The structural holes a reader can only otherwise infer from zero-valued rows
 * of an aggregate. Every group is a DECLARATION gap: something the ontology
 * does not say. None of them is a verdict about whether the gap is a defect —
 * that is the reader's call, and stating it here would be this module deciding
 * business intent from structure.
 */
export function ontologyCoverageGaps(
  ontology: DomainOntology,
  opts: { idCap?: number },
): OntologyCoverageGapsResult {
  const idCap = opts.idCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const sides = actionEventSides(ontology);
  const producersOf = new Map<string, Set<string>>();
  const consumersOf = new Map<string, Set<string>>();
  for (const [action, entry] of sides) {
    for (const event of entry.emits) {
      const set = producersOf.get(event) ?? new Set<string>();
      set.add(action);
      producersOf.set(event, set);
    }
    for (const event of entry.consumes) {
      const set = consumersOf.get(event) ?? new Set<string>();
      set.add(action);
      consumersOf.set(event, set);
    }
  }

  const eventsWithoutProducer: string[] = [];
  const eventsWithoutConsumer: string[] = [];
  for (const event of ontology.events ?? []) {
    const name = textValue(event.name);
    if (!name) continue;
    if ((producersOf.get(name)?.size ?? 0) === 0) eventsWithoutProducer.push(name);
    if ((consumersOf.get(name)?.size ?? 0) === 0) eventsWithoutConsumer.push(name);
  }

  const actionsWithoutTrigger: string[] = [];
  const actionsWithoutEmit: string[] = [];
  for (const action of ontology.actions ?? []) {
    const name = actionKey(action);
    if (!name) continue;
    const entry = sides.get(name);
    if ((entry?.consumes.size ?? 0) === 0) actionsWithoutTrigger.push(name);
    if ((entry?.emits.size ?? 0) === 0) actionsWithoutEmit.push(name);
  }

  // Everything that names an object anywhere in the graph.
  const referenced = new Set<string>();
  for (const action of ontology.actions ?? []) {
    for (const target of action.target_objects ?? []) {
      const text = textValue(target);
      if (text) referenced.add(text);
    }
  }
  for (const event of ontology.events ?? []) {
    const payload = eventPayload(event);
    for (const field of payload.event_data ?? []) {
      const text = textValue(field.target_object);
      if (text) referenced.add(text);
    }
    for (const mutation of payload.state_mutations ?? []) {
      const text = textValue(mutation.target_object);
      if (text) referenced.add(text);
    }
  }
  for (const object of ontology.objects ?? []) {
    for (const property of object.properties ?? []) {
      const text = textValue(property.references);
      if (text) referenced.add(text);
    }
  }
  for (const link of ontology.links ?? []) {
    const record = link as unknown as Record<string, unknown>;
    for (const raw of [record.from, record.to]) {
      const text = textValue(asRecord(raw)?.id);
      if (text) referenced.add(text);
    }
  }
  const objectsNotReferenced: string[] = [];
  for (const object of ontology.objects ?? []) {
    const key = objectKey(object);
    if (!key) continue;
    const names = [textValue(object.id), textValue(object.name)].filter(
      (value): value is string => value !== null,
    );
    if (!names.some((name) => referenced.has(name))) {
      objectsNotReferenced.push(key);
    }
  }

  const boundBy = ruleBindings(ontology);
  const addresses = ontologyRuleAddresses(ontology);
  const rulesNotBound: string[] = [];
  const rulesWithoutDeclaredId: string[] = [];
  for (const address of addresses) {
    if (!address.declared) {
      rulesWithoutDeclaredId.push(address.id);
      continue;
    }
    if ((boundBy.get(address.id)?.size ?? 0) === 0) rulesNotBound.push(address.id);
  }

  const index = indexOntologyEntityKinds(ontology);
  const unresolvedEndpointIds: string[] = [];
  const unaddressableEndpointLinkIds: string[] = [];
  (ontology.links ?? []).forEach((link, position) => {
    const record = link as unknown as Record<string, unknown>;
    // Same edge addressing as readOntologyLinks, so the two reports name the
    // same edge by the same id.
    const linkId = textValue(record.id) ?? `link:${position + 1}`;
    for (const raw of [record.from, record.to]) {
      const text = textValue(asRecord(raw)?.id);
      if (!text) {
        unaddressableEndpointLinkIds.push(linkId);
        continue;
      }
      if (!index.has(text)) unresolvedEndpointIds.push(text);
    }
  });

  const group = (kind: string, values: string[]): OntologyGapGroup => {
    const bounded = boundedIds(values, idCap);
    return {
      kind,
      total: bounded.total,
      ids: bounded.ids,
      truncated: bounded.truncated,
    };
  };

  return {
    groups: [
      group("events_without_producer", eventsWithoutProducer),
      group("events_without_consumer", eventsWithoutConsumer),
      group("actions_without_trigger", actionsWithoutTrigger),
      group("actions_without_emitted_event", actionsWithoutEmit),
      group("objects_not_referenced", objectsNotReferenced),
      group("rules_not_bound_to_any_action_step", rulesNotBound),
      group("rules_without_declared_id", rulesWithoutDeclaredId),
    ],
    unresolvedLinkEndpoints: {
      ...boundedIds(unresolvedEndpointIds, idCap),
      linksDeclared: Array.isArray(ontology.links),
      occurrences: unresolvedEndpointIds.length,
    },
    unaddressableLinkEndpoints: {
      ...boundedIds(unaddressableEndpointLinkIds, idCap),
      linksDeclared: Array.isArray(ontology.links),
      occurrences: unaddressableEndpointLinkIds.length,
    },
  };
}

// ── action comparison ────────────────────────────────────────────────────────

export interface OntologyActionListDiff {
  field: string;
  onlyInA: OntologyBoundedIds;
  onlyInB: OntologyBoundedIds;
  shared: OntologyBoundedIds;
}

export interface OntologyActionScalarDiff {
  field: string;
  /** null ⇒ undeclared on that side. Never defaulted to the other side's value. */
  a: string | null;
  b: string | null;
  same: boolean;
}

export interface OntologyActionCountDiff {
  field: string;
  a: number;
  b: number;
  same: boolean;
}

export interface OntologyActionDeclaredDiff {
  field: string;
  a: boolean;
  b: boolean;
  same: boolean;
}

export interface OntologyActionComparison {
  found: { a: boolean; b: boolean };
  resolved: { a: string | null; b: string | null };
  listFields: OntologyActionListDiff[];
  scalarFields: OntologyActionScalarDiff[];
  countFields: OntologyActionCountDiff[];
  /** Presence, not content: long prose is not diffed here, it is READ. */
  declaredFields: OntologyActionDeclaredDiff[];
  /** Present only when a side was not found. */
  available?: OntologyBoundedIds;
}

function findAction(
  ontology: DomainOntology,
  reference: string,
): OntologyAction | null {
  const ref = reference.trim();
  return (
    (ontology.actions ?? []).find(
      (action) => action.name === ref || action.id === ref,
    ) ?? null
  );
}

function stringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => textValue(value))
    .filter((value): value is string => value !== null);
}

export function compareOntologyActions(
  ontology: DomainOntology,
  referenceA: string,
  referenceB: string,
  opts: { idCap?: number; availableCap?: number },
): OntologyActionComparison {
  const idCap = opts.idCap ?? ONTOLOGY_ID_LIST_CAP_DEFAULT;
  const availableCap = opts.availableCap ?? ONTOLOGY_AVAILABLE_CAP_DEFAULT;
  const a = findAction(ontology, referenceA);
  const b = findAction(ontology, referenceB);
  const found = { a: a !== null, b: b !== null };
  const resolved = { a: a ? actionKey(a) : null, b: b ? actionKey(b) : null };

  if (!a || !b) {
    return {
      found,
      resolved,
      listFields: [],
      scalarFields: [],
      countFields: [],
      declaredFields: [],
      available: boundedIds(
        (ontology.actions ?? [])
          .map((action) => actionKey(action))
          .filter((value): value is string => value !== null),
        availableCap,
      ),
    };
  }

  const listDiff = (field: string, left: string[], right: string[]) => {
    const setA = new Set(left);
    const setB = new Set(right);
    return {
      field,
      onlyInA: boundedIds([...setA].filter((id) => !setB.has(id)), idCap),
      onlyInB: boundedIds([...setB].filter((id) => !setA.has(id)), idCap),
      shared: boundedIds([...setA].filter((id) => setB.has(id)), idCap),
    };
  };

  const scalarDiff = (
    field: string,
    left: unknown,
    right: unknown,
  ): OntologyActionScalarDiff => {
    const valueA = textValue(left);
    const valueB = textValue(right);
    return { field, a: valueA, b: valueB, same: valueA === valueB };
  };

  const countDiff = (
    field: string,
    left: number,
    right: number,
  ): OntologyActionCountDiff => ({
    field,
    a: left,
    b: right,
    same: left === right,
  });

  const declaredDiff = (
    field: string,
    left: unknown,
    right: unknown,
  ): OntologyActionDeclaredDiff => {
    const hasA = left !== undefined && left !== null;
    const hasB = right !== undefined && right !== null;
    return { field, a: hasA, b: hasB, same: hasA === hasB };
  };

  return {
    found,
    resolved,
    listFields: [
      listDiff("actor", stringList(a.actor), stringList(b.actor)),
      listDiff("trigger", stringList(a.trigger), stringList(b.trigger)),
      listDiff(
        "triggered_event",
        stringList(a.triggered_event),
        stringList(b.triggered_event),
      ),
      listDiff(
        "target_objects",
        stringList(a.target_objects),
        stringList(b.target_objects),
      ),
      listDiff("tool_use", stringList(a.tool_use), stringList(b.tool_use)),
      listDiff("action_step_rules", stepRuleRefs(a), stepRuleRefs(b)),
    ],
    scalarFields: [scalarDiff("category", a.category, b.category)],
    countFields: [
      countDiff("inputs", (a.inputs ?? []).length, (b.inputs ?? []).length),
      countDiff("outputs", (a.outputs ?? []).length, (b.outputs ?? []).length),
      countDiff(
        "action_steps",
        (a.action_steps ?? []).length,
        (b.action_steps ?? []).length,
      ),
    ],
    declaredFields: [
      declaredDiff("instruction", a.instruction, b.instruction),
      declaredDiff(
        "submission_criteria",
        a.submission_criteria,
        b.submission_criteria,
      ),
      declaredDiff("on_success", a.on_success, b.on_success),
      declaredDiff("on_failure", a.on_failure, b.on_failure),
      declaredDiff("side_effects", a.side_effects, b.side_effects),
      declaredDiff("integration", a.integration, b.integration),
    ],
  };
}
