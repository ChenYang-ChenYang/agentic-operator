#!/usr/bin/env node

import { createHash, verify as verifySignature } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPOSE = path.join(HERE, "compose.external.yml");
const DEFAULT_INGRESS = path.join(HERE, "compose.external-loopback.yml");
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const IDENTITY_HASH = /^sha256:[a-f0-9]{64}$/;
const PLACEHOLDER = /(?:replace[-_ ]?with|placeholder|change[-_ ]?me|example\.(?:com|invalid)|<[^>]+>|^sha256:0{64}$)/i;

const REQUIRED = [
  "EXTERNAL_SANDBOX_COMPOSE_PROJECT",
  "EXTERNAL_SANDBOX_TLS_TERMINATION",
  "EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN",
  "EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN",
  "EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256",
  "EXTERNAL_SANDBOX_PRIMARY_HOST_ID_SHA256",
  "EXTERNAL_SANDBOX_ATTESTATION_ROOT",
  "EXTERNAL_SANDBOX_EXECUTION_PLANE_ID",
  "EXTERNAL_SANDBOX_EXECUTION_PLANE_TRUST_DOMAIN",
  "EXTERNAL_SANDBOX_PLATFORM_ATTESTOR_KEY_ID",
  "EXTERNAL_SANDBOX_PRIMARY_HOST_IDENTITY_HASH",
  "EXTERNAL_SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH",
  "EXTERNAL_SANDBOX_CONTROL_HOST_IDENTITY_HASH",
  "EXTERNAL_SANDBOX_WORKLOAD_HOST_IDENTITY_HASH",
  "EXTERNAL_SANDBOX_DOCKER_DAEMON_IDENTITY_HASH",
  "EXTERNAL_SANDBOX_SECRET_ROOT",
  "EXTERNAL_SANDBOX_SECRET_GID",
  "EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH",
  "EXTERNAL_SANDBOX_DOCKER_SOCKET_GID",
  "EXTERNAL_SANDBOX_KEY_ID",
  "EXTERNAL_SANDBOX_RUNNER_ID",
  "EXTERNAL_SANDBOX_RUNNER_BUILD_ID",
  "EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST",
  "EXTERNAL_SANDBOX_APP_PREFIX",
  "EXTERNAL_SANDBOX_CONTROL_IMAGE",
  "EXTERNAL_SANDBOX_WORKLOAD_IMAGE",
  "EXTERNAL_SANDBOX_GATEWAY_IMAGE",
  "EXTERNAL_SANDBOX_CANDIDATE_IMAGE",
  "EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST",
  "EXTERNAL_SANDBOX_INNGEST_IMAGE",
  "EXTERNAL_SANDBOX_POSTGRES_IMAGE",
  "EXTERNAL_SANDBOX_REDIS_IMAGE",
];

const SECRET_FILES = [
  ["shared-with-primary/request-hmac", "opaque"],
  ["shared-with-primary/result-hmac", "opaque"],
  ["shared-with-primary/receipt-hmac", "opaque"],
  ["shared-with-primary/model-proxy-token", "opaque"],
  ["remote-only/workload-token", "opaque"],
  ["remote-only/control-bearer", "opaque"],
  ["remote-only/cancel-fence-hmac", "opaque"],
  ["remote-only/gateway-tombstone-hmac", "opaque"],
  ["remote-only/event-key", "hex"],
  ["remote-only/signing-key", "hex"],
  ["remote-only/postgres-password", "hex"],
  ["remote-only/redis-password", "hex"],
  ["remote-only/redis-acl", "redis-acl"],
];

const FORBIDDEN_DIRECT_SECRETS = [
  "FACTORY_SB_REQUEST_HMAC",
  "FACTORY_SB_RESULT_HMAC",
  "FACTORY_SB_RECEIPT_HMAC",
  "FACTORY_SB_MODEL_PROXY_TOKEN",
  "SANDBOX_RUNNER_REQUEST_HMAC",
  "SANDBOX_RUNNER_RESULT_HMAC",
  "SANDBOX_RUNNER_RECEIPT_HMAC",
  "SANDBOX_WORKLOAD_TOKEN",
  "SANDBOX_CANCEL_FENCE_HMAC",
  "SANDBOX_INNGEST_CONTROL_BEARER",
  "SANDBOX_INNGEST_EVENT_KEY",
  "SANDBOX_INNGEST_SIGNING_KEY",
];

export class ExternalSandboxConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalSandboxConfigError";
  }
}

function fail(message) {
  throw new ExternalSandboxConfigError(message);
}

export function machineIdSha256(value) {
  const normalized = String(value ?? "").replace(/[\r\n ]/g, "");
  if (!/^[A-Fa-f0-9-]{16,128}$/.test(normalized)) {
    fail("host machine-id is missing or malformed");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required`);
  if (PLACEHOLDER.test(value)) fail(`${name} still contains a placeholder`);
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function validatePlatformAttestation(env) {
  const rootInput = required(env, "EXTERNAL_SANDBOX_ATTESTATION_ROOT");
  if (!path.isAbsolute(rootInput)) {
    fail("EXTERNAL_SANDBOX_ATTESTATION_ROOT must be absolute");
  }
  let document;
  let publicKey;
  try {
    const root = realpathSync(rootInput);
    document = JSON.parse(
      readFileSync(path.join(root, "execution-plane.json"), "utf8"),
    );
    publicKey = readFileSync(
      path.join(root, "platform-attestor-public.pem"),
      "utf8",
    );
  } catch {
    fail("execution-plane attestation document/public key is missing or invalid");
  }
  const comparisons = {
    planeId: "EXTERNAL_SANDBOX_EXECUTION_PLANE_ID",
    trustDomain: "EXTERNAL_SANDBOX_EXECUTION_PLANE_TRUST_DOMAIN",
    runnerId: "EXTERNAL_SANDBOX_RUNNER_ID",
    runnerBuildId: "EXTERNAL_SANDBOX_RUNNER_BUILD_ID",
    runtimeImageDigest: "EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST",
    controlHostIdentityHash: "EXTERNAL_SANDBOX_CONTROL_HOST_IDENTITY_HASH",
    workloadHostIdentityHash: "EXTERNAL_SANDBOX_WORKLOAD_HOST_IDENTITY_HASH",
    dockerDaemonIdentityHash: "EXTERNAL_SANDBOX_DOCKER_DAEMON_IDENTITY_HASH",
    attestorKeyId: "EXTERNAL_SANDBOX_PLATFORM_ATTESTOR_KEY_ID",
  };
  for (const [field, envName] of Object.entries(comparisons)) {
    if (document[field] !== required(env, envName)) {
      fail(`execution-plane attestation ${field} does not match ${envName}`);
    }
  }
  if (
    document.schema
      !== "agent-factory-sandbox-execution-plane-attestation/v1"
    || document.isolationTier !== "remote_vm"
    || document.signatureAlgorithm !== "ed25519"
  ) {
    fail("execution-plane attestation schema/isolation/signature is invalid");
  }
  for (const name of [
    "EXTERNAL_SANDBOX_PRIMARY_HOST_IDENTITY_HASH",
    "EXTERNAL_SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH",
    "EXTERNAL_SANDBOX_CONTROL_HOST_IDENTITY_HASH",
    "EXTERNAL_SANDBOX_WORKLOAD_HOST_IDENTITY_HASH",
    "EXTERNAL_SANDBOX_DOCKER_DAEMON_IDENTITY_HASH",
  ]) {
    if (!IDENTITY_HASH.test(env[name] ?? "")) {
      fail(`${name} must be a domain-separated sha256:<64 hex> identity`);
    }
  }
  if (
    env.EXTERNAL_SANDBOX_PRIMARY_HOST_IDENTITY_HASH
      === document.controlHostIdentityHash
    || env.EXTERNAL_SANDBOX_PRIMARY_HOST_IDENTITY_HASH
      === document.workloadHostIdentityHash
  ) fail("signed execution plane shares the primary host identity");
  if (
    env.EXTERNAL_SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH
      === document.dockerDaemonIdentityHash
  ) fail("signed execution plane shares the primary Docker daemon identity");
  const {
    attestationHash,
    signature,
    ...body
  } = document;
  const expectedHash =
    `sandbox-execution-plane:v1:${createHash("sha256")
      .update(canonical(body), "utf8")
      .digest("hex")}`;
  if (attestationHash !== expectedHash) {
    fail("execution-plane attestation hash is invalid");
  }
  try {
    if (
      !verifySignature(
        null,
        Buffer.from(canonical({ ...body, attestationHash }), "utf8"),
        publicKey,
        Buffer.from(String(signature ?? ""), "base64url"),
      )
    ) fail("execution-plane attestor signature is invalid");
  } catch (error) {
    if (error instanceof ExternalSandboxConfigError) throw error;
    fail("execution-plane attestor signature/public key is invalid");
  }
  const issuedAt = Date.parse(document.issuedAt);
  const expiresAt = Date.parse(document.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
    || expiresAt <= issuedAt
  ) fail("execution-plane attestation is expired or malformed");
}

function exactHttpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be an absolute HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) fail(`${name} must be a credential-free HTTPS origin with no path`);
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "api"
    || hostname === "sandbox-runner"
    || hostname === "localhost"
    || hostname === "host.docker.internal"
    || hostname === "127.0.0.1"
    || hostname === "::1"
  ) fail(`${name} must not use a local or primary Compose service hostname`);
  return parsed.origin;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateSecrets(rootInput, secretGid) {
  if (!path.isAbsolute(rootInput)) fail("EXTERNAL_SANDBOX_SECRET_ROOT must be absolute");
  let root;
  try {
    root = realpathSync(rootInput);
    const rootInfo = statSync(root);
    if (
      !rootInfo.isDirectory()
      || rootInfo.gid !== secretGid
      || (rootInfo.mode & 0o050) !== 0o050
      || (rootInfo.mode & 0o027) !== 0
    ) {
      fail("EXTERNAL_SANDBOX_SECRET_ROOT must be group-owned by EXTERNAL_SANDBOX_SECRET_GID and mode 0750");
    }
  } catch (error) {
    if (error instanceof ExternalSandboxConfigError) throw error;
    fail("EXTERNAL_SANDBOX_SECRET_ROOT is not a readable directory");
  }

  const values = new Map();
  for (const [relative, kind] of SECRET_FILES) {
    const requested = path.join(root, relative);
    let resolved;
    let info;
    let value;
    try {
      resolved = realpathSync(requested);
      info = statSync(resolved);
      value = readFileSync(resolved, "utf8").trim();
    } catch {
      fail(`required secret file is missing: ${relative}`);
    }
    if (!inside(root, resolved) || !info.isFile()) {
      fail(`secret file must resolve inside the secret root: ${relative}`);
    }
    if (
      info.gid !== secretGid
      || (info.mode & 0o040) !== 0o040
      || (info.mode & 0o027) !== 0
    ) {
      fail(`secret file must be group-readable only by EXTERNAL_SANDBOX_SECRET_GID: ${relative}`);
    }
    if (Buffer.byteLength(value, "utf8") < 32 || Buffer.byteLength(value, "utf8") > 16_384) {
      fail(`secret file is empty, weak, or too large: ${relative}`);
    }
    if (PLACEHOLDER.test(value)) fail(`secret file contains a placeholder: ${relative}`);
    if (kind === "hex" && (!/^[a-f0-9]+$/i.test(value) || value.length < 32)) {
      fail(`secret file must contain hexadecimal key material: ${relative}`);
    }
    values.set(relative, value);
  }

  const redisPassword = values.get("remote-only/redis-password");
  const expectedAcl = `user default on >${redisPassword} ~* &* +@all`;
  if (values.get("remote-only/redis-acl") !== expectedAcl) {
    fail("remote-only/redis-acl does not match the mounted Redis password");
  }

  const comparable = [...values.entries()]
    .filter(([name]) => name !== "remote-only/redis-acl");
  if (new Set(comparable.map(([, value]) => value)).size !== comparable.length) {
    fail("each external sandbox secret purpose must use distinct key material");
  }
}

export function validateExternalSandboxConfiguration({ env, hostMachineId }) {
  for (const name of REQUIRED) required(env, name);
  for (const name of FORBIDDEN_DIRECT_SECRETS) {
    if (env[name]?.trim()) fail(`${name} must not contain a direct secret value`);
  }
  validatePlatformAttestation(env);

  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/.test(env.EXTERNAL_SANDBOX_COMPOSE_PROJECT)) {
    fail("EXTERNAL_SANDBOX_COMPOSE_PROJECT is invalid");
  }
  if (env.EXTERNAL_SANDBOX_IMAGE_PULL_POLICY !== "never") {
    fail("EXTERNAL_SANDBOX_IMAGE_PULL_POLICY must be never after digest-pinned images are preloaded");
  }
  if (!["host_reverse_proxy", "vpn_reverse_proxy"].includes(env.EXTERNAL_SANDBOX_TLS_TERMINATION)) {
    fail("EXTERNAL_SANDBOX_TLS_TERMINATION must confirm an existing host/VPN TLS reverse proxy");
  }
  if ((env.EXTERNAL_SANDBOX_CONTROL_BIND_ADDRESS ?? "127.0.0.1") !== "127.0.0.1") {
    fail("external sandbox control may bind only to 127.0.0.1");
  }
  const port = Number(env.EXTERNAL_SANDBOX_CONTROL_LOOPBACK_PORT ?? "3560");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    fail("EXTERNAL_SANDBOX_CONTROL_LOOPBACK_PORT must be an unprivileged TCP port");
  }

  const publicRunner = exactHttpsOrigin(
    env.EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN,
    "EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN",
  );
  const modelProxy = exactHttpsOrigin(
    env.EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN,
    "EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN",
  );
  if (publicRunner === modelProxy) {
    fail("runner ingress and primary model proxy must not share an origin");
  }

  const expectedHost = env.EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256;
  const primaryHost = env.EXTERNAL_SANDBOX_PRIMARY_HOST_ID_SHA256;
  if (!SHA256.test(expectedHost) || !SHA256.test(primaryHost)) {
    fail("remote and primary host identity hashes must be lowercase SHA-256");
  }
  if (expectedHost === primaryHost) {
    fail("external sandbox host identity equals the primary host identity");
  }
  if (machineIdSha256(hostMachineId) !== expectedHost) {
    fail("current machine-id does not match EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256");
  }

  for (const name of [
    "EXTERNAL_SANDBOX_KEY_ID",
    "EXTERNAL_SANDBOX_RUNNER_ID",
    "EXTERNAL_SANDBOX_RUNNER_BUILD_ID",
  ]) {
    if (!ID.test(env[name])) fail(`${name} has an invalid identity format`);
  }
  if (!OCI_DIGEST.test(env.EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST)) {
    fail("EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST must be lowercase sha256:<64 hex>");
  }

  const images = [
    "EXTERNAL_SANDBOX_CONTROL_IMAGE",
    "EXTERNAL_SANDBOX_WORKLOAD_IMAGE",
    "EXTERNAL_SANDBOX_GATEWAY_IMAGE",
    "EXTERNAL_SANDBOX_CANDIDATE_IMAGE",
    "EXTERNAL_SANDBOX_INNGEST_IMAGE",
    "EXTERNAL_SANDBOX_POSTGRES_IMAGE",
    "EXTERNAL_SANDBOX_REDIS_IMAGE",
  ].map((name) => {
    const value = env[name];
    if (!PINNED_IMAGE.test(value)) fail(`${name} must be repository@sha256:<64 lowercase hex>`);
    if (/@sha256:0{64}$/.test(value)) fail(`${name} still contains a zero placeholder digest`);
    return value;
  });
  if (new Set(images).size !== images.length) {
    fail("external sandbox service roles must not reuse one image identity");
  }
  const workloadDigest = `sha256:${env.EXTERNAL_SANDBOX_WORKLOAD_IMAGE.split("@sha256:")[1] ?? ""}`;
  if (env.EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST !== workloadDigest) {
    fail("EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST must equal the pinned workload OCI digest");
  }
  let candidateAllowlist;
  try {
    candidateAllowlist = JSON.parse(env.EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST);
  } catch {
    fail("EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST must be JSON");
  }
  if (
    !Array.isArray(candidateAllowlist)
    || candidateAllowlist.length !== 1
    || candidateAllowlist[0] !== env.EXTERNAL_SANDBOX_CANDIDATE_IMAGE
  ) fail("candidate image allowlist must contain exactly the pinned candidate image");

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(env.EXTERNAL_SANDBOX_APP_PREFIX)) {
    fail("EXTERNAL_SANDBOX_APP_PREFIX is invalid");
  }
  if (!path.isAbsolute(env.EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH)) {
    fail("EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH must be absolute");
  }
  const socketGid = Number(env.EXTERNAL_SANDBOX_DOCKER_SOCKET_GID);
  if (!Number.isSafeInteger(socketGid) || socketGid <= 0 || socketGid > 2_147_483_647) {
    fail("EXTERNAL_SANDBOX_DOCKER_SOCKET_GID must be a non-root numeric group id");
  }
  const secretGid = Number(env.EXTERNAL_SANDBOX_SECRET_GID);
  if (!Number.isSafeInteger(secretGid) || secretGid <= 0 || secretGid > 2_147_483_647) {
    fail("EXTERNAL_SANDBOX_SECRET_GID must be a non-root numeric group id");
  }
  if (secretGid === socketGid) {
    fail("secret-reader group and Docker socket group must be different capabilities");
  }

  validateSecrets(env.EXTERNAL_SANDBOX_SECRET_ROOT, secretGid);
  return {
    publicRunnerOrigin: publicRunner,
    modelProxyOrigin: modelProxy,
    runtimeImageDigest: env.EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST,
  };
}

export function parseEnvFile(text) {
  const output = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail(`invalid env file line ${index + 1}`);
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`invalid env name on line ${index + 1}`);
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        fail(`invalid quoted env value on line ${index + 1}`);
      }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) fail(`invalid quoted env value on line ${index + 1}`);
      value = value.slice(1, -1);
    }
    output[name] = value;
  }
  return output;
}

function cliArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function validateHostResources(env) {
  try {
    if (!statSync(env.EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH).isSocket()) {
      fail("EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH is not a Unix socket");
    }
  } catch (error) {
    if (error instanceof ExternalSandboxConfigError) throw error;
    fail("EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH is not readable on this VM");
  }
}

function validatePinnedImagesPresent(env) {
  for (const name of [
    "EXTERNAL_SANDBOX_CONTROL_IMAGE",
    "EXTERNAL_SANDBOX_WORKLOAD_IMAGE",
    "EXTERNAL_SANDBOX_GATEWAY_IMAGE",
    "EXTERNAL_SANDBOX_CANDIDATE_IMAGE",
    "EXTERNAL_SANDBOX_INNGEST_IMAGE",
    "EXTERNAL_SANDBOX_POSTGRES_IMAGE",
    "EXTERNAL_SANDBOX_REDIS_IMAGE",
  ]) {
    const image = env[name];
    const result = spawnSync(
      "docker",
      ["image", "inspect", image, "--format", "{{json .RepoDigests}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    let repoDigests;
    try {
      repoDigests = result.status === 0 ? JSON.parse(result.stdout.trim()) : undefined;
    } catch {
      repoDigests = undefined;
    }
    if (!Array.isArray(repoDigests) || !repoDigests.includes(image)) {
      fail(`${name} is not preloaded under its exact repository@sha256 identity`);
    }
  }
}

function runComposeConfig(envFile, env) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      DEFAULT_COMPOSE,
      "-f",
      DEFAULT_INGRESS,
      "config",
      "--quiet",
    ],
    {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  if (result.error || result.status !== 0) {
    // Never replay Compose stderr: configuration errors can include expanded
    // environment values on some Docker versions.
    fail("docker compose config --quiet failed (output suppressed to protect configuration data)");
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.includes("--print-host-id")) {
      const source = cliArgument("--host-id-file", "/etc/machine-id");
      process.stdout.write(`${machineIdSha256(readFileSync(source, "utf8"))}\n`);
      process.exit(0);
    }
    const envFile = path.resolve(cliArgument("--env-file", ""));
    if (!envFile || envFile === path.resolve("")) {
      fail("--env-file /absolute/path/to/.env.external is required");
    }
    const parsed = parseEnvFile(readFileSync(envFile, "utf8"));
    const env = { ...parsed };
    for (const name of [...REQUIRED, ...FORBIDDEN_DIRECT_SECRETS, "EXTERNAL_SANDBOX_IMAGE_PULL_POLICY", "EXTERNAL_SANDBOX_CONTROL_BIND_ADDRESS", "EXTERNAL_SANDBOX_CONTROL_LOOPBACK_PORT", "EXTERNAL_SANDBOX_HOST_ID_SOURCE_FILE"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const hostIdFile = env.EXTERNAL_SANDBOX_HOST_ID_SOURCE_FILE || "/etc/machine-id";
    validateExternalSandboxConfiguration({
      env,
      hostMachineId: readFileSync(hostIdFile, "utf8"),
    });
    validateHostResources(env);
    validatePinnedImagesPresent(env);
    runComposeConfig(envFile, env);
    process.stdout.write("external sandbox configuration validated; no services were started\n");
  } catch (error) {
    process.stderr.write(`external sandbox validation failed: ${error?.message ?? "unknown error"}\n`);
    process.exitCode = 1;
  }
}
