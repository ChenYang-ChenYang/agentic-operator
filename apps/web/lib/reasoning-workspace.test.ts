import { describe, expect, it } from "vitest";
import {
  reasoningAgentHref,
  reasoningWorkspaceTenant,
} from "./reasoning-workspace";

describe("standalone Reasoning workspace routing", () => {
  it.each([
    "raas",
    "zhaopin",
    "agents-generation",
    "__system",
    "unconfigured-tenant",
  ])(
    "keeps the current Business Domain in its own workspace: %s",
    (tenant) => {
      expect(reasoningWorkspaceTenant(tenant)).toBe(tenant);
      expect(reasoningAgentHref(tenant)).toBe(
        `/portal/${tenant}/reasoning-agent`,
      );
    },
  );
});
