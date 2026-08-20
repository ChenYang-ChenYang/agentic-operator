"use client";
// OntoCode v10 · 阶段产物渲染：把 scope / blueprint 的 harness_receipt JSON
// 渲染成可读的表格（而不是折叠成一行「完成 · 7s」或裸 JSON）。
// 直接回应用户诉求：blueprint 内容要可见 + 分析用表格展示。
import React from "react";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";
import {
  AnalystPresentationView,
  parseAnalystPresentation,
} from "./AnalystPresentation";

export type StageDocKind = "scope" | "blueprint" | "analysis";

const STAGE_LABEL: Record<StageDocKind, string> = {
  scope: "范围分析",
  blueprint: "Agent 蓝图",
  analysis: "本体理解",
};

export function stageDocLabel(kind: StageDocKind): string {
  return STAGE_LABEL[kind];
}

/** 从 artifact 逻辑名判定阶段类型（harness/scope/… 或 harness/blueprint/…）。 */
export function classifyStageDoc(logicalName: string): StageDocKind | null {
  if (/(^|\/)ontology_analysis(\/|$)/i.test(logicalName)) return "analysis";
  if (/(^|\/)scope(\/|$)/i.test(logicalName)) return "scope";
  if (/(^|\/)blueprint(\/|$)/i.test(logicalName)) return "blueprint";
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface ScopeAction {
  id: string;
  name: string;
  reason: string;
}

function parseScope(json: unknown): {
  actions: ScopeAction[];
  reasoning: string | null;
  confidence: number | null;
  scenario: string | null;
} | null {
  if (!isRecord(json)) return null;
  const rec = isRecord(json.recommendation) ? json.recommendation : null;
  if (!rec) return null;
  const actions: ScopeAction[] = Array.isArray(rec.actions)
    ? rec.actions.flatMap((a) => {
        if (!isRecord(a)) return [];
        const name = typeof a.name === "string" ? a.name : null;
        if (!name) return [];
        return [
          {
            id: typeof a.id === "string" ? a.id : name,
            name,
            reason: typeof a.reason === "string" ? a.reason : "",
          },
        ];
      })
    : [];
  return {
    actions,
    reasoning:
      typeof rec.reasoningSummary === "string" ? rec.reasoningSummary : null,
    confidence: typeof rec.confidence === "number" ? rec.confidence : null,
    scenario: typeof rec.scenario === "string" ? rec.scenario : null,
  };
}

interface BlueprintPhase {
  agent: string;
  title: string;
  intent: string;
  anchorCount: number;
  stepCount: number;
  deliberation: string | null;
  steps: Array<{
    label: string;
    agent: string | null;
    reads: string[];
    writes: string[];
    emits: string[];
    anchors: string[];
  }>;
}

function parseBlueprint(json: unknown): {
  domain: string | null;
  phases: BlueprintPhase[];
  unresolved: number;
} | null {
  if (!isRecord(json)) return null;
  const model = isRecord(json.model) ? json.model : null;
  if (!model) return null;
  const phases: BlueprintPhase[] = Array.isArray(model.phases)
    ? model.phases.flatMap((p) => {
        if (!isRecord(p)) return [];
        const steps = Array.isArray(p.steps) ? p.steps : [];
        const firstStep = steps.find((s) => isRecord(s)) as
          | Record<string, unknown>
          | undefined;
        const agent =
          (firstStep && typeof firstStep.agent === "string"
            ? firstStep.agent
            : null) ??
          (typeof p.id === "string" ? p.id : "agent");
        return [
          {
            agent,
            title: typeof p.title === "string" ? p.title : agent,
            intent: typeof p.intent === "string" ? p.intent : "",
            anchorCount: Array.isArray(p.anchors) ? p.anchors.length : 0,
            stepCount: steps.length,
            deliberation:
              typeof p.deliberation === "string" ? p.deliberation : null,
            steps: steps.flatMap((rawStep) => {
              if (!isRecord(rawStep)) return [];
              const strList = (value: unknown): string[] =>
                Array.isArray(value)
                  ? value.filter(
                      (item): item is string => typeof item === "string",
                    )
                  : [];
              const anchors = Array.isArray(rawStep.anchors)
                ? rawStep.anchors.flatMap((rawAnchor) => {
                    if (!isRecord(rawAnchor)) return [];
                    const kind =
                      typeof rawAnchor.kind === "string"
                        ? rawAnchor.kind
                        : null;
                    const id =
                      typeof rawAnchor.id === "string" ? rawAnchor.id : null;
                    return kind && id ? [`${kind}:${id}`] : [];
                  })
                : [];
              return [
                {
                  label:
                    typeof rawStep.label === "string"
                      ? rawStep.label
                      : "未命名步骤",
                  agent:
                    typeof rawStep.agent === "string"
                      ? rawStep.agent
                      : null,
                  reads: strList(rawStep.reads),
                  writes: strList(rawStep.writes),
                  emits: strList(rawStep.emits),
                  anchors,
                },
              ];
            }),
          },
        ];
      })
    : [];
  return {
    domain: typeof model.domain === "string" ? model.domain : null,
    phases,
    unresolved: Array.isArray(model.unresolved) ? model.unresolved.length : 0,
  };
}

interface AnalysisDoc {
  counts: { objects: number; links: number; agentActions: number };
  relationshipKinds: Array<{
    kind: string;
    count: number;
    examples: Array<{ from: string; to: string }>;
  }>;
  hubs: Array<{
    id: string;
    inbound: number;
    outbound: number;
    touchedByActions: string[];
  }>;
  chains: Array<{
    entryEvent: string;
    path: string[];
    terminalEvent: string | null;
    cyclic: boolean;
  }>;
  findings: Array<{ claim: string; refs: string[]; verdict: string }>;
  systems: string[];
  limitations: string[];
  narrative: string | null;
}

function parseAnalysis(json: unknown): AnalysisDoc | null {
  if (!isRecord(json)) return null;
  const structure = isRecord(json.structure) ? json.structure : null;
  if (!structure) return null;
  const counts = isRecord(structure.counts) ? structure.counts : {};
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  return {
    counts: {
      objects: num(counts.objects),
      links: num(counts.links),
      agentActions: num(counts.agentActions),
    },
    relationshipKinds: Array.isArray(structure.relationshipKinds)
      ? structure.relationshipKinds.flatMap((k) => {
          if (!isRecord(k) || typeof k.kind !== "string") return [];
          return [
            {
              kind: k.kind,
              count: num(k.count),
              examples: Array.isArray(k.examples)
                ? k.examples.flatMap((e) =>
                    isRecord(e) &&
                    typeof e.from === "string" &&
                    typeof e.to === "string"
                      ? [{ from: e.from, to: e.to }]
                      : [],
                  )
                : [],
            },
          ];
        })
      : [],
    hubs: Array.isArray(structure.hubs)
      ? structure.hubs.flatMap((h) =>
          isRecord(h) && typeof h.id === "string"
            ? [
                {
                  id: h.id,
                  inbound: num(h.inbound),
                  outbound: num(h.outbound),
                  touchedByActions: strList(h.touchedByActions),
                },
              ]
            : [],
        )
      : [],
    chains: Array.isArray(structure.eventChains)
      ? structure.eventChains.flatMap((c) =>
          isRecord(c) && typeof c.entryEvent === "string"
            ? [
                {
                  entryEvent: c.entryEvent,
                  path: strList(c.path),
                  terminalEvent:
                    typeof c.terminalEvent === "string" ? c.terminalEvent : null,
                  cyclic: c.cyclic === true,
                },
              ]
            : [],
        )
      : [],
    findings: Array.isArray(json.findings)
      ? json.findings.flatMap((f) =>
          isRecord(f) && typeof f.claim === "string"
            ? [
                {
                  claim: f.claim,
                  refs: strList(f.refs),
                  verdict:
                    typeof f.verdict === "string" ? f.verdict : "unverifiable",
                },
              ]
            : [],
        )
      : [],
    systems: strList(structure.externalSystems),
    limitations: strList(json.limitations),
    narrative: typeof json.narrative === "string" ? json.narrative : null,
  };
}

export interface StageDocViewProps {
  kind: StageDocKind;
  content: string | null;
  loading: boolean;
}

export function StageDocView(props: StageDocViewProps) {
  if (props.loading) {
    return <div className={styles.iEmpty}>加载中…</div>;
  }
  if (props.content === null) {
    return <div className={styles.iEmpty}>读取失败</div>;
  }
  let json: unknown;
  try {
    json = JSON.parse(props.content);
  } catch {
    return <pre className={styles.codeBox}>{props.content}</pre>;
  }

  if (props.kind === "scope") {
    const scope = parseScope(json);
    if (!scope) return <pre className={styles.codeBox}>{props.content}</pre>;
    return (
      <div className={styles.docWrap}>
        {scope.reasoning ? (
          <p className={styles.docSummary}>{scope.reasoning}</p>
        ) : null}
        <div className={styles.docTableWrap}>
          <table className={styles.docTable}>
            <thead>
              <tr>
                <th style={{ width: "34%" }}>Action</th>
                <th>纳入理由</th>
              </tr>
            </thead>
            <tbody>
              {scope.actions.map((a) => (
                <tr key={a.id}>
                  <td className={styles.docMono}>{a.name}</td>
                  <td>{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.docMeta}>
          共 {scope.actions.length} 个 Action
          {scope.confidence !== null
            ? ` · 置信度 ${Math.round(scope.confidence * 100)}%`
            : ""}
        </div>
      </div>
    );
  }

  if (props.kind === "analysis") {
    const presentation = parseAnalystPresentation(json);
    if (presentation) {
      return <AnalystPresentationView presentation={presentation} />;
    }
    const a = parseAnalysis(json);
    if (!a) return <pre className={styles.codeBox}>{props.content}</pre>;
    return (
      <div className={styles.docWrap}>
        {a.narrative ? <p className={styles.docSummary}>{a.narrative}</p> : null}
        <div className={styles.ovSum}>
          <span className={styles.ovChip}>{a.counts.objects} 对象</span>
          <span className={styles.ovChip}>{a.counts.links} 关系边</span>
          <span className={styles.ovChip}>{a.counts.agentActions} Agent 动作</span>
        </div>
        {a.relationshipKinds.length > 0 ? (
          <>
            <div className={styles.secTitle}>关系类型</div>
            <div className={styles.docTableWrap}>
              <table className={styles.docTable}>
                <thead>
                  <tr>
                    <th style={{ width: "38%" }}>类型</th>
                    <th>数量与示例</th>
                  </tr>
                </thead>
                <tbody>
                  {a.relationshipKinds.map((k) => (
                    <tr key={k.kind}>
                      <td className={styles.docMono}>{k.kind}</td>
                      <td>
                        ×{k.count}
                        {k.examples.length > 0 ? (
                          <div className={styles.docSub}>
                            {k.examples
                              .map((e) => `${e.from} → ${e.to}`)
                              .join("；")}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {a.hubs.length > 0 ? (
          <>
            <div className={styles.secTitle}>核心实体</div>
            <div className={styles.docTableWrap}>
              <table className={styles.docTable}>
                <thead>
                  <tr>
                    <th style={{ width: "38%" }}>实体</th>
                    <th>连接度</th>
                  </tr>
                </thead>
                <tbody>
                  {a.hubs.map((h) => (
                    <tr key={h.id}>
                      <td className={styles.docMono}>{h.id}</td>
                      <td>
                        入 {h.inbound} · 出 {h.outbound}
                        {h.touchedByActions.length > 0 ? (
                          <div className={styles.docSub}>
                            {h.touchedByActions.join("、")}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {a.findings.length > 0 ? (
          <>
            <div className={styles.secTitle}>结论</div>
            <div className={styles.docTableWrap}>
              <table className={styles.docTable}>
                <thead>
                  <tr>
                    <th style={{ width: "18%" }}>核查</th>
                    <th>结论与依据</th>
                  </tr>
                </thead>
                <tbody>
                  {a.findings.map((f, i) => (
                    <tr key={`${f.claim}-${i}`}>
                      <td
                        className={
                          f.verdict === "confirmed"
                            ? styles.agStatOk
                            : styles.agStatOff
                        }
                      >
                        {f.verdict === "confirmed" ? "✓ 已核对" : "未验证"}
                      </td>
                      <td>
                        {f.claim}
                        {f.refs.length > 0 ? (
                          <div className={styles.docSub}>
                            依据：{f.refs.join("、")}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {a.chains.length > 0 ? (
          <>
            <div className={styles.secTitle}>事件链</div>
            <div className={styles.docTableWrap}>
              <table className={styles.docTable}>
                <tbody>
                  {a.chains.map((c, i) => (
                    <tr key={`${c.entryEvent}-${i}`}>
                      <td className={styles.docMono}>
                        {c.entryEvent} → {c.path.join(" → ")}
                        {c.terminalEvent ? ` → ${c.terminalEvent}` : ""}
                        {c.cyclic ? "（存在回环）" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {a.systems.length > 0 ? (
          <div className={styles.docMeta}>
            外部系统：{a.systems.join("、")}
          </div>
        ) : null}
        {a.limitations.length > 0 ? (
          <div className={styles.docMeta}>
            {a.limitations.map((l, i) => (
              <div key={i}>· {l}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const bp = parseBlueprint(json);
  if (!bp) return <pre className={styles.codeBox}>{props.content}</pre>;
  return (
    <div className={styles.docWrap}>
      <div className={styles.docTableWrap}>
        <table className={styles.docTable}>
          <thead>
            <tr>
              <th style={{ width: "26%" }}>Agent</th>
              <th>职责与事件链</th>
            </tr>
          </thead>
          <tbody>
            {bp.phases.map((p, i) => (
              <tr key={`${p.agent}-${i}`}>
                <td className={styles.docMono}>
                  {p.agent}
                  <div className={styles.docSub}>{p.stepCount} 步</div>
                </td>
                <td>
                  <strong>{p.title}</strong>
                  {p.deliberation ? (
                    <HelpTip>{`设计说明：${p.deliberation}`}</HelpTip>
                  ) : null}
                  {p.intent ? <div>{p.intent}</div> : null}
                  {p.steps.length > 0 ? (
                    <ol className={styles.blueprintSteps}>
                      {p.steps.map((step, stepIndex) => (
                        <li
                          key={`${p.agent}-${step.label}-${stepIndex}`}
                          className={styles.blueprintStep}
                        >
                          <div>
                            {step.label}
                            {step.agent && step.agent !== p.agent
                              ? ` · ${step.agent}`
                              : ""}
                          </div>
                          {/* 「依据」原始锚点是内部 id，默认收进 hover。 */}
                          <div
                            className={styles.docSub}
                            title={
                              step.anchors.length
                                ? `依据 ${step.anchors.join("、")}`
                                : undefined
                            }
                          >
                            {[
                              step.reads.length
                                ? `读取 ${step.reads.join("、")}`
                                : null,
                              step.writes.length
                                ? `写入 ${step.writes.join("、")}`
                                : null,
                              step.emits.length
                                ? `发出 ${step.emits.join("、")}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.docMeta}>
        共 {bp.phases.length} 个 Agent 蓝图
        {bp.domain ? ` · 域 ${bp.domain}` : ""}
        {bp.unresolved > 0 ? ` · ${bp.unresolved} 项待解析` : ""}
      </div>
    </div>
  );
}
