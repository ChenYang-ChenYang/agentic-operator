/**
 * Inngest client factory — ONE Inngest app per tenant.
 *
 * Each tenant slug maps to its own Inngest app `${APP_PREFIX}-${slug}` (default
 * prefix `agentic-operator`), served at a distinct URL:
 *   - the platform/system app `agentic-operator-__system` is served at `/inngest`
 *     (the inngest-cli `-u .../inngest` auto-discovers it), and hosts helloFn,
 *     the system-cron heartbeat, the retention sweep, code-agent functions, and
 *     the global `system/PING` event.
 *   - every tenant app `agentic-operator-<slug>` is served at `/inngest/<slug>`
 *     and is registered with the dev/cloud Inngest by an explicit PUT self-sync
 *     (`apps/api/src/services/inngest-sync.ts`) — the cli only auto-discovers the
 *     one base URL, never the per-tenant sub-paths.
 *
 * WHY one app per tenant: the app boundary is what Inngest groups, syncs, and
 * shows online/offline. It does NOT partition the event bus (events are
 * environment-wide and fan out by NAME) nor add concurrency isolation (that is
 * the per-function `concurrency.key`). So tenant isolation of routing/concurrency
 * already comes from the `${slug}/${EVENT}` namespacing + the `${slug}:subject`
 * key — splitting apps buys per-tenant sync lifecycle, dashboard health, and
 * (future) per-tenant signing keys / process isolation. See
 * `docs/design/` / the per-tenant-inngest-apps design.
 *
 * Tenant credentials are resolved from env *references* in
 * `INNGEST_TENANT_CONFIG_REFS`; secret values never live in manifests or the
 * database. Production tenants without a complete mapping fail closed.
 *
 * v4 NOTE: `EventSchemas().fromRecord<EventMap>()` was removed in inngest@4. We
 * register without a global schema and rely on per-agent manifests + the
 * `${tenant}/${EVENT}` naming convention; `EventMap` below is documentation only.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Inngest } from "inngest";
import { isFactorySandboxTenant } from "./sandbox-mode";

/**
 * Event-name → payload type map. Retained as documentation for what shapes
 * flow through the system; not handed to the SDK in v4.
 *
 * Tenant-namespaced event names are written as `${tenant}/${EVENT_NAME}`
 * (e.g. `zhaopin/REQUIREMENT_LOGGED`, `zhaopin/task.resolved`) per DESIGN.md §6.
 * `system/PING` is the one platform-global event (served by the __system app).
 */
export type EventMap = {
  "system/PING": { data: { from?: string } };
  [k: `${string}/${string}`]: { data: Record<string, unknown> };
};

/**
 * App-id prefix. Configurable so staging + prod can coexist on one dev Inngest
 * without app-id collisions. Defaults to `agentic-operator`.
 */
const APP_PREFIX =
  (process.env.INNGEST_APP_PREFIX ?? "").trim() || "agentic-operator";

/**
 * Legacy-main compatibility. The old AO app was hard-coded as
 * `agentic-operator-main`; assigning a tenant slug here makes the new runtime
 * appear in Inngest with that legacy app id while preserving the
 * one-app-per-tenant model for every other tenant.
 */
const MAIN_TENANT_SLUG = (process.env.INNGEST_MAIN_TENANT ?? "").trim();
const MAIN_TENANT_APP_ID =
  (process.env.INNGEST_MAIN_APP_ID ?? "").trim() || `${APP_PREFIX}-main`;

/**
 * The platform/system app slug. Hosts helloFn, the system-cron heartbeat, the
 * retention sweep, code-agent functions, and the global `system/PING` event.
 * Served at the BASE `/inngest` path (no slug) so the inngest-cli `-u` flag
 * auto-discovers it.
 */
export const SYSTEM_SLUG = "__system";

/** `agentic-operator-<slug>` — the Inngest app id for a tenant. */
export function appIdForTenant(slug: string): string {
  if (isFactorySandboxTenant(slug)) {
    return `${sandboxAppPrefix()}-${slug}`;
  }
  if (slug !== SYSTEM_SLUG && slug === MAIN_TENANT_SLUG) {
    return MAIN_TENANT_APP_ID;
  }
  return `${APP_PREFIX}-${slug}`;
}

/** Tenant slug that should occupy the legacy/base Inngest app, if configured. */
export function mainTenantSlug(): string | null {
  return MAIN_TENANT_SLUG.length > 0 ? MAIN_TENANT_SLUG : null;
}

export function isMainTenant(slug: string): boolean {
  return slug !== SYSTEM_SLUG && slug === MAIN_TENANT_SLUG;
}

export type TenantInngestReadiness = "ready" | "degraded" | "blocked";
export type InngestDeploymentMode =
  | "development"
  | "cloud"
  | "self_hosted"
  | "invalid";

export interface TenantInngestConfigStatus {
  slug: string;
  readiness: TenantInngestReadiness;
  /** The actual durable-executor profile. `development` is never valid when
   * NODE_ENV=production; Cloud deliberately has no INNGEST_BASE_URL. */
  mode: InngestDeploymentMode;
  source:
    | "tenant_env_refs"
    | "sandbox_env_refs"
    | "shared_env"
    | "local_defaults"
    | "invalid";
  eventKeyConfigured: boolean;
  signingKeyConfigured: boolean;
  serveOrigin: string | null;
  baseUrl: string | null;
  missing: string[];
  /** Explicit, externally implemented deletion contract for ephemeral apps. */
  cleanupMode?: "custom_delete_control";
  /** True when the non-secret endpoint reference and credential resolve. */
  deleteControlConfigured?: boolean;
  /** True when authoritative broker registry operations are mediated by an
   * authenticated control gateway. Required for durable sandbox brokers. */
  controlGatewayConfigured?: boolean;
  note?: string;
}

export interface SandboxInngestIsolationStatus {
  isolated: boolean;
  missing: string[];
}

export const TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA =
  "agent-factory-target-inngest-isolation/v1" as const;

/** Secret-free identity issued by the trusted Factory control plane. The
 * remote workload compares its dedicated sandbox configuration against these
 * fingerprints without receiving the target tenant's production secrets. */
export interface TargetInngestIsolationIdentity {
  schema: typeof TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA;
  targetTenantSlug: string;
  eventChannelFingerprint: string;
  signatureChannelFingerprint: string;
  brokerFingerprint: string;
  appNamespaceFingerprint: string;
}

interface TenantInngestEnvRefs {
  eventKeyEnv: string;
  signingKeyEnv: string;
  serveOriginEnv: string;
  baseUrlEnv?: string;
}

interface ResolvedTenantInngestConfig {
  status: TenantInngestConfigStatus;
  eventKey?: string;
  signingKey?: string;
  /** Explicit SDK development mode is permitted only for the isolated
   * external sandbox workload. It is never inferred from NODE_ENV. */
  sandboxDevMode?: boolean;
  sandboxDeleteControl?: {
    urlTemplate: string;
    token: string;
  };
  sandboxControlBearer?: string;
}

/**
 * JSON object keyed by tenant slug. Values contain ENVIRONMENT VARIABLE NAMES,
 * never credentials, for example:
 *
 * {"acme":{"eventKeyEnv":"ACME_INNGEST_EVENT_KEY",
 *          "signingKeyEnv":"ACME_INNGEST_SIGNING_KEY",
 *          "serveOriginEnv":"ACME_INNGEST_SERVE_ORIGIN"}}
 */
export const TENANT_INNGEST_CONFIG_REFS_ENV = "INNGEST_TENANT_CONFIG_REFS";
/**
 * Dedicated env-reference contract for every nonce-bearing Agent Factory
 * sandbox app. The JSON contains env NAMES, never secret values:
 *
 * {"eventKeyEnv":"FACTORY_SB_EVENT_KEY",
 *  "signingKeyEnv":"FACTORY_SB_SIGNING_KEY",
 *  "serveOriginEnv":"FACTORY_SB_SERVE_ORIGIN",
 *  "baseUrlEnv":"FACTORY_SB_BASE_URL",
 *  "appPrefixEnv":"FACTORY_SB_APP_PREFIX",
 *  "devModeEnv":"FACTORY_SB_DEV_MODE",
 *  "controlBearerEnv":"FACTORY_SB_CONTROL_BEARER",
 *  "cleanupMode":"custom_delete_control",
 *  "deleteControlUrlEnv":"FACTORY_SB_DELETE_URL",
 *  "deleteControlTokenEnv":"FACTORY_SB_DELETE_TOKEN"}
 *
 * The factory requires a dedicated self-host test broker plus an operator-owned
 * control endpoint that really deletes one app identity. The URL value must
 * contain `{appId}` exactly once and the token remains in its referenced env.
 * A surviving zero-function app is not called deleted. No undocumented
 * Inngest Cloud/UI endpoint is guessed.
 */
export const SANDBOX_INNGEST_CONFIG_REFS_ENV =
  "INNGEST_SANDBOX_CONFIG_REFS";

export class TenantInngestConfigurationError extends Error {
  readonly status: TenantInngestConfigStatus;

  constructor(status: TenantInngestConfigStatus) {
    super(
      `Inngest configuration for tenant '${status.slug}' is ${status.readiness}: ${
        status.note ?? (status.missing.join(", ") || "invalid configuration")
      }`,
    );
    this.name = "TenantInngestConfigurationError";
    this.status = status;
  }
}

const ENV_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_SECRET_RE =
  /(?:^|[-_])(test|fake|mock|changeme|example|sample|dev)(?:$|[-_])/i;

function referencedSecret(name: string): { value?: string; error?: string } {
  const direct = process.env[name]?.trim();
  const file = process.env[`${name}_FILE`]?.trim();
  if (direct && file) {
    return { error: `${name} and ${name}_FILE cannot both be configured` };
  }
  if (!file) return direct ? { value: direct } : {};
  if (!path.isAbsolute(file)) return { error: `${name}_FILE must be absolute` };
  try {
    const raw = readFileSync(file, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
      return { error: `${name}_FILE exceeds 16 KiB` };
    }
    const value = raw.trim();
    return value ? { value } : { error: `${name}_FILE is empty` };
  } catch {
    return { error: `${name}_FILE is unreadable` };
  }
}

function normalizeHttpOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface InngestDeploymentStatus {
  ok: boolean;
  mode: InngestDeploymentMode;
  baseUrl: string | null;
  note?: string;
}

/**
 * Resolve the broker profile without conflating the local Dev Server with a
 * production self-host. Inngest Cloud intentionally uses the SDK's distinct
 * managed API/event endpoints, so INNGEST_BASE_URL must remain unset there.
 */
export function inngestDeploymentStatus(
  env: Record<string, string | undefined> = process.env,
): InngestDeploymentStatus {
  const rawDev = env.INNGEST_DEV?.trim() ?? "";
  if (rawDev && rawDev !== "0" && rawDev !== "1") {
    return {
      ok: false,
      mode: "invalid",
      baseUrl: null,
      note: "INNGEST_DEV must be 0, 1, or unset",
    };
  }
  const baseUrl = normalizeHttpOrigin(env.INNGEST_BASE_URL);
  if (env.INNGEST_BASE_URL?.trim() && !baseUrl) {
    return {
      ok: false,
      mode: "invalid",
      baseUrl: null,
      note: "INNGEST_BASE_URL must be an absolute http(s) origin",
    };
  }
  if (rawDev === "1") {
    if (env.NODE_ENV === "production") {
      return {
        ok: false,
        mode: "invalid",
        baseUrl,
        note: "the Inngest Dev Server is not a production durable executor",
      };
    }
    return {
      ok: true,
      mode: "development",
      baseUrl: baseUrl ?? "http://localhost:8288",
    };
  }
  if (baseUrl) return { ok: true, mode: "self_hosted", baseUrl };
  if (env.NODE_ENV === "production") {
    return { ok: true, mode: "cloud", baseUrl: null };
  }
  return {
    ok: true,
    mode: "development",
    baseUrl: "http://localhost:8288",
    note: "local development broker defaults are active",
  };
}

function parseTenantRefs():
  | { ok: true; refs: Record<string, unknown> }
  | { ok: false; error: string } {
  const raw = process.env[TENANT_INNGEST_CONFIG_REFS_ENV]?.trim();
  if (!raw) return { ok: true, refs: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `${TENANT_INNGEST_CONFIG_REFS_ENV} must be a JSON object`,
      };
    }
    return { ok: true, refs: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      error: `${TENANT_INNGEST_CONFIG_REFS_ENV} is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function asTenantRefs(
  value: unknown,
): { ok: true; refs: TenantInngestEnvRefs } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "tenant entry must be an object of env references",
    };
  }
  const candidate = value as Record<string, unknown>;
  const required = ["eventKeyEnv", "signingKeyEnv", "serveOriginEnv"] as const;
  for (const field of required) {
    if (
      typeof candidate[field] !== "string" ||
      !ENV_REF_RE.test(candidate[field])
    ) {
      return { ok: false, error: `${field} must name an environment variable` };
    }
  }
  if (
    candidate.baseUrlEnv !== undefined &&
    (typeof candidate.baseUrlEnv !== "string" ||
      !ENV_REF_RE.test(candidate.baseUrlEnv))
  ) {
    return { ok: false, error: "baseUrlEnv must name an environment variable" };
  }
  return {
    ok: true,
    refs: {
      eventKeyEnv: candidate.eventKeyEnv as string,
      signingKeyEnv: candidate.signingKeyEnv as string,
      serveOriginEnv: candidate.serveOriginEnv as string,
      ...(candidate.baseUrlEnv
        ? { baseUrlEnv: candidate.baseUrlEnv as string }
        : {}),
    },
  };
}

function parseSandboxRefs():
  | {
      ok: true;
      refs: TenantInngestEnvRefs & {
      baseUrlEnv: string;
      appPrefixEnv: string;
      devModeEnv?: string;
      controlBearerEnv?: string;
      cleanupMode: "custom_delete_control";
        deleteControlUrlEnv: string;
        deleteControlTokenEnv: string;
      };
    }
  | { ok: false; error: string } {
  const raw = process.env[SANDBOX_INNGEST_CONFIG_REFS_ENV]?.trim();
  if (!raw) {
    return {
      ok: false,
      error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV} is required for ephemeral Agent Factory apps`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV} is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const decoded = asTenantRefs(parsed);
  if (!decoded.ok) return decoded;
  if (!decoded.refs.baseUrlEnv) {
    return {
      ok: false,
      error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV}.baseUrlEnv must name a dedicated self-host test broker`,
    };
  }
  const candidate = parsed as Record<string, unknown>;
  const cleanupMode = candidate.cleanupMode;
  if (cleanupMode !== "custom_delete_control") {
    return {
      ok: false,
      error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV}.cleanupMode must be 'custom_delete_control'`,
    };
  }
  for (const field of ["appPrefixEnv", "deleteControlUrlEnv", "deleteControlTokenEnv"] as const) {
    if (typeof candidate[field] !== "string" || !ENV_REF_RE.test(candidate[field])) {
      return {
        ok: false,
        error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV}.${field} must name an environment variable`,
      };
    }
  }
  if (
    candidate.devModeEnv !== undefined &&
    (typeof candidate.devModeEnv !== "string" ||
      !ENV_REF_RE.test(candidate.devModeEnv))
  ) {
    return {
      ok: false,
      error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV}.devModeEnv must name an environment variable`,
    };
  }
  if (
    candidate.controlBearerEnv !== undefined
    && (typeof candidate.controlBearerEnv !== "string"
      || !ENV_REF_RE.test(candidate.controlBearerEnv))
  ) {
    return {
      ok: false,
      error: `${SANDBOX_INNGEST_CONFIG_REFS_ENV}.controlBearerEnv must name an environment variable`,
    };
  }
  return {
    ok: true,
    refs: {
      ...decoded.refs,
      baseUrlEnv: decoded.refs.baseUrlEnv,
      appPrefixEnv: candidate.appPrefixEnv as string,
      ...(candidate.devModeEnv
        ? { devModeEnv: candidate.devModeEnv as string }
        : {}),
      ...(candidate.controlBearerEnv
        ? { controlBearerEnv: candidate.controlBearerEnv as string }
        : {}),
      cleanupMode,
      deleteControlUrlEnv: candidate.deleteControlUrlEnv as string,
      deleteControlTokenEnv: candidate.deleteControlTokenEnv as string,
    },
  };
}

function configuredProductionSecrets(): Set<string> {
  const values = new Set<string>();
  for (const name of ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "INNGEST_API_KEY"] as const) {
    const value = referencedSecret(name).value;
    if (value) values.add(value);
  }
  const parsed = parseTenantRefs();
  if (!parsed.ok) return values;
  for (const entry of Object.values(parsed.refs)) {
    const decoded = asTenantRefs(entry);
    if (!decoded.ok) continue;
    for (const name of [decoded.refs.eventKeyEnv, decoded.refs.signingKeyEnv]) {
      const value = referencedSecret(name).value;
      if (value) values.add(value);
    }
  }
  return values;
}

function configuredProductionBaseUrls(): Set<string> {
  const values = new Set<string>();
  const shared = normalizeHttpOrigin(process.env.INNGEST_BASE_URL);
  if (shared) values.add(shared);
  const parsed = parseTenantRefs();
  if (!parsed.ok) return values;
  for (const entry of Object.values(parsed.refs)) {
    const decoded = asTenantRefs(entry);
    if (!decoded.ok) continue;
    const resolved = normalizeHttpOrigin(
      decoded.refs.baseUrlEnv
        ? process.env[decoded.refs.baseUrlEnv]
        : process.env.INNGEST_BASE_URL,
    );
    if (resolved) values.add(resolved);
  }
  return values;
}

const APP_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function sandboxAppPrefix(): string {
  const decoded = parseSandboxRefs();
  if (!decoded.ok) throw new Error("sandbox app prefix is unavailable because sandbox configuration is invalid");
  const value = process.env[decoded.refs.appPrefixEnv]?.trim();
  if (
    !value ||
    !APP_PREFIX_RE.test(value) ||
    value === APP_PREFIX ||
    value === MAIN_TENANT_APP_ID
  ) {
    throw new Error("sandbox app prefix is missing, invalid, or shared with production");
  }
  return value;
}

function validDeleteControlTemplate(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  const template = value.trim();
  if (
    template.split("{appId}").length !== 2 ||
    /[{}]/.test(template.replace("{appId}", ""))
  ) return false;
  try {
    const parsed = new URL(template.replace("{appId}", "sandbox-app-id"));
    const loopbackHttp = parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1"
        || parsed.hostname === "[::1]"
        || parsed.hostname === "::1");
    const internalControlOrigin = normalizeHttpOrigin(
      process.env.SANDBOX_INTERNAL_CONTROL_ORIGIN,
    );
    const explicitIsolatedWorkloadHttp = parsed.protocol === "http:"
      && process.env.SANDBOX_RUNNER_ROLE === "workload"
      && process.env.AGENTIC_PROCESS_ROLE === "sandbox-runner-workload"
      && process.env.SANDBOX_RUNNER_EGRESS_MODE === "deny_all"
      && internalControlOrigin !== null
      && parsed.origin === internalControlOrigin;
    return (
      (parsed.protocol === "https:" ||
        (process.env.NODE_ENV !== "production" && parsed.protocol === "http:") ||
        loopbackHttp ||
        explicitIsolatedWorkloadHttp) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function resolveSandboxInngestConfig(slug: string): ResolvedTenantInngestConfig {
  const deployment = inngestDeploymentStatus();
  if (!deployment.ok) {
    return blockedStatus(
      slug,
      ["INNGEST_DEV/INNGEST_BASE_URL"],
      deployment.note ?? "invalid Inngest deployment profile",
    );
  }
  const decoded = parseSandboxRefs();
  if (!decoded.ok) {
    return blockedStatus(
      slug,
      [SANDBOX_INNGEST_CONFIG_REFS_ENV],
      decoded.error,
    );
  }
  const refs = decoded.refs;
  const eventKeyRef = referencedSecret(refs.eventKeyEnv);
  const signingKeyRef = referencedSecret(refs.signingKeyEnv);
  const deleteControlTokenRef = referencedSecret(refs.deleteControlTokenEnv);
  const controlBearerRef = refs.controlBearerEnv
    ? referencedSecret(refs.controlBearerEnv)
    : {};
  const eventKey = eventKeyRef.value;
  const signingKey = signingKeyRef.value;
  const rawServeOrigin = process.env[refs.serveOriginEnv]?.trim();
  const rawBaseUrl = process.env[refs.baseUrlEnv]?.trim();
  const sandboxPrefix = process.env[refs.appPrefixEnv]?.trim();
  const deleteControlUrl = process.env[refs.deleteControlUrlEnv]?.trim();
  const deleteControlToken = deleteControlTokenRef.value;
  const controlBearer = controlBearerRef.value;
  const rawSandboxDevMode = refs.devModeEnv
    ? process.env[refs.devModeEnv]?.trim() ?? ""
    : "";
  const sandboxDevMode = rawSandboxDevMode === "1";
  const isolatedWorkloadRole =
    process.env.SANDBOX_RUNNER_ROLE === "workload" &&
    process.env.AGENTIC_PROCESS_ROLE === "sandbox-runner-workload" &&
    process.env.SANDBOX_RUNNER_EGRESS_MODE === "deny_all";
  const serveOrigin = normalizeHttpOrigin(rawServeOrigin);
  const configuredBaseUrl = normalizeHttpOrigin(rawBaseUrl);
  const baseUrl = configuredBaseUrl;
  const mode: InngestDeploymentMode = sandboxDevMode
    ? "development"
    : "self_hosted";
  const missing: string[] = [];
  if (eventKeyRef.error) missing.push(eventKeyRef.error);
  if (signingKeyRef.error) missing.push(signingKeyRef.error);
  if (deleteControlTokenRef.error) missing.push(deleteControlTokenRef.error);
  if (controlBearerRef.error) missing.push(controlBearerRef.error);
  if (!eventKey) missing.push(refs.eventKeyEnv);
  if (!signingKey) missing.push(refs.signingKeyEnv);
  if (!rawServeOrigin || !serveOrigin) missing.push(refs.serveOriginEnv);
  if (!rawBaseUrl || !configuredBaseUrl) {
    missing.push(refs.baseUrlEnv);
  }
  if (
    rawSandboxDevMode !== "" &&
    rawSandboxDevMode !== "0" &&
    rawSandboxDevMode !== "1"
  ) {
    missing.push(`${refs.devModeEnv} (must be empty, 0, or 1)`);
  }
  if (sandboxDevMode && !isolatedWorkloadRole) {
    missing.push(
      "sandbox Inngest dev mode requires the isolated external workload role with deny_all egress",
    );
  }
  if (
    !sandboxPrefix ||
    !APP_PREFIX_RE.test(sandboxPrefix) ||
    sandboxPrefix === APP_PREFIX ||
    sandboxPrefix === MAIN_TENANT_APP_ID
  ) {
    missing.push(`${refs.appPrefixEnv} (distinct sandbox app prefix)`);
  }
  if (!deleteControlUrl || !validDeleteControlTemplate(deleteControlUrl)) {
    missing.push(`${refs.deleteControlUrlEnv} (absolute URL template containing {appId})`);
  }
  if (!deleteControlToken) missing.push(refs.deleteControlTokenEnv);
  if (!sandboxDevMode && !refs.controlBearerEnv) {
    missing.push("sandbox broker controlBearerEnv");
  } else if (!sandboxDevMode && !controlBearer) {
    missing.push(refs.controlBearerEnv!);
  }
  if (configuredBaseUrl && configuredProductionBaseUrls().has(configuredBaseUrl)) {
    missing.push("sandbox broker URL must not reuse any production tenant broker");
  }
  if (eventKey && signingKey && eventKey === signingKey) {
    missing.push("sandbox event/signing keys must be different values");
  }
  const productionSecrets = configuredProductionSecrets();
  if (
    (eventKey && productionSecrets.has(eventKey)) ||
    (signingKey && productionSecrets.has(signingKey)) ||
    (deleteControlToken && productionSecrets.has(deleteControlToken)) ||
    (controlBearer && productionSecrets.has(controlBearer))
  ) {
    missing.push("sandbox Inngest keys must not reuse any production tenant key");
  }
  if (
    process.env.NODE_ENV === "production" &&
    eventKey &&
    (eventKey.length < 16 || PLACEHOLDER_SECRET_RE.test(eventKey))
  ) {
    missing.push(`${refs.eventKeyEnv} (placeholder/too short)`);
  }
  if (
    process.env.NODE_ENV === "production" &&
    signingKey &&
    (signingKey.length < 16 || PLACEHOLDER_SECRET_RE.test(signingKey))
  ) {
    missing.push(`${refs.signingKeyEnv} (placeholder/too short)`);
  }
  if (
    process.env.NODE_ENV === "production" &&
    deleteControlToken &&
    (deleteControlToken.length < 16 || PLACEHOLDER_SECRET_RE.test(deleteControlToken))
  ) {
    missing.push(`${refs.deleteControlTokenEnv} (placeholder/too short)`);
  }
  if (
    process.env.NODE_ENV === "production"
    && controlBearer
    && (controlBearer.length < 32 || PLACEHOLDER_SECRET_RE.test(controlBearer))
  ) {
    missing.push(`${refs.controlBearerEnv} (placeholder/too short)`);
  }
  return {
    status: {
      slug,
      readiness: missing.length
        ? "blocked"
        : sandboxDevMode
          ? "degraded"
          : "ready",
      mode,
      source: missing.length ? "invalid" : "sandbox_env_refs",
      eventKeyConfigured: Boolean(eventKey),
      signingKeyConfigured: Boolean(signingKey),
      serveOrigin,
      baseUrl,
      missing,
      cleanupMode: "custom_delete_control",
      deleteControlConfigured: Boolean(deleteControlUrl && deleteControlToken),
      controlGatewayConfigured: Boolean(controlBearer),
      ...(missing.length
        ? { note: `ephemeral sandbox Inngest configuration is incomplete: ${missing.join(", ")}` }
        : sandboxDevMode
          ? {
              note:
                "isolated external sandbox uses an Inngest Dev Server; callbacks are unsigned and execution is not production-durable",
            }
          : {}),
    },
    eventKey,
    signingKey,
    ...(sandboxDevMode ? { sandboxDevMode: true } : {}),
    ...(deleteControlUrl && deleteControlToken && validDeleteControlTemplate(deleteControlUrl)
      ? { sandboxDeleteControl: { urlTemplate: deleteControlUrl, token: deleteControlToken } }
      : {}),
    ...(controlBearer ? { sandboxControlBearer: controlBearer } : {}),
  };
}

function blockedStatus(
  slug: string,
  missing: string[],
  note: string,
): ResolvedTenantInngestConfig {
  const deployment = inngestDeploymentStatus();
  return {
    status: {
      slug,
      readiness: "blocked",
      mode: deployment.mode,
      source: "invalid",
      eventKeyConfigured: false,
      signingKeyConfigured: false,
      serveOrigin: null,
      baseUrl: normalizeHttpOrigin(process.env.INNGEST_BASE_URL),
      missing,
      note,
    },
  };
}

function resolveTenantInngestConfig(slug: string): ResolvedTenantInngestConfig {
  if (isFactorySandboxTenant(slug)) {
    return resolveSandboxInngestConfig(slug);
  }
  const deployment = inngestDeploymentStatus();
  if (!deployment.ok) {
    return blockedStatus(
      slug,
      ["INNGEST_DEV/INNGEST_BASE_URL"],
      deployment.note ?? "invalid Inngest deployment profile",
    );
  }
  const parsed = parseTenantRefs();
  if (!parsed.ok)
    return blockedStatus(slug, [TENANT_INNGEST_CONFIG_REFS_ENV], parsed.error);

  const configuredEntry = parsed.refs[slug];
  if (configuredEntry !== undefined) {
    const decoded = asTenantRefs(configuredEntry);
    if (!decoded.ok) {
      return blockedStatus(
        slug,
        [TENANT_INNGEST_CONFIG_REFS_ENV],
        decoded.error,
      );
    }
    const refs = decoded.refs;
    const eventKeyRef = referencedSecret(refs.eventKeyEnv);
    const signingKeyRef = referencedSecret(refs.signingKeyEnv);
    const eventKey = eventKeyRef.value;
    const signingKey = signingKeyRef.value;
    const rawServeOrigin = process.env[refs.serveOriginEnv]?.trim();
    const rawBaseUrl = refs.baseUrlEnv
      ? process.env[refs.baseUrlEnv]?.trim()
      : process.env.INNGEST_BASE_URL?.trim();
    const serveOrigin = normalizeHttpOrigin(rawServeOrigin);
    const configuredBaseUrl = normalizeHttpOrigin(rawBaseUrl);
    const baseUrl = configuredBaseUrl ?? deployment.baseUrl;
    const tenantMode: InngestDeploymentMode = configuredBaseUrl
      ? "self_hosted"
      : deployment.mode;
    const missing: string[] = [];
    if (eventKeyRef.error) missing.push(eventKeyRef.error);
    if (signingKeyRef.error) missing.push(signingKeyRef.error);
    if (!eventKey) missing.push(refs.eventKeyEnv);
    if (!signingKey) missing.push(refs.signingKeyEnv);
    if (!rawServeOrigin || !serveOrigin) missing.push(refs.serveOriginEnv);
    if (refs.baseUrlEnv && (!rawBaseUrl || !configuredBaseUrl)) {
      missing.push(refs.baseUrlEnv);
    }
    if (
      process.env.NODE_ENV === "production" &&
      tenantMode === "cloud" &&
      serveOrigin &&
      !serveOrigin.startsWith("https://")
    ) {
      missing.push(`${refs.serveOriginEnv} (Cloud callbacks require HTTPS)`);
    }
    if (
      process.env.NODE_ENV === "production" &&
      eventKey &&
      (eventKey.length < 16 || PLACEHOLDER_SECRET_RE.test(eventKey))
    ) {
      missing.push(`${refs.eventKeyEnv} (placeholder/too short)`);
    }
    if (
      process.env.NODE_ENV === "production" &&
      signingKey &&
      (signingKey.length < 16 || PLACEHOLDER_SECRET_RE.test(signingKey))
    ) {
      missing.push(`${refs.signingKeyEnv} (placeholder/too short)`);
    }
    const localBrokerFallback = tenantMode === "development";
    const status: TenantInngestConfigStatus = {
      slug,
      readiness: missing.length
        ? "blocked"
        : localBrokerFallback
          ? "degraded"
          : "ready",
      mode: tenantMode,
      source: missing.length ? "invalid" : "tenant_env_refs",
      eventKeyConfigured: Boolean(eventKey),
      signingKeyConfigured: Boolean(signingKey),
      serveOrigin,
      baseUrl,
      missing,
      ...(missing.length
        ? {
            note: `referenced tenant Inngest configuration is incomplete: ${missing.join(", ")}`,
          }
        : localBrokerFallback
          ? {
              note: "tenant credentials configured; using the local development broker",
            }
          : {}),
    };
    return { status, eventKey, signingKey };
  }

  // The platform app follows the same secret-file contract as tenant-scoped
  // clients.  Container/orchestrator deployments should not have to inject
  // long-lived broker credentials into the inspectable process environment
  // just because this is the system app.  Direct and *_FILE forms remain
  // mutually exclusive and unreadable/oversized files fail closed.
  const eventKeyRef = referencedSecret("INNGEST_EVENT_KEY");
  const signingKeyRef = referencedSecret("INNGEST_SIGNING_KEY");
  const eventKey = eventKeyRef.value;
  const signingKey = signingKeyRef.value;
  const explicitServeOrigin = normalizeHttpOrigin(
    process.env.INNGEST_SERVE_ORIGIN,
  );
  const localServeOrigin = `http://localhost:${process.env.PORT?.trim() || "3540"}`;
  const explicitBaseUrl = normalizeHttpOrigin(process.env.INNGEST_BASE_URL);
  const production = process.env.NODE_ENV === "production";
  const missing = [
    ...(eventKeyRef.error ? [eventKeyRef.error] : []),
    ...(signingKeyRef.error ? [signingKeyRef.error] : []),
    ...(!eventKey ? ["INNGEST_EVENT_KEY"] : []),
    ...(!signingKey ? ["INNGEST_SIGNING_KEY"] : []),
    ...(!explicitServeOrigin ? ["INNGEST_SERVE_ORIGIN"] : []),
  ];
  if (
    production &&
    deployment.mode === "cloud" &&
    explicitServeOrigin &&
    !explicitServeOrigin.startsWith("https://")
  ) {
    missing.push("INNGEST_SERVE_ORIGIN (Cloud callbacks require HTTPS)");
  }

  // The platform app may use the global environment. A real tenant must have
  // its own reference mapping in production; sharing credentials is only a
  // visible development compatibility mode.
  if (production && slug !== SYSTEM_SLUG) {
    return blockedStatus(
      slug,
      [TENANT_INNGEST_CONFIG_REFS_ENV],
      `no tenant-specific Inngest env-ref mapping exists for '${slug}'`,
    );
  }
  if (production && missing.length) {
    return blockedStatus(
      slug,
      missing,
      "system Inngest configuration is incomplete",
    );
  }
  if (
    production &&
    ((eventKey &&
      (eventKey.length < 16 || PLACEHOLDER_SECRET_RE.test(eventKey))) ||
      (signingKey &&
        (signingKey.length < 16 || PLACEHOLDER_SECRET_RE.test(signingKey))))
  ) {
    return blockedStatus(
      slug,
      ["INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY"],
      "production Inngest credentials are placeholders or too short",
    );
  }

  return {
    status: {
      slug,
      readiness: production ? "ready" : "degraded",
      mode: deployment.mode,
      source:
        eventKey || signingKey || explicitServeOrigin
          ? "shared_env"
          : "local_defaults",
      eventKeyConfigured: Boolean(eventKey),
      signingKeyConfigured: Boolean(signingKey),
      serveOrigin: explicitServeOrigin ?? localServeOrigin,
      baseUrl: explicitBaseUrl ?? deployment.baseUrl,
      missing,
      ...(production
        ? {}
        : {
            note:
              slug === SYSTEM_SLUG
                ? "development/test global Inngest configuration"
                : "development/test shared Inngest configuration; production requires tenant env refs",
          }),
    },
    eventKey,
    signingKey,
  };
}

/** Safe, secret-free configuration status for health/readiness endpoints. */
export function tenantInngestConfigStatus(
  slug: string,
): TenantInngestConfigStatus {
  return resolveTenantInngestConfig(slug).status;
}

function isolationFingerprint(kind: string, value: string): string {
  return `sha256:${createHash("sha256")
    .update(`agent-factory-inngest-isolation/v1\0${kind}\0${value}`, "utf8")
    .digest("hex")}`;
}

function brokerIsolationValue(config: ResolvedTenantInngestConfig): string {
  return `${config.status.mode}:${config.status.baseUrl ?? "inngest-cloud"}`;
}

/** Resolve target credentials only in the trusted API process and immediately
 * reduce them to domain-separated fingerprints. Raw values never enter the
 * candidate bundle or the remote workload environment. */
export function tenantInngestIsolationIdentity(
  targetSlug: string,
): TargetInngestIsolationIdentity {
  const target = resolveTenantInngestConfig(targetSlug);
  if (
    !targetSlug
    || isFactorySandboxTenant(targetSlug)
    || targetSlug === SYSTEM_SLUG
    || target.status.readiness === "blocked"
    || target.status.source !== "tenant_env_refs"
    || !target.eventKey
    || !target.signingKey
  ) {
    throw new TenantInngestConfigurationError(target.status);
  }
  return {
    schema: TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA,
    targetTenantSlug: targetSlug,
    eventChannelFingerprint: isolationFingerprint("event", target.eventKey),
    signatureChannelFingerprint: isolationFingerprint("signing", target.signingKey),
    brokerFingerprint: isolationFingerprint("broker", brokerIsolationValue(target)),
    appNamespaceFingerprint: isolationFingerprint("app", appIdForTenant(targetSlug)),
  };
}

/** Development-only variant used by a signed same-host Sandbox.
 *
 * Local development tenants commonly share the platform Inngest credentials
 * instead of owning production-style tenant env refs. The Sandbox still gets
 * only fingerprints and must prove that its dedicated broker, event key,
 * signing key and App namespace differ. This function is intentionally
 * unavailable in production and therefore cannot supply promotion evidence.
 */
export function tenantInngestDiagnosticIsolationIdentity(
  targetSlug: string,
): TargetInngestIsolationIdentity {
  const target = resolveTenantInngestConfig(targetSlug);
  if (
    process.env.NODE_ENV === "production" ||
    !targetSlug ||
    isFactorySandboxTenant(targetSlug) ||
    targetSlug === SYSTEM_SLUG ||
    target.status.readiness === "blocked" ||
    (target.status.source !== "tenant_env_refs" &&
      target.status.source !== "shared_env") ||
    !target.eventKey ||
    !target.signingKey
  ) {
    throw new TenantInngestConfigurationError(target.status);
  }
  return {
    schema: TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA,
    targetTenantSlug: targetSlug,
    eventChannelFingerprint: isolationFingerprint("event", target.eventKey),
    signatureChannelFingerprint: isolationFingerprint("signing", target.signingKey),
    brokerFingerprint: isolationFingerprint("broker", brokerIsolationValue(target)),
    appNamespaceFingerprint: isolationFingerprint("app", appIdForTenant(targetSlug)),
  };
}

function validTargetIsolationIdentity(
  identity: TargetInngestIsolationIdentity | undefined,
  targetSlug: string,
): identity is TargetInngestIsolationIdentity {
  const fingerprint = /^sha256:[a-f0-9]{64}$/;
  return identity?.schema === TARGET_INNGEST_ISOLATION_IDENTITY_SCHEMA
    && identity.targetTenantSlug === targetSlug
    && fingerprint.test(identity.eventChannelFingerprint)
    && fingerprint.test(identity.signatureChannelFingerprint)
    && fingerprint.test(identity.brokerFingerprint)
    && fingerprint.test(identity.appNamespaceFingerprint);
}

/**
 * Prove the exact target tenant and one ephemeral app do not share execution
 * credentials, broker, or app namespace. The result contains only field names
 * and human-safe reasons; raw credentials never leave this module.
 */
export function sandboxInngestIsolationStatus(
  sandboxSlug: string,
  targetSlug: string,
  targetIdentity?: TargetInngestIsolationIdentity,
): SandboxInngestIsolationStatus {
  const missing: string[] = [];
  if (!isFactorySandboxTenant(sandboxSlug)) {
    return { isolated: false, missing: ["valid factory sandbox identity"] };
  }
  if (!targetSlug || isFactorySandboxTenant(targetSlug) || targetSlug === SYSTEM_SLUG) {
    return { isolated: false, missing: ["explicit non-sandbox target tenant"] };
  }
  const sandbox = resolveTenantInngestConfig(sandboxSlug);
  if (sandbox.status.readiness === "blocked" || sandbox.status.source !== "sandbox_env_refs") {
    missing.push("complete dedicated sandbox Inngest configuration");
  }
  const target = targetIdentity ? undefined : resolveTenantInngestConfig(targetSlug);
  if (targetIdentity && !validTargetIsolationIdentity(targetIdentity, targetSlug)) {
    missing.push("valid target Inngest isolation identity from the Factory control plane");
  } else if (!targetIdentity && (target!.status.readiness === "blocked" || target!.status.source !== "tenant_env_refs")) {
    missing.push(`resolvable production Inngest config for target tenant '${targetSlug}'`);
  }
  if (!sandbox.eventKey) {
    missing.push("dedicated sandbox event key");
  } else if (targetIdentity) {
    if (isolationFingerprint("event", sandbox.eventKey) === targetIdentity.eventChannelFingerprint) {
      missing.push("sandbox event key differs from target tenant");
    }
  } else if (!target!.eventKey) missing.push("separate sandbox/target event keys");
  else if (sandbox.eventKey === target!.eventKey) missing.push("sandbox event key differs from target tenant");
  if (!sandbox.signingKey) {
    missing.push("dedicated sandbox signing key");
  } else if (targetIdentity) {
    if (isolationFingerprint("signing", sandbox.signingKey) === targetIdentity.signatureChannelFingerprint) {
      missing.push("sandbox signing key differs from target tenant");
    }
  } else if (!target!.signingKey) missing.push("separate sandbox/target signing keys");
  else if (sandbox.signingKey === target!.signingKey) missing.push("sandbox signing key differs from target tenant");
  if (!sandbox.status.baseUrl) missing.push("dedicated sandbox broker URL");
  if (sandbox.status.baseUrl) {
    const sameBroker = targetIdentity
      ? isolationFingerprint("broker", brokerIsolationValue(sandbox)) === targetIdentity.brokerFingerprint
      : Boolean(target!.status.baseUrl && sandbox.status.baseUrl === target!.status.baseUrl);
    if (sameBroker) missing.push("sandbox broker differs from target tenant broker");
  }
  try {
    const sandboxAppId = appIdForTenant(sandboxSlug);
    const targetAppId = appIdForTenant(targetSlug);
    if (sandboxAppId === targetAppId || !sandboxAppId.startsWith(`${sandboxAppPrefix()}-`)) {
      missing.push("distinct sandbox app namespace");
    }
    if (
      targetIdentity
      && isolationFingerprint("app", sandboxAppId) === targetIdentity.appNamespaceFingerprint
    ) {
      missing.push("sandbox app namespace differs from target tenant");
    }
  } catch {
    missing.push("distinct sandbox app namespace");
  }
  return { isolated: missing.length === 0, missing: [...new Set(missing)] };
}

export function tenantInngestServeOrigin(slug: string): string {
  const resolved = resolveTenantInngestConfig(slug);
  if (resolved.status.readiness === "blocked" || !resolved.status.serveOrigin) {
    throw new TenantInngestConfigurationError(resolved.status);
  }
  return resolved.status.serveOrigin;
}

export function tenantInngestBaseUrl(slug: string): string {
  const resolved = resolveTenantInngestConfig(slug);
  if (resolved.status.readiness === "blocked") {
    throw new TenantInngestConfigurationError(resolved.status);
  }
  // Cloud uses distinct SDK defaults (API https://api.inngest.com and Event
  // API https://inn.gs). This control-plane origin is only used for health
  // classification; it is intentionally not passed as the SDK's shared
  // `baseUrl`, which would incorrectly redirect event publication.
  if (resolved.status.mode === "cloud") return "https://api.inngest.com";
  if (!resolved.status.baseUrl)
    throw new TenantInngestConfigurationError(resolved.status);
  return resolved.status.baseUrl;
}

/** Authorization for the sandbox broker's narrow app-registry gateway.
 * Business tenants and the local dev broker do not use this channel. */
export function tenantInngestControlHeaders(slug: string): Record<string, string> {
  const resolved = resolveTenantInngestConfig(slug);
  if (resolved.status.readiness === "blocked") {
    throw new TenantInngestConfigurationError(resolved.status);
  }
  return resolved.sandboxControlBearer
    ? { authorization: `Bearer ${resolved.sandboxControlBearer}` }
    : {};
}

/**
 * Invoke the operator-owned deletion control for one factory-issued app. This
 * is deliberately narrower than a generic HTTP delete helper: both the tenant
 * identity and app id must match the ephemeral factory namespace, redirects
 * are rejected, and no endpoint/token is accepted from manifests or callers.
 */
export async function deleteFactorySandboxApp(
  slug: string,
  appId: string,
  fetchFn: typeof fetch = fetch,
  options: { tombstoneExpiresAt?: string } = {},
): Promise<{ alreadyAbsent: boolean }> {
  if (!isFactorySandboxTenant(slug) || appId !== appIdForTenant(slug)) {
    throw new Error("sandbox delete control refused a non-ephemeral app identity");
  }
  const resolved = resolveTenantInngestConfig(slug);
  if (
    resolved.status.readiness === "blocked" ||
    resolved.status.cleanupMode !== "custom_delete_control" ||
    !resolved.sandboxDeleteControl
  ) {
    throw new TenantInngestConfigurationError(resolved.status);
  }
  const url = resolved.sandboxDeleteControl.urlTemplate.replace(
    "{appId}",
    encodeURIComponent(appId),
  );
  const tombstoneExpiresAt = options.tombstoneExpiresAt
    ?? new Date(Date.now() + 30 * 60_000).toISOString();
  if (
    !Number.isFinite(Date.parse(tombstoneExpiresAt))
    || Date.parse(tombstoneExpiresAt) <= Date.now()
    || Date.parse(tombstoneExpiresAt) > Date.now() + 30 * 24 * 60 * 60_000
  ) throw new Error("sandbox gateway tombstone expiry is invalid");
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${resolved.sandboxDeleteControl.token}`,
        Accept: "application/json",
        "x-agentic-sandbox-tombstone-expires-at": tombstoneExpiresAt,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("sandbox delete control request failed");
  }
  if (!response.ok && response.status !== 404) {
    throw new Error(`sandbox delete control rejected the request (${response.status})`);
  }
  return { alreadyAbsent: response.status === 404 };
}

const clients = new Map<string, Inngest>();
const clientConfigFingerprints = new Map<string, string>();

/**
 * The Inngest client for a tenant app, constructed once and cached per slug.
 * Construction is cheap + side-effect-free; the app is only registered with
 * Inngest when its serve endpoint is PUT-synced.
 */
export function getTenantInngest(slug: string): Inngest {
  const resolved = resolveTenantInngestConfig(slug);
  if (resolved.status.readiness === "blocked") {
    throw new TenantInngestConfigurationError(resolved.status);
  }
  // Re-resolve on every lookup so a removed/invalid env reference cannot keep
  // using a previously cached credential. Rotation replaces the client in
  // place; the fingerprint is process-private and never exposed/logged.
  const fingerprint = `${resolved.eventKey ?? ""}\u0000${resolved.signingKey ?? ""}\u0000${resolved.status.mode}\u0000${resolved.status.baseUrl ?? ""}\u0000${resolved.sandboxDevMode ? "dev" : "durable"}`;
  let c = clients.get(slug);
  if (!c || clientConfigFingerprints.get(slug) !== fingerprint) {
    c = new Inngest({
      id: appIdForTenant(slug),
      ...(resolved.eventKey ? { eventKey: resolved.eventKey } : {}),
      ...(resolved.signingKey ? { signingKey: resolved.signingKey } : {}),
      ...((resolved.status.mode === "self_hosted" || resolved.sandboxDevMode) &&
      resolved.status.baseUrl
        ? { baseUrl: resolved.status.baseUrl }
        : {}),
      ...(resolved.sandboxDevMode ? { isDev: true } : {}),
    });
    clients.set(slug, c);
    clientConfigFingerprints.set(slug, fingerprint);
  }
  return c;
}

/**
 * Every Inngest client constructed so far — one per tenant app that has had at
 * least one function registered (or been explicitly touched at boot). Used by
 * `inngest-sync.ts` to PUT-sync each app's serve endpoint.
 */
export function allTenantClients(): Array<{ slug: string; client: Inngest }> {
  return [...clients.entries()].map(([slug, client]) => ({ slug, client }));
}

/** Drop an ephemeral client's credential-bearing cache entry after unregister. */
export function disposeTenantInngestClient(slug: string): boolean {
  clientConfigFingerprints.delete(slug);
  return clients.delete(slug);
}

/**
 * 这些角色被刻意剥夺了 broker 凭据，因此不能在模块加载时去要 __system 的
 * Inngest 配置——它们拿不到，只会在容器启动瞬间崩掉。
 *
 * 判据是「这个角色有没有 broker 凭据」，不是名字前缀。曾经只豁免
 * `sandbox-runner*`，结果 production-codeact-executor 同样无凭据却不在名单里：
 * 它在 external_sandbox 拓扑下每次 `docker compose up` 都因
 * TenantInngestConfigurationError 起不来，并按依赖关系连带挡住 api。
 * 契约见 apps/api/test/isolated-role-inngest-import.test.ts。
 */
function isCredentialIsolatedRole(role: string | undefined): boolean {
  if (!role) return false;
  return (
    role.startsWith("sandbox-runner")
    || role === "production-codeact-executor"
  );
}

/**
 * Back-compat alias — the platform/system client (`agentic-operator-__system`).
 * Existing `import { inngest }` sites (helloFn, system-cron, retention,
 * code-agent fns) resolve to the __system app. Per-tenant agent + cron
 * functions bind via `getTenantInngest(slug)` instead.
 */
export const inngest = isCredentialIsolatedRole(process.env.AGENTIC_PROCESS_ROLE)
  // These roles never serve or sync the production __system App. Construct an
  // inert client without global tenant credentials so importing
  // runtime/bootstrap cannot force production secrets into the isolated
  // container. Nonce sandbox apps still use getTenantInngest(slug) and the
  // dedicated INNGEST_SANDBOX_CONFIG_REFS contract.
  ? new Inngest({ id: "agentic-factory-sandbox-runner-control" })
  : getTenantInngest(SYSTEM_SLUG);
