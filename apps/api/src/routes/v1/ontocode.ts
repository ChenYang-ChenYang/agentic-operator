import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { factorySourceOntologyHash } from "@agentic/agent-factory";
import {
  ONTOCODE_COMMAND_POLICY,
  resolveOntoCodeAutonomyActionPolicy,
  CancelOntoCodeConfigurationTaskRequestSchema,
  CloseOntoCodeSessionRequestSchema,
  CommitOntoCodeChangeSetRequestSchema,
  CommitOntoCodeWorkspacePatchRequestSchema,
  CreateOntoCodeArtifactRequestSchema,
  CreateOntoCodeArtifactVersionRequestSchema,
  CreateOntoCodeChangeSetRequestSchema,
  CreateOntoCodeCommandRequestSchema,
  CreateOntoCodeConfigurationTaskRequestSchema,
  CreateOntoCodeEvidenceRecordRequestSchema,
  CreateOntoCodeHarnessJobRequestSchema,
  CreateOntoCodeProjectRequestSchema,
  CreateOntoCodeSessionRequestSchema,
  DecideOntoCodeCommandRequestSchema,
  ListOntoCodeCommandsQuerySchema,
  ListOntoCodeArtifactsQuerySchema,
  ListOntoCodeArtifactVersionsQuerySchema,
  ListOntoCodeChangeSetsQuerySchema,
  ListOntoCodeConfigurationTasksQuerySchema,
  ListOntoCodeEvidenceRecordsQuerySchema,
  ListOntoCodeEventsQuerySchema,
  ListOntoCodeHarnessJobsQuerySchema,
  ListOntoCodeMessagesQuerySchema,
  ListOntoCodePackageVersionsQuerySchema,
  ListOntoCodeSandboxAttemptsQuerySchema,
  ListOntoCodeProjectsQuerySchema,
  ListOntoCodeSessionsQuerySchema,
  OntoCodeArtifactCreateReceiptSchema,
  OntoCodeArtifactGetReceiptSchema,
  OntoCodeArtifactListReceiptSchema,
  OntoCodeArtifactVersionCreateReceiptSchema,
  OntoCodeArtifactVersionGetReceiptSchema,
  OntoCodeArtifactVersionListReceiptSchema,
  OntoCodeChangeSetCommitReceiptSchema,
  OntoCodeChangeSetCreateReceiptSchema,
  OntoCodeChangeSetGetReceiptSchema,
  OntoCodeChangeSetListReceiptSchema,
  OntoCodeCommandCreateReceiptSchema,
  OntoCodeCommandDecisionReceiptSchema,
  OntoCodeCommandGetReceiptSchema,
  OntoCodeCommandListReceiptSchema,
  OntoCodeConfigurationTaskCancelReceiptSchema,
  OntoCodeConfigurationTaskCreateReceiptSchema,
  OntoCodeConfigurationTaskGetReceiptSchema,
  OntoCodeConfigurationTaskListReceiptSchema,
  OntoCodeConfigurationTaskVerifyReceiptSchema,
  OntoCodeEventListReceiptSchema,
  OntoCodeEvidenceRecordCreateReceiptSchema,
  OntoCodeEvidenceRecordGetReceiptSchema,
  OntoCodeEvidenceRecordListReceiptSchema,
  OntoCodeHarnessJobCreateReceiptSchema,
  OntoCodeHarnessJobGetReceiptSchema,
  OntoCodeHarnessJobListReceiptSchema,
  OntoCodeMessageListReceiptSchema,
  OntoCodeMessagePostReceiptSchema,
  OntoCodeCandidateHeadGetReceiptSchema,
  OntoCodePackageVersionListReceiptSchema,
  OntoCodeSandboxAttemptGetReceiptSchema,
  OntoCodeSandboxAttemptListReceiptSchema,
  OntoCodeProjectCreateReceiptSchema,
  OntoCodeProjectGetReceiptSchema,
  OntoCodeProjectListReceiptSchema,
  OntoCodeSessionCreateReceiptSchema,
  OntoCodeSessionCloseReceiptSchema,
  OntoCodeOntologyFreshnessSchema,
  OntoCodeSessionGetReceiptSchema,
  OntoCodeSessionListReceiptSchema,
  OntoCodeSessionUpdateReceiptSchema,
  OntoCodeSuiteOverviewReceiptSchema,
  OntoCodeTurnReceiptSchema,
  OntoCodeWorkspacePatchCommitReceiptSchema,
  PostOntoCodeTurnRequestSchema,
  PostOntoCodeMessageRequestSchema,
  UpdateOntoCodeSessionRequestSchema,
  VerifyOntoCodeConfigurationTaskRequestSchema,
} from "@agentic/contracts";
import { requirePermission } from "../../plugins/rbac";
import { makeBoundFactoryOntologySource } from "../../services/agent-factory/bound-ontology-source";
import { withFactoryTenantLock } from "../../services/agent-factory/tenant-lock";
import {
  cancelOntoCodeConfigurationTask,
  createOntoCodeConfigurationTask,
  getOntoCodeConfigurationTask,
  listOntoCodeConfigurationTasks,
  verifyOntoCodeConfigurationTask,
} from "../../services/ontocode-configuration-task-store";
import {
  getOntoCodeCandidateHead,
  listOntoCodePackageVersions,
} from "../../services/ontocode-candidate-store";
import {
  getOntoCodeSandboxAttempt,
  listOntoCodeSandboxAttempts,
} from "../../services/ontocode-sandbox-attempt-store";
import { getOntoCodeSuiteOverview } from "../../services/ontocode-suite-overview";
import { confirmSessionHumanBoundaries } from "../../services/ontocode-human-boundary";
import { writeAudit } from "../../plugins/audit";
import { commitOntoCodeWorkspacePatch } from "../../services/ontocode-workspace-patch-store";
import {
  appendOntoCodeUserMessage,
  assertOntoCodeOntologyBinding,
  closeOntoCodeSession,
  cancelOntoCodeSessionJob,
  deleteOntoCodeSession,
  commitOntoCodeChangeSet,
  createOntoCodeArtifact,
  createOntoCodeArtifactVersion,
  createOntoCodeChangeSet,
  createOntoCodeCommand,
  createOntoCodeEvidenceRecord,
  createOntoCodeHarnessJob,
  createOntoCodeProject,
  createOntoCodeSession,
  createOntoCodeTurn,
  decideOntoCodeCommand,
  getOntoCodeArtifact,
  getOntoCodeArtifactVersion,
  getOntoCodeChangeSet,
  getOntoCodeCommand,
  getOntoCodeEvidenceRecord,
  getOntoCodeHarnessJob,
  getOntoCodeProject,
  getOntoCodeSession,
  listOntoCodeArtifacts,
  listOntoCodeArtifactVersions,
  listOntoCodeChangeSets,
  listOntoCodeCommands,
  listOntoCodeEvidenceRecords,
  listOntoCodeEvents,
  listOntoCodeHarnessJobs,
  listOntoCodeMessages,
  listOntoCodeProjects,
  listOntoCodeSessions,
  makeOntoCodeIdempotencyKey,
  OntoCodeStoreError,
  recordOntoCodeOntologyShadowing,
  retryOntoCodeSessionJob,
  updateOntoCodeSession,
  type OntoCodeStoreContext,
} from "../../services/ontocode-session-store";
import { redactHarnessTelemetryPayload } from "../../services/ontocode-telemetry-redaction";
import {
  publicOntoCodeHarnessJob,
  publicOntoCodeMessage,
  publicOntoCodeSessionEvent,
} from "../../services/ontocode-public-projection";
import type { UploadedFirstOntologySource } from "../../services/agent-factory/uploaded-ontology-source";
import {
  collectOntoCodeSessionFootprint,
  listOntoCodeSessionPurges,
  purgeCollectedTargets,
  recordOntoCodeSessionPurge,
  retryOntoCodeSessionPurge,
} from "../../services/ontocode-session-purge";

const IdempotencyKeySchema = z.string().trim().min(8).max(256);

function actorContext(
  req: FastifyRequest,
  permission: "workflows.read" | "workflows.write" | "audit.read",
): OntoCodeStoreContext {
  const auth = requirePermission(req, permission);
  return {
    tenantId: auth.tenantId,
    actorId: auth.userId ?? auth.credentialId ?? null,
  };
}

function idempotencyKey(
  req: FastifyRequest,
  bodyKey: string | undefined,
): string {
  const raw = req.headers["idempotency-key"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return IdempotencyKeySchema.parse(
    header?.trim() || bodyKey || makeOntoCodeIdempotencyKey(),
  );
}

export async function ontocodeRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, _req, reply) => {
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
  });

  app.get("/ontocode/projects", async (req, reply) => {
    const ctx = actorContext(req, "workflows.read");
    const query = ListOntoCodeProjectsQuerySchema.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return reply.ok(
      OntoCodeProjectListReceiptSchema.parse(listOntoCodeProjects(ctx, query)),
    );
  });

  app.post("/ontocode/projects", async (req, reply) => {
    const ctx = actorContext(req, "workflows.write");
    const input = CreateOntoCodeProjectRequestSchema.parse(req.body);
    const receipt = OntoCodeProjectCreateReceiptSchema.parse(
      createOntoCodeProject(ctx, input),
    );
    return reply.ok(receipt, receipt.mode === "created" ? 201 : 200);
  });

  app.get<{ Params: { projectId: string } }>(
    "/ontocode/projects/:projectId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeProjectGetReceiptSchema.parse({
          project: getOntoCodeProject(ctx, req.params.projectId),
        }),
      );
    },
  );

  app.get("/ontocode/sessions", async (req, reply) => {
    const ctx = actorContext(req, "workflows.read");
    const query = ListOntoCodeSessionsQuerySchema.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return reply.ok(
      OntoCodeSessionListReceiptSchema.parse(listOntoCodeSessions(ctx, query)),
    );
  });

  app.post("/ontocode/sessions", async (req, reply) => {
    const auth = requirePermission(req, "workflows.write");
    const ctx: OntoCodeStoreContext = {
      tenantId: auth.tenantId,
      actorId: auth.userId ?? auth.credentialId ?? null,
    };
    const input = CreateOntoCodeSessionRequestSchema.parse(req.body);
    return withFactoryTenantLock(auth.tenantId, async () => {
      const project = getOntoCodeProject(ctx, input.projectId);
      // Re-check under the same tenant workflow lease used by domain rebinding.
      // Once the row is inserted, the open Session itself blocks future
      // rebinding until the FDE explicitly completes or retires it.
      assertOntoCodeOntologyBinding(
        ctx,
        project.domain,
        project.ontologyDomainRegistrationId,
        project.runtimeProfileVersionId,
      );

      let authoritativeHash: string;
      try {
        const ontology = await makeBoundFactoryOntologySource(
          auth.tenantSlug,
          auth.tenantId,
          project.ontologyDomainRegistrationId,
          project.domain,
        ).fetchOntology(project.domain);
        if (ontology.domainId !== project.domain) {
          throw new Error(
            `Ontology source returned domain "${ontology.domainId}" for exact project domain "${project.domain}"`,
          );
        }
        authoritativeHash = factorySourceOntologyHash(ontology);
      } catch (error) {
        throw new OntoCodeStoreError(
          "ontocode_ontology_snapshot_unavailable",
          "The authoritative Ontology could not be read consistently, so OntoCode did not create a Session",
          503,
          {
            tenantId: auth.tenantId,
            projectId: project.id,
            ontologyDomainId: project.domain,
            reason: String((error as Error)?.message ?? error).slice(0, 500),
          },
        );
      }

      if (
        input.ontologySnapshotHash !== undefined &&
        input.ontologySnapshotHash !== authoritativeHash
      ) {
        throw new OntoCodeStoreError(
          "ontocode_ontology_snapshot_mismatch",
          "The requested Ontology snapshot is stale; refresh the Domain and create a new Session",
          409,
          {
            projectId: project.id,
            ontologyDomainId: project.domain,
            requestedSnapshotHash: input.ontologySnapshotHash,
            authoritativeSnapshotHash: authoritativeHash,
          },
        );
      }

      return reply.ok(
        OntoCodeSessionCreateReceiptSchema.parse(
          createOntoCodeSession(ctx, {
            ...input,
            ontologySnapshotHash: authoritativeHash,
          }),
        ),
        201,
      );
    });
  });

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeSessionGetReceiptSchema.parse({
          session: getOntoCodeSession(ctx, req.params.sessionId),
        }),
      );
    },
  );

  // Is the Ontology this Session is pinned to still what the authoritative
  // source serves RIGHT NOW?
  //
  // Drift was already fail-closed at job time (`requireCurrentOntology`
  // re-fetches and refuses a stale snapshot), but only at job time: between
  // jobs an FDE had no way to ask, so the first sign of a moved Ontology was a
  // job dying. This measures it on demand.
  //
  // Three honesty rules hold here and are asserted by the tests:
  //   · a source we could not read is `unavailable` with the REAL reason —
  //     never `current`, because "still fresh" and "we could not check" look
  //     identical to a reader and only one is safe to act on;
  //   · `servedBy` names the source object that actually produced the ontology,
  //     measured from the resolution itself (DomainOntology.source cannot
  //     answer it — an upload does not report "upload" there);
  //   · nothing is cached. The whole point is that it is measured now.
  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/ontology-freshness",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.read");
      const ctx: OntoCodeStoreContext = {
        tenantId: auth.tenantId,
        actorId: auth.userId ?? auth.credentialId ?? null,
      };
      reply.header("Cache-Control", "no-store");

      const session = getOntoCodeSession(ctx, req.params.sessionId);
      const project = getOntoCodeProject(ctx, session.projectId);
      const sessionSnapshotHash = session.ontologySnapshotHash ?? null;

      let source: UploadedFirstOntologySource | null = null;
      let currentHash: string | null = null;
      let reason: string | null = null;
      try {
        source = makeBoundFactoryOntologySource(
          auth.tenantSlug,
          auth.tenantId,
          project.ontologyDomainRegistrationId,
          project.domain,
        );
        const ontology = await source.fetchOntology(project.domain);
        if (ontology.domainId !== project.domain) {
          throw new Error(
            `Ontology source returned domain "${ontology.domainId}" for exact project domain "${project.domain}"`,
          );
        }
        currentHash = factorySourceOntologyHash(ontology);
      } catch (error) {
        // A transport quotes its own configuration back in failure messages, so
        // this reason crosses the SAME redaction boundary as every other
        // Factory-originated string that reaches a durable Session sink.
        // Redact BEFORE clipping: clipping first could split a credential and
        // let the fragment through.
        const raw = String((error as Error)?.message ?? error).slice(0, 2_000);
        reason =
          String(
            redactHarnessTelemetryPayload({ reason: raw }).reason ?? raw,
          ).slice(0, 500) || "本体源读取失败，且未给出原因";
      }

      // Provenance is reported from the RESOLUTION, never inferred from config,
      // and a chain that cannot say which side served says null rather than
      // guessing. It must never turn a successful measurement into a failure.
      //
      // `servedBy` is what PRODUCED the ontology, so a read that produced
      // nothing has no source to name: when the fetch failed, both provenance
      // fields stay empty rather than reporting the side the binding WOULD have
      // picked — that would be inference from configuration, which is the exact
      // thing this field exists to avoid. Which transport failed is in `reason`.
      let servedBy: "allmeta" | "upload" | "manifest" | null = null;
      let shadowed = false;
      let baseTransport: "allmeta" | "manifest" | null = null;
      if (source && currentHash !== null) {
        try {
          const resolution = await source.describeResolution(project.domain);
          baseTransport = resolution.base?.kind ?? null;
          servedBy =
            resolution.servedBy === "upload" ? "upload" : baseTransport;
          shadowed = resolution.shadowed;
        } catch {
          servedBy = null;
          shadowed = false;
        }
      }

      // #ONTOLOGY-SHADOW —— 不改谁赢，只是不再隐瞒。
      if (shadowed) {
        recordOntoCodeOntologyShadowing(ctx, session.id, {
          ontologyDomainId: project.domain,
          baseTransport,
          currentHash,
        });
      }

      return reply.ok(
        OntoCodeOntologyFreshnessSchema.parse({
          schema: "ontocode-ontology-freshness/v1",
          sessionSnapshotHash,
          status:
            currentHash === null
              ? "unavailable"
              : currentHash === sessionSnapshotHash
                ? "current"
                : "changed",
          currentHash,
          servedBy,
          shadowed,
          checkedAt: Date.now(),
          reason,
        }),
      );
    },
  );

  app.patch<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = UpdateOntoCodeSessionRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeSessionUpdateReceiptSchema.parse(
          updateOntoCodeSession(ctx, req.params.sessionId, input),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/close",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CloseOntoCodeSessionRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeSessionCloseReceiptSchema.parse(
          closeOntoCodeSession(ctx, req.params.sessionId, input),
        ),
      );
    },
  );

  // Scrap a Session outright. `close` is idle-only by design, so parked
  // needs_user / failed_recoverable sessions would otherwise be permanently
  // stuck in the rail. The row delete cascades to every child table; the audit
  // row is written first so the removal itself stays accountable.
  app.delete<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const sessionId = req.params.sessionId;
      // #SESSION-PURGE 四拍，顺序不能换：采集（行还在）→ 落记录 → 删行 →
      // 清外部 → 结算。这些文件全都按【作业 id】命名，而作业行是把文件映射回
      // Session 的唯一线索——cascade 恰恰先删作业行。所以采集必须在最前面，
      // 否则从那一刻起这些字节永久不可归属。
      const footprint = await collectOntoCodeSessionFootprint(ctx, sessionId);
      if (!footprint) {
        // 与 store 的 404 保持一致，由它抛出规范化的错误。
        deleteOntoCodeSession(ctx, sessionId);
      }
      const purgeId = `ocp-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      if (footprint) recordOntoCodeSessionPurge(ctx, footprint, purgeId);

      const receipt = deleteOntoCodeSession(ctx, sessionId);

      // 清理失败绝不能把「Session 已删」这个既成事实变成错误：记进 partial
      // 工单，返回里如实带上，可重试。
      const purge = footprint
        ? await purgeCollectedTargets(ctx, purgeId, footprint.targets)
        : null;

      writeAudit({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorId ?? undefined,
        action: "ontocode.session.deleted",
        targetType: "ontocode_session",
        targetId: receipt.sessionId,
        meta: {
          title: receipt.title,
          cancelledJobs: receipt.cancelledJobs,
          purgeId: footprint ? purgeId : null,
          purgeStatus: purge?.status ?? null,
          bytesRemoved: purge?.bytesRemoved ?? 0,
          removed: purge?.removed.length ?? 0,
          failed: purge?.failures.length ?? 0,
        },
      });
      return reply.ok({
        ...receipt,
        purge: purge
          ? {
              id: purgeId,
              status: purge.status,
              removed: purge.removed.length,
              bytesRemoved: purge.bytesRemoved,
              failures: purge.failures,
              // 删除必须说清自己【没】删什么——否则「无法真正删除」的印象
              // 就是这么来的。
              retained: footprint?.retained ?? [],
            }
          : null,
      });
    },
  );

  // #SESSION-PURGE —— 已删除 Session 的持久记录。
  //
  // 这是「这个 Session 曾经存在过」的唯一凭证：什么时候被谁删的、当时有多少
  // 消息/事件/产物、清掉了哪些外部字节、哪些是【刻意保留】的以及为什么。
  // 同时它也是工单：清理失败的记录停在 partial，可以重试补完，而不是留下一堆
  // 没人知道属于谁的文件。
  app.get("/ontocode/session-purges", async (req, reply) => {
    const ctx = actorContext(req, "workflows.read");
    const query = z
      .object({
        status: z.enum(["pending", "completed", "partial"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .strict()
      .parse(req.query);
    reply.header("Cache-Control", "no-store");
    return reply.ok({
      items: listOntoCodeSessionPurges(ctx, {
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit,
      }),
    });
  });

  app.post<{ Params: { purgeId: string } }>(
    "/ontocode/session-purges/:purgeId/retry",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const result = await retryOntoCodeSessionPurge(ctx, req.params.purgeId);
      if (!result) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: "ontocode_session_purge_not_found",
            message: "没有这条清除记录",
          },
        });
      }
      writeAudit({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorId ?? undefined,
        action: "ontocode.session_purge.retried",
        targetType: "ontocode_session_purge",
        targetId: req.params.purgeId,
        meta: {
          status: result.status,
          removed: result.removed.length,
          failed: result.failures.length,
          bytesRemoved: result.bytesRemoved,
        },
      });
      return reply.ok(result);
    },
  );

  // Stop the live Harness job without scrapping the Session. Until this
  // existed, an FDE watching a job run away had exactly one escape: delete the
  // whole Session — which cascades away its messages, events, artifacts and
  // evidence. 「停下这一步」和「这次尝试作废」是两个意图，不该共用一个按钮。
  app.post<{ Params: { sessionId: string }; Body?: { jobId?: string } }>(
    "/ontocode/sessions/:sessionId/cancel-job",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const jobId =
        typeof req.body?.jobId === "string" && req.body.jobId.trim()
          ? req.body.jobId.trim()
          : undefined;
      const receipt = cancelOntoCodeSessionJob(ctx, req.params.sessionId, {
        ...(jobId ? { jobId } : {}),
      });
      if (receipt.cancelled) {
        writeAudit({
          tenantId: ctx.tenantId,
          actorUserId: ctx.actorId ?? undefined,
          action: "ontocode.harness_job.cancelled",
          targetType: "ontocode_session",
          targetId: receipt.sessionId,
          meta: { jobIds: receipt.jobIds },
        });
      }
      return reply.ok(receipt);
    },
  );

  app.post<{ Params: { sessionId: string }; Body?: { jobId?: string } }>(
    "/ontocode/sessions/:sessionId/retry-job",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const jobId =
        typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
      if (!jobId) {
        throw new OntoCodeStoreError(
          "ontocode_harness_retry_job_required",
          "A Harness Job id is required for an explicit retry",
          400,
        );
      }
      const receipt = retryOntoCodeSessionJob(ctx, req.params.sessionId, jobId);
      writeAudit({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorId ?? undefined,
        action: "ontocode.harness_job.retry_requested",
        targetType: "ontocode_harness_job",
        targetId: receipt.jobId,
        meta: {
          sessionId: receipt.sessionId,
          previousAttempt: receipt.attempt,
          sessionRevision: receipt.sessionRevision,
        },
      });
      return reply.ok(receipt);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/configuration-tasks",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeConfigurationTasksQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeConfigurationTaskListReceiptSchema.parse(
          listOntoCodeConfigurationTasks(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/configuration-tasks",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeConfigurationTaskRequestSchema.parse(
        req.body,
      );
      const receipt = OntoCodeConfigurationTaskCreateReceiptSchema.parse(
        createOntoCodeConfigurationTask(ctx, req.params.sessionId, {
          ...input,
          idempotencyKey: idempotencyKey(req, input.idempotencyKey),
        }),
      );
      return reply.ok(receipt, receipt.mode === "created" ? 201 : 200);
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/ontocode/configuration-tasks/:taskId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeConfigurationTaskGetReceiptSchema.parse({
          task: getOntoCodeConfigurationTask(ctx, req.params.taskId),
        }),
      );
    },
  );

  // Configuration Tasks are audit state and are never hard-deleted. PATCH is
  // the safe lifecycle operation: it can only cancel an unresolved task.
  app.patch<{ Params: { taskId: string } }>(
    "/ontocode/configuration-tasks/:taskId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CancelOntoCodeConfigurationTaskRequestSchema.parse(
        req.body,
      );
      return reply.ok(
        OntoCodeConfigurationTaskCancelReceiptSchema.parse(
          cancelOntoCodeConfigurationTask(ctx, req.params.taskId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
      );
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/ontocode/configuration-tasks/:taskId/verify",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = VerifyOntoCodeConfigurationTaskRequestSchema.parse(
        req.body,
      );
      const receipt = OntoCodeConfigurationTaskVerifyReceiptSchema.parse(
        await verifyOntoCodeConfigurationTask(ctx, req.params.taskId, {
          ...input,
          idempotencyKey: idempotencyKey(req, input.idempotencyKey),
        }),
      );
      return reply.ok(
        receipt,
        receipt.verification.outcome === "pending" ? 202 : 200,
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/messages",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeMessagesQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      const page = listOntoCodeMessages(ctx, req.params.sessionId, query);
      return reply.ok(
        OntoCodeMessageListReceiptSchema.parse(
          {
            ...page,
            items: page.items.map(publicOntoCodeMessage),
          },
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/messages",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = PostOntoCodeMessageRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeMessagePostReceiptSchema.parse(
          appendOntoCodeUserMessage(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/turns",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = PostOntoCodeTurnRequestSchema.parse(req.body);
      const receipt = OntoCodeTurnReceiptSchema.parse(
        createOntoCodeTurn(ctx, req.params.sessionId, {
          ...input,
          idempotencyKey: idempotencyKey(req, input.idempotencyKey),
        }),
      );
      return reply.ok(receipt, receipt.mode === "created" ? 201 : 200);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/events",
    async (req, reply) => {
      const query = ListOntoCodeEventsQuerySchema.parse(req.query);
      // A Session's own harness trace (reasoning bursts, tool calls, their
      // results) is workspace content, not audit material: it is the thing the
      // FDE is here to read. Gating it on the admin-only `audit.read` meant the
      // workbench's reasoning panel was empty for everyone below admin. `audit`
      // visibility stays admin-gated — that tier does carry audit records.
      const ctx = actorContext(
        req,
        query.visibility === "audit" ? "audit.read" : "workflows.read",
      );
      reply.header("Cache-Control", "no-store");
      const page = listOntoCodeEvents(ctx, req.params.sessionId, query);
      return reply.ok(
        OntoCodeEventListReceiptSchema.parse(
          {
            ...page,
            items: page.items.map(publicOntoCodeSessionEvent),
          },
        ),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/commands",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeCommandsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeCommandListReceiptSchema.parse(
          listOntoCodeCommands(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/commands",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeCommandRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeCommandCreateReceiptSchema.parse(
          createOntoCodeCommand(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.get<{ Params: { commandId: string } }>(
    "/ontocode/commands/:commandId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeCommandGetReceiptSchema.parse({
          command: getOntoCodeCommand(ctx, req.params.commandId),
        }),
      );
    },
  );

  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: { commandId: string } }>(
      `/ontocode/commands/:commandId/${decision}`,
      async (req, reply) => {
        const ctx = actorContext(req, "workflows.write");
        const input = DecideOntoCodeCommandRequestSchema.parse(req.body);
        return reply.ok(
          OntoCodeCommandDecisionReceiptSchema.parse(
            decideOntoCodeCommand(ctx, req.params.commandId, decision, input),
          ),
        );
      },
    );
  }

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/harness-jobs",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeHarnessJobsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      const page = listOntoCodeHarnessJobs(ctx, req.params.sessionId, query);
      return reply.ok(
        OntoCodeHarnessJobListReceiptSchema.parse(
          {
            ...page,
            items: page.items.map(publicOntoCodeHarnessJob),
          },
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/harness-jobs",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeHarnessJobRequestSchema.parse(req.body);
      // Public callers must always enter Harness execution through a
      // server-derived Command. The store keeps its commandless seam for
      // trusted internal/read-only fixtures, while this boundary prevents an
      // API client from bypassing Session autonomy and approval policy.
      if (!input.commandId) {
        throw new OntoCodeStoreError(
          "ontocode_harness_command_required",
          "Public Harness Jobs require an attached, policy-derived OntoCode Command",
          409,
          { sessionId: req.params.sessionId, jobKind: input.kind },
        );
      }
      const command = getOntoCodeCommand(ctx, input.commandId);
      const session = getOntoCodeSession(ctx, req.params.sessionId);
      const policy = ONTOCODE_COMMAND_POLICY[command.type];
      const autonomyPolicy = resolveOntoCodeAutonomyActionPolicy(
        session.autonomyMode,
        command.type,
      );
      const mismatches = {
        ...(command.sessionId !== req.params.sessionId
          ? {
              sessionId: {
                expected: command.sessionId,
                received: req.params.sessionId,
              },
            }
          : {}),
        ...(input.kind !== policy.jobKind
          ? {
              jobKind: {
                expected: policy.jobKind,
                received: input.kind,
              },
            }
          : {}),
        ...(command.riskClass !== policy.riskClass
          ? {
              riskClass: {
                expected: policy.riskClass,
                received: command.riskClass,
              },
            }
          : {}),
        ...(!autonomyPolicy.allowed
          ? {
              autonomyMode: {
                expected: "read_only command in analysis-only mode",
                received: command.type,
              },
            }
          : {}),
        ...(command.requiresHuman !== autonomyPolicy.requiresHuman
          ? {
              requiresHuman: {
                expected: autonomyPolicy.requiresHuman,
                received: command.requiresHuman,
              },
            }
          : {}),
      };
      if (Object.keys(mismatches).length > 0) {
        throw new OntoCodeStoreError(
          "ontocode_command_policy_mismatch",
          "The Harness Job does not match the linked Command policy",
          409,
          {
            commandId: command.id,
            commandType: command.type,
            mismatches,
          },
        );
      }
      return reply.ok(
        OntoCodeHarnessJobCreateReceiptSchema.parse(
          createOntoCodeHarnessJob(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        202,
      );
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/ontocode/harness-jobs/:jobId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeHarnessJobGetReceiptSchema.parse({
          job: publicOntoCodeHarnessJob(
            getOntoCodeHarnessJob(ctx, req.params.jobId),
          ),
        }),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/changesets",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeChangeSetsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeChangeSetListReceiptSchema.parse(
          listOntoCodeChangeSets(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/changesets",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeChangeSetRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeChangeSetCreateReceiptSchema.parse(
          createOntoCodeChangeSet(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.get<{ Params: { changeSetId: string } }>(
    "/ontocode/changesets/:changeSetId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeChangeSetGetReceiptSchema.parse(
          getOntoCodeChangeSet(ctx, req.params.changeSetId),
        ),
      );
    },
  );

  app.post<{ Params: { changeSetId: string } }>(
    "/ontocode/changesets/:changeSetId/commit",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CommitOntoCodeChangeSetRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeChangeSetCommitReceiptSchema.parse(
          commitOntoCodeChangeSet(ctx, req.params.changeSetId, input),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/workspace-patches",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CommitOntoCodeWorkspacePatchRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeWorkspacePatchCommitReceiptSchema.parse(
          commitOntoCodeWorkspacePatch(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/artifacts",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeArtifactsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeArtifactListReceiptSchema.parse(
          listOntoCodeArtifacts(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/artifacts",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeArtifactRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeArtifactCreateReceiptSchema.parse(
          createOntoCodeArtifact(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/ontocode/artifacts/:artifactId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeArtifactGetReceiptSchema.parse(
          getOntoCodeArtifact(ctx, req.params.artifactId),
        ),
      );
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/ontocode/artifacts/:artifactId/versions",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodeArtifactVersionsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeArtifactVersionListReceiptSchema.parse(
          listOntoCodeArtifactVersions(ctx, req.params.artifactId, query),
        ),
      );
    },
  );

  app.post<{ Params: { artifactId: string } }>(
    "/ontocode/artifacts/:artifactId/versions",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeArtifactVersionRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeArtifactVersionCreateReceiptSchema.parse(
          createOntoCodeArtifactVersion(ctx, req.params.artifactId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.get<{ Params: { versionId: string } }>(
    "/ontocode/artifact-versions/:versionId",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeArtifactVersionGetReceiptSchema.parse(
          getOntoCodeArtifactVersion(ctx, req.params.versionId),
        ),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/candidate-head",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeCandidateHeadGetReceiptSchema.parse(
          getOntoCodeCandidateHead(ctx, req.params.sessionId),
        ),
      );
    },
  );

  // #CONFIG-GAPS — "what does THIS Build still need connected?" as one read.
  // The Candidate's own validation blockers name every unready (system, tool,
  // role); joining them with the derived config requirement is what lets
  // 「去设置」 land on a page that shows the real work instead of the static
  // one-entry provider catalogue. Read-only and secret-free: field NAMES and
  // satisfaction only, never values.
  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/configuration-gaps",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      const { runtimeProvidedSystemNames } = await import(
        "../../services/agent-factory/index"
      );
      const { collectOntoCodeConfigurationGaps } = await import(
        "../../services/ontocode-configuration-gaps"
      );
      return reply.ok(
        collectOntoCodeConfigurationGaps(ctx, req.params.sessionId, {
          runtimeProvidedSystemNames,
          envPresent: (name) =>
            typeof process.env[name] === "string" &&
            process.env[name]!.trim() !== "",
        }),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/suite-overview",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeSuiteOverviewReceiptSchema.parse({
          overview: getOntoCodeSuiteOverview(ctx, req.params.sessionId),
        }),
      );
    },
  );

  // 确认「人工边界」：把当前等待中的 Build 阻塞里那些无已授权工具的系统写成
  // governance.humanBoundary=true 的 System Profile（诚实、持久），并 resume Build。
  app.post<{
    Params: { sessionId: string };
    Body: { waitingJobId?: string; note?: string };
  }>(
    "/ontocode/sessions/:sessionId/confirm-human-boundary",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const body = (req.body ?? {}) as { waitingJobId?: string; note?: string };
      return reply.ok(
        confirmSessionHumanBoundaries(ctx, req.params.sessionId, {
          waitingJobId:
            typeof body.waitingJobId === "string"
              ? body.waitingJobId
              : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
        }),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/package-versions",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.read");
      const query = ListOntoCodePackageVersionsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodePackageVersionListReceiptSchema.parse(
          listOntoCodePackageVersions(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/sandbox-attempts",
    async (req, reply) => {
      const ctx = actorContext(req, "audit.read");
      const query = ListOntoCodeSandboxAttemptsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeSandboxAttemptListReceiptSchema.parse(
          listOntoCodeSandboxAttempts(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.get<{ Params: { attemptId: string } }>(
    "/ontocode/sandbox-attempts/:attemptId",
    async (req, reply) => {
      const ctx = actorContext(req, "audit.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeSandboxAttemptGetReceiptSchema.parse({
          attempt: getOntoCodeSandboxAttempt(ctx, req.params.attemptId),
        }),
      );
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/evidence",
    async (req, reply) => {
      const ctx = actorContext(req, "audit.read");
      const query = ListOntoCodeEvidenceRecordsQuerySchema.parse(req.query);
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeEvidenceRecordListReceiptSchema.parse(
          listOntoCodeEvidenceRecords(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/evidence",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeEvidenceRecordRequestSchema.parse(req.body);
      return reply.ok(
        OntoCodeEvidenceRecordCreateReceiptSchema.parse(
          createOntoCodeEvidenceRecord(ctx, req.params.sessionId, {
            ...input,
            idempotencyKey: idempotencyKey(req, input.idempotencyKey),
          }),
        ),
        201,
      );
    },
  );

  app.get<{ Params: { evidenceId: string } }>(
    "/ontocode/evidence/:evidenceId",
    async (req, reply) => {
      const ctx = actorContext(req, "audit.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        OntoCodeEvidenceRecordGetReceiptSchema.parse({
          evidence: getOntoCodeEvidenceRecord(ctx, req.params.evidenceId),
        }),
      );
    },
  );
}
