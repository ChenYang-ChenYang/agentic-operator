import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import {
  canonicalEvidenceJson,
  SandboxLifecycleBlockedError,
  sandboxCleanupReceiptIssues,
  sandboxExecutionPlaneAttestationIssues,
  type SandboxDeployResult,
  type SandboxExecutionPlaneAttestation,
} from "@agentic/agent-factory";

// Type-only: the CONTROL image's curated static closure must not include the bundle builder's
// deployer/llm graph. The runtime constant lives in the zero-dependency protocol module below.
import type { SandboxCandidateBundle } from "./services/agent-factory/sandbox-bundle-builder";
import {
  MAX_SANDBOX_CANDIDATE_RUN_MS,
  REMOTE_SANDBOX_ENVELOPE_SCHEMA,
  REMOTE_SANDBOX_RESULT_SCHEMA,
  RemoteSandboxProtocolError,
  signRemoteSandboxMessage,
  signRemoteSandboxRunnerHealth,
  verifyRemoteSandboxMessage,
  type RemoteSandboxAttemptCommand,
  type RemoteSandboxJobResult,
  type RemoteSandboxSubmitCommand,
  type SignedRemoteSandboxMessage,
} from "./services/agent-factory/sandbox-remote-protocol";
import type { SandboxWorkloadExecutionResult } from "./services/agent-factory/sandbox-runner-executor";
import {
  attestSandboxCandidateResult,
  type SandboxRunnerExecutionIdentity,
} from "./services/agent-factory/sandbox-runner-attestation";
import {
  registerSandboxRunnerDeleteControl,
  SANDBOX_DELETE_CONTROL_READINESS_SCHEMA,
} from "./services/agent-factory/sandbox-runner-delete-control";
import {
  listOutstandingSandboxAttempts,
  listSandboxAttempts,
} from "./services/agent-factory/sandbox-lifecycle-store";
import type {
  SandboxCodeActCandidateReaperLike,
} from "./services/agent-factory/sandbox-codeact-reaper";
import {
  SANDBOX_CANCEL_FENCE_ACK_SCHEMA,
  SandboxCancelFenceStore,
  signSandboxCancelFenceAck,
  verifySandboxCancelFenceAck,
  type SandboxCancelFenceAck,
} from "./services/agent-factory/sandbox-cancel-fence";

interface SandboxRunnerConfig {
  host: string;
  controlPort: number;
  keyId: string;
  requestSigningKey: string;
  resultSigningKey: string;
  identity: SandboxRunnerExecutionIdentity;
  deleteToken: string;
  brokerOrigin: string;
  appPrefix: string;
  journalDir: string;
  workloadUrl: string;
  workloadToken: string;
  cancelFenceIntegrityKey: string;
  brokerAuthToken?: string;
  jobTtlMs: number;
  reaperMs: number;
}

const OCI_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const SANDBOX_JOB_CLEANUP_MARGIN_MS = 3 * 60_000;
export const MIN_SANDBOX_RUNNER_JOB_TTL_MS =
  MAX_SANDBOX_CANDIDATE_RUN_MS + SANDBOX_JOB_CLEANUP_MARGIN_MS;

type JobStatus = RemoteSandboxJobResult<SandboxDeployResult>["status"];
type SandboxCandidateExecutor = (input: {
  bundle: SandboxCandidateBundle;
  identity: SandboxRunnerExecutionIdentity;
  signal?: AbortSignal;
  now?: () => Date;
}) => Promise<SandboxDeployResult>;
type SandboxWorkloadExecutor = (input: {
  bundle: SandboxCandidateBundle;
  signal?: AbortSignal;
  now?: () => Date;
}) => Promise<SandboxWorkloadExecutionResult>;

interface RunnerJob {
  attemptId: string;
  bundleHash: string;
  bundle: SandboxCandidateBundle;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  controller: AbortController;
  settled?: Promise<void>;
  result?: SandboxDeployResult;
  error?: { code: string; message: string };
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function valueOrFile(
  name: string,
  env: Record<string, string | undefined>,
  minBytes = 1,
): string {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  let value = direct;
  if (file) {
    if (!path.isAbsolute(file)) throw new Error(`${name}_FILE must be absolute`);
    value = readFileSync(file, "utf8").trim();
  }
  if (!value || Buffer.byteLength(value, "utf8") < minBytes) {
    throw new Error(`${name} is missing or too short`);
  }
  return value;
}

function optionalValueOrFile(
  name: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (!direct && !file) return undefined;
  return valueOrFile(name, env, 16);
}

function exactOrigin(value: string, label: string): string {
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) throw new Error(`${label} must be an absolute HTTP(S) origin`);
  return parsed.origin;
}

function executionPlaneAttestation(
  env: Record<string, string | undefined>,
  expected: {
    runnerId: string;
    runnerBuildId: string;
    runtimeImageDigest: string;
    isolationTier: "remote_container" | "remote_vm";
  },
): SandboxExecutionPlaneAttestation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      valueOrFile("SANDBOX_RUNNER_PLATFORM_ATTESTATION", env),
    );
  } catch (error) {
    throw new Error(
      `SANDBOX_RUNNER_PLATFORM_ATTESTATION is invalid: ${String(
        (error as Error)?.message ?? error,
      ).slice(0, 160)}`,
    );
  }
  const attestation = parsed as SandboxExecutionPlaneAttestation;
  const primaryHostIdentityHash = valueOrFile(
    "SANDBOX_PRIMARY_HOST_IDENTITY_HASH",
    env,
  );
  const primaryDockerDaemonIdentityHash = valueOrFile(
    "SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH",
    env,
  );
  const issues = sandboxExecutionPlaneAttestationIssues(attestation, {
    planeId: attestation?.planeId,
    trustDomain: attestation?.trustDomain,
    runnerId: expected.runnerId,
    allowedRunnerBuildIds: new Set([expected.runnerBuildId]),
    allowedRuntimeImageDigests: new Set([expected.runtimeImageDigest]),
    allowedControlHostIdentityHashes: new Set([
      attestation?.controlHostIdentityHash,
    ]),
    allowedWorkloadHostIdentityHashes: new Set([
      attestation?.workloadHostIdentityHash,
    ]),
    allowedDockerDaemonIdentityHashes: new Set([
      attestation?.dockerDaemonIdentityHash,
    ]),
    primaryHostIdentityHash,
    primaryDockerDaemonIdentityHash,
    attestorKeyId: valueOrFile(
      "SANDBOX_RUNNER_PLATFORM_ATTESTOR_KEY_ID",
      env,
    ),
    attestorPublicKey: valueOrFile(
      "SANDBOX_RUNNER_PLATFORM_ATTESTOR_PUBLIC_KEY",
      env,
    ),
  });
  if (
    attestation?.isolationTier !== expected.isolationTier
    || issues.length
  ) {
    throw new Error(
      `SANDBOX_RUNNER_PLATFORM_ATTESTATION failed verification: ${
        issues.join("; ") || "isolation tier mismatch"
      }`,
    );
  }
  return attestation;
}

/**
 * Prove the workload can reach the exact authenticated delete-control route
 * before it opens its durable orphan ledger. Compose also orders the services,
 * but this cross-container probe closes the gap between a loopback healthcheck
 * and actual execution-network reachability.
 */
export async function waitForSandboxDeleteControlReady(input: {
  origin: string;
  token: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const origin = exactOrigin(input.origin, "SANDBOX_INTERNAL_CONTROL_ORIGIN");
  if (Buffer.byteLength(input.token.trim(), "utf8") < 16) {
    throw new Error("sandbox delete-control token is missing or too short");
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("sandbox delete-control readiness timeout must be positive");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("sandbox delete-control readiness poll interval must be positive");
  }
  const fetchFn = input.fetchFn ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let authenticationRejected = false;
  do {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const response = await fetchFn(`${origin}/internal/health/delete-control`, {
        headers: { authorization: `Bearer ${input.token.trim()}` },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(2_000, remaining)),
      });
      if (response.status === 401 || response.status === 403) {
        authenticationRejected = true;
        break;
      }
      if (response.ok) {
        const body = await response.json() as { schema?: unknown; ready?: unknown };
        if (
          body.schema === SANDBOX_DELETE_CONTROL_READINESS_SCHEMA
          && body.ready === true
        ) return;
      }
    } catch {
      // The control container may be between listen() and network publication.
      // Retry only inside the bounded startup window; no recovery is attempted.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  } while (Date.now() < deadline);

  throw new SandboxLifecycleBlockedError({
    code: "sandbox_cleanup_failed",
    next: "ask_user",
    question:
      "沙箱 workload 启动时无法确认删除控制端点已就绪，因此没有读取或恢复任何遗留 App。请检查 control 服务、内部网络和 workload/delete token 后重试。",
    missing: [authenticationRejected
      ? "sandbox delete-control authentication was rejected"
      : "sandbox delete-control readiness was not reachable"],
  });
}

function assertControlPaths(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV === "test") return;
  const root = env.AGENTIC_DATA_ROOT ?? "";
  if (!root || !path.isAbsolute(root) || !path.resolve(root).startsWith("/sandbox/")) {
    throw new Error("AGENTIC_DATA_ROOT must use an independent /sandbox control volume");
  }
}

export function loadSandboxRunnerConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxRunnerConfig {
  assertControlPaths(env);
  const brokerOrigin = exactOrigin(
    valueOrFile("SANDBOX_INNGEST_BASE_URL", env),
    "SANDBOX_INNGEST_BASE_URL",
  );
  const workloadUrl = exactOrigin(
    valueOrFile("SANDBOX_WORKLOAD_URL", env),
    "SANDBOX_WORKLOAD_URL",
  );
  const requestSigningKey = valueOrFile("SANDBOX_RUNNER_REQUEST_HMAC", env, 32);
  const resultSigningKey = valueOrFile("SANDBOX_RUNNER_RESULT_HMAC", env, 32);
  const hasReceiptSigningKey = Boolean(
    env.SANDBOX_RUNNER_RECEIPT_HMAC?.trim()
    || env.SANDBOX_RUNNER_RECEIPT_HMAC_FILE?.trim(),
  );
  const receiptSigningKey = hasReceiptSigningKey
    ? valueOrFile("SANDBOX_RUNNER_RECEIPT_HMAC", env, 32)
    : resultSigningKey;
  const appPrefix = valueOrFile("SANDBOX_INNGEST_APP_PREFIX", env);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(appPrefix)) {
    throw new Error("SANDBOX_INNGEST_APP_PREFIX is invalid");
  }
  const runtimeImageDigest = valueOrFile("SANDBOX_RUNNER_RUNTIME_IMAGE_DIGEST", env);
  if (!OCI_SHA256_DIGEST.test(runtimeImageDigest)) {
    throw new Error(
      "SANDBOX_RUNNER_RUNTIME_IMAGE_DIGEST must be lowercase sha256:<64 hex>",
    );
  }
  const actualIsolationTier = valueOrFile("SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER", env);
  if (!["same_host_container", "remote_container", "remote_vm"].includes(actualIsolationTier)) {
    throw new Error(
      "SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER must be same_host_container, remote_container, or remote_vm",
    );
  }
  if (
    actualIsolationTier !== "same_host_container"
    && (!hasReceiptSigningKey
      || new Set([requestSigningKey, resultSigningKey, receiptSigningKey]).size !== 3)
  ) {
    throw new Error(
      "remote sandbox request, result, and receipt HMAC keys must be explicitly configured and distinct",
    );
  }
  const runnerId = valueOrFile("SANDBOX_RUNNER_ID", env);
  const runnerBuildId = valueOrFile("SANDBOX_RUNNER_BUILD_ID", env);
  const platformAttestation =
    actualIsolationTier === "same_host_container"
      ? undefined
      : executionPlaneAttestation(env, {
          runnerId,
          runnerBuildId,
          runtimeImageDigest,
          isolationTier: actualIsolationTier as
            | "remote_container"
            | "remote_vm",
        });
  const jobTtlMs = positiveInt(
    "SANDBOX_RUNNER_JOB_TTL_MS",
    env.SANDBOX_RUNNER_JOB_TTL_MS,
    MIN_SANDBOX_RUNNER_JOB_TTL_MS,
  );
  if (jobTtlMs < MIN_SANDBOX_RUNNER_JOB_TTL_MS) {
    throw new Error(
      `SANDBOX_RUNNER_JOB_TTL_MS must be at least ${MIN_SANDBOX_RUNNER_JOB_TTL_MS}ms (maximum run plus cleanup margin)`,
    );
  }
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    controlPort: positiveInt("PORT", env.PORT, 3560),
    keyId: valueOrFile("SANDBOX_RUNNER_KEY_ID", env),
    requestSigningKey,
    resultSigningKey,
    identity: {
      runnerId,
      runnerBuildId,
      runtimeImageDigest,
      receiptSigningKey,
      brokerOrigin,
      serveOrigin: workloadUrl,
      actualIsolationTier: actualIsolationTier as "same_host_container" | "remote_container" | "remote_vm",
      ...(platformAttestation ? { platformAttestation } : {}),
    },
    deleteToken: valueOrFile("SANDBOX_INNGEST_DELETE_TOKEN", env, 16),
    brokerOrigin,
    appPrefix,
    journalDir: path.resolve(
      env.AGENTIC_DATA_ROOT || "/sandbox/data",
      "runner-jobs",
    ),
    workloadUrl,
    workloadToken: valueOrFile("SANDBOX_WORKLOAD_TOKEN", env, 32),
    cancelFenceIntegrityKey: valueOrFile("SANDBOX_CANCEL_FENCE_HMAC", env, 32),
    brokerAuthToken: optionalValueOrFile("SANDBOX_INNGEST_CONTROL_BEARER", env),
    jobTtlMs,
    reaperMs: positiveInt(
      "SANDBOX_RUNNER_REAPER_MS",
      env.SANDBOX_RUNNER_REAPER_MS,
      60_000,
    ),
  };
}

export interface SandboxWorkloadConfig {
  host: string;
  port: number;
  token: string;
  brokerOrigin: string;
  appPrefix: string;
  brokerAuthToken?: string;
  cancelFenceDir: string;
  cancelFenceIntegrityKey: string;
  cancelFenceMaxEntries: number;
}

export function loadSandboxWorkloadConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxWorkloadConfig {
  if (env.NODE_ENV !== "test") {
    const db = env.DATABASE_URL?.replace(/^file:/, "") ?? "";
    for (const [name, raw] of [
      ["DATABASE_URL", db],
      ["AGENTIC_DATA_ROOT", env.AGENTIC_DATA_ROOT ?? ""],
      ["AGENTIC_MODELS_DIR", env.AGENTIC_MODELS_DIR ?? ""],
    ] as const) {
      if (!raw || !path.isAbsolute(raw) || !path.resolve(raw).startsWith("/sandbox/")) {
        throw new Error(`${name} must use an independent /sandbox workload volume`);
      }
    }
    if (env.SANDBOX_RUNNER_EGRESS_MODE !== "deny_all") {
      throw new Error("SANDBOX_RUNNER_EGRESS_MODE=deny_all is required");
    }
  }
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: positiveInt(
      "SANDBOX_RUNNER_WORKLOAD_PORT",
      env.SANDBOX_RUNNER_WORKLOAD_PORT,
      3561,
    ),
    token: valueOrFile("SANDBOX_WORKLOAD_TOKEN", env, 32),
    brokerOrigin: exactOrigin(
      valueOrFile("SANDBOX_INNGEST_BASE_URL", env),
      "SANDBOX_INNGEST_BASE_URL",
    ),
    appPrefix: valueOrFile("SANDBOX_INNGEST_APP_PREFIX", env),
    brokerAuthToken: optionalValueOrFile("SANDBOX_INNGEST_CONTROL_BEARER", env),
    cancelFenceDir: path.resolve(
      env.AGENTIC_DATA_ROOT || "/sandbox/data",
      "runner-cancel-fences",
    ),
    cancelFenceIntegrityKey: valueOrFile("SANDBOX_CANCEL_FENCE_HMAC", env, 32),
    cancelFenceMaxEntries: positiveInt(
      "SANDBOX_CANCEL_FENCE_MAX_ENTRIES",
      env.SANDBOX_CANCEL_FENCE_MAX_ENTRIES,
      10_000,
    ),
  };
}

function safeError(error: unknown): { code: string; message: string } {
  const raw = String((error as Error)?.message ?? error)
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, 400);
  return {
    code: error instanceof RemoteSandboxProtocolError
      ? error.code
      : error instanceof SandboxLifecycleBlockedError
        ? error.block.code
        : error instanceof SandboxRunnerCancellationError
          ? "sandbox_cancelled"
          : "sandbox_execution_failed",
    message: raw || "sandbox execution failed",
  };
}

function exactBearer(actual: string | undefined, expected: string): boolean {
  const supplied = actual?.startsWith("Bearer ") ? actual.slice(7) : "";
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

class SandboxRunnerCancellationError extends Error {
  constructor(message = "sandbox workload cancelled after verified cleanup") {
    super(message);
    this.name = "SandboxRunnerCancellationError";
  }
}

const SANDBOX_WORKLOAD_HEALTH_SCHEMA =
  "agent-factory-sandbox-workload-health/v1" as const;

interface SandboxWorkloadDurableHealth {
  outstandingAttempts: number;
  cleanupFailures: number;
  oldestOrphanAgeMs: number | null;
  lastReaperAt: string | null;
  reaperFailure: string | null;
}

interface SandboxWorkloadTerminalResult {
  schema: "agent-factory-sandbox-workload-terminal/v1";
  attemptId: string;
  bundleHash: string;
  status: "completed" | "cancelled" | "failed";
  startedAt: string;
  completedAt: string;
  result?: SandboxDeployResult;
  infrastructureCleanup?: SandboxWorkloadExecutionResult["infrastructureCleanup"];
  cleanupReceipt?: SandboxDeployResult["cleanupReceipt"];
  error?: { code: string; message: string };
}

async function brokerProvesAppAbsent(input: {
  brokerOrigin: string;
  appId: string;
  fetchFn: typeof fetch;
  authToken?: string;
}): Promise<void> {
  const response = await input.fetchFn(`${input.brokerOrigin}/v0/gql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    },
    body: JSON.stringify({ query: "{ apps { name } }" }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`sandbox broker absence query returned ${response.status}`);
  const payload = await response.json() as {
    data?: { apps?: Array<{ name?: string }> };
    errors?: unknown[];
  };
  if (payload.errors?.length) throw new Error("sandbox broker absence query failed");
  if ((payload.data?.apps ?? []).some((entry) => entry.name === input.appId)) {
    throw new Error("sandbox broker still contains the workload App");
  }
}

async function pruneExpiredGatewayTombstones(input: {
  brokerOrigin: string;
  authToken: string;
  fetchFn: typeof fetch;
}): Promise<void> {
  const listed = await input.fetchFn(
    `${input.brokerOrigin}/internal/factory-sandbox/tombstones`,
    {
      headers: { authorization: `Bearer ${input.authToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!listed.ok) throw new Error(`sandbox gateway tombstone list returned ${listed.status}`);
  const payload = await listed.json() as {
    schema?: string;
    tombstones?: Array<{ appId?: unknown }>;
  };
  if (
    payload.schema !== "agent-factory-sandbox-gateway-tombstones/v1"
    || !Array.isArray(payload.tombstones)
  ) throw new Error("sandbox gateway tombstone list is invalid");
  for (const entry of payload.tombstones) {
    if (typeof entry.appId !== "string" || !entry.appId.trim()) {
      throw new Error("sandbox gateway tombstone identity is invalid");
    }
    const released = await input.fetchFn(
      `${input.brokerOrigin}/internal/factory-sandbox/tombstones/${encodeURIComponent(entry.appId)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${input.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema: "agent-factory-sandbox-gateway-tombstone-release/v1",
          appId: entry.appId,
          // This helper is invoked only inside the global clean gate below.
          workloadClean: true,
          candidateClean: true,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!released.ok && released.status !== 404) {
      throw new Error(`sandbox gateway tombstone release returned ${released.status}`);
    }
  }
}

async function workloadProvesNoOutstandingAttempts(input: {
  workloadUrl: string;
  workloadToken: string;
  fetchFn: typeof fetch;
}): Promise<void> {
  const response = await input.fetchFn(`${input.workloadUrl}/health`, {
    headers: { authorization: `Bearer ${input.workloadToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`sandbox workload health returned ${response.status}`);
  }
  const body = await response.json() as {
    schema?: string;
    ok?: boolean;
    cleanupReady?: boolean;
    activeExecutions?: number;
    outstandingAttempts?: number;
  };
  if (
    body.schema !== SANDBOX_WORKLOAD_HEALTH_SCHEMA
    || body.ok !== true
    || body.cleanupReady !== true
    || body.activeExecutions !== 0
    || body.outstandingAttempts !== 0
  ) {
    throw new Error(
      `sandbox workload still has ${String(body.outstandingAttempts ?? "unknown")} outstanding attempts`,
    );
  }
}

function cancelFenceExpiry(bundle: SandboxCandidateBundle, jobTtlMs: number, now = new Date()): string {
  const bundleExpiry = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(bundleExpiry)) throw new Error("sandbox bundle expiry is invalid");
  return new Date(Math.max(
    bundleExpiry + SANDBOX_JOB_CLEANUP_MARGIN_MS,
    now.getTime() + jobTtlMs + SANDBOX_JOB_CLEANUP_MARGIN_MS,
  )).toISOString();
}

async function requestWorkloadCancellationFence(input: {
  workloadUrl: string;
  workloadToken: string;
  cancelFenceIntegrityKey: string;
  appPrefix: string;
  bundle: SandboxCandidateBundle;
  expiresAt: string;
  fetchFn: typeof fetch;
}): Promise<SandboxCancelFenceAck> {
  const appId = `${input.appPrefix}-${input.bundle.sandboxTenantSlug}`;
  const response = await input.fetchFn(
    `${input.workloadUrl}/internal/v1/executions/${encodeURIComponent(input.bundle.attemptId)}/cancel`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.workloadToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: "agent-factory-sandbox-workload-cancel/v1",
        attemptId: input.bundle.attemptId,
        bundleHash: input.bundle.bundleHash,
        sandboxTenantSlug: input.bundle.sandboxTenantSlug,
        appId,
        expiresAt: input.expiresAt,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(input.bundle.policy.maxRunMs + 120_000),
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`sandbox workload cancel-fence returned ${response.status}`);
  }
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new Error("sandbox workload cancel-fence acknowledgement is too large");
  }
  return verifySandboxCancelFenceAck(
    JSON.parse(raw),
    {
      attemptId: input.bundle.attemptId,
      bundleHash: input.bundle.bundleHash,
      sandboxTenantSlug: input.bundle.sandboxTenantSlug,
      appId,
    },
    input.cancelFenceIntegrityKey,
  );
}

function remoteWorkloadExecutor(
  config: SandboxRunnerConfig,
  fetchFn: typeof fetch = fetch,
): SandboxCandidateExecutor {
  return async ({ bundle, identity, signal }) => {
    const executeRequest = fetchFn(`${config.workloadUrl}/internal/v1/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.workloadToken}`,
      },
      body: JSON.stringify({
        schema: "agent-factory-sandbox-workload-command/v1",
        bundleHash: bundle.bundleHash,
        bundle,
      }),
      redirect: "error",
      // Do not abort this transport when the control-plane client cancels. The
      // workload must first finish its own App/tenant cleanup and return a
      // terminal proof. Cancellation is delivered on the dedicated endpoint.
      signal: AbortSignal.timeout(bundle.policy.maxRunMs + 120_000),
    });
    let cancelRequest: Promise<SandboxCancelFenceAck> | undefined;
    const requestCancel = () => {
      cancelRequest ??= requestWorkloadCancellationFence({
        workloadUrl: config.workloadUrl,
        workloadToken: config.workloadToken,
        cancelFenceIntegrityKey: config.cancelFenceIntegrityKey,
        appPrefix: config.appPrefix,
        bundle,
        expiresAt: cancelFenceExpiry(bundle, config.jobTtlMs),
        fetchFn,
      });
    };
    if (signal?.aborted) requestCancel();
    else signal?.addEventListener("abort", requestCancel, { once: true });
    let response: Response;
    try {
      response = await executeRequest;
      if (cancelRequest) await cancelRequest;
    } finally {
      signal?.removeEventListener("abort", requestCancel);
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as {
        error?: { code?: string; message?: string };
      };
      if (detail.error?.code === "sandbox_cleanup_failed") {
        throw new SandboxLifecycleBlockedError({
          code: "sandbox_cleanup_failed",
          next: "ask_user",
          question: "外部测试环境没有完成临时 App 的清理证明，我已停止后续 promotion。请检查 sandbox workload 和专用 Inngest broker 后重试。",
          missing: [detail.error.message?.slice(0, 240) || "remote workload cleanup failed"],
        });
      }
      throw new Error(
        detail.error?.message?.slice(0, 240)
          || `sandbox workload returned HTTP ${response.status}`,
      );
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 32 * 1024 * 1024) {
      throw new Error("sandbox workload result exceeded the size limit");
    }
    const terminal = JSON.parse(raw) as SandboxWorkloadTerminalResult;
    if ((terminal as unknown as { schema?: string }).schema === SANDBOX_CANCEL_FENCE_ACK_SCHEMA) {
      verifySandboxCancelFenceAck(
        terminal,
        {
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          sandboxTenantSlug: bundle.sandboxTenantSlug,
          appId: `${config.appPrefix}-${bundle.sandboxTenantSlug}`,
        },
        config.cancelFenceIntegrityKey,
      );
      await Promise.all([
        workloadProvesNoOutstandingAttempts({
          workloadUrl: config.workloadUrl,
          workloadToken: config.workloadToken,
          fetchFn,
        }),
        brokerProvesAppAbsent({
          brokerOrigin: config.brokerOrigin,
          appId: `${config.appPrefix}-${bundle.sandboxTenantSlug}`,
          fetchFn,
          authToken: config.brokerAuthToken,
        }),
      ]);
      throw new SandboxRunnerCancellationError(
        "sandbox workload cancellation fence prevented execution and exact App absence was verified",
      );
    }
    if (
      terminal.schema !== "agent-factory-sandbox-workload-terminal/v1"
      || terminal.attemptId !== bundle.attemptId
      || terminal.bundleHash !== bundle.bundleHash
    ) {
      throw new Error("sandbox workload result identity mismatch");
    }
    if (terminal.status === "cancelled") {
      const cleanupIssues = sandboxCleanupReceiptIssues(terminal.cleanupReceipt, {
        candidateFingerprint: bundle.candidateFingerprint,
        targetDomainId: bundle.targetDomainId,
      });
      if (cleanupIssues.length) {
        throw new SandboxLifecycleBlockedError({
          code: "sandbox_cleanup_failed",
          next: "ask_user",
          question: "取消测试后没有拿到完整的临时 App 清理证明，我已停止后续步骤。请检查 sandbox workload 的清理账本。",
          missing: cleanupIssues.slice(0, 8),
        });
      }
      throw new SandboxRunnerCancellationError();
    }
    if (terminal.status === "failed" && terminal.error?.code === "sandbox_cleanup_failed") {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: "外部测试已经停止，但 workload 没有证明临时 App 和执行资源都已清理。我已冻结 promotion，请先检查 sandbox workload 的清理账本。",
        missing: [terminal.error.message.slice(0, 240)],
      });
    }
    if (terminal.status === "failed") {
      const failureMessage = safeError(
        new Error(terminal.error?.message || "sandbox workload rejected the candidate"),
      ).message;
      try {
        // Some preparation failures have no cleanup receipt. We cannot infer
        // that an App never existed; classify the failure as clean only when
        // the workload ledger and broker independently prove zero residue.
        await Promise.all([
          workloadProvesNoOutstandingAttempts({
            workloadUrl: config.workloadUrl,
            workloadToken: config.workloadToken,
            fetchFn,
          }),
          brokerProvesAppAbsent({
            brokerOrigin: config.brokerOrigin,
            appId: `${config.appPrefix}-${bundle.sandboxTenantSlug}`,
            fetchFn,
            authToken: config.brokerAuthToken,
          }),
        ]);
      } catch (proofError) {
        const proofMessage = safeError(proofError).message;
        throw new SandboxLifecycleBlockedError({
          code: "sandbox_cleanup_failed",
          next: "ask_user",
          question: "外部测试在准备阶段失败了，但目前无法确认临时 App 和运行记录都不存在。我已把 runner 保持在红灯状态，请先检查专用 workload 和 Inngest broker。",
          missing: [failureMessage, proofMessage],
        });
      }
      throw new SandboxRunnerCancellationError(
        `sandbox workload rejected the candidate with zero residual resources independently verified: ${failureMessage}`,
      );
    }
    if (
      terminal.status !== "completed"
      || !terminal.result
      || !terminal.infrastructureCleanup
    ) {
      throw new Error(terminal.error?.message || "sandbox workload failed");
    }
    const workload: SandboxWorkloadExecutionResult = {
      schema: "agent-factory-sandbox-workload-result/v1",
      bundleHash: terminal.bundleHash,
      startedAt: terminal.startedAt,
      completedAt: terminal.completedAt,
      result: terminal.result,
      infrastructureCleanup: terminal.infrastructureCleanup,
    };
    const cleanupIssues = sandboxCleanupReceiptIssues(
      workload.result.cleanupReceipt,
      {
        candidateFingerprint: bundle.candidateFingerprint,
        targetDomainId: bundle.targetDomainId,
      },
    );
    if (
      workload.result.cleanupReceipt?.sandboxAttemptId !== bundle.attemptId
      || workload.result.cleanupReceipt?.sandboxTenantSlug !== bundle.sandboxTenantSlug
    ) cleanupIssues.push("sandbox workload cleanup attempt identity mismatch");
    if (cleanupIssues.length) {
      throw new Error(`sandbox workload cleanup evidence is invalid: ${cleanupIssues.join("; ")}`);
    }
    // The signer does not trust the executor's claim that deletion happened.
    // It independently queries the dedicated broker after the workload has
    // returned and only then creates the HMAC execution attestation.
    await brokerProvesAppAbsent({
      brokerOrigin: config.brokerOrigin,
      appId: workload.result.appId,
      fetchFn,
      authToken: config.brokerAuthToken,
    });
    // A replay miss or an accidental live dispatch is a candidate/test failure,
    // not evidence that cleanup failed. Return the signed control envelope with
    // the cleaned red result so the Factory can revise and create a fresh
    // attempt. It deliberately has no promotion execution receipt.
    if (
      workload.result.externalLiveCalls !== 0
      || workload.result.sandboxReplayEvidenceComplete !== true
    ) {
      return { ...workload.result, executionReceipt: undefined };
    }
    const executionReceipt = attestSandboxCandidateResult({
      bundle,
      result: workload.result,
      identity,
      startedAt: workload.startedAt,
      completedAt: workload.completedAt,
      infrastructureCleanup: workload.infrastructureCleanup,
    });
    return { ...workload.result, executionReceipt };
  };
}

function resultPayload(job: RunnerJob): RemoteSandboxJobResult<SandboxDeployResult> {
  return {
    schema: REMOTE_SANDBOX_RESULT_SCHEMA,
    attemptId: job.attemptId,
    bundleHash: job.bundleHash,
    status: job.status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

interface RunnerJobJournal {
  schema: "agent-factory-sandbox-runner-job/v1";
  attemptId: string;
  bundleHash: string;
  bundle: SandboxCandidateBundle;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  result?: SandboxDeployResult;
  error?: { code: string; message: string };
  integrityMac: string;
}

function journalFile(dir: string, attemptId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(attemptId)) {
    throw new Error("invalid sandbox runner journal attempt id");
  }
  return path.join(dir, `${attemptId}.json`);
}

function evidenceMac(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

function exactMac(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Atomic rename is not a durability boundary until both the file and parent
 * directory metadata have reached stable storage. The runner fails closed if
 * either fsync cannot be completed. */
function durableAtomicWrite(destination: string, content: string): void {
  const directory = path.dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let file = -1;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, content, { encoding: "utf8" });
    fsyncSync(file);
  } finally {
    if (file >= 0) closeSync(file);
  }
  renameSync(temporary, destination);
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function persistJob(dir: string, job: RunnerJob, integrityKey: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body: Omit<RunnerJobJournal, "integrityMac"> = {
    schema: "agent-factory-sandbox-runner-job/v1",
    attemptId: job.attemptId,
    bundleHash: job.bundleHash,
    bundle: job.bundle,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
  const journal: RunnerJobJournal = {
    ...body,
    integrityMac: evidenceMac(integrityKey, body),
  };
  const destination = journalFile(dir, job.attemptId);
  durableAtomicWrite(destination, `${JSON.stringify(journal)}\n`);
}

function loadJobJournals(
  dir: string,
  now: number,
  integrityKey: string,
): Map<string, RunnerJob> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jobs = new Map<string, RunnerJob>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const full = path.join(dir, name);
    let journal: RunnerJobJournal;
    try {
      journal = JSON.parse(readFileSync(full, "utf8")) as RunnerJobJournal;
    } catch (error) {
      throw new Error(`sandbox runner job journal is unreadable: ${name}: ${safeError(error).message}`);
    }
    if (
      journal.schema !== "agent-factory-sandbox-runner-job/v1"
      || journal.attemptId !== name.slice(0, -5)
      || journal.bundleHash !== journal.bundle?.bundleHash
      || journal.attemptId !== journal.bundle?.attemptId
    ) {
      throw new Error(`sandbox runner job journal identity mismatch: ${name}`);
    }
    const { integrityMac, ...body } = journal;
    if (!exactMac(integrityMac, evidenceMac(integrityKey, body))) {
      throw new Error(`sandbox runner job journal integrity check failed: ${name}`);
    }
    const interrupted = ["accepted", "running", "cleanup_pending"].includes(journal.status);
    const job: RunnerJob = {
      attemptId: journal.attemptId,
      bundleHash: journal.bundleHash,
      bundle: journal.bundle,
      // A restarted job is neither a functional failure nor confirmed dirty.
      // Keep it in cleanup_pending until workload readiness + broker absence
      // independently prove the interrupted attempt is gone.
      status: interrupted ? "cleanup_pending" : journal.status,
      createdAt: journal.createdAt,
      updatedAt: interrupted ? now : journal.updatedAt,
      controller: new AbortController(),
      ...(journal.result ? { result: journal.result } : {}),
      ...(interrupted
        ? {
            error: {
              code: "runner_restarted",
              message: "Runner restarted while this job was active; orphan cleanup ran before control traffic resumed.",
            },
          }
        : journal.error
          ? { error: journal.error }
          : {}),
    };
    jobs.set(job.attemptId, job);
    if (interrupted) persistJob(dir, job, integrityKey);
  }
  return jobs;
}

function nonceLedgerFile(dir: string): string {
  return path.join(dir, "consumed-nonces.ndjson");
}

function nonceLedgerLine(expiresAt: string, nonce: string, integrityKey: string): string {
  const body = { expiresAt, nonce };
  return `${expiresAt}\t${nonce}\t${evidenceMac(integrityKey, body)}`;
}

function loadConsumedNonces(
  dir: string,
  now: number,
  integrityKey: string,
): Set<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const active = new Map<string, string>();
    for (const line of readFileSync(nonceLedgerFile(dir), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [expiresText, nonce, integrityMac, ...extra] = line.split("\t");
      const expiresAt = Date.parse(expiresText ?? "");
      if (
        extra.length
        || !nonce
        || !Number.isFinite(expiresAt)
        || !exactMac(
          integrityMac,
          evidenceMac(integrityKey, { expiresAt: expiresText, nonce }),
        )
      ) {
        throw new Error("sandbox runner nonce ledger integrity check failed");
      }
      if (expiresAt >= now - 5_000) active.set(nonce, expiresText!);
    }
    // Compact expired replay entries without changing their signed expiry.
    // Extending or shortening nonce lifetime during restart would make replay
    // behavior depend on process timing instead of the original envelope.
    durableAtomicWrite(
      nonceLedgerFile(dir),
      [...active].map(([nonce, expiresAt]) =>
        nonceLedgerLine(expiresAt, nonce, integrityKey)).join("\n")
        + (active.size ? "\n" : ""),
    );
    return new Set(active.keys());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

function persistConsumedNonce(
  dir: string,
  nonce: string,
  expiresAt: string,
  integrityKey: string,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = openSync(nonceLedgerFile(dir), "a", 0o600);
  try {
    writeSync(file, `${nonceLedgerLine(expiresAt, nonce, integrityKey)}\n`, undefined, "utf8");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  const parent = openSync(dir, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export interface SandboxRunnerHealth {
  ok: boolean;
  broker: "ready" | "unreachable";
  storage: "ready" | "unwritable";
  jobs: Record<string, number>;
  controlLastReaperAt: string | null;
  workloadLastReaperAt: string | null;
  lastReaperAt: string | null;
  outstandingAttempts: number;
  workloadReady: boolean;
  workloadCleanupReady: boolean;
  workloadActiveExecutions: number;
  failedJobs: number;
  cleanupFailures: number;
  oldestOrphanAgeMs: number | null;
  reaperFailure: string | null;
}

export interface SandboxRunnerJobService {
  jobs: ReadonlyMap<string, RunnerJob>;
  close(): void;
  health(): Promise<SandboxRunnerHealth>;
}

export async function registerSandboxRunnerJobRoutes(input: {
  app: FastifyInstance;
  config: SandboxRunnerConfig;
  execute?: SandboxCandidateExecutor;
  now?: () => Date;
  fetchFn?: typeof fetch;
}): Promise<SandboxRunnerJobService> {
  const execute = input.execute ?? remoteWorkloadExecutor(input.config, input.fetchFn);
  const now = input.now ?? (() => new Date());
  const fetchFn = input.fetchFn ?? fetch;
  const jobs = loadJobJournals(
    input.config.journalDir,
    now().getTime(),
    input.config.resultSigningKey,
  );
  const consumedNonces = loadConsumedNonces(
    input.config.journalDir,
    now().getTime(),
    input.config.requestSigningKey,
  );
  let queue: Promise<void> = Promise.resolve();
  let lastReaperAt: string | null = null;
  let reaperFailure: string | null = null;

  const signed = (job: RunnerJob) => signRemoteSandboxMessage({
    purpose: "result",
    keyId: input.config.keyId,
    secret: input.config.resultSigningKey,
    payload: resultPayload(job),
    now: now(),
  });
  const verify = <T>(raw: unknown, purpose: "submit" | "status" | "cancel"): T => {
    if (!raw || typeof raw !== "object" || (raw as { schema?: unknown }).schema !== REMOTE_SANDBOX_ENVELOPE_SCHEMA) {
      throw new RemoteSandboxProtocolError("invalid_envelope", "Signed runner envelope is required");
    }
    const envelope = raw as SignedRemoteSandboxMessage<T>;
    const payload = verifyRemoteSandboxMessage(envelope, {
      expectedPurpose: purpose,
      expectedKeyId: input.config.keyId,
      secret: input.config.requestSigningKey,
      now: now(),
      consumedNonces,
    });
    persistConsumedNonce(
      input.config.journalDir,
      envelope.nonce,
      envelope.expiresAt,
      input.config.requestSigningKey,
    );
    return payload;
  };
  const exactJob = (attemptId: string, bundleHash: string): RunnerJob => {
    const job = jobs.get(attemptId);
    if (!job || job.bundleHash !== bundleHash) {
      throw new RemoteSandboxProtocolError(
        "job_identity_mismatch",
        "Sandbox job does not exist or has a different bundle identity",
      );
    }
    return job;
  };
  const run = async (job: RunnerJob): Promise<void> => {
    if (job.status === "cancelled") return;
    job.status = "running";
    job.updatedAt = now().getTime();
    persistJob(input.config.journalDir, job, input.config.resultSigningKey);
    try {
      job.result = await execute({
        bundle: job.bundle,
        identity: input.config.identity,
        signal: job.controller.signal,
        now,
      });
      job.status = "completed";
    } catch (error) {
      job.error = safeError(error);
      const cleanupFailed = error instanceof SandboxLifecycleBlockedError
        && error.block.code === "sandbox_cleanup_failed";
      const cleanupConfirmed = error instanceof SandboxRunnerCancellationError;
      job.status = cleanupConfirmed && !cleanupFailed
        ? "cancelled"
        : "failed";
    } finally {
      job.updatedAt = now().getTime();
      persistJob(input.config.journalDir, job, input.config.resultSigningKey);
    }
  };

  const healthSnapshot = async (): Promise<SandboxRunnerHealth> => {
    let storage: SandboxRunnerHealth["storage"] = "unwritable";
    const probe = path.join(input.config.journalDir, `.health-${randomUUID()}`);
    try {
      writeFileSync(probe, "ok", { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (readFileSync(probe, "utf8") === "ok") storage = "ready";
    } catch {
      storage = "unwritable";
    } finally {
      rmSync(probe, { force: true });
    }

    let broker: SandboxRunnerHealth["broker"] = "unreachable";
    try {
      const response = await fetchFn(`${input.config.brokerOrigin}/v0/gql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.config.brokerAuthToken
            ? { authorization: `Bearer ${input.config.brokerAuthToken}` }
            : {}),
        },
        body: JSON.stringify({ query: "{ apps { name } }" }),
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) broker = "ready";
    } catch {
      broker = "unreachable";
    }

    // Recovery is attempt-specific. A globally empty workload/broker is not a
    // cancellation proof because an old execute or App registration may still
    // arrive. Persist the exact attempt+bundle fence in the workload first.
    const recoveryFences = new Set<string>();
    for (const job of jobs.values()) {
      const interrupted = job.status === "cleanup_pending"
        && !job.settled
        && job.error?.code === "runner_restarted";
      const persistedCleanableFailure = job.status === "failed"
        && !job.settled
        && job.error?.code !== "sandbox_cleanup_failed";
      if (!interrupted && !persistedCleanableFailure) continue;
      try {
        await requestWorkloadCancellationFence({
          workloadUrl: input.config.workloadUrl,
          workloadToken: input.config.workloadToken,
          cancelFenceIntegrityKey: input.config.cancelFenceIntegrityKey,
          appPrefix: input.config.appPrefix,
          bundle: job.bundle,
          expiresAt: cancelFenceExpiry(job.bundle, input.config.jobTtlMs, now()),
          fetchFn,
        });
        recoveryFences.add(job.attemptId);
      } catch {
        // Keep the exact job red. Health below may still report the workload's
        // global state, but it can no longer turn that into a cancellation.
      }
    }

    let outstandingAttempts = 0;
    let workloadReady = false;
    let workloadCleanupReady = false;
    let workloadActiveExecutions = -1;
    let workloadCleanupFailures = 0;
    let workloadOldestOrphanAgeMs: number | null = null;
    let workloadLastReaperAt: string | null = null;
    let workloadReaperFailure: string | null = null;
    try {
      const response = await fetchFn(`${input.config.workloadUrl}/health`, {
        headers: { authorization: `Bearer ${input.config.workloadToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      const body = response.ok
        ? await response.json() as {
            schema?: string;
            ok?: boolean;
            cleanupReady?: boolean;
            activeExecutions?: number;
            outstandingAttempts?: number;
            cleanupFailures?: number;
            oldestOrphanAgeMs?: number | null;
            lastReaperAt?: string | null;
            reaperFailure?: string | null;
          }
        : {};
      const reportedAttempts = body.outstandingAttempts;
      const reportedActive = body.activeExecutions;
      const reportedCleanupFailures = body.cleanupFailures;
      const reportedOrphanAge = body.oldestOrphanAgeMs;
      const reportedLastReaperAt = body.lastReaperAt;
      const validReaperTimestamp = typeof reportedLastReaperAt === "string"
        && Number.isFinite(Date.parse(reportedLastReaperAt));
      if (
        body.schema === SANDBOX_WORKLOAD_HEALTH_SCHEMA
        && body.ok === true
        && typeof body.cleanupReady === "boolean"
        && typeof reportedActive === "number"
        && Number.isSafeInteger(reportedActive)
        && reportedActive >= 0
        && typeof reportedAttempts === "number"
        && Number.isSafeInteger(reportedAttempts)
        && reportedAttempts >= 0
        && typeof reportedCleanupFailures === "number"
        && Number.isSafeInteger(reportedCleanupFailures)
        && reportedCleanupFailures >= 0
        && (reportedOrphanAge === null
          || (typeof reportedOrphanAge === "number"
            && Number.isSafeInteger(reportedOrphanAge)
            && reportedOrphanAge >= 0))
        && validReaperTimestamp
        && (body.reaperFailure === null || typeof body.reaperFailure === "string")
      ) {
        workloadReady = true;
        workloadCleanupReady = body.cleanupReady;
        workloadActiveExecutions = reportedActive;
        outstandingAttempts = reportedAttempts;
        workloadCleanupFailures = reportedCleanupFailures;
        workloadOldestOrphanAgeMs = reportedOrphanAge ?? null;
        workloadLastReaperAt = reportedLastReaperAt;
        workloadReaperFailure = body.reaperFailure ?? null;
      }
    } catch {
      workloadReady = false;
    }

    // After a control restart there is no in-memory execution to await. Only
    // the restarted workload's clean ledger plus an independent broker query
    // can turn an interrupted or non-cleanup failed journal into a safe
    // cancellation. Explicit cleanup failures remain red and require repair.
    if (
      broker === "ready"
      && workloadReady
      && workloadCleanupReady
      && workloadActiveExecutions === 0
      && outstandingAttempts === 0
    ) {
      for (const job of jobs.values()) {
        const interrupted = job.status === "cleanup_pending"
          && !job.settled
          && job.error?.code === "runner_restarted";
        const persistedCleanableFailure = job.status === "failed"
          && !job.settled
          && job.error?.code !== "sandbox_cleanup_failed";
        if (
          (!interrupted && !persistedCleanableFailure)
          || !recoveryFences.has(job.attemptId)
        ) continue;
        try {
          await brokerProvesAppAbsent({
            brokerOrigin: input.config.brokerOrigin,
            appId: `${input.config.appPrefix}-${job.bundle.sandboxTenantSlug}`,
            fetchFn,
            authToken: input.config.brokerAuthToken,
          });
          job.status = "cancelled";
          job.error = {
            code: persistedCleanableFailure
              ? "runner_failure_absence_verified"
              : "runner_restarted_cleanup_verified",
            message: persistedCleanableFailure
              ? "Persisted failure was cancelled after an exact durable workload fence, clean workload ledger and broker absence verification."
              : "Interrupted job was cancelled after an exact durable workload fence, clean workload ledger and broker absence verification.",
          };
          job.updatedAt = now().getTime();
          persistJob(input.config.journalDir, job, input.config.resultSigningKey);
        } catch {
          // Keep the original red state; readiness below remains red.
        }
      }
    }

    const counts: Record<string, number> = {};
    let controlOldestOrphanAgeMs: number | null = null;
    const current = now().getTime();
    for (const job of jobs.values()) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      if (job.status !== "cleanup_pending" && job.status !== "failed") continue;
      const age = Math.max(0, current - job.updatedAt);
      controlOldestOrphanAgeMs = Math.max(controlOldestOrphanAgeMs ?? 0, age);
    }
    const failedJobs = counts.failed ?? 0;
    const controlCleanupFailures = [...jobs.values()].filter(
      (job) => job.status === "failed" && job.error?.code === "sandbox_cleanup_failed",
    ).length;
    const cleanupFailures = controlCleanupFailures + workloadCleanupFailures;
    const unhealthyJobs = (counts.cleanup_pending ?? 0) + failedJobs;
    const oldestOrphanAgeMs = [
      controlOldestOrphanAgeMs,
      workloadOldestOrphanAgeMs,
    ].reduce<number | null>(
      (oldest, age) => age === null ? oldest : Math.max(oldest ?? 0, age),
      null,
    );
    const combinedReaperFailure = [
      reaperFailure ? `control: ${reaperFailure}` : null,
      workloadReaperFailure ? `workload: ${workloadReaperFailure}` : null,
    ].filter((entry): entry is string => Boolean(entry)).join("; ") || null;
    const combinedLastReaperAt = lastReaperAt && workloadLastReaperAt
      ? new Date(Math.min(
          Date.parse(lastReaperAt),
          Date.parse(workloadLastReaperAt),
        )).toISOString()
      : null;
    return {
      ok: broker === "ready"
        && storage === "ready"
        && !combinedReaperFailure
        && workloadReady
        && workloadCleanupReady
        && workloadActiveExecutions === 0
        && outstandingAttempts === 0
        && cleanupFailures === 0
        && unhealthyJobs === 0,
      broker,
      storage,
      jobs: counts,
      controlLastReaperAt: lastReaperAt,
      workloadLastReaperAt,
      lastReaperAt: combinedLastReaperAt,
      outstandingAttempts,
      workloadReady,
      workloadCleanupReady,
      workloadActiveExecutions,
      failedJobs,
      cleanupFailures,
      oldestOrphanAgeMs,
      reaperFailure: combinedReaperFailure,
    };
  };

  input.app.post("/internal/v1/sandbox-jobs", async (request, reply) => {
    try {
      const command = verify<RemoteSandboxSubmitCommand<SandboxCandidateBundle>>(
        request.body,
        "submit",
      );
      if (
        command.schema !== "agent-factory-sandbox-submit/v1"
        || command.attemptId !== command.bundle.attemptId
        || command.bundleHash !== command.bundle.bundleHash
      ) {
        throw new RemoteSandboxProtocolError(
          "submit_identity_mismatch",
          "Sandbox submit command and bundle identities differ",
        );
      }
      if (
        input.config.jobTtlMs <
          command.bundle.policy.maxRunMs + SANDBOX_JOB_CLEANUP_MARGIN_MS
      ) {
        throw new RemoteSandboxProtocolError(
          "job_ttl_too_short",
          "Sandbox runner job TTL is shorter than this bundle's maxRunMs plus the required cleanup margin",
        );
      }
      const prior = jobs.get(command.attemptId);
      if (prior) {
        if (prior.bundleHash !== command.bundleHash) {
          throw new RemoteSandboxProtocolError(
            "job_identity_collision",
            "Sandbox attempt id is already bound to another bundle",
          );
        }
        return reply.send(signed(prior));
      }
      const readiness = await healthSnapshot();
      if (!readiness.ok) {
        throw new RemoteSandboxProtocolError(
          "runner_not_ready",
          `Sandbox runner is not ready (broker=${readiness.broker}, workload=${readiness.workloadReady}, failedJobs=${readiness.failedJobs}, cleanupFailures=${readiness.cleanupFailures}, outstanding=${readiness.outstandingAttempts})`,
        );
      }
      const timestamp = now().getTime();
      const job: RunnerJob = {
        attemptId: command.attemptId,
        bundleHash: command.bundleHash,
        bundle: command.bundle,
        status: "accepted",
        createdAt: timestamp,
        updatedAt: timestamp,
        controller: new AbortController(),
      };
      jobs.set(job.attemptId, job);
      persistJob(input.config.journalDir, job, input.config.resultSigningKey);
      queue = queue.then(() => run(job), () => run(job));
      job.settled = queue;
      void queue.catch(() => undefined);
      return reply.code(202).send(signed(job));
    } catch (error) {
      const safe = safeError(error);
      return reply.code(error instanceof RemoteSandboxProtocolError ? 400 : 500).send(safe);
    }
  });

  input.app.post("/internal/v1/sandbox-jobs/:attemptId/status", async (request, reply) => {
    try {
      const attemptId = (request.params as { attemptId: string }).attemptId;
      const command = verify<RemoteSandboxAttemptCommand>(request.body, "status");
      if (command.schema !== "agent-factory-sandbox-status/v1" || command.attemptId !== attemptId) {
        throw new RemoteSandboxProtocolError("status_identity_mismatch", "Sandbox status identity mismatch");
      }
      return reply.send(signed(exactJob(attemptId, command.bundleHash)));
    } catch (error) {
      return reply.code(400).send(safeError(error));
    }
  });

  input.app.post("/internal/v1/sandbox-jobs/:attemptId/cancel", async (request, reply) => {
    try {
      const attemptId = (request.params as { attemptId: string }).attemptId;
      const command = verify<RemoteSandboxAttemptCommand>(request.body, "cancel");
      if (command.schema !== "agent-factory-sandbox-cancel/v1" || command.attemptId !== attemptId) {
        throw new RemoteSandboxProtocolError("cancel_identity_mismatch", "Sandbox cancel identity mismatch");
      }
      const job = exactJob(attemptId, command.bundleHash);
      if (!["completed", "failed", "cancelled"].includes(job.status)) {
        await requestWorkloadCancellationFence({
          workloadUrl: input.config.workloadUrl,
          workloadToken: input.config.workloadToken,
          cancelFenceIntegrityKey: input.config.cancelFenceIntegrityKey,
          appPrefix: input.config.appPrefix,
          bundle: job.bundle,
          expiresAt: cancelFenceExpiry(job.bundle, input.config.jobTtlMs, now()),
          fetchFn,
        });
      }
      if (job.status === "accepted") job.status = "cancelled";
      else if (job.status === "running") job.status = "cleanup_pending";
      if (job.status !== "completed" && job.status !== "failed") {
        job.controller.abort(new Error("sandbox job cancelled by control plane"));
      }
      job.updatedAt = now().getTime();
      persistJob(input.config.journalDir, job, input.config.resultSigningKey);
      if (job.status === "cleanup_pending" && job.settled) {
        await job.settled;
      }
      if (job.status !== "cancelled") {
        throw new RemoteSandboxProtocolError(
          "cancel_cleanup_unconfirmed",
          "Sandbox cancellation did not reach a verified cancelled state",
        );
      }
      return reply.send(signed(job));
    } catch (error) {
      return reply.code(400).send(safeError(error));
    }
  });

  const reap = (): void => {
    try {
      const current = now().getTime();
      for (const [attemptId, job] of jobs) {
        const age = current - job.updatedAt;
        if ((job.status === "running" || job.status === "cleanup_pending") && age > input.config.jobTtlMs) {
          job.status = "cleanup_pending";
          job.controller.abort(new Error("sandbox runner job lease expired"));
          job.updatedAt = current;
          persistJob(input.config.journalDir, job, input.config.resultSigningKey);
        } else if (["completed", "cancelled"].includes(job.status) && age > input.config.jobTtlMs) {
          jobs.delete(attemptId);
          rmSync(journalFile(input.config.journalDir, attemptId), { force: true });
        }
      }
      if (consumedNonces.size > 50_000) {
        throw new Error("sandbox runner nonce ledger capacity exceeded");
      }
      reaperFailure = null;
      lastReaperAt = new Date(current).toISOString();
    } catch (error) {
      reaperFailure = safeError(error).message;
    }
  };
  // Readiness must report a real successful pass, not merely the timestamp at
  // which the process happened to start. Run the same bounded reaper once
  // before serving health/submit traffic, then continue on the interval.
  reap();
  const reaper = setInterval(reap, input.config.reaperMs);
  reaper.unref?.();

  return {
    jobs,
    close() {
      clearInterval(reaper);
      for (const job of jobs.values()) {
        if (job.status === "running" || job.status === "cleanup_pending") {
          job.controller.abort(new Error("sandbox runner shutting down"));
        }
      }
    },
    health: healthSnapshot,
  };
}

export async function buildSandboxRunnerControl(input: {
  config: SandboxRunnerConfig;
  execute?: SandboxCandidateExecutor;
  now?: () => Date;
  fetchFn?: typeof fetch;
}): Promise<FastifyInstance> {
  const now = input.now ?? (() => new Date());
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 32 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });
  const jobs = await registerSandboxRunnerJobRoutes({ app, ...input });
  await registerSandboxRunnerDeleteControl(app, {
    token: input.config.deleteToken,
    brokerOrigin: input.config.brokerOrigin,
    appPrefix: input.config.appPrefix,
    brokerAuthToken: input.config.brokerAuthToken,
    fetchFn: input.fetchFn,
  });
  // Process liveness, authenticated delete-control readiness and signed deep
  // cleanup health are deliberately three different signals. In particular,
  // liveness must never be consumed as promotion/readiness evidence.
  app.get("/live", async () => ({
    schema: "agent-factory-sandbox-runner-liveness/v1",
    alive: true,
  }));
  app.get("/health", async (_request, reply) => {
    const health = await jobs.health();
    const body = signRemoteSandboxRunnerHealth({
      role: "agent-factory-sandbox-runner",
      keyId: input.config.keyId,
      runnerId: input.config.identity.runnerId,
      runnerBuildId: input.config.identity.runnerBuildId,
      runtimeImageDigest: input.config.identity.runtimeImageDigest,
      isolationTier: input.config.identity.actualIsolationTier,
      platformAttestation:
        input.config.identity.platformAttestation ?? null,
      checkedAt: now().toISOString(),
      ...health,
      // The API only needs the failure bit. Never expose a Docker error,
      // filesystem path, credential fragment or tenant detail on this route.
      reaperFailure: health.reaperFailure === null ? null : "reaper_failed",
    }, input.config.resultSigningKey);
    return reply.code(health.ok ? 200 : 503).send(body);
  });
  app.addHook("onClose", async () => jobs.close());
  return app;
}

interface ActiveWorkloadExecution {
  bundle: SandboxCandidateBundle;
  controller: AbortController;
  settled: Promise<SandboxWorkloadTerminalResult>;
}

function verifiedCancelledWorkloadTerminal(input: {
  bundle: SandboxCandidateBundle;
  startedAt: string;
  completedAt: string;
  error: unknown;
}): SandboxWorkloadTerminalResult | null {
  const attempt = listSandboxAttempts().find((row) => row.id === input.bundle.attemptId);
  const cleanupReceipt = attempt?.cleanupReceipt as SandboxDeployResult["cleanupReceipt"];
  const issues = sandboxCleanupReceiptIssues(cleanupReceipt, {
    candidateFingerprint: input.bundle.candidateFingerprint,
    targetDomainId: input.bundle.targetDomainId,
  });
  if (
    attempt?.status !== "cleanup_verified"
    || attempt.remoteMayExist !== false
    || cleanupReceipt?.sandboxAttemptId !== input.bundle.attemptId
    || cleanupReceipt?.sandboxTenantSlug !== input.bundle.sandboxTenantSlug
    || issues.length > 0
  ) return null;
  return {
    schema: "agent-factory-sandbox-workload-terminal/v1",
    attemptId: input.bundle.attemptId,
    bundleHash: input.bundle.bundleHash,
    status: "cancelled",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    cleanupReceipt,
    error: safeError(input.error),
  };
}

export async function buildSandboxRunnerWorkload(input: {
  config: SandboxWorkloadConfig;
  execute?: SandboxWorkloadExecutor;
  now?: () => Date;
  fetchFn?: typeof fetch;
  durableHealth?: (
    activeAttemptIds: ReadonlySet<string>,
    now: Date,
  ) => Promise<SandboxWorkloadDurableHealth> | SandboxWorkloadDurableHealth;
  reconcileCancellation?: (activeAttemptIds: ReadonlySet<string>) => Promise<void>;
  candidateReaper: SandboxCodeActCandidateReaperLike;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 32 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });
  const execute = input.execute
    ?? (await import("./services/agent-factory/sandbox-runner-executor"))
      .executeSandboxCandidateBundleWorkload;
  const now = input.now ?? (() => new Date());
  const fetchFn = input.fetchFn ?? fetch;
  const durableHealth = input.durableHealth ?? (async (
    activeAttemptIds: ReadonlySet<string>,
    current: Date,
  ): Promise<SandboxWorkloadDurableHealth> => {
    const sandboxReaper = await import("./services/agent-factory/sandbox-reaper");
    const rows = listOutstandingSandboxAttempts({
      excludeAttemptIds: new Set(activeAttemptIds),
    });
    return {
      ...sandboxReaper.summarizeFactorySandboxOrphans(rows, current),
      ...sandboxReaper.getFactorySandboxReaperTelemetry(),
    };
  });
  const active = new Map<string, ActiveWorkloadExecution>();
  const candidateReaper = input.candidateReaper;
  const cancelFences = new SandboxCancelFenceStore(
    input.config.cancelFenceDir,
    input.config.cancelFenceIntegrityKey,
    input.config.cancelFenceMaxEntries,
  );
  const reconcileCancellation = input.reconcileCancellation ?? (async (
    activeAttemptIds: ReadonlySet<string>,
  ) => {
    const sandboxReaper = await import("./services/agent-factory/sandbox-reaper");
    await sandboxReaper.reconcileFactorySandboxOrphans();
    await candidateReaper.reconcile({ activeAttemptIds });
  });
  await candidateReaper.reconcile({ startup: true, activeAttemptIds: new Set() });
  candidateReaper.start(() => new Set(active.keys()));
  const terminal = new Map<string, SandboxWorkloadTerminalResult>();
  const rememberTerminal = (attemptId: string, outcome: SandboxWorkloadTerminalResult) => {
    terminal.set(attemptId, outcome);
    // The control journal is the durable source of truth. This workload cache
    // only serves short idempotent retries and must stay bounded in a
    // long-lived service.
    while (terminal.size > 512) {
      const oldest = terminal.keys().next().value as string | undefined;
      if (!oldest) break;
      terminal.delete(oldest);
    }
  };
  const cancelAck = (
    fence: ReturnType<SandboxCancelFenceStore["fence"]>,
    outcome?: SandboxWorkloadTerminalResult,
  ): SandboxCancelFenceAck => signSandboxCancelFenceAck(
    input.config.cancelFenceIntegrityKey,
    {
      schema: SANDBOX_CANCEL_FENCE_ACK_SCHEMA,
      attemptId: fence.attemptId,
      bundleHash: fence.bundleHash,
      sandboxTenantSlug: fence.sandboxTenantSlug,
      appId: fence.appId,
      status: outcome ? "terminal" : "cancel_fenced",
      fencedAt: fence.fencedAt,
      expiresAt: fence.expiresAt,
      ...(outcome
        ? {
            terminalStatus: outcome.status,
            terminalCompletedAt: outcome.completedAt,
          }
        : {}),
    },
  );

  const { inngestRoute } = await import("./routes/inngest");
  await inngestRoute(app);

  app.post("/internal/v1/execute", async (request, reply) => {
    if (!exactBearer(request.headers.authorization, input.config.token)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "unauthorized" } });
    }
    await candidateReaper.reconcile({ activeAttemptIds: new Set(active.keys()) });
    const candidateCleanup = candidateReaper.telemetry();
    if (
      candidateCleanup.candidateReaperFailure
      || !candidateCleanup.candidateCleanupReady
    ) {
      return reply.code(503).send({
        error: {
          code: "sandbox_candidate_cleanup_pending",
          message: candidateCleanup.candidateReaperFailure
            ?? `${candidateCleanup.orphanCandidates} candidate container(s) await verified cleanup`,
        },
      });
    }
    const command = request.body as {
      schema?: unknown;
      bundleHash?: unknown;
      bundle?: SandboxCandidateBundle;
    };
    if (
      command?.schema !== "agent-factory-sandbox-workload-command/v1"
      || typeof command.bundleHash !== "string"
      || !command.bundle
      || command.bundleHash !== command.bundle.bundleHash
      || command.bundle.attemptId.length === 0
    ) {
      return reply.code(400).send({
        error: { code: "workload_command_invalid", message: "workload command identity is invalid" },
      });
    }
    const bundle = command.bundle;
    const previous = terminal.get(bundle.attemptId);
    if (previous) {
      return previous.bundleHash === bundle.bundleHash
        ? reply.send(previous)
        : reply.code(409).send({ error: { code: "attempt_collision", message: "attempt id collision" } });
    }
    const existing = active.get(bundle.attemptId);
    if (existing) {
      return existing.bundle.bundleHash === bundle.bundleHash
        ? reply.send(await existing.settled)
        : reply.code(409).send({ error: { code: "attempt_collision", message: "attempt id collision" } });
    }
    const fenced = cancelFences.get(bundle.attemptId);
    if (fenced) {
      if (
        fenced.bundleHash !== bundle.bundleHash
        || fenced.sandboxTenantSlug !== bundle.sandboxTenantSlug
        || fenced.appId !== `${input.config.appPrefix}-${bundle.sandboxTenantSlug}`
      ) {
        return reply.code(409).send({
          error: { code: "attempt_collision", message: "cancelled attempt is bound to another bundle/App" },
        });
      }
      try {
        // A late execute is cleanup-only. It never enters the executor path
        // that creates a tenant, registers an App or starts a candidate.
        await reconcileCancellation(new Set(active.keys()));
        return reply.send(cancelAck(fenced));
      } catch (error) {
        return reply.code(503).send({
          error: {
            code: "sandbox_cleanup_failed",
            message: safeError(error).message,
          },
        });
      }
    }
    if (active.size > 0) {
      return reply.code(429).send({ error: { code: "workload_busy", message: "workload already has an active candidate" } });
    }
    const controller = new AbortController();
    const startedAt = now().toISOString();
    const settled = (async (): Promise<SandboxWorkloadTerminalResult> => {
      try {
        const workload = await execute({ bundle, signal: controller.signal, now });
        return {
          schema: "agent-factory-sandbox-workload-terminal/v1",
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          status: "completed",
          startedAt: workload.startedAt,
          completedAt: workload.completedAt,
          result: workload.result,
          infrastructureCleanup: workload.infrastructureCleanup,
        };
      } catch (error) {
        const completedAt = now().toISOString();
        const cancelled = controller.signal.aborted
          ? verifiedCancelledWorkloadTerminal({ bundle, startedAt, completedAt, error })
          : null;
        if (cancelled) return cancelled;
        return {
          schema: "agent-factory-sandbox-workload-terminal/v1",
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          status: "failed",
          startedAt,
          completedAt,
          error: controller.signal.aborted
            ? {
                code: "sandbox_cleanup_failed",
                message: "cancelled workload did not produce verified cleanup evidence",
              }
            : safeError(error),
        };
      } finally {
        active.delete(bundle.attemptId);
        await candidateReaper.reconcile({ activeAttemptIds: new Set(active.keys()) });
      }
    })();
    active.set(bundle.attemptId, { bundle, controller, settled });
    const outcome = await settled;
    rememberTerminal(bundle.attemptId, outcome);
    return reply.send(outcome);
  });

  app.post("/internal/v1/executions/:attemptId/cancel", async (request, reply) => {
    if (!exactBearer(request.headers.authorization, input.config.token)) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "unauthorized" } });
    }
    const attemptId = (request.params as { attemptId: string }).attemptId;
    const command = request.body as {
      schema?: unknown;
      attemptId?: unknown;
      bundleHash?: unknown;
      sandboxTenantSlug?: unknown;
      appId?: unknown;
      expiresAt?: unknown;
    };
    const expiresAt = typeof command.expiresAt === "string"
      ? Date.parse(command.expiresAt)
      : Number.NaN;
    if (
      command.schema !== "agent-factory-sandbox-workload-cancel/v1"
      || command.attemptId !== attemptId
      || typeof command.bundleHash !== "string"
      || typeof command.sandboxTenantSlug !== "string"
      || typeof command.appId !== "string"
      || command.appId !== `${input.config.appPrefix}-${command.sandboxTenantSlug}`
      || !Number.isFinite(expiresAt)
      || expiresAt <= now().getTime()
      || expiresAt > now().getTime() + 30 * 24 * 60 * 60_000
    ) {
      return reply.code(400).send({
        error: { code: "cancel_identity_invalid", message: "cancel fence identity/expiry is invalid" },
      });
    }
    let fence: ReturnType<SandboxCancelFenceStore["fence"]>;
    try {
      // Durability (file fsync + rename + directory fsync) happens before ACK
      // or abort. A workload restart therefore cannot forget this cancellation.
      fence = cancelFences.fence({
        attemptId,
        bundleHash: command.bundleHash,
        sandboxTenantSlug: command.sandboxTenantSlug,
        appId: command.appId,
        expiresAt: command.expiresAt as string,
      }, now());
    } catch (error) {
      return reply.code(409).send({
        error: { code: "cancel_fence_rejected", message: safeError(error).message },
      });
    }
    const done = terminal.get(attemptId);
    if (done) {
      return done.bundleHash === fence.bundleHash
        ? reply.send(cancelAck(fence, done))
        : reply.code(409).send({ error: { code: "attempt_collision", message: "attempt id collision" } });
    }
    const running = active.get(attemptId);
    if (!running) {
      return reply.code(202).send(cancelAck(fence));
    }
    if (
      running.bundle.bundleHash !== fence.bundleHash
      || running.bundle.sandboxTenantSlug !== fence.sandboxTenantSlug
    ) {
      return reply.code(409).send({ error: { code: "attempt_collision", message: "attempt id collision" } });
    }
    running.controller.abort(new Error("sandbox workload cancelled by runner control"));
    const outcome = await running.settled;
    rememberTerminal(attemptId, outcome);
    return reply.send(cancelAck(fence, outcome));
  });

  app.get("/health", async (request, reply) => {
    if (!exactBearer(request.headers.authorization, input.config.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    let broker: "ready" | "unreachable" = "unreachable";
    try {
      const response = await fetchFn(`${input.config.brokerOrigin}/v0/gql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.config.brokerAuthToken
            ? { authorization: `Bearer ${input.config.brokerAuthToken}` }
            : {}),
        },
        body: JSON.stringify({ query: "{ apps { name } }" }),
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) broker = "ready";
    } catch {
      broker = "unreachable";
    }
    let evidence: SandboxWorkloadDurableHealth;
    try {
      evidence = await durableHealth(new Set(active.keys()), now());
    } catch (error) {
      evidence = {
        outstandingAttempts: 0,
        cleanupFailures: 0,
        oldestOrphanAgeMs: null,
        lastReaperAt: null,
        reaperFailure: safeError(error).message,
      };
    }
    const reaperSucceeded = typeof evidence.lastReaperAt === "string"
      && Number.isFinite(Date.parse(evidence.lastReaperAt));
    const candidateEvidence = candidateReaper.telemetry();
    const candidateReaperSucceeded = typeof candidateEvidence.lastCandidateReaperAt === "string"
      && Number.isFinite(Date.parse(candidateEvidence.lastCandidateReaperAt));
    let cancelFencePruneFailure: string | null = null;
    if (
      broker === "ready"
      && active.size === 0
      && evidence.outstandingAttempts === 0
      && evidence.cleanupFailures === 0
      && reaperSucceeded
      && !evidence.reaperFailure
      && candidateReaperSucceeded
      && candidateEvidence.candidateCleanupReady
      && !candidateEvidence.candidateReaperFailure
    ) {
      for (const fence of cancelFences.expired(now())) {
        try {
          // Expiry alone never deletes a tombstone. First prove the exact App
          // absent while both lifecycle and candidate ledgers are globally
          // clean; only then durably unlink+fsync the fence file.
          await brokerProvesAppAbsent({
            brokerOrigin: input.config.brokerOrigin,
            appId: fence.appId,
            fetchFn,
            authToken: input.config.brokerAuthToken,
          });
          cancelFences.removeVerifiedExpired(fence.attemptId, now());
        } catch (error) {
          cancelFencePruneFailure = safeError(error).message;
          break;
        }
      }
      if (!cancelFencePruneFailure && input.config.brokerAuthToken) {
        try {
          // Gateway entries also cover successful (non-cancelled) attempts.
          // The gateway independently proves exact broker absence before it
          // unlinks anything; these booleans are issued only while both local
          // lifecycle and candidate reapers are globally clean.
          await pruneExpiredGatewayTombstones({
            brokerOrigin: input.config.brokerOrigin,
            authToken: input.config.brokerAuthToken,
            fetchFn,
          });
        } catch (error) {
          cancelFencePruneFailure = safeError(error).message;
        }
      }
    }
    const ok = broker === "ready"
      && reaperSucceeded
      && !evidence.reaperFailure
      && candidateReaperSucceeded
      && !candidateEvidence.candidateReaperFailure
      && !cancelFencePruneFailure;
    const cleanupReady = ok
      && active.size === 0
      && evidence.outstandingAttempts === 0
      && evidence.cleanupFailures === 0
      && candidateEvidence.candidateCleanupReady;
    return reply.code(ok ? 200 : 503).send({
      schema: SANDBOX_WORKLOAD_HEALTH_SCHEMA,
      ok,
      role: "sandbox-workload",
      broker,
      activeExecutions: active.size,
      cleanupReady,
      ...evidence,
      ...candidateEvidence,
      cancelFenceCount: cancelFences.size,
      cancelFencePruneFailure,
    });
  });
  app.addHook("onClose", async () => {
    for (const execution of active.values()) {
      execution.controller.abort(new Error("sandbox workload shutting down"));
    }
    await Promise.allSettled([...active.values()].map((execution) => execution.settled));
    candidateReaper.stop();
  });
  return app;
}

async function main(): Promise<void> {
  const role = process.env.SANDBOX_RUNNER_ROLE?.trim();
  let app: FastifyInstance;
  let host: string;
  let port: number;
  if (role === "control") {
    const config = loadSandboxRunnerConfig();
    app = await buildSandboxRunnerControl({ config });
    host = config.host;
    port = config.controlPort;
  } else if (role === "workload") {
    const config = loadSandboxWorkloadConfig();
    await waitForSandboxDeleteControlReady({
      origin: valueOrFile("SANDBOX_INTERNAL_CONTROL_ORIGIN", process.env),
      token: valueOrFile("SANDBOX_INNGEST_DELETE_TOKEN", process.env, 16),
    });
    // Recover durable nonce-App attempts before accepting another candidate.
    // Compose and the authenticated cross-network probe above prove the narrow
    // delete endpoint is available even though signed full cleanup health may
    // still be red. Any unverified orphan keeps this process fail-closed.
    const executor = await import("./services/agent-factory/sandbox-runner-executor");
    const sourceCleanup = executor.reconcileRunnerSourceSnapshots();
    if (sourceCleanup.removedTools || sourceCleanup.removedTenants) {
      console.warn(
        `[sandbox-workload] removed ${sourceCleanup.removedTools} orphan tool snapshot(s) and ${sourceCleanup.removedTenants} source tenant(s)`,
      );
    }
    const sandboxReaper = await import("./services/agent-factory/sandbox-reaper");
    await sandboxReaper.reconcileFactorySandboxOrphans({ startup: true });
    sandboxReaper.startFactorySandboxReaper(console);
    const { SandboxCodeActCandidateReaper } = await import(
      "./services/agent-factory/sandbox-codeact-reaper"
    );
    const candidateReaper = new SandboxCodeActCandidateReaper();
    const candidateCleanup = await candidateReaper.reconcile({
      startup: true,
      activeAttemptIds: new Set(),
    });
    if (!candidateCleanup.candidateCleanupReady) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: "sandbox workload 启动时无法确认遗留生成代码容器已删除。请检查 Docker socket、候选容器删除权限和 reaper 日志后重试。",
        missing: [candidateCleanup.candidateReaperFailure
          ?? `${candidateCleanup.orphanCandidates} candidate container(s) remain`],
      });
    }
    const { bootstrapSandboxWorkloadRuntime } = await import("./bootstrap");
    await bootstrapSandboxWorkloadRuntime();
    app = await buildSandboxRunnerWorkload({
      config,
      candidateReaper,
    });
    app.addHook("onClose", async () => {
      sandboxReaper.stopFactorySandboxReaper();
    });
    host = config.host;
    port = config.port;
  } else {
    throw new Error("SANDBOX_RUNNER_ROLE must be exactly 'control' or 'workload'");
  }
  const close = async () => app.close();
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await app.listen({ host, port });
  app.log.info(`sandbox ${role} listening on ${host}:${port}`);
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((error) => {
    const safe = safeError(error);
    console.error(`[sandbox-runner] ${safe.code}: ${safe.message}`);
    process.exitCode = 1;
  });
}
