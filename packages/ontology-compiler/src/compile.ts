/**
 * compile(model, overlay) — the normative ontology→manifest mapping
 * (docs/redesign-ontology-execution-2026-08-19.md §G1, items 1–4).
 *
 *   1. One AgentSpec per ontology Action. trigger = ontology trigger minus
 *      MANUAL, with a synthetic MANUAL_<ACTION_ID> fallback so every agent
 *      stays event-invocable.
 *   2. prompt-kind → one `logic` step (composed action_prompt + agent
 *      ontology_instructions cards + `metaerp.invoke` tool_use entries per
 *      declared query external_call). Overlay emissions compile to
 *      condition/emit/decision steps so events fire only on real hits.
 *      external-kind → rule-gate steps (`rule-gate:<RULE_ID>`) for mandatory
 *      preconditions, manual steps from ontology manual action_steps, then
 *      the `metaerp.invoke` write step (result_key = action id).
 *   3. events/objects/rules/actions files are pass-through projections.
 *   4. Deterministic: stable ordering everywhere, no timestamps added.
 *
 * Rule-gate block semantics note: a violated gate deterministically SKIPS the
 * manual/write/emit steps via `depends_on` gating and a final
 * `suppress-implicit-emit` decision step suppresses the legacy
 * `triggered_event[0]` fallback, so a blocked run performs no ERP write and
 * emits no downstream event. A natural-language rule compiles to a strict
 * JSON-verdict logic judge with `on_error: "terminal"`.
 */

import type {
  CompiledAgent,
  CompiledStep,
  CompiledToolUseEntry,
  CompileResult,
  CompilerOverlay,
  ErpOperation,
  OverlayEmission,
  OverlayExtraTool,
  OverlayToolArgumentSource,
  StudioAction,
  StudioDomainModel,
  StudioEvent,
  StudioRule,
} from "./types.ts";

const TOOL_NAME = "metaerp.invoke";
/** The reviewed policy from packages/tools registry REGISTRATIONS for
 * metaerp.invoke (statement-catalog idiom). Generated agents must declare it
 * and the runtime enforces exact equality with the registry. */
const METAERP_REVIEWED_POLICY = {
  operation: "read_write",
  effect_scope: "external",
  sandbox_policy: "requires_attempt_grant",
} as const;
const BASE_URL_ENV = "METAERP_BASE_URL";

const ONTOLOGY_QUERY_TOOL = "ontology.query";
/** The reviewed policy from packages/tools registry REGISTRATIONS for
 * ontology.query (read-only, tenant-scoped Neo4j graph retrieval). Same
 * byte-equality contract as METAERP_REVIEWED_POLICY: the runtime rejects any
 * generated-agent declaration that differs from the registry catalog. */
const ONTOLOGY_QUERY_REVIEWED_POLICY = {
  operation: "read",
  effect_scope: "external",
  sandbox_policy: "live_external",
} as const;
/** Extra judge-prompt line appended when an overlay grants ontology.query to
 * rule-gate judges (grant_to_judges) — evidence-fetch instruction, keeping
 * the fail-closed floor intact. */
const JUDGE_ONTOLOGY_QUERY_LINE =
  "工具说明：你可调用只读图谱工具 ontology.query 从本体图谱检索核验证据（如 实控人/股权关联 关系）；当事件负载缺少判定所需证据时，必须先查询图谱再裁决；若查询后仍无法取得证据，维持 fail-closed，判 violation。";

function fail(message: string): never {
  throw new Error(`[ontology-compiler] ${message}`);
}

function opIdFromEndpoint(endpoint: string): string {
  const basename = endpoint.split("/").filter(Boolean).pop() ?? "";
  if (!basename) fail(`cannot derive an operation id from endpoint "${endpoint}"`);
  return basename;
}

function syntheticManualTrigger(actionId: string): string {
  return `MANUAL_${actionId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function identifierKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_$-]+/g, "-");
}

// ── ontology_instructions cards ───────────────────────────────────────────────

function buildOntologyInstructions(model: StudioDomainModel, action: StudioAction): string | undefined {
  const objectsById = new Map(model.objects.map((object) => [object.id, object]));
  const rulesById = new Map(model.rules.map((rule) => [rule.id, rule]));

  const objectCards: string[] = [];
  for (const objectId of action.target_objects ?? []) {
    const object = objectsById.get(objectId);
    if (!object) {
      objectCards.push(`- ${objectId}`);
      continue;
    }
    // A computed property has no ERP column behind it, so an agent that treats
    // the list as "fields I can query" will either get nothing back or invent a
    // value — and rule gates are evaluated against exactly these names. Mark
    // them, with their derivation, so the agent knows to compute instead.
    const props = (object.properties ?? [])
      .map((property) => {
        if (property.is_computed !== true) return property.name;
        const expression =
          typeof property.computed_expression === "string" &&
          property.computed_expression.trim()
            ? `＝${property.computed_expression.trim()}`
            : "";
        return `${property.name}（推导${expression}）`;
      })
      .join(", ");
    objectCards.push(`- ${object.name ?? object.id}：决策属性 ${props || "（无声明属性）"}`);
  }

  const ruleCards: string[] = [];
  for (const binding of action.rule_bindings ?? []) {
    const rule = rulesById.get(binding.rule_id);
    const expression = rule?.machine_expression?.source ?? rule?.description ?? "";
    ruleCards.push(
      `- ${binding.rule_id} ${rule?.name ?? ""}（${binding.phase}·${binding.enforcement}）：${expression}`.trim(),
    );
  }

  const sections: string[] = [];
  if (objectCards.length) sections.push(`【目标对象】\n${objectCards.join("\n")}`);
  if (ruleCards.length) sections.push(`【绑定规则】\n${ruleCards.join("\n")}`);
  return sections.length ? sections.join("\n\n") : undefined;
}

// ── prompt composition ────────────────────────────────────────────────────────

function buildPromptOutputContract(
  action: StudioAction,
  eventsByName: Map<string, StudioEvent>,
  overlay: CompilerOverlay,
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const eventName of action.triggered_event) {
    const event = eventsByName.get(eventName);
    for (const field of event?.payload?.event_data ?? []) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      lines.push(`- ${field.name}: ${field.description ?? ""}（事件 ${eventName} 的 payload 段）`);
    }
  }
  const extraFields = overlay.output_contracts?.[action.id]?.fields ?? {};
  for (const [name, description] of Object.entries(extraFields)) {
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`- ${name}: ${description}`);
  }
  return lines.join("\n");
}

function buildAnalysisPrompt(
  action: StudioAction,
  eventsByName: Map<string, StudioEvent>,
  overlay: CompilerOverlay,
): string {
  const steps = (action.action_steps ?? [])
    .filter((step) => step.object_type === "logic")
    .map((step, index) => `${index + 1}. ${step.name}：${step.description ?? ""}`);
  const parts: string[] = [action.description ?? action.name];
  if (steps.length) parts.push(`执行步骤：\n${steps.join("\n")}`);
  const contract = buildPromptOutputContract(action, eventsByName, overlay);
  const contractFields = overlay.output_contracts?.[action.id]?.fields;
  const keyList = contractFields ? Object.keys(contractFields) : [];
  const skeleton = keyList.length
    ? `{\n${keyList.map((key) => `  ${JSON.stringify(key)}: <见字段说明>`).join(",\n")}\n}`
    : "";
  parts.push(
    [
      `输出契约（硬性）：仅输出一个 JSON 对象，不得输出任何其他文本。`,
      keyList.length
        ? `顶层键必须且只能是：${keyList.map((key) => `\`${key}\``).join("、")} —— 不得增删、不得改名、不得另立自创结构（如 decision/result/summary 等一律不允许作为顶层键）。`
        : "",
      keyList.length ? `骨架：\n${skeleton}` : "",
      `字段说明：\n${contract || "- result: 分析结论"}`,
      `下游步骤按上述键名逐字段取数，键名不符将导致整条业务链路中断（fail-closed）。`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return parts.join("\n\n");
}

function buildJudgePrompt(ruleId: string, rule: StudioRule | undefined, judgeContext: string | undefined): string {
  const expression = rule?.machine_expression?.source ?? rule?.description ?? "";
  const parts: string[] = [
    `你是规则闸口「rule-gate:${ruleId}」的审查器，对本次触发事件负载执行强制前置校验。`,
    `规则 ${ruleId} · ${rule?.name ?? ""}\n义务文：${expression}\n背景：${rule?.description ?? ""}`.trim(),
  ];
  if (judgeContext) parts.push(`取数说明：${judgeContext}`);
  parts.push(
    `仅输出一个 JSON 对象（不得输出任何其他文本）：\n` +
      `{"ruleId":"${ruleId}","status":"pass","reason":"<判定依据>"}\n` +
      `或 {"ruleId":"${ruleId}","status":"violation","reason":"<判定依据>"}\n` +
      `status 只能取小写的 pass 或 violation（严格小写，不接受 PASS/Pass 等变体）；证据不足时判 violation（fail-closed）。`,
  );
  return parts.join("\n\n");
}

// ── shared step builders ──────────────────────────────────────────────────────

function genericApproveFormSchema(title: string): Record<string, unknown> {
  return {
    type: "object",
    title,
    properties: {
      decision: { type: "string", enum: ["approve", "reject"], title: "审批决定" },
      comment: { type: "string", title: "审批意见" },
    },
    required: ["decision"],
  };
}

function suppressImplicitEmitStep(order: string): CompiledStep {
  return {
    order,
    name: "suppress-implicit-emit",
    description: "规则拦截或条件未命中时抑制隐式 triggered_event[0] 发射（显式 emit 已记录则本步为空操作）。",
    type: "decision",
    result_key: "suppress-implicit-emit",
    decision_table: {
      id: "suppress-implicit-emit",
      description: "无显式发射记录时写入空 _emits，阻断隐式首事件回退。",
      rows: [
        {
          id: "explicit-emit-recorded",
          all: [{ path: "lastResult._emits", op: "exists" }],
          outcome: "explicit",
        },
      ],
      missing: { outcome: "suppressed", payload: { _emits: [] } },
      default: { outcome: "suppressed", payload: { _emits: [] } },
    },
  };
}

function toolUseEntry(
  operationId: string,
  kind: "query" | "write",
  catalogPath: string,
  description?: string,
): CompiledToolUseEntry {
  return {
    name: TOOL_NAME,
    ...(description ? { description } : {}),
    side_effect: kind === "query" ? "read" : "write",
    // Must equal the reviewed global-registry policy for metaerp.invoke
    // byte-for-byte: generated agents are required to declare it, and the
    // runtime rejects any declaration that differs from the catalog.
    execution_policy: METAERP_REVIEWED_POLICY,
    config: {
      operation: operationId,
      base_url_env: BASE_URL_ENV,
      catalog_path: catalogPath,
    },
  };
}

function mergedQueryToolUseEntry(
  operations: Array<{ id: string; description?: string }>,
  catalogPath: string,
): CompiledToolUseEntry {
  const lines = operations
    .map((op) => (op.description ? `${op.id}（${op.description}）` : op.id))
    .join("、");
  return {
    name: TOOL_NAME,
    description: `实时查询 Meta ERP。可用操作：${lines}。`,
    side_effect: "read",
    execution_policy: METAERP_REVIEWED_POLICY,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: operations.map((op) => op.id),
          description: "要调用的 Meta ERP 查询操作",
        },
        payload: {
          type: "object",
          description: "可选过滤条件：按返回行的列做精确匹配（如 {\"STATUS\":\"dormant\"}）",
        },
      },
    },
    config: { base_url_env: BASE_URL_ENV, catalog_path: catalogPath },
  };
}

// ── overlay extra tools (ontology.query) ──────────────────────────────────────

/** JSON Schema for ontology.query's real arg surface
 * (packages/tools/src/ontology/query.ts). Built fresh per entry so agents
 * never alias one mutable schema object. */
function ontologyQueryInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["search_nodes", "get_node", "neighbors", "find_paths", "schema"],
        description:
          "图谱检索操作：search_nodes 关键词搜索节点 / get_node 取单个节点 / neighbors 查节点邻居与关系 / find_paths 找两节点间路径 / schema 查看图谱结构",
      },
      query: { type: "string", description: "search_nodes 必填：检索关键词" },
      id: { type: "string", description: "get_node、neighbors 必填：节点 id" },
      start_id: { type: "string", description: "find_paths 必填：起点节点 id" },
      end_id: { type: "string", description: "find_paths 必填：终点节点 id" },
      max_depth: {
        type: "number",
        description: "find_paths 可选：最大路径深度（1-4，默认 3）",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "search_nodes 可选：限定节点标签",
      },
      properties: {
        type: "array",
        items: { type: "string" },
        description: "search_nodes 可选：限定检索的属性名",
      },
      // neighbors filters on its own two arguments. Omitting them while the
      // schema is closed (additionalProperties:false) left the model no way to
      // narrow a neighbour scan at all: it would pass `labels`, which the
      // neighbors branch never reads, get every edge back, and retry.
      relationship_types: {
        type: "array",
        items: { type: "string" },
        description:
          "neighbors 可选：只返回这些关系类型（如 CONTROLLED_BY、EQUIVALENT_TO）",
      },
      neighbor_labels: {
        type: "array",
        items: { type: "string" },
        description:
          "neighbors 可选：只返回这些标签的邻居节点（如 UltimateController）",
      },
      limit: { type: "number", description: "可选：返回条数上限（1-100，默认 20）" },
    },
  };
}

function ontologyQueryToolUseEntry(grant: OverlayExtraTool): CompiledToolUseEntry {
  return {
    name: ONTOLOGY_QUERY_TOOL,
    description:
      grant.description ??
      "只读查询租户本体图谱（Neo4j）：检索节点、读取单节点、查看邻居关系、寻找两节点间路径或查看图谱结构。",
    side_effect: "read",
    // Must equal the reviewed global-registry policy for ontology.query
    // byte-for-byte (same contract as metaerp.invoke above).
    execution_policy: ONTOLOGY_QUERY_REVIEWED_POLICY,
    input_schema: ontologyQueryInputSchema(),
    // Config is narrowed to keys the tool treats as agent-supplied hints. The
    // tool server-validates tenant_property / id_property / database and pins
    // base_url, but it reads the Neo4j credentials from whatever env names
    // `username_env` / `password_env` name — so an overlay that could set those
    // would choose which server secret is sent as a Basic-auth password. An
    // overlay is tenant-authored config, not operator config: it may not pick
    // credential sources or endpoints.
    config: narrowOverlayToolConfig(grant.config),
  };
}

/** Keys an overlay may set on a granted tool's config. Everything else —
 * notably `base_url`, `username_env`, `password_env` — is operator-owned and
 * comes from the server environment. */
const OVERLAY_TOOL_CONFIG_KEYS = new Set([
  "tenant_property",
  "id_property",
  "database",
  "search_properties",
  "timeout_ms",
  "max_execution_time_ms",
]);

function narrowOverlayToolConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const source = config ?? {};
  const rejected = Object.keys(source)
    .filter((key) => !OVERLAY_TOOL_CONFIG_KEYS.has(key))
    .sort();
  if (rejected.length > 0) {
    throw new Error(
      `overlay extra_tools config may not set operator-owned key(s) ${rejected.join(", ")}; allowed: ${[...OVERLAY_TOOL_CONFIG_KEYS].sort().join(", ")}`,
    );
  }
  // Rebuilt in a stable key order so the compiled output stays byte-stable
  // regardless of how the overlay JSON happened to order its keys.
  const narrowed: Record<string, unknown> = {};
  for (const key of [...OVERLAY_TOOL_CONFIG_KEYS].sort()) {
    if (Object.hasOwn(source, key)) narrowed[key] = source[key];
  }
  return narrowed;
}

/** Apply overlay `extra_tools` grants to a compiled agent in place: append
 * the tool_use entry (after metaerp.invoke if present), grant the analyze
 * logic step, and — with grant_to_judges — every `rule-gate:*` LLM judge,
 * whose prompt gains the graph-evidence instruction line. Only tool names
 * with a compiler-known reviewed policy are accepted, so an overlay can
 * never ship an unreviewed execution_policy. */
function applyExtraTools(
  ctx: CompileContext,
  action: StudioAction,
  compiled: { steps: CompiledStep[]; toolUse: CompiledToolUseEntry[] },
): void {
  const grants = ctx.overlay.extra_tools?.[action.id] ?? [];
  for (const grant of grants) {
    if (grant.name !== ONTOLOGY_QUERY_TOOL) {
      fail(
        `overlay extra_tools for ${action.id} grants unsupported tool "${grant.name}" — only ${ONTOLOGY_QUERY_TOOL} has a compiler-known reviewed execution policy`,
      );
    }
    if (compiled.toolUse.some((entry) => entry.name === grant.name)) {
      fail(`overlay extra_tools for ${action.id} grants ${grant.name} more than once`);
    }
    // One entry per tool NAME per agent: the runtime lifts config by name
    // (first match wins) and providers reject duplicate tool names.
    compiled.toolUse.push(ontologyQueryToolUseEntry(grant));
    for (const step of compiled.steps) {
      if (step.type !== "logic") continue;
      const isJudge = step.name.startsWith("rule-gate:");
      if (isJudge && grant.grant_to_judges !== true) continue;
      const allowed = step.allowed_tools ?? (step.allowed_tools = []);
      if (!allowed.includes(grant.name)) allowed.push(grant.name);
      if (isJudge && step.action_prompt) {
        step.action_prompt = `${step.action_prompt}\n\n${JUDGE_ONTOLOGY_QUERY_LINE}`;
      }
    }
  }
}

// ── per-kind compilation ──────────────────────────────────────────────────────

interface CompileContext {
  model: StudioDomainModel;
  overlay: CompilerOverlay;
  eventsByName: Map<string, StudioEvent>;
  rulesById: Map<string, StudioRule>;
  catalogPath: string;
}

function overlayEmissionsFor(ctx: CompileContext, action: StudioAction): OverlayEmission[] {
  const emissions = ctx.overlay.emissions?.[action.id] ?? [];
  for (const emission of emissions) {
    if (!action.triggered_event.includes(emission.event)) {
      fail(
        `overlay emission for ${action.id} references event ${emission.event} not in its triggered_event`,
      );
    }
    if (!emission.when || typeof emission.when !== "string") {
      fail(`overlay emission for ${action.id}/${emission.event} requires a "when" expression or "always"`);
    }
  }
  return emissions;
}

/** Append overlay-driven emission steps. Returns true when at least one emit
 * is conditional (which requires the implicit-emit suppression floor). */
function appendEmissionSteps(
  steps: CompiledStep[],
  emissions: OverlayEmission[],
  actionId: string,
  nextOrder: () => string,
  /** Steps every emission must wait on — the ERP write for an external agent,
   * so a failed/skipped write emits nothing. Empty for prompt agents, whose
   * analyze step is already the immediately preceding step. */
  dependsOn: readonly string[] = [],
): boolean {
  const guard = dependsOn.length ? { depends_on: [...dependsOn] } : {};
  let conditional = false;
  for (const emission of emissions) {
    const payloadFrom = emission.payload_from ?? `results.${actionId}`;
    if (emission.when === "always") {
      steps.push({
        order: nextOrder(),
        name: `emit:${emission.event}`,
        description: `发射事件 ${emission.event}（无条件）。`,
        type: "emit",
        emit_event: emission.event,
        emit_payload_from: payloadFrom,
        result_key: identifierKey(`emit-${emission.event}`),
        ...guard,
      });
      continue;
    }
    conditional = true;
    const conditionKey = identifierKey(`emit-when-${emission.event}`);
    steps.push({
      order: nextOrder(),
      name: `emit-when:${emission.event}`,
      description: `事件 ${emission.event} 的发射条件。`,
      type: "condition",
      condition: emission.when,
      result_key: conditionKey,
      ...guard,
    });
    steps.push({
      order: nextOrder(),
      name: `emit:${emission.event}`,
      description: `条件命中时发射事件 ${emission.event}。`,
      type: "emit",
      emit_event: emission.event,
      emit_payload_from: payloadFrom,
      result_key: identifierKey(`emit-${emission.event}`),
      depends_on: [...dependsOn, conditionKey],
    });
  }
  return conditional;
}

function compilePromptAgent(ctx: CompileContext, action: StudioAction): {
  steps: CompiledStep[];
  toolUse: CompiledToolUseEntry[];
} {
  let ord = 0;
  const nextOrder = (): string => String(++ord);

  const queryCalls = (action.side_effects?.external_calls ?? []).filter((call) =>
    opIdFromEndpoint(call.endpoint).startsWith("query"),
  );
  // The runtime lifts tool config by NAME (agent.tool_use.find — first match
  // wins) and providers reject duplicate tool names in a roster, so an agent
  // carries at most ONE metaerp.invoke entry. A single query op keeps the
  // config pin; multiple ops merge into one unpinned entry whose input_schema
  // enum constrains which operations the model may call.
  const seenOps = new Set<string>();
  const queryOps: Array<{ id: string; description?: string }> = [];
  for (const call of queryCalls) {
    const operationId = opIdFromEndpoint(call.endpoint);
    if (seenOps.has(operationId)) continue;
    seenOps.add(operationId);
    queryOps.push({ id: operationId, description: call.description });
  }
  const toolUse: CompiledToolUseEntry[] =
    queryOps.length === 0
      ? []
      : queryOps.length === 1
        ? [toolUseEntry(queryOps[0]!.id, "query", ctx.catalogPath, queryOps[0]!.description)]
        : [mergedQueryToolUseEntry(queryOps, ctx.catalogPath)];

  const steps: CompiledStep[] = [
    {
      order: nextOrder(),
      name: "analyze",
      description: action.description ?? action.name,
      type: "logic",
      action_prompt: buildAnalysisPrompt(action, ctx.eventsByName, ctx.overlay),
      allowed_tools: toolUse.length ? [TOOL_NAME] : [],
      result_key: action.id,
    },
  ];

  const emissions = overlayEmissionsFor(ctx, action);
  const conditional = appendEmissionSteps(steps, emissions, action.id, nextOrder);
  if (conditional) steps.push(suppressImplicitEmitStep(nextOrder()));
  return { steps, toolUse };
}

function firstHumanRoleForAction(model: StudioDomainModel, actionId: string): string | undefined {
  for (const workflow of model.workflows) {
    const containsAction = (workflow.actions ?? []).some((step) => step.name === actionId);
    if (!containsAction) continue;
    const humanRole = (workflow.roles ?? []).find((role) => role.type === "Human" && role.role);
    if (humanRole?.role) return humanRole.role;
  }
  return undefined;
}

function normalizeToolArguments(
  actionId: string,
  template: Record<string, OverlayToolArgumentSource> | undefined,
): Record<string, OverlayToolArgumentSource> {
  const source = template ?? { payload: { from: "event.data" } };
  const entries = Object.entries(source);
  if (!entries.length) fail(`overlay tool_arguments for ${actionId} must not be empty`);
  const out: Record<string, OverlayToolArgumentSource> = {};
  for (const [argument, spec] of entries) {
    if (!spec || typeof spec !== "object") {
      fail(`overlay tool argument ${actionId}.${argument} must be {from} or {const}`);
    }
    const hasFrom = Object.prototype.hasOwnProperty.call(spec, "from");
    const hasConst = Object.prototype.hasOwnProperty.call(spec, "const");
    if (hasFrom === hasConst) {
      fail(`overlay tool argument ${actionId}.${argument} must choose exactly one of from/const`);
    }
    out[argument] = spec;
  }
  return out;
}

/** The overlay-declared compensation event for an action, validated against its
 * own `triggered_event` so a typo cannot silently disable the saga. */
function compensationEventFor(
  ctx: CompileContext,
  action: StudioAction,
): string | undefined {
  const event = ctx.overlay.compensation_events?.[action.id];
  if (!event) return undefined;
  if (!action.triggered_event.includes(event)) {
    fail(
      `overlay compensation_events for ${action.id} names ${event}, which is not in its triggered_event`,
    );
  }
  return event;
}

/** `triggered_event` minus the compensation event — the events a SUCCESSFUL run emits. */
function successEvents(ctx: CompileContext, action: StudioAction): string[] {
  const compensation = compensationEventFor(ctx, action);
  return compensation
    ? action.triggered_event.filter((event) => event !== compensation)
    : [...action.triggered_event];
}

function compileExternalAgent(ctx: CompileContext, action: StudioAction): {
  steps: CompiledStep[];
  toolUse: CompiledToolUseEntry[];
} {
  let ord = 0;
  const nextOrder = (): string => String(++ord);
  const steps: CompiledStep[] = [];
  const gateKeys: string[] = [];

  // (a) rule gates: mandatory precondition bindings, in binding order.
  const gateBindings = (action.rule_bindings ?? []).filter(
    (binding) => binding.phase === "precondition" && binding.enforcement === "mandatory",
  );
  for (const binding of gateBindings) {
    const ruleId = binding.rule_id;
    const rule = ctx.rulesById.get(ruleId);
    if (!rule) fail(`action ${action.id} binds unknown rule ${ruleId}`);
    const gateOverlay = ctx.overlay.rule_gates?.[ruleId];
    const deterministic = gateOverlay?.strategy === "condition" && !!gateOverlay.condition;
    if (deterministic) {
      const gateKey = identifierKey(`rule-gate-${ruleId}`);
      steps.push({
        order: nextOrder(),
        name: `rule-gate:${ruleId}`,
        description: `规则闸口（确定性判定）：${rule.name ?? ruleId}。判假即拦截后续人工/写入/发射步骤。`,
        type: "condition",
        condition: gateOverlay!.condition!,
        result_key: gateKey,
        ...(gateKeys.length ? { depends_on: [...gateKeys] } : {}),
      });
      gateKeys.push(gateKey);
    } else {
      const judgeKey = identifierKey(`rule-gate-${ruleId}`);
      const verdictKey = identifierKey(`rule-verdict-${ruleId}`);
      steps.push({
        order: nextOrder(),
        name: `rule-gate:${ruleId}`,
        description: `规则闸口（LLM 裁决）：${rule.name ?? ruleId}。输出严格 JSON 裁决 {ruleId,status,reason}。`,
        type: "logic",
        action_prompt: buildJudgePrompt(ruleId, rule, gateOverlay?.judge_context),
        allowed_tools: [],
        on_error: "terminal",
        result_key: judgeKey,
        ...(gateKeys.length ? { depends_on: [...gateKeys] } : {}),
      });
      steps.push({
        order: nextOrder(),
        name: `rule-verdict:${ruleId}`,
        description: `裁决闸口：仅当 ${ruleId} 判定 pass 时放行后续步骤。`,
        type: "condition",
        condition: `results.${judgeKey}.status == 'pass' || results.${judgeKey}.status == 'PASS'`,
        result_key: verdictKey,
        depends_on: [judgeKey],
      });
      gateKeys.push(verdictKey);
    }
  }

  // (b) manual steps from ontology action_steps (object_type === "manual").
  const manualKeys: string[] = [];
  for (const manualStep of (action.action_steps ?? []).filter((step) => step.object_type === "manual")) {
    const overlayManual = ctx.overlay.manual_steps?.[action.id]?.[manualStep.name];
    const manualKey = identifierKey(`manual-${manualStep.order}`);
    steps.push({
      order: nextOrder(),
      name: manualStep.name,
      description: manualStep.description ?? manualStep.name,
      type: "manual",
      // `task_type` is what makes the manual contract complete for the
      // authoring lint (rule 7: a Human-actor agent needs task_type +
      // awaiting_role + form_schema, or a taskDefinition tool). Emitting the
      // step name matches register.ts's own `action.task_type ?? action.name`
      // fallback, so the runtime task is byte-identical either way.
      task_type: overlayManual?.task_type ?? manualStep.name,
      form_schema: overlayManual?.form_schema ?? genericApproveFormSchema(manualStep.name),
      awaiting_role:
        overlayManual?.awaiting_role ?? firstHumanRoleForAction(ctx.model, action.id) ?? "Human",
      result_key: manualKey,
      ...(gateKeys.length || manualKeys.length
        ? { depends_on: [...gateKeys, ...manualKeys] }
        : {}),
    });
    manualKeys.push(manualKey);
  }

  // (c) the ERP write via metaerp.invoke; (d) result_key = action id slug.
  const operationId =
    action.implementation.operation_id ??
    (action.implementation.endpoint ? opIdFromEndpoint(action.implementation.endpoint) : undefined);
  if (!operationId) fail(`external action ${action.id} declares no operation_id/endpoint`);
  const guards = [...gateKeys, ...manualKeys];
  steps.push({
    order: nextOrder(),
    name: TOOL_NAME,
    description: `写回 Meta ERP：${operationId}。`,
    type: "tool",
    tool_arguments: normalizeToolArguments(action.id, ctx.overlay.tool_arguments?.[action.id]),
    allowed_tools: [TOOL_NAME],
    result_key: action.id,
    ...(guards.length ? { depends_on: guards } : {}),
  });

  // An overlay emission block wins: it is the only way to express a real
  // branch out of an external action (the canonical case is a human gate whose
  // form carries approve/reject, where `triggered_event[0]` alone would emit
  // APPROVED on a rejection). Emissions are gated on the write step, so a
  // blocked gate or a failed write still emits nothing.
  const overlayEmissions = overlayEmissionsFor(ctx, action);
  if (overlayEmissions.length) {
    const conditional = appendEmissionSteps(
      steps,
      overlayEmissions,
      action.id,
      nextOrder,
      [action.id],
    );
    if (conditional || gateKeys.length) steps.push(suppressImplicitEmitStep(nextOrder()));
  } else if (gateKeys.length) {
    // With gates in play the success event must be explicit and the implicit
    // triggered_event[0] fallback suppressed, so a blocked run emits nothing.
    // A compensation event is NOT a success event — it is emitted by the
    // runtime on hard failure, never as an unconditional emit step here.
    for (const eventName of successEvents(ctx, action)) {
      steps.push({
        order: nextOrder(),
        name: `emit:${eventName}`,
        description: `写入成功后发射事件 ${eventName}。`,
        type: "emit",
        emit_event: eventName,
        emit_payload_from: "lastResult",
        result_key: identifierKey(`emit-${eventName}`),
        depends_on: [action.id],
      });
    }
    steps.push(suppressImplicitEmitStep(nextOrder()));
  }

  const writeDescription = (action.side_effects?.external_calls ?? []).find(
    (call) => opIdFromEndpoint(call.endpoint) === operationId,
  )?.description;
  const toolUse = [toolUseEntry(operationId, "write", ctx.catalogPath, writeDescription)];
  return { steps, toolUse };
}

// ── erp-operations catalog ────────────────────────────────────────────────────

function buildErpOperations(model: StudioDomainModel): ErpOperation[] {
  const byId = new Map<string, ErpOperation>();
  const erpEntityByObject = new Map<string, string | null>(
    model.transformMaps.object_maps.map((objectMap) => [
      objectMap.object_id,
      objectMap.erp_entity ?? null,
    ]),
  );
  const add = (operation: ErpOperation): void => {
    const existing = byId.get(operation.operation_id);
    if (existing) {
      if (existing.path !== operation.path || existing.kind !== operation.kind) {
        fail(`conflicting definitions for ERP operation ${operation.operation_id}`);
      }
      return;
    }
    byId.set(operation.operation_id, operation);
  };
  for (const objectMap of model.transformMaps.object_maps) {
    const fetchPath = objectMap.fetch?.path;
    if (!fetchPath) continue;
    add({
      operation_id: opIdFromEndpoint(fetchPath),
      method: objectMap.fetch?.method ?? "POST",
      path: fetchPath,
      kind: "query",
      entity: objectMap.erp_entity ?? null,
    });
  }
  for (const actionMap of model.transformMaps.action_maps) {
    if (actionMap.kind !== "external") continue;
    const endpoint = actionMap.endpoint;
    if (!endpoint) fail(`action_map ${actionMap.action_id} (external) has no endpoint`);
    const target = actionMap.data_changes?.[0]?.target_object;
    add({
      operation_id: actionMap.operation_id ?? opIdFromEndpoint(endpoint),
      method: actionMap.method ?? "POST",
      path: endpoint,
      kind: "write",
      entity: target ? (erpEntityByObject.get(target) ?? null) : null,
    });
  }
  return [...byId.values()].sort((a, b) => a.operation_id.localeCompare(b.operation_id, "en"));
}

// ── entry point ───────────────────────────────────────────────────────────────

export interface CompileOptions {
  tenant: string;
}

export function compile(
  model: StudioDomainModel,
  overlay: CompilerOverlay = {},
  options: CompileOptions,
): CompileResult {
  const tenant = options.tenant;
  if (!tenant || !/^[a-z0-9][a-z0-9-]*$/.test(tenant)) {
    fail(`tenant must be a lowercase slug, got "${tenant}"`);
  }
  const catalogPath = `models/${tenant}-v1/erp-operations.json`;
  const ctx: CompileContext = {
    model,
    overlay,
    eventsByName: new Map(model.events.map((event) => [event.name, event])),
    rulesById: new Map(model.rules.map((rule) => [rule.id, rule])),
    catalogPath,
  };

  for (const actionId of Object.keys(overlay.emissions ?? {})) {
    if (!model.actions.some((action) => action.id === actionId)) {
      fail(`overlay emissions references unknown action ${actionId}`);
    }
  }
  for (const actionId of Object.keys(overlay.extra_tools ?? {})) {
    if (!model.actions.some((action) => action.id === actionId)) {
      fail(`overlay extra_tools references unknown action ${actionId}`);
    }
  }
  for (const actionId of Object.keys(overlay.compensation_events ?? {})) {
    if (!model.actions.some((action) => action.id === actionId)) {
      fail(`overlay compensation_events references unknown action ${actionId}`);
    }
  }

  const workflow: CompiledAgent[] = model.actions.map((action) => {
    const kind = action.implementation.kind;
    const compiled =
      kind === "prompt"
        ? compilePromptAgent(ctx, action)
        : kind === "external"
          ? compileExternalAgent(ctx, action)
          : fail(`action ${action.id} has unsupported implementation.kind "${kind}"`);
    applyExtraTools(ctx, action, compiled);

    const trigger = action.trigger.filter((event) => event !== "MANUAL");
    if (!trigger.length) trigger.push(syntheticManualTrigger(action.id));

    const ontologyInstructions = buildOntologyInstructions(model, action);
    // `triggered_event` drives register.ts's implicit emit fallback, so it must
    // list only what a SUCCESSFUL run emits; the failure event moves to
    // `compensation_event`, which the runtime emits once on a hard failure.
    const compensationEvent = compensationEventFor(ctx, action);
    return {
      id: action.id,
      name: action.id,
      title: action.name,
      description: action.description ?? "",
      actor: action.actor,
      trigger,
      triggered_event: successEvents(ctx, action),
      retries: 3,
      generated: true,
      ...(compensationEvent ? { compensation_event: compensationEvent } : {}),
      ...(ontologyInstructions ? { ontology_instructions: ontologyInstructions } : {}),
      tool_use: compiled.toolUse,
      actions: compiled.steps,
    };
  });

  return {
    workflow,
    actions: model.raw.actions,
    events: model.raw.events,
    objects: model.raw.objects,
    rules: model.raw.rules,
    erpOperations: buildErpOperations(model),
  };
}

/** Five-file AO layout + the erp-operations catalog, keyed by file name. */
export function serializeCompileResult(result: CompileResult): Map<string, unknown> {
  return new Map<string, unknown>([
    ["workflow_v1.json", result.workflow],
    ["actions_v1.json", result.actions],
    ["events_v1.json", result.events],
    ["objects_v1.json", result.objects],
    ["rules_v1.json", result.rules],
    ["erp-operations.json", result.erpOperations],
  ]);
}
