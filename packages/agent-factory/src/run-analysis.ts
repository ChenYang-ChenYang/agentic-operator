// #6 — whole-run analyzer. Reads a run's FULL event stream — the brain's actual thinking prose,
// every tool call WITH its input + complete output, the code it wrote, validation issues, refine
// critiques + per-round score moves, reverts, clarifications, the sandbox outcome, errors — builds
// a faithful narrative digest, and has an LLM review it: a 0–100 score + per-round breakdown +
// strengths / problems / suggestions, so the user can see exactly what happened and what to fix
// each run. The digest + per-round derivation are pure + testable; the LLM critique degrades to a
// digest-only result when no gateway is configured.

import type { BrainEvent } from "./brain-types";
import {
  chatJson,
  hasFactoryModelAdapter,
  isGatewayConfigured,
} from "./stream-gateway";
import { modelChain } from "./model-router";
import { detectLang, resolveBrainLang } from "./i18n";

export interface ScoreRound {
  agent: string;
  attempt: number;
  prior: number;
  next: number;
  delta: number;
  regression: boolean;
}

export interface RunReview {
  scored: boolean;
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
  suggestions: string[];
  /** deterministic per-refine-round score moves (from score.delta events) */
  rounds: ScoreRound[];
  /** the model that produced the critique (or "" when digest-only) */
  model: string;
  digest: string;
}

const g = (e: BrainEvent, k: string) => (e as unknown as Record<string, unknown>)[k];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// Per-segment caps (chars). Generous — the critique runs on the HARD tier (large context), so the
// reviewer sees the real reasoning/code/output, not a tally. Whole-digest cap is the backstop.
const THOUGHT_CAP = Number(process.env.FACTORY_REVIEW_THOUGHT_CAP) || 1500;
const OUTPUT_CAP = Number(process.env.FACTORY_REVIEW_OUTPUT_CAP) || 1600;
const CODE_CAP = Number(process.env.FACTORY_REVIEW_CODE_CAP) || 2000;
const CRITIQUE_CAP = Number(process.env.FACTORY_REVIEW_CRITIQUE_CAP) || 800;
const DIGEST_CAP = Number(process.env.FACTORY_REVIEW_DIGEST_CAP) || 120000;

function dimsStr(d: unknown): string {
  if (!d || typeof d !== "object") return "";
  const o = d as Record<string, unknown>;
  const parts = Object.entries(o)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

/** Deterministic per-refine-round score moves, keyed per agent (attempt 1,2,3…). The data the
 *  per-round view + the critic's round-by-round comments are grounded in. Pure. */
export function scoreRounds(events: BrainEvent[]): ScoreRound[] {
  const attempts = new Map<string, number>();
  const rounds: ScoreRound[] = [];
  for (const e of events) {
    if (e.t !== "score.delta") continue;
    const agent = String(g(e, "actionName") ?? "");
    const attempt = (attempts.get(agent) ?? 0) + 1;
    attempts.set(agent, attempt);
    rounds.push({
      agent,
      attempt,
      prior: Number(g(e, "priorTotal") ?? 0),
      next: Number(g(e, "newTotal") ?? 0),
      delta: Number(g(e, "delta") ?? 0),
      regression: Boolean(g(e, "regression")),
    });
  }
  return rounds;
}

/** A faithful, human-readable narrative of everything the run did — the input to the critic. Pure.
 *  Unlike the old tally, this carries the brain's actual thinking text, full tool I/O, written code,
 *  and refine critiques, so the reviewer can judge reasoning + code quality, not just event counts. */
export function runDigest(events: BrainEvent[]): string {
  const lines: string[] = [];
  let think = 0,
    tools = 0,
    toolFails = 0,
    refines = 0,
    clarifies = 0;
  let thoughtBuf = "";
  const flushThought = () => {
    const t = thoughtBuf.trim();
    // Count flushed thought BLOCKS, not raw stream deltas — a single reasoning block arrives as
    // hundreds of `think` deltas, so counting deltas inflated "N 段思考" by orders of magnitude.
    if (t) { lines.push(`💭 思考: ${clip(t, THOUGHT_CAP)}`); think++; }
    thoughtBuf = "";
  };
  for (const e of events) {
    if (e.t === "think") {
      thoughtBuf += String(g(e, "delta") ?? "");
      continue;
    }
    flushThought();
    switch (e.t) {
      case "model": {
        // 难度档没被满足是【降级】，必须写进叙事让质检评审员看得见——否则
        // 「hard 档任务被 flash 跑了」和「hard 档任务被 hard 模型跑了」在这份
        // 报告里长得一模一样。
        const unmet =
          g(e, "preferenceSatisfied") === false
            ? `｜⚠ 难度档未满足: ${String(g(e, "preferenceReason") ?? "未给出原因")}`
            : "";
        lines.push(
          `🧠 模型 ${String(g(e, "model") ?? "")} (${String(g(e, "tier") ?? "")} 档)${unmet}`,
        );
        break;
      }
      case "message":
        lines.push(`🗣 大脑: ${clip(String(g(e, "text") ?? ""), THOUGHT_CAP)}`);
        break;
      case "tool.call":
        tools++;
        lines.push(
          `🔧 调用 ${String(g(e, "name"))}｜理由: ${clip(String(g(e, "reasoning") ?? ""), 400)}` +
            (g(e, "input") !== undefined ? `\n   输入: ${clip(JSON.stringify(g(e, "input")), 700)}` : ""),
        );
        break;
      case "tool.result": {
        const ok = g(e, "ok");
        if (!ok) toolFails++;
        const out = String(g(e, "output") ?? g(e, "summary") ?? "");
        lines.push(`   ${ok ? "✓ 结果" : "✗ 失败"}: ${clip(out, OUTPUT_CAP)}`);
        break;
      }
      case "plan":
        lines.push(`🗺 规划: ${clip(String((g(e, "plan") as Record<string, unknown>)?.summary ?? ""), 600)}`);
        break;
      case "agent.created":
        lines.push(`🤖 设计 agent ${String((g(e, "spec") as Record<string, unknown>)?.actionName ?? "")}`);
        break;
      case "code":
        lines.push(
          `📝 写代码 ${String(g(e, "actionName"))} (${String(g(e, "codeSource"))}):\n${clip(String(g(e, "code") ?? ""), CODE_CAP)}`,
        );
        break;
      case "validation":
        lines.push(`🔎 校验: ${g(e, "ok") ? "闭合 ✓" : "未闭合 — " + ((g(e, "issues") as string[]) ?? []).join("；")}`);
        break;
      case "refine":
        refines++;
        lines.push(`♻ 精修 ${String(g(e, "actionName"))}: ${clip(String(g(e, "critique") ?? ""), CRITIQUE_CAP)}`);
        break;
      case "score.delta":
        lines.push(
          `📊 评分 ${String(g(e, "actionName"))}: ${g(e, "priorTotal")}→${g(e, "newTotal")}${g(e, "regression") ? " (退步)" : ""}${dimsStr(g(e, "dimensions"))}`,
        );
        break;
      case "revert":
        lines.push(`⏪ 回滚 ${String(g(e, "actionName"))}`);
        break;
      case "clarify":
        clarifies++;
        lines.push(`❓ 询问用户: ${clip(String(g(e, "question") ?? ""), 300)}`);
        break;
      case "compaction":
        lines.push(`🗜 上下文自动压缩`);
        break;
      case "sandbox":
        lines.push(
          `🧪 沙箱: 部署 ${g(e, "functionsRegistered") ?? 0}·跑 ${g(e, "ran") ?? 0}·${g(e, "fullChainRan") ? "通" : "未通"}${g(e, "simulated") ? " (模拟)" : " (真实)"}`,
        );
        break;
      case "error":
        lines.push(`⛔ 错误: ${clip(String(g(e, "message") ?? ""), 400)}`);
        break;
      case "done":
        lines.push(`🏁 结束: ${String(g(e, "status"))}`);
        break;
    }
  }
  flushThought();
  const rounds = scoreRounds(events);
  const roundsLine = rounds.length
    ? `\n逐轮评分: ${rounds.map((r) => `${r.agent}#${r.attempt} ${r.prior}→${r.next}(${r.delta >= 0 ? "+" : ""}${r.delta}${r.regression ? "↓" : ""})`).join(" · ")}`
    : "";
  const head = `本次运行概览: ${think} 段思考 · ${tools} 次工具调用(${toolFails} 失败) · ${refines} 次精修 · ${clarifies} 次询问用户${roundsLine}`;
  return `${head}\n\n=== 完整活动叙事 ===\n${lines.join("\n")}`.slice(0, DIGEST_CAP);
}

const FALLBACK = (digest: string, rounds: ScoreRound[]): RunReview => ({
  scored: false,
  score: 0,
  summary: "（无 LLM 网关，仅给出活动叙事与逐轮评分，未做 AI 评审）",
  strengths: [],
  problems: [],
  suggestions: [],
  rounds,
  model: "",
  digest,
});

/** LLM critique of a run. Returns a score + per-round breakdown + structured findings; degrades to
 *  digest-only. */
export async function analyzeRun(events: BrainEvent[], opts: { signal?: AbortSignal; domain?: string } = {}): Promise<RunReview> {
  const digest = runDigest(events);
  const rounds = scoreRounds(events);
  if (!isGatewayConfigured()) return FALLBACK(digest, rounds);
  // #15: prefer the run's resolved language (from its domain) over detecting from the digest —
  // the digest's fixed Chinese scaffolding labels can flip a short English run's detection to zh.
  const lang = opts.domain ? resolveBrainLang(opts.domain) : detectLang(digest);
  const sys =
    lang === "en"
      ? "You are the SENIOR QA REVIEWER of an Agent-Factory run. Below is the FULL narrative of an 'generate agents from an ontology' run — the brain's real thinking, every tool call's input + complete output, the code it wrote, validation issues, each refine round's critique + score change, reverts, clarifications, the real/simulated sandbox result, errors. Review each phase (read ontology → plan → design → validate → sandbox → deliver): was it grounded (no hallucination), are rules fetched dynamically at runtime, did it silently degrade, how is the code/prompt quality, did each refine round actually fix the right problem, were problems resolved sensibly or escalated to the user appropriately, did it really run (not simulated)." +
        ' Output ONLY JSON: {"score":number(0-100),"summary":string,"strengths":string[],"problems":string[],"suggestions":string[]}. problems/suggestions must be specific to a phase, action, even a round (e.g. "<agentName> refine round 2 dropped the wrong tool" — use agent/action names from THIS run). All English. No other text.'
      : "你是 Agent 工厂运行的【资深质检评审员】。下面给你的是一次「用本体生成 agents」运行的【完整活动叙事】——包含大脑真实的思考、每一次工具调用的输入与完整输出、写的代码、校验问题、每一轮精修的批评与评分变化、回滚、询问用户、沙箱真实/模拟结果、错误。请逐环节(读本体→规划→设计→校验→试运行→交付)审阅：是否接地不脑补、规则是否运行时动态抓、有没有默默降级、代码与提示质量如何、每一轮精修是否真的修对了问题、遇到问题是否合理解决或恰当询问用户、最终是否真跑通(非模拟)。" +
        '只输出 JSON：{"score":number(0-100),"summary":string,"strengths":string[],"problems":string[],"suggestions":string[]}。problems/suggestions 必须具体到环节、动作、甚至某一轮(如「<本次运行里的某个 agent> 第2轮精修把工具删错了」——用本次运行自己的 agent/action 名)。全部中文。不要任何其它文字。';
  try {
    let served = "";
    const j = await chatJson<Record<string, unknown>>(sys, digest, { temperature: 0.3, maxTokens: 6000, signal: opts.signal, models: modelChain("review"), purpose: "run_analysis", onModel: (m) => { served = m; } });
    if (!j) return FALLBACK(digest, rounds);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    return {
      scored: true,
      score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 0))),
      summary: String(j.summary ?? ""),
      strengths: arr(j.strengths),
      problems: arr(j.problems),
      suggestions: arr(j.suggestions),
      rounds,
      // #12: the model that ACTUALLY served the critique (after fallback), not just the preferred id.
      // Under the central gateway the "review" chain is a PREFERENCE PATTERN, not a model id — an
      // unserved turn reports no model rather than passing a pattern off as one.
      model:
        served ||
        (hasFactoryModelAdapter() ? "" : (modelChain("review")[0] ?? "")),
      digest,
    };
  } catch {
    return FALLBACK(digest, rounds);
  }
}
