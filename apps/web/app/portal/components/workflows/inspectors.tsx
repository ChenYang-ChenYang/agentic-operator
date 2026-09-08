"use client";

import type { DragEvent, ReactNode } from "react";
import type { WorkflowValidationResponse } from "@agentic/contracts";
import {
  ActorTag,
  Badge,
  Button,
  Icon,
  eventTone,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useAgent, type DagAgent } from "@/lib/hooks/useAgents";
import { agentDisplayTitle } from "@/lib/agent-title";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";
import { WORKFLOW_AGENT_DRAG_TYPE } from "./canvas-interactions";
import type { WorkflowDraft } from "./draft";

/**
 * Catalog row built from the live `/v1/events` stream so the inspectors can
 * surface color + category metadata without the bootstrap snapshot.
 */
export interface EventCatalogItem {
  name: string;
  color: string;
  category: string;
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}
    >
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
        {title}
      </div>
      {children}
    </div>
  );
}

function LegendRow({
  color,
  label,
  sub,
}: {
  color: string;
  label: string;
  sub: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{ width: 10, height: 10, background: color, borderRadius: 2 }}
      />
      <span style={{ color: "var(--text)" }}>{label}</span>
      <span
        style={{
          marginLeft: "auto",
          color: "var(--text-3)",
          fontSize: 11,
          fontFamily: "var(--mono)",
        }}
      >
        {sub}
      </span>
    </div>
  );
}

export function DefaultInspector({
  events,
  agents,
  onPick,
}: {
  events: EventCatalogItem[];
  agents: DagAgent[];
  onPick: (name: string) => void;
}) {
  const { t } = useI18n();
  const grouped: Record<string, EventCatalogItem[]> = {
    agent: [],
    human: [],
    data: [],
    external: [],
    alert: [],
    system: [],
  };
  events.forEach((e) => {
    const bucket = grouped[e.category];
    if (bucket) bucket.push(e);
  });
  const labels: Record<string, string> = {
    agent: t("inspectors.catFromAgents"),
    human: t("inspectors.catFromHumans"),
    data: t("inspectors.catData"),
    external: t("inspectors.catExternal"),
    alert: t("inspectors.catAlerts"),
    system: t("inspectors.catSystem"),
  };

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
          }}
        >
          {t("inspectors.legend")}
        </div>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
          }}
        >
          <LegendRow
            color="var(--signal)"
            label={t("inspectors.agentNode")}
            sub={t("inspectors.inWorkflow", {
              count: agents.filter((a) => a.actor === "Agent").length,
            })}
          />
          <LegendRow
            color="var(--violet)"
            label={t("inspectors.humanNode")}
            sub={t("inspectors.inWorkflow", {
              count: agents.filter((a) => a.actor === "Human").length,
            })}
          />
        </div>
      </div>
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          {t("inspectors.eventsClickToTrace")}
        </div>
        {Object.entries(grouped).map(([cat, items]) =>
          items.length > 0 ? (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontFamily: "var(--mono)",
                  color: "var(--text-3)",
                  marginBottom: 5,
                }}
              >
                {labels[cat]}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {items.map((e) => (
                  <button
                    key={e.name}
                    onClick={() => onPick(e.name)}
                    style={{ display: "inline-block" }}
                  >
                    <Badge
                      tone={eventTone(e.color)}
                      style={{ fontSize: 9.5, cursor: "pointer" }}
                    >
                      {e.name}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>
          ) : null,
        )}
      </div>
      <div
        style={{
          padding: "14px 16px",
          fontSize: 11.5,
          color: "var(--text-3)",
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: "var(--text-2)", fontWeight: 500 }}>
          {t("inspectors.tip")}
        </strong>
        <span>
          {" · "}
          {t("inspectors.tipBody")}
        </span>
      </div>
    </div>
  );
}

export function AgentInspector({
  agent,
  onClose,
  onToggleWidth,
  isWide,
  canResize,
  workflowLabel,
}: {
  agent: DagAgent | null | undefined;
  onClose: () => void;
  onToggleWidth: () => void;
  isWide: boolean;
  canResize: boolean;
  workflowLabel: string;
}) {
  const { t, language } = useI18n();
  // Complete workflow definitions are authoritative. Only fetch the live
  // AgentDetail as a compatibility fallback for an older DAG projection that
  // does not yet carry its source definition.
  const detailQuery = useAgent(
    agent && !agent.definition ? agent.kebabId : null,
  );
  const detail = detailQuery.data;
  if (!agent) return null;

  // The selected DAG may be an unpublished version. Its complete definition
  // is authoritative; tenant runtime detail can point at a different live
  // version and is therefore only a fallback for old projections.
  const triggers = agent.triggers;
  const emits = agent.emits;
  const actionNames = agent.definition?.actions
    ? agent.definition.actions.map((action) => action.name)
    : (detail?.actions ?? []).map((action) => action.name);

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <ActorTag
              actor={agent.actor}
              label={t(
                agent.actor === "Agent"
                  ? "common.actorAgent"
                  : "common.actorHuman",
              )}
            />
            <Badge tone="muted">{agent.kebabId}</Badge>
          </div>
          <div
            style={{
              fontSize: 15,
              color: "var(--text)",
              fontWeight: 500,
              lineHeight: 1.3,
            }}
          >
            {agentDisplayTitle(agent, language)}
          </div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      {actionNames.length > 0 && (
        <Section title={t("inspectors.steps")}>
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {actionNames.map((s, i) => (
              <li
                key={`${s}-${i}`}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "4px 0",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    width: 18,
                  }}
                >
                  {i + 1}.
                </span>
                <span className="mono" style={{ color: "var(--text)" }}>
                  {s}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title={t("inspectors.triggers")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {triggers.length > 0 ? (
            triggers.map((t) => (
              <Badge key={t} tone="blue">
                {t}
              </Badge>
            ))
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>
              {t("inspectors.noneManual")}
            </span>
          )}
        </div>
      </Section>
      <Section title={t("inspectors.emits")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {emits.map((e) => (
            <Badge key={e} tone="green">
              {e}
            </Badge>
          ))}
        </div>
      </Section>
      <Section title={t("inspectors.workflow")}>
        <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
          {workflowLabel}
        </span>
      </Section>
      <Section title={t("inspectors.completeAgentSettings")}>
        {agent.definition ? (
          <details
            key={isWide ? "wide" : "standard"}
            open={isWide || undefined}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 5,
              background: "var(--bg-2)",
              overflow: "hidden",
            }}
          >
            <summary
              style={{
                padding: "9px 10px",
                color: "var(--text-2)",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("inspectors.viewCompleteManifest")}
            </summary>
            <pre
              aria-label={t("inspectors.completeSettingsFor", {
                title: agentDisplayTitle(agent, language),
              })}
              style={{
                margin: 0,
                padding: 12,
                maxHeight: isWide ? "calc(100vh - 410px)" : 360,
                overflow: "auto",
                color: "var(--text)",
                background: "#0f0f11",
                borderTop: "1px solid var(--border)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                lineHeight: 1.55,
                whiteSpace: "pre",
              }}
            >
              {JSON.stringify(agent.definition, null, 2)}
            </pre>
          </details>
        ) : (
          <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>
            {t("inspectors.completeDefinitionUnavailable")}
          </span>
        )}
      </Section>
      <div
        style={{
          padding: 14,
          marginTop: "auto",
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        {canResize ? (
          <Button
            icon={isWide ? "chevron-right" : "chevron-left"}
            tone="primary"
            onClick={onToggleWidth}
            ariaLabel={
              isWide
                ? t("inspectors.restoreWidthAria")
                : t("inspectors.expandWidthAria")
            }
            style={{ flex: 1, justifyContent: "center" }}
          >
            {isWide
              ? t("inspectors.restorePanel")
              : t("inspectors.expandDetails")}
          </Button>
        ) : (
          <span
            style={{
              width: "100%",
              color: "var(--text-3)",
              fontSize: 11,
              textAlign: "center",
            }}
          >
            {t("inspectors.fullWidth")}
          </span>
        )}
      </div>
    </div>
  );
}

export function EventInspector({
  eventName,
  agents,
  onClose,
  onNavigateAgent,
  onNavigateEvents,
}: {
  eventName: string;
  agents: DagAgent[];
  onClose: () => void;
  onNavigateAgent: (id: string) => void;
  onNavigateEvents: (eventName: string) => void;
}) {
  const { language, t } = useI18n();
  // Live event-name filter — bounded to 8 so the "recent" panel only shows
  // the most useful entries even if the tenant's event history is large.
  const eventsQuery = useEvents({ name: eventName, limit: 8 });
  const catalogQuery = useEvents({ limit: 200 });
  const recent = eventsQuery.data ?? [];
  const catalog = catalogQuery.data ?? [];
  const catalogRow = catalog.find((c) => c.name === eventName);

  const emitters = agents.filter((a) => a.emits.includes(eventName));
  const listeners = agents.filter((a) => a.triggers.includes(eventName));

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <Badge
            tone={eventTone(catalogRow?.color ?? "")}
            style={{ marginBottom: 8 }}
          >
            {eventName}
          </Badge>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("inspectors.categoryLabel")} · {catalogRow?.category ?? "—"}
          </div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      <Section title={t("inspectors.emittedBy", { count: emitters.length })}>
        <NodeList agents={emitters} onPick={onNavigateAgent} />
      </Section>
      <Section title={t("inspectors.listenedBy", { count: listeners.length })}>
        <NodeList agents={listeners} onPick={onNavigateAgent} />
      </Section>
      <Section title={t("inspectors.recent", { count: recent.length })}>
        {recent.map((row: EventRow) => {
          const at = row.receivedAt ? Date.parse(row.receivedAt) : null;
          return (
            <div
              key={row.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 0",
                fontSize: 11.5,
              }}
            >
              <span className="mono" style={{ color: "var(--text-2)" }}>
                {row.id}
              </span>
              <span style={{ color: "var(--text-3)" }}>
                {at != null && Number.isFinite(at)
                  ? fmtAgo(at, language)
                  : "—"}
              </span>
            </div>
          );
        })}
      </Section>
      <div
        style={{
          padding: 14,
          marginTop: "auto",
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button
          icon="external"
          onClick={() => onNavigateEvents(eventName)}
          style={{ width: "100%" }}
        >
          {t("inspectors.viewInEventStream")}
        </Button>
      </div>
    </div>
  );
}

function NodeList({
  agents,
  onPick,
}: {
  agents: DagAgent[];
  onPick: (id: string) => void;
}) {
  const { t, language } = useI18n();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {agents.map((a) => (
        <button
          key={a.kebabId}
          onClick={() => onPick(a.kebabId)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            textAlign: "left",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          <ActorTag
            actor={a.actor}
            label={t(
              a.actor === "Agent" ? "common.actorAgent" : "common.actorHuman",
            )}
          />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agentDisplayTitle(a, language)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function EditDraftBanner({
  counts,
}: {
  counts: { added: number; modified: number; removed: number };
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        padding: "10px 24px",
        background: "rgba(255,181,71,0.06)",
        borderBottom: "1px solid rgba(255,181,71,0.25)",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 14,
        flexShrink: 0,
      }}
    >
      <Icon name="alert" size={12} style={{ color: "var(--amber)" }} />
      <div
        style={{
          display: "flex",
          minWidth: 0,
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: "4px 12px",
          fontSize: 12,
          color: "var(--text)",
        }}
      >
        <span
          style={{
            color: "var(--amber)",
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: 10.5,
          }}
        >
          {t("inspectors.editingDraft")}
        </span>
        <span style={{ color: "var(--text-2)" }}>
          {t("inspectors.draftDiffSummary", {
            added: counts.added,
            modified: counts.modified,
            removed: counts.removed,
          })}
        </span>
        <span
          style={{
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {t("inspectors.savedInBrowser")}
        </span>
      </div>
    </div>
  );
}

export function EditToolbar({
  tool,
  setTool,
  onAddAgent,
  onAutoLayout,
  onZoomToFit,
}: {
  tool: string;
  setTool: (t: string) => void;
  onAddAgent: () => void;
  onAutoLayout: () => void;
  onZoomToFit: () => void;
}) {
  const { t } = useI18n();
  const tools = [
    { id: "select", icon: "filter" as const, label: t("inspectors.toolSelect") },
    { id: "connect", icon: "git" as const, label: t("inspectors.toolConnect") },
    {
      id: "add",
      icon: "plus" as const,
      label: t("inspectors.placeAgentOnCanvas"),
    },
  ];
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: "var(--z-overlay)" as unknown as number,
        display: "flex",
        maxWidth: "calc(100% - 24px)",
        flexWrap: "wrap",
        gap: 1,
        background: "var(--panel)",
        border: "1px solid var(--border-2)",
        borderRadius: 6,
        padding: 2,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      }}
    >
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id)}
          title={t.label}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          style={{
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: tool === t.id ? "var(--signal)" : "transparent",
            color: tool === t.id ? "#000" : "var(--text-2)",
            borderRadius: 4,
          }}
        >
          <Icon name={t.icon} size={13} />
        </button>
      ))}
      <div
        style={{ width: 1, background: "var(--border)", margin: "4px 4px" }}
      />
      <button
        type="button"
        title={t("inspectors.addAgentTitle")}
        aria-label={t("inspectors.addAgent")}
        onClick={onAddAgent}
        style={{
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "0 10px",
          color: "#050505",
          fontSize: 11.5,
          fontWeight: 650,
          whiteSpace: "nowrap",
          background: "var(--signal)",
          borderRadius: 4,
        }}
      >
        <Icon name="plus" size={12} />
        <span>{t("inspectors.addAgent")}</span>
      </button>
      <div
        style={{ width: 1, background: "var(--border)", margin: "4px 4px" }}
      />
      <button
        type="button"
        title={t("inspectors.autoLayout")}
        aria-label={t("inspectors.autoLayout")}
        onClick={onAutoLayout}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-2)",
        }}
      >
        <Icon name="dashboard" size={13} />
      </button>
      <button
        type="button"
        title={t("inspectors.zoomToFit")}
        aria-label={t("inspectors.zoomToFit")}
        onClick={onZoomToFit}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-2)",
        }}
      >
        <Icon name="external" size={13} />
      </button>
    </div>
  );
}

export function DraftPalette({
  workflowName,
  draft,
  connectFrom,
  validation,
  onAddAutomated,
  onAddHuman,
}: {
  workflowName: string;
  draft: WorkflowDraft;
  connectFrom: string | null;
  validation: WorkflowValidationResponse | null;
  onAddAutomated: () => void;
  onAddHuman: () => void;
}) {
  const { t } = useI18n();
  const added = Array.from(draft.added).sort();
  const modified = Object.keys(draft.agents)
    .filter((id) => !draft.added.has(id) && !draft.removed.has(id))
    .sort();
  const removed = Array.from(draft.removed).sort();
  const changeCount = added.length + modified.length + removed.length;
  const errors =
    validation?.issues.filter((issue) => issue.severity === "error") ?? [];
  const warnings =
    validation?.issues.filter((issue) => issue.severity === "warning") ?? [];

  function startAgentDrag(
    event: DragEvent<HTMLButtonElement>,
    actor: "Agent" | "Human",
  ) {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(WORKFLOW_AGENT_DRAG_TYPE, actor);
    event.dataTransfer.setData("text/plain", actor);
  }

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 4,
          }}
        >
          {t("inspectors.editing")}
        </div>
        <div style={{ fontSize: 14, color: "var(--text)" }}>
          {workflowName}{" "}
          <span
            style={{
              color: "var(--amber)",
              fontFamily: "var(--mono)",
              fontSize: 11,
            }}
          >
            · {t("inspectors.localDraft")}
          </span>
        </div>
      </div>

      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          {t("inspectors.addNode")}
        </div>
        <div
          style={{
            color: "var(--text-2)",
            fontSize: 11.5,
            lineHeight: 1.5,
            marginBottom: 9,
          }}
        >
          {t("inspectors.addNodeHelp")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            type="button"
            draggable
            onDragStart={(event) => startAgentDrag(event, "Agent")}
            onClick={onAddAutomated}
            aria-label={t("inspectors.addAutomatedAria")}
            title={t("inspectors.dragOrClickTitle")}
            style={{
              padding: "8px 10px",
              background: "var(--panel-2)",
              border: "1px dashed var(--border-2)",
              borderLeft: "3px solid var(--signal)",
              borderRadius: 4,
              cursor: "grab",
              textAlign: "left",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text)" }}>
              {t("inspectors.automatedAgent")}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              {t("inspectors.automatedAgentSub")}
            </div>
          </button>
          <button
            type="button"
            draggable
            onDragStart={(event) => startAgentDrag(event, "Human")}
            onClick={onAddHuman}
            aria-label={t("inspectors.addHumanAria")}
            title={t("inspectors.dragOrClickTitle")}
            style={{
              padding: "8px 10px",
              background: "var(--panel-2)",
              border: "1px dashed var(--border-2)",
              borderLeft: "3px solid var(--violet)",
              borderRadius: 4,
              cursor: "grab",
              textAlign: "left",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text)" }}>
              {t("inspectors.humanReview")}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              {t("inspectors.humanReviewSub")}
            </div>
          </button>
          <div
            style={{
              padding: "7px 9px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: connectFrom ? "var(--blue)" : "var(--text-3)",
              fontSize: 10.5,
              lineHeight: 1.45,
            }}
          >
            {connectFrom ? (
              <>
                {t("inspectors.connectionSource")}:{" "}
                <span className="mono">{connectFrom}</span>.{" "}
                {t("inspectors.connectionTargetHelp")}
              </>
            ) : (
              t("inspectors.connectionIdleHelp")
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          {t("inspectors.unsavedBrowserChanges")}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11.5,
          }}
        >
          {changeCount === 0 && (
            <div style={{ color: "var(--text-3)", padding: "5px 0" }}>
              {t("inspectors.noUnsavedChanges")}
            </div>
          )}
          {added.map((id) => (
            <DiffRow
              key={`add-${id}`}
              kind="add"
              name={id}
              hint={t("inspectors.diffNewNode")}
            />
          ))}
          {modified.map((id) => (
            <DiffRow
              key={`mod-${id}`}
              kind="mod"
              name={id}
              hint={t("inspectors.diffEdited")}
            />
          ))}
          {removed.map((id) => (
            <DiffRow
              key={`del-${id}`}
              kind="del"
              name={id}
              hint={t("inspectors.diffRemoved")}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          padding: "14px 16px",
          marginTop: "auto",
          borderTop: "1px solid var(--border)",
          fontSize: 11.5,
          color:
            validation === null
              ? "var(--text-3)"
              : validation.valid
                ? "var(--green)"
                : "var(--amber)",
          lineHeight: 1.55,
        }}
      >
        <Icon
          name={validation?.valid ? "check" : "alert"}
          size={11}
          style={{
            color:
              validation === null
                ? "var(--text-3)"
                : validation.valid
                  ? "var(--green)"
                  : "var(--amber)",
          }}
        />{" "}
        {validation === null
          ? t("inspectors.notValidated")
          : validation.valid
            ? t("inspectors.validated", {
                count: validation.promptScores.length,
              })
            : t("inspectors.validationIssues", {
                errors: errors.length,
                warnings: warnings.length,
              })}
      </div>
    </div>
  );
}

function DiffRow({
  kind,
  name,
  hint,
}: {
  kind: "add" | "del" | "mod";
  name: string;
  hint: string;
}) {
  const tone =
    kind === "add"
      ? "var(--green)"
      : kind === "del"
        ? "var(--red)"
        : "var(--amber)";
  const sigil = kind === "add" ? "+" : kind === "del" ? "−" : "~";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 3,
      }}
    >
      <span
        className="mono"
        style={{ color: tone, width: 12, fontWeight: 700 }}
      >
        {sigil}
      </span>
      <span className="mono" style={{ color: "var(--text-2)", fontSize: 11.5 }}>
        {name}
      </span>
      <span
        style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: 10.5 }}
      >
        {hint}
      </span>
    </div>
  );
}
