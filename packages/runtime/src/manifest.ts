/**
 * Ontology + manifest loader.
 *
 * Per RF-1.4: each tenant's ontology lives in `models/<tenant-slug>-v<n>/`
 * and ships 5 files. Two are runtime-load-bearing (workflow + actions); the
 * other three are pass-through metadata served via the api.
 */

import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateErrorPredicateSyntax } from "./error-policy";
import { validateConditionSyntax } from "./action-plan";
import { RuleGateDeclarationSchema } from "./rule-guard";
import type { DecisionTable } from "@agentic/shared";
import {
  ProviderIdSchema,
  ReasoningConfigSchema,
  TaskClassIdSchema,
  TextVerbositySchema,
  WorkflowManifestCompatSchema,
  assertExecutableWorkflowManifestSource,
} from "@agentic/contracts";

export const ActorEnum = z.enum(["Agent", "Human"]);

// Persisted Agent-Factory event contracts. These used to survive only because
// AgentSchema is passthrough, which meant malformed contract metadata could be
// committed and then interpreted differently by promotion/runtime consumers.
// Declaring the shape makes the manifest itself the durable contract record.
const FactoryContractFieldSchema = z
  .object({
    field: z.string().min(1),
    type: z.string().min(1),
    description: z.string().optional(),
    source: z.string().optional(),
    required: z.boolean().optional(),
  })
  .strict();
/**
 * P1-RT-03: `condition` / `delay` / `subflow` are first-class step types.
 *   - `condition` evaluates a JS-ish expression against ctx and returns
 *     { evaluated: boolean, condition: string }; downstream branching is
 *     wired by register.ts.
 *   - `delay` sleeps for `delay_ms` using Inngest's durable timer.
 *   - `subflow` durably persists and emits an event for a child agent;
 *     register.ts owns the event-store and broker hand-off.
 */
export const StepTypeEnum = z.enum([
  "tool",
  "logic",
  "manual",
  "condition",
  "delay",
  "subflow",
  // Phase 1a: a synchronous sub-agent call (step.invoke). Failure is terminal by default;
  // soft continuation requires explicit on_error:"soft" + default_result.
  "invoke",
  // Phase 1b: deterministic collection fan-out and explicit downstream event intent.
  "foreach",
  "emit",
  // Machine-checkable first-match business routing. Unlike a logic prompt,
  // this is evaluated deterministically from structured data.
  "decision",
]);

const safeDataPath = z.string().min(1).regex(
  /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/,
  "must be a safe dotted/bracket data path",
);

const SAFE_PLAN_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const UNSAFE_PLAN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isSafeJsonConstant(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isSafeJsonConstant(entry, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([key, entry]) => !UNSAFE_PLAN_KEYS.has(key) && isSafeJsonConstant(entry, seen));
}

const toolArgumentPath = safeDataPath.refine(
  (value) => /^(event(?:\.|$)|input(?:\.|$)|lastResult(?:\.|$)|results(?:\.|$)|locals(?:\.|$))/.test(value),
  "must be rooted at event/input/lastResult/results/locals",
);

const ToolArgumentSourceSchema = z.union([
  z.object({ from: toolArgumentPath, required: z.boolean().optional() }).strict(),
  z.object({ const: z.unknown() }).strict().superRefine((value, ctx) => {
    if (!Object.prototype.hasOwnProperty.call(value, "const") || !isSafeJsonConstant(value.const)) {
      ctx.addIssue({ code: "custom", path: ["const"], message: "must be an explicit finite JSON constant" });
    }
  }),
]);

export const ToolArgumentsSchema = z.record(z.string(), ToolArgumentSourceSchema)
  .refine((value) => Object.keys(value).length > 0, "tool_arguments cannot be empty")
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!SAFE_PLAN_NAME_RE.test(key) || UNSAFE_PLAN_KEYS.has(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "must be a safe argument name" });
      }
    }
  });

const resultSourcePath = safeDataPath.refine(
  (value) => /^result(?:\.|$)/.test(value),
  "must be rooted at result",
);
export const ToolResultMapSchema = z.object({
  fields: z.record(z.string(), resultSourcePath)
    .refine((value) => Object.keys(value).length > 0, "result_map.fields cannot be empty")
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (!SAFE_PLAN_NAME_RE.test(key) || UNSAFE_PLAN_KEYS.has(key) || key === "_raw") {
          ctx.addIssue({ code: "custom", path: [key], message: "must be a safe named result field (and not _raw)" });
        }
      }
    }),
  include_raw: z.boolean().optional(),
}).strict();

const FactoryInputBindingCommon = {
  field: z.string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/, "must be an addressable field name")
    .refine((value) => !new Set(["__proto__", "prototype", "constructor"]).has(value), "must not be a prototype-control field"),
  type: z.string().min(1),
  required: z.boolean(),
} as const;
const FactoryConfigReferenceSchema = z.string().regex(
  /^tool:[^:]+:[A-Za-z_][A-Za-z0-9_-]*$/,
  "must be a canonical tool:<toolName>:<configKey> reference",
);

/** Executable input provenance emitted by Agent Factory. Secret/config rows
 * deliberately contain only an opaque reference; values are resolved by the
 * reviewed registered tool configuration and never copied into event data. */
export const FactoryInputBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    ...FactoryInputBindingCommon,
    kind: z.literal("event"),
    event_path: safeDataPath,
    source_events: z.array(z.string().min(1)).min(1).optional(),
    source_object: z.string().min(1).optional(),
  }).strict(),
  z.object({
    ...FactoryInputBindingCommon,
    kind: z.literal("object_lookup"),
    source_object: z.string().min(3),
    tool: z.string().min(1),
    arguments: z.record(z.string().min(1), safeDataPath).refine((value) => Object.keys(value).length > 0, "object_lookup arguments cannot be empty"),
    result_path: safeDataPath,
    depends_on: z.array(z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/)).optional(),
  }).strict(),
  z.object({
    ...FactoryInputBindingCommon,
    kind: z.literal("secret"),
    reference: FactoryConfigReferenceSchema,
  }).strict(),
  z.object({
    ...FactoryInputBindingCommon,
    kind: z.literal("config"),
    reference: FactoryConfigReferenceSchema,
  }).strict(),
  z.object({
    ...FactoryInputBindingCommon,
    kind: z.literal("human_input"),
    prompt: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    ...FactoryInputBindingCommon,
    kind: z.literal("step_output"),
    source_step: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/),
    source_output: safeDataPath,
  }).strict(),
]);
export type FactoryInputBinding = z.infer<typeof FactoryInputBindingSchema>;

function parseFactoryConfigReference(reference: string): { toolName: string; configKey: string } | null {
  const match = reference.match(/^tool:([^:]+):([A-Za-z_][A-Za-z0-9_-]*)$/);
  return match ? { toolName: match[1]!, configKey: match[2]! } : null;
}

const DecisionPredicateSchema = z.object({
  path: safeDataPath,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "contains", "exists", "missing"]),
  value: z.unknown().optional(),
  upper: z.number().optional(),
  values: z.array(z.unknown()).optional(),
}).strict();

const DecisionFallbackSchema = z.object({
  outcome: z.string().min(1),
  emitEvent: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();

const DecisionTableSchema: z.ZodType<DecisionTable> = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  rows: z.array(z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    all: z.array(DecisionPredicateSchema).optional(),
    any: z.array(DecisionPredicateSchema).optional(),
    outcome: z.string().min(1),
    emitEvent: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }).strict()).min(1),
  missing: DecisionFallbackSchema,
  default: DecisionFallbackSchema,
}).strict();

export const ErrorPolicyActionEnum = z.enum(["park", "retry", "terminal", "continue"]);
const ErrorPolicyOutcomeFields = {
  default_result: z.unknown().optional(),
  emit_event: z.string().min(1).optional(),
  emit_payload: z.record(z.string(), z.unknown()).optional(),
  suppress_emit: z.boolean().optional(),
} as const;

const ErrorPolicyWhenRuleSchema = z.object({
  when: z.string().min(1).max(1024),
  do: ErrorPolicyActionEnum,
  ...ErrorPolicyOutcomeFields,
}).strict().superRefine((rule, ctx) => {
  const error = validateErrorPredicateSyntax(rule.when);
  if (error) ctx.addIssue({ code: "custom", path: ["when"], message: error });
});

const ErrorPolicyDefaultRuleSchema = z.object({
  default: ErrorPolicyActionEnum,
  ...ErrorPolicyOutcomeFields,
}).strict();

/** Ordered, first-match-wins action error classifier. */
export const ErrorPolicyLadderSchema = z.array(
  z.union([ErrorPolicyWhenRuleSchema, ErrorPolicyDefaultRuleSchema]),
).min(1).max(20).superRefine((rules, ctx) => {
  const defaults = rules.flatMap((rule, index) => ("default" in rule ? [index] : []));
  if (defaults.length !== 1) {
    ctx.addIssue({ code: "custom", message: "error policy requires exactly one default rule" });
  } else if (defaults[0] !== rules.length - 1) {
    ctx.addIssue({ code: "custom", path: [defaults[0]!], message: "error policy default rule must be last" });
  }
});

const ActionFields = {
  /** Optional stable action id (Agent Studio v2 authored). Branching targets
   * (`true_action_id`/`false_action_id`) resolve against it, else the name. */
  id: z.string().optional(),
  order: z.string(),
  name: z.string(),
  description: z.string().optional().default(""),
  type: StepTypeEnum,
  /** Authored per-action LLM objective (v2). Overrides `description` as the
   * logic prompt objective when present. */
  action_prompt: z.string().optional(),
  /**
   * Optional per-step model controls (v2 contract). An omitted value inherits
   * the agent runtime setting; an authored value overrides it for this action
   * only. Shared losslessly with Agent Studio via @agentic/contracts.
   */
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(240).optional(),
  task_class: TaskClassIdSchema.optional(),
  reasoning: ReasoningConfigSchema.optional(),
  verbosity: TextVerbositySchema.optional(),
  store: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(1_048_576).optional(),
  /** Explicit tool identifier for `type:"tool"` actions (v2). Legacy manifests
   * keep `name === toolName`; when present this wins for dispatch. */
  tool: z.string().optional(),
  /** v2 condition branch targets (action `id`/name of a LATER action). */
  true_action_id: z.string().optional(),
  false_action_id: z.string().optional(),
  /** v2 manual-step operator contract. */
  form_schema: z.record(z.string(), z.unknown()).optional(),
  awaiting_role: z.string().optional(),
  /** v2 subflow scheduling + declarative per-action I/O mappings. */
  wait_policy: z.enum(["wait", "detach"]).optional(),
  input_mapping: z.record(z.string(), z.unknown()).optional(),
  output_mapping: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optional action-local capability boundary. Omission is reserved for
   * backwards compatibility with hand-written manifests; Agent Factory
   * manifests always emit it. At runtime an explicit value is intersected
   * with the agent-level `tool_use` roster.
   */
  allowed_tools: z.array(z.string().trim().min(1)).optional(),
  condition: z.string().min(1).optional(),
  task_type: z.string().optional(),
  // Action-local retries never had an execution path: Inngest retries the
  // registered function, not an individual action. Direct ActionSchema users
  // therefore reject the obsolete key. AgentSchema has a compatibility
  // preprocessor that promotes uniform legacy action values to agent.retries.
  retries: z.never({ error: "action-level retries is obsolete; declare agent.retries" }).optional(),
  timeout_s: z.number().int().positive().optional(),
  // P1-RT-03 fields for the new step types.
  delay_ms: z.number().int().nonnegative().optional(),
  subflow: z.string().min(1).optional(),
  subflow_input: z.record(z.string(), z.unknown()).optional(),
  // Phase 1a — production-grade orchestration fields:
  //  - depends_on: names of prior steps that GATE this one. If a depended-on condition step
  //    evaluated false (or a dependency was itself skipped), this action is SKIPPED (real branch).
  //  - idempotency_key_from: a dotted path (event.data / subject) whose value is appended to this
  //    step's Inngest id, so a per-item loop produces distinct, replay-stable step ids.
  //  - invoke / invoke_input / on_error / default_result: the synchronous step.invoke contract.
  depends_on: z.array(z.string()).optional(),
  /** Stable plan step id used to expose this action's raw output under
   * `ctx.results[result_key]`. Tool actions keep `name=toolName` for dispatch, so
   * this separate key is required for deterministic cross-step references. */
  result_key: z.string().min(1).optional(),
  /** Deterministic generated-plan dataflow. Omission retains the legacy tool
   * context contract; authored values never infer arguments from names. */
  tool_arguments: ToolArgumentsSchema.optional(),
  result_map: ToolResultMapSchema.optional(),
  idempotency_key_from: z.string().optional(),
  invoke: z.string().min(1).optional(),
  invoke_input: z.record(z.string(), z.unknown()).optional(),
  /** Forward computed parent data to a synchronous sub-agent. */
  forward_last_result: z.boolean().optional(),
  forward_results: z.boolean().optional(),
  // Legacy soft|terminal remains accepted. New manifests may provide a safe,
  // first-match predicate ladder with retry/terminal/continue outcomes.
  on_error: z.union([z.enum(["soft", "terminal"]), ErrorPolicyLadderSchema]).optional(),
  default_result: z.unknown().optional(),
  // Explicit emit intent. `emit_event` is checked against agent.triggered_event by the runtime;
  // payload paths use the same safe named-results dialect as conditions/foreach.
  emit_event: z.string().min(1).optional(),
  emit_payload_from: safeDataPath.optional(),
  emit_payload: z.record(z.string(), z.unknown()).optional(),
  decision_table: DecisionTableSchema.optional(),
  /** Present only on factory-projected acquisition actions. */
  input_binding: FactoryInputBindingSchema.optional(),
} as const;

function validateActionInputBinding(
  action: { type: string; name: string; input_binding?: z.infer<typeof FactoryInputBindingSchema> },
  ctx: z.RefinementCtx,
): void {
  const binding = action.input_binding;
  if (!binding) return;
  if (binding.kind === "object_lookup") {
    if (action.type !== "tool") {
      ctx.addIssue({ code: "custom", path: ["input_binding"], message: "object_lookup input binding requires a tool action" });
    }
    if (action.name !== binding.tool) {
      ctx.addIssue({ code: "custom", path: ["name"], message: `object_lookup action must dispatch exact tool ${binding.tool}` });
    }
  } else if (binding.kind === "human_input") {
    if (action.type !== "manual") {
      ctx.addIssue({ code: "custom", path: ["input_binding"], message: "human_input binding requires a durable manual action" });
    }
  } else {
    ctx.addIssue({ code: "custom", path: ["input_binding"], message: `${binding.kind} bindings do not create manifest actions` });
  }
}

function validateActionDataflow(
  action: { type: string; tool_arguments?: unknown; result_map?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (action.type === "tool") return;
  if (action.tool_arguments !== undefined) {
    ctx.addIssue({ code: "custom", path: ["tool_arguments"], message: "tool_arguments is only valid for tool actions" });
  }
  if (action.result_map !== undefined) {
    ctx.addIssue({ code: "custom", path: ["result_map"], message: "result_map is only valid for tool actions" });
  }
}

function validateActionToolBoundary(
  action: { type: string; name: string; allowed_tools?: string[] },
  ctx: z.RefinementCtx,
): void {
  const allowed = action.allowed_tools;
  if (allowed === undefined) return;

  const seen = new Set<string>();
  for (const [index, name] of allowed.entries()) {
    if (seen.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["allowed_tools", index],
        message: `duplicate action tool ${name}`,
      });
    }
    seen.add(name);
  }

  if (action.type === "tool") {
    if (allowed.length !== 1 || allowed[0] !== action.name) {
      ctx.addIssue({
        code: "custom",
        path: ["allowed_tools"],
        message: `tool action must allow exactly its dispatched tool ${action.name}`,
      });
    }
    return;
  }

  if (action.type !== "logic" && allowed.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["allowed_tools"],
      message: `${action.type} action cannot call tools; allowed_tools must be empty`,
    });
  }
}

function validateActionFailurePolicy(
  action: {
    on_error?: "soft" | "terminal" | z.infer<typeof ErrorPolicyLadderSchema>;
    default_result?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (!Array.isArray(action.on_error)) return;
  const hasActionDefault = Object.prototype.hasOwnProperty.call(action, "default_result");
  for (let index = 0; index < action.on_error.length; index++) {
    const rule = action.on_error[index]!;
    const outcome = "do" in rule ? rule.do : rule.default;
    const hasRuleDefault = Object.prototype.hasOwnProperty.call(rule, "default_result");
    if (outcome === "continue" && !hasRuleDefault && !hasActionDefault) {
      ctx.addIssue({
        code: "custom",
        path: ["on_error", index, "default_result"],
        message: "continue requires an explicit default_result on the rule or action",
      });
    }
    if (rule.emit_event && rule.suppress_emit) {
      ctx.addIssue({
        code: "custom",
        path: ["on_error", index],
        message: "emit_event and suppress_emit=true are mutually exclusive",
      });
    }
  }
}

const TIMEOUT_ACTION_TYPES = new Set([
  "tool",
  "logic",
  "condition",
  "invoke",
  "foreach",
  "emit",
  "decision",
]);

function validateActionTimeout(
  action: { type: string; timeout_s?: number },
  ctx: z.RefinementCtx,
): void {
  if (action.timeout_s !== undefined && !TIMEOUT_ACTION_TYPES.has(action.type)) {
    ctx.addIssue({
      code: "custom",
      path: ["timeout_s"],
      message: `timeout_s is not supported for ${action.type} actions`,
    });
  }
}

/** Foreach bodies are recursive orchestration plans. The lazy edge is
 * load-bearing: nested foreach and invoke receive the same timeout,
 * error-policy, dataflow, and emit validation as top-level actions. */
const FOREACH_BODY_TYPE_NAMES = [
  "tool",
  "logic",
  "condition",
  "invoke",
  "foreach",
  "emit",
] as const;
const FOREACH_BODY_TYPES = new Set<string>(FOREACH_BODY_TYPE_NAMES);
const ForeachBodyActionSchema: z.ZodTypeAny = z.lazy(() =>
  z.intersection(
    ActionSchema,
    z.object({ type: z.enum(FOREACH_BODY_TYPE_NAMES) }).passthrough(),
  ),
);

// `.passthrough()` is deliberate (v2 parity): Agent Studio's authored action
// fields must survive a round-trip through the legacy runtime parser — a
// Guided edit or import must never silently discard fields owned by a newer
// producer. All declared safety validation still runs via superRefine.
export const ActionSchema = z.object({
  ...ActionFields,
  items_from: safeDataPath.optional(),
  item_as: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/).optional(),
  item_key_from: safeDataPath.optional(),
  foreach_mode: z.literal("sequential").optional(),
  foreach_actions: z.array(ForeachBodyActionSchema).min(1).optional(),
}).passthrough().superRefine((action, ctx) => {
  validateActionFailurePolicy(action, ctx);
  validateActionTimeout(action, ctx);
  validateActionInputBinding(action, ctx);
  validateActionDataflow(action, ctx);
  validateActionToolBoundary(action, ctx);
  if (action.type === "invoke" && action.on_error === "soft" && !Object.prototype.hasOwnProperty.call(action, "default_result")) {
    ctx.addIssue({ code: "custom", path: ["default_result"], message: "on_error=soft requires an explicit default_result" });
  }
  if (action.type === "condition" && !action.condition?.trim()) {
    ctx.addIssue({ code: "custom", path: ["condition"], message: "condition requires a non-empty expression" });
  } else if (action.type === "condition" && action.condition) {
    const error = validateConditionSyntax(action.condition);
    if (error) ctx.addIssue({ code: "custom", path: ["condition"], message: error });
  }
  if (action.type === "delay" && !(typeof action.delay_ms === "number" && action.delay_ms > 0)) {
    ctx.addIssue({ code: "custom", path: ["delay_ms"], message: "delay requires delay_ms > 0" });
  }
  if (action.type === "subflow" && !action.subflow?.trim()) {
    ctx.addIssue({ code: "custom", path: ["subflow"], message: "subflow requires a non-empty target event" });
  }
  if (action.type === "invoke" && !action.invoke?.trim()) {
    ctx.addIssue({ code: "custom", path: ["invoke"], message: "invoke requires a resolvable target" });
  }
  if (action.type === "foreach") {
    if (!action.items_from) ctx.addIssue({ code: "custom", path: ["items_from"], message: "foreach requires items_from" });
    if (!action.item_key_from) ctx.addIssue({ code: "custom", path: ["item_key_from"], message: "foreach requires a replay-stable item_key_from" });
    if (!action.foreach_actions?.length) ctx.addIssue({ code: "custom", path: ["foreach_actions"], message: "foreach requires a non-empty foreach_actions body" });
    for (const [index, child] of (action.foreach_actions ?? []).entries()) {
      if (!FOREACH_BODY_TYPES.has(String((child as { type?: unknown }).type ?? ""))) {
        ctx.addIssue({
          code: "custom",
          path: ["foreach_actions", index, "type"],
          message: "foreach body supports tool/logic/condition/invoke/foreach/emit only",
        });
      }
    }
  }
  if (action.type === "emit" && !action.emit_event) {
    ctx.addIssue({ code: "custom", path: ["emit_event"], message: "emit requires emit_event" });
  }
  if (action.type === "decision" && !action.decision_table) {
    ctx.addIssue({ code: "custom", path: ["decision_table"], message: "decision requires decision_table" });
  }
});
export type ActionSpec = z.infer<typeof ActionSchema>;

/** Depth-first action view used by boot validation/lint. Foreach is the recursive nested action
 * form; centralising this traversal prevents body tools/prompts/invokes from bypassing resolvability
 * checks merely because they are not top-level. */
export function flattenActionSpecs(actions: ReadonlyArray<ActionSpec>): ActionSpec[] {
  const out: ActionSpec[] = [];
  for (const action of actions) {
    out.push(action);
    const children = (action as ActionSpec & { foreach_actions?: ActionSpec[] }).foreach_actions;
    if (children?.length) out.push(...flattenActionSpecs(children));
  }
  return out;
}

/** Validate each action-list scope independently. `depends_on` is deliberately
 * lexical: a nested body cannot reach a parent/sibling result implicitly, and
 * forward references cannot become replay-order dependent. */
function validateActionSiblingScope(
  actions: ReadonlyArray<ActionSpec>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const prior = new Set<string>();
  for (const [index, action] of actions.entries()) {
    const key = action.result_key ?? action.name;
    const actionPath = [...path, index];
    if (prior.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: [...actionPath, action.result_key ? "result_key" : "name"],
        message: `duplicate sibling action key ${key}`,
      });
    }
    for (const dependency of action.depends_on ?? []) {
      if (!prior.has(dependency)) {
        ctx.addIssue({
          code: "custom",
          path: [...actionPath, "depends_on"],
          message: `dependency ${dependency} must reference a prior sibling action in the same scope`,
        });
      }
    }
    prior.add(key);
    if (action.type === "foreach" && action.foreach_actions?.length) {
      validateActionSiblingScope(
        action.foreach_actions as ActionSpec[],
        ctx,
        [...actionPath, "foreach_actions"],
      );
    }
  }
}

/** Canonical entry for `agent.tool_use[*]`. */
export const ToolExecutionPolicySchema = z
  .object({
    operation: z.enum(["read", "compute", "write", "read_write"]),
    effect_scope: z.enum(["none", "sandbox_local", "external"]),
    sandbox_policy: z.enum([
      "pure",
      "sandbox_local",
      "live_external",
      "requires_attempt_grant",
    ]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const valid =
      (policy.sandbox_policy === "pure"
        && policy.effect_scope === "none"
        && (policy.operation === "read" || policy.operation === "compute"))
      || (policy.sandbox_policy === "sandbox_local"
        && policy.effect_scope === "sandbox_local")
      || (policy.sandbox_policy === "live_external"
        && policy.effect_scope === "external"
        && (policy.operation === "read" || policy.operation === "compute"))
      || (policy.sandbox_policy === "requires_attempt_grant"
        && policy.effect_scope === "external"
        && (policy.operation === "write" || policy.operation === "read_write"));
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "execution_policy fields form an invalid or unsafe combination",
      });
    }
  });

/**
 * #EFFECT-READBACK (D6) — manifest form of a tool's read-back declaration.
 *
 * Kept structurally identical to `ToolEffectVerificationContract` in
 * `@agentic/tools/registry` (the catalog form) so there is ONE contract shape
 * whichever surface authored it. Paths are constrained here for authoring
 * feedback at boot; `isToolEffectVerificationContract` re-checks them at
 * dispatch because the value also arrives from the DB, where a Zod type is no
 * longer protecting it.
 */
export const ToolEffectVerificationSchema = z
  .object({
    readTool: z.string().min(1),
    readArgs: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().regex(/^(input|output)\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/),
      )
      .optional(),
    match: z
      .array(
        z
          .object({
            claim: z.string().min(1),
            observed: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ToolUseEntrySchema = z
  .object({
    name: z.string(),
    /** Reviewed policy metadata. Generated agents must provide it for every
     * declared tool; legacy hand-authored manifests may omit it. */
    side_effect: z.enum(["read", "write", "dual", "call"]).optional(),
    /** Reviewed authorization semantics. Runtime compares this exact triple to
     * the current global registry before dispatch. */
    execution_policy: ToolExecutionPolicySchema.optional(),
    description: z.string().optional(),
    input_schema: z.unknown().optional(),
    /**
     * Per-tenant tool configuration. Lifted into `ToolContext.config` at
     * dispatch time so global tools (RoboHire wrappers, fs.* family, etc.)
     * can be specialised per tenant without code changes. Example:
     *
     *   "tool_use": [
     *     { "name": "parseResumeApi",
     *       "config": { "api_key_env": "TENANT_X_RH_KEY",
     *                   "timeout_ms": 60000 } },
     *     { "name": "fs.readFromInbox",
     *       "config": { "subdir": "resumes", "max_bytes": 5242880 } }
     *   ]
     *
     * The shape is intentionally `Record<string, unknown>` — each tool
     * documents the keys it honours. The runtime never inspects this map.
     */
    config: z.record(z.string(), z.unknown()).optional(),
    /**
     * #RULE-GATE — declarative ontology rule obligations for this tool call.
     *
     * The declaration says only WHICH rules guard the call and WHERE the
     * verdict evidence lives; it can never say how severe a rule is. Severity
     * is read from the server-authored rule row itself (`failurePolicy` /
     * `enforcementLevel`), so a manifest cannot downgrade a `block` rule.
     * See `rule-guard.ts` for the full trust split and why the mode defaults
     * to `report`. A malformed declaration fails the boot, not the run.
     */
    rule_gate: RuleGateDeclarationSchema.optional(),
    /**
     * #EFFECT-READBACK (D6) — how a claimed write by THIS tool is confirmed.
     *
     * A tool's own `is_error: false` is the tool's word for it; a read-back is
     * somebody else's. The declaration names a read tool (which must also be in
     * this agent's `tool_use[]` — a read-back never widens the trust boundary),
     * how to build its arguments from this call's own `input.*` / `output.*`,
     * and which claimed fields must match what is actually there.
     *
     * Per-tenant on purpose: the confirming endpoint is routinely tenant-bound,
     * which is exactly why it cannot live only in the shipped catalog. Absence
     * is never a pass — an undeclared write reconciles as `not_verified` and
     * qualifies the run's completion. Validated structurally at dispatch by
     * `isToolEffectVerificationContract`, so a malformed declaration is
     * REPORTED rather than silently ignored.
     */
    effect_verification: ToolEffectVerificationSchema.optional(),
  })
  .passthrough();

/**
 * Coerce empty-string values to undefined for the optional string slots that
 * legacy fixtures sometimes serialized as `""`. Without this, downstream
 * code that does `if (a.ontology_instructions)` works fine, but anything that
 * asserts `.toBeUndefined()` (and the lint that validates non-empty strings)
 * sees `""` and rejects it. The DESIGN-A audit calls this out in §3.1.
 */
const emptyStringToUndef = z
  .union([z.string(), z.undefined()])
  .transform((v) => (v === "" ? undefined : v))
  .optional();

/**
 * Agent Studio's v2 contract uses `null` as the explicit "disabled" value
 * for schedule fields. Normalized v2 manifests pass through this legacy
 * runtime parser during import, so accept that v2 sentinel here as well as
 * the legacy empty string. Both normalize to an omitted schedule.
 */
const disabledScheduleToUndef = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v === "" || v === null ? undefined : v))
  .optional();

/**
 * Tolerant `tool_use` schema: accepts either an array of canonical entries
 * OR a legacy empty string (coerced to undefined). Any other shape is
 * rejected so we catch authoring mistakes. The inner `.transform(() => undefined)`
 * already converts the `""` branch to `undefined`, so the union output is
 * `Entry[] | undefined` — no need for an outer transform.
 */
const toolUseSchema = z
  .union([
    z.array(ToolUseEntrySchema),
    z.literal("").transform(() => undefined),
  ])
  .optional();

/** Promote historical dead action retry fields to the real agent boundary. */
function migrateLegacyActionRetries(input: unknown): { value: unknown; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: input };
  const agent = { ...(input as Record<string, unknown>) };
  const declared: number[] = [];
  let invalid: string | undefined;

  const migrateActions = (value: unknown, pathLabel: string): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const action = { ...(entry as Record<string, unknown>) };
      if (Object.prototype.hasOwnProperty.call(action, "retries")) {
        const retry = action.retries;
        if (typeof retry !== "number" || !Number.isInteger(retry) || retry < 0 || retry > 10) {
          invalid ??= `${pathLabel}[${index}].retries must be an integer from 0 to 10`;
        } else {
          declared.push(retry);
        }
        delete action.retries;
      }
      if (Array.isArray(action.foreach_actions)) {
        action.foreach_actions = migrateActions(
          action.foreach_actions,
          `${pathLabel}[${index}].foreach_actions`,
        );
      }
      return action;
    });
  };

  agent.actions = migrateActions(agent.actions, "actions");
  if (invalid) return { value: agent, error: invalid };
  const values = [...new Set(declared)];
  if (values.length > 1) {
    return {
      value: agent,
      error: `legacy action-level retries values conflict (${values.join(", ")}); declare one agent.retries budget`,
    };
  }
  if (values.length === 1) {
    if (agent.retries === undefined) agent.retries = values[0];
    else if (agent.retries !== values[0]) {
      return {
        value: agent,
        error: `legacy action retries=${values[0]} conflicts with agent.retries=${String(agent.retries)}`,
      };
    }
  }
  return { value: agent };
}

// `.passthrough()` is load-bearing: on-disk `workflow_v*.json` carries
// optional fields (`cron`, `model`, `timeout_s`, …) that aren't part of
// the runtime contract but ARE part of the editor-facing manifest. Stripping
// them would silently drop authoring metadata — TC-33's "preserves every
// raw-JSON key" assertion guards against that regression. The 4 fields the
// editor cares about (input_data/ontology_instructions/tool_use/typescript_code)
// are now declared explicitly so empty-string coercion + tool_use shape
// validation actually run.
const AgentObjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional().default(""),
    actor: z.array(ActorEnum).min(1),
    trigger: z.array(z.string()),
    actions: z.array(ActionSchema),
    triggered_event: z.array(z.string()),
    // Agent-level Inngest retry budget for this agent's function
    // (`createFunction({ retries })` in register.ts). Optional — absence keeps
    // the historical default of 3. This is the sole retry budget in the
    // manifest contract (and comfortably inside Inngest's 0–20 range).
    retries: z.number().int().min(0).max(10).optional(),
    // #P0-4 — compensation: the event to emit if this agent's run FAILS after it may have caused
    // side-effects (e.g. PAYMENT_INITIATED → this agent fails → emit PAYMENT_CANCELLED so downstream
    // can undo). Fired once (idempotent) on a hard failure. Optional — no-op when unset.
    compensation_event: emptyStringToUndef,
    input_data: z.record(z.string(), z.unknown()).optional(),
    ontology_instructions: emptyStringToUndef,
    tool_use: toolUseSchema,
    typescript_code: emptyStringToUndef,
    // Agent Factory marker: this agent was machine-generated and has NO hand-written tenant
    // definePrompt. Its `logic` action runs the runtime's default generated-agent prompt (the
    // agent's ontology_instructions are its system prompt) and advertises GLOBAL tools in the
    // tool-use loop. Opt-in per agent → zero effect on hand-authored tenants (RAAS et al.).
    generated: z.boolean().optional(),
    /**
     * Agent-level AI runtime settings (v2 contract, additive). Declared here
     * so the runtime reads them typed (register.ts threads them into the
     * step-engine's gateway calls); per-action overrides live on ActionSchema.
     */
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    task_class: TaskClassIdSchema.optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(1_048_576).optional(),
    timeout_s: z.number().int().positive().max(86_400).optional(),
    // Ontology provenance for an Agent-Factory-generated agent. Promotion is
    // additive, so one live manifest can legitimately contain several values.
    // Runtime declarative-tool resolution uses this identity to avoid loading
    // another ontology's same-named implementation after a tenant rebind.
    factory_domain_id: z.string().min(1).optional(),
    // Explicit delivery target + execution scope. Sandbox-only attempt ids and
    // fingerprints are never copied into the production mapping.
    factory_target_domain_id: z.string().min(1).optional(),
    factory_execution_scope: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("sandbox"),
            target_domain_id: z.string().min(1),
            candidate_fingerprint: z.string().min(1),
            attempt_id: z.string().uuid(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("production"),
            target_domain_id: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    // Exact business Action provenance. Runtime tools use it to compare their
    // profile-bound action at the final I/O boundary; tool-call names are not
    // a substitute for this identity.
    factory_action_name: z.string().min(1).optional(),
    // Immutable Agent Factory production origin. Export/CI reconciles these
    // values with the committed promotion ledger; sandbox manifests omit them.
    factory_promotion_version_id: z.string().min(1).optional(),
    factory_regression_suite_fingerprint: z
      .string()
      .regex(/^regression-suite:v1:/)
      .optional(),
    factory_input_schema: z.array(FactoryContractFieldSchema).optional(),
    factory_input_bindings: z.array(FactoryInputBindingSchema).optional(),
    factory_tool_profile_refs: z.record(z.string().min(1), z.string().min(1)).optional(),
    // Attempt-bound external-tool replay identity. Present only on ephemeral
    // sandbox manifests; production manifests must never carry these hashes.
    factory_tool_replay_refs: z.record(
      z.string().min(1),
      z.object({
        definition_hash: z.string().regex(/^[a-f0-9]{64}$/),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/),
      }).strict(),
    ).optional(),
    factory_output_schema: z.array(FactoryContractFieldSchema).optional(),
    // #G — true CodeAct: execute the exact typescript_code handler in the worker isolate. A failure
    // fails the action; it never substitutes the declarative path.
    codeExecuted: z.boolean().optional(),
    // Non-sandbox execution is denied unless the manifest carries an explicit opt-in plus the exact
    // reviewed code digest. The production import/promote gates remain a separate, stricter layer.
    code_attestation: z
      .object({
        allow_production: z.literal(true),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      })
      .strict()
      .optional(),
    // Scheduled-trigger fields. Declared explicitly so that legacy manifests
    // serialising `""` as the placeholder coerce to `undefined`; otherwise
    // `.passthrough()` would let the raw empty string flow through and the
    // scheduler would try (and fail) to parse it as a cron expression.
    // Real cron strings like "0 9 * * *" pass through unchanged because
    // `disabledScheduleToUndef` only intercepts empty-string/null sentinels
    // (v2 serializes a disabled schedule as `null`).
    cron: disabledScheduleToUndef,
    cron_timezone: disabledScheduleToUndef,
    // Config-driven schedule references. The manifest declares only the env
    // variable names; scheduler.ts resolves the operator-owned cadence and
    // timezone at boot. A missing value is reported as unconfigured rather
    // than silently inventing a business schedule.
    cron_env: emptyStringToUndef,
    cron_timezone_env: emptyStringToUndef,
  })
  .passthrough()
  .superRefine((agent, ctx) => {
    validateActionSiblingScope(agent.actions, ctx, ["actions"]);
    if (
      agent.factory_tool_replay_refs &&
      agent.factory_execution_scope?.kind !== "sandbox"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["factory_tool_replay_refs"],
        message: "factory replay refs are sandbox-attempt-only",
      });
    }
    if (agent.generated) {
      for (const [index, tool] of (agent.tool_use ?? []).entries()) {
        if (!tool.execution_policy) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tool_use", index, "execution_policy"],
            message: `generated tool ${tool.name} must declare reviewed execution_policy metadata`,
          });
        }
      }
    }
    if (
      agent.factory_domain_id &&
      agent.factory_target_domain_id &&
      agent.factory_domain_id !== agent.factory_target_domain_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["factory_target_domain_id"],
        message: "factory target domain must equal factory_domain_id",
      });
    }
    if (
      agent.factory_execution_scope &&
      agent.factory_target_domain_id &&
      agent.factory_execution_scope.target_domain_id !== agent.factory_target_domain_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["factory_execution_scope", "target_domain_id"],
        message: "factory execution scope target must equal factory_target_domain_id",
      });
    }
    const inputBindings = agent.factory_input_bindings ?? [];
    const bindingFields = new Set<string>();
    for (let index = 0; index < inputBindings.length; index++) {
      const binding = inputBindings[index]!;
      if (bindingFields.has(binding.field)) {
        ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "field"], message: `duplicate input binding field ${binding.field}` });
      }
      bindingFields.add(binding.field);
      if (binding.kind === "event" && binding.source_events?.length) {
        for (const sourceEvent of binding.source_events) {
          if (!agent.trigger.includes(sourceEvent)) {
            ctx.addIssue({
              code: "custom",
              path: ["factory_input_bindings", index, "source_events"],
              message: `event binding source ${sourceEvent} is absent from agent.trigger`,
            });
          }
        }
      }
    }
    const acquisitionActions = agent.actions.filter((action) => action.input_binding);
    for (let index = 0; index < inputBindings.length; index++) {
      const binding = inputBindings[index]!;
      if (binding.kind === "object_lookup" || binding.kind === "human_input") {
        const matches = acquisitionActions.filter((action) => action.input_binding?.field === binding.field && action.input_binding.kind === binding.kind);
        if (matches.length !== 1) {
          ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index], message: `${binding.kind} field ${binding.field} requires exactly one acquisition action` });
        }
        if (binding.kind === "object_lookup" && !(agent.tool_use ?? []).some((tool) => tool.name === binding.tool)) {
          ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "tool"], message: `object_lookup tool ${binding.tool} is absent from tool_use` });
        }
      }
      if (binding.kind === "step_output") {
        const sourceIndex = agent.actions.findIndex((action) => (action.result_key ?? action.name) === binding.source_step && !action.input_binding);
        if (sourceIndex < 0) {
          ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "source_step"], message: `step_output source ${binding.source_step} is not an executable plan action` });
        }
      }
      if (binding.kind === "object_lookup") {
        for (const dependency of binding.depends_on ?? []) {
          if (!bindingFields.has(dependency) && !inputBindings.some((candidate) => candidate.field === dependency)) {
            ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "depends_on"], message: `unknown input binding dependency ${dependency}` });
          }
        }
      }
      if (binding.kind === "secret" || binding.kind === "config") {
        const reference = parseFactoryConfigReference(binding.reference);
        const toolUse = reference
          ? (agent.tool_use ?? []).find((tool) => tool.name === reference.toolName)
          : undefined;
        const profileRef = reference ? agent.factory_tool_profile_refs?.[reference.toolName] : undefined;
        const config = toolUse?.config;
        const value = reference && config ? config[reference.configKey] : undefined;
        if (!reference || !toolUse || !config || !Object.prototype.hasOwnProperty.call(config, reference.configKey)) {
          ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "reference"], message: `${binding.kind} reference does not resolve to tool_use config` });
        } else if (!profileRef) {
          ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "reference"], message: `${binding.kind} reference has no confirmed factory_tool_profile_refs provenance` });
        } else if (binding.kind === "secret") {
          if (!/_env$/i.test(reference.configKey) || typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
            ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "reference"], message: "secret reference must target a *_env config field containing an environment-variable name" });
          }
        } else if (/_env$/i.test(reference.configKey) || value === undefined || value === null || (typeof value === "string" && !value.trim())) {
          ctx.addIssue({ code: "custom", path: ["factory_input_bindings", index, "reference"], message: "config reference must target a populated non-secret profile field" });
        }
      }
    }
    const declared = new Set(agent.triggered_event);
    for (const action of flattenActionSpecs(agent.actions)) {
      if (action.type === "emit" && action.emit_event && !declared.has(action.emit_event)) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: `emit action "${action.name}" references undeclared event "${action.emit_event}"`,
        });
      }
      if (action.type === "subflow" && action.subflow && !declared.has(action.subflow)) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: `subflow action "${action.name}" references undeclared event "${action.subflow}"`,
        });
      }
      if (action.type === "decision" && action.decision_table) {
        const emitted = [
          ...action.decision_table.rows.map((row) => row.emitEvent),
          action.decision_table.missing.emitEvent,
          action.decision_table.default.emitEvent,
        ].filter((event): event is string => !!event);
        for (const event of emitted) {
          if (!declared.has(event)) {
            ctx.addIssue({
              code: "custom",
              path: ["actions"],
              message: `decision table emitEvent "${event}" is not in triggered_event`,
            });
          }
        }
      }
      if (Array.isArray(action.on_error)) {
        for (const [ruleIndex, rule] of action.on_error.entries()) {
          if (rule.emit_event && !declared.has(rule.emit_event)) {
            ctx.addIssue({
              code: "custom",
              path: ["actions"],
              message: `action "${action.name}" error rule #${ruleIndex + 1} references undeclared event "${rule.emit_event}"`,
            });
          }
        }
      }
    }
  });

export const AgentSchema = z.preprocess((input, ctx) => {
  const migrated = migrateLegacyActionRetries(input);
  if (migrated.error) {
    ctx.addIssue({ code: "custom", message: migrated.error });
    return z.NEVER;
  }
  return migrated.value;
}, AgentObjectSchema);
export type AgentSpec = z.infer<typeof AgentSchema>;

export const WorkflowManifestSchema = z.array(AgentSchema);
export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;

export const ActionsManifestSchema = z.array(z.record(z.string(), z.unknown()));
export type ActionsManifest = z.infer<typeof ActionsManifestSchema>;

/** Per-event metadata for the Events catalog view. Loose schema. */
export const EventCatalogEntry = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
    color: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();
export const EventCatalogSchema = z.object({
  events: z.array(EventCatalogEntry).optional(),
  metadata: z.unknown().optional(),
});

/** Per-entity metadata from objects.json. */
export const EntityPropertySchema = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    description: z.string().optional(),
    is_foreign_key: z.boolean().optional(),
    references: z.string().optional(),
  })
  .passthrough();
export const EntitySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    primary_key: z.string().optional(),
    properties: z.array(EntityPropertySchema).optional(),
  })
  .passthrough();
export const ObjectsManifestSchema = z.object({
  payload: z.array(EntitySchema).optional(),
  metadata: z.unknown().optional(),
});

/** Per-rule metadata from rules.json. Pass-through. */
export const RulesManifestSchema = z
  .object({
    payload: z.array(z.unknown()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export interface LoadedManifest {
  manifest: WorkflowManifest;
  actionsExt: ActionsManifest;
  manifestPath: string;
  actionsPath: string;
}

export interface LoadedModels extends LoadedManifest {
  events: z.infer<typeof EventCatalogSchema>;
  objects: z.infer<typeof ObjectsManifestSchema>;
  rules: z.infer<typeof RulesManifestSchema>;
  dir: string;
}

/**
 * Resolve a model file in a dir. Accepts the bare name (`workflow.json`),
 * a versioned suffix (`workflow_v1.json`, `workflow_v2.json`, …), and any
 * legacy alias. Canonical names win over aliases; within one name family the
 * highest numeric version wins (the bare file is version 1).
 */
async function resolveModelFile(
  dir: string,
  candidates: string[],
): Promise<string | null> {
  let allFiles: string[];
  try {
    allFiles = await readdir(dir);
  } catch (error) {
    // Only a genuinely absent directory is an optional-file miss. Permission,
    // I/O, and wrong-file-type failures must not silently select an older or
    // empty model set.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  // Resolve each canonical name (then its aliases) independently, but choose
  // the highest NUMERIC version within that family.  The old implementation
  // returned `workflow.json` before even looking for `workflow_v2.json`, and
  // used lexical sorting for versioned files (`v9` > `v10`).  Both behaviours
  // made a durable deploy/rollback head disappear after a process restart.
  for (const c of candidates) {
    const base = c.replace(/\.json$/, "");
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escapedBase}_v(\\d+(?:\\.\\d+)*)\\.json$`, "i");
    const matches: Array<{ file: string; parts: number[] }> = [];
    if (allFiles.includes(c)) matches.push({ file: c, parts: [1] });
    for (const file of allFiles) {
      const match = file.match(re);
      if (!match?.[1]) continue;
      matches.push({
        file,
        parts: match[1].split(".").map((part) => Number(part)),
      });
    }
    matches.sort((a, b) => {
      const width = Math.max(a.parts.length, b.parts.length);
      for (let i = 0; i < width; i += 1) {
        const delta = (b.parts[i] ?? 0) - (a.parts[i] ?? 0);
        if (delta !== 0) return delta;
      }
      return a.file.localeCompare(b.file);
    });
    if (matches[0]) return path.join(dir, matches[0].file);
  }
  return null;
}

async function readJsonFileOptional<T>(
  filePath: string | null,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  if (!filePath) return fallback;
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  return schema.parse(raw);
}

/**
 * Backwards-compat wrapper: loads workflow + actions from a dir.
 * Accepts versioned names (`workflow_v1.json`).
 */
export async function loadManifestFromDisk(
  workflowDir: string,
): Promise<LoadedManifest> {
  const workflowPath = await resolveModelFile(workflowDir, [
    "workflow.json",
    "manifest.json",
  ]);
  if (!workflowPath) {
    throw new Error(
      `[manifest] no workflow.json found in ${workflowDir}`,
    );
  }
  const actionsPath = await resolveModelFile(workflowDir, ["actions.json"]);
  const rawWorkflow = JSON.parse(
    await readFile(workflowPath, "utf8"),
  ) as unknown;
  assertExecutableWorkflowManifestSource(rawWorkflow);
  // Canonical compatibility boundary (v2): a bare array stays on the legacy
  // parser so registration behavior does not change merely because a loader
  // was upgraded. A versioned Studio/import envelope (`{$schemaVersion,
  // agents}`) is first normalized through the canonical v2 compat schema
  // (defaults + refinements), then re-validated by the legacy runtime schema —
  // passthrough preserves every authored v2 field while all runtime safety
  // validation (plan scopes, error policies, emit declarations) still runs.
  const manifest = Array.isArray(rawWorkflow)
    ? WorkflowManifestSchema.parse(rawWorkflow)
    : WorkflowManifestSchema.parse(
        WorkflowManifestCompatSchema.parse(rawWorkflow).agents,
      );
  const actionsExt = await readJsonFileOptional(
    actionsPath,
    ActionsManifestSchema,
    [],
  );
  return {
    manifest,
    actionsExt,
    manifestPath: workflowPath,
    actionsPath: actionsPath ?? path.join(workflowDir, "actions.json"),
  };
}

/**
 * Load all 5 ontology files from a tenant model directory.
 */
export async function loadModelsFromDisk(
  modelDir: string,
): Promise<LoadedModels> {
  const base = await loadManifestFromDisk(modelDir);
  const [eventsPath, objectsPath, rulesPath] = await Promise.all([
    resolveModelFile(modelDir, ["events.json"]),
    resolveModelFile(modelDir, ["objects.json"]),
    resolveModelFile(modelDir, ["rules.json"]),
  ]);
  const [events, objects, rules] = await Promise.all([
    readJsonFileOptional(eventsPath, EventCatalogSchema, { events: [] }),
    readJsonFileOptional(objectsPath, ObjectsManifestSchema, { payload: [] }),
    readJsonFileOptional(rulesPath, RulesManifestSchema, { payload: [] }),
  ]);
  return { ...base, events, objects, rules, dir: modelDir };
}

/**
 * Derive tenant slug from a model folder name.
 *   "RAAS-v1"        → "raas"
 *   "supportflow-v3" → "supportflow"
 *   "finance"        → "finance"
 */
export function tenantSlugFromFolder(folder: string): string {
  return folder.toLowerCase().replace(/-v\d+(\.\d+)*$/i, "");
}
