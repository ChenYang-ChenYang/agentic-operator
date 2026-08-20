import type { FastifyInstance } from "fastify";
import { requirePermission } from "../../plugins/rbac";
import {
  listOntoCodeEvents,
  OntoCodeStoreError,
  type OntoCodeStoreContext,
} from "../../services/ontocode-session-store";
import { publicOntoCodeSessionEvent } from "../../services/ontocode-public-projection";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;
const MAX_CONNECTION_MS = 30 * 60_000;
const PAGE_SIZE = 200;

function parseCursor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

export function ontocodeSseFrame(input: {
  id?: number;
  event?: string;
  data: unknown;
}): string {
  const lines: string[] = [];
  if (input.id !== undefined) lines.push(`id: ${input.id}`);
  if (input.event) lines.push(`event: ${input.event}`);
  const serialized =
    typeof input.data === "string" ? input.data : JSON.stringify(input.data);
  for (const line of serialized.split(/\r?\n/)) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * Live-tail visibility floor. `user` stays the default so an existing consumer
 * sees exactly what it saw before; `debug` is opt-in and is what carries the
 * Harness reasoning/tool rows — without it a Session spending minutes inside
 * tool calls streams nothing and the reasoning panel reads as frozen.
 *
 * `audit` is refused rather than downgraded: that tier is gated on `audit.read`,
 * which this route does not evaluate, and quietly answering a narrower question
 * than the one asked is the same lie as a silent truncation.
 */
function parseStreamVisibility(value: unknown): "user" | "debug" | null {
  if (value === undefined || value === null || value === "") return "user";
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return "user";
  if (raw === "user" || raw === "debug") return raw;
  return null;
}

/**
 * Durable, cursor-based live tail for one OntoCode Build Session.
 *
 * Session events remain the source of truth. The stream only transports
 * already-committed rows, so reconnecting with Last-Event-ID is gap-free and
 * never replays an uncommitted Harness claim.
 */
export async function ontocodeStreamRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{
    Params: { sessionId: string };
    Querystring: {
      after?: string;
      lastEventId?: string;
      visibility?: string;
    };
  }>("/ontocode/sessions/:sessionId/stream", async (req, reply) => {
    const auth = requirePermission(req, "workflows.read");
    const headerCursor = req.headers["last-event-id"];
    const cursor = parseCursor(
      req.query.lastEventId ?? req.query.after ?? headerCursor,
    );
    if (cursor === null) {
      return reply.fail(
        "bad_request",
        "after/Last-Event-ID must be a non-negative integer",
        400,
      );
    }
    const visibility = parseStreamVisibility(req.query.visibility);
    if (visibility === null) {
      return reply.fail(
        "bad_request",
        "visibility must be user or debug on the live tail",
        400,
      );
    }

    const ctx: OntoCodeStoreContext = {
      tenantId: auth.tenantId,
      actorId: auth.userId ?? auth.credentialId ?? null,
    };

    // Fail with the normal tenant-scoped 404 before committing SSE headers.
    try {
      listOntoCodeEvents(ctx, req.params.sessionId, {
        after: cursor,
        limit: 1,
        visibility,
      });
    } catch (error) {
      if (error instanceof OntoCodeStoreError) {
        return reply.fail(
          error.code,
          error.message,
          error.statusCode,
          undefined,
          error.details,
        );
      }
      throw error;
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write(": ontocode session stream\n\nretry: 1000\n\n");

    let after = cursor;
    let closed = false;
    let polling = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        raw.end();
      } catch {
        // Socket may already be closed by the browser or reverse proxy.
      }
    };

    const write = (frame: string): boolean => {
      if (closed || raw.destroyed || raw.writableEnded) return false;
      try {
        return raw.write(frame);
      } catch {
        close();
        return false;
      }
    };

    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        let hasMore = true;
        while (!closed && hasMore) {
          const page = listOntoCodeEvents(ctx, req.params.sessionId, {
            after,
            limit: PAGE_SIZE,
            visibility,
          });
          for (const event of page.items) {
            const publicEvent = publicOntoCodeSessionEvent(event);
            if (
              !write(ontocodeSseFrame({ id: event.seq, data: publicEvent }))
            ) {
              // Backpressure is allowed to trigger a durable reconnect. The
              // browser carries the last fully written event id.
              close();
              return;
            }
            after = event.seq;
          }
          hasMore = page.hasMore;
        }
      } catch (error) {
        req.log.error(
          { error, sessionId: req.params.sessionId },
          "[ontocode.stream] durable event poll failed",
        );
        write(
          ontocodeSseFrame({
            event: "stream.error",
            data: { code: "ontocode_event_stream_failed" },
          }),
        );
        close();
      } finally {
        polling = false;
      }
    };

    await poll();
    pollTimer = setInterval(() => void poll(), POLL_MS);
    heartbeatTimer = setInterval(() => {
      write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    timeoutTimer = setTimeout(close, MAX_CONNECTION_MS);
    pollTimer.unref?.();
    heartbeatTimer.unref?.();
    timeoutTimer.unref?.();

    req.raw.on("close", close);
    req.raw.on("error", close);
  });
}

export const __test = { parseCursor, parseStreamVisibility };
