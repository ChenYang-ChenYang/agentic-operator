/** Canonical cassette contract shared by Agent Factory record/probe and Runtime
 * replay. It intentionally contains no secrets: request bodies/args are keyed by
 * deterministic hashes and any optional preview is recursively redacted. */

export interface CanonicalCassetteEntry {
  key: string;
  request:
    | { kind: "http"; method: string; url: string; bodyHash: string }
    | { kind: "tool"; toolName: string; argsHash: string };
  response: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
    durationMs?: number;
  };
  recordedAt?: string;
}

export interface WriteProbeCassetteProof {
  schema: "agent-factory-write-probe/v1";
  markerHash: string;
  namespaceHash: string;
  targetHash: string;
  idempotencyKeyHash: string;
  create: { completed: boolean; evidence?: unknown };
  cleanup: { completed: boolean; evidence?: unknown };
  absence: { verified: boolean; evidence?: unknown };
}

/** API-issued integrity envelope for cassette evidence.  The signature covers
 * the complete cassette with this field omitted plus every value below.  It is
 * deliberately tenant/domain/config scoped so copying a valid fixture between
 * integration profiles cannot turn it into valid evidence. */
export interface CassetteEvidenceAttestation {
  schema: "agent-factory-cassette-attestation/v1";
  algorithm: "hmac-sha256";
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  binding: {
    tenantId: string;
    tenantSlug: string;
    domainId: string;
    toolName: string;
    definitionHash: string;
    configHash: string;
    actor: string;
    mode: "live-probe" | "signed-fixture" | "runtime-record";
    /** A bundle confirmation authorizes only this exact plan. This provenance
     * is secret-free and covered by the cassette HMAC. */
    authorization?: {
      kind: "sandbox_evidence_plan";
      subjectDigest: string;
      challengeId: string;
    };
  };
  signature: string;
}

export interface CanonicalCassetteDocument {
  version: 1;
  tool?: {
    name: string;
    definitionHash: string;
    schemaHash?: string;
    version?: string;
  };
  evidence?: {
    recordedAt: string;
    recordedBy?: string;
    mode: "live-probe" | "signed-fixture" | "runtime-record";
    /** Secret-free proof that a write canary was created, cleaned up, and
     * subsequently read back as absent. Raw identifiers are never persisted. */
    writeProbe?: WriteProbeCassetteProof;
    /** Immutable managed-tool revision identity used when a draft/retired
     * revision is probed. This is added before attestation, so activation can
     * prove the cassette belongs to the exact reviewed revision instead of
     * trusting mutable database summary JSON. */
    toolRevision?: {
      id: string;
      definitionHash: string;
    };
    /** API-owned signature.  In particular, the text `signed-fixture` is not
     * trusted unless this envelope verifies against the persistent API key. */
    attestation?: CassetteEvidenceAttestation;
  };
  entries: CanonicalCassetteEntry[];
}

const SENSITIVE_KEY = /(?:api[_-]?key|token|authorization|secret|password|cookie|credential)/i;

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function cassetteHash(value: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function canonicalHttpCassetteKey(method: string, url: string, body?: string): string {
  return cassetteHash(`${(method || "GET").toUpperCase()} ${url} ${body ?? ""}`);
}

export function canonicalToolCassetteKey(toolName: string, args: unknown): string {
  return cassetteHash(`${toolName} ${stableJson(args ?? {})}`);
}

export function redactCassetteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCassetteValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      ? value.replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
      : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactCassetteValue(item),
  ]));
}

export function isCanonicalCassette(value: unknown): value is CanonicalCassetteDocument {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CanonicalCassetteDocument>;
  return row.version === 1 && Array.isArray(row.entries);
}

export function lookupCanonicalToolCassette(
  value: unknown,
  toolName: string,
  args: unknown,
  expectedDefinitionHash?: string,
): unknown | undefined {
  if (!isCanonicalCassette(value)) return undefined;
  if (value.tool && value.tool.name !== toolName) return undefined;
  if (expectedDefinitionHash && value.tool?.definitionHash !== expectedDefinitionHash) return undefined;
  const key = canonicalToolCassetteKey(toolName, args);
  return value.entries.find((entry) => entry.key === key && entry.request.kind === "tool")?.response.body;
}

export function makeToolCassetteEntry(input: {
  toolName: string;
  args: unknown;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  durationMs?: number;
  recordedAt?: string;
}): CanonicalCassetteEntry {
  const key = canonicalToolCassetteKey(input.toolName, input.args);
  return {
    key,
    request: { kind: "tool", toolName: input.toolName, argsHash: cassetteHash(stableJson(input.args ?? {})) },
    response: {
      status: input.status,
      body: redactCassetteValue(input.body),
      ...(input.headers ? { headers: redactCassetteValue(input.headers) as Record<string, string> } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    },
    recordedAt: input.recordedAt,
  };
}
