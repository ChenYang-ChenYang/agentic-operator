/**
 * RunStreamEvent — the discriminated union published over SSE
 * `GET /v1/stream` by the runtime's broadcast channel (P1-RT-05).
 *
 * Variants:
 *   - run.started        — a new run row was inserted
 *   - run.step.started   — a step row went `running`
 *   - run.step.completed — a step row was finalized (ok / failed / skipped)
 *   - run.completed      — the run row was finalized successfully
 *   - run.failed         — the run row was finalized with an error
 *   - event.emitted      — a downstream event row was created
 *   - task.created       — a human-gated task row was opened
 *   - task.resolved      — a human-gated task row was resolved
 *
 * `tenantId` is the platform-internal tenant id (NOT the slug); the SSE
 * handler tags subscribers by tenantId so cross-tenant leakage is
 * structurally impossible.
 *
 * All payloads include `at` (unix-ms) so consumers can render relative
 * timestamps. Optional fields collapse to `null` rather than `undefined`
 * to keep the wire shape stable across providers.
 */

import { z } from "zod";
import { CodeActAttestationStatus } from "./runs";

const Base = {
  tenantId: z.string(),
  at: z.number(),
};

const CodeActReceiptEventFields = {
  codeRan: z.boolean().nullable().optional(),
  codeExecuted: z.boolean().nullable().optional(),
  codeIsolation: z.enum(["worker_thread", "isolated_subprocess", "isolated_container"]).nullable().optional(),
  codeSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  codeAttestation: CodeActAttestationStatus.nullable().optional(),
  codeExecutionFailure: z.string().nullable().optional(),
} as const;

export const RunStartedEvent = z.object({
  type: z.literal("run.started"),
  ...Base,
  runId: z.string(),
  agentName: z.string(),
  triggerEvent: z.string().nullable(),
  subject: z.string().nullable(),
  correlationId: z.string(),
  // P2-FE-18 — surfaced so the portal can render the TEST badge instantly.
  testRun: z.boolean().optional(),
});

export const RunStepStartedEvent = z.object({
  type: z.literal("run.step.started"),
  ...Base,
  runId: z.string(),
  stepId: z.string(),
  ord: z.number(),
  name: z.string(),
  stepType: z.string(),
});

export const RunStepCompletedEvent = z.object({
  ...CodeActReceiptEventFields,
  type: z.literal("run.step.completed"),
  ...Base,
  runId: z.string(),
  stepId: z.string(),
  ord: z.number(),
  name: z.string(),
  stepType: z.string(),
  status: z.string(),
  durationMs: z.number().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  error: z.string().nullable(),
});

export const RunCompletedEvent = z.object({
  ...CodeActReceiptEventFields,
  type: z.literal("run.completed"),
  ...Base,
  runId: z.string(),
  durationMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  emittedEventId: z.string().nullable(),
});

export const RunFailedEvent = z.object({
  ...CodeActReceiptEventFields,
  type: z.literal("run.failed"),
  ...Base,
  runId: z.string(),
  errorMessage: z.string(),
});

/** A run was explicitly stopped by an operator. Kept separate from failed so
 * dashboards do not count deliberate intervention as a runtime error. */
export const RunCancelledEvent = z.object({
  type: z.literal("run.cancelled"),
  ...Base,
  runId: z.string(),
  reason: z.string(),
});

export const EventEmittedEvent = z.object({
  type: z.literal("event.emitted"),
  ...Base,
  eventId: z.string(),
  name: z.string(),
  subject: z.string().nullable(),
  sourceRunId: z.string().nullable(),
});

export const TaskCreatedEvent = z.object({
  type: z.literal("task.created"),
  ...Base,
  taskId: z.string(),
  runId: z.string().nullable(),
  taskType: z.string(),
  title: z.string(),
});

export const TaskResolvedEvent = z.object({
  type: z.literal("task.resolved"),
  ...Base,
  taskId: z.string(),
  decision: z.string(),
});

/**
 * `deployment.created` — emitted when a workflow manifest or tenant-code
 * deployment goes live. UC-V11-06: the operator portal fires a toast on
 * `kind: 'tenant_code'` so engineers see hot-reload land without manual
 * refresh.
 *
 * `kind` distinguishes:
 *   - "manifest"    → workflow manifest deploy (importer / editor save)
 *   - "tenant_code" → custom tenant code deploy (CLI `agentic deploy`)
 *
 * Backend emits via the broadcast channel after the file rename + Inngest
 * re-register completes (apps/api/src/services/reconcile-imports.ts +
 * apps/api/src/routes/v1/tenant-code.ts).
 */
export const DeploymentCreatedEvent = z.object({
  type: z.literal("deployment.created"),
  ...Base,
  deploymentId: z.string(),
  kind: z.enum(["manifest", "tenant_code"]),
  version: z.string(),
  workflowSlug: z.string().nullable(),
});

/** Structured copy of a line written to the per-run file log. This is the
 * real terminal transport: lifecycle events remain useful for cache
 * invalidation, while this variant carries the exact runtime log event and
 * fields that were persisted on disk. */
export const LogLineEvent = z.object({
  type: z.literal("log.line"),
  ...Base,
  runId: z.string(),
  correlationId: z.string(),
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  event: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

/** A mutation/authorization decision was durably appended to audit_log. */
export const AuditRecordedEvent = z.object({
  type: z.literal("audit.recorded"),
  ...Base,
  auditId: z.string(),
  action: z.string(),
  actorUserId: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  decision: z.enum(["allow", "deny"]).nullable(),
});

/** One provider call as captured by the platform-wide LLM telemetry sink. */
export const LlmCallCompletedEvent = z.object({
  type: z.literal("llm.call.completed"),
  ...Base,
  callId: z.string(),
  runId: z.string().nullable().optional(),
  purpose: z.string().nullable(),
  provider: z.string().nullable(),
  requestedModel: z.string().nullable(),
  servedModel: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  tokenSource: z.enum(["provider", "estimated_chars"]).nullable().optional(),
  latencyMs: z.number().nullable(),
  fallback: z.boolean().nullable(),
  ok: z.boolean().nullable(),
  failureReason: z.string().nullable(),
});

/** A tool dispatch completed. Runtime tool-use loops and code-agent tools use
 * the same shape so the monitoring UI can aggregate them together. */
export const ToolCallCompletedEvent = z.object({
  type: z.literal("tool.call.completed"),
  ...Base,
  runId: z.string(),
  correlationId: z.string(),
  agentName: z.string().nullable(),
  stepName: z.string().nullable(),
  toolName: z.string(),
  durationMs: z.number().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  /**
   * The endpoint this call actually reached, and the body it sent, when the
   * tool reports them. An operator being asked to trust that a system of
   * record was written to should be able to see the request rather than a
   * claim that one happened. Both are optional: only tools that talk to a
   * remote system have them.
   */
  url: z.string().nullable().optional(),
  request: z.string().nullable().optional(),
});

export const RunStreamEvent = z.discriminatedUnion("type", [
  RunStartedEvent,
  RunStepStartedEvent,
  RunStepCompletedEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunCancelledEvent,
  EventEmittedEvent,
  TaskCreatedEvent,
  TaskResolvedEvent,
  DeploymentCreatedEvent,
  LogLineEvent,
  AuditRecordedEvent,
  LlmCallCompletedEvent,
  ToolCallCompletedEvent,
]);
export type RunStreamEvent = z.infer<typeof RunStreamEvent>;
