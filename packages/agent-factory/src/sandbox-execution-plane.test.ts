import { describe, expect, it } from "vitest";

import {
  SANDBOX_EXECUTION_RECEIPT_SCHEMA,
  SANDBOX_CANDIDATE_BUNDLE_VERIFICATION_SCHEMA,
  sandboxCandidateBundleVerificationEvidenceHash,
  sandboxInfrastructureCleanupEvidenceHash,
  sandboxExecutionReceiptHash,
  sandboxExecutionReceiptIssues,
  type SandboxExecutionPlaneReceipt,
} from "./sandbox-execution-plane";
import {
  SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
  sandboxExecutionPlaneAttestationHash,
  sandboxExecutionPlaneCapabilities,
} from "./sandbox-platform-attestation";

function receipt(): SandboxExecutionPlaneReceipt {
  const platformBody = {
    schema: SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
    planeId: "plane-1",
    trustDomain: "sandbox.example",
    runnerId: "runner-1",
    runnerBuildId: "build-1",
    runtimeImageDigest: `sha256:${"a".repeat(64)}`,
    isolationTier: "remote_container" as const,
    controlHostIdentityHash: `sha256:${"6".repeat(64)}`,
    workloadHostIdentityHash: `sha256:${"7".repeat(64)}`,
    dockerDaemonIdentityHash: `sha256:${"8".repeat(64)}`,
    capabilities: sandboxExecutionPlaneCapabilities(),
    issuedAt: new Date(0).toISOString(),
    expiresAt: new Date(60_000).toISOString(),
    attestorKeyId: "attestor-1",
    signatureAlgorithm: "ed25519" as const,
  };
  const platformAttestation = {
    ...platformBody,
    attestationHash: sandboxExecutionPlaneAttestationHash(platformBody),
    signature: "A".repeat(86),
  };
  const bundleVerificationBody = {
    schema: SANDBOX_CANDIDATE_BUNDLE_VERIFICATION_SCHEMA,
    candidateBundleSchema:
      "agent-factory-sandbox-candidate-bundle/v2" as const,
    sandboxAttemptId: "attempt-1",
    candidateFingerprint: "candidate-1",
    bundleHash: `sandbox-bundle:v2:${"9".repeat(64)}`,
    specsFingerprint: `specs:v2:${"a".repeat(64)}`,
    manifestHash: `manifest:v1:${"b".repeat(64)}`,
    testSuiteHash: `test-suite:v1:${"c".repeat(64)}`,
    toolSnapshotHash: `tool-snapshot:v1:${"d".repeat(64)}`,
    verifiedAt: new Date(2_000).toISOString(),
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
      attemptId: "attempt-1",
      containerIdHash: `sha256:${"1".repeat(64)}`,
      codeSha256: "2".repeat(64),
      candidateImageDigest: `test/codeact-candidate@sha256:${"3".repeat(64)}`,
      imageId: `sha256:${"4".repeat(64)}`,
      policyHash: `sha256:${"5".repeat(64)}`,
      isolation: "isolated_container" as const,
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(2_000).toISOString(),
      removedAt: new Date(3_000).toISOString(),
      exitCode: 0,
      oomKilled: false,
      rpcCount: 1,
      removed: true as const,
      absenceVerified: true as const,
    }],
    verifiedAt: new Date(3_000).toISOString(),
  };
  const unsigned: Omit<SandboxExecutionPlaneReceipt, "attestationHash" | "signature"> = {
    schema: SANDBOX_EXECUTION_RECEIPT_SCHEMA,
    executionOrigin: "remote",
    isolationTier: "remote_container",
    candidateFingerprint: "candidate-1",
    targetDomainId: "agents-generation",
    targetTenantId: "tenant-1",
    targetTenantSlug: "agents-generation",
    sandboxAttemptId: "attempt-1",
    bundleHash: bundleVerificationBody.bundleHash,
    resultHash: "result-1",
    runnerId: "runner-1",
    runnerBuildId: "build-1",
    runtimeImageDigest: `sha256:${"a".repeat(64)}`,
    platformAttestation,
    candidateBundleVerification: {
      ...bundleVerificationBody,
      evidenceHash:
        sandboxCandidateBundleVerificationEvidenceHash(
          bundleVerificationBody,
        ),
    },
    brokerOriginHash: "sha256:broker",
    serveOriginHash: "sha256:serve",
    policyHash: "sha256:policy",
    networkPolicy: "deny_public_egress",
    externalLiveCalls: 0,
    modelUsageHash: `sandbox-model-usage:v1:${"e".repeat(64)}`,
    startedAt: new Date(1_000).toISOString(),
    completedAt: new Date(2_000).toISOString(),
    infrastructureCleanup: {
      ...cleanupBody,
      evidenceHash: sandboxInfrastructureCleanupEvidenceHash(cleanupBody),
    },
    signatureAlgorithm: "hmac-sha256",
  };
  return {
    ...unsigned,
    attestationHash: sandboxExecutionReceiptHash(unsigned),
    signature: "server-verified-signature",
  };
}

describe("sandbox execution-plane promotion receipt", () => {
  it("accepts only the exact remote candidate/domain/tenant/attempt tuple", () => {
    const value = receipt();
    expect(sandboxExecutionReceiptIssues(value, {
      candidateFingerprint: "candidate-1",
      targetDomainId: "agents-generation",
      targetTenantId: "tenant-1",
      targetTenantSlug: "agents-generation",
      sandboxAttemptId: "attempt-1",
      bundleHash: value.bundleHash,
      resultHash: "result-1",
    })).toEqual([]);
  });

  it("rejects a downgraded or tampered receipt instead of accepting a green badge", () => {
    const value = receipt();
    const tampered = {
      ...value,
      isolationTier: "worker",
      policyHash: "sha256:changed-policy",
    } as unknown as SandboxExecutionPlaneReceipt;
    expect(sandboxExecutionReceiptIssues(tampered, {
      candidateFingerprint: "another-candidate",
    })).toEqual(expect.arrayContaining([
      "sandbox isolation tier is not promotable",
      "sandbox execution attestation hash mismatch",
      "sandbox execution candidateFingerprint mismatch",
    ]));
  });

  it("records same-host container evidence but never treats it as promotable isolation", () => {
    const value = {
      ...receipt(),
      isolationTier: "same_host_container" as const,
      attestationHash: "",
    };
    value.attestationHash = sandboxExecutionReceiptHash(value);
    expect(sandboxExecutionReceiptIssues(value)).toContain(
      "sandbox isolation tier is not promotable",
    );
  });

  it("rejects a correctly hashed remote_container receipt backed only by worker/vm evidence", () => {
    const value = receipt();
    const cleanupBody = {
      ...value.infrastructureCleanup,
      candidateSecretsIssued: false,
      isolation: "worker_thread_untrusted" as const,
      evidenceHash: "",
    };
    cleanupBody.evidenceHash = sandboxInfrastructureCleanupEvidenceHash(cleanupBody);
    const forged = {
      ...value,
      infrastructureCleanup: cleanupBody,
      attestationHash: "",
    };
    forged.attestationHash = sandboxExecutionReceiptHash(forged);

    expect(sandboxExecutionReceiptIssues(forged)).toContain(
      "sandbox infrastructure cleanup is incomplete",
    );
  });

  it("rejects a tag, short digest or self-described image label as supply-chain identity", () => {
    const value = receipt();
    const malformed = {
      ...value,
      runtimeImageDigest: "agentic-sandbox-workload:latest",
    };
    malformed.attestationHash = sandboxExecutionReceiptHash(malformed);
    expect(sandboxExecutionReceiptIssues(malformed)).toContain(
      "runtime image digest is not a canonical OCI sha256 digest",
    );
  });
});
