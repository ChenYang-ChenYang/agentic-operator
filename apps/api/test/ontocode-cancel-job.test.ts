// 停止正在跑的作业，但保留 Session。
//
// 在此之前，眼看一个作业跑飞了的唯一出路是删掉整个 Session——而删除会级联清掉
// 它的消息、事件、产物与证据。「停下这一步」和「这次尝试作废」是两个意图，
// 不该共用一个按钮。
//
// 取消不需要新的中断链路：worker 的心跳用
// `status='running' AND startedAt=leaseToken` 重新宣示所有权，把行改成
// cancelled 之后这个谓词不再成立，worker 会在一个心跳周期内自行中止。所以
// 取消是关于作业行的一个事实，而不是一个 worker 可以忽略的请求。
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  ontocodeHarnessJobs,
  ontocodeSessionEvents,
  ontocodeSessions,
  tenants,
} from "@agentic/db";
import { setFactoryDomainBinding } from "../src/services/agent-factory/domain-binding";
import { buildTestEnv, type TestEnv } from "./harness";
import { installOntoCodeTestOntology } from "./ontocode-ontology-fixture";

async function success<T>(response: Response): Promise<T> {
  return ((await response.json()) as { ok: true; data: T }).data;
}

describe("OntoCode cancel-job", () => {
  let env: TestEnv;
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    id: `ten-oc-cancel-${suffix}`,
    slug: `occan${suffix}`,
    name: "OntoCode cancel job",
    domain: `Cancel-${suffix}`,
  };
  let removeOntology: () => Promise<void>;
  let headers: Record<string, string>;
  let sessionId: string;
  let projectId: string;

  beforeAll(async () => {
    env = await buildTestEnv();
    getDb()
      .insert(tenants)
      .values([{ id: fixture.id, slug: fixture.slug, name: fixture.name }])
      .run();
    const installed = await installOntoCodeTestOntology({
      tenantSlug: fixture.slug,
      domainId: fixture.domain,
      name: fixture.domain,
    });
    removeOntology = installed.remove;
    setFactoryDomainBinding(
      fixture.id,
      { id: fixture.domain, name: fixture.domain },
      "upload",
    );
    headers = {
      "content-type": "application/json",
      "x-agentic-tenant": fixture.slug,
    };
    projectId = (
      await success<{ project: { id: string } }>(
        await env.fetch("/v1/ontocode/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({
            domain: fixture.domain,
            name: `${fixture.name} Project`,
          }),
        }),
      )
    ).project.id;
    sessionId = (
      await success<{ session: { id: string } }>(
        await env.fetch("/v1/ontocode/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId,
            title: `${fixture.name} Session`,
            goal: "Exercise stopping a live job",
          }),
        }),
      )
    ).session.id;
  });

  afterAll(async () => {
    await removeOntology();
    getDb().delete(tenants).where(eq(tenants.id, fixture.id)).run();
    await env.cleanup();
  });

  function seedRunningJob(id: string): void {
    const now = new Date();
    getDb()
      .insert(ontocodeHarnessJobs)
      .values({
        id,
        tenantId: fixture.id,
        projectId,
        sessionId,
        kind: "build",
        status: "running",
        attempt: 1,
        idempotencyKey: `${id}-idem`,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      } as typeof ontocodeHarnessJobs.$inferInsert)
      .run();
    getDb()
      .update(ontocodeSessions)
      .set({ activityState: "running" })
      .where(eq(ontocodeSessions.id, sessionId))
      .run();
  }

  it("stops the running job and leaves the Session and its history intact", async () => {
    const jobId = `ocj-cancel-${suffix}`;
    seedRunningJob(jobId);
    // 会话里已有的事件——取消绝不能把它们带走。
    const eventsBefore = getDb()
      .select({ id: ontocodeSessionEvents.id })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.sessionId, sessionId))
      .all().length;

    const receipt = await success<{
      cancelled: boolean;
      jobIds: string[];
    }>(
      await env.fetch(`/v1/ontocode/sessions/${sessionId}/cancel-job`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    );
    expect(receipt).toMatchObject({ cancelled: true, jobIds: [jobId] });

    const job = getDb()
      .select({ status: ontocodeHarnessJobs.status })
      .from(ontocodeHarnessJobs)
      .where(
        and(
          eq(ontocodeHarnessJobs.tenantId, fixture.id),
          eq(ontocodeHarnessJobs.id, jobId),
        ),
      )
      .get();
    expect(job?.status).toBe("cancelled");

    // Session 还在，历史还在，活动状态回到 idle。
    const session = getDb()
      .select({ activityState: ontocodeSessions.activityState })
      .from(ontocodeSessions)
      .where(eq(ontocodeSessions.id, sessionId))
      .get();
    expect(session?.activityState).toBe("idle");
    expect(
      getDb()
        .select({ id: ontocodeSessionEvents.id })
        .from(ontocodeSessionEvents)
        .where(eq(ontocodeSessionEvents.sessionId, sessionId))
        .all().length,
    ).toBe(eventsBefore);
  });

  it("is idempotent: re-cancelling reports nothing to stop, not an error", async () => {
    const response = await env.fetch(
      `/v1/ontocode/sessions/${sessionId}/cancel-job`,
      { method: "POST", headers, body: JSON.stringify({}) },
    );
    expect(response.status).toBe(200);
    expect(
      await success<{ cancelled: boolean; jobIds: string[] }>(response),
    ).toMatchObject({ cancelled: false, jobIds: [] });
  });

  it("leaves a waiting_user job alone — it is waiting for this very person", async () => {
    const jobId = `ocj-waiting-${suffix}`;
    const now = new Date();
    getDb()
      .insert(ontocodeHarnessJobs)
      .values({
        id: jobId,
        tenantId: fixture.id,
        projectId,
        sessionId,
        kind: "build",
        status: "waiting_user",
        attempt: 1,
        idempotencyKey: `${jobId}-idem`,
        createdAt: now,
        updatedAt: now,
      } as typeof ontocodeHarnessJobs.$inferInsert)
      .run();

    const receipt = await success<{ cancelled: boolean }>(
      await env.fetch(`/v1/ontocode/sessions/${sessionId}/cancel-job`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    );
    expect(receipt.cancelled).toBe(false);
    expect(
      getDb()
        .select({ status: ontocodeHarnessJobs.status })
        .from(ontocodeHarnessJobs)
        .where(eq(ontocodeHarnessJobs.id, jobId))
        .get()?.status,
    ).toBe("waiting_user");
  });
});
