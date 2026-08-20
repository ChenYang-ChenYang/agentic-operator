import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { and, eq } from "drizzle-orm";
import { auditLog, factoryRuns, getDb, tenants, users } from "@agentic/db";

import { registerEnvelope } from "../src/plugins/error";
import { agentFactoryRoutes } from "../src/routes/v1/agent-factory";
import { recordRunFinish, recordRunStart } from "../src/services/agent-factory";
import { clearFactoryDomainBinding, setFactoryDomainBinding } from "../src/services/agent-factory/domain-binding";

const suffix = Date.now().toString(36);
const tenantId = `ten-factory-audit-${suffix}`;
const tenantSlug = `factory-audit-${suffix}`;
const userId = `usr-factory-audit-${suffix}`;
const domain = `factory-audit-domain-${suffix}`;
const runId = `frn-factory-audit-${suffix}`;
const waitingRunId = `frn-factory-audit-waiting-${suffix}`;
let app: ReturnType<typeof Fastify>;

function audits(action: string, targetId: string) {
  return getDb().select().from(auditLog).where(and(
    eq(auditLog.tenantId, tenantId),
    eq(auditLog.action, action),
    eq(auditLog.targetId, targetId),
  )).all();
}

beforeAll(async () => {
  const now = new Date();
  getDb().insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Factory Audit Operator",
    platformRole: "superadmin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Factory mutation audit", createdAt: now, updatedAt: now }).run();
  setFactoryDomainBinding(tenantId, { id: domain, name: "Factory audit ontology" }, "explicit");
  recordRunStart(domain, "private goal must never enter operation audit metadata", tenantId, runId);
  recordRunFinish(runId, {
    status: "done",
    tokensUsed: 12,
    turns: 1,
    agentsCount: 1,
    reachedTerminal: true,
    transcript: [{ t: "done", status: "finished", tokensUsed: 12, turns: 1 }],
  }, tenantId);

  app = Fastify({ logger: false });
  await registerEnvelope(app);
  app.addHook("onRequest", async (req) => {
    req.auth = {
      userId,
      email: `${userId}@example.test`,
      name: "Factory Audit Operator",
      platformRole: "superadmin",
      tenantId,
      tenantSlug,
      role: "admin",
      via: "cookie",
    };
  });
  await app.register(agentFactoryRoutes, { prefix: "/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  getDb().delete(auditLog).where(eq(auditLog.tenantId, tenantId)).run();
  getDb().delete(factoryRuns).where(eq(factoryRuns.tenantId, tenantId)).run();
  clearFactoryDomainBinding(tenantId);
  getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  getDb().delete(users).where(eq(users.id, userId)).run();
});

describe("Agent Factory mutation truth + operation audit", () => {
  it("does not report a missing run delete as a successful false-valued mutation", async () => {
    const missing = `frn-missing-${suffix}`;
    const response = await app.inject({ method: "DELETE", url: `/v1/agent-factory/runs/${missing}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
    const rows = audits("agent_factory.run.delete", missing);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metaJson).toMatchObject({ decision: "deny", outcome: "failed", errorCode: "not_found" });
  });

  it("refuses no-op stop/delete/restore states and audits both failure and durable success", async () => {
    const stopped = await app.inject({ method: "POST", url: "/v1/agent-factory/stop", payload: { runId } });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json()).toMatchObject({ ok: false, error: { code: "not_running" } });

    const deleted = await app.inject({ method: "DELETE", url: `/v1/agent-factory/runs/${runId}` });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().data).toEqual({ deleted: true });
    const duplicateDelete = await app.inject({ method: "DELETE", url: `/v1/agent-factory/runs/${runId}` });
    expect(duplicateDelete.statusCode).toBe(409);
    expect(duplicateDelete.json()).toMatchObject({ ok: false, error: { code: "already_deleted" } });

    const restored = await app.inject({ method: "POST", url: `/v1/agent-factory/runs/${runId}/restore` });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().data).toEqual({ restored: true });
    const duplicateRestore = await app.inject({ method: "POST", url: `/v1/agent-factory/runs/${runId}/restore` });
    expect(duplicateRestore.statusCode).toBe(409);
    expect(duplicateRestore.json()).toMatchObject({ ok: false, error: { code: "not_deleted" } });

    expect(audits("agent_factory.run.stop", runId).map((row) => row.metaJson)).toContainEqual(expect.objectContaining({ decision: "deny", outcome: "failed", errorCode: "not_running" }));
    expect(audits("agent_factory.run.delete", runId).map((row) => row.metaJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "allow", outcome: "succeeded" }),
      expect.objectContaining({ decision: "deny", outcome: "failed", errorCode: "already_deleted" }),
    ]));
    expect(audits("agent_factory.run.restore", runId).map((row) => row.metaJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "allow", outcome: "succeeded" }),
      expect.objectContaining({ decision: "deny", outcome: "failed", errorCode: "not_deleted" }),
    ]));
    expect(JSON.stringify([
      ...audits("agent_factory.run.stop", runId),
      ...audits("agent_factory.run.delete", runId),
      ...audits("agent_factory.run.restore", runId),
    ].map((row) => row.metaJson))).not.toContain("private goal");
  });

  it("durably stops a waiting-human run without deleting its history", async () => {
    recordRunStart(
      domain,
      "waiting for a decision that the operator chose to abandon",
      tenantId,
      waitingRunId,
    );
    recordRunFinish(
      waitingRunId,
      {
        status: "waiting_human",
        tokensUsed: 2,
        turns: 1,
        agentsCount: 0,
        reachedTerminal: false,
        transcript: [
          {
            t: "done",
            status: "waiting_human",
            completionKind: "incomplete",
          },
        ],
      },
      tenantId,
    );

    const stopped = await app.inject({
      method: "POST",
      url: "/v1/agent-factory/stop",
      payload: { runId: waitingRunId },
    });

    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json().data).toEqual({
      aborted: false,
      finalized: true,
    });
    expect(getDb().select().from(factoryRuns).where(
      and(
        eq(factoryRuns.tenantId, tenantId),
        eq(factoryRuns.id, waitingRunId),
      ),
    ).all()[0]).toMatchObject({
      status: "aborted",
      deletedAt: null,
    });
    expect(
      audits("agent_factory.run.stop", waitingRunId).map(
        (row) => row.metaJson,
      ),
    ).toContainEqual(
      expect.objectContaining({
        decision: "allow",
        outcome: "succeeded",
        mode: "orphan_durably_finalized",
        previousStatus: "waiting_human",
      }),
    );
  });
});
