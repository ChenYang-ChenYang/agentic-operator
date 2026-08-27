/**
 * Reduces the server's generation progress events into a timeline the modal can
 * render.
 *
 * Every value here is server-measured. Nothing is interpolated or predicted:
 * a stage stays "pending" until the server says it started, because a fake
 * progress bar that finishes before the work does is worse than no bar.
 */

import type { WorkflowGenerationProgress } from "@agentic/contracts";

/** Fixed display order — the order the generator actually performs them. */
export const GENERATION_STAGE_ORDER = [
  "documents",
  "research",
  "model",
  "generate",
  "interpret",
  "repair",
  "validate",
] as const;

export type GenerationStageId = (typeof GENERATION_STAGE_ORDER)[number];

export type GenerationStageState =
  | "pending"
  | "active"
  | "done"
  | "skipped"
  | "failed";

export interface GenerationStageView {
  id: GenerationStageId;
  state: GenerationStageState;
  /** Server-measured wall-clock for the stage, once it has finished. */
  durationMs: number | null;
  detail: string | null;
}

export interface GenerationTimeline {
  stages: GenerationStageView[];
  /** Latest cumulative token counts the server has reported, if any. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** Offset of the most recent event — the server's own elapsed clock. */
  serverElapsedMs: number;
}

/**
 * `repair` is conditional and rare; showing it as a pending step on every run
 * would imply the generator always repairs its own output.
 */
function isHiddenWhenUntouched(stage: GenerationStageId): boolean {
  return stage === "repair";
}

export function buildGenerationTimeline(
  events: readonly WorkflowGenerationProgress[],
): GenerationTimeline {
  const byStage = new Map<GenerationStageId, WorkflowGenerationProgress[]>();
  for (const event of events) {
    const bucket = byStage.get(event.stage as GenerationStageId) ?? [];
    bucket.push(event);
    byStage.set(event.stage as GenerationStageId, bucket);
  }

  const stages: GenerationStageView[] = [];
  for (const id of GENERATION_STAGE_ORDER) {
    const seen = byStage.get(id);
    if (!seen || seen.length === 0) {
      if (isHiddenWhenUntouched(id)) continue;
      stages.push({ id, state: "pending", durationMs: null, detail: null });
      continue;
    }
    const last = seen[seen.length - 1]!;
    const state: GenerationStageState =
      last.status === "started"
        ? "active"
        : last.status === "ok"
          ? "done"
          : last.status === "skipped"
            ? "skipped"
            : "failed";
    stages.push({
      id,
      state,
      durationMs: last.durationMs,
      detail: last.detail,
    });
  }

  // Token counts are cumulative and only attached to some events; carry the
  // most recent non-null forward rather than blanking the display.
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  for (const event of events) {
    if (event.tokensIn !== null) tokensIn = event.tokensIn;
    if (event.tokensOut !== null) tokensOut = event.tokensOut;
  }

  return {
    stages,
    tokensIn,
    tokensOut,
    serverElapsedMs: events.length ? events[events.length - 1]!.atMs : 0,
  };
}

/** `1.4s`, `28s`, `2m 05s` — compact and stable in width as it grows. */
export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
