import { describe, expect, it, vi } from "vitest";
import { getGlobalToolCatalogEntry, globalToolRegistry } from "../registry";
import {
  evaluatePowerPurchaseTimeliness,
  powerPurchaseTimelinessOutputSchema,
  type PowerPurchaseTimelinessInput,
} from "./evaluate-timeliness";

function fixture(
  overrides: Partial<PowerPurchaseTimelinessInput> = {},
): PowerPurchaseTimelinessInput {
  return {
    case_id: "PBP-LINE-001@DELIVERY-01",
    case_status: "executing",
    expected_completion_ratio: 0.8,
    actual_completion_ratio: 0.6,
    time_deviation_working_days: 7,
    formal_threshold_working_days: 7,
    on_time_score: 0.6,
    role_assignments: [
      {
        governance_role: "planner",
        principal_id: "planner-01",
        resolution_status: "resolved",
      },
      {
        governance_role: "department_head",
        principal_id: "department-head-01",
        resolution_status: "resolved",
      },
      {
        governance_role: "executive_in_charge",
        principal_id: "executive-01",
        resolution_status: "resolved",
      },
    ],
    ...overrides,
  };
}

describe("powerPurchase.evaluateTimeliness", () => {
  it.each([
    [0, "red", "executive_in_charge"],
    [0.599999, "red", "executive_in_charge"],
    [0.6, "yellow", "department_head"],
    [0.85, "yellow", "department_head"],
    [0.850001, "blue", "planner"],
    [1, "blue", "planner"],
  ] as const)(
    "classifies the score boundary %s as %s",
    (onTimeScore, level, targetRole) => {
      const result = evaluatePowerPurchaseTimeliness(
        fixture({ on_time_score: onTimeScore }),
      );
      expect(result.assessment_status).toBe("complete");
      expect(result.classification).toEqual({
        on_time_score: onTimeScore,
        level,
      });
      expect(result.routing.target_role).toBe(targetRole);
    },
  );

  it.each([
    [0, "monitor", false, false, false],
    [1, "signal_only", true, true, false],
    [6, "signal_only", false, true, false],
    [7, "formal_candidate", false, true, true],
    [8, "formal_candidate", false, true, true],
  ] as const)(
    "projects %s overdue working days to %s",
    (days, signalState, firstOverdue, signalRequired, formalRequired) => {
      const result = evaluatePowerPurchaseTimeliness(
        fixture({ time_deviation_working_days: days }),
      );
      expect(result.deviation.signal_state).toBe(signalState);
      expect(result.overdue).toMatchObject({
        first_overdue_signal: firstOverdue,
        signal_required: signalRequired,
        formal_warning_required: formalRequired,
        formal_threshold_working_days: 7,
      });
      expect(result.routing.dispatch_allowed).toBe(formalRequired);
      if (formalRequired) {
        expect(result.applied_rules).toEqual([
          "PP-RULE-DQ-001",
          "PP-RULE-SCHEDULE-001",
          "PP-RULE-OVERDUE-001",
          "PP-RULE-CLASSIFIER-001",
          "PP-RULE-ROUTING-001",
        ]);
      } else {
        expect(result.applied_rules).toEqual([
          "PP-RULE-DQ-001",
          "PP-RULE-SCHEDULE-001",
          "PP-RULE-OVERDUE-001",
        ]);
        expect(result.classification).toEqual({
          on_time_score: null,
          level: null,
        });
        expect(result.routing).toEqual({
          target_role: null,
          principal_id: null,
          routing_status: "not_required",
          fallback_used: false,
          fallback_kind: null,
          dispatch_allowed: false,
        });
        expect(result.data_quality.incident_required).toBe(false);
      }
    },
  );

  it.each([
    [0, "monitor"],
    [1, "signal_only"],
    [6, "signal_only"],
  ] as const)(
    "does not require or inspect formal-only inputs at %s overdue days",
    (days, signalState) => {
      const input: Record<string, unknown> = {
        ...fixture({ time_deviation_working_days: days }),
        on_time_score: "not-a-score",
        role_assignments: "not-assignments",
      };
      const result = evaluatePowerPurchaseTimeliness(input);

      expect(result).toMatchObject({
        assessment_status: "complete",
        data_quality: {
          incident_required: false,
          issue_codes: [],
          missing_or_invalid_fields: [],
        },
        deviation: { signal_state: signalState },
        classification: { on_time_score: null, level: null },
        routing: {
          target_role: null,
          principal_id: null,
          routing_status: "not_required",
          dispatch_allowed: false,
        },
        external_dispatch_performed: false,
      });
    },
  );

  it.each(["on_time_score", "role_assignments"] as const)(
    "requires formal-only field %s after the formal threshold",
    (field) => {
      const input: Record<string, unknown> = { ...fixture() };
      delete input[field];
      const result = evaluatePowerPurchaseTimeliness(input);

      expect(result).toMatchObject({
        assessment_status: "indeterminate",
        applied_rules: [
          "PP-RULE-DQ-001",
          "PP-RULE-SCHEDULE-001",
          "PP-RULE-OVERDUE-001",
        ],
        data_quality: {
          incident_required: true,
          missing_or_invalid_fields: [field],
          business_warning_suppressed: true,
          responsibility_attribution_suppressed: true,
        },
        deviation: { signal_state: "formal_candidate" },
        classification: { on_time_score: null, level: null },
        routing: {
          routing_status: "routing_pending",
          dispatch_allowed: false,
        },
        external_dispatch_performed: false,
      });
    },
  );

  it("calculates schedule deviation only and leaves amount deviation disabled", () => {
    const behind = evaluatePowerPurchaseTimeliness(
      fixture({
        expected_completion_ratio: 0.7,
        actual_completion_ratio: 0.4,
      }),
    );
    const ahead = evaluatePowerPurchaseTimeliness(
      fixture({
        expected_completion_ratio: 0.4,
        actual_completion_ratio: 0.7,
      }),
    );

    expect(behind.deviation.schedule_deviation).toBeCloseTo(0.3, 12);
    expect(ahead.deviation.schedule_deviation).toBe(0);
    expect(behind.deviation).toMatchObject({
      amount_deviation: null,
      amount_deviation_computed: false,
    });
  });

  it.each(["case_id", "case_status", "time_deviation_working_days"] as const)(
    "fails closed and suppresses warning and attribution when %s is missing",
    (field) => {
      const incomplete: Record<string, unknown> = { ...fixture() };
      delete incomplete[field];
      const result = evaluatePowerPurchaseTimeliness(incomplete);

      expect(result.assessment_status).toBe("indeterminate");
      expect(result.data_quality).toEqual({
        incident_required: true,
        issue_codes: ["critical_input_missing_or_invalid"],
        missing_or_invalid_fields: [field],
        business_warning_suppressed: true,
        responsibility_attribution_suppressed: true,
      });
      expect(result.deviation).toMatchObject({
        schedule_deviation: null,
        amount_deviation: null,
        amount_deviation_computed: false,
        signal_state: "indeterminate",
      });
      expect(result.classification.level).toBeNull();
      expect(result.routing.dispatch_allowed).toBe(false);
      expect(result.external_dispatch_performed).toBe(false);
      expect(result.applied_rules).toEqual(["PP-RULE-DQ-001"]);
    },
  );

  it("uses a non-dispatching governance fallback and opens DQ when the exact role is unresolved", () => {
    const result = evaluatePowerPurchaseTimeliness(
      fixture({
        on_time_score: 0.6,
        role_assignments: [
          {
            governance_role: "planner",
            principal_id: "planner-01",
            resolution_status: "resolved",
          },
        ],
      }),
    );

    expect(result.assessment_status).toBe("complete");
    expect(result.classification.level).toBe("yellow");
    expect(result.data_quality).toMatchObject({
      incident_required: true,
      issue_codes: ["routing_target_unresolved"],
      business_warning_suppressed: false,
      responsibility_attribution_suppressed: true,
    });
    expect(result.routing).toEqual({
      target_role: "department_head",
      principal_id: null,
      routing_status: "routing_pending",
      fallback_used: true,
      fallback_kind: "governance_dq_queue",
      dispatch_allowed: false,
    });
    expect(result.external_dispatch_performed).toBe(false);
  });

  it("fails closed on malformed explicit values rather than coercing them", () => {
    const result = evaluatePowerPurchaseTimeliness({
      ...fixture(),
      on_time_score: "0.85",
    });
    expect(result.assessment_status).toBe("indeterminate");
    expect(result.data_quality.missing_or_invalid_fields).toEqual([
      "on_time_score",
    ]);
    expect(result.external_dispatch_performed).toBe(false);
  });

  it("is globally registered as a pure compute tool with a valid output contract", () => {
    const descriptor = globalToolRegistry.get(
      "powerPurchase.evaluateTimeliness",
    );
    const catalog = getGlobalToolCatalogEntry(
      "powerPurchase.evaluateTimeliness",
    );
    const decision = evaluatePowerPurchaseTimeliness(fixture());

    expect(descriptor).toMatchObject({
      kind: "tool",
      name: "powerPurchase.evaluateTimeliness",
    });
    expect(catalog).toMatchObject({
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      testPolicy: "allow",
      credentialPosture: "none",
      probeRequired: false,
    });
    expect(catalog?.capabilities).toBeUndefined();
    expect(descriptor?.inputSchema).not.toHaveProperty("required");
    expect(
      Object.values(catalog?.argsSchema ?? {}).every(
        (field) => field.required !== true,
      ),
    ).toBe(true);
    expect(
      powerPurchaseTimelinessOutputSchema.safeParse(decision).success,
    ).toBe(true);
  });

  it("executes through the global descriptor without any network dispatch", async () => {
    const descriptor = globalToolRegistry.get(
      "powerPurchase.evaluateTimeliness",
    );
    expect(descriptor).toBeDefined();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not be called"));
    try {
      const result = await descriptor!.handler({
        agentName: "shadow-test",
        actionName: "evaluate",
        tenantSlug: "power-purchase",
        event: {
          name: "POWER_PURCHASE_SHADOW_EVALUATE",
          data: fixture(),
        },
      } as never);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({
        assessment_status: "complete",
        external_dispatch_performed: false,
      });
      expect(result.meta).toMatchObject({
        deterministic: true,
        sideEffects: "none",
        externalCalls: 0,
        rules: [
          "PP-RULE-DQ-001",
          "PP-RULE-SCHEDULE-001",
          "PP-RULE-OVERDUE-001",
          "PP-RULE-CLASSIFIER-001",
          "PP-RULE-ROUTING-001",
        ],
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
