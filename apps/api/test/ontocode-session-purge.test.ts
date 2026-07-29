// #SESSION-PURGE —— 删除一个 Session 到底删掉了什么。
//
// 修掉的行为：删除只走行删除（cascade 是对的），完全不触及四类盘上/库内状态：
//   · data/logs/factory-runs/<tenantId>/ocf-<jobId>-a<n>.ndjson（大脑转录）
//   · data/factory-conversation-archive/…/<runId>.ndjson（recall 的检索面——
//     不删的话，一个用户以为已抹掉的 Session 之后仍能被检索出内容）
//   · ontocode_artifact_blobs（content_text 是产物正文，且无 session 外键）
//
// 而且这些文件全按【作业 id】命名，作业行是把文件映射回 Session 的唯一线索，
// cascade 恰恰先删作业行——所以采集必须发生在删行【之前】，否则那一刻起这些
// 字节永久不可归属。本文件盯的就是这条顺序性质，以及「删除必须说清自己没删
// 什么」。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  ontocodeArtifactBlobs,
  ontocodeChangeSets,
  ontocodeEvidenceInvalidations,
  ontocodeEvidenceRecords,
  ontocodeHarnessJobs,
  ontocodePackageVersions,
  ontocodeSessionPurges,
  ontocodeSessions,
  tenants,
} from "@agentic/db";
import { setFactoryDomainBinding } from "../src/services/agent-factory/domain-binding";
import { buildTestEnv, type TestEnv } from "./harness";
import { installOntoCodeTestOntology } from "./ontocode-ontology-fixture";

async function success<T>(response: Response): Promise<T> {
  return ((await response.json()) as { ok: true; data: T }).data;
}

function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

describe("OntoCode session delete — external state purge", () => {
  let env: TestEnv;
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    id: `ten-oc-purge-${suffix}`,
    slug: `ocpur${suffix}`,
    name: "OntoCode purge",
    domain: `Purge-${suffix}`,
  };
  let removeOntology: () => Promise<void>;
  let headers: Record<string, string>;
  let bodylessHeaders: Record<string, string>;
  let sessionId: string;
  let projectId: string;
  const jobId = `ocj-purge${suffix}`;
  let transcriptFile: string;
  let archiveFile: string;

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
    bodylessHeaders = { "x-agentic-tenant": fixture.slug };
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
            goal: "Exercise the purge",
          }),
        }),
      )
    ).session.id;

    // 一个真实形状的作业 —— 转录文件名就是从它派生的。
    const now = new Date();
    getDb()
      .insert(ontocodeHarnessJobs)
      .values({
        id: jobId,
        tenantId: fixture.id,
        projectId,
        sessionId,
        kind: "build",
        status: "succeeded",
        attempt: 1,
        idempotencyKey: `${jobId}-idem`,
        createdAt: now,
        updatedAt: now,
      } as typeof ontocodeHarnessJobs.$inferInsert)
      .run();

    // 按生产的落盘规则铺两个文件：runId = `ocf-${jobId}-a${attempt}`。
    const runId = `ocf-${jobId}-a1`;
    const transcriptDir = path.resolve(
      dataRoot(),
      "logs",
      "factory-runs",
      fixture.id,
    );
    mkdirSync(transcriptDir, { recursive: true });
    transcriptFile = path.join(transcriptDir, `${runId}.ndjson`);
    writeFileSync(
      transcriptFile,
      `${JSON.stringify({ t: "think", delta: "机密推理内容" })}\n`,
      "utf8",
    );

    const archiveDir = path.join(
      dataRoot(),
      "factory-conversation-archive",
      "_tenants",
      fixture.id,
      fixture.domain,
    );
    mkdirSync(archiveDir, { recursive: true });
    archiveFile = path.join(archiveDir, `${runId}.ndjson`);
    writeFileSync(
      archiveFile,
      `${JSON.stringify({ at: 1, role: "user", content: "机密归档内容", foldSeq: 1 })}\n`,
      "utf8",
    );

    // 一个只被本 Session 引用的产物 blob（正文明文留库的那类）。
    getDb()
      .insert(ontocodeArtifactBlobs)
      .values({
        id: `ocb-purge-${suffix}`,
        tenantId: fixture.id,
        sha256: `sha-${suffix}`,
        sizeBytes: 42,
        contentText: "机密产物正文",
        createdAt: now,
      } as typeof ontocodeArtifactBlobs.$inferInsert)
      .run();
  });

  afterAll(async () => {
    await removeOntology();
    getDb().delete(tenants).where(eq(tenants.id, fixture.id)).run();
    await env.cleanup();
  });

  it("removes the brain transcript and the recall-searchable archive, not just the rows", async () => {
    expect(existsSync(transcriptFile)).toBe(true);
    expect(existsSync(archiveFile)).toBe(true);

    // 无 body 的 DELETE 不能声明 Content-Type: application/json —— Fastify 会
    // 以 FST_ERR_CTP_EMPTY_JSON_BODY 400 掉它。Web 端的 callV1 曾经无条件加这个
    // 头，于是删除按钮点下去在服务端连路由都没进；这里按修好之后的客户端行为发。
    const raw = await env.fetch(`/v1/ontocode/sessions/${sessionId}`, {
      method: "DELETE",
      headers: bodylessHeaders,
    });
    expect(raw.status).toBe(200);
    const receipt = await success<{
      deleted: true;
      purge: {
        id: string;
        status: string;
        removed: number;
        bytesRemoved: number;
        failures: unknown[];
        retained: Array<{ what: string; why: string }>;
      } | null;
    }>(raw);

    expect(receipt.deleted).toBe(true);
    expect(receipt.purge).toBeTruthy();
    expect(receipt.purge!.status).toBe("completed");
    // 这两条是这次修复的全部意义：以前它们会原样留在盘上，而且因为作业行已经
    // 没了，从此再也没人知道它们属于谁。
    expect(existsSync(transcriptFile)).toBe(false);
    expect(existsSync(archiveFile)).toBe(false);
    expect(receipt.purge!.removed).toBeGreaterThanOrEqual(2);
    expect(receipt.purge!.bytesRemoved).toBeGreaterThan(0);

    // 行也确实没了。
    expect(
      getDb()
        .select({ id: ontocodeSessions.id })
        .from(ontocodeSessions)
        .where(eq(ontocodeSessions.id, sessionId))
        .get(),
    ).toBeUndefined();
  });

  it("leaves a durable record of what the Session was and what was deliberately kept", async () => {
    const record = getDb()
      .select()
      .from(ontocodeSessionPurges)
      .where(eq(ontocodeSessionPurges.sessionId, sessionId))
      .get();
    expect(record).toBeTruthy();
    expect(record!.status).toBe("completed");
    expect(record!.sessionTitle).toContain(fixture.name);
    // 记录里保存的是「Session 曾经是什么」——行删掉之后这是唯一的凭证。
    const summary = JSON.parse(record!.summaryJson) as {
      jobs: number;
      jobIds: string[];
      retained: Array<{ what: string }>;
    };
    expect(summary.jobs).toBe(1);
    expect(summary.jobIds).toContain(jobId);
    // 删除必须说清自己【没】删什么。
    expect(summary.retained.length).toBeGreaterThan(0);

    const listed = await success<{ items: Array<{ sessionId: string }> }>(
      await env.fetch("/v1/ontocode/session-purges", {
        headers: bodylessHeaders,
      }),
    );
    expect(listed.items.some((item) => item.sessionId === sessionId)).toBe(true);
  });

  it("a Session that produced a Candidate package can still be deleted (#DELETE-RESTRICT)", async () => {
    // SQLite 在做级联清扫【之前】就先判 ON DELETE RESTRICT。
    // ontocode_evidence_invalidations 自己没有 session_id（只有 tenant /
    // evidence / changeset / package_version），所以一阶级联永远碰不到它；
    // 而它对 ontocode_package_versions 的外键是 RESTRICT。
    //
    // 后果：一个产出过候选包的 Session——也就是【一次成功 Build 之后】的
    // Session——根本删不掉，报的还是一句没有上下文的 FOREIGN KEY constraint
    // failed。库里今天 0 个候选包，所以这颗雷是哑的；第一次 Build 成功那天
    // 它就会响，而那恰好是最不该删不掉的时刻。
    const now = new Date();
    const second = (
      await success<{ session: { id: string } }>(
        await env.fetch("/v1/ontocode/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId,
            title: `${fixture.name} 已交付 Session`,
            goal: "Exercise the post-Build delete",
          }),
        }),
      )
    ).session.id;

    const ids = {
      pkg: `ocpv-restrict-${suffix}`,
      evidence: `ocev-restrict-${suffix}`,
      changeSet: `occs-restrict-${suffix}`,
      invalidation: `ocei-restrict-${suffix}`,
    };
    getDb()
      .insert(ontocodePackageVersions)
      .values({
        id: ids.pkg,
        tenantId: fixture.id,
        projectId,
        sessionId: second,
        ontologyHash: "oh",
        dependencyRoot: "root",
        artifactRefsJson: "[]",
        executionOwnersJson: "[]",
        status: "draft",
        validationJson: "{}",
        idempotencyKey: `${ids.pkg}-idem`,
        createdAt: now,
        updatedAt: now,
      } as typeof ontocodePackageVersions.$inferInsert)
      .run();
    getDb()
      .insert(ontocodeEvidenceRecords)
      .values({
        id: ids.evidence,
        tenantId: fixture.id,
        projectId,
        sessionId: second,
        kind: "sandbox",
        outcome: "passed",
        subjectType: "agent",
        subjectId: "a1",
        subjectDigest: "d1",
        dependencySetJson: "[]",
        validityPredicateJson: "{}",
        refsJson: "[]",
        summary: "s",
        producer: "p",
        idempotencyKey: `${ids.evidence}-idem`,
        createdAt: now,
      } as typeof ontocodeEvidenceRecords.$inferInsert)
      .run();
    getDb()
      .insert(ontocodeChangeSets)
      .values({
        id: ids.changeSet,
        tenantId: fixture.id,
        projectId,
        sessionId: second,
        status: "committed",
        summary: "s",
        baseOntologyHash: "oh",
        expectedSessionRevision: 1,
        idempotencyKey: `${ids.changeSet}-idem`,
        createdBy: "u",
        createdAt: now,
        updatedAt: now,
      } as typeof ontocodeChangeSets.$inferInsert)
      .run();
    getDb()
      .insert(ontocodeEvidenceInvalidations)
      .values({
        id: ids.invalidation,
        tenantId: fixture.id,
        evidenceId: ids.evidence,
        causedByChangeSetId: ids.changeSet,
        causedByPackageVersionId: ids.pkg,
        reason: "superseded",
        dependencyKeysJson: "[]",
        createdAt: now,
      } as typeof ontocodeEvidenceInvalidations.$inferInsert)
      .run();

    const response = await env.fetch(`/v1/ontocode/sessions/${second}`, {
      method: "DELETE",
      headers: bodylessHeaders,
    });
    // 修复前这里是 500 FOREIGN KEY constraint failed。
    expect(response.status).toBe(200);
    expect(
      getDb()
        .select({ id: ontocodeSessions.id })
        .from(ontocodeSessions)
        .where(eq(ontocodeSessions.id, second))
        .get(),
    ).toBeUndefined();
    // 那条够不着的行确实被扫掉了，没有留成孤儿。
    expect(
      getDb()
        .select({ id: ontocodeEvidenceInvalidations.id })
        .from(ontocodeEvidenceInvalidations)
        .where(eq(ontocodeEvidenceInvalidations.id, ids.invalidation))
        .get(),
    ).toBeUndefined();
  });

  it("a retry is idempotent — an already-removed target is not a failure", async () => {
    const record = getDb()
      .select({ id: ontocodeSessionPurges.id })
      .from(ontocodeSessionPurges)
      .where(eq(ontocodeSessionPurges.sessionId, sessionId))
      .get();
    const result = await success<{ status: string; failures: unknown[] }>(
      await env.fetch(
        `/v1/ontocode/session-purges/${record!.id}/retry`,
        { method: "POST", headers: bodylessHeaders },
      ),
    );
    expect(result.status).toBe("completed");
    expect(result.failures).toEqual([]);
  });
});
