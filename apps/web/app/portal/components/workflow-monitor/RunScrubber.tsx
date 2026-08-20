"use client";

/**
 * RunScrubber — status-chip strip of the most recent runs for the workflow's
 * agents (§G4 item 3). Selecting a chip highlights the run's node and its
 * emitted-event edges on the canvas; selecting it again (or the ✕) clears.
 *
 * Data: the shared `/v1/runs` list (SSE-invalidated), filtered client-side to
 * the agent names present in the rendered DAG.
 */

import { useMemo } from "react";
import { useRuns, type RunListRow } from "@/lib/hooks/useRuns";
import { fmtAgoShort, runStatusColor } from "./live-support";
import styles from "./monitor.module.css";

const FETCH_LIMIT = 40;
const SHOW_LIMIT = 15;

export function RunScrubber({
  agentNames,
  titlesByName,
  selectedRunId,
  onSelect,
}: {
  /** Manifest agent names in the rendered workflow (DagAgent.name). */
  agentNames: ReadonlySet<string>;
  /** agentName → display title for chip labels. */
  titlesByName: Record<string, string>;
  selectedRunId: string | null;
  onSelect: (run: RunListRow | null) => void;
}) {
  const runsQuery = useRuns({ limit: FETCH_LIMIT });
  const rows = useMemo(
    () =>
      (runsQuery.data ?? [])
        .filter((run) => agentNames.has(run.agentName))
        .slice(0, SHOW_LIMIT),
    [agentNames, runsQuery.data],
  );

  if (rows.length === 0) return null;

  return (
    <div className={styles.scrubber} role="toolbar" aria-label="Recent runs">
      <span className={styles.scrubberLabel}>Recent runs</span>
      <div className={styles.scrubberTrack}>
        {rows.map((run) => {
          const selected = run.id === selectedRunId;
          const title = titlesByName[run.agentName] ?? run.agentName;
          return (
            <button
              key={run.id}
              type="button"
              className={`${styles.chip} ${selected ? styles.chipSelected : ""}`}
              aria-pressed={selected}
              title={`${run.id} · ${run.status}${run.emittedEvent ? ` → ${run.emittedEvent}` : ""}`}
              onClick={() => onSelect(selected ? null : run)}
            >
              <span
                className={`${styles.chipDot} ${
                  run.status === "running" || run.status === "queued"
                    ? styles.chipDotRunning
                    : ""
                }`}
                style={{ background: runStatusColor(run.status) }}
              />
              <span
                style={{
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {title}
              </span>
              <span style={{ color: "var(--text-3)" }}>
                {run.status} · {fmtAgoShort(run.startedAt)}
              </span>
            </button>
          );
        })}
      </div>
      {selectedRunId && (
        <button
          type="button"
          className={styles.chip}
          onClick={() => onSelect(null)}
          title="Clear run highlight"
        >
          ✕ clear
        </button>
      )}
    </div>
  );
}
