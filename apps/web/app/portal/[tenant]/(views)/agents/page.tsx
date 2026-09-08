"use client";

/**
 * Agents view — list + detail page. P2-FE-09.
 *
 * Live data via canonical TanStack hooks:
 *   - useAgents() — workflow agent list (tenant-scoped)
 *   - useRuns({ limit: 200 }) — recent runs used for the per-agent stats
 *
 * Detail is in a separate route at `/portal/[tenant]/agents/[id]` so the
 * browser URL reflects the selected agent. The list page mirrors the v1_1
 * one-screen UX by routing to the detail page on click and rendering the
 * grid when none is selected.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ActorTag,
  Badge,
  Button,
  Empty,
  FilterChip,
  SearchInput,
  ViewHeader,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import { useAgents, useDag, type AgentListRow } from "@/lib/hooks/useAgents";
import { agentDisplayTitle } from "@/lib/agent-title";
import { useRuns } from "@/lib/hooks/useRuns";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { agentKindLabel } from "@/app/portal/lib/protocol-labels";
import { ImportManifestModal } from "@/app/portal/components/import-manifest/ImportManifestModal";
import { DeployAgentModal } from "@/app/portal/components/agents/DeployAgentModal";
import { buildAgentStats, type AgentStatsSnapshot } from "@/lib/agent-stats";

export default function AgentsPage() {
  const router = useRouter();
  const tenant = useTenant();
  const { t, language } = useI18n();
  const agentsQuery = useAgents();
  // The list rows come from the agents table (one title); the live manifest
  // carries the per-language titles, so borrow them by manifest name.
  const dagQuery = useDag();
  const titleI18nByName = useMemo(
    () =>
      new Map(
        (dagQuery.data?.agents ?? []).map((agent) => [
          agent.name,
          agent.titleI18n ?? null,
        ]),
      ),
    [dagQuery.data],
  );
  const displayTitle = (a: AgentListRow): string =>
    agentDisplayTitle(
      { name: a.name, title: a.title, titleI18n: titleI18nByName.get(a.name) ?? null },
      language,
    );
  const runsQuery = useRuns({ limit: 200 });
  const agents = agentsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const [query, setQuery] = useState("");
  const [actorFilter, setActorFilter] = useState<"all" | "Agent" | "Human">(
    "all",
  );
  const [importOpen, setImportOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);

  const stats = useMemo(() => {
    return buildAgentStats(agents, runs);
  }, [agents, runs]);

  const filtered = agents.filter((a) => {
    if (actorFilter !== "all" && a.actor !== actorFilter) return false;
    if (
      query &&
      !displayTitle(a).toLowerCase().includes(query.toLowerCase()) &&
      !a.name.toLowerCase().includes(query.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  function openAgent(kebabId: string) {
    router.push(`/portal/${tenant}/agents/${kebabId}` as never);
  }

  const isLoading = agentsQuery.isLoading;
  const isError = agentsQuery.isError;
  const error = agentsQuery.error;
  const statsReady = agentsQuery.data !== undefined && !agentsQuery.isError;
  const runSampleReady = runsQuery.data !== undefined && !runsQuery.isError;
  const countsReady = agentsQuery.data !== undefined && !agentsQuery.isError;
  const countValue: string | number = countsReady
    ? agents.length
    : agentsQuery.isLoading
      ? "…"
      : "—";
  const automatedValue: string | number = countsReady
    ? agents.filter((agent) => agent.actor === "Agent").length
    : countValue;
  const humanValue: string | number = countsReady
    ? agents.filter((agent) => agent.actor === "Human").length
    : countValue;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.agents")}
        subtitle={t("agents.subtitle", {
          count: countValue,
          automated: automatedValue,
          human: humanValue,
        })}
        action={[
          <Button
            key="upload"
            icon="upload"
            small
            onClick={() => setImportOpen(true)}
          >
            {t("agents.importManifest")}
          </Button>,
          <Button
            key="new"
            icon="plus"
            tone="primary"
            small
            onClick={() => setNewAgentOpen(true)}
          >
            {t("agents.newAgent")}
          </Button>,
        ]}
      />

      {runsQuery.isError ? (
        <div
          role="alert"
          style={{
            padding: "8px 16px",
            color: "var(--amber)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {t("agents.statsUnavailable")}: {runsQuery.error.message}
        </div>
      ) : null}

      <div
        style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0 }}
      >
        <aside
          style={{
            width: "100%",
            flexShrink: 0,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
            }}
          >
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("agents.searchPlaceholder")}
            />
          </div>
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 6,
            }}
          >
            <FilterChip
              active={actorFilter === "all"}
              onClick={() => setActorFilter("all")}
            >
              {t("agents.filterAll")}
            </FilterChip>
            <FilterChip
              active={actorFilter === "Agent"}
              onClick={() => setActorFilter("Agent")}
            >
              {t("agents.filterAgents")}
            </FilterChip>
            <FilterChip
              active={actorFilter === "Human"}
              onClick={() => setActorFilter("Human")}
            >
              {t("agents.filterHuman")}
            </FilterChip>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {isError ? (
              <Empty
                title={t("agents.loadFailedTitle")}
                hint={error?.message ?? t("agents.loadFailedHint")}
              />
            ) : isLoading && agents.length === 0 ? (
              <Empty title={t("agents.loadingTitle")} hint="" />
            ) : filtered.length === 0 ? (
              <Empty
                title={t("agents.emptyTitle")}
                hint={
                  agents.length === 0
                    ? t("agents.emptyHintNone")
                    : t("agents.emptyHintFilter")
                }
              />
            ) : (
              <AgentsGrid
                agents={filtered}
                stats={stats}
                statsReady={statsReady}
                runSampleReady={runSampleReady}
                onPick={openAgent}
                displayTitle={displayTitle}
              />
            )}
          </div>
        </aside>
      </div>

      {newAgentOpen && (
        <DeployAgentModal onClose={() => setNewAgentOpen(false)} />
      )}
      {importOpen && (
        <ImportManifestModal
          onClose={() => setImportOpen(false)}
          mode="agent"
        />
      )}
    </div>
  );
}

function AgentsGrid({
  agents,
  stats,
  statsReady,
  runSampleReady,
  onPick,
  displayTitle,
}: {
  agents: AgentListRow[];
  stats: Map<string, AgentStatsSnapshot>;
  statsReady: boolean;
  runSampleReady: boolean;
  onPick: (kebabId: string) => void;
  /** Language-aware title (the row itself only carries the stored one). */
  displayTitle: (a: AgentListRow) => string;
}) {
  const { language, t } = useI18n();
  return (
    <div
      style={{
        padding: 16,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
      }}
    >
      {agents.map((a) => {
        const s = stats.get(a.kebabId) ?? stats.get(a.name);
        return (
          <button
            key={a.id}
            onClick={() => onPick(a.kebabId)}
            style={{
              padding: "12px 14px",
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderLeft: `3px solid ${a.actor === "Agent" ? "var(--signal)" : "var(--violet)"}`,
              borderRadius: 6,
              textAlign: "left",
              transition: "background 0.12s, border-color 0.12s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--panel-2)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--panel)";
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
                minWidth: 0,
              }}
            >
              <span style={{ flexShrink: 0, display: "inline-flex" }}>
                <ActorTag
                  actor={a.actor}
                  label={
                    a.actor === "Agent"
                      ? t("common.actorAgent")
                      : t("common.actorHuman")
                  }
                />
              </span>
              <Badge
                tone="muted"
                style={{
                  display: "block",
                  minWidth: 0,
                  flexShrink: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <span title={a.kebabId}>{a.kebabId}</span>
              </Badge>
              <span
                style={{
                  marginLeft: "auto",
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  fontSize: 10.5,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                }}
              >
                {statsReady
                  ? (s?.lastRun ?? 0) > 0
                    ? fmtAgo(s!.lastRun, language)
                    : t("agents.idle")
                  : "—"}
              </span>
            </div>
            <div
              style={{
                fontSize: 13.5,
                color: "var(--text)",
                fontWeight: 500,
                marginBottom: 4,
                lineHeight: 1.3,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              }}
            >
              {displayTitle(a)}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-2)",
                lineHeight: 1.5,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {a.description ?? ""}
            </div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--text-3)",
              }}
            >
              {statsReady ? (
                <span>{t("agents.runsCount", { count: s?.runs ?? 0 })}</span>
              ) : (
                <span>{t("agents.statsUnavailable")}</span>
              )}
              {statsReady && (s?.errors ?? 0) > 0 && (
                <span style={{ color: "var(--red)" }}>
                  {t("agents.errCount", { count: s?.errors ?? 0 })}
                </span>
              )}
              {runSampleReady && (s?.sampledTests ?? 0) > 0 && (
                <span style={{ color: "var(--accent-text)" }}>
                  {t("agents.sampledTestCount", {
                    count: s?.sampledTests ?? 0,
                  })}
                </span>
              )}
              <span style={{ marginLeft: "auto" }}>
                {agentKindLabel(t, a.kind)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
