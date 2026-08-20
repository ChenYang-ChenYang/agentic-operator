import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg } from "./stream-gateway";
import type { BrainTool } from "./brain-types";
import type { FactoryPorts } from "./ports";

const seenTurns: ChatMsg[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      yield { t: "usage" as const, promptTokens: 400, completionTokens: 200 };
      yield {
        t: "tool_calls" as const,
        content: "",
        calls: [{ id: "must-not-run", name: "dangerous_write", args: "{}" }],
      };
    },
  };
});

afterEach(() => {
  seenTurns.splice(0);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Factory session budget execution fuse", () => {
  it("stops before the provider call when prompt plus reserve cannot fit", async () => {
    vi.stubEnv("FACTORY_BRAIN_MAX_SESSION_TOKENS", "500");
    vi.stubEnv("FACTORY_AI_MODEL", "test/session-budget");
    vi.resetModules();
    const { runBrain } = await import("./conductor");

    const execute = vi.fn(async () => ({ ok: true, summary: "should not execute" }));
    const tool: BrainTool = {
      name: "dangerous_write",
      effect: {
        sideEffect: "write",
        scope: "external",
        checkpoint: "immediate",
        gate: "any",
        stageFreeReason:
          "Test-only synthetic write used to verify the session budget refuses execution before dispatch.",
      },
      description: "test write",
      parameters: { type: "object" },
      execute,
    };
    const ports: FactoryPorts = {
      ontology: {
        listDomains: async () => [],
        fetchOntology: async () => ({
          domainId: "dom",
          actions: [],
          events: [],
          objects: [],
          rules: [],
          workflow: [],
          source: "snapshot",
        }),
        fetchActionRules: async () => [],
      },
      sandbox: {
        deployAndObserve: async () => { throw new Error("not used"); },
        teardown: async () => undefined,
      },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => [],
      },
      reflection: { list: async () => [], record: async () => undefined },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "execute a write",
      ports,
      tools: [tool],
      conversationId: "session-budget-test",
    })) {
      events.push(event);
    }

    expect(execute).not.toHaveBeenCalled();
    expect(seenTurns).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      t: "budget",
      tokens: 0,
      conversationTokens: 0,
      maxTokens: 500,
      stopReason: "provider_headroom:conversation",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      t: "done",
      status: "budget_exhausted",
      tokensUsed: 0,
      conversationTokensUsed: 0,
    }));
  });
});
