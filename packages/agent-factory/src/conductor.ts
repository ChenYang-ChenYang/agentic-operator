// Autonomous Harness Brain — the streaming ReAct loop.
//
// Re-implemented for the new arch from the OLD lib/agent-factory-v3/brain/conductor.ts:
// it reasons (streaming think deltas), calls tools, observes, loops — until it finishes
// (passing the acceptance gate) or exhausts its budget. All infrastructure is injected
// via ctx.ports, so the same loop runs in any runtime. A configurable whole-session
// token fuse and MAX_TURNS prevent unattended runaway work; live usage is emitted.

import { streamTurn, chatOnce, isGatewayConfigured, setLlmCallContext, type ChatMsg, type ToolSchema } from "./stream-gateway";
import { systemPrompt } from "./system-prompt";
import { FACTORY_TOOLS, SUBAGENT_TOOLS, normalizeQuestion } from "./tools";
import type { BrainEvent, BrainTool, BrainCtx, ReflectionLite, BoundaryEvent, FactoryStage, BudgetLedger } from "./brain-types";
import type { FactoryPorts } from "./ports";
import { isStopIntent } from "./intent";
import { parseUserIntent, extractJson } from "./specialists";
import { buildActionBrief } from "./action-brief";
import { matchBuiltinSkills, matchLearnedSkills, renderSkillRecall } from "./builtin-skills";
import type { GeneratedAgentSpec } from "./spec-types";
import { randomUUID } from "node:crypto";
import { modelChain, tierForContext } from "./model-router";
import { classifyIntentKind, estimateDifficulty, selectPolicy, parseStrategyPlan } from "./reasoning-policy";
import { extractCotConclusion, kernelTokenCharge, runReasoning } from "./reasoning-kernel";
import { consumeIntegrationBoundaryAnswer } from "./integration-binding";
import { anchorDue, buildOntologyAnchor, DEFAULT_ANCHOR_EVERY } from "./ontology-anchor";
import { roleOfTool } from "./process-roles";
import { adjustPolicyWithStats, recordOutcome } from "./policy-learning";
import { warmModelCatalog } from "./model-catalog";
import { resolveBrainLang } from "./i18n";
import { consolidateRunMemory, digestFromMessages, renderMemoryRecall, MEMORY_RECALL_PREFIX } from "./memory-consolidation";
import { GENERAL_MEMORY_SUBJECT } from "./ports";
import { induceSkillsFromRun, kebab as kebabSkill } from "./skill-induction";
import { humanMemoryQuestionKey, renderHumanMemorySeed } from "./human-memory";
import { archiveEntriesFromDropped, archiveTruncationReport } from "./conversation-archive";
import { isSideEffectTool } from "./side-effect-tools";
import { coverageWaiverMatches, normalizeCoverageCells, parseCoverageWaiverTag } from "./coverage-waiver";
import { isTestCaseDecisionTaggedMessage, parseTestCaseDecision } from "./test-case-decision";
import { resolveClarificationTimeout } from "./clarification-policy";
import { sanitizeSensitiveInput } from "./sensitive-input";
import { assessCompleteSuite, assessIntegrationBindings } from "./acceptance";
import type { FactoryAuthorizationChallenge, FactoryHumanInteractionKind, FactoryHumanMessage } from "./authorization-challenge";
import { resolveFactorySessionTokenLimit } from "./session-budget";
import {
  estimateContextUsage,
  planProviderCall,
  recentContextStart,
  serializeToolResultForContext,
  shouldCompactContext,
} from "./context-budget";
import {
  activeHumanInteraction,
  activeHumanInteractionKind,
  bindHumanInteractionEvent,
  closeHumanInteraction,
} from "./human-interaction";
import {
  factoryGenerationDirectiveFingerprint,
  factoryGenerationScopedAgentActionNames,
  type FactoryGenerationDirective,
  type FactoryInteractionPolicy,
} from "./generation-directive";
import {
  autopilotTestApprovalBlockReason,
  recordFactoryAssumption,
  resolveFactoryConversationInteractionPolicy,
  resolveAutopilotClarification,
} from "./interaction-policy";

// ── auto-compaction ───────────────────────────────────────────────────────────
// Keep the context bounded on long runs WITHOUT turn-capping: once the transcript
// grows large, fold everything except the last few turns into a structured state
// summary re-derived from ctx (nothing the brain needs is lost — specs/plan/sandbox
// all live in ctx). No extra LLM call.
// #9c: tuning is env-overridable (different domains/budgets want different limits) — not baked in.
const envInt = (k: string, d: number): number => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

/** External SDK/model/store errors are untrusted text. Never put their raw
 * message into an SSE event, tool result or durable transcript. */
function safeDiagnostic(value: unknown, fallback = "外部依赖返回了不可显示的错误。", maxLength = 1_000): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const sanitized = sanitizeSensitiveInput(raw, "diagnostic").sanitized;
  const text = typeof sanitized === "string" ? sanitized.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function completeSuiteForContext(ctx: BrainCtx) {
  return assessCompleteSuite(ctx.lastSandbox ? {
    ...ctx.lastSandbox,
    expectedCaseIds: (ctx.testCases ?? []).map((testCase) => testCase.id),
  } : null);
}

/** A trusted Factory tool may discover a blocker only after it has inspected
 * live configuration or validated a candidate.  `next: ask_user` is therefore
 * a control-flow instruction, not prose for the model to optionally follow. */
function structuredClarification(
  result: { summary?: unknown; output?: unknown },
): {
  question: string;
  context?: string;
  options?: Array<{ label: string; value: string; recommended?: boolean }>;
} | null {
  if (!result.output || typeof result.output !== "object" || Array.isArray(result.output)) return null;
  const output = result.output as Record<string, unknown>;
  if (output.next !== "ask_user") return null;
  const explicit = typeof output.question === "string" ? output.question.trim() : "";
  const fallback = typeof result.summary === "string" ? result.summary.trim() : "";
  const question = (explicit || fallback).slice(0, 600);
  if (!question) return null;
  const details: string[] = [];
  if (typeof output.context === "string" && output.context.trim()) {
    details.push(output.context.trim().slice(0, 360));
  }
  if (typeof output.reason === "string" && output.reason.trim()) {
    details.push(`阻断原因：${output.reason.trim().slice(0, 160)}`);
  }
  if (Array.isArray(output.missing)) {
    const missing = output.missing.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8);
    if (missing.length) details.push(`还缺：${missing.join("、")}`);
  }
  const options = Array.isArray(output.options)
    ? output.options.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const row = candidate as Record<string, unknown>;
        const label = typeof row.label === "string" ? row.label.trim().slice(0, 80) : "";
        const value = typeof row.value === "string" ? row.value.trim().slice(0, 300) : "";
        if (!label || !value) return [];
        return [{ label, value, ...(row.recommended === true ? { recommended: true } : {}) }];
      }).slice(0, 6)
    : [];
  return {
    question,
    ...(details.length ? { context: details.join("；").slice(0, 500) } : {}),
    ...(options.length ? { options } : {}),
  };
}

/**
 * Extract a clarification request only from the end of a plain-text model
 * response.  A terminal question mark is unambiguous.  For punctuation-free
 * requests (for example, “请确认 …”), be deliberately conservative: the request
 * must begin a short trailing sentence/line, rather than merely appearing
 * somewhere in a report.  This keeps report prose and quoted UI labels from
 * turning into fake questions, and prevents the whole report from becoming the
 * clarification card.
 */
function trailingClarificationQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // An explicit terminal question wins.  Start after the previous sentence or
  // line boundary so a long analysis preceding it is not copied into the card.
  if (/[？?]\s*$/.test(trimmed)) {
    const beforeMark = trimmed.slice(0, -1);
    let start = -1;
    for (const boundary of ["\n", "\r", "。", "！", "!", "？", "?", "；", ";"]) {
      start = Math.max(start, beforeMark.lastIndexOf(boundary));
    }
    const question = trimmed.slice(start + 1).trim();
    return question.length >= 2 ? question.slice(0, 600) : null;
  }

  // Only inspect a bounded tail.  A cut made in the middle of a sentence is not
  // itself treated as a candidate boundary; this avoids matching a quoted
  // “请选择 …” that happened to land at the start of the tail window.
  const tailStart = Math.max(0, trimmed.length - 1_200);
  const tail = trimmed.slice(tailStart);
  const boundaryChars = new Set(["\n", "\r", "。", "！", "!", "；", ";", "：", ":"]);
  const starts: number[] = [];
  if (tailStart === 0 || boundaryChars.has(trimmed[tailStart - 1] ?? "")) starts.push(0);
  for (let index = 0; index < tail.length; index += 1) {
    if (boundaryChars.has(tail[index] ?? "")) starts.push(index + 1);
  }

  // These are language-level request forms, not domain vocabulary.  Requiring
  // them at the beginning of a trailing segment is intentionally stricter than
  // searching the whole tail for words such as “确认” or “选择”.
  const requestLead = /^(?:(?:#{1,6}|[-*>]|\d+[.)、])\s*)*(?:\*{1,2}\s*)?(?:(?:下一步|接下来|现在|最后)[，,\s]*(?:(?:请|需要)(?:你|您)?\s*)?(?:确认|选择|回复|提供|补充|指定|说明|告知|告诉|输入|决定|核对)|请(?:你|您)?\s*(?:确认|选择|回复|提供|补充|指定|说明|告知|告诉|输入|决定|核对)|请问(?:你|您)?|(?:需要|希望)(?:你|您|我)\s*(?:确认|选择|回复|提供|补充|指定|说明|告知|决定)|需要(?:你|您|我)\s*(?:怎么|如何)|(?:你|您)(?:希望|想|要)|要不要|please\s+(?:choose|confirm|specify|reply|respond|provide|tell|enter|decide)\b|(?:do\s+you\s+want|would\s+you\s+like|should\s+(?:i|we)|which\s+(?:one|option))\b)/i;

  // Work backwards so the closest request to the response end wins.  Do not
  // truncate an overlong candidate: a partial question can be more misleading
  // than no auto-park at all.
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = tail.slice(starts[index]).trim();
    if (candidate.length < 4 || candidate.length > 600) continue;
    if (requestLead.test(candidate)) return candidate;
  }
  return null;
}
function compactionConfig(): {
  trigger: { maxMessages: number; maxChars: number; maxEstimatedTokens: number };
  keep: { maxMessages: number; maxChars: number; maxEstimatedTokens: number };
} {
  const maxMessages = envInt("FACTORY_COMPACT_AT_MSGS", 40);
  const maxChars = envInt("FACTORY_COMPACT_AT_CHARS", 240_000);
  const maxEstimatedTokens = envInt(
    "FACTORY_COMPACT_AT_ESTIMATED_TOKENS",
    60_000,
  );
  return {
    trigger: { maxMessages, maxChars, maxEstimatedTokens },
    keep: {
      // Always keep strictly fewer messages than the count trigger so a
      // count-driven fold cannot grow the array.
      maxMessages: Math.min(
        envInt("FACTORY_KEEP_RECENT", 12),
        Math.max(1, maxMessages - 1),
      ),
      maxChars: Math.min(
        envInt("FACTORY_COMPACT_KEEP_CHARS", 80_000),
        Math.max(1, maxChars - 1),
      ),
      maxEstimatedTokens: Math.min(
        envInt("FACTORY_COMPACT_KEEP_ESTIMATED_TOKENS", 20_000),
        Math.max(1, maxEstimatedTokens - 1),
      ),
    },
  };
}

function buildStateSummary(ctx: BrainCtx): string {
  const lines: string[] = [`【已折叠早期对话，这是结构化状态快照】`, `域: ${ctx.domain} · 目标: ${ctx.goal}`];
  if (ctx.ontology) {
    lines.push(`本体: ${ctx.ontology.actions.length} 动作 / ${ctx.ontology.events.length} 事件 / 工具库 ${ctx.toolCatalog.length}`);
    // #3 FIX (memory): keep the real action/event NAMES inside the folded summary — counts alone
    // let the brain hallucinate forgotten symbols after compaction. Cap with a "+N" tail.
    const cap = (arr: string[], n: number) => (arr.length > n ? `${arr.slice(0, n).join("、")}…(+${arr.length - n})` : arr.join("、"));
    const agentActs = factoryGenerationScopedAgentActionNames(
      ctx.ontology,
      ctx.generationDirective,
    );
    lines.push(`本次 generation scope(只能用这些真名，别脑补) · Agent动作: ${cap(agentActs, 30)} · 事件: ${cap(ctx.ontology.events.map((e) => e.name), 40)}`);
    // #3/#4 (memory): ALSO keep DataObject + rule NAMES in the fold — object property detail and
    // rule text are recoverable via describe_object / fetchActionRules, but the NAMES must survive
    // so the brain knows what exists to recall.
    const objNames = ctx.ontology.objects.map((o) => o.name || o.id);
    if (objNames.length) lines.push(`数据对象(共${objNames.length}，字段用 describe_object 取回): ${cap(objNames, 30)}`);
    if (ctx.ontology.rules.length) {
      const ruleNames = ctx.ontology.rules.map((r) => { const ro = r as Record<string, unknown>; return String(ro.businessLogicRuleName ?? ro.name ?? ro.title ?? ro.id ?? ""); }).filter(Boolean);
      lines.push(`规则(共${ctx.ontology.rules.length}，运行时用 ontology.fetchActionRules 抓): ${ruleNames.length ? cap(ruleNames, 25) : "(按动作动态抓)"}`);
    }
  }
  if (ctx.currentPlan) lines.push(`计划 v${ctx.currentPlan.version}: ${ctx.currentPlan.summary}`);
  if (ctx.specs.length) lines.push(`已设计 ${ctx.specs.length} 个 agent: ${ctx.specs.map((s) => `${s.short}(工具${s.tools.length}${s.generatedCode ? "·有码" : ""})`).join("、")}`);
  if (ctx.lastValidation) lines.push(`上次校验: ${ctx.lastValidation.ok ? "闭合✓" : "未闭合"}`);
  if (ctx.lastSandbox) lines.push(`上次沙箱: 部署${ctx.lastSandbox.deployed}·跑${ctx.lastSandbox.agentsRan}·${completeSuiteForContext(ctx).complete ? "全套件通✓" : "未通"}`);
  if (ctx.createdSkills.length) lines.push(`本次创造技能: ${ctx.createdSkills.map((s) => s.name).join("、")}`);
  // The AI's DIGESTED understanding of the ontology (understand_ontology) is reasoning the brain
  // owes itself — keep it verbatim through a fold so the design phase still reasons over the
  // understood model after early turns compact away ("读了就忘" insurance).
  // #UNDERSTAND-FIDELITY — two honesty fixes here. (1) On the skeleton/single-hop paths this value
  // is a JSON STRING; a bare 700-char slice cut it mid-record, so the brain's fold-surviving state
  // carried syntactically broken JSON with nothing saying it was cut — mark the truncation. (2) Say
  // HOW the understanding was produced: a deterministic skeleton and a four-dimension full-coverage
  // read are not interchangeable, and the brain should know which one it is reasoning over.
  if (ctx.ontologyUnderstanding) {
    const mode = ctx.ontologyUnderstandingMode;
    const cov = ctx.ontologyUnderstandingCoverage;
    const label = mode === "deep"
      ? `四维分治深读${cov ? `·${cov.complete ? "全量覆盖" : "覆盖不完整"} ${cov.itemsAnalyzed}/${cov.itemsTotal} 项` : ""}`
      : mode === "skeleton"
        ? "确定性骨架·未经 LLM 分析"
        : mode === "shallow"
          ? "单跳理解·未做全量深读"
          : "understand_ontology";
    const body = ctx.ontologyUnderstanding.length > 1_200
      ? `${ctx.ontologyUnderstanding.slice(0, 1_200)}…（此处为摘要截断，非完整理解；需要全文请重看 understand_ontology 输出）`
      : ctx.ontologyUnderstanding;
    lines.push(`本体理解(AI 消化结论·${label}): ${body}`);
  }
  // #PERSPECTIVES — 折叠后大脑仍要知道理解里已含（或缺）哪些业务视角结论，才能判断要不要补读。
  if (ctx.ontologyPerspectives) {
    const p = ctx.ontologyPerspectives;
    lines.push(`业务视角(深读附加·${p.okCount}/${p.total} 成功${p.source === "fallback" ? "·默认三视角" : ""}): ${p.selected.map((l) => l.label).join("、")}——视角结论已并入上方本体理解`);
  }
  // The intent gate's reading of WHAT THE USER WANTS — the one thing the brain must never
  // forget, however long the run gets. Appended per goal, kept verbatim through every fold.
  if (ctx.userIntent) lines.push(`用户意图(意图门·逐条累积): ${ctx.userIntent.slice(0, 500)}`);
  // #POLICY — 折叠后大脑仍要记得"这次请求走什么路线"（analyze 别 sandbox、skinny 别全量重走）。
  if (ctx.policy) lines.push(`推理路线(前置路由): ${ctx.policy.pipeline}${ctx.policy.strategy ? `·策略 ${ctx.policy.strategy}` : ""}${ctx.policy.deepUnderstand ? "·深读" : ""}${ctx.policy.deepCritique ? "·深评" : ""}${ctx.policy.tierBias ? `·${ctx.policy.tierBias}档` : ""} — ${ctx.policy.reasons.slice(0, 2).join("；")}`);
  // capability_resolve 的选型结论（复用/组合/新造）——设计阶段的"别造重复轮子"依据。
  if (ctx.capabilityResolution) lines.push(`能力解析(选型优先于制造): ${ctx.capabilityResolution.slice(0, 600)}`);
  if (ctx.humanDirectives.length) lines.push(`人工介入指令: ${ctx.humanDirectives.join(" / ")}`);
  // Open-problems anchor (ported from old AO): the work STILL OWED, kept verbatim so it never
  // compacts away — after a fold the brain reasons from a live problem list, not just counts.
  const open: string[] = [];
  if (ctx.ontology) {
    // #SCOPE — 用户点名只做一部分时（ctx.planScope=partial），没覆盖的动作是【本意】不是欠账。
    // 旧版把整本体的未覆盖动作无条件塞进"⚠ 还没解决的问题（处理完才能 finish）"，每次折叠都
    // 重述一遍——用户只要 createJD，快照却持续宣告"你还欠 5 个"。planScope 早就存在，这里没读。
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const partial = ctx.planScope?.kind === "partial";
    const outOfScope = new Set(partial ? (ctx.planScope?.missedActions ?? []) : []);
    const agentActions = factoryGenerationScopedAgentActionNames(
      ctx.ontology,
      ctx.generationDirective,
    );
    const uncovered = agentActions.filter((n) => !done.has(n) && !outOfScope.has(n));
    if (uncovered.length) open.push(`还没设计的 Agent 动作: ${uncovered.join("、")}`);
    if (partial && outOfScope.size) {
      lines.push(`本次范围(用户指定·部分): 只做 ${agentActions.filter((n) => !outOfScope.has(n)).join("、") || "(见计划)"}${ctx.planScope?.reason ? `（${ctx.planScope.reason}）` : ""}；范围外不做: ${[...outOfScope].join("、")} —— 这是用户的本意，不是欠账，别把它们当待办。`);
    }
  }
  const degraded = ctx.specs.filter((s) => s.degraded === true).map((s) => s.actionName);
  if (degraded.length) open.push(`仍是未完成降级壳的 agent: ${degraded.join("、")}`);
  const unresolved = ctx.specs.filter((s) => (s.unresolvedTools ?? []).length).map((s) => `${s.actionName}[${s.unresolvedTools!.join(",")}]`);
  if (unresolved.length) open.push(`工具没解析的 agent: ${unresolved.join("、")}`);
  if (ctx.ontology) {
    const integrationIssues = assessIntegrationBindings(ctx.specs, ctx.ontology, false).issues;
    if (integrationIssues.length) {
      open.push(`外部执行能力未就绪: ${integrationIssues.slice(0, 5).map((issue) => `${issue.short}[${issue.requirement.system}/${issue.requirement.role}:${issue.status}]`).join("、")}${integrationIssues.length > 5 ? "…" : ""}`);
    }
  }
  if (ctx.lastValidation && !ctx.lastValidation.ok) { const bad = Object.keys(ctx.lastValidation.agentIssueMap); if (bad.length) open.push(`上次校验未闭合，问题 agent: ${bad.join("、")}`); }
  if (ctx.lastSandbox && !completeSuiteForContext(ctx).complete) open.push(`上次沙箱未证明完整套件跑通（${completeSuiteForContext(ctx).detail}）`);
  if (open.length) lines.push(`⚠ 还没解决的问题（处理完才能 finish）:\n  - ${open.join("\n  - ")}`);
  lines.push(`花费: ${ctx.spent.turns} 轮 · ${Math.round(ctx.spent.tokens / 1000)}k tokens · ${ctx.spent.sandboxRuns} 次沙箱。需要细节用 describe_object(对象字段) / read_spec / inspect_run / list_agents 取回${ctx.ports?.conversationArchive && (ctx.compactionFolds ?? 0) > 0 ? "；被折叠的对话原文（早期用户消息/推理/工具输入输出）用 recall_conversation 按关键词找回" : ""}，别凭记忆脑补。`);
  return lines.join("\n");
}

/** Tier-2 abstractive compaction (ported from old AO): a best-effort LLM pass over the dropped
 *  turns that preserves REASONING NUANCE the deterministic snapshot can't (key decisions + WHY,
 *  diagnoses, open todos, concrete names). Cheap (fast tier); falls back to "" on any error. */
async function summarizeDropped(dropped: ChatMsg[], ctx: BrainCtx): Promise<string> {
  const text = dropped
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 800) : JSON.stringify(m.content).slice(0, 400)}`)
    .join("\n")
    .slice(0, 24000);
  const sys =
    "把下面这段 Agent 工厂运行对话压成要点，只保留对【后续决策】有用的：做过的关键决策与原因、遇到的问题与诊断结论、还没解决的事、涉及的具体名字(agent/事件/工具/runId)。简洁中文要点，别复述全文，别编造。";
  return chatOnce(sys, text, { temperature: 0.2, maxTokens: 700, signal: ctx.signal, models: modelChain("fast") });
}

/** Returns true if it compacted. Folds [system, ...old] → [system, stateSummary(+narrative)] + recent. */
async function maybeCompact(messages: ChatMsg[], ctx: BrainCtx): Promise<boolean> {
  const config = compactionConfig();
  if (!shouldCompactContext(messages, config.trigger)) return false;
  const system = messages[0]!;
  const recentStart = recentContextStart(messages, config.keep);
  const dropped = messages.slice(1, recentStart);
  const recent = messages.slice(recentStart);
  // Do not split a tool-call/tool-result pair at the boundary. If the suffix
  // starts with an orphan result, fold that result with its preceding call.
  while (recent.length && recent[0]!.role === "tool") {
    dropped.push(recent.shift()!);
  }
  // A single currently-active oversized exchange cannot be dropped safely.
  // New tool results are structurally capped below, so simply defer the fold.
  if (!dropped.length) return false;
  // #CONV-ARCHIVE — persist the dropped turns VERBATIM before any fold. The summary below is lossy
  // by design; the archive is what makes the loss recoverable (recall_conversation). A configured
  // archive that fails DEFERS the fold — context grows until the write path recovers, but folded
  // conversation is never silently destroyed. No archive configured → legacy summary-only fold.
  //
  // 三种情况必须分开处理。此处原本是一个合取判断
  // `if (archive && conversationId)`，于是「配了归档但这条会话不可寻址」会
  // 悄悄落进 else 分支走宽松折叠 —— 子大脑正是这种情况（继承父进程的 ports
  // 却没有 conversationId），它的每一次折叠都在无声销毁原文。
  if (!ctx.ports.conversationArchive) {
    // 没配归档：历史行为，摘要式折叠。使用者知道自己没开归档。
  } else if (!ctx.conversationId) {
    // 配了归档却写不进去，和写失败是同一件事：推迟折叠、明说原因。
    // 上下文会继续增长，但绝不静默销毁已配置要保留的原文。
    ctx.emit({
      t: "reflect",
      kind: "compact-archive-unaddressable",
      lesson: "已配置会话归档，但这条会话没有 conversationId，原文无处可写——本次压缩已推迟，不做无归档折叠。",
    });
    return false;
  } else {
    ctx.compactionFolds = (ctx.compactionFolds ?? 0) + 1;
    const entries = archiveEntriesFromDropped(dropped, ctx.compactionFolds, Date.now());
    try {
      await ctx.ports.conversationArchive.append(ctx.conversationId, entries);
      // 折叠不可逆，所以「这次归档是有损的」必须是可见事实，而不是埋在某条
      // content 末尾的一句话。
      const lossy = archiveTruncationReport(entries);
      if (lossy.truncated > 0) {
        ctx.emit({
          t: "reflect",
          kind: "compact-archive-lossy",
          lesson: `本次归档有 ${lossy.truncated}/${entries.length} 条超过 ${lossy.cap} 字被截断——这部分原文在折叠后不可恢复。需要更完整的归档可调高 FACTORY_ARCHIVE_CONTENT_CAP。`,
        });
      }
    } catch (error) {
      ctx.compactionFolds -= 1;
      ctx.emit({ t: "reflect", kind: "compact-archive-failed", lesson: `会话归档写入失败（${(error as Error).message}）——本次压缩已推迟，折叠原文不会被静默丢弃。` });
      return false;
    }
  }
  let summaryText = buildStateSummary(ctx);
  if (process.env.FACTORY_COMPACT_ABSTRACTIVE !== "0" && isGatewayConfigured() && dropped.length > 4) {
    const narrative = await summarizeDropped(dropped, ctx).catch(() => "");
    if (narrative.trim()) summaryText += `\n\n【折叠轮次的推理脉络（摘要，仅供延续决策）】\n${narrative.trim()}`;
    else {
      // #W2 — summarization failed (rate-limit/timeout): DON'T silently drop the reasoning narrative.
      // Deterministic fallback: keep the tail of the dropped assistant turns verbatim + surface a
      // visible warning so "reasoning continuity degraded" is legible, not invisible.
      const tail = dropped
        .filter((m) => m.role === "assistant")
        .slice(-3)
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400))
        .join("\n---\n");
      if (tail) summaryText += `\n\n【折叠轮次的原文尾段（摘要生成失败的确定性兜底）】\n${tail}`;
      ctx.emit({ t: "reflect", kind: "compact-fallback", lesson: "压缩摘要 LLM 调用失败——已用确定性截断兜底，推理连续性可能受损。" });
    }
  }
  const summary: ChatMsg = { role: "system", content: summaryText };
  messages.length = 0;
  messages.push(system, summary, ...recent);
  return true;
}

// ── constrained decoding (grounding enums) ─────────────────────────────────────
// Once the ontology is known, constrain the design/refine tool schemas' `action`
// (and tool-name fields) to the REAL names, so the model can't emit invented symbols
// (when the gateway honors JSON-schema enums). Cheap to rebuild each turn.
function injectGroundingEnums(schemas: ToolSchema[], g: { actionNames: string[]; toolNames: string[] }): ToolSchema[] {
  if (!g.actionNames.length) return schemas;
  return schemas.map((s) => {
    if (s.function.name !== "design_agent" && s.function.name !== "refine_agent" && s.function.name !== "codegen_agent" && s.function.name !== "read_spec" && s.function.name !== "score_spec") return s;
    const params = JSON.parse(JSON.stringify(s.function.parameters)) as { properties?: Record<string, Record<string, unknown>> };
    if (params.properties?.action) params.properties.action.enum = g.actionNames;
    if (params.properties?.tools && g.toolNames.length) (params.properties.tools as { items?: Record<string, unknown> }).items = { type: "string", enum: g.toolNames };
    return { ...s, function: { ...s.function, parameters: params } };
  });
}

// Maps a stage-bearing tool to the pipeline stage it advances, so the conductor can emit an
// explicit `stage` event when the brain enters it. Only the primary stage-advancing tools are
// listed — auxiliary reads (read_spec, score_spec, web_search, list_domains…) deliberately do
// NOT move the rail, so it doesn't jump backward on incidental lookups. A refine_agent firing
// after validate legitimately moves it back to "design" — that IS the refine loop the canvas
// draws. The web client mirrors this in stageOf() as a fallback for stage-less old transcripts.
const STAGE_OF_TOOL: Record<string, FactoryStage> = {
  read_ontology: "read",
  create_plan: "plan",
  design_agent: "design",
  design_fleet: "design",
  refine_fleet: "design",
  review_fleet: "validate",
  codegen_agent: "design",
  refine_agent: "design",
  revert_refine: "design",
  validate_graph: "validate",
  review_agent: "validate",
  review_context: "validate",
  review_completeness: "validate",
  verify_chain: "validate",
  propose_boundary_events: "validate",
  generate_test_cases: "sandbox",
  sandbox_run: "sandbox",
  run_regression: "sandbox",
  delivery_bundle: "deliver",
  inspect_run: "sandbox",
  finish: "deliver",
};

// #W2-STAGE — the OUTER STAGE STATE MACHINE: phaseFor was a display signal; these are ADMISSION
// GATES. A stage-bearing tool is refused with a structured steer unless its stage's entry conditions
// hold — the pipeline order is enforced by structure, not by system-prompt prose ("别跳过"). ReAct
// stays free INSIDE a stage; only cross-stage jumps are gated. Read-only/info tools are never gated.
export function stageAdmission(toolName: string, ctx: BrainCtx): string | null {
  const stage = STAGE_OF_TOOL[toolName];
  if (!stage) return null; // non-stage tools (info/skill/tool-smith/HITL) are always admitted
  switch (stage) {
    case "read":
      return null;
    case "plan":
      return ctx.ontology ? null : `[阶段闸门] ${toolName} 属于 PLAN 阶段——入口条件未满足：还没 read_ontology。先读本体。`;
    case "design":
      if (!ctx.ontology) return `[阶段闸门] ${toolName} 属于 DESIGN 阶段——先 read_ontology。`;
      if ((toolName === "design_agent" || toolName === "design_fleet") && !ctx.currentPlan) return `[阶段闸门] ${toolName} 需要先有分解计划——先 create_plan（并建议 critique_plan 挑战它），再设计。`;
      return null;
    case "validate":
      return ctx.specs.length ? null : `[阶段闸门] ${toolName} 属于 VALIDATE 阶段——还没有任何已设计 agent 可审。先 design_agent。`;
    case "sandbox":
      if (!ctx.specs.length) return `[阶段闸门] ${toolName} 属于 SANDBOX 阶段——先 design_agent。`;
      if (toolName === "sandbox_run" && ctx.lastValidation?.ok !== true) {
        return ctx.lastValidation
          ? `[阶段闸门] sandbox_run 前的 validate_graph 没有明确通过（要求 ok=true）——先按校验结果修复并重新 validate_graph，再创建真实沙箱。`
          : `[阶段闸门] sandbox_run 前先 validate_graph（事件图闭合 + 字段合同）——没校验就部署是在浪费一次真实沙箱。`;
      }
      return null;
    case "deliver":
      return ctx.lastSandbox ? null : `[阶段闸门] finish 属于 DELIVER 阶段——还没有沙箱证据。先 generate_test_cases → sandbox_run。`;
  }
  return null;
}

// #W2-STAGE — per-stage token budgets. DEFAULT OFF (0 = unlimited) per user 2026-07-02
// («token预算取消，设置最高预算»): live Allmeta domains routinely exceeded the old 50k/80k
// READ/PLAN defaults, so the «超出 token 预算——已提示收敛» nudge fired every run and steered the
// brain for no reason. A deployment that WANTS budgets re-enables per stage via
// FACTORY_STAGE_BUDGET_<STAGE>=<tokens>; the admission gates (stageAdmission) — which are about
// ORDER, not spend — are untouched.
const STAGE_BUDGETS: Record<string, number> = {
  read: envInt("FACTORY_STAGE_BUDGET_READ", 0),
  plan: envInt("FACTORY_STAGE_BUDGET_PLAN", 0),
  design: envInt("FACTORY_STAGE_BUDGET_DESIGN", 0),
  validate: envInt("FACTORY_STAGE_BUDGET_VALIDATE", 0),
  sandbox: envInt("FACTORY_STAGE_BUDGET_SANDBOX", 0),
  deliver: envInt("FACTORY_STAGE_BUDGET_DELIVER", 0),
};

// Runaway backstop. Auto-compaction bounds context size; this separately bounds
// unattended provider spend. Env-overridable (#9c), with `0` as an explicit opt-out.
const MAX_TURNS = envInt("FACTORY_MAX_TURNS", 200);
const MAX_TOKENS = resolveFactorySessionTokenLimit();
const TOOL_RESULT_CAP = envInt("FACTORY_TOOL_RESULT_CAP", 60_000);
const PROVIDER_TOKEN_RESERVE = envInt(
  "FACTORY_BRAIN_PROVIDER_TOKEN_RESERVE",
  4_096,
);

function configuredTurnCompletionCap(): number | null {
  const value = Number(process.env.FACTORY_BRAIN_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function tokenDelta(total: number, startingTotal: number): number {
  return Math.max(0, total - startingTotal);
}

function sessionCostState(tokens: number): {
  level: "ok" | "elevated" | "high";
  costNote?: string;
} {
  const elevatedDefault = MAX_TOKENS == null ? 2_000_000 : Math.max(1, Math.floor(MAX_TOKENS * 0.6));
  const highDefault = MAX_TOKENS == null ? 4_000_000 : Math.max(1, Math.floor(MAX_TOKENS * 0.85));
  const elevatedAt = envInt("FACTORY_COST_ELEVATED_TOKENS", elevatedDefault);
  const highAt = Math.max(elevatedAt, envInt("FACTORY_COST_HIGH_TOKENS", highDefault));
  const level = tokens >= highAt ? "high" : tokens >= elevatedAt ? "elevated" : "ok";
  const tokenK = Math.round(tokens / 1000);
  const costNote =
    level === "high"
      ? `⚠ 成本偏高(${tokenK}k tokens)——若已接近可交付，优先收敛到 finish。`
      : level === "elevated"
        ? `成本中高(${tokenK}k tokens)——能 finish 就别再额外 refine。`
        : undefined;
  return { level, ...(costNote ? { costNote } : {}) };
}

function freshCtx(domain: string, goal: string, ports: FactoryPorts, emit: (e: BrainEvent) => void, priorReflections: ReflectionLite[]): BrainCtx {
  return {
    domain,
    goal,
    emit,
    ports,
    interactionPolicy: "strict",
    specs: [],
    ontology: null,
    budget: { maxTokens: MAX_TOKENS, maxTurns: MAX_TURNS },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    currentPlan: null,
    toolCatalog: [],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    lastSandbox: null,
    lastValidation: null,
    humanDirectives: [],
    priorReflections,
  };
}

/** #SUBAGENT — run ONE isolated sub-brain (its own runBrain loop, depth-bounded read-only tools) and
 *  fold back its final conclusion. Shared by spawn_subagent (single) and spawn_subagent_group (members).
 *  Propagates the shared budget ledger down, and RESTORES the parent's LLM-telemetry context after the
 *  child clobbered the module global to its own (conversationId=undefined). Returns the FULL conclusion
 *  (untruncated) so a group reduce reasons over complete member outputs, not a 200-char stub. */
async function runSubBrain(
  ctx: BrainCtx,
  member: { task: string; role?: string; scopedTools?: BrainTool[]; groupId?: string },
): Promise<{ ok: boolean; role?: string; task: string; summary: string }> {
  const priorLlmCtx = { conversationId: ctx.conversationId, domain: ctx.domain };
  ctx.emit({ t: "subagent.start", task: member.task, ...(member.role ? { role: member.role } : {}), ...(member.groupId ? { groupId: member.groupId } : {}) });
  let summary = "";
  let failed = false;
  try {
    // R9: propagate depth (child fans out one more level until MAX_SUBAGENT_DEPTH, then read-only) and
    // the SHARED budget ledger (#TREE-BUDGET) so nested reasoning is bounded tree-wide, not per-run.
    for await (const ev of runBrain({
      domain: ctx.domain,
      goal: member.task,
      ports: ctx.ports,
      signal: ctx.signal,
      isSubAgent: true,
      depth: (ctx.subagentDepth ?? 0) + 1,
      budgetLedger: ctx.budgetLedger,
      interactionPolicy: ctx.interactionPolicy,
      generationDirective: ctx.generationDirective,
      // 给子大脑一个派生的会话 id。没有它，子大脑继承了父进程的归档端口却
      // 无处可写，压缩时要么静默销毁原文（旧行为），要么被迫推迟（新守卫）。
      // 派生 id 让子大脑的转录和父会话一样可归档、可 recall。
      ...(ctx.conversationId
        ? {
            conversationId: member.groupId
              ? `${ctx.conversationId}:sub:${member.groupId}:${member.role ?? "member"}`
              : `${ctx.conversationId}#sub-${(ctx.subagentDepth ?? 0) + 1}`,
          }
        : {}),
      ...(member.scopedTools?.length ? { tools: member.scopedTools } : {}),
    })) {
      if (ev.t === "message") summary = ev.text;
    }
  } catch (e) {
    failed = true;
    summary = `子大脑出错：${safeDiagnostic(e)}`;
  }
  setLlmCallContext(priorLlmCtx); // restore parent telemetry — the sub-brain clobbered it to conversationId=undefined
  ctx.emit({ t: "subagent.done", task: member.task, summary, ...(member.groupId ? { groupId: member.groupId } : {}) });
  return { ok: !failed, role: member.role, task: member.task, summary };
}

/** #TREE-BUDGET — charge n spawns against the shared ledger. Returns a refusal string when the tree-wide
 *  spawn cap would be exceeded (so a runaway fan-out/recursion stops), else null (and increments). */
function chargeSpawn(ctx: BrainCtx, n = 1): string | null {
  const ledger = ctx.budgetLedger;
  if (!ledger) return null;
  if (ledger.spawns + n > ledger.maxSpawns) {
    return `已达本次运行的子智能体总数上限（${ledger.maxSpawns}，已派 ${ledger.spawns}）——不能再派生。用已有结论收敛，或提高 FACTORY_MAX_TREE_SPAWNS。`;
  }
  ledger.spawns += n;
  return null;
}

/** Scope a sub-brain's toolset to a requested subset of the read-only SUBAGENT_TOOLS (unknown names are
 *  simply dropped); returns undefined to mean "the default depth-bounded set". */
function scopedSubagentTools(tools: unknown): BrainTool[] | undefined {
  const filter = Array.isArray(tools) ? new Set((tools as unknown[]).map((t) => String(t))) : null;
  return filter ? SUBAGENT_TOOLS.filter((t) => filter.has(t.name)) : undefined;
}

/** Run items through fn with a concurrency cap (order-preserving results). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

/** #SUBAGENT-GROUP — reduce a group's member conclusions into one coherent, de-duplicated result. One
 *  synthesis call (bounded, fast tier); degrades to a deterministic stitch if the gateway is off / fails
 *  / no member succeeded — the group never hard-fails the parent over a flaky member (quorum degrade). */
async function reduceGroup(
  ctx: BrainCtx,
  label: string,
  instruction: string,
  results: Array<{ role?: string; ok: boolean; summary: string }>,
): Promise<string> {
  const good = results.filter((r) => r.ok && r.summary.trim());
  const stitch = () => good.length
    ? `【组内 ${good.length}/${results.length} 成员结论（确定性拼接）】\n${good.map((r) => `· ${r.role ?? "成员"}：${r.summary.trim().slice(0, 300)}`).join("\n")}`
    : `子智能体组「${label}」没有成员成功产出结论。`;
  if (!good.length || !isGatewayConfigured()) return stitch();
  const material = good.map((r) => `## ${r.role ?? "成员"}\n${r.summary.trim()}`).join("\n\n");
  try {
    const text = await chatOnce(
      `你是「${label}」子智能体组的结论合成者。多个成员各自独立深挖了一个子任务，你把它们合成为一份连贯、去重、可直接使用的整体结论。${instruction ? `合成要求：${instruction}。` : ""}只输出合成后的结论正文，不要逐个复述成员。600 字以内，信息密度优先，名字/结论忠于成员材料不编造。`,
      material.slice(0, 24_000),
      { maxTokens: 1200, purpose: "subagent_group:reduce", models: modelChain("fast"), signal: ctx.signal },
    );
    return text.trim() || stitch();
  } catch {
    return stitch();
  }
}

/** spawn_subagent — a real isolated sub-brain for a focused research subtask. It gets
 *  its OWN message history + ctx (read-only tools only: no deploy, no mutation) and
 *  returns its summary, so a side investigation doesn't pollute the main conversation. */
const spawnSubagentTool: BrainTool = {
  name: "spawn_subagent",
  description: "派一个隔离的子大脑做聚焦子任务（只读研究：read_ontology / describe_domain / web_search / inspect_run 等，不能部署也不能改 agent）。完成后回传它的总结。某个子问题要独立深入分析、又不想污染主对话时用。要【一组分工的子脑并行】用 spawn_subagent_group。",
  // #DELEGATE (P1-11, Anthropic 多智能体系统实录) — 委派四件套：objective(task) / output_format /
  // 工具指引(tools) / 边界(boundaries)。原文："Each subagent needs an objective, an output format,
  // guidance on the tools and sources to use, and clear task boundaries" —— 否则子 agent 重复劳动或漏活。
  parameters: { type: "object", properties: { reasoning: { type: "string", description: "为什么要派子大脑" }, task: { type: "string", description: "【objective】交给子大脑的聚焦子任务——一句话说清要产出什么结论" }, output_format: { type: "string", description: "【四件套②】期望的回传格式（如「列表：每条 发现+证据出处」「一段 ≤200 字结论 + 3 个数据点」）——不传=自由总结" }, boundaries: { type: "string", description: "【四件套④】任务边界：不要做什么/查到什么程度为止（如「只查本体不读代码」「最多 3 个来源」）——防重复劳动与越界" }, role: { type: "string", description: "【由你自动拟定】给这个子大脑设定的角色名（≤10 字，按任务定制，如「证据调查员」「规则考古学家」「链路侦探」）——后台任务卡与活动叙事用它称呼这个子 agent" }, tools: { type: "array", items: { type: "string" }, description: "【四件套③】限定子大脑只能用这些工具(作用域工具集,避免全量工具污染其决策);不传=默认只读集" } }, required: ["reasoning", "task"], additionalProperties: false },
  async execute(args, ctx) {
    const taskCore = String(args.task ?? "").trim();
    if (!taskCore) return { ok: false, summary: "task 不能为空。" };
    const over = chargeSpawn(ctx); // #TREE-BUDGET — count this spawn against the tree-wide cap
    if (over) return { ok: false, summary: over };
    // 四件套织进子大脑的 goal（objective 之外的 output_format/boundaries 以显式段落传达）。
    const outputFormat = String(args.output_format ?? "").trim();
    const boundaries = String(args.boundaries ?? "").trim();
    const task = [taskCore, outputFormat ? `【回传格式】${outputFormat}` : "", boundaries ? `【边界】${boundaries}` : ""].filter(Boolean).join("\n");
    // #ROLE — 子大脑的角色由 AI 在 spawn 时自动设定（开放词汇，不设注册表）；缺省不显示。
    const role = String(args.role ?? "").trim().slice(0, 16) || undefined;
    const scopedTools = scopedSubagentTools(args.tools);
    const res = await runSubBrain(ctx, { task, role, scopedTools });
    return res.ok
      ? { ok: true, summary: `子大脑完成：${res.summary.slice(0, 200)}`, output: { summary: res.summary } }
      : { ok: false, summary: res.summary.slice(0, 200), output: { summary: res.summary } };
  },
};

/** #SUBAGENT-GROUP build mode — parse ONE member sub-brain's conclusion into a design_subagent proposal.
 *  The member is asked to END with a JSON object; we extract it tolerantly. A parse miss is NOT fatal:
 *  design_subagent works from `task` alone (it synthesises prompt/decision/code), so we degrade to a task
 *  derived from the member's role/conclusion rather than dropping the child. Never invents tools/schema. */
function parseDesignProposal(conclusion: string, role: string, fallbackTask: string): Record<string, unknown> {
  const parsed = extractJson(conclusion);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const task = typeof obj.task === "string" && obj.task.trim() ? obj.task.trim() : `${role}：${fallbackTask}`.slice(0, 120);
  const out: Record<string, unknown> = { task };
  if (typeof obj.system_prompt === "string" && obj.system_prompt.trim()) out.system_prompt = obj.system_prompt.trim();
  if (typeof obj.decision_logic === "string" && obj.decision_logic.trim()) out.decision_logic = obj.decision_logic.trim();
  if (Array.isArray(obj.tools)) out.tools = (obj.tools as unknown[]).map((t) => String(t)).filter(Boolean);
  if (Array.isArray(obj.input_schema)) out.input_schema = obj.input_schema;
  if (Array.isArray(obj.output_schema)) out.output_schema = obj.output_schema;
  if (obj.critical === true) out.critical = true;
  return out;
}

/** spawn_subagent_group — the reasoning-driven fan-out. When the brain judges that a problem needs a
 *  GROUP of specialised sub-brains (not a single one), it supplies a member roster and this runs them as
 *  parallel isolated runBrain loops (concurrency-limited, one shared budget ledger).
 *   · mode=research (default): reduce the members' conclusions into ONE structured result.
 *   · mode=build: each member designs one child sub-agent (isolated proposal); the tool then SERIALLY
 *     applies each via the real design_subagent tool (every call gated by its own TS/security/binding
 *     validation), landing a deployable parent→child workflow. Serial writes = no shared-ctx race. */
const spawnSubagentGroupTool: BrainTool = {
  name: "spawn_subagent_group",
  description: "当你【推理判断】某个问题需要一【组分工的子智能体】并行处理（而不是单个）时用它：你给出成员数组（每个成员自拟 role + 聚焦 task + 可选工具子集/边界），工具并行跑出一组隔离子大脑（每个各自独立推理一整轮 runBrain，带并发上限与全局预算）。mode=research（默认）：只读调研组，把各成员结论归并成一份结构化结果回灌你。mode=build（需 parent_action）：每个成员【设计一个子 agent】，工具随后【串行】用 design_subagent 逐个落地成可部署的父→子工作流（每个都过 TS/安全/绑定校验，坏提案会被拒不会污染）。适合把大问题按维度/视角拆开并行深挖再合成，或把一个复杂父 agent 一次性拆成多个子 agent 并落地。",
  parameters: { type: "object", properties: {
    reasoning: { type: "string", description: "为什么需要一个【组】而不是单个子脑（一句话）" },
    label: { type: "string", description: "这个组的名字（如「本体四维深读」「三视角评审」）——UI 用它标识这棵子树" },
    mode: { type: "string", enum: ["research", "build"], description: "research=只读调研组归并结论（默认）；build=每成员设计一个子 agent 并用 design_subagent 串行落地（需 parent_action）" },
    parent_action: { type: "string", description: "（build 模式必填）子 agent 们挂靠的【已 design_agent 的父 agent】动作名" },
    members: { type: "array", description: "组成员（2 到 6 个）。每个：{role(角色名≤12字), task(该成员的聚焦子任务/要设计的子 agent 职责), tools?(工具子集), boundaries?}", items: { type: "object", properties: { role: { type: "string", description: "成员角色名（≤12 字，按子任务定制）" }, task: { type: "string", description: "该成员的聚焦子任务；build 模式=这个子 agent 负责什么" }, tools: { type: "array", items: { type: "string" }, description: "限定该成员的工具子集；不传=默认集" }, boundaries: { type: "string", description: "该成员的边界：不做什么/查到什么程度" } }, required: ["role", "task"], additionalProperties: false } },
    reduce: { type: "string", description: "（research 可选）如何归并各成员结论的指示——不传=通用合成" },
  }, required: ["reasoning", "label", "members"], additionalProperties: false },
  async execute(args, ctx) {
    const rawMembers = Array.isArray(args.members) ? (args.members as Array<Record<string, unknown>>) : [];
    const members = rawMembers
      .map((m) => ({ role: String(m.role ?? "").trim().slice(0, 16), taskCore: String(m.task ?? "").trim(), tools: m.tools, boundaries: String(m.boundaries ?? "").trim() }))
      .filter((m) => m.role && m.taskCore);
    if (members.length < 2) return { ok: false, summary: "一个组至少要 2 个带 role+task 的成员；单个子任务请用 spawn_subagent。" };
    const MAX_MEMBERS = envInt("FACTORY_MAX_GROUP_MEMBERS", 6);
    if (members.length > MAX_MEMBERS) return { ok: false, summary: `一个组最多 ${MAX_MEMBERS} 个成员（收到 ${members.length}）——拆成多次或合并近似角色。` };

    const mode: "research" | "build" = args.mode === "build" ? "build" : "research";
    const parentAction = String(args.parent_action ?? "").trim();
    if (mode === "build") {
      if (opts_isSubAgentGuard(ctx)) return { ok: false, summary: "子脑内不能用 build 模式落地 agent（写侧操作只在主脑串行做）。改 research 模式或回主脑落地。" };
      if (!parentAction) return { ok: false, summary: "build 模式必须给 parent_action（子 agent 挂靠的、已 design_agent 的父 agent 动作名）。" };
      if (!ctx.specs.some((s) => s.actionName === parentAction && !s.isSubAgent)) {
        return { ok: false, summary: `没找到已设计的父 agent「${parentAction}」——先 design_agent 它，再用 build 组把子 agent 挂上去。` };
      }
    }
    const over = chargeSpawn(ctx, members.length); // #TREE-BUDGET — the whole group counts against the cap
    if (over) return { ok: false, summary: over };

    const label = (String(args.label ?? "").trim().slice(0, 40)) || "子智能体组";
    const groupId = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    ctx.emit({ t: "group.start", groupId, label, members: members.length, mode });

    const concurrency = Math.max(1, Math.min(envInt("FACTORY_GROUP_CONCURRENCY", 3), members.length));
    const buildInstruction = (role: string) =>
      `\n\n【产出要求】你在为父 agent「${parentAction}」设计一个子 agent（角色：${role}）。研究本体后，最后【只输出一个 JSON 对象】描述这个子 agent，不要再有多余文字：` +
      `{"task":"一句话子任务(必填,决定 slug)","system_prompt":"中文系统提示(职责/决策)","decision_logic":"分支决策逻辑","tools":["真实工具名"],"input_schema":[{"field":"","type":""}],"output_schema":[{"field":"","type":""}],"critical":false}。` +
      `除 task 外都可留空/省略；工具只能用本体/工具库里的真名，查不到就留空由后续补，绝不要编造工具或字段。`;
    const prepared = members.map((m) => ({
      role: m.role,
      task: [m.taskCore, m.boundaries ? `【边界】${m.boundaries}` : "", mode === "build" ? buildInstruction(m.role) : ""].filter(Boolean).join("\n"),
      scopedTools: scopedSubagentTools(m.tools),
      taskCore: m.taskCore,
    }));
    const results = await mapWithConcurrency(prepared, concurrency, (member) =>
      runSubBrain(ctx, { task: member.task, role: member.role, scopedTools: member.scopedTools, groupId }).then((r) => ({ ...r, taskCore: member.taskCore })),
    );

    if (mode === "build") {
      // #SUBAGENT-GROUP build — SERIALLY apply each member's proposal via the real design_subagent tool.
      // Serial (not parallel) so the shared parent ctx.specs / parent.plan mutations don't race; every
      // call is validated by design_subagent's own gates, so a bad proposal is rejected, never deployed.
      const designSubagent = FACTORY_TOOLS.find((t) => t.name === "design_subagent");
      const deployed: Array<{ role: string; ok: boolean; summary: string }> = [];
      for (const r of results) {
        if (!designSubagent) { deployed.push({ role: r.role ?? "成员", ok: false, summary: "design_subagent 工具不可用" }); continue; }
        if (!r.ok) { deployed.push({ role: r.role ?? "成员", ok: false, summary: `成员子脑失败：${r.summary.slice(0, 100)}` }); continue; }
        const proposal = parseDesignProposal(r.summary, r.role ?? "成员", r.taskCore);
        const res = await designSubagent.execute({ parent_action: parentAction, ...proposal }, ctx);
        deployed.push({ role: r.role ?? "成员", ok: res.ok, summary: res.summary });
        ctx.emit({ t: "message", text: res.ok ? `🧩 组员「${r.role}」→ 子 agent 已落地：${res.summary.slice(0, 120)}` : `⚠ 组员「${r.role}」的子 agent 被 design_subagent 拒绝（未部署）：${res.summary.slice(0, 120)}` });
      }
      const landed = deployed.filter((d) => d.ok);
      ctx.emit({ t: "group.done", groupId, label, ok: landed.length, total: deployed.length, summary: `落地 ${landed.length}/${deployed.length} 个子 agent 到父「${parentAction}」` });
      return {
        ok: landed.length > 0,
        summary: `子智能体组「${label}」(build)：为父「${parentAction}」落地 ${landed.length}/${deployed.length} 个子 agent${landed.length < deployed.length ? `（${deployed.length - landed.length} 个被校验拒绝，见明细）` : ""}。父的 plan 已串上对应 invoke 步。`,
        output: { label, groupId, mode, parentAction, deployed },
      };
    }

    const ok = results.filter((r) => r.ok);
    const merged = await reduceGroup(ctx, label, String(args.reduce ?? "").trim(), results);
    ctx.emit({ t: "group.done", groupId, label, ok: ok.length, total: results.length, summary: merged.slice(0, 200) });
    return {
      ok: ok.length > 0,
      summary: `子智能体组「${label}」完成：${ok.length}/${results.length} 成功。归并结论：${merged.slice(0, 240)}${ok.length < results.length ? `（${results.length - ok.length} 个成员失败，已按存活成员归并）` : ""}`,
      output: { label, groupId, mode, merged, members: results.map((r) => ({ role: r.role, ok: r.ok, conclusion: r.summary })) },
    };
  },
};

/** build mode is a WRITE operation (mutates ctx.specs) — only the top-level brain may do it, never a
 *  spawned sub-brain (whose isSubAgent ctx has no persistence and would race the parent). */
function opts_isSubAgentGuard(ctx: BrainCtx): boolean {
  return (ctx.subagentDepth ?? 0) > 0;
}

/** Test seam: the reasoning-driven group tool (research + build) exercised directly with a hand-built ctx. */
export const __spawnSubagentGroupToolForTest = spawnSubagentGroupTool;
export const __buildStateSummaryForTest = buildStateSummary;
/** Test seam (#CONV-ARCHIVE): the compaction fold with its archive-before-drop contract. */
export const __maybeCompactForTest = maybeCompact;

// ── #DESIGN-FLEET — sub-agents as BUILDERS, not just advisors ────────────────────────────────────
//
// Until now the production work (design_agent per ontology action) was done serially by the ONE main
// brain; sub-brains were read-only researchers. design_fleet closes that gap with the same shape that
// keeps the single-writer model safe:
//   · N fleet members (full runBrain sub-brains, read-only tools) each research ONE action in parallel
//     and produce a COMPLETE design proposal (the exact design_agent args) — "并行想";
//   · the tool then lands each proposal SERIALLY through the real design_agent — every proposal passes
//     the full gate suite (readiness slice, rule grounding, integration binding, input-binding compile,
//     code render+probe). A bad proposal is rejected with the gate's reason, never half-landed — "串行写".
// ask_user-typed refusals (integration selection, missing credentials) are AGGREGATED so the brain asks
// the user once for the whole fleet instead of parking N times.

/** Parse a fleet member's conclusion into design_agent args. system_prompt + decision_logic are the
 *  minimum viable design — a miss is a real member failure (unlike design_subagent, design_agent cannot
 *  synthesise them). Keys are whitelisted; authorization-sensitive params (tool_profiles etc.) are
 *  deliberately NOT passthrough — profile confirmation stays with the main brain + user. */
function parseFleetDesignProposal(conclusion: string): { ok: true; proposal: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = extractJson(conclusion);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!obj) return { ok: false, error: "成员结论里没有可解析的 JSON 设计提案" };
  const systemPrompt = typeof obj.system_prompt === "string" ? obj.system_prompt.trim() : "";
  const decisionLogic = typeof obj.decision_logic === "string" ? obj.decision_logic.trim() : "";
  if (!systemPrompt || !decisionLogic) return { ok: false, error: "提案缺少必填的 system_prompt / decision_logic" };
  const proposal: Record<string, unknown> = { system_prompt: systemPrompt, decision_logic: decisionLogic };
  if (Array.isArray(obj.tools)) proposal.tools = (obj.tools as unknown[]).map((t) => String(t)).filter(Boolean);
  if (Array.isArray(obj.plan)) proposal.plan = obj.plan;
  if (Array.isArray(obj.input_schema)) proposal.input_schema = obj.input_schema;
  if (Array.isArray(obj.output_schema)) proposal.output_schema = obj.output_schema;
  if (Array.isArray(obj.decision_tables)) proposal.decision_tables = obj.decision_tables;
  if (typeof obj.role_name === "string" && obj.role_name.trim()) proposal.role_name = obj.role_name.trim().slice(0, 18);
  if (typeof obj.tool_rationale === "string" && obj.tool_rationale.trim()) proposal.tool_rationale = obj.tool_rationale.trim();
  if (typeof obj.compensation_event === "string" && obj.compensation_event.trim()) proposal.compensation_event = obj.compensation_event.trim();
  if (obj.tool_configs && typeof obj.tool_configs === "object" && !Array.isArray(obj.tool_configs)) proposal.tool_configs = obj.tool_configs;
  return { ok: true, proposal };
}

const designFleetTool: BrainTool = {
  name: "design_fleet",
  description:
    "把【多个还没设计的本体动作】一次性并行设计：为每个动作派一个设计成员（隔离子脑，只读研究该动作的输入/输出/规则/工具后产出完整设计提案），然后【串行】用真实 design_agent 逐个落地——每个提案都过全套校验门（就绪切片/规则接地/集成绑定/输入绑定/代码渲染+探针），坏提案被拒不落地。需要用户拍板的（选集成/缺凭证）会【聚合成一份】回给你统一 ask_user，不会挂起 N 次。适合 create_plan 后把剩余动作并行造完（比逐个 design_agent 快 N 倍）；单个动作请直接 design_agent。",
  parameters: { type: "object", properties: {
    reasoning: { type: "string", description: "为什么现在适合并行设计这批动作（一句话）" },
    actions: { type: "array", items: { type: "string" }, description: "要并行设计的动作名（2 个起，来自 read_ontology agentActions[].name；已设计的会自动跳过）" },
    shared_guidance: { type: "string", description: "（可选）给所有设计成员的共同要求（如「所有 prompt 用中文」「优先用 Ontology 声明的工具」）" },
  }, required: ["reasoning", "actions"], additionalProperties: false },
  async execute(args, ctx) {
    if (opts_isSubAgentGuard(ctx)) return { ok: false, summary: "子脑内不能用 design_fleet（写侧操作只在主脑串行做）。" };
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const designAgent = FACTORY_TOOLS.find((t) => t.name === "design_agent");
    if (!designAgent) return { ok: false, summary: "design_agent 工具不可用。" };

    const agentActionNames = new Set(
      factoryGenerationScopedAgentActionNames(
        ctx.ontology,
        ctx.generationDirective,
      ),
    );
    const requested = [...new Set((Array.isArray(args.actions) ? (args.actions as unknown[]) : []).map((a) => String(a).trim()).filter(Boolean))];
    const serverScope = ctx.generationDirective?.requestedActionNames;
    const outsideScope = serverScope?.length
      ? requested.filter((action) => !serverScope.includes(action))
      : [];
    if (outsideScope.length) {
      return {
        ok: false,
        summary: `这些动作超出本次服务端生成范围：${outsideScope.join("、")}。只允许：${serverScope!.join("、")}。`,
      };
    }
    const unknown = requested.filter((a) => !agentActionNames.has(a));
    if (unknown.length) return { ok: false, summary: `这些不是本体里的 Agent 动作：${unknown.join("、")}。用 read_ontology agentActions[].name 里的准确名字。` };
    const designed = new Set(ctx.specs.filter((s) => !s.isSubAgent).map((s) => s.actionName));
    const skipped = requested.filter((a) => designed.has(a));
    const actions = requested.filter((a) => !designed.has(a));
    if (actions.length < 1) return { ok: false, summary: `这批动作都已设计过（${skipped.join("、")}）——改用 refine_agent 修改，或换还没设计的动作。` };
    const MAX_FLEET = envInt("FACTORY_MAX_FLEET_ACTIONS", 8);
    if (actions.length > MAX_FLEET) return { ok: false, summary: `一次舰队最多 ${MAX_FLEET} 个动作（收到 ${actions.length}）——分两批。` };

    const over = chargeSpawn(ctx, actions.length); // #TREE-BUDGET
    if (over) return { ok: false, summary: over };

    const label = `设计舰队 · ${actions.length} 动作`;
    const groupId = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    ctx.emit({ t: "group.start", groupId, label, members: actions.length, mode: "design" });

    const sharedGuidance = String(args.shared_guidance ?? "").trim();
    // #ACTION-BRIEF (P0-1) — deterministic context provisioning: each member receives its action's full
    // slice INLINE (events+payload contracts, objects, rules, tool candidates+credential posture,
    // readiness gaps) instead of re-reading the whole ontology — the dominant fleet token cost.
    const briefFor = (action: string) => buildActionBrief({
      ontology: ctx.ontology!,
      actionName: action,
      rules: ctx.rulesByAction?.[action],
      realTools: ctx.realTools,
      blocking: ctx.ontologyReadiness?.blocking,
    });
    const memberTaskTemplate = (action: string) =>
      `你是「${action}」这个本体动作的专职设计成员。下面的【动作简报】已包含设计所需的完整切片（事件契约/对象字段/规则/工具候选/就绪缺口）——【以简报为准直接设计】，只有简报里确实缺的信息才用只读工具（read_action_contract / describe_object / search_tools）定点补查，不要全量重读本体。\n\n${briefFor(action)}${sharedGuidance ? `\n\n【共同要求】${sharedGuidance}` : ""}\n\n【产出要求】最后【只输出一个 JSON 对象】（不要多余文字）：\n{"system_prompt":"中文系统提示(必填,亲自写:职责/边界/每个分支事件的触发条件;规则校验类动作必须写成运行时动态抓规则,绝不写死规则)","decision_logic":"分支决策逻辑(必填,说清何时 emit 哪个事件)","tools":["真实工具名——只能用 Ontology action.tool_use 声明的或工具库(search_tools)里真实存在的名字;拿不准就留空数组"],"plan":[{"stepId":"若 execution_plan_requirement.required=true 必须覆盖 action_steps 的稳定 stepId","kind":"tool|logic|condition|invoke|foreach|emit","tool":"kind=tool 时的真实工具","toolArguments":{"参数名":{"from":"input/lastResult/results/locals 开头的精确路径或改用 const","required":true}},"resultMap":{"fields":{"稳定字段名":"result 开头的精确路径"},"includeRaw":false},"dependsOn":["前置 stepId"],"emitEvent":"kind=emit 时【必填】:本体 triggered_event 真名","emitPayloadFrom":"event/input/lastResult/results/locals 开头的精确路径","invoke":"kind=invoke 时的子 agent","invokeInput":{"字段":"精确值"},"itemsFrom":"kind=foreach 时的集合路径","itemAs":"循环局部变量名","itemKeyFrom":"每层 foreach 的稳定业务键","body":"foreach 内可递归嵌套 foreach/invoke","idempotencyKeyFrom":"顶层副作用步的可重放业务键路径","timeoutS":30,"onError":"terminal|soft|park","description":"这步做什么"}],"input_schema":[{"field":"","type":"","required":true}],"output_schema":[{"field":"","type":""}],"role_name":"≤12字显示名"}\n【plan 何时给】只在 execution_plan_requirement.required=true、或有外部集成/多步副作用/循环子任务时才给 plan；简单的单步 LLM 判断型动作（没有 action_steps、没有外部系统）请【整体省略 plan 字段】——运行时会按 prompt+decision_logic 直接执行并自动 emit 声明的事件，不需要手写 emit 步。\ntoolArguments/resultMap 必须逐字段声明真实数据流，缺映射就先定点查证或 ask_user，禁止把整份 event/lastResult 默认塞给外部工具。嵌套每一层都要有业务键，invoke/tool 都要写 timeout 与错误策略。绝不编造工具名/事件名/字段名——全部用你研究到的真名。`;
    const memberTask = (action: string) => memberTaskTemplate(action).replace(
      '"body":"foreach 内可递归嵌套 foreach/invoke"',
      '"body":[{"stepId":"子步骤稳定 id","kind":"invoke","invoke":"子 agent 名","timeoutS":30,"onError":"terminal"}]',
    );

    const concurrency = Math.max(1, Math.min(envInt("FACTORY_GROUP_CONCURRENCY", 3), actions.length));
    const results = await mapWithConcurrency(actions, concurrency, (action) =>
      runSubBrain(ctx, { task: memberTask(action), role: `${action.slice(0, 10)}设计`, groupId }).then((r) => ({ ...r, action })),
    );

    // Serial landing through the REAL design_agent — full gate suite per proposal, no shared-ctx race.
    const landed: string[] = [];
    const rejected: Array<{ action: string; reason: string }> = [];
    const needsUser: Array<{ action: string; question: string }> = [];
    for (const r of results) {
      if (!r.ok) { rejected.push({ action: r.action, reason: `设计成员失败：${r.summary.slice(0, 160)}` }); continue; }
      const parsedProposal = parseFleetDesignProposal(r.summary);
      if (!parsedProposal.ok) { rejected.push({ action: r.action, reason: parsedProposal.error }); continue; }
      const res = await designAgent.execute({ action: r.action, ...parsedProposal.proposal }, ctx);
      if (res.ok) {
        landed.push(r.action);
        ctx.emit({ t: "message", text: `🏭 舰队成员「${r.action}」的设计已过全套校验门并落地。` });
      } else {
        const out = (res.output ?? {}) as Record<string, unknown>;
        if (out.next === "ask_user") {
          needsUser.push({ action: r.action, question: res.summary.slice(0, 260) });
          ctx.emit({ t: "message", text: `🙋 舰队成员「${r.action}」需要用户拍板（已聚合，稍后统一问）。` });
        } else {
          rejected.push({ action: r.action, reason: res.summary.slice(0, 260) });
          ctx.emit({ t: "message", text: `⚠ 舰队成员「${r.action}」的提案被校验门拒绝：${res.summary.slice(0, 120)}` });
        }
      }
    }

    ctx.emit({ t: "group.done", groupId, label, ok: landed.length, total: actions.length, summary: `并行设计落地 ${landed.length}/${actions.length}${needsUser.length ? ` · ${needsUser.length} 个待用户拍板` : ""}` });
    const parts = [
      `设计舰队完成：${landed.length}/${actions.length} 个动作已设计落地${landed.length ? `（${landed.join("、")}）` : ""}。`,
      skipped.length ? `已设计跳过：${skipped.join("、")}。` : "",
      needsUser.length ? `【需要用户确认 ${needsUser.length} 项】：${needsUser.map((n) => `${n.action}：${n.question}`).join("；")}` : "",
      rejected.length ? `【被拒 ${rejected.length} 项——按理由逐个用 design_agent 亲自修复设计】：${rejected.map((x) => `${x.action}：${x.reason}`).join("；")}` : "",
    ].filter(Boolean);
    const question = needsUser.length
      ? `还有 ${needsUser.length} 个 Agent 需要你补充真实信息后才能继续：${needsUser.map((item) => `${item.action}：${item.question}`).join("；")}`
      : undefined;
    return {
      ok: landed.length > 0,
      summary: parts.join(" "),
      output: {
        groupId,
        landed,
        skipped,
        rejected,
        needsUser,
        ...(question ? { next: "ask_user", reason: "fleet_actions_require_authoritative_input", question } : {}),
      },
    };
  },
};

/** Test seam: the parallel-design fleet exercised directly with a hand-built ctx. */
export const __designFleetToolForTest = designFleetTool;

// ── #REVIEW-FLEET / #REFINE-FLEET (P1) — parallelise the remaining serial production stages ─────────
//
// Reviews are read-only and per-agent independent → naturally parallel. Repairs follow design_fleet's
// shape: members produce PATCH proposals in parallel, the tool lands them SERIALLY through the real
// refine_agent (snapshot history + score delta + revert bookkeeping all preserved).

/** Compact inline brief of a DESIGNED spec for reviewers/refiners (mirrors #ACTION-BRIEF: provision the
 *  member inline instead of a read_spec round-trip). Deterministic, capped. */
function specBriefFor(spec: GeneratedAgentSpec, maxChars = 4500): string {
  const io = (rows?: Array<{ field: string; type: string; required?: boolean }>) =>
    (rows ?? []).map((r) => `${r.field}:${r.type}${r.required ? "!" : ""}`).join(", ") || "无";
  const plan = (spec.plan ?? []).map((s) => `${s.stepId}(${s.kind}${(s as { tool?: string }).tool ? `:${(s as { tool?: string }).tool}` : ""})`).join(" → ") || "无（声明式直跑）";
  const code = spec.generatedCode ? `\n— 代码（截取）—\n${spec.generatedCode.slice(0, 1400)}` : "";
  const brief = [
    `【当前 spec · ${spec.actionName}（${spec.nameZh}）】`,
    `trigger: ${spec.trigger.join("、")} → emit: ${spec.emit.join("、") || "（无）"} · tools: ${spec.tools.join("、") || "无"}`,
    `input: {${io(spec.inputSchema)}} → output: {${io(spec.outputSchema)}}`,
    `plan: ${plan}`,
    `— system_prompt —\n${spec.systemPrompt.slice(0, 1200)}`,
    `— decision_logic —\n${(spec.decisionLogic ?? "（未写）").slice(0, 700)}`,
  ].join("\n") + code;
  return brief.length > maxChars ? `${brief.slice(0, maxChars)}…（截断）` : brief;
}

type ReviewFinding = { lens: string; severity: string; issue: string; fix: string };
function parseReviewFindings(conclusion: string): ReviewFinding[] | null {
  const parsed = extractJson(conclusion);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const rows = Array.isArray(obj?.findings) ? (obj!.findings as Array<Record<string, unknown>>) : Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  if (!rows) return null;
  return rows
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      lens: ["quality", "context", "completeness"].includes(String(r.lens)) ? String(r.lens) : "quality",
      severity: ["high", "medium", "low"].includes(String(r.severity)) ? String(r.severity) : "medium",
      issue: String(r.issue ?? "").slice(0, 300),
      fix: String(r.fix ?? "").slice(0, 300),
    }))
    .filter((r) => r.issue);
}

const reviewFleetTool: BrainTool = {
  name: "review_fleet",
  description:
    "把【多个已设计 agent】一次性并行审查：每个 agent 派一个审查成员（隔离子脑，拿到该 agent 的完整 spec 简报 + 动作切片简报），按三透镜出具结构化 findings——quality(设计/代码质量)、context(是否读懂并契合上下文)、completeness(覆盖/分支/规则想全了没)。只审不改（advisory）：聚合结果回给你，high 级问题建议用 refine_fleet 并行修或逐个 refine_agent。适合设计完一批后统一体检；单个 agent 请直接 review_agent。",
  parameters: { type: "object", properties: {
    reasoning: { type: "string", description: "为什么现在批量审查（一句话）" },
    actions: { type: "array", items: { type: "string" }, description: "要审查的动作名（不传=全部已设计的顶层 agent，至多 8 个）" },
  }, required: ["reasoning"], additionalProperties: false },
  async execute(args, ctx) {
    if (opts_isSubAgentGuard(ctx)) return { ok: false, summary: "子脑内不能开审查舰队。" };
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const designed = ctx.specs.filter((s) => !s.isSubAgent);
    if (!designed.length) return { ok: false, summary: "还没有已设计的 agent 可审——先 design_agent / design_fleet。" };
    const requested = Array.isArray(args.actions) && (args.actions as unknown[]).length
      ? [...new Set((args.actions as unknown[]).map((a) => String(a).trim()))]
      : designed.map((s) => s.actionName);
    const missing = requested.filter((a) => !designed.some((s) => s.actionName === a));
    if (missing.length) return { ok: false, summary: `这些动作还没设计，审不了：${missing.join("、")}。` };
    const targets = requested.slice(0, envInt("FACTORY_MAX_FLEET_ACTIONS", 8));
    const over = chargeSpawn(ctx, targets.length);
    if (over) return { ok: false, summary: over };

    const label = `审查舰队 · ${targets.length} agent`;
    const groupId = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    ctx.emit({ t: "group.start", groupId, label, members: targets.length, mode: "review" });

    const memberTask = (action: string) => {
      const spec = designed.find((s) => s.actionName === action)!;
      return `你是「${action}」的独立审查员。用下面两份简报审查这个已设计 agent，【只审不改】。三个透镜逐一过：\n· quality：system_prompt/decision_logic/plan/代码 的设计质量（含 durability：副作用步可重放、幂等键、错误策略）\n· context：它是否读懂并契合本体上下文（事件契约字段对上了吗、输出映射到 emit 事件了吗、规则处理方式对吗）\n· completeness：分支/边界/失败路径想全了没（缺哪个分支事件、哪个异常没处理）\n\n${specBriefFor(spec)}\n\n${buildActionBrief({ ontology: ctx.ontology!, actionName: action, rules: ctx.rulesByAction?.[action], realTools: ctx.realTools, blocking: ctx.ontologyReadiness?.blocking })}\n\n【产出要求】最后【只输出一个 JSON 对象】：{"findings":[{"lens":"quality|context|completeness","severity":"high|medium|low","issue":"具体问题(可定位)","fix":"怎么修(一句话)"}]}。没有问题就 {"findings":[]}——别为了凑数硬挑；每条 issue 必须具体到字段/分支/步骤，不要泛泛而谈。`;
    };
    const results = await mapWithConcurrency(targets, Math.max(1, Math.min(envInt("FACTORY_GROUP_CONCURRENCY", 3), targets.length)), (action) =>
      runSubBrain(ctx, { task: memberTask(action), role: `${action.slice(0, 10)}审查`, groupId }).then((r) => ({ ...r, action })),
    );

    const reviews: Array<{ action: string; findings: ReviewFinding[]; parseFailed?: boolean }> = [];
    for (const r of results) {
      const findings = r.ok ? parseReviewFindings(r.summary) : null;
      reviews.push(findings ? { action: r.action, findings } : { action: r.action, findings: [], parseFailed: true });
    }
    const flagged = reviews.filter((r) => r.findings.some((f) => f.severity === "high")).map((r) => r.action);
    const totalFindings = reviews.reduce((n, r) => n + r.findings.length, 0);
    const failed = reviews.filter((r) => r.parseFailed).map((r) => r.action);
    ctx.emit({ t: "group.done", groupId, label, ok: targets.length - failed.length, total: targets.length, summary: `${totalFindings} 条发现 · ${flagged.length} 个 agent 有 high 级问题` });
    return {
      ok: failed.length < targets.length,
      summary: `审查舰队完成：${targets.length} 个 agent · ${totalFindings} 条发现${flagged.length ? ` · 【high 级】${flagged.join("、")}——建议 refine_fleet 并行修（items 带上对应 findings 作 problem）` : " · 无 high 级问题"}${failed.length ? ` · ⚠ ${failed.join("、")} 的审查产出无法解析（可单独 review_agent 重审）` : ""}`,
      output: { groupId, reviews, flagged },
    };
  },
};

function parseRefinePatch(conclusion: string): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = extractJson(conclusion);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!obj) return { ok: false, error: "成员结论里没有可解析的 JSON 补丁" };
  const critique = typeof obj.critique === "string" ? obj.critique.trim() : "";
  if (!critique) return { ok: false, error: "补丁缺少必填的 critique（根因）" };
  const patch: Record<string, unknown> = { critique };
  if (typeof obj.system_prompt === "string" && obj.system_prompt.trim()) patch.system_prompt = obj.system_prompt.trim();
  if (typeof obj.decision_logic === "string" && obj.decision_logic.trim()) patch.decision_logic = obj.decision_logic.trim();
  if (Array.isArray(obj.tools)) patch.tools = (obj.tools as unknown[]).map((t) => String(t)).filter(Boolean);
  if (Array.isArray(obj.input_schema)) patch.input_schema = obj.input_schema;
  if (Array.isArray(obj.output_schema)) patch.output_schema = obj.output_schema;
  if (Array.isArray(obj.plan)) patch.plan = obj.plan;
  return { ok: true, patch };
}

const refineFleetTool: BrainTool = {
  name: "refine_fleet",
  description:
    "把【多个 agent 的已验证问题】一次性并行修复：每个问题项派一个修复成员（隔离子脑，拿到 spec 简报+动作简报+问题描述）并行产出补丁（critique+要改的字段），然后【串行】用真实 refine_agent 逐个落地——快照历史/改前后分数/退步提醒全部保留，坏补丁被拒不落地。problem 必须是【已验证的具体问题】（validate_graph/sandbox_run/review 的结论），不要拿猜测来修。2 个问题起用；单个问题请直接 refine_agent。",
  parameters: { type: "object", properties: {
    reasoning: { type: "string", description: "为什么并行修这批（一句话）" },
    items: { type: "array", description: "问题项（2..8）：[{action:已设计动作名, problem:已验证的具体问题}]", items: { type: "object", properties: { action: { type: "string" }, problem: { type: "string" } }, required: ["action", "problem"], additionalProperties: false } },
  }, required: ["reasoning", "items"], additionalProperties: false },
  async execute(args, ctx) {
    if (opts_isSubAgentGuard(ctx)) return { ok: false, summary: "子脑内不能开修复舰队（写侧只在主脑串行做）。" };
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const refineAgent = FACTORY_TOOLS.find((t) => t.name === "refine_agent");
    if (!refineAgent) return { ok: false, summary: "refine_agent 工具不可用。" };
    const designed = ctx.specs.filter((s) => !s.isSubAgent);
    const rawItems = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
    const items = rawItems
      .map((i) => ({ action: String(i.action ?? "").trim(), problem: String(i.problem ?? "").trim() }))
      .filter((i) => i.action && i.problem);
    if (items.length < 2) return { ok: false, summary: "至少 2 个问题项才值得开舰队；单个问题直接 refine_agent。" };
    if (items.length > envInt("FACTORY_MAX_FLEET_ACTIONS", 8)) return { ok: false, summary: `一次最多 ${envInt("FACTORY_MAX_FLEET_ACTIONS", 8)} 项。` };
    const unknown = items.filter((i) => !designed.some((s) => s.actionName === i.action)).map((i) => i.action);
    if (unknown.length) return { ok: false, summary: `这些动作还没设计，修不了：${[...new Set(unknown)].join("、")}。` };
    const over = chargeSpawn(ctx, items.length);
    if (over) return { ok: false, summary: over };

    const label = `修复舰队 · ${items.length} 项`;
    const groupId = `grp-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    ctx.emit({ t: "group.start", groupId, label, members: items.length, mode: "refine" });

    const memberTask = (item: { action: string; problem: string }) => {
      const spec = designed.find((s) => s.actionName === item.action)!;
      return `你是「${item.action}」的专职修复成员。下面是它当前的 spec、动作切片简报，以及【已验证的问题】。定位根因并产出【定点补丁】——只改必须改的字段，别顺手重写没问题的部分。\n\n【已验证的问题】\n${item.problem.slice(0, 800)}\n\n${specBriefFor(spec)}\n\n${buildActionBrief({ ontology: ctx.ontology!, actionName: item.action, rules: ctx.rulesByAction?.[item.action], realTools: ctx.realTools, blocking: ctx.ontologyReadiness?.blocking })}\n\n【产出要求】最后【只输出一个 JSON 对象】：{"critique":"根因(必填,一句话说清哪里错为什么错)","system_prompt":"改后完整版(不改则省略此键)","decision_logic":"改后完整版(不改省略)","tools":["改后完整清单(不改省略)"],"input_schema":[...改后完整(不改省略)],"output_schema":[...],"plan":[...]}。工具/事件/字段名只用简报里的真名。`;
    };
    const results = await mapWithConcurrency(items, Math.max(1, Math.min(envInt("FACTORY_GROUP_CONCURRENCY", 3), items.length)), (item) =>
      runSubBrain(ctx, { task: memberTask(item), role: `${item.action.slice(0, 10)}修复`, groupId }).then((r) => ({ ...r, action: item.action })),
    );

    const landed: string[] = [];
    const rejected: Array<{ action: string; reason: string }> = [];
    const needsUser: Array<{ action: string; question: string }> = [];
    for (const r of results) {
      if (!r.ok) { rejected.push({ action: r.action, reason: `修复成员失败：${r.summary.slice(0, 160)}` }); continue; }
      const parsed = parseRefinePatch(r.summary);
      if (!parsed.ok) { rejected.push({ action: r.action, reason: parsed.error }); continue; }
      const res = await refineAgent.execute({ action: r.action, ...parsed.patch }, ctx);
      if (res.ok) {
        landed.push(r.action);
        ctx.emit({ t: "message", text: `🔧 修复舰队「${r.action}」补丁已落地：${res.summary.slice(0, 110)}` });
      } else {
        const out = (res.output ?? {}) as Record<string, unknown>;
        if (out.next === "ask_user") needsUser.push({ action: r.action, question: res.summary.slice(0, 260) });
        else rejected.push({ action: r.action, reason: res.summary.slice(0, 260) });
      }
    }
    ctx.emit({ t: "group.done", groupId, label, ok: landed.length, total: items.length, summary: `并行修复落地 ${landed.length}/${items.length}` });
    const question = needsUser.length
      ? `还有 ${needsUser.length} 个 Agent 的修改需要你补充真实信息：${needsUser.map((item) => `${item.action}：${item.question}`).join("；")}`
      : undefined;
    return {
      ok: landed.length > 0,
      summary: [
        `修复舰队完成：${landed.length}/${items.length} 项已落地${landed.length ? `（${landed.join("、")}——沙箱证据已失效，记得重新 sandbox_run）` : ""}。`,
        needsUser.length ? `【需要用户确认 ${needsUser.length} 项】：${needsUser.map((n) => `${n.action}：${n.question}`).join("；")}` : "",
        rejected.length ? `【被拒 ${rejected.length} 项——按理由亲自 refine_agent】：${rejected.map((x) => `${x.action}：${x.reason}`).join("；")}` : "",
      ].filter(Boolean).join(" "),
      output: {
        groupId,
        landed,
        rejected,
        needsUser,
        ...(question ? { next: "ask_user", reason: "fleet_refinements_require_authoritative_input", question } : {}),
      },
    };
  },
};

/** Test seams for the review/refine fleets. */
export const __reviewFleetToolForTest = reviewFleetTool;
export const __refineFleetToolForTest = refineFleetTool;

const AUTHORIZATION_CONTEXT = /^(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i;
const AUTHORIZATION_TOKEN = /authorize_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:[a-f0-9]{64}/i;
const AUTHORIZATION_TOKEN_GLOBAL = /authorize_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:[a-f0-9]{64}/gi;
const AUTHORIZATION_DECLINE_GLOBAL = /decline_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:[a-f0-9]{64}/gi;
const CHECKPOINT_AUTH_CONFIRM = "$factory_authorization_confirmed";
const CHECKPOINT_AUTH_DECLINE = "$factory_authorization_declined";

function isAuthorizationContext(value: unknown): boolean {
  return AUTHORIZATION_CONTEXT.test(String(value ?? ""));
}

function redactAuthorizationText(value: string): string {
  return value
    .replace(AUTHORIZATION_TOKEN_GLOBAL, "[服务端确认已选择]")
    .replace(AUTHORIZATION_DECLINE_GLOBAL, "[服务端确认已拒绝]");
}

function isTestFixtureClarification(question: string, context: string): boolean {
  return /sandbox 安全测试数据|测试数据补全|补全测试真实数据|禁止直接写入/i.test(context)
    || /sandbox.*测试|测试.*(?:字段|fixture|数据)/i.test(question);
}

function sanitizeClarificationAnswer(question: string, context: string, answer: string): { answer: string; sensitive: boolean } {
  if (!isTestFixtureClarification(question, context)) return { answer, sensitive: false };
  const scan = sanitizeSensitiveInput(answer, "clarification.test_fixture_answer");
  return {
    answer: typeof scan.sanitized === "string" ? scan.sanitized : "[REDACTED]",
    sensitive: scan.paths.length > 0,
  };
}

function serializeMessages(messages: ChatMsg[]): unknown[] {
  return JSON.parse(redactAuthorizationText(JSON.stringify(messages))) as unknown[];
}

function authorizationAnswerState(context: unknown, answer: string): string | null {
  if (!isAuthorizationContext(context)) return null;
  return AUTHORIZATION_TOKEN.test(answer)
    ? "用户已确认该服务端挑战"
    : "用户已拒绝该服务端挑战";
}

function checkpointOptions(
  options: Array<{ label: string; value: string; recommended?: boolean }> | undefined,
): Array<{ label: string; value: string; recommended?: boolean }> | undefined {
  return options?.map((option) => ({
    ...option,
    value: AUTHORIZATION_TOKEN.test(option.value)
      ? CHECKPOINT_AUTH_CONFIRM
      : CHECKPOINT_AUTH_DECLINE,
  }));
}

/** The serializable slice of ctx (everything except the runtime handles).
 * Authorization capabilities are persisted only as server-restorable refs;
 * raw confirmation/decline values never enter the conversation checkpoint. */
function serializeCtx(ctx: BrainCtx): Record<string, unknown> {
  const { emit: _e, ports: _p, signal: _s, ...rest } = ctx;
  void _e; void _p; void _s;
  const serialized: Record<string, unknown> = { ...rest };
  if (ctx.pendingHuman) {
    // A stop can durably defer batch peers, and gate routing can park an envelope.
    // One-shot authorization answers must remain only in the server mailbox.
    serialized.pendingHuman = ctx.pendingHuman.map((message) => ({
      ...message,
      text: redactAuthorizationText(message.text),
    }));
  }
  if (ctx.pendingAuthorizationChallenges) {
    serialized.pendingAuthorizationChallenges = Object.fromEntries(
      Object.entries(ctx.pendingAuthorizationChallenges).map(([context, challenge]) => [context, {
        id: challenge.id,
        kind: challenge.kind,
        protocolVersion: challenge.protocolVersion,
        digest: challenge.digest,
        subjectDigest: challenge.subjectDigest,
        runId: challenge.runId,
        conversationId: challenge.conversationId,
        expiresAt: challenge.expiresAt,
      }]),
    );
  }
  if (ctx.clarifyPrompt && isAuthorizationContext(ctx.clarifyPrompt.context)) {
    serialized.clarifyPrompt = {
      question: ctx.clarifyPrompt.question,
      context: ctx.clarifyPrompt.context,
      options: checkpointOptions(ctx.clarifyPrompt.options),
    };
  }
  if (ctx.clarificationAnswerEvidence) {
    serialized.clarificationAnswerEvidence = Object.fromEntries(
      Object.entries(ctx.clarificationAnswerEvidence).map(([key, evidence]) => {
        if (!isAuthorizationContext(evidence.context)) return [key, evidence];
        return [key, {
          ...evidence,
          options: checkpointOptions(evidence.options),
          answer: AUTHORIZATION_TOKEN.test(evidence.answer)
            ? CHECKPOINT_AUTH_CONFIRM
            : CHECKPOINT_AUTH_DECLINE,
        }];
      }),
    );
  }
  if (ctx.askedQuestions) {
    serialized.askedQuestions = Object.fromEntries(Object.entries(ctx.askedQuestions).map(([key, answer]) => [
      key,
      redactAuthorizationText(answer),
    ]));
  }
  serialized.humanDirectives = ctx.humanDirectives.map(redactAuthorizationText);
  // Final recursive guard covers future ctx fields (for example goal or a
  // newly-added diagnostic) without relying on every caller to remember the
  // authorization token shape.
  return JSON.parse(redactAuthorizationText(JSON.stringify(serialized))) as Record<string, unknown>;
}

async function restoreAuthorizationState(ctx: BrainCtx, messages: ChatMsg[]): Promise<void> {
  const refs = Object.values(ctx.pendingAuthorizationChallenges ?? {}) as Array<Partial<FactoryAuthorizationChallenge>>;
  if (!refs.length) return;
  const restored: Record<string, FactoryAuthorizationChallenge> = {};
  for (const ref of refs) {
    if (
      !ctx.ports.authorizationChallenges
      || !ref.id || !ref.kind || !ref.protocolVersion || !ref.digest || !ref.subjectDigest
      || !ref.runId || !ref.conversationId || !ref.expiresAt
    ) continue;
    const challenge = await ctx.ports.authorizationChallenges.restore(ctx.domain, ref as Pick<FactoryAuthorizationChallenge, "id" | "kind" | "protocolVersion" | "digest" | "subjectDigest" | "runId" | "conversationId" | "expiresAt">);
    if (challenge) restored[challenge.context] = challenge;
  }
  ctx.pendingAuthorizationChallenges = restored;
  if (ctx.clarifyPrompt && isAuthorizationContext(ctx.clarifyPrompt.context)) {
    const challenge = restored[String(ctx.clarifyPrompt.context)];
    if (challenge) {
      ctx.clarifyPrompt = { question: challenge.question, context: challenge.context, options: challenge.options };
    } else {
      ctx.awaitingClarify = false;
      ctx.clarifyPrompt = undefined;
      closeHumanInteraction(ctx, "clarify");
      const notice = "此前未决的服务端确认已失效或过期；不会自动执行，如仍需要请重新发起确认。";
      ctx.humanDirectives.push(notice);
      messages.push({ role: "user", content: `[服务端确认状态] ${notice}` });
    }
  }
  for (const [key, evidence] of Object.entries(ctx.clarificationAnswerEvidence ?? {})) {
    if (!isAuthorizationContext(evidence.context)) continue;
    const challenge = restored[String(evidence.context)];
    if (!challenge) {
      delete ctx.clarificationAnswerEvidence?.[key];
      continue;
    }
    evidence.options = challenge.options;
    if (evidence.answer === CHECKPOINT_AUTH_CONFIRM) evidence.answer = challenge.token;
    else if (evidence.answer === CHECKPOINT_AUTH_DECLINE) {
      evidence.answer = challenge.options.find((option) => option.value !== challenge.token)?.value ?? CHECKPOINT_AUTH_DECLINE;
    }
  }
}

function normalizeHumanMessage(value: FactoryHumanMessage | string): FactoryHumanMessage {
  return typeof value === "string" ? { text: value } : value;
}

async function persistHumanDecision(
  ctx: BrainCtx,
  input: {
    kind: "clarify" | "boundary" | "test_approval" | "directive";
    question: string;
    answer: string;
    context?: string;
  },
): Promise<void> {
  if (!ctx.ports.humanMemory) return;
  // A write-probe approval is deliberately one-shot. Persisting it as reusable
  // human memory would silently authorize a later conversation.
  if (
    /^authorize_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:/i.test(input.answer) ||
    /^(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i.test(input.context ?? "")
  ) return;
  await ctx.ports.humanMemory.upsert(ctx.domain, {
    questionKey: humanMemoryQuestionKey(input.kind, input.question),
    kind: input.kind,
    question: input.question,
    answer: input.answer,
    context: input.context,
    source: "human",
    conversationId: ctx.conversationId,
    confirmed: true,
  });
}

export async function* runBrain(opts: {
  domain: string;
  goal: string;
  ports: FactoryPorts;
  /** defaults to FACTORY_TOOLS */
  tools?: BrainTool[];
  /** aborts the loop when the SSE client disconnects */
  signal?: AbortSignal;
  /** conversation key — resume if it exists (load prior messages + ctx), else fresh. */
  conversationId?: string;
  /** Authenticated actor for a direct conversation continuation. Mailbox
   * answers carry their own actor and take precedence. */
  authenticatedActor?: string;
  /** internal: this run IS a spawned sub-brain (read-only, no persistence side effects). */
  isSubAgent?: boolean;
  /** sub-brain recursion depth (R9) — bounds spawn_subagent fan-out. */
  depth?: number;
  /** #TREE-BUDGET — shared spend ledger; the root omits it (one is created), children inherit it. */
  budgetLedger?: BudgetLedger;
  /** Trusted control-plane recovery reason. Never infer this from goal text. */
  continuationMode?: "crash_resume" | "human_gate_resume";
  /** Explicitly opted-in interaction behavior. Omitted preserves a resumed
   * conversation's policy; a fresh run defaults to legacy strict mode. */
  interactionPolicy?: FactoryInteractionPolicy;
  /** Server-validated Action scope / virtual Action overlay. */
  generationDirective?: FactoryGenerationDirective;
}): AsyncGenerator<BrainEvent> {
  const depth = opts.depth ?? 0;
  const MAX_SUBAGENT_DEPTH = envInt("FACTORY_MAX_SUBAGENT_DEPTH", 2);
  // #TREE-BUDGET — one ledger for the whole tree: the root creates it, every spawned child inherits the
  // SAME object (passed via opts.budgetLedger), so total tokens + total spawns are bounded tree-wide.
  const budgetLedger: BudgetLedger = opts.budgetLedger ?? { tokens: 0, spawns: 0, maxTokens: MAX_TOKENS, maxSpawns: envInt("FACTORY_MAX_TREE_SPAWNS", 12) };
  // R9: a sub-brain may itself fan out one more level (until MAX), then it's read-only research.
  // #SUBAGENT-GROUP — both the root brain and a sub-brain (until the shared depth cap) get spawn_subagent
  // + spawn_subagent_group, so a member can itself decompose into a recursive group; at MAX depth the
  // toolset drops to read-only (no further fan-out). The tree-wide spawn ledger bounds aggregate cost.
  const tools = opts.tools ?? (opts.isSubAgent ? (depth < MAX_SUBAGENT_DEPTH ? [...SUBAGENT_TOOLS, spawnSubagentTool, spawnSubagentGroupTool] : SUBAGENT_TOOLS) : [...FACTORY_TOOLS, spawnSubagentTool, spawnSubagentGroupTool, designFleetTool, reviewFleetTool, refineFleetTool]);
  const buffer: BrainEvent[] = [];
  let interactionCtx: BrainCtx | undefined;
  const emit = (e: BrainEvent) => buffer.push(
    interactionCtx ? bindHumanInteractionEvent(interactionCtx, e) : e,
  );

  // #7: warm the live model catalog (best-effort, non-blocking) so the difficulty router can
  // validate/derive tier chains against the models the gateway actually serves.
  warmModelCatalog();

  // resume or fresh
  // A conversation-store failure cannot be reinterpreted as "no saved row": doing so would run
  // against an empty context and risk overwriting or contradicting the durable conversation.
  const savedExists = opts.conversationId
    ? await opts.ports.conversation.has(opts.conversationId)
    : false;
  const saved = savedExists
    ? await opts.ports.conversation.load(opts.conversationId!)
    : null;
  // Recovery semantics are control-plane state, never a user-spoofable goal prefix.
  // Both crash recovery and an idle human-gate wake-up resume the checkpoint as-is:
  // they do not register a new intent or reset a still-pending gate.
  const isRecoveryResume = !opts.isSubAgent && opts.continuationMode !== undefined;
  const priorReflections: ReflectionLite[] = saved
    ? ((saved.ctx.priorReflections as ReflectionLite[]) ?? [])
    : await opts.ports.reflection.list(opts.domain);
  // Eager human memory: fresh conversations start with exact, confirmed
  // decisions instead of waiting for a post-run LLM consolidation.  Pinned
  // rows sort first in the concrete store; all returned rows are confirmed.
  const seededHumanMemories = !saved && !opts.isSubAgent && opts.ports.humanMemory
    ? await opts.ports.humanMemory.list(opts.domain, { confirmedOnly: true, limit: 200 })
    : [];

  const ctx: BrainCtx = saved
    ? ({ ...(saved.ctx as unknown as BrainCtx), emit, ports: opts.ports } as BrainCtx)
    : freshCtx(opts.domain, opts.goal, opts.ports, emit, priorReflections);
  interactionCtx = ctx;
  ctx.emit = emit;
  ctx.ports = opts.ports;
  if (saved && opts.generationDirective) {
    const savedFingerprint = factoryGenerationDirectiveFingerprint(
      ctx.generationDirective,
    );
    const requestedFingerprint = factoryGenerationDirectiveFingerprint(
      opts.generationDirective,
    );
    if (savedFingerprint !== requestedFingerprint) {
      throw new Error(
        "generation scope is immutable within a Factory conversation; start a new task",
      );
    }
  }
  ctx.generationDirective =
    opts.generationDirective ?? ctx.generationDirective;
  ctx.interactionPolicy = resolveFactoryConversationInteractionPolicy({
    saved: Boolean(saved),
    savedPolicy: ctx.interactionPolicy,
    requestedPolicy: opts.interactionPolicy,
  });
  // A recovery steer is not a new business goal. Keep the checkpointed goal so
  // acceptance, summaries and subsequent model turns retain the original task.
  if (!saved || !isRecoveryResume) ctx.goal = opts.goal;
  ctx.signal = opts.signal;
  ctx.conversationId = opts.conversationId;
  ctx.subagentDepth = depth;
  ctx.budgetLedger = budgetLedger; // #TREE-BUDGET — spawn tools read this to pass the shared ledger down
  const conversationTokensAtRunStart = Math.max(0, ctx.spent.tokens);
  const currentRunTokens = (): number =>
    tokenDelta(ctx.spent.tokens, conversationTokensAtRunStart);
  // #MEM-SEED v2 — 人工确认记忆只作为【背景上下文】随首轮注入（见下方 messages 的 system 帧）。刻意不再：
  //   · 跨会话预填 ctx.askedQuestions —— 那会让新会话里 ask_user 命中 ASK-DEDUP 直接回放旧答案而【不挂起】
  //     （用户抱怨"ask_user 开了却不暂停"的一条成因），改由模型自己判断是否引用旧答案，ask_user 仍真正 park；
  //   · 压进 ctx.humanDirectives —— 那会每轮作为「人工介入指令」重新出现、喧宾夺主，导致用户只发"你好"
  //     大脑也以旧决策开场复盘。作为 system 背景后，模型被明确要求不主动复述、不以此开场。
  // #P0-3 — bind LLM telemetry to this run so every chatOnce records against the right conversation/
  // domain (single-instance: one brain run at a time). No-op unless a sink is wired at bootstrap.
  setLlmCallContext({ conversationId: opts.conversationId, domain: opts.domain });

  const toolSchemas: ToolSchema[] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  // #9 (i18n): the brain's working language — follows FACTORY_BRAIN_LANG, else (auto) the ontology
  // content / the domain id, default zh. On a FRESH run ctx.ontology is null here, so under `auto`
  // it's re-resolved once read_ontology populates the ontology (see the turn loop) and the system
  // prompt refreshed — otherwise a Chinese-content domain with an ASCII slug would resolve to en.
  let lang = resolveBrainLang(opts.domain, ctx.ontology);
  let langFromOntology = !!ctx.ontology;
  const messages: ChatMsg[] = saved
    ? [...(saved.messages as ChatMsg[])]
    : [
        { role: "system", content: systemPrompt(opts.domain, priorReflections, lang) },
        ...(seededHumanMemories.length
          // #MEM-SEED v2 — 背景注入用 system 而非 role:user：不冒充"当前用户输入"排在真实那句话之前，
          // 于是纯问候不会触发大脑复盘旧决策。
          ? [{ role: "system" as const, content: renderHumanMemorySeed(seededHumanMemories) }]
          : []),
        { role: "user", content: redactAuthorizationText(opts.goal) },
      ];
  const CONTROL_POLICY_PREFIX = "[控制平面交互策略]";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(CONTROL_POLICY_PREFIX)
    ) {
      messages.splice(index, 1);
    }
  }
  messages.splice(1, 0, {
    role: "system",
    content:
      `${CONTROL_POLICY_PREFIX} 当前为 ${ctx.interactionPolicy}。` +
      (ctx.interactionPolicy === "autopilot"
        ? "一般低风险澄清和唯一边界分类会由控制平面采用推荐/只读安全默认并记录 assumption.applied；测试用例与沙箱审查只有在覆盖完整、无待处理授权且无外部写时才会自动批准。不要输出逐步思考、chain-of-thought 或长篇自言自语；只发一句决策摘要和必要的阶段/结果状态，然后调用工具。任何凭证、权威事实缺口、服务端 authorization challenge、外部副作用批准或生产写授权仍必须等待真人，绝不能自行回答或伪造确认。"
        : "保持旧 Agent Factory 严格交互：人工门必须等待真人提交。") +
      (ctx.generationDirective
        ? ` 本次只允许生成 Action：${ctx.generationDirective.requestedActionNames.join("、")}；不得扩展到其它 Action。这些选中 Action 就是本次完整验收全集：create_plan 按 full 规划，全部生成代码、测试并真实 sandbox_run 后可直接 finish；全域未选 Action 不算遗漏，也不得把本次任务降级成旧 partial/save_draft。${ctx.generationDirective.mode === "virtual_scenario" ? "其中 Virtual Action 是非权威会话覆盖层，禁止当成已写回 Ontology；可沙箱验证并交付草稿，但生产晋升必须等权威 Ontology 真正建模后重新生成。" : ""}`
        : ""),
  });
  // On RESUME, messages[0] is the system prompt frozen when the conversation started.
  // Refresh it so prompt improvements (the routing 铁律) apply to ongoing conversations
  // too, not just brand-new ones — otherwise the brain keeps obeying the old prompt.
  if (saved && messages[0]?.role === "system") {
    messages[0] = { role: "system", content: systemPrompt(opts.domain, priorReflections, lang) };
  }
  // Older checkpoints may have copied a raw one-shot answer into a chat
  // message. Redact before any resumed model call and before re-persistence.
  for (const message of messages) {
    if (typeof message.content === "string") message.content = redactAuthorizationText(message.content);
  }
  if (saved) await restoreAuthorizationState(ctx, messages);
  // #POLICY-PRUNE — 旧 [推理路线] 指令只对注入它的那次请求有效；随 checkpoint 沉积后每次
  // resume 都带着历史禁令（analyze 的「不要 create_plan」会与随后的生成授权直接矛盾，模型
  // 倾向服从更早的禁令）。恢复时剪掉历史路线消息——本次 selectPolicy 会重新注入当前路线。
  //
  // 这个失效模式【本来就已知】，但过去只在跨 run resume（saved）时剪。澄清门的 park 是
  // 【循环内】的：answer 回来后同一个 messages 继续用，从不经过这里 → 那条 analyze 的
  // 「【不要】进入生成流水线」原样留在场上，比用户的新回答更长寿。真实事故正是如此。
  // 所以抽成函数，重路由时复用（见 applyPolicyRoute）——把矛盾【物理移除】，而不是只声明作废。
  // 前缀必须与【注入分诊消息时】用的一致，否则剪不掉——改文案时最容易忘的一处。
  // `[前置分诊·事实与建议]` = analyze/skinny/ask_first 的 #POLICY-ADVISORY 消息；
  // `[推理路线]` = full 路线消息 + 已 checkpoint 的历史会话里的旧前缀（恢复后照样要剪掉）。
  const POLICY_GUIDE_PREFIXES = ["[前置分诊·事实与建议]", "[推理路线]"];
  const prunePolicyGuides = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user" && typeof m.content === "string" && POLICY_GUIDE_PREFIXES.some((p) => m.content!.startsWith(p))) messages.splice(i, 1);
    }
  };
  if (saved) prunePolicyGuides();

  // Ordinary continuation text is not an addressed HITL answer. If a saved
  // conversation is parked, preserve the gate and require its exact card id;
  // otherwise /runs/start could bypass /inject by treating arbitrary goal text
  // as consent (or by cancelling approval/boundary state).
  let goalRoutedToClarify = false;
  if (saved && !opts.isSubAgent && !isRecoveryResume && activeHumanInteractionKind(ctx)) {
    goalRoutedToClarify = true;
    messages.push({
      role: "system",
      content: "[人工门保护] 普通继续消息没有当前交互编号，不能充当回答、批准或分类。保留原等待状态；只消费经交互卡提交到耐久邮箱的精确回复。",
    });
    emit({ t: "message", text: "这条普通消息没有当前交互卡编号，因此没有被当作回答或批准。原等待仍保留，请在当前交互卡上提交。" });
  }
  if (saved && !goalRoutedToClarify) {
    messages.push(isRecoveryResume
      ? {
          role: "system",
          content: opts.continuationMode === "human_gate_resume"
            ? "[运行恢复] 已收到当前人工门的耐久回复；先由门控消费该回复，再从检查点继续，不能重做已完成步骤。"
            : "[运行恢复] 服务进程已恢复；从最近检查点继续，不能把恢复信号当作新需求，也不能重做已完成步骤。",
        }
      : { role: "user", content: redactAuthorizationText(opts.goal) });
  }

  // ── INTENT GATE（意图门）— understand the user before executing them. Every new goal
  // (fresh run OR a resumed conversation's follow-up) gets a fast structured read:
  // [类型] 目标 ｜ 约束 ｜ 期望产物 — APPENDED to ctx.userIntent so the conversation's intent
  // history accumulates. Fold-surviving (buildStateSummary) + restart-surviving (serializeCtx).
  // Skipped for sub-brains (machine-authored goals); fail-safe inside parseUserIntent: an LLM
  // hiccup degrades to recording the raw goal — the gate never blocks a run.
  const runIntentGate = async (utterance: string): Promise<boolean> => {
    if (opts.isSubAgent || !isGatewayConfigured() || !utterance.trim()) return false;
    const before = ctx.userIntent;
    ctx.userIntent = await parseUserIntent(redactAuthorizationText(utterance), ctx.userIntent);
    if (ctx.userIntent && ctx.userIntent !== before) {
      const latest = ctx.userIntent.split("\n").pop() ?? ctx.userIntent;
      emit({ t: "reflect", kind: "intent", lesson: `意图理解：${latest.replace(/^\+\s*/, "")}` });
      return true;
    }
    return false;
  };
  if (!goalRoutedToClarify && !isRecoveryResume) await runIntentGate(opts.goal);

  // ── #POLICY 前置自适应路由 — 意图门之后、任何工具调用之前，按【问题类型】选流水线形状 +
  // 档位偏置（analyze/question 降 fast 省钱）。#NATIVE 修订：规模/难度/历史教训只作为【事实
  // 与建议】注入上下文（下方 guide 消息），分治深度（understand/critique 的 deep 参数）由 AI
  // 原生决定——不再由本体规模阈值确定性强制。对 sub-brain 跳过（机器目标，无需分诊）。
  // #POLICY-REROUTE — 路线【不是开场一次性定死的】。任何一次真实的用户表态（开场目标、
  // 澄清门里的回答）都可能改变本次请求的性质（真实事故：开场问「你能生成哪个agent?」→ 判
  // [提问] → analyze 路线注入「【不要】进入生成流水线」；用户随后答「A」= 要生成 createJD，
  // 但路线从不重算，那条禁令终身有效 → 大脑把「A」缝进过期路线，得出「选择了方向A：继续
  // 只做分析」）。所以把分诊做成【可重入】：意图门 + 路由是一个函数，每次新表态都重跑一遍，
  // 由 AI 的意图解析自己决定路线，而不是让第一句话的分诊永久生效。
  const applyPolicyRoute = async (reroute: boolean): Promise<void> => {
    if (opts.isSubAgent) return;
    const difficulty = estimateDifficulty(ctx.ontology);
    // #AMBIGUITY-COUNT — read the count understand_ontology RECORDED, not a regex over its prose.
    // The old `/(\d+)\s*处歧义/` scrape was inverted: no successful writer of ontologyUnderstanding
    // ever emits that literal (it lives in tool summaries), so the count was 0 on every healthy
    // path and non-zero ONLY when synthesis failed and fell back to stitching specialist summaries
    // together — i.e. the ask_first route could fire only on the degraded path. 首轮（还没理解）为 0。
    const ambiguityCount = ctx.ontologyAmbiguityCount ?? 0;
    const intentKind = classifyIntentKind(ctx.userIntent);
    let policy = selectPolicy({ intentKind, difficulty, hasSpecs: ctx.specs.length > 0, ambiguityCount });
    // #POLICY-LEARN — 历史 arm 统计做证据偏置（保真差→强制深评；fast 答疑砸→撤降档）。best-effort。
    const stats = (await ctx.ports.policyStats?.load(opts.domain)) ?? null;
    policy = adjustPolicyWithStats(policy, stats, difficulty.band);
    const prior = ctx.policy?.pipeline;
    ctx.policy = { ...policy, band: difficulty.band };
    // #REASONING-KERNEL — the intent's DEFAULT reasoning method (executed via the kernel, not react-by-
    // default). analyze/question/report answers deliberate via cot at answer time (Phase-3b routing);
    // generate/modify keep the ambient react tool loop but run methods/combos via select_strategy.
    ctx.reasoningDefault = (intentKind === "analyze" || intentKind === "question" || intentKind === "report") ? "cot" : "react";
    emit({ t: "policy", pipeline: policy.pipeline, strategy: policy.strategy, band: difficulty.band, deepUnderstand: policy.deepUnderstand, deepCritique: policy.deepCritique, tierBias: policy.tierBias, reasons: policy.reasons });
    // #POLICY-ADVISORY — 分诊的产物是【事实 + 建议】，不是【命令】。这条 #NATIVE 原则本来只用在
    // "难度/规模不得强制深读"上（见上方注释），但 analyze/skinny 的路线文案当初仍写着「【不要】
    // 进入生成流水线 / 【不要】create_plan」——一个由【一行意图标签】驱动的确定性 if/else，却对
    // AI 下禁令。真实事故：开场问句被判 [提问] → 该禁令注入 → 用户随后选「生成 createJD」，AI 仍
    // 服从禁令、答"继续只做分析"。现在三条路线文案统一改成"分诊读到什么(事实) + 通常怎么做(建议)
    // + 判断不符就按你自己的来(决定权归 AI)"，把 #NATIVE 迁移做完。
    // 注意：这【不】削弱真正的安全网——阶段闸门(stageAdmission)、验收门、接地校验都在结构层，
    // 它们要的是【真实证据】而非"替 AI 选路线"，一行没动。
    // 「没被要求就别造」这条用户原则也没丢：它作为【原则】留在文案里（system-prompt 本来就有），
    // 只是不再伪装成一条随分诊冻结、比用户新指令更长寿的路线锁。
    // #NATIVE — full 路线也注入一条【事实与建议】（决定权在 AI）：难度事实、经验回喂的深评建议
    // （policy-learning 的 deepCritique 现在只经这里到达 AI，不再被工具强制消费）。
    const suggests = [
      policy.deepUnderstand ? "understand_ontology 建议 deep=true" : null,
      policy.deepCritique ? "critique_plan 建议 deep=true（历史保真教训）" : null,
    ].filter(Boolean);
    const guide =
      policy.pipeline === "analyze"
        ? "[前置分诊·事实与建议] 意图门把用户这次的表态读成【只读分析/答疑】。这是一次【基于用户原话的快速分诊，不是命令】——你在对话里看到的东西比它多，判断不符就按你自己的判断走，不必迁就它。\n可用的手段（供你选，不是清单）：用 read_ontology/understand_ontology 取真实事实；用 select_strategy 真跑 cot（有争议/高风险可 debate）推导答案，而不是凭印象直接说；用户要的是【流程图/事件流/蓝图】这类图而非可运行 agent 时，build_blueprint 会逐阶段跑 cot 细化业务逻辑并渲染成图（要只画其中几个动作就传 actions），要存档再 generate_report。\n一条来自用户的、始终有效的原则（不是本路线特有的）：【没被要求生成/部署时，别自作主张跑生成流水线去造用户没要的东西】。反过来，用户一旦表达出要开始做，那就是授权，立即转生成路线。服务端 generation scope（actionIds/scenario）就是本次完整验收全集，create_plan 按 full 规划并在测试、沙箱跑通后 finish；只有无 generation scope 的旧对话临时只做部分设计稿时才用 scope=partial + save_draft。授权看【意思】不看字面：「继续」「开始生成」「按你建议的做」是授权；【用户在你刚给出的选项/方案里选定了其中一个】（哪怕只回一个「A」「第一个」「就这个」）同样是授权，你自己提的选项自己认账，别把用户的选定重新解释成「他想继续分析」。拿不准他选的是哪个，就 ask_user 复述选项确认，别自己挑一个解释。"
        : policy.pipeline === "skinny"
          ? "[前置分诊·事实与建议] 意图门把这次读成【修改请求】，且本次会话已有设计成果（不是从零开始）。这是分诊的判断，不是命令——不符就按你自己的判断走。\n通常更省事的做法：定位目标 agent → refine_agent 定点修 → validate_graph（必要时 sandbox_run）验证；返工类子问题可以 select_strategy 真跑 reflection（产出→自评→重写）。既然已有成果，create_plan 全量重造多半是浪费——但如果你判断这次改动确实动了整体分解（比如要增删 agent、事件链变了），那就该重新规划，别为了迁就这条建议硬做定点修。"
          : policy.pipeline === "ask_first"
            ? "[前置分诊·事实与建议] 本体理解阶段标出了多处歧义（这是事实）。建议：先 ask_user 把最关键的 1-2 处澄清掉（给具体选项）再进入设计，免得设计建在猜测上。哪些歧义真的挡路、要不要现在问、还是先做能确定的部分，由你判断。"
            : `[推理路线] 完整生成路线。推理【不默认 ReAct】——select_strategy 现在会【真的执行】你选的方法/组合：例如 tot→debate→reflection 会真跑「tot 分叉打分剪枝 → debate 多方论证+评委 → reflection 自评重写」，并把上一步产出喂给下一步，最后把结论回给你用。按子问题/意图选：高风险裁决/finish → debate；复杂设计 → tot；返工 → reflection；纯分析 → cot；边做边探 → react（=主工具循环，无需额外跑）。分治深度（understand_ontology/critique_plan 的 deep 参数）同样由你定。参考事实：${policy.reasons.slice(-3).join("；")}${suggests.length ? `；${suggests.join("；")}` : ""}`;
    // #POLICY-REROUTE — 重路由时，旧的 [推理路线] 指令还原样躺在 transcript 里（且会被折叠
    // 快照逐字重述）。不作废它，两条互相矛盾的指令会同时在场，大脑多半听更早那条（本案就是）。
    // 所以路线变了就【显式宣告作废】——这是陈述事实（哪条现在有效），不是替 AI 做决定。
    // 路线变了：先【物理剪掉】旧的 [推理路线] 指令（#POLICY-PRUNE 同款——留着它，两条互相
    // 矛盾的指令同时在场，模型多半服从更早那条，本案就是），再宣告切换、注入新路线。
    // 路线没变则什么都不做：重复推同一条指令只是上下文噪音。
    const routeChanged = reroute && prior && prior !== policy.pipeline;
    if (routeChanged) {
      prunePolicyGuides();
      messages.push({ role: "user", content: `[推理路线·已更新] 用户刚才的表态改变了本次请求的性质：路线从「${prior}」切换为「${policy.pipeline}」。此前那条 [推理路线] 指令（含其中的「不要…」禁令）【已作废并移除】，以下面这条新的为准。` });
      emit({ t: "message", text: `🔀 你的回答改变了本次请求的性质——推理路线已从「${prior}」切到「${policy.pipeline}」。` });
    }
    if (guide && (!reroute || routeChanged)) messages.push({ role: "user", content: guide });

    // #BUILTIN-SKILLS (P1-5) — automatic skill recall at goal time: deterministic matching over
    // goal+intent, seeded library + learned (stored) skills, top fragments injected as BACKGROUND.
    // Best-effort: recall must never block a run.
    try {
      const recallText = `${opts.goal}\n${ctx.userIntent ?? ""}`;
      const learned = ctx.ports.skills ? await ctx.ports.skills.list(opts.domain) : [];
      const matches = [
        ...matchBuiltinSkills(recallText, { pipeline: policy.pipeline, limit: 2 }),
        ...matchLearnedSkills(recallText, learned as Array<{ slug: string; name: string; purpose: string; promptFragment?: string; decisionRule?: string }>, 1),
      ];
      const frame = renderSkillRecall(matches);
      if (frame) {
        messages.push({ role: "system", content: frame });
        emit({ t: "message", text: `🧠 已按目标召回技能：${matches.map((m) => m.name).join("、")}（背景参考）。` });
      }
    } catch { /* recall is advisory */ }

    // #MEM-RECALL (P1-B) — Mem0 读路径：#MEM-WRITE 只写不读的另一半。goal+意图做查询、
    // BACKGROUND system 帧、best-effort 永不阻塞（无向量驱动/存储故障=静默跳过——与 settle 侧
    // consolidation 的 terminal 语义相反，召回是 advisory）。FACTORY_MEMORY_RECALL=0 关。
    if (process.env.FACTORY_MEMORY_RECALL !== "0" && ctx.ports.memory) {
      try {
        const recallQuery = `${opts.goal}\n${ctx.userIntent ?? ""}`.slice(0, 2000);
        const domainHits = await ctx.ports.memory.search(opts.domain, recallQuery, 5);
        // #MEM-GENERAL — 通用道二次查询（k=3），各自 advisory：通用道故障不拖累本域召回。
        let generalHits: Array<{ key: string; value: string; score: number }> = [];
        try {
          generalHits = await ctx.ports.memory.search(GENERAL_MEMORY_SUBJECT, recallQuery, 3);
        } catch { /* general lane is advisory too */ }
        const memFrame = renderMemoryRecall(
          [...domainHits, ...generalHits.map((h) => ({ ...h, general: true }))].sort((a, b) => b.score - a.score),
        );
        if (memFrame) {
          // reroute 重进时只保留最新一帧（#POLICY-PRUNE 同款物理移除，防重复帧堆积）。
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === "system" && typeof m.content === "string" && m.content.startsWith(MEMORY_RECALL_PREFIX)) messages.splice(i, 1);
          }
          messages.push({ role: "system", content: memFrame });
          emit({ t: "message", text: `🗂 已召回本域长期记忆 ${memFrame.split("\n").length - 1} 条（背景参考）。` });
        }
      } catch { /* recall is advisory — a missing vector driver or store outage never blocks a run */ }
    }
  };
  if (!goalRoutedToClarify && !isRecoveryResume) await applyPolicyRoute(false);

  let finishedOk = false;
  // COMPLETION GUARD: the brain must design ALL Agent actions before stopping. When it
  // chats mid-generation (no tool call) with coverage still incomplete, nudge it on
  // instead of ending the run. Budget resets on real progress (a new agent designed),
  // so only a genuinely stuck brain hits the cap.
  let incompleteNudges = 0;
  let nudgeBaselineSpecs = 0;
  // A server generation directive is an explicit Build contract, not an
  // informational chat.  Before the first spec exists, a model can still try
  // to end the run with a prose report/question (including punctuation-free
  // endings such as “等你。”).  Give it a small, bounded opportunity to enter
  // the deterministic readiness/authoring path; if it keeps refusing, stop
  // honestly instead of misclassifying the run as a completed answer.
  let preAuthoringTextRefusals = 0;
  const MAX_PRE_AUTHORING_TEXT_REFUSALS = 3;
  let generationStalledBeforeAuthoring = false;
  // #ASK-PARK v2 — 纯文本以开放问题收尾时【合成一次真正的澄清挂起】（不再只提醒一次就让运行继续/
  // 收尾 incomplete）。autoParkCount 是上限，避免模型反复空问导致死挂。
  let autoParkCount = 0;
  const AUTO_PARK_MAX = Math.max(1, Number(process.env.FACTORY_AUTO_PARK_MAX) || 8);
  // #REASONING-KERNEL Phase-3b — analyze/question answers are deliberated through the kernel (cot) once
  // per run, so an intent-driven reasoning shape (not raw react) actually produces the answer.
  let answerDeliberated = false;
  let erroredOut = false;
  // #LEARN-NONFATAL — 学习类收尾（技能评估 / 自动反思 / 记忆整合 / 策略统计）失败
  // 不再把整次运行判为 errored。这四处原本都置 erroredOut=true，本意是「不许声称
  // 学到了其实没落库的东西」——但代价下错了：它们全部跑在【交付之后】，一次快档
  // 摘要调用抖动就能把一个已设计、已落盘、沙箱已验证的 build 翻成 errored，
  // 上游 OntoCode 随即按 factory_build_incomplete 丢掉候选包。
  // 保留响亮（照旧发 error 事件、计数并在 done 里报出），但不改判交付事实。
  const learningFailures: string[] = [];
  let budgetStopped = false;
  let finishRefusals = 0;
  let sawReflect = false;
  let parkTicks = 0;
  let humanWaitSuspended = false;
  // #AUDIT-FIX(H5) — park 超时节拍 env 可配；批准/边界门超时【挂起】而非自动拍板（见各门）。
  const PARK_MAX_TICKS = Math.max(10, Number(process.env.FACTORY_PARK_MAX_TICKS) || 150);
  const PARK_POLL_MS = Math.max(10, Number(process.env.FACTORY_PARK_POLL_MS) || 1_200);
  // A mailbox drain is a durable LEASE, not an acknowledgement. We only ack a
  // delivery after a conversation checkpoint contains its processed effect (or
  // its routed pending envelope). This closes the same-process crash window where
  // the next drain used to delete a human decision before it had been persisted.
  const seenHumanDeliveries = new Set<string>();
  const leasedHumanDeliveries = new Set<string>();
  const checkpointableHumanDeliveries = new Set<string>();
  const leaseHumanMessages = async (): Promise<FactoryHumanMessage[]> => {
    if (!opts.conversationId) return [];
    const drained = (await opts.ports.conversation.drainHumanMessages(opts.conversationId)).map(normalizeHumanMessage);
    const deliveryIds = [...new Set(drained.map((message) => message.deliveryId).filter((id): id is string => Boolean(id)))];
    if (deliveryIds.length && !opts.ports.conversation.ackHumanMessages) {
      throw new Error("durable human mailbox returned delivery ids but has no acknowledgement implementation");
    }
    const checkpointed = new Set(ctx.checkpointedHumanDeliveries ?? []);
    const newlyLeased = new Set<string>();
    for (const deliveryId of deliveryIds) {
      if (seenHumanDeliveries.has(deliveryId)) continue;
      seenHumanDeliveries.add(deliveryId);
      if (checkpointed.has(deliveryId)) {
        // The prior process saved this delivery's effects and died before ack.
        // Complete that idempotent ack now; never feed it to the model twice.
        await opts.ports.conversation.ackHumanMessages!(opts.conversationId, deliveryId);
        continue;
      }
      leasedHumanDeliveries.add(deliveryId);
      newlyLeased.add(deliveryId);
    }
    return drained.filter((message) => !message.deliveryId || newlyLeased.has(message.deliveryId));
  };
  const markHumanMessagesCheckpointable = (human: FactoryHumanMessage[]): void => {
    for (const deliveryId of human.map((message) => message.deliveryId)) {
      if (deliveryId && leasedHumanDeliveries.has(deliveryId)) checkpointableHumanDeliveries.add(deliveryId);
    }
  };
  const checkpointConversation = async (): Promise<void> => {
    if (!opts.conversationId) return;
    const ready = [...checkpointableHumanDeliveries];
    const priorCheckpointed = ctx.checkpointedHumanDeliveries;
    if (ready.length) {
      ctx.checkpointedHumanDeliveries = [...new Set([...(priorCheckpointed ?? []), ...ready])].slice(-100);
    }
    try {
      await opts.ports.conversation.save(opts.conversationId, {
        domain: opts.domain,
        messages: serializeMessages(messages),
        ctx: serializeCtx(ctx),
      });
    } catch (error) {
      ctx.checkpointedHumanDeliveries = priorCheckpointed;
      throw error;
    }
    for (const deliveryId of ready) {
      await opts.ports.conversation.ackHumanMessages!(opts.conversationId, deliveryId);
      checkpointableHumanDeliveries.delete(deliveryId);
      leasedHumanDeliveries.delete(deliveryId);
    }
  };
  const opensHumanInteraction = (event: BrainEvent): boolean =>
    (event.t === "clarify" && event.awaitingAnswer)
    || (event.t === "test.cases" && event.awaitingApproval)
    || (event.t === "boundary.cases" && event.awaitingDecision);
  /** A card must never become clickable before its exact id is durable. */
  const checkpointBeforeHumanInteraction = async (event: BrainEvent): Promise<void> => {
    if (opensHumanInteraction(event)) await checkpointConversation();
  };
  /** One authoritative gate order shared with the Web interaction dock. A
   * clarification always wins; an approved-suite gate comes next; boundary
   * classification is last. `testDataSupplementPending` is an execution mode,
   * not a human approval wait. */
  const activeHumanGate = (): "clarify" | "approval" | "boundary" | null => {
    const kind = activeHumanInteractionKind(ctx);
    return kind === "test_approval" ? "approval" : kind;
  };

  /** Resolve only the low-risk interaction classes that OntoCode explicitly
   * delegated. Dedicated authorization challenges and credential/production
   * side-effect questions are rejected by resolveAutopilotClarification and
   * remain normal durable human gates. */
  const applyPendingAutopilotGate = (): boolean => {
    if (opts.isSubAgent || ctx.interactionPolicy !== "autopilot") return false;
    const gate = activeHumanGate();
    if (gate === "clarify" && ctx.clarifyPrompt) {
      const prompt = ctx.clarifyPrompt;
      const automatic = resolveAutopilotClarification(ctx, prompt);
      if (!automatic) return false;
      const resolved = closeHumanInteraction(ctx, "clarify");
      ctx.awaitingClarify = false;
      ctx.clarifyPrompt = undefined;
      ctx.pendingIntegrationBoundaryAsk = undefined;
      (ctx.askedQuestions ??= {})[normalizeQuestion(prompt.question)] =
        automatic.answer;
      messages.push({
        role: "system",
        content: `[Autopilot assumption ${automatic.assumption.id}] 针对「${prompt.question}」采用：${automatic.answer}。这是可审计默认，不是人工授权；不得据此启用凭证、外部副作用或生产写入。`,
      });
      emit({
        t: "clarify",
        question: prompt.question,
        options: prompt.options,
        context: prompt.context,
        awaitingAnswer: false,
        interactionId: resolved?.interactionId,
      });
      if (
        isTestFixtureClarification(prompt.question, prompt.context ?? "") &&
        automatic.answer === "用占位"
      ) {
        ctx.testDataSupplementPending = false;
        const testApprovalBlock = autopilotTestApprovalBlockReason(ctx);
        ctx.awaitingApproval = testApprovalBlock !== null;
        if (testApprovalBlock === null) {
          const assumption = recordFactoryAssumption(ctx, {
            gate: "test_approval",
            subject: `沿用当前测试用例集（${(ctx.testCases ?? []).map((testCase) => testCase.id).join(",")}）`,
            value: "approve",
            source: "safe_default",
            detail:
              "测试联系/ID 字段沿用 sandbox 占位值；覆盖完整、无待处理授权、无外部写。",
          });
          emit({
            t: "test.cases",
            cases: ctx.testCases ?? [],
            awaitingApproval: false,
            coverage: ctx.testCoverage,
          });
          emit({
            t: "test.decision",
            decision: "approve",
            note: `autopilot assumption ${assumption.id}`,
          });
        } else {
          emit({
            t: "test.cases",
            cases: ctx.testCases ?? [],
            awaitingApproval: true,
            coverage: ctx.testCoverage,
          });
          messages.push({
            role: "system",
            content: `[Autopilot safety gate] 占位测试数据已采用，但测试执行仍需人工确认（${testApprovalBlock}）；不得创建覆盖豁免或继续 sandbox_run。`,
          });
        }
      }
      return true;
    }
    if (
      gate === "approval" &&
      ctx.awaitingApproval &&
      !ctx.testDataSupplementPending
    ) {
      const block = autopilotTestApprovalBlockReason(ctx);
      if (block) return false;
      const interaction = closeHumanInteraction(ctx, "test_approval");
      ctx.awaitingApproval = false;
      const assumption = recordFactoryAssumption(ctx, {
        gate: "test_approval",
        subject: `执行当前测试用例集（${(ctx.testCases ?? []).map((testCase) => testCase.id).join(",")}）`,
        value: "approve",
        source: "safe_default",
        detail: "覆盖矩阵完整、无待处理授权、无外部写",
      });
      emit({
        t: "test.cases",
        cases: ctx.testCases ?? [],
        awaitingApproval: false,
        interactionId: interaction?.interactionId,
        coverage: ctx.testCoverage,
      });
      emit({
        t: "test.decision",
        decision: "approve",
        interactionId: interaction?.interactionId,
        note: `autopilot assumption ${assumption.id}`,
      });
      messages.push({
        role: "system",
        content: `[Autopilot assumption ${assumption.id}] 当前测试用例集已按安全默认批准，可继续 sandbox_run；这不构成任何独立授权挑战或生产写授权。`,
      });
      return true;
    }
    if (gate === "boundary") {
      const proposals = ctx.boundaryProposals ?? [];
      const unique =
        proposals.length > 0 &&
        new Set(proposals.map((proposal) => proposal.event)).size ===
          proposals.length &&
        proposals.every(
          (proposal) =>
            proposal.suggestedKind === "external" ||
            proposal.suggestedKind === "terminal",
        );
      if (!unique) return false;
      const interaction = closeHumanInteraction(ctx, "boundary");
      const decided: BoundaryEvent[] = proposals.map((proposal) => ({
        event: proposal.event,
        kind: proposal.suggestedKind,
        ...(proposal.consumer ? { consumer: proposal.consumer } : {}),
        ...(proposal.payloadContract
          ? { payloadContract: proposal.payloadContract }
          : {}),
        note: `Autopilot 采用唯一建议分类：${proposal.why}`.slice(0, 500),
      }));
      const byEvent = new Map(
        (ctx.boundaryEvents ?? []).map((boundary) => [
          boundary.event,
          boundary,
        ]),
      );
      for (const boundary of decided) byEvent.set(boundary.event, boundary);
      ctx.boundaryEvents = [...byEvent.values()];
      ctx.awaitingBoundary = false;
      ctx.boundaryProposals = undefined;
      ctx.lastValidation = null;
      const assumption = recordFactoryAssumption(ctx, {
        gate: "boundary",
        subject: `边界事件分类：${decided.map((boundary) => boundary.event).join("、")}`,
        value: JSON.stringify(
          decided.map((boundary) => ({
            event: boundary.event,
            kind: boundary.kind,
          })),
        ),
        source: "recommended",
        detail: "只自动采用唯一 external/terminal 建议；break 保持人工门。",
      });
      emit({
        t: "boundary.cases",
        proposals,
        awaitingDecision: false,
        interactionId: interaction?.interactionId,
      });
      emit({
        t: "boundary.decided",
        events: decided,
        interactionId: interaction?.interactionId,
      });
      messages.push({
        role: "system",
        content: `[Autopilot assumption ${assumption.id}] 已采用唯一边界分类并使旧校验证据失效；现在重新 validate_graph。`,
      });
      return true;
    }
    return false;
  };

  try {
    // #W2 — duplicate-call breaker state (consecutive same tool+args).
    let lastToolSig = "";
    let dupCount = 0;
    // #W2-STAGE — current stage for token attribution + one-shot budget steers.
    let currentStage: FactoryStage = "read";
    const stageBudgetWarned = new Set<string>();
    brainLoop: for (let turn = 0; turn < MAX_TURNS; turn++) {
      // #W1-1 — re-assert THIS run's telemetry context every turn (concurrent runs share the module
      // global; per-turn re-assert + per-call entry snapshot bounds misattribution to a same-instant race).
      setLlmCallContext({ conversationId: opts.conversationId, domain: opts.domain });
      if (opts.signal?.aborted) break;
      if (applyPendingAutopilotGate()) {
        await checkpointConversation();
      }

      // Upgrade a legacy checkpoint that predates addressed interactions by
      // re-emitting its still-pending card with a fresh one-shot id. No answer
      // is accepted until this id has itself been checkpointed and shown.
      if (!opts.isSubAgent && activeHumanGate() && !activeHumanInteraction(ctx)) {
        const kind = activeHumanInteractionKind(ctx);
        if (kind === "clarify" && ctx.clarifyPrompt) {
          emit({
            t: "clarify",
            question: ctx.clarifyPrompt.question,
            options: ctx.clarifyPrompt.options,
            context: ctx.clarifyPrompt.context,
            awaitingAnswer: true,
          });
        } else if (kind === "test_approval") {
          emit({ t: "test.cases", cases: ctx.testCases ?? [], awaitingApproval: true, coverage: ctx.testCoverage });
        } else if (kind === "boundary") {
          emit({ t: "boundary.cases", proposals: ctx.boundaryProposals ?? [], awaitingDecision: true });
        }
        await checkpointConversation();
        while (buffer.length) yield buffer.shift()!;
      }
      // Initialization/resume reconciliation can emit a user-visible safety
      // notice before the first model/tool turn. A parked gate may suspend
      // below, so flush it now rather than losing it behind the wait loop.
      while (buffer.length) {
        const event = buffer.shift()!;
        await checkpointBeforeHumanInteraction(event);
        yield event;
      }

      // #9: once read_ontology has loaded the ontology, re-resolve the language from its CONTENT
      // (under `auto`) and refresh the system prompt if it changed — fixes a fresh run on a
      // Chinese-content domain whose slug is ASCII (which would otherwise stay English).
      if (!langFromOntology && ctx.ontology) {
        langFromOntology = true;
        const l2 = resolveBrainLang(opts.domain, ctx.ontology);
        if (l2 !== lang && messages[0]?.role === "system") {
          lang = l2;
          messages[0] = { role: "system", content: systemPrompt(opts.domain, priorReflections, lang) };
        }
      }

      // #W2-HITL — gate tag routing: a drained message TAGGED for a DIFFERENT gate must be
      // RE-QUEUED (ctx.pendingHuman), never consumed by the wrong gate. Before this fix the clarify
      // gate's "any free text counts" greedily ate [测试用例决策]/[边界事件决策] messages → the right
      // gate then timed out into its auto-fallback (wrong decision).
      const GATE_TAG = { approval: isTestCaseDecisionTaggedMessage, boundary: /^\[边界事件决策\]/, clarify: /^\[澄清回答\]/ };
      const expectedTextKind = (text: string): FactoryHumanInteractionKind | null =>
        GATE_TAG.clarify.test(text)
          ? "clarify"
          : GATE_TAG.approval(text)
            ? "test_approval"
            : GATE_TAG.boundary.test(text)
              ? "boundary"
              : null;
      const drainRouted = async (): Promise<{
        accepted: FactoryHumanMessage[];
        rejected: Array<{ message: FactoryHumanMessage; reason: string }>;
        all: FactoryHumanMessage[];
      }> => {
        const fresh = await leaseHumanMessages();
        const all = [...(ctx.pendingHuman ?? []).map(normalizeHumanMessage), ...fresh];
        ctx.pendingHuman = [];
        const interaction = activeHumanInteraction(ctx);
        const accepted: FactoryHumanMessage[] = [];
        const rejected: Array<{ message: FactoryHumanMessage; reason: string }> = [];
        let acceptedReply = false;
        for (const message of all) {
          if (isStopIntent(message.text)) {
            accepted.push(message);
            continue;
          }
          // Custom/legacy unit ports without a durable delivery identity remain
          // source-compatible. Every real durable delivery is strict.
          const customLegacy = !message.deliveryId && !message.interactionId && !message.gateKind;
          const textKind = expectedTextKind(message.text);
          if (!interaction) {
            rejected.push({ message, reason: "当前没有可安全匹配的人工交互编号" });
          } else if (!customLegacy && message.interactionId !== interaction.interactionId) {
            rejected.push({ message, reason: "这条回复属于已经结束或被替换的旧交互" });
          } else if (!customLegacy && message.gateKind !== interaction.kind) {
            rejected.push({ message, reason: "回复类型与当前正在等待的交互不一致" });
          } else if (textKind !== interaction.kind && !(customLegacy && textKind === null)) {
            rejected.push({ message, reason: "回复内容的类型与当前交互不一致" });
          } else if (acceptedReply) {
            rejected.push({ message, reason: "这个交互已经收到一条回复，重复回复没有采用" });
          } else {
            acceptedReply = true;
            accepted.push(customLegacy && textKind === null && interaction.kind === "clarify"
              ? { ...message, text: `[澄清回答] ${message.text}` }
              : message);
          }
        }
        return { accepted, rejected, all };
      };

      // TEST-CASE APPROVAL GATE — if the brain proposed test cases, PARK here (poll the
      // mailbox, no LLM turn consumed) until the user clicks 执行/重新生成. The run is in
      // the background, so parking survives navigation — the user can return and decide.
      if (!opts.isSubAgent && activeHumanGate() === "approval" && opts.conversationId) {
        const routed = await drainRouted();
        const human = routed.accepted;
        for (const rejected of routed.rejected) {
          yield { t: "message", text: `ℹ️ ${rejected.reason}，所以没有把它当作当前测试用例确认。请使用现在显示的交互卡重新提交。` };
        }
        let decided: null | { decision: "approve" | "regenerate" | "supply_data"; note: string; raw: string } = null;
        let invalidGateReply = false;
        const hardStop = human.some((message) => isStopIntent(message.text));
        if (hardStop) {
          ctx.humanDirectives.push("用户请求停止本次运行");
          messages.push({ role: "user", content: "[人工介入] 用户请求停止本次运行。" });
        } else {
          for (const humanMessage of human) {
            const text = humanMessage.text;
            const parsedDecision = parseTestCaseDecision(text);
            if (parsedDecision) {
              decided = {
                decision: parsedDecision.decision,
                note: parsedDecision.note,
                raw: parsedDecision.raw,
              };
            } else {
              invalidGateReply = true;
            }
          }
        }
        if (hardStop) {
          markHumanMessagesCheckpointable(routed.all);
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（等待中的确认已取消，已生成的内容保留）。" };
          ctx.awaitingApproval = false;
          closeHumanInteraction(ctx, "test_approval");
          break;
        }
        if (invalidGateReply) {
          closeHumanInteraction(ctx, "test_approval");
          emit({ t: "test.cases", cases: ctx.testCases ?? [], awaitingApproval: true, coverage: ctx.testCoverage });
          markHumanMessagesCheckpointable(routed.all);
          await checkpointConversation();
          while (buffer.length) yield buffer.shift()!;
          yield { t: "message", text: "这条测试用例回复格式不完整，系统没有执行任何沙箱操作。已生成一个新的确认卡，请重新选择。" };
          turn--;
          continue;
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          markHumanMessagesCheckpointable(routed.all);
          // #AUDIT-FIX(H5) — 旧行为在超时后自动按「执行」触发真实部署（用户从未批准，且可能
          // 正是为了阻止部署才停下）。现在：挂起运行、保留 park 状态，等用户回来决定；恢复
          // 会话时 H3 调和逻辑接手。绝不自动选择风险更高的一侧。
          parkTicks = 0;
          humanWaitSuspended = true;
          yield { t: "message", text: "⏸ 测试用例确认等待超时——运行已挂起（不会自动执行部署）。回来后点【执行/重新生成】或直接发消息即可继续。" };
          break;
        }
        if (!decided) {
          markHumanMessagesCheckpointable(routed.all);
          // Persist routed/invalid input and ack its lease before polling again.
          // Otherwise that inflight batch would block a newer, correct gate reply.
          if (checkpointableHumanDeliveries.size) await checkpointConversation();
          parkTicks++;
          await new Promise((r) => setTimeout(r, PARK_POLL_MS));
          turn--;
          continue; // poll again without consuming a turn
        }
        parkTicks = 0;
        if (decided.decision === "approve") {
          const uncovered = normalizeCoverageCells(ctx.testCoverage?.uncoveredNeedingData ?? []);
          if (uncovered.length) {
            const waivedCells = parseCoverageWaiverTag(decided.note);
            if (!waivedCells || !coverageWaiverMatches(uncovered, { cells: waivedCells })) {
              // Re-emit the gate so clients that optimistically hid the submitted card receive a
              // fresh actionable interaction.  No decision/memory is persisted and no sandbox is
              // started: ordinary approval is not consent to skip data-dependent coverage.
              closeHumanInteraction(ctx, "test_approval");
              emit({ t: "test.cases", cases: ctx.testCases ?? [], awaitingApproval: true, coverage: ctx.testCoverage });
              markHumanMessagesCheckpointable(routed.all);
              await checkpointConversation();
              yield {
                t: "message",
                text: `🛑 仍有 ${uncovered.length} 个需真实数据的覆盖格未命中（${uncovered.join("、")}）。请补齐用例，或在交互区逐项勾选并显式确认覆盖豁免；普通“执行”不会自动豁免。`,
              };
              while (buffer.length) yield buffer.shift()!;
              turn--;
              continue;
            }
            ctx.testCoverageWaiver = {
              cells: uncovered,
              note: decided.note.replace(/\[覆盖豁免:[^\]]+\]/, "").trim() || undefined,
              confirmedAt: Date.now(),
            };
          } else {
            ctx.testCoverageWaiver = undefined;
          }
        } else {
          ctx.testCoverageWaiver = undefined;
        }
        const testIds = (ctx.testCases ?? []).map((test) => test.id).join(",") || "current-suite";
        await persistHumanDecision(ctx, {
          kind: decided.decision === "supply_data" ? "directive" : "test_approval",
          question: decided.decision === "supply_data" ? `为测试用例集 ${testIds} 补数据` : `是否执行测试用例集 ${testIds}？`,
          answer: decided.raw,
          context: `decision=${decided.decision}${decided.note ? `; note=${decided.note}` : ""}`,
        });
        const resolvedInteraction = closeHumanInteraction(ctx, "test_approval");
        ctx.awaitingApproval = decided.decision === "supply_data";
        ctx.testDataSupplementPending = decided.decision === "supply_data";
        if (decided.decision === "supply_data") {
          ctx.lastSandbox = null;
          ctx.sandboxDesignReview = undefined;
        }
        let decisionNotice: string;
        if (decided.decision === "approve") {
          ctx.testDataSupplementPending = false;
          messages.push({ role: "user", content: "[测试用例决策] 用户已确认执行这批测试用例。现在调用 sandbox_run 真实部署并用这些用例触发跑通，然后让我看每个 agent 的真实输入/输出。" });
          decisionNotice = "✅ 你确认了用例——开始真实试运行。";
        } else if (decided.decision === "regenerate") {
          ctx.testDataSupplementPending = false;
          messages.push({ role: "user", content: `[测试用例决策] 用户要求重新生成测试用例${decided.note ? `，要求：${decided.note}` : ""}。请调用 generate_test_cases 重新设计一批给用户确认。` });
          decisionNotice = `🔄 你要求重做用例${decided.note ? `：${decided.note}` : ""}——重新生成中。`;
        } else {
          messages.push({ role: "user", content: `[测试用例决策] 用户选择为当前测试用例补数据${decided.note ? `，结构化要求：${decided.note}` : ""}。保留当前用例，不要运行 sandbox/finish；现在显式调用 supply_test_data。若资产不可用，用 ask_user 请用户在当前任务重新上传。工具更新后必须重新展示并等待批准。` });
          decisionNotice = "🧪 已进入补测试数据模式；旧批准与沙箱证据已失效，补完后会重新请你审查。";
        }
        markHumanMessagesCheckpointable(routed.all);
        // Persist and acknowledge the one-shot answer before the model can
        // turn this approval into sandbox or other downstream I/O.
        await checkpointConversation();
        yield { t: "test.decision", decision: decided.decision, interactionId: resolvedInteraction?.interactionId, note: decided.note || undefined };
        yield { t: "message", text: decisionNotice };
        // A higher-priority gate may have coexisted in a restored checkpoint.
        // Do not spend a model turn between human decisions.
        if (activeHumanGate()) {
          if (checkpointableHumanDeliveries.size) await checkpointConversation();
          turn--;
          continue;
        }
      }

      // BOUNDARY-EVENT GATE (mirrors the test-case gate). After the brain proposes boundary
      // events, PARK polling the mailbox until the user submits their per-event classification
      // (external handoff / terminal / break) + external contracts.
      if (!opts.isSubAgent && activeHumanGate() === "boundary" && opts.conversationId) {
        const routed = await drainRouted();
        const human = routed.accepted;
        for (const rejected of routed.rejected) {
          yield { t: "message", text: `ℹ️ ${rejected.reason}，所以没有把它当作当前边界分类。请使用现在显示的交互卡重新提交。` };
        }
        let decided: BoundaryEvent[] | null = null;
        let decisionRaw: string | null = null;
        let invalidGateReply = false;
        const hardStopB = human.some((message) => isStopIntent(message.text));
        if (hardStopB) {
          ctx.humanDirectives.push("用户请求停止本次运行");
          messages.push({ role: "user", content: "[人工介入] 用户请求停止本次运行。" });
        } else {
          for (const humanMessage of human) {
            const text = humanMessage.text;
            const m = text.match(/^\[边界事件决策\]\s*([\s\S]+)$/);
            if (m) {
              try {
                const parsed = JSON.parse(m[1]!.trim());
                if (Array.isArray(parsed)) {
                  decided = parsed
                    .filter((e) => e && typeof e === "object" && typeof e.event === "string")
                    .map((e) => ({
                      event: String(e.event),
                      kind: (["external", "terminal", "break"].includes(String(e.kind)) ? String(e.kind) : "external") as BoundaryEvent["kind"],
                      consumer: typeof e.consumer === "string" ? e.consumer : undefined,
                      payloadContract: typeof e.payloadContract === "string" ? e.payloadContract : undefined,
                      note: typeof e.note === "string" ? e.note : undefined,
                    }));
                  decisionRaw = text;
                } else invalidGateReply = true;
              } catch { invalidGateReply = true; }
            } else {
              invalidGateReply = true;
            }
          }
        }
        if (hardStopB) {
          markHumanMessagesCheckpointable(routed.all);
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（等待中的分类已取消，已生成的内容保留）。" };
          ctx.awaitingBoundary = false;
          closeHumanInteraction(ctx, "boundary");
          break;
        }
        if (invalidGateReply) {
          closeHumanInteraction(ctx, "boundary");
          emit({ t: "boundary.cases", proposals: ctx.boundaryProposals ?? [], awaitingDecision: true });
          markHumanMessagesCheckpointable(routed.all);
          await checkpointConversation();
          while (buffer.length) yield buffer.shift()!;
          yield { t: "message", text: "这条边界分类不是完整的列表，系统没有采用。已生成一个新的分类卡，请重新提交。" };
          turn--;
          continue;
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          markHumanMessagesCheckpointable(routed.all);
          // #AUDIT-FIX(M18) — 这个门存在的全部意义是「AI 提案、用户确认」；超时把 AI 初判当用户
          // 决定生效（直接影响断链判定与 finish）违背该原则。改为挂起等用户，恢复时 H3 接手。
          parkTicks = 0;
          humanWaitSuspended = true;
          yield { t: "message", text: "⏸ 边界事件确认等待超时——运行已挂起（不会按 AI 初判自动生效）。回来后提交分类或直接发消息即可继续。" };
          break;
        }
        if (!decided) {
          markHumanMessagesCheckpointable(routed.all);
          if (checkpointableHumanDeliveries.size) await checkpointConversation();
          parkTicks++;
          await new Promise((r) => setTimeout(r, PARK_POLL_MS));
          turn--;
          continue;
        }
        parkTicks = 0;
        const boundaryQuestion = `边界事件分类：${decided.map((entry) => entry.event).sort().join(",")}`;
        await persistHumanDecision(ctx, {
          kind: "boundary",
          question: boundaryQuestion,
          answer: decisionRaw ?? JSON.stringify(decided),
          context: JSON.stringify(decided),
        });
        const resolvedInteraction = closeHumanInteraction(ctx, "boundary");
        ctx.awaitingBoundary = false;
        ctx.boundaryProposals = undefined;
        const byEv = new Map((ctx.boundaryEvents ?? []).map((b) => [b.event, b]));
        for (const b of decided) byEv.set(b.event, b);
        ctx.boundaryEvents = [...byEv.values()];
        ctx.lastValidation = null; // re-validate honoring the new boundary classification
        const ext = decided.filter((b) => b.kind === "external");
        const brk = decided.filter((b) => b.kind === "break");
        messages.push({ role: "user", content: `[边界事件决策] 用户已分类：${decided.map((b) => `${b.event}=${b.kind}${b.consumer ? `(${b.consumer})` : ""}`).join("; ")}。${ext.length ? `把这些【外部交接】事件各总结成一份「对外契约」(事件名、payload 字段、触发时机、含义)用文字清晰呈现给我看,供下游消费方核对。` : ""}${brk.length ? `这些被判为【真断点】的事件(${brk.map((b) => b.event).join("、")})要你 refine_agent/补 agent 修。` : ""}外部/终态事件已不再算断点，继续推进。` });
        markHumanMessagesCheckpointable(routed.all);
        await checkpointConversation();
        yield { t: "boundary.decided", events: decided, interactionId: resolvedInteraction?.interactionId };
        yield { t: "message", text: `✅ 边界事件已确认(${ext.length} 外部交接 · ${decided.filter((b) => b.kind === "terminal").length} 终态 · ${brk.length} 待修断点)。` };
        if (activeHumanGate()) {
          if (checkpointableHumanDeliveries.size) await checkpointConversation();
          turn--;
          continue;
        }
      }

      // CLARIFICATION GATE (ask_user) — park polling the mailbox until the user answers (free
      // text via `[澄清回答] …`, or just a message). Mirrors the test-case / boundary gates.
      // A timeout suspends the run with the question still pending. A recommendation is advice,
      // never authorization for the model to answer its own question.
      if (!opts.isSubAgent && activeHumanGate() === "clarify" && opts.conversationId) {
        const routed = await drainRouted();
        const human = routed.accepted;
        for (const rejected of routed.rejected) {
          yield { t: "message", text: `ℹ️ ${rejected.reason}，所以没有把它当作当前问题的回答。请使用现在显示的交互卡重新提交。` };
        }
        let answer: string | null = null;
        const hardStopC = human.some((message) => isStopIntent(message.text));
        const untagged: Array<{ text: string; actor?: string }> = [];
        if (hardStopC) {
          ctx.humanDirectives.push("用户请求停止本次运行");
          messages.push({ role: "user", content: "[人工介入] 用户请求停止本次运行。" });
        } else {
          for (const humanMessage of human) {
            const text = humanMessage.text;
            const m = text.match(/^\[澄清回答\]\s*([\s\S]+)$/);
            if (m) untagged.push({ text: m[1]!.trim(), actor: humanMessage.actor });
          }
        }
        // #AUDIT-FIX(M16) — 多条自由回复【累积】为完整答案（旧逻辑只留最后一条，前面的静默丢弃）。
        if (untagged.length) answer = untagged.map((entry) => entry.text).join("\n");
        if (hardStopC) {
          markHumanMessagesCheckpointable(routed.all);
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（待答的问题保留，回来可继续）。" };
          break;
        }
        if (!answer && parkTicks >= PARK_MAX_TICKS) {
          markHumanMessagesCheckpointable(routed.all);
          // A missing human answer is a real blocker. In particular, ontology choices,
          // write probes, credentials and production boundaries must never be inferred from
          // the recommended option merely because nobody answered before the polling window.
          parkTicks = 0;
          humanWaitSuspended = true;
          const timeout = resolveClarificationTimeout(ctx.clarifyPrompt?.options);
          yield { t: "message", text: timeout.message };
          break;
        }
        if (!answer) {
          markHumanMessagesCheckpointable(routed.all);
          if (checkpointableHumanDeliveries.size) await checkpointConversation();
          parkTicks++;
          await new Promise((r) => setTimeout(r, PARK_POLL_MS));
          turn--;
          continue;
        }
        parkTicks = 0;
        const q = ctx.clarifyPrompt?.question ?? ""; // snapshot BEFORE clearing state (idempotent, matches the other gates)
        const clarificationOptions = ctx.clarifyPrompt?.options;
        const clarifyProposal = ctx.clarifyPrompt?.proposal ?? ""; // #ASK-PROPOSAL — 提问时的提案原文，clear 前快照
        const humanAnswerVerbatim = answer;
        // #ASK-FIX — 用户自由回复若命中某个选项的 label，规范化为该选项的 value（答案进入
        // 决策路径时统一是机器值；原文保留在给用户的回显里）。
        const hitOpt = ctx.clarifyPrompt?.options?.find((o) => o.label === answer || o.value === answer);
        if (hitOpt) answer = hitOpt.value;
        const clarifyContext = ctx.clarifyPrompt?.context ?? ""; // M20 用，clear 前快照
        const safeClarification = sanitizeClarificationAnswer(q, clarifyContext, answer);
        const safeHumanAnswer = sanitizeClarificationAnswer(q, clarifyContext, humanAnswerVerbatim).answer;
        const authorizationState = authorizationAnswerState(clarifyContext, safeClarification.answer);
        const modelVisibleAnswer = authorizationState ?? safeClarification.answer;
        const answerActors = [...new Set(untagged.map((entry) => entry.actor?.trim()).filter((actor): actor is string => Boolean(actor)))];
        const answerActor = answerActors.length === 1 && untagged.every((entry) => entry.actor?.trim() === answerActors[0])
          ? answerActors[0]
          : undefined;
        await persistHumanDecision(ctx, {
          kind: "clarify",
          question: q,
          answer: safeHumanAnswer,
          context: clarifyContext || undefined,
        });
        const resolvedInteraction = closeHumanInteraction(ctx, "clarify");
        ctx.awaitingClarify = false;
        ctx.clarifyPrompt = undefined;
        // #HUMAN-BOUNDARY — SERVER-side consumption: the integration gate recorded the exact
        // (system, mode) pairs its card asked about; an affirmative 人工边界 answer confirms THOSE
        // pairs (never a model-supplied list). Any answer clears the pending ask — a later design
        // attempt re-derives and re-asks whatever is still genuinely missing.
        const pendingBoundaryAsk = ctx.pendingIntegrationBoundaryAsk;
        if (pendingBoundaryAsk?.length) {
          ctx.pendingIntegrationBoundaryAsk = undefined;
          const confirmedBoundaries = consumeIntegrationBoundaryAnswer(pendingBoundaryAsk, humanAnswerVerbatim, {
            ...(resolvedInteraction?.interactionId ? { interactionId: resolvedInteraction.interactionId } : {}),
            ...(answerActor ? { actor: answerActor } : {}),
            confirmedAt: Date.now(),
          });
          if (confirmedBoundaries) {
            const replaced = new Set(confirmedBoundaries.map((entry) => `${entry.system} ${entry.mode}`));
            ctx.integrationHumanBoundaries = [
              ...(ctx.integrationHumanBoundaries ?? []).filter((entry) => !replaced.has(`${entry.system} ${entry.mode}`)),
              ...confirmedBoundaries,
            ];
            messages.push({ role: "user", content: `[服务端确认] 已把 ${confirmedBoundaries.map((entry) => `${entry.system}/${entry.mode}`).join("、")} 记录为【人工边界】（含交互卡审计）。设计可继续，把它们如实保留为 human_boundary 绑定；沙箱/交付/晋升仍会按未接通拦截，不要再就这些系统重复提问。` });
          }
        }
        ctx.humanDirectives.push(`澄清「${q}」→ ${modelVisibleAnswer}`);
        // #ASK-DEDUP — 记住"这个问题已经答过"：同一问题再被 ask_user 时直接回放答案，不再打断用户。
        (ctx.askedQuestions ??= {})[normalizeQuestion(q)] = modelVisibleAnswer;
        (ctx.clarificationAnswerEvidence ??= {})[normalizeQuestion(q)] = {
          question: q,
          ...(clarifyContext ? { context: clarifyContext } : {}),
          ...(clarificationOptions ? { options: clarificationOptions } : {}),
          answer: safeClarification.answer,
          ...(answerActor ? { actor: answerActor } : {}),
          answeredAt: Date.now(),
        };
        // #ASK-PROPOSAL — 把【问题 + 你当时的提案原文 + 选项 + 答案】一起还给模型。旧版只回注
        // 「问题原文 + 答案」，于是「你想选哪条？」→「A」在上下文里是【无法解析的】：A 是什么，
        // 只写在提案散文里，而那段话可能已被折叠摘要掉。模型只好自己编一个 A 的含义（真实事故：
        // 「A」= 只生成 createJD，被编成「继续只做分析」）。这里不解释 A 的含义（那要靠模型自己
        // 读提案），只保证【解析 A 所需的原文都在场】。
        const answerFrame = [
          `[用户澄清回答] 针对你的问题「${q}」，用户回答：${safeClarification.answer}。`,
          clarifyProposal ? `\n【你提问时给用户的原话（用户就是在回应这段，选项的含义只在这里面）】\n${clarifyProposal}` : "",
          clarificationOptions?.length ? `\n【你当时给的选项】${clarificationOptions.map((o) => `${o.label} = ${o.value}${o.recommended ? "（你标的推荐）" : ""}`).join(" ｜ ")}` : "",
          `\n照你自己上面那段话来理解这个回答——用户选的是【你提过的那个东西】。别给它另编一个解释，也别把它降级成"再分析一下"。若上面确实找不到能对上的选项，就 ask_user 复述选项让用户确认，不要自己挑一个。据此继续，别再重复问同样的问题。`,
        ].filter(Boolean).join("");
        messages.push({ role: "user", content: authorizationState
          ? `[服务端确认结果] 针对「${q}」，${authorizationState}。授权值由服务端保管，不会提供给模型。`
          : safeClarification.sensitive
            ? `[安全处理] 用户在测试数据回答里疑似粘贴了凭证，内容已脱敏且未写入 fixture。请让用户在服务器 sandbox integration profile 配置 *_env 引用；不要索要或复述密钥。`
            : answerFrame });
        // Test data is never mutated in the clarification gate. The brain must call
        // supply_test_data, whose atomic commit invalidates prior approval/sandbox evidence.
        // This removes the old key:value shortcut that could bypass re-approval and ingest secrets.
        if (isTestFixtureClarification(q, clarifyContext) && !safeClarification.sensitive && safeClarification.answer !== "用占位") {
          messages.push({ role: "user", content: "[测试数据安全门] 请把这次回答解析后显式调用 supply_test_data；不要直接改上下文。工具成功后必须重新等待用户批准用例。" });
        }
        let followupApprovalEvent: BrainEvent | undefined;
        if (isTestFixtureClarification(q, clarifyContext) && safeClarification.answer === "用占位") {
          ctx.testDataSupplementPending = false;
          ctx.awaitingApproval = true;
          followupApprovalEvent = bindHumanInteractionEvent(ctx, { t: "test.cases", cases: ctx.testCases ?? [], awaitingApproval: true, coverage: ctx.testCoverage });
        }
        // #POLICY-REROUTE — 澄清回答是一次【真实的用户表态】，可能整个改变本次请求的性质
        // （"你能生成哪个agent?"=提问 → 答「A」= 就生成 createJD = 生成）。旧版只在开场按第一句
        // 话分诊一次，此后 policy/userIntent/模型档位全部冻结，于是过期的「【不要】进入生成
        // 流水线」比用户的新回答更长寿。这里把【问题 + 提案原文 + 答案】作为一句完整表态重走
        // 意图门 + 路由：判成什么路线仍由 AI 的意图解析决定，我们只是不再拿旧结论当永久事实。
        // 授权类回答（服务端确认门）不参与——它确认的是一次授权，不是新需求。
        if (!authorizationState && !safeClarification.sensitive) {
          const utterance = [
            clarifyProposal ? `（我刚才向用户提出的方案原文：${clarifyProposal.slice(-1500)}）` : "",
            clarificationOptions?.length ? `（我给的选项：${clarificationOptions.map((o) => `${o.label}=${o.value}`).join("；")}）` : "",
            `我问用户：「${q}」`,
            `用户回答：${safeClarification.answer}`,
          ].filter(Boolean).join("\n");
          const intentMoved = await runIntentGate(utterance).catch(() => false);
          if (intentMoved) await applyPolicyRoute(true).catch(() => {});
        }
        markHumanMessagesCheckpointable(routed.all);
        await checkpointConversation();
        // #CLARIFY-CLEAR — only surface the resolution after its one-shot
        // consumption (and any next approval id) is durable.
        yield { t: "clarify", question: q, options: clarificationOptions, context: clarifyContext || undefined, awaitingAnswer: false, interactionId: resolvedInteraction?.interactionId };
        if (followupApprovalEvent) yield followupApprovalEvent;
        if (safeClarification.sensitive) {
          yield { t: "message", text: "🔐 检测到疑似凭证，已脱敏且不会写进测试数据。请在服务器的 sandbox integration profile 配置环境变量引用，不要在聊天中粘贴密钥。" };
        }
        yield { t: "message", text: authorizationState
          ? `✅ ${authorizationState}。`
          : safeClarification.sensitive
            ? "✅ 已收到并安全处理；疑似凭证内容未保留。"
            : `✅ 收到你的回答：${safeClarification.answer}` };
        if (activeHumanGate()) {
          if (checkpointableHumanDeliveries.size) await checkpointConversation();
          turn--;
          continue;
        }
      }

      ctx.spent.turns = turn + 1;

      // HITL: drain human messages injected since the last turn (authoritative steering).
      // A clear "停止/取消/stop" is a HARD stop, not advisory steering — break the loop now
      // (backup to the frontend /stop path, in case the stop arrived via inject).
      if (opts.conversationId) {
        const human = await leaseHumanMessages();
        const stopRequested = human.some((message) => isStopIntent(message.text));
        if (stopRequested) {
          const retained = human.filter((message) => !isStopIntent(message.text));
          if (retained.length) (ctx.pendingHuman ??= []).push(...retained);
          ctx.humanDirectives.push("用户请求停止本次运行");
          messages.push({ role: "user", content: "[人工介入] 用户请求停止本次运行。" });
          markHumanMessagesCheckpointable(human);
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（已生成的内容保留）。" };
          break;
        }
        for (const humanMessage of human) {
          const text = humanMessage.text;
          const modelVisibleText = redactAuthorizationText(text);
          ctx.humanDirectives.push(modelVisibleText);
          messages.push({ role: "user", content: `[人工介入] ${modelVisibleText}` });
          yield { t: "message", text: `🧑 收到你的介入：「${modelVisibleText}」——下一步会纳入。` };
        }
        markHumanMessagesCheckpointable(human);
      }

      // #AUDIT-FIX(M14) — pendingHuman 只被 park 门排空；错时投递的带标消息在门关闭后会永远滞留。
      // 常规轮顶：没有任何门在等时，把滞留消息按 [人工介入] 补送（可见），不再无声吞没。
      if (!ctx.awaitingApproval && !ctx.awaitingBoundary && !ctx.awaitingClarify && ctx.pendingHuman?.length) {
        for (const pending of ctx.pendingHuman.map(normalizeHumanMessage)) {
          const text = pending.text;
          const modelVisibleText = redactAuthorizationText(text);
          ctx.humanDirectives.push(modelVisibleText);
          messages.push({ role: "user", content: `[人工介入] ${modelVisibleText}` });
          yield { t: "message", text: `🧑（补送）收到你此前的消息：「${modelVisibleText.slice(0, 80)}」——对应的等待已结束，按介入处理。` };
        }
        ctx.pendingHuman = [];
      }

      // Periodic steering meter. Exact provider usage is also emitted after
      // every model call below so the registry/UI do not wait for run end.
      if (turn > 0 && turn % 3 === 0) {
        const runTokens = currentRunTokens();
        const tokenK = Math.round(runTokens / 1000);
        const conversationTokenK = Math.round(ctx.spent.tokens / 1000);
        const { level, costNote } = sessionCostState(ctx.spent.tokens);
        messages.push({
          role: "system",
          content: `[预算检查] 本轮已用 ${turn}/${MAX_TURNS} turn · ${tokenK}k tokens（会话累计 ${conversationTokenK}k）· ${ctx.spent.sandboxRuns} 次沙箱 · 已造 ${ctx.specs.length} 个 agent · ${ctx.lastSandbox ? "上次沙箱已跑过" : "尚未跑沙箱"}。${costNote ?? "前期探索就继续；接近 finish 就收敛。"}`,
        });
        yield { t: "budget", turn, maxTurns: MAX_TURNS, tokens: runTokens, conversationTokens: ctx.spent.tokens, maxTokens: MAX_TOKENS, specsBuilt: ctx.specs.length, sandboxRuns: ctx.spent.sandboxRuns, level, costNote };
      }

      // Auto-compaction: fold verbose early history into a state summary once large.
      if (await maybeCompact(messages, ctx)) {
        // #2d FIX: emit the folded content as a first-class, EXPANDABLE compaction event (state =
        // the structured snapshot the brain kept), so the user can see exactly what was compacted.
        yield { t: "compaction", summary: "上下文已自动压缩：保留近期若干轮 + 结构化状态摘要，早期冗长输出已折叠（细节可用 read_spec / inspect_run / list_agents 取回）。", state: buildStateSummary(ctx) };
      }

      // #ANCHOR — 本体记忆心跳：按节拍把【本体事实 + 消化结论 + 还欠的覆盖】重新注入对话，
      // 防止长跑中早期理解被几十轮工具结果稀释（折叠幸存解决"丢"，锚点解决"淡"）。
      // 事实提醒而非指令；FACTORY_ONTOLOGY_ANCHOR_EVERY 调节拍（0=关）。
      {
        const anchorEvery = Number(process.env.FACTORY_ONTOLOGY_ANCHOR_EVERY ?? DEFAULT_ANCHOR_EVERY);
        if (anchorDue(turn, anchorEvery)) {
          const anchor = buildOntologyAnchor(ctx, turn);
          if (anchor) {
            messages.push({ role: "user", content: anchor });
            yield { t: "reflect", kind: "anchor", lesson: `本体锚点已注入（第 ${turn} 轮心跳）——理解与覆盖清单已刷新到上下文。` };
          }
        }
      }

      // Constrained decoding: ground design/refine schemas to the REAL action + tool names.
      const groundedSchemas = ctx.ontology
        ? injectGroundingEnums(toolSchemas, {
            actionNames: factoryGenerationScopedAgentActionNames(
              ctx.ontology,
              ctx.generationDirective,
            ),
            toolNames: ctx.toolCatalog ?? [],
          })
        : toolSchemas;

      // #AUDIT-FIX(L24) — 排空事件缓冲：工具调用之外 emit 的事件（policy/意图反思/锚点/调和提示）
      // 曾只在工具循环里 drain，纯对话轮会静默滞留、run 结束整批丢弃。
      while (buffer.length) {
        const ev0 = buffer.shift()!;
        if (ev0.t === "reflect") sawReflect = true;
        await checkpointBeforeHumanInteraction(ev0);
        yield ev0;
      }

      // Provider calls are prepaid against both the conversation-lifetime fuse
      // and the tree-wide run ledger. Keep a reserve unspent and cap completion
      // tokens to the remaining headroom, so the final turn cannot overrun the
      // budget by a whole paid completion before usage arrives.
      const promptEstimate = estimateContextUsage(messages, {
        additionalChars: JSON.stringify(groundedSchemas).length,
      }).estimatedTokens;
      const providerBudget = planProviderCall({
        ledgers: [
          {
            scope: "conversation",
            spentTokens: ctx.spent.tokens,
            maxTokens: MAX_TOKENS,
          },
          {
            scope: "run-tree",
            spentTokens: budgetLedger.tokens,
            maxTokens: budgetLedger.maxTokens,
          },
        ],
        promptTokens: promptEstimate,
        reserveTokens: PROVIDER_TOKEN_RESERVE,
        requestedCompletionTokens: configuredTurnCompletionCap(),
      });
      if (!providerBudget.allowed) {
        budgetStopped = true;
        const { level, costNote } = sessionCostState(ctx.spent.tokens);
        yield {
          t: "budget",
          turn: turn + 1,
          maxTurns: MAX_TURNS,
          tokens: currentRunTokens(),
          conversationTokens: ctx.spent.tokens,
          maxTokens: MAX_TOKENS,
          specsBuilt: ctx.specs.length,
          sandboxRuns: ctx.spent.sandboxRuns,
          level,
          ...(costNote ? { costNote } : {}),
          stopReason: `provider_headroom:${providerBudget.limitingScope ?? "unknown"}`,
        };
        yield {
          t: "message",
          text: `剩余 token 不足以安全覆盖下一次模型调用（需预留 ${providerBudget.reserveTokens} token），已在调用前停止；没有发起本轮模型请求。`,
        };
        break brainLoop;
      }

      // #7: route this turn's model by difficulty (fast while reading/planning, hard once
      // designing/coding) through a config-driven fallback chain; annotate which model served it.
      // #ROLE-TIER (P0-2) — sub-brain MEMBERS (fleet designers / group researchers) default to the fast
      // chain: their task is "research one slice, produce one JSON", not whole-run stewardship. The main
      // brain keeps difficulty routing. Env-overridable per deployment; an invalid value falls through.
      const subTierRaw = process.env.FACTORY_SUBBRAIN_TIER?.trim();
      const subTier = (["fast", "default", "hard", "review"] as const).find((t) => t === subTierRaw) ?? "fast";
      const tier = opts.isSubAgent ? subTier : tierForContext(ctx);
      let pendingCalls: { id: string; name: string; args: string }[] | null = null;
      let assistantContent = "";
      let sessionBudgetExceeded = false;
      // #AUDIT-FIX(M17) — 单轮流中断（看门狗/断流/瞬时 5xx）不再炸掉整个 run：本轮重试一次
      // （messages 在成功前不变，重放安全）；连续两次才向上抛。
      for (let sAttempt = 0; ; sAttempt++) {
        try {
          pendingCalls = null;
          assistantContent = "";
          for await (const ev of streamTurn(messages, groundedSchemas, {
            signal: opts.signal,
            models: modelChain(tier),
            maxTokens: providerBudget.completionTokenCap,
          })) {
        if (ev.t === "think") {
          // The deliberation stream used to be suppressed under autopilot. That
          // is exactly backwards: autopilot is the UNATTENDED mode, where an
          // after-the-fact record is the ONLY record anyone will ever have of
          // why the run did what it did. (Measured: an autopilot OntoCode build
          // emitted 0 think frames out of 40 events; the copilot builds emitted
          // 327/574/695.) Consumers coalesce and bound this stream themselves.
          yield { t: "think", delta: ev.delta };
        }
        else if (ev.t === "model") yield { t: "model", model: ev.model, tier, turn: turn + 1 };
        else if (ev.t === "usage") {
          ctx.spent.tokens += ev.promptTokens + ev.completionTokens;
          budgetLedger.tokens += ev.promptTokens + ev.completionTokens; // #TREE-BUDGET — tree-wide spend
          // #W2-STAGE — attribute this turn's spend to the current stage; steer ONCE when a stage
          // blows its budget (converge/escalate, don't grind inside the stage).
          const st = (ctx.spent.stageTokens ??= {});
          st[currentStage] = (st[currentStage] ?? 0) + ev.promptTokens + ev.completionTokens;
          const budget = STAGE_BUDGETS[currentStage];
          if (budget && st[currentStage]! > budget && !stageBudgetWarned.has(currentStage)) {
            stageBudgetWarned.add(currentStage);
            messages.push({ role: "system", content: `[阶段预算] ${currentStage.toUpperCase()} 阶段已花 ${Math.round(st[currentStage]! / 1000)}k tokens（预算 ${Math.round(budget / 1000)}k）。别在本阶段继续磨：要么收敛进入下一阶段，要么 verify_chain/analyze_failure 定位真问题后换思路。` });
            yield { t: "message", text: `⚠ ${currentStage.toUpperCase()} 阶段超出 token 预算——已提示收敛。` };
          }
          const { level, costNote } = sessionCostState(ctx.spent.tokens);
          yield {
            t: "budget",
            turn: turn + 1,
            maxTurns: MAX_TURNS,
            tokens: currentRunTokens(),
            conversationTokens: ctx.spent.tokens,
            maxTokens: MAX_TOKENS,
            specsBuilt: ctx.specs.length,
            sandboxRuns: ctx.spent.sandboxRuns,
            level,
            ...(costNote ? { costNote } : {}),
          };
          sessionBudgetExceeded = (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS)
            || (budgetLedger.maxTokens != null && budgetLedger.tokens >= budgetLedger.maxTokens); // #TREE-BUDGET
        }
        else if (ev.t === "tool_calls") {
          pendingCalls = ev.calls;
          assistantContent = ev.content;
        } else if (ev.t === "done") assistantContent = ev.content;
          }
          break;
        } catch (e) {
          const msg = safeDiagnostic(e);
          const transientTurn = !opts.signal?.aborted && /看门狗|空转|overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang|abort/i.test(msg);
          if (sAttempt === 0 && transientTurn) {
            yield { t: "message", text: `⚠ 本轮模型流中断（${msg.slice(0, 70)}）——自动重试一次。` };
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw e;
        }
      }

      // Do not execute model-proposed tools or start another provider call once
      // the session fuse trips. The usage frame above remains in the transcript.
      if (sessionBudgetExceeded) {
        budgetStopped = true;
        yield { t: "message", text: "已达 token 预算上限，停止；可提高 FACTORY_BRAIN_MAX_SESSION_TOKENS 后继续。" };
        break brainLoop;
      }

      // No tool calls → the brain is talking: its final answer for this turn. We do NOT
      // second-guess it with a greeting/no-op guard — forcing a tool call because the output
      // "looks like a menu" (regex) was hardcoded routing, deciding FOR the model. The
      // empowering system prompt now lets the model judge for itself whether a message needs
      // a tool; trust that. (An explicit stop intent is still honored at the turn top.)
      if (!pendingCalls || pendingCalls.length === 0) {
        let text = assistantContent.trim();
        // #REASONING-KERNEL Phase-3b — for an analyze/question/report intent, the ANSWER is deliberated
        // through the reasoning kernel (cot) instead of being raw ReAct output — a real top-level shape
        // switch by intent. Once per run, only for a substantive NON-question answer, budget-guarded, and
        // degrading to the raw text on any failure (never a regression). An open question still auto-parks.
        if (
          !opts.isSubAgent && ctx.reasoningDefault === "cot" && !answerDeliberated
          && text.length > 40 && !trailingClarificationQuestion(text)
          && !(ctx.budgetLedger?.maxTokens != null && ctx.budgetLedger.tokens >= ctx.budgetLedger.maxTokens)
        ) {
          answerDeliberated = true;
          try {
            const subproblem = (ctx.userIntent?.split("\n").filter(Boolean).pop() ?? opts.goal).slice(0, 240);
            const digest = [
              ctx.ontologyUnderstanding ? `本体理解：${ctx.ontologyUnderstanding.slice(0, 1600)}` : "",
              ctx.specs?.length ? `已设计 ${ctx.specs.length} 个 agent` : "",
            ].filter(Boolean).join("\n");
            const deliberated = await runReasoning(
              { subproblem, context: digest || undefined, draft: text },
              parseStrategyPlan(ctx.reasoningDefault),
              { emit, signal: ctx.signal, maxLlmCalls: 3, onLlmCall: () => { if (ctx.budgetLedger) ctx.budgetLedger.tokens += kernelTokenCharge(); } },
            );
            if (!deliberated.ambientReactOnly && deliberated.final.trim()) {
              // #CLEAN-ANSWER — the message is the user-facing ANSWER, not the cot scratchpad. Keep
              // only the conclusion; the full deliberation still streams as a (foldable) reasoning.step
              // (flushed just below), so detailed view shows everything and brief shows a clean card.
              const split = extractCotConclusion(deliberated.final.trim());
              text = split ? split.conclusion : deliberated.final.trim();
            }
          } catch { /* keep the raw answer — never regress a working reply */ }
          // The kernel emitted reasoning.step events into the buffer; this no-tool turn may break the run
          // before the top-of-turn drain, so flush them to the stream now.
          while (buffer.length) {
            const event = buffer.shift()!;
            await checkpointBeforeHumanInteraction(event);
            yield event;
          }
        }
        if (text) yield { t: "message", text };
        const structuredHumanGatePending =
          ctx.awaitingClarify === true
          || ctx.awaitingApproval === true
          || ctx.awaitingBoundary === true
          || activeHumanInteractionKind(ctx) !== null;
        const activeGenerationDirective = ctx.generationDirective;
        const mustEnterGenerationPath =
          !opts.isSubAgent
          && activeGenerationDirective !== undefined
          && ctx.ontology !== null
          && ctx.specs.length === 0
          && !finishedOk
          && !structuredHumanGatePending
          && !budgetStopped
          && !erroredOut;
        if (mustEnterGenerationPath && activeGenerationDirective) {
          preAuthoringTextRefusals += 1;
          if (preAuthoringTextRefusals < MAX_PRE_AUTHORING_TEXT_REFUSALS) {
            const nextStep = preAuthoringTextRefusals === 1
              ? "现在调用 inspect_all_action_readiness 做服务端范围的只读全量预检；不要再用纯文本结束。"
              : "根据已经取得的 readiness 证据，立即调用 inspect_action_readiness / create_plan / design_agent 中合适的下一步；若确有权威输入缺口，必须通过返回 next=ask_user 的结构化工具挂起，不能只在正文里提问。";
            messages.push({
              role: "system",
              content:
                `[服务端生成守卫] generationDirective 已锁定 ${activeGenerationDirective.requestedActionNames.join("、")}，Ontology 已读取，但当前仍是 0 个 spec。` +
                `这是 Build，不是普通答疑；本轮纯文本不能作为终态（第 ${preAuthoringTextRefusals}/${MAX_PRE_AUTHORING_TEXT_REFUSALS} 次）。${nextStep}`,
            });
            yield {
              t: "message",
              text: `↪ Build 尚未进入 authoring；Harness 已要求先完成 readiness/authoring（${preAuthoringTextRefusals}/${MAX_PRE_AUTHORING_TEXT_REFUSALS}）。`,
            };
            continue;
          }
          generationStalledBeforeAuthoring = true;
          yield {
            t: "message",
            text:
              `generation_stalled_before_authoring：服务端生成范围已锁定且 Ontology 已读取，但模型连续 ${preAuthoringTextRefusals} 次只返回文本，` +
              "未进入 readiness/authoring 工具；本次 Build 已诚实停止，未生成 Agent。",
          };
          break;
        }
        // COMPLETION GUARD — don't let a generation stop mid-way on a chatty turn. If the
        // brain committed to generating (made a plan / designed ≥1 agent) but the ontology's
        // Agent actions aren't all covered and it hasn't successfully finished, tell it
        // exactly what's left and KEEP LOOPING (prevents stopping after only the first action).
        // The nudge budget resets on real progress, so a stuck brain still exits.
        // #8 FIX: gate ONLY on real specs existing — NOT on a plan alone. A plan can exist for an
        // analysis/exploration turn the user never asked to finish; nudging then makes "分析一下本体"
        // requests loop. The genuine generation path still trips this the moment the first spec exists.
        // #AUDIT-FIX(H4) — analyze/ask_first/skinny 路线与已交付会话不再被「去 finish」推搡：
        // 旧守卫会连发 5 条与 [推理路线] 直接矛盾的催促（甚至触发不想要的真实部署）。
        // #SCOPE — 用户只点名一部分动作时（create_plan scope=partial → ctx.planScope），"还差 N 个"
        // 根本不是遗漏而是【用户的本意】。旧版无视 planScope，把本体里全部 Agent 动作硬当成待办，
        // 逐字催「这个任务要为本域生成【全部 N 个 Agent】…立刻 design_fleet 把剩下 N 个并行设计」——
        // 用户只要 createJD 也会被推去造 6 个。planScope 早就存在（finish/save_draft 都认它），
        // 只是这道守卫从没读过它。部分范围下守卫改守【用户选定的范围】，而不是整本体。
        const partialScope = ctx.planScope?.kind === "partial";
        const guardExempt = ["analyze", "ask_first", "skinny"].includes(String(ctx.policy?.pipeline ?? "")) || ctx.delivered === true;
        if (!opts.isSubAgent && !finishedOk && !guardExempt && ctx.ontology && ctx.specs.length > 0) {
          const allAgentActions = factoryGenerationScopedAgentActionNames(
            ctx.ontology,
            ctx.generationDirective,
          );
          const outOfScope = new Set(partialScope ? (ctx.planScope?.missedActions ?? []) : []);
          const agentActions = allAgentActions.filter((a) => !outOfScope.has(a));
          const covered = new Set(ctx.specs.map((s) => s.actionName));
          const remaining = agentActions.filter((a) => !covered.has(a));
          if (ctx.specs.length > nudgeBaselineSpecs) { incompleteNudges = 0; nudgeBaselineSpecs = ctx.specs.length; } // progress → refill budget
          if (incompleteNudges < 5) {
            incompleteNudges += 1;
            if (remaining.length > 0) {
              // #GUARD-FACTS — 这条守卫是防「设计完第一个就停下」的真问题，但过去它替 AI 做了两个
              // 本该 AI 判的决定：①按数量阈值指定用哪个工具（≥2→design_fleet），②「别现在停下来问我」
              // 直接封掉 ask_user。现在只播报【状态事实 + 各选项及代价】——继续/并行/发现真问题要问，
              // 由 AI 判断。防停摆靠"播报事实 + 循环继续"达成，不靠禁止提问。
              const scopeNote = partialScope
                ? `本次是【用户指定的部分范围】(${ctx.planScope?.reason ?? "用户点名"})：范围内共 ${agentActions.length} 个动作，范围外的${outOfScope.size ? `(${[...outOfScope].join("、")})` : ""}不在本次范围。`
                : `本域共 ${agentActions.length} 个 Agent 动作。`;
              messages.push({ role: "user", content: `[进度·还没做完] ${scopeNote}已设计 ${ctx.specs.length} 个(${[...covered].join("、") || "无"})，范围内还差 ${remaining.length} 个：${remaining.join("、")}。剩下的可以逐个 design_agent，或 design_fleet 并行设计（动作彼此独立时并行更快；共享字段契约/相互依赖时串行更稳，你判断）。全设计完后按需 validate_graph → sandbox_run → ${partialScope ? "save_draft（部分范围）" : "finish"}。如果你在设计中发现了需要用户拍板的真问题（比如本体字段冲突、范围不清），该 ask_user 就问，别硬猜着往下做。${partialScope ? "" : "\n若用户其实只要其中一部分(见【用户意图】)，以用户说的范围为准，用 create_plan 的 scope=partial 记下，不必凑全量。"}` });
              yield { t: "message", text: `↪ 范围内还差 ${remaining.length} 个 agent（${remaining.join("、")}）。` };
            } else {
              messages.push({ role: "user", content: `[进度·范围内都已设计] 范围内 ${ctx.specs.length} 个 agent 都有 spec 了。收尾通常是 validate_graph（有问题 refine_agent 修）→ sandbox_run（用测试用例真跑通事件链）→ ${partialScope ? "save_draft" : "finish"}——按你判断的真实需要推进；如果发现设计层面还有没解决的问题，回头修也可以。` });
              yield { t: "message", text: `↪ 范围内 ${ctx.specs.length} 个 agent 都设计好了。` };
            }
            continue; // keep the ReAct loop running instead of ending mid-generation
          }
        }
        // #ASK-PARK v2 — 纯文本以开放问题收尾 = 大脑在等用户拍板。纯文本回复本身既不挂起运行、
        // 用户也没有作答通道；旧逻辑只提醒一次就让运行继续或直接 break 成 incomplete（用户视角=没暂停）。
        // 现在把这句开放问题【合成为一次真正的澄清挂起】——走与 ask_user 相同的 park：置 awaitingClarify +
        // clarifyPrompt + emit clarify，continue 到下一轮顶部的澄清门（真正等用户回答）。设自动挂起
        // 次数上限，避免模型反复空问导致死挂；无对话通道（conversationId 缺）时无法 park，照旧 break。
        // #ASK-PROPOSAL — 自动挂起【只截尾句】做 question（"你想选哪条？"），选项恒为 undefined。
        // 而大脑刚写的这段正文 `text` 往往就是选项本身（"路线A：只生成 createJD／路线B：补齐全部6个"）。
        // 不快照它，用户答「A」时上下文里就再没有能解析 A 的东西了 —— 真实事故的另一半。
        const parkQuestion = trailingClarificationQuestion(text);
        if (!opts.isSubAgent && !finishedOk && parkQuestion && opts.conversationId && autoParkCount < AUTO_PARK_MAX) {
          autoParkCount += 1;
          ctx.clarifyPrompt = { question: parkQuestion, options: undefined, proposal: text.slice(-4000), context: "auto-captured trailing question（大脑以纯文本提问，系统自动挂起等待你回答）" };
          ctx.awaitingClarify = true;
          const clarifyEvent = bindHumanInteractionEvent(ctx, { t: "clarify", question: parkQuestion, options: undefined, context: undefined, awaitingAnswer: true });
          await checkpointConversation();
          yield clarifyEvent;
          yield { t: "message", text: "⏸ 大脑向你提了个问题——运行已挂起，等你在下方作答后继续。" };
          continue; // next turn hits the clarification gate and parks the run
        }
        break;
      }

      // Model-produced arguments are untrusted. Parse and redact them before
      // the assistant tool-call frame is persisted or any tool.call event is
      // emitted. Calls containing a literal credential are kept only as this
      // safe summary and are rejected below before their tool executes.
      const preparedCalls = pendingCalls.map((call) => {
        let rawArgs: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.args || "{}");
          rawArgs = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        } catch {
          rawArgs = {};
        }
        const scan = sanitizeSensitiveInput(rawArgs, `${call.name}.args`);
        return {
          call,
          rawArgs,
          safeArgs: scan.sanitized as Record<string, unknown>,
          sensitivePaths: scan.paths,
        };
      });
      const preparedById = new Map(preparedCalls.map((entry) => [entry.call.id, entry] as const));
      const safeAssistantContent = sanitizeSensitiveInput(assistantContent, "assistant.content").sanitized;

      messages.push({
        role: "assistant",
        content: typeof safeAssistantContent === "string" && safeAssistantContent ? safeAssistantContent : null,
        tool_calls: preparedCalls.map(({ call, safeArgs }) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(safeArgs) },
        })),
      });

      let finished = false;
      // #ASK-PARK-MUTEX — a single assistant turn must not BOTH ask the user (park) and ship/act.
      // If ask_user shares the batch with a terminal/side-effecting tool, refuse the latter in EITHER
      // ordering: ask_user parks the run, and finish/sandbox_run get a structured error so they are
      // re-proposed only AFTER the user answers. Without this, [finish, ask_user] lets finish end the
      // run before the next-turn clarify gate ever runs, and [ask_user, sandbox_run] fires a real
      // side effect despite the pending question. The mutex is order-independent by construction.
      const TERMINAL_OR_SIDE_EFFECT_TOOLS = new Set(["finish", "sandbox_run"]);
      const batchHasAsk = pendingCalls.some((c) => c.name === "ask_user");
      let structuredClarificationPending = false;
      for (const call of pendingCalls) {
        const prepared = preparedById.get(call.id)!;
        // #W2 — consecutive-identical-call breaker: the same tool with the same args twice in a row is
        // grinding; a third is refused outright with a structured steer (no silent token burn).
        const dupSig = `${call.name}:${JSON.stringify(prepared.safeArgs)}`;
        if (dupSig === lastToolSig) dupCount += 1; else { dupCount = 0; lastToolSig = dupSig; }
        const args = prepared.rawArgs;
        const safeArgs = prepared.safeArgs;
        const reasoning = typeof safeArgs.reasoning === "string" ? safeArgs.reasoning : "";
        // #UI-DRILL — the generated agent this harness step targets (agent-scoped tools carry
        // `action`; `design_subagent` carries `parent_action`). Lets the ops panel group every
        // reasoning step + tool call under the agent it was building.
        const forAgent = typeof safeArgs.action === "string" ? safeArgs.action : typeof safeArgs.parent_action === "string" ? safeArgs.parent_action : undefined;
        yield { t: "tool.call", id: call.id, name: call.name, reasoning, input: safeArgs, role: roleOfTool(call.name), forAgent };

        // Explicit stage signal: light the canvas rail as the brain ENTERS this stage, before
        // the (possibly long) tool runs, so the active-stage highlight tracks the live work.
        const stage = STAGE_OF_TOOL[call.name];
        if (stage) yield { t: "stage", stage, status: "active", role: roleOfTool(call.name) };

        const tool = byName.get(call.name);
        // #W2-STAGE — admission gate: refuse a stage-jumping tool with a structured steer (this is the
        // phaseFor→control upgrade; order enforced by structure, not prompt prose).
        const admission = stageAdmission(call.name, ctx);
        // #AUDIT-FIX(L29) — 只有闸门放行才更新 stage 归因：被拒绝的跳段不应把后续 token 记到它头上。
        if (!admission && STAGE_OF_TOOL[call.name]) currentStage = STAGE_OF_TOOL[call.name]!;
        let result;
        if (prepared.sensitivePaths.length > 0) {
          result = {
            ok: false,
            summary: `安全校验拒绝了 ${call.name}：${prepared.sensitivePaths.slice(0, 3).join("、")} 含字面凭证或 secret 形态值。请只填写服务器 *_env 环境变量名；转录中仅保留了脱敏摘要。`,
          };
        } else if (ctx.testDataSupplementPending && !new Set(["supply_test_data", "ask_user", "generate_test_cases"]).has(call.name)) {
          result = { ok: false, summary: `当前正在补测试数据，只允许 supply_test_data / ask_user / generate_test_cases；${call.name} 要等更新后的用例重新获批。` };
        } else if (
          call.name !== "ask_user"
          && (batchHasAsk || structuredClarificationPending || ctx.awaitingClarify || (ctx.awaitingApproval && !ctx.testDataSupplementPending) || ctx.awaitingBoundary)
        ) {
          result = { ok: false, summary: `本轮需要向用户提问 / 等待人工确认——运行已挂起，暂不执行 ${call.name}。用户回答后请【单独】再调用它。` };
        } else if (TERMINAL_OR_SIDE_EFFECT_TOOLS.has(call.name) && pendingCalls.length !== 1) {
          // A tool earlier in the same batch can discover a structured blocker
          // only after execution.  Requiring terminal/side-effect tools to be a
          // singleton prevents ordering from turning `[sandbox_run, blocker]`
          // into an unauthorized deploy before the blocker can park the run.
          result = { ok: false, summary: `${call.name} 会结束流程或触发真实沙箱操作，必须在没有其它并行工具调用的一轮里单独执行。` };
        } else if (admission) {
          result = { ok: false, summary: admission };
        } else if (dupCount >= 2) {
          result = { ok: false, summary: `重复调用检测：你已连续 ${dupCount + 1} 次用【完全相同的参数】调用 ${call.name}——重复不会改变结果。改变输入、换工具（verify_chain/analyze_failure/ask_user），或 revert 后换思路。` };
        } else if (!tool) result = { ok: false, summary: `未知工具 ${call.name}` };
        else {
          const priorEmit = ctx.emit;
          ctx.emit = (event) => {
            priorEmit(sanitizeSensitiveInput(event, `${call.name}.event`).sanitized as BrainEvent);
          };
          // #HEARTBEAT — 工具执行心跳：长工具（understand_ontology 四维分治 / sandbox_run 轮询）
          // 曾在 UI 上只有一句"运行中…"，慢/卡/死不可区分。现在每 ~15s yield 一条 tool.progress
          // （elapsed 递增 + 阶梯升级提示），SSE 持续有流量 → 前端 staleness 不误报"无响应"。
          try {
            const HEARTBEAT_MS = Math.max(5000, Number(process.env.FACTORY_TOOL_HEARTBEAT_MS) || 15000);
            const toolP = Promise.resolve(tool.execute(args, ctx)).then(
              (v) => ({ kind: "ok" as const, v }),
              (e) => ({ kind: "err" as const, e }),
            );
            let elapsedMs = 0;
            type Settled = Awaited<typeof toolP>;
            let settled: Settled | null = null;
            for (;;) {
              const raced: Settled | null = await Promise.race([toolP, new Promise<null>((r) => { const t = setTimeout(() => r(null), HEARTBEAT_MS); (t as unknown as { unref?: () => void }).unref?.(); })]);
              if (raced) { settled = raced; break; }
              elapsedMs += HEARTBEAT_MS;
              const es = Math.round(elapsedMs / 1000);
              const note =
                es >= 420 ? "仍在执行。若长期无进展可停止运行——心跳仍在说明进程没死，多半是外部依赖极慢。"
                : es >= 180 ? "仍在执行（长任务：多次 LLM 调用/沙箱轮询属正常）。"
                : es >= 60 ? "仍在执行——这一步涉及多次 LLM 调用或外部等待。"
                : undefined;
              yield { t: "tool.progress", id: call.id, name: call.name, role: roleOfTool(call.name), elapsedS: es, ...(note ? { note } : {}) };
            }
            if (settled!.kind === "ok") result = settled!.v;
            else throw settled!.e;
          } catch (e) {
            result = { ok: false, summary: `工具 ${call.name} 出错：${safeDiagnostic(e)}` };
          } finally {
            ctx.emit = priorEmit;
          }
        }
        // Tool handlers and external SDK errors are untrusted too. Replace the
        // in-loop result with a recursively sanitized copy before the UI event
        // or model transcript sees it. The raw result is never checkpointed.
        const sanitizedResult = sanitizeSensitiveInput({
          summary: result.summary,
          ...(result.output !== undefined ? { output: result.output } : {}),
        }, `${call.name}.result`).sanitized as { summary?: unknown; output?: unknown };
        result = {
          ...result,
          summary: typeof sanitizedResult.summary === "string"
            ? sanitizedResult.summary
            : "工具返回了不可显示的摘要。",
          ...(result.output !== undefined ? { output: sanitizedResult.output } : {}),
        };
          const clarification = structuredClarification(result);
          if (clarification) {
            const questionKey = normalizeQuestion(clarification.question);
            const priorAnswer = (ctx.askedQuestions ??= {})[questionKey];
          if (typeof priorAnswer === "string" && priorAnswer.length > 0) {
            // A tool may rediscover the same blocker after resume. Replaying
            // the durable answer is idempotent; resetting it to pending would
            // trap the conversation in an endless ask_user loop.
            result.summary = `${result.summary}（这个问题此前已经由用户回答：${priorAnswer}。请据此继续，不要重复提问。）`;
            if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
              result.output = {
                ...(result.output as Record<string, unknown>),
                next: "continue",
                humanAnswer: priorAnswer,
              };
            }
          } else {
            const automatic = resolveAutopilotClarification(
              ctx,
              clarification,
            );
            if (automatic) {
              ctx.askedQuestions[questionKey] = automatic.answer;
              result.summary = `${result.summary}（Autopilot 已采用${automatic.source === "recommended" ? "推荐项" : "安全默认"}「${automatic.answer}」，记录假设 ${automatic.assumption.id}，不挂起。）`;
              if (
                result.output &&
                typeof result.output === "object" &&
                !Array.isArray(result.output)
              ) {
                result.output = {
                  ...(result.output as Record<string, unknown>),
                  next: "continue",
                  autopilotAnswer: automatic.answer,
                  assumptionId: automatic.assumption.id,
                };
              }
              messages.push({
                role: "system",
                content: `[Autopilot assumption ${automatic.assumption.id}] 工具提出「${clarification.question}」，控制平面采用：${automatic.answer}。这不是人工授权。`,
              });
            } else {
            ctx.askedQuestions[questionKey] = "";
            ctx.clarifyPrompt = clarification;
            ctx.awaitingClarify = true;
            structuredClarificationPending = true;
            // Do not emit duplicate cards when the same tool call is replayed
            // before the still-pending answer arrives.
            if (priorAnswer === undefined) {
              ctx.emit({
                t: "clarify",
                question: clarification.question,
                options: clarification.options,
                context: clarification.context,
                awaitingAnswer: true,
              });
            }
            result.summary = `${result.summary}（系统已按 next=ask_user 强制暂停，等待用户回答。）`;
            }
          }
        }
        // drain events the tool emitted (agent.created / validation / sandbox / plan / reflect)
        while (buffer.length) {
          const ev = buffer.shift()!;
          if (ev.t === "reflect") sawReflect = true;
          await checkpointBeforeHumanInteraction(ev);
          yield ev;
        }
        // #5: stream the FULL tool output (not just the one-line summary) so the activity log
        // shows complete I/O. Cap is generous + configurable so a huge read_ontology doesn't bloat
        // the SSE, but the "完整输出" pane is genuinely complete for normal tool calls.
        const outStr = result.output !== undefined ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)) : undefined;
        const UI_OUTPUT_CAP = Number(process.env.FACTORY_UI_OUTPUT_CAP) || 64000;
        const outForUi = outStr && outStr.length > UI_OUTPUT_CAP ? outStr.slice(0, UI_OUTPUT_CAP) + "\n…[输出过长已截断，完整内容用对应工具重取]" : outStr;
        yield { t: "tool.result", id: call.id, name: call.name, ok: result.ok, summary: result.summary, output: outForUi, forAgent };

        // Settle the stage once its tool returns. For `finish` only a PASSED gate (result.ok)
        // is a real 交付; a refused finish stays "error" so the rail never falsely shows shipped.
        // `detail` was never set here, so EVERY settled stage row read
        // `detail: null` — five distinct design rejections rendered as five
        // identical lines, and the one that actually blocked the session was
        // indistinguishable from the four that did not. The tool's own summary
        // is already sanitized above; carry its head so the rows differ.
        if (stage) {
          const settleDetail = result.summary
            ? `${call.name}：${result.summary.slice(0, 200)}`
            : call.name;
          yield { t: "stage", stage, status: result.ok ? "ok" : "error", role: roleOfTool(call.name), detail: settleDetail };
        }

        const toolBody = result.output !== undefined ? { summary: result.summary, output: result.output } : { ok: result.ok, summary: result.summary };
        const toolContent = serializeToolResultForContext(
          toolBody,
          TOOL_RESULT_CAP,
        );
        messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });

        // #SIDE-EFFECT-CKPT (WS1) — a tool whose whole point is an irreversible/billed effect
        // (sandbox_run, finish, save_draft, …) must become durable AT ONCE, not only at the
        // end-of-turn #CRASH-CKPT below. Otherwise a process death after the effect but before the
        // turn's checkpoint lets crash-resume replay the previous checkpoint and re-issue the call
        // — re-deploying a sandbox, re-billing tests, appending a duplicate draft. One extra upsert
        // per side-effect tool is cheap; the duplicated effect is not.
        if (opts.conversationId && isSideEffectTool(call.name)) {
          await checkpointConversation();
        }

        // #3 FIX (memory safety net): if a grounding tool rejected an unknown action/event/field
        // name — the brain forgot the real symbol after compaction — don't just surface the error.
        // Re-inject the REAL names from ctx.ontology (which survives compaction in memory) so the
        // next turn can self-correct without a wasted re-read. Cheap: no extra LLM/tool call.
        if (!result.ok && ctx.ontology && /design_agent|refine_agent|create_agent/.test(call.name) && /未知|不存在|unknown|not found|没有该|无效|invalid/.test(String(result.summary ?? ""))) {
          const acts = factoryGenerationScopedAgentActionNames(
            ctx.ontology,
            ctx.generationDirective,
          );
          const evs = ctx.ontology.events.map((e) => e.name);
          messages.push({ role: "system", content: `[名称纠偏] 你引用了本体里不存在的名称。只能用这些真名(别脑补)：可用 Agent 动作: ${acts.join("、")}；可用事件: ${evs.join("、")}。据此改正后重试。` });
        }

        // Only a PASSED finish ends the loop; a refused finish forces the brain back.
        if (call.name === "finish") {
          if (result.ok) {
            finished = true;
            finishedOk = true;
            ctx.delivered = true; // #AUDIT-FIX(H4) — 跨 run 持久（serializeCtx），交付后的追问不再被催 finish
          } else {
            finishRefusals += 1;
            if (finishRefusals >= 4) {
              messages.push({ role: "system", content: `[诚实收尾] 验收门已拒绝 ${finishRefusals} 次。若反复跑不通，多半是数据/环境/本体限制——别硬试，调 analyze_failure 诚实收尾。` });
              yield { t: "message", text: `⚠ 验收门已拒绝 ${finishRefusals} 次——若确实跑不通，请 analyze_failure 诚实收尾。` };
            }
          }
        }
      }

      // #ASK-PROPOSAL — 大脑这一轮若挂起等回答，把【同一轮它自己写的正文】快照进 clarifyPrompt。
      // ask_user 的 options 是可选的，大脑常常只把选项写在正文里（"路线A：… 路线B：…"）而 options
      // 留空；那样用户答「A」时，回注给模型的就只有「问题原文 + 字母 A」，A 指什么无从解析。
      // 这里不强迫大脑传 options（那是替它做决定），只是【别把它已经说过的话弄丢】。
      if (ctx.awaitingClarify && ctx.clarifyPrompt && !ctx.clarifyPrompt.proposal) {
        const proposal = typeof safeAssistantContent === "string" ? safeAssistantContent.trim() : "";
        if (proposal) ctx.clarifyPrompt = { ...ctx.clarifyPrompt, proposal: proposal.slice(-4000) };
      }

      // #CRASH-CKPT — checkpoint EVERY turn, not only at run end. The end-of-run `finally` save
      // covers normal exits and parks, but a mid-run PROCESS DEATH (tsx-watch restart on a file
      // edit, manual pnpm-dev restart, crash) used to lose every turn since the last interaction —
      // the «思考过程突然中断且无法续跑» incident: a follow-up build died mid-stream with its
      // conversation checkpoint still frozen at the PREVIOUS interaction. One SQLite upsert per
      // turn is cheap; crash-resume then continues from the latest completed turn.
      if (opts.conversationId) {
        await checkpointConversation();
      }

      if (finished) break;
      if (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS) {
        budgetStopped = true;
        yield { t: "message", text: "已达 token 预算上限，停止。" };
        break;
      }
    }
  } catch (e) {
    erroredOut = true;
    const safeError = safeDiagnostic(e);
    const transient = /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/i.test(safeError);
    yield {
      t: "error",
      message: transient
        ? `AI 网关临时过载/不可用(${safeError.slice(0, 80)})——已自动重试多次仍未恢复。这是上游算力波动，不是 agent 的问题。已生成的内容都在，稍等重试即可。`
        : safeError,
    };
  } finally {
    // Persist messages + ctx so the user's NEXT message resumes this conversation.
    if (opts.conversationId) {
      try {
        await checkpointConversation();
      } catch (error) {
        erroredOut = true;
        yield { t: "error", message: `会话检查点保存/人工消息确认失败：${safeDiagnostic(error)}` };
      }
    }
    // Tear the sandbox app back down at run-end (revert to 0 functions) — the OLD
    // conductor's session-end teardown. Only if a sandbox actually ran. A teardown failure is
    // observable and terminal: otherwise leaked registered functions would be hidden by `done`.
    if (!opts.isSubAgent && ctx.spent.sandboxRuns > 0) {
      try {
        await opts.ports.sandbox.teardown(opts.domain);
      } catch (error) {
        erroredOut = true;
        yield { t: "error", message: `sandbox 清理失败：${safeDiagnostic(error)}` };
      }
    }
    // Record skill effectiveness against this run's sandbox verdict (did reuse help?).
    if (!opts.isSubAgent && ctx.ports.skills && ctx.createdSkills.length) {
      const ok = completeSuiteForContext(ctx).complete;
      try {
        for (const s of ctx.createdSkills) {
          await ctx.ports.skills.recordEval(s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), ok);
        }
      } catch (error) {
        learningFailures.push(`技能评估保存失败：${safeDiagnostic(error)}`);
        yield { t: "error", message: `技能评估保存失败：${safeDiagnostic(error)}（学习类收尾失败，不改判本次交付结果）` };
      }
    }
  }

  // If the LLM wrote none, synthesize and durably persist one so next time isn't amnesiac.
  // Persistence is part of the factory's supervision contract and cannot silently disappear.
  if (!opts.isSubAgent && !sawReflect && !humanWaitSuspended) {
    const note =
      budgetStopped || (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS)
        ? `token 预算耗尽前未能结束`
        : ctx.spent.turns >= MAX_TURNS
          ? `turn 预算耗尽前未能结束`
          : `循环退出但没正常 finish`;
    try {
      await opts.ports.reflection.record(opts.domain, {
        summary: `${note}：${ctx.specs.length} 个 agent · sandbox ${ctx.lastSandbox ? "已跑" : "未跑"}`,
        lesson: "下次为该域生成时：循环走偏时早点 finish 总结现状，或 analyze_failure 留下根因，比空手退出有价值。",
      });
      yield { t: "reflect", kind: "caveat", lesson: "(自动) 退出前留下了一条警示反思" };
    } catch (error) {
      learningFailures.push(`运行反思保存失败：${safeDiagnostic(error)}`);
      yield { t: "error", message: `运行反思保存失败：${safeDiagnostic(error)}（学习类收尾失败，不改判本次交付结果）` };
    }
  }

  // #P0-6 (AWM 技能归纳) + #P0-5 (Mem0 记忆整合) — 收尾双沉淀。只在真收束时跑、env 可关；
  // when enabled, failures are terminal so the run cannot claim unpersisted learning.
  // 技能归纳的验证门（ASI）：真沙箱整链通过才算"verified success"，模拟/未通过一律不归纳。
  if (!opts.isSubAgent && finishedOk) {
    try {
      const settleDigest = digestFromMessages(messages as unknown[]);
      if (
        process.env.FACTORY_SKILL_INDUCTION !== "0" &&
        ctx.ports.skills &&
        completeSuiteForContext(ctx).complete &&
        ctx.lastSandbox?.simulated === false
      ) {
        const existing = (await ctx.ports.skills.list(opts.domain)).map((s) => ({ slug: s.slug, purpose: s.purpose }));
        const induced = await induceSkillsFromRun({ domain: opts.domain, digest: settleDigest, specs: ctx.specs, existingSkills: existing });
        for (const sk of induced) {
          await ctx.ports.skills.save({ slug: kebabSkill(sk.name), name: sk.name, purpose: sk.purpose, promptFragment: sk.promptFragment, tools: sk.tools, decisionRule: sk.decisionRule, domain: opts.domain });
          yield { t: "skill.created", name: `[归纳] ${sk.name}`, purpose: sk.purpose };
        }
        if (induced.length) yield { t: "message", text: `🧠 已从本次【真实验收通过】的运行归纳 ${induced.length} 个可复用技能入库（AWM：实例值已抽象成占位符）。` };
      }
      if (process.env.FACTORY_MEMORY_CONSOLIDATE !== "0" && ctx.ports.memory) {
        const res = await consolidateRunMemory({ domain: opts.domain, digest: settleDigest, memory: ctx.ports.memory });
        if (res.written > 0) yield { t: "message", text: `🗂 记忆整合（Mem0 式）：提取 ${res.extracted} 条事实 → ${res.written} 次 ADD/UPDATE/DELETE 写入长期记忆。` };
      }
    } catch (error) {
      learningFailures.push(`运行学习结果保存失败：${safeDiagnostic(error)}`);
      yield { t: "error", message: `运行学习结果保存失败：${safeDiagnostic(error)}（学习类收尾失败，不改判本次交付结果）` };
    }
  }

  // #POLICY-LEARN — 把本次 (pipeline|band) 的结果回喂进 arm 统计：ok = 体面收束；fidelityBad =
  // 出现过保真违约。下次同域同难度选路时用作证据偏置。Configured storage is required:
  // an update failure must prevent an untracked `done` verdict.
  if (!opts.isSubAgent && !humanWaitSuspended && ctx.policy?.band && ctx.ports.policyStats) {
    try {
      const prev = (await ctx.ports.policyStats.load(opts.domain)) ?? null;
      const next = recordOutcome(prev, {
        pipeline: ctx.policy.pipeline,
        band: ctx.policy.band,
        ok: finishedOk && !erroredOut,
        fidelityBad: Boolean(ctx.lastSandbox?.fidelityFailures?.length),
      });
      await ctx.ports.policyStats.save(opts.domain, next);
    } catch (error) {
      learningFailures.push(`策略统计保存失败：${safeDiagnostic(error)}`);
      yield { t: "error", message: `策略统计保存失败：${safeDiagnostic(error)}（学习类收尾失败，不改判本次交付结果）` };
    }
  }
  const status: Extract<BrainEvent, { t: "done" }>["status"] = erroredOut
    ? "errored"
    : humanWaitSuspended
      ? "waiting_human"
    : finishedOk
      ? "finished"
      : budgetStopped || (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS)
        ? "budget_exhausted"
        : ctx.spent.turns >= MAX_TURNS
          ? "turns_exhausted"
          : "incomplete";
  // 学习类收尾失败不改判交付，但必须说出来——否则「学到了什么」这件事会
  // 在无人察觉的情况下悄悄断档。
  if (learningFailures.length > 0) {
    yield {
      t: "message",
      text: `⚠️ 本次运行的学习结果有 ${learningFailures.length} 项未能落库（${learningFailures.join("；")}）。交付结果不受影响，但这次的经验没有沉淀下来。`,
    };
  }
  const completionKind: Extract<BrainEvent, { t: "done" }>["completionKind"] =
    status === "finished"
      ? "delivery"
      : status === "incomplete" && ctx.specs.length === 0 && !ctx.lastSandbox && !generationStalledBeforeAuthoring
        ? "answer"
        : "incomplete";
  yield {
    t: "done",
    // A factory_runs row represents this invocation, while ctx.spent.tokens is
    // intentionally checkpointed across the whole conversation. Never charge
    // historical resume spend to the new run again.
    tokensUsed: currentRunTokens(),
    conversationTokensUsed: ctx.spent.tokens,
    turns: ctx.spent.turns,
    status,
    completionKind,
  };
}
