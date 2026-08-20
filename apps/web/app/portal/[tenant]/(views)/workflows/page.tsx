"use client";

/**
 * Workflows view — DAG canvas of all agents wired by events. P2-FE-08.
 *
 * Ported from `agentic-operator_v1_1/views/workflows.jsx` (999 LOC), preserves:
 *   - the hand-tuned LAYOUT map (audit 01 §4.2 acceptance — see `./components/workflows/layout.ts`)
 *   - 8 stage columns + 5-lane grid
 *   - cubic-bezier SVG edges with color-coded arrowheads
 *   - animated travelling dots on live edges
 *   - edit-mode banner, toolbar, draft palette, node editor
 *   - NewWorkflowModal (template / blank / import paths)
 *   - ImportManifestModal hook
 *
 * Data sources (all live, no bootstrap snapshot):
 *   - useDag()             → agents + workflowVersion (from /v1/workflows/dag)
 *   - useEvents({limit})   → event catalog metadata (color/category) +
 *                            live event stream for the inspector
 *
 * Stages are derived from the live DAG's `stage` indices (see STAGE_LABELS
 * below) so each tenant's funnel reflects its own agents. Live updates
 * (run.*, event.emitted) flow through useStream() at the layout root.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  WorkflowDetail,
  WorkflowValidationResponse,
} from "@agentic/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ActorTag,
  Badge,
  Button,
  Icon,
  Splitter,
  ViewHeader,
  useToast,
} from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useDirty } from "@/app/portal/lib/dirty-context";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  COL_W,
  MAX_CANVAS_H,
  MAX_CANVAS_W,
  NODE_H,
  NODE_W,
  PAD_X,
  ROW_H,
  autoPackLayout,
  clampCanvasPosition,
  colorVar,
  dynamicCanvasSize,
  nodePos,
  type CanvasPoint,
} from "@/app/portal/components/workflows/layout";
import {
  AgentInspector,
  DefaultInspector,
  DraftPalette,
  EditDraftBanner,
  EditToolbar,
  EventInspector,
  type EventCatalogItem,
} from "@/app/portal/components/workflows/inspectors";
import { NewWorkflowModal } from "@/app/portal/components/workflows/NewWorkflowModal";
import { ImportManifestModal } from "@/app/portal/components/import-manifest/ImportManifestModal";
import { AgentEditor } from "@/app/portal/components/workflows/AgentEditor";
import { WorkflowHelp } from "@/app/portal/components/workflows/WorkflowHelp";
import { WorkflowRunConsole } from "@/app/portal/components/workflows/WorkflowRunConsole";
import {
  applyDraft,
  addAgentToDraft,
  connectAgents,
  countDraftChanges,
  createAutomatedAgentDefinition,
  createHumanAgentDefinition,
  deriveEventEdges,
  deserializeDraft,
  draftStorageKey,
  emptyDraft,
  mergeAgentDefinitionIntoDraft,
  moveAgent,
  serializeDraft,
  toManifest,
  tryReadSerializedDraft,
  type CompleteAgentDefinition,
  type WorkflowDraft,
} from "@/app/portal/components/workflows/draft";
import {
  WORKFLOW_INSPECTOR_DEFAULT_WIDTH,
  WORKFLOW_INSPECTOR_MIN_WIDTH,
  WORKFLOW_INSPECTOR_SPLITTER_WIDTH,
  clampWorkflowInspectorWidth,
  workflowInspectorMaxWidth,
  workflowInspectorStorageKey,
  workflowInspectorWideWidth,
} from "@/app/portal/components/workflows/inspector-layout";
import {
  WORKFLOW_AGENT_DRAG_TYPE,
  clientPointToCanvas,
  connectionEventName,
  nodePositionFromPointer,
  workflowEdgePath,
} from "@/app/portal/components/workflows/canvas-interactions";
import {
  readWorkflowReturnState,
  workflowCanvasHref,
} from "@/app/portal/components/workflows/workflow-navigation";
import {
  InspectorTabs,
  LiveAgentPanel,
  LiveLegend,
  NodeLiveBadge,
  RunScrubber,
  type MonitorInspectorTab,
} from "@/app/portal/components/workflow-monitor";
import { useDag } from "@/lib/hooks/useAgents";
import { useAgentEditor } from "@/lib/hooks/useAgentStudio";
import { useEvents } from "@/lib/hooks/useEvents";
import type { RunListRow } from "@/lib/hooks/useRuns";
import { useWorkflowLiveState } from "@/lib/hooks/useWorkflowLiveState";
import {
  formatWorkflowAuthoringError,
  useDeleteWorkflow,
  usePublishWorkflow,
  useSaveWorkflow,
  useValidateWorkflow,
  useWorkflowCatalog,
} from "@/lib/hooks/useWorkflowAuthoring";
import styles from "./workflow.module.css";

/**
 * Stage label catalog — static workflow ontology. Mirrors the dashboard's
 * STAGE_LABELS map (see `dashboard/page.tsx`) so the workflow funnel
 * column headers match the dashboard funnel labels. Tenants whose agents
 * use stage indices outside this map get a generic "Stage N" label.
 */
const STAGE_KEYS: Record<number, string> = {
  0: "intake",
  1: "analyze",
  2: "jd",
  3: "publish",
  4: "resume",
  5: "matchInterview",
  6: "package",
  7: "submit",
};

interface NodeDragState {
  id: string;
  pointerId: number;
  origin: CanvasPoint;
  start: { clientX: number; clientY: number };
  position: CanvasPoint;
  moved: boolean;
}

interface LinkDragState {
  sourceId: string;
  pointerId: number;
  point: CanvasPoint;
  targetId: string | null;
}

export default function WorkflowsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenant = useTenant();
  const { t, language } = useI18n();
  const toast = useToast();
  const requestedWorkflow = searchParams.get("workflow");
  const requestedMode = searchParams.get("mode");
  const requestedAgent = searchParams.get("agent");
  const resumeToken = searchParams.get("resume");
  const returnedAgentDraftId = searchParams.get("agentDraft");
  const catalogQuery = useWorkflowCatalog();
  const workflows = useMemo(
    () => catalogQuery.data?.workflows ?? [],
    [catalogQuery.data?.workflows],
  );
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(
    requestedWorkflow,
  );
  const editAfterSelectionRef = useRef<string | null>(null);
  const requestedWorkflowAppliedRef = useRef<string | null>(null);
  const requestedAgentAppliedRef = useRef<string | null>(null);

  // Pick the live workflow first, then the most recently updated draft. A
  // selection made by New Workflow is retained while the catalog refetches.
  useEffect(() => {
    if (catalogQuery.isLoading || workflows.length === 0) return;
    const requested = requestedWorkflow
      ? workflows.find((row) => row.slug === requestedWorkflow)
      : null;
    if (
      requested &&
      requestedWorkflowAppliedRef.current !== requestedWorkflow
    ) {
      requestedWorkflowAppliedRef.current = requestedWorkflow;
      if (selectedWorkflow !== requested.slug) {
        setSelectedWorkflow(requested.slug);
        return;
      }
    }
    if (
      selectedWorkflow &&
      workflows.some((row) => row.slug === selectedWorkflow)
    ) {
      return;
    }
    const preferred =
      workflows.find((row) => row.liveVersionId !== null) ?? workflows[0];
    setSelectedWorkflow(preferred?.slug ?? null);
  }, [catalogQuery.isLoading, requestedWorkflow, selectedWorkflow, workflows]);

  const selectedSummary = useMemo(
    () => workflows.find((row) => row.slug === selectedWorkflow) ?? null,
    [selectedWorkflow, workflows],
  );
  const dagQuery = useDag(selectedWorkflow);
  const returnedAgentEditor = useAgentEditor(
    returnedAgentDraftId ? requestedAgent : null,
    returnedAgentDraftId,
  );
  const saveWorkflow = useSaveWorkflow(selectedWorkflow);
  const validateWorkflow = useValidateWorkflow(selectedWorkflow);
  const publishWorkflow = usePublishWorkflow(selectedWorkflow);
  const deleteWorkflow = useDeleteWorkflow();
  const workflowVersion = dagQuery.data?.workflowVersion ?? "";
  const baseAgents = useMemo(
    () => dagQuery.data?.agents ?? [],
    [dagQuery.data?.agents],
  );

  // Live event catalog — `/v1/events` dedup'd by name so the workflow's
  // event-color map and inspector "available events" hint always reflect
  // what's actually been emitted (plus what the manifest declares — agents
  // surface their emit/trigger names through the DAG payload regardless of
  // whether the event has ever fired).
  const eventsQuery = useEvents({ limit: 200 });
  // §G4 realtime workflow monitor — per-agent live state + edge pulses folded
  // from the tenant SSE stream. Drives node rings/badges, real edge animation
  // and the live inspector panel outside edit mode.
  const live = useWorkflowLiveState();
  const [scrubRun, setScrubRun] = useState<RunListRow | null>(null);
  const [inspectorTab, setInspectorTab] =
    useState<MonitorInspectorTab>("live");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [tool, setTool] = useState<"select" | "connect" | "add">("select");
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [nodeDrag, setNodeDrag] = useState<NodeDragState | null>(null);
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null);
  const [canvasDropActive, setCanvasDropActive] = useState(false);
  const [canvasAnnouncement, setCanvasAnnouncement] = useState("");
  const [validation, setValidation] =
    useState<WorkflowValidationResponse | null>(null);
  const [editorErrors, setEditorErrors] = useState<Record<string, string[]>>(
    {},
  );
  const hasEditorErrors = Object.values(editorErrors).some(
    (errors) => errors.length > 0,
  );
  const reportEditorValidity = useCallback(
    (agentId: string, errors: string[]) => {
      setEditorErrors((current) => {
        const next = { ...current };
        if (errors.length) next[agentId] = errors;
        else delete next[agentId];
        return next;
      });
    },
    [],
  );
  const [zoom, setZoom] = useState(1);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importTarget, setImportTarget] = useState<{
    slug: string;
    name: string;
  } | null>(null);
  const publishInFlight = useRef(false);
  const [publishing, setPublishing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRunConsole, setShowRunConsole] = useState(false);
  const restoredReturnRef = useRef<string | null>(null);
  const appliedReturnedDraftRef = useRef<string | null>(null);
  const suppressedNodeClickRef = useRef<string | null>(null);
  const suppressedPortClickRef = useRef(false);
  // Live stream — placeholder for tweaks-panel wiring (Phase 2).
  const liveStream = true;
  // Scroll container for the canvas viewport. The canvas is wider than the
  // viewport when LAYOUT places nodes deep into the stage grid; this ref
  // lets us scroll the leftmost node into view after data loads so the
  // user actually sees their imported workflow.
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const inspectorRestoreWidthRef = useRef(WORKFLOW_INSPECTOR_DEFAULT_WIDTH);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [inspectorWidth, setInspectorWidth] = useState(
    WORKFLOW_INSPECTOR_DEFAULT_WIDTH,
  );
  const inspectorStorageKey = useMemo(
    () => workflowInspectorStorageKey(tenant),
    [tenant],
  );
  const [hydratedInspectorKey, setHydratedInspectorKey] = useState<
    string | null
  >(null);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      setWorkspaceWidth(Math.round(workspace.getBoundingClientRect().width));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(workspace);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    let next = WORKFLOW_INSPECTOR_DEFAULT_WIDTH;
    try {
      const stored = window.localStorage.getItem(inspectorStorageKey);
      const parsed = stored == null ? Number.NaN : Number(stored);
      if (Number.isFinite(parsed)) next = parsed;
    } catch {
      // Storage can be unavailable in locked-down enterprise browsers.
    }
    next = clampWorkflowInspectorWidth(next, 0);
    inspectorRestoreWidthRef.current = Math.min(
      next,
      WORKFLOW_INSPECTOR_DEFAULT_WIDTH,
    );
    setInspectorWidth(next);
    setHydratedInspectorKey(inspectorStorageKey);
  }, [inspectorStorageKey]);

  useEffect(() => {
    if (hydratedInspectorKey !== inspectorStorageKey) return;
    try {
      window.localStorage.setItem(
        inspectorStorageKey,
        String(clampWorkflowInspectorWidth(inspectorWidth, 0)),
      );
    } catch {
      // Resizing still works for the current session when storage is blocked.
    }
  }, [hydratedInspectorKey, inspectorStorageKey, inspectorWidth]);
  const inspectorMaxWidth = workflowInspectorMaxWidth(workspaceWidth);
  const renderedInspectorWidth = clampWorkflowInspectorWidth(
    inspectorWidth,
    workspaceWidth,
  );
  const preferredWideInspectorWidth =
    workflowInspectorWideWidth(workspaceWidth);
  const inspectorCanResize = workspaceWidth === 0 || workspaceWidth > 860;
  const inspectorIsWide =
    !inspectorCanResize ||
    renderedInspectorWidth >= preferredWideInspectorWidth - 1;

  // While editing, the canvas reads the *applied* draft so the operator
  // sees their changes immediately. Outside edit mode it's the bootstrap.
  const agents = useMemo(
    () => (editing ? applyDraft(baseAgents, draft) : baseAgents),
    [baseAgents, draft, editing],
  );
  const events = useMemo<EventCatalogItem[]>(() => {
    const map = new Map<string, EventCatalogItem>();
    // Seed from the event ledger so colors/categories that the api has seen
    // win over a derived fallback.
    for (const row of eventsQuery.data ?? []) {
      if (map.has(row.name)) continue;
      map.set(row.name, {
        name: row.name,
        color: row.color ?? "muted",
        category: row.category ?? "agent",
      });
    }
    // Use the effective agents, not only the last server snapshot. Trigger
    // and emitted-event edits therefore appear in hints and edge colors on
    // the same render that adds or removes their visual connection.
    for (const agent of agents) {
      for (const name of [...agent.triggers, ...agent.emits]) {
        const normalized = name.trim();
        if (!normalized || map.has(normalized)) continue;
        map.set(normalized, {
          name: normalized,
          color: "muted",
          category: "agent",
        });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [agents, eventsQuery.data]);
  const selectedAgentRecord = useMemo(
    () =>
      selectedAgent
        ? agents.find((agent) => agent.kebabId === selectedAgent)
        : undefined,
    [agents, selectedAgent],
  );
  // §G4 — lookups bridging the SSE stream's `agentName` (manifest name) to
  // the canvas's kebab-id node key space.
  const agentNameSet = useMemo(
    () => new Set(agents.map((agent) => agent.name)),
    [agents],
  );
  const agentTitlesByName = useMemo(
    () =>
      Object.fromEntries(agents.map((agent) => [agent.name, agent.title])),
    [agents],
  );
  const kebabByName = useMemo(
    () => new Map(agents.map((agent) => [agent.name, agent.kebabId])),
    [agents],
  );
  // Fresh inspector tab per node selection; drop the scrub highlight when the
  // operator switches workflows (its runs belong to the previous DAG).
  useEffect(() => {
    setInspectorTab("live");
  }, [selectedAgent]);
  useEffect(() => {
    setScrubRun(null);
  }, [selectedWorkflow]);
  const openTaskInbox = useCallback(
    (taskId: string | null) => {
      router.push(
        `/portal/${tenant}/tasks${
          taskId ? `?selected=${encodeURIComponent(taskId)}` : ""
        }` as never,
      );
    },
    [router, tenant],
  );
  useEffect(() => {
    // A workflow switch can render once with the previous node selection
    // while the new DAG is loading. Never pass an undefined agent to the
    // inspector/editor during that transition.
    if (
      selectedAgent &&
      dagQuery.data &&
      !dagQuery.isLoading &&
      !selectedAgentRecord
    ) {
      setSelectedAgent(null);
    }
  }, [dagQuery.data, dagQuery.isLoading, selectedAgent, selectedAgentRecord]);
  const draftCounts = countDraftChanges(draft);
  const dirty =
    draftCounts.added + draftCounts.modified + draftCounts.removed > 0;
  const dirtyApi = useDirty();
  // UC-V11-15: register the draft with the global Dirty context so
  // useTenantNavigate() and other guards can prompt before navigating away.
  useEffect(() => {
    const label = dirty
      ? t("workflowPage.dirtyLabel", {
          workflow: selectedWorkflow ?? t("workflowPage.workflowLower"),
          added: draftCounts.added,
          modified: draftCounts.modified,
          removed: draftCounts.removed,
        })
      : null;
    dirtyApi.setDirty("workflow-draft", label);
    return () => dirtyApi.setDirty("workflow-draft", null);
  }, [
    dirty,
    draftCounts.added,
    draftCounts.modified,
    draftCounts.removed,
    dirtyApi,
    selectedWorkflow,
    t,
  ]);

  // Persist each workflow's browser edits independently. Switching the
  // catalog selector never leaks one manifest patch into another workflow.
  const storageKey = useMemo(
    () => draftStorageKey(tenant, selectedWorkflow ?? "__none__"),
    [selectedWorkflow, tenant],
  );
  // `restoredAt` non-null means we restored a saved draft on mount; show
  // a small banner with a Discard action so the operator can opt out.
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [draftBaseVersionId, setDraftBaseVersionId] = useState<string | null>(
    null,
  );
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  useEffect(() => {
    const shouldOpenEditor =
      editAfterSelectionRef.current === selectedWorkflow ||
      (requestedMode === "edit" &&
        (!requestedWorkflow || requestedWorkflow === selectedWorkflow));
    setDraft(emptyDraft());
    setEditing(false);
    setSelectedAgent(null);
    setSelectedEvent(null);
    setConnectFrom(null);
    setValidation(null);
    setEditorErrors({});
    setRestoredAt(null);
    setDraftBaseVersionId(null);
    if (typeof window === "undefined" || !selectedWorkflow) {
      setHydratedKey(storageKey);
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = tryReadSerializedDraft(raw);
        if (!parsed) {
          window.localStorage.removeItem(storageKey);
        } else {
          setDraft(deserializeDraft(parsed));
          setDraftBaseVersionId(parsed.baseVersionId);
          setEditing(true);
          setRestoredAt(parsed.savedAt);
        }
      }
    } catch {
      // localStorage unavailable (private mode, quota) — silently skip.
    } finally {
      if (shouldOpenEditor) {
        editAfterSelectionRef.current = null;
        setEditing(true);
      }
      setHydratedKey(storageKey);
    }
  }, [requestedMode, requestedWorkflow, selectedWorkflow, storageKey]);
  useEffect(() => {
    if (
      editing &&
      draftBaseVersionId === null &&
      dagQuery.data?.workflowVersionId &&
      hydratedKey === storageKey
    ) {
      setDraftBaseVersionId(dagQuery.data.workflowVersionId);
    }
  }, [
    dagQuery.data?.workflowVersionId,
    draftBaseVersionId,
    editing,
    hydratedKey,
    storageKey,
  ]);
  // Save on every change while dirty; clear on clean state.
  useEffect(() => {
    if (hydratedKey !== storageKey || typeof window === "undefined") return;
    try {
      if (dirty) {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify(
            serializeDraft(
              draft,
              draftBaseVersionId ?? dagQuery.data?.workflowVersionId ?? null,
            ),
          ),
        );
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // Persistence failure is best-effort; don't break the UI.
    }
  }, [
    dagQuery.data?.workflowVersionId,
    draftBaseVersionId,
    hydratedKey,
    dirty,
    draft,
    storageKey,
  ]);
  function discardRestored() {
    setDraft(emptyDraft());
    setEditing(false);
    setRestoredAt(null);
    setDraftBaseVersionId(null);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
  }

  // Auto-pack any agents whose kebab-id isn't in the hand-tuned LAYOUT map
  // (the LAYOUT only covers RAAS). Pure derived state — same `agents` ->
  // same fallback positions; existing LAYOUT entries always win in
  // `getLayout` so RAAS visual fidelity is unaffected. We key entirely on
  // `kebabId` so the LAYOUT map (whose keys are kebab slugs like "1-1" or
  // "matcher-agent") and the auto-packed fallback share the same id space.
  const autoFallback = useMemo(
    () =>
      autoPackLayout(
        agents.map((a) => ({
          id: a.kebabId,
          stage: a.stage ?? 0,
          triggers: a.triggers ?? [],
          emits: a.emits ?? [],
        })),
      ),
    [agents],
  );

  const positions = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    for (const agent of agents) {
      out.set(
        agent.kebabId,
        clampCanvasPosition(
          agent.position ?? nodePos(agent.kebabId, autoFallback),
        ),
      );
    }
    return out;
  }, [agents, autoFallback]);

  const renderedPositions = useMemo(() => {
    if (!nodeDrag) return positions;
    const out = new Map(positions);
    out.set(nodeDrag.id, nodeDrag.position);
    return out;
  }, [nodeDrag, positions]);

  const canvasSize = useMemo(
    () => dynamicCanvasSize(renderedPositions.values()),
    [renderedPositions],
  );

  // Derive headers from rendered columns rather than only declared stages.
  // This keeps topology-packed stage-99 workflows and local draft additions
  // aligned with their actual nodes.
  const stages = useMemo(() => {
    const byColumn = new Map<number, Set<number>>();
    for (const agent of agents) {
      const position = renderedPositions.get(agent.kebabId);
      if (!position) continue;
      const column = Math.max(0, Math.round((position.x - PAD_X) / COL_W));
      const declared = byColumn.get(column) ?? new Set<number>();
      declared.add(agent.stage);
      byColumn.set(column, declared);
    }
    return Array.from(byColumn.entries())
      .sort(([left], [right]) => left - right)
      .map(([column, declared]) => {
        const usable = Array.from(declared).filter((stage) => stage !== 99);
        const stage = usable.length === 1 ? (usable[0] ?? column) : column;
        return {
          id: column,
          column,
          label: STAGE_KEYS[stage]
            ? t(`workflowPage.stage.${STAGE_KEYS[stage]}`)
            : t("workflowPage.stageFallback", { stage }),
        };
      });
  }, [agents, renderedPositions, t]);

  // Build edges: for each agent's emitted event, find listeners.
  const edges = useMemo(
    () =>
      deriveEventEdges(agents).filter(
        (edge) =>
          renderedPositions.has(edge.src) && renderedPositions.has(edge.dst),
      ),
    [agents, renderedPositions],
  );
  const previousDerivedEdgesRef = useRef<{
    context: string;
    edges: Map<string, (typeof edges)[number]>;
  }>({ context: "", edges: new Map() });

  useEffect(() => {
    const context = `${selectedWorkflow ?? ""}:${editing ? "edit" : "view"}`;
    const next = new Map(
      edges.map((edge) => [
        JSON.stringify([edge.src, edge.dst, edge.event]),
        edge,
      ]),
    );
    const previous = previousDerivedEdgesRef.current;
    previousDerivedEdgesRef.current = { context, edges: next };
    if (!editing || previous.context !== context) return;

    const added = Array.from(next.entries())
      .filter(([key]) => !previous.edges.has(key))
      .map(([, edge]) => edge);
    const removed = Array.from(previous.edges.entries())
      .filter(([key]) => !next.has(key))
      .map(([, edge]) => edge);
    if (added.length > 0) {
      const first = added[0]!;
      setCanvasAnnouncement(
        t("workflowPage.announcement.autoLinked", {
          source: first.src,
          target: first.dst,
          event: first.event,
          more:
            added.length > 1
              ? t("workflowPage.announcement.moreLinks", {
                  count: added.length - 1,
                })
              : "",
        }),
      );
    } else if (removed.length > 0) {
      const first = removed[0]!;
      setCanvasAnnouncement(
        t("workflowPage.announcement.autoRemoved", {
          source: first.src,
          target: first.dst,
          event: first.event,
          more:
            removed.length > 1
              ? t("workflowPage.announcement.moreLinks", {
                  count: removed.length - 1,
                })
              : "",
        }),
      );
    }
  }, [edges, editing, selectedWorkflow, t]);

  const evColor = useMemo(() => {
    const m: Record<string, string> = {};
    events.forEach((e) => {
      m[e.name] = e.color;
    });
    return m;
  }, [events]);

  // Highlight set when an agent or event is selected.
  const highlighted = useMemo(() => {
    const nodes = new Set<string>();
    const edgeSet = new Set<number>();
    if (selectedAgent) {
      nodes.add(selectedAgent);
      edges.forEach((e, i) => {
        if (e.src === selectedAgent || e.dst === selectedAgent) {
          edgeSet.add(i);
          nodes.add(e.src);
          nodes.add(e.dst);
        }
      });
    }
    if (selectedEvent) {
      edges.forEach((e, i) => {
        if (e.event === selectedEvent) {
          edgeSet.add(i);
          nodes.add(e.src);
          nodes.add(e.dst);
        }
      });
    }
    // §G4 run scrubber — highlight the selected run's node plus the edges
    // carrying the event that run emitted.
    if (scrubRun) {
      const kebab = kebabByName.get(scrubRun.agentName);
      if (kebab) {
        nodes.add(kebab);
        edges.forEach((e, i) => {
          if (
            e.src === kebab &&
            scrubRun.emittedEvent &&
            e.event === scrubRun.emittedEvent
          ) {
            edgeSet.add(i);
            nodes.add(e.dst);
          }
        });
      }
    }
    return { nodes, edges: edgeSet };
  }, [selectedAgent, selectedEvent, scrubRun, kebabByName, edges]);

  const dim = Boolean(selectedAgent || selectedEvent || scrubRun);

  // After data loads, scroll the canvas so the leftmost node is visible.
  // The canvas reserves room for all RAAS stages (0..7) at fixed COL_W;
  // a small workflow with only stage-5 nodes would otherwise render past
  // the viewport's right edge and look empty. Only nudges scroll when the
  // canvas is still at the leftmost position so we don't clobber a
  // user-initiated scroll on subsequent data updates.
  useEffect(() => {
    const el = canvasScrollRef.current;
    if (!el || el.scrollLeft !== 0) return;
    const positioned = Array.from(renderedPositions.values());
    if (positioned.length === 0) return;
    const minX = positioned.reduce(
      (acc, position) => Math.min(acc, position.x),
      Number.POSITIVE_INFINITY,
    );
    const targetX = Math.max(0, minX * zoom - 40);
    if (targetX > 0) el.scrollLeft = targetX;
  }, [renderedPositions, zoom]);

  useEffect(() => {
    const requestKey = `${requestedWorkflow ?? selectedWorkflow ?? ""}:${requestedAgent ?? ""}:${resumeToken ?? ""}`;
    if (
      !requestedAgent ||
      !editing ||
      requestedAgentAppliedRef.current === requestKey ||
      !agents.some((agent) => agent.kebabId === requestedAgent)
    ) {
      return;
    }
    requestedAgentAppliedRef.current = requestKey;
    setSelectedAgent(requestedAgent);
    setSelectedEvent(null);
  }, [
    agents,
    editing,
    requestedAgent,
    requestedWorkflow,
    resumeToken,
    selectedWorkflow,
  ]);

  useEffect(() => {
    if (
      !resumeToken ||
      restoredReturnRef.current === resumeToken ||
      !selectedWorkflow
    ) {
      return;
    }
    const state = readWorkflowReturnState(resumeToken, tenant);
    if (!state) {
      restoredReturnRef.current = resumeToken;
      return;
    }
    if (state.workflowSlug !== selectedWorkflow) {
      setSelectedWorkflow(state.workflowSlug);
      return;
    }
    restoredReturnRef.current = resumeToken;
    setEditing(state.editing);
    setTool(state.tool);
    setZoom(state.zoom);
    setSelectedAgent(state.selectedAgent);
    setSelectedEvent(null);
    requestAnimationFrame(() => {
      canvasScrollRef.current?.scrollTo({
        left: state.scrollLeft,
        top: state.scrollTop,
      });
    });
  }, [resumeToken, selectedWorkflow, tenant]);

  useEffect(() => {
    const returned = returnedAgentEditor.data?.draft;
    const currentVersionId = dagQuery.data?.workflowVersionId;
    if (
      !returnedAgentDraftId ||
      !returned ||
      !requestedAgent ||
      !selectedWorkflow ||
      !currentVersionId ||
      appliedReturnedDraftRef.current === returnedAgentDraftId
    ) {
      return;
    }
    appliedReturnedDraftRef.current = returnedAgentDraftId;
    if (
      returned.baseWorkflowVersionId &&
      returned.baseWorkflowVersionId !== currentVersionId
    ) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.wrongVersionTitle"),
        description: t("workflowPage.toast.wrongVersionDescription"),
      });
    } else {
      setEditing(true);
      setDraftBaseVersionId(currentVersionId);
      setDraft((current) =>
        mergeAgentDefinitionIntoDraft(
          current,
          returned.definition as CompleteAgentDefinition,
        ),
      );
      setSelectedAgent(requestedAgent);
      setSelectedEvent(null);
      setValidation(null);
      setCanvasAnnouncement(
        t("workflowPage.announcement.agentReturned", {
          agent: returned.definition.title ?? requestedAgent,
        }),
      );
      toast({
        tone: "green",
        title: t("workflowPage.toast.agentReturnedTitle"),
        description: t("workflowPage.toast.agentReturnedDescription"),
      });
    }
    router.replace(
      workflowCanvasHref({
        tenant,
        workflowSlug: selectedWorkflow,
        agentId: requestedAgent,
        resumeToken,
      }) as never,
    );
  }, [
    dagQuery.data?.workflowVersionId,
    requestedAgent,
    resumeToken,
    returnedAgentDraftId,
    returnedAgentEditor.data?.draft,
    router,
    selectedWorkflow,
    tenant,
    t,
    toast,
  ]);

  useEffect(() => {
    if (!returnedAgentDraftId || !returnedAgentEditor.isError) return;
    if (appliedReturnedDraftRef.current === returnedAgentDraftId) return;
    appliedReturnedDraftRef.current = returnedAgentDraftId;
    toast({
      tone: "red",
      title: t("workflowPage.toast.restoreFailedTitle"),
      description:
        returnedAgentEditor.error instanceof Error
          ? returnedAgentEditor.error.message
          : t("workflowPage.toast.returnedDraftUnavailable"),
    });
  }, [
    returnedAgentDraftId,
    returnedAgentEditor.error,
    returnedAgentEditor.isError,
    t,
    toast,
  ]);

  function expandAgentPanel(id: string) {
    setSelectedAgent(id);
    setSelectedEvent(null);
    setInspectorWidth((current) => {
      const rendered = clampWorkflowInspectorWidth(current, workspaceWidth);
      if (rendered >= preferredWideInspectorWidth - 1) return current;
      inspectorRestoreWidthRef.current = rendered;
      return preferredWideInspectorWidth;
    });
  }

  function toggleAgentPanelWidth() {
    setInspectorWidth((current) => {
      const rendered = clampWorkflowInspectorWidth(current, workspaceWidth);
      if (rendered >= preferredWideInspectorWidth - 1) {
        return clampWorkflowInspectorWidth(
          inspectorRestoreWidthRef.current,
          workspaceWidth,
        );
      }
      inspectorRestoreWidthRef.current = rendered;
      return preferredWideInspectorWidth;
    });
  }

  function navEvents(eventName: string) {
    router.push(
      `/portal/${tenant}/events?name=${encodeURIComponent(eventName)}` as never,
    );
  }

  function discardDraft() {
    setDraft(emptyDraft());
    setEditing(false);
    setConnectFrom(null);
    setValidation(null);
    setRestoredAt(null);
    setDraftBaseVersionId(null);
    setEditorErrors({});
  }

  function closeEditor() {
    if (dirty && !window.confirm(t("workflowPage.closeConfirm"))) {
      return;
    }
    discardDraft();
  }

  function editableManifest() {
    return toManifest(agents).map((definition) => {
      const position = positions.get(definition.id);
      if (!position) return definition;
      const extensions =
        definition.extensions && typeof definition.extensions === "object"
          ? definition.extensions
          : {};
      const priorCanvas =
        extensions.canvas &&
        typeof extensions.canvas === "object" &&
        !Array.isArray(extensions.canvas)
          ? extensions.canvas
          : {};
      return {
        ...definition,
        extensions: {
          ...extensions,
          canvas: { ...priorCanvas, position },
        },
      };
    });
  }

  async function saveDraft(): Promise<WorkflowDetail | null> {
    if (hasEditorErrors) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.fixBeforeSave"),
        description:
          Object.values(editorErrors).flat()[0] ??
          t("workflowPage.invalidField"),
      });
      return null;
    }
    const baseVersionId =
      draftBaseVersionId ?? dagQuery.data?.workflowVersionId ?? null;
    if (!selectedWorkflow || !baseVersionId) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.draftCannotSave"),
        description: t("workflowPage.toast.versionLoading"),
      });
      return null;
    }
    try {
      const detail = await saveWorkflow.mutateAsync({
        baseVersionId,
        manifest: editableManifest(),
      });
      toast({
        tone: "signal",
        title: t("workflowPage.toast.draftSaved"),
        description: t("workflowPage.toast.draftSavedDescription", {
          version: detail.latestVersion,
        }),
      });
      setDraft(emptyDraft());
      setDraftBaseVersionId(detail.latestVersionId);
      setRestoredAt(null);
      setValidation(null);
      return detail;
    } catch (err) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.draftSaveFailed"),
        description:
          err instanceof Error ? err.message : t("common.unknownError"),
      });
      return null;
    }
  }

  async function validateCurrent(): Promise<WorkflowValidationResponse | null> {
    if (hasEditorErrors) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.fixBeforeValidate"),
        description:
          Object.values(editorErrors).flat()[0] ??
          t("workflowPage.invalidField"),
      });
      return null;
    }
    if (!selectedWorkflow) return null;
    try {
      const result = await validateWorkflow.mutateAsync({
        manifest: editableManifest(),
      });
      setValidation(result);
      toast({
        tone: result.valid ? "green" : "amber",
        title: result.valid
          ? t("workflowPage.toast.validTitle")
          : t("workflowPage.toast.needsChangesTitle"),
        description: result.valid
          ? t("workflowPage.toast.promptsChecked", {
              count: result.promptScores.length,
            })
          : t("workflowPage.toast.blockingIssues", {
              count: result.issues.filter((issue) => issue.severity === "error")
                .length,
            }),
      });
      return result;
    } catch (err) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.validationFailed"),
        description:
          err instanceof Error ? err.message : t("common.unknownError"),
      });
      return null;
    }
  }

  async function publishCurrent() {
    if (!selectedWorkflow || publishInFlight.current) return;
    publishInFlight.current = true;
    setPublishing(true);
    try {
      const checked = await validateCurrent();
      if (!checked?.valid) return;
      let versionId = dagQuery.data?.workflowVersionId ?? undefined;
      if (dirty) {
        const saved = await saveDraft();
        if (!saved) return;
        versionId = saved.latestVersionId;
      }
      if (!versionId) {
        toast({
          tone: "red",
          title: t("workflowPage.toast.cannotPublish"),
          description: t("workflowPage.toast.noImmutableVersion"),
        });
        return;
      }
      const result = await publishWorkflow.mutateAsync({
        versionId,
        note: `Published from the workflow canvas (${selectedWorkflow}).`,
      });
      toast({
        tone: "green",
        title: t("workflowPage.toast.liveTitle"),
        description: t("workflowPage.toast.liveDescription", {
          version: result.version,
        }),
      });
      setDraft(emptyDraft());
      setEditing(false);
      setConnectFrom(null);
      setRestoredAt(null);
    } catch (err) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.publishFailed"),
        description:
          err instanceof Error ? err.message : t("common.unknownError"),
      });
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }

  function nextAgentId(actor: "Agent" | "Human"): string {
    const prefix = actor === "Human" ? "human-review" : "automated-step";
    const taken = new Set(agents.map((agent) => agent.kebabId));
    let index = 1;
    while (taken.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
  }

  function viewportPosition(): { x: number; y: number } {
    const canvas = canvasScrollRef.current;
    if (!canvas) return { x: PAD_X, y: 90 };
    return {
      x: Math.max(
        0,
        Math.min(
          Math.min(MAX_CANVAS_W - NODE_W, canvasSize.width + COL_W - NODE_W),
          (canvas.scrollLeft + canvas.clientWidth * 0.45) / zoom,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          Math.min(MAX_CANVAS_H - NODE_H, canvasSize.height + ROW_H - NODE_H),
          (canvas.scrollTop + canvas.clientHeight * 0.4) / zoom,
        ),
      ),
    };
  }

  function addAgent(
    actor: "Agent" | "Human",
    requestedPosition = viewportPosition(),
  ) {
    const id = nextAgentId(actor);
    const position = clampCanvasPosition(requestedPosition);
    const options = {
      id,
      position,
      stage: Math.max(0, Math.round((position.x - PAD_X) / COL_W)),
    };
    const definition =
      actor === "Human"
        ? createHumanAgentDefinition({
            ...options,
            title: t("workflowPage.newNodeDefaults.humanTitle"),
            description: t("workflowPage.newNodeDefaults.humanDescription"),
            actionDescription: t(
              "workflowPage.newNodeDefaults.humanActionDescription",
            ),
          })
        : createAutomatedAgentDefinition({
            ...options,
            title: t("workflowPage.newNodeDefaults.automatedTitle"),
            description: t("workflowPage.newNodeDefaults.automatedDescription"),
            actionDescription: t(
              "workflowPage.newNodeDefaults.automatedActionDescription",
            ),
            actionPrompt: t(
              "workflowPage.newNodeDefaults.automatedActionPrompt",
            ),
            ontologyInstructions: t(
              "workflowPage.newNodeDefaults.automatedOntologyInstructions",
              { title: t("workflowPage.newNodeDefaults.automatedTitle") },
            ),
          });
    setDraft((current) => addAgentToDraft(current, definition));
    setSelectedAgent(id);
    setSelectedEvent(null);
    setTool("select");
    setValidation(null);
    setCanvasAnnouncement(
      t("workflowPage.announcement.agentAdded", {
        agent: definition.title ?? definition.name,
      }),
    );
  }

  function connectPair(sourceId: string, targetId: string) {
    if (sourceId === targetId) {
      setConnectFrom(null);
      setLinkDrag(null);
      return;
    }
    const eventName = connectionEventName(sourceId, targetId);
    try {
      setDraft((current) =>
        connectAgents(current, agents, sourceId, targetId, eventName),
      );
      setSelectedAgent(targetId);
      setSelectedEvent(eventName);
      setConnectFrom(null);
      setLinkDrag(null);
      setTool("select");
      setValidation(null);
      setCanvasAnnouncement(
        t("workflowPage.announcement.connected", {
          source: sourceId,
          target: targetId,
          event: eventName,
        }),
      );
      toast({
        tone: "signal",
        title: t("workflowPage.toast.connectedTitle"),
        description: t("workflowPage.toast.connectedDescription", {
          event: eventName,
          source: sourceId,
          target: targetId,
        }),
      });
    } catch (err) {
      setLinkDrag(null);
      toast({
        tone: "red",
        title: t("workflowPage.toast.connectionFailed"),
        description:
          err instanceof Error ? err.message : t("common.unknownError"),
      });
    }
  }

  function connectNode(targetId: string) {
    if (!connectFrom) {
      setConnectFrom(targetId);
      setSelectedAgent(targetId);
      setCanvasAnnouncement(
        t("workflowPage.announcement.sourceSelected", { agent: targetId }),
      );
      return;
    }
    connectPair(connectFrom, targetId);
  }

  function canvasPoint(clientX: number, clientY: number): CanvasPoint | null {
    const canvas = canvasScrollRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return clientPointToCanvas(
      { clientX, clientY },
      {
        rectLeft: rect.left,
        rectTop: rect.top,
        scrollLeft: canvas.scrollLeft,
        scrollTop: canvas.scrollTop,
        zoom,
      },
    );
  }

  function findInputTarget(clientX: number, clientY: number): string | null {
    if (typeof document === "undefined") return null;
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-workflow-input]");
    const id = target?.dataset.workflowInput;
    return id && agents.some((agent) => agent.kebabId === id) ? id : null;
  }

  function beginNodeDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    id: string,
  ) {
    if (!editing || tool !== "select" || event.button !== 0) return;
    const origin = renderedPositions.get(id);
    if (!origin) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setNodeDrag({
      id,
      pointerId: event.pointerId,
      origin,
      start: { clientX: event.clientX, clientY: event.clientY },
      position: origin,
      moved: false,
    });
  }

  function updateNodeDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    setNodeDrag((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const position = nodePositionFromPointer(
        current.origin,
        current.start,
        { clientX: event.clientX, clientY: event.clientY },
        zoom,
      );
      const distance = Math.hypot(
        event.clientX - current.start.clientX,
        event.clientY - current.start.clientY,
      );
      return {
        ...current,
        position,
        moved: current.moved || distance >= 5,
      };
    });
  }

  function finishNodeDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!nodeDrag || nodeDrag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const completed = nodeDrag;
    setNodeDrag(null);
    if (!completed.moved) return;
    suppressedNodeClickRef.current = completed.id;
    setSelectedAgent(completed.id);
    setSelectedEvent(null);
    setDraft((current) => moveAgent(current, completed.id, completed.position));
    setValidation(null);
    setCanvasAnnouncement(
      t("workflowPage.announcement.moved", {
        agent: completed.id,
        x: Math.round(completed.position.x),
        y: Math.round(completed.position.y),
      }),
    );
  }

  function nudgeNode(event: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    if (!editing || tool !== "select") return;
    const direction: Record<string, CanvasPoint> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const vector = direction[event.key];
    if (!vector) return;
    event.preventDefault();
    const current = renderedPositions.get(id);
    if (!current) return;
    const step = event.shiftKey ? 24 : 8;
    const position = clampCanvasPosition({
      x: current.x + vector.x * step,
      y: current.y + vector.y * step,
    });
    setDraft((value) => moveAgent(value, id, position));
    setValidation(null);
    setCanvasAnnouncement(
      t("workflowPage.announcement.moved", {
        agent: id,
        x: Math.round(position.x),
        y: Math.round(position.y),
      }),
    );
  }

  function beginLinkDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    sourceId: string,
  ) {
    if (!editing || event.button !== 0) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedAgent(sourceId);
    setSelectedEvent(null);
    setLinkDrag({
      sourceId,
      pointerId: event.pointerId,
      point,
      targetId: null,
    });
    setCanvasAnnouncement(
      t("workflowPage.announcement.creatingConnection", { agent: sourceId }),
    );
  }

  function updateLinkDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!linkDrag || linkDrag.pointerId !== event.pointerId) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    const targetId = findInputTarget(event.clientX, event.clientY);
    setLinkDrag((current) =>
      current && current.pointerId === event.pointerId
        ? { ...current, point, targetId }
        : current,
    );
  }

  function finishLinkDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!linkDrag || linkDrag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const targetId =
      findInputTarget(event.clientX, event.clientY) ?? linkDrag.targetId;
    const sourceId = linkDrag.sourceId;
    setLinkDrag(null);
    suppressedPortClickRef.current = true;
    requestAnimationFrame(() => {
      suppressedPortClickRef.current = false;
    });
    if (targetId && targetId !== sourceId) {
      connectPair(sourceId, targetId);
      return;
    }
    setTool("connect");
    setConnectFrom(sourceId);
    setSelectedAgent(sourceId);
    setCanvasAnnouncement(
      t("workflowPage.announcement.sourceSelectedPort", { agent: sourceId }),
    );
  }

  useEffect(() => {
    function cancelActiveInteraction(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (!nodeDrag && !linkDrag && !connectFrom) return;
      setNodeDrag(null);
      setLinkDrag(null);
      setConnectFrom(null);
      setCanvasAnnouncement(t("workflowPage.announcement.cancelled"));
    }
    window.addEventListener("keydown", cancelActiveInteraction);
    return () => window.removeEventListener("keydown", cancelActiveInteraction);
  }, [connectFrom, linkDrag, nodeDrag, t]);

  function autoLayout() {
    const byStage = new Map<number, typeof agents>();
    for (const agent of agents) {
      const bucket = byStage.get(agent.stage) ?? [];
      bucket.push(agent);
      byStage.set(agent.stage, bucket);
    }
    const orderedStages = Array.from(byStage.keys()).sort((a, b) => a - b);
    setDraft((current) => {
      let next = current;
      orderedStages.forEach((stage, column) => {
        const rows = [...(byStage.get(stage) ?? [])].sort((a, b) =>
          a.kebabId.localeCompare(b.kebabId),
        );
        rows.forEach((agent, lane) => {
          next = moveAgent(next, agent.kebabId, {
            x: PAD_X + column * COL_W,
            y: 30 + lane * 90,
          });
        });
      });
      return next;
    });
    setValidation(null);
    toast({
      tone: "signal",
      title: t("workflowPage.toast.canvasArranged"),
      description: t("workflowPage.toast.canvasArrangedDescription"),
    });
  }

  function zoomToFit() {
    const canvas = canvasScrollRef.current;
    const all = Array.from(positions.values());
    if (!canvas || all.length === 0) return;
    const minX = Math.min(...all.map((position) => position.x));
    const minY = Math.min(...all.map((position) => position.y));
    const maxX = Math.max(...all.map((position) => position.x + NODE_W));
    const maxY = Math.max(...all.map((position) => position.y + NODE_H));
    const nextZoom = Math.max(
      0.35,
      Math.min(
        1,
        (canvas.clientWidth - 48) / Math.max(1, maxX - minX),
        (canvas.clientHeight - 72) / Math.max(1, maxY - minY),
      ),
    );
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      canvas.scrollTo({
        left: Math.max(0, minX * nextZoom - 24),
        top: Math.max(0, minY * nextZoom - 24),
        behavior: "smooth",
      });
    });
  }

  async function deleteSelectedWorkflow() {
    if (!selectedWorkflow || selectedSummary?.liveVersionId) return;
    const confirmed = window.confirm(
      t("workflowPage.deleteConfirm", {
        name: selectedSummary?.name ?? selectedWorkflow,
      }),
    );
    if (!confirmed) return;
    try {
      await deleteWorkflow.mutateAsync(selectedWorkflow);
      const next = workflows.find((row) => row.slug !== selectedWorkflow);
      setSelectedWorkflow(next?.slug ?? null);
      toast({ tone: "green", title: t("workflowPage.toast.deleted") });
    } catch (err) {
      toast({
        tone: "red",
        title: t("workflowPage.toast.deleteFailed"),
        description:
          err instanceof Error ? err.message : t("common.unknownError"),
      });
    }
  }

  function selectCreatedWorkflow(workflow: WorkflowDetail) {
    editAfterSelectionRef.current = workflow.slug;
    setSelectedWorkflow(workflow.slug);
    setDraft(emptyDraft());
    setRestoredAt(null);
    setDraftBaseVersionId(workflow.latestVersionId);
    setEditing(true);
    setShowNewModal(false);
  }

  return (
    <div className={styles.page}>
      <div className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {canvasAnnouncement}
      </div>
      <ViewHeader
        title={t("nav.workflows")}
        subtitle={
          editing ? (
            <>
              {t("workflowPage.editingDraftOf")}{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                {selectedWorkflow ?? t("workflowPage.workflowLower")}
              </span>{" "}
              {t("workflowPage.editingDraftHint")}
            </>
          ) : (
            t("workflowPage.subtitle")
          )
        }
        badge={
          editing ? (
            <Badge tone="amber">
              <Icon name="alert" size={9} /> {t("workflowPage.localDraft")}
            </Badge>
          ) : dagQuery.data?.workflowIsLive ? (
            <Badge tone="green">
              <Icon name="check" size={9} /> {t("workflowPage.live")}
            </Badge>
          ) : (
            <Badge tone="amber">{t("workflowPage.draft")}</Badge>
          )
        }
        action={
          editing
            ? [
                <Button
                  key="run"
                  small
                  icon="run"
                  onClick={() => setShowRunConsole(true)}
                  disabled={
                    !selectedWorkflow ||
                    dagQuery.isLoading ||
                    agents.length === 0
                  }
                >
                  {t("workflowPage.run")}
                </Button>,
                <Button
                  key="help"
                  small
                  icon="task"
                  onClick={() => setShowHelp(true)}
                >
                  {t("workflowPage.help")}
                </Button>,
                <Button key="discard" small tone="ghost" onClick={closeEditor}>
                  {t("workflowPage.closeEditor")}
                </Button>,
                <Button
                  key="val"
                  small
                  icon="check"
                  tone="ghost"
                  onClick={() => void validateCurrent()}
                  disabled={
                    validateWorkflow.isPending ||
                    dagQuery.isLoading ||
                    !dagQuery.data?.workflowVersionId ||
                    !selectedWorkflow ||
                    hasEditorErrors
                  }
                >
                  {validateWorkflow.isPending
                    ? t("workflowPage.validating")
                    : t("workflowPage.validate")}
                </Button>,
                <Button
                  key="save"
                  small
                  icon="code"
                  onClick={() => void saveDraft()}
                  disabled={!dirty || saveWorkflow.isPending || hasEditorErrors}
                >
                  {saveWorkflow.isPending
                    ? t("common.saving")
                    : dirty
                      ? t("workflowPage.saveDraftCount", {
                          count:
                            draftCounts.added +
                            draftCounts.modified +
                            draftCounts.removed,
                        })
                      : t("workflowPage.saveDraft")}
                </Button>,
                <Button
                  key="publish"
                  small
                  icon="deploy"
                  tone="primary"
                  onClick={() => void publishCurrent()}
                  disabled={
                    publishing ||
                    publishWorkflow.isPending ||
                    saveWorkflow.isPending ||
                    validateWorkflow.isPending ||
                    dagQuery.isLoading ||
                    !dagQuery.data?.workflowVersionId ||
                    !selectedWorkflow ||
                    hasEditorErrors
                  }
                >
                  {publishing
                    ? t("workflowPage.publishing")
                    : t("workflowPage.publish")}
                </Button>,
              ]
            : [
                <Button
                  key="run"
                  icon="run"
                  tone="primary"
                  small
                  onClick={() => setShowRunConsole(true)}
                  disabled={
                    !selectedWorkflow ||
                    dagQuery.isLoading ||
                    agents.length === 0
                  }
                >
                  {t("workflowPage.runWorkflow")}
                </Button>,
                <Button
                  key="help"
                  small
                  icon="task"
                  onClick={() => setShowHelp(true)}
                >
                  {t("workflowPage.help")}
                </Button>,
                <Button
                  key="edit"
                  icon="code"
                  small
                  onClick={() => {
                    setDraftBaseVersionId(
                      dagQuery.data?.workflowVersionId ?? null,
                    );
                    setEditing(true);
                  }}
                  disabled={!selectedWorkflow || dagQuery.isLoading}
                >
                  {t("workflowPage.editWorkflow")}
                </Button>,
                ...(selectedSummary?.hasUnpublishedChanges
                  ? [
                      <Button
                        key="publish"
                        icon="deploy"
                        small
                        tone="primary"
                        onClick={() => void publishCurrent()}
                        disabled={
                          publishing ||
                          publishWorkflow.isPending ||
                          validateWorkflow.isPending ||
                          saveWorkflow.isPending ||
                          dagQuery.isLoading ||
                          !dagQuery.data?.workflowVersionId
                        }
                      >
                        {publishing
                          ? t("workflowPage.publishing")
                          : t("workflowPage.publishDraft")}
                      </Button>,
                    ]
                  : []),
                ...(selectedSummary?.status === "draft" && selectedWorkflow
                  ? [
                      <Button
                        key="delete"
                        icon="x"
                        tone="danger"
                        small
                        onClick={() => void deleteSelectedWorkflow()}
                        disabled={deleteWorkflow.isPending}
                      >
                        {t("workflowPage.deleteDraft")}
                      </Button>,
                    ]
                  : []),
                <Button
                  key="new"
                  icon="plus"
                  small
                  onClick={() => setShowNewModal(true)}
                >
                  {t("workflowPage.newWorkflow")}
                </Button>,
                <Button
                  key="upload"
                  icon="upload"
                  small
                  onClick={() => setShowImport(true)}
                >
                  {t("workflowPage.importManifest")}
                </Button>,
              ]
        }
      />

      <div className={styles.selectorBar}>
        <span className={styles.selectorLabel}>
          {t("workflowPage.workflow")}
        </span>
        <select
          className={styles.workflowSelect}
          aria-label={t("workflowPage.selectedWorkflowAria")}
          value={selectedWorkflow ?? ""}
          onChange={(event) => setSelectedWorkflow(event.target.value || null)}
          disabled={catalogQuery.isLoading || workflows.length === 0}
        >
          {workflows.length === 0 && (
            <option value="">{t("workflowPage.noWorkflows")}</option>
          )}
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.slug}>
              {workflow.name} ·{" "}
              {workflow.liveVersionId
                ? workflow.hasUnpublishedChanges
                  ? t("workflowPage.liveAndDraft")
                  : t("workflowPage.live")
                : t("workflowPage.draft")}{" "}
              · {workflow.latestVersion}
            </option>
          ))}
        </select>
        {selectedSummary && (
          <>
            <Badge tone={dagQuery.data?.workflowIsLive ? "green" : "amber"}>
              {dagQuery.data?.workflowIsLive
                ? t("workflowPage.liveVersion")
                : t("workflowPage.draftVersion")}
            </Badge>
            {selectedSummary.hasUnpublishedChanges && (
              <Badge tone="amber">{t("workflowPage.unpublishedChanges")}</Badge>
            )}
            <span
              className="mono"
              style={{ color: "var(--text-3)", fontSize: 10.5 }}
            >
              {workflowVersion || selectedSummary.latestVersion} ·{" "}
              {t("workflowPage.agentsCount", {
                count: selectedSummary.agentCount,
              })}
            </span>
          </>
        )}
        {catalogQuery.isError && (
          <span role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>
            {catalogQuery.error instanceof Error
              ? formatWorkflowAuthoringError(catalogQuery.error, t)
              : t("workflowPage.catalogUnavailable")}
          </span>
        )}
        {!catalogQuery.isLoading && workflows.length === 0 && (
          <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>
            {t("workflowPage.createToBegin")}
          </span>
        )}
      </div>

      {editing && <EditDraftBanner counts={draftCounts} />}

      {/* §G4 — run scrubber: recent runs across this workflow's agents.
          Selecting a chip highlights the node + its emitted-event edges. */}
      {!editing && (
        <RunScrubber
          agentNames={agentNameSet}
          titlesByName={agentTitlesByName}
          selectedRunId={scrubRun?.id ?? null}
          onSelect={setScrubRun}
        />
      )}

      {restoredAt && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 24px",
            background: "var(--panel-2)",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--text-2)",
          }}
        >
          <Icon name="alert" size={11} style={{ color: "var(--amber)" }} />
          <span>
            {t("workflowPage.restoredFrom")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {new Date(restoredAt).toLocaleString(
                language === "zh" ? "zh-CN" : "en-US",
              )}
            </span>
          </span>
          <Button
            small
            tone="ghost"
            onClick={discardRestored}
            style={{ marginLeft: "auto" }}
          >
            {t("common.discard")}
          </Button>
        </div>
      )}

      <div
        className={styles.workspace}
        ref={workspaceRef}
        style={
          {
            "--workflow-inspector-width": `${renderedInspectorWidth}px`,
            "--workflow-inspector-splitter-width": `${WORKFLOW_INSPECTOR_SPLITTER_WIDTH}px`,
          } as CSSProperties
        }
      >
        {/* Canvas */}
        <div className={styles.canvasShell} id="workflow-canvas-region">
          {editing && (
            <div className={styles.canvasCoach}>
              <Icon name="workflow" size={12} />
              <span>{t("workflowPage.canvasCoach")}</span>
              <kbd>Esc</kbd>
            </div>
          )}
          {canvasDropActive && (
            <div className={styles.dropHint} aria-hidden="true">
              <Icon name="plus" size={15} />
              {t("workflowPage.releaseToAdd")}
            </div>
          )}
          <div
            className={styles.canvas}
            ref={canvasScrollRef}
            data-drop-active={canvasDropActive ? "true" : undefined}
            onDragOver={(event) => {
              if (
                !editing ||
                !Array.from(event.dataTransfer.types).includes(
                  WORKFLOW_AGENT_DRAG_TYPE,
                )
              ) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setCanvasDropActive(true);
            }}
            onDragLeave={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              setCanvasDropActive(false);
            }}
            onDrop={(event) => {
              const actor = event.dataTransfer.getData(
                WORKFLOW_AGENT_DRAG_TYPE,
              );
              setCanvasDropActive(false);
              if (!editing || (actor !== "Agent" && actor !== "Human")) return;
              event.preventDefault();
              const point = canvasPoint(event.clientX, event.clientY);
              if (!point) return;
              addAgent(actor, {
                x: point.x - NODE_W / 2,
                y: point.y - NODE_H / 2,
              });
            }}
            onClick={(event) => {
              if (!editing || tool !== "add") return;
              const target = event.target as HTMLElement;
              if (target.closest("button,[role='button']")) return;
              const point = canvasPoint(event.clientX, event.clientY);
              if (!point) return;
              addAgent("Agent", {
                x: point.x - NODE_W / 2,
                y: point.y - NODE_H / 2,
              });
            }}
          >
            {editing && (
              <EditToolbar
                tool={tool}
                setTool={(t) => {
                  setTool(t as typeof tool);
                  if (t !== "connect") setConnectFrom(null);
                }}
                onAddAgent={() => addAgent("Agent")}
                onAutoLayout={autoLayout}
                onZoomToFit={zoomToFit}
              />
            )}

            {/* Stage headers row */}
            <div
              style={{
                position: "absolute",
                left: 0,
                width: canvasSize.width,
                top: 0,
                height: 28,
                pointerEvents: "none",
                zoom,
              }}
            >
              {stages.map((s) => (
                <div
                  key={s.id}
                  style={{
                    position: "absolute",
                    left: PAD_X + s.column * COL_W,
                    width: COL_W,
                    padding: "8px 0 0 6px",
                    fontSize: 10,
                    fontFamily: "var(--mono)",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    color: "var(--text-3)",
                  }}
                >
                  {String(s.column).padStart(2, "0")} · {s.label}
                </div>
              ))}
            </div>

            <div
              style={{
                width: canvasSize.width,
                height: canvasSize.height + 30,
                position: "relative",
                paddingTop: 30,
                zoom,
              }}
            >
              {/* Stage column dividers */}
              <div
                style={{
                  position: "absolute",
                  inset: "30px 0 0 0",
                  pointerEvents: "none",
                }}
              >
                {stages.map((s) =>
                  s.column > 0 ? (
                    <div
                      key={s.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: PAD_X + s.column * COL_W - 8,
                        width: 1,
                        background: "var(--border)",
                        opacity: 0.5,
                      }}
                    />
                  ) : null,
                )}
              </div>

              {/* SVG edges */}
              <svg
                width={canvasSize.width}
                height={canvasSize.height}
                role="img"
                aria-label={t("workflowPage.dagAria", {
                  agents: agents.length,
                  edges: edges.length,
                })}
                style={{
                  position: "absolute",
                  top: 30,
                  left: 0,
                  pointerEvents: "none",
                }}
              >
                <defs>
                  {["green", "blue", "amber", "red", "muted"].map((c) => (
                    <marker
                      key={c}
                      id={`arrow-${c}`}
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto"
                    >
                      <path d="M0,0 L10,5 L0,10 z" fill={colorVar(c)} />
                    </marker>
                  ))}
                </defs>
                {edges.map((e, i) => {
                  const s = renderedPositions.get(e.src) ?? { x: 0, y: 0 };
                  const d = renderedPositions.get(e.dst) ?? { x: 0, y: 0 };
                  const sx = s.x + NODE_W;
                  const sy = s.y + NODE_H / 2;
                  const dx = d.x;
                  const dy = d.y + NODE_H / 2;
                  const path = workflowEdgePath(
                    { x: sx, y: sy },
                    { x: dx, y: dy },
                  );
                  const color = colorVar(evColor[e.event] ?? "muted");
                  const isHi = highlighted.edges.has(i) || hoveredEdge === i;
                  const opacity = dim ? (isHi ? 1 : 0.1) : isHi ? 1 : 0.55;
                  return (
                    <g
                      key={JSON.stringify([e.src, e.dst, e.event])}
                      role="button"
                      tabIndex={0}
                      aria-label={t("workflowPage.edgeAria", {
                        event: e.event,
                        source: e.src,
                        target: e.dst,
                      })}
                      style={{ pointerEvents: "auto" }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setSelectedEvent(e.event);
                        }
                      }}
                    >
                      <path
                        d={path}
                        stroke={color}
                        strokeWidth={isHi ? 2 : 1.25}
                        fill="none"
                        opacity={opacity}
                        markerEnd={`url(#arrow-${evColor[e.event] ?? "muted"})`}
                        style={{
                          cursor: "pointer",
                          transition: "opacity 0.15s, stroke-width 0.15s",
                        }}
                        onMouseEnter={() => setHoveredEdge(i)}
                        onMouseLeave={() => setHoveredEdge(null)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedEvent(e.event);
                        }}
                      />
                      {/* §G4 — a dot travels an edge only while its event
                          name actually pulsed on the SSE stream within the
                          last few seconds (or the edge is highlighted).
                          Replaces the former index-modulo decoration. */}
                      {liveStream &&
                        (isHi ||
                          (!dim && live.activeEventNames.has(e.event))) && (
                          <circle
                            className={styles.animatedEdgeDot}
                            r="3"
                            fill={color}
                            opacity={isHi ? 1 : 0.85}
                            aria-hidden="true"
                          >
                            <animateMotion
                              dur={`${2.5 + (i % 5) * 0.4}s`}
                              repeatCount="indefinite"
                              begin={`${(i * 0.13) % 2}s`}
                              path={path}
                            />
                          </circle>
                        )}
                    </g>
                  );
                })}
                {linkDrag &&
                  (() => {
                    const source = renderedPositions.get(linkDrag.sourceId);
                    if (!source) return null;
                    const target = linkDrag.targetId
                      ? renderedPositions.get(linkDrag.targetId)
                      : null;
                    const endpoint = target
                      ? { x: target.x, y: target.y + NODE_H / 2 }
                      : linkDrag.point;
                    return (
                      <path
                        className={styles.connectionPreview}
                        d={workflowEdgePath(
                          {
                            x: source.x + NODE_W,
                            y: source.y + NODE_H / 2,
                          },
                          endpoint,
                        )}
                        markerEnd="url(#arrow-blue)"
                      />
                    );
                  })()}
              </svg>

              {/* Agent nodes */}
              <div
                style={{
                  position: "absolute",
                  top: 30,
                  left: 0,
                  width: canvasSize.width,
                  height: canvasSize.height,
                }}
              >
                {agents.map((a) => {
                  const p = renderedPositions.get(a.kebabId) ?? { x: 0, y: 0 };
                  const isSel = selectedAgent === a.kebabId;
                  const isConnectSource = connectFrom === a.kebabId;
                  const isDropTarget = linkDrag?.targetId === a.kebabId;
                  const isDragging = nodeDrag?.id === a.kebabId;
                  const isHi = highlighted.nodes.has(a.kebabId);
                  const showDim = dim && !isHi;
                  const isAdded = editing && draft.added.has(a.kebabId);
                  const isModified = Boolean(
                    editing &&
                    draft.agents[a.kebabId] &&
                    !draft.added.has(a.kebabId) &&
                    !draft.removed.has(a.kebabId),
                  );
                  const borderColor = isSel
                    ? "var(--signal)"
                    : isConnectSource
                      ? "var(--blue)"
                      : isAdded
                        ? "var(--green)"
                        : isModified
                          ? "var(--amber)"
                          : isHi
                            ? "var(--border-3)"
                            : "var(--border-2)";
                  const dashed = editing ? "dashed" : "solid";
                  const state = isAdded
                    ? t("workflowPage.nodeState.added")
                    : isModified
                      ? t("workflowPage.nodeState.modified")
                      : t("workflowPage.nodeState.unchanged");
                  const nodeLabel = t("workflowPage.nodeAria", {
                    actor:
                      a.actor === "Agent"
                        ? t("workflowPage.actorAgent")
                        : t("workflowPage.actorHuman"),
                    title: a.title,
                    id: a.kebabId,
                    state,
                  });
                  return (
                    <div
                      key={a.kebabId}
                      className={`${styles.nodeFrame} ${
                        isDragging ? styles.nodeFrameDragging : ""
                      }`}
                      style={{
                        left: p.x,
                        top: p.y,
                        width: NODE_W,
                        height: NODE_H,
                        opacity: showDim ? 0.3 : 1,
                      }}
                    >
                      <button
                        type="button"
                        className={styles.nodeButton}
                        aria-label={nodeLabel}
                        aria-pressed={isSel}
                        onPointerDown={(event) =>
                          beginNodeDrag(event, a.kebabId)
                        }
                        onPointerMove={updateNodeDrag}
                        onPointerUp={finishNodeDrag}
                        onPointerCancel={() => setNodeDrag(null)}
                        onKeyDown={(event) => nudgeNode(event, a.kebabId)}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (suppressedNodeClickRef.current === a.kebabId) {
                            suppressedNodeClickRef.current = null;
                            return;
                          }
                          if (editing && tool === "connect") {
                            connectNode(a.kebabId);
                            return;
                          }
                          setSelectedAgent(isSel ? null : a.kebabId);
                          setSelectedEvent(null);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          expandAgentPanel(a.kebabId);
                        }}
                        title={
                          editing
                            ? t("workflowPage.nodeEditTitle", {
                                title: a.title,
                              })
                            : t("workflowPage.nodeViewTitle", {
                                title: a.title,
                              })
                        }
                        style={{
                          background:
                            a.actor === "Agent"
                              ? "var(--panel)"
                              : "var(--panel-2)",
                          borderTop: `1px ${dashed} ${borderColor}`,
                          borderRight: `1px ${dashed} ${borderColor}`,
                          borderBottom: `1px ${dashed} ${borderColor}`,
                          borderLeft: `3px solid ${
                            a.actor === "Agent"
                              ? "var(--signal)"
                              : "var(--violet)"
                          }`,
                          cursor:
                            editing && tool === "connect"
                              ? "crosshair"
                              : editing && tool === "select"
                                ? isDragging
                                  ? "grabbing"
                                  : "grab"
                                : "pointer",
                          boxShadow: isSel
                            ? "0 0 0 3px rgba(208,255,0,0.12)"
                            : "none",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            marginBottom: 4,
                          }}
                        >
                          <ActorTag
                            actor={a.actor}
                            label={
                              a.actor === "Agent"
                                ? t("common.actorAgent")
                                : t("common.actorHuman")
                            }
                          />
                          {isAdded && (
                            <Badge tone="green">
                              {t("workflowPage.newBadge")}
                            </Badge>
                          )}
                          {isModified && (
                            <Badge tone="amber">
                              {t("workflowPage.modifiedBadge")}
                            </Badge>
                          )}
                          <span
                            style={{
                              marginLeft: "auto",
                              fontSize: 10,
                              fontFamily: "var(--mono)",
                              color: "var(--text-3)",
                            }}
                          >
                            {a.kebabId}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 12.5,
                            color: "var(--text)",
                            fontWeight: 600,
                            lineHeight: 1.2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                          }}
                        >
                          {a.title}
                        </div>
                      </button>
                      {editing && (
                        <>
                          <button
                            type="button"
                            className={`${styles.nodePort} ${styles.nodePortInput} ${
                              isDropTarget ? styles.nodePortActive : ""
                            }`}
                            data-workflow-input={a.kebabId}
                            aria-label={t("workflowPage.connectIntoAria", {
                              title: a.title,
                            })}
                            title={t("workflowPage.inputPortTitle", {
                              title: a.title,
                            })}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (connectFrom) {
                                connectPair(connectFrom, a.kebabId);
                                return;
                              }
                              setSelectedAgent(a.kebabId);
                            }}
                          />
                          <button
                            type="button"
                            className={`${styles.nodePort} ${styles.nodePortOutput} ${
                              linkDrag?.sourceId === a.kebabId
                                ? styles.nodePortActive
                                : ""
                            }`}
                            aria-label={t("workflowPage.startConnectionAria", {
                              title: a.title,
                            })}
                            title={t("workflowPage.outputPortTitle", {
                              title: a.title,
                            })}
                            onPointerDown={(event) =>
                              beginLinkDrag(event, a.kebabId)
                            }
                            onPointerMove={updateLinkDrag}
                            onPointerUp={finishLinkDrag}
                            onPointerCancel={() => setLinkDrag(null)}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (suppressedPortClickRef.current) return;
                              setTool("connect");
                              setConnectFrom(a.kebabId);
                              setSelectedAgent(a.kebabId);
                              setSelectedEvent(null);
                              setCanvasAnnouncement(
                                t(
                                  "workflowPage.announcement.sourceSelectedPort",
                                  {
                                    agent: a.kebabId,
                                  },
                                ),
                              );
                            }}
                          />
                        </>
                      )}
                      {/* §G4 — live state ring + badge (view mode only). */}
                      {!editing && (
                        <NodeLiveBadge
                          live={
                            live.agents[a.name] ?? live.agents[a.kebabId]
                          }
                          onOpenTasks={openTaskInbox}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {!editing && <LiveLegend />}
        </div>

        <div
          className={styles.inspectorSplitter}
          title={t("workflowPage.resizeTitle")}
          onDoubleClick={toggleAgentPanelWidth}
        >
          <Splitter
            axis="x"
            invert
            hitSize={WORKFLOW_INSPECTOR_SPLITTER_WIDTH}
            getValue={() => renderedInspectorWidth}
            setValue={(next) =>
              setInspectorWidth(
                clampWorkflowInspectorWidth(next, workspaceWidth),
              )
            }
            min={WORKFLOW_INSPECTOR_MIN_WIDTH}
            max={inspectorMaxWidth}
            ariaLabel={t("workflowPage.resizeAria")}
            ariaControls="workflow-canvas-region workflow-agent-inspector"
          />
        </div>

        {/* Right inspector aside */}
        <aside className={styles.inspector} id="workflow-agent-inspector">
          {selectedAgent && editing && selectedAgentRecord ? (
            <AgentEditor
              agent={selectedAgentRecord}
              workflowSlug={selectedWorkflow ?? undefined}
              workflowAgents={agents}
              events={events}
              draft={draft.agents[selectedAgent]}
              onChange={(next) => {
                setDraft((prev) => ({
                  ...prev,
                  agents: { ...prev.agents, [selectedAgent]: next },
                }));
                setValidation(null);
              }}
              onValidityChange={reportEditorValidity}
              onToggleWidth={toggleAgentPanelWidth}
              canResize={inspectorCanResize}
              isWide={inspectorIsWide}
              onRemove={() => {
                setDraft((prev) => {
                  const isAdded = prev.added.has(selectedAgent);
                  const nextAgents = { ...prev.agents };
                  delete nextAgents[selectedAgent];
                  return {
                    agents: nextAgents,
                    added: isAdded
                      ? new Set(
                          Array.from(prev.added).filter(
                            (id) => id !== selectedAgent,
                          ),
                        )
                      : prev.added,
                    removed: isAdded
                      ? prev.removed
                      : new Set([...prev.removed, selectedAgent]),
                  };
                });
                setValidation(null);
                setEditorErrors((current) => {
                  const next = { ...current };
                  delete next[selectedAgent];
                  return next;
                });
                setSelectedAgent(null);
              }}
              onClose={() => setSelectedAgent(null)}
            />
          ) : selectedAgent && selectedAgentRecord ? (
            // §G4 — outside edit mode the inspector defaults to the live
            // monitor (state, controls, step timeline, log tail) with the
            // original manifest definition one tab away.
            <>
              <InspectorTabs tab={inspectorTab} onChange={setInspectorTab} />
              {inspectorTab === "live" ? (
                <LiveAgentPanel
                  agent={selectedAgentRecord}
                  live={
                    live.agents[selectedAgentRecord.name] ??
                    live.agents[selectedAgentRecord.kebabId]
                  }
                  onClose={() => setSelectedAgent(null)}
                  onOpenTasks={openTaskInbox}
                />
              ) : (
                <AgentInspector
                  agent={selectedAgentRecord}
                  onClose={() => setSelectedAgent(null)}
                  onToggleWidth={toggleAgentPanelWidth}
                  canResize={inspectorCanResize}
                  isWide={inspectorIsWide}
                  workflowLabel={`${selectedWorkflow ?? t("workflowPage.workflowLower")}${workflowVersion ? ` · ${workflowVersion}` : ""}`}
                />
              )}
            </>
          ) : selectedEvent ? (
            <EventInspector
              eventName={selectedEvent}
              agents={agents}
              onClose={() => setSelectedEvent(null)}
              onNavigateAgent={(id) => {
                setSelectedAgent(id);
                setSelectedEvent(null);
              }}
              onNavigateEvents={navEvents}
            />
          ) : editing ? (
            <DraftPalette
              workflowName={
                selectedSummary?.name ??
                selectedWorkflow ??
                t("workflowPage.workflow")
              }
              draft={draft}
              connectFrom={connectFrom}
              validation={validation}
              onAddAutomated={() => addAgent("Agent")}
              onAddHuman={() => addAgent("Human")}
            />
          ) : (
            <DefaultInspector
              events={events}
              agents={agents}
              onPick={setSelectedEvent}
            />
          )}
        </aside>
      </div>
      {showNewModal && (
        <NewWorkflowModal
          onClose={() => setShowNewModal(false)}
          onCreated={selectCreatedWorkflow}
          onImport={(target) => {
            setImportTarget(target);
            setShowImport(true);
          }}
        />
      )}
      {showImport && (
        <ImportManifestModal
          onClose={() => {
            setShowImport(false);
            setImportTarget(null);
            void catalogQuery.refetch();
            void dagQuery.refetch();
          }}
          mode="workflow"
          draftTarget={importTarget ?? undefined}
          onDraftCreated={selectCreatedWorkflow}
        />
      )}
      {showRunConsole && selectedWorkflow && agents.length > 0 && (
        <WorkflowRunConsole
          workflowSlug={selectedWorkflow}
          workflowName={selectedSummary?.name ?? selectedWorkflow}
          manifest={editableManifest()}
          currentVersion={
            workflowVersion ||
            selectedSummary?.latestVersion ||
            t("workflowPage.draftLower")
          }
          liveVersionId={selectedSummary?.liveVersionId ?? null}
          onClose={() => setShowRunConsole(false)}
        />
      )}
      <WorkflowHelp open={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}
