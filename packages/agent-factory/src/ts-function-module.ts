// #P1 — ts_function_module:把一个 GeneratedAgentSpec 渲染成【可部署到 Inngest 的 function】TS 模块,
// 对标旧 AO 的 server/inngest/agents/*.ts(create-jd / resume-parser / rule-check / match-resume /
// interview-inviter / candidate-identity)。这是融合蓝图 §07 的第一交付形态。
//
// #TRUE-CODE(2026-07-13)——三个 #SLOT 不再是空桩,而是【从 spec 确定性填实】:
//   #SLOT-1 fieldMapping  ← spec.inputSchema(声明字段显式提取 + 源对象路径回退 + 类型规整)
//   #SLOT-2 errorTaxonomy ← plan[].errorPolicy first-match typed ladder（与 manifest/runtime 一致）;
//                            legacy onError 保留兼容，message taxonomy 只兜底 plan 外故障
//   #SLOT-3 controlFlow   ← spec.plan[](条件真门控 dependsOn/evalCondition、逐步 step.run 稳定 id +
//                            idempotencyKeyFrom 后缀、软失败 defaultResult 延续、多路 emit 真选择)
// 外部能力经两个【注入缝】:globalThis.__agentTool / globalThis.__agentReason——Tester harness 注入
// 测试替身,真部署由运行时注入真实现;【未注入即抛错(park),绝不静默返回占位对象伪造通过】。
// codegen_agent 仍可用更丰富的业务逻辑整体覆盖本渲染(codeSource="ai")。
//
// 本模块【纯确定性】:同 spec 同 opts 逐字节同输出。真部署(把它注册进 -sb / 生产 Inngest)是 P1b。

import type { GeneratedAgentSpec, IoField, PlanStep } from "./spec-types";
import { EVAL_CONDITION_SRC, failEmitOf, renderMapFields } from "./codegen";
import { ERROR_POLICY_RUNTIME_SRC } from "./error-policy-code";
import {
  assertPlanDataflowRenderable,
  PLAN_DATAFLOW_RUNTIME_SRC,
  planUsesExactDataflow,
  renderedInvokeInput,
  renderedToolArguments,
  renderedToolCallback,
} from "./plan-dataflow-code";
import { validateConditionSyntax } from "./plan-projection";

export interface TsFunctionModuleOpts {
  /** import profile:new-AO(全局工具 registry) | old-AO(@/lib/* 旧仓库形态)。默认 new-AO。 */
  profile?: "new-ao" | "old-ao";
  /** 暂停闸 helper 名(旧 AO 用 skipIfRaasV1Paused)。缺省不生成暂停闸。 */
  pauseGate?: string;
}

function camel(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : "agent";
}
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
/** 稳定 step id:动词-清洗过的锚点(旧六文件的 sanitize 惯例)。 */
function stepId(verb: string, anchor: string): string {
  const a = anchor
    .replace(/[^A-Za-z0-9-]/g, "-")
    .slice(0, 40)
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${verb}-${a || "x"}`;
}

// ── #SLOT-2 errorTaxonomy(确定性填实)────────────────────────────────────────────
const CLASSIFY_ERROR_SRC = [
  `// #SLOT-2 errorTaxonomy — 把一次失败分成:business_fail(发 _FAILED 事件) / park(throw→Inngest 重试,`,
  `//   不发终态) / terminal(不可恢复,发 _FAILED) / rethrow(强制持久化失败,必须上抛)。`,
  `//   黄金范例:rule-check.isInfraFailure(park)、interview-inviter 终态码分级、resume-parser 依赖降级。`,
  `//   plan 内优先执行 typed ordered errorPolicy；本分类器只处理决策核心等 plan 外的 legacy 故障。`,
  `//   明确业务拒绝 → business_fail;未知保守 park(不误发终态、等重试)。`,
  `function classifyError(e: unknown): "business_fail" | "park" | "terminal" | "rethrow" {`,
  `  const m = String((e as Error)?.message ?? e).toLowerCase();`,
  `  // 计划内策略标签(步骤按 plan[].onError 抛出时自带,最高优先):`,
  `  if (m.startsWith("[terminal]")) return "terminal";`,
  `  if (m.startsWith("[park]")) return "park";`,
  `  if (m.startsWith("[rethrow]")) return "rethrow";`,
  `  // 强制持久化/审计类失败 → rethrow(绝不吞——candidate-identity 的 RuleAuditPersistenceError 语义)`,
  `  if (/(persist|audit|database|sqlite|constraint|transaction)/.test(m)) return "rethrow";`,
  `  // 凭证类失败(401/403/无效 key) → terminal:重试永远不会自愈,必须人工换凭证。`,
  `  if (/(401|403|unauthorized|forbidden|invalid api key|invalid_api_key|authentication failed)/.test(m)) return "terminal";`,
  `  // #G18 计费/额度/欠费(402/insufficient/quota/欠费/余额不足) → park。`,
  `  //   这类失败在充值后自愈,和 401 不同;判成 terminal 会把一次"暂时没钱"变成永久杀死,`,
  `  //   与 lib/dependency-health 的 RECOVERABLE 集合(quota/rate_limit/network/server)一致。`,
  `  if (/(402|payment required|insufficient|quota exceeded|out of credit|billing|欠费|余额不足|额度不足|配额)/.test(m)) return "park";`,
  `  // 基础设施瞬态(网络/超时/限流/5xx) → park(Inngest 重试自愈)`,
  `  if (/(timeout|timed out|econn|enotfound|eai_again|socket hang|fetch failed|network|429|too many requests|rate limit|502|503|504)/.test(m)) return "park";`,
  `  // 明确业务拒绝/校验失败 → business_fail(发 _FAILED 终态;重试不可自愈)`,
  `  if (/(invalid|missing|required|not found|404|400|unauthorized|401|403|forbidden|reject|校验失败|缺失|无效|不合规)/.test(m)) return "business_fail";`,
  `  return "park"; // 未知保守:等重试,不误发终态`,
  `}`,
].join("\n");

// ── 注入缝(fail-close)────────────────────────────────────────────────────────
const SEAM_SRC = [
  `/** 注入缝:真部署由运行时注入 __agentTool/__agentReason;Tester harness 注入测试替身。`,
  ` *  fail-close:未注入即抛错(park 语义,等待接线),【绝不静默返回占位对象伪造通过】。 */`,
  `async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {`,
  `  const g = globalThis as Record<string, unknown>;`,
  `  const runner = g.__agentTool as ((n: string, a: unknown) => Promise<unknown>) | undefined;`,
  `  if (!runner) throw new Error("[park] tool runner not injected (__agentTool) — cannot call " + name);`,
  `  return await runner(name, args);`,
  `}`,
  `async function reasonCore(systemPrompt: string, input: unknown): Promise<Record<string, unknown>> {`,
  `  const g = globalThis as Record<string, unknown>;`,
  `  const reason = g.__agentReason as ((sp: string, inp: unknown) => Promise<Record<string, unknown>>) | undefined;`,
  `  if (!reason) throw new Error("[park] reason core not injected (__agentReason) — fail-close");`,
  `  const d = (await reason(systemPrompt, input)) ?? {};`,
  `  if ((d as { _reasonFailed?: boolean })._reasonFailed === true) throw new Error("[park] 决策核心失败(LLM 不可用)——fail-close,不伪造通过");`,
  `  return d as Record<string, unknown>;`,
  `}`,
].join("\n");

/** idempotencyKeyFrom 的稳定后缀 helper(仅在有步骤声明时嵌入)。
 *
 * #G6 — 后缀要按【完整作用域】解析。以前它把 "input.candidate_id" 直接对着 mapped 走，
 * 而 mapped 里根本没有 `input` 这一层，于是每次都返回空串：所有 idempotencyKeyFrom 形同虚设，
 * 一个 handler 里多个持久化步骤会塌成同一个 id，被 Inngest 当成同一步重放。 */
const SUFFIX_SRC = [
  `const idSuffix = (scope: Record<string, unknown>, path: string): string => {`,
  `  const v = path.split(".").reduce<unknown>((c, k) => (c != null && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), scope);`,
  `  return v == null || String(v).trim() === "" ? "" : "-" + String(v).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);`,
  `};`,
].join("\n");

/** `foreach` uses the same content-addressed item/step identity as the delivered
 * runtime. Array indexes are deliberately absent from durable ids: reordering a
 * collection must not replay an already-completed side effect for another item. */
const FOREACH_SRC = [
  `const _sanitizeStepPart = (value: string): string => {`,
  `  const clean = (value || "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);`,
  `  return /[A-Za-z0-9]/.test(clean) ? clean : "step";`,
  `};`,
  `const _stableDigest96 = (value: string): string => {`,
  `  let hash = 0x6c62272e07bb014262b821756295c58dn;`,
  `  const prime = 0x0000000001000000000000000000013bn; const mask = (1n << 128n) - 1n;`,
  `  for (let i = 0; i < value.length; i++) hash = ((hash ^ BigInt(value.charCodeAt(i))) * prime) & mask;`,
  `  return hash.toString(16).padStart(32, "0").slice(-24);`,
  `};`,
  `const _stableForeachKey = (businessKey: string): string =>`,
  `  _sanitizeStepPart(businessKey).slice(0, 40) + "-" + _stableDigest96(businessKey);`,
  `const _foreachStepId = (parent: string, stableKey: string, child: string): string => {`,
  `  const p = _sanitizeStepPart(parent).slice(0, 16);`,
  `  const s = stableKey.length > 20 ? stableKey.slice(0, 7) + "-" + stableKey.slice(-12) : stableKey;`,
  `  const c = _sanitizeStepPart(child).slice(0, 16);`,
  `  return p + "-" + s + "-" + c + "-" + _stableDigest96(parent + "\\0" + stableKey + "\\0" + child);`,
  `};`,
].join("\n");

/** Canonical invoke envelope + a fail-closed deployment resolver. Generated
 * modules never disguise an invoke as a tool call or a step.run callback. */
const INVOKE_SRC = [
  `type _InvokeTargetResolver = (ref: string) => unknown;`,
  `const _resolveInvokeTarget = (ref: string): unknown => {`,
  `  const resolver = (globalThis as Record<string, unknown>).__agentInvokeTarget as _InvokeTargetResolver | undefined;`,
  `  if (!resolver) throw new Error("[park] invoke target resolver not injected (__agentInvokeTarget): " + ref);`,
  `  const target = resolver(ref);`,
  `  if (!target) throw new Error("[park] invoke target is not resolvable: " + ref);`,
  `  return target;`,
  `};`,
  `const _invokePayload = (args: { eventData: Record<string, unknown>; invokeInput?: Record<string, unknown>; forwardLastResult?: boolean; forwardResults?: boolean; lastResult?: unknown; results?: Record<string, unknown> }): Record<string, unknown> => {`,
  `  const last = args.forwardLastResult === false || args.lastResult == null ? {} : (typeof args.lastResult === "object" && !Array.isArray(args.lastResult) ? args.lastResult as Record<string, unknown> : { _lastResult: args.lastResult });`,
  `  const subject = args.eventData.subject ?? args.eventData._subject;`,
  `  const correlationId = args.eventData.__correlationId || args.eventData._correlationId;`,
  `  return { ...args.eventData, ...(args.invokeInput ?? {}), ...last, ...(args.forwardResults ? { _results: { ...(args.results ?? {}) } } : {}), ...(subject == null ? {} : { subject, _subject: subject }), ...(correlationId == null || correlationId === "" ? {} : { __correlationId: correlationId, _correlationId: correlationId }) };`,
  `};`,
].join("\n");

const VALUE_PATH_RE =
  /^[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z_$][A-Za-z0-9_$-]*)*$/;

/** The design/readiness gate normally validates plans first. The renderer still
 * guards its own executable boundary: unsupported loops and undeclared events
 * must fail at generation time instead of silently becoming a reasoning step. */
function assertRenderablePlan(
  plan: PlanStep[],
  declaredEvents: string[],
): void {
  const seen = new Set<string>();
  for (const step of plan) {
    const id = step.stepId || step.tool || step.kind;
    if (!id || seen.has(id))
      throw new Error(
        `cannot render plan: duplicate or empty stepId "${id || "(empty)"}"`,
      );
    seen.add(id);
    assertPlanDataflowRenderable(step, id);
    if (step.condition) {
      const conditionError = validateConditionSyntax(step.condition);
      if (conditionError) {
        throw new Error(
          `cannot render step "${id}": invalid condition — ${conditionError}`,
        );
      }
    }
    if (
      step.timeoutS !== undefined &&
      (!Number.isInteger(step.timeoutS) || step.timeoutS <= 0)
    ) {
      throw new Error(
        `cannot render step "${id}": timeoutS must be a positive integer`,
      );
    }
    if (step.kind === "emit") {
      if (!step.emitEvent)
        throw new Error(
          `cannot render emit step "${id}": emitEvent is required`,
        );
      if (!declaredEvents.includes(step.emitEvent)) {
        throw new Error(
          `cannot render emit step "${id}": event "${step.emitEvent}" is not in the declared emit allow-list`,
        );
      }
      if (step.emitPayloadFrom && !VALUE_PATH_RE.test(step.emitPayloadFrom)) {
        throw new Error(
          `cannot render emit step "${id}": emitPayloadFrom is not a safe data path`,
        );
      }
    }
    for (const rule of step.errorPolicy ?? []) {
      if (rule.emitEvent && !declaredEvents.includes(rule.emitEvent)) {
        throw new Error(
          `cannot render errorPolicy for "${id}": event "${rule.emitEvent}" is not in the declared emit allow-list`,
        );
      }
      if (rule.emitEvent && rule.suppressEmit) {
        throw new Error(
          `cannot render errorPolicy for "${id}": emitEvent and suppressEmit cannot both be set`,
        );
      }
    }
    if (step.kind === "foreach") {
      if (!step.itemsFrom || !VALUE_PATH_RE.test(step.itemsFrom)) {
        throw new Error(
          `cannot render foreach step "${id}": itemsFrom must be a safe data path`,
        );
      }
      if (!step.itemKeyFrom || !VALUE_PATH_RE.test(step.itemKeyFrom)) {
        throw new Error(
          `cannot render foreach step "${id}": itemKeyFrom must be a safe replay-stable data path`,
        );
      }
      if (!step.body?.length)
        throw new Error(`cannot render foreach step "${id}": body is required`);
      assertRenderablePlan(step.body, declaredEvents);
    }
  }
}

function indented(lines: string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
}

function emitPayloadLines(
  step: PlanStep,
  scopeExpr: string,
  selectedVar: string,
  payloadVar: string,
): string[] {
  const select = step.emitPayloadFrom
    ? `readConditionPath(${scopeExpr}, ${JSON.stringify(step.emitPayloadFrom)})`
    : `(${scopeExpr}).lastResult`;
  return [
    `const ${selectedVar} = ${select};`,
    ...(step.emitPayloadFrom
      ? [
          `if (${selectedVar} === undefined) throw new Error(${JSON.stringify(`[terminal] emit step ${step.stepId}: payload path ${step.emitPayloadFrom} did not resolve`)});`,
        ]
      : []),
    `const ${payloadVar}Base = ${selectedVar} && typeof ${selectedVar} === "object" && !Array.isArray(${selectedVar}) ? (${selectedVar} as Record<string, unknown>) : ${selectedVar} === undefined ? {} : { value: ${selectedVar} };`,
    `const ${payloadVar}: Record<string, unknown> = { ...${payloadVar}Base, ...${JSON.stringify(step.emitPayload ?? {})} };`,
  ];
}

function policySource(step: PlanStep): string {
  if (step.errorPolicy?.length) return JSON.stringify(step.errorPolicy);
  return step.onError ? JSON.stringify(step.onError) : "undefined";
}

/** Runtime-parity failure control flow for one rendered step. `continue` may
 * emit an explicit intent and/or suppress the historical implicit success;
 * retry/park remains retryable, while terminal becomes a real Inngest
 * NonRetriableError. */
function policyFailureLines(
  spec: GeneratedAgentSpec,
  step: PlanStep,
  id: string,
  lastVar: string,
  emitStepIdExpr: string,
): string[] {
  const fallback =
    step.defaultResult !== undefined
      ? JSON.stringify(step.defaultResult)
      : step.onError === "soft"
        ? "null"
        : "undefined";
  return [
    `const _resolution = _afResolveFailure(${policySource(step)}, e, ${fallback});`,
    `if (_resolution.suppressEmit) _suppressImplicitEmit = true;`,
    // #G16 — the declared failure emit must be sent BEFORE the terminal/retry
    // throws. Behind them it is dead code on every terminal path, which is how
    // an agent could lose a candidate silently: the run retires and the only
    // consumer that can escalate to a human never learns it happened.
    `if (_resolution.emitEvent && !_resolution.suppressEmit) {`,
    `  await step.sendEvent(${emitStepIdExpr}, { name: _resolution.emitEvent, data: _afFailurePayload(_resolution) });`,
    `  _explicitEmitCount++;`,
    `}`,
    `if (_resolution.disposition === "terminal") {`,
    `  throw new NonRetriableError("terminal action failure: " + _resolution.facts.message, { cause: e instanceof Error ? e : new Error(String(e)) });`,
    `}`,
    `if (_resolution.disposition === "retry") {`,
    `  const _tag = _resolution.policyAction === "park" ? "park" : "retry";`,
    `  throw new Error("[" + _tag + "] step ${id}: " + _resolution.facts.message, { cause: e instanceof Error ? e : undefined });`,
    `}`,
    `logger.warn(${JSON.stringify(`${spec.slug} step ${id} failed — continue by ordered error policy`)}, { action: _resolution.policyAction, facts: _resolution.facts });`,
    `${lastVar} = _resolution.defaultResult;`,
  ];
}

interface TsForeachEnv {
  depth: number;
  inputExpr: string;
  outerLastExpr: string;
  outerResultsExpr: string;
  outerLocalsExpr: string;
  assignTo: string;
  parentIdExpr: string;
}

/** Render one recursive foreach body. Every leaf side effect gets a durable
 * id derived from the full ancestor identity + current business key + child. */
function renderForeachBody(
  spec: GeneratedAgentSpec,
  parent: PlanStep,
  env: TsForeachEnv,
): string[] {
  const evName = spec.trigger?.[0] ?? "";
  const n = env.depth;
  const locals = `_locals${n}`;
  const localLast = `_localLast${n}`;
  const localResults = `_localResults${n}`;
  const localCond = `_localCond${n}`;
  const localSkipped = `_localSkipped${n}`;
  const localPass = `_localPass${n}`;
  const localCarry = `_localCarry${n}`;
  const localStepIds = `_localStepIds${n}`;
  const stableKey = `_stableKey${n}`;
  const out: string[] = [];
  for (const child of parent.body ?? []) {
    const id = child.stepId || child.tool || child.kind;
    const deps = (child.dependsOn ?? []).filter(Boolean);
    const childStepExpr = `_foreachStepId(${env.parentIdExpr}, ${stableKey}, ${JSON.stringify(id)})`;
    const failureEmitExpr = `_foreachStepId(${env.parentIdExpr}, ${stableKey}, ${JSON.stringify(`${id}-failure-emit`)})`;
    const resultsExpr = `{ ...(${env.outerResultsExpr}), ...${localResults} }`;
    const localScope = `{ ...${locals}, locals: ${locals}, event: { name: ${JSON.stringify(evName)}, data: { ...(${env.inputExpr}), ...${locals} } }, lastResult: ${localLast}, results: ${resultsExpr}, input: ${env.inputExpr} }`;
    const guards = [
      ...(deps.length ? [`${localPass}(${JSON.stringify(deps)})`] : []),
      ...(child.kind !== "condition" && child.condition
        ? [`evalCondition(${JSON.stringify(child.condition)}, ${localScope})`]
        : []),
    ];
    const core: string[] = [];

    if (child.kind === "condition") {
      core.push(
        `${localCond}[${JSON.stringify(id)}] = evalCondition(${JSON.stringify(child.condition ?? "")}, ${localScope});`,
        `${localResults}[${JSON.stringify(id)}] = { evaluated: ${localCond}[${JSON.stringify(id)}] };`,
      );
    } else {
      const execute: string[] = [];
      if (child.kind === "tool") {
        const toolArgs = renderedToolArguments(
          child,
          localScope,
          `${localCarry}()`,
        );
        if (toolArgs.legacy)
          execute.push(
            `// LEGACY WHOLE-CARRY: toolArguments 未声明；只为旧 plan 保留。`,
          );
        execute.push(
          `${localLast} = await step.run(${childStepExpr}, ${renderedToolCallback(child, `await callTool(${JSON.stringify(child.tool ?? id)}, ${toolArgs.expression})`)});`,
        );
      } else if (child.kind === "invoke") {
        const target = child.invoke ?? id;
        const eventData = `{ ...(${env.inputExpr}), ...${locals} }`;
        const payload = `_invokePayload({ eventData: ${eventData}, invokeInput: ${renderedInvokeInput(child.invokeInput as Record<string, unknown> | undefined, localScope)}, forwardLastResult: ${String(child.forwardLastResult ?? true)}, forwardResults: ${String(child.forwardResults ?? false)}, lastResult: ${localLast}, results: ${resultsExpr} })`;
        execute.push(
          `${localLast} = await step.invoke(${childStepExpr}, { function: _resolveInvokeTarget(${JSON.stringify(target)}), data: ${payload}${child.timeoutS ? `, timeout: ${JSON.stringify(`${child.timeoutS}s`)}` : ""} });`,
        );
      } else if (child.kind === "emit") {
        execute.push(
          ...emitPayloadLines(
            child,
            localScope,
            `_selected${n}`,
            `_payload${n}`,
          ),
        );
        execute.push(
          `await step.sendEvent(${childStepExpr}, { name: ${JSON.stringify(child.emitEvent)}, data: _payload${n} });`,
          `_explicitEmitCount++;`,
          `${localLast} = { ..._payload${n}, _emit: ${JSON.stringify(child.emitEvent)} };`,
        );
      } else if (child.kind === "foreach") {
        execute.push(
          ...renderForeachStep(spec, child, {
            depth: n + 1,
            inputExpr: env.inputExpr,
            outerLastExpr: localLast,
            outerResultsExpr: resultsExpr,
            outerLocalsExpr: locals,
            assignTo: localLast,
            parentIdExpr: childStepExpr,
          }),
        );
      } else {
        execute.push(
          `${localLast} = await step.run(${childStepExpr}, async () => await reasonCore(SYSTEM_PROMPT + ${JSON.stringify(`\n\n【foreach ${parent.stepId} 子步骤】${id}${child.description ? `：${child.description}` : ""}`)}, ${localCarry}()));`,
        );
      }
      core.push(
        `try {`,
        ...indented(execute, 2),
        `} catch (e) {`,
        ...indented(
          policyFailureLines(
            spec,
            child,
            `${parent.stepId}/${id}`,
            localLast,
            failureEmitExpr,
          ),
          2,
        ),
        `}`,
        `${localResults}[${JSON.stringify(id)}] = ${localLast};`,
      );
    }

    out.push(
      `${localStepIds}.push(${childStepExpr});`,
      `// foreach child ${id} (${child.kind})`,
    );
    if (guards.length) {
      out.push(
        `if (${guards.join(" && ")}) {`,
        ...indented(core, 2),
        `} else {`,
        `  ${localSkipped}.add(${JSON.stringify(id)});`,
        `  ${localResults}[${JSON.stringify(id)}] = { skipped: true, reason: "dependency condition was false or skipped" };`,
        `}`,
      );
    } else {
      out.push(...core);
    }
  }
  return out;
}

function renderForeachStep(
  spec: GeneratedAgentSpec,
  step: PlanStep,
  env: TsForeachEnv = {
    depth: 1,
    inputExpr: "mapped",
    outerLastExpr: "last",
    outerResultsExpr: "results",
    outerLocalsExpr: "{}",
    assignTo: "last",
    parentIdExpr: JSON.stringify(step.stepId || "foreach"),
  },
): string[] {
  const id = step.stepId || "foreach";
  const evName = spec.trigger?.[0] ?? "";
  const n = env.depth;
  const collection = `_collection${n}`;
  const seenKeys = `_seenKeys${n}`;
  const seenStableKeys = `_seenStableKeys${n}`;
  const receipts = `_receipts${n}`;
  const index = `_index${n}`;
  const item = `_item${n}`;
  const locals = `_locals${n}`;
  const keyValue = `_keyValue${n}`;
  const businessKey = `_businessKey${n}`;
  const stableKey = `_stableKey${n}`;
  const localLast = `_localLast${n}`;
  const localResults = `_localResults${n}`;
  const localCond = `_localCond${n}`;
  const localSkipped = `_localSkipped${n}`;
  const localPass = `_localPass${n}`;
  const localStepIds = `_localStepIds${n}`;
  const localCarry = `_localCarry${n}`;
  const emitCountBefore = `_emitCountBefore${n}`;
  const hasConditionalEmit = (step.body ?? []).some(
    (child) => child.kind === "emit" && Boolean(child.condition),
  );
  const scope = `{ event: { name: ${JSON.stringify(evName)}, data: { ...(${env.inputExpr}), ...(${env.outerLocalsExpr}) } }, lastResult: ${env.outerLastExpr}, results: ${env.outerResultsExpr}, input: ${env.inputExpr}, locals: ${env.outerLocalsExpr} }`;
  return [
    `const ${collection} = readConditionPath(${scope}, ${JSON.stringify(step.itemsFrom)});`,
    `if (!Array.isArray(${collection})) throw new Error(${JSON.stringify(`[terminal] foreach ${id}: itemsFrom ${step.itemsFrom} did not resolve to an array`)});`,
    `const ${seenKeys} = new Set<string>();`,
    `const ${seenStableKeys} = new Map<string, string>();`,
    `const ${receipts}: Array<Record<string, unknown>> = [];`,
    `for (let ${index} = 0; ${index} < ${collection}.length; ${index}++) {`,
    `  const ${item} = ${collection}[${index}];`,
    `  const ${locals}: Record<string, unknown> = { ...(${env.outerLocalsExpr}), ${JSON.stringify(step.itemAs?.trim() || "item")}: ${item}, index: ${index} };`,
    `  const ${keyValue} = readConditionPath({ ...${locals}, locals: ${locals}, event: { name: ${JSON.stringify(evName)}, data: { ...(${env.inputExpr}), ...${locals} } }, lastResult: ${item}, results: ${env.outerResultsExpr}, input: ${env.inputExpr} }, ${JSON.stringify(step.itemKeyFrom)});`,
    `  if (${keyValue} == null || String(${keyValue}).trim() === "") throw new Error(${JSON.stringify(`[terminal] foreach ${id}: item has no stable key at ${step.itemKeyFrom}`)} + " (#" + ${index} + ")");`,
    `  const ${businessKey} = String(${keyValue});`,
    `  if (${seenKeys}.has(${businessKey})) throw new Error(${JSON.stringify(`[terminal] foreach ${id}: duplicate item key `)} + ${businessKey});`,
    `  ${seenKeys}.add(${businessKey});`,
    `  const ${stableKey} = _stableForeachKey(${businessKey});`,
    `  if (${seenStableKeys}.has(${stableKey}) && ${seenStableKeys}.get(${stableKey}) !== ${businessKey}) throw new Error(${JSON.stringify(`[terminal] foreach ${id}: stable key collision for `)} + ${businessKey});`,
    `  ${seenStableKeys}.set(${stableKey}, ${businessKey});`,
    `  ${locals}.key = ${businessKey}; ${locals}.stableKey = ${stableKey};`,
    `  ${locals}._foreachPath = [...(Array.isArray((${env.outerLocalsExpr} as Record<string, unknown>)._foreachPath) ? ((${env.outerLocalsExpr} as Record<string, unknown>)._foreachPath as unknown[]) : []), ${businessKey}];`,
    `  let ${localLast}: unknown = ${item};`,
    `  const ${localResults}: Record<string, unknown> = {};`,
    `  const ${localCond}: Record<string, boolean> = {};`,
    `  const ${localSkipped} = new Set<string>();`,
    `  const ${localPass} = (deps: string[]): boolean => deps.every((dep) => !${localSkipped}.has(dep) && ${localCond}[dep] !== false);`,
    `  const ${localStepIds}: string[] = [];`,
    `  const ${localCarry} = (): Record<string, unknown> => ({ ...(${env.inputExpr}), ...(${env.outerLastExpr} && typeof ${env.outerLastExpr} === "object" ? (${env.outerLastExpr} as Record<string, unknown>) : {}), ...${locals}, ...(${localLast} && typeof ${localLast} === "object" ? (${localLast} as Record<string, unknown>) : {}), results: { ...(${env.outerResultsExpr}), ...${localResults} } });`,
    ...(hasConditionalEmit
      ? [`  const ${emitCountBefore} = _explicitEmitCount;`]
      : []),
    ...indented(renderForeachBody(spec, step, env), 2),
    ...(hasConditionalEmit
      ? [
          `  if (_explicitEmitCount === ${emitCountBefore}) throw new Error(${JSON.stringify(`[park] foreach ${id}: no authoritative conditional emit guard matched`)});`,
        ]
      : []),
    `  ${receipts}.push({ index: ${index}, key: ${businessKey}, stableKey: ${stableKey}, path: ${locals}._foreachPath, item: ${item}, stepIds: ${localStepIds}, results: ${localResults}, lastResult: ${localLast} });`,
    `}`,
    `${env.assignTo} = { count: ${receipts}.length, items: ${receipts}, byKey: Object.fromEntries(${receipts}.map((receipt) => [String(receipt.stableKey), receipt])) };`,
  ];
}

/** #G8 — deterministic precondition over the declared required input anchors. */
function renderRequiredInputGuard(fields: IoField[] | undefined): string[] {
  const required = (fields ?? [])
    .filter((f) => f && f.field && f.required)
    .map((f) => f.field);
  if (required.length === 0) return [];
  return [
    `    const _missingAnchors = ${JSON.stringify(required)}.filter((k) => mapped[k] == null || String(mapped[k]).trim() === "");`,
    `    if (_missingAnchors.length > 0) {`,
    `      throw new NonRetriableError(AGENT_ID + " missing required input anchors: " + _missingAnchors.join(", "));`,
    `    }`,
  ];
}

// ── #SLOT-3 controlFlow(plan[] 驱动的真实步骤)──────────────────────────────────
/** 渲染 plan[] 步骤为真实执行代码(step.run 稳定 id + 条件门控 + onError 策略)。 */
function renderPlanSteps(spec: GeneratedAgentSpec, plan: PlanStep[]): string {
  const evName = spec.trigger?.[0] ?? "";
  const out: string[] = [];
  for (const p of plan) {
    const id = p.stepId || p.tool || p.kind;
    const deps = (p.dependsOn ?? []).filter(Boolean);
    const baseId = stepId(
      p.kind === "tool" ? "call" : p.kind === "invoke" ? "invoke" : "do",
      `${spec.slug}-${id}`,
    );
    // #G6 — resolve the suffix against the whole scope, so "input.x",
    // "results.<step>.y" and "lastResult.z" all address something real.
    const idScope = `{ input: mapped, event: { name: ${JSON.stringify(evName)}, data: mapped }, lastResult: last, results }`;
    const guards = [
      ...(deps.length ? [`_pass(${JSON.stringify(deps)})`] : []),
      ...(p.kind !== "condition" && p.condition
        ? [`evalCondition(${JSON.stringify(p.condition)}, ${idScope})`]
        : []),
    ];
    const idExpr = p.idempotencyKeyFrom
      ? `${JSON.stringify(baseId)} + idSuffix(${idScope}, ${JSON.stringify(p.idempotencyKeyFrom)})`
      : JSON.stringify(baseId);

    let execute: string[];
    switch (p.kind) {
      case "condition":
        out.push(
          `      // step ${id} (condition)`,
          `      _cond[${JSON.stringify(id)}] = evalCondition(${JSON.stringify(p.condition ?? "")}, { event: { name: ${JSON.stringify(evName)}, data: mapped }, lastResult: last, results, input: mapped });`,
          `      results[${JSON.stringify(id)}] = { evaluated: _cond[${JSON.stringify(id)}] };`,
        );
        if (p.routes?.onTrue && p.routes.onFalse) {
          // #G2 — bind the verdict to a terminal event so the emit block can
          // read it. Without this the result is computed and discarded.
          out.push(
            `      _route = _cond[${JSON.stringify(id)}] ? ${JSON.stringify(p.routes.onTrue)} : ${JSON.stringify(p.routes.onFalse)};`,
          );
        }
        continue;
      case "tool":
        {
          const scope = `{ event: { name: ${JSON.stringify(evName)}, data: mapped }, lastResult: last, results, input: mapped }`;
          const toolArgs = renderedToolArguments(p, scope, "carry()");
          execute = [
            ...(toolArgs.legacy
              ? [
                  `// LEGACY WHOLE-CARRY: toolArguments 未声明；只为旧 plan 保留。`,
                ]
              : []),
            `last = await step.run(${idExpr}, ${renderedToolCallback(p, `await callTool(${JSON.stringify(p.tool ?? id)}, ${toolArgs.expression})`)});`,
          ];
        }
        break;
      case "invoke": {
        const scope = `{ event: { name: ${JSON.stringify(evName)}, data: mapped }, lastResult: last, results, input: mapped }`;
        execute = [
          `last = await step.invoke(${idExpr}, { function: _resolveInvokeTarget(${JSON.stringify(p.invoke ?? id)}), data: _invokePayload({ eventData: mapped, invokeInput: ${renderedInvokeInput(p.invokeInput as Record<string, unknown> | undefined, scope)}, forwardLastResult: ${String(p.forwardLastResult ?? true)}, forwardResults: ${String(p.forwardResults ?? false)}, lastResult: last, results })${p.timeoutS ? `, timeout: ${JSON.stringify(`${p.timeoutS}s`)}` : ""} });`,
        ];
        break;
      }
      case "emit": {
        const scope = `{ event: { name: ${JSON.stringify(evName)}, data: mapped }, lastResult: last, results, input: mapped }`;
        execute = [
          ...emitPayloadLines(p, scope, "_selected", "_payload"),
          `await step.sendEvent(${JSON.stringify(stepId("emit", `${spec.slug}-${id}`))}, { name: ${JSON.stringify(p.emitEvent)}, data: _payload });`,
          `_explicitEmitCount++;`,
          `last = { ..._payload, _emit: ${JSON.stringify(p.emitEvent)} };`,
        ];
        break;
      }
      case "foreach":
        execute = renderForeachStep(spec, p);
        break;
      default: // logic
        execute = [
          `last = await step.run(${idExpr}, async () => await reasonCore(SYSTEM_PROMPT + ${JSON.stringify(`\n\n【当前子步骤】${id}${p.description ? `：${p.description}` : ""}`)}, carry()));`,
        ];
    }

    const catchLines = policyFailureLines(
      spec,
      p,
      String(id),
      "last",
      JSON.stringify(stepId("emit-policy", `${spec.slug}-${id}`)),
    ).map((line) => `        ${line}`);

    const tryBlock = [
      `      try {`,
      ...execute.map((line) => `        ${line}`),
      `      } catch (e) {`,
      ...catchLines,
      `      }`,
      `      results[${JSON.stringify(id)}] = last;`,
    ];

    if (guards.length) {
      out.push(
        `      // step ${id} (${p.kind}) — 依赖: ${deps.join(", ")}`,
        `      if (${guards.join(" && ")}) {`,
        ...tryBlock.map((l) => `  ${l}`),
        `      } else {`,
        `        _skipped.add(${JSON.stringify(id)});`,
        `        logger.info("${esc(spec.slug)} skip step ${esc(String(id))} (依赖条件不成立)");`,
        `      }`,
      );
    } else {
      out.push(
        `      // step ${id} (${p.kind})${p.description ? ` — ${p.description.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
        ...tryBlock,
      );
    }
  }
  return out.join("\n");
}

/** 渲染一个 ts_function_module。 */
export function renderTsFunctionModule(
  spec: GeneratedAgentSpec,
  opts: TsFunctionModuleOpts = {},
): string {
  const profile = opts.profile ?? "new-ao";
  const short = spec.short || spec.actionName || "agent";
  const exportName = camel(short) + (/agent$/i.test(short) ? "" : "Agent");
  const tools = (spec.tools ?? []).filter(Boolean);
  const emits = (spec.emit ?? []).filter(Boolean);
  const triggers = (spec.trigger ?? []).filter(Boolean);
  const plan = (spec.plan ?? []).filter(Boolean);
  assertRenderablePlan(plan, emits);
  const allSteps = (steps: PlanStep[]): PlanStep[] =>
    steps.flatMap((step) => [step, ...(step.body ? allSteps(step.body) : [])]);
  const flattenedPlan = allSteps(plan);
  // HITL 强制 retries=1(人工闸不该自动重试;旧 AO 惯例);否则尊重 spec.retries,缺省 3。
  const retries = spec.hitl ? 1 : (spec.retries ?? 3);
  const failEmit = failEmitOf(spec);
  const successEmit = emits[0] ?? "DONE";
  const hasConditions = flattenedPlan.some((p) => Boolean(p.condition));
  const hasForeach = flattenedPlan.some((p) => p.kind === "foreach");
  const hasInvoke = flattenedPlan.some((p) => p.kind === "invoke");
  const hasExplicitEmits = flattenedPlan.some(
    (p) =>
      p.kind === "emit" ||
      p.errorPolicy?.some((rule) => Boolean(rule.emitEvent)),
  );
  const hasConditionalExplicitEmits = flattenedPlan.some(
    (p) => p.kind === "emit" && Boolean(p.condition),
  );
  const hasExactDataflow = planUsesExactDataflow(plan);
  const hasPathRuntime =
    hasConditions ||
    hasForeach ||
    hasExactDataflow ||
    flattenedPlan.some((p) => p.kind === "emit" && Boolean(p.emitPayloadFrom));
  const hasGating =
    hasConditions || flattenedPlan.some((p) => (p.dependsOn ?? []).length > 0);
  const hasSuffix = plan.some((p) => p.idempotencyKeyFrom);

  // 触发器:多 trigger → triggers:[{event}]（旧 create-jd 就是多 trigger）。
  const triggerConfig =
    triggers.length <= 1
      ? `{ event: ${JSON.stringify(triggers[0] ?? `${spec.domainId}/entry`)} }`
      : `[${triggers.map((t) => `{ event: ${JSON.stringify(t)} }`).join(", ")}]`;

  // 共享基础设施 = import-不生成。new-AO:工具经注入缝(真部署接运行时 registry);old-AO:@/lib/*。
  const imports =
    profile === "old-ao"
      ? [
          `import { inngest } from "@/server/inngest/client";`,
          `import { NonRetriableError } from "inngest";`,
          ...(tools.length
            ? [
                `// [deploy-profile] 真部署时解开这些共享库 import 并把 __agentTool 接到它们:`,
                ...tools.map(
                  (t) =>
                    `// import { ${camel(t.split(".").pop() || "call")} } from "@/lib/${t.split(".")[0]}";`,
                ),
              ]
            : []),
        ]
      : [
          `import { inngest } from "@/server/inngest/client";`,
          `import { NonRetriableError } from "inngest";`,
          `// [deploy-profile] new-AO 形态:外部能力经注入缝 __agentTool → 运行时全局工具 registry。`,
          ...(tools.length
            ? [`// 本 agent 绑定的工具:${tools.join(", ")}`]
            : [`// 本 agent 不依赖外部工具。`]),
        ];

  // 步骤体:plan[] 优先(#SLOT-3 真控制流);否则每个绑定工具一个 step.run 真调用。
  const stepRuns = plan.length
    ? renderPlanSteps(spec, plan)
    : tools.length
      ? tools
          .map((t) => {
            const v = camel(t.split(".").pop() || "call");
            const id = stepId(v, `${spec.slug}-${t}`);
            return [
              `      // LEGACY WHOLE-CARRY: spec 没有 plan/toolArguments；旧绑定工具兼容调用。`,
              `      // 外部调用「${t}」包在 step.run(稳定 id):幂等 + durable;经注入缝真调用(fail-close)。`,
              `      try {`,
              `        last = await step.run(${JSON.stringify(id)}, async () => await callTool(${JSON.stringify(t)}, carry()));`,
              `      } catch (e) {`,
              `        logger.warn("${esc(spec.slug)} tool ${esc(t)} failed — recorded, decision core will see it", { error: String(e) });`,
              `        last = { _toolFailed: ${JSON.stringify(t)}, _error: String((e as Error)?.message ?? e) };`,
              `      }`,
            ].join("\n");
          })
          .join("\n")
      : "      // (无外部调用——纯推理决策)";

  const emitInstr =
    emits.length > 1
      ? `\n只输出 JSON;必须附字段 "emit" 选择产出事件,取值之一:${emits.join(" | ")};判定失败/拒绝时选失败/拒绝类事件。`
      : "\n只输出 JSON。";

  // emit:单 emit 直发;多 emit 真选择(决策核心显式 emit 优先;失败走失败分支)——每个事件一个
  // 字面量分支 + 稳定 step id(重放稳定,也让事件名可静态审计)。
  const emitBlock =
    emits.length <= 1
      ? `      await step.sendEvent(${JSON.stringify(stepId("emit", successEmit))}, { name: ${JSON.stringify(successEmit)}, data: { ...carry(), ...decision } });`
      : [
          // #G1 — the terminal event is a function of the computed verdict, never
          // of an LLM's free-text `emit`. A model that answered "REJECTED", or
          // answered nothing at all, used to decide whether a candidate was
          // rejected or an invitation was declared sent — with no evidence
          // behind either. A plan's routing condition (#G2) decides first;
          // otherwise the pass/fail verdict does.
          `      // #SLOT-3 多路收敛:终态由计算出的判定决定(路由条件优先;失败 → ${failEmit})`,
          `      const _declared = ${JSON.stringify(emits)};`,
          `      const _failed = decision.pass === false || decision.ok === false;`,
          `      let _chosen = _failed ? ${JSON.stringify(failEmit)} : ${JSON.stringify(successEmit)};`,
          `      if (typeof _route === "string" && _declared.includes(_route)) _chosen = _route;`,
          `      const _data = { ...carry(), ...decision };`,
          ...emits.map(
            (e, i) =>
              `      ${i === 0 ? "if" : "else if"} (_chosen === ${JSON.stringify(e)}) await step.sendEvent(${JSON.stringify(stepId("emit", e))}, { name: ${JSON.stringify(e)}, data: _data });`,
          ),
          `      else await step.sendEvent(${JSON.stringify(stepId("emit", failEmit))}, { name: ${JSON.stringify(failEmit)}, data: _data });`,
        ].join("\n");

  const gatingDecls = hasGating
    ? [
        `    const _cond: Record<string, boolean> = {};`,
        `    const _skipped = new Set<string>();`,
        `    const _pass = (deps: string[]) => deps.every((d) => !_skipped.has(d) && _cond[d] !== false);`,
      ].join("\n")
    : "";

  return [
    `// ${spec.nameZh || short} — 由 OntoCode 从本体动作 \`${spec.actionName}\`(${spec.domainId})生成。`,
    `// 目标形态:可部署到 Inngest 的 function(对标旧 AO server/inngest/agents/*.ts)。`,
    `// trigger: ${triggers.join(" / ") || "(entry)"} → emit: ${emits.join(" | ") || "(terminal)"}`,
    ``,
    ...imports.filter(Boolean),
    ``,
    `const AGENT_ID = ${JSON.stringify(spec.slug)};`,
    `/** OntoCode 为这一个 agent 基于本体推理生成的 system prompt。 */`,
    "const SYSTEM_PROMPT = `" + esc(spec.systemPrompt ?? "") + "`;",
    ``,
    renderMapFields(spec.inputSchema),
    ``,
    CLASSIFY_ERROR_SRC,
    ``,
    `// #SLOT-3 controlFlow — 多路径/循环控制流。`,
    `//   黄金范例:rule-check 三路 JR 收敛 + per-JR fan-out;resume-parser 双路(parsed/etag)分叉。`,
    plan.length
      ? `//   已按 spec.plan[] 确定性填实:条件真门控(dependsOn/evalCondition)+ 逐步 step.run 稳定 id${hasSuffix ? " + idempotencyKeyFrom 后缀" : ""} + onError 策略。`
      : `//   本 spec 未声明 plan[]——按绑定工具顺序逐个 step.run 真调用;声明 plan[] 后重渲染即得真控制流。`,
    `// ──────────────────────────────────────────────────────────────────────────`,
    ``,
    SEAM_SRC,
    ``,
    ...(hasPathRuntime ? [EVAL_CONDITION_SRC, ``] : []),
    ...(hasExactDataflow ? [PLAN_DATAFLOW_RUNTIME_SRC, ``] : []),
    ...(plan.length ? [ERROR_POLICY_RUNTIME_SRC, ``] : []),
    ...(hasForeach ? [FOREACH_SRC, ``] : []),
    ...(hasInvoke ? [INVOKE_SRC, ``] : []),
    ...(hasSuffix ? [SUFFIX_SRC, ``] : []),
    `export const ${exportName} = inngest.createFunction(`,
    `  { id: AGENT_ID, name: ${JSON.stringify(short)}, retries: ${retries} },`,
    `  ${triggerConfig},`,
    `  async ({ event, step, logger }) => {`,
    `    // generic function 只消费 canonical event.data；tenant adapter 必须在进入 handler 前完成旧信封解包。`,
    `    const raw = (event.data ?? {}) as Record<string, unknown>;`,
    `    const mapped = mapFields(raw);`,
    // #G8 — inputSchema.required was declared and then dropped: a missing anchor
    // was only noticed by whichever tool step happened to bind it, which for a
    // resume flow is AFTER a paid vendor parse and a 90s child invoke. Fail
    // closed here instead, before anything is spent, and do it with a
    // NonRetriableError so a permanently malformed event is not retried 4 times.
    ...renderRequiredInputGuard(spec.inputSchema),
    `    let last: unknown = undefined;`,
    `    const results: Record<string, unknown> = {};`,
    `    const carry = (): Record<string, unknown> => ({ ...mapped, ...(last && typeof last === "object" ? (last as Record<string, unknown>) : {}), results: { ...results } });`,
    `    let _explicitEmitCount = 0;`,
    `    let _suppressImplicitEmit = false;`,
    // #G2 — the terminal event a routing condition selected, if the plan has one.
    `    let _route: string | undefined = undefined;`,
    ...(gatingDecls ? [gatingDecls] : []),
    ...(opts.pauseGate
      ? [
          `    // 暂停闸(fleet kill-switch)——任何工作之前。`,
          `    // const paused = await ${opts.pauseGate}(AGENT_ID, logger); if (paused) return paused;`,
        ]
      : []),
    `    logger.info("${esc(spec.slug)} handler.start", { keys: Object.keys(mapped) });`,
    `    try {`,
    stepRuns,
    `      // 决策核心(fail-close):SYSTEM_PROMPT over mapped+lastResult,经注入缝走真 LLM;未注入/失败即抛(park)。`,
    `      const decision = (await step.run(${JSON.stringify(stepId("decide", spec.slug))}, async () => await reasonCore(SYSTEM_PROMPT + ${JSON.stringify(emitInstr)}, { input: mapped, lastResult: last, results }))) as Record<string, unknown> & { pass?: boolean; ok?: boolean; emit?: string };`,
    ...(hasConditionalExplicitEmits
      ? [
          `      // Conditional explicit emits own routing. A guard miss is`,
          `      // unresolved and must never fall back to model-selected text.`,
          `      if (_explicitEmitCount === 0 && !_suppressImplicitEmit) {`,
          `        throw new Error("[park] no authoritative conditional emit guard matched");`,
          `      }`,
        ]
      : hasExplicitEmits
        ? [
            `      // 显式 emit plan 是权威 multi-emit；只有本次路径一个都没发时才走隐式终态选择。`,
            `      if (_explicitEmitCount === 0 && !_suppressImplicitEmit) {`,
            ...emitBlock.split("\n").map((line) => `  ${line}`),
            `      }`,
          ]
        : [
            `      if (!_suppressImplicitEmit) {`,
            ...emitBlock.split("\n").map((line) => `  ${line}`),
            `      }`,
          ]),
    `      logger.info("${esc(spec.slug)} handler.done");`,
    `      return { ok: decision.pass !== false && decision.ok !== false };`,
    `    } catch (e) {`,
    `      if ((e as Error)?.name === "NonRetriableError" || /^\[(?:retry|park)\]/.test(String((e as Error)?.message ?? e))) throw e;`,
    `      const kind = classifyError(e);`,
    `      // park / rethrow → 上抛(Inngest 重试 / 强制持久化失败);business_fail / terminal → 发 _FAILED。`,
    `      if (kind === "park" || kind === "rethrow") throw e;`,
    `      await step.sendEvent(${JSON.stringify(stepId("emit", failEmit))}, { name: ${JSON.stringify(failEmit)}, data: { ...mapped, error: String((e as Error)?.message ?? e) } });`,
    `      return { ok: false };`,
    `    }`,
    `  },`,
    `);`,
    ``,
  ].join("\n");
}
