/**
 * §G2 — Agent-execution LIVE window (Studio eval-test reconnection).
 *
 * Implements the wire contract Studio already codes against
 * (`@agentic/contracts/agent-execution-live`, contractVersion "1.0"; vendored
 * from allmetaOntology `eval-test/lib/test-runner/ao-live-contract.ts`).
 * Conformance client: allmetaOntology `eval-test/scripts/verify-ao-sandbox.mjs`.
 *
 * Deliberately OUTSIDE the /v1 prefix — Studio calls
 * `{AO_BASE_URL}/api/agent-execution/live/*` — and outside the portal
 * auth/RBAC plugins: this is a single-tenant service window authenticated by
 * the shared secret `AO_API_KEY` (Bearer or x-api-key, constant-time
 * compared). The window tenant is `AO_EXECUTION_TENANT` (default "power-scm").
 *
 * Responses are RAW contract JSON (never the portal's { ok, data } envelope);
 * non-2xx responses use the contract's `{ error: { code, message, retryable } }`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { and, desc, eq } from "drizzle-orm";

import {
  agentExecutions,
  artifacts,
  eventTypes,
  events,
  getDb,
  runEmittedEvents,
  runs,
  steps,
  tenants,
} from "@agentic/db";
import {
  appendToLedger,
  buildCanonicalEventPayload,
  getTenantInngest,
  loadManifestFromDisk,
  resolveModelsRoot,
  shouldDiscoverModelFolder,
  tenantEventName,
  tenantSlugFromFolder,
  type AgentSpec,
} from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import {
  AO_LIVE_CONTRACT_VERSION,
  AoLiveCapabilitiesSchema,
  AoLiveEnvelopeSchema,
  AoLiveExecutionRequestSchema,
  resolveAoModelRoute,
  type AoLiveExecutionRequest,
} from "@agentic/contracts";

// ─── Window configuration ────────────────────────────────────────────────────

function windowTenantSlug(): string {
  return process.env.AO_EXECUTION_TENANT?.trim() || "power-scm";
}

/** Constant-time string equality via fixed-length digests. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function presentedKey(req: FastifyRequest): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && /^bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^bearer\s+/i, "").trim();
    if (token) return token;
  }
  const apiKey = req.headers["x-api-key"];
  const single = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (typeof single === "string" && single.trim()) return single.trim();
  return null;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  retryable = false,
): FastifyReply {
  return reply.status(status).send({ error: { code, message, retryable } });
}

/** null ⇒ the reply was already sent (auth failed / misconfigured). */
function authorize(req: FastifyRequest, reply: FastifyReply): true | null {
  const configured = process.env.AO_API_KEY?.trim();
  if (!configured) {
    sendError(
      reply,
      500,
      "server_misconfigured",
      "AO_API_KEY is not configured on this deployment",
    );
    return null;
  }
  const presented = presentedKey(req);
  if (!presented || !timingSafeEqualStr(presented, configured)) {
    sendError(reply, 401, "unauthorized", "invalid or missing API key");
    return null;
  }
  return true;
}

// ─── Window manifest (models/<tenant>-v<n>/) ────────────────────────────────

interface WindowManifest {
  agents: AgentSpec[];
  /** e.g. "v1" — derived from the resolved workflow file name. */
  versionLabel: string;
  ruleCount: number;
  dir: string;
}

function folderVersionParts(folder: string): number[] {
  const match = folder.match(/-v(\d+(?:\.\d+)*)$/i);
  if (!match?.[1]) return [0];
  return match[1].split(".").map((part) => Number(part));
}

function compareVersionParts(a: number[], b: number[]): number {
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Resolve the live model folder for the window tenant, mirroring bootstrap
 * discovery (slug derivation + sandbox-folder exclusion + highest version). */
async function resolveWindowModelDir(slug: string): Promise<string | null> {
  const root = resolveModelsRoot();
  if (!root) return null;
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const candidates = entries
    .filter(
      (folder) =>
        shouldDiscoverModelFolder(folder) &&
        tenantSlugFromFolder(folder) === slug,
    )
    .sort((a, b) => compareVersionParts(folderVersionParts(a), folderVersionParts(b)));
  const chosen = candidates[candidates.length - 1];
  return chosen ? path.join(root, chosen) : null;
}

async function countRules(dir: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  const matches = files
    .map((file) => {
      const m = file.match(/^rules(?:_v(\d+(?:\.\d+)*))?\.json$/i);
      if (!m) return null;
      return {
        file,
        parts: (m[1] ?? "1").split(".").map((part) => Number(part)),
      };
    })
    .filter((entry): entry is { file: string; parts: number[] } => !!entry)
    .sort((a, b) => compareVersionParts(a.parts, b.parts));
  const chosen = matches[matches.length - 1];
  if (!chosen) return 0;
  try {
    const raw = JSON.parse(await readFile(path.join(dir, chosen.file), "utf8"));
    const payload = Array.isArray(raw)
      ? raw
      : ((raw as { payload?: unknown[] }).payload ?? []);
    return Array.isArray(payload) ? payload.length : 0;
  } catch {
    return 0;
  }
}

async function loadWindowManifest(slug: string): Promise<WindowManifest | null> {
  const dir = await resolveWindowModelDir(slug);
  if (!dir) return null;
  const loaded = await loadManifestFromDisk(dir);
  const versionMatch = path
    .basename(loaded.manifestPath)
    .match(/_v(\d+(?:\.\d+)*)\.json$/i);
  return {
    agents: loaded.manifest,
    versionLabel: versionMatch?.[1] ? `v${versionMatch[1]}` : "v1",
    ruleCount: await countRules(dir),
    dir,
  };
}

// ─── Envelope assembly helpers ──────────────────────────────────────────────

function envelopeStatus(
  runStatus: string | null | undefined,
):
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled" {
  switch (runStatus) {
    case "ok":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "running":
    case "waiting":
    case "paused":
      return "running";
    default:
      return "pending";
  }
}

async function readJsonFileOrNull(filePath: string | null): Promise<unknown> {
  if (!filePath) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

interface RuleEvaluation {
  ruleId: string;
  status: string;
  reason: string | null;
}

/** Harvest `rule-gate:<RULE_ID>` step outputs into contract ruleEvaluations.
 * Logic judges persist `{ruleId,status:"pass"|"violation",reason}`; condition
 * gates persist the engine's `{evaluated:boolean,...}` detail. */
export function ruleEvaluationFromStepOutput(
  stepName: string,
  output: unknown,
): RuleEvaluation | null {
  if (!stepName.startsWith("rule-gate:")) return null;
  const fallbackRuleId = stepName.slice("rule-gate:".length);
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const record = output as {
      ruleId?: unknown;
      status?: unknown;
      reason?: unknown;
      evaluated?: unknown;
    };
    if (record.status === "pass" || record.status === "violation") {
      return {
        ruleId:
          typeof record.ruleId === "string" && record.ruleId
            ? record.ruleId
            : fallbackRuleId,
        status:
          record.status === "pass" ? "evaluated_passed" : "evaluated_violated",
        reason: typeof record.reason === "string" ? record.reason : null,
      };
    }
    if (typeof record.evaluated === "boolean") {
      return {
        ruleId: fallbackRuleId,
        status: record.evaluated ? "evaluated_passed" : "evaluated_violated",
        reason: "deterministic condition",
      };
    }
  }
  return null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function agentExecutionRoutes(app: FastifyInstance) {
  // GET /api/agent-execution/live/capabilities
  app.get("/api/agent-execution/live/capabilities", async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const slug = windowTenantSlug();
    try {
      const manifest = await loadWindowManifest(slug);
      if (!manifest) {
        return sendError(
          reply,
          503,
          "manifest_unavailable",
          `no model folder found for window tenant '${slug}'`,
          true,
        );
      }
      const agents = manifest.agents.map((agent) => ({
        agent: agent.name,
        wsId: agent.name,
        inngestId: `${slug}.${agent.name}`,
        functionSlug: `${slug}.${agent.name}`,
        triggerEvent: agent.trigger[0] ?? "",
        emitsEvents: agent.triggered_event ?? [],
        auditOnly: false,
        displayName: agent.title ?? agent.name,
        requiredInputs: [] as string[],
      }));
      // Honesty over completeness: advertise exactly the workspace default
      // model as available. A richer roster requires per-tenant credential
      // probing, which this window does not fabricate.
      const defaultModel =
        (process.env.LLM_DEFAULT_MODEL ?? process.env.LLM_MODEL)?.trim() ||
        "mock-model-v1";
      const route = resolveAoModelRoute(defaultModel);
      const body = AoLiveCapabilitiesSchema.parse({
        contractVersion: AO_LIVE_CONTRACT_VERSION,
        mode: "live",
        agents,
        modelCapabilities: route
          ? [
              {
                requestedModel: route.requestedModel,
                available: true,
                channel: route.channel,
                wireModel: route.wireModel,
                agents: [],
                reasoningEfforts: [],
              },
            ]
          : [],
      });
      return reply.status(200).send(body);
    } catch (error) {
      req.log.error({ err: error }, "agent-execution: capabilities failed");
      return sendError(
        reply,
        500,
        "internal_error",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  });

  // POST /api/agent-execution/live/executions
  app.post("/api/agent-execution/live/executions", async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const slug = windowTenantSlug();
    let body: AoLiveExecutionRequest;
    try {
      body = AoLiveExecutionRequestSchema.parse(req.body);
    } catch (error) {
      const message =
        error instanceof ZodError
          ? error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")
          : String(error);
      return sendError(reply, 400, "invalid_request", message);
    }
    try {
      const db = getDb();
      // Idempotent replay: the same clientRequestId returns the SAME
      // executionId and never publishes a second trigger event.
      const existing = db
        .select()
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.tenantSlug, slug),
            eq(agentExecutions.clientRequestId, body.clientRequestId),
          ),
        )
        .all()[0];
      if (existing) {
        return reply.status(200).send({ executionId: existing.id });
      }

      const manifest = await loadWindowManifest(slug);
      const agent = manifest?.agents.find((entry) => entry.name === body.agent);
      if (!manifest || !agent) {
        return sendError(
          reply,
          404,
          "unknown_agent",
          `agent '${body.agent}' is not in the '${slug}' live manifest`,
        );
      }
      const triggerEvent = agent.trigger[0];
      if (!triggerEvent) {
        return sendError(
          reply,
          409,
          "agent_not_invocable",
          `agent '${body.agent}' declares no event trigger`,
        );
      }
      const tenantRow = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!tenantRow) {
        return sendError(
          reply,
          503,
          "tenant_not_ready",
          `window tenant '${slug}' is not seeded`,
          true,
        );
      }

      const executionId = makeId("exe");
      const eventId = makeId("evt");
      const correlationId = makeId("cor");
      // Same internal publish path as POST /v1/events: canonical logical
      // payload → NDJSON ledger → events row → Inngest envelope with
      // runtime-private `__` metadata.
      const publicPayload = Object.fromEntries(
        Object.entries(body.inputs.eventData).filter(
          ([key]) => !key.startsWith("__"),
        ),
      );
      const logicalPayload = buildCanonicalEventPayload({
        eventName: triggerEvent,
        eventId,
        correlationId,
        subject: executionId,
        payload: publicPayload,
      });
      const payloadRef = await appendToLedger(slug, {
        id: eventId,
        name: triggerEvent,
        subject: executionId,
        data: logicalPayload,
        ts: Date.now(),
      });
      const catalogRow = db
        .select({ category: eventTypes.category })
        .from(eventTypes)
        .where(
          and(
            eq(eventTypes.tenantId, tenantRow.id),
            eq(eventTypes.name, triggerEvent),
          ),
        )
        .all()[0];
      const inserted = db.transaction((tx) => {
        // The unique (tenant_slug, client_request_id) index is the
        // idempotency anchor under concurrency: the loser of a race reads
        // the winner's row below instead of double-publishing.
        try {
          tx.insert(agentExecutions)
            .values({
              id: executionId,
              tenantSlug: slug,
              agent: agent.name,
              clientRequestId: body.clientRequestId,
              eventId,
              requestJson: body as never,
              status: "pending",
              createdAt: new Date(),
            })
            .run();
        } catch {
          return false;
        }
        tx.insert(events)
          .values({
            id: eventId,
            tenantId: tenantRow.id,
            name: triggerEvent,
            category: catalogRow?.category ?? null,
            subject: executionId,
            payloadRef,
          })
          .run();
        return true;
      });
      if (!inserted) {
        const winner = db
          .select()
          .from(agentExecutions)
          .where(
            and(
              eq(agentExecutions.tenantSlug, slug),
              eq(agentExecutions.clientRequestId, body.clientRequestId),
            ),
          )
          .all()[0];
        if (winner) return reply.status(200).send({ executionId: winner.id });
        return sendError(
          reply,
          500,
          "persist_failed",
          "execution row could not be persisted",
          true,
        );
      }

      const inngestData: Record<string, unknown> = {
        ...logicalPayload,
        subject: executionId,
        __triggerEventId: eventId,
        __correlationId: correlationId,
        // Agent-scoped delivery: sibling subscribers of the trigger event
        // acknowledge without allocating a run (register.ts eventTargetsAgent),
        // so exactly ONE run correlates with this execution.
        __invokedAgent: agent.name,
      };
      if (body.config.suppressDownstream) {
        // §G2 engine semantics: the run persists ledger/event_store/
        // run_emitted_events truth but skips step.sendEvent fan-out.
        inngestData.__eval_suppress_downstream = true;
      }
      try {
        await getTenantInngest(slug).send({
          id: eventId,
          name: tenantEventName(slug, triggerEvent) as `${string}/${string}`,
          data: inngestData,
        });
      } catch (error) {
        req.log.error(
          { err: error, executionId, eventId },
          "agent-execution: Inngest enqueue failed",
        );
        return sendError(
          reply,
          502,
          "enqueue_failed",
          `execution ${executionId} is durably stored, but the broker rejected the trigger event; retry with the same clientRequestId after removing the stored row or contact the operator`,
          true,
        );
      }
      return reply.status(200).send({ executionId });
    } catch (error) {
      req.log.error({ err: error }, "agent-execution: submit failed");
      return sendError(
        reply,
        500,
        "internal_error",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  });

  // GET /api/agent-execution/live/executions/:id
  app.get<{ Params: { id: string } }>(
    "/api/agent-execution/live/executions/:id",
    async (req, reply) => {
      if (!authorize(req, reply)) return reply;
      const slug = windowTenantSlug();
      try {
        const db = getDb();
        const execution = db
          .select()
          .from(agentExecutions)
          .where(eq(agentExecutions.id, req.params.id))
          .all()[0];
        if (!execution || execution.tenantSlug !== slug) {
          return sendError(reply, 404, "not_found", "execution not found");
        }
        const request = (execution.requestJson ?? null) as
          | AoLiveExecutionRequest
          | null;
        const manifest = await loadWindowManifest(slug);
        const triggerEvent =
          manifest?.agents.find((entry) => entry.name === execution.agent)
            ?.trigger[0] ?? "";
        const ontologyLoaded: Record<string, unknown> = {
          domain: slug,
          version: manifest?.versionLabel ?? "v1",
          ruleCount: manifest?.ruleCount ?? 0,
          liveConsistency: null,
        };
        const requestedDigest = request?.config?.ontologySnapshotDigest;
        if (typeof requestedDigest === "string") {
          ontologyLoaded.snapshotDigest = requestedDigest;
        }

        const run = execution.eventId
          ? db
              .select()
              .from(runs)
              .where(eq(runs.triggerEventId, execution.eventId))
              .orderBy(desc(runs.startedAt))
              .all()[0]
          : undefined;
        const status = envelopeStatus(run?.status);

        if (!run) {
          const pending = AoLiveEnvelopeSchema.parse({
            executionId: execution.id,
            status,
            result: null,
            trace: null,
            meta: {
              agent: execution.agent,
              triggerEvent,
              eventIds: execution.eventId ? [execution.eventId] : [],
              startedAt: null,
              finishedAt: null,
              durationMs: null,
              ontologyLoaded,
            },
            error: null,
          });
          return reply.status(200).send(pending);
        }

        const stepRows = db
          .select()
          .from(steps)
          .where(eq(steps.runId, run.id))
          .orderBy(steps.ord)
          .all();
        const emittedRows = db
          .select({ eventId: runEmittedEvents.eventId, name: events.name })
          .from(runEmittedEvents)
          .innerJoin(events, eq(events.id, runEmittedEvents.eventId))
          .where(eq(runEmittedEvents.runId, run.id))
          .all();
        const emittedNames: string[] = [];
        const emittedEventIds: string[] = [];
        for (const row of emittedRows) {
          if (!emittedEventIds.includes(row.eventId)) {
            emittedEventIds.push(row.eventId);
            emittedNames.push(row.name);
          }
        }
        const ruleEvaluations: RuleEvaluation[] = [];
        for (const stepRow of stepRows) {
          if (!stepRow.name.startsWith("rule-gate:")) continue;
          const output = await readJsonFileOrNull(stepRow.outputRef);
          const evaluation = ruleEvaluationFromStepOutput(stepRow.name, output);
          if (evaluation) ruleEvaluations.push(evaluation);
        }
        const outputArtifact = db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.runId, run.id), eq(artifacts.role, "output")))
          .orderBy(desc(artifacts.createdAt))
          .all()[0];
        const output = await readJsonFileOrNull(outputArtifact?.path ?? null);

        const envelope = AoLiveEnvelopeSchema.parse({
          executionId: execution.id,
          status,
          result: {
            decision: null,
            summary: "",
            output,
          },
          trace: {
            runId: run.id,
            functionSlug: `${slug}.${execution.agent}`,
            steps: stepRows.map((stepRow) => ({
              name: stepRow.name,
              status: stepRow.status,
              durationMs: stepRow.durationMs ?? null,
            })),
            emittedEvents: emittedNames,
            ruleEvaluations,
          },
          meta: {
            agent: execution.agent,
            triggerEvent,
            eventIds: [
              ...(execution.eventId ? [execution.eventId] : []),
              ...emittedEventIds,
            ],
            startedAt: run.startedAt ? run.startedAt.toISOString() : null,
            finishedAt: run.endedAt ? run.endedAt.toISOString() : null,
            durationMs: run.durationMs ?? null,
            ontologyLoaded,
          },
          error:
            run.status === "failed"
              ? {
                  code: "run_failed",
                  message: run.errorMessage ?? "",
                  retryable: false,
                }
              : run.status === "cancelled"
                ? {
                    code: "run_cancelled",
                    message: run.errorMessage ?? "cancelled",
                    retryable: false,
                  }
                : null,
        });
        return reply.status(200).send(envelope);
      } catch (error) {
        req.log.error({ err: error }, "agent-execution: envelope failed");
        return sendError(
          reply,
          500,
          "internal_error",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  );
}
