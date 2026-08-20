import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  ToolContext,
  ToolDescriptor,
  ToolWriteProbeLifecycle,
  ToolWriteProbeExecutionContext,
  ToolWriteProbeLifecycleInput,
} from "@agentic/agent-kit";
import { canonicalEvidenceJson, catalogToolDefinitionHash, declarativeToolDefinitionHash, type DeclarativeProbeObservedEvidence, type DeclarativeTool } from "@agentic/agent-factory";
export { declarativeToolDefinitionHash };
import {
  DeclarativeToolExecutionError,
  makeDeclarativeTool,
  isToolExecutionPolicy,
  validateToolSchema,
  type ToolCatalogEntry,
  type DeclarativeToolFailureKind,
  type DeclarativeObservedExchange,
} from "@agentic/tools";
import {
  makeToolCassetteEntry,
  stableJson,
  type CanonicalCassetteDocument,
  type WriteProbeCassetteProof,
} from "@agentic/shared/cassette";
import {
  inspectWriteProbeSafety,
  isWriteCapableSideEffect,
  prepareWriteProbeCanary,
  readProbeResultPath,
  type PreparedWriteProbeCanary,
  type WriteProbeSafetyContract,
} from "@agentic/shared";

/** Backwards-compatible API-local names; the executable contract is defined
 * next to code-owned ToolDescriptor rather than model-authored metadata. */
export type WriteProbeLifecycleInput = ToolWriteProbeLifecycleInput;
export type WriteProbeLifecycle = ToolWriteProbeLifecycle;

export interface IntegrationProbeRequest {
  tool: DeclarativeTool;
  args: Record<string, unknown>;
  config?: Record<string, unknown>;
  tenantSlug: string;
  authorization?: { actor: string; allowSideEffects: boolean };
  fetchFn?: typeof fetch;
  dataRoot?: string;
  persistCassette?: boolean;
  canarySeed?: string;
  writeProbeLifecycle?: WriteProbeLifecycle;
}

export interface IntegrationProbeResult {
  verified: boolean;
  toolName: string;
  definitionHash: string;
  schemaHash: string;
  classification:
    | "verified"
    | "authorization_required"
    | "needs_config"
    | "idempotency_unverified"
    | "cleanup_failed"
    | "absence_proof_failed"
    | DeclarativeToolFailureKind
    | "unknown";
  status?: number;
  durationMs: number;
  error?: string;
  cassette?: CanonicalCassetteDocument;
  cassettePath?: string;
  observedEvidence?: DeclarativeProbeObservedEvidence;
  next?: "ask_user";
  missing?: string[];
  writeProbeProof?: WriteProbeCassetteProof;
}

export interface GlobalIntegrationProbeRequest {
  catalog: ToolCatalogEntry;
  descriptor: ToolDescriptor;
  args: Record<string, unknown>;
  config?: Record<string, unknown>;
  tenantSlug: string;
  authorization?: { actor: string; allowSideEffects: boolean };
  dataRoot?: string;
  persistCassette?: boolean;
  canarySeed?: string;
  writeProbeLifecycle?: WriteProbeLifecycle;
}

const hash = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");

/** Signed sentinel used only when the declared idempotency receipt/argument
 * could not be observed. Production authorization rejects this exact digest;
 * keeping it protocol-owned here prevents verifier/producer drift. */
export const UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH = hash({
  value: "[UNVERIFIED]",
});

/**
 * Integration probes need a tenant-scoped context/cassette namespace, but they
 * are not Inngest sandbox applications.  In particular, never manufacture a
 * plain `<tenant>-sb` slug here: runtime sandbox authorization is reserved for
 * fresh Agent Factory app attempts with dedicated credentials.
 */
export function integrationProbeScope(input: {
  tenantId: string;
  domainId?: string | null;
}): string {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("integration probe requires an explicit tenant scope");
  return `af-probe-${hash({ tenantId, domainId: input.domainId?.trim() || null }).slice(0, 24)}`;
}

const safeSegment = (value: string): string => {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("invalid cassette path segment");
  return safe;
};

const redactError = (value: unknown): string => String((value as Error)?.message ?? value ?? "unknown error")
  .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
  .replace(/((?:api[_-]?key|token|authorization|secret|password)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[REDACTED]")
  .slice(0, 500);

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|token|authorization|secret|password|cookie|credential|session)/i;
const MAX_OBSERVED_STRING = 2_000;
const MAX_OBSERVED_ARRAY = 30;
const MAX_OBSERVED_KEYS = 60;
const MAX_OBSERVED_DEPTH = 8;
const MAX_OBSERVED_NODES = 2_000;
const MAX_OBSERVED_TEXT_BUDGET = 32_000;

function probeSecretValues(config: Record<string, unknown> = {}, env: Record<string, string | undefined> = process.env): string[] {
  const values = new Set<string>();
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (!item || typeof item !== "object" || depth > 16 || nodes++ > 4_000) return;
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (/_env$/i.test(key) && typeof value === "string") {
        const secret = env[value.trim()];
        if (secret) values.add(secret);
      } else if (SENSITIVE_KEY.test(key) && typeof value === "string" && value) {
        values.add(value);
      }
      visit(value, depth + 1);
    }
  };
  visit(config, 0);
  return [...values].filter((value) => value.length >= 3).sort((left, right) => right.length - left.length);
}

function redactObservedText(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.split(encoded).join("[REDACTED]");
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|authorization|secret|password|cookie|credential|session)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(["'](?:api[_-]?key|access[_-]?token|token|authorization|secret|password|cookie|credential|session)["']\s*:\s*["'])[^"']+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED_KEY]");
  return redacted.length > MAX_OBSERVED_STRING
    ? `${redacted.slice(0, MAX_OBSERVED_STRING)}…[TRUNCATED]`
    : redacted;
}

/** Recursively sanitize untrusted probe output before it enters a cassette or
 * observed evidence. Per-field and aggregate budgets prevent a valid response
 * from becoming an unbounded persistence payload. */
export function sanitizeProbeEvidenceValue(value: unknown, secrets: string[] = []): unknown {
  const state = {
    nodes: 0,
    remainingText: MAX_OBSERVED_TEXT_BUDGET,
    seen: new WeakSet<object>(),
  };
  const textWithinBudget = (input: string): string => {
    const safe = redactObservedText(input, secrets);
    const available = Math.max(0, Math.min(MAX_OBSERVED_STRING, state.remainingText));
    if (available === 0) return "[TRUNCATED_BUDGET]";
    const truncated = safe.length > available ? `${safe.slice(0, available)}…[TRUNCATED]` : safe;
    state.remainingText = Math.max(0, state.remainingText - Math.min(safe.length, available));
    return truncated;
  };
  const visit = (item: unknown, depth: number): unknown => {
    state.nodes += 1;
    if (state.nodes > MAX_OBSERVED_NODES) return "[TRUNCATED_NODES]";
    if (depth > MAX_OBSERVED_DEPTH) return "[TRUNCATED_DEPTH]";
    if (typeof item === "string") {
      const trimmed = item.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 100_000) {
        try {
          return visit(JSON.parse(trimmed), depth + 1);
        } catch {
          // Preserve non-JSON text after applying string redaction.
        }
      }
      return textWithinBudget(item);
    }
    if (typeof item === "bigint") return textWithinBudget(item.toString());
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "function" || typeof item === "symbol") return textWithinBudget(String(item));
    if (item === undefined) return null;
    if (Array.isArray(item)) {
      if (state.seen.has(item)) return "[TRUNCATED_CIRCULAR]";
      state.seen.add(item);
      const rows = item.slice(0, MAX_OBSERVED_ARRAY).map((entry) => visit(entry, depth + 1));
      return item.length > MAX_OBSERVED_ARRAY ? [...rows, `[TRUNCATED_${item.length - MAX_OBSERVED_ARRAY}_ITEMS]`] : rows;
    }
    if (!item || typeof item !== "object") return item;
    if (item instanceof Date) return textWithinBudget(item.toISOString());
    if (state.seen.has(item)) return "[TRUNCATED_CIRCULAR]";
    state.seen.add(item);
    const entries = Object.entries(item as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [rawKey, entry] of entries.slice(0, MAX_OBSERVED_KEYS)) {
      const key = textWithinBudget(rawKey).slice(0, 240);
      result[key] = SENSITIVE_KEY.test(rawKey) ? "[REDACTED]" : visit(entry, depth + 1);
    }
    if (entries.length > MAX_OBSERVED_KEYS) result["[TRUNCATED_KEYS]"] = true;
    return result;
  };
  return visit(value, 0);
}

function redactObservedUrl(value: string, secrets: string[]): string {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return redactObservedText(parsed.toString(), secrets);
  } catch {
    return redactObservedText(value, secrets);
  }
}

function observedEvidence(
  exchange: DeclarativeObservedExchange | undefined,
  stage: string,
  secrets: string[],
  failure?: DeclarativeToolExecutionError | null,
): DeclarativeProbeObservedEvidence | undefined {
  if (!exchange && !failure) return undefined;
  return {
    stage,
    ...(exchange ? {
      request: {
        method: exchange.request.method,
        url: redactObservedUrl(exchange.request.url, secrets),
        body: sanitizeProbeEvidenceValue(exchange.request.body, secrets),
      },
      response: {
        status: exchange.response.status,
        body: sanitizeProbeEvidenceValue(exchange.response.body, secrets),
      },
    } : {}),
    ...(failure ? { failure: { kind: failure.kind, code: failure.code, retryable: failure.retryable } } : {}),
  };
}

function classifyGlobalFailure(error: unknown): { classification: IntegrationProbeResult["classification"]; status?: number } {
  const row = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof row.status === "number" ? row.status : undefined;
  const message = String(row.message ?? error ?? "");
  if (status === 429 || /rate.?limit|quota/i.test(message)) return { classification: "rate_limit", status };
  if (status && status >= 500) return { classification: "http_5xx", status };
  if (status && status >= 400) return { classification: "http_4xx", status };
  if (/schema|shape|validation|required field/i.test(message)) return { classification: "schema_mismatch", status };
  if (/network|fetch failed|econn|timeout|enotfound|socket/i.test(message)) return { classification: "network", status };
  return { classification: "unknown", status };
}

/** Persist an already-redacted canonical document by content hash.  The API
 * probe store reuses this after adding its control-plane attestation. */
export async function persistCassette(
  document: CanonicalCassetteDocument,
  dataRoot: string,
  tenantSlug: string,
  toolName: string,
): Promise<string> {
  return (await persistCassetteTracked(document, dataRoot, tenantSlug, toolName)).path;
}

/** Same content-addressed write with creation provenance, used by multi-file
 * transactions so newly-created files can be compensated if the DB commit
 * fails. Existing shared cassettes are never removed by that compensation. */
export async function persistCassetteTracked(
  document: CanonicalCassetteDocument,
  dataRoot: string,
  tenantSlug: string,
  toolName: string,
): Promise<{ path: string; created: boolean }> {
  const dir = path.resolve(dataRoot, "factory-cassettes", safeSegment(tenantSlug));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const canonical = canonicalEvidenceJson(document);
  const contentHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const target = path.join(dir, `${safeSegment(toolName)}-${contentHash}.json`);
  try {
    await fs.writeFile(target, canonical, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { path: target, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(target, "utf8");
    if (existing !== canonical) {
      throw new Error(`content-addressed cassette collision for ${toolName}`);
    }
    return { path: target, created: false };
  }
}

type PreparedWriteBoundary = {
  contract: WriteProbeSafetyContract;
  canary: PreparedWriteProbeCanary;
  lifecycle: WriteProbeLifecycle;
};

function writeProbeExecutionContext(input: {
  toolName: string;
  definitionHash: string;
  tenantSlug: string;
}): ToolWriteProbeExecutionContext {
  return {
    agentName: "agent-factory-probe",
    actionName: input.toolName,
    correlationId: `probe:${input.definitionHash.slice(0, 12)}`,
    tenantSlug: input.tenantSlug,
    eventName: `probe:${input.toolName}`,
  };
}

function prepareWriteBoundary(input: {
  requiresAttemptGrant: boolean;
  sideEffect: unknown;
  probeSafety: unknown;
  args: Record<string, unknown>;
  canarySeed?: string;
  lifecycle?: WriteProbeLifecycle;
}): { kind: "not_write" } | { kind: "ready"; value: PreparedWriteBoundary } | {
  kind: "blocked";
  missing: string[];
  error: string;
} {
  if (!input.requiresAttemptGrant) return { kind: "not_write" };
  if (!isWriteCapableSideEffect(input.sideEffect)) {
    return {
      kind: "blocked",
      missing: ["write_probe_safety_contract"],
      error: "sandboxPolicy 要求一次性写授权，但写探针安全契约未标记为 write/dual。",
    };
  }
  const safety = inspectWriteProbeSafety(input.sideEffect, input.probeSafety);
  if (safety.status === "needs_config") {
    return { kind: "blocked", missing: safety.missing, error: safety.question };
  }
  if (safety.status !== "ready") {
    return { kind: "blocked", missing: ["side_effect_class"], error: "写工具的 sideEffect 与 probeSafety 契约不一致。" };
  }
  const missing: string[] = [];
  if (!input.canarySeed) missing.push("canary_seed");
  if (!input.lifecycle || typeof input.lifecycle.cleanup !== "function") missing.push("cleanup_wiring");
  if (!input.lifecycle || typeof input.lifecycle.readback !== "function") missing.push("absence_readback_wiring");
  if (missing.length) {
    return {
      kind: "blocked",
      missing,
      error: `写探针的可信运行接线还没准备好（缺少：${missing.join(", ")}）。`,
    };
  }
  const prepared = prepareWriteProbeCanary({
    args: input.args,
    contract: safety.contract,
    seed: input.canarySeed!,
  });
  if (!prepared.ok) {
    return { kind: "blocked", missing: ["canary_arguments"], error: prepared.reason };
  }
  return {
    kind: "ready",
    value: { contract: safety.contract, canary: prepared.canary, lifecycle: input.lifecycle! },
  };
}

async function completeWriteProbeLifecycle(input: {
  boundary: PreparedWriteBoundary;
  toolName: string;
  config: Record<string, unknown>;
  createCompleted: boolean;
  createResult?: unknown;
  createError?: string;
  secrets: string[];
  execution: ToolWriteProbeExecutionContext;
}): Promise<{
  proof: WriteProbeCassetteProof;
  idempotencyVerified: boolean;
  cleanupCompleted: boolean;
  absenceVerified: boolean;
}> {
  const lifecycleInput: WriteProbeLifecycleInput = {
    toolName: input.toolName,
    args: input.boundary.canary.args,
    config: input.config,
    contract: input.boundary.contract,
    canary: input.boundary.canary,
    execution: input.execution,
    createResult: input.createResult,
  };
  let cleanupCompleted = false;
  let cleanupEvidence: unknown;
  try {
    const cleanup = await input.boundary.lifecycle.cleanup(lifecycleInput);
    cleanupCompleted = cleanup.completed === true;
    cleanupEvidence = cleanup.evidence;
  } catch (error) {
    cleanupEvidence = { error: redactObservedText(redactError(error), input.secrets) };
  }
  let absenceVerified = false;
  let absenceEvidence: unknown;
  try {
    const readback = await input.boundary.lifecycle.readback(lifecycleInput);
    absenceVerified = readback.absent === true;
    absenceEvidence = readback.evidence;
  } catch (error) {
    absenceEvidence = { error: redactObservedText(redactError(error), input.secrets) };
  }

  const idempotencyValue = input.boundary.contract.idempotency.kind === "argument"
    ? input.boundary.canary.idempotencyKey
    : readProbeResultPath(input.createResult, input.boundary.contract.idempotency.receiptPath);
  const idempotencyVerified = typeof idempotencyValue === "string"
    ? idempotencyValue.trim().length > 0
    : typeof idempotencyValue === "number" && Number.isFinite(idempotencyValue);
  const proofSecrets = [
    ...input.secrets,
    input.boundary.canary.marker,
    input.boundary.canary.namespace,
    input.boundary.canary.target,
    input.boundary.canary.idempotencyKey,
    typeof idempotencyValue === "string" ? idempotencyValue : undefined,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const digest = (value: unknown): string => hash({ value });
  return {
    idempotencyVerified,
    cleanupCompleted,
    absenceVerified,
    proof: {
      schema: "agent-factory-write-probe/v1",
      markerHash: digest(input.boundary.canary.marker),
      namespaceHash: digest(input.boundary.canary.namespace),
      targetHash: digest(input.boundary.canary.target),
      idempotencyKeyHash: idempotencyVerified
        ? digest(idempotencyValue)
        : UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH,
      create: {
        completed: input.createCompleted,
        evidence: sanitizeProbeEvidenceValue(
          input.createCompleted ? input.createResult : { error: input.createError ?? "create did not complete" },
          proofSecrets,
        ),
      },
      cleanup: {
        completed: cleanupCompleted,
        evidence: sanitizeProbeEvidenceValue(cleanupEvidence, proofSecrets),
      },
      absence: {
        verified: absenceVerified,
        evidence: sanitizeProbeEvidenceValue(absenceEvidence, proofSecrets),
      },
    },
  };
}

function writeProbeFailure(
  lifecycle: Awaited<ReturnType<typeof completeWriteProbeLifecycle>>,
): Pick<IntegrationProbeResult, "classification" | "error"> | null {
  if (!lifecycle.idempotencyVerified) {
    return { classification: "idempotency_unverified", error: "create result did not prove the declared idempotency key" };
  }
  if (!lifecycle.cleanupCompleted) {
    return { classification: "cleanup_failed", error: "write canary cleanup did not complete" };
  }
  if (!lifecycle.absenceVerified) {
    return { classification: "absence_proof_failed", error: "cleanup readback did not prove the canary is absent" };
  }
  return null;
}

async function probeDeclarativeWriteIntegration(input: {
  request: IntegrationProbeRequest;
  boundary: PreparedWriteBoundary;
  startedAt: number;
  definitionHash: string;
  schemaHash: string;
  baseSecrets: string[];
}): Promise<IntegrationProbeResult> {
  const execution = writeProbeExecutionContext({
    toolName: input.request.tool.name,
    definitionHash: input.definitionHash,
    tenantSlug: input.request.tenantSlug,
  });
  let exchange: DeclarativeObservedExchange | undefined;
  let createResult: unknown;
  let createCompleted = false;
  let createFailure: { classification: IntegrationProbeResult["classification"]; status?: number; error: string } | undefined;
  try {
    const descriptor = makeDeclarativeTool(input.request.tool, {
      fetchFn: input.request.fetchFn,
      onExchange: (value) => { exchange = value; },
    });
    const result = await descriptor.handler({
      ...execution,
      event: { name: execution.eventName, data: input.boundary.canary.args },
      config: input.request.config,
    } as ToolContext);
    createResult = result.data;
    createCompleted = true;
  } catch (error) {
    const failure = error instanceof DeclarativeToolExecutionError ? error : null;
    createFailure = {
      classification: failure?.kind ?? "unknown",
      status: failure?.status,
      error: redactObservedText(redactError(error), input.baseSecrets),
    };
  }

  // Cleanup is attempted even when create throws: an adapter can fail after a
  // remote system accepted a partial write.
  const lifecycle = await completeWriteProbeLifecycle({
    boundary: input.boundary,
    toolName: input.request.tool.name,
    config: input.request.config ?? {},
    createCompleted,
    createResult,
    createError: createFailure?.error,
    secrets: input.baseSecrets,
    execution,
  });
  const lifecycleFailure = writeProbeFailure(lifecycle);
  const failure = createFailure ?? lifecycleFailure;
  const durationMs = Date.now() - input.startedAt;
  const recordedAt = new Date().toISOString();
  const cassette: CanonicalCassetteDocument = {
    version: 1,
    tool: { name: input.request.tool.name, definitionHash: input.definitionHash, schemaHash: input.schemaHash },
    evidence: {
      recordedAt,
      recordedBy: input.request.authorization?.actor,
      mode: "live-probe",
      writeProbe: lifecycle.proof,
    },
    entries: [makeToolCassetteEntry({
      toolName: input.request.tool.name,
      args: sanitizeProbeEvidenceValue(input.boundary.canary.args, [
        ...input.baseSecrets,
        input.boundary.canary.marker,
        input.boundary.canary.namespace,
        input.boundary.canary.target,
        ...(input.boundary.canary.idempotencyKey ? [input.boundary.canary.idempotencyKey] : []),
      ]),
      status: exchange?.response.status ?? createFailure?.status ?? (createCompleted ? 200 : 500),
      body: lifecycle.proof.create.evidence,
      durationMs,
      recordedAt,
    })],
  };
  const cassettePath = input.request.persistCassette
    ? await persistCassette(cassette, input.request.dataRoot ?? (process.env.AGENTIC_DATA_ROOT?.trim() || "./data"), input.request.tenantSlug, input.request.tool.name)
    : undefined;
  const failureStatus = failure && "status" in failure && typeof failure.status === "number"
    ? failure.status
    : undefined;
  return {
    verified: !failure && createCompleted,
    toolName: input.request.tool.name,
    definitionHash: input.definitionHash,
    schemaHash: input.schemaHash,
    classification: failure?.classification ?? "verified",
    status: failureStatus ?? exchange?.response.status ?? 200,
    durationMs,
    ...(failure?.error ? { error: failure.error } : {}),
    cassette,
    cassettePath,
    writeProbeProof: lifecycle.proof,
    observedEvidence: observedEvidence(exchange, failure?.classification ?? "completed", [
      ...input.baseSecrets,
      input.boundary.canary.marker,
      input.boundary.canary.namespace,
      input.boundary.canary.target,
      ...(input.boundary.canary.idempotencyKey ? [input.boundary.canary.idempotencyKey] : []),
    ]),
  };
}

/** Execute a declarative tool against its real guarded HTTP boundary and create
 * a definition-bound, redacted cassette. Side-effecting probes require explicit
 * human authorization; callers cannot infer consent from tool metadata. */
export async function probeDeclarativeIntegration(request: IntegrationProbeRequest): Promise<IntegrationProbeResult> {
  const startedAt = Date.now();
  const executionPolicy = {
    operation: request.tool.operation,
    effectScope: request.tool.effectScope,
    sandboxPolicy: request.tool.sandboxPolicy,
  };
  if (!isToolExecutionPolicy(executionPolicy)) {
    return {
      verified: false,
      toolName: request.tool.name,
      definitionHash: "",
      schemaHash: "",
      classification: "needs_config",
      durationMs: Date.now() - startedAt,
      error: "工具缺少完整、可审核的 operation/effectScope/sandboxPolicy；不会从 sideEffect 或 HTTP method 推断。",
      next: "ask_user",
      missing: ["tool_execution_policy"],
    };
  }
  const schemaHash = hash({ params: request.tool.paramsSchema ?? {}, returns: request.tool.returnsSchema ?? {} });
  const definitionHash = declarativeToolDefinitionHash(request.tool, request.config);
  const requiresAttemptGrant = executionPolicy.sandboxPolicy === "requires_attempt_grant";
  const writeBoundary = prepareWriteBoundary({
    requiresAttemptGrant,
    sideEffect: request.tool.sideEffect,
    probeSafety: request.tool.probeSafety,
    args: request.args,
    canarySeed: request.canarySeed,
    lifecycle: request.writeProbeLifecycle,
  });
  if (writeBoundary.kind === "blocked") {
    return {
      verified: false,
      toolName: request.tool.name,
      definitionHash,
      schemaHash,
      classification: "needs_config",
      durationMs: Date.now() - startedAt,
      error: writeBoundary.error,
      next: "ask_user",
      missing: writeBoundary.missing,
    };
  }
  if (requiresAttemptGrant && !request.authorization?.allowSideEffects) {
    return {
      verified: false,
      toolName: request.tool.name,
      definitionHash,
      schemaHash,
      classification: "authorization_required",
      durationMs: Date.now() - startedAt,
      error: "requires_attempt_grant live probe requires explicit user authorization",
    };
  }

  const secrets = probeSecretValues(request.config);
  if (writeBoundary.kind === "ready") {
    return probeDeclarativeWriteIntegration({
      request,
      boundary: writeBoundary.value,
      startedAt,
      definitionHash,
      schemaHash,
      baseSecrets: secrets,
    });
  }
  let exchange: DeclarativeObservedExchange | undefined;
  try {
    const descriptor = makeDeclarativeTool(request.tool, {
      fetchFn: request.fetchFn,
      onExchange: (value) => { exchange = value; },
    });
    const result = await descriptor.handler({
      agentName: "agent-factory-probe",
      actionName: request.tool.name,
      correlationId: `probe:${definitionHash.slice(0, 12)}`,
      tenantSlug: request.tenantSlug,
      event: { name: `probe:${request.tool.name}`, data: request.args },
      config: request.config,
    } as ToolContext);
    const durationMs = Date.now() - startedAt;
    const recordedAt = new Date().toISOString();
    const cassette: CanonicalCassetteDocument = {
      version: 1,
      tool: { name: request.tool.name, definitionHash, schemaHash },
      evidence: { recordedAt, recordedBy: request.authorization?.actor, mode: "live-probe" },
      entries: [makeToolCassetteEntry({
        toolName: request.tool.name,
        args: sanitizeProbeEvidenceValue(request.args, secrets),
        status: exchange?.response.status ?? 200,
        body: sanitizeProbeEvidenceValue(result.data, secrets),
        durationMs,
        recordedAt,
      })],
    };
    const cassettePath = request.persistCassette
      ? await persistCassette(cassette, request.dataRoot ?? (process.env.AGENTIC_DATA_ROOT?.trim() || "./data"), request.tenantSlug, request.tool.name)
      : undefined;
    const status = exchange?.response.status ?? 200;
    return { verified: true, toolName: request.tool.name, definitionHash, schemaHash, classification: "verified", status, durationMs, cassette, cassettePath, observedEvidence: observedEvidence(exchange, "completed", secrets) };
  } catch (error) {
    const failure = error instanceof DeclarativeToolExecutionError ? error : null;
    const safeError = redactObservedText(redactError(error), secrets);
    return {
      verified: false,
      toolName: request.tool.name,
      definitionHash,
      schemaHash,
      classification: failure?.kind ?? "unknown",
      status: failure?.status,
      durationMs: Date.now() - startedAt,
      error: safeError,
      observedEvidence: observedEvidence(exchange, failure?.kind ?? "unknown", secrets, failure),
    };
  }
}

async function probeGlobalWriteIntegration(input: {
  request: GlobalIntegrationProbeRequest;
  boundary: PreparedWriteBoundary;
  startedAt: number;
  definitionHash: string;
  schemaHash: string;
  baseSecrets: string[];
}): Promise<IntegrationProbeResult> {
  const execution = writeProbeExecutionContext({
    toolName: input.request.catalog.name,
    definitionHash: input.definitionHash,
    tenantSlug: input.request.tenantSlug,
  });
  let createResult: unknown;
  let createCompleted = false;
  let createFailure: { classification: IntegrationProbeResult["classification"]; status?: number; error: string } | undefined;
  try {
    const result = await input.request.descriptor.handler({
      ...execution,
      event: { name: execution.eventName, data: input.boundary.canary.args },
      config: input.request.config,
    } as ToolContext);
    createResult = result.data;
    createCompleted = true;
    const issues = validateToolSchema(createResult, input.request.catalog.returnsSchema as Record<string, unknown> | undefined);
    if (issues.length) {
      const message = issues.slice(0, 5).map((issue) => `${issue.path}: expected ${issue.expected}, got ${issue.actual}`).join("; ");
      createFailure = {
        classification: "schema_mismatch",
        error: redactObservedText(redactError(message), input.baseSecrets),
      };
    }
  } catch (error) {
    const classified = classifyGlobalFailure(error);
    createFailure = {
      classification: classified.classification,
      status: classified.status,
      error: redactObservedText(redactError(error), input.baseSecrets),
    };
  }

  const lifecycle = await completeWriteProbeLifecycle({
    boundary: input.boundary,
    toolName: input.request.catalog.name,
    config: input.request.config ?? {},
    createCompleted,
    createResult,
    createError: createFailure?.error,
    secrets: input.baseSecrets,
    execution,
  });
  const lifecycleFailure = writeProbeFailure(lifecycle);
  const failure = createFailure ?? lifecycleFailure;
  const durationMs = Date.now() - input.startedAt;
  const recordedAt = new Date().toISOString();
  const canarySecrets = [
    ...input.baseSecrets,
    input.boundary.canary.marker,
    input.boundary.canary.namespace,
    input.boundary.canary.target,
    ...(input.boundary.canary.idempotencyKey ? [input.boundary.canary.idempotencyKey] : []),
  ];
  const cassette: CanonicalCassetteDocument = {
    version: 1,
    tool: { name: input.request.catalog.name, definitionHash: input.definitionHash, schemaHash: input.schemaHash },
    evidence: {
      recordedAt,
      recordedBy: input.request.authorization?.actor,
      mode: "live-probe",
      writeProbe: lifecycle.proof,
    },
    entries: [makeToolCassetteEntry({
      toolName: input.request.catalog.name,
      args: sanitizeProbeEvidenceValue(input.boundary.canary.args, canarySecrets),
      status: createFailure?.status ?? (createCompleted ? 200 : 500),
      body: lifecycle.proof.create.evidence,
      durationMs,
      recordedAt,
    })],
  };
  const cassettePath = input.request.persistCassette
    ? await persistCassette(cassette, input.request.dataRoot ?? (process.env.AGENTIC_DATA_ROOT?.trim() || "./data"), input.request.tenantSlug, input.request.catalog.name)
    : undefined;
  const failureStatus = failure && "status" in failure && typeof failure.status === "number"
    ? failure.status
    : undefined;
  return {
    verified: !failure && createCompleted,
    toolName: input.request.catalog.name,
    definitionHash: input.definitionHash,
    schemaHash: input.schemaHash,
    classification: failure?.classification ?? "verified",
    status: failureStatus ?? 200,
    durationMs,
    ...(failure?.error ? { error: failure.error } : {}),
    cassette,
    cassettePath,
    writeProbeProof: lifecycle.proof,
  };
}

/** Probe a compiled global registry adapter through its real ToolDescriptor.
 * Unknown side-effect metadata is treated as side-effecting. Success is
 * schema-checked and persisted only as a redacted, definition-bound cassette. */
export async function probeGlobalIntegration(request: GlobalIntegrationProbeRequest): Promise<IntegrationProbeResult> {
  const startedAt = Date.now();
  const executionPolicy = {
    operation: request.catalog.operation,
    effectScope: request.catalog.effectScope,
    sandboxPolicy: request.catalog.sandboxPolicy,
  };
  if (!isToolExecutionPolicy(executionPolicy)) {
    return {
      verified: false,
      toolName: request.catalog.name,
      definitionHash: "",
      schemaHash: "",
      classification: "needs_config",
      durationMs: Date.now() - startedAt,
      error: "global tool 缺少完整、可审核的 operation/effectScope/sandboxPolicy；不会从 sideEffect 推断。",
      next: "ask_user",
      missing: ["tool_execution_policy"],
    };
  }
  const schemaHash = hash({ args: request.catalog.argsSchema ?? {}, returns: request.catalog.returnsSchema ?? {} });
  const definitionHash = catalogToolDefinitionHash(request.catalog, request.config);
  const requiresAttemptGrant = executionPolicy.sandboxPolicy === "requires_attempt_grant";
  const writeBoundary = prepareWriteBoundary({
    requiresAttemptGrant,
    sideEffect: request.catalog.sideEffect,
    probeSafety: request.catalog.probeSafety,
    args: request.args,
    canarySeed: request.canarySeed,
    lifecycle: request.writeProbeLifecycle,
  });
  if (writeBoundary.kind === "blocked") {
    return {
      verified: false,
      toolName: request.catalog.name,
      definitionHash,
      schemaHash,
      classification: "needs_config",
      durationMs: Date.now() - startedAt,
      error: writeBoundary.error,
      next: "ask_user",
      missing: writeBoundary.missing,
    };
  }
  if (requiresAttemptGrant && !request.authorization?.allowSideEffects) {
    return {
      verified: false,
      toolName: request.catalog.name,
      definitionHash,
      schemaHash,
      classification: "authorization_required",
      durationMs: Date.now() - startedAt,
      error: "requires_attempt_grant global tool probe requires explicit user authorization",
    };
  }
  const secrets = probeSecretValues(request.config);
  if (writeBoundary.kind === "ready") {
    return probeGlobalWriteIntegration({
      request,
      boundary: writeBoundary.value,
      startedAt,
      definitionHash,
      schemaHash,
      baseSecrets: secrets,
    });
  }
  try {
    const result = await request.descriptor.handler({
      agentName: "agent-factory-probe",
      actionName: request.catalog.name,
      correlationId: `probe:${definitionHash.slice(0, 12)}`,
      tenantSlug: request.tenantSlug,
      event: { name: `probe:${request.catalog.name}`, data: request.args },
      config: request.config,
    } as ToolContext);
    const issues = validateToolSchema(result.data, request.catalog.returnsSchema as Record<string, unknown> | undefined);
    if (issues.length) {
      const message = issues.slice(0, 5).map((issue) => `${issue.path}: expected ${issue.expected}, got ${issue.actual}`).join("; ");
      return {
        verified: false,
        toolName: request.catalog.name,
        definitionHash,
        schemaHash,
        classification: "schema_mismatch",
        durationMs: Date.now() - startedAt,
        error: redactObservedText(redactError(message), secrets),
      };
    }
    const durationMs = Date.now() - startedAt;
    const recordedAt = new Date().toISOString();
    const cassette: CanonicalCassetteDocument = {
      version: 1,
      tool: { name: request.catalog.name, definitionHash, schemaHash },
      evidence: { recordedAt, recordedBy: request.authorization?.actor, mode: "live-probe" },
      entries: [makeToolCassetteEntry({
        toolName: request.catalog.name,
        args: sanitizeProbeEvidenceValue(request.args, secrets),
        status: 200,
        body: sanitizeProbeEvidenceValue(result.data, secrets),
        durationMs,
        recordedAt,
      })],
    };
    const cassettePath = request.persistCassette
      ? await persistCassette(cassette, request.dataRoot ?? (process.env.AGENTIC_DATA_ROOT?.trim() || "./data"), request.tenantSlug, request.catalog.name)
      : undefined;
    return { verified: true, toolName: request.catalog.name, definitionHash, schemaHash, classification: "verified", status: 200, durationMs, cassette, cassettePath };
  } catch (error) {
    const failure = classifyGlobalFailure(error);
    return {
      verified: false,
      toolName: request.catalog.name,
      definitionHash,
      schemaHash,
      classification: failure.classification,
      status: failure.status,
      durationMs: Date.now() - startedAt,
      error: redactObservedText(redactError(error), secrets),
    };
  }
}
