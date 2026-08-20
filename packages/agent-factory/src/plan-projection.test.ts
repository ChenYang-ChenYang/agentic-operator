import { describe, it, expect } from "vitest";
import {
  projectPlanToActions,
  parsePlan,
  validatePlan,
} from "./plan-projection";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

// Phase 1 — a generated spec's structured plan[] must project into ORDERED manifest actions
// (one durable step.run each), not collapse to a single logic action. Back-compat: no plan →
// the legacy single-logic action.

function spec(
  p: Partial<GeneratedAgentSpec> & { actionName: string },
): GeneratedAgentSpec {
  return {
    key: p.actionName,
    actionName: p.actionName,
    slug: p.slug ?? `d-${p.actionName}`,
    short: p.short ?? p.actionName,
    domainId: "rec",
    nameZh: p.actionName,
    kind: "llm",
    trigger: [],
    emit: [],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "x",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 2,
    hitl: p.hitl ?? false,
    confidence: 1,
    promptSource: "llm",
    plan: p.plan,
    decisionTables: p.decisionTables,
  } as GeneratedAgentSpec;
}

describe("projectPlanToActions", () => {
  it("falls back to a single logic action when there is no plan (back-compat)", () => {
    const actions = projectPlanToActions(spec({ actionName: "createJD" }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      order: "1",
      name: "createJD",
      type: "logic",
      allowed_tools: [],
    });
    expect(actions[0]!.retries).toBeUndefined();
  });

  it("emits an explicit least-privilege tool boundary for every projected plan action", () => {
    const actions = projectPlanToActions(
      spec({
        actionName: "boundedPlan",
        plan: [
          { stepId: "load", kind: "tool", tool: "records.read" },
          { stepId: "reason", kind: "logic" },
          {
            stepId: "ready",
            kind: "condition",
            condition: "lastResult != null",
          },
          {
            stepId: "each",
            kind: "foreach",
            itemsFrom: "input.items",
            itemKeyFrom: "item.id",
            body: [{ stepId: "save", kind: "tool", tool: "records.write" }],
          },
        ],
      }),
    );

    expect(actions.map((action) => action.allowed_tools)).toEqual([
      ["records.read"],
      [],
      [],
      [],
    ]);
    expect(
      (actions[3]!.foreach_actions as Array<Record<string, unknown>>)[0]!
        .allowed_tools,
    ).toEqual(["records.write"]);
  });

  it("prefixes a manual approval gate for HITL agents with no plan", () => {
    const actions = projectPlanToActions(
      spec({ actionName: "approveOffer", hitl: true }),
    );
    expect(actions.map((a) => a.type)).toEqual(["manual", "logic"]);
    expect(actions[0]!.name).toBe("approveOffer-approval");
  });

  it("appends machine-checkable decision tables after the data-producing steps", () => {
    const actions = projectPlanToActions(
      spec({
        actionName: "routeScore",
        plan: [{ stepId: "load-score", kind: "logic" }],
        decisionTables: [
          {
            id: "score",
            rows: [
              {
                id: "pass",
                all: [
                  { path: "results.load-score.score", op: "gte", value: 40 },
                ],
                outcome: "pass",
                emitEvent: "PASSED",
              },
            ],
            missing: { outcome: "review", emitEvent: "REVIEW" },
            default: { outcome: "reject", emitEvent: "FAILED" },
          },
        ],
      }),
    );
    expect(actions.map((action) => action.type)).toEqual(["logic", "decision"]);
    expect(actions[1]).toMatchObject({
      name: "decision-score",
      result_key: "decision-score",
    });
    expect(actions[1]!.decision_table).toMatchObject({ id: "score" });
  });

  it("projects each plan step into its own ordered action with the right type + fields", () => {
    const plan: PlanStep[] = [
      {
        stepId: "fetch-requirement",
        kind: "tool",
        tool: "getRequirement",
        idempotencyKeyFrom: "entity_id",
        onError: "terminal",
      },
      {
        stepId: "fetch-clarifications",
        kind: "tool",
        tool: "getClarifications",
        onError: "soft",
        defaultResult: [],
      },
      {
        stepId: "is-complete",
        kind: "condition",
        condition: "lastResult != null",
      },
      {
        stepId: "persist",
        kind: "tool",
        tool: "syncToPg",
        dependsOn: ["is-complete"],
        idempotencyKeyFrom: "entity_id",
      },
      {
        stepId: "dedup",
        kind: "invoke",
        invoke: "candidateIdentity",
        timeoutS: 90,
        onError: "soft",
        defaultResult: { verdict: "new" },
      },
    ];
    const actions = projectPlanToActions(
      spec({ actionName: "createJD", plan }),
    );
    expect(actions).toHaveLength(5);
    // order is 1..5 in declaration order
    expect(actions.map((a) => a.order)).toEqual(["1", "2", "3", "4", "5"]);
    // a tool step's NAME is the tool (so step-engine resolves it); others use stepId
    expect(actions[0]).toMatchObject({
      name: "getRequirement",
      type: "tool",
      result_key: "fetch-requirement",
      idempotency_key_from: "entity_id",
    });
    expect(actions[1]).toMatchObject({
      name: "getClarifications",
      type: "tool",
      on_error: "soft",
    });
    expect(actions[1]!.default_result).toEqual([]);
    expect(actions[2]).toMatchObject({
      name: "is-complete",
      type: "condition",
      condition: "lastResult != null",
    });
    expect(actions[3]).toMatchObject({
      name: "syncToPg",
      type: "tool",
      depends_on: ["is-complete"],
      idempotency_key_from: "entity_id",
    });
    expect(actions[4]).toMatchObject({
      name: "dedup",
      type: "invoke",
      result_key: "dedup",
      invoke: "candidateIdentity",
      forward_last_result: true,
      timeout_s: 90,
      on_error: "soft",
    });
  });

  it("projects a non-condition step condition as an executable pre-side-effect guard", () => {
    const actions = projectPlanToActions(
      spec({
        actionName: "routeOutcome",
        plan: [
          {
            stepId: "emit-passed",
            kind: "emit",
            emitEvent: "PASSED",
            condition: 'input.selected_event == "PASSED"',
            emitPayloadFrom: "input.payload",
          },
        ],
      }),
    );

    expect(actions[0]).toMatchObject({
      type: "emit",
      emit_event: "PASSED",
      condition: 'input.selected_event == "PASSED"',
      emit_payload_from: "input.payload",
    });
  });

  it("projects exact tool arguments and result maps without inferring from names", () => {
    const plan: PlanStep[] = [
      {
        stepId: "parse-one",
        kind: "tool",
        tool: "parseResumeApi",
        toolArguments: {
          object_key: { from: "input.object_key" },
          resume_id: { from: "locals.resume.resume_id" },
          strict: { const: true },
        },
        resultMap: {
          fields: {
            candidate_id: "result.data.candidate_id",
            parsed: "result.data.parsed",
          },
          includeRaw: true,
        },
        idempotencyKeyFrom: "resume_id",
        onError: "terminal",
      },
    ];
    const [action] = projectPlanToActions(
      spec({ actionName: "processResume", plan }),
    );
    expect(action).toMatchObject({
      tool_arguments: {
        object_key: { from: "input.object_key" },
        resume_id: { from: "locals.resume.resume_id" },
        strict: { const: true },
      },
      result_map: {
        fields: {
          candidate_id: "result.data.candidate_id",
          parsed: "result.data.parsed",
        },
        include_raw: true,
      },
    });
  });

  it("projects timeout_s for ordinary actions and nested foreach bodies", () => {
    const actions = projectPlanToActions(
      spec({
        actionName: "bounded",
        plan: [
          { stepId: "load", kind: "tool", tool: "load", timeoutS: 12 },
          { stepId: "think", kind: "logic", timeoutS: 8 },
          {
            stepId: "ready",
            kind: "condition",
            condition: "lastResult != null",
            timeoutS: 2,
          },
          { stepId: "notify", kind: "emit", emitEvent: "DONE", timeoutS: 3 },
          {
            stepId: "each",
            kind: "foreach",
            itemsFrom: "input.items",
            itemKeyFrom: "item.id",
            timeoutS: 30,
            body: [{ stepId: "one", kind: "tool", tool: "load", timeoutS: 4 }],
          },
        ],
      }),
    );
    expect(actions.map((action) => action.timeout_s)).toEqual([
      12, 8, 2, 3, 30,
    ]);
    expect(
      (actions[4]!.foreach_actions as Array<Record<string, unknown>>)[0]!
        .timeout_s,
    ).toBe(4);
    expect(actions.every((action) => action.retries === undefined)).toBe(true);
  });

  it("keeps the HITL manual gate as action 1, then the plan steps", () => {
    const plan: PlanStep[] = [{ stepId: "decide", kind: "logic" }];
    const actions = projectPlanToActions(
      spec({ actionName: "approveOffer", hitl: true, plan }),
    );
    expect(actions.map((a) => a.type)).toEqual(["manual", "logic"]);
    expect(actions[0]!.name).toBe("approveOffer-approval");
    expect(actions[1]!.name).toBe("decide");
  });

  it("projects object lookup and human input as durable acquisition actions before the plan", () => {
    const generated = spec({
      actionName: "enrichWork",
      plan: [{ stepId: "decide", kind: "logic" }],
    });
    generated.inputBindings = [
      {
        field: "work_id",
        type: "String",
        required: true,
        kind: "event",
        eventPath: "work_id",
      },
      {
        field: "stored",
        type: "String",
        required: true,
        kind: "object_lookup",
        sourceObject: "Work.result",
        tool: "records.getWork",
        arguments: { id: "bindings.operator_id" },
        resultPath: "result",
        dependsOn: ["operator_id"],
      },
      {
        field: "operator_id",
        type: "String",
        required: true,
        kind: "human_input",
        prompt: "请提供操作员编号",
      },
      {
        field: "token",
        type: "String",
        required: true,
        kind: "secret",
        reference: "tool:records.getWork:api_key_env",
      },
    ];
    const actions = projectPlanToActions(generated);
    expect(actions.map((action) => action.type)).toEqual([
      "manual",
      "tool",
      "logic",
    ]);
    expect(actions[0]).toMatchObject({
      name: "ask-input-operator_id",
      task_type: "agentInput",
      input_binding: { kind: "human_input", field: "operator_id" },
    });
    expect(actions[1]).toMatchObject({
      name: "records.getWork",
      result_key: "input-binding-2",
      input_binding: {
        kind: "object_lookup",
        field: "stored",
        arguments: { id: "bindings.operator_id" },
      },
    });
    expect(actions.map((action) => action.order)).toEqual(["1", "2", "3"]);
  });

  it("omits on_error for a 'park' policy (Inngest retries handle it; manifest enum is soft|terminal)", () => {
    const plan: PlanStep[] = [
      { stepId: "call", kind: "tool", tool: "t", onError: "park" },
    ];
    const actions = projectPlanToActions(spec({ actionName: "a", plan }));
    expect(actions[0]!.on_error).toBeUndefined();
  });

  it("projects an ordered errorPolicy to the manifest predicate ladder", () => {
    const plan: PlanStep[] = [
      {
        stepId: "call",
        kind: "tool",
        tool: "external.call",
        idempotencyKeyFrom: "entity_id",
        errorPolicy: [
          { when: "status==429", do: "park", suppressEmit: true },
          {
            when: "status>=400&&status<500",
            do: "continue",
            defaultResult: { accepted: false },
            emitEvent: "REQUEST_REJECTED",
          },
          { default: "terminal", suppressEmit: true },
        ],
      },
    ];
    const actions = projectPlanToActions(
      spec({ actionName: "classifyFailure", plan }),
    );
    expect(actions[0]!.on_error).toEqual([
      { when: "status==429", do: "park", suppress_emit: true },
      {
        when: "status>=400&&status<500",
        do: "continue",
        default_result: { accepted: false },
        emit_event: "REQUEST_REJECTED",
      },
      { default: "terminal", suppress_emit: true },
    ]);
  });

  it("projects foreach bodies and explicit emit intents without flattening their local scope", () => {
    const plan: PlanStep[] = [
      {
        stepId: "parse-resumes",
        kind: "foreach",
        itemsFrom: "input.resumes",
        itemAs: "resume",
        itemKeyFrom: "resume.resume_id",
        body: [
          {
            stepId: "parse-one",
            kind: "tool",
            tool: "parseResume",
            onError: "terminal",
          },
          {
            stepId: "emit-one",
            kind: "emit",
            emitEvent: "RESUME_PARSED",
            emitPayloadFrom: "results.parse-one",
          },
        ],
      },
    ];
    const actions = projectPlanToActions(
      spec({ actionName: "batchParse", plan }),
    );
    expect(actions[0]).toMatchObject({
      name: "parse-resumes",
      type: "foreach",
      items_from: "input.resumes",
      item_as: "resume",
      item_key_from: "resume.resume_id",
      foreach_mode: "sequential",
    });
    expect(actions[0]!.foreach_actions).toEqual([
      expect.objectContaining({
        name: "parseResume",
        type: "tool",
        result_key: "parse-one",
      }),
      expect.objectContaining({
        name: "emit-one",
        type: "emit",
        emit_event: "RESUME_PARSED",
        emit_payload_from: "results.parse-one",
      }),
    ]);
  });

  it("projects recursive foreach and item-local invoke without losing execution policy", () => {
    const plan: PlanStep[] = [
      {
        stepId: "each-job",
        kind: "foreach",
        itemsFrom: "input.jobs",
        itemAs: "job",
        itemKeyFrom: "job.id",
        body: [
          {
            stepId: "each-candidate",
            kind: "foreach",
            itemsFrom: "locals.job.candidates",
            itemAs: "candidate",
            itemKeyFrom: "candidate.id",
            body: [
              {
                stepId: "verify",
                kind: "invoke",
                invoke: "candidate-checker",
                timeoutS: 7,
                onError: "soft",
                defaultResult: { accepted: false },
                forwardResults: true,
              },
            ],
          },
        ],
      },
    ];
    expect(validatePlan(plan).ok).toBe(true);
    const [outer] = projectPlanToActions(spec({ actionName: "batch", plan }));
    const nested = (
      outer!.foreach_actions as Array<Record<string, unknown>>
    )[0]!;
    const invoke = (
      nested.foreach_actions as Array<Record<string, unknown>>
    )[0]!;
    expect(nested).toMatchObject({
      type: "foreach",
      result_key: "each-candidate",
      items_from: "locals.job.candidates",
      item_key_from: "candidate.id",
    });
    expect(invoke).toMatchObject({
      type: "invoke",
      result_key: "verify",
      invoke: "candidate-checker",
      timeout_s: 7,
      on_error: "soft",
      default_result: { accepted: false },
      forward_results: true,
    });
  });
});

describe("parsePlan — tolerates snake_case + camelCase from the LLM", () => {
  it("normalizes snake_case keys into PlanStep", () => {
    const plan = parsePlan([
      {
        step_id: "fetch",
        kind: "tool",
        tool: "getX",
        idempotency_key_from: "entity_id",
        on_error: "terminal",
      },
      {
        step_id: "dedup",
        kind: "invoke",
        invoke: "idc",
        depends_on: ["fetch"],
        default_result: { v: 1 },
        timeout_s: 30,
        on_error: "soft",
      },
    ]);
    expect(plan[0]).toMatchObject({
      stepId: "fetch",
      kind: "tool",
      tool: "getX",
      idempotencyKeyFrom: "entity_id",
      onError: "terminal",
    });
    expect(plan[1]).toMatchObject({
      stepId: "dedup",
      kind: "invoke",
      invoke: "idc",
      dependsOn: ["fetch"],
      timeoutS: 30,
      onError: "soft",
    });
    expect(plan[1]!.defaultResult).toEqual({ v: 1 });
  });
  it("normalizes snake_case exact tool dataflow", () => {
    const [step] = parsePlan([
      {
        step_id: "fetch",
        kind: "tool",
        tool: "records.fetch",
        tool_arguments: {
          id: { from: "input.id" },
          kind: { const: "candidate" },
        },
        result_map: { fields: { record_id: "result.id" }, include_raw: true },
      },
    ]);
    expect(step).toMatchObject({
      toolArguments: { id: { from: "input.id" }, kind: { const: "candidate" } },
      resultMap: { fields: { record_id: "result.id" }, includeRaw: true },
    });
  });
  it("normalizes legacy named-result references to results.<stepId>", () => {
    const plan = parsePlan([
      {
        step_id: "parse-resume",
        kind: "tool",
        tool: "parseResumeApi",
        idempotency_key_from: "resume_id",
        on_error: "terminal",
      },
      {
        step_id: "valid",
        kind: "condition",
        condition: "parse-resume.result.name != null",
      },
    ]);
    expect(plan[1]?.condition).toBe("results.parse-resume.result.name != null");
    expect(validatePlan(plan).ok).toBe(true);
  });
  it("drops malformed entries (no stepId/kind)", () => {
    const plan = parsePlan([
      { kind: "tool" },
      "garbage",
      { step_id: "ok", kind: "logic" },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.stepId).toBe("ok");
  });
  it("normalizes foreach + emit snake_case fields recursively", () => {
    const plan = parsePlan([
      {
        step_id: "each",
        kind: "foreach",
        items_from: "input.items",
        item_as: "row",
        item_key_from: "row.id",
        body: [
          { step_id: "save", kind: "tool", tool: "save", on_error: "terminal" },
          {
            step_id: "done",
            kind: "emit",
            emit_event: "ROW_DONE",
            emit_payload_from: "results.save",
          },
        ],
      },
    ]);
    expect(plan[0]).toMatchObject({
      stepId: "each",
      kind: "foreach",
      itemsFrom: "input.items",
      itemAs: "row",
      itemKeyFrom: "row.id",
    });
    expect(plan[0]!.body?.[1]).toMatchObject({
      kind: "emit",
      emitEvent: "ROW_DONE",
      emitPayloadFrom: "results.save",
    });
  });
  it("normalizes a snake_case on_error predicate ladder", () => {
    const plan = parsePlan([
      {
        step_id: "call",
        kind: "tool",
        tool: "external.call",
        idempotency_key_from: "entity_id",
        on_error: [
          { when: "status==429", do: "park", suppress_emit: true },
          {
            when: "status>=400&&status<500",
            do: "continue",
            default_result: null,
            emit_event: "REQUEST_REJECTED",
          },
          { default: "terminal" },
        ],
      },
    ]);
    expect(plan[0]!.errorPolicy).toEqual([
      { when: "status==429", do: "park", suppressEmit: true },
      {
        when: "status>=400&&status<500",
        do: "continue",
        defaultResult: null,
        emitEvent: "REQUEST_REJECTED",
      },
      { default: "terminal" },
    ]);
    expect(plan[0]!.onError).toBeUndefined();
  });
});

describe("validatePlan — enforces production discipline (Phase 1)", () => {
  const ok: PlanStep[] = [
    {
      stepId: "fetch",
      kind: "tool",
      tool: "getReq",
      idempotencyKeyFrom: "entity_id",
      onError: "terminal",
    },
    { stepId: "is-ok", kind: "condition", condition: "lastResult != null" },
    {
      stepId: "persist",
      kind: "tool",
      tool: "save",
      idempotencyKeyFrom: "entity_id",
      onError: "terminal",
      dependsOn: ["is-ok"],
    },
  ];
  it("accepts a well-formed plan", () => {
    expect(validatePlan(ok).ok).toBe(true);
  });
  it("rejects duplicate stepIds", () => {
    const r = validatePlan([
      { stepId: "a", kind: "logic" },
      { stepId: "a", kind: "logic" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplicate/i);
  });
  it("rejects stepIds that cannot be addressed by the named-result DSL", () => {
    const result = validatePlan([{ stepId: "解析 简历", kind: "logic" }]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/stepId|addressable/i);
  });
  it("rejects a tool step missing its tool", () => {
    expect(
      validatePlan([
        {
          stepId: "x",
          kind: "tool",
          idempotencyKeyFrom: "id",
          onError: "terminal",
        },
      ]).ok,
    ).toBe(false);
  });
  it("rejects a side-effecting (tool/invoke) step with no idempotencyKeyFrom", () => {
    const r = validatePlan([
      { stepId: "x", kind: "tool", tool: "t", onError: "terminal" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/idempotency/i);
  });
  it("rejects a side-effecting step with no onError policy", () => {
    const r = validatePlan([
      { stepId: "x", kind: "tool", tool: "t", idempotencyKeyFrom: "id" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/onError|on_error|failure/i);
  });
  it("accepts a safe errorPolicy and rejects unsafe/incomplete ladders", () => {
    const base = {
      stepId: "x",
      kind: "tool" as const,
      tool: "external.call",
      idempotencyKeyFrom: "entity_id",
    };
    expect(
      validatePlan(
        [
          {
            ...base,
            errorPolicy: [
              { when: "status==429||code==QUOTA_EXHAUSTED", do: "park" },
              {
                when: "status>=400&&status<500",
                do: "continue",
                defaultResult: null,
                emitEvent: "REQUEST_REJECTED",
              },
              { default: "terminal" },
            ],
          },
        ],
        { declaredEvents: ["REQUEST_REJECTED"] },
      ),
    ).toEqual({
      ok: true,
      errors: [],
      warnings: [
        'step "x": legacy whole-carry tool invocation (toolArguments is absent)',
      ],
    });

    const unsafe = validatePlan([
      {
        ...base,
        errorPolicy: [
          { when: "process.exit()", do: "continue", defaultResult: null },
          { default: "terminal" },
        ],
      },
    ]);
    expect(unsafe.errors.join(" ")).toMatch(/forbidden|predicate/i);

    const incomplete = validatePlan([
      {
        ...base,
        errorPolicy: [{ when: "status==429", do: "park" }],
      },
    ]);
    expect(incomplete.errors.join(" ")).toMatch(/default/i);
  });
  it("rejects a condition step with no expression", () => {
    expect(validatePlan([{ stepId: "c", kind: "condition" }]).ok).toBe(false);
  });

  it("validates safe condition guards on non-condition steps", () => {
    const guardedEmit: PlanStep[] = [
      {
        stepId: "emit-passed",
        kind: "emit",
        emitEvent: "PASSED",
        condition: 'input.selected_event == "PASSED"',
      },
    ];
    expect(validatePlan(guardedEmit, { declaredEvents: ["PASSED"] }).ok).toBe(
      true,
    );
    expect(
      validatePlan([
        {
          ...guardedEmit[0]!,
          condition: "the outcome looks good",
        },
      ]).errors.join(" "),
    ).toMatch(/invalid condition/);
    expect(
      validatePlan([
        {
          ...guardedEmit[0]!,
          routes: { onTrue: "PASSED", onFalse: "FAILED" },
        },
      ]).errors.join(" "),
    ).toMatch(/routes is only valid for condition/);
  });

  it("rejects non-positive or fractional action timeouts", () => {
    expect(
      validatePlan([
        { stepId: "c", kind: "condition", condition: "true", timeoutS: 0 },
      ]).errors.join(" "),
    ).toMatch(/timeoutS/);
    expect(
      validatePlan([
        { stepId: "c", kind: "condition", condition: "true", timeoutS: 1.5 },
      ]).errors.join(" "),
    ).toMatch(/timeoutS/);
  });
  it("rejects natural-language and unknown named-result conditions at design time", () => {
    expect(
      validatePlan([
        {
          stepId: "c",
          kind: "condition",
          condition: "invitation generation succeeded",
        },
      ]).ok,
    ).toBe(false);
    const unknown = validatePlan([
      {
        stepId: "c",
        kind: "condition",
        condition: "results.future.result.ok == true",
      },
    ]);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join(" ")).toMatch(/unknown|forward/i);
  });
  it("accepts the safe collection predicates implemented by the runtime", () => {
    const collectionPlan: PlanStep[] = [
      { stepId: "parse", kind: "logic" },
      {
        stepId: "has-items",
        kind: "condition",
        condition:
          "Array.isArray(results.parse.result.items) && results.parse.result.items.includes('ready')",
      },
    ];
    const result = validatePlan(collectionPlan);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    // #G2 — the predicate itself is fine; the plan is flagged because nothing
    // reads the verdict. A trailing condition with no dependents and no routes
    // is computed and discarded, which is how routing rules went missing.
    expect(result.warnings.join(" ")).toMatch(/never read/);
  });

  it("#G2 flags a routing condition whose result nothing reads, and validates declared routes", () => {
    const dead: PlanStep[] = [
      {
        stepId: "score-passes",
        kind: "condition",
        condition: "event.data.score >= 40",
      },
    ];
    expect(validatePlan(dead).warnings.join(" ")).toMatch(/never read/);

    const routed: PlanStep[] = [
      {
        stepId: "score-passes",
        kind: "condition",
        condition: "event.data.score >= 40",
        routes: { onTrue: "MATCHED", onFalse: "REJECTED" },
      },
    ];
    const ok = validatePlan(routed, {
      declaredEvents: ["MATCHED", "REJECTED"],
    });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join(" ")).not.toMatch(/never read/);

    // A route must name an event this agent is actually allowed to emit.
    const undeclared = validatePlan(routed, { declaredEvents: ["MATCHED"] });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors.join(" ")).toMatch(/REJECTED.*allow-list/);
  });
  it("rejects mutually exclusive emits whose branch lives only in prose", () => {
    // The exact shape a live six-agent fleet generated: one `logic` step
    // "decides" the outcome, then two emit steps depend on it with no
    // condition. The runtime only gates on `type:"condition"` results, so both
    // events fire every run and the failure branch pushes the chain forward
    // alongside the success branch.
    const proseBranch: PlanStep[] = [
      {
        stepId: "emit_resume_outcome",
        kind: "logic",
        description:
          "读取 is_locked：true 则 selected_event=RESUME_LOCKED_CONFLICT，否则 RESUME_PROCESSED",
      },
      {
        stepId: "emit_processed",
        kind: "emit",
        emitEvent: "RESUME_PROCESSED",
        dependsOn: ["emit_resume_outcome"],
      },
      {
        stepId: "emit_locked",
        kind: "emit",
        emitEvent: "RESUME_LOCKED_CONFLICT",
        dependsOn: ["emit_resume_outcome"],
      },
    ];
    const flagged = validatePlan(proseBranch, {
      declaredEvents: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"],
    });
    expect(flagged.ok).toBe(false);
    expect(flagged.errors.join(" ")).toMatch(/emit_resume_outcome/);
    expect(flagged.errors.join(" ")).toMatch(/condition/);

    // A real branch — a condition step with routes — stays legal.
    const routed: PlanStep[] = [
      {
        stepId: "resume_locked",
        kind: "condition",
        condition: "event.data.is_locked === true",
        routes: {
          onTrue: "RESUME_LOCKED_CONFLICT",
          onFalse: "RESUME_PROCESSED",
        },
      },
    ];
    expect(
      validatePlan(routed, {
        declaredEvents: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"],
      }).ok,
    ).toBe(true);

    // So does a fan-out that is genuinely unconditional: the same event twice
    // is not a branch, and one emit per predecessor is not a branch either.
    const fanOut: PlanStep[] = [
      { stepId: "work", kind: "logic" },
      {
        stepId: "emit_a",
        kind: "emit",
        emitEvent: "DONE",
        dependsOn: ["work"],
      },
    ];
    expect(validatePlan(fanOut, { declaredEvents: ["DONE"] }).ok).toBe(true);

    const guardedEmits: PlanStep[] = [
      { stepId: "select", kind: "logic" },
      {
        stepId: "emit_ok",
        kind: "emit",
        emitEvent: "DONE",
        dependsOn: ["select"],
        condition: 'results.select.selected_event == "DONE"',
      },
      {
        stepId: "emit_failed",
        kind: "emit",
        emitEvent: "FAILED",
        dependsOn: ["select"],
        condition: 'results.select.selected_event == "FAILED"',
      },
    ];
    expect(
      validatePlan(guardedEmits, {
        declaredEvents: ["DONE", "FAILED"],
      }).ok,
    ).toBe(true);
  });

  it("rejects an invoke step with no target", () => {
    expect(
      validatePlan([
        {
          stepId: "i",
          kind: "invoke",
          idempotencyKeyFrom: "id",
          onError: "soft",
        },
      ]).ok,
    ).toBe(false);
  });
  it("rejects soft invoke without an explicit defaultResult", () => {
    const missing = validatePlan([
      {
        stepId: "i",
        kind: "invoke",
        invoke: "child",
        idempotencyKeyFrom: "id",
        onError: "soft",
      },
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toMatch(/defaultResult/);
    expect(
      validatePlan([
        {
          stepId: "i",
          kind: "invoke",
          invoke: "child",
          idempotencyKeyFrom: "id",
          onError: "soft",
          defaultResult: null,
        },
      ]).ok,
    ).toBe(true);
  });
  it("rejects a dependsOn that references an unknown / forward step", () => {
    const r = validatePlan([
      {
        stepId: "a",
        kind: "tool",
        tool: "t",
        idempotencyKeyFrom: "id",
        onError: "terminal",
        dependsOn: ["later"],
      },
      { stepId: "later", kind: "logic" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/depends|forward|unknown/i);
  });
  it("does not require idempotency/onError on logic or condition steps", () => {
    expect(
      validatePlan([
        { stepId: "think", kind: "logic" },
        { stepId: "c", kind: "condition", condition: "true" },
      ]).ok,
    ).toBe(true);
  });
  it("requires stable foreach contracts and validates explicit events against the allow-list", () => {
    const valid: PlanStep[] = [
      {
        stepId: "each",
        kind: "foreach",
        itemsFrom: "input.items",
        itemKeyFrom: "id",
        body: [
          { stepId: "save", kind: "tool", tool: "save", onError: "terminal" },
          { stepId: "done", kind: "emit", emitEvent: "ROW_DONE" },
        ],
      },
    ];
    expect(
      validatePlan(valid, {
        knownTools: ["save"],
        declaredEvents: ["ROW_DONE"],
      }),
    ).toEqual({
      ok: true,
      errors: [],
      warnings: [
        'step "each" body: step "save": legacy whole-carry tool invocation (toolArguments is absent)',
      ],
    });
    const invalid = validatePlan(
      [
        {
          stepId: "each",
          kind: "foreach",
          itemsFrom: "input.items",
          body: [{ stepId: "done", kind: "emit", emitEvent: "INVENTED" }],
        },
      ],
      { declaredEvents: ["ROW_DONE"] },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(" ")).toMatch(/itemKeyFrom|allow-list/);
    expect(
      validatePlan([
        {
          stepId: "each",
          kind: "foreach",
          itemsFrom: "input.items.map(x=>x)",
          itemKeyFrom: "id",
          body: [{ stepId: "done", kind: "emit", emitEvent: "ROW_DONE" }],
        },
      ]).errors.join(" "),
    ).toMatch(/safe data path/);
  });

  it("allows invoke and recursively validates nested foreach bodies", () => {
    const nested: PlanStep[] = [
      {
        stepId: "outer",
        kind: "foreach",
        itemsFrom: "input.groups",
        itemKeyFrom: "id",
        body: [
          {
            stepId: "inner",
            kind: "foreach",
            itemsFrom: "locals.item.rows",
            itemAs: "row",
            itemKeyFrom: "row.id",
            body: [
              {
                stepId: "child",
                kind: "invoke",
                invoke: "child-agent",
                timeoutS: 5,
                onError: "terminal",
              },
            ],
          },
        ],
      },
    ];
    expect(validatePlan(nested)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
    nested[0]!.body![0]!.body![0]!.timeoutS = 0;
    expect(validatePlan(nested).errors.join(" ")).toMatch(
      /outer.*inner.*timeoutS/,
    );
  });

  it("validates exact tool dataflow and calls out legacy whole-carry", () => {
    const exact = validatePlan([
      {
        stepId: "call",
        kind: "tool",
        tool: "api.call",
        toolArguments: {
          id: { from: "input.id" },
          item_id: { from: "locals.row.id", required: false },
          mode: { const: "strict" },
        },
        resultMap: { fields: { id: "result.data.id" }, includeRaw: true },
        idempotencyKeyFrom: "id",
        onError: "terminal",
      },
    ]);
    expect(exact).toEqual({ ok: true, errors: [], warnings: [] });

    const legacy = validatePlan([
      {
        stepId: "call",
        kind: "tool",
        tool: "api.call",
        idempotencyKeyFrom: "id",
        onError: "terminal",
      },
    ]);
    expect(legacy.warnings).toEqual([
      'step "call": legacy whole-carry tool invocation (toolArguments is absent)',
    ]);

    const invalid = validatePlan([
      {
        stepId: "call",
        kind: "tool",
        tool: "api.call",
        toolArguments: { id: { from: "id" }, raw: "input.raw" as never },
        resultMap: { fields: { guessed: "data.id", _raw: "result" } },
        idempotencyKeyFrom: "id",
        onError: "terminal",
      },
    ]);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(" ")).toMatch(/rooted|bare values|_raw/);
  });
});

// #G12/#G13 —— 新 IR 的完整往返。设计端能写、投影能存、运行时读不回来，比没有这个字段更糟：
// 它会让一条被声明的保证在部署路径上悄悄消失。所以每个字段都要 parse → validate → project
// → 再 parse 后逐字节相等，并且半残的描述符必须【校验失败】，而不是被半填充地收下。
describe("#G12/#G13 IR round-trip", () => {
  const withDataflow = (step: Partial<PlanStep>): PlanStep =>
    ({
      stepId: "call-vendor",
      kind: "tool",
      tool: "vendor.call",
      ...step,
    }) as PlanStep;

  it("carries fromFirst through parse → project → parse unchanged", () => {
    const step = withDataflow({
      toolArguments: {
        dedupe_key: { fromFirst: ["input.etag", "results.download.sha256"] },
        mode: { const: "strict" },
      },
    });
    const actions = projectPlanToActions({
      ...({
        actionName: "processResume",
        slug: "s",
        short: "S",
        tools: ["vendor.call"],
      } as unknown as GeneratedAgentSpec),
      plan: [step],
    } as GeneratedAgentSpec);
    // manifest 侧是 snake_case
    expect(actions[0]!.tool_arguments).toEqual({
      dedupe_key: { from_first: ["input.etag", "results.download.sha256"] },
      mode: { const: "strict" },
    });
    // 读回来是 camelCase，且与原值一致
    const back = parsePlan(
      actions.map((a) => ({
        ...a,
        stepId: a.name,
        kind: "tool",
        tool: "vendor.call",
      })),
    );
    expect(back[0]!.toolArguments).toEqual(step.toolArguments);
  });

  it("carries an optional result field with fallbacks through the same round-trip", () => {
    const step = withDataflow({
      resultMap: {
        fields: {
          score: { from: "result.data.score", required: false, default: null },
          title: {
            from: "result.title",
            fallbackFrom: ["result.data.title"],
            fallbackConst: "未命名岗位",
          },
          id: "result.id",
        },
      },
    });
    const actions = projectPlanToActions({
      ...({
        actionName: "createJD",
        slug: "s",
        short: "S",
        tools: ["vendor.call"],
      } as unknown as GeneratedAgentSpec),
      plan: [step],
    } as GeneratedAgentSpec);
    expect(actions[0]!.result_map).toEqual({
      fields: {
        score: { from: "result.data.score", required: false, default: null },
        title: {
          from: "result.title",
          fallback_from: ["result.data.title"],
          fallback_const: "未命名岗位",
        },
        id: "result.id",
      },
    });
    const back = parsePlan(
      actions.map((a) => ({
        ...a,
        stepId: a.name,
        kind: "tool",
        tool: "vendor.call",
      })),
    );
    expect(back[0]!.resultMap).toEqual(step.resultMap);
  });

  it("fails closed on half-formed descriptors instead of half-populating them", () => {
    // 一个候选的 fromFirst 就是 {from}，多出来的语义只会误导读者
    expect(
      validatePlan([
        withDataflow({ toolArguments: { k: { fromFirst: ["input.a"] } } }),
      ]).errors.join(" "),
    ).toMatch(/at least two candidates/);
    // 三选一
    expect(
      validatePlan([
        withDataflow({
          toolArguments: {
            k: { from: "input.a", fromFirst: ["input.a", "input.b"] } as never,
          },
        }),
      ]).ok,
    ).toBe(false);
    // 可选性放宽的是「取不到怎么办」，不是「能取哪里」
    expect(
      validatePlan([
        withDataflow({
          toolArguments: {
            k: { fromFirst: ["input.a", "process.env.SECRET"] },
          },
        }),
      ]).errors.join(" "),
    ).toMatch(/safe path rooted/);
    expect(
      validatePlan([
        withDataflow({ resultMap: { fields: { s: { from: "data.score" } } } }),
      ]).errors.join(" "),
    ).toMatch(/rooted at result/);
    expect(
      validatePlan([
        withDataflow({
          resultMap: { fields: { s: { from: "result.a", nope: 1 } as never } },
        }),
      ]).errors.join(" "),
    ).toMatch(/unknown key/);
  });
});

// #G14/#G15 —— 声明式部署路径还执行不了补偿写和成功路径健康判定。投出一个悄悄丢掉这些
// 保证的 manifest，会一路绿到生产然后在真实故障上安静地不补偿；所以投影当场失败并说清缺什么。
describe("#G14/#G15 fail-closed projection", () => {
  const withGuarantee = (step: Partial<PlanStep>): GeneratedAgentSpec =>
    spec({
      actionName: "processResume",
      plan: [
        { stepId: "s", kind: "tool", tool: "vendor.call", ...step } as PlanStep,
      ],
    });

  it("refuses to project a compensating write the runtime cannot perform", () => {
    expect(() =>
      projectPlanToActions(
        withGuarantee({
          errorPolicy: [
            {
              when: "status>=500",
              do: "terminal",
              compensate: { tool: "records.upsert", bestEffort: true },
            },
          ],
        }),
      ),
    ).toThrow(/compensate/);
  });

  it("refuses to project success-path health signals the runtime never evaluates", () => {
    expect(() =>
      projectPlanToActions(
        withGuarantee({
          healthSignals: [
            { when: "status == 200", signal: "empty_body", fatal: true },
          ],
        }),
      ),
    ).toThrow(/healthSignals/);
  });

  it("still projects a plan that declares neither", () => {
    expect(projectPlanToActions(withGuarantee({}))).toHaveLength(1);
  });

  it("looks inside a foreach body — a nested guarantee is just as unhonoured", () => {
    expect(() =>
      projectPlanToActions(
        spec({
          actionName: "ruleCheck",
          plan: [
            {
              stepId: "each",
              kind: "foreach",
              itemsFrom: "input.items",
              itemKeyFrom: "item.id",
              body: [
                {
                  stepId: "one",
                  kind: "tool",
                  tool: "vendor.call",
                  healthSignals: [{ when: "status == 200", signal: "empty" }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/one\.healthSignals/);
  });
});
