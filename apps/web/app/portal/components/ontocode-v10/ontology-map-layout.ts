// OntoCode v10 · 地图布局模型。
//
// 输入是权威 Ontology 的那张动作表（`readMapSource` 从分析产物里读出来的四列原文：
// 动作名 / 执行方 / 消费的事件 / 产出的事件）。输出是一组整数坐标 `(分量, 秩, 列, 次序)`
// 和一份守恒账本。渲染层拿着它去画像素——但布局本身不认识像素。
//
// 三条纪律，全部可以被测试钉死：
//
// 1. **纯函数**。没有 Date、没有随机、没有 DOM 或字体度量、不接受容器尺寸。
//    同一份输入永远给出同一份输出（深度相等），所以 resize / 全屏切换永远不必重排。
//    所有遍历的起点与邻接顺序都取自 `ord`（本体的声明序），从不取自 Set/Map 的迭代序。
//
// 2. **零词表**。泳道键就是 `actor[]` 的原文拼接——不测 "agent" 子串、不归类成人或机器、
//    没声明就是空字符串且如实计数。没有任何一处判断依赖动作名、事件名或类别名的字面量。
//    换句话说：把整份本体改名，布局形状一个字节都不会变。
//
// 3. **一条关系都不丢**。`ledger` 是两条硬账本（见 C1/C2），每一条源关系都必须落在
//    「内联进连线 / 晋升成节点的进出边 / 来源端口 / 终点端口 / 自环」五个去处之一。
//    规模超过硬上限时如实失败（`oversized`），绝不前缀切片——切片会让被切掉父节点的
//    节点变成假的起点，是静默的结构说谎。
//
// 环的处理刻意用 Tarjan 强连通分量：SCC 的归属是图的固有性质、缩并图的分层是规范的，
// 「从组内哪儿切一刀」这点任意性被关在了 SCC 内部，不会外溢成「哪条边算回边取决于
// 从谁开始遍历」。

/* -------------------------------- 常量 -------------------------------- */

/** 视图规格里每个名单的长度上限，防止一份跑飞的规格撑爆匹配开销。 */
export const MAX_MAP_VIEW_LABELS = 40;
/** 模型可以附一句话说明看的是哪一段；超过即视为不合规格，不截半句。 */
export const MAX_MAP_VIEW_NOTE_CHARS = 120;
/** 焦点邻域的跳数上限。 */
export const MAX_MAP_VIEW_RADIUS = 8;
/** 泳道数上限；超过即整体退化为一条道（仍然一个节点都不丢）。 */
export const MAX_LANES = 6;
/** 病理输入护栏。超过即如实失败，不切片。 */
export const HARD_NODE_LIMIT = 2000;
/** 层内排序的轮数；每轮一趟向下、一趟向上。 */
const SWEEPS = 4;

export const MAP_VIEW_SCHEMA_V1 = "ontocode-ontology-map-view/v1";
export const MAP_VIEW_SCHEMA_V2 = "ontocode-ontology-map-view/v2";

/* -------------------------------- 类型 -------------------------------- */

export interface MapSourceRow {
  action: string;
  actor: string[];
  triggers: string[];
  emits: string[];
}
export interface MapSource {
  rows: MapSourceRow[];
  sourceTruncated: boolean;
}

export type MapViewDirection = "downstream" | "upstream" | "both";

export interface OntologyMapViewSpec {
  schema: typeof MAP_VIEW_SCHEMA_V1 | typeof MAP_VIEW_SCHEMA_V2;
  /** 从这些节点出发，按 direction/radius 取邻域。 */
  focus: string[];
  /** v2：v1 的语义等于 "downstream"。 */
  direction: MapViewDirection;
  /** v2：跳数上限；null = 不限跳 = v1 语义。纯节点集操作，不决定画多细。 */
  radius: number | null;
  /** 精确白名单。 */
  only: string[];
  /** v2：只保留这些执行方的道，按本体自己声明的值精确匹配。 */
  lanes: string[];
  /** 只加标记，绝不改变取舍。 */
  highlight: string[];
  /** 名单超过上限、因此没有参与匹配的那些原文。绝不静默切片。 */
  omitted: string[];
  note: string | null;
}

export interface AppliedMapView {
  applied: boolean;
  focus: string[];
  direction: MapViewDirection;
  radius: number | null;
  only: string[];
  lanes: string[];
  highlight: string[];
  /** 规格点名、但本体里根本没有的标签/道。如实列出，不静默忽略。 */
  unmatched: string[];
  /** 名单超过上限、没有参与匹配的原文。 */
  omitted: string[];
  note: string | null;
}

/** `""` = `actor[]` 为空，即本体没有声明执行方。绝不兜底成任何一边。 */
export type LaneId = string;
export type MapNodeKind = "action" | "event" | "dummy";
export type MapEventRole = "fork" | "merge" | "forkMerge";
export type MapColumnKind = "lane" | "junction";
export type MapEdgeKind = "forward" | "back";

export interface MapNode {
  /** 内部去重键，永不渲染。 */
  key: string;
  kind: MapNodeKind;
  /** 动作名或事件名原文；虚节点为空串。 */
  label: string;
  ord: number;
  /** 弱连通分量序号，按分量内最小 ord 升序编号。 */
  component: number;
  /** 分量内的局部秩，0 起。 */
  rank: number;
  columnKind: MapColumnKind;
  laneId: LaneId | null;
  /** 同一个 (分量, 秩, 列) 单元内的 0 起次序。 */
  index: number;
  loopGroup: number | null;
  inDegree: number;
  outDegree: number;
  /** 无人产出的事件名（挂在消费方）。 */
  entryPorts: string[];
  /** 无人消费的事件名（挂在产出方）。 */
  exitPorts: string[];
  selfLoops: string[];
  eventRole: MapEventRole | null;
  highlighted: boolean;
  focused: boolean;
  /** 渲染层的折叠资格；被点名的节点永不折叠。 */
  foldable: boolean;
}

export interface MapEdge {
  key: string;
  from: string;
  to: string;
  kind: MapEdgeKind;
  /** 这条线承载的事件名。同端点对多个事件时不止一个。 */
  eventLabels: string[];
  /** 两端分属不同的道 —— 一次人机交接。 */
  handoff: boolean;
  /** rank(to) - rank(from)；回边为负；恒不为 0。 */
  span: number;
  /** 虚节点键，rank 升序；span===1 时为空。 */
  waypoints: string[];
  /** 回边的回流沟槽号；前向边为 null。 */
  gutter: number | null;
}

export interface MapLoopGroup {
  id: number;
  component: number;
  memberKeys: string[];
  rankFrom: number;
  rankTo: number;
  laneIds: LaneId[];
  backEdgeKeys: string[];
}
export interface MapComponent {
  id: number;
  nodeKeys: string[];
  rankCount: number;
  actionCount: number;
  edgeCount: number;
}
export interface MapLane {
  id: LaneId;
  order: number;
  actionCount: number;
}
export interface MapColumn {
  kind: MapColumnKind;
  laneId: LaneId | null;
  order: number;
}
export interface OntologyMapCounts {
  nodes: number;
  edges: number;
}

/**
 * 关系守恒账本。三条等式：
 *
 * C1 `2×内联事件 + 晋升事件的进出边 + 来源端口 + 终点端口 + 2×自环 === 源关系数`
 * C2 `前向边 + 回边 === 画出来的边数`
 * C3 `视图收窄掉的关系 + 源关系数 === 全图关系数`
 *
 * C3 是后补的：在它之前，`sourceRelations` 直接取收窄之后的边数，于是
 * 「视图规格把关系筛掉了」这件事在账本里恒等成立、永远发现不了——节点计数
 * 诚实而结构在说谎。现在收窄掉的量必须自己报出来才能配平。
 */
export interface OntologyMapLedger {
  /** 全图（视图规格作用之前）的关系条数。 */
  totalRelations: number;
  /** 被视图规格筛掉、因此这张图上不画的关系条数。 */
  narrowedAwayRelations: number;
  sourceRelations: number;
  inlinedEventLabels: number;
  promotedEventEdges: number;
  entryPorts: number;
  exitPorts: number;
  selfLoops: number;
  forwardEdges: number;
  backEdges: number;
  balanced: boolean;
}

export interface OntologyMapModel {
  nodes: MapNode[];
  edges: MapEdge[];
  columns: MapColumn[];
  lanes: MapLane[];
  components: MapComponent[];
  loopGroups: MapLoopGroup[];
  gutterCount: number;
  counts: {
    /** 视图规格作用之前（二部图口径：节点 = 动作 ∪ 事件，边 = 关系条数）。 */
    total: OntologyMapCounts;
    /** 视图规格作用之后。 */
    narrowed: OntologyMapCounts;
    /** === narrowed：本模块不再截断。 */
    shown: OntologyMapCounts;
  };
  drawn: {
    cards: number;
    eventPills: number;
    dummies: number;
    edges: number;
    ports: number;
  };
  ledger: OntologyMapLedger;
  /** 上游那张分析表在到达浏览器之前就已限幅——此时 total 本身也是低估值。 */
  sourceTruncated: boolean;
  /** 病理输入护栏命中：如实失败，nodes/edges 为空，counts.total 仍然如实。 */
  oversized: boolean;
  /** 恒为 false：本模块永不丢节点。 */
  truncated: false;
  notes: {
    disconnectedComponents: number;
    unlinkedEventLabels: string[];
    duplicateActionLabels: string[];
    undeclaredLaneActionCount: number;
    handoffEdgeCount: number;
    laneMode: "lanes" | "collapsed";
  };
  view: AppliedMapView;
}

/* ------------------------------ 视图规格解析 ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 名单字段。超过上限的部分**不参与匹配**，但原文会被交出来——
 * 静默切片会让「规格点了名却没生效」永远发现不了。
 */
interface LabelList {
  kept: string[];
  omitted: string[];
}

function parseLabelList(value: unknown): LabelList | null {
  if (value === undefined || value === null) return { kept: [], omitted: [] };
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const text = entry.trim();
    if (text) out.push(text);
  }
  return {
    kept: out.slice(0, MAX_MAP_VIEW_LABELS),
    omitted: out.slice(MAX_MAP_VIEW_LABELS),
  };
}

const DIRECTIONS: MapViewDirection[] = ["downstream", "upstream", "both"];

/**
 * 校验一份模型给的视图规格。任何一处不合规就整份判 null，由调用方退回「看全图」
 * ——绝不半信半疑地采纳一半。v1 规格照收，缺的三个字段补上 v1 自己的语义。
 */
export function parseOntologyMapViewSpec(
  raw: unknown,
): OntologyMapViewSpec | null {
  if (!isRecord(raw)) return null;
  if (raw.schema !== MAP_VIEW_SCHEMA_V1 && raw.schema !== MAP_VIEW_SCHEMA_V2) {
    return null;
  }
  const focus = parseLabelList(raw.focus);
  const only = parseLabelList(raw.only);
  const lanes = parseLabelList(raw.lanes);
  const highlight = parseLabelList(raw.highlight);
  if (focus === null || only === null || lanes === null || highlight === null) {
    return null;
  }
  // 收集顺序固定：focus → only → lanes → highlight，与 unmatched 一致。
  const omitted = [
    ...focus.omitted,
    ...only.omitted,
    ...lanes.omitted,
    ...highlight.omitted,
  ];

  let direction: MapViewDirection = "downstream";
  if (raw.direction !== undefined && raw.direction !== null) {
    const candidate = DIRECTIONS.find((entry) => entry === raw.direction);
    if (!candidate) return null;
    direction = candidate;
  }

  let radius: number | null = null;
  if (raw.radius !== undefined && raw.radius !== null) {
    if (
      typeof raw.radius !== "number" ||
      !Number.isInteger(raw.radius) ||
      raw.radius < 0 ||
      raw.radius > MAX_MAP_VIEW_RADIUS
    ) {
      return null;
    }
    radius = raw.radius;
  }

  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") return null;
    const text = raw.note.trim();
    if (text.length > MAX_MAP_VIEW_NOTE_CHARS) return null;
    note = text || null;
  }

  return {
    schema: raw.schema,
    focus: focus.kept,
    direction,
    radius,
    only: only.kept,
    lanes: lanes.kept,
    highlight: highlight.kept,
    omitted,
    note,
  };
}

const NO_VIEW: AppliedMapView = {
  applied: false,
  focus: [],
  direction: "downstream",
  radius: null,
  only: [],
  lanes: [],
  highlight: [],
  unmatched: [],
  omitted: [],
  note: null,
};

function noView(): AppliedMapView {
  return { ...NO_VIEW };
}

/* ------------------------- S0 · 读行、合并、定 ord ------------------------- */

function dedupPreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

interface MergedRow {
  action: string;
  actor: string[];
  triggers: string[];
  emits: string[];
  /** 泳道键：`actor[]` 去空去重按声明序拼接。零词表、零兜底。 */
  laneKey: LaneId;
}

interface BipartiteNode {
  key: string;
  kind: "action" | "event";
  label: string;
  ord: number;
  laneKey: LaneId | null;
}
interface BipartiteEdge {
  from: string;
  to: string;
  event: string;
}
interface Bipartite {
  nodes: BipartiteNode[];
  edges: BipartiteEdge[];
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((entry) => {
    const text = typeof entry === "string" ? entry.trim() : "";
    return text ? [text] : [];
  });
}

function mergeRows(rows: MapSourceRow[]): {
  merged: MergedRow[];
  duplicateActionLabels: string[];
} {
  const byLabel = new Map<string, MergedRow>();
  const order: string[] = [];
  const duplicates: string[] = [];
  for (const raw of rows) {
    const label = typeof raw?.action === "string" ? raw.action.trim() : "";
    if (!label) continue;
    const actor = cleanList(raw.actor);
    const triggers = cleanList(raw.triggers);
    const emits = cleanList(raw.emits);
    const existing = byLabel.get(label);
    if (!existing) {
      byLabel.set(label, { action: label, actor, triggers, emits, laneKey: "" });
      order.push(label);
      continue;
    }
    if (!duplicates.includes(label)) duplicates.push(label);
    existing.actor = existing.actor.concat(actor);
    existing.triggers = existing.triggers.concat(triggers);
    existing.emits = existing.emits.concat(emits);
  }
  const merged = order.map((label) => {
    const row = byLabel.get(label) as MergedRow;
    const actor = dedupPreserveOrder(row.actor);
    return {
      action: row.action,
      actor,
      triggers: dedupPreserveOrder(row.triggers),
      emits: dedupPreserveOrder(row.emits),
      laneKey: actor.join("+"),
    };
  });
  return { merged, duplicateActionLabels: duplicates };
}

/**
 * ord 是全序的唯一仲裁者：先按声明序给全部动作编号，再按事件首次出现
 * （每行先 triggers 后 emits，格内保持数组序）给事件编号。
 */
function readBipartite(merged: MergedRow[]): Bipartite {
  const nodes: BipartiteNode[] = [];
  const seen = new Map<string, BipartiteNode>();
  const remember = (node: BipartiteNode) => {
    if (seen.has(node.key)) return;
    seen.set(node.key, node);
    nodes.push(node);
  };

  for (const row of merged) {
    remember({
      key: `a:${row.action}`,
      kind: "action",
      label: row.action,
      ord: nodes.length,
      laneKey: row.laneKey,
    });
  }
  for (const row of merged) {
    for (const event of row.triggers.concat(row.emits)) {
      remember({
        key: `e:${event}`,
        kind: "event",
        label: event,
        ord: nodes.length,
        laneKey: null,
      });
    }
  }

  const edges: BipartiteEdge[] = [];
  for (const row of merged) {
    const actionKey = `a:${row.action}`;
    for (const event of row.triggers) {
      edges.push({ from: `e:${event}`, to: actionKey, event });
    }
    for (const event of row.emits) {
      edges.push({ from: actionKey, to: `e:${event}`, event });
    }
  }
  return { nodes, edges };
}

/* --------------------------- S1 · 按视图规格收窄 --------------------------- */

function restrict(graph: Bipartite, keep: Set<string>): Bipartite {
  return {
    nodes: graph.nodes.filter((node) => keep.has(node.key)),
    edges: graph.edges.filter(
      (edge) => keep.has(edge.from) && keep.has(edge.to),
    ),
  };
}

function neighbourhood(
  graph: Bipartite,
  seeds: string[],
  direction: MapViewDirection,
  radius: number | null,
): Set<string> {
  const out = new Map<string, string[]>();
  const inbound = new Map<string, string[]>();
  for (const edge of graph.edges) {
    (out.get(edge.from) ?? out.set(edge.from, []).get(edge.from)!).push(
      edge.to,
    );
    (
      inbound.get(edge.to) ?? inbound.set(edge.to, []).get(edge.to)!
    ).push(edge.from);
  }
  const seen = new Set<string>(seeds);
  let frontier = [...new Set(seeds)];
  let hops = 0;
  while (frontier.length > 0 && (radius === null || hops < radius)) {
    const next: string[] = [];
    for (const key of frontier) {
      const forward = direction === "upstream" ? [] : (out.get(key) ?? []);
      const backward = direction === "downstream" ? [] : (inbound.get(key) ?? []);
      for (const target of forward.concat(backward)) {
        if (seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    frontier = next;
    hops += 1;
  }
  return seen;
}

interface Narrowed {
  graph: Bipartite;
  view: AppliedMapView;
}

function applyView(
  graph: Bipartite,
  spec: OntologyMapViewSpec | null,
): Narrowed {
  if (!spec) return { graph, view: noView() };
  const asked =
    spec.focus.length +
      spec.only.length +
      spec.lanes.length +
      spec.highlight.length +
      spec.omitted.length >
      0 || spec.note !== null;
  if (!asked) return { graph, view: noView() };

  const index = new Map<string, string>();
  for (const node of graph.nodes) {
    if (!index.has(node.label)) index.set(node.label, node.key);
  }
  const declaredLanes = new Set(
    graph.nodes.flatMap((node) => (node.laneKey === null ? [] : [node.laneKey])),
  );

  // 未匹配的收集顺序固定：focus → only → lanes → highlight。
  const unmatched: string[] = [];
  const resolve = (wanted: string[]): string[] =>
    wanted.flatMap((label) => {
      const key = index.get(label);
      if (key) return [key];
      unmatched.push(label);
      return [];
    });

  const focusKeys = resolve(spec.focus);
  const onlyKeys = resolve(spec.only);
  for (const lane of spec.lanes) {
    if (!declaredLanes.has(lane)) unmatched.push(lane);
  }
  resolve(spec.highlight);

  let current = graph;
  if (spec.focus.length > 0) {
    current = restrict(
      current,
      neighbourhood(current, focusKeys, spec.direction, spec.radius),
    );
  }
  if (spec.only.length > 0) {
    current = restrict(current, new Set(onlyKeys));
  }
  if (spec.lanes.length > 0) {
    const wanted = new Set(spec.lanes);
    const actions = new Set(
      current.nodes.flatMap((node) =>
        node.laneKey !== null && wanted.has(node.laneKey) ? [node.key] : [],
      ),
    );
    // 邻接的事件跟着留下来，否则一条边的两端会被拆散。
    const adjacent = new Set(actions);
    for (const edge of current.edges) {
      if (actions.has(edge.from)) adjacent.add(edge.to);
      if (actions.has(edge.to)) adjacent.add(edge.from);
    }
    current = restrict(current, adjacent);
  }

  return {
    graph: current,
    view: {
      applied: true,
      focus: spec.focus,
      direction: spec.direction,
      radius: spec.radius,
      only: spec.only,
      lanes: spec.lanes,
      highlight: spec.highlight,
      unmatched,
      omitted: spec.omitted,
      note: spec.note,
    },
  };
}

/* ------------------------- S2 · 事件分类 → 动作图 ------------------------- */

interface G1Node {
  key: string;
  kind: "action" | "event";
  label: string;
  ord: number;
  laneKey: LaneId | null;
  eventRole: MapEventRole | null;
  entryPorts: string[];
  exitPorts: string[];
  selfLoops: string[];
}
interface G1Edge {
  key: string;
  from: string;
  to: string;
  eventLabels: string[];
}
interface G1 {
  nodes: G1Node[];
  edges: G1Edge[];
  inlinedEventLabels: number;
  promotedEventEdges: number;
  entryPorts: number;
  exitPorts: number;
  selfLoops: number;
  unlinkedEventLabels: string[];
}

function condense(graph: Bipartite): G1 {
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const actions = graph.nodes.filter((node) => node.kind === "action");
  const events = graph.nodes.filter((node) => node.kind === "event");

  const producers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) continue;
    if (from.kind === "action") {
      const list = producers.get(to.key) ?? [];
      if (!list.includes(from.key)) list.push(from.key);
      producers.set(to.key, list);
    } else {
      const list = consumers.get(from.key) ?? [];
      if (!list.includes(to.key)) list.push(to.key);
      consumers.set(from.key, list);
    }
  }

  const make = (node: BipartiteNode): G1Node => ({
    key: node.key,
    kind: node.kind,
    label: node.label,
    ord: node.ord,
    laneKey: node.laneKey,
    eventRole: null,
    entryPorts: [],
    exitPorts: [],
    selfLoops: [],
  });

  const nodes = new Map<string, G1Node>();
  for (const action of actions) nodes.set(action.key, make(action));

  const byOrd = (a: string, b: string) =>
    (byKey.get(a)?.ord ?? 0) - (byKey.get(b)?.ord ?? 0);

  const inline = new Map<string, G1Edge>();
  const promoted: G1Edge[] = [];
  let inlinedEventLabels = 0;
  let promotedEventEdges = 0;
  let entryPortCount = 0;
  let exitPortCount = 0;
  let selfLoopCount = 0;
  const unlinkedEventLabels: string[] = [];

  for (const event of events) {
    const P = [...(producers.get(event.key) ?? [])].sort(byOrd);
    const C = [...(consumers.get(event.key) ?? [])].sort(byOrd);

    if (P.length >= 2 || C.length >= 2) {
      const node = make(event);
      node.eventRole =
        P.length >= 2 && C.length >= 2
          ? "forkMerge"
          : P.length >= 2
            ? "merge"
            : "fork";
      nodes.set(event.key, node);
      for (const producer of P) {
        promoted.push({
          key: `${producer}>${event.key}`,
          from: producer,
          to: event.key,
          eventLabels: [event.label],
        });
      }
      for (const consumer of C) {
        promoted.push({
          key: `${event.key}>${consumer}`,
          from: event.key,
          to: consumer,
          eventLabels: [event.label],
        });
      }
      promotedEventEdges += P.length + C.length;
      continue;
    }

    if (P.length === 1 && C.length === 1) {
      if (P[0] === C[0]) {
        nodes.get(P[0]!)?.selfLoops.push(event.label);
        selfLoopCount += 1;
        continue;
      }
      const key = `${P[0]}>${C[0]}`;
      const existing = inline.get(key);
      if (existing) existing.eventLabels.push(event.label);
      else {
        inline.set(key, {
          key,
          from: P[0]!,
          to: C[0]!,
          eventLabels: [event.label],
        });
      }
      inlinedEventLabels += 1;
      continue;
    }

    if (P.length === 0 && C.length === 1) {
      nodes.get(C[0]!)?.entryPorts.push(event.label);
      entryPortCount += 1;
      continue;
    }
    if (P.length === 1 && C.length === 0) {
      nodes.get(P[0]!)?.exitPorts.push(event.label);
      exitPortCount += 1;
      continue;
    }
    unlinkedEventLabels.push(event.label);
  }

  const orderedNodes = [...nodes.values()].sort((a, b) => a.ord - b.ord);
  const ordOf = new Map(orderedNodes.map((node) => [node.key, node.ord]));
  const edges = [...inline.values(), ...promoted].sort(
    (a, b) =>
      (ordOf.get(a.from) ?? 0) - (ordOf.get(b.from) ?? 0) ||
      (ordOf.get(a.to) ?? 0) - (ordOf.get(b.to) ?? 0),
  );

  return {
    nodes: orderedNodes,
    edges,
    inlinedEventLabels,
    promotedEventEdges,
    entryPorts: entryPortCount,
    exitPorts: exitPortCount,
    selfLoops: selfLoopCount,
    unlinkedEventLabels,
  };
}

/* ------------------------- S3/S4 · 强连通分量与回边 ------------------------- */

interface Adjacency {
  out: Map<string, G1Edge[]>;
  in: Map<string, G1Edge[]>;
}

function adjacencyOf(graph: G1): Adjacency {
  const ordOf = new Map(graph.nodes.map((node) => [node.key, node.ord]));
  const out = new Map<string, G1Edge[]>();
  const inbound = new Map<string, G1Edge[]>();
  for (const node of graph.nodes) {
    out.set(node.key, []);
    inbound.set(node.key, []);
  }
  for (const edge of graph.edges) {
    out.get(edge.from)?.push(edge);
    inbound.get(edge.to)?.push(edge);
  }
  const byTarget = (a: G1Edge, b: G1Edge) =>
    (ordOf.get(a.to) ?? 0) - (ordOf.get(b.to) ?? 0);
  const bySource = (a: G1Edge, b: G1Edge) =>
    (ordOf.get(a.from) ?? 0) - (ordOf.get(b.from) ?? 0);
  for (const list of out.values()) list.sort(byTarget);
  for (const list of inbound.values()) list.sort(bySource);
  return { out, in: inbound };
}

/** 迭代式 Tarjan。起点与邻接都按 ord 升序，所以 SCC 编号可复现。 */
function stronglyConnected(graph: G1, adjacency: Adjacency): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const ordOf = new Map(graph.nodes.map((node) => [node.key, node.ord]));
  let counter = 0;

  for (const root of graph.nodes) {
    if (index.has(root.key)) continue;
    const frames: Array<{ key: string; cursor: number }> = [];
    const open = (key: string) => {
      index.set(key, counter);
      low.set(key, counter);
      counter += 1;
      stack.push(key);
      onStack.add(key);
      frames.push({ key, cursor: 0 });
    };
    open(root.key);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = adjacency.out.get(frame.key) ?? [];
      if (frame.cursor < edges.length) {
        const next = edges[frame.cursor]!.to;
        frame.cursor += 1;
        if (!index.has(next)) open(next);
        else if (onStack.has(next)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(next)!));
        }
        continue;
      }
      frames.pop();
      if (low.get(frame.key) === index.get(frame.key)) {
        const group: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          group.push(popped);
        } while (popped !== frame.key);
        group.sort((a, b) => (ordOf.get(a) ?? 0) - (ordOf.get(b) ?? 0));
        sccs.push(group);
      }
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(
          parent.key,
          Math.min(low.get(parent.key)!, low.get(frame.key)!),
        );
      }
    }
  }
  return sccs;
}

/**
 * 组内去环：三色迭代 DFS，起点与邻接按 ord 升序，只走组内边。
 * 指向灰色（仍在当前路径上）节点的边就是回边。
 * 「从组内哪儿切」这点任意性到此为止——它出不了这个 SCC。
 */
function backEdgeKeys(
  sccs: string[][],
  adjacency: Adjacency,
  graph: G1,
): Set<string> {
  const ordOf = new Map(graph.nodes.map((node) => [node.key, node.ord]));
  const found = new Set<string>();
  for (const group of sccs) {
    if (group.length < 2) continue;
    const member = new Set(group);
    const colour = new Map<string, "grey" | "black">();
    for (const start of [...group].sort(
      (a, b) => (ordOf.get(a) ?? 0) - (ordOf.get(b) ?? 0),
    )) {
      if (colour.has(start)) continue;
      const frames: Array<{ key: string; cursor: number }> = [];
      colour.set(start, "grey");
      frames.push({ key: start, cursor: 0 });
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        const edges = (adjacency.out.get(frame.key) ?? []).filter((edge) =>
          member.has(edge.to),
        );
        if (frame.cursor < edges.length) {
          const edge = edges[frame.cursor]!;
          frame.cursor += 1;
          const seen = colour.get(edge.to);
          if (seen === "grey") found.add(edge.key);
          else if (seen === undefined) {
            colour.set(edge.to, "grey");
            frames.push({ key: edge.to, cursor: 0 });
          }
          continue;
        }
        colour.set(frame.key, "black");
        frames.pop();
      }
    }
  }
  return found;
}

/* --------------------------- S5 · 缩并分层 + 展开 --------------------------- */

/** DAG 上的最长路径分层（Kahn）。结果与处理顺序无关，天然确定。 */
function longestPathLevels(
  keys: string[],
  edges: Array<{ from: string; to: string }>,
): Map<string, number> {
  const level = new Map(keys.map((key) => [key, 0]));
  const indegree = new Map(keys.map((key) => [key, 0]));
  const out = new Map<string, Array<{ from: string; to: string }>>(
    keys.map((key) => [key, []]),
  );
  for (const edge of edges) {
    out.get(edge.from)?.push(edge);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = keys.filter((key) => (indegree.get(key) ?? 0) === 0);
  let cursor = 0;
  while (cursor < queue.length) {
    const key = queue[cursor++]!;
    for (const edge of out.get(key) ?? []) {
      level.set(edge.to, Math.max(level.get(edge.to)!, level.get(key)! + 1));
      const left = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }
  return level;
}

function rankNodes(
  graph: G1,
  sccs: string[][],
  back: Set<string>,
): Map<string, number> {
  const sccOf = new Map<string, number>();
  sccs.forEach((group, id) => {
    for (const key of group) sccOf.set(key, id);
  });

  const subRank = new Map<string, number>();
  const subHeight = sccs.map(() => 1);
  sccs.forEach((group, id) => {
    if (group.length === 1) {
      subRank.set(group[0]!, 0);
      return;
    }
    const inner = graph.edges.filter(
      (edge) =>
        !back.has(edge.key) &&
        sccOf.get(edge.from) === id &&
        sccOf.get(edge.to) === id,
    );
    const levels = longestPathLevels(group, inner);
    let height = 1;
    for (const key of group) {
      const level = levels.get(key) ?? 0;
      subRank.set(key, level);
      height = Math.max(height, level + 1);
    }
    subHeight[id] = height;
  });

  const condensedEdges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = sccOf.get(edge.from)!;
    const to = sccOf.get(edge.to)!;
    if (from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    condensedEdges.push({ from: String(from), to: String(to) });
  }
  const condensedKeys = sccs.map((_group, id) => String(id));

  // 缩并图上的最长路径，但每一步的步长是前驱组自己的高度。
  const base = new Map(condensedKeys.map((key) => [key, 0]));
  const indegree = new Map(condensedKeys.map((key) => [key, 0]));
  const out = new Map<string, Array<{ from: string; to: string }>>(
    condensedKeys.map((key) => [key, []]),
  );
  for (const edge of condensedEdges) {
    out.get(edge.from)?.push(edge);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = condensedKeys.filter((key) => (indegree.get(key) ?? 0) === 0);
  let cursor = 0;
  while (cursor < queue.length) {
    const key = queue[cursor++]!;
    for (const edge of out.get(key) ?? []) {
      base.set(
        edge.to,
        Math.max(base.get(edge.to)!, base.get(key)! + subHeight[Number(key)]!),
      );
      const left = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }

  const ranks = new Map<string, number>();
  for (const node of graph.nodes) {
    const id = sccOf.get(node.key)!;
    ranks.set(node.key, base.get(String(id))! + (subRank.get(node.key) ?? 0));
  }
  return ranks;
}

/* --------------------------- S6 · 弱连通分量 --------------------------- */

function weakComponents(graph: G1): Map<string, number> {
  const parent = new Map<string, string>(
    graph.nodes.map((node) => [node.key, node.key]),
  );
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const edge of graph.edges) {
    const a = find(edge.from);
    const b = find(edge.to);
    if (a !== b) parent.set(a, b);
  }

  const minOrd = new Map<string, number>();
  for (const node of graph.nodes) {
    const root = find(node.key);
    const current = minOrd.get(root);
    if (current === undefined || node.ord < current) {
      minOrd.set(root, node.ord);
    }
  }
  const roots = [...minOrd.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([root]) => root);
  const idOf = new Map(roots.map((root, id) => [root, id]));
  return new Map(graph.nodes.map((node) => [node.key, idOf.get(find(node.key))!]));
}

/* ------------------------------- 布局装配 ------------------------------- */

interface Placed {
  key: string;
  kind: MapNodeKind;
  label: string;
  ord: number;
  component: number;
  rank: number;
  columnOrder: number;
  columnKind: MapColumnKind;
  laneId: LaneId | null;
  index: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const EMPTY_LEDGER: OntologyMapLedger = {
  totalRelations: 0,
  narrowedAwayRelations: 0,
  sourceRelations: 0,
  inlinedEventLabels: 0,
  promotedEventEdges: 0,
  entryPorts: 0,
  exitPorts: 0,
  selfLoops: 0,
  forwardEdges: 0,
  backEdges: 0,
  balanced: true,
};

function emptyModel(
  total: OntologyMapCounts,
  narrowed: OntologyMapCounts,
  shown: OntologyMapCounts,
  sourceTruncated: boolean,
  oversized: boolean,
  view: AppliedMapView,
  notes?: Partial<OntologyMapModel["notes"]>,
  ledger?: OntologyMapLedger,
): OntologyMapModel {
  return {
    nodes: [],
    edges: [],
    columns: [],
    lanes: [],
    components: [],
    loopGroups: [],
    gutterCount: 0,
    counts: { total, narrowed, shown },
    drawn: { cards: 0, eventPills: 0, dummies: 0, edges: 0, ports: 0 },
    ledger: ledger ?? EMPTY_LEDGER,
    sourceTruncated,
    oversized,
    truncated: false,
    notes: {
      disconnectedComponents: 0,
      unlinkedEventLabels: [],
      duplicateActionLabels: [],
      undeclaredLaneActionCount: 0,
      handoffEdgeCount: 0,
      laneMode: "lanes",
      ...notes,
    },
    view,
  };
}

/**
 * 权威动作表 → 整数坐标的布局模型。
 *
 * `rawViewSpec` 是模型给的视图规格原文；不合规就整份丢弃、退回全图。
 */
export function buildOntologyMapLayout(
  source: MapSource,
  rawViewSpec?: unknown,
): OntologyMapModel {
  const sourceTruncated = source?.sourceTruncated === true;
  const { merged, duplicateActionLabels } = mergeRows(
    Array.isArray(source?.rows) ? source.rows : [],
  );
  const bipartite = readBipartite(merged);
  const total: OntologyMapCounts = {
    nodes: bipartite.nodes.length,
    edges: bipartite.edges.length,
  };

  if (total.nodes === 0) {
    return emptyModel(total, total, total, sourceTruncated, false, noView(), {
      duplicateActionLabels,
    });
  }
  if (total.nodes > HARD_NODE_LIMIT) {
    return emptyModel(
      total,
      total,
      { nodes: 0, edges: 0 },
      sourceTruncated,
      true,
      noView(),
      { duplicateActionLabels },
      // 一条都没画：全部关系记在「没画出来」这一侧，账本照样配得平。
      {
        ...EMPTY_LEDGER,
        totalRelations: total.edges,
        narrowedAwayRelations: total.edges,
      },
    );
  }

  const spec = parseOntologyMapViewSpec(rawViewSpec);
  const { graph: narrowedGraph, view } = applyView(bipartite, spec);
  const narrowed: OntologyMapCounts = {
    nodes: narrowedGraph.nodes.length,
    edges: narrowedGraph.edges.length,
  };

  const g1 = condense(narrowedGraph);
  const ledger: OntologyMapLedger = {
    totalRelations: total.edges,
    narrowedAwayRelations: total.edges - narrowed.edges,
    sourceRelations: narrowed.edges,
    inlinedEventLabels: g1.inlinedEventLabels,
    promotedEventEdges: g1.promotedEventEdges,
    entryPorts: g1.entryPorts,
    exitPorts: g1.exitPorts,
    selfLoops: g1.selfLoops,
    forwardEdges: 0,
    backEdges: 0,
    balanced: false,
  };

  const laneOfAction = new Map(
    merged.map((row) => [`a:${row.action}`, row.laneKey]),
  );
  const undeclaredLaneActionCount = g1.nodes.filter(
    (node) => node.kind === "action" && laneOfAction.get(node.key) === "",
  ).length;

  if (g1.nodes.length === 0) {
    ledger.balanced =
      2 * ledger.inlinedEventLabels +
        ledger.promotedEventEdges +
        ledger.entryPorts +
        ledger.exitPorts +
        2 * ledger.selfLoops ===
        ledger.sourceRelations &&
      ledger.narrowedAwayRelations + ledger.sourceRelations ===
        ledger.totalRelations;
    return emptyModel(
      total,
      narrowed,
      narrowed,
      sourceTruncated,
      false,
      view,
      {
        duplicateActionLabels,
        unlinkedEventLabels: g1.unlinkedEventLabels,
        undeclaredLaneActionCount,
      },
      ledger,
    );
  }

  /* --- 结构 --- */
  const adjacency = adjacencyOf(g1);
  const sccs = stronglyConnected(g1, adjacency);
  const back = backEdgeKeys(sccs, adjacency, g1);
  const rawRanks = rankNodes(g1, sccs, back);
  const componentOf = weakComponents(g1);

  const componentMin = new Map<number, number>();
  for (const node of g1.nodes) {
    const component = componentOf.get(node.key)!;
    const rank = rawRanks.get(node.key)!;
    const current = componentMin.get(component);
    if (current === undefined || rank < current) {
      componentMin.set(component, rank);
    }
  }
  const rankOf = new Map(
    g1.nodes.map((node) => [
      node.key,
      rawRanks.get(node.key)! - componentMin.get(componentOf.get(node.key)!)!,
    ]),
  );

  /* --- 泳道与列 --- */
  const declaredLanes: LaneId[] = [];
  for (const node of g1.nodes) {
    if (node.kind !== "action") continue;
    const lane = laneOfAction.get(node.key) ?? "";
    if (!declaredLanes.includes(lane)) declaredLanes.push(lane);
  }
  const laneMode: "lanes" | "collapsed" =
    declaredLanes.length > MAX_LANES ? "collapsed" : "lanes";
  const laneIds = laneMode === "collapsed" ? [""] : declaredLanes;
  const laneIdOf = (key: string): LaneId =>
    laneMode === "collapsed" ? "" : (laneOfAction.get(key) ?? "");

  // 道按声明序排在一起，路由列（晋升的事件 + 长边的虚节点）排在最后。
  //
  // 曾经把路由列塞在两条道正中间，于是每一条人机交接边都得先横穿整条路由走廊
  // 才能到对面——一层只有 ROW_H 的纵向余量，横向却隔着一整列。实测：夹在中间时
  // zhaopin-v1 的 13 条交接边 13 条、RAAS-v1 的 14 条 14 条都是近水平长条
  // （dx/dy>2），即 100%。道相邻之后同一口径降到 8/13 与 11/14。
  // 剩下的那些是几何本身：跨一层只有 ROW_H 的纵向余量，跨一条道却要走一个列宽，
  // 不是布线绕远。要再降只能加大 ROW_H，那是拿全图变高换的，没有做。
  const columns: MapColumn[] = laneIds.map((lane, order) => ({
    kind: "lane" as const,
    laneId: lane,
    order,
  }));
  const junctionOrder = columns.length;
  columns.push({ kind: "junction", laneId: null, order: junctionOrder });
  const laneColumnOrder = new Map(
    columns.flatMap((column) =>
      column.kind === "lane" ? [[column.laneId as LaneId, column.order]] : [],
    ),
  );

  /* --- 落位（含虚节点） --- */
  const placed: Placed[] = g1.nodes.map((node) => {
    const isAction = node.kind === "action";
    const laneId = isAction ? laneIdOf(node.key) : null;
    return {
      key: node.key,
      kind: node.kind,
      label: node.label,
      ord: node.ord,
      component: componentOf.get(node.key)!,
      rank: rankOf.get(node.key)!,
      columnOrder: isAction ? laneColumnOrder.get(laneId!)! : junctionOrder,
      columnKind: isAction ? "lane" : "junction",
      laneId,
      index: 0,
    };
  });

  const forwardEdges = g1.edges.filter((edge) => !back.has(edge.key));
  const backwardEdges = g1.edges.filter((edge) => back.has(edge.key));
  const ordBase = g1.nodes.length + 1;
  const waypointsOf = new Map<string, string[]>();
  forwardEdges.forEach((edge, position) => {
    const from = rankOf.get(edge.from)!;
    const to = rankOf.get(edge.to)!;
    const chain: string[] = [];
    for (let rank = from + 1; rank < to; rank += 1) {
      const key = `d:${position}:${rank}`;
      chain.push(key);
      placed.push({
        key,
        kind: "dummy",
        label: "",
        ord: ordBase + position,
        component: componentOf.get(edge.from)!,
        rank,
        columnOrder: junctionOrder,
        columnKind: "junction",
        laneId: null,
        index: 0,
      });
    }
    waypointsOf.set(edge.key, chain);
  });

  /* --- 层内排序 --- */
  const cellKey = (node: Placed) =>
    `${node.component}|${node.rank}|${node.columnOrder}`;
  const cells = new Map<string, Placed[]>();
  for (const node of placed) {
    const key = cellKey(node);
    const list = cells.get(key);
    if (list) list.push(node);
    else cells.set(key, [node]);
  }
  for (const cell of cells.values()) {
    cell.sort((a, b) => a.ord - b.ord);
    cell.forEach((node, index) => {
      node.index = index;
    });
  }
  // 单元偏移是常量（只取决于单元大小），所以 pos 只随 index 变。
  const cellOffset = new Map<string, number>();
  const rankGroups = new Map<string, Placed[]>();
  for (const node of placed) {
    const key = `${node.component}|${node.rank}`;
    const list = rankGroups.get(key);
    if (list) list.push(node);
    else rankGroups.set(key, [node]);
  }
  for (const [key] of rankGroups) {
    let offset = 0;
    for (const column of columns) {
      const cell = cells.get(`${key}|${column.order}`) ?? [];
      cellOffset.set(`${key}|${column.order}`, offset);
      offset += cell.length;
    }
  }

  const placedByKey = new Map(placed.map((node) => [node.key, node]));
  const posOf = (node: Placed) =>
    cellOffset.get(cellKey(node))! + node.index;

  // 分段图：长边穿过虚节点后，每一段都只跨一层。
  const segments: Array<{ from: string; to: string }> = [];
  for (const edge of forwardEdges) {
    const chain = [edge.from, ...(waypointsOf.get(edge.key) ?? []), edge.to];
    for (let i = 0; i + 1 < chain.length; i += 1) {
      segments.push({ from: chain[i]!, to: chain[i + 1]! });
    }
  }
  const segIn = new Map<string, string[]>();
  const segOut = new Map<string, string[]>();
  for (const segment of segments) {
    (segOut.get(segment.from) ?? segOut.set(segment.from, []).get(segment.from)!).push(
      segment.to,
    );
    (segIn.get(segment.to) ?? segIn.set(segment.to, []).get(segment.to)!).push(
      segment.from,
    );
  }

  const maxRank = Math.max(...placed.map((node) => node.rank));
  const componentIds = [...new Set(placed.map((node) => node.component))].sort(
    (a, b) => a - b,
  );
  const snapshot = () => new Map(placed.map((node) => [node.key, node.index]));
  const restore = (state: Map<string, number>) => {
    for (const node of placed) node.index = state.get(node.key)!;
  };
  const crossings = (state: Map<string, number>): number => {
    restore(state);
    let total = 0;
    for (const component of componentIds) {
      const byRank = new Map<number, Array<[number, number]>>();
      for (const segment of segments) {
        const from = placedByKey.get(segment.from)!;
        const to = placedByKey.get(segment.to)!;
        if (from.component !== component) continue;
        const list = byRank.get(from.rank) ?? [];
        list.push([posOf(from), posOf(to)]);
        byRank.set(from.rank, list);
      }
      for (const list of byRank.values()) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const [a1, a2] = list[i]!;
            const [b1, b2] = list[j]!;
            if ((a1 - b1) * (a2 - b2) < 0) total += 1;
          }
        }
      }
    }
    return total;
  };

  const candidates: Array<Map<string, number>> = [snapshot()];
  for (let sweep = 0; sweep < 2 * SWEEPS; sweep += 1) {
    const down = sweep % 2 === 0;
    const ranks = down
      ? Array.from({ length: maxRank }, (_v, i) => i + 1)
      : Array.from({ length: maxRank }, (_v, i) => maxRank - 1 - i);
    for (const component of componentIds) {
      for (const rank of ranks) {
        for (const column of columns) {
          const cell = cells.get(`${component}|${rank}|${column.order}`);
          if (!cell || cell.length < 2) continue;
          const keyed = cell.map((node) => {
            const neighbours = (down ? segIn : segOut).get(node.key) ?? [];
            const positions = neighbours.map((key) =>
              posOf(placedByKey.get(key)!),
            );
            return {
              node,
              // 无邻居就用它此刻的绝对位置——保持原位，不沉底。
              key: positions.length > 0 ? median(positions) : posOf(node),
              index: node.index,
            };
          });
          keyed.sort(
            (a, b) =>
              a.key - b.key || a.index - b.index || a.node.ord - b.node.ord,
          );
          keyed.forEach((entry, index) => {
            entry.node.index = index;
          });
        }
      }
    }
    candidates.push(snapshot());
  }
  let best = candidates[0]!;
  let bestScore = crossings(best);
  for (let i = 1; i < candidates.length; i += 1) {
    const score = crossings(candidates[i]!);
    if (score < bestScore) {
      bestScore = score;
      best = candidates[i]!;
    }
  }
  restore(best);

  /* --- 回流沟：区间图贪心着色 --- */
  const ordOf = new Map(g1.nodes.map((node) => [node.key, node.ord]));
  const gutterOf = new Map<string, number>();
  const assigned: Array<{ component: number; lo: number; hi: number; gutter: number }> =
    [];
  const sortedBack = [...backwardEdges].sort((a, b) => {
    const componentA = componentOf.get(a.from)!;
    const componentB = componentOf.get(b.from)!;
    const loA = Math.min(rankOf.get(a.from)!, rankOf.get(a.to)!);
    const loB = Math.min(rankOf.get(b.from)!, rankOf.get(b.to)!);
    const hiA = Math.max(rankOf.get(a.from)!, rankOf.get(a.to)!);
    const hiB = Math.max(rankOf.get(b.from)!, rankOf.get(b.to)!);
    return (
      componentA - componentB ||
      loA - loB ||
      hiB - hiA ||
      (ordOf.get(a.from) ?? 0) - (ordOf.get(b.from) ?? 0) ||
      (ordOf.get(a.to) ?? 0) - (ordOf.get(b.to) ?? 0)
    );
  });
  for (const edge of sortedBack) {
    const component = componentOf.get(edge.from)!;
    const lo = Math.min(rankOf.get(edge.from)!, rankOf.get(edge.to)!);
    const hi = Math.max(rankOf.get(edge.from)!, rankOf.get(edge.to)!);
    let gutter = 0;
    while (
      assigned.some(
        (other) =>
          other.gutter === gutter &&
          other.component === component &&
          other.lo <= hi &&
          lo <= other.hi,
      )
    ) {
      gutter += 1;
    }
    assigned.push({ component, lo, hi, gutter });
    gutterOf.set(edge.key, gutter);
  }
  const gutterCount = assigned.reduce(
    (max, entry) => Math.max(max, entry.gutter + 1),
    0,
  );

  /* --- 往返组 --- */
  const loopGroupSource = sccs
    .map((group) => group)
    .filter((group) => group.length >= 2)
    .sort((a, b) => {
      const componentA = componentOf.get(a[0]!)!;
      const componentB = componentOf.get(b[0]!)!;
      const rankA = Math.min(...a.map((key) => rankOf.get(key)!));
      const rankB = Math.min(...b.map((key) => rankOf.get(key)!));
      return (
        componentA - componentB ||
        rankA - rankB ||
        (ordOf.get(a[0]!) ?? 0) - (ordOf.get(b[0]!) ?? 0)
      );
    });
  const loopGroupOf = new Map<string, number>();
  const loopGroups: MapLoopGroup[] = loopGroupSource.map((group, id) => {
    for (const key of group) loopGroupOf.set(key, id);
    const ranks = group.map((key) => rankOf.get(key)!);
    const lanes = laneIds.filter((lane) =>
      group.some(
        (key) =>
          placedByKey.get(key)!.columnKind === "lane" &&
          placedByKey.get(key)!.laneId === lane,
      ),
    );
    return {
      id,
      component: componentOf.get(group[0]!)!,
      memberKeys: group,
      rankFrom: Math.min(...ranks),
      rankTo: Math.max(...ranks),
      laneIds: lanes,
      backEdgeKeys: backwardEdges
        .filter((edge) => group.includes(edge.from) && group.includes(edge.to))
        .map((edge) => edge.key),
    };
  });

  /* --- 装配节点 --- */
  const inDegree = new Map<string, number>(
    g1.nodes.map((node) => [node.key, 0]),
  );
  const outDegree = new Map<string, number>(
    g1.nodes.map((node) => [node.key, 0]),
  );
  for (const edge of g1.edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const highlightSet = new Set(view.highlight);
  const focusSet = new Set(view.focus);
  const g1ByKey = new Map(g1.nodes.map((node) => [node.key, node]));

  const nodes: MapNode[] = placed
    .slice()
    .sort(
      (a, b) =>
        a.component - b.component ||
        a.rank - b.rank ||
        a.columnOrder - b.columnOrder ||
        a.index - b.index,
    )
    .map((entry) => {
      const g1Node = g1ByKey.get(entry.key);
      const highlighted = g1Node ? highlightSet.has(g1Node.label) : false;
      const focused = g1Node ? focusSet.has(g1Node.label) : false;
      const entryPorts = g1Node?.entryPorts ?? [];
      const exitPorts = g1Node?.exitPorts ?? [];
      const selfLoops = g1Node?.selfLoops ?? [];
      const degreeIn = g1Node ? (inDegree.get(entry.key) ?? 0) : 1;
      const degreeOut = g1Node ? (outDegree.get(entry.key) ?? 0) : 1;
      return {
        key: entry.key,
        kind: entry.kind,
        label: entry.label,
        ord: entry.ord,
        component: entry.component,
        rank: entry.rank,
        columnKind: entry.columnKind,
        laneId: entry.laneId,
        index: entry.index,
        loopGroup: loopGroupOf.get(entry.key) ?? null,
        inDegree: degreeIn,
        outDegree: degreeOut,
        entryPorts,
        exitPorts,
        selfLoops,
        eventRole: g1Node?.eventRole ?? null,
        highlighted,
        focused,
        foldable:
          entry.kind === "action" &&
          degreeIn === 1 &&
          degreeOut === 1 &&
          loopGroupOf.get(entry.key) === undefined &&
          entryPorts.length === 0 &&
          exitPorts.length === 0 &&
          selfLoops.length === 0 &&
          !highlighted &&
          !focused,
      };
    });

  /* --- 装配边 --- */
  const laneIdOfNode = new Map(
    placed.map((entry) => [entry.key, entry.columnKind === "lane" ? entry.laneId : null]),
  );
  const isLane = new Map(
    placed.map((entry) => [entry.key, entry.columnKind === "lane"]),
  );
  const edges: MapEdge[] = g1.edges.map((edge) => {
    const isBack = back.has(edge.key);
    const span = rankOf.get(edge.to)! - rankOf.get(edge.from)!;
    return {
      key: edge.key,
      from: edge.from,
      to: edge.to,
      kind: isBack ? "back" : "forward",
      eventLabels: edge.eventLabels,
      handoff:
        isLane.get(edge.from) === true &&
        isLane.get(edge.to) === true &&
        laneIdOfNode.get(edge.from) !== laneIdOfNode.get(edge.to),
      span,
      waypoints: waypointsOf.get(edge.key) ?? [],
      gutter: isBack ? (gutterOf.get(edge.key) ?? 0) : null,
    };
  });

  ledger.forwardEdges = forwardEdges.length;
  ledger.backEdges = backwardEdges.length;
  ledger.balanced =
    2 * ledger.inlinedEventLabels +
      ledger.promotedEventEdges +
      ledger.entryPorts +
      ledger.exitPorts +
      2 * ledger.selfLoops ===
      ledger.sourceRelations &&
    ledger.forwardEdges + ledger.backEdges === g1.edges.length &&
    ledger.narrowedAwayRelations + ledger.sourceRelations ===
      ledger.totalRelations;

  /* --- 分量与道的统计 --- */
  const components: MapComponent[] = componentIds.map((id) => {
    const memberKeys = nodes
      .filter((node) => node.component === id)
      .map((node) => node.key);
    const ranks = nodes
      .filter((node) => node.component === id)
      .map((node) => node.rank);
    return {
      id,
      nodeKeys: memberKeys,
      rankCount: ranks.length > 0 ? Math.max(...ranks) + 1 : 0,
      actionCount: nodes.filter(
        (node) => node.component === id && node.kind === "action",
      ).length,
      edgeCount: edges.filter(
        (edge) => componentOf.get(edge.from) === id,
      ).length,
    };
  });

  const lanes: MapLane[] = laneIds.map((lane, order) => ({
    id: lane,
    order,
    actionCount: nodes.filter(
      (node) => node.kind === "action" && node.laneId === lane,
    ).length,
  }));

  const handoffEdgeCount = edges.filter((edge) => edge.handoff).length;

  return {
    nodes,
    edges,
    columns,
    lanes,
    components,
    loopGroups,
    gutterCount,
    counts: { total, narrowed, shown: narrowed },
    drawn: {
      cards: nodes.filter((node) => node.kind === "action").length,
      eventPills: nodes.filter((node) => node.kind === "event").length,
      dummies: nodes.filter((node) => node.kind === "dummy").length,
      edges: edges.length,
      ports: ledger.entryPorts + ledger.exitPorts,
    },
    ledger,
    sourceTruncated,
    oversized: false,
    truncated: false,
    notes: {
      disconnectedComponents: components.length,
      unlinkedEventLabels: g1.unlinkedEventLabels,
      duplicateActionLabels,
      undeclaredLaneActionCount,
      handoffEdgeCount,
      laneMode,
    },
    view,
  };
}
