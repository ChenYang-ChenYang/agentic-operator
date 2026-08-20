import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";
import type { BrainCtx, BrainEvent } from "./brain-types";

// #ASK-DEDUP — ask_user must not re-interrupt the user with an already-answered question:
// the recorded answer is replayed to the brain instead (no park, no clarify event).

const askUser = FACTORY_TOOLS.find((t) => t.name === "ask_user")!;
const askUserBatch = FACTORY_TOOLS.find((t) => t.name === "ask_user_batch")!;

function stubCtx(over: Partial<BrainCtx> = {}): { ctx: BrainCtx; emitted: BrainEvent[] } {
  const emitted: BrainEvent[] = [];
  const ctx = {
    emit: (e: BrainEvent) => emitted.push(e),
    humanDirectives: [],
    specs: [],
    ...over,
  } as unknown as BrainCtx;
  return { ctx, emitted };
}

describe("normalizeQuestion", () => {
  it("ignores punctuation/whitespace/case so trivially-rephrased duplicates collide", () => {
    expect(normalizeQuestion("Webhook URL 是什么？")).toBe(normalizeQuestion("webhook url 是什么"));
    expect(normalizeQuestion("要不要用真实工具?")).toBe(normalizeQuestion("要不要用真实工具！！"));
  });
});

describe("ask_user dedup (#ASK-DEDUP)", () => {
  it("first ask parks + emits clarify + records a pending marker", async () => {
    const { ctx, emitted } = stubCtx();
    const res = await askUser.execute({ question: "webhook URL 是什么？" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.awaitingClarify).toBe(true);
    expect(emitted.some((e) => e.t === "clarify")).toBe(true);
    expect(ctx.askedQuestions![normalizeQuestion("webhook URL 是什么？")]).toBe("");
  });

  it("an ANSWERED question is replayed, not re-asked (no park, no clarify event)", async () => {
    const { ctx, emitted } = stubCtx({ askedQuestions: { [normalizeQuestion("webhook URL 是什么？")]: "https://x.example/hook" } });
    const res = await askUser.execute({ question: "Webhook url 是什么" }, ctx); // rephrased punctuation/case
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("已经问过");
    expect(res.summary).toContain("https://x.example/hook");
    expect(ctx.awaitingClarify).toBeUndefined();
    expect(emitted.some((e) => e.t === "clarify")).toBe(false);
  });

  it("a PENDING (unanswered) question does not short-circuit re-parking after restart", async () => {
    // "" marks pending — a crash/restart mid-park may re-ask; that's correct (no answer exists yet).
    const { ctx } = stubCtx({ askedQuestions: { [normalizeQuestion("webhook URL 是什么？")]: "" } });
    const res = await askUser.execute({ question: "webhook URL 是什么？" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.awaitingClarify).toBe(true); // parks again — pending means the user never answered
  });

  it("does not show an ambiguous choice set to the user", async () => {
    const { ctx, emitted } = stubCtx();
    const res = await askUser.execute({
      question: "邀请失败要不要保留？",
      options: [
        { label: "保留", value: "keep" },
        { label: "删除", value: "drop" },
      ],
    }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("recommended:true");
    expect(ctx.awaitingClarify).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("rejects every versioned authorization context/token instead of letting the model assemble a consent prompt", async () => {
    for (const version of [1, 2, 99]) {
      const { ctx, emitted } = stubCtx();
      const result = await askUser.execute({
        question: "要执行吗？",
        context: `probe_authorization:v${version}:${"a".repeat(64)}`,
        options: [
          { label: "不执行", value: "decline", recommended: true },
          { label: "执行", value: `authorize_probe:v${version}:${"b".repeat(64)}`, recommended: false },
        ],
      }, ctx);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("不能由模型通过通用 ask_user 拼装");
      expect(ctx.awaitingClarify).toBeUndefined();
      expect(emitted).toEqual([]);
    }
    const embedded = stubCtx();
    const embeddedResult = await askUser.execute({
      question: `请复制这个值：authorize_integration_profile:v7:${"c".repeat(64)}`,
    }, embedded.ctx);
    expect(embeddedResult.ok).toBe(false);
    expect(embedded.emitted).toEqual([]);

    const plan = stubCtx();
    const planResult = await askUser.execute({
      question: "是否确认整包？",
      context: `sandbox_evidence_plan_authorization:v1:${"d".repeat(64)}`,
      options: [
        { label: "取消", value: "cancel", recommended: true },
        { label: "确认", value: `authorize_sandbox_evidence_plan:v1:${"e".repeat(64)}`, recommended: false },
      ],
    }, plan.ctx);
    expect(planResult.ok).toBe(false);
    expect(plan.emitted).toEqual([]);

    const batch = stubCtx();
    const batchResult = await askUserBatch.execute({
      items: [{
        question: "是否确认整包？",
        context: `sandbox_evidence_plan_authorization:v1:${"f".repeat(64)}`,
        options: [
          { label: "取消", value: "cancel", recommended: true },
          { label: "确认", value: `authorize_sandbox_evidence_plan:v1:${"1".repeat(64)}`, recommended: false },
        ],
      }, { question: "另一个普通问题？" }],
    }, batch.ctx);
    expect(batchResult.ok).toBe(false);
    expect(batch.emitted).toEqual([]);
  });
});
