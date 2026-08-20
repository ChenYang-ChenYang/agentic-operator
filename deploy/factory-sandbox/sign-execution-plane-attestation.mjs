#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SCHEMA = "agent-factory-sandbox-execution-plane-attestation/v1";
const CAPABILITIES = {
  protocolVersion: "agent-factory-sandbox-remote/v1",
  candidateBundleSchemas: ["agent-factory-sandbox-candidate-bundle/v2"],
  executionReceiptSchemas: ["agent-factory-sandbox-execution/v2"],
  promotionReceiptClasses: [
    "registration",
    "execution",
    "test",
    "run_drain",
    "cleanup",
  ],
  contentAddressedBundleVerification: true,
  independentBrokerReadback: true,
  candidateContainerAbsenceProof: true,
  denyPublicEgress: true,
};
const IDENTITY_HASH = /^sha256:[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;

function canonical(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fail(message) {
  throw new Error(message);
}

export function identityHash(purpose, rawIdentity) {
  const text = String(rawIdentity ?? "").trim();
  if (!SAFE_ID.test(purpose) || !text || text.length > 4_096) {
    fail("identity purpose/raw value is missing or malformed");
  }
  return `sha256:${createHash("sha256")
    .update(`agentic-sandbox-identity/v1\0${purpose}\0${text}`, "utf8")
    .digest("hex")}`;
}

export function signExecutionPlaneAttestation(input, privateKeyPem) {
  for (const field of [
    "planeId",
    "trustDomain",
    "runnerId",
    "runnerBuildId",
    "attestorKeyId",
  ]) {
    if (!SAFE_ID.test(input[field] ?? "")) fail(`${field} is invalid`);
  }
  if (!OCI_DIGEST.test(input.runtimeImageDigest ?? "")) {
    fail("runtimeImageDigest must be a canonical OCI sha256 digest");
  }
  for (const field of [
    "controlHostIdentityHash",
    "workloadHostIdentityHash",
    "dockerDaemonIdentityHash",
  ]) {
    if (!IDENTITY_HASH.test(input[field] ?? "")) fail(`${field} is invalid`);
  }
  if (!["remote_container", "remote_vm"].includes(input.isolationTier)) {
    fail("isolationTier must be remote_container or remote_vm");
  }
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 90 * 24 * 60 * 60_000
  ) {
    fail("attestation validity must be positive and no longer than 90 days");
  }
  const body = {
    schema: SCHEMA,
    planeId: input.planeId,
    trustDomain: input.trustDomain,
    runnerId: input.runnerId,
    runnerBuildId: input.runnerBuildId,
    runtimeImageDigest: input.runtimeImageDigest,
    isolationTier: input.isolationTier,
    controlHostIdentityHash: input.controlHostIdentityHash,
    workloadHostIdentityHash: input.workloadHostIdentityHash,
    dockerDaemonIdentityHash: input.dockerDaemonIdentityHash,
    capabilities: CAPABILITIES,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    attestorKeyId: input.attestorKeyId,
    signatureAlgorithm: "ed25519",
  };
  const attestationHash =
    `sandbox-execution-plane:v1:${createHash("sha256")
      .update(canonical(body), "utf8")
      .digest("hex")}`;
  const unsigned = { ...body, attestationHash };
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail("platform attestor private key must be Ed25519");
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonical(unsigned), "utf8"),
      privateKey,
    ).toString("base64url"),
  };
}

function main() {
  const inputFile = argument("--input");
  const privateKeyFile = argument("--private-key");
  const outputFile = argument("--output");
  const publicKeyFile = argument("--public-key-output");
  if (
    !inputFile
    || !privateKeyFile
    || !outputFile
    || !publicKeyFile
    || ![inputFile, privateKeyFile, outputFile, publicKeyFile]
      .every(path.isAbsolute)
  ) {
    fail(
      "usage: sign-execution-plane-attestation.mjs --input /abs/unsigned.json --private-key /abs/ed25519-private.pem --output /abs/execution-plane.json --public-key-output /abs/platform-attestor-public.pem",
    );
  }
  const input = JSON.parse(readFileSync(inputFile, "utf8"));
  const privateKeyPem = readFileSync(privateKeyFile, "utf8");
  const attestation = signExecutionPlaneAttestation(input, privateKeyPem);
  const publicKey = createPublicKey(privateKeyPem).export({
    type: "spki",
    format: "pem",
  });
  writeFileSync(outputFile, `${JSON.stringify(attestation, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
  writeFileSync(publicKeyFile, publicKey, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
  chmodSync(outputFile, 0o644);
  chmodSync(publicKeyFile, 0o644);
  process.stdout.write(
    `signed execution-plane attestation ${attestation.attestationHash}; private key was not copied\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
