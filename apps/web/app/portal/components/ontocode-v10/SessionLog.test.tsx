import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import { eventLabel, ReasoningFlowView, SessionLogView } from "./SessionLog";
import { SystemConnectionsView, connectionStage } from "./SystemConnections";
import type { SystemCoverageItem } from "@/lib/hooks/useOntoCodeWorkspace";
import { PreferencesProvider } from "@/app/portal/lib/preferences-context";

/** SystemConnectionsView renders a HelpTip, which reads i18n preferences. */
function renderWithPrefs(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <PreferencesProvider>{node}</PreferencesProvider>,
  );
}

const NOW = 1_753_600_000_000;

function msg(overrides: Partial<OntoCodeMessage> = {}): OntoCodeMessage {
  return {
    id: "ocm-1",
    tenantId: "t",
    sessionId: "s",
    role: "user",
    type: "text",
    content: { text: "生成 agents" },
    commandId: null,
    correlationId: "cor-1",
    idempotencyKey: null,
    createdAt: NOW,
    ...overrides,
  } as OntoCodeMessage;
}

function evt(overrides: Partial<OntoCodeSessionEvent> = {}): OntoCodeSessionEvent {
  return {
    id: "oce-1",
    seq: 1,
    tenantId: "t",
    projectId: "p",
    sessionId: "s",
    harnessJobId: "ocj-1",
    commandId: null,
    correlationId: "cor-1",
    causationId: null,
    type: "harness.ontology_analysis.plan",
    visibility: "user",
    payload: { counts: { objects: 49, links: 580 } },
    createdAt: NOW + 1000,
    ...overrides,
  } as OntoCodeSessionEvent;
}

function job(overrides: Partial<OntoCodeHarnessJob> = {}): OntoCodeHarnessJob {
  return {
    id: "ocj-1",
    tenantId: "t",
    sessionId: "s",
    commandId: null,
    runtimeProfileVersionId: null,
    kind: "ontology_analysis",
    status: "succeeded",
    inputHash: null,
    budget: null,
    candidatePackageVersionId: null,
    candidateDependencyRoot: null,
    candidateHeadId: null,
    candidateHeadRevision: null,
    testCases: [],
    idempotencyKey: "i",
    errorMessage: null,
    createdBy: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 5000,
    updatedAt: NOW + 5000,
    ...overrides,
  } as OntoCodeHarnessJob;
}

describe("eventLabel", () => {
  it("translates known types and keeps unknown ones visible", () => {
    expect(eventLabel("harness.job.waiting_user")).toBe("等待你回答");
    expect(eventLabel("harness.ontology_analysis.plan")).toContain("读取结构");
    expect(eventLabel("harness.build.stage")).toBe("阶段进展");
    // an unmapped type must not be silently swallowed
    expect(eventLabel("some.future.event")).toBe("some.future.event");
  });
});

describe("SessionLogView", () => {
  it("interleaves messages and events in time order", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[msg(), msg({ id: "ocm-2", role: "assistant", content: { text: "好的" }, createdAt: NOW + 2000 })]}
        events={[evt()]}
        jobs={[job()]}
      />,
    );
    expect(html).toContain("生成 agents");
    expect(html).toContain("好的");
    expect(html).toContain("读取结构");
    expect(html).toContain("2 条消息");
    // real counts, and payload rendered as a readable summary not raw JSON
    expect(html).toContain("objects 49");
    expect(html).not.toContain('{"counts"');
  });

  it("hides debug events until asked", () => {
    const html = renderToStaticMarkup(
      <SessionLogView
        messages={[]}
        events={[evt({ visibility: "debug", type: "harness.job.leased" })]}
        jobs={[]}
      />,
    );
    expect(html).toContain("显示全部");
    expect(html).not.toContain("作业领取");
  });

  it("shows an honest empty state", () => {
    const html = renderToStaticMarkup(
      <SessionLogView messages={[]} events={[]} jobs={[]} />,
    );
    expect(html).toContain("还没有可显示的记录");
  });
});

describe("ReasoningFlowView", () => {
  it("draws one node per job with its real steps", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView
        jobs={[job(), job({ id: "ocj-2", kind: "scope", status: "waiting_user", createdAt: NOW + 10 })]}
        events={[evt()]}
      />,
    );
    expect(html).toContain("Ontology 理解");
    expect(html).toContain("范围分析");
    expect(html).toContain("等你回答");
    expect(html).toContain("读取结构");
  });

  it("explains itself when nothing has run", () => {
    const html = renderToStaticMarkup(
      <ReasoningFlowView jobs={[]} events={[]} />,
    );
    expect(html).toContain("还没有执行过任何推理步骤");
  });
});

function sys(overrides: Partial<SystemCoverageItem> = {}): SystemCoverageItem {
  return {
    system: "GoHire_System",
    referencedByActions: ["processResume", "matchResume"],
    referencedVia: ["ontology"],
    profileId: "gohire-system",
    humanBoundary: false,
    runtimeProvided: false,
    hasTool: true,
    credentialProvider: "gohire",
    credentialConfigured: false,
    probeOk: null,
    probeAt: null,
    availability: "live",
    plannedFallback: "block",
    ...overrides,
  };
}

describe("connectionStage", () => {
  it("ranks maturity from runtime down to unprofiled", () => {
    expect(connectionStage(sys({ runtimeProvided: true }))).toBe("runtime");
    expect(connectionStage(sys({ credentialConfigured: true, probeOk: true }))).toBe("verified");
    expect(connectionStage(sys({ credentialConfigured: true }))).toBe("configured");
    expect(connectionStage(sys({ humanBoundary: true, credentialProvider: null }))).toBe("boundary");
    expect(connectionStage(sys())).toBe("needsCredential");
    expect(connectionStage(sys({ credentialProvider: null }))).toBe("needsProfile");
  });
});

describe("SystemConnectionsView", () => {
  it("lists every referenced system, not just the blocking one", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="Agents-generation"
        rows={[
          sys(),
          sys({
            system: "Internal_Recruitment_System",
            credentialProvider: null,
            profileId: null,
            referencedByActions: ["processResume"],
          }),
          sys({ system: "LLM_Gateway", runtimeProvided: true }),
        ]}
        totals={{ referenced: 3, profiled: 1, humanBoundary: 0, unprofiled: 1 }}
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
      />,
    );
    expect(html).toContain("GoHire_System");
    expect(html).toContain("Internal_Recruitment_System");
    expect(html).toContain("LLM_Gateway");
    expect(html).toContain("配置 gohire →");
    expect(html).toContain("运行时提供");
    expect(html).toContain("标为人工边界");
    expect(html).toContain("3 个系统");
    // the system with no provider offers no fake configure button
    expect(html).toContain("待建档");
  });

  it("reports a coverage failure instead of rendering an empty list", () => {
    const html = renderWithPrefs(
      <SystemConnectionsView
        domainLabel="d"
        rows={[]}
        errorText="无法读取系统连接：403"
        onConfigure={() => {}}
        onProbe={() => {}}
        onMarkBoundary={() => {}}
      />,
    );
    expect(html).toContain("403");
  });
});
