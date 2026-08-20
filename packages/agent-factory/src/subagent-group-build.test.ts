import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "./stream-gateway";

// Member sub-brains run through the mocked streamTurn; each concludes with a JSON design proposal.
const scriptedTurns: TurnEvent[][] = [];
vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* () {
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: '{"task":"fallback task"}' }];
      for (const event of events) yield event;
    },
  };
});

import { FACTORY_TOOLS } from "./tools";
import { __spawnSubagentGroupToolForTest as groupTool } from "./conductor";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

const readOntology = FACTORY_TOOLS.find((t) => t.name === "read_ontology")!;
const designAgent = FACTORY_TOOLS.find((t) => t.name === "design_agent")!;

function validOntology(): DomainOntology {
  return {
    domainId: "test",
    source: "allmeta",
    objects: [{ id: "Work", name: "Work", primary_key: "work_id", properties: [{ name: "work_id", type: "String" }, { name: "result", type: "String" }] }],
    rules: [],
    events: [
      { name: "WORK_REQUESTED", payload: { source_action: null, event_data: [{ name: "work_id", type: "String", target_object: "Work" }], state_mutations: [] } },
      { name: "WORK_DONE", payload: { source_action: "doWork", event_data: [{ name: "result", type: "String", target_object: "Work" }], state_mutations: [{ target_object: "Work", mutation_type: "MODIFY", impacted_properties: ["result"] }] } },
    ],
    actions: [{
      id: "a1", name: "doWork", actor: ["Agent"], trigger: ["WORK_REQUESTED"], triggered_event: ["WORK_DONE"], target_objects: ["Work"],
      tool_use: ["vendor.lookup"], system_prompt: "", user_prompt: "",
      inputs: [{ name: "work_id", type: "String", required: true, binding_kind: "event", event_field: "work_id", source_object: "Work.work_id" }],
      outputs: [{ name: "result", type: "String" }],
      action_steps: [{ id: "fetch", name: "fetch", type: "tool" }],
      integration: { systems: [{ name: "Vendor", kind: "external_api", role: "reads", capability: "GET /lookup", objects: ["Work"] }] },
    }],
    workflow: [{ id: "flow" }],
  } as unknown as DomainOntology;
}

function context(ontology: DomainOntology): BrainCtx {
  return {
    domain: "test", goal: "build", emit: () => {}, specs: [], ontology: null, currentPlan: null, toolCatalog: [], realTools: [],
    attemptHistory: {}, createdSkills: [], research: [], priorReflections: [], humanDirectives: [], lastSandbox: null, lastValidation: null,
    budget: { maxTokens: null, maxTurns: 20 }, spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    budgetLedger: { tokens: 0, spawns: 0, maxTokens: null, maxSpawns: 50 },
    ports: {
      ontology: { fetchOntology: async () => ontology, listDomains: async () => [], fetchActionRules: async () => [] },
      tools: { list: async () => [{ name: "vendor.lookup", description: "lookup", method: "GET", urlTemplate: "https://api.example.com/{work_id}", sideEffect: "read", operation: "read", effectScope: "external", sandboxPolicy: "live_external", domain: "test", capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["reads"], operations: ["lookup"], objectTypes: ["Work"] }], probeStatus: "verified" }], saveDraft: async () => ({ revisionId: "tvr-subagent-test", version: 1, definitionHash: "a".repeat(64), status: "draft" as const }) },
      toolRegistry: { list: async () => [] },
      skills: { list: async () => [], save: async () => {}, bumpUse: async () => {}, recordEval: async () => {} },
      // Member sub-brains run a full runBrain, which reads reflections at boot — required for build mode.
      reflection: { list: async () => [], record: async () => undefined },
      sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
      conversation: { has: async () => false, load: async () => null, save: async () => undefined, drainHumanMessages: async () => [] },
    },
  } as unknown as BrainCtx;
}

async function ctxWithParent(): Promise<BrainCtx> {
  const ctx = context(validOntology());
  await readOntology.execute({}, ctx);
  const designed = await designAgent.execute({
    action: "doWork",
    system_prompt: "按契约读取真实 Vendor 数据，并只输出本体声明字段。",
    decision_logic: "读取成功 emit WORK_DONE；失败按错误策略终止或重试。",
    tools: ["vendor.lookup"],
    plan: [{ stepId: "fetch", kind: "tool", tool: "vendor.lookup", idempotencyKeyFrom: "work_id", onError: "terminal" }],
  }, ctx);
  expect(designed.ok).toBe(true);
  return ctx;
}

describe("spawn_subagent_group — build mode (reason → group → deployable parent→child workflow)", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/group-model");
    vi.stubEnv("FACTORY_GROUP_CONCURRENCY", "1"); // deterministic member→scripted-turn pairing
    scriptedTurns.splice(0);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("each member designs one child; the tool serially lands them via design_subagent and wires the parent plan", async () => {
    const ctx = await ctxWithParent();
    const parent = ctx.specs.find((s) => s.actionName === "doWork")!;
    const planBefore = (parent.plan ?? []).length;
    scriptedTurns.push(
      [{ t: "done", content: '{"task":"process alpha input"}' }],
      [{ t: "done", content: '{"task":"process beta input"}' }],
    );

    const res = await groupTool.execute({
      reasoning: "把父 agent 拆成两个子 agent 并行落地",
      label: "doWork 拆解组",
      mode: "build",
      parent_action: "doWork",
      members: [{ role: "甲", task: "处理 alpha 分支" }, { role: "乙", task: "处理 beta 分支" }],
    }, ctx);

    expect(res.ok).toBe(true);
    // two children landed in ctx.specs…
    const children = ctx.specs.filter((s) => s.isSubAgent && s.parentAction === "doWork");
    expect(children).toHaveLength(2);
    // …and the parent plan gained one invoke step per child
    const invokeSteps = (parent.plan ?? []).filter((s) => s.kind === "invoke");
    expect(invokeSteps).toHaveLength(2);
    expect((parent.plan ?? []).length).toBeGreaterThan(planBefore);
    const out = res.output as { deployed: Array<{ ok: boolean }> };
    expect(out.deployed.every((d) => d.ok)).toBe(true);
  });

  it("refuses build mode without a parent_action, and with an unknown parent", async () => {
    const ctx = await ctxWithParent();
    const noParent = await groupTool.execute({ reasoning: "x", label: "g", mode: "build", members: [{ role: "甲", task: "a" }, { role: "乙", task: "b" }] }, ctx);
    expect(noParent.ok).toBe(false);
    expect(noParent.summary).toContain("parent_action");

    const badParent = await groupTool.execute({ reasoning: "x", label: "g", mode: "build", parent_action: "ghostParent", members: [{ role: "甲", task: "a" }, { role: "乙", task: "b" }] }, ctx);
    expect(badParent.ok).toBe(false);
    expect(badParent.summary).toContain("没找到");
  });

  it("refuses build mode from inside a spawned sub-brain (writes only happen in the top-level brain)", async () => {
    const ctx = await ctxWithParent();
    ctx.subagentDepth = 1; // pretend we're a nested sub-brain
    const res = await groupTool.execute({ reasoning: "x", label: "g", mode: "build", parent_action: "doWork", members: [{ role: "甲", task: "a" }, { role: "乙", task: "b" }] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("子脑内不能用 build");
  });
});
