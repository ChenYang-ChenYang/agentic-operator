"use client";

/**
 * LiveLegend — small always-on legend for the live workflow canvas (§G4).
 */

import { EDGE_PULSE_WINDOW_MS } from "@/lib/hooks/useWorkflowLiveState";
import styles from "./monitor.module.css";

const ITEMS: Array<{ color: string; label: string }> = [
  { color: "var(--signal)", label: "running" },
  { color: "var(--amber)", label: "waiting human" },
  { color: "var(--green)", label: "ok" },
  { color: "var(--red)", label: "failed" },
];

export function LiveLegend() {
  return (
    <div className={styles.legend} aria-hidden="true">
      <span className={styles.legendItem} style={{ color: "var(--text-2)" }}>
        LIVE
      </span>
      {ITEMS.map((item) => (
        <span key={item.label} className={styles.legendItem}>
          <span
            className={styles.legendDot}
            style={{ background: item.color }}
          />
          {item.label}
        </span>
      ))}
      <span className={styles.legendItem}>
        ● moving dot = event emitted &lt;{Math.round(EDGE_PULSE_WINDOW_MS / 1000)}
        s ago
      </span>
    </div>
  );
}
