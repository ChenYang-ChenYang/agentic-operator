/**
 * Agent Factory — SSE brain stream (background-run model).
 *
 *   POST /v1/agent-factory/runs/start { domain, goal, conversation? } — start / continue
 *   GET  /v1/agent-factory/stream?run=<runId>                         — attach / reconnect
 *   POST /v1/agent-factory/stop      { runId }                — stop a running brain
 *   POST /v1/agent-factory/inject    { conversation, text, interactionId?, kind? } — HITL message / exact decision
 *   GET  /v1/agent-factory/{domains,runs,runs/:id}            — pickers + history
 *
 * The brain runs DETACHED in the in-process run-registry, so closing the EventSource
 * (navigating away) only unsubscribes — the run keeps going server-side and a later
 * reconnect re-attaches (or replays from the durable factory_runs row). A stop button
 * aborts explicitly. Large goals and attachment contents are accepted by the JSON start
 * endpoint (up to the server's configurable request-body limit); EventSource carries only
 * the opaque run id through the unbuffered web proxy.
 */

import type { FastifyInstance } from "fastify";
import {
  isGatewayConfigured,
  analyzeRun,
  humanMemoryQuestionKey,
  isStopIntent,
  parseTestCaseDecision,
  assertFactoryScopeRecommendationCurrent,
  createFactoryGenerationDirective,
  factoryGenerationGoal,
  recommendFactoryActionScope,
  FactoryGenerationDirectiveError,
  FactoryScopeRecommendationError,
  type BrainContinuationMode,
  type BrainEvent,
  type FactoryGenerationDirective,
  type FactoryHumanInteractionKind,
  type FactoryHumanMemoryKind,
  type FactoryInteractionPolicy,
  type OntologySource,
} from "@agentic/agent-factory";
import {
  FactoryRunStartRequestSchema,
  FactoryScopeRecommendationRequestSchema,
} from "@agentic/contracts";
import { requirePermission, writeAudit } from "../../plugins/rbac";
import {
  makeFactoryPorts,
  listRuns,
  getRun,
  deleteRun,
  restoreRun,
  deleteRunsByDomain,
  listAgentDrafts,
  listRunningRuns,
  DrizzleConversationStore,
  DrizzleReflectionWriter,
  DrizzleSkillStore,
  DrizzleHumanMemoryStore,
  humanMemoryFromInjectedMessage,
} from "../../services/agent-factory";
import { promoteDrafts } from "../../services/agent-factory/promote";
import {
  FsUploadedOntologyStore,
  slugifyDomain,
} from "../../services/agent-factory/uploaded-ontology-store";
import {
  DraftVersionConflictError,
  FsAgentDraftStore,
  draftEditorSensitiveCategory,
} from "../../services/agent-factory/agent-draft-store";
import {
  assessDraftPromotionReadiness,
  createHumanReviewReceipt,
  previewDraftPromotion,
} from "../../services/agent-factory/draft-review";
import {
  enqueueHumanMessage,
  peekHumanMessages,
} from "../../services/agent-factory/mailbox";
import {
  startRun,
  subscribeRun,
  abortRun,
  readDurableRun,
  forceFinalizeAborted,
  sweepZombieRuns,
  isActiveRun,
  emitUserMessage,
  FactoryMessageDeliveryError,
} from "../../services/agent-factory/run-registry";
import {
  getIssuedFactoryScopeRecommendation,
  issueFactoryScopeRecommendation,
} from "../../services/agent-factory/scope-recommendation-store";
import {
  listReportJobs,
  getReportJob,
  startOntologyReportJob,
  deleteReportJob,
  type ReportFormat,
} from "../../services/agent-factory/report-jobs";
import {
  listDeclarativeTools,
} from "../../services/agent-factory/declarative-tool";
import {
  deactivateToolRevision,
  listToolRevisions,
  ToolRevisionError,
} from "../../services/agent-factory/tool-revision-store";
import {
  bindingMatchesDomain,
  clearFactoryDomainBinding,
  FactoryDomainBindingBlockedError,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
} from "../../services/agent-factory/domain-binding";
import {
  FactoryDomainDiscoveryError,
  discoverFactoryDomainBindingCandidate,
  makeFactoryDomainDiscoverySources,
  type FactoryDomainRequestedSource,
} from "../../services/agent-factory/factory-domain-discovery";
import type { AuthedContext } from "../../plugins/auth";
import { hasFactoryActiveWork } from "../../services/agent-factory/active-work";
import { withFactoryTenantLock } from "../../services/agent-factory/tenant-lock";
import {
  createFactoryReworkSeed,
  ReworkSeedError,
} from "../../services/agent-factory/rework-seed";
import {
  DraftSandboxError,
  finishDraftSandbox,
  getDraftSandboxInputContract,
  prepareDraftSandboxReview,
} from "../../services/agent-factory/draft-sandbox-finish";
import { registerFactoryFixtureAssetRoutes } from "./agent-factory-fixture-assets";
import { AuthoritativeOntologyPromotionError } from "../../services/agent-factory/authoritative-ontology-evidence";
import { createSseDrainRegistry } from "../../plugins/sse-drain";

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

type FactoryMutationOutcome = "succeeded" | "failed";

/**
 * Factory mutations are high-risk operator actions (they create/delete durable
 * evidence or change what is live).  Keep one deliberately small audit shape:
 * identifiers/counts are useful for supervision, while goals, prompts, memory
 * answers, ontology bodies and injected text must never be copied into the log.
 */
function auditFactoryMutation(
  auth: AuthedContext,
  opts: {
    action: string;
    targetType: string;
    targetId?: string | null;
    outcome: FactoryMutationOutcome;
    errorCode?: string;
    error?: unknown;
    meta?: Record<string, unknown>;
  },
): void {
  const error =
    opts.error == null
      ? undefined
      : String((opts.error as { message?: unknown })?.message ?? opts.error)
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 240);
  writeAudit(auth, {
    action: opts.action,
    targetType: opts.targetType,
    targetId: opts.targetId,
    decision: opts.outcome === "succeeded" ? "allow" : "deny",
    meta: {
      outcome: opts.outcome,
      ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
      ...(error ? { error } : {}),
      ...(opts.meta ?? {}),
    },
  });
}

function factoryFailureStatus(error: unknown, inputStatus = 400): number {
  const message = String((error as { message?: unknown })?.message ?? error);
  return /(inngest|hot[- ]?swap|persist|storage|database|sqlite|eacces|enospc|eio|i\/o|cannot (?:read|write|save|delete|sync|durably)|unavailable|timeout|timed out|connection)/i.test(
    message,
  )
    ? 503
    : inputStatus;
}

function draftPatchFailureMessage(error: unknown): string {
  const message = String(
    (error as { message?: unknown })?.message ?? error,
  ).trim();
  if (!message) return "没有创建新版本，请刷新草稿后重试。";
  if (draftEditorSensitiveCategory(message)) {
    return "修改失败，错误信息里包含敏感内容，服务端已隐藏。请检查密钥引用和测试 fixture 的放置方式。";
  }
  if (/不能包含字面密钥|fixture bytes|fixture asset/i.test(message))
    return message;
  if (/完全相同|不需要创建新版本/.test(message)) return message;
  if (/先更新 Allmeta Ontology 后重新生成/.test(message)) return message;
  if (/^patch(?:\.set|\.unset)? 必须|同一个字段不能同时/.test(message))
    return message;
  if (/draft version not found|draft not found/i.test(message))
    return "这个草稿版本已经变化或不存在，请刷新后重新打开。";
  if (/draft version conflict/i.test(message))
    return "这个草稿已经产生了更新版本。为避免覆盖别人的修改，请刷新后重新打开再改。";
  if (
    /immutable or unknown|identity field changed|cannot be unset/i.test(message)
  )
    return "这个字段由系统维护，不能用草稿编辑器修改。";
  if (/generatedCode|compile|lint|typescript/i.test(message))
    return "修改后的代码没有通过安全检查或 TypeScript 编译，请修正后重试。";
  if (/invalid draft patch|must be|is invalid|has no expanded/i.test(message))
    return "修改后的内容不符合 Agent 运行契约，请检查字段类型、事件、工具和计划之间是否一致。";
  if (/patch must set or unset/i.test(message))
    return "没有检测到实际修改，请先改动一个字段。";
  return "没有创建新版本，请检查修改内容并重试。";
}

class FactoryDomainBindingError extends Error {
  constructor(
    readonly code: "domain_unbound" | "domain_mismatch" | "domain_unavailable",
    message: string,
  ) {
    super(message);
  }
}

async function bindingSnapshot(auth: AuthedContext) {
  const ports = makeFactoryPorts(auth.tenantSlug, auth.tenantId);
  // The binding picker is a control-plane catalog and must stay independent
  // from the currently bound runtime transport.  In particular, an existing
  // upload binding intentionally makes `ports.ontology.listDomains()` return
  // only tenant-owned uploads; using that list here made it impossible to
  // switch the tenant back to an authoritative Allmeta Domain.
  const discoverySources = makeFactoryDomainDiscoverySources(auth.tenantSlug);
  let domains: Awaited<ReturnType<OntologySource["listDomains"]>> = [];
  let catalogError: string | null = null;
  if (discoverySources.allmeta) {
    try {
      domains = await discoverySources.allmeta.listDomains();
    } catch (error) {
      catalogError =
        String((error as { message?: unknown })?.message ?? error)
          .trim()
          .slice(0, 500) || "Allmeta catalog unavailable";
    }
  }
  // Runtime reads never infer identity from similar names. Existing installations are
  // backfilled once by migration 0031; after that only an explicit PUT/upload may bind.
  const binding = getFactoryDomainBinding(auth.tenantId);
  // A persisted relation is an identity, not another user-entered lookup.  Do
  // not case-fold or silently rewrite it at runtime; migration 0031 performed
  // the one-time legacy reconciliation.  PUT may accept an unambiguous
  // case-insensitive user input, but the stored id must resolve exactly here.
  let boundDomain:
    | Awaited<ReturnType<OntologySource["listDomains"]>>[number]
    | null = null;
  if (binding?.source === "explicit") {
    boundDomain =
      domains.find((domain) => domain.id === binding.ontologyDomainId) ?? null;
  } else if (binding?.source === "upload") {
    boundDomain =
      (await discoverySources.upload.listDomains()).find(
        (domain) => domain.id === binding.ontologyDomainId,
      ) ?? null;
  } else if (binding) {
    boundDomain =
      (await ports.ontology.listDomains()).find(
        (domain) => domain.id === binding.ontologyDomainId,
      ) ?? null;
  }
  return { ports, domains, binding, boundDomain, catalogError };
}

async function requireBoundFactoryDomain(
  auth: AuthedContext,
  requested: string,
) {
  // A route-level scope check proves the persisted tenant/domain identity; it
  // must not fetch the whole Allmeta catalog (or any graph data) for unrelated
  // operations such as listing human memory or skills. Generation/reporting
  // still read the exact bound Ontology through their scoped ports and fail
  // closed when that authoritative source is unavailable.
  const binding = getFactoryDomainBinding(auth.tenantId);
  if (!binding) {
    throw new FactoryDomainBindingError(
      "domain_unbound",
      `业务领域「${auth.tenantSlug}」尚未连接本体，请先在 Agent 工厂选择或上传本体。`,
    );
  }
  if (
    binding.ontologyDomainId !== requested ||
    !bindingMatchesDomain(binding, requested)
  ) {
    throw new FactoryDomainBindingError(
      "domain_mismatch",
      `当前业务领域只允许操作已连接本体「${binding.ontologyDomainName ?? binding.ontologyDomainId}」(${binding.ontologyDomainId})，不能操作「${requested}」。`,
    );
  }
  // Upload provenance is an exact tenant-owned artifact identity. If its file
  // disappeared, do not let a same-id Allmeta/manifest domain take its place.
  if (binding.source === "upload") {
    const uploaded = await new FsUploadedOntologyStore().get(
      auth.tenantSlug,
      binding.ontologyDomainId,
    );
    if (!uploaded) {
      throw new FactoryDomainBindingError(
        "domain_unavailable",
        `当前连接的本体「${binding.ontologyDomainName ?? binding.ontologyDomainId}」(${binding.ontologyDomainId}) 已不可用，请重新连接或上传。`,
      );
    }
  }
}

/**
 * Fixture bytes need the same exact persisted domain identity, but uploading
 * or deleting a short-lived file must not fetch ontology data from Allmeta (or
 * touch RAAS) just to prove that identity.  Availability is enforced by the
 * normal run/preflight paths; this transport guard only compares the
 * tenant-owned run against the tenant's immutable persisted binding.
 */
async function requireFixtureBoundFactoryDomain(
  auth: AuthedContext,
  requested: string,
): Promise<void> {
  const binding = getFactoryDomainBinding(auth.tenantId);
  if (!binding) {
    throw new FactoryDomainBindingError(
      "domain_unbound",
      `业务领域「${auth.tenantSlug}」尚未连接本体，请先在 Agent 工厂选择或上传本体。`,
    );
  }
  if (!bindingMatchesDomain(binding, requested)) {
    throw new FactoryDomainBindingError(
      "domain_mismatch",
      `当前业务领域只允许操作已连接本体「${binding.ontologyDomainName ?? binding.ontologyDomainId}」(${binding.ontologyDomainId})，不能操作「${requested}」。`,
    );
  }
}

function bindingFailure(
  reply: { fail: (code: string, message: string, status: number) => unknown },
  error: unknown,
) {
  if (error instanceof FactoryDomainBindingError)
    return reply.fail(error.code, error.message, 409);
  throw error;
}

class FactoryRunStartRequestError extends Error {
  constructor(
    readonly code: "conversation_not_found" | "conversation_deleted",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function startFactoryRun(
  auth: AuthedContext,
  domain: string,
  goal: string,
  conversationId?: string,
  continuationMode?: BrainContinuationMode,
  control?: {
    interactionPolicy?: FactoryInteractionPolicy;
    generationDirective?: FactoryGenerationDirective;
    persistGoal?: string;
  },
): Promise<{ runId: string; mode: "started" | "attached" }> {
  return withFactoryTenantLock(auth.tenantId, async () => {
    await requireBoundFactoryDomain(auth, domain);
    let mode: "started" | "attached" = "started";
    let ontologyDomainRegistrationId: string | null | undefined;
    let runtimeProfileVersionId: string | null | undefined;
    if (conversationId) {
      // A continuation must name a real, tenant-owned conversation.  Treat a
      // foreign id exactly like a missing id and never manufacture a new run
      // under caller-controlled "conversation" input.
      const conversation = getRun(conversationId, auth.tenantId);
      if (!conversation) {
        throw new FactoryRunStartRequestError(
          "conversation_not_found",
          "conversation not found",
          404,
        );
      }
      if (conversation.deletedAt) {
        throw new FactoryRunStartRequestError(
          "conversation_deleted",
          "conversation is in the recycle bin; restore it before continuing",
          409,
        );
      }
      if (conversation.domain !== domain) {
        throw new FactoryDomainBindingError(
          "domain_mismatch",
          `该会话属于本体「${conversation.domain}」，不能在「${domain}」中继续。`,
        );
      }
      // A parked OntoCode/Factory conversation is pinned to immutable
      // execution bindings. Human-gate recovery must carry those pins back
      // into startRun; omitting them made an otherwise valid answer fail with
      // "another ontology domain registration" before it reached the mailbox.
      ontologyDomainRegistrationId =
        conversation.ontologyDomainRegistrationId;
      runtimeProfileVersionId = conversation.runtimeProfileVersionId;
      // There is no await between this liveness check and startRun: a live
      // conversation receives the goal through its mailbox and returns the
      // same run id; a terminal/orphaned one starts a new turn.
      mode = isActiveRun(conversationId) ? "attached" : "started";
    }
    const run = startRun({
      domain,
      goal,
      tenantId: auth.tenantId,
      tenantSlug: auth.tenantSlug,
      ontologyDomainRegistrationId,
      runtimeProfileVersionId,
      // A userless tenant token may start/steer a run, but it is not a human
      // responder and can never be promoted into authorization evidence.
      confirmedActor: auth.userId ?? auth.email ?? undefined,
      conversationId,
      continuationMode,
      interactionPolicy: control?.interactionPolicy,
      generationDirective: control?.generationDirective,
      persistGoal: control?.persistGoal,
    });
    return { runId: run.runId, mode };
  });
}

function durableHumanInteraction(ctx: Record<string, unknown>): {
  kind: FactoryHumanInteractionKind;
  interactionId: string | null;
} | null {
  const kind: FactoryHumanInteractionKind | null =
    ctx.awaitingClarify === true
      ? "clarify"
      : ctx.awaitingApproval === true && ctx.testDataSupplementPending !== true
        ? "test_approval"
        : ctx.awaitingBoundary === true
          ? "boundary"
          : null;
  if (!kind) return null;
  const interactions = ctx.humanInteractions;
  const candidate =
    interactions &&
    typeof interactions === "object" &&
    !Array.isArray(interactions)
      ? (interactions as Record<string, unknown>)[kind]
      : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { kind, interactionId: null };
  }
  const row = candidate as Record<string, unknown>;
  const interactionId =
    typeof row.interactionId === "string" ? row.interactionId.trim() : "";
  return row.kind === kind &&
    /^hitl_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      interactionId,
    )
    ? { kind, interactionId }
    : { kind, interactionId: null };
}

function gateSubmissionMatches(
  kind: FactoryHumanInteractionKind,
  text: string,
): boolean {
  if (kind === "clarify") return /^\[澄清回答\]\s*\S[\s\S]*$/.test(text);
  if (kind === "test_approval") return parseTestCaseDecision(text) !== null;
  const match = text.match(/^\[边界事件决策\]\s*([\s\S]+)$/);
  if (!match) return false;
  try {
    const value = JSON.parse(match[1]!.trim());
    return (
      Array.isArray(value) &&
      value.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).event === "string",
      )
    );
  } catch {
    return false;
  }
}

export async function agentFactoryRoutes(app: FastifyInstance) {
  const registerStreamDrain = createSseDrainRegistry(app);
  await registerFactoryFixtureAssetRoutes(app, {
    requireBoundDomain: requireFixtureBoundFactoryDomain,
  });

  app.get("/agent-factory/domains", async (req, reply) => {
    requirePermission(req, "agents.read");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    const { ports, domains, binding, boundDomain, catalogError } =
      await bindingSnapshot(req.auth);
    // Return action identities from the real bound ontology so consumers do
    // not depend on a static list or accept arbitrary free text.
    const boundActions = boundDomain
      ? (await ports.ontology.fetchOntology(boundDomain.id)).actions
          .map((action) => ({
            id: action.id,
            name: action.name,
            description: action.description ?? null,
            actor: action.actor,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    // gatewayConfigured lets the UI warn "LLM 未配置" instead of the brain silently
    // dead-ending on its first turn when no streaming gateway key is present.
    return reply.ok({
      domains,
      binding,
      boundDomain,
      boundActions,
      gatewayConfigured: isGatewayConfigured(),
      catalogError,
    });
  });

  // Explicitly connect the current runtime Domain to one ontology Domain. This is
  // the only mutation path for the relation; later generation/promotion is guarded
  // against this persisted id instead of guessing from names.
  app.put<{
    Body: {
      ontologyDomainId?: string;
      source?: FactoryDomainRequestedSource;
      confirmRebind?: boolean;
    };
  }>("/agent-factory/domain-binding", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    return withFactoryTenantLock(auth.tenantId, async () => {
      const requested = String(req.body?.ontologyDomainId ?? "").trim();
      if (!requested) {
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail("bad_request", "ontologyDomainId 必填", 400);
      }
      const requestedSource = req.body?.source;
      if (
        requestedSource !== undefined &&
        requestedSource !== "upload" &&
        requestedSource !== "allmeta"
      ) {
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          targetId: requested,
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail(
          "bad_request",
          "source 只能是 upload 或 allmeta",
          400,
        );
      }
      const swept = sweepZombieRuns(null, auth.tenantId);
      if (swept > 0) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.zombie_sweep",
          targetType: "factory_run",
          outcome: "succeeded",
          meta: { count: swept, source: "domain_binding" },
        });
      }
      if (
        listRunningRuns(null, auth.tenantId).length ||
        hasFactoryActiveWork(auth.tenantId)
      ) {
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          targetId: requested,
          outcome: "failed",
          errorCode: "factory_running",
        });
        return reply.fail(
          "factory_running",
          "当前业务领域仍有 Agent 工厂任务运行中，结束后才能更换本体连接。",
          409,
        );
      }
      let candidate: Awaited<
        ReturnType<typeof discoverFactoryDomainBindingCandidate>
      >;
      let current: ReturnType<typeof getFactoryDomainBinding>;
      try {
        candidate = await discoverFactoryDomainBindingCandidate({
          requestedId: requested,
          ...(requestedSource ? { requestedSource } : {}),
          sources: makeFactoryDomainDiscoverySources(auth.tenantSlug),
        });
        current = getFactoryDomainBinding(auth.tenantId);
      } catch (error) {
        if (error instanceof FactoryDomainDiscoveryError) {
          auditFactoryMutation(auth, {
            action: "agent_factory.domain.bind",
            targetType: "ontology_domain",
            targetId: requested,
            outcome: "failed",
            errorCode: error.code,
          });
          return reply.fail(
            error.code,
            error.message,
            error.code === "domain_not_found" ? 404 : 409,
          );
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          targetId: requested,
          outcome: "failed",
          errorCode: "domain_catalog_unavailable",
          error,
        });
        return reply.fail(
          "domain_catalog_unavailable",
          (error as Error).message,
          503,
        );
      }
      const selected = candidate.domain;
      const changesBindingIdentity =
        !!current &&
        (current.ontologyDomainId !== selected.id ||
          current.source !== candidate.bindingSource);
      if (changesBindingIdentity && req.body?.confirmRebind !== true) {
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          targetId: selected.id,
          outcome: "failed",
          errorCode: "confirm_rebind",
          meta: {
            previousDomainId: current!.ontologyDomainId,
            previousSource: current!.source,
            requestedSource: candidate.bindingSource,
          },
        });
        return reply.fail(
          "confirm_rebind",
          `更换连接会让旧本体「${current!.ontologyDomainId}」或旧来源「${current!.source}」的历史草稿退出当前视图；请确认后重试。`,
          409,
        );
      }
      try {
        await candidate.ontology.fetchOntology(selected.id); // fail closed on empty/unreachable source
        const binding = setFactoryDomainBinding(
          auth.tenantId,
          selected,
          candidate.bindingSource,
        );
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          targetId: binding.ontologyDomainId,
          outcome: "succeeded",
          meta: {
            source: binding.source,
            previousDomainId: current?.ontologyDomainId ?? null,
            previousSource: current?.source ?? null,
            rebound: changesBindingIdentity,
          },
        });
        return reply.ok({ binding, boundDomain: selected });
      } catch (e) {
        const message = (e as Error).message;
        const errorCode =
          e instanceof FactoryDomainBindingBlockedError ||
          message.startsWith("factory_running:")
            ? "factory_running"
            : "domain_unavailable";
        auditFactoryMutation(auth, {
          action: "agent_factory.domain.bind",
          targetType: "ontology_domain",
          targetId: selected.id,
          outcome: "failed",
          errorCode,
          error: e,
        });
        return reply.fail(
          errorCode,
          message,
          409,
          undefined,
          e instanceof FactoryDomainBindingBlockedError ? e.details : undefined,
        );
      }
    });
  });

  app.get<{
    Querystring: { domain?: string; limit?: string; deleted?: string };
  }>("/agent-factory/runs", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = req.query.domain ? String(req.query.domain) : null;
    const limit = req.query.limit
      ? Math.min(100, Number(req.query.limit) || 30)
      : 30;
    const deleted = req.query.deleted === "true" || req.query.deleted === "1";
    const tenantId = req.auth?.tenantId;
    if (domain && req.auth) {
      try {
        await requireBoundFactoryDomain(req.auth, domain);
      } catch (e) {
        return bindingFailure(reply, e);
      }
    }
    // Clear orphaned "运行中" rows (api/HMR restart left them with no live driver) so the
    // history list reflects reality, not zombies that can never reach a terminal state. Skip the
    // sweep for the recycle bin (deleted rows are already terminal/tombstoned).
    if (!deleted) {
      const swept = sweepZombieRuns(domain, tenantId);
      if (swept > 0 && req.auth) {
        auditFactoryMutation(req.auth, {
          action: "agent_factory.run.zombie_sweep",
          targetType: "factory_run",
          outcome: "succeeded",
          meta: { count: swept, domain, source: "run_list" },
        });
      }
    }
    return reply.ok({ runs: listRuns(domain, tenantId, limit, { deleted }) });
  });
  app.get<{ Params: { id: string } }>(
    "/agent-factory/runs/:id",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      const run = getRun(req.params.id, req.auth?.tenantId);
      if (!run || run.deletedAt)
        return reply.fail("not_found", "run not found", 404);
      return reply.ok({ run });
    },
  );

  // #6: AI run review — load the run's saved transcript, have an LLM score it + surface problems.
  app.post<{ Params: { id: string } }>(
    "/agent-factory/runs/:id/analyze",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.read");
      const run = getRun(req.params.id, auth.tenantId);
      if (!run || run.deletedAt) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.analyze",
          targetType: "factory_run",
          targetId: req.params.id,
          outcome: "failed",
          errorCode: "not_found",
        });
        return reply.fail("not_found", "run not found", 404);
      }
      try {
        const review = await analyzeRun(
          (run.transcript as BrainEvent[]) ?? [],
          { domain: (run as { domain?: string }).domain },
        );
        auditFactoryMutation(auth, {
          action: "agent_factory.run.analyze",
          targetType: "factory_run",
          targetId: req.params.id,
          outcome: "succeeded",
          meta: { domain: run.domain, transcriptEvents: run.transcript.length },
        });
        return reply.ok({ review });
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.analyze",
          targetType: "factory_run",
          targetId: req.params.id,
          outcome: "failed",
          errorCode: "analysis_failed",
          error,
          meta: { domain: run.domain },
        });
        return reply.fail(
          "analysis_failed",
          (error as Error).message ?? "运行分析失败",
          503,
        );
      }
    },
  );

  // Human-confirmed, domain-scoped memory.  This surface is deliberately
  // separate from LLM-managed consolidation so a pinned human fact cannot be
  // rewritten by an AI UPDATE/DELETE operation.
  app.get<{
    Querystring: { domain?: unknown; pinned?: unknown; limit?: unknown };
  }>("/agent-factory/memories", async (req, reply) => {
    requirePermission(req, "agents.read");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    const domain = String(req.query.domain ?? "").trim();
    if (!domain) return reply.fail("bad_request", "domain 必填", 400);
    try {
      await requireBoundFactoryDomain(req.auth, domain);
    } catch (error) {
      return bindingFailure(reply, error);
    }
    const pinnedOnly =
      req.query.pinned === true ||
      req.query.pinned === "true" ||
      req.query.pinned === "1";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const [memories, reflections] = await Promise.all([
      new DrizzleHumanMemoryStore(req.auth.tenantId, domain).list(domain, {
        confirmedOnly: true,
        pinnedOnly,
        limit,
      }),
      new DrizzleReflectionWriter(req.auth.tenantId, domain).list(domain),
    ]);
    return reply.ok({
      memories,
      // Domain-knowledge clients can display machine lessons next to human
      // ground truth without ever conflating their provenance or mutation API.
      reflections: reflections.map((reflection) => ({
        ...reflection,
        source: "ai" as const,
      })),
    });
  });

  app.post<{
    Body: {
      domain?: unknown;
      kind?: unknown;
      questionKey?: unknown;
      question?: unknown;
      answer?: unknown;
      context?: unknown;
      source?: unknown;
      conversation?: unknown;
      pinned?: unknown;
    };
  }>("/agent-factory/memories", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const domain = String(req.body?.domain ?? "").trim();
    const question = String(req.body?.question ?? "").trim();
    const answer = String(req.body?.answer ?? "").trim();
    const kind = String(
      req.body?.kind ?? "directive",
    ) as FactoryHumanMemoryKind;
    const failInput = (message: string) => {
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.upsert",
        targetType: "factory_human_memory",
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null, kind },
      });
      return reply.fail("bad_request", message, 400);
    };
    if (!domain || !question || !answer)
      return failInput("domain、question、answer 必填");
    if (!["clarify", "boundary", "test_approval", "directive"].includes(kind)) {
      return failInput(
        "kind 须为 clarify | boundary | test_approval | directive",
      );
    }
    if (req.body?.source != null && req.body.source !== "human") {
      return failInput("人工记忆的 source 只能是 human");
    }
    if (req.body?.pinned != null && typeof req.body.pinned !== "boolean") {
      return failInput("pinned 必须是 boolean");
    }
    try {
      await requireBoundFactoryDomain(auth, domain);
    } catch (error) {
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.upsert",
        targetType: "factory_human_memory",
        outcome: "failed",
        errorCode:
          error instanceof FactoryDomainBindingError
            ? error.code
            : "domain_check_failed",
        error,
        meta: { domain, kind },
      });
      return bindingFailure(reply, error);
    }
    const conversation =
      req.body?.conversation == null
        ? undefined
        : String(req.body.conversation).trim();
    if (conversation) {
      const run = getRun(conversation, auth.tenantId);
      if (!run || run.domain !== domain) {
        const errorCode = !run ? "conversation_not_found" : "domain_mismatch";
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.upsert",
          targetType: "factory_human_memory",
          outcome: "failed",
          errorCode,
          meta: { domain, kind, conversationId: conversation },
        });
        return !run
          ? reply.fail("conversation_not_found", "conversation not found", 404)
          : reply.fail("domain_mismatch", "conversation 不属于这个本体域", 409);
      }
    }
    const explicitKey =
      req.body?.questionKey == null ? "" : String(req.body.questionKey).trim();
    try {
      const memory = await new DrizzleHumanMemoryStore(
        auth.tenantId,
        domain,
      ).upsert(domain, {
        questionKey: explicitKey || humanMemoryQuestionKey(kind, question),
        kind,
        question,
        answer,
        context:
          req.body?.context == null ? undefined : String(req.body.context),
        source: "human",
        conversationId: conversation,
        confirmed: true,
        pinned: req.body?.pinned as boolean | undefined,
      });
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.upsert",
        targetType: "factory_human_memory",
        targetId: memory.id,
        outcome: "succeeded",
        meta: {
          domain,
          kind,
          conversationId: conversation ?? null,
          pinned: memory.pinned,
        },
      });
      return reply.ok({ memory });
    } catch (error) {
      const message = (error as Error).message ?? "memory persistence failed";
      const invalid =
        /^(human memory|factory human memory|invalid |questionKey|question |answer |context |conversationId|non-human )/i.test(
          message,
        );
      const errorCode = invalid ? "invalid_memory" : "memory_persist_failed";
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.upsert",
        targetType: "factory_human_memory",
        outcome: "failed",
        errorCode,
        error,
        meta: { domain, kind, conversationId: conversation ?? null },
      });
      return reply.fail(errorCode, message, invalid ? 400 : 503);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { domain?: unknown; pinned?: unknown };
  }>("/agent-factory/memories/:id/pin", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const id = decodeURIComponent(req.params.id);
    const domain = String(req.body?.domain ?? "").trim();
    if (!domain || typeof req.body?.pinned !== "boolean") {
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.pin",
        targetType: "factory_human_memory",
        targetId: id,
        outcome: "failed",
        errorCode: "bad_request",
      });
      return reply.fail("bad_request", "domain 与 boolean pinned 必填", 400);
    }
    try {
      await requireBoundFactoryDomain(auth, domain);
      const updated = await new DrizzleHumanMemoryStore(
        auth.tenantId,
        domain,
      ).pin(domain, id, req.body.pinned);
      if (!updated) {
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.pin",
          targetType: "factory_human_memory",
          targetId: id,
          outcome: "failed",
          errorCode: "not_found",
          meta: { domain },
        });
        return reply.fail("not_found", "memory not found", 404);
      }
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.pin",
        targetType: "factory_human_memory",
        targetId: id,
        outcome: "succeeded",
        meta: { domain, pinned: req.body.pinned },
      });
      return reply.ok({ updated: true, pinned: req.body.pinned });
    } catch (error) {
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.pin",
        targetType: "factory_human_memory",
        targetId: id,
        outcome: "failed",
        errorCode:
          error instanceof FactoryDomainBindingError
            ? error.code
            : "memory_persist_failed",
        error,
        meta: { domain },
      });
      if (error instanceof FactoryDomainBindingError)
        return bindingFailure(reply, error);
      return reply.fail("memory_persist_failed", (error as Error).message, 503);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      domain?: unknown;
      answer?: unknown;
      context?: unknown;
      pinned?: unknown;
    };
  }>("/agent-factory/memories/:id", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const id = decodeURIComponent(req.params.id);
    const domain = String(req.body?.domain ?? "").trim();
    const failInput = (message: string) => {
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.edit",
        targetType: "factory_human_memory",
        targetId: id,
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null },
      });
      return reply.fail("bad_request", message, 400);
    };
    if (!domain) return failInput("domain 必填");
    const hasAnswer = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "answer",
    );
    const hasContext = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "context",
    );
    const hasPinned = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "pinned",
    );
    if (!hasAnswer && !hasContext && !hasPinned) {
      return failInput("至少提供 answer、context 或 pinned 之一");
    }
    if (
      hasAnswer &&
      (typeof req.body.answer !== "string" || !req.body.answer.trim())
    ) {
      return failInput("answer 必须是非空字符串");
    }
    if (
      hasContext &&
      req.body.context !== null &&
      typeof req.body.context !== "string"
    ) {
      return failInput("context 必须是字符串或 null");
    }
    if (hasPinned && typeof req.body.pinned !== "boolean") {
      return failInput("pinned 必须是 boolean");
    }
    try {
      await requireBoundFactoryDomain(auth, domain);
      const memory = await new DrizzleHumanMemoryStore(
        auth.tenantId,
        domain,
      ).edit(domain, id, {
        ...(hasAnswer ? { answer: req.body.answer as string } : {}),
        ...(hasContext ? { context: req.body.context as string | null } : {}),
        ...(hasPinned ? { pinned: req.body.pinned as boolean } : {}),
      });
      if (!memory) {
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.edit",
          targetType: "factory_human_memory",
          targetId: id,
          outcome: "failed",
          errorCode: "not_found",
          meta: { domain },
        });
        return reply.fail("not_found", "memory not found", 404);
      }
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.edit",
        targetType: "factory_human_memory",
        targetId: id,
        outcome: "succeeded",
        meta: {
          domain,
          changedAnswer: hasAnswer,
          changedContext: hasContext,
          changedPinned: hasPinned,
        },
      });
      return reply.ok({ memory });
    } catch (error) {
      if (error instanceof FactoryDomainBindingError) {
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.edit",
          targetType: "factory_human_memory",
          targetId: id,
          outcome: "failed",
          errorCode: error.code,
          error,
          meta: { domain },
        });
        return bindingFailure(reply, error);
      }
      const message = (error as Error).message ?? "memory persistence failed";
      const invalid =
        /^(human memory|factory human memory|invalid |questionKey|question |answer |context |conversationId|non-human )/i.test(
          message,
        );
      const errorCode = invalid ? "invalid_memory" : "memory_persist_failed";
      auditFactoryMutation(auth, {
        action: "agent_factory.memory.edit",
        targetType: "factory_human_memory",
        targetId: id,
        outcome: "failed",
        errorCode,
        error,
        meta: { domain },
      });
      return reply.fail(errorCode, message, invalid ? 400 : 503);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { domain?: unknown } }>(
    "/agent-factory/memories/:id",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const id = decodeURIComponent(req.params.id);
      const domain = String(req.query.domain ?? "").trim();
      if (!domain) {
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.delete",
          targetType: "factory_human_memory",
          targetId: id,
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail("bad_request", "domain 必填", 400);
      }
      try {
        await requireBoundFactoryDomain(auth, domain);
        const deleted = await new DrizzleHumanMemoryStore(
          auth.tenantId,
          domain,
        ).del(domain, id);
        if (!deleted) {
          auditFactoryMutation(auth, {
            action: "agent_factory.memory.delete",
            targetType: "factory_human_memory",
            targetId: id,
            outcome: "failed",
            errorCode: "not_found",
            meta: { domain },
          });
          return reply.fail("not_found", "memory not found", 404);
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.delete",
          targetType: "factory_human_memory",
          targetId: id,
          outcome: "succeeded",
          meta: { domain },
        });
        return reply.ok({ deleted: true });
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.memory.delete",
          targetType: "factory_human_memory",
          targetId: id,
          outcome: "failed",
          errorCode:
            error instanceof FactoryDomainBindingError
              ? error.code
              : "memory_persist_failed",
          error,
          meta: { domain },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        return reply.fail(
          "memory_persist_failed",
          (error as Error).message,
          503,
        );
      }
    },
  );

  // Build, but do NOT start, a production rework conversation seed.  The
  // response contains the explicit runs/start request so a human can review it
  // before creating a new factory conversation.
  app.post<{ Body: { domain?: unknown; slug?: unknown; limit?: unknown } }>(
    "/agent-factory/rework-seed",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
      const domain = String(req.body?.domain ?? "").trim();
      const slug = String(req.body?.slug ?? "").trim();
      if (!domain || !slug)
        return reply.fail("bad_request", "domain 和 slug 必填", 400);
      try {
        await requireBoundFactoryDomain(req.auth, domain);
      } catch (error) {
        return bindingFailure(reply, error);
      }
      try {
        const result = await createFactoryReworkSeed({
          tenantId: req.auth.tenantId,
          tenantSlug: req.auth.tenantSlug,
          domain,
          slug,
          limit: Number(req.body?.limit) || undefined,
        });
        return reply.ok({ ...result, started: false });
      } catch (error) {
        if (error instanceof ReworkSeedError) {
          const status =
            error.code === "draft_not_found" || error.code === "agent_not_live"
              ? 404
              : 409;
          return reply.fail(error.code, error.message, status);
        }
        throw error;
      }
    },
  );

  // #P1-6 (#SKILL-EXPORT) — 技能库列表 + 导出为 Agent Skills 开放标准（agentskills.io）。
  // 导出物是 spec-compliant 的 SKILL.md（frontmatter name/description = 发现期路由信号），
  // 可直接放进 Claude Code / Agent SDK 等任意采纳该标准的 harness 的 skills 目录复用。
  app.get<{ Querystring: { domain?: string } }>(
    "/agent-factory/skills",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
      const domain = String(req.query.domain ?? "").trim();
      if (!domain) return reply.fail("bad_request", "domain 必填", 400);
      try {
        await requireBoundFactoryDomain(req.auth, domain);
      } catch (e) {
        return bindingFailure(reply, e);
      }
      const rows = await new DrizzleSkillStore(req.auth.tenantId, domain).list(
        domain,
      );
      const { lintSkillExport, toSpecName } =
        await import("@agentic/agent-factory");
      return reply.ok({
        skills: rows.map((r) => {
          const s = {
            slug: r.slug,
            name: r.name,
            purpose: r.purpose,
            promptFragment: r.promptFragment,
            tools: r.tools ?? [],
            decisionRule: r.decisionRule,
            domain: r.domain,
          };
          return {
            ...s,
            useCount: r.useCount,
            evalCount: r.evalCount,
            successCount: r.successCount,
            specName: toSpecName(r.slug),
            exportable: lintSkillExport(s).length === 0,
          };
        }),
      });
    },
  );
  app.get<{ Params: { slug: string }; Querystring: { domain?: string } }>(
    "/agent-factory/skills/:slug/export",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
      const domain = String(req.query.domain ?? "").trim();
      if (!domain) return reply.fail("bad_request", "domain 必填", 400);
      try {
        await requireBoundFactoryDomain(req.auth, domain);
      } catch (e) {
        return bindingFailure(reply, e);
      }
      const row = (
        await new DrizzleSkillStore(req.auth.tenantId, domain).list(domain)
      ).find((skill) => skill.slug === decodeURIComponent(req.params.slug));
      if (!row) return reply.fail("not_found", "没有这个技能", 404);
      const skill = {
        slug: row.slug,
        name: row.name,
        purpose: row.purpose,
        promptFragment: row.promptFragment,
        tools: row.tools ?? [],
        decisionRule: row.decisionRule,
        domain: row.domain,
      };
      const { renderSkillMd, lintSkillExport } =
        await import("@agentic/agent-factory");
      const lint = lintSkillExport(skill);
      if (lint.length)
        return reply.fail(
          "not_exportable",
          `技能不满足 Agent Skills 规范：${lint.join("；")}`,
          422,
        );
      const { dirName, skillMd } = renderSkillMd(skill);
      reply.raw.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${dirName}--SKILL.md"`,
      });
      reply.raw.end(skillMd);
      return reply;
    },
  );

  // Soft-delete a run (历史运行 trash). Tenant-scoped; never deletes a live 'running' row. The
  // row is recoverable via /restore and a reconnect to it replays a tombstone, not the run.
  app.delete<{ Params: { id: string } }>(
    "/agent-factory/runs/:id",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const id = req.params.id;
      try {
        const deleted = deleteRun(id, auth.tenantId);
        if (!deleted) {
          const run = getRun(id, auth.tenantId);
          const errorCode = !run
            ? "not_found"
            : run.status === "running"
              ? "run_running"
              : run.deletedAt
                ? "already_deleted"
                : "delete_not_persisted";
          const status = !run
            ? 404
            : errorCode === "delete_not_persisted"
              ? 503
              : 409;
          auditFactoryMutation(auth, {
            action: "agent_factory.run.delete",
            targetType: "factory_run",
            targetId: id,
            outcome: "failed",
            errorCode,
            meta: { status: run?.status ?? null },
          });
          return reply.fail(
            errorCode,
            !run
              ? "run not found"
              : run.status === "running"
                ? "运行仍在执行，不能删除"
                : run.deletedAt
                  ? "运行已经在回收站中"
                  : "运行删除未持久化",
            status,
          );
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.run.delete",
          targetType: "factory_run",
          targetId: id,
          outcome: "succeeded",
        });
        return reply.ok({ deleted: true });
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.delete",
          targetType: "factory_run",
          targetId: id,
          outcome: "failed",
          errorCode: "delete_failed",
          error,
        });
        return reply.fail("delete_failed", (error as Error).message, 503);
      }
    },
  );

  // Restore a soft-deleted run.
  app.post<{ Params: { id: string } }>(
    "/agent-factory/runs/:id/restore",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const id = req.params.id;
      try {
        const restored = restoreRun(id, auth.tenantId);
        if (!restored) {
          const run = getRun(id, auth.tenantId);
          const errorCode = !run
            ? "not_found"
            : !run.deletedAt
              ? "not_deleted"
              : "restore_not_persisted";
          const status = !run
            ? 404
            : errorCode === "restore_not_persisted"
              ? 503
              : 409;
          auditFactoryMutation(auth, {
            action: "agent_factory.run.restore",
            targetType: "factory_run",
            targetId: id,
            outcome: "failed",
            errorCode,
          });
          return reply.fail(
            errorCode,
            !run
              ? "run not found"
              : !run.deletedAt
                ? "运行不在回收站中"
                : "运行恢复未持久化",
            status,
          );
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.run.restore",
          targetType: "factory_run",
          targetId: id,
          outcome: "succeeded",
        });
        return reply.ok({ restored: true });
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.restore",
          targetType: "factory_run",
          targetId: id,
          outcome: "failed",
          errorCode: "restore_failed",
          error,
        });
        return reply.fail("restore_failed", (error as Error).message, 503);
      }
    },
  );

  // Bulk-clear a domain's finished runs (清空已完成). Requires ?domain=; skips live runs.
  app.delete<{ Querystring: { domain?: string } }>(
    "/agent-factory/runs",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const domain = String(req.query.domain ?? "").trim();
      if (!domain) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.bulk_delete",
          targetType: "factory_run",
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail("bad_request", "domain 必填", 400);
      }
      try {
        await requireBoundFactoryDomain(auth, domain);
        const cleared = deleteRunsByDomain(domain, auth.tenantId);
        auditFactoryMutation(auth, {
          action: "agent_factory.run.bulk_delete",
          targetType: "factory_run",
          targetId: domain,
          outcome: "succeeded",
          meta: { domain, count: cleared },
        });
        return reply.ok({ cleared });
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.bulk_delete",
          targetType: "factory_run",
          targetId: domain,
          outcome: "failed",
          errorCode:
            error instanceof FactoryDomainBindingError
              ? error.code
              : "delete_failed",
          error,
          meta: { domain },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        return reply.fail("delete_failed", (error as Error).message, 503);
      }
    },
  );

  // Durable agent drafts a finished run produced (persisted by finish()).
  app.get<{ Querystring: { domain?: string; versionId?: string } }>(
    "/agent-factory/drafts",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      const domain = req.query.domain ? String(req.query.domain) : "";
      if (!domain) return reply.fail("bad_request", "domain 必填", 400);
      if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
      try {
        await requireBoundFactoryDomain(req.auth, domain);
      } catch (e) {
        return bindingFailure(reply, e);
      }
      const scope = {
        tenantId: req.auth.tenantId,
        tenantSlug: req.auth.tenantSlug,
        ontologyDomainId: domain,
      };
      const store = new FsAgentDraftStore(scope);
      const drafts = req.query.versionId
        ? await store.getVersion(domain, String(req.query.versionId))
        : await listAgentDrafts(domain, scope);
      const versionStatus = new Map(
        (await store.listVersions(domain)).map(
          (version) => [version.versionId, version] as const,
        ),
      );
      const readinessByVersion = new Map<
        string,
        Awaited<ReturnType<typeof assessDraftPromotionReadiness>>
      >();
      for (const versionId of [
        ...new Set(
          drafts
            .map((draft) => draft.versionId)
            .filter((value): value is string => Boolean(value)),
        ),
      ]) {
        const status = versionStatus.get(versionId);
        const versionDrafts = drafts.filter(
          (draft) => draft.versionId === versionId,
        );
        readinessByVersion.set(
          versionId,
          await assessDraftPromotionReadiness({
            domain,
            drafts: versionDrafts,
            ctx: {
              tenantId: req.auth.tenantId,
              tenantSlug: req.auth.tenantSlug,
            },
            promotionGateAdmission: status?.promotionGateAdmission === true,
          }),
        );
      }
      // The rail needs identity/status only. Never send an entire generated
      // spec (which can contain historic tool config or fixture references) to
      // the browser just to render this list.
      return reply.ok({
        drafts: drafts.map((draft) => {
          const spec = draft.spec as unknown as Record<string, unknown>;
          const safeText = (value: unknown): value is string =>
            typeof value === "string" &&
            draftEditorSensitiveCategory(value) === null;
          const safeTextList = (value: unknown): value is string[] =>
            Array.isArray(value) && value.every((entry) => safeText(entry));
          const status = draft.versionId
            ? versionStatus.get(draft.versionId)
            : undefined;
          const readiness = draft.versionId
            ? readinessByVersion.get(draft.versionId)
            : undefined;
          return {
            slug: draft.slug,
            createdAt: draft.createdAt,
            ...(draft.versionId ? { versionId: draft.versionId } : {}),
            replayReady: status?.replayReady === true,
            regressionReady: status?.regressionReady === true,
            regressionStatus: status?.regressionStatus ?? "missing",
            promotionGateAdmission: status?.promotionGateAdmission === true,
            promotionEligible:
              status?.promotionGateAdmission === true &&
              readiness?.promotionEligible === true,
            promotionEvidenceReady: status?.promotionEvidenceReady === true,
            promotionBlockers: readiness?.blockers ?? [
              "不可变回归套件尚未取得 production commit gate 资格。",
            ],
            evidenceQualification: status?.evidenceQualification ?? {
              schema: "agent-factory-regression-evidence-qualification/v1",
              replay: "blocked",
              promotion: "blocked",
              blockers: [
                {
                  code: "replay_not_ready",
                  detail: "不可变回归套件尚未完整重放通过。",
                },
              ],
            },
            ...(draft.regression
              ? {
                  regression: {
                    artifact: draft.regression.artifact,
                    evidenceFingerprint: draft.regression.evidenceFingerprint,
                    suiteFingerprint: draft.regression.suiteFingerprint,
                  },
                }
              : {}),
            spec: {
              ...(safeText(spec.nameZh) ? { nameZh: spec.nameZh } : {}),
              ...(safeText(spec.short) ? { short: spec.short } : {}),
              ...(safeText(spec.actionName)
                ? { actionName: spec.actionName }
                : {}),
              ...(safeTextList(spec.tools) ? { tools: spec.tools } : {}),
              ...(spec.isMock === true ? { isMock: true } : {}),
              ...(spec.mock === true ? { mock: true } : {}),
            },
          };
        }),
      });
    },
  );

  app.get<{ Querystring: { domain?: string } }>(
    "/agent-factory/drafts/versions",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      const domain = String(req.query.domain ?? "").trim();
      if (!domain) return reply.fail("bad_request", "domain 必填", 400);
      if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
      try {
        await requireBoundFactoryDomain(req.auth, domain);
      } catch (e) {
        return bindingFailure(reply, e);
      }
      const store = new FsAgentDraftStore({
        tenantId: req.auth.tenantId,
        tenantSlug: req.auth.tenantSlug,
        ontologyDomainId: domain,
      });
      const versions = await store.listVersions(domain);
      const qualified: typeof versions = [];
      for (const version of versions) {
        const drafts = await store.getVersion(domain, version.versionId);
        const readiness = await assessDraftPromotionReadiness({
          domain,
          drafts,
          ctx: { tenantId: req.auth.tenantId, tenantSlug: req.auth.tenantSlug },
          promotionGateAdmission: version.promotionGateAdmission,
        });
        qualified.push({
          ...version,
          promotionEligible:
            version.promotionGateAdmission && readiness.promotionEligible,
          promotionBlockers: readiness.blockers,
        });
      }
      return reply.ok({ versions: qualified });
    },
  );

  // #P1b — fetch the DEPLOYABLE ts_function_module code for one draft (the actual function code,
  // inngest.createFunction 形态, to download/copy). Rendered from the spec if not persisted yet.
  app.get<{
    Querystring: { domain?: string; slug?: string; versionId?: string };
  }>("/agent-factory/drafts/code", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = String(req.query.domain ?? "").trim();
    const slug = String(req.query.slug ?? "").trim();
    if (!domain || !slug)
      return reply.fail("bad_request", "domain 和 slug 必填", 400);
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    try {
      await requireBoundFactoryDomain(req.auth, domain);
    } catch (e) {
      return bindingFailure(reply, e);
    }
    const versionId = String(req.query.versionId ?? "").trim() || undefined;
    const code = await new FsAgentDraftStore({
      tenantId: req.auth.tenantId,
      tenantSlug: req.auth.tenantSlug,
      ontologyDomainId: domain,
    }).getCode(domain, slug, versionId);
    if (code == null) return reply.fail("not_found", "没有这个草稿。", 404);
    return reply.ok({ domain, slug, code, filename: `${slug}.ts` });
  });

  // The Web editor is schema-driven by this exact immutable draft. It never
  // infers editable fields from an Action name and never receives sensitive
  // historic values.
  app.get<{
    Params: { slug: string };
    Querystring: { domain?: string; versionId?: string };
  }>("/agent-factory/drafts/:slug/editor", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = String(req.query.domain ?? "").trim();
    const versionId = String(req.query.versionId ?? "").trim();
    const slug = String(req.params.slug ?? "").trim();
    if (!domain || !versionId || !slug) {
      return reply.fail(
        "bad_request",
        "打开草稿编辑器需要明确的 domain、slug 和 versionId",
        400,
      );
    }
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    try {
      await requireBoundFactoryDomain(req.auth, domain);
      const contract = await new FsAgentDraftStore({
        tenantId: req.auth.tenantId,
        tenantSlug: req.auth.tenantSlug,
        ontologyDomainId: domain,
      }).getEditorContract(domain, versionId, slug);
      if (!contract) {
        return reply.fail(
          "draft_not_found",
          "这个草稿或版本已不存在，请刷新草稿列表后重试。",
          404,
        );
      }
      return reply.ok(contract);
    } catch (error) {
      if (error instanceof FactoryDomainBindingError) {
        return bindingFailure(reply, error);
      }
      return reply.fail(
        "draft_editor_failed",
        "暂时无法读取这个草稿的编辑契约，请刷新后重试。",
        factoryFailureStatus(error, 503),
      );
    }
  });

  // Human design/code edits fork an immutable version and deliberately carry
  // no old sandbox/regression receipt. A fresh sandbox finish is required
  // before the new version can be promoted.
  app.patch<{
    Params: { slug: string };
    Body: {
      domain?: string;
      baseVersionId?: string;
      patch?: { set?: Record<string, unknown>; unset?: string[] };
    };
  }>("/agent-factory/drafts/:slug", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const domain = String(req.body?.domain ?? "").trim();
    const baseVersionId = String(req.body?.baseVersionId ?? "").trim();
    const slug = decodeURIComponent(req.params.slug);
    if (!domain || !baseVersionId || !req.body?.patch) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.patch",
        targetType: "factory_draft",
        targetId: slug,
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null, baseVersionId: baseVersionId || null },
      });
      return reply.fail(
        "bad_request",
        "domain、baseVersionId 和 patch 必填",
        400,
      );
    }
    return withFactoryTenantLock(auth.tenantId, async () => {
      try {
        await requireBoundFactoryDomain(auth, domain);
        const result = await new FsAgentDraftStore({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          ontologyDomainId: domain,
        }).createPatchedVersion(domain, baseVersionId, slug, req.body!.patch!);
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.patch",
          targetType: "factory_draft_version",
          targetId: result.versionId,
          outcome: "succeeded",
          meta: {
            domain,
            baseVersionId,
            slug: result.changedSlug,
            regressionInvalidated: true,
          },
        });
        // The patched version's full specs are durable server-side artifacts,
        // not an editor response. Returning metadata only prevents historic
        // config or fixture references from crossing into browser state.
        const { drafts: _serverOnlyDrafts, ...publicResult } = result;
        return reply.ok(
          {
            ...publicResult,
            scope: {
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
              domain,
              slug: result.changedSlug,
              baseVersionId,
            },
          },
          201,
        );
      } catch (error) {
        const errorCode =
          error instanceof FactoryDomainBindingError
            ? error.code
            : error instanceof DraftVersionConflictError
              ? error.code
              : "draft_patch_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.patch",
          targetType: "factory_draft",
          targetId: slug,
          outcome: "failed",
          errorCode,
          error: draftPatchFailureMessage(error),
          meta: { domain, baseVersionId },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        return reply.fail(
          error instanceof DraftVersionConflictError
            ? error.code
            : "draft_patch_failed",
          draftPatchFailureMessage(error),
          error instanceof DraftVersionConflictError
            ? 409
            : factoryFailureStatus(error),
        );
      }
    });
  });

  app.get<{
    Params: { slug: string };
    Querystring: { domain?: string; versionId?: string };
  }>("/agent-factory/drafts/:slug/sandbox-input", async (req, reply) => {
    requirePermission(req, "agents.read");
    const domain = String(req.query.domain ?? "").trim();
    const versionId = String(req.query.versionId ?? "").trim();
    const slug = decodeURIComponent(req.params.slug);
    if (!domain || !versionId) {
      return reply.fail("bad_request", "domain 和 versionId 必填", 400);
    }
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    try {
      await requireBoundFactoryDomain(req.auth, domain);
      const contract = await getDraftSandboxInputContract({
        scope: {
          tenantId: req.auth.tenantId,
          tenantSlug: req.auth.tenantSlug,
          ontologyDomainId: domain,
        },
        domain,
        versionId,
        slug,
        ports: makeFactoryPorts(req.auth.tenantSlug, req.auth.tenantId, domain),
      });
      return reply.ok(contract);
    } catch (error) {
      if (error instanceof FactoryDomainBindingError)
        return bindingFailure(reply, error);
      if (error instanceof DraftSandboxError)
        return reply.fail(error.code, error.publicMessage, error.statusCode);
      return reply.fail(
        "sandbox_input_failed",
        "暂时无法读取这个版本的测试输入契约，请刷新后重试。",
        factoryFailureStatus(error, 503),
      );
    }
  });

  // Re-sandbox one exact immutable delivery version. The first call computes
  // the complete current evidence tuple and issues a durable one-shot human
  // challenge. It does not deploy anything.
  app.post<{
    Params: { slug: string };
    Body: {
      domain?: string;
      versionId?: string;
      testCases?: unknown;
      boundaryEvents?: unknown;
    };
  }>("/agent-factory/drafts/:slug/sandbox-review", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const domain = String(req.body?.domain ?? "").trim();
    const versionId = String(req.body?.versionId ?? "").trim();
    const slug = decodeURIComponent(req.params.slug);
    if (!domain || !versionId || req.body?.testCases === undefined) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.sandbox_review",
        targetType: "factory_draft_version",
        targetId: versionId || null,
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null, slug },
      });
      return reply.fail(
        "bad_request",
        "domain、versionId 和 testCases 必填",
        400,
      );
    }
    return withFactoryTenantLock(auth.tenantId, async () => {
      try {
        await requireBoundFactoryDomain(auth, domain);
        const review = await prepareDraftSandboxReview({
          scope: {
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
            ontologyDomainId: domain,
          },
          domain,
          versionId,
          slug,
          testCases: req.body!.testCases,
          boundaryEvents: req.body!.boundaryEvents,
          ports: makeFactoryPorts(auth.tenantSlug, auth.tenantId, domain),
        });
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.sandbox_review",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "succeeded",
          meta: {
            domain,
            slug,
            fingerprint: review.fingerprint,
            specsCount: review.specsCount,
            testCasesCount: review.testCases.length,
          },
        });
        return reply.ok(review, 201);
      } catch (error) {
        const code =
          error instanceof DraftSandboxError
            ? error.code
            : error instanceof FactoryDomainBindingError
              ? error.code
              : "sandbox_review_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.sandbox_review",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "failed",
          errorCode: code,
          meta: { domain, slug },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        if (error instanceof DraftSandboxError) {
          return reply.fail(error.code, error.publicMessage, error.statusCode);
        }
        return reply.fail(
          "sandbox_review_failed",
          "暂时无法准备沙箱审查。没有创建 Inngest App，请检查 AllmetaOntology 和工具库连接后重试。",
          factoryFailureStatus(error, 503),
        );
      }
    });
  });

  // A consumed exact-version challenge is the only path that can create the
  // disposable app. The deployer owns teardown in finally; a green,
  // cleanup-verified run is materialized as pending evidence, then this same
  // request must replay its exact artifact before the version becomes ready.
  app.post<{
    Params: { slug: string };
    Body: {
      domain?: string;
      versionId?: string;
      testCases?: unknown;
      boundaryEvents?: unknown;
      challengeRef?: unknown;
      answer?: unknown;
    };
  }>("/agent-factory/drafts/:slug/sandbox-finish", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const domain = String(req.body?.domain ?? "").trim();
    const versionId = String(req.body?.versionId ?? "").trim();
    const slug = decodeURIComponent(req.params.slug);
    if (
      !domain ||
      !versionId ||
      req.body?.testCases === undefined ||
      !req.body?.challengeRef ||
      !req.body?.answer
    ) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.sandbox_finish",
        targetType: "factory_draft_version",
        targetId: versionId || null,
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null, slug },
      });
      return reply.fail(
        "bad_request",
        "domain、versionId、testCases、challengeRef 和 answer 必填",
        400,
      );
    }
    if (
      !auth.userId ||
      auth.via === "token" ||
      (process.env.NODE_ENV === "production" && auth.via !== "cookie")
    ) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.sandbox_finish",
        targetType: "factory_draft_version",
        targetId: versionId,
        outcome: "failed",
        errorCode: "interactive_human_required",
        meta: { domain, slug, via: auth.via },
      });
      return reply.fail(
        "interactive_human_required",
        "创建临时沙箱必须由交互式登录用户确认，API token/模型/生产 dev 身份不能代签。",
        403,
      );
    }
    return withFactoryTenantLock(auth.tenantId, async () => {
      try {
        await requireBoundFactoryDomain(auth, domain);
        const result = await finishDraftSandbox({
          scope: {
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
            ontologyDomainId: domain,
          },
          domain,
          versionId,
          slug,
          testCases: req.body!.testCases,
          boundaryEvents: req.body!.boundaryEvents,
          challengeRef: req.body!.challengeRef,
          answer: req.body!.answer,
          actor: auth.userId!,
          ports: makeFactoryPorts(auth.tenantSlug, auth.tenantId, domain),
        });
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.sandbox_finish",
          targetType: "factory_draft_version",
          targetId: result.versionId,
          outcome: "succeeded",
          meta: {
            domain,
            slug,
            baseVersionId: versionId,
            fingerprint: result.fingerprint,
            cleanupVerified: true,
            functionsRegistered: result.sandbox.functionsRegistered,
            regressionReady: result.regressionReady,
            diagnosticOnly: result.diagnosticOnly,
            qualification: result.qualification,
          },
        });
        return reply.ok(result, 201);
      } catch (error) {
        const code =
          error instanceof DraftSandboxError
            ? error.code
            : error instanceof FactoryDomainBindingError
              ? error.code
              : "sandbox_finish_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.sandbox_finish",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "failed",
          errorCode: code,
          meta: { domain, slug },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        if (error instanceof DraftSandboxError) {
          return reply.fail(error.code, error.publicMessage, error.statusCode);
        }
        return reply.fail(
          "sandbox_finish_failed",
          "沙箱没有完成可验证交付。临时 App 会由生命周期清理器收口；请查看运行日志后重新创建一次新沙箱。",
          factoryFailureStatus(error, 503),
        );
      }
    });
  });

  // #P7-infra — 治理闭环:列出【待人签核】的返工建议(生产回归越阈值,由治理巡检产出)。
  app.get("/agent-factory/governance", async (req, reply) => {
    requirePermission(req, "agents.read");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    const { fsGovernanceStore, governanceRunnerStatus } =
      await import("../../services/agent-factory/fleet-governance-runner");
    const decisions = await fsGovernanceStore.list(req.auth.tenantSlug);
    const status = governanceRunnerStatus();
    return reply.ok({
      decisions,
      enabled: status.enabled,
      scheduled: status.running,
    });
  });

  // #P7-infra — 手动触发一次治理巡检(不等定时;仍只 SURFACE 建议,不自动开返工 run)。
  app.post("/agent-factory/governance/sweep", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const { runGovernanceSweep } =
      await import("../../services/agent-factory/fleet-governance-runner");
    const r = await runGovernanceSweep(auth.tenantSlug);
    if (r.error) {
      auditFactoryMutation(auth, {
        action: "agent_factory.governance.sweep",
        targetType: "tenant",
        targetId: auth.tenantId,
        outcome: "failed",
        errorCode: "governance_sweep_failed",
        error: r.error,
      });
      return reply.fail("governance_sweep_failed", r.summary, 503);
    }
    auditFactoryMutation(auth, {
      action: "agent_factory.governance.sweep",
      targetType: "tenant",
      targetId: auth.tenantId,
      outcome: "succeeded",
      meta: {
        scannedFunctions: r.scannedFunctions,
        decisionsCreated: r.decisions.length,
      },
    });
    return reply.ok(r);
  });

  // Delete a single generated-function DRAFT before it's promoted (user declined it). File-based
  // draft store; never touches live agents. domain required to scope the delete.
  app.delete<{ Params: { slug: string }; Querystring: { domain?: string } }>(
    "/agent-factory/drafts/:slug",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const slug = decodeURIComponent(req.params.slug);
      const domain = String(req.query.domain ?? "").trim();
      if (!domain) {
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.delete",
          targetType: "factory_draft",
          targetId: slug,
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail("bad_request", "domain 必填", 400);
      }
      try {
        await requireBoundFactoryDomain(auth, domain);
        const removed = await new FsAgentDraftStore({
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          ontologyDomainId: domain,
        }).delete(domain, slug);
        if (!removed) {
          auditFactoryMutation(auth, {
            action: "agent_factory.draft.delete",
            targetType: "factory_draft",
            targetId: slug,
            outcome: "failed",
            errorCode: "not_found",
            meta: { domain },
          });
          return reply.fail("not_found", "没有这个草稿。", 404);
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.delete",
          targetType: "factory_draft",
          targetId: slug,
          outcome: "succeeded",
          meta: { domain, deletionMode: "tombstone" },
        });
        return reply.ok({ deleted: true, slug });
      } catch (error) {
        const errorCode =
          error instanceof FactoryDomainBindingError
            ? error.code
            : "draft_delete_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.delete",
          targetType: "factory_draft",
          targetId: slug,
          outcome: "failed",
          errorCode,
          error,
          meta: { domain },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        return reply.fail("draft_delete_failed", (error as Error).message, 503);
      }
    },
  );

  // Read-only, zero-deployment-write comparison: current live manifest vs the
  // exact immutable draft version chosen for promotion.
  app.post<{ Body: { domain?: string; versionId?: string; slugs?: string[] } }>(
    "/agent-factory/drafts/promotion-preview",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.read");
      const domain = String(req.body?.domain ?? "").trim();
      const versionId = String(req.body?.versionId ?? "").trim();
      if (!domain || !versionId)
        return reply.fail("bad_request", "domain 和 versionId 必填", 400);
      try {
        await requireBoundFactoryDomain(auth, domain);
        return reply.ok(
          await previewDraftPromotion(
            domain,
            { versionId, slugs: req.body?.slugs },
            {
              tenantId: auth.tenantId,
              tenantSlug: auth.tenantSlug,
            },
          ),
        );
      } catch (error) {
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        const detail = String((error as Error)?.message ?? error);
        return reply.fail(
          /no changes|already live/i.test(detail)
            ? "promotion_no_changes"
            : "promotion_preview_failed",
          /no changes|already live/i.test(detail)
            ? "这个不可变版本已经完整在线，没有需要晋升的变化。若要修改，请先从 Agent 工厂生成或编辑一个新版本。"
            : detail,
          /no changes|already live/i.test(detail)
            ? 400
            : error instanceof AuthoritativeOntologyPromotionError &&
                error.code === "authoritative_ontology_unavailable"
              ? 503
              : factoryFailureStatus(error),
        );
      }
    },
  );

  // Only an interactive authenticated user can mint this HMAC receipt. Actor,
  // hashes and scope are derived server-side; no model/user-supplied `actor` or
  // boolean inside the promote request can self-certify review.
  app.post<{
    Body: {
      domain?: string;
      versionId?: string;
      slugs?: string[];
      reviewChallenge?: string;
      decision?: string;
      codeReviewed?: boolean;
      designReviewed?: boolean;
    };
  }>("/agent-factory/drafts/reviews", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const domain = String(req.body?.domain ?? "").trim();
    const versionId = String(req.body?.versionId ?? "").trim();
    if (!domain || !versionId || !req.body?.reviewChallenge) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.human_signoff",
        targetType: "factory_draft_version",
        targetId: versionId || null,
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null },
      });
      return reply.fail(
        "bad_request",
        "domain、versionId 和 reviewChallenge 必填",
        400,
      );
    }
    if (
      !auth.userId ||
      auth.via === "token" ||
      (process.env.NODE_ENV === "production" && auth.via !== "cookie")
    ) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.human_signoff",
        targetType: "factory_draft_version",
        targetId: versionId,
        outcome: "failed",
        errorCode: "interactive_human_required",
        meta: { domain, via: auth.via },
      });
      return reply.fail(
        "interactive_human_required",
        "人工签核必须来自交互式登录用户，API token/模型/生产 dev 身份不能代签",
        403,
      );
    }
    return withFactoryTenantLock(auth.tenantId, async () => {
      try {
        await requireBoundFactoryDomain(auth, domain);
        const receipt = await createHumanReviewReceipt({
          domain,
          versionId,
          slugs: req.body?.slugs,
          reviewChallenge: String(req.body!.reviewChallenge),
          decision: req.body?.decision as "approve_code_and_design",
          codeReviewed: req.body?.codeReviewed === true,
          designReviewed: req.body?.designReviewed === true,
          reviewer: {
            userId: auth.userId,
            email: auth.email,
            name: auth.name,
            via: auth.via,
          },
          ctx: {
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
          },
        });
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.human_signoff",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "succeeded",
          meta: {
            domain,
            receiptId: receipt.receiptId,
            selectionHash: receipt.selectionHash,
            codeReviewed: true,
            designReviewed: true,
          },
        });
        return reply.ok({ receipt }, 201);
      } catch (error) {
        const errorCode =
          error instanceof FactoryDomainBindingError
            ? error.code
            : "human_review_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.human_signoff",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "failed",
          errorCode,
          error,
          meta: { domain },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        return reply.fail(
          "human_review_failed",
          (error as Error).message,
          factoryFailureStatus(error),
        );
      }
    });
  });

  // Promote a domain's finished drafts → real running Fleet agents. EXPLICIT,
  // ADDITIVE, exact-version, and gated by a server-issued human review receipt.
  app.post<{
    Body: {
      domain?: string;
      versionId?: string;
      receiptId?: string;
      slugs?: string[];
    };
  }>("/agent-factory/drafts/promote", async (req, reply) => {
    const auth = requirePermission(req, "deployments.write");
    const domain = String(req.body?.domain ?? "").trim();
    const versionId = String(req.body?.versionId ?? "").trim();
    const receiptId = String(req.body?.receiptId ?? "").trim();
    if (!domain || !versionId || !receiptId) {
      auditFactoryMutation(auth, {
        action: "agent_factory.draft.promote",
        targetType: "factory_draft_version",
        targetId: versionId || null,
        outcome: "failed",
        errorCode: "bad_request",
        meta: { domain: domain || null },
      });
      return reply.fail(
        "bad_request",
        "domain、versionId 和 receiptId 必填",
        400,
      );
    }
    return withFactoryTenantLock(auth.tenantId, async (lease) => {
      try {
        lease.assertOwned();
        await requireBoundFactoryDomain(auth, domain);
        lease.assertOwned();
        const result = await promoteDrafts(
          domain,
          { versionId, receiptId, slugs: req.body?.slugs },
          {
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
          },
        );
        lease.assertOwned();
        if (
          result.total <= 0 ||
          result.promoted.length !== result.total ||
          result.functionsRegistered <= 0
        ) {
          throw new Error(
            `promotion did not make every selected draft live (selected=${result.total}, promoted=${result.promoted.length}, functions=${result.functionsRegistered})`,
          );
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.promote",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "succeeded",
          meta: {
            domain,
            receiptId,
            promoted: result.promoted,
            deploymentId: result.deploymentId,
            functionsRegistered: result.functionsRegistered,
            liveAgents: result.liveAgents,
            regressionCasesReplayed: result.regression?.casesReplayed ?? 0,
          },
        });
        return reply.ok(result);
      } catch (e) {
        const errorCode =
          e instanceof FactoryDomainBindingError ? e.code : "promote_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.draft.promote",
          targetType: "factory_draft_version",
          targetId: versionId,
          outcome: "failed",
          errorCode,
          error: e,
          meta: { domain, receiptId },
        });
        if (e instanceof FactoryDomainBindingError)
          return bindingFailure(reply, e);
        return reply.fail(
          "promote_failed",
          (e as Error).message ?? "晋升失败",
          factoryFailureStatus(e),
        );
      }
    });
  });

  // ── Uploaded ontology bundles (本地本体) — upload actions/events/rules/dataObjects JSON; it
  // persists as a reusable LOCAL domain that shows up in the switcher and the factory reads instead
  // of the live Ontology. ────────────────────────────────────────────────────────────────────────
  app.get("/agent-factory/ontology-uploads", async (req, reply) => {
    const auth = requirePermission(req, "agents.read");
    return reply.ok({
      uploads: await new FsUploadedOntologyStore().list(auth.tenantSlug),
    });
  });

  app.post<{
    Body: {
      name?: string;
      ontology?: unknown;
      domainId?: string;
      confirmRebind?: boolean;
    };
  }>("/agent-factory/ontology-upload", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    return withFactoryTenantLock(auth.tenantId, async () => {
      const swept = sweepZombieRuns(null, auth.tenantId);
      if (swept > 0) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.zombie_sweep",
          targetType: "factory_run",
          outcome: "succeeded",
          meta: { count: swept, source: "ontology_upload" },
        });
      }
      if (
        listRunningRuns(null, auth.tenantId).length ||
        hasFactoryActiveWork(auth.tenantId)
      ) {
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          outcome: "failed",
          errorCode: "factory_running",
        });
        return reply.fail(
          "factory_running",
          "当前业务领域仍有 Agent 工厂任务运行中，结束后才能上传或覆盖本体。",
          409,
        );
      }
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail("bad_request", "请给上传的本体起个名字。", 400);
      }
      if (req.body?.ontology == null) {
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail(
          "bad_request",
          "ontology（JSON 内容）不能为空。",
          400,
        );
      }
      // Body-size guard: refuse an oversized bundle (DoS / memory) — well above any real ontology.
      if (JSON.stringify(req.body.ontology).length > 4_000_000) {
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          outcome: "failed",
          errorCode: "too_large",
        });
        return reply.fail("too_large", "本体 JSON 过大（>4MB）。", 413);
      }
      const domainId = String(req.body?.domainId ?? "").trim() || undefined;
      const targetDomainId = domainId ?? slugifyDomain(name);
      const current = getFactoryDomainBinding(auth.tenantId);
      // Omitting domainId used to bypass the PUT endpoint's rebind confirmation:
      // the name-derived id silently replaced the active binding.  Both explicit
      // and derived target identities now use the same confirmation contract.
      if (
        current &&
        current.ontologyDomainId !== targetDomainId &&
        req.body?.confirmRebind !== true
      ) {
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          targetId: targetDomainId,
          outcome: "failed",
          errorCode: "confirm_rebind",
          meta: { previousDomainId: current.ontologyDomainId },
        });
        return reply.fail(
          "confirm_rebind",
          `上传会把当前本体连接从「${current.ontologyDomainId}」更换为「${targetDomainId}」；请确认后重试。`,
          409,
        );
      }
      const store = new FsUploadedOntologyStore();
      try {
        // Snapshot an existing upload so a DB binding failure can compensate
        // an already-durable file replacement instead of leaving half a saga.
        const previousOntology = await store.get(
          auth.tenantSlug,
          targetDomainId,
        );
        const previousMeta = previousOntology
          ? (await store.list(auth.tenantSlug)).find(
              (entry) => entry.id === targetDomainId,
            )
          : undefined;
        const meta = await store.save(
          auth.tenantSlug,
          name,
          req.body.ontology,
          domainId,
        );
        let binding: ReturnType<typeof setFactoryDomainBinding> | undefined;
        try {
          binding = setFactoryDomainBinding(
            auth.tenantId,
            { id: meta.id, name: meta.name },
            "upload",
          );
        } catch (bindingError) {
          // setFactoryDomainBinding commits and then reads back.  If the commit
          // succeeded but that read transiently failed, a second read proves it
          // and we keep the durable upload. Otherwise restore/delete the file.
          let bindingReadFailed = false;
          try {
            const persisted = getFactoryDomainBinding(auth.tenantId);
            if (
              persisted?.ontologyDomainId === meta.id &&
              persisted.source === "upload"
            )
              binding = persisted;
          } catch {
            // Storage is unavailable; keep the uploaded evidence rather than
            // risking a binding that points at a file we just removed.
            bindingReadFailed = true;
          }
          if (!binding && !bindingReadFailed) {
            try {
              if (previousOntology) {
                await store.save(
                  auth.tenantSlug,
                  previousMeta?.name ?? targetDomainId,
                  previousOntology,
                  targetDomainId,
                );
              } else {
                await store.delete(auth.tenantSlug, targetDomainId);
              }
            } catch (recoveryError) {
              throw new AggregateError(
                [bindingError, recoveryError],
                `ontology upload binding failed and file compensation failed for ${targetDomainId}`,
              );
            }
          }
          if (!binding) throw bindingError;
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          targetId: meta.id,
          outcome: "succeeded",
          meta: {
            counts: meta.counts,
            previousDomainId: current?.ontologyDomainId ?? null,
            rebound: !!current && current.ontologyDomainId !== meta.id,
          },
        });
        return reply.ok({ uploaded: meta, binding });
      } catch (e) {
        const message = (e as Error).message ?? "本体校验失败";
        const errorCode = message.startsWith("factory_running:")
          ? "factory_running"
          : "invalid_ontology";
        auditFactoryMutation(auth, {
          action: "agent_factory.ontology.upload",
          targetType: "ontology_domain",
          targetId: targetDomainId,
          outcome: "failed",
          errorCode,
          error: e,
        });
        return reply.fail(
          errorCode,
          message,
          errorCode === "factory_running" ? 409 : factoryFailureStatus(e),
        );
      }
    });
  });

  app.delete<{ Params: { id: string } }>(
    "/agent-factory/ontology-uploads/:id",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.write");
      return withFactoryTenantLock(auth.tenantId, async () => {
        const id = decodeURIComponent(req.params.id);
        const swept = sweepZombieRuns(null, auth.tenantId);
        if (swept > 0) {
          auditFactoryMutation(auth, {
            action: "agent_factory.run.zombie_sweep",
            targetType: "factory_run",
            outcome: "succeeded",
            meta: { count: swept, source: "ontology_delete" },
          });
        }
        if (
          listRunningRuns(null, auth.tenantId).length ||
          hasFactoryActiveWork(auth.tenantId)
        ) {
          auditFactoryMutation(auth, {
            action: "agent_factory.ontology.delete",
            targetType: "ontology_domain",
            targetId: id,
            outcome: "failed",
            errorCode: "factory_running",
          });
          return reply.fail(
            "factory_running",
            "当前业务领域仍有 Agent 工厂任务运行中，结束后才能删除本体。",
            409,
          );
        }
        const store = new FsUploadedOntologyStore();
        const current = getFactoryDomainBinding(auth.tenantId);
        const isActiveUpload = current?.ontologyDomainId === id;
        // Disconnect first. A new run cannot start while unbound; this prevents a
        // window where the id remains bound but its uploaded source has vanished.
        let disconnected = false;
        let ontologyBackup: Awaited<
          ReturnType<FsUploadedOntologyStore["get"]>
        > = null;
        let ontologyBackupName = current?.ontologyDomainName ?? id;
        try {
          ontologyBackup = await store.get(auth.tenantSlug, id);
          if (ontologyBackup) {
            ontologyBackupName =
              (await store.list(auth.tenantSlug)).find(
                (entry) => entry.id === id,
              )?.name ?? ontologyBackupName;
          }
          disconnected = isActiveUpload
            ? clearFactoryDomainBinding(auth.tenantId)
            : false;
          const removed = await store.delete(auth.tenantSlug, id);
          if (!removed) {
            if (disconnected && current) {
              setFactoryDomainBinding(
                auth.tenantId,
                {
                  id: current.ontologyDomainId,
                  name: current.ontologyDomainName ?? current.ontologyDomainId,
                },
                current.source,
              );
            }
            auditFactoryMutation(auth, {
              action: "agent_factory.ontology.delete",
              targetType: "ontology_domain",
              targetId: id,
              outcome: "failed",
              errorCode: "not_found",
            });
            return reply.fail("not_found", "没有这个上传的本体。", 404);
          }
          const binding = getFactoryDomainBinding(auth.tenantId);
          auditFactoryMutation(auth, {
            action: "agent_factory.ontology.delete",
            targetType: "ontology_domain",
            targetId: id,
            outcome: "succeeded",
            meta: { disconnected },
          });
          return reply.ok({ deleted: true, id, disconnected, binding });
        } catch (error) {
          let surfaced: unknown = error;
          const recoveryFailures: unknown[] = [error];
          if (ontologyBackup) {
            try {
              await store.save(
                auth.tenantSlug,
                ontologyBackupName,
                ontologyBackup,
                id,
              );
            } catch (recoveryError) {
              recoveryFailures.push(recoveryError);
            }
          }
          if (disconnected && current) {
            try {
              setFactoryDomainBinding(
                auth.tenantId,
                {
                  id: current.ontologyDomainId,
                  name: current.ontologyDomainName ?? current.ontologyDomainId,
                },
                current.source,
              );
            } catch (recoveryError) {
              recoveryFailures.push(recoveryError);
            }
          }
          if (recoveryFailures.length > 1)
            surfaced = new AggregateError(
              recoveryFailures,
              `ontology delete failed and compensation failed for ${id}`,
            );
          auditFactoryMutation(auth, {
            action: "agent_factory.ontology.delete",
            targetType: "ontology_domain",
            targetId: id,
            outcome: "failed",
            errorCode: "ontology_delete_failed",
            error: surfaced,
          });
          return reply.fail(
            "ontology_delete_failed",
            (surfaced as Error).message,
            503,
          );
        }
      });
    },
  );

  // ── Ops sidebar backend (任务 tab) ──────────────────────────────────────────────────────────────
  // Unified BACKGROUND snapshot across the tenant: factory runs (all domains, running first) with a
  // liveness flag, plus report jobs. One poll target for the Claude-desktop-style 后台 section.
  app.get("/agent-factory/background", async (req, reply) => {
    const auth = requirePermission(req, "agents.read");
    const tenantId = auth.tenantId;
    const swept = sweepZombieRuns(null, tenantId);
    if (swept > 0) {
      auditFactoryMutation(auth, {
        action: "agent_factory.run.zombie_sweep",
        targetType: "factory_run",
        outcome: "succeeded",
        meta: { count: swept, source: "background" },
      });
    }
    const runs = listRuns(null, tenantId, 12).map((r) => ({
      ...r,
      live: r.status === "running" && isActiveRun(r.id),
    }));
    return reply.ok({ runs, jobs: listReportJobs(tenantId) });
  });

  // 领域报告 — kick off an ontology-analysis report job (HTML / PDF / both). Detached like a
  // factory run: this returns immediately; progress + artifact links surface via /background.
  app.post<{ Body: { domain?: string; format?: string; focus?: string } }>(
    "/agent-factory/report",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      return withFactoryTenantLock(auth.tenantId, async () => {
        const domain = String(req.body?.domain ?? "").trim();
        const format = String(req.body?.format ?? "html");
        if (!domain || !["html", "pdf", "both"].includes(format)) {
          auditFactoryMutation(auth, {
            action: "agent_factory.report.start",
            targetType: "factory_report_job",
            outcome: "failed",
            errorCode: "bad_request",
            meta: { domain: domain || null, format },
          });
          return reply.fail(
            "bad_request",
            !domain ? "domain 必填" : "format 须为 html | pdf | both",
            400,
          );
        }
        if (!isGatewayConfigured()) {
          auditFactoryMutation(auth, {
            action: "agent_factory.report.start",
            targetType: "factory_report_job",
            outcome: "failed",
            errorCode: "not_configured",
            meta: { domain, format },
          });
          return reply.fail(
            "not_configured",
            "LLM 网关未配置——报告 agent 无法运行。",
            503,
          );
        }
        const focus = req.body?.focus
          ? String(req.body.focus).slice(0, 500)
          : undefined;
        try {
          await requireBoundFactoryDomain(auth, domain);
          const job = startOntologyReportJob({
            tenantId: auth.tenantId,
            tenantSlug: auth.tenantSlug,
            domain,
            format: format as ReportFormat,
            focus,
          });
          auditFactoryMutation(auth, {
            action: "agent_factory.report.start",
            targetType: "factory_report_job",
            targetId: job.id,
            outcome: "succeeded",
            meta: { domain, format, status: job.status },
          });
          return reply.ok({ job }, 202);
        } catch (error) {
          const errorCode =
            error instanceof FactoryDomainBindingError
              ? error.code
              : "report_start_failed";
          auditFactoryMutation(auth, {
            action: "agent_factory.report.start",
            targetType: "factory_report_job",
            outcome: "failed",
            errorCode,
            error,
            meta: { domain, format },
          });
          if (error instanceof FactoryDomainBindingError)
            return bindingFailure(reply, error);
          return reply.fail(
            "report_start_failed",
            (error as Error).message,
            503,
          );
        }
      });
    },
  );

  // Clear a finished report job from the background panel (running jobs are refused —
  // no abort path exists, so hiding an in-flight job would misreport reality).
  app.delete<{ Params: { id: string } }>(
    "/agent-factory/report/:id",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const id = req.params.id;
      try {
        const deleted = deleteReportJob(id, auth.tenantId);
        if (!deleted) {
          const job = getReportJob(id, auth.tenantId);
          const errorCode =
            job?.status === "running" ? "job_running" : "not_found";
          auditFactoryMutation(auth, {
            action: "agent_factory.report.delete",
            targetType: "factory_report_job",
            targetId: id,
            outcome: "failed",
            errorCode,
            meta: { status: job?.status ?? null },
          });
          return reply.fail(
            errorCode,
            job?.status === "running"
              ? "报告任务仍在运行，不能清除。"
              : "没有这个报告任务。",
            job?.status === "running" ? 409 : 404,
          );
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.report.delete",
          targetType: "factory_report_job",
          targetId: id,
          outcome: "succeeded",
        });
        return reply.ok({ deleted: true, id });
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.report.delete",
          targetType: "factory_report_job",
          targetId: id,
          outcome: "failed",
          errorCode: "report_delete_failed",
          error,
        });
        return reply.fail(
          "report_delete_failed",
          (error as Error).message,
          503,
        );
      }
    },
  );

  // Runtime-active generated tools. Drafts live only in the revision ledger
  // exposed by /v1/tools/revisions; this compatibility surface may deactivate
  // an active revision but never destroys its audit history.
  app.get("/agent-factory/generated-tools", async (req, reply) => {
    requirePermission(req, "agents.read");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    const binding = getFactoryDomainBinding(req.auth.tenantId);
    const revisionScopes = [
      binding?.ontologyDomainId ?? "__unbound__",
      ...(binding ? ["__unbound__"] : []),
    ];
    const activeRevisionByName = new Map<
      string,
      { id: string; domainId: string | null }
    >();
    for (const domainId of revisionScopes) {
      for (const revision of listToolRevisions({
        tenantId: req.auth.tenantId,
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
    return reply.ok({
      tools: listDeclarativeTools(
        req.auth.tenantId,
        binding?.ontologyDomainId ?? null,
      ).map((tool) => {
        const activeRevision = activeRevisionByName.get(tool.name);
        return {
          ...tool,
          activeRevisionId: activeRevision?.id,
          activeRevisionDomainId: activeRevision?.domainId,
          managedLifecycle: Boolean(activeRevision),
          deactivationBlocker: activeRevision
            ? undefined
            : {
                code: "legacy_tool_revision_migration_required",
                message:
                  "这个 active projection 没有对应的 managed revision；请先完成显式 lifecycle migration。",
                next: "migrate_legacy_tool_revision",
              },
        };
      }),
    });
  });

  app.delete<{
    Params: { name: string };
    Querystring: {
      expectedActiveRevisionId?: string;
      revisionDomainId?: string;
    };
  }>(
    "/agent-factory/generated-tools/:name",
    async (req, reply) => {
      // Permanent capability deactivation changes tenant configuration. An
      // operator may invoke agents but only an administrator may retire tools.
      const auth = requirePermission(req, "agents.write");
      const name = decodeURIComponent(req.params.name);
      const expectedActiveRevisionId = String(
        req.query.expectedActiveRevisionId ?? "",
      ).trim();
      if (!expectedActiveRevisionId) {
        return reply.fail(
          "expected_active_revision_required",
          "停用工具必须带 expectedActiveRevisionId",
          400,
        );
      }
      let revisionDomainId: string | undefined;
      try {
        const binding = getFactoryDomainBinding(auth.tenantId);
        const currentDomainId =
          binding?.ontologyDomainId ?? "__unbound__";
        revisionDomainId = String(
          req.query.revisionDomainId ?? currentDomainId,
        ).trim();
        if (
          revisionDomainId !== currentDomainId &&
          revisionDomainId !== "__unbound__"
        ) {
          return reply.fail(
            "not_found",
            "revision domain 不属于当前 ontology 绑定",
            404,
          );
        }
        const actor = auth.userId ?? auth.email;
        if (!actor) {
          return reply.fail(
            "auth_actor_required",
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
        auditFactoryMutation(auth, {
          action: "agent_factory.tool.deactivate",
          targetType: "tool_revision",
          targetId: revision.id,
          outcome: "succeeded",
          meta: {
            name,
            version: revision.version,
            definitionHash: revision.definitionHash,
            revisionDomainId,
          },
        });
        return reply.ok({
          deactivated: true,
          deleted: false,
          retainedHistory: true,
          name,
          revision,
        });
      } catch (error) {
        if (error instanceof ToolRevisionError) {
          auditFactoryMutation(auth, {
            action: "agent_factory.tool.deactivate",
            targetType: "tool",
            targetId: name,
            outcome: "failed",
            errorCode: error.code,
            meta: { revisionDomainId: revisionDomainId ?? null },
          });
          return reply.fail(error.code, error.message, error.statusCode);
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.tool.deactivate",
          targetType: "tool",
          targetId: name,
          outcome: "failed",
          errorCode: "tool_deactivate_failed",
          error,
          meta: { revisionDomainId: revisionDomainId ?? null },
        });
        return reply.fail(
          "tool_deactivate_failed",
          (error as Error).message,
          503,
        );
      }
    },
  );

  // 介入通道 peek — how many injected messages the brain hasn't drained yet, so the sidebar can
  // show "N 条介入待大脑读取" instead of leaving the user guessing whether their input landed.
  app.get<{ Querystring: { conversation?: string } }>(
    "/agent-factory/mailbox",
    async (req, reply) => {
      requirePermission(req, "agents.read");
      const conversation = String(req.query.conversation ?? "").trim();
      if (!conversation)
        return reply.fail("bad_request", "conversation 必填", 400);
      if (!req.auth || !getRun(conversation, req.auth.tenantId))
        return reply.fail("not_found", "conversation not found", 404);
      // Tenant-scoped peek: a guessed foreign conversation id reads as empty, never as
      // another tenant's live-run metadata.
      return reply.ok(peekHumanMessages(conversation, req.auth.tenantId));
    },
  );

  // HITL: inject a human message / a test-case decision into a running brain.
  app.post<{
    Body: {
      conversation?: string;
      text?: string;
      interactionId?: string;
      kind?: FactoryHumanInteractionKind;
    };
  }>("/agent-factory/inject", async (req, reply) => {
    const auth = requirePermission(req, "agents.invoke");
    const conversation = String(req.body?.conversation ?? "").trim();
    const text = String(req.body?.text ?? "").trim();
    const interactionId = String(req.body?.interactionId ?? "").trim();
    const submittedKind = req.body?.kind;
    if (!conversation || !text) {
      auditFactoryMutation(auth, {
        action: "agent_factory.run.inject",
        targetType: "factory_run",
        targetId: conversation || null,
        outcome: "failed",
        errorCode: "bad_request",
      });
      return reply.fail("bad_request", "conversation 和 text 必填", 400);
    }
    const run = getRun(conversation, auth.tenantId);
    if (!run) {
      auditFactoryMutation(auth, {
        action: "agent_factory.run.inject",
        targetType: "factory_run",
        targetId: conversation,
        outcome: "failed",
        errorCode: "not_found",
      });
      return reply.fail("not_found", "conversation not found", 404);
    }
    const responderActor = auth.userId ?? auth.email;
    if (!responderActor?.trim()) {
      return reply.fail(
        "human_actor_required",
        "这条回答可能用于人工确认，但当前凭证没有可审计的用户身份；请用已登录用户重新提交。",
        403,
      );
    }
    let snapshot: Awaited<ReturnType<DrizzleConversationStore["load"]>>;
    try {
      snapshot = await new DrizzleConversationStore(
        auth.tenantId,
        run.domain,
      ).load(conversation);
    } catch (error) {
      return reply.fail(
        "conversation_read_failed",
        (error as Error).message,
        503,
      );
    }
    const rejectHumanInteraction = (
      code: string,
      message: string,
      status: number,
    ) => {
      auditFactoryMutation(auth, {
        action: "agent_factory.run.inject",
        targetType: "factory_run",
        targetId: conversation,
        outcome: "failed",
        errorCode: code,
        meta: { domain: run.domain },
      });
      return reply.fail(code, message, status);
    };
    const durableInteraction = durableHumanInteraction(snapshot?.ctx ?? {});
    const stopping = isStopIntent(text);
    if (!stopping && durableInteraction) {
      if (!durableInteraction.interactionId) {
        return rejectHumanInteraction(
          "human_interaction_upgrade_required",
          "这个等待来自旧版运行，还没有安全的交互编号。请重新打开任务，等系统显示新的交互卡后再提交；本次没有采用你的回复。",
          409,
        );
      }
      if (!interactionId || !submittedKind) {
        return rejectHumanInteraction(
          "human_interaction_id_required",
          "当前正在等你处理一张交互卡。请直接在那张卡里提交，普通消息不会被当作批准或回答。",
          409,
        );
      }
      if (interactionId !== durableInteraction.interactionId) {
        return rejectHumanInteraction(
          "stale_human_interaction",
          "这张交互卡已经结束或被新版替换了，本次回复没有采用。请刷新后在当前卡片上重新提交。",
          409,
        );
      }
      if (submittedKind !== durableInteraction.kind) {
        return rejectHumanInteraction(
          "wrong_human_interaction_kind",
          "这条回复的类型和当前等待的事项不一致，本次没有采用。请在当前交互卡上重新提交。",
          409,
        );
      }
      if (!gateSubmissionMatches(submittedKind, text)) {
        return rejectHumanInteraction(
          "invalid_human_interaction_answer",
          "这条回复不符合当前交互卡的格式，本次没有采用，也没有触发后续操作。请回到当前卡片重新提交。",
          400,
        );
      }
    } else if (!stopping && (interactionId || submittedKind)) {
      return rejectHumanInteraction(
        "stale_human_interaction",
        "这个交互已经结束，本次回复没有采用。请刷新任务查看当前状态。",
        409,
      );
    }
    const clarifyPrompt = snapshot?.ctx?.clarifyPrompt;
    const clarifyContext =
      clarifyPrompt && typeof clarifyPrompt === "object"
        ? String((clarifyPrompt as Record<string, unknown>).context ?? "")
        : "";
    const isAuthorizationChallenge =
      isFactoryAuthorizationChallengeContext(clarifyContext);
    if (isAuthorizationChallenge) {
      // A one-shot authorization can mutate an integration profile or issue
      // real I/O. Ordinary steering remains agents.invoke; answering this
      // server challenge requires the stronger write permission.
      requirePermission(req, "agents.write");
    }
    // Eager domain memory: once the durable conversation snapshot says this
    // conversation is parked at a human gate, persist the answer before
    // acknowledging/queuing it.  This closes the old settle-only loss window
    // (failed/aborted runs used to forget every human teaching).  The strict
    // parser accepts exactly the same gate syntax as the conductor; the
    // conductor repeats the same upsert after consumption as an idempotent
    // fallback for the narrow gate-checkpoint race.
    let memoryRecorded = false;
    try {
      const candidate =
        snapshot && !isAuthorizationChallenge
          ? humanMemoryFromInjectedMessage(snapshot.ctx, text)
          : null;
      if (candidate) {
        await new DrizzleHumanMemoryStore(auth.tenantId, run.domain).upsert(
          run.domain,
          {
            questionKey: humanMemoryQuestionKey(
              candidate.kind,
              candidate.question,
            ),
            ...candidate,
            source: "human",
            conversationId: conversation,
            confirmed: true,
          },
        );
        memoryRecorded = true;
      }
    } catch (error) {
      auditFactoryMutation(auth, {
        action: "agent_factory.run.inject",
        targetType: "factory_run",
        targetId: conversation,
        outcome: "failed",
        errorCode: "human_memory_persist_failed",
        error,
        meta: { domain: run.domain },
      });
      return reply.fail(
        "human_memory_persist_failed",
        `人工回答未能安全写入领域记忆，消息尚未入队：${(error as Error).message}`,
        503,
      );
    }
    // A timed-out HITL run has deliberately released its in-process driver.
    // Wake that exact durable gate before enqueueing the reply. Starting first
    // keeps the acknowledgement honest: if recovery cannot start, no mailbox
    // copy is accepted and the user can safely retry without duplicating a
    // decision. A concurrent/live driver is merely re-attached.
    const waitingCtx = snapshot?.ctx ?? {};
    const hasDurableHumanGate = Boolean(
      waitingCtx.awaitingClarify ||
      waitingCtx.awaitingBoundary ||
      (waitingCtx.awaitingApproval && !waitingCtx.testDataSupplementPending),
    );
    const shouldResumeHumanGate =
      run.status === "waiting_human" && hasDurableHumanGate;
    let resumeEnsured = false;
    try {
      let resumed = false;
      let ensuredRunId: string | null = null;
      if (shouldResumeHumanGate) {
        const ensured = await startFactoryRun(
          auth,
          run.domain,
          run.goal,
          conversation,
          "human_gate_resume",
        );
        resumed = ensured.mode === "started";
        ensuredRunId = ensured.runId;
        resumeEnsured = true;
      }
      const enqueueResult = enqueueHumanMessage(
        conversation,
        text,
        auth.tenantId,
        responderActor,
        durableInteraction?.interactionId && submittedKind
          ? {
              interactionId: durableInteraction.interactionId,
              gateKind: submittedKind,
            }
          : undefined,
      );
      if (enqueueResult === "duplicate_interaction") {
        return rejectHumanInteraction(
          "duplicate_human_interaction",
          "这张交互卡的回复已经提交过了，本次没有重复入队。请等 Agent 工厂处理；如果页面没有更新，再刷新任务。",
          409,
        );
      }
      if (enqueueResult !== "queued") {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.inject",
          targetType: "factory_run",
          targetId: conversation,
          outcome: "failed",
          errorCode: "forbidden",
          meta: { domain: run.domain },
        });
        return reply.fail(
          "forbidden",
          "conversation belongs to another tenant",
          403,
        );
      }
      const active = isActiveRun(conversation);
      // #USER-MESSAGE — echo the human's words onto the live transcript (gate answers and injected
      // notes were invisible in the chat). Falls back silently when no in-memory run is attached;
      // the mailbox delivery above is the source of truth either way.
      emitUserMessage(ensuredRunId ?? conversation, auth.tenantId, text);
      auditFactoryMutation(auth, {
        action: "agent_factory.run.inject",
        targetType: "factory_run",
        targetId: conversation,
        outcome: "succeeded",
        meta: {
          domain: run.domain,
          active,
          resumed,
          memoryRecorded,
          delivery: active ? "live_mailbox" : "durable_mailbox",
        },
      });
      return reply.ok(
        {
          queued: true,
          active,
          resumed,
          runId: ensuredRunId ?? conversation,
          memoryRecorded,
        },
        202,
      );
    } catch (error) {
      const errorCode =
        shouldResumeHumanGate && !resumeEnsured
          ? "human_gate_resume_failed"
          : "message_persist_failed";
      auditFactoryMutation(auth, {
        action: "agent_factory.run.inject",
        targetType: "factory_run",
        targetId: conversation,
        outcome: "failed",
        errorCode,
        error,
        meta: { domain: run.domain, memoryRecorded },
      });
      return reply.fail(errorCode, (error as Error).message, 503);
    }
  });

  // FDE-first scope discovery. The model receives only the current bound,
  // authoritative Ontology catalog and returns exact actor=Agent ids. A failed
  // model/parse never degrades to "select everything".
  app.post<{ Body: unknown }>(
    "/agent-factory/scope-recommendation",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const parsed = FactoryScopeRecommendationRequestSchema.safeParse(
        req.body,
      );
      if (!parsed.success) {
        auditFactoryMutation(auth, {
          action: "agent_factory.scope.recommend",
          targetType: "ontology_domain",
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail(
          "bad_request",
          parsed.error.issues[0]?.message ?? "domain/scenario 参数无效",
          400,
        );
      }
      const { domain, scenario } = parsed.data;
      try {
        await requireBoundFactoryDomain(auth, domain);
        const ontology = await makeFactoryPorts(
          auth.tenantSlug,
          auth.tenantId,
          domain,
        ).ontology.fetchOntology(domain);
        const recommendation = await recommendFactoryActionScope({
          ontology,
          scenario,
          scopeKey: `${auth.tenantId}\0${auth.tenantSlug}`,
        });
        issueFactoryScopeRecommendation({
          tenantId: auth.tenantId,
          domain,
          recommendation,
        });
        auditFactoryMutation(auth, {
          action: "agent_factory.scope.recommend",
          targetType: "ontology_domain",
          targetId: domain,
          outcome: "succeeded",
          meta: {
            mode: recommendation.mode,
            actionCount: recommendation.actionIds.length,
            unresolvedCount: recommendation.unresolved?.length ?? 0,
          },
        });
        return reply.ok(recommendation);
      } catch (error) {
        const errorCode =
          error instanceof FactoryDomainBindingError
            ? error.code
            : error instanceof FactoryScopeRecommendationError
              ? error.code
              : "scope_recommendation_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.scope.recommend",
          targetType: "ontology_domain",
          targetId: domain,
          outcome: "failed",
          errorCode,
          error,
        });
        if (error instanceof FactoryDomainBindingError) {
          return bindingFailure(reply, error);
        }
        if (error instanceof FactoryScopeRecommendationError) {
          return reply.fail(
            error.code,
            error.message,
            error.code === "scenario_required"
              ? 400
              : error.retryable
                ? 503
                : 422,
          );
        }
        return reply.fail(
          "scope_recommendation_failed",
          "暂时无法生成 Action 范围推荐；本次没有默认全选，请稍后重试。",
          503,
        );
      }
    },
  );

  // Canonical start/continue transport.  Goals can include full attachment
  // contents without URL encoding or client-side truncation.  Starting is a
  // separate acknowledgement from streaming so an EventSource reconnect never
  // accidentally creates a second run.
  app.post<{ Body: unknown }>(
    "/agent-factory/runs/start",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const parsed = FactoryRunStartRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const raw =
          req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
        auditFactoryMutation(auth, {
          action: "agent_factory.run.start",
          targetType: "factory_run",
          targetId:
            typeof raw.conversation === "string"
              ? raw.conversation.trim() || null
              : null,
          outcome: "failed",
          errorCode: "bad_request",
          meta: {
            domain:
              typeof raw.domain === "string" ? raw.domain.trim() || null : null,
          },
        });
        return reply.fail(
          "bad_request",
          parsed.error.issues[0]?.message ?? "启动参数无效",
          400,
        );
      }
      const {
        domain,
        goal = "",
        scenario = "",
        conversation: conversationId,
        interactionPolicy,
        recommendationId,
        ontologyHash,
      } = parsed.data;
      const actionIds = parsed.data.actionIds ?? [];
      if (new Set(actionIds).size !== actionIds.length) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.start",
          targetType: "factory_run",
          targetId: conversationId ?? null,
          outcome: "failed",
          errorCode: "bad_request",
          meta: { domain },
        });
        return reply.fail("bad_request", "actionIds 不能包含重复项", 400);
      }
      const hasStructuredScope = actionIds.length > 0 || Boolean(scenario);
      if (hasStructuredScope && (!recommendationId || !ontologyHash)) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.start",
          targetType: "factory_run",
          targetId: conversationId ?? null,
          outcome: "failed",
          errorCode: "scope_recommendation_required",
          meta: { domain },
        });
        return reply.fail(
          "scope_recommendation_required",
          "请先描述业务目标并分析 Ontology，再接受或微调 AI 推荐的 Action 范围。",
          409,
        );
      }
      try {
        let generationDirective: FactoryGenerationDirective | undefined;
        let executionGoal = goal;
        let recommendationTuned = false;
        if (hasStructuredScope) {
          await requireBoundFactoryDomain(auth, domain);
          const ontology = await makeFactoryPorts(
            auth.tenantSlug,
            auth.tenantId,
            domain,
          ).ontology.fetchOntology(domain);
          assertFactoryScopeRecommendationCurrent({
            scopeKey: `${auth.tenantId}\0${auth.tenantSlug}`,
            domain,
            ontology,
            scenario,
            recommendationId: recommendationId!,
            ontologyHash: ontologyHash!,
          });
          const issued = getIssuedFactoryScopeRecommendation({
            tenantId: auth.tenantId,
            domain,
            scenario,
            recommendationId: recommendationId!,
            ontologyHash: ontologyHash!,
          });
          if (!issued) {
            throw new FactoryScopeRecommendationError(
              "scope_recommendation_stale",
              "这条 Action 范围推荐未签发、已过期或服务已重启，请重新分析 Ontology。",
            );
          }
          if (issued.mode !== "virtual_scenario" && actionIds.length === 0) {
            throw new FactoryScopeRecommendationError(
              "scope_recommendation_invalid",
              "已有 Action 的推荐范围不能被清空；请至少保留一个 Action，或重新描述场景进行分析。",
            );
          }
          recommendationTuned =
            issued.actionIds.length !== actionIds.length ||
            issued.actionIds.some((id) => !actionIds.includes(id));
          generationDirective = createFactoryGenerationDirective({
            ontology,
            actionIds,
            scenario,
            forceVirtual:
              issued.mode === "virtual_scenario" && actionIds.length === 0,
          });
          executionGoal = factoryGenerationGoal(generationDirective, goal);
        }
        const persistGoal = goal.trim()
          ? goal
          : scenario ||
            (generationDirective
              ? `生成 Action：${generationDirective.requestedActionNames.join("、")}`
              : executionGoal);
        const started = await startFactoryRun(
          auth,
          domain,
          executionGoal,
          conversationId,
          undefined,
          {
            interactionPolicy,
            generationDirective,
            persistGoal,
          },
        );
        auditFactoryMutation(auth, {
          action: "agent_factory.run.start",
          targetType: "factory_run",
          targetId: started.runId,
          outcome: "succeeded",
          meta: {
            domain,
            mode: started.mode,
            conversationId: conversationId ?? null,
            interactionPolicy: interactionPolicy ?? "strict",
            generationMode: generationDirective?.mode ?? "legacy_goal",
            actionCount: generationDirective?.requestedActionIds.length ?? 0,
            recommendationId: recommendationId ?? null,
            recommendationTuned,
          },
        });
        return reply.ok(
          {
            ...started,
            interactionPolicy: interactionPolicy ?? "strict",
            ...(generationDirective
              ? {
                  generation: {
                    mode: generationDirective.mode,
                    actionIds: generationDirective.requestedActionIds,
                    actionNames: generationDirective.requestedActionNames,
                    virtualAction: generationDirective.virtualAction
                      ? {
                          id: generationDirective.virtualAction.id,
                          name: generationDirective.virtualAction.name,
                          trigger: generationDirective.virtualAction.trigger,
                          emit: generationDirective.virtualAction
                            .triggered_event,
                          provenance:
                            generationDirective.virtualAction.factoryProvenance,
                        }
                      : null,
                  },
                }
              : {}),
          },
          202,
        );
      } catch (error) {
        const errorCode =
          error instanceof FactoryDomainBindingError
            ? error.code
            : error instanceof FactoryGenerationDirectiveError
              ? error.code
              : error instanceof FactoryScopeRecommendationError
                ? error.code
                : error instanceof FactoryRunStartRequestError ||
                    error instanceof FactoryMessageDeliveryError
                  ? error.code
                  : "run_start_failed";
        auditFactoryMutation(auth, {
          action: "agent_factory.run.start",
          targetType: "factory_run",
          targetId: conversationId ?? null,
          outcome: "failed",
          errorCode,
          error,
          meta: { domain, conversationId: conversationId ?? null },
        });
        if (error instanceof FactoryDomainBindingError)
          return bindingFailure(reply, error);
        if (error instanceof FactoryGenerationDirectiveError) {
          return reply.fail(error.code, error.message, 400);
        }
        if (error instanceof FactoryScopeRecommendationError) {
          return reply.fail(
            error.code,
            error.message,
            error.code === "scope_recommendation_stale" ? 409 : 422,
          );
        }
        if (error instanceof FactoryRunStartRequestError) {
          return reply.fail(error.code, error.message, error.status);
        }
        if (error instanceof FactoryMessageDeliveryError) {
          return reply.fail(error.code, error.message, 503);
        }
        return reply.fail(
          "run_start_failed",
          (error as Error).message ?? "无法启动 Agent 工厂任务",
          503,
        );
      }
    },
  );

  // Stop button — abort the detached background run.
  app.post<{ Body: { runId?: string } }>(
    "/agent-factory/stop",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const runId = String(req.body?.runId ?? "").trim();
      if (!runId) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.stop",
          targetType: "factory_run",
          outcome: "failed",
          errorCode: "bad_request",
        });
        return reply.fail("bad_request", "runId 必填", 400);
      }
      try {
        const run = getRun(runId, auth.tenantId);
        if (!run) {
          auditFactoryMutation(auth, {
            action: "agent_factory.run.stop",
            targetType: "factory_run",
            targetId: runId,
            outcome: "failed",
            errorCode: "not_found",
          });
          return reply.fail("not_found", "run not found", 404);
        }
        // If it wasn't live in the registry it may be ORPHANED (api/HMR restart left the durable
        // row stuck 'running') — flip that row to 'aborted' so the stuck "运行中" actually clears.
        const aborted = abortRun(runId, auth.tenantId);
        const finalized = aborted
          ? false
          : forceFinalizeAborted(runId, auth.tenantId);
        if (!aborted && !finalized) {
          auditFactoryMutation(auth, {
            action: "agent_factory.run.stop",
            targetType: "factory_run",
            targetId: runId,
            outcome: "failed",
            errorCode: "not_running",
            meta: { status: run.status },
          });
          return reply.fail(
            "not_running",
            `运行已处于 ${run.status}，没有可取消的执行`,
            409,
          );
        }
        if (finalized && getRun(runId, auth.tenantId)?.status !== "aborted") {
          throw new Error(
            "orphaned factory run was not durably finalized as aborted",
          );
        }
        auditFactoryMutation(auth, {
          action: "agent_factory.run.stop",
          targetType: "factory_run",
          targetId: runId,
          outcome: "succeeded",
          meta: {
            mode: aborted ? "live_abort_requested" : "orphan_durably_finalized",
            previousStatus: run.status,
          },
        });
        return reply.ok({ aborted, finalized }, aborted ? 202 : 200);
      } catch (error) {
        auditFactoryMutation(auth, {
          action: "agent_factory.run.stop",
          targetType: "factory_run",
          targetId: runId,
          outcome: "failed",
          errorCode: "stop_failed",
          error,
        });
        return reply.fail("stop_failed", (error as Error).message, 503);
      }
    },
  );

  app.get<{
    Querystring: {
      domain?: unknown;
      goal?: unknown;
      conversation?: unknown;
      run?: unknown;
    };
  }>("/agent-factory/stream", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("unauthorized", "需要租户上下文", 401);
    // Starting through a GET was the source of URL overflow and attachment
    // truncation.  Reject the legacy shape explicitly even if a `run` was
    // also supplied, so no caller can believe query-string input was used.
    if (
      req.query.domain != null ||
      req.query.goal != null ||
      req.query.conversation != null
    ) {
      return reply.fail(
        "stream_start_not_supported",
        "请先 POST /agent-factory/runs/start，再用 runId 连接 stream",
        400,
      );
    }
    const reconnectId =
      typeof req.query.run === "string" ? req.query.run.trim() : "";
    if (!reconnectId)
      return reply.fail("bad_request", "run 必须是非空字符串", 400);
    if (!getRun(reconnectId, req.auth.tenantId)) {
      return reply.fail("not_found", "run not found", 404);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": open\n\n");

    let unsub: (() => void) | null = null;
    let ended = false;
    let unregisterDrain: () => void = () => undefined;
    // #ALIVE-PING — the old `: ping` was an SSE COMMENT, which per spec NEVER dispatches
    // EventSource.onmessage; the client's 60s silence watchdog therefore false-fired on every
    // legitimately quiet stretch (ask_user park waits up to 180s for the human; a deep-reasoning
    // call's first token can take 60–90s) — the recurring「该运行已无响应——已解锁」incident.
    // Fix: while the run is GENUINELY alive in the registry, send a real data frame the client
    // can see (and ignore for the transcript). A true zombie (driver gone / run evicted) gets
    // only the comment ping, so the watchdog still catches real corpses.
    const pingRunId = reconnectId;
    const keepalive = setInterval(() => {
      try {
        if (pingRunId && isActiveRun(pingRunId))
          reply.raw.write(`data: {"t":"ping"}\n\n`);
        else reply.raw.write(": ping\n\n");
      } catch {
        /* socket gone */
      }
    }, 15_000);
    const endStream = () => {
      if (ended) return;
      ended = true;
      clearInterval(keepalive);
      if (unsub) unsub();
      unregisterDrain();
      try {
        reply.raw.write("event: end\ndata: ok\n\n");
        reply.raw.end();
      } catch {
        /* socket gone */
      }
    };
    // Client disconnect → only UNSUBSCRIBE; the background run keeps going.
    req.raw.on("close", () => {
      ended = true;
      clearInterval(keepalive);
      if (unsub) unsub();
      unregisterDrain();
    });
    unregisterDrain = registerStreamDrain(endStream);

    const send = (f: unknown) => {
      try {
        reply.raw.write(frame(f));
      } catch {
        /* socket gone */
      }
      // The run's `done` frame ends THIS connection (the run itself already finished).
      if (f && typeof f === "object" && (f as { t?: string }).t === "done")
        setTimeout(endStream, 50);
    };

    // Attach to the live run, or replay from the durable row.
    unsub = subscribeRun(reconnectId, send, req.auth.tenantId);
    if (!unsub) {
      const durable = await readDurableRun(reconnectId, req.auth.tenantId);
      send({ t: "run.started", runId: reconnectId });
      if (durable?.deleted) {
        send({
          t: "message",
          text: "该运行已被删除（在回收站中，可在历史里恢复后再查看）。",
        });
      } else if (durable) {
        for (const e of durable.transcript) send(e);
        send({ t: "message", text: "（已从存档回放该运行）" });
      } else {
        send({
          t: "message",
          text: "该运行不在内存中且无存档——可能已被清理。",
        });
      }
      endStream();
    }
    return reply;
  });
}
export function isFactoryAuthorizationChallengeContext(value: string): boolean {
  return /^(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i.test(
    value,
  );
}
