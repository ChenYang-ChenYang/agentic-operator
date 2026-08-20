import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

// Deterministic streamTurn: each call records the messages it saw and yields the next scripted turn.
const seenTurns: ChatMsg[][] = [];
const scriptedTurns: TurnEvent[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [
        { t: "done" as const, content: "done" },
      ];
      for (const event of events) yield event;
    },
  };
});

import { runBrain } from "./conductor";
import type { BrainTool } from "./brain-types";
import type { FactoryPorts } from "./ports";

const baseOntologyPort = {
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
const baseSandboxPort = {
  deployAndObserve: async () => {
    throw new Error("not used");
  },
  teardown: async () => undefined,
};
const baseReflectionPort = {
  list: async () => [],
  record: async () => undefined,
};

describe("#ASK-PARK v2 — a plain-text trailing question parks the run instead of ending it", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/park-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("auto-parks on a trailing question (no tool call), waits for the user, then resumes on the answer", async () => {
    // Turn 1: the brain ends with a plain-text open question and NO tool call → must PARK, not end.
    // Turn 2: after the user answers at the clarify gate, the run resumes and finishes normally.
    scriptedTurns.push(
      [{ t: "done", content: "两个集成里你希望用哪个？A 还是 B？" }],
      [{ t: "done", content: "好的，按 A 继续。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        // Answer only becomes available AFTER the first model turn produced the question, so the
        // pre-question mailbox reads see nothing and the answer is consumed by the clarify gate.
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "用 A", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "帮我选集成",
      ports,
      conversationId: "park-conv",
    })) {
      events.push(event);
    }

    // The run PARKED: a clarify(awaitingAnswer:true) frame was synthesized from the trailing question…
    const parkFrame = events.find(
      (e): e is Extract<typeof e, { t: "clarify" }> =>
        e.t === "clarify" && e.awaitingAnswer === true,
    );
    expect(parkFrame).toBeTruthy();
    expect(String(parkFrame?.question)).toContain("A 还是 B？");
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "message",
        text: expect.stringContaining("运行已挂起"),
      }),
    );
    // …and it RESUMED: a clearing clarify(awaitingAnswer:false) frame + the answer threaded into turn 2's prompt.
    expect(events).toContainEqual(
      expect.objectContaining({ t: "clarify", awaitingAnswer: false }),
    );
    expect(seenTurns).toHaveLength(2);
    expect(
      seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n"),
    ).toContain("[用户澄清回答]");
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  // #ASK-PROPOSAL 回归 — 真实事故：大脑把选项写在【正文散文】里（"路线A：只生成 createJD／
  // 路线B：补齐全部6个"），末句只留"你想选哪条？"。自动挂起只截尾句当 question、options 恒为
  // undefined，于是用户答「A」时回注给模型的只有「问题原文 + 字母A」——A 指什么在上下文里
  // 无从解析，大脑只好自己编（实际编成了"继续只做分析"）。修复：挂起时快照提案原文，回答
  // 回来时与答案一起还给模型。断言的是【解析 A 所需的原文在场】，不是断言模型怎么解释它。
  it("carries the proposal prose (where the options actually live) into the answer frame", async () => {
    const proposal = [
      "根据本体，当前只有 createJD 能生成。",
      "路线 A：直接生成 createJD 的完整代码（已有设计稿）。",
      "路线 B：补齐其他 5 个 agent 的工具契约，然后并行生成全部 6 个。",
      "你想选哪条？",
    ].join("\n");
    scriptedTurns.push(
      [{ t: "done", content: proposal }],
      [{ t: "done", content: "开始生成 createJD。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "[澄清回答] A", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    for await (const _event of runBrain({
      domain: "dom",
      goal: "你能生成哪个agent?",
      ports,
      conversationId: "proposal-conv",
    })) {
      /* drain */
    }

    expect(seenTurns).toHaveLength(2);
    const turn2 = seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n");
    expect(turn2).toContain("[用户澄清回答]");
    expect(turn2).toContain("用户回答：A");
    // 关键：解析「A」所需的原文必须在场——否则 A 只是个无意义的字母。
    expect(turn2).toContain("你提问时给用户的原话");
    expect(turn2).toContain("路线 A：直接生成 createJD 的完整代码");
    expect(turn2).toContain("路线 B：补齐其他 5 个 agent");
    // 并且明确告诉模型：按你自己提过的选项理解它，别另编一个。
    expect(turn2).toContain("别给它另编一个解释");
  });

  it("extracts a punctuation-free trailing request instead of using the long report as the question", async () => {
    const report = `检查报告开头：${"这是一条已经完成的只读检查记录。".repeat(90)}`;
    scriptedTurns.push(
      [{ t: "done", content: `${report}\n\n请确认选择 A 还是 B。` }],
      [{ t: "done", content: "收到，继续执行。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "选择 A", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "检查配置",
      ports,
      conversationId: "tail-request-conv",
    })) {
      events.push(event);
    }

    const parkFrame = events.find(
      (event): event is Extract<typeof event, { t: "clarify" }> =>
        event.t === "clarify" && event.awaitingAnswer === true,
    );
    expect(parkFrame?.question).toBe("请确认选择 A 还是 B。");
    expect(parkFrame?.question).not.toContain("检查报告开头");
    expect(events).toContainEqual(
      expect.objectContaining({ t: "clarify", awaitingAnswer: false }),
    );
    expect(seenTurns).toHaveLength(2);
  });

  it("does not park when request-like words only appear inside report prose", async () => {
    scriptedTurns.push([
      {
        t: "done",
        content:
          "检查完成。字段文案中包含“请选择一个平台”，这是对现状的引用。所有只读检查均已结束。",
      },
    ]);
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => [],
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "只读检查",
      ports,
      conversationId: "report-only-conv",
    })) {
      events.push(event);
    }

    expect(
      events.some(
        (event) => event.t === "clarify" && event.awaitingAnswer === true,
      ),
    ).toBe(false);
    expect(seenTurns).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });
});

describe("#ASK-PARK-MUTEX — ask_user cannot ship in the same assistant turn", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/park-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("parks a structured ask raised on the final model turn", async () => {
    const question = "processResume 应该使用哪个真实执行面？";
    const askTool: BrainTool = {
      name: "ask_user",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test last-turn ask_user",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.clarifyPrompt = {
          question,
          context: "缺少权威工具绑定，不能猜测接口。",
          options: [
            {
              label: "确认人工边界",
              value: "confirm_manual_boundary",
              recommended: true,
            },
          ],
        };
        ctx.awaitingClarify = true;
        ctx.emit({
          t: "clarify",
          question,
          context: ctx.clarifyPrompt.context,
          options: ctx.clarifyPrompt.options,
          awaitingAnswer: true,
        });
        return { ok: true, summary: "parked on an exact human gate" };
      },
    };
    scriptedTurns.push([
      {
        t: "tool_calls",
        content: "",
        calls: [{ id: "ask-final", name: "ask_user", args: "{}" }],
      },
    ]);
    let saved:
      | {
          ctx: Record<string, unknown>;
        }
      | undefined;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, value) => {
          saved = structuredClone(value) as { ctx: Record<string, unknown> };
        },
        drainHumanMessages: async () => [],
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "生成 processResume",
      ports,
      tools: [askTool],
      conversationId: "last-turn-structured-ask",
      executionBudget: { maxTurns: 1 },
    })) {
      events.push(event);
    }

    expect(seenTurns).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "clarify",
        question,
        awaitingAnswer: true,
        options: [
          {
            label: "确认人工边界",
            value: "confirm_manual_boundary",
            recommended: true,
          },
        ],
      }),
    );
    expect(saved?.ctx).toMatchObject({
      awaitingClarify: true,
      clarifyPrompt: {
        question,
        context: "缺少权威工具绑定，不能猜测接口。",
      },
    });
    expect(events.at(-1)).toMatchObject({
      t: "done",
      status: "waiting_human",
      completionKind: "incomplete",
      turns: 1,
    });
  });

  it("refuses a finish batched with ask_user (in EITHER ordering) and parks on the question", async () => {
    const finishRan = vi.fn();
    const askTool: BrainTool = {
      name: "ask_user",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test ask_user",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.clarifyPrompt = { question: "要继续吗？" };
        ctx.awaitingClarify = true;
        ctx.emit({
          t: "clarify",
          question: "要继续吗？",
          awaitingAnswer: true,
        });
        return { ok: true, summary: "parked" };
      },
    };
    const finishTool: BrainTool = {
      name: "finish",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "deliver",
        advancesStage: true,
      },
      description: "test finish",
      parameters: { type: "object", properties: {} },
      async execute() {
        finishRan();
        return { ok: true, summary: "shipped" };
      },
    };
    // Hardest ordering: finish FIRST in the batch — the mutex must still refuse it before it executes.
    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [
            { id: "f", name: "finish", args: "{}" },
            { id: "a", name: "ask_user", args: "{}" },
          ],
        },
      ],
      [{ t: "done", content: "已按回答继续。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "继续", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "开始",
      ports,
      tools: [askTool, finishTool],
      conversationId: "mutex-conv",
    })) {
      events.push(event);
    }

    // finish was REFUSED by the mutex (never executed) and surfaced a structured steer…
    expect(finishRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "finish",
        ok: false,
        summary: expect.stringContaining("暂不执行 finish"),
      }),
    );
    // …while ask_user parked the run, which then resumed on the answer (2nd model turn ran).
    expect(events).toContainEqual(
      expect.objectContaining({ t: "clarify", awaitingAnswer: true }),
    );
    expect(seenTurns).toHaveLength(2);
    expect(
      seenTurns[1]!.map((m) => String(m.content ?? "")).join("\n"),
    ).toContain("[用户澄清回答]");
  });

  it("turns a typed next=ask_user tool result into a real park and stops later batch tools", async () => {
    const laterRan = vi.fn();
    const blocker: BrainTool = {
      name: "inspect_config",
      effect: {
        sideEffect: "read",
        scope: "none",
        checkpoint: "turn",
        gate: "any",
      },
      description: "discovers a configuration blocker",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          ok: false,
          summary: "测试环境还没配好。",
          output: {
            next: "ask_user",
            reason: "sandbox_config_missing",
            question: "请先配置独立的 Inngest 测试环境，完成后告诉我可以继续。",
            context: "沙箱只允许使用与生产隔离的 broker 和凭据。",
            options: [
              { label: "已配置，可以继续", value: "SANDBOX_CONFIGURED" },
              { label: "暂不继续", value: "STOP" },
            ],
            missing: ["sandbox broker", "sandbox credentials"],
          },
        };
      },
    };
    const later: BrainTool = {
      name: "design_after_blocker",
      effect: {
        sideEffect: "read",
        scope: "none",
        checkpoint: "turn",
        gate: "any",
      },
      description: "must not run while clarification is pending",
      parameters: { type: "object", properties: {} },
      async execute() {
        laterRan();
        return { ok: true, summary: "ran" };
      },
    };
    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [
            { id: "b", name: "inspect_config", args: "{}" },
            { id: "l", name: "design_after_blocker", args: "{}" },
          ],
        },
      ],
      [{ t: "done", content: "已收到配置确认。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "独立测试环境已配置", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "检查并继续",
      ports,
      tools: [blocker, later],
      conversationId: "structured-ask-conv",
    }))
      events.push(event);

    expect(laterRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "clarify",
        question: expect.stringContaining("独立的 Inngest 测试环境"),
        options: expect.arrayContaining([
          expect.objectContaining({
            label: "已配置，可以继续",
            value: "SANDBOX_CONFIGURED",
          }),
        ]),
        context: expect.stringContaining("与生产隔离"),
        awaitingAnswer: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "design_after_blocker",
        ok: false,
        summary: expect.stringContaining("运行已挂起"),
      }),
    );
    expect(seenTurns).toHaveLength(2);
    expect(
      seenTurns[1]!.map((message) => String(message.content ?? "")).join("\n"),
    ).toContain("独立测试环境已配置");
  });

  it("replays an answered structured blocker instead of resetting it to pending", async () => {
    const blocker: BrainTool = {
      name: "inspect_repeat_blocker",
      effect: {
        sideEffect: "read",
        scope: "none",
        checkpoint: "turn",
        gate: "any",
      },
      description: "returns the same typed blocker twice",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          ok: false,
          summary: "还需要选择连接方式。",
          output: {
            next: "ask_user",
            question: "请选择连接方式 A 或 B。",
            options: [
              { label: "方式 A", value: "A" },
              { label: "方式 B", value: "B" },
            ],
          },
        };
      },
    };
    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "b1", name: blocker.name, args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "b2", name: blocker.name, args: "{}" }],
        },
      ],
      [{ t: "done", content: "已按 A 继续。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: "A", actor: "usr-human" }];
          }
          return [];
        },
      },
    };
    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "检查连接",
      ports,
      tools: [blocker],
      conversationId: "structured-repeat-conv",
    }))
      events.push(event);

    expect(
      events.filter((event) => event.t === "clarify" && event.awaitingAnswer),
    ).toHaveLength(1);
    const second = events.find(
      (event) => event.t === "tool.result" && event.id === "b2",
    );
    expect(second).toMatchObject({
      summary: expect.stringContaining("此前已经由用户回答：A"),
    });
    expect(seenTurns).toHaveLength(3);
  });

  it("requires sandbox_run to be the only tool in its assistant turn", async () => {
    const sandboxRan = vi.fn();
    const sandboxTool: BrainTool = {
      name: "sandbox_run",
      effect: {
        sideEffect: "call",
        scope: "sandbox",
        checkpoint: "immediate",
        gate: "sandbox",
        advancesStage: true,
      },
      description: "side effect",
      parameters: { type: "object", properties: {} },
      async execute() {
        sandboxRan();
        return { ok: true, summary: "deployed" };
      },
    };
    const inspectTool: BrainTool = {
      name: "inspect",
      effect: {
        sideEffect: "read",
        scope: "none",
        checkpoint: "turn",
        gate: "any",
      },
      description: "read only",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, summary: "inspected" };
      },
    };
    scriptedTurns.push([
      {
        t: "tool_calls",
        content: "",
        calls: [
          { id: "s", name: "sandbox_run", args: "{}" },
          { id: "i", name: "inspect", args: "{}" },
        ],
      },
    ]);
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => [],
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "测试",
      ports,
      tools: [sandboxTool, inspectTool],
    })) {
      events.push(event);
    }

    expect(sandboxRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "sandbox_run",
        ok: false,
        summary: expect.stringContaining(
          "必须在没有其它并行工具调用的一轮里单独执行",
        ),
      }),
    );
  });
});

describe("test fixture clarification safety", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/fixture-safety-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("never turns key:value clarification text into a fixture and redacts an accidentally pasted secret", async () => {
    const secret = "sk-accidentally-pasted-secret";
    const snapshots: Array<{
      ctx: Record<string, unknown>;
      messages: unknown[];
    }> = [];
    const askForFixture: BrainTool = {
      name: "request_fixture_data",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only fixture clarification",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.testCases = [
          {
            id: "tc1",
            name: "case",
            scenario: "safe",
            kind: "pass",
            entryEvent: "START",
            payload: { candidate_email: "sandbox@example.invalid" },
            expectedOutcome: "done",
          },
        ];
        ctx.clarifyPrompt = {
          question: "请提供 sandbox 测试字段；不要粘贴凭证。",
          context:
            "补全 sandbox 安全测试数据；回答后必须显式调用 supply_test_data 并重新审批，禁止直接写入",
        };
        ctx.awaitingClarify = true;
        ctx.emit({
          t: "clarify",
          question: ctx.clarifyPrompt.question,
          context: ctx.clarifyPrompt.context,
          awaitingAnswer: true,
        });
        return { ok: true, summary: "waiting" };
      },
    };
    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "fixture", name: askForFixture.name, args: "{}" }],
        },
      ],
      [{ t: "done", content: "已停止收集凭证。" }],
    );
    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => {
          snapshots.push(structuredClone(snapshot));
        },
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [{ text: `api_key: ${secret}`, actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "准备安全测试数据",
      ports,
      tools: [askForFixture],
      conversationId: "fixture-secret-conv",
    }))
      events.push(event);

    const serialized = JSON.stringify({ seenTurns, snapshots, events });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "message",
        text: expect.stringContaining("integration profile"),
      }),
    );
    expect(snapshots.at(-1)?.ctx.testDataOverrides).toBeUndefined();
    expect(
      (
        snapshots.at(-1)?.ctx.testCases as Array<{
          payload: Record<string, unknown>;
        }>
      )[0]!.payload,
    ).toEqual({ candidate_email: "sandbox@example.invalid" });
    expect(
      seenTurns[1]!.map((message) => String(message.content ?? "")).join("\n"),
    ).toContain("未写入 fixture");
  });
});

describe("test approval third state — supply_data", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/supply-data-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps approval closed, rejects sandbox, applies data atomically, then asks for approval again", async () => {
    const sandboxRan = vi.fn();
    const snapshots: Array<{ ctx: Record<string, unknown> }> = [];
    const propose: BrainTool = {
      name: "propose_cases",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only case proposal",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.testCases = [
          {
            id: "case-1",
            name: "resume fixture",
            scenario: "parse a supplied resume",
            kind: "pass",
            entryEvent: "RESUME_RECEIVED",
            payload: { resume: { text: "placeholder" } },
            expectedOutcome: "RESUME_PARSED",
          },
        ];
        ctx.awaitingApproval = true;
        ctx.testDataSupplementPending = false;
        ctx.emit({
          t: "test.cases",
          cases: ctx.testCases,
          awaitingApproval: true,
        });
        return { ok: true, summary: "cases proposed" };
      },
    };
    const sandbox: BrainTool = {
      name: "sandbox_run",
      effect: {
        sideEffect: "call",
        scope: "sandbox",
        checkpoint: "immediate",
        gate: "sandbox",
        advancesStage: true,
      },
      description: "must remain blocked while data is being supplied",
      parameters: { type: "object", properties: {} },
      async execute() {
        sandboxRan();
        return { ok: true, summary: "sandbox ran" };
      },
    };
    const supplyData: BrainTool = {
      name: "supply_test_data",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only atomic fixture update",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        expect(ctx.testDataSupplementPending).toBe(true);
        const current = structuredClone(ctx.testCases ?? []);
        current[0]!.payload = { resume: { text: "sanitized sandbox resume" } };
        ctx.testCases = current;
        ctx.testDataSupplementPending = false;
        ctx.awaitingApproval = true;
        ctx.lastSandbox = null;
        ctx.sandboxDesignReview = undefined;
        ctx.emit({ t: "test.cases", cases: current, awaitingApproval: true });
        return { ok: true, summary: "fixture updated; approval required" };
      },
    };

    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "p", name: "propose_cases", args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "blocked", name: "sandbox_run", args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "supply", name: "supply_test_data", args: "{}" }],
        },
      ],
      [{ t: "done", content: "测试数据已重新确认。" }],
    );

    let suppliedDecision = false;
    let approvedDecision = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => {
          snapshots.push(
            structuredClone(snapshot) as { ctx: Record<string, unknown> },
          );
        },
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !suppliedDecision) {
            suppliedDecision = true;
            return [{ text: "[测试用例决策: 补数据]", actor: "usr-human" }];
          }
          if (seenTurns.length >= 3 && !approvedDecision) {
            approvedDecision = true;
            return [{ text: "[测试用例决策: 执行]", actor: "usr-human" }];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "补齐测试数据后执行",
      ports,
      tools: [propose, sandbox, supplyData],
      conversationId: "supply-data-third-state",
    }))
      events.push(event);

    expect(sandboxRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "test.decision",
        decision: "supply_data",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "sandbox_run",
        ok: false,
        summary: expect.stringContaining("当前正在补测试数据"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "test.cases",
        awaitingApproval: true,
        cases: [
          expect.objectContaining({
            payload: { resume: { text: "sanitized sandbox resume" } },
          }),
        ],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "test.decision",
        decision: "approve",
      }),
    );
    expect(seenTurns).toHaveLength(4);
    const lastCtx = snapshots.at(-1)?.ctx;
    expect(lastCtx?.testDataSupplementPending).toBe(false);
    expect(lastCtx?.awaitingApproval).toBe(false);
  });
});

describe("test approval draft-only exit", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/save-draft-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("saves an unverified draft without starting sandbox or finish", async () => {
    const sandboxRan = vi.fn();
    const draftSaved = vi.fn();
    const propose: BrainTool = {
      name: "propose_cases",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only case proposal",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.testCases = [
          {
            id: "case-1",
            name: "draft-only case",
            scenario: "review without execution",
            kind: "pass",
            entryEvent: "START",
            payload: { id: "sandbox-id" },
            expectedOutcome: "DONE",
          },
        ];
        ctx.awaitingApproval = true;
        ctx.emit({
          t: "test.cases",
          cases: ctx.testCases,
          awaitingApproval: true,
        });
        return { ok: true, summary: "cases proposed" };
      },
    };
    const sandbox: BrainTool = {
      name: "sandbox_run",
      effect: {
        sideEffect: "call",
        scope: "sandbox",
        checkpoint: "immediate",
        gate: "sandbox",
        advancesStage: true,
      },
      description: "must not run for a draft-only decision",
      parameters: { type: "object", properties: {} },
      async execute() {
        sandboxRan();
        return { ok: true, summary: "sandbox ran" };
      },
    };
    const saveDraft: BrainTool = {
      name: "save_draft",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "any",
      },
      description: "persist generated_unverified draft",
      parameters: { type: "object", properties: {} },
      async execute() {
        draftSaved();
        return {
          ok: true,
          summary: "saved generated_unverified draft",
          output: { readiness: "generated_unverified" },
        };
      },
    };

    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "propose", name: "propose_cases", args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "draft", name: "save_draft", args: "{}" }],
        },
      ],
    );

    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async () => undefined,
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [
              {
                text: "[测试用例决策: 保存设计稿]",
                actor: "usr-human",
              },
            ];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "只保存设计稿，不执行沙箱",
      ports,
      tools: [propose, sandbox, saveDraft],
      conversationId: "save-draft-test-decision",
    }))
      events.push(event);

    expect(draftSaved).toHaveBeenCalledOnce();
    expect(sandboxRan).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "test.decision",
        decision: "save_draft",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "message",
        text: expect.stringContaining("沙箱、交付与晋升继续保持关闭"),
      }),
    );
    expect(
      seenTurns[1]!.map((message) => String(message.content ?? "")).join("\n"),
    ).toContain("禁止调用 sandbox_run/finish");
  });

  it("allows save_draft to abandon an in-progress test-data supplement", async () => {
    const snapshots: Array<{ ctx: Record<string, unknown> }> = [];
    const draftSaved = vi.fn();
    const propose: BrainTool = {
      name: "propose_cases",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only case proposal",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.testCases = [
          {
            id: "case-1",
            name: "supplement case",
            scenario: "needs optional data",
            kind: "pass",
            entryEvent: "START",
            payload: { id: "sandbox-id" },
            expectedOutcome: "DONE",
          },
        ];
        ctx.awaitingApproval = true;
        ctx.emit({
          t: "test.cases",
          cases: ctx.testCases,
          awaitingApproval: true,
        });
        return { ok: true, summary: "cases proposed" };
      },
    };
    const saveDraft: BrainTool = {
      name: "save_draft",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "any",
      },
      description: "persist generated_unverified draft",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        expect(ctx.testDataSupplementPending).toBe(true);
        draftSaved();
        return { ok: true, summary: "saved generated_unverified draft" };
      },
    };

    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "propose", name: "propose_cases", args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "draft", name: "save_draft", args: "{}" }],
        },
      ],
    );

    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => {
          snapshots.push(
            structuredClone(snapshot) as {
              ctx: Record<string, unknown>;
            },
          );
        },
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [
              {
                text: "[测试用例决策: 补数据]",
                actor: "usr-human",
              },
            ];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "补数据前改为只保存设计稿",
      ports,
      tools: [propose, saveDraft],
      conversationId: "save-draft-from-supplement",
    }))
      events.push(event);

    expect(draftSaved).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "test.decision",
        decision: "supply_data",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "save_draft",
        ok: false,
      }),
    );
    expect(snapshots.at(-1)?.ctx.testDataSupplementPending).toBe(false);
    expect(snapshots.at(-1)?.ctx.awaitingApproval).toBe(false);
  });

  it("atomically exits a fixture clarification when the user explicitly requests draft-only", async () => {
    const snapshots: Array<{
      domain: string;
      messages: ChatMsg[];
      ctx: Record<string, unknown>;
    }> = [];
    const supplyAttempted = vi.fn();
    const sandboxAttempted = vi.fn();
    const finishAttempted = vi.fn();
    const draftSaved = vi.fn();
    const requestFixture: BrainTool = {
      name: "request_fixture_data",
      effect: {
        sideEffect: "write",
        scope: "conversation",
        checkpoint: "turn",
        gate: "any",
      },
      description: "test-only fixture clarification",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        // Reproduce the live resumed conversation exactly: authoring already
        // spent past the cumulative 20-call control-plane cap. The recovery
        // must not reset this counter merely because a human answered.
        ctx.spent.toolCalls = 36;
        ctx.budget.maxToolCalls = 20;
        ctx.testCases = [
          {
            id: "case-credential",
            name: "credential-shaped business field",
            scenario: "business field is not an integration secret",
            kind: "pass",
            entryEvent: "START",
            payload: { compliance_credential: "business-attribute" },
            expectedOutcome: "DONE",
          },
        ];
        ctx.awaitingApproval = true;
        ctx.testDataSupplementPending = true;
        ctx.clarifyPrompt = {
          question:
            "测试契约里出现了凭证字段（compliance_credential）。请先配置 integration profile。",
          context: "测试数据补全；回答后显式调用 supply_test_data 并重新审批",
        };
        ctx.awaitingClarify = true;
        ctx.emit({
          t: "clarify",
          question: ctx.clarifyPrompt.question,
          context: ctx.clarifyPrompt.context,
          awaitingAnswer: true,
        });
        return { ok: true, summary: "waiting for fixture clarification" };
      },
    };
    const staleSupply: BrainTool = {
      name: "supply_test_data",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "any",
      },
      description: "must not execute after draft-only exit",
      parameters: { type: "object", properties: {} },
      async execute() {
        supplyAttempted();
        return {
          ok: false,
          summary: "credential field still missing",
          output: {
            next: "ask_user",
            question: "请再提供一个凭证字段。",
          },
        };
      },
    };
    const sandboxRun: BrainTool = {
      name: "sandbox_run",
      effect: {
        sideEffect: "write",
        scope: "sandbox",
        checkpoint: "immediate",
        gate: "sandbox",
        advancesStage: true,
      },
      description: "must remain blocked by a draft-only budget grant",
      parameters: { type: "object", properties: {} },
      async execute() {
        sandboxAttempted();
        return { ok: true, summary: "sandbox ran" };
      },
    };
    const finish: BrainTool = {
      name: "finish",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "deliver",
        advancesStage: true,
      },
      description: "must remain blocked by a draft-only budget grant",
      parameters: { type: "object", properties: {} },
      async execute() {
        finishAttempted();
        return { ok: true, summary: "finished" };
      },
    };
    const saveDraft: BrainTool = {
      name: "save_draft",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "any",
      },
      description: "persist generated_unverified draft",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        expect(ctx.testDataSupplementPending).toBe(false);
        expect(ctx.awaitingApproval).toBe(false);
        draftSaved();
        return {
          ok: true,
          summary: "saved generated_unverified draft",
          output: { readiness: "generated_unverified" },
        };
      },
    };

    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "fixture", name: requestFixture.name, args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [
            { id: "stale-supply", name: staleSupply.name, args: "{}" },
            { id: "forbidden-sandbox", name: sandboxRun.name, args: "{}" },
            { id: "forbidden-finish", name: finish.name, args: "{}" },
            { id: "draft", name: saveDraft.name, args: "{}" },
            { id: "draft-replay", name: saveDraft.name, args: "{}" },
          ],
        },
      ],
    );

    let answered = false;
    const ports: FactoryPorts = {
      ontology: baseOntologyPort,
      sandbox: baseSandboxPort,
      reflection: baseReflectionPort,
      conversation: {
        has: async () => false,
        load: async () => null,
        save: async (_id, snapshot) => {
          snapshots.push(
            structuredClone(snapshot) as {
              domain: string;
              messages: ChatMsg[];
              ctx: Record<string, unknown>;
            },
          );
        },
        drainHumanMessages: async () => {
          if (seenTurns.length >= 1 && !answered) {
            answered = true;
            return [
              {
                text: "[澄清回答] compliance_credential 是 Ontology 的业务属性，不是 integration secret；不要配置、粘贴或假定任何凭证。当前只要求保存完整 6-Agent 的 generated_unverified 草稿：停止 supply_test_data，不执行 sandbox_run、finish 或 promotion，直接调用 save_draft；沙箱、交付和晋升继续 fail-closed。",
                actor: "usr-human",
              },
            ];
          }
          return [];
        },
      },
    };

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "完整 authoring 后只保存未验证草稿",
      ports,
      tools: [requestFixture, staleSupply, sandboxRun, finish, saveDraft],
      conversationId: "draft-only-from-fixture-clarification",
    }))
      events.push(event);

    expect(supplyAttempted).not.toHaveBeenCalled();
    expect(sandboxAttempted).not.toHaveBeenCalled();
    expect(finishAttempted).not.toHaveBeenCalled();
    expect(draftSaved).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "supply_test_data",
        ok: false,
        summary: expect.stringContaining("当前没有待补的测试数据"),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        t: "clarify",
        question: "请再提供一个凭证字段。",
        awaitingAnswer: true,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "sandbox_run",
        ok: false,
        summary: expect.stringContaining("一次性收尾授权只允许 save_draft"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "finish",
        ok: false,
        summary: expect.stringContaining("一次性收尾授权只允许 save_draft"),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        id: "draft",
        name: "save_draft",
        ok: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        id: "draft-replay",
        name: "save_draft",
        ok: false,
        summary: expect.stringContaining("超预算收尾名额已消费"),
      }),
    );
    const secondTurn = seenTurns[1]!
      .map((message) => String(message.content ?? ""))
      .join("\n");
    expect(secondTurn).toContain("[测试数据安全门·草稿退出]");
    expect(secondTurn).not.toContain(
      "[测试数据安全门] 请把这次回答解析后显式调用 supply_test_data",
    );
    expect(snapshots.at(-1)?.ctx.testDataSupplementPending).toBe(false);
    expect(snapshots.at(-1)?.ctx.awaitingApproval).toBe(false);
    expect(snapshots.at(-1)?.ctx.draftOnlyHandoffBudgetGrant).toBe("consumed");
    expect(
      (snapshots.at(-1)?.ctx.spent as { toolCalls?: number } | undefined)
        ?.toolCalls,
    ).toBe(36);

    // Compatibility with the live checkpoint written by the prior binary:
    // the exact server system frame is durable, but the new grant field is
    // absent. A crash-retry may recover that authority once without resetting
    // historical spend.
    const availableSnapshot = snapshots.find(
      (snapshot) =>
        snapshot.ctx.draftOnlyHandoffBudgetGrant === "available" &&
        snapshot.messages.some(
          (message) =>
            message.role === "system" &&
            message.content ===
              "[测试数据安全门·草稿退出] 用户明确停止本轮测试数据补充，只要求保存 generated_unverified 草稿。补数据与测试批准状态已由服务端关闭；忽略此前调用 supply_test_data 的指令，现在仅调用 save_draft。禁止 sandbox_run/finish/promotion，不得声称 runnable、verified 或可晋升。",
        ),
    );
    expect(availableSnapshot).toBeTruthy();
    const legacySnapshot = structuredClone(availableSnapshot!);
    delete legacySnapshot.ctx.draftOnlyHandoffBudgetGrant;
    const legacyResumeSnapshots: typeof snapshots = [];
    draftSaved.mockClear();
    scriptedTurns.push([
      {
        t: "tool_calls",
        content: "",
        calls: [
          { id: "legacy-stale", name: staleSupply.name, args: "{}" },
          { id: "legacy-draft", name: saveDraft.name, args: "{}" },
        ],
      },
    ]);
    const legacyResumeEvents = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "crash resume",
      ports: {
        ...ports,
        conversation: {
          has: async () => true,
          load: async () => structuredClone(legacySnapshot),
          save: async (_id, snapshot) => {
            legacyResumeSnapshots.push(
              structuredClone(snapshot) as (typeof snapshots)[number],
            );
          },
          drainHumanMessages: async () => [],
        },
      },
      tools: [staleSupply, saveDraft],
      conversationId: "legacy-draft-only-checkpoint",
      continuationMode: "crash_resume",
    }))
      legacyResumeEvents.push(event);

    expect(draftSaved).toHaveBeenCalledOnce();
    expect(legacyResumeEvents).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        id: "legacy-draft",
        name: "save_draft",
        ok: true,
      }),
    );
    expect(legacyResumeSnapshots.at(-1)?.ctx.draftOnlyHandoffBudgetGrant).toBe(
      "consumed",
    );
    expect(
      (
        legacyResumeSnapshots.at(-1)?.ctx.spent as
          | { toolCalls?: number }
          | undefined
      )?.toolCalls,
    ).toBe(36);

    // A persisted consumed grant must not be reconstructed from the still
    // present marker on a later retry.
    const consumedSnapshot = structuredClone(legacyResumeSnapshots.at(-1)!);
    const consumedResumeSnapshots: typeof snapshots = [];
    draftSaved.mockClear();
    scriptedTurns.push([
      {
        t: "tool_calls",
        content: "",
        calls: [{ id: "consumed-retry", name: saveDraft.name, args: "{}" }],
      },
    ]);
    const consumedResumeEvents = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "retry must not mint another grant",
      ports: {
        ...ports,
        conversation: {
          has: async () => true,
          load: async () => structuredClone(consumedSnapshot),
          save: async (_id, snapshot) => {
            consumedResumeSnapshots.push(
              structuredClone(snapshot) as (typeof snapshots)[number],
            );
          },
          drainHumanMessages: async () => [],
        },
      },
      tools: [saveDraft],
      conversationId: "consumed-draft-only-checkpoint",
      continuationMode: "crash_resume",
    }))
      consumedResumeEvents.push(event);

    expect(draftSaved).not.toHaveBeenCalled();
    expect(consumedResumeEvents).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        id: "consumed-retry",
        name: "save_draft",
        ok: false,
        summary: expect.stringContaining("超预算收尾名额已消费"),
      }),
    );
    expect(
      consumedResumeSnapshots.at(-1)?.ctx.draftOnlyHandoffBudgetGrant,
    ).toBe("consumed");
  });

  it("keeps an ordinary over-budget save_draft fail-closed without the one-shot grant", async () => {
    const draftSaved = vi.fn();
    const consumeBudget: BrainTool = {
      name: "consume_budget_for_test",
      effect: {
        sideEffect: "read",
        scope: "none",
        checkpoint: "turn",
        gate: "any",
      },
      description: "reproduce an already-exhausted resumed conversation",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.spent.toolCalls = 36;
        ctx.budget.maxToolCalls = 20;
        return { ok: true, summary: "historical spend restored" };
      },
    };
    const saveDraft: BrainTool = {
      name: "save_draft",
      effect: {
        sideEffect: "write",
        scope: "factory_durable",
        checkpoint: "immediate",
        gate: "any",
      },
      description: "must not receive a generic over-budget exemption",
      parameters: { type: "object", properties: {} },
      async execute() {
        draftSaved();
        return { ok: true, summary: "saved" };
      },
    };

    scriptedTurns.push(
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "consume", name: consumeBudget.name, args: "{}" }],
        },
      ],
      [
        {
          t: "tool_calls",
          content: "",
          calls: [{ id: "draft", name: saveDraft.name, args: "{}" }],
        },
      ],
    );

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "ordinary draft request without a fixture-exit decision",
      ports: {
        ontology: baseOntologyPort,
        sandbox: baseSandboxPort,
        reflection: baseReflectionPort,
        conversation: {
          has: async () => false,
          load: async () => null,
          save: async () => undefined,
          drainHumanMessages: async () => [],
        },
      },
      tools: [consumeBudget, saveDraft],
      conversationId: "ordinary-over-budget-save-draft",
    }))
      events.push(event);

    expect(draftSaved).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        t: "tool.result",
        name: "save_draft",
        ok: false,
        summary: expect.stringContaining("工具调用预算上限（20）"),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      t: "done",
      status: "budget_exhausted",
      completionKind: "incomplete",
    });
  });
});
