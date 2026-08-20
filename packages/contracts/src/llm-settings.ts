/**
 * Versioned, secret-free contracts for AI model routing and settings.
 *
 * A gateway instance is deliberately not a `ProviderId`. `ProviderId` is the
 * legacy, closed list of built-in adapter families; `GatewayInstanceId` is a
 * runtime-configurable connection name such as `openrouter`, `newapi`, or
 * `newapi-csi`. A canonical model route splits on its first slash only:
 *
 *   openrouter/openai/gpt-5.6-sol
 *   ^ gateway   ^ provider-native model id (slashes are preserved)
 */

import { z } from "zod";
import {
  PROVIDER_IDS,
  catalogModelPolicy,
  findCatalogModel,
  type CatalogModel,
  type ProviderId,
} from "./providers";
import { ReasoningConfigSchema, TextVerbositySchema } from "./llm";

const GATEWAY_INSTANCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TASK_CLASS_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const CREDENTIAL_REFERENCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const MODEL_ID_CHARACTERS = /^[A-Za-z0-9._:+@/-]+$/;

export const GatewayInstanceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    GATEWAY_INSTANCE_ID_PATTERN,
    "gateway instance id must be a lowercase kebab-case identifier",
  )
  .brand<"GatewayInstanceId">();
export type GatewayInstanceId = z.infer<typeof GatewayInstanceIdSchema>;

export const ProviderNativeModelIdSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    if (value !== value.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "model id must not have leading or trailing whitespace",
      });
    }
    if (!MODEL_ID_CHARACTERS.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: "model id contains unsupported characters",
      });
    }
    const segments = value.split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9]/.test(segment),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "model id path segments must be non-empty, safe, and start with a letter or number",
      });
    }
  })
  .brand<"ProviderNativeModelId">();
export type ProviderNativeModelId = z.infer<typeof ProviderNativeModelIdSchema>;

function validateModelRouteString(value: string): {
  gatewayInstanceId: GatewayInstanceId;
  modelId: ProviderNativeModelId;
} {
  if (value !== value.trim()) {
    throw new Error("model route must not have surrounding whitespace");
  }
  if (value.length > 577) {
    throw new Error("model route is too long");
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      "model route must use <gateway-instance>/<provider-native-model-id>",
    );
  }
  return {
    gatewayInstanceId: GatewayInstanceIdSchema.parse(value.slice(0, separator)),
    modelId: ProviderNativeModelIdSchema.parse(value.slice(separator + 1)),
  };
}

export const ModelRouteIdSchema = z
  .string()
  .min(3)
  .max(577)
  .superRefine((value, ctx) => {
    try {
      validateModelRouteString(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
  .brand<"ModelRouteId">();
export type ModelRouteId = z.infer<typeof ModelRouteIdSchema>;

export interface ParsedModelRouteId {
  id: ModelRouteId;
  gatewayInstanceId: GatewayInstanceId;
  modelId: ProviderNativeModelId;
}

/** Parse a canonical route, splitting only the first slash. */
export function parseModelRouteId(value: string): ParsedModelRouteId {
  const parts = validateModelRouteString(value);
  return {
    id: ModelRouteIdSchema.parse(`${parts.gatewayInstanceId}/${parts.modelId}`),
    ...parts,
  };
}

export function formatModelRouteId(
  gatewayInstanceId: string,
  modelId: string,
): ModelRouteId {
  const gateway = GatewayInstanceIdSchema.parse(gatewayInstanceId);
  const model = ProviderNativeModelIdSchema.parse(modelId);
  return ModelRouteIdSchema.parse(`${gateway}/${model}`);
}

export const GatewayInstanceKindSchema = z.enum([
  "direct",
  "openrouter",
  "newapi",
  "openai-compatible",
  "mock",
]);
export type GatewayInstanceKind = z.infer<typeof GatewayInstanceKindSchema>;

export const GatewayApiModeSchema = z.enum([
  "auto",
  "chat-completions",
  "responses",
]);
export type GatewayApiMode = z.infer<typeof GatewayApiModeSchema>;

/**
 * Wire-level request dialect for compatible gateways. This is deliberately
 * configured on the gateway instance instead of inferred from a model prefix:
 * a NewAPI deployment may remap any upstream model name.
 */
export const GatewayWireDialectSchema = z.enum([
  "auto",
  "openai-chat",
  "openrouter",
  "moonshot",
  "zai",
  "deepseek",
  "unsupported",
]);
export type GatewayWireDialect = z.infer<typeof GatewayWireDialectSchema>;

export const GatewayInstanceCapabilitiesSchema = z
  .object({
    modelDiscovery: z.boolean().optional(),
    chatCompletions: z.boolean().optional(),
    responses: z.boolean().optional(),
    anthropicMessages: z.boolean().optional(),
  })
  .strict();
export type GatewayInstanceCapabilities = z.infer<
  typeof GatewayInstanceCapabilitiesSchema
>;

export const GatewayTimeoutPolicySchema = z
  .object({
    connectTimeoutMs: z.number().int().positive().max(120_000).optional(),
    requestTimeoutMs: z.number().int().positive().max(7_200_000).optional(),
    maxRequestTimeoutMs: z.number().int().positive().max(7_200_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.requestTimeoutMs !== undefined &&
      value.maxRequestTimeoutMs !== undefined &&
      value.requestTimeoutMs > value.maxRequestTimeoutMs
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["requestTimeoutMs"],
        message: "requestTimeoutMs must not exceed maxRequestTimeoutMs",
      });
    }
  });
export type GatewayTimeoutPolicy = z.infer<typeof GatewayTimeoutPolicySchema>;

export const GatewayRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(5).default(1),
    baseBackoffMs: z.number().int().min(0).max(30_000).default(250),
  })
  .strict();
export type GatewayRetryPolicy = z.infer<typeof GatewayRetryPolicySchema>;

const HttpBaseUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "baseUrl must use http or https and must not contain credentials, a query, or a fragment");

/**
 * Public gateway configuration. Secrets cannot enter this schema: callers
 * may only store an opaque credential reference resolved by the API vault.
 */
export const GatewayInstanceSchema = z
  .object({
    id: GatewayInstanceIdSchema,
    displayName: z.string().trim().min(1).max(120),
    kind: GatewayInstanceKindSchema,
    /** Legacy built-in provider family for a direct adapter only. */
    providerId: z.enum(PROVIDER_IDS).optional(),
    baseUrl: HttpBaseUrlSchema.optional(),
    credentialRef: z.string().regex(CREDENTIAL_REFERENCE_PATTERN).optional(),
    credentialScope: z.enum(["workspace", "tenant"]).optional(),
    enabled: z.boolean().default(true),
    apiMode: GatewayApiModeSchema.default("auto"),
    dialect: GatewayWireDialectSchema.default("auto"),
    capabilities: GatewayInstanceCapabilitiesSchema.optional(),
    timeouts: GatewayTimeoutPolicySchema.optional(),
    retry: GatewayRetryPolicySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "direct" && value.providerId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["providerId"],
        message: "direct gateway instances require a legacy providerId",
      });
    }
    if (value.kind !== "direct" && value.providerId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["providerId"],
        message: "providerId is only valid for direct gateway instances",
      });
    }
    if (
      (value.kind === "newapi" || value.kind === "openai-compatible") &&
      value.baseUrl === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: `${value.kind} gateway instances require baseUrl`,
      });
    }
    if (value.kind === "mock" && value.credentialRef !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "mock gateway instances must not reference credentials",
      });
    }
  });
export type GatewayInstance = z.infer<typeof GatewayInstanceSchema>;

/** Provider family remains a separate, closed compatibility type. */
export type GatewayDirectProviderId = ProviderId;

export const TaskClassIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    TASK_CLASS_ID_PATTERN,
    "task class must be a lowercase dotted identifier",
  )
  .brand<"TaskClassId">();
export type TaskClassId = z.infer<typeof TaskClassIdSchema>;

export const TaskClassDefinitionSchema = z
  .object({
    id: TaskClassIdSchema,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000).optional(),
    parent: TaskClassIdSchema.optional(),
    aliases: z.array(TaskClassIdSchema).default([]),
  })
  .strict();
export type TaskClassDefinition = z.infer<typeof TaskClassDefinitionSchema>;

export const TaskTaxonomySchema = z
  .array(TaskClassDefinitionSchema)
  .min(1)
  .max(256)
  .superRefine((definitions, ctx) => {
    const ids = new Map<string, number>();
    const aliases = new Map<string, number>();
    for (const [index, definition] of definitions.entries()) {
      if (ids.has(definition.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `duplicate task class: ${definition.id}`,
        });
      } else {
        ids.set(definition.id, index);
      }
      for (const alias of definition.aliases) {
        if (alias === definition.id) {
          ctx.addIssue({
            code: "custom",
            path: [index, "aliases"],
            message: "a task class cannot alias itself",
          });
        }
        if (aliases.has(alias)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "aliases"],
            message: `duplicate task alias: ${alias}`,
          });
        } else {
          aliases.set(alias, index);
        }
      }
    }

    for (const [index, definition] of definitions.entries()) {
      if (definition.parent !== undefined && !ids.has(definition.parent)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "parent"],
          message: `unknown parent task class: ${definition.parent}`,
        });
      }
      for (const alias of definition.aliases) {
        if (ids.has(alias)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "aliases"],
            message: `task alias conflicts with a canonical task class: ${alias}`,
          });
        }
      }
    }

    const byId = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    for (const [index, definition] of definitions.entries()) {
      const visited = new Set<string>([definition.id]);
      let parent = definition.parent;
      while (parent !== undefined) {
        if (visited.has(parent)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "parent"],
            message: `task taxonomy cycle detected at ${parent}`,
          });
          break;
        }
        visited.add(parent);
        parent = byId.get(parent)?.parent;
      }
    }
  });
export type TaskTaxonomy = z.infer<typeof TaskTaxonomySchema>;

export const CORE_LLM_TASK_TAXONOMY: TaskTaxonomy = TaskTaxonomySchema.parse([
  { id: "default", label: "Default" },
  { id: "generation", label: "Generation", parent: "default" },
  {
    id: "ontology.generate",
    label: "Ontology generation",
    parent: "generation",
    aliases: ["ontology_generation"],
  },
  {
    id: "ontogene.generate",
    label: "OntoGene generation",
    parent: "ontology.generate",
    aliases: ["ontogene"],
  },
  { id: "evaluation", label: "Evaluation", parent: "default" },
  {
    id: "evaluation.run",
    label: "Run evaluation",
    parent: "evaluation",
    aliases: ["evaluate"],
  },
  { id: "chat.respond", label: "Chat", parent: "default", aliases: ["chat"] },
  {
    id: "assistant.suggest",
    label: "AI suggestion",
    parent: "chat.respond",
    aliases: ["ai.suggestion"],
  },
  { id: "query", label: "Query", parent: "default" },
  {
    id: "graph.query",
    label: "Graph Engine query",
    parent: "query",
    aliases: ["graph_engine.query"],
  },
  {
    id: "ontology.query",
    label: "Ontology query",
    parent: "graph.query",
  },
  { id: "extract", label: "Structured extraction", parent: "default" },
  {
    id: "file.parse",
    label: "File parsing",
    parent: "extract",
    aliases: ["file.parsing"],
  },
  {
    id: "output.repair",
    label: "Output repair",
    parent: "extract",
    aliases: ["manifest.output-repair", "agent-runtime.output-repair"],
  },
  {
    id: "workflow.generate",
    label: "Workflow generation",
    parent: "generation",
  },
  {
    id: "agent.author",
    label: "Agent authoring",
    parent: "generation",
    aliases: ["agent-authoring", "studio.instruction-authoring"],
  },
  {
    /**
     * The Agent Factory brain. It shares the generation routing family, but
     * not the identity: billing it as `agent.author` made every usage view
     * report Factory reasoning as portal agent-authoring traffic.
     */
    id: "factory.brain",
    label: "Agent Factory reasoning",
    parent: "generation",
  },
  { id: "research", label: "Research", parent: "default" },
  { id: "classify", label: "Classification", parent: "evaluation" },
  {
    id: "tool.loop",
    label: "Tool-use loop",
    parent: "default",
    aliases: ["manifest.logic", "code-agent"],
  },
]);

export const TaskWorkloadProfileSchema = z.enum([
  "quality",
  "balanced",
  "fast",
  "low-cost",
  "structured",
  "long-context",
  "tool-use",
]);
export type TaskWorkloadProfile = z.infer<typeof TaskWorkloadProfileSchema>;

export const TaskCapabilityRequirementsSchema = z
  .object({
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    minimumContextTokens: z.number().int().positive().optional(),
  })
  .strict();
export type TaskCapabilityRequirements = z.infer<
  typeof TaskCapabilityRequirementsSchema
>;

/** Omitted fields mean “use the model/provider default”. */
export const TaskModelParametersSchema = z
  .object({
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(1_048_576).optional(),
    timeoutMs: z.number().int().positive().max(7_200_000).optional(),
    overallDeadlineMs: z.number().int().positive().max(7_200_000).optional(),
    jsonMode: z.boolean().optional(),
    store: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.timeoutMs !== undefined &&
      value.overallDeadlineMs !== undefined &&
      value.timeoutMs > value.overallDeadlineMs
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["timeoutMs"],
        message: "timeoutMs must not exceed overallDeadlineMs",
      });
    }
  });
export type TaskModelParameters = z.infer<typeof TaskModelParametersSchema>;

export const RouteFallbackConditionSchema = z.enum([
  "rate_limit",
  "timeout",
  "network",
  "provider_error",
  "not_configured",
  "auth",
  "model_not_found",
]);
export type RouteFallbackCondition = z.infer<
  typeof RouteFallbackConditionSchema
>;

/**
 * Optional behavioral family hint used for capability/default selection only.
 * It is never a billing-provider identity; accounting uses resolved catalog
 * and gateway metadata.
 */
export const ModelFamilyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
    "model family must be a lowercase dotted or kebab-case identifier",
  )
  .brand<"ModelFamilyId">();
export type ModelFamilyId = z.infer<typeof ModelFamilyIdSchema>;

export const TaskRouteCandidateSchema = z
  .object({
    route: ModelRouteIdSchema,
    label: z.string().trim().min(1).max(120).optional(),
    modelFamily: ModelFamilyIdSchema.optional(),
    enabled: z.boolean().default(true),
    parameters: TaskModelParametersSchema.optional(),
    fallbackOn: z.array(RouteFallbackConditionSchema).max(7).optional(),
  })
  .strict();
export type TaskRouteCandidate = z.infer<typeof TaskRouteCandidateSchema>;

const RoutingProfileFields = {
  description: z.string().trim().min(1).max(1_000).optional(),
  enabled: z.boolean().default(true),
  workload: TaskWorkloadProfileSchema.default("balanced"),
  requirements: TaskCapabilityRequirementsSchema.optional(),
  parameters: TaskModelParametersSchema.optional(),
  candidates: z.array(TaskRouteCandidateSchema).min(1).max(16),
} as const;

export const TaskRoutingProfileSchema = z
  .object({
    taskClass: TaskClassIdSchema,
    ...RoutingProfileFields,
  })
  .strict()
  .superRefine((profile, ctx) => {
    validateCandidateList(profile.candidates, ctx);
  });
export type TaskRoutingProfile = z.infer<typeof TaskRoutingProfileSchema>;

export const DefaultTaskRoutingProfileSchema = z
  .object(RoutingProfileFields)
  .strict()
  .superRefine((profile, ctx) => {
    validateCandidateList(profile.candidates, ctx);
  });
export type DefaultTaskRoutingProfile = z.infer<
  typeof DefaultTaskRoutingProfileSchema
>;

function validateCandidateList(
  candidates: TaskRouteCandidate[],
  ctx: z.RefinementCtx,
): void {
  const routes = new Set<string>();
  let enabled = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (routes.has(candidate.route)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidates", index, "route"],
        message: `duplicate model route: ${candidate.route}`,
      });
    }
    routes.add(candidate.route);
    if (candidate.enabled) enabled += 1;
  }
  if (enabled === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "a routing profile requires at least one enabled candidate",
    });
  }
}

export const LLM_SETTINGS_SCHEMA_VERSION = 1 as const;

/**
 * One effective workspace/tenant snapshot. API keys and arbitrary secret
 * headers are intentionally impossible to represent here.
 */
export const LlmSettingsV1Schema = z
  .object({
    schemaVersion: z.literal(LLM_SETTINGS_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    gatewayInstances: z.array(GatewayInstanceSchema).min(1).max(64),
    taxonomy: TaskTaxonomySchema.default(CORE_LLM_TASK_TAXONOMY),
    defaultProfile: DefaultTaskRoutingProfileSchema,
    taskProfiles: z.array(TaskRoutingProfileSchema).max(256).default([]),
  })
  .strict()
  .superRefine((settings, ctx) => {
    const gatewayIds = new Set<string>();
    for (const [index, gateway] of settings.gatewayInstances.entries()) {
      if (gatewayIds.has(gateway.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["gatewayInstances", index, "id"],
          message: `duplicate gateway instance: ${gateway.id}`,
        });
      }
      gatewayIds.add(gateway.id);
    }

    const profileIds = new Set<string>();
    for (const [index, profile] of settings.taskProfiles.entries()) {
      if (profile.taskClass === "default") {
        ctx.addIssue({
          code: "custom",
          path: ["taskProfiles", index, "taskClass"],
          message: "use defaultProfile for the default task class",
        });
      }
      if (profileIds.has(profile.taskClass)) {
        ctx.addIssue({
          code: "custom",
          path: ["taskProfiles", index, "taskClass"],
          message: `duplicate task routing profile: ${profile.taskClass}`,
        });
      }
      profileIds.add(profile.taskClass);
    }

    const profiles: Array<{
      path: Array<string | number>;
      candidates: TaskRouteCandidate[];
    }> = [
      {
        path: ["defaultProfile"],
        candidates: settings.defaultProfile.candidates,
      },
      ...settings.taskProfiles.map((profile, index) => ({
        path: ["taskProfiles", index],
        candidates: profile.candidates,
      })),
    ];
    for (const profile of profiles) {
      for (const [candidateIndex, candidate] of profile.candidates.entries()) {
        const route = parseModelRouteId(candidate.route);
        if (!gatewayIds.has(route.gatewayInstanceId)) {
          ctx.addIssue({
            code: "custom",
            path: [...profile.path, "candidates", candidateIndex, "route"],
            message: `model route references unknown gateway instance: ${route.gatewayInstanceId}`,
          });
        }
      }
    }
  });
export type LlmSettingsV1 = z.infer<typeof LlmSettingsV1Schema>;
export type LlmSettingsV1Input = z.input<typeof LlmSettingsV1Schema>;

/** Alias reserved for a future versioned union. */
export const LlmSettingsSchema = LlmSettingsV1Schema;
export type LlmSettings = LlmSettingsV1;
export type LlmSettingsInput = LlmSettingsV1Input;

/**
 * An ordered, caller-supplied model preference (strongest wish first).
 *
 * This is a RANKING HINT, never an authorization: entries are matched against
 * the model ids the routing policy already allows, so a preference can only
 * reorder that set — it can never introduce a model the workspace/tenant did
 * not enable. Callers that route by task difficulty (the Agent Factory's
 * fast/default/hard/review tiers) express difficulty here; the policy remains
 * the boundary. Each entry is matched case-insensitively as a regular
 * expression, falling back to a literal substring when it is not valid regex,
 * so both pinned model ids and family patterns work.
 */
export const ModelPreferenceSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(16);
export type ModelPreference = z.infer<typeof ModelPreferenceSchema>;

export const RoutingResolutionRequestSchema = z
  .object({
    taskClass: TaskClassIdSchema.default(TaskClassIdSchema.parse("default")),
    explicitRoute: ModelRouteIdSchema.optional(),
    modelPreference: ModelPreferenceSchema.optional(),
  })
  .strict();
export type RoutingResolutionRequest = z.infer<
  typeof RoutingResolutionRequestSchema
>;
export type RoutingResolutionRequestInput = z.input<
  typeof RoutingResolutionRequestSchema
>;

export const RoutingMatchTypeSchema = z.enum([
  "explicit",
  "exact",
  "alias",
  "parent",
  "default",
]);
export type RoutingMatchType = z.infer<typeof RoutingMatchTypeSchema>;

export const RoutingTraceStageSchema = z.enum([
  "explicit",
  "exact",
  "alias",
  "parent",
  "default",
  "candidate",
]);
export const RoutingTraceOutcomeSchema = z.enum([
  "miss",
  "skipped",
  "eligible",
  "selected",
]);

export const RoutingTraceStepSchema = z
  .object({
    stage: RoutingTraceStageSchema,
    outcome: RoutingTraceOutcomeSchema,
    taskClass: TaskClassIdSchema.optional(),
    route: ModelRouteIdSchema.optional(),
    message: z.string(),
  })
  .strict();
export type RoutingTraceStep = z.infer<typeof RoutingTraceStepSchema>;

/**
 * What became of a caller's model preference. Present only when one was
 * expressed; `satisfied:false` is a first-class, explained outcome — the
 * caller asked for a stronger/cheaper class of model than the policy allows
 * and must be told, not quietly served something else.
 */
export const ModelPreferenceOutcomeSchema = z
  .object({
    requested: ModelPreferenceSchema,
    satisfied: z.boolean(),
    matchedRoute: ModelRouteIdSchema.nullable(),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type ModelPreferenceOutcome = z.infer<
  typeof ModelPreferenceOutcomeSchema
>;

export const ResolvedLlmRoutingSchema = z
  .object({
    settingsRevision: z.number().int().nonnegative(),
    requestedTaskClass: TaskClassIdSchema,
    matchedTaskClass: TaskClassIdSchema.nullable(),
    matchType: RoutingMatchTypeSchema,
    selectedCandidate: TaskRouteCandidateSchema,
    candidates: z.array(TaskRouteCandidateSchema).min(1),
    modelPreference: ModelPreferenceOutcomeSchema.nullable().default(null),
    effectiveParameters: TaskModelParametersSchema,
    workload: TaskWorkloadProfileSchema,
    requirements: TaskCapabilityRequirementsSchema.nullable(),
    explanation: z.string(),
    trace: z.array(RoutingTraceStepSchema),
  })
  .strict();
export type ResolvedLlmRouting = z.infer<typeof ResolvedLlmRoutingSchema>;

export type LlmRoutingResolutionErrorCode =
  | "explicit_gateway_not_found"
  | "explicit_gateway_disabled"
  | "explicit_model_not_selectable"
  | "no_eligible_route";

export class LlmRoutingResolutionError extends Error {
  override readonly name = "LlmRoutingResolutionError";

  constructor(
    readonly code: LlmRoutingResolutionErrorCode,
    message: string,
    readonly trace: RoutingTraceStep[],
  ) {
    super(message);
  }
}

interface ProfileSelection {
  profile: TaskRoutingProfile | DefaultTaskRoutingProfile;
  matchedTaskClass: TaskClassId | null;
  matchType: Exclude<RoutingMatchType, "explicit">;
  candidates: TaskRouteCandidate[];
}

function mergeTaskModelParameters(
  base: TaskModelParameters | undefined,
  override: TaskModelParameters | undefined,
): TaskModelParameters {
  const merged: TaskModelParameters = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  if (base?.reasoning || override?.reasoning) {
    merged.reasoning = {
      ...(base?.reasoning ?? {}),
      ...(override?.reasoning ?? {}),
    };
  }
  return TaskModelParametersSchema.parse(merged);
}

function eligibleCandidates(
  settings: LlmSettings,
  profile: TaskRoutingProfile | DefaultTaskRoutingProfile,
  taskClass: TaskClassId | undefined,
  trace: RoutingTraceStep[],
): TaskRouteCandidate[] {
  const gatewayById = new Map(
    settings.gatewayInstances.map((gateway) => [gateway.id, gateway]),
  );
  const eligible: TaskRouteCandidate[] = [];
  for (const candidate of profile.candidates) {
    if (!candidate.enabled) {
      trace.push({
        stage: "candidate",
        outcome: "skipped",
        ...(taskClass ? { taskClass } : {}),
        route: candidate.route,
        message: "Candidate is disabled.",
      });
      continue;
    }
    const parsed = parseModelRouteId(candidate.route);
    const gateway = gatewayById.get(parsed.gatewayInstanceId);
    if (!gateway?.enabled) {
      trace.push({
        stage: "candidate",
        outcome: "skipped",
        ...(taskClass ? { taskClass } : {}),
        route: candidate.route,
        message: gateway
          ? `Gateway instance ${gateway.id} is disabled.`
          : `Gateway instance ${parsed.gatewayInstanceId} is not configured.`,
      });
      continue;
    }
    const lifecycleFailure = candidateLifecycleFailure(gateway, candidate);
    if (lifecycleFailure) {
      trace.push({
        stage: "candidate",
        outcome: "skipped",
        ...(taskClass ? { taskClass } : {}),
        route: candidate.route,
        message: lifecycleFailure,
      });
      continue;
    }
    const capabilityFailure = candidateCapabilityFailure(
      gateway,
      candidate,
      profile.requirements,
    );
    if (capabilityFailure) {
      trace.push({
        stage: "candidate",
        outcome: "skipped",
        ...(taskClass ? { taskClass } : {}),
        route: candidate.route,
        message: capabilityFailure,
      });
      continue;
    }
    eligible.push(candidate);
    trace.push({
      stage: "candidate",
      outcome: "eligible",
      ...(taskClass ? { taskClass } : {}),
      route: candidate.route,
      message: "Candidate is eligible.",
    });
  }
  return eligible;
}

function candidateLifecycleFailure(
  gateway: GatewayInstance,
  candidate: TaskRouteCandidate,
): string | null {
  const model = catalogModelForCandidate(gateway, candidate);
  if (!model) return null;
  const policy = catalogModelPolicy(model);
  return policy.selectable
    ? null
    : `Candidate is not selectable under model lifecycle policy (${policy.reason}).`;
}

function candidateCapabilityFailure(
  gateway: GatewayInstance,
  candidate: TaskRouteCandidate,
  requirements: TaskCapabilityRequirements | undefined,
): string | null {
  if (!requirements) return null;
  const model = catalogModelForCandidate(gateway, candidate);
  // Compatible gateways can remap arbitrary IDs. Unknown capability data is
  // therefore not treated as a negative; the provider remains authoritative.
  if (!model) return null;
  if (requirements.vision && !model.vision) {
    return "Candidate does not satisfy the required vision capability.";
  }
  if (requirements.tools && !model.tools) {
    return "Candidate does not satisfy the required tool-use capability.";
  }
  if (requirements.reasoning && !model.reasoning) {
    return "Candidate does not satisfy the required reasoning capability.";
  }
  if (
    requirements.minimumContextTokens !== undefined &&
    model.ctx < requirements.minimumContextTokens
  ) {
    return `Candidate context window ${model.ctx} is below the required ${requirements.minimumContextTokens} tokens.`;
  }
  // The catalog has no universal structured-output flag. Keep the route
  // eligible and let the adapter/provider validate that requirement.
  return null;
}

const MODEL_FAMILY_PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  openai: "openai",
  anthropic: "anthropic",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  kimi: "moonshot",
  zai: "zai",
  "z-ai": "zai",
  zhipu: "zai",
  glm: "zai",
  deepseek: "deepseek",
  openrouter: "openrouter",
};

/** Resolve a behavioral family hint without treating it as billing identity. */
export function providerIdForModelFamily(
  modelFamily: string | undefined,
): ProviderId | undefined {
  if (!modelFamily) return undefined;
  const normalized = modelFamily.toLowerCase();
  return (
    MODEL_FAMILY_PROVIDER_ALIASES[normalized] ??
    MODEL_FAMILY_PROVIDER_ALIASES[normalized.split(/[.-]/)[0] ?? ""]
  );
}

/**
 * Resolve the provider family used only for model capabilities and compatible
 * wire controls. It must not be used as an upstream account or price source.
 */
export function behavioralProviderForCandidate(
  gateway: GatewayInstance,
  candidate: TaskRouteCandidate,
): ProviderId | undefined {
  if (gateway.kind === "direct") return gateway.providerId;
  if (gateway.kind === "openrouter") return "openrouter";

  const family = providerIdForModelFamily(candidate.modelFamily);
  if (family) return family;
  if (
    gateway.dialect !== "auto" &&
    gateway.dialect !== "openai-chat" &&
    gateway.dialect !== "unsupported"
  ) {
    return gateway.dialect;
  }

  // NewAPI model ids commonly retain a vendor namespace. This is a
  // behavioral fallback only; NewAPI channel ownership and pricing remain
  // authoritative and are never inferred from this prefix.
  const modelId = String(parseModelRouteId(candidate.route).modelId);
  return providerIdForModelFamily(modelId.split("/")[0]);
}

export function catalogModelForCandidate(
  gateway: GatewayInstance,
  candidate: TaskRouteCandidate,
): CatalogModel | undefined {
  const provider = behavioralProviderForCandidate(gateway, candidate);
  if (!provider) return undefined;
  const parsed = parseModelRouteId(candidate.route);
  let modelId = String(parsed.modelId);
  if (provider !== "openrouter" && modelId.includes("/")) {
    modelId = modelId.slice(modelId.lastIndexOf("/") + 1);
  }
  return findCatalogModel(provider, modelId);
}

function closestTaxonomyDefinition(
  requested: TaskClassId,
  taxonomy: TaskTaxonomy,
): TaskClassDefinition | undefined {
  const exact = taxonomy.find((definition) => definition.id === requested);
  if (exact) return exact;
  return [...taxonomy]
    .filter((definition) => requested.startsWith(`${definition.id}.`))
    .sort((left, right) => right.id.length - left.id.length)[0];
}

function parentChain(
  requested: TaskClassId,
  aliasTarget: TaskClassDefinition | undefined,
  taxonomy: TaskTaxonomy,
): TaskClassId[] {
  const byId = new Map(
    taxonomy.map((definition) => [definition.id, definition]),
  );
  const nearest = aliasTarget ?? closestTaxonomyDefinition(requested, taxonomy);
  const out: TaskClassId[] = [];
  const seen = new Set<string>([requested]);

  // The alias target was already attempted at the alias stage. For a dotted
  // extension, however, the nearest canonical task is the first parent match.
  if (!aliasTarget && nearest && nearest.id !== requested) {
    out.push(nearest.id);
    seen.add(nearest.id);
  }
  let parent = nearest?.parent;
  while (parent !== undefined && !seen.has(parent)) {
    if (parent !== "default") out.push(parent);
    seen.add(parent);
    parent = byId.get(parent)?.parent;
  }

  // Custom task classes without a taxonomy entry still get deterministic
  // dotted-name ancestry (`customer.file.parse` -> `customer.file`).
  if (!nearest) {
    const segments = requested.split(".");
    while (segments.length > 1) {
      segments.pop();
      const candidate = TaskClassIdSchema.parse(segments.join("."));
      if (!seen.has(candidate) && candidate !== "default") {
        out.push(candidate);
        seen.add(candidate);
      }
    }
  }
  return out;
}

function tryProfile(
  settings: LlmSettings,
  profile: TaskRoutingProfile | undefined,
  taskClass: TaskClassId,
  stage: "exact" | "alias" | "parent",
  matchType: "exact" | "alias" | "parent",
  trace: RoutingTraceStep[],
): ProfileSelection | null {
  if (!profile) {
    trace.push({
      stage,
      outcome: "miss",
      taskClass,
      message: `No routing profile is configured for ${taskClass}.`,
    });
    return null;
  }
  if (!profile.enabled) {
    trace.push({
      stage,
      outcome: "skipped",
      taskClass,
      message: `Routing profile ${taskClass} is disabled.`,
    });
    return null;
  }
  const candidates = eligibleCandidates(settings, profile, taskClass, trace);
  if (candidates.length === 0) {
    trace.push({
      stage,
      outcome: "skipped",
      taskClass,
      message: `Routing profile ${taskClass} has no eligible candidates.`,
    });
    return null;
  }
  trace.push({
    stage,
    outcome: "selected",
    taskClass,
    route: candidates[0]!.route,
    message: `Selected routing profile ${taskClass}.`,
  });
  return {
    profile,
    matchedTaskClass: taskClass,
    matchType,
    candidates,
  };
}

/**
 * Rank the ALREADY-ELIGIBLE candidates by the caller's model preference.
 *
 * The eligible set is the policy boundary and is never changed here: no
 * candidate is added, none is removed. Matches are hoisted in preference order
 * (stably, so equally-ranked candidates keep their configured order) and the
 * unmatched remainder stays behind as fallbacks. When nothing matches, the
 * configured order is returned untouched and the outcome says so — the caller
 * is told its difficulty preference could not be met rather than being handed
 * a different model as if it were the one requested.
 */
function preferenceMatcher(entry: string): (modelId: string) => boolean {
  let expression: RegExp | null = null;
  try {
    expression = new RegExp(entry, "i");
  } catch {
    expression = null; // Not valid regex — fall back to a literal contains.
  }
  const literal = entry.toLowerCase();
  return (modelId) =>
    expression
      ? expression.test(modelId)
      : modelId.toLowerCase().includes(literal);
}

function applyModelPreference(
  candidates: TaskRouteCandidate[],
  preference: ModelPreference,
  trace: RoutingTraceStep[],
): { candidates: TaskRouteCandidate[]; outcome: ModelPreferenceOutcome } {
  const ranked = candidates.map((candidate, index) => {
    const modelId = String(parseModelRouteId(candidate.route).modelId);
    const rank = preference.findIndex((entry) =>
      preferenceMatcher(entry)(modelId),
    );
    return { candidate, index, rank: rank < 0 ? Number.MAX_SAFE_INTEGER : rank };
  });
  const ordered = [...ranked].sort(
    (left, right) => left.rank - right.rank || left.index - right.index,
  );
  const best = ordered[0]!;
  const satisfied = best.rank !== Number.MAX_SAFE_INTEGER;
  const reason = satisfied
    ? `Model preference entry ${preference[best.rank]} matched allowed route ${best.candidate.route}.`
    : `No allowed candidate matched the model preference (${preference.join(", ")}); kept the configured order and selected ${best.candidate.route}.`;
  trace.push({
    stage: "candidate",
    outcome: satisfied ? "selected" : "skipped",
    route: best.candidate.route,
    message: reason,
  });
  return {
    candidates: ordered.map((entry) => entry.candidate),
    outcome: ModelPreferenceOutcomeSchema.parse({
      requested: preference,
      satisfied,
      matchedRoute: satisfied ? best.candidate.route : null,
      reason,
    }),
  };
}

function finalizeResolution(
  settings: LlmSettings,
  requestedTaskClass: TaskClassId,
  selection: ProfileSelection,
  trace: RoutingTraceStep[],
  preference: ModelPreference | undefined,
): ResolvedLlmRouting {
  const preferred = preference?.length
    ? applyModelPreference(selection.candidates, preference, trace)
    : null;
  const candidates = preferred?.candidates ?? selection.candidates;
  const selectedCandidate = candidates[0]!;
  const matched = selection.matchedTaskClass;
  const explanation =
    selection.matchType === "exact"
      ? `Task ${requestedTaskClass} matched its exact routing profile and selected ${selectedCandidate.route}.`
      : selection.matchType === "alias"
        ? `Task ${requestedTaskClass} matched alias ${matched} and selected ${selectedCandidate.route}.`
        : selection.matchType === "parent"
          ? `Task ${requestedTaskClass} used nearest parent profile ${matched} and selected ${selectedCandidate.route}.`
          : `Task ${requestedTaskClass} used the default routing profile and selected ${selectedCandidate.route}.`;
  const preferenceNote = preferred ? ` ${preferred.outcome.reason}` : "";
  return ResolvedLlmRoutingSchema.parse({
    settingsRevision: settings.revision,
    requestedTaskClass,
    matchedTaskClass: matched,
    matchType: selection.matchType,
    selectedCandidate,
    candidates,
    modelPreference: preferred?.outcome ?? null,
    effectiveParameters: mergeTaskModelParameters(
      selection.profile.parameters,
      selectedCandidate.parameters,
    ),
    workload: selection.profile.workload,
    requirements: selection.profile.requirements ?? null,
    explanation: `${explanation}${preferenceNote}`,
    trace,
  });
}

/**
 * Resolve a model route without invoking another model. Precedence is fixed:
 * explicit route, exact task profile, alias, nearest parent, then default.
 */
export function resolveLlmRouting(
  settingsInput: LlmSettingsV1Input,
  requestInput: RoutingResolutionRequestInput,
): ResolvedLlmRouting {
  const settings = LlmSettingsSchema.parse(settingsInput);
  const request = RoutingResolutionRequestSchema.parse(requestInput);
  const trace: RoutingTraceStep[] = [];

  if (request.explicitRoute) {
    const route = parseModelRouteId(request.explicitRoute);
    const gateway = settings.gatewayInstances.find(
      (candidate) => candidate.id === route.gatewayInstanceId,
    );
    if (!gateway) {
      trace.push({
        stage: "explicit",
        outcome: "skipped",
        taskClass: request.taskClass,
        route: route.id,
        message: `Gateway instance ${route.gatewayInstanceId} is not configured.`,
      });
      throw new LlmRoutingResolutionError(
        "explicit_gateway_not_found",
        trace[0]!.message,
        trace,
      );
    }
    if (!gateway.enabled) {
      trace.push({
        stage: "explicit",
        outcome: "skipped",
        taskClass: request.taskClass,
        route: route.id,
        message: `Gateway instance ${route.gatewayInstanceId} is disabled.`,
      });
      throw new LlmRoutingResolutionError(
        "explicit_gateway_disabled",
        trace[0]!.message,
        trace,
      );
    }
    const selectedCandidate = TaskRouteCandidateSchema.parse({
      route: route.id,
    });
    const lifecycleFailure = candidateLifecycleFailure(
      gateway,
      selectedCandidate,
    );
    if (lifecycleFailure) {
      trace.push({
        stage: "explicit",
        outcome: "skipped",
        taskClass: request.taskClass,
        route: route.id,
        message: lifecycleFailure,
      });
      throw new LlmRoutingResolutionError(
        "explicit_model_not_selectable",
        lifecycleFailure,
        trace,
      );
    }
    trace.push({
      stage: "explicit",
      outcome: "selected",
      taskClass: request.taskClass,
      route: route.id,
      message: "Selected the explicit model route.",
    });
    return ResolvedLlmRoutingSchema.parse({
      settingsRevision: settings.revision,
      requestedTaskClass: request.taskClass,
      matchedTaskClass: request.taskClass,
      matchType: "explicit",
      selectedCandidate,
      candidates: [selectedCandidate],
      // An operator pinning one route outranks any caller ranking hint, but the
      // caller is still told its preference was not what decided this call.
      modelPreference: request.modelPreference?.length
        ? ModelPreferenceOutcomeSchema.parse({
            requested: request.modelPreference,
            satisfied: false,
            matchedRoute: null,
            reason: `An explicit model route (${route.id}) overrides the requested model preference.`,
          })
        : null,
      effectiveParameters: {},
      workload: "balanced",
      requirements: null,
      explanation: `Explicit route ${route.id} overrides task routing for ${request.taskClass}.`,
      trace,
    });
  }

  const profileByTask = new Map(
    settings.taskProfiles.map((profile) => [profile.taskClass, profile]),
  );
  const exact = tryProfile(
    settings,
    profileByTask.get(request.taskClass),
    request.taskClass,
    "exact",
    "exact",
    trace,
  );
  if (exact) {
    return finalizeResolution(
      settings,
      request.taskClass,
      exact,
      trace,
      request.modelPreference,
    );
  }

  const aliasTarget = settings.taxonomy.find((definition) =>
    definition.aliases.includes(request.taskClass),
  );
  if (aliasTarget) {
    const aliased = tryProfile(
      settings,
      profileByTask.get(aliasTarget.id),
      aliasTarget.id,
      "alias",
      "alias",
      trace,
    );
    if (aliased) {
      return finalizeResolution(
        settings,
        request.taskClass,
        aliased,
        trace,
        request.modelPreference,
      );
    }
  } else {
    trace.push({
      stage: "alias",
      outcome: "miss",
      taskClass: request.taskClass,
      message: `No task alias matched ${request.taskClass}.`,
    });
  }

  for (const parent of parentChain(
    request.taskClass,
    aliasTarget,
    settings.taxonomy,
  )) {
    const nearest = tryProfile(
      settings,
      profileByTask.get(parent),
      parent,
      "parent",
      "parent",
      trace,
    );
    if (nearest) {
      return finalizeResolution(
        settings,
        request.taskClass,
        nearest,
        trace,
        request.modelPreference,
      );
    }
  }

  const defaultCandidates = settings.defaultProfile.enabled
    ? eligibleCandidates(settings, settings.defaultProfile, undefined, trace)
    : [];
  if (defaultCandidates.length === 0) {
    trace.push({
      stage: "default",
      outcome: "skipped",
      message: settings.defaultProfile.enabled
        ? "The default routing profile has no eligible candidates."
        : "The default routing profile is disabled.",
    });
    throw new LlmRoutingResolutionError(
      "no_eligible_route",
      "no eligible LLM route is configured",
      trace,
    );
  }
  trace.push({
    stage: "default",
    outcome: "selected",
    route: defaultCandidates[0]!.route,
    message: "Selected the default routing profile.",
  });
  return finalizeResolution(
    settings,
    request.taskClass,
    {
      profile: settings.defaultProfile,
      matchedTaskClass: null,
      matchType: "default",
      candidates: defaultCandidates,
    },
    trace,
    request.modelPreference,
  );
}
