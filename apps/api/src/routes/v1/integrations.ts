/**
 * /v1/integrations — per-tenant external-service integrations backing
 * Settings → Integrations.
 *
 *   GET    /v1/integrations                    — list configured + available
 *   GET    /v1/integrations/requirements       — derived config fields for one provider
 *   PUT    /v1/integrations                    — upsert one (dynamic fields aware)
 *   DELETE /v1/integrations/:provider          — remove one
 *   POST   /v1/integrations/:provider/test     — connection test (health probe)
 *
 * Providers are NOT limited to the static catalog: any System Profile that
 * declares `credential.provider` makes that provider configurable here, and
 * the form fields come from the profile's ConfigFieldSpec derivation — no code
 * change per new system. API keys/secret fields are write-only over the wire.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ListIntegrationsResponse,
  UpsertIntegrationBody,
  INTEGRATION_PROVIDERS,
  type IntegrationStatus,
  type SystemProfileV1,
} from "@agentic/contracts";
import { gohire, listGlobalTools } from "@agentic/tools";
import { requireAuth } from "../../plugins/auth";
import {
  deleteIntegration,
  getDecryptedCreds,
  getIntegrationRow,
  listIntegrations,
  setIntegrationHealth,
  toPublic,
  upsertIntegration,
} from "../../services/integration-store";
import { listSystemProfiles } from "../../services/system-profile-store";
import {
  buildSystemToolIndex,
  profileForProvider,
  requirementFor,
  splitDynamicFields,
  type IntegrationLite,
} from "../../services/system-config-requirements";
import {
  classifyProbeError,
  redactProbeDetail,
} from "../../services/probe-classify";
import { probeHttpHealth } from "../../services/generic-probe";
import { classifySystemProfileStoreFailure } from "../../services/ontology-read-failure";

const STATIC_AVAILABLE = INTEGRATION_PROVIDERS.map((p) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  defaultBaseUrl: p.defaultBaseUrl,
  description: p.description,
  docsUrl: p.docsUrl,
  source: "catalog" as const,
}));

/** Map a provider id to its health-probe tool, when one exists. */
function healthToolFor(provider: string) {
  if (provider === "gohire") return gohire.gohireHealthApi;
  return null;
}

/**
 * The System Profile table is an INPUT to every read below: which providers are
 * configurable at all, what fields their form has, which health path a generic
 * probe calls. When it cannot be read, this route stops and says so.
 *
 * It used to degrade to `[]` when the driver's message contained "no such
 * table". Both halves were wrong. Sniffing an English substring maps unrelated
 * causes onto one outcome — the exact practice `classifySystemProfileStoreFailure`
 * was written to replace, in this same change. And an empty profile list is not
 * a smaller answer than "unreadable": profile-derived providers silently vanish
 * from Settings, and a generic probe silently falls back to `/health` and
 * reports the resulting 404 as a connection verdict.
 *
 * The guard is deliberately narrow — one call — so an integration-table or
 * tool-catalog fault is never reported as a profile-store fault.
 */
function failProfileStore(reply: FastifyReply, error: unknown) {
  const failure = classifySystemProfileStoreFailure(error);
  return reply.fail(
    failure.code,
    failure.message,
    503,
    undefined,
    failure.details,
  );
}

/** Static catalog ∪ providers declared by the tenant's System Profiles —
 * a profiled system becomes configurable with zero code changes. Planned
 * (not-yet-built) systems are excluded: there is nothing to configure yet. */
function availableProviders(profiles: SystemProfileV1[]) {
  const seen = new Set<string>(STATIC_AVAILABLE.map((p) => p.id));
  const derived: Array<{
    id: string;
    name: string;
    kind: string;
    defaultBaseUrl: string;
    description: string;
    docsUrl?: string;
    source: "catalog" | "profile";
  }> = [];
  for (const profile of profiles) {
    const provider = profile.credential?.provider?.trim();
    if (!provider || seen.has(provider)) continue;
    if (profile.availability === "planned") continue;
    seen.add(provider);
    derived.push({
      id: provider,
      name: profile.name,
      kind: "系统档案",
      defaultBaseUrl: "",
      description: profile.description ?? `来自系统档案 ${profile.id}`,
      source: "profile",
    });
  }
  return [...STATIC_AVAILABLE, ...derived];
}

/** Secret-free lookup map for satisfaction checks (enabled rows only). */
function integrationsLiteByProvider(tenantId: string): Map<string, IntegrationLite> {
  const map = new Map<string, IntegrationLite>();
  for (const row of listIntegrations(tenantId)) {
    if (!row.enabled) continue;
    map.set(row.provider, {
      baseUrl: row.baseUrl,
      hasKey: row.hasKey,
      config: row.config,
      secretKeysStored: row.secretKeysStored,
      enabled: row.enabled,
    });
  }
  return map;
}

/** Derive the requirement for one provider id (system resolved via profiles). */
function requirementForProvider(
  tenantId: string,
  provider: string,
  profiles: SystemProfileV1[],
) {
  const profile = profileForProvider(provider, profiles);
  const systemName = profile?.name ?? provider;
  const requirement = requirementFor(systemName, {
    profiles,
    toolIndex: buildSystemToolIndex(listGlobalTools()),
    integrationsByProvider: integrationsLiteByProvider(tenantId),
    // Caller names the provider explicitly — even an unprofiled one still
    // gets the generic form here (coverage rows keep steering to 建档).
    fallbackProvider: provider,
  });
  return { requirement, profile, systemName };
}

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/integrations — configured rows + available providers (catalog ∪ profiles).
  app.get("/integrations", async (req, reply) => {
    const auth = requireAuth(req);
    let profiles: SystemProfileV1[];
    try {
      profiles = listSystemProfiles(auth.tenantId);
    } catch (e) {
      return failProfileStore(reply, e);
    }
    const payload = ListIntegrationsResponse.parse({
      integrations: listIntegrations(auth.tenantId),
      available: availableProviders(profiles),
    });
    return reply.ok(payload);
  });

  // GET /v1/integrations/requirements?provider=x — the dynamic form spec the
  // Settings editor renders (fields + provenance + satisfaction, secret-free).
  app.get<{ Querystring: { provider?: string } }>(
    "/integrations/requirements",
    async (req, reply) => {
      const auth = requireAuth(req);
      const provider = String(req.query?.provider ?? "").trim();
      if (!provider) return reply.fail("BAD_REQUEST", "provider is required", 400);
      let profiles: SystemProfileV1[];
      try {
        profiles = listSystemProfiles(auth.tenantId);
      } catch (e) {
        return failProfileStore(reply, e);
      }
      const { requirement, profile, systemName } = requirementForProvider(
        auth.tenantId,
        provider,
        profiles,
      );
      return reply.ok({
        provider,
        systemName,
        profileId: profile?.id ?? null,
        requirement,
      });
    },
  );

  // PUT /v1/integrations — upsert (keyed on tenant + provider). Dynamic
  // `fields{}` are routed by the derived specs: declared non-secret → plain
  // config bag; declared secret or UNKNOWN → encrypted bag (fail closed).
  app.put("/integrations", async (req, reply) => {
    const auth = requireAuth(req);
    const body = UpsertIntegrationBody.parse(req.body);
    let plainFields: Record<string, string> | undefined;
    let secretFields: Record<string, string> | undefined;
    let baseUrl = body.baseUrl;
    let apiKey = body.apiKey;
    if (body.fields && Object.keys(body.fields).length > 0) {
      // Which bag a dynamic field lands in — plain config or the encrypted one
      // — is decided by the derived spec. With no spec there is no safe guess:
      // a secret would be at risk of being written in the clear.
      let profiles: SystemProfileV1[];
      try {
        profiles = listSystemProfiles(auth.tenantId);
      } catch (e) {
        return failProfileStore(reply, e);
      }
      const { requirement } = requirementForProvider(
        auth.tenantId,
        body.provider,
        profiles,
      );
      const split = splitDynamicFields(body.fields, requirement.fields);
      if (split.baseUrl !== undefined && baseUrl === undefined) {
        const candidate = split.baseUrl.trim();
        if (candidate.length > 0) {
          try {
            new URL(candidate);
          } catch {
            return reply.fail("BAD_REQUEST", "fields.base_url 不是合法 URL", 400);
          }
        }
        baseUrl = candidate.length > 0 ? candidate : undefined;
      }
      if (split.apiKey !== undefined && apiKey === undefined) apiKey = split.apiKey;
      plainFields = split.plainFields;
      secretFields = split.secretFields;
    }
    const saved = upsertIntegration({
      tenantId: auth.tenantId,
      provider: body.provider,
      name: body.name,
      baseUrl,
      apiKey,
      plainFields,
      secretFields,
      enabled: body.enabled,
      createdBy: auth.via,
    });
    try {
      const audit = await import("../../plugins/audit");
      audit.writeAudit({
        tenantId: auth.tenantId,
        action: "integration.upsert",
        targetType: "integration",
        targetId: saved.id,
        // Field names only — never any value.
        meta: {
          provider: body.provider,
          base_url_set: baseUrl !== undefined,
          key_changed: apiKey !== undefined,
          plain_fields: plainFields ? Object.keys(plainFields).sort() : [],
          secret_fields: secretFields ? Object.keys(secretFields).sort() : [],
          auth_via: auth.via ?? null,
        },
      });
    } catch (err) {
      req.log.warn({ err }, "integration.upsert: audit write failed");
    }
    return reply.ok(saved);
  });

  // DELETE /v1/integrations/:provider
  app.delete<{ Params: { provider: string } }>(
    "/integrations/:provider",
    async (req, reply) => {
      const auth = requireAuth(req);
      const removed = deleteIntegration(auth.tenantId, req.params.provider);
      if (!removed) return reply.fail("not_found", "integration not found", 404);
      try {
        const audit = await import("../../plugins/audit");
        audit.writeAudit({
          tenantId: auth.tenantId,
          action: "integration.delete",
          targetType: "integration",
          targetId: req.params.provider,
          meta: { provider: req.params.provider, auth_via: auth.via ?? null },
        });
      } catch {
        /* audit best-effort */
      }
      return reply.ok({ deleted: true });
    },
  );

  // POST /v1/integrations/:provider/test — probe the provider's health
  // endpoint using the stored creds, then cache the result on the row so the
  // Settings list can show a health pill without re-probing.
  app.post<{ Params: { provider: string } }>(
    "/integrations/:provider/test",
    async (req, reply) => {
      const auth = requireAuth(req);
      const provider = req.params.provider;
      const row = getIntegrationRow(auth.tenantId, provider);
      if (!row) return reply.fail("not_found", "integration not found", 404);

      const tool = healthToolFor(provider);
      let status: IntegrationStatus = "ok";
      let message: string | null = null;
      if (tool) {
        try {
          // The tool reads base URL + key for this tenant via the injected
          // integration resolver (set at bootstrap), so no secret is passed
          // through this layer.
          await tool.handler({
            agentName: "settings",
            actionName: `${provider}.health`,
            correlationId: `integration-test-${provider}`,
            tenantSlug: auth.tenantSlug,
            subject: undefined,
            event: { name: `integration:${provider}:test`, data: {} },
          });
        } catch (err) {
          // "Server reachable, deployment just has no /health route" is proof of
          // connectivity, not a failure — see probe-classify.ts for the strict
          // (404 + no-route signature) double condition.
          const cls = classifyProbeError(err);
          if (cls.reachableNoHealth) {
            status = "ok";
            message = cls.note ?? null;
          } else {
            status = "error";
            // Same echo risk as the System Profile probe: this call carried a
            // decrypted key, and the tool folds the upstream's whole error body
            // into its message before it is persisted on the row.
            message = redactProbeDetail(err);
          }
        }
      } else {
        // Generic probe — any profiled provider is testable with zero code:
        // base URL + key from this row, health path from its System Profile.
        const creds = getDecryptedCreds(auth.tenantId, provider);
        const baseUrl = creds?.base_url?.trim();
        if (!baseUrl) {
          return reply.fail(
            "no_base_url",
            `provider '${provider}' 的集成缺 Base URL——填写后才能测试连接`,
            400,
          );
        }
        // The health path comes from the profile. Falling back to `/health`
        // because the table was unreadable would turn an unknown into an
        // invented connection verdict.
        let profiles: SystemProfileV1[];
        try {
          profiles = listSystemProfiles(auth.tenantId);
        } catch (e) {
          return failProfileStore(reply, e);
        }
        const profile = profileForProvider(provider, profiles);
        const result = await probeHttpHealth({
          baseUrl,
          apiKey: creds?.api_key,
          healthPath: profile?.credential?.healthPath,
        });
        status = result.ok ? "ok" : "error";
        message = redactProbeDetail(result.detail);
      }

      // Persist the message even when ok — a reachable-with-hint verdict (e.g.
      // "no /health route at this base") must survive on the row, not flash
      // once in a toast. The Settings list renders it as an amber note.
      setIntegrationHealth(auth.tenantId, provider, status, message);
      const updated = getIntegrationRow(auth.tenantId, provider);
      return reply.ok({
        ok: status === "ok",
        status,
        message,
        checkedAt: updated?.lastCheckedAt ? updated.lastCheckedAt.getTime() : Date.now(),
        integration: updated ? toPublic(updated) : null,
      });
    },
  );
}
