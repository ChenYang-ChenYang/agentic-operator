import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeEvidenceRecord,
  OntoCodeHarnessJob,
  OntoCodeSuiteOverview,
} from "@agentic/contracts";
import {
  buildIsInProgress,
  candidateLabelForBuildState,
  INSPECTOR_TABS,
  InspectorChangesView,
  InspectorDetailView,
  InspectorEvidenceView,
  InspectorOverviewView,
  InspectorTabBar,
  InspectorTestsView,
  isInspectorFullscreenExitKey,
  latestStageDocumentForKind,
  latestStageDocumentRows,
} from "./ArtifactInspector";

function makeArtifact(
  overrides: Partial<OntoCodeArtifact> = {},
): OntoCodeArtifact {
  return {
    id: "oca-1",
    tenantId: "ten-raas",
    projectId: "ocp-1",
    sessionId: "ocs-1",
    logicalName: "agents/jd-matcher/agent.ts",
    kind: "agent_code",
    semanticPath: null,
    createdBy: null,
    createdAt: 1,
    ...overrides,
  } as OntoCodeArtifact;
}

function makeVersion(
  overrides: Partial<OntoCodeArtifactVersion> = {},
): OntoCodeArtifactVersion {
  return {
    id: "ocav-1",
    tenantId: "ten-raas",
    artifactId: "oca-1",
    sessionId: "ocs-1",
    changeSetId: null,
    version: 3,
    blobHash: "b".repeat(64),
    contentType: "text/typescript",
    sizeBytes: 100,
    metadata: {},
    idempotencyKey: "idem-1",
    createdBy: null,
    createdAt: 2,
    ...overrides,
  } as OntoCodeArtifactVersion;
}

const EVIDENCE = [
  {
    id: "ocev-1",
    outcome: "passed",
    summary: "沙箱 6/6 用例通过",
    artifactVersionId: "ocav-1",
  } as unknown as OntoCodeEvidenceRecord,
];

function makeOverview(
  qualification: OntoCodeSuiteOverview["agents"][number]["qualification"],
): OntoCodeSuiteOverview {
  return {
    sessionId: "ocs-1",
    candidate: null,
    agents: [
      {
        name: "processResume",
        executionOwner: "declarative_manifest",
        artifacts: [],
        test: null,
        qualification,
        blocking: null,
      },
    ],
    readiness: { ready: 0, pendingConfig: 0, verifying: 1 },
    generatedAt: 1,
  };
}

describe("OntoCode delivery truth", () => {
  it("distinguishes every Candidate package state from a generated-unverified draft", () => {
    expect(candidateLabelForBuildState("candidate_ready", 2)).toBe(
      "v2 · 待验证",
    );
    expect(candidateLabelForBuildState("verified_candidate", 2)).toBe(
      "v2 · 已验证",
    );
    expect(candidateLabelForBuildState("release_ready", 2)).toBe("v2 · 可发布");
    expect(candidateLabelForBuildState("released", 2)).toBe("v2 · 已发布");
    const draftLabel = candidateLabelForBuildState("generated_unverified");
    // 「未验证」的诚实事实必须保留；草稿绝不冒充候选包。
    expect(draftLabel).toBe("草稿 · 未验证");
    expect(draftLabel).not.toContain("Candidate");
    expect(draftLabel).not.toMatch(/^v\d/);
  });

  it("treats queued, running, leased and retry-scheduled Build jobs as in progress", () => {
    for (const status of [
      "queued",
      "running",
      "leased",
      "retry_scheduled",
    ] as const) {
      expect(buildIsInProgress([{ kind: "build", status }])).toBe(true);
    }
    expect(buildIsInProgress([{ kind: "build", status: "waiting_user" }])).toBe(
      false,
    );
    expect(buildIsInProgress([{ kind: "build", status: "succeeded" }])).toBe(
      false,
    );
    expect(
      buildIsInProgress([{ kind: "ontology_analysis", status: "queued" }]),
    ).toBe(false);
  });
});

describe("InspectorOverviewView", () => {
  // 分析回执落了盘、classifyStageDoc 也认得它，但它以前不在阶段文档表里——
  // 于是整个本体理解跑完之后，FDE 在界面上没有任何入口能读到结论。
  it("offers the Ontology analysis as an openable stage document", () => {
    const opened: string[] = [];
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel="候选 v1"
        items={[
          {
            artifact: makeArtifact({
              id: "oca-a",
              logicalName: "harness/ontology_analysis/ocj-1/receipt.json",
              kind: "harness_receipt",
            }),
            latestVersion: makeVersion({ id: "ocav-a", artifactId: "oca-a" }),
          },
          {
            artifact: makeArtifact({
              id: "oca-s",
              logicalName: "harness/scope/receipt.json",
              kind: "harness_receipt",
            }),
            latestVersion: makeVersion({
              id: "ocav-s",
              artifactId: "oca-s",
              createdAt: 3,
            }),
          },
        ]}
        evidence={EVIDENCE}
        onOpen={() => {}}
        onOpenStageDoc={(kind) => opened.push(kind)}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("本体理解");
    expect(html).toContain("范围分析");
    void opened;
  });

  it("uses the first-class analysis artifact instead of duplicating its harness receipt", () => {
    const receipt = {
      artifact: makeArtifact({
        id: "oca-analysis-receipt",
        logicalName: "harness/ontology_analysis/ocj-1/receipt.json",
        kind: "harness_receipt",
      }),
      latestVersion: makeVersion({
        id: "ocav-analysis-receipt",
        artifactId: "oca-analysis-receipt",
        metadata: { jobId: "ocj-1" },
        createdAt: 6,
      }),
    };
    const firstClass = {
      artifact: makeArtifact({
        id: "oca-analysis",
        logicalName: "analysis/ontology.json",
        kind: "ontology_analysis",
        semanticPath: "/analysis/ontology",
      }),
      latestVersion: makeVersion({
        id: "ocav-analysis",
        artifactId: "oca-analysis",
        metadata: { jobId: "ocj-1" },
        createdAt: 5,
      }),
    };

    expect(latestStageDocumentRows([receipt, firstClass])).toEqual([
      { item: firstClass, kind: "analysis" },
    ]);
    expect(latestStageDocumentRows([firstClass, receipt])).toEqual([
      { item: firstClass, kind: "analysis" },
    ]);

    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        items={[receipt, firstClass]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html.match(/本体理解/g)).toHaveLength(1);
    expect(html).not.toContain("ontology.json");
    expect(html).toContain("1 执行回执");
  });

  it("resolves a direct analysis-open request to the canonical first-class artifact", () => {
    const receipt = {
      artifact: makeArtifact({
        id: "oca-analysis-receipt",
        logicalName: "harness/ontology_analysis/ocj-live/receipt.json",
        kind: "harness_receipt",
      }),
      latestVersion: makeVersion({
        id: "ocav-analysis-receipt",
        artifactId: "oca-analysis-receipt",
        metadata: { jobId: "ocj-live" },
        createdAt: 10,
      }),
    };
    const firstClass = {
      artifact: makeArtifact({
        id: "oca-analysis",
        logicalName: "analysis/ontology.json",
        kind: "ontology_analysis",
      }),
      latestVersion: makeVersion({
        id: "ocav-analysis",
        artifactId: "oca-analysis",
        metadata: { jobId: "ocj-live" },
        createdAt: 10,
      }),
    };

    expect(
      latestStageDocumentForKind([receipt, firstClass], "analysis"),
    ).toEqual({ item: firstClass, kind: "analysis" });
    expect(
      latestStageDocumentForKind([receipt, firstClass], "scope"),
    ).toBeNull();
  });

  it("lists artifacts with short names and folds harness receipts", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel="候选 v2"
        items={[
          { artifact: makeArtifact(), latestVersion: makeVersion() },
          {
            artifact: makeArtifact({
              id: "oca-2",
              logicalName: "harness/scope/receipt.json",
              kind: "harness_receipt",
            }),
            latestVersion: makeVersion({ id: "ocav-2", artifactId: "oca-2" }),
          },
        ]}
        evidence={EVIDENCE}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("agent.ts");
    expect(html).toContain("候选 v2");
    expect(html).toContain("1 证据通过");
    expect(html).toContain("1 执行回执");
    expect(html).not.toContain("receipt.json");
  });

  /**
   * 活库实况：session ocs-0f8ee876b24149a2 的 6 个 agent_code 的 logicalName 只有
   * 目录段不同（agents/<agent>/agent.ts），6 个 agent_spec 同理。只取路径末段会把
   * 六行渲染成同一个 "agent.ts"、副标题同为「代码 · v1」——FDE 无法分辨点开的是哪个
   * agent。文件名必须携带足以区分同名文件的那一段。
   */
  it("keeps same-named artifacts from different agents distinguishable", () => {
    const paths = [
      "agents/agents-gener-match-resume/agent.ts",
      "agents/agents-gener-process-resume/agent.ts",
      "agents/agents-gener-create-jd/agent.ts",
    ];
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        items={paths.map((logicalName, i) => ({
          artifact: makeArtifact({
            id: `oca-${i}`,
            logicalName,
            kind: "agent_code",
          }),
          latestVersion: makeVersion({
            id: `ocav-${i}`,
            artifactId: `oca-${i}`,
          }),
        }))}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    // 每个 agent 的辨识段都必须出现在渲染结果里。
    expect(html).toContain("agents-gener-match-resume");
    expect(html).toContain("agents-gener-process-resume");
    expect(html).toContain("agents-gener-create-jd");
  });

  it("shows the OntoCode alias for the durable factory draft name", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        items={[
          {
            artifact: makeArtifact({
              logicalName: "package/factory-draft.json",
              kind: "agent_code_draft",
            }),
            latestVersion: makeVersion(),
          },
        ]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("ontocode-draft.json");
    expect(html).not.toContain("factory-draft.json");
  });

  it("shows the delivery label without relabeling a draft", () => {
    const candidateHtml = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel="v3 · 已验证"
        candidateStatus="verified_candidate"
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(candidateHtml).toContain("v3 · 已验证");

    const draftHtml = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel="草稿 · 未验证"
        candidateStatus="generated_unverified"
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(draftHtml).toContain("草稿 · 未验证");
    expect(draftHtml).not.toContain("Candidate");
  });

  it("marks development-only evidence amber and never calls it trusted", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        overview={makeOverview("development_only")}
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("开发验证 · 不可晋级");
    expect(html).not.toContain("沙箱可信");
  });

  it("reserves the green trusted label for promotable evidence", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        overview={makeOverview("promotable")}
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("沙箱可信 · 可晋级");
    expect(html).not.toContain("开发验证 · 不可晋级");
  });

  it("shows a terse empty state with no guidance prose", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("暂无产物");
    expect(html).not.toContain("说一句业务目标");
  });

  it("shows live generation state instead of telling the FDE to continue", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        buildInProgress
        items={[
          {
            artifact: makeArtifact({
              id: "oca-blueprint",
              logicalName: "harness/blueprint/receipt.json",
              kind: "harness_receipt",
            }),
            latestVersion: makeVersion({
              id: "ocav-blueprint",
              artifactId: "oca-blueprint",
            }),
          },
        ]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );

    expect(html).toContain("生成中…");
    expect(html).not.toContain("发送「继续」");
  });
});

describe("InspectorDetailView", () => {
  it("renders version pills, content and evidence tab count", () => {
    const html = renderToStaticMarkup(
      <InspectorDetailView
        name="agent.ts"
        kind="agent_code"
        versions={[makeVersion(), makeVersion({ id: "ocav-9", version: 4 })]}
        activeVersionId="ocav-9"
        content={"export const jdMatcher = inngest.createFunction({...});"}
        contentLoading={false}
        evidence={EVIDENCE}
        onSelectVersion={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).toContain("v3");
    expect(html).toContain("v4");
    expect(html).toContain("inngest.createFunction");
    expect(html).toContain("证据 · 1");
    expect(html).toContain("‹ 概览");
  });

  /**
   * 一份 agent.ts 活库里有 46-54KB（约 1300-1800 行）。把它整串塞进一个 <pre>
   * 既没有行号也没有高亮，FDE 只能靠肉眼在无标记的长文里找 tool 调用与 emit。
   * 代码类产物必须给出真正的查看能力：取走全文（复制/下载）、知道规模（行数）。
   * 服务端渲染保持纯文本可读（渐进增强），浏览器里再升级为编辑器。
   */
  it("gives code artifacts real handles: copy, download and size", () => {
    const code = Array.from(
      { length: 120 },
      (_, i) => `// line ${i + 1}`,
    ).join("\n");
    const html = renderToStaticMarkup(
      <InspectorDetailView
        name="agents-gener-match-resume/agent.ts"
        kind="agent_code"
        versions={[makeVersion()]}
        activeVersionId="ocav-1"
        content={code}
        contentLoading={false}
        evidence={[]}
        onSelectVersion={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).toContain("复制");
    expect(html).toContain("下载");
    expect(html).toContain("120 行");
    // 降级路径仍然是可读的纯文本，不是空壳。
    expect(html).toContain("// line 1");
  });
});

describe("session-level inspector destinations", () => {
  it("exposes changes, tests and evidence as real tabs", () => {
    expect(INSPECTOR_TABS.map((tab) => tab.id)).toEqual(
      expect.arrayContaining(["changes", "tests", "evidence"]),
    );
  });

  it("renders persisted semantic changes without claiming a code diff", () => {
    const html = renderToStaticMarkup(
      <InspectorChangesView
        changeSet={
          {
            status: "validated",
            summary: "更新候选筛选规则",
          } as unknown as Parameters<
            typeof InspectorChangesView
          >[0]["changeSet"]
        }
        operations={[
          {
            id: "op-1",
            operation: "replace",
            semanticPath: "/actions/screenCandidate",
            fromSemanticPath: null,
            sourceRefs: ["ontology:screenCandidate"],
            invalidates: ["evidence:old-screening"],
          } as unknown as Parameters<
            typeof InspectorChangesView
          >[0]["operations"][number],
        ]}
      />,
    );
    expect(html).toContain("更新候选筛选规则");
    expect(html).toContain("/actions/screenCandidate");
    expect(html).toContain("替换");
    expect(html).not.toContain("代码差异");
  });

  it("renders all persisted test aggregates and artifactless evidence", () => {
    const overview = makeOverview(null);
    overview.agents[0]!.test = { passed: 3, failed: 1, inconclusive: 2 };
    const testsHtml = renderToStaticMarkup(
      <InspectorTestsView overview={overview} />,
    );
    expect(testsHtml).toContain("3 通过 · 1 失败 · 2 待定");

    const evidenceHtml = renderToStaticMarkup(
      <InspectorEvidenceView
        evidence={[
          {
            id: "ocev-session",
            artifactVersionId: null,
            kind: "sandbox_test",
            outcome: "passed",
            state: "valid",
            summary: "沙箱场景通过",
            createdAt: 3,
          } as unknown as OntoCodeEvidenceRecord,
        ]}
      />,
    );
    expect(evidenceHtml).toContain("沙箱场景通过");
    expect(evidenceHtml).toContain("sandbox test");
  });

  it("humanizes historical evidence kind and summary at the render boundary", () => {
    const html = renderToStaticMarkup(
      <InspectorEvidenceView
        evidence={[
          {
            id: "ocev-old-build-failure",
            artifactVersionId: null,
            harnessJobId: null,
            kind: "harness_build_failure",
            outcome: "failed",
            state: "valid",
            summary:
              "build OntoCode 未能完成：Agent Factory 停在 factory_waiting_checkpoint。",
            createdAt: 3,
          } as unknown as OntoCodeEvidenceRecord,
        ]}
      />,
    );
    expect(html).toContain("代码生成失败记录");
    expect(html).toContain("OntoCode");
    expect(html).toContain("ontocode_build_resume_state_unavailable");
    expect(html).not.toMatch(
      /Agent Factory|\bFactory\b|\bHarness\b|\bfactory_/u,
    );
  });

  it("humanizes a historical test-job failure in both text and hover title", () => {
    const html = renderToStaticMarkup(
      <InspectorTestsView
        jobs={[
          {
            id: "ocj-old-test-failure",
            kind: "test",
            status: "failed_terminal",
            errorMessage:
              "OntoCode 失败：Agent Factory 返回 factory_test_incomplete。",
          } as unknown as OntoCodeHarnessJob,
        ]}
      />,
    );
    expect(html).toContain("OntoCode");
    expect(html).toContain("ontocode_test_incomplete");
    expect(html).not.toMatch(
      /Agent Factory|\bFactory\b|\bHarness\b|\bfactory_/u,
    );
  });
});

/*
 * 全屏以前只挂在「产物」概览的头上——钻进阶段文档就没了，其余七个 tab 从来没有。
 * 控制权移到 tab 栏（检查器外壳）后，每个 tab 都拿得到，包括别人拥有的地图视图。
 */
describe("inspector fullscreen shell", () => {
  it("covers every inspector tab", () => {
    expect(INSPECTOR_TABS.map((tab) => tab.id)).toEqual([
      "artifacts",
      "map",
      "changes",
      "tests",
      "evidence",
      "connections",
      "log",
      "reasoning",
    ]);
  });

  it("offers a labelled, focusable fullscreen button on every tab in both states", () => {
    for (const tab of INSPECTOR_TABS) {
      for (const fullscreen of [false, true]) {
        const html = renderToStaticMarkup(
          <InspectorTabBar
            tabs={INSPECTOR_TABS}
            activeTab={tab.id}
            fullscreen={fullscreen}
            onSelectTab={() => {}}
            onToggleFullscreen={() => {}}
          />,
        );
        const label = fullscreen ? "退出全屏" : "全屏";
        expect(html).toContain(`aria-label="${label}"`);
        expect(html).toContain(`aria-pressed="${String(fullscreen)}"`);
        expect(html).toContain('type="button"');
        expect(html).toContain(tab.label);
      }
    }
  });

  it("keeps internal tab identifiers off the screen", () => {
    const html = renderToStaticMarkup(
      <InspectorTabBar
        tabs={INSPECTOR_TABS}
        activeTab="map"
        fullscreen={false}
        onSelectTab={() => {}}
        onToggleFullscreen={() => {}}
      />,
    );
    for (const tab of INSPECTOR_TABS) {
      expect(html).not.toContain(`>${tab.id}<`);
    }
  });

  it("exits on Esc and on nothing else", () => {
    expect(isInspectorFullscreenExitKey("Escape")).toBe(true);
    expect(isInspectorFullscreenExitKey("Enter")).toBe(false);
    expect(isInspectorFullscreenExitKey("Esc")).toBe(false);
    expect(isInspectorFullscreenExitKey(" ")).toBe(false);
  });
});

describe("blocking reasons are not silently cut", () => {
  it("keeps the whole reason reachable instead of slicing it to a fixed length", () => {
    const overview = makeOverview(null);
    const reason = "GoHire 集成尚未配置，沙箱无法调用 parse-resume 接口";
    overview.agents[0]!.blocking = reason;
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        overview={overview}
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onOpenStageDoc={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain(reason);
    expect(html).toContain(`title="${reason}"`);
  });
});
