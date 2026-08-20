import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

// #FACTORY-SMOKE (P0-3) — the full-brainLoop wiring test. Every piece is REAL except the LLM: the
// conductor's gates, the intent gate + policy router, stage admission, design_fleet fan-out/landing,
// validate_graph — driven end-to-end by scripted turns. This locks in CI exactly the journey the live
// run exercised (including the stage-gate refusal + recovery), so wiring regressions (buffer drains,
// gate ordering, fleet plumbing) never need a paid live run to surface again.
const scriptedTurns: TurnEvent[][] = [];
const seenTurns: ChatMsg[][] = [];
vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => true,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "done" }];
      for (const event of events) yield event;
    },
    chatOnce: async (_s: string, _u: string, o?: { purpose?: string }) => {
      if (o?.purpose === "specialist:intent") return "[生成] 为本域生成全部 agent ｜ 约束: 无 ｜ 期望产物: 可运行的智能体代码";
      return `[${o?.purpose}]`;
    },
    // A scripted test must NEVER reach the network. isGatewayConfigured is mocked true (so gated
    // paths run), which also arms design_agent's inner self-refine — its chatJson/chatJsonResult
    // must be stubbed too or the fleet landing hangs ~20s on a real fetch (live regression).
    chatJson: async () => null,
    chatJsonResult: async () => ({ ok: false as const, failure: "model_no_json" as const, detail: "mocked" }),
  };
});

import { runBrain } from "./conductor";
import type { BrainEvent } from "./brain-types";
import type { FactoryPorts } from "./ports";
import type { DomainOntology, OntologyAction, OntologyEvent } from "./ontology-types";

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
  const a = actionTriplet({ action: "stepOne", req: "ONE_REQ", done: "ONE_DONE" });
  const b = actionTriplet({ action: "stepTwo", req: "ONE_DONE", done: "TWO_DONE" });
  const c = actionTriplet({ action: "stepThree", req: "TWO_DONE", done: "THREE_DONE" });
  // chain consumers/producers stay symmetric with triggers/emits
  a.events[1]!.consumers = ["stepTwo"]; a.events[1]!.producers = ["stepOne"];
  b.events[1]!.consumers = ["stepThree"]; b.events[1]!.producers = ["stepTwo"];
  c.events[1]!.producers = ["stepThree"];
  return {
    domainId: "smoke", source: "snapshot", workflow: [{ id: "flow" }], rules: [],
    objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
    actions: [a.action, b.action, c.action],
    events: [a.events[0]!, a.events[1]!, b.events[1]!, c.events[1]!],
  } as unknown as DomainOntology;
}

const ports = (): FactoryPorts => ({
  ontology: { fetchOntology: async () => ontology(), listDomains: async () => [], fetchActionRules: async () => [] },
  sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
  reflection: { list: async () => [], record: async () => undefined },
  conversation: { has: async () => false, load: async () => null, save: async () => undefined, drainHumanMessages: async () => [] },
} as unknown as FactoryPorts);

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args: JSON.stringify(args) });
const proposal = JSON.stringify({
  system_prompt: "你负责按事件契约完成本步处理，只输出本体声明字段。",
  decision_logic: "处理成功 emit 声明的完成事件；输入缺失则按错误策略终止。",
  tools: [],
  role_name: "链路工人",
});

describe("factory smoke — the whole brainLoop journey with a fleet (scripted turns)", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/smoke-model");
    vi.stubEnv("FACTORY_GROUP_CONCURRENCY", "1");
    scriptedTurns.splice(0); seenTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("intent→policy→read→(fleet refused by stage gate)→plan→fleet lands 3→validate→done", async () => {
    scriptedTurns.push(
      // turn 1: read the ontology
      [{ t: "tool_calls", content: "", calls: [call("c1", "read_ontology", {})] }],
      // turn 2: premature fleet — MUST be refused by the stage admission gate (no plan yet)
      [{ t: "tool_calls", content: "", calls: [call("c2", "design_fleet", { reasoning: "并行", actions: ["stepOne", "stepTwo", "stepThree"] })] }],
      // turn 3: create the plan
      [{ t: "tool_calls", content: "", calls: [call("c3", "create_plan", { summary: "三步链", agents: [
        { actionName: "stepOne", role: "工人A" }, { actionName: "stepTwo", role: "工人B" }, { actionName: "stepThree", role: "工人C" },
      ] })] }],
      // turn 4: fleet again — now admitted; its 3 members consume the next 3 scripted turns
      [{ t: "tool_calls", content: "", calls: [call("c4", "design_fleet", { reasoning: "并行", actions: ["stepOne", "stepTwo", "stepThree"] })] }],
      [{ t: "done", content: proposal }], // member: stepOne
      [{ t: "done", content: proposal }], // member: stepTwo
      [{ t: "done", content: proposal }], // member: stepThree
      // turn 5: validate the graph
      [{ t: "tool_calls", content: "", calls: [call("c5", "validate_graph", {})] }],
      // turn 6: brain wraps up in plain text (no finish — no sandbox evidence yet)
      [{ t: "done", content: "3 个 agent 已并行设计落地并通过静态校验。要继续 sandbox_run 验证请告诉我。" }],
    );

    const events: BrainEvent[] = [];
    for await (const ev of runBrain({ domain: "smoke", goal: "为本域生成全部 3 个 agent，动作独立请用 design_fleet 并行设计", ports: ports(), conversationId: "smoke-conv" })) {
      events.push(ev);
    }

    // ① intent gate + policy routed to the FULL pipeline
    expect(events.find((e): e is Extract<BrainEvent, { t: "policy" }> => e.t === "policy")?.pipeline).toBe("full");
    // ② premature fleet was refused by the stage gate, with the steer naming create_plan
    const fleetResults = events.filter((e): e is Extract<BrainEvent, { t: "tool.result" }> => e.t === "tool.result" && e.name === "design_fleet");
    expect(fleetResults).toHaveLength(2);
    expect(fleetResults[0]!.ok).toBe(false);
    expect(fleetResults[0]!.summary).toContain("阶段闸门");
    expect(fleetResults[0]!.summary).toContain("create_plan");
    // ③ after create_plan the fleet ran: group tree + THREE real landings through design_agent
    const start = events.find((e): e is Extract<BrainEvent, { t: "group.start" }> => e.t === "group.start");
    expect(start).toMatchObject({ mode: "design", members: 3 });
    const created = events.filter((e) => e.t === "agent.created");
    expect(created).toHaveLength(3);
    expect(events.find((e): e is Extract<BrainEvent, { t: "group.done" }> => e.t === "group.done")).toMatchObject({ ok: 3, total: 3 });
    expect(fleetResults[1]!.ok).toBe(true);
    // ④ members were briefed INLINE (#ACTION-BRIEF): each member turn's prompt carries the brief,
    //    so members need no read_ontology round-trip of their own
    const memberTurns = seenTurns.filter((t) => t.some((m) => typeof m.content === "string" && m.content.includes("【动作简报 ·")));
    expect(memberTurns.length).toBeGreaterThanOrEqual(3);
    const memberPrompt = memberTurns
      .flatMap((turn) => turn.map((message) => String(message.content ?? "")))
      .join("\n");
    expect(memberPrompt).toContain("结构化 integration");
    expect(memberPrompt).toContain("每个顶层 tool/invoke");
    expect(memberPrompt).toContain("禁止把 emit 改成 condition");
    expect(memberPrompt).toContain("不要再提交 decision_tables");
    // ⑤ validate_graph really ran against the landed specs
    const validation = events.find((e): e is Extract<BrainEvent, { t: "validation" }> => e.t === "validation");
    expect(validation).toBeTruthy();
    // ⑥ clean end
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });
});
