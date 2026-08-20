import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { factoryConversations, factoryHumanMemories, factoryRuns, getDb, tenants } from "@agentic/db";
import { humanMemoryQuestionKey } from "@agentic/agent-factory";
import { DrizzleConversationStore, recordRunStart } from "../src/services/agent-factory";
import { DrizzleHumanMemoryStore, humanMemoryFromInjectedMessage, redactHumanMemorySecrets } from "../src/services/agent-factory/human-memory-store";
import { buildTestEnv, type TestEnv } from "./harness";
import { FsUploadedOntologyStore } from "../src/services/agent-factory/uploaded-ontology-store";
import { clearFactoryDomainBinding, setFactoryDomainBinding } from "../src/services/agent-factory/domain-binding";
import { isFactoryAuthorizationChallengeContext } from "../src/routes/v1/agent-factory";

const suffix = Date.now().toString(36);
const tenantA = { id: `ten-hmem-a-${suffix}`, slug: `hmema${suffix}`.slice(0, 60) };
const tenantB = { id: `ten-hmem-b-${suffix}`, slug: `hmemb${suffix}`.slice(0, 60) };
const domain = `human-memory-${suffix}`;
const upload = new FsUploadedOntologyStore();

describe("factory human memory store + API", () => {
  let env: TestEnv;

  beforeAll(async () => {
    getDb().insert(tenants).values([
      { id: tenantA.id, slug: tenantA.slug, name: "Human memory A" },
      { id: tenantB.id, slug: tenantB.slug, name: "Human memory B" },
    ]).run();
    for (const tenant of [tenantA, tenantB]) {
      await upload.save(tenant.slug, "Human memory ontology", {
        actions: [{ name: "rememberHumanDecision", actor: ["Agent"] }],
      }, domain);
      setFactoryDomainBinding(tenant.id, { id: domain, name: "Human memory ontology" }, "upload");
    }
    env = await buildTestEnv();
  });

  afterAll(async () => {
    getDb().delete(factoryConversations).where(eq(factoryConversations.domain, domain)).run();
    getDb().delete(factoryRuns).where(eq(factoryRuns.domain, domain)).run();
    getDb().delete(factoryHumanMemories).where(eq(factoryHumanMemories.domain, domain)).run();
    for (const tenant of [tenantA, tenantB]) {
      try { clearFactoryDomainBinding(tenant.id); } catch { /* no active factory work */ }
      await upload.delete(tenant.slug, domain);
      getDb().delete(tenants).where(eq(tenants.id, tenant.id)).run();
    }
  });

  it("isolates tenant/domain, preserves pin on omitted updates, and rejects non-human provenance", async () => {
    const key = humanMemoryQuestionKey("clarify", "候选人的拒绝阈值？");
    const a = new DrizzleHumanMemoryStore(tenantA.id, domain);
    const created = await a.upsert(domain, {
      questionKey: key,
      kind: "clarify",
      question: "候选人的拒绝阈值？",
      answer: "综合分低于 60 时拒绝",
      source: "human",
      conversationId: "frn-human-1",
      pinned: true,
    });
    expect(created).toMatchObject({ source: "human", confirmed: true, pinned: true });

    const updated = await a.upsert(domain, {
      questionKey: key,
      kind: "clarify",
      question: "候选人的拒绝阈值？",
      answer: "综合分低于 65 时拒绝",
      source: "human",
    });
    expect(updated.pinned).toBe(true);
    expect((await new DrizzleHumanMemoryStore(tenantB.id, domain).list(domain)).length).toBe(0);
    await expect(a.list(`${domain}-other`)).rejects.toThrow(/domain mismatch/);
    await expect(a.upsert(domain, {
      questionKey: key,
      kind: "clarify",
      question: "AI attempted overwrite",
      answer: "replace pinned fact",
      source: "ai",
    } as never)).rejects.toThrow(/human-confirmed path/);
    expect((await a.list(domain))[0]?.answer).toBe("综合分低于 65 时拒绝");
  });

  it("redacts credential material before persistence and closes list/pin/delete API loop", async () => {
    expect(redactHumanMemorySecrets("Authorization: Bearer top-secret-token-123")).not.toContain("top-secret");
    const headers = { "content-type": "application/json", "x-agentic-tenant": tenantA.slug };
    const authHeaders = { "x-agentic-tenant": tenantA.slug };
    const created = await env.fetch("/v1/agent-factory/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({
        domain,
        kind: "directive",
        question: "外部服务如何认证？",
        answer: "api_key=super-secret-value",
        pinned: false,
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { data: { memory: { id: string; answer: string } } };
    expect(createdBody.data.memory.answer).toBe("api_key=[REDACTED]");

    const listed = await env.fetch(`/v1/agent-factory/memories?domain=${encodeURIComponent(domain)}`, { headers: authHeaders });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: { memories: Array<{ id: string }>; reflections: Array<{ source: string }> } };
    expect(listedBody.data.memories.map((entry) => entry.id)).toContain(createdBody.data.memory.id);
    expect(listedBody.data.reflections.every((entry) => entry.source === "ai")).toBe(true);

    const edited = await env.fetch(`/v1/agent-factory/memories/${encodeURIComponent(createdBody.data.memory.id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ domain, answer: "认证方式由平台密钥别名决定", context: "人工纠正", pinned: true }),
    });
    expect(edited.status).toBe(200);
    const editedBody = await edited.json() as { data: { memory: { answer: string; context?: string; pinned: boolean } } };
    expect(editedBody.data.memory).toMatchObject({
      answer: "认证方式由平台密钥别名决定",
      context: "人工纠正",
      pinned: true,
    });

    const pinned = await env.fetch(`/v1/agent-factory/memories/${encodeURIComponent(createdBody.data.memory.id)}/pin`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ domain, pinned: true }),
    });
    expect(pinned.status).toBe(200);

    const deleted = await env.fetch(`/v1/agent-factory/memories/${encodeURIComponent(createdBody.data.memory.id)}?domain=${encodeURIComponent(domain)}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(deleted.status).toBe(200);
  });

  it("persists a parked human answer during inject, before the conductor settles", async () => {
    const conversation = `frn-human-inject-${suffix}`;
    const interactionId = "hitl_11111111-1111-4111-8111-111111111111";
    recordRunStart(domain, "等待人工阈值", tenantA.id, conversation);
    await new DrizzleConversationStore(tenantA.id, domain).save(conversation, {
      domain,
      messages: [],
      ctx: {
        awaitingClarify: true,
        clarifyPrompt: { question: "自动拒绝阈值是多少？", context: "候选人筛选" },
        humanInteractions: {
          clarify: { interactionId, kind: "clarify", subjectDigest: "a".repeat(64), createdAt: Date.now() },
        },
      },
    });

    const textOnly = await env.fetch("/v1/agent-factory/inject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentic-tenant": tenantA.slug },
      body: JSON.stringify({ conversation, text: "[澄清回答] 没带卡片编号" }),
    });
    expect(textOnly.status).toBe(409);
    expect((await textOnly.json() as { error?: { code?: string; message?: string } }).error).toMatchObject({
      code: "human_interaction_id_required",
      message: expect.stringContaining("不会被当作批准或回答"),
    });

    const stale = await env.fetch("/v1/agent-factory/inject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentic-tenant": tenantA.slug },
      body: JSON.stringify({ conversation, interactionId: "hitl_22222222-2222-4222-8222-222222222222", kind: "clarify", text: "[澄清回答] 旧卡答案" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error?: { code?: string; message?: string } }).error).toMatchObject({
      code: "stale_human_interaction",
      message: expect.stringContaining("没有采用"),
    });

    const wrongKind = await env.fetch("/v1/agent-factory/inject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentic-tenant": tenantA.slug },
      body: JSON.stringify({ conversation, interactionId, kind: "boundary", text: "[边界事件决策] []" }),
    });
    expect(wrongKind.status).toBe(409);
    expect((await wrongKind.json() as { error?: { code?: string } }).error?.code).toBe("wrong_human_interaction_kind");

    const response = await env.fetch("/v1/agent-factory/inject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentic-tenant": tenantA.slug },
      body: JSON.stringify({ conversation, interactionId, kind: "clarify", text: "[澄清回答] 综合分低于 62" }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { data: { queued: boolean; active: boolean; memoryRecorded: boolean } };
    expect(body.data).toMatchObject({ queued: true, active: false, memoryRecorded: true });

    const duplicate = await env.fetch("/v1/agent-factory/inject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentic-tenant": tenantA.slug },
      body: JSON.stringify({ conversation, interactionId, kind: "clarify", text: "[澄清回答] 综合分低于 62" }),
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json() as { error?: { code?: string; message?: string } }).error).toMatchObject({
      code: "duplicate_human_interaction",
      message: expect.stringContaining("已经提交过"),
    });

    const stored = (await new DrizzleHumanMemoryStore(tenantA.id, domain).list(domain))
      .find((memory) => memory.question === "自动拒绝阈值是多少？");
    expect(stored).toMatchObject({
      kind: "clarify",
      answer: "综合分低于 62",
      source: "human",
      conversationId: conversation,
      confirmed: true,
    });
  });

  it("classifies only answers consumable by the current durable HITL gate", () => {
    expect(humanMemoryFromInjectedMessage({
      awaitingApproval: true,
      testCases: [{ id: "happy" }, { id: "reject" }],
    }, "[测试用例决策：重新生成] 增加 null 输入")).toMatchObject({
      kind: "test_approval",
      question: "是否执行测试用例集 happy,reject？",
      context: "decision=regenerate; note=增加 null 输入",
    });

    const boundary = humanMemoryFromInjectedMessage({ awaitingBoundary: true },
      '[边界事件决策] [{"event":"INTERVIEW_SENT","kind":"external","consumer":"ATS"}]');
    expect(boundary).toMatchObject({
      kind: "boundary",
      question: "边界事件分类：INTERVIEW_SENT",
    });
    expect(humanMemoryFromInjectedMessage({
      awaitingClarify: true,
      clarifyPrompt: { question: "邮箱？" },
    }, "停止")).toBeNull();
    expect(humanMemoryFromInjectedMessage({
      awaitingClarify: true,
      clarifyPrompt: { question: "邮箱？" },
    }, "[边界事件决策] not-json")).toBeNull();
    expect(humanMemoryFromInjectedMessage({ awaitingApproval: true }, "我再想想")).toBeNull();
    expect(humanMemoryFromInjectedMessage({ awaitingApproval: true }, "好")).toBeNull();
    expect(humanMemoryFromInjectedMessage({ awaitingApproval: true }, "我想补数据以后再执行")).toBeNull();
    expect(humanMemoryFromInjectedMessage({ awaitingApproval: true }, "重新生成的话，先看看")).toBeNull();
    expect(humanMemoryFromInjectedMessage({ awaitingApproval: true }, "[测试用例决策: maybe]")).toBeNull();
    expect(humanMemoryFromInjectedMessage({
      awaitingApproval: true,
      testCases: [{ id: "happy" }, { id: "binary-resume" }],
    }, "[测试用例决策：补数据] {\"case_payloads\":[]}")).toMatchObject({
      kind: "directive",
      question: "为测试用例集 happy,binary-resume 补数据",
      answer: "[测试用例决策：补数据] {\"case_payloads\":[]}",
      context: "decision=supply_data; note={\"case_payloads\":[]}",
    });
    expect(humanMemoryFromInjectedMessage({
      awaitingClarify: true,
      clarifyPrompt: {
        question: "是否批准当前设计进入沙箱？",
        context: `sandbox_design_review_authorization:v1:${"a".repeat(64)}`,
      },
    }, "批准进入沙箱")).toBeNull();
    const planContext = `sandbox_evidence_plan_authorization:v1:${"b".repeat(64)}`;
    expect(isFactoryAuthorizationChallengeContext(planContext)).toBe(true);
    expect(humanMemoryFromInjectedMessage({
      awaitingClarify: true,
      clarifyPrompt: {
        question: "是否一次确认整包 sandbox evidence plan？",
        context: planContext,
      },
    }, "确认整包仅用于沙箱")).toBeNull();
  });

  it("exposes rework as a seed-only route and fails honestly when no promoted draft exists", async () => {
    const response = await env.fetch("/v1/agent-factory/rework-seed", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentic-tenant": tenantA.slug },
      body: JSON.stringify({ domain, slug: "not-a-promoted-draft" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("draft_not_found");
  });
});
