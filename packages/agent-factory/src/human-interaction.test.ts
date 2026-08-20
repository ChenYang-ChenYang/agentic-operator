import { describe, expect, it } from "vitest";
import type { BrainCtx, BrainEvent } from "./brain-types";
import {
  activeHumanInteraction,
  bindHumanInteractionEvent,
  closeHumanInteraction,
  humanInteractionMatchesSubject,
} from "./human-interaction";

function ctx(): BrainCtx {
  return {
    domain: "dom",
    goal: "goal",
    emit: () => undefined,
    ports: {} as BrainCtx["ports"],
    specs: [],
    ontology: null,
    budget: { maxTokens: null, maxTurns: 10 },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    currentPlan: null,
    toolCatalog: [],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    lastSandbox: null,
    lastValidation: null,
    humanDirectives: [],
    priorReflections: [],
  };
}

describe("addressed human interactions", () => {
  it("keeps an id stable for an exact re-emission and rotates it when the subject changes", () => {
    const state = ctx();
    state.awaitingClarify = true;
    const first = bindHumanInteractionEvent(state, {
      t: "clarify",
      question: "选择平台？",
      awaitingAnswer: true,
    }) as Extract<BrainEvent, { t: "clarify" }>;
    const replay = bindHumanInteractionEvent(state, {
      t: "clarify",
      question: "选择平台？",
      awaitingAnswer: true,
    }) as Extract<BrainEvent, { t: "clarify" }>;
    const replacement = bindHumanInteractionEvent(state, {
      t: "clarify",
      question: "确认新的平台？",
      awaitingAnswer: true,
    }) as Extract<BrainEvent, { t: "clarify" }>;

    expect(first.interactionId).toMatch(/^hitl_/);
    expect(replay.interactionId).toBe(first.interactionId);
    expect(replacement.interactionId).not.toBe(first.interactionId);
    expect(activeHumanInteraction(state)?.interactionId).toBe(replacement.interactionId);
  });

  it("uses clarify > approval > boundary and retires only the consumed kind", () => {
    const state = ctx();
    state.awaitingClarify = true;
    state.awaitingApproval = true;
    state.awaitingBoundary = true;
    bindHumanInteractionEvent(state, { t: "clarify", question: "Q", awaitingAnswer: true });
    bindHumanInteractionEvent(state, { t: "test.cases", cases: [], awaitingApproval: true });
    bindHumanInteractionEvent(state, { t: "boundary.cases", proposals: [], awaitingDecision: true });

    expect(activeHumanInteraction(state)?.kind).toBe("clarify");
    closeHumanInteraction(state, "clarify");
    state.awaitingClarify = false;
    expect(activeHumanInteraction(state)?.kind).toBe("test_approval");
    expect(state.humanInteractions?.boundary).toBeTruthy();
  });

  it("binds a durable interaction to the exact prompt subject", () => {
    const state = ctx();
    state.awaitingClarify = true;
    const prompt = {
      question: "选择哪个连接？",
      context: "requirement=req-1",
      options: [{ label: "Allmeta", value: "option-token" }],
    };
    bindHumanInteractionEvent(state, {
      t: "clarify",
      ...prompt,
      awaitingAnswer: true,
    });
    const interaction = activeHumanInteraction(state)!;

    expect(humanInteractionMatchesSubject(interaction, "clarify", prompt)).toBe(
      true,
    );
    expect(
      humanInteractionMatchesSubject(interaction, "clarify", {
        ...prompt,
        question: "已被替换的旧问题",
      }),
    ).toBe(false);
  });
});
