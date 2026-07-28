import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeProjects,
  ontocodeSessionMessages,
  tenants,
} from "@agentic/db";
import {
  acceptOntoCodeAssistantRun,
  completeOntoCodeAssistantRun,
  completeOntoCodeAssistantStep,
  failOntoCodeAssistantRun,
  getOntoCodeAssistantRun,
  persistOntoCodeCompiledContext,
  startOntoCodeAssistantStep,
} from "../src/services/ontocode-assistant-run-store";
import {
  compileOntoCodeContext,
  OntoCodeContextCompilerError,
} from "../src/services/ontocode-context-compiler";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  createOntoCodeArtifact,
  createOntoCodeProject,
  createOntoCodeSession,
  createOntoCodeTurn,
  getOntoCodeProject,
  getOntoCodeSession,
  listLatestOntoCodeMessages,
} from "../src/services/ontocode-session-store";
import { buildTestEnv } from "./harness";
import { installOntoCodeTestOntology } from "./ontocode-ontology-fixture";

describe("OntoCode durable Assistant Run and exact context", () => {
  let tenantId: string;
  let projectId: string;
  let sessionId: string;
  let secondSessionId: string;
  let ontologyHash: string;
  let originalBinding: FactoryDomainBinding | null;
  let removeOntology: () => Promise<void>;
  const suffix = randomUUID().slice(0, 8);
  const domain = `ontocode-assistant-${suffix}`;
  const ctx = {
    tenantId: "",
    actorId: "usr-ontocode-assistant-test",
  };

  beforeAll(async () => {
    await buildTestEnv();
    const tenant = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get();
    if (!tenant) throw new Error("__system test tenant is missing");
    tenantId = tenant.id;
    ctx.tenantId = tenantId;
    originalBinding = getFactoryDomainBinding(tenantId);
    const installed = await installOntoCodeTestOntology({
      tenantSlug: "__system",
      domainId: domain,
      name: "OntoCode durable Assistant test",
    });
    ontologyHash = installed.ontologyHash;
    removeOntology = installed.remove;
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "OntoCode durable Assistant test" },
      "upload",
    );
    const project = createOntoCodeProject(ctx, {
      domain,
      name: `Assistant project ${suffix}`,
    });
    projectId = project.project.id;
    sessionId = (
      await createOntoCodeSession(ctx, {
        projectId,
        title: "Durable assistant session",
        goal: "Verify durable acceptance and exact Artifact context.",
        autonomyMode: "copilot",
        ontologySnapshotHash: ontologyHash,
      })
    ).session.id;
    secondSessionId = (
      await createOntoCodeSession(ctx, {
        projectId,
        title: "Separate session",
        goal: "Prove exact context cannot cross Session boundaries.",
        autonomyMode: "guide",
        ontologySnapshotHash: ontologyHash,
      })
    ).session.id;
  });

  afterAll(async () => {
    if (projectId) {
      getDb()
        .delete(ontocodeProjects)
        .where(eq(ontocodeProjects.id, projectId))
        .run();
    }
    await removeOntology?.();
    if (originalBinding) {
      setFactoryDomainBinding(
        tenantId,
        {
          id: originalBinding.ontologyDomainId,
          name:
            originalBinding.ontologyDomainName ??
            originalBinding.ontologyDomainId,
        },
        originalBinding.source,
      );
    } else {
      clearFactoryDomainBinding(tenantId);
    }
  });

  it("resolves only exact, tenant- and Session-scoped Artifact versions", () => {
    const session = getOntoCodeSession(ctx, sessionId);
    const created = createOntoCodeArtifact(ctx, sessionId, {
      expectedSessionRevision: session.revision,
      logicalName: "agents/screen-candidate/agent.ts",
      kind: "agent_code",
      semanticPath: "/agents/screenCandidate/generatedCode",
      content:
        "export async function screenCandidate(input: unknown) { return input; }\n",
      contentType: "text/typescript",
      metadata: { executionOwner: "codeact" },
      idempotencyKey: `assistant-artifact-${suffix}`,
    });
    const current = getOntoCodeSession(ctx, sessionId);
    const project = getOntoCodeProject(ctx, projectId);
    const compiled = compileOntoCodeContext({
      ctx,
      project,
      session: current,
      requestedRefs: [
        `ontology:${ontologyHash}`,
        `artifact:${created.artifact.id}@${created.version.id}`,
      ],
    });

    expect(compiled.refs).toEqual([
      expect.objectContaining({
        kind: "ontology",
        canonicalRef: `ontology:${ontologyHash}`,
        contentHash: ontologyHash,
      }),
      expect.objectContaining({
        kind: "artifact",
        canonicalRef: `artifact:${created.artifact.id}@${created.version.id}`,
        contentHash: created.version.blobHash,
        content:
          "export async function screenCandidate(input: unknown) { return input; }\n",
      }),
    ]);
    expect(compiled.contextHash).toMatch(/^[a-f0-9]{64}$/);

    // #ONTOLOGY-FACTS —— 没拿到摘要时，上下文必须【明说】没拿到，而不是安静地只给身份信息：
    // 助手手上一条领域事实都没有却看起来在引用本体，是最容易骗到人的一种状态。
    const ontologyRef = compiled.refs.find((r) => r.kind === "ontology")!;
    expect(ontologyRef.content).toContain("digestUnavailable");
    expect(ontologyRef.content).not.toContain("digest\":");

    // 拿到摘要时，真实领域事实进入上下文，问「这个域有哪些动作」不必再跑一个完整作业。
    const withDigest = compileOntoCodeContext({
      ctx,
      project,
      session: current,
      requestedRefs: [`ontology:${ontologyHash}`],
      ontologyDigest: "域 X（来源 allmeta）\n规则：66 条 · 阻断 49",
    });
    const withFacts = withDigest.refs.find((r) => r.kind === "ontology")!;
    expect(withFacts.content).toContain("阻断 49");
    expect(withFacts.content).not.toContain("digestUnavailable");
    // 内容不同 → 上下文哈希必须不同，否则两次不同的输入会被当成同一次。
    expect(withDigest.contextHash).not.toBe(compiled.contextHash);

    expect(() =>
      compileOntoCodeContext({
        ctx,
        project,
        session: getOntoCodeSession(ctx, secondSessionId),
        requestedRefs: [`artifact:${created.version.id}`],
      }),
    ).toThrowError(OntoCodeContextCompilerError);
    expect(() =>
      compileOntoCodeContext({
        ctx,
        project,
        session: current,
        requestedRefs: ["agents/screen-candidate/agent.ts"],
      }),
    ).toThrow("Context refs must be exact");
  });

  it("accepts the user turn before planning and resumes the same atomic turn", () => {
    const idempotencyKey = `assistant-run-success-${suffix}`;
    const text = "Explain the exact selected Artifact without changing it.";
    const current = getOntoCodeSession(ctx, sessionId);
    const project = getOntoCodeProject(ctx, projectId);
    const acceptance = acceptOntoCodeAssistantRun(ctx, sessionId, {
      text,
      contextRefs: [`ontology:${ontologyHash}`],
      idempotencyKey,
    });
    expect(acceptance).toMatchObject({
      mode: "created",
      run: { status: "accepted", sourceMessageId: acceptance.sourceMessage.id },
      sourceMessage: { role: "user" },
    });

    const contextStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
      ordinal: 1,
      kind: "context_compile",
      input: { refs: [`ontology:${ontologyHash}`] },
    });
    const compiled = compileOntoCodeContext({
      ctx,
      project,
      session: getOntoCodeSession(ctx, sessionId),
      requestedRefs: [`ontology:${ontologyHash}`],
    });
    persistOntoCodeCompiledContext(ctx, acceptance.run.id, compiled);
    completeOntoCodeAssistantStep(ctx, contextStep.id, {
      contextHash: compiled.contextHash,
      manifest: compiled.manifest,
    });
    const modelStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
      ordinal: 2,
      kind: "model_plan",
      input: { contextHash: compiled.contextHash },
    });
    completeOntoCodeAssistantStep(ctx, modelStep.id, {
      behavior: "explain",
      model: "test-contract-model",
    });
    const policyStep = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
      ordinal: 3,
      kind: "policy_commit",
      input: { behavior: "explain" },
    });
    const receipt = createOntoCodeTurn(ctx, sessionId, {
      text,
      behavior: "explain",
      arguments: {},
      affectedSemanticPaths: [],
      requestedCapabilities: [],
      idempotencyKey,
      assistantText: `The authoritative snapshot is ontology:${ontologyHash}.`,
      persistedRequestContent: {
        text,
        turn: {
          behavior: "assistant",
          contextRefs: [`ontology:${ontologyHash}`],
        },
      },
    });
    completeOntoCodeAssistantStep(ctx, policyStep.id, {
      directiveId: receipt.directive.id,
      behavior: receipt.directive.behavior,
    });
    completeOntoCodeAssistantRun(ctx, acceptance.run.id, {
      model: "test-contract-model",
      terminalResponse: receipt,
    });

    const stored = getOntoCodeAssistantRun(ctx, acceptance.run.id);
    expect(stored.run).toMatchObject({
      status: "succeeded",
      contextHash: compiled.contextHash,
      terminalResponse: {
        directive: { id: receipt.directive.id, behavior: "explain" },
      },
    });
    expect(stored.steps.map((step) => [step.ordinal, step.status])).toEqual([
      [1, "succeeded"],
      [2, "succeeded"],
      [3, "succeeded"],
    ]);
    expect(stored.contextRefs).toEqual([
      expect.objectContaining({
        kind: "ontology",
        canonicalRef: `ontology:${ontologyHash}`,
        contentHash: ontologyHash,
      }),
    ]);

    const attached = acceptOntoCodeAssistantRun(ctx, sessionId, {
      text,
      contextRefs: [`ontology:${ontologyHash}`],
      idempotencyKey,
    });
    expect(attached).toMatchObject({
      mode: "attached",
      run: { id: acceptance.run.id, status: "succeeded" },
      sourceMessage: { id: acceptance.sourceMessage.id },
    });
    const sourceRows = getDb()
      .select()
      .from(ontocodeSessionMessages)
      .where(eq(ontocodeSessionMessages.id, acceptance.sourceMessage.id))
      .all();
    expect(sourceRows).toHaveLength(1);
    expect(getOntoCodeSession(ctx, sessionId).revision).toBeGreaterThan(
      current.revision,
    );
  });

  it("keeps the accepted message and a durable failed Run when planning fails", () => {
    const idempotencyKey = `assistant-run-failure-${suffix}`;
    const acceptance = acceptOntoCodeAssistantRun(ctx, sessionId, {
      text: "Review a provider response.",
      contextRefs: [],
      idempotencyKey,
    });
    const step = startOntoCodeAssistantStep(ctx, acceptance.run.id, {
      ordinal: 1,
      kind: "model_plan",
      input: { provider: "tenant-gateway" },
    });
    failOntoCodeAssistantRun(
      ctx,
      acceptance.run.id,
      Object.assign(new Error("The configured provider is unavailable"), {
        code: "ontocode_assistant_planner_unavailable",
      }),
      step.id,
    );

    const stored = getOntoCodeAssistantRun(ctx, acceptance.run.id);
    expect(stored.run).toMatchObject({
      status: "failed",
      errorCode: "ontocode_assistant_planner_unavailable",
      errorMessage: "The configured provider is unavailable",
    });
    expect(stored.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "ontocode_assistant_planner_unavailable",
    });
    expect(
      listLatestOntoCodeMessages(ctx, sessionId, 20).some(
        (message) =>
          message.id === acceptance.sourceMessage.id && message.role === "user",
      ),
    ).toBe(true);
    expect(
      listLatestOntoCodeMessages(ctx, sessionId, 20).some(
        (message) =>
          message.role === "assistant" &&
          message.type === "error" &&
          message.content.assistantRunId === acceptance.run.id,
      ),
    ).toBe(true);
  });
});
