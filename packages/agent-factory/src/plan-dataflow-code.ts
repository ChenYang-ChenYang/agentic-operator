import type { PlanStep } from "./spec-types";

const SAFE_PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/;
const SAFE_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function safeJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => safeJson(entry, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([key, entry]) => !UNSAFE_KEYS.has(key) && safeJson(entry, seen));
}

export function assertPlanDataflowRenderable(step: PlanStep, id: string): void {
  if (step.kind !== "tool" && (step.toolArguments || step.resultMap)) {
    throw new Error(`cannot render step "${id}": toolArguments/resultMap are only valid for tool steps`);
  }
  if (step.toolArguments) {
    if (!Object.keys(step.toolArguments).length) throw new Error(`cannot render tool step "${id}": toolArguments is empty`);
    for (const [argument, source] of Object.entries(step.toolArguments)) {
      if (!SAFE_NAME_RE.test(argument) || UNSAFE_KEYS.has(argument)) throw new Error(`cannot render tool step "${id}": unsafe argument name "${argument}"`);
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`cannot render tool step "${id}": argument ${argument} is not an explicit source`);
      const record = source as unknown as Record<string, unknown>;
      const hasFrom = Object.prototype.hasOwnProperty.call(record, "from");
      const hasConst = Object.prototype.hasOwnProperty.call(record, "const");
      // #G13 —— 三选一：from / fromFirst / const。
      const hasFromFirst = Object.prototype.hasOwnProperty.call(record, "fromFirst");
      const chosen = [hasFrom, hasFromFirst, hasConst].filter(Boolean).length;
      if (chosen !== 1 || Object.keys(record).some((key) => !["from", "fromFirst", "required", "const"].includes(key))) {
        throw new Error(`cannot render tool step "${id}": argument ${argument} must choose exactly one of from/fromFirst/const`);
      }
      if (hasFrom || hasFromFirst) {
        const candidates = hasFrom
          ? [typeof record.from === "string" ? record.from : ""]
          : Array.isArray(record.fromFirst) ? record.fromFirst.map((v) => (typeof v === "string" ? v : "")) : [];
        // 一条候选也不能放松：可选性放宽的是「取不到怎么办」，不是「能取哪里」。
        if (hasFromFirst && candidates.length < 2) {
          throw new Error(`cannot render tool step "${id}": argument ${argument}.fromFirst needs at least two candidates`);
        }
        for (const from of candidates) {
          if (!SAFE_PATH_RE.test(from) || !/^(event(?:\.|$)|input(?:\.|$)|lastResult(?:\.|$)|results(?:\.|$)|locals(?:\.|$))/.test(from)) {
            throw new Error(`cannot render tool step "${id}": argument ${argument} has an unsafe/unrooted path`);
          }
        }
        if (record.required !== undefined && typeof record.required !== "boolean") throw new Error(`cannot render tool step "${id}": argument ${argument}.required must be boolean`);
      } else if (!safeJson(record.const)) {
        throw new Error(`cannot render tool step "${id}": argument ${argument} constant is not finite JSON`);
      }
    }
  }
  if (step.resultMap) {
    if (!Object.keys(step.resultMap.fields ?? {}).length) throw new Error(`cannot render tool step "${id}": resultMap.fields is empty`);
    for (const [field, value] of Object.entries(step.resultMap.fields)) {
      if (!SAFE_NAME_RE.test(field) || UNSAFE_KEYS.has(field) || field === "_raw") throw new Error(`cannot render tool step "${id}": unsafe resultMap field "${field}"`);
      // #G12 —— 字段值可以是裸路径（必需）或对象形态（可选/默认值/回退）。
      // 每一条候选路径都要过同一套安全检查：可选性放宽的是「取不到怎么办」，绝不放宽「能取哪里」。
      const paths = typeof value === "string"
        ? [value]
        : [value.from, ...(value.fallbackFrom ?? [])];
      for (const path of paths) {
        if (!SAFE_PATH_RE.test(path) || !/^result(?:\.|$)/.test(path)) throw new Error(`cannot render tool step "${id}": resultMap.${field} has an unsafe/unrooted path`);
      }
    }
  }
}

/** Self-contained runtime used by both generated TypeScript renderers. It
 * deliberately consumes only authored templates; it never derives arguments
 * from a tool name or merges the carry when toolArguments is present. */
export const PLAN_DATAFLOW_RUNTIME_SRC = `
type _AfToolArgument = { from: string; required?: boolean } | { fromFirst: string[]; required?: boolean } | { const: unknown };
type _AfResultField = string | { from: string; required?: boolean; default?: unknown; fallbackFrom?: string[]; fallbackConst?: unknown };
type _AfResultMap = { fields: Record<string, _AfResultField>; includeRaw?: boolean };
// #G12/#G13 —— 唯一的"取第一个可用值"实现。空串与纯空白算未命中：一个只有空格的字段
// 不是一个值，而裸 ?? 会把它当成有值收下。
function _afFirstPresent(values: unknown[]): unknown {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return undefined;
}
function _afCloneJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("[terminal] tool argument is not finite JSON"); return value; }
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("[terminal] tool argument is not JSON");
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => _afCloneJson(entry, seen));
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = _afCloneJson(entry, seen);
  return out;
}
function _afToolArguments(template: Record<string, _AfToolArgument>, scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [argument, source] of Object.entries(template)) {
    const hasFrom = Object.prototype.hasOwnProperty.call(source, "from");
    const hasFromFirst = Object.prototype.hasOwnProperty.call(source, "fromFirst");
    const hasConst = Object.prototype.hasOwnProperty.call(source, "const");
    if ([hasFrom, hasFromFirst, hasConst].filter(Boolean).length !== 1) throw new Error("[terminal] tool argument " + argument + " must choose exactly one of from/fromFirst/const");
    if (hasFrom) {
      const path = String((source as { from: string }).from ?? "");
      const value = readConditionPath(scope, path);
      if (value === undefined) {
        if ((source as { required?: boolean }).required === false) continue;
        throw new Error("[terminal] required tool argument path did not resolve: " + argument + " <- " + path);
      }
      out[argument] = _afCloneJson(value);
    } else if (hasFromFirst) {
      // #G13 —— 这里把 null 也算未命中（单 from 不会）。null 正是"事件带了这个字段但它是空的"，
      // 而那恰恰是应该走回退的情形；把它当值收下就等于没有回退。
      const paths = (source as { fromFirst: string[] }).fromFirst ?? [];
      const value = _afFirstPresent(paths.map((path) => readConditionPath(scope, String(path))));
      if (value === undefined) {
        if ((source as { required?: boolean }).required === false) continue;
        throw new Error("[terminal] no candidate resolved for required tool argument: " + argument + " <- " + paths.join(" | "));
      }
      out[argument] = _afCloneJson(value);
    } else {
      out[argument] = _afCloneJson((source as { const: unknown }).const);
    }
  }
  return out;
}
// #G4 — an invoked child's payload. A value may be a {from}/{const} descriptor
// (resolve it) or a plain literal (pass it through). Before this existed the
// whole object was inlined verbatim, so a descriptor travelled to the callee as
// an object AND — because the payload is spread after the inbound event data —
// overwrote the real value it was meant to select. A required:false descriptor
// on an unresolvable path drops the key rather than poisoning it.
function _afInvokeInput(template: Record<string, unknown>, scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [argument, source] of Object.entries(template)) {
    if (!source || typeof source !== "object" || Array.isArray(source)) { out[argument] = source; continue; }
    const hasFrom = Object.prototype.hasOwnProperty.call(source, "from");
    const hasFromFirst = Object.prototype.hasOwnProperty.call(source, "fromFirst");
    const hasConst = Object.prototype.hasOwnProperty.call(source, "const");
    const chosen = [hasFrom, hasFromFirst, hasConst].filter(Boolean).length;
    if (chosen === 0) { out[argument] = source; continue; }
    if (chosen > 1) throw new Error("[terminal] invoke input " + argument + " must choose exactly one of from/fromFirst/const");
    if (hasConst) { out[argument] = _afCloneJson((source as { const: unknown }).const); continue; }
    if (hasFromFirst) {
      const paths = (source as { fromFirst: string[] }).fromFirst ?? [];
      const picked = _afFirstPresent(paths.map((path) => readConditionPath(scope, String(path))));
      if (picked === undefined) {
        if ((source as { required?: boolean }).required === false) continue;
        throw new Error("[terminal] no candidate resolved for required invoke input: " + argument + " <- " + paths.join(" | "));
      }
      out[argument] = _afCloneJson(picked);
      continue;
    }
    const path = String((source as { from: string }).from ?? "");
    const value = readConditionPath(scope, path);
    if (value === undefined) {
      if ((source as { required?: boolean }).required === false) continue;
      throw new Error("[terminal] required invoke input path did not resolve: " + argument + " <- " + path);
    }
    out[argument] = _afCloneJson(value);
  }
  return out;
}
function _afMapToolResult(raw: unknown, map: _AfResultMap): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const read = (path: string): unknown => (path === "result" ? raw : readPath(raw, path.slice("result.".length)));
  for (const [field, source] of Object.entries(map.fields)) {
    // 裸字符串 = 必需：取不到就终态失败。旧 plan 的语义逐字节不变。
    if (typeof source === "string") {
      const value = read(source);
      if (value === undefined) throw new Error("[terminal] tool result path did not resolve: " + field + " <- " + source);
      out[field] = value;
      continue;
    }
    // #G12 —— 对象形态：按序 from → fallbackFrom → fallbackConst → default。
    // 一个 200 但没带可选字段的响应不应该杀掉整条本来成功的路径。
    const candidates = [source.from].concat(source.fallbackFrom ?? []);
    let value = _afFirstPresent(candidates.map(read));
    if (value === undefined && source.fallbackConst !== undefined) value = source.fallbackConst;
    if (value === undefined && source.default !== undefined) value = source.default;
    if (value === undefined) {
      if (source.required === false) continue;
      throw new Error("[terminal] tool result path did not resolve: " + field + " <- " + candidates.join(" | "));
    }
    out[field] = value;
  }
  if (map.includeRaw === true) out._raw = raw;
  return out;
}
`.trim();

export function planUsesExactDataflow(plan: PlanStep[]): boolean {
  return plan.some((step) =>
    // #G4 — an invoke payload is resolved by this runtime too, so a plan that
    // only carries `invokeInput` still needs the prelude emitted.
    Boolean(step.toolArguments || step.resultMap || step.invokeInput)
    || (step.body ? planUsesExactDataflow(step.body) : false));
}

/** Render the exact argument expression and an explicit compatibility marker
 * for old plan rows. */
export function renderedToolArguments(
  step: PlanStep,
  scopeExpression: string,
  legacyCarryExpression: string,
): { expression: string; legacy: boolean } {
  if (!step.toolArguments) {
    return { expression: legacyCarryExpression, legacy: true };
  }
  return {
    expression: `_afToolArguments(${JSON.stringify(step.toolArguments)}, ${scopeExpression})`,
    legacy: false,
  };
}

/**
 * #G4 — an invoked child agent's payload, resolved the same way tool arguments
 * are. Inlining `invokeInput` verbatim shipped literal `{from:"input.upload_id"}`
 * descriptors to the callee, and because the payload is spread AFTER the inbound
 * event data, each descriptor OVERWROTE the correct value it was supposed to
 * select — so the child saw a poisoned object where a real id belonged, and any
 * `required` check passed because the object is not undefined.
 */
export function renderedInvokeInput(
  invokeInput: Record<string, unknown> | undefined,
  scopeExpression: string,
): string {
  if (!invokeInput || Object.keys(invokeInput).length === 0) return "{}";
  return `_afInvokeInput(${JSON.stringify(invokeInput)}, ${scopeExpression})`;
}

/** Wrap an awaited raw tool call with resultMap when authored. The callback
 * creates its own lexical block, so repeated steps cannot collide on `_raw`. */
export function renderedToolCallback(step: PlanStep, awaitedCallExpression: string): string {
  if (!step.resultMap) return `async () => ${awaitedCallExpression}`;
  return `async () => { const _raw = ${awaitedCallExpression}; return _afMapToolResult(_raw, ${JSON.stringify(step.resultMap)}); }`;
}
