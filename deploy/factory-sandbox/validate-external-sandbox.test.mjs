import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ExternalSandboxConfigError,
  machineIdSha256,
  validateExternalSandboxConfiguration,
} from "./validate-external-sandbox.mjs";
import {
  identityHash,
  signExecutionPlaneAttestation,
} from "./sign-execution-plane-attestation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.join(HERE, "compose.external.yml");
const INGRESS = path.join(HERE, "compose.external-loopback.yml");
const PRIMARY_CONNECTOR = path.join(HERE, "compose.primary-external-connection.yml");
const INIT_SECRETS = path.join(HERE, "init-secrets.mjs");
const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const SECRET_GID = process.getgid() === 0 ? 1999 : process.getgid();

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function pinned(name, character) {
  return `registry.internal/agentic/${name}@${digest(character)}`;
}

function writeSecret(root, relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  chmodSync(path.dirname(file), 0o750);
  if (process.getgid() === 0) chownSync(path.dirname(file), -1, SECRET_GID);
  writeFileSync(file, `${value}\n`, { mode: 0o640 });
  chmodSync(file, 0o640);
  if (process.getgid() === 0) chownSync(file, -1, SECRET_GID);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentic-external-sandbox-"));
  chmodSync(root, 0o750);
  if (process.getgid() === 0) chownSync(root, -1, SECRET_GID);
  const secretValues = new Map();
  let index = 1;
  for (const relative of [
    "shared-with-primary/request-hmac",
    "shared-with-primary/result-hmac",
    "shared-with-primary/receipt-hmac",
    "shared-with-primary/model-proxy-token",
    "remote-only/workload-token",
    "remote-only/control-bearer",
    "remote-only/cancel-fence-hmac",
    "remote-only/gateway-tombstone-hmac",
    "remote-only/event-key",
    "remote-only/signing-key",
    "remote-only/postgres-password",
    "remote-only/redis-password",
  ]) {
    const value = createHash("sha256").update(`secret-${index++}`).digest("hex");
    secretValues.set(relative, value);
    writeSecret(root, relative, value);
  }
  writeSecret(
    root,
    "remote-only/redis-acl",
    `user default on >${secretValues.get("remote-only/redis-password")} ~* &* +@all`,
  );

  const candidate = pinned("candidate", "4");
  const attestationRoot = mkdtempSync(
    path.join(tmpdir(), "agentic-external-attestation-"),
  );
  const remoteHostIdentityHash = identityHash("host", MACHINE_ID);
  const remoteDaemonIdentityHash = identityHash(
    "docker-daemon",
    "remote-daemon-test-id",
  );
  const primaryHostIdentityHash = identityHash(
    "host",
    "primary-host-test-id",
  );
  const primaryDaemonIdentityHash = identityHash(
    "docker-daemon",
    "primary-daemon-test-id",
  );
  const env = {
    EXTERNAL_SANDBOX_COMPOSE_PROJECT: "agentic_factory_remote",
    EXTERNAL_SANDBOX_IMAGE_PULL_POLICY: "never",
    EXTERNAL_SANDBOX_TLS_TERMINATION: "host_reverse_proxy",
    EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN: "https://sandbox.internal.company",
    EXTERNAL_SANDBOX_CONTROL_BIND_ADDRESS: "127.0.0.1",
    EXTERNAL_SANDBOX_CONTROL_LOOPBACK_PORT: "3560",
    EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN: "https://operator.internal.company",
    EXTERNAL_SANDBOX_HOST_ID_SOURCE_FILE: "/etc/machine-id",
    EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256: machineIdSha256(MACHINE_ID),
    EXTERNAL_SANDBOX_PRIMARY_HOST_ID_SHA256: "f".repeat(64),
    EXTERNAL_SANDBOX_ATTESTATION_ROOT: attestationRoot,
    EXTERNAL_SANDBOX_EXECUTION_PLANE_ID: "test-execution-plane",
    EXTERNAL_SANDBOX_EXECUTION_PLANE_TRUST_DOMAIN:
      "sandbox.test.internal",
    EXTERNAL_SANDBOX_PLATFORM_ATTESTOR_KEY_ID: "platform-key-test",
    EXTERNAL_SANDBOX_PRIMARY_HOST_IDENTITY_HASH:
      primaryHostIdentityHash,
    EXTERNAL_SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH:
      primaryDaemonIdentityHash,
    EXTERNAL_SANDBOX_CONTROL_HOST_IDENTITY_HASH:
      remoteHostIdentityHash,
    EXTERNAL_SANDBOX_WORKLOAD_HOST_IDENTITY_HASH:
      remoteHostIdentityHash,
    EXTERNAL_SANDBOX_DOCKER_DAEMON_IDENTITY_HASH:
      remoteDaemonIdentityHash,
    EXTERNAL_SANDBOX_SECRET_ROOT: root,
    EXTERNAL_SANDBOX_SECRET_GID: String(SECRET_GID),
    EXTERNAL_SANDBOX_DOCKER_SOCKET_PATH: "/var/run/docker.sock",
    EXTERNAL_SANDBOX_DOCKER_SOCKET_GID: "999",
    EXTERNAL_SANDBOX_KEY_ID: "remote-key-v1",
    EXTERNAL_SANDBOX_RUNNER_ID: "remote-runner-v1",
    EXTERNAL_SANDBOX_RUNNER_BUILD_ID: "build-20260716-a1",
    EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST: digest("2"),
    EXTERNAL_SANDBOX_APP_PREFIX: "agentic-factory-sandbox",
    EXTERNAL_SANDBOX_CONTROL_IMAGE: pinned("control", "1"),
    EXTERNAL_SANDBOX_WORKLOAD_IMAGE: pinned("workload", "2"),
    EXTERNAL_SANDBOX_GATEWAY_IMAGE: pinned("gateway", "3"),
    EXTERNAL_SANDBOX_CANDIDATE_IMAGE: candidate,
    EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST: JSON.stringify([candidate]),
    EXTERNAL_SANDBOX_INNGEST_IMAGE: pinned("inngest", "5"),
    EXTERNAL_SANDBOX_POSTGRES_IMAGE: pinned("postgres", "6"),
    EXTERNAL_SANDBOX_REDIS_IMAGE: pinned("redis", "7"),
  };
  const keys = generateKeyPairSync("ed25519");
  const attestation = signExecutionPlaneAttestation(
    {
      planeId: env.EXTERNAL_SANDBOX_EXECUTION_PLANE_ID,
      trustDomain: env.EXTERNAL_SANDBOX_EXECUTION_PLANE_TRUST_DOMAIN,
      runnerId: env.EXTERNAL_SANDBOX_RUNNER_ID,
      runnerBuildId: env.EXTERNAL_SANDBOX_RUNNER_BUILD_ID,
      runtimeImageDigest: env.EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST,
      isolationTier: "remote_vm",
      controlHostIdentityHash: remoteHostIdentityHash,
      workloadHostIdentityHash: remoteHostIdentityHash,
      dockerDaemonIdentityHash: remoteDaemonIdentityHash,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      attestorKeyId: env.EXTERNAL_SANDBOX_PLATFORM_ATTESTOR_KEY_ID,
    },
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  writeFileSync(
    path.join(attestationRoot, "execution-plane.json"),
    `${JSON.stringify(attestation)}\n`,
    { mode: 0o644 },
  );
  writeFileSync(
    path.join(attestationRoot, "platform-attestor-public.pem"),
    keys.publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o644 },
  );
  return { env, root };
}

function expectConfigError(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ExternalSandboxConfigError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("accepts a fully pinned independent-VM configuration", () => {
  const { env } = fixture();
  const result = validateExternalSandboxConfiguration({ env, hostMachineId: MACHINE_ID });
  assert.equal(result.publicRunnerOrigin, env.EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN);
  assert.equal(result.modelProxyOrigin, env.EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN);
});

test("rejects same-host isolation and a machine-id mismatch", () => {
  const { env } = fixture();
  env.EXTERNAL_SANDBOX_PRIMARY_HOST_ID_SHA256 = env.EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256;
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env, hostMachineId: MACHINE_ID }),
    /equals the primary host/,
  );

  const second = fixture();
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: second.env, hostMachineId: "abcdefabcdefabcdefabcdefabcdefab" }),
    /does not match/,
  );
});

test("rejects a shared primary daemon and a tampered platform attestation", () => {
  const first = fixture();
  first.env.EXTERNAL_SANDBOX_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH =
    first.env.EXTERNAL_SANDBOX_DOCKER_DAEMON_IDENTITY_HASH;
  expectConfigError(
    () => validateExternalSandboxConfiguration({
      env: first.env,
      hostMachineId: MACHINE_ID,
    }),
    /shares the primary Docker daemon/,
  );

  const second = fixture();
  const documentFile = path.join(
    second.env.EXTERNAL_SANDBOX_ATTESTATION_ROOT,
    "execution-plane.json",
  );
  const document = JSON.parse(readFileSync(documentFile, "utf8"));
  document.trustDomain = "tampered.invalid";
  writeFileSync(documentFile, JSON.stringify(document), { mode: 0o644 });
  expectConfigError(
    () => validateExternalSandboxConfiguration({
      env: second.env,
      hostMachineId: MACHINE_ID,
    }),
    /does not match|hash is invalid|signature is invalid/,
  );
});

test("requires HTTPS origins and loopback-only runner ingress", () => {
  const first = fixture();
  first.env.EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN = "http://api:3501";
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: first.env, hostMachineId: MACHINE_ID }),
    /HTTPS origin/,
  );

  const second = fixture();
  second.env.EXTERNAL_SANDBOX_CONTROL_BIND_ADDRESS = "0.0.0.0";
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: second.env, hostMachineId: MACHINE_ID }),
    /bind only to 127\.0\.0\.1/,
  );
});

test("rejects mutable/placeholder images and a broader candidate allowlist", () => {
  const first = fixture();
  first.env.EXTERNAL_SANDBOX_CONTROL_IMAGE = "registry.internal/control:latest";
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: first.env, hostMachineId: MACHINE_ID }),
    /repository@sha256/,
  );

  const placeholder = fixture();
  placeholder.env.EXTERNAL_SANDBOX_CONTROL_IMAGE = pinned("control", "0");
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: placeholder.env, hostMachineId: MACHINE_ID }),
    /zero placeholder digest/,
  );

  const second = fixture();
  second.env.EXTERNAL_SANDBOX_CANDIDATE_IMAGE_ALLOWLIST = JSON.stringify([
    second.env.EXTERNAL_SANDBOX_CANDIDATE_IMAGE,
    pinned("candidate-two", "8"),
  ]);
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: second.env, hostMachineId: MACHINE_ID }),
    /exactly the pinned candidate/,
  );
});

test("binds the signed runtime digest to the exact workload OCI digest", () => {
  const { env } = fixture();
  env.EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST = digest("a");
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env, hostMachineId: MACHINE_ID }),
    /runtimeImageDigest does not match|must equal the pinned workload OCI digest/,
  );
});

test("rejects direct secret values and permissive secret files", () => {
  const first = fixture();
  first.env.SANDBOX_WORKLOAD_TOKEN = "x".repeat(64);
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: first.env, hostMachineId: MACHINE_ID }),
    /must not contain a direct secret/,
  );

  const second = fixture();
  chmodSync(path.join(second.root, "remote-only/workload-token"), 0o644);
  expectConfigError(
    () => validateExternalSandboxConfiguration({ env: second.env, hostMachineId: MACHINE_ID }),
    /group-readable only/,
  );
});

test("standalone stack has no primary service dependency and no default published port", () => {
  const compose = readFileSync(COMPOSE, "utf8");
  const ingress = readFileSync(INGRESS, "utf8");
  assert.doesNotMatch(compose, /^\s{2}api:/m);
  assert.doesNotMatch(compose, /http:\/\/api(?::|\/)/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.doesNotMatch(compose, /agentic-(?:data|models|runtime)/);
  assert.match(compose, /SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER: remote_vm/);
  assert.match(compose, /EXTERNAL_SANDBOX_MODEL_PROXY_ORIGIN/);
  assert.match(ingress, /host_ip: "\$\{EXTERNAL_SANDBOX_CONTROL_BIND_ADDRESS:-127\.0\.0\.1\}"/);
});

test("primary connector uses exact external runner identity and a distinct receipt key", () => {
  const connector = readFileSync(PRIMARY_CONNECTOR, "utf8");
  assert.match(connector, /FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: external_sandbox/);
  assert.match(connector, /receiptSigningKeyEnv/);
  assert.match(connector, /FACTORY_SB_RECEIPT_HMAC_FILE: \/run\/secrets\/factory-sandbox\/receipt-hmac/);
  assert.match(connector, /FACTORY_SB_RUNNER_URL: "\$\{EXTERNAL_SANDBOX_PUBLIC_RUNNER_ORIGIN:/);
  assert.match(connector, /FACTORY_SB_ALLOWED_BUILD_IDS: '\["\$\{EXTERNAL_SANDBOX_RUNNER_BUILD_ID:/);
  assert.match(connector, /FACTORY_SB_ALLOWED_IMAGE_DIGESTS: '\["\$\{EXTERNAL_SANDBOX_RUNTIME_IMAGE_DIGEST:/);
  assert.match(connector, /FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: ""/);
  assert.match(connector, /platformAttestorPublicKeyEnv/);
  assert.match(connector, /primaryDockerDaemonIdentityHashEnv/);
});

test("secret initializer is idempotent, group-scoped, and never prints key values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentic-external-secret-init-"));
  const args = [
    INIT_SECRETS,
    "--secret-root",
    root,
    "--secret-gid",
    String(SECRET_GID),
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /generated=13, preserved=0/);
  const requestFile = path.join(root, "shared-with-primary/request-hmac");
  const requestSecret = readFileSync(requestFile, "utf8").trim();
  assert.ok(requestSecret.length >= 64);
  assert.doesNotMatch(first.stdout, new RegExp(requestSecret));
  assert.equal(statSync(requestFile).mode & 0o777, 0o640);
  assert.equal(statSync(requestFile).gid, SECRET_GID);

  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /generated=0, preserved=13/);
  assert.equal(readFileSync(requestFile, "utf8").trim(), requestSecret);
  assert.doesNotMatch(second.stdout, new RegExp(requestSecret));
});

test("docker compose config --quiet accepts the valid fixture without stdout", {
  skip: spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0,
}, () => {
  const { env, root } = fixture();
  const envFile = path.join(root, "external.env");
  writeFileSync(
    envFile,
    `${Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", envFile, "-f", COMPOSE, "-f", INGRESS, "config", "--quiet"],
    { cwd: HERE, encoding: "utf8" },
  );
  assert.equal(result.stdout, "");
  assert.equal(result.status, 0, "docker compose config --quiet rejected the standalone stack");
});
