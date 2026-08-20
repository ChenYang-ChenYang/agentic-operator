/**
 * Canonical production run engine for `BaseAgent.run()`, including multi-turn
 * tool-use loop. The engine appends one `steps` row per LLM call (`type: "logic"`)
 * and one per tool dispatch (`type: "tool"`), aggregates tokens across turns,
 * and persists prompt + response sidecars under `data/artifacts/<runId>/`.
 *
 * Single-shot agents (default `maxSteps = 1`) take exactly one provider turn.
 *
 * Failure modes are caught and recorded; the LLMError is re-thrown for the
 * caller (HTTP layer) to convert into a 4xx/5xx envelope.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";

import {
  agents,
  agentVersions,
  deployments,
  getDb,
  llmTurns,
  runs,
  steps,
  tenants,
  workflows,
} from "@agentic/db";
import type { DB } from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  logPathFor,
  publishStreamEvent,
  registerStepArtifactEvidence,
  writeRunLog,
} from "@agentic/runtime";
import type { ProviderId } from "@agentic/contracts";
import {
  LLMError,
  currentUsageAttribution,
  isLLMError,
  type ChatContentBlock,
  type ChatMessage,
  type ChatResponse,
  type ToolCall,
  type ToolResultBlock,
} from "@agentic/llm-gateway";

import type { BaseAgent } from "./base-agent";
import type {
  AgentContext,
  AgentResult,
  AgentScope,
  ToolHandlerResult,
} from "./types";
import { getGateway } from "./gateway-host";

const SYSTEM_TENANT_SLUG = "__system";

export class RunCancelledError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`run ${runId} cancelled by operator`);
    this.name = "RunCancelledError";
    this.runId = runId;
  }
}

function isRunCancelled(db: DB, runId: string): boolean {
  const row = db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .all()[0];
  return row?.status === "cancelled";
}

function appendRunDiagnostic(db: DB, runId: string, diagnostic: string): void {
  try {
    const row = db
      .select({ errorMessage: runs.errorMessage })
      .from(runs)
      .where(eq(runs.id, runId))
      .all()[0];
    const next = [row?.errorMessage, diagnostic]
      .filter(Boolean)
      .join("; ")
      .slice(0, 4_000);
    db.update(runs).set({ errorMessage: next }).where(eq(runs.id, runId)).run();
  } catch {
    // Never replace the authoritative terminal outcome with a secondary
    // diagnostic-write error.
  }
}

function logFailureDiagnostic(event: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `log_persist_failed(${event}): ${message}`;
}

function artifactsRoot(): string {
  return process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
}

async function writeArtifact(
  runId: string,
  name: string,
  payload: unknown,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) {
    throw new Error(`Invalid run id for artifact path: ${runId}`);
  }
  const dir = path.join(artifactsRoot(), runId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized === undefined) {
    throw new TypeError(`Artifact '${name}' has no JSON representation`);
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return filePath;
}

function resolveTenantId(
  db: DB,
  slug: string,
  provider: ProviderId,
): { id: string; slug: string } {
  const row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  if (!row) {
    throw new LLMError(
      `Tenant '${slug}' not found — bootstrap must run first`,
      "bad_request",
      provider,
    );
  }
  return { id: row.id, slug: row.slug };
}

/** Tenant-scoped lookup half of resolveAgentRow: agents row + live code_agent deployment
 *  within ONE tenant. Returns null when either half is missing (caller decides fallback);
 *  still throws on an ambiguous double-binding — that's a data bug, not a fallback case. */
function lookupAgentRow(
  db: DB,
  agentName: string,
  tenantId: string,
  provider: ProviderId,
): { agentId: string; agentVersionId: string | null } | null {
  const agentRows = db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(and(eq(agents.kebabId, agentName), eq(workflows.tenantId, tenantId)))
    .all();

  if (agentRows.length === 0) return null;
  if (agentRows.length > 1) {
    throw new LLMError(
      `Agent '${agentName}' has multiple DB bindings in tenant '${tenantId}'`,
      "bad_request",
      provider,
    );
  }

  const agentRow = agentRows[0]!;
  const av = db
    .select({ id: agentVersions.id })
    .from(deployments)
    .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        eq(deployments.target, "code_agent"),
        eq(deployments.status, "live"),
        eq(agentVersions.agentId, agentRow.id),
      ),
    )
    .orderBy(desc(deployments.deployedAt), desc(deployments.id))
    .all()[0];

  if (!av) return null;
  return { agentId: agentRow.id, agentVersionId: av.id };
}

function resolveAgentRow(
  db: DB,
  agentName: string,
  tenantId: string,
  scope: AgentScope,
  provider: ProviderId,
): { agentId: string; agentVersionId: string | null } {
  const definitionTenantId =
    scope === "system"
      ? db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.slug, SYSTEM_TENANT_SLUG))
          .all()[0]?.id
      : tenantId;
  const hit = definitionTenantId
    ? lookupAgentRow(db, agentName, definitionTenantId, provider)
    : null;
  if (hit) return hit;
  throw new LLMError(
    `Agent '${agentName}' has no live ${scope} binding — bootstrap must run first`,
    "bad_request",
    provider,
  );
}

function contentToToolUseBlocks(
  toolCalls: ToolCall[] | undefined,
): ChatContentBlock[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls.map((tc) => ({
    type: "tool_use" as const,
    id: tc.id,
    name: tc.name,
    input: tc.input,
  }));
}

function buildAssistantTurnContent(
  text: string,
  toolCalls: ToolCall[] | undefined,
): string | ChatContentBlock[] {
  const toolBlocks = contentToToolUseBlocks(toolCalls);
  if (toolBlocks.length === 0) return text;
  const blocks: ChatContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  blocks.push(...toolBlocks);
  return blocks;
}

function buildToolResultMessage(
  toolCalls: ToolCall[],
  results: Array<ToolHandlerResult>,
): ChatMessage {
  const blocks: ToolResultBlock[] = toolCalls.map((tc, idx) => {
    const res = results[idx]!;
    const body = res.ok
      ? JSON.stringify(res.data ?? null)
      : JSON.stringify({
          error: res.error ?? { code: "unknown", message: "tool failed" },
        });
    return {
      type: "tool_result",
      tool_use_id: tc.id,
      content: body,
      ...(res.ok ? {} : { is_error: true }),
    };
  });
  return { role: "tool", content: blocks };
}

function validateProviderToolCalls(
  agentName: string,
  provider: ProviderId,
  toolCalls: ToolCall[],
): void {
  const ids = new Set<string>();
  for (const call of toolCalls) {
    if (!call.id || !call.id.trim() || !call.name || !call.name.trim()) {
      throw new LLMError(
        `Provider returned a malformed tool call for agent '${agentName}'`,
        "provider_error",
        provider,
      );
    }
    if (ids.has(call.id)) {
      throw new LLMError(
        `Provider returned duplicate tool-call id '${call.id}' for agent '${agentName}'`,
        "provider_error",
        provider,
      );
    }
    ids.add(call.id);
    if (
      call.input === null ||
      typeof call.input !== "object" ||
      Array.isArray(call.input)
    ) {
      throw new LLMError(
        `Provider returned non-object input for tool '${call.name}'`,
        "provider_error",
        provider,
      );
    }
  }
}

export async function executeAgentRun<TInput, TOutput>(
  agent: BaseAgent<TInput, TOutput>,
  input: TInput,
  ctx: AgentContext,
): Promise<AgentResult<TOutput>> {
  const db = getDb();
  const gateway = getGateway();
  const requestedProvider =
    ctx.provider ?? agent.defaultProvider ?? gateway.defaultProvider;
  const requestedModel =
    ctx.model ?? agent.defaultModel ?? gateway.defaultModel;
  const requestedTenantSlug = ctx.tenantSlug || SYSTEM_TENANT_SLUG;
  const tenantSlug =
    agent.scope === "system" && agent.runScope === "owner"
      ? SYSTEM_TENANT_SLUG
      : requestedTenantSlug;
  const { id: tenantId } = resolveTenantId(db, tenantSlug, requestedProvider);
  const { agentId, agentVersionId } = resolveAgentRow(
    db,
    agent.name,
    tenantId,
    agent.scope,
    requestedProvider,
  );

  const runId = ctx.runId?.trim() || makeId("run");
  const correlationId = ctx.correlationId ?? makeId("cor");
  const parentRunId = ctx.parentRunId?.trim() || undefined;
  const runtimeRole = ctx.runtimeRole?.trim() || "primary";
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(runtimeRole)) {
    throw new LLMError(
      `Invalid runtimeRole ${JSON.stringify(runtimeRole)}`,
      "bad_request",
      requestedProvider,
    );
  }
  if (parentRunId) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(parentRunId) || parentRunId === runId) {
      throw new LLMError(
        `Invalid parent run '${parentRunId}' for nested run '${runId}'`,
        "bad_request",
        requestedProvider,
      );
    }
    const parent = db
      .select({
        tenantId: runs.tenantId,
        correlationId: runs.correlationId,
      })
      .from(runs)
      .where(eq(runs.id, parentRunId))
      .all()[0];
    if (
      !parent ||
      parent.tenantId !== tenantId ||
      parent.correlationId !== correlationId
    ) {
      throw new LLMError(
        `Nested run parent '${parentRunId}' is missing or outside the locked tenant/correlation`,
        "bad_request",
        requestedProvider,
      );
    }
  }
  const effectiveCtx: AgentContext = {
    ...ctx,
    tenantSlug,
    runId,
    correlationId,
    parentRunId,
    runtimeRole,
  };
  const startedAt = Date.now();
  const runLogPath = logPathFor(
    { tenantSlug, tenantId, runId, correlationId, agentName: agent.name },
    new Date(startedAt),
  );
  const logCtx = {
    tenantSlug,
    tenantId,
    runId,
    correlationId,
    agentName: agent.name,
    logPath: runLogPath,
  };
  const testRun = ctx.testRun === true;
  // Request-scoped usage attribution (Kenny's usage-ledger spine): stamp the
  // originating API request/interaction onto the run row for billing joins.
  const usageAttribution = currentUsageAttribution();

  const reserved = db
    .select({
      tenantId: runs.tenantId,
      agentId: runs.agentId,
      agentVersionId: runs.agentVersionId,
      parentRunId: runs.parentRunId,
      correlationId: runs.correlationId,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .all()[0];
  if (reserved) {
    if (
      reserved.tenantId !== tenantId ||
      reserved.agentId !== agentId ||
      reserved.correlationId !== correlationId ||
      (reserved.parentRunId ?? undefined) !== parentRunId
    ) {
      throw new LLMError(
        `Reserved run '${runId}' cannot be started (status=${reserved.status})`,
        "bad_request",
        requestedProvider,
      );
    }
    if (reserved.status === "cancelled") throw new RunCancelledError(runId);
    if (reserved.status !== "queued") {
      throw new LLMError(
        `Reserved run '${runId}' cannot be started (status=${reserved.status})`,
        "bad_request",
        requestedProvider,
      );
    }
    db.update(runs)
      .set({
        status: "running",
        startedAt: new Date(startedAt),
        correlationId,
        parentRunId: parentRunId ?? null,
        agentVersionId: agentVersionId ?? null,
        logPath: runLogPath,
        isTest: testRun,
        errorMessage: null,
        requestId: usageAttribution?.requestId,
        interactionId: usageAttribution?.interactionId,
        productSurface: usageAttribution?.productSurface,
        productAction: usageAttribution?.productAction,
        requestedBy:
          usageAttribution?.actorType === "user"
            ? usageAttribution.actorId
            : undefined,
      })
      .where(eq(runs.id, runId))
      .run();
  } else {
    db.insert(runs)
      .values({
        id: runId,
        tenantId,
        agentId,
        agentVersionId: agentVersionId ?? null,
        triggerEventId: null,
        parentRunId: parentRunId ?? null,
        status: "running",
        startedAt: new Date(startedAt),
        correlationId,
        subject: null,
        logPath: runLogPath,
        isTest: testRun,
        requestId: usageAttribution?.requestId,
        interactionId: usageAttribution?.interactionId,
        productSurface: usageAttribution?.productSurface,
        productAction: usageAttribution?.productAction,
        requestedBy:
          usageAttribution?.actorType === "user"
            ? usageAttribution.actorId
            : undefined,
      })
      .run();
  }

  try {
    publishStreamEvent({
      type: "run.started",
      tenantId,
      at: startedAt,
      runId,
      agentName: agent.name,
      triggerEvent: null,
      subject: null,
      correlationId,
      testRun,
    });
  } catch {
    /* broadcast best-effort */
  }

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let completedProviderCalls = 0;
  let lastProvider: ProviderId = requestedProvider;
  let lastModel: string | null = requestedModel ?? null;
  let ord = 0;
  let finalText = "";
  let activeStep: {
    id: string;
    ord: number;
    name: string;
    type: string;
    startedAt: number;
    provider: string | null;
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
  } | null = null;

  try {
    await writeRunLog(logCtx, "INFO", "run.start", {
      agent: agent.name,
      kind: "code",
      invocation_id: effectiveCtx.invocationId ?? "—",
      parent_run_id: parentRunId ?? "—",
      runtime_role: runtimeRole,
      test_run: testRun,
    });

    const provider: ProviderId = requestedProvider;
    const model = effectiveCtx.model ?? agent.defaultModel;

    const messages: ChatMessage[] = await agent._buildMessages(
      input,
      effectiveCtx,
    );

    const tools = agent.getTools(effectiveCtx);
    const toolHandlers = agent.getToolHandlers(effectiveCtx);
    if (!Number.isSafeInteger(agent.maxSteps) || agent.maxSteps < 1) {
      throw new LLMError(
        `Agent '${agent.name}' declares invalid maxSteps=${String(agent.maxSteps)}`,
        "bad_request",
        provider,
      );
    }
    const maxSteps = agent.maxSteps;
    const advertisedToolNames = new Set<string>();
    for (const tool of tools) {
      if (!tool.name || !tool.name.trim()) {
        throw new LLMError(
          `Agent '${agent.name}' advertises a tool with an empty name`,
          "bad_request",
          provider,
        );
      }
      if (advertisedToolNames.has(tool.name)) {
        throw new LLMError(
          `Agent '${agent.name}' advertises duplicate tool '${tool.name}'`,
          "bad_request",
          provider,
        );
      }
      advertisedToolNames.add(tool.name);
    }

    for (let turn = 0; turn < maxSteps; turn++) {
      if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);
      ord += 1;
      const stepId = makeId("stp");
      const stepStartedAt = Date.now();

      db.insert(steps)
        .values({
          id: stepId,
          runId,
          ord,
          name: "llm.call",
          type: "logic",
          status: "running",
          startedAt: new Date(stepStartedAt),
        })
        .run();
      activeStep = {
        id: stepId,
        ord,
        name: "llm.call",
        type: "logic",
        startedAt: stepStartedAt,
        provider: null,
        model: null,
        tokensIn: null,
        tokensOut: null,
      };

      try {
        publishStreamEvent({
          type: "run.step.started",
          tenantId,
          at: stepStartedAt,
          runId,
          stepId,
          ord,
          name: "llm.call",
          stepType: "logic",
        });
      } catch {
        /* broadcast best-effort */
      }

      const inputArtifact = await writeArtifact(
        runId,
        `step-${ord}-input.json`,
        {
          agent: agent.name,
          runtimeRole,
          parentRunId: parentRunId ?? null,
          provider,
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        },
      );
      await registerStepArtifactEvidence({
        tenantId,
        runId,
        stepId,
        role: "step_input",
        filePath: inputArtifact,
        metadata: { source: "code_agent", step: "llm.call", turn },
      });
      db.update(steps)
        .set({ inputRef: inputArtifact })
        .where(eq(steps.id, stepId))
        .run();

      if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);

      const response: ChatResponse = await gateway.chat({
        messages,
        provider,
        providers: effectiveCtx.providers,
        model: model ?? undefined,
        maxTokens: agent.maxOutputTokens,
        tools: tools.length > 0 ? tools : undefined,
        jsonMode: agent.outputSchema ? true : undefined,
        tenantId,
        runId,
        purpose: `agent:${agent.name}/role:${runtimeRole}/turn:${turn}`,
        // AI-settings threading (merged from Kenny's runtime v2): per-invocation
        // overrides win over the agent's declared defaults.
        reasoning: effectiveCtx.reasoning ?? agent.defaultReasoning,
        verbosity: effectiveCtx.verbosity ?? agent.defaultVerbosity,
        store: effectiveCtx.store ?? agent.storeResponses,
        routing: {
          taskType: effectiveCtx.taskClass ?? agent.taskClass,
        },
      });

      // Account as soon as the provider returns. Artifact writes, output
      // parsing, or later tool execution can still fail, but those failures
      // must not erase tokens that were actually consumed.
      totalTokensIn += response.tokensIn ?? 0;
      totalTokensOut += response.tokensOut ?? 0;
      completedProviderCalls += 1;
      lastProvider = response.provider;
      lastModel = response.model;
      activeStep = activeStep
        ? {
            ...activeStep,
            provider: response.provider,
            model: response.model,
            tokensIn: response.tokensIn ?? null,
            tokensOut: response.tokensOut ?? null,
          }
        : null;

      const toolCalls = response.toolCalls ?? [];
      const responseRecordedAt = Date.now();
      db.update(steps)
        .set({
          provider: response.provider,
          model: response.model,
          tokensIn: response.tokensIn ?? null,
          tokensOut: response.tokensOut ?? null,
        })
        .where(eq(steps.id, stepId))
        .run();

      // Preserve both evidence sinks independently. An unavailable artifact
      // volume must not erase the provider turn from telemetry, and a DB
      // telemetry failure must not prevent the raw sidecar from being kept.
      let outputArtifact: string | undefined;
      let artifactError: unknown;
      try {
        outputArtifact = await writeArtifact(runId, `step-${ord}-output.json`, {
          text: response.text,
          provider: response.provider,
          model: response.model,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          finishReason: response.finishReason,
          toolCalls: response.toolCalls ?? null,
          latencyMs: response.latencyMs,
        });
      } catch (error) {
        artifactError = error;
      }

      let telemetryError: unknown;
      try {
        db.insert(llmTurns)
          .values({
            id: makeId("llt"),
            tenantId,
            runId,
            stepId,
            ord: turn,
            promptPreview: JSON.stringify(messages).slice(0, 4_000),
            responseText: (response.text ?? "").slice(0, 8_000),
            reasoning: null,
            toolCallsJson: response.toolCalls ?? [],
            provider: response.provider,
            model: response.model,
            tokensIn: response.tokensIn ?? null,
            tokensOut: response.tokensOut ?? null,
            finishReason: response.finishReason ?? null,
            latencyMs: response.latencyMs ?? null,
            correlationId,
          })
          .run();
      } catch (error) {
        telemetryError = error;
      }
      if (outputArtifact) {
        await registerStepArtifactEvidence({
          tenantId,
          runId,
          stepId,
          role: "step_output",
          filePath: outputArtifact,
          metadata: { source: "code_agent", step: "llm.call", turn },
        });
        db.update(steps)
          .set({ outputRef: outputArtifact })
          .where(eq(steps.id, stepId))
          .run();
      }
      if (artifactError && telemetryError) {
        throw new AggregateError(
          [artifactError, telemetryError],
          "Provider response artifact and llm-turn telemetry both failed to persist",
        );
      }
      if (artifactError) throw artifactError;
      if (telemetryError) throw telemetryError;

      await writeRunLog(logCtx, "INFO", "llm.call", {
        step: "llm.call",
        provider: response.provider,
        model: response.model,
        tokens_in: response.tokensIn ?? 0,
        tokens_out: response.tokensOut ?? 0,
        duration_ms: responseRecordedAt - stepStartedAt,
      });

      if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);

      if (toolCalls.length === 0 && !response.text.trim()) {
        throw new LLMError(
          `Provider ${response.provider}/${response.model} returned an empty response`,
          "provider_error",
          response.provider,
        );
      }
      validateProviderToolCalls(agent.name, response.provider, toolCalls);
      if (toolCalls.length > 0 && turn === maxSteps - 1) {
        throw new LLMError(
          `Agent '${agent.name}' exhausted maxSteps=${maxSteps} before completing its tool-use loop`,
          "bad_request",
          response.provider,
        );
      }

      const stepEndedAt = Date.now();
      db.update(steps)
        .set({
          status: "ok",
          endedAt: new Date(stepEndedAt),
          durationMs: stepEndedAt - stepStartedAt,
        })
        .where(eq(steps.id, stepId))
        .run();
      try {
        publishStreamEvent({
          type: "run.step.completed",
          tenantId,
          at: stepEndedAt,
          runId,
          stepId,
          ord,
          name: "llm.call",
          stepType: "logic",
          status: "ok",
          durationMs: stepEndedAt - stepStartedAt,
          provider: response.provider,
          model: response.model,
          tokensIn: response.tokensIn ?? null,
          tokensOut: response.tokensOut ?? null,
          error: null,
        });
      } catch {
        /* broadcast best-effort */
      }
      activeStep = null;

      if (toolCalls.length === 0) {
        finalText = response.text;
        break;
      }

      // Append assistant turn (carries the tool_use blocks).
      messages.push({
        role: "assistant",
        content: buildAssistantTurnContent(response.text, toolCalls),
      });

      // Dispatch tool calls in order, one tool step per call.
      const results: ToolHandlerResult[] = [];
      for (const tc of toolCalls) {
        ord += 1;
        const toolStepId = makeId("stp");
        const toolStartedAt = Date.now();
        db.insert(steps)
          .values({
            id: toolStepId,
            runId,
            ord,
            name: tc.name,
            type: "tool",
            status: "running",
            startedAt: new Date(toolStartedAt),
          })
          .run();
        activeStep = {
          id: toolStepId,
          ord,
          name: tc.name,
          type: "tool",
          startedAt: toolStartedAt,
          provider: null,
          model: null,
          tokensIn: null,
          tokensOut: null,
        };
        try {
          publishStreamEvent({
            type: "run.step.started",
            tenantId,
            at: toolStartedAt,
            runId,
            stepId: toolStepId,
            ord,
            name: tc.name,
            stepType: "tool",
          });
        } catch {
          /* broadcast best-effort */
        }
        const toolInputArtifact = await writeArtifact(
          runId,
          `step-${ord}-input.json`,
          { tool: tc.name, input: tc.input },
        );
        await registerStepArtifactEvidence({
          tenantId,
          runId,
          stepId: toolStepId,
          role: "step_input",
          filePath: toolInputArtifact,
          metadata: { source: "code_agent", step: tc.name },
        });
        db.update(steps)
          .set({ inputRef: toolInputArtifact })
          .where(eq(steps.id, toolStepId))
          .run();
        if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);

        const handlerCandidate =
          advertisedToolNames.has(tc.name) &&
          Object.hasOwn(toolHandlers, tc.name)
            ? toolHandlers[tc.name]
            : undefined;
        const handler =
          typeof handlerCandidate === "function" ? handlerCandidate : undefined;
        let res: ToolHandlerResult;
        try {
          if (!advertisedToolNames.has(tc.name)) {
            res = {
              ok: false,
              error: {
                code: "tool_not_advertised",
                message: `Provider requested unadvertised tool ${tc.name}`,
              },
            };
          } else if (!handler) {
            res = {
              ok: false,
              error: {
                code: "tool_handler_missing",
                message: `No handler for ${tc.name}`,
              },
            };
          } else {
            const candidate: unknown = await handler(tc.input, effectiveCtx);
            res =
              candidate &&
              typeof candidate === "object" &&
              typeof (candidate as { ok?: unknown }).ok === "boolean"
                ? (candidate as ToolHandlerResult)
                : {
                    ok: false,
                    error: {
                      code: "tool_result_invalid",
                      message: `Handler for ${tc.name} returned an invalid result envelope`,
                    },
                  };
          }
        } catch (err) {
          res = {
            ok: false,
            error: {
              code: "tool_threw",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        const toolOutputArtifact = await writeArtifact(
          runId,
          `step-${ord}-output.json`,
          res,
        );
        await registerStepArtifactEvidence({
          tenantId,
          runId,
          stepId: toolStepId,
          role: "step_output",
          filePath: toolOutputArtifact,
          metadata: { source: "code_agent", step: tc.name },
        });
        db.update(steps)
          .set({ outputRef: toolOutputArtifact })
          .where(eq(steps.id, toolStepId))
          .run();
        if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);

        const toolEndedAt = Date.now();
        db.update(steps)
          .set({
            status: res.ok ? "ok" : "failed",
            endedAt: new Date(toolEndedAt),
            durationMs: toolEndedAt - toolStartedAt,
            error: res.ok
              ? null
              : `${res.error?.code ?? "tool_failed"}: ${res.error?.message ?? ""}`,
          })
          .where(eq(steps.id, toolStepId))
          .run();
        try {
          publishStreamEvent({
            type: "run.step.completed",
            tenantId,
            at: toolEndedAt,
            runId,
            stepId: toolStepId,
            ord,
            name: tc.name,
            stepType: "tool",
            status: res.ok ? "ok" : "failed",
            durationMs: toolEndedAt - toolStartedAt,
            provider: null,
            model: null,
            tokensIn: null,
            tokensOut: null,
            error: res.ok
              ? null
              : `${res.error?.code ?? "tool_failed"}: ${res.error?.message ?? ""}`,
          });
        } catch {
          /* broadcast best-effort */
        }
        activeStep = null;
        await writeRunLog(logCtx, res.ok ? "INFO" : "ERROR", "tool.call", {
          step: tc.name,
          tool: tc.name,
          ok: res.ok,
          duration_ms: toolEndedAt - toolStartedAt,
          error: res.ok ? undefined : res.error?.message,
        });
        results.push(res);
      }

      // Append the tool result message for the next LLM turn.
      messages.push(buildToolResultMessage(toolCalls, results));
    }

    // Optional output validation + one repair retry.
    if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);
    let output: TOutput;
    if (agent.outputSchema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(finalText);
      } catch {
        parsed = undefined;
      }
      const validation = agent.outputSchema.safeParse(parsed);
      if (validation.success) {
        output = validation.data as TOutput;
      } else {
        // Repair turn: re-prompt with the issues and one more LLM call.
        ord += 1;
        const repairStepId = makeId("stp");
        const repairStartedAt = Date.now();
        db.insert(steps)
          .values({
            id: repairStepId,
            runId,
            ord,
            name: "llm.repair",
            type: "logic",
            status: "running",
            startedAt: new Date(repairStartedAt),
          })
          .run();
        activeStep = {
          id: repairStepId,
          ord,
          name: "llm.repair",
          type: "logic",
          startedAt: repairStartedAt,
          provider: null,
          model: null,
          tokensIn: null,
          tokensOut: null,
        };
        try {
          publishStreamEvent({
            type: "run.step.started",
            tenantId,
            at: repairStartedAt,
            runId,
            stepId: repairStepId,
            ord,
            name: "llm.repair",
            stepType: "logic",
          });
        } catch {
          /* broadcast best-effort */
        }
        messages.push({
          role: "assistant",
          content: finalText,
        });
        messages.push({
          role: "user",
          content: `Your previous reply did not match the required schema. Issues: ${JSON.stringify(validation.error.issues)}. Reply with strict JSON only.`,
        });
        const repairInputArtifact = await writeArtifact(
          runId,
          `step-${ord}-input.json`,
          {
            agent: agent.name,
            provider,
            model,
            messages,
            jsonMode: true,
          },
        );
        await registerStepArtifactEvidence({
          tenantId,
          runId,
          stepId: repairStepId,
          role: "step_input",
          filePath: repairInputArtifact,
          metadata: { source: "code_agent", step: "llm.repair" },
        });
        db.update(steps)
          .set({ inputRef: repairInputArtifact })
          .where(eq(steps.id, repairStepId))
          .run();
        if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);

        const repair = await gateway.chat({
          messages,
          provider,
          providers: effectiveCtx.providers,
          model: model ?? undefined,
          maxTokens: agent.maxOutputTokens,
          jsonMode: true,
          tenantId,
          runId,
          purpose: `agent:${agent.name}/role:${runtimeRole}/repair`,
        });
        totalTokensIn += repair.tokensIn ?? 0;
        totalTokensOut += repair.tokensOut ?? 0;
        completedProviderCalls += 1;
        lastProvider = repair.provider;
        lastModel = repair.model;
        activeStep = activeStep
          ? {
              ...activeStep,
              provider: repair.provider,
              model: repair.model,
              tokensIn: repair.tokensIn ?? null,
              tokensOut: repair.tokensOut ?? null,
            }
          : null;
        const repairRecordedAt = Date.now();
        db.update(steps)
          .set({
            provider: repair.provider,
            model: repair.model,
            tokensIn: repair.tokensIn ?? null,
            tokensOut: repair.tokensOut ?? null,
          })
          .where(eq(steps.id, repairStepId))
          .run();
        let repairOutputArtifact: string | undefined;
        let repairArtifactError: unknown;
        try {
          repairOutputArtifact = await writeArtifact(
            runId,
            `step-${ord}-output.json`,
            {
              text: repair.text,
              provider: repair.provider,
              model: repair.model,
              tokensIn: repair.tokensIn,
              tokensOut: repair.tokensOut,
              finishReason: repair.finishReason,
              toolCalls: repair.toolCalls ?? null,
              latencyMs: repair.latencyMs,
            },
          );
        } catch (error) {
          repairArtifactError = error;
        }
        let repairTelemetryError: unknown;
        try {
          db.insert(llmTurns)
            .values({
              id: makeId("llt"),
              tenantId,
              runId,
              stepId: repairStepId,
              ord: completedProviderCalls - 1,
              promptPreview: JSON.stringify(messages).slice(0, 4_000),
              responseText: (repair.text ?? "").slice(0, 8_000),
              reasoning: null,
              toolCallsJson: repair.toolCalls ?? [],
              provider: repair.provider,
              model: repair.model,
              tokensIn: repair.tokensIn ?? null,
              tokensOut: repair.tokensOut ?? null,
              finishReason: repair.finishReason ?? null,
              latencyMs: repair.latencyMs ?? null,
              correlationId,
            })
            .run();
        } catch (error) {
          repairTelemetryError = error;
        }
        if (repairOutputArtifact) {
          await registerStepArtifactEvidence({
            tenantId,
            runId,
            stepId: repairStepId,
            role: "step_output",
            filePath: repairOutputArtifact,
            metadata: { source: "code_agent", step: "llm.repair" },
          });
          db.update(steps)
            .set({ outputRef: repairOutputArtifact })
            .where(eq(steps.id, repairStepId))
            .run();
        }
        if (repairArtifactError && repairTelemetryError) {
          throw new AggregateError(
            [repairArtifactError, repairTelemetryError],
            "Repair response artifact and llm-turn telemetry both failed to persist",
          );
        }
        if (repairArtifactError) throw repairArtifactError;
        if (repairTelemetryError) throw repairTelemetryError;
        await writeRunLog(logCtx, "INFO", "llm.call", {
          step: "llm.repair",
          provider: repair.provider,
          model: repair.model,
          tokens_in: repair.tokensIn ?? 0,
          tokens_out: repair.tokensOut ?? 0,
          duration_ms: repairRecordedAt - repairStartedAt,
        });
        if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);
        if (repair.toolCalls?.length) {
          throw new LLMError(
            `Agent '${agent.name}' repair response unexpectedly requested tools`,
            "bad_request",
            repair.provider,
          );
        }
        let repaired: unknown;
        try {
          repaired = JSON.parse(repair.text);
        } catch {
          repaired = undefined;
        }
        const validation2 = agent.outputSchema.safeParse(repaired);
        if (!validation2.success) {
          throw new LLMError(
            `output_parse_error: ${JSON.stringify(validation2.error.issues)}`,
            "bad_request",
            lastProvider as ProviderId,
          );
        }
        const repairEndedAt = Date.now();
        db.update(steps)
          .set({
            status: "ok",
            endedAt: new Date(repairEndedAt),
            durationMs: repairEndedAt - repairStartedAt,
          })
          .where(eq(steps.id, repairStepId))
          .run();
        try {
          publishStreamEvent({
            type: "run.step.completed",
            tenantId,
            at: repairEndedAt,
            runId,
            stepId: repairStepId,
            ord,
            name: "llm.repair",
            stepType: "logic",
            status: "ok",
            durationMs: repairEndedAt - repairStartedAt,
            provider: repair.provider,
            model: repair.model,
            tokensIn: repair.tokensIn ?? null,
            tokensOut: repair.tokensOut ?? null,
            error: null,
          });
        } catch {
          /* broadcast best-effort */
        }
        activeStep = null;
        output = validation2.data as TOutput;
        finalText = repair.text;
      }
    } else {
      output = await agent._parseOutput(finalText, effectiveCtx);
    }

    if (isRunCancelled(db, runId)) throw new RunCancelledError(runId);
    if (completedProviderCalls === 0 || !lastModel?.trim()) {
      throw new LLMError(
        `Agent '${agent.name}' completed without provider/model evidence`,
        "provider_error",
        lastProvider,
      );
    }

    const runEndedAt = Date.now();
    db.update(runs)
      .set({
        status: "ok",
        endedAt: new Date(runEndedAt),
        durationMs: runEndedAt - startedAt,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        model: lastModel,
      })
      .where(eq(runs.id, runId))
      .run();

    await writeRunLog(logCtx, "INFO", "run.ok", {
      agent: agent.name,
      provider: lastProvider,
      model: lastModel,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      duration_ms: runEndedAt - startedAt,
    });
    try {
      publishStreamEvent({
        type: "run.completed",
        tenantId,
        at: runEndedAt,
        runId,
        durationMs: runEndedAt - startedAt,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        emittedEventId: null,
      });
    } catch {
      /* broadcast best-effort */
    }

    return {
      runId,
      status: "ok",
      output,
      provider: lastProvider,
      model: lastModel,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      durationMs: runEndedAt - startedAt,
      steps: ord,
      testRun,
    };
  } catch (err) {
    if (err instanceof RunCancelledError) {
      const cancelledAt = Date.now();
      if (activeStep) {
        const cancelledStep = activeStep;
        db.update(steps)
          .set({
            status: "skipped",
            endedAt: new Date(cancelledAt),
            durationMs: cancelledAt - cancelledStep.startedAt,
            error: "cancelled_by_operator",
            provider: cancelledStep.provider,
            model: cancelledStep.model,
            tokensIn: cancelledStep.tokensIn,
            tokensOut: cancelledStep.tokensOut,
          })
          .where(eq(steps.id, cancelledStep.id))
          .run();
        try {
          publishStreamEvent({
            type: "run.step.completed",
            tenantId,
            at: cancelledAt,
            runId,
            stepId: cancelledStep.id,
            ord: cancelledStep.ord,
            name: cancelledStep.name,
            stepType: cancelledStep.type,
            status: "skipped",
            durationMs: cancelledAt - cancelledStep.startedAt,
            provider: cancelledStep.provider,
            model: cancelledStep.model,
            tokensIn: cancelledStep.tokensIn,
            tokensOut: cancelledStep.tokensOut,
            error: "cancelled_by_operator",
          });
        } catch {
          /* broadcast best-effort */
        }
        activeStep = null;
      }
      if (completedProviderCalls > 0) {
        db.update(runs)
          .set({
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            model: lastModel,
          })
          .where(eq(runs.id, runId))
          .run();
      }
      try {
        await writeRunLog(logCtx, "INFO", "run.cancelled", {
          agent: agent.name,
          reason: "operator_stop",
          provider_calls: completedProviderCalls,
          tokens_in: totalTokensIn,
          tokens_out: totalTokensOut,
        });
      } catch (logError) {
        appendRunDiagnostic(
          db,
          runId,
          logFailureDiagnostic("run.cancelled", logError),
        );
      }
      throw err;
    }

    const llm = isLLMError(err)
      ? err
      : new LLMError(
          err instanceof Error ? err.message : String(err),
          "provider_error",
          lastProvider,
          err,
        );

    const runEndedAt = Date.now();
    if (activeStep) {
      const failedStep = activeStep;
      db.update(steps)
        .set({
          status: "failed",
          endedAt: new Date(runEndedAt),
          durationMs: runEndedAt - failedStep.startedAt,
          error: `${llm.code}: ${llm.message}`,
          provider: failedStep.provider,
          model: failedStep.model,
          tokensIn: failedStep.tokensIn,
          tokensOut: failedStep.tokensOut,
        })
        .where(eq(steps.id, failedStep.id))
        .run();
      try {
        publishStreamEvent({
          type: "run.step.completed",
          tenantId,
          at: runEndedAt,
          runId,
          stepId: failedStep.id,
          ord: failedStep.ord,
          name: failedStep.name,
          stepType: failedStep.type,
          status: "failed",
          durationMs: runEndedAt - failedStep.startedAt,
          provider: failedStep.provider,
          model: failedStep.model,
          tokensIn: failedStep.tokensIn,
          tokensOut: failedStep.tokensOut,
          error: `${llm.code}: ${llm.message}`,
        });
      } catch {
        /* broadcast best-effort */
      }
      activeStep = null;
    }
    db.update(runs)
      .set({
        status: "failed",
        endedAt: new Date(runEndedAt),
        durationMs: runEndedAt - startedAt,
        tokensIn: completedProviderCalls > 0 ? totalTokensIn : null,
        tokensOut: completedProviderCalls > 0 ? totalTokensOut : null,
        model: completedProviderCalls > 0 ? lastModel : null,
        errorMessage: `${llm.code}: ${llm.message}`,
      })
      .where(eq(runs.id, runId))
      .run();

    try {
      await writeRunLog(logCtx, "ERROR", "run.fail", {
        agent: agent.name,
        code: llm.code,
        provider: llm.provider,
        message: llm.message,
      });
    } catch (logError) {
      appendRunDiagnostic(
        db,
        runId,
        logFailureDiagnostic("run.fail", logError),
      );
    }
    try {
      publishStreamEvent({
        type: "run.failed",
        tenantId,
        at: runEndedAt,
        runId,
        errorMessage: `${llm.code}: ${llm.message}`,
      });
    } catch {
      /* broadcast best-effort */
    }

    throw llm;
  }
}
