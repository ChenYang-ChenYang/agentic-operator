"use client";

/**
 * LiveAgentPanel — the workflow monitor's node inspector (§G4 item 2).
 *
 * Shown when a canvas node is clicked outside edit mode ("Live" tab):
 *   - agent title + live state chip (from useWorkflowLiveState)
 *   - run controls: Cancel / Replay (existing endpoints) and Pause / Resume
 *     (new endpoints added in parallel — a 404/405 disables them with a
 *     "runtime does not support pause yet" tooltip)
 *   - waiting-human deep link into the task inbox
 *   - the focused run's live step timeline (useRun, SSE-invalidated)
 *   - recent runs for this agent (click to refocus the timeline/logs)
 *   - live log tail over `/v1/runs/:id/logs?follow=1`
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, useToast } from "@/app/portal/components";
import type { DagAgent } from "@/lib/hooks/useAgents";
import type { AgentLiveState } from "@/lib/hooks/useWorkflowLiveState";
import {
  useCancelRun,
  useReplayRun,
  useRun,
  useRuns,
} from "@/lib/hooks/useRuns";
import {
  isPauseUnsupportedError,
  usePauseRun,
  useResumeRun,
} from "@/lib/hooks/useRunControls";
import { useRunLogStream } from "@/lib/hooks/useRunLogStream";
import {
  fmtAgoShort,
  fmtTokens,
  isRunActive,
  liveStatusColor,
  liveStatusLabel,
  runStatusColor,
} from "./live-support";
import styles from "./monitor.module.css";

const PAUSE_UNSUPPORTED_HINT = "runtime does not support pause yet";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        color: "var(--text-3)",
        letterSpacing: "0.08em",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}
    >
      <SectionTitle>{title}</SectionTitle>
      {children}
    </div>
  );
}

export function LiveAgentPanel({
  agent,
  live,
  onClose,
  onOpenTasks,
}: {
  agent: DagAgent;
  live: AgentLiveState | undefined;
  onClose: () => void;
  /** Navigate to the HITL inbox, optionally pre-selecting a task. */
  onOpenTasks: (taskId: string | null) => void;
}) {
  const toast = useToast();
  const state = live?.state ?? "idle";

  // Recent runs for this agent (server-filtered by agents.name).
  const recentQuery = useRuns({ agent: agent.name, limit: 10 });
  const recent = useMemo(() => recentQuery.data ?? [], [recentQuery.data]);

  // The focused run: the operator's explicit pick wins; otherwise follow the
  // live active run, then the last resolved one, then the newest in history.
  const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);
  useEffect(() => setPinnedRunId(null), [agent.kebabId]);
  const focusedRunId =
    pinnedRunId ??
    live?.activeRunId ??
    live?.lastRunId ??
    recent[0]?.id ??
    null;

  const detailQuery = useRun(focusedRunId, { live: true });
  const run = detailQuery.data?.run ?? null;
  const steps = detailQuery.data?.steps ?? [];
  const waitingTask = detailQuery.data?.waitingTask ?? null;

  const followLogs = Boolean(run && isRunActive(run.status));
  const logs = useRunLogStream(focusedRunId, {
    follow: followLogs,
    maxLines: 400,
  });
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.lines.length]);

  // Controls.
  const cancel = useCancelRun();
  const replay = useReplayRun();
  const pauseRun = usePauseRun();
  const resumeRun = useResumeRun();
  // null = unknown (endpoint not probed yet), false = 404/405 seen.
  const [pauseSupported, setPauseSupported] = useState<boolean | null>(null);

  async function onCancel() {
    if (!run) return;
    try {
      const result = await cancel.mutateAsync(run.id);
      toast({
        tone: result.cancelled ? "signal" : "default",
        title: result.cancelled ? "Run cancelled" : "Nothing to cancel",
        description: result.note,
      });
    } catch (err) {
      toast({
        tone: "red",
        title: "Cancel failed",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onReplay() {
    if (!run) return;
    try {
      await replay.mutateAsync(run.id);
      toast({ tone: "signal", title: "Replay queued" });
    } catch (err) {
      toast({
        tone: "red",
        title: "Replay failed",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onPause() {
    if (!run) return;
    try {
      await pauseRun.mutateAsync(run.id);
      setPauseSupported(true);
      toast({ tone: "signal", title: "Pause requested" });
    } catch (err) {
      if (isPauseUnsupportedError(err)) {
        setPauseSupported(false);
        toast({ tone: "default", title: PAUSE_UNSUPPORTED_HINT });
        return;
      }
      toast({
        tone: "red",
        title: "Pause failed",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onResume() {
    if (!run) return;
    try {
      await resumeRun.mutateAsync(run.id);
      setPauseSupported(true);
      toast({ tone: "signal", title: "Resume requested" });
    } catch (err) {
      if (isPauseUnsupportedError(err)) {
        setPauseSupported(false);
        toast({ tone: "default", title: PAUSE_UNSUPPORTED_HINT });
        return;
      }
      toast({
        tone: "red",
        title: "Resume failed",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runActive = Boolean(run && isRunActive(run.status));
  const runPaused = run?.status === "paused";
  const pauseDisabled =
    !run || !runActive || runPaused || pauseSupported === false ||
    pauseRun.isPending;
  const resumeDisabled =
    !run || !runPaused || pauseSupported === false || resumeRun.isPending;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 6,
              alignItems: "center",
            }}
          >
            <Badge tone="muted">{agent.kebabId}</Badge>
            <span
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 10.5,
                color: liveStatusColor(state),
              }}
            >
              <span
                className={styles.legendDot}
                style={{ background: liveStatusColor(state) }}
              />
              {liveStatusLabel(state)}
              {state === "running" && live && live.runningCount > 1
                ? ` ×${live.runningCount}`
                : ""}
            </span>
          </div>
          <div style={{ fontSize: 15, color: "var(--text)", fontWeight: 500 }}>
            {agent.title}
          </div>
          {live && live.tokensIn + live.tokensOut > 0 && (
            <div
              className="mono"
              style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 4 }}
            >
              session tokens {fmtTokens(live.tokensIn)} in ·{" "}
              {fmtTokens(live.tokensOut)} out
            </div>
          )}
          {state === "failed" && live?.lastError && (
            <div
              style={{
                fontSize: 11,
                color: "var(--red)",
                marginTop: 6,
                overflowWrap: "anywhere",
              }}
            >
              {live.lastError}
            </div>
          )}
        </div>
        <Button
          small
          tone="ghost"
          icon="x"
          ariaLabel="Close live panel"
          onClick={onClose}
        />
      </header>

      {/* Waiting-human affordance */}
      {(state === "waiting_human" || waitingTask) && (
        <Section title="Human gate">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              {waitingTask?.title ?? "Blocked on a human decision"}
            </span>
            <Button
              small
              tone="primary"
              onClick={() =>
                onOpenTasks(
                  waitingTask?.id ?? live?.waitingTaskIds[0] ?? null,
                )
              }
            >
              Open task inbox
            </Button>
          </div>
        </Section>
      )}

      {/* Controls */}
      <Section title={`Controls${run ? ` · ${run.id}` : ""}`}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button
            small
            tone="danger"
            disabled={!runActive || cancel.isPending}
            onClick={() => void onCancel()}
            title={
              runActive ? "POST /v1/runs/:id/cancel" : "run already terminal"
            }
          >
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </Button>
          <Button
            small
            disabled={!run || replay.isPending}
            onClick={() => void onReplay()}
            title="POST /v1/runs/:id/replay"
          >
            {replay.isPending ? "Replaying…" : "Replay"}
          </Button>
          <Button
            small
            tone="ghost"
            disabled={pauseDisabled}
            onClick={() => void onPause()}
            title={
              pauseSupported === false
                ? PAUSE_UNSUPPORTED_HINT
                : "POST /v1/runs/:id/pause"
            }
          >
            {pauseRun.isPending ? "Pausing…" : "Pause"}
          </Button>
          <Button
            small
            tone="ghost"
            disabled={resumeDisabled}
            onClick={() => void onResume()}
            title={
              pauseSupported === false
                ? PAUSE_UNSUPPORTED_HINT
                : "POST /v1/runs/:id/resume"
            }
          >
            {resumeRun.isPending ? "Resuming…" : "Resume"}
          </Button>
        </div>
        {pauseSupported === false && (
          <div
            style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 6 }}
          >
            {PAUSE_UNSUPPORTED_HINT}
          </div>
        )}
      </Section>

      {/* Step timeline of the focused run */}
      <Section
        title={
          run
            ? `Steps · ${run.status}${run.durationMs != null ? ` · ${run.durationMs}ms` : ""}`
            : "Steps"
        }
      >
        {!focusedRunId ? (
          <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            No runs yet for this agent.
          </div>
        ) : steps.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {detailQuery.isLoading ? "Loading…" : "No steps recorded."}
          </div>
        ) : (
          <div>
            {steps.map((step) => (
              <div key={step.id} className={styles.stepRow}>
                <span
                  className={styles.chipDot}
                  style={{ background: runStatusColor(step.status) }}
                />
                <span
                  className="mono"
                  style={{ color: "var(--text-3)", flex: "none" }}
                >
                  {String(step.ord).padStart(2, "0")}
                </span>
                <span
                  style={{
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flex: 1,
                  }}
                  title={step.error ?? step.name}
                >
                  {step.name}
                </span>
                <span
                  className="mono"
                  style={{ color: "var(--text-3)", flex: "none" }}
                >
                  {step.status}
                  {step.durationMs != null ? ` ${step.durationMs}ms` : ""}
                  {(step.tokensIn ?? 0) + (step.tokensOut ?? 0) > 0
                    ? ` · ${fmtTokens((step.tokensIn ?? 0) + (step.tokensOut ?? 0))}t`
                    : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Recent runs */}
      <Section title="Recent runs">
        {recent.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            {recentQuery.isLoading ? "Loading…" : "No run history."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`${styles.runRow} ${
                  row.id === focusedRunId ? styles.runRowSelected : ""
                }`}
                onClick={() =>
                  setPinnedRunId(row.id === pinnedRunId ? null : row.id)
                }
                title={`${row.id}${row.subject ? ` · ${row.subject}` : ""}`}
              >
                <span
                  className={styles.chipDot}
                  style={{ background: runStatusColor(row.status) }}
                />
                <span style={{ flex: "none" }}>{row.status}</span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--text-3)",
                  }}
                >
                  {row.subject ?? row.id}
                </span>
                <span style={{ flex: "none", color: "var(--text-3)" }}>
                  {fmtAgoShort(row.startedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* Live log tail */}
      <Section
        title={
          <>
            Log tail
            {followLogs && (
              <span
                style={{
                  marginLeft: 8,
                  color: logs.connected ? "var(--green)" : "var(--amber)",
                }}
              >
                {logs.connected
                  ? "● live"
                  : logs.error
                    ? `retrying ${logs.error.retrySeconds}s`
                    : "connecting…"}
              </span>
            )}
          </>
        }
      >
        {!focusedRunId ? (
          <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            Select a run to tail its log.
          </div>
        ) : (
          <div ref={logBoxRef} className={styles.logBox}>
            {logs.lines.length === 0 ? (
              <span style={{ color: "var(--text-3)" }}>
                No log lines yet.
              </span>
            ) : (
              logs.lines.map((line) => (
                <div
                  key={line.seq}
                  className={line.kind === "error" ? styles.logLineError : ""}
                >
                  {line.kind === "end" ? "— end of log —" : line.text}
                </div>
              ))
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
