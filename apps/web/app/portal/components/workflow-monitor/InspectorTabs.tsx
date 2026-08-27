"use client";

/**
 * InspectorTabs — Timeline / Live / Definition switch for the workflow
 * inspector aside when a node is selected outside edit mode (§G4).
 *
 * Timeline leads because it is the tab that answers "what is this agent doing
 * right now"; Live keeps the run controls and recent-run list, Definition the
 * static manifest.
 */

import { useI18n } from "@/app/portal/lib/preferences-context";
import styles from "./monitor.module.css";

export type MonitorInspectorTab = "timeline" | "live" | "definition";

export function InspectorTabs({
  tab,
  onChange,
}: {
  tab: MonitorInspectorTab;
  onChange: (tab: MonitorInspectorTab) => void;
}) {
  const { t } = useI18n();
  const tabs: Array<[MonitorInspectorTab, string]> = [
    ["timeline", t("monitor.tabTimeline")],
    ["live", t("monitor.tabLive")],
    ["definition", t("monitor.tabDefinition")],
  ];
  return (
    <div className={styles.tabs} role="tablist" aria-label="Agent inspector">
      {tabs.map(([key, label]) => (
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
