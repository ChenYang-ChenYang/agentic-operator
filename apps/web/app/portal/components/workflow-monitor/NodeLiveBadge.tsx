"use client";

/**
 * NodeLiveBadge — live-state overlay for one workflow-canvas node (§G4).
 *
 * Renders a colored ring around the node plus a top-right chip:
 *   running       → pulsing accent ring, "N ▶" chip + token accumulator
 *   waiting_human → orange badge with the open task count; clicking it
 *                   deep-links to the task-resolution inbox
 *   failed        → red ring + chip (title carries the last error)
 *   ok            → quiet green flash that fades out
 *
 * Purely presentational — state comes from useWorkflowLiveState keyed by the
 * agent's manifest name.
 */

import type { MouseEvent } from "react";
import type { AgentLiveState } from "@/lib/hooks/useWorkflowLiveState";
import { fmtTokens } from "./live-support";
import styles from "./monitor.module.css";

export function NodeLiveBadge({
  live,
  onOpenTasks,
}: {
  live: AgentLiveState | undefined;
  /** Navigate to the HITL inbox with the blocking task pre-selected. */
  onOpenTasks?: (taskId: string | null) => void;
}) {
  if (!live || live.state === "idle") return null;

  const ringClass =
    live.state === "running"
      ? styles.ringRunning
      : live.state === "waiting_human"
        ? styles.ringWaiting
        : live.state === "failed"
          ? styles.ringFailed
          : styles.ringOk;

  const tokens = live.tokensIn + live.tokensOut;

  function openTasks(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onOpenTasks?.(live?.waitingTaskIds[0] ?? null);
  }

  return (
    <>
      <div
        className={`${styles.ring} ${ringClass}`}
        // Re-mount on each resolved run so the ok flash replays.
        key={live.state === "ok" ? (live.lastRunId ?? "ok") : live.state}
        aria-hidden="true"
      />
      <div className={styles.badgeRow}>
        {live.state === "running" && (
          <span
            className={`${styles.badge} ${styles.badgeRunning}`}
            title={`${live.runningCount} run(s) in flight`}
          >
            ▶ {live.runningCount}
          </span>
        )}
        {live.state === "waiting_human" && (
          <button
            type="button"
            className={`${styles.badge} ${styles.badgeWaiting}`}
            title="Waiting for a human decision — open the task inbox"
            onClick={openTasks}
          >
            ✋ {live.waitingTaskIds.length}
          </button>
        )}
        {live.state === "failed" && (
          <span
            className={`${styles.badge} ${styles.badgeFailed}`}
            title={live.lastError ?? "run failed"}
          >
            ✕ failed
          </span>
        )}
        {live.state === "ok" && (
          <span
            key={live.lastRunId ?? "ok-chip"}
            className={`${styles.badge} ${styles.badgeOk}`}
            title="last run completed"
          >
            ✓ ok
          </span>
        )}
        {tokens > 0 && (
          <span
            className={styles.badgeTokens}
            title={`tokens in ${live.tokensIn} / out ${live.tokensOut} (this session)`}
          >
            {fmtTokens(tokens)} tok
          </span>
        )}
      </div>
    </>
  );
}
