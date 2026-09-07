import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ErpIntegrationStatus } from "@agentic/contracts";

const state: { data: ErpIntegrationStatus | undefined; isFetching: boolean; language: "zh" | "en" } = {
  data: undefined,
  isFetching: false,
  language: "zh",
};

vi.mock("@/lib/hooks/useErpStatus", () => ({
  useErpStatus: () => ({ data: state.data, isFetching: state.isFetching, refetch: vi.fn() }),
}));

vi.mock("@/app/portal/lib/preferences-context", () => ({
  useI18n: () => ({
    language: state.language,
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}${JSON.stringify(params)}` : key,
  }),
}));

import { ErpIntegrationBanner } from "./ErpIntegrationBanner";

function render(): string {
  return renderToStaticMarkup(<ErpIntegrationBanner />);
}

const reachable: ErpIntegrationStatus = {
  usesErp: true,
  ok: true,
  targets: [
    { env: "METAERP_BASE_URL", configured: true, baseUrl: "http://localhost:3620", reachable: true, checkedAt: 1, error: null, agents: ["generateExecutionPlanDraft"] },
  ],
};

describe("ErpIntegrationBanner", () => {
  it("renders nothing while the status is unknown, unused, or healthy", () => {
    state.data = undefined;
    expect(render()).toBe("");
    state.data = { usesErp: false, ok: true, targets: [] };
    expect(render()).toBe("");
    state.data = reachable;
    expect(render()).toBe("");
  });

  it("names the env var, origin, transport error and the affected agents when the ERP is unreachable", () => {
    state.data = {
      usesErp: true,
      ok: false,
      targets: [
        {
          env: "METAERP_BASE_URL",
          configured: true,
          baseUrl: "http://localhost:3620",
          reachable: false,
          checkedAt: 1,
          error: "ECONNREFUSED",
          agents: ["generateExecutionPlanDraft", "submitPlanForApproval"],
        },
      ],
    };
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("workflowPage.erpBannerTitle");
    expect(html).toContain("workflowPage.erpUnreachable");
    expect(html).toContain("METAERP_BASE_URL");
    expect(html).toContain("http://localhost:3620");
    expect(html).toContain("ECONNREFUSED");
    // Agent list joins with the language's own separator.
    expect(html).toContain("generateExecutionPlanDraft、submitPlanForApproval");
    expect(html).toContain("workflowPage.erpRecheck");
  });

  it("distinguishes a missing env var from an unreachable host, and switches the list separator with the language", () => {
    state.language = "en";
    state.data = {
      usesErp: true,
      ok: false,
      targets: [
        { env: "METAERP_BASE_URL", configured: false, baseUrl: null, reachable: null, checkedAt: null, error: null, agents: ["a", "b"] },
      ],
    };
    const html = render();
    expect(html).toContain("workflowPage.erpNotConfigured");
    expect(html).not.toContain("workflowPage.erpUnreachable");
    expect(html).toContain("a, b");
    state.language = "zh";
  });

  it("names five agents and counts the rest instead of listing a whole 29-agent workflow", () => {
    const agents = Array.from({ length: 29 }, (_, index) => `agent${index + 1}`);
    state.data = {
      usesErp: true,
      ok: false,
      targets: [
        { env: "METAERP_BASE_URL", configured: true, baseUrl: "http://localhost:3620", reachable: false, checkedAt: 1, error: "ECONNREFUSED", agents },
      ],
    };
    const html = render();
    // The mocked t() serialises params, so the nested agents string appears
    // JSON-escaped inside the outer message: assert on the stable parts.
    expect(html).toMatch(/agent1、agent2、agent3、agent4、agent5workflowPage\.erpAgentsMore[^}]*24/);
    expect(html).not.toContain("agent6");
  });
});
