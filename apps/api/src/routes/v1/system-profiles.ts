/**
 * /v1/system-profiles — OntoCode 外部系统档案 (External System Profiles).
 *
 *   GET    /v1/system-profiles                 — list the tenant's profiles
 *   PUT    /v1/system-profiles                 — upsert one (body = SystemProfileV1)
 *   DELETE /v1/system-profiles/:profileId      — remove one
 *   POST   /v1/system-profiles/draft-from-doc  — Platform-Smith: AI-draft a
 *          profile from a pasted integration doc / API spec (NOT saved; the
 *          caller reviews and PUTs it — propose → review → apply).
 *
 * Tenant-scoped via requireAuth. Drafting requires a configured LLM gateway;
 * import-by-paste works without one (a pasted valid profile JSON short-circuits
 * the LLM and is returned as an "imported" draft for confirmation).
 */

import type { FastifyInstance } from "fastify";
import {
  SystemProfileV1Schema,
  systemProfileNames,
  type SystemConfigRequirement,
  type SystemProfileV1,
} from "@agentic/contracts";
import {
  chatOnce,
  isGatewayConfigured,
  modelChain,
  safeFetch,
} from "@agentic/agent-factory";
import { requireAuth } from "../../plugins/auth";
import {
  deleteSystemProfile,
  listSystemProfiles,
  upsertSystemProfile,
} from "../../services/system-profile-store";
import {
  buildToolSystemsMap,
  finalizeSystemCoverageScope,
  norm,
  parseSystemCoverageScopeList,
  resolveSystemCoverageScope,
  summarizeSystemCoverage,
  SystemCoverageScopeError,
  type SystemCoverageAgentScope,
} from "../../services/system-coverage";
import {
  buildSystemToolIndex,
  requirementFor,
  type IntegrationLite,
} from "../../services/system-config-requirements";
import {
  classifyProbeError,
  redactProbeDetail,
} from "../../services/probe-classify";
import { probeHttpHealth } from "../../services/generic-probe";
import { listGlobalTools, gohire } from "@agentic/tools";
import {
  getDecryptedCreds,
  getIntegrationRow,
  listIntegrations,
} from "../../services/integration-store";
import { recordSystemProbe } from "../../services/system-profile-store";
import { getFactoryDomainBinding } from "../../services/agent-factory/domain-binding";
import {
  AllmetaOntologySource,
  normDomainId,
} from "../../services/agent-factory/allmeta-ontology-source";
import type { UploadedFirstOntologySource } from "../../services/agent-factory/uploaded-ontology-source";
import {
  classifyOntologyReadFailure,
  classifySystemProfileStoreFailure,
  redactOntologyStack,
  type OntologyReadStage,
} from "../../services/ontology-read-failure";

/** A system's connection probe reuses the provider's health-probe tool (the
 * same one Settings→Integrations 连接测试 uses). Only providers with a health
 * tool can be auto-probed; others report honestly that no auto test exists. */
function healthToolFor(provider: string) {
  return provider === "gohire" ? gohire.gohireHealthApi : null;
}

export type SystemProfileProbeKind =
  | "provider_health"
  | "allmeta_ontology_read";

const ALLMETA_PROFILE_IDENTITIES = new Set([
  "allmeta",
  "allmetaontology",
  "allmetaontologysystem",
]);

/** Allmeta's System Profile intentionally uses deployment env refs rather than
 * a Settings provider row. Match only its reviewed identity vocabulary; an
 * arbitrary env-only profile must never inherit the Allmeta read probe. */
export function isAllmetaOntologyProfile(profile: SystemProfileV1): boolean {
  return systemProfileNames(profile).some((name) =>
    ALLMETA_PROFILE_IDENTITIES.has(norm(name)),
  );
}

/** Describe whether the workbench can actually execute a probe. Configuration
 * presence and probe availability are independent: an env-only profile may be
 * fully configured while still having no safe automatic probe. */
export function systemProfileProbeKind(input: {
  profile: SystemProfileV1 | undefined;
  credentialProvider: string | null;
  providerIntegrationConfigured: boolean;
  bindingSource: "explicit" | "auto" | "upload" | null;
}): SystemProfileProbeKind | null {
  if (!input.profile || input.profile.availability === "planned") return null;
  if (
    isAllmetaOntologyProfile(input.profile) &&
    input.bindingSource === "explicit"
  ) {
    return "allmeta_ontology_read";
  }
  if (input.credentialProvider && input.providerIntegrationConfigured) {
    return "provider_health";
  }
  return null;
}

/**
 * A bound domain id is an identity, so the read never folds case to "help".
 * Naming the catalog's own spelling is the honest alternative: the caller is
 * told exactly what to type, and nothing is substituted on their behalf.
 * Returns undefined when the catalog cannot be consulted — an absent hint,
 * never an invented one.
 */
async function nearMissDomainHint(
  source: UploadedFirstOntologySource | null,
  domain: string,
): Promise<string | undefined> {
  if (!source) return undefined;
  try {
    const wanted = normDomainId(domain);
    const near = (await source.listDomains())
      .map((entry) => entry.id)
      .filter((id) => id !== domain && normDomainId(id) === wanted);
    if (!near.length) return undefined;
    return (
      `目录里有写法相近的业务域：${near.map((id) => `「${id}」`).join("、")}。` +
      `业务域 id 区分大小写，请照抄目录里的写法。`
    );
  } catch {
    return undefined;
  }
}

export function systemConfigurationIsReady(input: {
  providerIntegrationConfigured: boolean;
  requirement: SystemConfigRequirement;
}): boolean {
  return (
    input.providerIntegrationConfigured ||
    (input.requirement.posture === "env_only" &&
      input.requirement.satisfied)
  );
}

// 起草规程（含凭证字段规格）见 docs/skills/system-config-drafting.md —— 改这里
// 的规则时同步改那份 skill 文档，两处必须一致。
const DRAFT_SYS = `你是「Platform-Smith」，负责把一份外部平台的对接文档提炼成机器可读的系统档案 JSON。
严格只输出一个 JSON 对象，结构如下（不确定的字段省略，绝不编造端点或事件）：
{
  "id": "kebab-case 平台 id（小写字母/数字/连字符）",
  "name": "平台显示名",
  "aliases": ["业务方对它的各种称呼，如 RAAS_System"],
  "description": "一句话说明",
  "capabilities": {
    "api": [{"operation": "端点/操作名", "description": "…", "objectTypes": ["涉及对象"]}],
    "events": [{"direction": "inbound|outbound", "eventName": "事件名", "payloadContract": "载荷契约要点"}],
    "data": [{"objectType": "对象类型", "mode": "read|write|readwrite"}]
  },
  "credential": {
    "provider": "kebab-case 凭证 provider（平台需要凭证时给出，例如 gohire）",
    "envRefs": ["文档里提到的凭证 env 名"],
    "healthPath": "文档里给出的健康检查相对路径（如 /api/v1/health；不写默认 /health；必须以 / 开头，绝不写完整 URL）",
    "fields": [{"key": "snake_case 键", "label": "表单标签", "kind": "base_url|api_key|secret|text|select|env_only", "required": true, "secret": true, "envRef": "可选：能满足该字段的环境变量名", "hint": "一句话说明", "options": ["仅 select 用"]}]
  },
  "provenance": {"mode": "ai-drafted"}
}
判定要点：请求/响应式接口进 api；事件/回调/webhook/消息进 events（我们消费=inbound，我们发出=outbound）；数据表/实体读写进 data。名称逐字取自文档。
凭证铁律（违反任何一条即废稿）：
1. fields 只描述字段的「形状」——绝不填写任何真实值、示例密钥、token 或密码；
2. envRef 是环境变量的「名字」，不是值；
3. 每个字段必须判定 secret；拿不准就 secret:true（宁严勿松）；
4. 密钥类字段 kind 用 api_key（主凭证）或 secret（其余秘密）；region/org id 等非秘密用 text/select；只存在于部署环境的用 env_only；
5. 文档没提的字段不要发明；平台无凭证就省略 fields；
6. 本档案是草稿——必须经人审确认后才生效。`;

export async function systemProfilesRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/system-profiles", async (req, reply) => {
    const auth = requireAuth(req);
    let profiles;
    try {
      profiles = listSystemProfiles(auth.tenantId);
    } catch (e) {
      const failure = classifySystemProfileStoreFailure(e);
      return reply.fail(
        failure.code,
        failure.message,
        503,
        undefined,
        failure.details,
      );
    }
    return reply.ok({
      profiles,
      aliasIndex: profiles.map((p) => ({
        id: p.id,
        names: systemProfileNames(p),
      })),
    });
  });

  // 系统覆盖：默认是整个域；actionIds / agentSlugs 可把范围收敛到本次
  // 生成套件。systems 只是完整性断言，绝不直接过滤服务端推导出的依赖。
  //
  // Failure discipline for this handler: no catch-all mapping. Every step of
  // the coverage read runs inside one guard that remembers WHICH step it is on,
  // so an escaping error is reported with a real reason and a named stage
  // instead of a bare 500 or a blanket "domain not found". Inputs this route
  // cannot read (profile table, integration table, ontology) fail closed —
  // reporting "nothing is configured" because a table was unreadable would be a
  // different answer, not a smaller one.
  //
  // Two statements DO run before the guard, deliberately, because neither one
  // is a coverage read and neither may be reported as one:
  //   · `requireAuth` — an unauthenticated or non-member caller is a 401/403
  //     about the caller. Folding it into the guard would relabel it as an
  //     internal coverage defect at stage `resolve_binding` and tell an FDE to
  //     report a platform bug for their own expired session.
  //   · reading `domain` off the query string — a pure string read that decides
  //     the 400, and the value the guard's own error messages are written
  //     around.
  app.get<{
    Querystring: {
      domain?: string;
      actionIds?: string | string[];
      agentSlugs?: string | string[];
      systems?: string | string[];
    };
  }>("/system-profiles/coverage", async (req, reply) => {
    const auth = requireAuth(req);
    const domain = String(req.query?.domain ?? "").trim();
    if (!domain) return reply.fail("BAD_REQUEST", "domain is required", 400);
    let stage: OntologyReadStage = "resolve_binding";
    let source: UploadedFirstOntologySource | null = null;
    try {
      // Which ontology graph a tenant reads is that tenant's own decision, and
      // it is recorded as a binding. Without one there is nothing to fall back
      // to that would still be true: an unbound tenant would silently read a
      // catalog domain it never chose, and every profile lookup would come back
      // empty because profiles are tenant-scoped — reported as "0 configured".
      const binding = getFactoryDomainBinding(auth.tenantId);
      if (!binding) {
        return reply.fail(
          "NO_DOMAIN_BINDING",
          "这个工作区还没有选择业务域，因此无从判断要连哪些外部系统。" +
            "请先在业务域设置里选择或上传一个业务域，再回到这里。",
          409,
          undefined,
          { reason: "no_domain_binding", stage: "resolve_binding", domain },
        );
      }

      let scopeRequest;
      try {
        scopeRequest = {
          actionIds: parseSystemCoverageScopeList(
            req.query?.actionIds,
            "actionIds",
          ),
          agentSlugs: parseSystemCoverageScopeList(
            req.query?.agentSlugs,
            "agentSlugs",
          ),
          systems: parseSystemCoverageScopeList(req.query?.systems, "systems"),
        };
      } catch (error) {
        if (error instanceof SystemCoverageScopeError) {
          return reply.fail(error.code, error.message, 400);
        }
        throw error;
      }

      stage = "read_profiles";
      let profiles: ReturnType<typeof listSystemProfiles>;
      try {
        profiles = listSystemProfiles(auth.tenantId);
      } catch (e) {
        const failure = classifySystemProfileStoreFailure(e);
        return reply.fail(
          failure.code,
          failure.message,
          503,
          undefined,
          failure.details,
        );
      }

      stage = "build_source";
      const { makeBoundFactoryOntologySource } =
        await import("../../services/agent-factory/bound-ontology-source");
      source = makeBoundFactoryOntologySource(auth.tenantSlug, auth.tenantId);
      // A1 — an agent most often reaches an external system through a tool
      // (tool_use[]), not an integration.systems block. Feed the global tool
      // catalog's capability.systems so pure-tool_use actions are not silently
      // reported as "fully covered".
      const toolSystems = buildToolSystemsMap(listGlobalTools());
      // Systems the platform runtime already satisfies (LLM gateway / internal
      // invoke) — folded in like tool_use so AO_Internal / LLM_Gateway show as
      // covered ("运行时提供") instead of demanding an external profile.
      const { runtimeProvidedSystemNames } =
        await import("../../services/agent-factory/index");
      const runtimeSystems = runtimeProvidedSystemNames();
      // Connection-ladder inputs: which credential providers are configured,
      // plus the secret-free row view the requirement derivation checks.
      const configuredProviders = new Set<string>();
      const integrationsByProvider = new Map<string, IntegrationLite>();
      for (const i of listIntegrations(auth.tenantId)) {
        if (!i.enabled) continue;
        configuredProviders.add(i.provider);
        integrationsByProvider.set(i.provider, {
          baseUrl: i.baseUrl,
          hasKey: i.hasKey,
          config: i.config,
          secretKeysStored: i.secretKeysStored,
          enabled: i.enabled,
        });
      }
      const profileById = new Map(profiles.map((p) => [p.id, p]));
      const systemToolIndex = buildSystemToolIndex(listGlobalTools());

      stage = "read_ontology";
      const ontology = await source.fetchOntology(domain);

      stage = "read_agent_drafts";
      let agentScopes: SystemCoverageAgentScope[] = [];
      if (scopeRequest.agentSlugs.length) {
        // A slug is trusted only after resolving it from this tenant/domain's
        // server-owned latest draft projection. Scenario-derived agents may
        // have no ontology Action, so their persisted spec carries the scope.
        const { FsAgentDraftStore } =
          await import("../../services/agent-factory/agent-draft-store");
        const drafts = await new FsAgentDraftStore({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          ontologyDomainId: domain,
        }).list(domain);
        agentScopes = drafts.map((draft) => ({
          slug: draft.slug,
          actionName: draft.spec.actionName,
          tools: draft.spec.tools ?? [],
          integrationRequirements: draft.spec.integrationRequirements ?? [],
          ...(draft.spec.parentAction
            ? { parentAction: draft.spec.parentAction }
            : {}),
          ...(draft.spec.isSubAgent !== undefined
            ? { isSubAgent: draft.spec.isSubAgent }
            : {}),
          ...(draft.versionId ? { versionId: draft.versionId } : {}),
        }));
      }
      stage = "summarize";
      const resolvedScope = resolveSystemCoverageScope(
        ontology.actions ?? [],
        scopeRequest,
        agentScopes,
      );
      const summary = summarizeSystemCoverage(
        resolvedScope.actions,
        profiles,
        toolSystems,
        runtimeSystems,
      );
      const scope = finalizeSystemCoverageScope(
        resolvedScope.scope,
        summary,
        profiles,
      );

      stage = "enrich";
      // Enrich each row with the full connection maturity ladder so the
      // workbench card can show "还差几步能用" without extra round-trips.
      const systems = summary.systems.map((row) => {
        const profile = row.profileId
          ? profileById.get(row.profileId)
          : undefined;
        const credentialProvider = profile?.credential?.provider ?? null;
        // The dynamic config requirement (fields + provenance + satisfaction)
        // — what 去配置/工作台第③步 renders. Secret-free by construction.
        const configRequirement = requirementFor(row.system, {
          profiles,
          toolIndex: systemToolIndex,
          integrationsByProvider,
          runtimeProvided: row.runtimeProvided,
        });
        const resolvedProvider =
          credentialProvider ?? configRequirement.provider;
        const providerIntegrationConfigured = resolvedProvider
          ? configuredProviders.has(resolvedProvider)
          : false;
        // Deployment env refs are a real configuration channel even though
        // they intentionally have no Settings integration row. This is the
        // Allmeta shape (`ALLMETA_BASE_URL` + `ALLMETA_API_KEY`).
        const credentialConfigured =
          systemConfigurationIsReady({
            providerIntegrationConfigured,
            requirement: configRequirement,
          });
        const probeKind = systemProfileProbeKind({
          profile,
          credentialProvider: resolvedProvider,
          providerIntegrationConfigured,
          bindingSource: binding.source,
        });
        return {
          ...row,
          hasTool: row.referencedVia.includes("tool"),
          credentialProvider: resolvedProvider,
          credentialConfigured,
          probeOk: profile?.lastProbe?.ok ?? null,
          probeAt: profile?.lastProbe?.at ?? null,
          probeSupported: probeKind !== null,
          probeKind,
          availability: profile?.availability ?? "live",
          plannedFallback: profile?.plannedFallback ?? "block",
          configRequirement,
        };
      });
      return reply.ok({ ...summary, systems, scope: { domain, ...scope } });
    } catch (e) {
      if (e instanceof SystemCoverageScopeError) {
        return reply.fail(e.code, e.message, 400);
      }
      const failure = classifyOntologyReadFailure({ error: e, stage, domain });
      const hint =
        failure.details.reason === "domain_not_in_catalog"
          ? await nearMissDomainHint(source, domain)
          : undefined;
      req.log.error(
        {
          stage,
          domain,
          reason: failure.details.reason,
          code: failure.code,
          diagnostic: failure.details.diagnostic,
          stack: redactOntologyStack(e),
        },
        "system coverage read failed",
      );
      return reply.fail(
        failure.code,
        failure.message,
        failure.status,
        hint,
        failure.details,
      );
    }
  });

  // Decide one or more referenced systems as deliberately human-operated,
  // without needing a parked build to confirm against. Same honest semantics as
  // the session blocker path: design may proceed, execution gates do not.
  app.post<{ Body: { systems?: unknown; note?: unknown } }>(
    "/system-profiles/human-boundary",
    async (req, reply) => {
      const auth = requireAuth(req);
      const raw = Array.isArray(req.body?.systems) ? req.body.systems : [];
      const systems = raw.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      );
      if (systems.length === 0) {
        return reply.fail("BAD_REQUEST", "systems is required", 400);
      }
      const { markSystemsAsHumanBoundary } = await import(
        "../../services/ontocode-human-boundary"
      );
      const marked = markSystemsAsHumanBoundary(auth.tenantId, systems, {
        confirmedBy: auth.email ?? auth.name ?? auth.userId ?? auth.via,
        note: typeof req.body?.note === "string" ? req.body.note : undefined,
      });
      return reply.ok({ marked, systems });
    },
  );

  app.put("/system-profiles", async (req, reply) => {
    const auth = requireAuth(req);
    // A2 — PUT is the human-review commit; stamp who confirmed it.
    const confirmedBy = auth.email ?? auth.name ?? auth.userId ?? auth.via;
    let profile;
    try {
      profile = upsertSystemProfile(auth.tenantId, req.body, { confirmedBy });
    } catch (e) {
      return reply.fail(
        "BAD_REQUEST",
        `档案不合法：${(e as Error).message}`,
        400,
      );
    }
    try {
      const audit = await import("../../plugins/audit");
      audit.writeAudit({
        tenantId: auth.tenantId,
        action: "system_profile.upsert",
        targetType: "system_profile",
        targetId: profile.id,
        meta: {
          name: profile.name,
          aliases: profile.aliases.length,
          confirmedBy,
        },
      });
    } catch {
      /* audit is best-effort */
    }
    return reply.ok({ profile });
  });

  // C — connection probe: a REAL credentialed health call to the system's
  // provider (reuses Settings→Integrations 连接测试). This validates "凭证+API
  // 连得上", NOT business logic — that's the agent sandbox after generation.
  app.post<{ Params: { profileId: string } }>(
    "/system-profiles/:profileId/probe",
    async (req, reply) => {
      const auth = requireAuth(req);
      const profile = listSystemProfiles(auth.tenantId).find(
        (p) => p.id === req.params.profileId,
      );
      if (!profile) return reply.fail("NOT_FOUND", "档案不存在", 404);
      if (profile.availability === "planned") {
        return reply.fail(
          "PLANNED",
          "系统尚未建成（本体已规划）——没有可测的连接；建成后把档案翻回 live 再探测",
          400,
        );
      }

      // Allmeta is deliberately env-only: there is no Settings provider row
      // and no generic `/health` contract. Prove the connection by reading the
      // tenant's exact, persisted Allmeta domain through the same strict source
      // used by Factory authoring. This is read-only connection evidence; it
      // does not claim sandbox write verification or Candidate promotion.
      if (isAllmetaOntologyProfile(profile)) {
        const binding = getFactoryDomainBinding(auth.tenantId);
        if (!binding || binding.source !== "explicit") {
          return reply.fail(
            "NO_ALLMETA_BINDING",
            "当前租户未绑定 Allmeta Ontology 域——请先在业务域设置中选择 Allmeta 来源",
            400,
          );
        }
        const at = Date.now();
        let ok = false;
        let detail: string;
        try {
          const ontology = await new AllmetaOntologySource(undefined, {
            domainIdentity: "exact",
          }).fetchOntology(binding.ontologyDomainId);
          ok = true;
          detail =
            `只读 Ontology 探针通过：${binding.ontologyDomainId}` +
            `（objects=${ontology.objects.length}, actions=${ontology.actions.length}, ` +
            `events=${ontology.events.length}, rules=${ontology.rules.length}）`;
        } catch (error) {
          detail = `只读 Ontology 探针失败：${redactProbeDetail(error)}`;
        }
        recordSystemProbe(auth.tenantId, profile.id, {
          ok,
          at,
          detail,
        });
        return reply.ok({
          ok,
          probeKind: "allmeta_ontology_read" as const,
          domain: binding.ontologyDomainId,
          at,
          detail,
        });
      }

      const provider = profile.credential?.provider;
      if (!provider) {
        return reply.fail(
          "NO_PROVIDER",
          "该系统未声明凭证 provider——无法自动连接测试（可能是人工边界或纯事件型系统）",
          400,
        );
      }
      if (!getIntegrationRow(auth.tenantId, provider)) {
        return reply.fail(
          "NO_CREDENTIAL",
          `未配置 ${provider} 凭证——请先到 Settings → Integrations 配置`,
          400,
        );
      }
      const tool = healthToolFor(provider);
      let ok = true;
      let detail: string | undefined;
      if (tool) {
        // First-party health tool (gohire) — creds resolve inside the tool via
        // the injected integration resolver; no secret passes through here.
        try {
          await tool.handler({
            agentName: "system-connect",
            actionName: `${provider}.health`,
            correlationId: `system-probe-${profile.id}`,
            tenantSlug: auth.tenantSlug,
            subject: undefined,
            event: { name: `system:${profile.id}:probe`, data: {} },
          });
        } catch (err) {
          // Reachable-but-no-/health-route is connectivity PROOF, not failure
          // (strict 404 + no-route-signature double condition; see probe-classify).
          const cls = classifyProbeError(err);
          if (cls.reachableNoHealth) {
            ok = true;
            detail = cls.note;
          } else {
            ok = false;
            // The tool folds the WHOLE upstream error body into its message,
            // and this probe reached that upstream holding a decrypted key —
            // an auth error that quotes the key it rejected would otherwise be
            // persisted verbatim on the profile row.
            detail = redactProbeDetail(err);
          }
        }
      } else {
        // Generic probe — ANY profiled provider becomes testable with zero
        // code: base URL + key from the integration row, health path from the
        // profile (`credential.healthPath`, default /health).
        const creds = getDecryptedCreds(auth.tenantId, provider);
        const baseUrl = creds?.base_url?.trim();
        if (!baseUrl) {
          return reply.fail(
            "NO_BASE_URL",
            `${provider} 的集成缺 Base URL——先到 Settings → Integrations 填写后再探测`,
            400,
          );
        }
        const result = await probeHttpHealth({
          baseUrl,
          apiKey: creds?.api_key,
          healthPath: profile.credential?.healthPath,
        });
        ok = result.ok;
        // `detail` keeps up to 200 characters of the upstream's own body, and
        // the probe sent it a Bearer credential — same echo risk as above.
        detail = redactProbeDetail(result.detail);
      }
      const at = Date.now();
      recordSystemProbe(auth.tenantId, profile.id, {
        ok,
        at,
        provider,
        ...(detail ? { detail } : {}),
      });
      return reply.ok({ ok, provider, at, ...(detail ? { detail } : {}) });
    },
  );

  app.delete<{ Params: { profileId: string } }>(
    "/system-profiles/:profileId",
    async (req, reply) => {
      const auth = requireAuth(req);
      const deleted = deleteSystemProfile(auth.tenantId, req.params.profileId);
      if (!deleted) return reply.fail("NOT_FOUND", "档案不存在", 404);
      return reply.ok({ deleted: true });
    },
  );

  app.post<{ Body: { url?: string; text?: string; hint?: string } }>(
    "/system-profiles/draft-from-doc",
    async (req, reply) => {
      const auth = requireAuth(req);
      let doc = String(req.body?.text ?? "").trim();
      const url = String(req.body?.url ?? "").trim();
      const hint = String(req.body?.hint ?? "").trim();

      // Import short-circuit: a pasted valid profile JSON needs no LLM.
      if (doc.startsWith("{")) {
        try {
          const direct = SystemProfileV1Schema.parse(JSON.parse(doc));
          return reply.ok({
            draft: {
              ...direct,
              provenance: { ...direct.provenance, mode: "imported" as const },
            },
            imported: true,
          });
        } catch {
          /* not a profile document — fall through to drafting */
        }
      }

      if (!doc && url) {
        try {
          const res = await safeFetch(url, {
            headers: { accept: "text/html,text/plain,*/*" },
          });
          doc = (await res.text())
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 8000);
        } catch (e) {
          return reply.fail(
            "FETCH_FAILED",
            `抓取文档失败：${(e as Error).message}`,
            400,
          );
        }
      }
      if (!doc) {
        return reply.fail(
          "BAD_REQUEST",
          "没有文档可提炼——粘贴对接文档文本或给一个 URL。",
          400,
        );
      }
      if (!isGatewayConfigured()) {
        return reply.fail(
          "LLM_UNCONFIGURED",
          "未配置 LLM 网关，无法自动起草；可直接粘贴档案 JSON 导入。",
          400,
        );
      }
      try {
        const text = await chatOnce(
          DRAFT_SYS,
          `${hint ? `平台提示：${hint}\n\n` : ""}对接文档（截断）：\n${doc.slice(0, 6000)}`,
          {
            temperature: 0.2,
            maxTokens: 1600,
            models: modelChain("review"),
            purpose: "system-profile.draft",
            context: {
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              domain:
                getFactoryDomainBinding(auth.tenantId)?.ontologyDomainId ??
                undefined,
            },
          },
        );
        const match = text.match(/\{[\s\S]*\}/);
        if (!match)
          return reply.fail(
            "EXTRACT_FAILED",
            "没能从文档提炼出档案；补充平台提示后重试，或手工粘贴档案 JSON。",
            422,
          );
        const draft = SystemProfileV1Schema.parse(JSON.parse(match[0]));
        return reply.ok({
          draft: {
            ...draft,
            provenance: { ...draft.provenance, mode: "ai-drafted" as const },
          },
          imported: false,
        });
      } catch (e) {
        return reply.fail(
          "EXTRACT_FAILED",
          `提炼失败：${(e as Error).message}`,
          422,
        );
      }
    },
  );
}
