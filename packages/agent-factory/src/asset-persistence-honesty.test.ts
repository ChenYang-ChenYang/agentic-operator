import { describe, expect, it } from "vitest";
import type { BrainCtx } from "./brain-types";
import type { DeclarativeTool } from "./ports";
import { FACTORY_TOOLS, persistedToolAsRealTool } from "./tools";

const createSkill = FACTORY_TOOLS.find((tool) => tool.name === "create_skill")!;
const createTool = FACTORY_TOOLS.find((tool) => tool.name === "create_tool")!;

function ctx(overrides: Partial<BrainCtx> = {}): BrainCtx {
  return {
    domain: "Hiring-v2",
    createdSkills: [],
    specs: [],
    toolCatalog: [],
    realTools: [],
    ontology: null,
    emit: () => {},
    ports: {},
    ...overrides,
  } as unknown as BrainCtx;
}

describe("factory asset persistence honesty", () => {
  it("treats legacy/unknown declarative side effects as guarded call, never read", () => {
    expect(persistedToolAsRealTool({
      name: "legacy.unknown",
      description: "legacy fixture",
      domain: "test-domain",
      method: "POST",
      urlTemplate: "https://api.example.test/legacy",
      sideEffect: "unknown",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
    }).sideEffect).toBe("call");
  });

  it("does not claim a skill was persisted when the tenant store rejects it", async () => {
    const c = ctx({
      ports: {
        skills: {
          save: async () => { throw new Error("tenant/domain collision"); },
          list: async () => [],
          bumpUse: async () => {},
          recordEval: async () => {},
        },
      } as unknown as BrainCtx["ports"],
    });
    const result = await createSkill.execute({
      name: "failure-aware-retry",
      purpose: "reuse failure-aware retry guidance",
      prompt_fragment: "对每次外部调用检查业务状态与关键字段；失败时保留上下文并采用有界退避，禁止把空响应当成功。",
      decision_rule: "关键字段为空或业务状态失败时进入有界重试",
    }, c);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("持久化入库失败");
    expect(result.output).toMatchObject({ inMemory: true, persisted: false });
    expect(c.createdSkills).toHaveLength(1);
  });

  it("does not claim a tool was persisted when the tenant store rejects it", async () => {
    const events: Array<{ t: string }> = [];
    const c = ctx({
      emit: (event) => events.push(event),
      ports: {
        tools: {
          saveDraft: async () => { throw new Error("write unavailable"); },
          list: async () => [],
        },
      } as unknown as BrainCtx["ports"],
    });
    const result = await createTool.execute({
      name: "acme.lookupCandidate",
      description: "Lookup one candidate",
      method: "GET",
      url_template: "https://api.example.test/candidates/{id}",
      side_effect: "read",
      operation: "read",
      effect_scope: "external",
      sandbox_policy: "live_external",
    }, c);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("未通过持久化草稿边界");
    expect(result.output).toMatchObject({ inMemory: false, persisted: false });
    expect(c.toolCatalog).not.toContain("acme.lookupCandidate");
    expect(events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ t: "tool.created" })]),
    );
  });

  it("normalizes and persists a strict executable HTTP manifest", async () => {
    let saved: DeclarativeTool | undefined;
    const events: Array<Record<string, unknown>> = [];
    const c = ctx({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      ports: {
        tools: {
          saveDraft: async (tool: DeclarativeTool) => {
            saved = tool;
            return {
              revisionId: "tvr-asset-honesty",
              version: 1,
              definitionHash: "a".repeat(64),
              status: "draft" as const,
            };
          },
          list: async () => [],
        },
      } as unknown as BrainCtx["ports"],
    });
    const result = await createTool.execute({
      name: "acme.parseResume",
      description: "Parse a resume",
      method: "POST",
      url_template: "https://api.example.test/resumes",
      side_effect: "write",
      operation: "write",
      effect_scope: "external",
      sandbox_policy: "requires_attempt_grant",
      request_spec: {
        encoding: "multipart",
        fields: { candidate_id: "{candidateId}" },
        files: [{ field: "file", base64_path: "resume.base64", filename_path: "resume.name", mime: "application/pdf", required: true }],
        max_bytes: 2_000_000,
      },
      response_spec: {
        assertions: [{ path: "success", op: "eq", value: true, failure: "terminal", code: "VENDOR_REJECTED" }],
        mappings: { candidateId: "data.candidate_id", text: "data.text" },
      },
      examples: [{ request: { candidateId: "cand-1", file: "[REDACTED]" }, response: { success: true, data: { candidate_id: "cand-1", text: "Engineer" } }, source: "documentation" }],
    }, c);

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      lifecycle: "draft",
      runtimeActive: false,
      availableInCurrentRegistry: false,
    });
    expect(c.toolCatalog).not.toContain("acme.parseResume");
    expect(c.realTools?.map((tool) => tool.name)).not.toContain(
      "acme.parseResume",
    );
    expect(saved).toMatchObject({
      requestSpec: {
        encoding: "multipart",
        files: [{ field: "file", base64Path: "resume.base64", filenamePath: "resume.name", mime: "application/pdf", required: true }],
        maxBytes: 2_000_000,
      },
      responseSpec: {
        assertions: [{ code: "VENDOR_REJECTED", failure: "terminal" }],
        mappings: { candidateId: "data.candidate_id", text: "data.text" },
      },
      examples: [{ source: "documentation" }],
      probeStatus: "required",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: "tool.created",
          revisionId: "tvr-asset-honesty",
          status: "draft",
          runtimeActive: false,
        }),
      ]),
    );
  });

  it("rejects ambiguous manifests and literal credentials before persistence", async () => {
    let saves = 0;
    const c = ctx({
      ports: {
        tools: {
          saveDraft: async () => {
            saves++;
            return {
              revisionId: "tvr-should-not-save",
              version: 1,
              definitionHash: "b".repeat(64),
              status: "draft" as const,
            };
          },
          list: async () => [],
        },
      } as unknown as BrainCtx["ports"],
    });
    const ambiguous = await createTool.execute({
      name: "acme.ambiguous",
      description: "Ambiguous request",
      method: "POST",
      url_template: "https://api.example.test/items",
      body_template: "{}",
      request_spec: { encoding: "json" },
      side_effect: "read",
    }, c);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.summary).toContain("互斥");

    const secretExample = await createTool.execute({
      name: "acme.secretExample",
      description: "Unsafe example",
      method: "GET",
      url_template: "https://api.example.test/items",
      side_effect: "read",
      examples: [{ request: { authorization: "Bearer live-secret" }, response: {} }],
    }, c);
    expect(secretExample.ok).toBe(false);
    expect(secretExample.summary).toContain("字面凭证");

    const secretBody = await createTool.execute({
      name: "acme.secretBody",
      description: "Unsafe body",
      method: "POST",
      url_template: "https://api.example.test/items",
      side_effect: "write",
      body_template: '{"password":"live-secret"}',
    }, c);
    expect(secretBody.ok).toBe(false);
    expect(secretBody.summary).toContain("字面凭证");
    expect(saves).toBe(0);
  });
});
