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
  OntologyEvent,
  OntologyLink,
  OntologyObject,
  OntologyWorkflowItem,
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

/** #FIELDS —— 对象【自己的字段】层面的缺陷类别。
 *
 *  以前八种结构缺口全是拓扑层面的（谁连谁、谁引用谁），没有一处读过对象自己声明的字段。
 *  于是「我们的 dataObject 有哪些缺陷」这个问题，分析器一个字都答不出来。
 *
 *  每一类只看本体自己声明的字段（EntitySchema：primary_key / properties[].name /
 *  .type / .is_foreign_key / .references），不做任何命名约定推断——
 *  「叫 xxx_id 所以应该是外键」不是证据，不算缺陷。 */
export type ObjectFieldDefectKind =
  | "missing_primary_key"
  | "no_properties"
  | "property_without_name"
  | "property_without_type"
  | "duplicate_property_name"
  | "primary_key_not_a_property"
  | "foreign_key_without_reference"
  | "foreign_key_dangling_reference";

/** 检查维度的固定清单。逐项实测并全部上报，所以「0 处」读作【查过是 0】，
 *  而不是【这个维度没查】——后者才是真正会骗人的那种 0。 */
export const OBJECT_FIELD_DEFECT_KINDS: readonly ObjectFieldDefectKind[] = [
  "missing_primary_key",
  "no_properties",
  "property_without_name",
  "property_without_type",
  "duplicate_property_name",
  "primary_key_not_a_property",
  "foreign_key_without_reference",
  "foreign_key_dangling_reference",
];

export interface ObjectFieldDefect {
  kind: ObjectFieldDefectKind;
  /** 出问题的那一处声明：`Object` 或 `Object.property`。 */
  subject: string;
  detail: string;
}

export interface ObjectFieldProfile {
  id: string;
  /** 只在与 id 不同时保留。 */
  name: string | null;
  /** null 表示【本体没有声明主键】，绝不兜底成 id。 */
  primaryKey: string | null;
  properties: number;
  typedProperties: number;
  foreignKeys: number;
  /** 这个对象命中的缺陷类别，去重。 */
  defects: ObjectFieldDefectKind[];
}

export interface ObjectFieldAnalysis {
  objects: number;
  properties: number;
  /** is_foreign_key===true 的属性数。 */
  foreignKeys: number;
  objectsWithPrimaryKey: number;
  /** 一个缺陷都没有的对象数。 */
  cleanObjects: number;
  /** 每个维度的实测计数——包括 0。 */
  checked: Array<{ kind: ObjectFieldDefectKind; count: number }>;
  defects: ObjectFieldDefect[];
  profiles: ObjectFieldProfile[];
}

/** #AGENT-CONSISTENCY —— 已生成 agent 与本体的一致性核对项。
 *
 *  覆盖率（哪些动作有了 agent）早就有了；一致性（生成出来的东西和本体哪里对不上）一直没有。
 *  这四项都能不带任何业务判断地判定，因为两边都是【声明】。 */
export type AgentConsistencyCheckKind =
  /** agent 的 tool_use 里有本体任何动作步骤都没调用过的工具。 */
  | "agent_tool_not_declared_by_ontology"
  /** 本体动作步骤声明要用的工具，没有任何已生成 agent 声明它。 */
  | "ontology_tool_without_agent"
  /** agent 声明绑定的本体动作，在当前本体里已经不存在。 */
  | "agent_action_missing_from_ontology"
  /** agent 产出的事件不在本体事件目录里。 */
  | "agent_event_not_in_catalog";

export interface AgentConsistencyFinding {
  subject: string;
  detail: string;
  /** 支撑这条发现的具体名字（agent 名 / 动作名），让它可核查。 */
  refs: string[];
}

export interface AgentConsistencyCheck {
  kind: AgentConsistencyCheckKind;
  /** `not_checkable` = 比对的某一侧根本不存在。绝不写成「一致」。 */
  state: "checked" | "not_checkable";
  /** state 为 not_checkable 时说明缺的是哪一侧；checked 时为 null。 */
  blockedReason: string | null;
  /** 这次真正扫过的声明条数，让「0 处不一致」可读。 */
  scanned: number;
  findings: AgentConsistencyFinding[];
}

export interface AgentOntologyConsistency {
  /** 随本体一起提供的已生成 agent 数（workflow 清单）。 */
  agents: number;
  /** 声明绑定能落到某个本体动作上的 agent 数。 */
  boundAgents: number;
  /** 全部检查项都无法核对时为 not_checkable。 */
  state: "checked" | "not_checkable";
  blockedReason: string | null;
  checks: AgentConsistencyCheck[];
  /** 只统计真正核对过的检查项。 */
  totalFindings: number;
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
    | "no_agent_actions"
    /** #FIELDS —— 对象自身字段声明有缺陷。只在实测到缺陷时构造。 */
    | "object_field_defects"
    /** #AGENT-CONSISTENCY —— 已生成 agent 与本体对不上。只在实测到不一致时构造。 */
    | "agents_inconsistent_with_ontology";
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
  /** #FIELDS —— 对象自身字段维度的完整读数。每个维度都实测，0 是查过的 0。 */
  objectFields: ObjectFieldAnalysis;
  /** #AGENT-CONSISTENCY —— 已生成 agent 与本体的一致性核对。 */
  agentConsistency: AgentOntologyConsistency;
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

/** 唯一的「这是一个已声明的字符串吗」判定。空串/非串一律 null——
 *  下游据此报「未声明」，而不是替本体兜底一个值。 */
function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 读一个可能是 `["a"]` / `"a"` / `[{name:"a"}]` 的声明列表。 */
function declaredNames(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  const names: string[] = [];
  for (const entry of entries) {
    const name =
      textValue(entry) ??
      textValue((entry as Record<string, unknown> | null)?.name);
    if (name) names.push(name);
  }
  return names;
}

// ── #RULES —— 规则维度 ────────────────────────────────────────────────────────

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
        const id = textValue(row.id) ?? textValue(row.rule_id) ?? textValue(row.name);
        if (id) refs.push(id);
        continue;
      }
      const scalar = textValue(entry);
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
    const id = textValue(rule.id) ?? textValue(rule.rule_id) ?? textValue(rule.name) ?? `rule:${index + 1}`;
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
      const name = textValue(entry) ?? textValue((entry as Record<string, unknown> | null)?.id);
      if (!name) continue;
      (objectIds.has(name) ? governs : dangling).push(name);
    }
    facets.push({
      id,
      name: textValue(rule.businessLogicRuleName) ?? textValue(rule.name) ?? id,
      // null 一律保留为 null：本体没说，就不要替它说。
      enforcementLevel: textValue(rule.enforcementLevel),
      failurePolicy: textValue(rule.failurePolicy),
      executor: textValue(rule.executor),
      automationStatus: textValue(rule.automationStatus),
      client: textValue(rule.applicableClient) ?? textValue(rule.belongsToClient),
      department: textValue(rule.applicableDepartment) ?? textValue(rule.belongsToDepartment),
      stage: textValue(rule.specificScenarioStage),
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

// ── #FIELDS —— 对象字段维度 ───────────────────────────────────────────────────

/**
 * 逐个对象读它【自己声明的字段】。八个维度全部实测并全部上报，包括计数为 0 的那些——
 * 因为「这个维度查过、是 0」和「这个维度从来没人看过」在生成前是完全不同的两件事，
 * 而以前的分析器只有后者。
 *
 * 判定只依据本体自己写下的字段（primary_key / properties[].name / .type /
 * .is_foreign_key / .references）。不做命名约定推断，也不把「像外键」当成外键。
 */
export function analyzeObjectFields(
  objects: OntologyObject[],
  knownObjectIds: Set<string>,
): ObjectFieldAnalysis {
  const defects: ObjectFieldDefect[] = [];
  const profiles: ObjectFieldProfile[] = [];
  let properties = 0;
  let foreignKeys = 0;
  let objectsWithPrimaryKey = 0;
  let cleanObjects = 0;

  for (const [index, raw] of objects.entries()) {
    const object = (raw ?? {}) as unknown as Record<string, unknown>;
    const id = textValue(object.id) ?? `object:${index + 1}`;
    const name = textValue(object.name);
    const primaryKey = textValue(object.primary_key);
    const rawProperties = Array.isArray(object.properties)
      ? (object.properties as unknown[])
      : [];
    const own: ObjectFieldDefectKind[] = [];
    const note = (
      kind: ObjectFieldDefectKind,
      subject: string,
      detail: string,
    ) => {
      defects.push({ kind, subject, detail });
      if (!own.includes(kind)) own.push(kind);
    };

    if (primaryKey) objectsWithPrimaryKey += 1;
    else {
      note(
        "missing_primary_key",
        id,
        "对象没有声明 primary_key：一行数据的身份无法确定，按主键读取、更新与幂等去重都生成不出来。",
      );
    }
    if (rawProperties.length === 0) {
      note(
        "no_properties",
        id,
        "对象没有声明任何 properties：只有一个名字，没有可读写的字段。",
      );
    }

    const seen = new Map<string, number>();
    let typedProperties = 0;
    let objectForeignKeys = 0;
    for (const [propertyIndex, rawProperty] of rawProperties.entries()) {
      properties += 1;
      const property = (
        rawProperty && typeof rawProperty === "object" ? rawProperty : {}
      ) as Record<string, unknown>;
      const propertyName = textValue(property.name);
      if (!propertyName) {
        note(
          "property_without_name",
          `${id}[${propertyIndex + 1}]`,
          "属性没有声明 name：这一列无法被任何生成出来的代码引用。",
        );
        continue;
      }
      const subject = `${id}.${propertyName}`;
      seen.set(propertyName, (seen.get(propertyName) ?? 0) + 1);
      if (textValue(property.type)) typedProperties += 1;
      else {
        note(
          "property_without_type",
          subject,
          "属性没有声明 type：既生成不出校验，也无法判断它能不能参与比较与匹配。",
        );
      }
      if (property.is_foreign_key === true) {
        objectForeignKeys += 1;
        foreignKeys += 1;
        const reference = textValue(property.references);
        if (!reference) {
          note(
            "foreign_key_without_reference",
            subject,
            "属性声明为外键（is_foreign_key）却没有 references：指向哪个对象没有说明，连接无法生成。",
          );
        } else if (!knownObjectIds.has(reference)) {
          note(
            "foreign_key_dangling_reference",
            subject,
            `外键指向「${reference}」，但本体里没有这个对象——按它生成的连接会落空。`,
          );
        }
      }
    }
    for (const [propertyName, count] of seen) {
      if (count > 1) {
        note(
          "duplicate_property_name",
          `${id}.${propertyName}`,
          `同名属性出现 ${count} 次：读到哪一条取决于解析顺序，不是可确定的语义。`,
        );
      }
    }
    if (primaryKey && rawProperties.length > 0 && !seen.has(primaryKey)) {
      note(
        "primary_key_not_a_property",
        `${id}:${primaryKey}`,
        `primary_key 声明为「${primaryKey}」，但 properties 里没有同名字段——主键在这个对象上取不到值。`,
      );
    }

    if (own.length === 0) cleanObjects += 1;
    profiles.push({
      id,
      name: name && name !== id ? name : null,
      primaryKey,
      properties: rawProperties.length,
      typedProperties,
      foreignKeys: objectForeignKeys,
      defects: own,
    });
  }

  return {
    objects: objects.length,
    properties,
    foreignKeys,
    objectsWithPrimaryKey,
    cleanObjects,
    checked: OBJECT_FIELD_DEFECT_KINDS.map((kind) => ({
      kind,
      count: defects.filter((defect) => defect.kind === kind).length,
    })),
    defects,
    profiles,
  };
}

// ── #AGENT-CONSISTENCY —— 已生成 agent 对不对得上本体 ─────────────────────────

interface GeneratedAgentFacts {
  name: string;
  /** 声明绑定到哪个本体动作：factory_action_name 是显式声明，缺省时只能按同名推断。 */
  boundAction: string;
  bindingDeclared: boolean;
  tools: string[];
  emits: string[];
}

/** 已生成 agent 就在本体自己带的 workflow 清单里（manifest 源把 models/<域>/workflow*.json
 *  原样挂在 DomainOntology.workflow 上）。Allmeta 域不带这个清单，于是 workflow 为空——
 *  那时正确的回答是「无法核对」，不是「一致」。 */
function readGeneratedAgents(
  workflow: OntologyWorkflowItem[],
): GeneratedAgentFacts[] {
  const agents: GeneratedAgentFacts[] = [];
  for (const raw of workflow ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const name = textValue(row.name);
    if (!name) continue;
    const declared = textValue(row.factory_action_name);
    agents.push({
      name,
      boundAction: declared ?? name,
      bindingDeclared: declared !== null,
      tools: [...new Set(declaredNames(row.tool_use))].sort(),
      emits: [...new Set(declaredNames(row.triggered_event))].sort(),
    });
  }
  return agents;
}

/** 本体侧声明过的工具：动作的 tool_use[] 与 action_steps[].tool。 */
function ontologyToolDeclarations(
  actions: OntologyAction[],
): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  const add = (tool: string, action: string) => {
    byTool.set(tool, [...(byTool.get(tool) ?? []), action]);
  };
  for (const action of actions) {
    for (const tool of declaredNames(action.tool_use)) add(tool, action.name);
    for (const rawStep of (action.action_steps ?? []) as unknown[]) {
      if (!rawStep || typeof rawStep !== "object") continue;
      const tool = textValue((rawStep as Record<string, unknown>).tool);
      if (tool) add(tool, action.name);
    }
  }
  return byTool;
}

/**
 * 核对已生成 agent 与本体的一致性。四项检查都只比对【双方各自声明】的东西，
 * 不含任何业务判断。
 *
 * 每一项都会先看比对的另一侧在不在：另一侧不存在时判 `not_checkable` 并说明缺什么，
 * 绝不把「没得比」渲染成「没问题」——那正是这套分析要修的毛病。
 */
export function analyzeAgentConsistency(
  actions: OntologyAction[],
  events: OntologyEvent[],
  workflow: OntologyWorkflowItem[],
): AgentOntologyConsistency {
  const agents = readGeneratedAgents(workflow);
  const ontologyTools = ontologyToolDeclarations(actions);
  const actionNames = new Set(
    actions.map((action) => action.name).filter((name) => Boolean(name)),
  );
  const eventNames = new Set(
    events.map((event) => event.name).filter((name) => Boolean(name)),
  );

  const agentsByTool = new Map<string, string[]>();
  const agentsByEmit = new Map<string, string[]>();
  for (const agent of agents) {
    for (const tool of agent.tools) {
      agentsByTool.set(tool, [...(agentsByTool.get(tool) ?? []), agent.name]);
    }
    for (const emit of agent.emits) {
      agentsByEmit.set(emit, [...(agentsByEmit.get(emit) ?? []), agent.name]);
    }
  }

  const noAgents =
    agents.length === 0
      ? "该域没有随本体提供已生成的 agent 清单（workflow 为空）：没有可比对的一侧，无法核对——这不等于「一致」。"
      : null;
  const noOntologyTools =
    ontologyTools.size === 0
      ? `本体的 ${actions.length} 个动作没有任何一处声明工具（action_steps[].tool / tool_use 都是空的）：没有可比对的一侧，无法判断 agent 声明的工具是否越界。`
      : null;
  const noActions =
    actionNames.size === 0 ? "本体没有动作定义，无法核对 agent 的绑定。" : null;
  const noEventCatalog =
    eventNames.size === 0
      ? "本体没有事件目录（events 为空）：无法判断 agent 产出的事件是否在册。"
      : null;

  const check = (
    kind: AgentConsistencyCheckKind,
    blockedReason: string | null,
    scanned: number,
    findings: AgentConsistencyFinding[],
  ): AgentConsistencyCheck =>
    blockedReason
      ? { kind, state: "not_checkable", blockedReason, scanned: 0, findings: [] }
      : { kind, state: "checked", blockedReason: null, scanned, findings };

  const checks: AgentConsistencyCheck[] = [
    check(
      "agent_tool_not_declared_by_ontology",
      noAgents ?? noOntologyTools,
      agentsByTool.size,
      [...agentsByTool.entries()]
        .filter(([tool]) => !ontologyTools.has(tool))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([tool, owners]) => ({
          subject: tool,
          detail: `agent ${owners.join("、")} 声明使用工具「${tool}」，但本体没有任何动作步骤调用它——这一步的业务依据在本体里找不到。`,
          refs: [...new Set(owners)].sort(),
        })),
    ),
    check(
      "ontology_tool_without_agent",
      noAgents ?? noOntologyTools,
      ontologyTools.size,
      [...ontologyTools.entries()]
        .filter(([tool]) => !agentsByTool.has(tool))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([tool, owners]) => ({
          subject: tool,
          detail: `本体动作 ${[...new Set(owners)].sort().join("、")} 的步骤声明要用工具「${tool}」，但没有任何已生成 agent 声明它——这一步没有被生成出来。`,
          refs: [...new Set(owners)].sort(),
        })),
    ),
    check(
      "agent_action_missing_from_ontology",
      noAgents ?? noActions,
      agents.length,
      agents
        .filter((agent) => !actionNames.has(agent.boundAction))
        .map((agent) => ({
          subject: agent.name,
          detail:
            `agent 绑定的本体动作「${agent.boundAction}」在当前本体里不存在` +
            (agent.bindingDeclared
              ? "（factory_action_name 显式声明）。"
              : "（该 agent 没有声明 factory_action_name，这里按同名推断绑定）。") +
            "本体改过之后没有同步重生成，或者这个 agent 从一开始就没有本体依据。",
          refs: [agent.name, agent.boundAction],
        })),
    ),
    check(
      "agent_event_not_in_catalog",
      noAgents ?? noEventCatalog,
      agentsByEmit.size,
      [...agentsByEmit.entries()]
        .filter(([event]) => !eventNames.has(event))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([event, owners]) => ({
          subject: event,
          detail: `agent ${owners.join("、")} 产出事件「${event}」，但它不在本体事件目录里——下游没有任何声明过的消费方。`,
          refs: [...new Set(owners)].sort(),
        })),
    ),
  ];

  const checkable = checks.filter((entry) => entry.state === "checked");
  return {
    agents: agents.length,
    boundAgents: agents.filter((agent) => actionNames.has(agent.boundAction))
      .length,
    state: checkable.length === 0 ? "not_checkable" : "checked",
    blockedReason:
      checkable.length === 0
        ? (noAgents ??
          noActions ??
          checks.find((entry) => entry.blockedReason)?.blockedReason ??
          null)
        : null,
    checks,
    totalFindings: checkable.reduce(
      (sum, entry) => sum + entry.findings.length,
      0,
    ),
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
  // 对象身份的唯一口径：id 与 name 都算数（规则与外键两处引用都可能用任一种写法）。
  const objectIdUniverse = new Set(
    objects.flatMap((o) =>
      [o.id, o.name].filter((v): v is string => Boolean(v)),
    ),
  );
  const ruleAnalysis = analyzeRules(
    rules as Array<Record<string, unknown>>,
    actions,
    objectIdUniverse,
    ruleEndpointIds,
  );
  // #FIELDS —— 对象自己的字段。#AGENT-CONSISTENCY —— 生成物与本体的对照。
  const objectFields = analyzeObjectFields(objects, objectIdUniverse);
  const agentConsistency = analyzeAgentConsistency(
    actions,
    events,
    ontology.workflow ?? [],
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
  // #FIELDS —— 只在实测到缺陷时构造。每个维度的计数（含 0）在 objectFields.checked 里，
  // 所以「没有这条 gap」读作「八个维度都查过、都是 0」，而不是「没查」。
  if (objectFields.defects.length > 0) {
    const fired = objectFields.checked.filter((entry) => entry.count > 0);
    gaps.push({
      kind: "object_field_defects",
      detail:
        `${objectFields.defects.length} 处对象字段级缺陷（${fired.map((e) => `${e.kind} ${e.count}`).join("、")}）。`
        + "这些是对象自己的声明问题——主键、属性、类型、外键指向缺任何一样，"
        + "按它生成的读写就落不了地，而拓扑层面的检查一个都发现不了。",
      subjects: objectFields.defects
        .slice(0, 20)
        .map((defect) => `${defect.subject}（${defect.kind}）`),
    });
  }
  // #AGENT-CONSISTENCY —— 同理：只在真正核对过并发现不一致时构造。
  // 「无法核对」不进 gaps，而是由 agentConsistency.state 如实报出，避免被读成「一致」。
  if (agentConsistency.totalFindings > 0) {
    const firedChecks = agentConsistency.checks.filter(
      (entry) => entry.state === "checked" && entry.findings.length > 0,
    );
    gaps.push({
      kind: "agents_inconsistent_with_ontology",
      detail:
        `已生成的 ${agentConsistency.agents} 个 agent 与本体有 ${agentConsistency.totalFindings} 处对不上`
        + `（${firedChecks.map((e) => `${e.kind} ${e.findings.length}`).join("、")}）。`
        + "两边都是声明，对不上就是对不上：要么本体改过之后没重生成，要么 agent 做了本体没写的事。",
      subjects: firedChecks
        .flatMap((entry) =>
          entry.findings.map((finding) => `${finding.subject}（${entry.kind}）`),
        )
        .slice(0, 20),
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
    objectFields,
    agentConsistency,
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
  opts: {
    maxEntities?: number;
    maxChains?: number;
    maxRules?: number;
    maxFieldDefects?: number;
    maxConsistencyFindings?: number;
  } = {},
): string {
  const maxEntities = opts.maxEntities ?? 25;
  const maxChains = opts.maxChains ?? 12;
  const maxRules = opts.maxRules ?? 24;
  const maxFieldDefects = opts.maxFieldDefects ?? 20;
  const maxConsistencyFindings = opts.maxConsistencyFindings ?? 8;
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
  // #FIELDS —— 对象自己的字段。以前模型看到的只有对象名和连接度，
  // 主键/属性/类型/外键指向一个都没有，于是「dataObject 有什么缺陷」根本无从答起。
  const f = analysis.objectFields;
  if (f.objects > 0) {
    lines.push("");
    lines.push(
      `对象字段：${f.objects} 个对象 · ${f.properties} 个属性 · 外键声明 ${f.foreignKeys}`
      + ` · 已声明主键 ${f.objectsWithPrimaryKey}/${f.objects} · 无字段缺陷 ${f.cleanObjects}/${f.objects}`,
    );
    const fired = f.checked.filter((entry) => entry.count > 0);
    lines.push(
      fired.length
        ? `- 字段级缺陷 ${f.defects.length} 处：${fired.map((e) => `${e.kind} ${e.count}`).join(" · ")}`
        : `- 字段级缺陷 0 处。这 ${f.checked.length} 个维度逐项查过：${f.checked.map((e) => e.kind).join("、")}`
          + " —— 是「查过是 0」，不是「没查」。",
    );
    const shownDefects = f.defects.slice(0, maxFieldDefects);
    for (const defect of shownDefects) {
      lines.push(`  · [${defect.kind}] ${defect.subject}：${defect.detail}`);
    }
    if (shownDefects.length < f.defects.length) {
      lines.push(
        `  · （共 ${f.defects.length} 处，上列为前 ${shownDefects.length} 处）`,
      );
    }
  }
  // #AGENT-CONSISTENCY —— 生成物与本体的对照。「无法核对」必须原样说出口。
  const c = analysis.agentConsistency;
  lines.push("");
  if (c.state === "not_checkable") {
    lines.push(`生成 agent 一致性：无法核对 —— ${c.blockedReason ?? "缺少可比对的一侧。"}`);
  } else {
    lines.push(
      `生成 agent 一致性：已生成 ${c.agents} 个 agent（绑定能落到本体动作上的 ${c.boundAgents} 个）`
      + ` · 不一致 ${c.totalFindings} 处`,
    );
    for (const entry of c.checks) {
      if (entry.state === "not_checkable") {
        lines.push(`- [${entry.kind}] 无法核对：${entry.blockedReason}`);
        continue;
      }
      const shown = entry.findings.slice(0, maxConsistencyFindings);
      lines.push(
        `- [${entry.kind}] 扫过 ${entry.scanned} 条，发现 ${entry.findings.length} 处`
        + (shown.length
          ? `：${shown.map((finding) => finding.subject).join("、")}`
            + (shown.length < entry.findings.length ? " …" : "")
          : ""),
      );
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
