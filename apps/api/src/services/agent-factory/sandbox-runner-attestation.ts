import { createHash } from "node:crypto";

import {
  sandboxExecutionReceiptHash,
  sandboxInfrastructureCleanupEvidenceIssues,
  sandboxExecutionPlaneAttestationIssues,
  generatedFleetModelRequirement,
  sandboxModelUsageEvidenceIssues,
  type SandboxDeployResult,
  type SandboxExecutionPlaneReceipt,
  type SandboxExecutionPlaneAttestation,
  type SandboxInfrastructureCleanupEvidence,
} from "@agentic/agent-factory";

import type { SandboxCandidateBundle } from "./sandbox-bundle-builder";
import {
  canonicalSandboxSha256,
  remoteSandboxResultHash,
  RemoteSandboxProtocolError,
  signSandboxExecutionPlaneReceipt,
  verifyExactSandboxCandidateBundle,
} from "./sandbox-remote-protocol";

export interface SandboxRunnerExecutionIdentity {
  runnerId: string;
  runnerBuildId: string;
  runtimeImageDigest: string;
  receiptSigningKey: string;
  brokerOrigin: string;
  serveOrigin: string;
  actualIsolationTier: "same_host_container" | "remote_container" | "remote_vm";
  platformAttestation?: SandboxExecutionPlaneAttestation;
}

/** Control-plane attestation over already-returned workload evidence. This file
 * intentionally has no runtime/deployer/tenant imports, so the HMAC signer can
 * be packaged without candidate execution code or tenant adapters. */
export function attestSandboxCandidateResult(input: {
  bundle: SandboxCandidateBundle;
  result: SandboxDeployResult;
  identity: SandboxRunnerExecutionIdentity;
  startedAt: string;
  completedAt: string;
  infrastructureCleanup: SandboxInfrastructureCleanupEvidence;
}): SandboxExecutionPlaneReceipt {
  if (
    input.result.cleanupVerified !== true
    || input.result.externalLiveCalls !== 0
    || input.result.sandboxReplayEvidenceComplete !== true
    || input.result.sandboxAttemptId !== input.bundle.attemptId
    || input.result.sandboxTenantSlug !== input.bundle.sandboxTenantSlug
    || input.result.cleanupReceipt?.sandboxAttemptId !== input.bundle.attemptId
  ) {
    throw new RemoteSandboxProtocolError(
      "runner_result_not_promotable",
      "Workload result is not bound to complete zero-live-call cleanup evidence",
    );
  }
  if (
    input.identity.actualIsolationTier !== "same_host_container"
    && sandboxExecutionPlaneAttestationIssues(
      input.identity.platformAttestation,
    ).length > 0
  ) {
    throw new RemoteSandboxProtocolError(
      "runner_platform_attestation_missing",
      "Remote runner has no valid independently signed platform attestation",
    );
  }
  if (
    input.identity.platformAttestation
    && (
      input.identity.platformAttestation.runnerId !== input.identity.runnerId
      || input.identity.platformAttestation.runnerBuildId
        !== input.identity.runnerBuildId
      || input.identity.platformAttestation.runtimeImageDigest
        !== input.identity.runtimeImageDigest
      || input.identity.platformAttestation.isolationTier
        !== input.identity.actualIsolationTier
    )
  ) {
    throw new RemoteSandboxProtocolError(
      "runner_platform_attestation_mismatch",
      "Remote runner identity does not match its signed platform attestation",
    );
  }
  const infrastructureIssues = sandboxInfrastructureCleanupEvidenceIssues(
    input.infrastructureCleanup,
    input.bundle.attemptId,
  );
  const modelRequirement = generatedFleetModelRequirement(input.bundle.specs);
  const modelUsageIssues = [
    ...modelRequirement.issues,
    ...sandboxModelUsageEvidenceIssues(
    input.result.modelUsage,
    {
      sandboxAttemptId: input.bundle.attemptId,
      bundleHash: input.bundle.bundleHash,
      targetTenantId: input.bundle.targetTenant.id,
      targetTenantSlug: input.bundle.targetTenant.slug,
      modelRequired: modelRequirement.requiredAgentRefs.length > 0,
      requiredAgentRefs: modelRequirement.requiredAgentRefs,
    },
  )];
  if (
    input.result.modelUsage?.budget.maxCalls !== input.bundle.policy.maxModelCalls
    || input.result.modelUsage?.budget.maxTotalTokens !== input.bundle.policy.maxModelTotalTokens
  ) {
    modelUsageIssues.push("model usage is not bound to the submitted budget policy");
  }
  if (modelUsageIssues.length) {
    throw new RemoteSandboxProtocolError(
      "runner_model_usage_invalid",
      `Workload did not prove real, budgeted semantic-model usage: ${modelUsageIssues.join("; ")}`,
    );
  }
  const codeSpecs = input.bundle.specs.filter((spec) => spec.codeExecuted === true);
  const declarativeSpecs = input.bundle.specs.filter((spec) => spec.codeExecuted !== true);
  const candidateCodeHashes = new Set(
    input.infrastructureCleanup.candidateExecutions.map((execution) => execution.codeSha256),
  );
  const codeRanAgents = new Set(input.result.codeRanAgents ?? []);
  const runtimeRanAgents = new Set((input.result.agentRuns ?? []).flatMap((run) => [
    run.agentSlug,
    run.agentShort,
  ]));
  if (
    input.infrastructureCleanup.executionOwners.codeactFunctions !== codeSpecs.length
    || input.infrastructureCleanup.executionOwners.declarativeFunctions !== declarativeSpecs.length
    || codeSpecs.some((spec) => !candidateCodeHashes.has(
      createHash("sha256").update(spec.generatedCode ?? "", "utf8").digest("hex"),
    ))
    || codeSpecs.some((spec) => !codeRanAgents.has(spec.short))
    || declarativeSpecs.some((spec) =>
      !runtimeRanAgents.has(spec.slug)
      && !runtimeRanAgents.has(spec.short)
      && !runtimeRanAgents.has(spec.nameZh))
  ) {
    infrastructureIssues.push(
      "execution-owner evidence does not exactly cover the signed generated artifacts",
    );
  }
  if (infrastructureIssues.length) {
    throw new RemoteSandboxProtocolError(
      "runner_cleanup_evidence_invalid",
      `Workload did not prove an isolated, removed, digest-pinned candidate container: ${infrastructureIssues.join("; ")}`,
    );
  }
  const resultHash = remoteSandboxResultHash(input.result);
  const candidateBundleVerification = verifyExactSandboxCandidateBundle(
    input.bundle,
    input.completedAt,
  );
  const body = {
    schema: "agent-factory-sandbox-execution/v2" as const,
    executionOrigin: "remote" as const,
    // Never let a submitted bundle self-assert the strength of the machine
    // that executed it. Deployment-owned runner identity is the source.
    isolationTier: input.identity.actualIsolationTier,
    candidateFingerprint: input.bundle.candidateFingerprint,
    targetDomainId: input.bundle.targetDomainId,
    targetTenantId: input.bundle.targetTenant.id,
    targetTenantSlug: input.bundle.targetTenant.slug,
    sandboxAttemptId: input.bundle.attemptId,
    bundleHash: input.bundle.bundleHash,
    resultHash,
    runnerId: input.identity.runnerId,
    runnerBuildId: input.identity.runnerBuildId,
    runtimeImageDigest: input.identity.runtimeImageDigest,
    ...(input.identity.platformAttestation
      ? { platformAttestation: input.identity.platformAttestation }
      : {}),
    candidateBundleVerification,
    brokerOriginHash: `sha256:${canonicalSandboxSha256(input.identity.brokerOrigin)}`,
    serveOriginHash: `sha256:${canonicalSandboxSha256(input.identity.serveOrigin)}`,
    policyHash: `sandbox-policy:v1:${canonicalSandboxSha256(input.bundle.policy)}`,
    networkPolicy: "deny_public_egress" as const,
    externalLiveCalls: 0 as const,
    modelUsageHash: input.result.modelUsage!.evidenceHash,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    infrastructureCleanup: input.infrastructureCleanup,
    signatureAlgorithm: "hmac-sha256" as const,
  };
  const attestationHash = sandboxExecutionReceiptHash({
    ...body,
    attestationHash: "",
    signature: "",
  } as SandboxExecutionPlaneReceipt);
  return signSandboxExecutionPlaneReceipt(
    { ...body, attestationHash },
    input.identity.receiptSigningKey,
  );
}
