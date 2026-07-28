// OntoCode · Ontology Analyst — the comprehension pass.
//
// The problem it solves: everything upstream saw the domain as a flat catalogue.
// `read_ontology` handed the model `links: <count>` — the compiled relationship
// graph (typed edges, each carrying the compiler's own reasoning) was fetched and
// then discarded before anyone reasoned over it. So "understanding" could never
// be more than a restatement of the action list.
//
// The loop here is deliberately deterministic on the outside and judgemental only
// where judgement is required:
//
//   PLAN       structural read of the REAL graph (pure, no model)
//   PROBE      bounded live lookups against the same authoritative source
//   INTERPRET  one model pass that must cite ids it was given
//   VERIFY     every citation re-checked against the structure; a claim whose
//              refs do not exist is downgraded, never quietly published
//
// Honesty rules that are enforced, not merely intended:
//   · a source that cannot serve instances reports `unsupported_by_source`
//   · a domain with zero rows reports `empty` and the report says conclusions are
//     schema/relationship-grounded only
//   · no gateway configured still yields a full structural report, marked as
//     having no interpretation rather than inventing one
import {
  analyzeOntologyStructure,
  analyzeToolRequirements,
  chatJson,
  isGatewayConfigured,
  renderAnalysisForModel,
  renderToolRequirementsForModel,
  type DomainOntology,
  type IntegrationCapabilityProvider,
  type OntologyStructuralAnalysis,
  type RealTool,
  type ToolRequirementAnalysis,
} from "@agentic/agent-factory";

export type SubstrateState =
  | "available"
  | "empty"
  | "unsupported_by_source"
  | "not_configured";

export interface AnalystFinding {
  claim: string;
  /** Ontology ids the claim rests on (object / action / event / rule / link). */
  refs: string[];
  verdict: "confirmed" | "unverifiable";
  /** Which refs did not exist in the ontology — why a claim was downgraded. */
  unknownRefs?: string[];
}

export interface OntologyAnalysisReceipt {
  schema: "ontocode-ontology-analysis/v1";
  domain: string;
  ontologyHash: string | null;
  structure: OntologyStructuralAnalysis;
  substrate: {
    relationshipGraph: SubstrateState;
    instances: SubstrateState;
    interpretation: SubstrateState;
    /** #TOOL-REQ — whether we could read the tool catalogue at all. */
    toolCatalogue: SubstrateState;
  };
  /**
   * #TOOL-REQ — per-Action: which integrations this domain declares, which real
   * tools cover them, and what is genuinely missing. `null` means the catalogue
   * could not be read — which is NOT the same as "nothing is missing".
   */
  toolRequirements: ToolRequirementAnalysis | null;
  probes: Array<{
    probe: string;
    target: string;
    ok: boolean;
    detail: string;
  }>;
  findings: AnalystFinding[];
  limitations: string[];
  narrative: string | null;
}

export interface AnalystDeps {
  /** Live rule lookup on the bound source; absent on sources without it. */
  fetchActionRules?: (
    domain: string,
    actionName: string,
  ) => Promise<unknown>;
  /** Row sampling; absent on sources that only carry metadata. */
  listInstances?: (
    domain: string,
    objectType: string,
    opts: { limit: number },
  ) => Promise<{ items: unknown[] }>;
  /**
   * #TOOL-REQ — the same execution surfaces Build reads. Absent means the
   * requirement facet is skipped and reported as `not_configured`.
   */
  listExecutionResources?: () => Promise<{
    tools: RealTool[];
    capabilityProviders: IntegrationCapabilityProvider[];
    systemAliasGroups: string[][];
  }>;
  /** Injectable so tests never reach a real gateway. */
  interpret?: (system: string, user: string) => Promise<unknown>;
  gatewayConfigured?: () => boolean;
  onProgress?: (
    type: string,
    payload: Record<string, unknown>,
    visibility?: "user" | "debug" | "audit",
  ) => Promise<void>;
}

const MAX_RULE_PROBES = 6;
const MAX_INSTANCE_PROBES = 5;

function idUniverse(ontology: DomainOntology): Set<string> {
  const ids = new Set<string>();
  for (const o of ontology.objects ?? []) {
    ids.add(o.id);
    if (o.name) ids.add(o.name);
  }
  for (const a of ontology.actions ?? []) {
    ids.add(a.id);
    ids.add(a.name);
  }
  for (const e of ontology.events ?? []) ids.add(e.name);
  for (const l of ontology.links ?? []) ids.add(l.id);
  for (const [index, rule] of (ontology.rules ?? []).entries()) {
    const record = rule as Record<string, unknown>;
    const id = record.id ?? record.rule_id ?? record.name;
    ids.add(typeof id === "string" && id ? id : `rule:${index + 1}`);
  }
  return ids;
}

const INTERPRET_SYSTEM = [
  "你是企业本体分析师。下面给你的是某个业务域【真实的】结构分析：实体连接度、关系类型（含真实边示例）、事件链、外部系统与结构缺口。",
  "任务：解释这个域在业务上到底在做什么、核心实体如何相互支撑、自动化边界在哪里、有哪些真实风险。",
  "硬性要求：",
  "1) 每条结论必须附 refs——只能引用材料里出现过的 id（对象名/动作名/事件名/关系边 id）。不确定就不要写。",
  "2) 不要复述计数；要给出结构含义（例如「Job_Posting 通过 object-fk 指向 Job_Requisition，说明岗位发布依赖需求单，删除需求单会造成悬挂发布」）。",
  "3) 不许编造材料中不存在的实体、字段、系统或规则。",
  '只输出 JSON：{"findings":[{"claim":string,"refs":string[]}],"narrative":string}',
].join("\n");

/**
 * Run the comprehension pass. Never throws for a missing substrate — an absent
 * capability is reported as state, because "we could not look" and "we looked and
 * found nothing" are different facts and the FDE needs to tell them apart.
 */
export async function analyzeOntology(
  ontology: DomainOntology,
  opts: { ontologyHash?: string | null } & AnalystDeps = {},
): Promise<OntologyAnalysisReceipt> {
  const structure = analyzeOntologyStructure(ontology);
  await opts.onProgress?.("harness.ontology_analysis.plan", {
    domain: structure.domainId,
    counts: structure.counts,
    hasLinkGraph: structure.hasLinkGraph,
  });

  const probes: OntologyAnalysisReceipt["probes"] = [];
  const limitations: string[] = [];

  // ── PROBE: live rule bindings for the busiest agent actions ──────────────
  if (opts.fetchActionRules) {
    for (const name of structure.agentActions.slice(0, MAX_RULE_PROBES)) {
      try {
        const rules = await opts.fetchActionRules(structure.domainId, name);
        const count = Array.isArray(rules) ? rules.length : 0;
        probes.push({
          probe: "action_rules",
          target: name,
          ok: true,
          detail: `${count} 条规则绑定`,
        });
      } catch (error) {
        probes.push({
          probe: "action_rules",
          target: name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── PROBE: does the graph carry any real rows? ───────────────────────────
  let instances: SubstrateState = "unsupported_by_source";
  if (opts.listInstances) {
    let sampled = 0;
    const targets = structure.hubs.slice(0, MAX_INSTANCE_PROBES);
    for (const hub of targets) {
      try {
        const page = await opts.listInstances(structure.domainId, hub.id, {
          limit: 5,
        });
        const n = Array.isArray(page?.items) ? page.items.length : 0;
        sampled += n;
        probes.push({
          probe: "instances",
          target: hub.id,
          ok: true,
          detail: `${n} 行样本`,
        });
      } catch (error) {
        probes.push({
          probe: "instances",
          target: hub.id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    instances = sampled > 0 ? "available" : "empty";
    if (instances === "empty") {
      limitations.push(
        "图中当前没有实例数据（0 行），因此结论只基于结构与关系，未经真实数据佐证。",
      );
    }
  } else {
    limitations.push(
      "当前本体来源不提供实例读取，无法用真实数据校验结构结论。",
    );
  }

  if (!structure.hasLinkGraph) {
    limitations.push(
      "该来源没有提供已编译的关系图，实体关联只能从动作的 target_objects 推断。",
    );
  }

  // ── PROBE: 工具需求 ───────────────────────────────────────────────────────
  // 本体的 Action 不声明固定工具，所以「要哪些工具、我们有没有」必须推出来。
  // 用的是 Build 期同一套能力匹配，只是前移到这里，且只读。
  let toolRequirements: ToolRequirementAnalysis | null = null;
  let toolCatalogue: SubstrateState = "not_configured";
  if (opts.listExecutionResources) {
    try {
      const resources = await opts.listExecutionResources();
      toolRequirements = analyzeToolRequirements(ontology, resources.tools, {
        systemAliasGroups: resources.systemAliasGroups,
        capabilityProviders: resources.capabilityProviders,
      });
      toolCatalogue = resources.tools.length > 0 ? "available" : "empty";
      probes.push({
        probe: "tool_requirements",
        target: `${resources.tools.length} 个工具`,
        ok: true,
        detail:
          `${toolRequirements.total} 条集成需求：已覆盖 ${toolRequirements.covered}`
          + ` · 待配置 ${toolRequirements.needsConfig} · 待探针 ${toolRequirements.needsProbe}`
          + ` · 待人工选择 ${toolRequirements.ambiguous} · 缺工具 ${toolRequirements.gaps}`
          + (toolRequirements.unknown ? ` · 无法判定 ${toolRequirements.unknown}` : "")
          + ` · 人工环节 ${toolRequirements.humanSteps}`,
      });
      if (toolCatalogue === "empty") {
        limitations.push(
          "工具目录读到 0 个工具，因此「缺哪些工具」的结论无效——这是读取问题，不代表没有可用工具。",
        );
      }
      if (toolRequirements.unknown > 0) {
        limitations.push(
          `${toolRequirements.unknown} 条集成需求没能完成匹配（引擎报错），既不算已覆盖也不算缺工具。`,
        );
      }
      if (toolRequirements.ambiguous > 0) {
        limitations.push(
          `${toolRequirements.ambiguous} 条集成需求有多个同分工具，必须由人来选；这里不替你挑。`,
        );
      }
    } catch (error) {
      // 读不到就说读不到。绝不把「没查成」显示成「不缺工具」。
      toolCatalogue = "unsupported_by_source";
      probes.push({
        probe: "tool_requirements",
        target: "工具目录",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      limitations.push(
        "本次没能读到工具目录，无法判断这个域缺哪些工具。",
      );
    }
  } else {
    limitations.push(
      "未接入工具目录，本次不含工具需求分析。",
    );
  }

  await opts.onProgress?.("harness.ontology_analysis.observation", {
    probes: probes.length,
    instances,
    toolCatalogue,
    ...(toolRequirements
      ? {
          toolRequirements: {
            total: toolRequirements.total,
            covered: toolRequirements.covered,
            gaps: toolRequirements.gaps,
            ambiguous: toolRequirements.ambiguous,
            gapSystems: toolRequirements.gapSystems,
          },
        }
      : {}),
    limitations: limitations.length,
  });

  // ── INTERPRET: one model pass over the structural facts ──────────────────
  const gatewayOk = (opts.gatewayConfigured ?? isGatewayConfigured)();
  let findings: AnalystFinding[] = [];
  let narrative: string | null = null;
  let interpretation: SubstrateState = "not_configured";

  if (gatewayOk) {
    const rendered = renderAnalysisForModel(structure);
    const probeText = probes.length
      ? `\n\n实测探针：\n${probes.map((p) => `- ${p.probe} ${p.target}：${p.ok ? p.detail : `失败（${p.detail}）`}`).join("\n")}`
      : "";
    // 工具事实交给模型，让「自动化边界在哪」有据可依，而不是凭动作名猜。
    const toolText = toolRequirements
      ? `\n\n${renderToolRequirementsForModel(toolRequirements)}`
      : "";
    const call =
      opts.interpret ??
      ((system: string, user: string) =>
        chatJson<unknown>(system, user, {
          temperature: 0.2,
          maxTokens: 3000,
          purpose: "ontology_analysis",
        }));
    const material = `${rendered}${probeText}${toolText}`;
    // #HARNESS-TELEMETRY — 这一步是真的在调模型。以前它无声无息，看板上
    // 「理解 Ontology」只有开头结尾两个标记，中间那次真实推理没有任何痕迹。
    await opts.onProgress?.(
      "harness.ontology_analysis.interpret_started",
      { materialChars: material.length, probes: probes.length },
      "debug",
    );
    try {
      const raw = await call(INTERPRET_SYSTEM, material);
      const parsed = raw as
        | { findings?: unknown; narrative?: unknown }
        | null
        | undefined;
      const universe = idUniverse(ontology);
      const rawFindings = Array.isArray(parsed?.findings)
        ? parsed.findings
        : [];
      // ── VERIFY: a claim is only "confirmed" if every id it cites exists ──
      findings = rawFindings.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const claim = (entry as { claim?: unknown }).claim;
        if (typeof claim !== "string" || !claim.trim()) return [];
        const refsRaw = (entry as { refs?: unknown }).refs;
        const refs = Array.isArray(refsRaw)
          ? refsRaw.filter(
              (r): r is string => typeof r === "string" && r.trim().length > 0,
            )
          : [];
        const unknownRefs = refs.filter((r) => !universe.has(r));
        const confirmed = refs.length > 0 && unknownRefs.length === 0;
        return [
          {
            claim: claim.trim(),
            refs,
            verdict: confirmed
              ? ("confirmed" as const)
              : ("unverifiable" as const),
            ...(unknownRefs.length ? { unknownRefs } : {}),
          },
        ];
      });
      const narrativeRaw = parsed?.narrative;
      narrative =
        typeof narrativeRaw === "string" && narrativeRaw.trim()
          ? narrativeRaw.trim()
          : null;
      interpretation = findings.length > 0 || narrative ? "available" : "empty";
      await opts.onProgress?.(
        "harness.ontology_analysis.interpret_completed",
        {
          findings: findings.length,
          confirmed: findings.filter((f) => f.verdict === "confirmed").length,
          narrativeChars: narrative?.length ?? 0,
        },
        "debug",
      );
      const downgraded = findings.filter(
        (f) => f.verdict === "unverifiable",
      ).length;
      if (downgraded > 0) {
        limitations.push(
          `${downgraded} 条结论引用了本体中不存在的 id，已标记为未经验证。`,
        );
      }
    } catch (error) {
      interpretation = "empty";
      limitations.push(
        `解释环节失败，仅保留结构分析：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    limitations.push(
      "未配置 LLM 网关，本次只产出确定性的结构分析，没有解释环节。",
    );
  }

  await opts.onProgress?.("harness.ontology_analysis.synthesis", {
    findings: findings.length,
    confirmed: findings.filter((f) => f.verdict === "confirmed").length,
    interpretation,
  });

  return {
    schema: "ontocode-ontology-analysis/v1",
    domain: structure.domainId,
    ontologyHash: opts.ontologyHash ?? null,
    structure,
    substrate: {
      relationshipGraph: structure.hasLinkGraph ? "available" : "empty",
      instances,
      interpretation,
      toolCatalogue,
    },
    toolRequirements,
    probes,
    findings,
    limitations,
    narrative,
  };
}
