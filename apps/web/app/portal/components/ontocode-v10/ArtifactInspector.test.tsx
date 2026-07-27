import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeEvidenceRecord,
} from "@agentic/contracts";
import {
  InspectorDetailView,
  InspectorOverviewView,
} from "./ArtifactInspector";

function makeArtifact(overrides: Partial<OntoCodeArtifact> = {}): OntoCodeArtifact {
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

describe("InspectorOverviewView", () => {
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
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("agent.ts");
    expect(html).toContain("候选 v2");
    expect(html).toContain("1 项证据通过");
    expect(html).toContain("1 份执行回执");
    expect(html).not.toContain("receipt.json");
  });

  it("shows a goal-first empty state", () => {
    const html = renderToStaticMarkup(
      <InspectorOverviewView
        candidateLabel={null}
        items={[]}
        evidence={[]}
        onOpen={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain("说一句业务目标");
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
        content={'export const jdMatcher = inngest.createFunction({...});'}
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
});
