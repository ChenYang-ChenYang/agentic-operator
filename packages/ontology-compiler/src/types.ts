/**
 * Typed model of an allmetaOntology studio domain export (the compiler input)
 * plus the compiler overlay and the compiled output shapes (design G1).
 *
 * IMPORTANT: this library is dependency-free (node builtins only) so the CLI
 * can run it under Node's native type stripping. Do not add bare-specifier
 * imports here; runtime-schema validation happens in the package tests via
 * `@agentic/runtime/manifest`.
 */

// ── studio export (input) ─────────────────────────────────────────────────────

export interface StudioActionStep {
  id?: string;
  order: string;
  name: string;
  description?: string;
  object_type: string;
}

export interface StudioRuleBinding {
  id?: string;
  rule_id: string;
  phase: string;
  enforcement: string;
  failure_policy?: string;
}

export interface StudioExternalCall {
  system?: string;
  endpoint: string;
  method?: string;
  description?: string;
}

export interface StudioDataChange {
  target_object?: string;
  mutation_type?: string;
  impacted_properties?: string[];
}

export interface StudioActionImplementation {
  kind: string;
  operation_id?: string;
  endpoint?: string;
  method?: string;
  model_tier?: string;
  prompt_template_id?: string;
}

export interface StudioAction {
  id: string;
  name: string;
  description?: string;
  category?: string;
  actor: string[];
  trigger: string[];
  target_objects?: string[];
  action_steps?: StudioActionStep[];
  rule_bindings?: StudioRuleBinding[];
  side_effects?: {
    data_changes?: StudioDataChange[];
    external_calls?: StudioExternalCall[];
  };
  triggered_event: string[];
  implementation: StudioActionImplementation;
  [key: string]: unknown;
  /** Prose statement of when this action applies; see `submission_gates`. */
  submission_criteria?: string;
}

export interface StudioEventDataField {
  name: string;
  type?: string;
  description?: string;
  target_object?: string | null;
  required?: boolean;
}

export interface StudioEvent {
  name: string;
  description?: string;
  payload?: {
    event_data?: StudioEventDataField[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StudioObjectProperty {
  name: string;
  type?: string;
  description?: string;
  /** True when the value is derived by the ontology rather than read from an
   * ERP column — the compiled instructions must say so, or an agent will try
   * to query a field that no source system exposes. */
  is_computed?: boolean;
  computed_expression?: string;
  [key: string]: unknown;
}

export interface StudioObject {
  id: string;
  name?: string;
  description?: string;
  properties?: StudioObjectProperty[];
  [key: string]: unknown;
}

export interface StudioRule {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  machine_expression?: {
    language?: string;
    source?: string;
    [key: string]: unknown;
  };
  outcome?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StudioWorkflowRole {
  id?: string;
  type?: string;
  role?: string;
  display_name?: string;
}

export interface StudioWorkflow {
  id: string;
  roles?: StudioWorkflowRole[];
  actions?: Array<{ name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface TransformObjectMap {
  object_id: string;
  erp_entity?: string | null;
  fetch?: { method?: string; path?: string } | null;
  [key: string]: unknown;
}

export interface TransformActionMap {
  action_id: string;
  kind: string;
  operation_id?: string;
  endpoint?: string;
  method?: string;
  data_changes?: StudioDataChange[];
  [key: string]: unknown;
}

export interface TransformMaps {
  object_maps: TransformObjectMap[];
  action_maps: TransformActionMap[];
  [key: string]: unknown;
}

/** Loaded, typed studio domain (raw payload envelopes are preserved for the
 * pass-through output projections). */
export interface StudioDomainModel {
  domainId: string;
  actions: StudioAction[];
  events: StudioEvent[];
  objects: StudioObject[];
  rules: StudioRule[];
  workflows: StudioWorkflow[];
  transformMaps: TransformMaps;
  raw: {
    actions: unknown;
    events: { metadata?: unknown; events: unknown[] };
    objects: { metadata?: unknown; payload: unknown[] };
    rules: { metadata?: unknown; payload: unknown[] };
  };
}

// ── compiler overlay ──────────────────────────────────────────────────────────

export interface OverlayEmission {
  event: string;
  /** `"always"` for an unconditional explicit emit; otherwise an AO safe
   * condition-DSL expression (e.g. `lastResult.match_found == true`). */
  when: string;
  /** Safe data path for `emit_payload_from`; defaults to `results.<actionId>`. */
  payload_from?: string;
}

export interface OverlayRuleGate {
  /** `condition` requires `condition`; anything else compiles a logic judge. */
  strategy: "condition" | "judge";
  condition?: string;
  /** Extra prompt context telling the judge where its facts live in the
   * trigger event payload. */
  judge_context?: string;
}

export interface OverlayManualStep {
  awaiting_role?: string;
  form_schema?: Record<string, unknown>;
  /** Typed task class surfaced to the operator. Defaults to the ontology
   * manual-step name, which is exactly what register.ts already falls back to
   * (`action.task_type ?? action.name`), so the default changes no behaviour —
   * it only makes the contract explicit, which the authoring lint requires
   * before a human-actor agent can be draft-tested or published. */
  task_type?: string;
}

export type OverlayToolArgumentSource =
  | { from: string; required?: boolean }
  | { const: unknown };

/** One overlay-granted extra tool for a compiled agent. Only names with a
 * compiler-known reviewed execution policy are accepted (currently just
 * `ontology.query`) so an overlay can never ship an unreviewed policy. */
export interface OverlayExtraTool {
  /** Tool name — must be `"ontology.query"` for now. */
  name: string;
  /** Domain-specific guidance shown to the model (what the graph holds).
   * Falls back to a generic read-only graph description when omitted. */
  description?: string;
  /** Passed through verbatim as the tool_use entry's `config` (e.g.
   * `{tenant_property, id_property, database}`). */
  config?: Record<string, unknown>;
  /** When true, also grant the tool to every `rule-gate:*` LLM judge step
   * and extend those judges' prompts with the graph-evidence instruction. */
  grant_to_judges?: boolean;
}

export interface CompilerOverlay {
  domain?: string;
  description?: string;
  /** actionId → ordered conditional/unconditional emissions. */
  emissions?: Record<string, OverlayEmission[]>;
  /** ruleId → gate strategy for mandatory precondition bindings. */
  rule_gates?: Record<string, OverlayRuleGate>;
  /**
   * actionId → a condition deciding whether this action should run at all.
   *
   * The ontology states this per action as `submission_criteria`, but as prose
   * ("领导选定「执行调拨」方案且计划员已确认执行时提交")，which nothing enforces.
   * Fan-out branches that share a trigger event therefore all fired: three
   * mutually exclusive plans, all three executed. This is that sentence made
   * checkable. Rule gates cannot express it — they key on a rule id, and the
   * branches all cite the same rule.
   */
  submission_gates?: Record<string, string>;
  /** actionId → ontology manual-step name → form schema / awaiting role. */
  manual_steps?: Record<string, Record<string, OverlayManualStep>>;
  /** actionId → tool_arguments template for the ERP write step. */
  tool_arguments?: Record<string, Record<string, OverlayToolArgumentSource>>;
  /** actionId → extra prompt output-contract fields (name → description). */
  output_contracts?: Record<string, { fields?: Record<string, string> }>;
  /** actionId → extra read-only tools granted to that agent's LLM steps. */
  extra_tools?: Record<string, OverlayExtraTool[]>;
  /**
   * actionId → the ontology event that undoes this action's side effect.
   *
   * An ontology action often declares BOTH its success event and its failure
   * event in `triggered_event` (e.g. `TRANSFER_ORDERS_CREATED` alongside
   * `ORDER_WRITEBACK_FAILED`). Compiling both as emit steps would fire the
   * failure event on every SUCCESSFUL write. Naming the failure event here
   * instead compiles it to the agent's `compensation_event`, which
   * register.ts emits exactly once on a hard failure — the saga semantics the
   * ontology's rule actually describes. The named event is removed from the
   * auto-emit list.
   */
  compensation_events?: Record<string, string>;
  /**
   * actionId → localized display titles, e.g.
   * `{ zh: "库存校验", en: "Verify Inventory Availability" }`.
   *
   * An ontology package names its actions by id (`verifyInventoryAvailability`)
   * and carries the human wording only on workflow steps; this is where the
   * per-locale title an operator reads on the canvas is declared. `title` is
   * taken from `title_locale` (default `zh`); the whole map ships as
   * `title_i18n` so the portal can switch with its language toggle.
   */
  titles?: Record<string, Record<string, string>>;
  /** Locale whose title becomes the AgentSpec `title` (default `zh`). */
  title_locale?: string;
  /**
   * actionId → outcomes an analysis action may honestly report that mean
   * "nothing downstream may proceed" (e.g. `blocking_note` set because a
   * cycle configuration is missing, BR-PLAN-01).
   *
   * Without this the compiled agent emitted its success event regardless,
   * and the ERP write downstream received a null payload, was rejected with
   * HTTP 400 and retried for minutes. Each outcome compiles to a `condition`
   * step over the analysis result plus a `control.fail` tool step with
   * `on_error: "terminal"`: the run ends FAILED with the reported reason,
   * visible on the canvas, and no event fires.
   */
  blocking_outcomes?: Record<string, OverlayBlockingOutcome[]>;
}

export interface OverlayBlockingOutcome {
  /** AO condition-DSL expression over `lastResult` (the analysis JSON) that
   * is TRUE when the run must stop, e.g.
   * `lastResult.blocking_note || !lastResult.draft_request`. */
  when: string;
  /** Stable snake_case failure code recorded on the run (`^[a-z][a-z0-9_]*$`). */
  code: string;
  /** Safe data path to the reason the analysis reported (preferred). */
  message_from?: string;
  /** Static reason when the analysis carries none. Exactly one of
   * `message_from` / `message` must be given. */
  message?: string;
}

/** Declarative retry/terminal ladder rule (runtime `RuntimeErrorPolicyRule`). */
export type CompiledErrorPolicyRule =
  | { when: string; do: "retry" | "terminal" | "park" | "continue" }
  | { default: "retry" | "terminal" | "park" | "continue" };

// ── compiled output ───────────────────────────────────────────────────────────

/** Reviewed execution policy — must byte-match the global registry entry for
 * the named tool (metaerp.invoke and ontology.query respectively). */
export type CompiledExecutionPolicy =
  | {
      operation: "read_write";
      effect_scope: "external";
      sandbox_policy: "requires_attempt_grant";
    }
  | {
      operation: "read";
      effect_scope: "external";
      sandbox_policy: "live_external";
    }
  | {
      /** control.fail — pure, no I/O, no effect. */
      operation: "compute";
      effect_scope: "none";
      sandbox_policy: "pure";
    };

export interface CompiledToolUseEntry {
  name: string;
  description?: string;
  side_effect: "read" | "write";
  execution_policy: CompiledExecutionPolicy;
  /** JSON Schema advertised to the model's tool roster (multi-operation
   * query entries constrain `operation` via enum here). */
  input_schema?: Record<string, unknown>;
  config: {
    /** Pinned operation. Omitted for merged multi-operation query entries —
     * the runtime lifts config by tool NAME (first match wins), so an agent
     * may carry at most ONE metaerp.invoke entry. */
    operation?: string;
    /** metaerp.invoke entries always carry these two; overlay-granted extra
     * tools (ontology.query) instead carry their overlay config verbatim. */
    base_url_env?: string;
    catalog_path?: string;
    [key: string]: unknown;
  };
}

/** One manifest action/step. Kept structural (the real contract is
 * `@agentic/runtime` AgentSchema, asserted in tests). */
export interface CompiledStep {
  order: string;
  name: string;
  description?: string;
  type: "logic" | "condition" | "manual" | "tool" | "emit" | "decision";
  action_prompt?: string;
  condition?: string;
  form_schema?: Record<string, unknown>;
  awaiting_role?: string;
  tool_arguments?: Record<string, OverlayToolArgumentSource>;
  allowed_tools?: string[];
  result_key?: string;
  depends_on?: string[];
  /** Legacy string policy, or a declarative first-match ladder (the ERP write
   * step compiles one: 4xx = terminal, unreachable/5xx = retry). */
  on_error?: "soft" | "terminal" | CompiledErrorPolicyRule[];
  emit_event?: string;
  emit_payload_from?: string;
  decision_table?: Record<string, unknown>;
  /** Typed task class for a manual step, surfaced to the operator. */
  task_type?: string;
}

/** One value the run console should ask for, derived from the trigger event's
 *  declared payload. Shape matches `AgentInputPortV2` in @agentic/contracts. */
export interface AgentInputPort {
  id: string;
  label?: string;
  description?: string;
  kind: "value";
  required: boolean;
  /** JSON Schema fragment — carries `format`/`examples` so the run console
   *  can generate a usable default rather than a placeholder. */
  schema: Record<string, unknown>;
}

export interface CompiledAgent {
  id: string;
  name: string;
  title: string;
  /** Localized titles by language tag; `title` is one of these values. */
  title_i18n?: Record<string, string>;
  description: string;
  actor: string[];
  trigger: string[];
  inputs: AgentInputPort[];
  triggered_event: string[];
  retries: number;
  generated: true;
  /** Emitted once by register.ts when the run fails hard (overlay-declared). */
  compensation_event?: string;
  ontology_instructions?: string;
  tool_use: CompiledToolUseEntry[];
  actions: CompiledStep[];
}

export interface ErpOperation {
  operation_id: string;
  method: string;
  path: string;
  kind: "query" | "write";
  entity: string | null;
}

export interface CompileResult {
  workflow: CompiledAgent[];
  actions: unknown;
  events: { metadata?: unknown; events: unknown[] };
  objects: { metadata?: unknown; payload: unknown[] };
  rules: { metadata?: unknown; payload: unknown[] };
  erpOperations: ErpOperation[];
}
