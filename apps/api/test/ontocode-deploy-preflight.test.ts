// The deploy preflight must be precise and honest: it reports the real reason a
// candidate cannot be promoted, and it must never relax a governance gate to
// make the flow look finished.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeCandidateHeads,
  ontocodePackageVersions,
  ontocodeProjects,
  ontocodeSandboxAttempts,
  tenants,
} from "@agentic/db";
import {
  createOntoCodeCommand,
  createOntoCodeHarnessJob,
  createOntoCodeProject,
  createOntoCodeSession,
} from "../src/services/ontocode-session-store";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import { preflightOntoCodeDeploy } from "../src/services/ontocode-deploy";
import { buildTestEnv } from "./harness";

const DOMAIN = "deploy-preflight-domain";

describe("preflightOntoCodeDeploy", () => {
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
      { id: DOMAIN, name: "Deploy preflight Ontology" },
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
            originalBinding.ontologyDomainName ?? originalBinding.ontologyDomainId,
        },
        originalBinding.source,
      );
    } else {
      clearFactoryDomainBinding(tenantId);
    }
  });

  function seedSession() {
    const ctx = { tenantId, actorId: "test-fde" };
    const suffix = randomUUID().slice(0, 8);
    const { project } = createOntoCodeProject(ctx, {
      domain: DOMAIN,
      name: `Preflight ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Preflight ${suffix}`,
      goal: "部署这套 agents",
      autonomyMode: "copilot",
    });
    return { ctx, project, session, suffix };
  }

  /** sandbox attempts reference a real harness job (FK, NOT NULL). */
  function seedJob(sessionId: string, revision: number, suffix: string) {
    const ctx = { tenantId, actorId: "test-fde" };
    const { command, sessionRevision } = createOntoCodeCommand(ctx, sessionId, {
      type: "run_tests",
      arguments: {},
      expectedSessionRevision: revision,
      affectedSemanticPaths: [],
      riskClass: "sandbox_effect",
      requestedCapabilities: [],
      requiresHuman: false,
      rationaleSummary: "seed",
      idempotencyKey: `cmd-${suffix}`,
    });
    const { job } = createOntoCodeHarnessJob(ctx, sessionId, {
      commandId: command.id,
      kind: "test",
      expectedSessionRevision: sessionRevision,
      idempotencyKey: `job-${suffix}`,
    });
    return job.id;
  }

  function seedCandidate(
    projectId: string,
    sessionId: string,
    suffix: string,
    status: "candidate_ready" | "verified_candidate",
  ) {
    const db = getDb();
    const now = new Date();
    const pkgId = `ocpv-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.insert(ontocodePackageVersions)
      .values({
        id: pkgId,
        tenantId,
        projectId,
        sessionId,
        parentVersionId: null,
        sourceHarnessJobId: null,
        ontologyHash: "a".repeat(64),
        dependencyRoot: "b".repeat(64),
        artifactRefsJson: JSON.stringify([
          {
            logicalName: "agents/createJD/agent.ts",
            kind: "agent_code",
            artifactId: "oca-x",
            artifactVersionId: "ocav-x",
            blobHash: "c".repeat(64),
          },
        ]),
        executionOwnersJson: JSON.stringify({ createJD: "declarative_manifest" }),
        status,
        validationJson: JSON.stringify({ releaseEligible: false }),
        idempotencyKey: `pkg-${suffix}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(ontocodeCandidateHeads)
      .values({
        id: `och-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        tenantId,
        projectId,
        sessionId,
        packageVersionId: pkgId,
        revision: 2,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return pkgId;
  }

  it("says there is nothing to deploy before any candidate exists", () => {
    const { ctx, session } = seedSession();
    const pf = preflightOntoCodeDeploy(ctx, session.id);
    expect(pf.deployable).toBe(false);
    expect(pf.candidate).toBeNull();
    expect(pf.blockers.map((b) => b.code)).toEqual(["no_candidate"]);
    // every blocker must tell the FDE what to actually do
    expect(pf.blockers[0]?.remedy).toContain("构建");
  });

  it("refuses an unverified candidate and explains why", () => {
    const { ctx, project, session, suffix } = seedSession();
    seedCandidate(project.id, session.id, suffix, "candidate_ready");
    const pf = preflightOntoCodeDeploy(ctx, session.id);
    expect(pf.deployable).toBe(false);
    expect(pf.candidate?.status).toBe("candidate_ready");
    const codes = pf.blockers.map((b) => b.code);
    expect(codes).toContain("candidate_not_verified");
    expect(codes).toContain("no_sandbox_attempt");
  });

  it("refuses a same-host sandbox result as release evidence", () => {
    const { ctx, project, session, suffix } = seedSession();
    const pkgId = seedCandidate(
      project.id,
      session.id,
      suffix,
      "verified_candidate",
    );
    const now = new Date();
    getDb()
      .insert(ontocodeSandboxAttempts)
      .values({
        id: `ocsa-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        tenantId,
        projectId: project.id,
        sessionId: session.id,
        harnessJobId: seedJob(session.id, session.revision, suffix),
        ordinal: 1,
        packageVersionId: pkgId,
        dependencyRoot: "b".repeat(64),
        ontologyHash: "a".repeat(64),
        testSuiteHash: "d".repeat(64),
        candidateFingerprint: "e".repeat(64),
        status: "succeeded",
        qualification: "development_only",
        executionOrigin: "local",
        isolationTier: "same_host_container",
        idempotencyKey: `att-${suffix}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const pf = preflightOntoCodeDeploy(ctx, session.id);
    expect(pf.deployable).toBe(false);
    expect(pf.sandbox?.qualification).toBe("development_only");
    const blocker = pf.blockers.find((b) => b.code === "sandbox_not_qualified");
    expect(blocker).toBeDefined();
    // the reason must name the real cause, not a generic failure
    expect(blocker?.detail).toContain("same_host_container");
    expect(blocker?.remedy).toContain("独立");
  });

  it("clears only when the candidate is verified AND the sandbox is promotable", () => {
    const { ctx, project, session, suffix } = seedSession();
    const pkgId = seedCandidate(
      project.id,
      session.id,
      suffix,
      "verified_candidate",
    );
    const now = new Date();
    getDb()
      .insert(ontocodeSandboxAttempts)
      .values({
        id: `ocsa-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        tenantId,
        projectId: project.id,
        sessionId: session.id,
        harnessJobId: seedJob(session.id, session.revision, suffix),
        ordinal: 1,
        packageVersionId: pkgId,
        dependencyRoot: "b".repeat(64),
        ontologyHash: "a".repeat(64),
        testSuiteHash: "d".repeat(64),
        candidateFingerprint: "e".repeat(64),
        status: "succeeded",
        qualification: "promotable",
        executionOrigin: "remote",
        isolationTier: "dedicated_host",
        idempotencyKey: `att-${suffix}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const pf = preflightOntoCodeDeploy(ctx, session.id);
    expect(pf.blockers).toEqual([]);
    expect(pf.deployable).toBe(true);
    expect(pf.sandbox?.qualification).toBe("promotable");
  });
});
