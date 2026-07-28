import { describe, it, expect } from "vitest";
import ts from "typescript";
import { renderTsFunctionModule } from "./ts-function-module";
import { harnessTsModuleForTest } from "./function-tester";
import { validateAgentCode } from "./codegen";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "parseResume",
    actionName: "parseResume",
    slug: "raas-parse-resume",
    short: "ResumeParserAgent",
    domainId: "raas-v1",
    nameZh: "简历解析",
    kind: "llm",
    trigger: ["RESUME_DOWNLOADED"],
    emit: ["RESUME_PROCESSED"],
    tools: ["parseResumeApi", "fs.readFromInbox"],
    unresolvedTools: [],
    objects: ["Candidate", "Resume"],
    systemPrompt: "你负责解析简历原文,产出结构化候选人信息。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 3,
    hitl: false,
    confidence: 0.9,
    promptSource: "llm" as GeneratedAgentSpec["promptSource"],
    ...over,
  } as GeneratedAgentSpec;
}

describe("#P1 renderTsFunctionModule — inngest.createFunction 形态", () => {
  it("产出 inngest.createFunction 骨架(对标旧 AO),含 id/name/retries/trigger", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("inngest.createFunction(");
    expect(code).toContain('const AGENT_ID = "raas-parse-resume"');
    expect(code).toContain("retries: 3");
    expect(code).toContain('{ event: "RESUME_DOWNLOADED" }');
    expect(code).toContain("export const resumeParserAgent = inngest.createFunction(");
  });

  it("挖出三个定制槽位(fieldMapping / errorTaxonomy / controlFlow)", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("#SLOT-1 fieldMapping");
    expect(code).toContain("function mapFields(");
    expect(code).toContain("#SLOT-2 errorTaxonomy");
    expect(code).toContain("function classifyError(");
    expect(code).toContain("#SLOT-3 controlFlow");
    // 黄金范例锚点被写进注释(防过拟合:按模式引用,不整文件复制)
    expect(code).toContain("buildPromptFromRequirement");
    expect(code).toContain("isInfraFailure");
  });

  it("只用三种 step 原语:step.run(工具+决策) + step.sendEvent(emit),无 waitForEvent/cancelOn/并发键", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("await step.run(");
    expect(code).toContain("await step.sendEvent(");
    expect(code).not.toContain("waitForEvent");
    expect(code).not.toContain("cancelOn");
    expect(code).not.toContain("concurrency");
    // 每个工具一个 step.run + 决策核心一个 step.run("decide-…")
    expect((code.match(/await step\.run\(/g) ?? []).length).toBe(3);
    expect(code).toContain('"decide-');
  });

  it("多 trigger → triggers 数组;多 emit → 真实事件选择(决策 emit 优先,字面量分支)", () => {
    const code = renderTsFunctionModule(spec({ trigger: ["REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED"], emit: ["JD_GENERATED", "JD_FAILED"] }));
    expect(code).toContain('[{ event: "REQUIREMENT_LOGGED" }, { event: "CLARIFICATION_READY" }, { event: "JD_REJECTED" }]');
    expect(code).toContain("let _chosen");
    expect(code).toContain('name: "JD_GENERATED"');
    expect(code).toContain('name: "JD_FAILED"');
  });

  it("错误分类 catch:park/rethrow 上抛,business_fail/terminal 发 _FAILED", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("const kind = classifyError(e)");
    expect(code).toContain('if (kind === "park" || kind === "rethrow") throw e');
    // 单 emit(RESUME_PROCESSED)→ 派生 RESUME_FAILED 作失败事件
    expect(code).toContain("RESUME_FAILED");
  });

  it("hitl agent retries=1;old-ao profile 生成 @/lib import 注释", () => {
    expect(renderTsFunctionModule(spec({ hitl: true }))).toContain("retries: 1");
    const old = renderTsFunctionModule(spec(), { profile: "old-ao", pauseGate: "skipIfRaasV1Paused" });
    expect(old).toContain('import { inngest } from "@/server/inngest/client"');
    expect(old).toContain("@/lib/");
    expect(old).toContain("skipIfRaasV1Paused");
  });

  it("产出是语法有效的 TS(通过 validateAgentCode 编译)", async () => {
    const code = renderTsFunctionModule(spec());
    const v = await validateAgentCode(code);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("确定性:同 spec 同 opts 逐字节同输出", () => {
    const a = renderTsFunctionModule(spec(), { profile: "old-ao" });
    const b = renderTsFunctionModule(spec(), { profile: "old-ao" });
    expect(a).toBe(b);
  });
});

// ── #TRUE-CODE:槽位不再是空桩——经 harness 真执行验证 ─────────────────────────────
type RunFn = (event: unknown, opts?: { tool?: (n: string, a: unknown) => Promise<unknown>; invoke?: (ref: string, input: unknown, meta?: unknown) => Promise<unknown>; reason?: (sp: string, inp: unknown) => Promise<Record<string, unknown>> }) => Promise<{
  ran: boolean; error?: string; emitNames?: string[]; toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; runStepIds?: string[];
}>;

function loadHarnessed(moduleCode: string): RunFn {
  const harnessed = harnessTsModuleForTest(moduleCode);
  const js = ts.transpileModule(harnessed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const moduleObj = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function("require", "exports", "module", js)(() => ({}), moduleObj.exports, moduleObj);
  return moduleObj.exports.__run as RunFn;
}

describe("#TRUE-CODE renderTsFunctionModule — 槽位真执行(经 harness)", () => {
  it("#SLOT-1 mapFields 真映射:声明字段类型规整 + 源路径回退,工具收到映射后的载荷", async () => {
    const run = loadHarnessed(renderTsFunctionModule(spec({
      tools: ["parseResumeApi"],
      inputSchema: [
        { field: "upload_id", type: "String" },
        { field: "head_count", type: "Number", source: "Job_Requisition.head_count" },
      ],
    })));
    const r = await run(
      { data: { upload_id: "u-9", Job_Requisition: { head_count: "5" } } },
      { tool: async () => ({ parsed: true }), reason: async () => ({ pass: true, ok: true }) },
    );
    expect(r.ran).toBe(true);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]!.args["upload_id"]).toBe("u-9");
    expect(r.toolCalls![0]!.args["head_count"]).toBe(5); // "5" → 5(类型规整) 经源路径回退取到
    expect(r.emitNames).toContain("RESUME_PROCESSED");
  });

  it("#SLOT-2 classifyError 真分类:业务错误发 _FAILED,基础设施瞬态 park 上抛", async () => {
    const code = renderTsFunctionModule(spec());
    const biz = await loadHarnessed(code)({ data: {} }, { tool: async () => ({}), reason: async () => { throw new Error("invalid resume: missing name"); } });
    expect(biz.ran).toBe(true); // handler 捕获并发终态,不上抛
    expect(biz.emitNames).toContain("RESUME_FAILED");

    const infra = await loadHarnessed(code)({ data: {} }, { tool: async () => ({}), reason: async () => { throw new Error("ETIMEDOUT fetch failed"); } });
    expect(infra.ran).toBe(false); // park → 上抛给 Inngest 重试,不发终态
    expect(infra.emitNames).not.toContain("RESUME_FAILED");

    // #G18 — 欠费/额度用尽在充值后自愈，必须 park 等重试。此前它被判成 terminal，
    // 把一次「暂时没钱」变成对这条业务的永久杀死；而真正不自愈的是凭证类失败(401/403)。
    // 这与 lib/dependency-health 的 RECOVERABLE 集合(quota/rate_limit/network/server)一致。
    for (const msg of ["Request failed with status 402", "insufficient balance", "余额不足，请充值", "quota exceeded for this month"]) {
      const billing = await loadHarnessed(code)({ data: {} }, { tool: async () => ({}), reason: async () => { throw new Error(msg); } });
      expect(billing.ran, msg).toBe(false); // 上抛给 Inngest 重试
      expect(billing.emitNames, msg).not.toContain("RESUME_FAILED");
    }
    // 凭证失败仍然 terminal：重试换不来一把新钥匙。
    for (const msg of ["Request failed with status 401", "invalid api key"]) {
      const auth = await loadHarnessed(code)({ data: {} }, { tool: async () => ({}), reason: async () => { throw new Error(msg); } });
      expect(auth.ran, msg).toBe(true);
      expect(auth.emitNames, msg).toContain("RESUME_FAILED");
    }
  });

  it("#SLOT-3 plan[] 真控制流:条件真门控 + soft 真延续 + onError 标签进分类学", async () => {
    const plan: PlanStep[] = [
      { stepId: "is-pdf", kind: "condition", condition: "event.data.kind == 'pdf'" },
      { stepId: "parse", kind: "tool", tool: "parseResumeApi", dependsOn: ["is-pdf"], onError: "soft", defaultResult: { parsed: null } },
      { stepId: "store", kind: "tool", tool: "records.upsert" },
    ];
    const code = renderTsFunctionModule(spec({ plan, tools: ["parseResumeApi", "records.upsert"] }));
    const fixture = { tool: async () => ({ name: "张三", conflict: false }), reason: async () => ({ pass: true, ok: true }) };
    const pdf = await loadHarnessed(code)({ data: { kind: "pdf" } }, fixture);
    expect(pdf.toolCalls!.map((c) => c.name)).toEqual(["parseResumeApi", "records.upsert"]);

    const doc = await loadHarnessed(code)({ data: { kind: "docx" } }, fixture);
    expect(doc.toolCalls!.map((c) => c.name)).toEqual(["records.upsert"]); // parse 真被跳过
    expect(doc.emitNames).toContain("RESUME_PROCESSED");
  });

  it("toolArguments/resultMap 精确整形，且 foreach locals 可直接引用", async () => {
    const plan: PlanStep[] = [{
      stepId: "each",
      kind: "foreach",
      itemsFrom: "input.resumes",
      itemAs: "resume",
      itemKeyFrom: "resume.id",
      body: [{
        stepId: "parse-one",
        kind: "tool",
        tool: "parseResumeApi",
        toolArguments: {
          resume_id: { from: "locals.resume.id" },
          object_key: { from: "locals.resume.object_key" },
          mode: { const: "strict" },
        },
        resultMap: { fields: { parsed_id: "result.data.id" }, includeRaw: true },
        onError: "terminal",
      }],
    }];
    const code = renderTsFunctionModule(spec({ plan, tools: ["parseResumeApi"] }));
    expect(code).toContain("_afToolArguments");
    expect(code).toContain("_afMapToolResult");
    expect(code).not.toContain("LEGACY WHOLE-CARRY: toolArguments 未声明");
    const run = loadHarnessed(code);
    const result = await run(
      { data: { resumes: [{ id: "R-1", object_key: "inbox/r1.pdf", ignored: "no" }] } },
      {
        tool: async (_name, args) => ({ data: { id: (args as Record<string, unknown>).resume_id } }),
        reason: async () => ({ pass: true, ok: true }),
      },
    );
    expect(result.ran).toBe(true);
    expect(result.toolCalls).toEqual([{
      name: "parseResumeApi",
      args: { resume_id: "R-1", object_key: "inbox/r1.pdf", mode: "strict" },
    }]);
  });

  it("#SLOT-3 命名结果可跨越中间步骤读取，不再依赖单一 lastResult", async () => {
    const plan: PlanStep[] = [
      { stepId: "parse-resume", kind: "tool", tool: "parseResumeApi", idempotencyKeyFrom: "resume_id", onError: "terminal" },
      { stepId: "load-rules", kind: "tool", tool: "ontology.fetchActionRules", idempotencyKeyFrom: "resume_id", onError: "terminal" },
      { stepId: "parsed-ok", kind: "condition", condition: "results.parse-resume.result.name != null" },
      { stepId: "persist", kind: "tool", tool: "records.upsert", dependsOn: ["parsed-ok"], idempotencyKeyFrom: "resume_id", onError: "terminal" },
    ];
    const run = loadHarnessed(renderTsFunctionModule(spec({ plan, tools: ["parseResumeApi", "ontology.fetchActionRules", "records.upsert"] })));
    const r = await run(
      { data: { resume_id: "R-1" } },
      {
        tool: async (name) => name === "parseResumeApi" ? { name: "张三" } : name === "ontology.fetchActionRules" ? { count: 2 } : { persisted: true },
        reason: async () => ({ pass: true, ok: true }),
      },
    );
    expect(r.ran).toBe(true);
    expect(r.toolCalls!.map((c) => c.name)).toEqual(["parseResumeApi", "ontology.fetchActionRules", "records.upsert"]);
  });

  it("#G1 多 emit 的终态由判定决定,LLM 的自由文本 emit 不能改写它", async () => {
    const code = renderTsFunctionModule(spec({ emit: ["MATCHED", "REVIEW_NEEDED", "REJECTED"] }));
    // 模型说"发 REVIEW_NEEDED"——不算数。没有路由条件时，终态只由 pass/ok 判定二分。
    // 这条保证的意义在于：一个候选人是被拒绝还是被推进，不能取决于一次自由文本生成。
    const hostile = await loadHarnessed(code)({ data: {} }, { tool: async () => ({}), reason: async () => ({ ok: true, emit: "REVIEW_NEEDED" }) });
    expect(hostile.emitNames).toEqual(["MATCHED"]);
    // #G19 — 运行失败绝不能复用某条业务终态。这里三个声明事件都是业务判定，
    // 「REJECTED」尤其是对候选人的处置结论；把一次 401 或接线 bug 发成 REJECTED
    // 等于凭零证据永久拒绝一个人。没有失败形态的已声明事件时必须合成 _FAILED。
    const failed = await loadHarnessed(code)({ data: {} }, { tool: async () => ({}), reason: async () => ({ pass: false }) });
    expect(failed.emitNames).toEqual(["MATCHED_FAILED"]);

    // 已声明了失败形态事件时，复用它而不是再合成一个下游没订阅的新名字。
    const withFailure = renderTsFunctionModule(spec({ emit: ["MATCHED", "MATCH_FAILED"] }));
    const reused = await loadHarnessed(withFailure)({ data: {} }, { tool: async () => ({}), reason: async () => ({ pass: false }) });
    expect(reused.emitNames).toEqual(["MATCH_FAILED"]);
  });

  it("#G2 路由条件真的决定终态——算完就丢弃的条件等于这段逻辑不存在", async () => {
    const plan: PlanStep[] = [
      {
        stepId: "score-passes",
        kind: "condition",
        condition: "event.data.score >= 40",
        routes: { onTrue: "MATCHED", onFalse: "REJECTED" },
      },
    ];
    const code = renderTsFunctionModule(spec({ emit: ["MATCHED", "REJECTED"], plan, tools: [] }));
    // 分数够 → MATCHED；分数不够 → REJECTED。两次都给一个"敌意"的决策核心：
    // 它自称成功、还点名要发 MATCHED，路由条件必须压过它。
    const high = await loadHarnessed(code)({ data: { score: 88 } }, { tool: async () => ({}), reason: async () => ({ ok: true, emit: "MATCHED" }) });
    expect(high.emitNames).toEqual(["MATCHED"]);
    const low = await loadHarnessed(code)({ data: { score: 12 } }, { tool: async () => ({}), reason: async () => ({ ok: true, emit: "MATCHED" }) });
    expect(low.emitNames).toEqual(["REJECTED"]);
  });

  it("foreach 真执行逐项 body、按业务键生成重放稳定 id，并把全部结果 fan-in", async () => {
    const plan: PlanStep[] = [{
      stepId: "parse-all",
      kind: "foreach",
      itemsFrom: "input.resumes",
      itemAs: "resume",
      itemKeyFrom: "resume.id",
      body: [
        { stepId: "parse-one", kind: "tool", tool: "parseResumeApi", onError: "terminal" },
        { stepId: "valid", kind: "condition", condition: "results.parse-one.result.ok == true" },
        { stepId: "emit-one", kind: "emit", emitEvent: "RESUME_PROCESSED", emitPayloadFrom: "results.parse-one", dependsOn: ["valid"] },
      ],
    }];
    const moduleCode = renderTsFunctionModule(spec({ plan, tools: ["parseResumeApi"] }));
    expect((await validateAgentCode(moduleCode)).ok).toBe(true);
    const run = loadHarnessed(moduleCode);
    let decisionInput: Record<string, unknown> | undefined;
    const execute = (resumes: Array<{ id: string }>) => run(
      { data: { resumes } },
      {
        tool: async (_name, args) => {
          const resume = (args as Record<string, unknown>).resume as { id: string };
          return { id: resume.id, ok: true };
        },
        reason: async (_prompt, input) => {
          decisionInput = input as Record<string, unknown>;
          return { pass: true, ok: true };
        },
      },
    );

    const first = await execute([{ id: "R/1" }, { id: "R 2" }]);
    expect(first.ran).toBe(true);
    expect(first.toolCalls?.map((call) => (call.args.resume as { id: string }).id)).toEqual(["R/1", "R 2"]);
    expect(first.emitNames).toEqual(["RESUME_PROCESSED", "RESUME_PROCESSED"]);
    expect((decisionInput?.results as Record<string, { count: number }>)?.["parse-all"]?.count).toBe(2);
    const firstIds = first.runStepIds!.filter((id) => !id.startsWith("decide-"));
    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);

    const reordered = await execute([{ id: "R 2" }, { id: "R/1" }]);
    const reorderedIds = reordered.runStepIds!.filter((id) => !id.startsWith("decide-"));
    expect([...reorderedIds].sort()).toEqual([...firstIds].sort());
  });

  it("嵌套 foreach 内 invoke 使用完整祖先业务键生成稳定 durable id", async () => {
    const plan: PlanStep[] = [{
      stepId: "each-job",
      kind: "foreach",
      itemsFrom: "input.jobs",
      itemAs: "job",
      itemKeyFrom: "job.id",
      body: [{
        stepId: "each-candidate",
        kind: "foreach",
        itemsFrom: "locals.job.candidates",
        itemAs: "candidate",
        itemKeyFrom: "candidate.id",
        body: [{
          stepId: "verify",
          kind: "invoke",
          invoke: "candidate-checker",
          timeoutS: 5,
          onError: "terminal",
          forwardResults: true,
        }, {
          stepId: "done",
          kind: "emit",
          emitEvent: "RESUME_PROCESSED",
          emitPayloadFrom: "results.verify",
        }],
      }],
    }];
    const moduleCode = renderTsFunctionModule(spec({ plan, tools: [] }));
    expect(moduleCode).toContain("await step.invoke(");
    expect(moduleCode).toContain("_resolveInvokeTarget");
    expect(moduleCode).not.toContain('callTool("invoke:');
    expect((await validateAgentCode(moduleCode)).ok).toBe(true);
    const run = loadHarnessed(moduleCode);
    const execute = (jobs: Array<{ id: string; candidates: Array<{ id: string }> }>) => run(
      { data: { jobs } },
      {
        invoke: async (ref, args) => ({
          checkedBy: ref,
          candidateId: (args as Record<string, unknown>).id,
        }),
        reason: async () => ({ ok: true }),
      },
    );
    const jobs = [
      { id: "JR/a", candidates: [{ id: "C-1" }, { id: "C-2" }] },
      { id: "JR a", candidates: [{ id: "C-3" }] },
    ];
    const first = await execute(jobs);
    const reordered = await execute([...jobs].reverse().map((job) => ({ ...job, candidates: [...job.candidates].reverse() })));
    expect(first.ran).toBe(true);
    expect(first.emitNames).toEqual(["RESUME_PROCESSED", "RESUME_PROCESSED", "RESUME_PROCESSED"]);
    expect(first.toolCalls?.map((call) => call.name)).toEqual([
      "invoke:candidate-checker",
      "invoke:candidate-checker",
      "invoke:candidate-checker",
    ]);
    const ids = first.runStepIds!.filter((id) => !id.startsWith("decide-"));
    const reorderedIds = reordered.runStepIds!.filter((id) => !id.startsWith("decide-"));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort()).toEqual([...reorderedIds].sort());
  });

  it("generic function 保留 canonical event.data 的 payload 与其他顶层字段", async () => {
    const plan: PlanStep[] = [{
      stepId: "inspect",
      kind: "tool",
      tool: "inspect",
      onError: "terminal",
    }];
    const run = loadHarnessed(
      renderTsFunctionModule(spec({ plan, tools: ["inspect"] })),
    );
    const result = await run(
      {
        data: {
          payload: { nested: "kept-as-data" },
          tenant_id: "tenant-1",
          request_id: "request-1",
        },
      },
      {
        tool: async () => ({ ok: true }),
        reason: async () => ({ ok: true }),
      },
    );
    expect(result.ran).toBe(true);
    expect(result.toolCalls?.[0]?.args).toMatchObject({
      payload: { nested: "kept-as-data" },
      tenant_id: "tenant-1",
      request_id: "request-1",
    });
  });

  it("显式 emit plan 支持 allowlisted multi-emit，且不会再追加隐式终态", async () => {
    const plan: PlanStep[] = [
      { stepId: "notify-a", kind: "emit", emitEvent: "MATCHED", emitPayload: { channel: "a" } },
      { stepId: "notify-b", kind: "emit", emitEvent: "REVIEW_NEEDED", emitPayload: { channel: "b" } },
    ];
    const run = loadHarnessed(renderTsFunctionModule(spec({ plan, emit: ["MATCHED", "REVIEW_NEEDED", "REJECTED"], tools: [] })));
    const result = await run({ data: { candidate_id: "C-1" } }, { reason: async () => ({ ok: true, emit: "REJECTED" }) });
    expect(result.ran).toBe(true);
    expect(result.emitNames).toEqual(["MATCHED", "REVIEW_NEEDED"]);
  });

  it("foreach/emit 边界 fail-close：重复业务键终止，未声明事件在渲染期拒绝", async () => {
    const foreachPlan: PlanStep[] = [{
      stepId: "each", kind: "foreach", itemsFrom: "input.rows", itemKeyFrom: "id",
      body: [{ stepId: "save", kind: "tool", tool: "records.upsert", onError: "terminal" }],
    }];
    const duplicate = await loadHarnessed(renderTsFunctionModule(spec({ plan: foreachPlan, tools: ["records.upsert"] })))(
      { data: { rows: [{ id: "same" }, { id: "same" }] } },
      { tool: async () => ({ saved: true }), reason: async () => ({ ok: true }) },
    );
    // Matches manifest foreach: a malformed/duplicate business key aborts the
    // run for retry; it must not be converted into a successful _FAILED emit.
    expect(duplicate.ran).toBe(false);
    expect(duplicate.emitNames).toEqual([]);
    expect(duplicate.toolCalls).toHaveLength(1);

    expect(() => renderTsFunctionModule(spec({
      plan: [{ stepId: "invent", kind: "emit", emitEvent: "INVENTED" }],
    }))).toThrow(/declared emit allow-list/);
  });

  it("fail-close:注入缝缺失时抛错(park),绝不静默伪造通过", async () => {
    // 不经 harness(不注入替身)直接加载并调用 handler——callTool/reasonCore 必须抛错。
    const code = renderTsFunctionModule(spec());
    const js = ts.transpileModule(code.split("\n").filter((l) => !/^\s*import\s/.test(l)).join("\n").replace(/\binngest\.createFunction\b/g, "__cap.createFunction"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let fn: { handler: (a: unknown) => Promise<unknown> } | null = null;
    const __cap = { createFunction: (_c: unknown, _t: unknown, handler: (a: unknown) => Promise<unknown>) => { fn = { handler }; return fn; } };
    const moduleObj = { exports: {} as Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function("require", "exports", "module", "__cap", js)(() => ({}), moduleObj.exports, moduleObj, __cap);
    const step = { run: async (_i: string, f: () => Promise<unknown>) => f(), sendEvent: async () => undefined, invoke: async () => ({}) };
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    await expect(fn!.handler({ event: { data: {} }, step, logger })).rejects.toThrow(/__agentTool|__agentReason/);
  });
});
