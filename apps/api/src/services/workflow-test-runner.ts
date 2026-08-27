import { makeId } from "@agentic/shared";
import {
  AgentDefinitionV2Schema,
  WorkflowTestRunResponseSchema,
  normalizeWorkflowManifest,
  type AgentDefinitionV2,
  type WorkflowRunEntrypoint,
  type WorkflowRunInputBinding,
  type WorkflowRunInputDescriptor,
  type WorkflowRunProfile,
  type WorkflowRunProfileTarget,
  type WorkflowRunToolPolicy,
  type WorkflowTestAgentRun,
  type WorkflowTestEventRecord,
  type WorkflowTestRunBody,
  type WorkflowTestRunResponse,
  type WorkflowTestStepResult,
} from "@agentic/contracts";
import type { TenantRegistry } from "@agentic/agent-kit";
import {
  AgentInputValidationError,
  OutputSchemaValidationError,
  buildManualTaskResolution,
  canonicalJson,
  finalizeAgentExecution,
  prepareAgentExecution,
  resolveAgentEmissions,
  runAction,
  type ActionSpec,
} from "@agentic/runtime";
import { getGlobalToolCatalogEntry } from "@agentic/tools";
import type { AuthedContext } from "../plugins/auth";
import { boundConversationHistory } from "./conversation-history";
import {
  getWorkflowDraft,
  getWorkflowRunVersionSnapshot,
  validateWorkflowManifest,
  workflowManifestHash,
} from "./workflow-authoring";

interface QueuedTestEvent {
  id: string;
  name: string;
  depth: number;
  subject: string | null;
  sourceAgentRunId: string | null;
  parentEventId: string | null;
  data: Record<string, unknown>;
}

interface ExecuteAgentInput {
  definition: AgentDefinitionV2;
  event: QueuedTestEvent;
  tenantId: string;
  tenantSlug: string;
  registry?: TenantRegistry;
  body: WorkflowTestRunBody;
}

interface ExecuteAgentResult {
  run: WorkflowTestAgentRun;
  emissions: Array<{
    id: string;
    name: string;
    payload: Record<string, unknown>;
    outputPortIds: string[];
  }>;
}

export class WorkflowTestInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowTestInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inputBinding(
  agent: AgentDefinitionV2,
  event: string,
  inputId: string,
): WorkflowRunInputBinding {
  const authored = agent.trigger_bindings?.[event]?.[inputId];
  if (!authored) return { agentId: agent.id, mode: "direct" };
  if ("path" in authored && typeof authored.path === "string") {
    return {
      agentId: agent.id,
      mode: "path",
      expression: authored.path,
    };
  }
  if ("template" in authored && typeof authored.template === "string") {
    return {
      agentId: agent.id,
      mode: "template",
      expression: authored.template,
    };
  }
  return { agentId: agent.id, mode: "constant" };
}

function sameInputContract(
  left: WorkflowRunInputDescriptor,
  right: Pick<
    WorkflowRunInputDescriptor,
    "kind" | "schema" | "sensitivity" | "file"
  >,
): boolean {
  return (
    left.kind === right.kind &&
    left.sensitivity === right.sensitivity &&
    canonicalJson(left.schema) === canonicalJson(right.schema) &&
    canonicalJson(left.file ?? null) === canonicalJson(right.file ?? null)
  );
}

/**
 * Describe every trigger event and the union of named inputs required by its
 * listeners. Externally reachable triggers are recommended, but internal
 * events remain available for targeted branch tests.
 */
export function describeWorkflowEntrypoints(manifestInput: unknown): {
  entrypoints: WorkflowRunEntrypoint[];
  warnings: string[];
} {
  const manifest = normalizeWorkflowManifest(manifestInput);
  const emitted = new Set(
    manifest.agents.flatMap((agent) => agent.triggered_event),
  );
  const listeners = new Map<string, AgentDefinitionV2[]>();
  for (const agent of manifest.agents) {
    for (const event of agent.trigger) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(agent);
      listeners.set(event, bucket);
    }
  }

  const entrypoints = [...listeners.entries()]
    .map(([event, agents]): WorkflowRunEntrypoint => {
      const merged = new Map<string, WorkflowRunInputDescriptor>();
      let requiresRawPayload = false;
      for (const agent of agents) {
        for (const input of agent.inputs) {
          const binding = inputBinding(agent, event, input.id);
          if (binding.mode === "path" || binding.mode === "template") {
            requiresRawPayload = true;
          }
          const candidate: WorkflowRunInputDescriptor = {
            id: input.id,
            label: input.label ?? input.id,
            description: input.description ?? null,
            kind: input.kind,
            required:
              input.required &&
              binding.mode !== "constant" &&
              binding.mode !== "template",
            schema: structuredClone(input.schema),
            ...(input.default !== undefined
              ? { default: structuredClone(input.default) }
              : {}),
            ...(input.example !== undefined
              ? { example: structuredClone(input.example) }
              : {}),
            sensitivity: input.sensitivity,
            ...(input.ui ? { ui: structuredClone(input.ui) } : {}),
            ...(input.file ? { file: structuredClone(input.file) } : {}),
            consumers: [agent.id],
            bindings: [binding],
            conflict: false,
          };
          const current = merged.get(input.id);
          if (!current) {
            merged.set(input.id, candidate);
            continue;
          }
          current.required ||= candidate.required;
          current.consumers = [...new Set([...current.consumers, agent.id])];
          current.bindings.push(binding);
          current.conflict ||= !sameInputContract(current, candidate);
        }
      }
      const inputs = [...merged.values()].sort((left, right) => {
        const leftOrder = left.ui?.order ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.ui?.order ?? Number.MAX_SAFE_INTEGER;
        return (
          leftOrder - rightOrder ||
          left.label.localeCompare(right.label) ||
          left.id.localeCompare(right.id)
        );
      });
      const source = emitted.has(event) ? "internal" : "external";
      return {
        event,
        source,
        recommended: source === "external",
        listenerAgentIds: agents.map((agent) => agent.id),
        listenerTitles: agents.map(
          (agent) => agent.title ?? agent.name ?? agent.id,
        ),
        inputs,
        requiresRawPayload,
      };
    })
    .sort(
      (left, right) =>
        Number(right.recommended) - Number(left.recommended) ||
        left.event.localeCompare(right.event),
    );

  const warnings: string[] = [];
  if (entrypoints.length === 0) {
    warnings.push("The workflow declares no trigger events.");
  } else if (!entrypoints.some((entrypoint) => entrypoint.recommended)) {
    warnings.push(
      "Every trigger is also emitted inside the workflow. Select an internal event deliberately and keep the depth/run budgets bounded.",
    );
  }
  for (const entrypoint of entrypoints) {
    const conflicts = entrypoint.inputs.filter((input) => input.conflict);
    if (conflicts.length > 0) {
      warnings.push(
        `${entrypoint.event} has conflicting listener contracts for: ${conflicts.map((input) => input.id).join(", ")}. Use raw JSON when one value cannot satisfy every listener.`,
      );
    }
  }
  return { entrypoints, warnings };
}

export function getWorkflowRunProfile(
  slug: string,
  target: WorkflowRunProfileTarget,
  ctx: Pick<AuthedContext, "tenantId" | "tenantSlug">,
): WorkflowRunProfile {
  const snapshot = getWorkflowRunVersionSnapshot(slug, target, ctx);
  const described = describeWorkflowEntrypoints(snapshot.manifest);
  return {
    workflowSlug: snapshot.workflowSlug,
    target,
    versionId: snapshot.versionId,
    version: snapshot.version,
    isLive: snapshot.isLive,
    manifestHash: workflowManifestHash(snapshot.manifest),
    ...described,
  };
}

function testToolAllowed(name: string, policy: WorkflowRunToolPolicy): boolean {
  if (policy === "live") return true;
  const catalog = getGlobalToolCatalogEntry(name);
  if (!catalog || catalog.testPolicy !== "allow") return false;
  // The merged registry taxonomy is read | write | dual | call (no "none");
  // only read-class tools are side-effect-safe for non-live test runs.
  return policy === "safe" || catalog.sideEffect === "read";
}

function definitionForPolicy(
  definition: AgentDefinitionV2,
  policy: WorkflowRunToolPolicy,
): AgentDefinitionV2 {
  if (policy === "live") return definition;
  return AgentDefinitionV2Schema.parse({
    ...definition,
    tool_use: definition.tool_use.filter((tool) =>
      testToolAllowed(tool.name, policy),
    ),
  });
}

async function tenantRegistry(
  tenantSlug: string,
): Promise<TenantRegistry | undefined> {
  // Dynamic import mirrors Studio and avoids a bootstrap ↔ route-service
  // initialization cycle.
  const module = await import("../bootstrap");
  return module.getExpandedTenantRegistry(tenantSlug);
}

function errorRecord(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof WorkflowTestInputError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof AgentInputValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: error.issues,
    };
  }
  if (error instanceof OutputSchemaValidationError) {
    return {
      code: error.code,
      message: error.message,
      details: error.issues,
    };
  }
  return {
    code: "execution_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function actionToolName(action: ActionSpec): string {
  return typeof action.tool === "string" && action.tool.length > 0
    ? action.tool
    : action.name;
}

async function executeAgent(
  input: ExecuteAgentInput,
): Promise<ExecuteAgentResult> {
  const startedAt = Date.now();
  const runId = makeId("run");
  const definition = definitionForPolicy(
    input.definition,
    input.body.toolPolicy,
  );
  const steps: WorkflowTestStepResult[] = [];
  const actor = definition.actor.includes("Human") ? "Human" : "Agent";
  let preparedInputs: Record<string, unknown> = {};
  let lastResult: unknown = null;
  let provider: string | null = null;
  let model: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let outputAlreadyValidated = false;

  try {
    const prepared = await prepareAgentExecution({
      definition,
      event: {
        name: input.event.name,
        data: input.event.data,
        subject: input.event.subject,
      },
    });
    preparedInputs = prepared.inputs;

    if (definition.actions.length === 0) {
      if (actor === "Human") {
        const stepStarted = Date.now();
        lastResult = buildManualTaskResolution({
          taskId: makeId("tsk"),
          decision: input.body.humanDecision,
          payload: input.body.humanPayload,
        });
        steps.push({
          id: makeId("stp"),
          order: "1",
          name: "Simulated human decision",
          type: "manual",
          status: "ok",
          startedAt: stepStarted,
          endedAt: Date.now(),
          durationMs: Math.max(0, Date.now() - stepStarted),
          input: preparedInputs,
          output: lastResult,
          provider: null,
          model: null,
          tokensIn: 0,
          tokensOut: 0,
          attempts: 1,
          branchTarget: null,
          simulation: `Human wait auto-resolved as ${input.body.humanDecision}`,
          error: null,
        });
      } else {
        throw new WorkflowTestInputError(
          "agent_has_no_actions",
          `Agent '${definition.title ?? definition.name}' has no executable actions.`,
        );
      }
    }

    let index = 0;
    while (index < definition.actions.length) {
      const action = definition.actions[index]!;
      const typedAction = action as ActionSpec;
      const stepStarted = Date.now();
      const stepId = makeId("stp");
      const stepInput = {
        event: input.event.data,
        inputs: preparedInputs,
        lastResult,
      };
      let simulation: string | null = null;
      try {
        if (
          action.type === "tool" &&
          !testToolAllowed(actionToolName(typedAction), input.body.toolPolicy)
        ) {
          throw new WorkflowTestInputError(
            "unsafe_tool_blocked",
            `Tool '${actionToolName(typedAction)}' is blocked by the ${input.body.toolPolicy} test policy.`,
          );
        }

        if (action.type === "manual") {
          lastResult = buildManualTaskResolution({
            taskId: makeId("tsk"),
            decision: input.body.humanDecision,
            payload: input.body.humanPayload,
          });
          simulation = `Human wait auto-resolved as ${input.body.humanDecision}`;
          const endedAt = Date.now();
          steps.push({
            id: stepId,
            order: action.order,
            name: action.name,
            type: action.type,
            status: "ok",
            startedAt: stepStarted,
            endedAt,
            durationMs: Math.max(0, endedAt - stepStarted),
            input: stepInput,
            output: lastResult,
            provider: null,
            model: null,
            tokensIn: 0,
            tokensOut: 0,
            attempts: 1,
            branchTarget: null,
            simulation,
            error: null,
          });
          index += 1;
          continue;
        }

        const executionAction =
          action.type === "delay" ? { ...action, delay_ms: 0 } : action;
        if (action.type === "delay") {
          simulation = `Durable delay (${action.delay_ms ?? 0}ms) skipped`;
        } else if (action.type === "subflow") {
          simulation = `Subflow '${action.subflow ?? "unknown"}' recorded but not dispatched`;
        }

        const outcome = await runAction({
          ctx: {
            agentName: definition.name,
            actionName: action.name,
            subject: input.event.subject ?? undefined,
            correlationId: runId,
            tenantSlug: input.tenantSlug,
            event: {
              name: input.event.name,
              data: {
                ...input.event.data,
                inputs: preparedInputs,
              },
            },
            lastResult,
          },
          action: executionAction as ActionSpec,
          agent: {
            ...definition,
            tenantId: input.tenantId,
            generated: definition.generated ?? true,
          },
          tenantRegistry: input.registry,
          autoResolveManual: true,
          finalOutput: index === definition.actions.length - 1,
          // Chat continuity for the draft run. This MUST ride the runAction
          // call, not the prepareAgentExecution call above — that call's
          // compiled messages are discarded and only `prepared.inputs` is
          // consumed, so history wired there would ship dead. From here it
          // flows StepInput.conversationHistory -> runTenantPrompt ->
          // prepareAgentExecution.promptOptions -> compileAgentPrompts, which
          // splices it between the system and user messages
          // (packages/runtime/src/agent-execution.ts:439-447).
          //
          // depth 0 only: the person is chatting with the WORKFLOW, so only the
          // agents listening to the trigger event get the transcript.
          // Downstream agents receive agent 1's output through the normal
          // emission graph, and may fan out many times per turn — injecting a
          // shared transcript into each would be both wrong and unbounded.
          ...(input.event.depth === 0 &&
          input.body.conversationHistory.length > 0
            ? {
                conversationHistory: boundConversationHistory(
                  input.body.conversationHistory,
                ),
              }
            : {}),
        });
        provider = outcome.provider ?? provider;
        model = outcome.model ?? model;
        tokensIn += outcome.tokensIn ?? 0;
        tokensOut += outcome.tokensOut ?? 0;
        const attempts =
          typeof outcome.meta?.actionAttempts === "number"
            ? Math.max(1, Math.floor(outcome.meta.actionAttempts))
            : 1;
        const branchTarget =
          action.type === "condition" &&
          isRecord(outcome.data) &&
          typeof outcome.data.targetActionId === "string"
            ? outcome.data.targetActionId
            : null;
        const endedAt = Date.now();
        const stepError = outcome.ok
          ? null
          : {
              code: String(outcome.meta?.error ?? "step_failed"),
              message: `Action '${action.name}' failed.`,
              ...(outcome.meta?.validationIssues === undefined
                ? {}
                : { details: outcome.meta.validationIssues }),
            };
        steps.push({
          id: stepId,
          order: action.order,
          name: action.name,
          type: action.type,
          status: outcome.ok ? "ok" : "failed",
          startedAt: stepStarted,
          endedAt,
          durationMs: Math.max(0, endedAt - stepStarted),
          input: stepInput,
          output: outcome.data,
          provider: outcome.provider ?? null,
          model: outcome.model ?? null,
          tokensIn: outcome.tokensIn ?? 0,
          tokensOut: outcome.tokensOut ?? 0,
          attempts,
          branchTarget,
          simulation,
          error: stepError,
        });
        if (!outcome.ok) {
          throw new WorkflowTestInputError(
            stepError?.code ?? "step_failed",
            stepError?.message ?? `Action '${action.name}' failed.`,
            stepError?.details,
          );
        }
        lastResult = outcome.data;
        outputAlreadyValidated =
          index === definition.actions.length - 1 &&
          outcome.meta?.outputValid === true;

        if (branchTarget) {
          const targetIndex = definition.actions.findIndex(
            (candidate) => (candidate.id ?? candidate.name) === branchTarget,
          );
          if (targetIndex < 0) {
            throw new WorkflowTestInputError(
              "condition_target_missing",
              `Condition '${action.name}' selected unknown action '${branchTarget}'.`,
            );
          }
          if (targetIndex <= index) {
            throw new WorkflowTestInputError(
              "condition_target_invalid",
              `Condition '${action.name}' must branch to a later action.`,
            );
          }
          index = targetIndex;
          continue;
        }
        index += 1;
      } catch (error) {
        if (!steps.some((step) => step.id === stepId)) {
          const endedAt = Date.now();
          const failure = errorRecord(error);
          steps.push({
            id: stepId,
            order: action.order,
            name: action.name,
            type: action.type,
            status:
              failure.code === "unsafe_tool_blocked" ? "blocked" : "failed",
            startedAt: stepStarted,
            endedAt,
            durationMs: Math.max(0, endedAt - stepStarted),
            input: stepInput,
            output: null,
            provider: null,
            model: null,
            tokensIn: 0,
            tokensOut: 0,
            attempts: 1,
            branchTarget: null,
            simulation,
            error: failure,
          });
        }
        throw error;
      }
    }

    const source = {
      agentName: definition.name,
      runId,
      subject: input.event.subject,
      correlationId: runId,
    };
    const finalized = outputAlreadyValidated
      ? {
          output: { value: lastResult, valid: true },
          emissions: resolveAgentEmissions({
            definition,
            inputs: preparedInputs,
            outputs: lastResult,
            source,
          }),
        }
      : await finalizeAgentExecution({
          definition,
          candidate: lastResult,
          inputs: preparedInputs,
          source,
        });
    const emissions = finalized.emissions.map((emission) => ({
      id: makeId("evt"),
      name: emission.name,
      payload: emission.payload,
      outputPortIds: emission.outputPortIds,
    }));
    const endedAt = Date.now();
    return {
      run: {
        id: runId,
        agentId: definition.id,
        agentName: definition.name,
        agentTitle: definition.title ?? definition.name,
        actor,
        status: "ok",
        depth: input.event.depth,
        triggerEventId: input.event.id,
        triggerEvent: input.event.name,
        subject: input.event.subject,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        inputs: preparedInputs,
        output: finalized.output.value,
        outputValid: finalized.output.valid,
        provider,
        model,
        tokensIn,
        tokensOut,
        steps,
        emissions: emissions.map((emission) => ({
          eventId: emission.id,
          name: emission.name,
          outputPortIds: emission.outputPortIds,
        })),
        error: null,
      },
      emissions,
    };
  } catch (error) {
    const endedAt = Date.now();
    const failure = errorRecord(error);
    return {
      run: {
        id: runId,
        agentId: definition.id,
        agentName: definition.name,
        agentTitle: definition.title ?? definition.name,
        actor,
        status: failure.code === "unsafe_tool_blocked" ? "blocked" : "failed",
        depth: input.event.depth,
        triggerEventId: input.event.id,
        triggerEvent: input.event.name,
        subject: input.event.subject,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        inputs: preparedInputs,
        output: null,
        outputValid: false,
        provider,
        model,
        tokensIn,
        tokensOut,
        steps,
        emissions: [],
        error: failure,
      },
      emissions: [],
    };
  }
}

function rootEventData(
  runId: string,
  eventId: string,
  body: WorkflowTestRunBody,
): Record<string, unknown> {
  const subject = body.subject ?? null;
  return {
    ...body.inputs,
    ...body.payload,
    inputs: structuredClone(body.inputs),
    event_type: body.triggerEvent,
    event_name: body.triggerEvent,
    event_id: eventId,
    run_id: runId,
    correlation_id: runId,
    ...(subject ? { subject } : {}),
    ...(typeof body.payload.prompt === "string"
      ? {}
      : typeof body.inputs.prompt === "string"
        ? { prompt: body.inputs.prompt, input: body.inputs.prompt }
        : {}),
  };
}

export async function runWorkflowDraftTest(
  slug: string,
  body: WorkflowTestRunBody,
  ctx: AuthedContext,
): Promise<WorkflowTestRunResponse> {
  // Authorizing against a real tenant-owned workflow prevents this route from
  // becoming a generic arbitrary-tool execution endpoint.
  getWorkflowDraft(slug, ctx);
  const validation = validateWorkflowManifest(body.manifest, {
    tenantSlug: ctx.tenantSlug,
  });
  const blocking = validation.issues.filter(
    (issue) => issue.severity === "error",
  );
  if (blocking.length > 0) {
    throw new WorkflowTestInputError(
      "workflow_validation_failed",
      "The current workflow draft has blocking validation issues.",
      { validation },
    );
  }
  const manifest = normalizeWorkflowManifest(body.manifest);
  const listenersByEvent = new Map<string, AgentDefinitionV2[]>();
  for (const agent of manifest.agents) {
    for (const event of agent.trigger) {
      const listeners = listenersByEvent.get(event) ?? [];
      listeners.push(agent);
      listenersByEvent.set(event, listeners);
    }
  }
  if (!listenersByEvent.has(body.triggerEvent)) {
    throw new WorkflowTestInputError(
      "entry_event_not_declared",
      `No workflow agent listens for '${body.triggerEvent}'.`,
    );
  }

  const runId = makeId("run");
  const rootEventId = makeId("evt");
  const startedAt = Date.now();
  const registry = await tenantRegistry(ctx.tenantSlug);
  const queue: QueuedTestEvent[] = [
    {
      id: rootEventId,
      name: body.triggerEvent,
      depth: 0,
      subject: body.subject ?? null,
      sourceAgentRunId: null,
      parentEventId: null,
      data: rootEventData(runId, rootEventId, body),
    },
  ];
  const agentRuns: WorkflowTestAgentRun[] = [];
  const eventRecords: WorkflowTestEventRecord[] = [];
  const warnings = validation.issues
    .filter((issue) => issue.severity !== "error")
    .map((issue) => `${issue.path}: ${issue.message}`);
  let limitReached = false;
  let halt = false;

  while (queue.length > 0 && !halt) {
    const event = queue.shift()!;
    const listeners = listenersByEvent.get(event.name) ?? [];
    const eventRecord: WorkflowTestEventRecord = {
      id: event.id,
      name: event.name,
      depth: event.depth,
      subject: event.subject,
      sourceAgentRunId: event.sourceAgentRunId,
      parentEventId: event.parentEventId,
      payload: event.data,
      consumerAgentIds: listeners.map((agent) => agent.id),
      terminal: listeners.length === 0,
    };
    eventRecords.push(eventRecord);

    if (event.depth > body.limits.maxDepth) {
      eventRecord.terminal = true;
      warnings.push(
        `Depth budget ${body.limits.maxDepth} stopped '${event.name}' at depth ${event.depth}.`,
      );
      limitReached = true;
      continue;
    }

    for (const definition of listeners) {
      if (agentRuns.length >= body.limits.maxAgentRuns) {
        warnings.push(
          `Agent-run budget ${body.limits.maxAgentRuns} reached; remaining branches were not executed.`,
        );
        limitReached = true;
        halt = true;
        break;
      }
      const result = await executeAgent({
        definition,
        event,
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        registry,
        body,
      });
      agentRuns.push(result.run);
      if (result.run.status !== "ok" && body.failurePolicy === "fail_fast") {
        warnings.push(
          `Fail-fast policy stopped the workflow after '${result.run.agentTitle}' ${result.run.status}.`,
        );
        halt = true;
        break;
      }
      for (const emission of result.emissions) {
        if (eventRecords.length + queue.length >= body.limits.maxEvents) {
          warnings.push(
            `Event budget ${body.limits.maxEvents} reached; '${emission.name}' was recorded on the agent result but not dispatched.`,
          );
          limitReached = true;
          halt = true;
          break;
        }
        queue.push({
          id: emission.id,
          name: emission.name,
          depth: event.depth + 1,
          subject: event.subject,
          sourceAgentRunId: result.run.id,
          parentEventId: event.id,
          data: {
            ...emission.payload,
            event_type: emission.name,
            event_name: emission.name,
            event_id: emission.id,
            run_id: result.run.id,
            correlation_id: runId,
            ...(event.subject ? { subject: event.subject } : {}),
          },
        });
      }
    }
  }

  const passed = agentRuns.filter((run) => run.status === "ok").length;
  const failed = agentRuns.filter((run) => run.status === "failed").length;
  const blocked = agentRuns.filter((run) => run.status === "blocked").length;
  const terminalEventIds = new Set(
    eventRecords.filter((event) => event.terminal).map((event) => event.id),
  );
  const terminalOutputs = agentRuns
    .filter(
      (run) =>
        run.status === "ok" &&
        (run.emissions.length === 0 ||
          run.emissions.every((emission) =>
            terminalEventIds.has(emission.eventId),
          )),
    )
    .map((run) => ({
      agentRunId: run.id,
      agentId: run.agentId,
      agentTitle: run.agentTitle,
      output: run.output,
      emittedEvents: run.emissions.map((emission) => emission.name),
    }));
  const endedAt = Date.now();
  const status =
    failed + blocked > 0
      ? passed > 0
        ? "partial"
        : "failed"
      : limitReached
        ? "partial"
        : "ok";

  return WorkflowTestRunResponseSchema.parse({
    runId,
    workflowSlug: slug,
    mode: "draft_test",
    status,
    manifestHash: workflowManifestHash(manifest),
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    trigger: {
      event: body.triggerEvent,
      subject: body.subject ?? null,
      inputs: body.inputs,
      payload: body.payload,
    },
    policy: {
      toolPolicy: body.toolPolicy,
      failurePolicy: body.failurePolicy,
      humanDecision: body.humanDecision,
      limits: body.limits,
    },
    summary: {
      agentRuns: agentRuns.length,
      passed,
      failed,
      blocked,
      steps: agentRuns.reduce((sum, run) => sum + run.steps.length, 0),
      events: eventRecords.length,
      terminalEvents: eventRecords.filter((event) => event.terminal).length,
      tokensIn: agentRuns.reduce((sum, run) => sum + run.tokensIn, 0),
      tokensOut: agentRuns.reduce((sum, run) => sum + run.tokensOut, 0),
    },
    agentRuns,
    events: eventRecords,
    terminalOutputs,
    warnings,
  });
}
