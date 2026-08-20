import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OntoCodeOntologyFreshness } from "@agentic/contracts";
import { PreferencesProvider } from "@/app/portal/lib/preferences-context";
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
    // 快照哈希不再在默认视图重复出现——只留锁定状态
    expect(html).toContain("已锁定");
    expect(html).not.toContain("a1b2c3");
  });

  it("marks attention rows with a badge", () => {
    const html = render();
    expect(html).toContain("sBadge");
  });

  it("shows create-first empty state when there are no sessions", () => {
    const html = render({ sessions: [], activeSessionId: null });
    expect(html).toContain("＋ 新建");
    expect(html).toContain("暂无会话");
  });

  it("highlights the active session row", () => {
    const html = render({ activeSessionId: "ocs-aaaa" });
    expect(html).toContain("sItemOn");
    const inactive = render({ activeSessionId: null });
    expect(inactive).not.toContain("sItemOn");
  });
});

function freshness(
  overrides: Partial<OntoCodeOntologyFreshness> = {},
): OntoCodeOntologyFreshness {
  return {
    schema: "ontocode-ontology-freshness/v1",
    sessionSnapshotHash: "2c5d9d85aa",
    status: "current",
    currentHash: "2c5d9d85aa",
    servedBy: "allmeta",
    shadowed: false,
    checkedAt: 1_700_000_000_000,
    reason: null,
    ...overrides,
  };
}

/** 「无法核对」会渲染 HelpTip，而 HelpTip 读 i18n preferences。 */
function renderWithPrefs(
  overrides: Partial<React.ComponentProps<typeof SessionRail>> = {},
): string {
  return renderToStaticMarkup(
    <PreferencesProvider>
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
      />
    </PreferencesProvider>,
  );
}

describe("SessionRail 本体来源/新鲜度芯片", () => {
  it("没有测量结果时保持今天的「已锁定」，不假装核对过", () => {
    const html = render({ ontologyFreshness: null });
    expect(html).toContain("已锁定");
    expect(html).not.toContain("无法核对");
    expect(html).not.toContain("最新");
  });

  it("current 时说出真正作答的来源，且不泄漏哈希", () => {
    const html = render({ ontologyFreshness: freshness() });
    expect(html).toContain("Allmeta · 最新");
    expect(html).not.toContain("已锁定");
    expect(html).not.toContain("2c5d9d85aa");
  });

  it("上传件覆盖是 FDE 今天完全看不见的那一格——必须写在标签上", () => {
    const html = renderWithPrefs({
      ontologyFreshness: freshness({ servedBy: "upload", shadowed: true }),
    });
    expect(html).toContain("上传件覆盖");
    expect(html).not.toContain("最新");
  });

  it("changed 时给出既有恢复路径：点击即走新建会话", () => {
    const html = renderWithPrefs({
      ontologyFreshness: freshness({ status: "changed", currentHash: "9f00" }),
    });
    expect(html).toContain("本体已更新");
    // 芯片本身是可点的控件，而不是一段说明文字
    expect(html).toMatch(/<button[^>]*ontoChip/);
    expect(html).not.toContain("9f00");
  });

  it("unavailable 时说无法核对，原因只留在 HelpTip 里，不铺成正文", () => {
    const html = renderWithPrefs({
      ontologyFreshness: freshness({
        status: "unavailable",
        currentHash: null,
        servedBy: null,
        reason: "allmeta_fetch_failed: connect ECONNREFUSED 127.0.0.1:3500",
      }),
    });
    expect(html).toContain("无法核对");
    expect(html).toContain("help-tip");
    // 原因是 HelpTip 的 aria-label / 悬浮内容，绝不是常驻正文
    expect(html).toContain(
      "aria-label=\"allmeta_fetch_failed: connect ECONNREFUSED 127.0.0.1:3500",
    );
    expect(html).not.toContain("<div>allmeta_fetch_failed");
  });

  it("任何状态下常驻文案都是短词——解释只活在 HelpTip 的 aria-label / 悬浮层里", () => {
    for (const f of [
      freshness(),
      freshness({ servedBy: "upload", shadowed: true }),
      freshness({ status: "changed", currentHash: "9f00" }),
      freshness({
        status: "unavailable",
        currentHash: null,
        servedBy: null,
        reason: "allmeta_fetch_failed",
      }),
    ]) {
      const html = renderWithPrefs({ ontologyFreshness: f });
      // 去掉 HelpTip 的 aria-label 后，剩下的常驻文本里不许有解释性长句
      const visible = html.replace(/aria-label="[^"]*"/g, "");
      expect(visible).not.toContain("这个会话");
      expect(visible).not.toContain("；");
      expect(visible).not.toContain("。");
      expect(visible).not.toContain("2c5d9d85aa");
    }
  });
});

describe("SessionRail delete affordance", () => {
  it("renders a delete control per session when the handler is provided", () => {
    const html = render({ onDeleteSession: () => {} });
    expect(html).toContain("sItemDelete");
    expect(html).toContain("删除 候选人筛选套件");
  });

  it("omits the delete control when no handler is provided", () => {
    const html = render();
    expect(html).not.toContain("sItemDelete");
  });

  it("disables the row being deleted", () => {
    const html = render({
      onDeleteSession: () => {},
      deletingSessionId: "ocs-aaaa",
    });
    expect(html).toContain("disabled");
  });
});
