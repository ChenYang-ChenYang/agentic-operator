/**
 * Specialists — the LIGHT nesting channel of the factory's shared reasoning core.
 *
 * Two nesting channels exist (see docs/ao-architecture-layers.html §4.5):
 *   · HEAVY  — spawn_subagent: a full recursive runBrain with its own message history
 *     and read-only tools, for tasks that must fetch data / reason over turns.
 *   · LIGHT  — this module: role-prompted, single-shot structured calls run IN PARALLEL,
 *     for cognitive decomposition when the data is already in hand (e.g. digesting a big
 *     ontology by dimension: objects / rules / actions / events; parsing user intent).
 *
 * Both channels share the SAME reasoning infrastructure (stream-gateway model routing,
 * fallback chain, llm_calls telemetry) — "共用一个推理大脑": what specializes is the ROLE
 * and its context window, never a second model stack. Every specialist surfaces as a
 * subagent.start/done pair, so the chat transcript, the 大脑 tab and the 后台任务 panel
 * all show the fan-out for free.
 *
 * Testability: every entry point accepts an injectable `llm` (defaults to chatOnce), so
 * unit tests drive the orchestration with a fake — no provider calls.
 */

import { chatOnce } from "./stream-gateway";
import { modelChain, type ModelTier } from "./model-router";
import { ruleEnforcementLevelValue } from "./ontology-aggregates";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// #ROLE-TIER (P0-2) — specialists (cognitive experts / intent gate / synthesis) default to the fast
// chain WITH fallback (they previously pinned the single configured model — the live 402 failure mode).
function specialistModels(): string[] {
  const raw = process.env.FACTORY_SPECIALIST_TIER?.trim();
  const tier: ModelTier = (["fast", "default", "hard", "review"] as const).find((t) => t === raw) ?? "fast";
  return modelChain(tier);
}

export type SpecialistLlm = (system: string, user: string, opts?: { maxTokens?: number; purpose?: string }) => Promise<string>;

export interface SpecialistTask {
  id: string;
  /** Short role name, e.g. "rules 专家" — becomes the subagent card title. */
  role: string;
  system: string;
  user: string;
  /** #FULL-DIMENSION — when the dimension does not fit one call, the pre-built per-batch prompts.
   * Each is analyzed, then merged, so EVERY item is seen exactly once. `user` is the single-batch
   * form (used when this is absent). */
  batches?: string[];
  maxTokens?: number;
  /** Compact name/count census of this dimension — what the (optional) deepen pass re-reads to
   * self-critique against, instead of re-sending the full dimension. */
  census?: string;
  /** Honest coverage of this dimension: how many items were fed, over how many batches, and how
   * many were individually too large to fit whole (the only lossy path — never silent). */
  coverage?: { itemsTotal: number; batches: number; oversized: number };
  /** Item count per batch, so a FAILED batch can be subtracted from reported coverage instead of
   * being silently counted as analyzed. */
  batchItemCounts?: number[];
}

/** Per-call character budget for ONE expert batch. The dimension is packed into as many batches as
 * needed so nothing is dropped; this only bounds a single call's input. Well under every gateway
 * model's context (≈30k tokens at the default), and env-tunable for bigger/smaller deployments. */
export const SPECIALIST_BATCH_CHARS: number = (() => {
  const raw = Number(process.env.FACTORY_SPECIALIST_BATCH_CHARS);
  return Number.isFinite(raw) && raw >= 4_000 ? Math.floor(raw) : 120_000;
})();

/**
 * #FULL-DIMENSION — pack a dimension's items into batches under `budget`, guaranteeing that every
 * item is analyzed EXACTLY ONCE and that no item is ever split mid-record.
 *
 * This replaces a silent `capJson(dimension, N)` truncation that (measured on the live
 * Agents-generation ontology) hid 62–72% of every dimension from its own expert — e.g. the actions
 * expert saw ~2 of 16 actions and still answered authoritatively.
 *
 * An item whose own serialization exceeds the whole budget still gets analyzed, alone in its batch,
 * and is counted in `oversized` so the caller can disclose it instead of pretending full coverage.
 */
export function packDimensionBatches(
  items: unknown[],
  budget: number = SPECIALIST_BATCH_CHARS,
): { batches: unknown[][]; itemsTotal: number; oversized: number } {
  const batches: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  let oversized = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item, null, 1).length + 2;
    if (itemSize > budget) oversized += 1;
    // start a new batch when this item would overflow the current one (an over-budget item lands
    // alone rather than being split — splitting a record would corrupt it).
    if (current.length && size + itemSize > budget) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) batches.push(current);
  return { batches, itemsTotal: items.length, oversized };
}

export interface SpecialistResult {
  id: string;
  role: string;
  ok: boolean;
  /** Parsed JSON when the reply carries one, else the raw text. */
  output: unknown;
  summary: string;
  /** #FULL-DIMENSION — provable coverage of this dimension, surfaced so the user can judge whether
   * the analysis was actually comprehensive instead of taking the conclusion on faith.
   * `itemsAnalyzed` < `itemsTotal` exactly when a batch failed — never rounded up. */
  coverage?: { itemsTotal: number; batches: number; oversized: number; itemsAnalyzed?: number; batchesFailed?: number };
}

/** Tolerant JSON extraction — specialists are asked for JSON but models add fences/prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1]! : t).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  // walk to the matching close so trailing prose doesn't break the parse
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** #EXPERT-REASONING — the second pass: the SAME dimension expert critiques its own draft and
 * deepens it. Re-sends ONLY the draft + a compact census the task carries (never the full dimension
 * again), so a real reasoning round costs ~1 extra call, not a 3× input blowup. */
/** #FULL-DIMENSION — the batched counterpart of DEEPEN_SYSTEM: the dimension was too large for one
 * call, so each batch produced its own conclusions; this pass MERGES them into one complete,
 * de-duplicated judgement and deepens it — the same "real second reasoning round", now over the
 * whole dimension rather than a truncated slice. */
const MERGE_SYSTEM = (role: string, batches: number) =>
  `你是本体分析的「${role}」。你的维度较大，已分 ${batches} 批【全量】分析完毕，各批结论在下方。现在做一轮真正的合并+深化：\n` +
  `1) 把各批结论合并成【一份完整、去重】的结论——跨批次的重复发现合并成一条，别丢任何一批的关键项。\n` +
  `2) 只有跨批对照才看得出的东西（全局分布、批次之间的冲突/缺口/重复定义），必须在这里点出来。\n` +
  `3) 哪些"发现"只是复读清单、没有判断（"所以呢"）？改写成有结论的判断。\n` +
  `4) 对照【维度速览】的完整名单做最后核对（你已看过全部 ${batches} 批，速览用于查漏）。\n` +
  `只输出与各批同结构的 JSON：{"keyFindings":[…],"risks":[…],"ambiguities":[…],"crossDimensionNotes":[…]}。名字逐字来自数据，不确定进 ambiguities，绝不编造。信息密度优先。`;

const DEEPEN_SYSTEM = (role: string) =>
  `你是本体分析的「${role}」复核者。审视你自己的【初稿】，做一轮真正的深化——不是润色：\n` +
  `1) 漏了什么关键项？（对照【维度速览】里的名字逐一核对，别放过任何强制规则/核心对象/闸口动作/断链事件）\n` +
  `2) 哪些"发现"其实只是复读清单、没有判断（"所以呢"）？把它们改写成有结论的判断。\n` +
  `3) 跨维度牵连讲透了吗？（这一维度如何约束动作/事件/规则/对象）\n` +
  `只输出与初稿同结构的 JSON：{"keyFindings":[…],"risks":[…],"ambiguities":[…],"crossDimensionNotes":[…]}。名字逐字来自数据，不确定进 ambiguities，绝不编造。信息密度优先，比初稿更完整。`;

/** Run role-prompted specialists IN PARALLEL. Single failures degrade to ok:false — the caller
 *  decides whether partial understanding is usable (it usually is). With `deepen`, each specialist
 *  runs a real second reasoning round (draft → self-critique & deepen) surfaced as a reasoning.step;
 *  `census` (a per-task compact name/count list) is what the deepen pass re-reads instead of the
 *  full dimension. */
export async function runSpecialists(
  ctx: Pick<BrainCtx, "emit">,
  tasks: SpecialistTask[],
  opts?: { llm?: SpecialistLlm; deepen?: boolean },
): Promise<SpecialistResult[]> {
  const llm: SpecialistLlm = opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 1600, purpose: o?.purpose, models: specialistModels() }));
  const deepen = opts?.deepen === true;
  return Promise.all(
    tasks.map(async (t): Promise<SpecialistResult> => {
      const cov = t.coverage;
      const batchNote = cov && cov.batches > 1 ? `（${cov.itemsTotal} 项 · 分 ${cov.batches} 批全量分析）` : "";
      ctx.emit({ t: "subagent.start", task: `认知专家 · ${t.role}${batchNote}` });
      try {
        // Pass 1 — analyze the WHOLE dimension. #FULL-DIMENSION: a large dimension is split into
        // batches (never truncated), every batch analyzed in parallel, so no item goes unseen.
        // allSettled, NOT all: batching multiplies the number of calls, so a single flaky batch
        // must not discard its siblings' work. Surviving batches still produce an analysis; the
        // items behind a failed batch are subtracted from the reported coverage rather than being
        // quietly counted as analyzed.
        const prompts = t.batches?.length ? t.batches : [t.user];
        const settled = await Promise.allSettled(prompts.map((p, i) =>
          llm(t.system, p, {
            maxTokens: t.maxTokens ?? 1600,
            purpose: `specialist:${t.id}${prompts.length > 1 ? `.b${i + 1}` : ""}`,
          })));
        const drafts: string[] = [];
        const failedBatches: number[] = [];
        settled.forEach((s, i) => (s.status === "fulfilled" ? drafts.push(s.value) : failedBatches.push(i)));
        if (!drafts.length) {
          const first = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
          throw new Error(String(first?.reason instanceof Error ? first.reason.message : first?.reason ?? "all batches failed"));
        }
        // Items actually analyzed = total minus those in the failed batches (honest, not assumed).
        const lostItems = failedBatches.reduce((n, i) => n + (t.batchItemCounts?.[i] ?? 0), 0);
        const analyzed = Math.max(0, (cov?.itemsTotal ?? 0) - lostItems);
        const multi = drafts.length > 1;
        let text = multi
          ? drafts.map((d, i) => `【第 ${i + 1}/${drafts.length} 批结论】\n${d.trim()}`).join("\n\n")
          : drafts[0]!;
        // Pass 2 — a real second reasoning round: merge (when batched) + self-critique + deepen,
        // re-reading only the drafts and the compact census. Visible as a foldable reasoning.step.
        if (deepen || multi) {
          ctx.emit({
            t: "reasoning.step",
            strategy: "reflection",
            index: 0,
            total: 1,
            output: multi ? `【${t.role}】合并 ${drafts.length} 批结论并深化中…` : `【${t.role}】复核初稿并深化中…`,
            forAgent: `认知专家·${t.role}`,
          });
          try {
            const refined = await llm(
              multi ? MERGE_SYSTEM(t.role, drafts.length) : DEEPEN_SYSTEM(t.role),
              `【维度速览】\n${t.census ?? "（无）"}\n\n【你的${multi ? "各批结论" : "初稿"}】\n${text.trim().slice(0, 8_000 * Math.max(1, drafts.length))}`,
              { maxTokens: (t.maxTokens ?? 1600) + (multi ? 800 : 400), purpose: `specialist:${t.id}.${multi ? "merge" : "deepen"}` },
            );
            if (refined.trim()) text = refined;
          } catch { /* best-effort — keep the drafts */ }
        }
        const parsed = extractJson(text);
        const output = parsed ?? text.trim();
        const complete = !failedBatches.length;
        const coverageNote = cov
          ? `${complete ? `${cov.itemsTotal} 项全量` : `⚠ 仅 ${analyzed}/${cov.itemsTotal} 项（${failedBatches.length}/${cov.batches} 批失败，结论不完整）`}${cov.batches > 1 ? `（${cov.batches} 批）` : ""}${cov.oversized ? ` · ⚠ ${cov.oversized} 项单条过大` : ""} · `
          : "";
        const summary = `${coverageNote}${summarizeOutput(t.role, parsed, text)}`;
        ctx.emit({ t: "subagent.done", task: `认知专家 · ${t.role}`, summary });
        return {
          id: t.id,
          role: t.role,
          ok: true,
          output,
          summary,
          ...(cov ? { coverage: { ...cov, itemsAnalyzed: analyzed, batchesFailed: failedBatches.length } } : {}),
        };
      } catch (e) {
        const summary = `${t.role} 分析失败：${(e as Error).message}`;
        ctx.emit({ t: "subagent.done", task: `认知专家 · ${t.role}`, summary });
        return { id: t.id, role: t.role, ok: false, output: null, summary, ...(cov ? { coverage: cov } : {}) };
      }
    }),
  );
}

function summarizeOutput(role: string, parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const findings = Array.isArray(o.keyFindings) ? o.keyFindings.length : 0;
    const risks = Array.isArray(o.risks) ? o.risks.length : 0;
    const amb = Array.isArray(o.ambiguities) ? o.ambiguities.length : 0;
    if (findings || risks || amb) return `${role}：${findings} 项发现 · ${risks} 项风险 · ${amb} 处歧义`;
  }
  return `${role}：${raw.trim().slice(0, 90)}`;
}

// ── ontology deep understanding（四维分治）─────────────────────────────────────────

const DIM_SYSTEM = (role: string, focus: string) =>
  `你是本体分析的「${role}」。只深入分析交给你的这一个维度：${focus}。\n` +
  `只输出 JSON：{"keyFindings":[…每条一句，具体到名字…],"risks":[…],"ambiguities":[…],"crossDimensionNotes":[…这一维度对其它维度（动作/事件/规则/对象）的关键牵连…]}。\n` +
  `所有名字必须逐字来自数据；不确定写进 ambiguities，绝不编造。发现要有判断力（"所以呢"），不要复读清单。`;

/** #RULE-ENFORCEMENT — render a rule's enforcement level for the roster/census.
 *
 * The roster used to read only `enforcement` / `severity`. Live Allmeta rules carry
 * `enforcementLevel` instead (measured: enforcement 0/66, severity 0/66, enforcementLevel 54/66),
 * so the tag NEVER rendered — while the deepen/merge pass is explicitly told 「别放过任何强制规则」.
 * The expert could not tell a mandatory rule from an advisory one anywhere in its checklist.
 * Accept every spelling; stay silent only when the rule genuinely declares no level. */
export function ruleEnforcementTag(rule: Record<string, unknown>): string {
  // Shared with rules_by_enforcement_level (ontology-aggregates) so the chart
  // and this narrative can never disagree about the same rule's declared level.
  const text = ruleEnforcementLevelValue(rule);
  return text ? `[${text}]` : "";
}

const capJson = (v: unknown, n: number): string => {
  const s = JSON.stringify(v, null, 1);
  return s.length > n ? `${s.slice(0, n)}\n…（截断，共 ${s.length} 字符）` : s;
};

/** Assemble one dimension expert. #FULL-DIMENSION — the dimension is BATCHED (never truncated), so
 * the expert provably sees every item; `reference` context from other dimensions stays capped
 * (it is background, not the thing being analyzed). */
function dimensionTask(opts: {
  id: string;
  role: string;
  system: string;
  census: string;
  globalCensus: string;
  label: string;
  items: unknown[];
  reference?: string;
  maxTokens?: number;
}): SpecialistTask {
  const packed = packDimensionBatches(opts.items);
  const total = packed.batches.length;
  const prompt = (batch: unknown[], i: number) =>
    `${opts.globalCensus}\n\n【你的维度：${opts.label}${
      total > 1
        ? ` · 第 ${i + 1}/${total} 批（本维度共 ${packed.itemsTotal} 项，本批 ${batch.length} 项；其余批次由你在后续合并时汇总，本批只管本批）`
        : ` 全量（${packed.itemsTotal} 项，已完整给出）`
    }】\n${JSON.stringify(batch, null, 1)}${opts.reference ? `\n\n${opts.reference}` : ""}`;
  const batches = packed.batches.map(prompt);
  return {
    id: opts.id,
    role: opts.role,
    system: opts.system,
    user: batches[0] ?? `${opts.globalCensus}\n\n【你的维度：${opts.label}】\n（本维度为空）`,
    ...(batches.length > 1 ? { batches } : {}),
    census: opts.census,
    coverage: { itemsTotal: packed.itemsTotal, batches: Math.max(1, batches.length), oversized: packed.oversized },
    batchItemCounts: packed.batches.map((b) => b.length),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
  };
}

/** Build the four dimension-specialist tasks. Each gets its OWN dimension IN FULL (batched when
 *  large) plus a one-line census of the others — a clean, focused context window per dimension.
 *
 *  `toolCatalog` (the REAL registered tool names) is handed to the actions expert because its brief
 *  includes 「工具缺口」: without it the expert can see what an action DECLARES in tool_use but has no
 *  way to know which of those actually exist, so it could only guess. Facts belong in the context —
 *  the expert has no tool-calling channel of its own (that is the HEAVY spawn_subagent channel). */
export function buildOntologySpecialistTasks(
  ont: DomainOntology,
  opts?: { toolCatalog?: string[] },
): SpecialistTask[] {
  const census = `全域概况：${ont.actions.length} 动作 · ${ont.events.length} 事件 · ${ont.rules.length} 规则 · ${ont.objects.length} 数据对象（你只负责自己的维度，其它维度另有专家）`;
  const actionsLite = ont.actions.map((a) => ({ name: a.name, actor: a.actor, trigger: a.trigger, triggered_event: a.triggered_event, tool_use: a.tool_use, description: (a.description ?? "").slice(0, 160) }));
  // Per-dimension name/level rosters — the deepen pass re-reads THESE (cheap) to check nothing was
  // dropped, instead of re-sending the full dimension.
  const ruleRoster = (ont.rules as Array<Record<string, unknown>>).map((r) => `${String(r.name ?? r.id ?? "")}${ruleEnforcementTag(r)}`).join("、");
  return [
    dimensionTask({
      id: "objects",
      role: "objects 专家",
      system: DIM_SYSTEM("数据对象专家", "领域数据模型——对象、属性、对象间关系、哪些对象是流程核心"),
      globalCensus: census,
      label: "dataObjects",
      items: ont.objects,
      reference: `【参照：动作如何触碰对象】\n${capJson(actionsLite.map((a) => ({ name: a.name, targets: ont.actions.find((x) => x.name === a.name)?.target_objects ?? [] })), 6_000)}`,
      census: `对象清单（${ont.objects.length}）：${ont.objects.map((o) => o.name).join("、")}`,
    }),
    dimensionTask({
      id: "rules",
      role: "rules 专家",
      system: DIM_SYSTEM("业务规则专家", "规则体系——强制级别分布、按业务阶段的聚类、关键把关逻辑、规则间冲突或缺口"),
      globalCensus: census,
      label: "rules",
      items: ont.rules,
      reference: `【参照：动作清单】\n${capJson(actionsLite.map((a) => a.name), 2_000)}`,
      maxTokens: 2000,
      census: `规则清单（${ont.rules.length}，逐条核对不要漏）：${ruleRoster}`,
    }),
    dimensionTask({
      id: "actions",
      role: "actions 专家",
      system: DIM_SYSTEM("动作专家", "每个动作的职责边界、触发与产出、工具缺口、哪些动作是规则闸口"),
      globalCensus: census,
      label: "actions",
      items: ont.actions,
      // 工具缺口 is only knowable by comparing each action's declared tool_use against the tools that
      // actually exist — so give the expert that list instead of asking it to guess.
      reference: opts?.toolCatalog?.length
        ? `【参照：工具库真实已注册的工具（${opts.toolCatalog.length} 个）——判断“工具缺口”时，动作 tool_use 里【不在此清单】的即为缺口；不在清单里的名字不要臆断它存在】\n${opts.toolCatalog.join("、")}`
        : `【参照：工具库清单未提供——请勿臆断某工具是否存在；如需判断工具缺口，写进 ambiguities】`,
      census: `动作清单（${ont.actions.length}）：${ont.actions.map((a) => `${a.name}(${(a.actor ?? []).join("/") || "?"})`).join("、")}`,
    }),
    dimensionTask({
      id: "events",
      role: "events 专家",
      system: DIM_SYSTEM("事件链专家", "事件流转——入口/终态/断链、并发扇出、事件载荷契约是否闭合"),
      globalCensus: census,
      label: "events",
      items: ont.events,
      reference: `【参照：动作的触发/产出关系】\n${capJson(actionsLite.map((a) => ({ name: a.name, trigger: a.trigger, emit: a.triggered_event })), 8_000)}`,
      census: `事件清单（${ont.events.length}）：${(ont.events as Array<Record<string, unknown>>).map((e) => String(e.name ?? e.id ?? "")).join("、")}`,
    }),
  ];
}

/** Reduce the four specialists' outputs into ONE coherent understanding (the fold-surviving
 *  ctx.ontologyUnderstanding). Uses one synthesis call; degrades to a deterministic stitch. */
export async function synthesizeUnderstanding(
  results: SpecialistResult[],
  ont: DomainOntology,
  opts?: { llm?: SpecialistLlm },
): Promise<string> {
  const llm: SpecialistLlm = opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 1400, purpose: o?.purpose, models: specialistModels() }));
  const good = results.filter((r) => r.ok);
  const material = good.map((r) => `## ${r.role}\n${typeof r.output === "string" ? r.output : JSON.stringify(r.output)}`).join("\n\n");
  const fallback = () =>
    `【分治理解（确定性拼接）】\n${good.map((r) => `· ${r.summary}`).join("\n")}\n（合成调用失败——以上为各专家原始结论的拼接）`;
  if (!good.length) return "";
  try {
    const text = await llm(
      "你是本体理解的合成者。多位维度专家与业务视角专家已各自深入分析，你把它们合成为一份连贯的整体理解，供后续设计智能体时持续参考。输出纯文本（非 JSON），必须覆盖：要造哪些 agent、主事件链与断链、规则闸口与合规要点、核心数据对象、各业务视角的关键结论（客户触点/运营接管/对账审计等，若有）、待澄清歧义清单。名字逐字来自专家材料，不编造。800 字以内，信息密度优先。",
      `域：${ont.domainId}（${ont.actions.length} 动作 / ${ont.events.length} 事件 / ${ont.rules.length} 规则 / ${ont.objects.length} 对象）\n\n${material.slice(0, 32_000)}`,
      { maxTokens: 1800, purpose: "specialist:synthesize" },
    );
    return text.trim() || fallback();
  } catch {
    return fallback();
  }
}

// ── user intent（意图门）───────────────────────────────────────────────────────────

/** 短肯定/继续类输入——用户在确认推进既定目标，不是新需求。意图门对这类输入不重分类
 *  （重分类会锚定上一行的 [分析] 再判一次 [分析]，形成 分析→提问→"继续"→再分析 的死循环）。
 *  = isExplicitProceed ∪ isBareAffirmative（仍导出，供别处/测试用）。 */
export function isContinueGoal(goal: string): boolean {
  return isExplicitProceed(goal) || isBareAffirmative(goal);
}

/** 明确表意「开始/继续做那件事」的短语——语义上无歧义地指向【推进】。这类走确定性快路径是安全的
 *  （不烧 LLM、也不会误读），因为词本身就带动作方向（"继续/开始生成/接着做"）。 */
export function isExplicitProceed(goal: string): boolean {
  const g = goal.trim().replace(/[。．.!！~～\s]+$/g, "");
  return g.length > 0 && g.length <= 16 && /^(请?继续|继续吧|继续生成|开始吧?|直接开始|开始生成|接着(做|来|干)吧?|按你(说|建议)的(做|来)?吧?|就这样(做|办)吧?|go|go ahead|go on|do it|proceed|continue|carry on|keep going|start(?: it)?)$/i.test(g);
}

/** 纯应答/确认词（"好的/可以/嗯/ok/sure"）——【有歧义】：可能是授权推进，也可能只是附和你上一段
 *  分析。绝不用正则替 AI 拍板它是哪种（那正是用户铁律禁止的「用 regex 理解用户自然语言」）——
 *  交给意图门 LLM 结合上下文判断。此函数只用于把它们【从确定性快路径里排除】。 */
export function isBareAffirmative(goal: string): boolean {
  const g = goal.trim().replace(/[。．.!！~～\s]+$/g, "");
  return g.length > 0 && g.length <= 12 && /^(好的?|行了?|是的?|对的?|可以|没问题|同意|确认|嗯+|ok|okay|yes(?: please)?|y|yep|yeah|sure|fine|agree|agreed|confirm(?:ed)?)$/i.test(g);
}

/** 从一行意图记录取 [类型] 标签（生成/分析/修改/提问/报告/其它）。 */
export function intentTagOf(line: string): string | undefined {
  return line.match(/\[(生成|分析|修改|提问|报告|其它|其他)\]/)?.[1];
}

/** 期望产物明确包含可运行代码/智能体/部署运行类交付 → 实质是生成型意图。
 *  用于确定性纠偏：句首带"分析"的生成请求（"请你分析，并生成能跑通的智能体"）
 *  被便宜模型判成 [分析] 时，按它自己解析出的期望产物把类型改回 [生成]。
 *
 *  例外（#BLUEPRINT）：一张【流程图/业务流/蓝图/时序图】本身是【分析】产物，不是可运行构建——
 *  即使它提到 "agent"（如"即将设计的 agents 的整体流程图"）。只有当期望产物【同时】要可运行/部署
 *  类东西时才算生成。否则画蓝图是安全的先手，用户再说"继续/生成"即授权（continue 分支已处理）。 */
export function expectsBuildDeliverable(intentLine: string): boolean {
  const m = intentLine.match(/期望产物[:：]([^\n]*)/);
  if (!m) return false;
  const d = m[1] ?? "";
  const runnable = /代码|functions?|部署|试运行|沙箱|事件链|可运行|能跑通|上线|promote/i.test(d);
  const diagramOnly = /流程图|业务流|工作流图?|时序图|泳道|蓝图|流程梳理|梳理|架构图|可视化|diagram|flow ?chart|blueprint/i.test(d) && !runnable;
  if (diagramOnly) return false;
  return runnable || /智能体|agent/i.test(d);
}

/** Parse the user's goal into a structured intent line, APPENDED to any prior intent so a
 *  conversation's intent history accumulates (fold-surviving via ctx.userIntent). Fail-safe:
 *  returns prior intent + raw goal on any LLM failure — the gate must never block a run. */
export async function parseUserIntent(
  goal: string,
  priorIntent: string | undefined,
  opts?: { llm?: SpecialistLlm },
): Promise<string> {
  const llm: SpecialistLlm = opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 400, purpose: o?.purpose, models: specialistModels() }));
  const raw = goal.trim();
  const appendRaw = () => (priorIntent ? `${priorIntent}\n+ 追加：${raw.slice(0, 200)}` : `目标原文：${raw.slice(0, 240)}`);
  if (!raw) return priorIntent ?? "";
  // #INTENT-CONTINUE — 只有【明确表意推进】的短语（继续/开始生成/接着做）才走确定性快路径延续既定
  // 目标，且只在能【确信延续的是什么类型】时才走。真实事故：旧版把纯应答词（好的/ok/可以）也当
  // continue，命中后【绕过 LLM 意图门】，且无标签时兜底成 [生成]——于是「AI 分析完，用户回『好的』
  // （=我知道了）」被判成授权生成、一路跑到真实沙箱部署，直接违背 system-prompt「没明说生成就别启动」。
  // 现在：纯应答词交回 LLM 意图门（它有 priorIntent 上下文，能判"这是授权还是附和"）；且【绝不】把
  // "判不出类型"兜底成风险最高的 [生成]。
  if (priorIntent && isExplicitProceed(raw)) {
    const last = priorIntent.split("\n").filter(Boolean).pop() ?? "";
    const priorKind = expectsBuildDeliverable(last) ? "生成" : intentTagOf(last);
    if (priorKind) {
      const goalText = (last.replace(/^\+?\s*/, "").replace(/^\[[^\]]*\]\s*/, "").split(/[｜|]/)[0] ?? "").trim();
      return `${priorIntent}\n+ [${priorKind}] 继续推进既定目标（用户确认继续）：${goalText.slice(0, 160)} ｜ 约束: 延续此前 ｜ 期望产物: 延续此前`;
    }
    // priorIntent 无可辨类型（多半来自 LLM 失败时的降级降级原文）——不猜"生成"，落到下面让 LLM 判。
  }
  try {
    const text = await llm(
      `把用户这句话解析成一行意图记录，格式固定：\n[类型] 一句话目标 ｜ 约束: …；… ｜ 期望产物: …\n类型从 生成/分析/修改/提问/报告/其它 中选一个。约束与期望产物没有就写 无。只输出这一行，不解释。\n类型判定规则（按优先级）：\n1. 只要用户要求产出/构建/生成/部署可运行的智能体、agent、代码，或要求试运行/沙箱/事件链验证——即使句中也有"分析/理解/看看"——一律 [生成]（分析只是生成的前置步骤）。\n2. [修改] = 已有生成成果，要求改其中某些。\n3. [报告] = 主产物是分析报告文档（HTML/PDF），不要求可运行代码。\n4. [分析] = 只要求解读/评估/答疑，不要求任何构建产物。\n5. 用户输入是简短的应答/确认词（好的/可以/嗯/是的/ok/sure 等）时：结合【此前意图】判断——只有当上一轮【明确在提议开始生成/部署】、用户这是在授权，才判被授权动作的类型（通常 [生成]）；若上一轮只是分析/答疑、用户多半只是在【附和或表示知道了】，就【沿用上一条的类型】或判 [其它]，绝不擅自升级成 [生成]。拿不准时【不要】默认 [生成]。\n例："分析这些 action 并生成能跑通的智能体" → [生成]；"帮我理解这个本体" → [分析]；（上一轮=分析本体）用户回"好的" → [其它]（附和，非授权生成）；（上一轮=AI 问"要现在开始生成吗"）用户回"好的" → [生成]（授权）。`,
      priorIntent ? `（此前意图：${priorIntent.slice(-400)}）\n用户新输入：${raw.slice(0, 1200)}` : `用户输入：${raw.slice(0, 1200)}`,
      { maxTokens: 400, purpose: "specialist:intent" },
    );
    let line = text.trim().split("\n")[0]?.trim();
    if (!line || line.length < 4) return appendRaw();
    // 确定性纠偏：模型判了 [分析] 但它自己解析出的期望产物是代码/可运行智能体 → 实质是 [生成]。
    if (/\[分析\]/.test(line) && expectsBuildDeliverable(line)) line = line.replace("[分析]", "[生成]");
    return priorIntent ? `${priorIntent}\n+ ${line}` : line;
  } catch {
    return appendRaw();
  }
}
