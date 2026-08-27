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
import {
  useRunReasoning,
  type ReasoningTurnRow,
} from "@/lib/hooks/useRunReasoning";
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
import { fmtDuration, fmtTokens, pickFocusRun } from "./live-support";
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
 * The model's own reasoning for this turn, expanded in place.
 *
 * This is the real thing, not the prompt: `llm_turns.reasoning` holds the text
 * the model produced while working the problem, and `responseText` its answer.
 * The trace's turn artifacts carry neither — their `response` is null on every
 * row — so the timeline joins this in from GET /v1/reasoning?run= instead.
 */
function Reasoning({
  reasoning,
  responseText,
}: {
  reasoning: string | null;
  responseText: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!reasoning && !responseText) return null;

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
        <>
          {reasoning ? (
            <pre className={styles.reasoningText}>{reasoning}</pre>
          ) : null}
          {responseText ? (
            <pre className={styles.answerText}>{responseText}</pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TurnRow({
  turn,
  reasoning,
}: {
  turn: TurnNode;
  reasoning?: ReasoningTurnRow;
}) {
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
      <Reasoning
        reasoning={reasoning?.reasoning ?? null}
        responseText={reasoning?.responseText ?? null}
      />
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
  reasoningByOrd,
}: {
  attempt: AttemptNode;
  showHeader: boolean;
  reasoningByOrd?: Map<number, ReasoningTurnRow>;
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
          <TurnRow
            key={turn.iteration}
            turn={turn}
            reasoning={reasoningByOrd?.get(turn.iteration - 1)}
          />
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

function StepBlock({
  step,
  reasoningByStep,
}: {
  step: StepNode;
  reasoningByStep?: Map<string, Map<number, ReasoningTurnRow>>;
}) {
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
          reasoningByOrd={reasoningByStep?.get(step.stepId)}
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
  reasoningTurns,
  isLoading,
  isError,
}: {
  events: RunTraceEvent[];
  /** Persisted step list — carries the skipped steps the trace omits. */
  stepRows?: readonly RunStepRow[];
  /** Captured LLM turns — the only source of the model's own reasoning. */
  reasoningTurns?: readonly ReasoningTurnRow[];
  isLoading: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  const tree = useMemo(
    () => mergeStepRows(buildRunTraceTree(events), stepRows ?? []),
    [events, stepRows],
  );
  const elapsedMs = useMemo(() => elapsedFrom(events), [events]);
  // (stepId → ord → turn). llm_turns.step_id is the same id the steps table
  // uses, so traced and merged nodes both find their turns.
  const reasoningByStep = useMemo(() => {
    const byStep = new Map<string, Map<number, ReasoningTurnRow>>();
    for (const turn of reasoningTurns ?? []) {
      const key = turn.stepId;
      if (!key) continue;
      let inner = byStep.get(key);
      if (!inner) {
        inner = new Map();
        byStep.set(key, inner);
      }
      inner.set(turn.ord, turn);
    }
    return byStep;
  }, [reasoningTurns]);

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
        <StepBlock
          key={step.stepId}
          step={step}
          reasoningByStep={reasoningByStep}
        />
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
  const { turns } = useRunReasoning(runId, status === "running");

  if (!runId) return <p className={styles.muted}>{t("monitor.selectRun")}</p>;
  return (
    <RunTimeline
      events={events}
      stepRows={detail.data?.steps as RunStepRow[] | undefined}
      reasoningTurns={turns}
      isLoading={isLoading && detail.isLoading}
      isError={isError && detail.isError}
    />
  );
}

/**
 * Resting state of the inspector: the run worth watching, with no selection.
 *
 * Falls back to `fallback` (the event catalogue) only when the tenant has
 * never run anything — otherwise the most valuable strip of screen in the room
 * shows a reference table while agents are working behind it.
 */
export function IdleTimelinePanel({
  agents,
  fallback,
}: {
  agents: Record<
    string,
    { activeRunId: string | null; lastRunId: string | null; lastEventAt: number | null }
  >;
  fallback: React.ReactNode;
}) {
  const focus = useMemo(() => pickFocusRun(agents), [agents]);
  const { events, isLoading, isError } = useRunTrace(
    focus?.runId ?? null,
    focus?.live ? "running" : "ok",
  );
  const detail = useRun(focus?.runId ?? null, { live: focus?.live ?? false });
  const { turns } = useRunReasoning(focus?.runId ?? null, focus?.live ?? false);

  if (!focus) return <>{fallback}</>;
  return (
    <RunTimeline
      events={events}
      stepRows={detail.data?.steps as RunStepRow[] | undefined}
      reasoningTurns={turns}
      isLoading={isLoading && detail.isLoading}
      isError={isError && detail.isError}
    />
  );
}
