/**
 * Deterministic Power-Purchase shadow decision support.
 *
 * This module deliberately owns no clock, storage, network client, role
 * directory, or ERP adapter. It evaluates only the explicit snapshot supplied
 * by the caller and returns a recommendation; it never dispatches an alert.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

type JsonRecord = Record<string, unknown>;

export const POWER_PURCHASE_TIMELINESS_RULE_IDS = [
  "PP-RULE-DQ-001",
  "PP-RULE-SCHEDULE-001",
  "PP-RULE-OVERDUE-001",
  "PP-RULE-CLASSIFIER-001",
  "PP-RULE-ROUTING-001",
] as const;

const GOVERNANCE_ROLES = [
  "planner",
  "department_head",
  "executive_in_charge",
  "parent_leader",
  "procurement_leader",
  "demand_owner",
  "inventory_owner",
] as const;

const RESOLUTION_STATUSES = [
  "resolved",
  "routing_pending",
  "dq_opened",
] as const;

type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];
type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];
type RiskLevel = "red" | "yellow" | "blue";
type RoutingRole = "planner" | "department_head" | "executive_in_charge";

export interface PowerPurchaseRoleAssignmentInput {
  governance_role: GovernanceRole;
  principal_id: string;
  resolution_status: ResolutionStatus;
}

export interface PowerPurchaseTimelinessInput {
  case_id: string;
  case_status: string;
  expected_completion_ratio: number;
  actual_completion_ratio: number;
  time_deviation_working_days: number;
  formal_threshold_working_days: number;
  /** Required only after the overdue rule reaches `formal_candidate`. */
  on_time_score?: number;
  /** Required only after classification makes governed routing applicable. */
  role_assignments?: PowerPurchaseRoleAssignmentInput[];
}

const riskLevelSchema = z.enum(["red", "yellow", "blue"]);
const routingRoleSchema = z.enum([
  "planner",
  "department_head",
  "executive_in_charge",
]);

export const powerPurchaseTimelinessOutputSchema = z
  .object({
    schema: z.literal("agentic-operator.power-purchase-timeliness-decision/v1"),
    applied_rules: z.array(z.enum(POWER_PURCHASE_TIMELINESS_RULE_IDS)).min(1),
    case_id: z.string().nullable(),
    assessment_status: z.enum(["complete", "indeterminate"]),
    data_quality: z.object({
      incident_required: z.boolean(),
      issue_codes: z.array(z.string()),
      missing_or_invalid_fields: z.array(z.string()),
      business_warning_suppressed: z.boolean(),
      responsibility_attribution_suppressed: z.boolean(),
    }),
    deviation: z.object({
      expected_completion_ratio: z.number().nullable(),
      actual_completion_ratio: z.number().nullable(),
      schedule_deviation: z.number().nullable(),
      time_deviation_working_days: z.number().nullable(),
      amount_deviation: z.null(),
      amount_deviation_computed: z.literal(false),
      signal_state: z.enum([
        "monitor",
        "signal_only",
        "formal_candidate",
        "indeterminate",
      ]),
    }),
    overdue: z.object({
      first_overdue_signal: z.boolean(),
      signal_required: z.boolean(),
      formal_warning_required: z.boolean(),
      formal_threshold_working_days: z.number().int().positive().nullable(),
    }),
    classification: z.object({
      on_time_score: z.number().nullable(),
      level: riskLevelSchema.nullable(),
    }),
    routing: z.object({
      target_role: routingRoleSchema.nullable(),
      principal_id: z.string().nullable(),
      routing_status: z.enum(["not_required", "resolved", "routing_pending"]),
      fallback_used: z.boolean(),
      fallback_kind: z.literal("governance_dq_queue").nullable(),
      dispatch_allowed: z.boolean(),
    }),
    external_dispatch_performed: z.literal(false),
  })
  .strict();

export type PowerPurchaseTimelinessDecision = z.infer<
  typeof powerPurchaseTimelinessOutputSchema
>;

interface BaseTimelinessInput {
  case_id: string;
  case_status: string;
  expected_completion_ratio: number;
  actual_completion_ratio: number;
  time_deviation_working_days: number;
  formal_threshold_working_days: number;
}

interface FormalTimelinessInput {
  on_time_score: number;
  role_assignments: PowerPurchaseRoleAssignmentInput[];
}

interface ParsedInput<T> {
  value: T | null;
  issues: string[];
}

const BASE_APPLIED_RULES = [
  "PP-RULE-DQ-001",
  "PP-RULE-SCHEDULE-001",
  "PP-RULE-OVERDUE-001",
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedRatio(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isGovernanceRole(value: unknown): value is GovernanceRole {
  return (
    typeof value === "string" &&
    (GOVERNANCE_ROLES as readonly string[]).includes(value)
  );
}

function isResolutionStatus(value: unknown): value is ResolutionStatus {
  return (
    typeof value === "string" &&
    (RESOLUTION_STATUSES as readonly string[]).includes(value)
  );
}

function parseBaseInput(input: unknown): ParsedInput<BaseTimelinessInput> {
  if (!isRecord(input)) return { value: null, issues: ["input"] };

  const issues: string[] = [];
  if (!nonBlankString(input.case_id)) issues.push("case_id");
  if (!nonBlankString(input.case_status)) issues.push("case_status");
  if (!boundedRatio(input.expected_completion_ratio)) {
    issues.push("expected_completion_ratio");
  }
  if (!boundedRatio(input.actual_completion_ratio)) {
    issues.push("actual_completion_ratio");
  }
  if (!nonNegativeNumber(input.time_deviation_working_days)) {
    issues.push("time_deviation_working_days");
  }
  if (!positiveInteger(input.formal_threshold_working_days)) {
    issues.push("formal_threshold_working_days");
  }
  if (issues.length > 0) return { value: null, issues };
  return {
    value: {
      case_id: (input.case_id as string).trim(),
      case_status: (input.case_status as string).trim(),
      expected_completion_ratio: input.expected_completion_ratio as number,
      actual_completion_ratio: input.actual_completion_ratio as number,
      time_deviation_working_days: input.time_deviation_working_days as number,
      formal_threshold_working_days:
        input.formal_threshold_working_days as number,
    },
    issues: [],
  };
}

function parseFormalInput(
  input: JsonRecord,
): ParsedInput<FormalTimelinessInput> {
  const issues: string[] = [];
  if (!boundedRatio(input.on_time_score)) issues.push("on_time_score");

  const assignments: PowerPurchaseRoleAssignmentInput[] = [];
  if (!Array.isArray(input.role_assignments)) {
    issues.push("role_assignments");
  } else {
    input.role_assignments.forEach((candidate, index) => {
      if (!isRecord(candidate)) {
        issues.push(`role_assignments[${index}]`);
        return;
      }
      let valid = true;
      if (!isGovernanceRole(candidate.governance_role)) {
        issues.push(`role_assignments[${index}].governance_role`);
        valid = false;
      }
      if (!nonBlankString(candidate.principal_id)) {
        issues.push(`role_assignments[${index}].principal_id`);
        valid = false;
      }
      if (!isResolutionStatus(candidate.resolution_status)) {
        issues.push(`role_assignments[${index}].resolution_status`);
        valid = false;
      }
      if (valid) {
        assignments.push({
          governance_role: candidate.governance_role as GovernanceRole,
          principal_id: (candidate.principal_id as string).trim(),
          resolution_status: candidate.resolution_status as ResolutionStatus,
        });
      }
    });
  }

  if (issues.length > 0) return { value: null, issues };
  return {
    value: {
      on_time_score: input.on_time_score as number,
      role_assignments: assignments,
    },
    issues: [],
  };
}

function classify(score: number): RiskLevel {
  if (score < 0.6) return "red";
  if (score <= 0.85) return "yellow";
  return "blue";
}

function routingRole(level: RiskLevel): RoutingRole {
  switch (level) {
    case "blue":
      return "planner";
    case "yellow":
      return "department_head";
    case "red":
      return "executive_in_charge";
  }
}

function indeterminateDecision(
  raw: unknown,
  issues: string[],
  base?: BaseTimelinessInput,
): PowerPurchaseTimelinessDecision {
  const caseId =
    base?.case_id ??
    (isRecord(raw) && nonBlankString(raw.case_id) ? raw.case_id.trim() : null);
  const formalStageReached = base !== undefined;
  return {
    schema: "agentic-operator.power-purchase-timeliness-decision/v1",
    applied_rules: formalStageReached
      ? [...BASE_APPLIED_RULES]
      : ["PP-RULE-DQ-001"],
    case_id: caseId,
    assessment_status: "indeterminate",
    data_quality: {
      incident_required: true,
      issue_codes: ["critical_input_missing_or_invalid"],
      missing_or_invalid_fields: issues,
      business_warning_suppressed: true,
      responsibility_attribution_suppressed: true,
    },
    deviation: {
      expected_completion_ratio: base?.expected_completion_ratio ?? null,
      actual_completion_ratio: base?.actual_completion_ratio ?? null,
      schedule_deviation: base
        ? Math.max(
            0,
            base.expected_completion_ratio - base.actual_completion_ratio,
          )
        : null,
      time_deviation_working_days: base?.time_deviation_working_days ?? null,
      amount_deviation: null,
      amount_deviation_computed: false,
      signal_state: formalStageReached ? "formal_candidate" : "indeterminate",
    },
    overdue: {
      first_overdue_signal: base?.time_deviation_working_days === 1,
      signal_required: base ? base.time_deviation_working_days > 0 : false,
      formal_warning_required: formalStageReached,
      formal_threshold_working_days:
        base?.formal_threshold_working_days ?? null,
    },
    classification: { on_time_score: null, level: null },
    routing: {
      target_role: null,
      principal_id: null,
      routing_status: formalStageReached ? "routing_pending" : "not_required",
      fallback_used: false,
      fallback_kind: null,
      dispatch_allowed: false,
    },
    external_dispatch_performed: false,
  };
}

/** Evaluate the five approved rules without reading or mutating external state. */
export function evaluatePowerPurchaseTimeliness(
  raw: unknown,
): PowerPurchaseTimelinessDecision {
  const parsed = parseBaseInput(raw);
  if (!parsed.value) return indeterminateDecision(raw, parsed.issues);

  const input = parsed.value;
  const timeDeviation = input.time_deviation_working_days;
  const formalWarning = timeDeviation >= input.formal_threshold_working_days;
  const signalRequired = timeDeviation > 0;
  const signalState = formalWarning
    ? "formal_candidate"
    : signalRequired
      ? "signal_only"
      : "monitor";

  if (!formalWarning) {
    return {
      schema: "agentic-operator.power-purchase-timeliness-decision/v1",
      applied_rules: [...BASE_APPLIED_RULES],
      case_id: input.case_id,
      assessment_status: "complete",
      data_quality: {
        incident_required: false,
        issue_codes: [],
        missing_or_invalid_fields: [],
        business_warning_suppressed: false,
        responsibility_attribution_suppressed: false,
      },
      deviation: {
        expected_completion_ratio: input.expected_completion_ratio,
        actual_completion_ratio: input.actual_completion_ratio,
        schedule_deviation: Math.max(
          0,
          input.expected_completion_ratio - input.actual_completion_ratio,
        ),
        time_deviation_working_days: timeDeviation,
        amount_deviation: null,
        amount_deviation_computed: false,
        signal_state: signalState,
      },
      overdue: {
        first_overdue_signal: timeDeviation === 1,
        signal_required: signalRequired,
        formal_warning_required: false,
        formal_threshold_working_days: input.formal_threshold_working_days,
      },
      classification: { on_time_score: null, level: null },
      routing: {
        target_role: null,
        principal_id: null,
        routing_status: "not_required",
        fallback_used: false,
        fallback_kind: null,
        dispatch_allowed: false,
      },
      external_dispatch_performed: false,
    };
  }

  const formalParsed = parseFormalInput(raw as JsonRecord);
  if (!formalParsed.value) {
    return indeterminateDecision(raw, formalParsed.issues, input);
  }

  const formalInput = formalParsed.value;
  const level = classify(formalInput.on_time_score);
  const targetRole = routingRole(level);
  const resolvedAssignments = formalInput.role_assignments.filter(
    (assignment) =>
      assignment.governance_role === targetRole &&
      assignment.resolution_status === "resolved",
  );
  const routingResolved = resolvedAssignments.length === 1;
  const routingIssueCodes = routingResolved
    ? []
    : [
        resolvedAssignments.length === 0
          ? "routing_target_unresolved"
          : "routing_target_ambiguous",
      ];

  return {
    schema: "agentic-operator.power-purchase-timeliness-decision/v1",
    applied_rules: [...POWER_PURCHASE_TIMELINESS_RULE_IDS],
    case_id: input.case_id,
    assessment_status: "complete",
    data_quality: {
      incident_required: !routingResolved,
      issue_codes: routingIssueCodes,
      missing_or_invalid_fields: [],
      business_warning_suppressed: false,
      responsibility_attribution_suppressed: !routingResolved,
    },
    deviation: {
      expected_completion_ratio: input.expected_completion_ratio,
      actual_completion_ratio: input.actual_completion_ratio,
      schedule_deviation: Math.max(
        0,
        input.expected_completion_ratio - input.actual_completion_ratio,
      ),
      time_deviation_working_days: timeDeviation,
      amount_deviation: null,
      amount_deviation_computed: false,
      signal_state: signalState,
    },
    overdue: {
      first_overdue_signal: timeDeviation === 1,
      signal_required: signalRequired,
      formal_warning_required: formalWarning,
      formal_threshold_working_days: input.formal_threshold_working_days,
    },
    classification: {
      on_time_score: formalInput.on_time_score,
      level,
    },
    routing: {
      target_role: targetRole,
      principal_id: routingResolved
        ? resolvedAssignments[0]!.principal_id
        : null,
      routing_status: routingResolved ? "resolved" : "routing_pending",
      fallback_used: !routingResolved,
      fallback_kind: routingResolved ? null : "governance_dq_queue",
      // This is a recommendation only. A separate governed workflow may act
      // on it only after the formal threshold and exact role both resolve.
      dispatch_allowed: formalWarning && routingResolved,
    },
    external_dispatch_performed: false,
  };
}

export const powerPurchaseEvaluateTimeliness = defineTool({
  name: "powerPurchase.evaluateTimeliness",
  description:
    "Pure deterministic shadow evaluation for Power-Purchase data quality, schedule deviation, overdue signal/formal threshold, red/yellow/blue classification, and governed routing. Never calls MetaERP or dispatches alerts.",
  output: powerPurchaseTimelinessOutputSchema,
  async handler(ctx) {
    const data = evaluatePowerPurchaseTimeliness(ctx.event?.data);
    return {
      data,
      meta: {
        deterministic: true,
        sideEffects: "none",
        externalCalls: 0,
        rules: [...data.applied_rules],
      },
    };
  },
});
