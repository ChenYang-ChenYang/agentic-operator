// R15 — a domain-independent production acceptance bar, as an executable check.
//
// A generated agent set reaches the standard when it covers every Agent action,
// every tool resolves, a NON-simulated sandbox
// registered real functions and ran the chain to terminal with no degrade, structurally-declared
// rule gates have a verified rule-reading execution surface, and every I/O is typed from the
// ontology event_data.
// This makes the bar testable + surfaceable; the actual live end-to-end run is the manual step.

import type { GeneratedAgentSpec, PlanStep } from "./spec-types";
import type { DomainOntology } from "./ontology-types";
import { coverageGap } from "./graph";
import {
  isReviewedToolExecutionPolicy,
  requiresAttemptGrantPolicy,
} from "./design-loop";
import { analyzeOntologyReadiness } from "./ontology-readiness";
import { deriveIntegrationRequirements } from "./integration-binding";
import type { IntegrationBindingStatus, IntegrationRequirement } from "./integration-binding";
import type { RealTool } from "./tool-catalog";
import { assessRuleGate } from "./rule-gate-evidence";
import { authorRuleGates } from "./rule-gate-authoring";
import type { SandboxBrokerRegistrationProof, SandboxToolDispatchReceipt } from "./ports";
import type { SandboxExecutionPlaneReceipt } from "./sandbox-execution-plane";
import { sandboxExecutionReceiptIssues } from "./sandbox-execution-plane";
import { sandboxRegistrationEvidenceIssues } from "./sandbox-registration";
import {
  generatedFleetModelRequirement,
  sandboxModelUsageEvidenceIssues,
  type SandboxModelUsageEvidence,
} from "./sandbox-model-usage";
import { validateGeneratedToolCoverage } from "./code-lint";

function flattenPlan(steps: readonly PlanStep[] | undefined): PlanStep[] {
  return (steps ?? []).flatMap((step) => [
    step,
    ...flattenPlan(step.body),
  ]);
}

export interface AcceptanceSandbox {
  appId?: string;
  committedManifestFunctionIds?: string[];
  brokerRegistration?: SandboxBrokerRegistrationProof;
  /** Explicit unit-fixture compatibility only; ignored outside NODE_ENV=test. */
  testOnlyRegistrationBypass?: boolean;
  /** @deprecated Diagnostic compatibility for old transcripts only. */
  registeredIds?: string[];
  functionsRegistered?: number;
  ran?: number;
  fullChainRan?: boolean;
  /** the chain reached a SUCCESS (non-failish) terminal — strong evidence even when fullChainRan
   *  flickers false because slow rule-gate agents were still `running` at snapshot time. */
  reachedSuccessTerminal?: boolean;
  /** Per-approved-case runtime verdicts. Together with the exact expected case
   * ids these can prove a complete suite when the aggregate fullChainRan bit
   * was sampled before its final projection settled. */
  caseVerdicts?: CompleteSuiteVerdicts;
  expectedCaseIds?: string[];
  /** #REDESIGN P1 — spec shorts whose GENERATED CODE actually ran (not fell back to declarative). */
  codeRanAgents?: string[];
  degradedAgents?: string[];
  /** #R3 — shorts whose REAL emitted payload violated the downstream field contract
   *  (from evaluateExecutionFidelity over the sandbox agentRuns). Undefined ⇒ not graded ⇒ lenient pass. */
  fidelityFailures?: string[];
  /** #TESTER-WIRE — per-spec P2.5 function-tester verdicts (the rendered .ts deliverable really
   *  executed in isolation). Undefined on a REAL run ⇒ UNKNOWN ⇒ blocks (3-state, like fidelity). */
  functionTester?: Array<{ short: string; pass: boolean; ran: boolean; reasons: string[]; tier: string; qualification?: "development_only" | "promotable"; fixtureMode?: "evidence" | "scripted" | "missing" }>;
  /** #TESTER-WIRE — sandbox chain tool dispatch mode (mock/replay/live/gated) for honest detail text. */
  toolMode?: string;
  externalLiveCalls?: number | null;
  replayReceipts?: SandboxToolDispatchReceipt[];
  sandboxReplayEvidenceComplete?: boolean;
  /** Evidence tied to the sandboxed spec fingerprint. `false` explicitly
   * proves this chain contains no external-write tool; undefined is unknown. */
  externalWritesRequired?: boolean;
  /** Exact evidence identity + remote runner attestation. */
  specsFingerprint?: string;
  candidateFingerprint?: string;
  targetDomainId?: string;
  sandboxAttemptId?: string;
  executionReceipt?: SandboxExecutionPlaneReceipt;
  modelUsage?: SandboxModelUsageEvidence;
  simulated?: boolean;
}

export interface CompleteSuiteVerdicts {
  allPass: boolean;
  results: Array<{ caseId?: string; kind: string; pass: boolean; reason: string }>;
}

export interface CompleteSuiteEvidence {
  fullChainRan?: boolean;
  degradedAgents?: readonly string[];
  caseVerdicts?: CompleteSuiteVerdicts;
  expectedCaseIds?: readonly string[];
}

export interface CompleteSuiteAssessment {
  complete: boolean;
  source: "full_chain" | "case_verdicts" | "incomplete";
  detail: string;
}

/** One fail-closed definition of "the whole approved suite completed" shared
 * by sandbox_run, finish, API draft finish and acceptanceGate. Prefer the
 * runtime's aggregate fullChainRan proof. Its only fallback is an exact,
 * duplicate-free set of passing verdicts for every approved case id; a lone
 * success terminal or a client boolean is never enough. */
export function assessCompleteSuite(
  evidence: CompleteSuiteEvidence | null | undefined,
): CompleteSuiteAssessment {
  if (!evidence) return { complete: false, source: "incomplete", detail: "缺少沙箱套件证据" };
  const degraded = evidence.degradedAgents?.filter(Boolean) ?? [];
  if (degraded.length) {
    return { complete: false, source: "incomplete", detail: `发生降级：${degraded.join("、")}` };
  }
  if (evidence.fullChainRan === true) {
    return { complete: true, source: "full_chain", detail: "运行时确认整链与全套件完成" };
  }

  const expected = evidence.expectedCaseIds?.map((id) => id.trim()).filter(Boolean) ?? [];
  const verdicts = evidence.caseVerdicts;
  if (!expected.length || !verdicts || verdicts.allPass !== true) {
    return { complete: false, source: "incomplete", detail: "没有完整的整链或逐用例证明" };
  }
  const expectedSet = new Set(expected);
  const observedIds = verdicts.results.map((entry) => entry.caseId?.trim() ?? "");
  const observedSet = new Set(observedIds);
  const exactCases = expectedSet.size === expected.length
    && observedIds.every(Boolean)
    && observedSet.size === verdicts.results.length
    && observedSet.size === expectedSet.size
    && [...expectedSet].every((id) => observedSet.has(id));
  if (!exactCases || verdicts.results.some((entry) => entry.pass !== true)) {
    return {
      complete: false,
      source: "incomplete",
      detail: `逐用例回执不完整（${observedSet.size}/${expectedSet.size}）或存在失败/重复用例`,
    };
  }
  return {
    complete: true,
    source: "case_verdicts",
    detail: `${expectedSet.size} 个批准用例均有唯一通过回执`,
  };
}

export interface AcceptanceCriterion { key: string; label: string; pass: boolean; detail: string }
/** #CHECKLIST — per-agent view of the SAME evidence the fleet criteria are computed from.
 *  HARNESS-OWNED: derived fresh from specs+sandbox on every call; there is no mutable stored
 *  checklist the brain could edit — an item flips green ONLY because real evidence (registration,
 *  real runs, code_ran receipts, fidelity grading) says so. (Anthropic long-running-harness
 *  pattern: the checklist belongs to the harness, agents may not remove or edit tests.) */
export interface AgentChecklist { slug: string; short: string; items: AcceptanceCriterion[]; pass: boolean }
export interface AcceptanceReport { criteria: AcceptanceCriterion[]; allPass: boolean; perAgent: AgentChecklist[] }

export interface AcceptanceOptions {
  blockingDefects?: number;
  blockingDefectSlugs?: string[];
  /** Current registry definitions. Only capability metadata on tools selected
   * by a spec may prove a rule reader; names and summaries are never evidence. */
  registeredTools?: readonly RealTool[];
}

export interface IntegrationBindingIssue {
  short: string;
  requirement: IntegrationRequirement;
  status: Exclude<IntegrationBindingStatus, "resolved">;
  reason: string;
}

export interface IntegrationBindingAssessment {
  total: number;
  resolved: number;
  issues: IntegrationBindingIssue[];
}

const integrationRole = (value: string): "notify" | "trigger" | "consume" | "other" => {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_.:/()-]+/g, "");
  if (normalized === "notify" || normalized === "notifies") return "notify";
  if (normalized === "trigger" || normalized === "triggers") return "trigger";
  if (normalized === "consume" || normalized === "consumes") return "consume";
  return "other";
};

/** Assess persisted integration evidence against the current ontology. The
 * ontology is the source of truth when present; spec-carried requirements are
 * also included so sub-agents and review-only artifacts can retain explicit
 * requirements. A claimed `resolved` result must identify and prove its exact
 * execution surface: selected tool, runtime provider, or declared event. */
export function assessIntegrationBindings(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology | null,
  includeUncoveredActions = true,
): IntegrationBindingAssessment {
  const ontologyActions = new Map((ontology?.actions ?? []).map((action) => [action.name, action]));
  const coveredActions = new Set<string>();
  const assessment: IntegrationBindingAssessment = { total: 0, resolved: 0, issues: [] };

  for (const spec of specs) {
    if (!spec.isSubAgent) coveredActions.add(spec.actionName);
    const byId = new Map<string, IntegrationRequirement>();
    const action = ontologyActions.get(spec.actionName);
    for (const requirement of action ? deriveIntegrationRequirements(action) : []) {
      byId.set(requirement.id, requirement);
    }
    for (const requirement of spec.integrationRequirements ?? []) {
      if (!byId.has(requirement.id)) byId.set(requirement.id, requirement);
    }
    for (const binding of spec.integrationBindings ?? []) {
      if (!byId.has(binding.requirement.id)) byId.set(binding.requirement.id, binding.requirement);
    }

    const bindings = spec.integrationBindings ?? [];
    const planSteps = flattenPlan(spec.plan);
    const planById = new Map(planSteps.map((step) => [step.stepId, step]));
    for (const requirement of byId.values()) {
      assessment.total += 1;
      const matches = bindings.filter((binding) => binding.requirement.id === requirement.id);
      if (matches.length !== 1) {
        assessment.issues.push({
          short: spec.short,
          requirement,
          status: "missing",
          reason: matches.length === 0 ? "未记录 binding" : `存在 ${matches.length} 条冲突 binding`,
        });
        continue;
      }
      const binding = matches[0]!;
      if (binding.status !== "resolved") {
        assessment.issues.push({
          short: spec.short,
          requirement,
          status: binding.status,
          reason: binding.reason,
        });
        continue;
      }
      const bindingKind = binding.bindingKind ?? (binding.toolName ? "tool" : undefined);
      if (bindingKind === "tool" && (!binding.toolName || !spec.tools.includes(binding.toolName))) {
        assessment.issues.push({
          short: spec.short,
          requirement,
          status: "missing",
          reason: binding.toolName
            ? `resolved 工具 ${binding.toolName} 未被 agent 选中`
            : "resolved binding 未指定工具",
        });
        continue;
      }
      if (bindingKind === "runtime" && !binding.bindingId?.trim()) {
        assessment.issues.push({
          short: spec.short,
          requirement,
          status: "missing",
          reason: "resolved runtime binding 未指定 provider id",
        });
        continue;
      }
      if (bindingKind === "event") {
        const eventNames = requirement.eventNames ?? [];
        const boundEvents = new Set((binding.bindingId ?? "").split(",").map((name) => name.trim()).filter(Boolean));
        const role = integrationRole(requirement.role);
        const declaredEvents = new Set(role === "notify" ? spec.emit : role === "trigger" || role === "consume" ? spec.trigger : []);
        const missing = eventNames.filter((event) => !declaredEvents.has(event) || !boundEvents.has(event));
        if (!binding.bindingId?.trim() || !eventNames.length || role === "other" || missing.length) {
          assessment.issues.push({
            short: spec.short,
            requirement,
            status: "missing",
            reason: !eventNames.length
              ? "resolved event binding 没有 ontology event 证据"
              : `event binding 未覆盖 spec 声明：${missing.join(",") || requirement.role}`,
          });
          continue;
        }
      }
      if (!bindingKind) {
        assessment.issues.push({
          short: spec.short,
          requirement,
          status: "missing",
          reason: "resolved binding 未指定 tool/runtime/event 类型",
        });
        continue;
      }
      const executionRef = binding.executionRef;
      if (bindingKind === "tool") {
        const stepIds = executionRef?.kind === "tool" ? executionRef.planStepIds : [];
        const exact = executionRef?.kind === "tool"
          && executionRef.toolName === binding.toolName
          && stepIds.length > 0
          && new Set(stepIds).size === stepIds.length
          && stepIds.every((stepId) => {
            const step = planById.get(stepId);
            return step?.kind === "tool" && step.tool === binding.toolName;
          });
        if (!exact) {
          assessment.issues.push({
            short: spec.short,
            requirement,
            status: "missing",
            reason: `resolved 工具 ${binding.toolName ?? "(unknown)"} 没有绑定到 plan 中精确的 tool step`,
          });
          continue;
        }
      } else if (bindingKind === "runtime") {
        const stepIds = executionRef?.kind === "runtime" ? executionRef.planStepIds : [];
        const exact = executionRef?.kind === "runtime"
          && executionRef.providerId === binding.bindingId
          && stepIds.length > 0
          && new Set(stepIds).size === stepIds.length
          && stepIds.every((stepId) => planById.get(stepId)?.kind === "logic");
        if (!exact) {
          assessment.issues.push({
            short: spec.short,
            requirement,
            status: "missing",
            reason: `resolved 运行时能力 ${binding.bindingId ?? "(unknown)"} 没有绑定到 plan 中精确的 logic step`,
          });
          continue;
        }
      } else if (bindingKind === "event") {
        const requiredEvents = requirement.eventNames ?? [];
        const exact = executionRef?.kind === "event"
          && executionRef.eventNames.length > 0
          && new Set(executionRef.eventNames).size === executionRef.eventNames.length
          && requiredEvents.every((event) => executionRef.eventNames.includes(event));
        if (!exact) {
          assessment.issues.push({
            short: spec.short,
            requirement,
            status: "missing",
            reason: "resolved event binding 没有绑定到精确的 ontology event 边界",
          });
          continue;
        }
      }
      assessment.resolved += 1;
    }
  }

  // Keep the integration criterion independently truthful when an ontology
  // action has not been generated yet (coverage also reports the absent agent).
  if (includeUncoveredActions) {
    for (const action of ontology?.actions ?? []) {
      if (!action.actor.includes("Agent") || coveredActions.has(action.name)) continue;
      for (const requirement of deriveIntegrationRequirements(action)) {
        assessment.total += 1;
        assessment.issues.push({
          short: action.name,
          requirement,
          status: "missing",
          reason: "对应 agent 尚未生成",
        });
      }
    }
  }

  return assessment;
}

function integrationAssessmentDetail(assessment: IntegrationBindingAssessment): string {
  if (assessment.total === 0) return "无外部集成要求";
  if (assessment.issues.length === 0) return `${assessment.resolved} 项外部集成全部 resolved`;
  const counts: Record<Exclude<IntegrationBindingStatus, "resolved">, number> = {
    missing: 0,
    needs_config: 0,
    needs_probe: 0,
    human_boundary: 0,
  };
  for (const issue of assessment.issues) counts[issue.status] += 1;
  const summary = (["missing", "needs_config", "needs_probe", "human_boundary"] as const)
    .filter((status) => counts[status] > 0)
    .map((status) => `${status} ${counts[status]}`)
    .join(" · ");
  const examples = assessment.issues
    .slice(0, 3)
    .map((issue) => `${issue.short}:${issue.requirement.system}(${issue.status})`)
    .join("、");
  return `${assessment.resolved}/${assessment.total} resolved · ${summary}：${examples}${assessment.issues.length > 3 ? "…" : ""}`;
}

export function acceptanceReport(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology | null,
  sandbox: AcceptanceSandbox | null,
  /** #P3 — 监督者证据(可选,向后兼容:不传则不加此判据,既有调用行为不变)。
   *  #CHECKLIST — blockingDefectSlugs: per-agent open blocking-defect slugs, for the per-agent view. */
  opts?: AcceptanceOptions,
): AcceptanceReport {
  const agentActions = ontology ? ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name) : [];
  const ontologyReadiness = ontology ? analyzeOntologyReadiness(ontology) : null;
  const integrationAssessment = assessIntegrationBindings(specs, ontology);
  const gap = ontology ? coverageGap(ontology.actions, specs.map((s) => s.actionName)) : agentActions;
  const unresolved = specs.filter((s) => (s.unresolvedTools ?? []).length);
  // Sub-agents are invoke-only helpers (invoked with the parent's data) — exempt from typed-payload
  // + ontology coverage, but still must have code + resolve their tools like any deliverable.
  const noPayload = specs.filter((s) => !s.isSubAgent).filter((s) => !(s.inputSchema?.length) && !(s.outputSchema?.length));
  const noCode = specs.filter((s) => !((s.generatedCode ?? "").trim())); // finish() enforces code — the bar must surface it too
  const ontologyActions = new Map((ontology?.actions ?? []).map((action) => [action.name, action]));
  const ruleAssessments = new Map(specs.map((spec) => [
    spec,
    assessRuleGate(spec, {
      ontologyAction: ontologyActions.get(spec.actionName),
      registeredTools: opts?.registeredTools ?? [],
    }),
  ]));
  const gatesUnbound = specs.filter((spec) => {
    const assessment = ruleAssessments.get(spec)!;
    return assessment.isRuleGate && !assessment.readerBound;
  });
  // #RULE-GATE-AUTHOR — recompute, from the Ontology and the spec's own plan, which rule-gate
  // declarations this agent SHOULD carry, and compare with what it actually carries. Independent of
  // the generator on purpose: a spec that was designed before the generator emitted gates (or by a
  // path that skipped it) shows up as undeclared here rather than as "nothing to declare".
  const ruleGateAuthoring = new Map(specs.map((spec) => {
    const action = ontologyActions.get(spec.actionName);
    return [
      spec,
      action
        ? authorRuleGates({ action, rules: (ontology?.rules ?? []) as Array<Record<string, unknown>>, spec })
        : null,
    ] as const;
  }));
  const realSpecs = specs.filter((s) => !/-mock-/.test(s.slug)); // mocks are sandbox stand-ins, not deliverables
  const registrationIssues = sandboxRegistrationEvidenceIssues(
    sandbox
      ? {
          appId: sandbox.appId,
          committedManifestFunctionIds: sandbox.committedManifestFunctionIds,
          brokerRegistration: sandbox.brokerRegistration,
          testOnlyRegistrationBypass: sandbox.testOnlyRegistrationBypass,
        }
      : null,
    realSpecs.map((spec) => spec.slug),
  );
  const registrationProven = !!sandbox
    && sandbox.simulated === false
    && registrationIssues.length === 0;
  // #NEST — every SUB-AGENT must be referenced by some parent's plan `invoke` step (no orphans that
  // deploy but nothing calls). invoke targets the sub's `short` (= its manifest name).
  const subAgents = specs.filter((s) => s.isSubAgent);
  const invokedTargets = new Set(specs.flatMap((s) => flattenPlan(s.plan).filter((p) => p.kind === "invoke" && p.invoke).map((p) => p.invoke as string)));
  const orphanSubs = subAgents.filter((s) => !invokedTargets.has(s.short));
  // A parent invoke whose target isn't a deployed spec = a dangling call that soft-fails at runtime
  // (e.g. the sub was refined/reverted away). Catch it at finish, not silently in production.
  const allShorts = new Set(specs.map((s) => s.short));
  const danglingInvokes = [...invokedTargets].filter((t) => !allShorts.has(t));
  // #REDESIGN P1 — code-delivered agents (codeExecuted) whose generated code did NOT actually run in
  // the sandbox (fell back to declarative). A real sandbox must prove the code ran, or finish is a lie.
  const codeSpecs = specs.filter((s) => s.codeExecuted);
  const codeToolCoverageFailures = codeSpecs
    .filter((spec) => Boolean(spec.generatedCode?.trim()))
    .map((spec) => ({ spec, result: validateGeneratedToolCoverage(spec.generatedCode!, spec.tools) }))
    .filter(({ result }) => !result.ok);
  const ranSet = new Set(sandbox?.codeRanAgents ?? []);
  const codeFellBack = sandbox && !sandbox.simulated ? codeSpecs.filter((s) => !ranSet.has(s.short)) : [];
  // #R3 — execution fidelity: agents whose REAL emitted payload violated the downstream contract.
  // Graded upstream (from the sandbox agentRuns) and threaded here.
  // #AUDIT-FIX(P1-02) — 三态而非二态：undefined 不再一律当 pass（fail-open）。真实跑过且有 agent
  // 运行、却【没采到保真证据】= UNKNOWN，按未知【阻断】finish（不能证明 emit 合法就不算通过）。
  // 模拟/未跑沙箱由 real_register/chain_ran 兜底，这里不重复扣分。
  const fidelityFail = sandbox?.fidelityFailures ?? [];
  const fidelityEvaluated = sandbox?.fidelityFailures !== undefined;
  const fidelityUnknown = !!sandbox && sandbox.simulated === false && (sandbox.ran ?? 0) > 0 && !fidelityEvaluated;
  // #TESTER-WIRE — a real sandbox needs a one-to-one, promotion-qualified
  // tester receipt for the complete submitted fleet. Presence of the array is
  // not evidence: empty, missing, duplicate, non-ran, failed, development-only
  // and unknown-short entries all fail closed. Explicit simulated/dry paths
  // remain diagnostic-only and are rejected by real_register/chain_ran rather
  // than being double-counted here.
  const ft = sandbox?.functionTester;
  const ftEvaluated = ft !== undefined;
  const ftEntries = ft ?? [];
  const ftByShort = new Map<string, typeof ftEntries>();
  for (const entry of ftEntries) {
    const entries = ftByShort.get(entry.short) ?? [];
    entries.push(entry);
    ftByShort.set(entry.short, entries);
  }
  const expectedTesterShorts = specs.map((spec) => spec.short);
  const expectedTesterSet = new Set(expectedTesterShorts);
  const ftMissing = [...new Set(expectedTesterShorts.filter((short) => (ftByShort.get(short)?.length ?? 0) === 0))];
  const ftDuplicates = [...new Set(expectedTesterShorts.filter((short) => (ftByShort.get(short)?.length ?? 0) > 1))];
  const ftUnexpected = [...new Set(ftEntries.filter((entry) => !expectedTesterSet.has(entry.short)).map((entry) => entry.short))];
  const ftNotRan = ftEntries.filter((entry) => entry.ran !== true);
  const ftFails = ftEntries.filter((entry) => entry.pass !== true);
  const ftNonPromotable = ftEntries.filter((entry) => entry.qualification !== "promotable");
  const realFunctionTesterRequired = sandbox?.simulated === false;
  const ftStrictPass =
    !realFunctionTesterRequired ||
    (
      ftEvaluated &&
      ftEntries.length === specs.length &&
      ftMissing.length === 0 &&
      ftDuplicates.length === 0 &&
      ftUnexpected.length === 0 &&
      ftNotRan.length === 0 &&
      ftFails.length === 0 &&
      ftNonPromotable.length === 0
    );
  const ftFailureParts = [
    ...(!ftEvaluated ? ["缺少 functionTester 字段"] : []),
    ...(ftEntries.length !== specs.length ? [`记录数 ${ftEntries.length}/${specs.length}`] : []),
    ...(ftMissing.length ? [`缺记录：${ftMissing.join("、")}`] : []),
    ...(ftDuplicates.length ? [`重复记录：${ftDuplicates.join("、")}`] : []),
    ...(ftUnexpected.length ? [`未知 spec：${ftUnexpected.join("、")}`] : []),
    ...(ftNotRan.length ? [`未实际执行：${[...new Set(ftNotRan.map((entry) => entry.short))].join("、")}`] : []),
    ...(ftFails.length ? [`测试失败：${ftFails.map((entry) => `${entry.short}(${entry.reasons[0] ?? "未知原因"})`).join("、")}`] : []),
    ...(ftNonPromotable.length ? [`非 promotable：${[...new Set(ftNonPromotable.map((entry) => entry.short))].join("、")}`] : []),
  ];
  const toolMode = sandbox?.toolMode;
  const externalLiveCalls = sandbox?.externalLiveCalls;
  const zeroExternalLiveProven = externalLiveCalls === 0;
  const evidenceReplayProven =
    toolMode === "evidence_replay" &&
    zeroExternalLiveProven &&
    sandbox?.sandboxReplayEvidenceComplete === true;
  const executionReceiptIssues = sandbox
    ? sandboxExecutionReceiptIssues(sandbox.executionReceipt, {
        candidateFingerprint: sandbox.candidateFingerprint ?? sandbox.specsFingerprint,
        targetDomainId: sandbox.targetDomainId ?? ontology?.domainId,
        sandboxAttemptId: sandbox.sandboxAttemptId,
      })
    : ["missing sandbox evidence"];
  // Unit tests may continue to exercise the pure acceptance bar with compact
  // fixtures. Outside NODE_ENV=test, absence or mismatch is always fail-closed.
  const remoteExecutionProven = !!sandbox && (
    (process.env.NODE_ENV === "test" && !sandbox.executionReceipt)
    || executionReceiptIssues.length === 0
  );
  const modelRequirement = generatedFleetModelRequirement(specs);
  const modelUsageIssues = sandbox
    ? [
        ...modelRequirement.issues,
        ...sandboxModelUsageEvidenceIssues(sandbox.modelUsage, {
        sandboxAttemptId: sandbox.sandboxAttemptId,
        modelRequired: modelRequirement.requiredAgentRefs.length > 0,
        requiredAgentRefs: modelRequirement.requiredAgentRefs,
      })]
    : ["missing sandbox model-usage evidence"];
  const modelUsageProven = !!sandbox && (
    (process.env.NODE_ENV === "test" && !sandbox.modelUsage)
    || modelUsageIssues.length === 0
  );
  const missingToolPolicies = specs.flatMap((spec) =>
    [...new Set([
      ...(spec.tools ?? []),
      ...flattenPlan(spec.plan)
        .filter((step) => step.kind === "tool" && step.tool)
        .map((step) => step.tool as string),
    ])]
      .filter((name) => !isReviewedToolExecutionPolicy(spec.toolPolicies?.[name]))
      .map((name) => `${spec.short}:${name}`));
  const toolExecutionProven = evidenceReplayProven;
  const toolModeNote =
    !zeroExternalLiveProven
      ? ` · 🛑 externalLiveCalls=${externalLiveCalls == null ? "unknown" : externalLiveCalls}（必须精确为 0）`
      : toolMode === "evidence_replay" && sandbox?.sandboxReplayEvidenceComplete === true
        ? ` · attempt-bound evidence replay（${sandbox.replayReceipts?.length ?? 0} 条精确参数回执，externalLiveCalls=0）`
      : toolMode
        ? ` · 工具模式 ${toolMode}（Factory 沙箱只接受 attempt-bound evidence_replay）`
        : " · 缺少工具执行模式证据";
  const completeSuite = assessCompleteSuite(sandbox);
  const chainReached = completeSuite.complete;

  const criteria: AcceptanceCriterion[] = [
    { key: "ontology_ready", label: "Ontology 引用与 I/O 契约完整", pass: !!ontologyReadiness?.ready, detail: ontologyReadiness ? (ontologyReadiness.ready ? `0 个阻塞缺口 · ${ontologyReadiness.warnings.length} 个待解析警告` : `${ontologyReadiness.blocking.length} 个阻塞缺口：${ontologyReadiness.blocking.slice(0, 4).map((issue) => issue.code).join("、")}${ontologyReadiness.blocking.length > 4 ? "…" : ""}`) : "未读取 Ontology" },
    { key: "coverage", label: "覆盖全部 Agent 动作", pass: !!ontology && gap.length === 0, detail: gap.length ? `还差：${gap.join("、")}` : `${agentActions.length} 个全覆盖` },
    { key: "integration_bindings", label: "外部集成已绑定、配置并验证", pass: integrationAssessment.issues.length === 0, detail: integrationAssessmentDetail(integrationAssessment) },
    { key: "tools_resolve", label: "所有工具都能解析", pass: unresolved.length === 0, detail: unresolved.length ? `未解析：${unresolved.map((s) => s.short).join("、")}` : "无未解析工具" },
    { key: "tool_policy_reviewed", label: "所有工具都有明确执行策略", pass: missingToolPolicies.length === 0, detail: missingToolPolicies.length ? `缺失或不合法：${missingToolPolicies.slice(0, 6).join("、")}${missingToolPolicies.length > 6 ? "…" : ""}` : "operation / effectScope / sandboxPolicy 均已审查" },
    { key: "sandbox_zero_live_external", label: "Factory 沙箱仅使用精确证据回放", pass: evidenceReplayProven, detail: !sandbox ? "未跑沙箱" : externalLiveCalls == null ? "缺少 runtime dispatch 账本，不能把未知当成 0" : externalLiveCalls > 0 ? `检测到 ${externalLiveCalls} 次 external live call，已阻断` : toolMode !== "evidence_replay" ? `toolMode=${toolMode ?? "unknown"}，必须是 evidence_replay` : sandbox.sandboxReplayEvidenceComplete !== true ? "externalLiveCalls=0，但 cassette miss/账本不完整" : `externalLiveCalls=0 · replay receipts ${sandbox.replayReceipts?.length ?? 0}` },
    { key: "promotable_execution_plane", label: "生成函数在外部隔离执行平面真跑", pass: remoteExecutionProven, detail: !sandbox ? "未跑沙箱" : remoteExecutionProven ? (sandbox.executionReceipt ? `${sandbox.executionReceipt.isolationTier} · runner ${sandbox.executionReceipt.runnerId}` : "单元测试兼容：未提供 remote receipt（不可作为生产证据）") : executionReceiptIssues.slice(0, 4).join("；") },
    { key: "real_model_usage", label: "需要推理的函数真实调用模型且预算已记账", pass: modelUsageProven, detail: !sandbox ? "未跑沙箱" : modelUsageProven ? (sandbox.modelUsage ? `模型调用 ${sandbox.modelUsage.calls} 次 · ${sandbox.modelUsage.totalTokens ?? "usage 未测量"} tokens · total envelope ${sandbox.modelUsage.budget.reservedTotalTokens}/${sandbox.modelUsage.budget.maxTotalTokens}` : "单元测试兼容：未提供模型账本（不可作为生产证据）") : modelUsageIssues.slice(0, 4).join("；") },
    {
      key: "real_register",
      label: "Inngest 精确注册（独立回读）",
      pass: registrationProven,
      detail: !sandbox
        ? "未跑沙箱"
        : sandbox.simulated
          ? "上次是模拟验证"
          : registrationProven
            ? (sandbox.testOnlyRegistrationBypass
                ? "单元测试显式兼容（不可作为生产证据）"
                : `broker 精确回读 ${sandbox.brokerRegistration!.observedFunctionCount}/${realSpecs.length} 个函数`)
            : registrationIssues.slice(0, 4).join("；"),
    },
    // Only a complete suite can pass. A single successful terminal is useful
    // diagnosis, but is not evidence that sibling branches/functions ran.
    { key: "chain_ran", label: "链路端到端跑通", pass: chainReached && toolExecutionProven, detail: sandbox ? `跑 ${sandbox.ran ?? 0} · ${completeSuite.detail}${sandbox.reachedSuccessTerminal ? " · 达成功终态" : ""}${toolModeNote}` : "未跑沙箱" },
    { key: "rule_gates", label: "结构化规则闸已绑定规则读取能力", pass: gatesUnbound.length === 0, detail: gatesUnbound.length ? `未绑定 rulebase reader：${gatesUnbound.map((s) => s.short).join("、")}` : "已绑定或无结构化规则闸" },
    { key: "typed_payloads", label: "I/O 都从 event_data 类型化", pass: specs.length > 0 && noPayload.length === 0, detail: noPayload.length ? `无 schema：${noPayload.map((s) => s.short).join("、")}` : "全部已类型化" },
    { key: "has_code", label: "所有 agent 都有代码", pass: specs.length > 0 && noCode.length === 0, detail: noCode.length ? `缺代码：${noCode.map((s) => s.short).join("、")}` : "全部已生成代码" },
    { key: "sub_agents_bound", label: "子 agent 都被父 invoke·无悬空调用", pass: orphanSubs.length === 0 && danglingInvokes.length === 0, detail: danglingInvokes.length ? `悬空 invoke（目标不存在）：${danglingInvokes.join("、")}` : subAgents.length ? (orphanSubs.length ? `孤儿子 agent（没被 invoke）：${orphanSubs.map((s) => s.short).join("、")}` : `${subAgents.length} 个子 agent 均已被父调用`) : "无子 agent" },
    { key: "code_really_ran", label: "生成代码真的执行（非回退声明式）", pass: codeFellBack.length === 0, detail: codeFellBack.length ? `标了执行代码但回退了声明式（没真跑）：${codeFellBack.map((s) => s.short).join("、")}` : codeSpecs.length ? `${codeSpecs.length} 个代码型 agent 的代码均真跑` : "无代码执行型 agent（声明式）" },
    { key: "code_tool_coverage", label: "CodeAct 真实调用全部已审查工具", pass: codeToolCoverageFailures.length === 0, detail: codeToolCoverageFailures.length ? codeToolCoverageFailures.map(({ spec, result }) => `${spec.short}: ${result.missingReviewedTools.join("、") || result.violations[0]}`).join("｜") : codeSpecs.length ? "所有 CodeAct handler 均覆盖其完整工具契约" : "无 CodeAct agent" },
    { key: "execution_fidelity", label: "真实 emit 满足下游契约（不 output_parse_error）", pass: fidelityFail.length === 0 && !fidelityUnknown, detail: fidelityUnknown ? "⚠ 无法评估执行保真（真实跑了但没采到 emit 载荷/证据）——按未知阻断，不算通过；重跑沙箱或检查 agentRuns 采集" : fidelityFail.length ? `emit 载荷违反下游契约：${fidelityFail.join("、")}` : fidelityEvaluated ? "全部 emit 载荷满足契约" : "未评估（模拟或未跑沙箱）" },
    {
      key: "function_tester",
      label: "每个交付 .ts 模块均在可晋升隔离面真跑通过（P2.5 Tester）",
      pass: ftStrictPass,
      detail: !realFunctionTesterRequired
        ? "未评估（明确的模拟/dry/test-only 路径；不能作为交付证据）"
        : ftStrictPass
          ? `${ftEntries.length} 个 spec 均有且仅有一条 ran=true、pass=true、qualification=promotable 的隔离执行回执`
          : `可晋升 tester 证据不完整：${ftFailureParts.join("；") || "未知错误"}`,
    },
  ];
  // #P3 — 独立监督者的版本锁定缺陷:finish 门要求 0 个 open 阻塞缺陷。只有当调用方传入证据时才加此
  // 判据(向后兼容——既有 acceptanceReport(specs,ontology,sandbox) 调用不受影响)。
  if (opts && typeof opts.blockingDefects === "number") {
    const n = opts.blockingDefects;
    criteria.push({ key: "no_blocking_defects", label: "监督者：0 阻塞缺陷（版本锁定，须复验关闭）", pass: n === 0, detail: n === 0 ? "无未清阻塞缺陷" : `${n} 个阻塞缺陷未复验关闭，不能 finish` });
  }

  // #CHECKLIST — per-agent view over the SAME evidence (no new state, nothing the brain can edit).
  // Items are only included where applicable to that agent, so a green card means "every check
  // that applies to me passed", not "N/A padded to green".
  const degradedSet = new Set(sandbox?.degradedAgents ?? []);
  const fidelitySet = new Set(fidelityFail);
  const defectSlugSet = new Set(opts?.blockingDefectSlugs ?? []);
  const realSandbox = !!sandbox && sandbox.simulated === false;
  const perAgent: AgentChecklist[] = specs.map((s) => {
    const items: AcceptanceCriterion[] = [
      { key: "has_code", label: "已生成代码", pass: !!(s.generatedCode ?? "").trim(), detail: (s.generatedCode ?? "").trim() ? "有" : "缺代码" },
      { key: "tools_resolve", label: "工具全部解析", pass: !(s.unresolvedTools ?? []).length, detail: (s.unresolvedTools ?? []).length ? `未解析：${(s.unresolvedTools ?? []).join("、")}` : `${s.tools.length} 个工具` },
    ];
    const minePolicyMissing = [...new Set([
      ...(s.tools ?? []),
      ...flattenPlan(s.plan).filter((step) => step.kind === "tool" && step.tool).map((step) => step.tool as string),
    ])].filter((name) => !isReviewedToolExecutionPolicy(s.toolPolicies?.[name]));
    items.push({
      key: "tool_policy_reviewed",
      label: "工具执行策略完整",
      pass: minePolicyMissing.length === 0,
      detail: minePolicyMissing.length ? `缺失或不合法：${minePolicyMissing.join("、")}` : "已审查",
    });
    const mine = assessIntegrationBindings([s], ontology, false);
    if (mine.total > 0) {
      items.push({
        key: "integration_bindings",
        label: "外部集成已就绪",
        pass: mine.issues.length === 0,
        detail: integrationAssessmentDetail(mine),
      });
    }
    if (!s.isSubAgent) items.push({ key: "typed_payloads", label: "I/O 已类型化", pass: !!(s.inputSchema?.length || s.outputSchema?.length), detail: s.inputSchema?.length || s.outputSchema?.length ? "有 schema" : "无 schema" });
    const ruleAssessment = ruleAssessments.get(s)!;
    if (ruleAssessment.isRuleGate) items.push({ key: "rule_gate_bound", label: "规则闸已绑定规则读取能力", pass: ruleAssessment.readerBound, detail: ruleAssessment.readerBound ? `已绑定：${ruleAssessment.readers.join("、")}` : `未绑定；结构证据：${ruleAssessment.evidence.join("、")}` });
    // #RULE-GATE-AUTHOR — only applicable where the Ontology actually attaches rules to a tool this
    // agent dispatches. "Nothing to declare" is not padded into a green tick: the item is absent.
    const expectedGates = ruleGateAuthoring.get(s) ?? null;
    if (expectedGates?.gates.length) {
      const declared = new Map((s.ruleGates ?? []).map((gate) => [gate.tool, gate]));
      const missing = expectedGates.gates.filter((gate) => {
        const actual = declared.get(gate.tool);
        return !actual || gate.declaration.rules.ids.some((id) => !actual.declaration.rules.ids.includes(id));
      });
      const openGaps = [...(s.ruleGateGaps ?? []), ...expectedGates.gaps];
      items.push({
        key: "rule_gate_declared",
        label: "规则义务已写进 manifest 规则闸",
        pass: missing.length === 0,
        detail: missing.length
          ? `未声明规则闸：${missing.map((gate) => `${gate.tool}(${gate.declaration.rules.ids.length} 条规则)`).join("、")}`
          : `已声明 ${expectedGates.gates.length} 个工具的规则闸（mode=report）${openGaps.length ? ` · ${openGaps.length} 处义务无法接线：${[...new Set(openGaps.map((gap) => gap.kind))].join("、")}` : ""}`,
      });
    }
    if (realSandbox) {
      items.push({ key: "ran_no_degrade", label: "沙箱真跑无降级", pass: !degradedSet.has(s.short), detail: degradedSet.has(s.short) ? "降级" : "正常" });
      const agentHasExternalWrite = [
        ...(s.tools ?? []),
        ...flattenPlan(s.plan).filter((p) => p.kind === "tool" && p.tool).map((p) => p.tool as string),
      ].some((name) => requiresAttemptGrantPolicy(s.toolPolicies?.[name]));
      if (agentHasExternalWrite) {
        items.push({ key: "external_write_replay", label: "外部写使用已验证证据回放", pass: evidenceReplayProven, detail: evidenceReplayProven ? "当前 attempt 为精确 cassette replay，externalLiveCalls=0" : "缺少当前 attempt 的 T2 probe/cassette + T3 replay 证据" });
      }
      if (s.codeExecuted) items.push({ key: "code_really_ran", label: "生成代码真的执行", pass: ranSet.has(s.short), detail: ranSet.has(s.short) ? "code_ran 回执 ✓" : "回退了声明式" });
      if (s.codeExecuted) {
        const coverage = validateGeneratedToolCoverage(s.generatedCode ?? "", s.tools);
        items.push({ key: "code_tool_coverage", label: "代码覆盖已审查工具", pass: coverage.ok, detail: coverage.ok ? "全部直接调用" : `缺少：${coverage.missingReviewedTools.join("、") || coverage.violations[0]}` });
      }
      if (fidelityEvaluated) items.push({ key: "execution_fidelity", label: "emit 满足下游契约", pass: !fidelitySet.has(s.short), detail: fidelitySet.has(s.short) ? "违反契约" : "满足" });
      const mine = ftEntries.filter((entry) => entry.short === s.short);
      const minePass = mine.length === 1
        && mine[0]!.ran === true
        && mine[0]!.pass === true
        && mine[0]!.qualification === "promotable";
      items.push({
        key: "function_tester",
        label: "交付 .ts 可晋升隔离真跑",
        pass: minePass,
        detail: mine.length === 0
          ? "无 tester 记录"
          : mine.length > 1
            ? `${mine.length} 条重复 tester 记录`
            : mine[0]!.ran !== true
              ? "tester 未实际执行（ran=false）"
              : mine[0]!.pass !== true
                ? mine[0]!.reasons[0] ?? "tester 未通过"
                : mine[0]!.qualification !== "promotable"
                  ? `执行面不可晋升（${mine[0]!.qualification ?? "qualification 缺失"}）`
                  : `真跑通过（${mine[0]!.tier}，promotable）`,
      });
    }
    if (opts?.blockingDefectSlugs) items.push({ key: "no_blocking_defects", label: "无未清阻塞缺陷", pass: !defectSlugSet.has(s.slug), detail: defectSlugSet.has(s.slug) ? "监督者缺陷未复验关闭" : "无" });
    return { slug: s.slug, short: s.short, items, pass: items.every((i) => i.pass) };
  });

  return { criteria, allPass: criteria.every((c) => c.pass) && perAgent.every((agent) => agent.pass), perAgent };
}

/** The conductor records sandbox evidence under its OWN field names (deployed / agentsRan /
 *  ranAgents — see tools.ts ctx.lastSandbox). This is the shape the finish gate has on hand. */
export interface SandboxEvidenceLike {
  appId?: string;
  deployed?: number;
  functionsRegistered?: number;
  agentsRan?: number;
  ran?: number;
  ranAgents?: string[];
  registeredIds?: string[];
  committedManifestFunctionIds?: string[];
  brokerRegistration?: SandboxBrokerRegistrationProof;
  testOnlyRegistrationBypass?: boolean;
  fullChainRan?: boolean;
  reachedSuccessTerminal?: boolean;
  caseVerdicts?: CompleteSuiteVerdicts;
  expectedCaseIds?: string[];
  codeRanAgents?: string[];
  degradedAgents?: string[];
  fidelityFailures?: string[];
  functionTester?: Array<{ short: string; pass: boolean; ran: boolean; reasons: string[]; tier: string; qualification?: "development_only" | "promotable"; fixtureMode?: "evidence" | "scripted" | "missing" }>;
  toolMode?: string;
  externalLiveCalls?: number | null;
  replayReceipts?: SandboxToolDispatchReceipt[];
  sandboxReplayEvidenceComplete?: boolean;
  externalWritesRequired?: boolean;
  specsFingerprint?: string;
  candidateFingerprint?: string;
  targetDomainId?: string;
  sandboxAttemptId?: string;
  executionReceipt?: SandboxExecutionPlaneReceipt;
  modelUsage?: SandboxModelUsageEvidence;
  simulated?: boolean;
}

/** Phase 0a — bridge the conductor's lastSandbox shape onto the documented acceptance bar and
 *  return the failing criteria, so `finish` can enforce coverage + tools_resolve + real_register +
 *  chain_ran(no-degrade) + rule_gates + typed_payloads instead of its weaker inline checks. */
export function acceptanceGate(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology | null,
  sandbox: SandboxEvidenceLike | null,
  /** #P3 — 监督者证据(可选,向后兼容)。 */
  opts?: AcceptanceOptions,
): { pass: boolean; failing: AcceptanceCriterion[]; report: AcceptanceReport } {
  const sb: AcceptanceSandbox | null = sandbox
    ? {
        appId: sandbox.appId,
        committedManifestFunctionIds: sandbox.committedManifestFunctionIds,
        brokerRegistration: sandbox.brokerRegistration,
        testOnlyRegistrationBypass: sandbox.testOnlyRegistrationBypass,
        // Legacy field is retained for transcript diagnostics only and is not
        // consulted by the registration gate.
        registeredIds: sandbox.registeredIds,
        functionsRegistered: sandbox.functionsRegistered ?? sandbox.deployed,
        ran: sandbox.ran ?? sandbox.agentsRan,
        fullChainRan: sandbox.fullChainRan,
        reachedSuccessTerminal: sandbox.reachedSuccessTerminal,
        caseVerdicts: sandbox.caseVerdicts,
        expectedCaseIds: sandbox.expectedCaseIds,
        codeRanAgents: sandbox.codeRanAgents,
        degradedAgents: sandbox.degradedAgents ?? [],
        fidelityFailures: sandbox.fidelityFailures,
        functionTester: sandbox.functionTester,
        toolMode: sandbox.toolMode,
        externalLiveCalls: sandbox.externalLiveCalls,
        replayReceipts: sandbox.replayReceipts,
        sandboxReplayEvidenceComplete: sandbox.sandboxReplayEvidenceComplete,
        externalWritesRequired: sandbox.externalWritesRequired,
        specsFingerprint: sandbox.specsFingerprint,
        candidateFingerprint: sandbox.candidateFingerprint,
        targetDomainId: sandbox.targetDomainId,
        sandboxAttemptId: sandbox.sandboxAttemptId,
        executionReceipt: sandbox.executionReceipt,
        modelUsage: sandbox.modelUsage,
        simulated: sandbox.simulated,
      }
    : null;
  const report = acceptanceReport(specs, ontology, sb, opts);
  return { pass: report.allPass, failing: report.criteria.filter((c) => !c.pass), report };
}
