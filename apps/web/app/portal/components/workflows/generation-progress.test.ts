import { describe, expect, it } from "vitest";
import type { WorkflowGenerationProgress } from "@agentic/contracts";
import {
  GENERATION_STAGE_ORDER,
  buildGenerationTimeline,
  formatElapsed,
} from "./generation-progress";

function event(
  overrides: Partial<WorkflowGenerationProgress> &
    Pick<WorkflowGenerationProgress, "stage" | "status">,
): WorkflowGenerationProgress {
  return {
    atMs: 0,
    durationMs: null,
    detail: null,
    tokensIn: null,
    tokensOut: null,
    ...overrides,
  } as WorkflowGenerationProgress;
}

describe("buildGenerationTimeline", () => {
  it("shows every stage as pending before anything is reported", () => {
    const { stages } = buildGenerationTimeline([]);
    // `repair` is conditional, so it must not imply the generator always repairs.
    expect(stages.map((stage) => stage.id)).toEqual(
      GENERATION_STAGE_ORDER.filter((id) => id !== "repair"),
    );
    expect(stages.every((stage) => stage.state === "pending")).toBe(true);
  });

  it("marks the stage the server says is running as active, not complete", () => {
    const { stages } = buildGenerationTimeline([
      event({ stage: "generate", status: "started" }),
    ]);
    expect(stages.find((stage) => stage.id === "generate")?.state).toBe(
      "active",
    );
    // Nothing downstream is guessed at.
    expect(stages.find((stage) => stage.id === "validate")?.state).toBe(
      "pending",
    );
  });

  it("keeps the server's own duration and detail for a finished stage", () => {
    const { stages } = buildGenerationTimeline([
      event({ stage: "generate", status: "started" }),
      event({
        stage: "generate",
        status: "ok",
        durationMs: 34_335,
        detail: "7,566 characters returned",
      }),
    ]);
    const generate = stages.find((stage) => stage.id === "generate")!;
    expect(generate.state).toBe("done");
    expect(generate.durationMs).toBe(34_335);
    expect(generate.detail).toBe("7,566 characters returned");
  });

  it("distinguishes skipped from pending", () => {
    const { stages } = buildGenerationTimeline([
      event({ stage: "documents", status: "skipped" }),
    ]);
    expect(stages.find((stage) => stage.id === "documents")?.state).toBe(
      "skipped",
    );
  });

  it("surfaces repair only once it actually happens", () => {
    const { stages } = buildGenerationTimeline([
      event({ stage: "interpret", status: "failed", detail: "bad JSON" }),
      event({ stage: "repair", status: "started" }),
    ]);
    expect(stages.find((stage) => stage.id === "repair")?.state).toBe("active");
    expect(stages.find((stage) => stage.id === "interpret")?.state).toBe(
      "failed",
    );
  });

  it("carries the latest cumulative token counts forward", () => {
    const timeline = buildGenerationTimeline([
      event({ stage: "generate", status: "ok", tokensIn: 12_534, tokensOut: 3_802 }),
      // Later events report no tokens; the display must not blank out.
      event({ stage: "validate", status: "ok" }),
    ]);
    expect(timeline.tokensIn).toBe(12_534);
    expect(timeline.tokensOut).toBe(3_802);
  });

  it("reports the server's own elapsed offset", () => {
    const timeline = buildGenerationTimeline([
      event({ stage: "generate", status: "ok", atMs: 34_337 }),
    ]);
    expect(timeline.serverElapsedMs).toBe(34_337);
  });
});

describe("formatElapsed", () => {
  it("stays compact and readable as it grows", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(340)).toBe("340ms");
    expect(formatElapsed(1_400)).toBe("1.4s");
    expect(formatElapsed(28_000)).toBe("28s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });
});
