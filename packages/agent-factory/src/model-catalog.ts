// #7 — Live model-catalog introspection for the New API / custom OpenAI-compatible gateway.
//
// The difficulty router (model-router.ts) targets DIFFERENT models per task tier. To do that
// WITHOUT hardcoding a final list of model ids, it reads the gateway's live catalog via
// `GET {baseURL}/models` (the standard OpenAI list-models endpoint the New API serves). The
// catalog lets the router (a) validate that a configured id is actually served — so a typo'd
// or decommissioned id is dropped instead of wasting a fallback hop — and (b) DERIVE a sensible
// per-tier chain from what's actually available when a deployment hasn't pinned env chains.
//
// Fetch is cached + best-effort: it NEVER throws and NEVER blocks the brain loop. `modelChain`
// reads the cache synchronously (returns null when not yet warmed → the router just skips
// catalog validation and uses the configured/base chain as-is).

import {
  hasFactoryModelAdapter,
  resolveFactoryGateway,
} from "./stream-gateway";

let cache: { ids: string[]; at: number } | null = null;
let inflight: Promise<string[] | null> | null = null;

const ttlMs = (env: Record<string, string | undefined>) => Number(env.FACTORY_MODEL_CATALOG_TTL_MS) || 5 * 60_000;

/** The catalog ids if warmed (and not stale), else null. Synchronous — safe in the hot loop. */
export function cachedModelIds(env: Record<string, string | undefined> = process.env): string[] | null {
  if (!cache) return null;
  // Stale → kick off a non-blocking background refresh (de-duped via the inflight guard) and return
  // the still-usable stale ids, so a long run actually picks up catalog changes mid-flight.
  if (Date.now() - cache.at > ttlMs(env)) warmModelCatalog(env);
  return cache.ids;
}

/** Fetch (and cache) the gateway's served model ids. Best-effort: returns the last good cache
 *  (or null) on any failure. De-duped in-flight so concurrent runs don't stampede the endpoint. */
export async function fetchModelCatalog(
  env: Record<string, string | undefined> = process.env,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<string[] | null> {
  // The API's central tenant gateway owns catalog/routing discovery. Never
  // bypass it with a second process-env credentialed /models request.
  if (hasFactoryModelAdapter()) return cache?.ids ?? null;
  if (!opts.force && cache && Date.now() - cache.at < ttlMs(env)) return cache.ids;
  if (inflight) return inflight;
  // Catalog discovery is optional.  A deployment with no gateway credential
  // must simply skip the HTTP request; it should not be forced to choose a
  // model merely to discover that no authenticated request can be made.
  const configuredKey = (
    env.FACTORY_GATEWAY_API_KEY ||
    env.CUSTOM_LLM_API_KEY ||
    env.OPENAI_API_KEY ||
    ""
  ).trim();
  if (!configuredKey) return cache?.ids ?? null;
  const { baseURL, apiKey } = resolveFactoryGateway(env);
  if (!apiKey) return cache?.ids ?? null;
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const timeoutMs = Number(env.FACTORY_MODEL_CATALOG_TIMEOUT_MS) || 4000;
  inflight = (async () => {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return cache?.ids ?? null;
      const body = (await r.json()) as { data?: Array<{ id?: unknown }> };
      const ids = Array.isArray(body?.data)
        ? body.data.map((m) => String(m?.id ?? "")).filter(Boolean)
        : [];
      if (ids.length) {
        cache = { ids, at: Date.now() };
        return ids;
      }
      return cache?.ids ?? null;
    } catch {
      return cache?.ids ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Fire-and-forget warm-up — call at run start so the cache is populated for later turns. */
export function warmModelCatalog(env: Record<string, string | undefined> = process.env): void {
  void fetchModelCatalog(env).catch(() => {});
}

/** Test-only: reset the module cache. */
export function __resetModelCatalog(): void {
  cache = null;
  inflight = null;
}
