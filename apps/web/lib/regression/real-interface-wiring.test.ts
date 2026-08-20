import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return readFileSync(resolve(WEB_ROOT, relativePath), "utf8");
}

describe("production interfaces do not silently substitute fake success", () => {
  it("manifest import uses repository inputs and releases pending sessions", () => {
    const source = read(
      "app/portal/components/import-manifest/ImportManifestModal.tsx",
    );

    expect(source).toContain("/manifest-import/fetch-repo");
    expect(source).toMatch(/repository:\s*repo\.repository\.trim\(\)/);
    expect(source).toMatch(/ref:\s*repo\.ref\.trim\(\)/);
    expect(source).toMatch(/path:\s*repo\.path\.trim\(\)/);
    expect(source).toMatch(/method:\s*["']DELETE["']/);
    expect(source).toContain("ManifestImportPreviewSchema.safeParse");
    expect(source).toContain("ManifestImportCommitSchema.safeParse");
  });

  it("manifest import does not render the old fabricated preview", () => {
    const source = read(
      "app/portal/components/import-manifest/ImportManifestModal.tsx",
    );

    for (const forbidden of [
      "useDag",
      "raas-stage",
      "claude-sonnet",
      "Connect OpenAI",
      "new_properties",
      "auto_rollback",
      "~ 4 s",
      "10-1",
      "10-2",
    ]) {
      expect(
        source,
        `found fabricated manifest UI token: ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  it("run-with-input validates the successful response union", () => {
    const source = read("app/portal/components/agents/RunWithInputModal.tsx");

    expect(source).toContain("InvokeSuccess.safeParse");
    expect(source).toContain("eventId: z.string().min(1)");
    expect(source).toContain("correlationId: z.string().min(1)");
    expect(source).not.toContain("(no event id)");
    expect(source).not.toContain("(no correlation id)");
  });

  it("agent calls renders only persisted invocation evidence", () => {
    const source = read("app/portal/components/logs/AgentCallsLogTab.tsx");

    expect(source).toContain("const provenEdges");
    expect(source).toContain("filteredProvenEdges");
    expect(source).not.toContain("inferredEdges");
    expect(source).not.toContain("filteredInferredEdges");
    expect(source).not.toContain("buildAgentCallEdges");
  });

  it("sidebar badges use tenant-wide canonical counts instead of list lengths", () => {
    const source = read("app/portal/components/shell/sidebar.tsx");

    expect(source).toContain("useCounts");
    expect(source).toContain("counts?.agents");
    expect(source).toContain("counts?.runningRuns");
    expect(source).toContain("counts?.openTasks");
    expect(source).not.toContain("useRuns({ limit:");
    expect(source).not.toContain("useTasks()");
    expect(source).not.toContain("tasks.length");

    const agentsHook = read("lib/hooks/useAgents.ts");
    expect(agentsHook).toMatch(
      /useDeleteAgent[\s\S]*AGENT_KEYS\.list[\s\S]*COUNT_KEYS\.tenant/,
    );
  });

  it("preserves cancelled as an accessible status across run projections", () => {
    const atoms = read("app/portal/components/atoms.tsx");
    expect(atoms).toContain('| "cancelled"');
    expect(atoms).toMatch(/cancelled:\s*\{\s*color:/);

    for (const path of [
      "app/portal/components/logs/RunLogTab.tsx",
      "app/portal/components/logs/TokenUsageLogTab.tsx",
      "app/portal/components/logs/AgentCallsLogTab.tsx",
      "app/portal/components/logs/AnalyticsLogTab.tsx",
      "app/portal/components/logs/EventLogTab.tsx",
      "app/portal/components/runs/EventChain.tsx",
      "app/portal/components/runs/TraceTree.tsx",
      "app/portal/[tenant]/(views)/runs/page.tsx",
      "app/portal/[tenant]/(views)/runs/[id]/page.tsx",
      "app/portal/[tenant]/(views)/dashboard/page.tsx",
      "app/portal/[tenant]/(views)/reasoning/page.tsx",
    ]) {
      const source = read(path);
      expect(source, path).toContain("cancelled");
      expect(source, path).not.toMatch(/cancelled[^\n]*paused/);
    }
  });

  it("health hook has no demo-mode branch", () => {
    const source = read("lib/hooks/useHealth.ts");
    expect(source).not.toContain("demoMode");
  });

  it("agent detail delegates to Agent Studio with the real route identity", () => {
    // The agent detail route is the Agent Studio experience: a thin wrapper
    // that forwards the URL identity. It must not fabricate agent fields —
    // Studio loads the live editor payload itself (useAgentEditor).
    const source = read("app/portal/[tenant]/(views)/agents/[id]/page.tsx");

    expect(source).toContain("<AgentStudio");
    expect(source).toContain('agentId={params?.id ?? ""}');
    expect(source).not.toContain("input_data: {}");
    expect(source).not.toContain('typescript_code: ""');

    // The deployed-source honesty contract now lives in the run detail's
    // agent tab, which still renders the exact deployed snapshot fields.
    const runDetail = read("app/portal/[tenant]/(views)/runs/[id]/page.tsx");
    expect(runDetail).toContain(
      "sourceUnavailable: agentDetail.sourceUnavailable",
    );
  });

  it("run agent tab uses the same deployed source snapshot", () => {
    const source = read("app/portal/[tenant]/(views)/runs/[id]/page.tsx");

    expect(source).toContain("typescript_code: agentDetail.typescript_code");
    expect(source).toContain("tool_use: agentDetail.tool_use");
    expect(source).toContain(
      "sourceUnavailable: agentDetail.sourceUnavailable",
    );
    expect(source).not.toContain('typescript_code: ""');
    expect(source).not.toContain("input_data: {}");
  });

  it("provider credential revocation calls the real DELETE endpoint and does not fake env removal", () => {
    const hook = read("lib/hooks/useModelFleet.ts");
    const view = read("app/portal/components/settings/sections/Models.tsx");

    expect(hook).toContain("export function useDeleteProviderKey");
    expect(hook).toContain('method: "DELETE"');
    expect(hook).toContain("/key`");
    expect(view).toContain("useDeleteProviderKey");
    expect(view).toContain('meta?.source === "vault"');
    expect(view).toContain('meta?.source === "env"');
    expect(view).toContain('t("models.envKeyRemovalHint")');
  });

  it("workflow edits deploy to the explicitly selected workflow identity", () => {
    // Multi-workflow authoring: every save/run targets the slug the operator
    // selected in the catalog — never the bare tenant slug (which would
    // silently write a different workflow than the one on screen).
    const source = read("app/portal/[tenant]/(views)/workflows/page.tsx");

    expect(source).toContain("workflowSlug: selectedWorkflow");
    expect(source).not.toContain("workflowSlug: tenant,");
  });

  it("factory promotion requires a visible code/design review before issuing a receipt", () => {
    const page = read("app/portal/[tenant]/(views)/factory/page.tsx");
    const review = read(
      "app/portal/[tenant]/(views)/factory/promotion-review.tsx",
    );

    expect(page).toContain("/drafts/promotion-preview");
    expect(page).toContain("/drafts/code?");
    expect(page).toContain("/drafts/reviews");
    expect(page).toContain("receiptId: review.data.receipt.receiptId");
    expect(page).not.toContain("const approved = window.confirm");
    expect(review).toContain("codeReviewed");
    expect(review).toContain("designReviewed");
    expect(review).toContain("<CodeBox code={artifact.code}");
    expect(review).toContain("preview.delta.config");
    expect(review).toContain("preview.delta.contracts");
  });
});
