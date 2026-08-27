import { z } from "zod";
import {
  AgentDefinitionV2Schema,
  AgentFilePolicySchema,
  AgentInputKindSchema,
  AgentPortUiSchema,
  AgentPromptProvenanceV2Schema,
  AgentSensitivitySchema,
  JsonSchemaSchema,
  WorkflowManifestV2Schema,
  type AgentDefinitionV2Input,
} from "./agent-definition";
import { ProviderIdSchema } from "./llm";

/** URL-safe, tenant-local workflow identifier. */
export const WorkflowSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "workflow slug must be lowercase kebab-case",
  );
export type WorkflowSlug = z.infer<typeof WorkflowSlugSchema>;

export const WorkflowModelSelectionSchema = z
  .object({
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
  })
  .refine(
    (value) => value.provider !== undefined || value.model !== undefined,
    {
      message: "provider or model is required",
    },
  );
export type WorkflowModelSelection = z.infer<
  typeof WorkflowModelSelectionSchema
>;

export const WorkflowTemplateSummarySchema = z.object({
  id: z.string().min(1).max(80),
  version: z.number().int().positive(),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2_000),
  category: z.enum(["starter", "operations", "support", "documents", "data"]),
  tags: z.array(z.string().min(1).max(60)).max(20),
  agentCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  hasHumanTask: z.boolean(),
});
export type WorkflowTemplateSummary = z.infer<
  typeof WorkflowTemplateSummarySchema
>;

export const WorkflowTemplateDetailSchema =
  WorkflowTemplateSummarySchema.extend({
    manifest: WorkflowManifestV2Schema,
  });
export type WorkflowTemplateDetail = z.infer<
  typeof WorkflowTemplateDetailSchema
>;

export const WorkflowTemplateCatalogResponseSchema = z.object({
  templates: z.array(WorkflowTemplateSummarySchema),
});

export const WorkflowStatusSchema = z.enum(["draft", "live", "superseded"]);

export const WorkflowSummarySchema = z.object({
  id: z.string(),
  slug: WorkflowSlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(4_000).default(""),
  status: WorkflowStatusSchema,
  latestVersionId: z.string(),
  latestVersion: z.string(),
  liveVersionId: z.string().nullable(),
  hasUnpublishedChanges: z.boolean(),
  agentCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

export const WorkflowVersionSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  status: WorkflowStatusSchema,
  agentCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  createdBy: z.string().nullable(),
});
export type WorkflowVersionSummary = z.infer<
  typeof WorkflowVersionSummarySchema
>;

export const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  manifest: WorkflowManifestV2Schema,
  actions: z.array(z.unknown()).nullable(),
  versions: z.array(WorkflowVersionSummarySchema),
});
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;

export const WorkflowListResponseSchema = z.object({
  workflows: z.array(WorkflowSummarySchema),
});

const BlankWorkflowSourceSchema = z.object({
  type: z.literal("blank"),
});

const TemplateWorkflowSourceSchema = z.object({
  type: z.literal("template"),
  templateId: z.string().trim().min(1).max(80),
});

const CloneWorkflowSourceSchema = z.object({
  type: z.literal("clone"),
  workflowSlug: WorkflowSlugSchema,
  versionId: z.string().trim().min(1).optional(),
});

const ManifestWorkflowSourceSchema = z.object({
  type: z.literal("manifest"),
  manifest: z.unknown(),
  actions: z.array(z.unknown()).optional(),
});

export const WorkflowCreateSourceSchema = z.discriminatedUnion("type", [
  BlankWorkflowSourceSchema,
  TemplateWorkflowSourceSchema,
  CloneWorkflowSourceSchema,
  ManifestWorkflowSourceSchema,
]);
export type WorkflowCreateSource = z.infer<typeof WorkflowCreateSourceSchema>;

export const CreateWorkflowBodySchema = z.object({
  slug: WorkflowSlugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4_000).optional().default(""),
  source: WorkflowCreateSourceSchema,
  model: WorkflowModelSelectionSchema.optional(),
});
export type CreateWorkflowBody = z.infer<typeof CreateWorkflowBodySchema>;

export const SaveWorkflowBodySchema = z.object({
  baseVersionId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(4_000).optional(),
  manifest: z.unknown(),
  /** Omit to retain the prior revision's external actions payload. */
  actions: z.array(z.unknown()).nullable().optional(),
});
export type SaveWorkflowBody = z.infer<typeof SaveWorkflowBodySchema>;

export const ValidateWorkflowBodySchema = z
  .object({
    manifest: z.unknown().optional(),
    versionId: z.string().trim().min(1).optional(),
  })
  .default({});
export type ValidateWorkflowBody = z.infer<typeof ValidateWorkflowBodySchema>;

export const PublishWorkflowBodySchema = z
  .object({
    versionId: z.string().trim().min(1).optional(),
    note: z.string().trim().max(500).optional(),
    /**
     * A tenant has exactly one live workflow deployment, so publishing a
     * manifest that drops an agent removes it from the live runtime. The
     * import pipeline's `overwriteGuard` answers 409 with the removal diff
     * unless the operator has seen it and re-submitted with this flag.
     */
    confirmOverwrite: z.boolean().optional().default(false),
  })
  .default({ confirmOverwrite: false });
export type PublishWorkflowBody = z.infer<typeof PublishWorkflowBodySchema>;

export const WorkflowValidationIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
});
export type WorkflowValidationIssue = z.infer<
  typeof WorkflowValidationIssueSchema
>;

export const WorkflowPromptScoreSchema = z.object({
  agentId: z.string(),
  score: z.number().int().min(0).max(11),
  required: z.number().int().positive(),
  missing: z.array(z.string()),
  /**
   * Sections that are structurally present but say nothing. `score` counts
   * headings, which a prompt template supplies for free; this is the part an
   * author has to earn.
   */
  weak: z.array(z.string()).default([]),
});
export type WorkflowPromptScore = z.infer<typeof WorkflowPromptScoreSchema>;

/**
 * Canonical value produced when a durable Human/manual action is resolved.
 *
 * Keeping the data contract and its runtime JSON Schema together prevents
 * generated workflow output ports from drifting away from the value emitted
 * by `packages/runtime/src/register.ts`.
 */
export const WorkflowManualTaskDecisionSchema = z.enum([
  "approve",
  "reject",
  "supplement",
]);
export type WorkflowManualTaskDecision = z.infer<
  typeof WorkflowManualTaskDecisionSchema
>;

export const WorkflowManualTaskOutcomeSchema = z.enum([
  "approved",
  "rejected",
  "supplemented",
]);
export type WorkflowManualTaskOutcome = z.infer<
  typeof WorkflowManualTaskOutcomeSchema
>;

export const WorkflowManualTaskResolutionSchema = z
  .object({
    task_id: z.string().min(1),
    status: z.literal("resolved"),
    decision: WorkflowManualTaskDecisionSchema,
    outcome: WorkflowManualTaskOutcomeSchema,
    payload: z.unknown(),
  })
  .strict();
export type WorkflowManualTaskResolution = z.infer<
  typeof WorkflowManualTaskResolutionSchema
>;

export const WORKFLOW_MANUAL_TASK_RESOLUTION_JSON_SCHEMA = {
  type: "object",
  required: ["task_id", "status", "decision", "outcome", "payload"],
  properties: {
    task_id: { type: "string", minLength: 1 },
    status: { type: "string", const: "resolved" },
    decision: {
      type: "string",
      enum: ["approve", "reject", "supplement"],
    },
    outcome: {
      type: "string",
      enum: ["approved", "rejected", "supplemented"],
    },
    // The authored form_schema validates operator input at the task boundary.
    // The durable resolution envelope deliberately permits any JSON payload,
    // including null when the operator supplied no supplemental fields.
    payload: {},
  },
  additionalProperties: false,
} as const;

/** Complete output-port contract shared by every generated Human agent. */
export function workflowManualTaskResolutionOutputContract(
  emittedEvents: readonly string[],
): Pick<
  AgentDefinitionV2Input,
  "outputs" | "output_config" | "output_bindings"
> {
  return {
    outputs: [
      {
        id: "decision",
        label: "Decision",
        required: true,
        schema: structuredClone(WORKFLOW_MANUAL_TASK_RESOLUTION_JSON_SCHEMA),
        sensitivity: "confidential",
      },
    ],
    output_config: {
      format: "json",
      strict: true,
      repair_attempts: 0,
      // The runtime's canonical manual resolution is the single output value;
      // wrapping it again as `{ decision: resolution }` before validation
      // would make the manual producer and its output port disagree.
      unwrap_single_output: true,
    },
    output_bindings: Object.fromEntries(
      emittedEvents.map((event) => [
        event,
        { decision: { output: "decision" } },
      ]),
    ),
  };
}

export const WorkflowValidationResponseSchema = z.object({
  valid: z.boolean(),
  versionId: z.string().nullable(),
  manifestHash: z.string().length(64),
  issues: z.array(WorkflowValidationIssueSchema),
  promptScores: z.array(WorkflowPromptScoreSchema),
});
export type WorkflowValidationResponse = z.infer<
  typeof WorkflowValidationResponseSchema
>;

export const WorkflowDocumentDiagnosticSchema = z.object({
  path: z.string(),
  status: z.enum(["included", "skipped", "truncated", "failed"]),
  bytes: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  reason: z.string().optional(),
});
export type WorkflowDocumentDiagnostic = z.infer<
  typeof WorkflowDocumentDiagnosticSchema
>;

export const WorkflowDocumentFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
});
export type WorkflowDocumentFolder = z.infer<
  typeof WorkflowDocumentFolderSchema
>;

export const WorkflowDocumentFoldersResponseSchema = z.object({
  rootAvailable: z.boolean(),
  truncated: z.boolean(),
  folders: z.array(WorkflowDocumentFolderSchema),
});
export type WorkflowDocumentFoldersResponse = z.infer<
  typeof WorkflowDocumentFoldersResponseSchema
>;

export const WorkflowDocumentExtractionSchema = z.object({
  folder: z.string(),
  filesSeen: z.number().int().nonnegative(),
  filesIncluded: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  totalCharacters: z.number().int().nonnegative(),
  truncated: z.boolean(),
  diagnostics: z.array(WorkflowDocumentDiagnosticSchema),
});
export type WorkflowDocumentExtraction = z.infer<
  typeof WorkflowDocumentExtractionSchema
>;

export const GenerateWorkflowBodySchema = z.object({
  purpose: z.string().trim().min(20).max(12_000),
  documentFolder: z.string().max(500).optional(),
  webResearch: z.boolean().optional().default(false),
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(240).optional(),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(30).default([]),
  expectedOutputs: z
    .array(z.string().trim().min(1).max(1_000))
    .max(30)
    .default([]),
});
export type GenerateWorkflowBody = z.infer<typeof GenerateWorkflowBodySchema>;

export const WorkflowGenerationSourceSchema = z.object({
  kind: z.enum(["document", "research"]),
  title: z.string(),
  reference: z.string(),
  query: z.string().optional(),
  snippet: z.string().optional(),
  publishedAt: z.string().nullable().optional(),
});
export type WorkflowGenerationSource = z.infer<
  typeof WorkflowGenerationSourceSchema
>;

export const GenerateWorkflowResponseSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  manifest: WorkflowManifestV2Schema,
  validation: WorkflowValidationResponseSchema,
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  warnings: z.array(z.string()),
  sources: z.array(WorkflowGenerationSourceSchema),
  documents: WorkflowDocumentExtractionSchema.nullable(),
  modelSelection: z.object({
    provider: ProviderIdSchema,
    model: z.string(),
    source: z.enum(["explicit", "workspace_default"]),
  }),
  usage: z.object({
    tokensIn: z.number().int().nonnegative().nullable(),
    tokensOut: z.number().int().nonnegative().nullable(),
  }),
});
export type GenerateWorkflowResponse = z.infer<
  typeof GenerateWorkflowResponseSchema
>;

// ─── Enterprise workflow run console ──────────────────────────────────────

export const WorkflowRunProfileTargetSchema = z.enum(["latest", "live"]);
export type WorkflowRunProfileTarget = z.infer<
  typeof WorkflowRunProfileTargetSchema
>;

export const WorkflowRunToolPolicySchema = z.enum(["safe", "simulate", "live"]);
export type WorkflowRunToolPolicy = z.infer<typeof WorkflowRunToolPolicySchema>;

export const WorkflowRunFailurePolicySchema = z.enum(["continue", "fail_fast"]);
export type WorkflowRunFailurePolicy = z.infer<
  typeof WorkflowRunFailurePolicySchema
>;

export const WorkflowRunInputBindingSchema = z.object({
  agentId: z.string(),
  mode: z.enum(["direct", "path", "template", "constant"]),
  expression: z.string().optional(),
});
export type WorkflowRunInputBinding = z.infer<
  typeof WorkflowRunInputBindingSchema
>;

export const WorkflowRunInputDescriptorSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  kind: AgentInputKindSchema,
  required: z.boolean(),
  schema: JsonSchemaSchema,
  default: z.unknown().optional(),
  example: z.unknown().optional(),
  sensitivity: AgentSensitivitySchema,
  ui: AgentPortUiSchema.optional(),
  file: AgentFilePolicySchema.optional(),
  consumers: z.array(z.string()),
  bindings: z.array(WorkflowRunInputBindingSchema),
  conflict: z.boolean(),
});
export type WorkflowRunInputDescriptor = z.infer<
  typeof WorkflowRunInputDescriptorSchema
>;

export const WorkflowRunEntrypointSchema = z.object({
  event: z.string(),
  source: z.enum(["external", "internal"]),
  recommended: z.boolean(),
  listenerAgentIds: z.array(z.string()),
  listenerTitles: z.array(z.string()),
  inputs: z.array(WorkflowRunInputDescriptorSchema),
  requiresRawPayload: z.boolean(),
});
export type WorkflowRunEntrypoint = z.infer<typeof WorkflowRunEntrypointSchema>;

export const WorkflowRunProfileSchema = z.object({
  workflowSlug: WorkflowSlugSchema,
  target: WorkflowRunProfileTargetSchema,
  versionId: z.string(),
  version: z.string(),
  isLive: z.boolean(),
  manifestHash: z.string().length(64),
  entrypoints: z.array(WorkflowRunEntrypointSchema),
  warnings: z.array(z.string()),
});
export type WorkflowRunProfile = z.infer<typeof WorkflowRunProfileSchema>;

export const WorkflowTestRunLimitsSchema = z
  .object({
    maxAgentRuns: z.number().int().min(1).max(100).default(25),
    maxEvents: z.number().int().min(1).max(250).default(75),
    maxDepth: z.number().int().min(1).max(50).default(12),
  })
  .default({
    maxAgentRuns: 25,
    maxEvents: 75,
    maxDepth: 12,
  });
export type WorkflowTestRunLimits = z.infer<typeof WorkflowTestRunLimitsSchema>;

export const WorkflowTestRunBodySchema = z
  .object({
    manifest: z.unknown(),
    triggerEvent: z.string().trim().min(1).max(160),
    subject: z.string().trim().min(1).max(500).optional(),
    inputs: z.record(z.string(), z.unknown()).default({}),
    payload: z.record(z.string(), z.unknown()).default({}),
    toolPolicy: WorkflowRunToolPolicySchema.default("safe"),
    confirmLiveEffects: z.boolean().default(false),
    failurePolicy: WorkflowRunFailurePolicySchema.default("continue"),
    humanDecision: WorkflowManualTaskDecisionSchema.default("approve"),
    humanPayload: z.unknown().optional(),
    limits: WorkflowTestRunLimitsSchema,
    /**
     * Prior turns of a chat-style draft run, supplied by the caller. The draft
     * test runner is deliberately stateless (it writes no run, step or message
     * rows), so continuity lives in the request rather than the database.
     * Bounded server-side as well — never trust the client's length.
     */
    conversationHistory: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().max(8_000),
        }),
      )
      .max(20)
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.toolPolicy === "live" && value.confirmLiveEffects !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmLiveEffects"],
        message: "live tool effects require explicit confirmation",
      });
    }
  });
export type WorkflowTestRunBody = z.infer<typeof WorkflowTestRunBodySchema>;

export const WorkflowTestStepResultSchema = z.object({
  id: z.string(),
  order: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.enum(["ok", "failed", "skipped", "blocked"]),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  input: z.unknown(),
  output: z.unknown(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  branchTarget: z.string().nullable(),
  simulation: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable(),
});
export type WorkflowTestStepResult = z.infer<
  typeof WorkflowTestStepResultSchema
>;

export const WorkflowTestEmissionSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  outputPortIds: z.array(z.string()),
});
export type WorkflowTestEmission = z.infer<typeof WorkflowTestEmissionSchema>;

export const WorkflowTestAgentRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  agentTitle: z.string(),
  actor: z.enum(["Agent", "Human"]),
  status: z.enum(["ok", "failed", "blocked"]),
  depth: z.number().int().nonnegative(),
  triggerEventId: z.string(),
  triggerEvent: z.string(),
  subject: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  inputs: z.record(z.string(), z.unknown()),
  output: z.unknown(),
  outputValid: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  steps: z.array(WorkflowTestStepResultSchema),
  emissions: z.array(WorkflowTestEmissionSchema),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable(),
});
export type WorkflowTestAgentRun = z.infer<typeof WorkflowTestAgentRunSchema>;

export const WorkflowTestEventRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  depth: z.number().int().nonnegative(),
  subject: z.string().nullable(),
  sourceAgentRunId: z.string().nullable(),
  parentEventId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  consumerAgentIds: z.array(z.string()),
  terminal: z.boolean(),
});
export type WorkflowTestEventRecord = z.infer<
  typeof WorkflowTestEventRecordSchema
>;

export const WorkflowTestTerminalOutputSchema = z.object({
  agentRunId: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  output: z.unknown(),
  emittedEvents: z.array(z.string()),
});
export type WorkflowTestTerminalOutput = z.infer<
  typeof WorkflowTestTerminalOutputSchema
>;

export const WorkflowTestRunResponseSchema = z.object({
  runId: z.string(),
  workflowSlug: WorkflowSlugSchema,
  mode: z.literal("draft_test"),
  status: z.enum(["ok", "failed", "partial"]),
  manifestHash: z.string().length(64),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  trigger: z.object({
    event: z.string(),
    subject: z.string().nullable(),
    inputs: z.record(z.string(), z.unknown()),
    payload: z.record(z.string(), z.unknown()),
  }),
  policy: z.object({
    toolPolicy: WorkflowRunToolPolicySchema,
    failurePolicy: WorkflowRunFailurePolicySchema,
    humanDecision: WorkflowManualTaskDecisionSchema,
    limits: WorkflowTestRunLimitsSchema,
  }),
  summary: z.object({
    agentRuns: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    terminalEvents: z.number().int().nonnegative(),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
  }),
  agentRuns: z.array(WorkflowTestAgentRunSchema),
  events: z.array(WorkflowTestEventRecordSchema),
  terminalOutputs: z.array(WorkflowTestTerminalOutputSchema),
  warnings: z.array(z.string()),
});
export type WorkflowTestRunResponse = z.infer<
  typeof WorkflowTestRunResponseSchema
>;

// ─── Proposal-based prompt generation from the workflow editor ────────────

export const WorkflowAgentPromptBodySchema = z.object({
  definition: AgentDefinitionV2Schema,
  mode: z.enum(["generate", "improve", "shorten", "add_guardrails"]),
  instructions: z
    .string()
    .max(128 * 1024)
    .optional(),
  selectedText: z
    .string()
    .max(128 * 1024)
    .optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(240).optional(),
});
export type WorkflowAgentPromptBody = z.infer<
  typeof WorkflowAgentPromptBodySchema
>;

export const WorkflowAgentPromptResponseSchema = z.object({
  proposedInstructions: z
    .string()
    .min(1)
    .max(128 * 1024),
  explanation: z
    .string()
    .max(16 * 1024)
    .optional(),
  provenance: AgentPromptProvenanceV2Schema,
});
export type WorkflowAgentPromptResponse = z.infer<
  typeof WorkflowAgentPromptResponseSchema
>;
