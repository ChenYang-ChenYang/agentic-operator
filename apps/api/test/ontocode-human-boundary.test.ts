import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeHarnessJobs,
  ontocodeProjects,
  ontocodeSessionEvents,
  tenants,
} from "@agentic/db";
import {
  createOntoCodeProject,
  createOntoCodeSession,
  deleteOntoCodeSession,
} from "../src/services/ontocode-session-store";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import { confirmSessionHumanBoundaries } from "../src/services/ontocode-human-boundary";
import {
  listSystemProfiles,
  tenantHumanBoundarySystems,
} from "../src/services/system-profile-store";
import { buildTestEnv } from "./harness";

describe("confirmSessionHumanBoundaries", () => {
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
      { id: "ontocode-worker-test", name: "OntoCode human-boundary test Ontology" },
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

  function seedWaitingBuild(systems: string[]) {
    const ctx = { tenantId, actorId: "test-fde" };
    const suffix = randomUUID().slice(0, 8);
    const { project } = createOntoCodeProject(ctx, {
      domain: "ontocode-worker-test",
      name: `HB test ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `HB session ${suffix}`,
      goal: "Generate agents",
      autonomyMode: "copilot",
    });
    const db = getDb();
    const now = new Date();
    const jobId = `ocj-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.insert(ontocodeHarnessJobs)
      .values({
        id: jobId,
        tenantId,
        sessionId: session.id,
        commandId: null,
        runtimeProfileVersionId: null,
        kind: "build",
        status: "waiting_user",
        inputHash: null,
        budgetJson: null,
        errorMessage: `动作「processResume」需要连接 ${systems.join("、")}`,
        createdBy: "test-fde",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        updatedAt: now,
        testCasesJson: "[]",
        idempotencyKey: `idem-${suffix}`,
      })
      .run();
    db.insert(ontocodeSessionEvents)
      .values({
        id: `oce-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        seq: 900,
        tenantId,
        projectId: project.id,
        sessionId: session.id,
        harnessJobId: jobId,
        commandId: null,
        correlationId: `cor-${suffix}`,
        causationId: null,
        type: "harness.build.waiting_user",
        visibility: "user",
        payloadJson: JSON.stringify({
          jobId,
          kind: "build",
          question: {
            id: `q-${suffix}`,
            kind: "config",
            question: "确认哪些真实工具连接这些系统",
            systems,
            allowOther: true,
          },
        }),
        createdAt: now,
      })
      .run();
    return { ctx, session, jobId };
  }

  it("marks the pending systems as human boundary and resumes the build", () => {
    const { ctx, session, jobId } = seedWaitingBuild([
      "Internal_Recruitment_System",
    ]);

    const result = confirmSessionHumanBoundaries(ctx, session.id);

    // 1. systems read from the server-side waiting event, not the client
    expect(result.systems).toEqual(["Internal_Recruitment_System"]);
    expect(result.resumed).toBe(true);
    expect(result.resumeAction).toBe("generate_package");

    // 2. a durable humanBoundary System Profile now exists → future builds clear the gate
    const boundarySystems = tenantHumanBoundarySystems(tenantId);
    expect(boundarySystems).toContain("Internal_Recruitment_System");
    const profiles = listSystemProfiles(tenantId);
    const marked = profiles.find(
      (p) => p.name === "Internal_Recruitment_System",
    );
    expect(marked?.governance?.humanBoundary).toBe(true);
    // provenance stamped by upsert (the FDE confirmed it)
    expect(marked?.provenance?.confirmedBy).toBe("test-fde");

    // 3. the parked build was cancelled and a fresh build queued (resume)
    const jobs = getDb()
      .select()
      .from(ontocodeHarnessJobs)
      .where(eq(ontocodeHarnessJobs.sessionId, session.id))
      .all();
    const original = jobs.find((j) => j.id === jobId);
    expect(original?.status).toBe("cancelled");
    const resumed = jobs.find(
      (j) => j.id !== jobId && j.kind === "build",
    );
    expect(resumed).toBeDefined();
    expect(resumed?.status === "queued" || resumed?.status === "leased").toBe(
      true,
    );
  });

  it("deletes a parked session outright, cascading its children", () => {
    const { ctx, session, jobId } = seedWaitingBuild([
      "Internal_Recruitment_System",
    ]);
    const db = getDb();
    // preconditions: the session has children and is NOT idle (close would refuse)
    expect(
      db
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.sessionId, session.id))
        .all().length,
    ).toBeGreaterThan(0);

    const receipt = deleteOntoCodeSession(ctx, session.id);
    expect(receipt.deleted).toBe(true);
    expect(receipt.cancelledJobs).toBeGreaterThan(0);

    // the row and every child are gone (FK cascade + foreign_keys=ON)
    expect(
      db
        .select()
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.id, jobId))
        .all(),
    ).toHaveLength(0);
    expect(
      db
        .select()
        .from(ontocodeSessionEvents)
        .where(eq(ontocodeSessionEvents.sessionId, session.id))
        .all(),
    ).toHaveLength(0);
    // deleting again is a clean 404, not a crash
    expect(() => deleteOntoCodeSession(ctx, session.id)).toThrow();
  });

  it("refuses to delete a session from another Business Domain", () => {
    const { session } = seedWaitingBuild(["Internal_Recruitment_System"]);
    expect(() =>
      deleteOntoCodeSession(
        { tenantId: "ten-someone-else", actorId: "intruder" },
        session.id,
      ),
    ).toThrow();
  });

  it("rejects when there is no waiting build", () => {
    const ctx = { tenantId, actorId: "test-fde" };
    const suffix = randomUUID().slice(0, 8);
    const { project } = createOntoCodeProject(ctx, {
      domain: "ontocode-worker-test",
      name: `HB empty ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `HB empty ${suffix}`,
      goal: "Generate agents",
      autonomyMode: "copilot",
    });
    expect(() => confirmSessionHumanBoundaries(ctx, session.id)).toThrow();
  });
});
