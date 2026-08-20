import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  appendToLedger,
  buildCanonicalEventPayload,
  getTenantInngest,
  privateUsageAttributionMetadata,
  publishStreamEvent,
  tenantEventName,
} from "@agentic/runtime";
import {
  currentUsageAttribution,
  mergeUsageAttribution,
} from "@agentic/llm-gateway";
import { agents, auditLog, events, eventTypes, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { IngestEventBody, ListEventsQuery } from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import { listRecentEvents, resolvePayloadRef } from "../../queries/runs";
import {
  fetchCausality,
  fetchEventsSince,
  getEventDetail,
  listEventCatalog,
} from "../../queries/events";
import {
  lookupIdempotency,
  readIdempotencyKey,
  storeIdempotency,
} from "../../services/idempotency";
import { normalizeEventIngestBody } from "../../services/raas-ingress";
import { materializeRaasResume } from "../../services/raas-resume-fetch";
import { writeAudit } from "../../plugins/audit";
import { getDag } from "../../queries/workflows";
import { isInngestFunctionRegistered } from "../../services/inngest-registry";

/**
 * SSE limits for `GET /v1/events/stream` per docs/design/event-tester.md §4.2:
 *   - Poll the events table every 250ms (SQLite has no LISTEN/NOTIFY; this
 *     is the cheapest live-tail primitive that doesn't couple the wire
 *     format to Inngest internals).
 *   - 15s heartbeat keeps proxies / load balancers from idling the conn.
 *   - 30-min hard timeout — the client is expected to reconnect; this caps
 *     the per-connection cost in the unlikely "user left tab open" case.
 */
const SSE_POLL_MS = 250;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_TIMEOUT_MS = 30 * 60_000;

interface PendingEventEnqueue {
  __agentic_pending_event_enqueue: 1;
  route: "events";
  event: {
    id: string;
    name: string;
    data: Record<string, unknown>;
  };
  successBody: {
    ok: true;
    data: { event_id: string; name: string };
  };
  audit?: {
    name: string;
    subject: string | null;
    test: boolean;
    source: string;
    fields: string[];
    targetAgent?: string | null;
  };
}

function pendingEventEnqueue(value: unknown): PendingEventEnqueue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PendingEventEnqueue>;
  if (
    candidate.__agentic_pending_event_enqueue !== 1 ||
    candidate.route !== "events" ||
    !candidate.event ||
    typeof candidate.event.id !== "string" ||
    typeof candidate.event.name !== "string" ||
    !candidate.event.data ||
    typeof candidate.event.data !== "object" ||
    Array.isArray(candidate.event.data) ||
    !candidate.successBody
  ) {
    return null;
  }
  return candidate as PendingEventEnqueue;
}

function sseFrame(event: string, data: string): string {
  const lines = [`event: ${event}`];
  for (const ln of data.split("\n")) lines.push(`data: ${ln}`);
  lines.push("", "");
  return lines.join("\n");
}

function ensureEventPublishAudit(input: {
  tenantId: string;
  userId: string | null | undefined;
  authVia: string | null | undefined;
  eventId: string;
  name: string;
  subject: string | null;
  test: boolean;
  source: string;
  fields: string[];
  targetAgent?: string | null;
}): void {
  const existing = getDb()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, input.tenantId),
        eq(auditLog.action, "event.publish"),
        eq(auditLog.targetId, input.eventId),
      ),
    )
    .all()[0];
  if (existing) return;
  writeAudit({
    tenantId: input.tenantId,
    actorUserId: input.userId ?? undefined,
    action: "event.publish",
    targetType: "event",
    targetId: input.eventId,
    meta: {
      name: input.name,
      subject: input.subject,
      test: input.test,
      source: input.source,
      auth_via: input.authVia ?? null,
      // Field names only: payload values may contain secrets or PII.
      fields: input.fields,
      target_agent: input.targetAgent ?? null,
    },
  });
}

export async function eventsRoutes(app: FastifyInstance) {
  // POST /v1/events — public ingest. Additive `test` + `source` fields per
  // PRD FR-4 / FR-8 / NFR-6 — kept fully backwards-compatible with existing
  // payload shapes by routing them through the same Zod schema.
  app.post("/events", async (req, reply) => {
    const auth = requirePermission(req, "events.publish");
    // The RAAS-backed recruitment tenant also accepts the old shared-Inngest
    // contract `{name,data:{entity_*,event_id,payload,trace}}`. Normalization
    // is tenant-gated: no other tenant gets recruitment-specific coercions.
    const normalized = normalizeEventIngestBody(req.body, auth.tenantSlug);
    const parsed = IngestEventBody.parse(normalized.body);

    // UC-V11-32 / PF-GAP-10 — idempotency replay. If the caller supplied
    // an Idempotency-Key header AND we previously serviced the same
    // (tenant, key) pair, return the cached body byte-for-byte without
    // re-emitting the Inngest event or inserting a new `events` row.
    // RAAS historically did not send Idempotency-Key. Its canonical event_id
    // (then etag/upload_id) is a safe tenant-scoped fallback; an explicit
    // standard header always wins.
    const idemKey = readIdempotencyKey(req) ?? normalized.idempotencyKey;
    if (idemKey) {
      const cached = lookupIdempotency(auth.tenantId, idemKey);
      if (cached) {
        const pending = pendingEventEnqueue(cached.body);
        if (pending) {
          const fallbackFields = Object.keys(pending.event.data).filter(
            (key) => key !== "subject" && !key.startsWith("__"),
          );
          try {
            ensureEventPublishAudit({
              tenantId: auth.tenantId,
              userId: auth.userId,
              authVia: auth.via,
              eventId: pending.event.id,
              name:
                pending.audit?.name ??
                pending.event.name.split("/").slice(1).join("/"),
              subject:
                pending.audit?.subject ??
                (typeof pending.event.data.subject === "string"
                  ? pending.event.data.subject
                  : null),
              test: pending.audit?.test ?? pending.event.data.__test === true,
              source: pending.audit?.source ?? "authenticated_retry",
              fields: pending.audit?.fields ?? fallbackFields,
              targetAgent: pending.audit?.targetAgent ?? null,
            });
          } catch (err) {
            req.log.error(
              { err, eventId: pending.event.id },
              "event.publish: pending audit write failed",
            );
            return reply.fail(
              "audit_failed",
              `event ${pending.event.id} is durably stored, but its audit record could not be written; retry with the same idempotency key`,
              500,
            );
          }
          try {
            // The event row/ledger entry already exists. Retry only the
            // broker hand-off with the same Inngest event id, so an ambiguous
            // prior timeout cannot duplicate a broker event either.
            await getTenantInngest(auth.tenantSlug).send({
              id: pending.event.id,
              name: pending.event.name as `${string}/${string}`,
              data: pending.event.data,
            });
          } catch (err) {
            req.log.error(
              { err, eventId: pending.event.id },
              "event.publish: pending Inngest enqueue retry failed",
            );
            return reply.fail(
              "enqueue_failed",
              `event ${pending.event.id} is durably stored, but Inngest is still unreachable; retry with the same idempotency key`,
              502,
            );
          }
          try {
            publishStreamEvent({
              type: "event.emitted",
              tenantId: auth.tenantId,
              at: Date.now(),
              eventId: pending.event.id,
              name:
                pending.audit?.name ??
                pending.event.name.split("/").slice(1).join("/"),
              subject:
                pending.audit?.subject ??
                (typeof pending.event.data.subject === "string"
                  ? pending.event.data.subject
                  : null),
              sourceRunId: null,
            });
          } catch {
            /* broker acceptance + durable event row remain authoritative */
          }
          try {
            storeIdempotency(auth.tenantId, idemKey, {
              status: 200,
              body: pending.successBody,
            });
          } catch (err) {
            req.log.warn(
              { err, eventId: pending.event.id },
              "idempotency: pending event completed but cache update failed",
            );
          }
          return reply.code(200).send(pending.successBody);
        }
        return reply.code(cached.status).send(cached.body);
      }
    }

    // A caller may keep using the legacy same-tenant `slug/EVENT` spelling,
    // but it may never choose another tenant's namespace. Previously a
    // tenant-A token could POST `tenant-b/TRIGGER`: the row was stored under
    // A while the Inngest envelope was delivered to B. Normalize only after
    // enforcing that the optional prefix matches the authenticated tenant.
    const slash = parsed.name.indexOf("/");
    let bareName = parsed.name;
    if (slash >= 0) {
      const requestedTenant = parsed.name.slice(0, slash);
      if (requestedTenant !== auth.tenantSlug) {
        return reply.fail(
          "forbidden_namespace",
          `Event namespace '${requestedTenant}' does not match authenticated tenant '${auth.tenantSlug}'`,
          403,
        );
      }
      bareName = parsed.name.slice(slash + 1);
    }
    if (!bareName) {
      return reply.fail("invalid_event_name", "Event name is required", 400);
    }
    const db = getDb();

    // Agent-scoped sends are stronger than generic event fanout. Verify the
    // target against the LIVE workflow version and the mutable Inngest
    // registry before writing the ledger row. This prevents a 200 response
    // for an agent that exists in history but is not loaded by this process.
    if (parsed.targetAgent) {
      const dag = await getDag(auth.tenantSlug);
      const liveAgent = dag.agents.find(
        (agent) => agent.name === parsed.targetAgent,
      );
      if (!liveAgent) {
        return reply.fail(
          "agent_not_live",
          `Agent '${parsed.targetAgent}' is not in the live workflow`,
          409,
        );
      }
      const enabled = db
        .select({ enabled: agents.enabled })
        .from(agents)
        .where(eq(agents.id, liveAgent.id))
        .all()[0]?.enabled;
      if (enabled !== true) {
        return reply.fail(
          "agent_disabled",
          `Agent '${parsed.targetAgent}' is disabled`,
          409,
        );
      }
      if (!liveAgent.triggers.includes(bareName)) {
        return reply.fail(
          "agent_not_subscribed",
          `Agent '${parsed.targetAgent}' does not listen for '${bareName}' in the live workflow`,
          409,
        );
      }
      const functionId = `${auth.tenantSlug}.${parsed.targetAgent}`;
      if (!isInngestFunctionRegistered(functionId)) {
        return reply.fail(
          "agent_not_running",
          `Agent '${parsed.targetAgent}' is not registered in the live runtime`,
          409,
        );
      }
    }

    const eventId = makeId("evt");
    const correlationId = makeId("cor");
    // Wire name goes through the tenant event adapter (broker contracts may
    // rename); the namespace guard above already proved any prefix is ours.
    const wireEventName = tenantEventName(auth.tenantSlug, parsed.name);

    // Legacy RESUME_DOWNLOADED points at RAAS/MinIO, while processResume's
    // first tool reads the local zhaopin inbox. Materialize before writing the
    // event: missing credentials, unsafe keys, 404s, and oversized files fail
    // loudly and never leave a durable event that can only fail downstream.
    const authoredPayload = parsed.payload ?? {};
    const deliveryInput = normalized.raasTenant
      ? { ...authoredPayload, ...(normalized.runtimeMetadata ?? {}) }
      : authoredPayload;
    const materializedPayload = normalized.raasTenant
      ? await materializeRaasResume(bareName, deliveryInput)
      : deliveryInput;
    // `__*` keys are runtime-owned. Keep them out of the durable/public
    // logical payload while preserving tenant-adapter metadata on the broker
    // delivery copy (for example the legacy RAAS envelope and trace id).
    const deliveryPrivateMetadata = Object.fromEntries(
      Object.entries(materializedPayload).filter(([key]) =>
        key.startsWith("__"),
      ),
    );
    const eventPayload = Object.fromEntries(
      Object.entries(materializedPayload).filter(
        ([key]) => !key.startsWith("__"),
      ),
    );
    const effectiveCorrelationId =
      typeof deliveryPrivateMetadata.__correlationId === "string"
        ? deliveryPrivateMetadata.__correlationId
        : correlationId;
    // Canonical logical payload: runtime identity fields (event_id/request_id/
    // subject/prompt aliases) are normalized once at the publish edge so every
    // consumer sees the same envelope shape.
    const logicalPayload = buildCanonicalEventPayload({
      eventName: bareName,
      eventId,
      correlationId: effectiveCorrelationId,
      subject: parsed.subject,
      payload: eventPayload,
    });

    const payloadRef = await appendToLedger(auth.tenantSlug, {
      id: eventId,
      name: bareName,
      subject: parsed.subject,
      data: logicalPayload,
      ts: Date.now(),
    });

    // Stamp `events.category` from the catalog. The legacy `SELECT
    // events.category` reads in listRecentEvents / fetchEventsSince already
    // expect the column to be populated; without this lookup, SSE rows
    // arrived with `category: null` even when the catalog declared one,
    // breaking the colour-coded category filter in the Events view.
    const catalogRow = db
      .select({ category: eventTypes.category })
      .from(eventTypes)
      .where(
        and(
          eq(eventTypes.tenantId, auth.tenantId),
          eq(eventTypes.name, bareName),
        ),
      )
      .all()[0];

    db.insert(events)
      .values({
        id: eventId,
        tenantId: auth.tenantId,
        name: bareName,
        category: catalogRow?.category ?? null,
        subject: parsed.subject ?? null,
        payloadRef,
      })
      .run();
    // Only stamp __test when the caller explicitly opted in. We never inject
    // it on payloads that didn't ask — that would silently flag production
    // traffic as test, breaking dashboards in the opposite direction.
    const inngestData: Record<string, unknown> = {
      ...logicalPayload,
      ...deliveryPrivateMetadata,
      subject: parsed.subject,
      __triggerEventId: eventId,
      __correlationId: effectiveCorrelationId,
      ...privateUsageAttributionMetadata(
        mergeUsageAttribution(currentUsageAttribution(), {
          billingAccountId: auth.tenantId,
          correlationId: effectiveCorrelationId,
          invocationSource: "event",
        }),
      ),
    };
    if (normalized.raasTenant) {
      // The legacy Inngest concurrency/cancel expressions cannot use CEL
      // macros. Keep a mandatory, normalized wire key for both canonical and
      // HTTP-ingested recruitment events.
      inngestData.entity_id = parsed.subject ?? eventId;
    }
    if (parsed.targetAgent) {
      // Reuse the manifest-invoke metadata key. Runtime functions with the
      // same trigger receive the envelope, but only this named agent is
      // allowed to allocate a run row.
      inngestData.__invokedAgent = parsed.targetAgent;
    }
    if (parsed.test === true) {
      inngestData.__test = true;
    }

    const okBody = { event_id: eventId, name: wireEventName };
    const successBody = { ok: true as const, data: okBody };
    const pending: PendingEventEnqueue = {
      __agentic_pending_event_enqueue: 1,
      route: "events",
      event: { id: eventId, name: wireEventName, data: inngestData },
      successBody,
      audit: {
        name: bareName,
        subject: parsed.subject ?? null,
        test: parsed.test === true,
        source: parsed.source ?? "authenticated_api",
        fields: Object.keys(eventPayload),
        targetAgent: parsed.targetAgent ?? null,
      },
    };
    // Persist the replay recipe before handing off to the broker. If send()
    // times out after the broker accepted the event, the retry uses this same
    // event id; if it failed before acceptance, the retry completes the handoff
    // without inserting another local event row.
    if (idemKey) {
      try {
        storeIdempotency(auth.tenantId, idemKey, {
          status: 503,
          body: pending,
        });
      } catch (err) {
        req.log.error(
          { err, eventId },
          "idempotency: failed to persist pending event enqueue recipe",
        );
        return reply.fail(
          "idempotency_store_failed",
          "event was stored but not enqueued because its retry recipe could not be persisted",
          500,
        );
      }
    }
    // This route is authenticated and permission-gated. Its body-level
    // `source` is descriptive metadata, never a reason to omit an operation
    // audit. Dedicated unauthenticated webhook ingress uses separate routes.
    // Audit persistence is a prerequisite for a success response and broker
    // handoff, so an operator action can never succeed invisibly.
    try {
      ensureEventPublishAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        authVia: auth.via,
        eventId,
        name: bareName,
        subject: parsed.subject ?? null,
        test: parsed.test === true,
        source: parsed.source ?? "authenticated_api",
        fields: Object.keys(eventPayload),
        targetAgent: parsed.targetAgent ?? null,
      });
    } catch (err) {
      req.log.error({ err, eventId }, "event.publish: audit write failed");
      return reply.fail(
        "audit_failed",
        `event ${eventId} is durably stored, but its audit record could not be written`,
        500,
      );
    }

    try {
      await getTenantInngest(auth.tenantSlug).send({
        id: eventId,
        name: wireEventName as `${string}/${string}`,
        data: inngestData,
      });
    } catch (err) {
      req.log.error({ err, eventId }, "event.publish: Inngest enqueue failed");
      return reply.fail(
        "enqueue_failed",
        `event ${eventId} is durably stored, but Inngest rejected the enqueue; retry with the same idempotency key`,
        502,
      );
    }
    // The live Event/Terminal stream represents broker-accepted traffic. The local events row above
    // is a durable pending outbox entry until send() succeeds, so publishing before this point made a
    // rejected enqueue look live in the operator UI.
    try {
      publishStreamEvent({
        type: "event.emitted",
        tenantId: auth.tenantId,
        at: Date.now(),
        eventId,
        name: bareName,
        subject: parsed.subject ?? null,
        sourceRunId: null,
      });
    } catch {
      /* broker acceptance + durable event row remain authoritative */
    }

    if (idemKey) {
      // Cache the envelope-wrapped body so a retry replays the same shape
      // the client originally received (the error plugin wraps `reply.ok`
      // responses as `{ ok: true, data: ... }`).
      try {
        storeIdempotency(auth.tenantId, idemKey, {
          status: 200,
          body: successBody,
        });
      } catch (err) {
        req.log.warn({ err }, "idempotency: cache write failed (event)");
      }
    }
    return reply.ok(okBody);
  });

  // POST /v1/events/:id/replay
  app.post<{ Params: { id: string } }>(
    "/events/:id/replay",
    async (req, reply) => {
      const auth = requirePermission(req, "events.publish");
      const { id } = req.params;
      const db = getDb();
      const row = db.select().from(events).where(eq(events.id, id)).all()[0];
      if (!row) return reply.fail("not_found", "event not found", 404);
      if (row.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);

      let payload: unknown = null;
      if (row.payloadRef) {
        try {
          payload = await resolvePayloadRef(
            row.payloadRef,
            Number.POSITIVE_INFINITY,
          );
        } catch (err) {
          req.log.error(
            { err, eventId: id, payloadRef: row.payloadRef },
            "event.replay: payload read failed",
          );
          return reply.fail(
            "payload_unreadable",
            "original event payload cannot be read; replay was not enqueued",
            409,
          );
        }
      }

      // P0-API-01 — use makeId("evt") so same-millisecond replays cannot
      // collide on the legacy `${id}-replay-${Date.now()}` pattern.
      const newId = makeId("evt");
      const correlationId = makeId("cor");
      const logicalPayload = buildCanonicalEventPayload({
        eventName: row.name,
        eventId: newId,
        correlationId,
        subject: row.subject,
        payload,
      });
      // A replay is a new durable event, not just an Inngest message. Without
      // this row the manifest runtime's runs.trigger_event_id foreign key
      // points at a missing event and the replayed run never starts.
      const replayData = {
        ...logicalPayload,
        subject: row.subject ?? undefined,
        ...(auth.tenantSlug === "zhaopin"
          ? { entity_id: row.subject ?? newId }
          : {}),
        __triggerEventId: newId,
        __correlationId: correlationId,
        __replayOf: id,
        ...privateUsageAttributionMetadata(
          mergeUsageAttribution(currentUsageAttribution(), {
            billingAccountId: auth.tenantId,
            correlationId,
            invocationSource: "replay",
          }),
        ),
      };
      const replayRef = await appendToLedger(auth.tenantSlug, {
        id: newId,
        name: row.name,
        subject: row.subject ?? undefined,
        data: logicalPayload,
        ts: Date.now(),
      });
      db.insert(events)
        .values({
          id: newId,
          tenantId: auth.tenantId,
          name: row.name,
          category: row.category ?? null,
          sourceAgentId: row.sourceAgentId,
          subject: row.subject ?? null,
          payloadRef: replayRef,
        })
        .run();
      try {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "event.replay",
          targetType: "event",
          targetId: id,
          meta: { new_event_id: newId },
        });
      } catch (err) {
        req.log.error(
          { err, eventId: newId },
          "event.replay: audit write failed",
        );
        return reply.fail(
          "audit_failed",
          `replay event was persisted as ${newId}, but its audit record could not be written`,
          500,
        );
      }
      try {
        await getTenantInngest(auth.tenantSlug).send({
          id: newId,
          name: tenantEventName(
            auth.tenantSlug,
            row.name,
          ) as `${string}/${string}`,
          data: replayData,
        });
      } catch (err) {
        req.log.error(
          { err, eventId: newId },
          "event.replay: inngest.send failed",
        );
        return reply.fail(
          "enqueue_failed",
          `replay event was persisted as ${newId}, but Inngest rejected the enqueue`,
          502,
        );
      }
      try {
        publishStreamEvent({
          type: "event.emitted",
          tenantId: auth.tenantId,
          at: Date.now(),
          eventId: newId,
          name: row.name,
          subject: row.subject ?? null,
          sourceRunId: null,
        });
      } catch {
        /* broker acceptance + durable replay row remain authoritative */
      }
      return reply.ok({ replayed: id, new_event_id: newId });
    },
  );

  // GET /v1/events — list recent (legacy shape, used by the existing
  // events.jsx view; kept unchanged so we don't break that surface).
  app.get("/events", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const q = ListEventsQuery.parse(req.query);
    const rows = await listRecentEvents(auth.tenantSlug, q);
    return reply.ok(rows);
  });

  // GET /v1/events/catalog — tenant's event catalog (FR-1).
  app.get("/events/catalog", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const list = await listEventCatalog(auth.tenantSlug);
    return reply.ok({ events: list });
  });

  // GET /v1/events/:id — single event with its REAL resolved payload +
  // actual consumers (the runs it triggered). Powers the Events detail panel.
  // Declared AFTER the static /events/catalog + /events/recent routes so
  // Fastify's static-before-param ordering doesn't shadow them.
  app.get<{ Params: { id: string } }>("/events/:id", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const detail = await getEventDetail(auth.tenantSlug, req.params.id);
    if (!detail) return reply.fail("not_found", "event not found", 404);
    return reply.ok(detail);
  });

  // GET /v1/events/recent — same payload as /events but with optional
  // causality envelope when ?causality=1&seed=<id>. We keep /events
  // untouched so the legacy SPA view doesn't have to migrate.
  app.get<{
    Querystring: {
      causality?: string;
      seed?: string;
      limit?: string;
      name?: string;
    };
  }>("/events/recent", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    if (req.query.causality === "1" && req.query.seed) {
      const out = await fetchCausality(auth.tenantSlug, req.query.seed);
      return reply.ok(out);
    }
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const rows = await listRecentEvents(auth.tenantSlug, {
      limit,
      name: req.query.name,
    });
    return reply.ok({ events: rows });
  });

  // GET /v1/events/stream — SSE live tail (FR-5). Mirrors the framing logic
  // in runs-logs.ts so SPA clients can use the same EventSource patterns.
  app.get<{
    Querystring: { since?: string; names?: string };
  }>("/events/stream", async (req, reply) => {
    const auth = requirePermission(req, "events.read");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();

    // `cursor` is exclusive — we ask the query layer for rows strictly
    // newer than this timestamp. Default to "now − 1s" so a fresh
    // subscriber doesn't drown in history, while still spanning the
    // SQLite `unixepoch()` second-boundary: `receivedAt` is stamped at
    // floor(now() in seconds) * 1000, so a cursor of exactly `Date.now()`
    // would miss any row inserted in the current wall-clock second.
    const sinceParam = req.query.since ? parseInt(req.query.since, 10) : NaN;
    let cursor = Number.isFinite(sinceParam) ? sinceParam : Date.now() - 1000;
    const names =
      req.query.names && req.query.names.length > 0
        ? req.query.names
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(hbTimer);
      clearTimeout(timeoutTimer);
      try {
        reply.raw.end();
      } catch {
        /* socket already closed */
      }
    };

    const pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const rows = await fetchEventsSince(auth.tenantSlug, cursor, names);
        for (const r of rows) {
          if (closed) return;
          const ts = r.receivedAt instanceof Date ? r.receivedAt.getTime() : 0;
          if (ts > cursor) cursor = ts;
          reply.raw.write(sseFrame("event", JSON.stringify(r)));
        }
      } catch (err) {
        req.log.error(
          { err },
          "events/stream: poll failed; closing stale stream",
        );
        try {
          reply.raw.write(
            sseFrame(
              "error",
              JSON.stringify({ code: "event_stream_poll_failed" }),
            ),
          );
        } finally {
          close();
        }
      }
    }, SSE_POLL_MS);

    const hbTimer = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(sseFrame("heartbeat", "{}"));
      } catch {
        close();
      }
    }, SSE_HEARTBEAT_MS);

    const timeoutTimer = setTimeout(close, SSE_TIMEOUT_MS);

    req.raw.on("close", close);
    req.raw.on("error", close);
  });
}
