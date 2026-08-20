"use client";

/**
 * InspectorTabs — Live / Definition switch for the workflow inspector aside
 * when a node is selected outside edit mode (§G4).
 */

import styles from "./monitor.module.css";

export type MonitorInspectorTab = "live" | "definition";

export function InspectorTabs({
  tab,
  onChange,
}: {
  tab: MonitorInspectorTab;
  onChange: (tab: MonitorInspectorTab) => void;
}) {
  return (
    <div className={styles.tabs} role="tablist" aria-label="Agent inspector">
      {(
        [
          ["live", "Live"],
          ["definition", "Definition"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          className={`${styles.tab} ${tab === key ? styles.tabActive : ""}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
