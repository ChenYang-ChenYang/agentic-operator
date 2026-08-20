/**
 * Shared types for agent-authoring primitives.
 *
 * These describe what a tenant author sees when writing custom tools and
 * prompts. The runtime (packages/runtime) consumes the same types via the
 * resolver chain so action.name in a manifest can map to a tenant-defined
 * implementation.
 */

import type {
  PreparedWriteProbeCanary,
  ToolConfigContract,
  WriteProbeSafetyContract,
} from "@agentic/shared";
import type { z } from "zod";

/**
 * Per-invocation context passed to every tool handler and prompt template.
 * Tools/prompts pluck what they need from here instead of declaring inputs
 * separately — keeps the manifest action shape simple (just `name + type`).
 */
export interface ToolContext {
  /** Agent that owns the step currently executing. */
  agentName: string;
  /** The action's `name` field from the manifest (matches the tool/prompt name). */
  actionName: string;
  /** Exact Ontology business action that owns this generated execution. This
   * differs from `actionName` while a logic step calls a tool: `actionName`
   * then names the tool, whereas this value remains the profile-bound action. */
  ontologyActionName?: string;
  /** The subject this run is operating on (e.g. a candidate id, requisition id). */
  subject?: string;
  /** Correlation id threaded through every step in this run. */
  correlationId: string;
  /**
   * Cooperative action deadline. Runtime sets this when `timeout_s` (or an
   * enclosing foreach deadline) applies. Network/process-backed tools should
   * pass it to their cancellable primitive; the runtime still fails closed at
   * the deadline if a legacy handler ignores it.
   */
  signal?: AbortSignal;
  /** The run id (runs.id) for this execution. Lets a tool tag durable side
   *  effects (e.g. `records.upsert`) with their originating run WITHOUT a
   *  tools→runtime import cycle. Optional for back-compat. */
  runId?: string;
  /** Tenant slug (e.g. "raas"). */
  tenantSlug: string;
  /** Internal tenant id used for budget enforcement and telemetry
   * attribution. Optional for backwards-compatible standalone tools. */
  tenantId?: string;
  /** The trigger event that fired this run, if any. */
  event?: {
    name: string;
    data: Record<string, unknown>;
  };
  /**
   * Output of the previous step in the same run, if any. Lets a tool/prompt
   * pipe data forward without explicit wiring in the manifest.
   */
  lastResult?: unknown;
  /**
   * Raw outputs of all completed plan steps, keyed by their stable `stepId` /
   * manifest `result_key`. Unlike `lastResult`, this survives intervening steps
   * and makes non-adjacent data dependencies explicit and deterministic.
   */
  results?: Record<string, unknown>;
  /** Current foreach bindings when a manifest `foreach` body is executing. Includes the authored
   * item alias plus `index`, raw `key`, and replay-safe `stableKey`. Undefined outside foreach. */
  locals?: Record<string, unknown>;
  /**
   * Per-tenant tool configuration, lifted from the workflow manifest's
   * `tool_use[i].config` blob and passed through verbatim. Handlers use this
   * for per-tenant credentials (e.g. `api_key_env`), per-tenant paths
   * (e.g. `subdir`), and any other knob that varies between deployments
   * but shouldn't require a code change.
   *
   * Concretely: a global tool like `robohire.parseResumeApi` can read
   * `ctx.config?.api_key_env` so tenant A and tenant B can both invoke
   * the same shared tool with different credentials, picked up from
   * different env vars, with zero TypeScript.
   *
   * `undefined` means the manifest didn't declare a config block for this
   * tool — handlers should fall back to env defaults in that case.
   */
  config?: Record<string, unknown>;
  /**
   * #P0-1 — durable, scoped memory (run / subject / tenant) so a tool can PERSIST + RECALL across
   * steps and runs. Threaded from the delivered adapter (register.ts → step-engine). Structurally
   * compatible with `@agentic/agent-sdk`'s `MemoryHandle` (kept inline so agent-kit needn't depend on
   * agent-sdk). `undefined` for pure-runtime/test callers — handlers treat memory as optional.
   */
  memory?: ToolMemoryHandle;
}

/** Minimal memory-handle surface a tool can use. A real `@agentic/agent-sdk` MemoryHandle is
 *  structurally assignable to this (get/put/delete identical; search's MemoryHit[] ⊆ unknown[]). */
export interface ToolMemoryHandle {
  get<T = unknown>(key: string, scope?: "run" | "subject" | "tenant"): Promise<T | null>;
  put<T = unknown>(key: string, value: T, scope?: "run" | "subject" | "tenant"): Promise<void>;
  delete(key: string, scope?: "run" | "subject" | "tenant"): Promise<void>;
  search(query: string, k: number): Promise<unknown[]>;
}

/**
 * What a tool handler returns. The runtime takes `data` as the step's output
 * (becomes the next step's `lastResult`), and surfaces `tokensIn`/`tokensOut`
 * on the run row for the tokens KPI.
 */
export interface ToolResult<T = unknown> {
  data: T;
  tokensIn?: number;
  tokensOut?: number;
  /** Free-form metadata for logs / debug surfaces. */
  meta?: Record<string, unknown>;
}

/**
 * Agent Factory metadata owned by the same package as a tenant-native tool.
 *
 * This is deliberately descriptive only: the runtime continues to execute the
 * descriptor's existing handler.  Agent Factory may use this declaration to
 * discover and review the exact tenant capability instead of inventing a DB
 * adapter with the same name.
 */
export interface ToolFactoryMetadata {
  summary?: string;
  category: string;
  sideEffect: "read" | "write" | "dual" | "call";
  operation: "read" | "compute" | "write" | "read_write";
  effectScope: "none" | "sandbox_local" | "external";
  sandboxPolicy: "pure" | "sandbox_local" | "live_external" | "requires_attempt_grant";
  aliases?: string[];
  argsSchema?: Record<string, ToolFactoryFieldSchema>;
  returnsSchema?: Record<string, ToolFactoryFieldSchema>;
  configSchema?: Record<string, ToolFactoryFieldSchema>;
  configContract?: ToolConfigContract;
  credentialEnv?: string[];
  capabilities?: ToolFactoryCapability[];
  profileScope?: ToolFactoryProfileScope;
  probeSafety?: WriteProbeSafetyContract;
  /** Stable source coordinate within the registry package. */
  source: {
    modulePath: string;
    exportName?: string;
    revision?: string;
  };
}

/** Input supplied only by the trusted Agent Factory probe boundary after it
 * has replaced model-authored values with an isolated synthetic canary. */
export interface ToolWriteProbeLifecycleInput {
  toolName: string;
  args: Record<string, unknown>;
  config: Record<string, unknown>;
  contract: WriteProbeSafetyContract;
  canary: PreparedWriteProbeCanary;
  /** Exact code-owned context used for the canary create call. Cleanup and
   * readback receive this independently of model-authored args so a lifecycle
   * can bind deletion to the same isolated execution boundary. */
  execution: ToolWriteProbeExecutionContext;
  /** Undefined is possible when create threw after the external system had
   * already accepted a partial write. Cleanup must still be attempted. */
  createResult?: unknown;
}

export interface ToolWriteProbeExecutionContext {
  agentName: "agent-factory-probe";
  actionName: string;
  correlationId: string;
  tenantSlug: string;
  eventName: string;
}

/**
 * Code-owned cleanup/readback implementation for a disposable write canary.
 *
 * This deliberately lives on ToolDescriptor, not in serializable Factory
 * metadata or an Ontology payload. A model can describe a safety contract but
 * cannot install executable cleanup code. `id` + `revision` are reviewed,
 * non-secret coordinates; providers additionally digest both callbacks before
 * placing the lifecycle identity in the tool definition hash.
 */
export interface ToolWriteProbeLifecycle {
  readonly identity: {
    id: string;
    revision: string;
  };
  cleanup(input: ToolWriteProbeLifecycleInput): Promise<{ completed: boolean; evidence?: unknown }>;
  readback(input: ToolWriteProbeLifecycleInput): Promise<{ absent: boolean; evidence?: unknown }>;
}

export interface ToolFactoryFieldSchema {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  allowedValues?: Array<string | number | boolean | null>;
}

export interface ToolFactoryCapability {
  systems: string[];
  /** Required for systems:["*"]: profile config key containing the exact
   * Ontology system this reusable transport is authorized to represent. */
  systemConfigKey?: string;
  kinds: string[];
  roles: string[];
  operations?: string[];
  objectTypes?: string[];
  probeRequired?: boolean;
}

export interface ToolFactoryProfileScope {
  exact?: Array<{
    configKey: string;
    source: "tenantId" | "tenantSlug" | "domain" | "action";
  }>;
  allowlists?: Array<{
    configKey: string;
    source: "tenant" | "domain" | "action" | "objects";
    match: "any" | "all";
  }>;
}

export interface TenantRegistryFactoryMetadata {
  /** Package/release identity; the provider also binds the selected runtime version. */
  source: {
    kind: string;
    id: string;
    version: string;
    revision?: string;
  };
}

/**
 * A tool descriptor produced by `defineTool()`. The runtime calls
 * `descriptor.handler(ctx)` and (optionally) validates the output against
 * `descriptor.output` before storing it.
 */
export interface ToolDescriptor<TOutput = unknown> {
  readonly kind: "tool";
  readonly name: string;
  readonly description?: string;
  /**
   * Declared JSON Schema (`type: "object"`) for the arguments this tool accepts.
   * Same wire shape as a manifest `tool_use[].input_schema` and the gateway's
   * `ToolDef.input_schema`, so a consumer can hand it to the model unchanged.
   *
   * Populated by providers that own a real argument contract — today
   * `@agentic/mcp`, where the server's `tools/list` schema used to be dropped,
   * leaving every MCP tool advertised to the model with no argument contract.
   *
   * Optional and additive. Absent means "this tool declares no argument
   * contract"; a consumer must treat that as UNKNOWN, never as "any arguments
   * are valid".
   */
  readonly inputSchema?: Record<string, unknown>;
  /** Optional Zod schema — runtime validates handler output if present. */
  readonly output?: z.ZodType<TOutput>;
  /** Optional Agent Factory discovery contract. It never replaces the handler. */
  readonly factory?: ToolFactoryMetadata;
  /** Trusted executable half of `factory.probeSafety`. It is intentionally
   * absent from JSON catalogs; only its fingerprinted identity is published. */
  readonly factoryWriteProbeLifecycle?: ToolWriteProbeLifecycle;
  handler(ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

/**
 * A prompt descriptor produced by `definePrompt()`. The runtime renders the
 * template against the live context to get a string, hands that to the LLM
 * caller, and (optionally) validates the LLM's structured output against
 * `descriptor.output`.
 */
export interface PromptDescriptor<TOutput = unknown> {
  readonly kind: "prompt";
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly system?: string;
  template(ctx: ToolContext): string;
  /**
   * Optional Zod schema for structured output. When set, the runtime asks
   * the LLM for JSON matching this shape and validates the response.
   */
  readonly output?: z.ZodType<TOutput>;
}

/** Transport-neutral input delivered to a tenant-owned event adapter. */
export interface TenantInboundEvent {
  /** Event name as received from the broker (bare or tenant-qualified). */
  eventName: string;
  /** Rehydrated broker data before any tenant-specific projection. */
  data: Record<string, unknown>;
}

/** Canonical runtime output passed to a tenant-owned event adapter. */
export interface TenantOutboundEvent {
  eventId: string;
  eventName: string;
  payload: Record<string, unknown>;
  subject?: string | null;
  correlationId?: string | null;
  sourceAgent?: string | null;
  /** Replay-stable timestamp from the durable runtime receipt. */
  emittedAt?: string | null;
}

/**
 * Tenant-owned boundary between broker envelopes and the runtime's canonical
 * flat event data. The generic runtime defaults to identity; a tenant that
 * must preserve a legacy/external wire contract owns that codec explicitly.
 */
export interface TenantEventAdapter {
  /** Stable diagnostic label; it is never used to branch business logic. */
  readonly name?: string;
  /**
   * Project a canonical event name onto this tenant's broker wire contract.
   * Omission keeps the isolated `${tenantSlug}/${eventName}` convention.
   * Legacy/bare names are a tenant transport concern and must be declared
   * here rather than enabled by a process-global runtime switch.
   */
  readonly wireEventName?: (input: {
    tenantSlug: string;
    eventName: string;
  }) => string;
  /** Raw broker expressions used before inbound canonicalization (for
   * concurrency/cancellation). Legacy envelope paths belong here, never in the
   * generic registrar. */
  readonly subjectExpressions?: {
    trigger: string;
    cancel: string;
  };
  /** Optional stable broker function identity owned by this tenant's
   * compatibility contract. Generic runtime code never knows business ids. */
  readonly functionId?: (input: {
    tenantSlug: string;
    agentName: string;
  }) => string;
  inbound(input: TenantInboundEvent): Record<string, unknown>;
  outbound(input: TenantOutboundEvent): Record<string, unknown>;
}

/**
 * A tenant package's default export. Bootstrap auto-discovers `@tenants/<slug>`
 * and merges these registries with the generic tool/prompt set so manifest
 * actions can reference tenant-specific names without further wiring.
 *
 * `mcpServers` and `skills` are opt-in extensions:
 *   - When `mcpServers` is set, the runtime spins up the MCP client for
 *     each entry and folds the advertised tools into `tools` under
 *     `<serverName>.<toolName>` keys (see `@agentic/mcp`).
 *   - When `skills` is set, the runtime registers two built-in tools
 *     (`skills.list_skills` and `skills.load_skill`) so any agent in the
 *     tenant can progressively-disclose SKILL.md bodies (see `@agentic/skills`).
 */
export interface TenantRegistry {
  tools?: Record<string, ToolDescriptor>;
  prompts?: Record<string, PromptDescriptor>;
  mcpServers?: McpServerConfigLike[];
  skills?: SkillDescriptorLike[];
  /** Optional broker-envelope codec. Omission means the identity adapter. */
  eventAdapter?: TenantEventAdapter;
  /**
   * Optional, tenant-owned configuration for the standalone Reasoning runtime.
   * This is deliberately separate from Agent Factory ontology bindings: the
   * factory may generate agents from one ontology while production reasoning
   * evaluates rules from another.
   */
  reasoning?: TenantReasoningConfigLike;
  /** Source identity used when hashing tenant-native tool definitions. */
  factory?: TenantRegistryFactoryMetadata;
}

export interface TenantReasoningConfigLike {
  ontology: {
    provider: "allmeta";
    domainId: string;
  };
  /** Omit to allow every real Action returned by the configured domain. */
  allowedActions?: string[];
}

/**
 * Structural alias for `McpServerConfig` from `@agentic/mcp`. Defined here
 * to keep `@agentic/agent-kit` from importing the MCP SDK transitively
 * (tenant packages that ship zero MCP servers shouldn't pull megabytes of
 * stdio-transport deps). The runtime narrows this to the real type at
 * the bootstrap edge.
 */
export interface McpServerConfigLike {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  allowTools?: string[];
  optional?: boolean;
}

/**
 * Structural alias for `SkillDescriptor` from `@agentic/skills`. Same
 * decoupling rationale as `McpServerConfigLike` — declared here so
 * `agent-kit` keeps zero filesystem deps.
 */
export interface SkillDescriptorLike {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md body for progressive load. */
  path: string;
  /** Optional frontmatter metadata surfaced verbatim to the agent. */
  metadata?: Record<string, unknown>;
}
