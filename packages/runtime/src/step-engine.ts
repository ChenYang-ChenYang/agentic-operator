/**
 * Step engine — dispatches a single action by type.
 *
 * Called from inside an Inngest function via step.run(), so each invocation
 * is durable + idempotent (Inngest replays the function with memoized step
 * results on retry).
 *
 * Resolution order for `tool` and `logic` actions:
 *   1. Tenant registry (`@tenants/<slug>`) — typed handler from agent-kit.
 *   2. Global @agentic/tools registry — real handlers only.
 *
 * Tenant resolution lets a manifest action `{ "name": "rankCandidates", "type": "logic" }`
 * dispatch to a real tenant-defined prompt without editing the runtime.
 */

import {
  globalToolExecutionPolicy,
  globalToolRegistry,
  toolExecutionPoliciesEqual,
  type ToolEffectScope,
  type ToolExecutionPolicy,
  type ToolOperation,
  type ToolSandboxPolicy,
} from "@agentic/tools";
import type {
  PromptDescriptor,
  TenantRegistry,
  ToolContext,
  ToolDescriptor,
} from "@agentic/agent-kit";
import type { MemoryHandle } from "@agentic/agent-sdk";
import type { ActionSpec } from "./manifest";
import { getRuntimeGateway } from "./llm-host";
import { makeGeneratedAgentPrompt } from "./generated-agent";
import {
  runGeneratedCodeIsolated,
  type GeneratedCodeHostRuntime,
} from "./codeact";
import type { CodeActDockerTransport } from "./codeact-container";
import {
  ActionTimeoutError,
  applyToolResultMap,
  evaluateActionPrecondition,
  evaluateConditionDetailed,
  foreachStepId,
  hasAuthoritativeConditionalEmit,
  materializeForeach,
  materializeToolArguments,
  readPath,
  resolveBusinessKey,
  resolveConditionPath,
  runSequentialForeach,
  runWithActionTimeout,
  shouldSkip,
  type GateState,
  type StepScope,
} from "./action-plan";
import {
  RuleGateDeclarationSchema,
  evaluateRuleGate,
  normalizeRuleVerdict,
  type RuleGateDecision,
  type RuleGateDeclaration,
  type RuleGateFinding,
  type RuleGateMode,
} from "./rule-guard";
import {
  evaluateProbeVerification,
  probeVerificationPolicyFromEnv,
  validateSuppliedArgTypes,
  type ProbeVerificationResult,
  type ToolProbeState,
} from "./tool-dispatch-verification";
import {
  compareEffectReadback,
  resolveEffectVerificationContract,
  resolveReadbackArgs,
  unverifiedEffect,
  type EffectVerificationReceipt,
} from "./effect-verification";
import { globalToolEffectVerification } from "@agentic/tools/registry";
import { mergeStepResults } from "./message-envelope";
import type { EmitIntent } from "./emit-select";
import {
  actionErrorFacts,
  classifyActionFailure,
  failureForDisposition,
  type ActionFailureResolution,
  type RuntimeOnErrorPolicy,
} from "./error-policy";
import {
  isSandboxTenant,
  sandboxToolMode,
  sandboxToolStub,
  cassetteLookup,
  toolDispatchDecision,
  factorySandboxDispatchDecision,
  replayFactorySandboxTool,
  recordFactorySandboxLocalDispatch,
  gatedToolMarker,
  injectedFault,
  faultResult,
  type FactorySandboxExecutionScope,
  type FactorySandboxReplayRef,
  type FactorySandboxDispatchReceipt,
} from "./sandbox-mode";
import {
  mergeUsageAttribution,
  runWithUsageAttribution,
  type UsageAttribution,
  type ChatContentBlock,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ProviderId,
  type ToolDef,
  type ToolUseBlock,
  type ToolResultBlock,
} from "@agentic/llm-gateway";
import {
  AgentInputValidationError,
  OutputSchemaValidationError,
  canonicalJson,
  normalizeAgentForExecution,
  parseValidateAndRepairOutput,
  prepareAgentExecution,
  resolveRestrictedJsonPath,
  validateValueAgainstJsonSchema,
  type AgentConversationTurn,
} from "./agent-execution";
import { appendRuntimeTrace, type RuntimeTraceSink } from "./execution-trace";
import { isRequiredStepEvidenceFailure } from "./step-evidence";
import type { ToolCallLedgerEntry } from "./run-completion-reconciliation";
import type { ReasoningConfigDTO, TextVerbosity } from "@agentic/contracts";
import { parseStructuredJson } from "./structured-output";
import { writeArtifact } from "./artifacts";
import {
  evaluateDecisionTable,
  materializeInvokePayload,
} from "@agentic/shared";
import { makeCodeActExecutionReceipt } from "./codeact-receipt";
import { createHash } from "node:crypto";
import {
  revalidateProductionCodeActCapability,
  type ProductionCodeActCapability,
} from "./production-codeact-authorization";

/**
 * Canonical tool-use entry on an AgentSpec (matches the Zod
 * `ToolUseEntrySchema` in manifest.ts). Only `name` is mandatory — when
 * `input_schema` is absent we synthesise a permissive object schema so the
 * gateway can still hand the tool to the model.
 */
export interface ToolUseEntry {
  name: string;
  /** Historical documentation only. Sandbox authorization does not read it. */
  side_effect?: "read" | "write" | "dual" | "call";
  execution_policy?: {
    operation: ToolOperation;
    effect_scope: ToolEffectScope;
    sandbox_policy: ToolSandboxPolicy;
  };
  description?: string;
  input_schema?: unknown;
  config?: Record<string, unknown>;
  /**
   * #EFFECT-READBACK (D6) — per-tenant confirmation route for this tool's
   * write, overriding the catalog default. Typed `unknown` on purpose: this
   * arrives as manifest JSON and is validated structurally at dispatch, so a
   * malformed declaration is REPORTED rather than trusted or dropped.
   */
  effect_verification?: unknown;
}

function declaredExecutionPolicy(
  entry: ToolUseEntry | undefined,
): ToolExecutionPolicy | undefined {
  const declared = entry?.execution_policy;
  return declared
    ? {
        operation: declared.operation,
        effectScope: declared.effect_scope,
        sandboxPolicy: declared.sandbox_policy,
      }
    : undefined;
}

function reviewedExecutionPolicy(
  name: string,
  entry: ToolUseEntry | undefined,
  useGlobalMetadata: boolean,
): ToolExecutionPolicy | undefined {
  const declared = declaredExecutionPolicy(entry);
  const catalog = useGlobalMetadata
    ? globalToolExecutionPolicy(name)
    : undefined;
  if (catalog && declared && !toolExecutionPoliciesEqual(catalog, declared)) {
    throw new Error(
      `tool '${name}' execution_policy conflicts with current reviewed registry metadata`,
    );
  }
  return catalog ?? declared;
}

interface AgentSlots {
  id?: string;
  name?: string;
  /** Internal tenant identity used for gateway budget attribution. */
  tenantId?: string;
  description?: string;
  ontology_instructions?: string;
  /** Provider-native model selected by the author (agent-level default). */
  model?: string;
  /** AI-settings task category inherited by logic actions (gateway routing). */
  task_class?: string;
  /** Explicit provider selected by the author. */
  provider?: ProviderId;
  reasoning?: ReasoningConfigDTO;
  verbosity?: TextVerbosity;
  store?: boolean;
  /** Per-call gateway timeout authored in the manifest. */
  timeout_s?: number;
  temperature?: number;
  max_tokens?: number;
  /** Authored tool-loop budget (v2). Structural so both the canonical
   * AgentToolLoopV2 and a raw manifest blob assign cleanly. */
  tool_loop?: { max_iterations?: number };
  /** Structured-trace verbosity contract (v2). */
  observability?: {
    trace_level?: "minimal" | "standard" | "debug";
    reasoning_summary?: boolean;
    persist_rendered_prompts?: boolean;
    retention_days?: number;
  };
  /**
   * v2 authoring carrier — read only through normalizeAgentForExecution for
   * prompt assembly / port validation / emissions. Typed loosely so both the
   * legacy AgentSpec slice and a spread AgentDefinitionV2 assign cleanly.
   */
  actor?: unknown;
  trigger?: unknown;
  actions?: unknown;
  inputs?: unknown;
  input_data?: Record<string, unknown>;
  user_prompt_template?: string;
  outputs?: unknown;
  output_config?: unknown;
  output_bindings?: unknown;
  trigger_bindings?: unknown;
  triggered_event?: unknown;
  extensions?: unknown;
  /**
   * Declarative tool roster from the manifest's `agent.tool_use[]`. When
   * non-empty AND a matching `tenantRegistry.tools[name]` exists, the
   * `logic` action runs a tool-use loop (gateway emits `tool_use` blocks
   * → engine executes → feeds `tool_result` back → repeat until text or
   * `MAX_TOOL_USE_ITERS`).
   */
  tool_use?: ToolUseEntry[];
  /**
   * Agent Factory marker. When true, the agent's `logic` action runs the runtime's default
   * generated-agent prompt (no hand-written tenant prompt required) and the tool-use loop
   * advertises GLOBAL registry tools in addition to tenant tools — so a machine-generated agent
   * referencing global tools (ontology.fetchActionRules, fs.*, …) can actually call them.
   */
  generated?: boolean;
  factoryDomainId?: string;
  /** Server-authored sandbox identity + profile provenance. A tool config or
   * generated handler cannot manufacture this pair at dispatch time. */
  factoryExecutionScope?:
    | FactorySandboxExecutionScope
    | {
        kind: "production";
        target_domain_id?: string;
      };
  factoryToolProfileRefs?: Record<string, string>;
  /** Server-authored, attempt-bound cassette hashes for external tools. */
  factoryToolReplayRefs?: Record<string, FactorySandboxReplayRef>;
  /** #G — true CodeAct: execute `typescriptCode` in the worker isolate. Sandbox is allowed by
   * default; production additionally requires an exact code attestation. Failure never falls back. */
  codeExecuted?: boolean;
  typescriptCode?: string;
  /** Exact production execution attestation. Absent means production code execution is forbidden. */
  codeAttestation?: {
    allow_production?: boolean;
    expected_sha256?: string;
  };
  factoryPromotionVersionId?: string;
  factoryRegressionSuiteFingerprint?: string;
  /** Process-local authority minted only after durable promotion/evidence
   * verification. A manifest-shaped object never satisfies this identity. */
  productionCodeActCapability?: ProductionCodeActCapability;
  productionCodeActManifestSha256?: string;
  productionCodeActWorkflowManifestSha256?: string;
  /** Declared downstream event allow-list. Required by explicit `emit` actions. */
  triggeredEvents?: string[];
  /**
   * #RULE-GATE — server-authored ontology rule corpus for this agent's domain,
   * threaded from `loadModelsFromDisk().rules.payload` at bootstrap.
   *
   * Deliberately NOT read from the manifest: if an agent could supply its own
   * rule corpus it could shrink the set of rules that govern it, and severity
   * (`failurePolicy`/`enforcementLevel`) would stop being authoritative. Same
   * trust property as `factoryExecutionScope` — a manifest cannot manufacture it.
   */
  ontologyRules?: unknown[];
  /**
   * #RULE-GATE — server-authored tool → rule-id bindings derived from the
   * ontology's own `action_steps[].rules[]`. The ontology ALREADY states which
   * rules govern which tool step; without this the binding would have to be
   * re-authored per manifest, and an agent that simply omitted it would be
   * silently exempt.
   */
  ontologyRuleBindings?: Record<string, string[]>;
  /**
   * #DISPATCH-VERIFY — per-tool probe verification state as persisted, keyed by
   * tool name. Threaded from the factory tool rows at bootstrap because the
   * declarative overlay deliberately rebuilds only the request template and the
   * policy triple; without this the dispatcher has nothing to check and an
   * expired or failed probe executes anyway.
   */
  factoryToolProbeState?: Record<string, ToolProbeState>;
  /**
   * #RULE-GATE — obligations that govern a whole ACTION rather than one tool
   * call. Measured need: of RAAS's 144 ontology rule references, 110 hang off
   * steps whose `object_type` is `logic` — they govern a reasoning step, not an
   * outbound call, so a tool-boundary gate structurally cannot reach them.
   *
   * The rule SELECTION is not declared here: it comes from the server-authored
   * `ontologyRuleBindings` keyed on the action name, which the ontology step
   * shares. Only the evidence location and the mode are authored.
   */
  action_rule_gate?: unknown;
}

interface ActionToolBoundary {
  /** `false` is the legacy hand-written-manifest compatibility path. */
  explicit: boolean;
  agentAllowed: string[];
  actionAllowed: string[];
  effective: string[];
}

function resolveActionToolBoundary(
  action: Pick<ActionSpec, "allowed_tools">,
  agent?: AgentSlots,
): ActionToolBoundary {
  const agentAllowed = [
    ...new Set(
      (agent?.tool_use ?? []).map((entry) => entry.name.trim()).filter(Boolean),
    ),
  ];
  if (action.allowed_tools === undefined) {
    return {
      explicit: false,
      agentAllowed,
      actionAllowed: agentAllowed,
      effective: agentAllowed,
    };
  }
  const actionAllowed = [
    ...new Set(action.allowed_tools.map((name) => name.trim()).filter(Boolean)),
  ];
  const actionSet = new Set(actionAllowed);
  return {
    explicit: true,
    agentAllowed,
    actionAllowed,
    effective: agentAllowed.filter((name) => actionSet.has(name)),
  };
}

function hasVerifiedSandboxProfile(
  agent: AgentSlots | undefined,
  toolName: string,
): boolean {
  return (
    agent?.factoryExecutionScope?.kind === "sandbox" &&
    typeof agent.factoryToolProfileRefs?.[toolName] === "string" &&
    agent.factoryToolProfileRefs[toolName]!.trim().length > 0
  );
}

/** Hard cap on tool-use iterations per `logic` action. Anything above 8
 * usually means the model is looping; we'd rather fail loud than burn
 * tokens forever. Override via `AGENTIC_TOOL_USE_MAX_ITERS` for stress
 * tests. */
const MAX_TOOL_USE_ITERS_DEFAULT = 8;
function resolveMaxIters(agent?: AgentSlots): number {
  // An authored v2 tool-loop budget wins over the env override.
  const authored = agent?.tool_loop?.max_iterations;
  if (typeof authored === "number" && Number.isFinite(authored)) {
    return Math.max(1, Math.min(100, Math.floor(authored)));
  }
  const raw = process.env.AGENTIC_TOOL_USE_MAX_ITERS;
  if (!raw) return MAX_TOOL_USE_ITERS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : MAX_TOOL_USE_ITERS_DEFAULT;
}

/** Best-effort structured trace append — trace IO must never abort a step. */
async function emitTraceBestEffort(
  trace: RuntimeTraceSink | undefined,
  event: Parameters<RuntimeTraceSink["append"]>[0],
): Promise<void> {
  try {
    await appendRuntimeTrace(trace, event);
  } catch (error) {
    console.warn(
      `[step-engine] structured trace append failed (run=${event.runId}, name=${event.name}):`,
      error,
    );
  }
}

export interface StepInput {
  ctx: ToolContext;
  action: ActionSpec;
  /** Caller-sanitized prior user/assistant turns for a continued Test Lab run. */
  conversationHistory?: AgentConversationTurn[];
  /**
   * Optional agent-level metadata that influences prompt assembly:
   *   - `description` is concatenated into the runtime prelude
   *   - `ontology_instructions` is appended to the system message
   * Pure-runtime callers (Inngest worker) pass the AgentSpec slice; tests
   * pass an inline shape.
   */
  agent?: AgentSlots;
  /** Tenant-specific tools + prompts; consulted before generic fallbacks. */
  tenantRegistry?: TenantRegistry;
  /**
   * When true (M4), manual steps log + skip rather than wait for task
   * resolution. M8 flips this to false and wires real waitForEvent + task
   * creation.
   */
  autoResolveManual?: boolean;
  /**
   * Per P0-RT-09: when both `runId` and `stepOrd` are set, the engine
   * writes JSON sidecars to AGENTIC_ARTIFACTS_DIR/<runId>/step-<ord>-{input,output}.json
   * so downstream consumers (UI, debug) can reconstruct the call.
   */
  runId?: string;
  /** Durable step row id, when the caller has allocated one. */
  stepId?: string;
  stepOrd?: number;
  /** Optional persistence seam for Studio/operator structured trace rows. */
  trace?: RuntimeTraceSink;
  /** Only the terminal action is validated against agent-level outputs (v2). */
  finalOutput?: boolean;
  /**
   * Sanitized account/request attribution recovered from the private Inngest
   * envelope. It is never exposed to prompts or tools.
   */
  usageAttribution?: UsageAttribution;
  /**
   * #REDESIGN FU1 — the REAL durable MemoryHandle for this run (createMemoryHandle), threaded from the
   * delivered adapter (register.ts). Passed into generated-code execution so a deployed agent's handler
   * gets persistent vector-recall memory instead of an ephemeral map. Undefined for pure-runtime/test
   * callers → codeact falls back to an in-process handle.
   */
  memory?: MemoryHandle;
  /** Optional step-safe host bindings for generated-code RPC. Production `invoke` must be supplied
   * by a durable caller; missing bindings fail the generated-code run rather than returning null. */
  generatedCodeHostRuntime?: GeneratedCodeHostRuntime;
  /** Trusted CodeAct executor seam used by focused tests. Production resolves
   * the Docker socket transport inside runGeneratedCodeIsolated. */
  generatedCodeContainerTransport?: CodeActDockerTransport;
  generatedCodeCandidateImage?: string;
  /** Durable orchestration primitives supplied by register.ts for actions
   * nested under foreach. A container is interpreted recursively, while each
   * leaf side effect receives a content-addressed step id. */
  durableActionRuntime?: {
    run(
      stepId: string,
      operation: () => Promise<StepOutput>,
      /** Human label for the body step (evidence records/logs). Optional so
       * bare test runtimes keep working; register.ts consumes it. */
      label?: { actionName?: string },
    ): Promise<StepOutput>;
    invoke(args: {
      stepId: string;
      target: string;
      input: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<unknown>;
  };
  /** Stable parent identity for a nested foreach/invoke action. */
  durableStepId?: string;
  /** Internal absolute deadline inherited from a durable foreach parent. */
  deadlineAt?: number;
  /** Internal resolved budget supplied by the public timeout wrapper. */
  resolvedTimeoutMs?: number;
}

export interface StepOutput {
  ok: boolean;
  type: ActionSpec["type"];
  data: unknown;
  tokensIn?: number;
  tokensOut?: number;
  /** Real gateway-returned model id (P0-RT-04). */
  model?: string;
  /** Real gateway-returned provider id (P0-RT-04). */
  provider?: string;
  /** Absolute path to step-<ord>-output.json when artifacts are written. */
  outputArtifact?: string;
  /** Set for manual steps that haven't been resolved yet. */
  pendingTaskTitle?: string;
  meta?: Record<string, unknown>;
  /**
   * #RUN-EVIDENCE (D6) — per-call evidence ledger entries persisted by the
   * durable body steps under this output. Rides the RETURN VALUE (which for a
   * body step is the memoized `step.run` result) so a replay reconciles
   * against the same recorded calls; a foreach container aggregates its
   * children's entries here so the run-level ledger counts every dispatch at
   * every nesting depth.
   */
  toolLedger?: ToolCallLedgerEntry[];
}

/**
 * #RULE-GATE — the generated-code (CodeAct) tool binding.
 *
 * Extracted as a named seam for the same reason `dispatchInvokeRpc` was: this is
 * the third path that can reach a tool handler, and a gate that exists on the
 * other two but is merely *believed* to exist here is not a gate. Keeping it a
 * closure made that belief untestable.
 *
 * Enforces, in order: the action capability boundary (unchanged behaviour), then
 * the ontology rule obligations — a capability set says whether this agent may
 * ever call the tool, never whether it may call it on this run.
 */
export async function dispatchGeneratedCodeTool(args: {
  name: string;
  args?: unknown;
  ctx: ToolContext;
  agent: AgentSlots | undefined;
  declaredCodeToolSet: ReadonlySet<string>;
  tenantRegistry?: TenantRegistry;
  scope: StepScope;
}): Promise<unknown> {
  const { name, ctx, agent, declaredCodeToolSet, tenantRegistry, scope } = args;
  if (!declaredCodeToolSet.has(name)) {
    throw new Error(
      `[action_tool_not_allowed] generated-code tool '${name}' is outside the current action capability boundary`,
    );
  }
  const tenantTool = tenantRegistry?.tools?.[name];
  const globalTool = tenantTool ? undefined : globalToolRegistry.get(name);
  const descriptor = tenantTool ?? globalTool;
  if (!descriptor) throw new Error(`generated-code tool '${name}' is not registered`);

  const gate = evaluateToolRuleGate({ agent, toolName: name, scope });
  if (gate && !gate.decision.allowed) {
    throw new Error(
      gate.decision.steer ??
        `rule_gate_refused: generated-code tool '${name}' has unsatisfied ontology rule obligations`,
    );
  }

  const toolUse = agent?.tool_use?.find((entry) => entry.name === name);
  const toolData =
    args.args && typeof args.args === "object" && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : { value: args.args };
  const toolCtx: ToolContext = {
    ...ctx,
    actionName: name,
    event: {
      name: ctx.event?.name ?? "generated-code.tool",
      data: toolData,
    },
    ...(toolUse?.config ? { config: toolUse.config } : {}),
  };
  const toolResult = await runTenantTool(toolCtx, descriptor);
  if (!toolResult.ok) {
    throw new Error(
      `generated-code tool '${name}' failed: ${JSON.stringify(toolResult.meta ?? toolResult.data)}`,
    );
  }
  return toolResult.data;
}

async function runTenantTool(
  ctx: ToolContext,
  tool: ToolDescriptor,
): Promise<StepOutput> {
  const result = await tool.handler(ctx);
  // Optional structured-output validation
  let validated = result.data;
  if (tool.output) {
    const parsed = tool.output.safeParse(result.data);
    if (parsed.success) {
      validated = parsed.data;
    } else {
      return {
        ok: false,
        type: "tool",
        data: result.data,
        meta: {
          error: "schema_mismatch",
          tool: tool.name,
          tenant: true,
          schemaError: parsed.error.issues,
        },
      };
    }
  }
  return {
    ok: true,
    type: "tool",
    data: validated,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    meta: { ...result.meta, tool: tool.name, tenant: true },
  };
}

/**
 * Compose the system message:
 *   1. tenant prompt override (if any) — wins first position so the LLM
 *      reads it before the runtime prelude
 *   2. runtime prelude — generic "you are an agentic workflow step" framing
 *   3. agent description
 *   4. agent ontology_instructions
 * Empty segments are skipped.
 */
function buildSystemMessage(parts: {
  tenantOverride?: string;
  agentDescription?: string;
  ontologyInstructions?: string;
}): string {
  const lines: string[] = [];
  if (parts.tenantOverride) lines.push(parts.tenantOverride);
  lines.push(
    "You are an LLM-driven step inside an agentic workflow. Reply concisely and follow the rubric in the user message.",
  );
  if (parts.agentDescription) lines.push(parts.agentDescription);
  if (parts.ontologyInstructions) lines.push(parts.ontologyInstructions);
  return lines.join("\n\n");
}

async function callLLM(
  rendered: string,
  preferredModel?: string,
  systemOverride?: string,
  agent?: AgentSlots,
  tenantRegistry?: TenantRegistry,
  ctx?: ToolContext,
  action?: ActionSpec,
  jsonMode = false,
  execution?: {
    /** Prepared v2 message pair — replaces the legacy system/user assembly. */
    messages?: ChatMessage[];
    trace?: RuntimeTraceSink;
    runId?: string;
    stepId?: string;
    usageAttribution?: UsageAttribution;
  },
): Promise<{
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  toolCalls: ToolCallTrace[];
  turns: LlmTurnTrace[];
  terminalError?: string;
}> {
  const gateway = getRuntimeGateway();
  if (!gateway) {
    throw new Error(
      "[step-engine] LLMGateway not initialised — apps/api bootstrap must call setRuntimeGateway()",
    );
  }
  // Agent Studio v2 detection (deterministic, side-effect free). Drives the
  // stricter per-call tool gates; a normalization failure keeps v1 behavior.
  let isV2Agent = false;
  try {
    isV2Agent =
      agent !== undefined &&
      normalizeAgentForExecution(agent).compatibilityMode === "v2";
  } catch {
    isV2Agent = false;
  }
  const systemContent = buildSystemMessage({
    tenantOverride: systemOverride,
    agentDescription: agent?.description,
    ontologyInstructions: agent?.ontology_instructions,
  });

  // Build the action-scoped ToolDef[] roster ONCE per logic action. Every tool
  // in the effective agent/action intersection must resolve before the model
  // runs; tools outside that intersection are neither advertised nor callable.
  const tools: ToolDef[] = [];
  const boundary = resolveActionToolBoundary(action ?? {}, agent);
  const effectiveToolAllowlist = new Set(boundary.effective);
  const effectiveToolEntries = (agent?.tool_use ?? []).filter((entry) =>
    effectiveToolAllowlist.has(entry.name.trim()),
  );
  if (effectiveToolEntries.length > 0) {
    for (const entry of effectiveToolEntries) {
      // Tenant tool wins; otherwise fall back to the global registry so a
      // declared global tool (ontology.fetchActionRules, fs.*, meta.ping, …) is
      // advertised to the model. Per the global-registry contract, any global
      // tool is callable by ANY agent that lists it in tool_use[] — the
      // allow-list is the trust boundary — so this applies to hand-authored
      // agents too. The per-call gate below still rejects UNdeclared calls.
      const handler =
        tenantRegistry?.tools?.[entry.name] ??
        globalToolRegistry.get(entry.name);
      if (!handler) {
        throw new Error(
          `agent ${agent?.name ?? "unknown"} declares unresolved tool ${entry.name}; refusing to run with a silently reduced tool roster`,
        );
      }
      tools.push({
        name: entry.name,
        description: entry.description ?? handler.description ?? entry.name,
        // #ARG-CONTRACT (D3) — a manifest-declared schema still wins, but when
        // the manifest is silent, fall back to the contract the tool ITSELF
        // declares before resorting to the permissive stand-in. Advertising
        // `{additionalProperties:true}` while the descriptor holds a real schema
        // is what left every MCP tool, and every catalog tool a manifest did not
        // re-describe, with a contentless contract the model had to guess at.
        input_schema: isPlainSchema(entry.input_schema)
          ? entry.input_schema
          : isPlainSchema(handler.inputSchema)
            ? handler.inputSchema
            : { type: "object", additionalProperties: true },
      });
    }
  }

  const messages: ChatMessage[] = execution?.messages
    ? structuredClone(execution.messages)
    : [
        { role: "system", content: systemContent },
        { role: "user", content: rendered },
      ];

  // Tool-use loop. When no tools are advertised this is a single pass and
  // exits immediately — same shape as the old single-call path.
  const maxIters = resolveMaxIters(agent);
  let totalIn = 0;
  let totalOut = 0;
  let lastProvider = "";
  let lastModel = "";
  let finalText = "";
  const toolCalls: ToolCallTrace[] = [];
  // #W0 — raw per-turn capture (response text + reasoning + requested tools),
  // surfaced up to register.ts which persists it to `llm_turns`. This is the
  // only site that sees every turn's full response, incl. provider-native
  // reasoning via response.raw.
  const turns: LlmTurnTrace[] = [];
  let terminalError: string | undefined;

  for (let iter = 0; iter < maxIters; iter++) {
    // #ACI (P1-8) — collapse tool outputs older than the last N rounds to one line before每轮调用
    // （SWE-agent实测：只留最近5条完整观察优于全量历史 +3.0pp；折叠幂等，标记可见不装没发生）。
    foldOldToolResults(messages as Array<{ role: string; content: unknown }>);
    // Per-agent AI settings (provider/reasoning/verbosity/store/temperature/
    // max_tokens/timeout) + gateway routing (task_class) + durable billing
    // attribution all ride the request. Omitted fields inherit gateway policy.
    const chatRequest: ChatRequest = {
      messages,
      model: preferredModel,
      provider: agent?.provider,
      reasoning: agent?.reasoning,
      verbosity: agent?.verbosity,
      store: agent?.store,
      temperature: agent?.temperature,
      maxTokens: agent?.max_tokens,
      timeoutMs:
        typeof agent?.timeout_s === "number"
          ? agent.timeout_s * 1_000
          : undefined,
      tools: tools.length > 0 ? tools : undefined,
      jsonMode,
      signal: ctx?.signal,
      tenantId: ctx?.tenantId ?? agent?.tenantId,
      runId: execution?.runId ?? ctx?.runId,
      stepId: execution?.stepId,
      tenantSlug: ctx?.tenantSlug,
      purpose: ctx
        ? `agent:${ctx.agentName}/step:${ctx.actionName}`
        : "step-engine",
      routing: { taskType: agent?.task_class ?? "tool.loop" },
      attribution: execution?.usageAttribution,
    };
    const llmStartedAt = new Date();
    let response: ChatResponse;
    try {
      response = execution?.usageAttribution
        ? await runWithUsageAttribution(execution.usageAttribution, () =>
            gateway.chat(chatRequest),
          )
        : await gateway.chat(chatRequest);
    } catch (error) {
      if (execution?.runId) {
        const llmEndedAt = new Date();
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "llm",
          level: "minimal",
          name: "llm.call",
          status: "failed",
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: Math.max(
            0,
            llmEndedAt.getTime() - llmStartedAt.getTime(),
          ),
          summary: "Model call failed",
          data: {
            iteration: iter + 1,
            error: error instanceof Error ? error.message : String(error),
          },
          visibility: "operator",
        });
      }
      throw error;
    }
    totalIn += response.tokensIn ?? 0;
    totalOut += response.tokensOut ?? 0;
    lastProvider = response.provider;
    lastModel = response.model;
    if (execution?.runId) {
      const llmEndedAt = new Date();
      await emitTraceBestEffort(execution.trace, {
        runId: execution.runId,
        ...(execution.stepId ? { stepId: execution.stepId } : {}),
        kind: "llm",
        level: "standard",
        name: "llm.call",
        status: "ok",
        startedAt: llmStartedAt,
        endedAt: llmEndedAt,
        durationMs: Math.max(0, llmEndedAt.getTime() - llmStartedAt.getTime()),
        summary: `Model call completed with ${(response.toolCalls ?? []).length} tool request(s)`,
        data: {
          provider: response.provider,
          model: response.model,
          iteration: iter + 1,
          tokensIn: response.tokensIn ?? 0,
          tokensOut: response.tokensOut ?? 0,
          finishReason: response.finishReason,
        },
        visibility: "operator",
      });
      if (response.reasoningSummary) {
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "llm",
          level: "standard",
          name: "llm.reasoning_summary",
          status: "ok",
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: Math.max(
            0,
            llmEndedAt.getTime() - llmStartedAt.getTime(),
          ),
          summary: response.reasoningSummary,
          data: {
            provider: response.provider,
            model: response.model,
            reasoning: response.reasoning,
          },
          visibility: "user",
        });
      }
    }

    const requestedCalls = response.toolCalls ?? [];

    turns.push({
      ord: iter,
      promptPreview: iter === 0 ? capText(rendered, 4000) : undefined,
      responseText: capText(response.text ?? "", 8000),
      requestMessages: structuredClone(messages),
      requestTools: structuredClone(tools),
      responseTextFull: response.text ?? "",
      reasoningFull:
        extractReasoning(response.raw) ?? response.reasoningSummary ?? null,
      responseToolCalls: requestedCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
      // Provider-native reasoning from raw, else the gateway's normalized
      // deliberately-summarized reasoning. The opaque replay-only
      // `reasoningContent` is intentionally NEVER persisted (contract).
      reasoning: capText(
        extractReasoning(response.raw) ?? response.reasoningSummary ?? null,
        8000,
      ),
      toolCalls: requestedCalls.map((c) => ({
        name: c.name,
        input: capValue(c.input, 1500),
      })),
      provider: response.provider,
      model: response.model,
      tokensIn: response.tokensIn ?? 0,
      tokensOut: response.tokensOut ?? 0,
      finishReason: response.finishReason,
      latencyMs: response.latencyMs ?? 0,
    });
    if (agent?.generated || boundary.explicit) {
      const forbidden = [
        ...new Set(
          requestedCalls
            .map((call) => call.name.trim())
            .filter((name) => !effectiveToolAllowlist.has(name)),
        ),
      ];
      if (forbidden.length) {
        terminalError = boundary.explicit
          ? `[action_tool_not_allowed] Action「${ctx?.actionName ?? "unknown"}」请求了不在 agent.tool_use 与 action.allowed_tools 交集内的工具：${forbidden.join("、")}；已拒绝执行。` +
            `当前 Action 允许：${boundary.actionAllowed.length ? [...boundary.actionAllowed].sort().join("、") : "（无）"}；Agent 允许：${boundary.agentAllowed.length ? [...boundary.agentAllowed].sort().join("、") : "（无）"}`
          : `[generated_tool_not_declared] 生成 Agent「${agent?.name ?? "unknown"}」请求了未在不可变 agent.tool_use 中声明的工具：${forbidden.join("、")}；已拒绝执行。` +
            `允许工具：${effectiveToolAllowlist.size ? [...effectiveToolAllowlist].sort().join("、") : "（无）"}`;
        break;
      }
    }
    if (requestedCalls.length === 0) {
      // Model returned prose — we're done.
      finalText = response.text;
      if (!finalText.trim()) {
        terminalError = `provider ${response.provider}/${response.model} returned an empty final response`;
      }
      break;
    }

    // Echo back an assistant message containing the model's tool_use blocks
    // so the next turn has the right conversation history. Opaque provider
    // reasoning state (DeepSeek/Kimi/GLM) must be replayed verbatim on the
    // assistant tool-call turn — transport state only, never logged.
    const assistantBlocks: ChatContentBlock[] = [];
    if (response.text)
      assistantBlocks.push({ type: "text", text: response.text });
    for (const call of requestedCalls) {
      const block: ToolUseBlock = {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      };
      assistantBlocks.push(block);
    }
    messages.push({
      role: "assistant",
      content: assistantBlocks,
      ...(response.reasoningContent
        ? { reasoningContent: response.reasoningContent }
        : {}),
    });

    // Execute each tool call, collect tool_result blocks for the next turn.
    const resultBlocks: ChatContentBlock[] = [];
    for (const call of requestedCalls) {
      // Resolution chain: tenant override → global registry → not found.
      // Tenant wins on collision so a tenant can ship a custom impl that
      // shadows a global tool. The MCP layer already folds its tools into
      // tenantRegistry under namespaced names ("<server>.<tool>"), so it's
      // covered by the first lookup.
      const tenantHandler = tenantRegistry?.tools?.[call.name];
      const globalHandler = tenantHandler
        ? undefined
        : globalToolRegistry.get(call.name);
      const handler = tenantHandler ?? globalHandler;

      // Per-tenant config plumbing: lift the manifest's
      // `tool_use[i].config` blob into ctx.config so global tools can be
      // specialised per tenant (api_key_env, subdir, etc.) without code.
      const toolUseEntry = agent?.tool_use?.find(
        (t) => (t as { name?: string })?.name === call.name,
      );
      const toolConfig =
        toolUseEntry && typeof toolUseEntry === "object"
          ? ((toolUseEntry as { config?: Record<string, unknown> }).config ??
            undefined)
          : undefined;

      const callCtx: ToolContext = {
        agentName: ctx?.agentName ?? agent?.name ?? "unknown",
        actionName: call.name,
        ontologyActionName: ctx?.ontologyActionName,
        subject: ctx?.subject,
        correlationId: ctx?.correlationId ?? "no-correlation",
        signal: ctx?.signal,
        runId: ctx?.runId,
        tenantSlug: ctx?.tenantSlug ?? "unknown",
        tenantId: ctx?.tenantId,
        event: ctx?.event,
        // Each tool sees the prior tool's output as lastResult — gives the
        // model the option to chain without re-quoting state through the prompt.
        lastResult:
          toolCalls.length > 0
            ? toolCalls[toolCalls.length - 1]!.output
            : ctx?.lastResult,
        config: toolConfig,
        memory: ctx?.memory, // #P0-1 — durable memory reaches each tool in the tool-use loop
      };

      const startedAt = Date.now();
      // `agent.tool_use[]` (∩ action.allowed_tools) is the execution
      // allow-list, not merely a hint to the provider: a model must not be
      // able to manufacture an undeclared call and reach any registered
      // handler. (Generated/explicit-boundary agents already fail the whole
      // loop above; this per-call gate covers hand-authored agents too.)
      const callIsAllowed = effectiveToolAllowlist.has(call.name.trim());
      const resolvedVia = !callIsAllowed
        ? "not-allowed"
        : tenantHandler
          ? "tenant"
          : globalHandler
            ? "global"
            : "unresolved";
      if (execution?.runId) {
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "tool",
          level: "standard",
          name: call.name,
          status: "running",
          startedAt: new Date(startedAt),
          summary: callIsAllowed
            ? `Dispatching allowed tool '${call.name}'`
            : `Rejecting undeclared tool '${call.name}'`,
          data: { iteration: iter + 1, resolvedVia },
          visibility: "operator",
        });
      }
      let outputBody: string;
      let isError = false;
      let outputData: unknown = null;
      let sandboxDispatch: FactorySandboxDispatchReceipt | undefined;
      let ruleGateRecord: ToolCallRuleGateRecord | undefined;
      let probeRecord: ProbeVerificationResult | undefined;
      // #EFFECT-READBACK — hoisted out of the try so the read-back below can
      // see the SAME reviewed policy and the SAME dispatch decision this call
      // actually ran under. Re-deriving either afterwards would risk confirming
      // an effect against a different decision than the one that produced it.
      let callReviewedPolicy: ToolExecutionPolicy | undefined;
      let callDispatchDecision: string | undefined;
      try {
        if (!callIsAllowed) {
          throw new Error(
            `tool '${call.name}' is not declared in this agent's tool_use allow-list`,
          );
        }
        if (!handler) {
          throw new Error(
            `tool '${call.name}' not registered for this tenant and not found in global registry`,
          );
        }
        // v2 contract: a declared tool input schema is enforced immediately
        // before dispatch (the error feeds back so the model self-corrects).
        if (isV2Agent && isPlainSchema(toolUseEntry?.input_schema)) {
          const schemaIssues = validateValueAgainstJsonSchema(
            toolUseEntry.input_schema,
            call.input,
            "/tool/input",
            "tool_input_schema",
          );
          if (schemaIssues.length > 0) {
            throw new Error(
              `tool_input_schema_invalid: ${schemaIssues
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join("; ")}`,
            );
          }
        }
        // #ARG-CONTRACT (D3) — when the manifest declared no schema, the tool's
        // own contract still applies. Types only, never required-ness: see
        // `validateSuppliedArgTypes` for why omission is legitimate here.
        if (!isPlainSchema(toolUseEntry?.input_schema)) {
          const argIssues = validateSuppliedArgTypes(
            isPlainSchema(handler?.inputSchema) ? handler.inputSchema : undefined,
            call.input,
          );
          if (argIssues.length > 0) {
            throw new Error(
              `tool_arguments_invalid: ${argIssues
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join("; ")}`,
            );
          }
        }
        // #RULE-GATE — ontology rule obligations are a PRECONDITION, evaluated
        // here beside the schema check and before any sandbox/dispatch decision.
        // A refusal comes back as a tool_result error so the model can go get
        // the missing verdict instead of retrying the same illegal call.
        const gate = evaluateToolRuleGate({
          agent,
          toolName: call.name,
          scope: {
            event: ctx?.event,
            subject: ctx?.subject,
            lastResult: ctx?.lastResult,
            results: ctx?.results,
            locals: ctx?.locals,
          },
        });
        if (gate) {
          ruleGateRecord = gate.record;
          if (!gate.decision.allowed) {
            throw new Error(
              gate.decision.steer ??
                `rule_gate_refused: tool '${call.name}' has unsatisfied ontology rule obligations`,
            );
          }
        }
        // #REDESIGN P1b — the LLM tool-use loop must honour sandbox gating too (not just the
        // type:"tool" plan path): in a `-sb` tenant, READS run live, external WRITES are gated
        // (marker, not fired) unless a server-owned attempt grant exists; mock/replay short-circuit.
        const reviewedPolicy = reviewedExecutionPolicy(
          call.name,
          toolUseEntry,
          !!globalHandler,
        );
        callReviewedPolicy = reviewedPolicy;
        // #DISPATCH-VERIFY (D8) — a probe verified at promote time says nothing
        // about the definition running now. Checked here, against the reviewed
        // policy rather than the tool's name.
        const probeResult = verifyToolProbeAtDispatch({
          agent,
          toolName: call.name,
          policy: reviewedPolicy,
          declaredSideEffect: toolUseEntry?.side_effect,
        });
        if (probeResult) {
          probeRecord = probeResult;
          // #PROBE-DEFER — a service that simply is not deployed yet must not
          // block an FDE who has the credential wired. The deferral is carried
          // on the call record instead; a rejection or a missing credential
          // still refuses.
          if (
            !probeResult.verified &&
            !probeResult.deferrable &&
            probeVerificationPolicyFromEnv(process.env) === "refuse"
          ) {
            throw new Error(
              `probe_verification_failed: ${probeResult.issues.map((i) => i.code).join(", ")} — ${probeResult.issues.map((i) => i.detail).join("; ")}`,
            );
          }
        }
        const factoryDecision = factorySandboxDispatchDecision(
          reviewedPolicy,
          callCtx.tenantSlug,
          agent?.factoryExecutionScope,
        );
        const sbDecision =
          factoryDecision ??
          (isSandboxTenant(callCtx.tenantSlug)
            ? toolDispatchDecision(reviewedPolicy, sandboxToolMode(), {
                sandboxProfileVerified: hasVerifiedSandboxProfile(
                  agent,
                  call.name,
                ),
              })
            : "live");
        callDispatchDecision = sbDecision;
        if (sbDecision === "reject") {
          throw new Error(
            `tool '${call.name}' is missing valid reviewed execution_policy metadata`,
          );
        }
        if (factoryDecision === "replay") {
          const scope = agent?.factoryExecutionScope;
          if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
            throw new Error(
              `factory sandbox replay scope is missing for tool '${call.name}'`,
            );
          }
          const replayed = await replayFactorySandboxTool({
            scope,
            tenantSlug: callCtx.tenantSlug!,
            toolName: call.name,
            toolArgs: call.input,
            policy: reviewedPolicy,
            replayRef: agent.factoryToolReplayRefs?.[call.name],
          });
          outputData = replayed.body;
          sandboxDispatch = replayed.receipt;
          const faultLoop = injectedFault(ctx?.event?.data, call.name);
          if (faultLoop) outputData = faultResult(call.name, faultLoop.kind);
          outputBody = stringifyToolPayload(outputData);
        } else if (sbDecision !== "live") {
          const replayed =
            sbDecision === "replay"
              ? await cassetteLookup(callCtx.tenantSlug!, call.name, call.input)
              : undefined;
          if (sbDecision === "replay" && replayed === undefined) {
            throw new Error(
              `No replay cassette exists for tool '${call.name}'`,
            );
          }
          outputData =
            sbDecision === "gate_profile"
              ? gatedToolMarker(call.name, call.input, "sandbox_profile")
              : sbDecision === "gate_grant"
                ? gatedToolMarker(
                    call.name,
                    call.input,
                    "requires_attempt_grant",
                  )
                : (replayed ?? sandboxToolStub(call.name));
          const faultLoop = injectedFault(ctx?.event?.data, call.name); // #W3-FAULT — poisoned tool in the LLM loop
          if (faultLoop) outputData = faultResult(call.name, faultLoop.kind);
          // #W1-9 — make the sandbox decision VISIBLE in the artifact: a mocked/gated call must never
          // read like a real one in the run trace.
          if (outputData && typeof outputData === "object")
            (outputData as Record<string, unknown>).__sbDecision = sbDecision;
          outputBody = stringifyToolPayload(outputData);
        } else {
          if (factoryDecision === "live") {
            const scope = agent?.factoryExecutionScope;
            if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
              throw new Error(
                `factory sandbox local scope is missing for tool '${call.name}'`,
              );
            }
            sandboxDispatch = await recordFactorySandboxLocalDispatch({
              scope,
              tenantSlug: callCtx.tenantSlug!,
              toolName: call.name,
              toolArgs: call.input,
              policy: reviewedPolicy,
            });
          }
          // Merge the model's tool-call input into the context so handlers
          // that prefer args over ctx.event.data have a single read site.
          const handlerCtx = {
            ...callCtx,
            event: { name: `tool:${call.name}`, data: call.input },
          };
          const r = await handler.handler(handlerCtx);
          if (handler.output) {
            const parsed = handler.output.safeParse(r.data);
            if (!parsed.success) {
              throw new Error(
                `tool '${call.name}' returned data that violates its output schema: ${JSON.stringify(parsed.error.issues)}`,
              );
            }
            outputData = parsed.data;
          } else {
            outputData = r.data;
          }
          outputBody = stringifyToolPayload(outputData);
          totalIn += r.tokensIn ?? 0;
          totalOut += r.tokensOut ?? 0;
        }
      } catch (err) {
        isError = true;
        const error = String(err instanceof Error ? err.message : err);
        // Never retain an unserialisable value as if it were a successful
        // observation.  The trace and the model both receive the same
        // explicit error receipt.
        outputData = { error };
        outputBody = JSON.stringify(outputData);
      }
      // #EFFECT-READBACK (D6) — for a call that CLAIMS an external effect, ask
      // somebody other than the tool. Emitted for every write-capable call,
      // including the ones nobody declared a read-back for: "not verified with
      // a reason" is the honest record, and omitting it would let an
      // unconfirmed write reconcile as if it had nothing to confirm.
      const effectVerification: EffectVerificationReceipt | undefined =
        toolClaimsEffect(callReviewedPolicy, toolUseEntry?.side_effect)
          ? isError
            ? unverifiedEffect("write_errored", {
                detail: `tool '${call.name}' returned an error; there is no claimed effect to confirm`,
              })
            : callDispatchDecision !== undefined && callDispatchDecision !== "live"
              ? unverifiedEffect("write_not_real", {
                  detail: `dispatch decision '${callDispatchDecision}' — nothing was written, so nothing can be read back`,
                })
              : await verifyClaimedEffect({
                  toolName: call.name,
                  entry: toolUseEntry,
                  useGlobalMetadata: !!globalHandler,
                  input: call.input,
                  output: outputData,
                  resolveReadTool: (name) => {
                    // Same resolution chain and same allow-list as the call
                    // being verified — a read-back never widens the boundary.
                    const tenantRead = tenantRegistry?.tools?.[name];
                    const globalRead = tenantRead
                      ? undefined
                      : globalToolRegistry.get(name);
                    const readEntry = agent?.tool_use?.find(
                      (t) => (t as { name?: string })?.name === name,
                    );
                    let decision = "live";
                    try {
                      const readPolicy = reviewedExecutionPolicy(
                        name,
                        readEntry,
                        !!globalRead,
                      );
                      const factoryRead = factorySandboxDispatchDecision(
                        readPolicy,
                        callCtx.tenantSlug,
                        agent?.factoryExecutionScope,
                      );
                      decision =
                        factoryRead ??
                        (isSandboxTenant(callCtx.tenantSlug)
                          ? toolDispatchDecision(readPolicy, sandboxToolMode(), {
                              sandboxProfileVerified: hasVerifiedSandboxProfile(
                                agent,
                                name,
                              ),
                            })
                          : "live");
                    } catch {
                      // A read tool whose policy cannot be reviewed is not a
                      // live observation. Fail toward unverified.
                      decision = "reject";
                    }
                    // #RULE-GATE — the read tool is judged by the same gate the
                    // ordinary dispatch path would apply to it.
                    let gateAllowed = true;
                    try {
                      const readGate = evaluateToolRuleGate({
                        agent,
                        toolName: name,
                        scope: {
                          event: ctx?.event,
                          subject: ctx?.subject,
                          lastResult: ctx?.lastResult,
                          results: ctx?.results,
                          locals: ctx?.locals,
                        },
                      });
                      gateAllowed = readGate ? readGate.decision.allowed : true;
                    } catch {
                      // A malformed gate cannot be evaluated, so it cannot
                      // authorize anything.
                      gateAllowed = false;
                    }
                    return {
                      allowed: effectiveToolAllowlist.has(name.trim()),
                      ...(tenantRead ?? globalRead
                        ? { handler: (tenantRead ?? globalRead)! }
                        : {}),
                      decision,
                      gateAllowed,
                    };
                  },
                  makeContext: (name, args) => ({
                    ...callCtx,
                    actionName: name,
                    config: (
                      agent?.tool_use?.find(
                        (t) => (t as { name?: string })?.name === name,
                      ) as { config?: Record<string, unknown> } | undefined
                    )?.config,
                    event: { name: `tool:${name}`, data: args },
                  }),
                })
          : undefined;
      const toolDurationMs = Date.now() - startedAt;
      if (execution?.runId) {
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "tool",
          level: isError ? "minimal" : "standard",
          name: call.name,
          status: isError ? "failed" : "ok",
          startedAt: new Date(startedAt),
          endedAt: new Date(startedAt + toolDurationMs),
          durationMs: toolDurationMs,
          summary: isError
            ? `Tool '${call.name}' failed`
            : `Tool '${call.name}' completed`,
          data: { iteration: iter + 1, resolvedVia, isError },
          visibility: "operator",
        });
      }
      toolCalls.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: outputData,
        isError,
        durationMs: toolDurationMs,
        ...(sandboxDispatch ? { sandboxDispatch } : {}),
        ...(callDispatchDecision ? { sandboxDecision: callDispatchDecision } : {}),
        ...(ruleGateRecord ? { ruleGate: ruleGateRecord } : {}),
        ...(probeRecord ? { probe: probeRecord } : {}),
        ...(effectVerification ? { effectVerification } : {}),
      });

      // #ACI (P1-8) — window the observation + make empty success EXPLICIT (silence otherwise
      // reads as failure and triggers pointless retries; SWE-agent ships the same receipt).
      const windowed = windowToolOutput(outputBody);
      const resultBlock: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: call.id,
        content: windowed.trim()
          ? windowed
          : JSON.stringify({ ok: !isError, note: "（调用成功，无输出）" }),
        is_error: isError || undefined,
      };
      resultBlocks.push(resultBlock);
    }
    messages.push({ role: "tool", content: resultBlocks });

    // Final iteration safety: never turn an unfinished tool loop into
    // synthetic prose that the caller can mistake for a successful answer.
    if (iter === maxIters - 1) {
      terminalError = `tool-use loop hit max ${maxIters} iterations without a final model response`;
    }
  }

  return {
    text: finalText,
    tokensIn: totalIn,
    tokensOut: totalOut,
    provider: lastProvider,
    model: lastModel,
    toolCalls,
    turns,
    terminalError,
  };
}

/**
 * One raw LLM turn captured from the tool-use loop. Persisted to `llm_turns`
 * (via register.ts) and surfaced in the run's reasoning views. Text fields are
 * pre-bounded here so the runtime never hands the DB an unbounded blob.
 */
export interface LlmTurnTrace {
  ord: number;
  promptPreview?: string | null;
  responseText: string | null;
  reasoning: string | null;
  /** Exact provider request/response evidence; persisted in artifact files. */
  requestMessages?: ChatMessage[];
  requestTools?: ToolDef[];
  responseTextFull?: string;
  reasoningFull?: string | null;
  responseToolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolCalls: Array<{ name: string; input: unknown }>;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  latencyMs: number;
}

/** Truncate a string to `max` chars with a compact "+N more" marker. */
function capText(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/** Bound an arbitrary value by its serialized size; oversized → preview marker. */
function capValue(v: unknown, max: number): unknown {
  if (v == null) return v;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch (error) {
    return {
      _unserializable: true,
      _error: String(error instanceof Error ? error.message : error),
    };
  }
  if (s.length <= max) return v;
  return { _truncated: true, _bytes: s.length, _preview: s.slice(0, max) };
}

/**
 * Best-effort extraction of provider-native reasoning/thinking from a chat
 * response's `raw` payload. Anthropic surfaces `thinking` content blocks;
 * OpenAI-family adapters may expose `reasoning`/`reasoning_content`. Returns
 * null when the provider didn't surface any (the common case).
 */
function extractReasoning(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Anthropic: content[].{thinking|redacted_thinking}
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const b of r.content as Array<Record<string, unknown>>) {
      if (b?.type === "thinking" && typeof b.thinking === "string")
        parts.push(b.thinking);
      else if (b?.type === "redacted_thinking")
        parts.push("[redacted thinking]");
    }
    if (parts.join("").trim()) return parts.join("\n");
  }
  // OpenAI-ish: choices[0].message.{reasoning_content|reasoning}
  const choices = r.choices as Array<Record<string, unknown>> | undefined;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  const rc = msg?.reasoning_content ?? msg?.reasoning;
  if (typeof rc === "string" && rc.trim()) return rc;
  if (typeof r.reasoning === "string" && r.reasoning.trim()) return r.reasoning;
  return null;
}

/**
 * One executed tool call, surfaced in the step's `meta.toolCalls` for the
 * UI's trace tab and for downstream emit payloads.
 */
export interface ToolCallTrace {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
  durationMs: number;
  sandboxDispatch?: FactorySandboxDispatchReceipt;
  /**
   * #RUN-EVIDENCE — the dispatch decision this call actually ran under
   * (`live` / `replay` / `gate_profile` / `gate_grant` / `mock`). Recorded
   * explicitly rather than inferred from the presence of a factory receipt:
   * a gated call produces no receipt at all, so absence could not distinguish
   * "ran for real" from "was never dispatched". Undefined only when the call
   * failed before a decision existed.
   */
  sandboxDecision?: string;
  /** #RULE-GATE — the rule verdict this call was judged against. Present on
   * every guarded call, including the ones that were allowed, so the record
   * shows what was checked rather than only what failed. */
  ruleGate?: ToolCallRuleGateRecord;
  /** #DISPATCH-VERIFY — probe standing at the moment of dispatch. Present only
   * for tools that actually require a probe. */
  probe?: ProbeVerificationResult;
  /** #EFFECT-READBACK — whether a declared read-back confirmed the claimed
   * effect. Present on every write-capable call; absent means the call claimed
   * no external effect, which is NOT the same as an unverified one. */
  effectVerification?: EffectVerificationReceipt;
}

/** The auditable residue of one rule-gate evaluation. */
export interface ToolCallRuleGateRecord {
  mode: RuleGateMode;
  allowed: boolean;
  /** True when an enforcing gate would have refused — the whole point of
   * `report` mode is that this stays visible. */
  wouldRefuse: boolean;
  applicable: string[];
  refusals: RuleGateFinding[];
  warnings: RuleGateFinding[];
  scopeAxes: string[];
  verdictSource?: string;
  /** Where the bindings came from, so an unbound call is distinguishable from
   * a call with no governing rules. */
  bindingSource: "ontology" | "manifest" | "both";
}

function isPlainSchema(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * #RULE-GATE — the ontology's binding, looked up across a tool's whole identity.
 *
 * The ontology names a tool with whatever string its `actions.json` used, while
 * the registry deliberately answers to synonyms: `parseResumeApi` and
 * `gohire.parseResume` are back-compat aliases of `gohireParseResumeApi`, all
 * three keys pointing at ONE descriptor. An exact-key lookup therefore loses the
 * binding the moment a manifest is renamed to the canonical name CLAUDE.md asks
 * new manifests to use — same handler dispatched, gate silently gone.
 */
function ontologyBindingsFor(agent: AgentSlots | undefined, toolName: string): string[] {
  const bindings = agent?.ontologyRuleBindings;
  if (!bindings) return [];
  const direct = bindings[toolName];
  if (direct?.length) return direct;
  const descriptor = globalToolRegistry.get(toolName);
  if (!descriptor) return [];
  // Any other registry key resolving to the SAME descriptor is the same tool.
  const merged = new Set<string>();
  for (const [alias, candidate] of globalToolRegistry) {
    if (candidate !== descriptor) continue;
    for (const id of bindings[alias] ?? []) merged.add(id);
  }
  return [...merged];
}

/**
 * #RULE-GATE — resolve and evaluate the rule obligations for one tool call.
 *
 * Returns `null` when no rule governs this call at all. Throws only when a
 * declaration is malformed: a broken gate must not silently become "no gate".
 */
function evaluateToolRuleGate(args: {
  agent: AgentSlots | undefined;
  toolName: string;
  /**
   * The ACTION-level run state, not the per-call handler context. The gate is
   * runtime infrastructure rather than a tool, so the data minimisation applied
   * to handlers (the tool-use loop hands a tool only `lastResult`; an explicit
   * `tool_arguments` mapping strips the carry entirely) must not blind it — the
   * verdict it needs usually lives in `results`.
   */
  scope: StepScope;
}): { decision: RuleGateDecision; record: ToolCallRuleGateRecord } | null {
  const { agent, toolName, scope } = args;
  const entry = agent?.tool_use?.find((t) => t?.name === toolName);
  const rawDeclaration = (entry as { rule_gate?: unknown } | undefined)?.rule_gate;

  const ontologyIds = ontologyBindingsFor(agent, toolName);
  const hasOntologyBinding = ontologyIds.length > 0;
  if (rawDeclaration == null && !hasOntologyBinding) return null;

  // NOTE: an empty corpus is deliberately NOT an early return. A declared gate
  // whose corpus never arrived is unresolvable, not absent, and returning "no
  // gate" here turned a manifest `mode:"enforce"` into a silent allow in the
  // 5 of 7 shipped model dirs that carry no rules file. `evaluateRuleGate`
  // reports it as `corpus_unavailable` so enforce fails closed and report records.
  const corpus = Array.isArray(agent?.ontologyRules) ? agent.ontologyRules : [];

  let declaration: RuleGateDeclaration;
  if (rawDeclaration == null) {
    // Ontology-only binding: the ontology said which rules govern this tool but
    // nothing declared where a verdict lives, so nothing can be discharged.
    // Report mode makes that gap visible without breaking a live agent.
    declaration = RuleGateDeclarationSchema.parse({
      rules: { ids: ontologyIds },
      verdict_from: ["results", "lastResult"],
    });
  } else {
    const parsed = RuleGateDeclarationSchema.safeParse(rawDeclaration);
    if (!parsed.success) {
      throw new Error(
        `rule_gate for tool '${toolName}' is malformed and cannot be enforced: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    declaration = parsed.data;
    if (hasOntologyBinding) {
      // The ontology's binding is authoritative and additive: a manifest may add
      // rules to a gate, never remove the ones the ontology attached.
      const ids = new Set([...(declaration.rules.ids ?? []), ...ontologyIds]);
      declaration = { ...declaration, rules: { ...declaration.rules, ids: [...ids] } };
    }
  }

  const verdict = firstVerdict(scope, declaration.verdict_from);
  const humanBoundary = declaration.human_boundary_from
    ? firstDefined(scope, declaration.human_boundary_from)
    : undefined;

  const decision = evaluateRuleGate({
    declaration,
    corpus,
    context: {
      client: declaration.scope?.client_from
        ? resolveBusinessKey(declaration.scope.client_from, scope)
        : undefined,
      department: declaration.scope?.department_from
        ? resolveBusinessKey(declaration.scope.department_from, scope)
        : undefined,
    },
    verdict,
    humanBoundary,
  });

  const bindingSource: ToolCallRuleGateRecord["bindingSource"] =
    rawDeclaration == null ? "ontology" : hasOntologyBinding ? "both" : "manifest";

  return {
    decision,
    record: {
      mode: decision.mode,
      allowed: decision.allowed,
      wouldRefuse: decision.wouldRefuse,
      applicable: decision.applicable,
      refusals: decision.refusals,
      warnings: decision.warnings,
      scopeAxes: decision.scopeAxes,
      ...(decision.verdictSource ? { verdictSource: decision.verdictSource } : {}),
      bindingSource,
    },
  };
}

/**
 * #DISPATCH-VERIFY — freshness window for a tool's live probe. Unset means no
 * expiry is enforced, matching `evaluateProbeVerification`'s refusal to invent
 * a policy. The cassette attestation layer uses a 7-day default, so an operator
 * who wants the same window here sets it explicitly.
 */
function probeFreshnessWindowMs(): number | undefined {
  const raw = process.env.AGENTIC_TOOL_PROBE_TTL_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** The riskier of the two declared effect axes. `operation` and `side_effect`
 * are separate vocabularies and either may be the one that says "this reaches
 * out or mutates"; taking only the first defined value can silently drop the
 * other. */
function mostOutboundEffect(
  operation: string | undefined,
  declaredSideEffect: string | undefined,
): string | undefined {
  const RISKY = new Set(["write", "dual", "call", "read_write"]);
  if (operation && RISKY.has(operation)) return operation;
  if (declaredSideEffect && RISKY.has(declaredSideEffect)) return declaredSideEffect;
  return operation ?? declaredSideEffect;
}

/**
 * #DISPATCH-VERIFY — evaluate the probe standing of one tool about to run.
 * Returns null when the tool needs no probe, so callers can distinguish
 * "checked, nothing required" from "never checked".
 */
function verifyToolProbeAtDispatch(args: {
  agent: AgentSlots | undefined;
  toolName: string;
  policy: ToolExecutionPolicy | undefined;
  declaredSideEffect: string | undefined;
  currentDefinitionHash?: string;
}): ProbeVerificationResult | null {
  const result = evaluateProbeVerification({
    toolName: args.toolName,
    // OR the two axes rather than `??`-ing them: a reviewed `operation` of
    // "read" must not erase a manifest `side_effect` of "write"/"call". The
    // riskier of the two declarations wins.
    sideEffect: mostOutboundEffect(args.policy?.operation, args.declaredSideEffect),
    effectScope: args.policy?.effectScope,
    probe: args.agent?.factoryToolProbeState?.[args.toolName],
    // NOT sourced from the probe state: comparing that hash against itself is
    // tautological and made `probe_definition_drift` unreachable. Drift detection
    // needs an INDEPENDENT hash of the definition being dispatched, which the
    // runtime does not have today (bootstrap rebuilds the descriptor from the same
    // row). Left unset rather than faked — a check that cannot fire must not look
    // like one that passed.
    currentDefinitionHash: args.currentDefinitionHash,
    nowMs: Date.now(),
    ttlMs: probeFreshnessWindowMs(),
  });
  return result.requiresProbe ? result : null;
}

/**
 * #EFFECT-READBACK (D6) — is this call one that CLAIMS an external effect?
 *
 * Derived from the same two declared axes the probe gate uses, via the same
 * `mostOutboundEffect` helper, so the two gates cannot disagree about what a
 * tool does. `call` is deliberately excluded: an outbound read-only API call
 * claims no state to read back, and minting an unverifiable receipt for it
 * would drown the real writes in noise.
 *
 * An UNDECLARED tool is not write-capable here. That is not a fail-open: an
 * undeclared tool already cannot pass `reviewedExecutionPolicy` for sandbox
 * dispatch, and the run-level reconciliation separately reports declared write
 * tools that produced no recorded write.
 */
export function toolClaimsEffect(
  policy: ToolExecutionPolicy | undefined,
  declaredSideEffect: string | undefined,
): boolean {
  const effect = mostOutboundEffect(policy?.operation, declaredSideEffect);
  return effect === "write" || effect === "dual" || effect === "read_write";
}

/** Everything the read-back needs that only the dispatch site knows. */
interface EffectReadbackDispatch {
  toolName: string;
  entry: ToolUseEntry | undefined;
  useGlobalMetadata: boolean;
  input: unknown;
  output: unknown;
  /** Allow-list membership + handler resolution for the DECLARED read tool.
   * Supplied by the caller because the two dispatch sites resolve handlers
   * differently, and a read-back must reuse each site's own resolution rather
   * than inventing a third one. */
  resolveReadTool: (name: string) => {
    allowed: boolean;
    handler?: ToolDescriptor;
    /** The sandbox decision the read tool would receive. Anything other than
     * `live` means the read-back could not observe anything real. */
    decision: string;
    /** #RULE-GATE — false when an ontology rule gate governs the read tool and
     * would refuse it. A read-back must not perform a call the ordinary
     * dispatch path would have blocked; verification cannot be a side door. */
    gateAllowed: boolean;
  };
  makeContext: (name: string, args: Record<string, unknown>) => ToolContext;
}

/**
 * Run the declared read-back for one completed write and return its verdict.
 *
 * Never throws: a read-back that fails is unverified evidence, and turning it
 * into a step failure would convert a reporting mechanism into a new outage
 * mode. Every early return names its reason.
 */
async function verifyClaimedEffect(
  dispatch: EffectReadbackDispatch,
): Promise<EffectVerificationReceipt> {
  const resolution = resolveEffectVerificationContract({
    manifest: dispatch.entry?.effect_verification,
    catalog: dispatch.useGlobalMetadata
      ? globalToolEffectVerification(dispatch.toolName)
      : undefined,
  });
  if (!resolution.ok) {
    return unverifiedEffect(resolution.reason, {
      ...(resolution.detail ? { detail: resolution.detail } : {}),
    });
  }
  const { contract, source } = resolution.resolved;
  const base = { source, readTool: contract.readTool } as const;

  const readTool = dispatch.resolveReadTool(contract.readTool);
  if (!readTool.allowed) {
    return unverifiedEffect("read_tool_not_allowed", {
      ...base,
      detail: `read-back tool '${contract.readTool}' is not in this agent's tool_use allow-list`,
    });
  }
  if (!readTool.handler) {
    return unverifiedEffect("read_tool_unresolved", {
      ...base,
      detail: `read-back tool '${contract.readTool}' resolved to no handler`,
    });
  }
  if (!readTool.gateAllowed) {
    return unverifiedEffect("read_tool_gate_refused", {
      ...base,
      detail: `an ontology rule gate refuses '${contract.readTool}'; verification must not perform a call the dispatch path would block`,
    });
  }
  if (readTool.decision !== "live") {
    return unverifiedEffect("readback_not_real", {
      ...base,
      detail: `read-back would have been dispatched as '${readTool.decision}'; a simulated observation is not evidence`,
    });
  }

  const args = resolveReadbackArgs(contract, {
    input: dispatch.input,
    output: dispatch.output,
  });
  if (!args.ok) {
    return unverifiedEffect("readback_args_unresolved", {
      ...base,
      detail: `read-back arguments could not be resolved from the write call: ${args.missing.join(", ")}`,
    });
  }

  let observed: unknown;
  try {
    const result = await readTool.handler.handler(
      dispatch.makeContext(contract.readTool, args.args),
    );
    observed = result.data;
  } catch (error) {
    return unverifiedEffect("readback_failed", {
      ...base,
      detail: `read-back tool '${contract.readTool}' threw: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const comparison = compareEffectReadback(contract, {
    claim: dispatch.output,
    observed,
  });
  return {
    status: comparison.agreed ? "verified" : "disagreed",
    ...base,
    checks: comparison.checks,
  };
}

/**
 * #RULE-GATE at the ACTION boundary.
 *
 * Same obligation logic as the tool gate, keyed on the ACTION name. Returns null
 * when nothing governs this action, so an unguarded action is untouched.
 */
function evaluateActionRuleGate(args: {
  agent: AgentSlots | undefined;
  actionName: string;
  scope: StepScope;
}): { decision: RuleGateDecision; record: ToolCallRuleGateRecord } | null {
  const { agent, actionName, scope } = args;
  const raw = agent?.action_rule_gate;
  const boundIds = agent?.ontologyRuleBindings?.[actionName] ?? [];
  if (raw == null || boundIds.length === 0) return null;

  const corpus = Array.isArray(agent?.ontologyRules) ? agent.ontologyRules : [];
  const parsed = RuleGateDeclarationSchema.safeParse({
    ...(raw as Record<string, unknown>),
    // Selection is server-authored: the manifest may say WHERE the verdict lives
    // and how strict to be, never which rules govern the action.
    rules: { ids: boundIds },
  });
  if (!parsed.success) {
    throw new Error(
      `action_rule_gate for action '${actionName}' is malformed and cannot be enforced: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const declaration = parsed.data;
  const decision = evaluateRuleGate({
    declaration,
    corpus,
    context: {
      client: declaration.scope?.client_from
        ? resolveBusinessKey(declaration.scope.client_from, scope)
        : undefined,
      department: declaration.scope?.department_from
        ? resolveBusinessKey(declaration.scope.department_from, scope)
        : undefined,
    },
    verdict: firstVerdict(scope, declaration.verdict_from),
    humanBoundary: declaration.human_boundary_from
      ? firstDefined(scope, declaration.human_boundary_from)
      : undefined,
  });
  return {
    decision,
    record: {
      mode: decision.mode,
      allowed: decision.allowed,
      wouldRefuse: decision.wouldRefuse,
      applicable: decision.applicable,
      refusals: decision.refusals,
      warnings: decision.warnings,
      scopeAxes: decision.scopeAxes,
      ...(decision.verdictSource ? { verdictSource: decision.verdictSource } : {}),
      bindingSource: "ontology",
    },
  };
}

/** First declared path whose value normalizes to a real verdict./** First declared path whose value normalizes to a real verdict. Falling back
 * through the list means a stale unrelated object cannot be mistaken for one. */
function firstVerdict(scope: StepScope, paths: readonly string[]): unknown {
  for (const path of paths) {
    const candidate = readScopeValue(scope, path);
    if (normalizeRuleVerdict(candidate)) return candidate;
  }
  return undefined;
}

function firstDefined(scope: StepScope, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = readScopeValue(scope, path);
    if (value != null) return value;
  }
  return undefined;
}

/** Mirrors `resolveBusinessKey`'s convention: a bare key may name a field on
 * the trigger event's data, a dotted path addresses the whole step scope. */
function readScopeValue(scope: StepScope, path: string): unknown {
  const direct = readPath(scope, path);
  if (direct !== undefined) return direct;
  return readPath(scope.event?.data, path);
}

function stringifyToolPayload(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch (error) {
    throw new TypeError(
      `tool output is not JSON-serializable: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
  }
}

// #ACI (P1-8, SWE-agent arXiv 2405.15793) — tool-output windowing + history folding.
// Measured on SWE-bench: capped observation windows beat both "too little" (-3.7pp) and "full
// output" (-5.3pp); collapsing all but the last 5 observations to one line beats full history
// by +3.0pp; an EXPLICIT "ran successfully, no output" receipt prevents the model misreading
// silence as failure. Ported to the payload sizes of our JSON tool results (char-based window).
const TOOL_OUTPUT_WINDOW = Math.max(
  2000,
  Number(process.env.AGENTIC_TOOL_OUTPUT_WINDOW) || 8000,
);
const TOOL_HISTORY_KEEP = Math.max(
  1,
  Number(process.env.AGENTIC_TOOL_HISTORY_KEEP) || 5,
);
const FOLD_MARK = "…[已折叠的早期工具输出 — 只保留首行]";

/** Cap one tool output at the window: keep head + tail with an explicit truncation marker
 *  (the marker names the elided size, so the model KNOWS it is looking at a window). */
export function windowToolOutput(
  body: string,
  window = TOOL_OUTPUT_WINDOW,
): string {
  if (body.length <= window) return body;
  const head = Math.floor(window * 0.7);
  const tail = Math.max(0, window - head);
  return `${body.slice(0, head)}\n…[输出截断：省略 ${body.length - window} 字符——需要更多请用更具体的参数重新调用]…\n${body.slice(body.length - tail)}`;
}

/** Fold tool_result blocks OLDER than the last `keep` tool rounds down to their first line.
 *  Idempotent (folded blocks start with FOLD_MARK). Mutates in place — messages are loop-local. */
export function foldOldToolResults(
  messages: Array<{ role: string; content: unknown }>,
  keep = TOOL_HISTORY_KEEP,
): void {
  const toolIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++)
    if (messages[i]!.role === "tool") toolIdxs.push(i);
  const foldUpto = toolIdxs.length - keep;
  for (let k = 0; k < foldUpto; k++) {
    const m = messages[toolIdxs[k]!]!;
    if (!Array.isArray(m.content)) continue;
    for (const blk of m.content as Array<{
      type?: string;
      content?: unknown;
    }>) {
      if (blk?.type !== "tool_result" || typeof blk.content !== "string")
        continue;
      if (blk.content.startsWith(FOLD_MARK) || blk.content.length <= 160)
        continue;
      blk.content = `${FOLD_MARK} ${blk.content.slice(0, 140).split("\n")[0]}…`;
    }
  }
}

async function runTenantPrompt(
  ctx: ToolContext,
  prompt: PromptDescriptor,
  action: ActionSpec,
  agent?: AgentSlots,
  tenantRegistry?: TenantRegistry,
  execution?: {
    trace?: RuntimeTraceSink;
    runId?: string;
    stepId?: string;
    /** Only the terminal action validates against agent-level outputs (v2). */
    validateOutput?: boolean;
    conversationHistory?: AgentConversationTurn[];
    usageAttribution?: UsageAttribution;
  },
): Promise<StepOutput> {
  const rendered = prompt.template(ctx);
  const trace = execution?.trace;
  const runId = execution?.runId;
  const stepId = execution?.stepId;
  const validateOutput = execution?.validateOutput ?? true;
  const usageAttribution = execution?.usageAttribution;
  // Agent Studio v2 — compile separate system/user messages from the
  // authored ports + prompt template; validation of named inputs happened
  // upstream. Legacy agents keep the historical single rendered user turn.
  let usesV2Execution = false;
  try {
    usesV2Execution =
      agent !== undefined &&
      normalizeAgentForExecution(agent).compatibilityMode === "v2";
  } catch {
    usesV2Execution = false;
  }
  let messages: ChatMessage[] | undefined;
  if (usesV2Execution) {
    try {
      const rawEventName = ctx.event?.name ?? "unknown";
      const tenantPrefix = ctx.tenantSlug ? `${ctx.tenantSlug}/` : "";
      const eventName =
        tenantPrefix && rawEventName.startsWith(tenantPrefix)
          ? rawEventName.slice(tenantPrefix.length)
          : rawEventName;
      const authoredActionObjective =
        typeof action.action_prompt === "string" && action.action_prompt.trim()
          ? action.action_prompt.trim()
          : action.description?.trim() || action.name;
      const eventData = (ctx.event?.data ?? {}) as Record<string, unknown>;
      const suppliedInputs = isPlainSchema(eventData.inputs)
        ? { ...eventData.inputs }
        : undefined;
      const promptPorts = normalizeAgentForExecution(
        agent,
      ).definition.inputs.filter((input) => input.kind === "prompt");
      const promptPort = promptPorts.length === 1 ? promptPorts[0] : undefined;
      if (
        suppliedInputs &&
        promptPort &&
        !Object.hasOwn(suppliedInputs, promptPort.id) &&
        typeof eventData.prompt === "string"
      ) {
        suppliedInputs[promptPort.id] = eventData.prompt;
      }
      const prepared = await prepareAgentExecution({
        definition: agent,
        // Register and Studio both inject their already-validated input set
        // under event.data.inputs. Prefer it here so per-action input_mapping
        // is not discarded by re-applying the original trigger bindings.
        ...(suppliedInputs ? { inputs: suppliedInputs } : {}),
        event: {
          name: eventName,
          data: eventData,
          subject: ctx.subject ?? null,
        },
        promptOptions: {
          tenantInstructions: prompt.system,
          actionObjective: authoredActionObjective,
          includeOutputContract: validateOutput,
          // PromptDescriptor templates historically formed the user turn.
          // Keep their dynamic context in that same trust tier while the
          // Studio-owned `inputs.prompt` remains the immutable first block.
          actionContext: rendered,
          run: {
            subject: ctx.subject ?? null,
            correlationId: ctx.correlationId,
          },
          conversationHistory: execution?.conversationHistory,
        },
        trace,
        runId,
        stepId,
      });
      messages = prepared.prompts?.messages;
      if (!messages) {
        throw new AgentInputValidationError([
          {
            path: "/actor",
            code: "llm_prompt_unavailable",
            severity: "error",
            message: "logic actions require an LLM prompt message pair",
          },
        ]);
      }
      const currentUserMessage = messages[messages.length - 1];
      if (runId) {
        const persistRendered =
          agent?.observability?.persist_rendered_prompts === true;
        await emitTraceBestEffort(trace, {
          runId,
          ...(stepId ? { stepId } : {}),
          kind: "prompt",
          level: persistRendered ? "debug" : "standard",
          name: "prompt.compiled",
          status: "ok",
          summary: "Compiled separate system and user messages",
          data: persistRendered
            ? { messages }
            : {
                roles: messages.map((message) => message.role),
                systemBytes:
                  typeof messages[0]?.content === "string"
                    ? Buffer.byteLength(messages[0].content)
                    : 0,
                userBytes:
                  typeof currentUserMessage?.content === "string"
                    ? Buffer.byteLength(currentUserMessage.content)
                    : 0,
              },
          visibility: persistRendered ? "debug" : "operator",
        });
      }
    } catch (error) {
      if (error instanceof AgentInputValidationError) {
        return {
          ok: false,
          type: "logic",
          data: null,
          meta: {
            error: error.code,
            validationIssues: error.issues,
          },
        };
      }
      throw error;
    }
  }
  const result = await callLLM(
    rendered,
    action.model ?? prompt.model ?? agent?.model,
    prompt.system,
    agent,
    tenantRegistry,
    ctx,
    action,
    usesV2Execution ? true : !!prompt.output,
    {
      messages,
      trace,
      runId,
      stepId,
      usageAttribution,
    },
  );
  const sandboxDispatches = result.toolCalls.flatMap((call) =>
    call.sandboxDispatch ? [call.sandboxDispatch] : [],
  );
  if (result.terminalError) {
    return {
      ok: false,
      type: "logic",
      data: null,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.model,
      provider: result.provider,
      meta: {
        error: "llm_incomplete",
        message: result.terminalError,
        prompt: prompt.name,
        provider: result.provider,
        model: result.model,
        tenant: true,
        toolCalls: result.toolCalls,
        sandboxDispatches,
        turns: result.turns,
      },
    };
  }
  let validated: unknown = result.text;
  let repairTokensIn = 0;
  let repairTokensOut = 0;
  let validationMeta: Record<string, unknown> | undefined;
  if (usesV2Execution && validateOutput) {
    // v2 strict structured output: parse, locally validate against the
    // compiled output-port schema, and (bounded) LLM-repair on failure.
    try {
      const structured = await parseValidateAndRepairOutput({
        definition: agent,
        candidate: result.text,
        trace,
        runId,
        stepId,
        repair: async ({
          invalidResponse,
          issues,
          schema,
          attempt,
          maxAttempts,
        }) => {
          const gateway = getRuntimeGateway();
          if (!gateway) {
            throw new Error("LLMGateway not initialised for output repair");
          }
          const repairStartedAt = new Date();
          const repairRequest: ChatRequest = {
            messages: [
              {
                role: "system",
                content:
                  "Correct the supplied invalid response into one JSON value that satisfies the declared schema. Return JSON only; do not add facts or explanation.",
              },
              {
                role: "user",
                content: [
                  "Validation errors:",
                  canonicalJson(issues),
                  "Declared schema:",
                  canonicalJson(schema),
                  "Invalid response:",
                  invalidResponse,
                ].join("\n\n"),
              },
            ],
            model: action.model ?? prompt.model ?? agent?.model,
            provider: agent?.provider,
            reasoning: agent?.reasoning,
            verbosity: agent?.verbosity,
            store: agent?.store,
            temperature: agent?.temperature,
            maxTokens: agent?.max_tokens,
            timeoutMs:
              typeof agent?.timeout_s === "number"
                ? agent.timeout_s * 1_000
                : undefined,
            jsonMode: true,
            tenantId: ctx.tenantId ?? agent?.tenantId,
            runId,
            stepId,
            purpose: "manifest.output-repair",
            tenantSlug: ctx.tenantSlug,
            routing: { taskType: "output.repair" },
            attribution: usageAttribution,
          };
          const response = usageAttribution
            ? await runWithUsageAttribution(usageAttribution, () =>
                gateway.chat(repairRequest),
              )
            : await gateway.chat(repairRequest);
          repairTokensIn += response.tokensIn ?? 0;
          repairTokensOut += response.tokensOut ?? 0;
          if (runId) {
            const repairEndedAt = new Date();
            await emitTraceBestEffort(trace, {
              runId,
              ...(stepId ? { stepId } : {}),
              kind: "llm",
              level: "standard",
              name: "llm.output_repair",
              status: "ok",
              startedAt: repairStartedAt,
              endedAt: repairEndedAt,
              durationMs: Math.max(
                0,
                repairEndedAt.getTime() - repairStartedAt.getTime(),
              ),
              summary: `Completed output repair turn ${attempt} of ${maxAttempts}`,
              data: {
                attempt,
                maxAttempts,
                provider: response.provider,
                model: response.model,
                tokensIn: response.tokensIn ?? 0,
                tokensOut: response.tokensOut ?? 0,
              },
              visibility: "operator",
            });
          }
          return response.text;
        },
      });
      validated = structured.value;
      validationMeta = {
        outputValid: structured.valid,
        repaired: structured.repaired,
        repairAttempts: structured.repairAttempts,
        validationIssues: structured.issues,
        rawResponse: structured.rawResponse,
      };
    } catch (error) {
      if (error instanceof OutputSchemaValidationError) {
        return {
          ok: false,
          type: "logic",
          data: null,
          tokensIn: result.tokensIn + repairTokensIn,
          tokensOut: result.tokensOut + repairTokensOut,
          model: result.model,
          provider: result.provider,
          meta: {
            error: error.code,
            validationIssues: error.issues,
            repairAttempts: error.attempts,
            rawResponse: error.invalidResponse,
            prompt: prompt.name,
            toolCalls: result.toolCalls,
            sandboxDispatches,
            turns: result.turns,
          },
        };
      }
      throw error;
    }
  } else if (usesV2Execution) {
    // Intermediate logic results and results with an explicit output mapping
    // still need to be usable as structured mapping input. Final aggregate
    // validation happens after `applyActionOutputMapping` in the caller.
    try {
      validated = JSON.parse(result.text) as unknown;
    } catch {
      validated = result.text;
    }
    validationMeta = { rawResponse: result.text };
  } else if (agent?.generated === true && !prompt.output) {
    // Ontology-compiled generated agents (redesign 2026-08-19 §G1) publish
    // their logic result as the emitted-event payload and downstream steps
    // address into it (`emit_payload_from: results.<id>`, condition paths
    // like `input.gap_report.…`). Mirror the v2 behaviour: prefer structured
    // JSON when the model returned it, keep raw text otherwise. Legacy
    // (non-generated) v1 agents keep the historical raw-text result.
    try {
      validated = parseStructuredJson(result.text);
    } catch {
      validated = result.text;
    }
    validationMeta = { rawResponse: result.text };
  } else if (prompt.output) {
    try {
      const json = parseStructuredJson(result.text);
      const parsed = prompt.output.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          type: "logic",
          data: result.text,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          model: result.model,
          provider: result.provider,
          meta: {
            error: "prompt_output_schema_mismatch",
            schemaError: parsed.error.issues,
            prompt: prompt.name,
            provider: result.provider,
            model: result.model,
            toolCalls: result.toolCalls,
            sandboxDispatches,
            turns: result.turns,
          },
        };
      }
      validated = parsed.data;
    } catch (err) {
      return {
        ok: false,
        type: "logic",
        data: result.text,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        model: result.model,
        provider: result.provider,
        meta: {
          error: "prompt_output_invalid_json",
          message: err instanceof Error ? err.message : String(err),
          prompt: prompt.name,
          provider: result.provider,
          model: result.model,
          toolCalls: result.toolCalls,
          sandboxDispatches,
          turns: result.turns,
        },
      };
    }
  }
  return {
    ok: true,
    type: "logic",
    data: validated,
    tokensIn: result.tokensIn + repairTokensIn,
    tokensOut: result.tokensOut + repairTokensOut,
    model: result.model,
    provider: result.provider,
    meta: {
      prompt: prompt.name,
      provider: result.provider,
      model: result.model,
      tenant: true,
      // Surface the tool-use trace so the UI's IO/TRACE tabs can render
      // each tool call inline with the LLM turn that spawned it. Empty
      // array when the model didn't request any tools.
      toolCalls: result.toolCalls,
      sandboxDispatches,
      // #W0 — raw per-turn LLM capture (response text + reasoning + requested
      // tools). register.ts persists this to `llm_turns` when capture is on.
      turns: result.turns,
      // v2 structured-output receipts (outputValid / repairAttempts /
      // validationIssues / rawResponse); undefined for legacy prompts.
      ...validationMeta,
    },
  };
}

function invokePayload(
  action: ActionSpec,
  ctx: ToolContext,
): Record<string, unknown> {
  const a = action as ActionSpec & {
    invoke_input?: Record<string, unknown>;
    forward_last_result?: boolean;
    forward_results?: boolean;
  };
  return materializeInvokePayload({
    eventData: ctx.event?.data,
    invokeInput: a.invoke_input,
    forwardLastResult: a.forward_last_result,
    forwardResults: a.forward_results,
    lastResult: ctx.lastResult,
    results: ctx.results,
    subject: ctx.subject,
    correlationId: ctx.correlationId,
  });
}

function failureEmitIntent(
  resolution: ActionFailureResolution,
): EmitIntent | undefined {
  if (!resolution.emitEvent) return undefined;
  const fallback =
    resolution.defaultResult &&
    typeof resolution.defaultResult === "object" &&
    !Array.isArray(resolution.defaultResult)
      ? (resolution.defaultResult as Record<string, unknown>)
      : { error: resolution.facts };
  return {
    event: resolution.emitEvent,
    payload: { ...fallback, ...(resolution.emitPayload ?? {}) },
  };
}

function classifyNestedActionFailure(
  action: ActionSpec,
  failure: unknown,
): ActionFailureResolution {
  const inherited = (
    failure as {
      output?: { meta?: { failureResolution?: unknown } };
    } | null
  )?.output?.meta?.failureResolution;
  if (
    action.on_error === undefined &&
    inherited &&
    typeof inherited === "object" &&
    !Array.isArray(inherited)
  ) {
    return inherited as ActionFailureResolution;
  }
  return classifyActionFailure({
    policy: action.on_error as RuntimeOnErrorPolicy,
    failure,
    defaultResult: Object.prototype.hasOwnProperty.call(
      action,
      "default_result",
    )
      ? action.default_result
      : action.on_error === "soft"
        ? null
        : undefined,
  });
}

// ── v2 declarative per-action I/O mappings (Agent Studio) ───────────────────
// `input_mapping` reshapes the context an action sees; `output_mapping`
// reshapes what it returns. Values are restricted JSON paths ("$."-rooted),
// {constant}, {path} or {template} objects — never executable expressions.

function renderActionMappingTemplate(
  template: string,
  root: Record<string, unknown>,
): string {
  return template.replace(/{{([\s\S]*?)}}/g, (_token, raw: string) => {
    const expression = raw.trim();
    const asJson = expression.startsWith("json ");
    const dotted = (asJson ? expression.slice(5) : expression).trim();
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(dotted)
    ) {
      throw new TypeError(
        `unsupported action mapping expression '${expression}'`,
      );
    }
    const value = resolveRestrictedJsonPath(root, `$.${dotted}`);
    return asJson
      ? canonicalJson(value)
      : value == null
        ? ""
        : typeof value === "string"
          ? value
          : canonicalJson(value);
  });
}

function resolveActionMappingValue(
  value: unknown,
  root: Record<string, unknown>,
): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolveRestrictedJsonPath(root, value);
  }
  if (isPlainSchema(value)) {
    if (Object.hasOwn(value, "constant"))
      return structuredClone(value.constant);
    if (typeof value.path === "string") {
      return resolveRestrictedJsonPath(root, value.path);
    }
    if (typeof value.template === "string") {
      return renderActionMappingTemplate(value.template, root);
    }
  }
  return structuredClone(value);
}

function mapActionRecord(
  mapping: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TypeError(`forbidden action mapping key '${key}'`);
    }
    mapped[key] = resolveActionMappingValue(value, root);
  }
  return mapped;
}

function applyActionInputMapping(
  ctx: ToolContext,
  action: ActionSpec,
): ToolContext {
  const mapping = (action as { input_mapping?: unknown }).input_mapping;
  if (!isPlainSchema(mapping) || Object.keys(mapping).length === 0) return ctx;
  const eventData = ctx.event?.data ?? {};
  const nestedInputs = isPlainSchema(eventData.inputs) ? eventData.inputs : {};
  const mapped = mapActionRecord(mapping, {
    event: eventData,
    inputs: nestedInputs,
    lastResult: ctx.lastResult,
    run: { subject: ctx.subject, correlationId: ctx.correlationId },
  });
  return {
    ...ctx,
    event: {
      name: ctx.event?.name ?? `action:${action.name}`,
      data:
        action.type === "logic"
          ? { ...eventData, inputs: { ...nestedInputs, ...mapped } }
          : mapped,
    },
  };
}

function applyActionOutputMapping(
  result: StepOutput,
  action: ActionSpec,
  ctx: ToolContext,
): StepOutput {
  const mapping = (action as { output_mapping?: unknown }).output_mapping;
  if (!isPlainSchema(mapping) || Object.keys(mapping).length === 0)
    return result;
  const eventData = ctx.event?.data ?? {};
  const nestedInputs = isPlainSchema(eventData.inputs) ? eventData.inputs : {};
  const mapped = mapActionRecord(mapping, {
    result: result.data,
    lastResult: result.data,
    event: eventData,
    inputs: nestedInputs,
    run: { subject: ctx.subject, correlationId: ctx.correlationId },
  });
  // Branch/gate control fields are runtime state, not ordinary mapped output.
  // Preserve them even when an author maps additional condition fields so
  // register.ts cannot silently take the wrong branch.
  if (action.type === "condition" && isPlainSchema(result.data)) {
    for (const key of ["evaluated", "condition", "targetActionId"] as const) {
      if (Object.hasOwn(result.data, key)) mapped[key] = result.data[key];
    }
  }
  return {
    ...result,
    data: mapped,
    meta: { ...result.meta, outputMapped: true },
  };
}

async function runActionCore(input: StepInput): Promise<StepOutput> {
  const { ctx, action, tenantRegistry, agent, runId, stepOrd } = input;
  const traceRunId = runId ?? ctx.runId;
  const actionStartedAt = new Date();
  if (traceRunId) {
    await emitTraceBestEffort(input.trace, {
      runId: traceRunId,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      kind: "step",
      level: "standard",
      name: action.name,
      status: "running",
      startedAt: actionStartedAt,
      summary: action.description || `Executing ${action.type} action`,
      data: { type: action.type, ...(stepOrd ? { ord: stepOrd } : {}) },
      visibility: "user",
    });
  }

  // Optional ad-hoc artifact contract: persist input before any provider/tool
  // can run. The durable register.ts path writes its own richer input ref and
  // therefore leaves these arguments unset.
  if (runId && typeof stepOrd === "number") {
    await writeArtifact(runId, `step-${stepOrd}-input.json`, {
      action: action.name,
      type: action.type,
      ctx,
      agent: agent
        ? { name: agent.name, description: agent.description }
        : undefined,
    });
  }

  let result: StepOutput;
  let actionRuleGateRecord: ToolCallRuleGateRecord | undefined;
  /**
   * #RUN-EVIDENCE (D6) — a direct `type:"tool"` action dispatches a real tool
   * without an LLM loop, so it never populated `meta.toolCalls` and therefore
   * never reached the per-call evidence writer in register.ts. A run whose only
   * external write went through this path produced a ledger of zero calls,
   * which would make the run-level reconciliation understate the truth. The
   * facts are collected here and projected into one `ToolCallTrace` after the
   * switch, so every `break` path — refusal, gate, unresolved tool, live call —
   * lands in the same record the LLM loop already produces.
   */
  let directToolDispatch:
    | {
        tool: string;
        input: unknown;
        startedAtMs: number;
        decision?: string;
        /** Whether this tool CLAIMS an external effect, per its reviewed
         * policy / declared side-effect. Drives whether a read-back receipt is
         * required at all. */
        writeCapable?: boolean;
        /** The tool's own return value, boxed so `undefined` stays
         * distinguishable from "never captured". */
        rawOutput?: { value: unknown };
        probe?: ProbeVerificationResult;
        effectVerification?: EffectVerificationReceipt;
      }
    | undefined;
  try {
    switch (action.type) {
      case "decision": {
        if (!action.decision_table) {
          result = {
            ok: false,
            type: "decision",
            data: { __error: "decision_table_missing" },
            meta: { error: "decision_table_missing" },
          };
          break;
        }
        const decision = evaluateDecisionTable(action.decision_table, {
          input: ctx.event?.data ?? {},
          event: ctx.event ?? {},
          lastResult: ctx.lastResult,
          results: ctx.results ?? {},
        });
        result = {
          ok: true,
          type: "decision",
          data: {
            ...(decision.payload ?? {}),
            outcome: decision.outcome,
            decision_table: decision.tableId,
            decision_row: decision.rowId,
            ...(decision.emitEvent ? { _emit: decision.emitEvent } : {}),
          },
          meta: {
            decisionTable: decision.tableId,
            decisionRow: decision.rowId,
            matched: decision.matched,
          },
        };
        break;
      }
      case "tool": {
        // v2 (Agent Studio) actions may carry an explicit `tool` identifier
        // distinct from the action name; legacy manifests keep name === tool.
        const toolName =
          typeof action.tool === "string" && action.tool.length > 0
            ? action.tool
            : action.name;
        directToolDispatch = {
          tool: toolName,
          input: ctx.event?.data ?? null,
          startedAtMs: Date.now(),
        };
        let isV2ToolAgent = false;
        try {
          isV2ToolAgent =
            agent !== undefined &&
            normalizeAgentForExecution(agent).compatibilityMode === "v2";
        } catch {
          isV2ToolAgent = false;
        }
        const boundary = resolveActionToolBoundary(action, agent);
        if (
          boundary.explicit &&
          (boundary.actionAllowed.length !== 1 ||
            boundary.actionAllowed[0] !== action.name ||
            !boundary.effective.includes(action.name))
        ) {
          result = {
            ok: false,
            type: "tool",
            data: {
              __error: "action_tool_not_allowed",
              tool: action.name,
              message: `工具 Action「${action.name}」只能调用自身，且该工具必须同时存在于 agent.tool_use。`,
            },
            meta: {
              error: "action_tool_not_allowed",
              tool: action.name,
              actionAllowedTools: boundary.actionAllowed,
              agentAllowedTools: boundary.agentAllowed,
            },
          };
          break;
        }
        const dataflowAction = action as ActionSpec & {
          tool_arguments?: Record<
            string,
            { from: string; required?: boolean } | { const: unknown }
          >;
        };
        const materializedArguments = dataflowAction.tool_arguments
          ? materializeToolArguments(dataflowAction.tool_arguments, {
              event: ctx.event,
              input: ctx.event?.data,
              lastResult: ctx.lastResult,
              results: ctx.results,
              locals: ctx.locals,
            })
          : null;
        if (materializedArguments && !materializedArguments.ok) {
          result = {
            ok: false,
            type: "tool",
            data: null,
            meta: {
              error: "tool_arguments_unresolved",
              detail: materializedArguments.error,
              argument: materializedArguments.argument,
              path: materializedArguments.path,
              tool: toolName,
              argumentMode: "explicit",
            },
          };
          break;
        }
        const invocationCtx: ToolContext = materializedArguments?.ok
          ? {
              ...ctx,
              event: {
                name: ctx.event?.name ?? "generated-plan.tool",
                data: materializedArguments.args,
              },
              // An explicit mapping is also a capability/data-minimisation
              // boundary. The handler receives the selected arguments, not a
              // second implicit route to the entire preceding carry.
              lastResult: undefined,
              results: undefined,
              locals: undefined,
            }
          : ctx;
        // Record the arguments the handler will actually receive, not the raw
        // trigger payload: an explicit `tool_arguments` mapping is the real
        // dispatched input and is what a read-back must be built from.
        directToolDispatch.input = invocationCtx.event?.data ?? null;
        // Resolve the handler and its reviewed side-effect metadata before the
        // sandbox boundary. Policy is based on metadata, never on the tool name.
        const tenantTool = tenantRegistry?.tools?.[toolName];
        const globalTool = !tenantTool
          ? globalToolRegistry.get(toolName)
          : undefined;
        const toolUseEntry = agent?.tool_use?.find(
          (entry) => entry.name === toolName,
        );
        // v2 contract: `tool_use[]` is the execution trust boundary for direct
        // actions just as it is for model-requested calls. A registered tool is
        // never implicitly callable merely because an action knows its name.
        if (isV2ToolAgent && !toolUseEntry) {
          result = {
            ok: false,
            type: "tool",
            data: null,
            meta: {
              error: "tool_not_allowed",
              tool: toolName,
              message: `Tool '${toolName}' is not present in this agent's tool_use allow-list`,
            },
          };
          break;
        }
        // v2 contract: a declared input schema is enforced on the exact
        // dispatched arguments before the handler runs.
        if (isV2ToolAgent && isPlainSchema(toolUseEntry?.input_schema)) {
          const schemaIssues = validateValueAgainstJsonSchema(
            toolUseEntry.input_schema,
            (invocationCtx.event?.data ?? {}) as Record<string, unknown>,
            "/tool/input",
            "tool_input_schema",
          );
          if (schemaIssues.length > 0) {
            result = {
              ok: false,
              type: "tool",
              data: null,
              meta: {
                error: "tool_input_schema_invalid",
                tool: toolName,
                validationIssues: schemaIssues,
              },
            };
            break;
          }
        }
        // Generated plans share the exact same immutable capability boundary as
        // CodeAct and the LLM tool loop. Hand-written agents retain their
        // historical tenant/global resolution behaviour.
        if (
          agent?.generated &&
          !(agent.tool_use ?? []).some((entry) => entry.name === toolName)
        ) {
          result = {
            ok: false,
            type: "tool",
            data: {
              __error: "generated_tool_not_declared",
              tool: toolName,
              message: `生成 Agent「${agent.name ?? ctx.agentName}」的计划请求了未在不可变 agent.tool_use 中声明的工具「${toolName}」；已拒绝执行。`,
            },
            meta: {
              error: "generated_tool_not_declared",
              tool: toolName,
              declaredTools: (agent.tool_use ?? []).map((entry) => entry.name),
            },
          };
          break;
        }
        // #RULE-GATE — the same precondition the LLM tool-use loop enforces.
        // Without it, a plan could reach a guarded write by declaring it as a
        // direct `type:"tool"` action instead of letting the model request it.
        // #ARG-CONTRACT (D3) — the tool's own contract applies here too. Live
        // manifest agents are almost entirely `type:"tool"` actions, so a check
        // wired only into the LLM loop would miss the real production path.
        if (!isPlainSchema(toolUseEntry?.input_schema)) {
          const resolvedForArgs = tenantTool ?? globalTool;
          const argIssues = validateSuppliedArgTypes(
            isPlainSchema(resolvedForArgs?.inputSchema)
              ? resolvedForArgs.inputSchema
              : undefined,
            invocationCtx.event?.data,
          );
          if (argIssues.length > 0) {
            result = {
              ok: false,
              type: "tool",
              data: null,
              meta: {
                error: "tool_arguments_invalid",
                tool: toolName,
                validationIssues: argIssues,
              },
            };
            break;
          }
        }
        {
          // Deliberately the action-level `ctx`, not `invocationCtx`: an
          // explicit `tool_arguments` mapping nulls the carry for the handler as
          // a capability boundary, but the gate must still see the run's state.
          const gate = evaluateToolRuleGate({
            agent,
            toolName,
            scope: {
              event: ctx.event,
              subject: ctx.subject,
              lastResult: ctx.lastResult,
              results: ctx.results,
              locals: ctx.locals,
            },
          });
          if (gate) {
            actionRuleGateRecord = gate.record;
            if (!gate.decision.allowed) {
              result = {
                ok: false,
                type: "tool",
                data: null,
                meta: {
                  error: "rule_gate_refused",
                  tool: toolName,
                  message: gate.decision.steer,
                  ruleGate: gate.record,
                },
              };
              break;
            }
          }
        }
        const reviewedPolicy = reviewedExecutionPolicy(
          toolName,
          toolUseEntry,
          !!globalTool,
        );
        // #DISPATCH-VERIFY (D8) — probe standing applies to this path too.
        const actionProbe = verifyToolProbeAtDispatch({
          agent,
          toolName,
          policy: reviewedPolicy,
          declaredSideEffect: toolUseEntry?.side_effect,
        });
        if (actionProbe) directToolDispatch.probe = actionProbe;
        directToolDispatch.writeCapable = toolClaimsEffect(
          reviewedPolicy,
          toolUseEntry?.side_effect,
        );
        if (
          actionProbe &&
          !actionProbe.verified &&
          !actionProbe.deferrable &&
          probeVerificationPolicyFromEnv(process.env) === "refuse"
        ) {
          result = {
            ok: false,
            type: "tool",
            data: null,
            meta: {
              error: "probe_verification_failed",
              tool: toolName,
              probe: actionProbe,
            },
          };
          break;
        }
        const factoryDecision = factorySandboxDispatchDecision(
          reviewedPolicy,
          ctx.tenantSlug,
          agent?.factoryExecutionScope,
        );
        let sandboxLocalDispatch: FactorySandboxDispatchReceipt | undefined;
        // Ordinary production dispatch is `live`; the sandbox branch below
        // replaces this with the decision it actually took. Recorded either
        // way so the ledger never has to infer realness from silence.
        directToolDispatch.decision = factoryDecision ?? "live";
        // T3 — sandbox interception: in the isolated `-sb` tenant, a Phase-1 `type:"tool"` step calls
        // the real handler directly (no LLM in the loop), so without this it would hit RoboHire/etc.
        // for real. Tests may use mock/replay; production accepts gated/live only.
        if (isSandboxTenant(ctx.tenantSlug)) {
          // #W3-FAULT — an injected fault (from a kind:"fault" test case's __fault payload marker) beats
          // every dispatch mode: return a failing result so the step's onError policy is EXERCISED.
          const fault = injectedFault(ctx.event?.data, toolName);
          if (fault) {
            result = {
              ok: false,
              type: "tool",
              data: faultResult(toolName, fault.kind),
              meta: {
                tool: toolName,
                sandbox: true,
                injectedFault: fault.kind,
              },
            };
            break;
          }
          const mode =
            factoryDecision === null ? sandboxToolMode() : "evidence_replay";
          const decision =
            factoryDecision ??
            toolDispatchDecision(reviewedPolicy, sandboxToolMode(), {
              sandboxProfileVerified: hasVerifiedSandboxProfile(
                agent,
                toolName,
              ),
            });
          directToolDispatch.decision = decision;
          if (decision === "reject") {
            result = {
              ok: false,
              type: "tool",
              data: {
                __error: `tool '${toolName}' is missing valid reviewed execution_policy metadata`,
              },
              meta: {
                tool: toolName,
                sandbox: true,
                toolMode: mode,
                decision,
              },
            };
            break;
          }
          if (factoryDecision === "replay") {
            const scope = agent?.factoryExecutionScope;
            const args = (invocationCtx.event?.data ?? {}) as Record<
              string,
              unknown
            >;
            if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
              result = {
                ok: false,
                type: "tool",
                data: {
                  __error: `factory sandbox replay scope is missing for tool '${toolName}'`,
                },
                meta: {
                  tool: toolName,
                  sandbox: true,
                  toolMode: mode,
                  decision: "reject",
                },
              };
              break;
            }
            try {
              const replayed = await replayFactorySandboxTool({
                scope,
                tenantSlug: ctx.tenantSlug!,
                toolName: toolName,
                toolArgs: args,
                policy: reviewedPolicy,
                replayRef: agent.factoryToolReplayRefs?.[toolName],
              });
              result = {
                ok: true,
                type: "tool",
                data: replayed.body,
                meta: {
                  tool: toolName,
                  sandbox: true,
                  toolMode: mode,
                  decision: "replay",
                  replayed: true,
                  sandboxDispatches: [replayed.receipt],
                },
              };
            } catch (error) {
              result = {
                ok: false,
                type: "tool",
                data: { __error: String((error as Error)?.message ?? error) },
                meta: {
                  tool: toolName,
                  sandbox: true,
                  toolMode: mode,
                  decision: "replay",
                  replayed: false,
                },
              };
            }
            break;
          }
          if (factoryDecision === "live") {
            const scope = agent?.factoryExecutionScope;
            if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
              result = {
                ok: false,
                type: "tool",
                data: {
                  __error: `factory sandbox local scope is missing for tool '${toolName}'`,
                },
                meta: {
                  tool: toolName,
                  sandbox: true,
                  toolMode: mode,
                  decision: "reject",
                },
              };
              break;
            }
            sandboxLocalDispatch = await recordFactorySandboxLocalDispatch({
              scope,
              tenantSlug: ctx.tenantSlug!,
              toolName: toolName,
              toolArgs: invocationCtx.event?.data ?? {},
              policy: reviewedPolicy,
            });
          }
          if (decision !== "live") {
            const args = (invocationCtx.event?.data ?? {}) as Record<
              string,
              unknown
            >;
            const replayed =
              decision === "replay"
                ? await cassetteLookup(ctx.tenantSlug!, toolName, args)
                : undefined;
            if (decision === "replay" && replayed === undefined) {
              result = {
                ok: false,
                type: "tool",
                data: {
                  __error: `No replay cassette exists for tool '${toolName}'`,
                },
                meta: {
                  tool: toolName,
                  sandbox: true,
                  toolMode: mode,
                  decision,
                  replayed: false,
                },
              };
              break;
            }
            result = {
              ok: true,
              type: "tool",
              data:
                decision === "gate_profile"
                  ? gatedToolMarker(toolName, args, "sandbox_profile")
                  : decision === "gate_grant"
                    ? gatedToolMarker(toolName, args, "requires_attempt_grant")
                    : (replayed ?? sandboxToolStub(toolName)),
              meta: {
                tool: toolName,
                sandbox: true,
                toolMode: mode,
                decision,
                replayed: replayed !== undefined,
              },
            };
            break;
          }
        }
        // Same resolution chain as the LLM tool-use loop: tenant override
        // → global registry. An unresolved name fails closed; there is no
        // name-guessing or synthetic success path.
        if (tenantTool || globalTool) {
          // Look up matching tool_use[] entry by action name so per-tenant
          // config flows the same way it does in the LLM tool-use loop.
          // tenant-test1's writeWorkflowLog (a `type: "tool"` action with
          // no LLM loop) relies on this path to receive its subdir/filename
          // binding from the manifest.
          const toolConfig =
            toolUseEntry && typeof toolUseEntry === "object"
              ? ((toolUseEntry as { config?: Record<string, unknown> })
                  .config ?? undefined)
              : undefined;
          const enrichedCtx: ToolContext = toolConfig
            ? { ...invocationCtx, config: toolConfig }
            : invocationCtx;
          result = await runTenantTool(
            enrichedCtx,
            (tenantTool ?? globalTool)!,
          );
          // #EFFECT-READBACK (D6) — the direct tool path reaches real external
          // writes without any model in the loop, so it needs the same
          // confirmation the LLM loop now performs.
          if (directToolDispatch.writeCapable) {
            directToolDispatch.effectVerification = !result.ok
              ? unverifiedEffect("write_errored", {
                  detail: `tool '${toolName}' returned ok=false; there is no claimed effect to confirm`,
                })
              : directToolDispatch.decision !== undefined
                  && directToolDispatch.decision !== "live"
                ? unverifiedEffect("write_not_real", {
                    detail: `dispatch decision '${directToolDispatch.decision}' — nothing was written, so nothing can be read back`,
                  })
                : await verifyClaimedEffect({
                    toolName,
                    entry: toolUseEntry,
                    useGlobalMetadata: !!globalTool,
                    input: directToolDispatch.input,
                    output: result.data,
                    resolveReadTool: (name) => {
                      const tenantRead = tenantRegistry?.tools?.[name];
                      const globalRead = tenantRead
                        ? undefined
                        : globalToolRegistry.get(name);
                      const readEntry = agent?.tool_use?.find(
                        (entry) => entry.name === name,
                      );
                      // `tool_use[]` is the trust boundary on this path too:
                      // an action may only reach a tool the agent declared.
                      const allowed =
                        agent?.tool_use === undefined
                          ? true
                          : agent.tool_use.some((entry) => entry.name === name);
                      let decision = "live";
                      try {
                        const readPolicy = reviewedExecutionPolicy(
                          name,
                          readEntry,
                          !!globalRead,
                        );
                        const factoryRead = factorySandboxDispatchDecision(
                          readPolicy,
                          ctx.tenantSlug,
                          agent?.factoryExecutionScope,
                        );
                        decision =
                          factoryRead ??
                          (isSandboxTenant(ctx.tenantSlug)
                            ? toolDispatchDecision(readPolicy, sandboxToolMode(), {
                                sandboxProfileVerified:
                                  hasVerifiedSandboxProfile(agent, name),
                              })
                            : "live");
                      } catch {
                        decision = "reject";
                      }
                      let gateAllowed = true;
                      try {
                        const readGate = evaluateToolRuleGate({
                          agent,
                          toolName: name,
                          scope: {
                            event: ctx.event,
                            subject: ctx.subject,
                            lastResult: ctx.lastResult,
                            results: ctx.results,
                            locals: ctx.locals,
                          },
                        });
                        gateAllowed = readGate
                          ? readGate.decision.allowed
                          : true;
                      } catch {
                        gateAllowed = false;
                      }
                      return {
                        allowed,
                        ...(tenantRead ?? globalRead
                          ? { handler: (tenantRead ?? globalRead)! }
                          : {}),
                        decision,
                        gateAllowed,
                      };
                    },
                    makeContext: (name, args) => ({
                      ...invocationCtx,
                      actionName: name,
                      config: (
                        agent?.tool_use?.find((entry) => entry.name === name) as
                          | { config?: Record<string, unknown> }
                          | undefined
                      )?.config,
                      event: { name: `tool:${name}`, data: args },
                    }),
                  });
          }
          if (sandboxLocalDispatch) {
            result.meta = {
              ...result.meta,
              sandbox: true,
              toolMode: "evidence_replay",
              decision: "live",
              sandboxDispatches: [sandboxLocalDispatch],
            };
          }
        } else {
          result = {
            ok: false,
            type: "tool",
            data: {
              __error: `工具「${toolName}」未注册（tenant/global 都没有）——生产不使用假桩兜底。请为该动作绑定真实工具或补进工具库。`,
            },
            meta: {
              tool: toolName,
              unresolved: true,
              error: "tool_not_registered",
            },
          };
        }
        break;
      }
      case "logic": {
        // #RULE-GATE — obligations that govern this whole action, checked before
        // any model turn. Rules the ontology attached to a `logic` step are not
        // about one outbound call, so the tool boundary cannot speak for them.
        {
          const actionGate = evaluateActionRuleGate({
            agent,
            actionName: action.name,
            scope: {
              event: ctx.event,
              subject: ctx.subject,
              lastResult: ctx.lastResult,
              results: ctx.results,
              locals: ctx.locals,
            },
          });
          if (actionGate && !actionGate.decision.allowed) {
            result = {
              ok: false,
              type: "logic",
              data: null,
              meta: {
                error: "rule_gate_refused",
                action: action.name,
                message: actionGate.decision.steer,
                ruleGate: actionGate.record,
              },
            };
            break;
          }
        }
        const tenantPrompt = tenantRegistry?.prompts?.[action.name];
        // A codeExecuted claim is authoritative: execute the exact bytes in the
        // worker isolate or fail this step. There is no declarative/LLM fallback.
        // Sandbox tenants use their attempt-scoped gate. Production requires an
        // opaque capability minted from durable promotion evidence; manifest
        // allow/hash fields are descriptive and are never execution authority.
        if (agent?.generated && agent.codeExecuted) {
          if (!agent.typescriptCode) {
            const codeExecutionReceipt = makeCodeActExecutionReceipt({
              codeExecuted: false,
              codeRan: false,
              isolation: null,
              codeSha256: null,
              attestation: "not_checked",
              durationMs: 0,
              failure: "empty_code",
            });
            result = {
              ok: false,
              type: "logic",
              data: null,
              meta: {
                error: "generated_code_missing",
                codeExecuted: false,
                isolation: null,
                codeAttestation: "not_checked",
                codeExecutionReceipt,
              },
            };
            break;
          }

          const codeSha256 = createHash("sha256")
            .update(agent.typescriptCode, "utf8")
            .digest("hex");
          const sandboxCodeAct = isSandboxTenant(ctx.tenantSlug);
          const productionClaims =
            !sandboxCodeAct &&
            ctx.tenantId &&
            agent.id &&
            agent.factoryDomainId &&
            agent.factoryPromotionVersionId &&
            agent.factoryRegressionSuiteFingerprint &&
            agent.productionCodeActManifestSha256 &&
            agent.productionCodeActWorkflowManifestSha256
              ? await revalidateProductionCodeActCapability(
                  agent.productionCodeActCapability,
                  {
                    executionKind: "codeact",
                    tenantId: ctx.tenantId,
                    tenantSlug: ctx.tenantSlug,
                    domainId: agent.factoryDomainId,
                    agentSlug: agent.id,
                    promotionVersionId: agent.factoryPromotionVersionId,
                    regressionSuiteFingerprint:
                      agent.factoryRegressionSuiteFingerprint,
                    codeSha256,
                    agentManifestSha256: agent.productionCodeActManifestSha256,
                    workflowManifestSha256:
                      agent.productionCodeActWorkflowManifestSha256,
                  },
                )
              : null;
          if (!sandboxCodeAct && !productionClaims) {
            const codeExecutionReceipt = makeCodeActExecutionReceipt({
              codeExecuted: false,
              codeRan: false,
              isolation: null,
              codeSha256,
              attestation: "not_authorized",
              durationMs: 0,
              failure: "production_not_authorized",
            });
            result = {
              ok: false,
              type: "logic",
              data: null,
              meta: {
                // Preserve the historical top-level code for callers while the
                // structured receipt carries the precise durable denial.
                error: "generated_code_requires_sandbox",
                denialReason: "durable_production_authorization_missing",
                codeExecuted: false,
                isolation: null,
                codeSha256,
                codeAttestation: "not_authorized",
                tenantSlug: ctx.tenantSlug,
                codeExecutionReceipt,
              },
            };
            break;
          }

          const codeToolBoundary = resolveActionToolBoundary(action, agent);
          const declaredCodeTools = codeToolBoundary.effective;
          const declaredCodeToolSet = new Set(declaredCodeTools);
          const unresolvedCodeTools = declaredCodeTools.filter(
            (name) =>
              !tenantRegistry?.tools?.[name] && !globalToolRegistry.get(name),
          );
          if (unresolvedCodeTools.length) {
            const codeExecutionReceipt = makeCodeActExecutionReceipt({
              codeExecuted: false,
              codeRan: false,
              isolation: null,
              codeSha256: null,
              attestation: "not_checked",
              durationMs: 0,
              failure: "generated_tool_configuration_missing",
            });
            result = {
              ok: false,
              type: "logic",
              data: null,
              meta: {
                error: "generated_tool_configuration_missing",
                codeExecuted: false,
                missingTools: unresolvedCodeTools,
                message: `生成 Agent「${agent.name ?? ctx.agentName}」声明的工具尚未注册/配置：${unresolvedCodeTools.join("、")}；代码未启动。`,
                codeExecutionReceipt,
              },
            };
            break;
          }

          const configuredHost = input.generatedCodeHostRuntime;
          // #RULE-GATE — generated code is the THIRD way to reach a handler, and
          // the capability set alone answers only "may this agent ever call this
          // tool", never "may it call it right now". Extracted to a named seam
          // (same shape as `dispatchInvokeRpc`) so the gate here is unit-testable
          // rather than trusted.
          const productionTool = async (
            name: string,
            args?: unknown,
          ): Promise<unknown> =>
            dispatchGeneratedCodeTool({
              name,
              args,
              ctx,
              agent,
              declaredCodeToolSet,
              tenantRegistry,
              scope: {
                event: ctx.event,
                subject: ctx.subject,
                lastResult: ctx.lastResult,
                results: ctx.results,
                locals: ctx.locals,
              },
            });
          // The host binding resolves tenant/global handlers for both targets.
          // In a nonce Factory sandbox, runGeneratedCodeIsolated applies the
          // attempt replay gate before this binding is reachable: external tools
          // never call it, while pure/sandbox_local tools may execute locally.
          const hostRuntime: GeneratedCodeHostRuntime = {
            ...configuredHost,
            tool: configuredHost?.tool ?? productionTool,
          };

          const exec = await runGeneratedCodeIsolated(
            agent.typescriptCode,
            (ctx.event?.data ?? {}) as Record<string, unknown>,
            {
              systemPrompt: agent.ontology_instructions,
              tenantSlug: ctx.tenantSlug,
              tenantId: ctx.tenantId,
              agentName: agent.name ?? ctx.agentName,
              correlationId: ctx.correlationId,
              subject: ctx.subject,
              memory: input.memory,
              runId: input.runId,
              timeoutMs: input.resolvedTimeoutMs,
              production: {
                allowProduction: productionClaims !== null,
                expectedCodeSha256: productionClaims?.codeSha256,
                promotionVersionId: productionClaims?.promotionVersionId,
                regressionSuiteFingerprint:
                  productionClaims?.regressionSuiteFingerprint,
              },
              allowedTools: declaredCodeTools,
              toolPolicies: Object.fromEntries(
                (agent.tool_use ?? [])
                  .filter((entry) => declaredCodeToolSet.has(entry.name.trim()))
                  .flatMap((entry) => {
                    const policy = reviewedExecutionPolicy(
                      entry.name,
                      entry,
                      globalToolRegistry.has(entry.name),
                    );
                    return policy ? [[entry.name, policy] as const] : [];
                  }),
              ),
              sandboxProfileVerifiedTools: declaredCodeTools.filter((name) =>
                hasVerifiedSandboxProfile(agent, name),
              ),
              factoryExecutionScope: agent.factoryExecutionScope,
              factoryToolReplayRefs: agent.factoryToolReplayRefs,
              hostRuntime,
              containerTransport: input.generatedCodeContainerTransport,
              candidateImage: input.generatedCodeCandidateImage,
            },
          );
          if (exec.ok) {
            const codeExecutionReceipt = makeCodeActExecutionReceipt({
              codeExecuted: exec.executorStarted,
              codeRan: true,
              isolation: exec.executorStarted ? exec.isolation : null,
              codeSha256: exec.codeSha256,
              attestation: exec.attestation,
              durationMs: exec.durationMs,
              failure: null,
            });
            result = {
              ok: true,
              type: "logic",
              data: exec.data,
              meta: {
                codeExecuted: true,
                emitted: exec.emitted,
                isolation: exec.isolation,
                codeSha256: exec.codeSha256,
                codeAttestation: exec.attestation,
                codeDurationMs: exec.durationMs,
                productionAttested: exec.productionAttested,
                ...(exec.containerEvidence
                  ? { containerEvidence: exec.containerEvidence }
                  : {}),
                sandboxDispatches: exec.toolDispatches.flatMap((dispatch) =>
                  dispatch.receipt ? [dispatch.receipt] : [],
                ),
                // #RUN-EVIDENCE (D6) — the host-side classification of every
                // tool the generated code dispatched. `sandboxDispatches` only
                // carries factory RECEIPTS, so a production live dispatch left
                // no trace at all and the run-level ledger could not tell
                // "generated code called nothing" from "generated code called
                // things we never recorded". This list closes exactly that
                // ambiguity; it is not a substitute for a per-call record.
                codeToolDispatches: exec.toolDispatches.map((dispatch) => ({
                  tool: dispatch.tool,
                  kind: dispatch.kind,
                })),
                codeExecutionReceipt,
              },
            };
          } else {
            const productionPolicyDenied =
              exec.failure === "production_not_authorized" ||
              exec.failure === "attestation_missing";
            const codeExecutionReceipt = makeCodeActExecutionReceipt({
              codeExecuted: exec.executorStarted,
              codeRan: false,
              isolation: exec.executorStarted ? exec.isolation : null,
              codeSha256: exec.codeSha256,
              attestation: exec.attestation,
              durationMs: exec.durationMs,
              failure: exec.failure,
            });
            result = {
              ok: false,
              type: "logic",
              data: null,
              meta: {
                // Keep the historical top-level code for an unattested legacy
                // manifest while exposing the precise structured failure below.
                error: productionPolicyDenied
                  ? "generated_code_requires_sandbox"
                  : exec.failure === "attestation_mismatch"
                    ? "generated_code_attestation_failed"
                    : "generated_code_execution_failed",
                codeExecuted: exec.executorStarted,
                codeExecutionFailure: exec.failure,
                codeExecutionError: exec.error,
                isolation: exec.executorStarted ? exec.isolation : null,
                codeSha256: exec.codeSha256,
                codeAttestation: exec.attestation,
                codeDurationMs: exec.durationMs,
                productionAttested: exec.productionAttested,
                ...(exec.containerEvidence
                  ? { containerEvidence: exec.containerEvidence }
                  : {}),
                sandboxDispatches: exec.toolDispatches.flatMap((dispatch) =>
                  dispatch.receipt ? [dispatch.receipt] : [],
                ),
                // #RUN-EVIDENCE (D6) — the host-side classification of every
                // tool the generated code dispatched. `sandboxDispatches` only
                // carries factory RECEIPTS, so a production live dispatch left
                // no trace at all and the run-level ledger could not tell
                // "generated code called nothing" from "generated code called
                // things we never recorded". This list closes exactly that
                // ambiguity; it is not a substitute for a per-call record.
                codeToolDispatches: exec.toolDispatches.map((dispatch) => ({
                  tool: dispatch.tool,
                  kind: dispatch.kind,
                })),
                tenantSlug: ctx.tenantSlug,
                timedOut: exec.timedOut ?? false,
                crashed: exec.crashed ?? false,
                codeExecutionReceipt,
                hint: "The exact generated handler did not complete in its isolate; no declarative fallback was executed.",
              },
            };
          }
        } else if (tenantPrompt || agent?.generated) {
          // Declarative generated agents (codeExecuted=false) run their authored
          // ontology instructions through the real gateway via the default
          // generated prompt. For v1 generated agents the full authored
          // action_prompt (rubric + output contract) must ride the user turn —
          // it reaches the model nowhere else, and compiled ontology agents put
          // their fail-closed output contract there. v2 agents already carry
          // action_prompt in the system message, so their action-context keeps
          // the one-line description.
          let logicPromptIsV2 = false;
          try {
            logicPromptIsV2 =
              agent !== undefined &&
              normalizeAgentForExecution(agent).compatibilityMode === "v2";
          } catch {
            logicPromptIsV2 = false;
          }
          const authoredLogicObjective =
            !logicPromptIsV2 &&
            typeof action.action_prompt === "string" &&
            action.action_prompt.trim()
              ? action.action_prompt.trim()
              : action.description;
          const logicPrompt =
            tenantPrompt ??
            makeGeneratedAgentPrompt(action.name, authoredLogicObjective);
          // Per-action AI controls are true per-step overrides: any omitted
          // field inherits the agent-level selection, so a cheap classifier, a
          // reasoning-heavy planner, and a long-context synthesizer can coexist
          // inside one authored agent.
          const effectiveAgent = agent
            ? {
                ...agent,
                ...(action.provider ? { provider: action.provider } : {}),
                ...(action.model ? { model: action.model } : {}),
                ...(action.task_class
                  ? { task_class: action.task_class }
                  : action.task_type
                    ? { task_class: action.task_type }
                    : {}),
                ...(action.reasoning ? { reasoning: action.reasoning } : {}),
                ...(action.verbosity ? { verbosity: action.verbosity } : {}),
                ...(typeof action.store === "boolean"
                  ? { store: action.store }
                  : {}),
                ...(typeof action.temperature === "number"
                  ? { temperature: action.temperature }
                  : {}),
                ...(typeof action.max_tokens === "number"
                  ? { max_tokens: action.max_tokens }
                  : {}),
                ...(typeof action.timeout_s === "number"
                  ? { timeout_s: action.timeout_s }
                  : {}),
              }
            : agent;
          // Per-action retry budget. Parsed legacy manifests migrate action
          // retries up to the agent-level Inngest budget (leaving 0 here);
          // Studio test-lab callers pass raw v2 actions that may carry one.
          const retryCount = Math.min(
            10,
            Math.max(0, (action as { retries?: number }).retries ?? 0),
          );
          const maxAttempts = retryCount + 1;
          const hasOutputMapping =
            isPlainSchema(
              (action as { output_mapping?: unknown }).output_mapping,
            ) &&
            Object.keys(
              (action as { output_mapping?: Record<string, unknown> })
                .output_mapping ?? {},
            ).length > 0;
          let attempts = 0;
          for (;;) {
            attempts += 1;
            try {
              result = await runTenantPrompt(
                ctx,
                logicPrompt,
                action,
                effectiveAgent,
                tenantRegistry,
                {
                  trace: input.trace,
                  runId: input.runId ?? ctx.runId,
                  stepId: input.stepId,
                  validateOutput:
                    (input.finalOutput ?? true) && !hasOutputMapping,
                  conversationHistory: input.conversationHistory,
                  usageAttribution: input.usageAttribution,
                },
              );
            } catch (error) {
              if (attempts >= maxAttempts) throw error;
              if (input.runId) {
                await emitTraceBestEffort(input.trace, {
                  runId: input.runId,
                  ...(input.stepId ? { stepId: input.stepId } : {}),
                  kind: "step",
                  level: "standard",
                  name: `${action.name}.retry`,
                  status: "running",
                  summary: `Retrying logic action after attempt ${attempts} failed`,
                  data: {
                    attempt: attempts,
                    maxAttempts,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  visibility: "operator",
                });
              }
              continue;
            }
            const retryableResult =
              !result.ok && result.meta?.error === "output_schema_invalid";
            if (!retryableResult || attempts >= maxAttempts) break;
          }
          result = {
            ...result,
            meta: { ...result.meta, actionAttempts: attempts },
          };
        } else {
          // UC-V11-25 / AR-GAP-13 — strict mode. Boot-time validation in
          // `packages/runtime/src/bootstrap.ts` refuses to register a tenant
          // whose manifest has logic actions without matching prompts.
          // Reaching this branch means a hot-reload path bypassed validation
          // or a test wired a partial registry. Fail loud instead of
          // shipping `${name}: ${description}` (often non-English text) to
          // the model as a user message.
          result = {
            ok: false,
            type: "logic",
            data: null,
            meta: {
              error: "missing_tenant_prompt",
              actionName: action.name,
              hint:
                "Add a definePrompt to tenants/<slug>/prompts/ and re-export it " +
                "from the TenantRegistry.prompts map.",
            },
          };
        }
        break;
      }
      case "manual": {
        // Real HITL flow lives in register.ts (step.waitForEvent + tasks).
        // The engine never reaches this case via the main loop — register.ts
        // short-circuits manual steps before calling runAction. Kept here so
        // ad-hoc callers (tests, replays) get a sensible placeholder.
        result = {
          ok: false,
          type: "manual",
          data: {
            error: "manual_step_requires_durable_runtime",
            note: "manual steps must run through register.ts waitForEvent/task orchestration",
          },
          pendingTaskTitle: action.name,
        };
        break;
      }
      case "condition": {
        // Phase 1a: the real, safe boolean evaluator (action-plan.ts) — supports path
        // comparisons (==/!=/>/</>=/<=), presence, negation, &&/||, plus the legacy
        // `lastResult == null` forms plus named `results.<stepId>` access. Unparseable is a
        // configuration failure (ok:false), never a silent false branch.
        // register.ts consumes `data.evaluated` to SKIP downstream dependsOn steps.
        const condition =
          (action as { condition?: string }).condition ?? "true";
        const evaluation = evaluateConditionDetailed(condition, {
          lastResult: ctx.lastResult,
          results: ctx.results,
          event: ctx.event,
          input: ctx.event?.data,
          locals: ctx.locals,
        });
        // v2 branch routing: expose the selected explicit target so register.ts
        // (and the Studio test-runner) can jump to a later action.
        const conditionTargetActionId = evaluation.valid
          ? ((evaluation.value
              ? action.true_action_id
              : action.false_action_id) ?? null)
          : null;
        result = {
          // Invalid expressions are configuration defects, not a false business branch. Fail the
          // step closed so the plan cannot silently continue to its default success emit.
          ok: evaluation.valid,
          type: "condition",
          data: {
            evaluated: evaluation.value,
            condition,
            valid: evaluation.valid,
            error: evaluation.error,
            targetActionId: conditionTargetActionId,
          },
          ...(evaluation.valid
            ? {}
            : {
                meta: { error: "invalid_condition", detail: evaluation.error },
              }),
        };
        break;
      }
      case "delay": {
        // Durable timers require Inngest's step.sleep and are orchestrated in
        // register.ts. Refuse an ad-hoc in-process timer: setTimeout inside a
        // worker is neither crash-safe nor replay-safe and could otherwise
        // produce a false completion receipt after a restart.
        const ms = (action as { delay_ms?: number }).delay_ms ?? 0;
        // A non-positive delay is a no-op (Agent Studio's rewrite/simulation path
        // emits delay_ms:0): it needs no durable timer, so it resolves instantly
        // in-process — no setTimeout is spawned, so the crash/replay-safety
        // rationale is fully preserved. Only a real positive delay is refused and
        // forced through register.ts step.sleep orchestration.
        if (ms <= 0) {
          result = {
            ok: true,
            type: "delay",
            data: { delay_ms: ms, sleptMs: ms },
          };
          break;
        }
        result = {
          ok: false,
          type: "delay",
          data: {
            error: "delay_requires_durable_runtime",
            delay_ms: ms,
            note: "delay steps must run through register.ts step.sleep orchestration",
          },
        };
        break;
      }
      case "subflow": {
        // P1-RT-03: placeholder. The real fork — emitting an event for the
        // child agent and (optionally) awaiting its terminal event — is in
        // register.ts. The engine version records the intended fanout so
        // ad-hoc callers can inspect it.
        const a = action as {
          subflow?: string;
          subflow_input?: Record<string, unknown>;
        };
        result = {
          ok: false,
          type: "subflow",
          data: {
            error: "subflow_requires_durable_runtime",
            subflow: a.subflow ?? null,
            subflow_input: a.subflow_input ?? {},
          },
        };
        break;
      }
      case "emit": {
        const a = action as ActionSpec & {
          emit_event?: string;
          emit_payload_from?: string;
          emit_payload?: Record<string, unknown>;
        };
        const event = (a.emit_event ?? "").trim();
        const allow = agent?.triggeredEvents;
        if (!event || (allow && !allow.includes(event))) {
          result = {
            ok: false,
            type: "emit",
            data: null,
            meta: {
              error: !event ? "emit_event_missing" : "emit_event_not_declared",
              event,
              declared: allow ?? [],
            },
          };
          break;
        }
        let selected: unknown = ctx.lastResult;
        if (a.emit_payload_from) {
          const resolved = resolveConditionPath(
            {
              lastResult: ctx.lastResult,
              results: ctx.results,
              event: ctx.event,
              input: ctx.event?.data,
              locals: ctx.locals,
            },
            a.emit_payload_from,
          );
          if (!resolved.valid || resolved.value === undefined) {
            result = {
              ok: false,
              type: "emit",
              data: null,
              meta: {
                error: "emit_payload_path_unresolved",
                path: a.emit_payload_from,
              },
            };
            break;
          }
          selected = resolved.value;
        }
        const selectedRecord =
          selected && typeof selected === "object" && !Array.isArray(selected)
            ? (selected as Record<string, unknown>)
            : selected === undefined
              ? {}
              : { value: selected };
        const payload = { ...selectedRecord, ...(a.emit_payload ?? {}) };
        const intent: EmitIntent = { event, payload };
        result = {
          ok: true,
          type: "emit",
          // `_emit` keeps old one-branch consumers working; `_emits` is the lossless contract.
          data: { ...payload, _emit: event, _emits: [intent] },
          meta: { emitted: [intent], explicitEmit: true },
        };
        break;
      }
      case "invoke": {
        const target = (action.invoke ?? "").trim();
        if (!target || !input.durableActionRuntime) {
          result = {
            ok: false,
            type: "invoke",
            data: null,
            meta: {
              error: !target
                ? "invoke_target_missing"
                : "invoke_requires_durable_runtime",
              target,
            },
          };
          break;
        }
        try {
          const data = await input.durableActionRuntime.invoke({
            stepId: input.durableStepId ?? action.result_key ?? action.name,
            target,
            input: invokePayload(action, ctx),
            timeoutMs: input.resolvedTimeoutMs,
          });
          result = {
            ok: true,
            type: "invoke",
            data,
            meta: { invoked: target, durableStepId: input.durableStepId },
          };
        } catch (failure) {
          const facts = actionErrorFacts(failure);
          result = {
            ok: false,
            type: "invoke",
            data: { __error: "invoke_failed", target },
            meta: {
              error: "invoke_failed",
              target,
              facts,
              ...(facts.kind ? { kind: facts.kind } : {}),
              ...(facts.code ? { code: facts.code } : {}),
              ...(facts.status !== undefined ? { status: facts.status } : {}),
              message: facts.message,
            },
          };
        }
        break;
      }
      case "foreach": {
        const a = action as ActionSpec & {
          items_from?: string;
          item_as?: string;
          item_key_from?: string;
          foreach_actions?: ActionSpec[];
        };
        const itemsPath = a.items_from ?? "";
        const resolved = resolveConditionPath(
          {
            lastResult: ctx.lastResult,
            results: ctx.results,
            event: ctx.event,
            input: ctx.event?.data,
            locals: ctx.locals,
          },
          itemsPath,
        );
        if (!resolved.valid || !Array.isArray(resolved.value)) {
          result = {
            ok: false,
            type: "foreach",
            data: null,
            meta: { error: "foreach_items_not_array", path: itemsPath },
          };
          break;
        }
        const materialized = materializeForeach({
          items: resolved.value,
          itemAs: a.item_as,
          itemKeyFrom: a.item_key_from ?? "",
        });
        if (!materialized.ok) {
          result = {
            ok: false,
            type: "foreach",
            data: null,
            meta: { error: "foreach_key_invalid", detail: materialized.error },
          };
          break;
        }

        let totalIn = 0;
        let totalOut = 0;
        // #RUN-EVIDENCE (D6) — aggregate the ledger entries the durable body
        // steps persisted, so a nested container's caller counts every leaf
        // dispatch exactly once (leaves write, containers only aggregate).
        const bodyToolLedger: ToolCallLedgerEntry[] = [];
        const allEmitted: EmitIntent[] = [];
        let suppressImplicitEmit = false;
        let terminalFailure: {
          stepId: string;
          data: unknown;
          resolution?: ActionFailureResolution;
        } | null = null;
        const parentId =
          input.durableStepId ?? action.result_key ?? action.name;
        const foreachActions = a.foreach_actions ?? [];
        const ownsConditionalEmitRouting =
          hasAuthoritativeConditionalEmit(foreachActions);
        const receipts = await runSequentialForeach(
          materialized.frames,
          async (frame) => {
            if (terminalFailure) {
              return {
                index: frame.index,
                key: frame.businessKey,
                stableKey: frame.stableKey,
                item: frame.item,
                stepIds: [] as string[],
                results: {} as Record<string, unknown>,
                lastResult: frame.item as unknown,
                skipped: true,
                reason: "prior foreach item failed terminally",
              };
            }
            let localLast: unknown = frame.item;
            const localResults: Record<string, unknown> = {};
            const localGate: GateState = {
              conditionTrue: {},
              skipped: new Set<string>(),
            };
            const stepIds: string[] = [];
            const failures: Array<{
              stepId: string;
              action: string;
              resolution: ActionFailureResolution;
            }> = [];
            // The count is item-local by construction. A conditional emit in
            // item A must not make a no-match in item B look routed.
            const emitCountBefore = allEmitted.length;
            for (const child of foreachActions) {
              if (ctx.signal?.aborted) break;
              const childKey = child.result_key ?? child.name;
              const durableId = foreachStepId(parentId, frame, childKey);
              stepIds.push(durableId);
              const skip = shouldSkip(
                { name: childKey, dependsOn: child.depends_on },
                localGate,
              );
              if (skip.skip) {
                localGate.skipped.add(childKey);
                localResults[childKey] = { skipped: true, reason: skip.reason };
                continue;
              }
              const combinedLocals = { ...(ctx.locals ?? {}), ...frame.locals };
              const childEvent = {
                name: ctx.event?.name ?? "foreach",
                data: {
                  ...(ctx.event?.data ?? {}),
                  ...combinedLocals,
                  _foreach: {
                    parentStepId: parentId,
                    index: frame.index,
                    key: frame.businessKey,
                    stableKey: frame.stableKey,
                  },
                },
              };
              const childPrecondition = evaluateActionPrecondition(child, {
                lastResult: localLast,
                results: { ...(ctx.results ?? {}), ...localResults },
                event: childEvent,
                input: childEvent.data,
                locals: combinedLocals,
              });
              if (childPrecondition.outcome === "invalid") {
                terminalFailure = {
                  stepId: durableId,
                  data: {
                    __error: "invalid_condition",
                    condition: childPrecondition.condition,
                    error: childPrecondition.error,
                  },
                };
                break;
              }
              if (childPrecondition.outcome === "skip") {
                localGate.skipped.add(childKey);
                localResults[childKey] = {
                  skipped: true,
                  reason: childPrecondition.reason,
                  condition: childPrecondition.condition,
                  evaluated: false,
                };
                continue;
              }
              const childInput: StepInput = {
                ...input,
                runId: undefined,
                stepOrd: undefined,
                action: child,
                durableStepId: durableId,
                ctx: {
                  ...ctx,
                  actionName: child.name,
                  event: childEvent,
                  lastResult: localLast,
                  results: { ...(ctx.results ?? {}), ...localResults },
                  locals: combinedLocals,
                },
              };
              let bodyResult: StepOutput;
              try {
                const operation = () => runAction(childInput);
                // A foreach container owns no external side effect itself; its
                // descendants receive their own ids. Every other body action is
                // one durable item-local boundary (invoke uses host.invoke).
                bodyResult =
                  child.type === "foreach" || child.type === "invoke"
                    ? await operation()
                    : input.durableActionRuntime
                      ? await input.durableActionRuntime.run(
                          durableId,
                          operation,
                          { actionName: child.name },
                        )
                      : await operation();
              } catch (failure) {
                // #RUN-EVIDENCE — a failed evidence write is a runtime
                // failure, never a business failure a manifest `on_error`
                // policy may soften. Same carve-out register.ts applies.
                // Recognizer, not instanceof: an SDK StepError round-trip
                // keeps only the error's name, not its class identity.
                if (isRequiredStepEvidenceFailure(failure)) throw failure;
                const resolution = classifyNestedActionFailure(child, failure);
                if (resolution.disposition === "retry") {
                  throw failureForDisposition(resolution, failure) ?? failure;
                }
                failures.push({
                  stepId: durableId,
                  action: childKey,
                  resolution,
                });
                suppressImplicitEmit ||= resolution.suppressEmit;
                const intent = failureEmitIntent(resolution);
                if (intent) allEmitted.push(intent);
                if (resolution.disposition === "continue") {
                  bodyResult = {
                    ok: true,
                    type: child.type,
                    data: resolution.defaultResult,
                    meta: { failureResolution: resolution, softFailed: true },
                  };
                } else {
                  terminalFailure = {
                    stepId: durableId,
                    data: { error: resolution.facts },
                    resolution,
                  };
                  break;
                }
              }
              totalIn += bodyResult.tokensIn ?? 0;
              totalOut += bodyResult.tokensOut ?? 0;
              // Collected BEFORE the ok-check: a failed body step's dispatched
              // calls happened and their evidence is already on disk.
              if (Array.isArray(bodyResult.toolLedger)) {
                bodyToolLedger.push(...bodyResult.toolLedger);
              }
              const emitted = (
                bodyResult.meta as { emitted?: EmitIntent[] } | undefined
              )?.emitted;
              if (Array.isArray(emitted)) allEmitted.push(...emitted);
              if (!bodyResult.ok) {
                const resolution = classifyNestedActionFailure(child, {
                  output: bodyResult,
                });
                if (resolution.disposition === "retry") {
                  throw (
                    failureForDisposition(resolution, { output: bodyResult }) ??
                    new Error(`foreach child ${childKey} requested retry`)
                  );
                }
                failures.push({
                  stepId: durableId,
                  action: childKey,
                  resolution,
                });
                suppressImplicitEmit ||= resolution.suppressEmit;
                const intent = failureEmitIntent(resolution);
                if (intent) allEmitted.push(intent);
                if (resolution.disposition === "continue") {
                  localResults[childKey] = resolution.defaultResult;
                  localLast = mergeStepResults(
                    localLast,
                    resolution.defaultResult,
                  );
                  continue;
                }
                terminalFailure = {
                  stepId: durableId,
                  data: bodyResult.data,
                  resolution,
                };
                break;
              }
              localResults[childKey] = bodyResult.data;
              localLast = mergeStepResults(localLast, bodyResult.data);
              if (child.type === "condition") {
                localGate.conditionTrue[childKey] = Boolean(
                  (bodyResult.data as { evaluated?: boolean } | null)
                    ?.evaluated,
                );
              }
            }
            if (
              !terminalFailure &&
              !ctx.signal?.aborted &&
              ownsConditionalEmitRouting &&
              allEmitted.length === emitCountBefore
            ) {
              terminalFailure = {
                stepId: foreachStepId(
                  parentId,
                  frame,
                  "conditional-emit-no-match",
                ),
                data: {
                  __error: "conditional_emit_no_match",
                  code: "CONDITIONAL_EMIT_NO_MATCH",
                  message: `[park] foreach ${parentId}: no authoritative conditional emit guard matched`,
                },
              };
            }
            return {
              index: frame.index,
              key: frame.businessKey,
              stableKey: frame.stableKey,
              item: frame.item,
              stepIds,
              results: localResults,
              lastResult: localLast,
              failures,
            };
          },
        );

        const resolvedTerminalFailure = terminalFailure as {
          stepId: string;
          data: unknown;
          resolution?: ActionFailureResolution;
        } | null;
        if (resolvedTerminalFailure) {
          result = {
            ok: false,
            type: "foreach",
            data: { receipts, failure: resolvedTerminalFailure },
            tokensIn: totalIn,
            tokensOut: totalOut,
            ...(bodyToolLedger.length ? { toolLedger: bodyToolLedger } : {}),
            meta: {
              foreach: true,
              emitted: allEmitted,
              error: "foreach_body_failed",
              suppressImplicitEmit,
              ...(resolvedTerminalFailure.resolution
                ? { failureResolution: resolvedTerminalFailure.resolution }
                : {}),
            },
          };
          break;
        }
        const byKey = Object.fromEntries(
          receipts.map((receipt) => [receipt.stableKey, receipt]),
        );
        result = {
          ok: true,
          type: "foreach",
          data: { count: receipts.length, items: receipts, byKey },
          tokensIn: totalIn,
          tokensOut: totalOut,
          ...(bodyToolLedger.length ? { toolLedger: bodyToolLedger } : {}),
          meta: {
            foreach: true,
            mode: "sequential",
            emitted: allEmitted,
            suppressImplicitEmit,
          },
        };
        break;
      }
      default: {
        // Keep the switch fail-closed for any unexpected/ad-hoc type.
        result = {
          ok: false,
          type: "logic",
          data: null,
          meta: {
            error: "unsupported_action_type",
            actionType: (action as { type?: string }).type,
          },
        };
        break;
      }
    }

    if (action.type === "tool") {
      // #RUN-EVIDENCE (D6) — capture what the TOOL returned, before
      // `result_map` reshapes it. The audit record must show the tool's own
      // answer; an authored projection of it would make the persisted evidence
      // disagree with what the external system was actually told/asked.
      if (directToolDispatch) {
        directToolDispatch.rawOutput = { value: result.data };
      }
      const dataflowAction = action as ActionSpec & {
        tool_arguments?: Record<string, unknown>;
        result_map?: { fields: Record<string, string>; include_raw?: boolean };
      };
      const argumentMode = dataflowAction.tool_arguments
        ? "explicit"
        : "legacy_whole_context";
      if (result.ok && dataflowAction.result_map) {
        const mapped = applyToolResultMap(
          result.data,
          dataflowAction.result_map,
        );
        if (!mapped.ok) {
          result = {
            ...result,
            ok: false,
            data: null,
            meta: {
              ...(result.meta ?? {}),
              error: "tool_result_map_unresolved",
              detail: mapped.error,
              field: mapped.field,
              path: mapped.path,
              argumentMode,
            },
          };
        } else {
          result = {
            ...result,
            data: mapped.value,
            meta: {
              ...(result.meta ?? {}),
              argumentMode,
              resultMapped: true,
              rawResultIncluded: dataflowAction.result_map.include_raw === true,
            },
          };
        }
      } else {
        result = {
          ...result,
          meta: { ...(result.meta ?? {}), argumentMode },
        };
      }
    }
  } catch (error) {
    // A thrown dispatch still closes its structured step trace so Studio's
    // timeline never shows a forever-running action. Rethrow unchanged —
    // durable classification happens in register.ts.
    if (traceRunId) {
      const actionEndedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await emitTraceBestEffort(input.trace, {
        runId: traceRunId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        kind: "step",
        level: "minimal",
        name: action.name,
        status: "failed",
        startedAt: actionStartedAt,
        endedAt: actionEndedAt,
        durationMs: Math.max(
          0,
          actionEndedAt.getTime() - actionStartedAt.getTime(),
        ),
        summary: `${action.type} action failed: ${message}`,
        data: { type: action.type, error: message },
        visibility: "user",
      });
    }
    throw error;
  }

  if (actionRuleGateRecord) {
    result.meta = {
      ...result.meta,
      ruleGate: actionRuleGateRecord,
    };
  }

  // #RUN-EVIDENCE (D6) — project the direct `type:"tool"` dispatch into the
  // same `meta.toolCalls` shape the LLM loop emits, so register.ts's existing
  // per-call evidence writer records it and the run-level reconciliation counts
  // it. Done BEFORE `applyActionOutputMapping` so the recorded output is what
  // the tool actually returned rather than an authored reshaping of it. Never
  // overwrites an existing array: a path that already produced traces owns them.
  if (directToolDispatch && !Array.isArray(result.meta?.toolCalls)) {
    const directTrace: ToolCallTrace = {
      id: `direct-${action.name}`,
      name: directToolDispatch.tool,
      input:
        directToolDispatch.input
        && typeof directToolDispatch.input === "object"
        && !Array.isArray(directToolDispatch.input)
          ? (directToolDispatch.input as Record<string, unknown>)
          : { __value: directToolDispatch.input },
      output: directToolDispatch.rawOutput
        ? directToolDispatch.rawOutput.value
        : result.data,
      isError: !result.ok,
      durationMs: Math.max(0, Date.now() - directToolDispatch.startedAtMs),
      ...(directToolDispatch.decision
        ? { sandboxDecision: directToolDispatch.decision }
        : {}),
      ...(actionRuleGateRecord ? { ruleGate: actionRuleGateRecord } : {}),
      ...(directToolDispatch.probe ? { probe: directToolDispatch.probe } : {}),
      // A write-capable action that never reached the live dispatch — gated,
      // stubbed, replayed, refused by a gate, or failed before dispatch — still
      // owes a receipt. Falling through with none would let the reconciliation
      // read the call as one that claimed no effect at all.
      ...((): { effectVerification?: EffectVerificationReceipt } => {
        if (directToolDispatch.effectVerification) {
          return { effectVerification: directToolDispatch.effectVerification };
        }
        if (!directToolDispatch.writeCapable) return {};
        return {
          effectVerification: !result.ok
            ? unverifiedEffect("write_errored", {
                detail: `action '${action.name}' did not complete a write; there is no claimed effect to confirm`,
              })
            : unverifiedEffect("write_not_real", {
                detail: `dispatch decision '${directToolDispatch.decision ?? "(none)"}' — nothing was written, so nothing can be read back`,
              }),
        };
      })(),
    };
    result.meta = { ...result.meta, toolCalls: [directTrace] };
  }

  // v2 declarative per-action output mapping (applies after our tool
  // result_map so an authored mapping has the final say on the step's shape).
  if (result.ok) result = applyActionOutputMapping(result, action, ctx);

  // P0-RT-09: optional artifact sidecars.
  if (runId && typeof stepOrd === "number") {
    result.outputArtifact = await writeArtifact(
      runId,
      `step-${stepOrd}-output.json`,
      result,
    );
  }

  if (traceRunId) {
    const actionEndedAt = new Date();
    const traceToolCalls = Array.isArray(result.meta?.toolCalls)
      ? (result.meta.toolCalls as ToolCallTrace[])
      : [];
    await emitTraceBestEffort(input.trace, {
      runId: traceRunId,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      kind: "step",
      level: result.ok ? "standard" : "minimal",
      name: action.name,
      status: result.ok ? "ok" : "failed",
      startedAt: actionStartedAt,
      endedAt: actionEndedAt,
      durationMs: Math.max(
        0,
        actionEndedAt.getTime() - actionStartedAt.getTime(),
      ),
      summary: result.ok
        ? `${action.type} action completed`
        : `${action.type} action failed`,
      data: {
        type: action.type,
        tokensIn: result.tokensIn ?? 0,
        tokensOut: result.tokensOut ?? 0,
        toolCalls: traceToolCalls.length,
        toolErrors: traceToolCalls.filter((t) => t.isError).length,
        ...(result.model ? { model: result.model } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.ok ? {} : { error: result.meta?.error ?? "action_failed" }),
      },
      visibility: "user",
    });
  }

  return result;
}

/**
 * Execute every in-process action kind behind the same manifest deadline.
 * Tool/LLM handlers receive an AbortSignal; isolated CodeAct workers receive
 * the exact millisecond budget and are hard-terminated by their worker host.
 */
export async function runAction(input: StepInput): Promise<StepOutput> {
  // v2 declarative per-action input mapping reshapes the context this action
  // sees; billing attribution gains the durable function identity. Both are
  // no-ops for legacy manifests.
  const mappedCtx = applyActionInputMapping(input.ctx, input.action);
  const usageAttribution = mergeUsageAttribution(input.usageAttribution, {
    correlationId: mappedCtx.correlationId,
    functionName: `manifest.${mappedCtx.tenantSlug ?? "unknown"}.${mappedCtx.agentName ?? input.agent?.name ?? "unknown"}.${input.action.name}`,
  });
  input = { ...input, ctx: mappedCtx, usageAttribution };
  const precondition = evaluateActionPrecondition(input.action, {
    lastResult: input.ctx.lastResult,
    results: input.ctx.results,
    event: input.ctx.event,
    input: input.ctx.event?.data,
    locals: input.ctx.locals,
  });
  if (precondition.outcome === "invalid") {
    return {
      ok: false,
      type: input.action.type,
      data: {
        __error: "invalid_condition",
        condition: precondition.condition,
        error: precondition.error,
      },
      meta: {
        error: "invalid_condition",
        condition: precondition.condition,
        detail: precondition.error,
        conditionGuard: true,
      },
    };
  }
  if (precondition.outcome === "skip") {
    return {
      ok: true,
      type: input.action.type,
      data: {
        skipped: true,
        reason: precondition.reason,
        condition: precondition.condition,
        evaluated: false,
      },
      meta: {
        skipped: true,
        skipReason: "condition_false",
        condition: precondition.condition,
        evaluated: false,
        conditionGuard: true,
      },
    };
  }
  const now = Date.now();
  const localTimeoutMs =
    typeof input.action.timeout_s === "number"
      ? input.action.timeout_s * 1000
      : undefined;
  const localDeadlineAt =
    localTimeoutMs === undefined ? undefined : now + localTimeoutMs;
  const effectiveDeadlineAt =
    input.deadlineAt === undefined
      ? localDeadlineAt
      : localDeadlineAt === undefined
        ? input.deadlineAt
        : Math.min(input.deadlineAt, localDeadlineAt);
  const remainingDeadlineMs =
    effectiveDeadlineAt === undefined
      ? undefined
      : Math.max(0, effectiveDeadlineAt - now);
  const deadlineSource =
    input.deadlineAt !== undefined &&
    (localDeadlineAt === undefined || input.deadlineAt <= localDeadlineAt)
      ? "parent_deadline"
      : "action_timeout";
  const timeoutMs = remainingDeadlineMs;
  try {
    return await runWithActionTimeout(
      (signal) =>
        runActionCore({
          ...input,
          ctx: signal ? { ...input.ctx, signal } : input.ctx,
          deadlineAt: effectiveDeadlineAt,
          resolvedTimeoutMs: timeoutMs,
        }),
      {
        timeoutMs,
        parentSignal: input.ctx.signal,
        label: `action ${input.action.name}`,
      },
    );
  } catch (error) {
    if (!(error instanceof ActionTimeoutError)) throw error;
    return {
      ok: false,
      type: input.action.type,
      data: {
        __error: "action_timeout",
        code: error.code,
        timeout_ms: error.timeoutMs,
      },
      meta: {
        error: "action_timeout",
        kind: error.kind,
        code: error.code,
        timeoutMs: error.timeoutMs,
        deadlineSource,
        retryable: true,
      },
    };
  }
}
