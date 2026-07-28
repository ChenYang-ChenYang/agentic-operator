import { describe, expect, it } from "vitest";
import ts from "typescript";
import { probeAgentModule, specToAgentCode } from "./codegen";
import { harnessTsModuleForTest } from "./function-tester";
import { projectPlanToActions } from "./plan-projection";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";
import { renderTsFunctionModule } from "./ts-function-module";
import { INVOKE_CONTRACT_TEST_VECTORS } from "@agentic/shared";

function spec(overrides: Partial<GeneratedAgentSpec>): GeneratedAgentSpec {
  return {
    key: "work",
    actionName: "work",
    slug: "demo-work",
    short: "WorkAgent",
    domainId: "demo",
    nameZh: "工作",
    kind: "llm",
    trigger: ["WORK_REQUESTED"],
    emit: ["WORK_DONE"],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "完成工作。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 3,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    ...overrides,
  } as GeneratedAgentSpec;
}

type CodeRun = (input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

function loadCodeAct(code: string): CodeRun {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let handler: CodeRun | undefined;
  const defineAgent = (definition: { handler?: CodeRun }) => {
    handler = definition.handler;
    return definition;
  };
  const moduleObject = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function("require", "exports", "module", "defineAgent", js)(() => ({}), moduleObject.exports, moduleObject, defineAgent);
  if (!handler) throw new Error("rendered CodeAct handler missing");
  return handler;
}

type FunctionRun = (
  event: unknown,
  options: { tool?: (name: string, args: unknown) => Promise<unknown>; invoke?: (ref: string, args: unknown, meta?: unknown) => Promise<unknown>; reason?: () => Promise<Record<string, unknown>> },
) => Promise<{ ran: boolean; error?: string; emitNames: string[] }>;

function loadFunction(code: string): FunctionRun {
  const js = ts.transpileModule(harnessTsModuleForTest(code), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleObject = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function("require", "exports", "module", js)(() => ({}), moduleObject.exports, moduleObject);
  return moduleObject.exports.__run as FunctionRun;
}

function codeCtx(tool: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const emitNames: string[] = [];
  return {
    emitNames,
    ctx: {
      tools: { run: tool },
      invoke: async () => ({}),
      reason: async () => ({ ok: true, pass: true }),
      emit: async (event: string) => { emitNames.push(event); },
      log: () => undefined,
      memory: { get: async () => null, put: async () => undefined, delete: async () => undefined, search: async () => [] },
    },
  };
}

describe("same-spec renderer parity", () => {
  it("executes foreach + repeated explicit emits in both renderers without an extra implicit emit", async () => {
    const plan: PlanStep[] = [{
      stepId: "each-row",
      kind: "foreach",
      itemsFrom: "input.rows",
      itemAs: "row",
      itemKeyFrom: "row.id",
      body: [
        { stepId: "copy", kind: "tool", tool: "row.copy", onError: "terminal" },
        { stepId: "emit-row", kind: "emit", emitEvent: "ROW_DONE", emitPayloadFrom: "results.copy" },
      ],
    }];
    const shared = spec({ plan, tools: ["row.copy"], emit: ["WORK_DONE", "ROW_DONE"] });
    const tool = async (_name: string, args: Record<string, unknown>) => ({ copied: (args.row as { id: string }).id });

    const renderedCode = specToAgentCode(shared);
    const code = codeCtx(tool);
    await loadCodeAct(renderedCode)({ rows: [{ id: "A" }, { id: "B" }] }, code.ctx);
    const fn = await loadFunction(renderTsFunctionModule(shared))(
      { data: { rows: [{ id: "A" }, { id: "B" }] } },
      { tool: async (name, args) => tool(name, args as Record<string, unknown>), reason: async () => ({ ok: true, pass: true }) },
    );

    expect(code.emitNames).toEqual(["ROW_DONE", "ROW_DONE"]);
    expect(fn.emitNames).toEqual(code.emitNames);
    expect(await probeAgentModule(renderedCode)).toMatchObject({ loads: false });
    expect(projectPlanToActions(shared)[0]).toMatchObject({ type: "foreach", items_from: "input.rows" });
  });

  it("renders nested foreach + invoke in both review artifacts while manifest remains execution owner", async () => {
    const plan: PlanStep[] = [{
      stepId: "jobs",
      kind: "foreach",
      itemsFrom: "input.jobs",
      itemAs: "job",
      itemKeyFrom: "job.id",
      body: [{
        stepId: "candidates",
        kind: "foreach",
        itemsFrom: "locals.job.candidates",
        itemAs: "candidate",
        itemKeyFrom: "candidate.id",
        body: [{ stepId: "check", kind: "invoke", invoke: "candidate-checker", timeoutS: 3, onError: "terminal" },
          { stepId: "done", kind: "emit", emitEvent: "ROW_DONE", emitPayloadFrom: "results.check" }],
      }],
    }];
    const shared = spec({ plan, emit: ["WORK_DONE", "ROW_DONE"] });
    const code = codeCtx(async () => ({}));
    await loadCodeAct(specToAgentCode(shared))({
      jobs: [{ id: "J-1", candidates: [{ id: "C-1" }, { id: "C-2" }] }],
    }, code.ctx);
    const fn = await loadFunction(renderTsFunctionModule(shared))(
      { data: { jobs: [{ id: "J-1", candidates: [{ id: "C-1" }, { id: "C-2" }] }] } },
      { invoke: async () => ({ accepted: true }), reason: async () => ({ ok: true }) },
    );
    expect(code.emitNames).toEqual(["ROW_DONE", "ROW_DONE"]);
    expect(fn.emitNames).toEqual(code.emitNames);
    expect(await probeAgentModule(specToAgentCode(shared))).toMatchObject({ loads: false });
    expect(projectPlanToActions(shared)[0]).toMatchObject({
      type: "foreach",
      foreach_actions: [expect.objectContaining({ type: "foreach" })],
    });
  });

  it.each(INVOKE_CONTRACT_TEST_VECTORS)(
    "keeps invoke payload/timeout parity for $name",
    async (vector) => {
      const plan: PlanStep[] = [
        { stepId: "parse", kind: "tool", tool: "seed", onError: "terminal" },
        {
          stepId: "child",
          kind: "invoke",
          invoke: "child-agent",
          invokeInput: { ...vector.input.invokeInput },
          forwardLastResult: vector.input.forwardLastResult,
          forwardResults: vector.input.forwardResults,
          timeoutS: vector.input.timeoutS,
          onError: "terminal",
        },
      ];
      const shared = spec({ plan, tools: ["seed"] });
      let codePayload: unknown;
      let codeTimeout: unknown;
      const code = codeCtx(async () => vector.input.lastResult);
      Object.assign(code.ctx, {
        subject: vector.input.subject,
        correlationId: vector.input.correlationId,
        invoke: async (_ref: string, payload: unknown, options: unknown) => {
          codePayload = payload;
          codeTimeout = options;
          return { invoked: true };
        },
      });
      await loadCodeAct(specToAgentCode(shared))(
        { ...vector.input.eventData },
        code.ctx,
      );

      let functionPayload: unknown;
      let functionMeta: unknown;
      const eventData = {
        ...vector.input.eventData,
        ...(vector.input.subject == null
          ? {}
          : { subject: vector.input.subject }),
        ...(vector.input.correlationId
          ? { __correlationId: vector.input.correlationId }
          : {}),
      };
      await loadFunction(renderTsFunctionModule(shared))(
        { data: eventData },
        {
          tool: async () => vector.input.lastResult,
          invoke: async (_ref, payload, meta) => {
            functionPayload = payload;
            functionMeta = meta;
            return { invoked: true };
          },
          reason: async () => ({ ok: true }),
        },
      );

      expect(codePayload).toEqual(vector.expectedPayload);
      expect(functionPayload).toEqual(vector.expectedPayload);
      expect(codeTimeout).toEqual({ timeoutMs: vector.expectedTimeoutMs });
      expect(functionMeta).toEqual({
        timeout:
          vector.input.timeoutS === undefined
            ? undefined
            : `${vector.input.timeoutS}s`,
        stepId: expect.any(String),
      });
    },
  );

  it("classifies ordered park/retry/terminal/continue+emit/drop identically and preserves the manifest ladder", async () => {
    const plan: PlanStep[] = [{
      stepId: "vendor-call",
      kind: "tool",
      tool: "vendor.call",
      idempotencyKeyFrom: "work_id",
      errorPolicy: [
        { when: "status==429", do: "park", suppressEmit: true },
        { when: "status>=500", do: "retry", suppressEmit: true },
        { when: "kind==schema_mismatch", do: "terminal", suppressEmit: true },
        // #G16 —— 终态 + 声明失败事件。这条向量是本文件此前缺的那一半：原有 ladder 里唯一带
        // emitEvent 的规则落在 continue 上，于是「先抛后发」这个缺陷在两个渲染器里都看不见。
        { when: "status==418", do: "terminal", emitEvent: "WORK_REJECTED" },
        { when: "status==400", do: "continue", defaultResult: { accepted: false }, emitEvent: "WORK_REJECTED" },
        { when: "code==DROP", do: "continue", defaultResult: null, suppressEmit: true },
        { default: "terminal", suppressEmit: true },
      ],
    }];
    const shared = spec({ plan, tools: ["vendor.call"], emit: ["WORK_DONE", "WORK_REJECTED"] });
    const renderedCode = specToAgentCode(shared);
    const runCode = loadCodeAct(renderedCode);
    const runFunction = loadFunction(renderTsFunctionModule(shared));

    const outcome = async (failure: unknown) => {
      const code = codeCtx(async () => { throw failure; });
      let codeError = "";
      try { await runCode({ work_id: "W-1" }, code.ctx); } catch (error) { codeError = String((error as Error).message); }
      const fn = await runFunction(
        { data: { work_id: "W-1" } },
        { tool: async () => { throw failure; }, reason: async () => ({ ok: true, pass: true }) },
      );
      return { codeError, codeEmits: code.emitNames, fn };
    };

    const park = await outcome({ status: 429 });
    expect(park.codeError).toMatch(/^\[park\]/);
    expect(park.fn.error).toMatch(/^\[park\]/);
    const retry = await outcome({ status: 503 });
    expect(retry.codeError).toMatch(/^\[retry\]/);
    expect(retry.fn.error).toMatch(/^\[retry\]/);
    const terminal = await outcome({ kind: "schema_mismatch" });
    expect(terminal.codeError).toMatch(/^\[terminal\]/);
    expect(terminal.fn.error).toMatch(/terminal action failure/);
    const continued = await outcome({ status: 400 });
    expect(continued.codeError).toBe("");
    expect(continued.codeEmits).toEqual(["WORK_REJECTED"]);
    expect(continued.fn.emitNames).toEqual(continued.codeEmits);
    const dropped = await outcome({ code: "DROP" });
    expect(dropped.codeError).toBe("");
    expect(dropped.codeEmits).toEqual([]);
    expect(dropped.fn.emitNames).toEqual([]);

    // #G16 —— 终态路径上声明的失败事件必须真的发得出去。放在 throw 之后它是死代码，
    // 运行悄无声息地退休，唯一能升级给人的消费方永远收不到。两个渲染器都要满足。
    const terminalEmit = await outcome({ status: 418 });
    expect(terminalEmit.codeError).toMatch(/^\[terminal\]/);
    expect(terminalEmit.codeEmits).toEqual(["WORK_REJECTED"]);
    expect(terminalEmit.fn.error).toMatch(/terminal action failure/);
    expect(terminalEmit.fn.emitNames).toEqual(["WORK_REJECTED"]);

    expect(projectPlanToActions(shared)[0]!.on_error).toEqual([
      { when: "status==429", do: "park", suppress_emit: true },
      { when: "status>=500", do: "retry", suppress_emit: true },
      { when: "kind==schema_mismatch", do: "terminal", suppress_emit: true },
      { when: "status==418", do: "terminal", emit_event: "WORK_REJECTED" },
      { when: "status==400", do: "continue", default_result: { accepted: false }, emit_event: "WORK_REJECTED" },
      { when: "code==DROP", do: "continue", default_result: null, suppress_emit: true },
      { default: "terminal", suppress_emit: true },
    ]);
    expect(await probeAgentModule(renderedCode)).toMatchObject({ loads: false });
  });

  // #G1 —— 终态事件由计算出的判定决定。两个渲染器都不能让 LLM 的自由文本 decision.emit
  // 改写它：一个候选人是被拒绝还是被推进，不能取决于一次生成的措辞。
  it("ignores an LLM-chosen emit in both renderers", async () => {
    const shared = spec({ plan: [], tools: [], emit: ["WORK_DONE", "WORK_REJECTED"] });
    const code = codeCtx(async () => ({}));
    await loadCodeAct(specToAgentCode(shared))(
      { work_id: "W-1" },
      { ...code.ctx, reason: async () => ({ ok: true, emit: "WORK_REJECTED" }) },
    );
    const fn = await loadFunction(renderTsFunctionModule(shared))(
      { data: { work_id: "W-1" } },
      { tool: async () => ({}), reason: async () => ({ ok: true, emit: "WORK_REJECTED" }) },
    );
    expect(code.emitNames).toEqual(["WORK_DONE"]);
    expect(fn.emitNames).toEqual(code.emitNames);
  });

  it("gives a codeExecuted spec exactly one logic execution owner", () => {
    const generated = spec({
      codeExecuted: true,
      plan: [
        { stepId: "reason", kind: "logic", description: "pure reasoning with no child side effects" },
      ],
    });
    const actions = projectPlanToActions(generated);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "logic", name: "work" });
    expect(actions[0]!.on_error).toEqual(expect.arrayContaining([
      expect.objectContaining({ when: expect.stringContaining("[terminal]"), do: "terminal" }),
      expect.objectContaining({ default: "retry" }),
    ]));
  });
});
