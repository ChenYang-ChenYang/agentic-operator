/**
 * Turning a run's payload into something a person can decide on.
 *
 * A generated manual step asks for the identifiers the downstream ERP write
 * needs — alert_id, chain_id, option_id, option_type. Nobody can type those
 * from memory, and nothing was filling them in, so the form was unanswerable
 * even though every value was sitting in the run's own payload one step
 * upstream. Worse, the panel showed no business context at all: an approver
 * was asked to approve or reject with no idea which stage slipped, by how long,
 * or why.
 *
 * Both are fixed from the same source — the task's `preparedContext` (what the
 * earlier manual steps decided) and the run's trigger payload (what the agents
 * found). This module reads those, and is deliberately tenant-agnostic: it
 * matches on the shape of the data and on the form's own field names, never on
 * business field names, so it works the same for any compiled ontology.
 */

/**
 * Keys the platform stamps onto every event envelope. They are runtime
 * plumbing — correlation ids, the emitting agent, the raw previous result —
 * not something an approver should be reading, so they never become facts.
 */
const ENVELOPE_KEYS = new Set([
  "_meta",
  "_parallel_tool_calls",
  "event_id",
  "event_name",
  "event_type",
  "request_id",
  "source_agent",
  "source_run",
  "subject",
  "last_result",
  "identifier_discipline",
  "queried_operations",
  "query_rounds_used",
]);

/** How deep to walk nested objects looking for a prefill value. */
const MAX_PREFILL_DEPTH = 4;
/** A value longer than this is context to read, not a field value to fill. */
const MAX_PREFILL_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Scalars only: an id or an enum, never an object dumped into a text input. */
function scalarString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_PREFILL_LENGTH ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Find a scalar for `field` anywhere in `source`, nearest match first.
 *
 * Breadth-first on purpose: `alert_context.chain_id` and
 * `execution_deviation[0].chain_id` hold the same id, and the shallower one is
 * the more canonical place to have found it.
 */
function findScalar(source: unknown, field: string): string | null {
  let frontier: unknown[] = [source];
  for (let depth = 0; depth <= MAX_PREFILL_DEPTH; depth += 1) {
    const next: unknown[] = [];
    for (const node of frontier) {
      if (Array.isArray(node)) {
        next.push(...node);
        continue;
      }
      if (!isRecord(node)) continue;
      if (field in node) {
        const hit = scalarString(node[field]);
        if (hit !== null) return hit;
      }
      for (const [key, value] of Object.entries(node)) {
        if (ENVELOPE_KEYS.has(key)) continue;
        if (isRecord(value) || Array.isArray(value)) next.push(value);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return null;
}

/**
 * Values to seed the form with, keyed by field name.
 *
 * `sources` are consulted in order, so a decision an earlier manual step
 * already recorded wins over the same key found in the raw run payload.
 * Returns only what it actually found — the caller layers this over the
 * schema's own defaults rather than blanking anything.
 */
export function prefillFromContext(
  fieldNames: readonly string[],
  sources: readonly unknown[],
): Record<string, string> {
  const filled: Record<string, string> = {};
  for (const field of fieldNames) {
    for (const source of sources) {
      const hit = findScalar(source, field);
      if (hit !== null) {
        filled[field] = hit;
        break;
      }
    }
  }
  return filled;
}

export interface ContextFact {
  key: string;
  value: string;
}

export interface ContextGroup {
  /** Stable React key and the group's source path. */
  key: string;
  title: string;
  facts: ContextFact[];
  /**
   * True when this record is part of the decision rather than the evidence
   * behind it — the panel opens these and collapses the rest.
   */
  relevant: boolean;
  /**
   * True when this is one of several sibling records from the same list — the
   * alternatives being chosen between, rather than context around the choice.
   */
  alternatives: boolean;
}

/** Longest a single fact renders before the panel clips it. */
const MAX_FACT_LENGTH = 400;

/** One line for a leaf value; null for anything that is not worth a row. */
export function formatContextValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_FACT_LENGTH
      ? `${trimmed.slice(0, MAX_FACT_LENGTH)}…`
      : trimmed;
  }
  if (Array.isArray(value)) {
    const scalars = value.map(formatContextValue).filter(Boolean);
    return scalars.length === value.length && scalars.length > 0
      ? scalars.join("、")
      : null;
  }
  return null;
}

function factsOf(record: Record<string, unknown>): ContextFact[] {
  const facts: ContextFact[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    const rendered = formatContextValue(value);
    if (rendered !== null) facts.push({ key, value: rendered });
  }
  return facts;
}

/**
 * A list this short is the decision itself — the options on the table, the one
 * deviation being handled. A longer one is reference data: seven per-stage
 * progress rows are evidence, not the question.
 */
const DECISION_LIST_MAX = 3;
/** However relevant they look, this many cards is already a wall. */
const MAX_RELEVANT_GROUPS = 8;

/**
 * Break a run payload into readable groups: nested records become their own
 * cards, and whatever scalars sit at the top level become one more.
 *
 * Promotion is by SHAPE alone, which keeps this honest for any compiled
 * ontology. Matching the form's own field names looked like a useful second
 * signal and is not: on a real procurement payload `chain_id` is both a
 * required form field and present in fourteen of eighteen records, so it
 * promotes everything — including the seven per-stage rows it exists to demote.
 * A key that identifies everything discriminates nothing.
 */
export function contextGroups(payload: unknown): ContextGroup[] {
  if (!isRecord(payload)) return [];
  const groups: ContextGroup[] = [];
  const topLevel: ContextFact[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    if (isRecord(value)) {
      const facts = factsOf(value);
      if (facts.length > 0) {
        groups.push({ key, title: key, facts, relevant: true, alternatives: false });
      }
      continue;
    }
    if (Array.isArray(value)) {
      // A list of scalars reads better as one line than as N cards.
      const inline = formatContextValue(value);
      if (inline !== null) {
        topLevel.push({ key, value: inline });
        continue;
      }
      const decisionSized = value.length <= DECISION_LIST_MAX;
      // Two or three sibling records are alternatives — the set being chosen
      // between. A single record, however short its list, is just context.
      const alternatives = decisionSized && value.length > 1;
      value.forEach((item, index) => {
        if (!isRecord(item)) return;
        const facts = factsOf(item);
        if (facts.length === 0) return;
        groups.push({
          key: `${key}[${index}]`,
          title: value.length > 1 ? `${key} #${index + 1}` : key,
          facts,
          relevant: decisionSized,
          alternatives,
        });
      });
      continue;
    }
    const rendered = formatContextValue(value);
    if (rendered !== null) topLevel.push({ key, value: rendered });
  }

  if (topLevel.length > 0) {
    groups.push({
      key: "__root__",
      title: "",
      facts: topLevel,
      relevant: true,
      alternatives: false,
    });
  }

  // Alternatives lead. A payload's key order is an accident of how the agent
  // happened to write its JSON, and on a real approval it put the three options
  // sixth, seventh and eighth of eight cards — so the one thing the approver is
  // actually choosing between was the last thing they'd find.
  const promoted = [
    ...groups.filter((group) => group.relevant && group.alternatives),
    ...groups.filter((group) => group.relevant && !group.alternatives),
  ];
  const kept = promoted.slice(0, MAX_RELEVANT_GROUPS);
  const demoted = new Set(promoted.slice(MAX_RELEVANT_GROUPS));
  return [
    ...kept,
    ...groups
      .filter((group) => !group.relevant || demoted.has(group))
      .map((group) => (group.relevant ? { ...group, relevant: false } : group)),
  ];
}
