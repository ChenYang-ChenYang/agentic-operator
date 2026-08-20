import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireProductionSetupLock,
  assertDatabaseInspectionHealthy,
  assertNoHostDatabaseUsers,
  assertNoRunningDockerDatabaseMounts,
  assertProductionSetupSafety,
  copyRuntimeSettings,
  createProductionSetupExecution,
  ensureProductionImageAttestationKeyPair,
  finalizeBindSecretPermissions,
  parseOpenDatabaseFiles,
  persistentIntegritySecret,
  resolveProductionSandboxDeployment,
  runWithStableSourceFingerprint,
  type CommandObserver,
  validHexSecret,
  writeDerivedSecretFile,
} from "../scripts/setup-factory-production";
import {
  assertFactoryProductionImageAttestation,
  expectedProductionImages,
  productionImageAttestationKeyId,
  signFactoryProductionImageAttestation,
  verifyProductionImageObservation,
} from "../scripts/verify-factory-production-images";
import {
  encodeProductionEnvLine,
  parseProductionEnvText,
} from "../scripts/production-env-file";
import {
  acquireSqliteWriterLease,
  sqliteWriterLeasePath,
} from "../../../packages/db/src/writer-lease";

const roots: string[] = [];
const repoRoot = path.resolve(process.cwd(), "../..");

afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("factory production setup contract", () => {
  const image = (digit: string) => `sha256:${digit.repeat(64)}`;
  const imageEnv = () => ({
    FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "single_host_compose",
    AGENTIC_BUILD_ID: "local-build-1",
    AGENTIC_API_IMAGE: image("1"),
    AGENTIC_WEB_IMAGE: image("2"),
    FACTORY_SANDBOX_CONTROL_IMAGE: image("3"),
    FACTORY_SANDBOX_WORKLOAD_IMAGE: image("4"),
    FACTORY_SANDBOX_GATEWAY_IMAGE: image("5"),
    PRODUCTION_CODEACT_EXECUTOR_IMAGE: image("6"),
    FACTORY_CODEACT_CANDIDATE_IMAGE: image("7"),
    FACTORY_SB_RUNTIME_IMAGE_DIGEST: image("4"),
    FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["local-build-1"]),
    FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([image("4")]),
    FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS: JSON.stringify([image("7")]),
    PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS: JSON.stringify([image("7")]),
    PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS: JSON.stringify([image("7")]),
  });

  it("keeps same-host Compose diagnostic by default without inventing external identities", () => {
    expect(resolveProductionSandboxDeployment({
      ambient: {},
      source: {},
      previous: {},
      localBuildId: "local-build-1",
      localWorkloadDigest: image("4"),
      fingerprint: "fixture",
    })).toMatchObject({
      topology: "single_host_compose",
      runnerUrl: "http://sandbox-runner:3560",
      keyId: "factory-sandbox-fixture",
      allowedBuildIds: JSON.stringify(["local-build-1"]),
      allowedImageDigests: JSON.stringify([image("4")]),
    });
  });

  it("aborts when a long image build observes a changed source fingerprint", async () => {
    let fingerprint = "source-v1";
    let buildCompleted = false;
    await expect(runWithStableSourceFingerprint({
      expected: "source-v1",
      phase: "sandbox workload image build",
      operation: async () => {
        buildCompleted = true;
        fingerprint = "source-v2";
        return "sha256:image";
      },
      observeFingerprint: async () => fingerprint,
    })).rejects.toThrow(/source changed during sandbox workload image build/);
    expect(buildCompleted).toBe(true);
  });

  it("requires exact independently supplied remote identities for external_sandbox", () => {
    const remoteImage = image("8");
    const config = resolveProductionSandboxDeployment({
      ambient: {},
      source: {
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "external_sandbox",
        FACTORY_SB_RUNNER_URL: "https://factory-sandbox.example.test/control/",
        FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS: "factory-sandbox.example.test",
        FACTORY_SB_KEY_ID: "external-key-v3",
        FACTORY_SB_RUNNER_ID: "external-runner-v3",
        FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["remote-build-v3"]),
        FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([remoteImage]),
        // 证明校验所需的完整引用。少任何一项，主平面就整体拒绝远程沙箱配置
        // （/health 报 sandbox_runner_unreachable_or_misconfigured），所以
        // setup 必须要求运维显式提供，而不是发明一个身份。
        FACTORY_SB_EXECUTION_PLANE_ID: "external-plane-v3",
        FACTORY_SB_EXECUTION_PLANE_TRUST_DOMAIN: "external-trust-v3",
        FACTORY_SB_PLATFORM_ATTESTOR_KEY_ID: "external-attestor-v3",
        EXTERNAL_SANDBOX_ATTESTOR_PUBLIC_HOST_FILE: "/secure/attestor-public.pem",
        FACTORY_PRIMARY_HOST_IDENTITY_HASH: image("a"),
        FACTORY_PRIMARY_DOCKER_DAEMON_IDENTITY_HASH: image("b"),
        FACTORY_SB_ALLOWED_CONTROL_HOST_IDENTITY_HASHES: JSON.stringify([image("c")]),
        FACTORY_SB_ALLOWED_WORKLOAD_HOST_IDENTITY_HASHES: JSON.stringify([image("d")]),
        FACTORY_SB_ALLOWED_DOCKER_DAEMON_IDENTITY_HASHES: JSON.stringify([image("e")]),
        EXTERNAL_SANDBOX_VM_ADDRESS: "192.168.64.2",
        EXTERNAL_SANDBOX_CA_HOST_FILE: "/secure/ca.crt",
      },
      previous: {},
      localBuildId: "local-build-1",
      localWorkloadDigest: image("4"),
      fingerprint: "fixture",
    });
    expect(config).toEqual({
      topology: "external_sandbox",
      runnerUrl: "https://factory-sandbox.example.test/control",
      runnerHttpAllowedHosts: "factory-sandbox.example.test",
      keyId: "external-key-v3",
      runnerId: "external-runner-v3",
      allowedBuildIds: JSON.stringify(["remote-build-v3"]),
      allowedImageDigests: JSON.stringify([remoteImage]),
      runtimeImageDigest: remoteImage,
      executionPlaneId: "external-plane-v3",
      executionPlaneTrustDomain: "external-trust-v3",
      platformAttestorKeyId: "external-attestor-v3",
      platformAttestorPublicKeyFile:
        "/run/secrets/external-sandbox-attestor-public.pem",
      platformAttestorPublicHostFile: "/secure/attestor-public.pem",
      primaryHostIdentityHash: image("a"),
      primaryDockerDaemonIdentityHash: image("b"),
      allowedControlHostIdentityHashes: JSON.stringify([image("c")]),
      allowedWorkloadHostIdentityHashes: JSON.stringify([image("d")]),
      allowedDockerDaemonIdentityHashes: JSON.stringify([image("e")]),
      vmAddress: "192.168.64.2",
      caHostFile: "/secure/ca.crt",
    });

    expect(() => resolveProductionSandboxDeployment({
      ambient: {},
      source: {
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "external_sandbox",
        FACTORY_SB_RUNNER_URL: "http://remote-sandbox.example.test:3560",
        FACTORY_SB_KEY_ID: "external-key-v3",
        FACTORY_SB_RUNNER_ID: "external-runner-v3",
        FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["remote-build-v3", "fallback-build"]),
        FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([remoteImage]),
      },
      previous: {},
      localBuildId: "local-build-1",
      localWorkloadDigest: image("4"),
      fingerprint: "fixture",
    })).toThrow(/must use HTTPS/);

    expect(() => resolveProductionSandboxDeployment({
      ambient: {},
      source: {
        FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY: "external_sandbox",
        FACTORY_SB_RUNNER_URL: "https://factory-sandbox.example.test",
        FACTORY_SB_KEY_ID: "external-key-v3",
        FACTORY_SB_RUNNER_ID: "external-runner-v3",
        FACTORY_SB_ALLOWED_BUILD_IDS: JSON.stringify(["remote-build-v3", "fallback-build"]),
        FACTORY_SB_ALLOWED_IMAGE_DIGESTS: JSON.stringify([remoteImage]),
      },
      previous: {},
      localBuildId: "local-build-1",
      localWorkloadDigest: image("4"),
      fingerprint: "fixture",
    })).toThrow(/exactly one trusted identity/);
  });

  it("round-trips generated JSON values and rejects malformed quoted env input", () => {
    const values = {
      SIMPLE: "plain",
      JSON_ARRAY: JSON.stringify([image("a")]),
      JSON_OBJECT: JSON.stringify({ runnerUrlEnv: "FACTORY_SB_RUNNER_URL" }),
      ESCAPED: "quoted \"value\" with \\ path",
      EMPTY: "",
    };
    const encoded = Object.entries(values)
      .map(([name, value]) => encodeProductionEnvLine(name, value))
      .join("\n");

    expect(parseProductionEnvText(encoded)).toEqual(values);
    expect(parseProductionEnvText(String.raw`LITERAL='[\"not-decoded\"]'`))
      .toEqual({ LITERAL: String.raw`[\"not-decoded\"]` });
    expect(() => parseProductionEnvText('BROKEN="unterminated'))
      .toThrow(/malformed quoted value for BROKEN/);
    expect(() => parseProductionEnvText(String.raw`BROKEN="bad\q"`))
      .toThrow(/malformed quoted value for BROKEN/);
    expect(() => parseProductionEnvText("BROKEN='a'b'"))
      .toThrow(/malformed quoted value for BROKEN/);
  });

  it("binds readiness to observed image IDs even if diagnostic tags are rebound", () => {
    const keys = generateKeyPairSync("ed25519");
    const keyId = productionImageAttestationKeyId(keys.publicKey);
    const expected = expectedProductionImages({
      ...imageEnv(),
      DIAGNOSTIC_API_TAG: "attacker/rebound:latest",
    });
    const containers = expected.services.map((row, index) => ({
      service: row.service,
      containerId: `container-${index}`,
      configImage: row.imageId,
      imageId: row.imageId,
      status: "running",
      health: "healthy",
      buildId: expected.buildId,
      role: row.role,
    }));
    const body = verifyProductionImageObservation({
      expected,
      containers,
      candidate: {
        imageId: expected.candidateImageId,
        buildId: expected.buildId,
        role: "codeact-candidate",
      },
      keyId,
      now: new Date(0),
    });
    const attestation = signFactoryProductionImageAttestation(body, keys.privateKey);
    expect(attestation.services).toHaveLength(6);
    expect(attestation.candidate.imageId).toBe(image("7"));
    expect(() => assertFactoryProductionImageAttestation(
      attestation,
      expected,
      { publicKey: keys.publicKey, now: new Date(1), maxTtlMs: 5 * 60_000 },
    )).not.toThrow();
    expect(() => assertFactoryProductionImageAttestation(
      { ...attestation, buildId: "forged" },
      expected,
      { publicKey: keys.publicKey, now: new Date(1), maxTtlMs: 5 * 60_000 },
    )).toThrow(/hash is invalid|signature is invalid/);

    expect(() => verifyProductionImageObservation({
      expected,
      containers: containers.map((row) => row.service === "api"
        ? { ...row, configImage: image("8"), imageId: image("8") }
        : row),
      candidate: {
        imageId: expected.candidateImageId,
        buildId: expected.buildId,
        role: "codeact-candidate",
      },
      keyId,
    })).toThrow(/api is not running its configured immutable image ID/);
  });

  it.each([
    {
      name: "FACTORY_SB_ALLOWED_BUILD_IDS",
      expected: "local-build-1",
      additional: "attacker-build",
    },
    {
      name: "FACTORY_SB_ALLOWED_IMAGE_DIGESTS",
      expected: image("4"),
      additional: image("8"),
    },
    {
      name: "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS",
      expected: image("7"),
      additional: image("8"),
    },
    {
      name: "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS",
      expected: image("7"),
      additional: image("8"),
    },
    {
      name: "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS",
      expected: image("7"),
      additional: image("8"),
    },
  ])("rejects broadened or duplicate $name admission allowlists", ({ name, expected, additional }) => {
    expect(() => expectedProductionImages({
      ...imageEnv(),
      [name]: JSON.stringify([expected, additional]),
    })).toThrow(new RegExp(`${name} must contain exactly`));
    expect(() => expectedProductionImages({
      ...imageEnv(),
      [name]: JSON.stringify([expected, expected]),
    })).toThrow(new RegExp(`${name} must contain exactly`));
  });

  it("rejects weak or malformed persisted machine credentials", () => {
    expect(validHexSecret("a".repeat(64))).toBe(true);
    expect(validHexSecret("a".repeat(63))).toBe(false);
    expect(validHexSecret("not-a-hex-secret-that-is-merely-non-empty".repeat(2))).toBe(false);
    expect(validHexSecret("a".repeat(30))).toBe(false);
  });

  it("keeps durable integrity keys stable across repeated production setup", () => {
    const secretRoot = mkdtempSync(path.join(tmpdir(), "factory-production-integrity-"));
    roots.push(secretRoot);
    for (const [name, purpose] of [
      ["result-hmac", "sandbox result journal"],
      ["request-hmac", "sandbox request nonce ledger"],
      ["receipt-hmac", "sandbox execution receipts"],
    ] as const) {
      const filename = path.join(secretRoot, name);
      const first = persistentIntegritySecret(filename, purpose);
      const second = persistentIntegritySecret(filename, purpose);

      expect(validHexSecret(first)).toBe(true);
      expect(second).toBe(first);
    }
  });

  it("holds a token-safe setup lock and recovers one whose exact process owner died", () => {
    const lockRoot = mkdtempSync(path.join(tmpdir(), "factory-production-lock-"));
    roots.push(lockRoot);
    const lockPath = path.join(lockRoot, "setup.lock");
    const first = acquireProductionSetupLock(lockPath, {
      pid: 41,
      processIdentity: () => "test-process:41:first",
      ownerState: () => "active",
      startHeartbeat: false,
    });

    expect(() => acquireProductionSetupLock(lockPath, {
      pid: 42,
      processIdentity: () => "test-process:42",
      ownerState: () => "active",
      startHeartbeat: false,
    })).toThrow(/already running \(pid 41\)/);
    first.release();

    const crashed = acquireProductionSetupLock(lockPath, {
      pid: 43,
      processIdentity: () => "test-process:43:crashed",
      startHeartbeat: false,
    });
    const recovered = acquireProductionSetupLock(lockPath, {
      pid: 44,
      processIdentity: () => "test-process:44",
      ownerState: () => "dead",
      startHeartbeat: false,
    });
    expect(() => crashed.release()).toThrow(/non-owner/);
    recovered.heartbeat();
    recovered.release();
    expect(() => statSync(lockPath)).toThrow();
  });

  it("does not steal a recent incomplete setup lock", () => {
    const lockRoot = mkdtempSync(path.join(tmpdir(), "factory-production-lock-incomplete-"));
    roots.push(lockRoot);
    const lockPath = path.join(lockRoot, "setup.lock");
    mkdirSync(lockPath);
    writeFileSync(path.join(lockPath, "owner.json"), "not-json\n");

    expect(() => acquireProductionSetupLock(lockPath, {
      pid: 45,
      processIdentity: () => "test-process:45",
      incompleteGraceMs: 60_000,
      startHeartbeat: false,
    })).toThrow(/incomplete or malformed/);
  });

  it("aborts a long command on lock replacement and fences every later mutation phase", async () => {
    const lockRoot = mkdtempSync(path.join(tmpdir(), "factory-production-lock-loss-"));
    roots.push(lockRoot);
    const lockPath = path.join(lockRoot, "setup.lock");
    const started = path.join(lockRoot, "child-started");
    const terminated = path.join(lockRoot, "child-terminated");
    const lock = acquireProductionSetupLock(lockPath, {
      processIdentity: () => `test-process:${process.pid}:lock-loss`,
      heartbeatMs: 10,
    });
    const execution = createProductionSetupExecution(lock);
    const childScript = [
      'const fs = require("node:fs");',
      `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminated)}, "yes\\n"); process.exit(0); });`,
      `fs.writeFileSync(${JSON.stringify(started)}, "yes\\n");`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const running = execution.runCommand(
      process.execPath,
      ["-e", childScript],
      { capture: true },
    );
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 2_000 });

    const ownerFile = path.join(lockPath, "owner.json");
    const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(ownerFile, `${JSON.stringify({ ...owner, token: "b".repeat(64) })}\n`);

    await expect(running).rejects.toThrow(/ownership changed unexpectedly/);
    await vi.waitFor(() => expect(existsSync(terminated)).toBe(true), { timeout: 2_000 });
    expect(lock.signal.aborted).toBe(true);

    const mutations = { image: 0, secret: 0, env: 0 };
    for (const phase of Object.keys(mutations) as Array<keyof typeof mutations>) {
      expect(() => execution.mutate(phase, () => {
        mutations[phase] += 1;
      })).toThrow(/ownership changed unexpectedly/);
    }
    expect(mutations).toEqual({ image: 0, secret: 0, env: 0 });
    expect(() => lock.release()).toThrow(/ownership changed unexpectedly/);
  });

  it("keeps captured commands and mutation phases working while ownership is intact", async () => {
    const lockRoot = mkdtempSync(path.join(tmpdir(), "factory-production-lock-owned-"));
    roots.push(lockRoot);
    const lock = acquireProductionSetupLock(path.join(lockRoot, "setup.lock"), {
      processIdentity: () => `test-process:${process.pid}:owned`,
      startHeartbeat: false,
    });
    const execution = createProductionSetupExecution(lock);

    await expect(execution.runCommand(
      process.execPath,
      ["-e", 'process.stdout.write("captured-ok\\n")'],
      { capture: true },
    )).resolves.toBe("captured-ok");
    const mutations: string[] = [];
    for (const phase of ["image", "secret", "env"]) {
      execution.mutate(phase, () => mutations.push(phase));
    }
    expect(mutations).toEqual(["image", "secret", "env"]);
    expect(lock.signal.aborted).toBe(false);
    expect(() => lock.assertOwned()).not.toThrow();
    lock.release();
  });

  it("finds open database, WAL and deleted WAL descriptors without relying on current paths", () => {
    const database = "/srv/agentic/data/agentic.db";
    const output = [
      "p123",
      "cnode",
      "f19u",
      `n${database}-wal (deleted)`,
      "p456",
      "cdocker-api",
      "f7u",
      `n${database}`,
      "p789",
      "cunrelated",
      "f1u",
      `n${database}-backup`,
    ].join("\n");
    expect(parseOpenDatabaseFiles(output, database)).toEqual([
      {
        pid: "123",
        command: "node",
        descriptor: "19u",
        filename: "agentic.db-wal",
        canonicalPath: `${database}-wal`,
        deleted: true,
      },
      {
        pid: "456",
        command: "docker-api",
        descriptor: "7u",
        filename: "agentic.db",
        canonicalPath: database,
        deleted: false,
      },
    ]);
    expect(() => assertNoHostDatabaseUsers(database, () => ({
      status: 0,
      stdout: output,
      stderr: "",
    }))).toThrow(/pid=123 command=node file=agentic\.db-wal \(deleted\)/);
  });

  it("allows only WAL/SHM independently proven link-count-zero for the exact macOS Docker proxy", () => {
    const database = "/srv/agentic/data/agentic.db";
    const output = [
      "p80076",
      "ccom.apple.Virtualization.Virtua",
      "f21u",
      `n${database}-wal`,
      "f22u",
      `n${database}-shm`,
    ].join("\n");
    const calls: string[] = [];
    expect(() => assertNoHostDatabaseUsers(database, (_command, args) => {
      calls.push(args[0]!);
      return { status: 0, stdout: output, stderr: "" };
    }, {
      platform: "darwin",
      dockerMountInventoryVerified: true,
    })).not.toThrow();
    expect(calls).toEqual(["-nP", "+L1"]);
  });

  it("retains two descriptors for the same canonical WAL instead of collapsing evidence", () => {
    const database = "/srv/agentic/data/agentic.db";
    const rows = parseOpenDatabaseFiles([
      "p80076",
      "ccom.apple.Virtualization.Virtua",
      "f21u",
      `n${database}-wal`,
      "f22u",
      `n${database}-wal`,
    ].join("\n"), database);
    expect(rows.map((row) => row.descriptor)).toEqual(["21u", "22u"]);
  });

  it.each([
    {
      label: "non-macOS host",
      command: "com.apple.Virtualization.Virtua",
      suffix: "-wal (deleted)",
      platform: "linux" as const,
      dockerVerified: true,
    },
    {
      label: "live WAL",
      command: "com.apple.Virtualization.Virtua",
      suffix: "-wal",
      platform: "darwin" as const,
      dockerVerified: true,
    },
    {
      label: "deleted main database",
      command: "com.apple.Virtualization.Virtua",
      suffix: " (deleted)",
      platform: "darwin" as const,
      dockerVerified: true,
    },
    {
      label: "ordinary host writer",
      command: "node",
      suffix: "-wal (deleted)",
      platform: "darwin" as const,
      dockerVerified: true,
    },
    {
      label: "lookalike command",
      command: "com.apple.Virtualization.Virtua-helper",
      suffix: "-wal (deleted)",
      platform: "darwin" as const,
      dockerVerified: true,
    },
    {
      label: "missing Docker inventory proof",
      command: "com.apple.Virtualization.Virtua",
      suffix: "-wal (deleted)",
      platform: "darwin" as const,
      dockerVerified: false,
    },
  ])("keeps $label fail-closed", ({ command, suffix, platform, dockerVerified }) => {
    const database = "/srv/agentic/data/agentic.db";
    expect(() => assertNoHostDatabaseUsers(database, (_command, args) => ({
      status: 0,
      // A strict candidate receives an independent +L1 query; an empty result
      // proves that the full-inventory handle is not authorized as unlinked.
      stdout: args[0] === "+L1"
        ? ""
        : ["p80076", `c${command}`, "f21u", `n${database}${suffix}`].join("\n"),
      stderr: "",
    }), {
      platform,
      dockerMountInventoryVerified: dockerVerified,
    })).toThrow(/host process\(es\) still have/);
  });

  it.each([
    { label: "different PID", pid: "80077", command: "com.apple.Virtualization.Virtua", fd: "21u" },
    { label: "different command", pid: "80076", command: "com.apple.Virtualization.VirtualMachine", fd: "21u" },
    { label: "different descriptor", pid: "80076", command: "com.apple.Virtualization.Virtua", fd: "22u" },
    {
      label: "different canonical filename",
      pid: "80076",
      command: "com.apple.Virtualization.Virtua",
      fd: "21u",
      unlinkedDatabase: "/srv/other/agentic.db",
    },
  ])("rejects +L1 evidence with $label", ({ pid, command, fd, unlinkedDatabase }) => {
    const database = "/srv/agentic/data/agentic.db";
    const full = [
      "p80076",
      "ccom.apple.Virtualization.Virtua",
      "f21u",
      `n${database}-wal`,
    ].join("\n");
    const unlinked = [
      `p${pid}`,
      `c${command}`,
      `f${fd}`,
      `n${unlinkedDatabase ?? database}-wal`,
    ].join("\n");
    expect(() => assertNoHostDatabaseUsers(database, (_command, args) => ({
      status: 0,
      stdout: args[0] === "+L1" ? unlinked : full,
      stderr: "",
    }), {
      platform: "darwin",
      dockerMountInventoryVerified: true,
    })).toThrow(/host process\(es\) still have/);
  });

  it.each([
    { label: "non-zero exit", status: 1, stderr: "" },
    { label: "stderr warning", status: 0, stderr: "lsof warning" },
  ])("fails closed when +L1 has $label", ({ status, stderr }) => {
    const database = "/srv/agentic/data/agentic.db";
    const full = [
      "p80076",
      "ccom.apple.Virtualization.Virtua",
      "f21u",
      `n${database}-wal`,
    ].join("\n");
    expect(() => assertNoHostDatabaseUsers(database, (_command, args) => ({
      status: args[0] === "+L1" ? status : 0,
      stdout: full,
      stderr: args[0] === "+L1" ? stderr : "",
    }), {
      platform: "darwin",
      dockerMountInventoryVerified: true,
    })).toThrow(/lsof \+L1 could not provide/);
  });

  it("fails closed with an actionable error when lsof is unavailable", () => {
    expect(() => assertNoHostDatabaseUsers("/srv/data/agentic.db", () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
    }))).toThrow(/lsof is required/);
  });

  it("fails closed with an actionable error when Docker inventory is unavailable", () => {
    expect(() => assertNoRunningDockerDatabaseMounts(
      "/srv/data/agentic.db",
      () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
      }),
    )).toThrow(/Docker CLI is required/);
  });

  it("rejects any running writable bind mount that covers the database", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "factory-production-live-mount-"));
    roots.push(fixtureRoot);
    const data = path.join(fixtureRoot, "data");
    mkdirSync(data);
    const database = path.join(data, "agentic.db");
    writeFileSync(database, "fixture\n");
    const observe: CommandObserver = (command, args) => {
      expect(command).toBe("docker");
      if (args[0] === "ps") return { status: 0, stdout: "abc123\n", stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify([{
          Id: "abc123",
          Name: "/old-agentic-api",
          State: { Running: true },
          Mounts: [{
            Type: "bind",
            Source: data,
            Destination: "/app/data",
            RW: true,
          }],
        }]),
        stderr: "",
      };
    };
    expect(() => assertNoRunningDockerDatabaseMounts(database, observe)).toThrow(
      /old-agentic-api[\s\S]*stop them explicitly/,
    );
  });

  it("rejects incomplete Docker inspect results instead of granting stale-handle proof", () => {
    const observe: CommandObserver = (_command, args) => args[0] === "ps"
      ? { status: 0, stdout: "first\nsecond\n", stderr: "" }
      : {
        status: 0,
        stdout: JSON.stringify([{
          Id: "first",
          State: { Running: true },
          Mounts: [],
        }]),
        stderr: "",
      };
    expect(() => assertNoRunningDockerDatabaseMounts(
      "/srv/agentic/data/agentic.db",
      observe,
    )).toThrow(/inventory was incomplete/);
  });

  it("canonicalizes Docker bind sources so a symlink alias cannot hide database coverage", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "factory-production-mount-alias-"));
    roots.push(fixtureRoot);
    const data = path.join(fixtureRoot, "real-data");
    const alias = path.join(fixtureRoot, "data-alias");
    mkdirSync(data);
    const database = path.join(data, "agentic.db");
    writeFileSync(database, "fixture\n");
    symlinkSync(data, alias);
    const observe: CommandObserver = (_command, args) => args[0] === "ps"
      ? { status: 0, stdout: "container-one\n", stderr: "" }
      : {
        status: 0,
        stdout: JSON.stringify([{
          Id: "container-one",
          Name: "/aliased-writer",
          State: { Running: true },
          Mounts: [{
            Type: "bind",
            Source: alias,
            Destination: "/app/data",
            RW: true,
          }],
        }]),
        stderr: "",
      };
    expect(() => assertNoRunningDockerDatabaseMounts(database, observe)).toThrow(/aliased-writer/);
  });

  it("accepts only an exact healthy integrity and foreign-key result", () => {
    expect(() => assertDatabaseInspectionHealthy({
      integrity: ["ok"],
      foreignKeyViolations: 0,
    })).not.toThrow();
    expect(() => assertDatabaseInspectionHealthy({
      integrity: ["page 12 is never used"],
      foreignKeyViolations: 0,
    })).toThrow(/integrity_check failed/);
    expect(() => assertDatabaseInspectionHealthy({
      integrity: ["ok"],
      foreignKeyViolations: 2,
    })).toThrow(/foreign_key_check found 2/);
  });

  it("runs both ownership inventories around the read-only database inspection", async () => {
    const safetyRoot = mkdtempSync(path.join(tmpdir(), "factory-production-safety-"));
    roots.push(safetyRoot);
    writeFileSync(path.join(safetyRoot, "agentic.db"), "test fixture only\n");
    const events: string[] = [];
    const observe: CommandObserver = (command, args) => {
      events.push(`${command} ${args[0] ?? ""}`);
      return { status: 0, stdout: "", stderr: "" };
    };

    await assertProductionSetupSafety(safetyRoot, {
      observeCommand: observe,
      inspectDatabase: async () => {
        events.push("sqlite inspect");
        return { integrity: ["ok"], foreignKeyViolations: 0 };
      },
    });
    expect(events).toEqual([
      "docker ps",
      "lsof -nP",
      "sqlite inspect",
      "docker ps",
      "lsof -nP",
    ]);
  });

  it("accepts stale macOS Docker file-sharing WAL evidence only through the composite inventory gate", async () => {
    const safetyRoot = mkdtempSync(path.join(tmpdir(), "factory-production-docker-stale-wal-"));
    roots.push(safetyRoot);
    const database = path.join(safetyRoot, "agentic.db");
    writeFileSync(database, "test fixture only\n");
    const events: string[] = [];
    const observe: CommandObserver = (command, args) => {
      events.push(`${command} ${args[0] ?? ""}`);
      return command === "docker"
        ? { status: 0, stdout: "", stderr: "" }
        : {
        status: 0,
        stdout: [
          "p80076",
          "ccom.apple.Virtualization.Virtua",
          "f21u",
          // Real macOS lsof emits the same filename text in both inventories;
          // only +L1 supplies the link-count-zero proof.
          `n${database}-wal`,
        ].join("\n"),
        stderr: "",
      };
    };

    await expect(assertProductionSetupSafety(safetyRoot, {
      platform: "darwin",
      observeCommand: observe,
      inspectDatabase: async () => ({ integrity: ["ok"], foreignKeyViolations: 0 }),
    })).resolves.toBeUndefined();
    expect(events).toEqual([
      "docker ps",
      "lsof -nP",
      "lsof +L1",
      "docker ps",
      "lsof -nP",
      "lsof +L1",
    ]);
  });

  it("requires explicit writer-lease recovery and re-proves safety after removal", async () => {
    const safetyRoot = mkdtempSync(path.join(tmpdir(), "factory-production-writer-recovery-"));
    roots.push(safetyRoot);
    const database = path.join(safetyRoot, "agentic.db");
    writeFileSync(database, "test fixture only\n");
    const lease = acquireSqliteWriterLease(`file:${database}`);
    let observed = 0;
    const observe: CommandObserver = () => {
      observed += 1;
      return { status: 0, stdout: "", stderr: "" };
    };
    const inspectDatabase = async () => ({
      integrity: ["ok"],
      foreignKeyViolations: 0,
    });

    await expect(assertProductionSetupSafety(safetyRoot, {
      observeCommand: observe,
      inspectDatabase,
    })).rejects.toThrow(/--recover-sqlite-writer-lease/);
    expect(observed).toBe(0);
    expect(existsSync(lease.leasePath)).toBe(true);

    await assertProductionSetupSafety(safetyRoot, {
      observeCommand: observe,
      inspectDatabase,
      recoverWriterLease: true,
    });
    // Docker + lsof before inspection, both again before recovery, then both
    // once more plus a second integrity check after the destructive step.
    expect(observed).toBe(6);
    expect(existsSync(sqliteWriterLeasePath(`file:${database}`))).toBe(false);
  });

  it("rejects a missing production database before invoking external inventory", async () => {
    const safetyRoot = mkdtempSync(path.join(tmpdir(), "factory-production-missing-db-"));
    roots.push(safetyRoot);
    let invoked = false;
    await expect(assertProductionSetupSafety(safetyRoot, {
      observeCommand: () => {
        invoked = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      inspectDatabase: async () => ({ integrity: ["ok"], foreignKeyViolations: 0 }),
    })).rejects.toThrow(/production database does not exist/);
    expect(invoked).toBe(false);
  });

  it("carries vendor-neutral integration config while rejecting deployment authority", () => {
    const settings = new Map(copyRuntimeSettings({
      ACME_RECRUIT_API_KEY: "secret",
      ACME_RECRUIT_BASE_URL: "http://localhost:9876/v1",
      ROBOHIRE_API_KEY: "another-secret",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
      DATABASE_URL: "file:/tmp/dev.db",
      API_BIND_ADDRESS: "0.0.0.0",
      API_PORT: "9999",
      INNGEST_SIGNING_KEY: "must-not-survive",
      FACTORY_SB_RESULT_HMAC: "must-not-survive",
      FACTORY_SB_RECEIPT_HMAC: "must-not-survive",
      FACTORY_EXEC_GENERATED: "1",
      FACTORY_CONTROL_PLANE_BUILD_ID: "forged-build",
      PRODUCTION_CODEACT_EXECUTOR_TOKEN: "must-not-survive",
      SANDBOX_WORKLOAD_TOKEN: "must-not-survive",
      AGENTIC_PROCESS_ROLE: "sandbox-runner-workload",
      AGENTIC_DATABASE_READONLY: "0",
      AGENTIC_API_IMAGE: "attacker/api:latest",
      FACTORY_MODEL_PROVIDER: "anthropic",
    }));

    expect(settings.get("ACME_RECRUIT_API_KEY")).toBe("secret");
    expect(settings.get("ROBOHIRE_API_KEY")).toBe("another-secret");
    expect(settings.get("ACME_RECRUIT_BASE_URL")).toBe("http://host.docker.internal:9876/v1");
    expect(settings.has("NODE_OPTIONS")).toBe(false);
    expect(settings.has("DATABASE_URL")).toBe(false);
    expect(settings.has("API_BIND_ADDRESS")).toBe(false);
    expect(settings.has("API_PORT")).toBe(false);
    expect(settings.has("INNGEST_SIGNING_KEY")).toBe(false);
    expect(settings.has("FACTORY_SB_RESULT_HMAC")).toBe(false);
    expect(settings.has("FACTORY_SB_RECEIPT_HMAC")).toBe(false);
    expect(settings.has("FACTORY_EXEC_GENERATED")).toBe(false);
    expect(settings.has("FACTORY_CONTROL_PLANE_BUILD_ID")).toBe(false);
    expect(settings.has("PRODUCTION_CODEACT_EXECUTOR_TOKEN")).toBe(false);
    expect(settings.has("SANDBOX_WORKLOAD_TOKEN")).toBe(false);
    expect(settings.has("AGENTIC_PROCESS_ROLE")).toBe(false);
    expect(settings.has("AGENTIC_DATABASE_READONLY")).toBe(false);
    expect(settings.has("AGENTIC_API_IMAGE")).toBe(false);
    expect(settings.get("FACTORY_MODEL_PROVIDER")).toBe("anthropic");
  });

  it("reconciles derived broker files and leaves bind secrets non-writable but readable by non-root services", () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-production-secrets-"));
    roots.push(root);
    const leaf = path.join(root, "sandbox");
    const file = path.join(leaf, "event-keys");

    writeDerivedSecretFile(file, "old-key");
    writeDerivedSecretFile(file, "new-key");
    expect(readFileSync(file, "utf8")).toBe("new-key\n");

    finalizeBindSecretPermissions([leaf]);
    expect(statSync(leaf).mode & 0o777).toBe(0o505);
    expect(statSync(file).mode & 0o777).toBe(0o404);
    chmodSync(leaf, 0o700);
  });

  it("persists a host-only Ed25519 private key and exposes only its public trust root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-production-image-trust-"));
    roots.push(root);
    const first = ensureProductionImageAttestationKeyPair(root);
    const privateBytes = readFileSync(first.privateKeyFile, "utf8");
    const publicBytes = readFileSync(first.publicKeyFile, "utf8");
    const second = ensureProductionImageAttestationKeyPair(root);

    expect(privateBytes).toContain("BEGIN PRIVATE KEY");
    expect(publicBytes).toContain("BEGIN PUBLIC KEY");
    expect(publicBytes).not.toContain("PRIVATE");
    expect(second.keyId).toBe(first.keyId);
    expect(readFileSync(second.privateKeyFile, "utf8")).toBe(privateBytes);
    expect(statSync(first.privateKeyFile).mode & 0o777).toBe(0o600);
    expect(statSync(first.publicKeyFile).mode & 0o777).toBe(0o444);
  });

  it("generates every required production Compose variable and all isolated execution identities", () => {
    const setup = readFileSync(
      path.join(repoRoot, "apps/api/scripts/setup-factory-production.ts"),
      "utf8",
    );
    const baseCompose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
    const compose = readFileSync(path.join(repoRoot, "docker-compose.production.yml"), "utf8");
    const dockerfile = readFileSync(path.join(repoRoot, "apps/api/Dockerfile"), "utf8");
    const webDockerfile = readFileSync(path.join(repoRoot, "apps/web/Dockerfile"), "utf8");
    const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((match) => match[1]!);
    const generated = new Set(
      [...setup.matchAll(/\["([A-Z0-9_]+)",/g)].map((match) => match[1]!),
    );

    expect([...new Set(required)].filter((name) => !generated.has(name))).toEqual([]);
    for (const name of [
      "FACTORY_CODEACT_CANDIDATE_IMAGE",
      "FACTORY_CODEACT_DOCKER_SOCKET_HOST_PATH",
      "FACTORY_CODEACT_DOCKER_SOCKET_GID",
      "FACTORY_SANDBOX_BUDGET_TOKENS",
      "FACTORY_SB_RUNNER_HTTP_ALLOWED_HOSTS",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_FILE",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TOPOLOGY",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_HOST_FILE",
      "FACTORY_PRODUCTION_IMAGE_ATTESTATION_TTL_MS",
      "SANDBOX_MODEL_PROXY_HTTP_ALLOWED_HOSTS",
      "SANDBOX_CANCEL_FENCE_HMAC_FILE",
      "SANDBOX_CANCEL_FENCE_HMAC_HOST_FILE",
      "SANDBOX_CANCEL_FENCE_MAX_ENTRIES",
      "SANDBOX_GATEWAY_TOMBSTONE_HMAC_FILE",
      "SANDBOX_GATEWAY_TOMBSTONE_HMAC_HOST_FILE",
      "SANDBOX_GATEWAY_TOMBSTONE_MAX_ENTRIES",
      "PRODUCTION_CODEACT_EXECUTOR_ENABLED",
      "PRODUCTION_CODEACT_EXECUTOR_IMAGE",
      "PRODUCTION_CODEACT_EXECUTOR_URL",
      "PRODUCTION_CODEACT_EXECUTOR_TOKEN_FILE",
      "PRODUCTION_CODEACT_EXECUTOR_TOKEN_HOST_FILE",
      "PRODUCTION_CODEACT_EXECUTOR_HTTP_ALLOWED_HOSTS",
      "PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID",
      "PRODUCTION_CODEACT_EXPECTED_BUILD_ID",
      "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS",
      "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS",
      "PRODUCTION_CODEACT_REAPER_INTERVAL_MS",
      "PRODUCTION_CODEACT_ORPHAN_GRACE_MS",
      "PRODUCTION_CODEACT_DRAIN_TIMEOUT_MS",
      "AGENTIC_RUNTIME_UID",
      "AGENTIC_RUNTIME_GID",
      "AGENTIC_NODE_BASE_IMAGE",
      "API_BIND_ADDRESS",
      "API_PORT",
    ]) {
      expect(generated.has(name), `${name} is generated by setup`).toBe(true);
    }
    expect(setup).toContain('target: "codeact-candidate"');
    expect(setup).toContain('target: "production-codeact-executor"');
    expect(compose).toContain("FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_HOST_FILE");
    expect(compose).toContain("FACTORY_PRODUCTION_IMAGE_ATTESTATION_PUBLIC_KEY_FILE");
    expect(compose).not.toContain("FACTORY_PRODUCTION_IMAGE_ATTESTATION_PRIVATE_KEY_HOST_FILE");
    expect(setup).toMatch(
      /curated production targets must resolve to distinct image IDs[\s\S]*?await assertProductionSetupSafety\(dataRoot, \{ ownedWriterLease: writerLease \}\);[\s\S]*?writeFileSync\(envPath/,
    );
    expect(setup).toMatch(
      /const setupLock = acquireProductionSetupLock\(setupLockPath\);[\s\S]*?await assertProductionSetupSafety\(dataRoot, \{[\s\S]*?recoverWriterLease: opts\.recoverWriterLease[\s\S]*?\}\);[\s\S]*?writerLease = acquireSqliteWriterLease[\s\S]*?await runSetup\(opts, writerLease, setupLock\);[\s\S]*?writerLease\?\.release\(\)[\s\S]*?setupLock\.release\(\)/,
    );
    expect(setup).toContain("NODE_BASE_IMAGE: nodeBaseImage");
    expect(setup).toContain('`http://localhost:${apiPort}`');
    for (const binding of [
      '["AGENTIC_API_IMAGE", imageIds.api]',
      '["AGENTIC_WEB_IMAGE", imageIds.web]',
      '["FACTORY_SANDBOX_CONTROL_IMAGE", imageIds.control]',
      '["FACTORY_SANDBOX_WORKLOAD_IMAGE", imageIds.workload]',
      '["FACTORY_SANDBOX_GATEWAY_IMAGE", imageIds.gateway]',
      '["PRODUCTION_CODEACT_EXECUTOR_IMAGE", imageIds.executor]',
      '["FACTORY_CODEACT_CANDIDATE_IMAGE", candidateDigest]',
    ]) expect(setup).toContain(binding);
    expect(setup).not.toContain('["AGENTIC_API_IMAGE", tags.api]');
    expect(setup).toMatch(
      /const resultHmac = persistentIntegritySecret\([\s\S]*?"result-hmac"[\s\S]*?"sandbox result journal"/,
    );
    expect(setup).toMatch(
      /const requestHmac = persistentIntegritySecret\([\s\S]*?"request-hmac"[\s\S]*?"sandbox request nonce ledger"/,
    );
    expect(setup).toMatch(
      /const receiptHmac = persistentIntegritySecret\([\s\S]*?"receipt-hmac"[\s\S]*?"sandbox execution receipts"/,
    );
    expect(setup).toContain("const sandboxCancelFenceIntegrityKey = persistentIntegritySecret(");
    expect(setup).toContain("const sandboxGatewayTombstoneIntegrityKey = persistentIntegritySecret(");
    expect(compose).toContain("user: \"${AGENTIC_RUNTIME_UID:?");
    expect(compose).toContain('"${API_BIND_ADDRESS:-127.0.0.1}:${API_PORT:-3501}:3501"');
    expect(compose).toContain('image: "${PRODUCTION_CODEACT_EXECUTOR_IMAGE:?');
    expect(compose).toContain('image: "${FACTORY_SANDBOX_CONTROL_IMAGE:?');
    expect(compose).toContain('image: "${FACTORY_SANDBOX_WORKLOAD_IMAGE:?');
    expect(compose).toContain(
      'AGENTIC_BUILD_ID: "${PRODUCTION_CODEACT_EXPECTED_BUILD_ID:?PRODUCTION_CODEACT_EXPECTED_BUILD_ID is required}"',
    );
    expect(compose).not.toContain(
      'PRODUCTION_CODEACT_EXECUTOR_ID: "production-codeact-${FACTORY_SB_RUNNER_BUILD_ID:',
    );
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*[\s\\\n]*CMD[^\n]*\/live/);
    expect(dockerfile).not.toMatch(/HEALTHCHECK[^\n]*[\s\\\n]*CMD[^\n]*\/health/);
    expect(webDockerfile).toMatch(/HEALTHCHECK[\s\S]*require\('node:net'\)\.connect/);
    for (const capability of [
      "AGENTIC_SQLITE_WRITER_LEASE_TOKEN",
      "AGENTIC_SQLITE_WRITER_LEASE_PATH",
      "AGENTIC_SQLITE_WRITER_SUPERVISOR_PID",
      "AGENTIC_SQLITE_WRITER_SUPERVISED",
      "AGENTIC_SQLITE_TEST_WRITER",
      "AGENTIC_API_TEST_RUN_ROOT",
    ]) {
      expect(baseCompose).toContain(`${capability}: ""`);
    }
    expect(compose.match(/source: "\$\{SANDBOX_CANCEL_FENCE_HMAC_HOST_FILE:\?/g)).toHaveLength(2);
    expect(compose.split("  codeact-executor:")[0]).not.toContain("SANDBOX_CANCEL_FENCE_HMAC_HOST_FILE");
    expect(compose.match(/source: "\$\{SANDBOX_GATEWAY_TOMBSTONE_HMAC_HOST_FILE:\?/g)).toHaveLength(1);
    const gatewayService = compose.split(/^  sandbox-broker-gateway:/m)[1]
      ?.split(/^  [a-z0-9-]+:/m)[0] ?? "";
    expect(gatewayService).toContain("SANDBOX_GATEWAY_TOMBSTONE_HMAC_HOST_FILE");
    expect(compose).toContain('name: "agentic-operator_factory-sandbox-control-current"');
    expect(compose).not.toMatch(
      /factory-sandbox-control[^\n]*\$\{FACTORY_SB_RUNNER_BUILD_ID/,
    );

    const common = dockerfile.split("FROM ${NODE_BASE_IMAGE} AS sandbox-common")[1]
      ?.split("FROM sandbox-common AS production-codeact-executor")[0] ?? "";
    const executor = dockerfile.split("FROM sandbox-common AS production-codeact-executor")[1]
      ?.split(/\nFROM /)[0] ?? "";
    expect(common).not.toMatch(/COPY .*\/(?:models|tenants)(?:\s|\/)/);
    expect(executor).toContain("/app/apps/api/src/codeact-executor.ts");
    expect(executor).not.toContain("/app/apps/api/src /app/apps/api/src");
    expect(executor).not.toMatch(/\/(?:models|tenants)(?:\s|\/)/);
    expect(executor).not.toContain("docker-entrypoint.sh");
  });
});
