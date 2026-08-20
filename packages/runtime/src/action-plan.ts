// Phase 1a — pure, dependency-free decision logic extracted from the Inngest-coupled
// register.ts / step-engine.ts so the production-grade orchestration semantics
// (stable idempotency-keyed step ids, real condition branching, synchronous invoke)
// are unit-testable WITHOUT a live Inngest or a DB handle.
//
// Nothing here imports inngest / drizzle / better-sqlite3 — keep it that way.

/** Inngest step ids must be stable + contain only safe chars. Mirrors the OLD agents'
 *  `sanitize()` (resume-parser-agent.ts) so the same logical step memoizes across replays. */
export function sanitizeStepId(s: string): string {
  const cleaned = (s || "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  // An all-separator result ("---") is a valid-but-useless Inngest id; collapse to the fallback.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "step";
}

/** Walk a dotted path on a plain object/scope. Returns undefined on any miss. */
export function readPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface StepScope {
  event?: { name?: string; data?: Record<string, unknown> };
  subject?: unknown;
  lastResult?: unknown;
  /** Raw output of every completed step, keyed by the plan's stable step id. */
  results?: Record<string, unknown>;
  /** Per-iteration foreach bindings (`itemAs`, index, stable key). */
  locals?: Record<string, unknown>;
}

/** Resolve the business key an action dedupes on, from `idempotencyKeyFrom`. Tries the
 *  trigger event's data first (the common case — `entity_id`, `subject`), then the scope. */
export function resolveBusinessKey(key: string | undefined, scope: StepScope): string | undefined {
  if (!key) return undefined;
  if (key === "subject") {
    return scope.subject != null && String(scope.subject).trim() ? String(scope.subject) : undefined;
  }
  const fromData = readPath(scope.event?.data, key);
  if (fromData != null && String(fromData).trim()) return String(fromData);
  const fromScope = readPath(scope, key);
  if (fromScope != null && String(fromScope).trim()) return String(fromScope);
  return undefined;
}

/** Stable, unique-per-iteration Inngest step id. When an action declares
 *  `idempotencyKeyFrom`, the resolved business key is appended (so a loop over a
 *  collection produces distinct, replay-stable ids — the OLD `download-and-parse-${key}`
 *  pattern). Falls back to the action name alone when no key resolves (back-compat). */
export function stableStepId(actionName: string, idempotencyKeyFrom: string | undefined, scope: StepScope): string {
  const base = sanitizeStepId(actionName);
  const biz = resolveBusinessKey(idempotencyKeyFrom, scope);
  return biz ? `${base}-${sanitizeStepId(biz)}` : base;
}

// ── deterministic sequential foreach ─────────────────────────────────────────

export interface ForeachFrame<T = unknown> {
  index: number;
  item: T;
  /** Raw business key selected by itemKeyFrom. */
  businessKey: string;
  /** Sanitized + hashed key safe for durable step ids and object maps. */
  stableKey: string;
  locals: Record<string, unknown>;
}

export type ForeachMaterialization<T = unknown> =
  | { ok: true; frames: ForeachFrame<T>[] }
  | { ok: false; error: string; frames: [] };

/** Deterministic 96-bit suffix derived from FNV-1a-128. The previous 32-bit
 * suffix was too small for tenant-scale durable-id namespaces. */
export function stableDigest96(value: string): string {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  const prime = 0x0000000001000000000000000000013bn;
  const mask = (1n << 128n) - 1n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(32, "0").slice(-24);
}

/** Build replay-stable iteration frames. Missing/duplicate business keys fail closed: silently
 * falling back to an array index would route a retried side effect to a different durable step
 * after collection reordering. */
export function materializeForeach<T>(args: {
  items: readonly T[];
  itemAs?: string;
  itemKeyFrom: string;
}): ForeachMaterialization<T> {
  const itemAs = args.itemAs?.trim() || "item";
  const keyPath = args.itemKeyFrom.replace(new RegExp(`^(?:locals\\.)?${itemAs}\\.`), "");
  const seen = new Set<string>();
  const seenStableKeys = new Map<string, string>();
  const frames: ForeachFrame<T>[] = [];
  for (let index = 0; index < args.items.length; index++) {
    const item = args.items[index]!;
    const raw = keyPath === itemAs || keyPath === "" ? item : readPath(item, keyPath);
    if (raw == null || !String(raw).trim()) {
      return { ok: false, error: `foreach item #${index} has no stable key at "${args.itemKeyFrom}"`, frames: [] };
    }
    const businessKey = String(raw);
    if (seen.has(businessKey)) {
      return { ok: false, error: `foreach item key "${businessKey}" is duplicated`, frames: [] };
    }
    seen.add(businessKey);
    const stableKey = `${sanitizeStepId(businessKey).slice(0, 40)}-${stableDigest96(businessKey)}`;
    const collidedWith = seenStableKeys.get(stableKey);
    if (collidedWith !== undefined && collidedWith !== businessKey) {
      return {
        ok: false,
        error: `foreach stable key collision between "${collidedWith}" and "${businessKey}"`,
        frames: [],
      };
    }
    seenStableKeys.set(stableKey, businessKey);
    frames.push({
      index,
      item,
      businessKey,
      stableKey,
      locals: {
        [itemAs]: item,
        index,
        key: businessKey,
        stableKey,
      },
    });
  }
  return { ok: true, frames };
}

/** Stable child id used in receipts/traces for a foreach body step. */
export function foreachStepId(parentStepId: string, frame: Pick<ForeachFrame, "stableKey">, childStepId: string): string {
  const parent = sanitizeStepId(parentStepId).slice(0, 16);
  const stable = frame.stableKey.length > 20
    ? `${frame.stableKey.slice(0, 7)}-${frame.stableKey.slice(-12)}`
    : frame.stableKey;
  const child = sanitizeStepId(childStepId).slice(0, 16);
  const digest = stableDigest96(`${parentStepId}\0${frame.stableKey}\0${childStepId}`);
  return `${parent}-${stable}-${child}-${digest}`;
}

/** Tiny sequential state machine shared by the step engine and unit tests. Awaiting each worker
 * before starting the next guarantees deterministic side-effect order and bounded memory. */
export async function runSequentialForeach<T, R>(
  frames: readonly ForeachFrame<T>[],
  worker: (frame: ForeachFrame<T>) => Promise<R>,
): Promise<R[]> {
  const outputs: R[] = [];
  for (const frame of frames) outputs.push(await worker(frame));
  return outputs;
}

// ── condition evaluator ───────────────────────────────────────────────────────
// A small SAFE boolean expression evaluator (NO eval / new Function). Supports:
//   true / false literals
//   <path> == <lit> | != | >= | <= | > | <      (lit = 'str' | "str" | number | true | false | null)
//   presence:  <path>            (truthy)
//   negation:  !<path>
//   conjunction / disjunction:  &&  ||
// Anything it can't parse is an INVALID configuration. The detailed evaluator
// reports that state and manifest loading rejects it before registration.

export interface ConditionScope {
  lastResult?: unknown;
  results?: Record<string, unknown>;
  event?: { name?: string; data?: Record<string, unknown> };
  /** Alias used by generated plans/code for the entry event payload. */
  input?: Record<string, unknown>;
  /** Foreach-local bindings. A local is addressable as `locals.item.id` or `item.id`. */
  locals?: Record<string, unknown>;
}

export interface ConditionEvaluation {
  value: boolean;
  valid: boolean;
  error?: string;
}

function conditionLexicalError(source: string): string | null {
  if (!source) return "condition is empty";
  if (source.length > 1024) return "condition is longer than 1024 characters";
  if (/=>|;|`|\b(new|function|return|this|process|globalThis|require|import|eval|constructor|prototype|__proto__)\b/.test(source)) {
    return "condition contains executable/forbidden syntax";
  }
  return null;
}

/**
 * Static validation for the exact no-eval condition dialect implemented
 * below.  This intentionally calls the same parser/evaluator with an empty
 * scope: syntactically valid paths remain valid even when their value is
 * absent, while unsupported calls/operators/characters are rejected.  Keeping
 * one grammar prevents manifest validation and runtime evaluation drifting.
 */
export function validateConditionSyntax(expression: string): string | null {
  const source = (expression ?? "").trim();
  const lexical = conditionLexicalError(source);
  if (lexical) return lexical;
  const evaluated = evaluateConditionDetailed(source, {});
  return evaluated.valid
    ? null
    : (evaluated.error ?? "condition is not in the safe expression DSL");
}

function splitTop(e: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let buf = "";
  for (let i = 0; i < e.length; i++) {
    const c = e[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && e.startsWith(op, i)) { out.push(buf); buf = ""; i += op.length - 1; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parseLiteral(s: string): { parsed: boolean; value: unknown } {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return { parsed: true, value: t.slice(1, -1) };
  if (t === "null" || t === "undefined") return { parsed: true, value: null };
  if (t === "true") return { parsed: true, value: true };
  if (t === "false") return { parsed: true, value: false };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { parsed: true, value: Number(t) };
  return { parsed: false, value: undefined };
}

function compare(l: unknown, r: unknown, op: string): boolean {
  // `x != null` is a nullish presence check. Treat both null and undefined as missing;
  // the previous implementation accidentally made `undefined != null` true.
  if (r === null) {
    if (op === "==" || op === "===") return l == null;
    if (op === "!=" || op === "!==") return l != null;
  }
  switch (op) {
    case "===": return l === r;
    case "!==": return l !== r;
    case "==": return l === r || (l != null && r != null && String(l) === String(r));
    case "!=": return !(l === r || (l != null && r != null && String(l) === String(r)));
    case ">": return Number(l) > Number(r);
    case "<": return Number(l) < Number(r);
    case ">=": return Number(l) >= Number(r);
    case "<=": return Number(l) <= Number(r);
    default: return false;
  }
}

function stripOuterParens(src: string): string {
  let out = src.trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    let depth = 0;
    let quote = "";
    let wrapsAll = true;
    for (let i = 0; i < out.length; i++) {
      const c = out[i]!;
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0 && i < out.length - 1) { wrapsAll = false; break; }
      if (depth < 0) return out;
    }
    if (!wrapsAll || depth !== 0) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\?\./g, ".").replace(/\[['"]([^'"]+)['"]\]/g, ".$1").replace(/^\./, "");
}

const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z_$][A-Za-z0-9_$-]*)*$/;

function resultPath(results: Record<string, unknown> | undefined, path: string): { found: boolean; value: unknown } {
  if (!results) return { found: false, value: undefined };
  const keys = Object.keys(results).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (path !== key && !path.startsWith(`${key}.`)) continue;
    let tail = path === key ? "" : path.slice(key.length + 1);
    // Compatibility with existing generated plans: `parse-resume.result.name` means the
    // raw result of step `parse-resume`, then field `name`.
    if (tail === "result" || tail === "data" || tail === "value") tail = "";
    else tail = tail.replace(/^(result|data|value)\./, "");
    return { found: true, value: tail ? readPath(results[key], tail) : results[key] };
  }
  return { found: false, value: undefined };
}

/** Resolve a condition path without eval. New plans use `results.<stepId>.*`; legacy generated
 * plans using `<stepId>.result.*` or `steps['<stepId>'].result.*` remain readable. */
export function resolveConditionPath(scope: ConditionScope, rawPath: string): { valid: boolean; value: unknown; error?: string } {
  const path = normalizePath(rawPath);
  if (!PATH_RE.test(path)) return { valid: false, value: undefined, error: `unsupported path "${rawPath.trim()}"` };
  if (path === "input") return { valid: true, value: scope.input ?? scope.event?.data };
  if (path.startsWith("input.")) return { valid: true, value: readPath(scope.input ?? scope.event?.data, path.slice(6)) };
  if (path === "event" || path.startsWith("event.")) return { valid: true, value: readPath(scope, path) };
  if (path === "lastResult" || path.startsWith("lastResult.")) return { valid: true, value: readPath(scope, path) };
  if (path === "results" || path === "steps") return { valid: true, value: scope.results };
  if (path === "locals") return { valid: true, value: scope.locals };
  if (path.startsWith("locals.")) return { valid: true, value: readPath(scope.locals, path.slice(7)) };
  if (path.startsWith("results.") || path.startsWith("steps.")) {
    return { valid: true, value: resultPath(scope.results, path.replace(/^(results|steps)\./, "")).value };
  }
  const fromResult = resultPath(scope.results, path);
  if (fromResult.found) return { valid: true, value: fromResult.value };
  const fromLocal = readPath(scope.locals, path);
  if (fromLocal !== undefined) return { valid: true, value: fromLocal };
  const fromLast = readPath(scope.lastResult, path);
  if (fromLast !== undefined) return { valid: true, value: fromLast };
  return { valid: true, value: readPath(scope.input ?? scope.event?.data, path) };
}

// ── exact generated-plan tool dataflow ───────────────────────────────────────

export type ToolArgumentSource =
  | { from: string; required?: boolean }
  | { const: unknown };

export interface ToolResultMap {
  fields: Record<string, string>;
  include_raw?: boolean;
}

export type ToolArgumentsMaterialization =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; argument?: string; path?: string };

export type ToolResultMapping =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; field?: string; path?: string };

const SAFE_DATAFLOW_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const DATAFLOW_ROOT_RE = /^(event(?:\.|$)|input(?:\.|$)|lastResult(?:\.|$)|results(?:\.|$)|locals(?:\.|$))/;
const RESULT_ROOT_RE = /^result(?:\.|$)/;
const UNSAFE_DATAFLOW_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function cloneJsonConstant(value: unknown, seen = new Set<object>()): { ok: true; value: unknown } | { ok: false } {
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (!value || typeof value !== "object" || seen.has(value)) return { ok: false };
  seen.add(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      const cloned = cloneJsonConstant(entry, seen);
      if (!cloned.ok) return cloned;
      out.push(cloned.value);
    }
    return { ok: true, value: out };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return { ok: false };
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_DATAFLOW_KEYS.has(key)) return { ok: false };
    const cloned = cloneJsonConstant(entry, seen);
    if (!cloned.ok) return cloned;
    out[key] = cloned.value;
  }
  return { ok: true, value: out };
}

/** Resolve an explicitly-authored tool argument template. Required paths fail
 * closed; optional missing paths are omitted. No key-name inference and no
 * implicit carry merge occurs. */
export function materializeToolArguments(
  template: Record<string, ToolArgumentSource>,
  scope: ConditionScope,
): ToolArgumentsMaterialization {
  if (!template || typeof template !== "object" || Array.isArray(template) || !Object.keys(template).length) {
    return { ok: false, error: "tool_arguments must be a non-empty object" };
  }
  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [argument, source] of Object.entries(template)) {
    if (!SAFE_DATAFLOW_NAME_RE.test(argument) || UNSAFE_DATAFLOW_KEYS.has(argument)) {
      return { ok: false, error: `unsafe tool argument name "${argument}"`, argument };
    }
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return { ok: false, error: `tool argument "${argument}" is not an explicit source`, argument };
    }
    const record = source as unknown as Record<string, unknown>;
    const hasFrom = Object.prototype.hasOwnProperty.call(record, "from");
    const hasConst = Object.prototype.hasOwnProperty.call(record, "const");
    if (hasFrom === hasConst) {
      return { ok: false, error: `tool argument "${argument}" must choose exactly one of from/const`, argument };
    }
    if (hasFrom) {
      const path = typeof record.from === "string" ? record.from : "";
      if (!DATAFLOW_ROOT_RE.test(path)) {
        return { ok: false, error: `tool argument "${argument}" has an unsafe/unrooted path`, argument, path };
      }
      const resolved = resolveConditionPath(scope, path);
      if (!resolved.valid) {
        return { ok: false, error: resolved.error ?? `tool argument path "${path}" is invalid`, argument, path };
      }
      if (resolved.value === undefined) {
        if (record.required === false) continue;
        return { ok: false, error: `required tool argument path "${path}" did not resolve`, argument, path };
      }
      const cloned = cloneJsonConstant(resolved.value);
      if (!cloned.ok) {
        return { ok: false, error: `tool argument path "${path}" did not resolve to finite JSON`, argument, path };
      }
      args[argument] = cloned.value;
      continue;
    }
    const cloned = cloneJsonConstant(record.const);
    if (!cloned.ok) {
      return { ok: false, error: `tool argument "${argument}" constant is not finite JSON`, argument };
    }
    args[argument] = cloned.value;
  }
  return { ok: true, args };
}

/** Project a raw tool return into reviewed named fields. Every source path is
 * explicit and rooted at `result`; one missing path rejects the whole mapping. */
export function applyToolResultMap(raw: unknown, map: ToolResultMap): ToolResultMapping {
  if (!map || typeof map !== "object" || !map.fields || typeof map.fields !== "object" || Array.isArray(map.fields)) {
    return { ok: false, error: "result_map.fields must be an object" };
  }
  const entries = Object.entries(map.fields);
  if (!entries.length) return { ok: false, error: "result_map.fields cannot be empty" };
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [field, rawPath] of entries) {
    if (!SAFE_DATAFLOW_NAME_RE.test(field) || UNSAFE_DATAFLOW_KEYS.has(field) || field === "_raw") {
      return { ok: false, error: `unsafe result_map field "${field}"`, field };
    }
    const path = typeof rawPath === "string" ? normalizePath(rawPath) : "";
    if (!RESULT_ROOT_RE.test(path) || !PATH_RE.test(path)) {
      return { ok: false, error: `result_map field "${field}" has an unsafe/unrooted path`, field, path: rawPath };
    }
    const value = path === "result" ? raw : readPath(raw, path.slice("result.".length));
    if (value === undefined) {
      return { ok: false, error: `result_map path "${rawPath}" did not resolve`, field, path: rawPath };
    }
    out[field] = value;
  }
  if (map.include_raw === true) out._raw = raw;
  return { ok: true, value: out };
}

function evalAtom(atom: string, scope: ConditionScope): ConditionEvaluation {
  const a = stripOuterParens(atom);
  if (!a) return { value: false, valid: false, error: "empty condition atom" };
  if (/^true$/i.test(a)) return { value: true, valid: true };
  if (/^false$/i.test(a)) return { value: false, valid: true };

  const arrayMatch = a.match(/^Array\.isArray\((.+)\)$/);
  if (arrayMatch) {
    const r = resolveConditionPath(scope, arrayMatch[1]!);
    return r.valid ? { value: Array.isArray(r.value), valid: true } : { value: false, valid: false, error: r.error };
  }
  const includesMatch = a.match(/^(.+?)\.includes\((.+)\)$/);
  if (includesMatch) {
    const left = resolveConditionPath(scope, includesMatch[1]!);
    const lit = parseLiteral(includesMatch[2]!);
    if (!left.valid || !lit.parsed) return { value: false, valid: false, error: left.error ?? "includes() requires a literal argument" };
    const value = typeof left.value === "string"
      ? left.value.includes(String(lit.value))
      : Array.isArray(left.value) ? left.value.includes(lit.value) : false;
    return { value, valid: true };
  }

  const m = a.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const left = resolveConditionPath(scope, m[1]!);
    if (!left.valid) return { value: false, valid: false, error: left.error };
    const lit = parseLiteral(m[3]!);
    const right = lit.parsed ? { valid: true, value: lit.value } : resolveConditionPath(scope, m[3]!);
    if (!right.valid) return { value: false, valid: false, error: right.error };
    return { value: compare(left.value, right.value, m[2]!), valid: true };
  }

  const negated = a.startsWith("!!") ? 2 : a.startsWith("!") ? 1 : 0;
  const resolved = resolveConditionPath(scope, negated ? a.slice(negated) : a);
  if (!resolved.valid) return { value: false, valid: false, error: resolved.error };
  const truthy = Boolean(resolved.value);
  return { value: negated === 1 ? !truthy : truthy, valid: true };
}

export function evaluateConditionDetailed(expr: string, scope: ConditionScope): ConditionEvaluation {
  const e = (expr || "").trim();
  const lexical = conditionLexicalError(e);
  if (lexical) return { value: false, valid: false, error: lexical };
  try {
    const normalized = stripOuterParens(e);
    const ors = splitTop(normalized, "||");
    if (ors.length > 1) {
      const parts = ors.map((p) => evaluateConditionDetailed(p, scope));
      const bad = parts.find((p) => !p.valid);
      return bad ?? { value: parts.some((p) => p.value), valid: true };
    }
    const ands = splitTop(normalized, "&&");
    if (ands.length > 1) {
      const parts = ands.map((p) => evaluateConditionDetailed(p, scope));
      const bad = parts.find((p) => !p.valid);
      return bad ?? { value: parts.every((p) => p.value), valid: true };
    }
    return evalAtom(normalized, scope);
  } catch {
    return { value: false, valid: false, error: "condition evaluation failed" };
  }
}

export function evaluateCondition(expr: string, scope: ConditionScope): boolean {
  const result = evaluateConditionDetailed(expr, scope);
  return result.valid ? result.value : false;
}

/**
 * An authored `condition` on an ordinary action is a precondition for that
 * action, not a standalone branch verdict.  Keeping this distinction in one
 * helper prevents the durable register loop and the recursive step engine
 * from drifting: `type:"condition"` retains its existing result/route
 * semantics, while every other action either runs, is skipped, or fails
 * closed before it can perform work.
 */
export type ActionPreconditionEvaluation =
  | { outcome: "not_applicable" }
  | { outcome: "run"; condition: string }
  | { outcome: "skip"; condition: string; reason: string }
  | { outcome: "invalid"; condition: string; error: string };

/** Legacy ontology/manifests also use `condition` for human-readable
 * provenance such as "审计已落库". Only the exact safe DSL is executable;
 * prose remains round-tripped evidence and is deliberately not guessed into
 * a boolean predicate. New generated plans validate this same DSL before
 * projection, so their guards continue to fail closed at execution time. */
export function executableActionCondition(
  condition: string | undefined,
): string | undefined {
  if (condition === undefined) return undefined;
  const source = condition.trim();
  return source && validateConditionSyntax(source) === null
    ? source
    : undefined;
}

export function evaluateActionPrecondition(
  action: { type: string; name: string; condition?: string },
  scope: ConditionScope,
): ActionPreconditionEvaluation {
  if (action.type === "condition" || action.condition === undefined) {
    return { outcome: "not_applicable" };
  }
  const condition = executableActionCondition(action.condition);
  if (!condition) return { outcome: "not_applicable" };
  const evaluated = evaluateConditionDetailed(condition, scope);
  if (!evaluated.valid) {
    return {
      outcome: "invalid",
      condition,
      error: evaluated.error ?? "condition evaluation failed",
    };
  }
  if (!evaluated.value) {
    return {
      outcome: "skip",
      condition,
      reason: `action condition "${condition}" evaluated false`,
    };
  }
  return { outcome: "run", condition };
}

/** Whether this lexical action scope delegates event routing to one or more
 * explicitly guarded emit actions. Nested foreach scopes are checked by their
 * own executor so a match in one item/scope cannot hide a no-match in another. */
export function hasAuthoritativeConditionalEmit(
  actions: ReadonlyArray<{ type: string; condition?: string }>,
): boolean {
  return actions.some(
    (action) =>
      action.type === "emit" &&
      executableActionCondition(action.condition) !== undefined,
  );
}

// ── dependsOn gating (real branching) ──────────────────────────────────────────

export interface GateState {
  /** condition step name → its evaluated boolean */
  conditionTrue: Record<string, boolean>;
  /** step names that were skipped (so transitive dependents also skip) */
  skipped: Set<string>;
}

/** An action is skipped when any step it dependsOn was itself skipped, or is a condition
 *  step that evaluated false. This is what turns the (previously inert) condition result
 *  into a real branch/skip in the register.ts action loop. */
export function shouldSkip(action: { name: string; dependsOn?: string[] }, gate: GateState): { skip: boolean; reason?: string } {
  for (const dep of action.dependsOn ?? []) {
    if (gate.skipped.has(dep)) return { skip: true, reason: `dependency "${dep}" was skipped` };
    if (dep in gate.conditionTrue && gate.conditionTrue[dep] === false) return { skip: true, reason: `condition "${dep}" is false` };
  }
  return { skip: false };
}

// ── synchronous soft-invoke ─────────────────────────────────────────────────────

/** Stable typed failure exposed to declarative error-policy predicates. */
export class ActionTimeoutError extends Error {
  readonly kind = "timeout";
  readonly code = "ACTION_TIMEOUT";
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded timeout (${Math.max(0, Math.trunc(timeoutMs))}ms)`);
    this.name = "ActionTimeoutError";
    this.timeoutMs = Math.max(0, Math.trunc(timeoutMs));
  }
}

/** Resolve an action-local timeout against an optional enclosing deadline. */
export function effectiveActionTimeoutMs(args: {
  timeoutS?: number;
  deadlineAt?: number;
  now?: number;
}): number | undefined {
  const local = typeof args.timeoutS === "number" && Number.isFinite(args.timeoutS) && args.timeoutS > 0
    ? Math.trunc(args.timeoutS * 1000)
    : undefined;
  const remaining = typeof args.deadlineAt === "number" && Number.isFinite(args.deadlineAt)
    ? Math.max(0, Math.trunc(args.deadlineAt - (args.now ?? Date.now())))
    : undefined;
  if (local === undefined) return remaining;
  if (remaining === undefined) return local;
  return Math.min(local, remaining);
}

/** Bound an action and propagate cooperative cancellation to providers/tools. */
export async function runWithActionTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  opts: { timeoutMs?: number; parentSignal?: AbortSignal; label: string },
): Promise<T> {
  const timeoutMs = opts.timeoutMs;
  const parent = opts.parentSignal;
  if (timeoutMs === undefined && !parent) return operation(undefined);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortWith = (reason: unknown): void => {
    const failure = reason instanceof ActionTimeoutError
      ? reason
      : new ActionTimeoutError(opts.label, timeoutMs ?? 0);
    if (!controller.signal.aborted) controller.abort(failure);
    rejectAbort?.(failure);
  };
  const onParentAbort = (): void => abortWith(parent?.reason);
  if (parent?.aborted) abortWith(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  if (timeoutMs !== undefined) {
    if (timeoutMs <= 0) abortWith(new ActionTimeoutError(opts.label, timeoutMs));
    else {
      timer = setTimeout(
        () => abortWith(new ActionTimeoutError(opts.label, timeoutMs)),
        timeoutMs,
      );
      timer.unref?.();
    }
  }

  try {
    // An inherited deadline may already be exhausted before this action is
    // reached. Never start a provider/tool/worker after that point.
    if (controller.signal.aborted) {
      void aborted.catch(() => undefined);
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new ActionTimeoutError(opts.label, timeoutMs ?? 0);
    }
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

export interface SoftInvokeResult<T> {
  ok: boolean;
  data: T | undefined;
  timedOut: boolean;
  softFailed: boolean;
}

/** Run a synchronous sub-call (e.g. a step.invoke of a dedup/identity sub-agent).
 * Failure is terminal by default. Soft continuation exists only as an explicit
 * manifest policy and bootstrap separately requires an explicit fallback. */
export async function softInvoke<T>(
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number; onError?: "soft" | "terminal"; fallback?: T },
): Promise<SoftInvokeResult<T>> {
  const { timeoutMs, onError = "terminal", fallback } = opts ?? {};
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: T;
    if (timeoutMs && timeoutMs > 0) {
      const timeoutP = new Promise<never>((_, rej) => {
        timer = setTimeout(() => { timedOut = true; rej(new Error("invoke timeout")); }, timeoutMs);
      });
      result = await Promise.race([fn(), timeoutP]);
    } else {
      result = await fn();
    }
    return { ok: true, data: result, timedOut: false, softFailed: false };
  } catch (e) {
    if (onError === "terminal") throw e;
    return { ok: false, data: fallback, timedOut, softFailed: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
