import {
  createHash,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

import { canonicalEvidenceJson } from "./evidence-fingerprint";

export const SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA =
  "agent-factory-sandbox-execution-plane-attestation/v1" as const;

export const SANDBOX_REMOTE_PROTOCOL_VERSION =
  "agent-factory-sandbox-remote/v1" as const;

export const SANDBOX_PROMOTION_RECEIPT_CLASSES = [
  "registration",
  "execution",
  "test",
  "run_drain",
  "cleanup",
] as const;

const IDENTITY_HASH = /^sha256:[a-f0-9]{64}$/;
const OCI_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{80,120}$/;

export interface SandboxExecutionPlaneCapabilities {
  protocolVersion: typeof SANDBOX_REMOTE_PROTOCOL_VERSION;
  candidateBundleSchemas: readonly [
    "agent-factory-sandbox-candidate-bundle/v2",
  ];
  executionReceiptSchemas: readonly [
    "agent-factory-sandbox-execution/v2",
  ];
  promotionReceiptClasses: typeof SANDBOX_PROMOTION_RECEIPT_CLASSES;
  contentAddressedBundleVerification: true;
  independentBrokerReadback: true;
  candidateContainerAbsenceProof: true;
  denyPublicEgress: true;
}

export interface SandboxExecutionPlaneAttestation {
  schema: typeof SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA;
  planeId: string;
  trustDomain: string;
  runnerId: string;
  runnerBuildId: string;
  runtimeImageDigest: string;
  isolationTier: "remote_container" | "remote_vm";
  /** Domain-separated hashes only. Raw machine/container-runtime identities
   * must never enter a runner health response or persisted execution receipt. */
  controlHostIdentityHash: string;
  workloadHostIdentityHash: string;
  dockerDaemonIdentityHash: string;
  capabilities: SandboxExecutionPlaneCapabilities;
  issuedAt: string;
  expiresAt: string;
  attestorKeyId: string;
  signatureAlgorithm: "ed25519";
  attestationHash: string;
  signature: string;
}

export interface SandboxExecutionPlaneAttestationExpected {
  planeId: string;
  trustDomain: string;
  runnerId: string;
  allowedRunnerBuildIds: ReadonlySet<string>;
  allowedRuntimeImageDigests: ReadonlySet<string>;
  allowedControlHostIdentityHashes: ReadonlySet<string>;
  allowedWorkloadHostIdentityHashes: ReadonlySet<string>;
  allowedDockerDaemonIdentityHashes: ReadonlySet<string>;
  primaryHostIdentityHash: string;
  primaryDockerDaemonIdentityHash: string;
  attestorKeyId: string;
  attestorPublicKey: string;
  now?: Date;
  clockSkewMs?: number;
}

export function sandboxExecutionPlaneCapabilities():
  SandboxExecutionPlaneCapabilities {
  return {
    protocolVersion: SANDBOX_REMOTE_PROTOCOL_VERSION,
    candidateBundleSchemas: [
      "agent-factory-sandbox-candidate-bundle/v2",
    ],
    executionReceiptSchemas: [
      "agent-factory-sandbox-execution/v2",
    ],
    promotionReceiptClasses: SANDBOX_PROMOTION_RECEIPT_CLASSES,
    contentAddressedBundleVerification: true,
    independentBrokerReadback: true,
    candidateContainerAbsenceProof: true,
    denyPublicEgress: true,
  };
}

function unsignedAttestation(
  attestation: SandboxExecutionPlaneAttestation,
): Omit<
  SandboxExecutionPlaneAttestation,
  "attestationHash" | "signature"
> {
  const {
    attestationHash: _attestationHash,
    signature: _signature,
    ...unsigned
  } = attestation;
  return unsigned;
}

function attestationSignatureInput(
  attestation: Omit<SandboxExecutionPlaneAttestation, "signature">,
): Buffer {
  return Buffer.from(canonicalEvidenceJson(attestation), "utf8");
}

export function sandboxExecutionPlaneAttestationHash(
  attestation:
    | SandboxExecutionPlaneAttestation
    | Omit<
        SandboxExecutionPlaneAttestation,
        "attestationHash" | "signature"
      >,
): string {
  const {
    attestationHash: _attestationHash,
    signature: _signature,
    ...unsigned
  } = attestation as SandboxExecutionPlaneAttestation;
  return `sandbox-execution-plane:v1:${createHash("sha256")
    .update(canonicalEvidenceJson(unsigned), "utf8")
    .digest("hex")}`;
}

/** Intended for an offline deployment attestor. The private key must never be
 * mounted into the sandbox runner or primary API. */
export function signSandboxExecutionPlaneAttestation(
  body: Omit<
    SandboxExecutionPlaneAttestation,
    "attestationHash" | "signature"
  >,
  privateKey: string,
): SandboxExecutionPlaneAttestation {
  const attestationHash = sandboxExecutionPlaneAttestationHash(body);
  const unsigned = { ...body, attestationHash };
  return {
    ...unsigned,
    signature: signBytes(
      null,
      attestationSignatureInput(unsigned),
      privateKey,
    ).toString("base64url"),
  };
}

export function sandboxExecutionPlaneAttestationIssues(
  attestation: SandboxExecutionPlaneAttestation | null | undefined,
  expected?: SandboxExecutionPlaneAttestationExpected,
): string[] {
  if (!attestation) {
    return ["missing independently signed execution-plane attestation"];
  }
  const issues: string[] = [];
  if (attestation.schema !== SANDBOX_EXECUTION_PLANE_ATTESTATION_SCHEMA) {
    issues.push("unsupported execution-plane attestation schema");
  }
  for (const [label, value] of [
    ["plane id", attestation.planeId],
    ["trust domain", attestation.trustDomain],
    ["runner id", attestation.runnerId],
    ["runner build id", attestation.runnerBuildId],
    ["attestor key id", attestation.attestorKeyId],
  ] as const) {
    if (!SAFE_ID.test(value ?? "")) issues.push(`invalid ${label}`);
  }
  if (!OCI_SHA256_DIGEST.test(attestation.runtimeImageDigest ?? "")) {
    issues.push("execution-plane runtime image digest is invalid");
  }
  for (const [label, value] of [
    ["control host identity", attestation.controlHostIdentityHash],
    ["workload host identity", attestation.workloadHostIdentityHash],
    ["Docker daemon identity", attestation.dockerDaemonIdentityHash],
  ] as const) {
    if (!IDENTITY_HASH.test(value ?? "")) issues.push(`invalid ${label} hash`);
  }
  if (
    attestation.isolationTier !== "remote_container"
    && attestation.isolationTier !== "remote_vm"
  ) {
    issues.push("execution-plane attestation is not remotely isolated");
  }
  if (
    canonicalEvidenceJson(attestation.capabilities)
    !== canonicalEvidenceJson(sandboxExecutionPlaneCapabilities())
  ) {
    issues.push("execution-plane capabilities are incomplete or unsupported");
  }
  const issuedAt = Date.parse(attestation.issuedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt
  ) {
    issues.push("execution-plane attestation validity window is invalid");
  }
  if (
    attestation.signatureAlgorithm !== "ed25519"
    || !ED25519_SIGNATURE.test(attestation.signature ?? "")
  ) {
    issues.push("execution-plane attestation signature is missing or unsupported");
  }
  if (
    attestation.attestationHash
    !== sandboxExecutionPlaneAttestationHash(attestation)
  ) {
    issues.push("execution-plane attestation hash mismatch");
  }

  if (expected) {
    const now = (expected.now ?? new Date()).getTime();
    const skew = expected.clockSkewMs ?? 5_000;
    if (issuedAt > now + skew || expiresAt < now - skew) {
      issues.push("execution-plane attestation is not currently valid");
    }
    if (attestation.planeId !== expected.planeId) {
      issues.push("execution-plane id mismatch");
    }
    if (attestation.trustDomain !== expected.trustDomain) {
      issues.push("execution-plane trust domain mismatch");
    }
    if (attestation.runnerId !== expected.runnerId) {
      issues.push("execution-plane runner id mismatch");
    }
    if (!expected.allowedRunnerBuildIds.has(attestation.runnerBuildId)) {
      issues.push("execution-plane runner build is not allowlisted");
    }
    if (
      !expected.allowedRuntimeImageDigests.has(
        attestation.runtimeImageDigest,
      )
    ) {
      issues.push("execution-plane runtime image is not allowlisted");
    }
    if (
      !expected.allowedControlHostIdentityHashes.has(
        attestation.controlHostIdentityHash,
      )
    ) {
      issues.push("execution-plane control host is not allowlisted");
    }
    if (
      !expected.allowedWorkloadHostIdentityHashes.has(
        attestation.workloadHostIdentityHash,
      )
    ) {
      issues.push("execution-plane workload host is not allowlisted");
    }
    if (
      !expected.allowedDockerDaemonIdentityHashes.has(
        attestation.dockerDaemonIdentityHash,
      )
    ) {
      issues.push("execution-plane Docker daemon is not allowlisted");
    }
    if (
      !IDENTITY_HASH.test(expected.primaryHostIdentityHash)
      || !IDENTITY_HASH.test(expected.primaryDockerDaemonIdentityHash)
    ) {
      issues.push("primary host or Docker daemon comparison identity is missing");
    } else {
      if (
        attestation.controlHostIdentityHash
          === expected.primaryHostIdentityHash
        || attestation.workloadHostIdentityHash
          === expected.primaryHostIdentityHash
      ) {
        issues.push("execution plane shares the primary host identity");
      }
      if (
        attestation.dockerDaemonIdentityHash
        === expected.primaryDockerDaemonIdentityHash
      ) {
        issues.push("execution plane shares the primary Docker daemon identity");
      }
    }
    if (attestation.attestorKeyId !== expected.attestorKeyId) {
      issues.push("execution-plane attestor key id mismatch");
    } else if (
      attestation.signatureAlgorithm === "ed25519"
      && ED25519_SIGNATURE.test(attestation.signature ?? "")
    ) {
      try {
        const verified = verifyBytes(
          null,
          attestationSignatureInput({
            ...unsignedAttestation(attestation),
            attestationHash: attestation.attestationHash,
          }),
          expected.attestorPublicKey,
          Buffer.from(attestation.signature, "base64url"),
        );
        if (!verified) {
          issues.push("execution-plane attestor signature mismatch");
        }
      } catch {
        issues.push("execution-plane attestor public key is invalid");
      }
    }
  }

  return [...new Set(issues)];
}
