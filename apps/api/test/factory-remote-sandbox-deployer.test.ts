import {
  SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxCleanupReceiptHash,
  sandboxExecutionReceiptHash,
  sandboxInfrastructureCleanupEvidenceHash,
  sandboxExecutionPlaneCapabilities,
  sandboxRunDrainReceiptHash,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
  type SandboxDeployResult,
  type SandboxExecutionPlaneReceipt,
  signSandboxExecutionPlaneAttestation,
} from "@agentic/agent-factory";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV,
  RemoteSandboxDeployer,
  loadRemoteSandboxConnectionConfig,
  type RemoteSandboxConnectionConfig,
  type RemoteSandboxTransport,
} from "../src/services/agent-factory/remote-sandbox-deployer";
import type { SandboxCandidateBundle } from "../src/services/agent-factory/sandbox-bundle-builder";
import {
  canonicalSandboxSha256,
  remoteSandboxResultHash,
  signRemoteSandboxMessage,
  signSandboxExecutionPlaneReceipt,
  verifySandboxExecutionPlaneReceipt,
  verifyExactSandboxCandidateBundle,
  type RemoteSandboxAttemptCommand,
  type RemoteSandboxJobResult,
  type RemoteSandboxSubmitCommand,
  type SignedRemoteSandboxMessage,
} from "../src/services/agent-factory/sandbox-remote-protocol";
import { makeTargetInngestIsolationIdentity } from "./factory-sandbox-execution-fixture";
import { readFactorySandboxModelUsageEvidence } from "../src/services/agent-factory/factory-sandbox-model-proxy";

const now = new Date("2026-07-15T08:00:00.000Z");
const requestKey = "test-only-request-signing-key-32-bytes";
const resultKey = "test-only-result-signing-key-32-bytes";
const receiptKey = "test-only-receipt-signing-key-32-bytes";
const runnerId = "sandbox-runner-test";
const runnerBuildId = "runner-build-20260715";
const runtimeImageDigest = `sha256:${"b".repeat(64)}`;
const platformKeys = generateKeyPairSync("ed25519");
const platformPrivateKey = platformKeys.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();
const platformPublicKey = platformKeys.publicKey.export({
  type: "spki",
  format: "pem",
}).toString();
const controlHostIdentityHash = `sha256:${"6".repeat(64)}`;
const workloadHostIdentityHash = `sha256:${"7".repeat(64)}`;
const dockerDaemonIdentityHash = `sha256:${"8".repeat(64)}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

const connection: RemoteSandboxConnectionConfig = {
  runnerUrl: "http://sandbox-runner:3560",
  requestSigningKey: requestKey,
  resultSigningKey: resultKey,
  receiptSigningKey: receiptKey,
  keyId: "sandbox-key-v1",
  runnerId,
  allowedBuildIds: new Set([runnerBuildId]),
  allowedImageDigests: new Set([runtimeImageDigest]),
  platformAttestationExpected: {
    planeId: "sandbox-plane-test",
    trustDomain: "test.agentic.internal",
    runnerId,
    allowedRunnerBuildIds: new Set([runnerBuildId]),
    allowedRuntimeImageDigests: new Set([runtimeImageDigest]),
    allowedControlHostIdentityHashes: new Set([controlHostIdentityHash]),
    allowedWorkloadHostIdentityHashes: new Set([workloadHostIdentityHash]),
    allowedDockerDaemonIdentityHashes: new Set([dockerDaemonIdentityHash]),
    primaryHostIdentityHash: `sha256:${"9".repeat(64)}`,
    primaryDockerDaemonIdentityHash: `sha256:${"a".repeat(64)}`,
    attestorKeyId: "platform-key-test",
    attestorPublicKey: platformPublicKey,
    now,
  },
};

function spec(): GeneratedAgentSpec {
  return {
    key: "GenerateAgent",
    actionName: "GenerateAgent",
    slug: "agents-generation-generate-agent",
    short: "GenerateAgentAgent",
    domainId: "Agents-generation",
    nameZh: "生成 Agent",
    kind: "llm",
    trigger: ["AGENT_GENERATION_REQUESTED"],
    emit: ["AGENT_GENERATED"],
    tools: [],
    unresolvedTools: [],
    objects: ["AgentDraft"],
    systemPrompt: "生成并验证 Agent。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    generatedCode: "export const generatedFunction = { id: 'generate-agent' };",
    codeExecuted: true,
  } as GeneratedAgentSpec;
}

function cleanupReceipt(bundle: SandboxCandidateBundle): SandboxCleanupReceipt {
  const drainBody = {
    schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
    sandboxAttemptId: bundle.attemptId,
    appId: `sandbox-app-${bundle.attemptId}`,
    sandboxTenantSlug: bundle.sandboxTenantSlug,
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    observedRuns: [],
  };
  const body: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
    schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
    appId: drainBody.appId,
    sandboxTenantSlug: bundle.sandboxTenantSlug,
    sandboxAttemptId: bundle.attemptId,
    candidateFingerprint: bundle.candidateFingerprint,
    targetDomainId: bundle.targetDomainId,
    runDrain: {
      ...drainBody,
      evidenceHash: sandboxRunDrainReceiptHash(drainBody),
    },
    deletedAt: now.toISOString(),
    absence: {
      connected: false,
      functionCount: null,
      registryState: "not_registered",
    },
  };
  return { ...body, absenceProbeHash: sandboxCleanupReceiptHash(body) };
}

function completedResult(
  bundle: SandboxCandidateBundle,
  imageDigest = runtimeImageDigest,
): SandboxDeployResult {
  const cleanup = cleanupReceipt(bundle);
  const modelUsage = readFactorySandboxModelUsageEvidence(bundle.attemptId, bundle.bundleHash);
  if (!modelUsage) throw new Error("test model grant was not registered");
  const platformAttestation = signSandboxExecutionPlaneAttestation(
    {
      schema: SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
      planeId: "sandbox-plane-test",
      trustDomain: "test.agentic.internal",
      runnerId,
      runnerBuildId,
      runtimeImageDigest: imageDigest,
      isolationTier: "remote_container",
      controlHostIdentityHash,
      workloadHostIdentityHash,
      dockerDaemonIdentityHash,
      capabilities: sandboxExecutionPlaneCapabilities(),
      issuedAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      attestorKeyId: "platform-key-test",
      signatureAlgorithm: "ed25519",
    },
    platformPrivateKey,
  );
  const body: SandboxDeployResult = {
    appId: cleanup.appId,
    functionsRegistered: 1,
    ran: 1,
    deployed: 1,
    reachedSuccessTerminal: true,
    fullChainRan: true,
    codeRanAgents: ["GenerateAgentAgent"],
    degradedAgents: [],
    runs: [{ id: "run-1", status: "ok" }],
    fingerprint: bundle.candidateFingerprint,
    simulated: false,
    toolMode: "evidence_replay",
    externalLiveCalls: 0,
    sandboxReplayEvidenceComplete: true,
    replayReceipts: [],
    sandboxDispatches: [],
    candidateFingerprint: bundle.candidateFingerprint,
    targetDomainId: bundle.targetDomainId,
    sandboxAttemptId: bundle.attemptId,
    sandboxTenantSlug: bundle.sandboxTenantSlug,
    cleanupVerified: true,
    cleanupReceipt: cleanup,
    modelUsage,
    functionTester: [{
      short: "GenerateAgentAgent",
      pass: true,
      ran: true,
      emitNames: [],
      reasons: [],
      tier: "external-container",
      fixtureMode: "scripted",
      qualification: "promotable",
    }],
  };
  const cleanupBody = {
    schema: "agent-factory-sandbox-infrastructure-cleanup/v1" as const,
    candidateExecutionAbsent: true as const,
    workspaceAbsent: true as const,
    candidateSecretsIssued: false as const,
    isolation: "isolated_container" as const,
    executionOwners: { declarativeFunctions: 0, codeactFunctions: 1 },
    candidateExecutions: [{
      schema: "agentic-codeact-container-execution/v1" as const,
      attemptId: bundle.attemptId,
      containerIdHash: `sha256:${"1".repeat(64)}`,
      codeSha256: "2".repeat(64),
      candidateImageDigest: `test/codeact-candidate@sha256:${"3".repeat(64)}`,
      imageId: `sha256:${"4".repeat(64)}`,
      policyHash: `sha256:${"5".repeat(64)}`,
      isolation: "isolated_container" as const,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      removedAt: now.toISOString(),
      exitCode: 0,
      oomKilled: false,
      rpcCount: 1,
      removed: true as const,
      absenceVerified: true as const,
    }],
    verifiedAt: now.toISOString(),
  };
  const unsigned = {
    schema: "agent-factory-sandbox-execution/v2" as const,
    executionOrigin: "remote" as const,
    isolationTier: "remote_container" as const,
    candidateFingerprint: bundle.candidateFingerprint,
    targetDomainId: bundle.targetDomainId,
    targetTenantId: bundle.targetTenant.id,
    targetTenantSlug: bundle.targetTenant.slug,
    sandboxAttemptId: bundle.attemptId,
    bundleHash: bundle.bundleHash,
    resultHash: remoteSandboxResultHash(body),
    runnerId,
    runnerBuildId,
    runtimeImageDigest: imageDigest,
    platformAttestation,
    candidateBundleVerification: verifyExactSandboxCandidateBundle(
      bundle,
      now.toISOString(),
    ),
    brokerOriginHash: `sha256:${"c".repeat(64)}`,
    serveOriginHash: `sha256:${"d".repeat(64)}`,
    policyHash: `sandbox-policy:v1:${canonicalSandboxSha256(bundle.policy)}`,
    networkPolicy: "deny_public_egress" as const,
    externalLiveCalls: 0 as const,
    modelUsageHash: modelUsage.evidenceHash,
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    infrastructureCleanup: {
      ...cleanupBody,
      evidenceHash: sandboxInfrastructureCleanupEvidenceHash(cleanupBody),
    },
    signatureAlgorithm: "hmac-sha256" as const,
  };
  const receiptWithoutSignature = {
    ...unsigned,
    attestationHash: sandboxExecutionReceiptHash(unsigned),
  } satisfies Omit<SandboxExecutionPlaneReceipt, "signature">;
  return {
    ...body,
    executionReceipt: signSandboxExecutionPlaneReceipt(
      receiptWithoutSignature,
      receiptKey,
    ),
  };
}

function sameHostDiagnosticReceipt(
  receipt: SandboxExecutionPlaneReceipt,
): SandboxExecutionPlaneReceipt {
  const {
    signature: _signature,
    platformAttestation: _platformAttestation,
    ...unsigned
  } = receipt;
  const diagnostic = {
    ...unsigned,
    isolationTier: "same_host_container" as const,
    attestationHash: "",
  };
  diagnostic.attestationHash = sandboxExecutionReceiptHash(diagnostic);
  return signSandboxExecutionPlaneReceipt(diagnostic, receiptKey);
}

function resultEnvelope(
  payload: RemoteSandboxJobResult<SandboxDeployResult>,
  nonce: string,
) {
  return signRemoteSandboxMessage({
    purpose: "result",
    keyId: connection.keyId,
    secret: resultKey,
    payload,
    now,
    nonce,
    ttlMs: 60_000,
  });
}

function cleanedFailedResult(bundle: SandboxCandidateBundle): SandboxDeployResult {
  const { executionReceipt: _receipt, ...cleaned } = completedResult(bundle);
  return {
    ...cleaned,
    reachedSuccessTerminal: false,
    fullChainRan: false,
    degradedAgents: ["fixture replay did not match"],
    sandboxReplayEvidenceComplete: false,
  };
}

function transport(imageDigest = runtimeImageDigest): RemoteSandboxTransport & {
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn(
    async (
      attemptId: string,
      envelope: SignedRemoteSandboxMessage<RemoteSandboxAttemptCommand>,
    ) =>
      resultEnvelope(
        {
          schema: "agent-factory-sandbox-remote-result/v1",
          attemptId,
          bundleHash: envelope.payload.bundleHash,
          status: "cancelled",
        },
        `cancel-${attemptId}`,
      ),
  );
  return {
    submit: async (
      envelope: SignedRemoteSandboxMessage<
        RemoteSandboxSubmitCommand<SandboxCandidateBundle>
      >,
    ) => {
      const bundle = envelope.payload.bundle;
      return resultEnvelope(
        {
          schema: "agent-factory-sandbox-remote-result/v1",
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          status: "completed",
          result: completedResult(bundle, imageDigest),
        },
        `completed-${bundle.attemptId}`,
      );
    },
    status: async () => {
      throw new Error("immediate completion should not poll");
    },
    cancel,
  };
}

function deployer(remoteTransport: RemoteSandboxTransport) {
  return new RemoteSandboxDeployer({
    tenantScope: {
      tenantId: "tenant-agents-generation",
      tenantSlug: "agents-generation",
    },
    connection,
    targetInngestIsolation: makeTargetInngestIsolationIdentity("agents-generation"),
    transport: remoteTransport,
    controlPlaneBuildId: "api-build-20260715",
    now: () => now,
    pollIntervalMs: 10,
    timeoutMs: 1_000,
  });
}

describe("RemoteSandboxDeployer", () => {
  it("does not contact the sandbox in production without a current host-signed image proof", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE", "");
    vi.stubEnv("FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE", "");
    const remoteTransport = transport();

    await expect(deployer(remoteTransport).deployAndObserve(
      "Agents-generation",
      [spec()],
      { candidateFingerprint: "sandbox-evidence:v5:image-trust-blocked" },
    )).rejects.toMatchObject({
      block: expect.objectContaining({
        code: "sandbox_config_missing",
        next: "ask_user",
        question: expect.stringContaining("主机签名证明"),
      }),
    });
    expect(remoteTransport.cancel).not.toHaveBeenCalled();
  });

  it("accepts only a signed, identity-bound and fully cleaned remote result", async () => {
    const remoteTransport = transport();
    const result = await deployer(remoteTransport).deployAndObserve(
      "Agents-generation",
      [spec()],
      { candidateFingerprint: "sandbox-evidence:v5:remote-deployer" },
    );
    expect(result).toMatchObject({
      reachedSuccessTerminal: true,
      cleanupVerified: true,
      externalLiveCalls: 0,
      toolMode: "evidence_replay",
      executionReceipt: {
        executionOrigin: "remote",
        runtimeImageDigest,
      },
    });
    expect(remoteTransport.cancel).not.toHaveBeenCalled();
  });

  it("validates same-host receipts only as explicit diagnostic evidence and downgrades the run", async () => {
    let diagnosticChecked = false;
    const remoteTransport: RemoteSandboxTransport = {
      submit: async (envelope) => {
        const bundle = envelope.payload.bundle;
        const result = completedResult(bundle);
        const diagnosticReceipt = sameHostDiagnosticReceipt(result.executionReceipt!);
        const args = {
          secret: receiptKey,
          expected: {
            candidateFingerprint: bundle.candidateFingerprint,
            sandboxAttemptId: bundle.attemptId,
          },
          expectedRunnerId: runnerId,
          allowedRunnerBuildIds: connection.allowedBuildIds,
          allowedRuntimeImageDigests: connection.allowedImageDigests,
          now,
        };
        expect(() => verifySandboxExecutionPlaneReceipt(
          diagnosticReceipt,
          args,
        )).toThrow(/isolation tier is not promotable/);
        expect(() => verifySandboxExecutionPlaneReceipt(
          diagnosticReceipt,
          { ...args, allowDiagnosticSameHost: true },
        )).not.toThrow();
        diagnosticChecked = true;
        return resultEnvelope({
          schema: "agent-factory-sandbox-remote-result/v1",
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          status: "completed",
          result: { ...result, executionReceipt: diagnosticReceipt },
        }, `diagnostic-verification-${bundle.attemptId}`);
      },
      status: async () => { throw new Error("immediate completion should not poll"); },
      cancel: async () => { throw new Error("successful result must not cancel"); },
    };
    const diagnosticDeployer = new RemoteSandboxDeployer({
      tenantScope: {
        tenantId: "tenant-agents-generation",
        tenantSlug: "agents-generation",
      },
      connection,
      targetInngestIsolation: makeTargetInngestIsolationIdentity("agents-generation"),
      transport: remoteTransport,
      controlPlaneBuildId: "api-build-20260715",
      now: () => now,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      productionImageTrust: () => ({
        configured: true,
        ok: true,
        state: "ready",
        topology: "single_host_compose",
        diagnosticOnly: true,
      }),
    });
    const result = await diagnosticDeployer.deployAndObserve(
      "Agents-generation",
      [spec()],
      { candidateFingerprint: "sandbox-evidence:v5:diagnostic-receipt" },
    );
    expect(diagnosticChecked).toBe(true);
    expect(result.degradedAgents).toContain("same_host_container_diagnostic_only");
    expect(result.functionTester?.every(
      (entry) => entry.qualification === "development_only",
    )).toBe(true);
  });

  it("allows an explicit diagnostic trust result in development composition", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() =>
      new RemoteSandboxDeployer({
        tenantScope: {
          tenantId: "tenant-agents-generation",
          tenantSlug: "agents-generation",
        },
        connection,
        targetInngestIsolation:
          makeTargetInngestIsolationIdentity("agents-generation"),
        transport: transport(),
        controlPlaneBuildId: "api-build-20260715",
        productionImageTrust: () => ({
          configured: false,
          ok: true,
          state: "disabled",
          topology: "single_host_compose",
          diagnosticOnly: true,
        }),
      }),
    ).not.toThrow();
  });

  it("refuses an injected diagnostic trust result in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      new RemoteSandboxDeployer({
        tenantScope: {
          tenantId: "tenant-agents-generation",
          tenantSlug: "agents-generation",
        },
        connection,
        targetInngestIsolation:
          makeTargetInngestIsolationIdentity("agents-generation"),
        transport: transport(),
        controlPlaneBuildId: "api-build-20260715",
        productionImageTrust: () => ({
          configured: true,
          ok: true,
          state: "ready",
          topology: "single_host_compose",
          diagnosticOnly: true,
        }),
      }),
    ).toThrow(/cannot be injected in production/);
  });

  it("blocks an otherwise valid receipt from a non-allowlisted workload image", async () => {
    const remoteTransport = transport(`sha256:${"e".repeat(64)}`);
    await expect(
      deployer(remoteTransport).deployAndObserve(
        "Agents-generation",
        [spec()],
        { candidateFingerprint: "sandbox-evidence:v5:untrusted-image" },
      ),
    ).rejects.toMatchObject({
      block: expect.objectContaining({
        code: "sandbox_execution_failed",
        next: "ask_user",
        question: expect.stringContaining("清理干净"),
      }),
    });
    expect(remoteTransport.cancel).toHaveBeenCalledOnce();
  });

  it("keeps cleanup_failed when cancellation cannot be verified", async () => {
    const remoteTransport = transport(`sha256:${"e".repeat(64)}`);
    remoteTransport.cancel.mockRejectedValueOnce(new Error("runner unavailable"));
    await expect(
      deployer(remoteTransport).deployAndObserve(
        "Agents-generation",
        [spec()],
        { candidateFingerprint: "sandbox-evidence:v5:cleanup-unconfirmed" },
      ),
    ).rejects.toMatchObject({
      block: expect.objectContaining({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
      }),
    });
  });

  it("returns a cleaned red candidate for revision without poisoning cleanup", async () => {
    const cancel = vi.fn();
    const remoteTransport: RemoteSandboxTransport = {
      submit: async (envelope) => {
        const bundle = envelope.payload.bundle;
        return resultEnvelope({
          schema: "agent-factory-sandbox-remote-result/v1",
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          status: "completed",
          result: cleanedFailedResult(bundle),
        }, `cleaned-red-${bundle.attemptId}`);
      },
      status: async () => { throw new Error("immediate completion should not poll"); },
      cancel,
    };

    const result = await deployer(remoteTransport).deployAndObserve(
      "Agents-generation",
      [spec()],
      { candidateFingerprint: "sandbox-evidence:v5:cleaned-red" },
    );
    expect(result).toMatchObject({
      fullChainRan: false,
      cleanupVerified: true,
      sandboxReplayEvidenceComplete: false,
    });
    expect(result.executionReceipt).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("maps a signed clean runner rejection to an actionable isolation block", async () => {
    const cancel = vi.fn(
      async (
        attemptId: string,
        envelope: SignedRemoteSandboxMessage<RemoteSandboxAttemptCommand>,
      ) => resultEnvelope({
        schema: "agent-factory-sandbox-remote-result/v1",
        attemptId,
        bundleHash: envelope.payload.bundleHash,
        status: "cancelled",
      }, `cancel-clean-rejection-${attemptId}`),
    );
    const remoteTransport: RemoteSandboxTransport = {
      submit: async (envelope) => {
        const bundle = envelope.payload.bundle;
        return resultEnvelope({
          schema: "agent-factory-sandbox-remote-result/v1",
          attemptId: bundle.attemptId,
          bundleHash: bundle.bundleHash,
          status: "cancelled",
          error: {
            code: "sandbox_cancelled",
            message: "target broker identity does not match the sandbox",
          },
        }, `clean-rejection-${bundle.attemptId}`);
      },
      status: async () => { throw new Error("immediate rejection should not poll"); },
      cancel,
    };

    await expect(
      deployer(remoteTransport).deployAndObserve(
        "Agents-generation",
        [spec()],
        { candidateFingerprint: "sandbox-evidence:v5:clean-rejection" },
      ),
    ).rejects.toMatchObject({
      block: expect.objectContaining({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: expect.stringContaining("确认没有遗留运行资源"),
      }),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("remote sandbox connection configuration", () => {
  const refs = {
    runnerUrlEnv: "TEST_SANDBOX_RUNNER_URL",
    requestSigningKeyEnv: "TEST_SANDBOX_REQUEST_HMAC",
    resultSigningKeyEnv: "TEST_SANDBOX_RESULT_HMAC",
    keyIdEnv: "TEST_SANDBOX_KEY_ID",
    runnerIdEnv: "TEST_SANDBOX_RUNNER_ID",
    allowedBuildIdsEnv: "TEST_SANDBOX_BUILD_IDS",
    allowedImageDigestsEnv: "TEST_SANDBOX_IMAGE_DIGESTS",
  };

  it("requires three distinct signing purposes for a promotable external plane", () => {
    const base = {
      [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refs),
      AGENTIC_PROCESS_ROLE: "api",
      FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "external_sandbox",
      TEST_SANDBOX_RUNNER_URL: "https://sandbox.example.test",
      TEST_SANDBOX_REQUEST_HMAC: requestKey,
      TEST_SANDBOX_RESULT_HMAC: resultKey,
      TEST_SANDBOX_KEY_ID: "sandbox-key-v1",
      TEST_SANDBOX_RUNNER_ID: runnerId,
      TEST_SANDBOX_BUILD_IDS: JSON.stringify([runnerBuildId]),
      TEST_SANDBOX_IMAGE_DIGESTS: runtimeImageDigest,
    };
    expect(() => loadRemoteSandboxConnectionConfig(base)).toThrow(
      /independent receipt signing key reference/,
    );

    const refsWithReceipt = {
      ...refs,
      receiptSigningKeyEnv: "TEST_SANDBOX_RECEIPT_HMAC",
      executionPlaneIdEnv: "TEST_SANDBOX_EXECUTION_PLANE_ID",
      executionPlaneTrustDomainEnv: "TEST_SANDBOX_EXECUTION_PLANE_TRUST_DOMAIN",
      platformAttestorKeyIdEnv: "TEST_SANDBOX_PLATFORM_ATTESTOR_KEY_ID",
      platformAttestorPublicKeyEnv:
        "TEST_SANDBOX_PLATFORM_ATTESTOR_PUBLIC_KEY",
      primaryHostIdentityHashEnv: "TEST_PRIMARY_HOST_IDENTITY_HASH",
      primaryDockerDaemonIdentityHashEnv:
        "TEST_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH",
      allowedControlHostIdentityHashesEnv:
        "TEST_SANDBOX_ALLOWED_CONTROL_HOST_IDENTITY_HASHES",
      allowedWorkloadHostIdentityHashesEnv:
        "TEST_SANDBOX_ALLOWED_WORKLOAD_HOST_IDENTITY_HASHES",
      allowedDockerDaemonIdentityHashesEnv:
        "TEST_SANDBOX_ALLOWED_DOCKER_DAEMON_IDENTITY_HASHES",
    };
    const platformEnv = {
      TEST_SANDBOX_EXECUTION_PLANE_ID: "sandbox-plane-test",
      TEST_SANDBOX_EXECUTION_PLANE_TRUST_DOMAIN: "test.agentic.internal",
      TEST_SANDBOX_PLATFORM_ATTESTOR_KEY_ID: "platform-key-test",
      TEST_SANDBOX_PLATFORM_ATTESTOR_PUBLIC_KEY: platformPublicKey,
      TEST_PRIMARY_HOST_IDENTITY_HASH: `sha256:${"9".repeat(64)}`,
      TEST_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH:
        `sha256:${"a".repeat(64)}`,
      TEST_SANDBOX_ALLOWED_CONTROL_HOST_IDENTITY_HASHES:
        controlHostIdentityHash,
      TEST_SANDBOX_ALLOWED_WORKLOAD_HOST_IDENTITY_HASHES:
        workloadHostIdentityHash,
      TEST_SANDBOX_ALLOWED_DOCKER_DAEMON_IDENTITY_HASHES:
        dockerDaemonIdentityHash,
    };
    expect(() => loadRemoteSandboxConnectionConfig({
      ...base,
      ...platformEnv,
      [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refsWithReceipt),
      TEST_SANDBOX_RECEIPT_HMAC: resultKey,
    })).toThrow(/must be distinct/);

    expect(loadRemoteSandboxConnectionConfig({
      ...base,
      ...platformEnv,
      [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refsWithReceipt),
      TEST_SANDBOX_RECEIPT_HMAC:
        "receipt-key-that-is-independent-and-at-least-32-bytes",
    }).receiptSigningKey).toContain("receipt-key-that-is-independent");
  });

  it("loads indirection-only config and never needs secrets in the refs JSON", () => {
    const loaded = loadRemoteSandboxConnectionConfig({
      [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refs),
      AGENTIC_PROCESS_ROLE: "api",
      FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: "sandbox-runner",
      TEST_SANDBOX_RUNNER_URL: "http://sandbox-runner:3560/",
      TEST_SANDBOX_REQUEST_HMAC: requestKey,
      TEST_SANDBOX_RESULT_HMAC: resultKey,
      TEST_SANDBOX_KEY_ID: "sandbox-key-v1",
      TEST_SANDBOX_RUNNER_ID: runnerId,
      TEST_SANDBOX_BUILD_IDS: JSON.stringify([runnerBuildId]),
      TEST_SANDBOX_IMAGE_DIGESTS: runtimeImageDigest,
    });
    expect(loaded).toMatchObject({
      runnerUrl: "http://sandbox-runner:3560",
      keyId: "sandbox-key-v1",
      runnerId,
      receiptSigningKey: resultKey,
    });
    expect([...loaded.allowedBuildIds]).toEqual([runnerBuildId]);
    expect([...loaded.allowedImageDigests]).toEqual([runtimeImageDigest]);
  });

  it("rejects a weak HMAC key before the first request", () => {
    expect(() =>
      loadRemoteSandboxConnectionConfig({
        [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refs),
        AGENTIC_PROCESS_ROLE: "api",
        FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: "sandbox-runner",
        TEST_SANDBOX_RUNNER_URL: "http://sandbox-runner:3560",
        TEST_SANDBOX_REQUEST_HMAC: "too-short",
        TEST_SANDBOX_RESULT_HMAC: resultKey,
        TEST_SANDBOX_KEY_ID: "sandbox-key-v1",
        TEST_SANDBOX_RUNNER_ID: runnerId,
        TEST_SANDBOX_BUILD_IDS: runnerBuildId,
        TEST_SANDBOX_IMAGE_DIGESTS: runtimeImageDigest,
      }),
    ).toThrow(/at least 32 bytes/i);
  });

  it("rejects plain HTTP to a non-allowlisted or non-API runner", () => {
    const base = {
      [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refs),
      TEST_SANDBOX_RUNNER_URL: "http://sandbox-runner:3560",
      TEST_SANDBOX_REQUEST_HMAC: requestKey,
      TEST_SANDBOX_RESULT_HMAC: resultKey,
      TEST_SANDBOX_KEY_ID: "sandbox-key-v1",
      TEST_SANDBOX_RUNNER_ID: runnerId,
      TEST_SANDBOX_BUILD_IDS: runnerBuildId,
      TEST_SANDBOX_IMAGE_DIGESTS: runtimeImageDigest,
    };
    expect(() => loadRemoteSandboxConnectionConfig({
      ...base,
      AGENTIC_PROCESS_ROLE: "api",
      FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: "another-service",
    })).toThrow(/Plain HTTP remote sandbox/);
    expect(() => loadRemoteSandboxConnectionConfig({
      ...base,
      AGENTIC_PROCESS_ROLE: "sandbox-runner-control",
      FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: "sandbox-runner",
    })).toThrow(/Plain HTTP remote sandbox/);
  });

  it("rejects tags and malformed image identities in the execution allowlist", () => {
    expect(() =>
      loadRemoteSandboxConnectionConfig({
        [FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]: JSON.stringify(refs),
        AGENTIC_PROCESS_ROLE: "api",
        FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: "sandbox-runner",
        TEST_SANDBOX_RUNNER_URL: "http://sandbox-runner:3560",
        TEST_SANDBOX_REQUEST_HMAC: requestKey,
        TEST_SANDBOX_RESULT_HMAC: resultKey,
        TEST_SANDBOX_KEY_ID: "sandbox-key-v1",
        TEST_SANDBOX_RUNNER_ID: runnerId,
        TEST_SANDBOX_BUILD_IDS: runnerBuildId,
        TEST_SANDBOX_IMAGE_DIGESTS: "agentic-sandbox-workload:latest",
      }),
    ).toThrow(/lowercase sha256:<64 hex>/i);
  });
});
