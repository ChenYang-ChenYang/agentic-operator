// #TOOL-REQ —— 在 Build 之前回答 FDE 的那个问题：
//   「这个 Action 需要哪些工具？我们库里有没有？是哪个？缺不缺？」
//
// 为什么需要这个模块。能力匹配引擎（resolveIntegrationBindings）本身早就写好并且接线了，
// 但它只接在 design_agent 里 —— 也就是只在 Build 开始之后、只针对模型已经挑好的工具、
// 而且不带证据。于是 FDE 在决定要不要生成之前，看不到任何工具层面的事实。
// 这里把同一套判定【前移】成一次只读分析：按 Action 逐条列出本体声明的集成需求、
// 库里对得上的真实工具名、以及真正的缺口。不新建第二套匹配逻辑。
//
// 两条诚实性纪律，都是被真实数据逼出来的：
//
//  1. 本体声明 kind:"human_ui" 的需求【不是工具缺口】，是本体自己写明的人工环节。
//     绑定引擎不认识 human_ui（全仓库只在本体数据里出现），会把它当成"没有工具覆盖"，
//     于是 Agents-generation 的 11 条人工环节被报成 11 个缺工具 —— 这会让 FDE 以为
//     要去补 11 个工具，而实际上一个都不用补。
//
//  2. 匹配是【断言】，必须带证据与置信度。同分多选一律报"待人工选择"，绝不替 FDE 挑一个：
//     两个都能读对象存储的工具，选错的那个可能读的是另一套存储。
//
// 这个模块只读，不改任何 spec、不写任何绑定；它的输出是给人看的事实，不是执行决定。

import type { DomainOntology, OntologyAction } from "./ontology-types";
import {
  deriveIntegrationRequirements,
  resolveIntegrationBindings,
  type IntegrationCapabilityProvider,
  type IntegrationRequirement,
  type IntegrationToolBinding,
} from "./integration-binding";
import type { RealTool } from "./tool-catalog";

/** 一条集成需求在工具层面的结论。 */
export type ToolRequirementVerdict =
  /** 本体声明的人工环节（kind=human_ui）。不需要工具，也不算缺口。 */
  | "human_step"
  /** 有唯一真实工具覆盖，且当前即可使用。 */
  | "covered"
  /** 有唯一真实工具，但还要配置（凭证 / profile / 语句目录）。 */
  | "needs_config"
  /** 有唯一真实工具，但还要一次真实探针才敢用。 */
  | "needs_probe"
  /** 多个工具同分。必须由人来选；替 FDE 选一个是错的。 */
  | "ambiguous"
  /** 全库没有任何工具声明覆盖它 —— 这才是真缺口。 */
  | "gap"
  /** 匹配没跑成（引擎报错）。「没判成」不是「没工具」，绝不并入缺口。 */
  | "unknown";

export interface ToolRequirementRow {
  actionName: string;
  /** 本体里这条需求的稳定 id。 */
  requirementId: string;
  system: string;
  kind: string;
  role: string;
  /** 本体写明的能力标识（如 jd.generate）。 */
  capability: string | null;
  objectTypes: string[];
  verdict: ToolRequirementVerdict;
  /** 命中的真实工具名。ambiguous 时是全部候选。 */
  tools: string[];
  /** 为什么是这个结论 —— 直接取自绑定引擎的理由，不另编话术。 */
  reason: string;
  /** 还缺什么才能用：凭证环境变量 / 配置键。 */
  missingCredentialEnv: string[];
  missingConfigKeys: string[];
}

export interface ToolRequirementAnalysis {
  /** 本体一共声明了多少条集成需求。 */
  total: number;
  /** 本体声明的人工环节数（不是缺口）。 */
  humanSteps: number;
  covered: number;
  needsConfig: number;
  needsProbe: number;
  ambiguous: number;
  /** 真缺口：全库无工具覆盖。 */
  gaps: number;
  /** 没能判定的条数。与 gaps 分开计，避免把读取故障当成缺工具。 */
  unknown: number;
  /** 真缺口涉及的外部系统，去重。这是「要新建哪些工具」的答案。 */
  gapSystems: string[];
  /** 参与本次匹配的工具库规模，让读者知道结论的取材面。 */
  catalogSize: number;
  rows: ToolRequirementRow[];
}

/** 本体里声明为人工界面的需求：由人来做，不需要工具。 */
function isHumanStep(requirement: IntegrationRequirement): boolean {
  return String(requirement.kind ?? "").trim().toLowerCase() === "human_ui";
}

function bindingVerdict(binding: IntegrationToolBinding): ToolRequirementVerdict {
  if (binding.selectionRequired) return "ambiguous";
  switch (binding.status) {
    case "resolved":
      return "covered";
    case "needs_config":
      return "needs_config";
    case "needs_probe":
      return "needs_probe";
    default:
      return "gap";
  }
}

function candidateNames(binding: IntegrationToolBinding): string[] {
  if (binding.selectionRequired) {
    return (binding.selectionCandidates ?? [])
      .map((candidate) => candidate.toolName ?? candidate.bindingId)
      .filter((name): name is string => Boolean(name))
      .sort();
  }
  return binding.toolName ? [binding.toolName] : [];
}

/**
 * 按 Action 分析工具需求。纯只读：不改 spec、不写绑定、不调模型。
 *
 * `tools` 应当是这个租户在设计期真正能用到的全部工具（全局注册表 + 租户能力包）。
 * 传少了会把「我们没查」显示成「库里没有」—— 所以 catalogSize 一并输出，让读者能判断。
 */
export function analyzeToolRequirements(
  ontology: DomainOntology,
  tools: RealTool[],
  opts: {
    /** 租户已确认的系统别名组：同一组内的名字指同一个外部系统。 */
    systemAliasGroups?: readonly (readonly string[])[];
    /** 平台自带的运行时能力（LLM 网关、agent 互调等）。 */
    capabilityProviders?: IntegrationCapabilityProvider[];
  } = {},
): ToolRequirementAnalysis {
  const rows: ToolRequirementRow[] = [];

  for (const action of ontology.actions ?? []) {
    const requirements = deriveIntegrationRequirements(action as OntologyAction);
    if (requirements.length === 0) continue;

    // 人工环节先摘出来：它们不该进绑定引擎，进去只会被报成缺工具。
    const humanRequirements = requirements.filter(isHumanStep);
    for (const requirement of humanRequirements) {
      rows.push({
        actionName: action.name,
        requirementId: requirement.id,
        system: requirement.system,
        kind: requirement.kind,
        role: requirement.role,
        capability: requirement.capability ?? null,
        objectTypes: requirement.objectTypes ?? [],
        verdict: "human_step",
        tools: [],
        reason: "本体声明为人工界面（human_ui）：由人执行，不需要工具，也不构成缺口。",
        missingCredentialEnv: [],
        missingConfigKeys: [],
      });
    }
    if (humanRequirements.length === requirements.length) continue;

    // 其余交给既有的能力匹配引擎 —— 不另写一套判定。
    const machineIds = new Set(
      requirements.filter((r) => !isHumanStep(r)).map((r) => r.id),
    );
    let bindings: IntegrationToolBinding[] = [];
    try {
      bindings = resolveIntegrationBindings(action as OntologyAction, tools, {
        ...(opts.systemAliasGroups ? { systemAliasGroups: opts.systemAliasGroups } : {}),
        ...(opts.capabilityProviders ? { capabilityProviders: opts.capabilityProviders } : {}),
      }).bindings;
    } catch (error) {
      // 引擎拒绝了整个 Action 就如实说 —— 判为 unknown 而不是 gap：
      // 「我们没判成」和「库里没有」是两件事，混在一起会让 FDE 去建不该建的工具。
      for (const requirement of requirements.filter((r) => !isHumanStep(r))) {
        rows.push({
          actionName: action.name,
          requirementId: requirement.id,
          system: requirement.system,
          kind: requirement.kind,
          role: requirement.role,
          capability: requirement.capability ?? null,
          objectTypes: requirement.objectTypes ?? [],
          verdict: "unknown",
          tools: [],
          reason: `无法完成匹配：${(error as Error).message}`,
          missingCredentialEnv: [],
          missingConfigKeys: [],
        });
      }
      continue;
    }

    for (const binding of bindings) {
      if (!machineIds.has(binding.requirement.id)) continue;
      rows.push({
        actionName: action.name,
        requirementId: binding.requirement.id,
        system: binding.requirement.system,
        kind: binding.requirement.kind,
        role: binding.requirement.role,
        capability: binding.requirement.capability ?? null,
        objectTypes: binding.requirement.objectTypes ?? [],
        verdict: bindingVerdict(binding),
        tools: candidateNames(binding),
        reason: binding.reason,
        missingCredentialEnv: binding.missingCredentialEnv ?? [],
        missingConfigKeys: binding.missingConfigKeys ?? [],
      });
    }
  }

  rows.sort((a, b) =>
    a.actionName.localeCompare(b.actionName) || a.requirementId.localeCompare(b.requirementId));

  const count = (verdict: ToolRequirementVerdict): number =>
    rows.filter((row) => row.verdict === verdict).length;

  return {
    total: rows.length,
    humanSteps: count("human_step"),
    covered: count("covered"),
    needsConfig: count("needs_config"),
    needsProbe: count("needs_probe"),
    ambiguous: count("ambiguous"),
    gaps: count("gap"),
    unknown: count("unknown"),
    gapSystems: [
      ...new Set(rows.filter((row) => row.verdict === "gap").map((row) => row.system)),
    ].sort(),
    catalogSize: tools.length,
    rows,
  };
}

const VERDICT_LABEL: Record<ToolRequirementVerdict, string> = {
  human_step: "人工环节",
  covered: "已覆盖",
  needs_config: "待配置",
  needs_probe: "待探针",
  ambiguous: "待人工选择",
  gap: "缺工具",
  unknown: "无法判定",
};

/** 紧凑、给模型看的渲染。截断必须自报，绝不让读者以为是全量。 */
export function renderToolRequirementsForModel(
  analysis: ToolRequirementAnalysis,
  opts: { maxRows?: number } = {},
): string {
  if (analysis.total === 0) return "";
  const maxRows = opts.maxRows ?? 40;
  const lines: string[] = [];
  lines.push(
    `工具需求：${analysis.total} 条集成需求 · 已覆盖 ${analysis.covered}`
    + ` · 待配置 ${analysis.needsConfig} · 待探针 ${analysis.needsProbe}`
    + ` · 待人工选择 ${analysis.ambiguous} · 缺工具 ${analysis.gaps}`
    + (analysis.unknown ? ` · 无法判定 ${analysis.unknown}（匹配没跑成，不等于缺工具）` : "")
    + ` · 人工环节 ${analysis.humanSteps}（本体声明，不是缺口）`
    + `（工具库 ${analysis.catalogSize} 个）`,
  );
  if (analysis.gapSystems.length) {
    lines.push(`- 真缺口涉及的系统：${analysis.gapSystems.join("、")} —— 这里才需要新建工具`);
  }
  // 先看缺口与歧义：那是 FDE 真正要做决定的地方。
  const ordered = [...analysis.rows].sort((a, b) => {
    const rank = (v: ToolRequirementVerdict) =>
      v === "unknown" ? 0 : v === "gap" ? 1 : v === "ambiguous" ? 2 : v === "needs_probe" ? 3 : v === "needs_config" ? 4 : v === "covered" ? 5 : 6;
    return rank(a.verdict) - rank(b.verdict) || a.actionName.localeCompare(b.actionName);
  });
  const shown = ordered.slice(0, maxRows);
  lines.push(
    shown.length < ordered.length
      ? `- 明细（共 ${ordered.length} 条，下列为前 ${shown.length} 条，按需处理优先级排序）：`
      : "- 明细：",
  );
  for (const row of shown) {
    lines.push(
      `  · ${row.actionName} · ${row.system}/${row.kind}/${row.role}`
      + `${row.capability ? ` · ${row.capability}` : ""}`
      + ` → ${VERDICT_LABEL[row.verdict]}`
      + `${row.tools.length ? `：${row.tools.join(" | ")}` : ""}`
      + `${row.missingCredentialEnv.length ? ` · 缺凭证 ${row.missingCredentialEnv.join("、")}` : ""}`,
    );
  }
  return lines.join("\n");
}
