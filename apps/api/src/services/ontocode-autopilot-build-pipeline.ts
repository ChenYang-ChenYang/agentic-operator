import { z } from "zod";
import {
  ONTOCODE_COMMAND_POLICY,
  resolveOntoCodeAutonomyActionPolicy,
  type OntoCodeAutonomyMode,
  type OntoCodeCommandType,
} from "@agentic/contracts";

export const ONTOCODE_AUTOPILOT_BUILD_PIPELINE_SCHEMA =
  "ontocode-autopilot-build-pipeline/v1" as const;

const OntoCodeAutopilotBuildPipelineSchema = z
  .object({
    schema: z.literal(ONTOCODE_AUTOPILOT_BUILD_PIPELINE_SCHEMA),
    pipelineId: z.string().trim().min(1).max(256),
    target: z.literal("generate_package"),
    scopeMode: z.literal("full_domain"),
  })
  .strict();

export type OntoCodeAutopilotBuildPipeline = z.infer<
  typeof OntoCodeAutopilotBuildPipelineSchema
>;

const PIPELINE_ACTIONS = new Set<OntoCodeCommandType>([
  "analyze_scope",
  "propose_blueprint",
  "generate_package",
]);
const FULL_BUILD_PLANNER_ACTIONS = new Set<OntoCodeCommandType>([
  "analyze_ontology",
  ...PIPELINE_ACTIONS,
]);

function normalizedRequest(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A reference to the current/bound Ontology plus an explicit request for
 * Agent code is also whole-domain authority. In product language, “generate
 * agents code for the current Ontology” names both the source boundary and
 * the package target; requiring the extra word “full” made that ordinary
 * request stop after Scope even in sandbox_autopilot.
 *
 * Keep this deliberately narrower than a pair of loose keyword checks. The
 * generation verb must sit next to the plural/generic Agent target, code must
 * be explicit in the same bounded request, and the Ontology phrase must
 * describe the whole current source. A targeted request such as “for
 * processResume” therefore cannot silently widen into full_domain.
 */
function isOntologyWideAgentCodeRequest(text: string): boolean {
  const chineseOrMixedForward =
    /(?:(?:当前|这个|该|整个|完整|我们的|本域的|该域的)(?:的)?(?:本体|\bontology\b)|(?:根据|基于|使用)\s*(?:(?:当前|这个|该|整个|完整|我们的|本域的|该域的)(?:的)?)?(?:本体|\bontology\b))[\s，,:：]*(?:(?:请|帮我|直接)\s*)?(?:生成|构建|编写|创建|产出|实现)[\s，,:：]*(?:(?:全部|所有|全量|完整|一组|这些)\s*)?(?:\bagents?\b|智能体)[\s_-]*(?:代码|\bcode\b)/u.test(
      text,
    );
  const chineseOrMixedSplit =
    /(?:(?:当前|这个|该|整个|完整|我们的|本域的|该域的)(?:的)?(?:本体|\bontology\b)|(?:根据|基于|使用)\s*(?:(?:当前|这个|该|整个|完整|我们的|本域的|该域的)(?:的)?)?(?:本体|\bontology\b)).{0,24}(?:生成|构建|创建|设计)[\s，,:：]*(?:(?:需要生成的|全部|所有|全量|完整|一组|这些)\s*)?(?:\bagents\b|智能体)(?=[\s，,:：。.!！？]|$).{0,64}(?:(?:编写|写|实现|产出|生成).{0,8})?(?:代码|\bcode\b|\bcoding\b)/u.test(
      text,
    );
  // A named Business Domain is just as precise a whole-source boundary as
  // "current Ontology". Keep the generic plural Agent target adjacent to the
  // Ontology phrase so a request for one named Agent (for example
  // processResume) cannot be widened into a full-domain Build.
  const chineseDomainQualifiedForward =
    /[\p{L}\p{N}_-]{2,120}\s*领域(?:的)?\s*(?:本体|\bontology\b)\s*(?:的)?[\s，,:\uff1a]*(?:(?:请|帮我|直接)\s*)?(?:生成|构建|编写|创建|产出|实现)[\s，,:\uff1a]*(?:(?:全部|所有|全量|完整|一组|这些)\s*)?(?:\bagents\b|智能体)[\s_-]*(?:代码|\bcode\b)/u.test(
      text,
    );
  const chineseDomainQualifiedReverse =
    /(?:生成|构建|编写|创建|产出|实现)[\s，,:\uff1a]*[\p{L}\p{N}_-]{2,120}\s*领域(?:的)?\s*(?:本体|\bontology\b)\s*(?:的)?[\s，,:\uff1a]*(?:(?:全部|所有|全量|完整|一组|这些)\s*)?(?:\bagents\b|智能体)[\s_-]*(?:代码|\bcode\b)/u.test(
      text,
    );
  const englishForward =
    /\b(?:current|this|whole|entire)\s+ontology\b[\s,:-]*(?:please\s+)?\b(?:generate|build|create|write|produce|implement)\b[\s,:-]*(?:(?:all|the|these)\s+)?agents?\s+(?:code|package)\b/u.test(
      text,
    ) ||
    /\bontology\b[\s,:-]*(?:please\s+)?\b(?:generate|build|create|write|produce|implement)\b[\s,:-]*(?:(?:all|the|these)\s+)?agents?\s+(?:code|package)\b/u.test(
      text,
    );
  const englishReverse =
    /\b(?:generate|build|create|write|produce|implement)\b[\s,:-]*(?:(?:all|the|these)\s+)?agents?\s+(?:code|package)\b[\s,:-]*(?:for|from|using|based\s+on)\s+(?:the\s+)?(?:current\s+|this\s+|whole\s+|entire\s+)?ontology\b/u.test(
      text,
    );
  return (
    chineseOrMixedForward ||
    chineseOrMixedSplit ||
    chineseDomainQualifiedForward ||
    chineseDomainQualifiedReverse ||
    englishForward ||
    englishReverse
  );
}

/**
 * Recognize explicit authority for a whole/full Build. A generic "build",
 * "continue", a named-Agent request, or an analysis request is not enough
 * authority for the server to add autonomous follow-up Commands.
 */
export function isExplicitFullBuildRequest(value: string): boolean {
  const text = normalizedRequest(value);
  if (!text) return false;
  const chinese =
    /(?:全量|全部|完整|整个|全域|端到端).{0,16}(?:构建|生成|build)/u.test(
      text,
    ) ||
    /(?:构建|生成|build).{0,16}(?:全部|全量|完整|所有|整个|全域)/u.test(text);
  const english =
    /\b(?:full|complete|whole|entire|all[- ]domain|end[- ]to[- ]end)\b.{0,32}\b(?:build|generate|create|produce)\b/u.test(
      text,
    ) ||
    /\b(?:build|generate|create|produce)\b.{0,32}\b(?:all|full|complete|whole|entire|all[- ]domain)\b/u.test(
      text,
    );
  return chinese || english || isOntologyWideAgentCodeRequest(text);
}

export function createOntoCodeAutopilotBuildPipeline(
  pipelineId: string,
): OntoCodeAutopilotBuildPipeline {
  return OntoCodeAutopilotBuildPipelineSchema.parse({
    schema: ONTOCODE_AUTOPILOT_BUILD_PIPELINE_SCHEMA,
    pipelineId,
    target: "generate_package",
    scopeMode: "full_domain",
  });
}

export function readOntoCodeAutopilotBuildPipeline(
  value: unknown,
): OntoCodeAutopilotBuildPipeline | null {
  const result = OntoCodeAutopilotBuildPipelineSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function resolveOntoCodeAutopilotBuildStart(input: {
  autonomyMode: OntoCodeAutonomyMode;
  userText: string;
  plannerBehavior: "navigate" | "explain" | "clarify" | "execute";
  plannerAction?: OntoCodeCommandType;
  pipelineId: string;
  waitingBuildInteraction: boolean;
}): {
  action: "analyze_scope";
  pipeline: OntoCodeAutopilotBuildPipeline;
} | null {
  if (
    // A reply to a waiting Build belongs to that stable execution. Starting a
    // new Scope -> Blueprint -> Package pipeline here would split one Build
    // into two lifecycles and discard the active human interaction.
    input.waitingBuildInteraction ||
    input.autonomyMode !== "sandbox_autopilot" ||
    input.plannerBehavior !== "execute" ||
    !input.plannerAction ||
    !FULL_BUILD_PLANNER_ACTIONS.has(input.plannerAction) ||
    !isExplicitFullBuildRequest(input.userText)
  ) {
    return null;
  }
  return {
    // Scope is the real prerequisite. Ontology comprehension is useful, but it
    // is not a generation boundary and cannot ground Blueprint by itself.
    action: "analyze_scope",
    pipeline: createOntoCodeAutopilotBuildPipeline(input.pipelineId),
  };
}

/**
 * What the FDE is told when the server normalises "build the whole thing" into
 * the Scope → Blueprint → Package pipeline.
 *
 * Lives here, exported, so #HUMAN-TEXT-GUARD can hold it to the same standard
 * as the other chat producers: it used to name the engine's own objects
 * ("耐久 Command/Job" / "Commands/Jobs"), which is backend vocabulary. The
 * load-bearing part is the limit — this pipeline stops before tests,
 * comparison and release, and still says so.
 */
export function ontoCodeAutopilotBuildStartText(chinese: boolean): string {
  return chinese
    ? "已开始全量 Build：先锁定当前 Ontology 的完整 Agent Action 范围，成功后依次出蓝图和代码。不会自动跑测试、做回归对比，也不会发布。"
    : "I started the full Build: it first pins the complete Agent Action scope for this Ontology, then produces the blueprint and the code in turn. It will not run tests, compare against a previous version, or release anything.";
}

/** Keep the server-owned reasoning suffix on the Chinese FDE-facing surface. */
export function ontoCodeAutopilotBuildRationaleSummary(
  rationaleSummary: string,
): string {
  return `${rationaleSummary}；服务端已将明确的全量 Build 请求规范为 Scope → 蓝图 → 代码流程。`.slice(
    0,
    1_000,
  );
}

export function nextOntoCodeAutopilotBuildAction(
  current: OntoCodeCommandType,
): "propose_blueprint" | "generate_package" | null {
  if (current === "analyze_scope") return "propose_blueprint";
  if (current === "propose_blueprint") return "generate_package";
  return null;
}

/**
 * Defense in depth for the worker: even if a malformed marker reaches storage,
 * automatic continuation remains limited to read/draft work in the autonomous
 * mode. Tests, Sandbox execution, comparison and release are never part of
 * this pipeline.
 */
export function mayAutonomouslyContinueBuildPipeline(
  autonomyMode: OntoCodeAutonomyMode,
  action: OntoCodeCommandType,
): boolean {
  if (autonomyMode !== "sandbox_autopilot" || !PIPELINE_ACTIONS.has(action)) {
    return false;
  }
  const base = ONTOCODE_COMMAND_POLICY[action];
  const autonomy = resolveOntoCodeAutonomyActionPolicy(autonomyMode, action);
  return (
    autonomy.allowed &&
    !autonomy.requiresHuman &&
    !base.requiresHuman &&
    (base.riskClass === "read_only" || base.riskClass === "draft_change")
  );
}
