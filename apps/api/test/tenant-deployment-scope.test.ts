import { describe, expect, it } from "vitest";
import {
  enabledTenantDeploymentScope,
  isTenantInProcessDeploymentScope,
} from "../src/services/tenant-deployment-scope";

describe("tenant Inngest process deployment scope", () => {
  it("allows every tenant when no process allow-list is configured", () => {
    expect(enabledTenantDeploymentScope({})).toBeNull();
    expect(isTenantInProcessDeploymentScope("raas", {})).toBe(true);
  });

  it("trims and enforces the explicit tenant ownership allow-list", () => {
    const env = {
      AGENTIC_ENABLED_TENANTS: " raas, zhaopin ,,",
    };
    expect([...enabledTenantDeploymentScope(env)!]).toEqual([
      "raas",
      "zhaopin",
    ]);
    expect(isTenantInProcessDeploymentScope("raas", env)).toBe(true);
    expect(isTenantInProcessDeploymentScope("northwind", env)).toBe(false);
  });
});
