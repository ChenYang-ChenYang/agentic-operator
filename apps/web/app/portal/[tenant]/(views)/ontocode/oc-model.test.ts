import { describe, expect, it } from "vitest";
import type { AgentCardData, Block, BrainStep, DraftRow } from "../factory/model";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import { isOntoCodeScopeRecommendation } from "./oc-api";
import {
  boundaryDecisionText,
  buildOntoCodeIntentGoal,
  clarifyAnswerText,
  deriveBuildStages,
  confirmPromotionOutcome,
  deriveConnectionReadiness,
  deriveExecLine,
  deriveFlowGraph,
  deriveNextSteps,
  deriveOntologyDomainState,
  deriveOntoCodeBuildContext,
  deriveResolvedGates,
  deriveTodos,
  extractProviderHint,
  deriveTokensUsed,
  draftChip,
  isAgentOwnedOntologyAction,
  linearizeFlow,
  matchBoundRecommendationActionIds,
  pickPromotableSet,
  presentTodo,
  resolveOntoCodeComposerSubmit,
  resolveOntoCodeStartMode,
  scopeDraftsToAgents,
  testDecisionText,
  timeAgo,
  todoTierCounts,
} from "./oc-model";

const clarifyBlock = (over: Partial<Extract<Block, { kind: "clarify" }>> = {}): Block => ({
  kind: "clarify",
  id: "b-1",
  interactionId: "int-1",
  question: "高分邀约的分数线？",
  options: [
    { label: "≥80（推荐）", value: "80", recommended: true },
    { label: "≥70", value: "70" },
  ],
  awaiting: true,
  ...over,
});

const validScopeRecommendation = {
  recommendationId: "rec_0123456789abcdef0123456789abcdef",
  ontologyHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  mode: "action_selection",
  scenario: "客户风险升高时创建跟进任务",
  actionIds: ["create-followup"],
  actions: [
    {
      id: "create-followup",
      name: "创建跟进任务",
      reason: "场景要求在风险升高后创建跟进",
    },
  ],
  reasoningSummary: "使用一个已有 Action 即可覆盖该目标",
  confidence: 0.86,
} as const;

describe("isOntoCodeScopeRecommendation", () => {
  it("accepts a complete, aligned Action recommendation", () => {
    expect(isOntoCodeScopeRecommendation(validScopeRecommendation)).toBe(true);
  });

  it("rejects invalid confidence instead of rendering false precision", () => {
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        confidence: 1.01,
      }),
    ).toBe(false);
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        confidence: Number.NaN,
      }),
    ).toBe(false);
  });

  it("rejects malformed recommendation identity and Ontology hashes", () => {
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        recommendationId: "rec-not-signed",
      }),
    ).toBe(false);
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        ontologyHash: "short",
      }),
    ).toBe(false);
  });

  it("rejects duplicate or out-of-sync Action IDs", () => {
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        actionIds: ["create-followup", "notify-owner"],
      }),
    ).toBe(false);
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        actionIds: ["create-followup", "create-followup"],
        actions: [
          validScopeRecommendation.actions[0],
          validScopeRecommendation.actions[0],
        ],
      }),
    ).toBe(false);
  });

  it("requires an empty Action scope and a virtual Action for scenario mode", () => {
    const virtualAction = {
      id: "scenario-risk-followup",
      name: "风险跟进",
      reason: "当前 Ontology 没有直接对应 Action",
    };
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        mode: "virtual_scenario",
        actionIds: [],
        actions: [],
        virtualAction,
      }),
    ).toBe(true);
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        mode: "virtual_scenario",
        actionIds: [],
        actions: [],
      }),
    ).toBe(false);
    expect(
      isOntoCodeScopeRecommendation({
        ...validScopeRecommendation,
        virtualAction,
      }),
    ).toBe(false);
  });
});

describe("buildOntoCodeIntentGoal", () => {
  it("only exposes actions explicitly owned by Agent actors", () => {
    expect(isAgentOwnedOntologyAction({ actor: ["Agent"] })).toBe(true);
    expect(isAgentOwnedOntologyAction({ actor: ["Human"] })).toBe(false);
    expect(isAgentOwnedOntologyAction({ actor: [] })).toBe(false);
  });

  it("keeps selected Ontology actions explicit and adds an optional scenario", () => {
    const goal = buildOntoCodeIntentGoal(
      [
        { id: "create-jd", name: "创建职位" },
        { id: "publish-jd", name: "发布职位" },
      ],
      "审批通过后再发布",
    );
    expect(goal).toContain("create-jd（创建职位）");
    expect(goal).toContain("publish-jd（发布职位）");
    expect(goal).toContain("场景与业务约束：\n审批通过后再发布");
    expect(goal).toContain("沙箱中跑通");
  });

  it("marks scenario-only work as a non-mutating scenario agent", () => {
    const goal = buildOntoCodeIntentGoal([], "客户风险升高时创建跟进任务");
    expect(goal).toContain("场景型 Agent（不回写 Ontology）");
    expect(goal).toContain("客户风险升高时创建跟进任务");
  });
});

describe("resolveOntoCodeStartMode", () => {
  it("sends structured scope only for a new suite", () => {
    expect(
      resolveOntoCodeStartMode({
        hasSuite: false,
        hasConversation: false,
        selectedActionIds: ["create-jd"],
        sourceActionIds: [],
      }),
    ).toBe("new_scope");
  });

  it("reuses immutable server scope for same-action follow-up edits", () => {
    expect(
      resolveOntoCodeStartMode({
        hasSuite: true,
        hasConversation: true,
        selectedActionIds: ["publish-jd", "create-jd"],
        sourceActionIds: ["create-jd", "publish-jd"],
      }),
    ).toBe("modify_existing");
  });

  it("requires a new task when the selected Action set changes", () => {
    expect(
      resolveOntoCodeStartMode({
        hasSuite: true,
        hasConversation: true,
        selectedActionIds: ["publish-jd"],
        sourceActionIds: ["create-jd", "publish-jd"],
      }),
    ).toBe("scope_changed");
  });

  it("allows goal-only follow-ups for a scenario-only virtual Action scope", () => {
    expect(
      resolveOntoCodeStartMode({
        hasSuite: true,
        hasConversation: true,
        selectedActionIds: [],
        sourceActionIds: [],
      }),
    ).toBe("modify_existing");
  });
});

describe("deriveOntologyDomainState", () => {
  it("blocks on a failed request instead of collapsing it into an empty domain", () => {
    expect(
      deriveOntologyDomainState({
        hasData: false,
        isPending: false,
        isError: true,
        domainCount: 0,
        domainId: "",
      }),
    ).toBe("error");
  });

  it("does not trust stale domain data after a failed refresh", () => {
    expect(
      deriveOntologyDomainState({
        hasData: true,
        isPending: false,
        isError: true,
        domainCount: 2,
        domainId: "agents-generation",
      }),
    ).toBe("error");
  });

  it("distinguishes a successful empty response from loading and ready states", () => {
    expect(
      deriveOntologyDomainState({
        hasData: true,
        isPending: false,
        isError: false,
        domainCount: 0,
        domainId: "",
      }),
    ).toBe("empty");
    expect(
      deriveOntologyDomainState({
        hasData: false,
        isPending: true,
        isError: false,
        domainCount: 0,
        domainId: "",
      }),
    ).toBe("loading");
    expect(
      deriveOntologyDomainState({
        hasData: true,
        isPending: false,
        isError: false,
        domainCount: 1,
        domainId: "agents-generation",
      }),
    ).toBe("ready");
  });
});

describe("resolveOntoCodeComposerSubmit", () => {
  it("routes the first question to server-side Ontology analysis", () => {
    expect(
      resolveOntoCodeComposerSubmit({
        hasCurrentTask: false,
        hasRecommendation: false,
      }),
    ).toBe("analyze_scope");
  });

  it("only starts after a recommendation or for an existing task", () => {
    expect(
      resolveOntoCodeComposerSubmit({
        hasCurrentTask: false,
        hasRecommendation: true,
      }),
    ).toBe("start_run");
    expect(
      resolveOntoCodeComposerSubmit({
        hasCurrentTask: true,
        hasRecommendation: false,
      }),
    ).toBe("start_run");
  });
});

describe("matchBoundRecommendationActionIds", () => {
  it("preserves an exact server recommendation when every ID is bound", () => {
    expect(
      matchBoundRecommendationActionIds({
        recommendedActionIds: ["create-followup", "notify-owner"],
        boundAgentActionIds: ["notify-owner", "create-followup", "archive-risk"],
      }),
    ).toEqual(["create-followup", "notify-owner"]);
  });

  it("rejects the whole recommendation when one ID is unavailable", () => {
    expect(
      matchBoundRecommendationActionIds({
        recommendedActionIds: ["create-followup", "not-in-this-domain"],
        boundAgentActionIds: ["create-followup"],
      }),
    ).toBeNull();
  });
});

describe("deriveOntoCodeBuildContext", () => {
  it("shows selected source scope, a virtual action, and compact autopilot assumptions", () => {
    const context = deriveOntoCodeBuildContext([
      {
        t: "source.scope",
        actionIds: ["create-jd", "publish-jd", "scenario-risk-followup"],
        scenario: "审批通过后发布",
      },
      {
        t: "virtual_action.created",
        actionId: "scenario-risk-followup",
        name: "风险跟进",
      },
      {
        t: "assumption.applied",
        assumption: {
          id: "asm-timeout",
          gate: "runtime_default",
          subject: "请求超时",
          value: "30 秒",
          source: "recommended",
          detail: "Ontology 未声明超时",
          appliedAt: 1_785_000_000_000,
        },
      },
      {
        t: "assumption.applied",
        assumption: {
          id: "asm-fallback",
          gate: "failure_boundary",
          subject: "失败处理",
          value: "人工边界",
          source: "recommended",
        },
      },
    ]);
    expect(context.actionIds).toEqual(["create-jd", "publish-jd"]);
    expect(context.scenario).toBe("审批通过后发布");
    expect(context.virtualAction).toEqual({
      id: "scenario-risk-followup",
      name: "风险跟进",
    });
    expect(context.assumptions).toHaveLength(2);
    expect(context.assumptions[0]).toMatchObject({
      id: "asm-timeout",
      gate: "runtime_default",
      summary: "请求超时 → 30 秒",
      detail: "Ontology 未声明超时",
    });
    expect(context.assumptions[1]?.summary).toBe("失败处理 → 人工边界");
  });
});

describe("deriveTodos", () => {
  it("collects awaiting gates of all three kinds and skips resolved ones", () => {
    const blocks: Block[] = [
      clarifyBlock(),
      clarifyBlock({ id: "b-2", interactionId: "int-2", awaiting: false }),
      {
        kind: "testcases",
        id: "b-3",
        interactionId: "int-3",
        cases: [
          { id: "c1", name: "主链", kind: "pass", scenario: "s", entryEvent: "resume.submitted", expectedOutcome: "ok" },
        ],
        awaiting: true,
      },
      {
        kind: "boundarycases",
        id: "b-4",
        interactionId: "int-4",
        proposals: [
          { event: "ats.synced", suggestedKind: "terminal", why: "无消费者", producers: ["ats-writeback"] },
        ],
        awaiting: true,
      },
    ];
    const todos = deriveTodos(blocks);
    expect(todos.map((t) => t.kind)).toEqual(["clarify", "test_approval", "boundary"]);
    expect(todos[0]!.options).toHaveLength(2);
    expect(todos[1]!.cases).toHaveLength(1);
    expect(todos[2]!.proposals?.[0]?.event).toBe("ats.synced");
  });

  it("marks credential-flavoured clarify gates", () => {
    const todos = deriveTodos([
      clarifyBlock({ question: "gohireBgCheckApi 凭证未配置，请提供 API key" }),
    ]);
    expect(todos[0]!.credentialLike).toBe(true);
    expect(deriveTodos([clarifyBlock()])[0]!.credentialLike).toBe(false);
  });

  it("extracts a provider hint from a credential todo for the 去配置 deep-link", () => {
    // explicit provider tag
    const explicit = deriveTodos([
      clarifyBlock({ question: "缺少凭证 provider: gohire，请到集成配置" }),
    ])[0]!;
    expect(explicit.credentialLike).toBe(true);
    expect(explicit.providerHint).toBe("gohire");
    // env-var name → provider slug
    const env = deriveTodos([
      clarifyBlock({ question: "需要设置 ACME_CRM_API_KEY 才能继续（凭证缺失）" }),
    ])[0]!;
    expect(env.providerHint).toBe("acme-crm");
    // no derivable provider → null (route to workbench, not settings)
    const none = deriveTodos([
      clarifyBlock({ question: "该动作缺少凭证，但没有指明是哪个系统" }),
    ])[0]!;
    expect(none.credentialLike).toBe(true);
    expect(none.providerHint).toBeNull();
    // non-credential todo carries no hint (null, not derived)
    expect(deriveTodos([clarifyBlock()])[0]!.providerHint).toBeNull();
  });
});

describe("extractProviderHint", () => {
  it("explicit provider:/= tag wins", () => {
    expect(extractProviderHint("provider: gohire")).toBe("gohire");
    expect(extractProviderHint("provider=Acme-CRM")).toBe("acme-crm");
  });
  it("env var name → kebab provider slug (suffix stripped)", () => {
    expect(extractProviderHint("set GOHIRE_API_KEY")).toBe("gohire");
    expect(extractProviderHint("X_INTERNAL_TOKEN missing")).toBe("x-internal");
    expect(extractProviderHint("FOO_SECRET not set")).toBe("foo");
  });
  it("returns null when nothing parseable", () => {
    expect(extractProviderHint("just some prose about credentials")).toBeNull();
  });
});

describe("presentTodo", () => {
  it("shortens wall-of-text questions to the first sentence", () => {
    const long = deriveTodos([
      clarifyBlock({
        question:
          "6 个动作（createJD、processResume、ruleCheckForCandidateIdentity）目前还不能生成可靠草稿。请确认哪些真实工具负责连接这些系统（createJD 需要连接 RAAS_System（尚无任何已授权的工具/运行时能力））、processResume 需要连接 RAAS_System……",
        options: undefined,
      }),
    ])[0]!;
    const p = presentTodo(long);
    expect(p.shortTitle.length).toBeLessThanOrEqual(65);
    expect(p.truncated).toBe(true);
    expect(p.tier).toBe("required");
  });

  it("tiers recommended-option questions and surfaces inline quick options", () => {
    const todo = deriveTodos([clarifyBlock()])[0]!;
    const p = presentTodo(todo);
    expect(p.tier).toBe("recommended");
    expect(p.inlineOptions[0]).toEqual({ label: "≥80（推荐）", recommended: true });
    expect(p.inlineOptions).toHaveLength(2);
  });

  it("keeps credential questions in the required tier with source hint", () => {
    const todo = deriveTodos([
      clarifyBlock({ question: "GoHire API 凭证未配置", context: "写副作用，不能替你猜" }),
    ])[0]!;
    const p = presentTodo(todo);
    expect(p.tier).toBe("required");
    expect(p.sourceHint).toBe("写副作用，不能替你猜");
  });

  it("todoTierCounts splits required vs recommended", () => {
    const todos = deriveTodos([
      clarifyBlock(),
      clarifyBlock({ id: "b-2", interactionId: "int-2", question: "凭证未配置 key", options: undefined }),
    ]);
    expect(todoTierCounts(todos)).toEqual({ required: 1, recommended: 1 });
  });
});

describe("wire tags", () => {
  it("stays byte-identical to the factory transport", () => {
    expect(clarifyAnswerText("≥80")).toBe("[澄清回答] ≥80");
    expect(testDecisionText("approve")).toBe("[测试用例决策: 执行]");
    expect(testDecisionText("regenerate", "换个夹具")).toBe("[测试用例决策: 重新生成] 换个夹具");
    expect(boundaryDecisionText([{ event: "e", kind: "terminal" }])).toBe(
      '[边界事件决策] [{"event":"e","kind":"terminal"}]',
    );
  });
});

describe("deriveExecLine", () => {
  const ev = (t: string, rest: Record<string, unknown> = {}): BrainEvent => ({ t, ...rest });

  it("shows the open tool call while running", () => {
    const line = deriveExecLine(
      [
        ev("tool.call", { id: "t1", name: "ontology.query" }),
        ev("tool.result", { id: "t1", ok: true }),
        ev("tool.call", { id: "t2", name: "gohireMatchResumeApi" }),
      ],
      true,
    );
    expect(line.state).toBe("running");
    expect(line.text).toBe("调用 gohireMatchResumeApi");
    expect(line.toolCount).toBe(2);
  });

  it("shows a neutral build state when no tool is open", () => {
    const line = deriveExecLine([ev("think", { delta: "…" })], true);
    expect(line).toMatchObject({ state: "running", text: "正在构建" });
  });

  it("reports waiting_human and terminal done distinctly", () => {
    const base = [ev("agent.created", { spec: { slug: "jd-matcher" } })];
    expect(deriveExecLine([...base, ev("done", { status: "waiting_human" })], false)).toMatchObject({
      state: "done",
      text: "等待你的决定",
      agentCount: 1,
    });
    expect(deriveExecLine([...base, ev("done", { status: "finished" })], false)).toMatchObject({
      state: "done",
      text: "完成",
    });
  });

  it("surfaces a trailing error when not running", () => {
    const line = deriveExecLine([ev("error", { message: "上游 503" })], false);
    expect(line).toMatchObject({ state: "error", text: "上游 503" });
  });

  it("is idle with no events", () => {
    expect(deriveExecLine([], false).state).toBe("idle");
  });
});

describe("deriveBuildStages", () => {
  const step = (
    id: string,
    kind: BrainStep["kind"],
    status: BrainStep["status"],
    interactionId?: string,
  ): BrainStep => ({
    id,
    kind,
    status,
    label: id,
    ...(interactionId ? { interactionId } : {}),
  });

  it("collapses noisy steps into stable product phases", () => {
    const stages = deriveBuildStages([
      step("read", "read", "ok"),
      step("design-a", "design", "ok"),
      step("refine-a", "refine", "warn"),
      step("gate", "gate", "await", "int-1"),
      step("sandbox", "sandbox", "ok"),
    ]);
    expect(stages.map((stage) => stage.id)).toEqual([
      "context",
      "generate",
      "validate",
      "sandbox",
    ]);
    expect(stages.find((stage) => stage.id === "generate")?.count).toBe(2);
    expect(stages.find((stage) => stage.id === "validate")).toMatchObject({
      status: "await",
      interactionId: "int-1",
    });
  });

  it("keeps a failure visible even if a later step in that phase is informational", () => {
    const [stage] = deriveBuildStages([
      step("validation-failed", "validate", "fail"),
      step("gate-recorded", "gate", "info"),
    ]);
    expect(stage).toMatchObject({ id: "validate", status: "fail" });
  });
});

describe("deriveFlowGraph", () => {
  const agent = (slug: string, trigger: string[], emit: string[]): AgentCardData => ({
    slug,
    actionName: slug,
    short: slug,
    nameZh: slug,
    trigger,
    emit,
    tools: [],
  });

  it("wires producer→consumer edges and classifies entry/terminal events", () => {
    const graph = deriveFlowGraph([
      agent("parser", ["resume.submitted"], ["resume.parsed"]),
      agent("matcher", ["resume.parsed"], ["match.scored"]),
    ]);
    expect(graph.edges).toEqual([{ from: "parser", to: "matcher", event: "resume.parsed" }]);
    expect(graph.entryEvents).toEqual([{ event: "resume.submitted", to: "parser" }]);
    expect(graph.terminalEvents).toEqual([{ event: "match.scored", from: "matcher" }]);
    expect(graph.nodes).toHaveLength(2);
  });
});

describe("flow/resolved/usage/time projections", () => {
  const agent = (slug: string, trigger: string[], emit: string[]): AgentCardData => ({
    slug, actionName: slug, short: slug, nameZh: slug, trigger, emit, tools: [],
  });

  it("linearizeFlow walks entry→terminal and keeps orphans", () => {
    const graph = deriveFlowGraph([
      agent("a", ["e0"], ["e1"]),
      agent("b", ["e1"], ["e2"]),
      agent("orphan", ["ex"], []),
    ]);
    const lin = linearizeFlow(graph);
    expect(lin[0]).toEqual(["a", "b"]);
    expect(lin.flat()).toContain("orphan");
  });

  it("deriveResolvedGates lists only non-awaiting gates", () => {
    const resolved = deriveResolvedGates([
      clarifyBlock({ awaiting: false }),
      clarifyBlock({ id: "b-9", interactionId: "int-9" }),
      { kind: "testcases", id: "b-8", cases: [{ id: "c", name: "n", kind: "pass", scenario: "s", entryEvent: "e", expectedOutcome: "o" }], awaiting: false },
    ]);
    expect(resolved).toHaveLength(2);
    expect(resolved[1]!.title).toContain("已批准");
  });

  it("deriveTokensUsed takes the last budget frame", () => {
    expect(deriveTokensUsed([{ t: "budget", tokens: 1000 }, { t: "budget", tokens: 52000 }])).toBe(52000);
    expect(deriveTokensUsed([{ t: "think" }])).toBeNull();
  });

  it("timeAgo buckets correctly with injected now", () => {
    const now = Date.parse("2026-07-22T12:00:00Z");
    expect(timeAgo("2026-07-22T11:59:40Z", now)).toBe("刚刚");
    expect(timeAgo("2026-07-22T11:35:00Z", now)).toBe("25 分钟前");
    expect(timeAgo("2026-07-22T03:00:00Z", now)).toBe("9 小时前");
    expect(timeAgo("2026-07-21T09:00:00Z", now)).toBe("昨天");
    expect(timeAgo("2026-07-18T09:00:00Z", now)).toBe("4 天前");
  });
});

describe("deriveConnectionReadiness (端到端部署门)", () => {
  const sys = (system: string, probeOk: boolean | null, humanBoundary = false) => ({ system, probeOk, humanBoundary });

  it("all ready when every system is probe-verified or a human boundary", () => {
    const r = deriveConnectionReadiness([sys("GoHire", true), sys("Internal", null, true)]);
    expect(r).toEqual({ allReady: true, pending: [], verified: 2, total: 2 });
  });

  it("lists systems that are neither verified nor a boundary as pending", () => {
    const r = deriveConnectionReadiness([
      sys("GoHire", true),
      sys("RAAS", null), // built + credentialed but never probed → pending
      sys("Allmeta", false), // probe failed → pending
    ]);
    expect(r.allReady).toBe(false);
    expect(r.pending).toEqual(["RAAS", "Allmeta"]);
    expect(r.verified).toBe(1);
  });

  it("runtime-provided systems count as ready (no external connection to build)", () => {
    const r = deriveConnectionReadiness([
      { system: "AO_Internal", probeOk: null, humanBoundary: false, runtimeProvided: true },
      { system: "RAAS", probeOk: null, humanBoundary: false },
    ]);
    expect(r.pending).toEqual(["RAAS"]);
    expect(r.verified).toBe(1);
  });

  it("planned + human_boundary counts ready; planned + block stays pending with a 规划中 label", () => {
    const r = deriveConnectionReadiness([
      // 本体规划了、未建成，选了人工边界回退 → 不阻塞部署
      { system: "Future_CRM", probeOk: null, humanBoundary: false, availability: "planned" as const, plannedFallback: "human_boundary" as const },
      // 同为规划中但选阻断 → 留在待办，带「规划中」标注
      { system: "Future_ERP", probeOk: null, humanBoundary: false, availability: "planned" as const, plannedFallback: "block" as const },
    ]);
    expect(r.pending).toEqual(["Future_ERP（规划中）"]);
    expect(r.verified).toBe(1);
    expect(r.allReady).toBe(false);
  });

  it("planned dominates probeOk — a stale probe on a now-planned system must not mark it ready", () => {
    const r = deriveConnectionReadiness([
      { system: "Rebuilt", probeOk: true, humanBoundary: false, availability: "planned" as const, plannedFallback: "block" as const },
    ]);
    expect(r.pending).toEqual(["Rebuilt（规划中）"]);
  });

  it("empty coverage is trivially ready", () => {
    expect(deriveConnectionReadiness([]).allReady).toBe(true);
  });
});

describe("promotion gating", () => {
  const promotableDraft = (over: Partial<DraftRow> = {}): DraftRow => ({
    slug: "match-resume",
    createdAt: "2026-07-22T00:00:00Z",
    versionId: "v-1",
    replayReady: true,
    regressionReady: true,
    promotionGateAdmission: true,
    promotionEligible: true,
    promotionEvidenceReady: true,
    evidenceQualification: {
      schema: "agent-factory-regression-evidence-qualification/v1",
      replay: "sandbox_verified",
      promotion: "candidate",
      blockers: [],
    },
    spec: { nameZh: "简历匹配", short: "matcher" },
    ...over,
  });

  it("scopes domain-wide drafts to only the agents emitted by the current stream", () => {
    const drafts = [
      promotableDraft({ slug: "current-a" }),
      promotableDraft({ slug: "current-b" }),
      promotableDraft({ slug: "historical-other-task" }),
    ];
    const scoped = scopeDraftsToAgents(drafts, ["current-a", "current-b"]);
    expect(scoped.map((draft) => draft.slug)).toEqual(["current-a", "current-b"]);
    expect(scopeDraftsToAgents(drafts, [])).toEqual([]);
  });

  it("draftChip separates promotable / evidence-pending / plain drafts", () => {
    expect(draftChip(promotableDraft())).toMatchObject({ tone: "ok", blockers: [] });
    const pending = draftChip(promotableDraft({ promotionEligible: false, promotionBlockers: ["缺生产凭证"] }));
    expect(pending).toMatchObject({ tone: "warn", blockers: ["缺生产凭证"] });
    expect(draftChip(promotableDraft({ replayReady: false })).tone).toBe("dim");
  });

  it("pickPromotableSet requires readiness and a single version", () => {
    expect(pickPromotableSet([]).ok).toBe(false);
    expect(pickPromotableSet([promotableDraft({ replayReady: false })]).ok).toBe(false);
    const mixed = pickPromotableSet([
      promotableDraft(),
      promotableDraft({ slug: "invite", versionId: "v-2" }),
    ]);
    expect(mixed.ok).toBe(false);
    const happy = pickPromotableSet([
      promotableDraft(),
      promotableDraft({ slug: "invite" }),
      promotableDraft({ slug: "parser", replayReady: false }),
    ]);
    expect(happy).toEqual({ ok: true, versionId: "v-1", slugs: ["match-resume", "invite"] });
  });

  it("confirmPromotionOutcome demands full-slug confirmation with live counts", () => {
    const slugs = ["a", "b"];
    expect(
      confirmPromotionOutcome(slugs, { promoted: ["a", "b"], functionsRegistered: 2, liveAgents: 2 }),
    ).toBe(true);
    expect(confirmPromotionOutcome(slugs, { promoted: ["a"], functionsRegistered: 2, liveAgents: 2 })).toBe(false);
    expect(confirmPromotionOutcome(slugs, { promoted: ["a", "b"], functionsRegistered: 0, liveAgents: 2 })).toBe(false);
    expect(confirmPromotionOutcome(slugs, { promoted: ["a", "b"], functionsRegistered: 2, liveAgents: 1 })).toBe(false);
  });
});

describe("deriveNextSteps", () => {
  it("suggests credential setup and advanced mode only after done", () => {
    const doneExec = { state: "done" as const, text: "完成", toolCount: 3, agentCount: 6 };
    const todos = deriveTodos([
      clarifyBlock({ question: "GoHire API 凭证未配置" }),
    ]);
    const steps = deriveNextSteps(doneExec, todos, "raas");
    expect(steps.map((s) => s.id)).toEqual(["credential", "advanced"]);
    // The credential CTA must deep-link straight to the Integrations section —
    // dropping the operator on the default Workspace tab is the "empty page"
    // report we are fixing.
    expect(steps.find((s) => s.id === "credential")?.href).toBe(
      "/portal/raas/settings?section=integrations",
    );
    expect(deriveNextSteps({ ...doneExec, state: "running" }, todos, "raas")).toEqual([]);
  });
});
