import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WorkflowManifestV2Schema,
  workflowManualTaskResolutionOutputContract,
} from "@agentic/contracts";
import {
  parseValidateAndRepairOutput,
  resolveAgentEmissions,
} from "./agent-execution";
import { buildManualTaskPayload, buildManualTaskResolution } from "./register";

describe("manual task payload", () => {
  it("carries the prepared decision context and authored operator contract", () => {
    const payload = buildManualTaskPayload({
      agent: { name: "approvalAgent" },
      action: {
        order: "2",
        name: "requestApproval",
        description: "Review the prepared recommendation.",
        type: "manual",
        task_type: "approval",
        awaiting_role: "risk-operator",
        form_schema: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["approve", "reject"] },
          },
        },
      },
      subject: "case-42",
      preparedContext: {
        recommendation: "approve",
        evidence: ["policy-7"],
      },
    });

    assert.deepEqual(payload, {
      agentName: "approvalAgent",
      actionName: "requestApproval",
      description: "Review the prepared recommendation.",
      subject: "case-42",
      condition: null,
      preparedContext: {
        recommendation: "approve",
        evidence: ["policy-7"],
      },
      formSchema: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["approve", "reject"] },
        },
      },
      awaitingRole: "risk-operator",
    });
  });

  it("strictly validates and emits every canonical manual decision", async () => {
    // This is the same strict single-output shape used by generated/template
    // Human agents. Parsing it through the canonical v2 schema also supplies
    // every runtime default that production publication persists.
    const definition = WorkflowManifestV2Schema.parse({
      $schemaVersion: 2,
      agents: [
        {
          id: "approval-agent",
          name: "approvalAgent",
          title: "Approval agent",
          description: "Waits for a typed operator decision.",
          actor: ["Human"],
          trigger: ["REVIEW_REQUESTED"],
          trigger_bindings: {
            REVIEW_REQUESTED: { review: { path: "$" } },
          },
          inputs: [
            {
              id: "review",
              label: "Review package",
              kind: "value",
              required: true,
              schema: { type: "object" },
              sensitivity: "confidential",
            },
          ],
          actions: [
            {
              order: "1",
              name: "requestApproval",
              description: "Wait for an operator decision.",
              type: "manual",
              task_type: "approval",
              awaiting_role: "operator",
              form_schema: { type: "object" },
            },
          ],
          ...workflowManualTaskResolutionOutputContract([
            "REVIEW_RESOLVED",
            "REVIEW_AUDITED",
          ]),
          triggered_event: ["REVIEW_RESOLVED", "REVIEW_AUDITED"],
        },
      ],
    }).agents[0]!;
    const cases = [
      ["approve", "approved"],
      ["reject", "rejected"],
      ["supplement", "supplemented"],
    ] as const;

    for (const [decision, outcome] of cases) {
      const resolution = buildManualTaskResolution({
        taskId: "tsk-42",
        decision,
        payload: { note: `${decision} note` },
      });
      assert.deepEqual(resolution, {
        task_id: "tsk-42",
        status: "resolved",
        decision,
        outcome,
        payload: { note: `${decision} note` },
      });

      const validated = await parseValidateAndRepairOutput({
        definition,
        candidate: resolution,
      });
      assert.equal(validated.valid, true);
      assert.deepEqual(validated.value, resolution);

      const emissions = resolveAgentEmissions({
        definition,
        inputs: { review: { caseId: "case-42" } },
        outputs: validated.value,
        source: {
          agentName: "approvalAgent",
          runId: "run-42",
          subject: "case-42",
          correlationId: "cor-42",
        },
      });
      assert.deepEqual(
        emissions.map((emission) => emission.name),
        ["REVIEW_RESOLVED", "REVIEW_AUDITED"],
      );
      for (const emission of emissions) {
        assert.deepEqual(emission.payload.decision, resolution);
      }
    }
  });

  it("rejects an unknown manual decision instead of silently approving it", () => {
    assert.throws(
      () =>
        buildManualTaskResolution({
          taskId: "tsk-42",
          decision: "escalate",
        }),
      /invalid manual task decision/,
    );
  });

  it("rejects a missing manual decision instead of silently approving it", () => {
    assert.throws(
      () =>
        buildManualTaskResolution({
          taskId: "tsk-42",
        }),
      /invalid manual task decision/,
    );
  });
});
