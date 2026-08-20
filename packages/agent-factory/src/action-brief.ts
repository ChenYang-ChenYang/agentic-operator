// #ACTION-BRIEF (P0-1) — deterministic context provisioning for fleet members and reviewers.
//
// Problem: every design_fleet / review member is a FULL runBrain sub-brain that re-reads the whole
// ontology to understand ONE action — the dominant token cost of a fleet (a 3-member live run burned
// ~420k tokens, mostly duplicated ontology reads). The member only needs its action's SLICE.
//
// This module packs that slice — the action's contract, its trigger/emit events WITH payload fields,
// the objects it touches, the rules pinned to it, candidate real tools with credential posture, its
// readiness gaps and execution-plan requirement — into ONE compact, deterministic brief (pure function,
// zero LLM, capped). Members receive the brief inline and only reach for read-only tools when something
// is genuinely missing, instead of re-reading the world.

import type { DomainOntology, OntologyEvent, OntologyObject } from "./ontology-types";
import type { OntologyReadinessIssue } from "./ontology-readiness";
import { blockingIssuesForAction } from "./ontology-normalize";
import { rankRealTools, type RealTool } from "./tool-catalog";
import {
  canonicalRegisteredToolName,
  resolveBoundedExecutionToolProjection,
} from "./execution-tool-projection";

export interface ActionBriefInput {
  ontology: DomainOntology;
  actionName: string;
  /** rules already resolved for this action (ctx.rulesByAction[action]) — optional. */
  rules?: Array<{ id: string; name: string; summary: string }>;
  /** the real tool registry (ctx.realTools) for candidate ranking + credential posture — optional. */
  realTools?: RealTool[];
  /** current blocking readiness issues (ctx.ontologyReadiness.blocking) — optional. */
  blocking?: OntologyReadinessIssue[];
  /** hard cap on the rendered brief (chars). Default 6000. */
  maxChars?: number;
}

const refKey = (v: string): string => (v ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, "");
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function eventLine(ev: OntologyEvent): string {
  const fields = (ev.payload?.event_data ?? [])
    .map((f) => `${f.name}:${f.type}${f.required === false ? "?" : ""}`)
    .join(", ");
  return `· ${ev.name} — {${fields || "无字段"}}${ev.description ? ` （${clip(ev.description, 60)}）` : ""}`;
}

function objectLine(obj: OntologyObject): string {
  const props = (obj.properties ?? []).map((p) => `${p.name}:${p.type ?? "?"}`).join(", ");
  return `· ${obj.id}（主键 ${obj.primary_key ?? "未声明"}）: {${clip(props, 240)}}`;
}

/** Everything a member needs to design/review ONE action — deterministic, compact, honest about gaps. */
export function buildActionBrief(input: ActionBriefInput): string {
  const { ontology, actionName } = input;
  const maxChars = input.maxChars ?? 9000;
  const action = (ontology.actions ?? []).find((a) => a.name === actionName || a.id === actionName);
  if (!action) return `【动作简报】未找到动作「${actionName}」——名字必须来自本体 agentActions。`;

  const eventsByKey = new Map((ontology.events ?? []).map((e) => [refKey(e.name), e] as const));
  const triggers = (action.trigger ?? []).map((n) => eventsByKey.get(refKey(n))).filter((e): e is OntologyEvent => !!e);
  const emits = (action.triggered_event ?? []).map((n) => eventsByKey.get(refKey(n))).filter((e): e is OntologyEvent => !!e);
  const objects = (action.target_objects ?? [])
    .map((ref) => (ontology.objects ?? []).find((o) => refKey(o.id) === refKey(ref) || refKey(o.name) === refKey(ref)))
    .filter((o): o is OntologyObject => !!o);

  const inputs = (action.inputs ?? []).map((i) => {
    const row = i as Record<string, unknown>;
    const bind = row.binding_kind ? ` [${String(row.binding_kind)}${row.event_field ? `:${String(row.event_field)}` : ""}]` : " [未声明绑定]";
    return `· ${String(row.name)}:${String(row.type ?? "?")}${row.required === true ? " 必填" : ""}${bind}`;
  });
  const outputs = (action.outputs ?? []).map((o) => {
    const row = o as Record<string, unknown>;
    return `· ${String(row.name)}:${String(row.type ?? "?")}`;
  });

  const steps = (action.action_steps ?? []).map((s) => {
    const row = s as Record<string, unknown>;
    const stepId = String(row.step_id ?? row.id ?? row.name ?? "?");
    const kind = String(row.object_type ?? row.type ?? "?");
    const dispatch = row.tool
      ? ` tool=${String(row.tool)}`
      : row.invoke
        ? ` invoke=${String(row.invoke)}`
        : (row.emit_event ?? row.event)
          ? ` emit=${String(row.emit_event ?? row.event)}`
          : "";
    const toolArguments = row.tool_arguments ?? row.toolArguments;
    const argumentSummary = toolArguments && typeof toolArguments === "object" && !Array.isArray(toolArguments)
      ? ` args=${clip(JSON.stringify(toolArguments), 260)}`
      : "";
    const resultMap = row.result_map ?? row.resultMap;
    const resultSummary = resultMap && typeof resultMap === "object" && !Array.isArray(resultMap)
      ? ` result=${clip(JSON.stringify(resultMap), 180)}`
      : "";
    const rawDependencies = row.depends_on ?? row.dependsOn;
    const dependencies = Array.isArray(rawDependencies)
      ? ` depends=${rawDependencies.map(String).join(",")}`
      : "";
    const parent = typeof (row.parent_step ?? row.parentStep) === "string"
      ? ` parent=${String(row.parent_step ?? row.parentStep)}`
      : "";
    const foreach = kind === "foreach"
      ? ` items=${String(row.items_from ?? row.itemsFrom ?? "?")} as=${String(row.item_as ?? row.itemAs ?? "item")} key=${String(row.item_key_from ?? row.itemKeyFrom ?? "?")}`
      : "";
    const payloadFrom = typeof (row.emit_payload_from ?? row.emitPayloadFrom) === "string"
      ? ` payload=${String(row.emit_payload_from ?? row.emitPayloadFrom)}`
      : "";
    const idempotency = typeof (row.idempotency_key_from ?? row.idempotencyKeyFrom) === "string"
      ? ` idem=${String(row.idempotency_key_from ?? row.idempotencyKeyFrom)}`
      : "";
    const factOperation = typeof row.fact_operation === "string"
      ? ` operation=${row.fact_operation}`
      : "";
    const argumentContract = row.argument_contract && typeof row.argument_contract === "object" && !Array.isArray(row.argument_contract)
      ? ` argumentContract=${clip(JSON.stringify(row.argument_contract), 200)}`
      : "";
    const config = row.config && typeof row.config === "object" && !Array.isArray(row.config)
      ? ` config=${clip(JSON.stringify(row.config), 160)}`
      : "";
    const condition = typeof row.condition === "string" && row.condition.trim()
      ? ` if=${clip(row.condition.trim(), 100)}`
      : "";
    const description = typeof row.description === "string" && row.description.trim()
      ? ` — ${clip(row.description.trim(), 220)}`
      : "";
    return `· ${stepId}(${kind})${dispatch}${factOperation}${foreach}${parent}${dependencies}${payloadFrom}${idempotency}${config}${argumentSummary}${resultSummary}${argumentContract}${condition}${description}`;
  });
  const integrationSystems = ((action.integration as Record<string, unknown> | undefined)?.systems as Array<Record<string, unknown>> | undefined) ?? [];
  const integrations = integrationSystems.map((s) => `· ${String(s.name ?? "?")}（${String(s.kind ?? "?")}/${String(s.role ?? "?")}${s.capability ? ` · ${clip(String(s.capability), 50)}` : ""}）`);

  const stepDeclaredTools = (action.action_steps ?? []).flatMap((step) => {
    const name = typeof step.tool === "string" ? step.tool.trim() : "";
    return name ? [name] : [];
  });
  const integrationDeclaredTools = integrationSystems.flatMap((system) => {
    const name = String(
      system.via_tool ?? system.viaTool ?? system.tool ?? "",
    ).trim();
    return name ? [name] : [];
  });
  const declaredTools = [
    ...new Set([
      ...(action.tool_use ?? []).map(String).map((value) => value.trim()).filter(Boolean),
      ...stepDeclaredTools,
      ...integrationDeclaredTools,
    ]),
  ];
  const ranked = input.realTools?.length ? rankRealTools(action, input.realTools, 4) : [];
  const boundedProjection = input.realTools?.length
    ? resolveBoundedExecutionToolProjection({
        action,
        registry: input.realTools,
      })
    : undefined;
  const bindingLines = boundedProjection?.finalBinding.bindings.map((binding) => {
    const executionSurface =
      binding.toolName ??
      (binding.bindingKind === "tool" ? binding.bindingId : undefined);
    const candidates = binding.selectionCandidates
      ?.map((candidate) => candidate.toolName ?? candidate.bindingId)
      .filter((value): value is string => Boolean(value));
    const selected = executionSurface
      ? `=> ${executionSurface} [${binding.status}]`
      : binding.selectionRequired && candidates?.length
        ? `=> 待唯一选择（${candidates.join(" / ")}）`
        : `=> 未解析 [${binding.status}]`;
    return `· ${binding.requirement.id} ${binding.requirement.system}/${binding.requirement.kind}/${binding.requirement.role} ${selected}`;
  }) ?? [];
  const declaredCanonical = declaredTools.map((declared) => {
    const registered = canonicalRegisteredToolName(
      declared,
      input.realTools ?? [],
    );
    const projected = boundedProjection?.projection.get(declared);
    if (registered) {
      return `· ${declared} → ${registered} [${registered === declared ? "registered canonical" : "registry alias"}]`;
    }
    if (projected) {
      return `· ${declared} → ${projected} [final bounded integration projection]`;
    }
    return `· BLOCKER ${declared} → 不可投影（source-only；不能拿语义相近/排名候选替换）`;
  });
  const canonicalExecutionTools = new Set(
    declaredTools.flatMap((declared) => {
      const canonical =
        canonicalRegisteredToolName(declared, input.realTools ?? []) ??
        boundedProjection?.projection.get(declared);
      return canonical ? [canonical] : [];
    }),
  );
  const toolLines = [
    declaredTools.length
      ? `本体源声明工具 source declarations（action_steps / integration / tool_use；不是 available_tools）: ${declaredTools.join("、")}`
      : "本体未声明工具 source symbol",
    ...(declaredCanonical.length
      ? ["逐符号 final/bounded projection（每个 source 独立判定）:", ...declaredCanonical]
      : []),
    ...(bindingLines.length
      ? [
          "结构化 integration 的 authoring 执行面（final bounded；不能覆盖上面已注册的精确 source 工具；needs_config / needs_probe 只阻断 sandbox/晋升）:",
          ...bindingLines,
        ]
      : []),
    ...ranked.filter((n) => !canonicalExecutionTools.has(n)).map((n) => {
      const rt = input.realTools!.find((t) => t.name === n);
      const cred = rt?.credentialEnv?.length ? `（需凭证 ${rt.credentialEnv.join("/")}）` : "";
      return `补充候选真实工具（只可补充；不得替换 registered canonical 或不可投影 blocker）: ${n}${rt?.summary ? ` — ${clip(rt.summary, 60)}` : ""}${cred}`;
    }),
  ];

  const myBlocking = input.blocking?.length ? blockingIssuesForAction(input.blocking, action) : [];
  const rules = input.rules ?? [];

  const sections = [
    `【动作简报 · ${action.name}】${action.description ? clip(action.description, 200) : ""}`,
    `— 触发事件（含 payload 契约）—\n${triggers.map(eventLine).join("\n") || "（无——入口需人工确认）"}`,
    `— 产出事件（emit 目标；输出字段必须映射到这些事件的字段）—\n${emits.map(eventLine).join("\n") || "（无）"}`,
    `— 输入（含绑定）—\n${inputs.join("\n") || "（无）"}`,
    `— 输出 —\n${outputs.join("\n") || "（无）"}`,
    steps.length ? `— 本体声明的 action_steps（plan 必须覆盖这些稳定 stepId）—\n${steps.join("\n")}` : "— 无 action_steps：简单动作可整体省略 plan —",
    `— 工具 —\n${toolLines.join("\n")}`,
    integrations.length ? `— 外部集成声明 —\n${integrations.join("\n")}` : "",
    rules.length ? `— 挂在此动作的规则（运行时动态抓取，绝不写死进 prompt）—\n${rules.slice(0, 12).map((r) => `· [${r.id}] ${r.name}：${clip(r.summary, 100)}`).join("\n")}${rules.length > 12 ? `\n（另有 ${rules.length - 12} 条，read_ontology 可查）` : ""}` : "— 无挂载规则 —",
    objects.length ? `— 触碰的数据对象（字段过长时用 describe_object 定点查）—\n${objects.map(objectLine).join("\n")}` : "",
    myBlocking.length ? `— ⚠ 本切片当前的就绪阻塞（设计前需 revise_ontology 或 ask_user 解决）—\n${myBlocking.slice(0, 6).map((b) => `· ${b.code}${b.field ? `(${b.field})` : ""}: ${clip(b.message, 90)}`).join("\n")}` : "— 就绪：本切片无阻塞 —",
  ].filter(Boolean);

  const brief = sections.join("\n\n");
  return brief.length > maxChars ? `${brief.slice(0, maxChars)}\n…（简报超长已截断——缺的细节用 read_ontology/describe_object 定点查）` : brief;
}
