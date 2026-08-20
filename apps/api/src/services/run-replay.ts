import { eq } from "drizzle-orm";
import { events, getDb, runs } from "@agentic/db";
import {
  appendToLedger,
  getTenantInngest,
  privateUsageAttributionMetadata,
  publishStreamEvent,
  tenantEventName,
} from "@agentic/runtime";
import {
  currentUsageAttribution,
  mergeUsageAttribution,
} from "@agentic/llm-gateway";
import { makeId } from "@agentic/shared";
import {
  CreateAgentRunResponseSchema,
  ReplayStudioRunBodySchema,
} from "@agentic/contracts";
import type { AuthedContext } from "../plugins/auth";
import { writeAudit } from "../plugins/audit";
import { resolvePayloadRef } from "../queries/runs";
import { replayStudioRun, StudioRunInputError } from "./studio-runner";

export class RunReplayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "RunReplayError";
  }
}

export interface RunReplayResult {
  statusCode: 200 | 202;
  body:
    | {
        replayed_run: string;
        new_event_id: string;
      }
    | ReturnType<typeof CreateAgentRunResponseSchema.parse>;
  newRunId: string | null;
}

/**
 * Replay one tenant-owned run. Shared by the single-run and bulk endpoints so
 * both paths preserve the same payload, attribution and audit semantics.
 */
export async function replayRunForOperator(
  auth: AuthedContext,
  runId: string,
  rawBody: unknown = {},
): Promise<RunReplayResult> {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
  if (!run || run.tenantId !== auth.tenantId) {
    throw new RunReplayError("not_found", "run not found", 404);
  }

  const isStudioRun =
    run.invocationSource === "studio" ||
    run.sessionId != null ||
    run.agentVersionId != null ||
    run.draftRevisionId != null;
  if (isStudioRun) {
    const body = ReplayStudioRunBodySchema.parse(rawBody ?? {});
    try {
      const replay = CreateAgentRunResponseSchema.parse(
        await replayStudioRun(auth, run.id, body),
      );
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "run.replay",
        targetType: "run",
        targetId: replay.runId,
        meta: {
          replay_of_run: run.id,
          version: body.version,
          session_id: replay.sessionId,
        },
      });
      return { statusCode: 202, body: replay, newRunId: replay.runId };
    } catch (error) {
      if (error instanceof StudioRunInputError) {
        throw new RunReplayError(
          error.code,
          error.message,
          error.code.endsWith("missing") || error.code.endsWith("expired")
            ? 410
            : 400,
          error.issues,
        );
      }
      throw error;
    }
  }

  if (!run.triggerEventId) {
    throw new RunReplayError("no_trigger", "run has no trigger event", 400);
  }
  const evt = db
    .select()
    .from(events)
    .where(eq(events.id, run.triggerEventId))
    .all()[0];
  if (!evt) {
    throw new RunReplayError("gone", "trigger event missing", 410);
  }

  let payload: Record<string, unknown> = {};
  if (evt.payloadRef) {
    try {
      const resolved = await resolvePayloadRef(
        evt.payloadRef,
        Number.POSITIVE_INFINITY,
      );
      if (
        resolved &&
        typeof resolved === "object" &&
        !Array.isArray(resolved)
      ) {
        payload = resolved as Record<string, unknown>;
      }
    } catch {
      throw new RunReplayError(
        "payload_unreadable",
        "original trigger payload cannot be read; replay was not enqueued",
        409,
      );
    }
  }

  const newEventId = makeId("evt");
  const correlationId = makeId("cor");
  const replayData = {
    ...payload,
    subject: evt.subject ?? undefined,
    ...(auth.tenantSlug === "zhaopin"
      ? { entity_id: evt.subject ?? newEventId }
      : {}),
    __triggerEventId: newEventId,
    __correlationId: correlationId,
    __replayOfRun: run.id,
    ...privateUsageAttributionMetadata(
      mergeUsageAttribution(currentUsageAttribution(), {
        billingAccountId: auth.tenantId,
        correlationId,
        invocationSource: "replay",
      }),
    ),
  };
  const payloadRef = await appendToLedger(auth.tenantSlug, {
    id: newEventId,
    name: evt.name,
    subject: evt.subject ?? undefined,
    data: replayData,
    ts: Date.now(),
  });
  db.insert(events)
    .values({
      id: newEventId,
      tenantId: auth.tenantId,
      name: evt.name,
      category: evt.category ?? null,
      subject: evt.subject ?? null,
      payloadRef,
    })
    .run();
  try {
    publishStreamEvent({
      type: "event.emitted",
      tenantId: auth.tenantId,
      at: Date.now(),
      eventId: newEventId,
      name: evt.name,
      subject: evt.subject ?? null,
      sourceRunId: run.id,
    });
  } catch {
    // Durable event row is authoritative.
  }
  try {
    await getTenantInngest(auth.tenantSlug).send({
      name: tenantEventName(auth.tenantSlug, evt.name) as `${string}/${string}`,
      data: replayData,
    });
  } catch {
    throw new RunReplayError(
      "enqueue_failed",
      `replay event was persisted as ${newEventId}, but Inngest rejected the enqueue`,
      502,
    );
  }
  writeAudit({
    tenantId: auth.tenantId,
    actorUserId: auth.userId ?? undefined,
    action: "run.replay",
    targetType: "run",
    targetId: run.id,
    meta: { new_event_id: newEventId },
  });
  return {
    statusCode: 200,
    body: { replayed_run: run.id, new_event_id: newEventId },
    newRunId: null,
  };
}
