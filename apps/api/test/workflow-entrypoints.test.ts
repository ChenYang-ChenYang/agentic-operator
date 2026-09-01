import { describe, expect, it } from "vitest";
import { describeWorkflowEntrypoints } from "../src/services/workflow-test-runner.js";

/**
 * Shaped after the hc-procurement manifest, which has three externally-fired
 * triggers of wildly different reach.
 */
function manifest(
  agents: Array<{ name: string; trigger: string[]; emits?: string[] }>,
) {
  return {
    agents: agents.map((agent) => ({
      id: agent.name,
      name: agent.name,
      title: agent.name,
      actor: "Agent",
      trigger: agent.trigger,
      triggered_event: agent.emits ?? [],
      actions: [],
    })),
  };
}

const HC = manifest([
  { name: "collect", trigger: ["DAILY_SCAN", "DOC_STATUS_CHANGED"], emits: ["SYNCED"] },
  { name: "calculate", trigger: ["SYNCED"], emits: ["DETECTED", "NO_DEVIATION"] },
  { name: "archive", trigger: ["NO_DEVIATION"] },
  { name: "score", trigger: ["DETECTED"], emits: ["SCORED"] },
  { name: "raise", trigger: ["SCORED", "ESCALATED"], emits: ["RAISED"] },
  { name: "generate", trigger: ["RAISED"], emits: ["OPTIONS"] },
  { name: "approve", trigger: ["OPTIONS"] },
  // The timeout sweep: externally fired, but it drives almost nothing.
  { name: "escalate", trigger: ["ALERT_TIMEOUT_SCAN"], emits: ["ESCALATED"] },
]);

describe("describeWorkflowEntrypoints", () => {
  const { entrypoints } = describeWorkflowEntrypoints(HC);
  const byEvent = (event: string) =>
    entrypoints.find((entry) => entry.event === event);

  // Every external trigger used to be recommended equally, so the console
  // defaulted to whichever sorted first alphabetically — ALERT_TIMEOUT_SCAN,
  // a one-agent sweep. You picked the default and got one node.
  it("recommends the trigger that actually drives the workflow", () => {
    expect(byEvent("DAILY_SCAN")?.recommended).toBe(true);
    expect(byEvent("ALERT_TIMEOUT_SCAN")?.recommended).toBe(false);
    expect(entrypoints[0]!.event).toBe("DAILY_SCAN");
  });

  it("still offers the narrow external trigger, just not as the default", () => {
    const escalate = byEvent("ALERT_TIMEOUT_SCAN");
    expect(escalate).toBeDefined();
    expect(escalate?.source).toBe("external");
  });

  it("keeps internal events available and never recommended", () => {
    const internal = byEvent("SYNCED");
    expect(internal?.source).toBe("internal");
    expect(internal?.recommended).toBe(false);
  });

  it("orders by reach, so the widest entry is nearest the top", () => {
    const order = entrypoints.map((entry) => entry.event);
    expect(order.indexOf("DAILY_SCAN")).toBeLessThan(
      order.indexOf("ALERT_TIMEOUT_SCAN"),
    );
  });

  it("recommends both when two external triggers reach the same agents", () => {
    // collect listens to DAILY_SCAN and DOC_STATUS_CHANGED alike.
    expect(byEvent("DOC_STATUS_CHANGED")?.recommended).toBe(true);
  });

  it("warns when every trigger is emitted inside the workflow", () => {
    const { warnings } = describeWorkflowEntrypoints(
      manifest([
        { name: "a", trigger: ["LOOP"], emits: ["LOOP"] },
      ]),
    );
    expect(warnings.join(" ")).toContain("emitted inside the workflow");
  });
});
