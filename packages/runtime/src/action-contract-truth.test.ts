import { describe, expect, it } from "vitest";

import { ActionSchema, AgentSchema } from "./manifest";

const base = {
  order: "1",
  name: "step",
  description: "truth contract",
};

describe("action contracts fail closed", () => {
  it.each([
    [{ ...base, type: "condition" }, "condition"],
    [{ ...base, type: "delay", delay_ms: 0 }, "delay_ms"],
    [{ ...base, type: "subflow" }, "subflow"],
    [{ ...base, type: "invoke" }, "invoke"],
    [{ ...base, type: "emit" }, "emit_event"],
  ])("rejects a no-op %s action", (action, expectedPath) => {
    const parsed = ActionSchema.safeParse(action);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes(expectedPath))).toBe(true);
    }
  });

  it("rejects legacy soft success without an explicit fallback", () => {
    const parsed = ActionSchema.safeParse({
      ...base,
      type: "invoke",
      invoke: "childAgent",
      on_error: "soft",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("default_result"))).toBe(true);
    }
  });

  it("rejects an undeclared subflow event", () => {
    const parsed = AgentSchema.safeParse({
      id: "agent-1",
      name: "parent",
      actor: ["Agent"],
      trigger: ["START"],
      triggered_event: ["DONE"],
      actions: [{ ...base, type: "subflow", subflow: "CHILD_START" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("undeclared event"))).toBe(true);
    }
  });

  it("accepts fully specified durable orchestration actions", () => {
    expect(ActionSchema.safeParse({ ...base, type: "condition", condition: "input.ready == true" }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...base, type: "delay", delay_ms: 250 }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...base, type: "subflow", subflow: "CHILD_START" }).success).toBe(true);
    expect(ActionSchema.safeParse({ ...base, type: "invoke", invoke: "childAgent" }).success).toBe(true);
  });

  it("validates executable factory input bindings against their acquisition actions", () => {
    const human = { field: "approval", type: "Boolean", required: true, kind: "human_input" as const, prompt: "是否继续？" };
    const lookup = {
      field: "stored",
      type: "String",
      required: true,
      kind: "object_lookup" as const,
      source_object: "Work.result",
      tool: "records.getWork",
      arguments: { id: "event.work_id" },
      result_path: "result",
    };
    const valid = {
      id: "bound-agent",
      name: "boundAgent",
      actor: ["Agent"],
      trigger: ["START"],
      triggered_event: ["DONE"],
      tool_use: [{ name: "records.getWork", config: { api_key_env: "WORK_API_KEY", region: "cn-east" } }],
      factory_tool_profile_refs: { "records.getWork": "profile-1" },
      factory_input_bindings: [
        { field: "work_id", type: "String", required: true, kind: "event", event_path: "work_id" },
        human,
        lookup,
        { field: "score", type: "Number", required: true, kind: "step_output", source_step: "calculate", source_output: "score" },
        { field: "api_key", type: "String", required: true, kind: "secret", reference: "tool:records.getWork:api_key_env" },
      ],
      actions: [
        { order: "1", name: "ask-input-approval", type: "manual", input_binding: human },
        { order: "2", name: "records.getWork", type: "tool", input_binding: lookup },
        { order: "3", name: "calculate", type: "logic", result_key: "calculate" },
      ],
    };
    expect(AgentSchema.safeParse(valid).success).toBe(true);
    expect(AgentSchema.safeParse({ ...valid, tool_use: [] }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...valid, actions: valid.actions.slice(0, 2) }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...base, name: "wrong", type: "tool", input_binding: lookup }).success).toBe(false);
  });

  it("rejects illegal conditions during direct manifest parsing", () => {
    expect(ActionSchema.safeParse({
      ...base,
      type: "condition",
      condition: "input.items.map(x => x.id)",
    }).success).toBe(false);
    expect(ActionSchema.safeParse({
      ...base,
      type: "condition",
      condition: "input.ready && (results.check.score >= 80 || input.force == true)",
    }).success).toBe(true);
    const proseCondition = ActionSchema.safeParse({
      ...base,
      type: "emit",
      emit_event: "DONE",
      condition: "审计已落库",
    });
    expect(proseCondition.success).toBe(true);
    if (proseCondition.success) {
      expect(proseCondition.data.condition).toBe("审计已落库");
    }
    expect(ActionSchema.safeParse({
      ...base,
      type: "tool",
      condition: "input.ready && results.check.score >= 80",
    }).success).toBe(true);
  });

  it("removes the dead action retry contract and migrates uniform legacy values to the agent", () => {
    expect(ActionSchema.safeParse({ ...base, type: "logic", retries: 2 }).success).toBe(false);

    const migrated = AgentSchema.parse({
      id: "legacy",
      name: "legacy",
      actor: ["Agent"],
      trigger: ["START"],
      actions: [
        { ...base, type: "logic", retries: 2 },
        { ...base, order: "2", name: "done", type: "emit", emit_event: "DONE", retries: 2 },
      ],
      // Required because the second action declares DONE.
      triggered_event: ["DONE"],
    });
    expect(migrated.retries).toBe(2);
    expect(migrated.actions.every((action) => !("retries" in action))).toBe(true);

    expect(() => AgentSchema.parse({
      id: "ambiguous",
      name: "ambiguous",
      actor: ["Agent"],
      trigger: ["START"],
      triggered_event: [],
      actions: [
        { ...base, type: "logic", retries: 1 },
        { ...base, order: "2", type: "logic", retries: 3 },
      ],
    })).toThrow(/conflict/i);
  });

  it.each(["tool", "logic", "condition", "emit", "foreach", "decision"] as const)(
    "accepts timeout_s on %s actions",
    (type) => {
      const additions = type === "condition"
        ? { condition: "input.ready" }
        : type === "emit"
          ? { emit_event: "DONE" }
          : type === "foreach"
            ? {
                items_from: "input.items",
                item_key_from: "item.id",
                foreach_actions: [{ ...base, type: "logic" }],
              }
            : type === "decision"
              ? {
                  decision_table: {
                    id: "d",
                    rows: [{ id: "yes", outcome: "yes" }],
                    missing: { outcome: "missing" },
                    default: { outcome: "no" },
                  },
                }
              : {};
      expect(ActionSchema.safeParse({ ...base, type, timeout_s: 5, ...additions }).success).toBe(true);
    },
  );

  it("rejects timeout_s on orchestration types with separate durable timing contracts", () => {
    expect(ActionSchema.safeParse({ ...base, type: "delay", delay_ms: 10, timeout_s: 1 }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...base, type: "subflow", subflow: "CHILD", timeout_s: 1 }).success).toBe(false);
    expect(ActionSchema.safeParse({ ...base, type: "manual", timeout_s: 1 }).success).toBe(false);
  });
});
