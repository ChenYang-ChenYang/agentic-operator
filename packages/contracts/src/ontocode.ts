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
  "analyze_ontology",
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
  /** Read-only comprehension pass over the bound Ontology: structural graph
   *  analysis + evidence-cited interpretation. Produces understanding, never
   *  code, so it is safe to run at any point in a Session. */
  "ontology_analysis",
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

/** Stable OntoCode lifecycle across replaceable Harness Jobs and retries. */
export const OntoCodeBuildExecutionStateSchema = z.enum([
  "new",
  "running",
  "resuming",
  "waiting_user",
  "generated_unverified",
  "candidate_ready",
  "failed_recoverable",
  "failed_terminal",
  "cancelled",
]);
export type OntoCodeBuildExecutionState = z.infer<
  typeof OntoCodeBuildExecutionStateSchema
>;

export const OntoCodeBuildInteractionKindSchema = z.enum([
  "clarify",
  "test_approval",
  "boundary",
  "execution_readiness",
  "legacy_answer",
]);
export type OntoCodeBuildInteractionKind = z.infer<
  typeof OntoCodeBuildInteractionKindSchema
>;

export const OntoCodeBuildPendingAnswerStatusSchema = z.enum([
  "pending",
  "delivered",
  "consumed",
]);
export type OntoCodeBuildPendingAnswerStatus = z.infer<
  typeof OntoCodeBuildPendingAnswerStatusSchema
>;

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

/**
 * Server-side persistence projection for an OntoCode Build execution.
 *
 * `engineRunId` is an internal adapter binding, not a navigation or public API
 * identity.  Product surfaces identify this execution only by `id`.  The
 * directive is parsed JSON here even though SQLite stores its canonical text.
 */
export const OntoCodeBuildExecutionPersistenceSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    sessionId: IdentifierSchema,
    state: OntoCodeBuildExecutionStateSchema,
    ontologyHash: Sha256Schema,
    directive: JsonObjectSchema,
    directiveHash: Sha256Schema,
    runtimeProfileVersionId: OptionalIdentifierSchema,
    engineKind: z.string().trim().min(1).max(80),
    engineRunId: OptionalIdentifierSchema,
    checkpointDigest: Sha256Schema.nullable(),
    checkpointRevision: z.number().int().nonnegative(),
    pendingInteractionId: OptionalIdentifierSchema,
    pendingInteractionKind: OntoCodeBuildInteractionKindSchema.nullable(),
    pendingInteractionSubjectDigest: Sha256Schema.nullable(),
    pendingAnswerId: OptionalIdentifierSchema,
    pendingAnswerDigest: Sha256Schema.nullable(),
    pendingAnswerStatus: OntoCodeBuildPendingAnswerStatusSchema.nullable(),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((execution, ctx) => {
    const interactionFields = [
      execution.pendingInteractionId,
      execution.pendingInteractionKind,
      execution.pendingInteractionSubjectDigest,
    ];
    const interactionPresent = interactionFields.filter(
      (value) => value !== null,
    ).length;
    if (interactionPresent !== 0 && interactionPresent !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingInteractionId"],
        message:
          "pending interaction id, kind, and subject digest must be stored atomically",
      });
    }

    const answerFields = [
      execution.pendingAnswerId,
      execution.pendingAnswerDigest,
      execution.pendingAnswerStatus,
    ];
    const answerPresent = answerFields.filter((value) => value !== null).length;
    if (answerPresent !== 0 && answerPresent !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingAnswerId"],
        message:
          "pending answer id, digest, and delivery status must be stored atomically",
      });
    }
    if (answerPresent > 0 && interactionPresent !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingAnswerId"],
        message: "a pending answer must address one exact interaction",
      });
    }
  });
export type OntoCodeBuildExecutionPersistence = z.infer<
  typeof OntoCodeBuildExecutionPersistenceSchema
>;

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

/**
 * A chart the workspace may render inside a chat answer.
 *
 * The honesty rule is structural: `rows` are ALWAYS computed by the server from
 * the authoritative Ontology (a deterministic aggregate named in `source`), and
 * `computedBy` is a literal so a model-authored payload cannot claim otherwise.
 * The model chooses WHICH aggregate to show and HOW to present it — never the
 * numbers. `truncated` travels with the rows so a cut list is never read as a
 * complete one.
 */
/**
 * Whether the Ontology a Session is locked to is still what the authoritative
 * source serves right now.
 *
 * Every field is measured, never assumed. `unavailable` is a first-class answer
 * carrying the real reason — a source we could not read must never be reported
 * as `current`, because "still fresh" and "we could not check" look identical
 * to an FDE and only one of them is safe to act on.
 *
 * `servedBy` names the source object that actually produced the ontology, and
 * `shadowed` marks the case an FDE cannot otherwise see: an uploaded bundle
 * answering for a domain that a live source could also have served, without an
 * explicit binding having chosen it.
 */
export const OntoCodeOntologyFreshnessSchema = z
  .object({
    schema: z.literal("ontocode-ontology-freshness/v1"),
    /** The immutable hash this Session is pinned to. */
    sessionSnapshotHash: z.string().trim().min(1).max(80).nullable(),
    status: z.enum(["current", "changed", "unavailable"]),
    /** What the source serves now. Null only when `status` is `unavailable`. */
    currentHash: z.string().trim().min(1).max(80).nullable(),
    servedBy: z.enum(["allmeta", "upload", "manifest"]).nullable(),
    shadowed: z.boolean(),
    checkedAt: TimestampSchema,
    /** Verbatim failure reason. Present only when `status` is `unavailable`. */
    reason: z.string().max(500).nullable(),
  })
  .strict();
export type OntoCodeOntologyFreshness = z.infer<
  typeof OntoCodeOntologyFreshnessSchema
>;

export const OntoCodeChartSpecSchema = z
  .object({
    schema: z.literal("ontocode-chart/v1"),
    kind: z.enum(["bar", "donut"]),
    title: z.string().trim().min(1).max(120),
    note: z.string().trim().min(1).max(500).optional(),
    // The renderer prints `${row.value} ${unit}`, so a unit carrying digits
    // (or ％-family signs) fuses model-invented numbers onto server-computed
    // rows — e.g. unit="92.7% 通过". Title/note are model prose like the
    // answer body; the unit is the one field typography welds to real data.
    unit: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^0-9０-９%‰]+$/u, "unit 不能包含数字")
      .optional(),
    rows: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(120),
            value: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    total: z.number().finite().nonnegative().optional(),
    truncated: z.boolean(),
    source: z
      .object({
        aggregate: z.string().trim().min(1).max(120),
        computedBy: z.literal("server"),
      })
      .strict(),
  })
  .strict();
export type OntoCodeChartSpec = z.infer<typeof OntoCodeChartSpecSchema>;

// ── ontocode-table/v1 ────────────────────────────────────────────────────────
// Contract bounds. Exported so the producing server and the rendering client
// read ONE number each instead of two literals that can drift apart.
/** Widest table an answer may carry. */
export const ONTOCODE_TABLE_MAX_COLUMNS = 8;
/** Tallest table an answer may carry (per-derivation caps must be ≤ this). */
export const ONTOCODE_TABLE_MAX_ROWS = 60;
export const ONTOCODE_TABLE_TITLE_CHARS = 120;
export const ONTOCODE_TABLE_NOTE_CHARS = 500;
export const ONTOCODE_TABLE_COLUMN_KEY_CHARS = 60;
export const ONTOCODE_TABLE_COLUMN_LABEL_CHARS = 60;
export const ONTOCODE_TABLE_CELL_CHARS = 240;
export const ONTOCODE_TABLE_DERIVATION_CHARS = 120;

/**
 * ONE cell. A plain string or a finite number — nothing else.
 *
 * The union is the honesty boundary at the smallest scale: a structured cell
 * (`{ text, tooltip, verdict }`) is exactly where a model smuggles authored
 * content into a table of server-derived facts, so a cell that is not a bare
 * value the server produced does not parse at all. Booleans and null are
 * excluded too — the server renders its own words for "declared/undeclared"
 * rather than handing the renderer a flag to interpret.
 */
export const OntoCodeTableCellSchema = z.union([
  z.string().max(ONTOCODE_TABLE_CELL_CHARS),
  z.number().finite(),
]);
export type OntoCodeTableCell = z.infer<typeof OntoCodeTableCellSchema>;

export const OntoCodeTableColumnSchema = z
  .object({
    /** Stable identifier of the derivation's column. Never shown. */
    key: z.string().trim().min(1).max(ONTOCODE_TABLE_COLUMN_KEY_CHARS),
    /** What the reader sees. */
    label: z.string().trim().min(1).max(ONTOCODE_TABLE_COLUMN_LABEL_CHARS),
    /** Numeric columns read right-aligned; text reads left. Presentation only. */
    align: z.enum(["left", "right"]).optional(),
  })
  .strict();
export type OntoCodeTableColumn = z.infer<typeof OntoCodeTableColumnSchema>;

/**
 * A table the workspace may render inside a chat answer — the table analogue of
 * OntoCodeChartSpecSchema, under the same discipline.
 *
 * `rows` are ALWAYS computed by the server from the authoritative Ontology (a
 * deterministic derivation named in `source`), and `computedBy` is a literal so
 * a model-authored payload cannot claim otherwise. The model chooses WHICH
 * derivation to show and HOW to title it — never the contents.
 *
 * Rows are POSITIONAL: each row is an array of cells that must line up exactly
 * with `columns`. A keyed-object row would let a payload introduce a column the
 * derivation never declared; here a row that does not match the declared arity
 * is rejected outright.
 *
 * Truncation is stated, never implied: `total` is the full pre-cap row count,
 * `truncated` says whether rows were cut, and `cellsTruncated` counts cells
 * whose own text had to be clipped. A cut table is never readable as a whole one.
 */
export const OntoCodeTableSpecSchema = z
  .object({
    schema: z.literal("ontocode-table/v1"),
    title: z.string().trim().min(1).max(ONTOCODE_TABLE_TITLE_CHARS),
    note: z.string().trim().min(1).max(ONTOCODE_TABLE_NOTE_CHARS).optional(),
    columns: z
      .array(OntoCodeTableColumnSchema)
      .min(1)
      .max(ONTOCODE_TABLE_MAX_COLUMNS),
    rows: z
      .array(
        z.array(OntoCodeTableCellSchema).min(1).max(ONTOCODE_TABLE_MAX_COLUMNS),
      )
      .min(1)
      .max(ONTOCODE_TABLE_MAX_ROWS),
    /** Full pre-cap row count; rows.length < total ⇔ truncated. */
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    /** Cells whose own text exceeded the cell bound and was clipped. */
    cellsTruncated: z.number().int().nonnegative(),
    source: z
      .object({
        derivation: z
          .string()
          .trim()
          .min(1)
          .max(ONTOCODE_TABLE_DERIVATION_CHARS),
        computedBy: z.literal("server"),
      })
      .strict(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    for (const [index, row] of spec.rows.entries()) {
      if (row.length !== spec.columns.length) {
        ctx.addIssue({
          code: "custom",
          path: ["rows", index],
          message: `第 ${index + 1} 行有 ${row.length} 个单元格，与 ${spec.columns.length} 个列不匹配`,
        });
      }
    }
    if (spec.rows.length > spec.total) {
      ctx.addIssue({
        code: "custom",
        path: ["total"],
        message: `total ${spec.total} 小于实际行数 ${spec.rows.length}`,
      });
    }
    if (spec.truncated !== spec.rows.length < spec.total) {
      ctx.addIssue({
        code: "custom",
        path: ["truncated"],
        message: `truncated=${spec.truncated} 与 ${spec.rows.length}/${spec.total} 行不一致`,
      });
    }
  });
export type OntoCodeTableSpec = z.infer<typeof OntoCodeTableSpecSchema>;

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
export type OntoCodeResolvedCommandBudget = OntoCodeHarnessBudget & {
  maxWallClockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
};

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
  analyze_ontology: {
    commandType: "analyze_ontology",
    jobKind: "ontology_analysis",
    riskClass: "read_only",
    requiresHuman: false,
    // Reads the graph and reasons over it; no artifact is mutated, so it gets a
    // wider model allowance than scope but the same read-only risk class.
    budget: { maxWallClockMs: 300_000, maxModelCalls: 12, maxToolCalls: 40 },
  },
  analyze_scope: {
    commandType: "analyze_scope",
    jobKind: "scope",
    riskClass: "read_only",
    requiresHuman: false,
    // Scope now reasons with ontology tool access (the same read-only inquiry
    // loop analyze_ontology runs), so it carries the same budget. Reasoning is
    // MANDATORY on this stage by product decision — a budget too small to fund
    // it would force the dishonest choice between failing and faking, so the
    // budget is sized for the loop, not for the old single flattened call.
    budget: { maxWallClockMs: 300_000, maxModelCalls: 12, maxToolCalls: 40 },
  },
  propose_blueprint: {
    commandType: "propose_blueprint",
    jobKind: "blueprint",
    riskClass: "draft_change",
    requiresHuman: false,
    // Blueprint runs a per-phase reasoning pass (one call per selected Action,
    // plus grounding retries). Sized so a full-domain selection reasons every
    // phase instead of stopping partway; same rationale as analyze_scope.
    budget: { maxWallClockMs: 300_000, maxModelCalls: 16, maxToolCalls: 24 },
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
    // `budget` is the bounded one-Action default. Multi-Action generation is
    // expanded by `resolveOntoCodeCommandBudget` up to this server-owned
    // ceiling; callers can tighten that resolved allowance, never widen it.
    budget: { maxWallClockMs: 600_000, maxModelCalls: 10, maxToolCalls: 24 },
    budgetCeiling: {
      maxWallClockMs: 900_000,
      maxModelCalls: 40,
      maxToolCalls: 96,
    },
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
    // The current implementation executes the exact Candidate in a Sandbox.
    // Treating this as read-only let guide mode start real runtime work.
    riskClass: "sandbox_effect",
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
    budgetCeiling?: OntoCodeHarnessBudget;
  }
>;

/**
 * Resolve the server-owned default budget for a concrete command.
 *
 * A generated package has real per-Action work (contract grounding, design,
 * validation and evidence), so a fixed ten-call allowance made a six-Action
 * Build terminate immediately after planning. The allowance now grows with
 * the immutable selected scope while remaining capped by the command policy.
 * A single-Action Build keeps the original tight limits.
 *
 * #BUDGET-FOLLOWS-WORK — the allowance belongs to the work stream, not to the
 * label of the command that nudges it. Every `build`-kind command drives the
 * same per-Action generation harness, so once the server knows the Session's
 * immutable Action scope it sizes them all alike. A live six-Action Build lost
 * its generated agents to this: an FDE's "save the draft" turn was routed to
 * `patch_artifact`, whose flat allowance overwrote the running conversation's
 * budget (30/74/900s → 8/20/120s) and the terminal `save_draft` never got a
 * turn. Scope sizing only ever WIDENS a command's own policy budget, and stays
 * capped by the generation ceiling.
 */
export function resolveOntoCodeCommandBudget(
  action: OntoCodeCommandType,
  args: Record<string, unknown> = {},
  serverScope?: { authoritativeActionCount?: number | null },
): OntoCodeResolvedCommandBudget {
  const policy = ONTOCODE_COMMAND_POLICY[action];
  if (action !== "generate_package") {
    const scopeCount = serverScope?.authoritativeActionCount;
    // Only a server-recovered scope widens a non-generation command; client
    // arguments can still tighten the result downstream but never widen it.
    if (
      policy.jobKind !== "build" ||
      !Number.isSafeInteger(scopeCount) ||
      (scopeCount ?? 0) <= 0
    ) {
      return { ...policy.budget };
    }
    const scoped = resolveOntoCodeCommandBudget("generate_package", {}, {
      authoritativeActionCount: scopeCount,
    });
    // A Build-kind command never drops below its own policy allowance.
    return {
      maxWallClockMs: Math.max(
        policy.budget.maxWallClockMs,
        scoped.maxWallClockMs,
      ),
      maxModelCalls: Math.max(policy.budget.maxModelCalls, scoped.maxModelCalls),
      maxToolCalls: Math.max(policy.budget.maxToolCalls, scoped.maxToolCalls),
    };
  }
  const generationPolicy = ONTOCODE_COMMAND_POLICY.generate_package;

  const selectedActionCount = Array.isArray(args.actionIds)
    ? new Set(
        args.actionIds
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean),
      ).size
    : 0;
  const fullDomain = args.scopeMode === "full_domain";
  const authoritativeActionCount =
    Number.isSafeInteger(serverScope?.authoritativeActionCount) &&
    (serverScope?.authoritativeActionCount ?? 0) > 0
      ? serverScope!.authoritativeActionCount!
      : null;
  const actionCount =
    authoritativeActionCount ??
    (fullDomain ? 8 : Math.max(1, selectedActionCount));
  const additionalActions = actionCount - 1;
  const ceiling = generationPolicy.budgetCeiling;

  return {
    maxWallClockMs: Math.min(
      ceiling.maxWallClockMs!,
      generationPolicy.budget.maxWallClockMs + additionalActions * 60_000,
    ),
    maxModelCalls: Math.min(
      ceiling.maxModelCalls!,
      generationPolicy.budget.maxModelCalls + additionalActions * 4,
    ),
    maxToolCalls: Math.min(
      ceiling.maxToolCalls!,
      generationPolicy.budget.maxToolCalls + additionalActions * 10,
    ),
  };
}

export interface OntoCodeAutonomyActionPolicy {
  allowed: boolean;
  requiresHuman: boolean;
  reason:
    | "analysis_only"
    | "confirm_each_change"
    | "sandbox_autonomous"
    | "base_human_gate";
}

/**
 * Product-facing autonomy semantics, kept separate from the immutable command
 * risk table:
 *
 * - guide              = analysis only
 * - copilot            = confirm every non-read-only engineering step
 * - sandbox_autopilot  = autonomous through draft/sandbox work
 *
 * No mode can remove a base production/external approval gate.
 */
export function resolveOntoCodeAutonomyActionPolicy(
  mode: OntoCodeAutonomyMode,
  action: OntoCodeCommandType,
): OntoCodeAutonomyActionPolicy {
  const base = ONTOCODE_COMMAND_POLICY[action];
  if (mode === "guide") {
    return {
      allowed: base.riskClass === "read_only",
      requiresHuman: false,
      reason: "analysis_only",
    };
  }
  if (mode === "copilot" && base.riskClass !== "read_only") {
    return {
      allowed: true,
      requiresHuman: true,
      reason: "confirm_each_change",
    };
  }
  return {
    allowed: true,
    requiresHuman: base.requiresHuman,
    reason: base.requiresHuman ? "base_human_gate" : "sandbox_autonomous",
  };
}

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
    // Optional during the additive migration window. New Build Jobs bind the
    // stable execution; legacy/non-Build Jobs legitimately remain unbound.
    buildExecutionId: OptionalIdentifierSchema.optional(),
    attemptNo: z.number().int().nonnegative().optional(),
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
export type OntoCodeEvidenceState = z.infer<typeof OntoCodeEvidenceStateSchema>;

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

export const OntoCodeCandidateBlockerStageSchema = z.enum([
  "runtime",
  "verification",
]);
export type OntoCodeCandidateBlockerStage = z.infer<
  typeof OntoCodeCandidateBlockerStageSchema
>;

export const OntoCodeCandidateBlockerCodeSchema = z.enum([
  "integration_profile_missing",
  "integration_probe_missing",
  "credential_reference_unavailable",
  "external_api_runtime_not_ready",
  "write_probe_contract_missing",
  "human_boundary_pending",
]);
export type OntoCodeCandidateBlockerCode = z.infer<
  typeof OntoCodeCandidateBlockerCodeSchema
>;

/**
 * A Candidate may be structurally complete while an external execution
 * dependency is not ready. These blockers are intentionally narrower than a
 * free-form warning: every row names the immutable Agent/requirement/tool it
 * applies to and the exact later-stage gate it closes.
 */
export const OntoCodeCandidateBlockerSchema = z
  .object({
    code: OntoCodeCandidateBlockerCodeSchema,
    stage: OntoCodeCandidateBlockerStageSchema,
    agentSlug: z.string().trim().min(1).max(200),
    actionName: z.string().trim().min(1).max(200).nullable(),
    requirementId: z.string().trim().min(1).max(240).nullable(),
    system: z.string().trim().min(1).max(240).nullable(),
    toolName: z.string().trim().min(1).max(200).nullable(),
    bindingStatus: z.string().trim().min(1).max(100).nullable(),
    reason: z.string().trim().min(1).max(2_000),
    missing: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  })
  .strict();
export type OntoCodeCandidateBlocker = z.infer<
  typeof OntoCodeCandidateBlockerSchema
>;

export const OntoCodeCandidateValidationV2Schema = z
  .object({
    schema: z.literal("ontocode-candidate-validation/v2"),
    passed: z.literal(true),
    packageIntegrityPassed: z.literal(true),
    requiredArtifactKinds: z.array(OntoCodeArtifactKindSchema).min(1).max(100),
    agentCount: z.number().int().positive(),
    executionOwnerCount: z.number().int().positive(),
    runtimeReady: z.boolean(),
    verificationPrerequisitesReady: z.boolean(),
    runtimeBlockers: z.array(OntoCodeCandidateBlockerSchema).max(2_000),
    verificationBlockers: z.array(OntoCodeCandidateBlockerSchema).max(2_000),
    sandboxEvidenceIncluded: z.boolean(),
    releaseEligible: z.boolean(),
  })
  // Promotion and deployment append signed evidence coordinates to this
  // object. Keep those additive fields while the core readiness contract stays
  // parsed and typed.
  .catchall(z.unknown());
export type OntoCodeCandidateValidationV2 = z.infer<
  typeof OntoCodeCandidateValidationV2Schema
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
export const OntoCodeSandboxExecutionOriginSchema = z.enum(["local", "remote"]);
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

// ─── Structured waiting question (Harness → conversational action card) ───

const OntoCodeStructuredQuestionOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1).max(500),
    recommended: z.boolean().optional(),
  })
  .strict();

const OntoCodeStructuredQuestionItemSchema = z
  .object({
    id: z.string().trim().min(1).max(200).optional(),
    question: z.string().trim().min(1).max(1_000),
    context: z.string().max(2_000).optional(),
    options: z.array(OntoCodeStructuredQuestionOptionSchema).max(4).default([]),
    allowOther: z.boolean().default(true),
    systems: z.array(z.string().trim().min(1).max(200)).max(4).default([]),
  })
  .strict();

export const OntoCodeStructuredQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["config", "decision", "authorization"]),
    question: z.string().trim().min(1).max(4_000),
    why: z.string().max(2_000).optional(),
    options: z
      .array(OntoCodeStructuredQuestionOptionSchema)
      .max(12)
      .default([]),
    /** ask_user_batch remains machine-readable all the way to the UI. */
    items: z.array(OntoCodeStructuredQuestionItemSchema).max(8).optional(),
    allowOther: z.boolean().default(true),
    impact: z.string().max(1_000).optional(),
    systems: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    /**
     * How much of the readiness receipt this question was derived from. Present
     * only when the scan hit its bound: a truncated scan cannot be read as "these
     * are all the gaps", and staying silent about it turns a partial check into
     * an apparently complete one.
     */
    coverage: z
      .object({
        scanned: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        truncated: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OntoCodeStructuredQuestion = z.infer<
  typeof OntoCodeStructuredQuestionSchema
>;

const WALL_CLOCK_POLICY_BY_JOB_KIND: Record<
  OntoCodeHarnessJobKind,
  "warn" | "kill"
> = {
  // Comprehension is generative work: a deadline should surface as a warning,
  // not silently discard a partially formed reading.
  ontology_analysis: "warn",
  scope: "warn",
  blueprint: "warn",
  build: "warn",
  test: "warn",
  debug: "warn",
  regression: "warn",
  simulation: "kill",
  promotion: "kill",
  deploy: "kill",
  production_analysis: "kill",
};

/**
 * Generative work must not be killed by a fixed deadline — for those kinds the
 * wall-clock budget is advisory ("warn"; spec §5.1 定案, staged checkpoint
 * split deferred to M3), while bounded read-only/production kinds keep "kill".
 */
export function resolveWallClockPolicy(
  kind: OntoCodeHarnessJobKind,
): "warn" | "kill" {
  return WALL_CLOCK_POLICY_BY_JOB_KIND[kind];
}
