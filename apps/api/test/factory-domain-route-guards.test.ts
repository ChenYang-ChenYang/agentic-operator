import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, tenants } from "@agentic/db";
import {
  factoryScopeRecommendationId,
  factorySourceOntologyHash,
} from "@agentic/agent-factory";
import { buildTestEnv, type TestEnv } from "./harness";
import {
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  FsUploadedOntologyStore,
  slugifyDomain,
} from "../src/services/agent-factory/uploaded-ontology-store";
import { DrizzleSkillStore } from "../src/services/agent-factory/stores";
import { getRun, makeFactoryPorts } from "../src/services/agent-factory";

const suffix = Date.now().toString(36);
const tenantId = `ten-factory-route-${suffix}`;
const tenantSlug = `factoryroute${suffix}`.slice(0, 60);
const headers = {
  "content-type": "application/json",
  "x-agentic-tenant": tenantSlug,
};
const store = new FsUploadedOntologyStore();

describe("Agent Factory route-level binding guards", () => {
  let env: TestEnv;
  const createdUploads = new Set<string>();

  beforeAll(async () => {
    process.env.AGENTIC_DEV_USER_EMAIL ??=
      "test-platform-admin@agentic.invalid";
    getDb()
      .insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "Factory route guard" })
      .run();
    env = await buildTestEnv();
  });

  afterAll(async () => {
    for (const id of createdUploads) await store.delete(tenantSlug, id);
    try {
      clearFactoryDomainBinding(tenantId);
    } catch {
      /* no active work should remain */
    }
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("does not let an upload with omitted domainId bypass rebind confirmation", async () => {
    setFactoryDomainBinding(tenantId, { id: `current-${suffix}` }, "explicit");
    const name = `Replacement ${suffix}`;
    const target = slugifyDomain(name);
    createdUploads.add(target);
    const body = {
      name,
      ontology: { actions: [{ name: "replace", actor: ["Agent"] }] },
    };

    const refused = await env.fetch("/v1/agent-factory/ontology-upload", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("confirm_rebind");
    expect(getFactoryDomainBinding(tenantId)?.ontologyDomainId).toBe(
      `current-${suffix}`,
    );
    expect(await store.get(tenantSlug, target)).toBeNull();

    const confirmed = await env.fetch("/v1/agent-factory/ontology-upload", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, confirmRebind: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(getFactoryDomainBinding(tenantId)?.ontologyDomainId).toBe(target);
    expect((await store.get(tenantSlug, target))?.domainId).toBe(target);
  });

  it("records exact uploaded catalog selections as upload provenance and never falls through", async () => {
    const domain = "raas"; // also exists in ManifestOntologySource: an intentional same-id overlay
    createdUploads.add(domain);
    await store.save(
      tenantSlug,
      "RAAS tenant override",
      {
        actions: [{ name: "tenantOnlyOverride", actor: ["Agent"] }],
      },
      domain,
    );
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "legacy auto match" },
      "auto",
    );

    const selected = await env.fetch("/v1/agent-factory/domain-binding", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ontologyDomainId: domain,
        confirmRebind: true,
      }),
    });
    expect(selected.status).toBe(200);
    expect(getFactoryDomainBinding(tenantId)).toMatchObject({
      ontologyDomainId: domain,
      source: "upload",
    });

    expect(await store.delete(tenantSlug, domain)).toBe(true);
    // A source=upload binding is strict. Even though the base manifest also has
    // `raas`, losing this tenant's overlay must not remap the bound identity.
    await expect(
      makeFactoryPorts(tenantSlug, tenantId, domain).ontology.fetchOntology(
        domain,
      ),
    ).rejects.toThrow(/上传的本体里找不到/);
  });

  it("requires explicit confirmation when the same domain id changes Ontology source", async () => {
    const domain = `repair-${suffix}`;
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "missing old upload" },
      "upload",
    );
    const oldBaseUrl = process.env.ALLMETA_BASE_URL;
    const oldApiKey = process.env.ALLMETA_API_KEY;
    process.env.ALLMETA_BASE_URL = "http://allmeta-binding-repair.test";
    delete process.env.ALLMETA_API_KEY;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/domains") {
          return new Response(
            JSON.stringify({
              domains: [{ id: domain, name: "Allmeta repair target" }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.pathname === "/api/v1/ontology/actions") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "live-action",
                  name: "liveAction",
                  actor: ["Agent"],
                  trigger: [],
                  triggered_event: [],
                  target_objects: [],
                  tool_use: [],
                  inputs: [],
                  outputs: [],
                  action_steps: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.pathname === "/api/v1/ontology/actions/live-action/steps") {
          return new Response(JSON.stringify({ action_steps: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          ["events", "objects", "rules", "links"].some(
            (resource) => url.pathname === `/api/v1/ontology/${resource}`,
          )
        ) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      });

    try {
      const refused = await env.fetch("/v1/agent-factory/domain-binding", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ontologyDomainId: domain, source: "allmeta" }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        error: { code: "confirm_rebind" },
      });
      expect(getFactoryDomainBinding(tenantId)).toMatchObject({
        ontologyDomainId: domain,
        source: "upload",
      });

      const repaired = await env.fetch("/v1/agent-factory/domain-binding", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ontologyDomainId: domain,
          source: "allmeta",
          confirmRebind: true,
        }),
      });
      expect(repaired.status).toBe(200);
      expect(getFactoryDomainBinding(tenantId)).toMatchObject({
        ontologyDomainId: domain,
        ontologyDomainName: "Allmeta repair target",
        source: "explicit",
      });
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (oldBaseUrl === undefined) delete process.env.ALLMETA_BASE_URL;
      else process.env.ALLMETA_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.ALLMETA_API_KEY;
      else process.env.ALLMETA_API_KEY = oldApiKey;
    }
  });

  it("keeps the Allmeta binding catalog visible while the runtime is bound to an upload", async () => {
    const uploadedDomain = `uploaded-current-${suffix}`;
    const allmetaDomain = `allmeta-target-${suffix}`;
    createdUploads.add(uploadedDomain);
    await store.save(
      tenantSlug,
      "Current uploaded ontology",
      {
        actions: [
          {
            name: "uploadedAction",
            actor: ["Agent"],
          },
        ],
      },
      uploadedDomain,
    );
    setFactoryDomainBinding(
      tenantId,
      { id: uploadedDomain, name: "Current uploaded ontology" },
      "upload",
    );

    const oldBaseUrl = process.env.ALLMETA_BASE_URL;
    const oldApiKey = process.env.ALLMETA_API_KEY;
    process.env.ALLMETA_BASE_URL = "http://allmeta-catalog.test";
    delete process.env.ALLMETA_API_KEY;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/domains") {
          return new Response(
            JSON.stringify({
              domains: [{ id: allmetaDomain, name: "Authoritative target" }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      });

    try {
      const response = await env.fetch("/v1/agent-factory/domains", {
        headers,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          domains: [
            {
              id: allmetaDomain,
              name: "Authoritative target",
              source: "allmeta",
            },
          ],
          binding: {
            ontologyDomainId: uploadedDomain,
            source: "upload",
          },
          boundDomain: {
            id: uploadedDomain,
            source: "upload",
          },
          boundActions: [{ name: "uploadedAction" }],
          catalogError: null,
        },
      });
    } finally {
      fetchSpy.mockRestore();
      if (oldBaseUrl === undefined) delete process.env.ALLMETA_BASE_URL;
      else process.env.ALLMETA_BASE_URL = oldBaseUrl;
      if (oldApiKey === undefined) delete process.env.ALLMETA_API_KEY;
      else process.env.ALLMETA_API_KEY = oldApiKey;
    }
  });

  it("lists and exports skills only through the tenant's exact bound ontology", async () => {
    const domain = `skills-${suffix}`;
    createdUploads.add(domain);
    await store.save(
      tenantSlug,
      "Skills ontology",
      { actions: [{ name: "skillAction", actor: ["Agent"] }] },
      domain,
    );
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "Skills ontology" },
      "upload",
    );
    await new DrizzleSkillStore(tenantId, domain).save({
      slug: `tenant-skill-${suffix}`,
      name: "Tenant skill",
      purpose: "Keep tenant/domain data isolated",
      promptFragment:
        "Always verify the owning tenant and exact ontology identity before reading reusable state.",
      tools: [],
      decisionRule: "Only use on an exact tenant and ontology match",
      domain,
    });

    const listed = await env.fetch(
      `/v1/agent-factory/skills?domain=${encodeURIComponent(domain)}`,
      { headers },
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      data: { skills: Array<{ slug: string }> };
    };
    expect(listedBody.data.skills.map((skill) => skill.slug)).toContain(
      `tenant-skill-${suffix}`,
    );

    const exported = await env.fetch(
      `/v1/agent-factory/skills/${encodeURIComponent(`tenant-skill-${suffix}`)}/export?domain=${encodeURIComponent(domain)}`,
      { headers },
    );
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain("Tenant skill");

    const mismatched = await env.fetch(
      `/v1/agent-factory/skills?domain=${encodeURIComponent(`other-${suffix}`)}`,
      { headers },
    );
    expect(mismatched.status).toBe(409);
  });

  it("starts with an untruncated JSON goal and reserves SSE GET for run-id attachment", async () => {
    const domain = `start-${suffix}`;
    createdUploads.add(domain);
    await store.save(
      tenantSlug,
      "Start transport ontology",
      {
        actions: [{ name: "inspectAttachedSpecification", actor: ["Agent"] }],
      },
      domain,
    );
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "Start transport ontology" },
      "upload",
    );

    const legacy = await env.fetch(
      `/v1/agent-factory/stream?domain=${encodeURIComponent(domain)}&goal=${encodeURIComponent("legacy query start")}`,
      { headers },
    );
    expect(legacy.status).toBe(400);
    expect(
      ((await legacy.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("stream_start_not_supported");

    // Well beyond the old UI's 3,000-character attachment slice and normal
    // browser URL limits.  The API must persist the exact JSON value it was
    // given rather than acknowledge a shortened goal.
    const goal = `请审查以下完整附件：\n${"真实附件行-0123456789\n".repeat(2_000)}`;
    const started = await env.fetch("/v1/agent-factory/runs/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ domain, goal }),
    });
    expect(started.status).toBe(202);
    const payload = (await started.json()) as {
      data: { runId: string; mode: string };
    };
    expect(payload.data.mode).toBe("started");
    expect(getRun(payload.data.runId, tenantId)?.goal).toBe(goal);

    const stopped = await env.fetch("/v1/agent-factory/stop", {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: payload.data.runId }),
    });
    // A live detached driver is cancelled cooperatively. The HTTP request can
    // only acknowledge that abort was requested; durable terminal state is
    // verified below, so 202 is the truthful contract (200 is reserved for an
    // orphan that was synchronously finalized in storage).
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({
      data: { aborted: true, finalized: false },
    });
    for (
      let attempt = 0;
      attempt < 200 &&
      getRun(payload.data.runId, tenantId)?.status === "running";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getRun(payload.data.runId, tenantId)?.status).not.toBe("running");
  });

  it("requires a server-issued Q&A recommendation before any structured Action start", async () => {
    const domain = `scope-${suffix}`;
    createdUploads.add(domain);
    await store.save(
      tenantSlug,
      "Scope recommendation ontology",
      {
        actions: [
          {
            id: "act-match",
            name: "matchResume",
            actor: ["Agent"],
            trigger: [],
            triggered_event: [],
            target_objects: [],
            tool_use: [],
          },
        ],
      },
      domain,
    );
    setFactoryDomainBinding(
      tenantId,
      { id: domain, name: "Scope recommendation ontology" },
      "upload",
    );

    const missing = await env.fetch("/v1/agent-factory/runs/start", {
      method: "POST",
      headers,
      body: JSON.stringify({
        domain,
        scenario: "筛选简历",
        actionIds: ["act-match"],
        interactionPolicy: "autopilot",
      }),
    });
    expect(missing.status).toBe(409);
    expect(
      ((await missing.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("scope_recommendation_required");

    const ontology = await makeFactoryPorts(
      tenantSlug,
      tenantId,
      domain,
    ).ontology.fetchOntology(domain);
    const ontologyHash = factorySourceOntologyHash(ontology);
    const forged = await env.fetch("/v1/agent-factory/runs/start", {
      method: "POST",
      headers,
      body: JSON.stringify({
        domain,
        scenario: "筛选简历",
        actionIds: [ontology.actions[0]!.id],
        recommendationId: factoryScopeRecommendationId({
          scopeKey: `${tenantId}\0${tenantSlug}`,
          domain,
          ontologyHash,
          scenario: "筛选简历",
        }),
        ontologyHash,
        interactionPolicy: "autopilot",
      }),
    });
    expect(forged.status).toBe(409);
    expect(
      ((await forged.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("scope_recommendation_stale");
  });
});
