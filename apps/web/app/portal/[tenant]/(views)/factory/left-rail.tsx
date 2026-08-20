"use client";

/**
 * Agent 工厂 — the LEFT RAIL. Collapsible ontology binding/catalog,
 * 历史运行 with per-row soft-delete + restore + 清空已完成 + status filter (was view-only), the
 * 已生成·草稿 promote flow, and a PINNED 运行健康 strip (the old 验证 tab, promoted to always-on
 * so you never tab-hunt to see if the run is green). The whole rail hides via the page's toggle.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Icon, StatusDot, SearchInput, FilterChip } from "@/app/portal/components";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import { EvalLine } from "./atoms";
import { factoryRunDisplayStatus, type DomainRow, type RunRow, type DraftRow } from "./model";

const SECTION_LABEL: React.CSSProperties = { fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em" };

export function CollapsibleSection({ title, badge, storageKey, defaultOpen = true, children }: { title: ReactNode; badge?: ReactNode; storageKey: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { try { const v = localStorage.getItem(storageKey); if (v != null) setOpen(v === "1"); } catch { /* ignore */ } }, [storageKey]);
  const toggle = () => setOpen((o) => { const n = !o; try { localStorage.setItem(storageKey, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  return (
    <div>
      <button onClick={toggle} style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", padding: "2px 0", marginBottom: 6, background: "none", border: "none", cursor: "pointer", ...SECTION_LABEL }}>
        <span style={{ display: "inline-flex", transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}><Icon name="chevron-down" size={12} /></span>
        <span>{title}</span>
        {badge != null && <span style={{ marginLeft: "auto" }}>{badge}</span>}
      </button>
      {open && children}
    </div>
  );
}

export function DomainList({ domains, domain, query, setQuery, onSelect, actionLabel, uploadedIds, onDeleteUpload }: { domains: DomainRow[]; domain: string; query: string; setQuery: (v: string) => void; onSelect?: (id: string) => void; actionLabel?: string; uploadedIds?: Set<string>; onDeleteUpload?: (id: string, name: string) => void }) {
  const { t } = useI18n();
  const q = query.trim().toLowerCase();
  const shown = q ? domains.filter((d) => (d.name ?? d.id).toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) : domains;
  return (
    <div>
      {domains.length > 1 && <div style={{ marginBottom: 6 }}><SearchInput value={query} onChange={setQuery} placeholder={t("factory.leftRail.domain.searchPlaceholder")} ariaLabel={t("factory.leftRail.domain.searchAriaLabel")} /></div>}
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)", padding: "4px 2px" }}>{t("factory.leftRail.domain.noMatch")}</div>}
      {shown.map((d) => {
        const active = d.id === domain;
        // Tenant uploads can be deleted in place; built-in/live ontology rows cannot.
        const deletable = Boolean(uploadedIds?.has(d.id) && onDeleteUpload);
        return (
          <div key={d.id} style={{ display: "flex", alignItems: "stretch", gap: 2, marginBottom: 3 }}>
            <button className="factory-cta" onClick={() => onSelect?.(d.id)} disabled={!onSelect} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "1px solid " + (active ? "var(--signal)" : "transparent"), background: active ? "var(--panel-2)" : "transparent", color: "var(--text)", cursor: onSelect ? "pointer" : "default", fontSize: 12.5 }}>
              <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: active ? "var(--signal)" : "transparent", flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name ?? d.id}</span>
                {d.counts ? <span style={{ display: "block", fontSize: 10, color: "var(--text-3)", marginTop: 1 }}>{t("factory.leftRail.domain.counts", { actions: d.counts.actions, events: d.counts.events })}</span> : null}
              </span>
              {actionLabel && <span style={{ flexShrink: 0, color: active ? "var(--green)" : "var(--signal)", fontSize: 10.5 }}>{active ? t("factory.leftRail.domain.connected") : actionLabel}</span>}
            </button>
            {deletable && (
              <button onClick={() => onDeleteUpload!(d.id, d.name ?? d.id)} title={t("factory.leftRail.domain.deleteUploadTitle")} aria-label={t("factory.leftRail.domain.deleteUploadAriaLabel", { name: d.name ?? d.id })} className="factory-cta" style={{ flexShrink: 0, background: "none", border: "1px solid transparent", borderRadius: 8, color: "var(--text-4)", cursor: "pointer", fontSize: 12, padding: "0 6px" }}>🗑</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

const STATUS_FILTERS: Array<{ key: string; match: (s: string) => boolean }> = [
  { key: "all", match: () => true },
  { key: "done", match: (s) => s === "finished" || s === "done" || s === "answer_completed" },
  { key: "waiting", match: (s) => s === "waiting_human" },
  { key: "failed", match: (s) => /error|failed|aborted|incomplete|exhausted|invalid|unverified|legacy_unknown/.test(s) },
  { key: "running", match: (s) => s === "running" },
];

const statusColor = (s: string) => (s === "finished" || s === "done" || s === "answer_completed" ? "var(--green)" : /error|failed|aborted|invalid/.test(s) ? "var(--red)" : s === "running" ? "var(--signal)" : "var(--amber)");
const statusDotKind = (s: string): "ok" | "failed" | "running" | "idle" => (s === "finished" || s === "done" || s === "answer_completed" ? "ok" : /error|failed|aborted|invalid/.test(s) ? "failed" : s === "running" ? "running" : "idle");
// Human-readable status (was the raw "finished"/"error"/"exhausted" dev string in mono).
const humanStatus = (t: Translate, s: string): string => (s === "answer_completed" ? t("factory.leftRail.runStatus.answerCompleted") : s === "finished" || s === "done" ? t("factory.leftRail.runStatus.finished") : s === "waiting_human" ? t("factory.leftRail.runStatus.waitingHuman") : s === "failed_real_execution" ? t("factory.leftRail.runStatus.failedRealExecution") : s === "invalid_evidence" ? t("factory.leftRail.runStatus.invalidEvidence") : s === "unverified_evidence" ? t("factory.leftRail.runStatus.unverifiedEvidence") : s === "legacy_unknown" ? t("factory.leftRail.runStatus.legacyUnknown") : /error|aborted/.test(s) ? t("factory.leftRail.runStatus.failed") : s === "running" ? t("factory.leftRail.runStatus.running") : /incomplete|exhausted/.test(s) ? t("factory.leftRail.runStatus.incomplete") : s);
// Compact relative time so a run reads "3 分钟前", not a raw ISO / nothing.
const relTime = (t: Translate, iso: string, locale: string): string => {
  const timestamp = new Date(iso).getTime();
  if (!timestamp || Number.isNaN(timestamp)) return "";
  const s = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (s < 60) return t("factory.leftRail.relTime.justNow");
  if (s < 3600) return t("factory.leftRail.relTime.minutesAgo", { count: Math.floor(s / 60) });
  if (s < 86400) return t("factory.leftRail.relTime.hoursAgo", { count: Math.floor(s / 3600) });
  if (s < 604800) return t("factory.leftRail.relTime.daysAgo", { count: Math.floor(s / 86400) });
  return new Date(timestamp).toLocaleDateString(locale, { month: "numeric", day: "numeric" });
};

export function shouldShowHistoryAgentCount(goal: string | null | undefined): boolean {
  return Boolean(goal?.trim());
}

export function HistoryList({ runs, viewingRunId, onOpen, onDelete, onClear, deletedRuns = [], showTrash = false, onToggleTrash, onRestore }: { runs: RunRow[]; viewingRunId: string | null; onOpen: (id: string) => void; onDelete: (id: string) => void; onClear: () => void; deletedRuns?: RunRow[]; showTrash?: boolean; onToggleTrash?: () => void; onRestore?: (id: string) => void }) {
  const { language, t } = useI18n();
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const [filter, setFilter] = useState("all");
  const f = STATUS_FILTERS.find((x) => x.key === filter)!;
  const shown = runs.filter((r) => f.match(factoryRunDisplayStatus(r)));
  return (
    <div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
        {STATUS_FILTERS.map((s) => <FilterChip key={s.key} active={filter === s.key} onClick={() => setFilter(s.key)}>{t(`factory.leftRail.statusFilter.${s.key}`)}</FilterChip>)}
      </div>
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)" }}>{runs.length ? t("factory.leftRail.history.noMatch") : t("factory.leftRail.history.empty")}</div>}
      {shown.map((r) => {
        const title = r.goal?.trim() || t("factory.leftRail.history.runOfAgents", { count: r.agentsCount });
        const active = viewingRunId === r.id;
        const displayStatus = factoryRunDisplayStatus(r);
        return (
          <div key={r.id} className="hover-row" style={{ display: "flex", gap: 6, alignItems: "center", padding: "7px 9px", marginBottom: 2, borderRadius: 7, border: "1px solid " + (active ? "var(--signal)" : "transparent"), background: active ? "var(--panel-2)" : "transparent" }}>
            <button onClick={() => onOpen(r.id)} style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                <StatusDot status={statusDotKind(displayStatus)} size={6} />
                <span style={{ minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
              </span>
              <span style={{ fontSize: 10, color: "var(--text-3)", paddingLeft: 12 }}>
                <span style={{ color: statusColor(displayStatus) }}>{humanStatus(t, displayStatus)}</span>
                {r.createdAt && relTime(t, r.createdAt, locale) ? ` · ${relTime(t, r.createdAt, locale)}` : ""}
                {r.agentsCount && shouldShowHistoryAgentCount(r.goal)
                  ? ` · ${t("factory.leftRail.history.agentCount", { count: r.agentsCount })}`
                  : ""}
              </span>
            </button>
            {r.status !== "running" && (
              <button title={t("factory.leftRail.history.deleteRunTitle")} onClick={(e) => { e.stopPropagation(); onDelete(r.id); }} style={{ flexShrink: 0, display: "inline-flex", padding: 4, borderRadius: 5, background: "none", border: "none", cursor: "pointer", color: "var(--text-4)" }}>
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 12, marginTop: 4, alignItems: "center" }}>
        {shown.some((r) => r.status !== "running" && r.status !== "waiting_human") && (
          <button onClick={onClear} style={{ fontSize: 11, color: "var(--text-3)", background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="trash" size={11} /> {t("factory.leftRail.history.clearCompleted")}
          </button>
        )}
        {onToggleTrash && (
          <button onClick={onToggleTrash} style={{ fontSize: 11, color: showTrash ? "var(--signal)" : "var(--text-3)", background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="trash" size={11} /> {t("factory.leftRail.history.recycleBin")}{showTrash ? " ▾" : " ▸"}{deletedRuns.length ? ` (${deletedRuns.length})` : ""}
          </button>
        )}
      </div>
      {/* #5: recycle bin — list soft-deleted runs with a restore action. */}
      {showTrash && (
        <div style={{ marginTop: 6, borderTop: "1px dashed var(--border)", paddingTop: 6 }}>
          {deletedRuns.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)" }}>{t("factory.leftRail.history.recycleBinEmpty")}</div>}
          {deletedRuns.map((r) => (
            <div key={r.id} className="hover-row" style={{ display: "flex", gap: 7, alignItems: "center", padding: "6px 8px", marginBottom: 2, borderRadius: 6, opacity: 0.8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.goal?.trim() || t("factory.leftRail.history.runOfAgents", { count: r.agentsCount })}</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--text-4)" }}>{humanStatus(t, factoryRunDisplayStatus(r))} · {t("factory.leftRail.history.deleted")}{r.createdAt && relTime(t, r.createdAt, locale) ? ` · ${relTime(t, r.createdAt, locale)}` : ""}</span>
              </span>
              <button title={t("factory.leftRail.history.restoreTitle")} onClick={(e) => { e.stopPropagation(); onRestore?.(r.id); }} style={{ flexShrink: 0, fontSize: 11, color: "var(--signal)", background: "none", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>{t("factory.leftRail.history.restore")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HealthStrip({ checks }: { checks: Array<{ ok: boolean | undefined; label: string }> }) {
  const { t } = useI18n();
  return (
    <div style={{ border: "1px solid var(--border-2)", borderRadius: 8, padding: "8px 10px", background: "var(--panel-2)" }}>
      <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>{t("factory.leftRail.health.title")}</div>
      {checks.map((c, i) => <EvalLine key={i} ok={c.ok} label={c.label} />)}
    </div>
  );
}

export function DraftList({
  drafts,
  promoting,
  promoteMsg,
  promoteError = false,
  editMsg,
  sandboxMsg,
  editingSlug,
  sandboxingSlug,
  onPromote,
  onEdit,
  onSandbox,
  onDelete,
}: {
  drafts: DraftRow[];
  promoting: boolean;
  promoteMsg: string;
  promoteError?: boolean;
  editMsg?: string;
  sandboxMsg?: string;
  editingSlug?: string | null;
  sandboxingSlug?: string | null;
  onPromote: (slugs?: string[]) => void;
  onEdit?: (draft: DraftRow) => void;
  onSandbox?: (draft: DraftRow) => void;
  onDelete?: (slug: string) => void;
}) {
  const { t } = useI18n();
  // R4: per-draft selection (track EXCLUDED so it survives draft-list updates); default all in.
  // Historical/test sandbox stand-ins can still exist on disk, but they are never
  // promotable. Render their checkbox disabled instead of offering a dead toggle.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  if (drafts.length === 0) return <div style={{ fontSize: 11, color: "var(--text-4)" }}>{t("factory.leftRail.draft.empty")}</div>;
  const ineligibleReason = (draft: DraftRow) => draftPromotionIneligibleReason(t, draft);
  const isOn = (draft: DraftRow) => !excluded.has(draft.slug) && !ineligibleReason(draft);
  const toggle = (slug: string) => setExcluded((prev) => { const n = new Set(prev); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });
  const selected = drafts.filter(isOn).map((d) => d.slug);
  return (
    <>
      {drafts.map((d) => {
        const reason = ineligibleReason(d);
        return (
          <div key={d.slug} style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: "6px 8px", marginBottom: 3, borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)" }}>
            <label title={reason ?? undefined} style={{ display: "flex", gap: 7, alignItems: "flex-start", flex: 1, minWidth: 0, cursor: reason ? "not-allowed" : "pointer", opacity: reason ? 0.7 : 1 }}>
              <input type="checkbox" checked={isOn(d)} disabled={Boolean(reason)} onChange={() => toggle(d.slug)} style={{ marginTop: 2 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text)" }}>{d.spec?.nameZh ?? d.spec?.short ?? d.slug}{reason ? ` · ${t("factory.leftRail.draft.notPromotable")}` : ""}</span>
                <span style={{ display: "block", fontSize: 10, color: reason ? "var(--red)" : "var(--text-3)", fontFamily: "var(--mono)" }}>
                  {reason ?? `${t("factory.leftRail.draft.toolCount", { count: (d.spec?.tools ?? []).length })}${d.spec?.actionName ? ` · ${d.spec.actionName}` : ""} · ${d.versionId}`}
                </span>
                {d.replayReady === true && d.promotionEligible !== true && (
                  <span role="status" style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--amber)", lineHeight: 1.4 }}>
                    {t("factory.leftRail.draft.sandboxVerifiedBlocked")}
                  </span>
                )}
                {d.replayReady === true && d.promotionEligible === true && (
                  <span role="status" style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--green)", lineHeight: 1.4 }}>
                    {t("factory.leftRail.draft.regressionReplayable")}
                  </span>
                )}
              </span>
            </label>
            {onEdit && (
              <button
                title={d.versionId ? t("factory.leftRail.draft.editTitle") : t("factory.leftRail.draft.editDisabledTitle")}
                aria-label={t("factory.leftRail.draft.editAriaLabel", { name: d.spec?.nameZh ?? d.slug })}
                disabled={!d.versionId || Boolean(editingSlug)}
                onClick={() => onEdit(d)}
                style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: !d.versionId || editingSlug ? "default" : "pointer", color: "var(--text-3)", fontSize: 12, opacity: !d.versionId || editingSlug ? 0.45 : 1 }}
              >{editingSlug === d.slug ? "…" : "✎"}</button>
            )}
            {onSandbox && d.versionId && (
              <button
                title={d.regression ? t("factory.leftRail.draft.sandboxRetestTitle") : t("factory.leftRail.draft.sandboxCreateTitle")}
                aria-label={t("factory.leftRail.draft.sandboxAriaLabel", { name: d.spec?.nameZh ?? d.slug })}
                disabled={Boolean(sandboxingSlug || editingSlug)}
                onClick={() => onSandbox(d)}
                style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: sandboxingSlug || editingSlug ? "default" : "pointer", color: d.regression ? "var(--text-3)" : "var(--amber)", fontSize: 12, opacity: sandboxingSlug || editingSlug ? 0.45 : 1 }}
              >{sandboxingSlug === d.slug ? "…" : "🧪"}</button>
            )}
            {onDelete && (
              <button title={t("factory.leftRail.draft.deleteTitle")} onClick={() => onDelete(d.slug)} style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: "pointer", color: "var(--text-4)", fontSize: 12 }}>🗑</button>
            )}
          </div>
        );
      })}
      <button onClick={() => onPromote(selected)} disabled={promoting || selected.length === 0} title={t("factory.leftRail.draft.promoteTitle")} style={{ width: "100%", marginTop: 6, padding: "7px 9px", borderRadius: 7, border: "1px solid var(--green)", background: "transparent", color: "var(--green)", cursor: promoting || selected.length === 0 ? "default" : "pointer", fontSize: 12, opacity: promoting || selected.length === 0 ? 0.5 : 1 }}>
        {promoting ? t("factory.leftRail.draft.promoting") : t("factory.leftRail.draft.promoteSelected", { count: selected.length })}
      </button>
      {editMsg && <div role="status" style={{ fontSize: 10.5, color: "var(--green)", marginTop: 5, lineHeight: 1.5 }}>{editMsg}</div>}
      {sandboxMsg && <div role="status" style={{ fontSize: 10.5, color: "var(--green)", marginTop: 5, lineHeight: 1.5 }}>{sandboxMsg}</div>}
      {promoteMsg && <div role={promoteError ? "alert" : "status"} style={{ fontSize: 10.5, color: promoteError ? "var(--red)" : "var(--text-3)", marginTop: 5, lineHeight: 1.5 }}>{promoteMsg}</div>}
    </>
  );
}

export function draftPromotionIneligibleReason(t: Translate, draft: DraftRow): string | null {
    const sandboxScaffold = /-mock-ext-|(^|[-_])mock([-_]|$)|(^|[-_])simulate([-_]|$)|mock_/i.test(draft.slug)
      || draft.spec?.isMock === true
      || draft.spec?.mock === true;
    if (sandboxScaffold) return t("factory.leftRail.draft.reason.sandboxScaffold");
    if (!draft.versionId) return t("factory.leftRail.draft.reason.noVersionId");
    if (!draft.regression?.artifact || !draft.regression.evidenceFingerprint || !draft.regression.suiteFingerprint) {
      return t("factory.leftRail.draft.reason.missingRegression");
    }
    if (draft.replayReady !== true || draft.regressionReady !== true) {
      if (draft.regressionStatus === "pending_replay") return t("factory.leftRail.draft.reason.pendingReplay");
      if (draft.regressionStatus === "invalid") return t("factory.leftRail.draft.reason.invalidArtifact");
      if (draft.regressionStatus === "missing") return t("factory.leftRail.draft.reason.missingStatus");
      return t("factory.leftRail.draft.reason.notConfirmed");
    }
    if (
      draft.promotionGateAdmission !== true
      ||
      draft.promotionEligible !== true
      || draft.promotionEvidenceReady !== true
      || draft.evidenceQualification?.promotion !== "candidate"
    ) {
      const blockers = draft.promotionBlockers?.length ? `: ${draft.promotionBlockers.slice(0, 2).join("; ")}` : "";
      return t("factory.leftRail.draft.reason.liveProbeRequired", { blockers });
    }
    return null;
}
