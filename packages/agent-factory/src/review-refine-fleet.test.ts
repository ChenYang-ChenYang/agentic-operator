import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "./stream-gateway";

// review_fleet / refine_fleet — members are REAL runBrain sub-brains through the mocked streamTurn;
// refine landing goes through the REAL refine_agent (snapshot + score bookkeeping untouched).
const scriptedTurns: TurnEvent[][] = [];
const seenTurns: Array<Array<{ content: unknown }>> = [];
vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: Array<{ content: unknown }>) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "{}" }];
      for (const event of events) yield event;
    },
  };
});

import { FACTORY_TOOLS } from "./tools";
import { __designFleetToolForTest as designFleet, __reviewFleetToolForTest as reviewFleet, __refineFleetToolForTest as refineFleet } from "./conductor";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology, OntologyAction, OntologyEvent } from "./ontology-types";

const readOntology = FACTORY_TOOLS.find((t) => t.name === "read_ontology")!;

function actionTriplet(n: { action: string; req: string; done: string }): { action: OntologyAction; events: OntologyEvent[] } {
  return {
    action: {
      id: n.action, name: n.action, actor: ["Agent"], trigger: [n.req], triggered_event: [n.done], target_objects: ["Work"],
      tool_use: [], system_prompt: "", user_prompt: "",
      inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" }],
      outputs: [{ name: "result", type: "String" }],
      action_steps: [], integration: { systems: [] },
    } as unknown as OntologyAction,
    events: [
      { name: n.req, payload: { source_action: null, event_data: [{ name: "work_id", type: "String", target_object: "Work" }], state_mutations: [] } },
      { name: n.done, payload: { source_action: n.action, event_data: [{ name: "work_id", type: "String", target_object: "Work" }, { name: "result", type: "String", target_object: "Work" }], state_mutations: [] } },
    ] as OntologyEvent[],
  };
}

function ontology(): DomainOntology {
  const a = actionTriplet({ action: "alphaWork", req: "ALPHA_REQ", done: "ALPHA_DONE" });
  const b = actionTriplet({ action: "betaWork", req: "BETA_REQ", done: "BETA_DONE" });
  return {
    domainId: "t", source: "snapshot", workflow: [{ id: "flow" }], rules: [],
    objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
    actions: [a.action, b.action], events: [...a.events, ...b.events],
  } as unknown as DomainOntology;
}

function context(ont: DomainOntology): BrainCtx & { __events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  return {
    domain: "t", goal: "g", emit: (e: BrainEvent) => events.push(e), specs: [], ontology: null,
    currentPlan: { summary: "s", agents: [], notes: [], version: 1 },
    toolCatalog: [], realTools: [], attemptHistory: {}, createdSkills: [], research: [], priorReflections: [], humanDirectives: [],
    lastSandbox: null, lastValidation: null,
    budget: { maxTokens: null, maxTurns: 20 }, spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    budgetLedger: { tokens: 0, spawns: 0, maxTokens: null, maxSpawns: 50 },
    ports: {
      ontology: { fetchOntology: async () => ont, listDomains: async () => [], fetchActionRules: async () => [] },
      tools: { list: async () => [], saveDraft: async () => ({ revisionId: "tvr-review-test", version: 1, definitionHash: "a".repeat(64), status: "draft" as const }) },
      toolRegistry: { list: async () => [] },
      skills: { list: async () => [], save: async () => {}, bumpUse: async () => {}, recordEval: async () => {} },
      reflection: { list: async () => [], record: async () => undefined },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: { has: async () => false, load: async () => null, save: async () => undefined, drainHumanMessages: async () => [] },
    },
    __events: events,
  } as unknown as BrainCtx & { __events: BrainEvent[] };
}

const designProposal = JSON.stringify({
  system_prompt: "你按事件契约完成本步处理，只输出声明字段。",
  decision_logic: "成功 emit 完成事件；失败按错误策略终止。",
  tools: [],
});

async function seedTwoSpecs(ctx: BrainCtx): Promise<void> {
  await readOntology.execute({}, ctx);
  scriptedTurns.push([{ t: "done", content: designProposal }], [{ t: "done", content: designProposal }]);
  const res = await designFleet.execute({ reasoning: "seed", actions: ["alphaWork", "betaWork"] }, ctx);
  expect(res.ok).toBe(true);
  expect(ctx.specs.filter((s) => !s.isSubAgent)).toHaveLength(2);
}

describe("review_fleet — parallel three-lens review, advisory aggregation", () => {
  beforeEach(() => { vi.stubEnv("FACTORY_AI_MODEL", "test/m"); vi.stubEnv("FACTORY_GROUP_CONCURRENCY", "1"); scriptedTurns.splice(0); seenTurns.splice(0); });
  afterEach(() => vi.unstubAllEnvs());

  it("reviews every designed agent, aggregates findings, flags high severity, and never mutates specs", async () => {
    const ctx = context(ontology());
    await seedTwoSpecs(ctx);
    const before = JSON.stringify(ctx.specs);
    scriptedTurns.push(
      [{ t: "done", content: JSON.stringify({ findings: [{ lens: "context", severity: "high", issue: "输出 result 未映射到 ALPHA_DONE 字段", fix: "补输出映射" }] }) }],
      [{ t: "done", content: JSON.stringify({ findings: [] }) }],
    );
    const res = await reviewFleet.execute({ reasoning: "批量体检" }, ctx);
    expect(res.ok).toBe(true);
    const out = res.output as { reviews: Array<{ action: string; findings: unknown[] }>; flagged: string[] };
    expect(out.reviews).toHaveLength(2);
    expect(out.flagged).toEqual(["alphaWork"]);
    expect(res.summary).toContain("refine_fleet");
    expect(JSON.stringify(ctx.specs)).toBe(before); // advisory: zero spec mutation
    // members were provisioned INLINE with the spec + action briefs
    const memberPrompt = seenTurns.flat().map((m) => String(m.content ?? "")).join("\n");
    expect(memberPrompt).toContain("【当前 spec · alphaWork");
    expect(memberPrompt).toContain("【动作简报 · alphaWork】");
    const events = (ctx as unknown as { __events: BrainEvent[] }).__events;
    expect(events.find((e): e is Extract<BrainEvent, { t: "group.start" }> => e.t === "group.start" && e.mode === "review")).toBeTruthy();
  });

  it("refuses when nothing is designed yet and marks unparseable member output without failing the fleet", async () => {
    const ctx = context(ontology());
    await readOntology.execute({}, ctx);
    const none = await reviewFleet.execute({ reasoning: "x" }, ctx);
    expect(none.ok).toBe(false);
    expect(none.summary).toContain("先 design_agent");

    await seedTwoSpecs(ctx);
    scriptedTurns.push([{ t: "done", content: "这个 agent 看起来还行。" }], [{ t: "done", content: JSON.stringify({ findings: [] }) }]);
    const res = await reviewFleet.execute({ reasoning: "x" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("无法解析");
  });
});

describe("refine_fleet — parallel patches, serial landing through the real refine_agent", () => {
  beforeEach(() => { vi.stubEnv("FACTORY_AI_MODEL", "test/m"); vi.stubEnv("FACTORY_GROUP_CONCURRENCY", "1"); scriptedTurns.splice(0); seenTurns.splice(0); });
  afterEach(() => vi.unstubAllEnvs());

  it("lands two patches with refine_agent bookkeeping (attempt history + prompt change) intact", async () => {
    const ctx = context(ontology());
    await seedTwoSpecs(ctx);
    const patch = (marker: string) => JSON.stringify({
      critique: `输出映射缺失（${marker}）`,
      system_prompt: `修订版系统提示 ${marker}：按事件契约处理并把 result 映射到完成事件字段。`,
    });
    scriptedTurns.push([{ t: "done", content: patch("alpha") }], [{ t: "done", content: patch("beta") }]);

    const res = await refineFleet.execute({ reasoning: "并行修", items: [
      { action: "alphaWork", problem: "review 指出输出未映射" },
      { action: "betaWork", problem: "同上" },
    ] }, ctx);

    expect(res.ok).toBe(true);
    const out = res.output as { landed: string[]; rejected: unknown[] };
    expect(out.landed).toEqual(["alphaWork", "betaWork"]);
    expect(out.rejected).toEqual([]);
    // the REAL refine_agent applied the patch + kept history
    const alpha = ctx.specs.find((s) => s.actionName === "alphaWork")!;
    expect(alpha.systemPrompt).toContain("修订版系统提示 alpha");
    expect(ctx.attemptHistory["alphaWork"]?.length).toBeGreaterThanOrEqual(1);
    expect(res.summary).toContain("重新 sandbox_run");
    const memberPrompt = seenTurns.flat().map((m) => String(m.content ?? "")).join("\n");
    expect(memberPrompt).toContain("源 kind=logic 的路由选择步必须继续是 logic");
    expect(memberPrompt).not.toContain("写成 dependsOn 一个 kind=condition 步");
  });

  it("parks the fleet with one aggregated ask_user question when a refinement needs a real tool", async () => {
    const ctx = context(ontology());
    await seedTwoSpecs(ctx);
    scriptedTurns.push(
      [{ t: "done", content: JSON.stringify({ critique: "需要新增外部写入", tools: ["ghost.write"] }) }],
      [{ t: "done", content: JSON.stringify({ critique: "补充决策说明", decision_logic: "成功后产出 BETA_DONE；失败终止。" }) }],
    );

    const res = await refineFleet.execute({ reasoning: "并行修", items: [
      { action: "alphaWork", problem: "需要外部写入" },
      { action: "betaWork", problem: "决策说明不足" },
    ] }, ctx);

    expect(res.ok).toBe(true);
    expect(res.output).toMatchObject({
      landed: ["betaWork"],
      next: "ask_user",
      reason: "fleet_refinements_require_authoritative_input",
      needsUser: [{ action: "alphaWork" }],
    });
    expect((res.output as { question: string }).question).toContain("alphaWork");
    expect(ctx.specs.find((spec) => spec.actionName === "alphaWork")?.tools).toEqual([]);
  });

  it("guards: <2 items, unknown action, missing critique in a member patch", async () => {
    const ctx = context(ontology());
    await seedTwoSpecs(ctx);
    expect((await refineFleet.execute({ reasoning: "x", items: [{ action: "alphaWork", problem: "p" }] }, ctx)).ok).toBe(false);
    expect((await refineFleet.execute({ reasoning: "x", items: [{ action: "ghost", problem: "p" }, { action: "alphaWork", problem: "p" }] }, ctx)).summary).toContain("ghost");

    scriptedTurns.push([{ t: "done", content: JSON.stringify({ system_prompt: "改了但没写根因" }) }], [{ t: "done", content: JSON.stringify({ critique: "根因", decision_logic: "修订决策" }) }]);
    const res = await refineFleet.execute({ reasoning: "x", items: [
      { action: "alphaWork", problem: "p1" }, { action: "betaWork", problem: "p2" },
    ] }, ctx);
    expect(res.ok).toBe(true); // beta landed
    const out = res.output as { landed: string[]; rejected: Array<{ action: string; reason: string }> };
    expect(out.landed).toEqual(["betaWork"]);
    expect(out.rejected[0]).toMatchObject({ action: "alphaWork" });
    expect(out.rejected[0]!.reason).toContain("critique");
  });
});
