import { describe, expect, it } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import { ControlFailError, CONTROL_FAIL_DEFAULT_CODE, fail } from "./fail";
import { globalToolRegistry, listGlobalTools } from "../registry";

function ctx(args: Record<string, unknown>): ToolContext {
  return {
    agentName: "derivePurchaseSchedule",
    actionName: "control.fail",
    correlationId: "cor-control-1",
    tenantSlug: "procurement-hc-formal",
    event: { name: "PURCHASE_REQUIRED_CONFIRMED", data: args },
    config: {},
  } as ToolContext;
}

describe("control.fail", () => {
  it("always throws, carrying the declared code and the reported reason", async () => {
    const reason = "无法获取业务类型【物资】的阶段周期配置，根据BR-PLAN-01不予推算。";
    await expect(
      fail.handler(ctx({ code: "schedule_blocked", message: reason })),
    ).rejects.toMatchObject({
      name: "ControlFailError",
      code: "schedule_blocked",
      kind: "blocked_outcome",
      // The `<kind>:` prefix is what the runtime's error-fact extractor reads
      // when only the message survives an Inngest step boundary.
      message: `blocked_outcome: ${reason}`,
    });
  });

  it("refuses to invent a reason and falls back to a stable default code", async () => {
    const error = await fail.handler(ctx({ code: "Not A Code", message: "   " })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlFailError);
    expect((error as ControlFailError).code).toBe(CONTROL_FAIL_DEFAULT_CODE);
    expect((error as ControlFailError).message).toMatch(/未提供原因|without a reason/);
  });

  it("is registered globally as a pure compute tool with no effect scope", () => {
    // The registry wraps descriptors with catalog metadata; identity is by name + handler.
    const registered = globalToolRegistry.get("control.fail");
    expect(registered?.name).toBe(fail.name);
    expect(registered?.handler).toBe(fail.handler);
    const entry = listGlobalTools().find((tool) => tool.name === "control.fail");
    expect(entry).toMatchObject({
      category: "control",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
    });
  });
});
