import { describe, expect, it } from "vitest";
import type { OntologyAction } from "./ontology-types";
import type { PlanStep } from "./spec-types";
import {
  analyzeExecutionPlanRequirement,
  normalizePlanAgainstOntology,
  validatePlanAgainstOntology,
} from "./ontology-execution";

function action(over: Partial<OntologyAction> = {}): OntologyAction {
  return {
    id: "9-1",
    name: "processResume",
    actor: ["Agent"],
    trigger: ["RESUME_DOWNLOADED"],
    triggered_event: ["RESUME_PROCESSED"],
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
    ...over,
  };
}

describe("ontology execution-plan readiness", () => {
  it("requires a plan from ontology facts, without domain/action allowlists", () => {
    const requirement = analyzeExecutionPlanRequirement(
      action({
        action_steps: [
          { name: "uploadResume", type: "tool", tool: "objectStore.getObject" },
          { name: "parseResume", type: "tool", tool: "parseResumeApi" },
          { name: "validateCompleteness", type: "logic" },
        ],
        integration: {
          systems: [
            {
              name: "RoboHire",
              role: "calls",
              capability: "POST /parse-resume",
            },
          ],
        },
        side_effects: {
          data_changes: [{ object_type: "Resume", action: "CREATE" }],
        },
      }),
    );
    expect(requirement.required).toBe(true);
    expect(requirement.ontologySteps.map((step) => step.stepId)).toEqual([
      "uploadResume",
      "parseResume",
      "validateCompleteness",
    ]);
    expect(requirement.ontologySteps.slice(0, 2)).toMatchObject([
      { kind: "tool", tool: "objectStore.getObject" },
      { kind: "tool", tool: "parseResumeApi" },
    ]);
    expect(requirement.reasons.join(" ")).toMatch(
      /action_steps|integration|mutation/,
    );
  });

  it("blocks an opaque plan and reports missing ontology operations", () => {
    const ontologyAction = action({
      action_steps: [{ name: "parseResume" }, { name: "persistResume" }],
    });
    expect(validatePlanAgainstOntology(ontologyAction, [])[0]).toMatch(
      /structured plan required/,
    );
    expect(
      validatePlanAgainstOntology(ontologyAction, [
        { stepId: "parseResume", kind: "logic" },
      ])[0],
    ).toMatch(/persistResume/);
    expect(
      validatePlanAgainstOntology(ontologyAction, [
        { stepId: "parseResume", kind: "logic" },
        { stepId: "persistResume", kind: "logic" },
      ]),
    ).toEqual([]);
  });

  it("rejects a plan that reuses ontology step ids with the wrong execution contract", () => {
    const ontologyAction = action({
      action_steps: [
        {
          step_id: "download",
          object_type: "tool",
          tool: "objectStore.getObject",
        },
        { step_id: "parse", object_type: "tool", tool: "parseResumeApi" },
        {
          step_id: "identity",
          object_type: "invoke",
          invoke: "ruleCheckForCandidateIdentity",
        },
        {
          step_id: "done",
          object_type: "emit",
          emit_event: "RESUME_PROCESSED",
        },
      ],
    });
    const validPlan = [
      {
        stepId: "download",
        kind: "tool" as const,
        tool: "objectStore.getObject",
      },
      { stepId: "parse", kind: "tool" as const, tool: "parseResumeApi" },
      {
        stepId: "identity",
        kind: "invoke" as const,
        invoke: "ruleCheckForCandidateIdentity",
      },
      { stepId: "done", kind: "emit" as const, emitEvent: "RESUME_PROCESSED" },
    ];
    expect(validatePlanAgainstOntology(ontologyAction, validPlan)).toEqual([]);

    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "download"
            ? { ...step, kind: "logic" as const }
            : step,
        ),
      ).join(" "),
    ).toMatch(/download.*kind mismatch/);
    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "parse" ? { ...step, tool: "someOtherParser" } : step,
        ),
      ).join(" "),
    ).toMatch(/parse.*tool mismatch/);
    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "identity"
            ? { ...step, invoke: "someOtherAgent" }
            : step,
        ),
      ).join(" "),
    ).toMatch(/identity.*invoke mismatch/);
    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "done"
            ? { ...step, emitEvent: "RESUME_FAILED" }
            : step,
        ),
      ).join(" "),
    ).toMatch(/done.*emitEvent mismatch/);
  });

  it("preserves authoritative conditional emit dependencies and payload routing", () => {
    const ontologyAction = action({
      triggered_event: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"],
      action_steps: [
        { step_id: "select_outcome", object_type: "logic" },
        {
          step_id: "emit_processed",
          object_type: "emit",
          emit_event: "RESUME_PROCESSED",
          condition:
            'results.select_outcome.selected_event == "RESUME_PROCESSED"',
          depends_on: ["select_outcome"],
          emit_payload_from: "results.select_outcome.payload",
        },
      ],
    });
    const validPlan = [
      { stepId: "select_outcome", kind: "logic" as const },
      {
        stepId: "emit_processed",
        kind: "emit" as const,
        emitEvent: "RESUME_PROCESSED",
        condition:
          'results.select_outcome.selected_event == "RESUME_PROCESSED"',
        dependsOn: ["select_outcome"],
        emitPayloadFrom: "results.select_outcome.payload",
      },
    ];

    expect(validatePlanAgainstOntology(ontologyAction, validPlan)).toEqual([]);
    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "emit_processed"
            ? { ...step, condition: "input.ready == true" }
            : step,
        ),
      ).join(" "),
    ).toMatch(/condition mismatch/);
    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "emit_processed" ? { ...step, dependsOn: [] } : step,
        ),
      ).join(" "),
    ).toMatch(/dependsOn mismatch/);
    expect(
      validatePlanAgainstOntology(
        ontologyAction,
        validPlan.map((step) =>
          step.stepId === "emit_processed"
            ? { ...step, emitPayloadFrom: undefined }
            : step,
        ),
      ).join(" "),
    ).toMatch(/emitPayloadFrom mismatch/);
  });

  it("does not pretend to compile a prose-only source condition into authoritative code", () => {
    const ontologyAction = action({
      action_steps: [
        {
          step_id: "generate_jd_content",
          object_type: "logic",
        },
        {
          step_id: "persist_job_posting",
          object_type: "emit",
          emit_event: "RESUME_PROCESSED",
          condition: "job_posting_id 已返回",
          depends_on: ["generate_jd_content"],
        },
      ],
    });

    const honestPlan = [
      { stepId: "generate_jd_content", kind: "logic" as const },
      {
        stepId: "persist_job_posting",
        kind: "emit" as const,
        emitEvent: "RESUME_PROCESSED",
        dependsOn: ["generate_jd_content"],
      },
    ];
    // Prose remains review evidence. The plan is not required to pretend it
    // can compile that prose into a machine predicate.
    expect(validatePlanAgainstOntology(ontologyAction, honestPlan)).toEqual([]);

    const invented = validatePlanAgainstOntology(
      ontologyAction,
      honestPlan.map((step) =>
        step.stepId === "persist_job_posting"
          ? {
              ...step,
              condition: "results.generate_jd_content.result.confidence > 0.8",
            }
          : step,
      ),
    );
    expect(invented.join(" ")).toMatch(
      /persist_job_posting.*invented\/untrusted.*non-executable prose/i,
    );
    expect(
      analyzeExecutionPlanRequirement(ontologyAction).ontologySteps[1],
    ).toMatchObject({ condition: "job_posting_id 已返回" });
  });

  it("deterministically restores source-owned logic routers and guarded emits", () => {
    const ontologyAction = action({
      triggered_event: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"],
      action_steps: [
        {
          step_id: "emit_resume_outcome",
          object_type: "logic",
          condition: "候选人与简历已持久化",
        },
        {
          step_id: "emit_resume_processed",
          object_type: "emit",
          emit_event: "RESUME_PROCESSED",
          condition:
            'results.emit_resume_outcome.selected_event == "RESUME_PROCESSED"',
          depends_on: ["emit_resume_outcome"],
          emit_payload_from: "results.emit_resume_outcome.payload",
        },
        {
          step_id: "emit_resume_locked_conflict",
          object_type: "emit",
          emit_event: "RESUME_LOCKED_CONFLICT",
          condition:
            'results.emit_resume_outcome.selected_event == "RESUME_LOCKED_CONFLICT"',
          depends_on: ["emit_resume_outcome"],
          emit_payload_from: "results.emit_resume_outcome.payload",
        },
      ],
    });
    const drifted = [
      {
        stepId: "emit_resume_outcome",
        kind: "condition" as const,
        condition: "input.passed == true",
        routes: {
          onTrue: "RESUME_PROCESSED",
          onFalse: "RESUME_LOCKED_CONFLICT",
        },
      },
      {
        stepId: "emit_resume_processed",
        kind: "emit" as const,
        emitEvent: "RESUME_PROCESSED",
        condition: "input.passed == true",
      },
      {
        stepId: "emit_resume_locked_conflict",
        kind: "emit" as const,
        emitEvent: "RESUME_LOCKED_CONFLICT",
        condition: "input.passed == false",
      },
    ];

    const normalized = normalizePlanAgainstOntology(ontologyAction, drifted);
    expect(normalized).toEqual([
      { stepId: "emit_resume_outcome", kind: "logic" },
      {
        stepId: "emit_resume_processed",
        kind: "emit",
        emitEvent: "RESUME_PROCESSED",
        condition:
          'results.emit_resume_outcome.selected_event == "RESUME_PROCESSED"',
        dependsOn: ["emit_resume_outcome"],
        emitPayloadFrom: "results.emit_resume_outcome.payload",
      },
      {
        stepId: "emit_resume_locked_conflict",
        kind: "emit",
        emitEvent: "RESUME_LOCKED_CONFLICT",
        condition:
          'results.emit_resume_outcome.selected_event == "RESUME_LOCKED_CONFLICT"',
        dependsOn: ["emit_resume_outcome"],
        emitPayloadFrom: "results.emit_resume_outcome.payload",
      },
    ]);
    expect(validatePlanAgainstOntology(ontologyAction, normalized)).toEqual([]);
    expect(normalizePlanAgainstOntology(ontologyAction, normalized)).toEqual(
      normalized,
    );
  });

  it("restores source-owned tool, invoke, and emit identities by stable stepId", () => {
    const ontologyAction = action({
      triggered_event: ["RESUME_PROCESSED"],
      action_steps: [
        {
          step_id: "load_resume",
          object_type: "tool",
          tool: "fs.readFromInbox",
        },
        {
          step_id: "check_identity",
          object_type: "invoke",
          invoke: "ruleCheckForCandidateIdentity",
        },
        {
          step_id: "emit_processed",
          object_type: "emit",
          emit_event: "RESUME_PROCESSED",
        },
      ],
    });
    const normalized = normalizePlanAgainstOntology(ontologyAction, [
      {
        stepId: "load_resume",
        kind: "logic",
        tool: "invented.reader",
      },
      {
        stepId: "check_identity",
        kind: "logic",
        invoke: "inventedAgent",
      },
      {
        stepId: "emit_processed",
        kind: "emit",
        emitEvent: "INVENTED_EVENT",
      },
    ] as PlanStep[]);

    expect(normalized).toEqual([
      { stepId: "load_resume", kind: "tool", tool: "fs.readFromInbox" },
      {
        stepId: "check_identity",
        kind: "invoke",
        invoke: "ruleCheckForCandidateIdentity",
      },
      {
        stepId: "emit_processed",
        kind: "emit",
        emitEvent: "RESUME_PROCESSED",
      },
    ]);
  });

  it("removes invented executable guards when the source condition is prose", () => {
    const ontologyAction = action({
      action_steps: [
        {
          step_id: "generate_jd_content",
          object_type: "logic",
        },
        {
          step_id: "emit_jd_generated",
          object_type: "emit",
          emit_event: "RESUME_PROCESSED",
          condition: "job_posting_id 已返回",
        },
      ],
    });
    const normalized = normalizePlanAgainstOntology(ontologyAction, [
      { stepId: "generate_jd_content", kind: "logic" },
      {
        stepId: "emit_jd_generated",
        kind: "emit",
        emitEvent: "RESUME_PROCESSED",
        condition: "results.generate_jd_content.result.confidence > 0.8",
      },
    ]);

    expect(normalized[1]).not.toHaveProperty("condition");
    expect(validatePlanAgainstOntology(ontologyAction, normalized)).toEqual([]);
  });

  it("keeps legacy action_steps without execution identity backward-compatible", () => {
    const ontologyAction = action({
      action_steps: [
        { step_id: "legacy-step", description: "historical prose-only step" },
      ],
    });
    expect(
      validatePlanAgainstOntology(ontologyAction, [
        { stepId: "legacy-step", kind: "logic" },
      ]),
    ).toEqual([]);
  });

  it("requires integration boundaries to remain separate replayable tool/invoke steps", () => {
    const ontologyAction = action({
      action_steps: [{ name: "evaluate", type: "logic" }],
      integration: {
        systems: [
          { name: "Vendor", role: "calls" },
          { name: "Primary DB", role: "writes" },
        ],
      },
    });
    const tooFlat = validatePlanAgainstOntology(ontologyAction, [
      { stepId: "evaluate", kind: "logic" },
    ]);
    expect(tooFlat.join(" ")).toMatch(/2 integration system boundary/);
    expect(
      validatePlanAgainstOntology(ontologyAction, [
        { stepId: "callVendor", kind: "tool", tool: "vendor.call" },
        { stepId: "evaluate", kind: "logic" },
        { stepId: "persist", kind: "tool", tool: "records.upsert" },
      ]),
    ).toEqual([]);
  });

  it("normalizes unsafe ontology labels to addressable stable ids", () => {
    const requirement = analyzeExecutionPlanRequirement(
      action({ action_steps: [{ name: "解析简历" }, { name: "save resume" }] }),
    );
    expect(requirement.ontologySteps.map((step) => step.stepId)).toEqual([
      "ontology-step-1",
      "ontology-step-2",
    ]);
  });

  it("does not mistake an external trigger source for a handler-side tool boundary", () => {
    const requirement = analyzeExecutionPlanRequirement(
      action({ integration: { systems: [{ name: "HSM", role: "triggers" }] } }),
    );
    expect(requirement.integrationSystems).toHaveLength(1);
    expect(requirement.replayableIntegrationCount).toBe(0);
    expect(requirement.required).toBe(false);
  });

  it("does not collapse a prose-only business procedure into an implicit single logic step", () => {
    const ontologyAction = action({
      instruction:
        "读取对象存储，调用外部解析服务，写入权威记录后发送结果事件。",
    });
    const requirement = analyzeExecutionPlanRequirement(ontologyAction);
    expect(requirement).toMatchObject({
      required: true,
      unstructuredInstruction: true,
    });
    expect(validatePlanAgainstOntology(ontologyAction, [])[0]).toMatch(
      /structured plan required/,
    );
    expect(
      validatePlanAgainstOntology(ontologyAction, [
        { stepId: "reviewed-procedure", kind: "logic" },
      ]),
    ).toEqual([]);
  });
});
