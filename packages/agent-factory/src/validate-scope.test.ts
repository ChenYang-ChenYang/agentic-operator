import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import { stageAdmission } from "./conductor";
import type { BrainCtx } from "./brain-types";

// #SCOPE 回归 —— 真实死锁：用户说「只把 createJD 写出来，跑通给我看」时，AI 【永远】拿不到沙箱验证。
//
// 链条：create_plan(scope=partial) → design 1 个 → validate_graph 的 coverageGap 按【整本体】判
// → gap = 用户明确不要的另外 2 个 → ok=false → ctx.lastValidation={ok:false}
// → stageAdmission 拒绝 sandbox_run（要求 lastValidation.ok===true）→ 死锁：AI 怎么修都过不去，
// 因为"缺陷"正是用户不要的东西。finish 早就认 planScope 了，validate_graph 没有。

const validateGraph = FACTORY_TOOLS.find((t) => t.name === "validate_graph")!;
const listAgents = FACTORY_TOOLS.find((t) => t.name === "list_agents")!;
const reviewCompleteness = FACTORY_TOOLS.find((t) =>
  t.name === "review_completeness")!;

const ontology = {
  domainId: "rec",
  actions: [
    {
      id: "createJD", name: "createJD", actor: ["Agent"],
      trigger: ["REQUIREMENT_LOGGED"], triggered_event: ["JD_CREATED"],
      target_objects: [], tool_use: [], action_steps: [], system_prompt: "", user_prompt: "",
    },
    {
      id: "processResume", name: "processResume", actor: ["Agent"],
      trigger: ["RESUME_UPLOADED"], triggered_event: ["RESUME_PROCESSED"],
      target_objects: [], tool_use: [], action_steps: [], system_prompt: "", user_prompt: "",
    },
    {
      id: "matchResume", name: "matchResume", actor: ["Agent"],
      trigger: ["RESUME_PROCESSED"], triggered_event: ["MATCH_DONE"],
      target_objects: [], tool_use: [], action_steps: [], system_prompt: "", user_prompt: "",
    },
  ],
  events: [
    { name: "REQUIREMENT_LOGGED" }, { name: "JD_CREATED" },
    { name: "RESUME_UPLOADED" }, { name: "RESUME_PROCESSED" }, { name: "MATCH_DONE" },
  ],
  objects: [],
  rules: [],
  workflow: [],
  source: "snapshot",
};

/** 一个设计完整、无降级、工具已解析的 createJD spec —— 范围内本身是合格的。 */
const createJdSpec = {
  actionName: "createJD",
  slug: "create-jd",
  short: "createJD",
  nameZh: "生成JD",
  trigger: ["REQUIREMENT_LOGGED"],
  emit: ["JD_CREATED"],
  tools: [],
  systemPrompt: "你负责生成 JD",
  generatedCode: "export const createJdAgent = {}",
  degraded: false,
  unresolvedTools: [],
};

const ctxOf = (planScope?: BrainCtx["planScope"]): BrainCtx =>
  ({
    ontology,
    domain: "rec",
    specs: [createJdSpec],
    toolCatalog: [],
    emit: () => undefined,
    boundaryEvents: [],
    ...(planScope ? { planScope } : {}),
  }) as unknown as BrainCtx;

describe("validate_graph 的覆盖门必须认 planScope（否则部分范围永远无法验证）", () => {
  it("server generation scope 是完整验收全集，且跨未选 Action 的事件按范围边界闭合", async () => {
    const scopedOntology = {
      ...ontology,
      actions: [
        ontology.actions[0],
        {
          ...ontology.actions[1],
          trigger: ["JD_CREATED"],
          triggered_event: ["RESUME_PROCESSED"],
        },
        ontology.actions[2],
      ],
    };
    const ctx = {
      ...ctxOf(),
      ontology: scopedOntology,
      generationDirective: {
        schema: "agent-factory-generation-directive/v1",
        mode: "action_selection",
        requestedActionIds: ["createJD"],
        requestedActionNames: ["createJD"],
        requestedActions: [{ id: "createJD", name: "createJD" }],
        sourceOntologyHash: "a".repeat(64),
      },
    } as unknown as BrainCtx;

    const result = await validateGraph.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.lastValidation?.ok).toBe(true);
    expect(stageAdmission("sandbox_run", ctx)).toBeNull();
    expect((result.output as { coverageGap: string[] }).coverageGap).toEqual([]);
    const issueText = ((result.output as { issues: string[] }).issues).join("\n");
    expect(issueText).toContain("processResume");
    expect(issueText).toContain("不在本次范围");
    expect(issueText).not.toContain("缺少 agent 的动作");

    const progress = await listAgents.execute({}, ctx);
    expect(progress.output).toMatchObject({
      remaining: [],
      designed: 1,
      total: 1,
    });
    const review = await reviewCompleteness.execute({}, ctx);
    expect((review.output as { deterministic: string[] }).deterministic)
      .not.toEqual(expect.arrayContaining([
        expect.stringContaining("processResume"),
      ]));
  });

  it("session-local virtual Action is the sole dynamic acceptance scope", async () => {
    const virtualAction = {
      id: "virtual-action-abc",
      name: "virtualScenario_ABC",
      actor: ["Agent"],
      trigger: ["SCENARIO_REQUESTED"],
      triggered_event: ["SCENARIO_COMPLETED"],
      target_objects: [],
      tool_use: [],
      action_steps: [],
      system_prompt: "",
      user_prompt: "",
      factoryProvenance: {
        schema: "agent-factory-virtual-action/v1",
        kind: "virtual_scenario",
        source: "factory_session_overlay",
        authoritative: false,
        scenarioHash: "b".repeat(64),
      },
    } as const;
    const virtualSpec = {
      ...createJdSpec,
      actionName: virtualAction.name,
      slug: "virtual-scenario-abc",
      short: "VirtualScenarioAgent",
      nameZh: "场景 Agent",
      trigger: [...virtualAction.trigger],
      emit: [...virtualAction.triggered_event],
    };
    const ctx = {
      ...ctxOf(),
      ontology: {
        ...ontology,
        actions: [...ontology.actions, virtualAction],
        events: [
          ...ontology.events,
          { name: "SCENARIO_REQUESTED" },
          { name: "SCENARIO_COMPLETED" },
        ],
      },
      specs: [virtualSpec],
      generationDirective: {
        schema: "agent-factory-generation-directive/v1",
        mode: "virtual_scenario",
        requestedActionIds: [virtualAction.id],
        requestedActionNames: [virtualAction.name],
        requestedActions: [{
          id: virtualAction.id,
          name: virtualAction.name,
        }],
        sourceOntologyHash: "c".repeat(64),
        scenario: "处理一个当前 Ontology 没有的场景",
        virtualAction,
      },
    } as unknown as BrainCtx;

    const result = await validateGraph.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect((result.output as { coverageGap: string[] }).coverageGap).toEqual([]);
    const progress = await listAgents.execute({}, ctx);
    expect(progress.output).toMatchObject({
      remaining: [],
      designed: 1,
      total: 1,
    });
  });

  it("partial 范围：范围外的动作不算缺陷 → 能通过 → sandbox_run 放行（死锁解除）", async () => {
    const ctx = ctxOf({ kind: "partial", reason: "用户只要 createJD", missedActions: ["processResume", "matchResume"] });
    const r = await validateGraph.execute({}, ctx);

    expect(r.ok).toBe(true);
    expect(ctx.lastValidation?.ok).toBe(true);
    // 关键：这一步过去恒为拒绝，AI 永远拿不到真实沙箱证据。
    expect(stageAdmission("sandbox_run", ctx)).toBeNull();

    // 范围外的动作仍然【作为事实】被说出来（不是静默丢弃）——AI 自己判断要不要扩范围。
    const issues = (r.output as { issues?: string[] }).issues ?? [];
    const text = issues.join("\n");
    expect(text).toContain("不在本次范围内");
    expect(text).toContain("processResume");
    expect(text).not.toContain("缺少 agent 的动作"); // 不再伪装成缺陷
  });

  it("没有 planScope（默认全量）：少设计的动作仍然是真缺陷 → 拒绝放行（证据门没被削弱）", async () => {
    const ctx = ctxOf();
    const r = await validateGraph.execute({}, ctx);

    expect(r.ok).toBe(false);
    expect(ctx.lastValidation?.ok).toBe(false);
    expect(stageAdmission("sandbox_run", ctx)).toContain("阶段闸门");
    const issues = (r.output as { issues?: string[] }).issues ?? [];
    expect(issues.join("\n")).toContain("缺少 agent 的动作");
  });

  it("partial 范围内【自己】没设计完 → 仍然 ok=false（标 partial 不能用来逃避范围内的覆盖）", async () => {
    // 用户要 createJD + processResume，但只设计了 createJD → 范围内仍缺一个。
    const ctx = ctxOf({ kind: "partial", reason: "用户要两个", missedActions: ["matchResume"] });
    const r = await validateGraph.execute({}, ctx);

    expect(r.ok).toBe(false);
    expect(ctx.lastValidation?.ok).toBe(false);
    const issues = (r.output as { issues?: string[] }).issues ?? [];
    expect(issues.join("\n")).toContain("processResume"); // 范围内缺的，照样报缺陷
  });
});
