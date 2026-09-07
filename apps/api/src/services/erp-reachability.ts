/**
 * Meta ERP reachability — the "is the VPN/proxy/base URL right?" check the
 * portal shows BEFORE an operator watches a run fail on it.
 *
 * The LIVE manifest's `metaerp.invoke` entries name the env var that holds
 * the base URL (`config.base_url_env`, default METAERP_BASE_URL). Each
 * distinct env var is one target: configured? and, if so, does a GET to its
 * origin get ANY HTTP answer? A 404/401 still proves the host is reachable —
 * the gateway is not required to serve GET / — while a refused connection,
 * DNS failure, TLS handshake or timeout means the ERP cannot be reached from
 * this API process at all (2026-09-07: Clash fake-IP + a VPN without DNS
 * turned every call into a TLS EOF).
 *
 * Probes are cached per URL for a short TTL so a polling portal cannot turn
 * into a connection storm against the ERP gateway.
 */

import type { ErpIntegrationStatus, ErpIntegrationTarget } from "@agentic/contracts";

const METAERP_TOOL = "metaerp.invoke";
const DEFAULT_BASE_URL_ENV = "METAERP_BASE_URL";
const DEFAULT_TTL_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 2_500;

export interface ErpProbeResult {
  reachable: boolean;
  checkedAt: number;
  error: string | null;
}

export interface ErpProbeOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const probeCache = new Map<string, ErpProbeResult>();

export function _clearErpProbeCacheForTests(): void {
  probeCache.clear();
}

function transportError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `timeout after ${timeoutMs}ms`;
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeCode =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : undefined;
  if (causeCode) return causeCode;
  if (cause instanceof Error && cause.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/** Probe one base URL (origin). Cached for `ttlMs` per URL. */
export async function probeErpBaseUrl(
  baseUrl: string,
  opts: ErpProbeOptions = {},
): Promise<ErpProbeResult> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cached = probeCache.get(baseUrl);
  if (cached && now() - cached.checkedAt < ttlMs) return cached;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let result: ErpProbeResult;
  try {
    await fetchImpl(baseUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    result = { reachable: true, checkedAt: now(), error: null };
  } catch (error) {
    result = { reachable: false, checkedAt: now(), error: transportError(error, timeoutMs) };
  }
  probeCache.set(baseUrl, result);
  return result;
}

/** `scheme://host[:port]` of a configured value, or null when it is not a URL. */
export function erpOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** env var → agent names, from the manifest's metaerp.invoke tool_use entries. */
export function erpTargetsFromManifest(agents: readonly unknown[]): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const agent = raw as { name?: unknown; tool_use?: unknown };
    const name = typeof agent.name === "string" ? agent.name : null;
    if (!name || !Array.isArray(agent.tool_use)) continue;
    for (const entry of agent.tool_use as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const tool = entry as { name?: unknown; config?: { base_url_env?: unknown } };
      if (tool.name !== METAERP_TOOL) continue;
      const env =
        typeof tool.config?.base_url_env === "string" && tool.config.base_url_env.trim()
          ? tool.config.base_url_env.trim()
          : DEFAULT_BASE_URL_ENV;
      const list = targets.get(env) ?? [];
      if (!list.includes(name)) list.push(name);
      targets.set(env, list);
    }
  }
  return targets;
}

/** Full status for one tenant's live manifest. */
export async function erpIntegrationStatus(
  agents: readonly unknown[],
  env: NodeJS.ProcessEnv,
  opts: ErpProbeOptions = {},
): Promise<ErpIntegrationStatus> {
  const grouped = erpTargetsFromManifest(agents);
  const targets: ErpIntegrationTarget[] = [];
  for (const [envName, agentNames] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const raw = env[envName]?.trim() ?? "";
    const origin = raw ? erpOrigin(raw) : null;
    if (!origin) {
      targets.push({
        env: envName,
        configured: false,
        baseUrl: null,
        reachable: null,
        checkedAt: null,
        error: raw ? "not an absolute http(s) URL" : null,
        agents: agentNames,
      });
      continue;
    }
    const probe = await probeErpBaseUrl(origin, opts);
    targets.push({
      env: envName,
      configured: true,
      baseUrl: origin,
      reachable: probe.reachable,
      checkedAt: probe.checkedAt,
      error: probe.error,
      agents: agentNames,
    });
  }
  return {
    usesErp: targets.length > 0,
    ok: targets.every((target) => target.configured && target.reachable === true),
    targets,
  };
}
