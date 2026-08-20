import { z } from "zod";
import {
  ProviderIdSchema,
  ReasoningConfigSchema,
  TextVerbositySchema,
} from "./llm";
import { TaskClassIdSchema } from "./llm-settings";

/**
 * Canonical Agent Definition v2.
 *
 * This is deliberately additive to the v1 manifest contract in agents.ts.
 * V1 callers continue to use AgentSpec/WorkflowManifest while new Studio and
 * runtime code can share this lossless, editor-facing definition. Every
 * extensible object uses passthrough so a Guided edit cannot discard fields
 * owned by a newer runtime or an external manifest producer.
 */

export const AGENT_DEFINITION_SCHEMA_VERSION = 2 as const;

/** JSON Schema draft 2020-12 document. Semantic limits are checked separately. */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

export const AgentPortIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    "port id must start with a letter and contain only letters, numbers, _ or -",
  );
export type AgentPortId = z.infer<typeof AgentPortIdSchema>;

export const AgentSensitivitySchema = z.enum([
  "none",
  "personal",
  "confidential",
  "secret",
]);
export type AgentSensitivity = z.infer<typeof AgentSensitivitySchema>;

export const AgentInputKindSchema = z.enum(["prompt", "value", "file"]);
export type AgentInputKind = z.infer<typeof AgentInputKindSchema>;

export const AgentPortUiSchema = z
  .object({
    control: z
      .enum([
        "text",
        "textarea",
        "number",
        "checkbox",
        "select",
        "json",
        "file",
      ])
      .optional(),
    placeholder: z.string().max(1_000).optional(),
    helpText: z.string().max(4_000).optional(),
    order: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type AgentPortUi = z.infer<typeof AgentPortUiSchema>;

export const AgentFilePolicySchema = z
  .object({
    media_types: z.array(z.string().min(1).max(200)).max(100).optional(),
    max_bytes: z.number().int().positive().optional(),
    multiple: z.boolean().optional(),
  })
  .passthrough();
export type AgentFilePolicy = z.infer<typeof AgentFilePolicySchema>;

export const AgentInputPortV2Schema = z
  .object({
    id: AgentPortIdSchema,
    label: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(8_000).optional(),
    kind: AgentInputKindSchema,
    required: z.boolean().default(false),
    schema: JsonSchemaSchema,
    default: z.unknown().optional(),
    example: z.unknown().optional(),
    sensitivity: AgentSensitivitySchema.default("none"),
    ui: AgentPortUiSchema.optional(),
    file: AgentFilePolicySchema.optional(),
  })
  .passthrough();
export type AgentInputPortV2 = z.infer<typeof AgentInputPortV2Schema>;

export const AgentOutputPortV2Schema = z
  .object({
    id: AgentPortIdSchema,
    label: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(8_000).optional(),
    required: z.boolean().default(true),
    schema: JsonSchemaSchema,
    example: z.unknown().optional(),
    sensitivity: AgentSensitivitySchema.default("none"),
    ui: AgentPortUiSchema.optional(),
  })
  .passthrough();
export type AgentOutputPortV2 = z.infer<typeof AgentOutputPortV2Schema>;

const JsonPathSchema = z.string().trim().min(1).max(2_000);
const TemplateSchema = z.string().max(32 * 1024);

/** One production-event payload binding for an input port. */
export const AgentTriggerBindingV2Schema = z.union([
  z.object({ path: JsonPathSchema }).passthrough(),
  z.object({ template: TemplateSchema }).passthrough(),
  z.object({ constant: z.unknown() }).passthrough(),
]);
export type AgentTriggerBindingV2 = z.infer<typeof AgentTriggerBindingV2Schema>;

/** event name -> input port id -> binding */
export const AgentTriggerBindingsV2Schema = z.record(
  z.string(),
  z.record(z.string(), AgentTriggerBindingV2Schema),
);
export type AgentTriggerBindingsV2 = z.infer<
  typeof AgentTriggerBindingsV2Schema
>;

/** One output-event payload field binding. */
export const AgentOutputBindingV2Schema = z.union([
  z
    .object({ input: AgentPortIdSchema, path: JsonPathSchema.optional() })
    .passthrough(),
  z
    .object({ output: AgentPortIdSchema, path: JsonPathSchema.optional() })
    .passthrough(),
  z.object({ template: TemplateSchema }).passthrough(),
  z.object({ constant: z.unknown() }).passthrough(),
]);
export type AgentOutputBindingV2 = z.infer<typeof AgentOutputBindingV2Schema>;

/** event name -> emitted payload field -> binding */
export const AgentOutputBindingsV2Schema = z.record(
  z.string(),
  z.record(z.string(), AgentOutputBindingV2Schema),
);
export type AgentOutputBindingsV2 = z.infer<typeof AgentOutputBindingsV2Schema>;

export const AgentPromptProvenanceV2Schema = z
  .object({
    mode: z.enum(["manual", "ai-assisted", "imported"]),
    source_hash: z.string().min(1).optional(),
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    generated_at: z.string().datetime().optional(),
    tokens_in: z.number().int().nonnegative().nullable().optional(),
    tokens_out: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
export type AgentPromptProvenanceV2 = z.infer<
  typeof AgentPromptProvenanceV2Schema
>;

export const AgentToolUseV2Schema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(2_000).optional(),
    input_schema: JsonSchemaSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AgentToolUseV2 = z.infer<typeof AgentToolUseV2Schema>;

export const AgentActionTypeV2Schema = z.enum([
  "tool",
  "logic",
  "manual",
  "condition",
  "delay",
  "subflow",
  // Factory-runtime action types (merged from our manifest step-engine): sub-agent
  // invocation, iteration, and event emission. Additive — Agent Studio simply does
  // not author these; the manifest runtime dispatches them (fields flow via
  // AgentActionV2Schema.passthrough()).
  "invoke",
  "foreach",
  "emit",
]);
export type AgentActionTypeV2 = z.infer<typeof AgentActionTypeV2Schema>;

export const AgentActionV2Schema = z
  .object({
    id: z.string().trim().min(1).max(160).optional(),
    order: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(8_000).default(""),
    type: AgentActionTypeV2Schema,
    action_prompt: z
      .string()
      .max(32 * 1024)
      .optional(),
    /**
     * Optional per-step model controls. An omitted value inherits the agent
     * runtime setting; an authored value overrides it for this action only.
     * Keeping these on the canonical action schema makes Studio, manifest
     * import, and the Inngest runtime share one lossless contract.
     */
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(1_048_576).optional(),
    retries: z.number().int().nonnegative().max(10).optional(),
    timeout_s: z.number().int().positive().max(86_400).optional(),
    /** Optional per-action override of the agent's AI-settings task class. */
    task_class: TaskClassIdSchema.optional(),
    tool: z.string().trim().min(1).max(160).optional(),
    condition: z.string().max(8_000).optional(),
    true_action_id: z.string().max(160).optional(),
    false_action_id: z.string().max(160).optional(),
    task_type: z.string().max(160).optional(),
    form_schema: JsonSchemaSchema.optional(),
    awaiting_role: z.string().max(160).optional(),
    delay_ms: z.number().int().nonnegative().optional(),
    subflow: z.string().max(160).optional(),
    subflow_input: z.record(z.string(), z.unknown()).optional(),
    wait_policy: z.enum(["wait", "detach"]).optional(),
    input_mapping: z.record(z.string(), z.unknown()).optional(),
    output_mapping: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AgentActionV2 = z.infer<typeof AgentActionV2Schema>;

export const AgentConcurrencyV2Schema = z
  .object({
    enabled: z.boolean().default(true),
    max_concurrent_executions: z.number().int().positive().max(1_000),
    key: z.string().max(2_000).optional(),
  })
  .passthrough();
export type AgentConcurrencyV2 = z.infer<typeof AgentConcurrencyV2Schema>;

export const AgentToolLoopV2Schema = z
  .object({
    max_iterations: z.number().int().positive().max(100).default(8),
  })
  .passthrough();
export type AgentToolLoopV2 = z.infer<typeof AgentToolLoopV2Schema>;

export const RESERVED_AGENT_ARTIFACT_FILENAMES = [
  "agent-definition.json",
  "run-input.json",
  "run-record.json",
  "raw-response.txt",
] as const;

const reservedAgentArtifactFilenames = new Set<string>(
  RESERVED_AGENT_ARTIFACT_FILENAMES,
);

export const AgentArtifactPolicyV2Schema = z
  .object({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^/\\]+$/, "artifact filename must be a leaf name")
      .refine((name) => name !== "." && name !== "..", {
        message: "artifact filename cannot be . or ..",
      })
      .refine(
        (name) => !reservedAgentArtifactFilenames.has(name.toLowerCase()),
        {
          message:
            "artifact filename is reserved for Agent Studio run evidence",
        },
      )
      .default("output.json"),
    persist_individual_outputs: z.boolean().default(false),
    persist_run_input: z.boolean().default(true),
    persist_run_record: z.literal(true).default(true),
    persist_raw_response: z.boolean().default(false),
  })
  .passthrough();
export type AgentArtifactPolicyV2 = z.infer<typeof AgentArtifactPolicyV2Schema>;

export const AgentOutputConfigV2Schema = z
  .object({
    format: z.literal("json").default("json"),
    strict: z.boolean().default(true),
    repair_attempts: z.number().int().nonnegative().max(3).default(1),
    unwrap_single_output: z.boolean().default(false),
    artifact: AgentArtifactPolicyV2Schema.default({
      filename: "output.json",
      persist_individual_outputs: false,
      persist_run_input: true,
      persist_run_record: true,
      persist_raw_response: false,
    }),
  })
  .passthrough();
export type AgentOutputConfigV2 = z.infer<typeof AgentOutputConfigV2Schema>;

export const AgentObservabilityV2Schema = z
  .object({
    trace_level: z.enum(["minimal", "standard", "debug"]).default("standard"),
    reasoning_summary: z.boolean().default(true),
    persist_rendered_prompts: z.boolean().default(false),
    retention_days: z.number().int().positive().max(3_650).default(3_650),
  })
  .passthrough();
export type AgentObservabilityV2 = z.infer<typeof AgentObservabilityV2Schema>;

/** Runtime fields retain their existing manifest names for v1 compatibility. */
export const AgentRuntimeConfigV2Schema = z
  .object({
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    task_class: TaskClassIdSchema.optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(1_048_576).optional(),
    timeout_s: z.number().int().positive().max(86_400).optional(),
    retries: z.number().int().nonnegative().max(10).optional(),
    concurrency: AgentConcurrencyV2Schema.optional(),
    tool_loop: AgentToolLoopV2Schema.optional(),
    cron: z.string().trim().min(1).max(240).nullable().optional(),
    cron_timezone: z.string().trim().min(1).max(240).nullable().optional(),
    observability: AgentObservabilityV2Schema.optional(),
  })
  .passthrough();
export type AgentRuntimeConfigV2 = z.infer<typeof AgentRuntimeConfigV2Schema>;

const AgentDefinitionV2BaseSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(160),
    title: z.string().max(240).optional(),
    description: z.string().max(8_000).default(""),
    actor: z.array(z.enum(["Agent", "Human"])).min(1),
    stage: z.number().int().min(0).max(999).optional(),
    template: z
      .enum(["blank", "classify", "extract", "rag", "loop", "human"])
      .optional(),
    trigger: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
    trigger_bindings: AgentTriggerBindingsV2Schema.optional(),
    inputs: z.array(AgentInputPortV2Schema).min(1).max(200),
    input_data: z.record(z.string(), z.unknown()).optional(),
    ontology_instructions: z
      .string()
      .max(128 * 1024)
      .optional(),
    user_prompt_template: z
      .string()
      .max(128 * 1024)
      .optional(),
    generated: z.boolean().optional(),
    prompt_provenance: AgentPromptProvenanceV2Schema.optional(),
    tool_use: z.array(AgentToolUseV2Schema).max(200).default([]),
    actions: z.array(AgentActionV2Schema).max(500).default([]),
    outputs: z.array(AgentOutputPortV2Schema).min(1).max(200),
    output_config: AgentOutputConfigV2Schema.default({
      format: "json",
      strict: true,
      repair_attempts: 1,
      unwrap_single_output: false,
      artifact: {
        filename: "output.json",
        persist_individual_outputs: false,
        persist_run_input: true,
        persist_run_record: true,
        persist_raw_response: false,
      },
    }),
    triggered_event: z
      .array(z.string().trim().min(1).max(160))
      .max(100)
      .default([]),
    output_bindings: AgentOutputBindingsV2Schema.optional(),
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    task_class: TaskClassIdSchema.optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(1_048_576).optional(),
    timeout_s: z.number().int().positive().max(86_400).optional(),
    retries: z.number().int().nonnegative().max(10).optional(),
    concurrency: AgentConcurrencyV2Schema.optional(),
    tool_loop: AgentToolLoopV2Schema.optional(),
    cron: z.string().trim().min(1).max(240).nullable().optional(),
    cron_timezone: z.string().trim().min(1).max(240).nullable().optional(),
    observability: AgentObservabilityV2Schema.optional(),
    typescript_code: z
      .string()
      .max(256 * 1024)
      .optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const AgentDefinitionV2Schema = AgentDefinitionV2BaseSchema.superRefine(
  (definition, ctx) => {
    const inputIds = new Set<string>();
    let promptCount = 0;
    definition.inputs.forEach((input, index) => {
      if (inputIds.has(input.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate input id: ${input.id}`,
          path: ["inputs", index, "id"],
        });
      }
      inputIds.add(input.id);
      if (input.kind === "prompt") {
        promptCount += 1;
        if (input.id !== "prompt") {
          ctx.addIssue({
            code: "custom",
            message: 'the reserved prompt input must use id "prompt"',
            path: ["inputs", index, "id"],
          });
        }
      }
    });

    const outputIds = new Set<string>();
    definition.outputs.forEach((output, index) => {
      if (outputIds.has(output.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate output id: ${output.id}`,
          path: ["outputs", index, "id"],
        });
      }
      outputIds.add(output.id);
    });

    if (definition.actor.includes("Agent") && promptCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "LLM agents must declare exactly one prompt input",
        path: ["inputs"],
      });
    }
    if (!definition.actor.includes("Agent") && promptCount > 1) {
      ctx.addIssue({
        code: "custom",
        message: "human agents may declare at most one prompt input",
        path: ["inputs"],
      });
    }
  },
);
export type AgentDefinitionV2 = z.infer<typeof AgentDefinitionV2Schema>;
export type AgentDefinitionV2Input = z.input<typeof AgentDefinitionV2Schema>;

export const WorkflowManifestV2Schema = z
  .object({
    $schemaVersion: z.literal(AGENT_DEFINITION_SCHEMA_VERSION),
    agents: z.array(AgentDefinitionV2Schema),
  })
  .passthrough();
export type WorkflowManifestV2 = z.infer<typeof WorkflowManifestV2Schema>;
export type WorkflowManifestV2Input = z.input<typeof WorkflowManifestV2Schema>;

/**
 * Normalize one v1/v2 agent object into the v2 contract. This is intentionally
 * deterministic and side-effect free so API, runtime, import, and tests can
 * share one compatibility boundary.
 */
function legacyJsonSchema(type: unknown): JsonSchema {
  const value = String(type ?? "string")
    .trim()
    .toLowerCase();
  const list = value.match(/^(?:list|array)\s*[<(]\s*(.+?)\s*[>)]$/);
  if (list) return { type: "array", items: legacyJsonSchema(list[1]) };
  if (value.startsWith("list") || value.startsWith("array")) {
    return { type: "array", items: {} };
  }
  if (["integer", "int", "long"].includes(value)) return { type: "integer" };
  if (["number", "float", "double", "decimal"].includes(value)) {
    return { type: "number" };
  }
  if (["boolean", "bool"].includes(value)) return { type: "boolean" };
  if (["json", "object", "map", "dictionary"].includes(value)) {
    return { type: "object" };
  }
  if (["date", "localdate"].includes(value)) {
    return { type: "string", format: "date" };
  }
  if (["datetime", "date-time", "timestamp"].includes(value)) {
    return { type: "string", format: "date-time" };
  }
  return { type: "string" };
}

function legacyPortId(value: unknown, fallback: string): string {
  const normalized = String(value ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, 120);
  return normalized || fallback;
}

function uniquePortId(
  desired: string,
  fallback: string,
  used: Set<string>,
): string {
  const base = legacyPortId(desired, fallback);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 112)}_${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

function legacySensitivity(
  port: Record<string, unknown>,
  id: string,
): AgentSensitivity {
  if (
    port.sensitivity === "none" ||
    port.sensitivity === "personal" ||
    port.sensitivity === "confidential" ||
    port.sensitivity === "secret"
  ) {
    return port.sensitivity;
  }
  return /password|passwd|credential|secret|token|api[_-]?key/i.test(id)
    ? "secret"
    : "none";
}

export function normalizeAgentDefinition(input: unknown): AgentDefinitionV2 {
  const raw = z.record(z.string(), z.unknown()).parse(input);

  const actor = Array.isArray(raw.actor)
    ? raw.actor
    : raw.actor === "Human" || raw.actor === "Agent"
      ? [raw.actor]
      : ["Agent"];
  const inputData =
    raw.input_data &&
    typeof raw.input_data === "object" &&
    !Array.isArray(raw.input_data)
      ? (raw.input_data as Record<string, unknown>)
      : {};
  const promptDefault =
    typeof inputData.prompt === "string" ? inputData.prompt : undefined;
  const providerCandidate =
    raw.provider === "" || raw.provider == null
      ? raw.defaultProvider
      : raw.provider;
  const provider =
    providerCandidate === "" || providerCandidate == null
      ? undefined
      : providerCandidate;
  const modelCandidate =
    raw.model === "" || raw.model == null ? raw.defaultModel : raw.model;
  const model =
    modelCandidate === "" || modelCandidate == null
      ? undefined
      : modelCandidate;

  const rawActions = Array.isArray(raw.actions)
    ? raw.actions
    : Array.isArray(raw.action_steps)
      ? raw.action_steps
      : [];
  const actions = rawActions.map((value, index) => {
    const action = z.record(z.string(), z.unknown()).parse(value);
    const order = String(action.order ?? index + 1);
    const legacyType = String(action.type ?? action.object_type ?? "logic");
    const type =
      legacyType === "action"
        ? actor.includes("Human")
          ? "manual"
          : "logic"
        : legacyType === "human"
          ? "manual"
          : [
                "tool",
                "logic",
                "manual",
                "condition",
                "delay",
                "subflow",
              ].includes(legacyType)
            ? legacyType
            : "logic";
    const name = String(action.name ?? action.id ?? `step${index + 1}`);
    return {
      ...action,
      order,
      name,
      description:
        typeof action.description === "string" ? action.description : "",
      type,
      ...(type === "tool" && !action.tool ? { tool: name } : {}),
      ...(type === "logic" &&
      !action.action_prompt &&
      typeof action.description === "string"
        ? { action_prompt: action.description }
        : {}),
    };
  });

  const rawTools = Array.isArray(raw.tool_use) ? raw.tool_use : [];
  const toolUse = rawTools.map((value) =>
    typeof value === "string" ? { name: value } : value,
  );
  for (const action of actions) {
    if (
      action.type === "tool" &&
      typeof action.tool === "string" &&
      !toolUse.some(
        (tool) =>
          tool &&
          typeof tool === "object" &&
          "name" in tool &&
          tool.name === action.tool,
      )
    ) {
      toolUse.push({ name: action.tool });
    }
  }

  const direct = AgentDefinitionV2Schema.safeParse({
    ...raw,
    actor,
    actions,
    tool_use: toolUse,
    provider,
    model,
    cron: raw.cron === "" ? null : raw.cron,
    cron_timezone: raw.cron_timezone === "" ? null : raw.cron_timezone,
  });
  if (direct.success) return direct.data;

  const usedInputIds = new Set<string>();
  const rawInputs = Array.isArray(raw.inputs) ? raw.inputs : null;
  const inputs: AgentInputPortV2[] = (rawInputs ?? []).map((value, index) => {
    const port = z.record(z.string(), z.unknown()).parse(value);
    const requestedId = legacyPortId(
      port.id ?? port.name,
      `input_${index + 1}`,
    );
    const id = uniquePortId(
      port.kind === "prompt" ? "prompt" : requestedId,
      `input_${index + 1}`,
      usedInputIds,
    );
    const kind =
      id === "prompt" || port.kind === "prompt"
        ? "prompt"
        : port.kind === "file" || /file|upload/i.test(String(port.type ?? ""))
          ? "file"
          : "value";
    const schema =
      port.schema &&
      typeof port.schema === "object" &&
      !Array.isArray(port.schema)
        ? (port.schema as JsonSchema)
        : port.input_schema &&
            typeof port.input_schema === "object" &&
            !Array.isArray(port.input_schema)
          ? (port.input_schema as JsonSchema)
          : legacyJsonSchema(port.type);
    return {
      ...port,
      id: kind === "prompt" ? "prompt" : id,
      label: String(port.label ?? port.name ?? id),
      description:
        typeof port.description === "string" ? port.description : undefined,
      kind,
      required: Boolean(port.required),
      schema,
      sensitivity: legacySensitivity(port, id),
    };
  });

  if (
    actor.includes("Agent") &&
    !inputs.some((port) => port.kind === "prompt")
  ) {
    usedInputIds.add("prompt");
    inputs.unshift({
      id: "prompt",
      label: "Request",
      kind: "prompt",
      required: rawInputs !== null,
      schema: { type: "string" },
      ...(rawInputs === null
        ? {
            default:
              promptDefault ??
              "Process the incoming workflow event according to the agent instructions.",
          }
        : {}),
      sensitivity: "none",
    });
  }
  if (inputs.length === 0) {
    inputs.push({
      id: "prompt",
      label: "Request",
      kind: "prompt",
      required: false,
      schema: { type: "string" },
      default:
        promptDefault ??
        "Process the incoming workflow event according to the agent instructions.",
      sensitivity: "none",
    });
  }
  if (rawInputs === null) {
    inputs.push({
      id: "payload",
      label: "Payload",
      kind: "value",
      required: false,
      schema: { type: "object" },
      default: inputData,
      sensitivity: "none",
    });
  }

  const usedOutputIds = new Set<string>();
  const rawOutputs = Array.isArray(raw.outputs) ? raw.outputs : null;
  const outputs: AgentOutputPortV2[] = (rawOutputs ?? []).map(
    (value, index) => {
      const port = z.record(z.string(), z.unknown()).parse(value);
      const id = uniquePortId(
        String(port.id ?? port.name ?? ""),
        `output_${index + 1}`,
        usedOutputIds,
      );
      const schema =
        port.schema &&
        typeof port.schema === "object" &&
        !Array.isArray(port.schema)
          ? (port.schema as JsonSchema)
          : port.output_schema &&
              typeof port.output_schema === "object" &&
              !Array.isArray(port.output_schema)
            ? (port.output_schema as JsonSchema)
            : legacyJsonSchema(port.type);
      return {
        ...port,
        id,
        label: String(port.label ?? port.name ?? id),
        description:
          typeof port.description === "string" ? port.description : undefined,
        required: port.required !== false,
        schema,
        sensitivity: legacySensitivity(port, id),
      };
    },
  );
  if (outputs.length === 0) {
    outputs.push({
      id: "result",
      label: "Result",
      required: true,
      schema: {},
      sensitivity: "none",
    });
  }

  const supplementalInputIds = inputs
    .filter((port) => port.id !== "prompt")
    .map((port) => port.id);
  const extensions =
    raw.extensions &&
    typeof raw.extensions === "object" &&
    !Array.isArray(raw.extensions)
      ? (raw.extensions as Record<string, unknown>)
      : {};

  const normalized = {
    ...raw,
    id: String(raw.id ?? raw.name ?? "agent"),
    name: String(raw.name ?? raw.id ?? "agent"),
    description: typeof raw.description === "string" ? raw.description : "",
    actor,
    trigger: Array.isArray(raw.trigger) ? raw.trigger : [],
    inputs,
    ontology_instructions:
      typeof raw.ontology_instructions === "string"
        ? raw.ontology_instructions
        : typeof raw.system_prompt === "string" && raw.system_prompt.trim()
          ? raw.system_prompt
          : undefined,
    actions,
    tool_use: toolUse,
    outputs,
    provider,
    model,
    output_config:
      raw.output_config ??
      ({
        format: "json",
        strict: false,
        repair_attempts: 0,
        unwrap_single_output: false,
        artifact: {
          filename: "output.json",
          persist_individual_outputs: false,
          persist_run_input: true,
          persist_run_record: true,
          persist_raw_response: false,
        },
      } as const),
    triggered_event: Array.isArray(raw.triggered_event)
      ? raw.triggered_event
      : [],
    user_prompt_template:
      typeof raw.user_prompt_template === "string"
        ? raw.user_prompt_template
        : supplementalInputIds.length
          ? supplementalInputIds
              .map((id) => `${id}: {{json inputs.${id}}}`)
              .join("\n")
          : "",
    cron: raw.cron === "" ? null : raw.cron,
    cron_timezone: raw.cron_timezone === "" ? null : raw.cron_timezone,
    extensions: {
      ...extensions,
      compatibility_mode:
        typeof extensions.compatibility_mode === "string"
          ? extensions.compatibility_mode
          : "v1",
    },
  };

  return AgentDefinitionV2Schema.parse(normalized);
}

export function normalizeWorkflowManifest(input: unknown): WorkflowManifestV2 {
  if (Array.isArray(input)) {
    return WorkflowManifestV2Schema.parse({
      $schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
      agents: input.map(normalizeAgentDefinition),
    });
  }

  const envelope = z.record(z.string(), z.unknown()).parse(input);
  if (!Array.isArray(envelope.agents)) {
    throw new TypeError(
      "workflow manifest must be a bare agent array or an agents envelope",
    );
  }
  if (
    envelope.$schemaVersion !== undefined &&
    envelope.$schemaVersion !== 1 &&
    envelope.$schemaVersion !== AGENT_DEFINITION_SCHEMA_VERSION
  ) {
    throw new RangeError(
      `unsupported workflow schema version: ${String(envelope.$schemaVersion)}`,
    );
  }
  return WorkflowManifestV2Schema.parse({
    ...envelope,
    $schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    agents: envelope.agents.map(normalizeAgentDefinition),
  });
}

/** Accepts v1 arrays or v2 envelopes and always outputs the v2 envelope. */
export const WorkflowManifestCompatSchema = z
  .union([
    WorkflowManifestV2Schema,
    z.array(z.record(z.string(), z.unknown())),
    z
      .object({ agents: z.array(z.record(z.string(), z.unknown())) })
      .passthrough(),
  ])
  .transform(normalizeWorkflowManifest);
export type WorkflowManifestCompat = z.infer<
  typeof WorkflowManifestCompatSchema
>;
