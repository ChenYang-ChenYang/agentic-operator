import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CreateWorkflowBodySchema,
  SaveWorkflowBodySchema,
  type WorkflowManifestV2,
} from "@agentic/contracts";
import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { LLMGateway, type ProviderAdapter } from "@agentic/llm-gateway";
import {
  bindTriggerInputs,
  resolveAgentEmissions,
  validateAgentInputs,
} from "@agentic/runtime";
import {
  LiveWorkflowDeleteError,
  WorkflowNotFoundError,
  WorkflowVersionConflictError,
  createWorkflowDraft,
  deleteWorkflowDraft,
  getWorkflowDraft,
  listWorkflowDrafts,
  saveWorkflowDraft,
  validateWorkflowManifest,
} from "../src/services/workflow-authoring";
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
} from "../src/services/workflow-templates";
import {
  WORKFLOW_DOCUMENT_LIMITS,
  WorkflowDocumentPathError,
  extractWorkflowDocuments,
  listWorkflowDocumentFolders,
} from "../src/services/workflow-documents";
import { generateWorkflowPreview } from "../src/services/workflow-generator";
import { _setWorkflowResearchFetchForTests } from "../src/services/workflow-research";
import { _setLLMGatewayForTests } from "../src/services/llm";

const suffix = Date.now().toString(36).slice(-8);
const tenantASlug = `wf-auth-${suffix}-a`;
const tenantBSlug = `wf-auth-${suffix}-b`;
const tenantAId = makeId("ten");
const tenantBId = makeId("ten");
const tenantA = { tenantId: tenantAId, tenantSlug: tenantASlug };
const tenantB = { tenantId: tenantBId, tenantSlug: tenantBSlug };

beforeAll(() => {
  getDb()
    .insert(tenants)
    .values([
      { id: tenantAId, slug: tenantASlug, name: "Workflow authoring A" },
      { id: tenantBId, slug: tenantBSlug, name: "Workflow authoring B" },
    ])
    .run();
});

afterAll(() => {
  getDb().delete(tenants).where(eq(tenants.id, tenantAId)).run();
  getDb().delete(tenants).where(eq(tenants.id, tenantBId)).run();
});

describe("workflow authoring templates and immutable drafts", () => {
  it("serves six real templates whose derived counts and manifests validate", () => {
    const templates = listWorkflowTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      "hello-world",
      "webhook-summarizer",
      "scheduled-report",
      "support-triage",
      "document-approval",
      "data-enrichment",
    ]);
    for (const summary of templates) {
      const detail = getWorkflowTemplate(summary.id)!;
      expect(summary.agentCount).toBe(detail.manifest.agents.length);
      expect(summary.actionCount).toBe(
        detail.manifest.agents.reduce(
          (total, agent) => total + agent.actions.length,
          0,
        ),
      );
      const validation = validateWorkflowManifest(detail.manifest);
      expect(
        validation.issues.filter((issue) => issue.severity === "error"),
      ).toEqual([]);
      expect(validation.valid).toBe(true);
    }
  });

  it("binds scheduled and multi-agent template events into runnable v2 inputs", () => {
    const scheduled =
      getWorkflowTemplate("scheduled-report")!.manifest.agents[0]!;
    const scheduledInputs = bindTriggerInputs(scheduled, {
      name: "SCHEDULED_REPORT_REQUESTED",
      data: {
        __scheduledAt: "2026-07-16T09:00:00.000Z",
        __scheduledAgent: scheduled.name,
        __scheduledCron: scheduled.cron,
      },
    });
    expect(validateAgentInputs(scheduled, scheduledInputs).values).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("Scheduled report builder"),
        payload: expect.objectContaining({
          __scheduledAgent: scheduled.name,
        }),
      }),
    );

    for (const templateId of ["support-triage", "document-approval"]) {
      const agents = getWorkflowTemplate(templateId)!.manifest.agents;
      const first = agents[0]!;
      const second = agents[1]!;
      const firstInputs = validateAgentInputs(
        first,
        bindTriggerInputs(first, {
          name: first.trigger[0]!,
          data: { prompt: `Run ${templateId}`, record: { id: "case-1" } },
          subject: "case-1",
        }),
      ).values;
      const output = {
        result: {
          summary: "Validated package",
          result: { id: "case-1" },
          confidence: 0.95,
          assumptions: [],
          needs_review: templateId === "document-approval",
        },
      };
      const connection = first.triggered_event.find((event) =>
        second.trigger.includes(event),
      )!;
      const emission = resolveAgentEmissions({
        definition: first,
        inputs: firstInputs,
        outputs: output,
        source: {
          agentName: first.name,
          runId: "run-template-1",
          subject: "case-1",
        },
      }).find((item) => item.name === connection)!;
      const secondInputs = validateAgentInputs(
        second,
        bindTriggerInputs(second, {
          name: connection,
          data: emission.payload,
          subject: "case-1",
        }),
      ).values;
      expect(secondInputs).toEqual(
        expect.objectContaining(
          second.actor.includes("Human")
            ? { review: expect.objectContaining({ result: output.result }) }
            : {
                prompt: expect.any(String),
                payload: expect.objectContaining({ result: output.result }),
              },
        ),
      );
    }
  });

  it("creates a full blank draft without creating a live deployment", () => {
    const created = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: `blank-${suffix}`,
        name: "Blank starter",
        description: "Safe starter",
        source: { type: "blank" },
        model: { provider: "mock", model: "mock-model-v1" },
      }),
      tenantA,
    );
    expect(created.status).toBe("draft");
    expect(created.manifest.agents).toHaveLength(1);
    expect(created.manifest.agents[0]?.trigger).toEqual(["WORKFLOW_REQUESTED"]);
    expect(created.manifest.agents[0]?.model).toBe("mock-model-v1");
    const live = getDb()
      .select()
      .from(deployments)
      .where(eq(deployments.versionId, created.latestVersionId))
      .all();
    expect(live).toHaveLength(0);

    const internalWorkflowId = makeId("wf");
    getDb()
      .insert(workflows)
      .values({
        id: internalWorkflowId,
        tenantId: tenantBId,
        slug: "__tenant_code__",
        name: "Internal tenant code",
      })
      .run();
    getDb()
      .insert(workflowVersions)
      .values({
        id: makeId("wfv"),
        workflowId: internalWorkflowId,
        version: "1.0.0",
        manifestJson: { kind: "tenant_code", version: "1.0.0" },
      })
      .run();

    // Internal deployment lanes share these tables but are never exposed to
    // or mutable through workflow authoring.
    expect(listWorkflowDrafts(tenantB)).toEqual([]);
    expect(() => getWorkflowDraft("__tenant_code__", tenantB)).toThrow(
      WorkflowNotFoundError,
    );
  });

  it("saves lossless revisions, rejects stale bases, and clones an exact version", () => {
    const template = getWorkflowTemplate("hello-world")!;
    const richManifest = structuredClone(
      template.manifest,
    ) as WorkflowManifestV2;
    richManifest.agents[0]!.extensions = {
      ...(richManifest.agents[0]!.extensions ?? {}),
      vendor: {
        nested: { keep: true, order: ["first", "second"] },
      },
    };
    richManifest.agents[0]!.actions[0] = {
      ...richManifest.agents[0]!.actions[0]!,
      vendor_action: { preserve: "exactly" },
    };
    const source = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: `source-${suffix}`,
        name: "Rich source",
        source: {
          type: "manifest",
          manifest: richManifest,
          actions: [{ external: { keep: [1, 2, 3] } }],
        },
      }),
      tenantA,
    );
    const editedManifest = structuredClone(source.manifest);
    editedManifest.agents[0]!.title = "Only this title changed";
    const saved = saveWorkflowDraft(
      source.slug,
      SaveWorkflowBodySchema.parse({
        baseVersionId: source.latestVersionId,
        manifest: editedManifest,
      }),
      tenantA,
    );
    expect(saved.latestVersionId).not.toBe(source.latestVersionId);
    expect(saved.manifest.agents[0]!.extensions?.vendor).toEqual({
      nested: { keep: true, order: ["first", "second"] },
    });
    expect(saved.manifest.agents[0]!.actions[0]!.vendor_action).toEqual({
      preserve: "exactly",
    });
    expect(saved.actions).toEqual([{ external: { keep: [1, 2, 3] } }]);

    expect(() =>
      saveWorkflowDraft(
        source.slug,
        SaveWorkflowBodySchema.parse({
          baseVersionId: source.latestVersionId,
          manifest: editedManifest,
        }),
        tenantA,
      ),
    ).toThrow(WorkflowVersionConflictError);

    const clone = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: `clone-${suffix}`,
        name: "Rich clone",
        source: {
          type: "clone",
          workflowSlug: source.slug,
          versionId: saved.latestVersionId,
        },
      }),
      tenantA,
    );
    expect(clone.manifest.agents).toEqual(saved.manifest.agents);
    expect(clone.actions).toEqual(saved.actions);
    const lineage = (
      clone.manifest as WorkflowManifestV2 & {
        extensions?: { workflow?: { lineage?: Record<string, unknown> } };
      }
    ).extensions?.workflow?.lineage;
    expect(lineage).toMatchObject({
      source: "clone",
      sourceWorkflowSlug: source.slug,
      sourceVersionId: saved.latestVersionId,
    });
  });

  it("refuses to delete the tenant's live workflow but deletes a draft", () => {
    const draft = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: `delete-${suffix}`,
        name: "Delete guard",
        source: { type: "template", templateId: "hello-world" },
        model: { provider: "mock", model: "mock-model-v1" },
      }),
      tenantA,
    );
    const deploymentId = makeId("dpl");
    getDb()
      .insert(deployments)
      .values({
        id: deploymentId,
        tenantId: tenantAId,
        target: "workflow",
        versionId: draft.latestVersionId,
        status: "live",
      })
      .run();
    expect(() => deleteWorkflowDraft(draft.slug, tenantA)).toThrow(
      LiveWorkflowDeleteError,
    );
    getDb().delete(deployments).where(eq(deployments.id, deploymentId)).run();
    deleteWorkflowDraft(draft.slug, tenantA);
    expect(() => getWorkflowDraft(draft.slug, tenantA)).toThrow();
  });
});

describe("tenant document extraction, research, and generation", () => {
  let documentsRoot: string;
  const previousRoot = process.env.AGENTIC_WORKFLOW_DOCUMENTS_DIR;
  const previousProvider = process.env.AGENTIC_WORKFLOW_RESEARCH_PROVIDER;
  const previousKey = process.env.TAVILY_API_KEY;
  const tenantKeyName = `AGENTIC_TENANT_${tenantASlug
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}_TAVILY_API_KEY`;
  const previousTenantKey = process.env[tenantKeyName];

  beforeAll(async () => {
    documentsRoot = await mkdtemp(
      path.join(os.tmpdir(), "agentic-workflow-docs-"),
    );
    process.env.AGENTIC_WORKFLOW_DOCUMENTS_DIR = documentsRoot;
    const folder = path.join(documentsRoot, tenantASlug, "procedures");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "intake.md"),
      "# Intake\nVerify the request, route exceptions to an operator, and retain evidence.",
      "utf8",
    );
    await writeFile(
      path.join(folder, "controls.html"),
      "<h1>Controls</h1><p>Approval is required for high-risk exceptions.</p>",
      "utf8",
    );
    await writeFile(
      path.join(folder, "oversize.pdf"),
      Buffer.alloc(WORKFLOW_DOCUMENT_LIMITS.maxFileBytes + 1, 1),
    );
    await writeFile(
      path.join(folder, ".private.md"),
      "This hidden file must never become generator context.",
      "utf8",
    );
    const hiddenFolder = path.join(folder, ".editor-cache");
    await mkdir(hiddenFolder);
    await writeFile(
      path.join(hiddenFolder, "credentials.md"),
      "This hidden directory must never become generator context.",
      "utf8",
    );
    await symlink("intake.md", path.join(folder, "linked.md"));
  });

  afterAll(async () => {
    _setLLMGatewayForTests(null);
    _setWorkflowResearchFetchForTests(null);
    if (previousRoot === undefined)
      delete process.env.AGENTIC_WORKFLOW_DOCUMENTS_DIR;
    else process.env.AGENTIC_WORKFLOW_DOCUMENTS_DIR = previousRoot;
    if (previousProvider === undefined)
      delete process.env.AGENTIC_WORKFLOW_RESEARCH_PROVIDER;
    else process.env.AGENTIC_WORKFLOW_RESEARCH_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousKey;
    if (previousTenantKey === undefined) delete process.env[tenantKeyName];
    else process.env[tenantKeyName] = previousTenantKey;
    await rm(documentsRoot, { recursive: true, force: true });
  });

  it("lists only the authenticated tenant tree and safely bounds extraction", async () => {
    const listed = await listWorkflowDocumentFolders(tenantASlug);
    expect(listed.rootAvailable).toBe(true);
    expect(listed.folders.some((folder) => folder.path === "procedures")).toBe(
      true,
    );
    expect(
      listed.folders.find((folder) => folder.path === "procedures"),
    ).toMatchObject({ fileCount: 3 });
    expect(
      listed.folders.some((folder) => folder.path.includes(".editor-cache")),
    ).toBe(false);
    expect((await listWorkflowDocumentFolders(tenantBSlug)).folders).toEqual(
      [],
    );

    const extracted = await extractWorkflowDocuments(tenantASlug, "procedures");
    expect(extracted.documents.map((document) => document.path)).toEqual([
      "procedures/controls.html",
      "procedures/intake.md",
    ]);
    expect(extracted.report.filesSeen).toBe(4);
    expect(
      extracted.report.diagnostics.some((item) =>
        item.path.includes(".private"),
      ),
    ).toBe(false);
    expect(
      extracted.report.diagnostics.some((item) =>
        item.path.includes(".editor-cache"),
      ),
    ).toBe(false);
    expect(extracted.report.truncated).toBe(true);
    expect(
      extracted.report.diagnostics.find(
        (item) => item.path === "procedures/oversize.pdf",
      ),
    ).toMatchObject({ status: "skipped" });
    expect(
      extracted.report.diagnostics.find(
        (item) => item.path === "procedures/linked.md",
      ),
    ).toMatchObject({ status: "skipped" });
    await expect(
      extractWorkflowDocuments(tenantASlug, "../other-tenant"),
    ).rejects.toBeInstanceOf(WorkflowDocumentPathError);
  });

  it("returns a connected, rubric-complete mock preview from documents", async () => {
    const preview = await generateWorkflowPreview(
      {
        purpose:
          "Analyze intake requests, enforce the documented controls, and require approval for high-risk exceptions.",
        documentFolder: "procedures",
        webResearch: false,
        provider: "mock",
        model: "mock-model-v1",
        constraints: ["Never auto-approve a high-risk exception"],
        expectedOutputs: ["Auditable decision package"],
      },
      tenantA,
    );
    expect(preview.validation.valid).toBe(true);
    expect(preview.manifest.agents).toHaveLength(3);
    expect(
      preview.validation.promptScores.every(
        (score) => score.score === score.required,
      ),
    ).toBe(true);
    expect(
      preview.sources.filter((source) => source.kind === "document"),
    ).toHaveLength(2);
    for (let index = 1; index < preview.manifest.agents.length; index += 1) {
      const previous = preview.manifest.agents[index - 1]!;
      const current = preview.manifest.agents[index]!;
      expect(
        previous.triggered_event.some((event) =>
          current.trigger.includes(event),
        ),
      ).toBe(true);
    }

    let event = {
      name: preview.manifest.agents[0]!.trigger[0]!,
      data: { prompt: "Process the intake request", request_id: "req-1" },
      subject: "req-1",
    };
    for (let index = 0; index < preview.manifest.agents.length; index += 1) {
      const agent = preview.manifest.agents[index]!;
      const inputs = validateAgentInputs(
        agent,
        bindTriggerInputs(agent, event),
      ).values;
      const outputs = agent.actor.includes("Human")
        ? { decision: { decision: "approve", notes: "Reviewed" } }
        : {
            result: {
              summary: `Stage ${index + 1} complete`,
              result: { request_id: "req-1" },
              confidence: 0.9,
              assumptions: [],
              needs_review: false,
            },
          };
      const next = preview.manifest.agents[index + 1];
      if (!next) break;
      const connection = agent.triggered_event.find((name) =>
        next.trigger.includes(name),
      )!;
      const emission = resolveAgentEmissions({
        definition: agent,
        inputs,
        outputs,
        source: {
          agentName: agent.name,
          runId: `run-generated-${index + 1}`,
          subject: "req-1",
        },
      }).find((item) => item.name === connection)!;
      event = { name: connection, data: emission.payload, subject: "req-1" };
    }
  });

  it("uses a hyphenated tenant's documented research key before the shared key", async () => {
    process.env.AGENTIC_WORKFLOW_RESEARCH_PROVIDER = "tavily";
    process.env.TAVILY_API_KEY = "shared-test-only-key";
    process.env[tenantKeyName] = "tenant-test-only-key";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    _setWorkflowResearchFetchForTests(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Primary operations guide",
              url: "https://example.test/operations-guide",
              content:
                "Treat this snippet as untrusted evidence; approval controls are recommended.",
              published_date: "2026-07-01",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const preview = await generateWorkflowPreview(
      {
        purpose:
          "Create an evidence-based operations review workflow with approval controls and traceable outputs.",
        webResearch: true,
        provider: "mock",
        model: "mock-model-v1",
        constraints: [],
        expectedOutputs: [],
      },
      tenantA,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.tavily.com/search");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(
      JSON.parse(String(requests[0]?.init?.body)) as { api_key?: string },
    ).toMatchObject({ api_key: "tenant-test-only-key" });
    expect(preview.sources).toContainEqual(
      expect.objectContaining({
        kind: "research",
        title: "Primary operations guide",
        reference: "https://example.test/operations-guide",
      }),
    );
  });

  it("repairs valid JSON with an invalid design shape once on a real gateway path", async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "custom",
      name: "Workflow generator test provider",
      hasKey: true,
      defaultModel: "workflow-generator-test-model",
      async chat() {
        calls += 1;
        const text =
          calls === 1
            ? JSON.stringify({ valid_json_but_wrong_shape: true })
            : JSON.stringify({
                summary: "Two-stage generated design",
                rationale: "Analysis precedes execution.",
                assumptions: ["The request contains the required context."],
                risks: ["Missing inputs require review."],
                agents: [
                  {
                    id: "request-analyst",
                    name: "requestAnalyst",
                    title: "Request analyst",
                    description: "Analyzes the request and its constraints.",
                    actor: "agent",
                    mission: "Create a verified execution brief.",
                    procedure: ["Validate input", "Create the brief"],
                    triggers: ["REQUEST_RECEIVED"],
                    emits: ["REQUEST_ANALYZED"],
                    result_schema: {
                      type: "object",
                      required: ["brief"],
                      properties: { brief: { type: "string", minLength: 1 } },
                      additionalProperties: false,
                    },
                    tools: [
                      {
                        name: "fs.writeMarkdownToArchive",
                        config: {
                          subdir: "workflow-generated",
                          id_prefix: "wf",
                        },
                      },
                    ],
                    actions: [
                      {
                        name: "archiveRequest",
                        type: "tool",
                        tool: "fs.writeMarkdownToArchive",
                        instruction:
                          "Archive the supplied request before analysis.",
                        input_mapping: {
                          text: "$.inputs.payload.text",
                          title: { constant: "Generated workflow request" },
                        },
                        output_mapping: { archive_id: "$.result.id" },
                      },
                      {
                        name: "analyzeRequest",
                        type: "logic",
                        instruction: "Analyze the request without fabrication.",
                      },
                    ],
                  },
                  {
                    id: "request-operator",
                    name: "requestOperator",
                    title: "Request operator",
                    description: "Executes the verified brief.",
                    actor: "agent",
                    mission: "Complete the requested outcome safely.",
                    procedure: ["Validate the brief", "Produce the result"],
                    triggers: ["REQUEST_ANALYZED"],
                    emits: ["REQUEST_COMPLETED"],
                    result_schema: {
                      type: "object",
                      required: ["outcome"],
                      properties: { outcome: { type: "string", minLength: 1 } },
                      additionalProperties: false,
                    },
                    tools: [],
                    actions: [
                      {
                        name: "completeRequest",
                        type: "logic",
                        instruction: "Complete and verify the request.",
                      },
                    ],
                  },
                ],
              });
        return {
          text,
          provider: "custom",
          model: "workflow-generator-test-model",
          tokensIn: 20,
          tokensOut: 40,
          finishReason: "stop",
          latencyMs: 1,
        };
      },
    };
    const gateway = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: "workflow-generator-test-model",
      timeoutMs: 5_000,
    });
    gateway.registerProvider(adapter);
    _setLLMGatewayForTests(gateway);
    try {
      const preview = await generateWorkflowPreview(
        {
          purpose:
            "Analyze operational requests and complete the verified outcome with an auditable result.",
          webResearch: false,
          provider: "custom",
          model: "workflow-generator-test-model",
          constraints: [],
          expectedOutputs: [],
        },
        tenantA,
      );
      expect(calls).toBe(2);
      expect(preview.validation.valid).toBe(true);
      expect(preview.manifest.agents).toHaveLength(2);
      expect(preview.usage).toEqual({ tokensIn: 40, tokensOut: 80 });
      expect(preview.manifest.agents[0]!.tool_use[0]).toMatchObject({
        name: "fs.writeMarkdownToArchive",
        config: { subdir: "workflow-generated", id_prefix: "wf" },
        input_schema: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
        },
      });
      expect(preview.manifest.agents[0]!.actions[0]).toMatchObject({
        type: "tool",
        tool: "fs.writeMarkdownToArchive",
        input_mapping: {
          text: "$.inputs.payload.text",
          title: { constant: "Generated workflow request" },
        },
        output_mapping: { archive_id: "$.result.id" },
      });
    } finally {
      _setLLMGatewayForTests(null);
    }
  });

  it("canonicalizes a model-supplied v2 manifest without losing runnable contracts", async () => {
    const domainMarker = "DOMAIN_MARKER_CANONICAL_GENERATOR";
    const actionMarker = "ACTION_MARKER_CANONICAL_GENERATOR";
    const adapter: ProviderAdapter = {
      id: "custom",
      name: "Canonical workflow generator test provider",
      hasKey: true,
      defaultModel: "canonical-generator-model",
      async chat() {
        return {
          text: JSON.stringify({
            summary: "Canonical two-stage workflow",
            rationale: "A typed brief connects analysis to execution.",
            manifest: {
              $schemaVersion: 2,
              agents: [
                {
                  id: "canonical-analyst",
                  name: "canonicalAnalyst",
                  title: "Canonical analyst",
                  description: "Produces a typed execution brief.",
                  actor: ["Agent"],
                  trigger: ["CANONICAL_REQUESTED"],
                  trigger_bindings: {
                    CANONICAL_REQUESTED: {
                      undeclared: { path: "$" },
                    },
                  },
                  inputs: [
                    {
                      id: "prompt",
                      kind: "prompt",
                      required: true,
                      schema: { type: "string" },
                    },
                    {
                      id: "request",
                      kind: "value",
                      required: true,
                      schema: {
                        type: "object",
                        required: ["id"],
                        properties: { id: { type: "string" } },
                        additionalProperties: false,
                      },
                    },
                  ],
                  ontology_instructions: `${domainMarker}: preserve this domain rule verbatim.`,
                  user_prompt_template:
                    "Canonical request: {{json inputs.request}}",
                  tool_use: [
                    { name: "fs.writeMarkdownToArchive" },
                    {
                      name: "writeJdToDisk",
                      config: {
                        subdir: "canonical-generated",
                        id_prefix: "canonical",
                      },
                    },
                  ],
                  actions: [
                    {
                      id: "archive-brief",
                      order: "1",
                      name: "archiveBrief",
                      description: "Archive the typed brief.",
                      action_prompt: actionMarker,
                      type: "tool",
                      tool: "writeJdToDisk",
                      provider: "openai",
                      model: "unselected-action-model",
                      reasoning: { effort: "high" },
                      verbosity: "high",
                      store: true,
                      temperature: 1.8,
                      max_tokens: 999_999,
                      input_mapping: {
                        text: "$.inputs.payload.text",
                        title: { constant: "Canonical brief" },
                      },
                      output_mapping: { archive_id: "$.result.id" },
                    },
                  ],
                  outputs: [
                    {
                      id: "brief",
                      required: true,
                      schema: {
                        type: "object",
                        required: ["id"],
                        properties: { id: { type: "string" } },
                        additionalProperties: false,
                      },
                    },
                  ],
                  triggered_event: ["CANONICAL_BRIEF_READY"],
                  provider: "openai",
                  model: "unselected-agent-model",
                  temperature: 1.9,
                  max_tokens: 999_999,
                  store: true,
                },
                {
                  id: "canonical-operator",
                  name: "canonicalOperator",
                  title: "Canonical operator",
                  description: "Executes a typed brief.",
                  actor: ["Agent"],
                  trigger: ["CANONICAL_BRIEF_READY"],
                  inputs: [
                    {
                      id: "prompt",
                      kind: "prompt",
                      required: false,
                      schema: { type: "string" },
                    },
                    {
                      id: "brief",
                      kind: "value",
                      required: true,
                      schema: {
                        type: "object",
                        required: ["id"],
                        properties: { id: { type: "string" } },
                        additionalProperties: false,
                      },
                    },
                  ],
                  ontology_instructions: "Execute only the supplied brief.",
                  user_prompt_template: "Brief: {{json inputs.brief}}",
                  tool_use: [],
                  actions: [
                    {
                      id: "execute-brief",
                      order: "1",
                      name: "executeBrief",
                      description: "Execute the typed brief.",
                      type: "logic",
                      action_prompt: "Execute and verify the typed brief.",
                    },
                  ],
                  outputs: [
                    {
                      id: "outcome",
                      required: true,
                      schema: { type: "object" },
                    },
                  ],
                  triggered_event: ["CANONICAL_COMPLETED"],
                },
              ],
            },
          }),
          provider: "custom",
          model: "canonical-generator-model",
          tokensIn: 50,
          tokensOut: 100,
          finishReason: "stop",
          latencyMs: 1,
        };
      },
    };
    const gateway = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: "canonical-generator-model",
      timeoutMs: 5_000,
    });
    gateway.registerProvider(adapter);
    _setLLMGatewayForTests(gateway);
    try {
      const preview = await generateWorkflowPreview(
        {
          purpose:
            "Turn a typed canonical request into a verified typed outcome.",
          webResearch: false,
          provider: "custom",
          model: "canonical-generator-model",
          constraints: [],
          expectedOutputs: [],
        },
        tenantA,
      );
      expect(preview.validation.valid).toBe(true);
      const first = preview.manifest.agents[0]!;
      const second = preview.manifest.agents[1]!;
      expect(first.provider).toBe("custom");
      expect(first.model).toBe("canonical-generator-model");
      expect(first.temperature).toBe(0.2);
      expect(first.max_tokens).toBe(3_200);
      expect(first.store).toBe(false);
      expect(first.user_prompt_template).toBe(
        "Canonical request: {{json inputs.request}}",
      );
      expect(first.ontology_instructions?.split(domainMarker)).toHaveLength(2);
      expect(preview.validation.promptScores[0]).toMatchObject({
        score: 11,
        required: 11,
      });
      expect(first.tool_use).toHaveLength(1);
      expect(first.tool_use[0]).toMatchObject({
        name: "fs.writeMarkdownToArchive",
        config: {
          subdir: "canonical-generated",
          id_prefix: "canonical",
        },
        input_schema: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: expect.stringContaining("Markdown body"),
            },
            title: {
              type: "string",
              description: expect.stringContaining("Rendered as"),
            },
          },
        },
      });
      expect(first.actions[0]).toMatchObject({
        tool: "fs.writeMarkdownToArchive",
        action_prompt: actionMarker,
        input_mapping: {
          text: "$.inputs.payload.text",
          title: { constant: "Canonical brief" },
        },
        output_mapping: { archive_id: "$.result.id" },
      });
      for (const key of [
        "provider",
        "model",
        "reasoning",
        "verbosity",
        "store",
        "temperature",
        "max_tokens",
      ]) {
        expect(first.actions[0]).not.toHaveProperty(key);
      }
      expect(first.trigger_bindings?.CANONICAL_REQUESTED).toEqual({
        request: { path: "$.request" },
      });
      expect(first.output_bindings?.CANONICAL_BRIEF_READY).toEqual({
        brief: { output: "brief" },
      });
      expect(second.trigger_bindings?.CANONICAL_BRIEF_READY).toEqual({
        brief: { path: "$.brief" },
      });
      expect(second.output_bindings?.CANONICAL_COMPLETED).toEqual({
        outcome: { output: "outcome" },
      });

      const firstInputs = validateAgentInputs(
        first,
        bindTriggerInputs(first, {
          name: "CANONICAL_REQUESTED",
          data: { request: { id: "request-1" } },
          subject: "request-1",
        }),
      ).values;
      const emission = resolveAgentEmissions({
        definition: first,
        inputs: firstInputs,
        outputs: { brief: { id: "request-1" } },
        source: {
          agentName: first.name,
          runId: "run-canonical-1",
          subject: "request-1",
        },
      }).find((item) => item.name === "CANONICAL_BRIEF_READY")!;
      expect(
        validateAgentInputs(
          second,
          bindTriggerInputs(second, {
            name: emission.name,
            data: emission.payload,
            subject: "request-1",
          }),
        ).values,
      ).toMatchObject({
        prompt: expect.any(String),
        brief: { id: "request-1" },
      });
    } finally {
      _setLLMGatewayForTests(null);
    }
  });
});
