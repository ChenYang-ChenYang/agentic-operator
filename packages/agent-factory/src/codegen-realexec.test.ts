import { describe, it, expect } from "vitest";
import ts from "typescript";
import { specToAgentCode } from "./codegen";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

// #TRUE-CODE — the rendered handler must REALLY EXECUTE: tools actually invoked per plan[],
// conditions actually gate, onError policies actually apply, the decision core fail-closes,
// and multi-emit actually selects among declared events. These tests load the rendered module
// exactly like the CodeAct shim (transpile → new Function → capturing defineAgent) and CALL
// the handler with an instrumented ctx — killing the old "commented-out tools + hardcoded
// 2-way emit" scaffold for good.

interface AgentDef { handler: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }

function loadRendered(code: string): AgentDef {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  let captured: AgentDef | null = null;
  const defineAgent = (cfg: AgentDef) => { captured = cfg; return cfg; };
  const requireShim = (id: string): unknown => (id === "@agentic/runtime" ? { defineAgent } : {});
  const moduleObj = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function("require", "exports", "module", "defineAgent", js) as (
    r: (id: string) => unknown, e: Record<string, unknown>, m: { exports: Record<string, unknown> }, d: (c: AgentDef) => AgentDef,
  ) => void;
  factory(requireShim, moduleObj.exports, moduleObj, defineAgent);
  if (!captured) throw new Error("defineAgent not captured");
  return captured;
}

function makeCtx(opts: { reason?: unknown; toolImpl?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const emits: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const run = async (name: string, args: Record<string, unknown>) => {
    toolCalls.push({ tool: name, args });
    const impl = opts.toolImpl ?? ((n: string) => ({ [`${n.replace(/\W/g, "_")}_result`]: true }));
    return impl(name, args);
  };
  const ctx = {
    tools: { run },
    tool: run,
    reason: async () => opts.reason ?? { ok: true, pass: true },
    emit: async (event: string, payload: Record<string, unknown>) => { emits.push({ event, payload }); },
    invoke: async (ref: string, args: Record<string, unknown>) => { toolCalls.push({ tool: `invoke:${ref}`, args }); return { invoked: ref }; },
    log: () => { /* silent */ },
    memory: { get: async () => null, put: async () => undefined, delete: async () => undefined, search: async () => [] },
  };
  return { ctx, toolCalls, emits };
}

function spec(overrides: Partial<GeneratedAgentSpec>): GeneratedAgentSpec {
  return {
    key: "a", actionName: "processResume", slug: "rec-process-resume", short: "ProcessResume",
    domainId: "rec", nameZh: "简历处理", kind: "llm", trigger: ["RESUME_UPLOADED"], emit: ["RESUME_PROCESSED"],
    tools: [], unresolvedTools: [], objects: [], systemPrompt: "处理简历。", userPrompt: "",
    steps: [], ruleRefs: [], retries: 3, hitl: false, confidence: 0.9, promptSource: "llm",
    ...overrides,
  } as GeneratedAgentSpec;
}

describe("specToAgentCode — rendered handler REALLY executes", () => {
  it("plan[] tool steps actually call ctx.tools.run in order, threading results", async () => {
    const plan: PlanStep[] = [
      { stepId: "fetch-resume", kind: "tool", tool: "fs.readFromInbox" },
      { stepId: "parse", kind: "tool", tool: "parseResumeApi" },
    ];
    const def = loadRendered(specToAgentCode(spec({ plan, tools: ["fs.readFromInbox", "parseResumeApi"] })));
    const { ctx, toolCalls, emits } = makeCtx({ toolImpl: (n) => ({ from: n }) });
    await def.handler({ upload_id: "u1" }, ctx);
    expect(toolCalls.map((c) => c.tool)).toEqual(["fs.readFromInbox", "parseResumeApi"]);
    // second call carries the first tool's threaded result + original input
    expect(toolCalls[1]!.args).toMatchObject({ upload_id: "u1", from: "fs.readFromInbox" });
    expect(emits).toHaveLength(1);
    expect(emits[0]!.event).toBe("RESUME_PROCESSED");
  });

  it("renders exact toolArguments/resultMap and marks tool CodeAct as declarative-required", async () => {
    const plan: PlanStep[] = [
      {
        stepId: "lookup",
        kind: "tool",
        tool: "candidate.lookup",
        toolArguments: {
          candidate_id: { from: "input.candidate_id" },
          source: { const: "factory" },
        },
        resultMap: { fields: { canonical_id: "result.data.id" } },
        onError: "terminal",
      },
      {
        stepId: "persist",
        kind: "tool",
        tool: "candidate.persist",
        toolArguments: {
          id: { from: "results.lookup.canonical_id" },
          note: { from: "input.note", required: false },
        },
        onError: "terminal",
      },
    ];
    const code = specToAgentCode(spec({ plan, tools: ["candidate.lookup", "candidate.persist"] }));
    expect(code).toContain('factoryExecutionMode: "declarative_required"');
    expect(code).not.toContain("candidate_id: carry");
    const def = loadRendered(code);
    const { ctx, toolCalls } = makeCtx({
      toolImpl: (name) => name === "candidate.lookup" ? { data: { id: "C-1" }, ignored: true } : { saved: true },
    });
    await def.handler({ candidate_id: "incoming", ignored: "must-not-leak" }, ctx);
    expect(toolCalls).toEqual([
      { tool: "candidate.lookup", args: { candidate_id: "incoming", source: "factory" } },
      { tool: "candidate.persist", args: { id: "C-1" } },
    ]);
  });

  it("condition steps really gate dependents (skipped tool is NOT called)", async () => {
    const plan: PlanStep[] = [
      { stepId: "is-urgent", kind: "condition", condition: "event.data.urgent == true" },
      { stepId: "notify", kind: "tool", tool: "meta.ping", dependsOn: ["is-urgent"] },
    ];
    const code = specToAgentCode(spec({ plan, tools: ["meta.ping"] }));

    const a = makeCtx();
    await loadRendered(code).handler({ urgent: true }, a.ctx);
    expect(a.toolCalls.map((c) => c.tool)).toEqual(["meta.ping"]);

    const b = makeCtx();
    await loadRendered(code).handler({ urgent: false }, b.ctx);
    expect(b.toolCalls).toHaveLength(0); // really skipped
  });

  it("onError:soft continues with defaultResult; onError:terminal rethrows", async () => {
    const soft: PlanStep[] = [
      { stepId: "flaky", kind: "tool", tool: "flaky.tool", onError: "soft", defaultResult: { fallback: true } },
      { stepId: "next", kind: "tool", tool: "meta.ping" },
    ];
    const softDef = loadRendered(specToAgentCode(spec({ plan: soft, tools: ["flaky.tool", "meta.ping"] })));
    const s = makeCtx({ toolImpl: (n) => { if (n === "flaky.tool") throw new Error("boom"); return { ok: 1 }; } });
    await softDef.handler({}, s.ctx);
    expect(s.toolCalls.map((c) => c.tool)).toEqual(["flaky.tool", "meta.ping"]);
    expect(s.toolCalls[1]!.args).toMatchObject({ fallback: true }); // defaultResult threaded

    const term: PlanStep[] = [{ stepId: "hard", kind: "tool", tool: "hard.tool", onError: "terminal" }];
    const termDef = loadRendered(specToAgentCode(spec({ plan: term, tools: ["hard.tool"] })));
    const t = makeCtx({ toolImpl: () => { throw new Error("hard-fail"); } });
    await expect(termDef.handler({}, t.ctx)).rejects.toThrow("hard-fail");
    expect(t.emits).toHaveLength(0); // no fake success emit after a terminal failure
  });

  // #G1/#G19 —— 与 ts-function-module 同构。终态由判定决定：LLM 点名要发的事件不算数，
  // 失败也绝不复用某条业务终态（"REJECTED" 是对候选人的处置结论，不是运行错误的出口）。
  it("multi-emit: the verdict picks the event, an LLM's decision.emit does not", async () => {
    const s = spec({ emit: ["MATCHED", "REVIEW_NEEDED", "REJECTED"] });
    const code = specToAgentCode(s);

    const picked = makeCtx({ reason: { ok: true, emit: "REVIEW_NEEDED" } });
    await loadRendered(code).handler({}, picked.ctx);
    expect(picked.emits[0]!.event).toBe("MATCHED");

    // 三个声明事件都是业务判定，没有失败形态的可复用项 → 合成 MATCHED_FAILED。
    const failed = makeCtx({ reason: { ok: false } });
    await loadRendered(code).handler({}, failed.ctx);
    expect(failed.emits[0]!.event).toBe("MATCHED_FAILED");

    const passed = makeCtx({ reason: { pass: true } });
    await loadRendered(code).handler({}, passed.ctx);
    expect(passed.emits[0]!.event).toBe("MATCHED");

    // 声明了失败形态事件时复用它，而不是再合成一个下游没订阅的新名字。
    const withFailure = specToAgentCode(spec({ emit: ["MATCHED", "MATCH_FAILED"] }));
    const reused = makeCtx({ reason: { pass: false } });
    await loadRendered(withFailure).handler({}, reused.ctx);
    expect(reused.emits[0]!.event).toBe("MATCH_FAILED");
  });

  it("decision core FAIL-CLOSES: _reasonFailed throws instead of emitting a fake pass", async () => {
    const def = loadRendered(specToAgentCode(spec({})));
    const { ctx, emits } = makeCtx({ reason: { ok: false, _reasonFailed: true, error: "llm_gateway_missing" } });
    await expect(def.handler({}, ctx)).rejects.toThrow(/fail-close/);
    expect(emits).toHaveLength(0);
  });

  it("no-plan fallback really calls every bound tool (soft-continue), then decides", async () => {
    const def = loadRendered(specToAgentCode(spec({ tools: ["a.one", "b.two"] })));
    const { ctx, toolCalls, emits } = makeCtx({ toolImpl: (n) => { if (n === "a.one") throw new Error("x"); return { got: n }; } });
    await def.handler({ k: 1 }, ctx);
    expect(toolCalls.map((c) => c.tool)).toEqual(["a.one", "b.two"]);
    expect(emits).toHaveLength(1); // failure context recorded, decision core still ran
  });
});
