import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
  canonicalEvidenceJson,
  SANDBOX_CLEANUP_RECEIPT_SCHEMA,
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxCleanupReceiptHash,
  sandboxDesignReviewSubjectDigest,
  sandboxRunDrainReceiptHash,
  type AgentDraftRegressionEvidence,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
} from "@agentic/agent-factory";
import { FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import { FsFactoryFixtureAssetStore } from "../src/services/agent-factory/fixture-asset-store";
import {
  assertRegressionArtifactCassetteEvidence,
  regressionSuiteFingerprint,
  replayRegressionArtifact,
  type PersistedRegressionArtifact,
} from "../src/services/agent-factory/regression-artifact";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";
import { eq } from "drizzle-orm";
import {
  factoryAuthorizationChallenges,
  getDb,
  tenants,
} from "@agentic/db";
import { makePromotableSandboxExecutionEvidence } from "./factory-sandbox-execution-fixture";
import { makePromotableSandboxRegistrationEvidence } from "./factory-sandbox-registration-fixture";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";
import {
  attestLiveProbeCassette,
  cassetteConfigHash,
  createAuthorizedSignedFixtureCassette,
  signedFixtureAuthorizationSubject,
} from "../src/services/agent-factory/cassette-evidence-attestation";
import { sandboxToolBindingId } from "../src/services/agent-factory/sandbox-bundle-builder";
import { DrizzleFactoryAuthorizationChallengeStore } from "../src/services/agent-factory/authorization-challenge-store";

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "processResume",
    actionName: "processResume",
    slug: "resume-agent",
    short: "ResumeAgent",
    domainId: "regression-domain",
    nameZh: "简历处理",
    kind: "llm",
    trigger: ["RESUME_DOWNLOADED"],
    emit: ["RESUME_PROCESSED", "RESUME_FAILED"],
    tools: ["parseResumeApi"],
    toolPolicies: {
      parseResumeApi: {
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
      },
    },
    toolSideEffects: { parseResumeApi: "read" },
    sandboxToolConfigs: { parseResumeApi: {} },
    unresolvedTools: [],
    objects: ["Candidate"],
    systemPrompt: "解析简历并发出结果事件。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    ...over,
  } as GeneratedAgentSpec;
}

function codeActSpec(event = "RESUME_PROCESSED"): GeneratedAgentSpec {
  return spec({
    codeSource: "ai",
    codeExecuted: true,
    generatedCode: `
      import { defineAgent } from "@agentic/runtime";
      export const resumeAgent = defineAgent({
        name: "resume-agent",
        async handler(input, ctx) {
          const parsed = await ctx.tool("parseResumeApi", input);
          await ctx.emit(${JSON.stringify(event)}, { ...input, parsed });
          return { ok: true };
        },
      });
    `,
  });
}

function binaryFixtureCodeActSpec(echoFixtureInError = false): GeneratedAgentSpec {
  return spec({
    tools: [],
    codeSource: "ai",
    codeExecuted: true,
    generatedCode: `
      import { defineAgent } from "@agentic/runtime";
      export const resumeAgent = defineAgent({
        name: "resume-agent",
        async handler(input, ctx) {
          if (typeof input.resume_file !== "string") throw new Error("resume fixture was not materialized");
          ${echoFixtureInError ? "throw new Error(`unsafe-worker-error:${input.resume_file}`);" : ""}
          await ctx.emit("RESUME_PROCESSED", input);
          return { ok: true };
        },
      });
    `,
  });
}

let root: string;
let previousRoot: string | undefined;
let previousGeneratedExecution: string | undefined;

function isolatedReplayOptions() {
  const { candidateImage, containerTransport } = codeActContainerTestOptions();
  return {
    codeActCandidateImage: candidateImage,
    codeActContainerTransport: containerTransport,
  };
}

function cleanupReceipt(candidateFingerprint: string): SandboxCleanupReceipt {
  const body: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
    schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
    appId: "factory-test-af-sbx-regression",
    sandboxTenantSlug: "af-sbx-11111111-22222222-333333333333-sb",
    sandboxAttemptId: "33333333-3333-4333-8333-333333333333",
    candidateFingerprint,
    targetDomainId: "regression-domain",
    runDrain: (() => {
      const drainBody = {
        schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
        sandboxAttemptId: "33333333-3333-4333-8333-333333333333",
        appId: "factory-test-af-sbx-regression",
        sandboxTenantSlug: "af-sbx-11111111-22222222-333333333333-sb",
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        observedRuns: [],
      };
      return { ...drainBody, evidenceHash: sandboxRunDrainReceiptHash(drainBody) };
    })(),
    deletedAt: new Date(0).toISOString(),
    absence: { connected: false, functionCount: null, registryState: "not_registered" },
  };
  return { ...body, absenceProbeHash: sandboxCleanupReceiptHash(body) };
}

function sandboxDesignReview(
  fingerprint: string,
): NonNullable<AgentDraftRegressionEvidence["sandboxDesignReview"]> {
  const subjectDigest = sandboxDesignReviewSubjectDigest({
    domain: "regression-domain",
    fingerprint,
  });
  return {
    fingerprint,
    subjectDigest,
    receipt: {
      challengeId: "fac-regression-review",
      kind: "sandbox_design_review",
      protocolVersion: 1,
      digest: "f".repeat(64),
      subjectDigest,
      authorizationDigest: "a".repeat(64),
      actor: "usr-regression-reviewer",
      runId: "factory-regression-run",
      conversationId: "factory-regression-run",
      // Deliberately expired today: the challenge was valid when atomically
      // consumed, and immutable replay must not demand a second approval.
      consumedAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:15:00.000Z",
    },
  };
}

beforeEach(async () => {
  previousRoot = process.env.AGENTIC_DATA_ROOT;
  previousGeneratedExecution = process.env.FACTORY_EXEC_GENERATED;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-regression-"));
  process.env.AGENTIC_DATA_ROOT = root;
  process.env.FACTORY_EXEC_GENERATED = "1";
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = previousRoot;
  if (previousGeneratedExecution === undefined) delete process.env.FACTORY_EXEC_GENERATED;
  else process.env.FACTORY_EXEC_GENERATED = previousGeneratedExecution;
  await fs.rm(root, { recursive: true, force: true });
});

async function evidence(): Promise<AgentDraftRegressionEvidence> {
  const cassette = path.join(root, "cassettes", "parseResumeApi.json");
  await fs.mkdir(path.dirname(cassette), { recursive: true });
  const definitionHash = "d".repeat(64);
  const entries = [
    makeToolCassetteEntry({
      toolName: "parseResumeApi",
      args: { upload_id: "real-upload-1", results: {} },
      status: 200,
      body: { name: "张三" },
      recordedAt: new Date(0).toISOString(),
    }),
    makeToolCassetteEntry({
      toolName: "parseResumeApi",
      args: { upload_id: "real-upload-1" },
      status: 200,
      body: { name: "张三" },
      recordedAt: new Date(0).toISOString(),
    }),
  ];
  const cassetteDocument = attestLiveProbeCassette({
    version: 1,
    tool: { name: "parseResumeApi", definitionHash, schemaHash: "schema-1" },
    evidence: { recordedAt: new Date().toISOString(), mode: "live-probe" },
    entries,
  }, {
    tenantId: "ten-regression",
    tenantSlug: "regression-tenant",
    domainId: "regression-domain",
    toolName: "parseResumeApi",
    definitionHash,
    config: {},
    actor: "usr-regression-prober",
  });
  const cassetteRaw = canonicalEvidenceJson(cassetteDocument);
  await fs.writeFile(cassette, cassetteRaw, "utf8");
  const contentHash = createHash("sha256")
    .update(canonicalEvidenceJson(JSON.parse(cassetteRaw)))
    .digest("hex");
  const cleanup = cleanupReceipt("sandbox-evidence:v2:approved-identity");
  return {
    evidenceFingerprint: "sandbox-evidence:v2:approved-identity",
    authoritativeOntology: {
      schema: "agent-factory-authoritative-ontology/v1",
      tenantId: "ten-regression",
      tenantSlug: "regression-tenant",
      domainId: "regression-domain",
      source: "allmeta",
      contentHash: `ontology:v2:${"0".repeat(64)}`,
    },
    cleanupReceipt: cleanup,
    ...makePromotableSandboxRegistrationEvidence(cleanup.appId, ["resume-agent"]),
    ...makePromotableSandboxExecutionEvidence({
      candidateFingerprint: "sandbox-evidence:v2:approved-identity",
      targetDomainId: "regression-domain",
      sandboxAttemptId: cleanup.sandboxAttemptId,
      agentRefs: ["resume-agent"],
    }),
    approvedTestCases: [{
      id: "tc-pass",
      name: "解析成功",
      scenario: "上传有效简历",
      kind: "pass",
      entryEvent: "RESUME_DOWNLOADED",
      payload: { upload_id: "demo" },
      expectedOutcome: "发出 RESUME_PROCESSED",
      expectedEvent: "RESUME_PROCESSED",
      functionAssertions: {
        emits: [{ event: "RESUME_PROCESSED", count: 1, payload: { requiredPaths: ["upload_id"] } }],
        toolCalls: [{ tool: "parseResumeApi", count: 1, args: { partial: { upload_id: "real-upload-1" } } }],
        result: { partial: { ok: true } },
      },
    }],
    testDataOverrides: { upload_id: "real-upload-1" },
    functionTester: [{ short: "ResumeAgent", pass: true, ran: true, emitNames: ["RESUME_PROCESSED"], reasons: [], tier: "worker", fixtureMode: "scripted", qualification: "promotable" }],
    toolMode: "evidence_replay",
    externalLiveCalls: 0,
    sandboxReplayEvidenceComplete: true,
    sandboxDesignReview: sandboxDesignReview("sandbox-evidence:v2:approved-identity"),
    replayReceipts: [{
      schema: "agent-factory-sandbox-dispatch/v1",
      attemptId: cleanup.sandboxAttemptId,
      tenantSlug: cleanup.sandboxTenantSlug,
      tool: "parseResumeApi",
      kind: "replay",
      effectScope: "external",
      argsHash: entries[0]!.request.kind === "tool" ? entries[0]!.request.argsHash : "",
      cassetteKey: entries[0]!.key,
      definitionHash,
      contentHash,
      responseStatus: 200,
      at: new Date(0).toISOString(),
    }],
    cassetteRefs: [{
      bindingId: sandboxToolBindingId({
        specSlugs: ["resume-agent"],
        toolName: "parseResumeApi",
        configHash: cassetteConfigHash({}),
        definitionHash,
      }),
      specSlugs: ["resume-agent"],
      tool: "parseResumeApi",
      path: cassette,
      definitionHash,
      schemaHash: "schema-1",
      evidenceMode: "live-probe",
      configHash: cassetteConfigHash({}),
      attestationKeyId: cassetteDocument.evidence!.attestation!.keyId,
      attestationExpiresAt: cassetteDocument.evidence!.attestation!.expiresAt,
    }],
  };
}

describe("versioned Agent Factory regression artifacts", () => {
  it("refuses to persist promotion evidence unless the full Inngest ledger proves zero external live calls", async () => {
    const store = new FsAgentDraftStore();
    const ev = await evidence();
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      externalLiveCalls: 1,
    })).rejects.toThrow(/externalLiveCalls must be exactly 0/);
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      externalLiveCalls: null,
      sandboxReplayEvidenceComplete: false,
    })).rejects.toThrow(/externalLiveCalls must be exactly 0|ledger is missing or incomplete/);
  });

  it("binds the sandbox dispatch receipt to the exact cassette bytes, not only tool and definition", async () => {
    const store = new FsAgentDraftStore();
    const ev = await evidence();
    ev.replayReceipts![0] = {
      ...ev.replayReceipts![0]!,
      contentHash: "e".repeat(64),
    };
    await expect(store.save("regression-domain", [spec()], ev))
      .rejects.toThrow(/exact immutable cassette content/);
  });

  it("requires an authenticated sandbox-design review bound to this exact candidate and subject", async () => {
    const store = new FsAgentDraftStore();
    const ev = await evidence();
    const { sandboxDesignReview: _missing, ...withoutReview } = ev;
    // 文案被有意泛化过：这道门现在由【人工 sandboxDesignReview 或 autopilot
    // 评审】任一满足，所以措辞不再专指人工回执。源码不回退，测试跟上。
    await expect(store.save("regression-domain", [spec()], withoutReview))
      .rejects.toThrow(/sandbox review evidence is missing/);
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      sandboxDesignReview: { ...ev.sandboxDesignReview!, fingerprint: "sandbox-evidence:v2:other" },
    })).rejects.toThrow(/fingerprint does not match/);
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      sandboxDesignReview: {
        ...ev.sandboxDesignReview!,
        subjectDigest: "b".repeat(64),
        receipt: { ...ev.sandboxDesignReview!.receipt, subjectDigest: "b".repeat(64) },
      },
    })).rejects.toThrow(/not bound to the candidate domain\/fingerprint\/build/);
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      sandboxDesignReview: {
        ...ev.sandboxDesignReview!,
        receipt: { ...ev.sandboxDesignReview!.receipt, subjectDigest: "b".repeat(64) },
      },
    })).rejects.toThrow(/not bound to the persisted subject digest/);
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      sandboxDesignReview: {
        ...ev.sandboxDesignReview!,
        receipt: { ...ev.sandboxDesignReview!.receipt, kind: "probe", actor: "" },
      },
    })).rejects.toThrow(/wrong kind|no authenticated actor/);
  });

  it("keeps every delivery version and persists approved cases, fingerprints, modules and cassette refs", async () => {
    const store = new FsAgentDraftStore();
    const ev = await evidence();
    await store.save("regression-domain", [spec({ systemPrompt: "version one" })], ev);
    await store.save("regression-domain", [spec({ systemPrompt: "version two" })], {
      ...ev,
      evidenceFingerprint: "sandbox-evidence:v2:approved-identity-2",
      authoritativeOntology: {
        schema: "agent-factory-authoritative-ontology/v1",
        tenantId: "ten-regression",
        tenantSlug: "regression-tenant",
        domainId: "regression-domain",
        source: "allmeta",
        contentHash: `ontology:v2:${"1".repeat(64)}`,
      },
      cleanupReceipt: cleanupReceipt("sandbox-evidence:v2:approved-identity-2"),
      ...makePromotableSandboxExecutionEvidence({
        candidateFingerprint: "sandbox-evidence:v2:approved-identity-2",
        targetDomainId: "regression-domain",
        sandboxAttemptId: cleanupReceipt("sandbox-evidence:v2:approved-identity-2").sandboxAttemptId,
        marker: "e",
        agentRefs: ["resume-agent"],
      }),
      sandboxDesignReview: sandboxDesignReview("sandbox-evidence:v2:approved-identity-2"),
    });

    const versionsRoot = path.join(root, "factory-drafts", "regression-domain", "versions");
    const versions = (await fs.readdir(versionsRoot)).filter((name) => !name.startsWith("."));
    expect(versions).toHaveLength(2);
    const prompts = await Promise.all(versions.map(async (version) => {
      const draft = JSON.parse(await fs.readFile(path.join(versionsRoot, version, "agents", "resume-agent.json"), "utf8"));
      return draft.spec.systemPrompt;
    }));
    expect(prompts.sort()).toEqual(["version one", "version two"]);

    const [latest] = await store.list("regression-domain");
    expect(latest?.spec.systemPrompt).toBe("version two");
    expect(latest?.versionId).toMatch(/^v-/);
    expect(latest?.regression?.evidenceFingerprint).toBe("sandbox-evidence:v2:approved-identity-2");
    expect(latest?.regression?.authoritativeOntology).toMatchObject({
      schema: "agent-factory-authoritative-ontology/v1",
      domainId: "regression-domain",
      contentHash: `ontology:v2:${"1".repeat(64)}`,
    });
    const artifactPath = path.join(root, "factory-drafts", "regression-domain", latest!.regression!.artifact);
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as PersistedRegressionArtifact;
    expect(artifact.approvedTestCases.map((testCase) => testCase.id)).toEqual(["tc-pass"]);
    expect(artifact.authoritativeOntology).toEqual(latest!.regression!.authoritativeOntology);
    expect(artifact.sandboxCleanupReceipt).toMatchObject({
      candidateFingerprint: "sandbox-evidence:v2:approved-identity-2",
      absenceProbeHash: expect.stringMatching(/^sandbox-cleanup:v1:[a-f0-9]{64}$/),
    });
    expect(artifact.effectiveTestCases[0]?.payload.upload_id).toBe("real-upload-1");
    expect(artifact.agents[0]?.moduleFile).toBe("agents/resume-agent.ts");
    expect(artifact.agents[0]?.cases[0]).toMatchObject({
      expectEmits: ["RESUME_PROCESSED"],
      requiredEvidenceTools: ["parseResumeApi"],
      assertions: { exactEmits: true, forbiddenEmits: ["RESUME_FAILED"] },
      fixture: { reasonResult: { emit: "RESUME_PROCESSED", __approvedDecisionFixture: "tc-pass" } },
    });
    expect(artifact.agents[0]?.cases[0]?.fixture.toolResults).toBeUndefined();
    expect(artifact.cassetteRefs).toEqual([expect.objectContaining({ tool: "parseResumeApi", definitionHash: "d".repeat(64), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(artifact).toMatchObject({
      toolMode: "evidence_replay",
      externalLiveCalls: 0,
      sandboxReplayEvidenceComplete: true,
      replayReceipts: [expect.objectContaining({ tool: "parseResumeApi", kind: "replay" })],
      sandboxDesignReview: expect.objectContaining({
        fingerprint: "sandbox-evidence:v2:approved-identity-2",
        receipt: expect.objectContaining({ kind: "sandbox_design_review", actor: "usr-regression-reviewer" }),
      }),
    });
    expect(artifact.sandboxDesignReview).toEqual(
      sandboxDesignReview("sandbox-evidence:v2:approved-identity-2"),
    );
    expect(artifact.replay.command).toContain("replay:factory-regression");
    expect(artifact.suiteFingerprint).toMatch(/^regression-suite:v1:/);
  });

  it("replays the exact persisted module and fails closed after module or cassette drift", async () => {
    const store = new FsAgentDraftStore();
    await store.save("regression-domain", [spec()], await evidence());

    const first = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(first.pass, first.errors.join("; ")).toBe(true);
    expect(first).toMatchObject({
      sandboxExternalLiveCalls: 0,
      sandboxReplayEvidenceComplete: true,
      sandboxReplayReceipts: [expect.objectContaining({ tool: "parseResumeApi", kind: "replay" })],
    });
    expect(first.effectiveEntryEvents).toEqual(["RESUME_DOWNLOADED"]);
    expect(first.results).toEqual([
      expect.objectContaining({
        slug: "resume-agent", caseId: "resume-agent:tc-pass", pass: true, ran: true,
        execution: "rendered-module",
      }),
    ]);

    const [draft] = await store.list("regression-domain");
    const artifact = path.join(root, "factory-drafts", "regression-domain", draft!.regression!.artifact);
    const persisted = JSON.parse(await fs.readFile(artifact, "utf8")) as PersistedRegressionArtifact;
    expect(path.isAbsolute(persisted.cassetteRefs[0]!.path)).toBe(false);
    const persistedCassette = path.resolve(path.dirname(artifact), persisted.cassetteRefs[0]!.path);
    expect(persistedCassette.startsWith(`${path.dirname(artifact)}${path.sep}`)).toBe(true);
    const originalPersistedCassette = await fs.readFile(persistedCassette);
    await fs.appendFile(persistedCassette, "\n", "utf8");
    const cassetteDrift = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(cassetteDrift.pass).toBe(false);
    expect(cassetteDrift.errors.join(" ")).toContain("cassette content drift");

    // Restore the canonical immutable cassette so the next assertion isolates module drift.
    await fs.writeFile(persistedCassette, originalPersistedCassette);
    const modulePath = path.join(path.dirname(artifact), persisted.agents[0]!.moduleFile);
    await fs.appendFile(modulePath, "\n// tampered\n", "utf8");
    const tampered = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(tampered.pass).toBe(false);
    expect(tampered.errors.join(" ")).toContain("module hash mismatch");
  });

  it("materializes a scoped binary binding only in server replay memory and fails closed after asset deletion", async () => {
    const tenantId = "ten-regression";
    const tenantSlug = "tenant-regression";
    const domain = "regression-domain";
    const conversationId = "factory-regression-run";
    const fixtureStore = new FsFactoryFixtureAssetStore({
      root: path.join(root, "fixture-assets"),
      ttlSeconds: 60,
    });
    const content = Buffer.from("private-resume-bytes", "utf8");
    const base64 = content.toString("base64");
    const metadata = await fixtureStore.put({ tenantId, domain, conversationId }, {
      caseId: "tc-pass",
      path: "/resume_file",
      base64,
      mimeType: "application/pdf",
      filename: "candidate.pdf",
    });
    const ev = await evidence();
    ev.approvedTestCases = [{
      ...ev.approvedTestCases[0]!,
      payload: {
        upload_id: "demo",
        resume_file: {
          schema: FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
          conversationId,
          as: "base64_string",
          ...metadata,
        },
      },
      functionAssertions: {
        emits: [{ event: "RESUME_PROCESSED", count: 1, payload: { requiredPaths: ["resume_file"] } }],
        result: { partial: { ok: true } },
      },
    }];
    ev.replayReceipts = [];
    ev.cassetteRefs = [];
    const store = new FsAgentDraftStore({ tenantId, tenantSlug, ontologyDomainId: domain }, fixtureStore);
    await store.save(domain, [binaryFixtureCodeActSpec()], ev);

    const [draft] = await store.list(domain);
    const domainDirectory = `${domain}-${createHash("sha256").update(domain, "utf8").digest("hex").slice(0, 16)}`;
    const artifactPath = path.join(
      root,
      "factory-drafts",
      "_tenants",
      tenantId,
      domainDirectory,
      draft!.regression!.artifact,
    );
    const persistedArtifact = await fs.readFile(artifactPath, "utf8");
    expect(persistedArtifact).not.toContain(base64);
    const replayWithoutTenantAdapter = await replayRegressionArtifact(artifactPath);
    expect(replayWithoutTenantAdapter.pass).toBe(false);
    expect(replayWithoutTenantAdapter.results[0]?.reasons.join(" ")).toContain("tenant-scoped server materializer");

    const replay = await store.replayRegression(
      domain,
      ["resume-agent"],
      undefined,
      isolatedReplayOptions(),
    );
    expect(replay.pass, [...replay.errors, ...replay.results.flatMap((entry) => entry.reasons)].join("; ")).toBe(true);
    expect(JSON.stringify(replay)).not.toContain(base64);

    await store.save(domain, [binaryFixtureCodeActSpec(true)], ev);
    const workerFailure = await store.replayRegression(
      domain,
      ["resume-agent"],
      undefined,
      isolatedReplayOptions(),
    );
    expect(workerFailure.pass).toBe(false);
    expect(workerFailure.results[0]?.reasons).toEqual([
      "binary fixture replay failed inside the isolated container; execution details were withheld",
    ]);
    expect(JSON.stringify(workerFailure)).not.toContain(base64);

    await fixtureStore.delete({ tenantId, domain, conversationId }, metadata.assetId);
    const missing = await store.replayRegression(
      domain,
      ["resume-agent"],
      undefined,
      isolatedReplayOptions(),
    );
    expect(missing.pass).toBe(false);
    expect(missing.results).toEqual([
      expect.objectContaining({
        slug: "resume-agent",
        caseId: "resume-agent:tc-pass",
        pass: false,
        ran: false,
        reasons: [expect.stringMatching(/missing, expired, deleted/)],
      }),
    ]);
    expect(JSON.stringify(missing)).not.toContain(base64);
  });

  it("does not allow an unversioned legacy draft to bypass the promotion regression gate", async () => {
    const dir = path.join(root, "factory-drafts", "regression-domain");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "resume-agent.json"), JSON.stringify({
      domain: "regression-domain",
      slug: "resume-agent",
      spec: spec(),
      createdAt: new Date(0).toISOString(),
    }), "utf8");
    const replay = await new FsAgentDraftStore().replayRegression("regression-domain", ["resume-agent"]);
    expect(replay.pass).toBe(false);
    expect(replay.errors.join(" ")).toContain("no replayable regression artifact");
  });

  it("keeps a legacy immutable suite replayable but never treats missing qualification as promotable", async () => {
    const store = new FsAgentDraftStore();
    await store.save("regression-domain", [spec()], await evidence());
    const [draft] = await store.list("regression-domain");
    const artifactPath = path.join(
      root,
      "factory-drafts",
      "regression-domain",
      draft!.regression!.artifact,
    );
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as PersistedRegressionArtifact;
    delete (artifact as Partial<PersistedRegressionArtifact>).evidenceQualification;
    artifact.suiteFingerprint = regressionSuiteFingerprint(artifact);
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    const replay = await replayRegressionArtifact(artifactPath);
    expect(replay.pass, replay.errors.join("; ")).toBe(true);
    expect(replay.promotionEvidenceReady).toBe(false);
    expect(replay.promotionEvidenceErrors?.join(" ")).toContain(
      "legacy artifacts are replayable but not promotable",
    );
  });

  it("revalidates the persisted sandbox-design receipt even when suite integrity is recomputed", async () => {
    const store = new FsAgentDraftStore();
    await store.save("regression-domain", [spec()], await evidence());
    const [draft] = await store.list("regression-domain");
    const artifactPath = path.join(root, "factory-drafts", "regression-domain", draft!.regression!.artifact);
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as PersistedRegressionArtifact;
    artifact.sandboxDesignReview.receipt.actor = "";
    artifact.suiteFingerprint = regressionSuiteFingerprint(artifact);
    await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    const replay = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(replay.pass).toBe(false);
    expect(replay.errors.join(" ")).toContain("sandbox design review receipt has no authenticated actor");
  });

  it("blocks promotion when a called external tool has no real cassette/probe evidence", async () => {
    const store = new FsAgentDraftStore();
    const ev = await evidence();
    await expect(store.save("regression-domain", [spec()], {
      ...ev,
      replayReceipts: [],
      cassetteRefs: [],
    })).rejects.toThrow(/parseResumeApi.*requires exactly one immutable cassette binding/);
  });

  it("does not confuse a signed-fixture summary with production live evidence", async () => {
    const ev = await evidence();
    ev.cassetteRefs![0] = {
      ...ev.cassetteRefs![0]!,
      evidenceMode: "signed-fixture",
    };
    const store = new FsAgentDraftStore();
    await expect(store.save("regression-domain", [spec()], ev)).resolves.toBe(1);
    const [draft] = await store.list("regression-domain");
    const artifact = JSON.parse(await fs.readFile(
      path.join(root, "factory-drafts", "regression-domain", draft!.regression!.artifact),
      "utf8",
    )) as PersistedRegressionArtifact;
    expect(artifact.evidenceQualification).toMatchObject({
      replay: "sandbox_verified",
      promotion: "candidate",
      blockers: [],
    });
    // This test changed only the untrusted summary, not the HMAC-covered
    // cassette. Replay must still reject it. A genuine signed fixture is
    // created by the one-shot human authorization path exercised separately.
    const replay = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(replay.pass).toBe(false);
    expect(replay.promotionEvidenceReady).toBe(false);
    expect(replay.errors.join(" ")).toContain("cassette attestation summary drift");
  });

  it("replays a genuinely human-authorized signed fixture and leaves production proof to the commit gate", async () => {
    const tenantId = `ten-regression-signed-${randomUUID()}`;
    const tenantSlug = `regression-signed-${randomUUID()}`;
    getDb().insert(tenants).values({
      id: tenantId,
      slug: tenantSlug,
      name: "Regression signed fixture test",
    }).run();
    try {
      const ev = await evidence();
      ev.authoritativeOntology = {
        ...ev.authoritativeOntology!,
        tenantId,
        tenantSlug,
      };
      const originalPath = ev.cassetteRefs![0]!.path;
      const original = JSON.parse(await fs.readFile(originalPath, "utf8")) as {
        entries: ReturnType<typeof makeToolCassetteEntry>[];
      };
      const recordedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const fixtureInput = {
        tenantId,
        tenantSlug,
        domainId: "regression-domain",
        toolName: "parseResumeApi",
        definitionHash: "d".repeat(64),
        schemaHash: "schema-1",
        config: {},
        entries: original.entries,
        recordedAt,
        expiresAt,
      };
      const execution = {
        runId: `run-${randomUUID()}`,
        conversationId: `conversation-${randomUUID()}`,
      };
      const challenges = new DrizzleFactoryAuthorizationChallengeStore(
        tenantId,
        "regression-domain",
      );
      const challenge = await challenges.issue("regression-domain", {
        kind: "probe",
        subjectDigest: signedFixtureAuthorizationSubject(fixtureInput),
        ...execution,
        question: "是否确认这份精确 sandbox fixture？",
        declineLabel: "不创建",
        confirmLabel: "确认仅用于沙箱",
      });
      const authorization = await challenges.consume("regression-domain", {
        challenge,
        answer: challenge.token,
        actor: "usr-regression-fixture-reviewer",
        question: challenge.question,
        context: challenge.context,
        options: challenge.options,
      });
      const document = createAuthorizedSignedFixtureCassette({
        ...fixtureInput,
        authorization,
        execution,
      }, { dataRoot: root });
      const raw = canonicalEvidenceJson(document);
      await fs.writeFile(originalPath, raw, "utf8");
      const contentHash = createHash("sha256").update(raw, "utf8").digest("hex");
      ev.cassetteRefs![0] = {
        ...ev.cassetteRefs![0]!,
        evidenceMode: "signed-fixture",
        attestationKeyId: document.evidence!.attestation!.keyId,
        attestationExpiresAt: document.evidence!.attestation!.expiresAt,
      };
      ev.replayReceipts![0] = {
        ...ev.replayReceipts![0]!,
        contentHash,
      };

      const store = new FsAgentDraftStore({
        tenantId,
        tenantSlug,
        ontologyDomainId: "regression-domain",
      });
      await store.save("regression-domain", [spec()], ev);
      const replay = await store.replayRegression("regression-domain", ["resume-agent"]);
      expect(replay.pass, replay.errors.join("; ")).toBe(true);
      expect(replay).toMatchObject({
        promotionEvidenceReady: true,
        promotionEvidenceErrors: [],
      });
      const [draft] = await store.list("regression-domain");
      const artifactPath = path.join(
        root,
        "factory-drafts",
        "_tenants",
        tenantId,
        `regression-domain-${createHash("sha256").update("regression-domain", "utf8").digest("hex").slice(0, 16)}`,
        draft!.regression!.artifact,
      );
      const artifact = JSON.parse(await fs.readFile(
        artifactPath,
        "utf8",
      )) as PersistedRegressionArtifact;
      expect(artifact.evidenceQualification).toMatchObject({
        promotion: "candidate",
        blockers: [],
      });
      expect(artifact.promotionToolEvidenceRequirements).toEqual([
        expect.objectContaining({
          tool: "parseResumeApi",
          requiresLiveProbe: true,
        }),
      ]);
      await expect(assertRegressionArtifactCassetteEvidence(
        artifactPath,
        { dataRoot: root },
      )).resolves.toBeUndefined();
    } finally {
      getDb().delete(factoryAuthorizationChallenges)
        .where(eq(factoryAuthorizationChallenges.tenantId, tenantId)).run();
      getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    }
  });

  it("does not require a sandbox write fixture to pretend it mutated production", async () => {
    const writeSpec = spec({
      toolPolicies: {
        parseResumeApi: {
          operation: "write",
          effectScope: "external",
          sandboxPolicy: "requires_attempt_grant",
        },
      },
      toolSideEffects: { parseResumeApi: "write" },
    });
    const store = new FsAgentDraftStore();
    await expect(store.save(
      "regression-domain",
      [writeSpec],
      await evidence(),
    )).resolves.toBe(1);
    const [draft] = await store.list("regression-domain");
    const artifact = JSON.parse(await fs.readFile(
      path.join(root, "factory-drafts", "regression-domain", draft!.regression!.artifact),
      "utf8",
    )) as PersistedRegressionArtifact;
    expect(artifact.evidenceQualification).toMatchObject({
      promotion: "candidate",
      blockers: [],
    });
    expect(artifact.promotionToolEvidenceRequirements).toEqual([
      expect.objectContaining({
        tool: "parseResumeApi",
        requiresLiveProbe: true,
        requiresWriteProbe: true,
      }),
    ]);
  });

  it("does not invent a green structural case when no approved case matches the trigger", async () => {
    const store = new FsAgentDraftStore();
    const ev = await evidence();
    await store.save("regression-domain", [spec({ tools: [], emit: ["RESUME_PROCESSED"] })], {
      ...ev,
      approvedTestCases: [],
      replayReceipts: [],
      cassetteRefs: [],
    });
    const replay = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(replay.pass).toBe(false);
    expect(replay.results[0]).toMatchObject({ pass: false, ran: false });
    expect(replay.results[0]?.reasons.join(" ")).toContain("不会自动伪造");
  });

  it("persists and replays the exact content-addressed CodeAct handler through the production container kernel", async () => {
    const store = new FsAgentDraftStore();
    const executable = codeActSpec();
    await store.save("regression-domain", [executable], await evidence());

    const [draft] = await store.list("regression-domain");
    const artifactPath = path.join(root, "factory-drafts", "regression-domain", draft!.regression!.artifact);
    const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8")) as PersistedRegressionArtifact;
    expect(artifact.scope).toBe("content-addressed-execution");
    expect(artifact.agents[0]).toMatchObject({
      execution: "codeact-runtime",
      runtimeCodeFile: "agents/resume-agent.codeact.ts",
      runtimeCodeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const runtimePath = path.join(path.dirname(artifactPath), artifact.agents[0]!.runtimeCodeFile!);
    expect(await fs.readFile(runtimePath, "utf8")).toBe(executable.generatedCode);

    const replay = await store.replayRegression(
      "regression-domain",
      ["resume-agent"],
      undefined,
      isolatedReplayOptions(),
    );
    expect(replay.pass, replay.errors.join("; ")).toBe(true);
    expect(replay).toMatchObject({
      promotionEvidenceReady: true,
      promotionEvidenceErrors: [],
    });
    expect(replay.results[0]).toMatchObject({
      pass: true,
      ran: true,
      execution: "codeact-runtime",
      tier: "codeact-container",
      codeHash: artifact.agents[0]!.runtimeCodeHash,
      emitNames: ["RESUME_PROCESSED"],
    });

    await fs.appendFile(runtimePath, "\n// drift\n", "utf8");
    const drift = await store.replayRegression("regression-domain", ["resume-agent"]);
    expect(drift.pass).toBe(false);
    expect(drift.errors.join(" ")).toContain("runtime code hash mismatch");
  });

  it("does not let a green rendered skeleton substitute for a failing production CodeAct handler", async () => {
    const store = new FsAgentDraftStore();
    // The deterministic rendered module would follow the replay reason fixture
    // and emit RESUME_PROCESSED. The exact production handler intentionally
    // emits the other declared branch, so exact replay must reject it.
    await store.save("regression-domain", [codeActSpec("RESUME_FAILED")], await evidence());
    const replay = await store.replayRegression(
      "regression-domain",
      ["resume-agent"],
      undefined,
      isolatedReplayOptions(),
    );
    expect(replay.pass).toBe(false);
    expect(replay.results[0]).toMatchObject({
      execution: "codeact-runtime",
      ran: true,
      pass: false,
      emitNames: ["RESUME_FAILED"],
    });
    expect(replay.results[0]!.reasons.join(" ")).toContain("expected emit not observed: RESUME_PROCESSED");
  });
});
