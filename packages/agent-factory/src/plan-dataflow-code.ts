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
      if (hasFrom === hasConst || Object.keys(record).some((key) => !["from", "required", "const"].includes(key))) {
        throw new Error(`cannot render tool step "${id}": argument ${argument} must choose exactly one of from/const`);
      }
      if (hasFrom) {
        const from = typeof record.from === "string" ? record.from : "";
        if (!SAFE_PATH_RE.test(from) || !/^(event(?:\.|$)|input(?:\.|$)|lastResult(?:\.|$)|results(?:\.|$)|locals(?:\.|$))/.test(from)) {
          throw new Error(`cannot render tool step "${id}": argument ${argument} has an unsafe/unrooted path`);
        }
        if (record.required !== undefined && typeof record.required !== "boolean") throw new Error(`cannot render tool step "${id}": argument ${argument}.required must be boolean`);
      } else if (!safeJson(record.const)) {
        throw new Error(`cannot render tool step "${id}": argument ${argument} constant is not finite JSON`);
      }
    }
  }
  if (step.resultMap) {
    if (!Object.keys(step.resultMap.fields ?? {}).length) throw new Error(`cannot render tool step "${id}": resultMap.fields is empty`);
    for (const [field, path] of Object.entries(step.resultMap.fields)) {
      if (!SAFE_NAME_RE.test(field) || UNSAFE_KEYS.has(field) || field === "_raw") throw new Error(`cannot render tool step "${id}": unsafe resultMap field "${field}"`);
      if (!SAFE_PATH_RE.test(path) || !/^result(?:\.|$)/.test(path)) throw new Error(`cannot render tool step "${id}": resultMap.${field} has an unsafe/unrooted path`);
    }
  }
}

/** Self-contained runtime used by both generated TypeScript renderers. It
 * deliberately consumes only authored templates; it never derives arguments
 * from a tool name or merges the carry when toolArguments is present. */
export const PLAN_DATAFLOW_RUNTIME_SRC = `
type _AfToolArgument = { from: string; required?: boolean } | { const: unknown };
type _AfResultMap = { fields: Record<string, string>; includeRaw?: boolean };
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
    const hasConst = Object.prototype.hasOwnProperty.call(source, "const");
    if (hasFrom === hasConst) throw new Error("[terminal] tool argument " + argument + " must choose exactly one of from/const");
    if (hasFrom) {
      const path = String((source as { from: string }).from ?? "");
      const value = readConditionPath(scope, path);
      if (value === undefined) {
        if ((source as { required?: boolean }).required === false) continue;
        throw new Error("[terminal] required tool argument path did not resolve: " + argument + " <- " + path);
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
    const hasConst = Object.prototype.hasOwnProperty.call(source, "const");
    if (!hasFrom && !hasConst) { out[argument] = source; continue; }
    if (hasFrom && hasConst) throw new Error("[terminal] invoke input " + argument + " must choose exactly one of from/const");
    if (hasConst) { out[argument] = _afCloneJson((source as { const: unknown }).const); continue; }
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
  for (const [field, path] of Object.entries(map.fields)) {
    const value = path === "result" ? raw : readPath(raw, path.slice("result.".length));
    if (value === undefined) throw new Error("[terminal] tool result path did not resolve: " + field + " <- " + path);
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
