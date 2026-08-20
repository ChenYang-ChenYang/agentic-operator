"use client";

import {
  OntoCodeAnalystPresentationV1Schema,
  type OntoCodeAnalystBlock,
  type OntoCodeAnalystCell,
  type OntoCodeAnalystEvidence,
  type OntoCodeAnalystPresentationV1,
  type OntoCodeAnalystTableBlock,
} from "@agentic/contracts";
import React from "react";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";

type AnalystCell = OntoCodeAnalystCell;
type EvidenceKind = OntoCodeAnalystEvidence;
type TableBlock = OntoCodeAnalystTableBlock;
type AnalystBlock = OntoCodeAnalystBlock;
export type AnalystPresentation = OntoCodeAnalystPresentationV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, max);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function stringList(value: unknown, limit = 40, maxLength = 320): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
        .map((entry) => entry.trim().slice(0, maxLength))
        .slice(0, limit)
    : [];
}

function cell(value: unknown): AnalystCell {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 320);
  if (Array.isArray(value)) return stringList(value, 12, 320);
  return null;
}

function evidenceList(value: unknown): EvidenceKind[] {
  const allowed = new Set<EvidenceKind>([
    "ontology_structure",
    "live_probe",
    "verified_interpretation",
  ]);
  return stringList(value, 3, 40).filter((entry): entry is EvidenceKind =>
    allowed.has(entry as EvidenceKind),
  );
}

/**
 * Parse the server-selected Analyst protocol without accepting arbitrary
 * component props. The client caps every collection again so an old or corrupt
 * artifact cannot turn the inspector into an unbounded render.
 */
export function parseAnalystPresentation(
  value: unknown,
): AnalystPresentation | null {
  if (!isRecord(value) || !isRecord(value.presentation)) return null;
  const source = value.presentation;
  if (source.schema !== "ontocode-analysis-presentation/v1") return null;
  const domain = text(source.domain, 160);
  const title = text(source.title, 240);
  if (!domain || !title || !Array.isArray(source.blocks)) return null;
  const requestSource = isRecord(source.request) ? source.request : {};
  const blocks = source.blocks.slice(0, 40).flatMap((raw): AnalystBlock[] => {
    if (!isRecord(raw)) return [];
    const id = text(raw.id, 200);
    const blockTitle = text(raw.title, 500);
    if (!id || !blockTitle) return [];
    const description = text(raw.description, 2_000);
    const base = {
      id,
      title: blockTitle,
      ...(description ? { description } : {}),
      evidence: evidenceList(raw.evidence),
    };
    if (raw.kind === "metrics" && Array.isArray(raw.items)) {
      return [
        {
          ...base,
          kind: "metrics",
          items: raw.items.slice(0, 24).flatMap((rawItem) => {
            if (!isRecord(rawItem)) return [];
            const itemId = text(rawItem.id, 200);
            const label = text(rawItem.label, 200);
            const value =
              typeof rawItem.value === "number" &&
              Number.isFinite(rawItem.value)
                ? rawItem.value
                : typeof rawItem.value === "string"
                  ? rawItem.value.slice(0, 320)
                  : null;
            if (!itemId || !label || value === null) return [];
            const tone =
              rawItem.tone === "positive" ||
              rawItem.tone === "warning" ||
              rawItem.tone === "critical" ||
              rawItem.tone === "neutral"
                ? rawItem.tone
                : undefined;
            return [
              {
                id: itemId,
                label,
                value,
                ...(text(rawItem.unit, 40)
                  ? { unit: text(rawItem.unit, 40)! }
                  : {}),
                ...(tone ? { tone } : {}),
                ...(text(rawItem.detail, 1_000)
                  ? { detail: text(rawItem.detail, 1_000)! }
                  : {}),
              },
            ];
          }),
        },
      ];
    }
    if (
      raw.kind === "table" &&
      Array.isArray(raw.columns) &&
      Array.isArray(raw.rows)
    ) {
      const seenColumnKeys = new Set<string>();
      const columns = raw.columns
        .slice(0, 24)
        .flatMap((rawColumn): TableBlock["columns"] => {
          if (!isRecord(rawColumn)) return [];
          const key = text(rawColumn.key, 120);
          const label = text(rawColumn.label, 200);
          const dataType: TableBlock["columns"][number]["dataType"] =
            rawColumn.dataType === "number" ||
            rawColumn.dataType === "boolean" ||
            rawColumn.dataType === "tags" ||
            rawColumn.dataType === "status" ||
            rawColumn.dataType === "text"
              ? rawColumn.dataType
              : "text";
          if (!key || !label || seenColumnKeys.has(key)) return [];
          seenColumnKeys.add(key);
          return [{ key, label, dataType }];
        });
      if (columns.length === 0) return [];
      const rows = raw.rows.slice(0, 100).flatMap((rawRow) => {
        if (!isRecord(rawRow)) return [];
        const row: Record<string, AnalystCell> = {};
        for (const column of columns)
          row[column.key] = cell(rawRow[column.key]);
        return [row];
      });
      const totalRows = Math.max(count(raw.totalRows), rows.length);
      return [
        {
          ...base,
          kind: "table",
          columns,
          rows,
          totalRows,
          truncated:
            raw.truncated === true ||
            raw.columns.length > columns.length ||
            raw.rows.length > rows.length,
        },
      ];
    }
    if (raw.kind === "list" && Array.isArray(raw.items)) {
      return [
        {
          ...base,
          kind: "list",
          items: raw.items.slice(0, 80).flatMap((rawItem) => {
            if (!isRecord(rawItem)) return [];
            const itemId = text(rawItem.id, 200);
            const itemTitle = text(rawItem.title, 500);
            if (!itemId || !itemTitle) return [];
            const severity =
              rawItem.severity === "warning" ||
              rawItem.severity === "critical" ||
              rawItem.severity === "info"
                ? rawItem.severity
                : undefined;
            return [
              {
                id: itemId,
                title: itemTitle,
                ...(text(rawItem.detail, 1_000)
                  ? { detail: text(rawItem.detail, 1_000)! }
                  : {}),
                ...(severity ? { severity } : {}),
                ...(stringList(rawItem.refs, 24, 200).length
                  ? { refs: stringList(rawItem.refs, 24, 200) }
                  : {}),
              },
            ];
          }),
          totalItems: Math.max(
            count(raw.totalItems),
            Math.min(raw.items.length, 80),
          ),
          truncated: raw.truncated === true || raw.items.length > 80,
        },
      ];
    }
    if (
      raw.kind === "relationship" &&
      Array.isArray(raw.nodes) &&
      Array.isArray(raw.edges)
    ) {
      const nodeIds = new Set<string>();
      const nodes = raw.nodes.slice(0, 80).flatMap((rawNode) => {
        if (!isRecord(rawNode)) return [];
        const nodeId = text(rawNode.id, 200);
        const label = text(rawNode.label, 200);
        const entityType = text(rawNode.entityType, 120);
        if (!nodeId || !label || !entityType || nodeIds.has(nodeId)) return [];
        nodeIds.add(nodeId);
        return [{ id: nodeId, label, entityType }];
      });
      const edges = raw.edges.slice(0, 120).flatMap((rawEdge) => {
        if (!isRecord(rawEdge)) return [];
        const edgeId = text(rawEdge.id, 200);
        const sourceId = text(rawEdge.source, 200);
        const targetId = text(rawEdge.target, 200);
        const label = text(rawEdge.label, 200);
        return edgeId &&
          sourceId &&
          targetId &&
          label &&
          nodeIds.has(sourceId) &&
          nodeIds.has(targetId)
          ? [{ id: edgeId, source: sourceId, target: targetId, label }]
          : [];
      });
      return [
        {
          ...base,
          kind: "relationship",
          nodes,
          edges,
          totalNodes: Math.max(count(raw.totalNodes), nodes.length),
          totalEdges: Math.max(count(raw.totalEdges), edges.length),
          truncated:
            raw.truncated === true ||
            raw.nodes.length > nodes.length ||
            raw.edges.length > edges.length,
        },
      ];
    }
    return [];
  });
  const parsed = OntoCodeAnalystPresentationV1Schema.safeParse({
    schema: "ontocode-analysis-presentation/v1",
    domain,
    title,
    request: {
      question: text(requestSource.question, 1_000),
      focus: stringList(requestSource.focus, 8, 160),
      preferredViews: stringList(requestSource.preferredViews, 4, 40).filter(
        (entry): entry is AnalystBlock["kind"] =>
          entry === "metrics" ||
          entry === "table" ||
          entry === "list" ||
          entry === "relationship",
      ),
    },
    blocks,
  });
  return parsed.success ? parsed.data : null;
}

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  ontology_structure: "本体结构",
  live_probe: "实时探针",
  verified_interpretation: "引用已核验",
};

const SEVERITY_LABEL = {
  info: "信息",
  warning: "需关注",
  critical: "严重",
} as const;

function StatusValue({ value }: { value: AnalystCell }) {
  const normalized = String(value ?? "").toLowerCase();
  const tone =
    /^(?:ok|ready|available|covered|connected|confirmed|verified)$/u.test(
      normalized,
    )
      ? styles.analystStatusOk
      : /failed|missing|blocked|critical|gap|unavailable/u.test(normalized)
        ? styles.analystStatusBad
        : /need|pending|warning|ambiguous|unverified|isolated|not_/u.test(
              normalized,
            )
          ? styles.analystStatusWarn
          : styles.analystStatusNeutral;
  return (
    <span className={`${styles.analystStatus} ${tone}`}>
      {String(value ?? "—")}
    </span>
  );
}

function CellValue(props: {
  value: AnalystCell;
  dataType: TableBlock["columns"][number]["dataType"];
}) {
  if (props.dataType === "status") return <StatusValue value={props.value} />;
  if (Array.isArray(props.value)) {
    if (props.value.length === 0)
      return <span className={styles.analystEmpty}>—</span>;
    return (
      <span className={styles.analystTags}>
        {props.value.map((entry, index) => (
          <span key={`${entry}-${index}`} className={styles.analystTag}>
            {entry}
          </span>
        ))}
      </span>
    );
  }
  if (props.value === null || props.value === "") {
    return <span className={styles.analystEmpty}>—</span>;
  }
  if (typeof props.value === "boolean") return <>{props.value ? "是" : "否"}</>;
  return <>{String(props.value)}</>;
}

function BlockHeader({
  block,
  titleId,
}: {
  block: AnalystBlock;
  titleId: string;
}) {
  return (
    <div className={styles.analystBlockHead}>
      <div>
        <h4 id={titleId} className={styles.analystBlockTitle}>
          {block.title}
          {/* 区块说明长段默认收进 HelpTip，不常驻占屏。 */}
          {block.description ? <HelpTip>{block.description}</HelpTip> : null}
        </h4>
      </div>
      {block.evidence.length > 0 ? (
        <div className={styles.analystEvidence}>
          {block.evidence.map((entry) => (
            <span key={entry}>{EVIDENCE_LABEL[entry]}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AnalystBlockView({ block }: { block: AnalystBlock }) {
  const titleId = React.useId();
  if (block.kind === "metrics") {
    return (
      <section className={styles.analystBlock} aria-labelledby={titleId}>
        <BlockHeader block={block} titleId={titleId} />
        <div className={styles.analystMetrics}>
          {block.items.map((item) => (
            <div
              key={item.id}
              className={`${styles.analystMetric} ${
                item.tone === "positive"
                  ? styles.analystMetricPositive
                  : item.tone === "warning"
                    ? styles.analystMetricWarning
                    : item.tone === "critical"
                      ? styles.analystMetricCritical
                      : ""
              }`}
            >
              <div className={styles.analystMetricLabel}>{item.label}</div>
              <div className={styles.analystMetricValue}>
                {item.value}
                {item.unit ? <small>{item.unit}</small> : null}
              </div>
              {item.detail ? (
                <div className={styles.analystMetricDetail}>{item.detail}</div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (block.kind === "table") {
    return (
      <section className={styles.analystBlock} aria-labelledby={titleId}>
        <BlockHeader block={block} titleId={titleId} />
        <div
          className={`${styles.docTableWrap} ${styles.analystTableWrap}`}
          role="region"
          aria-labelledby={titleId}
          tabIndex={0}
        >
          <table className={`${styles.docTable} ${styles.analystTable}`}>
            <caption className={styles.analystSrOnly}>
              {block.title}
              {block.description ? `：${block.description}` : ""}
            </caption>
            <thead>
              <tr>
                {block.columns.map((column, columnIndex) => (
                  <th key={column.key} scope="col">
                    {columnIndex === 0 ? (
                      <span className={styles.analystRowHead}>
                        {column.label}
                      </span>
                    ) : (
                      column.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${block.id}-${rowIndex}`}>
                  {block.columns.map((column, columnIndex) => {
                    const value = (
                      <CellValue
                        value={row[column.key] ?? null}
                        dataType={column.dataType}
                      />
                    );
                    // 首列被 sticky 钉在左边，而 sticky 盒不裁剪自身溢出。
                    // 内层块把这一列的 max-content 贡献钉在上限内并强制换行，
                    // 长本体 id 因此整段换行留在格子里，而不是盖到下一列上。
                    return columnIndex === 0 ? (
                      <th key={column.key} scope="row">
                        <span className={styles.analystRowHead}>{value}</span>
                      </th>
                    ) : (
                      <td key={column.key}>{value}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {block.rows.length === 0 ? (
          <div className={styles.analystBlockEmpty}>无数据</div>
        ) : null}
        {block.truncated ? (
          <div className={styles.analystTruncated}>
            显示 {block.rows.length}/{block.totalRows} 行
          </div>
        ) : null}
      </section>
    );
  }
  if (block.kind === "list") {
    return (
      <section className={styles.analystBlock} aria-labelledby={titleId}>
        <BlockHeader block={block} titleId={titleId} />
        <ul className={styles.analystList}>
          {block.items.map((item) => (
            <li
              key={item.id}
              className={`${styles.analystListItem} ${
                item.severity === "critical"
                  ? styles.analystListCritical
                  : item.severity === "warning"
                    ? styles.analystListWarning
                    : ""
              }`}
            >
              <div className={styles.analystListTitleRow}>
                <div className={styles.analystListTitle}>{item.title}</div>
                {item.severity ? (
                  <span
                    className={`${styles.analystSeverity} ${
                      item.severity === "critical"
                        ? styles.analystSeverityCritical
                        : item.severity === "warning"
                          ? styles.analystSeverityWarning
                          : styles.analystSeverityInfo
                    }`}
                  >
                    {SEVERITY_LABEL[item.severity]}
                  </span>
                ) : null}
              </div>
              {item.detail ? (
                <div className={styles.analystListDetail}>{item.detail}</div>
              ) : null}
              {item.refs?.length ? (
                <div className={styles.analystRefs}>
                  {item.refs.map((ref) => (
                    <span key={ref}>{ref}</span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {block.truncated ? (
          <div className={styles.analystTruncated}>
            仅显示 {block.items.length}/{block.totalItems} 项。
          </div>
        ) : null}
      </section>
    );
  }

  const labels = new Map(block.nodes.map((node) => [node.id, node.label]));
  return (
    <section className={styles.analystBlock} aria-labelledby={titleId}>
      <BlockHeader block={block} titleId={titleId} />
      <ul
        className={styles.analystNodeCloud}
        aria-label={`${block.title} 节点`}
      >
        {block.nodes.map((node) => (
          <li key={node.id} className={styles.analystNode}>
            <small>{node.entityType}</small>
            {node.label}
          </li>
        ))}
      </ul>
      <ul className={styles.analystEdges} aria-label={`${block.title} 关系`}>
        {block.edges.map((edge) => (
          <li
            key={edge.id}
            className={styles.analystEdge}
            aria-label={`${labels.get(edge.source) ?? edge.source} 通过 ${edge.label} 指向 ${labels.get(edge.target) ?? edge.target}`}
          >
            <span>{labels.get(edge.source) ?? edge.source}</span>
            <span className={styles.analystEdgeLink}>
              <small>{edge.label}</small>
              <i aria-hidden="true">→</i>
            </span>
            <span>{labels.get(edge.target) ?? edge.target}</span>
          </li>
        ))}
      </ul>
      {block.truncated ? (
        <div className={styles.analystTruncated}>
          关系图已限幅：显示 {block.nodes.length}/{block.totalNodes} 节点 ·{" "}
          {block.edges.length}/{block.totalEdges} 边。
        </div>
      ) : null}
    </section>
  );
}

export function AnalystPresentationView({
  presentation,
}: {
  presentation: AnalystPresentation;
}) {
  return (
    <div className={styles.analystWrap}>
      <header className={styles.analystHero}>
        <h3>{presentation.title}</h3>
        {presentation.request.question ? (
          <p>{presentation.request.question}</p>
        ) : null}
        {presentation.request.focus.length > 0 ? (
          <div className={styles.analystFocus}>
            {presentation.request.focus.map((entry) => (
              <span key={entry}>{entry}</span>
            ))}
          </div>
        ) : null}
      </header>
      {presentation.blocks.map((block) => (
        <AnalystBlockView key={block.id} block={block} />
      ))}
      {presentation.blocks.length === 0 ? (
        <div className={styles.iEmpty}>无结构化结果</div>
      ) : null}
    </div>
  );
}
