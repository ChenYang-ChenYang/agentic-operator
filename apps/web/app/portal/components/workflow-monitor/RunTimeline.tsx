"use client";

/**
 * RunTimeline — the 时间轴 view of one run's execution (§G4).
 *
 * Renders the tree buildRunTraceTree produces: step → attempt → turn → tool
 * call, down a single vertical spine so the eye follows one line from the
 * trigger to the last write. Each level carries the numbers that make the run
 * legible without opening anything — duration, model, tokens, tool count — and
 * expands to the evidence underneath.
 *
 * Two constraints shaped this. It is projected at a launch event, so type is
 * large, status is carried by shape as well as colour, and nothing important
 * hides behind a hover. And it renders while the run is still going, so rows
 * appear with a short entry animation rather than the list jumping — bounded
 * by the wf-* keyframes in global.css, all of which honour reduced motion.
 */

import { useMemo, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useArtifact } from "@/lib/hooks/useArtifact";
import { useRunTrace } from "@/lib/hooks/useRunTrace";
import { useRun } from "@/lib/hooks/useRuns";
import {
  buildRunTraceTree,
  mergeStepRows,
  type RunStepRow,
  type AttemptNode,
  type RunTraceEvent,
  type StepNode,
  type ToolCallNode,
  type TurnNode,
} from "./trace-tree";
import {
  readDataChange,
  readStepOutcome,
  type EvidenceArtifact,
} from "./data-change";
import { fmtDuration, fmtTokens } from "./live-support";
import styles from "./timeline.module.css";

function statusColor(status: string | null): string {
  switch (status) {
    case "ok":
      return "var(--green)";
    case "failed":
      return "var(--red)";
    case "running":
      return "var(--signal)";
    case "skipped":
      return "var(--text-3)";
    default:
      return "var(--text-3)";
  }
}

/** Status is carried by shape too, so it survives a projector and colour blindness. */
function StatusDot({ status }: { status: string | null }) {
  const running = status === "running";
  return (
    <span
      className={`${styles.dot} ${running ? styles.dotRunning : ""}`}
      style={{ background: statusColor(status) }}
      aria-hidden="true"
    />
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  );
}

/**
 * The business-system effect of one tool call, in business words.
 *
 * Fetched lazily: a run can carry a hundred calls and pulling every artifact up
 * front would cost more requests than the whole page. The artifact only loads
 * once its row is expanded.
 */
function DataChange({ artifactId }: { artifactId: string | null }) {
  const { t } = useI18n();
  const { data, isLoading } = useArtifact(artifactId);
  const change = useMemo(
    () => readDataChange(data as EvidenceArtifact | null),
    [data],
  );

  if (!artifactId) return <p className={styles.muted}>{t("monitor.dataChangeNone")}</p>;
  if (isLoading) return <p className={styles.muted}>{t("monitor.loading")}</p>;
  if (!change) return <p className={styles.muted}>{t("monitor.dataChangeNone")}</p>;

  const heading =
    change.kind === "write"
      ? t("monitor.dataChangeWrote")
      : change.kind === "read"
        ? t("monitor.dataChangeRead")
        : change.kind === "error"
          ? t("monitor.dataChangeError")
          : (change.operation ?? "");

  return (
    <div
      className={`${styles.change} ${change.kind === "write" ? "wf-commit" : ""}`}
      style={{
        borderLeftColor:
          change.kind === "error"
            ? "var(--red)"
            : change.kind === "write"
              ? "var(--signal)"
              : "var(--border-2)",
      }}
    >
      <div className={styles.changeHead}>
        <span className={styles.changeVerb}>{heading}</span>
        {change.operation ? (
          <code className={styles.changeOp}>{change.operation}</code>
        ) : null}
        <span className={styles.changeEnv}>
          {change.live
            ? t("monitor.dataChangeLive")
            : t("monitor.dataChangeSandbox")}
        </span>
      </div>

      {change.documentId ? (
        <div className={styles.docId}>{change.documentId}</div>
      ) : null}
      {change.rowCount !== null ? (
        <div className={styles.muted}>
          {t("monitor.dataChangeRows", { n: String(change.rowCount) })}
        </div>
      ) : null}
      {change.errorText ? (
        <div className={styles.changeError}>{change.errorText}</div>
      ) : null}

      {change.fields.length > 0 ? (
        <dl className={styles.fields}>
          {change.fields.map((f) => (
            <div key={f.key} className={styles.field}>
              <dt className={styles.fieldKey}>{f.key}</dt>
              <dd className={styles.fieldValue}>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCallNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <li className={`${styles.callRow} wf-row-in`}>
      <button
        type="button"
        className={styles.callHead}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? t("monitor.collapse") : t("monitor.expand")}
      >
        <StatusDot status={call.isError ? "failed" : call.status} />
        <code className={styles.callName}>{call.tool}</code>
        <span className={styles.callTime}>{fmtDuration(call.durationMs)}</span>
        <span className={styles.caret} aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? <DataChange artifactId={call.evidenceArtifactId} /> : null}
    </li>
  );
}

/**
 * The turn's own reasoning, expanded in place.
 *
 * Fetched only when opened, like the evidence: the artifact holds the full
 * model response and pulling one per turn on render would multiply requests by
 * the length of the agent loop. The text is whatever the runtime recorded —
 * this renders it, it does not summarise it.
 */
function Reasoning({ artifactId }: { artifactId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useArtifact(open ? artifactId : null);

  /**
   * What the model was actually asked.
   *
   * The turn artifact is {iteration, request, response, usage}, but `response`
   * is null on every turn artifact this runtime writes — the model's own words
   * are not persisted anywhere the client can reach. What IS persisted is the
   * request: the system rubric and the user instruction, which for a rule gate
   * is the obligation text the agent had to judge against. That is the useful
   * half and it is shown as-is rather than dressed up as chain-of-thought.
   */
  const text = useMemo(() => {
    if (data === null || data === undefined) return null;
    if (typeof data === "string") return data;
    const d = data as Record<string, unknown>;
    for (const key of ["reasoning", "thinking", "content", "text"]) {
      const v = d[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    const response = d.response;
    if (typeof response === "string" && response.trim()) return response;

    const messages = (d.request as { messages?: unknown } | undefined)?.messages;
    if (Array.isArray(messages)) {
      const parts = messages
        .map((m) => {
          const msg = m as { role?: unknown; content?: unknown };
          if (typeof msg.content !== "string") return null;
          const role = typeof msg.role === "string" ? msg.role : "?";
          return `[${role}]\n${msg.content}`;
        })
        .filter((x): x is string => x !== null);
      if (parts.length) return parts.join("\n\n");
    }
    return JSON.stringify(data, null, 2);
  }, [data]);

  return (
    <div className={styles.reasoningBlock}>
      <button
        type="button"
        className={styles.reasoningLink}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t("monitor.reasoning")}
        <span className={styles.caret} aria-hidden="true">
          {open ? "\u2212" : "+"}
        </span>
      </button>
      {open ? (
        isLoading ? (
          <p className={styles.muted}>{t("monitor.loading")}</p>
        ) : text ? (
          <pre className={styles.reasoningText}>{text}</pre>
        ) : (
          <p className={styles.muted}>{t("monitor.dataChangeNone")}</p>
        )
      ) : null}
    </div>
  );
}

function TurnRow({ turn }: { turn: TurnNode }) {
  const { t } = useI18n();
  return (
    <li className={`${styles.turnRow} wf-row-in`}>
      <div className={styles.turnHead}>
        <span className={styles.turnLabel}>
          {t("monitor.turn", { n: String(turn.iteration) })}
        </span>
        {turn.model ? (
          <code className={styles.model}>{turn.model}</code>
        ) : (
          <span className={styles.muted}>{t("monitor.noModel")}</span>
        )}
        {turn.tokensIn !== null || turn.tokensOut !== null ? (
          <span className={styles.turnTokens}>
            {t("monitor.turnTokens", {
              in: fmtTokens(turn.tokensIn ?? 0),
              out: fmtTokens(turn.tokensOut ?? 0),
            })}
          </span>
        ) : null}
        {turn.durationMs !== null ? (
          <span className={styles.callTime}>{fmtDuration(turn.durationMs)}</span>
        ) : null}
        {turn.finishReason ? (
          <span className={styles.finish}>{turn.finishReason}</span>
        ) : null}
      </div>
      {turn.artifactId ? <Reasoning artifactId={turn.artifactId} /> : null}
      {turn.toolCalls.length > 0 ? (
        <ul className={styles.callList}>
          {turn.toolCalls.map((c) => (
            <ToolCallRow key={`${c.seq}-${c.callIndex ?? "x"}`} call={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AttemptBlock({
  attempt,
  showHeader,
}: {
  attempt: AttemptNode;
  showHeader: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.attempt}>
      {showHeader ? (
        <div className={styles.attemptHead}>
          <StatusDot status={attempt.status} />
          <span className={styles.attemptLabel}>
            {t("monitor.attempt", { n: String(attempt.attempt) })}
          </span>
          {attempt.attempt > 1 ? (
            <span className={styles.retryTag}>{t("monitor.attemptRetry")}</span>
          ) : null}
          <span className={styles.callTime}>
            {fmtDuration(attempt.durationMs)}
          </span>
        </div>
      ) : null}
      {/* A skipped step's reason is already rendered by StepOutcome from the
          resolved output; only a genuine execution error belongs here. */}
      {attempt.error && attempt.status !== "skipped" ? (
        <p className={styles.changeError}>{attempt.error}</p>
      ) : null}
      <ul className={`${styles.turnList} wf-spine`}>
        {attempt.turns.map((turn) => (
          <TurnRow key={turn.iteration} turn={turn} />
        ))}
        {attempt.looseToolCalls.map((c) => (
          <ToolCallRow key={`loose-${c.seq}`} call={c} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The decision the step reached, in the model's own words.
 *
 * For a rule gate this is the whole point of the step: `status` is the verdict
 * and `reason` is the sentence explaining which evidence was missing. It sits
 * directly under the step header rather than behind an expander, because on a
 * projector this is the line the room needs to read.
 */
function StepOutcome({ output }: { output: unknown }) {
  const { t } = useI18n();
  const outcome = useMemo(() => readStepOutcome(output), [output]);
  if (!outcome) return null;

  if (outcome.kind === "condition") {
    return (
      <div className={styles.outcomeCondition}>
        <code>{outcome.condition}</code>
        {outcome.evaluated !== null ? (
          <span className={styles.evaluated}>
            {outcome.evaluated
              ? t("monitor.conditionTrue")
              : t("monitor.conditionFalse")}
          </span>
        ) : null}
      </div>
    );
  }

  const violated =
    outcome.status !== null &&
    /violat|fail|reject|deny/i.test(outcome.status);

  return (
    <div
      className={styles.outcome}
      style={{
        borderLeftColor: violated
          ? "var(--red)"
          : outcome.kind === "skipped"
            ? "var(--text-3)"
            : "var(--green)",
      }}
    >
      <div className={styles.outcomeHead}>
        {outcome.ruleId ? (
          <code className={styles.ruleId}>{outcome.ruleId}</code>
        ) : null}
        {outcome.status ? (
          <span
            className={styles.verdict}
            style={{ color: violated ? "var(--red)" : "var(--text-2)" }}
          >
            {outcome.status}
          </span>
        ) : null}
      </div>
      {outcome.reason ? (
        <p className={styles.reason}>{outcome.reason}</p>
      ) : null}
    </div>
  );
}

function StepBlock({ step }: { step: StepNode }) {
  const multipleAttempts = step.attempts.length > 1;
  const last = step.attempts[step.attempts.length - 1];
  return (
    <section className={styles.step}>
      <header className={styles.stepHead}>
        <StatusDot status={last?.status ?? null} />
        <h4 className={styles.stepName}>{step.name}</h4>
        {step.type ? <span className={styles.stepType}>{step.type}</span> : null}
        <span className={styles.callTime}>{fmtDuration(last?.durationMs)}</span>
      </header>
      <StepOutcome output={step.output} />
      {step.attempts.map((attempt) => (
        <AttemptBlock
          key={attempt.attempt}
          attempt={attempt}
          showHeader={multipleAttempts}
        />
      ))}
    </section>
  );
}

/**
 * Wall-clock span of the trace: first row that started to the last that ended.
 * Derived rather than fetched — the run detail endpoint would tell us the same
 * thing at the cost of another request per selection.
 */
function elapsedFrom(events: RunTraceEvent[]): number | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const s = e.startedAt ? Date.parse(e.startedAt) : NaN;
    const f = e.endedAt ? Date.parse(e.endedAt) : NaN;
    if (Number.isFinite(s)) first = Math.min(first, s);
    if (Number.isFinite(f)) last = Math.max(last, f);
    if (Number.isFinite(s)) last = Math.max(last, s);
  }
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    return null;
  }
  return last - first;
}

export function RunTimeline({
  events,
  stepRows,
  isLoading,
  isError,
}: {
  events: RunTraceEvent[];
  /** Persisted step list — carries the skipped steps the trace omits. */
  stepRows?: readonly RunStepRow[];
  isLoading: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  const tree = useMemo(
    () => mergeStepRows(buildRunTraceTree(events), stepRows ?? []),
    [events, stepRows],
  );
  const elapsedMs = useMemo(() => elapsedFrom(events), [events]);

  if (isError) return <p className={styles.muted}>{t("monitor.error")}</p>;
  if (isLoading && events.length === 0) {
    return <p className={styles.muted}>{t("monitor.loading")}</p>;
  }
  if (events.length === 0 && (stepRows?.length ?? 0) === 0) {
    return <p className={styles.muted}>{t("monitor.empty")}</p>;
  }

  const turnCount = tree.steps.reduce(
    (n, s) => n + s.attempts.reduce((m, a) => m + a.turns.length, 0),
    0,
  );

  return (
    <div className={styles.root}>
      <div className={styles.totals}>
        <Metric
          label={t("monitor.totalElapsed")}
          value={fmtDuration(elapsedMs)}
        />
        <Metric
          label={t("monitor.totalTokens")}
          value={`${fmtTokens(tree.totals.tokensIn)} / ${fmtTokens(tree.totals.tokensOut)}`}
        />
        <Metric
          label={t("monitor.totalTurns")}
          value={String(turnCount)}
        />
        <Metric
          label={t("monitor.totalToolCalls")}
          value={String(tree.totals.toolCalls)}
        />
      </div>

      {tree.degraded ? (
        <p className={styles.degraded}>{t("monitor.degradedNote")}</p>
      ) : null}

      {tree.steps.map((step) => (
        <StepBlock key={step.stepId} step={step} />
      ))}
    </div>
  );
}

/**
 * Panel wrapper: picks the run to trace and owns the fetch.
 *
 * An agent can have several runs in flight, so the active one wins and the last
 * resolved one is the resting state — which is what makes the tab useful
 * between scenarios rather than empty.
 */
export function RunTimelinePanel({
  scrubbedRunId,
  scrubbedRunStatus,
  activeRunId,
  lastRunId,
}: {
  /** Run picked from the recent-runs strip, if any — it wins. */
  scrubbedRunId?: string | null;
  scrubbedRunStatus?: string | null;
  activeRunId: string | null | undefined;
  lastRunId: string | null | undefined;
}) {
  const { t } = useI18n();
  // An explicit pick beats the live default: during a demo the presenter walks
  // back through the strip, and the panel has to follow rather than snap to
  // whatever ran last.
  const runId = scrubbedRunId ?? activeRunId ?? lastRunId ?? null;
  const status = scrubbedRunId
    ? (scrubbedRunStatus ?? "ok")
    : activeRunId
      ? "running"
      : "ok";
  const { events, isLoading, isError } = useRunTrace(runId, status);
  // The persisted step list fills in what the trace cannot see: steps that were
  // skipped never emit trace rows, and a run whose gate failed is mostly
  // skipped steps.
  const detail = useRun(runId, { live: status === "running" });

  if (!runId) return <p className={styles.muted}>{t("monitor.selectRun")}</p>;
  return (
    <RunTimeline
      events={events}
      stepRows={detail.data?.steps as RunStepRow[] | undefined}
      isLoading={isLoading && detail.isLoading}
      isError={isError && detail.isError}
    />
  );
}
