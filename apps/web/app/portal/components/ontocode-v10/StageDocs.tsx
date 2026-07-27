"use client";
// OntoCode v10 · 阶段产物渲染：把 scope / blueprint 的 harness_receipt JSON
// 渲染成可读的表格（而不是折叠成一行「完成 · 7s」或裸 JSON）。
// 直接回应用户诉求：blueprint 内容要可见 + 分析用表格展示。
import React from "react";
import styles from "./workbench.module.css";

export type StageDocKind = "scope" | "blueprint";

const STAGE_LABEL: Record<StageDocKind, string> = {
  scope: "范围分析",
  blueprint: "Agent 蓝图",
};

export function stageDocLabel(kind: StageDocKind): string {
  return STAGE_LABEL[kind];
}

/** 从 artifact 逻辑名判定阶段类型（harness/scope/… 或 harness/blueprint/…）。 */
export function classifyStageDoc(logicalName: string): StageDocKind | null {
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
  intent: string;
  anchorCount: number;
  stepCount: number;
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
            intent: typeof p.intent === "string" ? p.intent : "",
            anchorCount: Array.isArray(p.anchors) ? p.anchors.length : 0,
            stepCount: steps.length,
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
    return <div className={styles.iEmpty}>无法读取该阶段产物内容。</div>;
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
                <th>为什么纳入本次范围</th>
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
                  <div className={styles.docSub}>
                    {p.stepCount} 步 · {p.anchorCount} 锚点
                  </div>
                </td>
                <td>{p.intent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.docMeta}>
        共 {bp.phases.length} 个 Agent 蓝图
        {bp.domain ? ` · 域 ${bp.domain}` : ""}
        {bp.unresolved > 0 ? ` · ${bp.unresolved} 项待解析` : ""}
        {" · 下一步：发送「继续」生成 Agent 代码"}
      </div>
    </div>
  );
}
