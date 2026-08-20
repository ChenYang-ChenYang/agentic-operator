import { describe, expect, it } from "vitest";
import type {
  OntoCodeBuildSession,
  OntoCodeCommand,
  OntoCodeConfigurationTask,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import {
  type ActionCardVM,
  collectVisibleText,
  deriveActionCardLifecycle,
  FORBIDDEN_VOCABULARY,
  projectFlow,
  projectSessionRow,
  RECOMMENDATION_COMMAND_ARGUMENT_KEY,
} from "./projection";

const NOW = 1_753_600_000_000;

function makeSession(
  overrides: Partial<OntoCodeBuildSession> = {},
): OntoCodeBuildSession {
  return {
    id: "ocs-1111222233334444",
    tenantId: "ten-raas",
    projectId: "ocp-aaaabbbbccccdddd",
    runtimeProfileVersionId: null,
    title: "候选人筛选套件",
    goal: "基于 RAAS-v1 生成并验证候选人匹配 Agent",
    phase: "build",
    activityState: "idle",
    autonomyMode: "copilot",
    revision: 4,
    ontologySnapshotHash: "a".repeat(64),
    basePackageVersionId: null,
    environmentProfileVersionId: null,
    ownerUserId: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeJob(
  overrides: Partial<OntoCodeHarnessJob> = {},
): OntoCodeHarnessJob {
  return {
    id: "ocj-9999888877776666",
    tenantId: "ten-raas",
    sessionId: "ocs-1111222233334444",
    commandId: null,
    runtimeProfileVersionId: null,
    kind: "build",
    status: "succeeded",
    inputHash: null,
    budget: null,
    candidatePackageVersionId: null,
    candidateDependencyRoot: null,
    candidateHeadId: null,
    candidateHeadRevision: null,
    testCases: [],
    idempotencyKey: "idem-build-1",
    errorMessage: null,
    createdBy: null,
    createdAt: NOW - 50_000,
    startedAt: NOW - 49_000,
    finishedAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<OntoCodeMessage> = {},
): OntoCodeMessage {
  return {
    id: "ocm-1234123412341234",
    tenantId: "ten-raas",
    sessionId: "ocs-1111222233334444",
    role: "user",
    type: "text",
    content: { text: "开始生成" },
    commandId: null,
    correlationId: "cor-1234123412341234",
    idempotencyKey: null,
    createdAt: NOW - 55_000,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<OntoCodeSessionEvent> = {},
): OntoCodeSessionEvent {
  return {
    id: "oce-5678567856785678",
    seq: 7,
    tenantId: "ten-raas",
    projectId: "ocp-aaaabbbbccccdddd",
    sessionId: "ocs-1111222233334444",
    harnessJobId: "ocj-9999888877776666",
    commandId: null,
    correlationId: "cor-1234123412341234",
    causationId: null,
    type: "harness.build.stage",
    visibility: "user",
    payload: {},
    createdAt: NOW - 40_000,
    ...overrides,
  };
}

const OPEN_CONFIG_TASK = {
  id: "ocfg-4321432143214321",
  sessionId: "ocs-1111222233334444",
  status: "open",
  title: "配置 RoboHire API 凭证",
  blockerKey: "integration:RoboHire_System",
  waitingHarnessJobId: "ocj-9999888877776666",
  requirement: { summary: "真实 E2E 缺少 candidates.read 权限" },
} as unknown as OntoCodeConfigurationTask;

describe("projectSessionRow", () => {
  it("maps needs_user to human waiting label with question preview", () => {
    const row = projectSessionRow(
      makeSession({ activityState: "needs_user" }),
      {
        latestQuestion: "最终评分工具选哪个？",
      },
    );
    expect(row.tone).toBe("warn");
    expect(row.label).toBe("等你决定");
    expect(row.sub).toContain("最终评分工具");
    expect(row.needsAttention).toBeGreaterThan(0);
  });

  it("maps idle with overview facts instead of harness jargon", () => {
    const row = projectSessionRow(makeSession({ activityState: "idle" }), {
      overview: { agents: 3, ready: 2, blocked: 1 },
    });
    expect(row.label).toBe("可继续");
    expect(row.sub).toContain("3 个 agent");
    expect(row.sub).toContain("2 就绪");
    expect(row.sub).not.toMatch(/harness|evidence/i);
  });

  it("maps idle without overview to the bare label with no filler sub", () => {
    const row = projectSessionRow(makeSession({ activityState: "idle" }));
    expect(row.label).toBe("可继续");
    expect(row.sub).toBe("");
  });

  it("maps running with job kind to a live verb", () => {
    const row = projectSessionRow(makeSession({ activityState: "running" }), {
      runningJobKind: "build",
    });
    expect(row.tone).toBe("run");
    expect(row.sub).toContain("正在生成");
  });

  it("never leaks internal vocabulary", () => {
    const rows = [
      projectSessionRow(makeSession({ activityState: "failed_recoverable" })),
      projectSessionRow(makeSession({ activityState: "review_required" })),
      projectSessionRow(makeSession({ phase: "observe" })),
      projectSessionRow(makeSession({ phase: "completed" })),
    ];
    expect(collectVisibleText(rows)).not.toMatch(FORBIDDEN_VOCABULARY);
  });
});

describe("projectFlow", () => {
  it("renders user text, human assistant text, and skips directive-only noise", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage(),
        makeMessage({
          id: "ocm-2222333344445555",
          role: "assistant",
          content: { text: "好的，我会先读取 Ontology 再生成。" },
          createdAt: NOW - 54_000,
        }),
        makeMessage({
          id: "ocm-3333444455556666",
          role: "assistant",
          content: { directive: { behavior: "execute", target: "build" } },
          createdAt: NOW - 53_000,
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("aiText");
    expect(JSON.stringify(items)).not.toContain("directive");
  });

  it("turns a finished job into an exec group and a running job into a status line", () => {
    const items = projectFlow({
      session: makeSession({ activityState: "running" }),
      messages: [],
      jobs: [
        makeJob(),
        makeJob({
          id: "ocj-1212343456567878",
          kind: "blueprint",
          status: "running",
          startedAt: NOW - 5_000,
          finishedAt: null,
        }),
      ],
      events: [
        makeEvent({ payload: { stage: "planning" } }),
        makeEvent({ id: "oce-2", seq: 8, type: "harness.build.stage" }),
      ],
      configTasks: [],
      commands: [],
    });
    const exec = items.find((i) => i.kind === "execGroup");
    expect(exec).toBeDefined();
    const status = items.filter((i) => i.kind === "statusLine");
    expect(status).toHaveLength(1);
    expect(JSON.stringify(status[0])).toContain("蓝图");
  });

  it("keeps the original Job id on a recoverable failed execution group", () => {
    const jobId = "ocj-recoverable-original";
    const items = projectFlow({
      session: makeSession({ activityState: "failed_recoverable" }),
      messages: [],
      jobs: [
        makeJob({
          id: jobId,
          status: "failed_recoverable",
          errorMessage: "可恢复失败",
        }),
      ],
      events: [],
      configTasks: [],
      commands: [],
    });

    expect(items.find((item) => item.kind === "execGroup")).toMatchObject({
      kind: "execGroup",
      title: "代码生成失败（可修复）",
      retryJobId: jobId,
    });
  });

  it("keeps a failed Build audit row but suppresses retry after the same execution produced a Candidate", () => {
    const buildExecutionId = "ocx-stable-build-1";
    const failedJobId = "ocj-failed-after-candidate";
    const items = projectFlow({
      session: makeSession({ activityState: "failed_recoverable" }),
      messages: [],
      jobs: [
        makeJob({
          id: "ocj-candidate-bearing-sibling",
          buildExecutionId,
          status: "cancelled",
          candidatePackageVersionId: "ocpv-existing-candidate",
          candidateHeadId: "och-existing-candidate",
          createdAt: NOW - 40_000,
          finishedAt: NOW - 20_000,
          updatedAt: NOW - 20_000,
        }),
        makeJob({
          id: failedJobId,
          buildExecutionId,
          status: "failed_recoverable",
          errorMessage: "后续恢复未完成",
          createdAt: NOW - 19_000,
          finishedAt: NOW - 10_000,
          updatedAt: NOW - 10_000,
        }),
      ],
      events: [],
      configTasks: [],
      commands: [],
    });

    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "execGroup",
        id: `exec-${failedJobId}`,
        title: "代码生成失败（可修复）",
      }),
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ retryJobId: failedJobId }),
    );
  });

  it("turns structured waiting questions and open config tasks into action cards", () => {
    const items = projectFlow({
      session: makeSession({ activityState: "needs_user" }),
      messages: [],
      jobs: [makeJob({ status: "waiting_user" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "q-1",
              kind: "decision",
              question: "评分阈值取多少？",
              why: "规则 R-087 给 75，历史 P50=71",
              options: [
                { label: "75（推荐）", value: "75", recommended: true },
                { label: "80", value: "80" },
              ],
              allowOther: true,
            },
          },
        }),
      ],
      configTasks: [OPEN_CONFIG_TASK],
      commands: [],
    });
    const cards = items.filter((i) => i.kind === "actionCard");
    expect(cards.length).toBe(2);
    const decision = cards.find((c) => c.card?.kind === "decision");
    expect(decision?.card?.options?.some((o) => o.recommended)).toBe(true);
    expect(decision?.card?.allowOther).toBe(true);
    const config = cards.find((c) => c.card?.kind === "config");
    expect(config?.card?.title).toContain("RoboHire");
    expect(collectVisibleText(items)).not.toMatch(FORBIDDEN_VOCABULARY);
  });

  it("recovers legacy batch Markdown into compact, selectable config items", () => {
    const rawQuestion =
      "Agent Factory 需要你的回答：以下几项需要你拍板：\n\n**1. 1. createJD 的 RAAS sandbox 怎么继续？**\n背景：需要读取真实需求。\nA. 我现在提供非密钥配置 ★推荐\nB. 已在服务器配置\nC. 暂停\n\n**2. 2. GoHire sandbox 怎么处理？**\n背景：不能把真实 key 发到聊天。\nA. 我现在提供环境变量名（推荐）\nB. 复用现有 profile\nC. 暂停\n背景：批量决策 · 2 项";
    const items = projectFlow({
      session: makeSession({ activityState: "needs_user" }),
      messages: [
        makeMessage({
          role: "assistant",
          content: { text: rawQuestion, status: "waiting_user" },
        }),
      ],
      jobs: [makeJob({ status: "waiting_user" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "hitl-batch",
              kind: "config",
              question: rawQuestion,
              options: [],
              allowOther: true,
              // Durable historical rows sometimes contain unrelated tokens and
              // a non-item order; mapping must follow item text, not position.
              systems: ["Job_Posting", "GoHire_System", "RAAS_System"],
            },
          },
        }),
      ],
      configTasks: [],
      commands: [],
    });
    const card = items.find(
      (item) => item.kind === "actionCard" && item.card.kind === "config",
    );
    expect(card?.kind).toBe("actionCard");
    if (!card || card.kind !== "actionCard") return;
    expect(card.card.title).toBe("2 项配置");
    expect(card.card.title).not.toContain("**");
    expect(card.card.items).toHaveLength(2);
    expect(card.card.items?.[0]).toMatchObject({
      question: "createJD 的 RAAS sandbox 怎么继续？",
      system: "RAAS_System",
    });
    expect(card.card.items?.[1]).toMatchObject({
      question: "GoHire sandbox 怎么处理？",
      system: "GoHire_System",
    });
    expect(
      card.card.items?.[0]?.options.some((option) => option.recommended),
    ).toBe(true);
    expect(items.some((item) => item.kind === "aiText")).toBe(false);
    expect(collectVisibleText(items)).not.toContain("**1.");
  });

  it("compacts a single config prompt while preserving its selectable options", () => {
    const items = projectFlow({
      session: makeSession({ activityState: "needs_user" }),
      messages: [],
      jobs: [makeJob({ status: "waiting_user" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "hitl-single",
              kind: "config",
              question:
                "Agent Factory 需要你的回答：请确认 GoHire sandbox 如何继续？\n背景：真实 key 不能发到会话。\n可选回答：\n1. 使用服务器配置",
              options: [
                {
                  label: "使用服务器配置",
                  value: "reuse-profile",
                  recommended: true,
                },
              ],
              allowOther: true,
              systems: ["GoHire_System"],
            },
          },
        }),
      ],
      configTasks: [],
      commands: [],
    });
    const card = items.find(
      (item) => item.kind === "actionCard" && item.card.refId === "hitl-single",
    );
    expect(card).toMatchObject({
      kind: "actionCard",
      card: {
        title: "请确认 GoHire sandbox 如何继续？",
        items: [
          {
            question: "请确认 GoHire sandbox 如何继续？",
            system: "GoHire_System",
            options: [{ label: "使用服务器配置", recommended: true }],
          },
        ],
      },
    });
  });

  it("humanizes every historical waiting-card field without rewriting answer values", () => {
    const items = projectFlow({
      session: makeSession({ activityState: "needs_user" }),
      messages: [],
      jobs: [makeJob({ status: "waiting_user" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "hitl-historical-engine-copy",
              kind: "config",
              question: "Agent Factory 需要你的回答：请确认构建方式？",
              why: "Harness 正在等待 Factory checkpoint。",
              impact: "将恢复 factory_waiting_checkpoint。",
              items: [
                {
                  id: "build-mode",
                  question: "Agent Factory 如何继续？",
                  context: "Harness 会保留 factory_retry 回执。",
                  options: [
                    {
                      label: "让 Factory 继续",
                      value: "Factory::continue",
                      recommended: true,
                    },
                  ],
                },
              ],
              options: [
                {
                  label: "让 Harness 重试",
                  value: "Harness::retry",
                },
              ],
              allowOther: true,
            },
          },
        }),
      ],
      configTasks: [],
      commands: [],
    });

    const item = items.find(
      (candidate) =>
        candidate.kind === "actionCard" &&
        candidate.card.refId === "hitl-historical-engine-copy",
    );
    expect(item?.kind).toBe("actionCard");
    if (!item || item.kind !== "actionCard") return;

    const visible = collectVisibleText([item]);
    expect(visible).not.toMatch(
      /Agent Factory|\bFactory\b|\bHarness\b|\bfactory_/u,
    );
    expect(visible).toContain("OntoCode");
    expect(visible).toContain("ontocode_build_resume_state_unavailable");
    expect(item.card.options?.[0]?.value).toBe("Harness::retry");
    expect(item.card.items?.[0]?.options[0]?.value).toBe("Factory::continue");
  });

  it("humanizes legacy Markdown labels without rewriting synthesized answer values", () => {
    const rawQuestion =
      "Agent Factory 需要你的回答：请选择：\n\n**1. 构建如何继续？**\n背景：Harness 已停在 factory_checkpoint。\nA. 让 Factory 继续 ★推荐\nB. 暂停\n背景：批量决策 · 1 项";
    const items = projectFlow({
      session: makeSession({ activityState: "needs_user" }),
      messages: [],
      jobs: [makeJob({ status: "waiting_user" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "hitl-legacy-engine-copy",
              kind: "config",
              question: rawQuestion,
              options: [],
              allowOther: true,
            },
          },
        }),
      ],
      configTasks: [],
      commands: [],
    });
    const item = items.find(
      (candidate) =>
        candidate.kind === "actionCard" &&
        candidate.card.refId === "hitl-legacy-engine-copy",
    );
    expect(item?.kind).toBe("actionCard");
    if (!item || item.kind !== "actionCard") return;

    expect(collectVisibleText([item])).not.toMatch(
      /Agent Factory|\bFactory\b|\bHarness\b|\bfactory_/u,
    );
    expect(item.card.items?.[0]?.options[0]).toMatchObject({
      // The displayed label names the OntoCode product; the submitted audit
      // value keeps the original historical text byte-for-byte.
      label: "让 OntoCode 继续",
      value: "A：让 Factory 继续",
    });
  });

  it("humanizes recommendation card copy while retaining its typed action", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          role: "assistant",
          content: {
            text: "可以查看详情。",
            recommendations: [
              {
                id: "historical-factory-inspection",
                kind: "inspection",
                title: "查看 Agent Factory 证据",
                reason: "Harness 已经保存回执。",
                impact: "只读打开 factory_build 结果。",
                recommended: true,
                action: {
                  type: "navigate",
                  target: "evidence",
                  label: "打开 Factory 证据",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    const item = items.find(
      (candidate) =>
        candidate.kind === "actionCard" &&
        candidate.card.refId === "historical-factory-inspection",
    );
    expect(item?.kind).toBe("actionCard");
    if (!item || item.kind !== "actionCard") return;

    expect(collectVisibleText([item])).not.toMatch(
      /Agent Factory|\bFactory\b|\bHarness\b|\bfactory_/u,
    );
    expect(item.card.recommendation?.action).toMatchObject({
      type: "navigate",
      target: "evidence",
      label: "打开 Factory 证据",
    });
    expect(item.card.inspectorTarget).toBe("evidence");
  });

  it("routes an evidence navigation recommendation to the evidence inspector, not artifacts", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          role: "assistant",
          content: {
            text: "验证已完成。",
            recommendations: [
              {
                id: "review-evidence",
                kind: "inspection",
                title: "查看验证证据",
                reason: "证据记录已持久化。",
                recommended: true,
                action: {
                  type: "navigate",
                  target: "evidence",
                  label: "查看证据",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    const recommendation = items.find(
      (item) =>
        item.kind === "actionCard" && item.card.refId === "review-evidence",
    );
    expect(recommendation).toMatchObject({
      kind: "actionCard",
      card: {
        inspectorTarget: "evidence",
        options: [{ label: "查看证据" }],
      },
    });
  });

  it("routes a map navigation recommendation to the map inspector, not artifacts", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          role: "assistant",
          content: {
            text: "范围已确定。",
            recommendations: [
              {
                id: "review-map",
                kind: "inspection",
                title: "在地图中查看节点关系",
                reason: "事件与动作的连接已可视化。",
                recommended: true,
                action: {
                  type: "navigate",
                  target: "map",
                  label: "查看地图",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    const recommendation = items.find(
      (item) => item.kind === "actionCard" && item.card.refId === "review-map",
    );
    expect(recommendation).toMatchObject({
      kind: "actionCard",
      card: {
        inspectorTarget: "map",
        options: [{ label: "查看地图" }],
      },
    });
  });

  it("routes a changes navigation recommendation to the changes inspector, not artifacts", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          role: "assistant",
          content: {
            text: "语义变更已生成。",
            recommendations: [
              {
                id: "review-changes",
                kind: "inspection",
                title: "查看语义变更",
                reason: "变更操作已持久化。",
                recommended: true,
                action: {
                  type: "navigate",
                  target: "changes",
                  label: "查看变更",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    const recommendation = items.find(
      (item) =>
        item.kind === "actionCard" && item.card.refId === "review-changes",
    );
    expect(recommendation).toMatchObject({
      kind: "actionCard",
      card: {
        inspectorTarget: "changes",
        options: [{ label: "查看变更" }],
      },
    });
  });

  it("routes a tests navigation recommendation to the tests inspector, not artifacts", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          role: "assistant",
          content: {
            text: "测试已完成。",
            recommendations: [
              {
                id: "review-tests",
                kind: "inspection",
                title: "查看测试结果",
                reason: "测试汇总已持久化。",
                recommended: true,
                action: {
                  type: "navigate",
                  target: "tests",
                  label: "查看测试",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    const recommendation = items.find(
      (item) =>
        item.kind === "actionCard" && item.card.refId === "review-tests",
    );
    expect(recommendation).toMatchObject({
      kind: "actionCard",
      card: {
        inspectorTarget: "tests",
        options: [{ label: "查看测试" }],
      },
    });
  });

  it("retains strictly validated configure, execute, reply and navigate actions", () => {
    const user = makeMessage({
      id: "ocm-user-tool-request",
      role: "user",
      content: { text: "请为 GoHire 创建 generateJdApi 工具，只保存草稿。" },
      correlationId: "cor-tool-authoring",
      createdAt: NOW - 2_000,
    });
    const items = projectFlow({
      session: makeSession(),
      messages: [
        user,
        makeMessage({
          id: "ocm-assistant-actions",
          role: "assistant",
          correlationId: "cor-tool-authoring",
          createdAt: NOW - 1_000,
          content: {
            text: "可以先建立受控工具任务。",
            recommendations: [
              {
                id: "author-gohire-tool",
                kind: "configuration",
                title: "创建 GoHire 工具草稿",
                reason: "用户明确要求创建工具。",
                impact: "只创建 Configuration Task，不激活运行时。",
                recommended: true,
                action: {
                  type: "configure",
                  label: "进入 Tool-Smith",
                  destination: "tool_authoring",
                  systemName: "GoHire_System",
                  toolName: "generateJdApi",
                  toolIntent: "调用 GoHire sandbox 生成职位描述。",
                },
              },
              {
                id: "run-scope",
                kind: "execution",
                title: "重新分析范围",
                reason: "范围需要刷新。",
                recommended: false,
                action: {
                  type: "execute",
                  label: "分析范围",
                  turnAction: "analyze_scope",
                },
              },
              {
                id: "reply-boundary",
                kind: "decision",
                title: "确认边界",
                reason: "需要用户明确选择。",
                recommended: false,
                action: {
                  type: "reply",
                  label: "只生成草稿",
                  value: "只生成草稿，不激活。",
                },
              },
              {
                id: "open-tests",
                kind: "navigation",
                title: "查看测试",
                reason: "测试视图是只读的。",
                recommended: false,
                action: {
                  type: "navigate",
                  label: "打开测试",
                  target: "tests",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });

    const recommendations = items.filter(
      (item): item is Extract<(typeof items)[number], { kind: "actionCard" }> =>
        item.kind === "actionCard" && Boolean(item.card.recommendation),
    );
    expect(recommendations).toHaveLength(4);
    expect(
      recommendations.map((item) => item.card.recommendation?.action.type),
    ).toEqual(["configure", "execute", "reply", "navigate"]);
    expect(recommendations[0]).toMatchObject({
      kind: "actionCard",
      card: {
        kind: "config",
        primaryLabel: "进入 Tool-Smith",
        recommendation: {
          sourceUserMessageId: "ocm-user-tool-request",
          sourceUserIntent: "请为 GoHire 创建 generateJdApi 工具，只保存草稿。",
        },
      },
    });
    expect(recommendations[3]).toMatchObject({
      kind: "actionCard",
      card: { inspectorTarget: "tests" },
    });
  });

  it("drops malformed or semantically mismatched recommendation actions", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          role: "assistant",
          content: {
            text: "这些动作都不应获得界面权限。",
            recommendations: [
              {
                id: "wrong-kind",
                kind: "execution",
                title: "伪装配置",
                reason: "kind 与 action 不一致。",
                action: {
                  type: "configure",
                  label: "创建",
                  destination: "tool_authoring",
                  systemName: "GoHire_System",
                  toolName: "generateJdApi",
                },
              },
              {
                id: "unknown-action",
                kind: "execution",
                title: "未知执行",
                reason: "不在执行白名单。",
                action: {
                  type: "execute",
                  label: "部署",
                  turnAction: "deploy_release",
                },
              },
              {
                id: "bad-identifier",
                kind: "configuration",
                title: "坏标识",
                reason: "systemName 不是 Identifier。",
                action: {
                  type: "configure",
                  label: "创建",
                  destination: "tool_authoring",
                  systemName: "GoHire System",
                  toolName: "generateJdApi",
                },
              },
              {
                id: "extra-authority",
                kind: "navigation",
                title: "额外字段",
                reason: "严格 action 不接受额外字段。",
                action: {
                  type: "navigate",
                  label: "打开",
                  target: "evidence",
                  href: "https://attacker.invalid",
                },
              },
            ],
          },
        }),
      ],
      jobs: [],
      events: [],
      configTasks: [],
      commands: [],
    });
    expect(
      items.filter(
        (item) => item.kind === "actionCard" && item.card.recommendation,
      ),
    ).toHaveLength(0);
  });
});

/* ---------------------- 行动卡生命周期（纯函数） ---------------------- */

const SCOPE_RECOMMENDATION_KEY = "assistant:ocm-assistant-scope:run-scope";

function makeCommand(
  overrides: Partial<OntoCodeCommand> = {},
): OntoCodeCommand {
  return {
    id: "occ-1111111122222222",
    tenantId: "ten-raas",
    sessionId: "ocs-1111222233334444",
    type: "analyze_scope",
    arguments: {
      [RECOMMENDATION_COMMAND_ARGUMENT_KEY]: SCOPE_RECOMMENDATION_KEY,
    },
    expectedSessionRevision: 4,
    baseOntologyHash: null,
    basePackageVersionId: null,
    affectedSemanticPaths: [],
    riskClass: "read_only",
    requestedCapabilities: [],
    status: "queued",
    requiresHuman: false,
    rationaleSummary: "分析 Agent 生成范围",
    idempotencyKey: "idem-scope-1",
    createdBy: null,
    createdAt: NOW - 30_000,
    updatedAt: NOW - 30_000,
    ...overrides,
  };
}

function makeScopeCard(overrides: Partial<ActionCardVM> = {}): ActionCardVM {
  return {
    kind: "system",
    origin: "assistant_recommendation",
    refId: "run-scope",
    title: "分析 Agent 生成范围",
    why: "范围需要刷新。",
    impact: "将识别出 17 个事件",
    primaryLabel: "开始 Scope 分析",
    options: [{ label: "开始 Scope 分析", value: "analyze_scope" }],
    recommendation: {
      id: "run-scope",
      kind: "execution",
      recommended: true,
      sourceMessageId: "ocm-assistant-scope",
      blockerKey: SCOPE_RECOMMENDATION_KEY,
      action: {
        type: "execute",
        label: "开始 Scope 分析",
        turnAction: "analyze_scope",
      },
    },
    ...overrides,
  };
}

describe("deriveActionCardLifecycle", () => {
  it("keeps a recommendation proposed when no Command and no matching stage exist", () => {
    expect(
      deriveActionCardLifecycle({
        card: makeScopeCard(),
        proposedAt: NOW - 40_000,
        jobs: [],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("keeps a recommendation proposed when the only matching stage finished before the card was proposed", () => {
    // 卡片是在那次范围分析之后才提出的——它请求的是一次新的分析，不是旧的那次。
    expect(
      deriveActionCardLifecycle({
        card: makeScopeCard(),
        proposedAt: NOW - 20_000,
        jobs: [
          makeJob({
            id: "ocj-scope-old",
            kind: "scope",
            status: "succeeded",
            createdAt: NOW - 60_000,
            finishedAt: NOW - 55_000,
          }),
        ],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("reports running from the exact Command the card created", () => {
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-live",
          commandId: "occ-1111111122222222",
          kind: "scope",
          status: "running",
          createdAt: NOW - 29_000,
          finishedAt: null,
        }),
      ],
      commands: [makeCommand({ status: "running" })],
    });
    expect(lifecycle.state).toBe("running");
    expect(lifecycle.basis).toBe("exact");
    expect(lifecycle.label).toBe("进行中");
  });

  it("reports done with the real outcome from the exact Command the card created", () => {
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-done",
          commandId: "occ-1111111122222222",
          kind: "scope",
          status: "succeeded",
          createdAt: NOW - 29_000,
          finishedAt: NOW - 20_000,
        }),
      ],
      commands: [makeCommand({ status: "succeeded" })],
    });
    expect(lifecycle.state).toBe("done");
    expect(lifecycle.basis).toBe("exact");
    expect(lifecycle.label).toContain("已完成");
    expect(lifecycle.label).toContain("范围分析");
  });

  it("reports failed from the exact Command the card created", () => {
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-bad",
          commandId: "occ-1111111122222222",
          kind: "scope",
          status: "failed_terminal",
          createdAt: NOW - 29_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      commands: [makeCommand({ status: "failed" })],
    });
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.basis).toBe("exact");
    expect(lifecycle.label).toContain("失败");
  });

  it("reports superseded when a matching stage ran after the card without an attributable Command", () => {
    // FDE 看到的正是这一幕：卡片还在请求「开始 Scope 分析」，而范围分析早已跑完。
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-anon",
          commandId: null,
          kind: "scope",
          status: "succeeded",
          createdAt: NOW - 30_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      commands: [],
    });
    expect(lifecycle.state).toBe("superseded");
    expect(lifecycle.basis).toBe("stage");
    expect(lifecycle.label).toContain("已执行过");
  });

  it("does not mark a card superseded by a failed run — the failure keeps its recovery affordance", () => {
    // 「已执行过」是一句陈述：这一步真的跑成过。失败的尝试不是执行记录——
    // 拿它 supersede 会把按钮吞掉，恰好复活「按钮与事实不符」的原始缺陷。
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-failed",
          commandId: null,
          kind: "scope",
          status: "failed_terminal",
          createdAt: NOW - 30_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      commands: [],
    });
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.basis).toBe("stage");
    expect(lifecycle.label).toContain("失败");
    expect(lifecycle.label).not.toContain("已执行过");
  });

  it("reports a later cancelled run as cancelled, never as 已执行过", () => {
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-cancelled",
          commandId: null,
          kind: "scope",
          status: "cancelled",
          createdAt: NOW - 30_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      commands: [],
    });
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.basis).toBe("stage");
    expect(lifecycle.label).toContain("已取消");
    expect(lifecycle.label).not.toContain("已执行过");
  });

  it("treats a recoverable failure the same way — failed with the button kept", () => {
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-recoverable",
          commandId: null,
          kind: "scope",
          status: "failed_recoverable",
          createdAt: NOW - 30_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      commands: [],
    });
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.basis).toBe("stage");
  });

  it("lets a real success supersede regardless of a failed sibling attempt", () => {
    const failedThenSucceeded = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-f1",
          commandId: null,
          kind: "scope",
          status: "failed_terminal",
          createdAt: NOW - 30_000,
          finishedAt: NOW - 29_000,
        }),
        makeJob({
          id: "ocj-scope-s1",
          commandId: null,
          kind: "scope",
          status: "succeeded",
          createdAt: NOW - 20_000,
          finishedAt: NOW - 15_000,
        }),
      ],
      commands: [],
    });
    expect(failedThenSucceeded.state).toBe("superseded");

    // 反向顺序同判：成功真实存在，之后一次失败的重试不能把它注销。
    const succeededThenFailed = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-s2",
          commandId: null,
          kind: "scope",
          status: "succeeded",
          createdAt: NOW - 30_000,
          finishedAt: NOW - 25_000,
        }),
        makeJob({
          id: "ocj-scope-f2",
          commandId: null,
          kind: "scope",
          status: "failed_terminal",
          createdAt: NOW - 20_000,
          finishedAt: NOW - 15_000,
        }),
      ],
      commands: [],
    });
    expect(succeededThenFailed.state).toBe("superseded");
  });

  it("stays proposed when the only failure predates the card — ambiguous stays ambiguous", () => {
    expect(
      deriveActionCardLifecycle({
        card: makeScopeCard(),
        proposedAt: NOW - 20_000,
        jobs: [
          makeJob({
            id: "ocj-scope-old-failed",
            commandId: null,
            kind: "scope",
            status: "failed_terminal",
            createdAt: NOW - 60_000,
            finishedAt: NOW - 55_000,
          }),
        ],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("reports running when a matching stage is in flight even though nothing links it to the card", () => {
    const lifecycle = deriveActionCardLifecycle({
      card: makeScopeCard(),
      proposedAt: NOW - 40_000,
      jobs: [
        makeJob({
          id: "ocj-scope-flight",
          commandId: null,
          kind: "scope",
          status: "running",
          createdAt: NOW - 50_000,
          finishedAt: null,
        }),
      ],
      commands: [],
    });
    expect(lifecycle.state).toBe("running");
    expect(lifecycle.basis).toBe("stage");
  });

  it("never attributes a Command stamped by a different recommendation", () => {
    expect(
      deriveActionCardLifecycle({
        card: makeScopeCard(),
        proposedAt: NOW - 40_000,
        jobs: [],
        commands: [
          makeCommand({
            id: "occ-other",
            arguments: {
              [RECOMMENDATION_COMMAND_ARGUMENT_KEY]:
                "assistant:ocm-other:another-card",
            },
            status: "succeeded",
          }),
        ],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("leaves a still-waiting question card answerable", () => {
    const card: ActionCardVM = {
      kind: "config",
      origin: "harness_question",
      refId: "hitl-1",
      questionId: "hitl-1",
      jobId: "ocj-9999888877776666",
      title: "GoHire sandbox 怎么处理？",
    };
    expect(
      deriveActionCardLifecycle({
        card,
        proposedAt: NOW - 40_000,
        jobs: [makeJob({ status: "waiting_user" })],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("settles a question card once its job left the waiting state", () => {
    const card: ActionCardVM = {
      kind: "config",
      origin: "harness_question",
      refId: "hitl-1",
      questionId: "hitl-1",
      jobId: "ocj-9999888877776666",
      title: "GoHire sandbox 怎么处理？",
    };
    const lifecycle = deriveActionCardLifecycle({
      card,
      proposedAt: NOW - 40_000,
      jobs: [makeJob({ kind: "build", status: "succeeded" })],
      commands: [],
    });
    expect(lifecycle.state).toBe("done");
    expect(lifecycle.basis).toBe("job");
    expect(lifecycle.label).toContain("已处理");
  });

  it("reads an answered question from the resolution record, not from the cancelled job it leaves behind", () => {
    // 回答一个等待中的问题，服务端会把那个作业置为 cancelled 并另起一个。
    // 只看 status 会把「已回答」说成「已取消」——那是在冤枉用户。
    const card: ActionCardVM = {
      kind: "config",
      origin: "harness_question",
      refId: "hitl-1",
      questionId: "hitl-1",
      jobId: "ocj-9999888877776666",
      title: "GoHire sandbox 怎么处理？",
    };
    const lifecycle = deriveActionCardLifecycle({
      card,
      proposedAt: NOW - 40_000,
      jobs: [makeJob({ status: "cancelled" })],
      commands: [],
      resolvedQuestionJobIds: new Set(["ocj-9999888877776666"]),
    });
    expect(lifecycle.state).toBe("done");
    expect(lifecycle.label).toBe("已回答");
    expect(lifecycle.basis).toBe("job");
  });

  it("still reports a genuinely cancelled question as cancelled", () => {
    const card: ActionCardVM = {
      kind: "config",
      origin: "harness_question",
      refId: "hitl-1",
      questionId: "hitl-1",
      jobId: "ocj-9999888877776666",
      title: "GoHire sandbox 怎么处理？",
    };
    const lifecycle = deriveActionCardLifecycle({
      card,
      proposedAt: NOW - 40_000,
      jobs: [makeJob({ status: "cancelled" })],
      commands: [],
      resolvedQuestionJobIds: new Set(),
    });
    expect(lifecycle.state).toBe("failed");
    expect(lifecycle.label).toContain("已取消");
  });

  it("does not invent a state for a question card whose job is not in the loaded page", () => {
    const card: ActionCardVM = {
      kind: "decision",
      origin: "harness_question",
      refId: "hitl-2",
      questionId: "hitl-2",
      jobId: "ocj-not-loaded",
      title: "评分阈值取多少？",
    };
    expect(
      deriveActionCardLifecycle({
        card,
        proposedAt: NOW - 40_000,
        jobs: [makeJob({ status: "succeeded" })],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("never settles a Configuration Task card from its waiting job's status", () => {
    // 配置任务的存续只由它自己的 status 决定；作业跑完不代表配置做完了。
    const card: ActionCardVM = {
      kind: "config",
      origin: "configuration_task",
      refId: "ocfg-4321432143214321",
      configTaskId: "ocfg-4321432143214321",
      jobId: "ocj-9999888877776666",
      title: "配置 RoboHire API 凭证",
    };
    expect(
      deriveActionCardLifecycle({
        card,
        proposedAt: NOW - 40_000,
        jobs: [makeJob({ status: "succeeded" })],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("leaves non-executing recommendations answerable", () => {
    const reply = makeScopeCard({
      kind: "decision",
      recommendation: {
        id: "reply-boundary",
        kind: "decision",
        recommended: false,
        sourceMessageId: "ocm-assistant-scope",
        blockerKey: "assistant:ocm-assistant-scope:reply-boundary",
        action: { type: "reply", label: "只生成草稿", value: "只生成草稿。" },
      },
    });
    expect(
      deriveActionCardLifecycle({
        card: reply,
        proposedAt: NOW - 40_000,
        jobs: [makeJob({ kind: "scope", status: "succeeded" })],
        commands: [],
      }),
    ).toEqual({ state: "proposed" });
  });

  it("keeps every lifecycle chip free of internal state-machine vocabulary", () => {
    const jobStatuses = [
      "queued",
      "leased",
      "running",
      "waiting_user",
      "retry_scheduled",
      "failed_recoverable",
      "failed_terminal",
      "cancelled",
      "succeeded",
    ] as const;
    const labels = jobStatuses.flatMap((status) => {
      const lifecycle = deriveActionCardLifecycle({
        card: makeScopeCard(),
        proposedAt: NOW - 40_000,
        jobs: [
          makeJob({
            id: "ocj-scope-vocab",
            commandId: "occ-1111111122222222",
            kind: "scope",
            status,
            createdAt: NOW - 29_000,
          }),
        ],
        commands: [makeCommand()],
      });
      return lifecycle.label ? [lifecycle.label] : [];
    });
    expect(labels.length).toBe(jobStatuses.length);
    for (const label of labels) {
      expect(label).not.toMatch(FORBIDDEN_VOCABULARY);
      expect(label.length).toBeLessThanOrEqual(12);
    }
  });
});

describe("projectFlow · action card lifecycle", () => {
  it("marks the已完成 Scope recommendation as superseded instead of re-offering it", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          id: "ocm-assistant-scope",
          role: "assistant",
          createdAt: NOW - 40_000,
          content: {
            text: "我可以先分析生成范围。",
            recommendations: [
              {
                id: "run-scope",
                kind: "execution",
                title: "分析 Agent 生成范围",
                reason: "范围需要刷新。",
                impact: "将识别出 17 个事件",
                recommended: true,
                action: {
                  type: "execute",
                  label: "开始 Scope 分析",
                  turnAction: "analyze_scope",
                },
              },
            ],
          },
        }),
        makeMessage({
          id: "ocm-assistant-scope-done",
          role: "assistant",
          createdAt: NOW - 20_000,
          content: { text: "Ontology 范围分析已完成。" },
        }),
      ],
      jobs: [
        makeJob({
          id: "ocj-scope-anon",
          kind: "scope",
          status: "succeeded",
          createdAt: NOW - 30_000,
          startedAt: NOW - 29_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      events: [],
      configTasks: [],
      commands: [],
    });
    const card = items.find(
      (item) => item.kind === "actionCard" && item.card.refId === "run-scope",
    );
    expect(card?.kind).toBe("actionCard");
    if (!card || card.kind !== "actionCard") return;
    expect(card.card.origin).toBe("assistant_recommendation");
    expect(card.card.lifecycle?.state).toBe("superseded");
    expect(collectVisibleText(items)).toContain("已执行过");
    expect(collectVisibleText(items)).not.toMatch(FORBIDDEN_VOCABULARY);
  });

  it("keeps a failed stage from masquerading as 已执行过 in the projected flow", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [
        makeMessage({
          id: "ocm-assistant-scope",
          role: "assistant",
          createdAt: NOW - 40_000,
          content: {
            text: "我可以先分析生成范围。",
            recommendations: [
              {
                id: "run-scope",
                kind: "execution",
                title: "分析 Agent 生成范围",
                reason: "范围需要刷新。",
                impact: "将识别出 17 个事件",
                recommended: true,
                action: {
                  type: "execute",
                  label: "开始 Scope 分析",
                  turnAction: "analyze_scope",
                },
              },
            ],
          },
        }),
      ],
      jobs: [
        makeJob({
          id: "ocj-scope-anon-failed",
          kind: "scope",
          status: "failed_terminal",
          createdAt: NOW - 30_000,
          startedAt: NOW - 29_000,
          finishedAt: NOW - 25_000,
        }),
      ],
      events: [],
      configTasks: [],
      commands: [],
    });
    const card = items.find(
      (item) => item.kind === "actionCard" && item.card.refId === "run-scope",
    );
    expect(card?.kind).toBe("actionCard");
    if (!card || card.kind !== "actionCard") return;
    expect(card.card.lifecycle?.state).toBe("failed");
    expect(card.card.lifecycle?.label).toContain("失败");
    const visible = collectVisibleText(items);
    expect(visible).not.toContain("已执行过");
    expect(visible).not.toMatch(FORBIDDEN_VOCABULARY);
  });

  it("settles an answered question card from the durable resolution event", () => {
    const items = projectFlow({
      session: makeSession(),
      messages: [],
      jobs: [makeJob({ status: "cancelled" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "q-answered",
              kind: "decision",
              question: "评分阈值取多少？",
              options: [{ label: "75", value: "75" }],
            },
          },
        }),
        makeEvent({
          id: "oce-resolved",
          seq: 9,
          type: "harness.job.input_resolved",
          harnessJobId: "ocj-followup",
          payload: {
            waitingJobId: "ocj-9999888877776666",
            followUpJobId: "ocj-followup",
          },
          createdAt: NOW - 30_000,
        }),
      ],
      configTasks: [],
      commands: [],
    });
    const card = items.find(
      (item) => item.kind === "actionCard" && item.card.refId === "q-answered",
    );
    expect(card?.kind).toBe("actionCard");
    if (!card || card.kind !== "actionCard") return;
    expect(card.card.lifecycle).toEqual({
      state: "done",
      label: "已回答",
      basis: "job",
    });
  });

  it("stamps every projected action card with its provenance", () => {
    const items = projectFlow({
      session: makeSession({ activityState: "needs_user" }),
      messages: [],
      jobs: [makeJob({ status: "waiting_user" })],
      events: [
        makeEvent({
          type: "harness.build.waiting_user",
          payload: {
            question: {
              id: "q-1",
              kind: "decision",
              question: "评分阈值取多少？",
              options: [{ label: "75", value: "75" }],
            },
          },
        }),
      ],
      configTasks: [OPEN_CONFIG_TASK],
      commands: [],
    });
    const origins = items
      .filter((item) => item.kind === "actionCard")
      .map((item) => (item.kind === "actionCard" ? item.card.origin : null));
    expect(origins).toContain("harness_question");
    expect(origins).toContain("configuration_task");
    expect(origins).not.toContain(undefined);
  });
});

describe("resumeActionForJobKind", () => {
  it("maps waiting job kinds to their matching resume actions", async () => {
    const { resumeActionForJobKind } = await import("./projection");
    expect(resumeActionForJobKind("build")).toBe("generate_package");
    expect(resumeActionForJobKind("blueprint")).toBe("propose_blueprint");
    expect(resumeActionForJobKind("test")).toBe("run_tests");
    expect(resumeActionForJobKind("promotion")).toBeNull();
  });
});
