/**
 * Provider connectivity probe — verifies a candidate key against the upstream
 * vendor without persisting anything. Hits the provider's "list models"
 * endpoint when one exists; that's cheap, doesn't consume tokens, and proves
 * the key is valid + the network is reachable.
 *
 * Returns a normalized result; callers don't need to know provider-specific
 * shapes. Errors are caught and folded into `{ ok: false, ... }` so the
 * frontend can render one consistent UI.
 */
import type { GatewayInstance, ProviderId } from "@agentic/contracts";
import { redact } from "@agentic/llm-gateway";
import {
  assertSafeGatewayBaseUrl,
  gatewayApiUrl,
} from "./gateway-network-safety";

export interface ProviderTestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  modelCount: number | null;
  message: string;
}

const TEST_TIMEOUT_MS = 8_000;

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: ac.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore — some providers return non-JSON on error pages
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function countModels(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const models = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : null;
  if (models === null) return null;
  if (
    models.some((model) => {
      if (!model || typeof model !== "object") return true;
      const entry = model as Record<string, unknown>;
      return !(
        (typeof entry.id === "string" && entry.id.trim().length > 0) ||
        (typeof entry.name === "string" && entry.name.trim().length > 0)
      );
    })
  ) {
    return null;
  }
  return models.length;
}

function invalidModelCatalogMessage(status: number): string {
  return `${status} OK — response is not a valid OpenAI-compatible model catalog; verify the gateway base URL (it usually must include /v1)`;
}

interface OpenAICompatibleConfig {
  baseURL: string;
  /** Probe path appended to baseURL. Defaults to `/models`. Some providers
   *  (OpenRouter) expose a public model list, so we hit an auth-required
   *  endpoint instead to actually validate the key. */
  probePath?: string;
  extraHeaders?: Record<string, string>;
}

const OPENAI_COMPATIBLE: Partial<Record<ProviderId, OpenAICompatibleConfig>> = {
  openai: { baseURL: "https://api.openai.com/v1" },
  // OpenRouter's /models is public; /auth/key requires the bearer.
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    probePath: "/auth/key",
  },
  groq: { baseURL: "https://api.groq.com/openai/v1" },
  together: { baseURL: "https://api.together.xyz/v1" },
  mistral: { baseURL: "https://api.mistral.ai/v1" },
  deepseek: { baseURL: "https://api.deepseek.com" },
  moonshot: { baseURL: "https://api.moonshot.ai/v1" },
  zai: { baseURL: "https://api.z.ai/api/paas/v4" },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
};

async function testOpenAICompatible(
  apiKey: string,
  cfg: OpenAICompatibleConfig,
): Promise<ProviderTestResult> {
  const start = Date.now();
  const path = cfg.probePath ?? "/models";
  try {
    const { status, body } = await fetchJson(`${cfg.baseURL}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(cfg.extraHeaders ?? {}),
      },
    });
    const latencyMs = Date.now() - start;
    if (status >= 200 && status < 300) {
      const modelCount = countModels(body);
      if (path === "/models" && modelCount === null) {
        return {
          ok: false,
          statusCode: status,
          latencyMs,
          modelCount: null,
          message: invalidModelCatalogMessage(status),
        };
      }
      const detail =
        modelCount !== null
          ? `returned ${modelCount} models`
          : (describeAuthResponse(body) ?? "key accepted");
      return {
        ok: true,
        statusCode: status,
        latencyMs,
        modelCount,
        message: `200 OK · ${latencyMs} ms · ${detail}`,
      };
    }
    return {
      ok: false,
      statusCode: status,
      latencyMs,
      modelCount: null,
      message: errorMessageFromStatus(status, body),
    };
  } catch (err) {
    return networkError(err, Date.now() - start);
  }
}

/** OpenRouter's /auth/key returns `{ data: { label, usage, limit, ... } }`. */
function describeAuthResponse(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.label === "string") return `key "${d.label}" accepted`;
  return null;
}

async function testAnthropic(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const { status, body } = await fetchJson(
      "https://api.anthropic.com/v1/models",
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
      },
    );
    const latencyMs = Date.now() - start;
    if (status >= 200 && status < 300) {
      const modelCount = countModels(body);
      return {
        ok: true,
        statusCode: status,
        latencyMs,
        modelCount,
        message:
          modelCount !== null
            ? `200 OK · ${latencyMs} ms · returned ${modelCount} models`
            : `200 OK · ${latencyMs} ms`,
      };
    }
    return {
      ok: false,
      statusCode: status,
      latencyMs,
      modelCount: null,
      message: errorMessageFromStatus(status, body),
    };
  } catch (err) {
    return networkError(err, Date.now() - start);
  }
}

async function testGemini(apiKey: string): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const { status, body } = await fetchJson(url, {
      headers: { Accept: "application/json" },
    });
    const latencyMs = Date.now() - start;
    if (status >= 200 && status < 300) {
      const modelCount = countModels(body);
      return {
        ok: true,
        statusCode: status,
        latencyMs,
        modelCount,
        message:
          modelCount !== null
            ? `200 OK · ${latencyMs} ms · returned ${modelCount} models`
            : `200 OK · ${latencyMs} ms`,
      };
    }
    return {
      ok: false,
      statusCode: status,
      latencyMs,
      modelCount: null,
      message: errorMessageFromStatus(status, body),
    };
  } catch (err) {
    return networkError(err, Date.now() - start);
  }
}

async function testAzure(apiKey: string): Promise<ProviderTestResult> {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiVersion = (process.env.AZURE_OPENAI_API_VERSION ?? "").trim();
  if (!endpoint || !apiVersion) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      modelCount: null,
      message: "Azure OpenAI endpoint or API version is not configured",
    };
  }
  let base: URL;
  try {
    base = new URL(endpoint);
    if (
      base.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && base.protocol === "http:")
    ) {
      throw new Error("unsupported protocol");
    }
  } catch {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      modelCount: null,
      message: "Azure OpenAI endpoint is not a valid allowed URL",
    };
  }
  const start = Date.now();
  try {
    const url = new URL(`${base.toString().replace(/\/+$/, "")}/openai/models`);
    url.searchParams.set("api-version", apiVersion);
    const { status, body } = await fetchJson(url.toString(), {
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    const latencyMs = Date.now() - start;
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        statusCode: status,
        latencyMs,
        modelCount: countModels(body),
        message: `Azure OpenAI credential accepted · ${latencyMs} ms`,
      };
    }
    return {
      ok: false,
      statusCode: status,
      latencyMs,
      modelCount: null,
      message: errorMessageFromStatus(status, body),
    };
  } catch (error) {
    return networkError(error, Date.now() - start);
  }
}

function errorMessageFromStatus(status: number, body: unknown): string {
  const fromBody = extractErrorText(body);
  const label = httpStatusLabel(status);
  if (fromBody) return `${status} ${label} — ${fromBody}`;
  if (status === 401 || status === 403)
    return `${status} ${label} — key rejected by provider`;
  if (status === 429) return `${status} ${label} — rate limited`;
  return `${status} ${label}`;
}

function extractErrorText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const errField = obj.error;
  if (typeof errField === "string") return errField;
  if (errField && typeof errField === "object") {
    const msg = (errField as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  if (typeof obj.message === "string") return obj.message;
  return null;
}

function httpStatusLabel(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 429) return "Too Many Requests";
  if (status >= 500) return "Server Error";
  return "Error";
}

function networkError(err: unknown, latencyMs: number): ProviderTestResult {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? String(err);
  if (name === "AbortError") {
    return {
      ok: false,
      statusCode: null,
      latencyMs,
      modelCount: null,
      message: `Timed out after ${TEST_TIMEOUT_MS} ms — provider unreachable`,
    };
  }
  return {
    ok: false,
    statusCode: null,
    latencyMs,
    modelCount: null,
    message: `Network error — ${message}`,
  };
}

export async function testProviderKey(
  provider: ProviderId,
  apiKey: string,
): Promise<ProviderTestResult> {
  const trimmed = (apiKey ?? "").trim();
  if (trimmed.length < 8) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      modelCount: null,
      message: "Key is empty or too short",
    };
  }

  if (provider === "mock") {
    if (process.env.NODE_ENV !== "test") {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        modelCount: null,
        message: "The mock provider is available only inside NODE_ENV=test",
      };
    }
    return {
      ok: true,
      statusCode: 200,
      latencyMs: 1,
      modelCount: 1,
      message: "Mock provider — always reachable",
    };
  }

  if (provider === "anthropic") return testAnthropic(trimmed);
  if (provider === "gemini") return testGemini(trimmed);
  if (provider === "azure") return testAzure(trimmed);
  if (provider === "custom") {
    const baseURL = (process.env.CUSTOM_LLM_BASE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!baseURL) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        modelCount: null,
        message: "CUSTOM_LLM_BASE_URL is not configured",
      };
    }
    return testOpenAICompatible(trimmed, { baseURL });
  }

  const oai = OPENAI_COMPATIBLE[provider];
  if (oai) return testOpenAICompatible(trimmed, oai);

  return {
    ok: false,
    statusCode: null,
    latencyMs: 0,
    modelCount: null,
    message: `Provider ${provider} cannot be tested over the public API (requires SDK-specific auth)`,
  };
}

/** Non-billable authentication/model-discovery probe for dynamic gateways. */
export async function testGatewayConnection(args: {
  instance: GatewayInstance;
  apiKey: string;
  timeoutMs?: number;
}): Promise<
  ProviderTestResult & { endpoint: string | null; testedAt: number }
> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(
    1_000,
    Math.min(
      args.timeoutMs ?? args.instance.timeouts?.connectTimeoutMs ?? 15_000,
      120_000,
    ),
  );
  try {
    if (args.instance.kind === "mock") {
      return {
        ok: true,
        statusCode: 200,
        latencyMs: 1,
        modelCount: 1,
        message: "Mock gateway — always reachable",
        endpoint: "internal",
        testedAt: Date.now(),
      };
    }
    if (!args.instance.baseUrl) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        modelCount: null,
        message: "Gateway instance has no base URL",
        endpoint: null,
        testedAt: Date.now(),
      };
    }
    await assertSafeGatewayBaseUrl(args.instance.baseUrl);
    const endpoint = gatewayApiUrl(
      args.instance.baseUrl,
      "/models",
      args.instance.kind === "newapi",
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(args.apiKey
            ? { Authorization: `Bearer ${args.apiKey.trim()}` }
            : {}),
        },
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Error pages may be non-JSON; status remains sufficient.
      }
      const latencyMs = Date.now() - startedAt;
      const modelCount = response.ok ? countModels(body) : null;
      const validModelCatalog = response.ok && modelCount !== null;
      return {
        ok: validModelCatalog,
        statusCode: response.status,
        latencyMs,
        modelCount,
        message: validModelCatalog
          ? `${response.status} OK · ${latencyMs} ms${modelCount === null ? "" : ` · returned ${modelCount} models`}`
          : response.ok
            ? invalidModelCatalogMessage(response.status)
            : redact(errorMessageFromStatus(response.status, body)),
        endpoint,
        testedAt: Date.now(),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = (error as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      latencyMs,
      modelCount: null,
      message: timedOut
        ? `Timed out after ${timeoutMs} ms — gateway unreachable`
        : redact(error instanceof Error ? error.message : String(error)),
      endpoint: args.instance.baseUrl ?? null,
      testedAt: Date.now(),
    };
  }
}
