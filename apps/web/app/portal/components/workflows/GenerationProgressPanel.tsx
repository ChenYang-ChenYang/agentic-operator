"use client";

/**
 * What the server is doing while a workflow generates.
 *
 * Every stage, duration and token count here comes from the server's own
 * progress stream; the only client-side value is the total elapsed clock, which
 * is labelled as elapsed rather than as an estimate. Nothing predicts how long
 * the remaining work will take.
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { WorkflowGenerationProgress } from "@agentic/contracts";
import { Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  buildGenerationTimeline,
  formatElapsed,
  type GenerationStageState,
} from "./generation-progress";

export interface GenerationProgressPanelProps {
  events: readonly WorkflowGenerationProgress[];
  /** True while the request is in flight; drives the elapsed clock. */
  running: boolean;
  startedAt: number | null;
}

function stateColor(state: GenerationStageState): string {
  if (state === "done") return "var(--signal)";
  if (state === "active") return "var(--signal)";
  if (state === "failed") return "var(--red)";
  return "var(--text-3)";
}

function StageMark({ state }: { state: GenerationStageState }) {
  if (state === "done") return <Icon name="check" size={11} />;
  if (state === "failed") return <Icon name="alert" size={11} />;
  if (state === "active")
    return (
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "var(--signal)",
          display: "inline-block",
          animation: "pulse 1.2s ease-in-out infinite",
        }}
      />
    );
  return (
    <span
      aria-hidden="true"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        border: "1px solid var(--border-2)",
        display: "inline-block",
      }}
    />
  );
}

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "16px 1fr auto",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
  fontSize: 11.5,
};

export function GenerationProgressPanel({
  events,
  running,
  startedAt,
}: GenerationProgressPanelProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  const timeline = buildGenerationTimeline(events);
  const elapsedMs =
    startedAt === null ? 0 : Math.max(0, (running ? now : now) - startedAt);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "grid",
        gap: 6,
        padding: "12px 14px",
        marginTop: 12,
        borderRadius: 6,
        border: "1px solid var(--border-2)",
        background: "var(--panel-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 12 }}>
          {running
            ? t("newWorkflowModal.progressRunning")
            : t("newWorkflowModal.progressDone")}
        </strong>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-2)",
          }}
        >
          {t("newWorkflowModal.progressElapsed", {
            elapsed: formatElapsed(elapsedMs),
          })}
          {timeline.tokensIn !== null || timeline.tokensOut !== null
            ? ` · ${t("newWorkflowModal.progressTokens", {
                input: (timeline.tokensIn ?? 0).toLocaleString(),
                output: (timeline.tokensOut ?? 0).toLocaleString(),
              })}`
            : ""}
        </span>
      </div>

      <div>
        {timeline.stages.map((stage) => (
          <div key={stage.id} style={rowStyle}>
            <span
              style={{
                display: "inline-flex",
                justifyContent: "center",
                color: stateColor(stage.state),
              }}
            >
              <StageMark state={stage.state} />
            </span>
            <span
              style={{
                color:
                  stage.state === "pending" || stage.state === "skipped"
                    ? "var(--text-3)"
                    : "var(--text)",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {t(`newWorkflowModal.stage_${stage.id}`)}
              {stage.detail ? (
                <span style={{ color: "var(--text-3)" }}> · {stage.detail}</span>
              ) : null}
            </span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10.5,
                color: "var(--text-3)",
              }}
            >
              {stage.state === "skipped"
                ? t("newWorkflowModal.stageSkipped")
                : stage.durationMs !== null
                  ? formatElapsed(stage.durationMs)
                  : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
