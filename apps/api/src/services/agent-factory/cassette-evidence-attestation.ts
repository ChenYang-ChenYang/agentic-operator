import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type {
  FactoryExecutionScope,
  FactoryHumanAuthorizationReceipt,
} from "@agentic/agent-factory";
import {
  stableJson,
  redactCassetteValue,
  type CanonicalCassetteDocument,
  type CanonicalCassetteEntry,
  type CassetteEvidenceAttestation,
  type WriteProbeCassetteProof,
} from "@agentic/shared/cassette";
import { canonicalEvidenceJson } from "@agentic/shared";

import { verifyConsumedFactoryAuthorization } from "./authorization-challenge-store";

export type CassetteEvidenceMode = NonNullable<
  CanonicalCassetteDocument["evidence"]
>["mode"];

export interface CassetteEvidenceBindingInput {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  toolName: string;
  definitionHash: string;
  config: Record<string, unknown>;
  actor: string;
}

export interface ExpectedCassetteEvidenceBinding {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  toolName: string;
  definitionHash: string;
  configHash: string;
  allowedModes?: readonly CassetteEvidenceMode[];
}

export interface CassetteEvidenceSummary {
  mode: CassetteEvidenceMode;
  configHash: string;
  attestationKeyId: string;
  attestationExpiresAt: string;
  writeProbe?: {
    schema: WriteProbeCassetteProof["schema"];
    createCompleted: boolean;
    cleanupCompleted: boolean;
    absenceVerified: boolean;
    idempotencyKeyHash: string;
  };
}

interface SigningOptions {
  /** Focused tests may inject an isolated key. Production always omits it and
   * loads the API-owned key file. */
  key?: Buffer;
  now?: Date;
  dataRoot?: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_OR_FNV = /^(?:[a-f0-9]{64}|[a-f0-9]{8})$/;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TTL_MS = 90 * 24 * 60 * 60_000;
const MIN_KEY_BYTES = 32;

function requiredText(value: unknown, field: string, max = 1_000): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} is invalid`);
  return normalized;
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export function cassetteConfigHash(config: Record<string, unknown>): string {
  return sha256(stableJson(config));
}

function keyPath(dataRootOverride?: string): string {
  const configured = process.env.FACTORY_CASSETTE_ATTESTATION_KEY_FILE?.trim();
  if (configured) return path.resolve(configured);
  const dataRoot = dataRootOverride?.trim()
    || process.env.AGENTIC_DATA_ROOT?.trim()
    || "./data";
  return path.resolve(dataRoot, "factory-keys", "cassette-attestation.key");
}

function decodeKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[a-f0-9]+$/i.test(value) && value.length % 2 === 0
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new Error(`cassette attestation key must contain at least ${MIN_KEY_BYTES} bytes`);
  }
  return key;
}

/** Load or atomically create the API-owned persistent signing key.  The file,
 * not an environment literal, is the trust root so API restarts do not make
 * fresh evidence unverifiable. */
function persistentSigningKey(create: boolean, dataRoot?: string): Buffer {
  const target = keyPath(dataRoot);
  if (create) mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    if (!create) {
      throw new Error("cassette attestation trust root is unavailable");
    }
    const generated = randomBytes(32).toString("hex");
    let fd: number | undefined;
    try {
      fd = openSync(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(fd, `${generated}\n`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("cassette attestation key path must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    // A newly generated file is already 0600.  Repairing an owner-controlled
    // persistent volume is safe; a non-owner process will fail here.
    chmodSync(target, 0o600);
  }
  return decodeKey(readFileSync(target, "utf8"));
}

function signingKey(options: SigningOptions | undefined, create: boolean): Buffer {
  const key = options?.key ?? persistentSigningKey(create, options?.dataRoot);
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new Error(`cassette attestation key must contain at least ${MIN_KEY_BYTES} bytes`);
  }
  return key;
}

function withoutAttestation(
  document: CanonicalCassetteDocument,
): CanonicalCassetteDocument {
  if (!document.evidence) return document;
  const { attestation: _attestation, ...evidence } = document.evidence;
  return { ...document, evidence };
}

function signaturePayload(
  document: CanonicalCassetteDocument,
  unsigned: Omit<CassetteEvidenceAttestation, "signature">,
): string {
  return stableJson({
    purpose: "agent-factory-cassette-evidence/v1",
    cassette: withoutAttestation(document),
    attestation: unsigned,
  });
}

function signatureFor(
  document: CanonicalCassetteDocument,
  unsigned: Omit<CassetteEvidenceAttestation, "signature">,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(signaturePayload(document, unsigned), "utf8")
    .digest("hex");
}

function keyId(key: Buffer): string {
  return `cassette-hmac-${sha256(key).slice(0, 16)}`;
}

function validEntry(entry: CanonicalCassetteEntry, toolName: string): boolean {
  return Boolean(entry)
    && /^[a-f0-9]{8}$/i.test(entry.key)
    && entry.request?.kind === "tool"
    && entry.request.toolName === toolName
    && /^[a-f0-9]{8}$/i.test(entry.request.argsHash)
    && Number.isInteger(entry.response?.status)
    && entry.response.status >= 100
    && entry.response.status <= 599
    && Object.prototype.hasOwnProperty.call(entry.response, "body");
}

function validateUnsignedDocument(
  document: CanonicalCassetteDocument,
  binding: CassetteEvidenceBindingInput,
): void {
  if (document.version !== 1 || !document.evidence) {
    throw new Error("cassette evidence contract is invalid");
  }
  const toolName = requiredText(binding.toolName, "toolName", 300);
  const definitionHash = requiredText(binding.definitionHash, "definitionHash", 64).toLowerCase();
  if (!SHA256.test(definitionHash)) throw new Error("cassette definitionHash is invalid");
  if (
    document.tool?.name !== toolName
    || document.tool.definitionHash.toLowerCase() !== definitionHash
  ) {
    throw new Error("cassette tool/definition does not match its signing scope");
  }
  if (!document.entries.length || !document.entries.every((entry) => validEntry(entry, toolName))) {
    throw new Error("cassette entries do not satisfy the canonical tool exchange schema");
  }
  if (!Number.isFinite(Date.parse(document.evidence.recordedAt))) {
    throw new Error("cassette recordedAt is invalid");
  }
}

function attestCassette(
  document: CanonicalCassetteDocument,
  binding: CassetteEvidenceBindingInput,
  expiresAt: string,
  options?: SigningOptions,
): CanonicalCassetteDocument {
  validateUnsignedDocument(document, binding);
  const now = options?.now ?? new Date();
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > MAX_TTL_MS) {
    throw new Error("cassette evidence expiry must be in the future and no more than 90 days");
  }
  const mode = document.evidence!.mode;
  const actor = requiredText(binding.actor, "actor", 300);
  // Sign the exact JSON value that can be persisted and transported. In-memory
  // TypeScript objects may contain `undefined` optional fields; signing those
  // before JSON serialization would create evidence that immediately fails
  // verification after a normal write/read round trip.
  const transportDocument = JSON.parse(
    canonicalEvidenceJson(withoutAttestation(document)),
  ) as CanonicalCassetteDocument;
  const normalized: CanonicalCassetteDocument = {
    ...transportDocument,
    evidence: {
      ...transportDocument.evidence!,
      recordedBy: actor,
    },
  };
  const key = signingKey(options, true);
  const unsigned: Omit<CassetteEvidenceAttestation, "signature"> = {
    schema: "agent-factory-cassette-attestation/v1",
    algorithm: "hmac-sha256",
    keyId: keyId(key),
    issuedAt: now.toISOString(),
    expiresAt: new Date(expiry).toISOString(),
    binding: {
      tenantId: requiredText(binding.tenantId, "tenantId", 300),
      tenantSlug: requiredText(binding.tenantSlug, "tenantSlug", 300),
      domainId: requiredText(binding.domainId, "domainId", 500),
      toolName: requiredText(binding.toolName, "toolName", 300),
      definitionHash: requiredText(binding.definitionHash, "definitionHash", 64).toLowerCase(),
      configHash: cassetteConfigHash(binding.config),
      actor,
      mode,
    },
  };
  const attestation: CassetteEvidenceAttestation = {
    ...unsigned,
    signature: signatureFor(normalized, unsigned, key),
  };
  return {
    ...normalized,
    evidence: { ...normalized.evidence!, attestation },
  };
}

function defaultExpiry(now = new Date()): string {
  const raw = process.env.FACTORY_CASSETTE_ATTESTATION_TTL_MS?.trim();
  const ttl = raw === undefined ? DEFAULT_TTL_MS : Number(raw);
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > MAX_TTL_MS) {
    throw new Error("FACTORY_CASSETTE_ATTESTATION_TTL_MS must be between 60000 and 7776000000");
  }
  return new Date(now.getTime() + ttl).toISOString();
}

/** Trusted API path used immediately after a real probe returns. */
export function attestLiveProbeCassette(
  document: CanonicalCassetteDocument,
  binding: CassetteEvidenceBindingInput,
  options?: SigningOptions,
): CanonicalCassetteDocument {
  if (document.evidence?.mode !== "live-probe") {
    throw new Error("live-probe attestation cannot sign another evidence mode");
  }
  const now = options?.now ?? new Date();
  return attestCassette(document, binding, defaultExpiry(now), { ...options, now });
}

export interface AuthorizedSignedFixtureInput {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  toolName: string;
  definitionHash: string;
  schemaHash?: string;
  config: Record<string, unknown>;
  entries: CanonicalCassetteEntry[];
  recordedAt: string;
  expiresAt: string;
  authorization: FactoryHumanAuthorizationReceipt;
  execution: FactoryExecutionScope;
}

function sanitizedFixtureEntries(
  entries: CanonicalCassetteEntry[],
): CanonicalCassetteEntry[] {
  return entries.map((entry) => ({
    ...entry,
    response: {
      ...entry.response,
      body: redactCassetteValue(entry.response.body),
      ...(entry.response.headers
        ? { headers: redactCassetteValue(entry.response.headers) as Record<string, string> }
        : {}),
    },
  }));
}

/** Stable subject shown at the future fixture-creation HITL gate.  The human
 * authorizes the exact entries and expiry, not a generic permission to mint
 * fixtures later. */
export function signedFixtureAuthorizationSubject(
  input: Omit<AuthorizedSignedFixtureInput, "authorization" | "execution">,
): string {
  return sha256(stableJson({
    protocol: "agent-factory-signed-fixture-authorization/v1",
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domainId: input.domainId,
    toolName: input.toolName,
    definitionHash: input.definitionHash,
    schemaHash: input.schemaHash ?? null,
    configHash: cassetteConfigHash(input.config),
    entries: sanitizedFixtureEntries(input.entries),
    recordedAt: input.recordedAt,
    expiresAt: input.expiresAt,
  }));
}

/** Build a signed fixture only from a consumed, authenticated one-shot human
 * probe authorization.  Merely passing an actor string is intentionally not a
 * signing API.  A route/Brain tool may call this after it implements the
 * matching challenge UI. */
export function createAuthorizedSignedFixtureCassette(
  input: AuthorizedSignedFixtureInput,
  options?: SigningOptions,
): CanonicalCassetteDocument {
  if (
    input.authorization.runId !== input.execution.runId
    || input.authorization.conversationId !== input.execution.conversationId
  ) {
    throw new Error("signed fixture authorization does not belong to the current execution");
  }
  const subjectDigest = signedFixtureAuthorizationSubject(input);
  if (!verifyConsumedFactoryAuthorization({
    tenantId: input.tenantId,
    domain: input.domainId,
    receipt: input.authorization,
    kind: "probe",
    subjectDigest,
  })) {
    throw new Error("signed fixture requires an exact consumed human authorization receipt");
  }
  const document: CanonicalCassetteDocument = {
    version: 1,
    tool: {
      name: input.toolName,
      definitionHash: input.definitionHash,
      ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
    },
    evidence: {
      recordedAt: input.recordedAt,
      recordedBy: input.authorization.actor,
      mode: "signed-fixture",
    },
    entries: sanitizedFixtureEntries(input.entries),
  };
  return attestCassette(document, {
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domainId: input.domainId,
    toolName: input.toolName,
    definitionHash: input.definitionHash,
    config: input.config,
    actor: input.authorization.actor,
  }, input.expiresAt, options);
}

/** Build one independently replayable cassette that belongs to an exact
 * server-derived sandbox evidence plan. The plan receipt is verified once per
 * cassette so a caller cannot append an unreviewed tool after confirmation. */
export function createAuthorizedSandboxEvidencePlanCassette(
  input: AuthorizedSignedFixtureInput & { planSubjectDigest: string },
  options?: SigningOptions,
): CanonicalCassetteDocument {
  if (
    input.authorization.runId !== input.execution.runId
    || input.authorization.conversationId !== input.execution.conversationId
  ) {
    throw new Error("sandbox evidence plan authorization does not belong to the current execution");
  }
  if (!verifyConsumedFactoryAuthorization({
    tenantId: input.tenantId,
    domain: input.domainId,
    receipt: input.authorization,
    kind: "sandbox_evidence_plan",
    subjectDigest: input.planSubjectDigest,
  })) {
    throw new Error("sandbox evidence plan requires an exact consumed human authorization receipt");
  }
  const document: CanonicalCassetteDocument = {
    version: 1,
    tool: {
      name: input.toolName,
      definitionHash: input.definitionHash,
      ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
    },
    evidence: {
      recordedAt: input.recordedAt,
      recordedBy: input.authorization.actor,
      mode: "signed-fixture",
      authorization: {
        kind: "sandbox_evidence_plan",
        subjectDigest: input.planSubjectDigest,
        challengeId: input.authorization.challengeId,
      },
    } as NonNullable<CanonicalCassetteDocument["evidence"]> & {
      authorization: {
        kind: "sandbox_evidence_plan";
        subjectDigest: string;
        challengeId: string;
      };
    },
    entries: sanitizedFixtureEntries(input.entries),
  };
  return attestCassette(document, {
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domainId: input.domainId,
    toolName: input.toolName,
    definitionHash: input.definitionHash,
    config: input.config,
    actor: input.authorization.actor,
  }, input.expiresAt, options);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function verifyCassetteEvidenceAttestation(
  document: CanonicalCassetteDocument,
  expected: ExpectedCassetteEvidenceBinding,
  options?: SigningOptions & { trust?: "api-attestation" | "verified-regression-export" },
): { valid: boolean; issues: string[]; summary?: CassetteEvidenceSummary } {
  const issues: string[] = [];
  const attestation = document.evidence?.attestation;
  if (!attestation) return { valid: false, issues: ["cassette evidence attestation is missing"] };
  if (
    attestation.schema !== "agent-factory-cassette-attestation/v1"
    || attestation.algorithm !== "hmac-sha256"
  ) issues.push("cassette evidence attestation protocol is invalid");
  const exportTrusted = options?.trust === "verified-regression-export";
  const key = exportTrusted ? undefined : signingKey(options, false);
  if (!exportTrusted && attestation.keyId !== keyId(key!)) issues.push("cassette evidence attestation key is not trusted");
  const issued = Date.parse(attestation.issuedAt);
  const expires = Date.parse(attestation.expiresAt);
  const now = (options?.now ?? new Date()).getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued >= expires) {
    issues.push("cassette evidence attestation timestamps are invalid");
  } else {
    if (issued > now + 30_000) issues.push("cassette evidence attestation was issued in the future");
    if (expires <= now) issues.push("cassette evidence attestation has expired");
    if (expires - issued > MAX_TTL_MS) issues.push("cassette evidence attestation lifetime is too long");
  }
  const binding = attestation.binding;
  const mode = document.evidence?.mode;
  const comparisons: Array<[unknown, unknown, string]> = [
    [binding?.tenantId, expected.tenantId, "tenantId"],
    [binding?.tenantSlug, expected.tenantSlug, "tenantSlug"],
    [binding?.domainId, expected.domainId, "domainId"],
    [binding?.toolName, expected.toolName, "toolName"],
    [binding?.definitionHash, expected.definitionHash, "definitionHash"],
    [binding?.configHash, expected.configHash, "configHash"],
    [binding?.mode, mode, "mode"],
    [binding?.actor, document.evidence?.recordedBy, "actor"],
    [document.tool?.name, expected.toolName, "document toolName"],
    [document.tool?.definitionHash, expected.definitionHash, "document definitionHash"],
  ];
  for (const [actual, wanted, label] of comparisons) {
    if (actual !== wanted) issues.push(`cassette evidence ${label} binding mismatch`);
  }
  if (!binding?.actor?.trim()) issues.push("cassette evidence actor binding is missing");
  if (expected.allowedModes && (!mode || !expected.allowedModes.includes(mode))) {
    issues.push(`cassette evidence mode ${String(mode ?? "missing")} is not allowed`);
  }
  const { signature, ...unsigned } = attestation;
  if (exportTrusted) {
    if (!/^[a-f0-9]{64}$/i.test(signature)) {
      issues.push("cassette evidence signature shape is invalid");
    }
  } else {
    const wantedSignature = signatureFor(document, unsigned, key!);
    if (!safeEqualHex(signature, wantedSignature)) {
      issues.push("cassette evidence signature is invalid");
    }
  }
  if (!document.entries.length || !document.entries.every((entry) => validEntry(entry, expected.toolName))) {
    issues.push("cassette evidence entries are invalid");
  }
  if (issues.length) return { valid: false, issues };
  const proof = document.evidence?.writeProbe;
  return {
    valid: true,
    issues: [],
    summary: {
      mode: mode!,
      configHash: attestation.binding.configHash,
      attestationKeyId: attestation.keyId,
      attestationExpiresAt: attestation.expiresAt,
      ...(proof ? {
        writeProbe: {
          schema: proof.schema,
          createCompleted: proof.create?.completed === true,
          cleanupCompleted: proof.cleanup?.completed === true,
          absenceVerified: proof.absence?.verified === true,
          idempotencyKeyHash: proof.idempotencyKeyHash,
        },
      } : {}),
    },
  };
}

export function completeWriteProbeProofIssues(
  proof: WriteProbeCassetteProof | undefined,
): string[] {
  if (!proof) return ["write probe proof is missing"];
  const issues: string[] = [];
  if (proof.schema !== "agent-factory-write-probe/v1") issues.push("write probe proof schema is invalid");
  for (const [label, value] of [
    ["markerHash", proof.markerHash],
    ["namespaceHash", proof.namespaceHash],
    ["targetHash", proof.targetHash],
    ["idempotencyKeyHash", proof.idempotencyKeyHash],
  ] as const) {
    if (!SHA256_OR_FNV.test(value ?? "")) issues.push(`write probe ${label} is invalid`);
  }
  if (proof.create?.completed !== true) issues.push("write probe create proof is incomplete");
  if (proof.cleanup?.completed !== true) issues.push("write probe cleanup proof is incomplete");
  if (proof.absence?.verified !== true) issues.push("write probe absence proof is incomplete");
  return issues;
}
