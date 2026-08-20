import {
  SANDBOX_CANDIDATE_BUNDLE_VERIFICATION_SCHEMA,
  SANDBOX_EXECUTION_RECEIPT_SCHEMA,
  SANDBOX_INFRASTRUCTURE_CLEANUP_SCHEMA,
  SANDBOX_MODEL_USAGE_SCHEMA,
  SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
  sandboxCandidateBundleVerificationEvidenceHash,
  sandboxExecutionPlaneCapabilities,
  sandboxExecutionReceiptHash,
  sandboxInfrastructureCleanupEvidenceHash,
  sandboxModelUsageEvidenceHash,
  signSandboxExecutionPlaneAttestation,
  type SandboxExecutionPlaneReceipt,
  type SandboxModelUsageEvidence,
} from "@agentic/agent-factory";
import { generateKeyPairSync } from "node:crypto";

import { signSandboxExecutionPlaneReceipt } from "../src/services/agent-factory/sandbox-remote-protocol";
import type { TargetInngestIsolationIdentity } from "@agentic/runtime";

const platformKeys = generateKeyPairSync("ed25519");
const platformPrivateKey = platformKeys.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

export function makeTargetInngestIsolationIdentity(
  targetTenantSlug: string,
): TargetInngestIsolationIdentity {
  return {
    schema: "agent-factory-target-inngest-isolation/v1",
    targetTenantSlug,
    eventChannelFingerprint: `sha256:${"1".repeat(64)}`,
    signatureChannelFingerprint: `sha256:${"2".repeat(64)}`,
    brokerFingerprint: `sha256:${"3".repeat(64)}`,
    appNamespaceFingerprint: `sha256:${"4".repeat(64)}`,
  };
}

/**
 * Test-only representation of a receipt that has already crossed the remote
 * runner adapter. Keep fixtures on the same v2 identity/cleanup contract as
 * production instead of weakening promotion validation under NODE_ENV=test.
 */
export function makePromotableSandboxExecutionReceipt(input: {
  candidateFingerprint: string;
  targetDomainId: string;
  sandboxAttemptId: string;
  targetTenantId?: string;
  targetTenantSlug?: string;
  marker?: string;
  modelUsageHash?: string;
  isolationTier?: "remote_container" | "remote_vm" | "same_host_container";
}): SandboxExecutionPlaneReceipt {
  const marker = (input.marker ?? "a").slice(0, 1).padEnd(1, "a");
  const now = new Date(0).toISOString();
  const runnerId = "test-external-runner";
  const runnerBuildId = "test-external-runner-build";
  const runtimeImageDigest = `sha256:${marker.repeat(64)}`;
  const isolationTier = input.isolationTier ?? "remote_container";
  const platformAttestation = signSandboxExecutionPlaneAttestation(
    {
      schema: SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
      planeId: "test-execution-plane",
      trustDomain: "test.agentic.internal",
      runnerId,
      runnerBuildId,
      runtimeImageDigest,
      isolationTier,
      controlHostIdentityHash: `sha256:${"6".repeat(64)}`,
      workloadHostIdentityHash: `sha256:${"7".repeat(64)}`,
      dockerDaemonIdentityHash: `sha256:${"8".repeat(64)}`,
      capabilities: sandboxExecutionPlaneCapabilities(),
      issuedAt: now,
      expiresAt: new Date(24 * 60 * 60_000).toISOString(),
      attestorKeyId: "test-platform-attestor",
      signatureAlgorithm: "ed25519",
    },
    platformPrivateKey,
  );
  const bundleHash = `sandbox-bundle:v2:${marker.repeat(64)}`;
  const bundleVerificationBody = {
    schema: SANDBOX_CANDIDATE_BUNDLE_VERIFICATION_SCHEMA,
    candidateBundleSchema:
      "agent-factory-sandbox-candidate-bundle/v2" as const,
    sandboxAttemptId: input.sandboxAttemptId,
    candidateFingerprint: input.candidateFingerprint,
    bundleHash,
    specsFingerprint: `specs:v2:${"9".repeat(64)}`,
    manifestHash: `manifest:v1:${"a".repeat(64)}`,
    testSuiteHash: `test-suite:v1:${"b".repeat(64)}`,
    toolSnapshotHash: `tool-snapshot:v1:${"c".repeat(64)}`,
    verifiedAt: now,
  };
  const candidateBundleVerification = {
    ...bundleVerificationBody,
    evidenceHash: sandboxCandidateBundleVerificationEvidenceHash(
      bundleVerificationBody,
    ),
  };
  const cleanupBody = {
    schema: SANDBOX_INFRASTRUCTURE_CLEANUP_SCHEMA,
    candidateExecutionAbsent: true as const,
    workspaceAbsent: true as const,
    candidateSecretsIssued: false as const,
    isolation: "isolated_container" as const,
    executionOwners: { declarativeFunctions: 0, codeactFunctions: 1 },
    candidateExecutions: [{
      schema: "agentic-codeact-container-execution/v1" as const,
      attemptId: input.sandboxAttemptId,
      containerIdHash: `sha256:${"1".repeat(64)}`,
      codeSha256: "2".repeat(64),
      candidateImageDigest: `test/codeact-candidate@sha256:${"3".repeat(64)}`,
      imageId: `sha256:${"4".repeat(64)}`,
      policyHash: `sha256:${"5".repeat(64)}`,
      isolation: "isolated_container" as const,
      startedAt: now,
      completedAt: now,
      removedAt: now,
      exitCode: 0,
      oomKilled: false,
      rpcCount: 1,
      removed: true as const,
      absenceVerified: true as const,
    }],
    verifiedAt: now,
  };
  const unsigned = {
    schema: SANDBOX_EXECUTION_RECEIPT_SCHEMA,
    executionOrigin: "remote" as const,
    isolationTier,
    candidateFingerprint: input.candidateFingerprint,
    targetDomainId: input.targetDomainId,
    targetTenantId: input.targetTenantId ?? "ten-test-external-sandbox",
    targetTenantSlug: input.targetTenantSlug ?? "test-external-sandbox",
    sandboxAttemptId: input.sandboxAttemptId,
    bundleHash,
    resultHash: `sandbox-result:v1:${marker.repeat(64)}`,
    runnerId,
    runnerBuildId,
    runtimeImageDigest,
    platformAttestation,
    candidateBundleVerification,
    brokerOriginHash: `sha256:${"b".repeat(64)}`,
    serveOriginHash: `sha256:${"c".repeat(64)}`,
    policyHash: `sandbox-policy:v1:${"d".repeat(64)}`,
    networkPolicy: "deny_public_egress" as const,
    externalLiveCalls: 0 as const,
    modelUsageHash: input.modelUsageHash
      ?? `sandbox-model-usage:v1:${"e".repeat(64)}`,
    startedAt: now,
    completedAt: now,
    infrastructureCleanup: {
      ...cleanupBody,
      evidenceHash: sandboxInfrastructureCleanupEvidenceHash(cleanupBody),
    },
    signatureAlgorithm: "hmac-sha256" as const,
  };
  const receipt = {
    ...unsigned,
    attestationHash: sandboxExecutionReceiptHash(unsigned),
  } satisfies Omit<SandboxExecutionPlaneReceipt, "signature">;
  return signSandboxExecutionPlaneReceipt(
    receipt,
    "test-only-remote-receipt-signing-key-0001",
  );
}

/** Build measured, attempt-bound model evidence for tests that exercise the
 * production promotion gate. This is deliberately explicit test evidence;
 * production code has no missing-evidence waiver. */
export function makePromotableSandboxModelUsage(input: {
  sandboxAttemptId: string;
  targetTenantId?: string;
  targetTenantSlug?: string;
  marker?: string;
  agentRefs: string[];
}): SandboxModelUsageEvidence {
  const marker = (input.marker ?? "a").slice(0, 1).padEnd(1, "a");
  const now = new Date(0).toISOString();
  const agentRefs = [...new Set(input.agentRefs)].sort();
  const calls = agentRefs.length;
  const body = {
    schema: SANDBOX_MODEL_USAGE_SCHEMA,
    sandboxAttemptId: input.sandboxAttemptId,
    bundleHash: `sandbox-bundle:v2:${marker.repeat(64)}`,
    targetTenantId: input.targetTenantId ?? "ten-test-external-sandbox",
    targetTenantSlug: input.targetTenantSlug ?? "test-external-sandbox",
    calls,
    successfulCalls: calls,
    failedCalls: 0,
    rejectedCalls: 0,
    agentCalls: agentRefs.map((agentRef) => ({
      agentRef,
      calls: 1,
      successfulCalls: 1,
      failedCalls: 0,
      rejectedCalls: 0,
    })),
    rejectedReasons: [],
    providerModels: calls > 0
      ? [{ provider: "test-provider", model: "test-model" }]
      : [],
    inputTokens: calls * 8,
    outputTokens: calls * 4,
    totalTokens: calls * 12,
    budget: {
      enforced: true as const,
      maxCalls: Math.max(1, calls),
      maxTotalTokens: Math.max(1_024, calls * 1_024),
      reservedTotalTokens: calls * 64,
    },
    startedAt: now,
    completedAt: now,
  };
  return {
    ...body,
    evidenceHash: sandboxModelUsageEvidenceHash(body),
  };
}

export function makePromotableSandboxExecutionEvidence(input: {
  candidateFingerprint: string;
  targetDomainId: string;
  sandboxAttemptId: string;
  targetTenantId?: string;
  targetTenantSlug?: string;
  marker?: string;
  agentRefs: string[];
  isolationTier?: "remote_container" | "remote_vm" | "same_host_container";
}): {
  modelUsage: SandboxModelUsageEvidence;
  executionReceipt: SandboxExecutionPlaneReceipt;
} {
  const modelUsage = makePromotableSandboxModelUsage(input);
  return {
    modelUsage,
    executionReceipt: makePromotableSandboxExecutionReceipt({
      ...input,
      modelUsageHash: modelUsage.evidenceHash,
    }),
  };
}
