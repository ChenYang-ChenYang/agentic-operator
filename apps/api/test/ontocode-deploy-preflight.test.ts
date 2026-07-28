// The deploy preflight must be precise and honest: it reports the real reason a
// candidate cannot be promoted, and it must never relax a governance gate to
// make the flow look finished.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifactBlobs,
  ontocodeArtifacts,
  ontocodeArtifactVersions,
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
import {
  markOntoCodeCandidateReleased,
  preflightOntoCodeDeploy,
} from "../src/services/ontocode-deploy";
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

  /** #DRAFT-BINDING — write the immutable artifact a real Build produces, so the
   * preflight reads a genuine binding rather than a test-only shortcut. */
  function seedDraftBinding(
    projectId: string,
    sessionId: string,
    suffix: string,
    binding: Record<string, unknown>,
  ) {
    const db = getDb();
    const now = new Date();
    // Blobs are content-addressed per tenant, so keep each fixture distinct.
    const content = JSON.stringify({ ...binding, sourceHarnessJobId: suffix });
    const blobId = `ocab-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const artifactId = `oca-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const versionId = `ocav-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.insert(ontocodeArtifactBlobs)
      .values({
        id: blobId,
        tenantId,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        contentText: content,
        createdAt: now,
      })
      .run();
    db.insert(ontocodeArtifacts)
      .values({
        id: artifactId,
        tenantId,
        projectId,
        sessionId,
        logicalName: "package/factory-draft.json",
        kind: "agent_config",
        semanticPath: "/package/factoryDraft",
        createdAt: now,
      })
      .run();
    db.insert(ontocodeArtifactVersions)
      .values({
        id: versionId,
        tenantId,
        sessionId,
        artifactId,
        blobId,
        version: 1,
        blobHash: createHash("sha256").update(content).digest("hex"),
        contentType: "application/json",
        sizeBytes: Buffer.byteLength(content, "utf8"),
        changeSetId: null,
        metadataJson: JSON.stringify({}),
        idempotencyKey: `draft-binding-${suffix}`,
        createdAt: now,
      })
      .run();
    return {
      logicalName: "package/factory-draft.json",
      kind: "agent_config",
      artifactId,
      artifactVersionId: versionId,
      blobHash: createHash("sha256").update(content).digest("hex"),
    };
  }

  function seedCandidate(
    projectId: string,
    sessionId: string,
    suffix: string,
    status: "candidate_ready" | "verified_candidate",
    draftBinding: Record<string, unknown> | null = {
      schema: "ontocode-candidate-factory-draft/v1",
      domain: DOMAIN,
      draftVersionIds: ["v-20260728120000000-abcd1234"],
      bound: true,
      unboundAgents: [],
      unboundReason: null,
    },
  ) {
    const db = getDb();
    const now = new Date();
    const pkgId = `ocpv-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const bindingRef = draftBinding
      ? seedDraftBinding(projectId, sessionId, suffix, draftBinding)
      : null;
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
          ...(bindingRef ? [bindingRef] : []),
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
    expect(pf.draftBinding?.draftVersionIds).toEqual([
      "v-20260728120000000-abcd1234",
    ]);
  });

  // #DRAFT-BINDING — promotion operates on an on-disk draft version. A candidate
  // that cannot name exactly one has no unambiguous deploy target, and saying
  // "ready" there would promote something nobody verified.
  it("refuses to deploy a candidate that names no Factory draft version", () => {
    const { ctx, project, session, suffix } = seedSession();
    const pkgId = seedCandidate(
      project.id,
      session.id,
      suffix,
      "verified_candidate",
      null,
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
    expect(pf.deployable).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["factory_draft_unbound"]);
    expect(pf.draftBinding).toBeNull();
  });

  // #RELEASED — the release write must describe the exact thing that went live.
  describe("markOntoCodeCandidateReleased", () => {
    function release(
      pkgId: string,
      overrides: Partial<{ dependencyRoot: string }> = {},
    ) {
      return markOntoCodeCandidateReleased(
        { tenantId, actorId: "test-fde" },
        {
          packageVersionId: pkgId,
          dependencyRoot: overrides.dependencyRoot ?? "b".repeat(64),
          draftVersionId: "v-20260728120000000-abcd1234",
          reviewReceiptId: "rcp-real-human",
          deploymentId: "dep-1",
          promotedSlugs: ["createJD"],
          functionsRegistered: 1,
          liveAgents: 6,
          releasedAt: new Date(),
        },
      );
    }

    it("marks a verified candidate released and records what went live", () => {
      const { project, session, suffix } = seedSession();
      const pkgId = seedCandidate(
        project.id,
        session.id,
        suffix,
        "verified_candidate",
      );
      expect(release(pkgId)).toBe(true);
      const row = getDb()
        .select()
        .from(ontocodePackageVersions)
        .where(eq(ontocodePackageVersions.id, pkgId))
        .get();
      expect(row?.status).toBe("released");
      const validation = JSON.parse(row!.validationJson) as Record<
        string,
        unknown
      >;
      expect(validation.releaseEligible).toBe(true);
      expect(validation.factoryDraftVersionId).toBe(
        "v-20260728120000000-abcd1234",
      );
      expect(validation.reviewReceiptId).toBe("rcp-real-human");
    });

    it("refuses to release a candidate that was never verified", () => {
      const { project, session, suffix } = seedSession();
      const pkgId = seedCandidate(
        project.id,
        session.id,
        suffix,
        "candidate_ready",
      );
      expect(release(pkgId)).toBe(false);
      expect(
        getDb()
          .select()
          .from(ontocodePackageVersions)
          .where(eq(ontocodePackageVersions.id, pkgId))
          .get()?.status,
      ).toBe("candidate_ready");
    });

    it("refuses to release when the candidate's content drifted", () => {
      const { project, session, suffix } = seedSession();
      const pkgId = seedCandidate(
        project.id,
        session.id,
        suffix,
        "verified_candidate",
      );
      expect(release(pkgId, { dependencyRoot: "f".repeat(64) })).toBe(false);
      expect(
        getDb()
          .select()
          .from(ontocodePackageVersions)
          .where(eq(ontocodePackageVersions.id, pkgId))
          .get()?.status,
      ).toBe("verified_candidate");
    });
  });

  it("refuses a candidate whose Agents are spread across several draft versions", () => {
    const { ctx, project, session, suffix } = seedSession();
    seedCandidate(project.id, session.id, suffix, "verified_candidate", {
      schema: "ontocode-candidate-factory-draft/v1",
      domain: DOMAIN,
      draftVersionIds: ["v-aaa", "v-bbb"],
      bound: false,
      unboundAgents: [],
      unboundReason: "这些 Agent 分散在多个 draft 版本里，无法作为一个整体促升",
    });
    const pf = preflightOntoCodeDeploy(ctx, session.id);
    const blocker = pf.blockers.find((b) => b.code === "factory_draft_unbound");
    expect(blocker?.detail).toContain("多个 draft 版本");
    expect(pf.draftBinding?.draftVersionIds).toEqual(["v-aaa", "v-bbb"]);
  });
});
