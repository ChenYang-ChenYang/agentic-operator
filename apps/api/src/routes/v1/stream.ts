/**
 * Tenant-scoped lifecycle SSE with a durable gap-free bootstrap.
 *
 * A process-local broadcaster is only the low-latency transport. Every new
 * connection subscribes first, reconstructs recent activity from durable
 * rows/files, then flushes live frames queued during that read. Reconnects
 * therefore recover events that happened while the browser or API socket was
 * down instead of presenting the in-memory channel as history.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunStreamEvent } from "@agentic/contracts";
import { subscribeStreamEvents } from "@agentic/runtime";
import { can, requirePermission } from "../../plugins/rbac";
import { getRecentActivity } from "../../queries/activity";
import { createSseDrainRegistry } from "../../plugins/sse-drain";

const KEEPALIVE_MS = 15_000;
const MAX_PENDING_FRAMES = 2_048;
const MAX_BOOT_EVENTS = 2_048;
const MAX_SEEN_IDS = 8_192;
const DEFAULT_BACKFILL = 1_000;
const MAX_BACKFILL = 2_000;

interface StreamQuery {
  backfill?: string;
}

function boundedBackfill(raw: string | undefined): number | null {
  if (raw == null || raw === "") return DEFAULT_BACKFILL;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(MAX_BACKFILL, value);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Stable across durable backfill and its matching live broadcast. */
export function streamEventId(event: RunStreamEvent): string {
  switch (event.type) {
    case "run.started":
      return `run-start:${event.runId}`;
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return `${event.type}:${event.runId}`;
    case "run.step.started":
    case "run.step.completed":
      return `${event.type}:${event.stepId}`;
    case "event.emitted":
      return `event:${event.eventId}`;
    case "task.created":
    case "task.resolved":
      return `${event.type}:${event.taskId}`;
    case "deployment.created":
      return `deployment:${event.deploymentId}`;
    case "log.line":
      return `log:${event.runId}:${event.at}:${event.event}:${shortHash(event.message)}`;
    case "audit.recorded":
      return `audit:${event.auditId}`;
    case "llm.call.completed":
      return `llm:${event.callId}`;
    case "tool.call.completed":
      return `tool:${event.runId}:${event.at}:${event.toolName}:${shortHash(`${event.correlationId}:${event.stepName ?? ""}`)}`;
  }
}

function sseFrame(id: string, event: RunStreamEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  const registerStreamDrain = createSseDrainRegistry(app);
  app.get<{ Querystring: StreamQuery }>(
    "/stream",
    async (
      req: FastifyRequest<{ Querystring: StreamQuery }>,
      reply: FastifyReply,
    ) => {
      const auth = requirePermission(req, "events.read");
      const includeAudit = can(auth, "audit.read");
      const includeRuns = can(auth, "runs.read");
      const includeTasks = can(auth, "tasks.read");
      const includeUsage = can(auth, "usage.read");
      const includeDeployments = can(auth, "deployments.read");
      const includeFileLogs = includeRuns;
      const headerLastEventId = req.headers["last-event-id"];
      const resumeId = (
        Array.isArray(headerLastEventId)
          ? headerLastEventId[0]
          : headerLastEventId
      )?.trim();
      const backfill = boundedBackfill(req.query.backfill);
      if (backfill == null) {
        return reply.fail(
          "bad_request",
          `backfill must be an integer between 0 and ${MAX_BACKFILL}`,
          400,
        );
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      let blocked = false;
      let bootstrapping = true;
      let bootOverflow = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let unsub: () => void = () => undefined;
      let unregisterDrain: () => void = () => undefined;
      const pendingFrames: string[] = [];
      const bootEvents: RunStreamEvent[] = [];
      const seen = new Set<string>();
      const seenOrder: string[] = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        pendingFrames.length = 0;
        bootEvents.length = 0;
        raw.off("drain", flush);
        unsub();
        unregisterDrain();
        try {
          raw.end();
        } catch {
          // Socket may already be gone.
        }
      };

      function flush() {
        if (closed || !blocked) return;
        blocked = false;
        while (!closed && pendingFrames.length > 0) {
          if (!raw.write(pendingFrames.shift()!)) {
            blocked = true;
            return;
          }
        }
      }

      const writeFrame = (frame: string): boolean => {
        if (closed || raw.destroyed || raw.writableEnded) return false;
        if (blocked) {
          if (pendingFrames.length >= MAX_PENDING_FRAMES) {
            req.log.warn(
              { tenantId: auth.tenantId, queued: pendingFrames.length },
              "[stream] client backpressure queue exhausted; closing for durable reconnect",
            );
            queueMicrotask(cleanup);
            return false;
          }
          pendingFrames.push(frame);
          return true;
        }
        try {
          blocked = !raw.write(frame);
          return true;
        } catch (error) {
          req.log.warn({ error }, "[stream] socket write failed");
          queueMicrotask(cleanup);
          return false;
        }
      };

      const remember = (id: string): boolean => {
        if (seen.has(id)) return false;
        seen.add(id);
        seenOrder.push(id);
        if (seenOrder.length > MAX_SEEN_IDS) {
          const expired = seenOrder.shift();
          if (expired) seen.delete(expired);
        }
        return true;
      };

      const eventAllowed = (event: RunStreamEvent): boolean => {
        switch (event.type) {
          case "run.started":
          case "run.completed":
          case "run.failed":
          case "run.cancelled":
          case "run.step.started":
          case "run.step.completed":
          case "log.line":
          case "tool.call.completed":
            return includeRuns;
          case "task.created":
          case "task.resolved":
            return includeTasks;
          case "deployment.created":
            return includeDeployments;
          case "llm.call.completed":
            return includeUsage;
          case "audit.recorded":
            return includeAudit;
          case "event.emitted":
            return true;
        }
      };

      const send = (event: RunStreamEvent) => {
        if (closed) return;
        if (!eventAllowed(event)) return;
        const id = streamEventId(event);
        if (!remember(id)) return;
        try {
          writeFrame(sseFrame(id, event));
        } catch (error) {
          // A non-serializable lifecycle frame is a broken stream contract;
          // close explicitly so clients recover from durable history.
          req.log.error({ error, id }, "[stream] event serialization failed");
          writeFrame(
            `event: stream.error\ndata: ${JSON.stringify({ code: "serialization_failed", id })}\n\n`,
          );
          queueMicrotask(cleanup);
        }
      };

      raw.on("drain", flush);
      raw.on("close", cleanup);
      raw.on("error", cleanup);
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
      unregisterDrain = registerStreamDrain(cleanup);

      writeFrame(": stream open\n\nretry: 1000\n\n");

      // Subscribe before the durable read. Live events arriving during that
      // read are queued and de-duplicated against history when flushed.
      unsub = subscribeStreamEvents(auth.tenantId, (event) => {
        if (closed) return;
        if (bootstrapping) {
          if (bootEvents.length >= MAX_BOOT_EVENTS) {
            bootOverflow = true;
            req.log.warn(
              { tenantId: auth.tenantId, queued: bootEvents.length },
              "[stream] durable bootstrap queue exhausted",
            );
            cleanup();
            return;
          }
          bootEvents.push(event);
          return;
        }
        send(event);
      });

      try {
        if (backfill > 0) {
          const history = await getRecentActivity(auth.tenantSlug, backfill, {
            includeAudit,
            includeFileLogs,
            includeRuns,
            includeTasks,
            includeUsage,
            includeDeployments,
          });
          if (closed) return reply;
          let replay = history.filter(eventAllowed);
          if (resumeId) {
            const resumeIndex = replay.findIndex(
              (event) => streamEventId(event) === resumeId,
            );
            remember(resumeId);
            if (resumeIndex >= 0) {
              replay = replay.slice(resumeIndex + 1);
            } else {
              // The cursor fell outside the bounded durable window. Do not
              // silently pretend the reconnect is gap-free; tell capable
              // clients that this frame is a reset snapshot.
              writeFrame(
                `event: stream.reset\ndata: ${JSON.stringify({ code: "resume_cursor_not_in_backfill", lastEventId: resumeId, backfill })}\n\n`,
              );
            }
          }
          for (const event of replay) send(event);
        }
      } catch (error) {
        req.log.error({ error }, "[stream] durable activity backfill failed");
        writeFrame(
          `event: stream.error\ndata: ${JSON.stringify({ code: "backfill_failed", message: "durable activity backfill failed" })}\n\n`,
        );
        cleanup();
        return reply;
      }

      if (closed || bootOverflow) return reply;
      bootstrapping = false;
      for (const event of bootEvents) send(event);
      bootEvents.length = 0;
      writeFrame(
        `event: ready\ndata: ${JSON.stringify({ ok: true, tenantSlug: auth.tenantSlug, backfill, at: Date.now() })}\n\n`,
      );

      keepalive = setInterval(() => {
        if (!closed && !blocked) writeFrame(`: keepalive ${Date.now()}\n\n`);
      }, KEEPALIVE_MS);
      keepalive.unref?.();
      return reply;
    },
  );
}
