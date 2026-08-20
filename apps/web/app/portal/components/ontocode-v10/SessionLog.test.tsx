import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  OntoCodeAssistantRun,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import {
  eventLabel,
  eventTypeHint,
  ReasoningFlowView,
  SessionLogView,
} from "./SessionLog";
import { SystemConnectionsView, connectionStage } from "./SystemConnections";
import type { SystemCoverageItem } from "@/lib/hooks/useOntoCodeWorkspace";
import { PreferencesProvider } from "@/app/portal/lib/preferences-context";

/** These views render HelpTip, which reads i18n preferences. */
function renderWithPrefs(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <PreferencesProvider>{node}</PreferencesProvider>,
  );
}

const NOW = 1_753_600_000_000;

function msg(overrides: Partial<OntoCodeMessage> = {}): OntoCodeMessage {
  return {
    id: "ocm-1",
    tenantId: "t",
    sessionId: "s",
    role: "user",
    type: "text",
    content: { text: "生成 agents" },
    commandId: null,
    correlationId: "cor-1",
    idempotencyKey: null,
    createdAt: NOW,
    ...overrides,
  } as OntoCodeMessage;
}

function evt(
  overrides: Partial<OntoCodeSessionEvent> = {},
): OntoCodeSessionEvent {
  return {
    id: "oce-1",
    seq: 1,
    tenantId: "t",
    projectId: "p",
    sessionId: "s",
    harnessJobId: "ocj-1",
    commandId: null,
    correlationId: "cor-1",
    causationId: null,
    type: "harness.ontology_analysis.plan",
    visibility: "user",
    payload: { counts: { objects: 49, links: 580 } },
    createdAt: NOW + 1000,
    ...overrides,
  } as OntoCodeSessionEvent;
}

function job(overrides: Partial<OntoCodeHarnessJob> = {}): OntoCodeHarnessJob {
  return {
    id: "ocj-1",
    tenantId: "t",
    sessionId: "s",
    commandId: null,
    runtimeProfileVersionId: null,
    kind: "ontology_analysis",
    status: "succeeded",
    inputHash: null,
    budget: null,
    candidatePackageVersionId: null,
    candidateDependencyRoot: null,
    candidateHeadId: null,
    candidateHeadRevision: null,
    testCases: [],
    idempotencyKey: "i",
    errorMessage: null,
    createdBy: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 5000,
    updatedAt: NOW + 5000,
    ...overrides,
  } as OntoCodeHarnessJob;
}

function arun(
  overrides: Partial<OntoCodeAssistantRun> = {},
): OntoCodeAssistantRun {
  return {
    id: "ocar-1",
    tenantId: "t",
    sessionId: "s",
    sourceMessageId: "ocm-1",
    status: "succeeded",
    autonomyMode: "copilot",
    policy: {},
    contextHash: null,
    contextManifest: {},
    budget: {},
    model: "provider-a/model-a",
    terminalResponse: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: "i",
    createdBy: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 1,
    updatedAt: NOW + 1,
    ...overrides,
  } as OntoCodeAssistantRun;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("eventLabel", () => {
  it("translates known types and keeps unknown ones visible", () => {
    expect(eventLabel("harness.job.waiting_user")).toBe("等待你回答");
    expect(eventLabel("harness.ontology_analysis.plan")).toContain("读取结构");
    expect(eventLabel("harness.ontology_analysis.interpret_failed")).toContain(
      "模型解释未完成",
    );
    expect(eventLabel("harness.build.stage")).toBe("阶段进展");
    expect(eventLabel("harness.build.strategy")).toBe("推理方法");
    expect(eventLabel("harness.build.reasoning_step")).toBe("推理摘要");
    expect(eventLabel("harness.build.thinking")).toContain("非推理");
    // An unmapped type must not be silently swallowed — but the raw type is an
    // internal identifier, so it belongs on hover, not in the row's prose.
    // (It used to be the label itself; `harness.build.factory_started` — a frame
    // the server really emits — was printed verbatim to the FDE.)
    expect(eventLabel("some.future.event")).not.toBe("some.future.event");
    expect(eventTypeHint("some.future.event")).toBe("some.future.event");
    expect(eventTypeHint("harness.build.stage")).toBeNull();
  });

  it("labels the streaming-answer frame types inside the analysis phase branch", () => {
    // The ontology_analysis branch intercepts BEFORE the generic step map — a
    // missing entry would render "分析 · tool_call".
    expect(eventLabel("harness.ontology_analysis.tool_call")).toBe(
      "分析 · 调用工具",
    );
    expect(eventLabel("harness.ontology_analysis.tool_result")).toBe(
      "分析 · 工具结果",
    );
    expect(eventLabel("harness.ontology_analysis.chart")).toBe(
      "分析 · 生成图表",
    );
    expect(eventLabel("harness.ontology_analysis.answer_delta_truncated")).toBe(
      "回答分片已达上限（完整内容在最终消息里）",
    );
  });
});

describe("streaming answer frames in the log views", () => {
  const deltas = [1, 2, 3].map((ordinal) =>
    evt({
      id: `oce-delta-${ordinal}`,
      seq: 100 + ordinal,
      type: "harness.ontology_analysis.answer_delta",
      payload: { ordinal, text: `分片正文${ordinal}` },
      createdAt: NOW + 1000 + ordinal,
    }),
  );

  it("collapses consecutive answer deltas of one job into a single row without dumping text", () => {
    const html = renderToStaticMarkup(
      <SessionLogView messages={[]} events={deltas} jobs={[job()]} />,
    );
    expect(html).toContain("生成回答 · 3 片");
    expect(html).not.toContain("分片正文1");
    expect(occurrences(html, "生成回答")).toBe(1);
  });

  it("breaks the collapse when another frame interleaves", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          deltas[0]!,
          deltas[1]!,
          evt({
            id: "oce-tc",
            seq: 110,
            type: "harness.ontology_analysis.tool_call",
            payload: { tool: "list_events", reasoning: "读取事件分布" },
            createdAt: NOW + 1002.5,
          }),
          deltas[2]!,
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("生成回答 · 2 片");
    expect(html).toContain("生成回答 · 1 片");
    expect(html).toContain("分析 · 调用工具");
    expect(html).toContain("list_events");
  });

  it("shows the chart frame with its server-computed title", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          evt({
            id: "oce-chart",
            seq: 120,
            type: "harness.ontology_analysis.chart",
            payload: {
              chart: {
                schema: "ontocode-chart/v1",
                kind: "bar",
                title: "事件类型分布",
                rows: [{ label: "tool_call", value: 3 }],
                truncated: false,
                source: { aggregate: "events.by_type", computedBy: "server" },
              },
            },
          }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("分析 · 生成图表");
    expect(html).toContain("事件类型分布");
  });

  it("collapses the delta flood in the reasoning flow as well", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView jobs={[job()]} events={deltas} />,
    );
    expect(html).toContain("生成回答 · 3 片");
    expect(occurrences(html, "生成回答")).toBe(1);
    expect(html).not.toContain("分片正文1");
  });
});

/**
 * #INQUIRY-DELIBERATION —— 声明 / 每个真跑的方法 / 结果。这三种事件落在
 * ontology_analysis 相位分支里，该分支在通用 step 映射之前拦截：缺条目就渲染成
 * 「分析 · strategy」这样的半生不熟标签，而且 eventDetail 一个字段都读不到，
 * 整行没有正文。
 */
describe("deliberation frames in the log views", () => {
  const strategyEvent = evt({
    id: "oce-strategy",
    seq: 200,
    type: "harness.ontology_analysis.strategy",
    payload: {
      mode: "combo",
      steps: ["cot", "reflection"],
      chosenBy: "ai",
      rationale: "先列证据再自评，避免漏掉未消费事件",
      suggestion: "cot",
      estimatedModelCalls: 3,
    },
    createdAt: NOW + 2000,
  });

  function step(
    ordinal: number,
    payload: Record<string, unknown>,
  ): OntoCodeSessionEvent {
    return evt({
      id: `oce-step-${ordinal}`,
      seq: 210 + ordinal,
      type: "harness.ontology_analysis.reasoning_step",
      payload,
      createdAt: NOW + 2100 + ordinal,
    });
  }

  it("labels all three types instead of leaking the raw phase name", () => {
    expect(eventLabel("harness.ontology_analysis.strategy")).toBe(
      "分析 · 推理方法",
    );
    expect(eventLabel("harness.ontology_analysis.reasoning_step")).toBe(
      "分析 · 推理步骤",
    );
    expect(eventLabel("harness.ontology_analysis.deliberation")).toBe(
      "分析 · 审议结果",
    );
    for (const type of [
      "harness.ontology_analysis.strategy",
      "harness.ontology_analysis.reasoning_step",
      "harness.ontology_analysis.deliberation",
    ]) {
      expect(eventLabel(type)).not.toContain(type.split(".").pop()!);
    }
  });

  it("gives the declaration row the chain, the model's reason and whose call it was", () => {
    const html = renderToStaticMarkup(
      <SessionLogView messages={[]} events={[strategyEvent]} jobs={[job()]} />,
    );
    expect(html).toContain("分析 · 推理方法");
    expect(html).toContain("cot → reflection");
    expect(html).toContain("先列证据再自评");
    // 服务端先验只是建议；模型改了主意这件事必须看得见。
    expect(html).toContain("模型自选");
  });

  it("marks a declaration that simply took the server's suggestion", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          evt({
            ...strategyEvent,
            id: "oce-strategy-default",
            payload: {
              mode: "single",
              steps: ["cot"],
              chosenBy: "default",
              rationale: "沿用默认即可",
              suggestion: "cot",
              estimatedModelCalls: 1,
            },
          }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("沿用默认");
    expect(html).not.toContain("模型自选");
  });

  it("gives an executed method its position and its excerpt", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          step(1, {
            strategy: "reflection",
            index: 1,
            total: 3,
            output: "复核后发现两个孤立事件",
          }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("分析 · 推理步骤");
    expect(html).toContain("reflection 2/3");
    expect(html).toContain("复核后发现两个孤立事件");
  });

  it("never shows the declared method alone when a different one actually ran", () => {
    const degraded = step(2, {
      strategy: "socratic",
      index: 0,
      total: 1,
      output: "逐条追问后的结论",
      degradedFrom: "socratic",
    });
    const html = renderToStaticMarkup(
      <SessionLogView messages={[]} events={[degraded]} jobs={[job()]} />,
    );
    expect(html).toContain("socratic → 通用推理 1/1");
    expect(html).not.toContain(">socratic 1/1");
  });

  it("reads degradedFrom out of meta as well", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          step(3, {
            strategy: "socratic",
            index: 0,
            total: 1,
            output: "结论",
            meta: { degradedFrom: "socratic" },
          }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("通用推理");
  });

  it("shows the outcome status and its account", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          evt({
            id: "oce-outcome",
            seq: 250,
            type: "harness.ontology_analysis.deliberation",
            payload: {
              status: "refused",
              declared: ["debate"],
              executed: [],
              dropped: ["debate"],
              detail: "第一步至少需要 4 次模型调用，本次只剩 1 次",
              modelCalls: 0,
            },
            createdAt: NOW + 2500,
          }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("分析 · 审议结果");
    expect(html).toContain("未执行审议");
    expect(html).toContain("本次只剩 1 次");
  });

  it("collapses a run of plain reasoning steps but never swallows a degraded or failed one", () => {
    const events = [
      step(4, { strategy: "cot", index: 0, total: 4, output: "第一步" }),
      step(5, { strategy: "cot", index: 1, total: 4, output: "第二步" }),
      step(6, { strategy: "cot", index: 2, total: 4, output: "第三步" }),
      step(7, {
        strategy: "socratic",
        index: 3,
        total: 4,
        output: "第四步",
        degradedFrom: "socratic",
      }),
      step(8, {
        strategy: "debate",
        index: 4,
        total: 5,
        output: "",
        error: "上游超时",
      }),
    ];
    const html = renderToStaticMarkup(
      <SessionLogView messages={[]} events={events} jobs={[job()]} />,
    );
    expect(html).toContain("推理步骤 · 3 步");
    expect(occurrences(html, "推理步骤 · 3 步")).toBe(1);
    // 折叠掉的三步正文不进日志，但降级步与失败步必须各自成行、带正文。
    expect(html).not.toContain("第二步");
    expect(html).toContain("socratic → 通用推理 4/4");
    expect(html).toContain("上游超时");
  });

  it("keeps a lone reasoning step readable instead of collapsing it into a count", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          step(9, { strategy: "cot", index: 0, total: 1, output: "唯一一步" }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("唯一一步");
    expect(html).not.toContain("推理步骤 · 1 步");
  });

  it("applies the same collapse discipline in the reasoning flow", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[job()]}
        events={[
          strategyEvent,
          step(10, { strategy: "cot", index: 0, total: 3, output: "第一步" }),
          step(11, { strategy: "cot", index: 1, total: 3, output: "第二步" }),
          step(12, {
            strategy: "socratic",
            index: 2,
            total: 3,
            output: "第三步",
            degradedFrom: "socratic",
          }),
        ]}
      />,
    );
    expect(html).toContain("cot → reflection");
    expect(html).toContain("推理步骤 · 2 步");
    expect(html).not.toContain("第二步");
    expect(html).toContain("socratic → 通用推理 3/3");
  });

  it("carries no internal identifiers into any deliberation row", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          strategyEvent,
          step(13, { strategy: "cot", index: 0, total: 1, output: "结论" }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).not.toContain("ocj-1");
    expect(html).not.toContain("cor-1");
    expect(html).not.toContain("undefined");
  });
});

/**
 * #BLUEPRINT-REASON —— 蓝图阶段现在按 harness.blueprint.{strategy,reasoning_step,
 * deliberation} 发与分析命名空间同形的推理帧（服务端明说 mirror the analysis
 * vocabulary）。不接标签/正文，这三种帧就以原始类型名渲染成无正文空行——
 * 与分析命名空间当年的缺陷一模一样。
 */
describe("blueprint reasoning frames in the log views", () => {
  const blueprintJob = job({ id: "ocj-bp", kind: "blueprint" });
  function bevt(
    overrides: Partial<OntoCodeSessionEvent>,
  ): OntoCodeSessionEvent {
    return evt({ harnessJobId: "ocj-bp", ...overrides });
  }

  it("labels the blueprint namespace instead of leaking raw types", () => {
    expect(eventLabel("harness.blueprint.strategy")).toBe("蓝图 · 推理方法");
    expect(eventLabel("harness.blueprint.reasoning_step")).toBe(
      "蓝图 · 推理步骤",
    );
    expect(eventLabel("harness.blueprint.deliberation")).toBe(
      "蓝图 · 审议结果",
    );
    expect(eventLabel("harness.blueprint.grounded")).toBe(
      "蓝图 · 基于本体",
    );
    // 蓝图命名空间下的通用帧仍走通用映射，不得因新分支反而变生。
    expect(eventLabel("harness.blueprint.stage")).toBe("阶段进展");
  });

  it("keeps every deliberation-trio namespace labeled — including ones that do not exist yet", () => {
    // 三帧词汇是跨阶段契约。这里锁的是结构性质：任何
    // harness.<ns>.{strategy,reasoning_step,deliberation} 都必须得到人话标签，
    // 未来新增命名空间时由这条测试替它把关——缺标签立即红。
    const namespaces = [
      "ontology_analysis",
      "blueprint",
      "scope",
      "some_future_stage",
    ];
    const frames = ["strategy", "reasoning_step", "deliberation"] as const;
    for (const ns of namespaces) {
      for (const frame of frames) {
        const type = `harness.${ns}.${frame}`;
        const label = eventLabel(type);
        expect(label, type).not.toBe(type);
        expect(label, type).not.toContain(frame);
        expect(label, type).not.toContain("harness.");
      }
    }
  });

  it("gives blueprint strategy/step/deliberation rows their bodies via the shared readers", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          bevt({
            id: "oce-bp-strategy",
            seq: 300,
            type: "harness.blueprint.strategy",
            payload: {
              mode: "single",
              steps: ["cot"],
              chosenBy: "default",
              rationale: "阶段少，先用默认组合",
              suggestion: "cot",
              estimatedModelCalls: 3,
              unknown: [],
            },
            createdAt: NOW + 3000,
          }),
          bevt({
            id: "oce-bp-step",
            seq: 301,
            type: "harness.blueprint.reasoning_step",
            payload: {
              strategy: "cot",
              index: 0,
              total: 3,
              output: "解析简历阶段需要先校验附件格式",
              phaseId: "phase-1",
              phaseTitle: "解析简历",
            },
            createdAt: NOW + 3001,
          }),
          bevt({
            id: "oce-bp-outcome",
            seq: 302,
            type: "harness.blueprint.deliberation",
            payload: {
              status: "degraded",
              declared: ["cot"],
              executed: ["cot"],
              dropped: [],
              detail: "共 3 个阶段，已逐阶段推理并接地 1 个，2 个保留机械骨架",
              modelCalls: 3,
              context: { phases: 3, phasesReasoned: 1, phasesMechanical: 2 },
            },
            createdAt: NOW + 3002,
          }),
        ]}
        jobs={[blueprintJob]}
      />,
    );
    expect(html).toContain("蓝图 · 推理方法");
    expect(html).toContain("沿用默认");
    expect(html).toContain("阶段少，先用默认组合");
    expect(html).toContain("蓝图 · 推理步骤");
    expect(html).toContain("cot 1/3");
    expect(html).toContain("解析简历阶段需要先校验附件格式");
    expect(html).toContain("蓝图 · 审议结果");
    expect(html).toContain("审议部分完成");
    expect(html).toContain("2 个保留机械骨架");
    expect(html).not.toContain("harness.blueprint");
  });

  it("renders the future-namespace trio with real bodies, not bare labels", () => {
    // 正文读法与标签一样是按后缀接的：伪造一个未来阶段，三种帧照样有正文。
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          bevt({
            id: "oce-fut-outcome",
            seq: 320,
            type: "harness.some_future_stage.deliberation",
            payload: {
              status: "refused",
              declared: ["debate"],
              executed: [],
              dropped: ["debate"],
              detail: "预算不足，未启动",
              modelCalls: 0,
            },
            createdAt: NOW + 3200,
          }),
        ]}
        jobs={[blueprintJob]}
      />,
    );
    expect(html).toContain("未执行审议");
    expect(html).toContain("预算不足，未启动");
    expect(html).not.toContain("harness.some_future_stage");
  });

  it("collapses clean blueprint reasoning steps but keeps a failed one visible", () => {
    const steps = [0, 1, 2].map((i) =>
      bevt({
        id: `oce-bp-run-${i}`,
        seq: 310 + i,
        type: "harness.blueprint.reasoning_step",
        payload: {
          strategy: "cot",
          index: i,
          total: 4,
          output: `阶段推导 ${i}`,
        },
        createdAt: NOW + 3100 + i,
      }),
    );
    const failed = bevt({
      id: "oce-bp-run-3",
      seq: 313,
      type: "harness.blueprint.reasoning_step",
      payload: {
        strategy: "cot",
        index: 3,
        total: 4,
        output: "",
        error: "内核超时",
      },
      createdAt: NOW + 3103,
    });
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[...steps, failed]}
        jobs={[blueprintJob]}
      />,
    );
    expect(html).toContain("推理步骤 · 3 步");
    expect(html).not.toContain("阶段推导 1");
    expect(html).toContain("内核超时");
  });
});

/**
 * strategy 帧无条件先发——它只是「声明」。deliberation 帧才是结局：零阶段真的
 * 推理时，「推理方法」不允许只挂着声明的方法名冒充跑过；这与 reasoning_step 的
 * degradedFrom 纪律同源（声明名不得冒充真跑了的方法）。
 */
describe("jobMethod derives the shown method from declaration plus outcome", () => {
  const bpJob = job({ id: "ocj-bp-method", kind: "blueprint" });
  const strategyEvt = evt({
    id: "oce-m-strategy",
    seq: 400,
    harnessJobId: "ocj-bp-method",
    type: "harness.blueprint.strategy",
    payload: {
      mode: "single",
      steps: ["cot"],
      chosenBy: "default",
      rationale: "默认",
      suggestion: "cot",
      estimatedModelCalls: 3,
    },
    createdAt: NOW + 4000,
  });
  function outcome(payload: Record<string, unknown>): OntoCodeSessionEvent {
    return evt({
      id: "oce-m-outcome",
      seq: 410,
      harnessJobId: "ocj-bp-method",
      type: "harness.blueprint.deliberation",
      payload,
      createdAt: NOW + 4100,
    });
  }

  it("says 未执行 with the mechanical count when the deliberation reports zero reasoned phases", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[bpJob]}
        events={[
          strategyEvt,
          outcome({
            status: "empty",
            declared: ["cot"],
            executed: [],
            dropped: ["cot"],
            detail: "预算不足，3 个阶段全部保留机械骨架",
            modelCalls: 0,
            context: { phases: 3, phasesReasoned: 0, phasesMechanical: 3 },
          }),
        ]}
      />,
    );
    expect(html).toContain("cot · 未执行（3 阶段机械推导）");
    expect(html).not.toMatch(/title="cot"/);
  });

  it("marks a partially reasoned outcome instead of showing the bare chain", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[bpJob]}
        events={[
          strategyEvt,
          outcome({
            status: "degraded",
            declared: ["cot"],
            executed: ["cot"],
            dropped: [],
            detail: "接地 1 个，2 个保留机械骨架",
            modelCalls: 3,
            context: { phases: 3, phasesReasoned: 1, phasesMechanical: 2 },
          }),
        ]}
      />,
    );
    expect(html).toContain("cot · 审议部分完成（1/3 阶段推理）");
    expect(html).not.toMatch(/title="cot"/);
  });

  it("shows the executed chain bare only when the deliberation completed", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[bpJob]}
        events={[
          strategyEvt,
          outcome({
            status: "completed",
            declared: ["cot"],
            executed: ["cot"],
            dropped: [],
            detail: "3 个阶段全部推理并接地",
            modelCalls: 3,
            context: { phases: 3, phasesReasoned: 3, phasesMechanical: 0 },
          }),
        ]}
      />,
    );
    expect(html).toMatch(/title="cot"/);
  });

  it("keeps the declared chain when reasoning steps witness execution without an outcome frame", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[bpJob]}
        events={[
          strategyEvt,
          evt({
            id: "oce-m-step",
            seq: 401,
            harnessJobId: "ocj-bp-method",
            type: "harness.blueprint.reasoning_step",
            payload: {
              strategy: "cot",
              index: 0,
              total: 3,
              output: "第一阶段",
            },
            createdAt: NOW + 4001,
          }),
        ]}
      />,
    );
    expect(html).toMatch(/title="cot"/);
  });

  it("refuses to advertise a declared method on a finished job with no execution evidence", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView jobs={[bpJob]} events={[strategyEvt]} />,
    );
    expect(html).toContain("cot · 未见执行步骤");
    expect(html).not.toMatch(/title="cot"/);
  });
});

describe("SessionLogView", () => {
  it("interleaves messages and events in time order", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[
          msg(),
          msg({
            id: "ocm-2",
            role: "assistant",
            content: { text: "好的" },
            createdAt: NOW + 2000,
          }),
        ]}
        events={[evt()]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("生成 agents");
    expect(html).toContain("好的");
    expect(html).toContain("读取结构");
    expect(html).toContain("2 消息");
    // real counts, and payload rendered as a readable summary not raw JSON
    expect(html).toContain("objects 49");
    expect(html).not.toContain('{"counts"');
  });

  it("hides debug events until asked", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[evt({ visibility: "debug", type: "harness.job.leased" })]}
        jobs={[]}
      />,
    );
    expect(html).toContain("显示全部");
    expect(html).not.toContain("作业领取");
  });

  it("keeps an Analyst interpretation failure visible even when stamped debug", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[
          evt({
            visibility: "debug",
            type: "harness.ontology_analysis.interpret_failed",
            payload: { failureKind: "invalid_json" },
          }),
        ]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("模型解释未完成");
    expect(html).toContain("失败类型 invalid_json");
  });

  it("shows an honest empty state", () => {
    const html = renderToStaticMarkup(
      <SessionLogView messages={[]} events={[]} jobs={[]} />,
    );
    expect(html).toContain("暂无记录");
  });
});

describe("ReasoningFlowView", () => {
  it("draws one node per job with its real steps", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[
          job(),
          job({
            id: "ocj-2",
            kind: "scope",
            status: "waiting_user",
            createdAt: NOW + 10,
          }),
        ]}
        events={[evt()]}
      />,
    );
    expect(html).toContain("本体理解");
    expect(html).toContain("范围分析");
    expect(html).toContain("等你回答");
    expect(html).toContain("读取结构");
  });

  it("explains itself when nothing has run", () => {
    const html = renderWithPrefs(
      <ReasoningFlowView
        jobs={[]}
        events={[]}
        llmRuntime={{
          ok: true,
          reachable: true,
          provider: "custom",
          model: "gemini",
          mock: false,
          factoryCentralRouting: true,
        }}
      />,
    );
    expect(html).toContain("默认 LLM Gateway");
    expect(html).toContain("暂无步骤");
  });

  it("shows live non-mock LLM status and labels deterministic Blueprint honestly", () => {
    const html = renderWithPrefs(
      <ReasoningFlowView
        jobs={[
          job({
            id: "ocj-blueprint",
            kind: "blueprint",
            status: "succeeded",
          }),
        ]}
        events={[]}
        llmRuntime={{
          ok: true,
          reachable: true,
          provider: "custom",
          model: "google/gemini-3-flash-preview",
          latencyMs: 454,
          mock: false,
          factoryCentralRouting: true,
          lastCheckedAt: NOW,
        }}
      />,
    );
    expect(html).toContain("默认 LLM Gateway");
    expect(html).toContain("路由可达");
    // 内部路由明细降级为 hover（title），但事实仍随 DOM 可查。
    expect(html).toContain("google/gemini-3-flash-preview");
    expect(html).toContain("OntoCode 生成走中央租户路由");
    expect(html).not.toContain("Factory");
    expect(html).toContain("确定性本体接地 · 非 ReAct");
    expect(html).toContain("不会产生 ReAct 轨迹");
    expect(html).toContain("不代表每个 Job 都成功");
    expect(html).toContain("界面不会显示密钥");
    expect(html).toContain("仅在服务端使用已配置凭据");
  });

  it("does not present a reachable control plane as healthy inference after a credit failure", () => {
    const html = renderWithPrefs(
      <ReasoningFlowView
        jobs={[
          job({
            kind: "build",
            status: "failed_recoverable",
            errorMessage:
              '402 Insufficient credits {"limit_source":"openrouter_credits"}',
          }),
        ]}
        events={[]}
        llmRuntime={{
          ok: true,
          reachable: true,
          provider: "custom",
          model: "google/gemini-3-flash-preview",
          mock: false,
          factoryCentralRouting: true,
        }}
      />,
    );
    expect(html).toContain("推理受阻");
    expect(html).toContain("最近代码生成：模型额度不足");
    expect(html).not.toContain(">路由可达<");
  });

  it("marks a structurally succeeded Analyst job as partial failure when model interpretation failed", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[job({ status: "succeeded" })]}
        events={[
          evt({
            type: "harness.ontology_analysis.interpret_failed",
            visibility: "user",
            payload: { failureKind: "no_json" },
          }),
        ]}
      />,
    );
    expect(html).toContain("结构完成 · 模型解释失败");
    expect(html).toContain("失败类型 no_json");
  });

  // The assistant's own events are persisted with harnessJobId = null. Before
  // the assistant lane existed they were dropped outright, so nothing the
  // conversational side did could ever appear here.
  it("renders assistant events that carry no harness job", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[]}
        events={[
          evt({
            id: "oce-assistant-failed",
            harnessJobId: null,
            type: "assistant.run.failed",
            payload: {
              assistantRunId: "ocar-1",
              sourceMessageId: "ocm-1",
              errorMessage: "模型连续两次给出的回复都不符合规格",
            },
            createdAt: NOW + 20,
          }),
        ]}
      />,
    );
    expect(html).toContain("模型回复失败");
    expect(html).toContain("模型连续两次给出的回复都不符合规格");
    expect(html).not.toContain("暂无步骤");
    // the lane must be visually distinguishable, and a class that does not
    // exist in the CSS module renders as "undefined" — silently unstyled.
    expect(html).toMatch(/class="[^"]*flowAssistant/);
    expect(html).not.toContain("undefined");
  });

  it("groups conversation events into one lane per assistant run", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[]}
        assistantRuns={[
          arun(),
          arun({
            id: "ocar-2",
            sourceMessageId: "ocm-2",
            status: "failed",
            model: null,
          }),
        ]}
        events={[
          // carries only sourceMessageId — the run id has to come from the join
          evt({
            id: "oce-plan-1",
            harnessJobId: null,
            type: "ai.plan.proposed",
            payload: { sourceMessageId: "ocm-1", status: "approved" },
            createdAt: NOW + 10,
          }),
          evt({
            id: "oce-run-1",
            harnessJobId: null,
            type: "assistant.run.succeeded",
            payload: {
              assistantRunId: "ocar-1",
              sourceMessageId: "ocm-1",
              model: "provider-a/model-a",
            },
            createdAt: NOW + 11,
          }),
          evt({
            id: "oce-plan-2",
            harnessJobId: null,
            type: "ai.plan.proposed",
            payload: { sourceMessageId: "ocm-2", status: "approved" },
            createdAt: NOW + 20,
          }),
        ]}
      />,
    );
    // two runs → two lanes, not one bucket and not three
    expect(occurrences(html, "对话推理")).toBe(2);
    expect(occurrences(html, "AI 计划")).toBe(2);
    expect(html).toContain("provider-a/model-a");
    expect(html).toContain("模型回复完成");
  });

  it("puts events with no derivable run into a single time-ordered 对话 lane", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[]}
        events={[
          evt({
            id: "oce-sess-2",
            harnessJobId: null,
            type: "session.updated",
            payload: { phase: "scope" },
            createdAt: NOW + 30,
          }),
          evt({
            id: "oce-sess-1",
            harnessJobId: null,
            type: "session.created",
            payload: { phase: "intake" },
            createdAt: NOW + 10,
          }),
        ]}
      />,
    );
    expect(occurrences(html, "对话推理")).toBe(0);
    expect(occurrences(html, ">对话<")).toBe(1);
    expect(html).toMatch(/class="[^"]*flowConv/);
    expect(html).not.toContain("undefined");
    // earliest first, same as the harness lane
    expect(html.indexOf("会话创建")).toBeLessThan(html.indexOf("会话更新"));
  });

  it("keeps harness jobs and assistant lanes in one chronological chain", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[job({ id: "ocj-late", kind: "scope", createdAt: NOW + 900 })]}
        events={[
          evt({
            id: "oce-early",
            harnessJobId: null,
            type: "assistant.run.failed",
            payload: { assistantRunId: "ocar-9", errorMessage: "早于作业" },
            createdAt: NOW + 5,
          }),
        ]}
      />,
    );
    expect(html).toContain("对话推理");
    expect(html).toContain("范围分析");
    expect(html.indexOf("对话推理")).toBeLessThan(html.indexOf("范围分析"));
  });

  it("still groups harness-job events by job when a conversation lane exists", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[job()]}
        events={[
          evt(),
          evt({
            id: "oce-conv",
            harnessJobId: null,
            type: "session.updated",
            payload: { phase: "build" },
            createdAt: NOW + 2000,
          }),
        ]}
      />,
    );
    expect(html).toContain("本体理解");
    expect(html).toContain("读取结构");
    expect(html).toContain("会话更新");
    // the harness event must not leak into the conversation lane
    expect(occurrences(html, "读取结构")).toBe(1);
  });
});

function sys(overrides: Partial<SystemCoverageItem> = {}): SystemCoverageItem {
  return {
    system: "GoHire_System",
    referencedByActions: ["processResume", "matchResume"],
    referencedVia: ["ontology"],
    profileId: "gohire-system",
    humanBoundary: false,
    runtimeProvided: false,
    hasTool: true,
    credentialProvider: "gohire",
    credentialConfigured: false,
    probeOk: null,
    probeAt: null,
    probeSupported: true,
    probeKind: "provider_health",
    availability: "live",
    plannedFallback: "block",
    ...overrides,
  };
}

describe("connectionStage", () => {
  it("ranks maturity from runtime down to unprofiled", () => {
    expect(connectionStage(sys({ runtimeProvided: true }))).toBe("runtime");
    expect(
      connectionStage(sys({ credentialConfigured: true, probeOk: true })),
    ).toBe("verified");
    expect(connectionStage(sys({ credentialConfigured: true }))).toBe(
      "configured",
    );
    expect(
      connectionStage(sys({ humanBoundary: true, credentialProvider: null })),
    ).toBe("boundary");
    expect(connectionStage(sys())).toBe("needsCredential");
    expect(connectionStage(sys({ credentialProvider: null }))).toBe(
      "needsProfile",
    );
  });
});

describe("SystemConnectionsView", () => {
  it("lists every referenced system, not just the blocking one", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="Agents-generation"
        rows={[
          sys(),
          sys({
            system: "Internal_Recruitment_System",
            credentialProvider: null,
            profileId: null,
            referencedByActions: ["processResume"],
          }),
          sys({ system: "LLM_Gateway", runtimeProvided: true }),
        ]}
        totals={{ referenced: 3, profiled: 1, humanBoundary: 0, unprofiled: 1 }}
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
        onOpenFactoryProfiles={() => {}}
      />,
    );
    expect(html).toContain("GoHire_System");
    expect(html).toContain("Internal_Recruitment_System");
    expect(html).toContain("LLM_Gateway");
    expect(html).toContain("配置 →");
    expect(html).toContain("运行时提供");
    expect(html).toContain("人工边界");
    expect(html).toContain("3 个系统");
    // 常驻术语段已删——只留跳转按钮
    expect(html).not.toContain("系统连接 ≠ Factory Integration Profile");
    expect(html).toContain("集成档案 →");
    // the system with no provider offers no fake configure button
    expect(html).toContain("待建档");
  });

  it("counts only successful probes as verified", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="Agents-generation"
        rows={[
          sys({
            system: "GoHire_System",
            credentialConfigured: true,
            probeOk: null,
          }),
          sys({
            system: "Allmeta_Ontology_System",
            credentialConfigured: true,
            probeOk: true,
          }),
          sys({
            system: "Local_Runtime",
            runtimeProvided: true,
            credentialProvider: null,
          }),
        ]}
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
      />,
    );
    expect(html).toContain("1 已验证");
    expect(html).toContain("已配置 · 未验证");
    expect(html).toContain("连接已验证");
    expect(html).toContain("运行时提供");
    expect(html).not.toContain("3 已连接");
  });

  it("treats env-only Allmeta as configured and offers its real read-only Ontology probe", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="Agents-generation"
        rows={[
          sys({
            system: "Allmeta_Ontology_System",
            credentialProvider: null,
            credentialConfigured: true,
            probeSupported: true,
            probeKind: "allmeta_ontology_read",
            configRequirement: {
              provider: null,
              posture: "env_only",
              satisfied: true,
              fields: [
                {
                  key: "allmeta_base_url",
                  label: "ALLMETA_BASE_URL",
                  kind: "env_only",
                  required: true,
                  satisfied: true,
                  envPresent: true,
                },
              ],
            },
          }),
        ]}
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
      />,
    );
    expect(html).toContain("已配置 · 未验证");
    expect(html).toContain("环境引用已就绪");
    expect(html).toContain("凭证值不会进入浏览器");
    expect(html).toContain("验证本体只读");
    expect(html).not.toContain("待建档");
  });

  it("does not render a guaranteed-to-fail probe button for another env-only profile", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="Agents-generation"
        rows={[
          sys({
            system: "Object_Storage_System",
            credentialProvider: null,
            credentialConfigured: true,
            probeSupported: false,
            probeKind: null,
            configRequirement: {
              provider: null,
              posture: "env_only",
              satisfied: true,
              fields: [],
            },
          }),
        ]}
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
      />,
    );
    expect(html).toContain("无探针");
    expect(html).not.toContain("测试连接");
    expect(html).not.toContain("验证本体只读");
  });

  it("reports a coverage failure instead of rendering an empty list", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="d"
        rows={[]}
        errorText="无法读取系统连接：403"
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
      />,
    );
    expect(html).toContain("403");
  });
});
