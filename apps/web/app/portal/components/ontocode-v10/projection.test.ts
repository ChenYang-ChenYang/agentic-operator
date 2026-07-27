import { describe, expect, it } from "vitest";
import type {
  OntoCodeBuildSession,
  OntoCodeConfigurationTask,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import {
  collectVisibleText,
  FORBIDDEN_VOCABULARY,
  projectFlow,
  projectSessionRow,
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
    const row = projectSessionRow(makeSession({ activityState: "needs_user" }), {
      latestQuestion: "最终评分工具选哪个？",
    });
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

  it("maps idle without overview to a your-move hint", () => {
    const row = projectSessionRow(makeSession({ activityState: "idle" }));
    expect(row.sub).toContain("等你");
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
});
