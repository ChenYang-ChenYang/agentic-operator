// #RULE-GATE-AUTHOR (P0-1, generation half) — emit the manifest rule-gate DECLARATION the runtime
// guard is waiting for.
//
// The runtime half already exists (`packages/runtime/src/rule-guard.ts` + the `tool_use[].rule_gate`
// slot in `manifest.ts`), and the factory already REASONS about rule gates when it grades a draft
// (`acceptance.ts`: `rule_gates` / `rule_gate_bound`). What nothing did was WRITE the declaration —
// so every generated agent shipped with the gate slot empty and the obligation invisible.
//
// The trust split is the runtime's, and this module stays on the authoring side of it:
//
//   • SELECTION is server-authored. The ontology's own `action_steps[].rules[]` says which rules
//     govern which step, and the runtime re-derives that at boot from `actions.json`
//     (`ruleBindingsFromActions`). What we emit in `rules.ids` is the SAME set read from the SAME
//     place; the runtime merges ontology bindings additively, so a manifest can only ever add.
//     The reason to emit it anyway is reach: the runtime's binding keys on the ontology step's
//     `tool` (or step NAME), and in the live corpora 22 of 31 rule-bearing RAAS steps and 2 of 6
//     zhaopin ones name no tool at all — the manifest entry is the only place that can attach those
//     rules to the tool the generated plan actually dispatches.
//
//   • SEVERITY is never authored. Nothing in this file reads `failurePolicy` or `enforcementLevel`;
//     the runtime reads them off the rule row. `executor` IS read — but only to decide whether a
//     human-decision evidence location is REQUIRED, never to grade anything.
//
//   • MODE is never `enforce`. Turning a gate to enforce is an authoring decision with business
//     consequences (it can stop live traffic), and it is only safe once the discharge evidence is
//     really produced. The generator therefore always emits `report`, which is not silence: every
//     finding is recorded and `wouldRefuse` states plainly what an enforcing gate would have
//     stopped. Promoting to enforce stays a human act.
//
//   • A gate never references a verdict nobody produces. `verdict_from` points at a plan step this
//     agent actually has (`results.<stepId>` — the projected action's `result_key`). When the plan
//     has no such step, we still emit the declaration (the obligation is real and belongs in the
//     manifest) but we fall back to the runtime's OWN generic scan and raise a visible gap, rather
//     than naming a step that does not exist.
//
// `scope` is deliberately omitted. The corpora mark domain-wide rules with a sentinel in the same
// field that otherwise names a client ("通用" / "N/A"), and which values mean "everyone" is DATA we
// were not told — guessing it would silently drop governing rules. With no scope declared the
// runtime evaluates no scope axis and every selected rule applies, which is the conservative
// direction.

import { analyzeExecutionPlanRequirement } from "./ontology-execution";
import { resolveActionRuleReferences } from "./rule-gate-evidence";
import type { OntologyAction } from "./ontology-types";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

/** Exactly the object that goes into `tool_use[].rule_gate`. Field names are the manifest's. */
export interface AuthoredRuleGateDeclaration {
  rules: { ids: string[] };
  verdict_from: string[];
  human_boundary_from?: string[];
  /** Always "report" — see the header. */
  mode: "report";
}

export interface AuthoredRuleGate {
  /** The `tool_use[]` entry this declaration belongs on. */
  tool: string;
  declaration: AuthoredRuleGateDeclaration;
  /** Ontology step ids whose `rules[]` produced this gate. */
  fromSteps: string[];
  /** Plan step ids whose result the verdict is read from; empty when `verdict_from` is the
   *  runtime's generic scan because this plan produces no verdict. */
  verdictSteps: string[];
  /** True when nothing in this agent's plan produces the verdict this gate needs. */
  verdictProducerMissing: boolean;
}

export type RuleGateAuthoringGapKind =
  /** A rule reference in the ontology does not resolve to exactly one rule row. */
  | "rule_reference_unresolved"
  /** The ontology attached rules to a step the generated plan does not cover. */
  | "governing_step_not_in_plan"
  /** The governing step is not a tool call, so no tool boundary can carry the obligation. */
  | "governing_step_has_no_tool"
  /** The plan dispatches a tool this agent never selected, so it gets no `tool_use[]` entry. */
  | "governed_tool_not_selected"
  /** Nothing in the plan produces a rule verdict, so the gate can only ever report. */
  | "no_verdict_step"
  /** An `executor: "Human"` rule with no declared location for the resolved human decision. */
  | "human_rule_without_boundary";

export interface RuleGateAuthoringGap {
  kind: RuleGateAuthoringGapKind;
  ruleIds: string[];
  stepId?: string;
  tool?: string;
  /** User-facing (Chinese) — this is shown to the operator, not just logged. */
  detail: string;
}

export interface RuleGateAuthoring {
  gates: AuthoredRuleGate[];
  gaps: RuleGateAuthoringGap[];
}

/** The spec fields this derivation reads. Kept structural so acceptance can recompute it over a
 *  stored spec without reconstructing a whole design context. */
export type RuleGateAuthoringSpec = Pick<GeneratedAgentSpec, "tools" | "plan">;

export interface RuleGateAuthoringInput {
  action: OntologyAction;
  /** The domain's rule rows, exactly as the ontology serves them. */
  rules: readonly Record<string, unknown>[];
  spec: RuleGateAuthoringSpec;
  /** Author-declared evidence locations (validated against the real plan before use). */
  verdictFrom?: readonly string[];
  humanBoundaryFrom?: readonly string[];
}

interface FlatPlanStep {
  step: PlanStep;
  /** Pre-order position — execution order for everything the runtime can see. */
  order: number;
  /** Ancestor step ids, outermost first (empty at the top level). */
  ancestors: string[];
}

function flattenPlan(plan: readonly PlanStep[] | undefined): FlatPlanStep[] {
  const out: FlatPlanStep[] = [];
  const walk = (steps: readonly PlanStep[], ancestors: string[]): void => {
    for (const step of steps) {
      out.push({ step, order: out.length, ancestors });
      if (step.body?.length) walk(step.body, [...ancestors, step.stepId]);
    }
  };
  walk(plan ?? [], []);
  return out;
}

/**
 * Can `producer`'s result be read at `consumer`'s call?
 *
 * The runtime merges a parent's `results` into a foreach body's scope
 * (`results: { ...ctx.results, ...localResults }`), but a body step's result is LOCAL to its
 * iteration and gone by the time a later sibling of the loop runs. So visibility is: earlier in
 * execution order, and on the same nesting level or an enclosing one.
 */
function visibleTo(producer: FlatPlanStep, consumer: FlatPlanStep): boolean {
  if (producer.order >= consumer.order) return false;
  if (producer.ancestors.length > consumer.ancestors.length) return false;
  return producer.ancestors.every(
    (ancestor, index) => consumer.ancestors[index] === ancestor,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One rule-bearing ontology step, joined to the stepId the generated plan must carry. */
interface RuleBearingStep {
  /** The id `analyzeExecutionPlanRequirement` derives — the same id `validatePlanAgainstOntology`
   *  requires the plan to preserve, so this join is the one the rest of the factory already uses. */
  stepId: string;
  sourceName: string;
  /** Tool the ontology itself names on this step, when it names one. */
  declaredTool?: string;
  ruleIds: string[];
  unresolved: number;
}

function ruleBearingSteps(
  action: OntologyAction,
  rules: readonly Record<string, unknown>[],
): { steps: RuleBearingStep[]; unresolvedDetails: string[] } {
  const derived = analyzeExecutionPlanRequirement(action).ontologySteps;
  const steps: RuleBearingStep[] = [];
  const unresolvedDetails: string[] = [];
  let derivedIndex = 0;
  for (const raw of action.action_steps ?? []) {
    const step = record(raw);
    // `analyzeExecutionPlanRequirement` skips non-record entries, so the derived list only
    // advances for real rows — keeping the two index spaces aligned without re-deriving ids here.
    if (!step) continue;
    const identity = derived[derivedIndex++];
    if (!identity) continue;
    if (!Array.isArray(step.rules) || step.rules.length === 0) continue;
    // Resolve THIS step's references only, through the shared exact-match resolver (no prefix, no
    // fuzzy text, no action-name fallback).
    const resolution = resolveActionRuleReferences(
      { ...action, action_steps: [step] } as OntologyAction,
      rules,
    );
    const ruleIds = resolution.relevantRules
      .map((rule) => rule.id || rule.name)
      .filter(Boolean);
    for (const issue of resolution.unresolved)
      unresolvedDetails.push(`${identity.stepId}:${issue.reason}`);
    if (ruleIds.length === 0 && resolution.unresolved.length === 0) continue;
    steps.push({
      stepId: identity.stepId,
      sourceName: identity.sourceName,
      ...(identity.tool ? { declaredTool: identity.tool } : {}),
      ruleIds,
      unresolved: resolution.unresolved.length,
    });
  }
  return { steps, unresolvedDetails };
}

/** Paths the runtime can actually resolve, restricted to locations THIS agent really has. */
export function validateEvidencePaths(
  paths: readonly string[],
  spec: RuleGateAuthoringSpec,
): { ok: true; paths: string[] } | { ok: false; errors: string[] } {
  const stepIds = new Set(flattenPlan(spec.plan).map((flat) => flat.step.stepId));
  const errors: string[] = [];
  const accepted: string[] = [];
  for (const raw of paths) {
    const path = text(raw);
    if (!path) {
      errors.push("空路径");
      continue;
    }
    const [head, ...rest] = path.split(".");
    if (head === "results") {
      const stepId = rest[0];
      if (!stepId) {
        errors.push(`${path}：results 后必须写明具体的 plan stepId`);
        continue;
      }
      if (!stepIds.has(stepId)) {
        errors.push(
          `${path}：plan 里没有 stepId「${stepId}」——不能声明一个没人产出的裁决位置`,
        );
        continue;
      }
    } else if (head !== "lastResult" && head !== "input" && head !== "event") {
      errors.push(
        `${path}：只接受 results.<plan stepId> / lastResult / input.* / event.data.*`,
      );
      continue;
    } else if (head === "event" && rest[0] !== "data") {
      errors.push(`${path}：事件路径必须写成 event.data.*`);
      continue;
    }
    if (!accepted.includes(path)) accepted.push(path);
  }
  return errors.length ? { ok: false, errors } : { ok: true, paths: accepted };
}

/**
 * The runtime's OWN default when an ontology binding exists but nothing declares where the verdict
 * lives (`step-engine.ts`, `bootstrap.ts`). Reused verbatim so the honest "we do not know" case
 * says exactly what the runtime already says, instead of inventing a third vocabulary.
 */
const GENERIC_VERDICT_SCAN = ["results", "lastResult"] as const;

/**
 * Author the rule-gate declarations for ONE designed agent.
 *
 * Returns no gates when the action carries no rule references at all — an ungoverned action gets an
 * empty slot, not an empty gate.
 */
export function authorRuleGates(input: RuleGateAuthoringInput): RuleGateAuthoring {
  const { action, rules, spec } = input;
  const { steps, unresolvedDetails } = ruleBearingSteps(action, rules);
  const gaps: RuleGateAuthoringGap[] = [];
  if (steps.length === 0) return { gates: [], gaps };

  if (unresolvedDetails.length)
    gaps.push({
      kind: "rule_reference_unresolved",
      ruleIds: [],
      detail: `Ontology 里有 ${unresolvedDetails.length} 处规则引用无法唯一对应到规则行（${unresolvedDetails.slice(0, 4).join("、")}${unresolvedDetails.length > 4 ? "…" : ""}），这些规则没有进入任何规则闸——请补准确的 rule id 或唯一名称。`,
    });

  const flat = flattenPlan(spec.plan);
  const byStepId = new Map(flat.map((entry) => [entry.step.stepId, entry] as const));
  const selected = new Set(spec.tools ?? []);

  // Which plan steps can produce a verdict for a gate: the rule-bearing ontology steps that are NOT
  // themselves a guarded tool call. The ontology says the rules are consulted there; a non-tool step
  // is exactly the place where this agent evaluates them and leaves the result in `results.<id>`.
  // (zhaopin `ruleCheckForCandidateIdentity` is the live shape: rule 9-15 sits on the logic step
  // `extractCandidateIdentityRecord` AND on the guarded tool step `resolveIdentityMatch`.)
  const producerByRule = new Map<string, FlatPlanStep[]>();
  for (const step of steps) {
    const planStep = byStepId.get(step.stepId);
    if (!planStep) continue;
    if (planStep.step.kind === "tool") continue;
    for (const ruleId of step.ruleIds) {
      const bucket = producerByRule.get(ruleId) ?? [];
      bucket.push(planStep);
      producerByRule.set(ruleId, bucket);
    }
  }

  const authoredVerdict = input.verdictFrom?.length
    ? validateEvidencePaths(input.verdictFrom, spec)
    : null;
  const authoredHumanBoundary = input.humanBoundaryFrom?.length
    ? validateEvidencePaths(input.humanBoundaryFrom, spec)
    : null;

  interface Pending {
    tool: string;
    ruleIds: string[];
    fromSteps: string[];
    verdictSteps: FlatPlanStep[];
  }
  const pending = new Map<string, Pending>();

  for (const step of steps) {
    if (step.ruleIds.length === 0) continue;
    const planStep = byStepId.get(step.stepId);
    if (!planStep) {
      gaps.push({
        kind: "governing_step_not_in_plan",
        ruleIds: step.ruleIds,
        stepId: step.stepId,
        detail: `Ontology 把 ${step.ruleIds.length} 条规则挂在步骤「${step.sourceName}」上，但生成的 plan 没有这个步骤——这些规则在运行时没有任何落点。`,
      });
      continue;
    }
    const tool = planStep.step.kind === "tool" ? text(planStep.step.tool) : "";
    if (!tool) {
      gaps.push({
        kind: "governing_step_has_no_tool",
        ruleIds: step.ruleIds,
        stepId: step.stepId,
        detail: `步骤「${step.sourceName}」不是工具调用（kind=${planStep.step.kind}），工具边界上的规则闸结构上够不着它挂的 ${step.ruleIds.length} 条规则——只能在这一步自身的逻辑里保证。`,
      });
      continue;
    }
    if (!selected.has(tool)) {
      gaps.push({
        kind: "governed_tool_not_selected",
        ruleIds: step.ruleIds,
        stepId: step.stepId,
        tool,
        detail: `步骤「${step.sourceName}」派发工具 ${tool}，但它不在本 agent 已选工具里，manifest 不会为它生成 tool_use 条目，规则闸也就无处安放。`,
      });
      continue;
    }
    if (step.declaredTool && step.declaredTool !== tool)
      gaps.push({
        kind: "governed_tool_not_selected",
        ruleIds: step.ruleIds,
        stepId: step.stepId,
        tool,
        detail: `Ontology 在步骤「${step.sourceName}」上声明的工具是 ${step.declaredTool}，plan 实际派发的是 ${tool}——规则闸按实际派发的工具声明，请确认这是同一个执行面。`,
      });

    const entry = pending.get(tool) ?? {
      tool,
      ruleIds: [],
      fromSteps: [],
      verdictSteps: [],
    };
    for (const ruleId of step.ruleIds)
      if (!entry.ruleIds.includes(ruleId)) entry.ruleIds.push(ruleId);
    if (!entry.fromSteps.includes(step.stepId)) entry.fromSteps.push(step.stepId);
    for (const ruleId of step.ruleIds)
      for (const producer of producerByRule.get(ruleId) ?? [])
        if (visibleTo(producer, planStep) && !entry.verdictSteps.includes(producer))
          entry.verdictSteps.push(producer);
    pending.set(tool, entry);
  }

  const humanRuleIds = new Set(
    rules
      .filter((rule) => text(rule.executor) === "Human")
      .map((rule) => text(rule.id))
      .filter(Boolean),
  );

  const gates: AuthoredRuleGate[] = [];
  for (const entry of pending.values()) {
    const derivedVerdict = [...entry.verdictSteps]
      .sort((a, b) => a.order - b.order)
      .map((producer) => `results.${producer.step.stepId}`);
    const verdictFrom = authoredVerdict?.ok
      ? authoredVerdict.paths
      : derivedVerdict.length
        ? derivedVerdict
        : [...GENERIC_VERDICT_SCAN];
    const verdictProducerMissing = !authoredVerdict?.ok && derivedVerdict.length === 0;
    if (verdictProducerMissing)
      gaps.push({
        kind: "no_verdict_step",
        ruleIds: entry.ruleIds,
        tool: entry.tool,
        detail: `${entry.tool} 上的 ${entry.ruleIds.length} 条规则义务已声明，但本 agent 的 plan 里没有产出规则裁决的步骤——闸门只能 report（运行时会按「缺裁决证据」逐条记录）。要真正 enforce，先让某一步产出裁决并用 rule_verdict_from 指明位置。`,
      });

    const governedHumanRules = entry.ruleIds.filter((id) => humanRuleIds.has(id));
    const humanBoundaryFrom = authoredHumanBoundary?.ok
      ? authoredHumanBoundary.paths
      : undefined;
    if (governedHumanRules.length && !humanBoundaryFrom)
      gaps.push({
        kind: "human_rule_without_boundary",
        ruleIds: governedHumanRules,
        tool: entry.tool,
        detail: `${entry.tool} 受 ${governedHumanRules.length} 条 executor=Human 的规则约束（${governedHumanRules.slice(0, 3).join("、")}${governedHumanRules.length > 3 ? "…" : ""}），但没有声明「已解决且同意的人工决定」落在哪里——运行时会逐条拒绝这些规则，直到用 rule_human_boundary_from 指明真实位置。`,
      });

    gates.push({
      tool: entry.tool,
      declaration: {
        rules: { ids: entry.ruleIds },
        verdict_from: verdictFrom,
        ...(humanBoundaryFrom ? { human_boundary_from: humanBoundaryFrom } : {}),
        mode: "report",
      },
      fromSteps: entry.fromSteps,
      verdictSteps: derivedVerdict.map((path) => path.slice("results.".length)),
      verdictProducerMissing,
    });
  }

  if (authoredVerdict && !authoredVerdict.ok)
    gaps.push({
      kind: "no_verdict_step",
      ruleIds: [],
      detail: `声明的规则裁决位置无效，已忽略：${authoredVerdict.errors.slice(0, 4).join("；")}`,
    });
  if (authoredHumanBoundary && !authoredHumanBoundary.ok)
    gaps.push({
      kind: "human_rule_without_boundary",
      ruleIds: [],
      detail: `声明的人工决定位置无效，已忽略：${authoredHumanBoundary.errors.slice(0, 4).join("；")}`,
    });

  return { gates, gaps };
}

/** One-line operator summary. Empty string when there is nothing to say. */
export function describeRuleGateAuthoring(authoring: RuleGateAuthoring): string {
  if (!authoring.gates.length && !authoring.gaps.length) return "";
  const parts: string[] = [];
  if (authoring.gates.length) {
    const ruleCount = new Set(
      authoring.gates.flatMap((gate) => gate.declaration.rules.ids),
    ).size;
    parts.push(
      `🔒 已为 ${authoring.gates.length} 个工具声明规则闸（${ruleCount} 条规则，mode=report，严重级别与是否 enforce 都不由生成器决定）`,
    );
  }
  for (const gap of authoring.gaps.slice(0, 3)) parts.push(`⚠ ${gap.detail}`);
  if (authoring.gaps.length > 3) parts.push(`⚠ 另有 ${authoring.gaps.length - 3} 处规则闸缺口`);
  return parts.join(" · ");
}
