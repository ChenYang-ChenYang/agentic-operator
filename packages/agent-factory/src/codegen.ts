// Agent code generator — render a generated SPEC into a readable agent module the
// user can SEE + own + edit, and validate AI-written agent code.
//
// Adapted for the new arch: the OLD repo rendered an Inngest createFunction wired to
// a tool-registry's per-client `impl` metadata. The new monorepo has no such registry
// (agents deploy via the workflow manifest), so this renders a clean, self-documenting
// agent module — IO interfaces from the ontology-grounded schema, the LLM-authored
// SYSTEM_PROMPT verbatim, the bound tools, the per-branch decision logic, and a handler
// sketch. It's a faithful, readable scaffold (the deployed path is the manifest), not a
// guaranteed-runnable drop-in. Ported from OLD lib/agent-factory-v3/codegen.ts.

import type { GeneratedAgentSpec, IoField, PlanStep } from "./spec-types";
import {
  assertPlanDataflowRenderable,
  PLAN_DATAFLOW_RUNTIME_SRC,
  planUsesExactDataflow,
  renderedInvokeInput,
  renderedToolArguments,
  renderedToolCallback,
} from "./plan-dataflow-code";
import { ERROR_POLICY_RUNTIME_SRC } from "./error-policy-code";
import { generatedSpecExecutionOwnership } from "./execution-ownership";
import { validateConditionSyntax } from "./plan-projection";

/** 从 spec 推导「运行失败」事件名。
 *
 * #G19 — 只有本身就是失败形态的已声明事件(_FAILED/_ERROR/_REJECTED/_DENIED)才可以复用。
 * 以前这里对多 emit 的 agent 一律取【最后一个】声明事件，于是一次 HTTP 401 或一处接线 bug
 * 会被当成业务终态发出去：候选人被永久拒绝、锁冲突被凭空报告，而事件里没有任何支撑这个
 * 判定的证据。运行错误不是业务结论，拿不准就合成一个 _FAILED。 */
export function failEmitOf(spec: GeneratedAgentSpec): string {
  const emits = (spec.emit ?? []).filter(Boolean);
  const failureShaped = emits.find((name) =>
    /_(FAILED|ERROR|REJECTED|DENIED)$/.test(name),
  );
  if (failureShaped) return failureShaped;
  const base = (emits[0] ?? spec.trigger?.[0] ?? spec.actionName ?? "TASK")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_(PROCESSED|DONE|GENERATED|SENT|PASSED|OK)$/, "");
  return `${base}_FAILED`;
}

function camel(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : "agent";
}

// ── #SLOT-1 fieldMapping(确定性填实)────────────────────────────────────────────
/** 从 inputSchema 渲染真实的 mapFields:声明字段显式提取 + source 路径回退 + 类型规整,
 *  其余键透传。无 schema 时诚实透传(注释说明,而不是假装映射过)。 */
export function renderMapFields(fields: IoField[] | undefined): string {
  const fs = (fields ?? []).filter((f) => f && f.field);
  const header = [
    `// ──────────────────────────────────────────────────────────────────────────`,
    `// #SLOT-1 fieldMapping — 事件 payload 的松散字段 → 本 agent 需要的形状/文本。`,
    fs.length
      ? `//   已按本体输入 schema 确定性填实:声明字段显式提取 + 源路径回退 + 类型规整,其余键透传。`
      : `//   本体未声明输入 schema——诚实透传(不假装映射);补充 inputSchema 后重渲染即可填实。`,
  ];
  if (!fs.length) {
    return [
      ...header,
      `function mapFields(raw: Record<string, unknown>): Record<string, unknown> {`,
      `  return raw;`,
      `}`,
    ].join("\n");
  }
  // #G7 —— 真实信封把业务字段放在 payload 之下、锚点放在同级 entity_id。以前只有 source
  // 一种来源，于是 required 锚点在每个真实事件上都解析成 undefined；设计端其实推导出了正确的
  // 优先级顺序，却没有一个结构化的地方放它，最后落成了 systemPrompt 里的散文。
  const usesPick = fs.some(
    (f) =>
      (f.source && f.source.includes(".")) || (f.eventPaths?.length ?? 0) > 0,
  );
  const usesNum = fs.some((f) => /^(num|int|float|double)/i.test(f.type ?? ""));
  const usesBool = fs.some((f) => /^bool/i.test(f.type ?? ""));
  const lines: string[] = [
    ...header,
    `function mapFields(raw: Record<string, unknown>): Record<string, unknown> {`,
  ];
  if (usesPick)
    lines.push(
      `  const pick = (path: string): unknown => path.split(".").reduce<unknown>((c, k) => (c != null && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), raw);`,
    );
  if (usesNum)
    lines.push(
      `  const num = (v: unknown): number | undefined => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));`,
    );
  if (usesBool)
    lines.push(
      `  const bool = (v: unknown): boolean | undefined => (v == null ? undefined : v === true || v === "true" || v === 1 || v === "1");`,
    );
  // 空串/纯空白算未命中：裸 ?? 会把只有空格的字段当成有值收下，然后 required 守卫放行一个空锚点。
  if (usesPick)
    lines.push(
      `  const firstPresent = (...vals: unknown[]): unknown => vals.find((v) => v != null && (typeof v !== "string" || v.trim() !== ""));`,
    );
  lines.push(`  const out: Record<string, unknown> = { ...raw };`);
  for (const f of fs) {
    const key = JSON.stringify(f.field);
    // 探测顺序：声明的信封位置（高→低）→ 平铺字段名 → 本体 source 路径。
    // 平铺位置永远保留在链上，所以已经在用平铺信封的租户不受影响。
    const probes = [
      ...(f.eventPaths ?? [])
        .filter((path) => typeof path === "string" && path.trim())
        .map((path) => `pick(${JSON.stringify(path)})`),
      `raw[${key}]`,
      ...(f.source && f.source.includes(".")
        ? [`pick(${JSON.stringify(f.source)})`]
        : []),
    ];
    const deduped = [...new Set(probes)];
    const base =
      deduped.length > 1 ? `firstPresent(${deduped.join(", ")})` : deduped[0]!;
    const coerced = /^(num|int|float|double)/i.test(f.type ?? "")
      ? `num(${base})`
      : /^bool/i.test(f.type ?? "")
        ? `bool(${base})`
        : base;
    const note = [f.description, f.source ? `源: ${f.source}` : ""]
      .filter(Boolean)
      .join(" | ")
      .replace(/\s+/g, " ")
      .slice(0, 100);
    lines.push(`  out[${key}] = ${coerced};${note ? ` // ${note}` : ""}`);
  }
  lines.push(`  return out;`, `}`);
  return lines.join("\n");
}

function tsType(t: string): string {
  const x = (t || "").toLowerCase();
  if (x.startsWith("str")) return "string";
  if (
    x.startsWith("num") ||
    x === "int" ||
    x === "integer" ||
    x === "float" ||
    x === "double"
  )
    return "number";
  if (x.startsWith("bool")) return "boolean";
  if (x.startsWith("arr") || x.endsWith("[]")) return "unknown[]";
  if (x.startsWith("obj") || x.startsWith("map") || x.startsWith("json"))
    return "Record<string, unknown>";
  return "unknown";
}

function ioInterface(name: string, fields: IoField[] | undefined): string {
  if (!fields?.length) return "";
  const lines = fields.map((f) => {
    const key = /^[a-zA-Z_$][\w$]*$/.test(f.field)
      ? f.field
      : JSON.stringify(f.field);
    const note = f.description
      ? ` // ${f.description.replace(/\s+/g, " ").trim()}${f.source ? ` (源: ${f.source})` : ""}`
      : f.source
        ? ` // 源: ${f.source}`
        : "";
    return `  ${key}${f.required === false ? "?" : ""}: ${tsType(f.type)};${note}`;
  });
  return `interface ${name} {\n${lines.join("\n")}\n}`;
}

// #REAL-TYPECHECK — the ambient world generated agent code lives in: the defineAgent socket +
// the EXACT AgentRuntime ctx surface codeact.ts provides at run time. Declared both as a global
// (scope-injected style) and as the "@agentic/runtime" module (import style). Any OTHER import is
// a semantic error ON PURPOSE: in the CodeAct shim every other module resolves to `{}`, so code
// that imports it would be calling undefined at run time — the typecheck now says so up front.
const AGENT_AMBIENT_DTS = `
interface AgentMemory {
  get<T = unknown>(key: string): Promise<T | null>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  search(query: string, opts?: Record<string, unknown>): Promise<unknown[]>;
}
interface AgentSpawnResult { ok: boolean; data?: unknown; error?: string; emitted?: unknown[]; code?: string }
interface AgentRuntimeCtx {
  agentName: string;
  tenantSlug: string;
  correlationId: string;
  subject?: string;
  memory: AgentMemory;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
  reason(systemPrompt: string, input: unknown): Promise<Record<string, unknown>>;
  emit(event: string, payload?: Record<string, unknown>): Promise<void> | void;
  tools: { run(name: string, args?: unknown): Promise<unknown> };
  tool(name: string, args?: unknown): Promise<unknown>;
  spawn(task: string, input?: unknown, opts?: { tools?: string[] }): Promise<AgentSpawnResult>;
  invoke(agentRef: string, input?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}
interface AgentDefinition {
  id?: string; name?: string; actor?: string[]; trigger?: string[]; emit?: string[];
  tools?: string[]; systemPrompt?: string;
  handler(input: Record<string, unknown>, ctx: AgentRuntimeCtx): Promise<unknown> | unknown;
  [k: string]: unknown;
}
declare function defineAgent(cfg: AgentDefinition): AgentDefinition;
declare module "@agentic/runtime" {
  export function defineAgent(cfg: AgentDefinition): AgentDefinition;
}
// ── the ts_function_module (inngest.createFunction) deliverable's world ──────────
interface InngestStepLike {
  run<T = unknown>(id: string, fn: () => Promise<T> | T): Promise<T>;
  sendEvent(id: string, ev: { name: string; data?: Record<string, unknown> } | Array<{ name: string; data?: Record<string, unknown> }>): Promise<unknown> | unknown;
  invoke(id: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForEvent(id: string, opts?: Record<string, unknown>): Promise<unknown>;
}
interface InngestLoggerLike {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}
declare module "@/server/inngest/client" {
  export const inngest: {
    createFunction(
      cfg: Record<string, unknown>,
      trigger: Record<string, unknown> | Array<Record<string, unknown>>,
      handler: (args: { event: { name?: string; data?: Record<string, unknown> }; step: InngestStepLike; logger: InngestLoggerLike }) => Promise<unknown> | unknown,
    ): unknown;
  };
}
declare module "inngest" {
  export class NonRetriableError extends Error {}
}
`;

/** Validate AI-written agent code with a REAL semantic typecheck (ts.createProgram over a
 *  virtual host: the code + the ambient ctx surface). Catches what transpile-only syntax
 *  checking waved through for months — calls to nonexistent ctx methods, imports that resolve
 *  to {} at run time, arity/typo bugs. Degrades: semantic → transpile syntax → bracket floor;
 *  degradation never fail-opens (each tier still reports its own errors). */
// Perf: parsing the ES2022 lib .d.ts set dominates the semantic check (~seconds). Cache the
// parsed lib SourceFiles process-wide — they never change — so only the first validation pays;
// every later call re-parses just the two small virtual files.
const __libSourceCache = new Map<string, import("typescript").SourceFile>();

export async function validateAgentCode(
  code: string,
): Promise<{ ok: boolean; errors: string[] }> {
  try {
    const ts = await import("typescript");
    // ── tier 1: semantic program over a virtual host ────────────────────────────
    try {
      const options: import("typescript").CompilerOptions = {
        noEmit: true,
        strict: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        allowJs: false,
      };
      const CODE_FILE = "/__generated_agent__.ts";
      const AMBIENT_FILE = "/__agent_ambient__.d.ts";
      const virtual = new Map<string, string>([
        [CODE_FILE, code],
        [AMBIENT_FILE, AGENT_AMBIENT_DTS],
      ]);
      const base = ts.createCompilerHost(options, true);
      const host: import("typescript").CompilerHost = {
        ...base,
        fileExists: (f) => virtual.has(f) || base.fileExists(f),
        readFile: (f) => virtual.get(f) ?? base.readFile(f),
        getSourceFile: (f, lang, onError, shouldCreate) => {
          if (virtual.has(f))
            return ts.createSourceFile(
              f,
              virtual.get(f)!,
              ts.ScriptTarget.ES2022,
              true,
            );
          const hit = __libSourceCache.get(f);
          if (hit) return hit;
          const sf = base.getSourceFile(f, lang, onError, shouldCreate);
          if (sf) __libSourceCache.set(f, sf);
          return sf;
        },
        writeFile: () => {
          /* noEmit */
        },
      };
      const program = ts.createProgram(
        [CODE_FILE, AMBIENT_FILE],
        options,
        host,
      );
      const diags = [
        ...program.getSyntacticDiagnostics(program.getSourceFile(CODE_FILE)),
        ...program.getSemanticDiagnostics(program.getSourceFile(CODE_FILE)),
      ];
      const errors = diags
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => {
          const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
          if (d.file && d.start !== undefined) {
            const { line } = d.file.getLineAndCharacterOfPosition(d.start);
            return `L${line + 1}: ${msg}`;
          }
          return msg;
        });
      return { ok: errors.length === 0, errors };
    } catch {
      // ── tier 2: transpile-level syntax check (the old behavior) ──────────────
      const out = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          isolatedModules: true,
        },
        reportDiagnostics: true,
      });
      const errors = (out.diagnostics ?? [])
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
      return { ok: errors.length === 0, errors };
    }
  } catch {
    // ── tier 3: bracket-balance floor (typescript itself unavailable) ──────────
    const errors: string[] = [];
    const count = (s: string) => code.split(s).length - 1;
    if (count("{") !== count("}")) errors.push("花括号 { } 不配对");
    if (count("(") !== count(")")) errors.push("圆括号 ( ) 不配对");
    if (count("`") % 2 !== 0) errors.push("反引号 ` 不配对");
    if (!/export\s+(const|default|function)/.test(code))
      errors.push("缺少 export const / default / function");
    return { ok: errors.length === 0, errors };
  }
}

/**
 * #REDESIGN FU3 — the PROBE stage of the reviewLoop. Compile (validateAgentCode) proves the code
 * type-checks; this proves it actually LOADS and exposes a CALLABLE handler — the same structural
 * gate `runGeneratedCode` (codeact.ts) applies before it will execute. Transpile → run in a `new
 * Function` shim with a capturing `defineAgent` → confirm a `handler` function surfaced. The handler
 * is NOT invoked here (that needs a gateway + tools); this only rejects code that compiles but has no
 * runnable handler (a common codegen failure that a compile check alone lets through as "executable").
 * Never throws — returns `{ loads:false, reason }` on any failure so the grade degrades gracefully.
 */
export async function probeAgentModule(
  code: string,
): Promise<{ loads: boolean; reason?: string }> {
  if (!code || code.trim().length < 40)
    return { loads: false, reason: "代码过短/为空" };
  try {
    const ts = await import("typescript");
    const js = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    type ProbeDefinition = {
      handler?: unknown;
      factoryExecutionMode?: unknown;
      factoryExecutionReason?: unknown;
    };
    let captured: ProbeDefinition | null = null;
    const defineAgent = (cfg: ProbeDefinition) => {
      captured = cfg;
      return cfg;
    };
    const requireShim = (id: string): unknown =>
      id === "@agentic/runtime" ? { defineAgent } : {};
    const moduleObj = { exports: {} as Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
      "require",
      "exports",
      "module",
      "defineAgent",
      js,
    ) as (
      r: (id: string) => unknown,
      e: Record<string, unknown>,
      m: { exports: Record<string, unknown> },
      d: (c: ProbeDefinition) => unknown,
    ) => void;
    factory(requireShim, moduleObj.exports, moduleObj, defineAgent);
    const def =
      (captured as ProbeDefinition | null) ??
      (Object.values(moduleObj.exports).find(
        (v) =>
          v &&
          typeof v === "object" &&
          typeof (v as { handler?: unknown }).handler === "function",
      ) as ProbeDefinition | undefined) ??
      null;
    if (!def || typeof def.handler !== "function")
      return {
        loads: false,
        reason: "加载后没有可调用的 handler（defineAgent 未导出/handler 缺失）",
      };
    if (def.factoryExecutionMode === "declarative_required") {
      return {
        loads: false,
        reason:
          typeof def.factoryExecutionReason === "string" &&
          def.factoryExecutionReason.trim()
            ? def.factoryExecutionReason
            : "该结构化计划需要声明式 durable runtime，不能按 CodeAct 执行",
      };
    }
    return { loads: true };
  } catch (e) {
    return {
      loads: false,
      reason: `加载探针失败：${(e as Error).message.slice(0, 80)}`,
    };
  }
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

// ── real handler rendering ─────────────────────────────────────────────────────
// #TRUE-CODE — the handler used to comment out every tool call and hardcode a 2-way emit
// (a scaffold that "really executed" in CodeAct but did nothing real). Now it renders the
// spec's plan[] into an actually-executing sequence: real ctx.tools.run calls with result
// threading, dependsOn gating, a self-contained condition evaluator whose semantics mirror
// packages/runtime/src/action-plan.ts, per-step onError policy, a FAIL-CLOSE decision core,
// and real multi-branch emit selection.

/** Embedded, dependency-free condition evaluator — same dialect as the runtime's
 *  evaluateCondition (dotted paths on scope, ==/!=/>=/<=/>/<, !, &&, ||, literals).
 *  Emitted into every generated module so the code stays self-contained (imports other
 *  than @agentic/runtime resolve to {} in the CodeAct shim). Exported for the
 *  ts-function-module renderer, which embeds the same dialect. */
export const EVAL_CONDITION_SRC = `
function readPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
function readConditionPath(scope: Record<string, unknown>, rawPath: string): unknown {
  const path = rawPath.trim().replace(/\\?\\./g, ".").replace(/\\[['"]([^'"]+)['"]\\]/g, ".$1");
  const results = scope.results as Record<string, unknown> | undefined;
  const explicit = path.startsWith("results.") || path.startsWith("steps.");
  const rel = explicit ? path.replace(/^(results|steps)\\./, "") : path;
  for (const key of Object.keys(results ?? {}).sort((a, b) => b.length - a.length)) {
    if (rel !== key && !rel.startsWith(key + ".")) continue;
    let tail = rel === key ? "" : rel.slice(key.length + 1);
    if (tail === "result" || tail === "data" || tail === "value") tail = "";
    else tail = tail.replace(/^(result|data|value)\\./, "");
    return tail ? readPath(results![key], tail) : results![key];
  }
  if (explicit) return undefined;
  const direct = readPath(scope, path);
  if (direct !== undefined) return direct;
  const last = readPath(scope.lastResult, path);
  if (last !== undefined) return last;
  return readPath(scope.input ?? (scope.event as Record<string, unknown> | undefined)?.data, path);
}
function evalCondition(expr: string, scope: Record<string, unknown>): boolean {
  const e = (expr || "").trim();
  if (!e) return false;
  const split = (s: string, op: string): string[] => {
    const out: string[] = []; let depth = 0; let q = ""; let buf = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (q) { buf += c; if (c === q) q = ""; continue; }
      if (c === "'" || c === '"') { q = c; buf += c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      if (depth === 0 && s.startsWith(op, i)) { out.push(buf); buf = ""; i += op.length - 1; continue; }
      buf += c;
    }
    out.push(buf); return out;
  };
  try {
    const ors = split(e, "||");
    if (ors.length > 1) return ors.some((p) => evalCondition(p, scope));
    const ands = split(e, "&&");
    if (ands.length > 1) return ands.every((p) => evalCondition(p, scope));
    if (/^true$/i.test(e)) return true;
    if (/^false$/i.test(e)) return false;
    const m = e.match(/^(.+?)\\s*(===|!==|==|!=|>=|<=|>|<)\\s*(.+)$/);
    if (m) {
      const lit = (t0: string): unknown => {
        const t = t0.trim();
        if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
        if (t === "null" || t === "undefined") return null; if (t === "true") return true; if (t === "false") return false;
        if (/^-?\\d+(\\.\\d+)?$/.test(t)) return Number(t);
        return t;
      };
      const l = readConditionPath(scope, m[1]!.trim()); const r = lit(m[3]!); const op = m[2]!;
      if (r === null && (op === "==" || op === "===")) return l == null;
      if (r === null && (op === "!=" || op === "!==")) return l != null;
      if (op === "===") return l === r;
      if (op === "!==") return l !== r;
      if (op === "==") return l === r || (l != null && r != null && String(l) === String(r));
      if (op === "!=") return !(l === r || (l != null && r != null && String(l) === String(r)));
      if (op === ">") return Number(l) > Number(r);
      if (op === "<") return Number(l) < Number(r);
      if (op === ">=") return Number(l) >= Number(r);
      return Number(l) <= Number(r);
    }
    if (e.startsWith("!!")) return Boolean(readConditionPath(scope, e.slice(2).trim()));
    if (e.startsWith("!")) return !Boolean(readConditionPath(scope, e.slice(1).trim()));
    return Boolean(readConditionPath(scope, e));
  } catch { return false; }
}
`.trim();

const CODEGEN_VALUE_PATH_RE =
  /^[A-Za-z_$][A-Za-z0-9_$-]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$-]*|\[['"][^'"\]]+['"]\])*$/;

const CODEGEN_INVOKE_RUNTIME_SRC = `
const _invokePayload = (args: { eventData: Record<string, unknown>; invokeInput?: Record<string, unknown>; forwardLastResult?: boolean; forwardResults?: boolean; lastResult?: unknown; results?: Record<string, unknown>; subject?: unknown; correlationId?: string }): Record<string, unknown> => {
  const last = args.forwardLastResult === false || args.lastResult == null ? {} : (typeof args.lastResult === "object" && !Array.isArray(args.lastResult) ? args.lastResult as Record<string, unknown> : { _lastResult: args.lastResult });
  const subject = args.subject ?? args.eventData.subject ?? args.eventData._subject;
  const correlationId = args.correlationId || args.eventData.__correlationId || args.eventData._correlationId;
  return { ...args.eventData, ...(args.invokeInput ?? {}), ...last, ...(args.forwardResults ? { _results: { ...(args.results ?? {}) } } : {}), ...(subject == null ? {} : { subject, _subject: subject }), ...(correlationId == null || correlationId === "" ? {} : { __correlationId: correlationId, _correlationId: correlationId }) };
};
`.trim();

const CODEGEN_FOREACH_IDENTITY_SRC = `
const _sanitizeStepPart = (value: string): string => {
  const clean = (value || "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return /[A-Za-z0-9]/.test(clean) ? clean : "step";
};
const _stableDigest96 = (value: string): string => {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  const prime = 0x0000000001000000000000000000013bn; const mask = (1n << 128n) - 1n;
  for (let i = 0; i < value.length; i++) hash = ((hash ^ BigInt(value.charCodeAt(i))) * prime) & mask;
  return hash.toString(16).padStart(32, "0").slice(-24);
};
const _stableForeachKey = (businessKey: string): string => _sanitizeStepPart(businessKey).slice(0, 40) + "-" + _stableDigest96(businessKey);
`.trim();

function allPlanSteps(plan: PlanStep[]): PlanStep[] {
  return plan.flatMap((step) => [
    step,
    ...(step.body ? allPlanSteps(step.body) : []),
  ]);
}

function assertCodegenPlan(plan: PlanStep[], declaredEvents: string[]): void {
  const seen = new Set<string>();
  for (const step of plan) {
    const id = step.stepId || step.tool || step.kind;
    if (!id || seen.has(id))
      throw new Error(
        `cannot render agent plan: duplicate or empty stepId "${id || "(empty)"}"`,
      );
    seen.add(id);
    assertPlanDataflowRenderable(step, id);
    if (step.condition) {
      const conditionError = validateConditionSyntax(step.condition);
      if (conditionError) {
        throw new Error(
          `cannot render agent step "${id}": invalid condition — ${conditionError}`,
        );
      }
    }
    if (
      step.timeoutS !== undefined &&
      (!Number.isInteger(step.timeoutS) || step.timeoutS <= 0)
    ) {
      throw new Error(
        `cannot render agent step "${id}": timeoutS must be a positive integer`,
      );
    }
    if (step.kind === "emit") {
      if (!step.emitEvent)
        throw new Error(
          `cannot render emit step "${id}": emitEvent is required`,
        );
      if (!declaredEvents.includes(step.emitEvent))
        throw new Error(
          `cannot render emit step "${id}": event "${step.emitEvent}" is not in the declared emit allow-list`,
        );
      if (
        step.emitPayloadFrom &&
        !CODEGEN_VALUE_PATH_RE.test(step.emitPayloadFrom)
      )
        throw new Error(
          `cannot render emit step "${id}": emitPayloadFrom is not a safe data path`,
        );
    }
    for (const rule of step.errorPolicy ?? []) {
      if (rule.emitEvent && !declaredEvents.includes(rule.emitEvent))
        throw new Error(
          `cannot render errorPolicy for "${id}": event "${rule.emitEvent}" is not in the declared emit allow-list`,
        );
    }
    if (step.kind === "foreach") {
      if (!step.itemsFrom || !CODEGEN_VALUE_PATH_RE.test(step.itemsFrom))
        throw new Error(
          `cannot render foreach step "${id}": itemsFrom must be a safe data path`,
        );
      if (!step.itemKeyFrom || !CODEGEN_VALUE_PATH_RE.test(step.itemKeyFrom))
        throw new Error(
          `cannot render foreach step "${id}": itemKeyFrom must be a safe replay-stable data path`,
        );
      if (!step.body?.length)
        throw new Error(`cannot render foreach step "${id}": body is required`);
      assertCodegenPlan(step.body, declaredEvents);
    }
  }
}

function policySource(step: PlanStep): string {
  if (step.errorPolicy?.length) return JSON.stringify(step.errorPolicy);
  return step.onError ? JSON.stringify(step.onError) : "undefined";
}

function codegenFailureLines(
  step: PlanStep,
  id: string,
  lastVar: string,
): string[] {
  const fallback =
    step.defaultResult !== undefined
      ? JSON.stringify(step.defaultResult)
      : step.onError === "soft"
        ? "null"
        : "undefined";
  // #G16 —— 与 ts-function-module.policyFailureLines 保持同一顺序：先发声明的失败事件，
  // 再抛。放在抛出之后它在每条终态路径上都是死代码——唯一能把事故升级给人的消费方永远
  // 收不到，运行悄无声息地退休。两个渲染器在这一点上必须一致，否则同一份 spec 在
  // CodeAct 与声明式两条路上的失败语义不同。
  return [
    `const _resolution = _afResolveFailure(${policySource(step)}, e, ${fallback});`,
    `if (_resolution.suppressEmit) _suppressImplicitEmit = true;`,
    `if (_resolution.emitEvent && !_resolution.suppressEmit) { await ctx.emit(_resolution.emitEvent, _afFailurePayload(_resolution)); _explicitEmitCount++; }`,
    `if (_resolution.disposition !== "continue") {`,
    `  const _tag = _resolution.disposition === "terminal" ? "terminal" : (_resolution.policyAction === "park" ? "park" : "retry");`,
    `  ctx.log?.("error", ${JSON.stringify(`步骤 ${id} 按错误策略终止`)}, { action: _resolution.policyAction, facts: _resolution.facts });`,
    `  throw new Error("[" + _tag + "] step ${id}: " + _resolution.facts.message);`,
    `}`,
    `${lastVar} = _resolution.defaultResult;`,
  ];
}

function codegenEmitLines(
  step: PlanStep,
  scope: string,
  lastVar: string,
): string[] {
  const selected = step.emitPayloadFrom
    ? `readConditionPath(${scope}, ${JSON.stringify(step.emitPayloadFrom)})`
    : `(${scope}).lastResult`;
  return [
    `const _selected = ${selected};`,
    ...(step.emitPayloadFrom
      ? [
          `if (_selected === undefined) throw new Error(${JSON.stringify(`[terminal] emit step ${step.stepId}: payload path ${step.emitPayloadFrom} did not resolve`)});`,
        ]
      : []),
    `const _payloadBase = _selected && typeof _selected === "object" && !Array.isArray(_selected) ? (_selected as Record<string, unknown>) : _selected === undefined ? {} : { value: _selected };`,
    `const _payload: Record<string, unknown> = { ..._payloadBase, ...${JSON.stringify(step.emitPayload ?? {})} };`,
    `await ctx.emit(${JSON.stringify(step.emitEvent)}, _payload);`,
    `_explicitEmitCount++;`,
    `${lastVar} = { ..._payload, _emit: ${JSON.stringify(step.emitEvent)} };`,
  ];
}

function indentCode(lines: string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => prefix + line);
}

interface CodegenForeachEnv {
  depth: number;
  inputExpr: string;
  outerLastExpr: string;
  outerResultsExpr: string;
  outerLocalsExpr: string;
  assignTo: string;
}

function renderCodegenForeachBody(
  parent: PlanStep,
  trigger: string,
  env: CodegenForeachEnv,
): string[] {
  const n = env.depth;
  const locals = `_locals${n}`;
  const localLast = `_localLast${n}`;
  const localResults = `_localResults${n}`;
  const localCond = `_localCond${n}`;
  const localSkipped = `_localSkipped${n}`;
  const localPass = `_localPass${n}`;
  const localCarry = `_localCarry${n}`;
  const out: string[] = [];
  for (const child of parent.body ?? []) {
    const id = child.stepId || child.tool || child.kind;
    const deps = (child.dependsOn ?? []).filter(Boolean);
    const resultsExpr = `{ ...(${env.outerResultsExpr}), ...${localResults} }`;
    const scope = `{ ...${locals}, locals: ${locals}, event: { name: ${JSON.stringify(trigger)}, data: { ...(${env.inputExpr}), ...${locals} } }, lastResult: ${localLast}, results: ${resultsExpr}, input: ${env.inputExpr} }`;
    const guards = [
      ...(deps.length ? [`${localPass}(${JSON.stringify(deps)})`] : []),
      ...(child.kind !== "condition" && child.condition
        ? [`evalCondition(${JSON.stringify(child.condition)}, ${scope})`]
        : []),
    ];
    let execute: string[];
    if (child.kind === "condition") {
      execute = [
        `${localCond}[${JSON.stringify(id)}] = evalCondition(${JSON.stringify(child.condition ?? "")}, ${scope});`,
        `${localResults}[${JSON.stringify(id)}] = { evaluated: ${localCond}[${JSON.stringify(id)}] };`,
      ];
    } else {
      if (child.kind === "tool") {
        const toolArgs = renderedToolArguments(child, scope, `${localCarry}()`);
        execute = [
          ...(toolArgs.legacy
            ? [
                `// LEGACY WHOLE-CARRY: toolArguments 未声明；只为旧 plan 保留。`,
              ]
            : []),
          `${localLast} = await (${renderedToolCallback(child, `await ctx.tools.run(${JSON.stringify(child.tool ?? id)}, ${toolArgs.expression})`)})();`,
        ];
      } else if (child.kind === "invoke") {
        const eventData = `{ ...(${env.inputExpr}), ...${locals} }`;
        const payload = `_invokePayload({ eventData: ${eventData}, invokeInput: ${renderedInvokeInput(child.invokeInput as Record<string, unknown> | undefined, scope)}, forwardLastResult: ${String(child.forwardLastResult ?? true)}, forwardResults: ${String(child.forwardResults ?? false)}, lastResult: ${localLast}, results: ${resultsExpr}, subject: ctx.subject, correlationId: ctx.correlationId })`;
        execute = [
          `${localLast} = await ctx.invoke(${JSON.stringify(child.invoke ?? id)}, ${payload}, { timeoutMs: ${child.timeoutS ? child.timeoutS * 1000 : "undefined"} });`,
        ];
      } else if (child.kind === "emit")
        execute = codegenEmitLines(child, scope, localLast);
      else if (child.kind === "foreach") {
        execute = codegenForeachLines(child, trigger, {
          depth: n + 1,
          inputExpr: env.inputExpr,
          outerLastExpr: localLast,
          outerResultsExpr: resultsExpr,
          outerLocalsExpr: locals,
          assignTo: localLast,
        });
      } else
        execute = [
          `${localLast} = await ctx.reason(SYSTEM_PROMPT + ${JSON.stringify(`\n\n【foreach ${parent.stepId} 子步骤】${id}${child.description ? `：${child.description}` : ""}`)}, ${localCarry}());`,
        ];
      execute = [
        `try {`,
        ...indentCode(execute, 2),
        `} catch (e) {`,
        ...indentCode(codegenFailureLines(child, id, localLast), 2),
        `}`,
        `${localResults}[${JSON.stringify(id)}] = ${localLast};`,
      ];
    }
    out.push(`// foreach child ${id} (${child.kind})`);
    if (guards.length) {
      out.push(
        `if (${guards.join(" && ")}) {`,
        ...indentCode(execute, 2),
        `} else {`,
        `  ${localSkipped}.add(${JSON.stringify(id)});`,
        `  ${localResults}[${JSON.stringify(id)}] = { skipped: true, reason: "dependency condition was false or skipped" };`,
        `}`,
      );
    } else out.push(...execute);
  }
  return out;
}

function codegenForeachLines(
  step: PlanStep,
  trigger: string,
  env: CodegenForeachEnv = {
    depth: 1,
    inputExpr: "$in",
    outerLastExpr: "last",
    outerResultsExpr: "results",
    outerLocalsExpr: "{}",
    assignTo: "last",
  },
): string[] {
  const id = step.stepId || "foreach";
  const n = env.depth;
  const collection = `_collection${n}`;
  const seen = `_seenKeys${n}`;
  const seenStable = `_seenStableKeys${n}`;
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
  const localCarry = `_localCarry${n}`;
  const emitCountBefore = `_emitCountBefore${n}`;
  const hasConditionalEmit = (step.body ?? []).some(
    (child) => child.kind === "emit" && Boolean(child.condition),
  );
  const scope = `{ event: { name: ${JSON.stringify(trigger)}, data: { ...(${env.inputExpr}), ...(${env.outerLocalsExpr}) } }, lastResult: ${env.outerLastExpr}, results: ${env.outerResultsExpr}, input: ${env.inputExpr}, locals: ${env.outerLocalsExpr} }`;
  return [
    `const ${collection} = readConditionPath(${scope}, ${JSON.stringify(step.itemsFrom)});`,
    `if (!Array.isArray(${collection})) throw new Error(${JSON.stringify(`[terminal] foreach ${id}: itemsFrom ${step.itemsFrom} did not resolve to an array`)});`,
    `const ${seen} = new Set<string>();`,
    `const ${seenStable} = new Map<string, string>();`,
    `const ${receipts}: Array<Record<string, unknown>> = [];`,
    `for (let ${index} = 0; ${index} < ${collection}.length; ${index}++) {`,
    `  const ${item} = ${collection}[${index}];`,
    `  const ${locals}: Record<string, unknown> = { ...(${env.outerLocalsExpr}), ${JSON.stringify(step.itemAs?.trim() || "item")}: ${item}, index: ${index} };`,
    `  const ${keyValue} = readConditionPath({ ...${locals}, locals: ${locals}, event: { name: ${JSON.stringify(trigger)}, data: { ...(${env.inputExpr}), ...${locals} } }, lastResult: ${item}, results: ${env.outerResultsExpr}, input: ${env.inputExpr} }, ${JSON.stringify(step.itemKeyFrom)});`,
    `  if (${keyValue} == null || String(${keyValue}).trim() === "") throw new Error(${JSON.stringify(`[terminal] foreach ${id}: item has no stable key at ${step.itemKeyFrom}`)} + " (#" + ${index} + ")");`,
    `  const ${businessKey} = String(${keyValue});`,
    `  if (${seen}.has(${businessKey})) throw new Error(${JSON.stringify(`[terminal] foreach ${id}: duplicate item key `)} + ${businessKey});`,
    `  ${seen}.add(${businessKey});`,
    `  const ${stableKey} = _stableForeachKey(${businessKey});`,
    `  if (${seenStable}.has(${stableKey}) && ${seenStable}.get(${stableKey}) !== ${businessKey}) throw new Error(${JSON.stringify(`[terminal] foreach ${id}: stable key collision for `)} + ${businessKey});`,
    `  ${seenStable}.set(${stableKey}, ${businessKey});`,
    `  ${locals}.key = ${businessKey};`,
    `  ${locals}.stableKey = ${stableKey};`,
    `  ${locals}._foreachPath = [...(Array.isArray((${env.outerLocalsExpr} as Record<string, unknown>)._foreachPath) ? ((${env.outerLocalsExpr} as Record<string, unknown>)._foreachPath as unknown[]) : []), ${businessKey}];`,
    `  let ${localLast}: unknown = ${item};`,
    `  const ${localResults}: Record<string, unknown> = {};`,
    `  const ${localCond}: Record<string, boolean> = {};`,
    `  const ${localSkipped} = new Set<string>();`,
    `  const ${localPass} = (deps: string[]): boolean => deps.every((dep) => !${localSkipped}.has(dep) && ${localCond}[dep] !== false);`,
    `  const ${localCarry} = (): Record<string, unknown> => ({ ...(${env.inputExpr}), ...(${env.outerLastExpr} && typeof ${env.outerLastExpr} === "object" ? (${env.outerLastExpr} as Record<string, unknown>) : {}), ...${locals}, ...(${localLast} && typeof ${localLast} === "object" ? (${localLast} as Record<string, unknown>) : {}), results: { ...(${env.outerResultsExpr}), ...${localResults} } });`,
    ...(hasConditionalEmit
      ? [`  const ${emitCountBefore} = _explicitEmitCount;`]
      : []),
    ...indentCode(renderCodegenForeachBody(step, trigger, env), 2),
    ...(hasConditionalEmit
      ? [
          `  if (_explicitEmitCount === ${emitCountBefore}) throw new Error(${JSON.stringify(`[park] foreach ${id}: no authoritative conditional emit guard matched`)});`,
        ]
      : []),
    `  ${receipts}.push({ index: ${index}, key: ${businessKey}, stableKey: ${stableKey}, path: ${locals}._foreachPath, item: ${item}, results: ${localResults}, lastResult: ${localLast} });`,
    `}`,
    `${env.assignTo} = { count: ${receipts}.length, items: ${receipts}, byKey: Object.fromEntries(${receipts}.map((receipt) => [String(receipt.stableKey), receipt])) };`,
  ];
}

/** Render one PlanStep into real executing code lines (indent = 6 spaces base). */
function renderPlanStep(step: PlanStep, opts: { triggers: string[] }): string {
  const id = step.stepId || step.tool || step.kind;
  const deps = (step.dependsOn ?? []).filter(Boolean);
  const trigger = opts.triggers[0] ?? "";
  const scopeExpr = `{ event: { name: ${JSON.stringify(trigger)}, data: $in }, lastResult: last, results, input: $in }`;
  const guards = [
    ...(deps.length ? [`_pass(${JSON.stringify(deps)})`] : []),
    ...(step.kind !== "condition" && step.condition
      ? [`evalCondition(${JSON.stringify(step.condition)}, ${scopeExpr})`]
      : []),
  ];
  const guard = guards.join(" && ");

  let body: string[];
  switch (step.kind) {
    case "condition":
      body = [
        `_cond[${JSON.stringify(id)}] = evalCondition(${JSON.stringify(step.condition ?? "")}, ${scopeExpr});`,
        `results[${JSON.stringify(id)}] = { evaluated: _cond[${JSON.stringify(id)}] };`,
        // #G2 —— 与 ts-function-module 同构：声明了 routes 的条件把判定绑到终态事件上，
        // 否则它算完就被丢弃，路由规则等于不存在。
        ...(step.routes?.onTrue && step.routes.onFalse
          ? [
              `_route = _cond[${JSON.stringify(id)}] ? ${JSON.stringify(step.routes.onTrue)} : ${JSON.stringify(step.routes.onFalse)};`,
            ]
          : []),
      ];
      break;
    case "tool": {
      const toolArgs = renderedToolArguments(step, scopeExpr, "carry()");
      body = [
        ...(toolArgs.legacy
          ? [`// LEGACY WHOLE-CARRY: toolArguments 未声明；只为旧 plan 保留。`]
          : []),
        `last = await (${renderedToolCallback(step, `await ctx.tools.run(${JSON.stringify(step.tool ?? id)}, ${toolArgs.expression})`)})();`,
      ];
      break;
    }
    case "invoke":
      body = [
        `last = await ctx.invoke(${JSON.stringify(step.invoke ?? id)}, _invokePayload({ eventData: $in, invokeInput: ${renderedInvokeInput(step.invokeInput as Record<string, unknown> | undefined, scopeExpr)}, forwardLastResult: ${String(step.forwardLastResult ?? true)}, forwardResults: ${String(step.forwardResults ?? false)}, lastResult: last, results, subject: ctx.subject, correlationId: ctx.correlationId }), { timeoutMs: ${step.timeoutS ? step.timeoutS * 1000 : "undefined"} });`,
      ];
      break;
    case "emit":
      body = codegenEmitLines(step, scopeExpr, "last");
      break;
    case "foreach":
      body = codegenForeachLines(step, trigger);
      break;
    case "logic":
      body = [
        `last = await ctx.reason(SYSTEM_PROMPT + ${JSON.stringify(`\n\n【当前子步骤】${id}${step.description ? `：${step.description}` : ""}`)}, carry());`,
      ];
      break;
    default:
      throw new Error(
        `cannot render unsupported plan step kind: ${(step as { kind?: unknown }).kind ?? "(missing)"}`,
      );
  }

  const tryBlock = [
    `      try {`,
    ...body.map((line) => `        ${line}`),
    `      } catch (e) {`,
    ...codegenFailureLines(step, id, "last").map((line) => `        ${line}`),
    `      }`,
    ...(step.kind === "condition"
      ? []
      : [`      results[${JSON.stringify(id)}] = last;`]),
  ];

  if (!guard)
    return [
      `      // step ${id} (${step.kind})${step.description ? ` — ${step.description.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
      ...tryBlock,
    ].join("\n");
  return [
    `      // step ${id} (${step.kind}) — 依赖: ${deps.join(", ")}`,
    `      if (${guard}) {`,
    ...tryBlock.map((line) => `  ${line}`),
    `      } else {`,
    `        _skipped.add(${JSON.stringify(id)});`,
    `        ctx.log?.("info", ${JSON.stringify(`跳过步骤 ${id}（依赖条件不成立）`)});`,
    `      }`,
  ].join("\n");
}

/**
 * Render a generated spec into a REAL, reviewable agent module.  Semantics the
 * CodeAct socket can own are executable directly; plans requiring per-step
 * durability/typed RPC failures carry a machine-readable declarative_required
 * marker so the probe cannot falsely claim these bytes ran in CodeAct.
 */
export function specToAgentCode(spec: GeneratedAgentSpec): string {
  const exportName =
    camel(spec.short || "agent") +
    (/(agent)$/i.test(spec.short || "") ? "" : "Agent");
  const tools = spec.tools ?? [];
  const emits = spec.emit ?? [];
  const triggers = spec.trigger ?? [];
  const plan = (spec.plan ?? []).filter(Boolean);
  assertCodegenPlan(plan, emits);
  const flattenedPlan = allPlanSteps(plan);
  const declarativeReason =
    generatedSpecExecutionOwnership(spec, undefined).reason ?? null;

  const inName = `${spec.short || "Agent"}Input`;
  const outName = `${spec.short || "Agent"}Output`;
  const ifaces = [
    ioInterface(inName, spec.inputSchema),
    ioInterface(outName, spec.outputSchema),
  ].filter(Boolean);

  const hasConditions = flattenedPlan.some((p) => Boolean(p.condition));
  const hasExactDataflow = planUsesExactDataflow(plan);
  const hasPathRuntime =
    hasConditions ||
    hasExactDataflow ||
    flattenedPlan.some(
      (p) =>
        p.kind === "foreach" ||
        (p.kind === "emit" && Boolean(p.emitPayloadFrom)),
    );
  const hasExplicitEmits =
    flattenedPlan.some((p) => p.kind === "emit") ||
    flattenedPlan.some((p) =>
      p.errorPolicy?.some((rule) => Boolean(rule.emitEvent)),
    );
  const hasConditionalExplicitEmits = flattenedPlan.some(
    (p) => p.kind === "emit" && Boolean(p.condition),
  );
  const hasInvoke = flattenedPlan.some((p) => p.kind === "invoke");
  const hasForeach = flattenedPlan.some((p) => p.kind === "foreach");
  const hasGating =
    hasConditions || flattenedPlan.some((p) => (p.dependsOn ?? []).length > 0);

  // Step body: plan[] wins (each step really executes); otherwise every bound tool is
  // really called in order (soft-continue so the decision core still sees the context).
  const stepLines = plan.length
    ? plan.map((p) => renderPlanStep(p, { triggers })).join("\n")
    : tools.length
      ? tools
          .map((t) =>
            [
              `      try {`,
              `        // LEGACY WHOLE-CARRY: spec 没有 plan/toolArguments；旧绑定工具兼容调用。`,
              `        last = await ctx.tools.run(${JSON.stringify(t)}, carry());`,
              `      } catch (e) {`,
              `        ctx.log?.("warn", ${JSON.stringify(`工具 ${t} 调用失败——记录后继续（决策核心将看到失败上下文）`)}, { error: String(e) });`,
              `        last = { _toolFailed: ${JSON.stringify(t)}, _error: String(e) };`,
              `      }`,
              `      results[${JSON.stringify(t)}] = last;`,
            ].join("\n"),
          )
          .join("\n")
      : "      // (此 agent 不依赖外部工具——纯推理决策)";

  const emitInstr =
    emits.length > 1
      ? `\n只输出 JSON；必须附字段 "emit" 选择产出事件，取值之一：${emits.join(" | ")}；判定失败/拒绝时选失败/拒绝类事件。`
      : "\n只输出 JSON。";

  const emitBlock =
    emits.length <= 1
      ? [
          `      await ctx.emit(${JSON.stringify(emits[0] ?? "DONE")}, { ...carry(), ...decision });`,
        ].join("\n")
      : [
          // #G1/#G19 —— 与 ts-function-module 同构：终态由计算出的判定决定（路由条件优先），
          // LLM 的自由文本 decision.emit 不能改写它；失败事件也绝不复用「最后一个声明事件」，
          // 那会把一次 401 发成对候选人的业务终态。
          `      // 真实事件选择：路由条件优先；否则按 pass/ok 二分（失败走失败形态事件）`,
          `      const _declared = ${JSON.stringify(emits)};`,
          `      const _failed = decision.pass === false || decision.ok === false;`,
          `      let _chosen = _failed ? ${JSON.stringify(failEmitOf(spec))} : _declared[0]!;`,
          `      if (typeof _route === "string" && _declared.includes(_route)) _chosen = _route;`,
          `      await ctx.emit(_chosen, { ...carry(), ...decision });`,
        ].join("\n");

  const finalEmitBlock = hasConditionalExplicitEmits
    ? [
        `      // Ontology-authored conditional emits own routing. No matched guard`,
        `      // is an unresolved/unsafe outcome, never permission to fall back to LLM text.`,
        `      if (_explicitEmitCount === 0 && !_suppressImplicitEmit) {`,
        `        throw new Error("[park] no authoritative conditional emit guard matched");`,
        `      }`,
      ].join("\n")
    : hasExplicitEmits
      ? [
          `      // 显式 emit / errorPolicy intent 是权威输出；没有 intent 且未 suppress 时才走历史隐式终态。`,
          `      if (_explicitEmitCount === 0 && !_suppressImplicitEmit) {`,
          ...emitBlock.split("\n").map((line) => `  ${line}`),
          `      }`,
        ].join("\n")
      : [
          `      if (!_suppressImplicitEmit) {`,
          ...emitBlock.split("\n").map((line) => `  ${line}`),
          `      }`,
        ].join("\n");

  const gatingDecls = hasGating
    ? [
        `      const _cond: Record<string, boolean> = {};`,
        `      const _skipped = new Set<string>();`,
        `      const _pass = (deps: string[]) => deps.every((d) => !_skipped.has(d) && _cond[d] !== false);`,
      ].join("\n")
    : "";

  return [
    `// ${spec.nameZh} — 由 OntoCode 从本体动作 \`${spec.actionName}\`(${spec.domainId})生成。`,
    `// trigger: ${triggers.join(" / ") || "(entry)"} → emit: ${emits.join(" | ") || "(terminal)"}`,
    `// 真实可审查代码：工具调用、条件、foreach、显式 emit 与错误策略均由结构化 spec 渲染。`,
    `// CodeAct 只在执行语义可保真时过探针；需要逐步 durability/typed RPC policy 时 fail-close 到 manifest runtime。`,
    "",
    ...(ifaces.length
      ? [
          `/** Input/Output schema — 依据本体 DataObjects 定义。 */`,
          ifaces.join("\n\n"),
          "",
        ]
      : []),
    ...(hasPathRuntime ? [EVAL_CONDITION_SRC, ""] : []),
    ...(hasExactDataflow ? [PLAN_DATAFLOW_RUNTIME_SRC, ""] : []),
    ...(plan.length ? [ERROR_POLICY_RUNTIME_SRC, ""] : []),
    ...(hasForeach ? [CODEGEN_FOREACH_IDENTITY_SRC, ""] : []),
    ...(hasInvoke ? [CODEGEN_INVOKE_RUNTIME_SRC, ""] : []),
    `/** System prompt — OntoCode 为【这一个】agent 基于本体推理生成。 */`,
    "const SYSTEM_PROMPT = `" + escapeTemplate(spec.systemPrompt ?? "") + "`;",
    "",
    `export const ${exportName} = defineAgent({`,
    `  id: ${JSON.stringify(spec.slug)},`,
    `  name: ${JSON.stringify(spec.short || spec.nameZh)},`,
    `  actor: ${JSON.stringify(spec.hitl ? ["Human"] : ["Agent"])},`,
    `  trigger: ${JSON.stringify(triggers)},`,
    `  emit: ${JSON.stringify(emits)},`,
    `  tools: ${JSON.stringify(tools)},`,
    `  systemPrompt: SYSTEM_PROMPT,`,
    ...(declarativeReason
      ? [
          `  // Fail-closed ownership marker: probeAgentModule keeps this code reviewable but does not`,
          `  // claim CodeAct execution where the worker lacks durable/per-RPC policy semantics.`,
          `  factoryExecutionMode: "declarative_required",`,
          `  factoryExecutionReason: ${JSON.stringify(declarativeReason)},`,
        ]
      : []),
    `  async handler(input, ctx) {`,
    `      const $in = (input ?? {}) as Record<string, unknown>;`,
    `      let last: unknown = undefined;`,
    `      const results: Record<string, unknown> = {};`,
    `      const carry = (): Record<string, unknown> => ({ ...$in, ...(last && typeof last === "object" ? (last as Record<string, unknown>) : {}), results: { ...results } });`,
    `      let _explicitEmitCount = 0;`,
    `      let _suppressImplicitEmit = false;`,
    // #G2 —— 路由条件选中的终态事件。
    `      let _route: string | undefined = undefined;`,
    ...(gatingDecls ? [gatingDecls] : []),
    stepLines,
    `      // 决策核心（fail-close）：LLM 不可用/失败时绝不伪造通过`,
    `      const decision = (await ctx.reason(SYSTEM_PROMPT + ${JSON.stringify(emitInstr)}, { input: $in, lastResult: last, results })) as Record<string, unknown>;`,
    `      if (decision._reasonFailed === true) throw new Error("决策核心失败（LLM 不可用）——fail-close，不伪造通过");`,
    finalEmitBlock,
    `      return { ok: decision.pass !== false && decision.ok !== false, lastResult: last, results };`,
    `  },`,
    `});`,
    "",
  ].join("\n");
}
