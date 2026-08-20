/**
 * /v1/tools — the unified tool LIBRARY.
 *
 *   GET    /v1/tools                  → catalog: built-in globalToolRegistry tools (origin:"global")
 *                                       MERGED with persisted declarative 造工具 tools (origin:"created").
 *   POST   /v1/tools/generate-from-doc→ Tool-Smith: fetch a public API doc (or take pasted text) and
 *                                       LLM-extract a draft HTTP-tool contract (no save — returns a draft).
 *   POST   /v1/tools                  → persist a tenant/domain immutable draft revision.
 *   DELETE /v1/tools/:name            → CAS-deactivate the active revision; history remains.
 *
 * Only an exact HMAC-attested, human-activated revision is projected into
 * `factory_tools` and made runtime-executable by the step-engine resolver.
 * Draft/rejected/retired revisions never enter executable discovery.
 */

import type { FastifyInstance } from "fastify";
import { globalToolRegistry, listGlobalTools } from "@agentic/tools";
import { inspectWriteProbeSafety } from "@agentic/shared";
import { getExpandedTenantRegistry } from "../../bootstrap";
import {
  safeFetch,
  chatOnce,
  isGatewayConfigured,
  modelChain,
  findSensitiveProbeInputPath,
  findSensitiveInputPath,
  parseCapabilityDescriptors,
  persistedToolAsRealTool,
  realToolExecutionPolicy,
  isGeneratedToolExecutionPolicy,
  parseDeclarativeHttpContract,
  validateDeclarativeToolPolicy,
  validateIntegrationToolConfig,
  isIntegrationProfileEnvironment,
  type DeclarativeTool,
  type RealTool,
} from "@agentic/agent-factory";
import { listDeclarativeTools } from "../../services/agent-factory/declarative-tool";
import { DrizzleToolStatsStore, DrizzleToolStore } from "../../services/agent-factory/stores";
import { getFactoryDomainBinding } from "../../services/agent-factory/domain-binding";
import {
  listGlobalToolProbeReceipts,
  summarizeGlobalToolProbeReceiptsByTool,
} from "../../services/agent-factory/tool-probe-store";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  deleteIntegrationProfile,
  listIntegrationProfiles,
  saveIntegrationProfile,
} from "../../services/agent-factory/integration-profile-store";
import { hasFactoryActiveWork } from "../../services/agent-factory/active-work";
import {
  activateToolRevision,
  createToolDraft,
  deactivateToolRevision,
  getToolRevision,
  listToolRevisionPage,
  listToolRevisions,
  rejectToolRevision,
  ToolRevisionError,
} from "../../services/agent-factory/tool-revision-store";

interface FieldSchema { type: string; required?: boolean; description?: string; default?: unknown }

/** Best-effort coerce a stored params/returns blob (string→type, or {type,description}) to the
 *  catalog's field-schema shape so created tools render in the same API-docs table as global tools. */
function toFieldSchema(blob: Record<string, unknown> | undefined): Record<string, FieldSchema> | undefined {
  if (!blob || typeof blob !== "object") return undefined;
  const out: Record<string, FieldSchema> = {};
  for (const [k, v] of Object.entries(blob)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      out[k] = { type: String(o.type ?? "any"), required: Boolean(o.required), description: o.description ? String(o.description) : undefined, default: o.default };
    } else {
      out[k] = { type: typeof v === "string" ? String(v) : "any", description: typeof v === "string" ? String(v) : undefined };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map a persisted DeclarativeTool into the same ToolCatalogEntry shape the UI renders. */
function declToCatalogEntry(
  dt: DeclarativeTool,
  activeRevision?: { id: string; domainId: string | null },
): Record<string, unknown> {
  const category = dt.name.includes(".") ? dt.name.slice(0, dt.name.indexOf(".")) : "created";
  const evidenceMode = dt.probeEvidence?.evidenceMode;
  const productionProbeVerified = dt.probeStatus === "verified"
    && evidenceMode === "live-probe"
    && typeof dt.probeEvidence?.attestationKeyId === "string"
    && typeof dt.probeEvidence?.attestationExpiresAt === "string"
    && Date.parse(dt.probeEvidence.attestationExpiresAt) > Date.now();
  const writeProof = dt.probeEvidence?.writeProbeProof as {
    create?: { completed?: unknown };
    cleanup?: { completed?: unknown };
    absence?: { verified?: unknown };
    idempotencyKeyHash?: unknown;
  } | undefined;
  return {
    name: dt.name,
    category,
    summary: dt.description || `${dt.method} ${dt.urlTemplate}`,
    description: `${dt.method} ${dt.urlTemplate}（造工具 · 副作用:${dt.sideEffect}${dt.domain ? ` · 域:${dt.domain}` : " · tenant-wide"}）`,
    argsSchema: toFieldSchema(dt.paramsSchema),
    returnsSchema: toFieldSchema(dt.returnsSchema),
    configSchema: undefined,
    aliases: [],
    sourcePath: "factory_tools（active projection；通过 revision lifecycle 管理）",
    origin: "created",
    probeEvidenceMode: evidenceMode,
    productionProbeVerified,
    writeProbeComplete: Boolean(
      writeProof?.create?.completed === true
      && writeProof.cleanup?.completed === true
      && writeProof.absence?.verified === true
      && typeof writeProof.idempotencyKeyHash === "string"
      && /^[a-f0-9]{64}$/i.test(writeProof.idempotencyKeyHash),
    ),
    method: dt.method,
    urlTemplate: dt.urlTemplate,
    sideEffect: dt.sideEffect,
    operation: dt.operation,
    effectScope: dt.effectScope,
    sandboxPolicy: dt.sandboxPolicy,
    domain: dt.domain,
    capabilities: dt.capabilities ?? [],
    probeStatus: dt.probeStatus ?? "required",
    definitionHash: dt.definitionHash,
    probeEvidence: dt.probeEvidence,
    verifiedAt: dt.verifiedAt,
    activeRevisionId: activeRevision?.id,
    activeRevisionDomainId: activeRevision?.domainId,
    managedLifecycle: Boolean(activeRevision),
    deactivationBlocker: activeRevision
      ? undefined
      : {
          code: "legacy_tool_revision_migration_required",
          message:
            "这个 active projection 没有对应的 managed revision。系统不会伪造 probe/审核历史或直接删除；请先完成显式 lifecycle migration。",
          next: "migrate_legacy_tool_revision",
        },
  };
}

function globalCatalogAsRealTool(catalog: ReturnType<typeof listGlobalTools>[number]): RealTool {
  return {
    name: catalog.name,
    summary: catalog.summary,
    aliases: catalog.aliases,
    category: catalog.category,
    sideEffect: catalog.sideEffect ?? "call",
    operation: catalog.operation,
    effectScope: catalog.effectScope,
    sandboxPolicy: catalog.sandboxPolicy,
    configKeys: catalog.configSchema ? Object.keys(catalog.configSchema) : [],
    credentialEnv: catalog.credentialEnv ?? [],
    capabilities: catalog.capabilities ?? [],
    catalogDefinition: {
      name: catalog.name,
      category: catalog.category,
      sourcePath: catalog.sourcePath,
      sideEffect: catalog.sideEffect,
      operation: catalog.operation,
      effectScope: catalog.effectScope,
      sandboxPolicy: catalog.sandboxPolicy,
      argsSchema: catalog.argsSchema,
      returnsSchema: catalog.returnsSchema,
      configSchema: catalog.configSchema,
      ...(catalog.configContract !== undefined ? { configContract: catalog.configContract } : {}),
      capabilities: catalog.capabilities,
      profileScope: catalog.profileScope,
      probeSafety: catalog.probeSafety,
    },
  };
}

const EXTRACT_SYS =
  "你是 API 契约提炼器。给你一个工具意图和一段 API 文档文本，提炼出【最贴合该意图的单个 HTTP 端点】的可用契约。" +
  '只输出 JSON：{"name":string(带命名空间如 acme.getJob),"description":string(1..2000字符，描述真实端点用途),"method":"GET|POST|PUT|DELETE","url_template":string(可含{placeholder}),"headers":object,"body_template":string(与request_spec互斥),"request_spec":object(可选，json或multipart编码),"response_spec":object(可选，unwrap/mappings/assertions),"examples":array(可选，仅脱敏request/response样例),"side_effect":"read|write|dual","operation":"read|compute|write|read_write","effect_scope":"external","sandbox_policy":"live_external|requires_attempt_grant","params_schema":object(JSON Schema或字段map),"returns_schema":object(JSON Schema或字段map),"capabilities":[{"systems":string[],"kinds":string[],"roles":string[],"operations":string[],"objectTypes":string[],"probeRequired":boolean}],"auth_hint":string(鉴权方式与所需凭证),"confidence":number(0-1),"notes":string}。只在文档或脱敏样例明确支持时输出 request_spec/response_spec/examples；不得输出源码、handler 或可执行脚本。operation/effect_scope/sandbox_policy 是执行安全契约：只有确定不改变外部状态时才可用 live_external，任何可能修改外部状态的操作必须用 requires_attempt_grant。文档没有足够证据时不要从 HTTP method、side_effect 或工具名推断这三个字段，应将它们留空并在 notes 里用人话说明需要人确认。不要任何其它文字。';

const GENERATED_TOOL_DRAFT_FIELDS = new Set([
  "name",
  "description",
  "method",
  "url_template",
  "headers",
  "body_template",
  "request_spec",
  "response_spec",
  "examples",
  "side_effect",
  "operation",
  "effect_scope",
  "sandbox_policy",
  "params_schema",
  "returns_schema",
  "capabilities",
  "auth_hint",
  "confidence",
  "notes",
]);

/** Keep model output a declarative review artifact. In particular, source,
 * handler and script fields can never be reflected into the UI or persistence
 * request as if Tool-Smith had authority to install executable code. */
export function selectGeneratedToolDraftFields(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(candidate).filter(([key]) =>
      GENERATED_TOOL_DRAFT_FIELDS.has(key),
    ),
  );
}

const managedRevisionDomainId = (
  binding: ReturnType<typeof getFactoryDomainBinding>,
): string => binding?.ontologyDomainId ?? "__unbound__";

function requestedManagedRevisionDomainId(
  binding: ReturnType<typeof getFactoryDomainBinding>,
  requested?: unknown,
): string {
  const current = managedRevisionDomainId(binding);
  const value = typeof requested === "string" ? requested.trim() : "";
  if (!value) return current;
  if (value === "__unbound__" || value === current) return value;
  throw new ToolRevisionError(
    "TOOL_REVISION_NOT_FOUND",
    "revision domain 不属于当前 ontology 绑定；如需管理绑定前的 tenant-wide 草稿，请显式使用 __unbound__",
    404,
  );
}

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET: the unified catalog (global + created) ──────────────────────────────
  app.get("/tools", async (req, reply) => {
    const auth = requirePermission(req, "tools.read");
    // #SCALE-TOOLS — join empirical sandbox effectiveness so the library shows each tool's real
    // success rate (and flags demoted ones), not just its static contract.
    const binding = req.auth ? getFactoryDomainBinding(req.auth.tenantId) : null;
    const stats = await new DrizzleToolStatsStore(req.auth?.tenantId, binding?.ontologyDomainId).successRates();
    const globalProbeReceipts = req.auth
      ? summarizeGlobalToolProbeReceiptsByTool(listGlobalToolProbeReceipts(req.auth.tenantId, binding?.ontologyDomainId))
      : new Map();
    const integrationProfilesByTool = new Map<string, ReturnType<typeof listIntegrationProfiles>>();
    for (const profile of req.auth ? listIntegrationProfiles(req.auth.tenantId, binding?.ontologyDomainId) : []) {
      const current = integrationProfilesByTool.get(profile.toolName) ?? [];
      current.push(profile);
      integrationProfilesByTool.set(profile.toolName, current);
    }
    const rate = (name: string): { invoked: number; succeeded: number; successRate: number } | Record<string, never> => {
      const st = stats[name];
      return st && st.invoked > 0 ? { invoked: st.invoked, succeeded: st.succeeded, successRate: st.succeeded / st.invoked } : {};
    };
    const globals = listGlobalTools().map((t) => {
      const receipt = globalProbeReceipts.get(t.name);
      const probeRequired =
        t.effectScope === "external" ||
        t.operation === "write" ||
        t.operation === "read_write" ||
        t.sideEffect === "write" ||
        t.sideEffect === "dual" ||
        t.capabilities?.some((capability) => capability.probeRequired) === true;
      return {
        ...t,
        origin: "global" as const,
        probeStatus: probeRequired ? (receipt?.status ?? "required") : "verified",
        definitionHash: receipt?.definitionHash,
        verifiedDefinitionHashes: receipt?.verifiedDefinitionHashes,
        productionVerifiedDefinitionHashes: receipt?.productionVerifiedDefinitionHashes,
        probeEvidenceMode: receipt?.evidenceMode,
        productionProbeVerified: probeRequired ? (receipt?.productionVerified ?? false) : true,
        writeProbeComplete: receipt?.writeProbeComplete ?? false,
        integrationProfiles: integrationProfilesByTool.get(t.name) ?? [],
        probeEvidence: receipt?.evidence,
        verifiedAt: receipt?.verifiedAt,
        ...rate(t.name),
      };
    });
    // Object.assign (not spread) so declToCatalogEntry's Record<string, unknown> index signature —
    // which carries `category` — survives the enrichment (object-spread would drop it → no category).
    const revisionScopes = [
      managedRevisionDomainId(binding),
      ...(binding ? ["__unbound__"] : []),
    ];
    const activeRevisionByName = new Map<
      string,
      { id: string; domainId: string | null }
    >();
    for (const domainId of revisionScopes) {
      for (const revision of listToolRevisions({
        tenantId: auth.tenantId,
        domainId,
      })) {
        if (
          revision.status === "active" &&
          !activeRevisionByName.has(revision.name)
        ) {
          activeRevisionByName.set(revision.name, {
            id: revision.id,
            domainId: revision.domainId,
          });
        }
      }
    }
    const created = listDeclarativeTools(
      req.auth?.tenantId,
      binding?.ontologyDomainId ?? null,
    )
      .map((tool) =>
        declToCatalogEntry(tool, activeRevisionByName.get(tool.name)),
      )
      .map((tool) => Object.assign(tool, rate(String(tool.name))));
    // Tenant-effective overlay: tenant packages can shadow a global tool, and
    // MCP/Skills expansion contributes "<server>.<tool>" entries that exist
    // nowhere in the global catalog. Surface both so the library reflects what
    // this tenant's agents can actually call.
    const registry = getExpandedTenantRegistry(auth.tenantSlug);
    const createdNames = new Set(created.map((t) => String(t.name)));
    const globalNames = new Set(
      globals.flatMap((tool) => [tool.name, ...(tool.aliases ?? [])]),
    );
    const globalsWithSource = globals.map((tool) => ({
      ...tool,
      source: registry?.tools?.[tool.name]
        ? ("tenant_override" as const)
        : ("global" as const),
      available: true,
    }));
    const tenantEffective: Record<string, unknown>[] = [];
    for (const [name, descriptor] of Object.entries(registry?.tools ?? {})) {
      if (globalNames.has(name) || createdNames.has(name)) continue;
      const source = name.includes(".") ? "mcp_or_skill" : "tenant";
      tenantEffective.push({
        name,
        category: source === "tenant" ? "tenant" : name.split(".")[0]!,
        summary: descriptor.description ?? `Tenant-effective tool '${name}'.`,
        description: descriptor.description,
        sourcePath: "tenant-effective registry",
        origin: source,
        source,
        available: true,
        sideEffect: "write",
        testPolicy: "block",
        ...rate(name),
      });
    }
    const tools = [...globalsWithSource, ...created, ...tenantEffective];
    return reply.ok({
      tools,
      count: tools.length,
      createdCount: created.length,
      categories: Array.from(new Set(tools.map((t) => t.category as string))).sort(),
    });
  });

  // ── Managed generated-tool revision lifecycle ─────────────────────────────
  // Drafts are intentionally separate from GET /tools: that endpoint is the
  // executable catalog. Surfacing a draft there would make discovery look like
  // authorization and recreate the direct-to-runtime bug this ledger prevents.
  app.get<{
    Querystring: {
      name?: string;
      status?: string;
      limit?: string;
      cursor?: string;
      domain_id?: string;
    };
  }>("/tools/revisions", async (req, reply) => {
    const auth = requirePermission(req, "tools.read");
    const binding = getFactoryDomainBinding(auth.tenantId);
    const status = String(req.query.status ?? "").trim();
    if (
      status &&
      !new Set(["draft", "active", "retired", "rejected"]).has(status)
    ) {
      return reply.fail(
        "INVALID_TOOL_REVISION_STATUS",
        "status 只能是 draft/active/retired/rejected",
        400,
      );
    }
    const rawLimit = Number(req.query.limit ?? 25);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return reply.fail(
        "INVALID_PAGINATION",
        "limit 必须是正整数（最大 100）",
        400,
      );
    }
    try {
      const page = listToolRevisionPage({
        tenantId: auth.tenantId,
        domainId: requestedManagedRevisionDomainId(
          binding,
          req.query.domain_id,
        ),
        name: String(req.query.name ?? "").trim() || undefined,
        status: status
          ? (status as "draft" | "active" | "retired" | "rejected")
          : undefined,
        limit: rawLimit,
        cursor: String(req.query.cursor ?? "").trim() || undefined,
      });
      return reply.ok(page);
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  });

  app.get<{
    Params: { name: string };
    Querystring: {
      status?: string;
      limit?: string;
      cursor?: string;
      domain_id?: string;
    };
  }>("/tools/:name/revisions", async (req, reply) => {
    const auth = requirePermission(req, "tools.read");
    const binding = getFactoryDomainBinding(auth.tenantId);
    const name = decodeURIComponent(req.params.name);
    const status = String(req.query.status ?? "").trim();
    if (
      status &&
      !new Set(["draft", "active", "retired", "rejected"]).has(status)
    ) {
      return reply.fail(
        "INVALID_TOOL_REVISION_STATUS",
        "status 只能是 draft/active/retired/rejected",
        400,
      );
    }
    const limit = Number(req.query.limit ?? 25);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return reply.fail(
        "INVALID_PAGINATION",
        "limit 必须是 1..100 的整数",
        400,
      );
    }
    try {
      return reply.ok(listToolRevisionPage({
        tenantId: auth.tenantId,
        domainId: requestedManagedRevisionDomainId(
          binding,
          req.query.domain_id,
        ),
        name,
        status: status
          ? (status as "draft" | "active" | "retired" | "rejected")
          : undefined,
        limit,
        cursor: String(req.query.cursor ?? "").trim() || undefined,
      }));
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  });

  app.post<{
    Params: { name: string; revisionId: string };
    Body: {
      expectedActiveRevisionId?: string | null;
      revisionDomainId?: string;
    };
  }>("/tools/:name/revisions/:revisionId/activate", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    const actor = auth.userId ?? auth.email;
    if (!actor) {
      return reply.fail(
        "AUTH_ACTOR_REQUIRED",
        "激活工具需要可审计的登录用户身份",
        403,
      );
    }
    const name = decodeURIComponent(req.params.name);
    const revisionId = decodeURIComponent(req.params.revisionId);
    const binding = getFactoryDomainBinding(auth.tenantId);
    let revisionDomainId: string | undefined;
    if (
      !req.body ||
      !Object.prototype.hasOwnProperty.call(
        req.body,
        "expectedActiveRevisionId",
      ) ||
      (req.body.expectedActiveRevisionId !== null &&
        (typeof req.body.expectedActiveRevisionId !== "string" ||
          !req.body.expectedActiveRevisionId.trim()))
    ) {
      return reply.fail(
        "EXPECTED_ACTIVE_REVISION_REQUIRED",
        "激活/回滚必须带 expectedActiveRevisionId；首次激活传 null，防止并发覆盖",
        400,
      );
    }
    try {
      revisionDomainId = requestedManagedRevisionDomainId(
        binding,
        req.body.revisionDomainId,
      );
      const current = getToolRevision({
        tenantId: auth.tenantId,
        domainId: revisionDomainId,
        revisionId,
        name,
      });
      if (!current) {
        throw new ToolRevisionError(
          "TOOL_REVISION_NOT_FOUND",
          "revision 不属于这个工具名",
          404,
        );
      }
      const revision = await activateToolRevision({
        tenantId: auth.tenantId,
        domainId: revisionDomainId,
        revisionId,
        actor,
        expectedActiveRevisionId:
          req.body.expectedActiveRevisionId === null
            ? null
            : req.body.expectedActiveRevisionId.trim(),
      });
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: current.status === "retired"
          ? "tool.revision.rollback"
          : "tool.revision.activate",
        targetType: "tool_revision",
        targetId: revision.id,
        meta: {
          name: revision.name,
          version: revision.version,
          definitionHash: revision.definitionHash,
          activationProbeHash: revision.activationProbeHash,
          revisionDomainId,
        },
      });
      return reply.ok({ activated: true, revision });
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "tool.revision.activate",
          targetType: "tool_revision",
          targetId: revisionId,
          meta: {
            decision: "deny",
            outcome: "failed",
            errorCode: error.code,
            name,
            revisionDomainId: revisionDomainId ?? null,
          },
        });
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  });

  app.post<{
    Params: { name: string; revisionId: string };
    Body: { revisionDomainId?: string };
  }>("/tools/:name/revisions/:revisionId/reject", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    const actor = auth.userId ?? auth.email;
    if (!actor) {
      return reply.fail(
        "AUTH_ACTOR_REQUIRED",
        "拒绝工具草稿需要可审计的登录用户身份",
        403,
      );
    }
    const name = decodeURIComponent(req.params.name);
    const revisionId = decodeURIComponent(req.params.revisionId);
    const binding = getFactoryDomainBinding(auth.tenantId);
    let revisionDomainId: string | undefined;
    try {
      revisionDomainId = requestedManagedRevisionDomainId(
        binding,
        req.body?.revisionDomainId,
      );
      const current = getToolRevision({
        tenantId: auth.tenantId,
        domainId: revisionDomainId,
        revisionId,
        name,
      });
      if (!current) {
        throw new ToolRevisionError(
          "TOOL_REVISION_NOT_FOUND",
          "revision 不属于这个工具名",
          404,
        );
      }
      const revision = rejectToolRevision({
        tenantId: auth.tenantId,
        domainId: revisionDomainId,
        revisionId,
        actor,
      });
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "tool.revision.reject",
        targetType: "tool_revision",
        targetId: revision.id,
        meta: {
          name: revision.name,
          version: revision.version,
          definitionHash: revision.definitionHash,
          revisionDomainId,
        },
      });
      return reply.ok({ rejected: true, revision });
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "tool.revision.reject",
          targetType: "tool_revision",
          targetId: revisionId,
          meta: {
            decision: "deny",
            outcome: "failed",
            errorCode: error.code,
            name,
            revisionDomainId: revisionDomainId ?? null,
          },
        });
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  });

  // ── Human-confirmed, non-secret integration profiles ───────────────────────
  app.get<{ Params: { name: string }; Querystring: { environment?: string } }>("/tools/:name/profiles", async (req, reply) => {
    const auth = requirePermission(req, "tools.read");
    const name = decodeURIComponent(req.params.name);
    const binding = getFactoryDomainBinding(auth.tenantId);
    const globalCatalog = listGlobalTools().find((candidate) => candidate.name === name);
    const declarative = globalCatalog
      ? undefined
      : listDeclarativeTools(auth.tenantId, binding?.ontologyDomainId ?? null).find((candidate) => candidate.name === name);
    const tool = globalCatalog ? globalCatalogAsRealTool(globalCatalog) : declarative ? persistedToolAsRealTool(declarative) : undefined;
    if (!tool) return reply.fail("NOT_FOUND", `没有工具「${name}」`, 404);
    const environment = req.query.environment;
    if (environment !== undefined && !isIntegrationProfileEnvironment(environment)) {
      return reply.fail("INVALID_PROFILE_ENVIRONMENT", "environment 必须是 sandbox 或 production。", 400);
    }
    const profiles = listIntegrationProfiles(auth.tenantId, binding?.ontologyDomainId, name, environment).map((profile) => ({
      ...profile,
      validation: validateIntegrationToolConfig(tool, profile.config),
    }));
    return reply.ok({ profiles, count: profiles.length });
  });

  app.put<{
    Params: { name: string; profileKey: string };
    Body: { environment?: string; config?: unknown };
  }>("/tools/:name/profiles/:profileKey", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    if (hasFactoryActiveWork(auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "这个 tenant 正在做沙箱验证、报告生成或 promotion。为避免运行中途替换集成配置，请等本轮结束后再修改 profile。",
        409,
      );
    }
    const name = decodeURIComponent(req.params.name);
    const profileKey = decodeURIComponent(req.params.profileKey);
    const environment = req.body?.environment;
    if (!isIntegrationProfileEnvironment(environment)) {
      return reply.fail("INVALID_PROFILE_ENVIRONMENT", "请明确选择 sandbox 或 production；两套配置不能共用。", 400);
    }
    const binding = getFactoryDomainBinding(auth.tenantId);
    const globalCatalog = listGlobalTools().find((candidate) => candidate.name === name);
    const declarative = globalCatalog
      ? undefined
      : listDeclarativeTools(auth.tenantId, binding?.ontologyDomainId ?? null).find((candidate) => candidate.name === name);
    const tool = globalCatalog ? globalCatalogAsRealTool(globalCatalog) : declarative ? persistedToolAsRealTool(declarative) : undefined;
    if (!tool) return reply.fail("NOT_FOUND", `没有工具「${name}」`, 404);
    const confirmedBy = auth.userId ?? auth.email;
    if (!confirmedBy) {
      return reply.fail("AUTH_ACTOR_REQUIRED", "当前登录凭据没有可验证的用户身份，不能确认集成配置。", 403);
    }
    const result = saveIntegrationProfile({
      tenantId: auth.tenantId,
      domainId: binding?.ontologyDomainId,
      profileKey,
      environment,
      tool,
      config: req.body?.config,
      confirmedBy,
    });
    if (!result.ok) {
      return reply.fail("INVALID_INTEGRATION_PROFILE", result.error, 400);
    }
    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "integration_profile.confirm",
      targetType: "tool",
      targetId: name,
      meta: {
        profileKey,
        environment,
        domain: binding?.ontologyDomainId ?? null,
        ready: result.validation.ready,
        envRefs: result.validation.envRefs,
        missingEnvRefs: result.validation.missingEnvRefs,
      },
    });
    return reply.ok({ profile: result.profile, validation: result.validation });
  });

  app.delete<{ Params: { name: string; profileKey: string }; Querystring: { environment?: string } }>("/tools/:name/profiles/:profileKey", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    if (hasFactoryActiveWork(auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "这个 tenant 正在做沙箱验证、报告生成或 promotion。为避免撤销正在使用的集成配置，请等本轮结束后再删除 profile。",
        409,
      );
    }
    const name = decodeURIComponent(req.params.name);
    const profileKey = decodeURIComponent(req.params.profileKey);
    const environment = req.query.environment;
    if (!isIntegrationProfileEnvironment(environment)) {
      return reply.fail("INVALID_PROFILE_ENVIRONMENT", "删除 profile 时必须明确 environment=sandbox 或 environment=production。", 400);
    }
    const binding = getFactoryDomainBinding(auth.tenantId);
    const deleted = deleteIntegrationProfile(auth.tenantId, binding?.ontologyDomainId, name, profileKey, environment);
    if (!deleted) return reply.fail("NOT_FOUND", `没有 integration profile「${profileKey}」`, 404);
    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "integration_profile.delete",
      targetType: "tool",
      targetId: name,
      meta: { profileKey, environment, domain: binding?.ontologyDomainId ?? null },
    });
    return reply.ok({ deleted: true, name, profileKey, environment });
  });

  // ── POST generate-from-doc: fetch + LLM-extract a draft contract (no save) ────
  app.post<{ Body: { url?: string; text?: string; intent?: string } }>("/tools/generate-from-doc", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    if (!isGatewayConfigured()) return reply.fail("LLM_UNCONFIGURED", "未配置 LLM 网关，无法自动提炼；可直接手填工具契约。", 400);
    const intent = String(req.body?.intent ?? "").trim();
    if (!intent) return reply.fail("BAD_REQUEST", "请提供 tool_intent（这个工具要干嘛）。", 400);
    let doc = String(req.body?.text ?? "").trim();
    const url = String(req.body?.url ?? "").trim();
    if (!doc && url) {
      try {
        const res = await safeFetch(url, { headers: { accept: "text/html,text/plain,*/*" } });
        doc = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
      } catch (e) {
        return reply.fail("FETCH_FAILED", `抓取文档失败：${(e as Error).message}`, 400);
      }
    }
    if (!doc) return reply.fail("BAD_REQUEST", "没有文档文本可提炼——给一个公网 API 文档 url 或把 text 贴进来。", 400);
    try {
      const text = await chatOnce(EXTRACT_SYS, `工具意图：${intent}\n\nAPI 文档文本（截断）：\n${doc.slice(0, 5000)}`, {
        temperature: 0.2,
        maxTokens: 1200,
        models: modelChain("review"),
        purpose: "tool-contract.extract",
        context: {
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          domain: getFactoryDomainBinding(auth.tenantId)?.ontologyDomainId,
        },
      });
      const m = text.match(/\{[\s\S]*\}/);
      const rawDraft = m
        ? (JSON.parse(m[0]) as Record<string, unknown>)
        : null;
      if (!rawDraft || !rawDraft.name) return reply.fail("EXTRACT_FAILED", "没能从文档提炼出契约；换个更具体的 intent，或直接手填。", 422);
      return reply.ok({
        draft: selectGeneratedToolDraftFields(rawDraft),
      });
    } catch (e) {
      return reply.fail("EXTRACT_FAILED", `提炼失败：${(e as Error).message}`, 422);
    }
  });

  // ── POST: persist a governed non-executable revision draft ───────────────────
  app.post<{
    Body: {
      name?: string; description?: string; method?: string; url_template?: string;
      headers?: Record<string, string>; body_template?: string; side_effect?: string;
      request_spec?: unknown; response_spec?: unknown; examples?: unknown;
      operation?: string; effect_scope?: string; sandbox_policy?: string;
      params_schema?: Record<string, unknown>; returns_schema?: Record<string, unknown>;
      capabilities?: DeclarativeTool["capabilities"];
      /** Retained only so old clients receive a structured rejection. There is
       * no direct-to-projection publication path. */
      shared?: boolean;
      trusted_manual_publish?: boolean;
    };
  }>("/tools", async (req, reply) => {
    requirePermission(req, "agents.write");
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) return reply.fail("BAD_REQUEST", "工具名不能为空（建议带命名空间，如 acme.createTicket）。", 400);
    if (!String(b.url_template ?? "").trim()) return reply.fail("BAD_REQUEST", "url_template 不能为空。", 400);
    if (!req.auth) return reply.fail("UNAUTHORIZED", "需要租户上下文", 401);
    if (b.shared === true || b.trusted_manual_publish === true) {
      return reply.fail(
        "DIRECT_TOOL_PUBLISH_DISABLED",
        "共享/直发 active projection 已禁用。请先创建 tenant/domain revision 草稿，完成 exact attested probe，再由登录用户激活。",
        409,
      );
    }
    if (hasFactoryActiveWork(req.auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "沙箱验证、报告或 promotion 正在使用当前工具快照。为避免运行中途换掉能力定义，请等本轮结束后再保存工具。",
        409,
      );
    }
    const binding = getFactoryDomainBinding(req.auth.tenantId);
    const method = String(b.method ?? "").trim().toUpperCase();
    const urlTemplate = String(b.url_template ?? "").trim();
    if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
      return reply.fail("INVALID_TOOL_CONTRACT", "method 必须明确为 GET/HEAD/POST/PUT/PATCH/DELETE；未知 method 不能按只读保存。", 400);
    }
    try {
      const parsedUrl = new URL(urlTemplate);
      if (!new Set(["http:", "https:"]).has(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
        return reply.fail("INVALID_TOOL_CONTRACT", "url_template 只允许不含用户名/密码的绝对 http(s) URL。", 400);
      }
    } catch {
      return reply.fail("INVALID_TOOL_CONTRACT", "url_template 必须是绝对 http(s) URL。", 400);
    }
    if (b.headers !== undefined) {
      if (!b.headers || typeof b.headers !== "object" || Array.isArray(b.headers)) {
        return reply.fail("INVALID_TOOL_CONTRACT", "headers 必须是字符串映射对象。", 400);
      }
      const invalidHeader = Object.entries(b.headers).find(([key, value]) => !key.trim() || typeof value !== "string");
      if (invalidHeader) return reply.fail("INVALID_TOOL_CONTRACT", `header ${invalidHeader[0] || "(empty)"} 必须是字符串。`, 400);
    }
    if (b.body_template !== undefined && (typeof b.body_template !== "string" || !b.body_template)) {
      return reply.fail("INVALID_TOOL_CONTRACT", "body_template 必须是非空字符串。", 400);
    }
    const httpContract = parseDeclarativeHttpContract({
      method,
      bodyTemplate:
        typeof b.body_template === "string" ? b.body_template : undefined,
      requestSpec: b.request_spec,
      responseSpec: b.response_spec,
      examples: b.examples,
    });
    if (!httpContract.ok) {
      return reply.fail(
        "INVALID_TOOL_CONTRACT",
        httpContract.error,
        400,
      );
    }
    const sensitiveDefinitionPath = findSensitiveInputPath({
      url_template: urlTemplate,
      headers: b.headers,
      body_template: b.body_template,
      examples: b.examples,
    }, "tool");
    if (sensitiveDefinitionPath) {
      return reply.fail("SECRET_INPUT_REJECTED", `${sensitiveDefinitionPath} 含字面凭证；请使用 {config_key} 占位符。`, 400);
    }
    const parsedCapabilities = parseCapabilityDescriptors(b.capabilities);
    if (!parsedCapabilities.ok) return reply.fail("INVALID_TOOL_CONTRACT", parsedCapabilities.error, 400);
    const sideEffectPolicy = validateDeclarativeToolPolicy({
      method,
      declaredSideEffect: b.side_effect,
      bodyTemplate: b.body_template ? String(b.body_template) : undefined,
      requestSpec: httpContract.requestSpec,
      capabilities: parsedCapabilities.capabilities,
    });
    if (!sideEffectPolicy.ok) return reply.fail("INVALID_TOOL_CONTRACT", sideEffectPolicy.error, 400);
    const executionPolicy = {
      operation: b.operation,
      effectScope: b.effect_scope,
      sandboxPolicy: b.sandbox_policy,
    };
    if (!isGeneratedToolExecutionPolicy(executionPolicy) || executionPolicy.effectScope !== "external") {
      return reply.fail(
        "INVALID_TOOL_CONTRACT",
        "请明确提供 operation、effect_scope=external 和 sandbox_policy。我们不会根据 HTTP method、side_effect 或工具名替你猜执行权限。",
        400,
      );
    }
    const dt: DeclarativeTool = {
      name,
      description: String(b.description ?? ""),
      method,
      urlTemplate,
      headers: b.headers && typeof b.headers === "object" ? b.headers : undefined,
      bodyTemplate: b.body_template ? String(b.body_template) : undefined,
      requestSpec: httpContract.requestSpec,
      responseSpec: httpContract.responseSpec,
      examples: httpContract.examples,
      sideEffect: sideEffectPolicy.sideEffect,
      ...executionPolicy,
      // Domain is descriptive/selection metadata; ownership is the tenant scope
      // persisted separately in factory_tools.scope_key.
      // An unbound tenant may still author a private, tenant-wide tool. `null`
      // no longer means "shared" (scope_key does), it means the tool is not
      // restricted to one ontology id and will remain available after a later
      // explicit ontology connection.
      domain: binding?.ontologyDomainId ?? null,
      paramsSchema: b.params_schema && typeof b.params_schema === "object" ? b.params_schema : undefined,
      returnsSchema: b.returns_schema && typeof b.returns_schema === "object" ? b.returns_schema : undefined,
      capabilities: parsedCapabilities.capabilities.length ? parsedCapabilities.capabilities : undefined,
      probeStatus: "required",
    };
    const actor =
      req.auth.userId ??
      req.auth.email ??
      `token:${req.auth.tenantId}`;
    let revision: ReturnType<typeof createToolDraft>;
    try {
      revision = createToolDraft({
        tenantId: req.auth.tenantId,
        domainId: managedRevisionDomainId(binding),
        tool: dt,
        actor,
        source: "manual",
      });
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
    writeAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId ?? undefined,
      action: "tool.revision.create",
      targetType: "tool_revision",
      targetId: revision.id,
      meta: {
        method: dt.method,
        urlTemplate: dt.urlTemplate,
        sideEffect: dt.sideEffect,
        operation: dt.operation,
        effectScope: dt.effectScope,
        sandboxPolicy: dt.sandboxPolicy,
        shared: false,
        lifecycle: revision.status,
        revisionId: revision.id,
        version: revision.version,
        definitionHash: revision.definitionHash,
        probeStatus: dt.probeStatus,
      },
    });
    return reply.ok({
      // `saved` means durably persisted, not runtime-active. Older clients
      // retain their success path while lifecycle/runtimeActive are explicit.
      saved: true,
      draft: revision.status === "draft",
      name: dt.name,
      revisionId: revision.id,
      version: revision.version,
      definitionHash: revision.definitionHash,
      lifecycle: revision.status,
      runtimeActive: revision.status === "active",
      activation: revision.activation,
      sideEffect: dt.sideEffect,
      operation: dt.operation,
      effectScope: dt.effectScope,
      sandboxPolicy: dt.sandboxPolicy,
      shared: false,
    });
  });

  // ── POST probe: real guarded call + schema validation + canonical cassette ───
  app.post<{
    Params: { name: string };
    Body: {
      args?: Record<string, unknown>;
      config?: Record<string, unknown>;
      persist_cassette?: boolean;
      revision_id?: string;
      revision_domain_id?: string;
    };
  }>("/tools/:name/probe", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("UNAUTHORIZED", "需要租户上下文", 401);
    if (hasFactoryActiveWork(req.auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "这个 tenant 正在做沙箱验证、报告或 promotion；本轮结束前不能刷新工具探针证据。",
        409,
      );
    }
    const binding = getFactoryDomainBinding(req.auth.tenantId);
    const name = decodeURIComponent(req.params.name);
    const revisionId = String(req.body?.revision_id ?? "").trim() || undefined;
    const args = req.body?.args && typeof req.body.args === "object" ? req.body.args : {};
    let config = req.body?.config && typeof req.body.config === "object" ? req.body.config : undefined;
    const secretArg = findSensitiveProbeInputPath(args);
    if (secretArg) return reply.fail("SECRET_INPUT_REJECTED", `${secretArg} 不能携带凭证；请通过服务器环境变量配置。`, 400);
    const literalSecret = Object.entries(config ?? {}).find(([key, value]) =>
      /^(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)$/i.test(key) && value != null && String(value).trim() !== "",
    );
    if (literalSecret) return reply.fail("SECRET_INPUT_REJECTED", `config.${literalSecret[0]} 禁止传字面 secret；请改用 *_env 字段引用服务器环境变量名。`, 400);
    const badEnvRef = Object.entries(config ?? {}).find(([key, value]) => /_env$/i.test(key) && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)));
    if (badEnvRef) return reply.fail("BAD_CONFIG_ENV_REF", `config.${badEnvRef[0]} 必须是合法环境变量名。`, 400);
    const actor = req.auth.userId ?? req.auth.email ?? `token:${req.auth.tenantId}`;
    let revisionDomainId: string;
    try {
      revisionDomainId = requestedManagedRevisionDomainId(
        binding,
        req.body?.revision_domain_id,
      );
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
    const revision = revisionId
      ? getToolRevision({
          tenantId: req.auth.tenantId,
          domainId: revisionDomainId,
          revisionId,
          name,
        })
      : undefined;
    if (revisionId && !revision) {
      return reply.fail(
        "TOOL_REVISION_NOT_FOUND",
        "没有这个 tenant/domain 下的工具 revision",
        404,
      );
    }
    if (
      revision &&
      revision.status !== "draft" &&
      revision.status !== "retired"
    ) {
      return reply.fail(
        "TOOL_REVISION_NOT_PROBEABLE",
        `revision 状态 ${revision.status} 不能通过草稿 probe 路径执行`,
        409,
      );
    }
    if (revision && !revision.activation.eligible) {
      return reply.code(409).send({
        ok: false,
        error: {
          code: "PROBE_WRITE_LIFECYCLE_UNAVAILABLE",
          message: revision.activation.blockers[0]!.message,
        },
        status: "blocked",
        blockers: revision.activation.blockers,
      });
    }
    const persisted = revision?.definition
      ?? listDeclarativeTools(req.auth.tenantId, binding?.ontologyDomainId ?? null)
        .find((candidate) => candidate.name === name);
    const globalCatalog = persisted ? undefined : listGlobalTools().find((candidate) => candidate.name === name);
    const globalDescriptor = globalCatalog ? globalToolRegistry.get(globalCatalog.name) : undefined;
    if (!persisted && (!globalCatalog || !globalDescriptor)) return reply.fail("NOT_FOUND", `没有可 probe 的工具「${name}」`, 404);
    const realTool = globalCatalog ? globalCatalogAsRealTool(globalCatalog) : persisted ? persistedToolAsRealTool(persisted) : undefined;
    const executionPolicy = realToolExecutionPolicy(realTool);
    if (!executionPolicy) {
      return reply.fail(
        "TOOL_EXECUTION_POLICY_REQUIRED",
        "这个工具还没有完整、可审核的 operation/effectScope/sandboxPolicy，所以本次不会执行。请先在工具库补齐；系统不会从 sideEffect、HTTP method 或名字推断。",
        428,
      );
    }
    // This direct API has no durable factory ask_user challenge/consumption
    // proof. A request boolean is not human authorization, so every tool whose
    // reviewed policy requires an attempt grant is disabled here. Such probes
    // must run through probe_tool's exact one-shot human authorization path.
    if (executionPolicy.sandboxPolicy === "requires_attempt_grant") {
      const safety = inspectWriteProbeSafety(
        realTool!.sideEffect,
        realTool!.catalogDefinition?.probeSafety ?? realTool!.declarativeDefinition?.probeSafety,
      );
      if (safety.status === "needs_config") {
        return reply.code(428).send({
          ok: false,
          error: { code: "PROBE_CANARY_CONFIG_REQUIRED", message: safety.question },
          status: safety.status,
          next: safety.next,
          missing: safety.missing,
        });
      }
      return reply.fail(
        "PROBE_HUMAN_AUTHORIZATION_REQUIRED",
        "这个工具可能修改真实系统。直接 API 无法证明一次性人工授权，因此禁止执行；请在 Agent 工厂里确认这一次具体探针。",
        428,
      );
    }
    const configValidation = validateIntegrationToolConfig(realTool!, config ?? {});
    if (!configValidation.valid) {
      return reply.fail("BAD_TOOL_CONFIG", configValidation.issues.map((issue) => issue.message).join("；"), 400);
    }
    if (!configValidation.ready) {
      return reply.fail("TOOL_CONFIG_NOT_READY", `服务器尚未配置环境变量：${configValidation.missingEnvRefs.join(", ")}`, 428);
    }
    config = configValidation.config;
    // A verified receipt is useful only when the exact redacted cassette is
    // API-attested and durable.  `persist_cassette:false` is retained as a
    // backwards-compatible request field but no longer creates a green,
    // unusable receipt.  The unbound sentinel keeps pre-ontology diagnostics
    // isolated; connecting a real domain necessarily requires a fresh probe.
    const domainId = revision
      ? revisionDomainId
      : (binding?.ontologyDomainId ?? "__unbound__");
    const result = await new DrizzleToolStore(
      req.auth.tenantId,
      domainId,
      req.auth.tenantSlug,
    ).probe({
      domain: domainId,
      name,
      revisionId,
      args,
      config,
      actor,
    });
    if (result.classification === "authorization_required") {
      return reply.fail("PROBE_AUTHORIZATION_REQUIRED", result.error ?? "写操作 probe 需要明确确认", 428);
    }
    writeAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId ?? undefined,
      action: "tool.probe",
      targetType: "tool",
      targetId: name,
      meta: {
        origin: persisted ? "created" : "global",
        revisionId: revisionId ?? null,
        verified: result.verified,
        classification: result.classification,
        status: result.status,
        durationMs: result.durationMs,
        definitionHash: result.definitionHash,
        schemaHash: result.schemaHash,
        sideEffectsAuthorized: false,
      },
    });
    return reply.code(result.verified ? 200 : 422).send({ ok: result.verified, data: result });
  });

  // ── DELETE: controlled deactivate (immutable revisions are retained) ────────
  app.delete<{
    Params: { name: string };
    Querystring: {
      expectedActiveRevisionId?: string;
      revisionDomainId?: string;
    };
  }>("/tools/:name", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    const name = decodeURIComponent(req.params.name);
    const expectedActiveRevisionId = String(
      req.query.expectedActiveRevisionId ?? "",
    ).trim();
    if (!expectedActiveRevisionId) {
      return reply.fail(
        "EXPECTED_ACTIVE_REVISION_REQUIRED",
        "停用工具必须带 expectedActiveRevisionId，防止把审核期间刚切换的新版本删掉",
        400,
      );
    }
    let binding: ReturnType<typeof getFactoryDomainBinding> = null;
    let revisionDomainId: string | undefined;
    try {
      binding = getFactoryDomainBinding(auth.tenantId);
      revisionDomainId = requestedManagedRevisionDomainId(
        binding,
        req.query.revisionDomainId,
      );
      const actor = auth.userId ?? auth.email;
      if (!actor) {
        return reply.fail(
          "AUTH_ACTOR_REQUIRED",
          "停用工具需要可审计的登录用户身份",
          403,
        );
      }
      const revision = deactivateToolRevision({
        tenantId: auth.tenantId,
        domainId: revisionDomainId,
        name,
        actor,
        expectedActiveRevisionId,
      });
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "tool.revision.deactivate",
        targetType: "tool_revision",
        targetId: revision.id,
        meta: {
          decision: "allow",
          outcome: "succeeded",
          name,
          version: revision.version,
          definitionHash: revision.definitionHash,
          revisionDomainId,
        },
      });
      return reply.ok({
        deactivated: true,
        deleted: false,
        name,
        revision,
        retainedHistory: true,
      });
    } catch (error) {
      if (error instanceof ToolRevisionError) {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "tool.revision.deactivate",
          targetType: "tool",
          targetId: name,
          meta: {
            decision: "deny",
            outcome: "failed",
            errorCode: error.code,
            revisionDomainId: revisionDomainId ?? null,
          },
        });
        return reply.fail(error.code, error.message, error.statusCode);
      }
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "tool.revision.deactivate",
        targetType: "tool",
        targetId: name,
        meta: {
          decision: "deny",
          outcome: "failed",
          errorCode: "DELETE_FAILED",
          error: String((error as Error).message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 240),
          revisionDomainId: revisionDomainId ?? null,
        },
      });
      return reply.fail("DEACTIVATE_FAILED", "工具事务停用失败", 503);
    }
  });
}
