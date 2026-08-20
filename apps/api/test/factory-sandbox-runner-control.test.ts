import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac, generateKeyPairSync } from "node:crypto";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSandboxRunnerControl,
  loadSandboxRunnerConfig,
  registerSandboxRunnerJobRoutes,
} from "../src/sandbox-runner";
import {
  signRemoteSandboxMessage,
  verifyRemoteSandboxRunnerHealth,
} from "../src/services/agent-factory/sandbox-remote-protocol";
import type { SandboxCandidateBundle } from "../src/services/agent-factory/sandbox-bundle-builder";
import {
  SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
  canonicalEvidenceJson,
  sandboxExecutionPlaneCapabilities,
  signSandboxExecutionPlaneAttestation,
} from "@agentic/agent-factory";
import { signSandboxCancelFenceAck } from "../src/services/agent-factory/sandbox-cancel-fence";

const requestKey = "runner-control-request-key-at-least-32-bytes";
const resultKey = "runner-control-result-key-at-least-32-bytes";
const token = "runner-control-workload-token-at-least-32-bytes";
const cancelFenceKey = "runner-control-cancel-fence-key-at-least-32-bytes";
const roots: string[] = [];
const platformKeys = generateKeyPairSync("ed25519");
const platformPublicKey = platformKeys.publicKey.export({
  type: "spki",
  format: "pem",
}).toString();

function platformEnvironment() {
  const attestation = signSandboxExecutionPlaneAttestation(
    {
      schema: SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
      planeId: "runner-control-plane",
      trustDomain: "test.agentic.internal",
      runnerId: "runner-1",
      runnerBuildId: "build-1",
      runtimeImageDigest: `sha256:${"a".repeat(64)}`,
      isolationTier: "remote_vm",
      controlHostIdentityHash: `sha256:${"1".repeat(64)}`,
      workloadHostIdentityHash: `sha256:${"2".repeat(64)}`,
      dockerDaemonIdentityHash: `sha256:${"3".repeat(64)}`,
      capabilities: sandboxExecutionPlaneCapabilities(),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      attestorKeyId: "platform-key-1",
      signatureAlgorithm: "ed25519",
    },
    platformKeys.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString(),
  );
  return {
    SANDBOX_RUNNER_PLATFORM_ATTESTATION: JSON.stringify(attestation),
    SANDBOX_RUNNER_PLATFORM_ATTESTOR_KEY_ID: "platform-key-1",
    SANDBOX_RUNNER_PLATFORM_ATTESTOR_PUBLIC_KEY: platformPublicKey,
    SANDBOX_PRIMARY_HOST_IDENTITY_HASH: `sha256:${"4".repeat(64)}`,
    SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH:
      `sha256:${"5".repeat(64)}`,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle(attemptId = "attempt-control-1"): SandboxCandidateBundle {
  return {
    attemptId,
    bundleHash: `bundle-${attemptId}`,
    sandboxTenantSlug: `af-sbx-${attemptId}-sb`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    policy: { maxRunMs: 1_000 },
  } as SandboxCandidateBundle;
}

function config(journalDir: string) {
  return {
    host: "127.0.0.1",
    controlPort: 3560,
    keyId: "key-1",
    requestSigningKey: requestKey,
    resultSigningKey: resultKey,
    identity: {
      runnerId: "runner-1",
      runnerBuildId: "build-1",
      runtimeImageDigest: `sha256:${"a".repeat(64)}`,
      receiptSigningKey: resultKey,
      brokerOrigin: "http://sandbox-inngest:8288",
      serveOrigin: "http://sandbox-workload:3561",
      actualIsolationTier: "remote_container" as const,
    },
    deleteToken: "delete-token-at-least-16",
    brokerOrigin: "http://sandbox-inngest:8288",
    appPrefix: "agentic-factory-sandbox",
    journalDir,
    workloadUrl: "http://sandbox-workload:3561",
    workloadToken: token,
    cancelFenceIntegrityKey: cancelFenceKey,
    jobTtlMs: 18 * 60_000,
    reaperMs: 60_000,
  };
}

function cancelFenceAck(candidate: SandboxCandidateBundle) {
  const fencedAt = "2026-07-16T00:00:00.000Z";
  return signSandboxCancelFenceAck(cancelFenceKey, {
    schema: "agent-factory-sandbox-cancel-fence-ack/v1",
    attemptId: candidate.attemptId,
    bundleHash: candidate.bundleHash,
    sandboxTenantSlug: candidate.sandboxTenantSlug,
    appId: `agentic-factory-sandbox-${candidate.sandboxTenantSlug}`,
    status: "cancel_fenced",
    fencedAt,
    expiresAt: "2026-07-17T00:00:00.000Z",
  });
}

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "factory-runner-control-"));
  roots.push(value);
  return value;
}

function writeJournal(journalDir: string, body: Record<string, unknown>): void {
  const integrityMac = createHmac("sha256", resultKey)
    .update(canonicalEvidenceJson(body), "utf8")
    .digest("hex");
  writeFileSync(
    path.join(journalDir, `${String(body.attemptId)}.json`),
    JSON.stringify({ ...body, integrityMac }),
  );
}

function workloadHealth(
  overrides: Partial<{
    ok: boolean;
    cleanupReady: boolean;
    activeExecutions: number;
    outstandingAttempts: number;
    cleanupFailures: number;
    oldestOrphanAgeMs: number | null;
    lastReaperAt: string | null;
    reaperFailure: string | null;
  }> = {},
) {
  return {
    schema: "agent-factory-sandbox-workload-health/v1",
    ok: true,
    cleanupReady: true,
    activeExecutions: 0,
    outstandingAttempts: 0,
    cleanupFailures: 0,
    oldestOrphanAgeMs: null,
    lastReaperAt: "2026-07-16T00:00:00.000Z",
    reaperFailure: null,
    ...overrides,
  };
}

describe("sandbox runner control readiness", () => {
  it("keeps liveness and delete readiness green while full cleanup health is red", async () => {
    const journalDir = root();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth({
          ok: false,
          cleanupReady: false,
          outstandingAttempts: 1,
        })), { status: 503 });
      }
      if (url.endsWith("/v0/gql")) {
        return new Response(JSON.stringify({ data: { apps: [] } }), { status: 200 });
      }
      throw new Error("unexpected endpoint");
    }) as unknown as typeof fetch;
    const app = await buildSandboxRunnerControl({
      config: config(journalDir),
      fetchFn,
    });
    try {
      const live = await app.inject({ method: "GET", url: "/live" });
      const deleteReady = await app.inject({
        method: "GET",
        url: "/internal/health/delete-control",
        headers: { authorization: "Bearer delete-token-at-least-16" },
      });
      const full = await app.inject({ method: "GET", url: "/health" });

      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({
        schema: "agent-factory-sandbox-runner-liveness/v1",
        alive: true,
      });
      expect(deleteReady.statusCode).toBe(200);
      expect(full.statusCode).toBe(503);
      expect(verifyRemoteSandboxRunnerHealth(full.json(), resultKey)).toMatchObject({
        ok: false,
        workloadReady: false,
      });
    } finally {
      await app.close();
    }
  });

  it("signs the complete control health response with the result key", async () => {
    const journalDir = root();
    const checkedAt = new Date("2026-07-16T00:00:00.000Z");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), { status: 200 });
      }
      if (url.endsWith("/v0/gql")) {
        return new Response(JSON.stringify({ data: { apps: [] } }), {
          status: 200,
        });
      }
      throw new Error("unexpected endpoint");
    }) as unknown as typeof fetch;
    const app = await buildSandboxRunnerControl({
      config: config(journalDir),
      now: () => checkedAt,
      fetchFn,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      const verified = verifyRemoteSandboxRunnerHealth(
        response.json(),
        resultKey,
      );
      expect(verified).toMatchObject({
        schema: "agent-factory-sandbox-runner-health/v1",
        role: "agent-factory-sandbox-runner",
        keyId: "key-1",
        runnerId: "runner-1",
        runnerBuildId: "build-1",
        runtimeImageDigest: `sha256:${"a".repeat(64)}`,
        checkedAt: checkedAt.toISOString(),
      });
      expect(response.json()).toHaveProperty("integrityMac");
    } finally {
      await app.close();
    }
  });

  it("fails startup when the workload image identity is a tag instead of an OCI digest", () => {
    expect(() => loadSandboxRunnerConfig({
      NODE_ENV: "test",
      PORT: "3560",
      SANDBOX_INNGEST_BASE_URL: "http://sandbox-inngest:8288",
      SANDBOX_WORKLOAD_URL: "http://sandbox-workload:3561",
      SANDBOX_RUNNER_RESULT_HMAC: resultKey,
      SANDBOX_RUNNER_REQUEST_HMAC: requestKey,
      SANDBOX_RUNNER_KEY_ID: "key-1",
      SANDBOX_RUNNER_ID: "runner-1",
      SANDBOX_RUNNER_BUILD_ID: "build-1",
      SANDBOX_RUNNER_RUNTIME_IMAGE_DIGEST: "agentic-sandbox-workload:latest",
      SANDBOX_INNGEST_APP_PREFIX: "agentic-factory-sandbox",
      SANDBOX_INNGEST_DELETE_TOKEN: "delete-token-at-least-16",
      SANDBOX_WORKLOAD_TOKEN: token,
      SANDBOX_CANCEL_FENCE_HMAC: cancelFenceKey,
    })).toThrow(/lowercase sha256:<64 hex>/i);
  });

  it("fails startup when job TTL cannot cover the maximum run plus cleanup", () => {
    expect(() => loadSandboxRunnerConfig({
      NODE_ENV: "test",
      PORT: "3560",
      SANDBOX_INNGEST_BASE_URL: "http://sandbox-inngest:8288",
      SANDBOX_WORKLOAD_URL: "http://sandbox-workload:3561",
      SANDBOX_RUNNER_RESULT_HMAC: resultKey,
      SANDBOX_RUNNER_REQUEST_HMAC: requestKey,
      SANDBOX_RUNNER_KEY_ID: "key-1",
      SANDBOX_RUNNER_ID: "runner-1",
      SANDBOX_RUNNER_BUILD_ID: "build-1",
      SANDBOX_RUNNER_RUNTIME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
      SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER: "same_host_container",
      SANDBOX_INNGEST_APP_PREFIX: "agentic-factory-sandbox",
      SANDBOX_INNGEST_DELETE_TOKEN: "delete-token-at-least-16",
      SANDBOX_WORKLOAD_TOKEN: token,
      SANDBOX_CANCEL_FENCE_HMAC: cancelFenceKey,
      SANDBOX_RUNNER_JOB_TTL_MS: String(18 * 60_000 - 1),
    })).toThrow(/maximum run plus cleanup margin/i);
  });

  it("requires an explicit third signing key on a remote execution plane", () => {
    const base = {
      NODE_ENV: "test",
      PORT: "3560",
      SANDBOX_INNGEST_BASE_URL: "http://sandbox-inngest:8288",
      SANDBOX_WORKLOAD_URL: "http://sandbox-workload:3561",
      SANDBOX_RUNNER_RESULT_HMAC: resultKey,
      SANDBOX_RUNNER_REQUEST_HMAC: requestKey,
      SANDBOX_RUNNER_KEY_ID: "key-1",
      SANDBOX_RUNNER_ID: "runner-1",
      SANDBOX_RUNNER_BUILD_ID: "build-1",
      SANDBOX_RUNNER_RUNTIME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
      SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER: "remote_vm",
      SANDBOX_INNGEST_APP_PREFIX: "agentic-factory-sandbox",
      SANDBOX_INNGEST_DELETE_TOKEN: "delete-token-at-least-16",
      SANDBOX_WORKLOAD_TOKEN: token,
      SANDBOX_CANCEL_FENCE_HMAC: cancelFenceKey,
    };
    expect(() => loadSandboxRunnerConfig(base)).toThrow(/explicitly configured and distinct/);
    expect(() => loadSandboxRunnerConfig({
      ...base,
      SANDBOX_RUNNER_RECEIPT_HMAC: resultKey,
    })).toThrow(/explicitly configured and distinct/);
    expect(loadSandboxRunnerConfig({
      ...base,
      SANDBOX_RUNNER_RECEIPT_HMAC:
        "runner-control-receipt-key-independent-and-at-least-32-bytes",
      ...platformEnvironment(),
    }).identity.actualIsolationTier).toBe("remote_vm");
  });

  it("rejects a new signed job while deep workload readiness is red", async () => {
    const journalDir = root();
    const app = Fastify();
    const execute = vi.fn();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth({
          ok: false,
          outstandingAttempts: 1,
        })), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      execute,
      fetchFn,
    });
    const candidate = bundle();
    const payload = {
      schema: "agent-factory-sandbox-submit/v1" as const,
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      bundle: candidate,
    };
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/sandbox-jobs",
      payload: signRemoteSandboxMessage({
        purpose: "submit",
        keyId: "key-1",
        secret: requestKey,
        payload,
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "runner_not_ready" });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("recovers an interrupted journal only after workload and broker prove absence", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-restarted-1");
    writeJournal(journalDir, {
      schema: "agent-factory-sandbox-runner-job/v1",
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      bundle: candidate,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    });
    const app = Fastify();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/internal/v1/executions/${candidate.attemptId}/cancel`)) {
        return new Response(JSON.stringify(cancelFenceAck(candidate)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const service = await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      execute: vi.fn(),
      fetchFn,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    const before = service.jobs.get(candidate.attemptId);
    expect(before?.status).toBe("cleanup_pending");
    const health = await service.health();
    expect(health).toMatchObject({
      ok: true,
      broker: "ready",
      storage: "ready",
      cleanupFailures: 0,
      outstandingAttempts: 0,
      lastReaperAt: "2026-07-16T00:00:00.000Z",
    });
    expect(service.jobs.get(candidate.attemptId)?.status).toBe("cancelled");
    await app.close();
  });

  it("does not turn global cleanupReady plus broker absence into a cancelled interrupted attempt", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-no-exact-fence-1");
    writeJournal(journalDir, {
      schema: "agent-factory-sandbox-runner-job/v1",
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      bundle: candidate,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    });
    const app = Fastify();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/internal/v1/executions/${candidate.attemptId}/cancel`)) {
        return new Response(JSON.stringify({ error: "workload restarted before fence" }), { status: 503 });
      }
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const service = await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      execute: vi.fn(),
      fetchFn,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });
    const health = await service.health();
    expect(health.ok).toBe(false);
    expect(service.jobs.get(candidate.attemptId)?.status).toBe("cleanup_pending");
    await app.close();
  });

  it("refuses to start from a tampered durable job journal", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-tampered-journal-1");
    const body = {
      schema: "agent-factory-sandbox-runner-job/v1",
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      bundle: candidate,
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    };
    writeJournal(journalDir, body);
    const filename = path.join(journalDir, `${candidate.attemptId}.json`);
    const stored = JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>;
    stored.status = "running";
    writeFileSync(filename, JSON.stringify(stored));

    await expect(registerSandboxRunnerJobRoutes({
      app: Fastify(),
      config: config(journalDir),
      execute: vi.fn(),
    })).rejects.toThrow(/journal integrity check failed/);
  });

  it("treats a workload preflight rejection as clean only after both absence proofs", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-clean-preflight-1");
    const app = Fastify();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/internal/v1/execute")) {
        return new Response(JSON.stringify({
          schema: "agent-factory-sandbox-workload-terminal/v1",
          attemptId: candidate.attemptId,
          bundleHash: candidate.bundleHash,
          status: "failed",
          startedAt: "2026-07-16T00:00:00.000Z",
          completedAt: "2026-07-16T00:00:00.010Z",
          error: {
            code: "sandbox_isolation_invalid",
            message: "target broker identity does not match the sandbox",
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const service = await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      fetchFn,
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/sandbox-jobs",
      payload: signRemoteSandboxMessage({
        purpose: "submit",
        keyId: "key-1",
        secret: requestKey,
        payload: {
          schema: "agent-factory-sandbox-submit/v1" as const,
          attemptId: candidate.attemptId,
          bundleHash: candidate.bundleHash,
          bundle: candidate,
        },
      }),
    });

    expect(response.statusCode).toBe(202);
    await service.jobs.get(candidate.attemptId)?.settled;
    expect(service.jobs.get(candidate.attemptId)).toMatchObject({
      status: "cancelled",
      error: {
        code: "sandbox_cancelled",
        message: expect.stringContaining("zero residual resources independently verified"),
      },
    });
    await expect(service.health()).resolves.toMatchObject({
      ok: true,
      failedJobs: 0,
      cleanupFailures: 0,
      outstandingAttempts: 0,
    });
    await app.close();
  });

  it("keeps a preflight failure red when the broker cannot prove App absence", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-dirty-preflight-1");
    const app = Fastify();
    let executionStarted = false;
    const expectedAppId = `agentic-factory-sandbox-${candidate.sandboxTenantSlug}`;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/internal/v1/execute")) {
        executionStarted = true;
        return new Response(JSON.stringify({
          schema: "agent-factory-sandbox-workload-terminal/v1",
          attemptId: candidate.attemptId,
          bundleHash: candidate.bundleHash,
          status: "failed",
          startedAt: "2026-07-16T00:00:00.000Z",
          completedAt: "2026-07-16T00:00:00.010Z",
          error: { code: "sandbox_isolation_invalid", message: "preflight failed" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        data: { apps: executionStarted ? [{ name: expectedAppId }] : [] },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const service = await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      fetchFn,
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/sandbox-jobs",
      payload: signRemoteSandboxMessage({
        purpose: "submit",
        keyId: "key-1",
        secret: requestKey,
        payload: {
          schema: "agent-factory-sandbox-submit/v1" as const,
          attemptId: candidate.attemptId,
          bundleHash: candidate.bundleHash,
          bundle: candidate,
        },
      }),
    });

    expect(response.statusCode).toBe(202);
    await service.jobs.get(candidate.attemptId)?.settled;
    expect(service.jobs.get(candidate.attemptId)).toMatchObject({
      status: "failed",
      error: { code: "sandbox_cleanup_failed" },
    });
    await expect(service.health()).resolves.toMatchObject({
      ok: false,
      failedJobs: 1,
      cleanupFailures: 1,
    });
    await app.close();
  });

  it("reconciles a persisted non-cleanup failure only after both absence proofs", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-persisted-failure-1");
    writeJournal(journalDir, {
      schema: "agent-factory-sandbox-runner-job/v1",
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      bundle: candidate,
      status: "failed",
      createdAt: 1,
      updatedAt: 1,
      error: { code: "sandbox_execution_failed", message: "old preflight failure" },
    });
    const app = Fastify();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith(`/internal/v1/executions/${candidate.attemptId}/cancel`)) {
        return new Response(JSON.stringify(cancelFenceAck(candidate)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const service = await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      execute: vi.fn(),
      fetchFn,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    expect(service.jobs.get(candidate.attemptId)?.status).toBe("failed");
    await expect(service.health()).resolves.toMatchObject({
      ok: true,
      failedJobs: 0,
      cleanupFailures: 0,
    });
    expect(service.jobs.get(candidate.attemptId)).toMatchObject({
      status: "cancelled",
      error: { code: "runner_failure_absence_verified" },
    });
    await app.close();
  });

  it("never reconciles an explicit persisted cleanup failure", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-persisted-cleanup-failure-1");
    writeJournal(journalDir, {
      schema: "agent-factory-sandbox-runner-job/v1",
      attemptId: candidate.attemptId,
      bundleHash: candidate.bundleHash,
      bundle: candidate,
      status: "failed",
      createdAt: 1,
      updatedAt: 1,
      error: { code: "sandbox_cleanup_failed", message: "cleanup proof missing" },
    });
    const app = Fastify();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const service = await registerSandboxRunnerJobRoutes({
      app,
      config: config(journalDir),
      execute: vi.fn(),
      fetchFn,
    });

    await expect(service.health()).resolves.toMatchObject({
      ok: false,
      failedJobs: 1,
      cleanupFailures: 1,
    });
    expect(service.jobs.get(candidate.attemptId)?.status).toBe("failed");
    await app.close();
  });

  it("persists the authenticated nonce ledger across a control restart", async () => {
    const journalDir = root();
    const candidate = bundle("attempt-nonce-restart-1");
    const envelope = signRemoteSandboxMessage({
      purpose: "submit",
      keyId: "key-1",
      secret: requestKey,
      payload: {
        schema: "agent-factory-sandbox-submit/v1" as const,
        attemptId: candidate.attemptId,
        bundleHash: candidate.bundleHash,
        bundle: candidate,
      },
    });
    const readyFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify(workloadHealth()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { apps: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const firstApp = Fastify();
    const first = await registerSandboxRunnerJobRoutes({
      app: firstApp,
      config: config(journalDir),
      execute: vi.fn(async () => ({} as never)),
      fetchFn: readyFetch,
    });
    const accepted = await firstApp.inject({
      method: "POST",
      url: "/internal/v1/sandbox-jobs",
      payload: envelope,
    });
    expect(accepted.statusCode).toBe(202);
    await first.jobs.get(candidate.attemptId)?.settled;
    await firstApp.close();

    const restartedApp = Fastify();
    await registerSandboxRunnerJobRoutes({
      app: restartedApp,
      config: config(journalDir),
      execute: vi.fn(),
      fetchFn: readyFetch,
    });
    const replayed = await restartedApp.inject({
      method: "POST",
      url: "/internal/v1/sandbox-jobs",
      payload: envelope,
    });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toMatchObject({ code: "envelope_replayed" });
    await restartedApp.close();
  });
});
