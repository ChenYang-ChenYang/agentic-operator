import { describe, expect, it } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";
import { specsFingerprint } from "./evidence-fingerprint";

// #SCOPE 部分交付 — the user asked for ONE action's function: create_plan(scope:"partial") must
// not warn about the deliberately-uncovered actions, finish must route the delivery to save_draft,
// and save_draft must persist the designed specs into the durable draft library WITHOUT any
// regression evidence (promotion stays fail-closed on such drafts).

const save_draft = FACTORY_TOOLS.find((t) => t.name === "save_draft")!;
const create_plan = FACTORY_TOOLS.find((t) => t.name === "create_plan")!;
const finish = FACTORY_TOOLS.find((t) => t.name === "finish")!;

function spec(
  actionName: string,
  p: Partial<GeneratedAgentSpec> = {},
): GeneratedAgentSpec {
  return {
    key: actionName,
    actionName,
    slug: `d-${actionName}`,
    short: actionName,
    domainId: "rec",
    nameZh: actionName,
    kind: "llm",
    trigger: [],
    emit: [],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "do it",
    toolPolicies: {},
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    inputSchema: [{ field: "a", type: "string" }],
    generatedCode: "export const x = 1;",
    integrationRequirements: [],
    integrationBindings: [],
    ...p,
  } as GeneratedAgentSpec;
}

function ont(actionNames: string[]): DomainOntology {
  return {
    domainId: "rec",
    objects: [],
    rules: [],
    events: [],
    workflow: [],
    source: "allmeta",
    actions: actionNames.map((n) => ({
      id: n,
      name: n,
      actor: ["Agent"],
      trigger: [],
      triggered_event: [],
      target_objects: [],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
    })),
  } as DomainOntology;
}

function mk(
  specs: GeneratedAgentSpec[],
  opts: {
    drafts?: boolean;
    saveResult?: number;
    withReceipt?: boolean;
    receiptFingerprint?: string;
  } = {},
): {
  ctx: BrainCtx;
  saved: Array<{
    domain: string;
    specs: GeneratedAgentSpec[];
    regression: unknown;
  }>;
} {
  const saved: Array<{
    domain: string;
    specs: GeneratedAgentSpec[];
    regression: unknown;
  }> = [];
  const recordSave = (
    domain: string,
    savedSpecs: GeneratedAgentSpec[],
    regression?: unknown,
  ) => {
    saved.push({ domain, specs: savedSpecs, regression });
    return opts.saveResult ?? savedSpecs.length;
  };
  const ctx = {
    domain: "rec",
    ontology: ont(["createJD", "matchResume", "inviteInterview"]),
    specs,
    emit: () => {},
    conversationId: "save-draft-run",
    currentPlan: null,
    ports: {
      ...(opts.drafts === false
        ? {}
        : {
            drafts: {
              async save(
                domain: string,
                s: GeneratedAgentSpec[],
                regression?: unknown,
              ) {
                return recordSave(domain, s, regression);
              },
              ...(opts.withReceipt === false
                ? {}
                : {
                    async saveWithReceipt(
                      domain: string,
                      s: GeneratedAgentSpec[],
                      regression?: unknown,
                    ) {
                      return {
                        schema: "agent-factory-draft-save/v1" as const,
                        persisted: recordSave(domain, s, regression),
                        versionId: "v-save-draft-test-0001",
                        specsFingerprint:
                          opts.receiptFingerprint ?? specsFingerprint(s),
                      };
                    },
                  }),
              async list() {
                return [];
              },
            },
          }),
    },
  } as unknown as BrainCtx;
  return { ctx, saved };
}

describe("create_plan scope (#SCOPE 确定性范围信号)", () => {
  it("partial scope suppresses the missed-actions WARNING and records planScope", async () => {
    const { ctx } = mk([]);
    const res = await create_plan.execute(
      {
        summary: "只做 createJD",
        agents: [{ actionName: "createJD", role: "JD 生成" }],
        scope: "partial",
        scope_reason: "用户原话：只生成 createJD 的 function",
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(
      (res.output as { warnings: string[] }).warnings.join(""),
    ).not.toContain("还没规划");
    expect(res.summary).toContain("部分范围");
    expect(ctx.planScope).toMatchObject({
      kind: "partial",
      missedActions: ["matchResume", "inviteInterview"],
    });
  });

  it("partial scope WITHOUT a user-quoted reason is refused (scope must trace to intent)", async () => {
    const { ctx } = mk([]);
    const res = await create_plan.execute(
      {
        summary: "s",
        agents: [{ actionName: "createJD", role: "r" }],
        scope: "partial",
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("scope_reason");
  });

  it("default/full scope keeps the missed-actions warning (a genuine omission signal)", async () => {
    const { ctx } = mk([]);
    const res = await create_plan.execute(
      { summary: "s", agents: [{ actionName: "createJD", role: "r" }] },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.output as { warnings: string[] }).warnings.join("")).toContain(
      "还没规划的 Agent 动作",
    );
    expect(ctx.planScope?.kind).toBe("full");
  });
});

describe("save_draft (#SCOPE 部分交付)", () => {
  it("refuses when nothing is designed yet", async () => {
    const { ctx, saved } = mk([]);
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("refuses when a spec has no generated code (a draft means the function exists)", async () => {
    const { ctx, saved } = mk([spec("createJD", { generatedCode: undefined })]);
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("还没有代码");
    expect(saved).toHaveLength(0);
  });

  it("revalidates old checkpoint specs before creating an immutable draft", async () => {
    const stale = spec("createJD", {
      emit: ["JD_GENERATED", "JD_REJECTED"],
      plan: [
        { stepId: "select_outcome", kind: "logic" },
        {
          stepId: "emit_generated",
          kind: "emit",
          emitEvent: "JD_GENERATED",
          dependsOn: ["select_outcome"],
        },
        {
          stepId: "emit_rejected",
          kind: "emit",
          emitEvent: "JD_REJECTED",
          dependsOn: ["select_outcome"],
        },
      ],
    });
    const { ctx, saved } = mk([stale]);
    ctx.ontology!.actions = [
      {
        ...ctx.ontology!.actions[0]!,
        triggered_event: ["JD_GENERATED", "JD_REJECTED"],
        action_steps: [
          { step_id: "select_outcome", object_type: "logic" },
          {
            step_id: "emit_generated",
            object_type: "emit",
            emit_event: "JD_GENERATED",
            condition:
              'results.select_outcome.selected_event == "JD_GENERATED"',
            depends_on: ["select_outcome"],
          },
          {
            step_id: "emit_rejected",
            object_type: "emit",
            emit_event: "JD_REJECTED",
            condition: 'results.select_outcome.selected_event == "JD_REJECTED"',
            depends_on: ["select_outcome"],
          },
        ],
      },
    ];

    const res = await save_draft.execute({}, ctx);

    expect(res.ok).toBe(false);
    expect(res.output).toMatchObject({
      reason: "checkpoint_specs_contract_stale",
      invalidActions: [expect.objectContaining({ actionName: "createJD" })],
    });
    expect(res.summary).toContain("condition guard is missing");
    expect(saved).toHaveLength(0);
  });

  it("re-renders a valid checkpoint plan with the current guarded code generator", async () => {
    const current = spec("createJD", {
      emit: ["JD_GENERATED", "JD_REJECTED"],
      generatedCode: "// stale unconditional renderer bytes",
      plan: [
        { stepId: "select_outcome", kind: "logic" },
        {
          stepId: "emit_generated",
          kind: "emit",
          emitEvent: "JD_GENERATED",
          condition: 'results.select_outcome.selected_event == "JD_GENERATED"',
          dependsOn: ["select_outcome"],
        },
        {
          stepId: "emit_rejected",
          kind: "emit",
          emitEvent: "JD_REJECTED",
          condition: 'results.select_outcome.selected_event == "JD_REJECTED"',
          dependsOn: ["select_outcome"],
        },
      ],
    });
    const { ctx, saved } = mk([current]);
    ctx.ontology!.actions = [
      {
        ...ctx.ontology!.actions[0]!,
        triggered_event: ["JD_GENERATED", "JD_REJECTED"],
        action_steps: [
          { step_id: "select_outcome", object_type: "logic" },
          {
            step_id: "emit_generated",
            object_type: "emit",
            emit_event: "JD_GENERATED",
            condition:
              'results.select_outcome.selected_event == "JD_GENERATED"',
            depends_on: ["select_outcome"],
          },
          {
            step_id: "emit_rejected",
            object_type: "emit",
            emit_event: "JD_REJECTED",
            condition: 'results.select_outcome.selected_event == "JD_REJECTED"',
            depends_on: ["select_outcome"],
          },
        ],
      },
    ];

    const res = await save_draft.execute({}, ctx);

    expect(res.ok, res.summary).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.specs[0]!.generatedCode).toContain("evalCondition");
    expect(saved[0]!.specs[0]!.generatedCode).not.toContain(
      "stale unconditional renderer bytes",
    );
  });

  it("cannot use save_draft to omit an Action selected by the server Build scope", async () => {
    const { ctx, saved } = mk([spec("createJD")]);
    ctx.generationDirective = {
      schema: "agent-factory-generation-directive/v1",
      mode: "action_selection",
      requestedActionIds: ["createJD", "matchResume"],
      requestedActionNames: ["createJD", "matchResume"],
      requestedActions: [
        { id: "createJD", name: "createJD" },
        { id: "matchResume", name: "matchResume" },
      ],
      sourceOntologyHash: "sha256:test",
    };

    const res = await save_draft.execute({}, ctx);

    expect(res.ok).toBe(false);
    expect(res.output).toMatchObject({
      reason: "generation_scope_incomplete",
      missingActions: ["matchResume"],
    });
    expect(res.summary).toContain("不能用 save_draft 跳过已选 Action");
    expect(saved).toHaveLength(0);
  });

  it("persists the designed specs WITHOUT regression evidence and reports the partial scope honestly", async () => {
    const { ctx, saved } = mk([spec("createJD")]);
    ctx.planScope = {
      kind: "partial",
      reason: "只生成 createJD 的 function",
      missedActions: ["matchResume", "inviteInterview"],
    };
    const res = await save_draft.execute({ note: "用户只要 createJD" }, ctx);
    expect(res.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.domain).toBe("rec");
    expect(saved[0]!.regression).toBeUndefined(); // no fabricated evidence — promotion stays fail-closed
    expect(res.summary).toContain("部分交付");
    expect(res.summary).toContain("1/3");
    expect(res.summary).toContain("晋升门会拒绝" /* honest boundary */);
    expect(res.output).toMatchObject({
      draftVersionId: "v-save-draft-test-0001",
      specsFingerprint: specsFingerprint(saved[0]!.specs),
    });
  });

  it("rejects a save receipt whose digest does not cover the exact prompt/tools/policies snapshot", async () => {
    const { ctx, saved } = mk([spec("createJD")], {
      receiptFingerprint: `specs:v2:${"0".repeat(64)}`,
    });

    const res = await save_draft.execute({}, ctx);

    expect(res.ok).toBe(false);
    expect(res.summary).toContain("不可变版本回执");
    expect(saved).toHaveLength(1);
  });

  it("persists function code when an external API is offline and reports execution readiness without claiming verification", async () => {
    const offline = spec("createJD", {
      integrationBindings: [
        {
          requirement: {
            id: "createJD:integration:1",
            actionName: "createJD",
            system: "GoHire_System",
            kind: "external_api",
            role: "write",
            operations: ["generate"],
            objectTypes: [],
            replayable: false,
          },
          bindingKind: "tool",
          bindingId: "generateJdApi",
          toolName: "generateJdApi",
          status: "needs_probe",
          reason: "external platform is temporarily offline",
        },
      ],
      executionReadiness: {
        schema: "agent-factory-execution-readiness/v1",
        authoringReady: true,
        sandboxReady: false,
        promotionReady: false,
        sandboxBlockers: ["generateJdApi 缺少当前安全 sandbox probe evidence"],
        promotionBlockers: ["generateJdApi 缺少 live probe"],
        missingSandboxProfiles: [],
        missingProductionProfiles: [],
        probeGaps: [
          {
            tool: "generateJdApi",
            reasons: ["probe_not_verified"],
            sandboxReasons: ["probe_not_verified"],
            promotionReasons: ["live_probe_required_for_promotion"],
          },
        ],
        externalApis: [
          {
            tool: "generateJdApi",
            systems: ["GoHire_System"],
            bindingStatuses: ["needs_probe"],
            sandboxReady: false,
            promotionReady: false,
            missingSandboxProfile: false,
            missingProductionProfile: false,
            missingCredentialEnv: [],
            sandboxReasons: ["probe_not_verified"],
            promotionReasons: ["live_probe_required_for_promotion"],
          },
        ],
      },
    });
    const { ctx, saved } = mk([offline]);

    const res = await save_draft.execute({}, ctx);

    expect(res.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.specs[0]?.generatedCode).toContain("export");
    expect(res.summary).toContain("GoHire_System");
    expect(res.summary).toContain("generated_unverified");
    expect(res.summary).toContain("不是 runnable/verified candidate");
    expect(res.output).toMatchObject({
      executionReadiness: {
        state: "generated_unverified",
        sandboxEvidence: "not_run",
        sandboxPrerequisitesReady: false,
        promotionPrerequisitesReady: false,
        unverifiedApis: [
          expect.objectContaining({
            actionName: "createJD",
            tool: "generateJdApi",
            systems: ["GoHire_System"],
          }),
        ],
      },
    });
  });

  it("treats a zero-count store write as failure (never advertise an unpersisted draft)", async () => {
    const { ctx } = mk([spec("createJD")], { saveResult: 0 });
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
  });

  it("refuses when the drafts port is unwired", async () => {
    const { ctx } = mk([spec("createJD")], { drafts: false });
    const res = await save_draft.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("草稿存储未接入");
  });
});

describe("finish routes partial-scope deliveries to save_draft (semantics untouched)", () => {
  it("coverage-gap refusal points to save_draft when the plan scope is partial", async () => {
    const { ctx } = mk([spec("createJD")]);
    ctx.planScope = {
      kind: "partial",
      reason: "只生成 createJD",
      missedActions: ["matchResume", "inviteInterview"],
    };
    const res = await finish.execute({ summary: "s" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("save_draft");
    expect(res.summary).toContain("部分范围");
  });

  it("full-scope coverage gap keeps the original push to continue designing", async () => {
    const { ctx } = mk([spec("createJD")]);
    const res = await finish.execute({ summary: "s" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("继续 design_agent");
    expect(res.summary).not.toContain("save_draft");
  });
});
