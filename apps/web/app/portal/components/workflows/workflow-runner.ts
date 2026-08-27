import {
  normalizeWorkflowManifest,
  type AgentDefinitionV2,
  type WorkflowRunEntrypoint,
  type WorkflowRunInputBinding,
  type WorkflowRunInputDescriptor,
  type WorkflowTestRunLimits,
} from "@agentic/contracts";
import type { Translate } from "@/app/portal/lib/preferences-context";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function bindingFor(
  agent: AgentDefinitionV2,
  event: string,
  inputId: string,
): WorkflowRunInputBinding {
  const binding = agent.trigger_bindings?.[event]?.[inputId];
  if (!binding) return { agentId: agent.id, mode: "direct" };
  if ("path" in binding && typeof binding.path === "string") {
    return { agentId: agent.id, mode: "path", expression: binding.path };
  }
  if ("template" in binding && typeof binding.template === "string") {
    return {
      agentId: agent.id,
      mode: "template",
      expression: binding.template,
    };
  }
  return { agentId: agent.id, mode: "constant" };
}

function sameContract(
  current: WorkflowRunInputDescriptor,
  candidate: WorkflowRunInputDescriptor,
): boolean {
  return (
    current.kind === candidate.kind &&
    current.sensitivity === candidate.sensitivity &&
    stableJson(current.schema) === stableJson(candidate.schema) &&
    stableJson(current.file ?? null) === stableJson(candidate.file ?? null)
  );
}

/** Client-side equivalent of the API profile builder for unsaved manifests. */
export function deriveWorkflowEntrypoints(
  manifestInput: unknown,
  t?: Translate,
): {
  entrypoints: WorkflowRunEntrypoint[];
  warnings: string[];
} {
  const manifest = normalizeWorkflowManifest(manifestInput);
  const emitted = new Set(
    manifest.agents.flatMap((agent) => agent.triggered_event),
  );
  const listeners = new Map<string, AgentDefinitionV2[]>();
  for (const agent of manifest.agents) {
    for (const event of agent.trigger) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(agent);
      listeners.set(event, bucket);
    }
  }

  const entrypoints = [...listeners.entries()]
    .map(([event, agents]): WorkflowRunEntrypoint => {
      const inputs = new Map<string, WorkflowRunInputDescriptor>();
      let requiresRawPayload = false;
      for (const agent of agents) {
        for (const port of agent.inputs) {
          const binding = bindingFor(agent, event, port.id);
          requiresRawPayload ||= ["path", "template"].includes(binding.mode);
          const candidate: WorkflowRunInputDescriptor = {
            id: port.id,
            label: port.label ?? port.id,
            description: port.description ?? null,
            kind: port.kind,
            required:
              port.required &&
              binding.mode !== "constant" &&
              binding.mode !== "template",
            schema: structuredClone(port.schema),
            ...(port.default !== undefined
              ? { default: structuredClone(port.default) }
              : {}),
            ...(port.example !== undefined
              ? { example: structuredClone(port.example) }
              : {}),
            sensitivity: port.sensitivity,
            ...(port.ui ? { ui: structuredClone(port.ui) } : {}),
            ...(port.file ? { file: structuredClone(port.file) } : {}),
            consumers: [agent.id],
            bindings: [binding],
            conflict: false,
          };
          const current = inputs.get(port.id);
          if (!current) {
            inputs.set(port.id, candidate);
            continue;
          }
          current.required ||= candidate.required;
          current.consumers = [...new Set([...current.consumers, agent.id])];
          current.bindings.push(binding);
          current.conflict ||= !sameContract(current, candidate);
        }
      }
      const source = emitted.has(event) ? "internal" : "external";
      return {
        event,
        source,
        recommended: source === "external",
        listenerAgentIds: agents.map((agent) => agent.id),
        listenerTitles: agents.map(
          (agent) => agent.title ?? agent.name ?? agent.id,
        ),
        inputs: [...inputs.values()].sort((left, right) => {
          const leftOrder = left.ui?.order ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = right.ui?.order ?? Number.MAX_SAFE_INTEGER;
          return (
            leftOrder - rightOrder ||
            left.label.localeCompare(right.label) ||
            left.id.localeCompare(right.id)
          );
        }),
        requiresRawPayload,
      };
    })
    .sort(
      (left, right) =>
        Number(right.recommended) - Number(left.recommended) ||
        left.event.localeCompare(right.event),
    );

  const warnings: string[] = [];
  if (entrypoints.length === 0) {
    warnings.push(
      t?.("workflowRunConsole.warningNoTriggers") ??
        "The workflow declares no trigger events.",
    );
  } else if (!entrypoints.some((entrypoint) => entrypoint.recommended)) {
    warnings.push(
      t?.("workflowRunConsole.warningInternalOnly") ??
        "Every trigger is emitted internally. Choose an internal event deliberately and retain bounded test limits.",
    );
  }
  for (const entrypoint of entrypoints) {
    const conflicts = entrypoint.inputs.filter((input) => input.conflict);
    if (conflicts.length > 0) {
      warnings.push(
        t?.("workflowRunConsole.warningConflicts", {
          event: entrypoint.event,
          inputs: conflicts.map((input) => input.id).join(", "),
        }) ??
          `${entrypoint.event} has conflicting contracts for ${conflicts.map((input) => input.id).join(", ")}.`,
      );
    }
  }
  return { entrypoints, warnings };
}

export type WorkflowInputControl =
  | "text"
  | "textarea"
  | "number"
  | "checkbox"
  | "select"
  | "json"
  | "file";

export interface WorkflowPayloadFieldGuide {
  inputId: string;
  label: string;
  description: string | null;
  required: boolean;
  sensitivity: WorkflowRunInputDescriptor["sensitivity"];
  type: string;
  locations: string[];
  example: unknown;
  exampleSource:
    | "authored example"
    | "authored default"
    | "schema generated"
    | "binding generated";
  runtimeProvided: boolean;
}

export interface WorkflowPayloadGuide {
  /** Values loaded into the generated named-input controls. */
  inputValues: Record<string, unknown>;
  /** Advanced JSON merged over the event root by the Run Console. */
  rawPayload: Record<string, unknown>;
  /** Caller-facing event shape after named inputs and advanced JSON are combined. */
  eventPayload: Record<string, unknown>;
  fields: WorkflowPayloadFieldGuide[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function meaningfulExample(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function identifierExample(identifier: string, t?: Translate): string {
  const normalized = identifier.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized.includes("email")) return "alex.morgan@example.com";
  if (normalized.includes("phone") || normalized.includes("mobile")) {
    return "+1-202-555-0147";
  }
  if (normalized.includes("url") || normalized.includes("uri")) {
    return "https://example.com/resources/record-001";
  }
  if (normalized.includes("customer_message")) {
    return (
      t?.("workflowRunConsole.exampleCustomerMessage") ??
      "I was charged twice for invoice INV-2048. Please review the duplicate charge."
    );
  }
  if (
    normalized.includes("prompt") ||
    normalized === "request" ||
    normalized.includes("instruction")
  ) {
    return (
      t?.("workflowRunConsole.examplePrompt") ??
      "Review the supplied event, validate the data, and return the expected workflow result."
    );
  }
  if (normalized.includes("message") || normalized.includes("description")) {
    return (
      t?.("workflowRunConsole.exampleBusinessContext") ??
      "Provide the business context and expected outcome for this workflow run."
    );
  }
  if (normalized.includes("priority")) return "normal";
  if (normalized.includes("status")) return "pending";
  if (normalized.includes("name")) {
    return t?.("workflowRunConsole.exampleRecord") ?? "Example record";
  }
  if (normalized.includes("request_id")) return "REQ-2026-001";
  if (normalized.includes("case_id")) return "CASE-2026-001";
  if (normalized.includes("customer_id")) return "CUS-2026-001";
  if (normalized.includes("document_id")) return "DOC-2026-001";
  if (normalized.endsWith("_id") || normalized === "id") {
    const prefix = normalized
      .replace(/_id$/, "")
      .split("_")
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 4)
      .toUpperCase();
    return `${prefix || "REQ"}-2026-001`;
  }
  return t?.("workflowRunConsole.exampleValue") ?? "Example value";
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((candidate) => candidate !== "null");
  }
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return undefined;
}

function schemaExample(
  schema: Record<string, unknown>,
  identifier: string,
  kind: WorkflowRunInputDescriptor["kind"],
  depth = 0,
  t?: Translate,
): unknown {
  if (depth > 5) return null;
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(schema.enum[0]);
  }
  if (meaningfulExample(schema.default)) {
    return structuredClone(schema.default);
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return structuredClone(schema.examples[0]);
  }
  for (const union of [schema.oneOf, schema.anyOf]) {
    if (Array.isArray(union) && isRecord(union[0])) {
      return schemaExample(union[0], identifier, kind, depth + 1, t);
    }
  }

  const type = schemaType(schema);
  if (type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Object.keys(properties).length > 0) {
      return Object.fromEntries(
        Object.entries(properties)
          .slice(0, 20)
          .map(([key, child]) => [
            key,
            schemaExample(
              isRecord(child) ? child : {},
              key,
              "value",
              depth + 1,
              t,
            ),
          ]),
      );
    }
    if (schema.additionalProperties === false) return {};
    return {
      request_id: "REQ-2026-001",
      message:
        t?.("workflowRunConsole.exampleEventDescription") ??
        "Describe the event or work this workflow should process.",
      source: "workflow-run-console",
    };
  }
  if (type === "array") {
    if (schema.maxItems === 0) return [];
    const items = isRecord(schema.items) ? schema.items : {};
    const count = Math.min(
      3,
      Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 1),
    );
    return Array.from({ length: count }, (_, index) =>
      schemaExample(items, `${identifier}_${index + 1}`, "value", depth + 1, t),
    );
  }
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") {
    if (typeof schema.minimum === "number") return schema.minimum;
    if (typeof schema.exclusiveMinimum === "number") {
      return schema.exclusiveMinimum + (type === "integer" ? 1 : 0.1);
    }
    const normalized = identifier.toLowerCase();
    if (normalized.includes("amount") || normalized.includes("price")) {
      return 1250.5;
    }
    return type === "integer" ? 10 : 0.85;
  }
  if (type === "null") return null;

  const format = typeof schema.format === "string" ? schema.format : "";
  if (format === "date-time") return "2026-07-17T09:00:00Z";
  if (format === "date") return "2026-07-17";
  if (format === "time") return "09:00:00Z";
  if (format === "email") return "alex.morgan@example.com";
  if (format === "uuid") return "123e4567-e89b-12d3-a456-426614174000";
  if (format === "uri" || format === "url") {
    return "https://example.com/resources/record-001";
  }
  if (kind === "prompt") {
    return (
      t?.("workflowRunConsole.examplePrompt") ??
      "Review the supplied event, validate the data, and return the expected workflow result."
    );
  }
  return identifierExample(identifier, t);
}

export function workflowInputExampleValue(
  input: WorkflowRunInputDescriptor,
  t?: Translate,
): unknown {
  if (input.kind === "file") return input.file?.multiple ? [] : null;
  if (input.example !== undefined) return structuredClone(input.example);
  if (meaningfulExample(input.default)) return structuredClone(input.default);
  return schemaExample(
    input.schema as Record<string, unknown>,
    input.id,
    input.kind,
    0,
    t,
  );
}

export function workflowInputIsRuntimeProvided(
  input: WorkflowRunInputDescriptor,
): boolean {
  return (
    input.bindings.length > 0 &&
    input.bindings.every(
      (binding) => binding.mode === "constant" || binding.mode === "template",
    )
  );
}

export function workflowInputSchemaSummary(
  input: WorkflowRunInputDescriptor,
): string {
  if (input.kind === "file") {
    const mediaTypes = input.file?.media_types ?? [];
    return mediaTypes.length > 0
      ? `${input.file?.multiple ? "files" : "file"} · ${mediaTypes.join(" | ")}`
      : input.file?.multiple
        ? "files"
        : "file";
  }
  const schema = input.schema as Record<string, unknown>;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return `enum · ${schema.enum.map(String).join(" | ")}`;
  }
  const type =
    schemaType(schema) ?? (input.kind === "prompt" ? "string" : "value");
  if (type === "array" && isRecord(schema.items)) {
    return `array<${schemaType(schema.items) ?? "value"}>`;
  }
  return type;
}

function mergePayloadRecords(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    merged[key] =
      isRecord(merged[key]) && isRecord(value)
        ? mergePayloadRecords(merged[key], value)
        : structuredClone(value);
  }
  return merged;
}

function restrictedPathSegments(path: string): Array<string | number> | null {
  if (!path.startsWith("$") || path === "$") return [];
  const segments: Array<string | number> = [];
  let offset = 1;
  while (offset < path.length) {
    const rest = path.slice(offset);
    const property = rest.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/);
    const index = rest.match(/^\[(\d+)\]/);
    if (property) {
      const key = property[1]!;
      if (["__proto__", "prototype", "constructor"].includes(key)) return null;
      segments.push(key);
      offset += property[0].length;
      continue;
    }
    if (index) {
      segments.push(Number(index[1]));
      offset += index[0].length;
      continue;
    }
    return null;
  }
  return segments;
}

function setPayloadPath(
  payload: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (path === "$") {
    return isRecord(value) ? mergePayloadRecords(payload, value) : payload;
  }
  const segments = restrictedPathSegments(path);
  if (!segments || segments.length === 0 || typeof segments[0] === "number") {
    return payload;
  }
  const nextPayload = structuredClone(payload);
  let cursor: Record<string, unknown> | unknown[] = nextPayload;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const final = index === segments.length - 1;
    if (final) {
      if (Array.isArray(cursor) && typeof segment === "number") {
        cursor[segment] = structuredClone(value);
      } else if (!Array.isArray(cursor) && typeof segment === "string") {
        cursor[segment] = structuredClone(value);
      }
      break;
    }
    const following = segments[index + 1]!;
    const container: Record<string, unknown> | unknown[] =
      typeof following === "number" ? [] : {};
    if (Array.isArray(cursor) && typeof segment === "number") {
      if (!isRecord(cursor[segment]) && !Array.isArray(cursor[segment])) {
        cursor[segment] = container;
      }
      cursor = cursor[segment] as Record<string, unknown> | unknown[];
    } else if (!Array.isArray(cursor) && typeof segment === "string") {
      if (!isRecord(cursor[segment]) && !Array.isArray(cursor[segment])) {
        cursor[segment] = container;
      }
      cursor = cursor[segment] as Record<string, unknown> | unknown[];
    } else {
      return payload;
    }
  }
  return nextPayload;
}

function templateEventPaths(template: string): string[] {
  const paths = new Set<string>();
  const token = /{{\s*(?:json\s+)?event((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)\s*}}/g;
  for (const match of template.matchAll(token)) paths.add(`$${match[1]}`);
  return [...paths];
}

function templateBindingExample(
  input: WorkflowRunInputDescriptor,
  t?: Translate,
): string | undefined {
  const template = input.bindings.find(
    (binding) => binding.mode === "template" && binding.expression,
  )?.expression;
  if (!template) return undefined;
  return template.replace(
    /{{\s*(json\s+)?event((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)\s*}}/g,
    (_token, jsonPrefix: string | undefined, path: string) => {
      const identifier = path.split(".").filter(Boolean).at(-1) ?? input.id;
      const value = identifierExample(identifier, t);
      return jsonPrefix ? JSON.stringify(value) : value;
    },
  );
}

export function workflowInputDisplayExample(
  input: WorkflowRunInputDescriptor,
  t?: Translate,
): unknown {
  return (
    templateBindingExample(input, t) ?? workflowInputExampleValue(input, t)
  );
}

function guideLocations(
  input: WorkflowRunInputDescriptor,
  t?: Translate,
): string[] {
  const locations = new Set<string>();
  for (const binding of input.bindings) {
    if (binding.mode === "direct") {
      locations.add(
        t?.("workflowRunConsole.locationNamedInput", { id: input.id }) ??
          `named input · ${input.id}`,
      );
    } else if (binding.mode === "constant") {
      locations.add(
        t?.("workflowRunConsole.locationRuntimeConstant") ??
          "runtime constant · no value required",
      );
    } else if (binding.mode === "path" && binding.expression) {
      locations.add(binding.expression);
    } else if (binding.mode === "template") {
      const paths = binding.expression
        ? templateEventPaths(binding.expression)
        : [];
      if (paths.length > 0) {
        paths.forEach((path) =>
          locations.add(
            t?.("workflowRunConsole.locationTemplateReads", { path }) ??
              "template reads " + path,
          ),
        );
      } else {
        locations.add(
          t?.("workflowRunConsole.locationRuntimeTemplate") ??
            "runtime template",
        );
      }
    }
  }
  return [...locations];
}

/** Build a deterministic, caller-facing payload recipe from the entry contract. */
export function buildWorkflowPayloadGuide(
  entrypoint: WorkflowRunEntrypoint,
  t?: Translate,
): WorkflowPayloadGuide {
  const inputValues: Record<string, unknown> = {};
  let rawPayload: Record<string, unknown> = {};
  const fields: WorkflowPayloadFieldGuide[] = [];

  for (const input of entrypoint.inputs) {
    const runtimeProvided = workflowInputIsRuntimeProvided(input);
    const bindingExample = templateBindingExample(input, t);
    const example = workflowInputDisplayExample(input, t);
    if (!runtimeProvided && input.kind !== "file") {
      inputValues[input.id] = structuredClone(example);
    }
    for (const binding of input.bindings) {
      if (binding.mode === "path" && binding.expression) {
        rawPayload = setPayloadPath(rawPayload, binding.expression, example);
      }
      if (binding.mode === "template" && binding.expression) {
        for (const path of templateEventPaths(binding.expression)) {
          const segments = restrictedPathSegments(path) ?? [];
          const identifier = String(segments.at(-1) ?? input.id);
          rawPayload = setPayloadPath(
            rawPayload,
            path,
            identifierExample(identifier, t),
          );
        }
      }
    }
    fields.push({
      inputId: input.id,
      label: input.label,
      description: input.description,
      required: input.required,
      sensitivity: input.sensitivity,
      type: workflowInputSchemaSummary(input),
      locations: guideLocations(input, t),
      example,
      runtimeProvided,
      exampleSource:
        bindingExample !== undefined
          ? "binding generated"
          : input.example !== undefined
            ? "authored example"
            : meaningfulExample(input.default)
              ? "authored default"
              : "schema generated",
    });
  }

  return {
    inputValues,
    rawPayload,
    eventPayload: buildWorkflowEventPayload(inputValues, rawPayload),
    fields,
  };
}

export function workflowInputControl(
  input: WorkflowRunInputDescriptor,
): WorkflowInputControl {
  if (input.kind === "file") return "file";
  if (input.ui?.control) return input.ui.control;
  const schema = input.schema as Record<string, unknown>;
  if (Array.isArray(schema.enum)) return "select";
  if (schema.type === "boolean") return "checkbox";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "object" || schema.type === "array") return "json";
  if (typeof schema.maxLength === "number" && schema.maxLength > 240) {
    return "textarea";
  }
  return input.kind === "prompt" ? "textarea" : "text";
}

/**
 * Both the catalog templates and the AI generator write a mechanical prompt-port
 * default of the form `Process the incoming X event as Y.` It is a placeholder,
 * not a request anyone would actually type, so the Run console should look past
 * it for something derived from what the workflow is FOR.
 */
const GENERATED_PROMPT_BOILERPLATE =
  /^Process the incoming .+ event as .+\.$/;

export interface WorkflowPromptSeedContext {
  /** The workflow's stated purpose (WorkflowSummary.description). */
  workflowDescription?: string;
  /** Descriptions of the agents listening to the selected entry event. */
  agentDescriptions?: readonly string[];
}

/**
 * A starting request the operator can actually send, preferring real authored
 * data over invented text. Falls back through: authored example → a non-boilerplate
 * authored default → the workflow's own purpose → the entry agent's description →
 * the generic control default.
 */
export function seedWorkflowPromptValue(
  input: WorkflowRunInputDescriptor,
  ctx: WorkflowPromptSeedContext = {},
): unknown {
  if (input.example !== undefined) return structuredClone(input.example);
  if (
    typeof input.default === "string" &&
    input.default.trim() &&
    !GENERATED_PROMPT_BOILERPLATE.test(input.default.trim())
  ) {
    return input.default;
  }
  const purpose = ctx.workflowDescription?.trim();
  if (purpose) return purpose;
  const agentPurpose = ctx.agentDescriptions?.find((value) => value?.trim());
  if (agentPurpose) return agentPurpose.trim();
  if (input.default !== undefined) return structuredClone(input.default);
  return "";
}

export function seedWorkflowInputValue(
  input: WorkflowRunInputDescriptor,
  ctx?: WorkflowPromptSeedContext,
): unknown {
  // The prompt port is the one field a human actually writes, so it gets the
  // goal-derived ladder rather than the raw authored default.
  if (input.kind === "prompt") return seedWorkflowPromptValue(input, ctx);
  if (input.default !== undefined) return structuredClone(input.default);
  if (input.example !== undefined) return structuredClone(input.example);
  const schema = input.schema as Record<string, unknown>;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  switch (workflowInputControl(input)) {
    case "checkbox":
      return false;
    case "number":
      return "";
    case "json":
      return schema.type === "array" ? [] : {};
    case "file":
      return input.file?.multiple ? [] : null;
    default:
      return "";
  }
}

export function validateWorkflowInputValues(
  entrypoint: WorkflowRunEntrypoint | undefined,
  values: Record<string, unknown>,
  t?: Translate,
  includeConflicts = true,
): string[] {
  if (!entrypoint) {
    return [
      t?.("workflowRunConsole.selectEntryEvent") ?? "Select an entry event.",
    ];
  }
  const errors: string[] = [];
  for (const input of entrypoint.inputs) {
    const value = values[input.id];
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (input.required && empty) {
      errors.push(
        t?.("workflowRunConsole.inputRequired", { label: input.label }) ??
          `${input.label} is required.`,
      );
    }
    if (input.conflict && includeConflicts) {
      errors.push(
        t?.("workflowRunConsole.inputConflict", { label: input.label }) ??
          `${input.label} has conflicting listener schemas; verify the raw event payload.`,
      );
    }
  }
  return errors;
}

export function parseWorkflowTestLimits(
  values: {
    maxAgentRuns: string;
    maxEvents: string;
    maxDepth: string;
  },
  t?: Translate,
): WorkflowTestRunLimits {
  const limits = {
    maxAgentRuns: Number(values.maxAgentRuns),
    maxEvents: Number(values.maxEvents),
    maxDepth: Number(values.maxDepth),
  };
  const constraints = [
    {
      key: "maxAgentRuns" as const,
      label: t?.("workflowRunConsole.agentRuns") ?? "Agent runs",
      max: 100,
    },
    {
      key: "maxEvents" as const,
      label: t?.("workflowRunConsole.events") ?? "Events",
      max: 250,
    },
    {
      key: "maxDepth" as const,
      label: t?.("workflowRunConsole.depth") ?? "Depth",
      max: 50,
    },
  ];
  for (const constraint of constraints) {
    const value = limits[constraint.key];
    if (!Number.isInteger(value) || value < 1 || value > constraint.max) {
      throw new Error(
        t?.("workflowRunConsole.budgetRange", {
          label: constraint.label,
          max: constraint.max,
        }) ??
          `${constraint.label} budget must be a whole number from 1 to ${constraint.max}.`,
      );
    }
  }
  return limits;
}

/**
 * Preserve the production event contract used by trigger binding:
 * direct inputs remain available at the payload root, while the canonical
 * nested `inputs` object cannot be replaced by an advanced raw-payload edit.
 */
export function buildWorkflowEventPayload(
  inputs: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...inputs,
    ...payload,
    inputs: structuredClone(inputs),
  };
}
