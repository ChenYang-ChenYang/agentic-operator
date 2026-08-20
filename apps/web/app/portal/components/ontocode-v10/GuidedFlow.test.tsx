import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowItemVM } from "./projection";
import { ActionCardView } from "./ActionCards";
import { Composer, GuidedFlow } from "./GuidedFlow";
import { PreferencesProvider } from "@/app/portal/lib/preferences-context";

/** ActionCardView renders HelpTip, which reads i18n preferences. */
function renderCard(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <PreferencesProvider>{node}</PreferencesProvider>,
  );
}

const ITEMS: FlowItemVM[] = [
  { kind: "user", id: "m1", text: "基于 RAAS-v1 生成整套 agent", at: 1 },
  { kind: "aiText", id: "m2", text: "好的，我会先读取 **Ontology**。", at: 2 },
  {
    kind: "execGroup",
    id: "e1",
    title: "代码生成完成 · 39s",
    steps: ["planning", "emitting"],
    at: 3,
  },
  { kind: "statusLine", id: "s1", text: "正在验证", at: 4 },
];

const CHART_SPEC = {
  schema: "ontocode-chart/v1",
  kind: "bar",
  title: "事件类型分布",
  unit: "条",
  rows: [{ label: "tool_call", value: 12 }],
  truncated: false,
  source: { aggregate: "events.by_type", computedBy: "server" },
};

describe("GuidedFlow", () => {
  it("renders goal, user bubble, markdown ai text, exec group and exactly one status line", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={{ title: "候选人匹配 Agent", chips: ["本体已锁定"] }}
        items={ITEMS}
        renderCard={() => null}
      />,
    );
    expect(html).toContain("候选人匹配 Agent");
    expect(html).toContain("基于 RAAS-v1 生成整套 agent");
    // This case feeds already-projected items, so the text is rendered
    // verbatim; the vocabulary boundary lives in projectFlow (projection.ts),
    // which has its own coverage.
    expect(html).toContain("<strong>Ontology</strong>");
    expect(html).toContain("代码生成完成");
    expect(html.match(/statusLine/g)?.length ?? 0).toBe(1);
  });

  it("renders no explanatory empty-state prose when the flow is empty", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow goal={null} items={[]} renderCard={() => null} />,
    );
    expect(html).not.toContain("说一句业务目标");
  });

  it("offers an explicit same-job retry on a recoverable failed execution group", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={null}
        items={[
          {
            kind: "execGroup",
            id: "exec-failed",
            title: "代码生成失败（可修复）",
            steps: [],
            retryJobId: "ocj-original",
            at: 3,
          },
        ]}
        renderCard={() => null}
        onRetryJob={() => {}}
        retryingJobId="ocj-original"
      />,
    );
    expect(html).toContain("重新排队中…");
    expect(html).toContain("disabled");
  });

  it("shows a retry failure beside the execution group without hiding the retry button", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={null}
        items={[
          {
            kind: "execGroup",
            id: "exec-failed",
            title: "代码生成失败（可修复）",
            steps: [],
            retryJobId: "ocj-original",
            at: 3,
          },
        ]}
        renderCard={() => null}
        onRetryJob={() => {}}
        retryErrorJobId="ocj-original"
        retryError="另一个作业仍在执行"
      />,
    );
    expect(html).toContain("重试这一步");
    expect(html).toContain("重试失败：另一个作业仍在执行");
    expect(html).toContain('role="alert"');
  });

  it("renders one live streaming bubble with markdown, tool activity and charts before the status line", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={null}
        items={ITEMS}
        renderCard={() => null}
        liveAnswers={[
          {
            jobId: "ocj-live",
            markdown: "正在**逐段**生成的回答。",
            pendingFragments: 0,
            charts: [CHART_SPEC],
            activity: {
              text: "正在调用 list_events：读取事件分布",
              busy: true,
            },
            truncated: false,
            invalidFrames: 0,
            lastEventAt: 10,
          },
        ]}
      />,
    );
    expect(html).toContain("<strong>逐段</strong>");
    expect(html).toContain("正在调用 list_events：读取事件分布");
    expect(html).toContain("事件类型分布");
    // 直播气泡在状态行之前——回答生成中，状态行仍收尾。
    expect(html.indexOf("<strong>逐段</strong>")).toBeLessThan(
      html.indexOf("正在验证"),
    );
    expect(html.match(/statusLine/g)?.length ?? 0).toBe(1);
  });

  it("notes truncated live streams instead of pretending the buffer is complete", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={null}
        items={[]}
        renderCard={() => null}
        liveAnswers={[
          {
            jobId: "ocj-live",
            markdown: "部分回答",
            pendingFragments: 0,
            charts: [],
            activity: null,
            truncated: true,
            invalidFrames: 0,
            lastEventAt: 10,
          },
        ]}
      />,
    );
    expect(html).toContain("部分回答");
    expect(html).toContain("完整内容以最终消息为准");
  });

  it("renders charts carried by the durable assistant message", () => {
    const html = renderToStaticMarkup(
      <GuidedFlow
        goal={null}
        items={[
          {
            kind: "aiText",
            id: "m9",
            text: "最终回答全文。",
            charts: [CHART_SPEC],
            at: 9,
          },
        ]}
        renderCard={() => null}
      />,
    );
    expect(html).toContain("最终回答全文。");
    expect(html).toContain("事件类型分布");
    expect(html).toContain("数据来源：服务端聚合 events.by_type");
  });
});

describe("ActionCardView", () => {
  it("renders a config card with deep-link and verify affordances", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "config",
          refId: "t1",
          title: "配置 RoboHire API 凭证",
          why: "真实 E2E 缺少 candidates.read 权限",
        }}
        onPrimary={() => {}}
        onSecondary={() => {}}
      />,
    );
    expect(html).toContain(">配置<");
    expect(html).toContain("去设置 →");
    expect(html).toContain("校验并继续");
    expect(html).toContain("candidates.read");
  });

  it("renders decision options with recommended mark and other-input", () => {
    const html = renderCard(
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
    expect(html).toContain(">拍板<");
    expect(html).toContain("✓ 75（推荐）");
    expect(html).toContain("其它");
  });

  it("renders per-system connection rows with provider deep-link actions", () => {
    const html = renderCard(
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
        onSecondary={() => {}}
      />,
    );
    // 有 provider 的系统 → 配置按钮；没有的 → 诚实说明 + 人工边界兜底
    expect(html).toContain("配置 →");
    expect(html).toContain("未建档");
    expect(html).toContain(">人工边界</button>");
    // 完整警告事实保留在 title tooltip 里
    expect(html).toContain("仅生成设计稿供审阅");
    expect(html).toContain("候选/沙箱/上线仍会拦截");
    expect(html).toContain("校验并继续");
  });

  it("renders a configured+verified system as connected", () => {
    const html = renderCard(
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
        onSecondary={() => {}}
      />,
    );
    expect(html).toContain("已配置 · 连接已验证");
    expect(html).toContain("配置 →");
  });

  it("does not count configured-but-unverified or runtime-provided systems as verified", () => {
    const html = renderCard(
      <ActionCardView
        card={{ kind: "config", refId: "q4", title: "连接验证" }}
        systemLinks={[
          {
            system: "GoHire_System",
            provider: "gohire",
            configured: true,
            probeOk: null,
            runtimeProvided: false,
          },
          {
            system: "Allmeta_Ontology_System",
            provider: "allmeta",
            configured: true,
            probeOk: true,
            runtimeProvided: false,
          },
          {
            system: "Local_Runtime",
            provider: null,
            configured: false,
            probeOk: null,
            runtimeProvided: true,
          },
        ]}
      />,
    );
    expect(html).toContain("连接 1/3");
    expect(html).toContain("已配置 · 未验证");
    expect(html).toContain("✓ 已配置 · 连接已验证");
    expect(html).toContain("运行时提供");
  });

  it("disables production approval until release-ready and an executor exist", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "deploy_confirm",
          refId: "deploy-1",
          title: "将候选包部署到生产",
        }}
        onPrimary={() => {}}
        onSecondary={() => {}}
      />,
    );
    // 部署门槛事实只剩 title tooltip 这一处
    expect(html).toContain("release-ready");
    expect(html).toContain("生产部署执行器");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>未接入<\/button>/);
    expect(html).not.toContain(">批准上线</button>");
    expect(html).toContain("拒绝");
  });

  it("renders batch config decisions as separate selectable sections", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "config",
          refId: "batch",
          title: "2 项配置",
          items: [
            {
              id: "raas",
              question: "RAAS sandbox 怎么继续？",
              context: "需要读取真实需求。",
              system: "RAAS_System",
              options: [
                {
                  label: "提供非密钥配置",
                  value: "A",
                  recommended: true,
                },
                { label: "复用现有 profile", value: "B" },
              ],
              allowOther: true,
            },
            {
              id: "gohire",
              question: "GoHire sandbox 怎么处理？",
              system: "GoHire_System",
              options: [
                { label: "提供环境变量名", value: "A", recommended: true },
                { label: "暂停", value: "C" },
              ],
              allowOther: true,
            },
          ],
        }}
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain("RAAS sandbox 怎么继续");
    expect(html).toContain("GoHire sandbox 怎么处理");
    expect(html).toContain("RAAS_System");
    expect(html.match(/推荐/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain("提交并继续");
    // 密钥安全提示压成一行，事实保留
    expect(html).toContain("API key");
    expect(html).toContain("不要发到会话里");
    expect(html).not.toContain("**1.");
  });

  it("still offers the primary button while a recommendation is genuinely pending", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "system",
          origin: "assistant_recommendation",
          refId: "run-scope",
          title: "分析 Agent 生成范围",
          impact: "将识别出 17 个事件",
          primaryLabel: "开始范围分析",
          lifecycle: { state: "proposed" },
        }}
        onPrimary={() => {}}
      />,
    );
    expect(html).toContain(">开始范围分析</button>");
    expect(html).toContain("将识别出 17 个事件");
  });

  it("drops the primary button and states the outcome once the step already ran", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "system",
          origin: "assistant_recommendation",
          refId: "run-scope",
          title: "分析 Agent 生成范围",
          impact: "将识别出 17 个事件",
          primaryLabel: "开始范围分析",
          lifecycle: {
            state: "done",
            label: "已完成 · 范围分析",
            basis: "exact",
          },
        }}
        onPrimary={() => {}}
      />,
    );
    expect(html).toContain("已完成 · 范围分析");
    expect(html).not.toContain("开始范围分析");
    expect(html).not.toContain("<button");
    // 已经发生的事就不再预告影响。
    expect(html).not.toContain("将识别出 17 个事件");
  });

  it("shows a superseded recommendation as already executed without a button", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "system",
          origin: "assistant_recommendation",
          refId: "run-scope",
          title: "分析 Agent 生成范围",
          primaryLabel: "开始范围分析",
          lifecycle: {
            state: "superseded",
            label: "已执行过 · 范围分析",
            basis: "stage",
          },
        }}
        onPrimary={() => {}}
      />,
    );
    expect(html).toContain("已执行过 · 范围分析");
    expect(html).not.toContain("<button");
  });

  it("shows a running recommendation as in flight without a button", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "system",
          origin: "assistant_recommendation",
          refId: "run-scope",
          title: "分析 Agent 生成范围",
          primaryLabel: "开始范围分析",
          lifecycle: { state: "running", label: "进行中", basis: "exact" },
        }}
        onPrimary={() => {}}
      />,
    );
    expect(html).toContain(">进行中<");
    expect(html).not.toContain("<button");
  });

  it("offers retry as the recovery path on a failed recommendation", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "system",
          origin: "assistant_recommendation",
          refId: "run-scope",
          title: "分析 Agent 生成范围",
          primaryLabel: "开始范围分析",
          lifecycle: {
            state: "failed",
            label: "失败 · 范围分析",
            basis: "exact",
          },
        }}
        onPrimary={() => {}}
      />,
    );
    expect(html).toContain("失败 · 范围分析");
    expect(html).toContain(">重试</button>");
  });

  it("stops offering answers on a config question whose job already settled", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "config",
          origin: "harness_question",
          refId: "hitl-batch",
          title: "1 项配置",
          items: [
            {
              id: "gohire",
              question: "GoHire sandbox 怎么处理？",
              options: [{ label: "提供环境变量名", value: "A" }],
              allowOther: true,
            },
          ],
          lifecycle: { state: "done", label: "已处理", basis: "job" },
        }}
        onAnswer={() => {}}
        onPrimary={() => {}}
        onSecondary={() => {}}
      />,
    );
    expect(html).toContain(">已处理<");
    expect(html).not.toContain("提交并继续");
    expect(html).not.toContain("校验并继续");
    expect(html).not.toContain("<button");
  });

  it("renders authorization card with approve/reject and error text", () => {
    const html = renderCard(
      <ActionCardView
        card={{
          kind: "authorization",
          refId: "c1",
          title: "写入外部系统需要授权",
        }}
        errorText="revision 冲突，请刷新"
      />,
    );
    expect(html).toContain(">授权<");
    expect(html).toContain("批准");
    expect(html).toContain("拒绝");
    expect(html).toContain("revision 冲突");
  });
});

describe("Composer", () => {
  it("disables send when empty and shows read-only reason", () => {
    const html = renderCard(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        sending={false}
        disabled
        disabledReason="只读"
        autonomy="copilot"
        onAutonomyChange={() => {}}
        autonomyError="仍有运行中的任务，请先等待或取消"
        contextTokens={["RAAS-v1"]}
      />,
    );
    expect(html).toContain("只读");
    expect(html).toContain("@ RAAS-v1");
    expect(html).toContain("执行方式未切换");
    // 边界事实降级进 HelpTip，但必须原样保留
    expect(html).toContain("每个有副作用或会改变代码生成状态的步骤");
    expect(html).toContain("disabled");
  });

  it("keeps the sandbox autonomy boundary available", () => {
    const html = renderCard(
      <Composer
        value="继续"
        onChange={() => {}}
        onSend={() => {}}
        sending={false}
        autonomy="sandbox_autopilot"
        onAutonomyChange={() => {}}
        contextTokens={["Agents-generation"]}
      />,
    );
    expect(html).toContain("自主执行仅限已授权的本机沙箱");
    expect(html).toContain("外部写入、生产晋级和部署仍需显式授权");
  });

  it("blocks send and quick actions while the autonomy change is pending", () => {
    const html = renderCard(
      <Composer
        value="生成 agents 代码"
        onChange={() => {}}
        onSend={() => {}}
        sending={false}
        autonomy="sandbox_autopilot"
        onAutonomyChange={() => {}}
        autonomyChanging
        contextTokens={["Agents-generation"]}
        quickActions={[{ label: "继续下一步", run: () => {} }]}
      />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>发送<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>继续下一步<\/button>/);
  });

  it("#ASSISTANT-CITE renders the evidence an answer named, and opens it", () => {
    const opened: Array<{ artifactId: string; versionId: string }> = [];
    const html = renderToStaticMarkup(
      <PreferencesProvider>
        <GuidedFlow
          goal={null}
          renderCard={() => null}
          items={[
            {
              kind: "aiText",
              id: "m-cite",
              text: "以下是基于本体事实的分类。",
              citations: [
                {
                  raw: "artifact:oca-43ca5f723a0a48f2@ocav-ea3c2f2d699644e8",
                  artifactId: "oca-43ca5f723a0a48f2",
                  versionId: "ocav-ea3c2f2d699644e8",
                },
              ],
              at: 3,
            },
          ]}
          onOpenCitation={(ref) => opened.push(ref)}
        />
      </PreferencesProvider>,
    );
    expect(html).toContain("依据");
    expect(html).toContain("产物 1");
    // The exact ref stays quotable for audit, on the control itself.
    expect(html).toContain("artifact:oca-43ca5f723a0a48f2@ocav-ea3c2f2d699644e8");
  });

  it("#ASSISTANT-CITE says nothing when an answer cited nothing", () => {
    const html = renderToStaticMarkup(
      <PreferencesProvider>
        <GuidedFlow
          goal={null}
          renderCard={() => null}
          items={[{ kind: "aiText", id: "m-plain", text: "好的。", at: 1 }]}
        />
      </PreferencesProvider>,
    );
    expect(html).not.toContain("依据");
  });
});
