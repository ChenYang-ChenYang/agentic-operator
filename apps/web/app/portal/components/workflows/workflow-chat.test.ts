import { describe, expect, it } from "vitest";
import type {
  AgentDefinitionV2,
  WorkflowRunEntrypoint,
  WorkflowTestRunResponse,
} from "@agentic/contracts";
import {
  MAX_CHAT_HISTORY_TURNS,
  chatCapableEntrypoint,
  chatIsDefault,
  hasIncompleteCascade,
  historyForNextTurn,
  replyBubblesFromRun,
} from "./workflow-chat";

function entrypoint(
  overrides: Partial<WorkflowRunEntrypoint> = {},
): WorkflowRunEntrypoint {
  return {
    event: "SUPPORT_REQUESTED",
    source: "external",
    recommended: true,
    listenerAgentIds: ["starter"],
    listenerTitles: ["Starter agent"],
    requiresRawPayload: false,
    inputs: [
      {
        id: "prompt",
        label: "Message",
        description: null,
        kind: "prompt",
        required: false,
        schema: { type: "string" },
        sensitivity: "none",
        consumers: ["starter"],
        bindings: [],
      },
    ],
    ...overrides,
  } as WorkflowRunEntrypoint;
}

function agent(overrides: Record<string, unknown> = {}): AgentDefinitionV2 {
  return {
    id: "starter",
    name: "starterAgent",
    title: "Starter agent",
    outputs: [
      { id: "reply", label: "Reply", required: true, schema: { type: "string" } },
    ],
    extensions: { starter: true },
    ...overrides,
  } as unknown as AgentDefinitionV2;
}

function runResponse(
  overrides: Partial<WorkflowTestRunResponse> = {},
): WorkflowTestRunResponse {
  return {
    terminalOutputs: [],
    agentRuns: [],
    warnings: [],
    summary: { agentRuns: 1 },
    ...overrides,
  } as unknown as WorkflowTestRunResponse;
}

describe("chatCapableEntrypoint", () => {
  it("selects a prompt-only external entrypoint", () => {
    expect(chatCapableEntrypoint([entrypoint()])?.event).toBe(
      "SUPPORT_REQUESTED",
    );
  });

  it("rejects an entrypoint that needs a structured payload", () => {
    expect(
      chatCapableEntrypoint([entrypoint({ requiresRawPayload: true })]),
    ).toBeNull();
  });

  it("rejects an entrypoint with a second required input", () => {
    const withExtra = entrypoint();
    withExtra.inputs = [
      ...withExtra.inputs,
      {
        id: "record",
        label: "Record",
        description: null,
        kind: "value",
        required: true,
        schema: { type: "object" },
        sensitivity: "none",
        consumers: ["starter"],
        bindings: [],
      } as unknown as (typeof withExtra.inputs)[number],
    ];
    expect(chatCapableEntrypoint([withExtra])).toBeNull();
  });

  it("ignores internal handoff events", () => {
    expect(chatCapableEntrypoint([entrypoint({ source: "internal" })])).toBeNull();
  });
});

describe("chatIsDefault", () => {
  it("is true only when every listener opted in via extensions.starter", () => {
    expect(chatIsDefault([agent()], entrypoint())).toBe(true);
  });

  it("is false for an ordinary tenant agent that merely looks chat-shaped", () => {
    // Guards the real regression: v1 tenant manifests normalise to a
    // prompt+payload port pair with no trigger_bindings, so a shape-only
    // heuristic would flip a production entrypoint into a chat box.
    expect(chatIsDefault([agent({ extensions: {} })], entrypoint())).toBe(false);
  });

  it("is false when any listener has not opted in", () => {
    const entry = entrypoint({ listenerAgentIds: ["starter", "other"] });
    expect(
      chatIsDefault(
        [agent(), agent({ id: "other", extensions: undefined })],
        entry,
      ),
    ).toBe(false);
  });

  it("is false without an entrypoint", () => {
    expect(chatIsDefault([agent()], null)).toBe(false);
  });
});

describe("replyBubblesFromRun", () => {
  it("unwraps a single string output port to prose", () => {
    const bubbles = replyBubblesFromRun(
      runResponse({
        terminalOutputs: [
          {
            agentRunId: "r1",
            agentId: "starter",
            agentTitle: "Starter agent",
            output: { reply: "Two sentences, plainly." },
            emittedEvents: [],
          },
        ],
      }),
      [agent()],
    );
    expect(bubbles).toEqual([
      { role: "assistant", content: "Two sentences, plainly." },
    ]);
  });

  it("bylines each agent when several produced terminal output", () => {
    const bubbles = replyBubblesFromRun(
      runResponse({
        terminalOutputs: [
          {
            agentRunId: "r1",
            agentId: "starter",
            agentTitle: "Starter agent",
            output: { reply: "First." },
            emittedEvents: [],
          },
          {
            agentRunId: "r2",
            agentId: "second",
            agentTitle: "Second agent",
            output: { reply: "Second." },
            emittedEvents: [],
          },
        ],
      }),
      [agent(), agent({ id: "second" })],
    );
    expect(bubbles.map((bubble) => bubble.byline)).toEqual([
      "Starter agent",
      "Second agent",
    ]);
  });

  it("pretty-prints a structured result rather than dropping it", () => {
    const multiOutput = agent({
      outputs: [
        { id: "a", label: "A", required: true, schema: { type: "string" } },
        { id: "b", label: "B", required: true, schema: { type: "string" } },
      ],
    });
    const bubbles = replyBubblesFromRun(
      runResponse({
        terminalOutputs: [
          {
            agentRunId: "r1",
            agentId: "starter",
            agentTitle: "Starter agent",
            output: { a: "1", b: "2" },
            emittedEvents: [],
          },
        ],
      }),
      [multiOutput],
    );
    expect(bubbles[0]!.content).toContain('"a"');
  });

  it("surfaces the failure instead of showing an empty bubble", () => {
    const bubbles = replyBubblesFromRun(
      runResponse({
        agentRuns: [
          {
            error: { code: "execution_failed", message: "Provider timed out." },
          },
        ] as unknown as WorkflowTestRunResponse["agentRuns"],
      }),
      [agent()],
    );
    expect(bubbles[0]!.content).toBe("Provider timed out.");
  });
});

describe("historyForNextTurn", () => {
  it("caps at the shared budget", () => {
    const turns = Array.from({ length: 30 }, (_, index) => ({
      role: "user" as const,
      content: `turn ${index}`,
    }));
    const bounded = historyForNextTurn(turns);
    expect(bounded).toHaveLength(MAX_CHAT_HISTORY_TURNS);
    expect(bounded.at(-1)!.content).toBe("turn 29");
  });
});

describe("hasIncompleteCascade", () => {
  it("flags a multi-agent workflow where a downstream agent never ran", () => {
    expect(
      hasIncompleteCascade(runResponse({ summary: { agentRuns: 1 } as never }), [
        agent(),
        agent({ id: "second" }),
      ]),
    ).toBe(true);
  });

  it("stays quiet for a single-agent workflow", () => {
    expect(
      hasIncompleteCascade(runResponse({ summary: { agentRuns: 1 } as never }), [
        agent(),
      ]),
    ).toBe(false);
  });
});
