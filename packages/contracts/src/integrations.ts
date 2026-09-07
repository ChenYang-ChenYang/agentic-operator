import { z } from "zod";

/**
 * @agentic/contracts/integrations — shapes for the `/v1/integrations`
 * surface backing Settings → Integrations.
 *
 * An integration is a per-tenant binding to an external service (the first
 * is the GoHire ATS): a base URL + an API key. The key is encrypted at rest
 * in apps/api; it NEVER crosses this contract in plaintext on the way out —
 * responses carry only a masked fragment + `hasKey`. The plaintext is only
 * ever accepted inbound on the upsert body.
 */

/** Catalog of providers an operator can configure. Drives the "Add
 *  integration" picker; keep in sync with the GoHire tool family + any
 *  future ATS wrappers in @agentic/tools. */
export const INTEGRATION_PROVIDERS = [
  {
    id: "gohire",
    name: "GoHire",
    kind: "ATS",
    defaultBaseUrl: "https://api.gohire.io/v1",
    description:
      "GoHire applicant-tracking system. Powers the gohire* tool family (parse/match/invite) for any agent that lists them in tool_use[].",
    docsUrl: "https://gohire.io",
  },
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDERS)[number]["id"];

/**
 * Provider ids accepted by the upsert route. Deliberately NOT an enum of the
 * static catalog: any tenant System Profile may declare its own
 * `credential.provider`, and the integration row must be creatable for it
 * without a code change. Kebab-case, same grammar as profile ids.
 */
export const IntegrationProvider = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9-]*$/, "provider must be kebab-case (a-z, 0-9, -)");

export const IntegrationStatus = z.enum(["unconfigured", "ok", "error"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** Public, secret-free view of one configured integration. */
export const IntegrationPublic = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  /** Masked fragment of the key (e.g. "gh_ab…wxyz"); never the plaintext. */
  keyMasked: z.string().nullable(),
  /** True when an API key is stored for this integration. */
  hasKey: z.boolean(),
  /** Non-secret dynamic field values (region, org id…), keyed by field spec key. */
  config: z.record(z.string(), z.string()).default({}),
  /** KEYS of stored extra secret fields (values never cross the wire). */
  secretKeysStored: z.array(z.string()).default([]),
  status: IntegrationStatus,
  lastCheckedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type IntegrationPublic = z.infer<typeof IntegrationPublic>;

export const ListIntegrationsResponse = z.object({
  integrations: z.array(IntegrationPublic),
  /** Providers the operator can add: the static catalog PLUS every provider a
   *  tenant System Profile declares in `credential.provider` — so a profiled
   *  system is configurable with zero code changes. */
  available: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      defaultBaseUrl: z.string().default(""),
      description: z.string().default(""),
      docsUrl: z.string().optional(),
      /** "catalog" = built-in static entry; "profile" = derived from a System Profile. */
      source: z.enum(["catalog", "profile"]).default("catalog"),
    }),
  ),
});
export type ListIntegrationsResponse = z.infer<typeof ListIntegrationsResponse>;

/**
 * Reachability of one Meta ERP base URL the tenant's LIVE workflow depends on
 * (`GET /v1/integrations/erp/status`). One row per `base_url_env` the
 * manifest's `metaerp.invoke` entries name — usually just METAERP_BASE_URL.
 * The portal shows a banner while `ok` is false so an operator learns that
 * the VPN/proxy/address is wrong BEFORE watching a run fail on it.
 */
export const ErpIntegrationTarget = z.object({
  /** Env var the manifest binds (`tool_use[].config.base_url_env`). */
  env: z.string(),
  configured: z.boolean(),
  /** Origin only (`scheme://host[:port]`) — never path, query or credentials. */
  baseUrl: z.string().nullable(),
  /** null while not configured (nothing to probe). */
  reachable: z.boolean().nullable(),
  checkedAt: z.number().nullable(),
  /** Transport failure summary when unreachable (e.g. `ECONNREFUSED`). */
  error: z.string().nullable(),
  /** Manifest agent names that invoke this ERP. */
  agents: z.array(z.string()),
});
export type ErpIntegrationTarget = z.infer<typeof ErpIntegrationTarget>;

export const ErpIntegrationStatus = z.object({
  /** false when no live agent calls metaerp.invoke — nothing to warn about. */
  usesErp: z.boolean(),
  /** true when every target is configured and reachable (or none is used). */
  ok: z.boolean(),
  targets: z.array(ErpIntegrationTarget),
});
export type ErpIntegrationStatus = z.infer<typeof ErpIntegrationStatus>;

/**
 * Upsert one integration. Keyed on (tenant, provider): a second PUT for the
 * same provider updates the existing row. `apiKey` is optional on update —
 * omit it to leave the stored key untouched (so the operator can change just
 * the base URL without re-entering the secret). Send an empty string to
 * clear the key.
 */
export const UpsertIntegrationBody = z.object({
  provider: IntegrationProvider,
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().max(2048).optional(),
  apiKey: z.string().max(4096).optional(),
  /**
   * Dynamic field values keyed by ConfigFieldSpec.key (beyond the first-class
   * baseUrl/apiKey). The server routes each value into the plain config bag or
   * the encrypted secrets bag according to the field's spec — unknown keys are
   * treated as SECRET (fail closed). Empty string deletes the stored value;
   * omitted keys stay untouched.
   */
  fields: z.record(z.string().max(120), z.string().max(8192)).optional(),
  enabled: z.boolean().optional(),
});
export type UpsertIntegrationBody = z.infer<typeof UpsertIntegrationBody>;

/** Result of a connection test (calls the provider's health endpoint). */
export const TestIntegrationResponse = z.object({
  ok: z.boolean(),
  status: IntegrationStatus,
  message: z.string().nullable(),
  checkedAt: z.number(),
});
export type TestIntegrationResponse = z.infer<typeof TestIntegrationResponse>;
