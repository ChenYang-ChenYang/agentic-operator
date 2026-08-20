"use client";

/**
 * OntoCode — the v10-style front door over the factory brain.
 *
 * One workbench: task composer (with @-references) → single execution line →
 * product area (flow strip + agent cards) → 待你决定 todo queue with a
 * dynamically-rendered config overlay. Compact build stages and opt-in
 * diagnostics live in the right rail. Data source is the SAME SSE brain stream + endpoints as /factory —
 * the old page stays available as 高级模式.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { HelpTip } from "@/app/portal/components";
import { usePreferences } from "@/app/portal/lib/preferences-context";
import { useBrainStream, activeRunKey, type BrainStreamRequest } from "@/lib/hooks/useBrainStream";
import {
  AGENT_FACTORY_DOMAIN_KEYS,
  useAgentFactoryDomains,
} from "@/lib/hooks/useAgentFactoryDomains";
import {
  deriveAgents,
  deriveBrainFlow,
  sandboxEvidenceStatus,
  toBlocks,
  type DraftRow,
  type RunRow,
} from "../factory/model";
import { composeFactoryGoal, replayModeForStart } from "../factory/factory-run-start";
import {
  buildOntologyBundle,
  classifyAttachment,
  stripExt,
  type OntologyFile,
} from "../factory/ontology-upload";
import {
  isPromotionPreviewData,
  PromotionReviewModal,
  type PromotionApprovalResult,
  type PromotionCodeArtifact,
  type PromotionPreviewData,
} from "../factory/promotion-review";
import {
  boundaryDecisionText,
  buildOntoCodeIntentGoal,
  clarifyAnswerText,
  confirmPromotionOutcome,
  deriveConnectionReadiness,
  deriveOntoCodeBuildContext,
  deriveExecLine,
  deriveFlowGraph,
  deriveNextSteps,
  deriveOntologyDomainState,
  deriveResolvedGates,
  deriveTodos,
  deriveTokensUsed,
  draftChip,
  isAgentOwnedOntologyAction,
  matchBoundRecommendationActionIds,
  pickPromotableSet,
  resolveOntoCodeComposerSubmit,
  resolveOntoCodeStartMode,
  scopeDraftsToAgents,
  testDecisionText,
  timeAgo,
  type TodoItem,
} from "./oc-model";
import {
  bindFactoryDomain,
  deleteFactoryRun,
  deleteOntologyUpload,
  draftSystemProfile,
  draftToolFromDoc,
  fetchDraftCode,
  fetchFactoryDrafts,
  fetchFactoryRuns,
  fetchOntologyUploads,
  fetchSystemCoverage,
  fetchSystemProfiles,
  type SystemCoverage,
  injectGateAnswer,
  recommendOntoCodeScope,
  promoteDraftSet,
  removeSystemProfile,
  requestPromotionPreview,
  saveSystemProfile,
  saveToolToLibrary,
  startFactoryRun,
  submitPromotionSignoff,
  uploadOntologyBundle,
  type OntoCodeScopeRecommendation,
  type SystemProfileDoc,
} from "./oc-api";
import {
  OcAgentCard,
  OcConfigOverlay,
  OcDomainMenu,
  OcExecLine,
  OcFlowStrip,
  OcNextSteps,
  OcResolvedStrip,
  OcSessionRail,
  OcSystemProfilesPanel,
  OcSystemWorkbench,
  OcTodoQueue,
  OcToolSmithOverlay,
} from "./components";
import "./ontocode.css";

const convKey = (tenant: string, domain: string) => `ao:factory:conv:${tenant}:${domain}`;

export default function OntoCodePage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const router = useRouter();
  const { t } = usePreferences();
  // Same-tab deep-link into Settings → Integrations. Replaces a `window.open`
  // new tab that (a) landed on the default Workspace tab and (b) flashed a
  // blank white page while dev compiled the freshly-opened route. With a
  // provider the editor auto-opens on that provider's DYNAMIC field form.
  const openIntegrations = useCallback(
    (provider?: string) =>
      router.push(
        `/portal/${tenant}/settings?section=integrations${
          provider ? `&provider=${encodeURIComponent(provider)}` : ""
        }`,
      ),
    [router, tenant],
  );
  const queryClient = useQueryClient();

  // ── domain binding ────────────────────────────────────────────────────────
  const domainsQuery = useAgentFactoryDomains(tenant);
  const binding = domainsQuery.data?.binding ?? null;
  const boundDomain = domainsQuery.data?.boundDomain ?? null;
  const boundActions = useMemo(
    () => domainsQuery.data?.boundActions ?? [],
    [domainsQuery.data?.boundActions],
  );
  const agentActions = useMemo(
    () => boundActions.filter(isAgentOwnedOntologyAction),
    [boundActions],
  );
  const hiddenNonAgentActionCount = boundActions.length - agentActions.length;
  const domainId = binding?.ontologyDomainId ?? boundDomain?.id ?? domainsQuery.data?.domains[0]?.id ?? "";
  const domainLabel = boundDomain?.name ?? boundDomain?.id ?? domainId;
  const domainState = deriveOntologyDomainState({
    hasData: domainsQuery.data !== undefined,
    isPending: domainsQuery.isPending,
    isError: domainsQuery.isError,
    domainCount: domainsQuery.data?.domains.length ?? 0,
    domainId,
  });
  const domainBuildBlocked = domainState !== "ready";

  const [domainMenuOpen, setDomainMenuOpen] = useState(false);
  const [domainBusy, setDomainBusy] = useState(false);
  const [uploadedIds, setUploadedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!tenant || !domainMenuOpen) return;
    let cancelled = false;
    void fetchOntologyUploads(t, tenant).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data.uploads)) {
        setUploadedIds(new Set(r.data.uploads.map((u) => u.id)));
      }
    });
    return () => { cancelled = true; };
  }, [tenant, t, domainMenuOpen]);

  // ── composer state ────────────────────────────────────────────────────────
  const [goal, setGoal] = useState("");
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([]);
  const [atTokens, setAtTokens] = useState<string[]>([]);
  const [atOpen, setAtOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [analyzingScope, setAnalyzingScope] = useState(false);
  const [scopeRecommendation, setScopeRecommendation] =
    useState<OntoCodeScopeRecommendation | null>(null);
  const scopeAnalysisNonceRef = useRef(0);

  useEffect(() => {
    scopeAnalysisNonceRef.current += 1;
    setAnalyzingScope(false);
    setSelectedActionIds([]);
    setScopeRecommendation(null);
  }, [domainId]);

  // Never leave a stale, previously valid recommendation actionable after the
  // domain request fails. The retry must recover a fresh Ontology snapshot
  // before the FDE can analyze or generate again.
  useEffect(() => {
    if (domainState !== "error") return;
    scopeAnalysisNonceRef.current += 1;
    setAnalyzingScope(false);
    setSelectedActionIds([]);
    setScopeRecommendation(null);
  }, [domainState]);

  // ── stream ────────────────────────────────────────────────────────────────
  const [streamReq, setStreamReq] = useState<BrainStreamRequest | null>(null);
  const nonceRef = useRef(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const { events, running, error: streamError } = useBrainStream(streamReq);
  const streamedAgentSlugs = useMemo(
    () => deriveAgents(events).map((agent) => agent.slug),
    [events],
  );
  const evidence = useMemo(() => sandboxEvidenceStatus(events), [events]);

  // Reattach ONCE on mount: a still-running brain (activeRunKey) wins; otherwise
  // stay idle. The one-shot guard matters — 「新任务」 sets streamReq back to null,
  // and without it this effect would immediately re-attach the run the user just
  // left (the reported stale-todo bug).
  const reattachedRef = useRef(false);
  useEffect(() => {
    if (!tenant || !domainId || streamReq || reattachedRef.current) return;
    reattachedRef.current = true;
    const active = localStorage.getItem(activeRunKey(tenant));
    const conv = localStorage.getItem(convKey(tenant, domainId));
    if (active) {
      nonceRef.current += 1;
      setConversationId(conv ?? active);
      setStreamReq({
        tenant,
        reconnectRunId: active,
        conversation: conv ?? active,
        replayMode: "replace",
        nonce: nonceRef.current,
      });
    } else if (conv) {
      setConversationId(conv);
    }
  }, [tenant, domainId, streamReq]);

  // ── recent runs ───────────────────────────────────────────────────────────
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsNonce, setRunsNonce] = useState(0);
  useEffect(() => {
    if (!tenant || !domainId) return;
    let cancelled = false;
    void fetchFactoryRuns(t, tenant, domainId).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data.runs)) setRuns(r.data.runs.slice(0, 8));
    });
    return () => { cancelled = true; };
  }, [tenant, domainId, t, running, runsNonce]);

  // ── drafts (deploy candidates) ────────────────────────────────────────────
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [draftsNonce, setDraftsNonce] = useState(0);
  useEffect(() => {
    if (!tenant || !domainId) return;
    let cancelled = false;
    void fetchFactoryDrafts(t, tenant, domainId).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data.drafts)) setDrafts(r.data.drafts);
    });
    return () => { cancelled = true; };
  }, [tenant, domainId, t, running, draftsNonce]);
  const scopedDrafts = useMemo(
    () => scopeDraftsToAgents(drafts, streamedAgentSlugs),
    [drafts, streamedAgentSlugs],
  );
  const promotable = useMemo(() => {
    if (!streamedAgentSlugs.length) {
      return { ok: false as const, reason: "当前任务还没有可部署 Agent" };
    }
    if (running) return { ok: false as const, reason: "生成与验证完成后才能部署" };
    if (evidence !== "real") return { ok: false as const, reason: "当前套件缺少沙箱真跑证据" };
    return pickPromotableSet(scopedDrafts);
  }, [streamedAgentSlugs, running, evidence, scopedDrafts]);

  // ── deploy (promotion) flow ───────────────────────────────────────────────
  const [coverage, setCoverage] = useState<SystemCoverage | null>(null);
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [promotionReview, setPromotionReview] = useState<{
    preview: PromotionPreviewData;
    codeArtifacts: PromotionCodeArtifact[];
  } | null>(null);

  const startDeploy = useCallback(async () => {
    if (!promotable.ok || deployBusy) return;
    if (!coverage) {
      setDeployMsg({ text: "尚未完成本次套件的连接检查，暂不能部署", error: true });
      return;
    }
    const readiness = deriveConnectionReadiness(coverage.systems);
    if (!readiness.allReady) {
      setDeployMsg({
        text: `部署被阻止：${readiness.pending.join("、")} 尚未完成连接验证`,
        error: true,
      });
      setWorkbenchOpen(true);
      return;
    }
    setDeployBusy(true);
    setDeployMsg(null);
    try {
      const { versionId, slugs } = promotable;
      const preview = await requestPromotionPreview(t, tenant, { domain: domainId, versionId, slugs });
      if (!preview.ok) {
        setDeployMsg({ text: `部署预览失败：${preview.message}`, error: true });
        return;
      }
      if (
        !isPromotionPreviewData(preview.data)
        || preview.data.versionId !== versionId
        || [...preview.data.slugs].sort().join("\0") !== [...slugs].sort().join("\0")
      ) {
        setDeployMsg({ text: "部署预览返回不完整——已按安全策略中止", error: true });
        return;
      }
      const codes = await Promise.all(
        slugs.map(async (slug) => ({
          slug,
          result: await fetchDraftCode(t, tenant, { domain: domainId, slug, versionId }),
        })),
      );
      const bad = codes.find(
        ({ slug, result }) =>
          !result.ok || result.data.slug !== slug || typeof result.data.code !== "string" || !result.data.code.trim(),
      );
      if (bad) {
        setDeployMsg({
          text: `读取 ${bad.slug} 的部署代码失败${bad.result.ok ? "" : `：${bad.result.message}`}`,
          error: true,
        });
        return;
      }
      setPromotionReview({
        preview: preview.data,
        codeArtifacts: codes.map(({ result }) => {
          if (!result.ok) throw new Error(result.message);
          return { slug: result.data.slug, filename: result.data.filename, code: result.data.code };
        }),
      });
    } finally {
      setDeployBusy(false);
    }
  }, [promotable, deployBusy, t, tenant, domainId, coverage]);

  const approveDeploy = useCallback(async (): Promise<PromotionApprovalResult> => {
    const pending = promotionReview;
    if (!pending) return { ok: false, message: "审查上下文丢失，请重新发起部署" };
    const { preview } = pending;
    const signoff = await submitPromotionSignoff(t, tenant, {
      domain: domainId,
      versionId: preview.versionId,
      slugs: preview.slugs,
      reviewChallenge: preview.reviewChallenge,
    });
    if (!signoff.ok || !signoff.data.receipt?.receiptId) {
      return { ok: false, message: signoff.ok ? "服务端未返回签核回执" : signoff.message };
    }
    const result = await promoteDraftSet(t, tenant, {
      domain: domainId,
      versionId: preview.versionId,
      receiptId: signoff.data.receipt.receiptId,
      slugs: preview.slugs,
    });
    if (!result.ok) return { ok: false, message: result.message };
    if (!confirmPromotionOutcome(preview.slugs, result.data)) {
      return { ok: false, message: "服务端未确认全部函数上线——请在高级模式核查" };
    }
    setDeployMsg({
      text: `✓ 已部署 ${result.data.promoted.length} 个 agent · 注册 ${result.data.functionsRegistered} 个 Inngest 函数 · 当前在线 ${result.data.liveAgents}`,
      error: false,
    });
    setDraftsNonce((n) => n + 1);
    return { ok: true };
  }, [promotionReview, t, tenant, domainId]);

  // ── projections ───────────────────────────────────────────────────────────
  const blocks = useMemo(() => toBlocks(t, events), [t, events]);
  const agents = useMemo(() => deriveAgents(events), [events]);
  const brainSteps = useMemo(() => deriveBrainFlow(t, events), [t, events]);
  const buildContext = useMemo(() => deriveOntoCodeBuildContext(events), [events]);
  const todos = useMemo(() => deriveTodos(blocks), [blocks]);
  const resolvedGates = useMemo(() => deriveResolvedGates(blocks), [blocks]);
  const tokensUsed = useMemo(() => deriveTokensUsed(events), [events]);
  const exec = useMemo(() => deriveExecLine(events, running), [events, running]);
  const graph = useMemo(() => deriveFlowGraph(agents), [agents]);
  const nextSteps = useMemo(() => deriveNextSteps(exec, todos, tenant), [exec, todos, tenant]);
  const hasAwait = todos.length > 0;
  const showHero = events.length === 0 && !running;
  const hasCurrentTask = events.length > 0 || running;
  const suiteReady = agents.length > 0;
  const sourceBoundActionIds = useMemo(() => {
    const selectable = new Set(agentActions.map((action) => action.id));
    return buildContext.actionIds.filter((id) => selectable.has(id));
  }, [agentActions, buildContext.actionIds]);
  const sourceActionKey = sourceBoundActionIds.slice().sort().join("\0");
  const hasStructuredSourceScope =
    buildContext.actionIds.length > 0
    || buildContext.scenario !== null
    || buildContext.virtualAction !== null;
  useEffect(() => {
    if (!hasCurrentTask || !hasStructuredSourceScope) return;
    const sourceIds = sourceActionKey ? sourceActionKey.split("\0") : [];
    setSelectedActionIds((current) => {
      const currentKey = current.slice().sort().join("\0");
      return currentKey === sourceActionKey ? current : sourceIds;
    });
  }, [hasCurrentTask, hasStructuredSourceScope, sourceActionKey]);
  const logLines = useMemo(() => {
    const lines: string[] = [];
    for (const b of blocks) {
      if (b.kind === "tool") lines.push(`[tool] ${b.name} ${b.ok === undefined ? "…" : b.ok ? "ok" : "FAIL"}${b.summary ? ` — ${b.summary}` : ""}`);
      else if (b.kind === "sandbox") lines.push(`[sbx] ${JSON.stringify(b.ev).slice(0, 160)}`);
      else if (b.kind === "error") lines.push(`[error] ${b.text}`);
      else if (b.kind === "budget") lines.push(`[budget] ${b.text}`);
    }
    return lines.slice(-100);
  }, [blocks]);

  // ── ui state ──────────────────────────────────────────────────────────────
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [overlayTodo, setOverlayTodo] = useState<TodoItem | null>(null);
  const [sendingTodoId, setSendingTodoId] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<"build" | "diagnostics">("build");
  const [railCollapsed, setRailCollapsed] = useState(true);

  useEffect(() => {
    if (window.matchMedia("(max-width: 1100px)").matches) setRailCollapsed(true);
  }, []);

  // A resolved gate disappears from `todos` — clear the pending marker then.
  useEffect(() => {
    if (sendingTodoId && !todos.some((td) => td.id === sendingTodoId)) setSendingTodoId(null);
  }, [todos, sendingTodoId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOverlayTodo(null);
      if (window.matchMedia("(max-width: 1100px)").matches) setRailCollapsed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── 外部系统档案（Platform-Smith） ─────────────────────────────────────────
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [profiles, setProfiles] = useState<SystemProfileDoc[]>([]);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<string | null>(null);
  const [profilesNonce, setProfilesNonce] = useState(0);

  useEffect(() => {
    if (!tenant || !profilesOpen) return;
    let cancelled = false;
    void fetchSystemProfiles(t, tenant).then((r) => {
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data.profiles)) { setProfiles(r.data.profiles); setProfileError(null); }
      else if (!r.ok) setProfileError(r.message);
    });
    return () => { cancelled = true; };
  }, [tenant, t, profilesOpen, profilesNonce]);

  const draftProfile = useCallback(async (input: { text?: string; url?: string; hint?: string }) => {
    setProfileBusy(true);
    setProfileError(null);
    try {
      const r = await draftSystemProfile(t, tenant, input);
      if (!r.ok) { setProfileError(r.message); return; }
      setProfileDraft(JSON.stringify(r.data.draft, null, 2));
    } finally {
      setProfileBusy(false);
    }
  }, [t, tenant]);

  const saveProfile = useCallback(async (profileJson: string) => {
    setProfileBusy(true);
    setProfileError(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(profileJson); } catch { setProfileError("草稿不是合法 JSON"); return; }
      const r = await saveSystemProfile(t, tenant, parsed);
      if (!r.ok) { setProfileError(r.message); return; }
      setProfileDraft(null);
      setProfilesNonce((n) => n + 1);
    } finally {
      setProfileBusy(false);
    }
  }, [t, tenant]);

  const deleteProfile = useCallback(async (profileId: string, name: string) => {
    if (!window.confirm(`删除系统档案「${name}」？集成绑定将不再认识它的别名。`)) return;
    setProfileBusy(true);
    try {
      const r = await removeSystemProfile(t, tenant, profileId);
      if (!r.ok) { setProfileError(r.message); return; }
      setProfilesNonce((n) => n + 1);
    } finally {
      setProfileBusy(false);
    }
  }, [t, tenant]);

  // ── conversation reset（换域/换本体后必须开新会话——与工厂语义一致） ──────────
  const resetConversation = useCallback(() => {
    if (domainId) localStorage.removeItem(convKey(tenant, domainId));
    scopeAnalysisNonceRef.current += 1;
    setAnalyzingScope(false);
    setConversationId(null);
    setStreamReq(null);
    setScopeRecommendation(null);
    setSelectedActionIds([]);
  }, [tenant, domainId]);

  // ── attachments（📎 真实上传：本体 JSON → 建域/并域；其余 → 随 goal 附带） ────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [documents, setDocuments] = useState<OntologyFile[]>([]);

  // ── Tool-Smith（📎 工具文档 → 提炼入库） ─────────────────────────────────────
  const [toolSmithDoc, setToolSmithDoc] = useState<OntologyFile | null>(null);
  const [toolDraft, setToolDraft] = useState<string | null>(null);
  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);

  const draftTool = useCallback(async (intent: string) => {
    if (!toolSmithDoc) return;
    setToolBusy(true);
    setToolError(null);
    try {
      const r = await draftToolFromDoc(t, tenant, { text: toolSmithDoc.text, intent });
      if (!r.ok) { setToolError(r.message); return; }
      setToolDraft(JSON.stringify(r.data.draft, null, 2));
    } finally {
      setToolBusy(false);
    }
  }, [toolSmithDoc, t, tenant]);

  const saveTool = useCallback(async (draftJson: string) => {
    setToolBusy(true);
    setToolError(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(draftJson); } catch { setToolError("草稿不是合法 JSON"); return; }
      const r = await saveToolToLibrary(t, tenant, parsed);
      if (!r.ok) { setToolError(r.message); return; }
      if (r.data.runtimeActive || r.data.lifecycle !== "draft") {
        setToolError(
          "服务端返回了非草稿状态；OntoCode 已停止，避免把未经 probe/人工激活的工具误标为可执行。",
        );
        return;
      }
      const name = (parsed as { name?: string }).name ?? "";
      setToolSmithDoc(null);
      setToolDraft(null);
      setDeployMsg({
        text: `✓ 工具「${name}」的受控 revision 草稿已保存；它仍不可执行，需完成精确 probe 与人工激活。`,
        error: false,
      });
    } finally {
      setToolBusy(false);
    }
  }, [t, tenant]);

  // ── 新任务：离开当前会话，回到干净工作台。不停止后台 run（可从最近任务回来）。──
  const startNewTask = useCallback(() => {
    if (
      running &&
      !window.confirm("当前会话仍在运行——切到新任务不会停止它，随时可从「最近任务」回来。开始新任务？")
    ) {
      return;
    }
    localStorage.removeItem(activeRunKey(tenant));
    if (domainId) localStorage.removeItem(convKey(tenant, domainId));
    scopeAnalysisNonceRef.current += 1;
    setConversationId(null);
    setStreamReq(null); // useBrainStream 对 null 请求会清空 events/running/error
    setGoal("");
    setSelectedActionIds([]);
    setScopeRecommendation(null);
    setAnalyzingScope(false);
    setAtTokens([]);
    setDocuments([]);
    setStartError(null);
    setDeployMsg(null);
    setOpenCard(null);
    setSendingTodoId(null);
    setOverlayTodo(null);
    composerRef.current?.focus();
  }, [running, tenant, domainId]);

  // ── 系统覆盖（该域引用的外部系统 vs 已建档） ─────────────────────────────────
  // Scope coverage to this build. Generated slugs only become authoritative
  // once matching drafts exist; until then the selected Ontology Action IDs
  // are the safe server-resolved selector.
  const coverageScope = useMemo<{
    actionIds?: string[];
    agentSlugs?: string[];
  } | null>(() => {
    const draftSlugs = new Set(drafts.map((draft) => draft.slug));
    const generatedSlugs = agents
      .map((agent) => agent.slug)
      .filter((slug) => draftSlugs.has(slug));
    if (generatedSlugs.length > 0 && generatedSlugs.length === agents.length) {
      return { agentSlugs: generatedSlugs };
    }
    if (selectedActionIds.length > 0) return { actionIds: selectedActionIds };
    return null;
  }, [agents, drafts, selectedActionIds]);

  useEffect(() => {
    if (!tenant || !domainId || !coverageScope) { setCoverage(null); return; }
    let cancelled = false;
    void fetchSystemCoverage(t, tenant, domainId, coverageScope).then((r) => {
      if (!cancelled) setCoverage(r.ok ? r.data : null);
    });
    return () => { cancelled = true; };
  }, [tenant, domainId, t, profilesNonce, coverageScope]);

  // 从 Settings 配完凭证切回本页时，覆盖条必须立刻反映新状态——窗口重获焦点 /
  // 标签页重新可见即重取（幂等 GET，别让用户以为"配了没生效"还得手动刷新）。
  useEffect(() => {
    if (!tenant || !domainId || !coverageScope) return;
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetchSystemCoverage(t, tenant, domainId, coverageScope).then((r) => {
        if (r.ok) setCoverage(r.data);
      });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [tenant, domainId, t, coverageScope]);

  // NOTE: takes File[] (already copied out of the live FileList) — clearing the
  // <input> clears its FileList, so the caller must snapshot synchronously first.
  const onFilesPicked = useCallback(async (picked: File[]) => {
    if (!picked.length) return;
    const files: OntologyFile[] = [];
    for (const f of picked) files.push({ name: f.name, text: await f.text() });
    const ontologyFiles = files.filter((f) => classifyAttachment(f.name, f.text) === "ontology");
    const toolDocs = files.filter((f) => classifyAttachment(f.name, f.text) === "tooldoc");

    if (toolDocs.length) {
      setDocuments((prev) => {
        const seen = new Set(prev.map((d) => d.name));
        return [...prev, ...toolDocs.filter((d) => !seen.has(d.name))];
      });
    }
    if (ontologyFiles.length) {
      const built = buildOntologyBundle(ontologyFiles);
      const skipNote = built.skipped.length ? `（跳过非法 JSON：${built.skipped.join("、")}）` : "";
      if (!built.actionCount) {
        setDeployMsg({ text: `本体文件里没有可用的动作（actions）${skipNote}`, error: true });
        return;
      }
      setDomainBusy(true);
      try {
        const name = boundDomain?.name ?? boundDomain?.id
          ?? (stripExt(ontologyFiles[0]!.name) || `${tenant} 本体`);
        const result = await uploadOntologyBundle(t, tenant, {
          name,
          ontology: built.bundle,
          ...(domainId ? { domainId } : {}),
        });
        if (!result.ok) {
          setDeployMsg({ text: `本体上传失败：${result.message}${skipNote}`, error: true });
          return;
        }
        if (!result.data?.uploaded?.id) {
          setDeployMsg({ text: `服务端未确认本体入库${skipNote}`, error: true });
          return;
        }
        resetConversation();
        await queryClient.invalidateQueries({ queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant) });
        setDeployMsg({
          text: `✓ 本体已入库「${result.data.uploaded.name ?? name}」· ${built.actionCount} 动作 · ${built.ruleCount} 规则 · ${built.eventCount} 事件${skipNote}——已开启新会话`,
          error: false,
        });
      } finally {
        setDomainBusy(false);
      }
    } else if (toolDocs.length) {
      setDeployMsg({ text: `已附加 ${toolDocs.length} 份参考文档——将随下一次生成一起交给大脑`, error: false });
    }
  }, [t, tenant, domainId, boundDomain, resetConversation, queryClient]);

  // ── domain menu handlers（绑定 / 删上传域） ──────────────────────────────────
  const onBindDomain = useCallback(async (id: string) => {
    if (id === domainId) { setDomainMenuOpen(false); return; }
    const changing = Boolean(binding && binding.ontologyDomainId !== id);
    if (changing && !window.confirm(`切换业务域会开始新的会话（当前草稿与对话上下文保留在原域）。确认切换到「${id}」？`)) return;
    setDomainBusy(true);
    try {
      const result = await bindFactoryDomain(t, tenant, { ontologyDomainId: id, confirmRebind: changing });
      if (!result.ok) { setDeployMsg({ text: `绑定失败：${result.message}`, error: true }); return; }
      resetConversation();
      await queryClient.invalidateQueries({ queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant) });
      setDeployMsg({ text: `✓ 已绑定业务域「${id}」——已开启新会话`, error: false });
      setDomainMenuOpen(false);
    } finally {
      setDomainBusy(false);
    }
  }, [t, tenant, domainId, binding, resetConversation, queryClient]);

  const onDeleteUploadDomain = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`删除上传域「${name}」？其动作/规则将从可选域中移除。`)) return;
    setDomainBusy(true);
    try {
      const result = await deleteOntologyUpload(t, tenant, id);
      if (!result.ok || result.data.deleted !== true) {
        setDeployMsg({ text: `删除失败：${result.ok ? "服务端未确认" : result.message}`, error: true });
        return;
      }
      setUploadedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await queryClient.invalidateQueries({ queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant) });
      setDeployMsg({ text: `✓ 已删除上传域「${name}」`, error: false });
    } finally {
      setDomainBusy(false);
    }
  }, [t, tenant, queryClient]);

  // ── run 软删（回收站在高级模式，可恢复） ─────────────────────────────────────
  const onDeleteRun = useCallback(async (id: string) => {
    if (!window.confirm("删除这条运行记录？（软删除，可在高级模式回收站恢复）")) return;
    const result = await deleteFactoryRun(t, tenant, id);
    if (!result.ok || result.data.deleted !== true) {
      setDeployMsg({ text: `删除运行失败：${result.ok ? "服务端未确认" : result.message}`, error: true });
      return;
    }
    if (streamReq?.reconnectRunId === id) setStreamReq(null);
    setRunsNonce((n) => n + 1);
  }, [t, tenant, streamReq]);

  // ── actions ───────────────────────────────────────────────────────────────
  const analyzeScope = useCallback(async () => {
    if (domainState !== "ready") {
      setStartError(
        domainState === "error"
          ? "Ontology 域读取失败，请重新加载后再分析"
          : "请先加载或上传一个 Ontology 域",
      );
      return;
    }
    const scenario = goal.trim();
    if (!scenario) {
      setStartError("请先描述一个业务目标或场景");
      composerRef.current?.focus();
      return;
    }
    if (!domainId) {
      setStartError("尚未绑定 Ontology 域——点击顶部域标签选择或上传");
      return;
    }
    const analysisNonce = ++scopeAnalysisNonceRef.current;
    setAnalyzingScope(true);
    setStartError(null);
    const result = await recommendOntoCodeScope(t, tenant, {
      domain: domainId,
      scenario,
    });
    if (analysisNonce !== scopeAnalysisNonceRef.current) return;
    setAnalyzingScope(false);
    if (!result.ok) {
      setScopeRecommendation(null);
      setSelectedActionIds([]);
      setStartError(`Ontology 分析失败：${result.message}`);
      return;
    }

    const recommendedIds = matchBoundRecommendationActionIds({
      recommendedActionIds: result.data.actionIds,
      boundAgentActionIds: agentActions.map((action) => action.id),
    });
    if (!recommendedIds) {
      setScopeRecommendation(null);
      setSelectedActionIds([]);
      setStartError("AI 建议引用了当前绑定 Ontology 中不可用的 Action，请重新分析");
      return;
    }
    if (result.data.mode !== "virtual_scenario" && recommendedIds.length === 0) {
      setScopeRecommendation(null);
      setSelectedActionIds([]);
      setStartError("AI 没有返回当前 Ontology 中可生成的 Action，请补充场景后重新分析");
      return;
    }
    setScopeRecommendation(result.data);
    setSelectedActionIds(recommendedIds);
  }, [domainState, goal, domainId, t, tenant, agentActions]);

  const start = useCallback(async () => {
    if (domainState !== "ready") {
      setStartError(
        domainState === "error"
          ? "Ontology 域读取失败，请重新加载后再生成"
          : "请先加载或上传一个 Ontology 域",
      );
      return;
    }
    const userText = [...atTokens.map((token) => `@${token}`), goal.trim()]
      .filter(Boolean)
      .join(" ");
    const startMode = resolveOntoCodeStartMode({
      hasSuite: hasCurrentTask,
      hasConversation: Boolean(conversationId),
      selectedActionIds,
      sourceActionIds: sourceBoundActionIds,
    });
    if (startMode === "scope_changed") {
      setStartError("当前套件的 Action 范围已锁定；请先点「新任务」再选择新的 Actions");
      return;
    }
    if (startMode === "modify_existing" && !userText && documents.length === 0) {
      setStartError("请描述要修改的内容，或附加参考文档");
      return;
    }
    if (startMode === "new_scope" && !scopeRecommendation) {
      setStartError("请先让 AI 分析 Ontology 并确认建议范围");
      return;
    }
    const selectedActions = selectedActionIds.map((id) => {
      const action = agentActions.find((candidate) => candidate.id === id);
      return { id, name: action?.name ?? id };
    });
    if (
      startMode === "new_scope"
      && !selectedActions.length
      && scopeRecommendation?.mode !== "virtual_scenario"
    ) {
      setStartError("请至少保留一个建议 Action；若场景没有对应 Action，请重新分析");
      return;
    }
    if (!domainId) { setStartError("尚未绑定 Ontology 域——点击顶部域标签选择或上传"); return; }
    const recommendedScenario =
      scopeRecommendation?.scenario.trim() || goal.trim();
    const readableIntent = startMode === "modify_existing"
      ? userText
      : buildOntoCodeIntentGoal(selectedActions, recommendedScenario);
    const finalGoal = composeFactoryGoal(t, readableIntent, documents);
    setStarting(true);
    setStartError(null);
    const existingConversation =
      startMode === "modify_existing" ? conversationId : null;
    const hadConversation = Boolean(existingConversation);
    const result = await startFactoryRun(t, tenant, {
      domain: domainId,
      goal: finalGoal,
      ...(startMode === "new_scope" && selectedActionIds.length
        ? { actionIds: selectedActionIds }
        : {}),
      ...(startMode === "new_scope" && recommendedScenario
        ? { scenario: recommendedScenario }
        : {}),
      ...(startMode === "new_scope" && scopeRecommendation
        ? {
            recommendationId: scopeRecommendation.recommendationId,
            ontologyHash: scopeRecommendation.ontologyHash,
          }
        : {}),
      interactionPolicy: "autopilot",
      ...(existingConversation ? { conversation: existingConversation } : {}),
    });
    setStarting(false);
    if (!result.ok) {
      if (result.code === "scope_recommendation_stale") {
        setScopeRecommendation(null);
        setSelectedActionIds([]);
        setStartError("Ontology 已发生变化，请重新分析业务场景后再生成");
      } else {
        setStartError(result.message);
      }
      return;
    }
    const receipt = result.data;
    const conv = existingConversation ?? receipt.runId;
    setConversationId(conv);
    localStorage.setItem(convKey(tenant, domainId), conv);
    nonceRef.current += 1;
    setStreamReq({
      tenant,
      reconnectRunId: receipt.runId,
      conversation: conv,
      replayMode: replayModeForStart(receipt, hadConversation),
      nonce: nonceRef.current,
    });
    setGoal("");
    setScopeRecommendation(null);
    setAtTokens([]);
    setDocuments([]);
  }, [
    goal,
    atTokens,
    selectedActionIds,
    agentActions,
    hasCurrentTask,
    sourceBoundActionIds,
    scopeRecommendation,
    documents,
    domainState,
    domainId,
    conversationId,
    t,
    tenant,
  ]);

  const submitComposer = useCallback(() => {
    if (domainState !== "ready") {
      setStartError(
        domainState === "error"
          ? "Ontology 域读取失败，请重新加载后再继续"
          : "请先加载或上传一个 Ontology 域",
      );
      return;
    }
    if (
      resolveOntoCodeComposerSubmit({
        hasCurrentTask,
        hasRecommendation: Boolean(scopeRecommendation),
      }) === "start_run"
    ) {
      void start();
      return;
    }
    void analyzeScope();
  }, [domainState, hasCurrentTask, scopeRecommendation, start, analyzeScope]);

  const attachRun = useCallback((runId: string) => {
    nonceRef.current += 1;
    scopeAnalysisNonceRef.current += 1;
    setAnalyzingScope(false);
    setScopeRecommendation(null);
    setSelectedActionIds([]);
    setStartError(null);
    setConversationId(runId);
    if (domainId) localStorage.setItem(convKey(tenant, domainId), runId);
    setStreamReq({ tenant, reconnectRunId: runId, conversation: runId, replayMode: "replace", nonce: nonceRef.current });
  }, [tenant, domainId]);

  const submitGate = useCallback(async (todo: TodoItem, kindText: string) => {
    const conversation = streamReq?.conversation ?? conversationId;
    if (!conversation || !todo.interactionId) { setStartError("缺少会话或交互标识，无法提交"); return; }
    setSendingTodoId(todo.id);
    setOverlayTodo(null);
    const result = await injectGateAnswer(t, tenant, {
      conversation,
      interactionId: todo.interactionId,
      kind: todo.kind,
      text: kindText,
    });
    if (!result.ok) { setSendingTodoId(null); setStartError(result.message); }
  }, [streamReq, conversationId, t, tenant]);

  const jumpInteraction = useCallback((interactionId: string) => {
    const todo = todos.find((td) => td.interactionId === interactionId);
    if (todo) setOverlayTodo(todo);
  }, [todos]);

  const statusChipFor = () => {
    if (running) return { label: "生成中…", tone: "dim" as const };
    if (evidence === "real") return { label: "已验证 ✓", tone: "ok" as const };
    if (hasAwait) return { label: "待决定", tone: "warn" as const };
    return { label: "草稿", tone: "dim" as const };
  };

  return (
    <div className="oc">
      {/* ── top bar ── */}
      <div className="oc-top">
        <span className="oc-logo">Onto<em>Code</em></span>
        <span className="oc-domainwrap">
          <button
            type="button"
            className="oc-pill"
            style={{ cursor: domainState === "loading" || domainState === "error" ? "not-allowed" : "pointer" }}
            disabled={domainState === "loading" || domainState === "error"}
            onClick={() => setDomainMenuOpen((v) => !v)}
            title="切换业务域 / 上传 Ontology JSON"
          >
            ⬡ {domainState === "error"
              ? "Ontology 域不可用"
              : domainState === "loading"
                ? "正在读取 Ontology…"
                : domainState === "empty"
                  ? "暂无 Ontology 域"
                  : domainLabel || "未绑定域"} ▾
          </button>
          {domainMenuOpen && (
            <OcDomainMenu
              domains={domainsQuery.data?.domains ?? []}
              boundId={domainId || null}
              uploadedIds={uploadedIds}
              busy={domainBusy}
              onBind={(id) => void onBindDomain(id)}
              onDeleteUpload={(id, name) => void onDeleteUploadDomain(id, name)}
              onUpload={() => { setDomainMenuOpen(false); fileInputRef.current?.click(); }}
              onClose={() => setDomainMenuOpen(false)}
            />
          )}
        </span>
        {boundDomain?.counts?.actions != null && (
          <span className="oc-pill">{boundDomain.counts.actions} 动作 · {boundDomain.counts.rules ?? 0} 规则</span>
        )}
        <span className="oc-sp" />
        {evidence === "real" && <span className="oc-pill ok">✓ 沙箱证据</span>}
        {promotable.ok ? (
          <button
            type="button"
            className="oc-pill ok"
            style={{ cursor: "pointer", fontWeight: 700 }}
            disabled={deployBusy}
            onClick={() => void startDeploy()}
          >
            {deployBusy ? "准备审查…" : `部署 ${promotable.slugs.length} 个草稿 →`}
          </button>
        ) : (
          <span className="oc-pill" title={promotable.reason}>
            部署 · 未就绪
          </span>
        )}
      </div>

      <div className={`oc-layout${railCollapsed ? " rail-collapsed" : ""}`}>
        {/* ── left rail ── */}
        <nav className="oc-left">
          <button type="button" className="oc-newtask" onClick={startNewTask}>
            ＋ 新任务
          </button>
          <button type="button" className="oc-navitem on">✦ 工作台</button>
          <button
            type="button"
            className="oc-navitem"
            disabled={domainState === "loading" || domainState === "error"}
            onClick={() => { setDomainMenuOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            ⬡ Ontology 域{" "}
            <span className="oc-cnt">
              {domainState === "error" ? "!" : domainsQuery.data?.domains.length ?? "…"}
            </span>
          </button>
          <button type="button" className="oc-navitem" onClick={() => setProfilesOpen(true)}>
            ⛁ 外部系统 <span className="oc-cnt">{profilesOpen ? profiles.length : "档案"}</span>
          </button>
          <div className="oc-recent oc-navlabel">
            <h4>草稿 · 待部署</h4>
            {drafts.length === 0 && <div className="oc-empty">暂无草稿</div>}
            {drafts.slice(0, 8).map((d) => {
              const chip = draftChip(d);
              return (
                <div className="oc-runrow" key={`${d.slug}:${d.versionId ?? ""}`} title={chip.blockers.join("；")}>
                  <span className={`st ${chip.tone === "ok" ? "st-live" : chip.tone === "warn" ? "st-draft" : "st-fail"}`} style={chip.tone === "dim" ? { background: "var(--oc-panel-2)", color: "var(--oc-text-3)" } : undefined}>
                    {chip.label}
                  </span>
                  {d.spec.nameZh || d.spec.actionName || d.slug}
                  <span className="meta">{d.slug}</span>
                </div>
              );
            })}
          </div>
          <div className="oc-recent oc-navlabel">
            <h4>最近任务</h4>
            {runs.length === 0 && <div className="oc-empty">暂无历史</div>}
            {runs.map((r) => (
              <div className="oc-runitem" key={r.id}>
                <button
                  type="button"
                  className={`oc-runrow${streamReq?.reconnectRunId === r.id ? " on" : ""}`}
                  onClick={() => attachRun(r.id)}
                >
                  <span className={`st ${r.status === "finished" || r.status === "done" ? "st-live" : r.status === "failed" ? "st-fail" : "st-draft"}`}>
                    {r.agentsCount} agents
                  </span>
                  {r.goal.slice(0, 26) || r.id}
                  <span className="meta">{timeAgo(r.createdAt, Date.now())}</span>
                </button>
                <button
                  type="button"
                  className="oc-rundel"
                  title="删除（软删除，可在高级模式回收站恢复）"
                  onClick={() => void onDeleteRun(r.id)}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
          <div className="oc-leftfoot">
            <Link href={`/portal/${tenant}/factory`}>高级模式 →</Link>
          </div>
        </nav>

        {/* ── center ── */}
        <main className="oc-main">
          {domainState === "error" && (
            <div className="oc-domain-state error" role="alert">
              <span>
                <b>Ontology 域读取失败</b>
              </span>
              <button
                type="button"
                disabled={domainsQuery.isFetching}
                onClick={() => void domainsQuery.refetch()}
              >
                {domainsQuery.isFetching ? "重试中…" : "重新加载"}
              </button>
            </div>
          )}
          {domainState === "empty" && (
            <div className="oc-domain-state empty" role="status">
              <span>
                <b>暂无 Ontology 域</b>
              </span>
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                上传 Ontology
              </button>
            </div>
          )}
          {showHero && (
            <div className="oc-hero">
              <div className="oc-hero-heading">
                <h2>你想让 <em>Agent</em> 完成什么业务目标？</h2>
                <HelpTip>
                  先描述场景；AI 会理解当前 Ontology，建议最小 Action
                  范围，再生成代码并在沙箱跑通
                </HelpTip>
              </div>
            </div>
          )}

          <div className="oc-composer">
            <div className="oc-scenario-heading">
              <label className="oc-scenario-label" htmlFor="oc-scenario">
                <span>{hasCurrentTask ? "继续修改当前 Agent 套件" : "描述业务目标或场景"}</span>
              </label>
              {!hasCurrentTask && !scopeRecommendation && (
                <HelpTip>
                  没有对应 Action 也可以：AI 会建议一个不回写 Ontology
                  的场景型 Agent。
                </HelpTip>
              )}
              {/* 常驻 helper 段降级为 HelpTip。 */}
              {(hasCurrentTask || scopeRecommendation) && (
                <HelpTip>
                  {hasCurrentTask
                    ? "修改会复用当前套件的 Ontology 范围，只重生成受影响的 Agent；更换范围请开始新任务。"
                    : "已完成 Ontology 分析。接受建议或展开微调，然后直接生成并跑通。"}
                </HelpTip>
              )}
              <small>{hasCurrentTask ? "复用已锁定范围" : "必填"}</small>
            </div>
            <textarea
              id="oc-scenario"
              ref={composerRef}
              value={goal}
              onChange={(e) => {
                setGoal(e.target.value);
                if (!hasCurrentTask) {
                  scopeAnalysisNonceRef.current += 1;
                  setAnalyzingScope(false);
                  setStartError(null);
                  if (scopeRecommendation) {
                    setScopeRecommendation(null);
                    setSelectedActionIds([]);
                  }
                }
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitComposer();
                }
                if (e.key === "@") setAtOpen(true);
              }}
              placeholder={
                hasCurrentTask
                  ? "继续描述修改，或输入 @ 引用某个 agent（如 @jd-matcher 分数线改成 75）…"
                  : "例如：当客户风险升高时，汇总订单与回款信息，通知客户经理并创建跟进任务…"
              }
            />

            {!hasCurrentTask && scopeRecommendation && (
              <section className="oc-scope-recommendation" aria-live="polite">
                <header>
                  <span className="oc-ai-label">✦ AI 建议范围</span>
                  <small>基于 {domainLabel || "当前 Ontology"}</small>
                </header>
                {scopeRecommendation.reasoningSummary && (
                  <p>{scopeRecommendation.reasoningSummary}</p>
                )}

                {scopeRecommendation.mode === "virtual_scenario" ? (
                  <div className="oc-virtual-scope">
                    <span className="mark" aria-hidden="true">
                      {selectedActionIds.length > 0 ? "✓" : "✦"}
                    </span>
                    {selectedActionIds.length > 0 ? (
                      <>
                        <span>
                          <b>已改用 {selectedActionIds.length} 个已有 Action</b>
                          <small>将按你微调后的 Ontology 范围生成</small>
                        </span>
                        <em>已微调</em>
                      </>
                    ) : (
                      <>
                        <span>
                          <b>{scopeRecommendation.virtualAction?.name || "场景型 Agent"}</b>
                          <small>
                            {scopeRecommendation.virtualAction?.reason
                              || "当前 Ontology 没有直接对应 Action，将按场景生成"}
                          </small>
                        </span>
                        <em>不回写 Ontology</em>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="oc-recommended-actions">
                    {scopeRecommendation.actions.map((action) => {
                      const selected = selectedActionIds.includes(action.id);
                      return (
                        <div
                          className={`oc-recommended-action${selected ? "" : " removed"}`}
                          key={action.id}
                        >
                          <span className="mark" aria-hidden="true">{selected ? "✓" : "–"}</span>
                          <span>
                            <b>{action.name || action.id}</b>
                            <small>{action.reason}</small>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {scopeRecommendation.unresolved?.length ? (
                  <div className="oc-scope-note">
                    AI 识别到的待确认事项：{scopeRecommendation.unresolved.join("；")}
                  </div>
                ) : null}
                {scopeRecommendation.confidence < 0.7 && (
                  <div className="oc-scope-note">
                    当前建议把握较低，请补充场景描述或检查 Action 范围。
                  </div>
                )}

                {agentActions.length > 0 && (
                  <details className="oc-scope-adjust">
                    <summary>
                      {scopeRecommendation.mode === "virtual_scenario"
                        && selectedActionIds.length === 0
                        ? "改用已有 Action"
                        : `微调范围 · 当前 ${selectedActionIds.length} 个 Action`}
                    </summary>
                    {hiddenNonAgentActionCount > 0 ? (
                      <p>{hiddenNonAgentActionCount} 项已隐藏</p>
                    ) : null}
                    <div className="oc-action-grid">
                      {agentActions.map((action) => {
                        const checked = selectedActionIds.includes(action.id);
                        return (
                          <label
                            className={`oc-action-option${checked ? " on" : ""}`}
                            key={action.id}
                            title={action.description ?? action.id}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelectedActionIds((current) =>
                                  current.includes(action.id)
                                    ? current.filter((id) => id !== action.id)
                                    : [...current, action.id],
                                )
                              }
                            />
                            <span className="check" aria-hidden="true">{checked ? "✓" : ""}</span>
                            <span className="action-copy">
                              <b>{action.name || action.id}</b>
                              <small>{action.id}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                )}
              </section>
            )}

            <div className="oc-comprow">
              {atOpen && (
                <div className="oc-atmenu">
                  {agents.length === 0 && <div className="oc-empty">生成后可 @ 引用 agent</div>}
                  {agents.map((a) => (
                    <button
                      key={a.slug}
                      type="button"
                      onClick={() => { setAtTokens((prev) => [...new Set([...prev, a.slug])]); setAtOpen(false); }}
                    >
                      <span className="k">@{a.slug}</span> {a.nameZh || a.actionName}
                      <span className="d">agent</span>
                    </button>
                  ))}
                  {runs.filter((r) => r.status === "failed").slice(0, 3).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => { setAtTokens((prev) => [...new Set([...prev, r.id])]); setAtOpen(false); }}
                    >
                      <span className="k">@{r.id.slice(0, 12)}…</span> 失败 run
                      <span className="d">debug</span>
                    </button>
                  ))}
                  <button type="button" onClick={() => setAtOpen(false)}><span className="d">关闭</span></button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".json,.md,.txt,.yaml,.yml,.csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const picked = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = "";
                  void onFilesPicked(picked);
                }}
              />
              <span className="oc-chip src">
                ⬡ {domainState === "error"
                  ? "Ontology 不可用"
                  : domainState === "loading"
                    ? "读取中"
                    : domainState === "empty"
                      ? "暂无 Ontology"
                      : domainLabel}
              </span>
              <button
                type="button"
                className="oc-chip"
                onClick={() => fileInputRef.current?.click()}
                title="上传 Ontology JSON（建域/并域）或参考文档（随生成附带）"
              >
                📎 附件
              </button>
              {documents.map((d) => (
                <span className="oc-chip doc" key={d.name} title={`参考文档 · ${d.text.length} 字符 · 将随下一次生成交给大脑`}>
                  ◫ {d.name}
                  <button
                    type="button"
                    className="oc-chip-action"
                    aria-label={`从 ${d.name} 提炼工具`}
                    title="从这份文档提炼一个声明式工具并入库"
                    style={{ color: "var(--oc-purple)" }}
                    onClick={() => { setToolSmithDoc(d); setToolDraft(null); setToolError(null); }}
                  >
                    ⚒
                  </button>
                  <button
                    type="button"
                    className="oc-chip-action"
                    aria-label={`移除附件 ${d.name}`}
                    onClick={() => setDocuments((prev) => prev.filter((item) => item.name !== d.name))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {atTokens.map((tk) => (
                <span className="oc-chip at" key={tk}>
                  @{tk}
                  <button
                    type="button"
                    className="oc-chip-action"
                    aria-label={`移除引用 ${tk}`}
                    onClick={() => setAtTokens((prev) => prev.filter((token) => token !== tk))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {suiteReady && (
                <button type="button" className="oc-chip" onClick={() => setAtOpen((v) => !v)} title="引用 agent / 失败 run">
                  ＠ 引用
                </button>
              )}
              <button
                type="button"
                className="oc-generate"
                disabled={
                  starting
                  || analyzingScope
                  || running
                  || domainBuildBlocked
                  || (!hasCurrentTask && !scopeRecommendation && !goal.trim())
                  || (
                    scopeRecommendation?.mode !== "virtual_scenario"
                    && Boolean(scopeRecommendation)
                    && selectedActionIds.length === 0
                  )
                }
                onClick={submitComposer}
                title={
                  running
                    ? "生成进行中"
                    : domainState === "error"
                      ? "Ontology 域读取失败，请重新加载"
                      : domainState !== "ready"
                        ? "请先加载或上传 Ontology"
                        : !hasCurrentTask && !scopeRecommendation
                          ? "让 AI 分析当前 Ontology 并建议最小范围"
                          : undefined
                }
              >
                {analyzingScope
                  ? "分析中…"
                  : starting
                    ? "启动中…"
                    : running
                      ? "生成中…"
                      : hasCurrentTask
                        ? "应用"
                        : scopeRecommendation
                          ? "生成"
                          : "推荐范围"}{" "}
                <span className="kbd">⌘↵</span>
              </button>
            </div>
          </div>

          {coverage && coverage.totals.referenced > 0 && (
            coverage.totals.unprofiled > 0 ? (
              <div
                className="oc-exec"
                style={{ borderColor: "var(--oc-amber)", color: "var(--oc-text-2)", background: "var(--oc-amber-dim)" }}
              >
                <span style={{ color: "var(--oc-amber)", fontWeight: 700 }}>⚠ 外部系统</span>
                <span>
                  {(() => {
                    // 运行时提供的系统（LLM 网关 / 内部调用）无需建档——从分母和
                    // 名单里都排除，否则横幅把 AO_Internal/LLM_Gateway 报成欠账。
                    const runtime = coverage.systems.filter((s) => s.runtimeProvided).length;
                    const needProfile = coverage.totals.referenced - runtime;
                    const planned = coverage.systems.filter((s) => s.availability === "planned").length;
                    const unprofiledNames = coverage.systems
                      .filter((s) => !s.profileId && !s.runtimeProvided)
                      .map((s) => s.system)
                      .join("、");
                    return (
                      <>
                        {coverage.totals.profiled}/{needProfile} 已建档
                        {runtime > 0 ? ` · ${runtime} 运行时提供 ✓` : ""}
                        {coverage.totals.humanBoundary > 0 ? ` · ${coverage.totals.humanBoundary} 人工边界` : ""}
                        {planned > 0 ? ` · ${planned} 规划中` : ""}
                        {" · 待建档："}
                        {unprofiledNames}
                      </>
                    );
                  })()}
                </span>
                <span className="oc-sp" />
                <button
                  type="button"
                  className="oc-act"
                  style={{ borderColor: "var(--oc-amber)", color: "var(--oc-amber)" }}
                  onClick={() => setWorkbenchOpen(true)}
                >
                  逐个连接 →
                </button>
              </div>
            ) : (
              <div className="oc-exec" style={{ borderColor: "var(--oc-green)", color: "var(--oc-green)" }}>
                ✓ 外部系统 {coverage.totals.referenced} 全部就绪
              </div>
            )
          )}
          {startError && <div className="oc-exec error">✕ {startError}</div>}
          {deployMsg && (
            <div className={`oc-exec${deployMsg.error ? " error" : ""}`} style={deployMsg.error ? undefined : { borderColor: "var(--oc-green)", color: "var(--oc-green)" }}>
              {deployMsg.text}
            </div>
          )}
          {streamError && <div className="oc-exec error">✕ 流连接异常（{streamError}）— 可在最近任务中重新打开</div>}
          <OcExecLine exec={exec} tokens={tokensUsed} onOpenRail={() => { setRailCollapsed(false); setRailTab("build"); }} />

          {suiteReady && (
            <div className="oc-suitehead">
              <b>{agents.length} Agents</b>
              <span className={`oc-badge ${evidence === "real" ? "ok" : evidence === "simulated_only" ? "bad" : "dim"}`}>
                {evidence === "real" ? "✓ 沙箱真跑证据" : evidence === "simulated_only" ? "仅模拟证据" : "未验证"}
              </span>
              <span className="oc-sp" />
              <OcNextSteps steps={nextSteps} />
            </div>
          )}

          {suiteReady && (
            <OcFlowStrip
              graph={graph}
              highlight={openCard}
              onNode={(slug) => {
                setOpenCard(slug);
                document.getElementById(`oc-agent-${slug}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          )}

          {suiteReady && (
            <div className="oc-grid">
              {agents.map((a) => (
                <OcAgentCard
                  key={a.slug}
                  agent={a}
                  open={openCard === a.slug}
                  onToggle={() => setOpenCard((cur) => (cur === a.slug ? null : a.slug))}
                  statusChip={statusChipFor()}
                  sandboxEvidence={evidence}
                />
              ))}
            </div>
          )}

          <OcTodoQueue
            todos={todos}
            sendingId={sendingTodoId}
            onHandle={(todo) => setOverlayTodo(todo)}
            onQuickAnswer={(todo, label) => void submitGate(todo, clarifyAnswerText(label))}
            onOpenIntegrations={openIntegrations}
            onOpenWorkbench={() => setWorkbenchOpen(true)}
          />
          <OcResolvedStrip items={resolvedGates} />
        </main>

        {/* ── right rail ── */}
        {!railCollapsed && (
          <button
            type="button"
            className="oc-rail-mobile-scrim"
            aria-label="关闭构建与诊断"
            onClick={() => setRailCollapsed(true)}
          />
        )}
        <OcSessionRail
          steps={brainSteps}
          context={buildContext}
          logLines={logLines}
          tab={railTab}
          onTab={setRailTab}
          collapsed={railCollapsed}
          onToggleCollapse={() => setRailCollapsed((v) => !v)}
          hasAwait={hasAwait}
          onJumpInteraction={jumpInteraction}
          onExport={events.length === 0 ? null : () => {
            const payload = {
              product: "OntoCode",
              tenant,
              domain: domainId,
              conversation: streamReq?.conversation ?? conversationId,
              runId: streamReq?.reconnectRunId ?? null,
              exportedAt: new Date().toISOString(),
              events,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `ontocode-session-${streamReq?.reconnectRunId ?? "current"}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        />
      </div>

      {toolSmithDoc && (
        <OcToolSmithOverlay
          docName={toolSmithDoc.name}
          busy={toolBusy}
          error={toolError}
          draft={toolDraft}
          onDraftChange={setToolDraft}
          onDraft={(intent) => void draftTool(intent)}
          onSave={(json) => void saveTool(json)}
          onClose={() => { setToolSmithDoc(null); setToolDraft(null); setToolError(null); }}
        />
      )}

      {profilesOpen && (
        <OcSystemProfilesPanel
          profiles={profiles}
          busy={profileBusy}
          error={profileError}
          onClose={() => { setProfilesOpen(false); setProfileDraft(null); setProfileError(null); }}
          onDraft={(input) => void draftProfile(input)}
          onSave={(json) => void saveProfile(json)}
          onDelete={(id, name) => void deleteProfile(id, name)}
          draft={profileDraft}
          onDraftChange={setProfileDraft}
        />
      )}

      {workbenchOpen && coverage && (
        <OcSystemWorkbench
          t={t}
          tenant={tenant}
          coverage={coverage}
          onClose={() => setWorkbenchOpen(false)}
          onChanged={() => setProfilesNonce((n) => n + 1)}
          onOpenIntegrations={openIntegrations}
        />
      )}

      {promotionReview && (
        <PromotionReviewModal
          preview={promotionReview.preview}
          codeArtifacts={promotionReview.codeArtifacts}
          onClose={() => setPromotionReview(null)}
          onApprove={approveDeploy}
        />
      )}

      {overlayTodo && (
        <OcConfigOverlay
          todo={overlayTodo}
          busy={sendingTodoId === overlayTodo.id}
          impact={
            overlayTodo.kind === "boundary"
              ? [...new Set((overlayTodo.proposals ?? []).flatMap((p) => p.producers))]
              : agents.slice(0, 3).map((a) => a.slug)
          }
          onClose={() => setOverlayTodo(null)}
          onClarify={(answer) => void submitGate(overlayTodo, clarifyAnswerText(answer))}
          onTest={(decision, note) => void submitGate(overlayTodo, testDecisionText(decision, note))}
          onBoundary={(evs) => void submitGate(overlayTodo, boundaryDecisionText(evs))}
        />
      )}
    </div>
  );
}
