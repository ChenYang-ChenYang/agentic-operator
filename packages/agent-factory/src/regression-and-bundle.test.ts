import { describe, expect, it } from "vitest";
import { keyVerdictsByCase, diffRegression } from "./regression-diff";
import { buildDeliveryBundle } from "./delivery-bundle";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx, BrainEvent } from "./brain-types";

describe("regression diff — pure verdict keying + per-case comparison", () => {
  it("keys verdicts by case name and falls back to kind#index on misalignment", () => {
    const keyed = keyVerdictsByCase(
      [{ name: "happy path" }, { name: "" }],
      [{ kind: "pass", pass: true, reason: "ok" }, { kind: "fault", pass: false, reason: "leaked success" }, { kind: "edge", pass: true, reason: "extra" }],
    );
    expect(Object.keys(keyed)).toEqual(["happy path", "fault#1", "edge#2"]);
    expect(keyed["fault#1"]).toMatchObject({ pass: false, kind: "fault" });
  });

  it("classifies fixed / regressed / still-failing / new — never counts a new case as a fix", () => {
    const baseline = {
      a: { pass: false, kind: "pass", reason: "" },
      b: { pass: true, kind: "pass", reason: "" },
      c: { pass: false, kind: "fault", reason: "" },
    };
    const current = {
      a: { pass: true, kind: "pass", reason: "" },   // fixed
      b: { pass: false, kind: "pass", reason: "" },  // regressed
      c: { pass: false, kind: "fault", reason: "" }, // still failing
      d: { pass: true, kind: "edge", reason: "" },   // new
    };
    expect(diffRegression(baseline, current)).toEqual({ fixed: ["a"], regressed: ["b"], stillFailing: ["c"], newCases: ["d"] });
    // no baseline → everything is new (first replay establishes the baseline)
    expect(diffRegression(undefined, current).newCases).toHaveLength(4);
  });
});

describe("run_regression tool — guards", () => {
  const runRegression = FACTORY_TOOLS.find((t) => t.name === "run_regression")!;
  it("refuses without specs or without an approved suite", async () => {
    const bare = { specs: [], testCases: [], emit: () => {} } as unknown as BrainCtx;
    expect((await runRegression.execute({}, bare)).summary).toContain("还没有已设计");
    const noSuite = { specs: [{ actionName: "a" }], testCases: [], emit: () => {} } as unknown as BrainCtx;
    expect((await runRegression.execute({}, noSuite)).summary).toContain("测试用例");
  });
});

describe("delivery bundle — honest one-artifact packaging", () => {
  const specs = [
    {
      actionName: "classifyTicket", nameZh: "工单分类专家", slug: "classify", short: "classify", trigger: ["TICKET_LOGGED"], emit: ["TICKET_CLASSIFIED"],
      tools: [], unresolvedTools: [], inputSchema: [{ field: "content", type: "String" }], outputSchema: [{ field: "category", type: "String" }],
      systemPrompt: "分类", decisionLogic: "分类后 emit", designReasoning: "读正文判断分类", generatedCode: "line1\nline2", codeExecuted: true,
    },
    {
      actionName: "draftReply", nameZh: "答复起草员", slug: "draft", short: "draft", trigger: ["RISK_ASSESSED"], emit: ["REPLY_DRAFTED"],
      tools: ["crm.send"], unresolvedTools: ["ghost.tool"], inputSchema: [], outputSchema: [], systemPrompt: "起草", decisionLogic: "起草后 emit",
    },
    { actionName: "classifyTicket__helper", nameZh: "子", slug: "classify-sub-x", short: "classify-sub-x", trigger: [], emit: [], tools: [], isSubAgent: true, parentAction: "classifyTicket", parentTask: "辅助", systemPrompt: "", decisionLogic: "" },
  ] as unknown as BrainCtx["specs"];

  const base = {
    domain: "fleetlab", specs,
    lastValidation: { ok: true, issues: [] },
    boundaryEvents: [{ event: "REPLY_DRAFTED", kind: "external", consumer: "客服系统", payloadContract: "{ticket_id, reply}" }],
    testCases: [], regressionBaseline: { fingerprint: "f", at: 1, verdicts: { "happy": { pass: true, kind: "pass", reason: "" }, "fault": { pass: false, kind: "fault", reason: "x" } } },
  } as unknown as Parameters<typeof buildDeliveryBundle>[0];

  it("packs agent cards, validation, REAL sandbox receipts, regression, external contracts", () => {
    const bundle = buildDeliveryBundle({
      ...base,
      lastSandbox: { specsFingerprint: "f", deployed: 2, agentsRan: 2, ranAgents: ["classify", "draft"], reachedTerminal: true, reachedSuccessTerminal: true, fullChainRan: true, codeRanAgents: ["classify"], degradedAgents: [], simulated: false } as never,
    });
    expect(bundle).toContain("# 交付包 · fleetlab");
    expect(bundle).toContain("工单分类专家（classifyTicket）");
    expect(bundle).toContain("↳ 子 agent classify-sub-x");
    expect(bundle).toContain("✅ 真实 Inngest 部署运行");
    expect(bundle).toContain("1/2 用例通过");
    expect(bundle).toContain("**REPLY_DRAFTED** → 消费方: 客服系统");
    // honesty: unresolved tool is a declared caveat
    expect(bundle).toContain("draftReply 有未解析工具");
  });

  it("labels a simulated run and a missing sandbox honestly — never launders evidence", () => {
    const simulated = buildDeliveryBundle({ ...base, lastSandbox: { specsFingerprint: "f", deployed: 2, agentsRan: 2, ranAgents: [], reachedTerminal: false, reachedSuccessTerminal: false, fullChainRan: false, degradedAgents: [], simulated: true } as never });
    expect(simulated).toContain("模拟运行");
    expect(simulated).toContain("不构成交付证据");
    const none = buildDeliveryBundle({ ...base, lastSandbox: null });
    expect(none).toContain("无沙箱证据");
  });
});

describe("ask_user_batch — one park for a batch of decisions", () => {
  const askBatch = FACTORY_TOOLS.find((t) => t.name === "ask_user_batch")!;
  const ctx = () => {
    const events: BrainEvent[] = [];
    return Object.assign({ specs: [], emit: (e: BrainEvent) => events.push(e) } as unknown as BrainCtx, { __events: events });
  };

  it("composes numbered items with starred recommendations into ONE clarify park", async () => {
    const c = ctx();
    const res = await askBatch.execute({ items: [
      { question: "assessRisk 接哪个集成？", options: [{ label: "接 rulehub", value: "rulehub", recommended: true }, { label: "先跳过", value: "skip" }] },
      { question: "CRM_KEY 用哪个环境变量？", context: "draftReply 需要真实凭证" },
    ] }, c);
    expect(res.ok).toBe(true);
    expect(c.awaitingClarify).toBe(true);
    expect(c.clarifyPrompt?.question).toContain("**1. assessRisk 接哪个集成？**");
    expect(c.clarifyPrompt?.question).toContain("A. 接 rulehub ★推荐");
    expect(c.clarifyPrompt?.question).toContain("**2. CRM_KEY 用哪个环境变量？**");
    expect(c.clarifyPrompt?.question).toContain("（自由回答）");
    const events = (c as unknown as { __events: BrainEvent[] }).__events;
    const clarification = events.find(
      (e): e is Extract<BrainEvent, { t: "clarify" }> => e.t === "clarify",
    );
    expect(clarification?.awaitingAnswer).toBe(true);
    expect(clarification?.items).toHaveLength(2);
    expect(clarification?.items?.[0]).toMatchObject({
      question: "assessRisk 接哪个集成？",
      options: [
        {
          label: "接 rulehub",
          value: "rulehub",
          recommended: true,
        },
        { label: "先跳过", value: "skip" },
      ],
    });
    expect(clarification?.items?.[1]).toMatchObject({
      question: "CRM_KEY 用哪个环境变量？",
      context: "draftReply 需要真实凭证",
    });
  });

  it("guards: <2 items refused; authorization tokens firewalled; duplicate batch replayed", async () => {
    const c = ctx();
    expect((await askBatch.execute({ items: [{ question: "只有一项" }] }, c)).ok).toBe(false);
    const fw = await askBatch.execute({ items: [
      { question: "确认探测？", options: [{ label: "确认", value: `authorize_probe:v2:${"a".repeat(64)}` }, { label: "否", value: "no" }] },
      { question: "另一项" },
    ] }, c);
    expect(fw.ok).toBe(false);
    expect(fw.summary).toContain("授权问题");

    const c2 = ctx();
    await askBatch.execute({ items: [{ question: "甲？" }, { question: "乙？" }] }, c2);
    const key = Object.keys(c2.askedQuestions ?? {})[0]!;
    c2.askedQuestions![key] = "甲选A；乙选B";
    const replay = await askBatch.execute({ items: [{ question: "甲？" }, { question: "乙？" }] }, c2);
    expect(replay.ok).toBe(true);
    expect(replay.summary).toContain("问过了");
  });
});
