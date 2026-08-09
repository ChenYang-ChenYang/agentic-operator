import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agents, auditLog, events, getDb, runs, tasks } from "@agentic/db";
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
  ListRunsQuery,
  ReplayStudioRunBodySchema,
} from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  getRun,
  getRunUsageSummary,
  listRecentRuns,
  listRunsPaged,
  listSteps,
  listRunChain,
  softDeleteRun,
  restoreRun,
  bulkSoftDeleteRuns,
  purgeDeletedRuns,
} from "../../queries/runs";
import { getRunSummary } from "../../queries/reasoning";
import {
  generateRunSummary,
  RunSummaryGenerationError,
} from "../../services/run-summary";
import {
  finalizeCancelledStudioRun,
  replayStudioRun,
  StudioRunInputError,
} from "../../services/studio-runner";

export async function runsRoutes(app: FastifyInstance) {
  // GET /v1/runs — list.
  //
  // Two shapes on one route, chosen by the query:
  //   - `?page=N` (or the recycle-bin `?deleted=1`) → a PaginatedRuns envelope
  //     `{ rows, total, page, pageSize }` for server-side page controls.
  //   - no `page` → the legacy bare array (dashboard / logs / trace-tree still
  //     read `useRuns()` expecting an array, so this stays back-compatible).
  app.get("/runs", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const q = ListRunsQuery.parse(req.query);
    const wantDeleted = q.deleted === "1" || q.deleted === "true";

    if (q.page !== undefined || wantDeleted) {
      const paged = await listRunsPaged(auth.tenantSlug, {
        page: q.page,
        pageSize: q.pageSize,
        status: q.status,
        agentName: q.agent,
        query: q.q,
        parentRunId: q.parentRunId,
        deleted: wantDeleted,
      });
      return reply.ok(paged);
    }

    const rows = await listRecentRuns(auth.tenantSlug, {
      limit: q.limit,
      status: q.status,
      agentName: q.agent,
      query: q.q,
      parentRunId: q.parentRunId,
    });
    return reply.ok(rows);
  });

  // GET /v1/runs/:id — single, strictly tenant-scoped.
  //
  // Previously this handler fell back to `getRun("__system", id)` if the
  // caller's tenant didn't own the run, which leaked __system-tenant code-
  // agent runs (token usage, prompts, outputs) to every authed tenant.
  // P0-AUTH-02. Code-agent runs that need to be visible to the invoking
  // tenant are now stored under that tenant; cross-tenant __system runs are
  // an operator/platform-admin surface and require a dedicated route + grant.
  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const run = await getRun(auth.tenantSlug, req.params.id);
    if (!run) return reply.fail("not_found", "run not found", 404);
    const steps = await listSteps(run.id);
    // HITL: if the run is blocked on an open human task, surface it so the
    // run viewer can show a "waiting for approval" state + deep-link instead
    // of looking stalled. Newest open task wins.
    const waiting = getDb()
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        awaitingRole: tasks.awaitingRole,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.runId, run.id),
          inArray(tasks.status, ["open", "resolving"]),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .all()[0];
    const usage = getRunUsageSummary(auth.tenantId, run.id);
    return reply.ok({ run, steps, waitingTask: waiting ?? null, usage });
  });

  // GET /v1/runs/:id/chain — the whole cross-run cascade sharing this run's
  // correlationId, in pipeline order. The zhaopin 6-agent pipeline links runs
  // by re-emitting events with the same correlationId (NOT parentRunId), so the
  // parentRunId-based trace tab shows nothing; this surfaces the real chain.
  app.get<{ Params: { id: string } }>("/runs/:id/chain", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const chain = await listRunChain(auth.tenantSlug, req.params.id);
    if (!chain) return reply.fail("not_found", "run not found", 404);
    return reply.ok(chain);
  });

  // GET /v1/runs/:id/summary — the cached AI summary (W2), or null if not yet
  // generated. Tenant-scoped; cheap read (no LLM call).
  app.get<{ Params: { id: string } }>(
    "/runs/:id/summary",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      const summary = getRunSummary(auth.tenantId, req.params.id);
      return reply.ok({ summary });
    },
  );

  // POST /v1/runs/:id/summary — generate (or regenerate) the AI summary and
  // cache it. Lazy: the run viewer calls this on first open when GET returned
  // null, and again on an explicit "regenerate". Generation fails explicitly
  // when the real provider/structured output is unavailable.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/summary",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      try {
        const summary = await generateRunSummary(
          auth.tenantSlug,
          req.params.id,
        );
        if (!summary) return reply.fail("not_found", "run not found", 404);
        return reply.ok({ summary });
      } catch (error) {
        if (error instanceof RunSummaryGenerationError) {
          req.log.error(
            { err: error, runId: req.params.id },
            "run summary generation failed",
          );
          return reply.fail("summary_generation_failed", error.message, 502);
        }
        throw error;
      }
    },
  );

  // POST /v1/runs/:id/replay
  app.post<{ Params: { id: string } }>(
    "/runs/:id/replay",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.replay");
      const db = getDb();
      const run = db
        .select()
        .from(runs)
        .where(eq(runs.id, req.params.id))
        .all()[0];
      if (!run) return reply.fail("not_found", "run not found", 404);
      if (run.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);
      if (["studio", "replay"].includes(run.invocationSource)) {
        const body = ReplayStudioRunBodySchema.parse(req.body ?? {});
        try {
          const replay = CreateAgentRunResponseSchema.parse(
            await replayStudioRun(auth, run.id, body),
          );
          writeAudit({
            tenantId: auth.tenantId,
            action: "run.replay",
            targetType: "run",
            targetId: replay.runId,
            meta: {
              replay_of_run: run.id,
              version: body.version,
              session_id: replay.sessionId,
            },
          });
          return reply.ok(replay, 202);
        } catch (error) {
          if (error instanceof StudioRunInputError) {
            return reply.fail(
              error.code,
              error.message,
              error.code.endsWith("missing") || error.code.endsWith("expired")
                ? 410
                : 400,
              undefined,
              error.issues,
            );
          }
          throw error;
        }
      }
      if (!run.triggerEventId)
        return reply.fail("no_trigger", "run has no trigger event", 400);

      const evt = db
        .select()
        .from(events)
        .where(eq(events.id, run.triggerEventId))
        .all()[0];
      if (!evt) return reply.fail("gone", "trigger event missing", 410);

      let payload: Record<string, unknown> = {};
      if (evt.payloadRef) {
        const [filePath, offsetStr] = evt.payloadRef.split("#");
        if (
          !filePath ||
          offsetStr == null ||
          !Number.isSafeInteger(Number(offsetStr))
        ) {
          return reply.fail(
            "payload_unreadable",
            "trigger event payload reference is malformed",
            409,
          );
        }
        try {
          const buf = await readFile(filePath);
          const offset = Number(offsetStr);
          const nl = buf.indexOf(0x0a, offset);
          const line = buf.toString("utf8", offset, nl === -1 ? undefined : nl);
          payload = (JSON.parse(line).data ?? {}) as Record<string, unknown>;
        } catch (err) {
          req.log.error(
            { err, runId: run.id, payloadRef: evt.payloadRef },
            "run.replay: payload read failed",
          );
          return reply.fail(
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
        /* durable event row is authoritative */
      }
      try {
        await getTenantInngest(auth.tenantSlug).send({
          name: tenantEventName(
            auth.tenantSlug,
            evt.name,
          ) as `${string}/${string}`,
          data: replayData,
        });
      } catch (err) {
        req.log.error(
          { err, runId: run.id, eventId: newEventId },
          "run.replay: inngest.send failed",
        );
        return reply.fail(
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
      return reply.ok({ replayed_run: run.id, new_event_id: newEventId });
    },
  );

  // POST /v1/runs/:id/cancel — operator kill switch for an in-flight run.
  //
  // Two execution paths share `runs.status`:
  //   1. Manifest agents run inside Inngest functions registered in
  //      `packages/runtime/src/register.ts`. Each fn declares a `cancelOn`
  //      hook keyed on `${tenantSlug}/run.cancel` matching subjects, so
  //      Inngest aborts the function at the next step boundary. The
  //      route emits the cancel event via `inngest.send` (NOT inside a
  //      `step.run` — this is a plain route handler, not a step).
  //   2. Code-defined agents run synchronously in the invoke route.
  //      Their run engine polls `runs.status` at every checkpoint and
  //      throws `RunCancelledError` when the row flips to `cancelled`.
  //      That bubble-up causes the invoke route to return 200 with
  //      `cancelled:true` instead of an error envelope.
  //
  // Manifest cancellation is fail-closed: the stable-id Inngest signal must
  // be accepted before the durable row is marked cancelled. A transport
  // failure returns 502 and leaves the run active so the UI never claims a
  // stop that the runtime did not receive. Code agents use the durable row as
  // their cooperative signal, so their update is committed directly.
  //
  // Idempotency: clicking Stop on a finished run is a no-op success —
  // operators routinely double-click; surfacing a 4xx for "already done"
  // is hostile UX. The audit row + Inngest emit only happen when we
  // actually flip the status.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/cancel",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.cancel");
      const db = getDb();
      const run = db
        .select()
        .from(runs)
        .where(eq(runs.id, req.params.id))
        .all()[0];
      if (!run) return reply.fail("not_found", "run not found", 404);
      if (run.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);
      const ensureStudioCancellationEvidence = async () => {
        if (
          run.invocationSource !== "studio" &&
          run.invocationSource !== "replay"
        ) {
          return;
        }
        await finalizeCancelledStudioRun({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          runId: run.id,
        }).catch((err) => {
          req.log.warn(
            { err, runId: run.id, action: "run.cancel.evidence_failed" },
            "cancel: Studio terminal evidence could not be persisted",
          );
        });
      };

      // Idempotent no-op when the run already reached a terminal state.
      // `cancelled` is terminal too — re-cancelling an already-cancelled
      // run returns 200 with the current row so a double-click does not
      // re-emit the Inngest cancel event or re-write the audit row.
      const TERMINAL = new Set(["ok", "failed", "cancelled"]);
      if (TERMINAL.has(run.status)) {
        if (run.status === "cancelled") {
          // A repeated cancel also self-heals a prior transient artifact
          // failure while remaining idempotent when evidence already exists.
          await ensureStudioCancellationEvidence();
        }
        req.log.info(
          {
            runId: run.id,
            tenantSlug: auth.tenantSlug,
            status: run.status,
            action: "run.cancel.noop",
          },
          "cancel: no-op (run already terminal)",
        );
        return reply.ok({
          runId: run.id,
          status: run.status,
          cancelled: false,
          note: `Run already terminal (status=${run.status}); no action taken.`,
        });
      }

      // Resolve the agent kind so we can give the operator an accurate
      // `note`. For manifest agents we must fire the Inngest cancel
      // signal; for code agents the cooperative poll handles termination
      // and we skip the Inngest send (no manifest fn to cancel).
      const agentRow = db
        .select({ kind: agents.kind })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .all()[0];
      const isManifest = agentRow?.kind !== "code";

      const previousStatus = run.status;
      if (isManifest) {
        try {
          await getTenantInngest(auth.tenantSlug).send({
            // A timeout after broker acceptance is safe to retry: Inngest
            // deduplicates this stable event id instead of cancelling twice.
            id: `cancel-${run.id}`,
            name: tenantEventName(
              auth.tenantSlug,
              "run.cancel",
            ) as `${string}/${string}`,
            data: {
              runId: run.id,
              subject: run.subject ?? null,
              ...(auth.tenantSlug === "zhaopin"
                ? { entity_id: run.subject ?? run.id }
                : {}),
              cancelledBy: auth.tenantSlug,
              previousStatus,
            },
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          writeAudit({
            tenantId: auth.tenantId,
            actorUserId: auth.userId ?? undefined,
            action: "run.cancel.failed",
            targetType: "run",
            targetId: run.id,
            meta: { previousStatus, reason: "inngest_send_failed", error },
          });
          req.log.error(
            { err, runId: run.id, action: "run.cancel.inngest_send_failed" },
            "cancel: Inngest did not accept the cancellation; run status remains active",
          );
          return reply.fail(
            "cancel_signal_failed",
            "Inngest did not acknowledge the cancellation signal; run status was not changed",
            502,
          );
        }
      }

      const endedAt = new Date();
      const startedAtMs = run.startedAt?.getTime() ?? endedAt.getTime();
      const durationMs = Math.max(0, endedAt.getTime() - startedAtMs);
      const auditId = makeId("aud");
      const persisted = db.transaction((tx) => {
        const updated = tx
          .update(runs)
          .set({
            status: "cancelled",
            endedAt,
            durationMs,
            outputValid: false,
            errorMessage: "cancelled_by_operator",
          })
          .where(
            and(
              eq(runs.id, run.id),
              eq(runs.tenantId, auth.tenantId),
              inArray(runs.status, ["queued", "running", "waiting"]),
            ),
          )
          .run() as { changes?: number };
        if ((updated.changes ?? 0) !== 1) return false;
        tx.insert(auditLog)
          .values({
            id: auditId,
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "run.cancel",
            targetType: "run",
            targetId: run.id,
            at: endedAt,
            metaJson: {
              previousStatus,
              durationMs,
              signal: isManifest ? "inngest_acknowledged" : "durable_status",
            } as never,
          })
          .run();
        return true;
      });

      if (!persisted) {
        const current = db
          .select({ status: runs.status })
          .from(runs)
          .where(and(eq(runs.id, run.id), eq(runs.tenantId, auth.tenantId)))
          .all()[0];
        if (current?.status === "cancelled") {
          // The race winner was another cancel; self-heal missing Studio
          // terminal evidence while remaining idempotent.
          await ensureStudioCancellationEvidence();
        }
        return reply.ok({
          runId: run.id,
          status: current?.status ?? run.status,
          cancelled: false,
          note: `Run reached status=${current?.status ?? "unknown"} before cancellation was committed; no row was overwritten.`,
        });
      }

      // Studio/replay runs additionally persist terminal cancellation
      // evidence (artifacts + session state) once the row is committed.
      await ensureStudioCancellationEvidence();

      try {
        publishStreamEvent({
          type: "run.cancelled",
          tenantId: auth.tenantId,
          at: endedAt.getTime(),
          runId: run.id,
          reason: "cancelled_by_operator",
        });
        publishStreamEvent({
          type: "audit.recorded",
          tenantId: auth.tenantId,
          at: endedAt.getTime(),
          auditId,
          action: "run.cancel",
          actorUserId: auth.userId,
          targetType: "run",
          targetId: run.id,
          decision: null,
        });
      } catch {
        /* durable run + audit rows are authoritative */
      }

      req.log.info(
        {
          runId: run.id,
          tenantSlug: auth.tenantSlug,
          previousStatus,
          isManifest,
          action: "run.cancel",
        },
        "cancel: runtime signal accepted and run committed as cancelled",
      );

      const noteSuffix = isManifest
        ? "Inngest acknowledged the cancel signal; the manifest function will exit at its next step boundary."
        : "Code agent will exit at the next cooperative-cancel checkpoint (between LLM calls).";

      return reply.ok({
        runId: run.id,
        status: "cancelled",
        cancelled: true,
        note: `Run status flipped to cancelled. ${noteSuffix}`,
      });
    },
  );

  // DELETE /v1/runs/:id — soft-delete (tombstone) a single run. Recoverable
  // from the recycle bin via POST /runs/:id/restore. Tenant-scoped and refuses
  // an in-flight run (cancel it first). Idempotent: re-deleting a tombstoned
  // run is a 200 no-op.
  app.delete<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const auth = requirePermission(req, "runs.delete");
    const reason = softDeleteRun(auth.tenantId, req.params.id);
    if (reason === "not_found")
      return reply.fail("not_found", "run not found", 404);
    if (reason === "active")
      return reply.fail(
        "run_active",
        "cannot delete an in-flight run — cancel it first",
        409,
      );
    if (reason === "ok") {
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "run.delete",
        targetType: "run",
        targetId: req.params.id,
        meta: {},
      });
      return reply.ok({
        id: req.params.id,
        deleted: true,
        note: "Run soft-deleted (recoverable from the recycle bin).",
      });
    }
    // already_deleted → idempotent no-op success.
    return reply.ok({
      id: req.params.id,
      deleted: false,
      note: "Run already in the recycle bin; no action taken.",
    });
  });

  // POST /v1/runs/:id/restore — un-tombstone a soft-deleted run.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/restore",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.delete");
      const restored = restoreRun(auth.tenantId, req.params.id);
      if (restored) {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "run.restore",
          targetType: "run",
          targetId: req.params.id,
          meta: {},
        });
      }
      return reply.ok({
        id: req.params.id,
        restored,
        note: restored
          ? "Run restored from the recycle bin."
          : "Nothing to restore (run not found or not deleted).",
      });
    },
  );

  // DELETE /v1/runs?scope=… — bulk maintenance. scope=oldest&n=100 tombstones
  // the N oldest finished runs (清理最旧 N 条); scope=all tombstones every
  // finished run (一键清空); scope=purge HARD-deletes the recycle bin + log
  // files (清空回收站; irreversible). None ever touch an in-flight run.
  app.delete("/runs", async (req, reply) => {
    const auth = requirePermission(req, "runs.delete");
    const q = req.query as { scope?: string; n?: string };

    if (q.scope === "oldest") {
      const n = Number(q.n ?? 0);
      if (!Number.isFinite(n) || n <= 0)
        return reply.fail(
          "bad_request",
          "scope=oldest requires a positive `n`",
          400,
        );
      const deleted = bulkSoftDeleteRuns(
        auth.tenantId,
        "oldest",
        Math.trunc(n),
      );
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "run.delete.bulk",
        targetType: "run",
        targetId: `oldest:${Math.trunc(n)}`,
        meta: { scope: "oldest", n: Math.trunc(n), deleted },
      });
      return reply.ok({
        scope: "oldest",
        deleted,
        note: `Soft-deleted ${deleted} oldest finished run(s).`,
      });
    }

    if (q.scope === "all") {
      const deleted = bulkSoftDeleteRuns(auth.tenantId, "all");
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "run.delete.bulk",
        targetType: "run",
        targetId: "all",
        meta: { scope: "all", deleted },
      });
      return reply.ok({
        scope: "all",
        deleted,
        note: `Soft-deleted ${deleted} finished run(s).`,
      });
    }

    if (q.scope === "purge") {
      const deleted = await purgeDeletedRuns(auth.tenantId);
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "run.purge",
        targetType: "run",
        targetId: "recycle-bin",
        meta: { scope: "purge", deleted },
      });
      return reply.ok({
        scope: "purge",
        deleted,
        note: `Permanently removed ${deleted} run(s) from the recycle bin.`,
      });
    }

    return reply.fail(
      "bad_request",
      "scope must be one of: oldest | all | purge",
      400,
    );
  });
}
