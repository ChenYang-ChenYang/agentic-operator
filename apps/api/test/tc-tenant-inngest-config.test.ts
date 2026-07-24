import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_INNGEST_CONFIG_REFS_ENV,
  SANDBOX_INNGEST_CONFIG_REFS_ENV,
  SYSTEM_SLUG,
  TenantInngestConfigurationError,
  appIdForTenant,
  deleteFactorySandboxApp,
  disposeTenantInngestClient,
  getTenantInngest,
  isFactorySandboxTenant,
  sandboxInngestIsolationStatus,
  tenantInngestConfigStatus,
  tenantInngestIsolationIdentity,
} from "@agentic/runtime";
import { checkInngest } from "../src/routes/health";
import {
  __recordInngestSyncEvidenceForTests,
  __resetInngestSyncEvidenceForTests,
  inngestRegistrationStatus,
  probeApp,
  reconcileApps,
  syncTenantApp,
  verifyTenantAppRegistration,
} from "../src/services/inngest-sync";
import {
  __resetInngestRegistryForTests,
  initInngestRegistry,
  listRegisteredApps,
} from "../src/services/inngest-registry";

const TRACKED_ENV = [
  "NODE_ENV",
  TENANT_INNGEST_CONFIG_REFS_ENV,
  "INNGEST_EVENT_KEY",
  "INNGEST_EVENT_KEY_FILE",
  "INNGEST_SIGNING_KEY",
  "INNGEST_SIGNING_KEY_FILE",
  "INNGEST_SERVE_ORIGIN",
  "INNGEST_BASE_URL",
  "INNGEST_DEV",
  "INNGEST_SYNC_DISABLED",
  "INNGEST_CLOUD_SYNC_MAX_AGE_MS",
  "ACME_EVENT_KEY",
  "ACME_EVENT_KEY_FILE",
  "ACME_SIGNING_KEY",
  "ACME_SIGNING_KEY_FILE",
  "ACME_SERVE_ORIGIN",
  "ACME_BASE_URL",
  SANDBOX_INNGEST_CONFIG_REFS_ENV,
  "FACTORY_SB_EVENT_KEY",
  "FACTORY_SB_SIGNING_KEY",
  "FACTORY_SB_SERVE_ORIGIN",
  "FACTORY_SB_BASE_URL",
  "FACTORY_SB_APP_PREFIX",
  "FACTORY_SB_DELETE_URL",
  "FACTORY_SB_DELETE_TOKEN",
  "FACTORY_SB_CONTROL_BEARER",
  "FACTORY_SB_DEV_MODE",
  "SANDBOX_INTERNAL_CONTROL_ORIGIN",
  "SANDBOX_RUNNER_ROLE",
  "AGENTIC_PROCESS_ROLE",
  "SANDBOX_RUNNER_EGRESS_MODE",
] as const;
const original = Object.fromEntries(
  TRACKED_ENV.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of TRACKED_ENV) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetInngestSyncEvidenceForTests();
  __resetInngestRegistryForTests();
  vi.unstubAllGlobals();
});

function configureAcme(): void {
  process.env.NODE_ENV = "production";
  process.env[TENANT_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
    acme: {
      eventKeyEnv: "ACME_EVENT_KEY",
      signingKeyEnv: "ACME_SIGNING_KEY",
      serveOriginEnv: "ACME_SERVE_ORIGIN",
      baseUrlEnv: "ACME_BASE_URL",
    },
  });
  process.env.ACME_EVENT_KEY = "evt_live_7Qm8Np2Rs4Tu6Vw9";
  process.env.ACME_SIGNING_KEY = "sign_live_8Rn9Pq3St5Uv7Wx1";
  process.env.ACME_SERVE_ORIGIN = "https://agents.acme.example";
  process.env.ACME_BASE_URL = "https://broker.acme.example";
  process.env.INNGEST_BASE_URL = "https://broker.platform.example";
  process.env.FACTORY_SB_CONTROL_BEARER =
    "sandbox_control_gateway_bearer_7Qm8Np2Rs4Tu6Vw9";
}

describe("tenant-specific Inngest configuration", () => {
  it("verifies the target broker registered the exact production function count", async () => {
    configureAcme();
    process.env.INNGEST_DEV = "0";
    delete process.env.INNGEST_SYNC_DISABLED;
    process.env.INNGEST_EVENT_KEY = "evt_system_live_7Qm8Np2Rs4Tu6Vw9";
    process.env.INNGEST_SIGNING_KEY = "sign_system_live_8Rn9Pq3St5Uv7Wx1";
    process.env.INNGEST_SERVE_ORIGIN = "https://agents.platform.example";
    const client = getTenantInngest("acme");
    const activationFn = client.createFunction(
      {
        id: "factory-production-activation",
        triggers: { event: "acme/ACTIVATE" },
      },
      async () => ({ ok: true }),
    );
    initInngestRegistry({
      systemBase: [],
      systemCodeAgent: [],
      tenants: [{ slug: "acme", fns: [activationFn] }],
    });
    const brokerCount = { value: 1 };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v0/gql")) {
        return new Response(JSON.stringify({
          data: {
            apps: [{
              name: appIdForTenant("acme"),
              url: "https://agents.acme.example/inngest/acme",
              error: null,
              connected: true,
              functionCount: brokerCount.value,
            }],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("registered", { status: 200 });
    }));

    await expect(syncTenantApp("acme")).resolves.toMatchObject({ ok: true });
    await expect(verifyTenantAppRegistration("acme", 1, {
      attempts: 1,
      delayMs: 0,
    })).resolves.toMatchObject({
      verified: true,
      connected: true,
      expectedFunctionCount: 1,
      observedFunctionCount: 1,
    });

    brokerCount.value = 0;
    await expect(verifyTenantAppRegistration("acme", 1, {
      attempts: 1,
      delayMs: 0,
    })).resolves.toMatchObject({
      verified: false,
      connected: true,
      expectedFunctionCount: 1,
      observedFunctionCount: 0,
    });
  });

  it("loads the production system app credentials from secret files", () => {
    process.env.NODE_ENV = "production";
    process.env.INNGEST_DEV = "0";
    process.env.INNGEST_BASE_URL = "https://broker.platform.example";
    process.env.INNGEST_SERVE_ORIGIN = "https://agents.platform.example";
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_SIGNING_KEY;
    const dir = mkdtempSync(path.join(tmpdir(), "agentic-system-inngest-secrets-"));
    try {
      const eventFile = path.join(dir, "event-key");
      const signingFile = path.join(dir, "signing-key");
      writeFileSync(eventFile, "evt_system_file_7Qm8Np2Rs4Tu6Vw9\n", { mode: 0o600 });
      writeFileSync(signingFile, "sign_system_file_8Rn9Pq3St5Uv7Wx1\n", { mode: 0o600 });
      process.env.INNGEST_EVENT_KEY_FILE = eventFile;
      process.env.INNGEST_SIGNING_KEY_FILE = signingFile;

      expect(tenantInngestConfigStatus(SYSTEM_SLUG)).toMatchObject({
        readiness: "ready",
        source: "shared_env",
        eventKeyConfigured: true,
        signingKeyConfigured: true,
      });

      process.env.INNGEST_EVENT_KEY = "evt_conflicting_direct_value_1234";
      const ambiguous = tenantInngestConfigStatus(SYSTEM_SLUG);
      expect(ambiguous.readiness).toBe("blocked");
      expect(ambiguous.missing.join(" ")).toMatch(/cannot both be configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads referenced secrets from absolute files and rejects ambiguous direct values", () => {
    configureAcme();
    const dir = mkdtempSync(path.join(tmpdir(), "agentic-inngest-secrets-"));
    try {
      const eventFile = path.join(dir, "event-key");
      const signingFile = path.join(dir, "signing-key");
      writeFileSync(eventFile, "evt_live_file_7Qm8Np2Rs4Tu6Vw9\n", { mode: 0o600 });
      writeFileSync(signingFile, "sign_live_file_8Rn9Pq3St5Uv7Wx1\n", { mode: 0o600 });
      delete process.env.ACME_EVENT_KEY;
      delete process.env.ACME_SIGNING_KEY;
      process.env.ACME_EVENT_KEY_FILE = eventFile;
      process.env.ACME_SIGNING_KEY_FILE = signingFile;

      expect(tenantInngestConfigStatus("acme")).toMatchObject({
        readiness: "ready",
        eventKeyConfigured: true,
        signingKeyConfigured: true,
      });

      process.env.ACME_EVENT_KEY = "evt_conflicting_direct_value_1234";
      const ambiguous = tenantInngestConfigStatus("acme");
      expect(ambiguous.readiness).toBe("blocked");
      expect(ambiguous.missing.join(" ")).toMatch(/cannot both be configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows the isolated workload to use only its exact internal HTTP delete control", () => {
    configureAcme();
    const slug = "af-sbx-1234abcd-5678efab-123456789abc-sb";
    process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      eventKeyEnv: "FACTORY_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_SB_BASE_URL",
      appPrefixEnv: "FACTORY_SB_APP_PREFIX",
      controlBearerEnv: "FACTORY_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "FACTORY_SB_DELETE_URL",
      deleteControlTokenEnv: "FACTORY_SB_DELETE_TOKEN",
    });
    process.env.FACTORY_SB_EVENT_KEY = "evt_sandbox_2Rs4Tu6Vw9Xy1Za3";
    process.env.FACTORY_SB_SIGNING_KEY = "sign_sandbox_3St5Uv7Wx1Yz2Ab4";
    process.env.FACTORY_SB_SERVE_ORIGIN = "http://sandbox-workload:3561";
    process.env.FACTORY_SB_BASE_URL = "http://sandbox-inngest:8288";
    process.env.FACTORY_SB_APP_PREFIX = "agentic-factory-sandbox";
    process.env.FACTORY_SB_DELETE_URL = "http://sandbox-runner-control:3560/apps/{appId}";
    process.env.FACTORY_SB_DELETE_TOKEN = "delete_live_4Tu6Vw9Xy1Za3Bc5";
    process.env.SANDBOX_INTERNAL_CONTROL_ORIGIN = "http://sandbox-runner-control:3560";

    expect(tenantInngestConfigStatus(slug).readiness).toBe("blocked");
    process.env.SANDBOX_RUNNER_ROLE = "workload";
    process.env.AGENTIC_PROCESS_ROLE = "sandbox-runner-workload";
    process.env.SANDBOX_RUNNER_EGRESS_MODE = "deny_all";
    expect(tenantInngestConfigStatus(slug)).toMatchObject({
      readiness: "ready",
      cleanupMode: "custom_delete_control",
      deleteControlConfigured: true,
    });

    process.env.FACTORY_SB_DELETE_URL = "http://different-internal-host:3560/apps/{appId}";
    expect(tenantInngestConfigStatus(slug).readiness).toBe("blocked");
  });

  it("enables unsigned Dev Server callbacks only through the isolated workload-scoped reference", () => {
    configureAcme();
    process.env.INNGEST_DEV = "0";
    const slug = "af-sbx-1234abcd-5678efab-def012345678-sb";
    process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      eventKeyEnv: "FACTORY_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_SB_BASE_URL",
      appPrefixEnv: "FACTORY_SB_APP_PREFIX",
      devModeEnv: "FACTORY_SB_DEV_MODE",
      controlBearerEnv: "FACTORY_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "FACTORY_SB_DELETE_URL",
      deleteControlTokenEnv: "FACTORY_SB_DELETE_TOKEN",
    });
    process.env.FACTORY_SB_EVENT_KEY = "evt_sandbox_mode_2Rs4Tu6Vw9Xy1Za3";
    process.env.FACTORY_SB_SIGNING_KEY = "sign_sandbox_mode_3St5Uv7Wx1Yz2Ab4";
    process.env.FACTORY_SB_SERVE_ORIGIN = "http://sandbox-workload:3561";
    process.env.FACTORY_SB_BASE_URL = "http://sandbox-inngest:8288";
    process.env.FACTORY_SB_APP_PREFIX = "agentic-factory-sandbox";
    process.env.FACTORY_SB_DELETE_URL =
      "http://sandbox-runner-control:3560/apps/{appId}";
    process.env.FACTORY_SB_DELETE_TOKEN = "delete_live_4Tu6Vw9Xy1Za3Bc5";
    process.env.SANDBOX_INTERNAL_CONTROL_ORIGIN =
      "http://sandbox-runner-control:3560";

    // Empty/0 are the production-safe defaults and retain signed,
    // self-hosted semantics even when the optional reference exists.
    process.env.FACTORY_SB_DEV_MODE = "";
    expect(tenantInngestConfigStatus(slug)).toMatchObject({
      readiness: "blocked",
      mode: "self_hosted",
    });
    process.env.SANDBOX_RUNNER_ROLE = "workload";
    process.env.AGENTIC_PROCESS_ROLE = "sandbox-runner-workload";
    process.env.SANDBOX_RUNNER_EGRESS_MODE = "deny_all";
    expect(tenantInngestConfigStatus(slug)).toMatchObject({
      readiness: "ready",
      mode: "self_hosted",
    });
    process.env.FACTORY_SB_DEV_MODE = "0";
    expect(tenantInngestConfigStatus(slug)).toMatchObject({
      readiness: "ready",
      mode: "self_hosted",
    });

    // No truthy aliases are accepted; a typo must fail closed.
    for (const invalid of ["true", "yes", "2"]) {
      process.env.FACTORY_SB_DEV_MODE = invalid;
      const status = tenantInngestConfigStatus(slug);
      expect(status.readiness).toBe("blocked");
      expect(status.missing.join(" ")).toMatch(/must be empty, 0, or 1/);
    }

    process.env.FACTORY_SB_DEV_MODE = "1";
    delete process.env.SANDBOX_RUNNER_EGRESS_MODE;
    expect(tenantInngestConfigStatus(slug)).toMatchObject({
      readiness: "blocked",
      mode: "development",
    });
    expect(tenantInngestConfigStatus(slug).missing.join(" ")).toMatch(
      /isolated external workload role with deny_all egress/,
    );

    process.env.SANDBOX_RUNNER_EGRESS_MODE = "deny_all";
    const status = tenantInngestConfigStatus(slug);
    expect(status).toMatchObject({
      readiness: "degraded",
      mode: "development",
      source: "sandbox_env_refs",
      baseUrl: "http://sandbox-inngest:8288",
    });
    expect(status.note).toMatch(/unsigned.*not production-durable/i);

    const client = getTenantInngest(slug);
    expect(client.mode).toBe("dev");
    expect(client.apiBaseUrl).toBe("http://sandbox-inngest:8288");
    expect(client.eventBaseUrl).toBe("http://sandbox-inngest:8288");
    expect(disposeTenantInngestClient(slug)).toBe(true);
  });

  it("requires dedicated credentials and an explicit delete control for ephemeral factory apps", async () => {
    configureAcme();
    const slug = "af-sbx-1234abcd-5678efab-123456789abc-sb";
    expect(isFactorySandboxTenant(slug)).toBe(true);
    process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      eventKeyEnv: "FACTORY_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_SB_BASE_URL",
      appPrefixEnv: "FACTORY_SB_APP_PREFIX",
      controlBearerEnv: "FACTORY_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "FACTORY_SB_DELETE_URL",
      deleteControlTokenEnv: "FACTORY_SB_DELETE_TOKEN",
    });
    process.env.FACTORY_SB_EVENT_KEY = "evt_sandbox_2Rs4Tu6Vw9Xy1Za3";
    process.env.FACTORY_SB_SIGNING_KEY = "sign_sandbox_3St5Uv7Wx1Yz2Ab4";
    process.env.FACTORY_SB_SERVE_ORIGIN = "https://factory-sandbox.example";
    process.env.FACTORY_SB_BASE_URL = "https://sandbox-broker.example";
    process.env.FACTORY_SB_APP_PREFIX = "agentic-factory-sandbox";
    process.env.FACTORY_SB_DELETE_URL = "https://sandbox-control.example/apps/{appId}";
    process.env.FACTORY_SB_DELETE_TOKEN = "delete_live_4Tu6Vw9Xy1Za3Bc5";

    const status = tenantInngestConfigStatus(slug);
    expect(status).toMatchObject({
      readiness: "ready",
      source: "sandbox_env_refs",
      cleanupMode: "custom_delete_control",
      deleteControlConfigured: true,
      serveOrigin: "https://factory-sandbox.example",
      baseUrl: "https://sandbox-broker.example",
    });
    expect(JSON.stringify(status)).not.toContain(process.env.FACTORY_SB_EVENT_KEY);
    expect(JSON.stringify(status)).not.toContain(process.env.FACTORY_SB_SIGNING_KEY);
    expect(JSON.stringify(status)).not.toContain(process.env.FACTORY_SB_DELETE_TOKEN);
    expect(() => getTenantInngest(slug)).not.toThrow();
    expect(appIdForTenant(slug)).toMatch(/^agentic-factory-sandbox-/);
    expect(sandboxInngestIsolationStatus(slug, "acme")).toEqual({ isolated: true, missing: [] });
    expect(disposeTenantInngestClient(slug)).toBe(true);
    const probeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          apps: [{
            name: appIdForTenant(slug),
            url: "https://factory-sandbox.example/inngest/probe",
            error: null,
            connected: true,
            functionCount: 1,
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", probeFetch);
    await expect(probeApp(appIdForTenant(slug), slug)).resolves.toMatchObject({
      healthy: true,
      connected: true,
      functionCount: 1,
    });
    expect(new Headers(probeFetch.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe(`Bearer ${process.env.FACTORY_SB_CONTROL_BEARER}`);
    const deleteFetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(deleteFactorySandboxApp(slug, appIdForTenant(slug), deleteFetch))
      .resolves.toEqual({ alreadyAbsent: false });
    expect(deleteFetch).toHaveBeenCalledWith(
      `https://sandbox-control.example/apps/${appIdForTenant(slug)}`,
      expect.objectContaining({ method: "DELETE", redirect: "error" }),
    );

    // Reusing any production tenant credential invalidates a previously cached
    // client and fails closed before registration or dispatch.
    process.env.FACTORY_SB_SIGNING_KEY = process.env.ACME_SIGNING_KEY;
    const reused = tenantInngestConfigStatus(slug);
    expect(reused.readiness).toBe("blocked");
    expect(reused.missing.join(" ")).toMatch(/must not reuse/i);
    expect(() => getTenantInngest(slug)).toThrow(TenantInngestConfigurationError);
  });

  it("lets a remote workload prove separation from fingerprints without receiving target secrets", () => {
    configureAcme();
    const targetIdentity = tenantInngestIsolationIdentity("acme");
    expect(JSON.stringify(targetIdentity)).not.toContain(process.env.ACME_EVENT_KEY);
    expect(JSON.stringify(targetIdentity)).not.toContain(process.env.ACME_SIGNING_KEY);

    const slug = "af-sbx-1234abcd-5678efab-123456789abc-sb";
    process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      eventKeyEnv: "FACTORY_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_SB_BASE_URL",
      appPrefixEnv: "FACTORY_SB_APP_PREFIX",
      controlBearerEnv: "FACTORY_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "FACTORY_SB_DELETE_URL",
      deleteControlTokenEnv: "FACTORY_SB_DELETE_TOKEN",
    });
    process.env.FACTORY_SB_EVENT_KEY = "evt_sandbox_remote_2Rs4Tu6Vw9Xy1Za3";
    process.env.FACTORY_SB_SIGNING_KEY = "sign_sandbox_remote_3St5Uv7Wx1Yz2Ab4";
    process.env.FACTORY_SB_SERVE_ORIGIN = "https://factory-sandbox.example";
    process.env.FACTORY_SB_BASE_URL = "https://sandbox-broker.example";
    process.env.FACTORY_SB_APP_PREFIX = "agentic-factory-sandbox";
    process.env.FACTORY_SB_DELETE_URL = "https://sandbox-control.example/apps/{appId}";
    process.env.FACTORY_SB_DELETE_TOKEN = "delete_live_4Tu6Vw9Xy1Za3Bc5";

    // Model the workload boundary: it has only sandbox credentials plus the
    // signed, secret-free identity carried in the candidate bundle.
    delete process.env[TENANT_INNGEST_CONFIG_REFS_ENV];
    delete process.env.ACME_EVENT_KEY;
    delete process.env.ACME_SIGNING_KEY;
    delete process.env.ACME_SERVE_ORIGIN;
    delete process.env.ACME_BASE_URL;
    expect(tenantInngestConfigStatus("acme").readiness).toBe("blocked");
    expect(sandboxInngestIsolationStatus(slug, "acme", targetIdentity)).toEqual({
      isolated: true,
      missing: [],
    });
  });

  it("does not let an ephemeral app inherit shared production configuration", () => {
    configureAcme();
    delete process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV];
    const status = tenantInngestConfigStatus(
      "af-sbx-1234abcd-5678efab-123456789abc-sb",
    );
    expect(status).toMatchObject({ readiness: "blocked", source: "invalid" });
    expect(status.missing).toContain(SANDBOX_INNGEST_CONFIG_REFS_ENV);
  });

  it("refuses to call the delete control for a non-ephemeral app id", async () => {
    const deleteFetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(deleteFactorySandboxApp("agents-generation", "agentic-operator-agents-generation", deleteFetch))
      .rejects.toThrow(/non-ephemeral app identity/);
    expect(deleteFetch).not.toHaveBeenCalled();
  });

  it("blocks a sandbox without a custom delete control or one that reuses the production broker", () => {
    configureAcme();
    const slug = "af-sbx-1234abcd-5678efab-123456789abc-sb";
    process.env.FACTORY_SB_EVENT_KEY = "evt_sandbox_2Rs4Tu6Vw9Xy1Za3";
    process.env.FACTORY_SB_SIGNING_KEY = "sign_sandbox_3St5Uv7Wx1Yz2Ab4";
    process.env.FACTORY_SB_SERVE_ORIGIN = "https://factory-sandbox.example";
    process.env.FACTORY_SB_BASE_URL = process.env.ACME_BASE_URL;
    process.env.FACTORY_SB_APP_PREFIX = "agentic-factory-sandbox";
    process.env.FACTORY_SB_DELETE_URL = "https://sandbox-control.example/apps/{appId}";
    process.env.FACTORY_SB_DELETE_TOKEN = "delete_live_4Tu6Vw9Xy1Za3Bc5";
    process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      eventKeyEnv: "FACTORY_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_SB_BASE_URL",
      appPrefixEnv: "FACTORY_SB_APP_PREFIX",
      controlBearerEnv: "FACTORY_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
    });

    const noDeleteControl = tenantInngestConfigStatus(slug);
    expect(noDeleteControl).toMatchObject({ readiness: "blocked", source: "invalid" });
    expect(noDeleteControl.note).toMatch(/deleteControlUrlEnv/);

    process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      eventKeyEnv: "FACTORY_SB_EVENT_KEY",
      signingKeyEnv: "FACTORY_SB_SIGNING_KEY",
      serveOriginEnv: "FACTORY_SB_SERVE_ORIGIN",
      baseUrlEnv: "FACTORY_SB_BASE_URL",
      appPrefixEnv: "FACTORY_SB_APP_PREFIX",
      controlBearerEnv: "FACTORY_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "FACTORY_SB_DELETE_URL",
      deleteControlTokenEnv: "FACTORY_SB_DELETE_TOKEN",
    });
    const reusedBroker = tenantInngestConfigStatus(slug);
    expect(reusedBroker.readiness).toBe("blocked");
    expect(reusedBroker.missing.join(" ")).toMatch(/must not reuse any production tenant broker/i);
  });

  it("dereferences tenant env names without exposing secret values", () => {
    configureAcme();
    const status = tenantInngestConfigStatus("acme");
    expect(status).toMatchObject({
      readiness: "ready",
      mode: "self_hosted",
      source: "tenant_env_refs",
      eventKeyConfigured: true,
      signingKeyConfigured: true,
      serveOrigin: "https://agents.acme.example",
      baseUrl: "https://broker.acme.example",
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(process.env.ACME_EVENT_KEY);
    expect(serialized).not.toContain(process.env.ACME_SIGNING_KEY);
    expect(() => getTenantInngest("acme")).not.toThrow();
    expect(() => getTenantInngest(`acme-${Date.now()}`)).toThrow(
      TenantInngestConfigurationError,
    );
  });

  it("uses Cloud SDK endpoints without inventing one shared base URL", async () => {
    configureAcme();
    delete process.env.INNGEST_BASE_URL;
    delete process.env.ACME_BASE_URL;
    process.env[TENANT_INNGEST_CONFIG_REFS_ENV] = JSON.stringify({
      acme: {
        eventKeyEnv: "ACME_EVENT_KEY",
        signingKeyEnv: "ACME_SIGNING_KEY",
        serveOriginEnv: "ACME_SERVE_ORIGIN",
      },
    });
    process.env.INNGEST_DEV = "0";
    delete process.env.INNGEST_SYNC_DISABLED;
    process.env.INNGEST_EVENT_KEY = "evt_system_live_7Qm8Np2Rs4Tu6Vw9";
    process.env.INNGEST_SIGNING_KEY = "sign_system_live_8Rn9Pq3St5Uv7Wx1";
    process.env.INNGEST_SERVE_ORIGIN = "https://agents.acme.example";

    const status = tenantInngestConfigStatus("acme");
    expect(status).toMatchObject({
      readiness: "ready",
      mode: "cloud",
      baseUrl: null,
    });

    initInngestRegistry({
      systemBase: [],
      systemCodeAgent: [],
      tenants: [{ slug: "acme", fns: [] }],
    });
    const syncFetch = vi.fn(
      async () => new Response("registered", { status: 200 }),
    );
    vi.stubGlobal("fetch", syncFetch);
    for (const app of listRegisteredApps()) {
      await expect(syncTenantApp(app.slug)).resolves.toMatchObject({
        ok: true,
        slug: app.slug,
      });
    }
    expect(syncFetch).toHaveBeenCalledTimes(2);
    let fetchCalls = 0;
    const health = await checkInngest(
      (async () => {
        fetchCalls += 1;
        throw new Error("Cloud health must use signed sync evidence");
      }) as typeof fetch,
      [SYSTEM_SLUG, "acme"],
    );
    expect(health).toMatchObject({
      ok: true,
      reachable: true,
      mode: "cloud",
      registrationOk: true,
    });
    expect(fetchCalls).toBe(0);

    process.env.INNGEST_CLOUD_SYNC_MAX_AGE_MS = "1000";
    __resetInngestSyncEvidenceForTests();
    for (const app of listRegisteredApps()) {
      __recordInngestSyncEvidenceForTests({
        slug: app.slug,
        appId: app.appId,
        fnCount: app.fnCount,
        ok: true,
        syncedAt: Date.now() - 2_000,
      });
    }
    const stale = await checkInngest(
      (async () => {
        throw new Error("stale Cloud evidence must not trigger a public probe");
      }) as typeof fetch,
      [SYSTEM_SLUG, "acme"],
    );
    expect(stale).toMatchObject({
      ok: false,
      reachable: false,
      mode: "cloud",
    });
    expect(stale.note).toMatch(/stale or missing/);
  });

  it("treats a zero-function tenant app as trivially dispatch-ready", async () => {
    process.env.NODE_ENV = "development";
    process.env.INNGEST_DEV = "1";
    process.env.INNGEST_BASE_URL = "http://127.0.0.1:8288";
    delete process.env.INNGEST_SYNC_DISABLED;

    const systemClient = getTenantInngest(SYSTEM_SLUG);
    const systemFn = systemClient.createFunction(
      {
        id: "zero-function-health-system",
        triggers: { event: `${SYSTEM_SLUG}/ZERO_FUNCTION_HEALTH` },
      },
      async () => ({ ok: true }),
    );
    const emptySlug = "zero-function-health";
    initInngestRegistry({
      systemBase: [systemFn],
      systemCodeAgent: [],
      tenants: [{ slug: emptySlug, fns: [] }],
    });
    const registered = listRegisteredApps();
    for (const app of registered) {
      __recordInngestSyncEvidenceForTests({
        slug: app.slug,
        appId: app.appId,
        fnCount: app.fnCount,
        ok: true,
      });
    }

    const calls: string[] = [];
    const health = await checkInngest(
      (async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v0/gql")) {
          return new Response(
            JSON.stringify({
              data: {
                apps: registered.map((app) => ({
                  name: app.appId,
                  connected: app.fnCount > 0,
                  functionCount: app.fnCount,
                  error: null,
                })),
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
      [SYSTEM_SLUG, emptySlug],
    );

    expect(health).toMatchObject({
      ok: true,
      reachable: true,
      registrationOk: true,
      expectedApps: 2,
      syncedApps: 2,
      emptyApps: [appIdForTenant(emptySlug)],
    });
    expect(health.note).toMatch(/1 empty app\(s\) require no dispatch session/);
    expect(calls).toEqual([
      "http://127.0.0.1:8288/health",
      "http://127.0.0.1:8288/v0/gql",
    ]);
  });

  it("probes a production self-host and requires current sync evidence", async () => {
    configureAcme();
    process.env.INNGEST_DEV = "0";
    delete process.env.INNGEST_SYNC_DISABLED;
    process.env.INNGEST_EVENT_KEY = "evt_system_live_7Qm8Np2Rs4Tu6Vw9";
    process.env.INNGEST_SIGNING_KEY = "sign_system_live_8Rn9Pq3St5Uv7Wx1";
    process.env.INNGEST_SERVE_ORIGIN = "https://agents.acme.example";
    initInngestRegistry({
      systemBase: [],
      systemCodeAgent: [],
      tenants: [{ slug: "acme", fns: [] }],
    });
    const syncFetch = vi.fn(
      async () => new Response("registered", { status: 200 }),
    );
    vi.stubGlobal("fetch", syncFetch);
    for (const app of listRegisteredApps()) {
      await expect(syncTenantApp(app.slug)).resolves.toMatchObject({
        ok: true,
        slug: app.slug,
      });
    }
    expect(syncFetch).toHaveBeenCalledTimes(2);
    const calls: string[] = [];
    const health = await checkInngest(
      (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
      [SYSTEM_SLUG, "acme"],
    );
    expect(health).toMatchObject({
      ok: true,
      reachable: true,
      mode: "self_hosted",
      registrationOk: true,
    });
    expect(calls).toEqual([
      "https://broker.platform.example/health",
      "https://broker.acme.example/health",
    ]);
  });

  it("repairs failed local acceptance evidence even when the broker registration is already healthy", async () => {
    configureAcme();
    process.env.INNGEST_DEV = "0";
    delete process.env.INNGEST_SYNC_DISABLED;
    process.env.INNGEST_EVENT_KEY = "evt_system_live_7Qm8Np2Rs4Tu6Vw9";
    process.env.INNGEST_SIGNING_KEY = "sign_system_live_8Rn9Pq3St5Uv7Wx1";
    process.env.INNGEST_SERVE_ORIGIN = "https://agents.platform.example";
    const client = getTenantInngest("acme");
    const activationFn = client.createFunction(
      { id: "factory-reconcile-activation", triggers: { event: "acme/ACTIVATE" } },
      async () => ({ ok: true }),
    );
    initInngestRegistry({
      systemBase: [],
      systemCodeAgent: [],
      tenants: [{ slug: "acme", fns: [activationFn] }],
    });
    const registered = listRegisteredApps();
    for (const app of registered) {
      __recordInngestSyncEvidenceForTests({
        slug: app.slug,
        appId: app.appId,
        fnCount: app.fnCount,
        ok: app.slug !== "acme",
      });
    }
    expect(inngestRegistrationStatus(registered)).toMatchObject({
      ok: false,
      unsynced: ["acme"],
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v0/gql")) {
        return new Response(JSON.stringify({
          data: {
            apps: registered.map((app) => ({
              name: app.appId,
              url: app.slug === "acme"
                ? "https://agents.acme.example/inngest/acme"
                : "https://agents.platform.example/inngest",
              error: null,
              connected: true,
              functionCount: app.fnCount,
            })),
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("registered", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileApps()).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agents.acme.example/inngest/acme",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(inngestRegistrationStatus(registered)).toMatchObject({
      ok: true,
      syncedApps: registered.length,
      unsynced: [],
    });
  });

  it("rejects the Inngest Dev Server in a production process", () => {
    configureAcme();
    process.env.INNGEST_DEV = "1";
    const status = tenantInngestConfigStatus("acme");
    expect(status).toMatchObject({
      readiness: "blocked",
      mode: "invalid",
    });
    expect(status.note).toMatch(/not a production durable executor/);
    expect(() => getTenantInngest("acme")).toThrow(
      TenantInngestConfigurationError,
    );
  });

  it("fails closed when a referenced secret is absent", () => {
    configureAcme();
    delete process.env.ACME_SIGNING_KEY;
    const status = tenantInngestConfigStatus("acme");
    expect(status.readiness).toBe("blocked");
    expect(status.missing).toContain("ACME_SIGNING_KEY");
    // A cached client may not bypass a removed/invalid env reference.
    expect(() => getTenantInngest("acme")).toThrow(
      TenantInngestConfigurationError,
    );
    expect(() => getTenantInngest("acme-missing-signing")).toThrow(
      TenantInngestConfigurationError,
    );
  });

  it("reports blocked readiness without probing the broker", async () => {
    process.env.NODE_ENV = "production";
    delete process.env[TENANT_INNGEST_CONFIG_REFS_ENV];
    let fetchCalls = 0;
    const health = await checkInngest(
      (async () => {
        fetchCalls++;
        return new Response("ok");
      }) as typeof fetch,
      ["unconfigured-production-tenant"],
    );
    expect(health).toMatchObject({
      ok: false,
      readiness: "blocked",
      blockedTenants: ["unconfigured-production-tenant"],
    });
    expect(fetchCalls).toBe(0);
  });

  it("labels shared local development configuration as degraded", () => {
    process.env.NODE_ENV = "development";
    delete process.env[TENANT_INNGEST_CONFIG_REFS_ENV];
    const status = tenantInngestConfigStatus("local-tenant");
    expect(status).toMatchObject({
      readiness: "degraded",
      serveOrigin: expect.stringMatching(/^http:\/\//),
      baseUrl: expect.stringMatching(/^http:\/\//),
    });
  });
});
