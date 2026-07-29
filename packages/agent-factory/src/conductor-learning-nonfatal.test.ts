// #LEARN-NONFATAL —— 学习类收尾失败不得改判交付事实。
//
// 这条不变量是被一个真实事故形状逼出来的：技能评估 / 自动反思 / 记忆整合 /
// 策略统计四段全部跑在【交付之后】，原实现在各自的 catch 里置
// erroredOut = true，于是 done.status 从 finished 翻成 errored；上游 OntoCode
// 按 factory_build_incomplete 处理，把一个已经设计好、已落盘、沙箱已验证的
// 候选包直接丢掉。一次快档摘要调用抖动就足以触发。
//
// 保留响亮：失败照旧发 error 事件，并在收尾多发一条明说「这次的经验没有沉淀
// 下来」。只是不再改判交付。
//
// 夹具说明（这两点是之前写不出这个测试的原因）：
//  1. 必须连 chatOnce 一起打桩。收尾的技能归纳 / 记忆整合 / 意图门都走它，
//     不打桩就会真去连 provider，测试挂在重试上而不是挂在断言上。
//  2. finish 有真实的阶段闸门：`deliver` 要求 ctx.lastSandbox 存在。这里不
//     绕过闸门，而是先用一个自带工具把沙箱证据放进 ctx —— 测的是「闸门通过
//     之后的收尾」，闸门本身仍然是真的。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg } from "./stream-gateway";
import type { BrainCtx, BrainTool } from "./brain-types";
import type { FactoryPorts } from "./ports";

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => true,
    setLlmCallContext: () => undefined,
    chatJson: async () => ({}),
    chat: async () => "",
    chatOnce: async () => "",
    streamTurn: async function* (messages: ChatMsg[]) {
      yield { t: "usage" as const, promptTokens: 10, completionTokens: 5 };
      // 从【对话内容】决定这一轮做什么，而不是靠模块级计数器——计数器会跨
      // 同文件的多个用例累加，第二个用例起就永远拿不到那一轮种子。
      const seeded = messages.some((m) =>
        typeof m.content === "string" && m.content.includes("sandbox evidence seeded"),
      );
      yield {
        t: "tool_calls" as const,
        content: "",
        calls: [
          seeded
            ? {
                id: "c-finish",
                name: "finish",
                args: JSON.stringify({ reasoning: "交付" }),
              }
            : {
                id: "c-seed",
                name: "seed_sandbox_evidence",
                args: JSON.stringify({ reasoning: "先拿到沙箱证据" }),
              },
        ],
      };
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function basePorts(overrides: Record<string, unknown> = {}): FactoryPorts {
  return {
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
        throw new Error("not used — evidence is seeded directly");
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
    ...overrides,
  } as unknown as FactoryPorts;
}

async function runToDone(ports: FactoryPorts) {
  vi.stubEnv("FACTORY_AI_MODEL", "test/learning-nonfatal");
  vi.stubEnv("FACTORY_MAX_TURNS", "4");
  const { runBrain } = await import("./conductor");

  const seed: BrainTool = {
    name: "seed_sandbox_evidence",
    description: "test seam: put sandbox evidence in ctx so the deliver gate opens",
    parameters: { type: "object" },
    execute: async (_args, ctx: BrainCtx) => {
      ctx.lastSandbox = {
        ok: true,
        simulated: false,
        agents: [],
      } as unknown as BrainCtx["lastSandbox"];
      return { ok: true, summary: "sandbox evidence seeded" };
    },
  };
  const finish: BrainTool = {
    name: "finish",
    description: "deliver",
    parameters: { type: "object" },
    execute: async () => ({ ok: true, summary: "delivered" }),
  };

  const events = [];
  for await (const event of runBrain({
    domain: "dom",
    goal: "deliver something",
    ports,
    tools: [seed, finish],
  })) {
    events.push(event);
  }
  return events;
}

const learningWarning = (events: Array<{ t: string }>): boolean =>
  events.some(
    (e) =>
      e.t === "message" &&
      /这次的经验没有沉淀下来/.test((e as unknown as { text: string }).text),
  );

describe("post-delivery learning failures", () => {
  it("delivers cleanly when the learning tail is healthy (baseline)", async () => {
    vi.resetModules();
    const events = await runToDone(basePorts());
    expect(events.find((e) => e.t === "done")).toMatchObject({
      status: "finished",
      completionKind: "delivery",
    });
    expect(learningWarning(events)).toBe(false);
  });

  it("a rejecting policy-stats store cannot unmake a delivered run", async () => {
    vi.resetModules();
    const events = await runToDone(
      basePorts({
        policyStats: {
          load: async () => null,
          save: async () => {
            throw new Error("disk full");
          },
        },
      }),
    );

    // 交付事实不变——这正是修复的全部意义。
    expect(events.find((e) => e.t === "done")).toMatchObject({
      status: "finished",
      completionKind: "delivery",
    });
    // 但失败仍然响亮：不改判 ≠ 吞掉。
    expect(
      events.some(
        (e) =>
          e.t === "error" &&
          /策略统计保存失败/.test((e as unknown as { message: string }).message),
      ),
    ).toBe(true);
    expect(learningWarning(events)).toBe(true);
  });

  it("a rejecting reflection port cannot unmake a delivered run", async () => {
    vi.resetModules();
    const events = await runToDone(
      basePorts({
        reflection: {
          list: async () => [],
          record: async () => {
            throw new Error("reflection store offline");
          },
        },
      }),
    );
    expect(events.find((e) => e.t === "done")).toMatchObject({
      status: "finished",
      completionKind: "delivery",
    });
  });

  it("a rejecting skill store cannot unmake a delivered run", async () => {
    vi.resetModules();
    const events = await runToDone(
      basePorts({
        skills: {
          list: async () => [],
          save: async () => undefined,
          recordEval: async () => {
            throw new Error("skill store offline");
          },
        },
      }),
    );
    expect(events.find((e) => e.t === "done")).toMatchObject({
      status: "finished",
      completionKind: "delivery",
    });
  });
});
