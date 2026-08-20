// Deterministic, DOMAIN-NEUTRAL table derivations over a DomainOntology.
//
// The table analogue of ontology-aggregates.ts, under exactly the same
// discipline: these are the only rows an analysis TABLE is allowed to carry.
// The server computes every cell from the authoritative Ontology; the model
// merely chooses WHICH derivation to show and HOW to title it. Nothing here
// contains business vocabulary — every value comes from the data, and every
// column label is generic ontology vocabulary (object / action / event / rule).
//
// Why tables and not just charts: a chart answers "how many", a table answers
// "which ones, and what do they say" — the shape of question an FDE actually
// asks of a domain ("what does this action consume and emit", "does this object
// declare a key", "which action does this rule bind to"). A count alone cannot
// be checked against the Ontology by eye; a row can.
//
// Honesty rules (identical to the aggregates module):
//   · rows are capped by ONE named, env-overridable constant;
//   · `total` is always the full pre-cap row count and `truncated` self-reports;
//   · a LIST cell is capped too, and a capped cell says how many it left out
//     inside its own text — the count columns always report the whole truth;
//   · an undeclared value is reported as "(未声明)" and an empty list as "(无)".
//     The ontology did not say, so this module does not say it for it.

import {
  ONTOCODE_TABLE_MAX_COLUMNS,
  ONTOCODE_TABLE_MAX_ROWS,
} from "@agentic/contracts";
import { ruleEnforcementLevelValue } from "./ontology-aggregates";
import type {
  DomainOntology,
  OntologyAction,
  OntologyEvent,
  OntologyObject,
} from "./ontology-types";

/** Env var that overrides the per-derivation row cap. */
export const ONTOLOGY_ANALYSIS_TABLE_ROW_CAP_ENV =
  "ONTOLOGY_ANALYSIS_TABLE_ROW_CAP";
/** Default row cap. Bounded by the table contract's own maximum so an
 * un-truncated derivation is always presentable as-is. */
export const ONTOLOGY_ANALYSIS_TABLE_ROW_CAP_DEFAULT = ONTOCODE_TABLE_MAX_ROWS;
/** Env var that overrides how many items ONE list cell may show. */
export const ONTOLOGY_ANALYSIS_TABLE_CELL_ITEM_CAP_ENV =
  "ONTOLOGY_ANALYSIS_TABLE_CELL_ITEM_CAP";
/** Default items per list cell. A row must stay readable in a chat column;
 * beyond this the cell states how many it is not showing. */
export const ONTOLOGY_ANALYSIS_TABLE_CELL_ITEM_CAP_DEFAULT = 6;

/** The label used when the ontology declares nothing. Reported as state. */
const UNDECLARED_LABEL = "(未声明)";
/** The label used when a declared collection is genuinely empty. */
const EMPTY_LABEL = "(无)";
/** Separator for the items of one list cell. */
const ITEM_SEPARATOR = "、";

function envInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined>,
): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function ontologyAnalysisTableRowCap(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.min(
    envInt(
      ONTOLOGY_ANALYSIS_TABLE_ROW_CAP_ENV,
      ONTOLOGY_ANALYSIS_TABLE_ROW_CAP_DEFAULT,
      env,
    ),
    ONTOCODE_TABLE_MAX_ROWS,
  );
}

export function ontologyAnalysisTableCellItemCap(
  env: Record<string, string | undefined> = process.env,
): number {
  return envInt(
    ONTOLOGY_ANALYSIS_TABLE_CELL_ITEM_CAP_ENV,
    ONTOLOGY_ANALYSIS_TABLE_CELL_ITEM_CAP_DEFAULT,
    env,
  );
}

/** One cell: a plain string or a number the server produced. Mirrors the
 * contract's cell union — nothing structured ever reaches a renderer. */
export type OntologyTableCell = string | number;

export interface OntologyTableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

export interface OntologyTableResult {
  derivation: string;
  columns: OntologyTableColumn[];
  rows: OntologyTableCell[][];
  /** Full pre-cap row count; rows.length < total ⇔ truncated. */
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

function sortedUnique(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const text = textValue(value);
    if (text) set.add(text);
  }
  return [...set].sort(compareText);
}

/**
 * Render a list of declared names into ONE cell.
 *
 * Empty says "(无)" rather than going blank — a blank cell reads as "not
 * checked" when the truth is "checked, and there are none". A cell holding more
 * items than the cap states the shortfall in its own text, because the reader
 * only ever sees the cell.
 */
function listCell(values: string[], itemCap: number): string {
  if (values.length === 0) return EMPTY_LABEL;
  if (values.length <= itemCap) return values.join(ITEM_SEPARATOR);
  const shown = values.slice(0, itemCap).join(ITEM_SEPARATOR);
  return `${shown}（另有 ${values.length - itemCap} 项未显示）`;
}

function eventPayload(event: OntologyEvent): OntologyEvent["payload"] {
  return event.payload && typeof event.payload === "object"
    ? event.payload
    : { source_action: null, event_data: [], state_mutations: [] };
}

export function actionKey(action: OntologyAction): string | null {
  return textValue(action.name) ?? textValue(action.id);
}

export function objectKey(object: OntologyObject): string | null {
  return textValue(object.id) ?? textValue(object.name);
}

/**
 * Events an action consumes / produces, taking the UNION of both declaration
 * sides exactly like the aggregates module: the action's trigger /
 * triggered_event arrays AND the event's consumers / producers +
 * payload.source_action. A doubly-declared edge appears once.
 */
export function actionEventSides(
  ontology: DomainOntology,
): Map<string, { consumes: Set<string>; emits: Set<string> }> {
  const sides = new Map<string, { consumes: Set<string>; emits: Set<string> }>();
  const slot = (name: string) => {
    const existing = sides.get(name);
    if (existing) return existing;
    const created = { consumes: new Set<string>(), emits: new Set<string>() };
    sides.set(name, created);
    return created;
  };
  for (const action of ontology.actions ?? []) {
    const name = actionKey(action);
    if (!name) continue;
    const entry = slot(name);
    for (const event of action.trigger ?? []) {
      const text = textValue(event);
      if (text) entry.consumes.add(text);
    }
    for (const event of action.triggered_event ?? []) {
      const text = textValue(event);
      if (text) entry.emits.add(text);
    }
  }
  for (const event of ontology.events ?? []) {
    const eventName = textValue(event.name);
    if (!eventName) continue;
    const payload = eventPayload(event);
    for (const producer of [...(event.producers ?? []), payload.source_action]) {
      const name = textValue(producer);
      if (name) slot(name).emits.add(eventName);
    }
    for (const consumer of event.consumers ?? []) {
      const name = textValue(consumer);
      if (name) slot(name).consumes.add(eventName);
    }
  }
  return sides;
}

/**
 * Rule references declared on an action's steps. EXACT matching only — the same
 * rule as ontology-analysis.ts's stepRuleRefs: a prefix, a shared target object
 * or a similar-looking name is not evidence of a binding.
 */
export function stepRuleRefs(action: OntologyAction): string[] {
  const refs: string[] = [];
  for (const rawStep of (action.action_steps ?? []) as unknown[]) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as Record<string, unknown>;
    const list = Array.isArray(step.rules)
      ? step.rules
      : step.rules == null
        ? []
        : [step.rules];
    for (const entry of list) {
      if (entry == null) continue;
      if (typeof entry === "object") {
        const row = entry as Record<string, unknown>;
        const id =
          textValue(row.id) ?? textValue(row.rule_id) ?? textValue(row.name);
        if (id) refs.push(id);
        continue;
      }
      const scalar = textValue(entry);
      if (scalar) refs.push(scalar);
    }
  }
  return refs;
}

interface TableDefinition {
  name: string;
  /** Model-visible; must stay domain-neutral. */
  description: string;
  columns: OntologyTableColumn[];
  compute(ontology: DomainOntology, itemCap: number): OntologyTableCell[][];
}

const TABLE_DEFINITIONS: TableDefinition[] = [
  {
    name: "actions_with_event_flow",
    description:
      "每个动作一行：执行者、消费的事件、产出的事件与两者的去重计数（合并动作侧 trigger/triggered_event 与事件侧 producers/consumers/source_action 的声明）。",
    columns: [
      { key: "action", label: "动作" },
      { key: "actor", label: "执行者" },
      { key: "consumes", label: "消费事件" },
      { key: "emits", label: "产出事件" },
      { key: "consumeCount", label: "消费数", align: "right" },
      { key: "emitCount", label: "产出数", align: "right" },
    ],
    compute: (ontology, itemCap) => {
      const sides = actionEventSides(ontology);
      const rows: OntologyTableCell[][] = [];
      for (const action of ontology.actions ?? []) {
        const name = actionKey(action);
        if (!name) continue;
        const entry = sides.get(name) ?? {
          consumes: new Set<string>(),
          emits: new Set<string>(),
        };
        const consumes = [...entry.consumes].sort(compareText);
        const emits = [...entry.emits].sort(compareText);
        const actors = sortedUnique(action.actor ?? []);
        rows.push([
          name,
          actors.length > 0
            ? listCell(actors, itemCap)
            : // No actor declared at all is different from an empty list of
              // events: nobody said who acts, so say that.
              UNDECLARED_LABEL,
          listCell(consumes, itemCap),
          listCell(emits, itemCap),
          consumes.length,
          emits.length,
        ]);
      }
      return rows;
    },
  },
  {
    name: "objects_with_key_and_properties",
    description:
      "每个对象一行：声明的 type、主键、属性数量与其中被声明为外键的数量；未声明的 type/主键报「(未声明)」，不从属性名反推。",
    columns: [
      { key: "object", label: "对象" },
      { key: "type", label: "类型" },
      { key: "primaryKey", label: "主键" },
      { key: "propertyCount", label: "属性数", align: "right" },
      { key: "foreignKeyCount", label: "外键数", align: "right" },
    ],
    compute: (ontology) => {
      const rows: OntologyTableCell[][] = [];
      for (const object of ontology.objects ?? []) {
        const key = objectKey(object);
        if (!key) continue;
        const properties = object.properties ?? [];
        rows.push([
          key,
          textValue(object.type) ?? UNDECLARED_LABEL,
          textValue(object.primary_key) ?? UNDECLARED_LABEL,
          properties.length,
          properties.filter((property) => property.is_foreign_key === true)
            .length,
        ]);
      }
      return rows;
    },
  },
  {
    name: "rules_with_enforcement_and_binding",
    description:
      "每条规则一行：声明的强制级别（接受 enforcement / severity / enforcementLevel / enforcement_level 任一拼写，未声明就报「(未声明)」）与经 action_steps[].rules[] 精确引用到它的动作；没有任何动作引用的规则以「(无)」和 0 出现。",
    columns: [
      { key: "rule", label: "规则" },
      { key: "name", label: "名称" },
      { key: "enforcement", label: "强制级别" },
      { key: "boundActions", label: "绑定动作" },
      { key: "boundActionCount", label: "绑定数", align: "right" },
    ],
    compute: (ontology, itemCap) => {
      const rules = (ontology.rules ?? []) as Array<Record<string, unknown>>;
      const idOf = (rule: Record<string, unknown>): string | null =>
        textValue(rule.id) ?? textValue(rule.rule_id) ?? textValue(rule.name);
      const known = new Set<string>();
      for (const rule of rules) {
        const id = idOf(rule);
        if (id) known.add(id);
      }
      // Exact references only, in both directions.
      const boundBy = new Map<string, Set<string>>();
      for (const action of ontology.actions ?? []) {
        const name = actionKey(action);
        if (!name) continue;
        for (const ref of stepRuleRefs(action)) {
          if (!known.has(ref)) continue;
          const set = boundBy.get(ref) ?? new Set<string>();
          set.add(name);
          boundBy.set(ref, set);
        }
      }
      const rows: OntologyTableCell[][] = [];
      const seen = new Set<string>();
      for (const rule of rules) {
        const id = idOf(rule);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const bound = [...(boundBy.get(id) ?? new Set<string>())].sort(
          compareText,
        );
        rows.push([
          id,
          textValue(rule.businessLogicRuleName) ??
            textValue(rule.name) ??
            UNDECLARED_LABEL,
          ruleEnforcementLevelValue(rule) ?? UNDECLARED_LABEL,
          listCell(bound, itemCap),
          bound.length,
        ]);
      }
      return rows;
    },
  },
  {
    name: "events_with_producers_and_consumers",
    description:
      "每个事件一行：产出它的动作、消费它的动作与 payload 字段数（合并事件侧 producers/consumers/source_action 与动作侧 triggered_event/trigger 的声明）。",
    columns: [
      { key: "event", label: "事件" },
      { key: "producers", label: "产出方" },
      { key: "consumers", label: "消费方" },
      { key: "payloadFields", label: "字段数", align: "right" },
    ],
    compute: (ontology, itemCap) => {
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
      const rows: OntologyTableCell[][] = [];
      for (const event of ontology.events ?? []) {
        const name = textValue(event.name);
        if (!name) continue;
        rows.push([
          name,
          listCell(
            [...(producersOf.get(name) ?? new Set<string>())].sort(compareText),
            itemCap,
          ),
          listCell(
            [...(consumersOf.get(name) ?? new Set<string>())].sort(compareText),
            itemCap,
          ),
          eventPayload(event).event_data?.length ?? 0,
        ]);
      }
      return rows;
    },
  },
];

const TABLES_BY_NAME = new Map(
  TABLE_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export function listAnalysisTables(): Array<{
  name: string;
  description: string;
}> {
  return TABLE_DEFINITIONS.map(({ name, description }) => ({
    name,
    description,
  }));
}

export function computeAnalysisTable(
  ontology: DomainOntology,
  name: string,
  env: Record<string, string | undefined> = process.env,
): OntologyTableResult {
  const definition = TABLES_BY_NAME.get(name);
  if (!definition) {
    throw new Error(
      `Unknown analysis table "${name}". Valid tables: ${TABLE_DEFINITIONS.map(
        (entry) => entry.name,
      ).join(", ")}`,
    );
  }
  if (definition.columns.length > ONTOCODE_TABLE_MAX_COLUMNS) {
    throw new Error(
      `Analysis table "${definition.name}" declares ${definition.columns.length} columns, above the ${ONTOCODE_TABLE_MAX_COLUMNS}-column contract bound`,
    );
  }
  const cap = ontologyAnalysisTableRowCap(env);
  const itemCap = ontologyAnalysisTableCellItemCap(env);
  const rows = definition
    .compute(ontology, itemCap)
    // Sorted by the first (identity) column so the same ontology always
    // derives the same table, whatever order the source listed entities in.
    .sort((a, b) => compareText(String(a[0]), String(b[0])));
  return {
    derivation: definition.name,
    columns: definition.columns.map((column) => ({ ...column })),
    rows: rows.slice(0, cap),
    total: rows.length,
    truncated: rows.length > cap,
  };
}
