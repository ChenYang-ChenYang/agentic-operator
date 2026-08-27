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
import { ZodError } from "zod";
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
import {
  WORKFLOW_TEMPLATE_FILENAME,
  annotateWorkflowManifest,
  blankTemplateForDownload,
} from "../../services/workflow-template-doc";

interface GenerationErrorDescription {
  code: string;
  message: string;
  status: number;
  hint?: string;
  details?: unknown;
}

/**
 * One place that turns anything thrown by a workflow generation into a coded,
 * actionable failure.
 *
 * Previously each unmapped error fell through to Fastify's default handler and
 * reached the operator as a bare "HTTP 500" with no cause — including the two
 * most likely real failures: a Zod error when the model's manifest does not
 * satisfy the response contract, and a raw gateway/transport error (timeout,
 * aborted socket, unreachable base URL) that `isLLMError` does not match.
 * Both are now named.
 */
function describeWorkflowGenerationError(
  error: unknown,
): GenerationErrorDescription {
  if (error instanceof WorkflowDocumentPathError) {
    return {
      code: "unsafe_document_path",
      message: error.message,
      status: 400,
    };
  }
  if (error instanceof WorkflowDocumentFolderNotFoundError) {
    return {
      code: "document_folder_not_found",
      message: error.message,
      status: 404,
    };
  }
  if (error instanceof WorkflowGenerationModelError) {
    return {
      code: "generator_model_unavailable",
      message: error.message,
      status: 400,
    };
  }
  if (error instanceof WorkflowGenerationOutputError) {
    return {
      code: "invalid_generator_output",
      message: error.message,
      status: 502,
      details: error.details,
    };
  }
  if (isLLMError(error)) {
    return {
      code: error.code,
      message: error.message,
      status: llmStatus(error.code),
    };
  }
  // A ZodError here means the generated workflow parsed as JSON but does not
  // satisfy GenerateWorkflowResponseSchema — a model-output problem, not a
  // server fault, so it reads as 502 with the offending paths attached.
  if (error instanceof ZodError) {
    return {
      code: "invalid_generator_output",
      message:
        "the generated workflow did not match the expected response shape",
      status: 502,
      hint: "Regenerate, or narrow the goal — the model produced a workflow the schema rejects.",
      details: error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
        message: issue.message,
      })),
    };
  }
  // Timeouts and dropped sockets arrive as AbortError / TypeError from fetch
  // and would otherwise be indistinguishable from a server bug.
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return {
      code: "timeout",
      message: "the generation timed out before the model responded",
      status: 504,
      hint: "Try again, or shorten the goal and constraints.",
    };
  }
  return {
    code: "generation_failed",
    message: error instanceof Error ? error.message : String(error),
    status: 500,
    hint: "This is unexpected. The server log has the full stack for this request.",
  };
}

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

  /**
   * The self-teaching manifest a person downloads, edits offline, and drops
   * back onto Import manifest.
   *
   * Sent raw rather than through `reply.ok` so the bytes on disk are the exact
   * manifest — an `{ok,data}` envelope would not re-import. The filename is
   * fixed and starts with "workflow": `ImportManifestModal.handleFiles` tests
   * `/actions.*\.json$/i` BEFORE `/workflow.*\.json$/i`, so a name containing
   * "actions" would be routed to the wrong slot.
   */
  app.get("/workflow-templates/:id/download", async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    let document: Record<string, unknown>;
    if (id === "blank") {
      document = blankTemplateForDownload();
    } else {
      const template = getWorkflowTemplate(id);
      if (!template) {
        return reply.fail(
          "workflow_template_not_found",
          `Workflow template not found: ${id}`,
          404,
        );
      }
      document = annotateWorkflowManifest(template.manifest);
    }
    reply.raw.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${WORKFLOW_TEMPLATE_FILENAME}"`,
    });
    reply.raw.end(JSON.stringify(document, null, 2));
    return reply;
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
      // Every failure is named. Nothing reaches the operator as a bare 500 with
      // no cause — see describeWorkflowGenerationError.
      const mapped = describeWorkflowGenerationError(error);
      if (mapped.status >= 500) {
        req.log.error(
          { err: error, code: mapped.code },
          "workflow generation failed",
        );
      }
      return reply.fail(
        mapped.code,
        mapped.message,
        mapped.status,
        mapped.hint,
        mapped.details,
      );
    }
  });

  /**
   * Streaming twin of POST /workflows/generate.
   *
   * A generation is a 20-90 second multi-stage operation behind one request, so
   * the plain endpoint can only offer an indeterminate spinner. This one
   * reports the stages the server actually performs — document extraction, web
   * research, model resolution, the generation call, JSON interpretation, an
   * optional repair pass, and validation — with real per-stage durations and
   * token counts, then ends with the same payload the plain endpoint returns.
   *
   * The plain endpoint stays as-is for API clients and as a fallback.
   */
  app.post("/workflows/generate/stream", async (req, reply) => {
    const auth = requireWorkspaceWriter(req);
    // Parse BEFORE hijacking so a malformed body still gets a normal 400.
    const body = GenerateWorkflowBodySchema.parse(req.body);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write(": workflow generation stream\n\n");

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        raw.end();
      } catch {
        // Socket already gone.
      }
    };
    req.raw.on("close", () => {
      closed = true;
    });
    const send = (event: string, data: unknown): void => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      try {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };
    // Some proxies buffer an idle stream; a comment every 15s keeps it open
    // across a long generation call.
    const heartbeat = setInterval(() => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      try {
        raw.write(": keepalive\n\n");
      } catch {
        closed = true;
      }
    }, 15_000);

    try {
      const result = GenerateWorkflowResponseSchema.parse(
        await generateWorkflowPreview(body, auth, (event) =>
          send("progress", event),
        ),
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
          streamed: true,
        },
      });
      send("result", result);
    } catch (error) {
      const mapped = describeWorkflowGenerationError(error);
      req.log.error(
        { err: error, code: mapped.code },
        "workflow generation stream failed",
      );
      send("failed", mapped);
    } finally {
      clearInterval(heartbeat);
      close();
    }
    return reply;
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
