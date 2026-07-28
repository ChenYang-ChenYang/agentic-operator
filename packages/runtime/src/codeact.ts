/**
 * Execute an Agent-Factory generated `defineAgent` handler through the
 * one-shot container isolation kernel.
 *
 * The host owns every stateful capability. Generated code receives a real
 * AgentRuntime-shaped socket, but reason/tool/memory/invoke/spawn cross an
 * explicit RPC bridge; the handler itself never runs on the host event loop.
 * Production execution is denied unless the caller supplies an opt-in flag
 * and an exact SHA-256 attestation for the code bytes being executed.
 */

import { createHash } from "node:crypto";
import type { MemoryHandle, SpawnResult } from "@agentic/agent-sdk";
import {
  globalToolExecutionPolicy,
  globalToolRegistry,
  isToolExecutionPolicy,
  toolExecutionPoliciesEqual,
  type ToolExecutionPolicy,
} from "@agentic/tools";
import {
  codeActExecutionGate,
  type CodeActRpcMethod,
} from "./codeact-worker";
import {
  executeCodeActContainer,
  type CodeActContainerExecutionEvidence,
  type CodeActContainerFailure,
  type CodeActDockerTransport,
} from "./codeact-container";
import {
  executeProductionCodeActRemote,
  productionCodeActRemoteEnabled,
} from "./codeact-remote";
import { getRuntimeGateway } from "./llm-host";
import {
  cassetteLookup,
  factorySandboxDispatchDecision,
  gatedToolMarker,
  isSandboxTenant,
  recordFactorySandboxLocalDispatch,
  replayFactorySandboxTool,
  sandboxToolMode,
  sandboxToolStub,
  toolDispatchDecision,
  type FactorySandboxDispatchReceipt,
  type FactorySandboxExecutionScope,
  type FactorySandboxReplayRef,
} from "./sandbox-mode";
import type { CodeActAttestationStatus } from "./codeact-receipt";

type Emit = { event: string; payload: Record<string, unknown> };
type SpawnedSubAgent = {
  task: string;
  code: string;
  ok?: boolean;
  durationMs?: number;
  depth?: number;
};

const MAX_SUBAGENT_DEPTH = Number(process.env.FACTORY_SUBAGENT_MAX_DEPTH) || 2;
const SPAWN_REVIEW_TRIES = Number(process.env.FACTORY_SPAWN_REVIEW_TRIES) || 2;

const DANGEROUS_API =
  /\b(child_process|require\(['"]fs['"]\)|require\(['"]net['"]\)|require\(['"]http['"]\)|require\(['"]https['"]\)|require\(['"]dns['"]\)|require\(['"]os['"]\)|import\s+[^;]*['"](?:fs|net|http|https|dns|os|child_process)['"]|process\.(exit|kill|binding)|eval\(|new\s+Function\(|globalThis\.|__proto__|constructor\s*\[)/;
const FORBIDDEN_SPAWN_MODULES = new Set([
  "child_process",
  "fs",
  "net",
  "dgram",
  "tls",
  "http",
  "https",
  "http2",
  "dns",
  "vm",
  "worker_threads",
  "cluster",
  "os",
  "inspector",
  "v8",
  "repl",
  "module",
  "process",
]);

function normalizeModuleSpecifier(specifier: string): string {
  let normalized = specifier.trim();
  if (normalized.startsWith("node:")) normalized = normalized.slice(5);
  return normalized.split("/")[0] ?? normalized;
}

async function lintSpawnCode(
  code: string,
): Promise<{ ok: boolean; violations: string[] }> {
  const violations: string[] = [];
  let astViolations: string[] | null = null;
  try {
    const ts = await Promise.race([
      import("typescript"),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("typescript import timeout")),
          5_000,
        );
        timer.unref?.();
      }),
    ]);
    const source = ts.createSourceFile(
      "__spawn__.ts",
      code,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const found = new Set<string>();
    const checkModule = (specifier: string) => {
      const base = normalizeModuleSpecifier(specifier);
      if (FORBIDDEN_SPAWN_MODULES.has(base)) found.add(`危险模块 ${base}`);
    };
    const visit = (node: import("typescript").Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        checkModule(node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        checkModule(node.moduleReference.expression.text);
      } else if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const first = node.arguments[0];
        if (ts.isIdentifier(expression) && expression.text === "require") {
          if (first && ts.isStringLiteral(first)) checkModule(first.text);
          else found.add("动态 require()");
        } else if (expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (first && ts.isStringLiteral(first)) checkModule(first.text);
          else found.add("动态 import()");
        } else if (ts.isIdentifier(expression) && expression.text === "eval") {
          found.add("eval()");
        } else if (
          ts.isIdentifier(expression) &&
          expression.text === "Function"
        ) {
          found.add("Function()");
        } else if (
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === "process" &&
          ["exit", "kill", "abort", "binding", "dlopen"].includes(
            expression.name.text,
          )
        ) {
          found.add(`process.${expression.name.text}`);
        }
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Function"
      ) {
        found.add("new Function()");
      } else if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "__proto__"
      ) {
        found.add("__proto__ 访问");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    astViolations = [...found];
  } catch {
    astViolations = null;
  }

  if (astViolations) {
    for (const violation of astViolations)
      violations.push(`危险 API：${violation}`);
  } else {
    const match = code.match(DANGEROUS_API);
    if (match) violations.push(`危险 API：${match[0].slice(0, 40)}`);
  }
  if (!/defineAgent|handler\s*\(/.test(code))
    violations.push("没有 defineAgent/handler 结构");
  return { ok: violations.length === 0, violations };
}

async function generateSubAgentCode(
  task: string,
  options: {
    tools?: string[];
    tenantSlug?: string;
    tenantId?: string;
    agentName?: string;
    runId?: string;
  },
): Promise<string | null> {
  const gateway = getRuntimeGateway();
  if (!gateway || !task.trim()) return null;
  if (!options.tenantId) {
    throw new Error(
      "CodeAct sub-agent generation requires tenantId for budget enforcement",
    );
  }
  const system =
    "你为一个正在运行的 agent 生成一个子 agent TypeScript 处理器。" +
    "只输出完整 defineAgent 代码；可使用 ctx.reason、ctx.tool、ctx.emit，最后返回对象。";
  const user = `子任务：${task}\n可用工具：${options.tools?.join("、") || "（以 ctx.reason 为主）"}`;
  const response = await gateway.chat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tenantSlug: options.tenantSlug,
    tenantId: options.tenantId,
    runId: options.runId,
    purpose: `agent:${options.agentName ?? "codeact"}/codeact:spawn`,
  });
  const fenced = response.text.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/);
  const code = (fenced ? fenced[1] : response.text) ?? "";
  return code.includes("defineAgent") ? code : null;
}

async function runSandboxTool(
  name: string,
  tenantSlug: string | undefined,
  args: unknown,
  declaredPolicy: ToolExecutionPolicy | undefined,
  sandboxProfileVerified: boolean,
  hostRuntimeKind: "live" | "fixture",
  factoryExecutionScope: FactorySandboxExecutionScope | { kind: "production" } | undefined,
  factoryReplayRef: FactorySandboxReplayRef | undefined,
  recordDispatch: (dispatch: GeneratedCodeToolDispatch) => void,
  liveHandler?: (name: string, args?: unknown) => Promise<unknown>,
): Promise<unknown> {
  const catalogPolicy = globalToolExecutionPolicy(name);
  if (catalogPolicy && declaredPolicy && !toolExecutionPoliciesEqual(catalogPolicy, declaredPolicy)) {
    throw new Error(
      `tool '${name}' execution policy conflicts with current reviewed registry metadata`,
    );
  }
  const reviewedPolicy = catalogPolicy ?? declaredPolicy;
  if (!isToolExecutionPolicy(reviewedPolicy)) {
    throw new Error(`tool '${name}' is missing valid reviewed execution_policy metadata`);
  }
  if (hostRuntimeKind === "fixture") {
    if (!liveHandler) throw new Error(`fixture tool '${name}' has no host fixture binding`);
    recordDispatch({ tool: name, kind: "fixture" });
    return liveHandler(name, args);
  }
  const factoryDecision = factorySandboxDispatchDecision(
    reviewedPolicy,
    tenantSlug,
    factoryExecutionScope,
  );
  const decision = factoryDecision ?? toolDispatchDecision(
    reviewedPolicy,
    sandboxToolMode(),
    { sandboxProfileVerified },
  );
  if (decision === "reject") {
    throw new Error(`tool '${name}' is missing valid reviewed execution_policy metadata`);
  }
  if (factoryDecision === "replay") {
    if (!tenantSlug || !factoryExecutionScope || factoryExecutionScope.kind !== "sandbox") {
      throw new Error(`factory sandbox replay scope is missing for CodeAct tool '${name}'`);
    }
    const replay = await replayFactorySandboxTool({
      scope: factoryExecutionScope,
      tenantSlug,
      toolName: name,
      toolArgs: args,
      policy: reviewedPolicy,
      replayRef: factoryReplayRef,
    });
    recordDispatch({ tool: name, kind: "replay", receipt: replay.receipt });
    return replay.body;
  }
  if (decision === "gate_profile") {
    recordDispatch({ tool: name, kind: "gated_profile" });
    return gatedToolMarker(name, args, "sandbox_profile");
  }
  if (decision === "gate_grant") {
    recordDispatch({ tool: name, kind: "gated_grant" });
    return gatedToolMarker(name, args, "requires_attempt_grant");
  }
  if (decision === "live") {
    if (factoryDecision === "live") {
      if (!tenantSlug || !factoryExecutionScope || factoryExecutionScope.kind !== "sandbox") {
        throw new Error(`factory sandbox local scope is missing for CodeAct tool '${name}'`);
      }
      const receipt = await recordFactorySandboxLocalDispatch({
        scope: factoryExecutionScope,
        tenantSlug,
        toolName: name,
        toolArgs: args,
        policy: reviewedPolicy,
      });
      recordDispatch({ tool: name, kind: "sandbox_local", receipt });
    } else {
      recordDispatch({ tool: name, kind: "live" });
    }
    if (liveHandler) return liveHandler(name, args);
    const tool = globalToolRegistry.get(name);
    if (!tool) throw new Error(`CodeAct tool '${name}' is not registered`);
    const response = await tool.handler({
      agentName: "codeact",
      actionName: name,
      correlationId: "sandbox",
      tenantSlug: tenantSlug ?? "",
      event: {
        name: "codeact",
        data:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : { value: args },
      },
    } as never);
    return (response as { data?: unknown })?.data ?? response;
  }
  if (decision === "replay" && tenantSlug) {
    recordDispatch({ tool: name, kind: "replay" });
    const replay = await cassetteLookup(tenantSlug, name, args);
    if (replay !== undefined) return replay;
    throw new Error(`No replay cassette exists for CodeAct tool '${name}'`);
  }
  if (decision === "stub") {
    recordDispatch({ tool: name, kind: "stub" });
    return sandboxToolStub(name);
  }
  throw new Error(
    `CodeAct tool '${name}' cannot run without a tenant replay scope`,
  );
}

/** Host-side capabilities reachable through worker RPC. */
export interface GeneratedCodeHostRuntime {
  reason?(systemPrompt: string, input: unknown): Promise<unknown>;
  tool?(name: string, args?: unknown): Promise<unknown>;
  invoke?(
    agentRef: string,
    input?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  spawn?(
    task: string,
    input?: unknown,
    options?: { tools?: string[] },
  ): Promise<SpawnResult>;
  log?(level: "info" | "warn" | "error", message: string, data?: unknown): void;
}

/** Non-sandbox execution requires both fields and an exact digest match. */
export interface GeneratedCodeProductionPolicy {
  allowProduction?: boolean;
  expectedCodeSha256?: string;
  /** Immutable promotion provenance bound into the remote executor request. */
  promotionVersionId?: string;
  regressionSuiteFingerprint?: string;
}

export interface RunGeneratedCodeOptions {
  systemPrompt?: string;
  tenantSlug?: string;
  /** Internal tenant id paired with tenantSlug. Required whenever the default
   * CodeAct host invokes the LLM so budget and telemetry scope cannot be bypassed. */
  tenantId?: string;
  agentName?: string;
  correlationId?: string;
  subject?: string;
  memory?: MemoryHandle;
  runId?: string;
  timeoutMs?: number;
  memoryMb?: number;
  production?: GeneratedCodeProductionPolicy;
  hostRuntime?: GeneratedCodeHostRuntime;
  /** Server-owned host classification. `fixture` is for exact regression
   * artifacts: it invokes the supplied deterministic host adapter but records
   * the call as fixture evidence, never as a live integration. */
  hostRuntimeKind?: "live" | "fixture";
  /** Trusted caller purpose. Regression replay may use fixture RPC while the
   * exact code still runs on the production remote container plane. */
  executionPurpose?: "runtime" | "regression_replay";
  /** Immutable tool capability set copied from the reviewed manifest/spec.
   * Generated code is denied by default when this field is absent or empty;
   * callers must never derive it from code-controlled spawn/tool arguments. */
  allowedTools?: readonly string[];
  /** Side-effect metadata paired with allowedTools. Unknown entries fail
   * closed at the sandbox boundary. */
  toolPolicies?: Readonly<Record<string, ToolExecutionPolicy>>;
  /** Tool names whose config provenance is an independent sandbox profile.
   * This list is supplied by the host from immutable manifest metadata. */
  sandboxProfileVerifiedTools?: readonly string[];
  /** Exact nonce-attempt identity and its per-tool cassette hashes. These are
   * ignored for production and mandatory for external Factory sandbox calls. */
  factoryExecutionScope?: FactorySandboxExecutionScope | { kind: "production" };
  factoryToolReplayRefs?: Readonly<Record<string, FactorySandboxReplayRef>>;
  /** Internal recursion depth for reviewed sandbox sub-agents. */
  _depth?: number;
  /** Trusted executor injection seam for focused tests. Production callers do
   * not set this and use the workload's Docker socket transport. */
  containerTransport?: CodeActDockerTransport;
  /** Server-owned exact candidate image override. Normal deployments resolve
   * FACTORY_CODEACT_CANDIDATE_IMAGE instead. */
  candidateImage?: string;
}

export type GeneratedCodeFailure =
  | "execution_disabled"
  | "isolation_not_allowed"
  | "empty_code"
  | "production_not_authorized"
  | "attestation_missing"
  | "attestation_mismatch"
  | "memory_required"
  | CodeActContainerFailure;

export interface GeneratedCodeToolDispatch {
  tool: string;
  kind: "live" | "fixture" | "replay" | "stub" | "gated_profile" | "gated_grant" | "sandbox_local";
  receipt?: FactorySandboxDispatchReceipt;
}

interface GeneratedCodeTelemetry {
  isolation: "isolated_container";
  codeSha256: string;
  durationMs: number;
  productionAttested: boolean;
  /** True only after Docker started the one-shot container for these bytes. */
  executorStarted: boolean;
  /** Exit/removal evidence authored by the trusted container executor. */
  containerEvidence?: CodeActContainerExecutionEvidence;
  /** Exact result of the runtime attestation gate. */
  attestation: CodeActAttestationStatus;
  /** Host-observed tool boundary classifications for evidence grading. */
  toolDispatches: GeneratedCodeToolDispatch[];
}

export type GeneratedCodeExecutionResult =
  | (GeneratedCodeTelemetry & {
      ok: true;
      data: Record<string, unknown>;
      emitted: Emit[];
      spawnedSubAgents?: SpawnedSubAgent[];
    })
  | (GeneratedCodeTelemetry & {
      ok: false;
      failure: GeneratedCodeFailure;
      error: string;
      timedOut?: boolean;
      crashed?: boolean;
    });

function codeDigest(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function asFinitePositive(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  return Number.isFinite(value) && (value ?? 0) >= minimum
    ? Math.floor(value!)
    : fallback;
}

/**
 * Structured generated-code execution API used by the step engine. Every
 * denial and worker/RPC failure retains a concrete reason and telemetry.
 */
export async function runGeneratedCodeIsolated(
  code: string,
  input: Record<string, unknown>,
  options: RunGeneratedCodeOptions = {},
): Promise<GeneratedCodeExecutionResult> {
  const started = Date.now();
  const codeSha256 = codeDigest(code ?? "");
  const tenantSlug = options.tenantSlug ?? "";
  const sandbox = !tenantSlug || isSandboxTenant(tenantSlug);
  const toolDispatches: GeneratedCodeToolDispatch[] = [];
  const initialAttestation: CodeActAttestationStatus = sandbox
    ? "sandbox_not_required"
    : "not_checked";
  const base = (
    attestation: CodeActAttestationStatus,
    executorStarted = false,
    durationMs = Date.now() - started,
    containerEvidence?: CodeActContainerExecutionEvidence,
  ): GeneratedCodeTelemetry => ({
    isolation: "isolated_container",
    codeSha256,
    durationMs,
    productionAttested: attestation === "production_verified",
    executorStarted,
    ...(containerEvidence ? { containerEvidence } : {}),
    attestation,
    toolDispatches: [...toolDispatches],
  });
  const deny = (
    failure: GeneratedCodeFailure,
    error: string,
    attestation: CodeActAttestationStatus = initialAttestation,
  ): GeneratedCodeExecutionResult => ({
    ok: false,
    failure,
    error,
    ...base(attestation),
  });

  // This call path is hard-wired to the one-shot container implementation.
  // The legacy worker/vm helper remains available only as a permanently
  // non-promotable diagnostic and can never reach this attestation path.
  const remoteProduction = !sandbox && productionCodeActRemoteEnabled();
  if (
    !sandbox
    && options.hostRuntimeKind === "fixture"
    && options.executionPurpose !== "regression_replay"
  ) {
    return deny(
      "production_not_authorized",
      "fixture host runtime is sandbox/regression-only",
      "not_authorized",
    );
  }
  if (!code || code.trim().length < 20) {
    return deny("empty_code", "generated agent code is empty or too short");
  }

  const expected = options.production?.expectedCodeSha256?.trim().toLowerCase();
  if (!sandbox) {
    if (options.production?.allowProduction !== true) {
      return deny(
        "production_not_authorized",
        "production generated-code execution requires allowProduction=true",
        "not_authorized",
      );
    }
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
      return deny(
        "attestation_missing",
        "production generated-code execution requires expectedCodeSha256",
        "missing",
      );
    }
    if (expected !== codeSha256) {
      return deny(
        "attestation_mismatch",
        `generated-code SHA-256 mismatch (expected ${expected}, actual ${codeSha256})`,
        "mismatch",
      );
    }
  } else if (expected && expected !== codeSha256) {
    // Optional sandbox attestations remain meaningful: once supplied they
    // cannot silently point at different bytes.
    return deny(
      "attestation_mismatch",
      `generated-code SHA-256 mismatch (expected ${expected}, actual ${codeSha256})`,
      "mismatch",
    );
  }
  const verifiedAttestation: CodeActAttestationStatus = sandbox
    ? expected
      ? "sandbox_verified"
      : "sandbox_not_required"
    : "production_verified";

  // Evaluate immutable production authorization before infrastructure
  // readiness. Otherwise an unattested legacy manifest is misleadingly
  // reported as a temporary executor outage and may be retried forever.
  if (!remoteProduction) {
    const executionGate = codeActExecutionGate("isolated_container");
    if (!executionGate.allowed) {
      return deny(
        executionGate.failure,
        executionGate.reason,
        "not_authorized",
      );
    }
  }

  if (process.env.NODE_ENV !== "test" && !options.memory) {
    return deny(
      "memory_required",
      "durable memory is required outside isolated unit tests",
      verifiedAttestation,
    );
  }

  const ephemeral = new Map<string, unknown>();
  const memory: MemoryHandle = options.memory ?? {
    async get<T = unknown>(key: string, scope = "run"): Promise<T | null> {
      const composite = `${scope}:${key}`;
      return ephemeral.has(composite) ? (ephemeral.get(composite) as T) : null;
    },
    async put<T = unknown>(
      key: string,
      value: T,
      scope = "run",
    ): Promise<void> {
      ephemeral.set(`${scope}:${key}`, value);
    },
    async delete(key: string, scope = "run"): Promise<void> {
      ephemeral.delete(`${scope}:${key}`);
    },
    async search(): Promise<never[]> {
      return [];
    },
  };

  const spawnedSubAgents: SpawnedSubAgent[] = [];
  const bubbledEmits: Emit[] = [];
  const allowedTools = new Set(
    (options.allowedTools ?? []).map((name) => name.trim()).filter(Boolean),
  );
  const assertToolAllowed = (name: string): void => {
    if (allowedTools.has(name)) return;
    const declared = [...allowedTools].sort();
    throw new Error(
      `[generated_tool_not_declared] 生成 Agent「${options.agentName ?? "codeact"}」请求了未在不可变 manifest/spec 中声明并配置的工具「${name}」；已拒绝执行。允许工具：${declared.length ? declared.join("、") : "（无）"}`,
    );
  };

  const spawn = async (
    task: string,
    spawnInput?: unknown,
    spawnOptions?: { tools?: string[] },
  ): Promise<SpawnResult> => {
    if (!sandbox) {
      return {
        ok: false,
        error:
          "spawn is not enabled for attested production handlers; use invoke",
      };
    }
    const depth = options._depth ?? 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return {
        ok: false,
        error: `达到子 agent 最大嵌套深度(${MAX_SUBAGENT_DEPTH})`,
      };
    }

    const childAllowedTools = [
      ...new Set(
        (spawnOptions?.tools ?? []).map((name) => name.trim()).filter(Boolean),
      ),
    ];
    const escalated = childAllowedTools.filter(
      (name) => !allowedTools.has(name),
    );
    if (escalated.length) {
      return {
        ok: false,
        error: `[generated_tool_not_declared] 子 Agent 请求了父 Agent 未获审查的工具：${escalated.join("、")}`,
      };
    }
    // A custom host is still behind the parent's immutable capability set;
    // it is an execution adapter, not an authorization boundary.
    if (options.hostRuntime?.spawn) {
      return options.hostRuntime.spawn(task, spawnInput, {
        ...spawnOptions,
        tools: childAllowedTools,
      });
    }

    let generated: string | null = null;
    let lastIssue = "";
    let lastCode = "";
    for (let attempt = 0; attempt < SPAWN_REVIEW_TRIES; attempt++) {
      const feedback = lastIssue
        ? `\n\n【上一次生成（已驳回）】：\n${lastCode.slice(0, 1_500)}\n【驳回原因】：${lastIssue}\n请针对性修正。`
        : "";
      try {
        const candidate = await generateSubAgentCode(
          `${String(task ?? "")}${feedback}`,
          {
            tools: spawnOptions?.tools,
            tenantSlug,
            tenantId: options.tenantId,
            agentName: options.agentName,
            runId: options.runId,
          },
        );
        if (!candidate) {
          lastIssue = "代码生成返回了无效 handler";
          continue;
        }
        lastCode = candidate;
        const lint = await lintSpawnCode(candidate);
        if (!lint.ok) {
          lastIssue = lint.violations.join("；");
          continue;
        }
        generated = candidate;
        break;
      } catch (error) {
        lastIssue = `代码生成失败：${String((error as Error)?.message ?? error).slice(0, 200)}`;
      }
    }
    if (!generated)
      return { ok: false, error: `子 agent 未通过审查（${lastIssue}）` };

    const spawnStarted = Date.now();
    const entry: SpawnedSubAgent = {
      task: String(task ?? ""),
      code: generated,
      depth: depth + 1,
    };
    spawnedSubAgents.push(entry);
    const child = await runGeneratedCodeIsolated(
      generated,
      (spawnInput ?? input) as Record<string, unknown>,
      {
        ...options,
        production: undefined,
        allowedTools: childAllowedTools,
        toolPolicies: Object.fromEntries(
          childAllowedTools
            .map((name) => [name, options.toolPolicies?.[name]] as const)
            .filter((entry): entry is readonly [string, ToolExecutionPolicy] => !!entry[1]),
        ),
        sandboxProfileVerifiedTools: childAllowedTools.filter((name) =>
          options.sandboxProfileVerifiedTools?.includes(name)),
        _depth: depth + 1,
      },
    );
    entry.ok = child.ok;
    entry.durationMs = Date.now() - spawnStarted;

    if (options.runId) {
      // A parent run id turns spawn trace persistence into required evidence.
      const { getDb, steps } = await import("@agentic/db");
      const { makeId } = await import("@agentic/shared");
      getDb()
        .insert(steps)
        .values({
          id: makeId("stp"),
          runId: options.runId,
          ord: 900 + spawnedSubAgents.length,
          name: `spawn:${entry.task.slice(0, 60)}`,
          type: "subflow",
          status: child.ok ? "ok" : "failed",
          startedAt: new Date(spawnStarted),
          endedAt: new Date(),
          durationMs: entry.durationMs,
        })
        .run();
    }

    if (!child.ok) return { ok: false, error: child.error, code: generated };
    bubbledEmits.push(...child.emitted);
    spawnedSubAgents.push(...(child.spawnedSubAgents ?? []));
    return {
      ok: true,
      data: child.data,
      emitted: child.emitted,
      code: generated,
    };
  };

  const hostRuntime = options.hostRuntime;
  const onRpc = async (
    method: CodeActRpcMethod,
    args: unknown[],
  ): Promise<unknown> => {
    switch (method) {
      case "reason": {
        const systemPrompt =
          typeof args[0] === "string" ? args[0] : (options.systemPrompt ?? "");
        const reasonInput = args[1];
        if (hostRuntime?.reason)
          return hostRuntime.reason(systemPrompt, reasonInput);
        const gateway = getRuntimeGateway();
        if (!gateway) throw new Error("LLM gateway is not configured");
        if (!options.tenantId) {
          throw new Error(
            "CodeAct LLM reasoning requires tenantId for budget enforcement",
          );
        }
        const response = await gateway.chat({
          messages: [
            {
              role: "system",
              content: systemPrompt || options.systemPrompt || "",
            },
            { role: "user", content: JSON.stringify(reasonInput ?? {}) },
          ],
          tenantSlug: options.tenantSlug,
          tenantId: options.tenantId,
          runId: options.runId,
          purpose: `agent:${options.agentName ?? "codeact"}/codeact:reason`,
        });
        try {
          return JSON.parse(response.text) as unknown;
        } catch {
          return {
            ok: false,
            _reasonFailed: true,
            error: "llm_unstructured_response",
            rawText: response.text.slice(0, 500),
          };
        }
      }
      case "tool": {
        const name = args[0];
        if (typeof name !== "string" || !name.trim())
          throw new Error("tool name is required");
        assertToolAllowed(name);
        const toolInput = args[1] ?? input;
        if (!sandbox) {
          if (hostRuntime?.tool) return hostRuntime.tool(name, toolInput);
          throw new Error(`production tool '${name}' has no host binding`);
        }
        return runSandboxTool(
          name,
          options.tenantSlug,
          toolInput,
          options.toolPolicies?.[name],
          options.sandboxProfileVerifiedTools?.includes(name) === true,
          options.hostRuntimeKind ?? "live",
          options.factoryExecutionScope,
          options.factoryToolReplayRefs?.[name],
          (dispatch) => toolDispatches.push(dispatch),
          hostRuntime?.tool,
        );
      }
      case "memory.get":
        return memory.get(String(args[0] ?? ""), args[1] as never);
      case "memory.put":
        await memory.put(String(args[0] ?? ""), args[1], args[2] as never);
        return null;
      case "memory.delete":
        await memory.delete(String(args[0] ?? ""), args[1] as never);
        return null;
      case "memory.search":
        return memory.search(String(args[0] ?? ""), Number(args[1] ?? 5));
      case "invoke": {
        const agentRef = args[0];
        if (typeof agentRef !== "string" || !agentRef.trim())
          throw new Error("invoke agentRef is required");
        const invokeOptions =
          args[2] && typeof args[2] === "object" && !Array.isArray(args[2])
            ? (args[2] as { timeoutMs?: unknown })
            : {};
        if (
          invokeOptions.timeoutMs !== undefined &&
          (typeof invokeOptions.timeoutMs !== "number" ||
            !Number.isFinite(invokeOptions.timeoutMs) ||
            invokeOptions.timeoutMs <= 0)
        ) {
          throw new Error("invoke timeoutMs must be a positive finite number");
        }
        const timeoutMs = invokeOptions.timeoutMs as number | undefined;
        const operation = async (): Promise<unknown> => {
          if (hostRuntime?.invoke)
            return hostRuntime.invoke(agentRef, args[1], { timeoutMs });
          // No host binding means no child to call — in the sandbox exactly as
          // in production. The sandbox used to fall through to
          // `spawn("执行 <ref>", …)`, i.e. it asked an LLM to improvise an agent
          // that does whatever the ref is named, and returned that as if the
          // real child had answered. Sandbox evidence is what gates promotion,
          // so a hallucinated stand-in could certify a working child that does
          // not exist. An unbound invoke must fail, and fail identically in
          // both environments — otherwise the sandbox is not testing the thing
          // that will run.
          throw new Error(
            `invoke '${agentRef}' has no durable host binding`,
          );
        };
        if (timeoutMs === undefined) return operation();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`invoke '${agentRef}' exceeded timeout (${timeoutMs}ms)`)),
                timeoutMs,
              );
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      case "spawn":
        return spawn(
          String(args[0] ?? ""),
          args[1],
          args[2] as { tools?: string[] } | undefined,
        );
    }
  };

  const timeoutMs = asFinitePositive(
    options.timeoutMs ?? Number(process.env.FACTORY_CODEACT_TIMEOUT_MS),
    120_000,
    50,
  );
  const memoryMb = asFinitePositive(
    options.memoryMb ?? Number(process.env.FACTORY_CODEACT_MEMORY_MB),
    128,
    16,
  );
  const executionOptions = {
    timeoutMs,
    memoryMb,
    cpus: Number(process.env.FACTORY_CODEACT_CPUS) || 1,
    pidsLimit: Number(process.env.FACTORY_CODEACT_PIDS_LIMIT) || 64,
    onRpc,
  };
  const container = remoteProduction
    ? await executeProductionCodeActRemote({
        code,
        data: input,
        ...executionOptions,
        identity: {
          tenantId: options.tenantId ?? "",
          tenantSlug,
          runId: options.runId ?? "",
          agentName: options.agentName ?? "codeact",
          correlationId: options.correlationId ?? "",
          subject: options.subject
            ?? (typeof input._subject === "string" ? input._subject : undefined),
          promotionVersionId: options.production?.promotionVersionId ?? "",
          regressionSuiteFingerprint:
            options.production?.regressionSuiteFingerprint ?? "",
          codeSha256,
        },
      })
    : await executeCodeActContainer(code, input, {
        ...executionOptions,
        image: options.candidateImage,
        attemptId: options.factoryExecutionScope?.kind === "sandbox"
          ? options.factoryExecutionScope.attempt_id
          : undefined,
        identity: {
          agentName: options.agentName ?? "codeact",
          tenantSlug,
          correlationId:
            options.correlationId ?? (sandbox ? "sandbox" : "production"),
          subject:
            options.subject ??
            (typeof input._subject === "string" ? input._subject : undefined),
        },
        transport: options.containerTransport,
        onLog(level, message, data) {
          if (hostRuntime?.log) {
            hostRuntime.log(level, message, data);
            return;
          }
          try {
            (console[level] ?? console.log)(
              `[codeact:${options.agentName ?? "generated"}] ${message}`,
              data ?? "",
            );
          } catch {
            /* observability is best-effort */
          }
        },
      });

  if (!container.ok) {
    return {
      ok: false,
      failure: container.failure,
      error: container.error,
      timedOut: container.timedOut,
      crashed: container.crashed,
      ...base(
        verifiedAttestation,
        container.executorStarted,
        container.durationMs,
        container.evidence,
      ),
    };
  }
  const emitted = [...container.emitted, ...bubbledEmits];
  const data = emitted[0]
    ? { ...container.result, _emit: emitted[0].event }
    : container.result;
  return {
    ok: true,
    data,
    emitted,
    ...(spawnedSubAgents.length ? { spawnedSubAgents } : {}),
    ...base(
      verifiedAttestation,
      true,
      container.durationMs,
      container.evidence,
    ),
  };
}

/**
 * Backward-compatible sandbox API. The step engine uses the structured API;
 * direct callers still receive success-or-null, with every failure logged.
 */
export async function runGeneratedCode(
  code: string,
  input: Record<string, unknown>,
  options: RunGeneratedCodeOptions = {},
): Promise<{
  data: Record<string, unknown>;
  emitted: Emit[];
  spawnedSubAgents?: SpawnedSubAgent[];
  isolation: "isolated_container";
  codeSha256: string;
  durationMs: number;
  productionAttested: boolean;
} | null> {
  const result = await runGeneratedCodeIsolated(code, input, options);
  if (!result.ok) {
    try {
      console.warn(
        `[codeact:${result.failure}] ${result.error} (sha256=${result.codeSha256}, isolation=${result.isolation})`,
      );
    } catch {
      /* logging is best-effort */
    }
    return null;
  }
  return {
    data: result.data,
    emitted: result.emitted,
    ...(result.spawnedSubAgents
      ? { spawnedSubAgents: result.spawnedSubAgents }
      : {}),
    isolation: result.isolation,
    codeSha256: result.codeSha256,
    durationMs: result.durationMs,
    productionAttested: result.productionAttested,
  };
}
