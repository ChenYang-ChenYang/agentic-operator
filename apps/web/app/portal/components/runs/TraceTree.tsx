"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Empty,
  Icon,
  StatusDot,
  type StatusName,
} from "@/app/portal/components";
import { fmtDur, fmtNum } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { RunListRow, StepRow } from "@/lib/hooks/useRuns";
import { useRun, useRunArtifacts, useRuns } from "@/lib/hooks/useRuns";
import { useRunTraceAll, type RunTraceEvent } from "@/lib/hooks/useAgentStudio";

const STATUS_TO_DOT: Record<string, StatusName> = {
  running: "running",
  queued: "waiting",
  waiting: "waiting",
  ok: "ok",
  failed: "failed",
  cancelled: "cancelled",
};

interface TraceNode {
  run: RunListRow;
  steps: StepRow[];
}

export interface TraceEntry {
  kind: "step" | "child";
  step?: StepRow;
  child?: RunListRow;
}

/** Stable pure composition retained for trace ordering regression tests. */
export function composeTrace(
  steps: StepRow[],
  children: RunListRow[],
): TraceEntry[] {
  return [
    ...[...steps]
      .sort((a, b) => a.ord - b.ord)
      .map((step) => ({ kind: "step" as const, step })),
    ...children.map((child) => ({ kind: "child" as const, child })),
  ];
}

const MAX_DEPTH = 6;

export function TraceTree({
  node,
  depth = 0,
  tenant,
}: {
  node: TraceNode;
  depth?: number;
  tenant: string;
}) {
  const { t } = useI18n();
  const childrenQuery = useRuns({ parentRunId: node.run.id, limit: 50 });
  const traceQuery = useRunTraceAll(
    node.run.id,
    ["queued", "running", "waiting"].includes(node.run.status),
  );
  const artifactsQuery = useRunArtifacts(node.run.id);
  const children = childrenQuery.data ?? [];
  const entries = composeTrace(node.steps, children);
  const eventsByStep = new Map<string, RunTraceEvent[]>();
  const runEvents: RunTraceEvent[] = [];
  for (const event of traceQuery.data?.events ?? []) {
    if (!event.stepId) {
      runEvents.push(event);
      continue;
    }
    const current = eventsByStep.get(event.stepId) ?? [];
    current.push(event);
    eventsByStep.set(event.stepId, current);
  }

  if (childrenQuery.isError || traceQuery.isError) {
    return (
      <Empty
        title={t("traceTree.loadFailed")}
        hint={(childrenQuery.error ?? traceQuery.error)?.message ?? ""}
      />
    );
  }
  if (
    childrenQuery.isLoading &&
    !childrenQuery.data &&
    node.steps.length === 0
  ) {
    return <Empty title={t("traceTree.loading")} hint={node.run.id} />;
  }
  if (entries.length === 0 && runEvents.length === 0) {
    return (
      <Empty
        title={t("traceTree.emptyTitle")}
        hint={t("traceTree.emptyHint")}
      />
    );
  }

  return (
    <div
      style={{
        borderLeft: depth > 0 ? "1px dashed var(--border-2)" : "none",
        marginLeft: depth > 0 ? 12 : 0,
        paddingLeft: depth > 0 ? 12 : 0,
      }}
    >
      {entries.map((entry, index) =>
        entry.kind === "step" && entry.step ? (
          <StepRowItem
            key={`s-${entry.step.id}-${index}`}
            step={entry.step}
            events={eventsByStep.get(entry.step.id) ?? []}
            inputArtifactId={
              artifactsQuery.data?.find(
                (artifact) =>
                  artifact.stepId === entry.step!.id &&
                  artifact.role === "step_input",
              )?.id
            }
            outputArtifactId={
              artifactsQuery.data?.find(
                (artifact) =>
                  artifact.stepId === entry.step!.id &&
                  artifact.role === "step_output",
              )?.id
            }
          />
        ) : entry.kind === "child" && entry.child ? (
          <ChildRunBlock
            key={`c-${entry.child.id}`}
            child={entry.child}
            depth={depth + 1}
            tenant={tenant}
          />
        ) : null,
      )}
      {runEvents.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              padding: "5px 8px",
              color: "var(--text-3)",
              fontSize: 10.5,
            }}
          >
            RUN EVENTS
          </div>
          <TraceEvidenceList events={runEvents} />
        </div>
      )}
    </div>
  );
}

function StepRowItem({
  step,
  events,
  inputArtifactId,
  outputArtifactId,
}: {
  step: StepRow;
  events: RunTraceEvent[];
  inputArtifactId?: string;
  outputArtifactId?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          display: "grid",
          gridTemplateColumns: "20px 1fr 110px 80px 18px",
          gap: 10,
          alignItems: "center",
          padding: "7px 8px",
          border: 0,
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <StatusDot status={STATUS_TO_DOT[step.status] ?? "idle"} />
        <div style={{ minWidth: 0 }}>
          <div
            className="mono"
            title={step.name}
            style={{
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.name}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
            {t("traceTree.stepLabel")} {step.ord} · {step.type}
            {step.model ? ` · ${step.model}` : ""}
            {events.length ? ` · ${events.length} trace` : ""}
          </div>
        </div>
        <div className="mono" style={rightMetaStyle}>
          {step.tokensIn != null && step.tokensOut != null
            ? `${fmtNum(step.tokensIn)} · ${fmtNum(step.tokensOut)}`
            : "—"}
        </div>
        <div
          className="mono"
          style={{ ...rightMetaStyle, color: stepTone(step) }}
        >
          {fmtDur(step.durationMs)}
        </div>
        <Icon
          name="chevron-right"
          size={10}
          style={{
            color: "var(--text-3)",
            transform: open ? "rotate(90deg)" : "none",
          }}
        />
      </button>
      {open && (
        <div
          style={{
            padding: "8px 10px 10px 38px",
            background: "var(--panel-2)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginBottom: events.length ? 8 : 0,
            }}
          >
            <StepPayload
              title="INPUT"
              value={step.input}
              artifactId={inputArtifactId}
            />
            <StepPayload
              title="OUTPUT"
              value={step.output}
              artifactId={outputArtifactId}
            />
          </div>
          <TraceEvidenceList events={events} />
        </div>
      )}
    </div>
  );
}

function StepPayload({
  title,
  value,
  artifactId,
}: {
  title: string;
  value: unknown;
  artifactId?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 5,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <div
        className="mono"
        style={{
          padding: "5px 7px",
          fontSize: 9.5,
          color: "var(--text-3)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {title}
        {artifactId && (
          <a
            href={`/v1/artifacts/${encodeURIComponent(artifactId)}`}
            style={{ float: "right", color: "var(--signal)" }}
          >
            full ↓
          </a>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 7,
          maxHeight: 220,
          overflow: "auto",
          fontSize: 10.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {value === undefined ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function TraceEvidenceList({ events }: { events: RunTraceEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {events.map((event) => (
        <div
          key={event.id}
          style={{
            display: "grid",
            gridTemplateColumns: "75px minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "start",
            padding: "7px 8px",
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: "var(--panel)",
          }}
        >
          <Badge
            tone={
              event.status === "failed"
                ? "red"
                : event.kind === "tool"
                  ? "blue"
                  : event.kind === "llm"
                    ? "violet"
                    : "muted"
            }
          >
            {event.kind}
          </Badge>
          <div style={{ minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10.5 }}>
              {event.name}
            </div>
            {event.summary && (
              <div
                style={{
                  marginTop: 3,
                  fontSize: 10.5,
                  color: "var(--text-2)",
                }}
              >
                {event.summary}
              </div>
            )}
            {event.data && (
              <pre
                style={{
                  margin: "5px 0 0",
                  maxHeight: 120,
                  overflow: "auto",
                  color: "var(--text-3)",
                  fontSize: 9.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                {JSON.stringify(event.data, null, 2)}
              </pre>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <span className="mono" style={rightMetaStyle}>
              {fmtDur(event.durationMs)}
            </span>
            {event.artifactId && (
              <a
                href={`/v1/artifacts/${encodeURIComponent(event.artifactId)}`}
                style={{
                  display: "block",
                  marginTop: 5,
                  fontSize: 10,
                  color: "var(--signal)",
                }}
              >
                evidence ↓
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChildRunBlock({
  child,
  depth,
  tenant,
}: {
  child: RunListRow;
  depth: number;
  tenant: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(depth <= 1);
  const childQuery = useRun(open ? child.id : null);
  const tone =
    child.status === "failed"
      ? "var(--red)"
      : child.status === "running"
        ? "var(--signal)"
        : child.status === "ok"
          ? "var(--green)"
          : "var(--amber)";

  return (
    <div
      style={{
        margin: "6px 0",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${tone}`,
        borderRadius: 4,
        background: "var(--panel-2)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          background: "transparent",
          border: 0,
          borderBottom: open ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Icon
          name="chevron-right"
          size={11}
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <StatusDot status={STATUS_TO_DOT[child.status] ?? "idle"} size={7} />
        <span className="mono" style={{ fontSize: 11 }}>
          {child.id}
        </span>
        <Badge tone="muted">{t("traceTree.subflow")}</Badge>
        <span style={{ minWidth: 0, flex: 1 }}>
          {child.agentTitle ?? child.agentName}
        </span>
        <span className="mono" style={{ color: tone, fontSize: 11 }}>
          {fmtDur(child.durationMs)}
        </span>
        <Link
          href={`/portal/${tenant}/runs/${child.id}` as never}
          onClick={(event) => event.stopPropagation()}
          title={t("traceTree.openChildRun")}
        >
          <Icon name="external" size={11} />
        </Link>
      </button>
      {open && depth < MAX_DEPTH && (
        <div style={{ padding: "6px 10px" }}>
          {childQuery.isError ? (
            <Empty
              title={t("traceTree.loadFailed")}
              hint={childQuery.error.message}
            />
          ) : childQuery.isLoading || !childQuery.data ? (
            <Empty title={t("traceTree.loading")} hint={child.id} />
          ) : (
            <TraceTree
              node={{
                run: childQuery.data.run,
                steps: childQuery.data.steps,
              }}
              depth={depth}
              tenant={tenant}
            />
          )}
        </div>
      )}
      {open && depth >= MAX_DEPTH && (
        <div
          style={{
            padding: "8px 10px",
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          {t("traceTree.depthCapPrefix")}{" "}
          <Link href={`/portal/${tenant}/runs/${child.id}` as never}>
            {t("traceTree.depthCapLink")}
          </Link>
        </div>
      )}
    </div>
  );
}

function stepTone(step: StepRow): string {
  if (step.status === "failed") return "var(--red)";
  if (step.status === "running") return "var(--signal)";
  if (step.status === "ok") return "var(--green)";
  return "var(--text-3)";
}

const rightMetaStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-3)",
  textAlign: "right",
};

export type { TraceNode };
