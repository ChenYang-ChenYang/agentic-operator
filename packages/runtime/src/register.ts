/**
 * registerAgent — turns an AgentSpec into an Inngest function tied to a tenant.
 *
 * Per DESIGN.md §5:
 *   - One Inngest function per (tenant, agent).
 *   - Function ID: `${tenantSlug}.${agentName}` unless the tenant's transport
 *     adapter explicitly owns a legacy external id mapping.
 *   - Concurrency key: `event.data.subject` (one run per subject in flight).
 *   - Retries: manifest `retries` (0–10) when declared, else 3 (Inngest default).
 *   - Triggers: tenant-namespaced by default, or projected by the selected
 *     tenant transport adapter when it owns an external wire contract.
 *
 * The handler:
 *   1. Allocates a run ID + correlation ID (correlation propagates through chains).
 *   2. Inserts a `runs` row with status=running, then `steps` rows per action.
 *   3. Calls runAction() inside step.run() so retries are durable.
 *   4. After all steps, picks an emitted event (first item in `triggered_event`),
 *      inserts an outbound `events` row, appends to the ledger, sends to Inngest.
 *   5. Updates the run with status=ok + emitted_event_id.
 */

import { createHash } from "node:crypto";

import { appIdForTenant, getTenantInngest } from "./client";
import { runAction, type LlmTurnTrace, type StepOutput } from "./step-engine";
import {
  buildToolCallAuditRecord,
  type ProbeVerificationResult,
} from "./tool-dispatch-verification";
import type { EffectVerificationReceipt } from "./effect-verification";
import {
  reconcileRunCompletion,
  runCompletionEnforcementFromEnv,
  summarizeRunCompletion,
  toolLedgerEntryFromAuditRecord,
  type RunCompletionReconciliation,
  type ToolCallLedgerEntry,
  type UncoveredStep,
} from "./run-completion-reconciliation";
import {
  globalToolExecutionPolicy,
  globalToolSideEffect,
} from "@agentic/tools";
import {
  codeActExecutionReceiptFromMeta,
  type CodeActExecutionReceipt,
  type CodeActIsolation,
} from "./codeact-receipt";
import {
  evaluateActionPrecondition,
  foreachStepId,
  hasAuthoritativeConditionalEmit,
  materializeForeach,
  resolveConditionPath,
  runSequentialForeach,
  stableStepId,
  shouldSkip,
  softInvoke,
  type GateState,
} from "./action-plan";
import { selectEmittedEvents, type EmitIntent } from "./emit-select";
import { appendToLedger } from "./event-ledger";
import { publish } from "./broadcast";
import {
  createFilesystemArtifactSink,
  registerStepArtifactEvidence,
  writeArtifact,
  type RuntimeArtifactSink,
  type RuntimePersistedArtifact,
} from "./artifacts";
import {
  AgentInputValidationError,
  OutputSchemaValidationError,
  bindTriggerInputs,
  canonicalJson,
  normalizeAgentForExecution,
  parseValidateAndRepairOutput,
  resolveAgentEmissions,
  validateAgentInputs,
} from "./agent-execution";
import {
  createFilteredTraceSink,
  type RuntimeTraceSink,
} from "./execution-trace";
import { stripPrivateEventMetadata } from "./event-envelope";
import {
  privateUsageAttributionMetadata,
  usageAttributionFromDeliveryData,
} from "./usage-attribution-envelope";
import { logPathFor, writeRunLog, type RunLogContext } from "./log-writer";
import {
  RequiredStepEvidenceError,
  isRequiredStepEvidenceFailure,
  requireStepEvidence,
} from "./step-evidence";
import { correlationFromEvent, withCorrelation } from "./correlation";
import {
  flattenActionSpecs,
  type ActionSpec,
  type AgentSpec,
  type FactoryInputBinding,
} from "./manifest";
import {
  InputBindingResolutionError,
  applyHumanInputResult,
  applyObjectLookupResult,
  initializeInputBindings,
  prepareObjectLookupArguments,
  resolveAvailableStepOutputBindings,
  unresolvedRequiredInputBindings,
  type RuntimeInputBindingIssue,
} from "./input-bindings";
import {
  classifyActionFailure,
  failureForDisposition,
  isNonRetriableFailure,
  type ActionFailureResolution,
  type RuntimeOnErrorPolicy,
} from "./error-policy";
import { makeId, materializeInvokePayload } from "@agentic/shared";
import {
  agents,
  agentVersions,
  artifacts,
  events,
  eventStore,
  llmTurns,
  runEmittedEvents,
  runTraceEvents,
  runs,
  steps,
  tasks as tasksTable,
  workflows,
  getDb,
} from "@agentic/db";
import { eq, and, desc } from "drizzle-orm";
import {
  mergeUsageAttribution,
  type UsageAttribution,
} from "@agentic/llm-gateway";
import type {
  AgentRunRecord,
  ProviderId,
  RunArtifactMetadata,
  RunEmittedEvent,
  WorkflowManualTaskResolution,
} from "@agentic/contracts";
import { WorkflowManualTaskResolutionSchema } from "@agentic/contracts";

/**
 * #W0 — is raw LLM-turn capture enabled? Default ON. Set
 * AGENTIC_CAPTURE_LLM_TURNS to a falsy value (`0`/`false`/`no`/`off`) to stop
 * persisting the model's response/reasoning text (e.g. for PII-sensitive
 * deployments); token counts on `steps`/`llm_calls` are unaffected.
 */
function captureLlmTurns(): boolean {
  const raw = (process.env.AGENTIC_CAPTURE_LLM_TURNS ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

import type {
  TenantEventAdapter,
  TenantRegistry,
  ToolDescriptor,
} from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";
import { getRuntimeMetrics } from "./llm-host";
import { createMemoryHandle } from "./memory";
import { runWithTraceContext } from "./trace-context";
// #COMMS — inter-agent message envelope: carry-forward payload assembler + content-addressed offload.
import {
  assembleEmitPayload,
  mergeStepResults,
  rehydratePayloadAsync,
} from "./message-envelope";
import { makeDurableBlobOffloader, resolveBlobRefAsync } from "./blob-store";
import {
  bareTenantEventName,
  scheduledAgentTriggerName,
  tenantEventName,
  tenantFunctionId,
} from "./event-name";
import { resolveTenantEventAdapter } from "./event-adapter";
import {
  assertSandboxAttemptDispatchAllowed,
  isFactorySandboxTenant,
} from "./sandbox-mode";
import {
  productionCodeActManifestSha256,
  revalidateProductionGeneratedAgentCapability,
  type ProductionCodeActCapability,
  type ProductionGeneratedAgentAuthorizationRequest,
} from "./production-codeact-authorization";

export interface RegisterContext {
  tenantId: string;
  tenantSlug: string;
  workflowVersionId: string;
  /**
   * Tenant-specific tools + prompts loaded from the optional
   * `@tenants/<slug>` package. Resolved before generic @agentic/tools so
   * manifest action.name → tenant impl when present, generic when absent.
   */
  tenantRegistry?: TenantRegistry;
  /**
   * Optional per-registration broker-envelope override. The tenant registry's
   * adapter is used otherwise; ordinary tenants receive the identity adapter.
   */
  eventAdapter?: TenantEventAdapter;
  /**
   * Phase 1a — optional resolver mapping an `invoke` action's target ref (an agent name or
   * Inngest function id) to the registered InngestFunction, so `type:"invoke"` actions can
   * synchronously call a sub-agent via step.invoke. Missing/failed targets are terminal unless
   * the manifest explicitly declares on_error:"soft" with default_result. Wired in bootstrap
   * after all functions are built (so siblings resolve by handler-run time).
   */
  resolveFunction?: (ref: string) => InngestFunction.Any | undefined;
  /**
   * Phase 2 — brain-authored declarative HTTP tools (from factory_tools), built into runtime
   * ToolDescriptors via buildDeclarativeOverlay. Merged into the per-step tenant tool map so the
   * step-engine resolves them (overlay → tenant → global) — this is what makes a tool the brain
   * DECLARED actually INVOKABLE by the deployed agent. Domain-scoped + injected by the api.
   */
  declarativeTools?: Record<string, ToolDescriptor>;
  /** Opaque authority minted from the durable Agent Factory promotion ledger.
   * It is captured by the registered handler and cannot be reconstructed from
   * manifest JSON. Declarative and sandbox agents leave it undefined. */
  productionCodeActCapability?: ProductionCodeActCapability;
  productionCodeActManifestSha256?: string;
  productionCodeActWorkflowManifestSha256?: string;
  /** Opaque promotion authority required for every generated production Agent,
   * including declarative plans. The CodeAct-specific fields above remain the
   * final handler-execution binding for exact code bytes. */
  productionGeneratedAgentCapability?: ProductionCodeActCapability;
  productionGeneratedAgentManifestSha256?: string;
  productionGeneratedWorkflowManifestSha256?: string;
  /**
   * #RULE-GATE — server-authored ontology rule corpus + tool bindings for this
   * tenant's domain, resolved once per boot by `resolveOntologyRuleContext`.
   * Injected here rather than read from the manifest so an agent can neither
   * shrink the rules that govern it nor exempt a tool from its own gate.
   */
  ontologyRules?: unknown[];
  ontologyRuleBindings?: Record<string, string[]>;
  /**
   * #DISPATCH-VERIFY — persisted probe standing per tool name, so dispatch can
   * verify what is actually running rather than trusting a promote-time check.
   */
  factoryToolProbeState?: Record<
    string,
    {
      probeStatus?: string | null;
      definitionHash?: string | null;
      verifiedAt?: number | null;
      classification?: string | null;
      credentialConfigured?: boolean | null;
    }
  >;
  /** Optional override; defaults to the runtime DB trace sink (run_trace_events). */
  traceSink?: RuntimeTraceSink;
  /** Optional tenant-authorized artifact service for this run. */
  artifactSinkFactory?: (context: {
    tenantId: string;
    runId: string;
  }) => RuntimeArtifactSink;
}

export function buildManualTaskPayload(input: {
  agent: Pick<AgentSpec, "name">;
  action: ActionSpec;
  subject: string | null;
  preparedContext: unknown;
}): Record<string, unknown> {
  return {
    agentName: input.agent.name,
    actionName: input.action.name,
    description: input.action.description,
    subject: input.subject,
    condition: input.action.condition ?? null,
    preparedContext: input.preparedContext ?? null,
    formSchema: input.action.form_schema ?? null,
    awaitingRole: input.action.awaiting_role ?? "operator",
  };
}

export type ManualTaskDecision = "approve" | "reject" | "supplement";
export type ManualTaskOutcome = "approved" | "rejected" | "supplemented";

export type ManualTaskResolution = WorkflowManualTaskResolution;

/**
 * Turn the resume event into the stable value exposed to later actions,
 * output validation, artifacts, and authored event bindings. A rejection is
 * a successful operator decision, not an infrastructure failure, so callers
 * can finalize and fan out it exactly like approve/supplement.
 */
export function buildManualTaskResolution(input: {
  taskId: string;
  decision?: unknown;
  payload?: unknown;
}): ManualTaskResolution {
  const decision = input.decision ?? "approve";
  if (
    decision !== "approve" &&
    decision !== "reject" &&
    decision !== "supplement"
  ) {
    throw new Error(`invalid manual task decision: ${String(decision)}`);
  }
  const outcome: ManualTaskOutcome =
    decision === "approve"
      ? "approved"
      : decision === "reject"
        ? "rejected"
        : "supplemented";
  return WorkflowManualTaskResolutionSchema.parse({
    task_id: input.taskId,
    status: "resolved",
    decision,
    outcome,
    payload: input.payload ?? null,
  });
}

/** Default persistence for Studio/operator structured trace rows. */
function createDbTraceSink(tenantId: string): RuntimeTraceSink {
  return {
    append(event) {
      const db = getDb();
      const latest = db
        .select({ seq: runTraceEvents.seq })
        .from(runTraceEvents)
        .where(eq(runTraceEvents.runId, event.runId))
        .orderBy(desc(runTraceEvents.seq))
        .limit(1)
        .all()[0];
      db.insert(runTraceEvents)
        .values({
          id: makeId("trc"),
          tenantId,
          runId: event.runId,
          stepId: event.stepId ?? null,
          parentId: event.parentId ?? null,
          seq: (latest?.seq ?? 0) + 1,
          kind: event.kind,
          level: event.level,
          name: event.name,
          status: event.status,
          startedAt: event.startedAt ?? null,
          endedAt: event.endedAt ?? null,
          durationMs: event.durationMs ?? null,
          summary: event.summary ?? null,
          dataJson: event.data ?? null,
          artifactId: event.artifactId ?? null,
          visibility: event.visibility,
        })
        .run();
    },
  };
}

/**
 * Generic events fan out to every function sharing their trigger. An
 * agent-scoped publish stamps `__invokedAgent`; sibling subscribers must
 * acknowledge the event without allocating a run. Unscoped events preserve
 * the original fanout behavior.
 */
export function eventTargetsAgent(
  data: Record<string, unknown>,
  agentName: string,
): boolean {
  const target = data.__invokedAgent;
  return typeof target !== "string" || target === "" || target === agentName;
}

/**
 * Add transport-only metadata to a canonical downstream payload. Keeping
 * this boundary explicit guarantees that stripping private keys from the
 * delivered data reproduces the exact object persisted in the event ledger.
 */
export function buildManifestEventDeliveryData(args: {
  logicalPayload: Record<string, unknown>;
  eventId: string;
  correlationId: string;
  usageAttribution?: UsageAttribution;
}): Record<string, unknown> {
  return {
    ...withCorrelation(args.correlationId, {
      ...stripPrivateEventMetadata(args.logicalPayload),
      __triggerEventId: args.eventId,
    }),
    ...privateUsageAttributionMetadata(args.usageAttribution),
  };
}

type RunInvocationSource = "studio" | "event" | "api" | "replay" | "demo";

function runInvocationSource(value: string | undefined): RunInvocationSource {
  switch (value) {
    case "studio":
    case "api":
    case "replay":
    case "demo":
      return value;
    default:
      return "event";
  }
}

export interface ResolvedAgentConcurrency {
  limit: number;
  key: string;
}

/**
 * Compile Studio concurrency settings into Inngest's expression language.
 * Only simple event-data JSON paths are accepted; this keeps authored values
 * data-only and prevents arbitrary expression injection. `enabled:false`
 * disables the per-subject limit entirely (returns undefined).
 */
export function resolveAgentConcurrency(
  agent: unknown,
  tenantSlug: string,
): ResolvedAgentConcurrency | undefined {
  const config =
    agent && typeof agent === "object"
      ? (
          agent as {
            concurrency?: {
              enabled?: boolean;
              max_concurrent_executions?: number;
              key?: string;
            };
          }
        ).concurrency
      : undefined;
  if (config?.enabled === false) return undefined;
  if (
    config?.max_concurrent_executions !== undefined &&
    (!Number.isInteger(config.max_concurrent_executions) ||
      config.max_concurrent_executions < 1 ||
      config.max_concurrent_executions > 1_000)
  ) {
    throw new TypeError(
      "concurrency.max_concurrent_executions must be an integer from 1 to 1000",
    );
  }
  const path = config?.key?.trim() || "$.subject";
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) {
    throw new TypeError(
      `concurrency.key must be a restricted event-data path such as '$.subject' or '$.inputs.candidate.id'`,
    );
  }
  const eventExpression = `event.data.${path.slice(2)}`;
  return {
    limit:
      typeof config?.max_concurrent_executions === "number"
        ? config.max_concurrent_executions
        : 8,
    key: `${JSON.stringify(`${tenantSlug}:`)} + ${eventExpression}`,
  };
}

/**
 * Canonical trigger list for one agent: its business triggers, else the
 * synthetic schedule event when a cron (or config-driven cron_env) schedule
 * is declared. Used by registration AND the bootstrap event-listener upsert
 * so cron-only agents stay visible in the catalog graph.
 */
export function resolveAgentTriggerNames(agent: {
  name: string;
  trigger: string[];
  cron?: string | null;
  cron_env?: string | null;
}): string[] {
  if (agent.trigger.length > 0) return [...agent.trigger];
  const scheduleDeclared =
    (typeof agent.cron === "string" && agent.cron.trim().length > 0) ||
    (typeof agent.cron_env === "string" && agent.cron_env.trim().length > 0);
  return scheduleDeclared ? [scheduledAgentTriggerName(agent.name)] : [];
}

/**
 * AR-GAP-13 / UC-V11-25 — boot-time validation that every `logic` action
 * in a manifest has a matching tenant `definePrompt`.
 *
 * Tech-design (`docs/tech-design/ar-tool.md` § "Option B — strict") chose
 * refuse-to-boot over runtime graceful-degradation: without a tenant
 * prompt the step engine used to ship the bare
 * `${action.name}: ${action.description}` line as the LLM user message.
 * For RAAS that means streaming a Chinese description to whatever model
 * is fronting the gateway — almost never what the workflow author
 * intended. Better to fail loud at boot.
 */
export interface MissingPromptRef {
  agentName: string;
  actionName: string;
  description: string;
}

export function findMissingTenantPrompts(args: {
  manifest: ReadonlyArray<AgentSpec>;
  tenantRegistry?: TenantRegistry;
}): MissingPromptRef[] {
  const prompts = args.tenantRegistry?.prompts ?? {};
  const missing: MissingPromptRef[] = [];
  for (const agent of args.manifest) {
    // Generated agents (Agent Factory) supply their own default prompt at runtime — not a missing
    // hand-written prompt, so they never block boot.
    if ((agent as { generated?: boolean }).generated) continue;
    for (const action of flattenActionSpecs(agent.actions)) {
      if (action.type !== "logic") continue;
      if (prompts[action.name]) continue;
      missing.push({
        agentName: agent.name,
        actionName: action.name,
        description: action.description,
      });
    }
  }
  return missing;
}

/**
 * Format `findMissingTenantPrompts` output for the boot log. The shape is
 * deliberately operator-readable (not stack-trace style) — engineers
 * paste it straight into a follow-up "implement these prompts" ticket.
 */
export function formatMissingPromptsError(
  tenantSlug: string,
  missing: MissingPromptRef[],
): string {
  if (missing.length === 0) return `[tenant ${tenantSlug}] no missing prompts`;
  const lines = [
    `[tenant ${tenantSlug}] boot failed — ${missing.length} logic action(s) have no tenant definePrompt:`,
    ...missing.map(
      (m) =>
        `  - ${m.agentName} · ${m.actionName}: ${truncateForLog(m.description)}`,
    ),
    "",
    `To fix: add tenant prompts under tenants/${tenantSlug}/prompts/ and re-export them from`,
    `the TenantRegistry.prompts map. Until then, this tenant's Inngest functions WILL NOT register;`,
    `other tenants continue to boot.`,
  ];
  return lines.join("\n");
}

function truncateForLog(s: string, max = 100): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Inngest accepts a literal 0–20 for `retries`; the manifest caps agents at 10. */
export type FunctionRetryCount = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Agent-level retry budget for the Inngest function. The manifest's optional
 * `retries` (AgentSchema, integer 0–10) wins when declared; absence keeps the
 * historical default of 3. Defensively clamped so a value that bypassed schema
 * validation can never exceed Inngest's accepted range. Exported for TC-12.
 */
export function functionRetries(
  agent: Pick<AgentSpec, "retries">,
): FunctionRetryCount {
  const r = agent.retries;
  if (typeof r !== "number" || !Number.isFinite(r)) return 3;
  return Math.min(Math.max(Math.trunc(r), 0), 10) as FunctionRetryCount;
}

interface RuntimeStepOutcome {
  ok: boolean;
  data: unknown;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  model?: string;
  provider?: string;
  meta?: Record<string, unknown>;
  /**
   * #RUN-EVIDENCE (D6) — this step's projection of the per-call audit records
   * it actually persisted. It rides on the step's RETURN VALUE deliberately:
   * Inngest memoizes step results, so a replay that re-enters finalize with a
   * fresh closure still sees the full ledger. Accumulating it in a closure
   * variable would silently reconcile against an empty ledger after any
   * replay boundary — evidence that vanishes on retry is not evidence.
   */
  toolLedger?: ToolCallLedgerEntry[];
}

/**
 * #RUN-EVIDENCE (D6) — which of an agent's DECLARED tools can mutate external
 * state.
 *
 * Two independent declared axes, ORed exactly the way the probe gate ORs them
 * (`mostOutboundEffect` in step-engine.ts): a reviewed `operation: "read"` must
 * not erase a manifest `side_effect: "write"`, and vice-versa. `call` is
 * excluded — an outbound read-only API call claims no state.
 *
 * Reads only what the manifest/registry DECLARED. There is no name list and no
 * inference from verbs in a tool's name; an agent that declares nothing
 * write-capable simply has an empty set, and the reconciliation then makes no
 * claim about writes rather than guessing one.
 */
export function declaredWriteCapableTools(
  toolUse: unknown,
): ReadonlySet<string> {
  const names = new Set<string>();
  if (!Array.isArray(toolUse)) return names;
  const WRITE_CAPABLE = new Set(["write", "dual", "read_write"]);
  for (const raw of toolUse) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as {
      name?: unknown;
      side_effect?: unknown;
      execution_policy?: { operation?: unknown };
    };
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const declared = [
      entry.side_effect,
      entry.execution_policy?.operation,
      // The reviewed registry entry is authoritative when the manifest omits
      // its own metadata; a global write tool stays write-capable even in a
      // manifest that forgot to say so.
      globalToolExecutionPolicy(name)?.operation,
      globalToolSideEffect(name),
    ];
    if (declared.some((value) => typeof value === "string" && WRITE_CAPABLE.has(value))) {
      names.add(name);
    }
  }
  return names;
}

/** Raw per-call capture the step engine leaves on `meta.toolCalls` — one shape
 * whether the calls came from the LLM tool-use loop or a direct `type:"tool"`
 * dispatch. This is the single read site for the evidence writer. */
interface CapturedToolCall {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  durationMs?: number;
  ruleGate?: unknown;
  probe?: ProbeVerificationResult;
  sandboxDispatch?: { mode?: string };
  sandboxDecision?: string;
  effectVerification?: EffectVerificationReceipt;
}

function capturedToolCalls(
  meta: Record<string, unknown> | undefined,
): CapturedToolCall[] {
  const calls = (meta as { toolCalls?: unknown } | undefined)?.toolCalls;
  return Array.isArray(calls) ? (calls as CapturedToolCall[]) : [];
}

/**
 * #RUN-EVIDENCE — deterministic, item-unique evidence name for one tool call
 * dispatched by a foreach BODY action.
 *
 * Shape: `step-<ord>-foreach-<childStepId>-tool-<k>.json`, where
 *   - `<ord>` is the foreach CONTAINER's 1-based position in the agent's
 *     action list (matching its own `step-<ord>-{input,output}.json` sidecars),
 *   - `<childStepId>` is the child's durable Inngest step id from
 *     `foreachStepId(...)` — ancestry-stable and collision-hashed across items,
 *     sibling actions and nesting depth, so two foreach items can never
 *     collide on an evidence file and a replay regenerates the exact names,
 *   - `<k>` is the 1-based call index within that body step.
 * Top-level actions keep their historical `step-<ord>-tool-<k>.json` names.
 *
 * `attempt` > 1 inserts an `attempt-<a>-` qualifier before `tool-<k>` —
 * mirroring the main loop's retry naming — so an Inngest redelivery that
 * re-executes the child body records its calls BESIDE the prior attempt's
 * evidence instead of silently rewriting it. Attempt 1 keeps the historical
 * name (existing runs/suites pin it).
 */
export function foreachToolCallEvidenceName(
  ord: number,
  childStepId: string,
  callIndex: number,
  attempt = 1,
): string {
  return attempt > 1
    ? `step-${ord}-foreach-${childStepId}-attempt-${attempt}-tool-${callIndex}.json`
    : `step-${ord}-foreach-${childStepId}-tool-${callIndex}.json`;
}

/**
 * #RUN-EVIDENCE — durable attempt counter for one foreach CHILD body step.
 *
 * Children own no `steps` row (their evidence catalogues under the container),
 * so unlike the main loop there is no `attempts` column to bump when Inngest
 * re-delivers a child step whose result never reached the server. The catalog
 * itself is the durable record: any already-registered `manifest_tool_call`
 * artifact for this child proves a prior execution persisted evidence, and the
 * highest recorded `metadata.attempt` (legacy rows count as 1) names it. The
 * next attempt is one past that — computed INSIDE the child's durable step
 * body, so a memoized replay (which never re-enters the body) cannot bump it.
 */
function nextForeachChildEvidenceAttempt(input: {
  runId: string;
  containerStepId: string;
  childStepId: string;
}): number {
  const rows = getDb()
    .select({ metadataJson: artifacts.metadataJson })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, input.runId),
        eq(artifacts.stepId, input.containerStepId),
        eq(artifacts.role, "trace"),
      ),
    )
    .all();
  let maxAttempt = 0;
  for (const row of rows) {
    const metadata = row.metadataJson as {
      source?: unknown;
      foreachChildStepId?: unknown;
      attempt?: unknown;
    } | null;
    if (metadata?.source !== "manifest_tool_call") continue;
    if (metadata.foreachChildStepId !== input.childStepId) continue;
    const recorded =
      typeof metadata.attempt === "number" && Number.isFinite(metadata.attempt)
        ? metadata.attempt
        : 1;
    if (recorded > maxAttempt) maxAttempt = recorded;
  }
  return maxAttempt + 1;
}

/** Per-run identity/sinks the evidence writer needs; built once per handler
 * entry so every call site persists under the same authority. */
interface ToolCallEvidenceContext {
  runId: string;
  tenantId: string;
  correlationId: string;
  tenantSlug: string;
  agentName: string;
  agentVersionId?: string;
  ontologyActionName?: string;
  workflowManifestSha256?: string;
  declaredWriteTools: ReadonlySet<string>;
  traceSink: RuntimeTraceSink;
  logCtx: RunLogContext;
}

/**
 * #RUN-EVIDENCE (D6) — THE per-call evidence writer, extracted from the main
 * action loop so foreach body actions flow through the exact same discipline.
 *
 * For every captured call it: builds the audit record ONCE
 * (`buildToolCallAuditRecord`), projects it into the run ledger
 * (`toolLedgerEntryFromAuditRecord` — same bytes an auditor re-reads),
 * persists it as an artifact, catalogues it (`role:"trace"`, source
 * `manifest_tool_call`), appends the operator trace row, and writes the
 * `tool.call` run-log line. Every persistence step is wrapped in
 * `requireStepEvidence`, so a failed write fails the surrounding durable step
 * — fail closed, at every nesting depth.
 *
 * Callers choose the artifact naming: the main loop passes the historical
 * `step-<ord>-tool-<k>.json`, foreach children pass
 * `foreachToolCallEvidenceName(...)`. Returns the projected ledger entries;
 * the caller must return them from its durable step body so Inngest
 * memoization preserves them across replays.
 */
async function persistToolCallEvidence(params: {
  context: ToolCallEvidenceContext;
  toolCalls: readonly CapturedToolCall[];
  /** DB `steps` row the evidence artifacts are catalogued under. */
  stepRowId: string;
  /** Human step label recorded on the audit record, ledger entry and logs. */
  stepName: string;
  /** Deterministic artifact name for the 1-based call index. The caller folds
   * `attempt` into the name (attempt > 1 gets an `attempt-<a>` qualifier) so a
   * retry never rewrites a prior attempt's record. */
  evidenceName: (callIndex: number) => string;
  /** 1-based execution attempt of the surrounding durable step body. Persisted
   * in artifact metadata — parity with the step_input/step_output sidecars —
   * so evidence names an attempt the `steps` row can corroborate. */
  attempt: number;
  /** Extra metadata keys persisted beside source/toolName/callIndex/attempt. */
  artifactMetadata?: Record<string, unknown>;
}): Promise<ToolCallLedgerEntry[]> {
  const { context } = params;
  const ledger: ToolCallLedgerEntry[] = [];
  for (const [toolIndex, tc] of params.toolCalls.entries()) {
    const evidenceName = params.evidenceName(toolIndex + 1);
    // #DISPATCH-VERIFY (D9) — the record names its authority: who acted, under
    // which ontology action and version, which gates it passed, and payload
    // digests. The six legacy keys keep their exact names.
    //
    // #RUN-EVIDENCE (D6) — built ONCE and used twice: persisted as the
    // artifact, and projected into the run-level ledger. The reconciliation is
    // therefore derived from the exact bytes an auditor can re-read, never
    // recomputed from the live objects the caller happens to still be holding.
    const auditRecord = buildToolCallAuditRecord({
      call: {
        id: tc.id,
        name: tc.name,
        input: tc.input,
        output: tc.output,
        isError: tc.isError,
        durationMs: tc.durationMs,
        ruleGate: tc.ruleGate,
        sandboxDecision: tc.sandboxDecision ?? tc.sandboxDispatch?.mode,
        ...(tc.effectVerification
          ? { effectVerification: tc.effectVerification }
          : {}),
      },
      ...(tc.probe ? { probe: tc.probe } : {}),
      subject: {
        agentName: context.agentName,
        agentVersionId: context.agentVersionId,
        ontologyActionName: context.ontologyActionName,
        tenantSlug: context.tenantSlug,
        tenantId: context.tenantId,
        runId: context.runId,
        correlationId: context.correlationId,
        stepName: params.stepName,
        workflowManifestSha256: context.workflowManifestSha256,
      },
    });
    ledger.push(
      toolLedgerEntryFromAuditRecord(auditRecord, {
        evidence: evidenceName,
        step: params.stepName,
        writeCapable: context.declaredWriteTools.has(tc.name.trim()),
      }),
    );
    const toolEvidencePath = await requireStepEvidence(
      `tool call evidence '${tc.name}'`,
      () => writeArtifact(context.runId, evidenceName, auditRecord),
    );
    const toolArtifact = await requireStepEvidence(
      `tool call evidence catalog '${tc.name}'`,
      () =>
        registerStepArtifactEvidence({
          tenantId: context.tenantId,
          runId: context.runId,
          stepId: params.stepRowId,
          role: "trace",
          filePath: toolEvidencePath,
          metadata: {
            source: "manifest_tool_call",
            toolName: tc.name,
            callIndex: toolIndex + 1,
            attempt: params.attempt,
            ...(params.artifactMetadata ?? {}),
          },
        }),
    );
    await requireStepEvidence(
      `tool call trace '${tc.name}'`,
      () =>
        context.traceSink.append({
          runId: context.runId,
          stepId: params.stepRowId,
          kind: "tool",
          level: tc.isError ? "minimal" : "standard",
          name: `${tc.name}.evidence`,
          status: tc.isError ? "failed" : "ok",
          durationMs: tc.durationMs ?? 0,
          summary: tc.isError
            ? `Tool '${tc.name}' failed`
            : `Tool '${tc.name}' input/output persisted`,
          data: {
            callIndex: toolIndex + 1,
            isError: tc.isError ?? false,
          },
          artifactId: toolArtifact.id,
          visibility: "operator",
        }),
    );
    await requireStepEvidence(`tool call log '${tc.name}'`, () =>
      writeRunLog(
        context.logCtx,
        tc.isError ? "ERROR" : "INFO",
        "tool.call",
        {
          step: params.stepName,
          tool: tc.name,
          ok: tc.isError ? false : true,
          duration: `${tc.durationMs ?? 0}ms`,
        },
      ),
    );
  }
  return ledger;
}

/** Persist/broadcast only fields authored by the isolated CodeAct runtime.
 * A manifest's `codeExecuted` flag is an execution request and never reaches
 * this mapper. */
function codeActReceiptFields(receipt: CodeActExecutionReceipt) {
  return {
    codeRan: receipt.codeRan,
    codeExecuted: receipt.codeExecuted,
    codeIsolation: receipt.isolation,
    codeSha256: receipt.codeSha256,
    codeAttestation: receipt.attestation,
    codeExecutionFailure: receipt.failure,
  } as const;
}

const codeActRunReceiptSelection = {
  codeRan: runs.codeRan,
  codeExecuted: runs.codeExecuted,
  codeIsolation: runs.codeIsolation,
  codeSha256: runs.codeSha256,
  codeAttestation: runs.codeAttestation,
  codeExecutionFailure: runs.codeExecutionFailure,
} as const;

function storedCodeActReceiptFields(receipt: {
  codeRan: boolean | null;
  codeExecuted: boolean | null;
  codeIsolation: string | null;
  codeSha256: string | null;
  codeAttestation: CodeActExecutionReceipt["attestation"] | null;
  codeExecutionFailure: string | null;
}) {
  const codeIsolation: CodeActIsolation | null =
    receipt.codeIsolation === "worker_thread" ||
    receipt.codeIsolation === "isolated_subprocess" ||
    receipt.codeIsolation === "isolated_container"
      ? receipt.codeIsolation
      : null;
  return {
    ...receipt,
    codeIsolation,
  };
}

class ActionReturnedFailure extends Error {
  readonly output: unknown;

  constructor(actionName: string, output: unknown) {
    super(`action ${actionName} returned ok=false`);
    this.name = "ActionReturnedFailure";
    this.output = output;
  }
}

// #RUN-EVIDENCE — RequiredStepEvidenceError/requireStepEvidence moved to
// ./step-evidence so the nested foreach engine can recognize (and refuse to
// soften) evidence failures without a register.ts↔step-engine.ts import cycle.

/** Turn a failed action into either a serializable continue receipt or real
 * Inngest control flow. Terminal becomes NonRetriableError; retry/park keeps
 * the original throwable so the function retry budget remains active. */
function resolveActionFailureOutcome(
  action: ActionSpec,
  failure: unknown,
  partial?: Partial<RuntimeStepOutcome>,
  options?: { reclassifyControlFlow?: boolean },
): RuntimeStepOutcome {
  if (isNonRetriableFailure(failure) && !options?.reclassifyControlFlow)
    throw failure;
  const inherited = (failure as ActionReturnedFailure | null)?.output as
    | { meta?: { failureResolution?: unknown } }
    | undefined;
  const inheritedResolution = inherited?.meta?.failureResolution;
  const resolution =
    action.on_error === undefined &&
    inheritedResolution &&
    typeof inheritedResolution === "object" &&
    !Array.isArray(inheritedResolution)
      ? (inheritedResolution as ActionFailureResolution)
      : classifyActionFailure({
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
  const controlFlowError = failureForDisposition(resolution, failure);
  if (controlFlowError) throw controlFlowError;
  return {
    ok: true,
    data: resolution.defaultResult,
    tokensIn: partial?.tokensIn ?? 0,
    tokensOut: partial?.tokensOut ?? 0,
    durationMs: partial?.durationMs ?? 0,
    // #RUN-EVIDENCE — a soft-failed step's tool calls happened. Dropping the
    // ledger here would let an `on_error: soft` policy erase the record of the
    // very calls that failed.
    ...(partial?.toolLedger ? { toolLedger: partial.toolLedger } : {}),
    meta: {
      ...(partial?.meta ?? {}),
      failureResolution: resolution,
      softFailed: true,
    },
  };
}

/** Foreach is a container boundary: an explicitly declared container policy
 * may catch a terminal child, while an undeclared policy preserves the
 * child's NonRetriable control flow. Exported to keep this critical boundary
 * independently regression-testable. */
export function resolveForeachContainerFailure(
  action: ActionSpec,
  failure: unknown,
): RuntimeStepOutcome {
  return resolveActionFailureOutcome(action, failure, undefined, {
    reclassifyControlFlow: action.on_error !== undefined,
  });
}

function failureResolutionFromOutcome(outcome: {
  meta?: Record<string, unknown>;
}): ActionFailureResolution | undefined {
  const value = outcome.meta?.failureResolution;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ActionFailureResolution)
    : undefined;
}

/** Validate that an ephemeral app can execute only a sandbox-scoped manifest,
 * and that a production tenant can never register a sandbox attempt pointer. */
export function assertFactoryExecutionScope(
  agent: AgentSpec,
  tenantSlug: string,
): void {
  const executionScope = agent.factory_execution_scope;
  if (isFactorySandboxTenant(tenantSlug)) {
    if (!agent.generated || executionScope?.kind !== "sandbox") {
      throw new Error(
        `[runtime] ephemeral sandbox ${tenantSlug} refuses an agent without sandbox execution scope`,
      );
    }
  } else if (executionScope?.kind === "sandbox") {
    throw new Error(
      `[runtime] production tenant ${tenantSlug} refuses sandbox app pointer ${executionScope.attempt_id}`,
    );
  }
  if (
    executionScope &&
    agent.factory_domain_id &&
    executionScope.target_domain_id !== agent.factory_domain_id
  ) {
    throw new Error(
      `[runtime] factory target domain mismatch for ${agent.id}: ${executionScope.target_domain_id} != ${agent.factory_domain_id}`,
    );
  }
}

export function registerAgent(
  agent: AgentSpec,
  ctx: RegisterContext,
): InngestFunction.Any | null {
  const tenantSlug = ctx.tenantSlug;
  assertFactoryExecutionScope(agent, tenantSlug);
  let productionGeneratedAuthorizationRequest: ProductionGeneratedAgentAuthorizationRequest | null =
    null;
  // A bare declarative `generated` agent (Agent Studio's derived-from-legacy
  // marker) carries no factory provenance and no executable code — it runs the
  // same declarative path as a hand-authored agent, so it needs no durable
  // Factory promotion capability. Only agents that CLAIM factory production
  // (any factory_* identity field or executable code) must prove one. Mirrors
  // the manifest-import quarantine + bootstrap gates so all three surfaces agree.
  const claimsFactoryProduction =
    agent.generated === true &&
    (!!agent.factory_domain_id ||
      !!agent.factory_target_domain_id ||
      !!agent.factory_promotion_version_id ||
      !!agent.factory_regression_suite_fingerprint ||
      !!agent.factory_execution_scope ||
      agent.codeExecuted === true ||
      !!agent.typescript_code);
  if (claimsFactoryProduction && !isFactorySandboxTenant(tenantSlug)) {
    const agentManifestSha256 = productionCodeActManifestSha256(agent);
    const scope = agent.factory_execution_scope;
    if (
      scope?.kind !== "production" ||
      !agent.factory_domain_id ||
      agent.factory_target_domain_id !== agent.factory_domain_id ||
      scope.target_domain_id !== agent.factory_domain_id ||
      !agent.factory_promotion_version_id ||
      !agent.factory_regression_suite_fingerprint ||
      !ctx.productionGeneratedAgentCapability ||
      ctx.productionGeneratedAgentManifestSha256 !== agentManifestSha256 ||
      !ctx.productionGeneratedWorkflowManifestSha256
    ) {
      throw new Error(
        `[runtime] generated production Agent ${tenantSlug}/${agent.id} has no exact durable Factory promotion capability`,
      );
    }
    const executionKind =
      agent.codeExecuted === true
        ? ("codeact" as const)
        : ("declarative" as const);
    if (executionKind === "codeact" && !agent.typescript_code) {
      throw new Error(
        `[runtime] generated production CodeAct ${tenantSlug}/${agent.id} has no handler bytes`,
      );
    }
    productionGeneratedAuthorizationRequest = {
      executionKind,
      tenantId: ctx.tenantId,
      tenantSlug,
      domainId: agent.factory_domain_id,
      agentSlug: agent.id,
      promotionVersionId: agent.factory_promotion_version_id,
      regressionSuiteFingerprint: agent.factory_regression_suite_fingerprint,
      codeSha256:
        executionKind === "codeact"
          ? createHash("sha256")
              .update(agent.typescript_code!, "utf8")
              .digest("hex")
          : agentManifestSha256,
      agentManifestSha256,
      workflowManifestSha256: ctx.productionGeneratedWorkflowManifestSha256,
    };
  }
  const eventAdapter = resolveTenantEventAdapter(ctx);
  const fnId = tenantFunctionId(tenantSlug, agent.name, eventAdapter);

  // Agent Studio v2 compatibility boundary. Normalization is deterministic and
  // side-effect free; a legacy agent that cannot normalize simply stays on the
  // v1 path (never a boot failure — the raw manifest already validated).
  let normalizedExecution: ReturnType<
    typeof normalizeAgentForExecution
  > | null = null;
  try {
    normalizedExecution = normalizeAgentForExecution(agent);
  } catch {
    normalizedExecution = null;
  }
  const usesV2Definition = normalizedExecution?.compatibilityMode === "v2";
  const observability = normalizedExecution?.definition.observability;
  const traceSinkForRun = (): RuntimeTraceSink =>
    createFilteredTraceSink(ctx.traceSink ?? createDbTraceSink(ctx.tenantId), {
      traceLevel: observability?.trace_level,
      reasoningSummary: observability?.reasoning_summary,
    });
  const definitionHash = `sha256:${createHash("sha256")
    .update(canonicalJson(agent))
    .digest("hex")}`;

  // A pure-schedule agent has no business event trigger, but scheduler.ts
  // emits this canonical synthetic event on every cron tick. Registering the
  // matching listener is load-bearing: previously registerAgent returned
  // null here while the cron producer still emitted, creating a convincing
  // but permanently dead schedule.
  const triggerNames = resolveAgentTriggerNames(agent);

  // No event or schedule trigger (e.g. manual-only entry) → no autonomous
  // Inngest function is registered.
  if (triggerNames.length === 0) {
    return null;
  }

  const triggers = triggerNames.map((t) => ({
    event: tenantEventName(
      tenantSlug,
      t,
      eventAdapter,
    ) as `${string}/${string}`,
  }));

  // Per review M2: prior to this change `register.ts` hardcoded `limit: 8`
  // and never read `agent.concurrency.max_concurrent_executions`, which made
  // the lint check `concurrency_excess` a no-op (checking dead config). The
  // cap is honoured at registration time via resolveAgentConcurrency, which
  // also compiles Studio-authored restricted key paths and honours an
  // explicit `enabled:false` (no limit). A missing `concurrency` block keeps
  // the historical default of 8, keyed on the tenant-prefixed subject.
  const triggerSubjectExpr =
    eventAdapter.subjectExpressions?.trigger ?? "event.data.subject";
  const cancelSubjectExpr =
    eventAdapter.subjectExpressions?.cancel ?? "async.data.subject";
  const authoredConcurrency = resolveAgentConcurrency(agent, tenantSlug);
  const authoredConcurrencyKey = Boolean(
    (
      agent as AgentSpec & { concurrency?: { key?: string } }
    ).concurrency?.key?.trim(),
  );
  // P5-TEN-01 (G7) — the default key composes the tenant slug with the
  // ADAPTER's subject expression. Without the tenant prefix, two tenants
  // whose agents both process subject="REQ-2041" would share one Inngest
  // slot bucket. An authored restricted key wins verbatim (already
  // tenant-prefixed by resolveAgentConcurrency).
  const concurrency = authoredConcurrency
    ? {
        limit: authoredConcurrency.limit,
        key: authoredConcurrencyKey
          ? authoredConcurrency.key
          : `"${tenantSlug}:" + ${triggerSubjectExpr}`,
      }
    : undefined;

  // One Inngest app per tenant: bind this agent's function to the tenant's own
  // client (`agentic-operator-<slug>`). Normal tenants keep `${slug}.${agent}`;
  // the opted-in zhaopin compatibility app reuses the six old AO function ids
  // so Inngest sees a handler upgrade rather than a duplicate fleet.
  return getTenantInngest(tenantSlug).createFunction(
    {
      id: fnId,
      name: agent.title ?? agent.name,
      // Every enabled key is tenant-prefixed (see resolution above). Studio
      // may author a restricted event-data path, or disable this limit.
      ...(concurrency ? { concurrency } : {}),
      // Per-agent retry budget from the manifest (`retries`, 0–10); defaults
      // to the historical 3 when the agent doesn't declare one.
      retries: functionRetries(agent),
      // Operator kill switch (POST /v1/runs/:id/cancel). The route emits the
      // tenant-adapted `run.cancel` carrying { runId, subject }. We match on
      // subject because the runId is allocated *inside* the function (the
      // triggering event doesn't know it yet, and Inngest's `cancelOn.if`
      // can only compare values already present on the trigger envelope).
      // Subject is the natural correlation: the concurrency key above
      // already serialises one run per (tenant, subject), so a cancel keyed
      // on subject hits exactly the in-flight run the operator clicked
      // Stop on. Trade-off documented in the route handler: if two runs
      // share a subject (rare — concurrency cap > 1 + same key), both are
      // cancelled together. For a kill switch this is the correct safety
      // posture.
      cancelOn: [
        {
          event: tenantEventName(
            tenantSlug,
            "run.cancel",
            eventAdapter,
          ) as `${string}/${string}`,
          if: `${cancelSubjectExpr} == ${triggerSubjectExpr}`,
        },
      ],
      // v4: triggers moved into opts (was a separate 2nd arg in v3)
      triggers,
    },
    async ({ event, step, logger }) => {
      // #COMMS — rehydrate content-addressed blob refs so this run's handlers see REAL values (the
      // wire/storage stayed small; the active run resolves on demand). No-op when there are no refs.
      // Async resolution: local fs first, then the shared backend (#SCALE-BLOB) — so on a multi-
      // instance deploy a blob written by instance A rehydrates on instance B.
      const rehydratedData = await rehydratePayloadAsync(
        (event.data ?? {}) as Record<string, unknown>,
        async (ref) => {
          const resolved = await resolveBlobRefAsync(ref);
          if (resolved == null) {
            throw new Error(
              `Blob ${ref.hash} (${ref.bytes} bytes) is unavailable from both local and configured shared storage`,
            );
          }
          return resolved;
        },
      );
      // Tenant transport concerns terminate here. The generic runtime always
      // operates on canonical flat data and never branches on a business
      // tenant or legacy envelope format.
      const data = eventAdapter.inbound({
        eventName: event.name,
        data: rehydratedData,
      });
      // Agent-scoped publish (Studio "run this agent"): sibling subscribers
      // sharing the trigger acknowledge without allocating a run.
      if (!eventTargetsAgent(rehydratedData, agent.name)) {
        return {
          skipped: true,
          reason: "targeted_event_for_another_agent",
          targetAgent: rehydratedData.__invokedAgent,
        };
      }
      // Sanitized account/request attribution recovered from the private
      // Inngest envelope. It is never exposed to prompts or tools.
      const deliveredUsageAttribution = usageAttributionFromDeliveryData(
        rehydratedData,
        ctx.tenantId,
      );
      // #COMMS — offloader for oversized OUTBOUND fields (content-addressed, dedup by sha256).
      const durableOffloader = makeDurableBlobOffloader();
      const offloader = durableOffloader.offload;
      const subject = typeof data.subject === "string" ? data.subject : null;
      const triggerEventId =
        typeof data.__triggerEventId === "string"
          ? data.__triggerEventId
          : null;
      // Event Tester plumbing: the publish route stamps `__test: true` on the
      // Inngest envelope when the caller opted in. We propagate that into
      // `runs.isTest` so test traffic from operator publishes is filterable
      // and never pollutes production observability (PRD G5, NFR-7). The
      // legacy spelling is `__test`; downstream actions should not read it
      // directly — runs.isTest is the source of truth.
      const isTest = data.__test === true;

      // step.run memoizes results across Inngest replays. Wrap correlation +
      // run-row allocation so identical IDs are reused on every replay, and
      // we never create duplicate runs rows.
      const init = await step.run("init", async () => {
        if (productionGeneratedAuthorizationRequest) {
          const authorized = await revalidateProductionGeneratedAgentCapability(
            ctx.productionGeneratedAgentCapability,
            productionGeneratedAuthorizationRequest,
          );
          if (!authorized) {
            throw new Error(
              `[runtime] generated production Agent authorization is absent or revoked for ${tenantSlug}/${agent.id}`,
            );
          }
        }
        assertSandboxAttemptDispatchAllowed({
          tenantId: ctx.tenantId,
          tenantSlug,
          appId: appIdForTenant(tenantSlug),
          executionScope: agent.factory_execution_scope,
        });
        // Use normalized data, not the raw transport event. A tenant adapter
        // may recover transport-native correlation metadata as __correlationId.
        const cid = correlationFromEvent({ data });
        const rid = makeId("run");
        const db = getDb();

        // Scope the lookup to THIS tenant's workflow. kebab_id is unique only
        // *within* a tenant — two tenants can legitimately reuse the same ids
        // (e.g. raas + zhaopin both ship "10-1"). Matching on kebab_id alone
        // grabbed whichever tenant's row sorted first, mis-attributing the run
        // (and its stats) to the wrong tenant's agent. ctx.tenantId pins it.
        const agentRow = db
          .select()
          .from(agents)
          .innerJoin(workflows, eq(workflows.id, agents.workflowId))
          .where(
            and(
              eq(workflows.tenantId, ctx.tenantId),
              eq(agents.kebabId, agent.id),
            ),
          )
          .all()[0]?.agents;
        if (!agentRow) {
          throw new Error(
            `[runtime] agent kebab_id=${agent.id} (tenant=${ctx.tenantId}) not found in DB — bootstrap must run before functions register`,
          );
        }
        const agentVersionRow = db
          .select()
          .from(agentVersions)
          .where(
            and(
              eq(agentVersions.agentId, agentRow.id),
              eq(agentVersions.workflowVersionId, ctx.workflowVersionId),
            ),
          )
          .all()[0];

        const startedAt = Date.now();
        const runLogPath = logPathFor(
          {
            tenantSlug,
            tenantId: ctx.tenantId,
            runId: rid,
            correlationId: cid,
            agentName: agent.name,
          },
          new Date(startedAt),
        );
        // Non-sensitive billing/product attribution merged with server truth
        // (authenticated context wins for account fields).
        const initUsageAttribution = mergeUsageAttribution(
          deliveredUsageAttribution,
          {
            billingAccountId: ctx.tenantId,
            correlationId: cid,
            invocationSource: runInvocationSource(
              deliveredUsageAttribution.invocationSource,
            ),
          },
        );
        db.insert(runs)
          .values({
            id: rid,
            tenantId: ctx.tenantId,
            agentId: agentRow.id,
            agentVersionId: agentVersionRow?.id ?? null,
            triggerEventId,
            status: "running",
            startedAt: new Date(startedAt),
            correlationId: cid,
            subject,
            isTest,
            invocationSource: runInvocationSource(
              initUsageAttribution.invocationSource,
            ),
            requestId: initUsageAttribution.requestId,
            interactionId: initUsageAttribution.interactionId,
            productSurface: initUsageAttribution.productSurface,
            productAction: initUsageAttribution.productAction,
            requestedBy:
              initUsageAttribution.actorType === "user"
                ? initUsageAttribution.actorId
                : undefined,
            definitionHash,
            outputValid: null,
            sideEffectMode: isTest ? "suppressed" : "live",
            logPath: runLogPath,
          })
          .run();
        // Structured run.start trace (run_trace_events) — best-effort: trace
        // IO must never abort a real run. Inside `init` ⇒ exactly-once.
        try {
          await traceSinkForRun().append({
            runId: rid,
            kind: "run",
            level: "minimal",
            name: "run.start",
            status: "running",
            startedAt: new Date(startedAt),
            summary: `Started ${isTest ? "test" : "event"} run for ${agent.name}`,
            data: {
              agentName: agent.name,
              eventName: event.name,
              definitionHash,
              testRun: isTest,
            },
            visibility: "user",
          });
        } catch (err) {
          logger.warn("run.start trace failed", { err: String(err) });
        }
        // Live feed: broadcast run.started so the portal's stream (LIVE pill,
        // dashboards, Logs → live terminal) reflects manifest-agent activity in
        // real time. Inside `init`'s step.run ⇒ exactly-once across replays.
        // Best-effort: a broadcast failure must never abort the run.
        try {
          publish({
            type: "run.started",
            tenantId: ctx.tenantId,
            at: startedAt,
            runId: rid,
            agentName: agent.name,
            triggerEvent: event.name ?? null,
            subject: subject ?? null,
            correlationId: cid,
            testRun: isTest,
          });
        } catch {
          /* broadcast best-effort */
        }
        return {
          runId: rid,
          correlationId: cid,
          agentDbId: agentRow.id,
          agentVersionId: agentVersionRow?.id ?? null,
          startedAt,
          runLogPath,
        };
      });

      const runId = init.runId;
      const correlationId = init.correlationId;
      const startedAtMs = init.startedAt;
      const startedAt = new Date(startedAtMs);
      const db = getDb();
      const usageAttribution = mergeUsageAttribution(
        deliveredUsageAttribution,
        {
          billingAccountId: ctx.tenantId,
          correlationId,
          invocationSource: runInvocationSource(
            deliveredUsageAttribution.invocationSource,
          ),
        },
      );
      const traceSink = traceSinkForRun();
      const artifactSink = ctx.artifactSinkFactory?.({
        tenantId: ctx.tenantId,
        runId,
      });
      const terminalArtifactSink =
        artifactSink ?? createFilesystemArtifactSink(runId);

      const logCtx = {
        tenantSlug,
        tenantId: ctx.tenantId,
        runId,
        correlationId,
        agentName: agent.name,
        logPath: init.runLogPath,
      };

      await writeRunLog(logCtx, "INFO", "run.start", {
        agent: agent.name,
        event: event.name,
        subject: subject ?? "—",
      });
      logger.info("run.start", { runId, agent: agent.name, event: event.name });

      // Phase 2 — merge brain-authored declarative tools into the per-step tenant registry so the
      // step-engine resolves them ahead of the global registry. No-op when none are injected.
      const effectiveTenantRegistry =
        ctx.declarativeTools && Object.keys(ctx.declarativeTools).length
          ? {
              ...ctx.tenantRegistry,
              tools: {
                ...(ctx.tenantRegistry?.tools ?? {}),
                ...ctx.declarativeTools,
              },
            }
          : ctx.tenantRegistry;

      // Generated code inside `step.run` can safely use durable DB-backed memory. Durable
      // emit/invoke are orchestrated below via Inngest steps; the removed adapter exposed dead
      // callbacks that only logged or returned null and therefore implied capabilities it did not have.
      const runMemory = createMemoryHandle({
        tenantId: ctx.tenantId,
        agentName: agent.name,
        subject: subject ?? "",
        runId,
      });

      let tokensIn = 0;
      let tokensOut = 0;
      let lastResult: unknown = null;
      // Raw output of every completed action, keyed by manifest `result_key` (the generated
      // plan's stepId). This is the durable in-run dataflow graph; `lastResult` remains only the
      // backwards-compatible adjacent-step view.
      const stepResults: Record<string, unknown> = {};
      // Explicit emit actions and CodeAct handlers can produce more than one intent (especially
      // inside foreach). Preserve declaration order and duplicates; finalization validates every
      // intent against agent.triggered_event before persisting/sending it.
      const emitIntents: EmitIntent[] = [];
      // A continue rule may deliberately suppress the historical implicit
      // `triggered_event[0]` success emit. Explicit emits already produced by
      // prior steps remain durable and are never erased.
      let suppressImplicitEmit = false;
      const applyFailureEmission = (outcome: {
        meta?: Record<string, unknown>;
      }): void => {
        const resolution = failureResolutionFromOutcome(outcome);
        if (!resolution) return;
        if (resolution.suppressEmit) suppressImplicitEmit = true;
        if (!resolution.emitEvent) return;
        const fallbackPayload =
          resolution.defaultResult &&
          typeof resolution.defaultResult === "object" &&
          !Array.isArray(resolution.defaultResult)
            ? (resolution.defaultResult as Record<string, unknown>)
            : { error: resolution.facts };
        emitIntents.push({
          event: resolution.emitEvent,
          payload: { ...fallbackPayload, ...(resolution.emitPayload ?? {}) },
        });
      };
      // #REDESIGN P1b — the REAL model that served this run (last step that reported one), so the run
      // records the actual model instead of a hardcoded "mock-model-v1".
      let runModel: string | null = null;
      let runProvider: string | null = null;
      // Agent Studio v2 structured-output receipts: validity of the final
      // authored output and the exact raw model response for diagnostics.
      let lastOutputValid: boolean | null = null;
      let lastRawResponse: string | undefined;
      let inputValid = !usesV2Definition;
      // ── #RUN-EVIDENCE (D6) — run-level completion evidence ─────────────
      // The ledger is rebuilt on every entry from the MEMOIZED step outcomes,
      // so a replay reconciles against the same calls the first pass recorded.
      const runToolLedger: ToolCallLedgerEntry[] = [];
      // Steps whose actions execute outside the per-call evidence writer, so
      // the ledger structurally cannot speak for their tool activity. Named
      // rather than ignored: silence about a step is not the same as a step
      // that used no tools, and "unknown" must never read as "fine".
      const uncoveredEvidenceSteps: UncoveredStep[] = [];
      // Write-capable tools this agent DECLARED it may call. Derived from the
      // reviewed execution policy and the declared side-effect — never from
      // anything in a tool's name — so a run that claims a write the ledger
      // never recorded is detectable without a hardcoded roster.
      const declaredWriteTools = declaredWriteCapableTools(agent.tool_use);
      // One authority for every per-call evidence write this run performs —
      // the main action loop and every foreach body step persist under the
      // same identity, sinks and declared-write roster.
      const toolCallEvidenceContext: ToolCallEvidenceContext = {
        runId,
        tenantId: ctx.tenantId,
        correlationId,
        tenantSlug,
        agentName: agent.name,
        agentVersionId: init.agentVersionId ?? undefined,
        ontologyActionName: agent.factory_action_name,
        workflowManifestSha256: ctx.productionCodeActWorkflowManifestSha256,
        declaredWriteTools,
        traceSink,
        logCtx,
      };
      // Phase 1a — real branching: a condition step records its boolean here; a downstream
      // action that dependsOn a false condition (or a skipped step) is SKIPPED, not run.
      const gate: GateState = { conditionTrue: {}, skipped: new Set<string>() };
      const ownsTopLevelConditionalEmitRouting =
        hasAuthoritativeConditionalEmit(agent.actions);

      // #P0-4 — compensation: emit the agent's declared compensation_event ONCE on a hard failure
      // (idempotent step id) so a run that failed after side-effects can be undone downstream (the
      // canonical PAYMENT_INITIATED → PAYMENT_CANCELLED case). No-op when compensation_event is unset.
      const emitCompensation = async (reason: string): Promise<void> => {
        const comp = agent.compensation_event;
        if (!comp) return;
        // #W1-2 — NEVER wrap step.* in try/catch: Inngest orchestrates via control-flow exceptions,
        // and swallowing them can corrupt replay. step.sendEvent is durable + idempotent by its id, so
        // Inngest itself retries transient failures. The run log is also required evidence.
        await step.sendEvent(`compensate.${runId}`, {
          name: tenantEventName(
            tenantSlug,
            comp,
            eventAdapter,
          ) as `${string}/${string}`,
          data: withCorrelation(correlationId, {
            subject: subject ?? undefined,
            source_agent: agent.name,
            source_run: runId,
            __compensation: true,
            reason: reason.slice(0, 200),
          }),
        });
        await writeRunLog(logCtx, "WARN", "run.compensate", {
          event: comp,
          reason: reason.slice(0, 200),
        });
      };

      // Agent-level AI runtime settings (always threaded — a legacy manifest
      // may author agent-level provider/model too) + the v2 authoring carrier
      // (ports, output config/bindings, tool_loop, observability) that the
      // step-engine's v2 execution path reads via normalizeAgentForExecution.
      const agentAiSettings = {
        provider: agent.provider,
        model: agent.model,
        task_class: agent.task_class,
        reasoning: agent.reasoning,
        verbosity: agent.verbosity,
        store: agent.store,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
        timeout_s: agent.timeout_s,
        tenantId: ctx.tenantId,
      } as const;
      const agentRecord = agent as unknown as Record<string, unknown>;
      const v2AgentCarrier = usesV2Definition
        ? {
            actor: agentRecord.actor,
            trigger: agentRecord.trigger,
            actions: agentRecord.actions,
            inputs: agentRecord.inputs,
            input_data: agentRecord.input_data as
              | Record<string, unknown>
              | undefined,
            user_prompt_template: agentRecord.user_prompt_template as
              | string
              | undefined,
            outputs: agentRecord.outputs,
            output_config: agentRecord.output_config,
            output_bindings: agentRecord.output_bindings,
            trigger_bindings: agentRecord.trigger_bindings,
            tool_loop: agentRecord.tool_loop as
              | { max_iterations?: number }
              | undefined,
            observability: agentRecord.observability as
              | {
                  trace_level?: "minimal" | "standard" | "debug";
                  reasoning_summary?: boolean;
                  persist_rendered_prompts?: boolean;
                }
              | undefined,
            extensions: agentRecord.extensions,
          }
        : {};

      const factoryInputBindings = (agent.factory_input_bindings ??
        []) as FactoryInputBinding[];
      const factoryToolConfigs = Object.fromEntries(
        (agent.tool_use ?? []).map((entry) => [entry.name, entry.config ?? {}]),
      );
      const initializedBindings = initializeInputBindings(
        factoryInputBindings,
        data,
        {
          toolConfigs: factoryToolConfigs,
          toolProfileRefs: agent.factory_tool_profile_refs ?? {},
          env: process.env,
          eventName: event.name,
        },
      );
      const inputBindingState = initializedBindings.state;
      const boundData = inputBindingState.data;
      const abortForInputBindings = async (
        issues: RuntimeInputBindingIssue[],
      ): Promise<never> => {
        const error = new InputBindingResolutionError(issues);
        await writeRunLog(logCtx, "ERROR", "input.binding-failed", {
          issues: issues.map((entry) => ({
            code: entry.code,
            field: entry.field,
            message: entry.message,
          })),
        });
        await failRun(runId, error.message, startedAt);
        throw error;
      };
      if (initializedBindings.issues.length) {
        await abortForInputBindings(initializedBindings.issues);
      }

      // Agent Studio v2 — bind + validate every named input against its port
      // schema BEFORE any model/tool call. The validated set is exposed to
      // every action as event.data.inputs. Legacy manifests skip this.
      let executionInputs: Record<string, unknown> = boundData;
      if (usesV2Definition) {
        try {
          executionInputs = await step.run("validate-inputs", async () => {
            const bound = bindTriggerInputs(agent, {
              name: bareTenantEventName(tenantSlug, event.name),
              data: boundData,
              subject,
            });
            const validated = validateAgentInputs(agent, bound);
            try {
              await traceSink.append({
                runId,
                kind: "input",
                level: "standard",
                name: "input.validation",
                status: "ok",
                summary: `Validated ${Object.keys(validated.values).length} named input(s)`,
                data: { inputIds: Object.keys(validated.values) },
                visibility: "user",
              });
            } catch (err) {
              logger.warn("input.validation trace failed", {
                err: String(err),
              });
            }
            return validated.values;
          });
          inputValid = true;
        } catch (error) {
          if (error instanceof AgentInputValidationError) {
            try {
              await traceSink.append({
                runId,
                kind: "input",
                level: "minimal",
                name: "input.validation",
                status: "failed",
                summary: "Named input validation failed before execution",
                data: { issues: error.issues },
                visibility: "user",
              });
            } catch {
              // The original validation error is the operator-facing cause.
            }
            await failRun(runId, error.message, startedAt, error.code);
          }
          throw error;
        }
      }

      for (let i = 0; i < agent.actions.length; i++) {
        const action = agent.actions[i]!;
        const ord = i + 1;
        const actionKey =
          (action as { result_key?: string }).result_key ?? action.name;

        // §G4 pause/resume — before each action, a memoized DB read decides
        // whether this run parks. The decision derives ONLY from the read
        // inside step.run (never ambient state), so it is identical on every
        // Inngest replay; the park itself is a durable waitForEvent keyed on
        // this runId. POST /v1/runs/:id/pause flips runs.status to "paused";
        // POST /v1/runs/:id/resume emits `${slug}/run.resume` {runId,subject}.
        const pausedAtGate = await step.run(`pause-check-${ord}`, async () => {
          const statusRow = getDb()
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId))
            .all()[0];
          return statusRow?.status === "paused";
        });
        if (pausedAtGate) {
          await writeRunLog(logCtx, "INFO", "run.pause", {
            ord,
            name: action.name,
          });
          const resumeSignal = await step.waitForEvent(`pause-wait-${ord}`, {
            event: tenantEventName(
              tenantSlug,
              "run.resume",
              eventAdapter,
            ) as `${string}/${string}`,
            if: `async.data.runId == "${runId}"`,
            timeout: "7d",
          });
          if (!resumeSignal) {
            // 7d without a resume: fail closed instead of silently resuming.
            await failRun(
              runId,
              `run paused before action ${ord} (${action.name}) and no resume arrived within 7d`,
              startedAt,
            );
            throw new Error("pause timeout");
          }
          // The resume route already flips paused→running before this wait
          // wakes; the guarded update below makes the engine converge when
          // the row was paused out-of-band (tests, direct DB edits).
          await step.run(`pause-resume-${ord}`, async () => {
            getDb()
              .update(runs)
              .set({ status: "running" })
              .where(and(eq(runs.id, runId), eq(runs.status, "paused")))
              .run();
            return true;
          });
          await writeRunLog(logCtx, "INFO", "run.resume", {
            ord,
            name: action.name,
          });
        }
        const availableStepBindings = resolveAvailableStepOutputBindings(
          inputBindingState,
          factoryInputBindings,
          stepResults,
        );
        if (availableStepBindings.length)
          await abortForInputBindings(availableStepBindings);

        const actionBinding = action.input_binding;
        // v2 agents see the validated named-input set on every action.
        let actionData: Record<string, unknown> = usesV2Definition
          ? { ...boundData, inputs: executionInputs }
          : boundData;
        if (actionBinding?.kind === "object_lookup") {
          const prepared = prepareObjectLookupArguments(
            inputBindingState,
            actionBinding,
          );
          if (!prepared.ok) {
            await abortForInputBindings(prepared.issues);
          } else {
            actionData = { ...boundData, ...prepared.arguments };
          }
        }
        // Scope for stable idempotency-keyed step ids + (later) invoke input resolution.
        const stepScope = {
          event: { name: event.name, data: actionData },
          subject: subject ?? undefined,
          lastResult,
          results: stepResults,
        };

        // Phase 1a — dependsOn gating. Skip (don't fail) an action whose gating condition was
        // false or whose dependency was skipped. Backward-compatible: actions with no depends_on
        // never skip, so existing single-path manifests are unaffected. This
        // dependency gate intentionally comes first: a skipped dependency may
        // own the result referenced by this action's guard, so the guard must
        // not be evaluated against an intentionally absent value.
        let skip = shouldSkip(
          {
            name: actionKey,
            dependsOn: (action as { depends_on?: string[] }).depends_on,
          },
          gate,
        );
        if (!skip.skip) {
          // A condition authored directly on an ordinary action is that
          // action's precondition. Evaluate it only after its dependencies
          // passed, but still before invoke/foreach/manual or any other
          // action-specific orchestration can create an external effect.
          // Standalone `type:"condition"` actions are deliberately excluded;
          // their verdict and explicit branch targets retain the established
          // handling below.
          const precondition = evaluateActionPrecondition(action, {
            ...stepScope,
            input: actionData,
          });
          if (precondition.outcome === "invalid") {
            const reason = `action ${actionKey} has an invalid condition: ${precondition.error}`;
            await failRun(runId, reason, startedAt, "invalid_condition");
            throw new Error(reason);
          }
          if (precondition.outcome === "skip") {
            skip = { skip: true, reason: precondition.reason };
          }
        }
        if (skip.skip) {
          gate.skipped.add(actionKey);
          await step.run(`skip.${ord}.${actionKey}`, async () => {
            const stepId = `stp-${runId.replace(/^run-/, "")}-skip-${ord}`;
            const now = new Date();
            const dbInner = getDb();
            const existing = dbInner
              .select({ id: steps.id })
              .from(steps)
              .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
              .all()[0];
            const persistedStepId = existing?.id ?? stepId;
            if (!existing) {
              dbInner
                .insert(steps)
                .values({
                  id: persistedStepId,
                  runId,
                  ord,
                  name: action.name,
                  type: action.type,
                  status: "skipped",
                  startedAt: now,
                  endedAt: now,
                  durationMs: 0,
                  error: skip.reason,
                })
                .run();
            }
            const inputRef = await writeArtifact(
              runId,
              `step-${ord}-input.json`,
              {
                action,
                action_data: actionData,
                prior_step_results: stepResults,
              },
            );
            const outputRef = await writeArtifact(
              runId,
              `step-${ord}-output.json`,
              { skipped: true, reason: skip.reason },
            );
            await registerStepArtifactEvidence({
              tenantId: ctx.tenantId,
              runId,
              stepId: persistedStepId,
              role: "step_input",
              filePath: inputRef,
              metadata: { source: "manifest_runtime", status: "skipped" },
            });
            await registerStepArtifactEvidence({
              tenantId: ctx.tenantId,
              runId,
              stepId: persistedStepId,
              role: "step_output",
              filePath: outputRef,
              metadata: { source: "manifest_runtime", status: "skipped" },
            });
            dbInner
              .update(steps)
              .set({ inputRef, outputRef })
              .where(eq(steps.id, persistedStepId))
              .run();
            return true;
          });
          await writeRunLog(logCtx, "INFO", "step.skip", {
            ord,
            name: action.name,
            resultKey: actionKey,
            type: action.type,
            reason: skip.reason,
          });
          continue;
        }

        // Phase 1a — synchronous sub-agent invoke (step.invoke). Failure is terminal by default.
        // Soft continuation is accepted only when the manifest explicitly declares on_error:"soft"
        // AND owns a default_result (also enforced at boot).
        if (action.type === "invoke") {
          const a = action as ActionSpec & {
            invoke?: string;
            invoke_input?: Record<string, unknown>;
            forward_last_result?: boolean;
            forward_results?: boolean;
            timeout_s?: number;
            default_result?: unknown;
          };
          const targetRef = a.invoke ?? "";
          const fn = ctx.resolveFunction?.(targetRef);
          const hasSoftFallback =
            a.on_error === "soft" &&
            Object.prototype.hasOwnProperty.call(a, "default_result");
          if (a.on_error === "soft" && !hasSoftFallback) {
            await failRun(
              runId,
              `invoke ${targetRef || "<missing>"} declares soft failure without default_result`,
              startedAt,
            );
            throw new Error(
              `invoke ${targetRef || "<missing>"}: on_error=soft requires default_result`,
            );
          }
          const invokeStableKey = stableStepId(
            action.name,
            (action as { idempotency_key_from?: string }).idempotency_key_from,
            stepScope,
          );
          const invokePayload = materializeInvokePayload({
            eventData: actionData,
            invokeInput: a.invoke_input,
            forwardLastResult: a.forward_last_result,
            forwardResults: a.forward_results,
            lastResult,
            results: stepResults,
            subject,
            correlationId,
          });
          const invokeReceipt = await step.run(
            `invoke.persist.${invokeStableKey}`,
            async () => {
              const dbInner = getDb();
              const existing = dbInner
                .select({ id: steps.id })
                .from(steps)
                .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
                .all()[0];
              const stepId =
                existing?.id ??
                `stp-${runId.replace(/^run-/, "")}-invoke-${ord}`;
              const startedAtMs = Date.now();
              if (existing) {
                dbInner
                  .update(steps)
                  .set({
                    status: "running",
                    startedAt: new Date(startedAtMs),
                    endedAt: null,
                    durationMs: null,
                    error: null,
                  })
                  .where(eq(steps.id, stepId))
                  .run();
              } else {
                dbInner
                  .insert(steps)
                  .values({
                    id: stepId,
                    runId,
                    ord,
                    name: action.name,
                    type: "invoke",
                    status: "running",
                    startedAt: new Date(startedAtMs),
                  })
                  .run();
              }
              const inputRef = await writeArtifact(
                runId,
                `step-${ord}-input.json`,
                { target: targetRef, input: invokePayload },
              );
              await registerStepArtifactEvidence({
                tenantId: ctx.tenantId,
                runId,
                stepId,
                role: "step_input",
                filePath: inputRef,
                metadata: {
                  source: "manifest_runtime",
                  actionName: action.name,
                  actionType: "invoke",
                },
              });
              dbInner
                .update(steps)
                .set({ inputRef })
                .where(eq(steps.id, stepId))
                .run();
              return { stepId, startedAtMs };
            },
          );
          const completeInvoke = async (
            status: "ok" | "failed",
            output: unknown,
            error: string | null,
          ) =>
            step.run(
              `invoke.complete.${invokeStableKey}.${status}`,
              async () => {
                const endedAtMs = Date.now();
                const outputRef = await writeArtifact(
                  runId,
                  `step-${ord}-output.json`,
                  output,
                );
                await registerStepArtifactEvidence({
                  tenantId: ctx.tenantId,
                  runId,
                  stepId: invokeReceipt.stepId,
                  role: "step_output",
                  filePath: outputRef,
                  metadata: {
                    source: "manifest_runtime",
                    actionName: action.name,
                    actionType: "invoke",
                  },
                });
                getDb()
                  .update(steps)
                  .set({
                    status,
                    endedAt: new Date(endedAtMs),
                    durationMs: endedAtMs - invokeReceipt.startedAtMs,
                    error,
                    outputRef,
                  })
                  .where(eq(steps.id, invokeReceipt.stepId))
                  .run();
                return true;
              },
            );
          let invoked: Awaited<ReturnType<typeof softInvoke>>;
          try {
            invoked = await softInvoke(
              async () => {
                if (!fn)
                  throw new Error(
                    `invoke target "${targetRef}" not resolvable`,
                  );
                return await step.invoke(`invoke-${invokeStableKey}`, {
                  function: fn,
                  data: invokePayload,
                  timeout: a.timeout_s ? `${a.timeout_s}s` : undefined,
                });
              },
              {
                timeoutMs: a.timeout_s ? a.timeout_s * 1000 : undefined,
                // Classification happens below. Always rethrow here so a
                // ladder (and legacy soft) observes the original typed error.
                onError: "terminal",
              },
            );
          } catch (failure) {
            await completeInvoke(
              "failed",
              {
                ok: false,
                error:
                  failure instanceof Error ? failure.message : String(failure),
              },
              failure instanceof Error ? failure.message : String(failure),
            );
            const handled = resolveActionFailureOutcome(action, failure);
            applyFailureEmission(handled);
            stepResults[actionKey] = handled.data ?? null;
            lastResult = mergeStepResults(lastResult, handled.data ?? null);
            await writeRunLog(logCtx, "WARN", "step.invoke-continue", {
              ord,
              name: action.name,
              resultKey: actionKey,
              target: targetRef,
              classification:
                failureResolutionFromOutcome(handled)?.policyAction,
            });
            continue;
          }
          await completeInvoke("ok", invoked.data ?? null, null);
          stepResults[actionKey] = invoked.data ?? null;
          lastResult = mergeStepResults(lastResult, invoked.data ?? null);
          await writeRunLog(
            logCtx,
            invoked.softFailed ? "WARN" : "INFO",
            "step.invoke",
            {
              ord,
              name: action.name,
              resultKey: actionKey,
              target: targetRef,
              softFailed: invoked.softFailed,
              timedOut: invoked.timedOut,
            },
          );
          continue;
        }

        if (action.type === "subflow") {
          // #P1-3 — durable subflow FANOUT. Persist the outbound event and a
          // running step receipt before handing it to Inngest, then mark the
          // step complete only after step.sendEvent succeeds. This makes a
          // broker failure visible as a running/retried step instead of a
          // parent run that falsely claims the child was dispatched.
          const a = action as {
            subflow?: string;
            subflow_input?: Record<string, unknown>;
          };
          const target = (a.subflow ?? "").trim();
          if (!target) {
            const reason = `subflow ${actionKey}: no target event declared`;
            await failRun(runId, reason, startedAt);
            await emitCompensation(reason);
            throw new Error(reason);
          }

          const subflowStepKey = stableStepId(
            action.name,
            (action as { idempotency_key_from?: string }).idempotency_key_from,
            stepScope,
          );
          const subflowPayload = withCorrelation(correlationId, {
            ...(a.subflow_input ?? {}),
            ...(lastResult &&
            typeof lastResult === "object" &&
            !Array.isArray(lastResult)
              ? (lastResult as Record<string, unknown>)
              : {}),
            subject: subject ?? undefined,
            source_agent: agent.name,
            source_run: runId,
          });
          const scheduled = await step.run(
            `subflow.persist.${subflowStepKey}`,
            async () => {
              const dbInner = getDb();
              const scheduledAt = Date.now();
              const emittedEventId = `evt-${runId.replace(/^run-/, "")}-sub-${ord}`;
              const stepId = `stp-${runId.replace(/^run-/, "")}-sub-${ord}`;
              const payloadRef = await appendToLedger(tenantSlug, {
                id: emittedEventId,
                name: target,
                subject: subject ?? undefined,
                data: subflowPayload,
                ts: scheduledAt,
              });
              const inputRef = await requireStepEvidence(
                "subflow input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    target,
                    payload: subflowPayload,
                  }),
              );
              const payloadJson = (() => {
                const json = JSON.stringify(subflowPayload);
                return json.length > 200_000
                  ? JSON.stringify({
                      __truncated: true,
                      bytes: json.length,
                      head: json.slice(0, 180_000),
                    })
                  : json;
              })();

              let persistedStepId = stepId;
              dbInner.transaction((tx) => {
                const existingEvent = tx
                  .select({ id: events.id })
                  .from(events)
                  .where(eq(events.id, emittedEventId))
                  .get();
                if (!existingEvent) {
                  tx.insert(events)
                    .values({
                      id: emittedEventId,
                      tenantId: ctx.tenantId,
                      name: target,
                      sourceAgentId: init.agentDbId,
                      subject,
                      payloadRef,
                    })
                    .run();
                  tx.insert(eventStore)
                    .values({
                      id: emittedEventId,
                      tenantId: ctx.tenantId,
                      name: target,
                      subject: subject ?? null,
                      sourceRunId: runId,
                      sourceAgent: agent.name,
                      causationId: triggerEventId ?? null,
                      correlationId,
                      payloadJson,
                    })
                    .run();
                }
                const existingStep = tx
                  .select({ id: steps.id, attempts: steps.attempts })
                  .from(steps)
                  .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
                  .get();
                if (existingStep) {
                  persistedStepId = existingStep.id;
                  tx.update(steps)
                    .set({
                      status: "running",
                      attempts: (existingStep.attempts ?? 1) + 1,
                      startedAt: new Date(scheduledAt),
                      endedAt: null,
                      durationMs: null,
                      error: null,
                      inputRef,
                    })
                    .where(eq(steps.id, existingStep.id))
                    .run();
                } else {
                  tx.insert(steps)
                    .values({
                      id: stepId,
                      runId,
                      ord,
                      name: action.name,
                      type: "subflow",
                      status: "running",
                      startedAt: new Date(scheduledAt),
                      attempts: 1,
                      inputRef,
                    })
                    .run();
                }
              });
              await requireStepEvidence("subflow input artifact catalog", () =>
                registerStepArtifactEvidence({
                  tenantId: ctx.tenantId,
                  runId,
                  stepId: persistedStepId,
                  role: "step_input",
                  filePath: inputRef,
                  metadata: {
                    source: "manifest_runtime",
                    actionName: action.name,
                    actionType: "subflow",
                  },
                }),
              );
              await writeRunLog(logCtx, "INFO", "step.subflow.persisted", {
                ord,
                name: action.name,
                target,
                eventId: emittedEventId,
              });
              try {
                publish({
                  type: "event.emitted",
                  tenantId: ctx.tenantId,
                  at: scheduledAt,
                  eventId: emittedEventId,
                  name: target,
                  subject: subject ?? null,
                  sourceRunId: runId,
                });
                publish({
                  type: "run.step.started",
                  tenantId: ctx.tenantId,
                  at: scheduledAt,
                  runId,
                  stepId: persistedStepId,
                  ord,
                  name: action.name,
                  stepType: "subflow",
                });
              } catch {
                /* live delivery is best-effort; durable rows are authoritative */
              }
              return { emittedEventId, stepId: persistedStepId, scheduledAt };
            },
          );

          const wireData = eventAdapter.outbound({
            eventId: scheduled.emittedEventId,
            eventName: target,
            payload: subflowPayload,
            subject,
            correlationId,
            sourceAgent: agent.name,
            emittedAt: new Date(scheduled.scheduledAt).toISOString(),
          });
          await step.sendEvent(`subflow.send.${scheduled.emittedEventId}`, {
            name: tenantEventName(
              tenantSlug,
              target,
              eventAdapter,
            ) as `${string}/${string}`,
            data: wireData,
          });

          await step.run(`subflow.complete.${subflowStepKey}`, async () => {
            const completedAt = Date.now();
            const output = {
              emittedEventId: scheduled.emittedEventId,
              target,
              dispatched: true,
            };
            const outputRef = await requireStepEvidence(
              "subflow output artifact",
              () => writeArtifact(runId, `step-${ord}-output.json`, output),
            );
            await requireStepEvidence("subflow output artifact catalog", () =>
              registerStepArtifactEvidence({
                tenantId: ctx.tenantId,
                runId,
                stepId: scheduled.stepId,
                role: "step_output",
                filePath: outputRef,
                metadata: {
                  source: "manifest_runtime",
                  actionName: action.name,
                  actionType: "subflow",
                },
              }),
            );
            await requireStepEvidence("subflow completion row", () =>
              getDb()
                .update(steps)
                .set({
                  status: "ok",
                  endedAt: new Date(completedAt),
                  durationMs: completedAt - scheduled.scheduledAt,
                  outputRef,
                })
                .where(eq(steps.id, scheduled.stepId))
                .run(),
            );
            await writeRunLog(logCtx, "INFO", "step.subflow", {
              ord,
              name: action.name,
              target,
              eventId: scheduled.emittedEventId,
            });
            try {
              publish({
                type: "run.step.completed",
                tenantId: ctx.tenantId,
                at: completedAt,
                runId,
                stepId: scheduled.stepId,
                ord,
                name: action.name,
                stepType: "subflow",
                status: "ok",
                durationMs: completedAt - scheduled.scheduledAt,
                provider: null,
                model: null,
                tokensIn: null,
                tokensOut: null,
                error: null,
              });
            } catch {
              /* live delivery is best-effort; durable rows are authoritative */
            }
            return output;
          });
          stepResults[actionKey] = {
            emittedEventId: scheduled.emittedEventId,
            target,
            dispatched: true,
          };
          continue;
        }

        if (action.type === "delay") {
          // A delay is orchestration state, not in-process work. Persist the
          // running step first, let Inngest own the timer, and only then mark
          // completion. setTimeout inside step.run would hold a worker and
          // could be replayed after a crash.
          const delayMs = (action as { delay_ms?: number }).delay_ms;
          if (!(typeof delayMs === "number" && delayMs > 0)) {
            const reason = `delay ${actionKey}: delay_ms must be greater than zero`;
            await failRun(runId, reason, startedAt);
            await emitCompensation(reason);
            throw new Error(reason);
          }
          const delayStepKey = stableStepId(
            action.name,
            (action as { idempotency_key_from?: string }).idempotency_key_from,
            stepScope,
          );
          const scheduled = await step.run(
            `delay.schedule.${delayStepKey}`,
            async () => {
              const dbInner = getDb();
              const scheduledAt = Date.now();
              const proposedStepId = `stp-${runId.replace(/^run-/, "")}-delay-${ord}`;
              const inputRef = await requireStepEvidence(
                "delay input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    delay_ms: delayMs,
                  }),
              );
              const existing = dbInner
                .select({ id: steps.id, attempts: steps.attempts })
                .from(steps)
                .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
                .get();
              const stepId = existing?.id ?? proposedStepId;
              if (existing) {
                dbInner
                  .update(steps)
                  .set({
                    status: "running",
                    attempts: (existing.attempts ?? 1) + 1,
                    startedAt: new Date(scheduledAt),
                    endedAt: null,
                    durationMs: null,
                    error: null,
                    inputRef,
                  })
                  .where(eq(steps.id, stepId))
                  .run();
              } else {
                dbInner
                  .insert(steps)
                  .values({
                    id: stepId,
                    runId,
                    ord,
                    name: action.name,
                    type: "delay",
                    status: "running",
                    startedAt: new Date(scheduledAt),
                    attempts: 1,
                    inputRef,
                  })
                  .run();
              }
              await requireStepEvidence("delay input artifact catalog", () =>
                registerStepArtifactEvidence({
                  tenantId: ctx.tenantId,
                  runId,
                  stepId,
                  role: "step_input",
                  filePath: inputRef,
                  metadata: {
                    source: "manifest_runtime",
                    actionName: action.name,
                    actionType: "delay",
                  },
                }),
              );
              await writeRunLog(logCtx, "INFO", "step.delay.scheduled", {
                ord,
                name: action.name,
                delayMs,
              });
              try {
                publish({
                  type: "run.step.started",
                  tenantId: ctx.tenantId,
                  at: scheduledAt,
                  runId,
                  stepId,
                  ord,
                  name: action.name,
                  stepType: "delay",
                });
              } catch {
                /* live delivery is best-effort; durable rows are authoritative */
              }
              return { stepId, scheduledAt };
            },
          );

          await step.sleep(`delay.wait.${delayStepKey}`, delayMs);

          const delayResult = await step.run(
            `delay.complete.${delayStepKey}`,
            async () => {
              const completedAt = Date.now();
              const output = { delay_ms: delayMs, sleptMs: delayMs };
              const outputRef = await requireStepEvidence(
                "delay output artifact",
                () => writeArtifact(runId, `step-${ord}-output.json`, output),
              );
              await requireStepEvidence("delay output artifact catalog", () =>
                registerStepArtifactEvidence({
                  tenantId: ctx.tenantId,
                  runId,
                  stepId: scheduled.stepId,
                  role: "step_output",
                  filePath: outputRef,
                  metadata: {
                    source: "manifest_runtime",
                    actionName: action.name,
                    actionType: "delay",
                  },
                }),
              );
              await requireStepEvidence("delay completion row", () =>
                getDb()
                  .update(steps)
                  .set({
                    status: "ok",
                    endedAt: new Date(completedAt),
                    durationMs: completedAt - scheduled.scheduledAt,
                    outputRef,
                  })
                  .where(eq(steps.id, scheduled.stepId))
                  .run(),
              );
              await writeRunLog(logCtx, "INFO", "step.ok", {
                name: action.name,
                type: "delay",
                duration: completedAt - scheduled.scheduledAt + "ms",
              });
              try {
                publish({
                  type: "run.step.completed",
                  tenantId: ctx.tenantId,
                  at: completedAt,
                  runId,
                  stepId: scheduled.stepId,
                  ord,
                  name: action.name,
                  stepType: "delay",
                  status: "ok",
                  durationMs: completedAt - scheduled.scheduledAt,
                  provider: null,
                  model: null,
                  tokensIn: null,
                  tokensOut: null,
                  error: null,
                });
              } catch {
                /* live delivery is best-effort; durable rows are authoritative */
              }
              return output;
            },
          );
          stepResults[actionKey] = delayResult;
          lastResult = mergeStepResults(lastResult, delayResult);
          continue;
        }

        if (action.type === "foreach") {
          const foreachStepKey = stableStepId(
            action.name,
            (action as { idempotency_key_from?: string }).idempotency_key_from,
            stepScope,
          );
          const foreachReceipt = await step.run(
            `foreach.persist.${foreachStepKey}`,
            async () => {
              const dbInner = getDb();
              const existing = dbInner
                .select({ id: steps.id })
                .from(steps)
                .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
                .all()[0];
              const stepId =
                existing?.id ??
                `stp-${runId.replace(/^run-/, "")}-foreach-${ord}`;
              const startedAtMs = Date.now();
              if (existing) {
                dbInner
                  .update(steps)
                  .set({
                    status: "running",
                    startedAt: new Date(startedAtMs),
                    endedAt: null,
                    durationMs: null,
                    error: null,
                  })
                  .where(eq(steps.id, stepId))
                  .run();
              } else {
                dbInner
                  .insert(steps)
                  .values({
                    id: stepId,
                    runId,
                    ord,
                    name: action.name,
                    type: "foreach",
                    status: "running",
                    startedAt: new Date(startedAtMs),
                  })
                  .run();
              }
              // #RUN-EVIDENCE — the container's own writes carry the same
              // fail-closed discipline as every main-loop counterpart. A
              // foreach whose initiating record cannot persist must fail as a
              // labelled evidence failure, never proceed (or soften) silently.
              const inputRef = await requireStepEvidence(
                "foreach input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    action,
                    action_data: actionData,
                    last_result: lastResult,
                    prior_step_results: stepResults,
                  }),
              );
              await requireStepEvidence("foreach input artifact catalog", () =>
                registerStepArtifactEvidence({
                  tenantId: ctx.tenantId,
                  runId,
                  stepId,
                  role: "step_input",
                  filePath: inputRef,
                  metadata: {
                    source: "manifest_runtime",
                    actionName: action.name,
                    actionType: "foreach",
                  },
                }),
              );
              await requireStepEvidence("foreach input artifact reference", () =>
                dbInner
                  .update(steps)
                  .set({ inputRef })
                  .where(eq(steps.id, stepId))
                  .run(),
              );
              return { stepId, startedAtMs };
            },
          );
          const completeForeach = async (
            status: "ok" | "failed",
            output: unknown,
            error: string | null,
          ) =>
            step.run(
              `foreach.complete.${foreachStepKey}.${status}`,
              async () => {
                const endedAtMs = Date.now();
                // #RUN-EVIDENCE — fail closed, like the main loop's output
                // artifact/terminal-status writes. Especially load-bearing on
                // the "failed" leg: a bare throw here would be caught by the
                // container's failure classifier and could be softened by an
                // on_error policy — a run continuing with no record of the
                // fan-out that just ran.
                const outputRef = await requireStepEvidence(
                  "foreach output artifact",
                  () => writeArtifact(runId, `step-${ord}-output.json`, output),
                );
                await requireStepEvidence(
                  "foreach output artifact catalog",
                  () =>
                    registerStepArtifactEvidence({
                      tenantId: ctx.tenantId,
                      runId,
                      stepId: foreachReceipt.stepId,
                      role: "step_output",
                      filePath: outputRef,
                      metadata: {
                        source: "manifest_runtime",
                        actionName: action.name,
                        actionType: "foreach",
                      },
                    }),
                );
                await requireStepEvidence("foreach completion row", () =>
                  getDb()
                    .update(steps)
                    .set({
                      status,
                      endedAt: new Date(endedAtMs),
                      durationMs: endedAtMs - foreachReceipt.startedAtMs,
                      error,
                      outputRef,
                    })
                    .where(eq(steps.id, foreachReceipt.stepId))
                    .run(),
                );
                return true;
              },
            );
          try {
            const a = action as typeof action & {
              items_from?: string;
              item_as?: string;
              item_key_from?: string;
              foreach_actions?: typeof agent.actions;
              timeout_s?: number;
            };
            const foreachActions = a.foreach_actions ?? [];
            const ownsConditionalEmitRouting =
              hasAuthoritativeConditionalEmit(foreachActions);
            // A foreach timeout is one wall-clock budget for the entire fan-out,
            // not a fresh budget per item. Each body run receives this absolute
            // deadline; its own timeout_s can only shorten it.
            const foreachDeadlineAt = a.timeout_s
              ? Date.now() + a.timeout_s * 1000
              : undefined;
            const collection = resolveConditionPath(
              {
                lastResult,
                results: stepResults,
                event: { name: event.name, data: boundData },
                input: boundData,
              },
              a.items_from ?? "",
            );
            if (!collection.valid || !Array.isArray(collection.value)) {
              const reason = `foreach ${actionKey}: items_from "${a.items_from ?? ""}" did not resolve to an array`;
              throw new Error(reason);
            }
            const materialized = materializeForeach({
              items: collection.value,
              itemAs: a.item_as,
              itemKeyFrom: a.item_key_from ?? "",
            });
            if (!materialized.ok) {
              const reason = `foreach ${actionKey}: ${materialized.error}`;
              throw new Error(reason);
            }

            const foreachFailure: {
              current: { stepId: string; data: unknown } | null;
            } = { current: null };
            // #RUN-EVIDENCE (D6) — every foreach body action that dispatches
            // tools passes through the SAME per-call evidence writer as
            // top-level actions, INSIDE its own durable step so Inngest
            // memoization keeps the writes exactly-once across replays. The
            // memoized child return value carries the projected ledger
            // entries; the container folds them into the run ledger below.
            // Evidence artifacts are catalogued under the container's step
            // row (children own no `steps` row) with an item-unique name.
            const runChildDurable = (
              childStepId: string,
              childName: string,
              operation: () => Promise<StepOutput>,
            ): Promise<StepOutput> =>
              step.run(childStepId, async () => {
                const output = await operation();
                const childToolCalls = capturedToolCalls(output.meta);
                // Children own no steps row, so the attempt is derived from
                // the durable evidence catalog itself (any prior record for
                // this child ⇒ this execution is a retry). Computed inside
                // the durable body — a memoized replay never re-enters here —
                // and only when there is evidence to write, so tool-less
                // children (condition/logic) cost no catalog scan.
                const attempt = childToolCalls.length
                  ? nextForeachChildEvidenceAttempt({
                      runId,
                      containerStepId: foreachReceipt.stepId,
                      childStepId,
                    })
                  : 1;
                const childLedger = await persistToolCallEvidence({
                  context: toolCallEvidenceContext,
                  toolCalls: childToolCalls,
                  stepRowId: foreachReceipt.stepId,
                  stepName: childName,
                  evidenceName: (callIndex) =>
                    foreachToolCallEvidenceName(
                      ord,
                      childStepId,
                      callIndex,
                      attempt,
                    ),
                  attempt,
                  artifactMetadata: { foreachChildStepId: childStepId },
                });
                return childLedger.length
                  ? {
                      ...output,
                      toolLedger: [...(output.toolLedger ?? []), ...childLedger],
                    }
                  : output;
              }) as Promise<StepOutput>;
            const durableActionRuntime = {
              run: (
                stepId: string,
                operation: () => Promise<StepOutput>,
                label?: { actionName?: string },
              ) => runChildDurable(stepId, label?.actionName ?? stepId, operation),
              invoke: async (request: {
                stepId: string;
                target: string;
                input: Record<string, unknown>;
                timeoutMs?: number;
              }): Promise<unknown> => {
                const fn = ctx.resolveFunction?.(request.target);
                if (!fn) {
                  throw new Error(
                    `invoke target "${request.target}" not resolvable`,
                  );
                }
                return step.invoke(`invoke-${request.stepId}`, {
                  function: fn,
                  data: request.input,
                  timeout: request.timeoutMs
                    ? `${Math.max(1, Math.ceil(request.timeoutMs / 1000))}s`
                    : undefined,
                });
              },
            };
            const receipts = await runSequentialForeach(
              materialized.frames,
              async (frame) => {
                if (foreachFailure.current) {
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
                const childStepIds: string[] = [];
                // Item-local count: an emit from a prior item cannot satisfy
                // this item's authoritative conditional route.
                const emitCountBefore = emitIntents.length;
                for (const child of foreachActions) {
                  const childKey = child.result_key ?? child.name;
                  const childStepId = foreachStepId(actionKey, frame, childKey);
                  childStepIds.push(childStepId);
                  const childSkip = shouldSkip(
                    { name: childKey, dependsOn: child.depends_on },
                    localGate,
                  );
                  if (childSkip.skip) {
                    localGate.skipped.add(childKey);
                    localResults[childKey] = {
                      skipped: true,
                      reason: childSkip.reason,
                    };
                    continue;
                  }

                  const childEventData = {
                    ...boundData,
                    ...frame.locals,
                    _foreach: {
                      parentStepId: actionKey,
                      index: frame.index,
                      key: frame.businessKey,
                      stableKey: frame.stableKey,
                    },
                  };
                  const childPrecondition = evaluateActionPrecondition(child, {
                    lastResult: localLast,
                    results: { ...stepResults, ...localResults },
                    event: { name: event.name, data: childEventData },
                    input: childEventData,
                    locals: frame.locals,
                  });
                  if (childPrecondition.outcome === "invalid") {
                    throw new Error(
                      `foreach ${actionKey} body action ${childKey} has an invalid condition: ${childPrecondition.error}`,
                    );
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

                  // Leaf item/body pairs are their own durable Inngest steps.
                  // A nested foreach is a container (its descendants own the
                  // durable steps), while invoke delegates directly to
                  // step.invoke; neither may be nested inside step.run.
                  const runChild = async (): Promise<StepOutput> => {
                    try {
                      const output = await runAction({
                        ctx: {
                          agentName: agent.name,
                          actionName: child.name,
                          ontologyActionName: agent.factory_action_name,
                          subject: subject ?? undefined,
                          correlationId,
                          runId,
                          tenantSlug,
                          tenantId: ctx.tenantId,
                          event: {
                            name: event.name,
                            data: childEventData,
                          },
                          lastResult: localLast,
                          results: { ...stepResults, ...localResults },
                          locals: frame.locals,
                          memory: runMemory,
                        },
                        action: child,
                        agent: {
                          id: agent.id,
                          name: agent.name,
                          description: agent.description,
                          ontology_instructions: agent.ontology_instructions,
                          generated: (agent as { generated?: boolean })
                            .generated,
                          factoryDomainId: agent.factory_domain_id,
                          factoryExecutionScope: agent.factory_execution_scope,
                          factoryToolProfileRefs:
                            agent.factory_tool_profile_refs,
                          factoryToolReplayRefs: agent.factory_tool_replay_refs,
                          // #RULE-GATE — server-authored corpus + ontology-derived tool
                          // bindings. Not sourced from the manifest by design.
                          ontologyRules: ctx.ontologyRules,
                          ontologyRuleBindings: ctx.ontologyRuleBindings,
                          factoryToolProbeState: ctx.factoryToolProbeState,
                          codeExecuted: (agent as { codeExecuted?: boolean })
                            .codeExecuted,
                          typescriptCode: agent.typescript_code,
                          codeAttestation: agent.code_attestation,
                          factoryPromotionVersionId:
                            agent.factory_promotion_version_id,
                          factoryRegressionSuiteFingerprint:
                            agent.factory_regression_suite_fingerprint,
                          productionCodeActCapability:
                            ctx.productionCodeActCapability,
                          productionCodeActManifestSha256:
                            ctx.productionCodeActManifestSha256,
                          productionCodeActWorkflowManifestSha256:
                            ctx.productionCodeActWorkflowManifestSha256,
                          ...agentAiSettings,
                          ...v2AgentCarrier,
                          triggeredEvents: agent.triggered_event,
                          tool_use: Array.isArray(agent.tool_use)
                            ? (agent.tool_use as Array<{
                                name: string;
                                description?: string;
                                input_schema?: unknown;
                              }>)
                            : undefined,
                        },
                        tenantRegistry: effectiveTenantRegistry,
                        autoResolveManual: true,
                        memory: runMemory,
                        trace: traceSink,
                        usageAttribution,
                        deadlineAt: foreachDeadlineAt,
                        durableStepId: childStepId,
                        durableActionRuntime,
                      });
                      const codeReceipt = codeActExecutionReceiptFromMeta(
                        output.meta,
                      );
                      if (codeReceipt) {
                        await requireStepEvidence(
                          "foreach CodeAct run receipt",
                          () =>
                            db
                              .update(runs)
                              .set(codeActReceiptFields(codeReceipt))
                              .where(eq(runs.id, runId))
                              .run(),
                        );
                        await requireStepEvidence(
                          "foreach CodeAct receipt log",
                          () =>
                            writeRunLog(
                              logCtx,
                              codeReceipt.codeRan ? "INFO" : "WARN",
                              "codeact.receipt",
                              {
                                step: child.name,
                                step_id: childStepId,
                                ...codeActReceiptFields(codeReceipt),
                                duration_ms: codeReceipt.durationMs,
                              },
                            ),
                        );
                      }
                      // An enclosing foreach deadline is authoritative. A child
                      // soft policy cannot convert expiration of the parent
                      // budget into a success and continue later items.
                      if (
                        !output.ok &&
                        (
                          output.meta as
                            | { deadlineSource?: unknown }
                            | undefined
                        )?.deadlineSource === "parent_deadline"
                      ) {
                        return output;
                      }
                      if (output.ok) return output;
                      const handled = resolveActionFailureOutcome(
                        child,
                        new ActionReturnedFailure(child.name, output),
                        {
                          tokensIn: output.tokensIn ?? 0,
                          tokensOut: output.tokensOut ?? 0,
                          meta: output.meta,
                          // A soft-failed nested container's leaves already
                          // persisted their evidence; the policy must not
                          // erase the record of the very calls that failed.
                          ...(output.toolLedger
                            ? { toolLedger: output.toolLedger }
                            : {}),
                        },
                      );
                      return { ...handled, type: child.type };
                    } catch (failure) {
                      // Recognizer, not instanceof: after an Inngest
                      // retry/memoization round-trip only the error NAME
                      // survives, and an evidence failure must still refuse
                      // the on_error classifier below.
                      if (isRequiredStepEvidenceFailure(failure))
                        throw failure;
                      return {
                        ...resolveActionFailureOutcome(child, failure),
                        type: child.type,
                      };
                    }
                  };
                  const bodyResult =
                    child.type === "foreach" || child.type === "invoke"
                      ? await runChild()
                      : await runChildDurable(childStepId, child.name, runChild);

                  tokensIn += bodyResult.tokensIn ?? 0;
                  tokensOut += bodyResult.tokensOut ?? 0;
                  // #RUN-EVIDENCE (D6) — fold the child's persisted per-call
                  // records into the run ledger. `bodyResult` is (or is
                  // derived from) memoized durable-step returns, so a replay
                  // rebuilds the identical entries. Collected BEFORE the
                  // ok-check: a failed child's dispatched calls happened.
                  if (Array.isArray(bodyResult.toolLedger)) {
                    runToolLedger.push(...bodyResult.toolLedger);
                  }
                  // Mirror of the main loop's uncovered-step check: a foreach
                  // CodeAct child's bridge dispatches surface only as
                  // meta.codeToolDispatches (no per-call audit record exists
                  // for them), so folding toolLedger alone would let this run
                  // read as fully evidenced. Declared, never fabricated — and
                  // only when the bridge actually saw dispatches.
                  const childCodeDispatches = (
                    bodyResult.meta as
                      | { codeToolDispatches?: unknown }
                      | undefined
                  )?.codeToolDispatches;
                  if (
                    Array.isArray(childCodeDispatches) &&
                    childCodeDispatches.length > 0
                  ) {
                    uncoveredEvidenceSteps.push({
                      ord,
                      name: child.name,
                      type: child.type,
                      reason: "generated_code_dispatch_not_recorded",
                    });
                  }
                  if (bodyResult.model) runModel = bodyResult.model;
                  const emitted = (
                    bodyResult.meta as { emitted?: EmitIntent[] } | undefined
                  )?.emitted;
                  if (Array.isArray(emitted)) emitIntents.push(...emitted);
                  if (
                    (
                      bodyResult.meta as
                        | { suppressImplicitEmit?: unknown }
                        | undefined
                    )?.suppressImplicitEmit === true
                  ) {
                    suppressImplicitEmit = true;
                  }
                  applyFailureEmission(bodyResult);

                  if (!bodyResult.ok) {
                    foreachFailure.current = {
                      stepId: childStepId,
                      data: bodyResult.data,
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
                  !foreachFailure.current &&
                  ownsConditionalEmitRouting &&
                  emitIntents.length === emitCountBefore
                ) {
                  throw Object.assign(
                    new Error(
                      `[park] foreach ${actionKey}: no authoritative conditional emit guard matched`,
                    ),
                    { code: "CONDITIONAL_EMIT_NO_MATCH" },
                  );
                }
                return {
                  index: frame.index,
                  key: frame.businessKey,
                  stableKey: frame.stableKey,
                  item: frame.item,
                  stepIds: childStepIds,
                  results: localResults,
                  lastResult: localLast,
                };
              },
            );

            if (foreachFailure.current) {
              const reason = `foreach ${actionKey} body step ${foreachFailure.current.stepId} failed`;
              throw new Error(reason);
            }
            const aggregate = {
              count: receipts.length,
              items: receipts,
              byKey: Object.fromEntries(
                receipts.map((receipt) => [receipt.stableKey, receipt]),
              ),
            };
            stepResults[actionKey] = aggregate;
            lastResult = mergeStepResults(lastResult, aggregate);
            // #RUN-EVIDENCE (D6) — foreach bodies are no longer an uncovered
            // coverage hole: every body step ran through `runChildDurable`,
            // whose per-call records were folded into `runToolLedger` above.
            // N dispatched ⇒ N reported now includes foreach children.
            await completeForeach("ok", aggregate, null);
            await writeRunLog(logCtx, "INFO", "step.foreach", {
              ord,
              name: action.name,
              resultKey: actionKey,
              count: receipts.length,
              mode: "sequential",
            });
            continue;
          } catch (failure) {
            // Recognizer, not instanceof — see the child carve-out above.
            if (isRequiredStepEvidenceFailure(failure)) throw failure;
            if (
              (failure as { code?: unknown } | null)?.code ===
              "CONDITIONAL_EMIT_NO_MATCH"
            ) {
              await failRun(
                runId,
                failure instanceof Error ? failure.message : String(failure),
                startedAt,
                "conditional_emit_no_match",
              );
            }
            await completeForeach(
              "failed",
              {
                ok: false,
                error:
                  failure instanceof Error ? failure.message : String(failure),
              },
              failure instanceof Error ? failure.message : String(failure),
            );
            const handled = resolveForeachContainerFailure(action, failure);
            applyFailureEmission(handled);
            // A foreach that failed mid-fan-out already folded every body step
            // that RAN into `runToolLedger` (collection happens before the
            // ok-check in the item loop); a body step that threw before
            // returning recorded nothing — exactly like a top-level action
            // that threw. No blanket coverage gap remains to declare.
            stepResults[actionKey] = handled.data ?? null;
            lastResult = mergeStepResults(lastResult, handled.data ?? null);
            await writeRunLog(logCtx, "WARN", "step.foreach-continue", {
              ord,
              name: action.name,
              resultKey: actionKey,
              classification:
                failureResolutionFromOutcome(handled)?.policyAction,
            });
            continue;
          }
        }

        if (action.type === "manual") {
          // Human-in-the-loop step (DESIGN.md §10):
          //   1) create task row inside step.run (memoized)
          //   2) waitForEvent("task.resolved") with matched taskId
          //   3) close step row with resolution
          const initStep = await step.run(`init-task-${ord}`, async () => {
            const sid = makeId("stp");
            const tid = makeId("tsk");
            const resumeMarker = `hitl:${ctx.tenantId}:${runId}:${tid}`;
            const sStarted = Date.now();
            const dbInner = getDb();
            // The task, its exact wait step, and the owning run's waiting
            // state form one recovery unit. A crash cannot leave an open task
            // whose parked step/origin cannot be identified.
            dbInner.transaction((tx) => {
              tx.insert(steps)
                .values({
                  id: sid,
                  runId,
                  ord,
                  name: action.name,
                  // invoke steps never reach an insert (handled+continue'd above); cast to the
                  // steps.type column union which predates the "invoke" member.
                  type: action.type as
                    | "tool"
                    | "logic"
                    | "manual"
                    | "condition"
                    | "delay"
                    | "subflow",
                  status: "running",
                  startedAt: new Date(sStarted),
                })
                .run();
              tx.insert(tasksTable)
                .values({
                  id: tid,
                  tenantId: ctx.tenantId,
                  runId,
                  originEventId: triggerEventId,
                  originEventName: event.name ?? null,
                  waitStepId: sid,
                  resumeMarker,
                  resumeState: "pending",
                  type: action.task_type ?? action.name,
                  title: `${agent.title ?? agent.name} · ${action.name}`,
                  awaitingRole: action.awaiting_role ?? "operator",
                  priority: "medium",
                  status: "open",
                  // A preceding logic/tool step often prepares the decision
                  // brief. Persist it (plus the authored operator form
                  // contract) so the operator sees the evidence that caused
                  // the HITL checkpoint.
                  payloadJson: {
                    ...buildManualTaskPayload({
                      agent,
                      action,
                      subject,
                      preparedContext: lastResult,
                    }),
                    ...(actionBinding?.kind === "human_input"
                      ? {
                          inputBinding: {
                            kind: "human_input",
                            field: actionBinding.field,
                            type: actionBinding.type,
                            required: actionBinding.required,
                            prompt: actionBinding.prompt,
                          },
                        }
                      : {}),
                  } as never,
                } as never)
                .run();
              tx.update(runs)
                .set({ status: "waiting" })
                .where(and(eq(runs.id, runId), eq(runs.status, "running")))
                .run();
            });
            try {
              publish({
                type: "run.step.started",
                tenantId: ctx.tenantId,
                at: sStarted,
                runId,
                stepId: sid,
                ord,
                name: action.name,
                stepType: action.type,
              });
              publish({
                type: "task.created",
                tenantId: ctx.tenantId,
                at: sStarted,
                taskId: tid,
                runId,
                taskType: action.task_type ?? action.name,
                title: `${agent.title ?? agent.name} · ${action.name}`,
              });
            } catch {
              /* live delivery is best-effort */
            }
            return { stepId: sid, taskId: tid, resumeMarker, sStarted };
          });
          await step.run(`evidence-task-${ord}`, async () => {
            const inputRef = await writeArtifact(
              runId,
              `step-${ord}-input.json`,
              {
                action,
                task_id: initStep.taskId,
                subject,
                prepared_context: lastResult,
                input_binding: actionBinding ?? null,
              },
            );
            await registerStepArtifactEvidence({
              tenantId: ctx.tenantId,
              runId,
              stepId: initStep.stepId,
              role: "step_input",
              filePath: inputRef,
              metadata: {
                source: "manifest_runtime",
                actionName: action.name,
                actionType: "manual",
              },
            });
            getDb()
              .update(steps)
              .set({ inputRef })
              .where(eq(steps.id, initStep.stepId))
              .run();
            return inputRef;
          });

          await writeRunLog(logCtx, "INFO", "step.wait", {
            ord,
            name: action.name,
            taskId: initStep.taskId,
            awaiting: "human",
          });

          // P5-TEN-01 — pin the predicate to the issuing tenant so a leaked
          // taskId in another tenant cannot resume this run. tasks.ts:resolve
          // now includes auth.tenantId in the event payload.
          // Per-tenant app: HITL resume and the resolve route both project
          // `task.resolved` through the same committed TenantEventAdapter.
          // Ordinary tenants therefore use `${slug}/task.resolved`; a tenant
          // that owns a legacy bus may intentionally use another wire name.
          // The tenantId predicate stays as defense-in-depth.
          const resolved = await step.waitForEvent(`wait-task-${ord}`, {
            event: tenantEventName(
              tenantSlug,
              "task.resolved",
              eventAdapter,
            ) as `${string}/${string}`,
            if: `async.data.taskId == "${initStep.taskId}" && async.data.tenantId == "${ctx.tenantId}" && async.data.resumeMarker == "${initStep.resumeMarker}"`,
            timeout: "7d",
          });

          if (!resolved) {
            // Timeout — mark task + step + run as failed.
            await step.run(`timeout-task-${ord}`, async () => {
              const dbInner = getDb();
              dbInner
                .update(steps)
                .set({
                  status: "failed",
                  error: "task timeout",
                  endedAt: new Date(),
                })
                .where(eq(steps.id, initStep.stepId))
                .run();
              dbInner
                .update(tasksTable)
                .set({
                  status: "failed",
                  resumeState: "failed",
                  resumeError: "task_wait_timeout",
                })
                .where(eq(tasksTable.id, initStep.taskId))
                .run();
            });
            await failRun(
              runId,
              `task ${initStep.taskId} timed out`,
              startedAt,
            );
            throw new Error("task timeout");
          }

          const resolution = (resolved.data ?? {}) as {
            taskId: string;
            decision?: string;
            payload?: unknown;
            resumeMarker?: string;
            actorUserId?: string | null;
          };
          // Canonical manual-decision envelope (v2 contract). Unknown decision
          // values from the transport degrade to "approve" (historical
          // behavior) instead of poisoning the durable resume with a throw.
          const manualDecision: ManualTaskDecision =
            resolution.decision === "reject" ||
            resolution.decision === "supplement"
              ? resolution.decision
              : "approve";
          const manualResolutionEnvelope = buildManualTaskResolution({
            taskId: initStep.taskId,
            decision: manualDecision,
            payload: resolution.payload,
          });

          if (
            resolution.decision !== "reject" &&
            actionBinding?.kind === "human_input"
          ) {
            const humanIssues = applyHumanInputResult(
              inputBindingState,
              actionBinding,
              resolution.payload,
            );
            if (humanIssues.length) {
              await step.run(`invalid-task-input-${ord}`, async () => {
                const failedAt = new Date();
                const dbInner = getDb();
                dbInner.transaction((tx) => {
                  tx.update(steps)
                    .set({
                      status: "failed",
                      error: humanIssues
                        .map((entry) => entry.message)
                        .join("; "),
                      endedAt: failedAt,
                    })
                    .where(eq(steps.id, initStep.stepId))
                    .run();
                  tx.update(tasksTable)
                    .set({
                      status: "failed",
                      resolvedAt: failedAt,
                      resolvedBy: resolution.actorUserId ?? null,
                      resolutionJson: resolution as never,
                      resumeState: "failed",
                      resumeError: "invalid_human_input",
                    })
                    .where(eq(tasksTable.id, initStep.taskId))
                    .run();
                });
              });
              await abortForInputBindings(humanIssues);
            }
          }

          await step.run(`close-task-${ord}`, async () => {
            const dbInner = getDb();
            const sEnded = Date.now();
            // v2 (Studio) semantics: a human rejection is a valid domain
            // outcome — the durable step completed successfully and the
            // resolution envelope flows through output validation and
            // authored emissions. Legacy manifests keep reject=failed.
            const stepStatus =
              manualDecision === "reject" && !usesV2Definition
                ? "failed"
                : "ok";
            const outputRef = await writeArtifact(
              runId,
              `step-${ord}-output.json`,
              {
                ...manualResolutionEnvelope,
                payload: resolution.payload ?? null,
                actor_user_id: resolution.actorUserId ?? null,
              },
            );
            await registerStepArtifactEvidence({
              tenantId: ctx.tenantId,
              runId,
              stepId: initStep.stepId,
              role: "step_output",
              filePath: outputRef,
              metadata: {
                source: "manifest_runtime",
                actionName: action.name,
                actionType: "manual",
              },
            });
            dbInner.transaction((tx) => {
              const taskUpdate = tx
                .update(tasksTable)
                .set({
                  status: "resolved",
                  resolvedAt: new Date(sEnded),
                  resolvedBy: resolution.actorUserId ?? null,
                  resolutionJson: {
                    ...resolution,
                    ...manualResolutionEnvelope,
                  } as never,
                  resumeState: "acknowledged",
                  resumeAcknowledgedAt: new Date(sEnded),
                  resumeError: null,
                })
                .where(
                  and(
                    eq(tasksTable.id, initStep.taskId),
                    eq(tasksTable.status, "resolving"),
                    eq(tasksTable.resumeMarker, initStep.resumeMarker),
                  ),
                )
                .run() as { changes?: number };
              if ((taskUpdate.changes ?? 0) !== 1) {
                throw new Error(
                  `task ${initStep.taskId} resume was not durably claimed`,
                );
              }
              tx.update(steps)
                .set({
                  status: stepStatus,
                  endedAt: new Date(sEnded),
                  durationMs: sEnded - initStep.sStarted,
                  outputRef,
                })
                .where(eq(steps.id, initStep.stepId))
                .run();
              tx.update(runs)
                .set({ status: "running" })
                .where(and(eq(runs.id, runId), eq(runs.status, "waiting")))
                .run();
            });
            try {
              publish({
                type: "run.step.completed",
                tenantId: ctx.tenantId,
                at: sEnded,
                runId,
                stepId: initStep.stepId,
                ord,
                name: action.name,
                stepType: action.type,
                status: stepStatus,
                durationMs: sEnded - initStep.sStarted,
                provider: null,
                model: null,
                tokensIn: null,
                tokensOut: null,
                error: stepStatus === "failed" ? "human rejected" : null,
              });
              publish({
                type: "task.resolved",
                tenantId: ctx.tenantId,
                at: sEnded,
                taskId: initStep.taskId,
                decision: resolution.decision ?? "approve",
              });
            } catch {
              /* live delivery is best-effort */
            }
          });

          if (manualDecision === "reject") {
            if (usesV2Definition) {
              // v2: a reject terminates remaining work but intentionally
              // proceeds through output validation, artifact persistence and
              // every authored emitted event with the resolution envelope.
              lastResult = manualResolutionEnvelope;
              stepResults[actionKey] = manualResolutionEnvelope;
              await writeRunLog(logCtx, "WARN", "step.ok", {
                name: action.name,
                type: action.type,
                taskId: initStep.taskId,
                decision: manualDecision,
                outcome: manualResolutionEnvelope.outcome,
              });
              break;
            }
            await failRun(runId, "human rejected", startedAt);
            throw new Error("rejected by human");
          }

          // v2 exposes the stable resolution envelope EXACTLY (strict output
          // contracts validate against it); legacy manifests keep the
          // historical payload/binding carry-forward shape.
          const manualResult = usesV2Definition
            ? manualResolutionEnvelope
            : actionBinding?.kind === "human_input"
              ? { [actionBinding.field]: boundData[actionBinding.field] }
              : (resolution.payload ?? null);
          lastResult = usesV2Definition
            ? manualResolutionEnvelope
            : mergeStepResults(lastResult, manualResult);
          stepResults[actionKey] = manualResult;
          await writeRunLog(logCtx, "INFO", "step.ok", {
            name: action.name,
            type: action.type,
            taskId: initStep.taskId,
            decision: manualDecision,
            outcome: manualResolutionEnvelope.outcome,
          });
          continue;
        }

        // tool | logic: atomic step.run with auto-managed step row.
        // Phase 1a — stable, idempotency-keyed Inngest step id. Falls back to the (sanitized)
        // action name when no idempotency_key_from is declared, so existing manifests are unchanged.
        const stepKey = stableStepId(
          action.name,
          (action as { idempotency_key_from?: string }).idempotency_key_from,
          stepScope,
        );
        // Per-step error behavior is resolved inside the durable callback so
        // retry/park throws before the step can be memoized as a success.
        let stepOutcome: RuntimeStepOutcome;
        try {
          stepOutcome = await step.run(stepKey, async () => {
            const sStarted = Date.now();
            const dbInner = getDb();
            // Upsert by (runId, ord). On an Inngest retry the failed body
            // re-executes; reuse the existing row and bump `attempts` instead
            // of inserting a phantom duplicate at the same ord.
            const existing = dbInner
              .select({ id: steps.id, attempts: steps.attempts })
              .from(steps)
              .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
              .all()[0];
            let sid: string;
            let attempt: number;
            if (existing) {
              sid = existing.id;
              attempt = (existing.attempts ?? 1) + 1;
              dbInner
                .update(steps)
                .set({
                  status: "running",
                  attempts: attempt,
                  startedAt: new Date(sStarted),
                  endedAt: null,
                  durationMs: null,
                  error: null,
                })
                .where(eq(steps.id, sid))
                .run();
            } else {
              sid = makeId("stp");
              attempt = 1;
              dbInner
                .insert(steps)
                .values({
                  id: sid,
                  runId,
                  ord,
                  name: action.name,
                  // invoke steps never reach an insert (handled+continue'd above); cast to the
                  // steps.type column union which predates the "invoke" member.
                  type: action.type as
                    | "tool"
                    | "logic"
                    | "manual"
                    | "condition"
                    | "delay"
                    | "subflow"
                    | "foreach"
                    | "emit"
                    | "decision",
                  status: "running",
                  startedAt: new Date(sStarted),
                  attempts: 1,
                })
                .run();
            }
            await writeRunLog(
              logCtx,
              attempt > 1 ? "WARN" : "DEBUG",
              "step.start",
              {
                ord,
                name: action.name,
                type: action.type,
                attempt,
              },
            );
            try {
              publish({
                type: "run.step.started",
                tenantId: ctx.tenantId,
                at: sStarted,
                runId,
                stepId: sid,
                ord,
                name: action.name,
                stepType: action.type,
              });
            } catch {
              /* broadcast best-effort */
            }

            let codeReceipt: CodeActExecutionReceipt | null = null;
            // #RUN-EVIDENCE (D6) — filled by the per-call evidence writer
            // below and returned with the step so it survives replay.
            const stepToolLedger: ToolCallLedgerEntry[] = [];
            try {
              // Persist the exact input before invoking any provider/tool.
              // A later output/evidence failure must not leave a real side
              // effect with no record of what initiated it.
              const stepInputRef = await requireStepEvidence(
                "input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    action,
                    action_data: actionData,
                    named_inputs: executionInputs,
                    last_result: lastResult ?? null,
                    prior_step_results: stepResults,
                    trigger_event: event.name,
                    subject: subject ?? null,
                  }),
              );
              await requireStepEvidence("input artifact catalog", () =>
                registerStepArtifactEvidence({
                  tenantId: ctx.tenantId,
                  runId,
                  stepId: sid,
                  role: "step_input",
                  filePath: stepInputRef,
                  metadata: {
                    source: "manifest_runtime",
                    actionName: action.name,
                    actionType: action.type,
                    attempt,
                  },
                }),
              );
              await requireStepEvidence("input artifact reference", () =>
                dbInner
                  .update(steps)
                  .set({ inputRef: stepInputRef })
                  .where(eq(steps.id, sid))
                  .run(),
              );

              const res = await runWithTraceContext(
                { correlationId, agentName: agent.name, tenantSlug, runId },
                () =>
                  runAction({
                    ctx: {
                      agentName: agent.name,
                      actionName: action.name,
                      ontologyActionName: agent.factory_action_name,
                      subject: subject ?? undefined,
                      correlationId,
                      runId,
                      tenantSlug,
                      tenantId: ctx.tenantId,
                      event: {
                        name: event.name,
                        data: actionData,
                      },
                      lastResult,
                      results: stepResults,
                      // #P0-1 — durable scoped memory reaches tenant tools (the production code path), not
                      // just generated code. Same handle threaded via StepInput.memory for generated code.
                      memory: runMemory,
                    },
                    action,
                    // Hand the step engine the slots it needs for prompt assembly
                    // AND the tool-use loop. `tool_use` is the canonical roster
                    // of advertised tools — the engine cross-references each
                    // entry against `tenantRegistry.tools` before passing it to
                    // the LLM; stale declarations fail closed.
                    agent: {
                      id: agent.id,
                      name: agent.name,
                      description: agent.description,
                      ontology_instructions: agent.ontology_instructions,
                      generated: (agent as { generated?: boolean }).generated,
                      factoryDomainId: agent.factory_domain_id,
                      factoryExecutionScope: agent.factory_execution_scope,
                      factoryToolProfileRefs: agent.factory_tool_profile_refs,
                      factoryToolReplayRefs: agent.factory_tool_replay_refs,
                      // #RULE-GATE — server-authored corpus + ontology-derived tool
                      // bindings. Not sourced from the manifest by design.
                      ontologyRules: ctx.ontologyRules,
                      ontologyRuleBindings: ctx.ontologyRuleBindings,
                      factoryToolProbeState: ctx.factoryToolProbeState,
                      codeExecuted: (agent as { codeExecuted?: boolean })
                        .codeExecuted,
                      typescriptCode: agent.typescript_code,
                      codeAttestation: agent.code_attestation,
                      factoryPromotionVersionId:
                        agent.factory_promotion_version_id,
                      factoryRegressionSuiteFingerprint:
                        agent.factory_regression_suite_fingerprint,
                      productionCodeActCapability:
                        ctx.productionCodeActCapability,
                      productionCodeActManifestSha256:
                        ctx.productionCodeActManifestSha256,
                      productionCodeActWorkflowManifestSha256:
                        ctx.productionCodeActWorkflowManifestSha256,
                      ...agentAiSettings,
                      ...v2AgentCarrier,
                      triggeredEvents: agent.triggered_event,
                      tool_use: Array.isArray(agent.tool_use)
                        ? (agent.tool_use as Array<{
                            name: string;
                            description?: string;
                            input_schema?: unknown;
                          }>)
                        : undefined,
                    },
                    tenantRegistry: effectiveTenantRegistry,
                    autoResolveManual: true,
                    // #REDESIGN FU1 — real durable memory for generated-code execution (delivered tier).
                    memory: runMemory,
                    // Studio/operator structured trace + terminal-output
                    // validation contract (v2) + billing attribution.
                    stepId: sid,
                    trace: traceSink,
                    finalOutput: i === agent.actions.length - 1,
                    usageAttribution,
                  }),
              ); // #SCALE-TRACE — ambient correlationId/agentName/tenantSlug/runId for nested tools/logs
              codeReceipt = codeActExecutionReceiptFromMeta(res.meta);
              if (res.model) runModel = res.model;
              const sEnded = Date.now();
              // Persist provider usage and the runtime-authored receipt as one
              // recovery unit before any later artifact/telemetry sink can
              // fail. Updating the run here (inside the durable step body)
              // makes the receipt replay-safe; finalization must never derive
              // or overwrite it from a fresh in-memory closure.
              await requireStepEvidence(
                "provider usage and CodeAct receipt",
                () =>
                  dbInner.transaction((tx) => {
                    tx.update(steps)
                      .set({
                        provider: res.provider ?? null,
                        model: res.model ?? null,
                        tokensIn: res.tokensIn ?? null,
                        tokensOut: res.tokensOut ?? null,
                        ...(codeReceipt
                          ? codeActReceiptFields(codeReceipt)
                          : {}),
                      })
                      .where(eq(steps.id, sid))
                      .run();
                    if (codeReceipt) {
                      tx.update(runs)
                        .set(codeActReceiptFields(codeReceipt))
                        .where(eq(runs.id, runId))
                        .run();
                    }
                  }),
              );
              if (codeReceipt) {
                await requireStepEvidence("CodeAct receipt log", () =>
                  writeRunLog(
                    logCtx,
                    codeReceipt!.codeRan ? "INFO" : "WARN",
                    "codeact.receipt",
                    {
                      step: action.name,
                      step_id: sid,
                      ...codeActReceiptFields(codeReceipt!),
                      duration_ms: codeReceipt!.durationMs,
                    },
                  ),
                );
              }
              let stepOutputRef: string | undefined;
              let artifactError: unknown;
              try {
                stepOutputRef = await writeArtifact(
                  runId,
                  `step-${ord}-output.json`,
                  res.data ?? null,
                );
              } catch (error) {
                artifactError = error;
              }

              let telemetryError: unknown;
              try {
                // #W0 — persist raw per-turn capture. On an Inngest retry,
                // replace the prior attempt's rows rather than duplicating
                // them. This attempt still runs if the sidecar write failed.
                if (captureLlmTurns()) {
                  const capturedTurns = (
                    res.meta as { turns?: LlmTurnTrace[] } | undefined
                  )?.turns;
                  if (
                    Array.isArray(capturedTurns) &&
                    capturedTurns.length > 0
                  ) {
                    if (attempt > 1) {
                      dbInner
                        .delete(llmTurns)
                        .where(eq(llmTurns.stepId, sid))
                        .run();
                    }
                    dbInner
                      .insert(llmTurns)
                      .values(
                        capturedTurns.map((tn) => ({
                          id: makeId("llt"),
                          tenantId: ctx.tenantId,
                          runId,
                          stepId: sid,
                          ord: tn.ord,
                          promptPreview: tn.promptPreview ?? null,
                          responseText: tn.responseText ?? null,
                          reasoning: tn.reasoning ?? null,
                          toolCallsJson: tn.toolCalls ?? [],
                          provider: tn.provider ?? null,
                          model: tn.model ?? null,
                          tokensIn: tn.tokensIn ?? null,
                          tokensOut: tn.tokensOut ?? null,
                          finishReason: tn.finishReason ?? null,
                          latencyMs: tn.latencyMs ?? null,
                          correlationId,
                        })),
                      )
                      .run();
                    for (const turn of capturedTurns) {
                      const evidencePath = await writeArtifact(
                        runId,
                        `step-${ord}-llm-${turn.ord + 1}.json`,
                        {
                          iteration: turn.ord + 1,
                          request: {
                            messages: turn.requestMessages ?? [],
                            tools: turn.requestTools ?? [],
                          },
                          response: {
                            text:
                              turn.responseTextFull ?? turn.responseText ?? "",
                            reasoning:
                              turn.reasoningFull ?? turn.reasoning ?? null,
                            tool_calls:
                              turn.responseToolCalls ?? turn.toolCalls ?? [],
                            finish_reason: turn.finishReason,
                          },
                          usage: {
                            provider: turn.provider,
                            model: turn.model,
                            tokens_in: turn.tokensIn,
                            tokens_out: turn.tokensOut,
                            latency_ms: turn.latencyMs,
                          },
                        },
                      );
                      const artifact = await registerStepArtifactEvidence({
                        tenantId: ctx.tenantId,
                        runId,
                        stepId: sid,
                        role: "trace",
                        filePath: evidencePath,
                        metadata: {
                          source: "manifest_llm_turn",
                          iteration: turn.ord + 1,
                        },
                      });
                      await traceSink.append({
                        runId,
                        stepId: sid,
                        kind: "llm",
                        level: "standard",
                        name: `llm.turn.${turn.ord + 1}`,
                        status: "ok",
                        durationMs: turn.latencyMs,
                        summary: `${turn.provider}/${turn.model} · ${turn.tokensIn} in / ${turn.tokensOut} out`,
                        data: {
                          iteration: turn.ord + 1,
                          provider: turn.provider,
                          model: turn.model,
                          tokensIn: turn.tokensIn,
                          tokensOut: turn.tokensOut,
                          finishReason: turn.finishReason,
                        },
                        artifactId: artifact.id,
                        visibility: "operator",
                      });
                    }
                  }
                }
              } catch (error) {
                telemetryError = error;
              }
              if (stepOutputRef) {
                await requireStepEvidence("output artifact catalog", () =>
                  registerStepArtifactEvidence({
                    tenantId: ctx.tenantId,
                    runId,
                    stepId: sid,
                    role: "step_output",
                    filePath: stepOutputRef,
                    metadata: {
                      source: "manifest_runtime",
                      actionName: action.name,
                      actionType: action.type,
                      attempt,
                    },
                  }),
                );
                await requireStepEvidence("output artifact reference", () =>
                  dbInner
                    .update(steps)
                    .set({ outputRef: stepOutputRef })
                    .where(eq(steps.id, sid))
                    .run(),
                );
              }
              if (artifactError && telemetryError) {
                throw new RequiredStepEvidenceError(
                  "output artifact and llm-turn telemetry",
                  new AggregateError(
                    [artifactError, telemetryError],
                    `Step '${action.name}' output artifact and llm-turn telemetry both failed to persist`,
                  ),
                );
              }
              if (artifactError) {
                throw new RequiredStepEvidenceError(
                  "output artifact",
                  artifactError,
                );
              }
              if (telemetryError) {
                throw new RequiredStepEvidenceError(
                  "llm-turn telemetry",
                  telemetryError,
                );
              }
              // Rich per-call logs so the run viewer reads like Inngest's trace:
              // one llm.call line (provider/model/tokens) + one tool.call line
              // per dispatched tool, before the step.ok summary.
              if (res.provider || res.model) {
                await requireStepEvidence("llm call log", () =>
                  writeRunLog(logCtx, "INFO", "llm.call", {
                    step: action.name,
                    provider: res.provider ?? "—",
                    model: res.model ?? "—",
                    tokens_in: res.tokensIn ?? 0,
                    tokens_out: res.tokensOut ?? 0,
                  }),
                );
              }
              // #RUN-EVIDENCE (D6) — THE per-call evidence writer (shared with
              // every foreach body step). Same audit record, same attempt-1
              // artifact names (`step-<ord>-tool-<k>.json`), same fail-closed
              // requireStepEvidence semantics as before the extraction. An
              // Inngest retry re-executes this whole body — the retry's calls
              // REALLY dispatched, so their records land under an
              // attempt-qualified name beside (never over) attempt 1's.
              stepToolLedger.push(
                ...(await persistToolCallEvidence({
                  context: toolCallEvidenceContext,
                  toolCalls: capturedToolCalls(res.meta),
                  stepRowId: sid,
                  stepName: action.name,
                  evidenceName: (callIndex) =>
                    attempt > 1
                      ? `step-${ord}-attempt-${attempt}-tool-${callIndex}.json`
                      : `step-${ord}-tool-${callIndex}.json`,
                  attempt,
                })),
              );
              const returnedError = res.ok
                ? null
                : String(
                    (
                      res.meta as
                        | { message?: unknown; error?: unknown }
                        | undefined
                    )?.message ??
                      (res.meta as { error?: unknown } | undefined)?.error ??
                      `action '${action.name}' returned ok=false`,
                  );
              await requireStepEvidence("terminal step status", () =>
                dbInner
                  .update(steps)
                  .set({
                    status: res.ok ? "ok" : "failed",
                    endedAt: new Date(sEnded),
                    durationMs: sEnded - sStarted,
                    error: returnedError,
                  })
                  .where(eq(steps.id, sid))
                  .run(),
              );
              try {
                publish({
                  type: "run.step.completed",
                  tenantId: ctx.tenantId,
                  at: sEnded,
                  runId,
                  stepId: sid,
                  ord,
                  name: action.name,
                  stepType: action.type,
                  status: res.ok ? "ok" : "failed",
                  durationMs: sEnded - sStarted,
                  provider: res.provider ?? null,
                  model: res.model ?? null,
                  tokensIn: res.tokensIn ?? null,
                  tokensOut: res.tokensOut ?? null,
                  error: returnedError,
                  ...(codeReceipt ? codeActReceiptFields(codeReceipt) : {}),
                });
              } catch {
                /* broadcast best-effort */
              }
              const durableOutcome: RuntimeStepOutcome = {
                ok: res.ok,
                data: res.data,
                tokensIn: res.tokensIn ?? 0,
                tokensOut: res.tokensOut ?? 0,
                durationMs: sEnded - sStarted,
                model: res.model,
                provider: res.provider,
                meta: res.meta,
                toolLedger: stepToolLedger,
              };
              return res.ok
                ? durableOutcome
                : resolveActionFailureOutcome(
                    action,
                    new ActionReturnedFailure(action.name, res),
                    durableOutcome,
                  );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const failedAt = Date.now();
              let failureStatusError: unknown;
              try {
                await requireStepEvidence("failed terminal step status", () =>
                  dbInner
                    .update(steps)
                    .set({
                      status: "failed",
                      endedAt: new Date(failedAt),
                      durationMs: failedAt - sStarted,
                      error: message,
                    })
                    .where(eq(steps.id, sid))
                    .run(),
                );
              } catch (error) {
                failureStatusError = error;
              }
              // A completion broadcast is only truthful after the
              // authoritative terminal status has been persisted.
              if (!failureStatusError) {
                try {
                  publish({
                    type: "run.step.completed",
                    tenantId: ctx.tenantId,
                    at: failedAt,
                    runId,
                    stepId: sid,
                    ord,
                    name: action.name,
                    stepType: action.type,
                    status: "failed",
                    durationMs: failedAt - sStarted,
                    provider: null,
                    model: null,
                    tokensIn: null,
                    tokensOut: null,
                    error: message,
                    ...(codeReceipt ? codeActReceiptFields(codeReceipt) : {}),
                  });
                } catch {
                  /* broadcast best-effort */
                }
              }
              let failureLogError: unknown;
              try {
                await requireStepEvidence("step failure log", () =>
                  writeRunLog(logCtx, "ERROR", "step.fail", {
                    ord,
                    name: action.name,
                    attempt,
                    error: message,
                  }),
                );
              } catch (error) {
                failureLogError = error;
              }
              if (failureStatusError || failureLogError) {
                const causes = [
                  ...(err instanceof RequiredStepEvidenceError ? [err] : []),
                  ...(failureStatusError ? [failureStatusError] : []),
                  ...(failureLogError ? [failureLogError] : []),
                ];
                throw new RequiredStepEvidenceError(
                  "failed-step evidence",
                  causes.length === 1
                    ? causes[0]
                    : new AggregateError(
                        causes,
                        `Step '${action.name}' failure evidence did not persist`,
                      ),
                );
              }
              // Required evidence failures are runtime failures, never
              // business failures eligible for a manifest soft/default rule.
              if (err instanceof RequiredStepEvidenceError) throw err;
              return resolveActionFailureOutcome(action, err, {
                durationMs: failedAt - sStarted,
                toolLedger: stepToolLedger,
              });
            }
          });
        } catch (stepErr) {
          // Recognizer, not instanceof: a memoized/replayed evidence failure
          // reaches this boundary as an SDK StepError that kept only the
          // original `name`, and it must never fall through to the
          // deterministic on_error policy below.
          if (isRequiredStepEvidenceFailure(stepErr)) {
            await emitCompensation(
              stepErr instanceof Error ? stepErr.message : String(stepErr),
            );
            throw stepErr;
          }
          // Defense in depth for SDK StepError wrappers. Normally the durable
          // callback already classified the failure; if the wrapper reaches
          // this boundary we apply the same deterministic policy once more.
          try {
            stepOutcome = resolveActionFailureOutcome(action, stepErr);
          } catch (controlFlowError) {
            await emitCompensation(
              controlFlowError instanceof Error
                ? controlFlowError.message
                : String(controlFlowError),
            );
            throw controlFlowError;
          }
        }

        // #RUN-EVIDENCE (D6) — fold this step's persisted per-call records into
        // the run ledger. `stepOutcome` is the memoized step result, so this
        // reproduces identically on replay.
        if (Array.isArray(stepOutcome.toolLedger)) {
          runToolLedger.push(...stepOutcome.toolLedger);
        }
        // Generated code reaches tools over the host RPC bridge, which records
        // a classification but no input/output — so no per-call audit record
        // exists for those dispatches. Declared as a coverage gap rather than
        // fabricated, and only when the bridge actually saw dispatches: a
        // CodeAct step that called no tools stays fully evidenced.
        if (
          Array.isArray(
            (stepOutcome.meta as { codeToolDispatches?: unknown } | undefined)
              ?.codeToolDispatches,
          )
          && (
            (stepOutcome.meta as { codeToolDispatches: unknown[] })
              .codeToolDispatches.length > 0
          )
        ) {
          uncoveredEvidenceSteps.push({
            ord,
            name: action.name,
            type: action.type,
            reason: "generated_code_dispatch_not_recorded",
          });
        }
        applyFailureEmission(stepOutcome);
        const continuedFailure = failureResolutionFromOutcome(stepOutcome);
        if (continuedFailure) {
          await writeRunLog(logCtx, "WARN", "step.error-continue", {
            ord,
            name: action.name,
            kind: continuedFailure.facts.kind,
            code: continuedFailure.facts.code,
            status: continuedFailure.facts.status,
            matchedRule: continuedFailure.matchedRule,
            emitEvent: continuedFailure.emitEvent,
            suppressEmit: continuedFailure.suppressEmit,
          });
        }
        tokensIn += stepOutcome.tokensIn;
        tokensOut += stepOutcome.tokensOut;
        // Replay-safe model/provider + v2 structured-output receipts (a failed
        // turn still consumed tokens and can carry the raw response needed for
        // terminal diagnostics).
        if (stepOutcome.model) runModel = stepOutcome.model;
        if (stepOutcome.provider) runProvider = stepOutcome.provider;
        const outcomeMeta = stepOutcome.meta as
          | { outputValid?: unknown; rawResponse?: unknown }
          | undefined;
        if (typeof outcomeMeta?.outputValid === "boolean") {
          lastOutputValid = outcomeMeta.outputValid;
        }
        if (typeof outcomeMeta?.rawResponse === "string") {
          lastRawResponse = outcomeMeta.rawResponse;
        }
        const emitted = (
          stepOutcome.meta as { emitted?: EmitIntent[] } | undefined
        )?.emitted;
        if (Array.isArray(emitted)) emitIntents.push(...emitted);
        if (actionBinding?.kind === "object_lookup") {
          const lookupIssues = applyObjectLookupResult(
            inputBindingState,
            actionBinding,
            stepOutcome.data,
          );
          if (lookupIssues.length) await abortForInputBindings(lookupIssues);
        }
        stepResults[actionKey] = stepOutcome.data;
        lastResult = mergeStepResults(lastResult, stepOutcome.data);

        // Phase 1a — record a condition step's verdict so downstream depends_on actions branch on it.
        if (action.type === "condition") {
          const conditionEvaluated = Boolean(
            (stepOutcome.data as { evaluated?: boolean } | null)?.evaluated,
          );
          gate.conditionTrue[actionKey] = conditionEvaluated;
          // Agent Studio v2 — explicit branch targets. A condition may name a
          // LATER action (by `id`, else name) to jump to; the target must be
          // forward-only so replays cannot loop.
          const conditionAction = action as {
            true_action_id?: unknown;
            false_action_id?: unknown;
          };
          const branchTarget = conditionEvaluated
            ? conditionAction.true_action_id
            : conditionAction.false_action_id;
          if (typeof branchTarget === "string" && branchTarget.length > 0) {
            const targetIndex = agent.actions.findIndex(
              (candidate) =>
                ((candidate as { id?: unknown }).id ?? candidate.name) ===
                branchTarget,
            );
            if (targetIndex <= i) {
              const reason = `condition ${action.name} selected invalid target ${branchTarget}`;
              await failRun(
                runId,
                reason,
                startedAt,
                "condition_target_invalid",
              );
              throw new Error(
                `condition target '${branchTarget}' must be a later action`,
              );
            }
            i = targetIndex - 1;
          }
        }

        // A soft/default policy permits the workflow to continue; it does
        // not retroactively make the underlying action successful. The
        // failed terminal step row + step.error-continue log above are the
        // truthful record, so never append a contradictory step.ok marker.
        if (!continuedFailure) {
          await writeRunLog(logCtx, "INFO", "step.ok", {
            name: action.name,
            type: action.type,
            duration: stepOutcome.durationMs + "ms",
          });
        }
      }

      const finalStepBindingIssues = resolveAvailableStepOutputBindings(
        inputBindingState,
        factoryInputBindings,
        stepResults,
      );
      if (finalStepBindingIssues.length)
        await abortForInputBindings(finalStepBindingIssues);
      const unresolvedBindings = unresolvedRequiredInputBindings(
        inputBindingState,
        factoryInputBindings,
      );
      if (unresolvedBindings.length)
        await abortForInputBindings(unresolvedBindings);

      // Agent Studio v2 — validate (and once repair) the terminal output
      // against the compiled output-port schema when no step already did.
      if (usesV2Definition && lastOutputValid !== true) {
        try {
          const finalValidation = await step.run(
            "validate-final-output",
            async () =>
              parseValidateAndRepairOutput({
                definition: agent,
                candidate: lastResult,
                trace: traceSink,
                runId,
              }),
          );
          lastResult = finalValidation.value;
          lastOutputValid = finalValidation.valid;
          lastRawResponse = finalValidation.rawResponse;
        } catch (error) {
          if (error instanceof OutputSchemaValidationError) {
            lastOutputValid = false;
            lastRawResponse = error.invalidResponse;
            await failRun(runId, error.message, startedAt, error.code);
          }
          throw error;
        }
      }

      // ── #RUN-EVIDENCE (D6) — reconcile the completion claim ──────────────
      // Computed here, after the last step and BEFORE any downstream event is
      // assembled or sent: under `refuse` a run that cannot evidence its own
      // completion must not first tell the rest of the fleet that it did.
      // Server-derived from the persisted per-call records; nothing an agent
      // returns can assert it.
      const runCompletion: RunCompletionReconciliation = reconcileRunCompletion({
        ledger: runToolLedger,
        declaredWriteTools: [...declaredWriteTools],
        uncoveredSteps: uncoveredEvidenceSteps,
      });
      if (
        runCompletion.outcome === "qualified"
        && runCompletionEnforcementFromEnv(process.env) === "refuse"
      ) {
        const detail = runCompletion.qualifications
          .map((item) => `${item.code}: ${item.detail}`)
          .join(" | ");
        await failRun(
          runId,
          `run_completion_unevidenced: ${detail}`,
          startedAt,
          "run_completion_unevidenced",
        );
        throw new Error(`run_completion_unevidenced: ${detail}`);
      }

      // Agent Studio v2 — authored output bindings decide WHICH events fire
      // and their exact payload field mapping; test mode suppresses them.
      // Legacy manifests keep the explicit-emit/first-declared selection.
      const v2SuppressedEmissions: string[] = [];
      const v2PortsByEvent: Record<string, string[]> = {};
      if (usesV2Definition) {
        const resolvedEmissions = resolveAgentEmissions({
          definition: agent,
          inputs: executionInputs,
          outputs: lastResult,
          source: {
            agentName: agent.name,
            runId,
            subject,
            correlationId,
          },
          suppress: isTest,
        });
        for (const emission of resolvedEmissions) {
          if (emission.suppressed) {
            v2SuppressedEmissions.push(emission.name);
            await writeRunLog(logCtx, "INFO", "event.suppressed", {
              name: emission.name,
              reason: "test_mode",
            });
            try {
              await traceSink.append({
                runId,
                kind: "event",
                level: "standard",
                name: emission.name,
                status: "skipped",
                summary: `Suppressed downstream event '${emission.name}' in test mode`,
                data: { outputPortIds: emission.outputPortIds },
                visibility: "user",
              });
            } catch {
              // Event persistence remains authoritative when trace is absent.
            }
            continue;
          }
          emitIntents.push({
            event: emission.name,
            payload: emission.payload,
          });
          v2PortsByEvent[emission.name] = emission.outputPortIds;
        }
        // v2 emissions are fully authored; the implicit triggered_event[0]
        // fallback must not double-fire beside them.
        suppressImplicitEmit = true;
      }

      // Preserve all explicit emit intents (including repeated names from foreach). If no step
      // emitted explicitly, selectEmittedEvents retains the historical exactly-one branch routing
      // ONLY for plans that did not delegate routing to conditional emit actions.
      if (
        ownsTopLevelConditionalEmitRouting &&
        emitIntents.length === 0 &&
        !suppressImplicitEmit
      ) {
        const reason =
          "[park] no authoritative conditional emit guard matched";
        await failRun(
          runId,
          reason,
          startedAt,
          "conditional_emit_no_match",
        );
        throw new Error(reason);
      }
      const selectedEmits = selectEmittedEvents(
        agent.triggered_event,
        lastResult,
        emitIntents,
        { suppressImplicit: suppressImplicitEmit },
      );
      const outbound = selectedEmits.map((intent) => ({
        intent,
        // An explicit emit payload is authoritative for that event. The incoming envelope is still
        // carried forward, while the aggregate foreach receipt stays internal unless selected.
        // v2 payloads are fully authored by output bindings — no inbound
        // carry-forward may pollute the exact mapped shape.
        assembled: assembleEmitPayload({
          incoming: usesV2Definition ? {} : data,
          lastResult: intent.payload ?? lastResult,
          meta: {
            subject: subject ?? undefined,
            correlationId,
            causationId: triggerEventId ?? correlationId,
            producedBy: agent.name,
            sourceRun: runId,
          },
          contractSchema: agent.factory_output_schema,
          offload: offloader,
        }),
      }));
      for (const item of outbound) {
        const assembled = item.assembled;
        if (
          assembled.carried.length ||
          assembled.offloaded.length ||
          assembled.missing.length
        ) {
          await writeRunLog(
            logCtx,
            assembled.missing.length ? "WARN" : "INFO",
            "emit.envelope",
            {
              event: item.intent.event,
              carried: assembled.carried,
              offloaded: assembled.offloaded,
              missing: assembled.missing,
            },
          );
        }
      }
      const invalidOutbound = outbound.filter(
        (item) => item.assembled.contractErrors.length > 0,
      );
      if (invalidOutbound.length) {
        const failures = invalidOutbound.flatMap((item) =>
          item.assembled.contractErrors.map((error) => ({
            event: item.intent.event,
            field: error.field,
            kind: error.kind,
            expectedType: error.expectedType,
            ...(error.actualType ? { actualType: error.actualType } : {}),
          })),
        );
        await writeRunLog(logCtx, "ERROR", "emit.contract-invalid", {
          failures,
        });
        throw new Error(
          `outbound event contract rejected: ${failures
            .slice(0, 8)
            .map(
              (failure) => `${failure.event}.${failure.field}:${failure.kind}`,
            )
            .join(", ")}`,
        );
      }
      // BlobRefs become durable event truth below. When a shared backend is
      // configured, all referenced bytes must be reachable there before the
      // ledger/event-store rows are committed; otherwise another instance
      // can receive a successful event whose payload is impossible to load.
      await durableOffloader.flush();
      const finalize = await step.run("finalize", async () => {
        const dbInner = getDb();
        const emittedEvents: Array<{
          id: string;
          name: string;
          index: number;
        }> = [];
        const emittedRecordRows: RunEmittedEvent[] = [];
        for (let index = 0; index < outbound.length; index++) {
          const item = outbound[index]!;
          const emittedEventId = makeId("evt");
          const emittedName = item.intent.event;
          const payload = item.assembled.payload;
          const payloadRef = await appendToLedger(tenantSlug, {
            id: emittedEventId,
            name: emittedName,
            subject: subject ?? undefined,
            data: payload,
            ts: Date.now(),
          });
          dbInner
            .insert(events)
            .values({
              id: emittedEventId,
              tenantId: ctx.tenantId,
              name: emittedName,
              sourceAgentId: init.agentDbId,
              subject,
              payloadRef,
            })
            .run();
          // #P1-1 — mirror into the durable, queryable event store: full assembled payload inline
          // (small thanks to blob offload) + causation lineage, so cross-agent causality is queryable
          // + replay-safe across restarts (unlike the per-instance NDJSON ledger). This is required
          // causality evidence, so insertion failures fail the finalize step.
          dbInner
            .insert(eventStore)
            .values({
              id: emittedEventId,
              tenantId: ctx.tenantId,
              name: emittedName,
              subject: subject ?? null,
              sourceRunId: runId,
              sourceAgent: agent.name,
              causationId: triggerEventId ?? null,
              correlationId,
              payloadJson: (() => {
                const j = JSON.stringify(payload);
                // #W1-14 — no SILENT truncation: oversize payloads store a marker so audits see the cut.
                return j.length > 200_000
                  ? JSON.stringify({
                      __truncated: true,
                      bytes: j.length,
                      head: j.slice(0, 180_000),
                    })
                  : j;
              })(),
            })
            .run();
          // Studio run views join emissions to authored output ports. Legacy
          // manifests link under the wildcard port.
          const emittedAt = new Date();
          const portIds =
            usesV2Definition && v2PortsByEvent[emittedName]?.length
              ? v2PortsByEvent[emittedName]!
              : ["*"];
          for (const outputPortId of portIds) {
            const linkId = makeId("ree");
            dbInner
              .insert(runEmittedEvents)
              .values({
                id: linkId,
                tenantId: ctx.tenantId,
                runId,
                eventId: emittedEventId,
                outputPortId,
                createdAt: emittedAt,
              })
              .run();
            emittedRecordRows.push({
              id: linkId,
              eventId: emittedEventId,
              eventName: emittedName,
              outputPortId,
              createdAt: emittedAt,
            });
          }
          emittedEvents.push({ id: emittedEventId, name: emittedName, index });
        }

        // The DB schema keeps one primary emitted_event_id for backwards compatibility. It points
        // to the first event; the complete ordered list lives in events/event_store and is returned.
        const emittedEventId = emittedEvents[0]?.id ?? null;

        const persistedAtMs = Date.now();
        // Persist the output receipt while the run is still in-flight. A broker rejection below must
        // leave the run non-terminal so Inngest can retry the idempotent step.sendEvent operations;
        // declaring status=ok here used to expose a false success before any downstream event was
        // actually accepted.
        dbInner
          .update(runs)
          .set({
            tokensIn,
            tokensOut,
            // #REDESIGN P1b — record the REAL model that served the run (falls back to the run's own
            // recorded model, else the configured default), not a hardcoded "mock-model-v1".
            model: runModel ?? "unknown",
            emittedEventId,
          })
          .where(eq(runs.id, runId))
          .run();
        return {
          emittedEventId,
          emittedEvents,
          emittedRecordRows,
          persistedAtMs,
        };
      });

      // §G2 suppressDownstream (eval): when the TRIGGER event payload carries
      // __eval_suppress_downstream === true, all persistence above stays
      // (ledger, events, event_store, run_emitted_events rows), but the
      // step.sendEvent fan-out below is skipped so downstream subscribers
      // never fire. The decision derives ONLY from event.data, so it is
      // identical on every Inngest replay.
      const suppressDownstreamForEval =
        data.__eval_suppress_downstream === true ||
        rehydratedData.__eval_suppress_downstream === true;
      if (suppressDownstreamForEval && finalize.emittedEvents.length > 0) {
        await writeRunLog(logCtx, "INFO", "emissions suppressed (eval)", {
          suppressed: finalize.emittedEvents.map(
            (emitted: { name: string }) => emitted.name,
          ),
        });
      }

      // The actual inngest.send must be outside step.run (step results are
      // memoized; sending an event inside a step would re-send on replay).
      // We use step.sendEvent which is Inngest's idempotent send primitive.
      for (const persisted of suppressDownstreamForEval
        ? []
        : finalize.emittedEvents) {
        const item = outbound[persisted.index];
        if (!item) continue;
        const emittedName = persisted.name;
        const emittedEventId = persisted.id;
        // Canonical delivery envelope: correlation + trigger lineage + the
        // private (strippable) usage-attribution block so chained runs bill
        // to the same interaction. Stripping `__` keys from this object
        // reproduces the exact ledger payload.
        const flatWireData = buildManifestEventDeliveryData({
          logicalPayload: item.assembled.payload,
          eventId: emittedEventId,
          correlationId,
          usageAttribution,
        });
        const wireData = eventAdapter.outbound({
          eventId: emittedEventId,
          eventName: emittedName,
          payload: flatWireData,
          subject,
          correlationId,
          sourceAgent: agent.name,
          emittedAt: new Date(finalize.persistedAtMs).toISOString(),
        });
        await step.sendEvent(`emit.${persisted.index}.${emittedEventId}`, {
          id: emittedEventId,
          name: tenantEventName(
            tenantSlug,
            emittedName,
            eventAdapter,
          ) as `${string}/${string}`,
          // #COMMS — the unified, carry-forward, offloaded payload (same object written to the ledger),
          // plus this event's id for downstream lineage.
          data: wireData,
        });
        // Stream/UI evidence is emitted only after the broker accepted the durable send step. The
        // events/event_store rows above are the persisted outbox; they are not delivery proof.
        await step.run(
          `confirm-emit.${persisted.index}.${emittedEventId}`,
          async () => {
            try {
              publish({
                type: "event.emitted",
                tenantId: ctx.tenantId,
                at: Date.now(),
                eventId: emittedEventId,
                name: emittedName,
                subject: subject ?? null,
                sourceRunId: runId,
              });
            } catch {
              /* broadcast best-effort */
            }
            return true;
          },
        );
        await writeRunLog(logCtx, "INFO", "event.emit", {
          name: emittedName,
          event_id: emittedEventId,
          index: persisted.index,
        });
      }

      const completion = await step.run("finalize-dispatched", async () => {
        const dbInner = getDb();
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs);

        // ── Terminal run evidence (Agent Studio contract) ──────────────────
        // Persist the exact terminal output + a typed run record BEFORE the
        // run flips to ok. Failure here keeps the run running so this
        // memoized step retries; the event sends above are idempotent.
        const outputFilename =
          (
            agent as AgentSpec & {
              output_config?: { artifact?: { filename?: string } };
            }
          ).output_config?.artifact?.filename ?? "output.json";
        const persistedOutput = await terminalArtifactSink.persist({
          role: "output",
          logicalName: outputFilename,
          contentType: "application/json",
          payload: lastResult,
        });
        const outputArtifactId = registerPersistedArtifact(persistedOutput);
        // #RUN-EVIDENCE (D6) — the completion reconciliation is MANDATORY
        // terminal evidence, persisted before the run may flip to `ok`, exactly
        // like output.json and run-record.json. A failure here throws and the
        // memoized step retries; it must never be possible for a run to read
        // `ok` while the statement of what it did and did not evidence is
        // missing. This is what stops `ok` meaning "nothing threw".
        const persistedCompletion = await terminalArtifactSink.persist({
          role: "trace",
          logicalName: "run-completion.json",
          contentType: "application/json",
          payload: runCompletion,
          metadata: {
            source: "manifest_runtime",
            outcome: runCompletion.outcome,
            qualifications: runCompletion.qualifications.map(
              (item) => item.code,
            ),
          },
        });
        const completionArtifactId =
          registerPersistedArtifact(persistedCompletion);
        let persistedRawResponse: RuntimePersistedArtifact | null = null;
        let rawResponseArtifactId: string | null = null;
        const persistRawResponse =
          (
            agent as AgentSpec & {
              output_config?: { artifact?: { persist_raw_response?: boolean } };
            }
          ).output_config?.artifact?.persist_raw_response === true;
        if (persistRawResponse && lastRawResponse !== undefined) {
          persistedRawResponse = await terminalArtifactSink.persist({
            role: "raw_response",
            logicalName: "raw-response.txt",
            contentType: "text/plain; charset=utf-8",
            payload: lastRawResponse,
          });
          rawResponseArtifactId =
            registerPersistedArtifact(persistedRawResponse);
        }
        const emittedRecordRows: RunEmittedEvent[] = (
          finalize.emittedRecordRows ?? []
        ).map(
          (row: {
            id: string;
            eventId: string;
            eventName: string;
            outputPortId: string;
            createdAt: string | number | Date;
          }) => ({
            id: row.id,
            eventId: row.eventId,
            eventName: row.eventName,
            outputPortId: row.outputPortId,
            createdAt: new Date(row.createdAt),
          }),
        );
        const outputMetadata = outputArtifactId
          ? toRunArtifactMetadata(outputArtifactId, persistedOutput, endedAt)
          : null;
        const rawResponseMetadata =
          rawResponseArtifactId && persistedRawResponse
            ? toRunArtifactMetadata(
                rawResponseArtifactId,
                persistedRawResponse,
                endedAt,
              )
            : null;
        const completionMetadata = completionArtifactId
          ? toRunArtifactMetadata(
              completionArtifactId,
              persistedCompletion,
              endedAt,
            )
          : null;
        const runRecord: AgentRunRecord = {
          schemaVersion: 1,
          runId,
          tenantId: ctx.tenantId,
          agentId: init.agentDbId,
          status: "ok",
          invocationSource: runInvocationSource(
            usageAttribution.invocationSource,
          ),
          target: {
            kind: "live",
            agentVersionId: init.agentVersionId ?? "unversioned",
          },
          definitionHash,
          sessionId: null,
          correlationId,
          subject,
          validation: {
            inputValid,
            outputValid: lastOutputValid,
            issues: [],
          },
          artifacts: [
            outputMetadata,
            rawResponseMetadata,
            completionMetadata,
          ].filter((value): value is RunArtifactMetadata => value !== null),
          emittedEvents: emittedRecordRows,
          model:
            runProvider || runModel
              ? {
                  ...(runProvider
                    ? { provider: runProvider as ProviderId }
                    : {}),
                  ...(runModel ? { model: runModel } : {}),
                  tokensIn,
                  tokensOut,
                }
              : undefined,
          timing: {
            queuedAt: null,
            startedAt,
            endedAt,
            durationMs: endedAtMs - startedAtMs,
          },
          error: null,
        };
        const persistedRunRecord = await terminalArtifactSink.persist({
          role: "run_record",
          logicalName: "run-record.json",
          contentType: "application/json",
          payload: runRecord,
        });
        registerPersistedArtifact(persistedRunRecord);
        // Existing consumers still expect run-output.json. Keep the legacy
        // envelope as a compatibility artifact while output.json remains the
        // exact authored shape. Best-effort — never blocks the terminal flip.
        try {
          await writeArtifact(runId, "run-output.json", {
            run_id: runId,
            agent: agent.name,
            title: agent.title ?? agent.name,
            tenant: tenantSlug,
            status: "ok",
            // #RUN-EVIDENCE — the legacy envelope carries the verdict too, so
            // an existing consumer that only reads this file cannot come away
            // believing `status: "ok"` is the whole story.
            completion: {
              outcome: runCompletion.outcome,
              qualifications: runCompletion.qualifications.map(
                (item) => item.code,
              ),
            },
            trigger: { name: event.name, subject, data },
            output: lastResult,
            emitted_events: finalize.emittedEvents.map(
              (item: { name: string }) => item.name,
            ),
            tokens: {
              in: tokensIn,
              out: tokensOut,
              provider: runProvider,
              model: runModel,
            },
            started_at: startedAt.toISOString(),
            ended_at: endedAt.toISOString(),
          });
        } catch (error) {
          logger.warn("legacy run-output artifact failed", {
            err: String(error),
          });
        }

        const updated = dbInner
          .update(runs)
          .set({
            status: "ok",
            endedAt,
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            model: runModel ?? "unknown",
            outputValid: lastOutputValid,
            emittedEventId: finalize.emittedEventId,
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "running")))
          .run() as { changes?: number };
        if ((updated.changes ?? 0) !== 1) {
          const current = dbInner
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId))
            .all()[0];
          throw new Error(
            `run ${runId} cannot be completed after event dispatch (current status: ${current?.status ?? "missing"})`,
          );
        }
        const completedReceipt = dbInner
          .select(codeActRunReceiptSelection)
          .from(runs)
          .where(eq(runs.id, runId))
          .all()[0];
        try {
          publish({
            type: "run.completed",
            tenantId: ctx.tenantId,
            at: endedAtMs,
            runId,
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            emittedEventId: finalize.emittedEventId,
            ...(completedReceipt
              ? storedCodeActReceiptFields(completedReceipt)
              : {}),
          });
        } catch {
          /* broadcast best-effort */
        }

        // Completion metrics are terminal evidence too, so they are recorded only after all
        // downstream sends have succeeded and inside a memoized step to avoid replay double-counts.
        const m = getRuntimeMetrics();
        if (m) {
          m.runs.inc({
            tenant: tenantSlug,
            agent: agent.name,
            model: runModel ?? "unknown",
            status: "ok",
          });
          m.runDuration?.observe(endedAtMs - startedAtMs, {
            tenant: tenantSlug,
            agent: agent.name,
          });
        }
        // Structured terminal traces — best-effort; terminal DB state and
        // artifacts must not be rolled back by trace IO.
        try {
          await traceSink.append({
            runId,
            kind: "artifact",
            level: "standard",
            name: "terminal.artifacts",
            status: "ok",
            endedAt,
            summary:
              "Persisted mandatory output.json, run-record.json and run-completion.json",
            data: {
              outputArtifactId,
              rawResponseArtifactId,
              completionArtifactId,
            },
            visibility: "user",
          });
          // #RUN-EVIDENCE — a qualified completion is surfaced as its own
          // trace row with a non-ok status, so the run viewer shows it beside
          // the terminal state instead of burying it in an artifact.
          await traceSink.append({
            runId,
            kind: "run",
            level: "minimal",
            name: "run.completion-evidence",
            // The trace vocabulary has no "qualified"; `failed` is the only
            // value that does not assert the check passed (`ok`) or was never
            // performed (`skipped`). It marks the EVIDENCE row, not the run —
            // `run.end` below stays `ok`.
            status: runCompletion.outcome === "evidenced" ? "ok" : "failed",
            endedAt,
            summary: summarizeRunCompletion(runCompletion),
            data: {
              outcome: runCompletion.outcome,
              toolCalls: runCompletion.toolCalls,
              writes: runCompletion.writes,
              qualifications: runCompletion.qualifications,
            },
            visibility: "user",
          });
          await traceSink.append({
            runId,
            kind: "run",
            level: "minimal",
            name: "run.end",
            status: "ok",
            startedAt,
            endedAt,
            durationMs: endedAtMs - startedAtMs,
            summary: "Agent run completed successfully",
            data: {
              emittedEventCount: finalize.emittedEvents.length,
              suppressedEventCount: v2SuppressedEmissions.length,
              completionOutcome: runCompletion.outcome,
            },
            visibility: "user",
          });
        } catch {
          /* trace best-effort */
        }
        return { endedAtMs };
      });

      // #RUN-EVIDENCE — the verdict lands in the run log at the level it
      // deserves, so an operator tailing logs sees an unevidenced completion
      // rather than an unqualified "run.end status=ok".
      await writeRunLog(
        logCtx,
        runCompletion.outcome === "evidenced" ? "INFO" : "WARN",
        "run.completion-evidence",
        {
          outcome: runCompletion.outcome,
          tool_calls: runCompletion.toolCalls.dispatched,
          real: runCompletion.toolCalls.real,
          simulated: runCompletion.toolCalls.simulated,
          errored: runCompletion.toolCalls.errored,
          real_writes: runCompletion.writes.recordedReal,
          read_back_verified: runCompletion.writes.readBackVerified,
          qualifications:
            runCompletion.qualifications.map((item) => item.code).join(",") ||
            "—",
        },
      );
      await writeRunLog(logCtx, "INFO", "run.end", {
        status: "ok",
        completion: runCompletion.outcome,
        duration: completion.endedAtMs - startedAtMs + "ms",
        emitted:
          finalize.emittedEvents
            .map((item: { name: string }) => item.name)
            .join(",") || "—",
      });

      // #INVOKE-RESULT — a parent step.invoke with forward_last_result:true
      // needs the child's BUSINESS conclusion, not just a delivery receipt:
      // without it the parent's carry-forward loses fields the child minted
      // (e.g. candidate_id from the dedup registry) and downstream
      // write-before-emit gates fail closed. Spread the primary emitted
      // payload flat (envelope `_*` keys stripped; receipt keys stay
      // authoritative last) so mergeStepResults exposes it to the chain.
      const primaryPayload = outbound[0]?.assembled.payload;
      const forwardedResult: Record<string, unknown> = {};
      if (
        primaryPayload &&
        typeof primaryPayload === "object" &&
        !Array.isArray(primaryPayload)
      ) {
        for (const [key, value] of Object.entries(primaryPayload)) {
          if (!key.startsWith("_")) forwardedResult[key] = value;
        }
      }
      return {
        ...forwardedResult,
        ok: true,
        runId,
        emittedEventId: finalize.emittedEventId,
        emittedEventIds: finalize.emittedEvents.map(
          (item: { id: string }) => item.id,
        ),
      };

      /** Persist a terminal artifact's DB row (filesystem sink) or trust the
       * tenant-authorized sink's own id. Returns the artifacts row id. */
      function registerPersistedArtifact(
        persisted: RuntimePersistedArtifact,
      ): string | null {
        if (artifactSink) return persisted.id ?? null;
        if (!persisted.path) {
          throw new Error(
            `artifact_persistence_failed: '${persisted.logicalName}' has no storage path`,
          );
        }
        const artifactId = persisted.id ?? makeId("art");
        getDb()
          .insert(artifacts)
          .values({
            id: artifactId,
            tenantId: ctx.tenantId,
            runId,
            stepId: persisted.stepId ?? null,
            kind: persisted.contentType,
            role: persisted.role,
            logicalName: persisted.logicalName,
            contentType: persisted.contentType,
            sha256: persisted.sha256,
            schemaId: persisted.schemaId ?? null,
            metadataJson: (persisted.metadata ?? null) as never,
            redacted: persisted.redacted,
            retentionUntil: persisted.retentionUntil ?? null,
            path: persisted.path,
            size: persisted.size,
          })
          .run();
        return artifactId;
      }

      function toRunArtifactMetadata(
        id: string,
        persisted: RuntimePersistedArtifact,
        createdAt: Date,
      ): RunArtifactMetadata {
        return {
          id,
          runId,
          stepId: persisted.stepId ?? null,
          role: persisted.role,
          logicalName: persisted.logicalName,
          contentType: persisted.contentType,
          size: persisted.size,
          sha256: persisted.sha256,
          schemaId: persisted.schemaId ?? null,
          metadata: persisted.metadata ?? null,
          redacted: persisted.redacted,
          createdAt,
          retentionUntil: persisted.retentionUntil ?? null,
        };
      }

      async function failRun(
        rid: string,
        message: string,
        started: Date,
        errorCode?: string,
      ): Promise<void> {
        // UC-V11-35 / PF-GAP-15 — wrap the run-status flip in `step.run`
        // so Inngest's exactly-once contract serializes it with any
        // concurrent retry. Without the wrapper, a flake between the
        // failure detection and the DB write could fire `failRun` twice
        // (once per replay), tombstoning a run that the retry actually
        // recovered.
        await step.run(`finalize-fail-${rid}`, async () => {
          const ended = new Date();
          let terminalMessage = message;
          // Terminal failure evidence (Agent Studio contract): the typed
          // run record + optional raw model response. Best-effort — an
          // artifact failure annotates the message but never masks the
          // original run failure being recorded.
          const failureArtifacts: RunArtifactMetadata[] = [];
          const persistRawResponse =
            (
              agent as AgentSpec & {
                output_config?: {
                  artifact?: { persist_raw_response?: boolean };
                };
              }
            ).output_config?.artifact?.persist_raw_response === true;
          if (persistRawResponse && lastRawResponse !== undefined) {
            try {
              const persistedRawResponse = await terminalArtifactSink.persist({
                role: "raw_response",
                logicalName: "raw-response.txt",
                contentType: "text/plain; charset=utf-8",
                payload: lastRawResponse,
              });
              const artifactId =
                registerPersistedArtifact(persistedRawResponse);
              if (artifactId) {
                failureArtifacts.push(
                  toRunArtifactMetadata(
                    artifactId,
                    persistedRawResponse,
                    ended,
                  ),
                );
              }
            } catch (error) {
              terminalMessage = `${terminalMessage}; artifact_persistence_failed: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
          const failedRecord: AgentRunRecord = {
            schemaVersion: 1,
            runId: rid,
            tenantId: ctx.tenantId,
            agentId: init.agentDbId,
            status: "failed",
            invocationSource: runInvocationSource(
              usageAttribution.invocationSource,
            ),
            target: {
              kind: "live",
              agentVersionId: init.agentVersionId ?? "unversioned",
            },
            definitionHash,
            sessionId: null,
            correlationId,
            subject,
            validation: {
              inputValid: errorCode !== "input_schema_invalid" && inputValid,
              outputValid:
                errorCode === "output_schema_invalid"
                  ? false
                  : (lastOutputValid ?? null),
              issues: [],
            },
            artifacts: failureArtifacts,
            emittedEvents: [],
            model:
              runProvider || runModel
                ? {
                    ...(runProvider
                      ? { provider: runProvider as ProviderId }
                      : {}),
                    ...(runModel ? { model: runModel } : {}),
                    tokensIn,
                    tokensOut,
                  }
                : undefined,
            timing: {
              queuedAt: null,
              startedAt: started,
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
            },
            error: {
              ...(errorCode ? { code: errorCode } : {}),
              message: terminalMessage,
            },
          };
          try {
            const persistedRunRecord = await terminalArtifactSink.persist({
              role: "run_record",
              logicalName: "run-record.json",
              contentType: "application/json",
              payload: failedRecord,
            });
            registerPersistedArtifact(persistedRunRecord);
          } catch (error) {
            terminalMessage = `${terminalMessage}; artifact_persistence_failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          db.update(runs)
            .set({
              status: "failed",
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
              tokensIn,
              tokensOut,
              model: runModel ?? "unknown",
              outputValid:
                errorCode === "output_schema_invalid"
                  ? false
                  : (lastOutputValid ?? null),
              errorMessage: terminalMessage,
            })
            .where(eq(runs.id, rid))
            .run();
          // Structured run.end (failed) trace — best-effort.
          try {
            await traceSink.append({
              runId: rid,
              kind: "run",
              level: "minimal",
              name: "run.end",
              status: "failed",
              startedAt: started,
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
              summary: "Agent run failed",
              data: {
                ...(errorCode ? { code: errorCode } : {}),
                message: terminalMessage,
              },
              visibility: "user",
            });
          } catch {
            /* trace best-effort */
          }
          const failedReceipt = db
            .select(codeActRunReceiptSelection)
            .from(runs)
            .where(eq(runs.id, rid))
            .all()[0];
          try {
            publish({
              type: "run.failed",
              tenantId: ctx.tenantId,
              at: ended.getTime(),
              runId: rid,
              errorMessage: message,
              ...(failedReceipt
                ? storedCodeActReceiptFields(failedReceipt)
                : {}),
            });
          } catch {
            /* broadcast best-effort */
          }

          // UC-V11-22 / AR-GAP-07 — `runs_total{status="failed"}` so the
          // dashboards see manifest-engine failures, not just code-agent
          // failures (which already bump from BaseAgent.run).
          const m = getRuntimeMetrics();
          if (m) {
            m.runs.inc({
              tenant: tenantSlug,
              agent: agent.name,
              // #W1-3 — real served model on the failure path too.
              model: runModel ?? "unknown",
              status: "failed",
            });
          }
        });
        await writeRunLog(logCtx, "ERROR", "run.end", {
          status: "failed",
          error: message,
        });
      }
    },
  );
}
