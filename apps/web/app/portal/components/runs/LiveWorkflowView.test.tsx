import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveNode } from "./LiveWorkflowView";
import type { DagAgent } from "@/lib/hooks/useAgents";

const copy = (zh: string, _en: string) => zh;

const agent = {
  id: "agt-1",
  kebabId: "approve-adjustment-option",
  name: "approveAdjustmentOption",
  title: "审批调整方案",
  actor: "Human",
  triggers: [],
  emits: [],
  stage: 3,
  recentRunCount: 0,
  isLive: true,
} as DagAgent;

const render = (props: Partial<React.ComponentProps<typeof LiveNode>>) =>
  renderToStaticMarkup(
    <LiveNode
      agent={agent}
      position={{ x: 0, y: 0 }}
      status={undefined}
      waitingCount={0}
      runningCount={0}
      selected={false}
      onSelect={() => undefined}
      copy={copy}
      {...props}
    />,
  );

describe("LiveNode", () => {
  it("is clickable only while it blocks on a person", () => {
    const waiting = render({ status: "waiting_human", waitingCount: 2 });
    expect(waiting).not.toContain("disabled");
    expect(waiting).toContain("待人工 2");
    expect(waiting).toContain("点开处理人工任务");

    for (const status of ["idle", "running", "ok", "failed"] as const) {
      expect(render({ status })).toContain("disabled");
    }
  });

  it("never labels a finished or failed node as idle", () => {
    expect(render({ status: "ok" })).toContain("已完成");
    expect(render({ status: "failed" })).toContain("上次失败");
    expect(render({ status: "running", runningCount: 1 })).toContain("运行中 1");
    // A human step with nothing queued is idle, but says so in its own terms.
    expect(render({ status: "idle" })).toContain("人工节点");
  });

  it("animates only the status dot, so the card does not flicker out", () => {
    const running = render({ status: "running", runningCount: 1 });
    expect(running.match(/animation:pulse/g) ?? []).toHaveLength(1);
    expect(render({ status: "ok" })).not.toContain("animation:pulse");
  });
});
