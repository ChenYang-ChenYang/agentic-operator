"use client";
// OntoCode v10 · 右栏：本次生成产物 概览 ⇄ 钻取。
// 纯视图 + 同文件的 connected 包装（版本/内容按需加载）。零 mock：全部来自真实产物记录。
import React, { useMemo, useState } from "react";
import type {
  OntoCodeArtifactVersion,
  OntoCodeEvidenceRecord,
} from "@agentic/contracts";
import {
  useLoadOntoCodeArtifactVersionContent,
  useOntoCodeArtifactVersions,
  type OntoCodeArtifactSummaryItem,
} from "@/lib/hooks/useOntoCodeWorkspace";
import styles from "./workbench.module.css";

const KIND_LABEL: Record<string, string> = {
  agent_code: "代码",
  agent_spec: "规格",
  agent_manifest: "契约",
  test_suite: "测试",
  scope_document: "范围",
  blueprint_document: "蓝图",
  harness_receipt: "执行回执",
  report: "报告",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ");
}

function shortName(logicalName: string): string {
  const parts = logicalName.split("/");
  return parts[parts.length - 1] || logicalName;
}

/* ------------------------------- 概览视图 ------------------------------- */

export interface InspectorOverviewProps {
  candidateLabel: string | null;
  items: OntoCodeArtifactSummaryItem[];
  evidence: OntoCodeEvidenceRecord[];
  onOpen: (artifactId: string) => void;
  onCollapse: () => void;
}

export function InspectorOverviewView(props: InspectorOverviewProps) {
  const passCount = props.evidence.filter((e) => e.outcome === "passed").length;
  const failCount = props.evidence.filter((e) => e.outcome === "failed").length;
  // 回执类产物在概览里折叠——FDE 来看的是产物本体，不是回执文件。
  const primary = props.items.filter(
    (i) => i.artifact.kind !== "harness_receipt",
  );
  const receipts = props.items.length - primary.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className={styles.iHead}>
        <div>
          <div className={styles.iHeadLabel}>本次生成 · 概览</div>
          <h3 className={styles.iHeadTitle}>
            产物
            {props.candidateLabel ? (
              <span className={styles.vChip}>{props.candidateLabel}</span>
            ) : null}
          </h3>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.btn} onClick={props.onCollapse}>
          收起
        </button>
      </div>
      <div className={styles.ovSum}>
        <span className={`${styles.ovChip} ${styles.ovChipOk}`}>
          {passCount} 项证据通过
        </span>
        {failCount > 0 ? (
          <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
            {failCount} 项失败
          </span>
        ) : null}
        <span className={styles.ovChip}>{primary.length} 个产物</span>
        {receipts > 0 ? (
          <span className={styles.ovChip}>{receipts} 份执行回执</span>
        ) : null}
      </div>
      <div className={styles.iBody}>
        {primary.length === 0 ? (
          <div className={styles.iEmpty}>
            还没有可查看的产物。先在左侧说一句业务目标；生成后这里会列出每个
            agent 的代码、契约与测试，可点开逐个审查。
          </div>
        ) : (
          primary.map((item) => (
            <button
              key={item.artifact.id}
              type="button"
              className={styles.agRow}
              onClick={() => props.onOpen(item.artifact.id)}
            >
              <span className={styles.agName}>
                {shortName(item.artifact.logicalName)}
              </span>
              <span className={styles.agWire}>
                {kindLabel(item.artifact.kind)} · v{item.latestVersion.version}
              </span>
              <span className={`${styles.agStat} ${styles.agStatOff}`}>›</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------- 钻取视图 ------------------------------- */

export interface InspectorDetailProps {
  name: string;
  kind: string;
  versions: OntoCodeArtifactVersion[];
  activeVersionId: string | null;
  content: string | null;
  contentLoading: boolean;
  evidence: OntoCodeEvidenceRecord[];
  onSelectVersion: (versionId: string) => void;
  onBack: () => void;
}

export function InspectorDetailView(props: InspectorDetailProps) {
  const [tab, setTab] = useState<"content" | "evidence">("content");
  const related = props.evidence;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className={styles.iHead}>
        <div>
          <button type="button" className={styles.btn} onClick={props.onBack}>
            ‹ 概览
          </button>
        </div>
        <h3 className={styles.iHeadTitle} style={{ minWidth: 0 }}>
          <span className={styles.agName} style={{ minWidth: 0 }}>
            {props.name}
          </span>
          <span className={styles.vChip}>{kindLabel(props.kind)}</span>
        </h3>
        <span style={{ flex: 1 }} />
      </div>
      <div className={styles.tabs}>
        <button
          type="button"
          className={tab === "content" ? `${styles.tab} ${styles.tabOn}` : styles.tab}
          onClick={() => setTab("content")}
        >
          内容
        </button>
        <button
          type="button"
          className={tab === "evidence" ? `${styles.tab} ${styles.tabOn}` : styles.tab}
          onClick={() => setTab("evidence")}
        >
          证据 · {related.length}
        </button>
      </div>
      <div className={styles.iBody}>
        {tab === "content" ? (
          <>
            <div className={styles.fileRow}>
              {props.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={
                    v.id === props.activeVersionId
                      ? `${styles.filePill} ${styles.filePillOn}`
                      : styles.filePill
                  }
                  onClick={() => props.onSelectVersion(v.id)}
                >
                  v{v.version}
                </button>
              ))}
            </div>
            {props.contentLoading ? (
              <div className={styles.iEmpty}>内容加载中…</div>
            ) : props.content !== null ? (
              <pre className={styles.codeBox}>{props.content}</pre>
            ) : (
              <div className={styles.iEmpty}>选择一个版本查看内容。</div>
            )}
          </>
        ) : related.length === 0 ? (
          <div className={styles.iEmpty}>
            该产物还没有关联证据。跑一次验证后，这里会显示测试与沙箱回执。
          </div>
        ) : (
          related.map((e) => (
            <div key={e.id} className={styles.evRow}>
              <span
                className={
                  e.outcome === "passed"
                    ? styles.agStatOk
                    : e.outcome === "failed"
                      ? styles.agStatBad
                      : styles.agStatOff
                }
              >
                {e.outcome === "passed" ? "✓" : e.outcome === "failed" ? "✗" : "…"}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{e.summary}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Connected 包装 ---------------------------- */

export interface ArtifactInspectorProps {
  tenant: string;
  sessionId: string;
  candidateLabel: string | null;
  items: OntoCodeArtifactSummaryItem[];
  evidence: OntoCodeEvidenceRecord[];
  onCollapse: () => void;
}

export function ArtifactInspectorConnected(props: ArtifactInspectorProps) {
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  const versionsQ = useOntoCodeArtifactVersions(
    props.tenant,
    props.sessionId,
    openArtifactId ?? "",
  );
  const loadContent = useLoadOntoCodeArtifactVersionContent(props.tenant);

  const openItem = useMemo(
    () => props.items.find((i) => i.artifact.id === openArtifactId) ?? null,
    [props.items, openArtifactId],
  );

  const selectVersion = (versionId: string) => {
    setActiveVersionId(versionId);
    setContent(null);
    loadContent.mutate(versionId, {
      onSuccess: (receipt) => {
        const text =
          typeof (receipt as { content?: unknown }).content === "string"
            ? ((receipt as { content: string }).content)
            : JSON.stringify(receipt, null, 2);
        setContent(text);
      },
    });
  };

  if (!openItem) {
    return (
      <InspectorOverviewView
        candidateLabel={props.candidateLabel}
        items={props.items}
        evidence={props.evidence}
        onCollapse={props.onCollapse}
        onOpen={(artifactId) => {
          setOpenArtifactId(artifactId);
          setActiveVersionId(null);
          setContent(null);
          const item = props.items.find((i) => i.artifact.id === artifactId);
          if (item) selectVersion(item.latestVersion.id);
        }}
      />
    );
  }

  const relatedEvidence = props.evidence.filter(
    (e) =>
      e.artifactVersionId === activeVersionId ||
      (e.artifactVersionId !== null &&
        versionsQ.data?.items.some((v) => v.id === e.artifactVersionId)),
  );

  return (
    <InspectorDetailView
      name={shortName(openItem.artifact.logicalName)}
      kind={openItem.artifact.kind}
      versions={versionsQ.data?.items ?? [openItem.latestVersion]}
      activeVersionId={activeVersionId}
      content={content}
      contentLoading={loadContent.isPending}
      evidence={relatedEvidence}
      onSelectVersion={selectVersion}
      onBack={() => {
        setOpenArtifactId(null);
        setActiveVersionId(null);
        setContent(null);
      }}
    />
  );
}
