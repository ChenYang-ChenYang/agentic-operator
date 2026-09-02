/**
 * LiveWorkflowView — the Runs page's runtime counterpart to the Workflows canvas.
 *
 * Workflows is BUILD TIME: you design the graph there. This is RUNTIME: the same
 * nodes and edges, read-only, coloured by what is happening right now, with the
 * activity feed beside it. An operator watching a demo should be able to see the
 * flow move without opening a single run.
 *
 * Composition, not new machinery — every piece already existed:
 *   useDag                 → nodes + edges (the published graph)
 *   useWorkflowLiveState   → per-agent live status, incl. waiting_human + task ids
 *   useWorkflowLiveState   → …and, through its frame tap, the same SSE frames
 *                            projected into the activity feed on one connection
 *   useTask/useResolveTask → resolving a blocking task in place
 *   layout.ts              → the identical auto-pack layout the build canvas uses,
 *                            so a node sits where the designer put it
 *
 * The one deliberate difference from the build canvas: nodes are not draggable
 * and carry no edit affordances. A monitoring surface that can silently mutate
 * the design is a foot-gun.
 */
"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useDag, type DagAgent } from "@/lib/hooks/useAgents";
import type { RunStreamEvent } from "@agentic/contracts";
import {
  useWorkflowLiveState,
  type AgentLiveStatus,
} from "@/lib/hooks/useWorkflowLiveState";
import {
  NODE_H,
  NODE_W,
  PAD_X,
  PAD_Y,
  autoPackLayout,
  nodePos,
} from "@/app/portal/components/workflows/layout";
import { Badge, Empty } from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import type { Language } from "@/lib/i18n/types";
import { Icon } from "@/app/portal/components/Icon";
import {
  agentSubtitle,
  appendFeed,
  countStates,
  edgeVisual,
  linkRunAgent,
  nextFollowState,
  nodeFreshness,
  nodeVisual,
  toFeedEntry,
  visibleFeed,
  type FeedEntry,
  type NodeFreshness,
} from "./live-view";
import { NodeTaskPanel } from "./NodeTaskPanel";

const FEED_W = 400;

export function LiveWorkflowView() {
  const { language } = useI18n();
  const tenant = useTenant();
  const copy = useCallback(
    (zh: string, en: string) => (language === "zh" ? zh : en),
    [language],
  );

  const dag = useDag();
  const seqRef = useRef(0);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  // runId → agent, so terminal frames that omit the agent still say whose run
  // just ended. A ref, not state: it feeds rendering but never drives it.
  const runAgentsRef = useRef(new Map<string, string>());
  const onFrame = useCallback(
    (event: RunStreamEvent) => {
      const entry = toFeedEntry(event, (seqRef.current += 1), copy);
      if (!entry) return;
      const linked = linkRunAgent(runAgentsRef.current, entry);
      setFeed((prev) => appendFeed(prev, linked));
    },
    [copy],
  );
  const live = useWorkflowLiveState(tenant, onFrame);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  // DEBUG lines are real content but bury the business ones; off by default.
  const [verbose, setVerbose] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(
    () => visibleFeed(feed, { verbose, agent: selectedAgent }),
    [feed, verbose, selectedAgent],
  );

  // Tail behaviour: stick to the bottom, but stop fighting the operator the
  // moment they scroll up to read something. The pinned position is recorded so
  // the scroll event this causes is not mistaken for the operator scrolling.
  const pinnedTopRef = useRef<number | null>(null);
  useEffect(() => {
    if (!follow) return;
    const el = feedRef.current;
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    el.scrollTop = target;
    pinnedTopRef.current = el.scrollTop;
  }, [shown, follow]);

  const agents = useMemo(() => dag.data?.agents ?? [], [dag.data]);
  const edges = useMemo(() => dag.data?.edges ?? [], [dag.data]);

  // Freshness is a function of elapsed time, so it needs a clock. It ticks only
  // while a node can still decay, so an idle canvas costs nothing.
  const [now, setNow] = useState(() => Date.now());
  const hasDecayable = agents.some((agent) => {
    const state = live.agents[agent.name];
    return (
      state != null &&
      nodeFreshness(state.state, state.lastEventAt, now) === "recent"
    );
  });
  useEffect(() => {
    if (!hasDecayable) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [hasDecayable]);

  const positions = useMemo(() => {
    const fallback = autoPackLayout(
      agents.map((agent) => ({
        id: agent.kebabId,
        stage: agent.stage ?? 0,
        triggers: agent.triggers ?? [],
        emits: agent.emits ?? [],
      })),
    );
    const map = new Map<string, { x: number; y: number }>();
    for (const agent of agents) {
      map.set(agent.name, agent.position ?? nodePos(agent.kebabId, fallback));
    }
    return map;
  }, [agents]);

  const counts = useMemo(
    () => countStates(agents, live.agents, now),
    [agents, live.agents, now],
  );

  const activeAgents = useMemo(() => {
    const names = new Set<string>();
    for (const agent of agents) {
      const state = live.agents[agent.name];
      if (
        state &&
        nodeFreshness(state.state, state.lastEventAt, now) !== "stale"
      ) {
        names.add(agent.name);
      }
    }
    return names;
  }, [agents, live.agents, now]);

  const canvasSize = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const point of positions.values()) {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { w: maxX + NODE_W + PAD_X * 2, h: maxY + NODE_H + PAD_Y * 2 };
  }, [positions]);

  const selected = selectedAgent
    ? (agents.find((agent) => agent.name === selectedAgent) ?? null)
    : null;
  const selectedTasks = selectedAgent
    ? (live.agents[selectedAgent]?.waitingTaskIds ?? [])
    : [];

  if (dag.isLoading) {
    return <Empty title={copy("正在载入工作流…", "Loading the workflow…")} />;
  }
  if (dag.isError) {
    return (
      <Empty
        title={copy("工作流载入失败", "Could not load the workflow")}
        hint={dag.error instanceof Error ? dag.error.message : undefined}
      />
    );
  }
  if (agents.length === 0) {
    return (
      <Empty
        title={copy("该业务领域还没有已发布的工作流", "No published workflow yet")}
        hint={copy(
          "先在「工作流」中发布一个版本，这里才有节点可以监看。",
          "Publish a version on Workflows first — this view watches what is live.",
        )}
      />
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      {/* ── canvas ───────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
            {dag.data?.workflowName ?? dag.data?.workflowSlug ?? tenant}
          </span>
          {counts.running === 0 &&
          counts.waiting === 0 &&
          counts.failed === 0 &&
          counts.ok === 0 ? (
            // Four zeros say nothing. Name the state instead, so a quiet graph
            // reads as quiet rather than as a view that failed to load.
            <Badge tone="muted">
              {copy("当前没有活动", "Nothing running right now")}
            </Badge>
          ) : (
            <Badge tone="signal">
              {copy("运行中", "Running")} {counts.running}
            </Badge>
          )}
          {counts.waiting > 0 && (
            <Badge tone="amber">
              {copy("待人工", "Waiting")} {counts.waiting}
            </Badge>
          )}
          {counts.failed > 0 && (
            <Badge tone="red">
              {copy("失败", "Failed")} {counts.failed}
            </Badge>
          )}
          {counts.ok > 0 && (
            <Badge tone="green">
              {copy("已完成", "Done")} {counts.ok}
            </Badge>
          )}
          <span style={{ fontSize: 11.5, color: "var(--text-3)", marginLeft: "auto" }}>
            {copy(
              "彩色节点与绿色连线＝5 分钟内走过的路径；点击节点只看它的动作，琥珀色可点开人工任务",
              "Coloured nodes and green edges are the path taken in the last 5 min; click a node to filter it, amber opens its task",
            )}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}>
          <div
            style={{
              position: "relative",
              width: canvasSize.w,
              height: canvasSize.h,
              minWidth: "100%",
            }}
          >
            <EdgeLayer
              agents={agents}
              edges={edges}
              positions={positions}
              pulsed={live.activeEventNames}
              traversed={activeAgents}
              size={canvasSize}
            />
            {agents.map((agent) => (
              <LiveNode
                key={agent.id}
                agent={agent}
                position={positions.get(agent.name) ?? { x: PAD_X, y: PAD_Y }}
                status={live.agents[agent.name]?.state}
                freshness={nodeFreshness(
                  live.agents[agent.name]?.state,
                  live.agents[agent.name]?.lastEventAt,
                  now,
                )}
                lastEventAt={live.agents[agent.name]?.lastEventAt ?? null}
                waitingCount={
                  live.agents[agent.name]?.waitingTaskIds.length ?? 0
                }
                runningCount={live.agents[agent.name]?.runningCount ?? 0}
                selected={selectedAgent === agent.name}
                onSelect={() =>
                  setSelectedAgent((prev) =>
                    prev === agent.name ? null : agent.name,
                  )
                }
                copy={copy}
                language={language}
              />
            ))}
          </div>
        </div>

        {selected && (
          <NodeTaskPanel
            agent={selected}
            taskIds={selectedTasks}
            onClose={() => setSelectedAgent(null)}
          />
        )}
      </div>

      {/* ── activity feed ────────────────────────────────────────────────── */}
      <div
        style={{
          width: FEED_W,
          flexShrink: 0,
          borderLeft: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {copy("处理动作流水线", "Activity")}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {shown.length}
            {shown.length !== feed.length && ` / ${feed.length}`}
          </span>
          <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <FeedToggle
              on={verbose}
              onClick={() => setVerbose((prev) => !prev)}
              title={copy(
                "显示 DEBUG 级日志",
                "Include DEBUG log lines",
              )}
            >
              {copy("详细", "Verbose")}
            </FeedToggle>
            <FeedToggle
              on={follow}
              onClick={() => setFollow((prev) => !prev)}
              title={copy("自动滚到最新", "Stick to the newest row")}
            >
              {copy("跟随", "Follow")}
            </FeedToggle>
          </span>
        </div>

        {selectedAgent && (
          <div
            style={{
              padding: "6px 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11.5,
              color: "var(--text-3)",
            }}
          >
            <span>{copy("只看", "Only")}</span>
            <strong style={{ color: "var(--text)" }}>{selectedAgent}</strong>
            <button
              type="button"
              onClick={() => setSelectedAgent(null)}
              style={{
                marginLeft: "auto",
                fontSize: 11,
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-3)",
                borderRadius: "var(--r-sm)",
                padding: "1px 7px",
                cursor: "pointer",
              }}
            >
              {copy("看全部", "Show all")}
            </button>
          </div>
        )}
        <div
          ref={feedRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            const next = nextFollowState({
              follow,
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              pinnedTop: pinnedTopRef.current,
            });
            if (next !== follow) setFollow(next);
          }}
          style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px 0" }}
        >
          {shown.length === 0 ? (
            <div
              style={{
                padding: "16px 12px",
                fontSize: 12,
                color: "var(--text-3)",
                lineHeight: 1.7,
              }}
            >
              {feed.length > 0
                ? copy(
                    "当前筛选下没有动作。",
                    "Nothing matches the current filter.",
                  )
                : copy(
                    "等待事件…触发一次工作流后，这里会像日志一样持续滚动：每一步、每次工具调用、每次模型调用和日志都会出现。",
                    "Waiting for events — fire the workflow and this tails like a log: every step, tool call, model call and log line.",
                  )}
            </div>
          ) : (
            shown.map((entry) => <FeedRow key={entry.id} entry={entry} />)
          )}
        </div>
      </div>
    </div>
  );
}

const TONE_COLOR: Record<FeedEntry["tone"], string> = {
  neutral: "var(--text-3)",
  running: "var(--signal)",
  ok: "var(--green)",
  failed: "var(--red)",
  waiting: "var(--amber)",
};

/** A small on/off chip, so the feed's controls read as one set. */
function FeedToggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      style={{
        fontSize: 11,
        background: "transparent",
        border: `1px solid ${on ? "var(--signal)" : "var(--border)"}`,
        color: on ? "var(--signal)" : "var(--text-3)",
        borderRadius: "var(--r-sm)",
        padding: "2px 8px",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/**
 * One line of the tail: who, what action, what happened, and what it cost.
 *
 * `label` is the action itself — a step name, a tool name, a model, an event —
 * so the eye can scan the left edge and follow what an agent is doing without
 * reading every sentence. `meta` carries the numbers, dimmed, at the end.
 */
function FeedRow({ entry }: { entry: FeedEntry }) {
  const time = new Date(entry.at).toLocaleTimeString();
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "3px 12px",
        fontSize: 11.5,
        lineHeight: 1.55,
        alignItems: "baseline",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: 5,
          background: TONE_COLOR[entry.tone],
          flexShrink: 0,
          transform: "translateY(-1px)",
        }}
      />
      <span className="mono" style={{ color: "var(--text-4)", flexShrink: 0 }}>
        {time}
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {entry.agent && (
          <span style={{ color: "var(--text)", fontWeight: 600 }}>
            {entry.agent}{" "}
          </span>
        )}
        {entry.label && (
          <span
            className="mono"
            style={{ color: TONE_COLOR[entry.tone] }}
          >
            {entry.label}{" "}
          </span>
        )}
        <span style={{ color: "var(--text-2)" }}>{entry.detail}</span>
        {entry.meta && (
          <span className="mono" style={{ color: "var(--text-4)" }}>
            {" "}
            {entry.meta}
          </span>
        )}
      </span>
    </div>
  );
}

export function LiveNode({
  agent,
  position,
  status,
  freshness = "recent",
  lastEventAt = null,
  waitingCount,
  runningCount,
  selected,
  onSelect,
  copy,
  language = "zh",
}: {
  agent: DagAgent;
  position: { x: number; y: number };
  status: AgentLiveStatus | undefined;
  freshness?: NodeFreshness;
  lastEventAt?: number | null;
  waitingCount: number;
  runningCount: number;
  selected: boolean;
  onSelect: () => void;
  copy: (zh: string, en: string) => string;
  language?: Language;
}) {
  const visual = nodeVisual(status, freshness);
  const subtitle = agentSubtitle(agent.definition?.description);
  const ago = lastEventAt ? fmtAgo(lastEventAt, language) : null;
  const label =
    waitingCount > 0
      ? copy(`待人工 ${waitingCount}`, `${waitingCount} waiting`)
      : runningCount > 0
        ? copy(`运行中 ${runningCount}`, `${runningCount} running`)
        : status === "failed"
          ? copy(`失败 ${ago ?? ""}`.trim(), `Failed ${ago ?? ""}`.trim())
          : status === "ok"
            ? copy(`已完成 ${ago ?? ""}`.trim(), `Done ${ago ?? ""}`.trim())
            : agent.actor === "Human"
              ? copy("人工节点", "Human step")
              : copy("空闲", "Idle");
  return (
    <button
      type="button"
      onClick={onSelect}
      title={
        visual.actionable
          ? copy("点开处理人工任务", "Open the human task")
          : copy("只看这个智能体的动作", "Show only this agent's activity")
      }
      style={{
        position: "absolute",
        left: position.x,
        top: position.y,
        width: NODE_W,
        height: NODE_H,
        textAlign: "left",
        padding: "6px 10px",
        borderRadius: "var(--r-md)",
        background: "var(--panel-2)",
        border: `${visual.emphasis === "strong" ? 2 : 1}px solid ${
          selected ? "var(--signal)" : visual.accent
        }`,
        boxShadow: selected ? "var(--shadow-2)" : "none",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {agent.title || agent.name}
      </span>
      {subtitle && (
        // The name says what the agent is called; this says what it does.
        <span
          style={{
            fontSize: 10.5,
            color: "var(--text-3)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {subtitle}
        </span>
      )}
      <span style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10.5 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 6,
            background: visual.accent,
            flexShrink: 0,
            // Only the dot animates. The shared `pulse` keyframes scale and fade
            // their element — on a whole node card that reads as the card
            // flickering out, not as work in progress.
            animation: visual.pulse
              ? "pulse 1.6s var(--ease-inout) infinite"
              : undefined,
          }}
        />
        <span style={{ color: "var(--text-3)" }}>{label}</span>
        {waitingCount > 0 && (
          <Icon name="task" size={10} style={{ marginLeft: "auto" }} />
        )}
      </span>
    </button>
  );
}

/**
 * Edges are drawn in one SVG under the nodes. An edge is highlighted while its
 * event pulsed recently, which is what makes the graph visibly "move" as the
 * chain advances.
 */
function EdgeLayer({
  agents,
  edges,
  positions,
  pulsed,
  traversed,
  size,
}: {
  agents: DagAgent[];
  edges: Array<{ fromAgent: string; toAgent: string; event: string; active: boolean }>;
  positions: Map<string, { x: number; y: number }>;
  pulsed: Set<string>;
  /** Agent names with recent activity — an edge between two of them ran. */
  traversed: Set<string>;
  size: { w: number; h: number };
}) {
  const byName = useMemo(
    () => new Map(agents.map((agent) => [agent.name, agent])),
    [agents],
  );
  return (
    <svg
      width={size.w}
      height={size.h}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden
    >
      {edges.map((edge, index) => {
        const from = positions.get(edge.fromAgent);
        const to = positions.get(edge.toAgent);
        if (!from || !to || !byName.has(edge.fromAgent) || !byName.has(edge.toAgent)) {
          return null;
        }
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const mid = x1 + Math.max(24, (x2 - x1) / 2);
        const visual = edgeVisual({
          hot: pulsed.has(edge.event),
          // Both ends moved recently, so the chain came through here.
          traversed:
            traversed.has(edge.fromAgent) && traversed.has(edge.toAgent),
          declared: edge.active,
        });
        return (
          <path
            key={`${edge.fromAgent}->${edge.toAgent}:${edge.event}:${index}`}
            d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke={visual.stroke}
            strokeWidth={visual.width}
            opacity={visual.opacity}
          />
        );
      })}
    </svg>
  );
}
