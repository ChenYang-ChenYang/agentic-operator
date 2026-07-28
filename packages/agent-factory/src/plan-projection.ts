// Project a GeneratedAgentSpec's structured `plan[]` into the runtime manifest's
// ordered `actions[]`. Each plan step becomes its OWN manifest action (= one durable step.run in
// register.ts), so a generated agent gets the per-step durability + branching + soft-fail that a
// hand-written production agent has. Pure (imports only spec-types) so it's unit-testable without
// the deployer's heavy deps; mapToManifest (apps/api) calls it.

import type {
  DependencyReason,
  ErrorPolicyAction,
  ErrorPolicyRule,
  GeneratedAgentSpec,
  GeneratedInputBinding,
  PlanStep,
  PlanStepKind,
  PlanToolArgument,
  PlanResultMap,
} from "./spec-types";
import { assertGeneratedSpecExecutionOwner } from "./execution-ownership";

const PLAN_KINDS: PlanStepKind[] = ["tool", "logic", "condition", "invoke", "foreach", "emit"];
const VALUE_PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isSafePlanJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isSafePlanJson(entry, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>)
    .every(([key, entry]) => !UNSAFE_OBJECT_KEYS.has(key) && isSafePlanJson(entry, seen));
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Canonicalize historical plan references (`parse-resume.result.name` and
 * `steps['parse-resume'].result.name`) to `results.parse-resume.result.name`.
 * The runtime still reads the legacy forms, but persisted specs now have one dialect. */
export function normalizeConditionReferences(expr: string, priorStepIds: string[]): string {
  let out = expr.trim().replace(/steps\[['"]([^'"]+)['"]\]/g, "results.$1");
  for (const id of [...priorStepIds].sort((a, b) => b.length - a.length)) {
    const escaped = reEscape(id);
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_$.-])(${escaped})(?=\\.result\\b)`, "g"), `$1results.$2`);
  }
  return out;
}

/** Conservative syntax lint for the safe runtime condition DSL. This rejects natural-language
 * placeholders and arbitrary JS callbacks at design time instead of silently evaluating false. */
export function validateConditionSyntax(expr: string): string | null {
  const src = expr.trim();
  if (!src) return "condition is empty";
  if (src.length > 1024) return "condition is longer than 1024 characters";
  if (/=>|;|`|\b(new|function|return|process|globalThis|require|import|eval)\b/.test(src)) return "condition contains executable/forbidden syntax";
  if (/\.(some|every|map|filter|reduce|test)\s*\(/.test(src)) return "condition uses an unsupported callback/regex method";
  if (/[^A-Za-z0-9_$.[\]()?'"\\\s=!<>&|,.-]/.test(src)) return "condition contains unsupported characters";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return "condition has unbalanced parentheses";
  }
  if (depth !== 0 || quote) return quote ? "condition has an unterminated string" : "condition has unbalanced parentheses";

  const path = String.raw`[A-Za-z_$][A-Za-z0-9_$-]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*`;
  const literal = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null|undefined)`;
  const stripOuter = (value: string): string => {
    let out = value.trim();
    while (out.startsWith("(") && out.endsWith(")")) {
      let d = 0; let q = ""; let wraps = true;
      for (let i = 0; i < out.length; i++) {
        const c = out[i]!;
        if (q) { if (c === "\\") i++; else if (c === q) q = ""; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === "(") d++;
        else if (c === ")") d--;
        if (d === 0 && i < out.length - 1) { wraps = false; break; }
      }
      if (!wraps) break;
      out = out.slice(1, -1).trim();
    }
    return out;
  };
  const splitTopLevel = (value: string, op: "&&" | "||"): string[] => {
    const parts: string[] = []; let buf = ""; let d = 0; let q = "";
    for (let i = 0; i < value.length; i++) {
      const c = value[i]!;
      if (q) { buf += c; if (c === "\\" && i + 1 < value.length) buf += value[++i]!; else if (c === q) q = ""; continue; }
      if (c === "'" || c === '"') { q = c; buf += c; continue; }
      if (c === "(") d++;
      else if (c === ")") d--;
      if (d === 0 && value.startsWith(op, i)) { parts.push(buf); buf = ""; i++; continue; }
      buf += c;
    }
    parts.push(buf);
    return parts;
  };
  const atomOk = (value: string): boolean => {
    const atom = stripOuter(value);
    if (/^(true|false)$/i.test(atom)) return true;
    if (new RegExp(`^Array\\.isArray\\(\\s*${path}\\s*\\)$`).test(atom)) return true;
    if (new RegExp(`^${path}\\.includes\\(\\s*${literal}\\s*\\)$`, "i").test(atom)) return true;
    if (new RegExp(`^${path}\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*(?:${literal}|${path})$`, "i").test(atom)) return true;
    return new RegExp(`^!{0,2}${path}$`).test(atom);
  };
  const expressionOk = (value: string): boolean => {
    const normalized = stripOuter(value);
    const ors = splitTopLevel(normalized, "||");
    if (ors.length > 1) return ors.every(expressionOk);
    const ands = splitTopLevel(normalized, "&&");
    return ands.length > 1 ? ands.every(expressionOk) : atomOk(normalized);
  };
  return expressionOk(src) ? null : "condition is natural language or not in the safe expression DSL";
}

const ERROR_POLICY_ACTIONS = new Set<ErrorPolicyAction>(["park", "retry", "terminal", "continue"]);

function normalizeBareErrorLiterals(expr: string): string {
  const scalar = (value: string): string => /^(?:true|false|null|undefined)$/i.test(value)
    ? value
    : JSON.stringify(value);
  return expr
    .replace(/\.includes\(\s*([A-Za-z_$][A-Za-z0-9_$.-]*)\s*\)/g, (_m, value: string) => `.includes(${scalar(value)})`)
    .replace(/(===|!==|==|!=|>=|<=|>|<)\s*([A-Za-z_$][A-Za-z0-9_$.-]*)(?=\s*(?:&&|\|\||\)|$))/g, (_m, op: string, value: string) => `${op}${scalar(value)}`);
}

/** Factory-side lint matching the runtime's intentionally small error predicate DSL. */
export function validateErrorPredicateSyntax(expr: string): string | null {
  const normalized = normalizeBareErrorLiterals(expr.trim());
  const syntax = validateConditionSyntax(normalized);
  if (syntax) return syntax.replace(/^condition/, "error predicate");
  const withoutStrings = normalized.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "");
  const identifiers = withoutStrings.match(/[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z_$][A-Za-z0-9_$-]*)*/g) ?? [];
  for (const token of identifiers) {
    if (/^(?:true|false|null|undefined|includes)$/i.test(token)) continue;
    const root = token.replace(/^error\./, "").split(".")[0];
    if (!root || !["kind", "code", "status", "name", "message", "data", "meta"].includes(root)) {
      return `error predicate path "${token}" is not allowed`;
    }
  }
  return null;
}

function parseErrorPolicy(raw: unknown): ErrorPolicyRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules: ErrorPolicyRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const outcome = String(row.do ?? row.default ?? "").trim() as ErrorPolicyAction;
    if (!ERROR_POLICY_ACTIONS.has(outcome)) continue;
    const hasRuleDefault = Object.prototype.hasOwnProperty.call(row, "defaultResult") || Object.prototype.hasOwnProperty.call(row, "default_result");
    const shared = {
      ...(hasRuleDefault
        ? { defaultResult: Object.prototype.hasOwnProperty.call(row, "defaultResult") ? row.defaultResult : row.default_result }
        : {}),
      ...((row.emitEvent ?? row.emit_event) != null ? { emitEvent: String(row.emitEvent ?? row.emit_event) } : {}),
      ...(row.emitPayload && typeof row.emitPayload === "object" && !Array.isArray(row.emitPayload)
        ? { emitPayload: row.emitPayload as Record<string, unknown> }
        : row.emit_payload && typeof row.emit_payload === "object" && !Array.isArray(row.emit_payload)
          ? { emitPayload: row.emit_payload as Record<string, unknown> }
          : {}),
      ...(typeof (row.suppressEmit ?? row.suppress_emit) === "boolean"
        ? { suppressEmit: Boolean(row.suppressEmit ?? row.suppress_emit) }
        : {}),
      // #G14 —— 终态前的补偿写。半残的描述符不收：宁可 undefined 让校验报出来，
      // 也不要半填充地存进去，那会让「已声明」和「会执行」悄悄脱节。
      ...(() => {
        const raw = row.compensate;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const c = raw as Record<string, unknown>;
        if (typeof c.tool !== "string" || !c.tool.trim()) return {};
        const args = c.toolArguments ?? c.tool_arguments;
        return {
          compensate: {
            tool: c.tool.trim(),
            ...(args && typeof args === "object" && !Array.isArray(args)
              ? { toolArguments: args as Record<string, PlanToolArgument> }
              : {}),
            bestEffort: true,
          },
        };
      })(),
      // #G17 —— 依赖归因。只有具体规则能带；default 上的会被 validatePlan 判错。
      ...(() => {
        const raw = row.dependencySignal ?? row.dependency_signal;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const d = raw as Record<string, unknown>;
        if (typeof d.provider !== "string" || typeof d.op !== "string" || typeof d.reason !== "string") return {};
        return {
          dependencySignal: {
            provider: d.provider,
            op: d.op,
            reason: d.reason as DependencyReason,
            ...(typeof (d.viaTool ?? d.via_tool) === "string" ? { viaTool: String(d.viaTool ?? d.via_tool) } : {}),
          },
        };
      })(),
    };
    if (typeof row.when === "string" && row.when.trim()) {
      rules.push({ when: row.when.trim(), do: outcome, ...shared });
    } else if (row.default != null) {
      rules.push({ default: outcome, ...shared });
    }
  }
  return rules.length ? rules : undefined;
}

/** Normalize raw LLM-authored plan rows (snake_case OR camelCase) into PlanStep[]. Drops rows
 *  missing a stepId or a valid kind. */
export function parsePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const stepId = String(o.stepId ?? o.step_id ?? "").trim();
    const kind = String(o.kind ?? "").trim() as PlanStepKind;
    if (!stepId || !PLAN_KINDS.includes(kind)) continue;
    const dependsRaw = o.dependsOn ?? o.depends_on;
    const rawOnError = o.onError ?? o.on_error;
    const onErrRaw = typeof rawOnError === "string" ? rawOnError.trim() : "";
    const errorPolicy = parseErrorPolicy(
      o.errorPolicy ?? o.error_policy ?? (Array.isArray(rawOnError) ? rawOnError : undefined),
    );
    const hasDefaultResult =
      Object.prototype.hasOwnProperty.call(o, "defaultResult") ||
      Object.prototype.hasOwnProperty.call(o, "default_result");
    const priorStepIds = out.map((s) => s.stepId);
    const rawCondition = o.condition != null ? String(o.condition) : undefined;
    const rawBody = o.body ?? o.foreach_actions;
    const rawToolArguments = o.toolArguments ?? o.tool_arguments;
    const rawResultMap = o.resultMap ?? o.result_map;
    const step: PlanStep = {
      stepId,
      kind,
      tool: o.tool != null ? String(o.tool) : undefined,
      // #G13 —— manifest 侧写作 from_first；读回来统一成 camelCase，否则设计端能写、
      // 投影能存，运行时却看不见——比没有这个字段更糟。
      toolArguments:
        rawToolArguments && typeof rawToolArguments === "object" && !Array.isArray(rawToolArguments)
          ? (Object.fromEntries(
              Object.entries(rawToolArguments as Record<string, unknown>).map(([name, raw]) => {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [name, raw];
                const v = raw as Record<string, unknown>;
                if (!("from_first" in v)) return [name, v];
                const { from_first: fromFirst, ...rest } = v;
                return [name, { ...rest, fromFirst }];
              }),
            ) as Record<string, PlanToolArgument>)
          : undefined,
      resultMap: (() => {
        if (!rawResultMap || typeof rawResultMap !== "object" || Array.isArray(rawResultMap)) return undefined;
        const value = rawResultMap as Record<string, unknown>;
        const fields = value.fields;
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) return undefined;
        return {
          // #G12 —— 同理：对象形态字段的 snake_case 键读回 camelCase。
          fields: Object.fromEntries(
            Object.entries(fields as Record<string, unknown>).map(([field, raw]) => {
              if (typeof raw === "string" || !raw || typeof raw !== "object" || Array.isArray(raw)) return [field, raw];
              const v = raw as Record<string, unknown>;
              const { fallback_from: fallbackFrom, fallback_const: fallbackConst, ...rest } = v;
              return [field, {
                ...rest,
                ...(fallbackFrom !== undefined ? { fallbackFrom } : {}),
                ...(fallbackConst !== undefined ? { fallbackConst } : {}),
              }];
            }),
          ) as PlanResultMap["fields"],
          ...(typeof (value.includeRaw ?? value.include_raw) === "boolean"
            ? { includeRaw: Boolean(value.includeRaw ?? value.include_raw) }
            : {}),
        } satisfies PlanResultMap;
      })(),
      // #G15 —— 对成功结果求值的健康判定。
      healthSignals: (() => {
        const raw = o.healthSignals ?? o.health_signals;
        if (!Array.isArray(raw)) return undefined;
        const rules = raw.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const r = entry as Record<string, unknown>;
          if (typeof r.when !== "string" || !r.when.trim()) return [];
          if (typeof r.signal !== "string" || !r.signal.trim()) return [];
          return [{
            when: r.when.trim(),
            signal: r.signal.trim(),
            ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
            ...(typeof r.fatal === "boolean" ? { fatal: r.fatal } : {}),
          }];
        });
        return rules.length ? rules : undefined;
      })(),
      // #G23 —— 集合为空时的显式分支。
      onEmpty: (() => {
        const raw = o.onEmpty ?? o.on_empty;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const e = raw as Record<string, unknown>;
        const emitEvent = e.emitEvent ?? e.emit_event;
        if (typeof emitEvent === "string" && emitEvent.trim()) {
          const payload = e.emitPayload ?? e.emit_payload;
          return {
            emitEvent: emitEvent.trim(),
            ...(payload && typeof payload === "object" && !Array.isArray(payload)
              ? { emitPayload: payload as Record<string, unknown> }
              : {}),
          };
        }
        const suppress = e.suppressEmit ?? e.suppress_emit;
        if (suppress === true && typeof e.reason === "string" && e.reason.trim()) {
          return { suppressEmit: true as const, reason: e.reason.trim() };
        }
        return undefined;
      })(),
      condition: rawCondition ? normalizeConditionReferences(rawCondition, priorStepIds) : undefined,
      // #G2 — the two declared events this condition routes to.
      routes: (() => {
        const raw = (o.routes ?? o.route) as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const onTrue = raw.onTrue ?? raw.on_true;
        const onFalse = raw.onFalse ?? raw.on_false;
        if (typeof onTrue !== "string" || typeof onFalse !== "string") return undefined;
        return { onTrue, onFalse };
      })(),
      invoke: o.invoke != null ? String(o.invoke) : undefined,
      invokeInput: o.invokeInput && typeof o.invokeInput === "object" && !Array.isArray(o.invokeInput)
        ? (o.invokeInput as Record<string, unknown>)
        : o.invoke_input && typeof o.invoke_input === "object" && !Array.isArray(o.invoke_input)
          ? (o.invoke_input as Record<string, unknown>)
          : undefined,
      forwardLastResult: typeof (o.forwardLastResult ?? o.forward_last_result) === "boolean" ? Boolean(o.forwardLastResult ?? o.forward_last_result) : undefined,
      forwardResults: typeof (o.forwardResults ?? o.forward_results) === "boolean" ? Boolean(o.forwardResults ?? o.forward_results) : undefined,
      dependsOn: Array.isArray(dependsRaw) ? dependsRaw.map(String) : undefined,
      idempotencyKeyFrom: (o.idempotencyKeyFrom ?? o.idempotency_key_from) != null ? String(o.idempotencyKeyFrom ?? o.idempotency_key_from) : undefined,
      onError: onErrRaw === "soft" || onErrRaw === "terminal" || onErrRaw === "park" ? (onErrRaw as PlanStep["onError"]) : undefined,
      errorPolicy,
      defaultResult: hasDefaultResult
        ? (Object.prototype.hasOwnProperty.call(o, "defaultResult")
            ? o.defaultResult
            : o.default_result)
        : undefined,
      timeoutS: typeof (o.timeoutS ?? o.timeout_s) === "number" ? (o.timeoutS ?? o.timeout_s) as number : undefined,
      itemsFrom: (o.itemsFrom ?? o.items_from) != null ? String(o.itemsFrom ?? o.items_from) : undefined,
      itemAs: (o.itemAs ?? o.item_as) != null ? String(o.itemAs ?? o.item_as) : undefined,
      itemKeyFrom: (o.itemKeyFrom ?? o.item_key_from) != null ? String(o.itemKeyFrom ?? o.item_key_from) : undefined,
      body: kind === "foreach" ? parsePlan(rawBody) : undefined,
      emitEvent: (o.emitEvent ?? o.emit_event ?? o.event) != null ? String(o.emitEvent ?? o.emit_event ?? o.event) : undefined,
      emitPayloadFrom: (o.emitPayloadFrom ?? o.emit_payload_from ?? o.payload_from) != null ? String(o.emitPayloadFrom ?? o.emit_payload_from ?? o.payload_from) : undefined,
      emitPayload: (() => {
        const value = o.emitPayload ?? o.emit_payload ?? o.payload;
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      })(),
      description: o.description != null ? String(o.description) : undefined,
    };
    out.push(step);
  }
  return out;
}

/** Enforce production discipline on an authored plan. Side-effecting steps (tool /
 *  invoke) MUST declare a failure policy (onError) and a replay-stable idempotencyKeyFrom — the
 *  same guarantees a hand-written agent gets from step.run + sanitized business-key ids. Returns
 *  the concrete errors so design_agent can REJECT a sloppy plan (mirrors the empty-prompt reject). */
export function validatePlan(
  plan: PlanStep[],
  opts?: { knownTools?: string[]; declaredEvents?: string[] },
  context?: { insideForeach?: boolean },
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i]!;
    const at = `step "${s.stepId || `#${i + 1}`}"`;
    if (!s.stepId) errors.push(`${at}: missing stepId`);
    if (s.stepId && !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(s.stepId)) errors.push(`${at}: stepId must match [A-Za-z_$][A-Za-z0-9_$-]* so named results remain addressable`);
    if (seen.has(s.stepId)) errors.push(`${at}: duplicate stepId`);
    if (!PLAN_KINDS.includes(s.kind)) errors.push(`${at}: invalid kind "${s.kind}"`);
    if (s.timeoutS !== undefined && (!Number.isInteger(s.timeoutS) || s.timeoutS <= 0)) {
      errors.push(`${at}: timeoutS must be a positive integer number of seconds`);
    }

    const sideEffecting = s.kind === "tool" || s.kind === "invoke";
    if (s.kind === "tool" && !s.tool) errors.push(`${at}: tool step needs a "tool" name`);
    if (s.kind !== "tool" && s.toolArguments !== undefined) errors.push(`${at}: toolArguments is only valid for tool steps`);
    if (s.kind !== "tool" && s.resultMap !== undefined) errors.push(`${at}: resultMap is only valid for tool steps`);
    if (s.kind === "tool" && s.toolArguments === undefined) {
      warnings.push(`${at}: legacy whole-carry tool invocation (toolArguments is absent)`);
    }
    if (s.toolArguments !== undefined) {
      const entries = Object.entries(s.toolArguments);
      if (!entries.length) errors.push(`${at}: toolArguments must contain at least one explicit argument`);
      for (const [argument, template] of entries) {
        if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(argument) || ["__proto__", "prototype", "constructor"].includes(argument)) {
          errors.push(`${at}: toolArguments key "${argument}" is not a safe argument name`);
          continue;
        }
        if (!template || typeof template !== "object" || Array.isArray(template)) {
          errors.push(`${at}: toolArguments.${argument} must be {from,...} or {const:...}; bare values are forbidden`);
          continue;
        }
        const value = template as unknown as Record<string, unknown>;
        const hasFrom = Object.prototype.hasOwnProperty.call(value, "from");
        const hasFromFirst = Object.prototype.hasOwnProperty.call(value, "fromFirst");
        const hasConst = Object.prototype.hasOwnProperty.call(value, "const");
        if ([hasFrom, hasFromFirst, hasConst].filter(Boolean).length !== 1
          || Object.keys(value).some((key) => !["from", "fromFirst", "required", "const"].includes(key))) {
          errors.push(`${at}: toolArguments.${argument} must choose exactly one of {from}, {fromFirst} or {const}`);
          continue;
        }
        if (hasFrom || hasFromFirst) {
          // #G13 —— 每条候选路径都过同一套根/形状检查。
          const candidates = hasFrom
            ? [typeof value.from === "string" ? value.from : ""]
            : Array.isArray(value.fromFirst) ? value.fromFirst : [];
          if (hasFromFirst && candidates.length < 2) {
            errors.push(`${at}: toolArguments.${argument}.fromFirst needs at least two candidates — with one it is just {from}`);
          }
          for (const candidate of candidates) {
            const path = typeof candidate === "string" ? candidate : "";
            if (!VALUE_PATH_RE.test(path) || !/^(event(?:\.|$)|input(?:\.|$)|lastResult(?:\.|$)|results(?:\.|$)|locals(?:\.|$))/.test(path)) {
              errors.push(`${at}: toolArguments.${argument} must be a safe path rooted at event/input/lastResult/results/locals`);
            }
          }
          if (value.required !== undefined && typeof value.required !== "boolean") {
            errors.push(`${at}: toolArguments.${argument}.required must be boolean`);
          }
        } else if (!isSafePlanJson(value.const)) {
          errors.push(`${at}: toolArguments.${argument}.const must be safe finite JSON`);
        }
      }
    }
    if (s.resultMap !== undefined) {
      const fields = s.resultMap.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) {
        errors.push(`${at}: resultMap.fields must contain at least one named field`);
      } else {
        for (const [field, path] of Object.entries(fields)) {
          if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(field) || ["__proto__", "prototype", "constructor", "_raw"].includes(field)) {
            errors.push(`${at}: resultMap field "${field}" is not a safe named field`);
          }
          // #G12 —— 裸路径（必需）或对象形态（可选/默认值/回退）。
          if (typeof path === "string") {
            if (!VALUE_PATH_RE.test(path) || !/^result(?:\.|$)/.test(path)) {
              errors.push(`${at}: resultMap.${field} must be a safe path rooted at result`);
            }
          } else if (!path || typeof path !== "object" || Array.isArray(path)) {
            errors.push(`${at}: resultMap.${field} must be a path string or a {from,...} descriptor`);
          } else {
            const descriptor = path as unknown as Record<string, unknown>;
            const allowed = ["from", "required", "default", "fallbackFrom", "fallbackConst"];
            if (Object.keys(descriptor).some((key) => !allowed.includes(key))) {
              errors.push(`${at}: resultMap.${field} has an unknown key (allowed: ${allowed.join(", ")})`);
            }
            const paths = [descriptor.from, ...(Array.isArray(descriptor.fallbackFrom) ? descriptor.fallbackFrom : [])];
            for (const candidate of paths) {
              const p = typeof candidate === "string" ? candidate : "";
              if (!VALUE_PATH_RE.test(p) || !/^result(?:\.|$)/.test(p)) {
                errors.push(`${at}: resultMap.${field} must be a safe path rooted at result`);
              }
            }
            if (descriptor.required !== undefined && typeof descriptor.required !== "boolean") {
              errors.push(`${at}: resultMap.${field}.required must be boolean`);
            }
            for (const key of ["default", "fallbackConst"] as const) {
              if (descriptor[key] !== undefined && !isSafePlanJson(descriptor[key])) {
                errors.push(`${at}: resultMap.${field}.${key} must be safe finite JSON`);
              }
            }
          }
        }
      }
      if (s.resultMap.includeRaw !== undefined && typeof s.resultMap.includeRaw !== "boolean") {
        errors.push(`${at}: resultMap.includeRaw must be boolean`);
      }
    }
    if (s.kind === "invoke" && !s.invoke) errors.push(`${at}: invoke step needs an "invoke" target`);
    if (s.kind === "condition" && !s.condition) errors.push(`${at}: condition step needs a "condition" expression`);
    if (s.kind === "emit" && !s.emitEvent) errors.push(`${at}: emit step needs an "emitEvent"`);
    if (s.emitPayloadFrom && !VALUE_PATH_RE.test(s.emitPayloadFrom)) errors.push(`${at}: emitPayloadFrom is not a safe data path`);
    if (s.kind === "emit" && s.emitEvent && opts?.declaredEvents && !opts.declaredEvents.includes(s.emitEvent)) {
      errors.push(`${at}: emitEvent "${s.emitEvent}" is not in the agent's declared emit allow-list`);
    }
    if (s.kind === "foreach") {
      if (!s.itemsFrom) errors.push(`${at}: foreach step needs an "itemsFrom" path`);
      if (!s.itemKeyFrom) errors.push(`${at}: foreach step needs itemKeyFrom (a replay-stable item key)`);
      if (s.itemsFrom && !VALUE_PATH_RE.test(s.itemsFrom)) errors.push(`${at}: itemsFrom is not a safe data path`);
      if (s.itemKeyFrom && !VALUE_PATH_RE.test(s.itemKeyFrom)) errors.push(`${at}: itemKeyFrom is not a safe data path`);
      if (!s.body?.length) errors.push(`${at}: foreach step needs a non-empty body`);
      if (s.itemAs && !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(s.itemAs)) errors.push(`${at}: itemAs must be an addressable local name`);
      const nested = s.body ?? [];
      const nestedValidation = validatePlan(nested, opts, { insideForeach: true });
      for (const error of nestedValidation.errors) errors.push(`${at} body: ${error}`);
      for (const warning of nestedValidation.warnings) warnings.push(`${at} body: ${warning}`);
    }
    if (s.kind === "condition" && s.condition) {
      const syntaxError = validateConditionSyntax(s.condition);
      if (syntaxError) errors.push(`${at}: invalid condition — ${syntaxError}`);
      for (const match of s.condition.matchAll(/\bresults\.([A-Za-z_$][A-Za-z0-9_$-]*)/g)) {
        if (!seen.has(match[1]!)) errors.push(`${at}: condition references unknown/forward result "${match[1]}"`);
      }
    }
    // #G2 — a condition whose result nothing reads is dead logic. It is only
    // read by later steps that depend on it, or by the emit block through
    // `routes`; with neither, the designer's routing rule is evaluated and then
    // silently discarded, and an LLM ends up choosing the terminal event.
    if (s.kind === "condition" && s.routes) {
      for (const [side, event] of Object.entries(s.routes)) {
        if (!event) errors.push(`${at}: routes.${side} needs a declared event name`);
        else if (opts?.declaredEvents && !opts.declaredEvents.includes(event)) {
          errors.push(`${at}: routes.${side} "${event}" is not in the agent's declared emit allow-list`);
        }
      }
    }
    if (s.kind === "condition" && !s.routes) {
      const readLater = plan.some((other, j) => j > i && (other.dependsOn ?? []).includes(s.stepId));
      if (!readLater) {
        warnings.push(`${at}: condition result is never read — no later step depends on it and it declares no routes, so this routing rule has no effect`);
      }
    }
    if (s.kind === "tool" && s.tool && opts?.knownTools && !opts.knownTools.includes(s.tool)) {
      errors.push(`${at}: tool "${s.tool}" is not in the resolved tool set`);
    }
    if (sideEffecting && !s.idempotencyKeyFrom && !context?.insideForeach) errors.push(`${at}: side-effecting step needs idempotencyKeyFrom (a replay-stable business key)`);
    if (sideEffecting && !s.onError && !s.errorPolicy?.length) errors.push(`${at}: side-effecting step needs an onError/errorPolicy failure policy`);
    if (s.onError && s.errorPolicy?.length) errors.push(`${at}: choose legacy onError or errorPolicy, not both`);
    if (s.kind === "invoke" && s.onError === "soft" && s.defaultResult === undefined) {
      errors.push(`${at}: invoke onError=soft requires an explicit defaultResult`);
    }
    if (s.errorPolicy?.length) {
      const defaults = s.errorPolicy.flatMap((rule, index) => ("default" in rule ? [index] : []));
      if (defaults.length !== 1) errors.push(`${at}: errorPolicy requires exactly one default rule`);
      else if (defaults[0] !== s.errorPolicy.length - 1) errors.push(`${at}: errorPolicy default rule must be last`);
      for (let ruleIndex = 0; ruleIndex < s.errorPolicy.length; ruleIndex++) {
        const rule = s.errorPolicy[ruleIndex]!;
        const outcome = "do" in rule ? rule.do : rule.default;
        if ("when" in rule) {
          const predicateError = validateErrorPredicateSyntax(rule.when);
          if (predicateError) errors.push(`${at}: errorPolicy rule #${ruleIndex + 1}: ${predicateError}`);
        }
        if (outcome === "continue" && rule.defaultResult === undefined && s.defaultResult === undefined) {
          errors.push(`${at}: errorPolicy continue rule #${ruleIndex + 1} requires defaultResult`);
        }
        if (rule.emitEvent && opts?.declaredEvents && !opts.declaredEvents.includes(rule.emitEvent)) {
          errors.push(`${at}: errorPolicy emitEvent "${rule.emitEvent}" is not in the agent's declared emit allow-list`);
        }
        if (rule.emitEvent && rule.suppressEmit) {
          errors.push(`${at}: errorPolicy rule #${ruleIndex + 1} cannot both emitEvent and suppressEmit`);
        }
      }
    }

    for (const dep of s.dependsOn ?? []) {
      if (!seen.has(dep)) errors.push(`${at}: dependsOn "${dep}" is not a prior step (forward/unknown reference)`);
    }
    seen.add(s.stepId);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** The manifest action shape the runtime ActionSchema accepts (loose — validated downstream). */
export type ManifestAction = Record<string, unknown> & { order: string; name: string; type: string };

/** Runtime manifest representation.  Keeping the conversion deterministic and
 * explicit avoids relying on Zod passthrough for execution-bearing metadata. */
export function projectInputBinding(binding: GeneratedInputBinding): Record<string, unknown> {
  const common = {
    field: binding.field,
    type: binding.type,
    required: binding.required,
    kind: binding.kind,
  };
  switch (binding.kind) {
    case "event":
      return {
        ...common,
        event_path: binding.eventPath,
        ...(binding.sourceEvents?.length ? { source_events: binding.sourceEvents } : {}),
        ...(binding.sourceObject ? { source_object: binding.sourceObject } : {}),
      };
    case "object_lookup":
      return {
        ...common,
        source_object: binding.sourceObject,
        tool: binding.tool,
        arguments: binding.arguments,
        result_path: binding.resultPath,
        ...(binding.dependsOn?.length ? { depends_on: binding.dependsOn } : {}),
      };
    case "secret":
    case "config":
      return { ...common, reference: binding.reference };
    case "human_input":
      return { ...common, prompt: binding.prompt };
    case "step_output":
      return { ...common, source_step: binding.sourceStep, source_output: binding.sourceOutput };
  }
}

function orderedAcquisitionBindings(bindings: GeneratedInputBinding[]): GeneratedInputBinding[] {
  const pending = new Map(
    bindings
      .filter((binding) => binding.kind === "object_lookup" || binding.kind === "human_input")
      .map((binding, index) => [binding.field, { binding, index }]),
  );
  const ordered: GeneratedInputBinding[] = [];
  while (pending.size) {
    const ready = [...pending.values()]
      .filter(({ binding }) => binding.kind !== "object_lookup" || (binding.dependsOn ?? []).every((field) => !pending.has(field)))
      .sort((left, right) => left.index - right.index)[0];
    if (!ready) {
      throw new Error(`input binding acquisition dependency cycle: ${[...pending.keys()].join(" -> ")}`);
    }
    ordered.push(ready.binding);
    pending.delete(ready.binding.field);
  }
  return ordered;
}

function actionForStep(step: PlanStep, order: number): ManifestAction {
  const actionName = step.kind === "tool" ? (step.tool || step.stepId) : step.stepId;
  const a: ManifestAction = {
    order: String(order),
    // A tool step's name IS the tool name so step-engine resolves it (tenant ?? global registry).
    // Other kinds use the human-readable stepId.
    name: actionName,
    type: step.kind,
    description: step.description ?? step.stepId,
    result_key: step.stepId,
    // Factory output never inherits the whole agent tool roster implicitly.
    // A declarative tool action gets only its own dispatch target; every other
    // action starts with no tool capability.
    allowed_tools: step.kind === "tool" ? [actionName] : [],
  };
  // `timeout_s` is an action execution policy, not an invoke-only field. The
  // runtime applies it to tool/logic/condition/emit/foreach (and accepts it on
  // decision actions authored directly in a manifest).
  if (step.timeoutS) a.timeout_s = step.timeoutS;
  if (step.toolArguments) {
    a.tool_arguments = Object.fromEntries(Object.entries(step.toolArguments).map(([name, value]) => [
      name,
      "from" in value
        ? { from: value.from, ...(value.required === false ? { required: false } : {}) }
        // #G13 —— 有序合取原样往返，manifest 侧用 snake_case。
        : "fromFirst" in value
          ? { from_first: value.fromFirst, ...(value.required === false ? { required: false } : {}) }
          : { const: value.const },
    ]));
  }
  if (step.resultMap) {
    a.result_map = {
      // #G12 —— 对象形态字段按 snake_case 往返；裸路径保持原样，旧 plan 逐字节不变。
      fields: Object.fromEntries(Object.entries(step.resultMap.fields).map(([field, value]) => [
        field,
        typeof value === "string"
          ? value
          : {
              from: value.from,
              ...(value.required === false ? { required: false } : {}),
              ...(value.default !== undefined ? { default: value.default } : {}),
              ...(value.fallbackFrom?.length ? { fallback_from: value.fallbackFrom } : {}),
              ...(value.fallbackConst !== undefined ? { fallback_const: value.fallbackConst } : {}),
            },
      ])),
      ...(step.resultMap.includeRaw ? { include_raw: true } : {}),
    };
  }
  // #G15/#G23 —— 往返。真正执行它们的运行时补丁另行落地；在那之前 projectPlanToActions
  // 会对声明了这些保证的 spec 直接失败（见下），而不是投出一个悄悄丢掉保证的 manifest。
  if (step.healthSignals?.length) {
    a.health_signals = step.healthSignals.map((r) => ({
      when: r.when,
      signal: r.signal,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.fatal ? { fatal: true } : {}),
    }));
  }
  if (step.onEmpty) {
    a.on_empty = "emitEvent" in step.onEmpty
      ? { emit_event: step.onEmpty.emitEvent, ...(step.onEmpty.emitPayload ? { emit_payload: step.onEmpty.emitPayload } : {}) }
      : { suppress_emit: true, reason: step.onEmpty.reason };
  }
  if (step.dependsOn?.length) a.depends_on = step.dependsOn;
  if (step.idempotencyKeyFrom) a.idempotency_key_from = step.idempotencyKeyFrom;
  // A predicate ladder supersedes the legacy label. "park" remains omitted
  // in the legacy form so old plans keep their Inngest-retry behavior.
  if (step.errorPolicy?.length) {
    a.on_error = step.errorPolicy.map((rule) => ({
      ...(Object.prototype.hasOwnProperty.call(rule, "when")
        ? { when: (rule as Extract<ErrorPolicyRule, { when: string }>).when, do: (rule as Extract<ErrorPolicyRule, { when: string }>).do }
        : { default: (rule as Extract<ErrorPolicyRule, { default: ErrorPolicyAction }>).default }),
      ...(Object.prototype.hasOwnProperty.call(rule, "defaultResult") ? { default_result: rule.defaultResult } : {}),
      ...(rule.emitEvent ? { emit_event: rule.emitEvent } : {}),
      ...(rule.emitPayload ? { emit_payload: rule.emitPayload } : {}),
      ...(rule.suppressEmit !== undefined ? { suppress_emit: rule.suppressEmit } : {}),
    }));
  } else if (step.onError === "soft" || step.onError === "terminal") {
    a.on_error = step.onError;
  }
  if (step.defaultResult !== undefined) a.default_result = step.defaultResult;
  if (step.kind === "condition") {
    a.condition = step.condition ?? "true";
    if (step.routes) a.routes = { on_true: step.routes.onTrue, on_false: step.routes.onFalse };
  }
  if (step.kind === "invoke") {
    a.invoke = step.invoke;
    if (step.invokeInput) a.invoke_input = step.invokeInput;
    // Generated sub-agent calls forward computed parent data by default. A spec can opt out.
    a.forward_last_result = step.forwardLastResult ?? true;
    if (step.forwardResults) a.forward_results = true;
  }
  if (step.kind === "foreach") {
    a.items_from = step.itemsFrom;
    a.item_as = step.itemAs ?? "item";
    a.item_key_from = step.itemKeyFrom;
    a.foreach_mode = "sequential";
    a.foreach_actions = (step.body ?? []).map((child, index) => actionForStep(child, index + 1));
  }
  if (step.kind === "emit") {
    a.emit_event = step.emitEvent;
    if (step.emitPayloadFrom) a.emit_payload_from = step.emitPayloadFrom;
    if (step.emitPayload) a.emit_payload = step.emitPayload;
  }
  return a;
}

/** Build the ordered manifest actions for a spec: an optional HITL manual gate, then either the
 *  projected plan steps or the legacy single-logic action (back-compat, no plan). */
/** #G14/#G15 —— 声明了但声明式运行时还执行不了的保证。
 *
 *  这些字段在评审产物（生成的 TS 模块）里是真的会执行的；但部署路径走的是 manifest，
 *  而运行时的规则 schema 是 strict 的、失败处置又是同步的，拿不到 step/tool 句柄。
 *  两种做法里必须选一种：投出一个悄悄丢掉保证的 manifest，或者当场失败并说清楚缺什么。
 *  丢掉保证的那份会一路绿到生产，然后在某个真实故障上安静地不补偿——所以这里 fail closed。 */
function unhonouredGuarantees(plan: PlanStep[] | undefined): string[] {
  const found: string[] = [];
  const walk = (steps: PlanStep[]): void => {
    for (const step of steps) {
      for (const rule of step.errorPolicy ?? []) {
        if (rule.compensate) found.push(`${step.stepId}.errorPolicy.compensate`);
      }
      if (step.healthSignals?.length) found.push(`${step.stepId}.healthSignals`);
      if (step.body?.length) walk(step.body);
    }
  };
  walk(plan ?? []);
  return found;
}

export function projectPlanToActions(spec: GeneratedAgentSpec): ManifestAction[] {
  assertGeneratedSpecExecutionOwner(spec);
  const unhonoured = unhonouredGuarantees(spec.plan);
  if (unhonoured.length) {
    throw new Error(
      `agent "${spec.slug}" declares execution guarantees the declarative runtime cannot honour yet `
      + `(${unhonoured.join("; ")}). 需要先落地 runtime 侧：manifest 规则 schema 放开对应字段、`
      + `失败处置改为可执行补偿（异步 + step/tool 句柄）、以及成功路径的求值挂点。`,
    );
  }
  const actions: ManifestAction[] = [];
  let order = 1;

  // Values that cannot be obtained synchronously from the trigger/ref table
  // become ordinary durable actions. Object lookup dispatches the exact
  // registered tool; human input reuses the runtime's task.waitForEvent path.
  for (const [index, binding] of orderedAcquisitionBindings(spec.inputBindings ?? []).entries()) {
    const projected = projectInputBinding(binding);
    if (binding.kind === "object_lookup") {
      actions.push({
        order: String(order++),
        name: binding.tool,
        description: `Resolve input ${binding.field} from ${binding.sourceObject}`,
        type: "tool",
        allowed_tools: [binding.tool],
        result_key: `input-binding-${index + 1}`,
        on_error: "terminal",
        input_binding: projected,
      });
    } else if (binding.kind === "human_input") {
      actions.push({
        order: String(order++),
        name: `ask-input-${binding.field}`,
        description: binding.prompt,
        type: "manual",
        allowed_tools: [],
        task_type: "agentInput",
        result_key: `input-binding-${index + 1}`,
        input_binding: projected,
      });
    }
  }

  if (spec.hitl) {
    actions.push({
      order: String(order++),
      name: `${spec.actionName || spec.slug}-approval`,
      description: "Human approval gate",
      type: "manual",
      allowed_tools: [],
    });
  }

  // A CodeAct handler is one execution owner for the whole authored plan.  If
  // we also project plan[] into tool/foreach/emit actions, the runtime executes
  // side effects twice (or never runs the code when the plan contains no logic
  // step).  Keep acquisition/HITL outside, then invoke the exact reviewed bytes
  // once.  Tagged handler failures are mapped back to the runtime's retry vs
  // NonRetriable semantics; untagged worker/RPC failures retry conservatively.
  if (spec.codeExecuted === true) {
    if (spec.decisionTables?.length) {
      throw new Error(`codeExecuted agent "${spec.slug}" cannot also project decisionTables; choose one execution owner`);
    }
    actions.push({
      order: String(order++),
      name: spec.actionName || spec.slug,
      description: (spec.designReasoning ?? "").slice(0, 200) || (spec.actionName || spec.slug),
      type: "logic",
      allowed_tools: [],
      result_key: spec.actionName || spec.slug,
      on_error: [
        { when: "meta.codeExecutionError.includes('[terminal]')", do: "terminal", suppress_emit: true },
        { when: "meta.codeExecutionError.includes('[park]')", do: "park", suppress_emit: true },
        { when: "meta.codeExecutionError.includes('[retry]')", do: "retry", suppress_emit: true },
        { default: "retry", suppress_emit: true },
      ],
    });
    return actions;
  }

  const plan = spec.plan ?? [];
  if (plan.length) {
    for (const step of plan) actions.push(actionForStep(step, order++));
  } else {
    actions.push({
      order: String(order++),
      name: spec.actionName || spec.slug,
      description: (spec.designReasoning ?? "").slice(0, 200) || (spec.actionName || spec.slug),
      type: "logic",
      allowed_tools: [],
    });
  }
  for (const table of spec.decisionTables ?? []) {
    actions.push({
      order: String(order++),
      name: `decision-${table.id}`,
      description: table.description ?? `Evaluate decision table ${table.id}`,
      type: "decision",
      allowed_tools: [],
      result_key: `decision-${table.id}`,
      decision_table: table,
    });
  }
  return actions;
}
