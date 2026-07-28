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

/** #RULES —— 一条规则被读出来的全部可核查事实。
 *
 *  以前整个规则维度只有 `counts.rules` 一个整数：一个域里哪些规则能卡住流程、哪些该由人来做、
 *  哪些还没法自动化、各自管着哪些对象、有没有接到任何动作上——FDE 一个都看不到，而这些恰恰是
 *  「能不能据此生成代码」的前提。 */
export interface RuleFacet {
  id: string;
  name: string;
  /** null 表示【本体没有声明】，绝不兜底成 "warn"。 */
  enforcementLevel: string | null;
  failurePolicy: string | null;
  executor: string | null;
  automationStatus: string | null;
  /** 政策不是全域统一的：同一个动作上可能挂着分属不同客户的互斥规则。 */
  client: string | null;
  department: string | null;
  stage: string | null;
  /** relatedEntities 中能在本体里找到的对象。 */
  governs: string[];
  /** relatedEntities 里指向本体不存在对象的引用——这是发现，不是噪音。 */
  danglingGoverns: string[];
  /** 编译关系图里是否有任何一条与它相连的边。 */
  linkBacked: boolean;
  /** 经 action_steps[].rules[] 精确引用到它的动作。 */
  referencedByActions: string[];
}

export interface RuleAnalysis {
  total: number;
  /** failurePolicy === "block"：真的能拦住流程。 */
  blocking: number;
  warning: number;
  /** 既没声明 enforcementLevel 也没声明 failurePolicy——报「未声明」，不报「不严重」。 */
  undeclared: number;
  byExecutor: Array<{ executor: string; count: number }>;
  byAutomation: Array<{ status: string; count: number }>;
  byClient: Array<{ client: string; count: number; blocking: number }>;
  byStage: Array<{ stage: string; count: number }>;
  /** 能从动作走到的规则数——生成器只看得见这些。 */
  reachableFromActions: number;
  /** 既没有动作引用、也没有任何关系边的规则 id。 */
  orphans: string[];
  /** 同名但 id 不同的规则：任何按名字归并的做法都会把不同政策合成一条。 */
  duplicateNames: Array<{ name: string; ids: string[] }>;
  /** 同一个动作上挂着分属不同客户的规则——照单生成会把 A 客户的政策套到 B 客户身上。 */
  crossClientActions: Array<{ action: string; clients: string[]; blockingRules: number }>;
  rules: RuleFacet[];
}

export interface OntologyAnalysisGap {
  kind:
    | "no_link_graph"
    | "isolated_entities"
    | "actions_without_objects"
    | "unreferenced_events"
    | "rules_without_actions"
    | "rules_without_enforcement"
    | "rules_span_multiple_clients"
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
  /** #RULES —— 规则维度的完整读数。 */
  rules: RuleAnalysis;
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

// ── #RULES —— 规则维度 ────────────────────────────────────────────────────────

function ruleText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 规则在 action_steps[].rules[] 里可能写成裸值，也可能写成 {id}/{name} 记录。
 *  只做精确匹配：前缀、目标对象、语义相似都不算证据。 */
function stepRuleRefs(action: OntologyAction): string[] {
  const refs: string[] = [];
  for (const rawStep of (action.action_steps ?? []) as unknown[]) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as Record<string, unknown>;
    const list = Array.isArray(step.rules) ? step.rules : step.rules == null ? [] : [step.rules];
    for (const entry of list) {
      if (entry == null) continue;
      if (typeof entry === "object") {
        const row = entry as Record<string, unknown>;
        const id = ruleText(row.id) ?? ruleText(row.rule_id) ?? ruleText(row.name);
        if (id) refs.push(id);
        continue;
      }
      const scalar = ruleText(entry);
      if (scalar) refs.push(scalar);
    }
  }
  return refs;
}

function analyzeRules(
  rules: Array<Record<string, unknown>>,
  actions: OntologyAction[],
  objectIds: Set<string>,
  linkedRuleIds: Set<string>,
): RuleAnalysis {
  const byId = new Map<string, Record<string, unknown>>();
  for (const [index, rule] of rules.entries()) {
    const id = ruleText(rule.id) ?? ruleText(rule.rule_id) ?? ruleText(rule.name) ?? `rule:${index + 1}`;
    if (!byId.has(id)) byId.set(id, rule);
  }
  // 动作 → 规则的精确引用。
  const referencedBy = new Map<string, string[]>();
  for (const action of actions) {
    for (const ref of stepRuleRefs(action)) {
      if (!byId.has(ref)) continue;
      referencedBy.set(ref, [...(referencedBy.get(ref) ?? []), action.name]);
    }
  }

  const facets: RuleFacet[] = [];
  for (const [id, rule] of byId) {
    const related = Array.isArray(rule.relatedEntities) ? rule.relatedEntities : [];
    const governs: string[] = [];
    const dangling: string[] = [];
    for (const entry of related) {
      const name = ruleText(entry) ?? ruleText((entry as Record<string, unknown> | null)?.id);
      if (!name) continue;
      (objectIds.has(name) ? governs : dangling).push(name);
    }
    facets.push({
      id,
      name: ruleText(rule.businessLogicRuleName) ?? ruleText(rule.name) ?? id,
      // null 一律保留为 null：本体没说，就不要替它说。
      enforcementLevel: ruleText(rule.enforcementLevel),
      failurePolicy: ruleText(rule.failurePolicy),
      executor: ruleText(rule.executor),
      automationStatus: ruleText(rule.automationStatus),
      client: ruleText(rule.applicableClient) ?? ruleText(rule.belongsToClient),
      department: ruleText(rule.applicableDepartment) ?? ruleText(rule.belongsToDepartment),
      stage: ruleText(rule.specificScenarioStage),
      governs: [...new Set(governs)].sort(),
      danglingGoverns: [...new Set(dangling)].sort(),
      linkBacked: linkedRuleIds.has(id),
      referencedByActions: [...new Set(referencedBy.get(id) ?? [])].sort(),
    });
  }
  facets.sort((a, b) => a.id.localeCompare(b.id));

  const tally = (pick: (f: RuleFacet) => string | null): Array<[string, number]> => {
    const counts = new Map<string, number>();
    for (const f of facets) {
      const key = pick(f) ?? "(未声明)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  const byClientCounts = new Map<string, { count: number; blocking: number }>();
  for (const f of facets) {
    const key = f.client ?? "(未声明)";
    const row = byClientCounts.get(key) ?? { count: 0, blocking: 0 };
    row.count += 1;
    if (f.failurePolicy === "block") row.blocking += 1;
    byClientCounts.set(key, row);
  }

  const namesToIds = new Map<string, string[]>();
  for (const f of facets) namesToIds.set(f.name, [...(namesToIds.get(f.name) ?? []), f.id]);

  // 同一个动作上挂着分属不同客户的规则：照单生成会把 A 客户的政策套到 B 客户身上。
  const crossClient: RuleAnalysis["crossClientActions"] = [];
  for (const action of actions) {
    const attached = facets.filter((f) => f.referencedByActions.includes(action.name));
    const clients = [...new Set(attached.map((f) => f.client).filter((c): c is string => Boolean(c) && c !== "通用"))].sort();
    if (clients.length > 1) {
      crossClient.push({
        action: action.name,
        clients,
        blockingRules: attached.filter((f) => f.failurePolicy === "block").length,
      });
    }
  }

  return {
    total: facets.length,
    blocking: facets.filter((f) => f.failurePolicy === "block").length,
    warning: facets.filter((f) => f.failurePolicy === "warn").length,
    undeclared: facets.filter((f) => f.failurePolicy === null && f.enforcementLevel === null).length,
    byExecutor: tally((f) => f.executor).map(([executor, count]) => ({ executor, count })),
    byAutomation: tally((f) => f.automationStatus).map(([status, count]) => ({ status, count })),
    byClient: [...byClientCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([client, row]) => ({ client, ...row })),
    byStage: tally((f) => f.stage).map(([stage, count]) => ({ stage, count })),
    reachableFromActions: facets.filter((f) => f.referencedByActions.length > 0).length,
    orphans: facets.filter((f) => f.referencedByActions.length === 0 && !f.linkBacked).map((f) => f.id),
    duplicateNames: [...namesToIds.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([name, ids]) => ({ name, ids: ids.sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    crossClientActions: crossClient,
    rules: facets,
  };
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

  // #RULES —— 规则维度。linkedRuleIds 用「规则端点」判定，而不是任何 id 形状约定。
  const ruleEndpointIds = new Set<string>();
  for (const link of links) {
    for (const end of [link.from, link.to] as Array<{ id?: unknown; type?: unknown } | undefined>) {
      if (!end) continue;
      if (String(end.type ?? "").toLowerCase().includes("rule")) {
        const id = endpointId(end);
        if (id) ruleEndpointIds.add(id);
      }
    }
  }
  const ruleAnalysis = analyzeRules(
    rules as Array<Record<string, unknown>>,
    actions,
    new Set(objects.flatMap((o) => [o.id, o.name].filter((v): v is string => Boolean(v)))),
    ruleEndpointIds,
  );

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
  // 这条 gap 早就声明在类型里，却从来没有人构造过它——于是「孤儿规则」从未被报告给任何人。
  if (ruleAnalysis.orphans.length > 0) {
    gaps.push({
      kind: "rules_without_actions",
      detail:
        `${ruleAnalysis.orphans.length}/${ruleAnalysis.total} 条规则既没有被任何动作的 action_steps 引用，`
        + "在编译关系图里也没有任何一条边。生成器只沿动作引用取规则，所以这些政策对它是不可见的——"
        + "据此生成的 agent 会静默地少执行这部分约束。",
      subjects: ruleAnalysis.orphans.slice(0, 20),
    });
  }
  const undeclaredRules = ruleAnalysis.rules
    .filter((r) => r.failurePolicy === null && r.enforcementLevel === null)
    .map((r) => r.id);
  if (undeclaredRules.length > 0) {
    gaps.push({
      kind: "rules_without_enforcement",
      detail:
        `${undeclaredRules.length} 条规则既没声明 enforcementLevel 也没声明 failurePolicy。`
        + "这里报「未声明」而不是「不严重」：把空值当成 warn，会把一批本该由人裁决的约束标成无害。",
      subjects: undeclaredRules.slice(0, 20),
    });
  }
  if (ruleAnalysis.crossClientActions.length > 0) {
    gaps.push({
      kind: "rules_span_multiple_clients",
      detail:
        "这些动作上挂着分属不同客户的规则。政策不是全域统一的——不带客户作用域就生成一个 agent，"
        + "等于把一个客户的政策套到另一个客户的业务上。",
      subjects: ruleAnalysis.crossClientActions.map((a) => `${a.action}（${a.clients.join(" / ")}）`),
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
    rules: ruleAnalysis,
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
  opts: { maxEntities?: number; maxChains?: number; maxRules?: number } = {},
): string {
  const maxEntities = opts.maxEntities ?? 25;
  const maxChains = opts.maxChains ?? 12;
  const maxRules = opts.maxRules ?? 24;
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
    // 截断必须自报。这个文件本来就是为了不再重蹈 capJson 静默截断的覆辙而写的，
    // 而它自己一直在把最多 40 条链切到 12 条却什么都不说。
    const shownChains = analysis.eventChains.slice(0, maxChains);
    lines.push(
      shownChains.length < analysis.eventChains.length
        ? `事件链（共 ${analysis.eventChains.length} 条，下列为前 ${shownChains.length} 条）：`
        : "事件链：",
    );
    for (const chain of shownChains) {
      lines.push(
        `- ${chain.entryEvent} → ${chain.path.join(" → ")}${chain.terminalEvent ? ` → ${chain.terminalEvent}` : ""}${chain.cyclic ? "（存在回环）" : ""}`,
      );
    }
  }
  if (analysis.externalSystems.length > 0) {
    lines.push("");
    lines.push(`外部系统：${analysis.externalSystems.join("、")}`);
  }
  // #RULES —— 规则以前只是 counts 里的一个整数。模型看不到「哪条能卡住流程、谁来执行、
  // 管着哪个对象、有没有接到动作上」，也就无从据此设计 agent。
  const r = analysis.rules;
  if (r.total > 0) {
    lines.push("");
    lines.push(
      `规则：${r.total} 条 · 阻断 ${r.blocking} · 仅告警 ${r.warning} · 未声明强制级别 ${r.undeclared}`
      + `（未声明 ≠ 不严重：本体没说就是没说）`,
    );
    lines.push(
      `- 生成器可见（被动作 action_steps 精确引用）：${r.reachableFromActions}/${r.total}`
      + `${r.orphans.length ? ` · 完全未接线 ${r.orphans.length} 条` : ""}`,
    );
    if (r.byExecutor.length) {
      lines.push(`- 执行者：${r.byExecutor.map((e) => `${e.executor} ${e.count}`).join(" · ")}`);
    }
    if (r.byAutomation.length) {
      lines.push(`- 自动化状态：${r.byAutomation.map((a) => `${a.status} ${a.count}`).join(" · ")}`);
    }
    if (r.byClient.length > 1) {
      lines.push(
        `- 客户作用域：${r.byClient.map((c) => `${c.client} ${c.count}（阻断 ${c.blocking}）`).join(" · ")}`,
      );
    }
    if (r.byStage.length) {
      lines.push(`- 场景阶段：${r.byStage.map((x) => `${x.stage} ${x.count}`).join(" · ")}`);
    }
    if (r.duplicateNames.length) {
      lines.push(
        `- 同名不同 id：${r.duplicateNames.map((d) => `${d.name}（${d.ids.join("/")}）`).join(" · ")}`
        + " —— 任何按名字归并的做法都会把不同政策合成一条",
      );
    }
    const attached = r.rules.filter((rule) => rule.referencedByActions.length > 0);
    if (attached.length) {
      const shown = attached.slice(0, maxRules);
      lines.push(
        shown.length < attached.length
          ? `- 已接到动作上的规则（共 ${attached.length} 条，下列为前 ${shown.length} 条）：`
          : "- 已接到动作上的规则：",
      );
      for (const rule of shown) {
        lines.push(
          `  · [${rule.id}] ${rule.name} · ${rule.failurePolicy ?? "强制级别未声明"}`
          + ` · 执行者 ${rule.executor ?? "未声明"}`
          + `${rule.client ? ` · 客户 ${rule.client}` : ""}`
          + ` · 动作 ${rule.referencedByActions.join("、")}`
          + `${rule.governs.length ? ` · 管辖对象 ${rule.governs.join("、")}` : ""}`,
        );
      }
    }
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
