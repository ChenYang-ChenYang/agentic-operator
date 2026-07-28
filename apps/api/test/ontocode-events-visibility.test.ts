// #HARNESS-TELEMETRY 的读取侧契约。
//
// 桥接层把大脑的推理与工具帧写进来之后，它们仍然一条也到不了前端，因为读取侧
// 有三个独立的坎，任何一个都足以让整条修复变成空转：
//
//   1. visibility 曾是【精确匹配】。要 debug 就只返回 debug，永远拿不到与之
//      交织的 user 行——也就是任何档位都取不到一条完整有序的轨迹；而前端不带
//      这个参数（默认 user），于是「显示全部」筛的列表里根本没有非 user 事件。
//   2. 非 user 档位曾要 audit.read（admin 独占），admin 以下的人推理面板必空。
//      —— 这一条本文件测不到（测试环境不开鉴权），只经人工复核，见下方注释。
//   3. 前端取事件是「limit=200、忽略 hasMore」。事件按 seq 升序，超过 200 条
//      看到的永远是最早的 200 条——恰好把结论丢在视野外。一次真实 Build 就能
//      写几百条。
//
// 这三条在这里各锁一条。
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, ontocodeSessionEvents, tenants } from "@agentic/db";
import { setFactoryDomainBinding } from "../src/services/agent-factory/domain-binding";
import { buildTestEnv, type TestEnv } from "./harness";
import { installOntoCodeTestOntology } from "./ontocode-ontology-fixture";

async function success<T>(response: Response): Promise<T> {
  return ((await response.json()) as { ok: true; data: T }).data;
}

describe("OntoCode session events — visibility floor and paging", () => {
  let env: TestEnv;
  const suffix = randomUUID().slice(0, 8);
  const fixture = {
    id: `ten-oc-vis-${suffix}`,
    slug: `ocvis${suffix}`,
    name: "OntoCode event visibility",
    domain: `Visibility-${suffix}`,
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
    const project = await success<{ project: { id: string } }>(
      await env.fetch("/v1/ontocode/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({
          domain: fixture.domain,
          name: `${fixture.name} Project`,
        }),
      }),
    );
    projectId = project.project.id;
    const session = await success<{ session: { id: string } }>(
      await env.fetch("/v1/ontocode/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId,
          title: `${fixture.name} Session`,
          goal: "Exercise the event read path",
        }),
      }),
    );
    sessionId = session.session.id;

    // 交织写入：一条 user、一条 debug，共 240 条 user + 60 条 debug。
    // 只有跨越 200 的量才能暴露「忽略 hasMore」这个坑。
    const now = Date.now();
    const rows: Array<typeof ontocodeSessionEvents.$inferInsert> = [];
    const existing = getDb()
      .select({ seq: ontocodeSessionEvents.seq })
      .from(ontocodeSessionEvents)
      .where(eq(ontocodeSessionEvents.sessionId, sessionId))
      .all();
    let seq = existing.reduce((max, row) => Math.max(max, row.seq), 0);
    for (let i = 0; i < 240; i += 1) {
      seq += 1;
      rows.push({
        id: `oce-vis-u-${suffix}-${i}`,
        tenantId: fixture.id,
        projectId,
        sessionId,
        seq,
        type: "harness.build.stage",
        visibility: "user",
        payloadJson: JSON.stringify({ n: i }),
        correlationId: `cor-${suffix}`,
        createdAt: new Date(now + seq),
      });
      if (i % 4 === 0) {
        seq += 1;
        rows.push({
          id: `oce-vis-d-${suffix}-${i}`,
          tenantId: fixture.id,
          projectId,
          sessionId,
          seq,
          type: "harness.build.thinking",
          visibility: "debug",
          payloadJson: JSON.stringify({ n: i }),
          correlationId: `cor-${suffix}`,
          createdAt: new Date(now + seq),
        });
      }
    }
    getDb().insert(ontocodeSessionEvents).values(rows).run();
  });

  afterAll(async () => {
    await removeOntology();
    getDb().delete(tenants).where(eq(tenants.id, fixture.id)).run();
    await env.cleanup();
  });

  async function page(visibility: string, after: number, limit = 500) {
    return success<{
      items: Array<{ seq: number; visibility: string; type: string }>;
      lastSeq: number;
      hasMore: boolean;
    }>(
      await env.fetch(
        `/v1/ontocode/sessions/${sessionId}/events?visibility=${visibility}&after=${after}&limit=${limit}`,
        { headers },
      ),
    );
  }

  it("treats visibility as a floor: debug returns user rows interleaved, not debug alone", async () => {
    const debug = await page("debug", 0);
    const kinds = new Set(debug.items.map((item) => item.visibility));
    expect(kinds).toContain("debug");
    // 这一条是修复前必然失败的：精确匹配下 user 行一条都不会出现。
    expect(kinds).toContain("user");

    const user = await page("user", 0);
    expect(new Set(user.items.map((item) => item.visibility))).toEqual(
      new Set(["user"]),
    );
    expect(debug.items.length).toBeGreaterThan(user.items.length);

    // 顺序仍然是全局 seq 升序，交织在一起——否则拿不到一条可读的轨迹。
    const seqs = debug.items.map((item) => item.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("serves visibility=debug on the ordinary workspace path", async () => {
    // 注意这条【测不到】RBAC 差异：本测试环境不开鉴权（AUTH_MODE 未设时
    // 权限检查一律放行），所以它证明不了「admin 以下也能看」。路由的权限
    // 选择（audit 档位保留 audit.read，其余按 workflows.read）只经人工复核。
    // 这条守的是另一件事：debug 档位不会被整体拒掉。
    const response = await env.fetch(
      `/v1/ontocode/sessions/${sessionId}/events?visibility=debug&limit=5`,
      { headers },
    );
    expect(response.status).toBe(200);
  });

  it("pages past the first window instead of silently showing only the earliest rows", async () => {
    // 修复前：取前 200 条、忽略 hasMore。事件升序，于是结论永远在视野外。
    const first = await page("user", 0, 200);
    expect(first.items).toHaveLength(200);
    expect(first.hasMore).toBe(true);

    const rest = await page("user", first.lastSeq, 200);
    expect(rest.items.length).toBeGreaterThan(0);
    expect(rest.items[0]!.seq).toBeGreaterThan(first.lastSeq);
    expect(first.items.length + rest.items.length).toBeGreaterThanOrEqual(240);
  });
});
