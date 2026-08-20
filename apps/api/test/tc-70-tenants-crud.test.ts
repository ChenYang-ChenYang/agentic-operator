/**
 * TC-50 — Tenant CRUD happy paths (P5-TEN-01).
 *
 * Exercises every route in `apps/api/src/routes/v1/tenants.ts`:
 *
 *   POST   /v1/tenants                — create an empty tenant + token
 *   POST   /v1/tenants                — duplicate slug → 409
 *   GET    /v1/tenants                — list excludes archived by default
 *   GET    /v1/tenants/:slug          — detail with budgets + counts
 *   PUT    /v1/tenants/:slug          — name/subtitle/color update (audit logged)
 *   PUT    /v1/tenants/:slug          — slug field rejected by .strict()
 *   DELETE /v1/tenants/:slug          — confirm mismatch → 400
 *   DELETE /v1/tenants/:slug          — happy archive → 200 + archivedAt set
 *   GET    /v1/tenants                — archived row hidden
 *   GET    /v1/tenants?include_archived=1 — archived row visible
 *   POST   /v1/tenants/:slug/restore  — clears archivedAt
 *
 * Slug uses a per-test-run suffix so re-runs against the dev DB don't collide.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  getDb,
  isTenantInngestDeploymentEnabled,
  tenantBudgets,
  tenants,
} from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `t50${Date.now().toString(36)}`.toLowerCase().slice(0, 12);
const SLUG = `crud-${SUFFIX}`;

describe("TC-50: tenant CRUD", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  afterAll(async () => {
    // Cleanup: drop everything we created so re-runs are idempotent.
    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(like(tenants.slug, `${SLUG}%`))
      .all()[0];
    if (row) {
      db.delete(apiTokens).where(eq(apiTokens.tenantId, row.id)).run();
      db.delete(tenantBudgets).where(eq(tenantBudgets.tenantId, row.id)).run();
      db.delete(auditLog).where(eq(auditLog.tenantId, row.id)).run();
      db.delete(tenants).where(eq(tenants.id, row.id)).run();
    }
  });

  it("POST /v1/tenants — creates row + bootstrap token + audit", async () => {
    const res = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: SLUG,
        name: "Crud Test Tenant",
        subtitle: "tc-50",
        color: "#5deeff",
        starter: "empty",
        mintToken: true,
        budget: { monthlyTokenCap: 1000, monthlyUsdCap: 250 },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.tenant.slug).toBe(SLUG);
    expect(body.data.tenant.name).toBe("Crud Test Tenant");
    expect(body.data.tenant.color).toBe("#5deeff");
    expect(body.data.tenant.archivedAt).toBeNull();
    expect(body.data.tenant.inngestEnabled).toBe(false);
    expect(body.data.tenant.inngestProcessScoped).toBe(true);
    expect(body.data.token).not.toBeNull();
    expect(body.data.token.plaintext).toMatch(/^agentic_/);
    expect(body.data.starter).toBeNull();

    // Verify the DB rows landed.
    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, SLUG))
      .all()[0];
    expect(row).toBeDefined();
    expect(row!.archivedAt).toBeNull();
    expect(isTenantInngestDeploymentEnabled(row!.id)).toBe(false);

    const budget = db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, row!.id))
      .all()[0];
    expect(budget).toBeDefined();
    expect(budget!.monthlyTokenCap).toBe(1000);

    const audits = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, row!.id),
          eq(auditLog.action, "tenant.create"),
        ),
      )
      .all();
    expect(audits.length).toBe(1);
  });

  it("POST /v1/tenants — duplicate slug → 409 slug_taken", async () => {
    const res = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: SLUG,
        name: "Duplicate",
        starter: "empty",
        mintToken: false,
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("slug_taken");
  });

  it("POST /v1/tenants — rejects removed sample starters", async () => {
    const res = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: `${SLUG}-sample`,
        name: "No Sample Runtime",
        starter: "hello",
        mintToken: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
  });

  it("POST /v1/tenants — reserved slug → 400 reserved_slug", async () => {
    const res = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "admin",
        name: "Should Fail",
        starter: "empty",
        mintToken: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Zod superRefine catches it first; the explicit reserved_slug branch is
    // a defense-in-depth backstop. Either code is acceptable here.
    expect(["invalid_input", "reserved_slug"]).toContain(body.error.code);
  });

  it("POST /v1/tenants — malformed slug → 400", async () => {
    const res = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "Has-UpperCase",
        name: "Bad Slug",
        starter: "empty",
        mintToken: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
  });

  it("GET /v1/tenants — list includes the new tenant", async () => {
    const res = await env.fetch("/v1/tenants");
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.items.find((t: { slug: string }) => t.slug === SLUG);
    expect(row).toBeDefined();
    expect(row.agentCount).toBe(0);
    expect(row.openTasks).toBe(0);
    expect(row.inngestEnabled).toBe(false);
    expect(row.inngestProcessScoped).toBe(true);
  });

  it("GET /v1/tenants/:slug — detail with budget rollup", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.slug).toBe(SLUG);
    expect(body.data.budgets).not.toBeNull();
    expect(body.data.budgets.monthlyTokenCap).toBe(1000);
    expect(body.data.workflowCount).toBe(0);
    expect(body.data.deploymentLiveCount).toBe(0);
  });

  it("PUT /v1/tenants/:slug/inngest-deployment — selects and stops this tenant", async () => {
    const deploy = await env.fetch(`/v1/tenants/${SLUG}/inngest-deployment`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(deploy.status).toBe(200);
    const deployed = await deploy.json();
    expect(deployed.data).toMatchObject({
      slug: SLUG,
      enabled: true,
      changed: true,
      functionCount: 0,
      status: "empty",
      brokerVerified: true,
    });
    const tenantId = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, SLUG))
      .all()[0]!.id;
    expect(isTenantInngestDeploymentEnabled(tenantId)).toBe(true);

    const stop = await env.fetch(`/v1/tenants/${SLUG}/inngest-deployment`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(stop.status).toBe(200);
    const stopped = await stop.json();
    expect(stopped.data).toMatchObject({
      slug: SLUG,
      enabled: false,
      changed: true,
      functionCount: 0,
      status: "stopped",
      brokerVerified: true,
    });

    const actions = getDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        eq(
          auditLog.tenantId,
          getDb()
            .select({ id: tenants.id })
            .from(tenants)
            .where(eq(tenants.slug, SLUG))
            .all()[0]!.id,
        ),
      )
      .all()
      .map((row) => row.action);
    expect(actions).toContain("tenant.inngest.deploy");
    expect(actions).toContain("tenant.inngest.stop");
  });

  it("PUT /v1/tenants/:slug/inngest-deployment — removes and restores a real manifest function set", async () => {
    const stop = await env.fetch("/v1/tenants/raas/inngest-deployment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(stop.status).toBe(200);
    expect((await stop.json()).data).toMatchObject({
      slug: "raas",
      enabled: false,
      functionCount: 0,
      status: "stopped",
      brokerVerified: true,
    });

    const deploy = await env.fetch("/v1/tenants/raas/inngest-deployment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(deploy.status).toBe(200);
    const data = (await deploy.json()).data;
    expect(data).toMatchObject({
      slug: "raas",
      enabled: true,
      status: "deployed",
      brokerVerified: true,
    });
    expect(data.functionCount).toBeGreaterThan(0);
  });

  it("PUT /v1/tenants/:slug — name/color update writes audit row", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Tenant",
        color: "#ffb547",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("Renamed Tenant");
    expect(body.data.color).toBe("#ffb547");

    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, SLUG))
      .all()[0];
    const audits = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, row!.id),
          eq(auditLog.action, "tenant.update"),
        ),
      )
      .all();
    expect(audits.length).toBe(1);
  });

  it("PUT /v1/tenants/:slug — rejects slug field (.strict)", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "another-slug" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
  });

  it("DELETE /v1/tenants/:slug — confirm mismatch → 400", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "wrong-slug" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("confirm_mismatch");
  });

  it("DELETE /v1/tenants/:slug — confirm match → archive", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: SLUG, reason: "tc-50 cleanup test" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.slug).toBe(SLUG);
    expect(typeof body.data.archivedAt).toBe("number");

    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, SLUG))
      .all()[0];
    expect(row!.archivedAt).not.toBeNull();
  });

  it("GET /v1/tenants — archived row hidden by default", async () => {
    const res = await env.fetch("/v1/tenants");
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.items.find((t: { slug: string }) => t.slug === SLUG);
    expect(row).toBeUndefined();
  });

  it("GET /v1/tenants?include_archived=1 — archived row visible", async () => {
    const res = await env.fetch("/v1/tenants?include_archived=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.items.find((t: { slug: string }) => t.slug === SLUG);
    expect(row).toBeDefined();
    expect(row.archivedAt).not.toBeNull();
  });

  it("DELETE /v1/tenants/:slug — second archive on archived → 409", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: SLUG }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("already_archived");
  });

  it("POST /v1/tenants/:slug/restore — clears archivedAt + audit", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.archivedAt).toBeNull();
    expect(body.data.inngestEnabled).toBe(false);

    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, SLUG))
      .all()[0];
    expect(row!.archivedAt).toBeNull();

    const audits = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, row!.id),
          eq(auditLog.action, "tenant.restore"),
        ),
      )
      .all();
    expect(audits.length).toBe(1);
  });

  it("GET /v1/tenants/:slug — unknown slug → 404", async () => {
    const res = await env.fetch("/v1/tenants/does-not-exist-xyz");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("tenant_not_found");
  });

  it("DELETE /v1/tenants/__system — system tenant cannot be archived", async () => {
    const res = await env.fetch("/v1/tenants/__system", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "__system" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("cannot_archive_system");
  });
});
