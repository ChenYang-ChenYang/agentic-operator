import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  businessOntologyDomains,
  factoryDomainBindings,
  getDb,
  ontocodeProjects,
  ontocodeSessions,
  runtimeProfiles,
  runtimeProfileVersions,
  tenantRuntimeNamespaces,
  tenants,
} from "@agentic/db";
import { createRuntimeProfile } from "../src/services/runtime-profile-store";
import { bindBusinessOntologyDomainRuntimeProfile } from "../src/services/business-ontology-domain-store";
import { buildTestEnv, type TestEnv } from "./harness";
import { installOntoCodeTestOntology } from "./ontocode-ontology-fixture";

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    details?: Record<string, unknown>;
  };
}

interface DomainRegistration {
  id: string;
  tenantId: string;
  ontologyDomainId: string;
  source: "allmeta" | "upload" | "manifest_legacy";
  status: "active" | "unavailable" | "archived";
  isDefault: boolean;
  archivedAt: number | null;
}

interface RegisteredOntologyReceipt {
  registration: DomainRegistration;
  ontology: {
    domainId: string;
    authoritativeSource: "allmeta" | "upload";
    normalizedSource: "allmeta" | "snapshot";
    snapshotHash: string;
    registeredSnapshotHash: string | null;
    snapshotMatchesRegistration: boolean;
    counts: {
      actions: number;
      events: number;
      objects: number;
      rules: number;
      links: number;
      workflow: number;
    };
    actions: Array<{
      id: string;
      name: string;
      actor: string[];
    }>;
    fetchedAt: number;
  };
}

async function success<T>(response: Response): Promise<T> {
  return ((await response.json()) as SuccessEnvelope<T>).data;
}

async function failure(response: Response): Promise<ErrorEnvelope["error"]> {
  return ((await response.json()) as ErrorEnvelope).error;
}

describe("Business Domain Ontology registry and OntoCode lineage", () => {
  let env: TestEnv;
  const suffix = randomUUID().slice(0, 8);
  const raasDomain = `RAAS-v1-${suffix}`;
  const agentsDomain = `Agents-generation-${suffix}`;
  const tenantsUnderTest = [
    {
      id: `ten-business-domain-a-${suffix}`,
      slug: `business-domain-a-${suffix}`,
      name: "Recruitment",
    },
    {
      id: `ten-business-domain-b-${suffix}`,
      slug: `business-domain-b-${suffix}`,
      name: "Energy",
    },
  ] as const;
  // Runtime Profile 的 tenant_registry_compat 适配器需要一个真实的租户注册表，
  // 而一个兼容命名空间只能归属一个 Business Domain——所以每个受测租户各配一个。
  const compatTenants = tenantsUnderTest.map((tenant, index) => ({
    id: `ten-bod-compat-${index}-${suffix}`,
    slug: `bod-compat-${index}-${suffix}`,
    name: `${tenant.name} compatibility registry`,
  }));
  const runtimeProfileVersionByTenant = new Map<string, string>();
  const headers = (tenantSlug: string) => ({
    "content-type": "application/json",
    "x-agentic-tenant": tenantSlug,
  });
  const removeOntologies: Array<() => Promise<void>> = [];
  const previousAllmetaBaseUrl = process.env.ALLMETA_BASE_URL;
  const previousAllmetaApiKey = process.env.ALLMETA_API_KEY;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.ALLMETA_BASE_URL = "http://allmeta-business-domain.test";
    delete process.env.ALLMETA_API_KEY;
    getDb()
      .insert(tenants)
      .values([...tenantsUnderTest, ...compatTenants])
      .run();

    // 新注册的 Ontology 域一律被标为 profile_pinned 且运行时档案版本为空
    // （business-ontology-domain-store.ts 的默认），于是在绑定一个不可变的
    // Runtime Profile 版本之前，创建 OntoCode 项目会被 409
    // ontocode_runtime_profile_required 挡住。这是产品的既定交接：
    // executionReadiness 会报 configuration_required，另有专门的绑定路由与
    // 前端流程。所以这里按真实使用顺序补上绑定，而不是放宽那道门。
    for (const [index, tenant] of tenantsUnderTest.entries()) {
      const compat = compatTenants[index]!;
      runtimeProfileVersionByTenant.set(
        tenant.slug,
        createRuntimeProfile(
          { tenantId: tenant.id, tenantSlug: tenant.slug, actorId: "usr-bod-test" },
          {
            name: `${tenant.name} compatibility`,
            adapter: {
              kind: "tenant_registry_compat",
              adapterRegistrySlug: compat.slug,
              adapterRegistryVersion: "0.1.0",
              eventNamespace: compat.slug,
              compatibilityTenantSlug: compat.slug,
            },
          },
        ).version.id,
      );
    }

    for (const tenant of tenantsUnderTest) {
      const raas = await installOntoCodeTestOntology({
        tenantSlug: tenant.slug,
        domainId: raasDomain,
        name: "RAAS upload",
        actionName: "scoreCandidate",
      });
      removeOntologies.push(raas.remove);
    }
    const agentsUpload = await installOntoCodeTestOntology({
      tenantSlug: tenantsUnderTest[0].slug,
      domainId: agentsDomain,
      name: "Agents generation upload",
      actionName: "generateAgent",
    });
    removeOntologies.push(agentsUpload.remove);

    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.origin !== "http://allmeta-business-domain.test") {
          throw new Error(
            `unexpected external request in test: ${url.toString()}`,
          );
        }
        if (url.pathname === "/api/domains") {
          return new Response(
            JSON.stringify({
              domains: [
                { id: raasDomain, name: "RAAS Allmeta" },
                { id: agentsDomain, name: "Agents generation Allmeta" },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const requestedDomain = url.searchParams.get("domain");
        if (url.pathname.startsWith("/api/v1/ontology/")) {
          if (
            requestedDomain !== raasDomain &&
            requestedDomain !== agentsDomain
          ) {
            return new Response("unknown domain", { status: 404 });
          }
        }
        if (url.pathname === "/api/v1/ontology/actions") {
          const actionId =
            requestedDomain === raasDomain
              ? "allmeta-score"
              : "allmeta-generate";
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: actionId,
                  name:
                    requestedDomain === raasDomain
                      ? "scoreCandidate"
                      : "generateAgent",
                  actor: ["Agent"],
                  trigger: [],
                  triggered_event: [],
                  target_objects: [],
                  tool_use: [],
                  inputs: [],
                  outputs: [],
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.pathname === "/api/v1/ontology/actions/allmeta-score/steps" ||
          url.pathname === "/api/v1/ontology/actions/allmeta-generate/steps"
        ) {
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

    env = await buildTestEnv();
  });

  afterAll(async () => {
    await Promise.all(removeOntologies.map((remove) => remove()));
    // Runtime Profile 这条链上有三处 RESTRICT（版本→档案、版本→兼容租户、
    // 命名空间→归属租户），所以拆除顺序是固定的：域注册 → 档案版本 → 档案 →
    // 命名空间 → 租户。顺序错了就撞外键。
    for (const tenant of tenantsUnderTest) {
      getDb()
        .delete(businessOntologyDomains)
        .where(eq(businessOntologyDomains.tenantId, tenant.id))
        .run();
      getDb()
        .delete(runtimeProfileVersions)
        .where(eq(runtimeProfileVersions.tenantId, tenant.id))
        .run();
      getDb()
        .delete(runtimeProfiles)
        .where(eq(runtimeProfiles.tenantId, tenant.id))
        .run();
      getDb()
        .delete(tenantRuntimeNamespaces)
        .where(eq(tenantRuntimeNamespaces.businessDomainTenantId, tenant.id))
        .run();
    }
    for (const tenant of [...tenantsUnderTest, ...compatTenants]) {
      getDb().delete(tenants).where(eq(tenants.id, tenant.id)).run();
    }
    fetchSpy.mockRestore();
    if (previousAllmetaBaseUrl === undefined) {
      delete process.env.ALLMETA_BASE_URL;
    } else {
      process.env.ALLMETA_BASE_URL = previousAllmetaBaseUrl;
    }
    if (previousAllmetaApiKey === undefined) {
      delete process.env.ALLMETA_API_KEY;
    } else {
      process.env.ALLMETA_API_KEY = previousAllmetaApiKey;
    }
    await env.cleanup();
  });

  const register = async (
    tenantSlug: string,
    ontologyDomainId: string,
    source: "allmeta" | "upload",
    makeDefault = false,
  ) => {
    const response = await env.fetch("/v1/business-ontology-domains", {
      method: "POST",
      headers: headers(tenantSlug),
      body: JSON.stringify({
        ontologyDomainId,
        source,
        makeDefault,
      }),
    });
    expect(response.status).toBe(201);
    const receipt = await success<{
      domain: DomainRegistration;
      mode: "created";
    }>(response);
    // 注册即绑定运行时档案——与真实使用顺序一致（注册 → 绑定 → 才能建项目）。
    const versionId = runtimeProfileVersionByTenant.get(tenantSlug);
    const tenant = tenantsUnderTest.find((t) => t.slug === tenantSlug);
    if (versionId && tenant) {
      bindBusinessOntologyDomainRuntimeProfile(
        { tenantId: tenant.id, tenantSlug, actorId: "usr-bod-test" },
        receipt.domain.id,
        versionId,
      );
    }
    return receipt;
  };

  const createProject = async (
    tenantSlug: string,
    registration: DomainRegistration,
    name: string,
  ) => {
    const response = await env.fetch("/v1/ontocode/projects", {
      method: "POST",
      headers: headers(tenantSlug),
      body: JSON.stringify({
        domain: registration.ontologyDomainId,
        ontologyDomainRegistrationId: registration.id,
        name,
      }),
    });
    expect(response.status).toBe(201);
    return success<{
      project: {
        id: string;
        domain: string;
        ontologyDomainRegistrationId: string;
      };
      mode: "created";
    }>(response);
  };

  const createSession = async (
    tenantSlug: string,
    projectId: string,
    title: string,
  ) => {
    const response = await env.fetch("/v1/ontocode/sessions", {
      method: "POST",
      headers: headers(tenantSlug),
      body: JSON.stringify({
        projectId,
        title,
        goal: `Exercise the exact registered Ontology lineage for ${title}`,
      }),
    });
    expect(response.status).toBe(201);
    return success<{
      session: { id: string; projectId: string; ontologySnapshotHash: string };
      event: { payload: Record<string, unknown> };
    }>(response);
  };

  it("registers multiple exact Ontology Domains under one Business Domain and uses each in OntoCode", async () => {
    const raasUpload = await register(
      tenantsUnderTest[0].slug,
      raasDomain,
      "upload",
      true,
    );
    const agentsAllmeta = await register(
      tenantsUnderTest[0].slug,
      agentsDomain,
      "allmeta",
    );
    const agentsUpload = await register(
      tenantsUnderTest[0].slug,
      agentsDomain,
      "upload",
    );

    expect(fetchSpy).toHaveBeenCalled();
    const listed = await env.fetch("/v1/business-ontology-domains", {
      headers: headers(tenantsUnderTest[0].slug),
    });
    expect(listed.status).toBe(200);
    const listReceipt = await success<{
      items: DomainRegistration[];
      count: number;
    }>(listed);
    expect(listReceipt.count).toBe(3);
    expect(
      listReceipt.items.map((item) => [item.ontologyDomainId, item.source]),
    ).toEqual(
      expect.arrayContaining([
        [raasDomain, "upload"],
        [agentsDomain, "allmeta"],
        [agentsDomain, "upload"],
      ]),
    );

    const ambiguous = await env.fetch("/v1/ontocode/projects", {
      method: "POST",
      headers: headers(tenantsUnderTest[0].slug),
      body: JSON.stringify({
        domain: agentsDomain,
        name: "An external id alone must not choose a source",
      }),
    });
    expect(ambiguous.status).toBe(409);
    expect(await failure(ambiguous)).toMatchObject({
      code: "ontocode_ontology_domain_source_ambiguous",
      details: {
        requestedDomain: agentsDomain,
        registrationIds: expect.arrayContaining([
          agentsAllmeta.domain.id,
          agentsUpload.domain.id,
        ]),
      },
    });

    const raasProject = await createProject(
      tenantsUnderTest[0].slug,
      raasUpload.domain,
      "RAAS scoring",
    );
    const agentsAllmetaProject = await createProject(
      tenantsUnderTest[0].slug,
      agentsAllmeta.domain,
      "Allmeta agent generation",
    );
    const agentsUploadProject = await createProject(
      tenantsUnderTest[0].slug,
      agentsUpload.domain,
      "Uploaded agent generation",
    );
    expect(
      new Set([
        raasProject.project.id,
        agentsAllmetaProject.project.id,
        agentsUploadProject.project.id,
      ]).size,
    ).toBe(3);
    expect(agentsAllmetaProject.project).toMatchObject({
      domain: agentsDomain,
      ontologyDomainRegistrationId: agentsAllmeta.domain.id,
    });
    expect(agentsUploadProject.project).toMatchObject({
      domain: agentsDomain,
      ontologyDomainRegistrationId: agentsUpload.domain.id,
    });

    const raasSession = await createSession(
      tenantsUnderTest[0].slug,
      raasProject.project.id,
      "RAAS-v1 candidate scoring",
    );
    const agentsSession = await createSession(
      tenantsUnderTest[0].slug,
      agentsAllmetaProject.project.id,
      "Allmeta agent generation",
    );
    expect(raasSession.event.payload).toMatchObject({
      ontologyDomainRegistrationId: raasUpload.domain.id,
      ontologyDomainId: raasDomain,
    });
    expect(agentsSession.event.payload).toMatchObject({
      ontologyDomainRegistrationId: agentsAllmeta.domain.id,
      ontologyDomainId: agentsDomain,
    });

    // The old Factory singleton is only a default pointer. An out-of-band
    // change must not invalidate a Project/Session pinned to its registration.
    getDb()
      .update(factoryDomainBindings)
      .set({
        ontologyDomainId: agentsDomain,
        ontologyDomainName: "Legacy default changed",
        source: "explicit",
        updatedAt: new Date(),
      })
      .where(eq(factoryDomainBindings.tenantId, tenantsUnderTest[0].id))
      .run();
    const secondRaasSession = await createSession(
      tenantsUnderTest[0].slug,
      raasProject.project.id,
      "RAAS remains pinned after default change",
    );
    expect(secondRaasSession.event.payload).toMatchObject({
      ontologyDomainRegistrationId: raasUpload.domain.id,
      ontologyDomainId: raasDomain,
    });
  });

  it("reads actions through the exact registration source and enforces tenant and status gates", async () => {
    const registrations = getDb()
      .select()
      .from(businessOntologyDomains)
      .where(eq(businessOntologyDomains.tenantId, tenantsUnderTest[0].id))
      .all();
    const allmeta = registrations.find(
      (item) =>
        item.ontologyDomainId === agentsDomain && item.source === "allmeta",
    );
    const upload = registrations.find(
      (item) =>
        item.ontologyDomainId === agentsDomain && item.source === "upload",
    );
    if (!allmeta || !upload) {
      throw new Error("same-id Allmeta/upload registrations are missing");
    }

    const allmetaResponse = await env.fetch(
      `/v1/business-ontology-domains/${allmeta.id}/ontology`,
      { headers: headers(tenantsUnderTest[0].slug) },
    );
    expect(allmetaResponse.status).toBe(200);
    expect(allmetaResponse.headers.get("cache-control")).toBe("no-store");
    const allmetaReceipt =
      await success<RegisteredOntologyReceipt>(allmetaResponse);
    expect(allmetaReceipt).toMatchObject({
      registration: {
        id: allmeta.id,
        ontologyDomainId: agentsDomain,
        source: "allmeta",
      },
      ontology: {
        domainId: agentsDomain,
        authoritativeSource: "allmeta",
        normalizedSource: "allmeta",
        registeredSnapshotHash: allmeta.ontologySnapshotHash,
        snapshotMatchesRegistration: true,
        counts: { actions: 1 },
        actions: [
          {
            id: "allmeta-generate",
            name: "generateAgent",
            actor: ["Agent"],
          },
        ],
      },
    });

    const uploadResponse = await env.fetch(
      `/v1/business-ontology-domains/${upload.id}/ontology`,
      { headers: headers(tenantsUnderTest[0].slug) },
    );
    expect(uploadResponse.status).toBe(200);
    const uploadReceipt =
      await success<RegisteredOntologyReceipt>(uploadResponse);
    expect(uploadReceipt).toMatchObject({
      registration: {
        id: upload.id,
        ontologyDomainId: agentsDomain,
        source: "upload",
      },
      ontology: {
        domainId: agentsDomain,
        authoritativeSource: "upload",
        normalizedSource: "snapshot",
        registeredSnapshotHash: upload.ontologySnapshotHash,
        snapshotMatchesRegistration: true,
        counts: { actions: 1 },
        actions: [
          {
            id: `action-${agentsDomain}`,
            name: "generateAgent",
            actor: ["Agent"],
          },
        ],
      },
    });
    expect(uploadReceipt.ontology.actions[0]?.id).not.toBe(
      allmetaReceipt.ontology.actions[0]?.id,
    );

    const crossTenant = await env.fetch(
      `/v1/business-ontology-domains/${allmeta.id}/ontology`,
      { headers: headers(tenantsUnderTest[1].slug) },
    );
    expect(crossTenant.status).toBe(404);
    expect(await failure(crossTenant)).toMatchObject({
      code: "business_ontology_domain_not_found",
      details: { registrationId: allmeta.id },
    });

    getDb()
      .update(businessOntologyDomains)
      .set({
        status: "unavailable",
        isDefault: false,
        lastError: "test-only source outage",
        updatedAt: new Date(),
      })
      .where(eq(businessOntologyDomains.id, allmeta.id))
      .run();
    const unavailable = await env.fetch(
      `/v1/business-ontology-domains/${allmeta.id}/ontology`,
      { headers: headers(tenantsUnderTest[0].slug) },
    );
    expect(unavailable.status).toBe(409);
    expect(await failure(unavailable)).toMatchObject({
      code: "business_ontology_domain_inactive",
      details: {
        registrationId: allmeta.id,
        ontologyDomainId: agentsDomain,
        status: "unavailable",
      },
    });
    getDb()
      .update(businessOntologyDomains)
      .set({
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(businessOntologyDomains.id, allmeta.id))
      .run();
  });

  it("rejects a registration owned by another Business Domain", async () => {
    const tenantARegistration = getDb()
      .select()
      .from(businessOntologyDomains)
      .where(
        and(
          eq(businessOntologyDomains.tenantId, tenantsUnderTest[0].id),
          eq(businessOntologyDomains.ontologyDomainId, raasDomain),
          eq(businessOntologyDomains.source, "upload"),
        ),
      )
      .get();
    if (!tenantARegistration)
      throw new Error("tenant A RAAS registration missing");

    const tenantBRegistration = await register(
      tenantsUnderTest[1].slug,
      raasDomain,
      "upload",
      true,
    );
    expect(tenantBRegistration.domain.id).not.toBe(tenantARegistration.id);

    const response = await env.fetch("/v1/ontocode/projects", {
      method: "POST",
      headers: headers(tenantsUnderTest[1].slug),
      body: JSON.stringify({
        domain: raasDomain,
        ontologyDomainRegistrationId: tenantARegistration.id,
        name: "Cross-Business-Domain lineage",
      }),
    });
    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({
      code: "ontocode_ontology_domain_registration_required",
      details: {
        requestedDomain: raasDomain,
        registrationId: tenantARegistration.id,
      },
    });
    expect(
      getDb()
        .select()
        .from(ontocodeProjects)
        .where(eq(ontocodeProjects.tenantId, tenantsUnderTest[1].id))
        .all(),
    ).toHaveLength(0);
  });

  it("blocks archiving an in-use registration, retains history, and archives an unused source association", async () => {
    const registrations = getDb()
      .select()
      .from(businessOntologyDomains)
      .where(eq(businessOntologyDomains.tenantId, tenantsUnderTest[0].id))
      .all();
    const raas = registrations.find(
      (item) =>
        item.ontologyDomainId === raasDomain && item.source === "upload",
    );
    const unused = registrations.find(
      (item) =>
        item.ontologyDomainId === agentsDomain && item.source === "upload",
    );
    if (!raas || !unused) throw new Error("expected registrations are missing");

    const refused = await env.fetch(
      `/v1/business-ontology-domains/${raas.id}`,
      {
        method: "DELETE",
        headers: headers(tenantsUnderTest[0].slug),
        body: JSON.stringify({ confirmOntologyDomainId: raasDomain }),
      },
    );
    expect(refused.status).toBe(409);
    expect(await failure(refused)).toMatchObject({
      code: "business_ontology_domain_in_use",
      details: {
        registrationId: raas.id,
        sessionId: expect.any(String),
      },
    });
    expect(
      getDb()
        .select({
          status: businessOntologyDomains.status,
          archivedAt: businessOntologyDomains.archivedAt,
        })
        .from(businessOntologyDomains)
        .where(eq(businessOntologyDomains.id, raas.id))
        .get(),
    ).toEqual({ status: "active", archivedAt: null });
    expect(
      getDb()
        .select({ id: ontocodeSessions.id })
        .from(ontocodeSessions)
        .innerJoin(
          ontocodeProjects,
          eq(ontocodeProjects.id, ontocodeSessions.projectId),
        )
        .where(eq(ontocodeProjects.ontologyDomainRegistrationId, raas.id))
        .all().length,
    ).toBeGreaterThan(0);

    const archived = await env.fetch(
      `/v1/business-ontology-domains/${unused.id}`,
      {
        method: "DELETE",
        headers: headers(tenantsUnderTest[0].slug),
        body: JSON.stringify({ confirmOntologyDomainId: agentsDomain }),
      },
    );
    expect(archived.status).toBe(200);
    expect(
      await success<{ domain: DomainRegistration; mode: "archived" }>(archived),
    ).toMatchObject({
      mode: "archived",
      domain: {
        id: unused.id,
        status: "archived",
        archivedAt: expect.any(Number),
      },
    });
    const archivedOntology = await env.fetch(
      `/v1/business-ontology-domains/${unused.id}/ontology`,
      { headers: headers(tenantsUnderTest[0].slug) },
    );
    expect(archivedOntology.status).toBe(409);
    expect(await failure(archivedOntology)).toMatchObject({
      code: "business_ontology_domain_inactive",
      details: {
        registrationId: unused.id,
        ontologyDomainId: agentsDomain,
        status: "archived",
      },
    });
    const verifyArchived = await env.fetch(
      `/v1/business-ontology-domains/${unused.id}/verify`,
      {
        method: "POST",
        headers: headers(tenantsUnderTest[0].slug),
        body: JSON.stringify({}),
      },
    );
    expect(verifyArchived.status).toBe(409);
    expect(await failure(verifyArchived)).toMatchObject({
      code: "business_ontology_domain_archived",
      details: {
        registrationId: unused.id,
        ontologyDomainId: agentsDomain,
      },
    });
    expect(
      getDb()
        .select({
          status: businessOntologyDomains.status,
          archivedAt: businessOntologyDomains.archivedAt,
        })
        .from(businessOntologyDomains)
        .where(eq(businessOntologyDomains.id, unused.id))
        .get(),
    ).toEqual({
      status: "archived",
      archivedAt: expect.any(Date),
    });

    // Archival removes the registration from new selection, never the
    // historical Project that records what source the FDE used.
    const historicalProject = getDb()
      .select()
      .from(ontocodeProjects)
      .where(eq(ontocodeProjects.ontologyDomainRegistrationId, unused.id))
      .get();
    expect(historicalProject).toBeDefined();
    const projectRead = await env.fetch(
      `/v1/ontocode/projects/${historicalProject!.id}`,
      { headers: headers(tenantsUnderTest[0].slug) },
    );
    expect(projectRead.status).toBe(200);

    const activeList = await env.fetch("/v1/business-ontology-domains", {
      headers: headers(tenantsUnderTest[0].slug),
    });
    expect(
      (await success<{ items: DomainRegistration[] }>(activeList)).items.map(
        (item) => item.id,
      ),
    ).not.toContain(unused.id);
    const historyList = await env.fetch(
      "/v1/business-ontology-domains?includeArchived=true",
      { headers: headers(tenantsUnderTest[0].slug) },
    );
    expect(
      (await success<{ items: DomainRegistration[] }>(historyList)).items,
    ).toContainEqual(
      expect.objectContaining({ id: unused.id, status: "archived" }),
    );
  });
});
