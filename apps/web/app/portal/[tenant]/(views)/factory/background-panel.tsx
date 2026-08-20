"use client";

/**
 * Agent 工厂 — Background tasks 浮出面板（Claude Desktop 质感）。
 *
 * 主体是【当前会话】的任务分解（deriveSessionTasks）：Harness（ReAct 主循环）、每个
 * Agent 的构建（内部 plan/工具调用/沙箱 I/O/修订）、Sub-agent（固化的 + 运行时 spawn）、
 * Tool（造工具，真实入库后在卡片上问「保留还是删除？」）、Sandbox（每次部署）——每条
 * 可 View transcript 看专属过程与推理；Agent 条目可一键跳到右栏检查器。
 *
 * 其后是跨会话的后台：领域报告任务（实时阶段 + 产物下载 + Clear）与其它仍在运行、
 * 可重连的会话。协作信号（大脑在等你回答 → 引导回聊天区；介入排队计数）置顶——
 * 聊天框才是回答与介入的通道，面板只负责让你"看见一切在后台发生的事"。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, HelpTip, Markdown } from "@/app/portal/components";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import { FactoryRequestGate } from "@/lib/factory-request-gate";
import { chip } from "./atoms";
import {
  buildGeneratedToolDeactivationPath,
  decodeFactoryResponse,
  factoryNetworkFailure,
  type FactoryApiResult,
} from "./factory-api";
import type { RunRow } from "./model";
import { deriveSessionTasks, deriveGeneratedTools, deriveAcceptance, type SessionTask, type SessionTaskStatus } from "./workers";
import { derivePhaseTimeline, type PhaseGroup } from "./phase-timeline";

function tenantHeaders(tenant: string): Record<string, string> {
  return { ...tenantHeader(), "x-agentic-tenant": tenant };
}

function isViewedTenant(tenant: string): boolean {
  return tenantHeader()["x-agentic-tenant"] === tenant;
}

async function apiGet<T>(t: Translate, tenant: string, path: string): Promise<FactoryApiResult<T>> {
  try {
    const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json", ...tenantHeaders(tenant) } });
    return await decodeFactoryResponse<T>(t, r);
  } catch (error) {
    return factoryNetworkFailure(t, error);
  }
}
async function apiSend<T = unknown>(t: Translate, tenant: string, path: string, method: "POST" | "DELETE", body?: unknown): Promise<FactoryApiResult<T>> {
  try {
    const headers: Record<string, string> = { Accept: "application/json", ...tenantHeaders(tenant) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method, credentials: "same-origin", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return await decodeFactoryResponse<T>(t, r);
  } catch (e) {
    return factoryNetworkFailure(t, e);
  }
}

interface BgRun extends RunRow {
  live?: boolean;
}
interface ReportJobRow {
  id: string;
  domain: string;
  domainName?: string;
  format: string;
  status: "running" | "done" | "error";
  phase?: string;
  createdAt: number;
  finishedAt?: number;
  error?: string;
  note?: string;
  title?: string;
  artifacts: Array<{ id: string; kind: string; size: number; label: string }>;
}
interface LibToolRow {
  name: string;
  description: string;
  activeRevisionId?: string;
  activeRevisionDomainId?: string | null;
  managedLifecycle?: boolean;
  deactivationBlocker?: {
    code: string;
    message: string;
    next?: string;
  };
}

const EMPTY_BACKGROUND: { runs: BgRun[]; jobs: ReportJobRow[] } = { runs: [], jobs: [] };
const EMPTY_LIB_TOOLS: LibToolRow[] = [];

type FilterKey = "all" | "running" | "done" | "failed";
type PanelReadSurface = "background" | "mailbox" | "tools";

const STATUS_COLOR: Record<SessionTaskStatus, string> = {
  running: "var(--signal)",
  ok: "var(--green)",
  error: "var(--red)",
  idle: "var(--text-3)",
};
// Claude-Desktop grouping: 运行中 → 等待 → 完成/失败. Recency (workers' order-desc) is the in-group tiebreak.
const STATUS_RANK: Record<SessionTaskStatus, number> = { running: 0, idle: 1, ok: 2, error: 2 };

function Dot({ status, size = 8 }: { status: SessionTaskStatus; size?: number }) {
  // `color` drives the `.health-pulse::before` ping ring (it uses currentColor) so the breathing
  // halo matches the status hue instead of inheriting the muted text color.
  return (
    <span
      className={status === "running" ? "health-pulse" : undefined}
      style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: STATUS_COLOR[status], color: STATUS_COLOR[status], flexShrink: 0 }}
    />
  );
}

const timeOf = (v: string | number | undefined, locale: string): string => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
};
const durOf = (a?: number, b?: number): string => {
  if (!a || !b || b <= a) return "";
  const sec = Math.round((b - a) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
};

const ICON_OF_KIND: Record<string, string> = { think: "🧠", message: "💬", tool: "🔧", gate: "🙋", stage: "▶", event: "•", error: "✗" };

/** Per-task 推理过程 timeline. Exported so the right-rail AgentInspector renders the SAME
 *  per-agent stream (reasoning.step/strategy/tool/think attribution) instead of duplicating it. */
export function TaskTranscript({ task }: { task: SessionTask }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {task.transcript.length === 0 && <div style={{ fontSize: 12, color: "var(--text-4)", padding: 12 }}>{t("factory.backgroundPanel.transcript.empty")}</div>}
      {task.transcript.map((it) => (
        <div key={it.id} style={{ display: "flex", gap: 8, padding: "6px 4px", borderBottom: "1px solid var(--border)", fontSize: 12, lineHeight: 1.55 }}>
          <span style={{ width: 18, textAlign: "center", color: it.ok === false || it.kind === "error" ? "var(--red)" : "var(--text-3)" }}>{ICON_OF_KIND[it.kind] ?? "•"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontWeight: it.kind === "gate" ? 600 : 500 }}>{it.label}</span>
            {it.ok !== undefined && <span style={{ marginLeft: 6, fontSize: 10.5, color: it.ok ? "var(--green)" : "var(--red)" }}>{it.ok ? "✓" : "✗"}</span>}
            {it.detail && <div style={{ color: "var(--text-3)", fontSize: 11.5, whiteSpace: "pre-wrap" }}>{it.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

const linkBtn: React.CSSProperties = { fontSize: 11, padding: "2px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "none", color: "var(--text-2)", cursor: "pointer" };
const primaryLinkBtn: React.CSSProperties = { ...linkBtn, border: "1px solid var(--signal)", color: "var(--signal)" };

/* ── #UI-DRILL — L2 决策卡组：点开一个 agent，宏观→微观看它的计划/思考/工具/问题/子agent/真实 I/O。
   sub-agent 可继续展开自己的 L2（递归，封顶 2 层防失控）。纯投影，历史回放一致。 ── */
function DrillCard({ icon, title, color, children }: { icon: string; title: string; color?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel-3)", padding: "7px 9px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: color ?? "var(--text-2)", marginBottom: 3 }}>{icon} {title}</div>
      <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{children}</div>
    </div>
  );
}

type DrillPart = "reasoning" | "tools" | "problems" | "subs" | "io";

/** Render an agent's L2 decision cards. `parts` scopes which cards show, so the detail drawer can
 *  slice this into 工作流/决策 · Sub-agents · 测试 sections; omit it (or pass nothing) for the full set.
 *  `flush` drops the left rail + top margin when the caller is already a section body (drawer). */
function AgentDrillIn({ task, taskBySlug, depth = 0, parts, flush }: { task: SessionTask; taskBySlug: Map<string, SessionTask>; depth?: number; parts?: DrillPart[]; flush?: boolean }) {
  const { t } = useI18n();
  const [openSub, setOpenSub] = useState<string | null>(null);
  const d = task.drill;
  if (!d) return null;
  const show = (p: DrillPart) => !parts || parts.includes(p);
  const toolItems = task.transcript.filter((it) => it.kind === "tool").slice(-8);
  const wrap: React.CSSProperties = flush
    ? { display: "flex", flexDirection: "column", gap: 6 }
    : { display: "flex", flexDirection: "column", gap: 6, marginTop: 4, paddingLeft: 16, borderLeft: "2px solid var(--border-2)" };
  return (
    <div style={wrap}>
      {show("reasoning") && d.strategy && (
        <DrillCard icon="🧭" title={t("factory.backgroundPanel.drill.reasoningMethod")}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--signal)", fontWeight: 600 }}>{d.strategy}</span>
        </DrillCard>
      )}
      {show("reasoning") && d.reasoning && <DrillCard icon="🧠" title={t("factory.backgroundPanel.drill.planReasoning")}><Markdown>{d.reasoning.slice(0, 500)}</Markdown></DrillCard>}
      {show("reasoning") && d.decisionLogic && <DrillCard icon="🔀" title={t("factory.backgroundPanel.drill.branchLogic")}><Markdown>{d.decisionLogic.slice(0, 400)}</Markdown></DrillCard>}
      {show("tools") && toolItems.length > 0 && (
        <DrillCard icon="🔧" title={t("factory.backgroundPanel.drill.toolsUsed")}>
          {toolItems.map((it) => (
            <div key={it.id}>
              {it.label}{it.ok !== undefined ? (it.ok ? " ✓" : " ✗") : ""}{it.detail ? ` — ${it.detail}` : ""}
            </div>
          ))}
        </DrillCard>
      )}
      {show("problems") && (d.problems.length > 0 || d.refineCritiques.length > 0) && (
        <DrillCard icon="⚠️" title={t("factory.backgroundPanel.drill.problemsRevisions")} color="var(--amber)">
          {d.problems.map((p, i) => <div key={`p${i}`}>· {p}</div>)}
          {d.refineCritiques.slice(-3).map((c, i) => <div key={`c${i}`} style={{ color: "var(--text-4)" }}>↻ {c}</div>)}
        </DrillCard>
      )}
      {/* #CHECKLIST — harness 持有的该 agent 验收清单：大脑无权删改，翻绿只能靠真实执行证据 */}
      {show("problems") && d.checklist && d.checklist.length > 0 && (
        <DrillCard icon="🧾" title={`${t("factory.backgroundPanel.drill.checklistTitle")}${d.checklist.every((c) => c.pass) ? " ✓" : ""}`} color={d.checklist.every((c) => c.pass) ? "var(--green)" : "var(--amber)"}>
          {d.checklist.map((c) => (
            <div key={c.key} style={{ color: c.pass ? "var(--text-3)" : "var(--amber)" }}>
              {c.pass ? "✓" : "✗"} {c.label}{c.detail ? ` — ${c.detail}` : ""}
            </div>
          ))}
        </DrillCard>
      )}
      {show("subs") && d.subAgents.length > 0 && (
        <DrillCard icon="🧩" title={t("factory.backgroundPanel.drill.subAgentsTitle")} color="var(--violet)">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {d.subAgents.map((sub) => (
              <button key={sub.slug} onClick={() => setOpenSub(openSub === sub.slug ? null : sub.slug)}
                style={{ ...linkBtn, border: "1px solid var(--violet)", color: "var(--violet)", fontSize: 10.5 }}>
                {openSub === sub.slug ? "▾" : "▸"} {sub.name}
              </button>
            ))}
          </div>
          {openSub && depth < 2 && taskBySlug.get(openSub) && (
            <AgentDrillIn task={taskBySlug.get(openSub)!} taskBySlug={taskBySlug} depth={depth + 1} />
          )}
        </DrillCard>
      )}
      {show("io") && d.io && (
        <DrillCard icon="📦" title={`${t("factory.backgroundPanel.drill.realIoTitle")}${d.fidelityFail ? ` · ⚠ ${t("factory.backgroundPanel.common.contractViolation")}` : ""}`} color={d.fidelityFail ? "var(--red)" : "var(--green)"}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>
            ◂ {d.io.triggerEvent ?? "—"} → ▸ {d.io.outputEvent ?? t("factory.backgroundPanel.io.noOutputEvent")} · {d.io.status ?? ""}
          </div>
          {d.io.output && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-4)", marginTop: 2 }}>{d.io.output.slice(0, 300)}</div>}
        </DrillCard>
      )}
      {!parts && !d.reasoning && !toolItems.length && !d.problems.length && !d.subAgents.length && !d.io && (
        <div style={{ fontSize: 10.5, color: "var(--text-4)" }}>{t("factory.backgroundPanel.drill.noDecisions")}</div>
      )}
    </div>
  );
}

const KIND_ICON: Record<SessionTask["kind"], string> = { harness: "🧠", agent: "🤖", subagent: "🧩", tool: "🔧", sandbox: "📦" };

// ── 测试 · I/O section — the agent's real sandbox trigger→emit + input/output payload snapshots. ──
function AgentIoPanel({ io, fidelityFail }: { io: { triggerEvent?: string; outputEvent?: string; status?: string; input?: string; output?: string }; fidelityFail?: boolean }) {
  const { t } = useI18n();
  const label: React.CSSProperties = { fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 };
  const box: React.CSSProperties = { fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-2)", background: "var(--panel-3)", borderRadius: 6, padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5, maxHeight: 260, overflow: "auto" };
  const statusColor = /error|fail/i.test(io.status ?? "") ? "var(--red)" : /ok|complet/i.test(io.status ?? "") ? "var(--green)" : "var(--text-3)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11.5, fontFamily: "var(--mono)", color: statusColor }}>{t("factory.backgroundPanel.io.statusLabel", { status: io.status || "—" })}</span>
        {fidelityFail && <span style={{ fontSize: 10.5, color: "var(--red)", border: "1px solid var(--red)", borderRadius: 6, padding: "1px 7px" }}>⚠ {t("factory.backgroundPanel.common.contractViolation")}</span>}
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {io.triggerEvent && chip(`◂ ${io.triggerEvent}`, "var(--blue)")}
        {io.outputEvent && chip(`▸ ${io.outputEvent}`, "var(--violet)")}
      </div>
      {io.input && <div><div style={label}>{t("factory.backgroundPanel.io.inputPayload")}</div><div style={box}>{io.input}</div></div>}
      {io.output && <div><div style={label}>{t("factory.backgroundPanel.io.outputPayload")}</div><div style={box}>{io.output}</div></div>}
      {!io.input && !io.output && <div style={{ fontSize: 11, color: "var(--text-4)" }}>{t("factory.backgroundPanel.io.noSnapshot")}</div>}
    </div>
  );
}

/* ── #UI-DRAWER — Claude-Desktop style detail drawer: click a background task card → a right-side
   drawer titled with the agent name, sectioned into 工作流·决策 / Sub-agents / 推理过程 / 测试·I/O.
   A fixed sheet on wide screens; on a phone `min(472px,100vw)` collapses it to full-width. Esc or a
   backdrop click closes. Non-agent tasks (harness/tool/sandbox) show just the 推理过程 transcript. ── */
function AgentDetailDrawer({ task, taskBySlug, onClose, onSelectAgent }: { task: SessionTask; taskBySlug: Map<string, SessionTask>; onClose: () => void; onSelectAgent?: (slug: string) => void }) {
  const { t } = useI18n();
  const d = task.drill;
  const hasWorkflow = !!(d && (d.reasoning || d.decisionLogic || task.transcript.some((it) => it.kind === "tool") || d.problems.length || d.refineCritiques.length));
  const hasSubs = !!(d && d.subAgents.length);
  const io = d?.io;
  const hasIo = !!(io && (io.triggerEvent || io.outputEvent || io.input || io.output || d?.fidelityFail));
  const sections = useMemo(() => {
    const out: Array<{ key: string; label: string }> = [];
    if (hasWorkflow) out.push({ key: "flow", label: t("factory.backgroundPanel.drawer.sectionFlow") });
    if (hasSubs) out.push({ key: "subs", label: t("factory.backgroundPanel.drawer.sectionSubs", { count: d!.subAgents.length }) });
    out.push({ key: "transcript", label: t("factory.backgroundPanel.drawer.sectionTranscript") });
    if (hasIo) out.push({ key: "test", label: t("factory.backgroundPanel.drawer.sectionTest") });
    return out;
  }, [hasWorkflow, hasSubs, hasIo, d, t]);
  const [sec, setSec] = useState<string>(sections[0]?.key ?? "transcript");
  // Sections grow as events stream in (io/subs appear late) — keep the active one valid.
  useEffect(() => { setSec((cur) => (sections.some((s) => s.key === cur) ? cur : sections[0]?.key ?? "transcript")); }, [sections]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: "var(--z-modal)" as unknown as number }} />
      <div className="rise" role="dialog" aria-label={t("factory.backgroundPanel.drawer.ariaLabel", { title: task.title })} style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(472px, 100vw)", zIndex: "var(--z-modal)" as unknown as number, background: "var(--panel-2)", borderLeft: "2px solid var(--signal)", boxShadow: "-16px 0 44px rgba(0,0,0,.32)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "13px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ marginTop: 4 }}><Dot status={task.status} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)", lineHeight: 1.4 }}>{KIND_ICON[task.kind]} {task.title}</div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 3, lineHeight: 1.5, wordBreak: "break-word" }}>{task.typeLabel} · {task.status === "idle" ? "—" : t(`factory.backgroundPanel.status.${task.status}`)}{task.meta ? ` · ${task.meta}` : ""}</div>
          </div>
          {task.agentSlug && onSelectAgent && <button onClick={() => onSelectAgent(task.agentSlug!)} style={primaryLinkBtn} title={t("factory.backgroundPanel.drawer.inspectorTitle")}>{t("factory.backgroundPanel.drawer.inspectorBtn")}</button>}
          <button onClick={onClose} title={t("factory.backgroundPanel.common.closeEsc")} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 17, lineHeight: 1 }}>✕</button>
        </div>
        {sections.length > 1 && (
          <div style={{ display: "flex", gap: 5, padding: "9px 12px 0", flexWrap: "wrap" }}>
            {sections.map((s) => (
              <button key={s.key} onClick={() => setSec(s.key)} style={{ fontSize: 11, padding: "4px 11px", borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", border: `1px solid ${sec === s.key ? "var(--signal)" : "var(--border)"}`, background: sec === s.key ? "var(--panel-3)" : "transparent", color: sec === s.key ? "var(--text)" : "var(--text-3)" }}>{s.label}</button>
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
          {sec === "flow" && d && <AgentDrillIn task={task} taskBySlug={taskBySlug} parts={["reasoning", "tools", "problems"]} flush />}
          {sec === "subs" && d && <AgentDrillIn task={task} taskBySlug={taskBySlug} parts={["subs"]} flush />}
          {sec === "transcript" && <TaskTranscript task={task} />}
          {sec === "test" && io && <AgentIoPanel io={io} fidelityFail={d?.fidelityFail} />}
        </div>
      </div>
    </>
  );
}

export interface BackgroundPanelProps {
  tenant: string;
  domain: string;
  events: BrainEvent[];
  running: boolean;
  convId: string;
  viewingRunId: string | null;
  liveRunId: string | null;
  /** page 已算好的 "等你决定" 提示（clarify/测试用例/边界分类）——面板只引导回聊天区。 */
  awaitingHint: string | null;
  onReconnectRun: (id: string) => void;
  /** 跳到右栏智能体检查器（tab=flow + selectedSlug）。 */
  onSelectAgent: (slug: string) => void;
  onClose?: () => void;
  /** 作为右栏 tab 内联渲染（非浮出层）：无 fixed 定位、无 Esc/✕，由 tab 容器滚动。 */
  inline?: boolean;
}

// #OBSERVABILITY — Workflow→Phase→Agent 遥测视图(参考 Claude 的 Workflow 面板)。把一次运行按六段
// stage 分 phase,每 phase 显示真实 tokens/tools/time + 展开看在此阶段跑过的子脑(专家/研究员)。
function fmtMs(ms: number): string {
  if (!ms || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}
function fmtTok(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }

function PhaseRow({ p }: { p: PhaseGroup }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const dot: SessionTaskStatus = p.status === "active" ? "running" : p.status === "error" ? "error" : "ok";
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel-2)", overflow: "hidden" }}>
      <button onClick={() => p.agents.length && setOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: p.agents.length ? "pointer" : "default", background: "transparent", border: "none", color: "var(--text)" }}>
        <Dot status={dot} size={7} />
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, textAlign: "left" }}>{p.label}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-3)", display: "flex", gap: 8 }}>
          {p.agents.length > 0 && <span>{t("factory.backgroundPanel.phase.subBrains", { count: p.agents.length })}</span>}
          <span>{t("factory.backgroundPanel.common.toolsCount", { count: p.tools })}</span>
          {p.tokens > 0 && <span>{fmtTok(p.tokens)} tok</span>}
          <span>{fmtMs(p.durationMs)}</span>
        </span>
        {p.agents.length > 0 && <span style={{ fontSize: 10, color: "var(--text-3)" }}>{open ? "▾" : "▸"}</span>}
      </button>
      {open && p.agents.length > 0 && (
        <div style={{ padding: "0 10px 8px 24px", display: "flex", flexDirection: "column", gap: 3 }}>
          {p.agents.map((a) => (
            <div key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <Dot status={a.status} size={6} />
              <span style={{ flex: 1, color: "var(--text-2)" }}>{a.name}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)" }}>{a.durationMs ? fmtMs(a.durationMs) : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseTimelineView({ events }: { events: BrainEvent[] }) {
  const { t } = useI18n();
  const tl = useMemo(() => derivePhaseTimeline(t, events), [events, t]);
  if (tl.phases.length < 2 && tl.totalTools === 0) return null; // nothing meaningful yet
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: 10, padding: "9px 10px", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <span style={{ fontWeight: 700, color: "var(--text-2)" }}>{t("factory.backgroundPanel.phase.workflowPhases", { count: tl.phases.length })}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", marginLeft: "auto", display: "flex", gap: 8 }}>
          <span>{t("factory.backgroundPanel.common.toolsCount", { count: tl.totalTools })}</span>
          {tl.totalTokens > 0 && <span>{fmtTok(tl.totalTokens)} tok</span>}
          <span>{fmtMs(tl.totalDurationMs)}</span>
        </span>
      </div>
      {tl.phases.map((p) => <PhaseRow key={p.stage} p={p} />)}
    </div>
  );
}

/** #CHECKLIST — 舰队级验收清单（harness 持有）：finish 每次尝试的快照。全绿=交付达标；
 *  未过项直接点名（大脑无权改任何一项——翻绿只能靠注册/真跑/code_ran 回执/保真评分这类真实证据）。 */
function AcceptanceChecklistView({ events }: { events: BrainEvent[] }) {
  const { t } = useI18n();
  const snap = useMemo(() => deriveAcceptance(t, events), [events, t]);
  const [open, setOpen] = useState(true);
  if (!snap) return null;
  const passed = snap.criteria.filter((c) => c.pass).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, border: `1px solid ${snap.allPass ? "var(--green)" : "var(--border)"}`, borderRadius: 10, padding: "9px 10px", background: "var(--panel)" }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", textAlign: "left" }}>
        <span style={{ fontWeight: 700, color: snap.allPass ? "var(--green)" : "var(--text-2)" }}>
          {t("factory.backgroundPanel.acceptance.title")}{snap.allPass ? ` · ${t("factory.backgroundPanel.acceptance.allGreen")} ✓` : ` · ${passed}/${snap.criteria.length}`}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)" }}>{open ? "▾" : "▸"} {t("factory.backgroundPanel.acceptance.evidenceNote")}</span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
          {snap.criteria.map((c) => (
            <div key={c.key} style={{ display: "flex", gap: 6, alignItems: "baseline", color: c.pass ? "var(--text-3)" : "var(--amber)" }}>
              <span style={{ fontFamily: "var(--mono)" }}>{c.pass ? "✓" : "✗"}</span>
              <span>{c.label}</span>
              <span style={{ fontSize: 10, color: "var(--text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.detail}</span>
            </div>
          ))}
          {snap.perAgent.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
              {snap.perAgent.map((p) => (
                <span key={p.slug} title={p.items.map((i) => `${i.pass ? "✓" : "✗"} ${i.label}`).join("\n")}
                  style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 7px", borderRadius: 999, border: `1px solid ${p.pass ? "var(--green)" : "var(--amber)"}`, color: p.pass ? "var(--green)" : "var(--amber)" }}>
                  {p.pass ? "✓" : "✗"} {p.short}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BackgroundPanel({ tenant, domain, events, running, convId, viewingRunId, liveRunId, awaitingHint, onReconnectRun, onSelectAgent, onClose, inline }: BackgroundPanelProps) {
  const { language, t } = useI18n();
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const [requestGate] = useState(() => new FactoryRequestGate());
  const sessionTasks = useMemo(() => deriveSessionTasks(t, events, running), [events, running, t]);
  // #UI-DRILL — slug→task 索引供子 agent 递归下钻（抽屉里的 Sub-agents 分区用）。
  const taskBySlug = useMemo(() => new Map(sessionTasks.filter((t) => t.agentSlug).map((t) => [t.agentSlug!, t])), [sessionTasks]);
  const runTools = useMemo(() => deriveGeneratedTools(events), [events]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = useMemo(() => sessionTasks.find((t) => t.id === openTaskId) ?? null, [sessionTasks, openTaskId]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [note, setNote] = useState("");
  const [readErrors, setReadErrors] = useState<Partial<Record<PanelReadSurface, string>>>({});
  const setReadError = useCallback((surface: PanelReadSurface, message?: string) => {
    setReadErrors((previous) => {
      if (message) return { ...previous, [surface]: message };
      if (!(surface in previous)) return previous;
      const next = { ...previous };
      delete next[surface];
      return next;
    });
  }, []);
  const [pendingSnapshot, setPendingSnapshot] = useState<{ tenant: string; domain: string; conversation: string; value: number } | null>(null);
  const pending = pendingSnapshot?.tenant === tenant && pendingSnapshot.domain === domain && pendingSnapshot.conversation === convId
    ? pendingSnapshot.value
    : 0;

  const [bgSnapshot, setBgSnapshot] = useState<{ tenant: string; value: { runs: BgRun[]; jobs: ReportJobRow[] } } | null>(null);
  const bg = bgSnapshot?.tenant === tenant ? bgSnapshot.value : EMPTY_BACKGROUND;
  const refreshBg = useCallback(() => {
    const scope = { tenant };
    const ticket = requestGate.begin("background", scope);
    void apiGet<{ runs: BgRun[]; jobs: ReportJobRow[] }>(t, tenant, "/v1/agent-factory/background").then((result) => {
      if (!requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setReadError("background", t("factory.backgroundPanel.error.backgroundReadFailed", { message: result.message }));
        return;
      }
      if (!result.data || !Array.isArray(result.data.runs) || !Array.isArray(result.data.jobs)) {
        setReadError("background", t("factory.backgroundPanel.error.backgroundReadInvalid"));
        return;
      }
      setReadError("background");
      setBgSnapshot({ tenant, value: result.data });
    });
  }, [requestGate, setReadError, t, tenant]);
  useEffect(() => {
    refreshBg();
    const timer = setInterval(refreshBg, 5000);
    return () => clearInterval(timer);
  }, [refreshBg]);
  useEffect(() => {
    if (!convId) {
      requestGate.invalidate("mailbox");
      setPendingSnapshot(null);
      setReadError("mailbox");
      return;
    }
    const scope = { tenant, domain: `${domain}\u0000${convId}` };
    const tick = () => {
      const ticket = requestGate.begin("mailbox", scope);
      void apiGet<{ pending: number }>(t, tenant, `/v1/agent-factory/mailbox?conversation=${encodeURIComponent(convId)}`).then((result) => {
        if (!requestGate.isCurrent(ticket, scope)) return;
        if (!result.ok) {
          setReadError("mailbox", t("factory.backgroundPanel.error.mailboxReadFailed", { message: result.message }));
          return;
        }
        if (!result.data || typeof result.data.pending !== "number") {
          setReadError("mailbox", t("factory.backgroundPanel.error.mailboxReadInvalid"));
          return;
        }
        setReadError("mailbox");
        setPendingSnapshot({ tenant, domain, conversation: convId, value: result.data.pending });
      });
    };
    tick();
    const timer = setInterval(tick, 6000);
    return () => clearInterval(timer);
  }, [convId, domain, requestGate, setReadError, t, tenant]);
  useEffect(() => {
    if (inline || !onClose) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, inline]);

  // ── 已真实入库工具的「保留还是删除？」确认闭环（内联在 Tool 任务卡上）──
  const keptKey = `ao:factory:keptTools:${tenant}:${domain}`;
  const [kept, setKept] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Absence of a key is meaningful: do not retain the previous tenant or
    // ontology's acknowledgements in component state.
    setKept(new Set());
    try {
      const v = localStorage.getItem(keptKey);
      if (v) setKept(new Set(JSON.parse(v) as string[]));
    } catch {
      /* ignore */
    }
  }, [keptKey]);
  const markKept = (name: string) => {
    setKept((prev) => {
      const next = new Set(prev);
      next.add(name);
      try {
        localStorage.setItem(keptKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const [libToolsSnapshot, setLibToolsSnapshot] = useState<{ tenant: string; domain: string; tools: LibToolRow[] } | null>(null);
  const libTools = libToolsSnapshot?.tenant === tenant && libToolsSnapshot.domain === domain
    ? libToolsSnapshot.tools
    : EMPTY_LIB_TOOLS;
  const refreshLibTools = useCallback(() => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("generated-tools", scope);
    void apiGet<{ tools: LibToolRow[] }>(t, tenant, "/v1/agent-factory/generated-tools").then((result) => {
      if (!requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setReadError("tools", t("factory.backgroundPanel.error.toolsReadFailed", { message: result.message }));
        return;
      }
      if (!result.data || !Array.isArray(result.data.tools)) {
        setReadError("tools", t("factory.backgroundPanel.error.toolsReadInvalid"));
        return;
      }
      setReadError("tools");
      setLibToolsSnapshot({ tenant, domain, tools: result.data.tools });
    });
  }, [domain, requestGate, setReadError, t, tenant]);
  useEffect(() => {
    refreshLibTools();
  }, [refreshLibTools, runTools.length]);
  // 待确认 = 本次会话创建 + 用户没表态 + 确实还在库里（历史回放不问——"刚创建"会误导）。
  const pendingToolNames = useMemo(() => {
    if (viewingRunId) return new Set<string>();
    return new Set(runTools.filter((t) => !kept.has(t.name) && libTools.some((l) => l.name === t.name)).map((t) => t.name));
  }, [runTools, kept, libTools, viewingRunId]);
  const acceptTool = async (name: string) => {
    setNote("");
    if (running && convId) {
      const result = await apiSend<{ queued: boolean }>(t, tenant, "/v1/agent-factory/inject", "POST", { conversation: convId, text: t("factory.backgroundPanel.inject.keepTool", { name }) });
      if (!isViewedTenant(tenant)) return;
      if (!result.ok || result.data.queued !== true) {
        setNote(t("factory.backgroundPanel.error.keepConfirmUndelivered", { detail: result.ok ? t("factory.backgroundPanel.error.serverNotQueued") : result.message }));
        return;
      }
    }
    markKept(name);
  };
  const declineTool = async (name: string) => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("tool-mutation", scope);
    setNote("");
    const tool = libTools.find((candidate) => candidate.name === name);
    if (!tool?.activeRevisionId) {
      setNote(
        tool?.deactivationBlocker?.message ??
          `工具「${name}」没有可核验的 active revision；请先完成 lifecycle migration。`,
      );
      return;
    }
    const path = buildGeneratedToolDeactivationPath({
      name,
      expectedActiveRevisionId: tool.activeRevisionId,
      revisionDomainId: tool.activeRevisionDomainId ?? null,
    });
    const r = await apiSend<{
      deactivated: boolean;
      deleted: boolean;
      retainedHistory: boolean;
    }>(t, tenant, path, "DELETE");
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    if (!r.ok || r.data.deactivated !== true) {
      setNote(t("factory.backgroundPanel.error.deleteToolFailed", { name, detail: r.ok ? "服务端未确认 deactivated:true" : r.message }));
      refreshLibTools();
      return;
    }
    markKept(name);
    if (running && convId) {
      const notifyResult = await apiSend<{ queued: boolean }>(t, tenant, "/v1/agent-factory/inject", "POST", { conversation: convId, text: t("factory.backgroundPanel.inject.deleteTool", { name }) });
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
      if (!notifyResult.ok || notifyResult.data.queued !== true) setNote(t("factory.backgroundPanel.error.toolDeletedNotNotified", { detail: notifyResult.ok ? t("factory.backgroundPanel.error.serverNotQueued") : notifyResult.message }));
    }
    refreshLibTools();
  };

  // ── 领域报告 quick action ──
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportFormat, setReportFormat] = useState<"html" | "pdf" | "both">("both");
  const [reportFocus, setReportFocus] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  useEffect(() => {
    requestGate.begin("tool-mutation", { tenant, domain });
    requestGate.begin("report-mutation", { tenant, domain });
    setNote("");
    setReadErrors({});
    setReportBusy(false);
    setShowReportForm(false);
    setReportFocus("");
    setOpenTaskId(null);
  }, [domain, requestGate, tenant]);
  const startReport = async () => {
    if (!domain || reportBusy) return;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("report-mutation", scope);
    setReportBusy(true);
    setNote("");
    const r = await apiSend<{ job: ReportJobRow }>(t, tenant, "/v1/agent-factory/report", "POST", { domain, format: reportFormat, focus: reportFocus.trim() || undefined });
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    setReportBusy(false);
    if (!r.ok || !r.data.job?.id || r.data.job.status !== "running") {
      setNote(t("factory.backgroundPanel.error.reportStartFailed", { detail: r.ok ? t("factory.backgroundPanel.error.serverNotRunning") : r.message }));
      return;
    }
    setReportFocus("");
    setShowReportForm(false);
    refreshBg();
  };

  const downloadArtifact = async (a: { id: string; kind: string; label: string }, title?: string) => {
    setNote("");
    try {
      const r = await fetch(`/v1/artifacts/${a.id}`, { credentials: "same-origin", headers: { ...tenantHeaders(tenant) } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (blob.size === 0) throw new Error(t("factory.backgroundPanel.error.emptyFile"));
      const url = URL.createObjectURL(blob);
      const ext = a.kind.includes("pdf") ? "pdf" : a.kind.includes("html") ? "html" : "bin";
      const el = document.createElement("a");
      el.href = url;
      el.download = `${(title ?? "report").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60)}.${ext}`;
      document.body.appendChild(el);
      el.click();
      el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      if (isViewedTenant(tenant)) setNote(t("factory.backgroundPanel.error.downloadFailed", { message: (e as Error).message }));
    }
  };

  const clearFinishedJobs = async () => {
    const finished = bg.jobs.filter((j) => j.status !== "running");
    if (!finished.length) return;
    setNote("");
    const results = await Promise.all(finished.map(async (job) => ({
      job,
      result: await apiSend<{ deleted: boolean }>(t, tenant, `/v1/agent-factory/report/${encodeURIComponent(job.id)}`, "DELETE"),
    })));
    if (!isViewedTenant(tenant)) return;
    const failures = results.filter(({ result }) => !result.ok || result.data.deleted !== true);
    if (failures.length) {
      const details = failures.map(({ job, result }) => `${job.title ?? job.id} (${result.ok ? t("factory.backgroundPanel.error.serverNotDeleted") : result.message})`).join("; ");
      setNote(t("factory.backgroundPanel.error.clearReportsPartial", { count: failures.length, details }));
    }
    refreshBg();
  };

  const clearReportJob = async (job: ReportJobRow) => {
    setNote("");
    const result = await apiSend<{ deleted: boolean }>(t, tenant, `/v1/agent-factory/report/${encodeURIComponent(job.id)}`, "DELETE");
    if (!isViewedTenant(tenant)) return;
    if (!result.ok || result.data.deleted !== true) {
      setNote(t("factory.backgroundPanel.error.clearReportFailed", { title: job.title ?? job.id, detail: result.ok ? t("factory.backgroundPanel.error.serverNotDeleted") : result.message }));
      return;
    }
    refreshBg();
  };

  const passes = (s: SessionTaskStatus) =>
    filter === "all" ? true : filter === "running" ? s === "running" : filter === "done" ? s === "ok" : s === "error";

  // Stable sort (workers already ordered by recency) → running float to the top, done sink.
  const visibleTasks = sessionTasks.filter((t) => passes(t.status)).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  const visibleRunningCount = visibleTasks.filter((t) => t.status === "running").length;
  const visibleJobs = bg.jobs.filter((j) => passes(j.status === "running" ? "running" : j.status === "done" ? "ok" : "error"));
  // 其它仍在运行、可重连的会话（历史/已完成的去左栏「历史运行」看，别在这里堆）。
  const otherLiveRuns = bg.runs.filter((r) => r.status === "running" && r.live && r.id !== liveRunId && r.id !== viewingRunId);
  const runningCount = sessionTasks.filter((t) => t.status === "running").length + bg.jobs.filter((j) => j.status === "running").length + otherLiveRuns.length;

  return (
    <div
      role="complementary"
      aria-label={t("factory.backgroundPanel.common.backgroundTasks")}
      className={inline ? undefined : "rise"}
      style={inline
        ? { display: "flex", flexDirection: "column" }
        : { position: "fixed", top: 0, right: 0, bottom: 0, width: 400, maxWidth: "92vw", zIndex: "var(--z-overlay)" as unknown as number, background: "var(--panel)", borderLeft: "1px solid var(--border)", boxShadow: "-16px 0 40px rgba(0,0,0,.28)", display: "flex", flexDirection: "column" }}
    >
      {/* #UI-DRAWER — click any task card → its detail drawer (view transcript + 工作流/sub/推理/测试). */}
      {openTask && (
        <AgentDetailDrawer
          task={openTask}
          taskBySlug={taskBySlug}
          onClose={() => setOpenTaskId(null)}
          onSelectAgent={openTask.agentSlug ? (slug) => { setOpenTaskId(null); onSelectAgent(slug); } : undefined}
        />
      )}

      {/* header（浮出模式才有标题/✕；inline 时 报告 按钮并入筛选行） */}
      {!inline && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 14px", borderBottom: "1px solid var(--border)" }}>
          <b style={{ fontSize: 13.5, color: "var(--text)", flex: 1 }}>{t("factory.backgroundPanel.common.backgroundTasks")}</b>
          <Button icon="spark" onClick={() => setShowReportForm((v) => !v)}>{t("factory.backgroundPanel.action.report")}</Button>
          {onClose && <button onClick={onClose} title={t("factory.backgroundPanel.common.closeEsc")} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 17, lineHeight: 1 }}>✕</button>}
        </div>
      )}

      {/* filter strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: inline ? "0 0 9px" : "9px 14px", borderBottom: "1px solid var(--border)" }}>
        {inline && <Button icon="spark" onClick={() => setShowReportForm((v) => !v)}>{t("factory.backgroundPanel.action.report")}</Button>}
        <select value={filter} onChange={(e) => setFilter(e.target.value as FilterKey)} style={{ fontSize: 11.5, padding: "3px 6px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7 }}>
          <option value="all">{t("factory.backgroundPanel.filter.all", { count: sessionTasks.length + bg.jobs.length + otherLiveRuns.length })}</option>
          <option value="running">{t("factory.backgroundPanel.filter.running", { count: runningCount })}</option>
          <option value="done">{t("factory.backgroundPanel.filter.done")}</option>
          <option value="failed">{t("factory.backgroundPanel.filter.failed")}</option>
        </select>
        <span style={{ flex: 1 }} />
        <button onClick={() => void clearFinishedJobs()} disabled={!bg.jobs.some((j) => j.status !== "running")} style={{ ...linkBtn, opacity: bg.jobs.some((j) => j.status !== "running") ? 1 : 0.4 }}>{t("factory.backgroundPanel.action.clear")}</button>
      </div>

      <div style={inline ? { padding: "12px 0 0", display: "flex", flexDirection: "column", gap: 8 } : { flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {note && <div role="alert" style={{ fontSize: 11, color: "var(--red)" }}>{note}</div>}
        {Object.entries(readErrors).map(([surface, message]) => message ? (
          <div key={surface} role="alert" style={{ fontSize: 11, color: "var(--red)" }}>{message}</div>
        ) : null)}

        {/* 协作信号 */}
        {awaitingHint && (
          <div style={{ border: "1px solid var(--amber)", borderRadius: 10, padding: "8px 11px", background: "var(--panel-2)", fontSize: 11.5, color: "var(--amber)", display: "flex", alignItems: "center", gap: 7 }}>
            <span className="health-pulse" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--amber)", display: "inline-block" }} />
            {t("factory.backgroundPanel.signal.awaiting", { hint: awaitingHint })}
          </div>
        )}
        {pending > 0 && <div style={{ fontSize: 11, color: "var(--text-3)", padding: "0 2px" }}>{t("factory.backgroundPanel.signal.interventionQueue", { count: pending })}</div>}

        {/* 报告 quick form */}
        {showReportForm && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "9px 11px", background: "var(--panel-2)", display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>{t("factory.backgroundPanel.report.formPrompt", { domain: domain || "—" })}</div>
            <div style={{ display: "flex", gap: 6 }}>
              {([["html", "HTML"], ["pdf", "PDF"], ["both", t("factory.backgroundPanel.report.formatBoth")]] as Array<["html" | "pdf" | "both", string]>).map(([k, l]) => (
                <button key={k} onClick={() => setReportFormat(k)} style={{ fontSize: 11, padding: "3px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${reportFormat === k ? "var(--signal)" : "var(--border)"}`, background: reportFormat === k ? "var(--panel-3)" : "transparent", color: reportFormat === k ? "var(--text)" : "var(--text-3)" }}>{l}</button>
              ))}
            </div>
            <input value={reportFocus} onChange={(e) => setReportFocus(e.target.value)} placeholder={t("factory.backgroundPanel.report.focusPlaceholder")} style={{ fontSize: 11.5, padding: "6px 9px", background: "var(--panel-3)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7 }} />
            <Button icon="spark" tone="primary" onClick={() => void startReport()} disabled={!domain || reportBusy}>{reportBusy ? t("factory.backgroundPanel.report.starting") : t("factory.backgroundPanel.report.generate")}</Button>
          </div>
        )}

        {/* ── 工作流阶段遥测（Workflow→Phase→Agent，参考 Claude 面板）—— 自门控:无阶段则不显示 ── */}
        <PhaseTimelineView events={events} />

        {/* ── #CHECKLIST — harness 持有的验收清单（finish 尝试后出现;真实证据翻绿）── */}
        <AcceptanceChecklistView events={events} />

        {/* ── 本会话任务（Harness / Agents / Sub-agents / Tools / Sandbox）—— 点卡片进入详情抽屉 ── */}
        {visibleTasks.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 1px", fontSize: 11 }}>
            <span style={{ fontWeight: 600, color: "var(--text-2)" }}>{t("factory.backgroundPanel.session.taskCount", { count: visibleTasks.length })}</span>
            {visibleRunningCount > 0 && (
              <span style={{ color: "var(--signal)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Dot status="running" size={7} />{t("factory.backgroundPanel.session.runningCount", { count: visibleRunningCount })}
              </span>
            )}
          </div>
        )}
        {visibleTasks.map((task) => {
          const toolName = task.toolName ?? "";
          const askThis = task.kind === "tool" && !!toolName && pendingToolNames.has(toolName);
          const libraryTool = askThis
            ? libTools.find((candidate) => candidate.name === toolName)
            : undefined;
          const canDeactivate = Boolean(libraryTool?.activeRevisionId);
          return (
            <div
              key={task.id}
              className="factory-cta"
              role="button"
              tabIndex={0}
              title={t("factory.backgroundPanel.drawer.ariaLabel", { title: task.title })}
              onClick={() => setOpenTaskId(task.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenTaskId(task.id); } }}
              style={{ border: `1px solid ${askThis ? "var(--amber)" : "var(--border)"}`, borderRadius: 10, padding: "9px 11px", background: "var(--panel-2)", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ marginTop: 5 }}><Dot status={task.status} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {KIND_ICON[task.kind]} {task.title}
                  </div>
                  <div style={{ fontSize: 10.5, color: task.kind === "agent" && task.typeLabel.includes("CodeAct") ? "var(--violet)" : "var(--text-3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                    {task.typeLabel} · {task.status === "idle" ? "—" : t(`factory.backgroundPanel.status.${task.status}`)}
                  </div>
                  {task.meta && <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 1 }}>{task.meta}</div>}
                </div>
                <span aria-hidden style={{ color: "var(--text-4)", fontSize: 16, lineHeight: 1, alignSelf: "center", flexShrink: 0 }}>›</span>
              </div>
              {askThis && <div style={{ fontSize: 11, color: "var(--amber)", paddingLeft: 16 }}>{t("factory.backgroundPanel.tool.keepOrDelete")}</div>}
              {askThis && !canDeactivate && (
                <div
                  role="alert"
                  style={{
                    fontSize: 10.5,
                    color: "var(--red)",
                    lineHeight: 1.45,
                    paddingLeft: 16,
                  }}
                >
                  {libraryTool?.deactivationBlocker?.message ??
                    "缺少 managed active revision；需先完成 lifecycle migration，系统不会伪造历史或直接删除。"}
                </div>
              )}
              {askThis && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 16 }}>
                  <button onClick={(e) => { e.stopPropagation(); void acceptTool(toolName); }} style={{ ...linkBtn, border: "1px solid var(--green)", color: "var(--green)" }}>{t("factory.backgroundPanel.tool.keep")}</button>
                  <button
                    disabled={!canDeactivate}
                    title={libraryTool?.deactivationBlocker?.message}
                    onClick={(e) => {
                      e.stopPropagation();
                      void declineTool(toolName);
                    }}
                    style={{
                      ...linkBtn,
                      opacity: canDeactivate ? 1 : 0.45,
                      cursor: canDeactivate ? "pointer" : "not-allowed",
                    }}
                  >
                    停用（保留 revision 历史）
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {sessionTasks.length === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--text-4)", padding: 8, display: "flex", alignItems: "center", gap: 6 }}>{t("factory.backgroundPanel.session.emptyState")} <HelpTip>{t("factory.backgroundPanel.session.emptyHelp")}</HelpTip></div>
        )}

        {/* ── 跨会话后台：报告任务 + 其它运行中的会话 ── */}
        {(visibleJobs.length > 0 || otherLiveRuns.length > 0) && (
          <div style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 2px 0" }}>{t("factory.backgroundPanel.crossSession.header")}</div>
        )}
        {visibleJobs.map((j) => {
          const st: SessionTaskStatus = j.status === "running" ? "running" : j.status === "done" ? "ok" : "error";
          return (
            <div key={j.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "9px 11px", background: "var(--panel-2)", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ marginTop: 5 }}><Dot status={st} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>📊 {j.title ?? t("factory.backgroundPanel.report.jobFallbackTitle", { name: j.domainName ?? j.domain })}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                    {t("factory.backgroundPanel.report.typeLabel")} · {t(`factory.backgroundPanel.status.${st}`)} · {j.format.toUpperCase()} · {timeOf(j.createdAt, locale)}{durOf(j.createdAt, j.finishedAt) ? ` · ${durOf(j.createdAt, j.finishedAt)}` : ""}
                  </div>
                </div>
              </div>
              {st === "running" && <div style={{ fontSize: 11, color: "var(--signal)", paddingLeft: 16 }}>⏳ {j.phase ?? t("factory.backgroundPanel.report.runningPhase")}…</div>}
              {j.status === "error" && <div style={{ fontSize: 11, color: "var(--red)", paddingLeft: 16 }}>{j.error}</div>}
              {j.note && <div style={{ fontSize: 11, color: "var(--amber)", paddingLeft: 16 }}>{j.note}</div>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 16 }}>
                {j.artifacts.map((a) => (
                  <button key={a.id} onClick={() => void downloadArtifact(a, j.title ?? `${j.domainName ?? j.domain}-report`)} style={primaryLinkBtn}>
                    ⬇ {a.label} · {Math.max(1, Math.round(a.size / 1024))}KB
                  </button>
                ))}
                {st !== "running" && <button onClick={() => void clearReportJob(j)} style={linkBtn}>{t("factory.backgroundPanel.action.clear")}</button>}
              </div>
            </div>
          );
        })}
        {otherLiveRuns.map((r) => (
          <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "9px 11px", background: "var(--panel-2)", display: "flex", alignItems: "center", gap: 8 }}>
            <Dot status="running" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>⚙ {r.goal || t("factory.backgroundPanel.run.noGoal")}</div>
              <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{t("factory.backgroundPanel.run.otherSession")} · {r.domain} · {r.agentsCount} agent · {Math.round((r.tokensUsed ?? 0) / 1000)}k tok · {timeOf(r.createdAt, locale)}</div>
            </div>
            <button onClick={() => onReconnectRun(r.id)} style={primaryLinkBtn}>{t("factory.backgroundPanel.run.connectView")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
