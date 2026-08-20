import { describe, expect, it } from "vitest";
import {
  WorkflowAuthoringApiError,
  WorkflowAuthoringClientError,
  WorkflowPublishOverwriteRequiredError,
  formatWorkflowAuthoringError,
  workflowOverwriteConflict,
} from "./useWorkflowAuthoring";

describe("formatWorkflowAuthoringError", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    key === "workflowAuthoringError.requestFailed"
      ? `工作流创作请求失败（HTTP ${vars?.status}）。`
      : key;

  it("localizes client-owned failures", () => {
    expect(
      formatWorkflowAuthoringError(
        new WorkflowAuthoringClientError(
          "requestFailed",
          "Workflow authoring request failed (HTTP 503).",
          503,
        ),
        t,
      ),
    ).toBe("工作流创作请求失败（HTTP 503）。");
  });

  it("preserves server-authored error detail", () => {
    expect(
      formatWorkflowAuthoringError(
        new WorkflowAuthoringApiError("policy_denied", "server detail"),
        t,
      ),
    ).toBe("server detail");
  });
});

describe("workflowOverwriteConflict", () => {
  const envelope = {
    ok: false,
    requires_confirmation: true,
    reason: "removes_agents",
    diff: {
      added: [],
      removed: ["support-response-drafter"],
      modified: ["support-ticket-triage"],
      prior_version: "auto-abc",
    },
    conflicts: [],
  };

  it("recognizes the publish confirmation envelope and names the removed agents", () => {
    const conflict = workflowOverwriteConflict(409, envelope);
    expect(conflict).toBeInstanceOf(WorkflowPublishOverwriteRequiredError);
    expect(conflict?.reason).toBe("removes_agents");
    expect(conflict?.removed).toEqual(["support-response-drafter"]);
    expect(conflict?.modified).toEqual(["support-ticket-triage"]);
  });

  it("ignores ordinary error envelopes and non-409 responses", () => {
    expect(
      workflowOverwriteConflict(409, {
        ok: false,
        error: { code: "workflow_conflict", message: "slug taken" },
      }),
    ).toBeNull();
    expect(workflowOverwriteConflict(400, envelope)).toBeNull();
    expect(workflowOverwriteConflict(409, null)).toBeNull();
  });
});
