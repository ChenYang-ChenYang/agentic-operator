// OntoCode v10 · 地图的产物读取层：从 Ontology 分析产物里取出那张动作表。
//
// 唯一数据来源是分析产物里那张 `ontology-actions` 表——服务端
// `buildOntologyAnalysisPresentation` 直接照 `ontology.actions` 逐行编出来的：
// 每行的 `triggers` 就是 `action.trigger`（这个动作消费的事件），`emits` 就是
// `action.triggered_event`（它产出的事件），`actor` 就是声明的执行方原文。
// 因此每一条关系都能回指到本体里的一处声明，没有一条是从名字或描述猜出来的。
//
// 刻意没有用 `structure.eventChains`：那个链在服务端是 `[0]` 折叠过的
// （只跟第一个消费者、第一个产出事件），当作边集会漏掉真实的分叉。
//
// 也刻意直接读产物原文，而不是复用 parseAnalystPresentation 的结果：那个解析器
// 会把每个单元格的标签数组静默截到 12 个，一个动作只要挂了更多事件，边就会在
// 到达这里之前消失且无人知情。
//
// 这一层只做「读产物、认表、取四列原文」，不做任何图论加工——图论住在
// `ontology-map-layout.ts`，它的输入必须是可以手写出来的普通数组才可能被单独测。
//
// 曾经这里还住着一棵树模型（`buildOntologyMapModel`）。它连同 `actorOf`
// 一起被删了：树只给得起一个父亲，合流与环因此被降级成文字注解，那正是新设计
// 明令废止的做法；`actorOf` 更是按 `"agent"` 这个字面量把执行方归类成机器或人，
// 是一份硬编码的业务词表。整套东西没有任何生产调用方，只有它自己的测试在保绿。
// 泳道现在按 `actor[]` 的原文分道，一个词表都不认。

const ACTIONS_BLOCK_ID = "ontology-actions";
const ACTION_COLUMN = "action";
const ACTOR_COLUMN = "actor";
const TRIGGERS_COLUMN = "triggers";
const EMITS_COLUMN = "emits";

interface ActionsTable {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function columnKeys(block: Record<string, unknown>): Set<string> {
  if (!Array.isArray(block.columns)) return new Set();
  return new Set(
    block.columns.flatMap((column) =>
      isRecord(column) && typeof column.key === "string" ? [column.key] : [],
    ),
  );
}

/** 认表：优先服务端固定的 id，退而认列结构，两者都不成立才放弃。 */
function isActionsTable(block: unknown): block is Record<string, unknown> {
  if (!isRecord(block) || block.kind !== "table") return false;
  if (!Array.isArray(block.rows)) return false;
  if (block.id === ACTIONS_BLOCK_ID) return true;
  const keys = columnKeys(block);
  return (
    keys.has(ACTION_COLUMN) &&
    (keys.has(TRIGGERS_COLUMN) || keys.has(EMITS_COLUMN))
  );
}

function presentationOf(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  return isRecord(raw.presentation) ? raw.presentation : raw;
}

/**
 * 从 Ontology 分析产物原文里取出那张动作表。
 * 传进来的既可以是整份产物（含 `presentation` 外壳），也可以是 presentation 本身。
 */
function findActionsTable(raw: unknown): ActionsTable | null {
  const source = presentationOf(raw);
  if (!source || !Array.isArray(source.blocks)) return null;
  const block = source.blocks.find(isActionsTable);
  if (!block || !Array.isArray(block.rows)) return null;
  return {
    rows: block.rows.filter(isRecord),
    truncated: block.truncated === true,
  };
}

function textCell(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `tags` 列到达浏览器时已是 string[]；单串也接受，空值不编造。 */
function listCell(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const text = textCell(entry);
      return text ? [text] : [];
    });
  }
  const single = textCell(value);
  return single ? [single] : [];
}

/** 产物 → 布局模型的输入（`ontology-map-layout.ts` 消费）。 */
export interface MapSourceRowInput {
  action: string;
  actor: string[];
  triggers: string[];
  emits: string[];
}
export interface MapSourceInput {
  rows: MapSourceRowInput[];
  sourceTruncated: boolean;
}

/**
 * 缺失或退化的产物给出空输入而不是抛错——由界面如实显示「暂无可展示的关系」，
 * 既不抛，也不补一张假图。
 */
export function readMapSource(raw: unknown): MapSourceInput {
  const table = findActionsTable(raw);
  if (!table) return { rows: [], sourceTruncated: false };
  return {
    rows: table.rows.map((row) => ({
      action: textCell(row[ACTION_COLUMN]),
      actor: listCell(row[ACTOR_COLUMN]),
      triggers: listCell(row[TRIGGERS_COLUMN]),
      emits: listCell(row[EMITS_COLUMN]),
    })),
    sourceTruncated: table.truncated === true,
  };
}
