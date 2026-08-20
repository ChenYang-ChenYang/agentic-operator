import { createHash } from "node:crypto";
import type {
  BrainCtx,
  FactoryAppliedAssumption,
  FactoryAssumptionGate,
} from "./brain-types";
import type { FactoryInteractionPolicy } from "./generation-directive";

export interface FactoryClarificationPrompt {
  question: string;
  context?: string;
  options?: Array<{
    label: string;
    value: string;
    recommended?: boolean;
  }>;
}

export interface FactoryAutopilotClarificationResolution {
  answer: string;
  source: "recommended" | "safe_default";
  assumption: FactoryAppliedAssumption;
}

const AUTHORIZATION_CONTEXT =
  /(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i;
const AUTHORIZATION_TOKEN =
  /authorize_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:/i;
const CREDENTIAL =
  /api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|password|passwd|credential|凭证|密钥|令牌/i;
const CREDENTIAL_REQUIRED =
  /(?:缺少|需要|要求|提供|输入|配置|设置|未配置|未设置|missing|required|provide|configure|not configured|unset)[^。；;\n]{0,50}(?:api[_ -]?key|token|secret|password|credential|凭证|密钥|令牌)|(?:api[_ -]?key|token|secret|password|credential|凭证|密钥|令牌)[^。；;\n]{0,50}(?:缺少|需要|要求|提供|输入|配置|设置|未配置|未设置|missing|required|provide|configure|not configured|unset)/i;
const PRODUCTION =
  /production|prod\b|正式环境|生产环境|线上环境/i;
const HUMAN_CONSENT =
  /authorize|authorization|approve|approval|confirm|confirmation|consent|permission|allow|may\s+i|shall\s+we|should\s+(?:i|we)|do\s+you\s+want|确认|批准|授权|允许|同意|是否|要不要|可否|可以吗|执行吗/i;
const EXTERNAL_SIDE_EFFECT =
  /(?:external|remote|production|prod\b|正式环境|生产环境|线上环境|外部|真实|线上)?[^。；;\n]{0,24}(?:write|delete|remove|send|notify|contact|e-?mail|message|invite|call|publish|deploy|release|charge|bill|create[^。；;\n]{0,24}(?:ticket|order|account)|live\s+call|写入|删除|移除|发送|通知|联系|邮件|消息|邀请|拨打|外发|发布|部署|上线|收费|扣款|开票|创建(?:工单|订单|账户)|真实调用|外呼)|(?:write|delete|remove|send|notify|contact|e-?mail|message|invite|call|publish|deploy|release|charge|bill|create[^。；;\n]{0,24}(?:ticket|order|account)|live\s+call|写入|删除|移除|发送|通知|联系|邮件|消息|邀请|拨打|外发|发布|部署|上线|收费|扣款|开票|创建(?:工单|订单|账户)|真实调用|外呼)[^。；;\n]{0,24}(?:external|remote|production|prod\b|正式环境|生产环境|线上环境|外部|真实|线上)?/i;
const SAFE_DEFAULT =
  /只读|草稿|稍后|跳过|不执行|不写|不删|不发送|不发布|不部署|保持阻塞|人工处理|占位|read.?only|draft|defer|skip|do not|don['’]?t|no write|no delete|no send|no publish|no deploy|block|placeholder/i;
const AUTHORITATIVE_FACT_GAP =
  /integration[_ -]?bindings?|integration[_ -]?profile|connection[_ -]?(?:config|identity|binding)|连接配置|连接身份|集成绑定|尚无已授权工具|没有已授权工具|运行时能力|runtime capability|rule[_ -]?tool[_ -]?selection|规则工具选择|authoritative ontology|权威\s*ontology|本体权威修订|ontology corrections?/i;

export type FactoryClarificationHardBlockReason =
  | "authorization_challenge"
  | "credential_required"
  | "production_side_effect"
  | "side_effect_authorization"
  | "authoritative_fact_required"
  | "unsafe_default";

export class FactoryInteractionPolicyChangeError extends Error {
  readonly code = "interaction_policy_immutable";

  constructor() {
    super(
      "interaction policy is immutable within a Factory conversation; start a new task",
    );
    this.name = "FactoryInteractionPolicyChangeError";
  }
}

/** Saved control-plane policy is not a user preference that can be upgraded on
 * a later turn. Older checkpoints without a field are conservatively strict. */
export function resolveFactoryConversationInteractionPolicy(input: {
  saved: boolean;
  savedPolicy?: FactoryInteractionPolicy;
  requestedPolicy?: FactoryInteractionPolicy;
}): FactoryInteractionPolicy {
  const savedPolicy = input.savedPolicy ?? "strict";
  if (
    input.saved &&
    input.requestedPolicy !== undefined &&
    input.requestedPolicy !== savedPolicy
  ) {
    throw new FactoryInteractionPolicyChangeError();
  }
  return input.saved
    ? savedPolicy
    : input.requestedPolicy ?? savedPolicy;
}

const text = (prompt: FactoryClarificationPrompt): string =>
  [
    prompt.question,
    prompt.context ?? "",
    ...(prompt.options ?? []).flatMap((option) => [
      option.label,
      option.value,
    ]),
  ].join("\n");

export function autopilotClarificationHardBlockReason(
  ctx: Pick<BrainCtx, "pendingAuthorizationChallenges">,
  prompt: FactoryClarificationPrompt,
): FactoryClarificationHardBlockReason | null {
  const material = text(prompt);
  if (
    AUTHORIZATION_CONTEXT.test(material) ||
    AUTHORIZATION_TOKEN.test(material) ||
    Object.values(ctx.pendingAuthorizationChallenges ?? {}).some(
      (challenge) =>
        challenge.context === prompt.context ||
        challenge.question === prompt.question,
    )
  ) {
    return "authorization_challenge";
  }
  if (
    CREDENTIAL_REQUIRED.test(material) ||
    (CREDENTIAL.test(material) &&
      /integration profile|连接配置|认证配置|credential setup/i.test(material))
  ) {
    return "credential_required";
  }
  if (AUTHORITATIVE_FACT_GAP.test(material)) {
    return "authoritative_fact_required";
  }
  if (PRODUCTION.test(material) && EXTERNAL_SIDE_EFFECT.test(material)) {
    return "production_side_effect";
  }
  if (HUMAN_CONSENT.test(material) && EXTERNAL_SIDE_EFFECT.test(material)) {
    return "side_effect_authorization";
  }
  const recommended = (prompt.options ?? []).filter(
    (option) => option.recommended === true,
  );
  if (
    recommended.length === 1 &&
    EXTERNAL_SIDE_EFFECT.test(
      `${recommended[0]!.label}\n${recommended[0]!.value}`,
    ) &&
    !SAFE_DEFAULT.test(
      `${recommended[0]!.label}\n${recommended[0]!.value}`,
    )
  ) {
    return "side_effect_authorization";
  }
  if (
    (prompt.options?.length ?? 0) > 0 &&
    recommended.length !== 1 &&
    !(prompt.options ?? []).some((option) =>
      SAFE_DEFAULT.test(`${option.label}\n${option.value}`),
    )
  ) {
    // With no single recommendation, autopilot may only choose an explicitly
    // non-executing option. A neutral-looking label is not authority.
    return "unsafe_default";
  }
  return null;
}

function optionRisk(option: { label: string; value: string }): number {
  const value = `${option.label}\n${option.value}`;
  let score = 0;
  if (
    SAFE_DEFAULT.test(value)
  ) {
    score -= 20;
  }
  if (
    /production|prod\b|正式环境|生产环境|执行|写入|删除|发送|通知|联系|邮件|消息|邀请|拨打|发布|部署|上线|收费|扣款|创建工单|真实调用|write|delete|send|notify|contact|e-?mail|message|invite|call|charge|create.{0,24}ticket|publish|deploy|live call/i.test(
      value,
    )
  ) {
    score += 40;
  }
  return score;
}

function chooseClarification(prompt: FactoryClarificationPrompt): {
  answer: string;
  source: "recommended" | "safe_default";
} | null {
  const options = prompt.options ?? [];
  const recommended = options.filter((option) => option.recommended === true);
  if (recommended.length === 1) {
    return { answer: recommended[0]!.value, source: "recommended" };
  }
  const safeCandidates = options.filter((option) =>
    SAFE_DEFAULT.test(`${option.label}\n${option.value}`),
  );
  if (safeCandidates.length) {
    const safest = [...safeCandidates].sort(
      (a, b) =>
        optionRisk(a) - optionRisk(b) ||
        a.value.localeCompare(b.value),
    )[0]!;
    return {
      answer: safest.value,
      source: "safe_default",
    };
  }
  if (options.length) return null;
  return {
    answer:
      "采用最保守默认：继续生成可审查草稿，保持只读，不启用外部写入、真实副作用或生产执行。",
    source: "safe_default",
  };
}

export function recordFactoryAssumption(
  ctx: Pick<BrainCtx, "assumptions" | "emit">,
  input: {
    gate: FactoryAssumptionGate;
    subject: string;
    value: string;
    source: "recommended" | "safe_default";
    detail?: string;
  },
): FactoryAppliedAssumption {
  const id = `asm_${createHash("sha256")
    .update(
      JSON.stringify({
        gate: input.gate,
        subject: input.subject,
        value: input.value,
        source: input.source,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24)}`;
  const existing = ctx.assumptions?.find((assumption) => assumption.id === id);
  if (existing) return existing;
  const assumption: FactoryAppliedAssumption = {
    id,
    gate: input.gate,
    subject: input.subject.slice(0, 600),
    value: input.value.slice(0, 2_000),
    source: input.source,
    ...(input.detail ? { detail: input.detail.slice(0, 1_000) } : {}),
    appliedAt: Date.now(),
  };
  (ctx.assumptions ??= []).push(assumption);
  ctx.assumptions = ctx.assumptions.slice(-500);
  ctx.emit({
    t: "assumption.applied",
    assumption,
    summary: `${assumption.subject} → ${assumption.value}`.slice(0, 500),
  });
  return assumption;
}

export function resolveAutopilotClarification(
  ctx: Pick<
    BrainCtx,
    | "interactionPolicy"
    | "pendingAuthorizationChallenges"
    | "assumptions"
    | "emit"
  >,
  prompt: FactoryClarificationPrompt,
): FactoryAutopilotClarificationResolution | null {
  if (ctx.interactionPolicy !== "autopilot") return null;
  if (autopilotClarificationHardBlockReason(ctx, prompt)) return null;
  const selected = chooseClarification(prompt);
  if (!selected) return null;
  const assumption = recordFactoryAssumption(ctx, {
    gate: "clarify",
    subject: prompt.question,
    value: selected.answer,
    source: selected.source,
    detail: prompt.context,
  });
  return { ...selected, assumption };
}

export type FactoryAutopilotTestApprovalBlockReason =
  | "coverage_unknown"
  | "coverage_incomplete"
  | "authorization_pending"
  | "external_write_requires_human";

/** Test execution can be auto-approved only when it is a fully covered,
 * side-effect-free sandbox decision.  It is intentionally stricter than a
 * general clarification: coverage waivers and external-write authority must
 * always come from a human. */
export function autopilotTestApprovalBlockReason(
  ctx: Pick<
    BrainCtx,
    | "testCoverage"
    | "pendingAuthorizationChallenges"
    | "specs"
  >,
): FactoryAutopilotTestApprovalBlockReason | null {
  if (!ctx.testCoverage) return "coverage_unknown";
  if (ctx.testCoverage.uncoveredNeedingData.length > 0) {
    return "coverage_incomplete";
  }
  if (Object.keys(ctx.pendingAuthorizationChallenges ?? {}).length > 0) {
    return "authorization_pending";
  }
  const externalWrite = ctx.specs.some((spec) => {
    if (
      Object.values(spec.toolSideEffects ?? {}).some(
        (effect) => effect === "write" || effect === "dual",
      )
    ) {
      return true;
    }
    return Object.values(spec.toolPolicies ?? {}).some(
      (policy) =>
        policy.effectScope === "external" &&
        (policy.operation === "write" ||
          policy.operation === "read_write" ||
          policy.sandboxPolicy === "requires_attempt_grant"),
    );
  });
  if (externalWrite) {
    return "external_write_requires_human";
  }
  return null;
}
