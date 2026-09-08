/**
 * Tests for the hand-tuned LAYOUT map (audit 01 §4.2 acceptance criterion).
 *
 * The pixel positions of every node in the RAAS workflow are fixed; any
 * regression here is a visual regression. Run these in CI to prevent
 * accidental auto-packing of the canvas.
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_H,
  CANVAS_W,
  COL_W,
  LAYOUT,
  MAX_CANVAS_H,
  MAX_CANVAS_W,
  MAX_LANE,
  MAX_STAGE,
  NODE_H,
  NODE_W,
  PAD_X,
  PAD_Y,
  ROW_H,
  autoPackLayout,
  clampCanvasPosition,
  colorVar,
  dynamicCanvasSize,
  getLayout,
  nodePos,
} from "./layout";

describe("workflows/layout LAYOUT map", () => {
  it("matches the canonical v1_1 dimensions", () => {
    expect(NODE_W).toBe(184);
    // 76/104 since 2026-09-07: 64 clipped the bottom of every title glyph
    // (CJK line boxes) and the second line of English titles; 72 still
    // shrank two-line English titles by 2px (measured in the live DOM).
    expect(NODE_H).toBe(76);
    expect(COL_W).toBe(220);
    expect(ROW_H).toBe(104);
    expect(PAD_X).toBe(30);
    expect(PAD_Y).toBe(30);
  });

  it("places every of the 23 RAAS agents into a stage+lane", () => {
    const expectedIds = [
      "1-1",
      "1-2",
      "2",
      "3",
      "3-2",
      "4",
      "5",
      "6",
      "7-1",
      "7-2",
      "8",
      "9-1",
      "9-2",
      "10-1",
      "10-2",
      "11-1",
      "11-2",
      "12",
      "13",
      "14-1",
      "14-2",
      "15",
      "16",
    ];
    expect(Object.keys(LAYOUT).sort()).toEqual(expectedIds.sort());
  });

  it("computes pixel positions deterministically", () => {
    expect(nodePos("1-1")).toEqual({ x: 30, y: 30 });
    expect(nodePos("16")).toEqual({
      x: PAD_X + 7 * COL_W,
      y: PAD_Y + 1 * ROW_H,
    });
    // Bottom-right of the layout
    expect(nodePos("12")).toEqual({
      x: PAD_X + 5 * COL_W,
      y: PAD_Y + 4 * ROW_H,
    });
  });

  it("returns origin for unknown ids", () => {
    expect(nodePos("does-not-exist")).toEqual({ x: 0, y: 0 });
  });

  it("derives canvas size from the largest stage/lane", () => {
    // Validate every layout entry is inside the canvas bounds.
    for (const id of Object.keys(LAYOUT)) {
      const p = nodePos(id);
      expect(p.x + NODE_W).toBeLessThanOrEqual(CANVAS_W);
      expect(p.y + NODE_H).toBeLessThanOrEqual(CANVAS_H);
    }
    expect(MAX_STAGE).toBe(7);
    expect(MAX_LANE).toBe(4);
  });

  it("groups by stage to produce 8 columns", () => {
    const byStage = new Map<number, string[]>();
    for (const [id, p] of Object.entries(LAYOUT)) {
      const arr = byStage.get(p.stage) ?? [];
      arr.push(id);
      byStage.set(p.stage, arr);
    }
    // 8 columns total (0..7); stage 0 has 2, stage 7 has 1.
    expect(byStage.size).toBe(8);
    expect(byStage.get(0)?.sort()).toEqual(["1-1", "1-2"]);
    expect(byStage.get(7)).toEqual(["16"]);
    // Stage 5 has the widest fan-out — 5 lanes.
    expect(byStage.get(5)?.length).toBe(5);
  });

  it("colorVar maps event color tokens to CSS vars", () => {
    expect(colorVar("green")).toBe("var(--green)");
    expect(colorVar("blue")).toBe("var(--blue)");
    expect(colorVar("amber")).toBe("var(--amber)");
    expect(colorVar("red")).toBe("var(--red)");
    expect(colorVar("muted")).toBe("var(--text-3)");
    expect(colorVar(undefined)).toBe("var(--text-3)");
    expect(colorVar("unknown-color")).toBe("var(--text-3)");
  });
});

describe("autoPackLayout — fallback for non-RAAS tenants", () => {
  it("returns an empty map for an empty input", () => {
    expect(autoPackLayout([])).toEqual({});
  });

  it("packs agents with mixed manifest stages by passing stage through", () => {
    const result = autoPackLayout([
      { id: "a", stage: 1 },
      { id: "b", stage: 1 },
      { id: "c", stage: 2 },
    ]);
    expect(result).toEqual({
      a: { stage: 1, lane: 0 },
      b: { stage: 1, lane: 1 },
      c: { stage: 2, lane: 0 },
    });
  });

  it("derives stages from event topology when every agent shares one stage (api uses 99 as 'unknown')", () => {
    // robohire-shaped: matcher emits MATCH_COMPLETED, inviter triggers on it.
    // Both reported as stage 99 by the api; auto-pack must place matcher in
    // stage 0 and inviter in stage 1 (downstream).
    const result = autoPackLayout([
      {
        id: "inviter-agent",
        stage: 99,
        triggers: ["MATCH_COMPLETED"],
        emits: ["INVITE_GENERATED"],
      },
      {
        id: "matcher-agent",
        stage: 99,
        triggers: ["MATCH_REQUESTED"],
        emits: ["MATCH_COMPLETED"],
      },
    ]);
    expect(result["matcher-agent"]?.stage).toBe(0);
    expect(result["inviter-agent"]?.stage).toBe(1);
  });

  it("places agents with no upstream emitter at stage 0", () => {
    const result = autoPackLayout([
      { id: "loner", stage: 99, triggers: ["EXTERNAL"], emits: [] },
      { id: "another", stage: 99, triggers: [], emits: ["X"] },
    ]);
    expect(result["loner"]?.stage).toBe(0);
    expect(result["another"]?.stage).toBe(0);
  });

  it("breaks cycles without hanging", () => {
    // Pathological: A→B→A. Should still terminate and produce a valid map.
    const result = autoPackLayout([
      { id: "a", stage: 99, triggers: ["FROM_B"], emits: ["FROM_A"] },
      { id: "b", stage: 99, triggers: ["FROM_A"], emits: ["FROM_B"] },
    ]);
    expect(Object.keys(result).sort()).toEqual(["a", "b"]);
    // Both stages are finite (capped at agents.length).
    expect(result["a"]?.stage).toBeLessThanOrEqual(2);
    expect(result["b"]?.stage).toBeLessThanOrEqual(2);
  });

  it("is stable — same input -> identical output (deterministic lanes)", () => {
    const input = [
      { id: "c", stage: 99, triggers: [], emits: [] },
      { id: "a", stage: 99, triggers: [], emits: [] },
      { id: "b", stage: 99, triggers: [], emits: [] },
    ];
    const r1 = autoPackLayout(input);
    const r2 = autoPackLayout(input);
    expect(r1).toEqual(r2);
    // Lanes assigned in sorted id order.
    expect(r1["a"]).toEqual({ stage: 0, lane: 0 });
    expect(r1["b"]).toEqual({ stage: 0, lane: 1 });
    expect(r1["c"]).toEqual({ stage: 0, lane: 2 });
  });
});

describe("dynamic workflow canvas", () => {
  it("preserves the legacy minimum for the hand-tuned RAAS layout", () => {
    const positions = Object.keys(LAYOUT).map((id) => nodePos(id));
    expect(dynamicCanvasSize(positions)).toEqual({
      width: CANVAS_W,
      height: CANVAS_H,
    });
  });

  it("expands to fit a 100-agent vertical workflow", () => {
    const fallback = autoPackLayout(
      Array.from({ length: 100 }, (_, index) => ({
        id: `agent-${String(index).padStart(3, "0")}`,
        stage: 0,
      })),
    );
    const positions = Object.keys(fallback).map((id) => nodePos(id, fallback));
    const size = dynamicCanvasSize(positions);
    expect(size.height).toBeGreaterThan(CANVAS_H);
    expect(size.height).toBeLessThanOrEqual(MAX_CANVAS_H);
    for (const position of positions) {
      expect(position.y + NODE_H).toBeLessThanOrEqual(size.height);
    }
  });

  it("caps hostile or non-finite imported coordinates", () => {
    expect(
      clampCanvasPosition({ x: Number.POSITIVE_INFINITY, y: -10 }),
    ).toEqual({ x: 0, y: 0 });
    expect(clampCanvasPosition({ x: 1e12, y: 1e12 })).toEqual({
      x: MAX_CANVAS_W - NODE_W,
      y: MAX_CANVAS_H - NODE_H,
    });
    expect(dynamicCanvasSize([{ x: 1e12, y: 1e12 }])).toEqual({
      width: MAX_CANVAS_W,
      height: MAX_CANVAS_H,
    });
  });
});

describe("getLayout — hand-tuned LAYOUT wins over fallback", () => {
  it("returns the LAYOUT entry when both exist (RAAS fidelity guard)", () => {
    // Even if the auto-pack puts "1-1" somewhere wildly different, the
    // RAAS hand-tuned entry must always win. Visual regression guard.
    const fallback = { "1-1": { stage: 99, lane: 99 } };
    expect(getLayout("1-1", fallback)).toEqual({ stage: 0, lane: 0 });
  });

  it("falls back to the auto-packed entry when LAYOUT is silent", () => {
    const fallback = {
      "matcher-agent": { stage: 0, lane: 0 },
      "inviter-agent": { stage: 1, lane: 0 },
    };
    expect(getLayout("matcher-agent", fallback)).toEqual({ stage: 0, lane: 0 });
    expect(getLayout("inviter-agent", fallback)).toEqual({ stage: 1, lane: 0 });
  });

  it("returns null when neither LAYOUT nor fallback knows the id", () => {
    expect(getLayout("does-not-exist")).toBeNull();
    expect(getLayout("does-not-exist", {})).toBeNull();
  });

  it("nodePos resolves through the fallback chain", () => {
    const fallback = { "custom-agent": { stage: 2, lane: 1 } };
    // Hand-tuned wins.
    expect(nodePos("1-1", fallback)).toEqual({ x: 30, y: 30 });
    // Fallback used.
    expect(nodePos("custom-agent", fallback)).toEqual({
      x: PAD_X + 2 * COL_W,
      y: PAD_Y + 1 * ROW_H,
    });
    // Unknown without fallback -> origin (unchanged behavior).
    expect(nodePos("nope")).toEqual({ x: 0, y: 0 });
  });
});

describe("RAAS LAYOUT regression guard — hand-tuned positions must never move", () => {
  // Locks in every (stage, lane) for the 23 RAAS agents. If a future edit
  // ever auto-packs RAAS by mistake, this fails loudly.
  it("preserves the v1_1 hand-tuned positions byte-for-byte", () => {
    expect(LAYOUT).toMatchInlineSnapshot(`
      {
        "1-1": {
          "lane": 0,
          "stage": 0,
        },
        "1-2": {
          "lane": 1,
          "stage": 0,
        },
        "10-1": {
          "lane": 0,
          "stage": 5,
        },
        "10-2": {
          "lane": 1,
          "stage": 5,
        },
        "11-1": {
          "lane": 2,
          "stage": 5,
        },
        "11-2": {
          "lane": 3,
          "stage": 5,
        },
        "12": {
          "lane": 4,
          "stage": 5,
        },
        "13": {
          "lane": 0,
          "stage": 6,
        },
        "14-1": {
          "lane": 1,
          "stage": 6,
        },
        "14-2": {
          "lane": 2,
          "stage": 6,
        },
        "15": {
          "lane": 3,
          "stage": 6,
        },
        "16": {
          "lane": 1,
          "stage": 7,
        },
        "2": {
          "lane": 0,
          "stage": 1,
        },
        "3": {
          "lane": 1,
          "stage": 1,
        },
        "3-2": {
          "lane": 2,
          "stage": 1,
        },
        "4": {
          "lane": 0,
          "stage": 2,
        },
        "5": {
          "lane": 1,
          "stage": 2,
        },
        "6": {
          "lane": 0,
          "stage": 3,
        },
        "7-1": {
          "lane": 1,
          "stage": 3,
        },
        "7-2": {
          "lane": 2,
          "stage": 3,
        },
        "8": {
          "lane": 0,
          "stage": 4,
        },
        "9-1": {
          "lane": 1,
          "stage": 4,
        },
        "9-2": {
          "lane": 2,
          "stage": 4,
        },
      }
    `);
  });
});
