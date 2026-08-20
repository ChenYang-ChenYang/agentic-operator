import { describe, expect, it } from "vitest";
import type { BrainTool } from "./brain-types";
import {
  ROOT_BRAIN_TOOLS,
  SUBAGENT_BRAIN_TOOLS,
} from "./conductor";
import {
  assertBrainToolGatesDeclared,
  brainToolEffect,
  isSideEffectTool,
  registeredBrainToolNames,
  sideEffectToolNames,
  stageAdvancingTools,
} from "./side-effect-tools";

// #SIDE-EFFECT-CKPT / #TOOL-EFFECT — these assertions exercise the actual
// dispatchable surfaces exported by the conductor. The registry is derived
// from each BrainTool.effect declaration; there is no parallel name list.
describe("brain-tool effect registry", () => {
  it("registers every root/sub-agent tool and accepts every declared gate", () => {
    const dispatchable = new Set(
      [...ROOT_BRAIN_TOOLS, ...SUBAGENT_BRAIN_TOOLS].map((tool) => tool.name),
    );

    expect(new Set(registeredBrainToolNames())).toEqual(dispatchable);
    expect(() =>
      assertBrainToolGatesDeclared(ROOT_BRAIN_TOOLS, SUBAGENT_BRAIN_TOOLS),
    ).not.toThrow();
  });

  it("rejects an external stage-free effect without a reviewed reason", () => {
    const undeclaredReason: BrainTool = {
      name: "test_unreviewed_external_effect",
      effect: {
        sideEffect: "call",
        scope: "external",
        checkpoint: "immediate",
        gate: "any",
      },
      description: "invalid test descriptor",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, summary: "not executed" };
      },
    };

    expect(() => assertBrainToolGatesDeclared([undeclaredReason])).toThrow(
      /stageFreeReason/,
    );
  });

  it("keeps declarations tied to each tool's real blast radius", () => {
    expect(brainToolEffect("read_ontology")).toMatchObject({
      sideEffect: "read",
      scope: "external",
      checkpoint: "turn",
      gate: "read",
      advancesStage: true,
    });
    expect(brainToolEffect("sandbox_run")).toMatchObject({
      sideEffect: "call",
      scope: "sandbox",
      checkpoint: "immediate",
      gate: "sandbox",
      advancesStage: true,
    });
    expect(brainToolEffect("save_draft")).toMatchObject({
      sideEffect: "write",
      scope: "factory_durable",
      checkpoint: "immediate",
      gate: "any",
    });
    expect(brainToolEffect("revise_ontology")).toMatchObject({
      sideEffect: "read",
      scope: "none",
      checkpoint: "turn",
      gate: "any",
    });
    expect(brainToolEffect("spawn_subagent")).toMatchObject({
      sideEffect: "call",
      scope: "external",
      checkpoint: "immediate",
      gate: "any",
    });
    expect(brainToolEffect("delivery_bundle")).toMatchObject({
      sideEffect: "read",
      scope: "conversation",
      checkpoint: "turn",
      gate: "deliver",
      advancesStage: true,
    });
  });

  it("derives immediate checkpoints without classifying reads and turn-local work as effects", () => {
    for (const name of [
      "sandbox_run",
      "finish",
      "save_draft",
      "run_regression",
      "create_tool",
      "create_skill",
      "create_signed_fixture",
      "confirm_integration_profile",
      "generate_report",
      "probe_tool",
      "spawn_subagent",
      "design_fleet",
    ]) {
      expect(isSideEffectTool(name), `${name} needs an immediate checkpoint`).toBe(
        true,
      );
    }

    for (const name of [
      "read_ontology",
      "list_agents",
      "describe_object",
      "read_spec",
      "review_agent",
      "create_plan",
      "understand_ontology",
      "design_agent",
      "codegen_agent",
      "revise_ontology",
      "delivery_bundle",
    ]) {
      expect(isSideEffectTool(name), `${name} checkpoints at turn end`).toBe(
        false,
      );
    }

    const immediate = sideEffectToolNames();
    expect(immediate.has("save_draft")).toBe(true);
    expect(immediate.has("delivery_bundle")).toBe(false);
  });

  it("fails closed for unknown tool names", () => {
    expect(isSideEffectTool("some_new_tool_2027")).toBe(true);
    expect(isSideEffectTool("")).toBe(true);
    expect(brainToolEffect("some_new_tool_2027")).toBeUndefined();
  });

  it("derives stage movement only from advancesStage declarations", () => {
    const stages = stageAdvancingTools();
    expect(stages.get("read_ontology")).toBe("read");
    expect(stages.get("create_plan")).toBe("plan");
    expect(stages.get("design_agent")).toBe("design");
    expect(stages.get("sandbox_run")).toBe("sandbox");
    expect(stages.get("finish")).toBe("deliver");
    expect(stages.has("read_spec")).toBe(false);
    expect(stages.has("search_tools")).toBe(false);
  });
});
