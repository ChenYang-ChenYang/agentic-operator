import type { HealthReport } from "@agentic/contracts";
import {
  sandboxExecutionPlaneAttestationIssues,
  type SandboxExecutionPlaneAttestation,
} from "@agentic/agent-factory";
import {
  productionCodeActRemoteEnabled,
  productionCodeActRemoteHealthExpectation,
  productionCodeActSecret,
} from "@agentic/runtime";

import {
  FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV,
  loadRemoteSandboxConnectionConfig,
} from "./agent-factory/remote-sandbox-deployer";
import { verifyRemoteSandboxRunnerHealth } from "./agent-factory/sandbox-remote-protocol";

type JsonRecord = Record<string, unknown>;
type ExecutorHealth = NonNullable<HealthReport["productionCodeActExecutor"]>;
type SandboxRunnerHealth = NonNullable<HealthReport["factorySandboxRunner"]>;

const EXECUTOR_HEALTH_SCHEMA =
  "agentic-production-codeact-executor-health/v1";
const SANDBOX_RUNNER_ROLE = "agent-factory-sandbox-runner";
const MAX_HEALTH_BYTES = 64 * 1024;
const JOB_STATUSES = new Set([
  "accepted",
  "running",
  "cleanup_pending",
  "completed",
  "failed",
  "cancelled",
]);

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_HEALTH_BYTES) {
    throw new Error("health response is too large");
  }
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_HEALTH_BYTES) {
        await reader.cancel();
        throw new Error("health response is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

function blockedExecutor(note: string): ExecutorHealth {
  return { configured: true, ok: false, state: "blocked", note };
}

/** Continuous authenticated deep probe of the isolated production launcher. */
export async function checkProductionCodeActExecutor(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<ExecutorHealth> {
  if (!productionCodeActRemoteEnabled(env)) {
    return { configured: false, ok: true, state: "disabled" };
  }
  try {
    const expected = productionCodeActRemoteHealthExpectation(env);
    const token = productionCodeActSecret(env);
    const response = await fetchImpl(`${expected.origin}/health`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const body = object(await boundedJson(response));
    if (!body) return blockedExecutor("executor_health_invalid");
    const checkedAtMs = typeof body.checkedAt === "string"
      ? Date.parse(body.checkedAt)
      : Number.NaN;
    const candidateImageId = typeof body.candidateImageId === "string"
      ? body.candidateImageId
      : "";
    const valid =
      response.ok &&
      body.schema === EXECUTOR_HEALTH_SCHEMA &&
      body.ok === true &&
      body.draining === false &&
      body.executorId === expected.executorId &&
      body.buildId === expected.buildId &&
      typeof body.candidateImage === "string" &&
      expected.candidateRefs.has(body.candidateImage) &&
      expected.candidateImageIds.has(candidateImageId) &&
      nonnegativeInteger(body.active) &&
      positiveInteger(body.capacity) &&
      (body.active as number) <= (body.capacity as number) &&
      nonnegativeInteger(body.removedOrphans) &&
      Number.isFinite(checkedAtMs) &&
      checkedAtMs <= nowMs + 5_000 &&
      checkedAtMs >= nowMs - 5 * 60_000 &&
      body.error === undefined;
    if (!valid) return blockedExecutor("executor_identity_or_deep_health_failed");
    const active = body.active as number;
    return {
      configured: true,
      ok: true,
      state: active > 0 ? "busy" : "ready",
      executorId: body.executorId as string,
      buildId: body.buildId as string,
      candidateRef: body.candidateImage as string,
      candidateImageId,
      active,
      capacity: body.capacity as number,
      removedOrphans: body.removedOrphans as number,
      checkedAt: body.checkedAt as string,
    };
  } catch {
    return blockedExecutor("executor_unreachable_or_misconfigured");
  }
}

function blockedSandbox(note: string): SandboxRunnerHealth {
  return { configured: true, ok: false, state: "blocked", note };
}

function exactJobCounts(value: unknown): Record<string, number> | null {
  const jobs = object(value);
  if (!jobs) return null;
  const result: Record<string, number> = {};
  for (const [status, count] of Object.entries(jobs)) {
    if (!JOB_STATUSES.has(status) || !nonnegativeInteger(count)) return null;
    result[status] = count;
  }
  return result;
}

/** Continuous identity-bound probe of the external sandbox control plane.
 * A normal accepted/running job is reported as busy and remains ready. */
export async function checkFactorySandboxRunner(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<SandboxRunnerHealth> {
  if (!env[FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]?.trim()) {
    return { configured: false, ok: true, state: "disabled" };
  }
  try {
    const expected = loadRemoteSandboxConnectionConfig(env);
    const response = await fetchImpl(`${expected.runnerUrl}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 200 && response.status !== 503) {
      return blockedSandbox("sandbox_runner_health_http_failed");
    }
    const rawBody = await boundedJson(response);
    const body = verifyRemoteSandboxRunnerHealth(
      rawBody,
      expected.resultSigningKey,
    );
    if (!body) return blockedSandbox("sandbox_runner_health_signature_invalid");
    const jobs = exactJobCounts(body.jobs);
    const checkedAtMs = typeof body.checkedAt === "string"
      ? Date.parse(body.checkedAt)
      : Number.NaN;
    if (
      body.role !== SANDBOX_RUNNER_ROLE ||
      body.keyId !== expected.keyId ||
      body.runnerId !== expected.runnerId ||
      typeof body.runnerBuildId !== "string" ||
      !expected.allowedBuildIds.has(body.runnerBuildId) ||
      typeof body.runtimeImageDigest !== "string" ||
      !expected.allowedImageDigests.has(body.runtimeImageDigest) ||
      (body.isolationTier !== "same_host_container"
        && body.isolationTier !== "remote_container"
        && body.isolationTier !== "remote_vm") ||
      typeof body.ok !== "boolean" ||
      body.broker !== "ready" ||
      body.storage !== "ready" ||
      !jobs ||
      body.workloadReady !== true ||
      typeof body.workloadCleanupReady !== "boolean" ||
      !nonnegativeInteger(body.workloadActiveExecutions) ||
      !nonnegativeInteger(body.outstandingAttempts) ||
      !nonnegativeInteger(body.failedJobs) ||
      !nonnegativeInteger(body.cleanupFailures) ||
      (body.oldestOrphanAgeMs !== null &&
        !nonnegativeInteger(body.oldestOrphanAgeMs)) ||
      !validTimestamp(body.controlLastReaperAt) ||
      !validTimestamp(body.workloadLastReaperAt) ||
      !validTimestamp(body.lastReaperAt) ||
      !Number.isFinite(checkedAtMs) ||
      checkedAtMs > nowMs + 5_000 ||
      checkedAtMs < nowMs - 60_000 ||
      body.reaperFailure !== null
    ) {
      return blockedSandbox("sandbox_runner_identity_or_deep_health_failed");
    }
    const diagnosticSameHost =
      body.isolationTier === "same_host_container";
    let platformAttestation: SandboxExecutionPlaneAttestation | null = null;
    if (!diagnosticSameHost) {
      if (!expected.platformAttestationExpected) {
        return blockedSandbox(
          "sandbox_runner_platform_attestation_unconfigured",
        );
      }
      platformAttestation = object(
        body.platformAttestation,
      ) as unknown as SandboxExecutionPlaneAttestation | null;
      const platformIssues = sandboxExecutionPlaneAttestationIssues(
        platformAttestation,
        {
          ...expected.platformAttestationExpected,
          now: new Date(nowMs),
        },
      );
      if (
        platformIssues.length
        || platformAttestation?.isolationTier !== body.isolationTier
      ) {
        return blockedSandbox(
          "sandbox_runner_platform_attestation_invalid",
        );
      }
    }
    const accepted = jobs.accepted ?? 0;
    const running = jobs.running ?? 0;
    const cleanupPending = jobs.cleanup_pending ?? 0;
    const failed = jobs.failed ?? 0;
    const activeJobs = accepted + running;
    const activeExecutions = body.workloadActiveExecutions as number;
    const outstandingAttempts = body.outstandingAttempts as number;
    const cleanupFailures = body.cleanupFailures as number;
    const oldestOrphanAgeMs = body.oldestOrphanAgeMs as number | null;
    const clean =
      cleanupPending === 0 &&
      failed === 0 &&
      body.failedJobs === 0 &&
      cleanupFailures === 0 &&
      oldestOrphanAgeMs === null;
    const busy =
      clean &&
      activeJobs > 0 &&
      activeExecutions <= activeJobs &&
      outstandingAttempts <= activeJobs;
    const idle =
      clean &&
      activeJobs === 0 &&
      activeExecutions === 0 &&
      outstandingAttempts === 0 &&
      body.workloadCleanupReady === true &&
      body.ok === true &&
      response.ok;
    if (!busy && !idle) {
      return blockedSandbox("sandbox_runner_cleanup_or_orphan_failed");
    }
    if (diagnosticSameHost && env.NODE_ENV === "production") {
      return {
        ...blockedSandbox("sandbox_runner_shares_primary_host_docker_daemon"),
        isolationTier: "same_host_container",
        diagnosticOnly: true,
        qualification: "development_only",
      } as SandboxRunnerHealth;
    }
    return {
      configured: true,
      ok: true,
      state: busy ? "busy" : "ready",
      runnerId: body.runnerId as string,
      buildId: body.runnerBuildId as string,
      runtimeImageDigest: body.runtimeImageDigest as string,
      isolationTier: body.isolationTier,
      diagnosticOnly: diagnosticSameHost,
      qualification: diagnosticSameHost
        ? "development_only"
        : "promotable",
      ...(platformAttestation
        ? {
            executionPlaneId: platformAttestation.planeId,
            trustDomain: platformAttestation.trustDomain,
            platformAttestationHash: platformAttestation.attestationHash,
          }
        : {
            note: "sandbox_runner_same_host_development_only",
          }),
      broker: "ready",
      storage: "ready",
      jobs,
      activeJobs,
      activeExecutions,
      outstandingAttempts,
      cleanupFailures,
      oldestOrphanAgeMs,
      reaperOk: true,
      controlLastReaperAt: body.controlLastReaperAt as string,
      workloadLastReaperAt: body.workloadLastReaperAt as string,
    };
  } catch {
    return blockedSandbox("sandbox_runner_unreachable_or_misconfigured");
  }
}

export const __test = { boundedJson, exactJobCounts };
