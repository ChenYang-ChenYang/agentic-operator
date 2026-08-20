/**
 * Generic connection probe — a real credentialed health call for ANY provider,
 * driven entirely by data (integration row base URL + key, System Profile
 * `credential.healthPath`). This is what removes the `healthToolFor()`
 * hardcode: providers with a first-party health tool (gohire) keep using it;
 * everyone else gets `GET {base}{healthPath ?? "/health"}` with a Bearer key.
 *
 * Trust model: the base URL is operator-configured tenant-admin input — the
 * SAME value the business tools already fetch verbatim (see gohire/rest-helper
 * ghFetch). Deliberately NOT behind the factory's SSRF-guarded safeFetch:
 * tenants legitimately probe private/LAN systems (a local Allmeta Studio, an
 * internal ATS). Guards that DO apply: http/https only, relative-path-only
 * healthPath (no "..", no absolute URL), bounded timeout, bounded body read,
 * and the decrypted key exists in memory only for the duration of the call.
 */

import { classifyHttpHealthResponse, type HttpProbeClassification } from "./probe-classify";

export interface GenericProbeInput {
  /** Operator-configured base URL (from the integration row). */
  baseUrl: string;
  /** Decrypted API key — sent as `Authorization: Bearer` when present. */
  apiKey?: string;
  /** Relative health path from the System Profile (default "/health"). */
  healthPath?: string;
  timeoutMs?: number;
}

export interface GenericProbeResult extends HttpProbeClassification {
  /** The path actually probed (never includes the key). */
  probedPath: string;
  /** HTTP status (0 = network/timeout failure before any response). */
  status: number;
}

/** Same-origin relative path: starts with "/", no whitespace, no "..". */
export function sanitizeHealthPath(path: string | undefined): string | null {
  const p = (path ?? "/health").trim();
  if (!p.startsWith("/") || /\s/.test(p) || p.includes("..") || p.startsWith("//")) return null;
  return p;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function probeHttpHealth(
  input: GenericProbeInput,
  fetcher: Fetcher = fetch,
): Promise<GenericProbeResult> {
  const path = sanitizeHealthPath(input.healthPath);
  if (!path) {
    return {
      ok: false,
      status: 0,
      probedPath: String(input.healthPath ?? ""),
      detail: `健康检查路径不合法（必须是以 / 开头的相对路径，不含 ..）：${input.healthPath}`,
    };
  }
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    return { ok: false, status: 0, probedPath: path, detail: `Base URL 不合法：${input.baseUrl}` };
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return {
      ok: false,
      status: 0,
      probedPath: path,
      detail: `Base URL 协议必须是 http/https：${base.protocol}`,
    };
  }

  const url = input.baseUrl.replace(/\/+$/, "") + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  try {
    const res = await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    // Bounded body read — a health endpoint answering megabytes is itself a
    // signal, but never buffer it all.
    const body = (await res.text()).slice(0, 4_000);
    return { ...classifyHttpHealthResponse(res.status, body), probedPath: path, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      probedPath: path,
      detail: `连接失败（网络/超时）：${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
