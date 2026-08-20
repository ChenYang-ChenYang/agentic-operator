import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

const scriptedTurns: TurnEvent[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (_messages: ChatMsg[]) {
      for (const event of scriptedTurns.shift() ?? [{ t: "done" as const, content: "continued" }]) {
        yield event;
      }
    },
  };
});

import { runBrain } from "./conductor";
import type { BrainTool } from "./brain-types";
import type { FactoryPorts } from "./ports";

const ontology = {
  listDomains: async () => [],
  fetchOntology: async () => ({
    domainId: "dom",
    actions: [],
    events: [],
    objects: [],
    rules: [],
    workflow: [],
    source: "snapshot" as const,
  }),
  fetchActionRules: async () => [],
};

const baseCtx = (extra: Record<string, unknown> = {}) => ({
  domain: "dom",
  goal: "original goal",
  specs: [],
  ontology: null,
  budget: { maxTokens: null, maxTurns: 20 },
  spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
  currentPlan: null,
  toolCatalog: [],
  attemptHistory: {},
  humanDirectives: [],
  priorReflections: [],
  createdSkills: [],
  research: [],
  ...extra,
});

function ports(overrides: Partial<FactoryPorts["conversation"]> = {}): FactoryPorts {
  return {
    ontology,
    sandbox: {
      deployAndObserve: async () => { throw new Error("not used"); },
      teardown: async () => undefined,
    },
    reflection: { list: async () => [], record: async () => undefined },
    conversation: {
      has: async () => false,
      load: async () => null,
      save: async () => undefined,
      drainHumanMessages: async () => [],
      ...overrides,
    },
  };
}

describe("Factory HITL state machine", () => {
  beforeEach(() => {
    scriptedTurns.splice(0);
    vi.stubEnv("FACTORY_AI_MODEL", "test/hitl-state-machine");
    vi.stubEnv("FACTORY_PARK_MAX_TICKS", "10");
    vi.stubEnv("FACTORY_PARK_POLL_MS", "10");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("ends a timed-out gate as waiting_human and preserves the exact checkpoint", async () => {
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    const openClarify: BrainTool = {
      name: "open_clarify",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test gate",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.awaitingClarify = true;
        ctx.clarifyPrompt = { question: "请选择真实集成", context: "需要人工确认" };
        ctx.emit({ t: "clarify", question: ctx.clarifyPrompt.question, context: ctx.clarifyPrompt.context, awaitingAnswer: true });
        return { ok: true, summary: "waiting" };
      },
    };
    scriptedTurns.push([{ t: "tool_calls", content: "", calls: [{ id: "gate", name: openClarify.name, args: "{}" }] }]);

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "build",
      tools: [openClarify],
      conversationId: "wait-timeout",
      ports: ports({ save: async (_id, value) => { snapshot = structuredClone(value); } }),
    })) {
      if (event.t === "clarify" && event.awaitingAnswer) {
        expect(event.interactionId).toMatch(/^hitl_/);
        expect(snapshot?.ctx).toMatchObject({
          humanInteractions: { clarify: { interactionId: event.interactionId } },
        });
      }
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      t: "done",
      status: "waiting_human",
      completionKind: "incomplete",
    });
    expect(events.at(-1)).not.toMatchObject({ completionKind: "answer" });
    expect(snapshot?.ctx).toMatchObject({
      awaitingClarify: true,
      clarifyPrompt: { question: "请选择真实集成", context: "需要人工确认" },
    });
  });

  it("uses clarify > approval > boundary when several restored flags coexist", async () => {
    const openAll: BrainTool = {
      name: "open_all_gates",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test gate priority",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.awaitingClarify = true;
        ctx.clarifyPrompt = { question: "先确认集成" };
        ctx.awaitingApproval = true;
        ctx.testCases = [{ id: "tc-1", name: "case", scenario: "case", kind: "pass", entryEvent: "START", payload: {}, expectedOutcome: "PASS" }];
        ctx.awaitingBoundary = true;
        ctx.boundaryProposals = [{ event: "HANDOFF", suggestedKind: "external", why: "external", producers: ["a"] }];
        ctx.emit({ t: "clarify", question: "先确认集成", awaitingAnswer: true });
        ctx.emit({ t: "test.cases", cases: ctx.testCases, awaitingApproval: true });
        ctx.emit({ t: "boundary.cases", proposals: ctx.boundaryProposals, awaitingDecision: true });
        return { ok: true, summary: "all gates opened" };
      },
    };
    scriptedTurns.push(
      [{ t: "tool_calls", content: "", calls: [{ id: "all", name: openAll.name, args: "{}" }] }],
      [{ t: "done", content: "all decisions consumed" }],
    );
    let reads = 0;
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "test priority",
      tools: [openAll],
      conversationId: "gate-priority",
      ports: ports({
        drainHumanMessages: async () => {
          reads += 1;
          if (reads === 2) return [{ text: "[澄清回答] 使用 A", actor: "usr" }];
          if (reads === 3) return [{ text: "[测试用例决策：执行]", actor: "usr" }];
          if (reads === 4) return [{ text: "[边界事件决策] [{\"event\":\"HANDOFF\",\"kind\":\"external\"}]", actor: "usr" }];
          return [];
        },
      }),
    })) events.push(event);

    const clearedClarify = events.findIndex((event) => event.t === "clarify" && event.awaitingAnswer === false);
    const approved = events.findIndex((event) => event.t === "test.decision" && event.decision === "approve");
    const boundary = events.findIndex((event) => event.t === "boundary.decided");
    expect(clearedClarify).toBeGreaterThanOrEqual(0);
    expect(approved).toBeGreaterThan(clearedClarify);
    expect(boundary).toBeGreaterThan(approved);
  });

  it("keeps approval and boundary gates on a typed crash resume and consumes their mailbox decisions", async () => {
    scriptedTurns.push([{ t: "done", content: "recovered" }]);
    let reads = 0;
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "ordinary text that carries no magic resume prefix",
      continuationMode: "crash_resume",
      conversationId: "typed-recovery",
      ports: ports({
        has: async () => true,
        load: async () => ({
          messages: [{ role: "system", content: "old" }, { role: "user", content: "original" }],
          ctx: baseCtx({
            awaitingApproval: true,
            testCases: [{ id: "tc-1", name: "case", scenario: "case", kind: "pass", entryEvent: "START", payload: {}, expectedOutcome: "PASS" }],
            awaitingBoundary: true,
            boundaryProposals: [{ event: "HANDOFF", suggestedKind: "external", why: "external", producers: ["a"] }],
          }),
        }),
        drainHumanMessages: async () => {
          reads += 1;
          if (reads === 1) return [{ text: "[测试用例决策：执行]", actor: "usr" }];
          if (reads === 2) return [{ text: "[边界事件决策] [{\"event\":\"HANDOFF\",\"kind\":\"external\"}]", actor: "usr" }];
          return [];
        },
      }),
    })) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({ t: "test.decision", decision: "approve" }));
    expect(events).toContainEqual(expect.objectContaining({ t: "boundary.decided" }));
    expect(events).not.toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("已取消等待") }));
  });

  it("does not let ordinary continuation text bypass an addressed saved gate", async () => {
    const interactionId = "hitl_55555555-5555-4555-8555-555555555555";
    let snapshot: { ctx: Record<string, unknown> } | undefined;
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "[澄清回答] 这是一条没有交互编号的迟到回复",
      conversationId: "ordinary-cannot-answer",
      ports: ports({
        has: async () => true,
        load: async () => ({
          messages: [{ role: "system", content: "old" }],
          ctx: baseCtx({
            awaitingClarify: true,
            clarifyPrompt: { question: "当前问题" },
            humanInteractions: {
              clarify: { interactionId, kind: "clarify", subjectDigest: "f".repeat(64), createdAt: Date.now() },
            },
          }),
        }),
        save: async (_id, value) => { snapshot = structuredClone(value); },
      }),
    })) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({ t: "message", text: expect.stringContaining("没有当前交互卡编号") }));
    expect(events).not.toContainEqual(expect.objectContaining({ t: "clarify", awaitingAnswer: false }));
    expect(events.at(-1)).toMatchObject({ t: "done", status: "waiting_human" });
    expect(snapshot?.ctx).toMatchObject({
      awaitingClarify: true,
      humanInteractions: { clarify: { interactionId } },
    });
  });
});
