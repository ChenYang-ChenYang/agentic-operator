/**
 * LLMGateway — single entry point for all LLM calls.
 *
 * Responsibilities:
 *   - Provider registry (in-process Map of ProviderId → Adapter)
 *   - chat() dispatch with provider resolution, failover, timeout, retry
 *   - Surface configured providers (for /v1/llm/providers)
 *
 * Every attributed provider attempt is persisted before dispatch and then
 * finalized with normalized usage and exact/dated cost information.
 */

import {
  selectableModelsForProvider,
  type ProviderId,
} from "@agentic/contracts";
import type {
  ChatRequest,
  ChatResponse,
  GatewayConfig,
  ProviderAdapter,
  ProviderInfo,
} from "./types";
import { LLMError, isLLMError } from "./errors";
import { assertBudgetAvailable } from "./budget";
import { calculateCost, normalizeUsage } from "./pricing";
import {
  assertModelControls,
  assertModelSelectable,
  isUnsupportedTemperatureError,
  normalizeModelRequest,
  omitTemperature,
} from "./capabilities";
import {
  failAttempt,
  finishAttempt,
  newLogicalCallId,
  startAttempt,
} from "./usage-ledger";
import {
  currentUsageAttribution,
  mergeUsageAttribution,
} from "./usage-attribution";

// ── G6 双推理面统一遥测（附录 B）——系统 B 的推理面也进耐久遥测层 ────────────────────
// stream-gateway（系统 A）早已全量落表；这里给运行时面同款钩子：apps/api 在构造单例时
// setGatewayCallSink(writeLlmCall 适配器)，每次 chat() 成/败都必须进入一个耐久存储层。
// （账单/成本的权威账本是 usage-ledger 的 llm_calls；本 sink 服务 Factory 观测脊柱。）

export interface GatewayCallRecord {
  provider: string;
  requestedModel?: string;
  servedModel?: string;
  latencyMs: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  ok: boolean;
  failureReason?: string;
  purpose?: string;
  tenantId?: string;
  runId?: string;
  interactionId?: string;
  correlationId?: string;
  invocationSource?: string;
  /** Ordered model preference the caller asked for (difficulty routing). */
  modelPreference?: string[];
  /** Caller's label for that preference (e.g. the difficulty tier). */
  modelPreferenceTier?: string;
  /** Whether an allowed candidate actually matched the preference. */
  modelPreferenceSatisfied?: boolean;
  /** Why it was (not) matched — recorded so a miss is auditable, not silent. */
  modelPreferenceReason?: string;
}

/**
 * Project the model-preference decision onto the telemetry record. Emitted on
 * BOTH the success and failure paths: "the caller asked for a harder model and
 * policy could not offer one" must stay answerable from the telemetry table
 * rather than living only in a log line.
 */
function modelPreferenceRecord(
  req: ChatRequest,
): Pick<
  GatewayCallRecord,
  | "modelPreference"
  | "modelPreferenceTier"
  | "modelPreferenceSatisfied"
  | "modelPreferenceReason"
> {
  const routing = req.routing;
  if (!routing?.modelPreference?.length) return {};
  return {
    modelPreference: routing.modelPreference,
    ...(routing.modelPreferenceTier
      ? { modelPreferenceTier: routing.modelPreferenceTier }
      : {}),
    ...(routing.modelPreferenceSatisfied !== undefined
      ? { modelPreferenceSatisfied: routing.modelPreferenceSatisfied }
      : {}),
    ...(routing.modelPreferenceReason
      ? { modelPreferenceReason: routing.modelPreferenceReason }
      : {}),
  };
}

let gatewayCallSink: ((rec: GatewayCallRecord) => void | Promise<void>) | null =
  null;
export function setGatewayCallSink(
  fn: ((rec: GatewayCallRecord) => void | Promise<void>) | null,
): void {
  gatewayCallSink = fn;
}

export class LLMGateway {
  private readonly providers = new Map<ProviderId, ProviderAdapter>();
  private readonly learnedTemperatureUnsupported = new Set<string>();

  constructor(private readonly config: GatewayConfig) {}

  registerProvider(adapter: ProviderAdapter): void {
    this.providers.set(adapter.id, adapter);
  }

  hasProvider(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  getProvider(id: ProviderId): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  get defaultProvider(): ProviderId {
    return this.config.defaultProvider;
  }

  get defaultModel(): string | null {
    return this.config.defaultModel;
  }

  /** Whether this process explicitly permits the deterministic test adapter. */
  get allowMock(): boolean {
    // Config is not an authority to enable synthetic inference in a real process. Hand-constructed
    // gateways are held to the same invariant as resolveConfig(); only the test process may opt in.
    return (
      process.env.NODE_ENV === "test" &&
      (this.config.allowMock === true || this.config.defaultProvider === "mock")
    );
  }

  listProviders(): ProviderInfo[] {
    const out: ProviderInfo[] = [];
    for (const [id, adapter] of this.providers) {
      const catalog = selectableModelsForProvider(id);
      out.push({
        id,
        name: adapter.name,
        hasKey: adapter.hasKey,
        defaultModel: adapter.defaultModel,
        models: catalog.map((m) => m.name),
      });
    }
    return out;
  }

  /**
   * Main dispatch. Resolves provider chain, model, timeout, then iterates
   * providers, retrying once on transient errors and falling through to
   * the next provider on subsequent transient failures.
   *
   * Throws LLMError on terminal failure (last provider's error).
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const sinkAttribution = mergeUsageAttribution(
      currentUsageAttribution(),
      req.attribution,
    );
    let res: ChatResponse;
    try {
      res = await this.chatInner(req);
    } catch (err) {
      try {
        const le = err as {
          provider?: string;
          code?: string;
          message?: string;
        };
        await gatewayCallSink?.({
          provider: le?.provider ?? "unknown",
          requestedModel: req.model ?? undefined,
          latencyMs: Date.now() - started,
          ok: false,
          failureReason: (le?.code ?? le?.message ?? String(err)).slice(0, 120),
          purpose: req.purpose,
          tenantId: req.tenantId,
          runId: req.runId,
          interactionId: sinkAttribution.interactionId,
          correlationId: sinkAttribution.correlationId,
          invocationSource: sinkAttribution.invocationSource,
          ...modelPreferenceRecord(req),
        });
      } catch (telemetryError) {
        throw new AggregateError(
          [err, telemetryError],
          "LLM call failed and its telemetry could not be durably recorded",
        );
      }
      throw err;
    }

    // A successful provider response is not reported as successful until its
    // telemetry sink confirms durability (database or its durable outbox).
    await gatewayCallSink?.({
      provider: res.provider,
      requestedModel: req.model ?? undefined,
      servedModel: res.model,
      latencyMs: Date.now() - started,
      tokensIn: res.tokensIn ?? null,
      tokensOut: res.tokensOut ?? null,
      ok: true,
      purpose: req.purpose,
      tenantId: req.tenantId,
      runId: req.runId,
      interactionId: sinkAttribution.interactionId,
      correlationId: sinkAttribution.correlationId,
      invocationSource: sinkAttribution.invocationSource,
      ...modelPreferenceRecord(req),
    });
    return res;
  }

  private async chatInner(req: ChatRequest): Promise<ChatResponse> {
    const providers = this.resolveProviderChain(req);
    if (this.config.requireUsageAttribution && !req.tenantId) {
      throw new LLMError(
        "tenantId is required for durable LLM usage accounting",
        "accounting_error",
        providers[0] ?? this.config.defaultProvider,
      );
    }
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    let lastError: unknown = null;
    const logicalCallId = req.routing?.logicalCallId ?? newLogicalCallId();
    let attemptNumber = req.routing?.attemptBase ?? 0;
    const attribution = mergeUsageAttribution(
      req.tenantId ? { billingAccountId: req.tenantId } : undefined,
      req.attribution,
      // Authenticated server context wins over caller-supplied account and
      // principal dimensions whenever a call originates in an API request.
      currentUsageAttribution(),
    );

    for (const id of providers) {
      const adapter = this.providers.get(id);
      if (!adapter) {
        lastError = new LLMError(
          `Provider not registered: ${id}`,
          "bad_request",
          id,
        );
        continue;
      }

      // A gateway-global default belongs only to its configured provider.
      // Fallback providers use their own catalog default unless the caller
      // explicitly supplied a model.
      const resolvedModel =
        req.model ??
        (id === this.config.defaultProvider
          ? this.config.defaultModel
          : null) ??
        adapter.defaultModel ??
        undefined;

      const temperatureCapabilityKey = resolvedModel
        ? `${id}:${resolvedModel.replace(/^~/, "")}`
        : null;
      let effectiveReq = resolvedModel
        ? normalizeModelRequest(id, resolvedModel, req)
        : req;
      if (
        temperatureCapabilityKey &&
        this.learnedTemperatureUnsupported.has(temperatureCapabilityKey)
      ) {
        effectiveReq = omitTemperature(effectiveReq);
      }
      if (resolvedModel) {
        assertModelSelectable(id, resolvedModel);
        assertModelControls(id, resolvedModel, effectiveReq);
      }
      assertBudgetAvailable(req.tenantId, id);

      const signal = combineSignals(req.signal, timeoutMs);
      const subReq: ChatRequest = {
        ...effectiveReq,
        model: resolvedModel,
        signal,
        providers: undefined,
        provider: id,
        routing: {
          ...req.routing,
          effectiveTimeoutMs: timeoutMs,
          controls: {
            ...(effectiveReq.temperature !== undefined
              ? { temperature: effectiveReq.temperature }
              : {}),
            ...(effectiveReq.maxTokens !== undefined
              ? { maxTokens: effectiveReq.maxTokens }
              : {}),
            ...(effectiveReq.jsonMode !== undefined
              ? { jsonMode: effectiveReq.jsonMode }
              : {}),
            ...(effectiveReq.reasoning !== undefined
              ? { reasoning: effectiveReq.reasoning }
              : {}),
            ...(effectiveReq.verbosity !== undefined
              ? { verbosity: effectiveReq.verbosity }
              : {}),
            ...(effectiveReq.store !== undefined
              ? { store: effectiveReq.store }
              : {}),
          },
        },
      };

      // Response-integrity gate (ours): a provider adapter must return its own
      // provider id, a non-empty served model, and sane token counts. Violations
      // are provider_errors and go through the same ledger fail path as any
      // other adapter failure.
      const validate = (response: ChatResponse): ChatResponse => {
        if (response.provider !== id) {
          throw new LLMError(
            `Provider adapter '${id}' returned mismatched provider '${response.provider}'`,
            "provider_error",
            id,
          );
        }
        if (!response.model || !response.model.trim()) {
          throw new LLMError(
            `Provider adapter '${id}' returned an empty served model`,
            "provider_error",
            id,
          );
        }
        for (const [label, value] of [
          ["tokensIn", response.tokensIn],
          ["tokensOut", response.tokensOut],
        ] as const) {
          if (value !== null && (!Number.isFinite(value) || value < 0)) {
            throw new LLMError(
              `Provider adapter '${id}' returned invalid ${label}=${String(value)}`,
              "provider_error",
              id,
            );
          }
        }
        return response;
      };

      const executeAttempt = async (
        attemptReq: ChatRequest,
      ): Promise<ChatResponse> => {
        attemptNumber += 1;
        const attemptAttribution = mergeUsageAttribution(
          attribution,
          this.config.resolveProviderAttribution?.(id, req.tenantId),
        );
        let ledgerAttempt;
        try {
          ledgerAttempt = startAttempt({
            logicalCallId,
            attempt: attemptNumber,
            tenantId: req.tenantId,
            runId: req.runId,
            stepId: req.stepId,
            purpose: req.purpose,
            provider: id,
            requestedModel: resolvedModel ?? "<unspecified>",
            reasoning: attemptReq.reasoning,
            verbosity: attemptReq.verbosity,
            store: attemptReq.store,
            attribution: attemptAttribution,
            routing: attemptReq.routing,
          });
        } catch (error) {
          throw new LLMError(
            `could not start durable LLM accounting: ${error instanceof Error ? error.message : String(error)}`,
            "accounting_error",
            id,
            error,
          );
        }

        let response: ChatResponse;
        try {
          response = validate(await adapter.chat(attemptReq));
        } catch (error) {
          const providerError = toLLMError(error, id);
          try {
            failAttempt(ledgerAttempt, providerError);
          } catch (ledgerError) {
            throw new LLMError(
              `could not record failed LLM attempt: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`,
              "accounting_error",
              id,
              ledgerError,
            );
          }
          throw providerError;
        }

        const usage = normalizeUsage(response);
        const cost = calculateCost({
          provider: id,
          model: response.model || resolvedModel || "<unspecified>",
          usage,
          providerReportedCostUsd: response.providerReportedCostUsd,
        });
        const normalized: ChatResponse = {
          ...response,
          tokensIn: usage.available === false ? null : usage.inputTokens,
          tokensOut: usage.available === false ? null : usage.outputTokens,
          usage,
          cost,
          routing: attemptReq.routing,
        };
        try {
          finishAttempt(ledgerAttempt, normalized, usage, cost);
        } catch (error) {
          // This is deliberately non-transient: the provider already ran, so
          // an accounting failure must never trigger an internal model retry.
          throw new LLMError(
            `could not finalize durable LLM accounting: ${error instanceof Error ? error.message : String(error)}`,
            "accounting_error",
            id,
            error,
          );
        }
        return normalized;
      };

      try {
        return await executeAttempt(subReq);
      } catch (err1) {
        let e1 = toLLMError(err1, id);
        let retryReq = subReq;
        if (
          retryReq.temperature !== undefined &&
          isUnsupportedTemperatureError(e1)
        ) {
          if (temperatureCapabilityKey) {
            this.learnedTemperatureUnsupported.add(temperatureCapabilityKey);
          }
          retryReq = omitTemperature(retryReq);
          try {
            return await executeAttempt({
              ...retryReq,
              routing: {
                ...retryReq.routing,
                retryReason: "unsupported_temperature_parameter",
              },
            });
          } catch (compatibilityErr) {
            e1 = toLLMError(compatibilityErr, id);
          }
        }
        if (!e1.transient) throw e1;
        const maxAttempts = boundedAttempts(
          req.retryPolicy?.maxAttempts ?? this.config.maxAttempts ?? 2,
        );
        const baseBackoffMs = boundedBackoff(
          req.retryPolicy?.baseBackoffMs ?? this.config.baseBackoffMs ?? 250,
        );
        lastError = e1;
        for (let transientAttempt = 2; transientAttempt <= maxAttempts; transientAttempt += 1) {
          await delay(baseBackoffMs * 2 ** (transientAttempt - 2));
          try {
            const signal2 = combineSignals(req.signal, timeoutMs);
            return await executeAttempt({
              ...retryReq,
              signal: signal2,
              routing: {
                ...retryReq.routing,
                retryReason: `transient_${e1.code}`,
              },
            });
          } catch (retryError) {
            const normalizedRetry = toLLMError(retryError, id);
            lastError = normalizedRetry;
            if (!normalizedRetry.transient) throw normalizedRetry;
          }
        }
        // Continue to the next provider after this provider's policy is spent.
      }
    }

    if (isLLMError(lastError)) throw lastError;
    throw new LLMError(
      "All providers failed",
      "provider_error",
      providers[0] ?? this.config.defaultProvider,
      lastError,
    );
  }

  private resolveProviderChain(req: ChatRequest): ProviderId[] {
    const chain =
      req.providers && req.providers.length > 0
        ? [...req.providers]
        : req.provider
          ? [req.provider]
          : [this.config.defaultProvider];
    if (!this.allowMock && chain.includes("mock")) {
      throw new LLMError(
        "Mock provider is disabled in this process; configure a real provider or run tests with NODE_ENV=test",
        "not_configured",
        "mock",
      );
    }
    return chain;
  }
}

function toLLMError(err: unknown, provider: ProviderId): LLMError {
  if (isLLMError(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new LLMError(msg, "provider_error", provider, err);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function boundedAttempts(value: number): number {
  return Number.isInteger(value) ? Math.max(1, Math.min(5, value)) : 2;
}

function boundedBackoff(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(30_000, value)) : 250;
}

/**
 * Compose a caller-provided AbortSignal with a timeout. Returns a fresh
 * signal aborted when EITHER fires. Uses native AbortSignal.any when
 * available (Node ≥20), with a polyfill for older runtimes.
 */
function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === "function") return anyFn([caller, timeout]);
  // Polyfill
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  caller.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}
