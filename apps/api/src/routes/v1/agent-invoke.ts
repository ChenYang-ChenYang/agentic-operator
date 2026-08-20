/**
 * POST /v1/agents/:name/invoke — synchronously invoke a code-defined agent.
 *
 * Request body (JSON):
 *   {
 *     input?:    unknown,            // passed to BaseAgent.buildMessages()
 *     provider?: ProviderId,         // override gateway default
 *     model?:    string,             // override gateway default
 *     async?:    boolean             // if true, fires inngest event instead of running inline
 *   }
 *
 * Sync response: { ok: true, data: { runId, status:'ok', output, ... } }
 * Async response: { ok: true, data: { runId: <reserved>, status:'queued' } }
 *
 * Error envelope: { ok: false, error: { code, message, hint? } }
 *   - 400 bad_request — unknown provider, validation failed
 *   - 404 not_found   — agent not registered
 *   - 503 not_configured — provider lacks credentials
 *   - 500 internal_error — gateway provider_error or unexpected
 */

import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import {
  agentRegistry,
  codeAgentEventName,
  RunCancelledError,
} from "@agentic/agents";
import { PROVIDER_IDS, type ProviderId } from "@agentic/contracts";
import {
  currentUsageAttribution,
  isLLMError,
  mergeUsageAttribution,
} from "@agentic/llm-gateway";
import {
  appendToLedger,
  buildCanonicalEventPayload,
  getTenantInngest,
  privateUsageAttributionMetadata,
  publishStreamEvent,
  tenantEventName,
} from "@agentic/runtime";
import { auditLog, events, eventTypes, getDb, runs, steps } from "@agentic/db";
import { and, desc, eq } from "drizzle-orm";
import { InvokeAgentBody } from "@agentic/contracts";
import { makeId } from "@agentic/shared";
import { getLLMGateway } from "../../services/llm";
import { metrics } from "../../services/metrics";
import { requirePermission } from "../../plugins/rbac";
import { findManifestAgentTrigger } from "../../queries/agents";
import {
  claimIdempotency,
  completeIdempotency,
  idempotencyFingerprint,
  lookupIdempotency,
  readIdempotencyKey,
} from "../../services/idempotency";
import { ensureCodeAgentBinding } from "../../services/code-agent-binding";
import { writeAudit } from "../../plugins/audit";
import { getTenantReasoningConfig } from "../../services/reasoning/tenant-config";
import { loadTenantReasoningContext } from "../../services/reasoning/context";

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

interface ManifestInvokeOperation {
  kind: "manifest";
  agentName: string;
  eventId: string;
  correlationId: string;
  triggerEvent: string;
  subject: string;
  inngestData: Record<string, unknown>;
  successBody: {
    ok: true;
    data: {
      kind: "manifest";
      status: "queued";
      eventId: string;
      eventName: string;
      subject: string;
      correlationId: string;
      note: string;
    };
  };
}

interface CodeAsyncInvokeOperation {
  kind: "code_async";
  runId: string;
  eventId: string;
  invocationId: string;
  correlationId: string;
  successBody: {
    ok: true;
    data: {
      kind: "code";
      runId: string;
      eventId: string;
      status: "queued";
      invocationId: string;
      correlationId: string;
      testRun: boolean;
    };
  };
}

interface CodeSyncInvokeOperation {
  kind: "code_sync";
  runId: string;
  invocationId: string;
  correlationId: string;
}

function idempotencyPending(
  reply: {
    header: (name: string, value: string) => unknown;
    fail: (code: string, message: string, status: number) => unknown;
  },
  retryAfterMs: number,
) {
  reply.header(
    "retry-after",
    String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
  );
  return reply.fail(
    "idempotency_in_progress",
    "A request with this Idempotency-Key is still running; retry with the same key after Retry-After",
    409,
  );
}

export async function agentInvokeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { name: string };
    Querystring: { testRun?: string; async?: string };
  }>("/agents/:name/invoke", async (req, reply) => {
    const agentName = req.params.name;
    const body = InvokeAgentBody.parse(req.body ?? {});
    // `?testRun=1` or `?testRun=true` flags the run as a test. Used by the
    // portal's "Test run" button to mark runs.is_test=true and the SSE
    // `run.started` payload's `testRun` field. Falls back to false when
    // the param is absent or any other value.
    const testRunQuery =
      req.query.testRun === "1" || req.query.testRun === "true";

    const wantsAsync =
      body.async || req.query.async === "1" || req.query.async === "true";

    // UC-V11-32 / PF-GAP-10 — idempotency replay. Authenticate first so
    // the cache lookup is correctly scoped per-tenant; missing/invalid
    // auth still returns the same 401 it always did.
    const auth = requirePermission(req, "agents.invoke");
    // The standalone Reasoning runtime owns its Allmeta policy. It deliberately
    // does not read Agent Factory's ontology binding: factory generation and
    // production rule evaluation are separate control planes.
    if (agentName === "reasoningAgent") {
      const input =
        body.input &&
        typeof body.input === "object" &&
        !Array.isArray(body.input)
          ? (body.input as Record<string, unknown>)
          : null;
      const requestedDomain =
        typeof input?.domainId === "string" ? input.domainId.trim() : "";
      const requestedAction =
        typeof input?.action === "string" ? input.action.trim() : "";
      if (!requestedDomain || !requestedAction) {
        return reply.fail(
          "bad_request",
          "reasoningAgent requires non-empty input.domainId and input.action",
          400,
        );
      }
      const reasoningConfig = getTenantReasoningConfig(auth.tenantSlug);
      if (!reasoningConfig) {
        return reply.fail(
          "reasoning_not_configured",
          "Configure the standalone Reasoning ontology for this tenant before invoking reasoningAgent",
          409,
        );
      }
      if (reasoningConfig.ontology.domainId !== requestedDomain) {
        return reply.fail(
          "ontology_domain_mismatch",
          `Requested ontology domain is not permitted by tenant '${auth.tenantSlug}' Reasoning configuration`,
          403,
        );
      }
      try {
        const context = await loadTenantReasoningContext(auth.tenantSlug);
        if (!context.actions.some((entry) => entry.name === requestedAction)) {
          return reply.fail(
            "ontology_action_not_found",
            `Action '${requestedAction}' does not exist in the tenant Reasoning ontology`,
            400,
          );
        }
      } catch (error) {
        req.log.error(
          { err: error, domainId: requestedDomain },
          "reasoning-agent ontology action validation failed",
        );
        return reply.fail(
          "ontology_unavailable",
          "The tenant Reasoning ontology could not be read; reasoning was not started",
          503,
        );
      }
    }
    const idemKey = readIdempotencyKey(req);
    const idemScope = `agent-invoke:${agentName}`;
    const idemFingerprint = idempotencyFingerprint({
      agentName,
      input: body.input ?? null,
      provider: body.provider ?? null,
      model: body.model ?? null,
      async: wantsAsync,
      testRun: testRunQuery,
    });
    if (idemKey) {
      const cached = lookupIdempotency(auth.tenantId, idemKey, {
        scope: idemScope,
        fingerprint: idemFingerprint,
      });
      if (cached) {
        return reply.code(cached.status).send(cached.body);
      }
    }

    // Validate provider exists in the gateway registry
    if (body.provider !== undefined) {
      if (!isProviderId(body.provider)) {
        return reply.fail(
          "bad_request",
          `Unknown provider: ${body.provider}`,
          400,
        );
      }
      // Reject the mock/non-runtime provider BEFORE probing the gateway
      // registry: a portal "Test run" flag must never opt real inference down
      // to the canned mock adapter. This also has to run ahead of
      // gateway.hasProvider(), which resolves the concrete gateway and throws
      // when no real default provider is configured outside a test process —
      // ordering the guard first keeps the honest 409 instead of a 500.
      if (body.provider === "mock" && process.env.NODE_ENV !== "test") {
        return reply.fail(
          "mock_provider_forbidden",
          "The mock provider is test-process-only; portal test runs still execute the configured real provider.",
          409,
        );
      }
      const gateway = getLLMGateway();
      if (!gateway.hasProvider(body.provider)) {
        return reply.fail(
          "bad_request",
          `Provider not registered: ${body.provider}`,
          400,
        );
      }
    }

    // Code definitions resolve from the single canonical @agentic/agents
    // registry. Tenant ownership is materialized below by
    // ensureCodeAgentBinding; system utilities are explicitly allow-listed.
    const agent = agentRegistry.get(agentName);
    if (!agent) {
      // Option B fallback — manifest agents aren't in the code registry but
      // they ARE invocable: emit their first declared trigger event into
      // Inngest and the manifest engine picks it up. This makes the
      // portal's "Test run" button work uniformly for both AgentKinds.
      // `auth` was already resolved at the top of the handler for the
      // idempotency lookup.
      const manifestAgent = await findManifestAgentTrigger(
        auth.tenantSlug,
        agentName,
      );
      if (!manifestAgent) {
        return reply.fail(
          "not_found",
          `Agent '${agentName}' not found in tenant '${auth.tenantSlug}' (neither as a code agent nor as a manifest agent).`,
          404,
        );
      }
      if (manifestAgent.sourceUnavailable) {
        return reply.fail(
          "agent_source_unavailable",
          `Agent '${agentName}' exists but no live deployment references a valid agent version; refusing to invoke an undeployed draft.`,
          409,
        );
      }
      if (!manifestAgent.enabled) {
        return reply.fail(
          "agent_disabled",
          `Agent '${agentName}' is disabled`,
          409,
        );
      }
      if (manifestAgent.triggers.length === 0) {
        return reply.fail(
          "no_auto_trigger",
          `Agent '${agentName}' has no declared trigger event (actor=${manifestAgent.actor}). Emit an event manually via POST /v1/events to invoke it.`,
          409,
        );
      }

      const triggerEvent = manifestAgent.triggers[0]!;
      const eventId = makeId("evt");
      const correlationId = makeId("cor");

      // Determine the subject. Body.input may carry one (e.g. {subject: "REQ-2041"}
      // or {candidate_id, job_requisition_id}); fall back to a synthetic test
      // subject so the run doesn't surface a NULL subject in the UI.
      const inputObj =
        body.input && typeof body.input === "object"
          ? (body.input as Record<string, unknown>)
          : {};
      const suppliedSubject =
        (typeof inputObj.subject === "string" && inputObj.subject) ||
        (typeof inputObj.candidate_id === "string" && inputObj.candidate_id) ||
        (typeof inputObj.job_requisition_id === "string" &&
          inputObj.job_requisition_id);
      if (!suppliedSubject && process.env.NODE_ENV !== "test") {
        return reply.fail(
          "subject_required",
          "Manifest invocation requires input.subject, input.candidate_id, or input.job_requisition_id; no synthetic business subject is generated.",
          400,
        );
      }
      const subject = suppliedSubject || `TEST-${eventId.slice(4, 12)}`;
      const exactPrompt =
        typeof body.input === "string"
          ? body.input
          : typeof inputObj.prompt === "string"
            ? inputObj.prompt
            : undefined;
      // Canonical logical payload (event_id/request_id/prompt aliases) so a
      // direct invoke produces the same envelope shape as a published event.
      const logicalPayload = buildCanonicalEventPayload({
        eventName: triggerEvent,
        eventId,
        correlationId,
        subject,
        payload: inputObj,
        ...(exactPrompt === undefined ? {} : { prompt: exactPrompt }),
      });

      const inngestData: Record<string, unknown> = {
        ...logicalPayload,
        subject,
        __triggerEventId: eventId,
        __correlationId: correlationId,
        __invokedAgent: agentName,
        ...privateUsageAttributionMetadata(
          mergeUsageAttribution(currentUsageAttribution(), {
            billingAccountId: auth.tenantId,
            correlationId,
            invocationSource: "api",
          }),
        ),
      };
      if (testRunQuery) {
        inngestData.__test = true;
      }

      let operation: ManifestInvokeOperation = {
        kind: "manifest",
        agentName,
        eventId,
        correlationId,
        triggerEvent,
        subject,
        inngestData,
        successBody: {
          ok: true,
          data: {
            kind: "manifest",
            status: "queued",
            eventId,
            eventName: triggerEvent,
            subject,
            correlationId,
            note: "Manifest agent dispatched via Inngest. Watch /v1/runs (SSE) for the resulting run.",
          },
        },
      };
      let claimOwnerToken: string | null = null;
      if (idemKey) {
        const claim = claimIdempotency({
          tenantId: auth.tenantId,
          key: idemKey,
          scope: idemScope,
          fingerprint: idemFingerprint,
          operation,
        });
        if (claim.state === "replay")
          return reply.code(claim.response.status).send(claim.response.body);
        if (claim.state === "pending")
          return idempotencyPending(reply, claim.retryAfterMs);
        operation = claim.operation;
        if (
          operation.kind !== "manifest" ||
          operation.agentName !== agentName
        ) {
          return reply.fail(
            "idempotency_store_failed",
            "Stored manifest invocation recipe does not match this agent",
            503,
          );
        }
        claimOwnerToken = claim.ownerToken;
      }

      // Persist the synthetic trigger event so the manifest engine's
      // `runs.trigger_event_id` FK (packages/runtime/src/register.ts:223)
      // points at a real row. Without this insert the manifest engine
      // throws `SqliteError: FOREIGN KEY constraint failed` on its first
      // step.run() write, leaving the run invisible to the UI and
      // re-triggering Inngest retries until the per-fn cap is hit.
      try {
        const db = getDb();
        const existingEvent = db
          .select({
            tenantId: events.tenantId,
            name: events.name,
            subject: events.subject,
          })
          .from(events)
          .where(eq(events.id, operation.eventId))
          .all()[0];
        if (existingEvent) {
          if (
            existingEvent.tenantId !== auth.tenantId ||
            existingEvent.name !== operation.triggerEvent ||
            existingEvent.subject !== operation.subject
          ) {
            throw new Error(
              `stable event id ${operation.eventId} is already bound to different event data`,
            );
          }
        } else {
          const payloadRef = await appendToLedger(auth.tenantSlug, {
            id: operation.eventId,
            name: operation.triggerEvent,
            subject: operation.subject,
            data: operation.inngestData,
            ts: Date.now(),
          });
          const catalogRow = db
            .select({ category: eventTypes.category })
            .from(eventTypes)
            .where(
              and(
                eq(eventTypes.tenantId, auth.tenantId),
                eq(eventTypes.name, operation.triggerEvent),
              ),
            )
            .all()[0];
          db.insert(events)
            .values({
              id: operation.eventId,
              tenantId: auth.tenantId,
              name: operation.triggerEvent,
              category: catalogRow?.category ?? null,
              subject: operation.subject,
              payloadRef,
            })
            .run();
          try {
            publishStreamEvent({
              type: "event.emitted",
              tenantId: auth.tenantId,
              at: Date.now(),
              eventId: operation.eventId,
              name: operation.triggerEvent,
              subject: operation.subject,
              sourceRunId: "",
            });
          } catch {
            /* durable event row is authoritative */
          }
        }
      } catch (err) {
        req.log.error(
          {
            err,
            eventId: operation.eventId,
            triggerEvent: operation.triggerEvent,
          },
          "manifest-invoke: failed to persist trigger event",
        );
        return reply.fail(
          "event_persist_failed",
          "Invocation was not enqueued because its durable trigger event could not be persisted",
          500,
        );
      }

      try {
        await getTenantInngest(auth.tenantSlug).send({
          // Stable broker id is the same durable event id.  An ambiguous
          // timeout followed by recovery cannot create a second Inngest event.
          id: operation.eventId,
          name: tenantEventName(
            auth.tenantSlug,
            operation.triggerEvent,
          ) as `${string}/${string}`,
          data: operation.inngestData,
        });
      } catch (err) {
        req.log.error({ err }, "agent-invoke: inngest.send failed");
        return reply.fail(
          "internal_error",
          "Failed to enqueue invocation event",
          500,
        );
      }

      if (idemKey && claimOwnerToken) {
        try {
          completeIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope: idemScope,
            fingerprint: idemFingerprint,
            ownerToken: claimOwnerToken,
            response: { status: 202, body: operation.successBody },
          });
        } catch (err) {
          req.log.error(
            { err, eventId: operation.eventId },
            "idempotency: manifest completion write failed",
          );
          return reply.fail(
            "idempotency_store_failed",
            `Event ${operation.eventId} was enqueued, but its idempotent success receipt could not be committed; retry with the same key`,
            503,
          );
        }
      }
      return reply.code(202).send(operation.successBody);
    }

    if (wantsAsync && !agent.inngestEnabled) {
      return reply.fail(
        "async_not_supported",
        `Agent '${agentName}' is a direct runtime capability and is not deployed as an Inngest function`,
        409,
      );
    }

    if (!agent.enabled) {
      return reply.fail(
        "agent_disabled",
        `Agent '${agentName}' is disabled`,
        409,
      );
    }

    const invocationId = makeId("inv");
    const correlationId = makeId("cor");
    const executionTenantSlug =
      agent.scope === "system" && agent.runScope === "owner"
        ? "__system"
        : auth.tenantSlug;
    let binding: ReturnType<typeof ensureCodeAgentBinding>;
    try {
      binding = ensureCodeAgentBinding(executionTenantSlug, agent, auth.userId);
    } catch (err) {
      req.log.error(
        { err, agentName, executionTenantSlug },
        "code-agent binding failed",
      );
      return reply.fail(
        "agent_binding_failed",
        `Failed to bind code agent '${agentName}' to tenant '${executionTenantSlug}'`,
        500,
      );
    }

    // Async path → Inngest
    if (wantsAsync) {
      const runId = makeId("run");
      const eventId = makeId("evt");
      const inputObj =
        body.input && typeof body.input === "object"
          ? (body.input as Record<string, unknown>)
          : null;
      const subject =
        inputObj && typeof inputObj.subject === "string"
          ? inputObj.subject
          : null;
      let operation: CodeAsyncInvokeOperation = {
        kind: "code_async",
        runId,
        eventId,
        invocationId,
        correlationId,
        successBody: {
          ok: true,
          data: {
            kind: "code",
            runId,
            eventId,
            status: "queued",
            invocationId,
            correlationId,
            testRun: testRunQuery,
          },
        },
      };
      let claimOwnerToken: string | null = null;
      if (idemKey) {
        const claim = claimIdempotency({
          tenantId: auth.tenantId,
          key: idemKey,
          scope: idemScope,
          fingerprint: idemFingerprint,
          operation,
        });
        if (claim.state === "replay")
          return reply.code(claim.response.status).send(claim.response.body);
        if (claim.state === "pending")
          return idempotencyPending(reply, claim.retryAfterMs);
        operation = claim.operation;
        if (operation.kind !== "code_async") {
          return reply.fail(
            "idempotency_store_failed",
            "Stored async invocation recipe has the wrong operation kind",
            503,
          );
        }
        claimOwnerToken = claim.ownerToken;
      }

      const db = getDb();
      const existingRun = db
        .select({
          tenantId: runs.tenantId,
          agentId: runs.agentId,
          status: runs.status,
          errorMessage: runs.errorMessage,
        })
        .from(runs)
        .where(eq(runs.id, operation.runId))
        .all()[0];
      let shouldSend = false;
      if (existingRun) {
        if (
          existingRun.tenantId !== binding.tenantId ||
          existingRun.agentId !== binding.agentId
        ) {
          return reply.fail(
            "idempotency_store_failed",
            `Reserved run ${operation.runId} belongs to a different tenant or agent`,
            503,
          );
        }
        if (existingRun.status === "queued") {
          shouldSend = true;
        } else if (
          existingRun.status === "failed" &&
          existingRun.errorMessage?.startsWith("enqueue_failed:")
        ) {
          db.update(runs)
            .set({
              status: "queued",
              endedAt: null,
              durationMs: null,
              errorMessage: null,
            })
            .where(eq(runs.id, operation.runId))
            .run();
          shouldSend = true;
        }
        // running/ok/cancelled/a real execution failure prove that the
        // stable broker event was already consumed; do not send again.
      } else {
        db.insert(runs)
          .values({
            id: operation.runId,
            tenantId: binding.tenantId,
            agentId: binding.agentId,
            agentVersionId: binding.agentVersionId,
            triggerEventId: null,
            status: "queued",
            startedAt: null,
            correlationId: operation.correlationId,
            subject,
            isTest: testRunQuery,
            logPath: null,
          })
          .run();
        shouldSend = true;
      }

      if (shouldSend) {
        try {
          await getTenantInngest("__system").send({
            id: operation.eventId,
            name: codeAgentEventName(agentName) as `${string}/${string}`,
            data: {
              runId: operation.runId,
              tenantSlug: executionTenantSlug,
              input: body.input,
              provider: body.provider as ProviderId | undefined,
              model: body.model,
              correlationId: operation.correlationId,
              invocationId: operation.invocationId,
              testRun: testRunQuery,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (idemKey) {
            // Keep the durable row queued: send() may have timed out after
            // broker acceptance. A retry inherits the same eventId/runId.
            db.update(runs)
              .set({ errorMessage: `enqueue_failed: ${message}` })
              .where(eq(runs.id, operation.runId))
              .run();
          } else {
            db.update(runs)
              .set({
                status: "failed",
                endedAt: new Date(),
                durationMs: 0,
                errorMessage: `enqueue_failed: ${message}`,
              })
              .where(eq(runs.id, operation.runId))
              .run();
            try {
              publishStreamEvent({
                type: "run.failed",
                tenantId: binding.tenantId,
                at: Date.now(),
                runId: operation.runId,
                errorMessage: `enqueue_failed: ${message}`,
              });
            } catch {
              /* durable failed run row is authoritative */
            }
          }
          req.log.error(
            {
              err,
              runId: operation.runId,
              eventId: operation.eventId,
              agentName,
            },
            "code-agent async enqueue failed",
          );
          return reply.fail(
            "enqueue_failed",
            idemKey
              ? `Run ${operation.runId} remains queued; retry with the same idempotency key to recover the stable enqueue`
              : `Run ${operation.runId} was recorded as failed because Inngest rejected the enqueue`,
            502,
          );
        }
      }

      // Cache completion can fail after the enqueue. Make the audit itself
      // recovery-idempotent so that retrying the pending recipe does not
      // create duplicate operator entries.
      const existingAudit = db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, binding.tenantId),
            eq(auditLog.action, "agent.invoke.async"),
            eq(auditLog.targetType, "run"),
            eq(auditLog.targetId, operation.runId),
          ),
        )
        .all()[0];
      if (!existingAudit) {
        writeAudit({
          tenantId: binding.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "agent.invoke.async",
          targetType: "run",
          targetId: operation.runId,
          meta: {
            agentName,
            invocationId: operation.invocationId,
            correlationId: operation.correlationId,
            eventId: operation.eventId,
            testRun: testRunQuery,
          },
        });
      }
      if (idemKey && claimOwnerToken) {
        try {
          completeIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope: idemScope,
            fingerprint: idemFingerprint,
            ownerToken: claimOwnerToken,
            response: { status: 202, body: operation.successBody },
          });
        } catch (err) {
          req.log.error(
            { err, runId: operation.runId, eventId: operation.eventId },
            "idempotency: async completion write failed",
          );
          return reply.fail(
            "idempotency_store_failed",
            `Run ${operation.runId} was enqueued, but its idempotent success receipt could not be committed; retry with the same key`,
            503,
          );
        }
      }
      return reply.code(202).send(operation.successBody);
    }

    // Sync path → BaseAgent.run()
    let syncOperation: CodeSyncInvokeOperation = {
      kind: "code_sync",
      runId: makeId("run"),
      invocationId,
      correlationId,
    };
    let syncClaimOwnerToken: string | null = null;
    if (idemKey) {
      const claim = claimIdempotency({
        tenantId: auth.tenantId,
        key: idemKey,
        scope: idemScope,
        fingerprint: idemFingerprint,
        operation: syncOperation,
      });
      if (claim.state === "replay")
        return reply.code(claim.response.status).send(claim.response.body);
      if (claim.state === "pending")
        return idempotencyPending(reply, claim.retryAfterMs);
      syncOperation = claim.operation;
      if (syncOperation.kind !== "code_sync") {
        return reply.fail(
          "idempotency_store_failed",
          "Stored sync invocation recipe has the wrong operation kind",
          503,
        );
      }
      syncClaimOwnerToken = claim.ownerToken;

      // Crash recovery: the old owner may have completed the durable run
      // but died before committing the HTTP receipt. Never execute a second
      // run. Reconstruct successful output from the real step artifact, or
      // surface the durable terminal/in-progress state.
      const prior = getDb()
        .select({
          tenantId: runs.tenantId,
          agentId: runs.agentId,
          status: runs.status,
          model: runs.model,
          tokensIn: runs.tokensIn,
          tokensOut: runs.tokensOut,
          durationMs: runs.durationMs,
          isTest: runs.isTest,
          errorMessage: runs.errorMessage,
        })
        .from(runs)
        .where(eq(runs.id, syncOperation.runId))
        .all()[0];
      if (prior) {
        if (
          prior.tenantId !== binding.tenantId ||
          prior.agentId !== binding.agentId
        ) {
          return reply.fail(
            "idempotency_store_failed",
            `Recovered run ${syncOperation.runId} belongs to a different tenant or agent`,
            503,
          );
        }
        if (["queued", "running", "waiting"].includes(prior.status)) {
          return idempotencyPending(reply, 2_000);
        }
        if (prior.status === "ok") {
          const outputRow = getDb()
            .select({
              outputRef: steps.outputRef,
              provider: steps.provider,
              model: steps.model,
            })
            .from(steps)
            .where(
              and(
                eq(steps.runId, syncOperation.runId),
                eq(steps.type, "logic"),
                eq(steps.status, "ok"),
              ),
            )
            .orderBy(desc(steps.ord))
            .all()[0];
          if (!outputRow?.outputRef) {
            return reply.fail(
              "idempotency_recovery_unavailable",
              `Run ${syncOperation.runId} completed, but its output artifact is unavailable; the operation will not be executed again`,
              503,
            );
          }
          try {
            const artifact = JSON.parse(
              await readFile(outputRow.outputRef, "utf8"),
            ) as {
              text?: unknown;
              provider?: unknown;
              model?: unknown;
              tokensIn?: unknown;
              tokensOut?: unknown;
            };
            if (typeof artifact.text !== "string")
              throw new Error("output artifact has no text field");
            const recoveredProvider = artifact.provider ?? outputRow.provider;
            const recoveredModel =
              artifact.model ?? outputRow.model ?? prior.model;
            if (
              typeof recoveredProvider !== "string" ||
              !isProviderId(recoveredProvider)
            ) {
              throw new Error("output artifact has no valid provider evidence");
            }
            if (typeof recoveredModel !== "string" || !recoveredModel.trim()) {
              throw new Error("output artifact has no valid model evidence");
            }
            if (typeof prior.durationMs !== "number") {
              throw new Error("completed run has no duration evidence");
            }
            const output = await agent._parsePersistedOutput(artifact.text, {
              tenantSlug: executionTenantSlug,
              correlationId: syncOperation.correlationId,
              invocationId: syncOperation.invocationId,
              runId: syncOperation.runId,
              provider: body.provider as ProviderId | undefined,
              model: body.model,
              testRun: testRunQuery,
            });
            const okData = {
              runId: syncOperation.runId,
              status: "ok" as const,
              output,
              provider: recoveredProvider,
              model: recoveredModel,
              tokensIn:
                prior.tokensIn ??
                (typeof artifact.tokensIn === "number"
                  ? artifact.tokensIn
                  : null),
              tokensOut:
                prior.tokensOut ??
                (typeof artifact.tokensOut === "number"
                  ? artifact.tokensOut
                  : null),
              durationMs: prior.durationMs,
              testRun: prior.isTest,
              recovered: true,
            };
            try {
              completeIdempotency({
                tenantId: auth.tenantId,
                key: idemKey,
                scope: idemScope,
                fingerprint: idemFingerprint,
                ownerToken: syncClaimOwnerToken,
                response: { status: 200, body: { ok: true, data: okData } },
              });
            } catch (err) {
              req.log.error(
                { err, runId: syncOperation.runId },
                "idempotency: recovered sync completion write failed",
              );
              return reply.fail(
                "idempotency_store_failed",
                `Recovered run ${syncOperation.runId}, but could not commit its success receipt`,
                503,
              );
            }
            return reply.code(200).send({ ok: true, data: okData });
          } catch (err) {
            req.log.error(
              {
                err,
                runId: syncOperation.runId,
                outputRef: outputRow.outputRef,
              },
              "idempotency: sync output recovery failed",
            );
            return reply.fail(
              "idempotency_recovery_unavailable",
              `Run ${syncOperation.runId} completed, but its real output could not be recovered; the operation will not be executed again`,
              503,
            );
          }
        }
        const terminalBody =
          prior.status === "cancelled"
            ? {
                ok: true as const,
                data: {
                  runId: syncOperation.runId,
                  status: "cancelled",
                  cancelled: true,
                },
              }
            : {
                ok: false as const,
                error: {
                  code: "idempotent_run_failed",
                  message:
                    prior.errorMessage ?? `Run ${syncOperation.runId} failed`,
                },
              };
        const terminalStatus = prior.status === "cancelled" ? 200 : 502;
        try {
          completeIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope: idemScope,
            fingerprint: idemFingerprint,
            ownerToken: syncClaimOwnerToken,
            response: { status: terminalStatus, body: terminalBody },
          });
        } catch (err) {
          req.log.error(
            { err, runId: syncOperation.runId },
            "idempotency: terminal sync completion write failed",
          );
          return reply.fail(
            "idempotency_store_failed",
            `Run ${syncOperation.runId} is terminal, but its receipt could not be committed`,
            503,
          );
        }
        return reply.code(terminalStatus).send(terminalBody);
      }
    }

    try {
      const result = await agent.run(body.input as never, {
        // Execution and run observability stay scoped to the active tenant.
        // Platform utilities resolve their canonical identity/version from
        // __system without being copied into this tenant's agent catalog.
        tenantSlug: executionTenantSlug,
        correlationId: syncOperation.correlationId,
        invocationId: syncOperation.invocationId,
        runId: syncOperation.runId,
        provider: body.provider as ProviderId | undefined,
        model: body.model,
        // P2-FE-18 — propagate `?testRun=1` into the run engine so it can
        // flip `runs.is_test` and tag the broadcast `run.started` event.
        testRun: testRunQuery,
      });

      // Prometheus metrics — single sample per finished run. Labelled by
      // tenant/agent/model/status so the Grafana panels can break down by
      // any of those dimensions. tokens_total carries direction=in|out so
      // total consumption can be aggregated across providers.
      const tenantLabel = executionTenantSlug;
      metrics.runs.inc({
        tenant: tenantLabel,
        agent: agentName,
        model: result.model,
        status: result.status,
      });
      if (typeof result.tokensIn === "number") {
        metrics.tokens.inc(
          {
            tenant: tenantLabel,
            agent: agentName,
            model: result.model,
            direction: "in",
          },
          result.tokensIn,
        );
      }
      if (typeof result.tokensOut === "number") {
        metrics.tokens.inc(
          {
            tenant: tenantLabel,
            agent: agentName,
            model: result.model,
            direction: "out",
          },
          result.tokensOut,
        );
      }
      metrics.runDuration.observe(result.durationMs, {
        tenant: tenantLabel,
        agent: agentName,
      });

      const okData = {
        runId: result.runId,
        status: result.status,
        output: result.output,
        provider: result.provider,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: result.durationMs,
        // P2-FE-18 — echo the test-run flag back so SPA callers don't have
        // to re-read the runs row to render the badge in their toast.
        testRun: result.testRun ?? testRunQuery,
      };
      if (idemKey && syncClaimOwnerToken) {
        try {
          completeIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope: idemScope,
            fingerprint: idemFingerprint,
            ownerToken: syncClaimOwnerToken,
            response: { status: 200, body: { ok: true, data: okData } },
          });
        } catch (err) {
          req.log.error(
            { err, runId: result.runId },
            "idempotency: sync completion write failed",
          );
          return reply.fail(
            "idempotency_store_failed",
            `Run ${result.runId} completed, but its idempotent success receipt could not be committed; retry with the same key`,
            503,
          );
        }
      }
      return reply.ok(okData);
    } catch (err) {
      // Operator clicked Stop while the synchronous run was in flight.
      // Cancellation is a successful outcome — return 200 with the
      // cancelled status so the portal can render the cancel state
      // without a red error toast. The run row was already flipped to
      // `cancelled` by the cancel-route handler; the run engine recorded
      // the step as `skipped`. Bumping metrics here would double-count
      // (the cancel route already incremented the cancel counter), so
      // we skip the metric increment for this path.
      if (err instanceof RunCancelledError) {
        const cancelledBody = {
          ok: true as const,
          data: {
            runId: err.runId,
            status: "cancelled",
            cancelled: true,
          },
        };
        if (idemKey && syncClaimOwnerToken) {
          try {
            completeIdempotency({
              tenantId: auth.tenantId,
              key: idemKey,
              scope: idemScope,
              fingerprint: idemFingerprint,
              ownerToken: syncClaimOwnerToken,
              response: { status: 200, body: cancelledBody },
            });
          } catch (completionError) {
            req.log.error(
              { err: completionError, runId: err.runId },
              "idempotency: cancelled sync completion write failed",
            );
            return reply.fail(
              "idempotency_store_failed",
              `Run ${err.runId} was cancelled, but its receipt could not be committed`,
              503,
            );
          }
        }
        return reply.code(200).send(cancelledBody);
      }
      const tenantLabel = executionTenantSlug;
      metrics.runs.inc({
        tenant: tenantLabel,
        agent: agentName,
        model: body.model ?? "unknown",
        status: "failed",
      });
      if (isLLMError(err)) {
        metrics.llmErrors.inc({
          tenant: tenantLabel,
          provider: err.provider,
          model: body.model ?? "unknown",
          code: err.code,
        });
        const status = mapErrorStatus(err.code);
        if (idemKey && syncClaimOwnerToken) {
          const failureBody = {
            ok: false as const,
            error: { code: err.code, message: err.message },
          };
          try {
            completeIdempotency({
              tenantId: auth.tenantId,
              key: idemKey,
              scope: idemScope,
              fingerprint: idemFingerprint,
              ownerToken: syncClaimOwnerToken,
              response: { status, body: failureBody },
            });
          } catch (completionError) {
            req.log.error(
              { err: completionError, runId: syncOperation.runId },
              "idempotency: failed sync completion write failed",
            );
            return reply.fail(
              "idempotency_store_failed",
              `Run ${syncOperation.runId} failed, but its receipt could not be committed`,
              503,
            );
          }
          return reply.code(status).send(failureBody);
        }
        return reply.fail(err.code, err.message, status);
      }
      if (idemKey && syncClaimOwnerToken) {
        const failureBody = {
          ok: false as const,
          error: {
            code: "internal_error",
            message:
              err instanceof Error ? err.message : "Agent invocation failed",
          },
        };
        try {
          completeIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope: idemScope,
            fingerprint: idemFingerprint,
            ownerToken: syncClaimOwnerToken,
            response: { status: 500, body: failureBody },
          });
        } catch (completionError) {
          req.log.error(
            { err: completionError, runId: syncOperation.runId },
            "idempotency: unexpected sync completion write failed",
          );
          return reply.fail(
            "idempotency_store_failed",
            `Run ${syncOperation.runId} failed, but its receipt could not be committed`,
            503,
          );
        }
        return reply.code(500).send(failureBody);
      }
      throw err;
    }
  });
}

function mapErrorStatus(code: string): number {
  switch (code) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "timeout":
      return 504;
    case "model_not_found":
    case "bad_request":
      return 400;
    case "not_configured":
    case "budget_storage":
      return 503;
    case "cost_limit_exceeded":
      return 429;
    case "network":
    case "provider_error":
    default:
      return 502;
  }
}
