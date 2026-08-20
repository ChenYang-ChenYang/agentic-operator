/**
 * Public types for the LLM gateway. Imported by adapters, the gateway class,
 * and any caller that wants to build a ChatRequest.
 *
 * Wire-format equivalents (Zod schemas) for these types live in
 * @agentic/contracts so the frontend can parse responses without depending
 * on this package.
 */

import type {
  ProviderId,
  ReasoningConfig,
  ReasoningContext,
  ReasoningEffort,
  ReasoningMode,
  ReasoningSummary,
  TextVerbosity,
} from "@agentic/contracts";

export type {
  ProviderId,
  ReasoningConfig,
  ReasoningContext,
  ReasoningEffort,
  ReasoningMode,
  ReasoningSummary,
  TextVerbosity,
};

// ─── P1-CON-01 — Typed content blocks for multi-modal / tool-use ──────────
//
// Adapter wire formats converge on three block kinds:
//   - text       : plain assistant-side text segment
//   - tool_use   : assistant emits a tool-call request
//   - tool_result: tool side reports the call's outcome
//
// All adapters that don't yet support tool blocks treat `string` content as
// before; the agent-runtime emits typed arrays only when it actually needs
// to.
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** JSON-encoded result body; the adapter is free to send as a string or structured object. */
  content: string;
  is_error?: boolean;
}

export type ChatContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  /** `tool` is the SDK's role for tool-result messages (a/k/a the "user-side" of a tool call). */
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentBlock[];
  /**
   * Opaque provider reasoning state that must be replayed verbatim on an
   * assistant tool-call turn (DeepSeek, Kimi, and GLM). It is transport
   * state, not a user-visible chain-of-thought, and must never be logged.
   */
  reasoningContent?: string;
}

/**
 * Adapter helper — flatten typed content blocks into plain text for adapters
 * that don't yet speak the structured block protocol. Tool-use blocks are
 * rendered as a JSON sentinel and tool-result blocks as their content body.
 * Legacy string contents pass through untouched.
 */
export function flattenContentToText(
  content: string | ChatContentBlock[],
): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use")
      parts.push(`[tool_use ${block.name} ${JSON.stringify(block.input)}]`);
    else if (block.type === "tool_result") parts.push(block.content);
  }
  return parts.join("\n");
}

// ─── P1-CON-02 — Tool definitions and structured tool calls ───────────────

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input shape. Validation is the agent's responsibility. */
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatRequest {
  /** G6 telemetry tag: who/why (e.g. "agent:reportGenerator", "step-engine:matchResume"). */
  purpose?: string;
  /** Conversation history. Must contain at least one user-role message. */
  messages: ChatMessage[];
  /** Provider-native model name. Falls back to gateway default. */
  model?: string;
  /** Single provider to use. Mutually exclusive with `providers` (the array wins). */
  provider?: ProviderId;
  /** Ordered fallback chain. Tries each until one returns or all fail with non-transient errors. */
  providers?: ProviderId[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Default 60_000 ms. */
  timeoutMs?: number;
  /** Total transient attempts for this provider, including the first call. */
  retryPolicy?: {
    maxAttempts: number;
    baseBackoffMs: number;
  };
  /** Caller-controlled abort. Combined with timeoutMs via AbortSignal.any-like helper. */
  signal?: AbortSignal;
  /** Hint the model to return JSON. Each adapter maps this to its native flag. */
  jsonMode?: boolean;
  /** Provider-neutral reasoning controls; model capabilities define valid subsets. */
  reasoning?: ReasoningConfig;
  /** Output detail control supported by GPT-5-family models and some gateways. */
  verbosity?: TextVerbosity;
  /** Whether the upstream provider may retain the response for later retrieval. */
  store?: boolean;
  /** P1-CON-02 — advertised tools for tool-use models. */
  tools?: ToolDef[];
  /** P1-RT-06 — caller-provided tenantId for usage attribution (optional). */
  tenantId?: string;
  /** Durable run attribution for per-call usage AND the per-provider-attempt
   * usage ledger. Runtime callers must pass the runs.id they are executing;
   * non-run calls intentionally omit it. */
  runId?: string;
  /** Alias of `tenantId` used by some legacy callers. */
  tenantSlug?: string;
  stepId?: string;
  /**
   * Non-sensitive billing dimensions for this logical call. Request-scoped
   * attribution supplied by the API is merged with these explicit values;
   * authenticated server context wins for account/principal fields. Never put
   * prompts, secrets, or customer payloads in this object.
   */
  attribution?: UsageAttribution;
  /**
   * Runtime routing decision. This contains identifiers and effective policy
   * only—never prompts, credentials, headers, or provider reasoning state.
   * Callers normally set `taskType`; the API routing host fills the remaining
   * fields after resolving the tenant/workspace AI settings.
   */
  routing?: LlmRoutingMetadata;
}

export type GatewayKind =
  | "direct"
  | "openrouter"
  | "newapi"
  | "openai-compatible"
  | "mock";

/** Strictly allow-listed routing/dispatch metadata written to the ledger. */
export interface LlmRoutingMetadata {
  requestedRoute?: string;
  effectiveRoute?: string;
  gatewayInstanceId?: string;
  gatewayKind?: GatewayKind;
  modelFamily?: string;
  taskType?: string;
  matchedTaskType?: string;
  profileId?: string;
  settingsRevision?: number;
  resolutionReason?:
    | "explicit"
    | "exact"
    | "alias"
    | "parent"
    | "default"
    | "legacy";
  fallbackIndex?: number;
  transport?: "chat" | "responses" | "native";
  effectiveTimeoutMs?: number;
  overallDeadlineMs?: number;
  /** Effective non-secret controls after provider capability normalization. */
  controls?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    reasoning?: ReasoningConfig;
    verbosity?: TextVerbosity;
    store?: boolean;
  };
  retryReason?: string;
  /** Shared across route candidates so retries/fallbacks form one timeline. */
  logicalCallId?: string;
  /** Route fallback candidates reserve 100 attempt ordinals each. */
  attemptBase?: number;
  /**
   * Caller-supplied ORDERED model preference (strongest wish first). It is a
   * ranking hint over the routes the tenant/workspace policy already allows —
   * it can reorder that set but never widen it, so a process-wide caller
   * setting can never beat tenant policy. Difficulty-routed callers (the Agent
   * Factory tiers) express task difficulty here.
   */
  modelPreference?: string[];
  /** Opaque caller label for that preference (e.g. the difficulty tier). */
  modelPreferenceTier?: string;
  /** Resolution outcome: did an allowed candidate match the preference? */
  modelPreferenceSatisfied?: boolean;
  /** Why the preference was (not) met — never silently dropped. */
  modelPreferenceReason?: string;
  /** Test/evaluation calls may explicitly override saved profile controls. */
  parameterPrecedence?: "policy" | "request";
  /** Caller supplied a legacy provider/model override; bypass task policy. */
  bypassTaskPolicy?: boolean;
}

export type UsageActorType = "user" | "api_token" | "system";

/**
 * Stable, low-cardinality dimensions used to reconcile an LLM charge with
 * the account, product interaction, server function, and API request that
 * caused it. IDs are identifiers only; secrets and request payloads are not
 * accepted by the durable exporter.
 */
export interface UsageAttribution {
  /** Internal customer/account charged for the call; defaults to tenantId. */
  billingAccountId?: string;
  /** Non-secret upstream organization/project/account identifier. */
  providerAccountId?: string;
  actorType?: UsageActorType;
  actorId?: string;
  /** Credential used to authenticate the caller (for example an API-token row). */
  credentialId?: string;
  /** Credential used to authenticate to the LLM provider, never the API key. */
  providerCredentialId?: string;
  product?: string;
  productSurface?: string;
  productAction?: string;
  /** One billable UI/API interaction; safe to use as a click correlation id. */
  interactionId?: string;
  functionName?: string;
  apiRoute?: string;
  httpMethod?: string;
  requestId?: string;
  correlationId?: string;
  invocationSource?: string;
}

/** Provider-neutral token accounting. Cached/write/reasoning tokens are subsets. */
export interface TokenUsage {
  /** False when the provider omitted authoritative usage entirely. */
  available?: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  reasoningTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  /** Original provider usage object for reconciliation/debugging. */
  raw?: unknown;
}

export type CostSource = "provider" | "catalog" | "unpriced";

/** USD nanodollars are used so sub-cent calls accumulate without rounding loss. */
export interface CostBreakdown {
  totalUsdNanos: number | null;
  inputUsdNanos: number | null;
  cachedInputUsdNanos: number | null;
  cacheWriteUsdNanos: number | null;
  outputUsdNanos: number | null;
  source: CostSource;
  priceSource?: string;
  priceAsOf?: string;
}

export interface ChatResponse {
  text: string;
  provider: ProviderId;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  finishReason: "stop" | "length" | "tool_calls" | "error" | "unknown";
  latencyMs: number;
  /** Detailed, normalized token accounting; legacy adapters may omit it. */
  usage?: TokenUsage;
  /** Final cost computed from provider billing data or the dated catalog. */
  cost?: CostBreakdown;
  /** Raw cost in USD reported by a provider such as OpenRouter. */
  providerReportedCostUsd?: number;
  providerRequestId?: string;
  /** Effective controls when the provider reports them, otherwise the requested values. */
  reasoning?: ReasoningConfig;
  verbosity?: TextVerbosity;
  /** Provider-generated, deliberately summarized reasoning; never raw chain-of-thought. */
  reasoningSummary?: string;
  /** Opaque reasoning state for exact tool-loop replay; never persist or display. */
  reasoningContent?: string;
  /** P1-LLM-04 — structured tool calls emitted by the model on this turn. */
  toolCalls?: ToolCall[];
  /** Provider-specific extras (e.g. tool calls). Opaque in v1. */
  raw?: unknown;
  /** Safe routing decision returned for diagnostics and the Settings test lab. */
  routing?: LlmRoutingMetadata;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  hasKey: boolean;
  defaultModel: string | null;
  models: string[];
}

/**
 * Adapter contract. Each concrete provider (anthropic, openai, …) ships an
 * adapter that conforms to this. Adapters never see the env directly — they
 * receive a typed config at construction time.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly hasKey: boolean;
  readonly defaultModel: string | null;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface GatewayConfig {
  defaultProvider: ProviderId;
  defaultModel: string | null;
  timeoutMs: number;
  /**
   * Test-only escape hatch for the deterministic mock adapter. Secure by
   * default: hand-constructed production gateways that omit this flag cannot
   * route a request to `mock`, even when a caller supplies it explicitly.
   */
  allowMock?: boolean;
  /** Legacy/default transient policy; routed calls normally override it. */
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** Fail before provider dispatch when tenant/account attribution is absent. */
  requireUsageAttribution?: boolean;
  /** Resolve non-secret provider-account dimensions separately for each attempt. */
  resolveProviderAttribution?: (
    provider: ProviderId,
    tenantId: string | undefined,
  ) => UsageAttribution | undefined;
}
