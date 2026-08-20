"use client";
// OntoCode v10 · 右栏：本次生成产物 概览 ⇄ 钻取。
// 纯视图 + 同文件的 connected 包装（版本/内容按需加载）。零 mock：全部来自真实产物记录。
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  OntoCodeArtifactVersion,
  OntoCodeChangeSet,
  OntoCodeChangeSetOperation,
  OntoCodeDeliveryState,
  OntoCodeEvidenceRecord,
  OntoCodeHarnessJob,
  OntoCodeSuiteOverview,
} from "@agentic/contracts";
import {
  useLoadOntoCodeArtifactVersionContent,
  useOntoCodeArtifactVersions,
  type OntoCodeArtifactSummaryItem,
} from "@/lib/hooks/useOntoCodeWorkspace";
import styles from "./workbench.module.css";
import {
  classifyStageDoc,
  stageDocLabel,
  StageDocView,
  type StageDocKind,
} from "./StageDocs";
import {
  jobFailed,
  jobFailureReason,
  jobKindLabel,
  jobStatusText,
} from "./job-labels";
import { productFacingOntoCodeText } from "./product-vocabulary";
import { CodeViewer } from "./CodeViewer";

const KIND_LABEL: Record<string, string> = {
  agent_code: "代码",
  agent_code_draft: "代码草稿 · 待验证",
  agent_spec: "规格",
  agent_manifest: "契约",
  test_suite: "测试",
  scope_document: "范围",
  blueprint_document: "蓝图",
  harness_receipt: "执行回执",
  ontology_analysis: "本体分析",
  report: "报告",
};

function kindLabel(kind: string): string {
  // 未映射的 kind 用中性中文兜底，不把内部枚举裸渲染给用户。
  return KIND_LABEL[kind] ?? "其它";
}

function shortName(logicalName: string): string {
  // The durable logical name is an internal compatibility contract. Present
  // the OntoCode product name without renaming the artifact in storage.
  if (logicalName === "package/factory-draft.json") return "ontocode-draft.json";
  const parts = logicalName.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || logicalName;
  // 一个候选包里每个 agent 各有一份 agent.ts / spec.json，只取末段会把整列渲染成
  // 同一个字符串，FDE 无法分辨点开的是哪个 agent。带上父目录（agent 名）才是
  // 真正的辨识位；再往上的 "agents/" 是所有行共有的前缀，省掉不损失信息。
  const parent = parts[parts.length - 2];
  return parent ? `${parent}/${name}` : name;
}

export type OntoCodeArtifactDeliveryStatus =
  | OntoCodeDeliveryState
  | "generated_unverified";

const CANDIDATE_STATUS_LABEL: Record<OntoCodeDeliveryState, string> = {
  candidate_ready: "待验证",
  verified_candidate: "已验证",
  release_ready: "可发布",
  released: "已发布",
};

/**
 * A generated-unverified draft is deliberately not called a Candidate. The
 * Candidate name starts only after an immutable Package Version exists.
 */
export function candidateLabelForBuildState(
  status: OntoCodeArtifactDeliveryStatus,
  revision?: number | null,
): string {
  if (status === "generated_unverified") {
    return "草稿 · 未验证";
  }
  const version =
    typeof revision === "number" && Number.isInteger(revision) && revision > 0
      ? revision
      : 1;
  return `v${version} · ${CANDIDATE_STATUS_LABEL[status]}`;
}

const BUILD_IN_PROGRESS_STATUSES = new Set<OntoCodeHarnessJob["status"]>([
  "queued",
  "running",
  "leased",
  "retry_scheduled",
]);

export function harnessJobIsInProgress(
  job: Pick<OntoCodeHarnessJob, "status">,
): boolean {
  return BUILD_IN_PROGRESS_STATUSES.has(job.status);
}

export function buildIsInProgress(
  jobs: Array<Pick<OntoCodeHarnessJob, "kind" | "status">>,
): boolean {
  return jobs.some(
    (job) => job.kind === "build" && harnessJobIsInProgress(job),
  );
}

type StageDocRow = {
  item: OntoCodeArtifactSummaryItem;
  kind: StageDocKind;
};

function stageDocKindForItem(
  item: OntoCodeArtifactSummaryItem,
): StageDocKind | null {
  if (item.artifact.kind === "ontology_analysis") return "analysis";
  return classifyStageDoc(item.artifact.logicalName);
}

function versionJobId(item: OntoCodeArtifactSummaryItem): string | null {
  const value = item.latestVersion.metadata.jobId;
  return typeof value === "string" && value.trim() ? value : null;
}

function isFirstClassAnalysis(item: OntoCodeArtifactSummaryItem): boolean {
  return item.artifact.kind === "ontology_analysis";
}

/**
 * Keep one stage entry per kind. Ontology analysis is intentionally persisted
 * both as an audit receipt and as a first-class, versioned artifact; when those
 * two rows represent the same job, the first-class artifact is the canonical
 * UI entry.
 */
export function latestStageDocumentRows(
  items: OntoCodeArtifactSummaryItem[],
): StageDocRow[] {
  const latest = new Map<StageDocKind, StageDocRow>();
  for (const item of items) {
    const kind = stageDocKindForItem(item);
    if (!kind) continue;
    const next = { item, kind };
    const previous = latest.get(kind);
    if (!previous) {
      latest.set(kind, next);
      continue;
    }
    const previousJobId = versionJobId(previous.item);
    const nextJobId = versionJobId(item);
    const sameJob =
      previousJobId !== null &&
      nextJobId !== null &&
      previousJobId === nextJobId;
    const previousCreatedAt = previous.item.latestVersion.createdAt;
    const nextCreatedAt = item.latestVersion.createdAt;
    const previousFirstClass = isFirstClassAnalysis(previous.item);
    const nextFirstClass = isFirstClassAnalysis(item);
    if (
      kind === "analysis" &&
      sameJob &&
      previousFirstClass !== nextFirstClass
    ) {
      if (nextFirstClass) latest.set(kind, next);
      continue;
    }
    const preferFirstClass =
      kind === "analysis" &&
      nextFirstClass &&
      !previousFirstClass &&
      nextCreatedAt === previousCreatedAt;
    if (nextCreatedAt > previousCreatedAt || preferFirstClass) {
      latest.set(kind, next);
    }
  }
  return (["analysis", "scope", "blueprint"] as const).flatMap((kind) => {
    const row = latest.get(kind);
    return row ? [row] : [];
  });
}

export function latestStageDocumentForKind(
  items: OntoCodeArtifactSummaryItem[],
  kind: StageDocKind,
): StageDocRow | null {
  return (
    latestStageDocumentRows(items).find((row) => row.kind === kind) ?? null
  );
}

/* ------------------------------- 概览视图 ------------------------------- */

export interface InspectorOverviewProps {
  candidateLabel: string | null;
  candidateStatus?: OntoCodeArtifactDeliveryStatus | null;
  buildInProgress?: boolean;
  overview?: OntoCodeSuiteOverview | null;
  items: OntoCodeArtifactSummaryItem[];
  evidence: OntoCodeEvidenceRecord[];
  onOpen: (artifactId: string) => void;
  onOpenStageDoc: (artifactId: string, kind: StageDocKind) => void;
  onCollapse: () => void;
}

const OWNER_LABEL: Record<string, string> = {
  declarative_manifest: "声明式",
  codeact: "代码执行",
};

export function InspectorOverviewView(props: InspectorOverviewProps) {
  const passCount = props.evidence.filter((e) => e.outcome === "passed").length;
  const failCount = props.evidence.filter((e) => e.outcome === "failed").length;
  const agents = props.overview?.agents ?? [];
  const readiness = props.overview?.readiness ?? null;
  // 回执类产物在概览里折叠——FDE 来看的是产物本体，不是回执文件。
  const primary = props.items.filter(
    (i) =>
      i.artifact.kind !== "harness_receipt" && stageDocKindForItem(i) === null,
  );
  const receipts = props.items.filter(
    (i) => i.artifact.kind === "harness_receipt",
  ).length;
  // 阶段产物（范围分析 / 蓝图）虽以 harness_receipt 存储，但内容丰富、
  // FDE 需要可查看——单列出来并渲染成表格，而不是折叠成计数。
  // 顺序即 FDE 的阅读顺序：先看懂这个域，再看这次要做什么，最后看打算怎么做。
  // 「analysis」以前不在这张表里——于是 Ontology 分析跑完、回执落了盘，却没有任何入口能打开它。
  const stageRows = latestStageDocumentRows(props.items);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className={styles.iHead}>
        <div>
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
        {props.buildInProgress ? (
          <span className={styles.ovChip}>生成中</span>
        ) : null}
        {readiness ? (
          <>
            <span className={`${styles.ovChip} ${styles.ovChipOk}`}>
              {readiness.ready} 就绪
            </span>
            {readiness.pendingConfig > 0 ? (
              <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
                {readiness.pendingConfig} 待配置
              </span>
            ) : null}
            {readiness.verifying > 0 ? (
              <span className={styles.ovChip}>
                {readiness.verifying} 验证中
              </span>
            ) : null}
          </>
        ) : null}
        <span className={`${styles.ovChip} ${styles.ovChipOk}`}>
          {passCount} 证据通过
        </span>
        {failCount > 0 ? (
          <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
            {failCount} 失败
          </span>
        ) : null}
        <span className={styles.ovChip}>{primary.length} 产物</span>
        {receipts > 0 ? (
          <span className={styles.ovChip}>{receipts} 执行回执</span>
        ) : null}
      </div>
      <div className={styles.iBody}>
        {stageRows.length > 0 ? (
          <>
            <div className={styles.secTitle}>阶段产物</div>
            {stageRows.map(({ item, kind }) => (
              <button
                key={item.artifact.id}
                type="button"
                className={styles.agRow}
                onClick={() => props.onOpenStageDoc(item.artifact.id, kind)}
              >
                <span className={styles.agName}>{stageDocLabel(kind)}</span>
                <span className={styles.agStatOff}>›</span>
              </button>
            ))}
          </>
        ) : null}
        {primary.length === 0 && agents.length === 0 ? (
          <div className={styles.iEmpty}>
            {props.buildInProgress
              ? "生成中…"
              : stageRows.length > 0
                ? "尚无代码"
                : "暂无产物"}
          </div>
        ) : null}
        {agents.length > 0 ? (
          <>
            {agents.map((a) => {
              const firstArtifact = a.artifacts[0];
              return (
                <button
                  key={a.name}
                  type="button"
                  className={styles.agRow}
                  onClick={() => {
                    if (firstArtifact) props.onOpen(firstArtifact.artifactId);
                  }}
                >
                  <span className={styles.agName}>{a.name}</span>
                  <span className={styles.agWire}>
                    {OWNER_LABEL[a.executionOwner] ?? a.executionOwner} ·{" "}
                    {a.artifacts.length} 个文件
                  </span>
                  {a.blocking ? (
                    // 以前是 slice(0, 18)：把阻塞原因砍成半句还不说自己砍了。
                    // 现在留全文，行内用省略号限幅，完整值 hover 可读。
                    <span
                      className={`${styles.agStat} ${styles.agStatBad} ${styles.agStatClamp}`}
                      title={a.blocking}
                    >
                      {a.blocking}
                    </span>
                  ) : a.test ? (
                    <span
                      className={
                        a.test.failed > 0
                          ? `${styles.agStat} ${styles.agStatBad}`
                          : `${styles.agStat} ${styles.agStatOk}`
                      }
                    >
                      {a.test.failed > 0
                        ? `✗ ${a.test.failed} 失败`
                        : `✓ ${a.test.passed}/${a.test.passed}`}
                    </span>
                  ) : a.qualification === "promotable" ? (
                    <span className={`${styles.agStat} ${styles.agStatOk}`}>
                      沙箱可信 · 可晋级
                    </span>
                  ) : a.qualification === "development_only" ? (
                    <span className={`${styles.agStat} ${styles.ovChipWarn}`}>
                      开发验证 · 不可晋级
                    </span>
                  ) : (
                    <span className={`${styles.agStat} ${styles.agStatOff}`}>
                      待验证
                    </span>
                  )}
                  <span className={styles.agStatOff}>›</span>
                </button>
              );
            })}
            <div
              className={styles.railSec}
              style={{ padding: "12px 16px 4px" }}
            >
              全部文件
            </div>
          </>
        ) : null}
        {primary.length > 0
          ? primary.map((item) => (
              <button
                key={item.artifact.id}
                type="button"
                className={styles.agRow}
                // 名称在窄栏会被截断；把展示名放进 title 与无障碍名，鼠标悬停和
                // 屏幕阅读器都能分辨是哪个 agent 的哪个文件。用 shortName 而不是
                // 裸 logicalName——后者会把内部兼容名（package/factory-draft.json）
                // 泄露给用户，绕过产品术语。
                title={shortName(item.artifact.logicalName)}
                aria-label={`打开 ${shortName(item.artifact.logicalName)}（${kindLabel(
                  item.artifact.kind,
                )} 第 ${item.latestVersion.version} 版）`}
                onClick={() => props.onOpen(item.artifact.id)}
              >
                <span className={styles.agName}>
                  {shortName(item.artifact.logicalName)}
                </span>
                <span className={styles.agWire}>
                  {kindLabel(item.artifact.kind)} · v
                  {item.latestVersion.version}
                </span>
                <span
                  className={`${styles.agStat} ${styles.agStatOff}`}
                  aria-hidden="true"
                >
                  ›
                </span>
              </button>
            ))
          : null}
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
  // 语言判定按当前版本自己的 content-type，而不是按产物 kind 猜。
  const activeVersion =
    props.versions.find((v) => v.id === props.activeVersionId) ?? null;
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
          className={
            tab === "content" ? `${styles.tab} ${styles.tabOn}` : styles.tab
          }
          onClick={() => setTab("content")}
        >
          内容
        </button>
        <button
          type="button"
          className={
            tab === "evidence" ? `${styles.tab} ${styles.tabOn}` : styles.tab
          }
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
              <CodeViewer
                content={props.content}
                contentType={activeVersion?.contentType ?? null}
                logicalName={props.name}
              />
            ) : (
              <div className={styles.iEmpty}>选择版本</div>
            )}
          </>
        ) : related.length === 0 ? (
          <div className={styles.iEmpty}>暂无证据</div>
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
                {e.outcome === "passed"
                  ? "✓"
                  : e.outcome === "failed"
                    ? "✗"
                    : "…"}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {productFacingOntoCodeText(e.summary)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* --------------------------- 会话级检查器视图 --------------------------- */

const CHANGE_STATUS_LABEL: Record<OntoCodeChangeSet["status"], string> = {
  proposed: "待审查",
  validated: "已验证",
  committed: "已提交",
  abandoned: "已放弃",
};

const CHANGE_OPERATION_LABEL: Record<
  OntoCodeChangeSetOperation["operation"],
  string
> = {
  add: "新增",
  replace: "替换",
  remove: "移除",
  move: "移动",
};

export interface InspectorChangesProps {
  changeSet?: OntoCodeChangeSet | null;
  operations: OntoCodeChangeSetOperation[];
  /** 没有变更集时，说清这次到底记下了什么，而不是一句「暂无」。 */
  artifactCount?: number;
  loading?: boolean;
  errorText?: string | null;
}

/**
 * 零变更集有两种完全不同的成因：这次什么都没产出，或者产出了产物但没有一条
 * 语义变更被记录下来。后者是这条链上真实存在的缺口，必须说出来。
 */
export function changesEmptyText(artifactCount: number | undefined): string {
  return typeof artifactCount === "number" && artifactCount > 0
    ? `本次记录了 ${artifactCount} 个产物，没有记录语义变更。`
    : "本次会话没有变更。";
}

/** Read-only semantic operations from the latest persisted session change set. */
export function InspectorChangesView(props: InspectorChangesProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className={styles.iHead}>
        <h3 className={styles.iHeadTitle}>变更</h3>
        {props.changeSet ? (
          <span className={styles.vChip}>
            {CHANGE_STATUS_LABEL[props.changeSet.status]}
          </span>
        ) : null}
      </div>
      {props.changeSet ? (
        <div className={styles.ovSum}>
          <span className={styles.ovChip}>
            {props.operations.length} 项语义变更
          </span>
        </div>
      ) : null}
      <div className={styles.iBody}>
        {props.errorText ? (
          <div className={styles.iEmpty}>{props.errorText}</div>
        ) : props.loading && !props.changeSet ? (
          <div className={styles.iEmpty}>正在读取变更…</div>
        ) : !props.changeSet ? (
          <div className={styles.iEmpty}>
            {changesEmptyText(props.artifactCount)}
          </div>
        ) : (
          <>
            <div className={styles.secTitle}>{props.changeSet.summary}</div>
            {props.loading ? (
              <div className={styles.iEmpty}>正在读取变更明细…</div>
            ) : props.operations.length === 0 ? (
              <div className={styles.iEmpty}>该变更记录没有语义操作</div>
            ) : (
              props.operations.map((operation) => (
                <div key={operation.id} className={styles.evRow}>
                  <span className={styles.agName} style={{ minWidth: 44 }}>
                    {CHANGE_OPERATION_LABEL[operation.operation]}
                  </span>
                  <span className={styles.agWire} title={operation.semanticPath}>
                    {operation.fromSemanticPath
                      ? `${operation.fromSemanticPath} → ${operation.semanticPath}`
                      : operation.semanticPath}
                  </span>
                  <span className={`${styles.agStat} ${styles.agStatOff}`}>
                    {operation.sourceRefs.length} 引用 · {operation.invalidates.length} 失效
                  </span>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

export interface InspectorTestsProps {
  overview?: OntoCodeSuiteOverview | null;
  /** 真实跑过的作业。没有测试作业和「跑了但没记结果」是两回事。 */
  jobs?: OntoCodeHarnessJob[];
  loading?: boolean;
  errorText?: string | null;
}

const TEST_JOB_KINDS = new Set<OntoCodeHarnessJob["kind"]>([
  "test",
  "regression",
]);

export function testJobsOf(
  jobs: OntoCodeHarnessJob[] | undefined,
): OntoCodeHarnessJob[] {
  return (jobs ?? []).filter((job) => TEST_JOB_KINDS.has(job.kind));
}

/** Per-Agent test aggregates supplied by the persisted suite overview. */
export function InspectorTestsView(props: InspectorTestsProps) {
  const rows = (props.overview?.agents ?? []).flatMap((agent) =>
    agent.test ? [{ name: agent.name, test: agent.test }] : [],
  );
  const testJobs = testJobsOf(props.jobs);
  const totals = rows.reduce(
    (sum, row) => ({
      passed: sum.passed + row.test.passed,
      failed: sum.failed + row.test.failed,
      inconclusive: sum.inconclusive + row.test.inconclusive,
    }),
    { passed: 0, failed: 0, inconclusive: 0 },
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className={styles.iHead}>
        <h3 className={styles.iHeadTitle}>测试</h3>
      </div>
      {rows.length > 0 ? (
        <div className={styles.ovSum}>
          <span className={`${styles.ovChip} ${styles.ovChipOk}`}>
            {totals.passed} 通过
          </span>
          {totals.failed > 0 ? (
            <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
              {totals.failed} 失败
            </span>
          ) : null}
          {totals.inconclusive > 0 ? (
            <span className={styles.ovChip}>{totals.inconclusive} 待定</span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.iBody}>
        {props.errorText ? (
          <div className={styles.iEmpty}>{props.errorText}</div>
        ) : props.loading && !props.overview ? (
          <div className={styles.iEmpty}>正在读取测试结果…</div>
        ) : rows.length === 0 && testJobs.length === 0 ? (
          // 「没有结果」和「从来没跑过测试」是两件事。今天真实发生的是后者，
          // 所以这里必须说出后者，而不是含糊的「暂无测试结果」。
          <div className={styles.iEmpty}>本次会话没有运行测试作业。</div>
        ) : (
          rows.map((row) => (
            <div key={row.name} className={styles.evRow}>
              <span className={styles.agName}>{row.name}</span>
              <span className={styles.agWire}>
                {row.test.passed} 通过 · {row.test.failed} 失败 ·{" "}
                {row.test.inconclusive} 待定
              </span>
              <span
                className={`${styles.agStat} ${
                  row.test.failed > 0
                    ? styles.agStatBad
                    : row.test.inconclusive > 0
                      ? styles.agStatOff
                      : styles.agStatOk
                }`}
              >
                {row.test.failed > 0
                  ? "✗"
                  : row.test.inconclusive > 0
                    ? "…"
                    : "✓"}
              </span>
            </div>
          ))
        )}
        {testJobs.length > 0 ? (
          <>
            <div className={styles.secTitle}>测试作业</div>
            {testJobs.map((job) => (
              <div key={job.id} className={styles.evRowStack}>
                <div className={styles.evRowLine}>
                  <span className={styles.agName}>{jobKindLabel(job.kind)}</span>
                  <span style={{ flex: 1 }} />
                  <span
                    className={`${styles.agStat} ${
                      jobFailed(job.status)
                        ? styles.agStatBad
                        : job.status === "succeeded"
                          ? styles.agStatOk
                          : styles.agStatOff
                    }`}
                  >
                    {jobStatusText(job.status)}
                  </span>
                </div>
                {jobFailed(job.status) ? (
                  <div
                    className={styles.rowReason}
                    title={jobFailureReason(job)}
                  >
                    {jobFailureReason(job)}
                  </div>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

const EVIDENCE_OUTCOME_LABEL: Record<
  OntoCodeEvidenceRecord["outcome"],
  string
> = {
  passed: "通过",
  failed: "失败",
  inconclusive: "待定",
  informational: "信息",
};

/** 引擎自己的证据种类换成人话；其余种类保留原词，不硬塞一个猜的中文。 */
const EVIDENCE_KIND_LABEL: Record<string, string> = {
  harness_receipt: "阶段回执",
  harness_failure_receipt: "失败回执",
  harness_ontology_analysis: "本体理解",
  harness_scope: "范围分析",
  harness_blueprint: "蓝图",
  harness_build: "代码生成",
  harness_simulation: "推演",
  harness_test: "测试",
  harness_debug: "修复",
  harness_regression: "回归",
  harness_promotion: "上线准备",
  harness_deploy: "部署",
  harness_production_analysis: "线上分析",
};

export function evidenceKindLabel(kind: string): string {
  const failed = kind.endsWith("_failure");
  const baseKind = failed ? kind.slice(0, -"_failure".length) : kind;
  const label = EVIDENCE_KIND_LABEL[baseKind];
  if (label) return failed ? `${label}失败记录` : label;
  const fallback = productFacingOntoCodeText(baseKind.replace(/_/g, " "));
  return failed ? `${fallback} · 失败` : fallback;
}

/** 可打开的产物。解析不出就不给入口——绝不编一个点不动的链接。 */
export interface EvidenceArtifactTarget {
  artifactId: string;
  name: string;
}

export interface InspectorEvidenceProps {
  evidence: OntoCodeEvidenceRecord[];
  /** 用来把每条证据落回它是哪个阶段产的。 */
  jobs?: OntoCodeHarnessJob[];
  resolveArtifact?: (
    artifactVersionId: string,
  ) => EvidenceArtifactTarget | null;
  onOpenArtifact?: (artifactId: string) => void;
  loading?: boolean;
  errorText?: string | null;
}

/**
 * 空证据同样分两种：这次一个阶段都没跑，还是跑了 N 个阶段却一条证据都没落。
 * 后者是链条上的真实缺口，含糊成「暂无证据」就等于把它藏起来。
 */
/**
 * 证据 → 它引用的那份产物。只认已取回的产物版本：认不出就返回 null，
 * 面板据此不给入口。宁可少一个按钮，也不给一个点了没反应的按钮。
 */
export function makeEvidenceArtifactResolver(
  items: OntoCodeArtifactSummaryItem[],
): (artifactVersionId: string) => EvidenceArtifactTarget | null {
  const byVersionId = new Map<string, EvidenceArtifactTarget>();
  for (const item of items) {
    byVersionId.set(item.latestVersion.id, {
      artifactId: item.artifact.id,
      name: shortName(item.artifact.logicalName),
    });
  }
  return (artifactVersionId) => byVersionId.get(artifactVersionId) ?? null;
}

export function evidenceEmptyText(jobCount: number): string {
  return jobCount > 0
    ? `已运行 ${jobCount} 个阶段，但没有记录证据。`
    : "本次会话还没有运行任何阶段，因此没有证据。";
}

function evidenceTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Session-level evidence, including job/change records not tied to an artifact. */
export function InspectorEvidenceView(props: InspectorEvidenceProps) {
  const evidence = [...props.evidence].sort((a, b) => b.createdAt - a.createdAt);
  const jobs = props.jobs ?? [];
  const stageByJobId = new Map(
    jobs.map((job) => [job.id, jobKindLabel(job.kind)] as const),
  );
  const validPassed = evidence.filter(
    (record) => record.state === "valid" && record.outcome === "passed",
  ).length;
  const failed = evidence.filter(
    (record) => record.state === "valid" && record.outcome === "failed",
  ).length;
  const stale = evidence.filter((record) => record.state === "stale").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className={styles.iHead}>
        <h3 className={styles.iHeadTitle}>证据</h3>
      </div>
      {evidence.length > 0 ? (
        <div className={styles.ovSum}>
          {/* 全是「仅记录」的时候，一个「0 通过」会被读成「全挂了」。
              先报真实条数，判定类的计数只在真的存在时才出现。 */}
          <span className={styles.ovChip}>{evidence.length} 条记录</span>
          {validPassed > 0 ? (
            <span className={`${styles.ovChip} ${styles.ovChipOk}`}>
              {validPassed} 通过
            </span>
          ) : null}
          {failed > 0 ? (
            <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
              {failed} 失败
            </span>
          ) : null}
          {stale > 0 ? (
            <span className={styles.ovChip}>{stale} 已失效</span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.iBody}>
        {props.errorText ? (
          <div className={styles.iEmpty}>{props.errorText}</div>
        ) : props.loading && evidence.length === 0 ? (
          <div className={styles.iEmpty}>正在读取证据…</div>
        ) : evidence.length === 0 ? (
          <div className={styles.iEmpty}>{evidenceEmptyText(jobs.length)}</div>
        ) : (
          evidence.map((record) => {
            const isStale = record.state === "stale";
            const summary = productFacingOntoCodeText(record.summary);
            const staleReason = record.staleReason
              ? productFacingOntoCodeText(record.staleReason)
              : null;
            const statusLabel = isStale
              ? "已失效"
              : EVIDENCE_OUTCOME_LABEL[record.outcome];
            const statusClass = isStale
              ? styles.agStatOff
              : record.outcome === "passed"
                ? styles.agStatOk
                : record.outcome === "failed"
                  ? styles.agStatBad
                  : styles.agStatOff;
            const stage = record.harnessJobId
              ? (stageByJobId.get(record.harnessJobId) ?? "其它阶段")
              : "会话";
            const target = record.artifactVersionId
              ? (props.resolveArtifact?.(record.artifactVersionId) ?? null)
              : null;
            return (
              <div key={record.id} className={styles.evRowStack}>
                <div className={styles.evRowLine}>
                  <span className={styles.agName} style={{ minWidth: 92 }}>
                    {evidenceKindLabel(record.kind)}
                  </span>
                  <span className={styles.agWire} title={summary}>
                    {summary}
                  </span>
                  <span className={`${styles.agStat} ${statusClass}`}>
                    {statusLabel}
                  </span>
                </div>
                <div className={styles.evRowLine}>
                  <span className={styles.evMeta}>
                    {stage} · {evidenceTime(record.createdAt)}
                  </span>
                  {isStale && staleReason ? (
                    <span className={styles.evMeta} title={staleReason}>
                      {staleReason}
                    </span>
                  ) : null}
                  <span style={{ flex: 1 }} />
                  {target ? (
                    <button
                      type="button"
                      className={styles.mini}
                      onClick={() => props.onOpenArtifact?.(target.artifactId)}
                    >
                      查看产物 · {target.name}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Connected 包装 ---------------------------- */

export type InspectorTab =
  | "artifacts"
  | "map"
  | "changes"
  | "tests"
  | "evidence"
  | "connections"
  | "log"
  | "reasoning";

export const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "artifacts", label: "产物" },
  { id: "map", label: "地图" },
  { id: "changes", label: "变更" },
  { id: "tests", label: "测试" },
  { id: "evidence", label: "证据" },
  { id: "connections", label: "连接" },
  { id: "log", label: "日志" },
  { id: "reasoning", label: "推理" },
];

/**
 * Fullscreen is a shell affordance, not a per-view one: the control lives on
 * the inspector tab bar, so every tab — including views owned elsewhere — gets
 * it without wiring anything of its own.
 */
export const INSPECTOR_FULLSCREEN_EXIT_KEY = "Escape";

/** Esc, and only Esc, leaves fullscreen. */
export function isInspectorFullscreenExitKey(key: string): boolean {
  return key === INSPECTOR_FULLSCREEN_EXIT_KEY;
}

const FULLSCREEN_LABEL = { enter: "全屏", exit: "退出全屏" } as const;

export interface InspectorTabBarProps {
  tabs: ReadonlyArray<{ id: InspectorTab; label: string }>;
  activeTab: InspectorTab;
  fullscreen: boolean;
  onSelectTab: (tab: InspectorTab) => void;
  onToggleFullscreen: () => void;
}

export function InspectorTabBar(props: InspectorTabBarProps) {
  const label = props.fullscreen
    ? FULLSCREEN_LABEL.exit
    : FULLSCREEN_LABEL.enter;
  return (
    <div className={styles.iTabBar}>
      <div className={styles.tabs}>
        {props.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={
              props.activeTab === tab.id
                ? `${styles.tab} ${styles.tabOn}`
                : styles.tab
            }
            aria-current={props.activeTab === tab.id ? "true" : undefined}
            onClick={() => props.onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`${styles.btn} ${styles.iTabBarAction}`}
        aria-label={label}
        aria-pressed={props.fullscreen}
        onClick={props.onToggleFullscreen}
      >
        {label}
      </button>
    </div>
  );
}

export interface StageDocOpenRequest {
  requestId: number;
  kind: StageDocKind;
}

/** 从别的 tab（今天是「证据」）跳进某个产物的钻取视图。 */
export interface ArtifactOpenRequest {
  requestId: number;
  artifactId: string;
}

export interface ArtifactInspectorProps {
  tenant: string;
  sessionId: string;
  candidateLabel: string | null;
  candidateStatus?: OntoCodeArtifactDeliveryStatus | null;
  buildInProgress?: boolean;
  overview?: OntoCodeSuiteOverview | null;
  items: OntoCodeArtifactSummaryItem[];
  evidence: OntoCodeEvidenceRecord[];
  onCollapse: () => void;
  openStageDocRequest?: StageDocOpenRequest | null;
  openArtifactRequest?: ArtifactOpenRequest | null;
}

export function ArtifactInspectorConnected(props: ArtifactInspectorProps) {
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [openStageDoc, setOpenStageDoc] = useState<{
    artifactId: string;
    kind: StageDocKind;
  } | null>(null);
  const [stageContent, setStageContent] = useState<string | null>(null);
  const handledStageRequestRef = useRef<string | null>(null);
  const handledArtifactRequestRef = useRef<string | null>(null);

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
            ? (receipt as { content: string }).content
            : JSON.stringify(receipt, null, 2);
        setContent(text);
      },
    });
  };

  const loadContentMutate = loadContent.mutate;

  const openArtifact = useCallback(
    (artifactId: string) => {
      const item = props.items.find((i) => i.artifact.id === artifactId);
      if (!item) return;
      setOpenStageDoc(null);
      setStageContent(null);
      setOpenArtifactId(artifactId);
      setActiveVersionId(item.latestVersion.id);
      setContent(null);
      loadContentMutate(item.latestVersion.id, {
        onSuccess: (receipt) => {
          const text =
            typeof (receipt as { content?: unknown }).content === "string"
              ? (receipt as { content: string }).content
              : JSON.stringify(receipt, null, 2);
          setContent(text);
        },
      });
    },
    [loadContentMutate, props.items],
  );

  // 证据行点进来的产物。和阶段文档请求同一套纪律：产物还没随查询回来就
  // 保持挂起，不静默退回概览。
  useEffect(() => {
    const request = props.openArtifactRequest;
    if (!request) return;
    const requestKey = `${props.sessionId}:${request.requestId}`;
    if (handledArtifactRequestRef.current === requestKey) return;
    if (!props.items.some((i) => i.artifact.id === request.artifactId)) return;
    handledArtifactRequestRef.current = requestKey;
    openArtifact(request.artifactId);
  }, [openArtifact, props.items, props.openArtifactRequest, props.sessionId]);

  const openStageContent = useCallback(
    (artifactId: string, kind: StageDocKind) => {
      const item = props.items.find((i) => i.artifact.id === artifactId);
      if (!item) return;
      setOpenArtifactId(null);
      setActiveVersionId(null);
      setContent(null);
      setOpenStageDoc({ artifactId, kind });
      setStageContent(null);
      loadContentMutate(item.latestVersion.id, {
        onSuccess: (receipt) => {
          const text =
            typeof (receipt as { content?: unknown }).content === "string"
              ? (receipt as { content: string }).content
              : JSON.stringify(receipt, null, 2);
          setStageContent(text);
        },
      });
    },
    [loadContentMutate, props.items],
  );

  useEffect(() => {
    const request = props.openStageDocRequest;
    if (!request) return;
    const requestKey = `${props.sessionId}:${request.requestId}`;
    if (handledStageRequestRef.current === requestKey) return;
    const row = latestStageDocumentForKind(props.items, request.kind);
    // A completed job and its artifact list can arrive in separate query
    // refreshes. Keep the request pending until the requested immutable
    // artifact becomes visible instead of silently falling back to overview.
    if (!row) return;
    handledStageRequestRef.current = requestKey;
    openStageContent(row.item.artifact.id, row.kind);
  }, [
    openStageContent,
    props.items,
    props.openStageDocRequest,
    props.sessionId,
  ]);

  if (openStageDoc) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className={styles.iHead}>
          <div>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setOpenStageDoc(null);
                setStageContent(null);
              }}
            >
              ‹ 概览
            </button>
          </div>
          <h3 className={styles.iHeadTitle} style={{ marginLeft: 4 }}>
            {stageDocLabel(openStageDoc.kind)}
          </h3>
          <span style={{ flex: 1 }} />
        </div>
        <div className={styles.iBody}>
          <StageDocView
            kind={openStageDoc.kind}
            content={stageContent}
            loading={loadContent.isPending && stageContent === null}
          />
        </div>
      </div>
    );
  }

  if (!openItem) {
    return (
      <InspectorOverviewView
        candidateLabel={props.candidateLabel}
        candidateStatus={props.candidateStatus}
        buildInProgress={props.buildInProgress}
        overview={props.overview}
        items={props.items}
        evidence={props.evidence}
        onCollapse={props.onCollapse}
        onOpenStageDoc={openStageContent}
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
