import type { FastifyInstance } from "fastify";
import {
  CreateWorkflowBodySchema,
  GenerateWorkflowBodySchema,
  GenerateWorkflowResponseSchema,
  ManifestImportCommit,
  PublishWorkflowBodySchema,
  SaveWorkflowBodySchema,
  ValidateWorkflowBodySchema,
  WorkflowDetailSchema,
  WorkflowDocumentFoldersResponseSchema,
  WorkflowAgentPromptBodySchema,
  WorkflowAgentPromptResponseSchema,
  WorkflowListResponseSchema,
  WorkflowRunProfileSchema,
  WorkflowRunProfileTargetSchema,
  WorkflowSlugSchema,
  WorkflowTemplateCatalogResponseSchema,
  WorkflowTemplateDetailSchema,
  WorkflowTestRunBodySchema,
  WorkflowTestRunResponseSchema,
  WorkflowValidationResponseSchema,
} from "@agentic/contracts";
import { isLLMError } from "@agentic/llm-gateway";
import { requireAuth, requireWorkspaceWriter } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";
import {
  LiveWorkflowDeleteError,
  WorkflowAlreadyExistsError,
  WorkflowDeploymentHistoryDeleteError,
  WorkflowManifestInputError,
  WorkflowNotFoundError,
  WorkflowTemplateNotFoundError,
  WorkflowVersionConflictError,
  WorkflowVersionNotFoundError,
  createWorkflowDraft,
  deleteWorkflowDraft,
  getWorkflowDraft,
  getWorkflowPublishSnapshot,
  listWorkflowDrafts,
  saveWorkflowDraft,
  validateWorkflowDraft,
  validateWorkflowManifest,
} from "../../services/workflow-authoring";
import {
  WorkflowTestInputError,
  getWorkflowRunProfile,
  runWorkflowDraftTest,
} from "../../services/workflow-test-runner";
import { generateInstructionsForDefinition } from "../../services/agent-drafts";
import {
  BlockingIssuesError,
  OverwriteRequiredError,
  commit as publishManifest,
} from "../../services/manifest-import";
import {
  WorkflowGenerationModelError,
  WorkflowGenerationOutputError,
  generateWorkflowPreview,
} from "../../services/workflow-generator";
import {
  WorkflowDocumentFolderNotFoundError,
  WorkflowDocumentPathError,
  listWorkflowDocumentFolders,
} from "../../services/workflow-documents";
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
} from "../../services/workflow-templates";

function llmStatus(code: string): number {
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
      return 503;
    default:
      return 502;
  }
}

export async function workflowAuthoringRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/workflow-templates", async (req, reply) => {
    requireAuth(req);
    return reply.ok(
      WorkflowTemplateCatalogResponseSchema.parse({
        templates: listWorkflowTemplates(),
      }),
    );
  });

  app.get("/workflow-templates/:id", async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    const template = getWorkflowTemplate(id);
    if (!template) {
      return reply.fail(
        "workflow_template_not_found",
        `Workflow template not found: ${id}`,
        404,
      );
    }
    return reply.ok(WorkflowTemplateDetailSchema.parse(template));
  });

  app.get("/workflow-document-folders", async (req, reply) => {
    const auth = requireAuth(req);
    try {
      return reply.ok(
        WorkflowDocumentFoldersResponseSchema.parse(
          await listWorkflowDocumentFolders(auth.tenantSlug),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowDocumentPathError) {
        return reply.fail("unsafe_document_path", error.message, 400);
      }
      throw error;
    }
  });

  app.get("/workflows", async (req, reply) => {
    const auth = requireAuth(req);
    return reply.ok(
      WorkflowListResponseSchema.parse({
        workflows: listWorkflowDrafts(auth),
      }),
    );
  });

  app.post("/workflows/generate", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    const body = GenerateWorkflowBodySchema.parse(req.body);
    try {
      const result = GenerateWorkflowResponseSchema.parse(
        await generateWorkflowPreview(body, auth),
      );
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.generate",
        targetType: "workflow_preview",
        targetId: result.validation.manifestHash.slice(0, 16),
        meta: {
          provider: result.modelSelection.provider,
          model: result.modelSelection.model,
          purposeChars: body.purpose.length,
          documentFolder: body.documentFolder ?? null,
          documentCount: result.documents?.filesIncluded ?? 0,
          agentCount: result.manifest.agents.length,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          valid: result.validation.valid,
        },
      });
      return reply.ok(result);
    } catch (error) {
      if (error instanceof WorkflowDocumentPathError) {
        return reply.fail("unsafe_document_path", error.message, 400);
      }
      if (error instanceof WorkflowDocumentFolderNotFoundError) {
        return reply.fail("document_folder_not_found", error.message, 404);
      }
      if (error instanceof WorkflowGenerationModelError) {
        return reply.fail("generator_model_unavailable", error.message, 400);
      }
      if (error instanceof WorkflowGenerationOutputError) {
        return reply.fail(
          "invalid_generator_output",
          error.message,
          502,
          undefined,
          error.details,
        );
      }
      if (isLLMError(error)) {
        return reply.fail(error.code, error.message, llmStatus(error.code));
      }
      throw error;
    }
  });

  app.post("/workflows", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    const body = CreateWorkflowBodySchema.parse(req.body);
    try {
      const workflow = WorkflowDetailSchema.parse(
        createWorkflowDraft(body, auth),
      );
      reply.header("ETag", `"${workflow.latestVersionId}"`);
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.create",
        targetType: "workflow",
        targetId: workflow.id,
        meta: {
          slug: workflow.slug,
          source: body.source.type,
          versionId: workflow.latestVersionId,
          agentCount: workflow.agentCount,
        },
      });
      return reply.ok(workflow, 201);
    } catch (error) {
      if (error instanceof WorkflowAlreadyExistsError) {
        return reply.fail("workflow_conflict", error.message, 409);
      }
      if (error instanceof WorkflowTemplateNotFoundError) {
        return reply.fail("workflow_template_not_found", error.message, 404);
      }
      if (error instanceof WorkflowManifestInputError) {
        return reply.fail(
          "invalid_workflow_manifest",
          error.message,
          400,
          undefined,
          error.causeDetails,
        );
      }
      if (
        error instanceof WorkflowNotFoundError ||
        error instanceof WorkflowVersionNotFoundError
      ) {
        return reply.fail("clone_source_not_found", error.message, 404);
      }
      throw error;
    }
  });

  app.get("/workflows/:slug", async (req, reply) => {
    const auth = requireAuth(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    try {
      const workflow = WorkflowDetailSchema.parse(getWorkflowDraft(slug, auth));
      reply.header("ETag", `"${workflow.latestVersionId}"`);
      return reply.ok(workflow);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      throw error;
    }
  });

  app.get("/workflows/:slug/run-profile", async (req, reply) => {
    const auth = requireAuth(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    const target = WorkflowRunProfileTargetSchema.parse(
      (req.query as { target?: string }).target ?? "latest",
    );
    try {
      return reply.ok(
        WorkflowRunProfileSchema.parse(
          getWorkflowRunProfile(slug, target, auth),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      if (error instanceof WorkflowVersionNotFoundError) {
        return reply.fail(
          target === "live"
            ? "workflow_live_version_not_found"
            : "workflow_version_not_found",
          error.message,
          404,
        );
      }
      throw error;
    }
  });

  app.post("/workflows/:slug/test-runs", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    const body = WorkflowTestRunBodySchema.parse(req.body);
    try {
      const result = WorkflowTestRunResponseSchema.parse(
        await runWorkflowDraftTest(slug, body, auth),
      );
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.test_run",
        targetType: "workflow",
        targetId: slug,
        meta: {
          runId: result.runId,
          manifestHash: result.manifestHash,
          triggerEvent: result.trigger.event,
          toolPolicy: result.policy.toolPolicy,
          failurePolicy: result.policy.failurePolicy,
          status: result.status,
          agentRuns: result.summary.agentRuns,
          failed: result.summary.failed,
          blocked: result.summary.blocked,
          tokensIn: result.summary.tokensIn,
          tokensOut: result.summary.tokensOut,
          durationMs: result.durationMs,
        },
      });
      return reply.ok(result);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      if (error instanceof WorkflowTestInputError) {
        return reply.fail(
          error.code,
          error.message,
          400,
          undefined,
          error.details,
        );
      }
      if (isLLMError(error)) {
        return reply.fail(error.code, error.message, llmStatus(error.code));
      }
      throw error;
    }
  });

  app.post(
    "/workflows/:slug/agents/:agentId/generate-instructions",
    async (req, reply) => {
      const auth = requireWorkspaceWriter(req);
      const params = req.params as { slug: string; agentId: string };
      const slug = WorkflowSlugSchema.parse(params.slug);
      const body = WorkflowAgentPromptBodySchema.parse(req.body);
      if (body.definition.id !== params.agentId) {
        return reply.fail(
          "agent_identity_mismatch",
          `Definition id '${body.definition.id}' does not match route agent '${params.agentId}'.`,
          400,
        );
      }
      try {
        // Establish tenant/workflow ownership even when the definition is a
        // new unsaved canvas node.
        getWorkflowDraft(slug, auth);
        const generated = WorkflowAgentPromptResponseSchema.parse(
          await generateInstructionsForDefinition(auth, body.definition, body),
        );
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "workflow.agent_prompt.generate",
          targetType: "workflow_agent",
          targetId: `${slug}/${params.agentId}`,
          meta: {
            mode: body.mode,
            provider: generated.provenance.provider,
            model: generated.provenance.model,
            sourceHash: generated.provenance.source_hash,
          },
        });
        return reply.ok(generated);
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) {
          return reply.fail("workflow_not_found", error.message, 404);
        }
        if (isLLMError(error)) {
          return reply.fail(error.code, error.message, llmStatus(error.code));
        }
        throw error;
      }
    },
  );

  app.put("/workflows/:slug", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    const body = SaveWorkflowBodySchema.parse(req.body);
    try {
      const workflow = WorkflowDetailSchema.parse(
        saveWorkflowDraft(slug, body, auth),
      );
      reply.header("ETag", `"${workflow.latestVersionId}"`);
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.draft.save",
        targetType: "workflow",
        targetId: workflow.id,
        meta: {
          slug,
          baseVersionId: body.baseVersionId,
          versionId: workflow.latestVersionId,
          agentCount: workflow.agentCount,
        },
      });
      return reply.ok(workflow);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      if (error instanceof WorkflowVersionConflictError) {
        return reply.fail(
          "workflow_version_conflict",
          error.message,
          409,
          "Reload the latest server draft and merge or reapply local changes.",
          { currentVersionId: error.currentVersionId },
        );
      }
      if (error instanceof WorkflowManifestInputError) {
        return reply.fail(
          "invalid_workflow_manifest",
          error.message,
          400,
          undefined,
          error.causeDetails,
        );
      }
      throw error;
    }
  });

  app.post("/workflows/:slug/validate", async (req, reply) => {
    const auth = requireAuth(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    const body = ValidateWorkflowBodySchema.parse(req.body);
    try {
      const result = WorkflowValidationResponseSchema.parse(
        validateWorkflowDraft(slug, body, auth),
      );
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.validate",
        targetType: "workflow",
        targetId: slug,
        meta: {
          versionId: result.versionId,
          manifestHash: result.manifestHash,
          valid: result.valid,
          issueCount: result.issues.length,
        },
      });
      return reply.ok(result);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      if (error instanceof WorkflowVersionNotFoundError) {
        return reply.fail("workflow_version_not_found", error.message, 404);
      }
      throw error;
    }
  });

  app.post("/workflows/:slug/publish", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    const body = PublishWorkflowBodySchema.parse(req.body ?? {});
    try {
      const snapshot = getWorkflowPublishSnapshot(slug, body.versionId, auth);
      // Validate the exact immutable version on the server. The canvas's
      // client-side validation is useful feedback, never a publish boundary.
      const validation = validateWorkflowManifest(snapshot.manifest, {
        versionId: snapshot.versionId,
        tenantSlug: auth.tenantSlug,
      });
      if (!validation.valid) {
        return reply.fail(
          "workflow_validation_failed",
          "workflow has blocking validation issues",
          400,
          "Fix every error and save a new immutable draft before publishing.",
          validation,
        );
      }
      const result = ManifestImportCommit.parse(
        await publishManifest(
          {
            mode: "commit",
            workflow: snapshot.manifest,
            ...(snapshot.actions ? { actions: snapshot.actions } : {}),
            target: "production",
            // Clicking Publish confirms promoting THIS version — it does not
            // confirm dropping agents that are live today. A tenant has one
            // live workflow deployment, so a removal here removes the agent
            // from the running system; `overwriteGuard` answers 409 with the
            // diff and the operator re-submits with confirmOverwrite.
            confirm_overwrite: body.confirmOverwrite,
            workflow_slug: snapshot.workflowSlug,
            workflow_name: snapshot.workflowName,
            note: body.note ?? `Published workflow ${snapshot.workflowSlug}`,
            conflict_resolutions: [],
          },
          auth,
          {
            actorUserId: auth.userId ?? undefined,
            log: {
              error: (obj, message) => req.log.error(obj, message ?? ""),
              info: (obj, message) => req.log.info(obj, message ?? ""),
            },
          },
        ),
      );
      return reply.ok(result);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      if (error instanceof WorkflowVersionNotFoundError) {
        return reply.fail("workflow_version_not_found", error.message, 404);
      }
      if (error instanceof WorkflowManifestInputError) {
        return reply.fail(
          "invalid_workflow_manifest",
          error.message,
          400,
          undefined,
          error.causeDetails,
        );
      }
      if (error instanceof BlockingIssuesError) {
        return reply.fail(
          "workflow_publish_blocked",
          "publish pipeline found blocking issues",
          400,
          undefined,
          { issues: error.issues },
        );
      }
      if (error instanceof OverwriteRequiredError) {
        return reply.status(409).send(error.payload);
      }
      throw error;
    }
  });

  app.delete("/workflows/:slug", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    const slug = WorkflowSlugSchema.parse(
      (req.params as { slug: string }).slug,
    );
    try {
      const workflow = getWorkflowDraft(slug, auth);
      deleteWorkflowDraft(slug, auth);
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "workflow.delete",
        targetType: "workflow",
        targetId: workflow.id,
        meta: { slug },
      });
      return reply.ok({ deleted: true, slug });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return reply.fail("workflow_not_found", error.message, 404);
      }
      if (error instanceof LiveWorkflowDeleteError) {
        return reply.fail("workflow_is_live", error.message, 409);
      }
      if (error instanceof WorkflowDeploymentHistoryDeleteError) {
        return reply.fail("workflow_has_deployments", error.message, 409);
      }
      throw error;
    }
  });
}
