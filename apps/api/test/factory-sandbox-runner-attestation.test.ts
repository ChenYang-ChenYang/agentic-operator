import { createHash, generateKeyPairSync } from "node:crypto";

import {
  SANDBOX_MODEL_USAGE_SCHEMA,
  sandboxModelUsageEvidenceHash,
  sandboxInfrastructureCleanupEvidenceHash,
  SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
  sandboxExecutionPlaneCapabilities,
  signSandboxExecutionPlaneAttestation,
  type SandboxDeployResult,
  type SandboxInfrastructureCleanupEvidence,
} from "@agentic/agent-factory";
import { describe, expect, it } from "vitest";

import type { SandboxCandidateBundle } from "../src/services/agent-factory/sandbox-bundle-builder";
import { attestSandboxCandidateResult } from "../src/services/agent-factory/sandbox-runner-attestation";
import { canonicalSandboxSha256 } from "../src/services/agent-factory/sandbox-remote-protocol";

const attemptId = "attempt-attestation-security";
const sandboxTenantSlug = "agents-generation-sb-attestation";
const generatedCode = "export const attested = defineAgent({ async handler() { return { ok: true }; } });";

const specs = [{
  slug: "attested-agent",
  short: "AttestedAgent",
  nameZh: "Attested Agent",
  domainId: "Agents-generation",
  codeExecuted: true,
  generatedCode,
}];
const manifest: unknown[] = [];
const bundleBody = {
  schema: "agent-factory-sandbox-candidate-bundle/v2" as const,
  policy: {
    requiredIsolation: "remote_container" as const,
    maxModelCalls: 8,
    maxModelTotalTokens: 100_000,
  },
  candidateFingerprint: "candidate-attestation-security",
  specsFingerprint: `specs:v2:${canonicalSandboxSha256(specs)}`,
  targetDomainId: "Agents-generation",
  targetTenant: { id: "tenant-agents-generation", slug: "agents-generation" },
  attemptId,
  sandboxTenantSlug,
  specs,
  manifest,
  manifestHash: `manifest:v1:${canonicalSandboxSha256(manifest)}`,
  testCases: [],
  toolDefinitions: [],
  toolEvidence: [],
};
const bundle = {
  ...bundleBody,
  bundleHash: `sandbox-bundle:v2:${canonicalSandboxSha256(bundleBody)}`,
} as SandboxCandidateBundle;

const modelUsageBody = {
  schema: SANDBOX_MODEL_USAGE_SCHEMA,
  sandboxAttemptId: attemptId,
  bundleHash: bundle.bundleHash,
  targetTenantId: bundle.targetTenant.id,
  targetTenantSlug: bundle.targetTenant.slug,
  calls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  rejectedCalls: 0,
  agentCalls: [],
  rejectedReasons: [],
  providerModels: [],
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  budget: { enforced: true as const, maxCalls: 8, maxTotalTokens: 100_000, reservedTotalTokens: 0 },
  startedAt: new Date(1_000).toISOString(),
  completedAt: new Date(2_000).toISOString(),
};

const result = {
  cleanupVerified: true,
  externalLiveCalls: 0,
  sandboxReplayEvidenceComplete: true,
  sandboxAttemptId: attemptId,
  sandboxTenantSlug,
  cleanupReceipt: { sandboxAttemptId: attemptId },
  codeRanAgents: ["AttestedAgent"],
  modelUsage: { ...modelUsageBody, evidenceHash: sandboxModelUsageEvidenceHash(modelUsageBody) },
} as SandboxDeployResult;

const identity = {
  runnerId: "runner-security-test",
  runnerBuildId: "build-security-test",
  runtimeImageDigest: `sha256:${"b".repeat(64)}`,
  receiptSigningKey: "test-only-receipt-signing-key-that-is-long-enough",
  brokerOrigin: "http://sandbox-broker.invalid",
  serveOrigin: "http://sandbox-workload.invalid",
  actualIsolationTier: "remote_container" as const,
  platformAttestation: (() => {
    const keys = generateKeyPairSync("ed25519");
    return signSandboxExecutionPlaneAttestation(
      {
        schema: SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA,
        planeId: "test-plane",
        trustDomain: "test.agentic.internal",
        runnerId: "runner-security-test",
        runnerBuildId: "build-security-test",
        runtimeImageDigest: `sha256:${"b".repeat(64)}`,
        isolationTier: "remote_container",
        controlHostIdentityHash: `sha256:${"6".repeat(64)}`,
        workloadHostIdentityHash: `sha256:${"7".repeat(64)}`,
        dockerDaemonIdentityHash: `sha256:${"8".repeat(64)}`,
        capabilities: sandboxExecutionPlaneCapabilities(),
        issuedAt: new Date(0).toISOString(),
        expiresAt: new Date(60_000).toISOString(),
        attestorKeyId: "test-attestor",
        signatureAlgorithm: "ed25519",
      },
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
  })(),
};

function cleanup(
  isolation: SandboxInfrastructureCleanupEvidence["isolation"],
  candidateSecretsIssued: boolean,
): SandboxInfrastructureCleanupEvidence {
  const body = {
    schema: "agent-factory-sandbox-infrastructure-cleanup/v1" as const,
    candidateExecutionAbsent: true as const,
    workspaceAbsent: true as const,
    candidateSecretsIssued,
    isolation,
    executionOwners: { declarativeFunctions: 0, codeactFunctions: 1 },
    candidateExecutions: [{
      schema: "agentic-codeact-container-execution/v1" as const,
      attemptId,
      containerIdHash: `sha256:${"1".repeat(64)}`,
      codeSha256: createHash("sha256").update(generatedCode, "utf8").digest("hex"),
      candidateImageDigest: `test/codeact-candidate@sha256:${"3".repeat(64)}`,
      imageId: `sha256:${"4".repeat(64)}`,
      policyHash: `sha256:${"5".repeat(64)}`,
      isolation: "isolated_container" as const,
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(2_000).toISOString(),
      removedAt: new Date(2_000).toISOString(),
      exitCode: 0,
      oomKilled: false,
      rpcCount: 1,
      removed: true as const,
      absenceVerified: true as const,
    }],
    verifiedAt: new Date(2_000).toISOString(),
  };
  return {
    ...body,
    evidenceHash: sandboxInfrastructureCleanupEvidenceHash(body),
  };
}

describe("sandbox runner execution attestation isolation", () => {
  it("refuses to sign worker/vm cleanup as remote_container", () => {
    expect(() => attestSandboxCandidateResult({
      bundle,
      result,
      identity,
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(2_000).toISOString(),
      infrastructureCleanup: cleanup("worker_thread_untrusted", false),
    })).toThrow(/real subprocess\/container boundary|isolated.*candidate/i);
  });

  it("accepts only an independently reported safe executor boundary", () => {
    const receipt = attestSandboxCandidateResult({
      bundle,
      result,
      identity,
      startedAt: new Date(1_000).toISOString(),
      completedAt: new Date(2_000).toISOString(),
      infrastructureCleanup: cleanup("isolated_container", false),
    });

    expect(receipt).toMatchObject({
      executionOrigin: "remote",
      isolationTier: "remote_container",
      infrastructureCleanup: {
        isolation: "isolated_container",
        candidateSecretsIssued: false,
      },
    });
  });
});
import { createHash } from "node:crypto";
