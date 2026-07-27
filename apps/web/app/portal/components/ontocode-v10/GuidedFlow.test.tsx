import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowItemVM } from "./projection";
import { ActionCardView } from "./ActionCards";
import { Composer, GuidedFlow } from "./GuidedFlow";

const ITEMS: FlowItemVM[] = [
  { kind: "user", id: "m1", text: "基于 RAAS-v1 生成整套 agent", at: 1 },
  { kind: "aiText", id: "m2", text: "好的，我会先读取 **Ontology**。", at: 2 },
  { kind: "execGroup", id: "e1", title: "代码生成完成 · 39s", steps: ["planning", "emitting"], at: 3 },
  { kind: "statusLine", id: "s1", text: "正在验证", at: 4 },
];

describe("GuidedFlow", () => {
  it("renders goal, user bubble, markdown ai text, exec group and exactly one status line", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={{ title: "候选人匹配 Agent", chips: ["Ontology 已锁定 · 快照 #a1b2c3"] }}
        items={ITEMS}
        renderCard={() => null}
      />,
    );
    expect(html).toContain("候选人匹配 Agent");
    expect(html).toContain("基于 RAAS-v1 生成整套 agent");
    expect(html).toContain("<strong>Ontology</strong>");
    expect(html).toContain("代码生成完成");
    expect(html.match(/statusLine/g)?.length ?? 0).toBe(1);
  });

  it("shows first-run guidance when the flow is empty", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow goal={null} items={[]} renderCard={() => null} />,
    );
    expect(html).toContain("说一句业务目标");
  });
});

describe("ActionCardView", () => {
  it("renders a config card with deep-link and verify affordances", () => {
    const html = renderToStaticMarkup(
      <ActionCardView
        card={{
          kind: "config",
          refId: "t1",
          title: "配置 RoboHire API 凭证",
          why: "真实 E2E 缺少 candidates.read 权限",
        }}
      />,
    );
    expect(html).toContain("需要配置");
    expect(html).toContain("去配置");
    expect(html).toContain("校验并继续");
    expect(html).toContain("candidates.read");
  });

  it("renders decision options with recommended mark and other-input", () => {
    const html = renderToStaticMarkup(
      <ActionCardView
        card={{
          kind: "decision",
          refId: "q1",
          title: "评分阈值取多少？",
          options: [
            { label: "75（推荐）", value: "75", recommended: true },
            { label: "80", value: "80" },
          ],
          allowOther: true,
        }}
      />,
    );
    expect(html).toContain("需要你拍板");
    expect(html).toContain("✓ 75（推荐）");
    expect(html).toContain("其它");
  });

  it("renders per-system connection rows with provider deep-link actions", () => {
    const html = renderToStaticMarkup(
      <ActionCardView
        card={{
          kind: "config",
          refId: "q2",
          title: "processResume 需要连接这些系统",
          systems: ["GoHire_System", "Internal_Recruitment_System"],
          boundaryEligible: true,
        }}
        systemLinks={[
          {
            system: "GoHire_System",
            provider: "gohire",
            configured: false,
            probeOk: null,
            runtimeProvided: false,
          },
          {
            system: "Internal_Recruitment_System",
            provider: null,
            configured: false,
            probeOk: null,
            runtimeProvided: false,
          },
        ]}
      />,
    );
    // 有 provider 的系统 → 指名配置按钮；没有的 → 诚实说明 + 人工边界兜底
    expect(html).toContain("配置 gohire →");
    expect(html).toContain("暂无连接档案");
    expect(html).toContain("确认人工边界（仅设计稿，不可交付）");
    expect(html).toContain("已配置完成，校验并继续");
  });

  it("renders a configured+verified system as connected", () => {
    const html = renderToStaticMarkup(
      <ActionCardView
        card={{ kind: "config", refId: "q3", title: "连接检查" }}
        systemLinks={[
          {
            system: "GoHire_System",
            provider: "gohire",
            configured: true,
            probeOk: true,
            runtimeProvided: false,
          },
        ]}
      />,
    );
    expect(html).toContain("已配置 · 连接已验证");
    expect(html).toContain("查看/重配 gohire →");
  });

  it("renders authorization card with approve/reject and error text", () => {
    const html = renderToStaticMarkup(
      <ActionCardView
        card={{ kind: "authorization", refId: "c1", title: "写入外部系统需要授权" }}
        errorText="revision 冲突，请刷新"
      />,
    );
    expect(html).toContain("需要授权");
    expect(html).toContain("批准");
    expect(html).toContain("拒绝");
    expect(html).toContain("revision 冲突");
  });
});

describe("Composer", () => {
  it("disables send when empty and shows read-only reason", () => {
    const html = renderToStaticMarkup(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        sending={false}
        disabled
        disabledReason="该 Session 已完成，只读"
        autonomy="copilot"
        onAutonomyChange={() => {}}
        contextTokens={["RAAS-v1"]}
      />,
    );
    expect(html).toContain("该 Session 已完成，只读");
    expect(html).toContain("@ RAAS-v1");
    expect(html).toContain("disabled");
  });
});
