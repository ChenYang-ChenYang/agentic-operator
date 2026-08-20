// The READ-ONLY ontology tool layer — schemas + handlers, closed over ONE
// DomainOntology.
//
// This used to live inside `runOntologyInquiry`, where it was reachable only by
// the prose analysis loop. It is extracted because a SECOND surface needs the
// exact same reads: the conversation path (`ontocode-assistant-*`) has to be
// able to verify a fact before it routes a turn, and a second implementation of
// "read this ontology" would be a second place for the tenant boundary to be
// got wrong.
//
// ── the closure IS the boundary ──────────────────────────────────────────────
//
// No handler here takes a domain, a tenant or an id namespace. A caller resolves
// exactly one `DomainOntology` — through whatever authorization its own entry
// point already performed — and hands it to `createOntologyReadToolHandlers`.
// Everything the model can then read is inside that object. Adding a
// `domain`/`tenantId` parameter to any tool in this file would open the boundary
// and is forbidden; a caller that needs another domain builds another closure.
//
// ── every call must say why ──────────────────────────────────────────────────
//
// `inquiryParams` forces a `reasoning` string onto every tool. That single field
// is what makes a tool frame readable ("列出所有 Action 以确认 actor 是否包含
// Agent") instead of a bare name, and it is required by the SCHEMA rather than
// by a prompt sentence, so a model cannot quietly skip it.
//
// ── honesty about clipping ───────────────────────────────────────────────────
//
// Every list is capped and every capped list reports its PRE-CAP total. A result
// whose payload itself was cut sets `truncated`. `unclipped` marks the two reads
// (`read_action`, `read_rule`, single-entry `read_workflow`) whose whole point is
// a verbatim contract; the caller is expected to honour that with a wider
// serialization bound rather than silently shortening them.

import {
  compareOntologyActions,
  ontologyCoverageGaps,
  ontologyRuleAddress,
  readOntologyLinks,
  readOntologyRule,
  readOntologyWorkflow,
  ONTOLOGY_ID_LIST_CAP_DEFAULT,
  ONTOLOGY_LINK_MAX_DEPTH,
  ONTOLOGY_LINK_READ_CAP_DEFAULT,
  ONTOLOGY_WORKFLOW_LIST_CAP_DEFAULT,
} from "./ontology-graph-reads";
import {
  computeAnalysisAggregate,
  listAnalysisAggregates,
} from "./ontology-aggregates";
import { computeAnalysisTable, listAnalysisTables } from "./ontology-tables";
import type { ToolSchema } from "./stream-gateway";
import type {
  DomainOntology,
  OntologyAction,
  OntologyEvent,
  OntologyObject,
} from "./ontology-types";

// ── knobs (every numeric bound is a named constant with an env override) ─────

export const ONTOLOGY_INQUIRY_EVENT_LIST_CAP_ENV =
  "ONTOLOGY_INQUIRY_EVENT_LIST_CAP";
export const ONTOLOGY_INQUIRY_EVENT_LIST_CAP_DEFAULT = 60;
export const ONTOLOGY_INQUIRY_SEARCH_RESULT_CAP_ENV =
  "ONTOLOGY_INQUIRY_SEARCH_RESULT_CAP";
export const ONTOLOGY_INQUIRY_SEARCH_RESULT_CAP_DEFAULT = 30;
export const ONTOLOGY_INQUIRY_NAME_LIST_CAP_ENV =
  "ONTOLOGY_INQUIRY_NAME_LIST_CAP";
export const ONTOLOGY_INQUIRY_NAME_LIST_CAP_DEFAULT = 200;
/** Relationship edges ONE `read_links` call returns. */
export const ONTOLOGY_INQUIRY_LINK_CAP_ENV = "ONTOLOGY_INQUIRY_LINK_CAP";
export const ONTOLOGY_INQUIRY_LINK_CAP_DEFAULT = ONTOLOGY_LINK_READ_CAP_DEFAULT;
/** Ids ONE derived id list (coverage gap group, diff side, reached set,
 * bound-action list) returns. Every such list reports its pre-cap total. */
export const ONTOLOGY_INQUIRY_ID_LIST_CAP_ENV = "ONTOLOGY_INQUIRY_ID_LIST_CAP";
export const ONTOLOGY_INQUIRY_ID_LIST_CAP_DEFAULT = ONTOLOGY_ID_LIST_CAP_DEFAULT;
/** Workflow entries ONE `read_workflow` listing returns. */
export const ONTOLOGY_INQUIRY_WORKFLOW_LIST_CAP_ENV =
  "ONTOLOGY_INQUIRY_WORKFLOW_LIST_CAP";
export const ONTOLOGY_INQUIRY_WORKFLOW_LIST_CAP_DEFAULT =
  ONTOLOGY_WORKFLOW_LIST_CAP_DEFAULT;
/** Radius around a search hit that becomes the returned snippet. */
export const ONTOLOGY_INQUIRY_SNIPPET_RADIUS_ENV =
  "ONTOLOGY_INQUIRY_SNIPPET_RADIUS";
export const ONTOLOGY_INQUIRY_SNIPPET_RADIUS_DEFAULT = 80;
/** Hard bound on ONE search snippet. A snippet cut by this reports truncated —
 * the honesty rule applies to this file's own clipping, not just to list caps. */
export const ONTOLOGY_INQUIRY_SNIPPET_CHARS_ENV =
  "ONTOLOGY_INQUIRY_SNIPPET_CHARS";
export const ONTOLOGY_INQUIRY_SNIPPET_CHARS_DEFAULT = 240;
/** Bound on any MODEL-SUPPLIED string echoed back in a tool summary (a filter,
 * a query, a name it got wrong, an unknown tool name) — one knob, because they
 * are the same class of untrusted echo. */
export const ONTOLOGY_INQUIRY_ECHO_CHARS_ENV = "ONTOLOGY_INQUIRY_ECHO_CHARS";
export const ONTOLOGY_INQUIRY_ECHO_CHARS_DEFAULT = 120;

export function ontologyReadEnvInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Model-visible names for the entity kinds a link anchor can resolve to.
 * Exported so the neutrality gate scans the exact strings that are sent. */
export const ONTOLOGY_ENTITY_KIND_LABELS: Record<string, string> = {
  object: "对象",
  action: "动作",
  event: "事件",
  rule: "规则",
};

/** Model-visible names for the coverage-gap groups. The machine-readable
 * `kind` stays in the payload; only the SUMMARY line is relabelled, so the
 * model can still key off a stable identifier while the one-line summary reads
 * as a sentence. Every label is generic ontology vocabulary. */
export const ONTOLOGY_GAP_GROUP_LABELS: Record<string, string> = {
  events_without_producer: "无产出方的事件",
  events_without_consumer: "无消费方的事件",
  actions_without_trigger: "不消费任何事件的动作",
  actions_without_emitted_event: "不产出任何事件的动作",
  objects_not_referenced: "未被任何声明引用的对象",
  rules_not_bound_to_any_action_step: "未被任何动作步骤绑定的规则",
  rules_without_declared_id: "未声明 id 的规则",
};

/** Same convention as the build brain's `params()`: every tool REQUIRES a
 * one-line `reasoning` so each call is auditable before it acts. */
export function inquiryParams(
  props: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description: "动手前用一句话说清你为什么这么做。",
      },
      ...props,
    },
    required: ["reasoning", ...required],
    additionalProperties: false,
  };
}

export function inquiryTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

// ── shared helpers ───────────────────────────────────────────────────────────

export function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function boundedNames(
  names: string[],
  cap: number,
): { names: string[]; total: number; truncated: boolean } {
  return {
    names: names.slice(0, cap),
    total: names.length,
    truncated: names.length > cap,
  };
}

export function eventPayload(event: OntologyEvent): OntologyEvent["payload"] {
  return event.payload && typeof event.payload === "object"
    ? event.payload
    : { source_action: null, event_data: [], state_mutations: [] };
}

export function findAction(
  ontology: DomainOntology,
  name: string,
): OntologyAction | null {
  return (
    (ontology.actions ?? []).find(
      (action) => action.name === name || action.id === name,
    ) ?? null
  );
}

export function findObject(
  ontology: DomainOntology,
  name: string,
): OntologyObject | null {
  return (
    (ontology.objects ?? []).find(
      (object) => object.id === name || object.name === name,
    ) ?? null
  );
}

export function snippetAround(
  text: string,
  index: number,
  radius: number,
): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// ── result shape ─────────────────────────────────────────────────────────────

export interface OntologyReadToolResult {
  ok: boolean;
  summary: string;
  output?: unknown;
  /** The bounded payload itself was cut (in addition to any list caps). */
  truncated?: boolean;
  /** Whole fields by contract — never clipped by the caller's result bound. */
  unclipped?: boolean;
}

export type OntologyReadToolHandler = (
  args: Record<string, unknown>,
) => Promise<OntologyReadToolResult>;

/**
 * The read-only tool names, in the order they are advertised. Exported so a
 * caller can state exactly which tools it exposed without re-deriving the list
 * from the schemas (and so a test can pin that both surfaces expose the same
 * closed set).
 */
export const ONTOLOGY_READ_TOOL_NAMES = [
  "list_events",
  "read_action",
  "read_object",
  "search",
  "read_links",
  "read_rule",
  "read_workflow",
  "coverage_gaps",
  "compare_actions",
  "table_data",
  "chart_data",
] as const;

export type OntologyReadToolName = (typeof ONTOLOGY_READ_TOOL_NAMES)[number];

/** The read-only tool schemas. Pure — the same text for every ontology. */
export function buildOntologyReadToolSchemas(): ToolSchema[] {
  const aggregates = listAnalysisAggregates();
  const aggregateEnum = aggregates.map((entry) => entry.name);
  const aggregateDoc = aggregates
    .map((entry) => `${entry.name}：${entry.description}`)
    .join(" ");
  const tables = listAnalysisTables();
  const tableEnum = tables.map((entry) => entry.name);
  const tableDoc = tables
    .map((entry) => `${entry.name}：${entry.description}`)
    .join(" ");
  return [
    inquiryTool(
      "list_events",
      "列出本体中的事件（名称、描述、producers、consumers、payload 字段名与 target_objects）。结果有上限并如实标注截断。",
      inquiryParams({
        filter: {
          type: "string",
          description: "可选。大小写不敏感的子串过滤（匹配事件名或描述）。",
        },
      }),
    ),
    inquiryTool(
      "read_action",
      "读取一个动作的完整契约：全部字段、原文、不截断。用于逐字核对触发事件、产出事件、输入输出与步骤。",
      inquiryParams(
        {
          name: {
            type: "string",
            description: "动作的准确 name 或 id。",
          },
        },
        ["name"],
      ),
    ),
    inquiryTool(
      "read_object",
      "读取一个对象的完整声明（含属性、主键、外键引用）。",
      inquiryParams(
        {
          name: {
            type: "string",
            description: "对象的准确 id 或 name。",
          },
        },
        ["name"],
      ),
    ),
    inquiryTool(
      "search",
      "在事件 / 动作 / 对象 / 规则中做大小写不敏感的子串检索。结果有上限并如实标注截断。",
      inquiryParams(
        {
          query: {
            type: "string",
            description: "要检索的子串。",
          },
        },
        ["query"],
      ),
    ),
    inquiryTool(
      "read_links",
      "读取本体里编译好的关系边（每条边的 id、类型与两端实体）。不给锚点 = 读全图；给锚点 = 只读与该实体相连的边，可按跳数向外遍历。返回的边有上限并如实标注截断；端点的完整性计数覆盖全部命中的边（含被上限截掉的那些）：写了 id 但在本体中找不到对应实体的端点单独计数，没有写 id 的端点也单独计数（两者是不同的事实，都不会被丢掉）。这两类的 id 清单本身也有上限，会同时给出截断前的真实数量。",
      inquiryParams({
        anchor: {
          type: "string",
          description:
            "可选。以某个实体（对象 / 动作 / 事件 / 规则）的 id 为锚点，只读与它相连的边。",
        },
        kind: {
          type: "string",
          description:
            "可选。只读这一种关系类型的边（精确匹配）。与 anchor 同时给出时，向外遍历也只沿这一类边进行。",
        },
        depth: {
          type: "number",
          description: `可选。从锚点向外遍历几跳（默认 1，上限 ${ONTOLOGY_LINK_MAX_DEPTH}；超过上限会按上限执行并如实告知）。不给锚点时无意义。`,
        },
      }),
    ),
    inquiryTool(
      "read_rule",
      "读取一条规则的完整正文，以及经 action_steps[].rules[] 精确引用到它的动作。用规则声明的 id 寻址；规则没有声明 id 时可以用序号（rule:N 或 N，从 1 开始），返回结果会明说这次是按序号寻址、序号在本体版本之间不稳定。",
      inquiryParams(
        {
          rule: {
            type: "string",
            description: "规则声明的 id，或序号形式（rule:3 / 3）。",
          },
        },
        ["rule"],
      ),
    ),
    inquiryTool(
      "read_workflow",
      "读取本体的工作流条目。不给 index = 列出全部条目（序号、声明的 id/name 与字段名）；给 index = 读那一条的完整内容、不截断。",
      inquiryParams({
        index: {
          type: "number",
          description: "可选。要读的条目序号（从 0 开始）。省略 = 列出全部。",
        },
      }),
    ),
    inquiryTool(
      "coverage_gaps",
      "读取本体的结构性缺口（确定性派生，不含任何判断）：没有产出方 / 没有消费方的事件、不消费 / 不产出事件的动作、没有被任何地方引用的对象、没有被任何动作步骤绑定的规则、没有声明 id 的规则，以及关系边端点的两类问题（写了 id 但解析不到实体、以及根本没写 id）。每组都给出真实总数与（有上限的）id 列表。",
      inquiryParams({}),
    ),
    inquiryTool(
      "compare_actions",
      "对比两个动作【声明的】契约：执行者 / 消费事件 / 产出事件 / 目标对象 / 工具 / 步骤绑定规则的差集与交集，类别的取值差异，输入输出与步骤的数量差异，以及各长文本字段是否被声明。只报差异，不做优劣判断。",
      inquiryParams(
        {
          a: { type: "string", description: "第一个动作的准确 name 或 id。" },
          b: { type: "string", description: "第二个动作的准确 name 或 id。" },
        },
        ["a", "b"],
      ),
    ),
    inquiryTool(
      "table_data",
      `读取一个服务端表格推导的完整结果【仅供你自己阅读】——不会推送给用户。列与单元格全部由服务端从本体算出。想把同一份表格展示给用户时才用 present_table。可用推导：${tableDoc}`,
      inquiryParams(
        {
          derivation: {
            type: "string",
            enum: tableEnum,
            description: "表格推导名称。",
          },
        },
        ["derivation"],
      ),
    ),
    inquiryTool(
      "chart_data",
      `读取一个服务端计算的确定性聚合（rows 永远由服务端从本体算出）。可用聚合：${aggregateDoc}`,
      inquiryParams(
        {
          aggregate: {
            type: "string",
            enum: aggregateEnum,
            description: "聚合名称。",
          },
        },
        ["aggregate"],
      ),
    ),
  ];
}

/**
 * The read-only handlers, closed over ONE ontology.
 *
 * Caps are read from the environment at construction so a caller does not have
 * to thread nine numbers through; pass `env` to pin them in a test.
 */
export function createOntologyReadToolHandlers(input: {
  ontology: DomainOntology;
  env?: Record<string, string | undefined>;
}): Record<OntologyReadToolName, OntologyReadToolHandler> {
  const { ontology } = input;
  const env = input.env ?? process.env;
  const eventListCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_EVENT_LIST_CAP_ENV,
    ONTOLOGY_INQUIRY_EVENT_LIST_CAP_DEFAULT,
    env,
  );
  const searchCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_SEARCH_RESULT_CAP_ENV,
    ONTOLOGY_INQUIRY_SEARCH_RESULT_CAP_DEFAULT,
    env,
  );
  const nameCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_NAME_LIST_CAP_ENV,
    ONTOLOGY_INQUIRY_NAME_LIST_CAP_DEFAULT,
    env,
  );
  const linkCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_LINK_CAP_ENV,
    ONTOLOGY_INQUIRY_LINK_CAP_DEFAULT,
    env,
  );
  const idListCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_ID_LIST_CAP_ENV,
    ONTOLOGY_INQUIRY_ID_LIST_CAP_DEFAULT,
    env,
  );
  const workflowListCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_WORKFLOW_LIST_CAP_ENV,
    ONTOLOGY_INQUIRY_WORKFLOW_LIST_CAP_DEFAULT,
    env,
  );
  const snippetRadius = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_SNIPPET_RADIUS_ENV,
    ONTOLOGY_INQUIRY_SNIPPET_RADIUS_DEFAULT,
    env,
  );
  const snippetCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_SNIPPET_CHARS_ENV,
    ONTOLOGY_INQUIRY_SNIPPET_CHARS_DEFAULT,
    env,
  );
  const echoCap = ontologyReadEnvInt(
    ONTOLOGY_INQUIRY_ECHO_CHARS_ENV,
    ONTOLOGY_INQUIRY_ECHO_CHARS_DEFAULT,
    env,
  );

  return {
    list_events: async (args) => {
      const filter = textValue(args.filter)?.toLowerCase() ?? null;
      const all = ontology.events ?? [];
      const filtered = filter
        ? all.filter((event) =>
            [event.name, event.description ?? ""]
              .join("\n")
              .toLowerCase()
              .includes(filter),
          )
        : all;
      const shown = filtered.slice(0, eventListCap);
      return {
        ok: true,
        summary: `${filtered.length} 个事件${filter ? `（过滤条件：${clip(filter, echoCap)}）` : ""}，返回 ${shown.length} 个${filtered.length > shown.length ? "（已截断）" : ""}`,
        truncated: filtered.length > shown.length,
        output: {
          total: filtered.length,
          shown: shown.length,
          truncated: filtered.length > shown.length,
          events: shown.map((event) => {
            const payload = eventPayload(event);
            return {
              name: event.name,
              ...(event.description ? { description: event.description } : {}),
              producers: event.producers ?? [],
              consumers: event.consumers ?? [],
              source_action: payload.source_action ?? null,
              payload_fields: (payload.event_data ?? []).map((field) => ({
                name: field.name,
                target_object: field.target_object ?? null,
              })),
            };
          }),
        },
      };
    },
    read_action: async (args) => {
      const name = textValue(args.name);
      if (!name) return { ok: false, summary: "缺少 name 参数" };
      const action = findAction(ontology, name);
      if (!action) {
        const bounded = boundedNames(
          (ontology.actions ?? []).map((entry) => entry.name || entry.id),
          nameCap,
        );
        return {
          ok: false,
          summary: `找不到动作「${clip(name, echoCap)}」`,
          output: {
            available: bounded.names,
            total: bounded.total,
            truncated: bounded.truncated,
          },
        };
      }
      // WHOLE fields, no clipping — that is the point versus the scope path.
      return {
        ok: true,
        summary: `动作「${action.name}」完整契约`,
        output: action,
        unclipped: true,
      };
    },
    read_object: async (args) => {
      const name = textValue(args.name);
      if (!name) return { ok: false, summary: "缺少 name 参数" };
      const object = findObject(ontology, name);
      if (!object) {
        const bounded = boundedNames(
          (ontology.objects ?? []).map((entry) => entry.id || entry.name || ""),
          nameCap,
        );
        return {
          ok: false,
          summary: `找不到对象「${clip(name, echoCap)}」`,
          output: {
            available: bounded.names,
            total: bounded.total,
            truncated: bounded.truncated,
          },
        };
      }
      return {
        ok: true,
        summary: `对象「${object.id}」完整声明`,
        output: object,
      };
    },
    search: async (args) => {
      const query = textValue(args.query)?.toLowerCase();
      if (!query) return { ok: false, summary: "缺少 query 参数" };
      const matches: Array<{
        kind: "event" | "action" | "object" | "rule";
        id: string;
        matchedIn: string;
        snippet: string;
        /** This snippet was cut by the snippet cap (separate from the surrounding
         * "…" that mark the excerpt's own window into a longer field). */
        snippetTruncated?: boolean;
      }> = [];
      const consider = (
        kind: "event" | "action" | "object" | "rule",
        id: string,
        field: string,
        text: string | null | undefined,
      ) => {
        if (!text) return;
        const index = text.toLowerCase().indexOf(query);
        if (index < 0) return;
        const around = snippetAround(text, index, snippetRadius);
        const snippet = clip(around, snippetCap);
        matches.push({
          kind,
          id,
          matchedIn: field,
          snippet,
          ...(around.trim().length > snippetCap
            ? { snippetTruncated: true }
            : {}),
        });
      };
      for (const event of ontology.events ?? []) {
        consider("event", event.name, "name", event.name);
        consider("event", event.name, "description", event.description);
        for (const field of eventPayload(event).event_data ?? []) {
          consider("event", event.name, `payload.${field.name}`, field.name);
        }
      }
      for (const action of ontology.actions ?? []) {
        const id = action.name || action.id;
        consider("action", id, "name", action.name);
        consider("action", id, "id", action.id);
        consider("action", id, "description", action.description);
        consider("action", id, "category", action.category);
      }
      for (const object of ontology.objects ?? []) {
        const id = object.id || object.name || "";
        consider("object", id, "id", object.id);
        consider("object", id, "name", object.name);
        consider("object", id, "description", object.description);
        consider("object", id, "type", object.type);
        for (const property of object.properties ?? []) {
          consider("object", id, `property.${property.name}`, property.name);
        }
      }
      for (const [index, rule] of (ontology.rules ?? []).entries()) {
        // ONE addressing rule for rules, shared with read_rule and the seed
        // prompt: a search hit the model cannot then feed back to read_rule
        // would be a dead end.
        const { id } = ontologyRuleAddress(
          rule as Record<string, unknown>,
          index,
        );
        consider("rule", id, "json", JSON.stringify(rule));
      }
      const shown = matches.slice(0, searchCap);
      // Honesty applies to THIS tool's own clipping too: a snippet cut by the
      // snippet cap is truncated output, whether or not the result LIST was
      // also capped. Reporting only the list cap made a cut snippet read as a
      // complete quotation.
      const listTruncated = matches.length > shown.length;
      const snippetsTruncated = shown.filter(
        (match) => match.snippetTruncated,
      ).length;
      return {
        ok: true,
        summary: `检索「${clip(query, echoCap)}」命中 ${matches.length} 处，返回 ${shown.length} 处${listTruncated ? "（已截断）" : ""}${snippetsTruncated > 0 ? `（其中 ${snippetsTruncated} 处摘录本身超出 ${snippetCap} 字符已截断）` : ""}`,
        truncated: listTruncated || snippetsTruncated > 0,
        output: {
          total: matches.length,
          shown: shown.length,
          truncated: listTruncated,
          ...(snippetsTruncated > 0 ? { snippetsTruncated } : {}),
          matches: shown,
        },
      };
    },
    read_links: async (args) => {
      const anchor = textValue(args.anchor);
      const kind = textValue(args.kind);
      const rawDepth = Number(args.depth);
      const result = readOntologyLinks(ontology, {
        ...(anchor ? { anchor } : {}),
        ...(kind ? { kind } : {}),
        ...(Number.isFinite(rawDepth) ? { depth: rawDepth } : {}),
        cap: linkCap,
        kindCap: idListCap,
        reachedCap: idListCap,
        unresolvedCap: idListCap,
      });
      if (!result.linksDeclared) {
        // "The export has no link collection" and "the graph has no edges" are
        // different facts, and only the second one is a statement about the
        // domain. Collapsing them would let the model conclude the latter.
        return {
          ok: false,
          summary:
            "这份本体未声明关系边集合：不是「关系边为 0」，而是这次导出里根本没有这个集合。关系不能据此推断。",
        };
      }
      const anchorNote = result.anchor
        ? `（锚点「${clip(result.anchor.id, echoCap)}」${
            result.anchor.resolvedAs
              ? `解析为${ONTOLOGY_ENTITY_KIND_LABELS[result.anchor.resolvedAs]}`
              : "在本体中解析不到实体"
          }，遍历 ${result.anchor.depth} 跳${
            result.anchor.depthRequested
              ? `（请求 ${result.anchor.depthRequested} 跳，上限 ${ONTOLOGY_LINK_MAX_DEPTH}）`
              : ""
          }，触达 ${result.anchor.reachedTotal} 个实体${
            result.anchor.reachedTruncated ? "（列表已截断）" : ""
          }）`
        : "";
      const kindNote = kind ? `（关系类型过滤：${clip(kind, echoCap)}）` : "";
      // The COUNTS are exact and cover every MATCHED edge, including the ones
      // the page cap withheld. The id lists are bounded, and say so — both in
      // the payload (`…IdsTotal` / `…Truncated`) and here.
      const unresolvedNote =
        result.unresolvedEndpoints > 0
          ? `（其中 ${result.unresolvedEndpoints} 个端点在本体中未解析到实体，共 ${result.unresolvedEndpointIdsTotal} 个不同 id${
              result.unresolvedEndpointIdsTruncated
                ? `，仅列出 ${result.unresolvedEndpointIds.length} 个`
                : ""
            }：${clip(result.unresolvedEndpointIds.join("、"), echoCap)}）`
          : "";
      const unaddressableNote =
        result.unaddressableEndpoints > 0
          ? `（另有 ${result.unaddressableEndpoints} 个端点根本没有可寻址 id——不是「解析不到」，是这条边上的这一端没写 id；分布在 ${result.unaddressableEndpointLinkIdsTotal} 条边上${
              result.unaddressableEndpointLinkIdsTruncated
                ? `，仅列出 ${result.unaddressableEndpointLinkIds.length} 条`
                : ""
            }：${clip(result.unaddressableEndpointLinkIds.join("、"), echoCap)}）`
          : "";
      return {
        ok: true,
        summary: `本体共 ${result.totalInOntology} 条关系边，命中 ${result.matched} 条${kindNote}${anchorNote}，返回 ${result.links.length} 条${result.truncated ? "（已截断）" : ""}${unresolvedNote}${unaddressableNote}`,
        truncated: result.truncated,
        output: result,
      };
    },
    read_rule: async (args) => {
      const reference = textValue(args.rule);
      if (!reference) return { ok: false, summary: "缺少 rule 参数" };
      const result = readOntologyRule(ontology, reference, {
        idCap: idListCap,
        matchCap: idListCap,
        availableCap: nameCap,
      });
      if (!result.found) {
        return {
          ok: false,
          summary: `找不到规则「${clip(reference, echoCap)}」；本体共 ${result.rulesTotal} 条规则、${result.available?.total ?? 0} 个可寻址 id${
            result.available?.truncated
              ? `（仅列出前 ${result.available.ids.length} 个）`
              : ""
          }`,
          output: result.available,
        };
      }
      const ordinalNote =
        result.addressedBy === "ordinal"
          ? "（该规则未声明 id，本次以序号寻址；序号是它在这份导出里的位置，在本体版本之间不稳定）"
          : "";
      const duplicateNote =
        result.matchTotal > 1
          ? `（有 ${result.matchTotal} 条规则声明了同一个 id，已全部返回${result.matchTruncated ? "，且列表已截断" : ""}）`
          : "";
      return {
        ok: true,
        summary: `规则「${clip(reference, echoCap)}」完整正文${ordinalNote}${duplicateNote}`,
        truncated: result.matchTruncated,
        // Whole text by contract — same discipline as read_action.
        unclipped: true,
        output: result,
      };
    },
    read_workflow: async (args) => {
      const hasIndex = args.index !== undefined && args.index !== null;
      const rawIndex = Number(args.index);
      if (hasIndex && !Number.isFinite(rawIndex)) {
        return {
          ok: false,
          summary: `index 必须是数字（收到「${clip(String(args.index), echoCap)}」）`,
        };
      }
      const result = readOntologyWorkflow(ontology, {
        ...(hasIndex ? { index: rawIndex } : {}),
        cap: workflowListCap,
        fieldCap: idListCap,
      });
      if (!result.found) {
        return {
          ok: false,
          summary: `工作流条目序号 ${result.outOfRange?.requested ?? rawIndex} 超出范围：本体共 ${result.total} 条工作流条目（序号从 0 开始）`,
        };
      }
      if (result.item) {
        return {
          ok: true,
          summary: `工作流第 ${result.item.index} 条完整内容（共 ${result.total} 条）`,
          unclipped: true,
          output: result,
        };
      }
      return {
        ok: true,
        summary: `工作流共 ${result.total} 条，返回 ${result.shown ?? 0} 条${result.truncated ? "（已截断）" : ""}`,
        truncated: result.truncated,
        output: result,
      };
    },
    coverage_gaps: async () => {
      const result = ontologyCoverageGaps(ontology, { idCap: idListCap });
      const parts = result.groups.map(
        (group) =>
          `${ONTOLOGY_GAP_GROUP_LABELS[group.kind] ?? group.kind} ${group.total}${
            group.truncated ? `（仅列出 ${group.ids.length} 个）` : ""
          }`,
      );
      parts.push(
        result.unresolvedLinkEndpoints.linksDeclared
          ? `解析不到实体的关系边端点 ${result.unresolvedLinkEndpoints.total}${
              result.unresolvedLinkEndpoints.truncated
                ? `（仅列出 ${result.unresolvedLinkEndpoints.ids.length} 个）`
                : ""
            }`
          : "关系边集合未声明，端点无从核对",
      );
      // A malformed endpoint is a hole in the export itself, not in the domain
      // — but it is still a hole, and it used to be reported by nobody.
      if (result.unaddressableLinkEndpoints.occurrences > 0) {
        parts.push(
          `没有可寻址 id 的关系边端点 ${result.unaddressableLinkEndpoints.occurrences}（分布在 ${result.unaddressableLinkEndpoints.total} 条边上${
            result.unaddressableLinkEndpoints.truncated
              ? `，仅列出 ${result.unaddressableLinkEndpoints.ids.length} 条`
              : ""
          }）`,
        );
      }
      const truncated =
        result.groups.some((group) => group.truncated) ||
        result.unresolvedLinkEndpoints.truncated ||
        result.unaddressableLinkEndpoints.truncated;
      return {
        ok: true,
        summary: `结构性缺口：${parts.join(" · ")}。这些只是「本体没有声明」的事实，是否算缺陷由你结合业务判断。`,
        truncated,
        output: result,
      };
    },
    compare_actions: async (args) => {
      const first = textValue(args.a);
      const second = textValue(args.b);
      if (!first || !second) {
        return { ok: false, summary: "缺少 a 或 b 参数：两个动作都要给。" };
      }
      const result = compareOntologyActions(ontology, first, second, {
        idCap: idListCap,
        availableCap: nameCap,
      });
      if (!result.found.a || !result.found.b) {
        const missing = [
          result.found.a ? null : first,
          result.found.b ? null : second,
        ].filter((value): value is string => value !== null);
        return {
          ok: false,
          summary: `找不到动作：${missing.map((name) => `「${clip(name, echoCap)}」`).join("、")}；本体共 ${result.available?.total ?? 0} 个动作${
            result.available?.truncated
              ? `（仅列出前 ${result.available.ids.length} 个）`
              : ""
          }`,
          output: result.available,
        };
      }
      const differingLists = result.listFields.filter(
        (field) => field.onlyInA.total > 0 || field.onlyInB.total > 0,
      ).length;
      const differingScalars = result.scalarFields.filter(
        (field) => !field.same,
      ).length;
      const differingCounts = result.countFields.filter(
        (field) => !field.same,
      ).length;
      const differingDeclared = result.declaredFields.filter(
        (field) => !field.same,
      ).length;
      const truncated = result.listFields.some(
        (field) =>
          field.onlyInA.truncated ||
          field.onlyInB.truncated ||
          field.shared.truncated,
      );
      return {
        ok: true,
        summary: `动作「${result.resolved.a}」与「${result.resolved.b}」的声明差异：列字段 ${differingLists} 处 · 取值字段 ${differingScalars} 处 · 数量字段 ${differingCounts} 处 · 字段是否声明 ${differingDeclared} 处${truncated ? "（部分差集列表已截断）" : ""}`,
        truncated,
        output: result,
      };
    },
    table_data: async (args) => {
      const derivation = textValue(args.derivation);
      if (!derivation) return { ok: false, summary: "缺少 derivation 参数" };
      let computed;
      try {
        computed = computeAnalysisTable(ontology, derivation);
      } catch (error) {
        return {
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
        };
      }
      // The read-only dual of present_table: SAME server-computed cells, no
      // frame. Reading a derivation must not require publishing it to the FDE.
      return {
        ok: true,
        summary: `表格推导 ${computed.derivation}：${computed.rows.length}/${computed.total} 行 · ${computed.columns.length} 列${computed.truncated ? "（行已截断）" : ""}（仅返回给你阅读，未推送给用户）`,
        truncated: computed.truncated,
        output: computed,
      };
    },
    chart_data: async (args) => {
      const aggregate = textValue(args.aggregate);
      if (!aggregate) return { ok: false, summary: "缺少 aggregate 参数" };
      try {
        const result = computeAnalysisAggregate(ontology, aggregate);
        return {
          ok: true,
          summary: `聚合 ${result.aggregate}：${result.rows.length}/${result.total} 行${result.truncated ? "（已截断）" : ""}`,
          truncated: result.truncated,
          output: result,
        };
      } catch (error) {
        return {
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
