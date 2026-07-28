import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { factorySourceOntologyHash } from "@agentic/agent-factory";
import {
  ONTOCODE_COMMAND_POLICY,
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
  updateOntoCodeSession,
  type OntoCodeStoreContext,
} from "../../services/ontocode-session-store";

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
      const receipt = deleteOntoCodeSession(ctx, req.params.sessionId);
      writeAudit({
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorId ?? undefined,
        action: "ontocode.session.deleted",
        targetType: "ontocode_session",
        targetId: receipt.sessionId,
        meta: {
          title: receipt.title,
          cancelledJobs: receipt.cancelledJobs,
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
      return reply.ok(
        OntoCodeMessageListReceiptSchema.parse(
          listOntoCodeMessages(ctx, req.params.sessionId, query),
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
      return reply.ok(
        OntoCodeEventListReceiptSchema.parse(
          listOntoCodeEvents(ctx, req.params.sessionId, query),
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
      return reply.ok(
        OntoCodeHarnessJobListReceiptSchema.parse(
          listOntoCodeHarnessJobs(ctx, req.params.sessionId, query),
        ),
      );
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/ontocode/sessions/:sessionId/harness-jobs",
    async (req, reply) => {
      const ctx = actorContext(req, "workflows.write");
      const input = CreateOntoCodeHarnessJobRequestSchema.parse(req.body);
      if (input.commandId) {
        const command = getOntoCodeCommand(ctx, input.commandId);
        const policy = ONTOCODE_COMMAND_POLICY[command.type];
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
          ...(command.requiresHuman !== policy.requiresHuman
            ? {
                requiresHuman: {
                  expected: policy.requiresHuman,
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
          job: getOntoCodeHarnessJob(ctx, req.params.jobId),
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
            typeof body.waitingJobId === "string" ? body.waitingJobId : undefined,
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
