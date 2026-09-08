import { describe, expect, it } from "vitest";
import {
  actionErrorFacts,
  classifyActionFailure,
  evaluateErrorPredicate,
  failureForDisposition,
  validateErrorPredicateSyntax,
  type RuntimeErrorPolicyRule,
} from "./error-policy";
import { ActionSchema, AgentSchema } from "./manifest";

function typedFailure(kind: string, status?: number): Error {
  return Object.assign(new Error(`${kind}: upstream request failed${status ? ` HTTP ${status}` : ""}`), {
    kind,
    status,
  });
}

const ladder: RuntimeErrorPolicyRule[] = [
  { when: "status==429 || code==QUOTA_EXHAUSTED", do: "park", suppress_emit: true },
  { when: "kind==schema_mismatch", do: "terminal", suppress_emit: true },
  { when: "status>=500", do: "retry", suppress_emit: true },
  {
    when: "status>=400 && status<500",
    do: "continue",
    default_result: { accepted: false },
    emit_event: "REQUEST_REJECTED",
    emit_payload: { source: "classifier" },
  },
  { default: "terminal", suppress_emit: true },
];

describe("declarative action error policy", () => {
  it("extracts typed kind/status through a serialized message fallback", () => {
    expect(actionErrorFacts(typedFailure("rate_limit", 429))).toMatchObject({
      kind: "rate_limit",
      status: 429,
      name: "Error",
    });
    expect(actionErrorFacts(new Error("http_5xx: service HTTP 503"))).toMatchObject({
      kind: "http_5xx",
      status: 503,
    });
  });

  it.each([
    ["429 is parked/retried", typedFailure("rate_limit", 429), "retry", "park"],
    ["5xx is retried", typedFailure("http_5xx", 503), "retry", "retry"],
    ["schema mismatch is terminal", typedFailure("schema_mismatch"), "terminal", "terminal"],
  ] as const)("classifies %s", (_label, failure, disposition, policyAction) => {
    expect(classifyActionFailure({ policy: ladder, failure })).toMatchObject({
      disposition,
      policyAction,
    });
  });

  it("continues a non-retriable 4xx with its default and selects a declared error emit", () => {
    const result = classifyActionFailure({
      policy: ladder,
      failure: typedFailure("http_4xx", 422),
    });
    expect(result).toMatchObject({
      disposition: "continue",
      defaultResult: { accepted: false },
      emitEvent: "REQUEST_REJECTED",
      emitPayload: { source: "classifier" },
      suppressEmit: false,
    });
    expect(result.matchedRule).toBe(3);
  });

  it("uses first-match ordering and fail-closes invalid predicates", () => {
    const first = classifyActionFailure({
      policy: [
        { when: "status>=400", do: "continue", default_result: null },
        { when: "status==429", do: "park" },
        { default: "terminal" },
      ],
      failure: typedFailure("rate_limit", 429),
    });
    expect(first.disposition).toBe("continue");
    expect(first.matchedRule).toBe(0);

    const invalid = classifyActionFailure({
      policy: [
        { when: "process.exit()", do: "continue", default_result: null },
        { default: "retry" },
      ],
      failure: typedFailure("network"),
    });
    expect(invalid.disposition).toBe("terminal");
    expect(invalid.policyError).toMatch(/forbidden|safe predicate/i);
  });

  it("supports concise bare codes while rejecting executable syntax", () => {
    expect(validateErrorPredicateSyntax("code==QUOTA_EXHAUSTED||status==429")).toBeNull();
    expect(evaluateErrorPredicate("code==QUOTA_EXHAUSTED||status==429", {
      code: "QUOTA_EXHAUSTED",
      name: "Error",
      message: "quota",
    })).toEqual({ valid: true, value: true });
    expect(validateErrorPredicateSyntax("status >= 400 && (() => true)()" )).toMatch(/forbidden|safe/i);
  });

  it("preserves legacy soft/retry and turns legacy terminal into NonRetriableError", () => {
    const failure = typedFailure("network");
    const soft = classifyActionFailure({ policy: "soft", failure, defaultResult: null });
    expect(soft).toMatchObject({ disposition: "continue", defaultResult: null });
    expect(failureForDisposition(soft, failure)).toBeNull();

    const retry = classifyActionFailure({ policy: undefined, failure });
    expect(failureForDisposition(retry, failure)).toBe(failure);

    const terminal = classifyActionFailure({ policy: "terminal", failure });
    const terminalError = failureForDisposition(terminal, failure);
    expect(terminalError?.name).toBe("NonRetriableError");
    expect((terminalError as Error & { cause?: unknown }).cause).toBe(failure);
  });
});

describe("manifest error-policy schema", () => {
  const action = (on_error: unknown, extra: Record<string, unknown> = {}) => ({
    order: "1",
    name: "call-external",
    type: "tool",
    on_error,
    ...extra,
  });

  it("accepts a complete ladder and keeps legacy strings compatible", () => {
    expect(ActionSchema.parse(action(ladder)).on_error).toEqual(ladder);
    expect(ActionSchema.parse(action("soft", { default_result: null })).on_error).toBe("soft");
    expect(ActionSchema.parse(action("terminal")).on_error).toBe("terminal");
  });

  it("rejects unsafe, missing-default, and continue-without-fallback ladders", () => {
    expect(() => ActionSchema.parse(action([
      { when: "process.exit()", do: "continue", default_result: null },
      { default: "terminal" },
    ]))).toThrow();
    expect(() => ActionSchema.parse(action([{ when: "status==429", do: "park" }]))).toThrow();
    expect(() => ActionSchema.parse(action([
      { when: "status==400", do: "continue" },
      { default: "terminal" },
    ]))).toThrow();
  });

  it("validates classifier-selected events against the agent allow-list", () => {
    const base = {
      id: "a-1",
      name: "genericAgent",
      actor: ["Agent"],
      trigger: ["INPUT_READY"],
      actions: [action([
        { when: "status>=400&&status<500", do: "continue", default_result: {}, emit_event: "REQUEST_REJECTED" },
        { default: "terminal" },
      ])],
      triggered_event: ["REQUEST_REJECTED"],
    };
    expect(AgentSchema.parse(base).name).toBe("genericAgent");
    expect(() => AgentSchema.parse({ ...base, triggered_event: ["REQUEST_ACCEPTED"] })).toThrow(/undeclared event/i);
  });
});

/**
 * The ladder the ontology compiler puts on every Meta ERP write step
 * (packages/ontology-compiler/src/compile.ts METAERP_WRITE_ERROR_POLICY).
 * Pinned here because the runtime is what interprets it: a drift in either
 * the compiler's rule text or the facts the tool errors carry would silently
 * bring back the 2026-09-07 behaviour (HTTP 400 retried 4× over six minutes).
 */
describe("compiled Meta ERP write ladder", () => {
  const erpLadder: RuntimeErrorPolicyRule[] = [
    { when: "kind == integration_unreachable || code == integration_unreachable", do: "retry" },
    { when: "status >= 400 && status < 500", do: "terminal" },
    { default: "retry" },
  ];

  it("is valid predicate DSL and a valid manifest ladder", () => {
    for (const rule of erpLadder) {
      if ("when" in rule && rule.when) expect(validateErrorPredicateSyntax(rule.when)).toBeNull();
    }
    expect(
      ActionSchema.parse({
        order: "1",
        name: "metaerp.invoke",
        type: "tool",
        allowed_tools: ["metaerp.invoke"],
        tool_arguments: { payload: { from: "event.data" } },
        on_error: erpLadder,
      }).on_error,
    ).toEqual(erpLadder);
  });

  it("treats an HTTP 4xx from the ERP as terminal — the payload is wrong, retrying cannot fix it", () => {
    // Exactly the message metaerp.invoke throws (status is parsed from `HTTP 400`).
    const failure = new Error(
      "metaerp.invoke: 'createPbp' returned HTTP 400 — {\"ok\":false,\"error\":\"createPbp: at least one plan line is required\"}",
    );
    expect(actionErrorFacts(failure).status).toBe(400);
    const resolution = classifyActionFailure({ policy: erpLadder, failure });
    expect(resolution).toMatchObject({ disposition: "terminal", matchedRule: 1 });
    expect(failureForDisposition(resolution, failure)?.name).toBe("NonRetriableError");
  });

  it("retries an unreachable ERP (typed error AND message-prefix fallback) and 5xx", () => {
    const typed = Object.assign(
      new Error("integration_unreachable: Meta ERP 接口不可达（METAERP_BASE_URL=http://localhost:3620）— fetch failed: ECONNREFUSED"),
      { code: "integration_unreachable", kind: "integration_unreachable" },
    );
    expect(classifyActionFailure({ policy: erpLadder, failure: typed })).toMatchObject({
      disposition: "retry",
      matchedRule: 0,
    });
    // Only the message survives a step boundary: the `<kind>:` prefix still matches rule 0.
    const serialized = new Error(typed.message);
    expect(actionErrorFacts(serialized).kind).toBe("integration_unreachable");
    expect(classifyActionFailure({ policy: erpLadder, failure: serialized })).toMatchObject({
      disposition: "retry",
      matchedRule: 0,
    });
    expect(
      classifyActionFailure({
        policy: erpLadder,
        failure: new Error("metaerp.invoke: 'createPbp' returned HTTP 503 — upstream unavailable"),
      }),
    ).toMatchObject({ disposition: "retry", matchedRule: 2 });
  });

  it("keeps a blocking outcome (control.fail) terminal under the legacy string policy and readable as facts", () => {
    const failure = Object.assign(
      new Error("blocked_outcome: 无法获取业务类型【物资】的阶段周期配置，根据BR-PLAN-01不予推算。"),
      { code: "schedule_blocked", kind: "blocked_outcome" },
    );
    const facts = actionErrorFacts(failure);
    expect(facts).toMatchObject({ code: "schedule_blocked", kind: "blocked_outcome" });
    expect(classifyActionFailure({ policy: "terminal", failure })).toMatchObject({ disposition: "terminal" });
    expect(actionErrorFacts(new Error(failure.message)).kind).toBe("blocked_outcome");
  });
});
