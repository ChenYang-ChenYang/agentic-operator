// End-to-end proof that the Ontology Analyst is reachable as a real job:
// a queued ontology_analysis job, leased and executed by the actual worker
// adapter, must persist a receipt artifact and an evidence row like any other
// harness result — no special-casing, no mock persistence layer.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifacts,
  ontocodeCommands,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodeProjects,
  ontocodeSessionEvents,
  tenants,
} from "@agentic/db";
import type { DomainOntology } from "@agentic/agent-factory";
import { factorySourceOntologyHash } from "@agentic/agent-factory";
import {
  createOntoCodeCommand,
  createOntoCodeHarnessJob,
  createOntoCodeProject,
  createOntoCodeSession,
  decideOntoCodeCommand,
  getOntoCodeHarnessJob,
} from "../src/services/ontocode-session-store";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
  type FactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  createDefaultOntoCodeHarnessExecutors,
  OntoCodeHarnessWorkerAdapter,
} from "../src/services/ontocode-harness-worker";
import { buildTestEnv } from "./harness";

const ontology: DomainOntology = {
  domainId: "analyst-e2e-domain",
  source: "snapshot",
  objects: [
    { id: "Job_Requisition" },
    { id: "Job_Posting" },
    { id: "Isolated_Thing" },
  ],
  rules: [],
  events: [{ name: "requisition.approved" }, { name: "jd.generated" }],
  actions: [
    {
      id: "1",
      name: "createJD",
      actor: ["Agent"],
      trigger: ["requisition.approved"],
      triggered_event: ["jd.generated"],
      target_objects: ["Job_Requisition", "Job_Posting"],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
      integration: { systems: [{ name: "GoHire_System", role: "write" }] },
    },
  ],
  links: [
    {
      id: "object-fk/Job_Posting/Job_Requisition",
      kind: "object-fk",
      from: { id: "Job_Posting", type: "DataObject" },
      to: { id: "Job_Requisition", type: "DataObject" },
    },
  ],
  workflow: [],
} as DomainOntology;

describe("ontology_analysis end to end through the worker", () => {
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
      { id: ontology.domainId, name: "Analyst e2e Ontology" },
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

  it("executes a queued job and persists a real receipt + evidence", async () => {
    const ctx = { tenantId, actorId: "test-fde" };
    const suffix = randomUUID().slice(0, 8);
    const { project } = createOntoCodeProject(ctx, {
      domain: ontology.domainId,
      name: `Analyst e2e ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Analyst e2e ${suffix}`,
      goal: "理解这个域的本体",
      autonomyMode: "copilot",
      ontologySnapshotHash: factorySourceOntologyHash(ontology),
    });

    // the same path the assistant uses: command -> approved -> job
    const { command, sessionRevision } = createOntoCodeCommand(
      ctx,
      session.id,
      {
        type: "analyze_ontology",
        arguments: {},
        expectedSessionRevision: session.revision,
        affectedSemanticPaths: [],
        riskClass: "read_only",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: "FDE asked to understand the Ontology",
        idempotencyKey: `idem-cmd-${suffix}`,
      },
    );
    expect(command.riskClass).toBe("read_only");
    // read_only + !requiresHuman means no approval step is needed
    expect(command.status).not.toBe("awaiting_approval");

    const { job } = createOntoCodeHarnessJob(ctx, session.id, {
      commandId: command.id,
      kind: "ontology_analysis",
      expectedSessionRevision: sessionRevision,
      idempotencyKey: `job-${suffix}`,
    });
    expect(job.status).toBe("queued");
    void decideOntoCodeCommand;
    void ontocodeCommands;
    void and;

    // run it through the REAL worker adapter and the REAL executor registry
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: {
        fetchOntology: async () => ontology,
        recommendScope: async () => {
          throw new Error("scope not used in this test");
        },
        runBuild: async () => {
          throw new Error("build not used in this test");
        },
        runCandidateTest: async () => {
          throw new Error("test not used in this test");
        },
      } as never,
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      jobId: job.id,
      status: "succeeded",
    });
    void createDefaultOntoCodeHarnessExecutors;

    expect(getOntoCodeHarnessJob(ctx, job.id).status).toBe("succeeded");

    // the receipt lands as a normal harness artifact
    const artifacts = getDb()
      .select()
      .from(ontocodeArtifacts)
      .where(eq(ontocodeArtifacts.sessionId, session.id))
      .all();
    const receipt = artifacts.find((a) =>
      a.logicalName.includes("ontology_analysis"),
    );
    expect(receipt).toBeDefined();
    expect(receipt?.kind).toBe("harness_receipt");

    // and as an evidence row — analysis is informational, never a test verdict
    const evidence = getDb()
      .select()
      .from(ontocodeEvidenceRecords)
      .where(eq(ontocodeEvidenceRecords.sessionId, session.id))
      .all();
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]?.outcome).toBe("informational");

    // the analyst's own phases are visible in the session event stream, which is
    // what the reasoning-flow view draws from
    const events = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.sessionId, session.id))
      .all();
    const analysisEvents = events.filter((e) =>
      e.type.startsWith("harness.ontology_analysis."),
    );
    expect(analysisEvents.map((e) => e.type)).toContain(
      "harness.ontology_analysis.plan",
    );
  });

  // The Allmeta source can serve live per-Action rule bindings, but the Analyst
  // was never handed that capability, so it always reported "could not check".
  it("probes live Action rules when the bound source can serve them", async () => {
    const ctx = { tenantId, actorId: "test-fde" };
    const suffix = randomUUID().slice(0, 8);
    const { project } = createOntoCodeProject(ctx, {
      domain: ontology.domainId,
      name: `Analyst rules ${suffix}`,
    });
    projectIds.push(project.id);
    const { session } = createOntoCodeSession(ctx, {
      projectId: project.id,
      title: `Analyst rules ${suffix}`,
      goal: "理解这个域的本体",
      autonomyMode: "copilot",
      ontologySnapshotHash: factorySourceOntologyHash(ontology),
    });
    const { command, sessionRevision } = createOntoCodeCommand(
      ctx,
      session.id,
      {
        type: "analyze_ontology",
        arguments: {},
        expectedSessionRevision: session.revision,
        affectedSemanticPaths: [],
        riskClass: "read_only",
        requestedCapabilities: [],
        requiresHuman: false,
        rationaleSummary: "FDE asked to understand the Ontology",
        idempotencyKey: `idem-rules-${suffix}`,
      },
    );
    createOntoCodeHarnessJob(ctx, session.id, {
      commandId: command.id,
      kind: "ontology_analysis",
      expectedSessionRevision: sessionRevision,
      idempotencyKey: `job-rules-${suffix}`,
    });

    const askedFor: string[] = [];
    const worker = new OntoCodeHarnessWorkerAdapter({
      tenantId,
      factory: {
        fetchOntology: async () => ontology,
        recommendScope: async () => {
          throw new Error("scope not used in this test");
        },
        runBuild: async () => {
          throw new Error("build not used in this test");
        },
        fetchActionRules: async (input: { actionName: string }) => {
          askedFor.push(input.actionName);
          return [{ id: "R-1", name: "JD 必须包含薪资区间" }];
        },
      } as never,
    });
    await expect(worker.runNext()).resolves.toMatchObject({
      status: "succeeded",
    });

    // It asked about the real Agent action, by name, from the real Ontology.
    expect(askedFor).toEqual(["createJD"]);
    const observation = getDb()
      .select()
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.sessionId, session.id))
      .all()
      .find((e) => e.type === "harness.ontology_analysis.observation");
    expect(JSON.parse(observation!.payloadJson)).toMatchObject({ probes: 1 });
  });
});
