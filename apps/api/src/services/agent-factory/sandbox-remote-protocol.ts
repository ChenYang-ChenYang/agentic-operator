import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  canonicalEvidenceJson,
  SANDBOX_CANDIDATE_BUNDLE_VERIFICATION_SCHEMA,
  sandboxCandidateBundleVerificationEvidenceHash,
  sandboxExecutionReceiptHash,
  sandboxExecutionReceiptIssues,
  sandboxExecutionPlaneAttestationIssues,
  type SandboxCandidateBundleVerificationEvidence,
  type SandboxExecutionPlaneReceipt,
  type SandboxExecutionPlaneAttestationExpected,
} from "@agentic/agent-factory";

export const REMOTE_SANDBOX_ENVELOPE_SCHEMA =
  "agent-factory-sandbox-remote-envelope/v1" as const;
export const REMOTE_SANDBOX_RESULT_SCHEMA =
  "agent-factory-sandbox-remote-result/v1" as const;
export const REMOTE_SANDBOX_RUNNER_HEALTH_SCHEMA =
  "agent-factory-sandbox-runner-health/v1" as const;
/** Protocol bound on a single candidate execution. Lives HERE (zero-dependency protocol module)
 * rather than in sandbox-bundle-builder so the control runner's STATIC import closure stays the
 * narrow curated set the sandbox-control image copies — importing the bundle builder for this one
 * number dragged the whole deployer/llm/secret graph into the control image contract. */
export const MAX_SANDBOX_CANDIDATE_RUN_MS = 15 * 60_000;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_CANONICAL_DEPTH = 64;
const SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const AUTHORIZATION_VALUE = /\b(?:Bearer|Basic)\s+([^\s,"]+)/gi;
const QUOTED_CREDENTIAL_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|cookie|credential|private[_-]?key)\b\s*(?::|=)\s*(["'`])([^"'`\r\n]+)\2/gi;
const PRIVATE_KEY_LITERAL = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const ENV_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_NAME = /(?:api[_-]?key|token|secret|password|credential|private[_-]?key|signing[_-]?key|session)/i;
const COMMON_SECRET_LITERALS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
] as const;

export type RemoteSandboxMessagePurpose =
  | "submit"
  | "status"
  | "cancel"
  | "result";

export interface SignedRemoteSandboxMessage<T> {
  schema: typeof REMOTE_SANDBOX_ENVELOPE_SCHEMA;
  purpose: RemoteSandboxMessagePurpose;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadHash: string;
  signatureAlgorithm: "hmac-sha256";
  payload: T;
  signature: string;
}

export interface RemoteSandboxSubmitCommand<TBundle = unknown> {
  schema: "agent-factory-sandbox-submit/v1";
  attemptId: string;
  bundleHash: string;
  bundle: TBundle;
}

export interface RemoteSandboxAttemptCommand {
  schema:
    | "agent-factory-sandbox-status/v1"
    | "agent-factory-sandbox-cancel/v1";
  attemptId: string;
  bundleHash: string;
  reason?: string;
}

export interface RemoteSandboxJobResult<TResult = unknown> {
  schema: typeof REMOTE_SANDBOX_RESULT_SCHEMA;
  attemptId: string;
  bundleHash: string;
  status:
    | "accepted"
    | "running"
    | "cleanup_pending"
    | "completed"
    | "failed"
    | "cancelled";
  result?: TResult;
  error?: {
    code: string;
    message: string;
  };
}

export class RemoteSandboxProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteSandboxProtocolError";
  }
}

function plainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The wire protocol deliberately accepts JSON values only.  In particular,
 * canonicalization must not silently turn BigInt, Date, class instances or
 * `undefined` into a different value than the runner receives.
 */
export function assertRemoteSandboxJson(
  value: unknown,
  rootPath = "payload",
): void {
  const active = new WeakSet<object>();
  const visit = (entry: unknown, path: string, depth: number): void => {
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new RemoteSandboxProtocolError(
        "payload_too_deep",
        `${path} exceeds the remote sandbox JSON depth limit`,
      );
    }
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new RemoteSandboxProtocolError(
          "payload_not_json",
          `${path} contains a non-finite number`,
        );
      }
      return;
    }
    if (typeof entry !== "object") {
      throw new RemoteSandboxProtocolError(
        "payload_not_json",
        `${path} contains a non-JSON ${typeof entry}`,
      );
    }
    if (active.has(entry)) {
      throw new RemoteSandboxProtocolError(
        "payload_not_json",
        `${path} contains a circular reference`,
      );
    }
    active.add(entry);
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
    } else {
      if (!plainObject(entry)) {
        throw new RemoteSandboxProtocolError(
          "payload_not_json",
          `${path} contains a non-plain object`,
        );
      }
      for (const [key, child] of Object.entries(entry)) {
        visit(child, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(entry);
  };
  visit(value, rootPath, 0);
}

function secretReferenceIsSafe(value: unknown, allowBareEnv = false): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  return (
    text === "[REDACTED]" ||
    (allowBareEnv && ENV_REF.test(text)) ||
    /^\{(?:env\.)?[A-Za-z_][A-Za-z0-9_]*\}$/.test(text) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text) ||
    /^secret-ref:[A-Za-z0-9_.:/-]+$/.test(text)
  );
}

function credentialFieldValueIsSafe(value: unknown, key: string): boolean {
  if (secretReferenceIsSafe(value, /(?:^|[_-])env(?:[_-]ref)?$/i.test(key))) return true;
  if (typeof value !== "string" || !/authorization/i.test(key)) return false;
  const match = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value.trim());
  return Boolean(match?.[1] && secretReferenceIsSafe(match[1]));
}

function configuredSecretValues(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...new Set(Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string")
    .map(([, value]) => value!.trim())
    // Very short operational values (for example AUTH_MODE=production) are
    // neither credentials nor useful DLP anchors and create false positives.
    .filter((value) => value.length >= 12))]
    .sort((left, right) => right.length - left.length);
}

function containsKnownSecretLiteral(value: string, configured: readonly string[]): boolean {
  if (COMMON_SECRET_LITERALS.some((pattern) => pattern.test(value))) return true;
  return configured.some((secret) => value.includes(secret));
}

function containsLiteralAuthorization(value: string): boolean {
  AUTHORIZATION_VALUE.lastIndex = 0;
  for (const match of value.matchAll(AUTHORIZATION_VALUE)) {
    const token = match[1] ?? "";
    if (!secretReferenceIsSafe(token)) return true;
  }
  return false;
}

function containsLiteralCredentialAssignment(value: string): boolean {
  QUOTED_CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (const match of value.matchAll(QUOTED_CREDENTIAL_ASSIGNMENT)) {
    const key = match[1] ?? "";
    const assigned = match[3] ?? "";
    if (!credentialFieldValueIsSafe(assigned, key)) return true;
  }
  return false;
}

/** Return the first literal credential path.  Secret *references* are valid;
 * resolved credential values are never valid bundle content. */
export function findRemoteSandboxSensitiveValue(
  value: unknown,
  rootPath = "payload",
): string | undefined {
  const configuredSecrets = configuredSecretValues();
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, path: string, parentKey: string, depth: number): string | undefined => {
    if (depth > MAX_CANONICAL_DEPTH) return `${path} is nested too deeply`;
    if (typeof entry === "string") {
      if (containsKnownSecretLiteral(entry, configuredSecrets)) {
        return `${path} contains a configured or recognized credential literal`;
      }
      if (containsLiteralAuthorization(entry)) return `${path} contains a literal authorization value`;
      if (containsLiteralCredentialAssignment(entry)) {
        return `${path} contains a literal credential assignment`;
      }
      if (PRIVATE_KEY_LITERAL.test(entry)) return `${path} contains a private key`;
      if (SENSITIVE_KEY.test(parentKey) && !credentialFieldValueIsSafe(entry, parentKey)) {
        return `${path} contains a literal credential`;
      }
      try {
        const url = new URL(entry);
        if (url.username || url.password) return `${path} contains URL credentials`;
        for (const key of url.searchParams.keys()) {
          if (SENSITIVE_KEY.test(key) && !credentialFieldValueIsSafe(url.searchParams.get(key), key)) {
            return `${path} contains a credential-bearing URL parameter`;
          }
        }
      } catch {
        // Ordinary strings are not URLs.
      }
      return undefined;
    }
    if (!entry || typeof entry !== "object") {
      if (SENSITIVE_KEY.test(parentKey) && !credentialFieldValueIsSafe(entry, parentKey)) {
        return `${path} contains a literal credential`;
      }
      return undefined;
    }
    if (seen.has(entry)) return `${path} contains a circular reference`;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        const found = visit(entry[index], `${path}[${index}]`, parentKey, depth + 1);
        if (found) return found;
      }
    } else {
      for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key) && !credentialFieldValueIsSafe(child, key)) {
          return `${path}.${key} contains a literal credential`;
        }
        const found = visit(child, `${path}.${key}`, key, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(value, rootPath, "", 0);
}

export function assertRemoteSandboxSecretFree(
  value: unknown,
  rootPath = "payload",
): void {
  const found = findRemoteSandboxSensitiveValue(value, rootPath);
  if (found) {
    throw new RemoteSandboxProtocolError(
      "literal_secret",
      `Remote sandbox payload rejected: ${found}`,
    );
  }
}

export function canonicalSandboxSha256(value: unknown): string {
  assertRemoteSandboxJson(value);
  return createHash("sha256")
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

function exactSecret(secret: string): string {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new RemoteSandboxProtocolError(
      "weak_signing_key",
      "Remote sandbox HMAC keys must contain at least 32 bytes",
    );
  }
  return secret;
}

function exactText(value: string, label: string, max = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new RemoteSandboxProtocolError(
      "invalid_envelope",
      `${label} must be a non-empty safe string`,
    );
  }
  return text;
}

function envelopeBody<T>(
  envelope: Omit<SignedRemoteSandboxMessage<T>, "signature">,
): Omit<SignedRemoteSandboxMessage<T>, "signature"> {
  return envelope;
}

function hmacBody(value: unknown, secret: string): string {
  return createHmac("sha256", exactSecret(secret))
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

function safeSignatureEqual(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Authenticate the runner's otherwise unauthenticated GET /health response.
 * The MAC intentionally covers the complete canonical body, including its
 * freshness and immutable runtime identities.
 */
export function signRemoteSandboxRunnerHealth(
  health: Record<string, unknown>,
  secret: string,
): Record<string, unknown> & {
  schema: typeof REMOTE_SANDBOX_RUNNER_HEALTH_SCHEMA;
  integrityMac: string;
} {
  const unsigned = {
    ...health,
    schema: REMOTE_SANDBOX_RUNNER_HEALTH_SCHEMA,
  };
  assertRemoteSandboxJson(unsigned);
  return {
    ...unsigned,
    integrityMac: hmacBody(unsigned, secret),
  };
}

/** Returns the authenticated body without its MAC, or null on any mismatch. */
export function verifyRemoteSandboxRunnerHealth(
  value: unknown,
  secret: string,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { integrityMac, ...unsigned } = value as Record<string, unknown>;
  if (
    unsigned.schema !== REMOTE_SANDBOX_RUNNER_HEALTH_SCHEMA
    || typeof integrityMac !== "string"
  ) return null;
  try {
    assertRemoteSandboxJson(unsigned);
    return safeSignatureEqual(integrityMac, hmacBody(unsigned, secret))
      ? unsigned
      : null;
  } catch {
    return null;
  }
}

export function signRemoteSandboxMessage<T>(args: {
  purpose: RemoteSandboxMessagePurpose;
  keyId: string;
  secret: string;
  payload: T;
  now?: Date;
  ttlMs?: number;
  nonce?: string;
}): SignedRemoteSandboxMessage<T> {
  assertRemoteSandboxJson(args.payload);
  assertRemoteSandboxSecretFree(args.payload);
  const now = args.now ?? new Date();
  const ttlMs = args.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) {
    throw new RemoteSandboxProtocolError(
      "invalid_ttl",
      "Remote sandbox envelope TTL must be between 1 second and 10 minutes",
    );
  }
  const unsigned: Omit<SignedRemoteSandboxMessage<T>, "signature"> = {
    schema: REMOTE_SANDBOX_ENVELOPE_SCHEMA,
    purpose: args.purpose,
    keyId: exactText(args.keyId, "keyId", 128),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    nonce: exactText(args.nonce ?? randomUUID(), "nonce", 128),
    payloadHash: `sha256:${canonicalSandboxSha256(args.payload)}`,
    signatureAlgorithm: "hmac-sha256",
    payload: args.payload,
  };
  return {
    ...unsigned,
    signature: hmacBody(envelopeBody(unsigned), args.secret),
  };
}

export function verifyRemoteSandboxMessage<T>(
  envelope: SignedRemoteSandboxMessage<T>,
  args: {
    expectedPurpose: RemoteSandboxMessagePurpose;
    expectedKeyId: string;
    secret: string;
    now?: Date;
    clockSkewMs?: number;
    maxTtlMs?: number;
    consumedNonces?: Set<string>;
  },
): T {
  assertRemoteSandboxJson(envelope, "envelope");
  if (
    envelope.schema !== REMOTE_SANDBOX_ENVELOPE_SCHEMA ||
    envelope.signatureAlgorithm !== "hmac-sha256" ||
    envelope.purpose !== args.expectedPurpose ||
    envelope.keyId !== args.expectedKeyId
  ) {
    throw new RemoteSandboxProtocolError(
      "envelope_identity_mismatch",
      "Remote sandbox envelope identity is invalid",
    );
  }
  exactText(envelope.nonce, "nonce", 128);
  const now = (args.now ?? new Date()).getTime();
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  const skew = args.clockSkewMs ?? 5_000;
  const maxTtl = args.maxTtlMs ?? 10 * 60_000;
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + skew ||
    expiresAt < now - skew ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maxTtl
  ) {
    throw new RemoteSandboxProtocolError(
      "envelope_expired",
      "Remote sandbox envelope is expired or has an invalid validity window",
    );
  }
  const payloadHash = `sha256:${canonicalSandboxSha256(envelope.payload)}`;
  if (payloadHash !== envelope.payloadHash) {
    throw new RemoteSandboxProtocolError(
      "payload_hash_mismatch",
      "Remote sandbox payload hash mismatch",
    );
  }
  const { signature, ...unsigned } = envelope;
  const expected = hmacBody(envelopeBody(unsigned), args.secret);
  if (!safeSignatureEqual(signature, expected)) {
    throw new RemoteSandboxProtocolError(
      "signature_mismatch",
      "Remote sandbox envelope signature mismatch",
    );
  }
  if (args.consumedNonces?.has(envelope.nonce)) {
    throw new RemoteSandboxProtocolError(
      "envelope_replayed",
      "Remote sandbox envelope nonce was already consumed",
    );
  }
  assertRemoteSandboxSecretFree(envelope.payload);
  args.consumedNonces?.add(envelope.nonce);
  return envelope.payload;
}

/** Hash exactly the runner result body, excluding the execution receipt that
 * contains this hash. */
export function remoteSandboxResultHash(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new RemoteSandboxProtocolError(
      "invalid_result",
      "Remote sandbox result must be an object",
    );
  }
  const { executionReceipt: _receipt, ...body } = result as Record<string, unknown>;
  return `sandbox-result:v1:${canonicalSandboxSha256(body)}`;
}

/** Control-signer readback of the exact transport-complete candidate bundle.
 * This intentionally lives in the narrow protocol module so the signer can
 * recompute identities without importing any deployment or tenant adapter. */
export function verifyExactSandboxCandidateBundle(
  value: unknown,
  verifiedAt: string,
): SandboxCandidateBundleVerificationEvidence {
  assertRemoteSandboxJson(value, "bundle");
  assertRemoteSandboxSecretFree(value, "bundle");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteSandboxProtocolError(
      "bundle_identity_mismatch",
      "Sandbox candidate bundle must be an object",
    );
  }
  const bundle = value as Record<string, unknown>;
  const {
    bundleHash: _bundleHash,
    ...body
  } = bundle;
  const expectedBundleHash =
    `sandbox-bundle:v2:${canonicalSandboxSha256(body)}`;
  const expectedSpecsFingerprint =
    `specs:v2:${canonicalSandboxSha256(bundle.specs)}`;
  const expectedManifestHash =
    `manifest:v1:${canonicalSandboxSha256(bundle.manifest)}`;
  if (
    bundle.schema !== "agent-factory-sandbox-candidate-bundle/v2"
    || bundle.bundleHash !== expectedBundleHash
    || bundle.specsFingerprint !== expectedSpecsFingerprint
    || bundle.manifestHash !== expectedManifestHash
    || typeof bundle.attemptId !== "string"
    || !bundle.attemptId.trim()
    || typeof bundle.candidateFingerprint !== "string"
    || !bundle.candidateFingerprint.trim()
    || !Array.isArray(bundle.testCases)
    || !Array.isArray(bundle.toolDefinitions)
    || !Array.isArray(bundle.toolEvidence)
    || Number.isNaN(Date.parse(verifiedAt))
  ) {
    throw new RemoteSandboxProtocolError(
      "bundle_identity_mismatch",
      "Sandbox candidate bundle did not pass exact content-addressed readback",
    );
  }
  const evidenceBody = {
    schema: SANDBOX_CANDIDATE_BUNDLE_VERIFICATION_SCHEMA,
    candidateBundleSchema:
      "agent-factory-sandbox-candidate-bundle/v2" as const,
    sandboxAttemptId: bundle.attemptId,
    candidateFingerprint: bundle.candidateFingerprint,
    bundleHash: expectedBundleHash,
    specsFingerprint: expectedSpecsFingerprint,
    manifestHash: expectedManifestHash,
    testSuiteHash:
      `test-suite:v1:${canonicalSandboxSha256(bundle.testCases)}`,
    toolSnapshotHash: `tool-snapshot:v1:${canonicalSandboxSha256({
      definitions: bundle.toolDefinitions,
      evidence: bundle.toolEvidence,
    })}`,
    verifiedAt,
  } satisfies Omit<
    SandboxCandidateBundleVerificationEvidence,
    "evidenceHash"
  >;
  return {
    ...evidenceBody,
    evidenceHash:
      sandboxCandidateBundleVerificationEvidenceHash(evidenceBody),
  };
}

function executionReceiptSignatureInput(
  receipt: SandboxExecutionPlaneReceipt,
): unknown {
  const { signature: _signature, ...body } = receipt;
  return body;
}

export function signSandboxExecutionPlaneReceipt(
  receipt: Omit<SandboxExecutionPlaneReceipt, "signature">,
  secret: string,
): SandboxExecutionPlaneReceipt {
  const complete = { ...receipt, signature: "" } as SandboxExecutionPlaneReceipt;
  if (receipt.attestationHash !== sandboxExecutionReceiptHash(complete)) {
    throw new RemoteSandboxProtocolError(
      "attestation_hash_mismatch",
      "Sandbox execution attestation hash is stale",
    );
  }
  return {
    ...receipt,
    signature: hmacBody(executionReceiptSignatureInput(complete), secret),
  };
}

export function verifySandboxExecutionPlaneReceipt(
  receipt: SandboxExecutionPlaneReceipt,
  args: {
    secret: string;
    expected: Parameters<typeof sandboxExecutionReceiptIssues>[1];
    expectedRunnerId: string;
    allowedRunnerBuildIds: ReadonlySet<string>;
    allowedRuntimeImageDigests: ReadonlySet<string>;
    platformAttestationExpected?: SandboxExecutionPlaneAttestationExpected;
    /** Permit signature/identity validation of a same-host diagnostic receipt.
     * This never changes the receipt's non-promotable semantics; callers must
     * explicitly downgrade the resulting run and promotion never sets it. */
    allowDiagnosticSameHost?: boolean;
    now?: Date;
    clockSkewMs?: number;
  },
): void {
  const diagnosticSameHost = (
    args.allowDiagnosticSameHost === true
    && receipt.isolationTier === "same_host_container"
  );
  const issues = sandboxExecutionReceiptIssues(receipt, args.expected).filter(
    (issue) => !(
      diagnosticSameHost
      && (
        issue === "sandbox isolation tier is not promotable"
        || issue
          === "sandbox execution-plane platform attestation is incomplete"
      )
    ),
  );
  if (issues.length) {
    throw new RemoteSandboxProtocolError(
      "execution_receipt_invalid",
      `Remote sandbox execution receipt is invalid: ${issues.join("; ")}`,
    );
  }
  // Same-host evidence may be authenticated for diagnostics, but it is
  // deliberately outside the independently attested remote-plane contract.
  // It remains non-promotable regardless of any embedded platform document.
  if (!diagnosticSameHost) {
    if (!args.platformAttestationExpected) {
      throw new RemoteSandboxProtocolError(
        "execution_plane_attestation_unconfigured",
        "Primary API has no allowlisted execution-plane attestor/host/daemon comparison",
      );
    } else {
      const platformIssues = sandboxExecutionPlaneAttestationIssues(
        receipt.platformAttestation,
        args.platformAttestationExpected,
      );
      if (platformIssues.length) {
        throw new RemoteSandboxProtocolError(
          "execution_plane_attestation_invalid",
          `Remote sandbox platform attestation is invalid: ${platformIssues.join("; ")}`,
        );
      }
    }
  }
  if (receipt.runnerId !== args.expectedRunnerId) {
    throw new RemoteSandboxProtocolError(
      "runner_identity_mismatch",
      "Remote sandbox runner identity mismatch",
    );
  }
  if (!args.allowedRunnerBuildIds.has(receipt.runnerBuildId)) {
    throw new RemoteSandboxProtocolError(
      "runner_build_untrusted",
      "Remote sandbox runner build is not allowlisted",
    );
  }
  if (!args.allowedRuntimeImageDigests.has(receipt.runtimeImageDigest)) {
    throw new RemoteSandboxProtocolError(
      "runtime_image_untrusted",
      "Remote sandbox workload image is not allowlisted",
    );
  }
  const now = (args.now ?? new Date()).getTime();
  const skew = args.clockSkewMs ?? 5_000;
  const completedAt = Date.parse(receipt.completedAt);
  const cleanupAt = Date.parse(receipt.infrastructureCleanup.verifiedAt);
  if (completedAt > now + skew || cleanupAt > now + skew || cleanupAt < completedAt) {
    throw new RemoteSandboxProtocolError(
      "execution_receipt_time_invalid",
      "Remote sandbox execution/cleanup timestamps are invalid",
    );
  }
  const expectedSignature = hmacBody(
    executionReceiptSignatureInput(receipt),
    args.secret,
  );
  if (!safeSignatureEqual(receipt.signature, expectedSignature)) {
    throw new RemoteSandboxProtocolError(
      "execution_receipt_signature_mismatch",
      "Remote sandbox execution receipt signature mismatch",
    );
  }
}
