import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
  sandboxExecutionPlaneCapabilities,
  signSandboxExecutionPlaneAttestation,
} from "@agentic/agent-factory";

import {
  checkFactorySandboxRunner,
  checkProductionCodeActExecutor,
} from "../src/services/execution-plane-health";
import { signRemoteSandboxRunnerHealth } from "../src/services/agent-factory/sandbox-remote-protocol";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const EXECUTOR_TOKEN = "executor-health-token-that-is-at-least-32-bytes";
const CANDIDATE_REF = `registry.example/codeact@sha256:${"a".repeat(64)}`;
const CANDIDATE_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SANDBOX_RESULT_KEY = "result-health-key-that-is-at-least-32-bytes";
const platformKeys = generateKeyPairSync("ed25519");
const platformPrivateKey = platformKeys.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();
const platformPublicKey = platformKeys.publicKey.export({
  type: "spki",
  format: "pem",
}).toString();
const remoteControlHostHash = `sha256:${"d".repeat(64)}`;
const remoteWorkloadHostHash = `sha256:${"e".repeat(64)}`;
const remoteDaemonHash = `sha256:${"f".repeat(64)}`;

function executorEnv(): NodeJS.ProcessEnv {
  return {
    AGENTIC_PROCESS_ROLE: "api",
    PRODUCTION_CODEACT_EXECUTOR_ENABLED: "1",
    PRODUCTION_CODEACT_EXECUTOR_URL: "https://codeact.internal",
    PRODUCTION_CODEACT_EXECUTOR_TOKEN: EXECUTOR_TOKEN,
    PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID: "executor-reviewed",
    PRODUCTION_CODEACT_EXPECTED_BUILD_ID: "build-reviewed",
    PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS: JSON.stringify([
      CANDIDATE_REF,
    ]),
    PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS: JSON.stringify([
      CANDIDATE_IMAGE_ID,
    ]),
  };
}

function executorBody(overrides: Record<string, unknown> = {}) {
  return {
    schema: "agentic-production-codeact-executor-health/v1",
    ok: true,
    draining: false,
    executorId: "executor-reviewed",
    buildId: "build-reviewed",
    active: 0,
    capacity: 8,
    checkedAt: new Date(NOW).toISOString(),
    candidateImage: CANDIDATE_REF,
    candidateImageId: CANDIDATE_IMAGE_ID,
    removedOrphans: 0,
    ...overrides,
  };
}

function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    AGENTIC_PROCESS_ROLE: "api",
    FACTORY_SANDBOX_REMOTE_CONFIG_REFS: JSON.stringify({
      runnerUrlEnv: "FACTORY_SB_RUNNER_URL",
      requestSigningKeyEnv: "FACTORY_SB_REQUEST_HMAC",
      resultSigningKeyEnv: "FACTORY_SB_RESULT_HMAC",
      keyIdEnv: "FACTORY_SB_KEY_ID",
      runnerIdEnv: "FACTORY_SB_RUNNER_ID",
      allowedBuildIdsEnv: "FACTORY_SB_ALLOWED_BUILD_IDS",
      allowedImageDigestsEnv: "FACTORY_SB_ALLOWED_IMAGE_DIGESTS",
      executionPlaneIdEnv: "FACTORY_SB_EXECUTION_PLANE_ID",
      executionPlaneTrustDomainEnv: "FACTORY_SB_TRUST_DOMAIN",
      platformAttestorKeyIdEnv: "FACTORY_SB_ATTESTOR_KEY_ID",
      platformAttestorPublicKeyEnv: "FACTORY_SB_ATTESTOR_PUBLIC_KEY",
      primaryHostIdentityHashEnv: "FACTORY_PRIMARY_HOST_HASH",
      primaryDockerDaemonIdentityHashEnv: "FACTORY_PRIMARY_DAEMON_HASH",
      allowedControlHostIdentityHashesEnv: "FACTORY_SB_CONTROL_HOST_HASHES",
      allowedWorkloadHostIdentityHashesEnv: "FACTORY_SB_WORKLOAD_HOST_HASHES",
      allowedDockerDaemonIdentityHashesEnv: "FACTORY_SB_DAEMON_HASHES",
    }),
    FACTORY_SB_RUNNER_URL: "https://sandbox.internal",
    FACTORY_SB_REQUEST_HMAC: "request-health-key-that-is-at-least-32-bytes",
    FACTORY_SB_RESULT_HMAC: SANDBOX_RESULT_KEY,
    FACTORY_SB_KEY_ID: "key-reviewed",
    FACTORY_SB_RUNNER_ID: "runner-reviewed",
    FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["sandbox-build-reviewed"]),
    FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([
      `sha256:${"c".repeat(64)}`,
    ]),
    FACTORY_SB_EXECUTION_PLANE_ID: "sandbox-plane-reviewed",
    FACTORY_SB_TRUST_DOMAIN: "sandbox.agentic.internal",
    FACTORY_SB_ATTESTOR_KEY_ID: "platform-key-reviewed",
    FACTORY_SB_ATTESTOR_PUBLIC_KEY: platformPublicKey,
    FACTORY_PRIMARY_HOST_HASH: `sha256:${"1".repeat(64)}`,
    FACTORY_PRIMARY_DAEMON_HASH: `sha256:${"2".repeat(64)}`,
    FACTORY_SB_CONTROL_HOST_HASHES: JSON.stringify([remoteControlHostHash]),
    FACTORY_SB_WORKLOAD_HOST_HASHES: JSON.stringify([remoteWorkloadHostHash]),
    FACTORY_SB_DAEMON_HASHES: JSON.stringify([remoteDaemonHash]),
  };
}

function runnerBody(overrides: Record<string, unknown> = {}) {
  const platformAttestation = signSandboxExecutionPlaneAttestation(
    {
      schema: SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
      planeId: "sandbox-plane-reviewed",
      trustDomain: "sandbox.agentic.internal",
      runnerId: "runner-reviewed",
      runnerBuildId: "sandbox-build-reviewed",
      runtimeImageDigest: `sha256:${"c".repeat(64)}`,
      isolationTier: "remote_vm",
      controlHostIdentityHash: remoteControlHostHash,
      workloadHostIdentityHash: remoteWorkloadHostHash,
      dockerDaemonIdentityHash: remoteDaemonHash,
      capabilities: sandboxExecutionPlaneCapabilities(),
      issuedAt: new Date(NOW - 1_000).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      attestorKeyId: "platform-key-reviewed",
      signatureAlgorithm: "ed25519",
    },
    platformPrivateKey,
  );
  return signRemoteSandboxRunnerHealth({
    role: "agent-factory-sandbox-runner",
    keyId: "key-reviewed",
    runnerId: "runner-reviewed",
    runnerBuildId: "sandbox-build-reviewed",
    runtimeImageDigest: `sha256:${"c".repeat(64)}`,
    isolationTier: "remote_vm",
    platformAttestation,
    checkedAt: new Date(NOW).toISOString(),
    ok: true,
    broker: "ready",
    storage: "ready",
    jobs: {},
    controlLastReaperAt: "2026-07-16T11:59:55.000Z",
    workloadLastReaperAt: "2026-07-16T11:59:56.000Z",
    lastReaperAt: "2026-07-16T11:59:55.000Z",
    outstandingAttempts: 0,
    workloadReady: true,
    workloadCleanupReady: true,
    workloadActiveExecutions: 0,
    failedJobs: 0,
    cleanupFailures: 0,
    oldestOrphanAgeMs: null,
    reaperFailure: null,
    ...overrides,
  }, SANDBOX_RESULT_KEY);
}

describe("API execution-plane health dependencies", () => {
  it("treats explicitly disabled planes as healthy disabled dependencies", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      checkProductionCodeActExecutor(fetchFn, {}),
    ).resolves.toEqual({ configured: false, ok: true, state: "disabled" });
    await expect(checkFactorySandboxRunner(fetchFn, {})).resolves.toEqual({
      configured: false,
      ok: true,
      state: "disabled",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("authenticates and identity-binds a healthy or busy production executor", async () => {
    const fetchFn = vi.fn(async (_url, init) =>
      new Response(JSON.stringify(executorBody({ active: 2 })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const health = await checkProductionCodeActExecutor(
      fetchFn,
      executorEnv(),
      NOW,
    );
    expect(health).toMatchObject({
      configured: true,
      ok: true,
      state: "busy",
      executorId: "executor-reviewed",
      buildId: "build-reviewed",
      candidateRef: CANDIDATE_REF,
      candidateImageId: CANDIDATE_IMAGE_ID,
      active: 2,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://codeact.internal/health",
      expect.objectContaining({
        headers: { authorization: `Bearer ${EXECUTOR_TOKEN}` },
      }),
    );
    expect(JSON.stringify(health)).not.toContain(EXECUTOR_TOKEN);
    expect(JSON.stringify(health)).not.toContain("codeact.internal");
  });

  it.each([
    ["wrong build", { buildId: "substituted" }],
    ["wrong candidate ref", { candidateImage: `sha256:${"d".repeat(64)}` }],
    ["wrong image id", { candidateImageId: `sha256:${"e".repeat(64)}` }],
    ["Docker/reaper failure", { ok: false, error: "/var/run/docker.sock denied" }],
    ["draining", { draining: true }],
  ])("blocks executor %s without echoing its error", async (_name, override) => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(executorBody(override)), {
        status: override.ok === false ? 503 : 200,
      }),
    ) as unknown as typeof fetch;
    const health = await checkProductionCodeActExecutor(
      fetchFn,
      executorEnv(),
      NOW,
    );
    expect(health).toMatchObject({ ok: false, state: "blocked" });
    expect(JSON.stringify(health)).not.toContain("docker.sock");
  });

  it("accepts an idle sandbox runner only with exact runner/build/runtime identities", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(runnerBody()), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(checkFactorySandboxRunner(fetchFn, sandboxEnv(), NOW)).resolves.toMatchObject({
      configured: true,
      ok: true,
      state: "ready",
      runnerId: "runner-reviewed",
      buildId: "sandbox-build-reviewed",
      runtimeImageDigest: `sha256:${"c".repeat(64)}`,
      reaperOk: true,
    });
  });

  it("reports a normal active sandbox execution as busy, not unhealthy", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify(
          runnerBody({
            ok: false,
            jobs: { running: 1 },
            workloadCleanupReady: false,
            workloadActiveExecutions: 1,
            outstandingAttempts: 1,
          }),
        ),
        { status: 503 },
      ),
    ) as unknown as typeof fetch;
    await expect(checkFactorySandboxRunner(fetchFn, sandboxEnv(), NOW)).resolves.toMatchObject({
      ok: true,
      state: "busy",
      activeJobs: 1,
      activeExecutions: 1,
      outstandingAttempts: 1,
    });
  });

  it("keeps a healthy same-host Docker sandbox available for development diagnostics", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(runnerBody({ isolationTier: "same_host_container" })), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    await expect(checkFactorySandboxRunner(fetchFn, sandboxEnv(), NOW)).resolves.toMatchObject({
      ok: true,
      state: "ready",
      isolationTier: "same_host_container",
      diagnosticOnly: true,
      qualification: "development_only",
      note: "sandbox_runner_same_host_development_only",
    });
  });

  it("keeps a same-host Docker sandbox blocked in production", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(runnerBody({ isolationTier: "same_host_container" })), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    await expect(checkFactorySandboxRunner(
      fetchFn,
      { ...sandboxEnv(), NODE_ENV: "production" },
      NOW,
    )).resolves.toMatchObject({
      ok: false,
      state: "blocked",
      isolationTier: "same_host_container",
      diagnosticOnly: true,
      qualification: "development_only",
      note: "sandbox_runner_shares_primary_host_docker_daemon",
    });
  });

  it.each([
    ["cleanup pending", { jobs: { cleanup_pending: 1 }, oldestOrphanAgeMs: 10 }],
    ["cleanup failure", { jobs: { failed: 1 }, failedJobs: 1, cleanupFailures: 1 }],
    ["orphan", { oldestOrphanAgeMs: 60_000 }],
    ["reaper failure", { reaperFailure: "candidate docker inspect failed" }],
    ["workload/Docker failure", { workloadReady: false }],
    ["identity substitution", { runnerBuildId: "unknown-build" }],
  ])("blocks sandbox runner %s and redacts internal detail", async (_name, override) => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(runnerBody({ ok: false, ...override })), {
        status: 503,
      }),
    ) as unknown as typeof fetch;
    const health = await checkFactorySandboxRunner(fetchFn, sandboxEnv(), NOW);
    expect(health).toMatchObject({ ok: false, state: "blocked" });
    expect(JSON.stringify(health)).not.toContain("docker inspect failed");
    expect(JSON.stringify(health)).not.toContain("sandbox.internal");
    expect(JSON.stringify(health)).not.toContain("request-health-key");
  });

  it.each([
    ["missing signature", () => {
      const { integrityMac: _integrityMac, ...unsigned } = runnerBody();
      return unsigned;
    }],
    ["tampered body", () => ({ ...runnerBody(), jobs: { running: 1 } })],
    ["wrong signing key", () => {
      const { integrityMac: _integrityMac, ...unsigned } = runnerBody();
      return signRemoteSandboxRunnerHealth(
        unsigned,
        "wrong-result-health-key-that-is-at-least-32-bytes",
      );
    }],
  ])("blocks sandbox runner health with %s", async (_name, bodyFactory) => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(bodyFactory()), { status: 200 }),
    ) as unknown as typeof fetch;
    const health = await checkFactorySandboxRunner(fetchFn, sandboxEnv(), NOW);
    expect(health).toEqual({
      configured: true,
      ok: false,
      state: "blocked",
      note: "sandbox_runner_health_signature_invalid",
    });
    expect(JSON.stringify(health)).not.toContain(SANDBOX_RESULT_KEY);
  });
});
