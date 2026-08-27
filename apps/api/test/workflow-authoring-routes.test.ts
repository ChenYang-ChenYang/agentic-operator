import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  AgentDraftResponseSchema,
  AgentEditorResponseSchema,
  WorkflowAgentPromptResponseSchema,
  GenerateWorkflowResponseSchema,
  WorkflowDetailSchema,
  WorkflowListResponseSchema,
  WorkflowRunProfileSchema,
  WorkflowTemplateCatalogResponseSchema,
  WorkflowTestRunResponseSchema,
  WorkflowValidationResponseSchema,
  type WorkflowDetail,
} from "@agentic/contracts";
import { agents, getDb, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenantASlug = `wf-route-${suffix}-a`;
const tenantBSlug = `wf-route-${suffix}-b`;
const tenantAId = makeId("ten");
const tenantBId = makeId("ten");
const workflowSlug = `route-${suffix}`;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const COMPLETE_TEST_PROMPT =
  "Role mission inputs procedure tool policy output contract completion criteria safety privacy non-fabrication do not fabricate error recovery retry human escalation operator review.";

function testAgent(input: {
  id: string;
  trigger: string;
  emitted: string;
  outputBinding?: boolean;
}) {
  return {
    id: input.id,
    name: input.id.replaceAll("-", ""),
    title: input.id,
    description: `Execute ${input.id}`,
    actor: ["Agent"],
    trigger: [input.trigger],
    inputs: [
      {
        id: "prompt",
        label: "Prompt",
        kind: "prompt",
        required: true,
        schema: { type: "string", minLength: 1 },
        sensitivity: "none",
      },
    ],
    ontology_instructions: COMPLETE_TEST_PROMPT,
    generated: true,
    tool_use: [],
    actions: [
      {
        order: "1",
        name: `${input.id}-execute`,
        description: `Execute ${input.id}`,
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "result",
        label: "Result",
        required: true,
        schema: { type: "string" },
        sensitivity: "none",
      },
    ],
    output_config: {
      format: "json",
      strict: true,
      repair_attempts: 0,
      unwrap_single_output: true,
      artifact: {
        filename: `${input.id}-output.json`,
        persist_individual_outputs: false,
        persist_run_input: true,
        persist_run_record: true,
        persist_raw_response: false,
      },
    },
    triggered_event: [input.emitted],
    ...(input.outputBinding
      ? {
          output_bindings: {
            [input.emitted]: { prompt: { output: "result" } },
          },
        }
      : {}),
    provider: "mock",
    model: "mock-model-v1",
  };
}

describe("workflow authoring HTTP API", () => {
  let env: TestEnv;
  let workflow: WorkflowDetail;

  beforeAll(async () => {
    getDb()
      .insert(tenants)
      .values([
        { id: tenantAId, slug: tenantASlug, name: "Workflow route A" },
        { id: tenantBId, slug: tenantBSlug, name: "Workflow route B" },
      ])
      .run();
    env = await buildTestEnv();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantAId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantBId)).run();
  });

  it("returns the API-owned template catalog", async () => {
    const response = await env.fetch("/v1/workflow-templates", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const catalog = WorkflowTemplateCatalogResponseSchema.parse(body.data);
    expect(catalog.templates).toHaveLength(6);
    expect(catalog.templates[0]?.agentCount).toBeGreaterThan(0);
  });

  it("serves the annotated blank template as a downloadable, re-importable file", async () => {
    const response = await env.fetch("/v1/workflow-templates/blank/download", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    // The importer routes by filename and tests /actions.*\.json$/i BEFORE
    // /workflow.*\.json$/i, so the name must match the second and not the first.
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "";
    expect(filename).toMatch(/workflow.*\.json$/i);
    expect(filename).not.toMatch(/actions.*\.json$/i);

    // The body is the manifest itself, not an {ok,data} envelope — an envelope
    // would not re-import.
    const raw = await response.text();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.$schemaVersion).toBe(2);
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed._readme)).toBe(true);
    expect(parsed.ok).toBeUndefined();
  });

  it("404s an unknown template download", async () => {
    const response = await env.fetch(
      "/v1/workflow-templates/does-not-exist/download",
      { headers: { "x-agentic-tenant": tenantASlug } },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.error?.code).toBe("workflow_template_not_found");
  });

  it("creates and reloads a server draft without making it visible cross-tenant", async () => {
    const created = await env.fetch("/v1/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        slug: workflowSlug,
        name: "Route workflow",
        description: "Created through the new authoring API",
        source: { type: "template", templateId: "hello-world" },
        model: { provider: "mock", model: "mock-model-v1" },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Envelope<unknown>;
    workflow = WorkflowDetailSchema.parse(createdBody.data);
    expect(created.headers.get("etag")).toBe(`"${workflow.latestVersionId}"`);
    expect(workflow.status).toBe("draft");

    const own = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(own.status).toBe(200);
    const other = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      headers: { "x-agentic-tenant": tenantBSlug },
    });
    expect(other.status).toBe(404);
    const otherBody = (await other.json()) as Envelope<unknown>;
    expect(otherBody.error?.code).toBe("workflow_not_found");
  });

  it("saves a new revision and rejects a stale base version", async () => {
    const baseVersionId = workflow.latestVersionId;
    const manifest = structuredClone(workflow.manifest);
    manifest.agents[0]!.title = "Updated through PUT";
    const updated = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({ baseVersionId, manifest }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as Envelope<unknown>;
    workflow = WorkflowDetailSchema.parse(updatedBody.data);
    expect(workflow.latestVersionId).not.toBe(baseVersionId);
    expect(workflow.manifest.agents[0]?.title).toBe("Updated through PUT");

    const stale = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({ baseVersionId, manifest }),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as Envelope<unknown>;
    expect(staleBody.error?.code).toBe("workflow_version_conflict");
  });

  it("materializes a canvas-added agent without rewriting existing identities", async () => {
    const db = getDb();
    const existingDefinition = workflow.manifest.agents[0]!;
    const existing = db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workflowId, workflow.id),
          eq(agents.kebabId, existingDefinition.id),
        ),
      )
      .all()[0];
    expect(existing).toBeDefined();
    db.update(agents)
      .set({
        enabled: true,
        lifecycle: "active",
        title: "Preserve this materialized identity",
      })
      .where(eq(agents.id, existing!.id))
      .run();

    const newAgentId = `canvas-agent-${suffix}`;
    const manifest = structuredClone(workflow.manifest);
    manifest.agents.push({
      ...structuredClone(existingDefinition),
      id: newAgentId,
      name: `canvasAgent${suffix}`,
      title: "Canvas-added agent",
      trigger: ["CANVAS_AGENT_REQUESTED"],
      triggered_event: ["CANVAS_AGENT_COMPLETED"],
    });

    const response = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        baseVersionId: workflow.latestVersionId,
        manifest,
      }),
    });
    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as Envelope<unknown>;
    workflow = WorkflowDetailSchema.parse(responseBody.data);

    const preserved = db
      .select()
      .from(agents)
      .where(eq(agents.id, existing!.id))
      .all()[0];
    expect(preserved).toMatchObject({
      enabled: true,
      lifecycle: "active",
      title: "Preserve this materialized identity",
    });

    const added = db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workflowId, workflow.id), eq(agents.kebabId, newAgentId)),
      )
      .all();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      tenantId: tenantAId,
      enabled: false,
      lifecycle: "draft",
      kind: "manifest",
    });

    const editor = await env.fetch(`/v1/agents/${newAgentId}/editor`, {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(editor.status).toBe(200);
    const editorBody = (await editor.json()) as Envelope<unknown>;
    const parsedEditor = AgentEditorResponseSchema.parse(editorBody.data);
    expect(parsedEditor.agent.kebabId).toBe(newAgentId);
    expect(parsedEditor.draft?.definition.id).toBe(newAgentId);

    const handoff = await env.fetch(`/v1/agents/${newAgentId}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        definition: manifest.agents.find(
          (definition) => definition.id === newAgentId,
        ),
        baseWorkflowVersionId: workflow.latestVersionId,
      }),
    });
    expect(handoff.status).toBe(201);
    const handoffBody = (await handoff.json()) as Envelope<unknown>;
    const handoffDraft = AgentDraftResponseSchema.parse(handoffBody.data).draft;
    expect(handoffDraft.baseWorkflowVersionId).toBe(workflow.latestVersionId);
    expect(handoffDraft.definition.title).toBe("Canvas-added agent");
  });

  it("validates the persisted revision separately from saving", async () => {
    const response = await env.fetch(`/v1/workflows/${workflowSlug}/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const result = WorkflowValidationResponseSchema.parse(body.data);
    expect(result.valid).toBe(true);
    expect(result.versionId).toBe(workflow.latestVersionId);
  });

  it("describes run entrypoints and executes a bounded multi-agent draft test", async () => {
    const profileResponse = await env.fetch(
      `/v1/workflows/${workflowSlug}/run-profile?target=latest`,
      { headers: { "x-agentic-tenant": tenantASlug } },
    );
    expect(profileResponse.status).toBe(200);
    const profileBody = (await profileResponse.json()) as Envelope<unknown>;
    const profile = WorkflowRunProfileSchema.parse(profileBody.data);
    expect(profile.versionId).toBe(workflow.latestVersionId);
    expect(profile.entrypoints.length).toBeGreaterThan(0);

    const missingLiveProfile = await env.fetch(
      `/v1/workflows/${workflowSlug}/run-profile?target=live`,
      { headers: { "x-agentic-tenant": tenantASlug } },
    );
    expect(missingLiveProfile.status).toBe(404);
    const missingLiveBody =
      (await missingLiveProfile.json()) as Envelope<unknown>;
    expect(missingLiveBody.error?.code).toBe("workflow_live_version_not_found");

    const manifest = {
      $schemaVersion: 2,
      agents: [
        testAgent({
          id: "enterprise-intake",
          trigger: "ENTERPRISE_TEST_START",
          emitted: "ENTERPRISE_TEST_NEXT",
          outputBinding: true,
        }),
        testAgent({
          id: "enterprise-finish",
          trigger: "ENTERPRISE_TEST_NEXT",
          emitted: "ENTERPRISE_TEST_DONE",
        }),
      ],
    };
    const response = await env.fetch(
      `/v1/workflows/${workflowSlug}/test-runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantASlug,
        },
        body: JSON.stringify({
          manifest,
          triggerEvent: "ENTERPRISE_TEST_START",
          subject: `SUBJECT-${suffix}`,
          inputs: { prompt: "Run the complete enterprise workflow test." },
          toolPolicy: "safe",
          failurePolicy: "continue",
          limits: { maxAgentRuns: 10, maxEvents: 20, maxDepth: 8 },
        }),
      },
    );
    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as Envelope<unknown>;
    const result = WorkflowTestRunResponseSchema.parse(responseBody.data);
    expect(result.status).toBe("ok");
    expect(result.summary).toMatchObject({
      agentRuns: 2,
      passed: 2,
      failed: 0,
      blocked: 0,
      steps: 2,
    });
    expect(result.agentRuns.map((run) => run.agentId)).toEqual([
      "enterprise-intake",
      "enterprise-finish",
    ]);
    expect(result.agentRuns.every((run) => run.outputValid)).toBe(true);
    expect(result.events.map((event) => event.name)).toEqual([
      "ENTERPRISE_TEST_START",
      "ENTERPRISE_TEST_NEXT",
      "ENTERPRISE_TEST_DONE",
    ]);
    expect(result.terminalOutputs).toHaveLength(1);
  });

  it("enforces draft-test safety confirmation and execution budgets", async () => {
    const unsafeAgent = testAgent({
      id: "enterprise-writer",
      trigger: "ENTERPRISE_WRITE_REQUESTED",
      emitted: "ENTERPRISE_WRITE_COMPLETED",
    });
    unsafeAgent.tool_use = [{ name: "fs.writeMarkdownToArchive" }];
    unsafeAgent.actions = [
      {
        order: "1",
        name: "write-enterprise-report",
        description: "Persist the report",
        type: "tool",
        tool: "fs.writeMarkdownToArchive",
      },
    ];
    const unsafeManifest = {
      $schemaVersion: 2,
      agents: [unsafeAgent],
    };

    const unconfirmedLiveEffects = await env.fetch(
      `/v1/workflows/${workflowSlug}/test-runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantASlug,
        },
        body: JSON.stringify({
          manifest: unsafeManifest,
          triggerEvent: "ENTERPRISE_WRITE_REQUESTED",
          inputs: { prompt: "Write the enterprise report." },
          toolPolicy: "live",
          confirmLiveEffects: false,
          limits: { maxAgentRuns: 5, maxEvents: 5, maxDepth: 3 },
        }),
      },
    );
    expect(unconfirmedLiveEffects.status).toBe(400);

    const safeRun = await env.fetch(`/v1/workflows/${workflowSlug}/test-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        manifest: unsafeManifest,
        triggerEvent: "ENTERPRISE_WRITE_REQUESTED",
        inputs: { prompt: "Write the enterprise report." },
        toolPolicy: "safe",
        failurePolicy: "fail_fast",
        limits: { maxAgentRuns: 5, maxEvents: 5, maxDepth: 3 },
      }),
    });
    expect(safeRun.status).toBe(200);
    const safeBody = (await safeRun.json()) as Envelope<unknown>;
    const safeResult = WorkflowTestRunResponseSchema.parse(safeBody.data);
    expect(safeResult.status).toBe("failed");
    expect(safeResult.summary).toMatchObject({
      agentRuns: 1,
      passed: 0,
      failed: 0,
      blocked: 1,
    });
    expect(safeResult.agentRuns[0]?.steps[0]).toMatchObject({
      status: "blocked",
      error: { code: "unsafe_tool_blocked" },
    });
    expect(safeResult.warnings).toContain(
      "Fail-fast policy stopped the workflow after 'enterprise-writer' blocked.",
    );

    const boundedManifest = {
      $schemaVersion: 2,
      agents: [
        testAgent({
          id: "budget-intake",
          trigger: "BUDGET_TEST_START",
          emitted: "BUDGET_TEST_NEXT",
          outputBinding: true,
        }),
        testAgent({
          id: "budget-finish",
          trigger: "BUDGET_TEST_NEXT",
          emitted: "BUDGET_TEST_DONE",
        }),
      ],
    };
    const boundedRun = await env.fetch(
      `/v1/workflows/${workflowSlug}/test-runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantASlug,
        },
        body: JSON.stringify({
          manifest: boundedManifest,
          triggerEvent: "BUDGET_TEST_START",
          inputs: { prompt: "Prove the event budget stops fan-out." },
          toolPolicy: "safe",
          failurePolicy: "continue",
          limits: { maxAgentRuns: 5, maxEvents: 1, maxDepth: 3 },
        }),
      },
    );
    expect(boundedRun.status).toBe(200);
    const boundedBody = (await boundedRun.json()) as Envelope<unknown>;
    const boundedResult = WorkflowTestRunResponseSchema.parse(boundedBody.data);
    expect(boundedResult.status).toBe("partial");
    expect(boundedResult.summary).toMatchObject({
      agentRuns: 1,
      passed: 1,
      events: 1,
    });
    expect(boundedResult.warnings).toContain(
      "Event budget 1 reached; 'BUDGET_TEST_NEXT' was recorded on the agent result but not dispatched.",
    );
  });

  it("generates a reviewable workflow-agent prompt proposal", async () => {
    const definition = testAgent({
      id: "prompt-author",
      trigger: "PROMPT_REQUESTED",
      emitted: "PROMPT_READY",
    });
    const response = await env.fetch(
      `/v1/workflows/${workflowSlug}/agents/prompt-author/generate-instructions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantASlug,
        },
        body: JSON.stringify({
          definition,
          mode: "improve",
          instructions: "Keep tenant data private and return valid output.",
          provider: "mock",
          model: "mock-model-v1",
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const generated = WorkflowAgentPromptResponseSchema.parse(body.data);
    expect(generated.proposedInstructions).toContain("# Role");
    expect(generated.proposedInstructions).toContain("# Output contract");
    expect(generated.provenance).toMatchObject({
      mode: "ai-assisted",
      provider: "mock",
      model: "mock-model-v1",
    });
    expect(generated.provenance.source_hash).toMatch(/^sha256:/);

    const mismatch = await env.fetch(
      `/v1/workflows/${workflowSlug}/agents/different-agent/generate-instructions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantASlug,
        },
        body: JSON.stringify({
          definition,
          mode: "generate",
          provider: "mock",
          model: "mock-model-v1",
        }),
      },
    );
    expect(mismatch.status).toBe(400);
    const mismatchBody = (await mismatch.json()) as Envelope<unknown>;
    expect(mismatchBody.error?.code).toBe("agent_identity_mismatch");
  });

  it("generates a deterministic mock preview without persisting it", async () => {
    const before = await env.fetch("/v1/workflows", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    const beforeBody = (await before.json()) as Envelope<unknown>;
    const beforeList = WorkflowListResponseSchema.parse(beforeBody.data);

    const response = await env.fetch("/v1/workflows/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        purpose:
          "Classify customer requests, prepare a safe resolution, and escalate uncertain outcomes for review.",
        provider: "mock",
        model: "mock-model-v1",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const generated = GenerateWorkflowResponseSchema.parse(body.data);
    expect(generated.validation.valid).toBe(true);
    expect(generated.manifest.agents.length).toBeGreaterThanOrEqual(2);

    const after = await env.fetch("/v1/workflows", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    const afterBody = (await after.json()) as Envelope<unknown>;
    const afterList = WorkflowListResponseSchema.parse(afterBody.data);
    expect(afterList.workflows).toHaveLength(beforeList.workflows.length);
  });

  it("maps malformed manifests to 400 and still tenant-scopes inline validation", async () => {
    const invalidCreate = await env.fetch("/v1/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        slug: `invalid-${suffix}`,
        name: "Invalid workflow",
        source: { type: "manifest", manifest: { notAgents: [] } },
      }),
    });
    expect(invalidCreate.status).toBe(400);
    const invalidBody = (await invalidCreate.json()) as Envelope<unknown>;
    expect(invalidBody.error?.code).toBe("invalid_workflow_manifest");

    const scopedValidate = await env.fetch(
      `/v1/workflows/${workflowSlug}/validate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantBSlug,
        },
        body: JSON.stringify({ manifest: workflow.manifest }),
      },
    );
    expect(scopedValidate.status).toBe(404);
  });

  it("deletes a non-live draft", async () => {
    const response = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "DELETE",
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(response.status).toBe(200);
    const missing = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(missing.status).toBe(404);
  });
});
