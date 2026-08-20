import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainCtx } from "./brain-types";

vi.mock("./stream-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stream-gateway")>()),
  chatJson: vi.fn(),
  isGatewayConfigured: vi.fn(() => true),
}));

import { chatJson, isGatewayConfigured } from "./stream-gateway";
import { FACTORY_TOOLS } from "./tools";

const reviewAgent = FACTORY_TOOLS.find((tool) => tool.name === "review_agent")!;
const reviewContext = FACTORY_TOOLS.find((tool) => tool.name === "review_context")!;
const reviewCompleteness = FACTORY_TOOLS.find((tool) => tool.name === "review_completeness")!;

const ontology = {
  actions: [
    { name: "CreateJD", actor: ["Agent"], trigger: ["JD_REQUESTED"], triggered_event: ["JD_CREATED"] },
  ],
  events: [],
  objects: [],
  rules: [],
};

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionName: "CreateJD",
    nameZh: "创建职位",
    trigger: ["JD_REQUESTED"],
    emit: ["JD_CREATED"],
    tools: ["records.upsert"],
    systemPrompt: "收到职位创建请求后校验输入，并调用持久化工具创建职位记录。",
    decisionLogic: "输入有效时创建记录并发出完成事件。",
    ...overrides,
  };
}

function ctx(specs: unknown[]): BrainCtx {
  return {
    domain: "rec",
    ontology,
    ontologyUnderstanding: "职位创建动作消费请求事件并产出职位创建事件。",
    specs,
    attemptHistory: {},
    emit: () => {},
  } as unknown as BrainCtx;
}

beforeEach(() => {
  // Production intentionally has no implicit model id.  These tests mock the
  // gateway call itself but model routing still validates an explicit,
  // non-mock deployment choice before invoking that mock.
  vi.stubEnv("FACTORY_AI_MODEL", "test/review-model");
  vi.mocked(chatJson).mockReset();
  vi.mocked(isGatewayConfigured).mockReturnValue(true);
});

afterEach(() => vi.unstubAllEnvs());

describe("LLM-backed reviews fail closed", () => {
  it("blocks review_agent when the design judge returns no parseable JSON", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(null);

    const result = await reviewAgent.execute({}, ctx([spec()]));

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("unknown");
    expect(result.output).toMatchObject({ verdict: "unknown", failure: "llm_review_unavailable", blocking: true });
    expect((result.output as { reviewFailures: string[] }).reviewFailures[0]).toContain("设计裁判");
  });

  it("blocks review_agent when code review throws after a valid empty design verdict", async () => {
    vi.mocked(chatJson)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("code judge unavailable"));

    const result = await reviewAgent.execute({}, ctx([
      spec({ codeExecuted: true, generatedCode: "export async function handler() { return { ok: true }; }" }),
    ]));

    expect(result.ok).toBe(false);
    expect((result.output as { reviewFailures: string[] }).reviewFailures).toEqual([
      "生成代码质检: code judge unavailable",
    ]);
  });

  it("blocks context review when its LLM verdict is missing", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(null);

    const result = await reviewContext.execute({}, ctx([spec()]));

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ verdict: "unknown", failure: "llm_review_unavailable", blocking: true });
    expect((result.output as { reviewFailures: string[] }).reviewFailures[0]).toContain("上下文裁判");
  });

  it("anchors a scoped context review in the selected Action contract, not a conflicting full-domain digest", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce([]);
    const scoped = ctx([spec({ tools: ["generateJdApi"] })]);
    scoped.ontology = {
      ...ontology,
      actions: [
        {
          ...ontology.actions[0],
          integration: {
            systems: [
              {
                name: "GoHire_System",
                via_tool: "generateJdApi",
                capability: "jd.generate",
              },
            ],
          },
        },
        {
          name: "InviteInterview",
          actor: ["Agent"],
          trigger: ["INTERVIEW_REQUESTED"],
          triggered_event: ["INTERVIEW_STARTED"],
          target_objects: [],
          tool_use: [],
          system_prompt: "",
          user_prompt: "",
        },
      ],
    } as never;
    scoped.ontologyUnderstanding =
      "错误的全域旧摘要：GoHire_System 只属于 InviteInterview，CreateJD 不得调用。";
    scoped.generationDirective = {
      schema: "agent-factory-generation-directive/v1",
      mode: "action_selection",
      requestedActionIds: ["create-jd"],
      requestedActionNames: ["CreateJD"],
      requestedActions: [{ id: "create-jd", name: "CreateJD" }],
      sourceOntologyHash: "a".repeat(64),
    };

    const result = await reviewContext.execute({}, scoped);

    expect(result.ok).toBe(true);
    const [system, user] = vi.mocked(chatJson).mock.calls[0]!;
    expect(system).toContain("Action 权威契约");
    expect(system).toContain("本次服务端验收范围只有：CreateJD");
    expect(user).toContain("GoHire_System");
    expect(user).toContain("generateJdApi");
    expect(user).not.toContain("错误的全域旧摘要");
  });

  it("blocks completeness review on a structurally invalid LLM verdict", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce([{ gap: "missing edge case", severity: "critical" }]);

    const result = await reviewCompleteness.execute({}, ctx([spec()]));

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ verdict: "unknown", failure: "llm_review_unavailable", blocking: true });
    expect((result.output as { reviewFailures: string[] }).reviewFailures[0]).toContain("invalid severity");
  });

  it("accepts explicit [] verdicts as completed reviews with no findings", async () => {
    vi.mocked(chatJson).mockResolvedValue([]);

    const agentResult = await reviewAgent.execute({}, ctx([spec()]));
    const contextResult = await reviewContext.execute({}, ctx([spec()]));
    const completenessResult = await reviewCompleteness.execute({}, ctx([spec()]));

    expect(agentResult).toMatchObject({ ok: true, output: { verdict: "pass", reviewFailures: [] } });
    expect(contextResult).toMatchObject({ ok: true, output: { verdict: "pass", reviewFailures: [] } });
    expect(completenessResult).toMatchObject({ ok: true, output: { verdict: "pass", reviewFailures: [] } });
  });

  it("does not report a tool-free pure logic function as an integration gap", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce([]);

    const result = await reviewCompleteness.execute({}, ctx([spec({ tools: [] })]));

    expect(result).toMatchObject({ ok: true, output: { verdict: "pass", reviewFailures: [] } });
    expect((result.output as { deterministic: string[] }).deterministic).toEqual([]);
  });
});
