import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agents, auditLog, getDb, runs, tasks } from "@agentic/db";
import {
  getTenantInngest,
  publishStreamEvent,
  tenantEventName,
} from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import { BulkRunActionBody, ListRunsQuery } from "@agentic/contracts";
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
  bulkSoftDeleteRunIds,
  bulkRestoreRunIds,
  purgeRunIds,
  purgeDeletedRuns,
  selectRunIds,
} from "../../queries/runs";
import { getRunSummary } from "../../queries/reasoning";
import {
  generateRunSummary,
  RunSummaryGenerationError,
} from "../../services/run-summary";
import { finalizeCancelledStudioRun } from "../../services/studio-runner";
import {
  replayRunForOperator,
  RunReplayError,
} from "../../services/run-replay";

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
        triggerEvent: q.triggerEvent,
        invocationSource: q.invocationSource,
        businessResult: q.businessResult,
        testRun:
          q.testRun === undefined
            ? undefined
            : q.testRun === "1" || q.testRun === "true",
        from: q.from,
        to: q.to,
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
      triggerEvent: q.triggerEvent,
      invocationSource: q.invocationSource,
      businessResult: q.businessResult,
      testRun:
        q.testRun === undefined
          ? undefined
          : q.testRun === "1" || q.testRun === "true",
      from: q.from,
      to: q.to,
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
      try {
        const replay = await replayRunForOperator(
          auth,
          req.params.id,
          req.body ?? {},
        );
        return reply.ok(replay.body, replay.statusCode);
      } catch (error) {
        if (error instanceof RunReplayError) {
          req.log.warn({ error, runId: req.params.id }, "run replay rejected");
          return reply.fail(
            error.code,
            error.message,
            error.statusCode,
            undefined,
            error.issues,
          );
        }
        throw error;
      }
    },
  );

  // POST /v1/runs/bulk-actions — selected ids or a server-side filter snapshot.
  // Filter mode is what makes "select all matching" correct across pagination.
  app.post("/runs/bulk-actions", async (req, reply) => {
    const body = BulkRunActionBody.parse(req.body);
    const permission = body.action === "replay" ? "runs.replay" : "runs.delete";
    const auth = requirePermission(req, permission);

    const runIds =
      body.selection.mode === "ids"
        ? [...new Set(body.selection.ids)]
        : selectRunIds(
            auth.tenantId,
            {
              status: body.selection.filter.status,
              agentName: body.selection.filter.agent,
              query: body.selection.filter.q,
              triggerEvent: body.selection.filter.triggerEvent,
              invocationSource: body.selection.filter.invocationSource,
              businessResult: body.selection.filter.businessResult,
              testRun: body.selection.filter.testRun,
              from: body.selection.filter.from,
              to: body.selection.filter.to,
              deleted: body.selection.filter.deleted,
            },
            body.selection.excludeIds,
          );
    if (runIds.length > 10_000) {
      return reply.fail(
        "selection_too_large",
        "selection matches more than 10,000 runs; narrow the filters first",
        413,
      );
    }

    let affected = 0;
    const replayedRunIds: string[] = [];
    const failures: Array<{ runId: string; error: string }> = [];
    if (body.action === "delete") {
      affected = bulkSoftDeleteRunIds(auth.tenantId, runIds);
    } else if (body.action === "restore") {
      affected = bulkRestoreRunIds(auth.tenantId, runIds);
    } else if (body.action === "purge") {
      affected = await purgeRunIds(auth.tenantId, runIds);
    } else {
      if (runIds.length > 200) {
        return reply.fail(
          "replay_selection_too_large",
          "bulk replay is limited to 200 runs per request",
          413,
        );
      }
      for (const runId of runIds) {
        try {
          const replay = await replayRunForOperator(auth, runId);
          if (replay.newRunId) replayedRunIds.push(replay.newRunId);
          affected += 1;
        } catch (error) {
          failures.push({
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: `run.${body.action}.bulk`,
      targetType: "run",
      targetId:
        body.selection.mode === "ids" ? "selected" : "filtered-selection",
      meta: {
        matched: runIds.length,
        affected,
        skipped: runIds.length - affected,
        filter:
          body.selection.mode === "filter" ? body.selection.filter : undefined,
      },
    });
    return reply.ok({
      action: body.action,
      matched: runIds.length,
      affected,
      skipped: runIds.length - affected,
      replayedRunIds: body.action === "replay" ? replayedRunIds : undefined,
      failures: failures.length > 0 ? failures : undefined,
      note: `${affected} of ${runIds.length} selected run(s) processed.`,
    });
  });

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

  // POST /v1/runs/:id/pause — §G4 operator hold for an in-flight manifest run.
  //
  // Pausing is durable-cooperative, mirroring the cancel contract's
  // status-row discipline: the route flips `runs.status` to `paused`
  // (allowed only from running/waiting), and the runtime's memoized
  // `pause-check-<ord>` step (packages/runtime/src/register.ts) reads that
  // row before each action and parks the function on
  // `step.waitForEvent("pause-wait-<ord>")` until the tenant `run.resume`
  // event matching this runId arrives (7d timeout). No Inngest signal is
  // needed to PAUSE — the durable row is the cooperative signal — so this
  // write commits directly, like the code-agent cancel path.
  //
  // Idempotency: pausing an already-paused or terminal run is a 200 no-op.
  app.post<{ Params: { id: string } }>(
    "/runs/:id/pause",
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
      if (run.status === "paused") {
        return reply.ok({
          runId: run.id,
          status: "paused",
          paused: false,
          note: "Run is already paused; no action taken.",
        });
      }
      if (!["running", "waiting"].includes(run.status)) {
        return reply.ok({
          runId: run.id,
          status: run.status,
          paused: false,
          note: `Run is not pausable from status=${run.status}; no action taken.`,
        });
      }
      const previousStatus = run.status;
      const pausedAt = new Date();
      const auditId = makeId("aud");
      const persisted = db.transaction((tx) => {
        const updated = tx
          .update(runs)
          .set({ status: "paused" })
          .where(
            and(
              eq(runs.id, run.id),
              eq(runs.tenantId, auth.tenantId),
              inArray(runs.status, ["running", "waiting"]),
            ),
          )
          .run() as { changes?: number };
        if ((updated.changes ?? 0) !== 1) return false;
        tx.insert(auditLog)
          .values({
            id: auditId,
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "run.pause",
            targetType: "run",
            targetId: run.id,
            at: pausedAt,
            metaJson: { previousStatus } as never,
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
        return reply.ok({
          runId: run.id,
          status: current?.status ?? run.status,
          paused: false,
          note: `Run reached status=${current?.status ?? "unknown"} before the pause was committed; no row was overwritten.`,
        });
      }
      return reply.ok({
        runId: run.id,
        status: "paused",
        paused: true,
        note: "Run will park before its next action until resumed.",
      });
    },
  );

  // POST /v1/runs/:id/resume — §G4 counterpart of pause.
  //
  // Fail-closed ordering mirrors cancel: a parked manifest function only
  // wakes on the tenant `run.resume` Inngest event, so the broker must
  // accept that signal BEFORE the durable row flips back to running — a
  // resume the runtime never received must not look resumed in the UI.
  // The runtime's own `pause-resume-<ord>` step also performs a guarded
  // paused→running flip, so the row converges even when the engine wakes
  // before/without this route's update (e.g. direct DB pauses in tests).
  app.post<{ Params: { id: string } }>(
    "/runs/:id/resume",
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
      if (run.status !== "paused") {
        return reply.ok({
          runId: run.id,
          status: run.status,
          resumed: false,
          note: `Run is not paused (status=${run.status}); no action taken.`,
        });
      }
      try {
        await getTenantInngest(auth.tenantSlug).send({
          // Stable per (run, pause cycle): timestamp disambiguates repeated
          // pause/resume cycles while broker retries of one click dedupe.
          id: `resume-${run.id}-${run.startedAt?.getTime() ?? 0}-${Date.now()}`,
          name: tenantEventName(
            auth.tenantSlug,
            "run.resume",
          ) as `${string}/${string}`,
          data: {
            runId: run.id,
            subject: run.subject ?? null,
            resumedBy: auth.tenantSlug,
          },
        });
      } catch (err) {
        req.log.error(
          { err, runId: run.id, action: "run.resume.inngest_send_failed" },
          "resume: Inngest did not accept the resume signal; run stays paused",
        );
        return reply.fail(
          "resume_signal_failed",
          "Inngest did not acknowledge the resume signal; run status was not changed",
          502,
        );
      }
      const resumedAt = new Date();
      const auditId = makeId("aud");
      db.transaction((tx) => {
        tx.update(runs)
          .set({ status: "running" })
          .where(
            and(
              eq(runs.id, run.id),
              eq(runs.tenantId, auth.tenantId),
              eq(runs.status, "paused"),
            ),
          )
          .run();
        tx.insert(auditLog)
          .values({
            id: auditId,
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "run.resume",
            targetType: "run",
            targetId: run.id,
            at: resumedAt,
            metaJson: { signal: "inngest_acknowledged" } as never,
          })
          .run();
      });
      return reply.ok({
        runId: run.id,
        status: "running",
        resumed: true,
        note: "Resume signal accepted; the parked function continues at its pause gate.",
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
