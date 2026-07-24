import { afterEach, describe, expect, it, vi } from "vitest";
import { setTenantInngestDeployment, updateTenant } from "./useTenants";

const TENANT_DETAIL = {
  id: "ten-1",
  slug: "acme",
  name: "Acme AI",
  subtitle: null,
  color: "#5deeff",
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
  inngestEnabled: true,
  inngestProcessScoped: true,
  agentCount: 0,
  runs24h: 0,
  openTasks: 0,
  workflowCount: 0,
  deploymentLiveCount: 0,
  membership: "admin" as const,
  budgets: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setTenantInngestDeployment", () => {
  it("uses the tenant-scoped idempotent deployment endpoint", async () => {
    const result = {
      slug: "acme",
      enabled: false,
      changed: true,
      appId: "agentic-operator-acme",
      servePath: "/inngest/acme",
      functionCount: 0,
      status: "stopped",
      brokerVerified: true,
    } as const;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ ok: true, data: result }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setTenantInngestDeployment({ slug: "acme", enabled: false }),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/tenants/acme/inngest-deployment",
      expect.objectContaining({
        credentials: "same-origin",
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });
});

describe("updateTenant", () => {
  it("sends only the mutable tenant patch to the existing PUT route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ ok: true, data: TENANT_DETAIL }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateTenant({
        slug: "acme",
        patch: { name: "Acme AI", color: "#5deeff" },
      }),
    ).resolves.toEqual(TENANT_DETAIL);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/tenants/acme",
      expect.objectContaining({
        credentials: "same-origin",
        method: "PUT",
        body: JSON.stringify({ name: "Acme AI", color: "#5deeff" }),
      }),
    );
  });

  it("surfaces the API error instead of presenting a successful save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            ok: false,
            error: { code: "forbidden", message: "Admin access required" },
          }),
      }),
    );

    await expect(
      updateTenant({ slug: "acme", patch: { name: "Acme AI" } }),
    ).rejects.toThrow("forbidden — Admin access required");
  });
});
