/**
 * Probe-failure classification — turn a health-tool error into an honest
 * connection verdict.
 *
 * The one case we reclassify: HTTP 404 with the framework's "Cannot GET
 * /health" no-route signature. That response PROVES the server is up, DNS/TLS
 * work and the request was parsed — this path just has no /health route.
 * Treating it as a hard failure told operators their reachable server was
 * broken. Verified live 2026-07-22 against gohire.top: a base URL missing its
 * path prefix (`https://api.gohire.top` instead of `…/api/v1`) produces
 * exactly this signature, while the prefixed /health returns 200 — so the
 * note steers the operator to check for a missing prefix rather than
 * pretending everything is perfect.
 *
 * Everything else stays a failure: network errors (status 0), 401/403
 * (credential rejected), 5xx, and 404s WITHOUT the no-route signature (which
 * can mean a wrong host entirely). Both conditions are required — fail
 * closed on ambiguity.
 */

import { redactHarnessTelemetryText } from "./ontocode-telemetry-redaction";

// ── Probe detail redaction ──────────────────────────────────────────────────
// A probe carries a DECRYPTED credential to a third party. Whatever comes back
// — a response body snippet, a tool error message that embeds that body — is
// persisted on the profile/integration row and returned to the caller, so the
// single most common auth-error shape ("we rejected this key: <key>") is also
// the shape that republishes it. Every probe branch sends its operator-facing
// detail through here.
//
// This composes the workspace's canonical telemetry boundary rather than
// competing with it: that boundary already knows about `scheme://user:pw@host`,
// e-mail and phone numbers, and a narrower scrubber beside it is exactly how a
// leak the wider one caught gets through the newer one.

/** Bearer FIRST: the field pass below would otherwise stop at the literal word
 *  `Bearer` and leave the token beside it in the clear. */
const BEARER_RE = /\bBearer\s+[^\s,"'})\]]+/gi;
/** Credential-named field in any of the shapes a probe reply actually uses:
 *  `k=v`, `k: v`, and JSON's `"k": "v"`. */
const CREDENTIAL_FIELD_RE =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|secret|password|passwd|cookie|credential|session|private[_-]?key)"?\s*[:=]\s*"?)[^\s,"'})\]]+/gi;
/** Cap on a persisted probe detail. A cut is reported, never silent. */
const PROBE_DETAIL_LIMIT = 1_500;

/** The one boundary every probe detail crosses before it is stored or returned. */
export function redactProbeDetail(value: unknown): string {
  const raw =
    value instanceof Error
      ? value.message || `${value.name}（未携带消息）`
      : String(value);
  const safe = redactHarnessTelemetryText(raw)
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(CREDENTIAL_FIELD_RE, "$1[REDACTED]");
  return safe.length > PROBE_DETAIL_LIMIT
    ? `${safe.slice(0, PROBE_DETAIL_LIMIT)}…（诊断信息共 ${safe.length} 字，已截断）`
    : safe;
}

const NO_ROUTE_HEALTH = /cannot\s+(?:get|post)\s+\S*\/health/i;
/** Framework no-route signature for ANY path (generic probe may use a custom
 *  healthPath, so the "/health" suffix can't be assumed). */
const NO_ROUTE_ANY = /cannot\s+(?:get|post)\s+\S+/i;

/** The operator-facing note when a 404 proves reachability. */
export const REACHABLE_NO_HEALTH_NOTE =
  "服务器可达，但当前 Base URL 下没有该健康检查路由——已按可达处理。" +
  "若业务调用也报 404，请检查 Base URL 是否缺路径前缀（例如应为 …/api/v1），" +
  "或在系统档案 credential.healthPath 里声明正确的健康检查路径。";

export interface ProbeClassification {
  /** Server reachable; deployment just lacks a /health route. */
  reachableNoHealth: boolean;
  /** Operator-facing note when reclassified. */
  note?: string;
}

export function classifyProbeError(err: unknown): ProbeClassification {
  const status = (err as { status?: unknown })?.status;
  const body = (err as { errorBody?: unknown })?.errorBody;
  const message = err instanceof Error ? err.message : String(err ?? "");

  const bodyText = typeof body === "string" ? body : body != null ? JSON.stringify(body) : "";
  const is404 =
    status === 404 ||
    // Fallback when the error lost its structured props: the gohire helper's
    // message format is "GoHire GET /health failed: 404".
    (typeof status !== "number" && /\/health failed:\s*404\b/.test(message));
  const hasNoRouteSignature = NO_ROUTE_HEALTH.test(bodyText) || NO_ROUTE_HEALTH.test(message);

  if (is404 && hasNoRouteSignature) {
    return { reachableNoHealth: true, note: REACHABLE_NO_HEALTH_NOTE };
  }
  return { reachableNoHealth: false };
}

// ── Response-level classification (generic HTTP probe) ──────────────────────

export interface HttpProbeClassification {
  /** Connection verdict: true for 2xx AND for reachable-but-no-route 404. */
  ok: boolean;
  /** Set when a no-route 404 proved reachability (note explains). */
  reachableNoHealth?: boolean;
  /** Set on 401/403 — the server is up but rejected the credential. */
  credentialRejected?: boolean;
  /** Operator-facing one-liner. */
  detail: string;
}

/** Classify a raw health-check HTTP response the same way the tool-error path
 *  does: 2xx = connected; 404 + framework no-route signature = reachable with
 *  a hint (never silently perfect); 401/403 = credential rejected; anything
 *  else = failure with the status + a body snippet for diagnosis. */
export function classifyHttpHealthResponse(
  status: number,
  bodySnippet: string,
): HttpProbeClassification {
  const snippet = bodySnippet.replace(/\s+/g, " ").trim().slice(0, 200);
  if (status >= 200 && status < 300) {
    return { ok: true, detail: `HTTP ${status}${snippet ? ` — ${snippet}` : ""}` };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      credentialRejected: true,
      detail: `凭证被拒（HTTP ${status}）——服务器可达，请检查 API Key 是否正确/未过期。`,
    };
  }
  if (status === 404 && NO_ROUTE_ANY.test(bodySnippet)) {
    return { ok: true, reachableNoHealth: true, detail: REACHABLE_NO_HEALTH_NOTE };
  }
  return {
    ok: false,
    detail: `健康检查失败：HTTP ${status}${snippet ? ` — ${snippet}` : ""}`,
  };
}
