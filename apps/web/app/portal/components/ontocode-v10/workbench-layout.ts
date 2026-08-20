/**
 * OntoCode v10 · three-column workbench layout model.
 *
 * Pure — no React, no DOM — so it unit-tests in the node vitest env (mirrors
 * `components/workflows/inspector-layout.ts`, the same seam used by the
 * workflow editor's resizable inspector). The React state wiring lives in
 * `use-workbench-layout.ts`; the rendering in `WorkbenchShell.tsx`.
 *
 * Invariant this file exists to protect: **the centre column can never be
 * squeezed to nothing.** Both side columns are independently resizable, so
 * their maxima are computed against the live viewport *and* against whatever
 * the other side is currently occupying, always reserving `OC_FLOW_MIN_WIDTH`
 * for the conversation.
 */

// ─── Named clamps (no magic pixels sprinkled through the component) ─────────

/** Left rail: the shipped v10 width, and the band a drag may move it in. */
export const OC_RAIL_DEFAULT_WIDTH = 272;
export const OC_RAIL_MIN_WIDTH = 200;
export const OC_RAIL_MAX_WIDTH = 460;

/** Right inspector: unchanged from the pre-existing 360–860 drag band. */
export const OC_INSPECTOR_DEFAULT_WIDTH = 432;
export const OC_INSPECTOR_MIN_WIDTH = 360;
export const OC_INSPECTOR_MAX_WIDTH = 860;

/** The centre conversation column's floor — the reason the clamps exist. */
export const OC_FLOW_MIN_WIDTH = 420;

/** Pointer hit-area of one resize handle (also its laid-out width). */
export const OC_SPLITTER_WIDTH = 10;

/** Width of the thin strip a collapsed column leaves behind so it can be
 *  re-expanded. Collapse must never be a one-way door. */
export const OC_COLLAPSED_RAIL_WIDTH = 36;

/** Pixels one arrow-key press moves a handle. */
export const OC_RESIZE_KEYBOARD_STEP = 16;

export interface WorkbenchLayout {
  railWidth: number;
  railCollapsed: boolean;
  inspectorWidth: number;
  inspectorCollapsed: boolean;
}

export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = {
  railWidth: OC_RAIL_DEFAULT_WIDTH,
  railCollapsed: false,
  inspectorWidth: OC_INSPECTOR_DEFAULT_WIDTH,
  inspectorCollapsed: false,
};

// ─── Geometry ───────────────────────────────────────────────────────────────

/**
 * Total horizontal space a side column consumes, including its resize handle.
 * A collapsed column consumes only its re-expand strip (and has no handle).
 */
export function sideOccupiedWidth(width: number, collapsed: boolean): number {
  if (collapsed) return OC_COLLAPSED_RAIL_WIDTH;
  const finite = Number.isFinite(width) ? Math.round(width) : 0;
  return finite + OC_SPLITTER_WIDTH;
}

/**
 * How wide one side column may grow given what the other side already takes.
 *
 * Below the desktop breakpoint the remaining room goes negative; we clamp up
 * to `hardMin` rather than returning nonsense, because CSS — not this
 * function — owns the narrow-window story (the inspector becomes a fixed
 * overlay drawer at ≤1199px). Same contract as `workflowInspectorMaxWidth`.
 */
function sideMaxWidth(
  viewportWidth: number,
  otherOccupied: number,
  hardMin: number,
  hardMax: number,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return hardMax;
  const room = Math.floor(
    viewportWidth - otherOccupied - OC_FLOW_MIN_WIDTH - OC_SPLITTER_WIDTH,
  );
  return Math.max(hardMin, Math.min(hardMax, room));
}

export function railMaxWidth(
  viewportWidth: number,
  inspectorOccupied: number,
): number {
  return sideMaxWidth(
    viewportWidth,
    inspectorOccupied,
    OC_RAIL_MIN_WIDTH,
    OC_RAIL_MAX_WIDTH,
  );
}

export function inspectorMaxWidth(
  viewportWidth: number,
  railOccupied: number,
): number {
  return sideMaxWidth(
    viewportWidth,
    railOccupied,
    OC_INSPECTOR_MIN_WIDTH,
    OC_INSPECTOR_MAX_WIDTH,
  );
}

function clampSide(
  width: number,
  fallback: number,
  min: number,
  max: number,
): number {
  const finite = Number.isFinite(width) ? Math.round(width) : fallback;
  return Math.max(min, Math.min(max, finite));
}

export function clampRailWidth(
  width: number,
  viewportWidth: number,
  inspectorOccupied: number,
): number {
  return clampSide(
    width,
    OC_RAIL_DEFAULT_WIDTH,
    OC_RAIL_MIN_WIDTH,
    railMaxWidth(viewportWidth, inspectorOccupied),
  );
}

export function clampInspectorWidth(
  width: number,
  viewportWidth: number,
  railOccupied: number,
): number {
  return clampSide(
    width,
    OC_INSPECTOR_DEFAULT_WIDTH,
    OC_INSPECTOR_MIN_WIDTH,
    inspectorMaxWidth(viewportWidth, railOccupied),
  );
}

/**
 * Widths to actually render, given stored preferences and the live viewport.
 *
 * The two columns constrain each other, so the order is fixed and documented:
 * the rail is clamped against the inspector's *stored* occupancy, then the
 * inspector against the *resolved* rail. A collapsed column keeps its stored
 * width untouched — that is the width it re-expands to.
 */
export function resolveWorkbenchWidths(
  layout: WorkbenchLayout,
  viewportWidth: number,
): { railWidth: number; inspectorWidth: number } {
  const railWidth = layout.railCollapsed
    ? layout.railWidth
    : clampRailWidth(
        layout.railWidth,
        viewportWidth,
        sideOccupiedWidth(layout.inspectorWidth, layout.inspectorCollapsed),
      );
  const inspectorWidth = layout.inspectorCollapsed
    ? layout.inspectorWidth
    : clampInspectorWidth(
        layout.inspectorWidth,
        viewportWidth,
        sideOccupiedWidth(railWidth, layout.railCollapsed),
      );
  return { railWidth, inspectorWidth };
}

// ─── Persistence ────────────────────────────────────────────────────────────
// Same shape as the other portal UI prefs: a versioned, tenant-scoped key and
// a tolerant normalizer, so a stale or hand-edited blob degrades to defaults
// instead of rendering a broken workbench.

export function workbenchLayoutStorageKey(tenant: string): string {
  return `agentic:ontocode-workbench-layout:v1:${tenant}`;
}

/** Minimal surface we need from `localStorage` — keeps this file DOM-free. */
export interface WorkbenchLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Coerce an untrusted blob into a valid layout, per field. Widths are held to
 *  their design band here; the viewport-dependent clamp happens at render. */
export function normalizeWorkbenchLayout(raw: unknown): WorkbenchLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WORKBENCH_LAYOUT };
  const r = raw as Record<string, unknown>;
  return {
    railWidth: clampSide(
      typeof r.railWidth === "number" ? r.railWidth : Number.NaN,
      OC_RAIL_DEFAULT_WIDTH,
      OC_RAIL_MIN_WIDTH,
      OC_RAIL_MAX_WIDTH,
    ),
    railCollapsed: boolOr(r.railCollapsed, DEFAULT_WORKBENCH_LAYOUT.railCollapsed),
    inspectorWidth: clampSide(
      typeof r.inspectorWidth === "number" ? r.inspectorWidth : Number.NaN,
      OC_INSPECTOR_DEFAULT_WIDTH,
      OC_INSPECTOR_MIN_WIDTH,
      OC_INSPECTOR_MAX_WIDTH,
    ),
    inspectorCollapsed: boolOr(
      r.inspectorCollapsed,
      DEFAULT_WORKBENCH_LAYOUT.inspectorCollapsed,
    ),
  };
}

/** Best-effort read. Private-mode / disabled storage must not break the page. */
export function readWorkbenchLayout(
  storage: WorkbenchLayoutStorage | null | undefined,
  key: string,
): WorkbenchLayout {
  if (!storage) return { ...DEFAULT_WORKBENCH_LAYOUT };
  try {
    const raw = storage.getItem(key);
    if (!raw) return { ...DEFAULT_WORKBENCH_LAYOUT };
    return normalizeWorkbenchLayout(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_WORKBENCH_LAYOUT };
  }
}

/** Best-effort write — a quota/security error is not worth an error boundary. */
export function writeWorkbenchLayout(
  storage: WorkbenchLayoutStorage | null | undefined,
  key: string,
  layout: WorkbenchLayout,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

// ─── Reducer ────────────────────────────────────────────────────────────────

export type WorkbenchLayoutAction =
  | { type: "hydrate"; layout: WorkbenchLayout }
  | { type: "toggleRail" }
  | { type: "toggleInspector" }
  | { type: "setRailCollapsed"; collapsed: boolean }
  | { type: "setInspectorCollapsed"; collapsed: boolean }
  | { type: "setRailWidth"; width: number; viewportWidth: number }
  | { type: "setInspectorWidth"; width: number; viewportWidth: number };

/**
 * Collapsing never discards the stored width — it is what the column
 * re-expands to. No-op actions return the identical state object so React
 * bails out of the re-render.
 */
export function workbenchLayoutReducer(
  state: WorkbenchLayout,
  action: WorkbenchLayoutAction,
): WorkbenchLayout {
  switch (action.type) {
    case "hydrate":
      return action.layout;
    case "toggleRail":
      return { ...state, railCollapsed: !state.railCollapsed };
    case "toggleInspector":
      return { ...state, inspectorCollapsed: !state.inspectorCollapsed };
    case "setRailCollapsed":
      return state.railCollapsed === action.collapsed
        ? state
        : { ...state, railCollapsed: action.collapsed };
    case "setInspectorCollapsed":
      return state.inspectorCollapsed === action.collapsed
        ? state
        : { ...state, inspectorCollapsed: action.collapsed };
    case "setRailWidth": {
      const railWidth = clampRailWidth(
        action.width,
        action.viewportWidth,
        sideOccupiedWidth(state.inspectorWidth, state.inspectorCollapsed),
      );
      return railWidth === state.railWidth ? state : { ...state, railWidth };
    }
    case "setInspectorWidth": {
      const inspectorWidth = clampInspectorWidth(
        action.width,
        action.viewportWidth,
        sideOccupiedWidth(state.railWidth, state.railCollapsed),
      );
      return inspectorWidth === state.inspectorWidth
        ? state
        : { ...state, inspectorWidth };
    }
    default:
      return state;
  }
}
