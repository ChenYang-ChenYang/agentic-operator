// #REASONING-KERNEL — the real execution of reasoning methods (2026-07-14).
//
// Before this module the factory's "reasoning strategy" was a DECLARATION only: select_strategy parsed
// a plan (e.g. "tot→debate→reflection"), broadcast it to the UI, and returned a label — while the actual
// control flow stayed a single monolithic ReAct loop. The user's requirement: reasoning must NOT default
// to ReAct; the method (or a COMBINATION) chosen for an intent/subproblem must actually EXECUTE, and a
// combo must run its steps in order, threading each step's output into the next.
//
// This module turns each method into a real, distinct LLM control flow, and runReasoning() executes a
// StrategyPlan (single or combo) for real:
//   cot        → one continuous scratchpad pass → conclusion (cheapest; pure analysis/answer)
//   reflection → draft → self-critique → targeted rewrite (rework / quality lock)
//   debate     → N independent proposers (parallel) + 1 judge synthesis (high-stakes arbitration/review)
//   tot        → K divergent branches (parallel) + score → prune/merge best (wide design spaces)
//   react      → an "observe→decide next concrete actions" planning pass (react as a combo step; the
//                AMBIENT tool loop remains the conductor's — a lone `react` needs no kernel run)
//
// Pure + injectable (llm defaults to chatOnce; tests pass a fake) — no provider calls in unit tests.
// Every real LLM call is counted + capped (budget guard) and can be charged to the shared tree ledger.

import { chatOnce } from "./stream-gateway";
import { modelChain, type ModelTier } from "./model-router";
import type { BrainEvent } from "./brain-types";
import type { StrategyPlan } from "./reasoning-policy";

// #ROLE-TIER (P0-2) — kernel roles are cost-routed: EXPLORE roles (debate proposers, tot branches —
// many parallel, diversity over polish) default to the fast chain; SYNTH roles (judge, merge, rewrite,
// cot conclusion) default to the standard chain. Env-overridable; an injected llm bypasses all of this.
const KERNEL_EXPLORE = /kernel:(?:debate\.p|tot\.b)\d+$/;
export const KERNEL_TIERS = ["fast", "default", "hard", "review"] as const;
/** 把任意输入收敛成合法档位（AI 传的字符串、env、都走这里）。非法 → undefined（回落默认）。 */
export function asModelTier(raw: unknown): ModelTier | undefined {
  const v = typeof raw === "string" ? raw.trim() : "";
  return KERNEL_TIERS.find((t) => t === v);
}
function kernelTier(env: string | undefined, fallback: ModelTier): ModelTier {
  return asModelTier(env) ?? fallback;
}
// #KERNEL-TIER-AI — 档位优先级：【AI 显式请求】 > 部署 env > 角色默认。
// 之前档位【只】由角色名正则决定：AI 判断"这题解空间大"选了 tot，3 条分叉却全跑 fast 链——
// 贵策略花了钱却没买到脑子（剪枝者再强也只能在弱模型产出的平庸候选里挑）。debate 同理：
// AI 为高风险裁决选 debate，三位论证者全 fast，评委在 default 档综合三份低质论证。
// 现在 AI 选策略时可以一并说"这次用多强的脑子"；不表态才回落 env / 角色默认（旧行为不变）。
function kernelModelsFor(purpose: string | undefined, requested?: { explore?: ModelTier; synth?: ModelTier }): string[] {
  const isExplore = KERNEL_EXPLORE.test(purpose ?? "");
  const tier = isExplore
    ? requested?.explore ?? kernelTier(process.env.FACTORY_KERNEL_EXPLORE_TIER, "fast")
    : requested?.synth ?? kernelTier(process.env.FACTORY_KERNEL_SYNTH_TIER, "default");
  return modelChain(tier);
}

// #KERNEL-BUDGET — per-call output budgets scale from ONE knob. FACTORY_KERNEL_MAX_TOKENS sets the
// LARGEST role budget (final synthesis: reflection.rewrite / tot.merge); every other role keeps its
// deliberate ratio (critique/proposers cheaper than synthesis). Read per call so tests/env can adjust
// at runtime. Clamped 256..32000; default 1800 (raised 2026-07-17 from the original 1100-top scale).
function kernelTokenBase(): number {
  const raw = Number(process.env.FACTORY_KERNEL_MAX_TOKENS);
  if (!Number.isFinite(raw) || raw < 256) return 1800;
  return Math.min(Math.round(raw), 32_000);
}
const kernelTokens = (ratio: number): number => Math.round(kernelTokenBase() * ratio);

/** What one kernel LLM call charges the shared tree budget ledger: the configured output budget plus
 * a small prompt-overhead estimate. Call sites use this instead of a stale flat constant so raising
 * FACTORY_KERNEL_MAX_TOKENS keeps the ledger (and its low-budget thresholds) honest. */
export function kernelTokenCharge(): number {
  return kernelTokenBase() + 400;
}

export type KernelLlm = (system: string, user: string, opts?: { maxTokens?: number; temperature?: number; purpose?: string }) => Promise<string>;

// #KERNEL-WINDOW — the kernel's prompt windows were bare literals inside baseUser()/reflection(), so a
// caller had no way to know how much of what it handed over the model would actually SEE. They are named
// here and overridable PER CALL (ReasoningInput.limits) so a caller that needs a wider window can ask for
// one AND can compute what was dropped. Defaults are the historical literals — untouched behaviour for
// every caller that does not opt in.
export const KERNEL_CONTEXT_CHARS_DEFAULT = 12_000;
export const KERNEL_DRAFT_CHARS_DEFAULT = 8_000;
export const KERNEL_CRITIQUE_CHARS_DEFAULT = 4_000;

/** Prompt windows for ONE reasoning run. Omitted fields keep the module defaults. */
export interface ReasoningLimits {
  contextChars?: number;
  draftChars?: number;
  critiqueChars?: number;
}

export interface ReasoningInput {
  /** the question / decision to reason about (one line). */
  subproblem: string;
  /** background the reasoning may use (ontology digest, specs, prior findings). */
  context?: string;
  /** optional seed / prior output — combo threading feeds the previous step's output in here. */
  draft?: string;
  /** #KERNEL-WINDOW — how much of `context` / `draft` the model is allowed to see. */
  limits?: ReasoningLimits;
}

const contextChars = (input: ReasoningInput): number =>
  input.limits?.contextChars ?? KERNEL_CONTEXT_CHARS_DEFAULT;
const draftChars = (input: ReasoningInput): number =>
  input.limits?.draftChars ?? KERNEL_DRAFT_CHARS_DEFAULT;
const critiqueChars = (input: ReasoningInput): number =>
  input.limits?.critiqueChars ?? KERNEL_CRITIQUE_CHARS_DEFAULT;

export interface ReasoningStepResult {
  strategy: string;
  output: string;
  meta?: Record<string, unknown>;
}

export interface ReasoningResult {
  final: string;
  steps: ReasoningStepResult[];
  llmCalls: number;
}

export interface KernelOpts {
  llm?: KernelLlm;
  emit?: (e: BrainEvent) => void;
  signal?: AbortSignal;
  forAgent?: string;
  /** K for tot/debate fan-out (default 3, clamped 2..5). */
  branches?: number;
  /** hard cap on real LLM calls across the WHOLE plan (budget guard; default 12). */
  maxLlmCalls?: number;
  /** called once per real LLM call so a caller can charge the shared budget ledger. */
  onLlmCall?: () => void;
  /**
   * #KERNEL-SUBSTEP — called once per real INTERNAL call, the moment it RETURNS.
   *
   * `emit` only fires when a whole METHOD returns, and a method is not one call:
   * reflection is draft→critique→rewrite (3 serial calls), debate/tot are a
   * fan-out plus two serial rounds. A conversation surface that reports progress
   * per method therefore shows nothing for the whole interior of a method — the
   * measured symptom was a 3004ms gap with no frame in it. This is the hook that
   * makes the interior reportable, and it fires AFTER the provider resolved, so
   * a frame built from it still describes work that really finished. It is never
   * a heartbeat: no call, no callback.
   */
  onSubStep?: (step: {
    /** The method this internal call belongs to (cot / reflection / …). */
    strategy: string;
    /** Which internal role finished (draft / critique / rewrite / judge / …). */
    phase: string;
    /** 0-based position among the internal calls this run has completed —
     *  same base as `reasoning.step.index`, so one renderer serves both. */
    ordinal: number;
    output: string;
  }) => void;
  /** #KERNEL-ATTRIBUTION — the model that actually SERVED a kernel call (post-fallback), reported per
   *  call so a caller's receipt can attribute kernel spend the same way it attributes its own turns.
   *  Only the DEFAULT transport can report this: an injected `llm` is the caller's own transport and the
   *  kernel will not invent a model name for it. */
  onServedModel?: (model: string) => void;
  /** #KERNEL-TIER-AI — AI 为【这一次】推理点的模型档位（它比任何静态规则更清楚这个子问题多难）。
   *  explore = tot 分叉 / debate 论证者（发散）；synth = merge / judge / rewrite / cot 结论（收敛）。
   *  不传 → 回落 env → 回落角色默认（fast/default）。刻意做成【一次性、不粘】：粘性档位正是
   *  tierForContext 修过的 one-way-ratchet bug 的成因。 */
  exploreTier?: ModelTier;
  synthTier?: ModelTier;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…（截断）` : s);

function baseUser(input: ReasoningInput): string {
  return [
    `子问题：${input.subproblem}`,
    input.context ? `\n【背景】\n${clip(input.context, contextChars(input))}` : "",
    input.draft ? `\n【已有草稿/上一步产出】\n${clip(input.draft, draftChars(input))}` : "",
  ].filter(Boolean).join("\n");
}

/** Tolerant "score: N" extraction for tot branch self-scores. */
function extractScore(text: string): number {
  const m = text.match(/(?:score|评分|打分)\s*[:：=]?\s*(\d{1,3})/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
}

async function runParallel<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

/** #CLEAN-ANSWER — the cot primitive is prompted to end with 【明确结论】<answer>. When a deliberated
 * cot output becomes a USER-FACING message, we want ONLY that conclusion — the scratchpad before it
 * belongs in the (foldable) reasoning.step, not the message card. Splits on the LAST 明确结论 marker
 * (bracketed 【明确结论】, or a markdown heading / bold form). Returns null when there is no usable
 * split (caller keeps the full text — an answer is never lost). Pure + deterministic. */
export function extractCotConclusion(final: string): { reasoning: string; conclusion: string } | null {
  const text = final.trim();
  if (!text) return null;
  const patterns = [
    /【\s*明确结论\s*】\s*[：:]?/g,
    /(?:^|\n)[>#*\s]*明确结论[*\s]*[：:]\s*/g,
  ];
  let cut = -1;
  for (const re of patterns) {
    for (let m = re.exec(text); m; m = re.exec(text)) cut = Math.max(cut, m.index + m[0].length);
  }
  if (cut < 0) return null;
  const conclusion = text.slice(cut).trim();
  // a trailing bare marker with no real conclusion is a mis-parse — keep the whole text.
  if (conclusion.length < 10) return null;
  const reasoning = text.slice(0, cut).replace(/[【\s]*明确结论[】\s]*[：:]?\s*$/, "").trim();
  return { reasoning, conclusion };
}

// ── the five primitives ─────────────────────────────────────────────────────────────────────

async function cot(input: ReasoningInput, call: KernelLlm): Promise<ReasoningStepResult> {
  const output = await call(
    "你用一段连续、结构化的推理（step by step）解决这个子问题：先把关键前提/约束理清，再逐步推导，最后给出【明确结论】。不调用任何工具，只输出推理与结论。",
    baseUser(input),
    { maxTokens: kernelTokens(0.9), temperature: 0.2, purpose: "kernel:cot" },
  );
  return { strategy: "cot", output: output.trim() };
}

async function reflection(input: ReasoningInput, call: KernelLlm): Promise<ReasoningStepResult> {
  // draft → self-critique → targeted rewrite. If a draft was threaded in, skip the initial draft.
  const draft = input.draft?.trim()
    ? input.draft.trim()
    : (await call("先给出这个子问题的一版直接答案/方案（简洁，可被批评）。", baseUser(input), { maxTokens: kernelTokens(0.8), temperature: 0.3, purpose: "kernel:reflection.draft" })).trim();
  const critique = (await call(
    "你是严格的自评者。只列出下面这版产出的【具体缺陷/风险/遗漏/未满足的约束】——逐条、可定位；确实没问题就写「无重大问题」。不要重写，只批评。",
    `${baseUser({ ...input, draft: undefined })}\n\n【待评产出】\n${clip(draft, draftChars(input))}`,
    { maxTokens: kernelTokens(0.65), temperature: 0.2, purpose: "kernel:reflection.critique" },
  )).trim();
  const rewrite = (await call(
    "根据自评做【定点重写】：只修被批评到的地方，保留其余；产出最终版（完整、可直接使用）。",
    `${baseUser({ ...input, draft: undefined })}\n\n【原产出】\n${clip(draft, draftChars(input))}\n\n【自评】\n${clip(critique, critiqueChars(input))}`,
    { maxTokens: kernelTokens(1), temperature: 0.2, purpose: "kernel:reflection.rewrite" },
  )).trim();
  return { strategy: "reflection", output: rewrite, meta: { critique } };
}

async function debate(input: ReasoningInput, call: KernelLlm, branches: number): Promise<ReasoningStepResult> {
  const stances = ["支持方：论证这个方案/答案成立的最强理由", "反对方：论证它不成立或有重大风险的最强理由", "中立评估：权衡两边，指出决定性因素"];
  const proposals = await runParallel(branches, (i) =>
    call(
      `你是一场结构化论证中的一方（${stances[i % stances.length]}）。给出你这一方最有力的论证与结论，尽量与他人角度不同。`,
      baseUser(input),
      { maxTokens: kernelTokens(0.65), temperature: 0.5, purpose: `kernel:debate.p${i}` },
    ).then((t) => t.trim()),
  );
  const verdict = (await call(
    "你是评委。读完各方论证后，做出【裁决】：哪一方更成立、为什么，给出综合后的最终结论（不要复读各方，直接给可执行结论 + 关键依据）。",
    `${baseUser({ ...input, draft: undefined })}\n\n${proposals.map((p, i) => `【论证方 ${i + 1}】\n${p}`).join("\n\n")}`,
    { maxTokens: kernelTokens(0.9), temperature: 0.2, purpose: "kernel:debate.judge" },
  )).trim();
  return { strategy: "debate", output: verdict, meta: { proposals } };
}

async function tot(input: ReasoningInput, call: KernelLlm, branches: number): Promise<ReasoningStepResult> {
  const raw = await runParallel(branches, (i) =>
    call(
      `你是思维树的一个分支（探索第 ${i + 1} 种【明显不同】的思路/分解方式）。给出这条思路的候选方案，并在最后一行自评：score: <0-100>（这条思路成功的把握），再补一句关键理由。`,
      baseUser(input),
      { maxTokens: kernelTokens(0.75), temperature: 0.7, purpose: `kernel:tot.b${i}` },
    ).then((t) => ({ text: t.trim(), score: extractScore(t) })),
  );
  const ranked = raw.map((b, i) => ({ ...b, i })).sort((a, b) => b.score - a.score);
  const merged = (await call(
    "你是剪枝/综合者。下面是多条思路（带自评分）。选出最有希望的一条为主线，并把其它思路里确实更优的要素并入，给出【最终方案】（完整、可直接使用；说明为何这样取舍）。",
    `${baseUser({ ...input, draft: undefined })}\n\n${ranked.map((b) => `【思路 ${b.i + 1} · 自评 ${b.score}】\n${b.text}`).join("\n\n")}`,
    { maxTokens: kernelTokens(1), temperature: 0.2, purpose: "kernel:tot.merge" },
  )).trim();
  return { strategy: "tot", output: merged, meta: { scores: raw.map((b) => b.score) } };
}

async function reactPlan(input: ReasoningInput, call: KernelLlm): Promise<ReasoningStepResult> {
  // react-as-a-combo-step: deliberate the next concrete tool actions (observe→act). The AMBIENT ReAct
  // tool loop stays the conductor's; this only plans it, so a combo like "tot→react" can hand a concrete
  // action plan back to the main loop.
  const output = await call(
    "把这个子问题转成接下来要在【工具循环】里执行的具体动作序列（观察→行动→再观察）：列出有序步骤，每步说清用什么工具/查什么/预期产出与判断。输出一个可直接执行的下一步计划。",
    baseUser(input),
    { maxTokens: kernelTokens(0.8), temperature: 0.3, purpose: "kernel:react.plan" },
  );
  return { strategy: "react", output: output.trim(), meta: { ambient: false } };
}

async function runOne(strategy: string, input: ReasoningInput, call: KernelLlm, branches: number): Promise<ReasoningStepResult> {
  switch (strategy) {
    case "cot": return cot(input, call);
    case "reflection": return reflection(input, call);
    case "debate": return debate(input, call, branches);
    case "tot": return tot(input, call, branches);
    case "react": return reactPlan(input, call);
    // #OPEN-VOCAB — an unrecognized method degrades to a plain cot pass (safe generic deliberation),
    // but keeps its declared name in the step so telemetry shows what was asked for.
    default: return cot(input, call).then((r) => ({ ...r, strategy, meta: { degradedFrom: strategy } }));
  }
}

/**
 * Execute a StrategyPlan for real. single = run the one method; combo = run each step in order,
 * threading the previous step's output into the next (tot generates → debate arbitrates → reflection
 * polishes). Emits one reasoning.step per executed method. Degrades per-step (a failed method keeps the
 * carry so a combo doesn't abort). A lone `react` is the AMBIENT loop, so it is NOT executed here —
 * runReasoning returns `ambientReactOnly:true` in that case (caller keeps the conductor's tool loop).
 */
export async function runReasoning(input: ReasoningInput, plan: StrategyPlan, opts: KernelOpts = {}): Promise<ReasoningResult & { ambientReactOnly: boolean }> {
  const branches = Math.max(2, Math.min(opts.branches ?? 3, 5));
  const maxCalls = Math.max(1, opts.maxLlmCalls ?? 12);
  let calls = 0;
  const requestedTiers = { explore: opts.exploreTier, synth: opts.synthTier };
  const baseLlm: KernelLlm = opts.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? kernelTokens(0.8), temperature: o?.temperature, purpose: o?.purpose, signal: opts.signal, models: kernelModelsFor(o?.purpose, requestedTiers), ...(opts.onServedModel ? { onModel: opts.onServedModel } : {}) }));
  // #KERNEL-SUBSTEP — one interception point covers EVERY primitive, because every
  // primitive gets its provider access through this one wrapper. `purpose` is already
  // "kernel:<method>.<role>" at each call site, so the sub-step's identity is read from
  // the call itself rather than re-declared (and re-desynchronised) per primitive.
  let subStepOrdinal = 0;
  const call: KernelLlm = async (s, u, o) => {
    if (opts.signal?.aborted) throw new Error("aborted");
    if (calls >= maxCalls) throw new Error(`reasoning kernel 调用已达上限 ${maxCalls}`);
    calls += 1;
    opts.onLlmCall?.();
    const output = await baseLlm(s, u, o);
    if (opts.onSubStep) {
      const purpose = (o?.purpose ?? "").replace(/^kernel:/, "");
      const [strategy, phase] = purpose.split(".");
      opts.onSubStep({
        strategy: strategy || "?",
        phase: phase || strategy || "?",
        ordinal: subStepOrdinal,
        output: clip(output.trim(), 4000),
      });
      subStepOrdinal += 1;
    }
    return output;
  };

  const executable = plan.steps.map((s) => String(s.strategy).toLowerCase());
  // A single ambient `react` needs no kernel execution — the conductor's tool loop IS react.
  if (executable.length === 1 && executable[0] === "react") {
    return { final: input.draft ?? "", steps: [], llmCalls: 0, ambientReactOnly: true };
  }

  const steps: ReasoningStepResult[] = [];
  let carry = input.draft;
  const total = executable.length;
  for (let i = 0; i < executable.length; i++) {
    const strategy = executable[i]!;
    let result: ReasoningStepResult;
    try {
      result = await runOne(strategy, { ...input, draft: carry }, call, branches);
    } catch (e) {
      result = { strategy, output: carry ?? "", meta: { error: (e as Error).message?.slice(0, 200) } };
    }
    steps.push(result);
    if (result.output) carry = result.output;
    opts.emit?.({
      t: "reasoning.step",
      strategy,
      index: i,
      total,
      output: clip(result.output, 4000),
      ...(opts.forAgent ? { forAgent: opts.forAgent } : {}),
      ...(result.meta ? { meta: result.meta } : {}),
    });
  }
  return { final: carry ?? "", steps, llmCalls: calls, ambientReactOnly: false };
}
