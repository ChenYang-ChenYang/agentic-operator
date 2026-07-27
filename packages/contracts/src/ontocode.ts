import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(160);
const OptionalIdentifierSchema = IdentifierSchema.nullable();
const TimestampSchema = z.number().int().nonnegative();
const RevisionSchema = z.number().int().positive();
const IdempotencyKeySchema = z.string().trim().min(8).max(256);
const Sha256Schema = z
  .string()
  .trim()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const OntoCodeSessionPhaseSchema = z.enum([
  "intake",
  "scope",
  "configure",
  "blueprint",
  "build",
  "verify",
  "debug",
  "review",
  "release",
  "observe",
  "completed",
]);
export type OntoCodeSessionPhase = z.infer<typeof OntoCodeSessionPhaseSchema>;

export const OntoCodeSessionActivitySchema = z.enum([
  "idle",
  "ai_planning",
  "queued",
  "running",
  "needs_user",
  "blocked_external",
  "review_required",
  "failed_recoverable",
  "paused",
  "cancelled",
]);
export type OntoCodeSessionActivity = z.infer<
  typeof OntoCodeSessionActivitySchema
>;

export const OntoCodeAutonomyModeSchema = z.enum([
  "guide",
  "copilot",
  "sandbox_autopilot",
]);
export type OntoCodeAutonomyMode = z.infer<typeof OntoCodeAutonomyModeSchema>;

export const OntoCodeMessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
]);
export const OntoCodeMessageTypeSchema = z.enum([
  "text",
  "recommendation",
  "decision",
  "configuration",
  "receipt",
  "error",
]);

export const OntoCodeCommandTypeSchema = z.enum([
  "analyze_scope",
  "propose_blueprint",
  "create_configuration_task",
  "verify_configuration",
  "generate_package",
  "patch_artifact",
  "generate_tests",
  "run_tests",
  "debug_failure",
  "compare_candidate",
  "prepare_release",
  "deploy_release",
]);
export type OntoCodeCommandType = z.infer<typeof OntoCodeCommandTypeSchema>;

export const OntoCodeRiskClassSchema = z.enum([
  "read_only",
  "draft_change",
  "sandbox_effect",
  "external_reversible",
  "external_irreversible",
  "production_deploy",
]);
export type OntoCodeRiskClass = z.infer<typeof OntoCodeRiskClassSchema>;

export const OntoCodeCommandStatusSchema = z.enum([
  "proposed",
  "awaiting_approval",
  "approved",
  "rejected",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const OntoCodeHarnessJobKindSchema = z.enum([
  "scope",
  "blueprint",
  "build",
  "simulation",
  "test",
  "debug",
  "regression",
  "promotion",
  "deploy",
  "production_analysis",
]);
export type OntoCodeHarnessJobKind = z.infer<
  typeof OntoCodeHarnessJobKindSchema
>;

export const OntoCodeHarnessJobStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "waiting_user",
  "retry_scheduled",
  "failed_recoverable",
  "failed_terminal",
  "cancelled",
  "succeeded",
]);

export const OntoCodeEventVisibilitySchema = z.enum(["user", "debug", "audit"]);

export const OntoCodeProjectSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    ontologyDomainRegistrationId: OptionalIdentifierSchema,
    runtimeProfileVersionId: OptionalIdentifierSchema,
    domain: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(4_000).nullable(),
    activePackageVersionId: OptionalIdentifierSchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeProject = z.infer<typeof OntoCodeProjectSchema>;

export const OntoCodeBuildSessionSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    runtimeProfileVersionId: OptionalIdentifierSchema,
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(20_000),
    phase: OntoCodeSessionPhaseSchema,
    activityState: OntoCodeSessionActivitySchema,
    autonomyMode: OntoCodeAutonomyModeSchema,
    revision: RevisionSchema,
    ontologySnapshotHash: Sha256Schema.nullable(),
    basePackageVersionId: OptionalIdentifierSchema,
    environmentProfileVersionId: OptionalIdentifierSchema,
    ownerUserId: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeBuildSession = z.infer<typeof OntoCodeBuildSessionSchema>;

export const OntoCodeMessageSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sessionId: IdentifierSchema,
    role: OntoCodeMessageRoleSchema,
    type: OntoCodeMessageTypeSchema,
    content: JsonObjectSchema,
    commandId: OptionalIdentifierSchema,
    correlationId: IdentifierSchema,
    idempotencyKey: z.string().nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
export type OntoCodeMessage = z.infer<typeof OntoCodeMessageSchema>;

export const OntoCodeCommandSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sessionId: IdentifierSchema,
    type: OntoCodeCommandTypeSchema,
    arguments: JsonObjectSchema,
    expectedSessionRevision: RevisionSchema,
    baseOntologyHash: Sha256Schema.nullable(),
    basePackageVersionId: OptionalIdentifierSchema,
    affectedSemanticPaths: z.array(z.string().trim().min(1).max(1_000)),
    riskClass: OntoCodeRiskClassSchema,
    requestedCapabilities: z.array(z.string().trim().min(1).max(200)),
    status: OntoCodeCommandStatusSchema,
    requiresHuman: z.boolean(),
    rationaleSummary: z.string().trim().min(1).max(4_000),
    idempotencyKey: IdempotencyKeySchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeCommand = z.infer<typeof OntoCodeCommandSchema>;

export const OntoCodeHarnessBudgetSchema = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
    maxModelCalls: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
  })
  .strict();
export type OntoCodeHarnessBudget = z.infer<typeof OntoCodeHarnessBudgetSchema>;

/**
 * A Candidate Test Case is durable job input. The Harness may enrich it with
 * generated assertions later, but it may never fabricate an empty event
 * payload for an external trigger.
 */
export const OntoCodeCandidateTestCaseSchema = z
  .object({
    id: IdentifierSchema,
    entryEvent: z.string().trim().min(1).max(240),
    payload: JsonObjectSchema,
    kind: z.enum(["pass", "reject", "edge", "fault"]),
    expectedEvent: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
export type OntoCodeCandidateTestCase = z.infer<
  typeof OntoCodeCandidateTestCaseSchema
>;

/**
 * The server-side execution policy is intentionally a single exhaustive
 * mapping. Chat turns derive command/job security fields from it and direct
 * Harness Job creation uses the same mapping to reject incompatible Commands.
 */
export const ONTOCODE_COMMAND_POLICY = {
  analyze_scope: {
    commandType: "analyze_scope",
    jobKind: "scope",
    riskClass: "read_only",
    requiresHuman: false,
    budget: { maxWallClockMs: 60_000, maxModelCalls: 4, maxToolCalls: 8 },
  },
  propose_blueprint: {
    commandType: "propose_blueprint",
    jobKind: "blueprint",
    riskClass: "draft_change",
    requiresHuman: false,
    budget: { maxWallClockMs: 120_000, maxModelCalls: 8, maxToolCalls: 16 },
  },
  create_configuration_task: {
    commandType: "create_configuration_task",
    jobKind: "blueprint",
    riskClass: "draft_change",
    requiresHuman: false,
    budget: { maxWallClockMs: 60_000, maxModelCalls: 4, maxToolCalls: 8 },
  },
  verify_configuration: {
    commandType: "verify_configuration",
    jobKind: "simulation",
    riskClass: "read_only",
    requiresHuman: false,
    budget: { maxWallClockMs: 90_000, maxModelCalls: 4, maxToolCalls: 12 },
  },
  generate_package: {
    commandType: "generate_package",
    jobKind: "build",
    riskClass: "draft_change",
    requiresHuman: false,
    budget: { maxWallClockMs: 600_000, maxModelCalls: 10, maxToolCalls: 24 },
  },
  patch_artifact: {
    commandType: "patch_artifact",
    jobKind: "build",
    riskClass: "draft_change",
    requiresHuman: false,
    budget: { maxWallClockMs: 120_000, maxModelCalls: 8, maxToolCalls: 20 },
  },
  generate_tests: {
    commandType: "generate_tests",
    jobKind: "test",
    riskClass: "draft_change",
    requiresHuman: false,
    budget: { maxWallClockMs: 120_000, maxModelCalls: 8, maxToolCalls: 16 },
  },
  run_tests: {
    commandType: "run_tests",
    jobKind: "test",
    riskClass: "sandbox_effect",
    requiresHuman: false,
    budget: { maxWallClockMs: 180_000, maxModelCalls: 6, maxToolCalls: 24 },
  },
  debug_failure: {
    commandType: "debug_failure",
    jobKind: "debug",
    riskClass: "draft_change",
    requiresHuman: false,
    budget: { maxWallClockMs: 180_000, maxModelCalls: 12, maxToolCalls: 30 },
  },
  compare_candidate: {
    commandType: "compare_candidate",
    jobKind: "regression",
    riskClass: "read_only",
    requiresHuman: false,
    budget: { maxWallClockMs: 120_000, maxModelCalls: 8, maxToolCalls: 20 },
  },
  prepare_release: {
    commandType: "prepare_release",
    jobKind: "promotion",
    riskClass: "external_reversible",
    requiresHuman: true,
    budget: { maxWallClockMs: 120_000, maxModelCalls: 6, maxToolCalls: 16 },
  },
  deploy_release: {
    commandType: "deploy_release",
    jobKind: "deploy",
    riskClass: "production_deploy",
    requiresHuman: true,
    budget: { maxWallClockMs: 300_000, maxModelCalls: 8, maxToolCalls: 24 },
  },
} as const satisfies Record<
  OntoCodeCommandType,
  {
    commandType: OntoCodeCommandType;
    jobKind: OntoCodeHarnessJobKind;
    riskClass: OntoCodeRiskClass;
    requiresHuman: boolean;
    budget: OntoCodeHarnessBudget;
  }
>;

export const OntoCodeTurnBehaviorSchema = z.enum([
  "navigate",
  "explain",
  "execute",
  "clarify",
]);
export type OntoCodeTurnBehavior = z.infer<typeof OntoCodeTurnBehaviorSchema>;

// An action is user intent, not trusted execution metadata. The server looks
// it up in ONTOCODE_COMMAND_POLICY to derive command type, job kind and limits.
export const OntoCodeTurnActionSchema = OntoCodeCommandTypeSchema;
export type OntoCodeTurnAction = z.infer<typeof OntoCodeTurnActionSchema>;

export const OntoCodeHarnessJobSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sessionId: IdentifierSchema,
    commandId: OptionalIdentifierSchema,
    runtimeProfileVersionId: OptionalIdentifierSchema,
    kind: OntoCodeHarnessJobKindSchema,
    status: OntoCodeHarnessJobStatusSchema,
    inputHash: Sha256Schema.nullable(),
    budget: OntoCodeHarnessBudgetSchema.nullable(),
    candidatePackageVersionId: OptionalIdentifierSchema,
    candidateDependencyRoot: Sha256Schema.nullable(),
    candidateHeadId: OptionalIdentifierSchema,
    candidateHeadRevision: RevisionSchema.nullable(),
    testCases: z.array(OntoCodeCandidateTestCaseSchema).max(500),
    idempotencyKey: IdempotencyKeySchema,
    errorMessage: z.string().max(8_000).nullable(),
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeHarnessJob = z.infer<typeof OntoCodeHarnessJobSchema>;

export const OntoCodeSessionEventSchema = z
  .object({
    id: IdentifierSchema,
    seq: z.number().int().positive(),
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    harnessJobId: OptionalIdentifierSchema,
    commandId: OptionalIdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: OptionalIdentifierSchema,
    type: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/)
      .max(200),
    visibility: OntoCodeEventVisibilitySchema,
    payload: JsonObjectSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type OntoCodeSessionEvent = z.infer<typeof OntoCodeSessionEventSchema>;

const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const CreateOntoCodeProjectRequestSchema = z
  .object({
    domain: z.string().trim().min(1).max(160),
    ontologyDomainRegistrationId: IdentifierSchema.optional(),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4_000).optional(),
  })
  .strict();
export type CreateOntoCodeProjectRequest = z.infer<
  typeof CreateOntoCodeProjectRequestSchema
>;

export const ListOntoCodeProjectsQuerySchema = PaginationQuerySchema.extend({
  domain: z.string().trim().min(1).max(160).optional(),
  search: z.string().trim().min(1).max(160).optional(),
}).strict();

export const OntoCodeProjectCreateReceiptSchema = z
  .object({
    project: OntoCodeProjectSchema,
    // There is exactly one long-lived OntoCode project for a tenant's bound
    // Ontology domain. Repeating project creation explicitly attaches to that
    // project instead of creating a second container with divergent state.
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeProjectListReceiptSchema = z
  .object({
    items: z.array(OntoCodeProjectSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeProjectGetReceiptSchema = z
  .object({ project: OntoCodeProjectSchema })
  .strict();

export const CreateOntoCodeSessionRequestSchema = z
  .object({
    projectId: IdentifierSchema,
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(20_000),
    autonomyMode: OntoCodeAutonomyModeSchema.default("copilot"),
    ontologySnapshotHash: Sha256Schema.optional(),
    basePackageVersionId: IdentifierSchema.optional(),
    environmentProfileVersionId: IdentifierSchema.optional(),
  })
  .strict();
export type CreateOntoCodeSessionRequest = z.infer<
  typeof CreateOntoCodeSessionRequestSchema
>;

export const ListOntoCodeSessionsQuerySchema = PaginationQuerySchema.extend({
  projectId: IdentifierSchema.optional(),
  phase: OntoCodeSessionPhaseSchema.optional(),
  activityState: OntoCodeSessionActivitySchema.optional(),
}).strict();

export const UpdateOntoCodeSessionRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    title: z.string().trim().min(1).max(200).optional(),
    goal: z.string().trim().min(1).max(20_000).optional(),
    phase: OntoCodeSessionPhaseSchema.optional(),
    activityState: OntoCodeSessionActivitySchema.optional(),
    autonomyMode: OntoCodeAutonomyModeSchema.optional(),
    basePackageVersionId: IdentifierSchema.nullable().optional(),
    environmentProfileVersionId: IdentifierSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
    "at least one session field must be updated",
  );
export type UpdateOntoCodeSessionRequest = z.infer<
  typeof UpdateOntoCodeSessionRequestSchema
>;

/**
 * Closing a Session is intentionally separate from the generic PATCH route.
 * "retired" means the FDE intentionally abandoned an unfinished task;
 * "completed" is reserved for a successfully released/observed task.
 */
export const OntoCodeSessionCloseDispositionSchema = z.enum([
  "retired",
  "completed",
]);
export type OntoCodeSessionCloseDisposition = z.infer<
  typeof OntoCodeSessionCloseDispositionSchema
>;

export const CloseOntoCodeSessionRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    disposition: OntoCodeSessionCloseDispositionSchema,
    reason: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();
export type CloseOntoCodeSessionRequest = z.infer<
  typeof CloseOntoCodeSessionRequestSchema
>;

export const OntoCodeSessionCreateReceiptSchema = z
  .object({
    session: OntoCodeBuildSessionSchema,
    event: OntoCodeSessionEventSchema,
  })
  .strict();

export const OntoCodeSessionListReceiptSchema = z
  .object({
    items: z.array(OntoCodeBuildSessionSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeSessionGetReceiptSchema = z
  .object({ session: OntoCodeBuildSessionSchema })
  .strict();

export const OntoCodeSessionUpdateReceiptSchema = z
  .object({
    session: OntoCodeBuildSessionSchema,
    event: OntoCodeSessionEventSchema,
  })
  .strict();

export const OntoCodeSessionCloseReceiptSchema = z
  .object({
    session: OntoCodeBuildSessionSchema,
    event: OntoCodeSessionEventSchema,
    disposition: OntoCodeSessionCloseDispositionSchema,
  })
  .strict();
export type OntoCodeSessionCloseReceipt = z.infer<
  typeof OntoCodeSessionCloseReceiptSchema
>;

export const PostOntoCodeMessageRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(50_000),
    correlationId: IdentifierSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type PostOntoCodeMessageRequest = z.infer<
  typeof PostOntoCodeMessageRequestSchema
>;

export const ListOntoCodeMessagesQuerySchema = PaginationQuerySchema;

export const OntoCodeMessagePostReceiptSchema = z
  .object({
    message: OntoCodeMessageSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeMessageListReceiptSchema = z
  .object({
    items: z.array(OntoCodeMessageSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * A durable Assistant Run is the server-owned lifecycle for one accepted user
 * turn. It is intentionally separate from both the conversational Message and
 * the Harness Job: the Assistant may compile/read/review before it proposes a
 * Command, and a failed model call must not erase the accepted user turn.
 */
export const OntoCodeAssistantRunStatusSchema = z.enum([
  "accepted",
  "planning",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OntoCodeAssistantRunStatus = z.infer<
  typeof OntoCodeAssistantRunStatusSchema
>;

export const OntoCodeAssistantStepKindSchema = z.enum([
  "context_compile",
  "model_plan",
  "policy_commit",
  "result_review",
]);
export type OntoCodeAssistantStepKind = z.infer<
  typeof OntoCodeAssistantStepKindSchema
>;

export const OntoCodeAssistantStepStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const OntoCodeAssistantRunSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sourceMessageId: IdentifierSchema,
    status: OntoCodeAssistantRunStatusSchema,
    autonomyMode: OntoCodeAutonomyModeSchema,
    policy: JsonObjectSchema,
    contextHash: Sha256Schema.nullable(),
    contextManifest: JsonObjectSchema,
    budget: OntoCodeHarnessBudgetSchema,
    model: z.string().trim().min(1).max(240).nullable(),
    terminalResponse: JsonObjectSchema.nullable(),
    errorCode: z.string().trim().min(1).max(200).nullable(),
    errorMessage: z.string().max(8_000).nullable(),
    idempotencyKey: IdempotencyKeySchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeAssistantRun = z.infer<typeof OntoCodeAssistantRunSchema>;

export const OntoCodeAssistantStepSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sessionId: IdentifierSchema,
    assistantRunId: IdentifierSchema,
    ordinal: z.number().int().positive(),
    kind: OntoCodeAssistantStepKindSchema,
    status: OntoCodeAssistantStepStatusSchema,
    attempt: z.number().int().positive(),
    inputHash: Sha256Schema.nullable(),
    outputHash: Sha256Schema.nullable(),
    observation: JsonObjectSchema,
    errorCode: z.string().trim().min(1).max(200).nullable(),
    errorMessage: z.string().max(8_000).nullable(),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeAssistantStep = z.infer<typeof OntoCodeAssistantStepSchema>;

export const OntoCodePinnedContextRefKindSchema = z.enum([
  "ontology",
  "artifact",
  "evidence",
  "changeset",
]);

export const OntoCodePinnedContextRefSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sessionId: IdentifierSchema,
    assistantRunId: IdentifierSchema,
    ordinal: z.number().int().nonnegative(),
    kind: OntoCodePinnedContextRefKindSchema,
    requestedRef: z.string().trim().min(1).max(1_000),
    canonicalRef: z.string().trim().min(1).max(1_000),
    artifactId: OptionalIdentifierSchema,
    artifactVersionId: OptionalIdentifierSchema,
    evidenceId: OptionalIdentifierSchema,
    changeSetId: OptionalIdentifierSchema,
    contentHash: Sha256Schema,
    metadata: JsonObjectSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type OntoCodePinnedContextRef = z.infer<
  typeof OntoCodePinnedContextRefSchema
>;

export const ListOntoCodeAssistantRunsQuerySchema =
  PaginationQuerySchema.extend({
    status: OntoCodeAssistantRunStatusSchema.optional(),
  }).strict();

export const OntoCodeAssistantRunGetReceiptSchema = z
  .object({
    run: OntoCodeAssistantRunSchema,
    steps: z.array(OntoCodeAssistantStepSchema),
    contextRefs: z.array(OntoCodePinnedContextRefSchema),
  })
  .strict();

export const OntoCodeAssistantRunListReceiptSchema = z
  .object({
    items: z.array(OntoCodeAssistantRunSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const CreateOntoCodeCommandRequestSchema = z
  .object({
    type: OntoCodeCommandTypeSchema,
    arguments: JsonObjectSchema.default({}),
    expectedSessionRevision: RevisionSchema,
    baseOntologyHash: Sha256Schema.optional(),
    basePackageVersionId: IdentifierSchema.optional(),
    affectedSemanticPaths: z
      .array(z.string().trim().min(1).max(1_000))
      .max(500)
      .default([]),
    riskClass: OntoCodeRiskClassSchema,
    requestedCapabilities: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    requiresHuman: z.boolean().default(false),
    rationaleSummary: z.string().trim().min(1).max(4_000),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.riskClass === "external_irreversible" ||
        value.riskClass === "production_deploy") &&
      !value.requiresHuman
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["requiresHuman"],
        message:
          "irreversible external effects and production deployment require human approval",
      });
    }
    if (
      value.type === "deploy_release" &&
      value.riskClass !== "production_deploy"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["riskClass"],
        message: "deploy_release must use the production_deploy risk class",
      });
    }
  });
export type CreateOntoCodeCommandRequest = z.infer<
  typeof CreateOntoCodeCommandRequestSchema
>;

export const ListOntoCodeCommandsQuerySchema = PaginationQuerySchema.extend({
  status: OntoCodeCommandStatusSchema.optional(),
}).strict();

export const OntoCodeCommandCreateReceiptSchema = z
  .object({
    command: OntoCodeCommandSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeCommandListReceiptSchema = z
  .object({
    items: z.array(OntoCodeCommandSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeCommandGetReceiptSchema = z
  .object({ command: OntoCodeCommandSchema })
  .strict();

export const DecideOntoCodeCommandRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
    note: z.string().trim().max(4_000).optional(),
  })
  .strict();
export type DecideOntoCodeCommandRequest = z.infer<
  typeof DecideOntoCodeCommandRequestSchema
>;

export const OntoCodeCommandDecisionReceiptSchema = z
  .object({
    command: OntoCodeCommandSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    decision: z.enum(["approve", "reject"]),
    mode: z.enum(["resolved", "attached"]),
  })
  .strict();

export const CreateOntoCodeHarnessJobRequestSchema = z
  .object({
    commandId: IdentifierSchema.optional(),
    kind: OntoCodeHarnessJobKindSchema,
    expectedSessionRevision: RevisionSchema,
    inputHash: Sha256Schema.optional(),
    budget: OntoCodeHarnessBudgetSchema.optional(),
    candidatePackageVersionId: IdentifierSchema.optional(),
    candidateDependencyRoot: Sha256Schema.optional(),
    candidateHeadRevision: RevisionSchema.optional(),
    testCases: z.array(OntoCodeCandidateTestCaseSchema).max(500).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const candidateFields = [
      value.candidatePackageVersionId,
      value.candidateDependencyRoot,
      value.candidateHeadRevision,
    ];
    const supplied = candidateFields.filter(
      (field) => field !== undefined,
    ).length;
    if (supplied !== 0 && supplied !== candidateFields.length) {
      ctx.addIssue({
        code: "custom",
        path: ["candidatePackageVersionId"],
        message:
          "candidatePackageVersionId, candidateDependencyRoot and candidateHeadRevision must be supplied together",
      });
    }
  });
export type CreateOntoCodeHarnessJobRequest = z.infer<
  typeof CreateOntoCodeHarnessJobRequestSchema
>;

export const ListOntoCodeHarnessJobsQuerySchema = PaginationQuerySchema.extend({
  kind: OntoCodeHarnessJobKindSchema.optional(),
  status: OntoCodeHarnessJobStatusSchema.optional(),
}).strict();

export const OntoCodeHarnessJobCreateReceiptSchema = z
  .object({
    job: OntoCodeHarnessJobSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeHarnessJobListReceiptSchema = z
  .object({
    items: z.array(OntoCodeHarnessJobSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeHarnessJobGetReceiptSchema = z
  .object({ job: OntoCodeHarnessJobSchema })
  .strict();

export const PostOntoCodeTurnRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(50_000),
    behavior: OntoCodeTurnBehaviorSchema.default("clarify"),
    action: OntoCodeTurnActionSchema.optional(),
    arguments: JsonObjectSchema.default({}),
    affectedSemanticPaths: z
      .array(z.string().trim().min(1).max(1_000))
      .max(500)
      .default([]),
    requestedCapabilities: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    correlationId: IdentifierSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.behavior === "execute" && !value.action) {
      ctx.addIssue({
        code: "custom",
        path: ["action"],
        message: "execute turns require an explicit action",
      });
    }
    if (value.behavior !== "execute" && value.action !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["action"],
        message: "only execute turns may specify an action",
      });
    }
    if (
      value.behavior !== "execute" &&
      (Object.keys(value.arguments).length > 0 ||
        value.affectedSemanticPaths.length > 0 ||
        value.requestedCapabilities.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["behavior"],
        message: "non-execute turns cannot carry execution inputs",
      });
    }
  });
export type PostOntoCodeTurnRequest = z.infer<
  typeof PostOntoCodeTurnRequestSchema
>;

const OntoCodeWorkspaceDirectiveBaseShape = {
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  sourceMessageId: IdentifierSchema,
  eventSeq: z.number().int().positive(),
};

export const OntoCodeWorkspaceDirectiveSchema = z.discriminatedUnion(
  "behavior",
  [
    z
      .object({
        ...OntoCodeWorkspaceDirectiveBaseShape,
        behavior: z.literal("navigate"),
        target: z.string().trim().min(1).max(50_000),
      })
      .strict(),
    z
      .object({
        ...OntoCodeWorkspaceDirectiveBaseShape,
        behavior: z.literal("explain"),
        topic: z.string().trim().min(1).max(50_000),
      })
      .strict(),
    z
      .object({
        ...OntoCodeWorkspaceDirectiveBaseShape,
        behavior: z.literal("clarify"),
        question: z.string().trim().min(1).max(50_000),
      })
      .strict(),
    z
      .object({
        ...OntoCodeWorkspaceDirectiveBaseShape,
        behavior: z.literal("execute"),
        action: OntoCodeTurnActionSchema,
        commandId: IdentifierSchema,
        harnessJobId: IdentifierSchema,
        commandType: OntoCodeCommandTypeSchema,
        jobKind: OntoCodeHarnessJobKindSchema,
        riskClass: OntoCodeRiskClassSchema,
        requiresHuman: z.boolean(),
        budget: OntoCodeHarnessBudgetSchema,
      })
      .strict(),
  ],
);
export type OntoCodeWorkspaceDirective = z.infer<
  typeof OntoCodeWorkspaceDirectiveSchema
>;

export const OntoCodeTurnReceiptSchema = z
  .object({
    userMessage: OntoCodeMessageSchema,
    assistantMessage: OntoCodeMessageSchema,
    directive: OntoCodeWorkspaceDirectiveSchema,
    command: OntoCodeCommandSchema.nullable(),
    job: OntoCodeHarnessJobSchema.nullable(),
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();
export type OntoCodeTurnReceipt = z.infer<typeof OntoCodeTurnReceiptSchema>;

// ─── Durable configuration tasks ──────────────────────────────────────────
//
// A Configuration Task is the server-owned continuation boundary between an
// OntoCode recommendation and a real settings surface. The URL carries only
// its opaque id; provider/tool/environment targets are loaded from this
// tenant-scoped record and are never trusted from query parameters.
//
// These contracts intentionally store requirement SHAPES and verification
// summaries only. Credential values, tokens, passwords, raw probe responses,
// and arbitrary config objects have no field in this model.

export const OntoCodeConfigurationTaskStatusSchema = z.enum([
  "open",
  "verifying",
  "satisfied",
  "cancelled",
  "superseded",
]);
export type OntoCodeConfigurationTaskStatus = z.infer<
  typeof OntoCodeConfigurationTaskStatusSchema
>;

export const OntoCodeConfigurationEnvironmentSchema = z.enum([
  "sandbox",
  "production",
]);
export type OntoCodeConfigurationEnvironment = z.infer<
  typeof OntoCodeConfigurationEnvironmentSchema
>;

export const OntoCodeConfigurationTaskTargetSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("integration"),
        provider: IdentifierSchema,
        system: IdentifierSchema.nullable().default(null),
      })
      .strict(),
    z
      .object({
        kind: z.literal("system_profile"),
        system: IdentifierSchema,
        profileId: OptionalIdentifierSchema.default(null),
      })
      .strict(),
    z
      .object({
        kind: z.literal("tool"),
        system: IdentifierSchema,
        desiredToolName: OptionalIdentifierSchema.default(null),
        requirementKind: OptionalIdentifierSchema.default(null),
        requirementRole: OptionalIdentifierSchema.default(null),
      })
      .strict(),
    z
      .object({
        kind: z.literal("tool_profile"),
        toolName: IdentifierSchema,
        environment: OntoCodeConfigurationEnvironmentSchema,
        profileKey: IdentifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("llm_gateway"),
        provider: OptionalIdentifierSchema.default(null),
      })
      .strict(),
    z
      .object({
        kind: z.literal("environment"),
        provider: OptionalIdentifierSchema.default(null),
        envRefs: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/),
          )
          .min(1)
          .max(40),
      })
      .strict(),
  ],
);
export type OntoCodeConfigurationTaskTarget = z.infer<
  typeof OntoCodeConfigurationTaskTargetSchema
>;

export const OntoCodeConfigurationFieldRequirementSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(200),
    kind: z.enum([
      "base_url",
      "api_key",
      "secret",
      "text",
      "select",
      "env_only",
    ]),
    required: z.boolean(),
    envRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/)
      .nullable()
      .default(null),
    source: z.enum(["profile", "tool", "catalog", "default"]),
  })
  .strict();
export type OntoCodeConfigurationFieldRequirement = z.infer<
  typeof OntoCodeConfigurationFieldRequirementSchema
>;

export const OntoCodeConfigurationRequirementSchema = z
  .object({
    summary: z.string().trim().min(1).max(4_000),
    reason: z.string().trim().max(4_000).nullable().default(null),
    missingFields: z
      .array(OntoCodeConfigurationFieldRequirementSchema)
      .max(100)
      .default([]),
    sourceRefs: z
      .array(z.string().trim().min(1).max(1_000))
      .max(200)
      .default([]),
  })
  .strict();
export type OntoCodeConfigurationRequirement = z.infer<
  typeof OntoCodeConfigurationRequirementSchema
>;

export const OntoCodeConfigurationVerificationPolicySchema =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("derived_requirement"),
        provider: IdentifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("system_probe"),
        profileId: IdentifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("tool_profile"),
        toolName: IdentifierSchema,
        environment: OntoCodeConfigurationEnvironmentSchema,
        profileKey: IdentifierSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("tool_contract"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("gateway_configuration"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("environment_presence"),
        envRefs: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/),
          )
          .min(1)
          .max(40),
      })
      .strict(),
    z
      .object({
        kind: z.literal("manual_external"),
        instructions: z.string().trim().min(1).max(4_000),
      })
      .strict(),
  ]);
export type OntoCodeConfigurationVerificationPolicy = z.infer<
  typeof OntoCodeConfigurationVerificationPolicySchema
>;

export const OntoCodeConfigurationVerificationOutcomeSchema = z.enum([
  "pending",
  "passed",
  "failed",
]);
export type OntoCodeConfigurationVerificationOutcome = z.infer<
  typeof OntoCodeConfigurationVerificationOutcomeSchema
>;

export const OntoCodeConfigurationVerificationResultSchema = z
  .object({
    outcome: OntoCodeConfigurationVerificationOutcomeSchema,
    code: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-z][a-z0-9_]*$/),
    summary: z.string().trim().min(1).max(4_000),
    checkedAt: TimestampSchema,
    resourceDigest: Sha256Schema.nullable().default(null),
    refs: z.array(z.string().trim().min(1).max(1_000)).max(200).default([]),
  })
  .strict();
export type OntoCodeConfigurationVerificationResult = z.infer<
  typeof OntoCodeConfigurationVerificationResultSchema
>;

export const OntoCodeConfigurationTaskSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^ocfg-[a-f0-9]{32}$/),
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sourceCommandId: OptionalIdentifierSchema,
    waitingHarnessJobId: OptionalIdentifierSchema,
    sourceRequirementId: OptionalIdentifierSchema,
    sourceActionName: OptionalIdentifierSchema,
    sourceReceiptDigest: Sha256Schema.nullable(),
    blockerKey: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(300),
    target: OntoCodeConfigurationTaskTargetSchema,
    requirement: OntoCodeConfigurationRequirementSchema,
    verificationPolicy: OntoCodeConfigurationVerificationPolicySchema,
    resumeAction: OntoCodeTurnActionSchema.nullable(),
    ontologyHash: Sha256Schema,
    status: OntoCodeConfigurationTaskStatusSchema,
    revision: RevisionSchema,
    lastVerification: OntoCodeConfigurationVerificationResultSchema.nullable(),
    resolutionNote: z.string().max(4_000).nullable(),
    idempotencyKey: IdempotencyKeySchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    verificationStartedAt: TimestampSchema.nullable(),
    verifiedAt: TimestampSchema.nullable(),
    cancelledAt: TimestampSchema.nullable(),
  })
  .strict();
export type OntoCodeConfigurationTask = z.infer<
  typeof OntoCodeConfigurationTaskSchema
>;

export const CreateOntoCodeConfigurationTaskRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
    sourceCommandId: IdentifierSchema.optional(),
    waitingHarnessJobId: IdentifierSchema.optional(),
    sourceRequirementId: IdentifierSchema.optional(),
    sourceActionName: IdentifierSchema.optional(),
    blockerKey: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(300),
    target: OntoCodeConfigurationTaskTargetSchema,
    requirement: OntoCodeConfigurationRequirementSchema,
    verificationPolicy: OntoCodeConfigurationVerificationPolicySchema,
    resumeAction: OntoCodeTurnActionSchema.optional(),
    ontologyHash: Sha256Schema,
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.waitingHarnessJobId && !value.sourceRequirementId) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceRequirementId"],
        message:
          "sourceRequirementId is required when binding a Configuration Task to a waiting Harness Job",
      });
    }
    if (value.waitingHarnessJobId && !value.sourceActionName) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceActionName"],
        message:
          "sourceActionName is required when binding a Configuration Task to a waiting Harness Job",
      });
    }
    if (
      !value.waitingHarnessJobId &&
      (value.sourceRequirementId || value.sourceActionName)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["waitingHarnessJobId"],
        message:
          "A source requirement or action must be bound to an immutable waiting Harness receipt",
      });
    }
  });
export type CreateOntoCodeConfigurationTaskRequest = z.infer<
  typeof CreateOntoCodeConfigurationTaskRequestSchema
>;

export const ListOntoCodeConfigurationTasksQuerySchema =
  PaginationQuerySchema.extend({
    status: OntoCodeConfigurationTaskStatusSchema.optional(),
    kind: z
      .enum([
        "integration",
        "system_profile",
        "tool",
        "tool_profile",
        "llm_gateway",
        "environment",
      ])
      .optional(),
  }).strict();
export type ListOntoCodeConfigurationTasksQuery = z.infer<
  typeof ListOntoCodeConfigurationTasksQuerySchema
>;

export const CancelOntoCodeConfigurationTaskRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    note: z.string().trim().min(1).max(4_000).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CancelOntoCodeConfigurationTaskRequest = z.infer<
  typeof CancelOntoCodeConfigurationTaskRequestSchema
>;

export const VerifyOntoCodeConfigurationTaskRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type VerifyOntoCodeConfigurationTaskRequest = z.infer<
  typeof VerifyOntoCodeConfigurationTaskRequestSchema
>;

export const OntoCodeConfigurationTaskCreateReceiptSchema = z
  .object({
    task: OntoCodeConfigurationTaskSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();
export type OntoCodeConfigurationTaskCreateReceipt = z.infer<
  typeof OntoCodeConfigurationTaskCreateReceiptSchema
>;

export const OntoCodeConfigurationTaskListReceiptSchema = z
  .object({
    items: z.array(OntoCodeConfigurationTaskSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type OntoCodeConfigurationTaskListReceipt = z.infer<
  typeof OntoCodeConfigurationTaskListReceiptSchema
>;

export const OntoCodeConfigurationTaskGetReceiptSchema = z
  .object({ task: OntoCodeConfigurationTaskSchema })
  .strict();
export type OntoCodeConfigurationTaskGetReceipt = z.infer<
  typeof OntoCodeConfigurationTaskGetReceiptSchema
>;

export const OntoCodeConfigurationTaskCancelReceiptSchema = z
  .object({
    task: OntoCodeConfigurationTaskSchema,
    event: OntoCodeSessionEventSchema.nullable(),
    sessionRevision: RevisionSchema,
    mode: z.enum(["cancelled", "attached"]),
  })
  .strict();
export type OntoCodeConfigurationTaskCancelReceipt = z.infer<
  typeof OntoCodeConfigurationTaskCancelReceiptSchema
>;

export const OntoCodeConfigurationTaskVerifyReceiptSchema = z
  .object({
    task: OntoCodeConfigurationTaskSchema,
    event: OntoCodeSessionEventSchema.nullable(),
    sessionRevision: RevisionSchema,
    verification: OntoCodeConfigurationVerificationResultSchema,
    mode: z.enum(["started", "attached"]),
    /** True only when a passed, snapshot-bound task created or attached the
     * exact server-authored continuation for its waiting Harness Job. */
    resumed: z.boolean(),
  })
  .strict();
export type OntoCodeConfigurationTaskVerifyReceipt = z.infer<
  typeof OntoCodeConfigurationTaskVerifyReceiptSchema
>;

export const ListOntoCodeEventsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    visibility: OntoCodeEventVisibilitySchema.default("user"),
  })
  .strict();

export const OntoCodeEventListReceiptSchema = z
  .object({
    items: z.array(OntoCodeSessionEventSchema),
    lastSeq: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

// ─── Change sets, immutable artifact versions, and evidence ────────────────

export const OntoCodeChangeSetStatusSchema = z.enum([
  "proposed",
  "validated",
  "committed",
  "abandoned",
]);
export type OntoCodeChangeSetStatus = z.infer<
  typeof OntoCodeChangeSetStatusSchema
>;

export const OntoCodeChangeOperationKindSchema = z.enum([
  "add",
  "replace",
  "remove",
  "move",
]);

export const OntoCodeChangeOperationInputSchema = z
  .object({
    operation: OntoCodeChangeOperationKindSchema,
    semanticPath: z.string().trim().min(1).max(1_000),
    fromSemanticPath: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .nullable()
      .default(null),
    beforeValue: z.json().nullable().default(null),
    afterValue: z.json().nullable().default(null),
    sourceRefs: z
      .array(z.string().trim().min(1).max(1_000))
      .max(500)
      .default([]),
    invalidates: z
      .array(z.string().trim().min(1).max(1_000))
      .max(500)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.operation === "move" && value.fromSemanticPath === null) {
      ctx.addIssue({
        code: "custom",
        path: ["fromSemanticPath"],
        message: "move operations require fromSemanticPath",
      });
    }
    if (value.operation === "remove" && value.afterValue !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["afterValue"],
        message: "remove operations cannot include afterValue",
      });
    }
  });
export type OntoCodeChangeOperationInput = z.infer<
  typeof OntoCodeChangeOperationInputSchema
>;

export const OntoCodeChangeSetOperationSchema =
  OntoCodeChangeOperationInputSchema.safeExtend({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    changeSetId: IdentifierSchema,
    ordinal: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  }).strict();
export type OntoCodeChangeSetOperation = z.infer<
  typeof OntoCodeChangeSetOperationSchema
>;

export const OntoCodeChangeSetSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    commandId: OptionalIdentifierSchema,
    status: OntoCodeChangeSetStatusSchema,
    summary: z.string().trim().min(1).max(8_000),
    baseOntologyHash: Sha256Schema.nullable(),
    basePackageVersionId: OptionalIdentifierSchema,
    expectedSessionRevision: RevisionSchema,
    idempotencyKey: IdempotencyKeySchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    committedAt: TimestampSchema.nullable(),
  })
  .strict();
export type OntoCodeChangeSet = z.infer<typeof OntoCodeChangeSetSchema>;

export const CreateOntoCodeChangeSetRequestSchema = z
  .object({
    commandId: IdentifierSchema.optional(),
    summary: z.string().trim().min(1).max(8_000),
    baseOntologyHash: Sha256Schema.optional(),
    basePackageVersionId: IdentifierSchema.optional(),
    expectedSessionRevision: RevisionSchema,
    operations: z.array(OntoCodeChangeOperationInputSchema).min(1).max(1_000),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateOntoCodeChangeSetRequest = z.infer<
  typeof CreateOntoCodeChangeSetRequestSchema
>;

export const ListOntoCodeChangeSetsQuerySchema = PaginationQuerySchema.extend({
  status: OntoCodeChangeSetStatusSchema.optional(),
}).strict();

export const CommitOntoCodeChangeSetRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
  })
  .strict();
export type CommitOntoCodeChangeSetRequest = z.infer<
  typeof CommitOntoCodeChangeSetRequestSchema
>;

export const OntoCodeChangeSetCreateReceiptSchema = z
  .object({
    changeSet: OntoCodeChangeSetSchema,
    operations: z.array(OntoCodeChangeSetOperationSchema),
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeChangeSetListReceiptSchema = z
  .object({
    items: z.array(OntoCodeChangeSetSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeChangeSetGetReceiptSchema = z
  .object({
    changeSet: OntoCodeChangeSetSchema,
    operations: z.array(OntoCodeChangeSetOperationSchema),
  })
  .strict();

export const OntoCodeChangeSetCommitReceiptSchema = z
  .object({
    changeSet: OntoCodeChangeSetSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["committed", "attached"]),
  })
  .strict();

export const OntoCodeArtifactKindSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]*$/)
  .max(120);

export const OntoCodeArtifactSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    logicalName: z.string().trim().min(1).max(500),
    kind: OntoCodeArtifactKindSchema,
    semanticPath: z.string().trim().min(1).max(1_000).nullable(),
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type OntoCodeArtifact = z.infer<typeof OntoCodeArtifactSchema>;

export const OntoCodeArtifactVersionSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    artifactId: IdentifierSchema,
    sessionId: IdentifierSchema,
    changeSetId: OptionalIdentifierSchema,
    version: z.number().int().positive(),
    blobHash: Sha256Schema,
    contentType: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().nonnegative(),
    metadata: JsonObjectSchema,
    idempotencyKey: IdempotencyKeySchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type OntoCodeArtifactVersion = z.infer<
  typeof OntoCodeArtifactVersionSchema
>;

const OntoCodeArtifactContentSchema = z.string().max(2_000_000);

export const CreateOntoCodeArtifactRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
    logicalName: z.string().trim().min(1).max(500),
    kind: OntoCodeArtifactKindSchema,
    semanticPath: z.string().trim().min(1).max(1_000).optional(),
    content: OntoCodeArtifactContentSchema,
    contentType: z.string().trim().min(1).max(200).default("application/json"),
    metadata: JsonObjectSchema.default({}),
    changeSetId: IdentifierSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateOntoCodeArtifactRequest = z.infer<
  typeof CreateOntoCodeArtifactRequestSchema
>;

export const CreateOntoCodeArtifactVersionRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
    content: OntoCodeArtifactContentSchema,
    contentType: z.string().trim().min(1).max(200).default("application/json"),
    metadata: JsonObjectSchema.default({}),
    changeSetId: IdentifierSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateOntoCodeArtifactVersionRequest = z.infer<
  typeof CreateOntoCodeArtifactVersionRequestSchema
>;

export const ListOntoCodeArtifactsQuerySchema = PaginationQuerySchema.extend({
  kind: OntoCodeArtifactKindSchema.optional(),
}).strict();

export const ListOntoCodeArtifactVersionsQuerySchema = PaginationQuerySchema;

export const OntoCodeArtifactSummarySchema = z
  .object({
    artifact: OntoCodeArtifactSchema,
    latestVersion: OntoCodeArtifactVersionSchema,
  })
  .strict();

export const OntoCodeArtifactCreateReceiptSchema = z
  .object({
    artifact: OntoCodeArtifactSchema,
    version: OntoCodeArtifactVersionSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeArtifactVersionCreateReceiptSchema = z
  .object({
    artifact: OntoCodeArtifactSchema,
    version: OntoCodeArtifactVersionSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeArtifactListReceiptSchema = z
  .object({
    items: z.array(OntoCodeArtifactSummarySchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeArtifactGetReceiptSchema = OntoCodeArtifactSummarySchema;

export const OntoCodeArtifactVersionListReceiptSchema = z
  .object({
    items: z.array(OntoCodeArtifactVersionSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeArtifactVersionGetReceiptSchema = z
  .object({
    artifact: OntoCodeArtifactSchema,
    version: OntoCodeArtifactVersionSchema,
    content: OntoCodeArtifactContentSchema,
  })
  .strict();

export const OntoCodeEvidenceOutcomeSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
  "informational",
]);

export const OntoCodeEvidenceStateSchema = z.enum(["valid", "stale"]);
export type OntoCodeEvidenceState = z.infer<
  typeof OntoCodeEvidenceStateSchema
>;

export const OntoCodeEvidenceKindSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]*$/)
  .max(120);

export const OntoCodeEvidenceRecordSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    harnessJobId: OptionalIdentifierSchema,
    changeSetId: OptionalIdentifierSchema,
    artifactVersionId: OptionalIdentifierSchema,
    kind: OntoCodeEvidenceKindSchema,
    outcome: OntoCodeEvidenceOutcomeSchema,
    state: OntoCodeEvidenceStateSchema,
    staleReason: z.string().trim().min(1).max(2_000).nullable(),
    invalidatedByPackageVersionId: OptionalIdentifierSchema,
    invalidatedAt: TimestampSchema.nullable(),
    subjectType: z.string().trim().min(1).max(120),
    subjectId: IdentifierSchema,
    subjectDigest: Sha256Schema,
    dependencySet: JsonObjectSchema,
    validityPredicate: JsonObjectSchema,
    refs: z.array(z.string().trim().min(1).max(1_000)),
    summary: z.string().trim().min(1).max(8_000),
    producer: z.string().trim().min(1).max(200),
    idempotencyKey: IdempotencyKeySchema,
    recordedBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type OntoCodeEvidenceRecord = z.infer<
  typeof OntoCodeEvidenceRecordSchema
>;

export const CreateOntoCodeEvidenceRecordRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
    harnessJobId: IdentifierSchema.optional(),
    changeSetId: IdentifierSchema.optional(),
    artifactVersionId: IdentifierSchema.optional(),
    kind: OntoCodeEvidenceKindSchema,
    outcome: OntoCodeEvidenceOutcomeSchema,
    subjectType: z.string().trim().min(1).max(120),
    subjectId: IdentifierSchema,
    subjectDigest: Sha256Schema,
    dependencySet: JsonObjectSchema,
    validityPredicate: JsonObjectSchema,
    refs: z.array(z.string().trim().min(1).max(1_000)).max(1_000).default([]),
    summary: z.string().trim().min(1).max(8_000),
    producer: z.string().trim().min(1).max(200),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateOntoCodeEvidenceRecordRequest = z.infer<
  typeof CreateOntoCodeEvidenceRecordRequestSchema
>;

export const ListOntoCodeEvidenceRecordsQuerySchema =
  PaginationQuerySchema.extend({
    kind: OntoCodeEvidenceKindSchema.optional(),
    outcome: OntoCodeEvidenceOutcomeSchema.optional(),
    state: OntoCodeEvidenceStateSchema.optional(),
  }).strict();

export const OntoCodeEvidenceRecordCreateReceiptSchema = z
  .object({
    evidence: OntoCodeEvidenceRecordSchema,
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["created", "attached"]),
  })
  .strict();

export const OntoCodeEvidenceRecordListReceiptSchema = z
  .object({
    items: z.array(OntoCodeEvidenceRecordSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeDeliveryStateSchema = z.enum([
  "candidate_ready",
  "verified_candidate",
  "release_ready",
  "released",
]);
export type OntoCodeDeliveryState = z.infer<typeof OntoCodeDeliveryStateSchema>;

export const OntoCodeExecutionOwnerSchema = z.enum([
  "declarative_manifest",
  "codeact",
]);
export type OntoCodeExecutionOwner = z.infer<
  typeof OntoCodeExecutionOwnerSchema
>;

export const OntoCodePackageVersionSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    parentVersionId: OptionalIdentifierSchema,
    sourceHarnessJobId: OptionalIdentifierSchema,
    ontologyHash: Sha256Schema,
    dependencyRoot: Sha256Schema,
    artifactRefs: z
      .array(
        z
          .object({
            logicalName: z.string().trim().min(1).max(500),
            kind: OntoCodeArtifactKindSchema,
            artifactId: IdentifierSchema,
            artifactVersionId: IdentifierSchema,
            blobHash: Sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(2_000),
    executionOwners: z.record(
      z.string().trim().min(1).max(200),
      OntoCodeExecutionOwnerSchema,
    ),
    status: OntoCodeDeliveryStateSchema,
    validation: JsonObjectSchema,
    idempotencyKey: IdempotencyKeySchema,
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodePackageVersion = z.infer<
  typeof OntoCodePackageVersionSchema
>;

export const OntoCodeCandidateHeadSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    packageVersionId: IdentifierSchema,
    revision: RevisionSchema,
    updatedBy: OptionalIdentifierSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeCandidateHead = z.infer<typeof OntoCodeCandidateHeadSchema>;

export const OntoCodeCandidateHeadGetReceiptSchema = z
  .object({
    head: OntoCodeCandidateHeadSchema.nullable(),
    packageVersion: OntoCodePackageVersionSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.head) !== Boolean(value.packageVersion)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Candidate Head and Package Version must either both be present or both be null",
      });
    }
  });

// ─── Atomic Workspace CAS patch ──────────────────────────────────────────

export const OntoCodeWorkspaceArtifactPatchSchema = z
  .object({
    artifactId: IdentifierSchema,
    baseArtifactVersionId: IdentifierSchema,
    baseBlobHash: Sha256Schema,
    content: OntoCodeArtifactContentSchema,
    contentType: z.string().trim().min(1).max(200).optional(),
    metadata: JsonObjectSchema.default({}),
  })
  .strict();
export type OntoCodeWorkspaceArtifactPatch = z.infer<
  typeof OntoCodeWorkspaceArtifactPatchSchema
>;

export const CommitOntoCodeWorkspacePatchRequestSchema = z
  .object({
    expectedSessionRevision: RevisionSchema,
    expectedCandidateHeadRevision: RevisionSchema,
    basePackageVersionId: IdentifierSchema,
    baseDependencyRoot: Sha256Schema,
    commandId: IdentifierSchema.optional(),
    summary: z.string().trim().min(1).max(8_000),
    patches: z
      .array(OntoCodeWorkspaceArtifactPatchSchema)
      .min(1)
      .max(200)
      .superRefine((patches, ctx) => {
        const seen = new Set<string>();
        patches.forEach((patch, index) => {
          if (seen.has(patch.artifactId)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "artifactId"],
              message: "an artifact may be patched only once per atomic commit",
            });
          }
          seen.add(patch.artifactId);
        });
      }),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CommitOntoCodeWorkspacePatchRequest = z.infer<
  typeof CommitOntoCodeWorkspacePatchRequestSchema
>;

export const OntoCodeWorkspacePatchCommitReceiptSchema = z
  .object({
    changeSet: OntoCodeChangeSetSchema,
    operations: z.array(OntoCodeChangeSetOperationSchema),
    versions: z.array(OntoCodeArtifactVersionSchema),
    packageVersion: OntoCodePackageVersionSchema,
    head: OntoCodeCandidateHeadSchema,
    staleEvidenceIds: z.array(IdentifierSchema),
    event: OntoCodeSessionEventSchema,
    sessionRevision: RevisionSchema,
    mode: z.enum(["committed", "attached"]),
  })
  .strict();
export type OntoCodeWorkspacePatchCommitReceipt = z.infer<
  typeof OntoCodeWorkspacePatchCommitReceiptSchema
>;

// ─── Exact Candidate Sandbox attempts ────────────────────────────────────

export const OntoCodeSandboxAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cleanup_failed",
]);
export const OntoCodeSandboxQualificationSchema = z.enum([
  "development_only",
  "promotable",
]);
export const OntoCodeSandboxExecutionOriginSchema = z.enum([
  "local",
  "remote",
]);
export const OntoCodeSandboxBundleHashSchema = z
  .string()
  .regex(
    /^sandbox-bundle:v(?:1|2):[a-f0-9]{64}$/,
    "expected a canonical sandbox-bundle:v1|v2 content identity",
  );

export const OntoCodeSandboxAttemptSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    harnessJobId: IdentifierSchema,
    ordinal: z.number().int().positive(),
    packageVersionId: IdentifierSchema,
    dependencyRoot: Sha256Schema,
    ontologyHash: Sha256Schema,
    testSuiteHash: Sha256Schema,
    environmentProfileVersionId: OptionalIdentifierSchema,
    factorySandboxAttemptId: OptionalIdentifierSchema,
    candidateFingerprint: Sha256Schema,
    bundleHash: OntoCodeSandboxBundleHashSchema.nullable(),
    status: OntoCodeSandboxAttemptStatusSchema,
    qualification: OntoCodeSandboxQualificationSchema,
    executionOrigin: OntoCodeSandboxExecutionOriginSchema.nullable(),
    isolationTier: z.string().trim().min(1).max(120).nullable(),
    appId: z.string().trim().min(1).max(256).nullable(),
    sandboxTenantSlug: z.string().trim().min(1).max(256).nullable(),
    registrationReceipt: JsonObjectSchema.nullable(),
    executionReceipt: JsonObjectSchema.nullable(),
    testReceipt: JsonObjectSchema.nullable(),
    runDrainReceipt: JsonObjectSchema.nullable(),
    cleanupReceipt: JsonObjectSchema.nullable(),
    errorCode: z.string().trim().min(1).max(200).nullable(),
    errorMessage: z.string().trim().min(1).max(8_000).nullable(),
    createdBy: OptionalIdentifierSchema,
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeSandboxAttempt = z.infer<
  typeof OntoCodeSandboxAttemptSchema
>;

export const ListOntoCodeSandboxAttemptsQuerySchema =
  PaginationQuerySchema.extend({
    status: OntoCodeSandboxAttemptStatusSchema.optional(),
    qualification: OntoCodeSandboxQualificationSchema.optional(),
  }).strict();

export const OntoCodeSandboxAttemptGetReceiptSchema = z
  .object({ attempt: OntoCodeSandboxAttemptSchema })
  .strict();

export const OntoCodeSandboxAttemptListReceiptSchema = z
  .object({
    items: z.array(OntoCodeSandboxAttemptSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const ListOntoCodePackageVersionsQuerySchema =
  PaginationQuerySchema.extend({
    status: OntoCodeDeliveryStateSchema.optional(),
  }).strict();

export const OntoCodePackageVersionListReceiptSchema = z
  .object({
    items: z.array(OntoCodePackageVersionSchema),
    count: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const OntoCodeEvidenceRecordGetReceiptSchema = z
  .object({ evidence: OntoCodeEvidenceRecordSchema })
  .strict();

// ─── Suite overview (read-only per-Agent aggregate over the Candidate) ───

export const OntoCodeSuiteOverviewAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    executionOwner: OntoCodeExecutionOwnerSchema,
    artifacts: z.array(
      z
        .object({
          artifactId: IdentifierSchema,
          artifactVersionId: IdentifierSchema,
          kind: OntoCodeArtifactKindSchema,
          logicalName: z.string().trim().min(1).max(500),
        })
        .strict(),
    ),
    test: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        inconclusive: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    qualification: OntoCodeSandboxQualificationSchema.nullable(),
    blocking: z.string().max(500).nullable(),
  })
  .strict();
export type OntoCodeSuiteOverviewAgent = z.infer<
  typeof OntoCodeSuiteOverviewAgentSchema
>;

export const OntoCodeSuiteOverviewSchema = z
  .object({
    sessionId: IdentifierSchema,
    candidate: z
      .object({
        packageVersionId: IdentifierSchema,
        headId: IdentifierSchema,
        revision: RevisionSchema,
        status: OntoCodeDeliveryStateSchema,
      })
      .strict()
      .nullable(),
    agents: z.array(OntoCodeSuiteOverviewAgentSchema).max(200),
    readiness: z
      .object({
        ready: z.number().int().nonnegative(),
        pendingConfig: z.number().int().nonnegative(),
        verifying: z.number().int().nonnegative(),
      })
      .strict(),
    generatedAt: TimestampSchema,
  })
  .strict();
export type OntoCodeSuiteOverview = z.infer<typeof OntoCodeSuiteOverviewSchema>;

export const OntoCodeSuiteOverviewReceiptSchema = z
  .object({ overview: OntoCodeSuiteOverviewSchema })
  .strict();
export type OntoCodeSuiteOverviewReceipt = z.infer<
  typeof OntoCodeSuiteOverviewReceiptSchema
>;
