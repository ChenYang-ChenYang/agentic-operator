// Draft → live promotion. A finished factory run persists its agents as durable DRAFTS
// (FsAgentDraftStore, off the live tables). Promotion is the EXPLICIT step that turns
// chosen drafts into real, running Fleet agents for a tenant.
//
// Safety: promotion is ADDITIVE. We load the tenant's CURRENT live workflow manifest and
// merge the promoted agents into it (replace/add by id, keep everything else), then run
// the SAME validate → commit pipeline a normal manifest deploy uses (which registers the
// Inngest functions). So promoting never clobbers a tenant's existing agents, and it
// fails CLOSED — a hard validation issue aborts before any commit.

import {
  assertGeneratedSpecExecutionOwner,
  assertGeneratedSpecToolPoliciesCurrent,
  compileGraph,
  verifyGraph,
  lintGeneratedToolCode,
  validateGeneratedToolAllowlist,
  validateGeneratedToolCoverage,
  validateGeneratedSpecIntegrationProfiles,
} from "@agentic/agent-factory";
import {
  validate as miValidate,
  commit as miCommit,
  createFactoryPromotionImportAuthorization,
  loadLiveManifest,
  type TenantCtx,
} from "../manifest-import";
import {
  buildProductionCodeAttestations,
  externalInputCoverageGaps,
  mapToManifest,
  specsToActions,
} from "./sandbox-deployer";
import { FsAgentDraftStore } from "./agent-draft-store";
import { getFactoryDomainBinding } from "./domain-binding";
import { beginFactoryActiveWork } from "./active-work";
import { verifyHumanReviewReceipt } from "./draft-review";
import { regressionModuleHash, regressionSpecHash } from "./regression-artifact";
import { inspectMergedPromotionSafety, promotionSafetyIssueMessage } from "./promotion-safety";
import { currentFactoryExecutionTools } from "./execution-resource-snapshot";
import {
  factoryPromotionDeploymentNote,
  stageFactoryPromotionRegression,
} from "./promotion-regression-ledger";
import { loadRemoteSandboxConnectionConfig } from "./remote-sandbox-deployer";
import { verifySandboxExecutionPlaneReceipt } from "./sandbox-remote-protocol";
import {
  assertAuthoritativeOntologyCurrent,
  sameAuthoritativeOntologyEvidence,
} from "./authoritative-ontology-evidence";
import { makeBoundFactoryOntologySource } from "./bound-ontology-source";
import { assertFactoryProductionImageTrustReady } from "./production-image-attestation";
import {
  productionIntegrationProbeIssueMessage,
  verifyProductionIntegrationProbeEvidence,
} from "./production-integration-probe-gate";

export interface PromoteDraftRequest {
  versionId: string;
  receiptId: string;
  slugs?: string[];
}

export interface PromoteResult {
  promoted: string[]; // slugs that were committed
  total: number; // how many drafts matched the request
  functionsRegistered: number; // Inngest functions registered by the commit
  liveAgents: number; // total agents in the tenant's workflow after the merge
  /** Exact target-tenant production deployment created by this promotion. */
  deploymentId?: string;
  activation?: {
    verified: true;
    appId: string;
    expectedFunctionCount: number;
    observedFunctionCount: number;
    evidence: "dev_graphql" | "cloud_sync_acceptance" | "test_only_bypass";
    checkedAt: string;
  };
  regression?: {
    versionId?: string;
    evidenceFingerprint?: string;
    suiteFingerprint?: string;
    sandboxCleanupReceiptHash?: string;
    authoritativeOntologyContentHash?: string;
    casesReplayed: number;
    promotionRecordId?: string;
  };
  review?: {
    receiptId: string;
    reviewedBy: string;
    reviewedAt: string;
    previewHash: string;
  };
}

const idOf = (a: unknown): string | undefined => (a && typeof a === "object" ? (a as { id?: string }).id : undefined);

/** Promote a domain's drafts (all, or the given slugs) into the tenant's live workflow. */
/** #NOMOCK — a mock/simulation agent must NEVER reach live production. create_mock_agent stubs and
 *  synthesized external-platform stubs are sandbox-closure scaffolds; if promoted, production would
 *  run a fake platform returning canned success. Detect by slug/marker and refuse. */
function isMockDraft(d: { slug: string; spec?: unknown }): boolean {
  if (/-mock-ext-|(^|[-_])mock([-_]|$)|(^|[-_])simulate([-_]|$)|mock_/i.test(d.slug)) return true;
  const sp = d.spec as { isMock?: boolean; mock?: boolean } | undefined;
  return sp?.isMock === true || sp?.mock === true;
}

async function promoteDraftsActive(domain: string, request: PromoteDraftRequest, ctx: TenantCtx): Promise<PromoteResult> {
  try {
    const trust = assertFactoryProductionImageTrustReady({ requiredTopology: "external_sandbox" });
    const explicitUnitTestBypass = process.env.NODE_ENV === "test"
      && process.env.VITEST === "true"
      && process.env.FACTORY_ALLOW_TEST_PROMOTION === "1";
    if (trust.state === "disabled" && !explicitUnitTestBypass) {
      throw new Error(
        "当前 API 不是启用生产镜像信任验证的 production 进程；这里只能做本地诊断，不能生成 production deployment/ledger",
      );
    }
  } catch (error) {
    throw new Error(
      `拒绝晋升：生产镜像的主机签名证明缺失、已过期或与当前部署不一致——${String((error as Error)?.message ?? error)}。请先让主机验证器重新检查当前镜像，再重新提交晋升。`,
    );
  }
  // Route guards are not a trust boundary: jobs/tests/internal callers can invoke this
  // service directly. Promotion is the production mutation point, so re-check the
  // persisted tenant→ontology relation here and use strict identity (not name aliases).
  const binding = getFactoryDomainBinding(ctx.tenantId);
  if (!binding) throw new Error(`业务领域「${ctx.tenantSlug}」尚未连接本体，拒绝晋升。`);
  if (binding.ontologyDomainId !== domain) {
    throw new Error(`业务领域「${ctx.tenantSlug}」只允许晋升已连接本体「${binding.ontologyDomainId}」的草稿，不能晋升「${domain}」。`);
  }

  const draftStore = new FsAgentDraftStore({ tenantId: ctx.tenantId, tenantSlug: ctx.tenantSlug, ontologyDomainId: domain });
  if (!request.versionId?.trim() || !request.receiptId?.trim()) {
    throw new Error("拒绝晋升：必须指定不可变草稿 versionId 和服务端签发的人工 code/design sign-off receiptId。");
  }
  const all = await draftStore.getVersion(domain, request.versionId);
  if (!all.length) throw new Error(`找不到不可变草稿版本：${request.versionId}`);
  const immutableSlugs = new Set(all.map((draft) => draft.slug));
  const selectedSlugs = request.slugs === undefined ? null : [...request.slugs];
  const want = selectedSlugs === null ? null : new Set(selectedSlugs);
  if (want && selectedSlugs) {
    const missing = [...immutableSlugs].filter((slug) => !want.has(slug));
    const unexpected = [...want].filter((slug) => !immutableSlugs.has(slug));
    const duplicateSelection = want.size !== selectedSlugs.length;
    if (
      missing.length
      || unexpected.length
      || duplicateSelection
      || want.size !== immutableSlugs.size
    ) {
      const complete = [...immutableSlugs].sort().join("、");
      const selected = selectedSlugs.length
        ? [...selectedSlugs].sort().join("、")
        : "（空）";
      throw new Error(
        `拒绝部分晋升：不可变草稿版本「${request.versionId}」是一套经过整体 sandbox 回放和人工审查的完整工作流，不能只上线其中一部分。完整 Agent 集合：${complete}；本次选择：${selected}。请确认后晋升完整集合；如果只想调整部分 Agent，请先生成新的完整不可变版本，并重新执行 sandbox 回放与人工审查。`,
      );
    }
  }
  const requested = want ? all.filter((d) => want.has(d.slug)) : all;
  const invalidDomain = requested.filter((d) => d.domain !== domain || d.spec?.domainId !== domain);
  if (invalidDomain.length) {
    throw new Error(`拒绝晋升领域归属不一致的草稿：${invalidDomain.map((d) => d.slug).join("、")}`);
  }
  // #NOMOCK — mock/simulation drafts are sandbox-closure scaffolds, not production. If the user
  // selected mock slugs → refuse loudly. A reviewed preview and the committed
  // selection must be identical, so production never silently drops entries.
  const mockChosen = requested.filter(isMockDraft);
  if (mockChosen.length) {
    throw new Error(`拒绝晋升模拟桩到生产：${mockChosen.map((d) => d.slug).join("、")}。模拟 agent 是沙箱闭链脚手架，生产会调到假平台（假成功）。请接入真实集成后再晋升，或不要选中它们。`);
  }
  const chosen = requested;
  if (!chosen.length) return { promoted: [], total: 0, functionsRegistered: 0, liveAgents: loadLiveManifest(ctx).length };
  const chosenSpecs = chosen.map((draft) => draft.spec as import("@agentic/agent-factory").GeneratedAgentSpec);
  for (const spec of chosenSpecs) {
    try {
      assertGeneratedSpecExecutionOwner(spec);
    } catch (error) {
      throw new Error(
        `拒绝晋升：${spec.slug} 的执行所有权不安全——${String((error as Error)?.message ?? error)}。含工具、invoke、foreach 或错误策略的代码目前只能作为审查参考，必须由声明式 durable steps 运行。`,
      );
    }
  }
  // A codeExecuted draft is an explicit production CodeAct request. Resolve the
  // exact handler identities up front; incomplete code must abort promotion and
  // can never be silently rewritten to a declarative agent.
  const productionCodeAttestations = buildProductionCodeAttestations(chosenSpecs);

  // The receipt is minted only by the interactive review endpoint (cookie/dev
  // user; API tokens are rejected) and is HMAC-bound to tenant/domain/version,
  // every selected spec+module hash, and the exact live→candidate preview.
  // Recomputing it here makes both draft drift and concurrent live changes fail
  // closed before any deployment row or manifest file can be created.
  let humanReview = await verifyHumanReviewReceipt({
    domain,
    versionId: request.versionId,
    slugs: chosen.map((draft) => draft.slug),
    receiptId: request.receiptId,
    ctx,
  });

  // #REGRESSION — production promotion never trusts a historical green badge.
  // Re-validate the immutable suite/cassette identities and execute the exact
  // persisted generated modules now. Legacy or tampered drafts fail closed.
  const regression = await draftStore.replayRegression(domain, chosen.map((draft) => draft.slug), request.versionId);
  if (!regression.pass) {
    const failures = [
      ...regression.errors,
      ...regression.results.filter((entry) => !entry.pass || !entry.ran).flatMap((entry) => entry.reasons.map((reason) => `${entry.slug}/${entry.caseId}: ${reason}`)),
    ];
    throw new Error(`拒绝晋升：当前草稿版本的回归套件未通过——${failures.slice(0, 6).join("；") || "没有可重放的通过证据"}。请重新运行 Agent Factory 沙箱并 finish，生成新的版本化回归工件。`);
  }
  if (regression.promotionEvidenceReady !== true) {
    throw new Error(
      `拒绝晋升：这个版本的不可变沙箱回放证据不完整或已漂移，不能进入独立的 production live-probe 门禁——${(regression.promotionEvidenceErrors ?? [])
        .slice(0, 6)
        .join("；") || "sandbox replay evidence qualification is blocked"}。请创建新的临时 App 重跑并重新人工审查；不会原地修改证据。`,
    );
  }
  if (
    regression.sandboxExternalLiveCalls !== 0 ||
    regression.sandboxReplayEvidenceComplete !== true
  ) {
    throw new Error(
      `拒绝晋升：完整 Inngest 沙箱没有提供 externalLiveCalls=0 的 attempt-bound evidence replay 回执（当前=${String(regression.sandboxExternalLiveCalls ?? "unknown")}）。请重新运行 Agent Factory 沙箱；不会把缺失证据当成零调用。`,
    );
  }
  if (!regression.sandboxExecutionReceipt) {
    throw new Error(
      "拒绝晋升：这个版本没有外部隔离 runner 的签名执行凭证。主 API/本地 worker 的绿色结果只能用于开发诊断，请在独立 sandbox runner 重新跑完并 finish。",
    );
  }
  if (!regression.sandboxModelUsage) {
    throw new Error(
      "拒绝晋升：这个版本没有与 sandbox attempt/bundle 绑定的真实模型调用账本。externalLiveCalls=0 只说明外部工具未直连，不能证明模型是否运行或预算是否记账。请重新跑沙箱。",
    );
  }
  if (!regression.authoritativeOntology) {
    throw new Error(
      "拒绝晋升：不可变回归工件没有权威 Ontology 身份和摘要。请重新执行“预检 → 新建沙箱测试 → 人工审查”。",
    );
  }
  try {
    const remote = loadRemoteSandboxConnectionConfig();
    verifySandboxExecutionPlaneReceipt(regression.sandboxExecutionReceipt, {
      secret: remote.receiptSigningKey,
      expected: {
        candidateFingerprint: regression.evidenceFingerprint,
        targetDomainId: domain,
        targetTenantId: ctx.tenantId,
        targetTenantSlug: ctx.tenantSlug,
        sandboxAttemptId: regression.sandboxCleanupReceipt?.sandboxAttemptId,
        modelUsageHash: regression.sandboxModelUsage.evidenceHash,
      },
      expectedRunnerId: remote.runnerId,
      allowedRunnerBuildIds: remote.allowedBuildIds,
      allowedRuntimeImageDigests: remote.allowedImageDigests,
      platformAttestationExpected:
        remote.platformAttestationExpected,
    });
  } catch (error) {
    throw new Error(
      `拒绝晋升：外部 sandbox runner 执行凭证当前无法验签或已不在允许列表——${String((error as Error)?.message ?? error).slice(0, 240)}。请检查 runner key/build/image allowlist；不会退回本地回放放行。`,
    );
  }
  // The historical sandbox auto-fired unproduced external callbacks with `{}`. Module regression
  // could replay that green artifact even though no approved external input ever existed. Rebuild
  // the coverage requirement from the complete immutable draft version and require every such
  // callback to be present in the fingerprint-bound effective test cases before production mutation.
  const externalInputGaps = externalInputCoverageGaps(
    all.map((draft) => draft.spec),
    regression.effectiveEntryEvents ?? [],
  );
  if (externalInputGaps.length) {
    throw new Error(
      `拒绝晋升：外部平台输入 ${externalInputGaps.join("、")} 没有明确批准的测试用例/真实载荷。不得用空对象或模拟回调补链；请 generate_test_cases / supply_test_data 后重新 sandbox_run 与 finish。`,
    );
  }

  // Close the receipt→replay TOCTOU window by recomputing the HMAC-bound
  // selection after replay, then compare every immutable spec/module/runtime
  // handler hash used below with the signed receipt.
  humanReview = await verifyHumanReviewReceipt({
    domain,
    versionId: request.versionId,
    slugs: chosen.map((draft) => draft.slug),
    receiptId: request.receiptId,
    ctx,
  });
  const signedBySlug = new Map(humanReview.receipt.selection.map((artifact) => [artifact.slug, artifact]));
  if (signedBySlug.size !== chosen.length) {
    throw new Error("拒绝晋升：人工签核的 artifact 选择与当前 promotion 选择数量不一致。");
  }
  for (const draft of chosen) {
    const signed = signedBySlug.get(draft.slug);
    if (!signed) throw new Error(`拒绝晋升：人工签核未覆盖 ${draft.slug}。`);
    if (
      !draft.regression?.evidenceFingerprint ||
      signed.sandboxEvidenceFingerprint !== draft.regression.evidenceFingerprint ||
      signed.sandboxEvidenceFingerprint !== regression.evidenceFingerprint
    ) {
      throw new Error(`拒绝晋升：${draft.slug} 的 sandbox code/spec evidence fingerprint 未被人工 HMAC receipt 精确签核或已发生替换。`);
    }
    if (
      !draft.regression?.suiteFingerprint ||
      signed.regressionSuiteFingerprint !== draft.regression.suiteFingerprint ||
      signed.regressionSuiteFingerprint !== regression.suiteFingerprint
    ) {
      throw new Error(`拒绝晋升：${draft.slug} 的回归 suite fingerprint 未被人工 HMAC receipt 精确签核或已发生替换。`);
    }
    if (
      !draft.regression.cleanupReceiptHash ||
      signed.sandboxCleanupReceiptHash !== draft.regression.cleanupReceiptHash ||
      signed.sandboxCleanupReceiptHash !== regression.sandboxCleanupReceiptHash
    ) {
      throw new Error(`拒绝晋升：${draft.slug} 的临时 Inngest App 删除回执未被人工 HMAC receipt 精确签核、与回归工件不一致，或已发生替换。`);
    }
    if (
      !sameAuthoritativeOntologyEvidence(
        draft.regression.authoritativeOntology,
        regression.authoritativeOntology,
      )
      || !sameAuthoritativeOntologyEvidence(
        signed.authoritativeOntology,
        regression.authoritativeOntology,
      )
    ) {
      throw new Error(
        `拒绝晋升：${draft.slug} 的权威 Ontology 身份没有被不可变回归工件和人工签核共同绑定。请重新预检、沙箱测试和人工审查。`,
      );
    }
    const specHash = regressionSpecHash(draft.spec);
    const module = await draftStore.getCode(domain, draft.slug, request.versionId);
    if (module == null) throw new Error(`拒绝晋升：不可变交付模块缺失 ${draft.slug}。`);
    const moduleHash = regressionModuleHash(module);
    if (signed.specHash !== specHash || signed.moduleHash !== moduleHash) {
      throw new Error(`拒绝晋升：${draft.slug} 的签核 spec/module hash 与不可变版本不一致。`);
    }
    if (draft.spec.codeExecuted === true) {
      const generatedCode = draft.spec.generatedCode;
      const runtimeHash = generatedCode ? regressionModuleHash(generatedCode) : "";
      if (!runtimeHash || signed.runtimeCodeHash !== runtimeHash) {
        throw new Error(`拒绝晋升：${draft.slug} 的 production handler hash 未被人工 HMAC receipt 精确签核。`);
      }
      if (!regression.results.some((entry) =>
        entry.slug === draft.slug &&
        entry.pass &&
        entry.ran &&
        entry.execution === "codeact-runtime" &&
        entry.codeHash === runtimeHash
      )) {
        throw new Error(`拒绝晋升：${draft.slug} 没有与 production handler 同 SHA-256 的 exact CodeAct regression replay 通过回执。`);
      }
    }
  }

  // #IAL — production promotion is the fleet-risk moment: an UNBOUNDED event cycle (agents
  // re-triggering each other with no HITL bound inside the loop) would re-fire Inngest functions
  // indefinitely in production. Fail CLOSED here (sandbox runs are bounded by test events, so the
  // same cycle is observable-but-survivable there; production is not). Also re-lint each draft's
  // generated code — defense in depth against unbounded in-handler loops (while(true)/setInterval)
  // that slipped past design-time linting or were introduced by later draft edits.
  {
    const specs = chosenSpecs;
    // Re-read registry definitions, tenant/domain declarative snapshots and
    // both profile environments after regression replay. A reviewed draft is
    // not permission to keep using a tool whose execution policy or confirmed
    // config changed later.
    const currentTools = await currentFactoryExecutionTools({
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      domainId: domain,
    });
    try {
      assertGeneratedSpecToolPoliciesCurrent(specs, currentTools);
    } catch (error) {
      throw new Error(
        `拒绝晋升：当前工具库的执行策略与已审查草稿不一致——${String((error as Error)?.message ?? error)}。请重新 design、sandbox 和人工审查。`,
      );
    }
    const profileValidation = validateGeneratedSpecIntegrationProfiles({
      specs,
      tools: currentTools,
      scope: {
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        domainId: domain,
      },
    });
    if (!profileValidation.ok) {
      throw new Error(
        `拒绝晋升：sandbox/production integration profile 已缺失、漂移或串环境——${profileValidation.issues
          .slice(0, 8)
          .map((issue) => issue.message)
          .join("；")}。请分别重新确认两套 profile，并重跑 sandbox 与人工审查。`,
      );
    }
    const productionProbeIssues = await verifyProductionIntegrationProbeEvidence({
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      domainId: domain,
      specs,
      tools: currentTools,
    });
    if (productionProbeIssues.length) {
      throw new Error(
        `拒绝晋升：正式运行配置还没有与当前工具实现、endpoint 和凭证精确绑定的 live probe——${productionProbeIssues
          .slice(0, 8)
          .map(productionIntegrationProbeIssueMessage)
          .join("；")}。sandbox profile 的探针或 signed fixture 不能替代 production profile；请按正式配置重新探测，再创建新沙箱版本并重新人工审查。`,
      );
    }
    const v = verifyGraph(compileGraph(specsToActions(specs), { domainId: domain }));
    const cycles = v.issues.filter((i) => i.kind === "cycle");
    if (cycles.length) {
      throw new Error(
        `拒绝晋升：检测到无界事件环（IAL 门）——${cycles.map((c) => `${(c as { actions: string[] }).actions.join("→")}（经 ${(c as { events: string[] }).events.join("、")}）`).join("；")}。环内无 HITL 停止界，上线会无限互相重触发。请加退出分支/终态事件或在环内加人工闸口后重新验证。`,
      );
    }
    const unresolved = specs.filter((spec) => (spec.unresolvedTools ?? []).length > 0);
    if (unresolved.length) {
      throw new Error(
        `拒绝晋升：交付规格仍有未解析工具——${unresolved
          .map((spec) => `${spec.slug}: ${(spec.unresolvedTools ?? []).join("、")}`)
          .join("｜")}。promotion 不会把它们静默过滤后上线一份必然失败的代码。`,
      );
    }
    const missingSideEffects = specs.flatMap((spec) => spec.tools
      .filter((name) => !spec.toolSideEffects?.[name])
      .map((name) => `${spec.slug}:${name}`));
    if (missingSideEffects.length) {
      throw new Error(
        `拒绝晋升：工具缺少已审查的 side_effect 元数据——${missingSideEffects.join("、")}。请先补工具库/profile，不能根据名字猜权限。`,
      );
    }
    const lintBad = specs
      .filter((s) => s.codeExecuted && s.generatedCode)
      .map((s) => ({ slug: s.slug, lint: lintGeneratedToolCode(s.generatedCode!) }))
      .filter((x) => !x.lint.ok);
    if (lintBad.length) {
      throw new Error(`拒绝晋升：生成代码未过安全静态检查——${lintBad.map((x) => `${x.slug}: ${x.lint.violations.join("; ")}`).join("｜")}`);
    }
    const allowlistBad = specs
      // Inspect every delivered generatedCode artifact, not only the current
      // CodeAct execution mode. A later mode flip must not turn previously
      // promoted reference code into an unreviewed capability escalation.
      .filter((s) => s.generatedCode)
      .map((s) => ({
        slug: s.slug,
        result: validateGeneratedToolAllowlist(s.generatedCode!, s.tools),
      }))
      .filter((entry) => !entry.result.ok);
    if (allowlistBad.length) {
      throw new Error(
        `拒绝晋升：生成代码的工具调用没有被不可变 spec.tools 精确审查/绑定——${allowlistBad
          .map((entry) => `${entry.slug}: ${entry.result.violations.join("；")}`)
          .join("｜")}。请把需要的工具明确加入 Agent 设计并重新 sandbox/review；动态工具名不允许上线。`,
      );
    }
    const coverageBad = specs
      .filter((spec) => spec.codeExecuted === true && Boolean(spec.generatedCode?.trim()))
      .map((spec) => ({ slug: spec.slug, result: validateGeneratedToolCoverage(spec.generatedCode!, spec.tools) }))
      .filter((entry) => !entry.result.ok);
    if (coverageBad.length) {
      throw new Error(
        `拒绝晋升：CodeAct handler 没有真实覆盖全部已审查工具——${coverageBad
          .map((entry) => `${entry.slug}: ${entry.result.missingReviewedTools.join("、") || entry.result.violations.join("；")}`)
          .join("｜")}。不能用注释或仅声明 tools 冒充真实业务调用；请重新生成代码并重跑 sandbox/review。`,
      );
    }
  }

  // Map through the production CodeAct policy using the exact handler hashes
  // covered by the immutable spec + HMAC receipt + replay gates above.
  if (!regression.suiteFingerprint) {
    throw new Error("拒绝晋升：回归重放未返回不可变 suite fingerprint。");
  }
  const promoted = mapToManifest(chosenSpecs, {
    target: "production",
    targetDomainId: domain,
    productionCodeAttestations,
    productionProvenance: {
      versionId: request.versionId,
      suiteFingerprint: regression.suiteFingerprint,
    },
  });
  const promotedIds = new Set<string>(promoted.map(idOf).filter((id): id is string => !!id));

  // ADDITIVE merge: keep every existing agent, replace/add the promoted ones by id.
  const live = loadLiveManifest(ctx);
  const merged = [...live.filter((a) => {
    const id = idOf(a);
    return !id || !promotedIds.has(id);
  }), ...promoted];

  // #IAL + persistent payload contracts — validate the EFFECTIVE production
  // fleet. Candidate-only graph checks cannot see existing↔new feedback loops
  // or payload drift on an event boundary with an already-live agent.
  const mergedSafety = inspectMergedPromotionSafety({ merged, promotedIds, domainId: domain });
  if (!mergedSafety.ok) {
    throw new Error(
      `拒绝晋升：合并后的 live+candidate 安全校验未通过——${mergedSafety.issues.slice(0, 12).map(promotionSafetyIssueMessage).join("；")}。请消除反馈环并对齐事件两端的持久化 factory_input/output_schema。`,
    );
  }

  if (
    !regression.artifact ||
    !regression.evidenceFingerprint ||
    !regression.suiteFingerprint ||
    !regression.sandboxCleanupReceiptHash
  ) {
    throw new Error("拒绝晋升：无法为 CI 持久化完整的回归工件身份。");
  }
  const stagedRegression = await stageFactoryPromotionRegression({
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    domain,
    versionId: request.versionId,
    slugs: chosen.map((draft) => draft.slug),
    artifactPath: regression.artifact,
    evidenceFingerprint: regression.evidenceFingerprint,
    suiteFingerprint: regression.suiteFingerprint,
    sandboxCleanupReceiptHash: regression.sandboxCleanupReceiptHash,
    reviewReceiptId: humanReview.receipt.receiptId,
  });
  let importAuthorization: ReturnType<
    typeof createFactoryPromotionImportAuthorization
  >;
  try {
    importAuthorization = createFactoryPromotionImportAuthorization({
      tenantId: ctx.tenantId,
      workflow: merged,
      receiptId: humanReview.receipt.receiptId,
      receiptSignature: humanReview.receipt.signature,
      versionId: request.versionId,
      selectionHash: humanReview.receipt.selectionHash,
      candidateManifestHash: humanReview.receipt.candidateManifestHash,
      regressionSuiteFingerprint: regression.suiteFingerprint,
      selectedSlugs: chosen.map((draft) => draft.slug),
      promotion: stagedRegression.record,
    });
  } catch (error) {
    await stagedRegression.abort();
    throw error;
  }

  let committed: Awaited<ReturnType<typeof miCommit>>;
  try {
    // validate (fail closed on hard issues) → commit (registers Inngest fns).
    // The staged durable record is part of the opaque authorization, so the
    // additive merge can authorize only this exact selected set.
    const preview = await miValidate(
      { mode: "validate", workflow: merged, target: "production", confirm_overwrite: true, conflict_resolutions: [] },
      ctx,
      undefined,
      importAuthorization,
    );
    const blocking = preview.issues.filter((i) => i.severity === "error");
    if (blocking.length) {
      throw new Error(`晋升校验未通过：${blocking.map((i) => i.message ?? i.code).join("；")}`);
    }
    // This is intentionally the last external read before the production
    // mutation. Preview/review checks do not authorize a graph that changed
    // while manifest validation or regression staging was in progress.
    await assertAuthoritativeOntologyCurrent({
      ontology: makeBoundFactoryOntologySource(ctx.tenantSlug, ctx.tenantId),
      expected: regression.authoritativeOntology,
      scope: {
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        domainId: domain,
      },
    });
    committed = await miCommit(
      {
        mode: "commit",
        workflow: merged,
        target: "production",
        confirm_overwrite: true,
        deployment_id: preview.deployment_id,
        conflict_resolutions: [],
        note: factoryPromotionDeploymentNote(
          stagedRegression.record.promotionId,
        ),
      },
      ctx,
      undefined,
      importAuthorization,
    );
  } catch (error) {
    await stagedRegression.abort();
    throw error;
  }
  // If this durable finalize fails after the production commit, leave the
  // pending marker in place and fail loudly. Bulk CI replay treats it as an
  // incomplete promotion instead of silently omitting a live version.
  const committedRegressionRecord = await stagedRegression.finalize(committed.deployment_id);
  return {
    promoted: chosen.map((d) => d.slug),
    total: chosen.length,
    functionsRegistered: committed.inngest_fns_registered ?? 0,
    liveAgents: merged.length,
    deploymentId: committed.deployment_id,
    ...(committed.inngest_activation ? {
      activation: {
        verified: true as const,
        appId: committed.inngest_activation.app_id,
        expectedFunctionCount:
          committed.inngest_activation.expected_function_count,
        observedFunctionCount:
          committed.inngest_activation.observed_function_count,
        evidence: committed.inngest_activation.evidence,
        checkedAt: committed.inngest_activation.checked_at,
      },
    } : {}),
    regression: {
      versionId: regression.versionId,
      evidenceFingerprint: regression.evidenceFingerprint,
      suiteFingerprint: regression.suiteFingerprint,
      sandboxCleanupReceiptHash: regression.sandboxCleanupReceiptHash,
      authoritativeOntologyContentHash:
        regression.authoritativeOntology.contentHash,
      casesReplayed: regression.results.length,
      promotionRecordId: committedRegressionRecord.promotionId,
    },
    review: {
      receiptId: humanReview.receipt.receiptId,
      reviewedBy: humanReview.receipt.actor.userId,
      reviewedAt: humanReview.receipt.createdAt,
      previewHash: humanReview.receipt.previewHash,
    },
  };
}

export async function promoteDrafts(domain: string, request: PromoteDraftRequest, ctx: TenantCtx): Promise<PromoteResult> {
  // Register before checking the binding. Because both operations are
  // synchronous, a concurrent rebind can neither slip between the check and
  // the first awaited filesystem/validation step nor proceed mid-promotion.
  const endActiveWork = beginFactoryActiveWork(ctx.tenantId, `promotion:${domain}`, "promotion");
  try {
    return await promoteDraftsActive(domain, request, ctx);
  } finally {
    endActiveWork();
  }
}
