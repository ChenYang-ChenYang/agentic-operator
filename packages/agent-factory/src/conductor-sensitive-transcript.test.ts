import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

const scriptedTurns: Array<TurnEvent[] | Error> = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (_messages: ChatMsg[]) {
      const scripted = scriptedTurns.shift() ?? [
        { t: "done" as const, content: "done" },
      ];
      if (scripted instanceof Error) throw scripted;
      for (const event of scripted) yield event;
    },
  };
});

import { __sanitizeFactoryToolCallArgsForTest, runBrain } from "./conductor";
import type { BrainTool } from "./brain-types";
import type { FactoryPorts } from "./ports";

describe("conductor pre-persistence secret boundary", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/sensitive-transcript-model");
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("allows only a schema-valid records.upsert business-key binding and still rejects secrets", () => {
    const safe = {
      plan: [
        {
          stepId: "persist-audit",
          kind: "tool",
          tool: "records.upsert",
          toolArguments: {
            key: { const: "candidate-audit" },
          },
        },
        {
          stepId: "each",
          kind: "foreach",
          body: [
            {
              stepId: "persist-child",
              kind: "tool",
              tool: "records.upsert",
              toolArguments: {
                key: { from: "locals.candidate.candidate_id", required: true },
              },
            },
          ],
        },
      ],
    };
    expect(__sanitizeFactoryToolCallArgsForTest("design_agent", safe)).toEqual({
      sanitized: safe,
      paths: [],
    });

    expect(
      __sanitizeFactoryToolCallArgsForTest("design_agent", {
        plan: [
          {
            tool: "records.upsert",
            toolArguments: { key: { const: "sk-live12345678" } },
          },
        ],
      }).paths,
    ).toContain("design_agent.args.plan[0].toolArguments.key.const");
    expect(
      __sanitizeFactoryToolCallArgsForTest("design_agent", {
        plan: [
          {
            tool: "vendor.call",
            toolArguments: { key: { const: "ordinary-business-value" } },
          },
        ],
      }).paths,
    ).toContain("design_agent.args.plan[0].toolArguments.key");
    expect(
      __sanitizeFactoryToolCallArgsForTest("design_agent", {
        plan: [
          {
            tool: "records.upsert",
            toolArguments: {
              key: {
                from: "input.id",
                unexpected: "bypass",
              },
            },
          },
        ],
      }).paths,
    ).toContain("design_agent.args.plan[0].toolArguments.key");
    expect(
      __sanitizeFactoryToolCallArgsForTest("design_agent", {
        key: "this-is-a-real-secret-value",
      }).paths,
    ).toContain("design_agent.args.key");
  });

  it("rejects secret args before execute and sanitizes handler results before events/checkpoints", async () => {
    let snapshot:
      | { messages: unknown[]; ctx: Record<string, unknown> }
      | undefined;
    const inputExecute = vi.fn(async () => ({
      ok: true,
      summary: "must not run",
    }));
    const configurationFields = [
      {
        key: "api_key_env",
        type: "string",
        required: true,
        description: "Server environment variable name only.",
      },
    ];
    const outputExecute = vi.fn(
      async (
        _args: Record<string, unknown>,
        ctx: Parameters<BrainTool["execute"]>[1],
      ) => {
        ctx.emit({
          t: "reflect",
          kind: "probe",
          lesson: "Bearer event-secret",
        });
        return {
          ok: false,
          summary: "vendor failed: Bearer response-secret",
          output: {
            token: "response-secret",
            nested: { note: "password=also-secret" },
            // Real readiness output exposes the same immutable schema in its
            // detailed report and compact receipt. Repeated references are not
            // cycles and both copies must survive sanitization.
            configurationFields,
            compact: {
              configuration: { fields: configurationFields },
            },
          },
        };
      },
    );
    const tools: BrainTool[] = [
      {
        name: "unsafe_input",
        effect: {
          sideEffect: "read",
          scope: "none",
          checkpoint: "turn",
          gate: "any",
        },
        description: "test",
        parameters: { type: "object" },
        execute: inputExecute,
      },
      {
        name: "unsafe_output",
        effect: {
          sideEffect: "write",
          scope: "conversation",
          checkpoint: "turn",
          gate: "any",
        },
        description: "test",
        parameters: { type: "object" },
        execute: outputExecute,
      },
    ];
    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [
            {
              id: "secret-in",
              name: "unsafe_input",
              args: JSON.stringify({
                payload: { note: "Bearer request-secret" },
              }),
            },
            {
              id: "secret-out",
              name: "unsafe_output",
              args: JSON.stringify({ id: "safe" }),
            },
          ],
        },
      ],
      [{ t: "done", content: "done" }],
    );
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
        deployAndObserve: async () => {
          throw new Error("not used");
        },
        teardown: async () => undefined,
      },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, value) => {
          snapshot = structuredClone(value);
        },
        drainHumanMessages: async () => [],
      },
      reflection: { list: async () => [], record: async () => undefined },
    };
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "security test",
      ports,
      tools,
      conversationId: "conv-secret",
    })) {
      events.push(event);
    }

    expect(inputExecute).not.toHaveBeenCalled();
    expect(outputExecute).toHaveBeenCalledOnce();
    const persisted = JSON.stringify(snapshot);
    const emitted = JSON.stringify(events);
    for (const secret of [
      "request-secret",
      "response-secret",
      "also-secret",
      "event-secret",
    ]) {
      expect(persisted).not.toContain(secret);
      expect(emitted).not.toContain(secret);
    }
    expect(persisted).toContain("[REDACTED]");
    expect(emitted).toContain("[REDACTED]");
    expect(persisted).toContain("api_key_env");
    expect(emitted).toContain("api_key_env");
    expect(emitted.match(/api_key_env/g)).toHaveLength(2);
  });

  it("sanitizes a top-level model stream error before SSE output", async () => {
    scriptedTurns.push(new Error("gateway failed password=stream-secret"));
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
        deployAndObserve: async () => {
          throw new Error("not used");
        },
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
      goal: "security test",
      ports,
      tools: [],
      conversationId: "conv-stream-error",
    })) {
      events.push(event);
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("stream-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(events).toContainEqual(
      expect.objectContaining({ t: "error", retryable: false }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ t: "done", status: "errored" }),
    );
  });

  it("marks a transient top-level model stream error as retryable", async () => {
    scriptedTurns.push(
      new Error("custom error: Request timed out."),
      new Error("custom error: Request timed out."),
    );
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
        deployAndObserve: async () => {
          throw new Error("not used");
        },
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
      goal: "retry test",
      ports,
      tools: [],
      conversationId: "conv-transient-stream-error",
    })) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({ t: "error", retryable: true }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ t: "done", status: "errored" }),
    );
  });

  it("sanitizes checkpoint, teardown and reflection failures before SSE output", async () => {
    const execute = vi.fn(
      async (
        _args: Record<string, unknown>,
        ctx: Parameters<BrainTool["execute"]>[1],
      ) => {
        ctx.spent.sandboxRuns = 1;
        return { ok: true, summary: "sandbox marked" };
      },
    );
    scriptedTurns.push([
      {
        t: "tool_calls",
        content: "",
        calls: [{ id: "mark-sandbox", name: "mark_sandbox", args: "{}" }],
      },
    ]);
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
        deployAndObserve: async () => {
          throw new Error("not used");
        },
        teardown: async () => {
          throw new Error("token=teardown-secret");
        },
      },
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => {
          throw new Error("authorization=checkpoint-secret");
        },
        drainHumanMessages: async () => [],
      },
      reflection: {
        list: async () => [],
        record: async () => {
          throw new Error("password=reflection-secret");
        },
      },
    };
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "security test",
      ports,
      tools: [
        {
          name: "mark_sandbox",
          effect: {
            sideEffect: "write",
            scope: "conversation",
            checkpoint: "turn",
            gate: "any",
          },
          description: "test",
          parameters: { type: "object" },
          execute,
        },
      ],
      conversationId: "conv-cleanup-errors",
    })) {
      events.push(event);
    }
    const serialized = JSON.stringify(events);
    for (const secret of [
      "checkpoint-secret",
      "teardown-secret",
      "reflection-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(events).toContainEqual(
      expect.objectContaining({ t: "done", status: "errored" }),
    );
  });
});
