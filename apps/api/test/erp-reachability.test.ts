import { afterEach, describe, expect, it } from "vitest";
import {
  _clearErpProbeCacheForTests,
  erpIntegrationStatus,
  erpOrigin,
  erpTargetsFromManifest,
  probeErpBaseUrl,
} from "../src/services/erp-reachability";

const manifest = [
  {
    name: "generateExecutionPlanDraft",
    tool_use: [{ name: "metaerp.invoke", config: { operation: "createPbp", base_url_env: "METAERP_BASE_URL" } }],
  },
  {
    name: "derivePurchaseSchedule",
    tool_use: [
      { name: "metaerp.invoke", config: { operation: "queryStageCycleConfig" } }, // default env
      { name: "control.fail", config: {} },
    ],
  },
  { name: "handleBlueAlertLocally", tool_use: [{ name: "metaerp.invoke", config: { base_url_env: "METAERP_ALERT_URL" } }] },
  { name: "noTools" },
];

function fetchStub(behaviour: "ok" | "404" | "refused" | "timeout"): typeof fetch {
  return (async () => {
    if (behaviour === "refused") {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    }
    if (behaviour === "timeout") {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }
    return new Response("", { status: behaviour === "404" ? 404 : 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => _clearErpProbeCacheForTests());

describe("erp-reachability", () => {
  it("groups the live manifest's metaerp.invoke bindings by base_url_env (default METAERP_BASE_URL)", () => {
    const targets = erpTargetsFromManifest(manifest);
    expect([...targets.entries()]).toEqual([
      ["METAERP_BASE_URL", ["generateExecutionPlanDraft", "derivePurchaseSchedule"]],
      ["METAERP_ALERT_URL", ["handleBlueAlertLocally"]],
    ]);
  });

  it("reports only the origin of a configured URL, never path or credentials", () => {
    expect(erpOrigin("http://user:pw@erp.internal:3620/metaerp/openapi/v1?x=1")).toBe("http://erp.internal:3620");
    expect(erpOrigin("ftp://erp.internal")).toBeNull();
    expect(erpOrigin("not a url")).toBeNull();
  });

  it("any HTTP answer proves reachability; a refused connection or timeout does not", async () => {
    expect(await probeErpBaseUrl("http://a.test", { fetchImpl: fetchStub("404"), ttlMs: 0 })).toMatchObject({ reachable: true, error: null });
    expect(await probeErpBaseUrl("http://b.test", { fetchImpl: fetchStub("refused"), ttlMs: 0 })).toMatchObject({ reachable: false, error: "ECONNREFUSED" });
    expect(await probeErpBaseUrl("http://c.test", { fetchImpl: fetchStub("timeout"), ttlMs: 0, timeoutMs: 100 })).toMatchObject({
      reachable: false,
      error: "timeout after 100ms",
    });
  });

  it("caches a probe per URL for the TTL so a polling portal cannot storm the gateway", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let now = 1_000;
    const opts = { fetchImpl: counting, ttlMs: 20_000, now: () => now };
    await probeErpBaseUrl("http://d.test", opts);
    await probeErpBaseUrl("http://d.test", opts);
    expect(calls).toBe(1);
    now += 20_001;
    await probeErpBaseUrl("http://d.test", opts);
    expect(calls).toBe(2);
  });

  it("builds the tenant status: unconfigured env, unreachable env, and ok only when every target answers", async () => {
    const unreachable = await erpIntegrationStatus(
      manifest,
      { METAERP_BASE_URL: "http://localhost:3620/", METAERP_ALERT_URL: "" },
      { fetchImpl: fetchStub("refused"), ttlMs: 0 },
    );
    expect(unreachable.usesErp).toBe(true);
    expect(unreachable.ok).toBe(false);
    expect(unreachable.targets).toMatchObject([
      { env: "METAERP_ALERT_URL", configured: false, baseUrl: null, reachable: null, agents: ["handleBlueAlertLocally"] },
      { env: "METAERP_BASE_URL", configured: true, baseUrl: "http://localhost:3620", reachable: false, error: "ECONNREFUSED" },
    ]);

    _clearErpProbeCacheForTests();
    const healthy = await erpIntegrationStatus(
      manifest,
      { METAERP_BASE_URL: "http://localhost:3620", METAERP_ALERT_URL: "https://alerts.internal" },
      { fetchImpl: fetchStub("ok"), ttlMs: 0 },
    );
    expect(healthy.ok).toBe(true);
    expect(healthy.targets.every((target) => target.reachable === true)).toBe(true);

    const none = await erpIntegrationStatus([{ name: "x", tool_use: [] }], {}, { fetchImpl: fetchStub("ok") });
    expect(none).toEqual({ usesErp: false, ok: true, targets: [] });
  });
});
