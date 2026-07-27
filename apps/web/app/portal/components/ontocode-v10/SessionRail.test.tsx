import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionRowVM } from "./projection";
import { SessionRail } from "./SessionRail";

const ROWS: SessionRowVM[] = [
  {
    id: "ocs-aaaa",
    title: "候选人筛选套件",
    tone: "run",
    label: "进行中",
    sub: "正在生成代码",
    needsAttention: 0,
    updatedAt: 1,
  },
  {
    id: "ocs-bbbb",
    title: "简历解析优化",
    tone: "warn",
    label: "等你决定",
    sub: "解析失败兜底策略",
    needsAttention: 1,
    updatedAt: 2,
  },
];

function render(overrides: Partial<React.ComponentProps<typeof SessionRail>> = {}) {
  return renderToStaticMarkup(
    <SessionRail
      businessDomainLabel="招聘"
      ontologyDomainLabel="RAAS-v1"
      snapshotShort="a1b2c3"
      sessions={ROWS}
      activeSessionId="ocs-aaaa"
      onSelectSession={() => {}}
      onCreateSession={() => {}}
      onOpenSettings={() => {}}
      {...overrides}
    />,
  );
}

describe("SessionRail", () => {
  it("renders real session rows with human-language status", () => {
    const html = render();
    expect(html).toContain("候选人筛选套件");
    expect(html).toContain("等你决定");
    expect(html).toContain("正在生成代码");
    expect(html).toContain("RAAS-v1");
    expect(html).toContain("a1b2c3");
  });

  it("marks attention rows with a badge", () => {
    const html = render();
    expect(html).toContain("sBadge");
  });

  it("shows create-first empty state when there are no sessions", () => {
    const html = render({ sessions: [], activeSessionId: null });
    expect(html).toContain("新建 Session");
    expect(html).toContain("业务目标");
  });

  it("highlights the active session row", () => {
    const html = render({ activeSessionId: "ocs-aaaa" });
    expect(html).toContain("sItemOn");
    const inactive = render({ activeSessionId: null });
    expect(inactive).not.toContain("sItemOn");
  });
});
