// Declarative agent spec produced by the factory. Maps 1:1 onto the runtime
// `DerivedAgent` consumed by makeOntologyAgent — but is the factory's own,
// richer artifact (carries tool bindings, steps, validation-relevant fields).
//
// Ported verbatim from the OLD repo's lib/agent-factory-gen/types.ts (pure types,
// zero imports) as part of the M1 migration into @agentic/agent-factory.

import type { IntegrationRequirement, IntegrationToolBinding } from "./integration-binding";
import type { OntologyInputBindingKind } from "./ontology-types";
import type { DecisionTable } from "@agentic/shared";

export interface GeneratedStep {
  name: string;
  description: string;
  /** registry tool this step calls, if any */
  tool?: string;
}

// Phase 1 — a STRUCTURED, ordered execution plan. Unlike the prose `steps[]` (UI only), each
// PlanStep is projected by mapToManifest into its OWN manifest action (one step.run each in
// register.ts), giving a generated agent the per-step durability + branching + soft-fail of a
// hand-written production agent. When a spec carries no `plan`, the deploy falls back to the
// legacy single-logic action (back-compat).
export type PlanStepKind = "tool" | "logic" | "condition" | "invoke" | "foreach" | "emit";

export type ErrorPolicyAction = "park" | "retry" | "terminal" | "continue";
export interface ErrorPolicyOutcome {
  /** Fallback value used only by `continue`. May also be inherited from PlanStep.defaultResult. */
  defaultResult?: unknown;
  /** Select a declared downstream event for this error class. */
  emitEvent?: string;
  emitPayload?: Record<string, unknown>;
  /** Suppress the runtime's historical implicit/default terminal emit. */
  suppressEmit?: boolean;
}
export type ErrorPolicyRule =
  | ({ when: string; do: ErrorPolicyAction } & ErrorPolicyOutcome)
  | ({ default: ErrorPolicyAction } & ErrorPolicyOutcome);

/** JSON-only value used by deterministic plan templates. `undefined`, bigint,
 * functions and class instances are deliberately not representable. */
export type PlanJsonValue =
  | null
  | boolean
  | number
  | string
  | PlanJsonValue[]
  | { [key: string]: PlanJsonValue };

/** One explicitly-authored tool argument. A value is either selected from the
 * current safe execution scope, or is an unmistakable static JSON constant.
 * Bare strings are never interpreted as paths (or constants), so the factory
 * cannot guess from a tool parameter name. */
export type PlanToolArgument =
  | { from: string; required?: boolean }
  | { const: PlanJsonValue };

/** Deterministic projection of a tool's raw return value into named plan data.
 * Paths are rooted at `result` (for example `result.candidate.id`). */
export interface PlanResultMap {
  fields: Record<string, string>;
  /** Preserve the complete tool return under the reserved `_raw` field. */
  includeRaw?: boolean;
}

export interface PlanStep {
  /** stable, human-readable id for this step (used as the manifest action name for logic steps) */
  stepId: string;
  kind: PlanStepKind;
  /** registry tool name — required for kind:"tool" (becomes the action name so it resolves) */
  tool?: string;
  /** Exact arguments passed to a tool. Every value must be an explicit safe
   * path reference or an explicit JSON constant. When absent, legacy plans
   * retain their historical whole-context behaviour and are marked as such by
   * validation/rendering. */
  toolArguments?: Record<string, PlanToolArgument>;
  /** Map the raw tool return into stable named fields. Missing source paths
   * fail closed; no parameter/result name inference is performed. */
  resultMap?: PlanResultMap;
  /** boolean expression evaluated against lastResult/event — for kind:"condition" */
  condition?: string;
  /** #G1/#G2 — the two declared events this condition routes to. A condition
   * step with no dependents used to be computed and then discarded, because the
   * gating map is only read by LATER steps; every routing rule the designer
   * authored (score >= threshold, lockOnly, passed, invitationId != null) was
   * evaluated and thrown away, leaving an LLM's free-text `emit` to pick the
   * terminal event. Declaring the routes makes the verdict decide. */
  routes?: { onTrue: string; onFalse: string };
  /** target agent name / fn id — for kind:"invoke" (synchronous sub-agent) */
  invoke?: string;
  /** Static fields sent to the invoked sub-agent. */
  invokeInput?: Record<string, unknown>;
  /** Forward the merged output of prior steps. Defaults true for generated invoke steps. */
  forwardLastResult?: boolean;
  /** Also expose every named step output as `_results` to the child. */
  forwardResults?: boolean;
  /** prior stepIds that gate this one: skip when a depended-on condition was false / step skipped */
  dependsOn?: string[];
  /** dotted path (event.data / subject) whose value is appended to the Inngest step id, so a
   *  per-item loop yields distinct, replay-stable ids (the OLD `download-and-parse-${key}`). */
  idempotencyKeyFrom?: string;
  /** failure policy: "terminal" fails the run, "soft" logs + continues with defaultResult,
   *  "park" retries (Inngest). Default "terminal". */
  onError?: "terminal" | "soft" | "park";
  /** Ordered first-match error classifier. When present it supersedes the
   * legacy onError label and is projected to manifest `on_error[]`. */
  errorPolicy?: ErrorPolicyRule[];
  /** the value lastResult takes when a soft step fails / invoke soft-fails */
  defaultResult?: unknown;
  /** wall-clock timeout in seconds for this action/container */
  timeoutS?: number;
  /** Collection path for kind:"foreach". Uses the same safe named-result dialect as
   * conditions (`results.fetch.items`, `input.resumes`, `lastResult.rows`). */
  itemsFrom?: string;
  /** Local name bound to the current foreach item. Defaults to `item`. */
  itemAs?: string;
  /** Stable key path relative to the current item (for example `resume_id`). Required for
   * production foreach plans so replay ids do not depend on array position. */
  itemKeyFrom?: string;
  /** Recursive sequential foreach body. Each nested foreach contributes its own
   * stable business key; invoke is allowed and inherits the full durable
   * timeout/error-policy contract. Manual/subflow lifecycle steps stay outside. */
  body?: PlanStep[];
  /** Event name for kind:"emit". It must be declared by the agent's `emit[]` allow-list. */
  emitEvent?: string;
  /** Optional safe path selecting the emitted payload. Defaults to the local lastResult. */
  emitPayloadFrom?: string;
  /** Optional static payload merged over the selected payload. */
  emitPayload?: Record<string, unknown>;
  description?: string;
}

// "ontology" = action carried a system_prompt; "ontology-desc" = seeded from the
// action's rich `description` (live actions have description, not system_prompt).
export type PromptSource = "llm" | "ontology" | "ontology-desc" | "fallback";

// ── Agent-Loop (reflexion) refinement records ─────────────────────────────────
// The factory drafts a prompt, then a critic LLM scores it against the ontology
// grounding and a reviser rewrites it — a small bounded generate→critique→revise
// loop. These types capture that self-improvement so it can be streamed + stored.
export interface PromptIssue {
  severity: "high" | "med" | "low";
  /** which rubric dimension the issue belongs to */
  dim: "coverage" | "tools" | "events" | "json" | "rules" | "role";
  what: string;
  fix: string;
}
export interface PromptCritique {
  score: number; // 0..1
  issues: PromptIssue[];
}
export interface RefinementRound {
  iteration: number; // 1-based
  score: number; // critic score of the draft entering this round
  issues: PromptIssue[];
  revised: boolean; // whether a non-empty rewrite was applied
}
export interface PromptRefinement {
  iterations: number; // critique→revise rounds actually run (0 = skipped)
  finalScore: number; // best score observed (0..1); 0 when no critic ran
  issuesFixed: number; // sum of actionable issues across rounds that triggered a rewrite
  converged: boolean; // stopped because score≥threshold or no new issues
  skipped: boolean; // loop didn't run (gateway down / empty critique / non-llm draft)
  history: RefinementRound[];
}

/** A declarative human-in-the-loop gate descriptor, attached to specs derived
 *  from Human-actor actions (mirrors the energy domain's GateRequest, but
 *  serializable). The executor pauses on `decisionEvent` instead of auto-deciding. */
export interface HitlGate {
  gateKey: string;
  eventNs: string;
  decisionEvent: string; // `<ns>/HUMAN_DECISION`
  emitOnDecision: Record<string, string>; // decision verb -> emit event (optional map)
  defaultEmit?: string;
  title: string;
  body: string;
}

/** A compiled, executable Action-input binding.  The factory deliberately
 * keeps this separate from `inputSchema`: the schema says what a business
 * value is, while this record says where the runtime is allowed to obtain it.
 * Secret/config bindings carry references only; their values never enter an
 * artifact, event payload, prompt, or generated source file. */
export type GeneratedInputBinding =
  | {
      field: string;
      type: string;
      required: boolean;
      kind: "event";
      eventPath: string;
      /** Optional subset of Action.trigger for which this binding is active.
       * This is the executable form of Allmeta inputs[].source_event. */
      sourceEvents?: string[];
      sourceObject?: string;
    }
  | {
      field: string;
      type: string;
      required: boolean;
      kind: "object_lookup";
      sourceObject: string;
      tool: string;
      arguments: Record<string, string>;
      resultPath: string;
      /** Other input fields that must be acquired before this lookup. */
      dependsOn?: string[];
    }
  | {
      field: string;
      type: string;
      required: boolean;
      kind: "secret" | "config";
      /** Opaque, non-secret reference. The runtime never dereferences it into
       * business input; the registered tool receives configuration through its
       * reviewed tool_use config. */
      reference: string;
    }
  | {
      field: string;
      type: string;
      required: boolean;
      kind: "human_input";
      prompt: string;
    }
  | {
      field: string;
      type: string;
      required: boolean;
      kind: "step_output";
      sourceStep: string;
      sourceOutput: string;
    };

/** Compile-time exhaustiveness helper used by consumers that accept ontology
 * binding-kind strings before they become a `GeneratedInputBinding`. */
export type GeneratedInputBindingKind = GeneratedInputBinding["kind"] & OntologyInputBindingKind;

/** How the executor sequences this agent's tools.
 *  - "parallel": run all tool-bound steps up-front, then decide once (default).
 *  - "sequential-react": reason→pick one tool→observe→repeat→emit (ReAct), for
 *    agents whose tool ordering is data-dependent. */
export type ToolFlow = "parallel" | "sequential-react";

/** Reviewed runtime side-effect class for an exact tool name.  The sandbox
 * never derives this from naming conventions; missing entries fail closed. */
export type GeneratedToolSideEffect = "read" | "write" | "dual" | "call";

/** Exact reviewed execution semantics copied from the current tool registry.
 * These fields, not `toolSideEffects`, drive sandbox authorization. */
export interface GeneratedToolExecutionPolicy {
  operation: "read" | "compute" | "write" | "read_write";
  effectScope: "none" | "sandbox_local" | "external";
  sandboxPolicy:
    | "pure"
    | "sandbox_local"
    | "live_external"
    | "requires_attempt_grant";
}

export interface GeneratedAgentSpec {
  /** stable selection id = ontology action name (PK) */
  key: string;
  actionName: string;
  /** `${domainPrefix}-${kebab(actionName)}` — Inngest fn id + AgentVersion.slug */
  slug: string;
  /** `${Pascal(actionName)}Agent` */
  short: string;
  domainId: string;
  nameZh: string;
  kind: "llm" | "simulated-human";
  /** consumed events */
  trigger: string[];
  /** emitted events */
  emit: string[];
  /** registry tool names — the generation-time scoped toolbox */
  tools: string[];
  /** Exact side-effect metadata captured from the selected registry/profile.
   * Every generated tool must have an entry before deployment. */
  toolSideEffects?: Record<string, GeneratedToolSideEffect>;
  /** Reviewed policy snapshot for every selected tool. Missing/unknown policy
   * blocks generation and sandbox dispatch; names and HTTP verbs are never
   * interpreted as authority. */
  toolPolicies?: Record<string, GeneratedToolExecutionPolicy>;
  /** Non-secret per-tool runtime configuration. Secret values are never stored;
   * credentials are referenced by environment-variable name (`*_env`). */
  toolConfigs?: Record<string, Record<string, unknown>>;
  /** Separate sandbox-only endpoint/credential/test-namespace config. Never
   * copied into a production manifest. */
  sandboxToolConfigs?: Record<string, Record<string, unknown>>;
  /** Human-confirmed profile provenance for toolConfigs. Runtime receives the
   * immutable expanded config; review retains which profile supplied it. */
  toolProfileRefs?: Record<string, string>;
  /** Human-confirmed sandbox profile provenance. */
  sandboxToolProfileRefs?: Record<string, string>;
  /** tool_use[] entries that didn't resolve to a registry tool (human review) */
  unresolvedTools: string[];
  /** Machine-readable external-system requirements derived from
   * `action.integration.systems[]`. Keeping them on the generated artifact makes
   * integration evidence reviewable and prevents a descriptive ontology block
   * from disappearing after design time. */
  integrationRequirements?: IntegrationRequirement[];
  /** Exact capability/config/probe resolution for every integration requirement.
   * Acceptance only treats `resolved` bindings to a selected tool as complete;
   * missing configuration or probe evidence remains a delivery blocker. */
  integrationBindings?: IntegrationToolBinding[];
  /** target_objects */
  objects: string[];
  /** R5 — per-DataObject read/write intent, grounded in the ontology: `reads` are the trigger
   *  events' event_data fields sourced from that object; `writes` are the emit events'
   *  state_mutations' impacted_properties on it. Lets validation check object coverage and a
   *  future runtime hydrate the entity by primary_key before deciding. */
  stateBindings?: Array<{ object: string; reads: string[]; writes: string[] }>;
  systemPrompt: string;
  userPrompt: string;
  /** the brain's design reasoning + tool rationale + per-branch decision logic it
   *  authored in design_agent. Stored on the spec so later re-emits (codegen /
   *  refine / revert) can show the REAL content instead of a placeholder. */
  designReasoning?: string;
  toolRationale?: string;
  decisionLogic?: string;
  /** Machine-checkable business routing. Runtime evaluates these tables as
   * data (first-match rows + explicit missing/default outcomes); prose remains
   * explanatory only. */
  decisionTables?: DecisionTable[];
  steps: GeneratedStep[];
  /** Phase 1 — structured ordered plan; projected into one manifest action per step. */
  plan?: PlanStep[];
  ruleRefs: string[];
  retries: number;
  hitl: boolean;
  confidence: number;
  promptSource: PromptSource;
  /** present only when the reflexion loop ran (useLlm + reachable gateway) */
  refinement?: PromptRefinement;
  /** present only for HITL (Human-actor) actions — the gate the executor waits on */
  hitlGate?: HitlGate;
  /** tool sequencing strategy for the executor (default "parallel") */
  toolFlow?: ToolFlow;
  /** P4 — true when this spec is a last-resort DEGRADED shell auto-synthesized to
   *  satisfy the coverage invariant after the brain exhausted its retries on the
   *  action. It is a placeholder (template prompt + floored tools), surfaced as a
   *  blocking warning — never a clean pass. The operator must complete it. */
  degraded?: boolean;
  /** A readable Inngest agent .ts rendering of this spec (specToAgentCode) —
   *  native imports + embedded prompt + step/emit scaffold — so the user can
   *  see + own + edit each generated agent as code, not just a spec. */
  generatedCode?: string;
  /** AI-authored input schema — the trigger event payload fields this agent
   *  consumes, grounded in the ontology DataObjects' properties. */
  inputSchema?: IoField[];
  /** Executable provenance for every ontology Action input. Generation fails
   * closed when a required input cannot be compiled to one of these records. */
  inputBindings?: GeneratedInputBinding[];
  /** AI-authored output schema — the outcome event payload fields it emits. */
  outputSchema?: IoField[];
  /** how `generatedCode` was produced: "ai" = the LLM wrote the .ts (codegen_agent);
   *  "render" = deterministic specToAgentCode rendering of the spec. */
  codeSource?: "ai" | "render";
  /** R7 — CodeAct stance. FALSE (default) = the runtime executes this agent DECLARATIVELY via
   *  the manifest action[] (systemPrompt + tools); `generatedCode` is a readable reference
   *  scaffold, NOT executed; runtime behavior remains fully spec-driven.
   *  TRUE = opt-in "true CodeAct": the runtime transpiles + runs the AI-authored handler
   *  instead of action[] dispatch (the executed path is deferred — flag reserved for it). */
  codeExecuted?: boolean;
  /** #REDESIGN FU3 — when the reviewLoop PROBE stage rejected the code (compiles+lints but doesn't
   *  load a callable handler), why. Surfaced in the design card so the failure is legible instead of
   *  silently downgrading to declarative. Undefined when the probe passed. */
  probeReason?: string;
  /** #SAGA（§6.6）— 补偿事件：agent 运行【硬失败】时 runtime 会 emit 它（Saga 补偿模式，
   *  manifest 的 compensation_event → register.ts 幂等发出），用于撤销已发生的外部副作用
   *  （邀约已发/JD 已发布）。有外部副作用工具却缺它 → designSelfCheck 软警告提醒补。 */
  compensationEvent?: string;
  /** #NEST — this spec is a SUB-AGENT (a deployable helper invoked synchronously by a parent via a
   *  plan `kind:"invoke"` step), NOT an ontology Agent-action. Excluded from coverage + event-graph
   *  closure (it has no ontology trigger); still a real registered function the parent invokes. */
  isSubAgent?: boolean;
  /** the parent spec's actionName that invokes this sub-agent (set on the sub-agent). */
  parentAction?: string;
  /** the subtask this sub-agent handles — its reason for existing (design_subagent / promotion). */
  parentTask?: string;
}

/** One AI-authored I/O field, grounded in a DataObject property where possible. */
export interface IoField {
  field: string;
  type: string;
  description?: string;
  /** false means the field is validated only when present. */
  required?: boolean;
  /** the DataObject.property this field maps to (e.g. "Candidate.candidate_id"). */
  source?: string;
}

export interface ValidationReport {
  ok: boolean;
  /** emitted by some agent but consumed by none and not a declared terminal */
  danglingEmits: string[];
  /** consumed by some agent but produced by none and not a declared entry */
  orphanTriggers: string[];
  /** tools referenced that aren't in the registry (hallucinated) */
  hallucinatedTools: string[];
  /** unresolved tool_use[] entries across all agents */
  unresolvedTools: string[];
  /** Legacy diagnostic only: agents with zero bound tools. Tool-free compute,
   * routing, validation, and event/runtime-backed specs may be fully valid. */
  emptyToolAgents: string[];
  /** agents with empty system prompts */
  emptyPrompts: string[];
  /** duplicate slugs */
  slugCollisions: string[];
  notes: string[];
}

export interface GenerateResult {
  domainId: string;
  source: "allmeta" | "snapshot";
  specs: GeneratedAgentSpec[];
  validation: ValidationReport;
  log: string[];
  /** how many actions used a live LLM prompt vs deterministic template */
  llmUsedCount: number;
}

/** Streamed generation events — the factory's internal reasoning surfaced live.
 *  Emitted in order as the pipeline runs; consumed by the SSE route + UI. */
export type GenEvent =
  | { t: "ontology"; domain: string; source: string; actions: number; events: number; agentActions: number }
  | { t: "log"; line: string }
  | { t: "agent-start"; actionName: string; index: number; total: number }
  | { t: "tools"; actionName: string; tools: string[]; unresolved: string[] }
  | { t: "prompt-mode"; actionName: string; useLlm: boolean }
  /** the exact meta-prompt the factory sends to the LLM to author this agent's prompt */
  | { t: "llm-request"; actionName: string; prompt: string }
  /** the exact LLM response (or degradation note) */
  | { t: "llm-response"; actionName: string; text: string; source: PromptSource }
  /** a bounded reflexion round: the critic's score + issues for this agent's prompt */
  | { t: "prompt-critique"; actionName: string; iteration: number; score: number; issues: PromptIssue[] }
  /** the reviser's outcome for this round */
  | { t: "prompt-revise"; actionName: string; iteration: number; changed: boolean; source: PromptSource }
  /** a Human-actor action became a HITL gate instead of being dropped */
  | { t: "hitl"; actionName: string; gateKey: string }
  | { t: "agent-done"; spec: GeneratedAgentSpec }
  | { t: "validation"; report: ValidationReport }
  /** per-spec LLM prompt-quality judge result (streamed as each completes) */
  | { t: "judge"; slug: string; available: boolean; promptScore: number | null; perCriterion?: Array<{ key: string; score: number; justification: string }> }
  | {
      t: "score";
      scored: boolean;
      /** headline = blend(real-source structural, prompt-judge) when available */
      headline: number;
      /** old snapshot-vs-snapshot agreement, demoted to a secondary signal */
      structuralMatch: number;
      /** golden parsed from the REAL running agents (server/inngest/agents/*) */
      realSource: { overall: number; matchedCount: number; perAgent: Array<{ logical: string; matched: boolean; realScore: number }> };
      /** LLM prompt-quality judge aggregate */
      promptJudge: { available: number; overall: number | null; perAgent: Array<{ slug: string; promptScore: number | null }> };
    }
  | { t: "persist"; persisted: string[]; skipped: string[]; errors: Array<{ slug: string; error: string }>; versionLabel: string }
  | { t: "done"; scored: boolean }
  | { t: "error"; message: string };

export type GenEventSink = (e: GenEvent) => void;
