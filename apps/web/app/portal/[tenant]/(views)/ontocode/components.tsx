"use client";

/**
 * OntoCode — presentational components (v10 light style, `.oc` scope).
 *
 * Everything here is a pure render of oc-model / factory-model projections;
 * page.tsx owns all data + handlers. Copy is intentionally literal Chinese for
 * P0 (i18n extraction tracked in the integration plan).
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { HelpTip } from "@/app/portal/components";
import type { AgentFactoryDomain } from "@/lib/domain-display";
import type { Translate } from "@/app/portal/lib/preferences-context";
import {
  draftSystemProfile,
  markSystemHumanBoundary,
  markSystemLive,
  markSystemPlanned,
  probeSystemConnection,
  saveSystemProfile,
  type SystemCoverage,
  type SystemCoverageRow,
  type SystemProfileDoc,
} from "./oc-api";
import type { AgentCardData, SandboxEvidenceStatus } from "../factory/model";
import type { BrainStep } from "../factory/model";
import {
  deriveBuildStages,
  linearizeFlow,
  presentTodo,
  todoTierCounts,
  type ExecLineState,
  type FlowGraphData,
  type NextStep,
  type OntoCodeBuildContext,
  type ResolvedGate,
  type TodoItem,
} from "./oc-model";

function useDialogEscape(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

// ── 域菜单（顶栏 chip 下拉：切换绑定 / 上传 / 删除上传域） ─────────────────────

export function OcDomainMenu({
  domains,
  boundId,
  uploadedIds,
  busy,
  onBind,
  onDeleteUpload,
  onUpload,
  onClose,
}: {
  domains: AgentFactoryDomain[];
  boundId: string | null;
  uploadedIds: Set<string>;
  busy: boolean;
  onBind: (id: string) => void;
  onDeleteUpload: (id: string, name: string) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  useDialogEscape(onClose);
  return (
    <>
      <button
        type="button"
        className="oc-menuscrim"
        onClick={onClose}
        aria-label="关闭 Ontology 域菜单"
      />
      <div className="oc-domainmenu" role="menu" aria-label="Ontology 域">
        <div className="cap">
          业务域
          <HelpTip>点击绑定；切换会开始新会话。</HelpTip>
        </div>
        {domains.length === 0 && <div className="oc-empty">暂无可用域——先上传 Ontology JSON</div>}
        {domains.map((d) => (
          <div className={`oc-domrow${d.id === boundId ? " on" : ""}`} key={d.id}>
            <button type="button" className="oc-dommain" disabled={busy} onClick={() => onBind(d.id)}>
              {d.id === boundId ? "● " : ""}{d.name ?? d.id}
              <span className="meta">
                {d.id}
                {d.counts ? ` · ${d.counts.actions ?? 0} 动作 · ${d.counts.rules ?? 0} 规则` : ""}
                {uploadedIds.has(d.id) ? " · 上传域" : ""}
              </span>
            </button>
            {uploadedIds.has(d.id) && (
              <button
                type="button"
                className="oc-domdel"
                title="删除此上传域"
                disabled={busy}
                onClick={() => onDeleteUpload(d.id, d.name ?? d.id)}
              >
                🗑
              </button>
            )}
          </div>
        ))}
        <div className="cap" style={{ borderTop: "1px solid var(--oc-border)", marginTop: 4, paddingTop: 8 }}>
          导入
        </div>
        <div className="oc-domrow">
          <button
            type="button"
            className="oc-dommain"
            disabled={busy}
            onClick={onUpload}
            title="JSON 带 actions/events/rules/dataObjects 自动建域或并入当前域"
          >
            ⬆ 上传 Ontology JSON…
          </button>
        </div>
      </div>
    </>
  );
}

// ── 执行行 ────────────────────────────────────────────────────────────────────

export function OcExecLine({
  exec,
  tokens,
  onOpenRail,
}: {
  exec: ExecLineState;
  tokens: number | null;
  onOpenRail: () => void;
}) {
  if (exec.state === "idle") return null;
  return (
    <div className={`oc-exec ${exec.state}`}>
      {exec.state === "running" ? <span className="spin" /> : exec.state === "error" ? "✕" : "✓"}
      <span>{exec.text}</span>
      <span className="meta">
        {exec.agentCount > 0 ? `${exec.agentCount} agents · ` : ""}
        {exec.toolCount} 次工具调用
        {tokens != null ? ` · ${Math.max(1, Math.round(tokens / 1000))}k tokens` : ""}
      </span>
      <button type="button" className="oc-ghost raillink" style={{ border: "none", padding: 0 }} onClick={onOpenRail}>
        查看构建状态
      </button>
    </div>
  );
}

// ── 事件与业务流（v10：业务阶段带 + 节点卡图，均由 trigger/emit 真实派生） ────────

export function OcFlowStrip({
  graph,
  onNode,
  highlight,
}: {
  graph: FlowGraphData;
  onNode: (slug: string) => void;
  highlight: string | null;
}) {
  const rows = useMemo(() => linearizeFlow(graph), [graph]);
  if (!graph.nodes.length) return null;
  const nodeOf = (slug: string) => graph.nodes.find((n) => n.slug === slug);
  const edgeEvent = (from: string, to: string) =>
    graph.edges.find((e) => e.from === from && e.to === to)?.event;
  const entryOf = (slug: string) => graph.entryEvents.find((e) => e.to === slug)?.event;
  const terminalsOf = (slug: string) => graph.terminalEvents.filter((e) => e.from === slug);
  const ribbon = rows[0] ?? [];
  return (
    <details className="oc-flow" open>
      <summary>事件与业务流</summary>
      <div className="oc-flowbody">
        {ribbon.length > 1 && (
          <div className="oc-ribbon">
            {ribbon.map((slug, i) => (
              <Fragment key={slug}>
                {i > 0 && <span className="sep">→</span>}
                <button
                  type="button"
                  className={`rib${highlight === slug ? " hl" : ""}`}
                  onClick={() => onNode(slug)}
                >
                  {nodeOf(slug)?.name ?? slug}
                </button>
              </Fragment>
            ))}
          </div>
        )}
        {rows.map((row, ri) => (
          <div className="oc-flowline" key={ri} style={ri ? { marginTop: 14 } : undefined}>
            {row.map((slug, i) => {
              const prev = i > 0 ? row[i - 1]! : null;
              const entry = i === 0 ? entryOf(slug) : null;
              const ev = prev ? edgeEvent(prev, slug) : null;
              const terms = i === row.length - 1 ? terminalsOf(slug) : [];
              const node = nodeOf(slug);
              return (
                <Fragment key={`${slug}-${i}`}>
                  {entry && (
                    <>
                      <span className="oc-fev entry">⚡ {entry}</span>
                      <span className="oc-farrow">→</span>
                    </>
                  )}
                  {ev && (
                    <>
                      <span className="oc-farrow">→</span>
                      <span className="oc-fev">{ev}</span>
                      <span className="oc-farrow">→</span>
                    </>
                  )}
                  <button
                    type="button"
                    className={`oc-fnodebox${highlight === slug ? " hl" : ""}`}
                    onClick={() => onNode(slug)}
                  >
                    <span className="nm">{slug}</span>
                    <span className="tr">⚡ {node?.trigger[0] ?? "—"}</span>
                  </button>
                  {terms.map((tm) => (
                    <Fragment key={tm.event}>
                      <span className="oc-farrow">→</span>
                      <span className="oc-fterm">↦ {tm.event}</span>
                    </Fragment>
                  ))}
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}

// ── 已决事项（闭环三态的绿色归档条） ──────────────────────────────────────────

export function OcResolvedStrip({ items }: { items: ResolvedGate[] }) {
  if (!items.length) return null;
  const shown = items.slice(-3).reverse();
  return (
    <div className="oc-resolved">
      {shown.map((g) => (
        <div className="row" key={g.id}>
          <span className="tick">✓</span>
          <span className="ttl">{g.title}</span>
          <span className="tag">已决</span>
        </div>
      ))}
      {items.length > 3 && (
        <div className="more">共 {items.length} 项</div>
      )}
    </div>
  );
}

// ── agent 卡片 ───────────────────────────────────────────────────────────────

function decisionSteps(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function OcAgentCard({
  agent,
  open,
  onToggle,
  statusChip,
  sandboxEvidence,
}: {
  agent: AgentCardData;
  open: boolean;
  onToggle: () => void;
  statusChip: { label: string; tone: "ok" | "warn" | "bad" | "dim" };
  sandboxEvidence: SandboxEvidenceStatus;
}) {
  const steps = decisionSteps(agent.decisionLogic);
  const [tab, setTab] = useState<"logic" | "contracts" | "code" | "tests">("code");
  const panelId = `oc-agent-panel-${agent.slug}`;
  const evidenceCopy =
    sandboxEvidence === "real"
      ? { title: "沙箱真跑通过", detail: "本次套件已有真实执行证据，可继续部署审查。", tone: "ok" as const }
      : sandboxEvidence === "simulated_only"
        ? { title: "仅有模拟证据", detail: "模拟结果不能作为部署依据，需要完成一次真实沙箱运行。", tone: "bad" as const }
        : { title: "等待沙箱证据", detail: "生成完成后会自动执行测试，并在这里回填结果。", tone: "dim" as const };
  return (
    <div className={`oc-card${open ? " open" : ""}`} id={`oc-agent-${agent.slug}`}>
      <button
        type="button"
        className="oc-cardhead"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="nm">{agent.slug}</span>
        {agent.nameZh && <span className="zh">{agent.nameZh}</span>}
        <span className={`oc-badge ${statusChip.tone}`}>{statusChip.label}</span>
        <span className="chev">{open ? "▲" : "▼"}</span>
      </button>
      <div className="oc-wire">
        <span className="ev">⚡ {agent.trigger.join(", ") || "—"}</span>
        {" → "}
        {agent.actionName || agent.short}
        {" → "}
        <span className="em">↦ {agent.emit.join(", ") || "—"}</span>
      </div>
      {open && (
        <div className="oc-cardbody" id={panelId}>
          <div className="oc-artifact-tabs" role="tablist" aria-label={`${agent.slug} 产物`}>
            {([
              ["code", "代码"],
              ["contracts", "契约"],
              ["tests", "测试证据"],
              ["logic", "业务逻辑"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "on" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="oc-artifact-panel" role="tabpanel">
            {tab === "code" && (
              agent.code ? (
                <div>
                  <div className="oc-secttl">可执行代码 · {agent.codeSource ?? "generated"}</div>
                  <pre className="oc-code" style={{ marginTop: 6 }}>{agent.code}</pre>
                </div>
              ) : (
                <div className="oc-artifact-empty">
                  <b>代码未回填</b>
                </div>
              )
            )}

            {tab === "contracts" && (
              <dl className="oc-contracts">
                <div>
                  <dt>Ontology Action</dt>
                  <dd>{agent.actionName || agent.short || agent.slug}</dd>
                </div>
                <div>
                  <dt>输入事件</dt>
                  <dd>{agent.trigger.join("、") || "—"}</dd>
                </div>
                <div>
                  <dt>输出事件</dt>
                  <dd>{agent.emit.join("、") || "—"}</dd>
                </div>
                <div>
                  <dt>允许调用的工具</dt>
                  <dd>{agent.tools.join("、") || "无需外部工具"}</dd>
                </div>
              </dl>
            )}

            {tab === "tests" && (
              <div className="oc-test-evidence">
                <span className={`oc-badge ${evidenceCopy.tone}`}>{evidenceCopy.title}</span>
                <p>{evidenceCopy.detail}</p>
                <div className="oc-evidence-row">
                  <span>{agent.codeExecuted ? "✓" : "○"}</span>
                  <span>{agent.codeExecuted ? "生成代码已执行" : "等待生成代码执行探针"}</span>
                </div>
                {agent.probeReason && <div className="oc-evidence-note">{agent.probeReason}</div>}
              </div>
            )}

            {tab === "logic" && (
              <>
                {steps.length > 0 ? (
                  <div className="oc-steps">
                    {steps.map((step, i) => (
                      <div className="oc-step" key={i}>
                        <span className="n">{i + 1}</span>
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="oc-artifact-empty">暂无逻辑</div>
                )}
                {agent.tools.length > 0 && (
                  <div className="oc-toolchips">
                    {agent.tools.map((tool) => <span className="oc-tc" key={tool}>{tool}</span>)}
                  </div>
                )}
                {agent.systemPrompt && (
                  <details>
                    <summary className="oc-secttl">查看系统提示词</summary>
                    <div className="oc-prompt-preview">{agent.systemPrompt}</div>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 待你决定 ─────────────────────────────────────────────────────────────────

export function OcTodoQueue({
  todos,
  onHandle,
  onQuickAnswer,
  onOpenIntegrations,
  onOpenWorkbench,
  sendingId,
}: {
  todos: TodoItem[];
  onHandle: (todo: TodoItem) => void;
  /** 行内直接点推荐/备选 = 一次点击完成作答（仅 clarify 类）。 */
  onQuickAnswer: (todo: TodoItem, answerLabel: string) => void;
  /** 凭证类 todo：带 provider 提示则深链到对应编辑器。 */
  onOpenIntegrations: (provider?: string) => void;
  /** 凭证类但提不出 provider = 缺口在系统层，去工作台建档/绑定。 */
  onOpenWorkbench: () => void;
  sendingId: string | null;
}) {
  const [open, setOpen] = useState(true);
  if (!todos.length) return null;
  const counts = todoTierCounts(todos);
  const kindLabel: Record<TodoItem["kind"], string> = {
    clarify: "澄清",
    test_approval: "测试用例批准",
    boundary: "边界事件分类",
  };
  return (
    <div className="oc-todos">
      <button
        type="button"
        className="oc-todohead"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="qmark">?</span>
        <b>待你决定 · {todos.length}</b>
        <span className="sub">
          {counts.required > 0 ? `${counts.required} 必填` : ""}
          {counts.required > 0 && counts.recommended > 0 ? " · " : ""}
          {counts.recommended > 0 ? `${counts.recommended} 可推荐` : ""}
        </span>
        <span className="chev">{open ? "⌄" : "›"}</span>
      </button>
      {open && todos.map((todo) => {
        const p = presentTodo(todo);
        const sending = sendingId === todo.id;
        return (
          <div className={`oc-todorow tier-${p.tier}${sending ? " sending" : ""}`} key={todo.id}>
            <span className={`oc-tier ${p.tier}`}>
              {todo.credentialLike ? "必填" : p.tier === "recommended" ? "可推荐" : "必答"}
            </span>
            <span className="q">
              {p.shortTitle}
              <span className="why">
                {p.sourceHint ? `溯源：${p.sourceHint}` : kindLabel[todo.kind]}
              </span>
            </span>
            <span className="acts">
              {sending ? (
                <span className="pending">已提交…</span>
              ) : (
                <>
                  {todo.credentialLike && (
                    todo.providerHint ? (
                      <button type="button" className="oc-act primary-red" onClick={() => onOpenIntegrations(todo.providerHint!)}>
                        去配置 {todo.providerHint} →
                      </button>
                    ) : (
                      <button type="button" className="oc-act primary-red" onClick={onOpenWorkbench}
                        title="这个凭证缺口需要先在工作台为对应系统建档/绑定，再配凭证">
                        去工作台连接 →
                      </button>
                    )
                  )}
                  {todo.kind === "clarify" && p.inlineOptions.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      className={`oc-act${opt.recommended ? " primary-green" : ""}`}
                      onClick={() => onQuickAnswer(todo, opt.label)}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button type="button" className="oc-act ghost" onClick={() => onHandle(todo)}>
                    {todo.kind === "clarify" && (p.truncated || !p.inlineOptions.length) ? "处理 →" : todo.kind === "clarify" ? "更多…" : "处理 →"}
                  </button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── 动态配置覆盖层 ────────────────────────────────────────────────────────────

export function OcConfigOverlay({
  todo,
  busy,
  impact,
  onClose,
  onClarify,
  onTest,
  onBoundary,
}: {
  todo: TodoItem;
  busy: boolean;
  impact: string[];
  onClose: () => void;
  onClarify: (answer: string) => void;
  onTest: (decision: "approve" | "regenerate", note?: string) => void;
  onBoundary: (
    events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>,
  ) => void;
}) {
  useDialogEscape(onClose);
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string | null>(
    todo.options?.find((o) => o.recommended)?.value ?? null,
  );
  const [note, setNote] = useState("");
  const [kinds, setKinds] = useState<Record<string, string>>(() =>
    Object.fromEntries((todo.proposals ?? []).map((p) => [p.event, p.suggestedKind])),
  );
  const [consumers, setConsumers] = useState<Record<string, string>>(() =>
    Object.fromEntries((todo.proposals ?? []).map((p) => [p.event, p.consumer ?? ""])),
  );

  const kindLabels: Record<TodoItem["kind"], string> = {
    clarify: "补充信息",
    test_approval: "沙箱测试用例",
    boundary: "边界事件分类",
  };

  return (
    <>
      <button type="button" className="oc-scrim" onClick={onClose} aria-label="关闭配置面板" />
      <aside
        className="oc-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={kindLabels[todo.kind]}
        tabIndex={-1}
        autoFocus
      >
        <div className="oc-ovhead">
          <h3>{kindLabels[todo.kind]}</h3>
          <div className="ctx">
            {todo.title}
            {impact.length > 0 && (
              <>
                <br />
                影响：{impact.join(" · ")}
              </>
            )}
          </div>
        </div>

        <div className="oc-ovbody">
          {todo.kind === "clarify" && (
            <>
              {todo.credentialLike && (
                <div className="oc-caserow" style={{ borderColor: "var(--oc-amber)" }}>
                  <span className="k">凭证类问题</span>
                  <div className="d">
                    写副作用凭证不能替你猜——去 Settings → Integrations
                    配置真实凭证，或在下方给替代方案。
                  </div>
                </div>
              )}
              {(todo.options ?? []).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`oc-opt${selected === opt.value ? " sel" : opt.recommended ? " rec" : ""}`}
                  onClick={() => { setSelected(opt.value); setCustom(""); }}
                >
                  {opt.label}
                  {opt.recommended && <span className="tag">推荐</span>}
                </button>
              ))}
              <textarea
                className="oc-textarea"
                placeholder="或自定义回答…"
                value={custom}
                onChange={(e) => { setCustom(e.target.value); if (e.target.value.trim()) setSelected(null); }}
              />
            </>
          )}

          {todo.kind === "test_approval" && (
            <>
              {(todo.cases ?? []).map((c) => (
                <div className="oc-caserow" key={c.id}>
                  <span className="k">{c.entryEvent}</span> <b style={{ fontSize: 12.5 }}>{c.name}</b>
                  <span className="oc-badge dim" style={{ marginLeft: 8 }}>{c.kind}</span>
                  <div className="d">{c.scenario} → 期望：{c.expectedOutcome}</div>
                </div>
              ))}
              {todo.coverage && todo.coverage.uncoveredNeedingData.length > 0 && (
                <div className="oc-caserow" style={{ borderColor: "var(--oc-amber)" }}>
                  <span className="k">覆盖缺口</span>
                  <div className="d">{todo.coverage.uncoveredNeedingData.join("、")} 需要补充数据（可在高级模式上传夹具）</div>
                </div>
              )}
              <textarea
                className="oc-textarea"
                placeholder="重新生成时的备注（可选）…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}

          {todo.kind === "boundary" && (
            <>
              {(todo.proposals ?? []).map((p) => (
                <div className="oc-caserow" key={p.event}>
                  <span className="k">{p.event}</span>
                  <div className="d">{p.why} · 产出方：{p.producers.join(", ") || "—"}</div>
                  <div style={{ marginTop: 7, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="oc-seg">
                      {(["terminal", "external", "break"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={kinds[p.event] === k ? "on" : ""}
                          onClick={() => setKinds((m) => ({ ...m, [p.event]: k }))}
                        >
                          {k === "terminal" ? "业务终点" : k === "external" ? "外部消费" : "断链需修"}
                        </button>
                      ))}
                    </span>
                    {kinds[p.event] === "external" && (
                      <input
                        className="oc-textarea"
                        style={{ minHeight: 0, padding: "6px 10px", flex: 1, minWidth: 140 }}
                        placeholder="消费方（系统/服务名）"
                        value={consumers[p.event] ?? ""}
                        onChange={(e) => setConsumers((m) => ({ ...m, [p.event]: e.target.value }))}
                      />
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="oc-ovfoot">
          {todo.kind === "clarify" && (
            <button
              type="button"
              className="oc-primary"
              disabled={busy || (!custom.trim() && !selected)}
              onClick={() => {
                const answer = custom.trim()
                  || todo.options?.find((o) => o.value === selected)?.label
                  || selected
                  || "";
                onClarify(answer);
              }}
            >
              {busy ? "提交中…" : "提交回答"}
            </button>
          )}
          {todo.kind === "test_approval" && (
            <>
              <button type="button" className="oc-primary" disabled={busy} onClick={() => onTest("approve")}>
                {busy ? "提交中…" : "批准并执行"}
              </button>
              <button type="button" className="oc-ghost" disabled={busy} onClick={() => onTest("regenerate", note.trim() || undefined)}>
                重新生成用例
              </button>
            </>
          )}
          {todo.kind === "boundary" && (
            <button
              type="button"
              className="oc-primary"
              disabled={busy}
              onClick={() =>
                onBoundary(
                  (todo.proposals ?? []).map((p) => ({
                    event: p.event,
                    kind: kinds[p.event] ?? p.suggestedKind,
                    ...(kinds[p.event] === "external" && consumers[p.event]?.trim()
                      ? { consumer: consumers[p.event]!.trim() }
                      : {}),
                    ...(p.payloadContract ? { payloadContract: p.payloadContract } : {}),
                  })),
                )
              }
            >
              {busy ? "提交中…" : "提交分类"}
            </button>
          )}
          <button type="button" className="oc-ghost" onClick={onClose}>返回</button>
        </div>
      </aside>
    </>
  );
}

// ── 右栏（构建摘要 / 诊断） ────────────────────────────────────────────────────

export function OcSessionRail({
  steps,
  context,
  logLines,
  tab,
  onTab,
  collapsed,
  onToggleCollapse,
  hasAwait,
  onJumpInteraction,
  onExport,
}: {
  steps: BrainStep[];
  context: OntoCodeBuildContext;
  logLines: string[];
  tab: "build" | "diagnostics";
  onTab: (t: "build" | "diagnostics") => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  hasAwait: boolean;
  onJumpInteraction: (interactionId: string) => void;
  onExport: (() => void) | null;
}) {
  const stages = useMemo(() => deriveBuildStages(steps), [steps]);
  if (collapsed) {
    return (
      <aside className="oc-rail" aria-label="构建与诊断">
        <button
          type="button"
          className="oc-railslim"
          onClick={onToggleCollapse}
          title="展开构建与诊断"
          aria-label="展开构建与诊断"
          aria-expanded="false"
        >
          <span>◧</span>
          {hasAwait && <span className="dotwarn" title="有待你决定的事项" />}
          <span style={{ writingMode: "vertical-rl", fontSize: 11 }}>构建 · 诊断</span>
        </button>
      </aside>
    );
  }
  return (
    <aside className="oc-rail" aria-label="构建与诊断">
      <div className="oc-railtabs">
        <button type="button" className={tab === "build" ? "on" : ""} onClick={() => onTab("build")}>
          构建
        </button>
        <button type="button" className={tab === "diagnostics" ? "on" : ""} onClick={() => onTab("diagnostics")}>
          诊断
        </button>
        <button
          type="button"
          className="fold"
          onClick={onToggleCollapse}
          title="折叠"
          aria-label="折叠构建与诊断"
          aria-expanded="true"
        >
          ⇥
        </button>
      </div>
      <div className="oc-railbody">
        {tab === "build" ? (
          <>
            {(context.actionIds.length > 0 || context.scenario || context.virtualAction) && (
              <div className="oc-build-context">
                <div className="oc-secttl">本次来源范围</div>
                {context.actionIds.length > 0 && (
                  <div className="scope-row">
                    <span className="oc-badge ok">Ontology Action</span>
                    <span>{context.actionIds.join("、")}</span>
                  </div>
                )}
                {context.virtualAction && (
                  <div className="scope-row">
                    <span className="oc-badge warn">场景型</span>
                    <span>{context.virtualAction.name} · 不回写 Ontology</span>
                  </div>
                )}
                {context.scenario && (
                  <div className="scenario" title={context.scenario}>{context.scenario}</div>
                )}
              </div>
            )}
            {context.assumptions.length > 0 && (
              <details className="oc-assumptions">
                <summary>已自动采用 {context.assumptions.length} 项安全假设</summary>
                <ul>
                  {context.assumptions.slice(-5).map((assumption) => (
                    <li key={assumption.id} title={assumption.detail ?? assumption.gate ?? undefined}>
                      {assumption.summary}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {stages.length ? (
              <div className="oc-tl">
                {stages.map((stage) => (
                  <div className="oc-tlrow" key={stage.id}>
                    <span className={`oc-tldot ${stage.status}`} />
                    <span className="oc-tltxt">
                      {stage.interactionId && stage.status === "await" ? (
                        <button
                          type="button"
                          className="lb link"
                          onClick={() => onJumpInteraction(stage.interactionId!)}
                        >
                          {stage.label}
                        </button>
                      ) : (
                        <span className="lb">{stage.label}</span>
                      )}
                      <span className="dt">
                        {" · "}
                        {stage.status === "ok"
                          ? "完成"
                          : stage.status === "fail"
                            ? "失败"
                            : stage.status === "await"
                              ? "需要处理"
                              : "进行中"}
                        {stage.count > 1 ? ` · ${stage.count} 项` : ""}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="oc-empty">暂无阶段</div>
            )}
          </>
        ) : (
          <>
            {logLines.length ? (
              <div className="oc-lograil">{logLines.join("\n")}</div>
            ) : (
              <div className="oc-empty">暂无诊断日志</div>
            )}
            {steps.length > 0 && (
              <details className="oc-diagnostic-steps">
                <summary>阶段事件 · {steps.length}</summary>
                <div className="oc-tl">
                  {steps.map((step) => (
                    <div className="oc-tlrow" key={step.id}>
                      <span className={`oc-tldot ${step.status}`} />
                      <span className="oc-tltxt">
                        <span className="lb">{step.label}</span>
                        {step.detail && <span className="dt"> · {step.detail}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
      <div className="oc-railfoot">
        <span />
        {onExport && (
          <button type="button" className="oc-export" onClick={onExport} title="下载本次构建事件（交接/审计用）">
            导出 ↧
          </button>
        )}
      </div>
    </aside>
  );
}

// ── 外部系统档案面板（Platform-Smith：文档→档案草稿→人审入库） ─────────────────

export function OcSystemProfilesPanel({
  profiles,
  busy,
  error,
  onClose,
  onDraft,
  onSave,
  onDelete,
  draft,
  onDraftChange,
}: {
  profiles: SystemProfileDoc[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDraft: (input: { text?: string; url?: string; hint?: string }) => void;
  onSave: (profileJson: string) => void;
  onDelete: (profileId: string, name: string) => void;
  /** 当前待确认的草稿 JSON（可编辑）；null = 无草稿。 */
  draft: string | null;
  onDraftChange: (value: string) => void;
}) {
  useDialogEscape(onClose);
  const [docText, setDocText] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [hint, setHint] = useState("");
  return (
    <>
      <button type="button" className="oc-scrim" onClick={onClose} aria-label="关闭外部系统档案" />
      <aside
        className="oc-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="外部系统档案"
        tabIndex={-1}
        autoFocus
      >
        <div className="oc-ovhead">
          <h3>
            外部系统档案
            <HelpTip>
              每个外部平台一份机器可读声明（别名 · api/事件/数据能力 ·
              凭证引用）——是集成绑定的权威来源。AI 起草，你确认后生效。
            </HelpTip>
          </h3>
        </div>
        <div className="oc-ovbody">
          <div className="oc-secttl">已建档 · {profiles.length}</div>
          {profiles.length === 0 && <div className="oc-empty">尚无档案</div>}
          {profiles.map((p) => (
            <div className="oc-caserow" key={p.id}>
              <b style={{ fontSize: 13 }}>{p.name}</b>
              {p.governance?.humanBoundary && (
                <span className="oc-badge warn" style={{ marginLeft: 8 }}>人工边界</span>
              )}
              <div className="d" title={`来源:${p.provenance.mode}`}>
                别名：{p.aliases.join("、") || "—"} · api {p.capabilities.api.length} · 事件 {p.capabilities.events.length} · 数据 {p.capabilities.data.length}
                {p.credential?.provider ? ` · 凭证:${p.credential.provider}` : ""}
              </div>
              <div style={{ marginTop: 6 }}>
                <button type="button" className="oc-ghost" disabled={busy} onClick={() => onDelete(p.id, p.name)}>
                  删除
                </button>
              </div>
            </div>
          ))}

          <div className="oc-secttl" style={{ marginTop: 6 }}>起草档案</div>
          <textarea
            className="oc-textarea"
            style={{ minHeight: 90 }}
            placeholder="粘贴平台对接文档 / API 规范 / 事件契约……（粘贴一份档案 JSON 则直接导入待确认）"
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="oc-textarea"
              style={{ minHeight: 0, padding: "7px 11px", flex: 1, minWidth: 160 }}
              placeholder="或文档 URL（公网）"
              value={docUrl}
              onChange={(e) => setDocUrl(e.target.value)}
            />
            <input
              className="oc-textarea"
              style={{ minHeight: 0, padding: "7px 11px", flex: 1, minWidth: 140 }}
              placeholder="平台提示（可选，如：RAAS 招聘平台）"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
            <button
              type="button"
              className="oc-primary"
              disabled={busy || (!docText.trim() && !docUrl.trim())}
              onClick={() => onDraft({
                ...(docText.trim() ? { text: docText.trim() } : {}),
                ...(docUrl.trim() ? { url: docUrl.trim() } : {}),
                ...(hint.trim() ? { hint: hint.trim() } : {}),
              })}
            >
              {busy ? "起草中…" : "起草档案"}
            </button>
          </div>

          {draft !== null && (
            <>
              <div className="oc-secttl" style={{ marginTop: 6 }}>草稿</div>
              <textarea
                className="oc-textarea"
                style={{ minHeight: 200, fontFamily: "var(--oc-mono)", fontSize: 11.5 }}
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
              />
            </>
          )}
          {error && <div className="oc-exec error">✕ {error}</div>}
        </div>
        <div className="oc-ovfoot">
          {draft !== null && (
            <button type="button" className="oc-primary" disabled={busy} onClick={() => onSave(draft)}>
              {busy ? "保存中…" : "确认并入库"}
            </button>
          )}
          <button type="button" className="oc-ghost" onClick={onClose}>关闭</button>
        </div>
      </aside>
    </>
  );
}

// ── Tool-Smith 覆盖层（📎 工具文档 → 提炼声明式工具 → 入库） ────────────────────

export function OcToolSmithOverlay({
  docName,
  busy,
  error,
  draft,
  onDraftChange,
  onDraft,
  onSave,
  onClose,
}: {
  docName: string;
  busy: boolean;
  error: string | null;
  draft: string | null;
  onDraftChange: (value: string) => void;
  onDraft: (intent: string) => void;
  onSave: (draftJson: string) => void;
  onClose: () => void;
}) {
  useDialogEscape(onClose);
  const [intent, setIntent] = useState("");
  return (
    <>
      <button type="button" className="oc-scrim" onClick={onClose} aria-label="关闭工具提炼面板" />
      <aside
        className="oc-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="从文档提炼工具"
        tabIndex={-1}
        autoFocus
      >
        <div className="oc-ovhead">
          <h3>
            从文档提炼工具
            <HelpTip>
              提炼出的声明式工具入库后立即出现在工具目录，成为集成绑定的候选实现。AI
              起草，你确认后入库。
            </HelpTip>
          </h3>
          <div className="ctx">文档：{docName}</div>
        </div>
        <div className="oc-ovbody">
          <div className="oc-secttl">工具用途</div>
          <input
            className="oc-textarea"
            style={{ minHeight: 0, padding: "8px 12px" }}
            placeholder="例：调用背调 API 提交候选人背调请求"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
          />
          <button
            type="button"
            className="oc-primary"
            style={{ alignSelf: "flex-start" }}
            disabled={busy || !intent.trim()}
            onClick={() => onDraft(intent.trim())}
          >
            {busy ? "提炼中…" : "从文档提炼契约"}
          </button>
          {draft !== null && (
            <>
              <div className="oc-secttl">草稿</div>
              <textarea
                className="oc-textarea"
                style={{ minHeight: 220, fontFamily: "var(--oc-mono)", fontSize: 11.5 }}
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
              />
            </>
          )}
          {error && <div className="oc-exec error">✕ {error}</div>}
        </div>
        <div className="oc-ovfoot">
          {draft !== null && (
            <button type="button" className="oc-primary" disabled={busy} onClick={() => onSave(draft)}>
              {busy ? "入库中…" : "确认并入库"}
            </button>
          )}
          <button type="button" className="oc-ghost" onClick={onClose}>关闭</button>
        </div>
      </aside>
    </>
  );
}

// ── 系统连接工作台（派生系统逐条决定 + 连接成熟度阶梯 + 内联 AI 建档） ─────────────

type ConnectStage = "unprofiled" | "profiled" | "tool" | "credential" | "ready" | "verified" | "boundary" | "runtime" | "planned";

function stageOf(row: SystemCoverageRow): { stage: ConnectStage; label: string; tone: "dim" | "blue" | "amber" | "green" | "purple" } {
  if (row.runtimeProvided) return { stage: "runtime", label: "运行时提供 ✓", tone: "green" };
  if (row.availability === "planned") {
    return row.plannedFallback === "human_boundary"
      ? { stage: "planned", label: "规划中 · 按人工边界", tone: "purple" }
      : { stage: "planned", label: "规划中 · 阻断部署", tone: "amber" };
  }
  if (row.humanBoundary) return { stage: "boundary", label: "人工边界", tone: "purple" };
  if (!row.profileId) return { stage: "unprofiled", label: "未建档", tone: "dim" };
  if (row.probeOk === true) return { stage: "verified", label: "连接已验 ✓", tone: "green" };
  if (row.credentialProvider && row.credentialConfigured) return { stage: "ready", label: "凭证已配 · 待验证", tone: "green" };
  if (row.hasTool && row.credentialProvider) return { stage: "credential", label: "缺凭证", tone: "amber" };
  if (row.hasTool) return { stage: "tool", label: "已连工具", tone: "blue" };
  return { stage: "profiled", label: "已建档", tone: "blue" };
}

export function OcSystemWorkbench({
  t,
  tenant,
  coverage,
  onClose,
  onChanged,
  onOpenIntegrations,
}: {
  t: Translate;
  tenant: string;
  coverage: SystemCoverage;
  onClose: () => void;
  onChanged: () => void;
  onOpenIntegrations: (provider?: string) => void;
}) {
  useDialogEscape(onClose);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busySystem, setBusySystem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // per-system AI-draft + probe state
  const [docText, setDocText] = useState<Record<string, string>>({});
  const [draftJson, setDraftJson] = useState<Record<string, string>>({});
  const [probeResult, setProbeResult] = useState<Record<string, { ok: boolean; detail?: string }>>({});

  const visible = coverage.systems.filter((s) => !skipped.has(s.system));
  const ready = visible.filter((s) => {
    const st = stageOf(s).stage;
    if (st === "planned") return s.plannedFallback === "human_boundary";
    return st === "verified" || st === "boundary" || st === "runtime";
  }).length;

  const doDraft = async (row: SystemCoverageRow) => {
    setBusySystem(row.system);
    setError(null);
    try {
      const r = await draftSystemProfile(t, tenant, {
        text: docText[row.system]?.trim() || undefined,
        hint: row.system,
      });
      if (!r.ok) { setError(r.message); return; }
      setDraftJson((m) => ({ ...m, [row.system]: JSON.stringify(r.data.draft, null, 2) }));
    } finally {
      setBusySystem(null);
    }
  };

  const doSave = async (row: SystemCoverageRow) => {
    const json = draftJson[row.system];
    if (!json) return;
    setBusySystem(row.system);
    setError(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(json); } catch { setError("草稿不是合法 JSON"); return; }
      const r = await saveSystemProfile(t, tenant, parsed);
      if (!r.ok) { setError(r.message); return; }
      setDraftJson((m) => { const n = { ...m }; delete n[row.system]; return n; });
      onChanged();
    } finally {
      setBusySystem(null);
    }
  };

  const doBoundary = async (row: SystemCoverageRow) => {
    setBusySystem(row.system);
    setError(null);
    try {
      const r = await markSystemHumanBoundary(t, tenant, row.system);
      if (!r.ok) { setError(r.message); return; }
      onChanged();
    } finally {
      setBusySystem(null);
    }
  };

  // 本体规划了、平台还没建成 → 标记 planned + 选回退（人工边界 / 阻断部署）。
  const doPlanned = async (row: SystemCoverageRow, fallback: "human_boundary" | "block") => {
    setBusySystem(row.system);
    setError(null);
    try {
      const r = await markSystemPlanned(t, tenant, row.system, fallback);
      if (!r.ok) { setError(r.message); return; }
      onChanged();
    } finally {
      setBusySystem(null);
    }
  };

  // 系统建成了 → 翻回 live，连接阶梯从建档处继续。
  const doLive = async (row: SystemCoverageRow) => {
    setBusySystem(row.system);
    setError(null);
    try {
      const r = await markSystemLive(t, tenant, row.system);
      if (!r.ok) { setError(r.message); return; }
      onChanged();
    } finally {
      setBusySystem(null);
    }
  };

  const doProbe = async (row: SystemCoverageRow) => {
    if (!row.profileId) return;
    setBusySystem(row.system);
    setError(null);
    try {
      const r = await probeSystemConnection(t, tenant, row.profileId);
      if (!r.ok) {
        setProbeResult((m) => ({ ...m, [row.system]: { ok: false, detail: r.message } }));
        return;
      }
      setProbeResult((m) => ({ ...m, [row.system]: { ok: r.data.ok, detail: r.data.detail } }));
      onChanged(); // refresh coverage so the ladder's ④格 turns green
    } finally {
      setBusySystem(null);
    }
  };

  return (
    <>
      <button type="button" className="oc-scrim" onClick={onClose} aria-label="关闭系统连接工作台" />
      <aside
        className="oc-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="系统连接工作台"
        tabIndex={-1}
        autoFocus
        style={{ width: "min(620px, 94vw)" }}
      >
        <div className="oc-ovhead">
          <h3>
            系统连接工作台
            <HelpTip>
              为每个系统建立连接（档案 · 工具 ·
              凭证）——只产出连接素材；连接验证在沙箱进行。
            </HelpTip>
          </h3>
          <div className="ctx">
            本域引用 {coverage.totals.referenced} 个外部系统 · {ready} 已就绪 · {visible.length - ready} 待处理。
            只产出连接素材，<b>不部署业务 agent</b>。
          </div>
        </div>
        <div className="oc-ovbody">
          {visible.length === 0 && <div className="oc-empty">本域没有需要连接的外部系统</div>}
          {visible.map((row) => {
            const st = stageOf(row);
            const open = expanded === row.system;
            const isBoundary = st.stage === "boundary";
            const isRuntime = st.stage === "runtime";
            const isPlanned = st.stage === "planned";
            return (
              <div className="oc-caserow" key={row.system} style={{ borderColor: open ? "var(--oc-green)" : undefined }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 13.5, fontFamily: "var(--oc-mono)" }}>{row.system}</b>
                  <span className={`oc-badge ${st.tone === "green" ? "ok" : st.tone === "amber" ? "warn" : st.tone === "purple" ? "bad" : "dim"}`}>{st.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--oc-text-3)" }}>
                    {row.referencedByActions.length} 个动作引用
                    {row.referencedVia.includes("tool") ? " · 经工具触达" : ""}
                  </span>
                </div>
                {isRuntime && (
                  <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--oc-green)" }}>
                    运行时提供，无需配置
                  </div>
                )}
                {!isRuntime && <>
                {/* connection ladder */}
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", fontSize: 11 }}>
                  <span className={`oc-badge ${row.profileId ? "ok" : "dim"}`}>{row.profileId ? "✓ 建档" : "建档"}</span>
                  <span className={`oc-badge ${row.hasTool ? "ok" : "dim"}`}>{row.hasTool ? "✓ 工具" : "工具"}</span>
                  <span className={`oc-badge ${row.credentialConfigured ? "ok" : row.credentialProvider ? "warn" : "dim"}`}>
                    {row.credentialConfigured ? "✓ 凭证" : row.credentialProvider ? `凭证:${row.credentialProvider}` : "凭证"}
                  </span>
                  <span className={`oc-badge ${row.probeOk === true ? "ok" : row.probeOk === false ? "bad" : "dim"}`}>
                    {row.probeOk === true ? "✓ 连接已验" : row.probeOk === false ? "✗ 连接失败" : "验证"}
                  </span>
                </div>
                {/* decision tri-state */}
                {!isBoundary && !isPlanned && (
                  <div style={{ display: "flex", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
                    <button type="button" className="oc-act primary-green" disabled={busySystem === row.system}
                      onClick={() => setExpanded(open ? null : row.system)}>
                      {open ? "收起" : "使用 · 连接 →"}
                    </button>
                    <button type="button" className="oc-act" disabled={busySystem === row.system}
                      onClick={() => void doBoundary(row)}>
                      {busySystem === row.system ? "…" : "人工边界"}
                    </button>
                    <button type="button" className="oc-act" disabled={busySystem === row.system}
                      title="本体规划了这个平台，但它还没建成——先标记，建成后一键翻回"
                      onClick={() => void doPlanned(row, "block")}>
                      {busySystem === row.system ? "…" : "规划中（未建成）"}
                    </button>
                    <button type="button" className="oc-act ghost" onClick={() => setSkipped((s) => new Set(s).add(row.system))}>
                      不使用
                    </button>
                  </div>
                )}
                {isBoundary && (
                  <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--oc-purple)" }}>
                    已标记人工边界——执行/晋升门仍按未接通拦截。
                  </div>
                )}
                {isPlanned && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11.5, color: st.tone === "purple" ? "var(--oc-purple)" : "var(--oc-amber, #d29922)" }}>
                      本体已规划、系统未建成——
                      {row.plannedFallback === "human_boundary"
                        ? "触达它的动作按人工边界处理，agent 照常部署。"
                        : "保持在部署待办里，触达它的动作不上线。"}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" className="oc-act" disabled={busySystem === row.system}
                        onClick={() => void doPlanned(row, row.plannedFallback === "human_boundary" ? "block" : "human_boundary")}>
                        {busySystem === row.system ? "…" : row.plannedFallback === "human_boundary" ? "改为阻断" : "改为人工"}
                      </button>
                      <button type="button" className="oc-act primary-green" disabled={busySystem === row.system}
                        onClick={() => void doLive(row)}>
                        {busySystem === row.system ? "…" : "已建成"}
                      </button>
                    </div>
                  </div>
                )}
                {/* connect wizard */}
                {open && !isBoundary && !isPlanned && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--oc-border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div>
                      <div className="oc-secttl">① 建档{row.profileId ? " · ✓ 已完成" : ""}</div>
                      {!row.profileId && (
                        <>
                          <textarea className="oc-textarea" style={{ minHeight: 64, marginTop: 6 }}
                            placeholder={`粘贴 ${row.system} 的对接文档 / API 规范（留空则让 AI 按系统名起一份骨架）…`}
                            value={docText[row.system] ?? ""}
                            onChange={(e) => setDocText((m) => ({ ...m, [row.system]: e.target.value }))} />
                          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                            <button type="button" className="oc-act primary-green" disabled={busySystem === row.system} onClick={() => void doDraft(row)}>
                              {busySystem === row.system ? "起草中…" : "AI 起草档案"}
                            </button>
                          </div>
                          {draftJson[row.system] != null && (
                            <>
                              <textarea className="oc-textarea" style={{ minHeight: 150, marginTop: 8, fontFamily: "var(--oc-mono)", fontSize: 11 }}
                                value={draftJson[row.system]}
                                onChange={(e) => setDraftJson((m) => ({ ...m, [row.system]: e.target.value }))} />
                              <button type="button" className="oc-primary" style={{ marginTop: 6 }} disabled={busySystem === row.system} onClick={() => void doSave(row)}>
                                {busySystem === row.system ? "入库中…" : "确认并入库"}
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    <div>
                      <div className="oc-secttl">② 工具{row.hasTool ? " · ✓ 已有工具触达" : ""}</div>
                    </div>
                    <div>
                      <div className="oc-secttl">③ 凭证{row.credentialConfigured ? " · ✓ 已配置" : row.credentialProvider ? ` · 缺 ${row.credentialProvider} 凭证` : ""}</div>
                      {/* 派生的配置字段清单（档案 fields → 工具声明 → 目录 → 默认）——
                          与 Settings → Integrations 动态表单同一份服务端派生。 */}
                      {row.configRequirement && row.configRequirement.fields.length > 0 && (
                        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", fontSize: 11 }}>
                          {row.configRequirement.fields.map((f) => (
                            <span
                              key={f.key}
                              className={`oc-badge ${f.satisfied ? "ok" : f.required ? "warn" : "dim"}`}
                              title={`${f.label}${f.required ? "（必填）" : ""} · 来源：${
                                f.source === "profile" ? "系统档案" : f.source === "tool" ? "工具声明" : f.source === "catalog" ? "内置目录" : "通用默认"
                              }${f.envRef ? ` · env ${f.envRef}${f.envPresent === true ? " 在位" : f.envPresent === false ? " 缺失" : ""}` : ""}`}
                            >
                              {f.satisfied ? "✓ " : ""}{f.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {row.configRequirement?.note && (
                        <div style={{ fontSize: 11.5, color: "var(--oc-text-3)", marginTop: 4 }}>{row.configRequirement.note}</div>
                      )}
                      {(row.credentialProvider || row.configRequirement?.provider) && !row.credentialConfigured && (
                        <button
                          type="button"
                          className="oc-act"
                          style={{ marginTop: 6 }}
                          onClick={() => onOpenIntegrations(row.credentialProvider ?? row.configRequirement?.provider ?? undefined)}
                        >
                          去 Settings → Integrations 配置 →
                        </button>
                      )}
                    </div>
                    <div>
                      <div className="oc-secttl">
                        ④ 验证{row.probeOk === true ? " · ✓ 已验证" : row.probeOk === false ? " · ✗ 上次失败" : ""}
                      </div>
                      {row.profileId && row.credentialProvider ? (
                        <>
                          <div style={{ fontSize: 11.5, color: "var(--oc-text-3)", margin: "4px 0" }}>
                            真实健康调用——验的是连得上，非业务逻辑。
                          </div>
                          <button type="button" className="oc-act" disabled={busySystem === row.system} onClick={() => void doProbe(row)}>
                            {busySystem === row.system ? "探测中…" : "验证连接（真实探针）"}
                          </button>
                          {probeResult[row.system] && (
                            <div style={{ marginTop: 6, fontSize: 12, color: probeResult[row.system]!.ok ? "var(--oc-green)" : "var(--oc-red)" }}>
                              {probeResult[row.system]!.ok ? "✓ 连接通" : `✗ ${probeResult[row.system]!.detail ?? "连接失败"}`}
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ marginTop: 4 }}>
                          <HelpTip>
                            需先建档并声明凭证 provider 才能自动探针；纯事件型 /
                            人工边界系统无需连接测试。
                          </HelpTip>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                </>}
              </div>
            );
          })}
          {error && <div className="oc-exec error">✕ {error}</div>}
        </div>
        <div className="oc-ovfoot">
          <button type="button" className="oc-ghost" onClick={onClose}>关闭</button>
        </div>
      </aside>
    </>
  );
}

// ── 下一步 chips ─────────────────────────────────────────────────────────────

export function OcNextSteps({ steps }: { steps: NextStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="oc-nextsteps">
      下一步
      {steps.map((s) => (
        <a key={s.id} href={s.href}>{s.label}</a>
      ))}
    </div>
  );
}
