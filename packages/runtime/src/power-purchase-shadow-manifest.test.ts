import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentDefinitionV2 } from "@agentic/contracts";
import { describe, expect, it } from "vitest";

import { bindTriggerInputs, validateAgentInputs } from "./agent-execution";
import { createBufferedTraceSink } from "./execution-trace";
import { lint } from "./lint";
import { loadManifestFromDisk } from "./manifest";
import { runAction } from "./step-engine";

const runtimeSourceDir = path.dirname(fileURLToPath(import.meta.url));
const modelDir = path.resolve(
  runtimeSourceDir,
  "../../../models/power-purchase-v1",
);

const expectedAgentIds = [
  "power-purchase-case-assessment",
  "procurement-evidence-analyst",
  "power-purchase-cause-assessment-router",
  "procurement-timeliness-agent",
  "power-purchase-remediation-proposal-router",
  "power-purchase-remediation-shadow-review",
  "power-purchase-remediation-shadow-guard",
  "procurement-dq-triage-assistant",
  "procurement-alert-briefing-assistant",
  "procurement-execution-reconciliation-assistant",
  "procurement-feedback-review-assistant",
] as const;

const lowPrivilegeAgentIds = [
  "procurement-evidence-analyst",
  "procurement-timeliness-agent",
  "procurement-dq-triage-assistant",
  "procurement-alert-briefing-assistant",
  "procurement-execution-reconciliation-assistant",
  "procurement-feedback-review-assistant",
] as const;

function formalCaseSnapshot(
  roleAssignments: Array<Record<string, unknown>> = [
    {
      governance_role: "department_head",
      principal_id: "department-head-01",
      resolution_status: "resolved",
    },
  ],
) {
  return {
    case_id: "PBP-LINE-001@DELIVERY-01",
    case_status: "executing",
    expected_completion_ratio: 0.8,
    actual_completion_ratio: 0.6,
    time_deviation_working_days: 7,
    formal_threshold_working_days: 7,
    on_time_score: 0.6,
    role_assignments: roleAssignments,
  };
}

describe("Power-Purchase shadow runtime model", () => {
  it("loads the exact eleven-runtime-unit v2 manifest", async () => {
    const loaded = await loadManifestFromDisk(modelDir);

    expect(path.basename(loaded.manifestPath)).toBe("workflow_v1.json");
    expect(loaded.manifest.map((agent) => agent.id)).toEqual(expectedAgentIds);
    expect(
      loaded.manifest
        .filter((unit) =>
          unit.actions.some((action) => action.type === "logic"),
        )
        .map((unit) => unit.id),
    ).toEqual([...lowPrivilegeAgentIds]);
    expect(
      loaded.manifest
        .filter(
          (unit) =>
            unit.actor.includes("Agent") &&
            unit.actions.every(
              (action) => action.type !== "logic" && action.type !== "manual",
            ),
        )
        .map((unit) => unit.id),
    ).toEqual([
      "power-purchase-case-assessment",
      "power-purchase-cause-assessment-router",
      "power-purchase-remediation-proposal-router",
      "power-purchase-remediation-shadow-guard",
    ]);
    expect(
      loaded.manifest
        .filter((unit) =>
          unit.actions.some((action) => action.type === "manual"),
        )
        .map((unit) => unit.id),
    ).toEqual(["power-purchase-remediation-shadow-review"]);

    const lintResult = lint(loaded.manifest, {
      llmProviders: ["openai", "anthropic", "azure", "google", "custom"],
      concurrencyMax: 1_000,
    });
    expect(
      lintResult.issues.filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(
      lintResult.conflicts.filter((conflict) => conflict.severity === "block"),
    ).toEqual([]);

    for (const unit of loaded.manifest) {
      expect(
        unit.extensions?.compatibility_mode,
        `${unit.id} must remain a native v2 unit rather than a v1-normalized fallback`,
      ).not.toBe("v1");
      expect(
        unit.output_config?.artifact.persist_run_input,
        `${unit.id} must not persist confidential raw input`,
      ).toBe(false);
      expect(
        unit.observability?.retention_days,
        `${unit.id} must use the local-shadow retention ceiling`,
      ).toBe(30);
    }
  });

  it("grants only the pure deterministic evaluator", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);
    const declaredTools = manifest.flatMap((agent) =>
      (agent.tool_use ?? []).map((tool) => tool.name),
    );
    const toolActions = manifest.flatMap((agent) =>
      agent.actions
        .filter((action) => action.type === "tool")
        .map((action) => ({ agent: agent.id, action })),
    );

    expect(declaredTools).toEqual(["powerPurchase.evaluateTimeliness"]);
    expect(toolActions).toHaveLength(1);
    expect(toolActions[0]).toMatchObject({
      agent: "power-purchase-case-assessment",
      action: {
        name: "powerPurchase.evaluateTimeliness",
        tool: "powerPurchase.evaluateTimeliness",
        allowed_tools: ["powerPurchase.evaluateTimeliness"],
      },
    });
    expect(
      manifest
        .flatMap((agent) => agent.actions)
        .flatMap((action) => action.allowed_tools ?? [])
        .filter((tool) => tool !== "powerPurchase.evaluateTimeliness"),
    ).toEqual([]);
  });

  it("keeps every LLM assistant structured, tool-less and proposal-only", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);

    for (const id of lowPrivilegeAgentIds) {
      const agent = manifest.find((candidate) => candidate.id === id) as
        | AgentDefinitionV2
        | undefined;
      expect(agent, id).toBeDefined();
      expect(agent?.temperature, id).toBe(0);
      expect(agent?.tool_use, id).toEqual([]);
      expect(agent?.output_config?.strict, id).toBe(true);
      expect(agent?.output_config?.artifact.persist_raw_response, id).toBe(
        false,
      );
      expect(agent?.output_config?.artifact.persist_run_input, id).toBe(false);
      expect(agent?.observability?.retention_days, id).toBe(30);
      expect(agent?.actions, id).toHaveLength(1);
      expect(agent?.actions[0], id).toMatchObject({
        type: "logic",
        allowed_tools: [],
      });
      expect(String(agent?.extensions?.grant ?? ""), id).toContain("only");
    }
  });

  it("closes the shadow event chain through deterministic routers", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);
    const byId = (id: string) => {
      const unit = manifest.find((candidate) => candidate.id === id);
      expect(unit, id).toBeDefined();
      return unit!;
    };

    const evidence = byId("procurement-evidence-analyst");
    const causeRouter = byId("power-purchase-cause-assessment-router");
    const planner = byId("procurement-timeliness-agent");
    const proposalRouter = byId("power-purchase-remediation-proposal-router");
    const review = byId("power-purchase-remediation-shadow-review");
    const guard = byId("power-purchase-remediation-shadow-guard");

    expect(evidence.trigger).toContain(
      "POWER_PURCHASE_REMEDIATION_SUPPLEMENT_REQUESTED",
    );
    expect(
      evidence.output_bindings?.POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED,
    ).toMatchObject({
      case_id: { output: "result", path: "$.case_id" },
      case_context: { input: "case_context" },
      cause_assessment: { output: "result" },
    });
    expect(causeRouter.trigger).toEqual([
      "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
    ]);
    expect(causeRouter.triggered_event).toEqual(
      expect.arrayContaining([
        "POWER_PURCHASE_CAUSE_ASSESSMENT_ACCEPTED",
        "POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED",
      ]),
    );
    expect(planner.trigger).toEqual([
      "POWER_PURCHASE_CAUSE_ASSESSMENT_ACCEPTED",
    ]);
    expect(planner.inputs.map((input) => input.id)).toEqual(
      expect.arrayContaining(["context", "case_context", "cause_assessment"]),
    );
    expect(planner.outputs[0]?.schema).toMatchObject({
      required: expect.arrayContaining(["schema", "ontology_binding_status"]),
      properties: {
        schema: {
          const: "agentic-operator.power-purchase-remediation-shadow-dto/v1",
        },
        ontology_binding_status: { const: "not_bound" },
        executable: { const: false },
      },
    });
    expect(proposalRouter.trigger).toEqual([
      "POWER_PURCHASE_REMEDIATION_PROPOSED",
    ]);
    expect(proposalRouter.triggered_event).toEqual(
      expect.arrayContaining([
        "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_READY",
        "POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED",
      ]),
    );
    expect(review.trigger).toEqual([
      "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_READY",
    ]);
    expect(guard.triggered_event).toContain(
      "POWER_PURCHASE_REMEDIATION_SUPPLEMENT_REQUESTED",
    );
  });

  it("treats human review as shadow review and always blocks approved execution", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);
    const review = manifest.find(
      (agent) => agent.id === "power-purchase-remediation-shadow-review",
    ) as AgentDefinitionV2 | undefined;
    const guard = manifest.find(
      (agent) => agent.id === "power-purchase-remediation-shadow-guard",
    ) as AgentDefinitionV2 | undefined;

    expect(review?.actor).toEqual(["Human"]);
    expect(review?.extensions).toMatchObject({
      deployment_mode: "shadow_decision_assist",
      business_approval: false,
      external_execution_authority: false,
    });
    expect(review?.actions[0]).toMatchObject({
      type: "manual",
      awaiting_role: "operator",
    });
    expect(review?.trigger).toEqual([
      "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_READY",
    ]);

    expect(guard?.tool_use).toEqual([]);
    expect(guard?.actions.some((action) => action.type === "tool")).toBe(false);
    expect(guard?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "emit",
          emit_event: "POWER_PURCHASE_EXTERNAL_EXECUTION_BLOCKED",
          emit_payload: expect.objectContaining({
            status: "blocked_by_capability_gate",
            real_metaerp_dispatch: false,
            review_kind: "shadow",
            business_approval: false,
            execution_attempted: false,
            external_execution_authority: false,
          }),
        }),
      ]),
    );
  });

  it("routes cause and proposal abstentions without creating a review-ready event", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);
    const unit = (id: string) => {
      const found = manifest.find((candidate) => candidate.id === id) as
        | AgentDefinitionV2
        | undefined;
      expect(found, id).toBeDefined();
      return found!;
    };
    const run = (
      definition: AgentDefinitionV2,
      actionId: string,
      eventName: string,
      eventData: Record<string, unknown>,
    ) => {
      const action = definition.actions.find(
        (candidate) => candidate.id === actionId,
      );
      expect(action, `${definition.id}/${actionId}`).toBeDefined();
      const bound = bindTriggerInputs(definition, {
        name: eventName,
        data: eventData,
        subject: "PBP-LINE-001@DELIVERY-01",
      });
      const validated = validateAgentInputs(definition, bound).values;
      return runAction({
        runId: `run-${definition.id}-${actionId}`,
        stepId: `step-${definition.id}-${actionId}`,
        trace: createBufferedTraceSink(),
        ctx: {
          agentName: definition.name,
          actionName: action!.name,
          correlationId: "power-purchase-router-test",
          tenantSlug: "power-purchase",
          event: {
            name: eventName,
            data: { ...eventData, inputs: validated },
          },
          results: {},
        },
        action: action!,
        agent: definition,
        tenantRegistry: {},
      });
    };

    const caseContext = {
      case_id: "PBP-LINE-001@DELIVERY-01",
      classification: { level: "yellow" },
    };
    const causeRouter = unit("power-purchase-cause-assessment-router");
    const causeEvent = (
      assessmentStatus: "suspected" | "unknown" | "abstain_data_quality",
    ) => ({
      case_id: caseContext.case_id,
      case_context: caseContext,
      cause_assessment: {
        case_id: caseContext.case_id,
        assessment_status: assessmentStatus,
      },
    });

    await expect(
      run(
        causeRouter,
        "suspected-gate",
        "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
        causeEvent("suspected"),
      ),
    ).resolves.toMatchObject({ data: { evaluated: true } });
    await expect(
      run(
        causeRouter,
        "emit-cause-accepted",
        "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
        causeEvent("suspected"),
      ),
    ).resolves.toMatchObject({
      type: "emit",
      meta: {
        emitted: [
          {
            event: "POWER_PURCHASE_CAUSE_ASSESSMENT_ACCEPTED",
            payload: expect.objectContaining({
              case_context: caseContext,
              cause_assessment: expect.objectContaining({
                assessment_status: "suspected",
              }),
            }),
          },
        ],
      },
    });

    for (const assessmentStatus of [
      "unknown",
      "abstain_data_quality",
    ] as const) {
      await expect(
        run(
          causeRouter,
          "cause-dq-gate",
          "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
          causeEvent(assessmentStatus),
        ),
      ).resolves.toMatchObject({ data: { evaluated: true } });
      const dq = await run(
        causeRouter,
        "emit-cause-dq",
        "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
        causeEvent(assessmentStatus),
      );
      expect(dq).toMatchObject({
        type: "emit",
        meta: {
          emitted: [
            {
              event: "POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED",
              payload: expect.objectContaining({
                dq_source: "cause_assessment_router",
                business_path_suppressed: true,
              }),
            },
          ],
        },
      });
      expect(
        (dq.meta as { emitted?: Array<{ event: string }> }).emitted,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "POWER_PURCHASE_CAUSE_ASSESSMENT_ACCEPTED",
          }),
        ]),
      );
    }

    const invalidCause = causeEvent("unknown") as Record<string, unknown>;
    invalidCause.cause_assessment = {
      case_id: caseContext.case_id,
      assessment_status: "confirmed",
    };
    expect(() =>
      validateAgentInputs(
        causeRouter,
        bindTriggerInputs(causeRouter, {
          name: "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
          data: invalidCause,
          subject: caseContext.case_id,
        }),
      ),
    ).toThrow();
    const missingCauseStatus = causeEvent("unknown") as Record<string, unknown>;
    missingCauseStatus.cause_assessment = {
      case_id: caseContext.case_id,
    };
    expect(() =>
      validateAgentInputs(
        causeRouter,
        bindTriggerInputs(causeRouter, {
          name: "POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED",
          data: missingCauseStatus,
          subject: caseContext.case_id,
        }),
      ),
    ).toThrow();

    const proposalRouter = unit("power-purchase-remediation-proposal-router");
    const proposalEvent = (status: "proposal" | "abstain_data_quality") => ({
      case_id: caseContext.case_id,
      case_context: caseContext,
      cause_assessment: {
        case_id: caseContext.case_id,
        assessment_status: "suspected",
      },
      shadow_proposal: {
        schema: "agentic-operator.power-purchase-remediation-shadow-dto/v1",
        ontology_binding_status: "not_bound",
        case_id: caseContext.case_id,
        status,
        executable: false,
        human_approval_required: true,
      },
    });

    await expect(
      run(
        proposalRouter,
        "proposal-gate",
        "POWER_PURCHASE_REMEDIATION_PROPOSED",
        proposalEvent("proposal"),
      ),
    ).resolves.toMatchObject({ data: { evaluated: true } });
    await expect(
      run(
        proposalRouter,
        "emit-review-ready",
        "POWER_PURCHASE_REMEDIATION_PROPOSED",
        proposalEvent("proposal"),
      ),
    ).resolves.toMatchObject({
      type: "emit",
      meta: {
        emitted: [
          {
            event: "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_READY",
            payload: expect.objectContaining({
              shadow_proposal: expect.objectContaining({
                status: "proposal",
                ontology_binding_status: "not_bound",
              }),
            }),
          },
        ],
      },
    });

    await expect(
      run(
        proposalRouter,
        "proposal-dq-gate",
        "POWER_PURCHASE_REMEDIATION_PROPOSED",
        proposalEvent("abstain_data_quality"),
      ),
    ).resolves.toMatchObject({ data: { evaluated: true } });
    const proposalDq = await run(
      proposalRouter,
      "emit-proposal-dq",
      "POWER_PURCHASE_REMEDIATION_PROPOSED",
      proposalEvent("abstain_data_quality"),
    );
    expect(proposalDq).toMatchObject({
      type: "emit",
      meta: {
        emitted: [
          {
            event: "POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED",
            payload: expect.objectContaining({
              dq_source: "remediation_proposal_router",
              business_path_suppressed: true,
            }),
          },
        ],
      },
    });
    expect(
      (proposalDq.meta as { emitted?: Array<{ event: string }> }).emitted,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_READY",
        }),
      ]),
    );

    const invalidProposal = proposalEvent("proposal") as Record<
      string,
      unknown
    >;
    invalidProposal.shadow_proposal = {
      ...(invalidProposal.shadow_proposal as Record<string, unknown>),
      status: "approved",
    };
    expect(() =>
      validateAgentInputs(
        proposalRouter,
        bindTriggerInputs(proposalRouter, {
          name: "POWER_PURCHASE_REMEDIATION_PROPOSED",
          data: invalidProposal,
          subject: caseContext.case_id,
        }),
      ),
    ).toThrow();
    const missingProposalStatus = proposalEvent("proposal") as Record<
      string,
      unknown
    >;
    const shadowProposalWithoutStatus = {
      ...(missingProposalStatus.shadow_proposal as Record<string, unknown>),
    };
    delete shadowProposalWithoutStatus.status;
    missingProposalStatus.shadow_proposal = shadowProposalWithoutStatus;
    expect(() =>
      validateAgentInputs(
        proposalRouter,
        bindTriggerInputs(proposalRouter, {
          name: "POWER_PURCHASE_REMEDIATION_PROPOSED",
          data: missingProposalStatus,
          subject: caseContext.case_id,
        }),
      ),
    ).toThrow();
  });

  it("routes approve, reject and supplement through the shadow guard", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);
    const guard = manifest.find(
      (candidate) => candidate.id === "power-purchase-remediation-shadow-guard",
    ) as AgentDefinitionV2 | undefined;
    const evidence = manifest.find(
      (candidate) => candidate.id === "procurement-evidence-analyst",
    ) as AgentDefinitionV2 | undefined;
    expect(guard).toBeDefined();
    expect(evidence).toBeDefined();

    const caseContext = { case_id: "PBP-LINE-001@DELIVERY-01" };
    const proposal = {
      case_id: caseContext.case_id,
      case_context: caseContext,
      cause_assessment: {
        case_id: caseContext.case_id,
        assessment_status: "suspected",
      },
      shadow_proposal: {
        schema: "agentic-operator.power-purchase-remediation-shadow-dto/v1",
        ontology_binding_status: "not_bound",
        case_id: caseContext.case_id,
        status: "proposal",
        executable: false,
        human_approval_required: true,
      },
    };
    const guardEvent = (decision: "approve" | "reject" | "supplement") => ({
      decision: {
        task_id: `task-${decision}`,
        status: "resolved",
        decision,
        outcome:
          decision === "approve"
            ? "approved"
            : decision === "reject"
              ? "rejected"
              : "supplemented",
        payload: {
          decision,
          review_note: `${decision} in shadow`,
          reviewed_evidence_ids: ["evidence-1"],
        },
      },
      proposal,
      production_authority: false,
    });
    const run = (actionId: string, data: Record<string, unknown>) => {
      const action = guard!.actions.find(
        (candidate) => candidate.id === actionId,
      );
      expect(action, actionId).toBeDefined();
      const bound = bindTriggerInputs(guard!, {
        name: "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_RESOLVED",
        data,
        subject: caseContext.case_id,
      });
      const validated = validateAgentInputs(guard!, bound).values;
      return runAction({
        runId: `run-shadow-guard-${actionId}`,
        stepId: `step-shadow-guard-${actionId}`,
        trace: createBufferedTraceSink(),
        ctx: {
          agentName: guard!.name,
          actionName: action!.name,
          correlationId: "power-purchase-shadow-guard-test",
          tenantSlug: "power-purchase",
          event: {
            name: "POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_RESOLVED",
            data: { ...data, inputs: validated },
          },
          results: {},
        },
        action: action!,
        agent: guard!,
        tenantRegistry: {},
      });
    };

    const branches = [
      {
        decision: "approve" as const,
        gate: "approved-gate",
        emit: "emit-blocked",
        event: "POWER_PURCHASE_EXTERNAL_EXECUTION_BLOCKED",
      },
      {
        decision: "reject" as const,
        gate: "rejected-gate",
        emit: "emit-rejected",
        event: "POWER_PURCHASE_REMEDIATION_REJECTED",
      },
      {
        decision: "supplement" as const,
        gate: "supplement-gate",
        emit: "emit-supplement",
        event: "POWER_PURCHASE_REMEDIATION_SUPPLEMENT_REQUESTED",
      },
    ];

    for (const branch of branches) {
      const data = guardEvent(branch.decision);
      await expect(run(branch.gate, data)).resolves.toMatchObject({
        data: { evaluated: true },
      });
      const emitted = await run(branch.emit, data);
      expect(emitted).toMatchObject({
        type: "emit",
        meta: { emitted: [{ event: branch.event }] },
      });

      if (branch.decision === "approve") {
        expect(emitted).toMatchObject({
          meta: {
            emitted: [
              {
                payload: expect.objectContaining({
                  status: "blocked_by_capability_gate",
                  review_kind: "shadow",
                  business_approval: false,
                  execution_attempted: false,
                  external_execution_authority: false,
                  real_metaerp_dispatch: false,
                }),
              },
            ],
          },
        });
      }

      if (branch.decision === "supplement") {
        const supplementPayload = (
          emitted.meta as {
            emitted?: Array<{ payload: Record<string, unknown> }>;
          }
        ).emitted?.[0]?.payload;
        expect(supplementPayload).toBeDefined();
        const rebound = validateAgentInputs(
          evidence!,
          bindTriggerInputs(evidence!, {
            name: "POWER_PURCHASE_REMEDIATION_SUPPLEMENT_REQUESTED",
            data: supplementPayload!,
            subject: caseContext.case_id,
          }),
        ).values;
        expect(rebound.case_context).toEqual(caseContext);
      }
    }

    const invalid = guardEvent("approve") as Record<string, unknown>;
    invalid.decision = {
      ...(invalid.decision as Record<string, unknown>),
      decision: "unknown",
    };
    for (const gate of ["approved-gate", "rejected-gate", "supplement-gate"]) {
      await expect(run(gate, invalid)).resolves.toMatchObject({
        data: { evaluated: false },
      });
    }
  });

  it("pins the ontology package and denies every external binding", async () => {
    const overlay = JSON.parse(
      await readFile(path.join(modelDir, "activation-overlay_v1.json"), "utf8"),
    ) as {
      source: { package_hash: string; release: string };
      runtime_manifest: {
        sha256: string;
        runtime_unit_count: number;
        llm_assistant_count: number;
        deterministic_machine_unit_count: number;
        human_shadow_review_unit_count: number;
        persist_run_input: boolean;
        persist_raw_response: boolean;
        retention_days: number;
        admission_status: string;
      };
      runtime_scope: Record<string, string>;
      agents: Array<{ id: string; grant: string }>;
      allowed_tools: Array<{ name: string; effect_scope: string }>;
      external_action_bindings: Array<{ action_id: string; adapter: string }>;
      approvals: Record<string, string>;
    };

    expect(overlay.source).toMatchObject({
      release: "1.0.3",
      package_hash:
        "sha256:893a26cf8c65b4194023301269f246d43f74fc75a181d78731cc9dd273b8ca1c",
    });
    expect(overlay.runtime_manifest).toEqual({
      path: "models/power-purchase-v1/workflow_v1.json",
      sha256:
        "7f5076e94a2973175b6fbe9c1e0348634aa7fbc17bf4df5c8c868c61b504c533",
      runtime_unit_count: 11,
      llm_assistant_count: 6,
      deterministic_machine_unit_count: 4,
      human_shadow_review_unit_count: 1,
      persist_run_input: false,
      persist_raw_response: false,
      retention_days: 30,
      admission_status: "descriptive_receipt_not_runtime_enforced",
    });
    expect(
      overlay.agents.find(
        (agent) => agent.id === "procurement-timeliness-agent",
      )?.grant,
    ).toBe("internal_unbound_shadow_remediation_dto_only");
    expect(overlay.runtime_scope).toMatchObject({
      production_activation: "denied",
      candidate_runtime_plan_import: "denied",
      real_metaerp_network: "denied",
      real_business_notifications: "denied",
    });
    expect(overlay.allowed_tools).toEqual([
      expect.objectContaining({
        name: "powerPurchase.evaluateTimeliness",
        effect_scope: "none",
      }),
    ]);
    expect(overlay.external_action_bindings).toHaveLength(15);
    expect(
      new Set(
        overlay.external_action_bindings.map((binding) => binding.action_id),
      ).size,
    ).toBe(15);
    expect(
      overlay.external_action_bindings.every(
        (binding) => binding.adapter === "deny",
      ),
    ).toBe(true);
    expect(overlay.approvals).toMatchObject({
      architecture: "approved_r1_local_fixture_shadow_only",
      agentic_engineering: "approved_r1_local_fixture_shadow_only",
      product_owner: "conditionally_approved_r1_local_fixture_shadow_only",
      security: "pending",
      ontology_release_1_1_0: "not_publishable_agent_family_governance_missing",
      customer_business_owner: "pending",
      production_activation: "rejected",
    });
  });

  it("executes the deterministic formal and DQ branches through the real step engine", async () => {
    const { manifest } = await loadManifestFromDisk(modelDir);
    const agent = manifest.find(
      (candidate) => candidate.id === "power-purchase-case-assessment",
    );
    expect(agent).toBeDefined();
    const action = (id: string) => {
      const found = agent?.actions.find((candidate) => candidate.id === id);
      expect(found, id).toBeDefined();
      return found!;
    };
    const run = (
      actionId: string,
      data: Record<string, unknown>,
      results: Record<string, unknown> = {},
    ) =>
      runAction({
        runId: `run-${actionId}`,
        stepId: `step-${actionId}`,
        trace: createBufferedTraceSink(),
        ctx: {
          agentName: agent!.name,
          actionName: action(actionId).name,
          correlationId: "power-purchase-shadow-test",
          tenantSlug: "power-purchase",
          event: {
            name: "POWER_PURCHASE_CASE_SNAPSHOT_OBSERVED",
            data,
          },
          results,
        },
        action: action(actionId),
        agent,
        tenantRegistry: {},
      });

    const formalSnapshot = formalCaseSnapshot();
    const assessment = await run("evaluate", formalSnapshot);
    expect(assessment).toMatchObject({
      ok: true,
      type: "tool",
      data: {
        assessment_status: "complete",
        deviation: { signal_state: "formal_candidate" },
        classification: { level: "yellow" },
        routing: {
          target_role: "department_head",
          principal_id: "department-head-01",
          dispatch_allowed: true,
        },
        external_dispatch_performed: false,
      },
    });
    const formalResults = { assessment: assessment.data };
    await expect(
      run("formal-gate", formalSnapshot, formalResults),
    ).resolves.toMatchObject({ ok: true, data: { evaluated: true } });
    await expect(
      run("emit-formal", formalSnapshot, formalResults),
    ).resolves.toMatchObject({
      ok: true,
      type: "emit",
      meta: {
        emitted: [
          {
            event: "POWER_PURCHASE_FORMAL_ALERT_CLASSIFIED",
            payload: expect.objectContaining({
              case_id: formalSnapshot.case_id,
              external_dispatch_performed: false,
            }),
          },
        ],
      },
    });

    const unresolvedSnapshot = formalCaseSnapshot([]);
    const unresolved = await run("evaluate", unresolvedSnapshot);
    const unresolvedResults = { assessment: unresolved.data };
    expect(unresolved.data).toMatchObject({
      data_quality: { incident_required: true },
      routing: {
        routing_status: "routing_pending",
        fallback_kind: "governance_dq_queue",
        dispatch_allowed: false,
      },
    });
    await expect(
      run("formal-gate", unresolvedSnapshot, unresolvedResults),
    ).resolves.toMatchObject({ ok: true, data: { evaluated: false } });
    await expect(
      run("dq-gate", unresolvedSnapshot, unresolvedResults),
    ).resolves.toMatchObject({ ok: true, data: { evaluated: true } });
    await expect(
      run("emit-dq", unresolvedSnapshot, unresolvedResults),
    ).resolves.toMatchObject({
      ok: true,
      type: "emit",
      meta: {
        emitted: [
          {
            event: "POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED",
            payload: expect.objectContaining({
              case_id: unresolvedSnapshot.case_id,
              external_dispatch_performed: false,
            }),
          },
        ],
      },
    });

    const missingBaseSnapshot = { ...formalSnapshot } as Record<
      string,
      unknown
    >;
    delete missingBaseSnapshot.case_status;
    const missingBase = await run("evaluate", missingBaseSnapshot);
    expect(missingBase).toMatchObject({
      ok: true,
      type: "tool",
      data: {
        assessment_status: "indeterminate",
        applied_rules: ["PP-RULE-DQ-001"],
        data_quality: {
          incident_required: true,
          missing_or_invalid_fields: ["case_status"],
          business_warning_suppressed: true,
          responsibility_attribution_suppressed: true,
        },
        routing: { dispatch_allowed: false },
        external_dispatch_performed: false,
      },
    });
  });
});
