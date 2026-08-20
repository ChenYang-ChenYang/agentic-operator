// Deterministic, DOMAIN-NEUTRAL aggregates over a DomainOntology.
//
// These are the only rows an analysis chart is allowed to carry: the server
// computes every number from the authoritative Ontology, and the model merely
// chooses WHICH aggregate to show and HOW to present it. Nothing here contains
// business vocabulary — labels come from the data, never from this module.
//
// Honesty rules:
//   · every list is capped by ONE named, env-overridable constant;
//   · `total` is always the full pre-cap row count and `truncated` self-reports;
//   · an undeclared category/type/level is reported as "(未声明)" — the ontology
//     did not say, so this module does not say it for it (never defaulted).

import type { DomainOntology, OntologyEvent } from "./ontology-types";

/** Env var that overrides the per-aggregate row cap. */
export const ONTOLOGY_ANALYSIS_AGGREGATE_ROW_CAP_ENV =
  "ONTOLOGY_ANALYSIS_AGGREGATE_ROW_CAP";
/** Default row cap. Matches the chart contract's maximum row count so an
 * un-truncated aggregate is always chartable as-is. */
export const ONTOLOGY_ANALYSIS_AGGREGATE_ROW_CAP_DEFAULT = 40;

export function ontologyAnalysisAggregateRowCap(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env[ONTOLOGY_ANALYSIS_AGGREGATE_ROW_CAP_ENV]);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : ONTOLOGY_ANALYSIS_AGGREGATE_ROW_CAP_DEFAULT;
}

export interface OntologyAggregateRow {
  label: string;
  value: number;
}

export interface OntologyAggregateResult {
  aggregate: string;
  rows: OntologyAggregateRow[];
  /** Full pre-cap row count; rows.length < total ⇔ truncated. */
  total: number;
  truncated: boolean;
}

/** The label used when the ontology declares nothing. Reported as state —
 * never silently folded into a real category. */
const UNDECLARED_LABEL = "(未声明)";

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * A rule's declared enforcement level, reading EVERY spelling the sibling
 * readers accept — the exact precedence of `ruleEnforcementTag` in
 * specialists.ts (measured on live Allmeta: enforcement 0/66 · severity 0/66 ·
 * enforcementLevel 54/66), plus the snake_case `enforcement_level` fallback
 * that readiness reads. Reading only camelCase here made a snake_case corpus
 * chart as all-"(未声明)" while the narrative reported declared levels — the
 * chart contradicting the prose on the SAME ontology. `null` still means the
 * rule genuinely declares no level; it is never defaulted.
 */
export function ruleEnforcementLevelValue(
  rule: Record<string, unknown>,
): string | null {
  const level =
    rule.enforcement ??
    rule.severity ??
    rule.enforcementLevel ??
    rule.enforcement_level;
  if (typeof level === "string") return level.trim() || null;
  if (typeof level === "number" && Number.isFinite(level)) {
    return String(level);
  }
  return null;
}

function eventPayload(event: OntologyEvent): OntologyEvent["payload"] {
  return event.payload && typeof event.payload === "object"
    ? event.payload
    : { source_action: null, event_data: [], state_mutations: [] };
}

/** value desc, then label asc — deterministic and locale-independent. */
function sortRows(rows: OntologyAggregateRow[]): OntologyAggregateRow[] {
  return [...rows].sort(
    (a, b) =>
      b.value - a.value ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

function countRows(counts: Map<string, number>): OntologyAggregateRow[] {
  return sortRows(
    [...counts.entries()].map(([label, value]) => ({ label, value })),
  );
}

/**
 * Producer/consumer topology is declared on BOTH sides (an event's
 * producers/consumers arrays + payload.source_action, and an action's
 * triggered_event/trigger arrays). The aggregate takes the union and counts
 * DISTINCT events per action so a doubly-declared edge is never counted twice.
 */
function eventsPerAction(
  ontology: DomainOntology,
  side: "producer" | "consumer",
): OntologyAggregateRow[] {
  const perAction = new Map<string, Set<string>>();
  const add = (action: string | null, event: string | null) => {
    if (!action || !event) return;
    const set = perAction.get(action) ?? new Set<string>();
    set.add(event);
    perAction.set(action, set);
  };
  // Every declared action appears, including honest zeroes.
  for (const action of ontology.actions ?? []) {
    const name = textValue(action.name) ?? textValue(action.id);
    if (name && !perAction.has(name)) perAction.set(name, new Set());
  }
  for (const action of ontology.actions ?? []) {
    const name = textValue(action.name) ?? textValue(action.id);
    const declared =
      side === "producer"
        ? (action.triggered_event ?? [])
        : (action.trigger ?? []);
    for (const event of declared) add(name, textValue(event));
  }
  for (const event of ontology.events ?? []) {
    const eventName = textValue(event.name);
    const payload = eventPayload(event);
    const declared =
      side === "producer"
        ? [...(event.producers ?? []), payload.source_action]
        : [...(event.consumers ?? [])];
    for (const actionName of declared) add(textValue(actionName), eventName);
  }
  return sortRows(
    [...perAction.entries()].map(([label, set]) => ({
      label,
      value: set.size,
    })),
  );
}

interface AggregateDefinition {
  name: string;
  /** Model-visible; must stay domain-neutral. */
  description: string;
  compute(ontology: DomainOntology): OntologyAggregateRow[];
}

const AGGREGATE_DEFINITIONS: AggregateDefinition[] = [
  {
    name: "events_per_producer_action",
    description:
      "每个动作产出多少个不同事件（合并事件侧 producers/source_action 与动作侧 triggered_event 的声明，去重计数；不产出事件的动作以 0 出现）。",
    compute: (ontology) => eventsPerAction(ontology, "producer"),
  },
  {
    name: "events_per_consumer_action",
    description:
      "每个动作消费多少个不同事件（合并事件侧 consumers 与动作侧 trigger 的声明，去重计数；不消费事件的动作以 0 出现）。",
    compute: (ontology) => eventsPerAction(ontology, "consumer"),
  },
  {
    name: "actions_by_category",
    description:
      "按声明的 category 统计动作数量；未声明 category 的动作归入「(未声明)」，不猜分类。",
    compute: (ontology) => {
      const counts = new Map<string, number>();
      for (const action of ontology.actions ?? []) {
        const label = textValue(action.category) ?? UNDECLARED_LABEL;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return countRows(counts);
    },
  },
  {
    name: "objects_by_type",
    description:
      "按声明的 type 统计对象数量；未声明 type 的对象归入「(未声明)」。",
    compute: (ontology) => {
      const counts = new Map<string, number>();
      for (const object of ontology.objects ?? []) {
        const label = textValue(object.type) ?? UNDECLARED_LABEL;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return countRows(counts);
    },
  },
  {
    name: "rules_by_enforcement_level",
    description:
      "按声明的强制级别统计规则数量（接受 enforcement / severity / enforcementLevel / enforcement_level 任一拼写）；未声明的规则归入「(未声明)」，绝不默认成 warn 或任何级别。",
    compute: (ontology) => {
      const counts = new Map<string, number>();
      for (const rule of ontology.rules ?? []) {
        const record = rule as Record<string, unknown>;
        const label = ruleEnforcementLevelValue(record) ?? UNDECLARED_LABEL;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return countRows(counts);
    },
  },
  {
    name: "event_payload_field_counts",
    description:
      "每个事件的 payload 字段（event_data）数量；没有字段的事件以 0 出现。",
    compute: (ontology) => {
      const rows: OntologyAggregateRow[] = [];
      for (const event of ontology.events ?? []) {
        const label = textValue(event.name);
        if (!label) continue;
        rows.push({
          label,
          value: eventPayload(event).event_data?.length ?? 0,
        });
      }
      return sortRows(rows);
    },
  },
];

const AGGREGATES_BY_NAME = new Map(
  AGGREGATE_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export function listAnalysisAggregates(): Array<{
  name: string;
  description: string;
}> {
  return AGGREGATE_DEFINITIONS.map(({ name, description }) => ({
    name,
    description,
  }));
}

export function computeAnalysisAggregate(
  ontology: DomainOntology,
  name: string,
  env: Record<string, string | undefined> = process.env,
): OntologyAggregateResult {
  const definition = AGGREGATES_BY_NAME.get(name);
  if (!definition) {
    throw new Error(
      `Unknown analysis aggregate "${name}". Valid aggregates: ${AGGREGATE_DEFINITIONS.map(
        (entry) => entry.name,
      ).join(", ")}`,
    );
  }
  const cap = ontologyAnalysisAggregateRowCap(env);
  const rows = definition.compute(ontology);
  return {
    aggregate: definition.name,
    rows: rows.slice(0, cap),
    total: rows.length,
    truncated: rows.length > cap,
  };
}
