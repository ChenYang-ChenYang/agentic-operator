import { describe, expect, it } from "vitest";

import { createProbeAuthorizationBinding } from "./probe-authorization";
import { findSensitiveInputPath, sanitizeSensitiveInput } from "./sensitive-input";

const tool = {
  name: "vendor.lookup",
  sideEffect: "write" as const,
  catalogDefinition: {
    name: "vendor.lookup",
    sideEffect: "write",
    argsSchema: { email: { type: "string" } },
    returnsSchema: {},
  },
};

describe("sensitive input boundary", () => {
  it.each([
    [{ nested: { authorization: "Bearer live-token" } }, "args.nested.authorization"],
    [{ note: "Bearer live-token" }, "args.note"],
    [{ note: "api_key=live-secret" }, "args.note"],
    [{ note: '{"password":"live-secret"}' }, "args.note"],
    [{ accessToken: "live-secret" }, "args.accessToken"],
    [{ auth: "this-is-a-real-secret-value" }, "args.auth"],
    [{ authHeader: "this-is-a-real-secret-value" }, "args.authHeader"],
    [{ proxyAuthorization: "this-is-a-real-secret-value" }, "args.proxyAuthorization"],
    [{ key: "this-is-a-real-secret-value" }, "args.key"],
    [{ payload: { jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123" } }, "args.payload.jwt"],
    [{ password: "correct-horse-battery" }, "args.password"],
    [{ password: "<real-secret>" }, "args.password"],
    [{ note: "Bearer '<sk-live12345678>'" }, "args.note"],
  ])("detects nested secret keys and secret-shaped values", (value, expected) => {
    expect(findSensitiveInputPath(value)).toBe(expected);
    const scan = sanitizeSensitiveInput(value);
    expect(scan.paths).toContain(expected);
    expect(JSON.stringify(scan.sanitized)).not.toContain("live-");
    expect(JSON.stringify(scan.sanitized)).not.toContain("correct-horse");
  });

  it("preserves safe env references, placeholders and digest-only authorization options", () => {
    const value = {
      api_key_env: "ROBOHIRE_API_KEY",
      authEnv: "ROBOHIRE_AUTH_ENV",
      authHeaderEnv: "ROBOHIRE_AUTH_HEADER_ENV",
      proxyAuthorizationEnv: "ROBOHIRE_PROXY_AUTH_ENV",
      key_env: "ROBOHIRE_SIGNING_KEY_ENV",
      headers: { authorization: "Bearer {api_key}" },
      password: "<REDACTED>",
      token: "<ENV_NAME>",
      authorizationQuestion: "要不要执行这次真实写探针？",
      authorizationContext: "probe_authorization:v2:" + "b".repeat(64),
      authorizationValue: "authorize_probe:v2:" + "c".repeat(64),
      option: "authorize_probe:v2:" + "a".repeat(64),
      sandboxPlanContext: "sandbox_evidence_plan_authorization:v1:" + "d".repeat(64),
      sandboxPlanConfirm: "authorize_sandbox_evidence_plan:v1:" + "e".repeat(64),
      sandboxPlanDecline: "decline_sandbox_evidence_plan:v1:" + "f".repeat(64),
    };
    expect(sanitizeSensitiveInput(value)).toEqual({ sanitized: value, paths: [] });
  });

  it("does not confuse JSON Pointer escaped business field ~key with a credential key", () => {
    const value = {
      case_payloads: [{
        case_id: "case-1",
        payload: { "~key": "ordinary-business-value", "~0key": "literal-tilde-data", nested: { "~1key": "still-business-data" } },
      }],
    };
    expect(findSensitiveInputPath(value)).toBeUndefined();
    expect(sanitizeSensitiveInput(value)).toEqual({ sanitized: value, paths: [] });
    expect(findSensitiveInputPath({ "~auth": "this-is-a-real-secret-value" })).toBe("args.~auth");
    expect(findSensitiveInputPath({ key: "this-is-a-real-secret-value" })).toBe("args.key");
    expect(findSensitiveInputPath({ authHeader: "this-is-a-real-secret-value" })).toBe("args.authHeader");
  });

  it("rejects a secret before probe hashing and hashes the exact safe request subject", () => {
    expect(createProbeAuthorizationBinding(tool, { note: "Bearer live-token" })).toBeUndefined();
    const first = createProbeAuthorizationBinding(tool, { email: "first@example.test", id: "x" })!;
    const second = createProbeAuthorizationBinding(tool, { email: "second@example.test", id: "x" })!;
    expect(first.digest).not.toBe(second.digest);
  });
});
