/**
 * Tenant-routing LLM gateway for the API process.
 *
 * Provider adapters capture credentials when they are constructed. A single
 * process-wide adapter set therefore cannot safely use tenant-scoped keys.
 * This host keeps one concrete gateway per tenant credential scope and
 * exposes a stable routing gateway to the runtime packages. Every chat is
 * routed from its required `tenantId`; request-local reads (provider/model
 * introspection) use the authenticated billing account in AsyncLocalStorage.
 */

import {
  LlmSettingsSchema,
  TaskClassIdSchema,
  behavioralProviderForCandidate,
  catalogModelForCandidate,
  parseModelRouteId,
  resolveLlmRouting,
  type GatewayInstance,
  type LlmSettings,
  type ProviderId,
  type TaskModelParameters,
  type TaskRouteCandidate,
} from "@agentic/contracts";
import { getDb, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { eq } from "drizzle-orm";
import {
  LLMError,
  currentUsageAttribution,
  createOpenAICompatibleAdapter,
  createOpenAIResponsesAdapter,
  isLLMError,
  LLMGateway,
  registerAllProviders,
  resolveOpenRouterReasoningMode,
  resolveConfig,
  setGatewayCallSink,
  shouldUseOpenRouterResponses,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderInfo,
} from "@agentic/llm-gateway";
import {
  getGatewayCredential,
  getProviderEnvironmentCredential,
  getProviderCredential,
  getProviderKeyEnvOverlay,
  gatewayCredentialSlot,
  providerApiKeyEnvName,
} from "./provider-keys";
import { getLlmSettings } from "./llm-settings-store";
import {
  assertSafeGatewayBaseUrl,
  gatewayApiUrl,
} from "./gateway-network-safety";
import { writeLlmCall } from "./agent-factory/llm-telemetry";
import { testProviderKey } from "./provider-test";

const WORKSPACE_SCOPE = "__workspace__";
const concreteGateways = new Map<string, LLMGateway>();
const dynamicGateways = new Map<string, LLMGateway>();
const configuredProviderGateways = new Map<string, LLMGateway>();
const tenantSlugs = new Map<string, string>();
let routingGateway: TenantRoutingGateway | null = null;
let testGateway: LLMGateway | null = null;
let _providerReadiness: DefaultProviderReadiness | null = null;
let _providerProbe: Promise<DefaultProviderReadiness> | null = null;

// G6 双推理面统一遥测（附录 B）：运行时面（llm-gateway）的每次调用也进
// llm_call_telemetry —— 与系统 A 的 stream-gateway 并表，全平台 LLM 开销/降级/
// 失败一张表可答。conversationId 固定 "runtime" 作面标记；purpose 由调用方标注
// （agent:xxx）。best-effort；账单/成本的权威账本是 usage-ledger 的 llm_calls。
// The sink is a module-global inside @agentic/llm-gateway, so wiring it once
// here covers every concrete/dynamic tenant gateway constructed below.
setGatewayCallSink((rec) => {
  const providerMeasured =
    Number.isSafeInteger(rec.tokensIn) &&
    (rec.tokensIn ?? -1) >= 0 &&
    Number.isSafeInteger(rec.tokensOut) &&
    (rec.tokensOut ?? -1) >= 0;
  writeLlmCall({
    conversationId:
      rec.interactionId ?? rec.correlationId ?? "runtime",
    tenantId: rec.tenantId,
    runId: rec.runId,
    purpose: rec.purpose ?? "runtime",
    requestedModel: rec.requestedModel,
    servedModel: rec.servedModel,
    provider: rec.provider,
    fallback: !!(
      rec.requestedModel &&
      rec.servedModel &&
      rec.requestedModel !== rec.servedModel
    ),
    approxTokensIn: rec.tokensIn ?? undefined,
    approxTokensOut: rec.tokensOut ?? undefined,
    // A successful model response does not imply that the provider exposed
    // usage. Only mark a row as provider-measured when both token counters
    // are actually present; otherwise provenance remains unknown.
    tokenSource: providerMeasured ? "provider" : undefined,
    latencyMs: rec.latencyMs,
    ok: rec.ok,
    failureReason: rec.failureReason,
    // Difficulty routing is only auditable if the ASK is recorded next to the
    // hit: which preference was requested, under which tier label, and whether
    // the allowed candidate set could satisfy it.
    modelPreference: rec.modelPreference,
    requestedTier: rec.modelPreferenceTier,
    preferenceSatisfied: rec.modelPreferenceSatisfied,
    preferenceReason: rec.modelPreferenceReason,
  } as Parameters<typeof writeLlmCall>[0]);
});

function contextTenantId(): string | undefined {
  return currentUsageAttribution()?.billingAccountId;
}

function buildEnv(tenantId?: string): Record<string, string | undefined> {
  return { ...process.env, ...getProviderKeyEnvOverlay(tenantId) };
}

function concreteGateway(tenantId?: string): LLMGateway {
  const cacheKey = tenantId ?? WORKSPACE_SCOPE;
  const cached = concreteGateways.get(cacheKey);
  if (cached) return cached;

  const { gateway: cfg, adapterEnv } = resolveConfig(buildEnv(tenantId));
  cfg.resolveProviderAttribution = (provider, attemptTenantId) => {
    const credential = getProviderCredential(
      provider,
      attemptTenantId ?? tenantId,
    );
    return credential
      ? { providerCredentialId: credential.credentialId }
      : undefined;
  };
  const gateway = new LLMGateway(cfg);
  registerAllProviders(gateway, adapterEnv);
  concreteGateways.set(cacheKey, gateway);
  return gateway;
}

function tenantSlug(tenantId: string | undefined): string | undefined {
  if (!tenantId) return undefined;
  const cached = tenantSlugs.get(tenantId);
  if (cached) return cached;
  const row = getDb()
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .all()[0];
  if (row) tenantSlugs.set(tenantId, row.slug);
  return row?.slug;
}

function providerForInstance(instance: GatewayInstance): ProviderId {
  if (instance.kind === "direct") return instance.providerId ?? "custom";
  if (instance.kind === "openrouter") return "openrouter";
  if (instance.kind === "mock") return "mock";
  return "custom";
}

type CompatibleDialect =
  | "openai-chat"
  | "openrouter"
  | "deepseek"
  | "moonshot"
  | "zai"
  | "unsupported";

function compatibleDialect(
  instance: GatewayInstance,
  candidate: TaskRouteCandidate,
): CompatibleDialect {
  const explicit = instance.dialect;
  if (explicit && explicit !== "auto") return explicit;
  // Behavioral family affects wire translation only. It is never used for
  // billing, provider attribution, or NewAPI channel ownership.
  const family = behavioralProviderForCandidate(instance, candidate);
  if (family === "moonshot") return "moonshot";
  if (family === "zai") return "zai";
  if (family === "deepseek") return "deepseek";
  if (family === "openrouter") return "openrouter";
  return "openai-chat";
}

function shouldUseResponses(
  instance: GatewayInstance,
  req: ChatRequest,
): boolean {
  if (instance.apiMode === "responses") return true;
  if (instance.apiMode === "chat-completions") return false;
  if (instance.capabilities?.responses !== true) return false;
  return Boolean(
    req.reasoning?.mode ||
    req.reasoning?.context ||
    req.reasoning?.summary ||
    req.verbosity ||
    req.store !== undefined,
  );
}

export function effectiveTransportForRoute(
  instance: GatewayInstance,
  req: ChatRequest,
): "chat" | "responses" | "native" {
  if (instance.kind === "newapi" || instance.kind === "openai-compatible") {
    return shouldUseResponses(instance, req) ? "responses" : "chat";
  }
  if (instance.kind === "openrouter") {
    return shouldUseOpenRouterResponses(resolveOpenRouterReasoningMode(req))
      ? "responses"
      : "chat";
  }
  if (instance.kind === "mock") return "native";
  if (instance.providerId === "openai") return "responses";
  if (instance.providerId === "anthropic") return "native";
  return "chat";
}

function normalizedGatewayBaseUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function dynamicGatewayCredential(
  instance: GatewayInstance,
  tenantId: string | undefined,
) {
  const stored = getGatewayCredential(
    gatewayCredentialSlot(instance, tenantId ?? WORKSPACE_SCOPE),
    tenantId,
    instance.credentialScope,
  );
  if (stored) return stored;

  // The process-wide custom credential belongs only to its configured
  // endpoint. Permit the auto-generated canonical instance to reuse it, but
  // never forward it to a renamed/ref-bound gateway, a tenant-only slot, or a
  // base URL that differs after URL normalization.
  const configuredBaseUrl = normalizedGatewayBaseUrl(
    process.env.CUSTOM_LLM_BASE_URL,
  );
  const instanceBaseUrl = normalizedGatewayBaseUrl(instance.baseUrl);
  const mayUseEnvironmentCustomCredential =
    instance.id === "custom" &&
    instance.kind === "openai-compatible" &&
    instance.credentialRef === "custom" &&
    instance.credentialScope !== "tenant" &&
    configuredBaseUrl !== null &&
    instanceBaseUrl === configuredBaseUrl;
  return mayUseEnvironmentCustomCredential
    ? getProviderEnvironmentCredential("custom")
    : null;
}

function dynamicGateway(
  instance: GatewayInstance,
  candidate: TaskRouteCandidate,
  tenantId: string | undefined,
  settingsRevision: number,
): LLMGateway {
  if (!instance.baseUrl) {
    throw new LLMError(
      `Gateway instance ${instance.id} has no base URL`,
      "not_configured",
      "custom",
    );
  }
  const dialect = compatibleDialect(instance, candidate);
  const credential = dynamicGatewayCredential(instance, tenantId);
  const key = [
    tenantId ?? WORKSPACE_SCOPE,
    settingsRevision,
    instance.id,
    dialect,
    normalizedGatewayBaseUrl(instance.baseUrl) ?? instance.baseUrl,
    credential?.credentialId ?? "no-credential",
  ].join(":");
  const cached = dynamicGateways.get(key);
  if (cached) return cached;
  const gateway = new LLMGateway({
    defaultProvider: "custom",
    defaultModel: null,
    timeoutMs: instance.timeouts?.requestTimeoutMs ?? 60_000,
    requireUsageAttribution: process.env.NODE_ENV === "production",
    resolveProviderAttribution: () =>
      credential
        ? { providerCredentialId: credential.credentialId }
        : undefined,
  });
  const modelListUrl = new URL(
    gatewayApiUrl(instance.baseUrl, "/models", instance.kind === "newapi"),
  );
  modelListUrl.pathname = modelListUrl.pathname.replace(/\/models$/, "");
  const baseURL = modelListUrl.toString().replace(/\/+$/, "");
  // Stored credentials must never follow an endpoint-controlled redirect.
  // The configured origin has already passed DNS/IP policy immediately
  // before dispatch; rejecting redirects preserves that trust decision.
  const noRedirectFetch: typeof globalThis.fetch = (input, init) =>
    globalThis.fetch(input, { ...init, redirect: "error" });
  const chat = createOpenAICompatibleAdapter({
    id: "custom",
    name: instance.displayName,
    baseURL,
    apiKey: credential?.apiKey,
    defaultModel: null,
    fetch: noRedirectFetch,
    reasoningDialect: dialect,
    ...(dialect === "moonshot"
      ? { maxTokensParam: "max_completion_tokens" as const }
      : {}),
  });
  const responses = createOpenAIResponsesAdapter({
    id: "custom",
    name: instance.displayName,
    baseURL,
    apiKey: credential?.apiKey,
    defaultModel: null,
    fetch: noRedirectFetch,
  });
  gateway.registerProvider({
    ...chat,
    chat: (request) =>
      shouldUseResponses(instance, request)
        ? responses.chat(request)
        : chat.chat(request),
  });
  dynamicGateways.set(key, gateway);
  return gateway;
}

/**
 * Build a credential-isolated gateway for a named direct/OpenRouter instance.
 * A settings instance may intentionally use a credential reference that is
 * different from the built-in provider ID; routing must honor that same key
 * that connection testing and model discovery use.
 */
function configuredProviderGateway(
  instance: GatewayInstance,
  tenantId: string | undefined,
  settingsRevision: number,
): LLMGateway {
  const provider = providerForInstance(instance);
  const credential = getGatewayCredential(
    gatewayCredentialSlot(instance, tenantId ?? WORKSPACE_SCOPE),
    tenantId,
    instance.credentialScope,
  );
  const cacheKey = [
    tenantId ?? WORKSPACE_SCOPE,
    settingsRevision,
    instance.id,
    provider,
    credential?.credentialId ?? "no-credential",
  ].join(":");
  const cached = configuredProviderGateways.get(cacheKey);
  if (cached) return cached;

  const env = buildEnv(tenantId);
  const apiKeyEnv = providerApiKeyEnvName(provider);
  if (apiKeyEnv) {
    // Assign even when absent so a named/tenant-scoped instance cannot
    // silently fall back to a different provider slot from buildEnv().
    env[apiKeyEnv] = credential?.apiKey;
  }
  const resolved = resolveConfig({
    ...env,
    LLM_DEFAULT_PROVIDER: provider,
    LLM_DEFAULT_MODEL: undefined,
  });
  const gateway = new LLMGateway({
    ...resolved.gateway,
    defaultProvider: provider,
    defaultModel: null,
    timeoutMs:
      instance.timeouts?.requestTimeoutMs ?? resolved.gateway.timeoutMs,
    resolveProviderAttribution: () =>
      credential
        ? { providerCredentialId: credential.credentialId }
        : undefined,
  });
  registerAllProviders(gateway, resolved.adapterEnv);
  configuredProviderGateways.set(cacheKey, gateway);
  return gateway;
}

function taskClass(req: ChatRequest): string {
  const requested = req.routing?.taskType ?? req.purpose ?? "default";
  const parsed = TaskClassIdSchema.safeParse(requested);
  return parsed.success ? parsed.data : "default";
}

/**
 * Apply shared profile defaults conservatively to one route candidate.
 * Provider-specific values that a catalog-known fallback cannot accept are
 * omitted so the provider can use its native default. Candidate overrides are
 * merged afterwards and remain strict, deliberate operator choices.
 */
export function taskPolicyParametersForCandidate(
  baseInput: TaskModelParameters | undefined,
  candidate: TaskRouteCandidate,
  instance: GatewayInstance,
): TaskModelParameters {
  const base: TaskModelParameters = {
    ...(baseInput ?? {}),
    ...(baseInput?.reasoning ? { reasoning: { ...baseInput.reasoning } } : {}),
  };
  const model = catalogModelForCandidate(instance, candidate);
  if (model) {
    if (base.temperature !== undefined) {
      const range = model.temperatureRange;
      if (
        range === null ||
        (range !== undefined &&
          (base.temperature < range.min || base.temperature > range.max))
      ) {
        delete base.temperature;
      }
    }
    if (base.reasoning) {
      const reasoning = { ...base.reasoning };
      if (
        reasoning.effort !== undefined &&
        !(model.reasoningEfforts ?? []).includes(reasoning.effort)
      ) {
        delete reasoning.effort;
      }
      if (
        reasoning.mode !== undefined &&
        !(model.reasoningModes ?? []).includes(reasoning.mode)
      ) {
        delete reasoning.mode;
      }
      if (
        reasoning.summary !== undefined &&
        !(model.reasoningSummaries ?? []).includes(reasoning.summary)
      ) {
        delete reasoning.summary;
      }
      if (
        reasoning.context !== undefined &&
        !(model.reasoningContexts ?? []).includes(reasoning.context)
      ) {
        delete reasoning.context;
      }
      base.reasoning = Object.keys(reasoning).length ? reasoning : undefined;
    }
    if (
      base.verbosity !== undefined &&
      !(model.textVerbosities ?? []).includes(base.verbosity)
    ) {
      delete base.verbosity;
    }
  }

  const provider = providerForInstance(instance);
  if (
    base.store !== undefined &&
    (provider === "openrouter" ? base.store : provider !== "openai")
  ) {
    delete base.store;
  }
  if (
    (instance.kind === "newapi" || instance.kind === "openai-compatible") &&
    instance.capabilities?.responses !== true
  ) {
    delete base.verbosity;
    delete base.store;
    if (base.reasoning) {
      const reasoning = { ...base.reasoning };
      delete reasoning.mode;
      delete reasoning.summary;
      delete reasoning.context;
      base.reasoning = Object.keys(reasoning).length ? reasoning : undefined;
    }
  }

  const override = candidate.parameters ?? {};
  return {
    ...base,
    ...override,
    ...(base.reasoning || override.reasoning
      ? { reasoning: { ...base.reasoning, ...override.reasoning } }
      : {}),
  };
}

function profileParameters(
  settings: LlmSettings,
  matchedTask: string | null,
  candidate: TaskRouteCandidate,
  instance: GatewayInstance,
): TaskModelParameters {
  const profile = matchedTask
    ? settings.taskProfiles.find((entry) => entry.taskClass === matchedTask)
    : settings.defaultProfile;
  return taskPolicyParametersForCandidate(
    profile?.parameters,
    candidate,
    instance,
  );
}

function applyPolicyParameters(
  req: ChatRequest,
  parameters: TaskModelParameters,
): ChatRequest {
  const requestWins = req.routing?.parameterPrecedence === "request";
  const choose = <T>(
    requestValue: T | undefined,
    policyValue: T | undefined,
  ) =>
    requestWins ? (requestValue ?? policyValue) : (policyValue ?? requestValue);
  return {
    ...req,
    temperature: choose(req.temperature, parameters.temperature),
    maxTokens: choose(req.maxTokens, parameters.maxTokens),
    timeoutMs: choose(req.timeoutMs, parameters.timeoutMs),
    jsonMode: choose(req.jsonMode, parameters.jsonMode),
    verbosity: choose(req.verbosity, parameters.verbosity),
    store: choose(req.store, parameters.store),
    reasoning:
      req.reasoning || parameters.reasoning
        ? requestWins
          ? { ...parameters.reasoning, ...req.reasoning }
          : { ...req.reasoning, ...parameters.reasoning }
        : undefined,
  };
}

export function normalizeRoutedRequestForCandidate(
  req: ChatRequest,
  candidate: TaskRouteCandidate,
  instance: GatewayInstance,
): ChatRequest {
  const normalized = taskPolicyParametersForCandidate(
    {
      reasoning: req.reasoning,
      verbosity: req.verbosity,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      timeoutMs: req.timeoutMs,
      jsonMode: req.jsonMode,
      store: req.store,
    },
    candidate,
    instance,
  );
  return {
    ...req,
    reasoning: normalized.reasoning,
    verbosity: normalized.verbosity,
    temperature: normalized.temperature,
    maxTokens: normalized.maxTokens,
    timeoutMs: normalized.timeoutMs,
    jsonMode: normalized.jsonMode,
    store: normalized.store,
  };
}

/**
 * Enforce the provider/model generation ceiling before dispatch, including
 * compatible gateways whose billing provider remains `custom`. When a route
 * does not publish a distinct output cap, its total context window is still
 * an absolute upper bound. The upstream remains responsible for enforcing
 * input + generated output within that window because tokenization is
 * provider-specific.
 */
export function assertRoutedTokenLimit(
  instance: GatewayInstance,
  candidate: TaskRouteCandidate,
  maxTokens: number | undefined,
): void {
  if (maxTokens === undefined) return;
  const model = catalogModelForCandidate(instance, candidate);
  if (!model) return;
  const maximum = model.out ?? model.ctx;
  if (maxTokens <= maximum) return;
  throw new LLMError(
    `${candidate.route} maxTokens=${maxTokens} exceeds its catalog maximum of ${maximum}`,
    "bad_request",
    providerForInstance(instance),
  );
}

const DEFAULT_ROUTE_FALLBACKS = new Set([
  "rate_limit",
  "timeout",
  "network",
  "provider_error",
  "not_configured",
]);

function mayFallback(candidate: TaskRouteCandidate, error: LLMError): boolean {
  const allowed = candidate.fallbackOn
    ? new Set<string>(candidate.fallbackOn)
    : DEFAULT_ROUTE_FALLBACKS;
  return allowed.has(error.code);
}

async function routeChat(
  req: ChatRequest,
  settingsInput: LlmSettings,
): Promise<ChatResponse> {
  const settings = LlmSettingsSchema.parse(settingsInput);
  const requestedTask = taskClass(req);
  // A caller's ordered model preference (e.g. the Agent Factory's task
  // difficulty tier) ranks the candidates this tenant's policy already allows.
  // The policy remains the boundary — resolution never selects a route the
  // profile did not list — and an unmet preference is reported below rather
  // than silently served by whatever the default happened to be.
  const resolution = resolveLlmRouting(settings, {
    taskClass: requestedTask,
    ...(req.routing?.requestedRoute
      ? { explicitRoute: req.routing.requestedRoute }
      : {}),
    ...(req.routing?.modelPreference?.length
      ? { modelPreference: req.routing.modelPreference }
      : {}),
  });
  const logicalCallId = req.routing?.logicalCallId ?? makeId("llc");
  const startedAt = Date.now();
  let lastError: LLMError | null = null;

  for (const [fallbackIndex, candidate] of resolution.candidates.entries()) {
    const parsed = parseModelRouteId(candidate.route);
    const instance = settings.gatewayInstances.find(
      (gateway) => gateway.id === parsed.gatewayInstanceId,
    );
    if (!instance?.enabled) continue;
    // Explicit routes override the task policy in both the resolver preview
    // and at dispatch. Request-level controls still apply below; profile and
    // candidate defaults do not silently leak into an explicit test call.
    const parameters =
      resolution.matchType === "explicit"
        ? resolution.effectiveParameters
        : profileParameters(
            settings,
            resolution.matchedTaskClass,
            candidate,
            instance,
          );
    const overallDeadlineMs =
      req.routing?.overallDeadlineMs ?? parameters.overallDeadlineMs;
    const remaining = overallDeadlineMs
      ? overallDeadlineMs - (Date.now() - startedAt)
      : undefined;
    if (remaining !== undefined && remaining <= 0) {
      throw new LLMError(
        `LLM routing deadline exceeded after ${overallDeadlineMs} ms`,
        "timeout",
        providerForInstance(instance),
      );
    }
    const mergedPolicyReq = applyPolicyParameters(req, parameters);
    // Ordinary agent-level controls are portable defaults, so prune values a
    // catalog-known fallback cannot accept. Explicit/test-lab requests remain
    // strict. Candidate overrides are re-applied by the normalizer and are
    // therefore treated as deliberate provider-specific choices.
    const policyReq =
      resolution.matchType === "explicit" ||
      req.routing?.parameterPrecedence === "request"
        ? mergedPolicyReq
        : normalizeRoutedRequestForCandidate(
            mergedPolicyReq,
            candidate,
            instance,
          );
    assertRoutedTokenLimit(instance, candidate, policyReq.maxTokens);
    const timeoutMs = Math.min(
      policyReq.timeoutMs ?? instance.timeouts?.requestTimeoutMs ?? 60_000,
      instance.timeouts?.maxRequestTimeoutMs ?? Number.MAX_SAFE_INTEGER,
      remaining ?? Number.MAX_SAFE_INTEGER,
    );
    const controller = overallDeadlineMs ? new AbortController() : null;
    const deadlineTimer = controller
      ? setTimeout(
          () => controller.abort(),
          Math.max(1, remaining ?? overallDeadlineMs!),
        )
      : null;
    const routeRequest: ChatRequest = {
      ...policyReq,
      model: parsed.modelId,
      provider: providerForInstance(instance),
      providers: undefined,
      timeoutMs,
      retryPolicy: instance.retry ?? { maxAttempts: 1, baseBackoffMs: 250 },
      signal: controller
        ? combineCallerSignals(req.signal, controller.signal)
        : req.signal,
      routing: {
        ...req.routing,
        requestedRoute:
          req.routing?.requestedRoute ?? resolution.selectedCandidate.route,
        effectiveRoute: candidate.route,
        gatewayInstanceId: instance.id,
        gatewayKind: instance.kind,
        modelFamily: candidate.modelFamily,
        taskType: requestedTask,
        matchedTaskType: resolution.matchedTaskClass ?? undefined,
        profileId: resolution.matchedTaskClass ?? "default",
        settingsRevision: resolution.settingsRevision,
        resolutionReason: resolution.matchType,
        fallbackIndex,
        transport: effectiveTransportForRoute(instance, {
          ...policyReq,
          model: parsed.modelId,
        }),
        overallDeadlineMs,
        logicalCallId,
        attemptBase: fallbackIndex * 100,
        ...(resolution.modelPreference
          ? {
              modelPreference: resolution.modelPreference.requested,
              modelPreferenceSatisfied: resolution.modelPreference.satisfied,
              modelPreferenceReason: resolution.modelPreference.reason,
            }
          : {}),
        ...(fallbackIndex > 0
          ? {
              retryReason: `route_fallback_after_${lastError?.code ?? "unknown"}`,
            }
          : {}),
      },
    };

    try {
      if (
        (instance.kind === "newapi" || instance.kind === "openai-compatible") &&
        instance.baseUrl
      ) {
        await assertSafeGatewayBaseUrl(instance.baseUrl);
      }
      const gateway =
        instance.kind === "newapi" || instance.kind === "openai-compatible"
          ? dynamicGateway(instance, candidate, req.tenantId, settings.revision)
          : instance.kind === "mock"
            ? concreteGateway(req.tenantId)
            : configuredProviderGateway(
                instance,
                req.tenantId,
                settings.revision,
              );
      return await gateway.chat(routeRequest);
    } catch (error) {
      const provider = providerForInstance(instance);
      const normalized = isLLMError(error)
        ? error
        : new LLMError(
            error instanceof Error ? error.message : String(error),
            "provider_error",
            provider,
            error,
          );
      lastError = normalized;
      if (
        fallbackIndex === resolution.candidates.length - 1 ||
        !mayFallback(candidate, normalized)
      ) {
        throw normalized;
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }
  throw (
    lastError ??
    new LLMError("No eligible LLM route", "not_configured", "custom")
  );
}

function combineCallerSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  if (!first) return second;
  return AbortSignal.any([first, second]);
}

/** Stable object injected at boot; delegates every operation to a safe scope. */
class TenantRoutingGateway extends LLMGateway {
  constructor() {
    // All public behavior below delegates to a concrete gateway. The base
    // constructor still needs a valid config for nominal class compatibility.
    super(resolveConfig(buildEnv()).gateway);
  }

  override chat(req: ChatRequest): Promise<ChatResponse> {
    const slug = tenantSlug(req.tenantId);
    if (req.routing?.bypassTaskPolicy) {
      return concreteGateway(req.tenantId).chat(req);
    }
    const usePolicy = Boolean(
      slug &&
      (req.routing?.requestedRoute ||
        req.routing?.taskType ||
        (!req.provider && !req.model)),
    );
    if (!slug || !usePolicy) return concreteGateway(req.tenantId).chat(req);
    return routeChat(req, getLlmSettings(slug).settings);
  }

  /**
   * Resolve the concrete gateway for the request-local billing scope for
   * read-only introspection, returning undefined instead of throwing when no
   * real provider can be constructed. resolveConfig() fails closed outside a
   * test process — it refuses to synthesize the mock adapter — so provider
   * discovery/registry probes must treat that as "no providers available"
   * rather than surfacing a 500. Real dispatch (chat) still fails loudly.
   */
  private introspectionGateway(): LLMGateway | undefined {
    try {
      return concreteGateway(contextTenantId());
    } catch {
      return undefined;
    }
  }

  override listProviders(): ProviderInfo[] {
    return this.introspectionGateway()?.listProviders() ?? [];
  }

  override hasProvider(id: ProviderId): boolean {
    return this.introspectionGateway()?.hasProvider(id) ?? false;
  }

  override getProvider(id: ProviderId): ProviderAdapter | undefined {
    return this.introspectionGateway()?.getProvider(id);
  }

  override get defaultProvider(): ProviderId {
    return concreteGateway(contextTenantId()).defaultProvider;
  }

  override get defaultModel(): string | null {
    return concreteGateway(contextTenantId()).defaultModel;
  }
}

const PROVIDER_KEY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "QWEN_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  custom: "CUSTOM_LLM_API_KEY",
};

export interface DefaultProviderReadiness {
  ok: boolean;
  provider: ProviderId;
  model: string | null;
  reachable: boolean;
  checkedAt: number;
  latencyMs: number;
  statusCode: number | null;
  /** Stable, non-sensitive classification; upstream bodies are never exposed. */
  note?:
    | "credential_missing"
    | "auth_rejected"
    | "rate_limited"
    | "upstream_error"
    | "unreachable";
}

/**
 * Prove the configured default provider accepts the real credential without
 * spending completion tokens. The provider test uses a list-models/auth
 * endpoint. Results are cached briefly for /health, while bootstrap forces a
 * fresh probe. No key, URL query, or upstream response body leaves this module.
 */
export async function probeDefaultLLMProvider(
  opts: {
    force?: boolean;
    maxAgeMs?: number;
  } = {},
): Promise<DefaultProviderReadiness> {
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? 60_000);
  if (
    !opts.force &&
    _providerReadiness &&
    Date.now() - _providerReadiness.checkedAt <= maxAgeMs
  ) {
    return _providerReadiness;
  }
  if (_providerProbe) return _providerProbe;
  _providerProbe = (async () => {
    const gateway = getLLMGateway();
    const provider = gateway.defaultProvider;
    const model = gateway.defaultModel;
    const checkedAt = Date.now();
    const env = buildEnv();
    const keyName = PROVIDER_KEY_ENV[provider];
    const key =
      provider === "mock"
        ? "test-only-probe"
        : keyName
          ? env[keyName]?.trim()
          : undefined;
    if (!key) {
      return {
        ok: false,
        provider,
        model,
        reachable: false,
        checkedAt,
        latencyMs: 0,
        statusCode: null,
        note: "credential_missing" as const,
      };
    }
    const result = await testProviderKey(provider, key);
    const note = result.ok
      ? undefined
      : result.statusCode === 401 || result.statusCode === 403
        ? ("auth_rejected" as const)
        : result.statusCode === 429
          ? ("rate_limited" as const)
          : result.statusCode != null && result.statusCode >= 500
            ? ("upstream_error" as const)
            : ("unreachable" as const);
    return {
      ok: result.ok,
      provider,
      model,
      reachable: result.statusCode != null,
      checkedAt,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      ...(note ? { note } : {}),
    };
  })();
  try {
    _providerReadiness = await _providerProbe;
    return _providerReadiness;
  } finally {
    _providerProbe = null;
  }
}

export async function assertDefaultLLMProviderReachable(
  context: string,
): Promise<DefaultProviderReadiness> {
  const readiness = await probeDefaultLLMProvider({ force: true, maxAgeMs: 0 });
  if (!readiness.ok) {
    throw new Error(
      `${context}: default LLM provider ${readiness.provider} failed its credential/connectivity probe` +
        `${readiness.statusCode == null ? "" : ` (HTTP ${readiness.statusCode})`}`,
    );
  }
  return readiness;
}

/**
 * A real provider must always be configured, but a transient upstream outage
 * should not take the whole control plane (Settings, audit, Sessions, profile
 * repair) offline. Deployments that intentionally want a cold-start hard gate
 * can opt into it explicitly; `/health` continues to expose the live probe
 * result in either mode.
 */
export function strictLlmStartupProbeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.AGENTIC_LLM_STARTUP_PROBE_STRICT?.trim().toLowerCase() === "true";
}

export function getLLMGateway(): LLMGateway {
  if (testGateway) return testGateway;
  routingGateway ??= new TenantRoutingGateway();
  return routingGateway;
}

/**
 * Fail closed when a production-reachable action would run on the canned
 * mock adapter or on an adapter without credentials. Test processes retain
 * the explicit mock provider for deterministic fixtures.
 */
export function assertRealLLMGateway(
  context: string,
  gateway: LLMGateway = getLLMGateway(),
): void {
  if (process.env.NODE_ENV === "test") return;
  const provider = gateway.defaultProvider;
  const model = gateway.defaultModel?.trim() ?? "";
  if (provider === "mock" || /(^|[\s/_-])mock([\s/_-]|$)/i.test(model)) {
    throw new Error(
      `${context}: 拒绝使用 mock LLM（provider=${provider}, model=${model || "(unset)"}）。` +
        "请配置真实 LLM_DEFAULT_PROVIDER/LLM_DEFAULT_MODEL 后重试。",
    );
  }
  const info = gateway.listProviders().find((p) => p.id === provider);
  if (!info?.hasKey) {
    throw new Error(
      `${context}: LLM provider ${provider} 未配置可用凭据/端点，拒绝启动会退化的运行。`,
    );
  }
  if (!model) {
    throw new Error(
      `${context}: LLM_DEFAULT_MODEL 未配置，无法证明请求会落到真实模型。`,
    );
  }
}

/** Clear every credential-bound adapter set after key or env changes. */
export function resetLLMGateway(): void {
  concreteGateways.clear();
  dynamicGateways.clear();
  configuredProviderGateways.clear();
  _providerReadiness = null;
  _providerProbe = null;
}

/** Test-only — replace the routing gateway with a custom instance. */
export function _setLLMGatewayForTests(gateway: LLMGateway | null): void {
  testGateway = gateway;
  if (gateway === null) concreteGateways.clear();
  if (gateway === null) dynamicGateways.clear();
  if (gateway === null) configuredProviderGateways.clear();
  _providerReadiness = null;
  _providerProbe = null;
}
