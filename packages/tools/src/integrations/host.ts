/**
 * Integration credential resolver — dependency-injection seam.
 *
 * `@agentic/tools` must stay free of any `@agentic/db` import (it's consumed
 * by the runtime AND, potentially, lighter-weight callers). But DB-backed
 * integrations (configured in Settings → Integrations and persisted to the
 * `integrations` table) need their decrypted base-URL + API-key to reach a
 * tool handler at dispatch time.
 *
 * We solve that the same way the LLM gateway is wired (`setRuntimeGateway`):
 * apps/api injects a resolver at boot that knows how to read + decrypt the
 * tenant's integration row. Tools call `resolveIntegrationCreds(tenantSlug,
 * provider)` and get `{ base_url, api_key }` (or null when nothing is
 * configured), with NO compile-time dependency on the DB.
 *
 * The resolver is synchronous on purpose: the api's store is better-sqlite3
 * (sync) + AES-256-GCM decrypt (sync), so a tool's REST helper can call it
 * inline without turning every credential read into an await.
 */

/** Decrypted, ready-to-use credentials for one (tenant, provider) pair. */
export interface IntegrationCreds {
  /** Base URL the operator configured in Settings (no trailing slash). */
  base_url?: string;
  /** Plaintext API key, decrypted from the integration store. */
  api_key?: string;
  /**
   * Dynamic field values beyond the two first-class ones, keyed by the System
   * Profile's ConfigFieldSpec keys (region, client_secret…). Plain config and
   * decrypted extra secrets are merged; a tool reads the keys its docs declare.
   */
  fields?: Record<string, string>;
}

export type IntegrationResolver = (
  tenantSlug: string,
  provider: string,
) => IntegrationCreds | null;

let resolver: IntegrationResolver | null = null;

/**
 * Install (or clear, with `null`) the integration credential resolver.
 * Called once from apps/api bootstrap. Idempotent — last write wins.
 */
export function setIntegrationResolver(fn: IntegrationResolver | null): void {
  resolver = fn;
}

/** True when a resolver has been wired (apps/api boot ran). */
export function hasIntegrationResolver(): boolean {
  return resolver !== null;
}

/**
 * Look up decrypted credentials for `(tenantSlug, provider)`. Returns null
 * when no resolver is installed, no tenant is in scope, or the resolver
 * throws / finds nothing — callers then fall back to env defaults. A
 * resolver failure must never bubble into a tool error.
 */
export function resolveIntegrationCreds(
  tenantSlug: string | undefined,
  provider: string,
): IntegrationCreds | null {
  if (!resolver || !tenantSlug) return null;
  try {
    return resolver(tenantSlug, provider);
  } catch {
    return null;
  }
}
