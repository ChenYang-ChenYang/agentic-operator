import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeCandidateHeads,
  ontocodeConfigurationTasks,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodePackageVersions,
  ontocodeProjects,
  ontocodeSandboxAttempts,
  tenants,
} from "@agentic/db";
import { OntoCodeSuiteOverviewSchema } from "@agentic/contracts";
import {
  createOntoCodeProject,
  createOntoCodeSession,
  OntoCodeStoreError,
} from "../src/services/ontocode-session-store";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import { getOntoCodeSuiteOverview } from "../src/services/ontocode-suite-overview";
import { buildTestEnv } from "./harness";

const DOMAIN = "ontocode-suite-overview-test";

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

describe("OntoCode suite overview aggregate", () => {
  let tenantId: string;
  let originalBinding: FactoryDomainBinding | null;
  const projectIds: string[] = [];

  beforeAll(async () => {
    await buildTestEnv();
    const tenant = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get();
    if (!tenant) throw new Error("__system test tenant is missing");
    tenantId = tenant.id;
    originalBinding = getFactoryDomainBinding(tenantId);
    setFactoryDomainBinding(
      tenantId,
      { id: DOMAIN, name: "OntoCode suite overview test Ontology" },
      "explicit",
    );
  });

  afterAll(() => {
    for (const projectId of projectIds) {
      getDb()
        .delete(ontocodeProjects)
        .where(eq(ontocodeProjects.id, projectId))
        .run();
    }
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

  function makeSessionFixture() {
    const suffix = randomUUID().slice(0, 8);
    const ctx = { tenantId, actorId: "test-fde" };
    const { project } = createOntoCodeProject(ctx, {
      domain: DOMAIN,
      name: `Suite overview ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Suite overview session ${suffix}`,
      goal: "Aggregate the exact Candidate suite",
      autonomyMode: "copilot",
    });
    return { ctx, project, session, suffix };
  }

  function insertCandidate(fixture: ReturnType<typeof makeSessionFixture>) {
    const { project, session, suffix } = fixture;
    const now = new Date();
    const packageVersionId = `ocpv-suite-${suffix}`;
    const headId = `och-suite-${suffix}`;
    getDb()
      .insert(ontocodePackageVersions)
      .values({
        id: packageVersionId,
        tenantId,
        projectId: project.id,
        sessionId: session.id,
        parentVersionId: null,
        sourceHarnessJobId: null,
        ontologyHash: sha(`ontology-${suffix}`),
        dependencyRoot: sha(`deps-${suffix}`),
        artifactRefsJson: JSON.stringify([
          {
            logicalName: "agents/jd-matcher/spec.json",
            kind: "agent_spec",
            artifactId: `oca-jd-spec-${suffix}`,
            artifactVersionId: `ocav-jd-spec-${suffix}`,
            blobHash: sha(`jd-spec-${suffix}`),
          },
          {
            logicalName: "agents/jd-matcher/agent.ts",
            kind: "agent_code",
            artifactId: `oca-jd-code-${suffix}`,
            artifactVersionId: `ocav-jd-code-${suffix}`,
            blobHash: sha(`jd-code-${suffix}`),
          },
          {
            logicalName: "agents/resume-parser/agent.ts",
            kind: "agent_code",
            artifactId: `oca-rp-code-${suffix}`,
            artifactVersionId: `ocav-rp-code-${suffix}`,
            blobHash: sha(`rp-code-${suffix}`),
          },
          {
            logicalName: "package/manifest.json",
            kind: "agent_manifest",
            artifactId: `oca-manifest-${suffix}`,
            artifactVersionId: `ocav-manifest-${suffix}`,
            blobHash: sha(`manifest-${suffix}`),
          },
        ]),
        executionOwnersJson: JSON.stringify({
          "jd-matcher": "declarative_manifest",
          "resume-parser": "codeact",
        }),
        status: "candidate_ready",
        validationJson: "{}",
        idempotencyKey: `suite-pkg-${suffix}`,
        createdBy: "test-fde",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getDb()
      .insert(ontocodeCandidateHeads)
      .values({
        id: headId,
        tenantId,
        projectId: project.id,
        sessionId: session.id,
        packageVersionId,
        revision: 2,
        updatedBy: "test-fde",
        updatedAt: now,
      })
      .run();
    return { packageVersionId, headId };
  }

  function insertEvidence(
    fixture: ReturnType<typeof makeSessionFixture>,
    packageVersionId: string,
    input: {
      kind: string;
      outcome: "passed" | "failed" | "inconclusive" | "informational";
      state?: "valid" | "stale";
      refs?: string[];
    },
  ) {
    const { project, session, suffix } = fixture;
    const id = `ocev-suite-${suffix}-${randomUUID().slice(0, 8)}`;
    getDb()
      .insert(ontocodeEvidenceRecords)
      .values({
        id,
        tenantId,
        projectId: project.id,
        sessionId: session.id,
        harnessJobId: null,
        changeSetId: null,
        artifactVersionId: null,
        kind: input.kind,
        outcome: input.outcome,
        state: input.state ?? "valid",
        staleReason: input.state === "stale" ? "superseded by a new Candidate" : null,
        invalidatedByPackageVersionId: null,
        invalidatedAt: null,
        subjectType: "candidate_package",
        subjectId: packageVersionId,
        subjectDigest: sha(`deps-${suffix}`),
        dependencySetJson: JSON.stringify({
          candidatePackageVersionId: packageVersionId,
        }),
        validityPredicateJson: JSON.stringify({ jobStatus: "succeeded" }),
        refsJson: JSON.stringify(input.refs ?? []),
        summary: `${input.kind} evidence for the suite overview test`,
        producer: "suite-overview-test",
        idempotencyKey: `suite-ev-${id}`,
        recordedBy: "test-fde",
        createdAt: new Date(),
      })
      .run();
    return id;
  }

  it("aggregates candidate, per-agent artifacts, attributed test counts and readiness", () => {
    const fixture = makeSessionFixture();
    const { packageVersionId, headId } = insertCandidate(fixture);
    // Attributable: refs mention the jd-matcher agent by name.
    insertEvidence(fixture, packageVersionId, {
      kind: "harness_test",
      outcome: "passed",
      refs: ["ontocode-artifact:agents/jd-matcher/agent.ts"],
    });
    // Stale evidence must be excluded even though it mentions the agent.
    insertEvidence(fixture, packageVersionId, {
      kind: "harness_test",
      outcome: "failed",
      state: "stale",
      refs: ["ontocode-artifact:agents/jd-matcher/agent.ts"],
    });
    // Non-test kinds never count toward test totals.
    insertEvidence(fixture, packageVersionId, {
      kind: "harness_build",
      outcome: "passed",
      refs: ["ontocode-artifact:agents/jd-matcher/agent.ts"],
    });

    const overview = getOntoCodeSuiteOverview(fixture.ctx, fixture.session.id);
    expect(OntoCodeSuiteOverviewSchema.parse(overview)).toEqual(overview);
    expect(overview.sessionId).toBe(fixture.session.id);
    expect(overview.candidate).toEqual({
      packageVersionId,
      headId,
      revision: 2,
      status: "candidate_ready",
    });
    expect(overview.agents).toHaveLength(2);

    const jdMatcher = overview.agents.find((a) => a.name === "jd-matcher");
    const resumeParser = overview.agents.find(
      (a) => a.name === "resume-parser",
    );
    if (!jdMatcher || !resumeParser) {
      throw new Error("both executionOwners agents must be present");
    }
    expect(jdMatcher.executionOwner).toBe("declarative_manifest");
    expect(resumeParser.executionOwner).toBe("codeact");
    expect(jdMatcher.artifacts.map((a) => a.logicalName).sort()).toEqual([
      "agents/jd-matcher/agent.ts",
      "agents/jd-matcher/spec.json",
    ]);
    expect(resumeParser.artifacts.map((a) => a.logicalName)).toEqual([
      "agents/resume-parser/agent.ts",
    ]);
    // The package-level manifest ref matches no agent and attaches nowhere.
    for (const agent of overview.agents) {
      expect(agent.artifacts.map((a) => a.logicalName)).not.toContain(
        "package/manifest.json",
      );
    }
    // Only the valid harness_test evidence that mentions the agent is counted.
    expect(jdMatcher.test).toEqual({ passed: 1, failed: 0, inconclusive: 0 });
    // Evidence never mentions resume-parser, so attribution is impossible.
    expect(resumeParser.test).toBeNull();
    expect(jdMatcher.qualification).toBeNull();
    expect(jdMatcher.blocking).toBeNull();
    expect(overview.readiness).toEqual({
      ready: 1,
      pendingConfig: 0,
      verifying: 0,
    });
    expect(
      overview.readiness.ready +
        overview.readiness.pendingConfig +
        overview.readiness.verifying,
    ).toBeGreaterThanOrEqual(1);
    expect(typeof overview.generatedAt).toBe("number");
  });

  it("returns an empty overview when the session has no candidate head", () => {
    const fixture = makeSessionFixture();
    const overview = getOntoCodeSuiteOverview(fixture.ctx, fixture.session.id);
    expect(OntoCodeSuiteOverviewSchema.parse(overview)).toEqual(overview);
    expect(overview.candidate).toBeNull();
    expect(overview.agents).toEqual([]);
    expect(overview.readiness).toEqual({
      ready: 0,
      pendingConfig: 0,
      verifying: 0,
    });
  });

  it("mirrors the session store's tenant-scoped not-found contract for cross-tenant reads", () => {
    const fixture = makeSessionFixture();
    insertCandidate(fixture);
    try {
      getOntoCodeSuiteOverview(
        { tenantId: `ten-cross-${fixture.suffix}` },
        fixture.session.id,
      );
      throw new Error("expected the cross-tenant read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OntoCodeStoreError);
      expect((error as OntoCodeStoreError).code).toBe(
        "ontocode_session_not_found",
      );
      expect((error as OntoCodeStoreError).statusCode).toBe(404);
    }
  });

  it("surfaces open configuration tasks as pendingConfig and per-agent blocking", () => {
    const fixture = makeSessionFixture();
    const { packageVersionId } = insertCandidate(fixture);
    // Unattributable evidence: mentions no agent, so every agent's test is null.
    insertEvidence(fixture, packageVersionId, {
      kind: "harness_test",
      outcome: "passed",
      refs: [],
    });
    const now = new Date();
    getDb()
      .insert(ontocodeConfigurationTasks)
      .values({
        id: `oct-suite-${fixture.suffix}`,
        tenantId,
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        sourceCommandId: null,
        waitingHarnessJobId: null,
        sourceRequirementId: null,
        sourceActionName: "jd-matcher",
        sourceReceiptDigest: null,
        blockerKey: `integration:gohire:${fixture.suffix}`,
        title: "Connect the GoHire integration",
        targetKind: "integration",
        targetJson: JSON.stringify({ provider: "gohire" }),
        requirementJson: JSON.stringify({ credential: "GOHIRE_API_KEY" }),
        verificationPolicyJson: JSON.stringify({ probe: "gohire.health" }),
        resumeAction: null,
        ontologyHash: sha(`ontology-${fixture.suffix}`),
        status: "open",
        revision: 1,
        idempotencyKey: `suite-task-${fixture.suffix}`,
        createdBy: "test-fde",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const overview = getOntoCodeSuiteOverview(fixture.ctx, fixture.session.id);
    const jdMatcher = overview.agents.find((a) => a.name === "jd-matcher");
    const resumeParser = overview.agents.find(
      (a) => a.name === "resume-parser",
    );
    expect(jdMatcher?.blocking).toBe("Connect the GoHire integration");
    expect(resumeParser?.blocking).toBeNull();
    expect(jdMatcher?.test).toBeNull();
    expect(resumeParser?.test).toBeNull();
    expect(overview.readiness).toEqual({
      ready: 0,
      pendingConfig: 1,
      verifying: 0,
    });
  });

  it("derives qualification and verifying from the latest sandbox attempt on the candidate", () => {
    const fixture = makeSessionFixture();
    const { packageVersionId } = insertCandidate(fixture);
    const jobId = `ocj-suite-${fixture.suffix}`;
    getDb()
      .insert(ontocodeHarnessJobs)
      .values({
        id: jobId,
        tenantId,
        sessionId: fixture.session.id,
        commandId: null,
        kind: "test",
        status: "succeeded",
        idempotencyKey: `suite-job-${fixture.suffix}`,
        createdBy: "test-fde",
      })
      .run();
    const attemptBase = {
      tenantId,
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      harnessJobId: jobId,
      packageVersionId,
      dependencyRoot: sha(`deps-${fixture.suffix}`),
      ontologyHash: sha(`ontology-${fixture.suffix}`),
      testSuiteHash: sha(`suite-${fixture.suffix}`),
      candidateFingerprint: sha(`fingerprint-${fixture.suffix}`),
      createdBy: "test-fde",
    };
    getDb()
      .insert(ontocodeSandboxAttempts)
      .values({
        ...attemptBase,
        id: `ocsa-suite-a-${fixture.suffix}`,
        ordinal: 1,
        status: "succeeded",
        qualification: "promotable",
        createdAt: new Date(Date.now() - 10_000),
        updatedAt: new Date(Date.now() - 10_000),
      })
      .run();

    const settled = getOntoCodeSuiteOverview(fixture.ctx, fixture.session.id);
    // The concluded promotable attempt qualifies every covered agent as ready.
    expect(settled.agents.map((a) => a.qualification)).toEqual([
      "promotable",
      "promotable",
    ]);
    expect(settled.readiness).toEqual({
      ready: 2,
      pendingConfig: 0,
      verifying: 0,
    });

    getDb()
      .insert(ontocodeSandboxAttempts)
      .values({
        ...attemptBase,
        id: `ocsa-suite-b-${fixture.suffix}`,
        ordinal: 2,
        status: "queued",
        qualification: "development_only",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const pending = getOntoCodeSuiteOverview(fixture.ctx, fixture.session.id);
    // The newest attempt wins: it is still pending, so the suite is verifying.
    expect(pending.agents.map((a) => a.qualification)).toEqual([
      "development_only",
      "development_only",
    ]);
    expect(pending.readiness).toEqual({
      ready: 0,
      pendingConfig: 0,
      verifying: 2,
    });
  });
});
