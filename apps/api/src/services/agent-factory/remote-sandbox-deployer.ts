import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SandboxLifecycleBlockedError,
  sandboxCleanupReceiptIssues,
  verificationPolicy,
  type SandboxExecutionPlaneAttestationExpected,
  type GeneratedAgentSpec,
  type SandboxDeployer,
  type SandboxDeployResult,
} from "@agentic/agent-factory";
import type { TargetInngestIsolationIdentity } from "@agentic/runtime";

import {
  buildSandboxCandidateBundle,
  sandboxCandidateBundleHash,
  type SandboxBundleTestCase,
  type SandboxBundleTenantRegistryDescriptor,
  type SandboxBundleToolDefinitionInput,
  type SandboxBundleToolEvidenceInput,
  type SandboxCandidateBundle,
} from "./sandbox-bundle-builder";
import {
  REMOTE_SANDBOX_ENVELOPE_SCHEMA,
  REMOTE_SANDBOX_RESULT_SCHEMA,
  RemoteSandboxProtocolError,
  canonicalSandboxSha256,
  remoteSandboxResultHash,
  signRemoteSandboxMessage,
  verifyRemoteSandboxMessage,
  verifySandboxExecutionPlaneReceipt,
  type RemoteSandboxAttemptCommand,
  type RemoteSandboxJobResult,
  type RemoteSandboxSubmitCommand,
  type SignedRemoteSandboxMessage,
} from "./sandbox-remote-protocol";
import {
  assertFactorySandboxModelProxyReady,
  factorySandboxModelUsageLedgerIssues,
  registerFactorySandboxModelGrant,
} from "./factory-sandbox-model-proxy";
import {
  assertFactoryProductionImageTrustReady,
  type FactoryProductionImageTrustStatus,
} from "./production-image-attestation";

type SandboxDeployOptions = NonNullable<
  Parameters<SandboxDeployer["deployAndObserve"]>[2]
>;

export const FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV =
  "FACTORY_SANDBOX_REMOTE_CONFIG_REFS" as const;

export interface RemoteSandboxConnectionConfig {
  runnerUrl: string;
  requestSigningKey: string;
  resultSigningKey: string;
  receiptSigningKey: string;
  keyId: string;
  runnerId: string;
  allowedBuildIds: ReadonlySet<string>;
  allowedImageDigests: ReadonlySet<string>;
  platformAttestationExpected?: SandboxExecutionPlaneAttestationExpected;
}

interface RemoteSandboxConfigRefs {
  runnerUrlEnv: string;
  requestSigningKeyEnv: string;
  resultSigningKeyEnv: string;
  receiptSigningKeyEnv?: string;
  keyIdEnv: string;
  runnerIdEnv: string;
  allowedBuildIdsEnv: string;
  allowedImageDigestsEnv: string;
  executionPlaneIdEnv?: string;
  executionPlaneTrustDomainEnv?: string;
  platformAttestorKeyIdEnv?: string;
  platformAttestorPublicKeyEnv?: string;
  primaryHostIdentityHashEnv?: string;
  primaryDockerDaemonIdentityHashEnv?: string;
  allowedControlHostIdentityHashesEnv?: string;
  allowedWorkloadHostIdentityHashesEnv?: string;
  allowedDockerDaemonIdentityHashesEnv?: string;
}

export interface RemoteSandboxTransport {
  submit(
    envelope: SignedRemoteSandboxMessage<
      RemoteSandboxSubmitCommand<SandboxCandidateBundle>
    >,
    signal?: AbortSignal,
  ): Promise<unknown>;
  status(
    attemptId: string,
    envelope: SignedRemoteSandboxMessage<RemoteSandboxAttemptCommand>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  cancel(
    attemptId: string,
    envelope: SignedRemoteSandboxMessage<RemoteSandboxAttemptCommand>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface RemoteSandboxToolEvidenceRequest {
  targetDomainId: string;
  targetTenant: {
    tenantId: string;
    tenantSlug: string;
    registryVersion?: string;
  };
  attemptId: string;
  candidateFingerprint: string;
  specs: GeneratedAgentSpec[];
  testCases: SandboxBundleTestCase[];
}

export interface RemoteSandboxToolSnapshot {
  definitions: SandboxBundleToolDefinitionInput[];
  evidence: SandboxBundleToolEvidenceInput[];
  /** Host-local source files for the exact evidence documents above. Paths
   * stay in the trusted control plane and are never serialized into a bundle. */
  cassetteRefs: Array<{
    bindingId: string;
    specSlugs: string[];
    tool: string;
    path: string;
    definitionHash: string;
    schemaHash?: string;
    evidenceMode: "live-probe" | "signed-fixture" | "runtime-record";
    configHash: string;
    attestationKeyId: string;
    attestationExpiresAt: string;
    writeProbe?: {
      schema: "agent-factory-write-probe/v1";
      createCompleted: boolean;
      cleanupCompleted: boolean;
      absenceVerified: boolean;
      idempotencyKeyHash: string;
    };
  }>;
  /** Signed, secret-free target registry shape. Adapter code itself never
   * crosses into the workload. */
  tenantRegistry?: SandboxBundleTenantRegistryDescriptor;
}

export interface RemoteSandboxDeployerOptions {
  tenantScope?: {
    tenantId: string;
    tenantSlug: string;
    /** Exact native adapter registry selected for the target tenant. */
    registryVersion?: string;
  };
  connection: RemoteSandboxConnectionConfig;
  /** Secret-free target broker/credential identity issued by the API process. */
  targetInngestIsolation?: TargetInngestIsolationIdentity;
  transport?: RemoteSandboxTransport;
  controlPlaneBuildId: string;
  resolveToolEvidence?: (
    request: RemoteSandboxToolEvidenceRequest,
  ) => Promise<RemoteSandboxToolSnapshot>;
  materializeTestCases?: (request: {
    targetDomainId: string;
    targetTenant: {
      tenantId: string;
      tenantSlug: string;
      registryVersion?: string;
    };
    conversationId?: string;
    testCases: SandboxBundleTestCase[];
  }) => Promise<SandboxBundleTestCase[]>;
  now?: () => Date;
  pollIntervalMs?: number;
  timeoutMs?: number;
  envelopeTtlMs?: number;
  /** Non-production diagnostic/test trust posture. Production construction
   * rejects injection and reads host-observed attestation directly. */
  productionImageTrust?: () => FactoryProductionImageTrustStatus;
}

interface ActiveRemoteAttempt {
  domain: string;
  bundleHash: string;
  consumedResultNonces: Set<string>;
}

const adapterVerifiedResults = new WeakSet<object>();

function markAdapterVerifiedResult(
  result: SandboxDeployResult,
): SandboxDeployResult {
  adapterVerifiedResults.add(result);
  return result;
}

/** In-process provenance fence between the HMAC/Ed25519-verifying remote
 * adapter and stores that can mutate Candidate qualification. JSON-shaped
 * evidence constructed by another caller does not carry this capability. */
export function remoteSandboxResultWasAdapterVerified(
  result: SandboxDeployResult,
): boolean {
  return adapterVerifiedResults.has(result);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OCI_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_RESPONSE_BYTES) {
    throw new RemoteSandboxProtocolError(
      "runner_response_too_large",
      "Remote sandbox runner response exceeded the size limit",
    );
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel("response size limit exceeded");
        throw new RemoteSandboxProtocolError(
          "runner_response_too_large",
          "Remote sandbox runner response exceeded the size limit",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function exactEnvName(value: unknown, field: string): string {
  if (typeof value !== "string" || !ENV_NAME.test(value)) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${field} must name an environment variable`,
    );
  }
  return value;
}

function parseRefs(value: string | undefined): RemoteSandboxConfigRefs {
  if (!value?.trim()) {
    throw new RemoteSandboxProtocolError(
      "remote_config_missing",
      `${FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV} is not configured`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV} is not valid JSON`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV} must be an object`,
    );
  }
  const row = parsed as Record<string, unknown>;
  const allowed = new Set([
    "runnerUrlEnv",
    "requestSigningKeyEnv",
    "resultSigningKeyEnv",
    "receiptSigningKeyEnv",
    "keyIdEnv",
    "runnerIdEnv",
    "allowedBuildIdsEnv",
    "allowedImageDigestsEnv",
    "executionPlaneIdEnv",
    "executionPlaneTrustDomainEnv",
    "platformAttestorKeyIdEnv",
    "platformAttestorPublicKeyEnv",
    "primaryHostIdentityHashEnv",
    "primaryDockerDaemonIdentityHashEnv",
    "allowedControlHostIdentityHashesEnv",
    "allowedWorkloadHostIdentityHashesEnv",
    "allowedDockerDaemonIdentityHashesEnv",
  ]);
  const unknown = Object.keys(row).find((key) => !allowed.has(key));
  if (unknown) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV}.${unknown} is unsupported`,
    );
  }
  return {
    runnerUrlEnv: exactEnvName(row.runnerUrlEnv, "runnerUrlEnv"),
    requestSigningKeyEnv: exactEnvName(
      row.requestSigningKeyEnv,
      "requestSigningKeyEnv",
    ),
    resultSigningKeyEnv: exactEnvName(
      row.resultSigningKeyEnv,
      "resultSigningKeyEnv",
    ),
    ...(row.receiptSigningKeyEnv === undefined
      ? {}
      : {
          receiptSigningKeyEnv: exactEnvName(
            row.receiptSigningKeyEnv,
            "receiptSigningKeyEnv",
          ),
        }),
    keyIdEnv: exactEnvName(row.keyIdEnv, "keyIdEnv"),
    runnerIdEnv: exactEnvName(row.runnerIdEnv, "runnerIdEnv"),
    allowedBuildIdsEnv: exactEnvName(
      row.allowedBuildIdsEnv,
      "allowedBuildIdsEnv",
    ),
    allowedImageDigestsEnv: exactEnvName(
      row.allowedImageDigestsEnv,
      "allowedImageDigestsEnv",
    ),
    ...Object.fromEntries(
      [
        "executionPlaneIdEnv",
        "executionPlaneTrustDomainEnv",
        "platformAttestorKeyIdEnv",
        "platformAttestorPublicKeyEnv",
        "primaryHostIdentityHashEnv",
        "primaryDockerDaemonIdentityHashEnv",
        "allowedControlHostIdentityHashesEnv",
        "allowedWorkloadHostIdentityHashesEnv",
        "allowedDockerDaemonIdentityHashesEnv",
      ]
        .filter((field) => row[field] !== undefined)
        .map((field) => [
          field,
          exactEnvName(row[field], field),
        ]),
    ),
  };
}

function envValue(
  name: string,
  env: Record<string, string | undefined>,
  options: { secret?: boolean } = {},
): string {
  const direct = env[name]?.trim();
  const fileName = env[`${name}_FILE`]?.trim();
  if (direct && fileName) {
    throw new RemoteSandboxProtocolError(
      "remote_config_ambiguous",
      `${name} and ${name}_FILE cannot both be configured`,
    );
  }
  let value = direct;
  if (fileName) {
    if (!path.isAbsolute(fileName)) {
      throw new RemoteSandboxProtocolError(
        "remote_config_invalid",
        `${name}_FILE must be an absolute path`,
      );
    }
    try {
      const raw = readFileSync(fileName, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
        throw new Error("secret/config file is too large");
      }
      value = raw.trim();
    } catch (error) {
      throw new RemoteSandboxProtocolError(
        "remote_config_unreadable",
        `${name}_FILE cannot be read: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
      );
    }
  }
  if (!value) {
    throw new RemoteSandboxProtocolError(
      "remote_config_missing",
      `${name} (or ${name}_FILE) is not configured`,
    );
  }
  if (options.secret && Buffer.byteLength(value, "utf8") < 32) {
    throw new RemoteSandboxProtocolError(
      "remote_config_weak_secret",
      `${name} must contain at least 32 bytes`,
    );
  }
  return value;
}

function stringSet(value: string, label: string): ReadonlySet<string> {
  let values: unknown;
  try {
    values = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",");
  } catch {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${label} must be a JSON array or comma-separated list`,
    );
  }
  if (!Array.isArray(values)) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${label} must be a list`,
    );
  }
  const normalized = values
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (!normalized.length || normalized.length !== values.length) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      `${label} must contain one or more non-empty strings`,
    );
  }
  return new Set(normalized);
}

function imageDigestSet(value: string, label: string): ReadonlySet<string> {
  const digests = stringSet(value, label);
  for (const digest of digests) {
    if (!OCI_SHA256_DIGEST.test(digest)) {
      throw new RemoteSandboxProtocolError(
        "remote_config_invalid",
        `${label} must contain only lowercase sha256:<64 hex> OCI digests`,
      );
    }
  }
  return digests;
}

function identityHashSet(
  value: string,
  label: string,
): ReadonlySet<string> {
  const hashes = stringSet(value, label);
  for (const hash of hashes) {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
      throw new RemoteSandboxProtocolError(
        "remote_config_invalid",
        `${label} must contain only domain-separated sha256:<64 hex> identities`,
      );
    }
  }
  return hashes;
}

function normalizedRunnerUrl(
  value: string,
  env: Record<string, string | undefined>,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      "Remote sandbox runner URL is invalid",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      "Remote sandbox runner URL must be an HTTP(S) origin without credentials/query/fragment",
    );
  }
  if (url.protocol === "http:") {
    const allowedHosts = new Set(
      (env.FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    );
    if (
      env.AGENTIC_PROCESS_ROLE !== "api"
      || !allowedHosts.has(url.hostname.toLowerCase())
    ) {
      throw new RemoteSandboxProtocolError(
        "remote_config_invalid",
        "Plain HTTP remote sandbox is allowed only from the API to an explicitly allowlisted internal runner host",
      );
    }
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

/** Resolve only environment *references*.  Secret values are never accepted in
 * the JSON config and may be mounted through Docker/Kubernetes `*_FILE`. */
export function loadRemoteSandboxConnectionConfig(
  env: Record<string, string | undefined> = process.env,
): RemoteSandboxConnectionConfig {
  const refs = parseRefs(env[FACTORY_SANDBOX_REMOTE_CONFIG_REFS_ENV]);
  const externalProduction =
    env.FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY?.trim()
      === "external_sandbox";
  if (externalProduction && !refs.receiptSigningKeyEnv) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      "External sandbox production requires an independent receipt signing key reference",
    );
  }
  const platformRefFields = [
    "executionPlaneIdEnv",
    "executionPlaneTrustDomainEnv",
    "platformAttestorKeyIdEnv",
    "platformAttestorPublicKeyEnv",
    "primaryHostIdentityHashEnv",
    "primaryDockerDaemonIdentityHashEnv",
    "allowedControlHostIdentityHashesEnv",
    "allowedWorkloadHostIdentityHashesEnv",
    "allowedDockerDaemonIdentityHashesEnv",
  ] as const;
  if (
    externalProduction
    && platformRefFields.some((field) => !refs[field])
  ) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      "External sandbox production requires execution-plane attestor, trust-domain, primary host/daemon and remote host/daemon allowlist references",
    );
  }
  const resultSigningKey = envValue(refs.resultSigningKeyEnv, env, {
    secret: true,
  });
  const requestSigningKey = envValue(refs.requestSigningKeyEnv, env, {
    secret: true,
  });
  const receiptSigningKey = refs.receiptSigningKeyEnv
    ? envValue(refs.receiptSigningKeyEnv, env, { secret: true })
    : resultSigningKey;
  if (
    externalProduction
    && new Set([requestSigningKey, resultSigningKey, receiptSigningKey]).size !== 3
  ) {
    throw new RemoteSandboxProtocolError(
      "remote_config_invalid",
      "External sandbox request, result, and receipt signing keys must be distinct",
    );
  }
  const platformAttestationExpected =
    platformRefFields.every((field) => refs[field])
      ? {
          planeId: envValue(refs.executionPlaneIdEnv!, env),
          trustDomain: envValue(refs.executionPlaneTrustDomainEnv!, env),
          runnerId: envValue(refs.runnerIdEnv, env),
          allowedRunnerBuildIds: stringSet(
            envValue(refs.allowedBuildIdsEnv, env),
            refs.allowedBuildIdsEnv,
          ),
          allowedRuntimeImageDigests: imageDigestSet(
            envValue(refs.allowedImageDigestsEnv, env),
            refs.allowedImageDigestsEnv,
          ),
          allowedControlHostIdentityHashes: identityHashSet(
            envValue(refs.allowedControlHostIdentityHashesEnv!, env),
            refs.allowedControlHostIdentityHashesEnv!,
          ),
          allowedWorkloadHostIdentityHashes: identityHashSet(
            envValue(refs.allowedWorkloadHostIdentityHashesEnv!, env),
            refs.allowedWorkloadHostIdentityHashesEnv!,
          ),
          allowedDockerDaemonIdentityHashes: identityHashSet(
            envValue(refs.allowedDockerDaemonIdentityHashesEnv!, env),
            refs.allowedDockerDaemonIdentityHashesEnv!,
          ),
          primaryHostIdentityHash: [...identityHashSet(
            envValue(refs.primaryHostIdentityHashEnv!, env),
            refs.primaryHostIdentityHashEnv!,
          )][0]!,
          primaryDockerDaemonIdentityHash: [...identityHashSet(
            envValue(refs.primaryDockerDaemonIdentityHashEnv!, env),
            refs.primaryDockerDaemonIdentityHashEnv!,
          )][0]!,
          attestorKeyId: envValue(refs.platformAttestorKeyIdEnv!, env),
          attestorPublicKey: envValue(
            refs.platformAttestorPublicKeyEnv!,
            env,
          ),
        } satisfies SandboxExecutionPlaneAttestationExpected
      : undefined;
  return {
    runnerUrl: normalizedRunnerUrl(envValue(refs.runnerUrlEnv, env), env),
    requestSigningKey,
    resultSigningKey,
    receiptSigningKey,
    keyId: envValue(refs.keyIdEnv, env),
    runnerId: envValue(refs.runnerIdEnv, env),
    allowedBuildIds: stringSet(
      envValue(refs.allowedBuildIdsEnv, env),
      refs.allowedBuildIdsEnv,
    ),
    allowedImageDigests: imageDigestSet(
      envValue(refs.allowedImageDigestsEnv, env),
      refs.allowedImageDigestsEnv,
    ),
    ...(platformAttestationExpected
      ? { platformAttestationExpected }
      : {}),
  };
}

export class HttpRemoteSandboxTransport implements RemoteSandboxTransport {
  private readonly baseUrl: string;

  constructor(
    runnerUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizedRunnerUrl(runnerUrl, process.env);
  }

  private async post(pathname: string, envelope: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "error",
      signal: combined,
    });
    const raw = await boundedResponseText(response);
    if (!response.ok) {
      throw new RemoteSandboxProtocolError(
        "runner_http_error",
        `Remote sandbox runner returned HTTP ${response.status}`,
      );
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new RemoteSandboxProtocolError(
        "runner_response_invalid",
        "Remote sandbox runner returned invalid JSON",
      );
    }
  }

  submit(
    envelope: SignedRemoteSandboxMessage<
      RemoteSandboxSubmitCommand<SandboxCandidateBundle>
    >,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.post("/internal/v1/sandbox-jobs", envelope, signal);
  }

  status(
    attemptId: string,
    envelope: SignedRemoteSandboxMessage<RemoteSandboxAttemptCommand>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.post(
      `/internal/v1/sandbox-jobs/${encodeURIComponent(attemptId)}/status`,
      envelope,
      signal,
    );
  }

  cancel(
    attemptId: string,
    envelope: SignedRemoteSandboxMessage<RemoteSandboxAttemptCommand>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.post(
      `/internal/v1/sandbox-jobs/${encodeURIComponent(attemptId)}/cancel`,
      envelope,
      signal,
    );
  }
}

function lifecycleBlock(
  code:
    | "target_scope_missing"
    | "sandbox_config_missing"
    | "sandbox_fixture_invalid"
    | "sandbox_isolation_invalid"
    | "sandbox_execution_failed"
    | "sandbox_unregister_unavailable"
    | "sandbox_cleanup_failed",
  question: string,
  missing: string[],
): SandboxLifecycleBlockedError {
  return new SandboxLifecycleBlockedError({
    code,
    next: "ask_user",
    question,
    missing,
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    // The deployer is also used by short-lived CI/probe workers. An awaited
    // poll delay must keep that process alive; otherwise Node exits with an
    // unsettled top-level await before the runner can return cleanup evidence.
    // The AbortSignal path below remains the bounded shutdown mechanism.
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function qualifyForHostTopology(
  result: SandboxDeployResult,
  trust: FactoryProductionImageTrustStatus,
): SandboxDeployResult {
  if (trust.topology !== "single_host_compose") return result;
  const diagnostic = "same_host_container_diagnostic_only";
  return {
    ...result,
    degradedAgents: [...new Set([...result.degradedAgents, diagnostic])],
    functionTester: result.functionTester?.map((entry) => ({
      ...entry,
      qualification: "development_only" as const,
      reasons: [...entry.reasons, "同宿主容器只用于诊断；需要 external_sandbox 才能形成可晋升证据。"],
    })),
  };
}

function asJobResult(
  value: unknown,
  expectedAttemptId: string,
  expectedBundleHash: string,
): RemoteSandboxJobResult<SandboxDeployResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteSandboxProtocolError(
      "runner_result_invalid",
      "Remote sandbox job result is not an object",
    );
  }
  const result = value as RemoteSandboxJobResult<SandboxDeployResult>;
  if (
    result.schema !== REMOTE_SANDBOX_RESULT_SCHEMA ||
    result.attemptId !== expectedAttemptId ||
    result.bundleHash !== expectedBundleHash ||
    ![
      "accepted",
      "running",
      "cleanup_pending",
      "completed",
      "failed",
      "cancelled",
    ].includes(result.status)
  ) {
    throw new RemoteSandboxProtocolError(
      "runner_result_identity_mismatch",
      "Remote sandbox job result is not bound to this attempt/bundle",
    );
  }
  return result;
}

/** Reattach host-local cassette paths only after the signed remote result has
 * been verified. Binding by tool name is insufficient because two generated
 * functions may intentionally select the same implementation with different
 * integration configs. */
export function bindRemoteSandboxCassetteRefs(
  snapshot: RemoteSandboxToolSnapshot,
  bundle: SandboxCandidateBundle,
): NonNullable<SandboxDeployResult["cassetteRefs"]> {
  const bundled = new Map(bundle.toolEvidence.map((entry) => [entry.bindingId, entry]));
  const refIds = snapshot.cassetteRefs.map((ref) => ref.bindingId);
  if (
    bundled.size !== bundle.toolEvidence.length
    || new Set(refIds).size !== refIds.length
    || snapshot.cassetteRefs.length !== bundled.size
  ) {
    throw new RemoteSandboxProtocolError(
      "tool_evidence_identity_mismatch",
      "Remote sandbox cassette source references do not cover the exact submitted bundle",
    );
  }
  return snapshot.cassetteRefs.map((ref) => {
    const evidence = bundled.get(ref.bindingId);
    if (
      !evidence
      || evidence.bindingId !== ref.bindingId
      || evidence.toolName !== ref.tool
      || canonicalSandboxSha256(evidence.specSlugs)
        !== canonicalSandboxSha256(ref.specSlugs)
      || evidence.definitionHash !== ref.definitionHash
      || evidence.schemaHash !== ref.schemaHash
      || evidence.configHash !== ref.configHash
      || evidence.cassette.evidence?.mode !== ref.evidenceMode
      || evidence.cassette.evidence?.attestation?.binding.configHash !== ref.configHash
      || evidence.cassette.evidence?.attestation?.keyId !== ref.attestationKeyId
      || evidence.cassette.evidence?.attestation?.expiresAt !== ref.attestationExpiresAt
    ) {
      throw new RemoteSandboxProtocolError(
        "tool_evidence_identity_mismatch",
        `Remote sandbox cassette source for '${ref.tool}' binding '${ref.bindingId}' is not bound to the submitted bundle`,
      );
    }
    const proof = evidence.cassette.evidence?.writeProbe;
    if (ref.writeProbe && (
      !proof
      || proof.schema !== ref.writeProbe.schema
      || (proof.create?.completed === true) !== ref.writeProbe.createCompleted
      || (proof.cleanup?.completed === true) !== ref.writeProbe.cleanupCompleted
      || (proof.absence?.verified === true) !== ref.writeProbe.absenceVerified
      || proof.idempotencyKeyHash !== ref.writeProbe.idempotencyKeyHash
    )) {
      throw new RemoteSandboxProtocolError(
        "tool_evidence_identity_mismatch",
        `Remote sandbox cassette write proof for '${ref.tool}' binding '${ref.bindingId}' is not bound to the submitted bundle`,
      );
    }
    if (!ref.writeProbe && proof) {
      throw new RemoteSandboxProtocolError(
        "tool_evidence_identity_mismatch",
        `Remote sandbox cassette write proof summary for '${ref.tool}' binding '${ref.bindingId}' is missing`,
      );
    }
    return {
      ...ref,
      contentHash: evidence.contentHash,
    };
  });
}

export class RemoteSandboxDeployer implements SandboxDeployer {
  private readonly transport: RemoteSandboxTransport;
  private readonly active = new Map<string, ActiveRemoteAttempt>();
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly envelopeTtlMs: number;

  constructor(private readonly options: RemoteSandboxDeployerOptions) {
    // Non-production composition may explicitly downgrade a signed same-host
    // runner to development_only. Production must always read the independent
    // host attestation itself and may never accept an injected trust result.
    if (options.productionImageTrust && process.env.NODE_ENV === "production") {
      throw new RemoteSandboxProtocolError(
        "remote_config_invalid",
        "production image trust verifier cannot be injected in production",
      );
    }
    this.transport = options.transport ?? new HttpRemoteSandboxTransport(
      options.connection.runnerUrl,
    );
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.envelopeTtlMs = options.envelopeTtlMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10 || this.pollIntervalMs > 60_000 ||
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60 * 60_000
    ) {
      throw new RemoteSandboxProtocolError(
        "remote_config_invalid",
        "Remote sandbox polling/timeout configuration is invalid",
      );
    }
  }

  private signed<T>(
    purpose: "submit" | "status" | "cancel",
    payload: T,
  ): SignedRemoteSandboxMessage<T> {
    return signRemoteSandboxMessage({
      purpose,
      keyId: this.options.connection.keyId,
      secret: this.options.connection.requestSigningKey,
      payload,
      now: this.now(),
      ttlMs: this.envelopeTtlMs,
    });
  }

  private verifiedJobResult(
    raw: unknown,
    active: ActiveRemoteAttempt,
    attemptId: string,
  ): RemoteSandboxJobResult<SandboxDeployResult> {
    const envelope = raw as SignedRemoteSandboxMessage<
      RemoteSandboxJobResult<SandboxDeployResult>
    >;
    if (envelope?.schema !== REMOTE_SANDBOX_ENVELOPE_SCHEMA) {
      throw new RemoteSandboxProtocolError(
        "runner_envelope_invalid",
        "Remote sandbox runner did not return a signed envelope",
      );
    }
    const payload = verifyRemoteSandboxMessage(envelope, {
      expectedPurpose: "result",
      expectedKeyId: this.options.connection.keyId,
      secret: this.options.connection.resultSigningKey,
      now: this.now(),
      consumedNonces: active.consumedResultNonces,
    });
    return asJobResult(payload, attemptId, active.bundleHash);
  }

  private validateCompletedResult(
    result: SandboxDeployResult,
    bundle: SandboxCandidateBundle,
    productionImageTrust: FactoryProductionImageTrustStatus,
  ): SandboxDeployResult {
    if (!result || typeof result !== "object") {
      throw new RemoteSandboxProtocolError(
        "runner_result_invalid",
        "Completed remote sandbox job has no result",
      );
    }
    const cleanupIssues = sandboxCleanupReceiptIssues(result.cleanupReceipt, {
      candidateFingerprint: bundle.candidateFingerprint,
      targetDomainId: bundle.targetDomainId,
    });
    if (
      result.simulated === true ||
      result.candidateFingerprint !== bundle.candidateFingerprint ||
      result.targetDomainId !== bundle.targetDomainId ||
      result.sandboxAttemptId !== bundle.attemptId ||
      result.sandboxTenantSlug !== bundle.sandboxTenantSlug ||
      result.cleanupVerified !== true ||
      result.cleanupReceipt?.appId !== result.appId ||
      result.cleanupReceipt?.sandboxAttemptId !== bundle.attemptId ||
      result.cleanupReceipt?.sandboxTenantSlug !== bundle.sandboxTenantSlug ||
      cleanupIssues.length > 0
    ) {
      throw new RemoteSandboxProtocolError(
        "runner_cleanup_invalid",
        `Remote sandbox result/cleanup identity is invalid${cleanupIssues.length ? `: ${cleanupIssues.join("; ")}` : ""}`,
      );
    }
    const functionFailure = (result.functionTester ?? []).some((entry) =>
      !entry.pass || !entry.ran || entry.qualification !== "promotable");
    const candidateFailed =
      result.fullChainRan !== true
      || result.reachedSuccessTerminal !== true
      || result.degradedAgents.length > 0
      || functionFailure
      || result.toolMode !== "evidence_replay"
      || result.externalLiveCalls !== 0
      || result.sandboxReplayEvidenceComplete !== true;
    if (!result.executionReceipt && candidateFailed) {
      // The result envelope is HMAC-authenticated and its cleanup receipt was
      // checked above. Missing promotion evidence is expected for a red
      // candidate; return it to the Harness so the user can edit/retry without
      // poisoning runner readiness. Acceptance remains fail-closed.
      return result;
    }
    if (!result.executionReceipt) {
      throw new RemoteSandboxProtocolError(
        "execution_receipt_missing",
        "Remote sandbox result has no signed execution-plane receipt",
      );
    }
    if (
      result.toolMode !== "evidence_replay" ||
      result.externalLiveCalls !== 0 ||
      result.sandboxReplayEvidenceComplete !== true
    ) {
      throw new RemoteSandboxProtocolError(
        "runner_replay_invalid",
        "Remote sandbox did not prove a complete zero-live-call evidence replay",
      );
    }
    const modelLedgerIssues = factorySandboxModelUsageLedgerIssues(result.modelUsage);
    if (modelLedgerIssues.length) {
      throw new RemoteSandboxProtocolError(
        "runner_model_usage_mismatch",
        `Remote sandbox model usage does not match the primary proxy ledger: ${modelLedgerIssues.join("; ")}`,
      );
    }
    const resultHash = remoteSandboxResultHash(result);
    verifySandboxExecutionPlaneReceipt(result.executionReceipt, {
      secret: this.options.connection.receiptSigningKey,
      expected: {
        candidateFingerprint: bundle.candidateFingerprint,
        targetDomainId: bundle.targetDomainId,
        targetTenantId: bundle.targetTenant.id,
        targetTenantSlug: bundle.targetTenant.slug,
        sandboxAttemptId: bundle.attemptId,
        bundleHash: bundle.bundleHash,
        resultHash,
        modelUsageHash: result.modelUsage?.evidenceHash,
      },
      expectedRunnerId: this.options.connection.runnerId,
      allowedRunnerBuildIds: this.options.connection.allowedBuildIds,
      allowedRuntimeImageDigests:
        this.options.connection.allowedImageDigests,
      platformAttestationExpected:
        this.options.connection.platformAttestationExpected,
      allowDiagnosticSameHost:
        productionImageTrust.topology === "single_host_compose",
      now: this.now(),
    });
    const expectedPolicyHash = `sandbox-policy:v1:${canonicalSandboxSha256(bundle.policy)}`;
    if (result.executionReceipt.policyHash !== expectedPolicyHash) {
      throw new RemoteSandboxProtocolError(
        "execution_policy_mismatch",
        "Remote sandbox execution receipt is not bound to the submitted policy",
      );
    }
    const createdAt = Date.parse(bundle.createdAt);
    const expiresAt = Date.parse(bundle.expiresAt);
    const startedAt = Date.parse(result.executionReceipt.startedAt);
    if (startedAt < createdAt - 5_000 || startedAt > expiresAt + 5_000) {
      throw new RemoteSandboxProtocolError(
        "execution_start_time_invalid",
        "Remote sandbox workload did not start inside the bundle validity window",
      );
    }
    return result;
  }

  private bindLocalCassetteRefs(
    snapshot: RemoteSandboxToolSnapshot,
    bundle: SandboxCandidateBundle,
  ): NonNullable<SandboxDeployResult["cassetteRefs"]> {
    return bindRemoteSandboxCassetteRefs(snapshot, bundle);
  }

  private async cancelAttempt(
    attemptId: string,
    active: ActiveRemoteAttempt,
    reason: string,
  ): Promise<void> {
    const command: RemoteSandboxAttemptCommand = {
      schema: "agent-factory-sandbox-cancel/v1",
      attemptId,
      bundleHash: active.bundleHash,
      reason: reason.slice(0, 240),
    };
    // Cancellation must still be attempted after the caller's AbortSignal has
    // fired; use a fresh bounded transport signal.
    const raw = await this.transport.cancel(
      attemptId,
      this.signed("cancel", command),
      AbortSignal.timeout(30_000),
    );
    const result = this.verifiedJobResult(raw, active, attemptId);
    if (result.status !== "cancelled") {
      throw new RemoteSandboxProtocolError(
        "runner_cancel_unconfirmed",
        "Remote sandbox runner did not confirm cancellation and cleanup",
      );
    }
  }

  async deployAndObserve(
    domain: string,
    specs: GeneratedAgentSpec[],
    opts?: SandboxDeployOptions,
  ): Promise<SandboxDeployResult> {
    let productionImageTrust: FactoryProductionImageTrustStatus;
    try {
      productionImageTrust = this.options.productionImageTrust
        ? this.options.productionImageTrust()
        : assertFactoryProductionImageTrustReady();
    } catch (error) {
      throw lifecycleBlock(
        "sandbox_config_missing",
        "生产镜像的主机签名证明缺失、已过期或与当前部署不一致，所以我没有创建沙箱 App。请先让主机验证器重新检查当前镜像；修好后再继续。",
        [String((error as Error)?.message ?? error).slice(0, 180)],
      );
    }
    if (!this.options.tenantScope) {
      throw lifecycleBlock(
        "target_scope_missing",
        "我还不知道这些 Agent 最终属于哪个 tenant，所以没有把候选代码发送到外部沙箱。请先选择目标业务空间。",
        ["target tenant id", "target tenant slug"],
      );
    }
    if (process.env.NODE_ENV !== "test") {
      try {
        assertFactorySandboxModelProxyReady();
      } catch (error) {
        throw lifecycleBlock(
          "sandbox_config_missing",
          "外部沙箱的真实模型代理还没有准备好，所以我没有创建测试 App。请配置 API↔workload 专用 token，并确认默认真实模型和预算可用。",
          [String((error as Error)?.message ?? error).slice(0, 180)],
        );
      }
    }
    const candidateFingerprint = opts?.candidateFingerprint?.trim();
    if (!candidateFingerprint) {
      throw lifecycleBlock(
        "sandbox_isolation_invalid",
        "这版代码还没有不可变指纹，所以不能送进外部测试环境。请重新运行预检后再试。",
        ["candidate fingerprint"],
      );
    }
    if (opts?.dryRun) {
      throw lifecycleBlock(
        "sandbox_isolation_invalid",
        "外部沙箱不会把 dry-run 冒充真实运行。请执行完整沙箱测试，或只停留在预检阶段。",
        ["real remote execution"],
      );
    }
    if (
      !this.options.targetInngestIsolation
      || this.options.targetInngestIsolation.targetTenantSlug !== this.options.tenantScope.tenantSlug
    ) {
      throw lifecycleBlock(
        "sandbox_isolation_invalid",
        "目标业务空间的 Inngest 隔离身份还没有准备好，所以我没有把代码发到外部沙箱。请补齐该 tenant 的独立 Inngest 配置；生产密钥只在控制面做哈希，不会传给 workload。",
        ["target tenant Inngest isolation identity"],
      );
    }
    opts?.signal?.throwIfAborted();
    const attemptId = randomUUID();
    const targetTenant = this.options.tenantScope;
    let testCases = (opts?.testCases ?? []) as SandboxBundleTestCase[];
    try {
      if (this.options.materializeTestCases) {
        testCases = await this.options.materializeTestCases({
          targetDomainId: domain,
          targetTenant,
          conversationId: opts?.fixtureConversationId,
          testCases,
        });
      }
    } catch (error) {
      throw lifecycleBlock(
        "sandbox_fixture_invalid",
        "测试文件无法安全地装入外部沙箱，所以我没有提交这次任务。请重新上传当前会话的脱敏测试文件。",
        [String((error as Error)?.message ?? error).slice(0, 180)],
      );
    }
    let toolSnapshot: RemoteSandboxToolSnapshot = {
      definitions: [],
      evidence: [],
      cassetteRefs: [],
    };
    try {
      toolSnapshot = this.options.resolveToolEvidence
        ? await this.options.resolveToolEvidence({
            targetDomainId: domain,
            targetTenant,
            attemptId,
            candidateFingerprint,
            specs,
            testCases,
          })
        : toolSnapshot;
    } catch (error) {
      throw lifecycleBlock(
        "sandbox_fixture_invalid",
        "当前工具定义或安全探针证据无法打包，所以我没有让外部沙箱猜测工具返回值。请先修复对应工具的 probe/cassette。",
        [String((error as Error)?.message ?? error).slice(0, 180)],
      );
    }

    const maxModelCalls = Math.min(
      1_024,
      Math.max(8, specs.length * Math.max(1, testCases.length + 1) * 4),
    );
    const configuredModelBudget = verificationPolicy().budgetTokens;
    if (
      process.env.NODE_ENV !== "test"
      && (!Number.isSafeInteger(configuredModelBudget) || configuredModelBudget < 1)
    ) {
      throw lifecycleBlock(
        "sandbox_config_missing",
        "真实模型测试还没有设置有限的总 token 预算，所以我没有创建临时 App。请配置 FACTORY_SANDBOX_BUDGET_TOKENS 后重试。",
        ["FACTORY_SANDBOX_BUDGET_TOKENS must be a positive integer"],
      );
    }
    const maxModelTotalTokens = Number.isSafeInteger(configuredModelBudget)
      && configuredModelBudget > 0
      ? configuredModelBudget
      : maxModelCalls * 8_192;

    let bundle: SandboxCandidateBundle;
    try {
      bundle = buildSandboxCandidateBundle({
        attemptId,
        candidateFingerprint,
        targetDomainId: domain,
        targetTenant,
        targetInngestIsolation: this.options.targetInngestIsolation,
        controlPlaneBuildId: this.options.controlPlaneBuildId,
        specs,
        testCases,
        boundaryEvents: opts?.boundaryEvents,
        tenantRegistry: toolSnapshot.tenantRegistry,
        toolDefinitions: toolSnapshot.definitions,
        toolEvidence: toolSnapshot.evidence,
        policy: {
          maxModelCalls,
          maxModelTotalTokens,
        },
        now: this.now(),
      });
      if (sandboxCandidateBundleHash(bundle) !== bundle.bundleHash) {
        throw new Error("candidate bundle hash mismatch after construction");
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 240);
      throw lifecycleBlock(
        "sandbox_isolation_invalid",
        `候选包没有通过外部沙箱安全预检：${message}。我没有发送代码，也不会删减证据后重试。`,
        [message],
      );
    }

    const active: ActiveRemoteAttempt = {
      domain,
      bundleHash: bundle.bundleHash,
      consumedResultNonces: new Set(),
    };
    const revokeModelGrant = registerFactorySandboxModelGrant({
      attemptId,
      bundleHash: bundle.bundleHash,
      tenantId: targetTenant.tenantId,
      tenantSlug: targetTenant.tenantSlug,
      expiresAt: this.now().getTime() + this.timeoutMs + 60_000,
      maxCalls: bundle.policy.maxModelCalls,
      maxTotalTokens: bundle.policy.maxModelTotalTokens,
    });
    this.active.set(attemptId, active);
    let completed = false;
    try {
      const submit: RemoteSandboxSubmitCommand<SandboxCandidateBundle> = {
        schema: "agent-factory-sandbox-submit/v1",
        attemptId,
        bundleHash: bundle.bundleHash,
        bundle,
      };
      const submitted = this.verifiedJobResult(
        await this.transport.submit(
          this.signed("submit", submit),
          opts?.signal,
        ),
        active,
        attemptId,
      );
      if (submitted.status === "completed") {
        const validated = this.validateCompletedResult(
          submitted.result!,
          bundle,
          productionImageTrust,
        );
        completed = true;
        return markAdapterVerifiedResult(qualifyForHostTopology({
          ...validated,
          cassetteRefs: this.bindLocalCassetteRefs(toolSnapshot, bundle),
        }, productionImageTrust));
      }
      if (submitted.status === "cancelled") {
        throw new RemoteSandboxProtocolError(
          "runner_clean_rejection",
          submitted.error?.message || "Remote sandbox runner rejected the job",
        );
      }
      if (submitted.status === "failed") {
        throw new RemoteSandboxProtocolError(
          "runner_rejected",
          submitted.error?.message || "Remote sandbox runner failed the job",
        );
      }

      const deadline = this.now().getTime() + this.timeoutMs;
      while (this.now().getTime() < deadline) {
        opts?.signal?.throwIfAborted();
        await abortableDelay(this.pollIntervalMs, opts?.signal);
        const command: RemoteSandboxAttemptCommand = {
          schema: "agent-factory-sandbox-status/v1",
          attemptId,
          bundleHash: bundle.bundleHash,
        };
        const status = this.verifiedJobResult(
          await this.transport.status(
            attemptId,
            this.signed("status", command),
            opts?.signal,
          ),
          active,
          attemptId,
        );
        if (status.status === "completed") {
          const validated = this.validateCompletedResult(
            status.result!,
            bundle,
            productionImageTrust,
          );
          completed = true;
          return markAdapterVerifiedResult(qualifyForHostTopology({
            ...validated,
            cassetteRefs: this.bindLocalCassetteRefs(toolSnapshot, bundle),
          }, productionImageTrust));
        }
        if (status.status === "cancelled") {
          throw new RemoteSandboxProtocolError(
            "runner_clean_rejection",
            status.error?.message || "Remote sandbox rejected the job and independently verified zero residual resources",
          );
        }
        if (status.status === "failed") {
          throw new RemoteSandboxProtocolError(
            "runner_failed",
            status.error?.message || "Remote sandbox job failed",
          );
        }
      }
      throw new RemoteSandboxProtocolError(
        "runner_timeout",
        "Remote sandbox job exceeded its execution deadline",
      );
    } catch (error) {
      let cleanupConfirmed = completed;
      if (!completed) {
        try {
          await this.cancelAttempt(
            attemptId,
            active,
            opts?.signal?.aborted ? "caller aborted" : "control-plane failure",
          );
          cleanupConfirmed = true;
        } catch {
          // The original failure remains primary.  A missing signed cancel
          // receipt is reflected in the lifecycle block below and prevents
          // promotion; it is never interpreted as successful cleanup.
        }
      }
      if (error instanceof SandboxLifecycleBlockedError) throw error;
      const message = String((error as Error)?.message ?? error).slice(0, 240);
      if (
        error instanceof RemoteSandboxProtocolError
        && error.code === "runner_clean_rejection"
      ) {
        throw lifecycleBlock(
          "sandbox_isolation_invalid",
          `外部测试环境拒绝了这版配置，但已通过独立检查确认没有遗留运行资源。请根据原因补齐配置或修改候选代码后，再发起一次新测试：${message}`,
          [message],
        );
      }
      if (cleanupConfirmed) {
        throw lifecycleBlock(
          "sandbox_execution_failed",
          `外部沙箱没有接受这次运行结果，但已验签确认临时任务和执行资源都清理干净了。不会晋升这版代码；请根据原因修复配置或候选代码后，创建一个新的测试任务：${message}`,
          [message],
        );
      }
      throw lifecycleBlock(
        "sandbox_cleanup_failed",
        `外部沙箱没有返回一份可验签、可证明已清理的结果：${message}。这次结果不会用于晋升，请检查 runner 后再重新创建新任务。`,
        [message],
      );
    } finally {
      revokeModelGrant();
      this.active.delete(attemptId);
    }
  }

  async teardown(domain: string): Promise<void> {
    const attempts = [...this.active.entries()].filter(
      ([, attempt]) => attempt.domain === domain,
    );
    const failures: unknown[] = [];
    for (const [attemptId, attempt] of attempts) {
      try {
        await this.cancelAttempt(attemptId, attempt, "factory teardown");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw lifecycleBlock(
        "sandbox_cleanup_failed",
        `有 ${failures.length} 个外部沙箱任务没有返回可验签的取消/清理状态。请先检查 runner，系统不会把它们当成已清理。`,
        failures.map((error) =>
          String((error as Error)?.message ?? error).slice(0, 160),
        ),
      );
    }
  }
}
