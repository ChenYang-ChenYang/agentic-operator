/**
 * metaerp.invoke — catalog-bound Meta ERP operation client.
 *
 * The ontology compiler (packages/ontology-compiler) emits an
 * `erp-operations.json` catalog per tenant model (derived from the domain's
 * transform maps): every entry names one Meta ERP OpenAPI operation, its
 * relative POST path, and whether it is a read (`query`) or a state-mutating
 * (`write`) operation. This tool is the ONLY way compiled agents reach the
 * ERP: the model (or a pinned `type:"tool"` step) may select an operation
 * name and a JSON payload — never a URL.
 *
 * Fail-closed contract:
 *   - base URL comes ONLY from the env var named by `config.base_url_env`
 *     (default METAERP_BASE_URL); unset/blank env throws.
 *   - the operation MUST exist in the configured catalog file; a missing
 *     catalog file or an unknown operation throws.
 *   - `config.operation` (compiler pin) overrides the model-supplied
 *     operation; when both are present and disagree, the call throws so a
 *     drifted manifest cannot silently invoke a different ERP op.
 *   - non-2xx and non-JSON upstream responses throw with a bounded
 *     diagnostic so the runtime surfaces a real tool error.
 *
 * Config (manifest `tool_use[].config`):
 *   - catalog_path  (required) repo-relative path to erp-operations.json,
 *                   e.g. "models/power-scm-v1/erp-operations.json".
 *   - base_url_env  env var NAME holding the ERP origin (default
 *                   "METAERP_BASE_URL"). Never a literal URL.
 *   - operation     optional pin — fixes/validates the operation for this
 *                   binding (compiled external actions always pin).
 *   - timeout_ms    request timeout, default 15000.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolContext } from "@agentic/agent-kit";
import { defineTool } from "@agentic/agent-kit";
import { findRepoRoot } from "../fs/_shared";

export type MetaerpOperationKind = "query" | "write";

export interface MetaerpCatalogOperation {
  operation: string;
  path: string;
  kind: MetaerpOperationKind;
  method: "POST";
  description?: string;
}

interface MetaerpInvokeConfig {
  catalog_path?: string;
  base_url_env?: string;
  operation?: string;
  timeout_ms?: number;
}

const DEFAULT_BASE_URL_ENV = "METAERP_BASE_URL";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_CHARS = 2_000;

/** Parsed catalogs keyed by absolute file path. The compiler output is
 * byte-stable per deploy; a redeploy rewrites the file, and the api process
 * restarts (or hot-swaps manifests) around it, so a process-lifetime cache
 * is safe. Tests clear it explicitly. */
const catalogCache = new Map<string, Map<string, MetaerpCatalogOperation>>();

export function _clearMetaerpCatalogCacheForTests(): void {
  catalogCache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKind(raw: unknown, operation: string): MetaerpOperationKind {
  if (raw === "query" || raw === "read") return "query";
  if (raw === "write" || raw === "external" || raw === "action") return "write";
  throw new Error(
    `metaerp.invoke: catalog entry '${operation}' has invalid kind '${String(
      raw,
    )}' (expected "query" or "write")`,
  );
}

function normalizeEntry(raw: unknown, index: number): MetaerpCatalogOperation {
  if (!isRecord(raw)) {
    throw new Error(
      `metaerp.invoke: catalog entry #${index} is not an object`,
    );
  }
  const operation =
    typeof raw.operation === "string" && raw.operation.trim()
      ? raw.operation.trim()
      : typeof raw.operation_id === "string" && raw.operation_id.trim()
        ? raw.operation_id.trim()
        : typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : null;
  if (!operation) {
    throw new Error(
      `metaerp.invoke: catalog entry #${index} is missing an operation name`,
    );
  }
  const rawPath =
    typeof raw.path === "string" && raw.path.trim()
      ? raw.path.trim()
      : typeof raw.endpoint === "string" && raw.endpoint.trim()
        ? raw.endpoint.trim()
        : null;
  if (!rawPath || !rawPath.startsWith("/") || rawPath.includes("..")) {
    throw new Error(
      `metaerp.invoke: catalog entry '${operation}' needs an absolute relative path starting with '/'`,
    );
  }
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "POST";
  if (method !== "POST") {
    throw new Error(
      `metaerp.invoke: catalog entry '${operation}' declares method '${method}'; only POST is supported`,
    );
  }
  return {
    operation,
    path: rawPath,
    kind: normalizeKind(raw.kind, operation),
    method: "POST",
    ...(typeof raw.description === "string"
      ? { description: raw.description }
      : {}),
  };
}

/** Load + cache the operation catalog. Accepts either a bare array of
 * operations or an `{ operations: [...] }` envelope (optionally with
 * metadata), so the compiler's five-file envelope conventions fit. */
export function loadMetaerpCatalog(
  catalogPath: string,
): Map<string, MetaerpCatalogOperation> {
  const absolute = path.isAbsolute(catalogPath)
    ? catalogPath
    : path.resolve(findRepoRoot(), catalogPath);
  const cached = catalogCache.get(absolute);
  if (cached) return cached;

  let rawText: string;
  try {
    rawText = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    throw new Error(
      `metaerp.invoke: operation catalog not readable at '${absolute}' — ` +
        `deploy the compiled erp-operations.json before invoking (${
          (error as NodeJS.ErrnoException).code ?? "read error"
        })`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(
      `metaerp.invoke: operation catalog at '${absolute}' is not valid JSON`,
    );
  }
  const rawEntries: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.operations)
      ? parsed.operations
      : (() => {
          throw new Error(
            `metaerp.invoke: operation catalog at '${absolute}' must be an array or { operations: [...] }`,
          );
        })();
  if (rawEntries.length === 0) {
    throw new Error(
      `metaerp.invoke: operation catalog at '${absolute}' declares zero operations`,
    );
  }
  const map = new Map<string, MetaerpCatalogOperation>();
  rawEntries.forEach((raw, index) => {
    const entry = normalizeEntry(raw, index);
    if (map.has(entry.operation)) {
      throw new Error(
        `metaerp.invoke: duplicate catalog operation '${entry.operation}'`,
      );
    }
    map.set(entry.operation, entry);
  });
  catalogCache.set(absolute, map);
  return map;
}

function readConfig(ctx: ToolContext): MetaerpInvokeConfig {
  return (ctx.config ?? {}) as MetaerpInvokeConfig;
}

function resolveBaseUrl(config: MetaerpInvokeConfig): string {
  const envName = config.base_url_env?.trim() || DEFAULT_BASE_URL_ENV;
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `metaerp.invoke: env var '${envName}' is not set — configure the Meta ERP base URL (e.g. METAERP_BASE_URL=http://localhost:3620)`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `metaerp.invoke: env var '${envName}' is not an absolute URL`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `metaerp.invoke: env var '${envName}' must be an http(s) URL`,
    );
  }
  return value.replace(/\/+$/, "");
}

function resolveOperationName(
  ctx: ToolContext,
  config: MetaerpInvokeConfig,
): string {
  const pinned = config.operation?.trim() || null;
  const supplied =
    typeof ctx.event?.data?.operation === "string" &&
    ctx.event.data.operation.trim()
      ? ctx.event.data.operation.trim()
      : null;
  if (pinned && supplied && pinned !== supplied) {
    throw new Error(
      `metaerp.invoke: this binding is pinned to operation '${pinned}' but the call requested '${supplied}'`,
    );
  }
  const operation = pinned ?? supplied;
  if (!operation) {
    throw new Error(
      "metaerp.invoke: no operation — pass args.operation or pin config.operation",
    );
  }
  return operation;
}

function resolvePayload(ctx: ToolContext): Record<string, unknown> {
  const raw = ctx.event?.data?.payload;
  if (raw == null) return {};
  if (!isRecord(raw)) {
    throw new Error("metaerp.invoke: args.payload must be a JSON object");
  }
  return raw;
}

export const metaerpInvoke = defineTool({
  name: "metaerp.invoke",
  description:
    "Invoke one Meta ERP OpenAPI operation from the tenant's compiled " +
    "erp-operations.json catalog. Args: { operation, payload? }. The manifest " +
    "config names the catalog file, the base-URL env var, and may pin the " +
    "operation. Unknown operations, an unset base-URL env, non-2xx and " +
    "non-JSON responses all fail closed.",
  async handler(ctx) {
    const config = readConfig(ctx);
    if (!config.catalog_path || !config.catalog_path.trim()) {
      throw new Error(
        "metaerp.invoke: config.catalog_path is required (repo-relative path to erp-operations.json)",
      );
    }
    const catalog = loadMetaerpCatalog(config.catalog_path.trim());
    const operationName = resolveOperationName(ctx, config);
    const entry = catalog.get(operationName);
    if (!entry) {
      const known = [...catalog.keys()].sort();
      throw new Error(
        `metaerp.invoke: operation '${operationName}' is not in the catalog ` +
          `'${config.catalog_path}'. Known operations: ${known
            .slice(0, 20)
            .join(", ")}${known.length > 20 ? ", …" : ""}`,
      );
    }
    const baseUrl = resolveBaseUrl(config);
    const payload = resolvePayload(ctx);
    const timeoutMs =
      typeof config.timeout_ms === "number" &&
      Number.isFinite(config.timeout_ms) &&
      config.timeout_ms > 0
        ? Math.min(config.timeout_ms, 120_000)
        : DEFAULT_TIMEOUT_MS;

    const url = `${baseUrl}${entry.path}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(
        `metaerp.invoke: '${operationName}' request to ${url} failed — ${reason}`,
      );
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `metaerp.invoke: '${operationName}' returned HTTP ${response.status} — ` +
          bodyText.slice(0, MAX_DIAGNOSTIC_CHARS),
      );
    }
    let body: unknown;
    try {
      body = bodyText.trim() ? JSON.parse(bodyText) : {};
    } catch {
      throw new Error(
        `metaerp.invoke: '${operationName}' returned non-JSON body — ` +
          bodyText.slice(0, MAX_DIAGNOSTIC_CHARS),
      );
    }

    return {
      data: body,
      meta: {
        tool: "metaerp.invoke",
        operation: entry.operation,
        kind: entry.kind,
        path: entry.path,
        // The absolute URL actually called, and the body actually sent. An
        // operator asked to trust that the ERP was written to needs to see the
        // request, not a claim that one happened.
        url,
        request: payload,
        status: response.status,
        correlationId: ctx.correlationId,
      },
    };
  },
});
