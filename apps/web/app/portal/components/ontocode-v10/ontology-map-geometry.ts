// OntoCode v10 · 地图几何：整数坐标 → 像素场景。
//
// 布局模型（ontology-map-layout.ts）只给 `(分量, 秩, 列, 次序)` 四个整数，刻意不认识
// 像素、也不接受容器尺寸——所以 resize 和全屏切换永远不会让形状重排。这一层把那组
// 整数摊成像素，同样是纯函数：常量在文件顶部，输入只有布局模型，输出可以在 node 里
// 逐个数字断言。
//
// 四件事在这里发生，且只在这里发生：
//   1. 列宽由「这一列在任意一层里最多摆几个」决定——本体自己的形状决定宽度。
//      一层里摆不下的换行接着摆（`MAX_CELL_SLOTS`），所以一个被二十方消费的
//      结果不会把画布拉成一条三千像素的走廊。虚节点只占一条细缝：宽度由内容
//      决定，不由布线决定。
//   2. 合流冠 / 结果条的锚点分配：每条来源落在自己的锚点上，线不再挤成一个点。
//   3. 直线段合并（环节多到一屏看不完时启用），硬条件是段内执行方一致——
//      这保证合并永远不会藏起一次人机交接。合并**真的压缩像素**：被合并掉的
//      那些层没有任何东西可摆，于是整层被吃掉，画布随之变矮。合并卡带着被折
//      进去的全部原名（`foldedLabels`），并且可以按 id 展开——任何规模下动作
//      原名都不许从可访问表述里消失。
//   4. 缩略条：整张图等比塞进一条固定宽度的带子，用来在长图上定位。

import type {
  LaneId,
  MapEdge,
  MapEventRole,
  MapNode,
  OntologyMapModel,
} from "./ontology-map-layout";

/* -------------------------------- 常量 -------------------------------- */

/** 一张环节卡的宽高。 */
export const CARD_W = 170;
export const CARD_H = 44;
/** 路由虚节点的槽宽。它只是一个折点，不该占一整张卡的位置。 */
export const DUMMY_W = 12;
/** 同一层同一列里横向最多摆几个；再多的换行接着摆。 */
export const MAX_CELL_SLOTS = 6;
/** 结果胶囊比环节卡矮一圈——形状本身就是区分，不靠颜色。 */
export const PILL_H = 26;
/** 同一层同一道里两张卡之间的间距。 */
const SLOT_GAP = 14;
/** 两条道之间的间距。 */
const COL_GAP = 26;
/** 一层的纵向步距。必须容得下卡 + 上面的汇合冠 + 下面的结果条。 */
export const ROW_H = 100;
/** 汇合冠离卡顶、结果条离卡底的距离。 */
const CROWN_DY = 13;
/** 回流沟的宽度。 */
const GUTTER_W = 22;
/** 画布四周的留白与道头高度。 */
const PAD_X = 18;
const PAD_BOTTOM = 26;
const LANE_HEAD_H = 30;
/**
 * 第一层的内容顶端。道头之外还要留出来源端口那一行和往返框的标题——
 * 贴着道头画，第 0 层的端口文字会压在道名上。
 */
const CONTENT_TOP = LANE_HEAD_H + 26;
/** 两段互不相连的流程之间留出的空档。 */
const COMPONENT_GAP = 64;
/** 连线离开卡片后先走一小段直线，再拐弯——避免箭头贴着卡边。 */
const STUB = 9;

/** 细节三档的阈值。只由环节数决定，与容器无关。 */
export const TIER_FULL_MAX = 40;
export const TIER_COMPACT_MAX = 120;
/** 直线段短于这个长度不值得合并。 */
export const MIN_FOLD_RUN = 3;
/**
 * 一张合并卡最多盖住几个环节。
 * 不设上限时，一条百环节的直链会塌成一张「98 个连续环节」的卡——诚实，
 * 但形状全没了。切成段之后整体形状还在，钻取也仍然是一次点击。
 */
export const MAX_FOLD_RUN = 12;

/** 卡上标题的字符预算，按档位收紧。原文放不下就截尾，完整值走清单。 */
const TITLE_CHARS: Record<MapDetailTier, number> = {
  full: 20,
  compact: 18,
  dots: 14,
};

/* -------------------------------- 类型 -------------------------------- */

export type MapDetailTier = "full" | "compact" | "dots";

export interface SceneNode {
  /** 渲染用的稳定 React key；由坐标派生，不含任何内部标识。 */
  slot: string;
  label: string;
  kind: "action" | "event";
  laneId: LaneId | null;
  /** 道在列序里的位置；用来做形状/纹理的冗余编码。 */
  laneOrder: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  inDegree: number;
  outDegree: number;
  /** 落在这个环节上的来源名（连线承载的事件原文）。卡面截尾，这里永远是全名。 */
  inLabels: string[];
  /** 从这个环节出去的结果名。同上，清单里不截。 */
  outLabels: string[];
  entryPorts: string[];
  exitPorts: string[];
  selfLoops: string[];
  eventRole: MapEventRole | null;
  highlighted: boolean;
  focused: boolean;
  inLoop: boolean;
  /** >0 表示这是一张合并卡，盖住了这么多个连续环节。 */
  foldCount: number;
  /** 合并卡的稳定 id，用来展开它；普通节点为 null。永不渲染成 DOM 属性。 */
  foldId: string | null;
  /** 被折进这张卡的环节原名，按先后排。截断在这套代码里等于撒谎。 */
  foldedLabels: string[];
  /** 段内那些线承载的结果原名——它们的线不画了，名字不能跟着消失。 */
  foldedEventLabels: string[];
  component: number;
  rank: number;
}

export interface SceneEdge {
  slot: string;
  kind: "forward" | "back";
  points: Array<[number, number]>;
  /** 箭头的落点与来向，渲染层据此画三角形。 */
  arrowAt: [number, number];
  arrowFrom: [number, number];
  handoff: boolean;
  eventLabels: string[];
  /** 两端的环节/结果原名。回流线靠 `toLabel` 说出自己回到哪儿。 */
  fromLabel: string;
  toLabel: string;
  gutter: number | null;
  /** 交接标记与连线上的结果名贴在这里：整条折线里最长那一段的中点。 */
  midpoint: [number, number];
  /** 回流线的说明贴在这里：沟里那一段竖线的中点。前向边与 midpoint 相同。 */
  noteAt: [number, number];
}

export interface SceneAnchor {
  slot: string;
  x: number;
  y: number;
}

export interface SceneCrown {
  slot: string;
  x: number;
  y: number;
  w: number;
  count: number;
  anchors: SceneAnchor[];
}

export interface SceneFork {
  slot: string;
  x: number;
  y: number;
  w: number;
  count: number;
  anchors: SceneAnchor[];
}

export interface SceneLoop {
  slot: string;
  x: number;
  y: number;
  w: number;
  h: number;
  memberCount: number;
  /**
   * 这个往返组是被哪几条边闭合的（回边的两端原名）。
   * 一条回边就能把小半张图圈进同一个强连通分量，光画一个框等于铺一张壁纸；
   * 说清楚「从谁回到谁」才是这个框唯一有用的信息。
   */
  closes: Array<{ from: string; to: string }>;
}

export interface SceneLane {
  id: LaneId;
  order: number;
  x: number;
  w: number;
  actionCount: number;
}

export interface SceneComponent {
  id: number;
  /** 从 0 起的展示序，用来决定要不要画分隔。永不上屏。 */
  position: number;
  top: number;
  height: number;
  actionCount: number;
}

export interface MapScene {
  width: number;
  height: number;
  headHeight: number;
  tier: MapDetailTier;
  nodes: SceneNode[];
  edges: SceneEdge[];
  crowns: SceneCrown[];
  forks: SceneFork[];
  loops: SceneLoop[];
  lanes: SceneLane[];
  /** 结果列的几何。这一列空着（事件全部内联进了连线）时为 null，不占宽度。 */
  junction: { x: number; w: number } | null;
  components: SceneComponent[];
  gutterXs: number[];
  /** 被合并进合并卡的环节数（合并卡本身不计）。 */
  foldedActions: number;
  /** 合并卡张数。 */
  foldGroupCount: number;
  /** 有折叠资格、但这一档还没折的环节数——「还能再压多少」是可报的。 */
  foldableActions: number;
  /** 因为整层空掉而被吃掉的层数。折叠省下来的像素就是它乘 ROW_H。 */
  compactedRanks: number;
  /** 合流处 / 分叉处 / 会回到前面的连线数——顶栏叙事的来源。 */
  mergeCount: number;
  forkCount: number;
  backCount: number;
  maxRankCount: number;
}

/**
 * 场景选项。目前只有一件事：哪几张合并卡被用户展开了。
 * 它是纯输入——同一个 (模型, 展开集合) 永远给出同一个场景，集合的书写顺序无关。
 */
export interface MapSceneOptions {
  expandedFolds?: readonly string[];
}

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 卡面放不下的标题按字符预算截尾。**只按长度截**，不做任何关键词匹配——
 * 一旦按词猜，就等于把业务域写进了渲染层。完整原文永远在清单里。
 */
export function truncateLabel(label: string, tier: MapDetailTier): string {
  const budget = TITLE_CHARS[tier];
  if (label.length <= budget) return label;
  return `${label.slice(0, budget - 1)}…`;
}

function px(value: number): number {
  return Math.round(value);
}

/* ------------------------------ 直线段合并 ------------------------------ */

export interface FoldGroup {
  /** 稳定 id：由段首成员派生，与数组下标无关，所以展开状态跨渲染仍然指同一段。 */
  id: string;
  memberKeys: string[];
  /** 成员原名，按段内先后。合并卡靠它交代自己折了谁。 */
  memberLabels: string[];
  laneId: LaneId | null;
  rankFrom: number;
  rankTo: number;
  component: number;
}

/**
 * 找出可以合并的极大直线段，再按 `MAX_FOLD_RUN` 切段。
 *
 * 资格来自布局模型的 `foldable`（进出各一条、不在往返组里、没有端口/自环、
 * 没有被规格点名），这里再加一条硬条件：**段内执行方必须一致**（`laneId`
 * 相等，按本体自己声明的原文比较，不认任何词表）。因此一次合并永远不可能把
 * 一次人机交接藏起来——这是结构条件，不是约定，`合并永不藏起人机交接` 那条
 * 测试就钉在这一行上。
 */
export function foldRuns(model: OntologyMapModel): FoldGroup[] {
  const byKey = new Map(model.nodes.map((node) => [node.key, node]));
  const nextOf = new Map<string, string>();
  const prevOf = new Map<string, string>();
  for (const edge of model.edges) {
    if (edge.kind !== "forward") continue;
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) continue;
    if (!from.foldable || !to.foldable) continue;
    if (from.laneId !== to.laneId) continue;
    nextOf.set(from.key, to.key);
    prevOf.set(to.key, from.key);
  }

  const groups: FoldGroup[] = [];
  const seen = new Set<string>();
  const emit = (chunk: string[]) => {
    if (chunk.length < MIN_FOLD_RUN) return;
    const members = chunk.map((key) => byKey.get(key)!);
    groups.push({
      id: `fold:${chunk[0]}`,
      memberKeys: chunk,
      memberLabels: members.map((entry) => entry.label),
      laneId: members[0]!.laneId,
      rankFrom: Math.min(...members.map((entry) => entry.rank)),
      rankTo: Math.max(...members.map((entry) => entry.rank)),
      component: members[0]!.component,
    });
  };

  for (const node of model.nodes) {
    if (node.kind !== "action" || !node.foldable) continue;
    if (seen.has(node.key) || prevOf.has(node.key)) continue;
    const chain: string[] = [];
    let cursor: string | undefined = node.key;
    while (cursor && !seen.has(cursor)) {
      chain.push(cursor);
      seen.add(cursor);
      cursor = nextOf.get(cursor);
    }
    if (chain.length < MIN_FOLD_RUN) continue;
    // 切段：整段除以上限向上取整，段长尽量匀，余数留给最后一段。
    for (let at = 0; at < chain.length; at += MAX_FOLD_RUN) {
      const chunk = chain.slice(at, at + MAX_FOLD_RUN);
      // 尾巴太短就并回上一段，免得留下一张「2 个连续环节」的卡。
      if (chunk.length < MIN_FOLD_RUN && groups.length > 0) {
        const last = groups[groups.length - 1]!;
        if (last.memberKeys[0] === chain[at - MAX_FOLD_RUN]) {
          last.memberKeys = last.memberKeys.concat(chunk);
          last.memberLabels = last.memberKeys.map(
            (key) => byKey.get(key)!.label,
          );
          last.rankTo = Math.max(
            ...last.memberKeys.map((key) => byKey.get(key)!.rank),
          );
          continue;
        }
      }
      emit(chunk);
    }
  }
  return groups;
}

/* -------------------------------- 场景 -------------------------------- */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
}

/**
 * 布局模型 → 像素场景。纯函数：同一个模型永远给出同一个场景，
 * 与视口、字体度量、时间都无关。窄栏放不下就让容器自己横向滚，不重排。
 */
export function buildMapScene(
  model: OntologyMapModel,
  options: MapSceneOptions = {},
): MapScene {
  const tier: MapDetailTier =
    model.drawn.cards <= TIER_FULL_MAX
      ? "full"
      : model.drawn.cards <= TIER_COMPACT_MAX
        ? "compact"
        : "dots";

  // 41 个环节起就开始折——这一档以前完全没有规模缓解，一条百环节的链会摊成
  // 一万像素的长带。`full` 档（≤40）本来就一屏看得完，不折。
  const eligible = tier === "full" ? [] : foldRuns(model);
  const expanded = new Set(options.expandedFolds ?? []);
  const groups = eligible.filter((group) => !expanded.has(group.id));
  const foldOf = new Map<string, FoldGroup>();
  for (const group of groups) {
    for (const key of group.memberKeys) foldOf.set(key, group);
  }
  const repOf = (key: string): string => foldOf.get(key)?.id ?? key;

  /* --- 可见节点：真实节点（去掉被合并掉的）+ 合并卡 --- */
  interface Visible {
    key: string;
    label: string;
    kind: "action" | "event";
    laneId: LaneId | null;
    columnOrder: number;
    component: number;
    rank: number;
    rankTo: number;
    source: MapNode | null;
    foldCount: number;
    foldId: string | null;
    foldedLabels: string[];
  }

  const columnOrderOfLane = new Map<LaneId, number>();
  for (const column of model.columns) {
    if (column.kind === "lane") {
      columnOrderOfLane.set(column.laneId as LaneId, column.order);
    }
  }
  const junctionOrder =
    model.columns.find((column) => column.kind === "junction")?.order ?? 0;

  const visible: Visible[] = [];
  const emittedFold = new Set<string>();
  for (const node of model.nodes) {
    if (node.kind === "dummy") continue;
    const group = foldOf.get(node.key);
    if (group) {
      if (emittedFold.has(group.id)) continue;
      emittedFold.add(group.id);
      visible.push({
        key: group.id,
        label: `${group.memberKeys.length} 个连续环节`,
        kind: "action",
        laneId: group.laneId,
        columnOrder: columnOrderOfLane.get(group.laneId ?? "") ?? junctionOrder,
        component: group.component,
        rank: group.rankFrom,
        rankTo: group.rankTo,
        source: null,
        foldCount: group.memberKeys.length,
        foldId: group.id,
        foldedLabels: group.memberLabels,
      });
      continue;
    }
    visible.push({
      key: node.key,
      label: node.label,
      kind: node.kind === "event" ? "event" : "action",
      laneId: node.laneId,
      columnOrder:
        node.columnKind === "lane"
          ? (columnOrderOfLane.get(node.laneId ?? "") ?? junctionOrder)
          : junctionOrder,
      component: node.component,
      rank: node.rank,
      rankTo: node.rank,
      source: node,
      foldCount: 0,
      foldId: null,
      foldedLabels: [],
    });
  }

  /** 端点 → 原名。合并卡用它自己的说法，其余就是本体的原文。 */
  const labelOfVisible = new Map(visible.map((item) => [item.key, item.label]));
  const labelOfEndpoint = (key: string) => labelOfVisible.get(key) ?? "";

  /* --- 连线：合并卡内部的线不画，其余一条不少 --- */
  const drawnEdges: Array<{ edge: MapEdge; from: string; to: string }> = [];
  /** 段内那些线不画了，但它们承载的结果原名跟着合并卡走，绝不静默消失。 */
  const foldedEventsOf = new Map<string, string[]>();
  for (const edge of model.edges) {
    const from = repOf(edge.from);
    const to = repOf(edge.to);
    if (from === to) {
      const list = foldedEventsOf.get(from);
      if (list) list.push(...edge.eventLabels);
      else foldedEventsOf.set(from, [...edge.eventLabels]);
      continue;
    }
    drawnEdges.push({ edge, from, to });
  }
  const liveWaypoints = new Set<string>();
  for (const entry of drawnEdges) {
    for (const key of entry.edge.waypoints) liveWaypoints.add(key);
  }

  /* --- 虚节点：只保留还在用的那些，它们和真实节点抢同一个槽位 --- */
  interface Slotted {
    key: string;
    component: number;
    rank: number;
    columnOrder: number;
    index: number;
    ord: number;
    visible: Visible | null;
  }
  const slotted: Slotted[] = [];
  for (const item of visible) {
    const source = item.source;
    slotted.push({
      key: item.key,
      component: item.component,
      rank: item.rank,
      columnOrder: item.columnOrder,
      index: 0,
      ord: source ? source.ord : Number.MIN_SAFE_INTEGER,
      visible: item,
    });
  }
  for (const node of model.nodes) {
    if (node.kind !== "dummy" || !liveWaypoints.has(node.key)) continue;
    slotted.push({
      key: node.key,
      component: node.component,
      rank: node.rank,
      columnOrder: junctionOrder,
      index: 0,
      ord: node.ord,
      visible: null,
    });
  }

  const cellKey = (entry: Slotted) =>
    `${entry.component}|${entry.rank}|${entry.columnOrder}`;
  const cells = new Map<string, Slotted[]>();
  for (const entry of slotted) {
    const list = cells.get(cellKey(entry));
    if (list) list.push(entry);
    else cells.set(cellKey(entry), [entry]);
  }
  for (const cell of cells.values()) {
    cell.sort((a, b) => a.ord - b.ord);
    cell.forEach((entry, index) => {
      entry.index = index;
    });
  }

  /* --- 槽位几何：一列在任意一层里最多摆几个，就有多宽 --- */
  //
  // 两件事在这里同时解决：
  //   · 一层里超过 `MAX_CELL_SLOTS` 的换行接着摆，宽度因此有硬上限；
  //   · 每个槽位的宽度取该列同一槽位里最宽的那个，虚节点只占 `DUMMY_W`。
  //     以前虚节点按整张卡宽算，一条长边就能把画布宽度顶起来——那是布线在
  //     决定画布宽度，不是内容。
  const slotOf = (index: number) => index % MAX_CELL_SLOTS;
  const subRowOf = (index: number) => Math.floor(index / MAX_CELL_SLOTS);
  const widthOfEntry = (entry: Slotted) => (entry.visible ? CARD_W : DUMMY_W);

  const slotWidth = new Map<string, number>();
  const slotsPerColumn = new Map<number, number>();
  for (const column of model.columns) slotsPerColumn.set(column.order, 0);
  for (const cell of cells.values()) {
    const order = cell[0]!.columnOrder;
    for (const entry of cell) {
      const slot = slotOf(entry.index);
      const key = `${order}|${slot}`;
      slotWidth.set(key, Math.max(slotWidth.get(key) ?? 0, widthOfEntry(entry)));
      slotsPerColumn.set(order, Math.max(slotsPerColumn.get(order) ?? 0, slot + 1));
    }
  }
  const slotX = new Map<string, number>();
  const columnW = new Map<number, number>();
  for (const column of model.columns) {
    const slots = slotsPerColumn.get(column.order) ?? 0;
    let offset = 0;
    for (let slot = 0; slot < slots; slot += 1) {
      slotX.set(`${column.order}|${slot}`, offset);
      offset += (slotWidth.get(`${column.order}|${slot}`) ?? 0) + SLOT_GAP;
    }
    // 空列不占宽度——事件全部内联进连线时，结果列本来就没有东西要摆。
    columnW.set(column.order, slots === 0 ? 0 : px(offset - SLOT_GAP));
  }

  const gutterXs: number[] = [];
  for (let g = 0; g < model.gutterCount; g += 1) {
    // 沟 0 离内容最近，编号越大越靠外——这样加一条沟不会推动已有的那些。
    gutterXs.push(px(PAD_X + (model.gutterCount - 1 - g) * GUTTER_W + GUTTER_W / 2));
  }

  const columnX = new Map<number, number>();
  let cursor = PAD_X + model.gutterCount * GUTTER_W;
  for (const column of model.columns) {
    const own = columnW.get(column.order) ?? 0;
    columnX.set(column.order, px(cursor));
    cursor += own + COL_GAP;
  }
  const width = px(cursor - COL_GAP + PAD_X);

  /* --- 层高与层压缩 --- */
  //
  // 一层的高度 = 这一层里最多要换几行 × ROW_H。一层里一个东西都不摆时高度为 0
  // ——被合并卡吃掉的那些层正好是这种。**折叠因此真的压缩像素**：以前合并卡
  // 自己被拉成一根跨越原区间的长条，省下来的高度是零。
  const subRows = new Map<string, number>();
  for (const cell of cells.values()) {
    const key = `${cell[0]!.component}|${cell[0]!.rank}`;
    subRows.set(
      key,
      Math.max(subRows.get(key) ?? 1, Math.ceil(cell.length / MAX_CELL_SLOTS)),
    );
  }

  const componentOrder = [...new Set(slotted.map((entry) => entry.component))].sort(
    (a, b) => a - b,
  );
  const maxRankOf = new Map<number, number>();
  for (const entry of slotted) {
    maxRankOf.set(
      entry.component,
      Math.max(maxRankOf.get(entry.component) ?? 0, entry.rank),
    );
  }
  for (const item of visible) {
    maxRankOf.set(
      item.component,
      Math.max(maxRankOf.get(item.component) ?? 0, item.rankTo),
    );
  }

  const rankTop = new Map<string, number>();
  const componentHeight = new Map<number, number>();
  let compactedRanks = 0;
  for (const id of componentOrder) {
    let offset = 0;
    const maxRank = maxRankOf.get(id) ?? 0;
    for (let rank = 0; rank <= maxRank; rank += 1) {
      rankTop.set(`${id}|${rank}`, offset);
      const rows = subRows.get(`${id}|${rank}`) ?? 0;
      if (rows === 0) compactedRanks += 1;
      offset += rows * ROW_H;
    }
    componentHeight.set(id, Math.max(offset, ROW_H));
  }
  /** 层空掉时它上面那一层就是真正的落脚点——合并卡因此只占一层。 */
  const anchorTop = (component: number, rank: number): number => {
    let cursorRank = rank;
    while (
      cursorRank > 0 &&
      (subRows.get(`${component}|${cursorRank}`) ?? 0) === 0
    ) {
      cursorRank -= 1;
    }
    return rankTop.get(`${component}|${cursorRank}`) ?? 0;
  };

  /* --- 分量纵向堆叠 --- */
  const componentTop = new Map<number, number>();
  const components: SceneComponent[] = [];
  let top = CONTENT_TOP;
  componentOrder.forEach((id, position) => {
    const own = componentHeight.get(id) ?? ROW_H;
    componentTop.set(id, px(top));
    components.push({
      id,
      position,
      top: px(top),
      height: px(own),
      actionCount:
        model.components.find((entry) => entry.id === id)?.actionCount ?? 0,
    });
    top += own + COMPONENT_GAP;
  });
  const height = px(top - COMPONENT_GAP + PAD_BOTTOM);

  /* --- 盒子 --- */
  const boxOf = new Map<string, Box>();
  const slotIndex = new Map(slotted.map((entry) => [entry.key, entry]));
  const boxFor = (entry: Slotted, item: Visible | null): Box => {
    const slot = slotOf(entry.index);
    const own = slotWidth.get(`${entry.columnOrder}|${slot}`) ?? CARD_W;
    const x = px(
      (columnX.get(entry.columnOrder) ?? 0) +
        (slotX.get(`${entry.columnOrder}|${slot}`) ?? 0),
    );
    const rowTop =
      (componentTop.get(entry.component) ?? 0) +
      (rankTop.get(`${entry.component}|${entry.rank}`) ?? 0) +
      subRowOf(entry.index) * ROW_H;
    if (!item) {
      return {
        x,
        y: px(rowTop + CARD_H / 2),
        w: 0,
        h: 0,
        cx: px(x + own / 2),
      };
    }
    if (item.kind === "event") {
      return {
        x,
        y: px(rowTop + (CARD_H - PILL_H) / 2),
        w: CARD_W,
        h: PILL_H,
        cx: px(x + CARD_W / 2),
      };
    }
    const spanTop =
      anchorTop(entry.component, item.rankTo) -
      (rankTop.get(`${entry.component}|${entry.rank}`) ?? 0);
    return {
      x,
      y: px(rowTop),
      w: CARD_W,
      h: px(Math.max(spanTop, 0) + CARD_H),
      cx: px(x + CARD_W / 2),
    };
  };
  for (const entry of slotted) {
    boxOf.set(entry.key, boxFor(entry, entry.visible));
  }

  /* --- 锚点：每条来源落在自己的锚点上 --- */
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const entry of drawnEdges) {
    (incoming.get(entry.to) ?? incoming.set(entry.to, []).get(entry.to)!).push(
      entry.edge.key,
    );
    (
      outgoing.get(entry.from) ?? outgoing.set(entry.from, []).get(entry.from)!
    ).push(entry.edge.key);
  }
  const labelsOfEdge = new Map(
    drawnEdges.map((entry) => [entry.edge.key, entry.edge.eventLabels]),
  );
  const anchorSpan = (count: number) =>
    Math.min(CARD_W - 26, Math.max(count, 1) * 30);
  const anchorX = (box: Box, count: number, position: number) => {
    if (count <= 1) return box.cx;
    const span = anchorSpan(count);
    return px(box.cx - span / 2 + (span * (position + 0.5)) / count);
  };

  const crowns: SceneCrown[] = [];
  const forks: SceneFork[] = [];
  const inAnchor = new Map<string, [number, number]>();
  const outAnchor = new Map<string, [number, number]>();
  for (const item of visible) {
    const box = boxOf.get(item.key)!;
    const ins = incoming.get(item.key) ?? [];
    const outs = outgoing.get(item.key) ?? [];
    ins.forEach((edgeKey, position) => {
      inAnchor.set(edgeKey, [anchorX(box, ins.length, position), box.y]);
    });
    outs.forEach((edgeKey, position) => {
      outAnchor.set(edgeKey, [
        anchorX(box, outs.length, position),
        px(box.y + box.h),
      ]);
    });
    if (ins.length >= 2) {
      const span = anchorSpan(ins.length);
      crowns.push({
        slot: `c${item.component}r${item.rank}i${boxOf.get(item.key)!.x}`,
        x: px(box.cx - span / 2),
        y: px(box.y - CROWN_DY),
        w: px(span),
        count: ins.length,
        anchors: ins.map((_edgeKey, position) => ({
          slot: `a${position}`,
          x: anchorX(box, ins.length, position),
          y: px(box.y - CROWN_DY),
        })),
      });
    }
    if (outs.length >= 2) {
      const span = anchorSpan(outs.length);
      forks.push({
        slot: `f${item.component}r${item.rank}i${boxOf.get(item.key)!.x}`,
        x: px(box.cx - span / 2),
        y: px(box.y + box.h + CROWN_DY),
        w: px(span),
        count: outs.length,
        anchors: outs.map((_edgeKey, position) => ({
          slot: `a${position}`,
          x: anchorX(box, outs.length, position),
          y: px(box.y + box.h + CROWN_DY),
        })),
      });
    }
  }

  /* --- 连线 --- */
  const edges: SceneEdge[] = drawnEdges.map((entry, position) => {
    const start = outAnchor.get(entry.edge.key) ?? [0, 0];
    const end = inAnchor.get(entry.edge.key) ?? [0, 0];
    const raw: Array<[number, number]> = [];
    if (entry.edge.kind === "back") {
      const fromBox = boxOf.get(entry.from)!;
      const gutter = gutterXs[entry.edge.gutter ?? 0] ?? gutterXs[0] ?? PAD_X;
      raw.push([fromBox.x, px(fromBox.y + fromBox.h / 2)]);
      raw.push([gutter, px(fromBox.y + fromBox.h / 2)]);
      raw.push([gutter, px(end[1] - STUB)]);
      raw.push([end[0], px(end[1] - STUB)]);
      raw.push([end[0], end[1]]);
    } else {
      raw.push([start[0], start[1]]);
      raw.push([start[0], px(start[1] + STUB)]);
      for (const key of entry.edge.waypoints) {
        const way = boxOf.get(key);
        if (way) raw.push([way.cx, way.y]);
      }
      raw.push([end[0], px(end[1] - STUB)]);
      raw.push([end[0], end[1]]);
    }
    // 层被折叠吃掉之后，同一层上的两个折点会落在同一个像素上——重复点画出来
    // 是零长度线段，还会把「贴在最长一段上」的挑选逻辑带偏。去重，不去形状。
    const points = raw.filter(
      (point, index) =>
        index === 0 ||
        point[0] !== raw[index - 1]![0] ||
        point[1] !== raw[index - 1]![1],
    );
    if (points.length === 1) points.push([points[0]![0], points[0]![1] + 1]);
    const last = points[points.length - 1]!;
    const before = points[points.length - 2] ?? last;
    // 标记贴在最长的一段上——贴在折点上会把文字挤到卡边或沟角上。
    let bestAt = 0;
    let bestLength = -1;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const length = Math.hypot(
        points[i + 1]![0] - points[i]![0],
        points[i + 1]![1] - points[i]![1],
      );
      if (length > bestLength) {
        bestLength = length;
        bestAt = i;
      }
    }
    const segmentMid = (index: number): [number, number] => [
      px((points[index]![0] + points[index + 1]![0]) / 2),
      px((points[index]![1] + points[index + 1]![1]) / 2),
    ];
    const mid = segmentMid(bestAt);
    const note =
      entry.edge.kind === "back" && points.length >= 3 ? segmentMid(1) : mid;
    return {
      slot: `e${position}`,
      kind: entry.edge.kind,
      points,
      arrowAt: last,
      arrowFrom: before,
      handoff: entry.edge.handoff,
      eventLabels: entry.edge.eventLabels,
      fromLabel: labelOfEndpoint(entry.from),
      toLabel: labelOfEndpoint(entry.to),
      gutter: entry.edge.gutter,
      midpoint: mid,
      noteAt: note,
    };
  });

  /* --- 往返框 --- */
  const labelOfNode = new Map(model.nodes.map((node) => [node.key, node.label]));
  const edgeByKey = new Map(model.edges.map((edge) => [edge.key, edge]));
  const loops: SceneLoop[] = [];
  for (const group of model.loopGroups) {
    const boxes = group.memberKeys
      .map((key) => (slotIndex.get(repOf(key))?.visible ? boxOf.get(repOf(key)) : null))
      .filter((box): box is Box => Boolean(box));
    if (boxes.length === 0) continue;
    const x = Math.min(...boxes.map((box) => box.x)) - 10;
    const y = Math.min(...boxes.map((box) => box.y)) - CROWN_DY - 10;
    const right = Math.max(...boxes.map((box) => box.x + box.w)) + 10;
    const bottom = Math.max(...boxes.map((box) => box.y + box.h)) + CROWN_DY + 10;
    loops.push({
      slot: `l${group.component}-${px(x)}-${px(y)}`,
      x: px(x),
      y: px(y),
      w: px(right - x),
      h: px(bottom - y),
      memberCount: group.memberKeys.length,
      closes: group.backEdgeKeys.flatMap((key) => {
        const edge = edgeByKey.get(key);
        if (!edge) return [];
        const from = labelOfNode.get(edge.from);
        const to = labelOfNode.get(edge.to);
        return from && to ? [{ from, to }] : [];
      }),
    });
  }

  /* --- 道 --- */
  const lanes: SceneLane[] = model.lanes.map((lane) => {
    const order = columnOrderOfLane.get(lane.id) ?? junctionOrder;
    return {
      id: lane.id,
      order: lane.order,
      x: columnX.get(order) ?? 0,
      w: columnW.get(order) ?? CARD_W,
      actionCount: lane.actionCount,
    };
  });

  /* --- 场景节点 --- */
  const sceneNodes: SceneNode[] = visible.map((item) => {
    const box = boxOf.get(item.key)!;
    const source = item.source;
    const laneOrder =
      item.laneId === null
        ? null
        : (model.lanes.find((lane) => lane.id === item.laneId)?.order ?? null);
    const inKeys = incoming.get(item.key) ?? [];
    const outKeys = outgoing.get(item.key) ?? [];
    const ins = inKeys.length;
    const outs = outKeys.length;
    return {
      slot: `n${item.component}-${item.rank}-${box.x}`,
      label: item.label,
      kind: item.kind,
      laneId: item.laneId,
      laneOrder,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      cx: box.cx,
      inDegree: ins,
      outDegree: outs,
      inLabels: inKeys.flatMap((key) => labelsOfEdge.get(key) ?? []),
      outLabels: outKeys.flatMap((key) => labelsOfEdge.get(key) ?? []),
      entryPorts: source?.entryPorts ?? [],
      exitPorts: source?.exitPorts ?? [],
      selfLoops: source?.selfLoops ?? [],
      eventRole: source?.eventRole ?? null,
      highlighted: source?.highlighted ?? false,
      focused: source?.focused ?? false,
      inLoop: source?.loopGroup !== null && source?.loopGroup !== undefined,
      foldCount: item.foldCount,
      foldId: item.foldId,
      foldedLabels: item.foldedLabels,
      foldedEventLabels: foldedEventsOf.get(item.key) ?? [],
      component: item.component,
      rank: item.rank,
    };
  });

  const foldedActions = groups.reduce(
    (sum, group) => sum + group.memberKeys.length,
    0,
  );
  const foldableActions = eligible.reduce(
    (sum, group) => sum + group.memberKeys.length,
    0,
  );

  return {
    width,
    height,
    headHeight: LANE_HEAD_H,
    tier,
    nodes: sceneNodes,
    edges,
    crowns,
    forks,
    loops,
    lanes,
    junction:
      (slotsPerColumn.get(junctionOrder) ?? 0) > 0
        ? {
            x: columnX.get(junctionOrder) ?? 0,
            w: columnW.get(junctionOrder) ?? 0,
          }
        : null,
    components,
    gutterXs,
    foldedActions,
    foldGroupCount: groups.length,
    foldableActions,
    compactedRanks,
    mergeCount: sceneNodes.filter((node) => node.inDegree >= 2).length,
    forkCount: sceneNodes.filter((node) => node.outDegree >= 2).length,
    backCount: edges.filter((edge) => edge.kind === "back").length,
    maxRankCount: model.components.reduce(
      (max, entry) => Math.max(max, entry.rankCount),
      0,
    ),
  };
}

/* -------------------------------- 缩略条 -------------------------------- */

export interface MapMinimapRect {
  slot: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "action" | "event";
  folded: boolean;
}

export interface MapMinimap {
  width: number;
  height: number;
  /** 场景像素 → 缩略像素的比例，用来把滚动位置换算成取景框。 */
  scale: number;
  rects: MapMinimapRect[];
}

/**
 * 整张图等比塞进一条固定宽度的带子。
 *
 * 长图上「我现在在哪」这件事光靠滚动条答不出来——缩略条给的是整体形状，
 * 取景框（由滚动位置换算，不在这一层）给的是位置。同样是纯函数。
 */
export function buildMapMinimap(
  scene: MapScene,
  width: number,
  maxHeight: number,
): MapMinimap {
  const scale = Math.min(
    width / Math.max(scene.width, 1),
    maxHeight / Math.max(scene.height, 1),
  );
  const height = Math.max(
    1,
    Math.min(maxHeight, Math.round(scene.height * scale)),
  );
  const clamp = (value: number, limit: number) =>
    Math.max(0, Math.min(value, limit));
  return {
    width,
    height,
    scale,
    rects: scene.nodes.map((node) => {
      const w = clamp(Math.max(1, Math.round(node.w * scale)), width);
      const h = clamp(Math.max(1, Math.round(node.h * scale)), height);
      return {
        slot: node.slot,
        x: clamp(Math.round(node.x * scale), width - w),
        y: clamp(Math.round(node.y * scale), height - h),
        w,
        h,
        kind: node.kind,
        folded: node.foldCount > 0,
      };
    }),
  };
}
