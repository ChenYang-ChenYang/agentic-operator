import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { classifyStageDoc, StageDocView } from "./StageDocs";

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
    const html = renderToStaticMarkup(
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
            intent: "订阅需求登记事件并生成标准化 JD",
            anchors: [{ id: "4", kind: "action" }],
            steps: [{ agent: "createJD" }],
          },
        ],
        unresolved: [],
      },
    });
    const html = renderToStaticMarkup(
      <StageDocView kind="blueprint" content={bp} loading={false} />,
    );
    expect(html).toContain("createJD");
    expect(html).toContain("订阅需求登记事件");
    expect(html).toContain("Agents-generation");
    expect(html).toContain("发送「继续」生成 Agent 代码");
    expect(html).toContain("<table");
  });

  it("falls back to raw JSON for unknown shapes and shows loading", () => {
    const bad = renderToStaticMarkup(
      <StageDocView kind="scope" content={"not json"} loading={false} />,
    );
    expect(bad).toContain("not json");
    const loading = renderToStaticMarkup(
      <StageDocView kind="blueprint" content={null} loading />,
    );
    expect(loading).toContain("加载中");
  });
});
