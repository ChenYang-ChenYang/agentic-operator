/**
 * Workflow canvas layout constants + the hand-tuned LAYOUT map.
 *
 * Ported verbatim from `agentic-operator_v1_1/views/workflows.jsx:5-37`.
 * **DO NOT** replace this with auto-packing for the RAAS workflow — every
 * value here was hand-tuned to match the design prototype (audit 01 §4.2
 * acceptance criterion). The auto-packer below is ONLY consulted as a
 * fallback for tenant kebab-ids that LAYOUT doesn't cover (e.g. robohire's
 * `matcher-agent` / `inviter-agent`); existing LAYOUT entries always win.
 */

export const NODE_W = 184;
/** 76 = the card's measured content budget (see `.nodeTitle` in
 * workflow.module.css): 2px border + 11px padding + 20.7px actor pill row +
 * 3px gap + a two-line 18px title (+1px) = 73.7, or a one-line title plus
 * the 14px kebab-id row = 69.7. 64 clipped the glyphs of every title; 72
 * still shrank two-line English titles by 2px. */
export const NODE_H = 76;
export const COL_W = 220;
/** Keeps the inter-row gap at 28px after the node grew from 64 to 76. */
export const ROW_H = 104;
export const PAD_X = 30;
export const PAD_Y = 30;

/**
 * Maps node kebab-id → (stage column, lane row). Every node in the RAAS
 * workflow has an explicit position.
 */
export const LAYOUT: Record<string, { stage: number; lane: number }> = {
  "1-1": { stage: 0, lane: 0 },
  "1-2": { stage: 0, lane: 1 },
  "2": { stage: 1, lane: 0 },
  "3": { stage: 1, lane: 1 },
  "3-2": { stage: 1, lane: 2 },
  "4": { stage: 2, lane: 0 },
  "5": { stage: 2, lane: 1 },
  "6": { stage: 3, lane: 0 },
  "7-1": { stage: 3, lane: 1 },
  "7-2": { stage: 3, lane: 2 },
  "8": { stage: 4, lane: 0 },
  "9-1": { stage: 4, lane: 1 },
  "9-2": { stage: 4, lane: 2 },
  "10-1": { stage: 5, lane: 0 },
  "10-2": { stage: 5, lane: 1 },
  "11-1": { stage: 5, lane: 2 },
  "11-2": { stage: 5, lane: 3 },
  "12": { stage: 5, lane: 4 },
  "13": { stage: 6, lane: 0 },
  "14-1": { stage: 6, lane: 1 },
  "14-2": { stage: 6, lane: 2 },
  "15": { stage: 6, lane: 3 },
  "16": { stage: 7, lane: 1 },
};

/**
 * Auto-pack a set of agents into the (stage, lane) grid for tenants that
 * don't have a hand-tuned LAYOUT entry. Used as a fallback by `getLayout()`.
 *
 * Strategy — bucket by stage, then assign lanes within each bucket:
 *   1. If every agent shares the same stage (the api uses 99 as the
 *      "unknown stage" sentinel when a manifest doesn't declare staging),
 *      derive stages from the event topology instead: agents with no
 *      incoming triggers from this tenant land at stage 0; downstream
 *      listeners land at stage = 1 + max(stage of upstream emitters).
 *      This gives `matcher-agent → MATCH_COMPLETED → inviter-agent` the
 *      natural left-to-right layout (matcher in col 0, inviter in col 1).
 *   2. Otherwise pass the manifest-declared stage through unchanged so a
 *      tenant that DOES declare stages keeps them.
 *   3. Sort agent ids inside each bucket by string compare so the same
 *      input always produces the same lane assignment (deterministic).
 *
 * Stable: same input array → identical output. The function never mutates
 * input.
 */
export function autoPackLayout(
  agents: Array<{
    id: string;
    stage: number;
    triggers?: string[];
    emits?: string[];
  }>,
): Record<string, { stage: number; lane: number }> {
  if (agents.length === 0) return {};

  // Step 1: decide effective stage per agent.
  //   - Mixed manifest stages → pass through.
  //   - All-same stage (typical: every agent at stage 99) → topo-sort.
  const declared = new Set(agents.map((a) => a.stage));
  const effectiveStage = new Map<string, number>();

  if (declared.size === 1) {
    // Topo-sort: who emits an event that anyone else triggers on?
    const emitterOf = new Map<string, string[]>(); // event → agent ids that emit it
    for (const a of agents) {
      for (const e of a.emits ?? []) {
        const arr = emitterOf.get(e) ?? [];
        arr.push(a.id);
        emitterOf.set(e, arr);
      }
    }
    // Memoized depth — guard against accidental cycles by capping at agents.length.
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    function depthOf(id: string): number {
      const cached = depth.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0; // cycle break
      visiting.add(id);
      const agent = agents.find((a) => a.id === id);
      const triggers = agent?.triggers ?? [];
      let maxParent = -1;
      for (const t of triggers) {
        const parents = emitterOf.get(t) ?? [];
        for (const p of parents) {
          if (p === id) continue;
          maxParent = Math.max(maxParent, depthOf(p));
        }
      }
      const d = maxParent + 1; // 0 when no parents
      depth.set(id, d);
      visiting.delete(id);
      return d;
    }
    for (const a of agents) {
      effectiveStage.set(a.id, Math.min(depthOf(a.id), agents.length));
    }
  } else {
    for (const a of agents) effectiveStage.set(a.id, a.stage);
  }

  // Step 2: bucket by stage, sort ids stably, assign lanes.
  const byStage = new Map<number, string[]>();
  for (const a of agents) {
    const s = effectiveStage.get(a.id) ?? 0;
    const arr = byStage.get(s) ?? [];
    arr.push(a.id);
    byStage.set(s, arr);
  }
  const out: Record<string, { stage: number; lane: number }> = {};
  for (const [stage, ids] of byStage) {
    const sorted = [...ids].sort();
    sorted.forEach((id, lane) => {
      out[id] = { stage, lane };
    });
  }
  return out;
}

/**
 * Resolve a position for an agent. Hand-tuned LAYOUT entry wins; falls back
 * to the auto-packed map (typically the output of `autoPackLayout` for the
 * current tenant). Returns null when neither has an entry — caller decides
 * whether to skip rendering or render at origin.
 */
export function getLayout(
  id: string,
  fallback?: Record<string, { stage: number; lane: number }>,
): { stage: number; lane: number } | null {
  return LAYOUT[id] ?? fallback?.[id] ?? null;
}

export function nodePos(
  id: string,
  fallback?: Record<string, { stage: number; lane: number }>,
): { x: number; y: number } {
  const p = getLayout(id, fallback);
  if (!p) return { x: 0, y: 0 };
  return {
    x: PAD_X + p.stage * COL_W,
    y: PAD_Y + p.lane * ROW_H,
  };
}

export function colorVar(c: string | undefined | null): string {
  const map: Record<string, string> = {
    green: "var(--green)",
    blue: "var(--blue)",
    amber: "var(--amber)",
    red: "var(--red)",
    muted: "var(--text-3)",
  };
  return map[c ?? ""] ?? "var(--text-3)";
}

/** Maximum stage/lane in the LAYOUT map — drives canvas size. */
export const MAX_STAGE = 7;
export const MAX_LANE = 4;

export const CANVAS_W = PAD_X * 2 + (MAX_STAGE + 1) * COL_W;
export const CANVAS_H = PAD_Y * 2 + (MAX_LANE + 1) * ROW_H;

/**
 * Authoring supports at most 100 agents. These caps cover both pathological
 * shapes for that limit (a 100-step chain or 100 agents in one lane) while
 * preventing an imported coordinate such as `Number.MAX_VALUE` from creating
 * an unusably large browser layer.
 */
export const MAX_CANVAS_W = PAD_X * 2 + 101 * COL_W;
export const MAX_CANVAS_H = PAD_Y * 2 + 100 * ROW_H;

export interface CanvasPoint {
  x: number;
  y: number;
}

export function clampCanvasPosition(position: CanvasPoint): CanvasPoint {
  const x = Number.isFinite(position.x) ? position.x : 0;
  const y = Number.isFinite(position.y) ? position.y : 0;
  return {
    x: Math.max(0, Math.min(MAX_CANVAS_W - NODE_W, x)),
    y: Math.max(0, Math.min(MAX_CANVAS_H - NODE_H, y)),
  };
}

/**
 * Grow the canvas to contain every node plus one padding gutter. The legacy
 * canvas remains the minimum so existing RAAS screenshots do not move.
 */
export function dynamicCanvasSize(positions: Iterable<CanvasPoint>): {
  width: number;
  height: number;
} {
  let width = CANVAS_W;
  let height = CANVAS_H;
  for (const raw of positions) {
    const position = clampCanvasPosition(raw);
    width = Math.max(width, position.x + NODE_W + PAD_X);
    height = Math.max(height, position.y + NODE_H + PAD_Y);
  }
  return {
    width: Math.min(MAX_CANVAS_W, Math.ceil(width)),
    height: Math.min(MAX_CANVAS_H, Math.ceil(height)),
  };
}
