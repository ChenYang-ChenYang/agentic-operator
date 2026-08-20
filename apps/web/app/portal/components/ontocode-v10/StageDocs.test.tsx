import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { classifyStageDoc, StageDocView } from "./StageDocs";
import { PreferencesProvider } from "@/app/portal/lib/preferences-context";

/** StageDocView renders HelpTip (deliberation), which reads i18n preferences. */
function renderDoc(node: React.ReactElement): string {
  return renderToStaticMarkup(<PreferencesProvider>{node}</PreferencesProvider>);
}

describe("classifyStageDoc", () => {
  it("classifies scope and blueprint receipts, ignores others", () => {
    expect(classifyStageDoc("harness/scope/ocj-1/receipt.json")).toBe("scope");
    expect(classifyStageDoc("harness/blueprint/ocj-2/receipt.json")).toBe(
      "blueprint",
    );
    expect(classifyStageDoc("agents/jd-matcher/agent.ts")).toBeNull();
  });
});

describe("StageDocView", () => {
  it("renders scope actions and reasons as a table", () => {
    const scope = JSON.stringify({
      schema: "ontocode-scope-receipt/v1",
      recommendation: {
        actions: [
          { id: "4", name: "createJD", reason: "负责 JD 生成与持久化" },
          { id: "5", name: "processResume", reason: "解析简历并结构化" },
        ],
        reasoningSummary: "覆盖从 JD 生成到简历处理的 6 个 Action。",
        confidence: 1,
      },
    });
    const html = renderDoc(
      <StageDocView kind="scope" content={scope} loading={false} />,
    );
    expect(html).toContain("createJD");
    expect(html).toContain("负责 JD 生成与持久化");
    expect(html).toContain("processResume");
    expect(html).toContain("覆盖从 JD 生成");
    expect(html).toContain("置信度 100%");
    expect(html).toContain("<table");
  });

  it("renders blueprint phases (agent + intent) as a table", () => {
    const bp = JSON.stringify({
      schema: "ontocode-blueprint-receipt/v1",
      model: {
        domain: "Agents-generation",
        phases: [
          {
            id: "agent-1-4",
            title: "JD 生成",
            intent: "订阅需求登记事件并生成标准化 JD",
            anchors: [{ id: "4", kind: "action" }],
            deliberation: "以权威 Action 作为职责边界。",
            steps: [
              {
                label: "生成并验证 JD",
                agent: "createJD",
                reads: ["Job_Requisition"],
                writes: ["Job_Posting"],
                emits: ["JD_CREATED"],
                anchors: [
                  { id: "4", kind: "action" },
                  { id: "JD_CREATED", kind: "event" },
                ],
              },
            ],
          },
        ],
        unresolved: [],
      },
    });
    const html = renderDoc(
      <StageDocView kind="blueprint" content={bp} loading={false} />,
    );
    expect(html).toContain("createJD");
    expect(html).toContain("JD 生成");
    expect(html).toContain("订阅需求登记事件");
    expect(html).toContain("生成并验证 JD");
    expect(html).toContain("读取 Job_Requisition");
    expect(html).toContain("写入 Job_Posting");
    expect(html).toContain("发出 JD_CREATED");
    // 原始锚点降级为 hover（title），事实仍在 DOM
    expect(html).toContain("依据 action:4、event:JD_CREATED");
    // 设计说明降级进 HelpTip，内容保留
    expect(html).toContain("以权威 Action 作为职责边界");
    expect(html).toContain("Agents-generation");
    expect(html).not.toContain("发送「继续」");
    expect(html).toContain("<table");
  });

  it("renders server-selected Analyst metrics, tables, lists and relationships", () => {
    const analysis = JSON.stringify({
      schema: "ontocode-ontology-analysis/v1",
      presentation: {
        schema: "ontocode-analysis-presentation/v1",
        domain: "Agents-generation",
        title: "Agents-generation Ontology 分析",
        request: {
          question: "哪些 Action 依赖外部系统？",
          focus: ["tools", "events"],
          preferredViews: ["table", "relationship"],
        },
        blocks: [
          {
            id: "overview",
            title: "Domain 概览",
            kind: "metrics",
            evidence: ["ontology_structure"],
            items: [
              {
                id: "objects",
                label: "Objects",
                value: 49,
                tone: "positive",
              },
            ],
          },
          {
            id: "dependencies",
            title: "外部系统与工具依赖",
            kind: "table",
            evidence: ["ontology_structure", "live_probe"],
            columns: [
              { key: "action", label: "Action", dataType: "text" },
              { key: "status", label: "状态", dataType: "status" },
              { key: "tools", label: "Tools", dataType: "tags" },
            ],
            rows: [
              {
                action: "createJD",
                status: "needs_config",
                tools: ["generateJdApi"],
              },
            ],
            totalRows: 1,
            truncated: false,
          },
          {
            id: "risks",
            title: "异常、缺口与限制",
            kind: "list",
            evidence: ["live_probe"],
            items: [
              {
                id: "risk-1",
                title: "待配置",
                detail: "GoHire profile 尚未验证",
                severity: "warning",
                refs: ["createJD"],
              },
            ],
            totalItems: 1,
            truncated: false,
          },
          {
            id: "graph",
            title: "Ontology 关系图",
            kind: "relationship",
            evidence: ["ontology_structure"],
            nodes: [
              { id: "a", label: "Job Requisition", entityType: "Object" },
              { id: "b", label: "Job Posting", entityType: "Object" },
            ],
            edges: [
              {
                id: "edge-1",
                source: "a",
                target: "b",
                label: "object-fk",
              },
            ],
            totalNodes: 2,
            totalEdges: 1,
            truncated: false,
          },
        ],
      },
    });
    const html = renderDoc(
      <StageDocView kind="analysis" content={analysis} loading={false} />,
    );
    expect(html).not.toContain("ANALYST");
    expect(html).toContain("哪些 Action 依赖外部系统");
    expect(html).toContain("Objects");
    expect(html).toContain("createJD");
    expect(html).toContain("generateJdApi");
    expect(html).toContain("GoHire profile 尚未验证");
    expect(html).toContain("Job Requisition");
    expect(html).toContain("object-fk");
    expect(html).toContain("实时探针");
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("需关注");
    expect(html).toContain("Ontology 关系图 关系");
    expect(html).toContain("Job Requisition 通过 object-fk 指向 Job Posting");
  });

  it("falls back to raw JSON for unknown shapes and shows loading", () => {
    const bad = renderDoc(
      <StageDocView kind="scope" content={"not json"} loading={false} />,
    );
    expect(bad).toContain("not json");
    const loading = renderDoc(
      <StageDocView kind="blueprint" content={null} loading />,
    );
    expect(loading).toContain("加载中");
  });
});
