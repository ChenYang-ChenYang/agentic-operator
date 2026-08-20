// #ANCHOR — 本体记忆锚点循环：确保 agent 在整个运行过程中【永远不忘本体】。
//
// 已有的两道防线只覆盖"折叠时不丢"：ctx.ontologyUnderstanding 是 buildStateSummary 的
// 折叠幸存者（压缩后仍在），serializeCtx 让它跨重启存活。但两次折叠之间的长跑里，
// 早期的理解会被几十轮工具结果稀释——模型不是"丢了"而是"注意力淡了"（读了就忘的
// 另一种形态）。这条锚点循环按节拍把【本体核心事实 + 消化结论 + 还欠的覆盖】重新注入
// 对话，作为持续的 re-grounding 心跳。
//
// 原则：锚点是【事实提醒】不是【指令】——只陈述本体状态与未覆盖清单，不指挥下一步
// （下一步仍由大脑 + policy 决定）；短（≤~800 字符）、确定性、可测试；节拍可调
// （FACTORY_ONTOLOGY_ANCHOR_EVERY，默认每 8 轮，0=关闭）。

import type { BrainCtx } from "./brain-types";
import { factoryGenerationScopedAgentActionNames } from "./generation-directive";

export const DEFAULT_ANCHOR_EVERY = 8;

/** 这一轮是否该注入锚点：有本体、节拍命中、且不是第 0 轮（首轮上下文本来就新鲜）。 */
export function anchorDue(turn: number, everyN: number = DEFAULT_ANCHOR_EVERY): boolean {
  if (!Number.isFinite(everyN) || everyN <= 0) return false;
  return turn > 0 && turn % everyN === 0;
}

/** 组装锚点文本（纯函数）。没有本体 → null（无事实可锚）。 */
export function buildOntologyAnchor(
  ctx: Pick<BrainCtx, "ontology" | "ontologyUnderstanding" | "specs" | "policy" | "planScope" | "generationDirective">,
  turn: number,
): string | null {
  const ont = ctx.ontology;
  if (!ont) return null;
  const allAgentActions = (ont.actions ?? []).filter((a) => (a.actor ?? []).includes("Agent")).map((a) => a.name);
  const designed = new Set((ctx.specs ?? []).map((s) => s.actionName));
  // #SCOPE — 用户点名只做一部分时，范围外的动作没有 spec 是【本意】。旧版无视 ctx.planScope，
  // 每 8 轮把整本体的未覆盖动作当"还欠"打回上下文——这既违反本文件开头自己写的"锚点是【事实
  // 提醒】不是【指令】"，也是"用户只要 1 个却被推去造 6 个"的周期性推力来源之一。
  const structuredScope = Boolean(ctx.generationDirective);
  const partial = !structuredScope && ctx.planScope?.kind === "partial";
  const outOfScope = new Set(partial ? (ctx.planScope?.missedActions ?? []) : []);
  const agentActions = structuredScope
    ? factoryGenerationScopedAgentActionNames(
        ont,
        ctx.generationDirective,
      )
    : allAgentActions.filter((a) => !outOfScope.has(a));
  const uncovered = agentActions.filter((a) => !designed.has(a));
  const lines: string[] = [
    `[本体锚点·第${turn}轮] 域「${ont.domainId}」：${allAgentActions.length} 个 Agent 动作 · ${ont.events?.length ?? 0} 事件 · ${ont.rules?.length ?? 0} 规则。这是你工作的业务事实基础，任何事件名/字段/规则引用都必须来自它。`,
  ];
  if (partial) {
    lines.push(`本次范围(用户指定·部分)：只做 ${agentActions.join("、") || "(见计划)"}${outOfScope.size ? `；范围外 ${outOfScope.size} 个不做：${[...outOfScope].slice(0, 8).join("、")}${outOfScope.size > 8 ? " …" : ""}` : ""}。`);
  } else if (structuredScope) {
    lines.push(`本次范围(服务端 generation scope)：只验收 ${agentActions.join("、") || "(空)"}；全域其它 Agent 动作不属于本次待办。`);
  }
  // #ANCHOR-FACTS — 本文件开头自己立的规矩：锚点是【事实提醒】不是【指令】，只陈述状态、不指挥
  // 下一步（下一步由大脑判断）。所以这里全部写成事实句，不带"别重复设计/先消化再动"这类祈使——
  // 「已全覆盖了还要不要动某个 agent」「要不要先深读」都由大脑自己看着办。
  if (uncovered.length) {
    lines.push(`范围内还没有 spec 的动作(${uncovered.length})：${uncovered.slice(0, 8).join("、")}${uncovered.length > 8 ? " …" : ""}`);
  } else if (agentActions.length) {
    lines.push(`范围内的 Agent 动作 spec 覆盖：${agentActions.filter((name) => designed.has(name)).length}/${agentActions.length}（全覆盖）。`);
  }
  if (ctx.ontologyUnderstanding) {
    lines.push(`此前的消化结论（可继续沿用）：${ctx.ontologyUnderstanding.slice(0, 420)}`);
  } else {
    lines.push(`understand_ontology：尚未执行（本体理解仅结构层，未做深度消化）。`);
  }
  // 路线不在锚点里复述——它已由 applyPolicyRoute 单点管理（含 routeChanged 时的物理 prune + 改宣）；
  // 在这里重推会绕过那套作废机制，把可能已过期的路线又塞回上下文。
  return lines.join("\n");
}
