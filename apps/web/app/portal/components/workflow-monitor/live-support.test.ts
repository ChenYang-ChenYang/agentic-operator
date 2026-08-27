/**
 * Tests for the shared monitor display helpers.
 *
 * fmtDuration exists because the live panel printed a half-hour step as
 * "1831853MS"; these pin the boundaries where the unit changes.
 */
import { describe, expect, it } from "vitest";
import { fmtDuration, fmtTokens, pickFocusRun } from "./live-support";

describe("fmtDuration", () => {
  it("keeps sub-second values in milliseconds", () => {
    expect(fmtDuration(838)).toBe("838ms");
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  it("switches to seconds at one second, with a decimal below ten", () => {
    expect(fmtDuration(1000)).toBe("1.0s");
    expect(fmtDuration(5400)).toBe("5.4s");
    expect(fmtDuration(12_400)).toBe("12s");
  });

  it("switches to minutes at one minute", () => {
    expect(fmtDuration(60_000)).toBe("1m 0s");
    expect(fmtDuration(159_000)).toBe("2m 39s");
    // The value that prompted this helper.
    expect(fmtDuration(1_831_853)).toBe("30m 32s");
  });

  it("switches to hours past sixty minutes", () => {
    expect(fmtDuration(3_600_000)).toBe("1h 0m");
    expect(fmtDuration(5_460_000)).toBe("1h 31m");
  });

  it("renders absent or nonsensical input as an em dash, never NaN", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
    expect(fmtDuration(-5)).toBe("—");
  });
});

describe("fmtTokens", () => {
  it("compacts thousands and millions", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1242)).toBe("1.2k");
    expect(fmtTokens(75_000)).toBe("75k");
    expect(fmtTokens(2_400_000)).toBe("2.4M");
  });

  it("treats absent counts as zero rather than printing NaN", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(Number.NaN)).toBe("0");
  });
});

describe("pickFocusRun", () => {
  const agent = (
    activeRunId: string | null,
    lastRunId: string | null,
    lastEventAt: number | null,
  ) => ({ activeRunId, lastRunId, lastEventAt });

  it("prefers a running agent over a finished one, whatever the timestamps", () => {
    const pick = pickFocusRun({
      done: agent(null, "run-old", 9_999),
      busy: agent("run-live", "run-prev", 1),
    });
    expect(pick).toEqual({ runId: "run-live", live: true });
  });

  it("breaks a tie between finished agents on most recent activity", () => {
    const pick = pickFocusRun({
      a: agent(null, "run-a", 100),
      b: agent(null, "run-b", 500),
    });
    expect(pick).toEqual({ runId: "run-b", live: false });
  });

  it("breaks a tie between running agents on most recent activity", () => {
    const pick = pickFocusRun({
      a: agent("run-a", null, 100),
      b: agent("run-b", null, 500),
    });
    expect(pick?.runId).toBe("run-b");
  });

  it("ignores agents that have never run", () => {
    const pick = pickFocusRun({
      never: agent(null, null, null),
      once: agent(null, "run-x", 5),
    });
    expect(pick?.runId).toBe("run-x");
  });

  it("returns null when nothing has ever run", () => {
    expect(pickFocusRun({})).toBeNull();
    expect(pickFocusRun({ a: agent(null, null, null) })).toBeNull();
  });
});
