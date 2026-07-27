// Deterministic Ontology comprehension — the structural half of the analyst.
//
// WHY THIS EXISTS: `read_ontology` hands the model `links: <count>` (tools.ts
// domain_summary) — a single integer. The authoritative relationship graph that
// Allmeta compiles (typed edges with per-edge compiler evidence) is fetched,
// held in memory on DomainOntology.links, and then thrown away before anything
// reasons over it. So "understanding" has been limited to a flat catalogue of
// objects/actions/rules with no notion of how entities actually relate.
//
// Everything here is PURE and synchronous: same ontology in → same analysis out,
// no LLM, no I/O. That makes it testable, cheap, and — importantly — it means the
// analyst still produces a real, citable structural reading when no model is
// available. The LLM layer sits ON TOP of these facts and must cite them.
import type {
  DomainOntology,
  OntologyAction,
  OntologyLink,
} from "./ontology-types";

export interface EntityProfile {
  /** DataObject id as it appears in the ontology. */
  id: string;
  name?: string;
  /** Edges where this entity is the source. */
  outbound: number;
  /** Edges where this entity is the target. */
  inbound: number;
  /** Actions whose target_objects include this entity. */
  touchedByActions: string[];
  /** Distinct relationship kinds on its edges. */
  relationshipKinds: string[];
  /** No edges at all — either genuinely standalone or a modelling gap. */
  isolated: boolean;
}

export interface RelationshipKindSummary {
  kind: string;
  count: number;
  /** Up to 3 concrete examples, so a reader can verify the claim. */
  examples: Array<{ id: string; from: string; to: string }>;
}

export interface EventChain {
  entryEvent: string;
  /** Ordered action names along one traversal from the entry event. */
  path: string[];
  terminalEvent: string | null;
  /** True when traversal stopped because it revisited an action. */
  cyclic: boolean;
}

export interface OntologyAnalysisGap {
  kind:
    | "no_link_graph"
    | "isolated_entities"
    | "actions_without_objects"
    | "unreferenced_events"
    | "rules_without_actions"
    | "no_agent_actions";
  detail: string;
  /** Concrete offenders, so the gap is checkable rather than rhetorical. */
  subjects: string[];
}

export interface OntologyStructuralAnalysis {
  domainId: string;
  source: string;
  counts: {
    objects: number;
    actions: number;
    agentActions: number;
    events: number;
    rules: number;
    links: number;
  };
  /** Sorted by total degree, most connected first. */
  entities: EntityProfile[];
  hubs: EntityProfile[];
  isolatedEntities: string[];
  relationshipKinds: RelationshipKindSummary[];
  eventChains: EventChain[];
  entryEvents: string[];
  terminalEvents: string[];
  externalSystems: string[];
  agentActions: string[];
  humanActions: string[];
  gaps: OntologyAnalysisGap[];
  /** True when the source supplied a compiled relationship graph. */
  hasLinkGraph: boolean;
}

function endpointId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id.trim() || null;
  }
  return null;
}

function linkEnds(link: OntologyLink): { from: string; to: string } | null {
  const from = endpointId(link.from);
  const to = endpointId(link.to);
  return from && to ? { from, to } : null;
}

function isAgentAction(action: OntologyAction): boolean {
  return (action.actor ?? []).some(
    (a) => typeof a === "string" && a.trim().toLowerCase() === "agent",
  );
}

/**
 * Systems an action declares it must reach. Allmeta emits rich entries
 * (`{name, kind, role, capability}`); older/manifest sources emit bare strings.
 * Both shapes are real, so both are read — taking only strings silently returned
 * an empty list for every live Allmeta domain.
 */
export function actionSystems(action: OntologyAction): string[] {
  const raw = (action as { integration?: unknown }).integration;
  if (!raw || typeof raw !== "object") return [];
  const systems = (raw as { systems?: unknown }).systems;
  if (!Array.isArray(systems)) return [];
  return systems.flatMap((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      return trimmed ? [trimmed] : [];
    }
    if (entry && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return [name.trim()];
    }
    return [];
  });
}

/**
 * Walk the event graph from each entry event. Bounded and cycle-safe: a chain
 * stops as soon as it would revisit an action, and is flagged `cyclic` so a
 * reader is never told a loop is a clean pipeline.
 */
function buildEventChains(actions: OntologyAction[]): {
  chains: EventChain[];
  entryEvents: string[];
  terminalEvents: string[];
} {
  const consumed = new Set<string>();
  const emitted = new Set<string>();
  for (const action of actions) {
    for (const t of action.trigger ?? []) consumed.add(t);
    for (const e of action.triggered_event ?? []) emitted.add(e);
  }
  const entryEvents = [...consumed].filter((e) => !emitted.has(e)).sort();
  const terminalEvents = [...emitted].filter((e) => !consumed.has(e)).sort();

  const byTrigger = new Map<string, OntologyAction[]>();
  for (const action of actions) {
    for (const t of action.trigger ?? []) {
      const list = byTrigger.get(t) ?? [];
      list.push(action);
      byTrigger.set(t, list);
    }
  }

  const chains: EventChain[] = [];
  const MAX_CHAINS = 40;
  const MAX_DEPTH = 12;
  // A mature domain often has NO strict entry event: every event is also emitted
  // somewhere, so `consumed - emitted` is empty and a naive walker reports "no
  // flows" for a graph that is full of them. Fall back to the busiest consumed
  // events so the reading still shows how work actually moves.
  const seeds =
    entryEvents.length > 0
      ? entryEvents
      : [...byTrigger.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([event]) => event)
          .slice(0, 8);
  for (const entry of seeds) {
    let event: string | null = entry;
    const path: string[] = [];
    const seen = new Set<string>();
    let cyclic = false;
    while (event && path.length < MAX_DEPTH) {
      const next: OntologyAction | undefined = (byTrigger.get(event) ?? [])[0];
      if (!next) break;
      if (seen.has(next.name)) {
        cyclic = true;
        break;
      }
      seen.add(next.name);
      path.push(next.name);
      event = (next.triggered_event ?? [])[0] ?? null;
    }
    if (path.length > 0) {
      chains.push({
        entryEvent: entry,
        path,
        terminalEvent: event && terminalEvents.includes(event) ? event : null,
        cyclic,
      });
    }
    if (chains.length >= MAX_CHAINS) break;
  }
  return { chains, entryEvents, terminalEvents };
}

export function analyzeOntologyStructure(
  ontology: DomainOntology,
): OntologyStructuralAnalysis {
  const links = ontology.links ?? [];
  const actions = ontology.actions ?? [];
  const objects = ontology.objects ?? [];
  const events = ontology.events ?? [];
  const rules = ontology.rules ?? [];

  const outbound = new Map<string, number>();
  const inbound = new Map<string, number>();
  const kindsByEntity = new Map<string, Set<string>>();
  const kindSummary = new Map<string, RelationshipKindSummary>();

  for (const link of links) {
    const ends = linkEnds(link);
    if (!ends) continue;
    outbound.set(ends.from, (outbound.get(ends.from) ?? 0) + 1);
    inbound.set(ends.to, (inbound.get(ends.to) ?? 0) + 1);
    for (const id of [ends.from, ends.to]) {
      const set = kindsByEntity.get(id) ?? new Set<string>();
      set.add(link.kind);
      kindsByEntity.set(id, set);
    }
    const summary = kindSummary.get(link.kind) ?? {
      kind: link.kind,
      count: 0,
      examples: [],
    };
    summary.count += 1;
    if (summary.examples.length < 3) {
      summary.examples.push({ id: link.id, from: ends.from, to: ends.to });
    }
    kindSummary.set(link.kind, summary);
  }

  const actionsByObject = new Map<string, string[]>();
  for (const action of actions) {
    for (const obj of action.target_objects ?? []) {
      const list = actionsByObject.get(obj) ?? [];
      list.push(action.name);
      actionsByObject.set(obj, list);
    }
  }

  const entities: EntityProfile[] = objects.map((object) => {
    const out = outbound.get(object.id) ?? 0;
    const inn = inbound.get(object.id) ?? 0;
    return {
      id: object.id,
      ...(object.name && object.name !== object.id
        ? { name: object.name }
        : {}),
      outbound: out,
      inbound: inn,
      touchedByActions: actionsByObject.get(object.id) ?? [],
      relationshipKinds: [...(kindsByEntity.get(object.id) ?? [])].sort(),
      isolated: out + inn === 0,
    };
  });
  entities.sort(
    (a, b) => b.outbound + b.inbound - (a.outbound + a.inbound),
  );

  const agentActions = actions.filter(isAgentAction);
  const { chains, entryEvents, terminalEvents } = buildEventChains(actions);

  const externalSystems = [
    ...new Set(actions.flatMap((a) => actionSystems(a))),
  ].sort();

  const referencedEvents = new Set<string>();
  for (const action of actions) {
    for (const t of action.trigger ?? []) referencedEvents.add(t);
    for (const e of action.triggered_event ?? []) referencedEvents.add(e);
  }

  const gaps: OntologyAnalysisGap[] = [];
  if (links.length === 0) {
    gaps.push({
      kind: "no_link_graph",
      detail:
        "该本体没有提供已编译的关系图（links）。实体之间的关联只能从动作的 target_objects 推断，无法验证外键/引用等真实关系。",
      subjects: [],
    });
  }
  const isolated = entities.filter((e) => e.isolated).map((e) => e.id);
  if (links.length > 0 && isolated.length > 0) {
    gaps.push({
      kind: "isolated_entities",
      detail: `${isolated.length} 个对象在关系图中没有任何边——要么确实独立，要么建模缺失。`,
      subjects: isolated.slice(0, 20),
    });
  }
  const actionsWithoutObjects = actions
    .filter((a) => (a.target_objects ?? []).length === 0)
    .map((a) => a.name);
  if (actionsWithoutObjects.length > 0) {
    gaps.push({
      kind: "actions_without_objects",
      detail: "这些动作没有声明 target_objects，无法确定它读写哪些业务实体。",
      subjects: actionsWithoutObjects.slice(0, 20),
    });
  }
  const unreferencedEvents = events
    .map((e) => e.name)
    .filter((name) => !referencedEvents.has(name));
  if (unreferencedEvents.length > 0) {
    gaps.push({
      kind: "unreferenced_events",
      detail: "这些事件在本体里定义了，但没有任何动作消费或产出它们。",
      subjects: unreferencedEvents.slice(0, 20),
    });
  }
  if (agentActions.length === 0) {
    gaps.push({
      kind: "no_agent_actions",
      detail:
        "该本体没有 actor=Agent 的动作，因此没有可自动化生成的 Agent 边界。",
      subjects: [],
    });
  }

  return {
    domainId: ontology.domainId,
    source: ontology.source,
    counts: {
      objects: objects.length,
      actions: actions.length,
      agentActions: agentActions.length,
      events: events.length,
      rules: rules.length,
      links: links.length,
    },
    entities,
    hubs: entities.filter((e) => e.outbound + e.inbound > 0).slice(0, 8),
    isolatedEntities: isolated,
    relationshipKinds: [...kindSummary.values()].sort(
      (a, b) => b.count - a.count,
    ),
    eventChains: chains,
    entryEvents,
    terminalEvents,
    externalSystems,
    agentActions: agentActions.map((a) => a.name),
    humanActions: actions.filter((a) => !isAgentAction(a)).map((a) => a.name),
    gaps,
    hasLinkGraph: links.length > 0,
  };
}

/**
 * Compact, model-facing rendering of the structural analysis. Unlike the raw
 * ontology this stays small enough to send whole, and unlike `links: <count>`
 * it carries the actual edges — which is the entire point.
 */
export function renderAnalysisForModel(
  analysis: OntologyStructuralAnalysis,
  opts: { maxEntities?: number; maxChains?: number } = {},
): string {
  const maxEntities = opts.maxEntities ?? 25;
  const maxChains = opts.maxChains ?? 12;
  const lines: string[] = [];
  lines.push(`域 ${analysis.domainId}（来源 ${analysis.source}）`);
  lines.push(
    `规模：对象 ${analysis.counts.objects} · 动作 ${analysis.counts.actions}（Agent ${analysis.counts.agentActions}） · 事件 ${analysis.counts.events} · 规则 ${analysis.counts.rules} · 关系边 ${analysis.counts.links}`,
  );
  if (analysis.relationshipKinds.length > 0) {
    lines.push("");
    lines.push("关系类型：");
    for (const kind of analysis.relationshipKinds) {
      const ex = kind.examples
        .map((e) => `${e.from}→${e.to}`)
        .join("，");
      lines.push(`- ${kind.kind} ×${kind.count}${ex ? `（例：${ex}）` : ""}`);
    }
  }
  if (analysis.hubs.length > 0) {
    lines.push("");
    lines.push("连接度最高的实体：");
    for (const hub of analysis.hubs.slice(0, maxEntities)) {
      lines.push(
        `- ${hub.id}：出 ${hub.outbound} / 入 ${hub.inbound}${hub.touchedByActions.length ? ` · 被动作 ${hub.touchedByActions.join("、")} 使用` : ""}`,
      );
    }
  }
  if (analysis.eventChains.length > 0) {
    lines.push("");
    lines.push("事件链：");
    for (const chain of analysis.eventChains.slice(0, maxChains)) {
      lines.push(
        `- ${chain.entryEvent} → ${chain.path.join(" → ")}${chain.terminalEvent ? ` → ${chain.terminalEvent}` : ""}${chain.cyclic ? "（存在回环）" : ""}`,
      );
    }
  }
  if (analysis.externalSystems.length > 0) {
    lines.push("");
    lines.push(`外部系统：${analysis.externalSystems.join("、")}`);
  }
  if (analysis.gaps.length > 0) {
    lines.push("");
    lines.push("结构缺口：");
    for (const gap of analysis.gaps) {
      lines.push(
        `- [${gap.kind}] ${gap.detail}${gap.subjects.length ? ` → ${gap.subjects.join("、")}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
