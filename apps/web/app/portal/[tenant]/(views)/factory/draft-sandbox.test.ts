import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";

import {
  draftSandboxTestTemplate,
  parseDraftSandboxSubmission,
  readDraftSandboxFinishReceipt,
  readDraftSandboxInputContract,
  readDraftSandboxReview,
  sandboxChallengeRef,
  type DraftSandboxChallenge,
  type DraftSandboxInputContract,
} from "./draft-sandbox";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

const scope = {
  tenantId: "ten-one",
  tenantSlug: "tenant-one",
  domain: "domain-one",
  slug: "resume-agent",
  versionId: "v-patched-one",
};
const expected = {
  tenantSlug: scope.tenantSlug,
  domain: scope.domain,
  slug: scope.slug,
  versionId: scope.versionId,
};

function inputContract(): DraftSandboxInputContract {
  return {
    schema: "agent-factory-draft-sandbox-input/v1",
    scope,
    specsCount: 2,
    entryEvents: [{
      event: "RESUME_RECEIVED",
      fields: [
        { name: "candidate_id", type: "string", required: true, targetObject: "Candidate" },
        { name: "attempts", type: "integer" },
      ],
    }],
    unresolvedBoundaries: [{ event: "INTERVIEW_REQUESTED", producers: ["inviteInterview"] }],
    testKinds: ["pass", "reject", "edge", "fault"],
    note: "请填写人工确认的数据。",
  };
}

function challenge(): DraftSandboxChallenge {
  const digest = "a".repeat(64);
  const token = `authorize_sandbox_design_review:v1:${digest}`;
  return {
    id: "fac-review-one",
    kind: "sandbox_design_review",
    protocolVersion: 1,
    digest,
    subjectDigest: "b".repeat(64),
    token,
    question: "是否批准这个不可变版本进入一次临时沙箱？",
    context: `sandbox_design_review_authorization:v1:${digest}`,
    options: [
      { label: "需要修改", value: `decline_sandbox_design_review:v1:${digest}`, recommended: true },
      { label: "批准一次沙箱", value: token, recommended: false },
    ],
    runId: "draft-sandbox-run-one",
    conversationId: "draft-sandbox-run-one",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("Factory draft sandbox input", () => {
  it("binds the server contract to the exact patched version and creates placeholders, not evidence", () => {
    const read = readDraftSandboxInputContract(t, inputContract(), expected);
    expect(read).toMatchObject({ ok: true, data: { scope, specsCount: 2 } });
    expect(readDraftSandboxInputContract(t, inputContract(), { ...expected, versionId: "v-other" })).toMatchObject({ ok: false });

    const template = JSON.parse(draftSandboxTestTemplate(t, inputContract()));
    expect(template).toEqual([expect.objectContaining({
      entryEvent: "RESUME_RECEIVED",
      payload: { candidate_id: "请填写真实测试值（string）", attempts: "请填写真实测试值（integer）" },
    })]);
    expect(parseDraftSandboxSubmission(t, JSON.stringify(template), "[]")).toMatchObject({
      ok: false,
      message: expect.stringContaining("模板占位"),
    });
  });

  it("rejects literal credentials but permits JSON-Pointer business fields and env references", () => {
    const base = [{
      id: "manual-1",
      name: "正常路径",
      scenario: "测试正常路径",
      kind: "pass",
      entryEvent: "RESUME_RECEIVED",
      payload: { candidate_id: "candidate-1", "~key": "business-value", authHeaderEnv: "AUTH_HEADER_ENV" },
      expectedOutcome: "成功",
    }];
    expect(parseDraftSandboxSubmission(t, JSON.stringify(base), "[]")).toMatchObject({ ok: true });
    expect(parseDraftSandboxSubmission(t, JSON.stringify([{ ...base[0], payload: { authHeader: "literal-auth-value" } }]), "[]")).toMatchObject({ ok: false });
    expect(parseDraftSandboxSubmission(t, JSON.stringify([{ ...base[0], payload: { key: "literal-signing-value" } }]), "[]")).toMatchObject({ ok: false });
  });
});

describe("Factory draft sandbox review and finish receipts", () => {
  it("accepts one exact review challenge and sends only its immutable reference at finish", () => {
    const review = {
      schema: "agent-factory-draft-sandbox-review/v1",
      scope,
      fingerprint: `sandbox-evidence:v6:${"c".repeat(64)}`,
      specsCount: 2,
      testCoverage: { required: ["happy:RESUME_RECEIVED"], covered: ["happy:RESUME_RECEIVED"], backfilled: [], uncoveredNeedingData: [] },
      testCases: [{ id: "manual-1", payload: { candidate_id: "candidate-1", "~1key": "business-value" } }],
      boundaryEvents: [{ event: "INTERVIEW_REQUESTED", kind: "external" }],
      challenge: challenge(),
    };
    expect(readDraftSandboxReview(t, review, expected)).toMatchObject({ ok: true });
    expect(readDraftSandboxReview(t, { ...review, scope: { ...scope, versionId: "v-stale" } }, expected)).toMatchObject({ ok: false });
    expect(readDraftSandboxReview(t, {
      ...review,
      challenge: { ...challenge(), options: challenge().options.map((option) => ({ ...option, recommended: false })) },
    }, expected)).toMatchObject({ ok: false });

    const ref = sandboxChallengeRef(challenge());
    expect(ref).not.toHaveProperty("token");
    expect(ref).not.toHaveProperty("question");
    expect(ref).not.toHaveProperty("context");
    expect(ref).not.toHaveProperty("options");
  });

  it("requires a fresh version plus verified cleanup and a completed regression replay", () => {
    const receipt = {
      schema: "agent-factory-draft-sandbox-finish/v1",
      scope: { ...scope, versionId: "v-sandboxed-two", baseVersionId: scope.versionId },
      baseVersionId: scope.versionId,
      versionId: "v-sandboxed-two",
      regressionReady: true,
      diagnosticOnly: false,
      qualification: "promotable",
      fingerprint: `sandbox-evidence:v6:${"d".repeat(64)}`,
      sandbox: {
        appId: "factory-test-af-sbx-one",
        attemptId: "attempt-one",
        cleanupVerified: true,
        functionsRegistered: 2,
        agentsRan: 2,
        qualification: "promotable",
        isolationTier: "remote_vm",
      },
      regressionReplay: { pass: true, suiteFingerprint: "suite-one", results: 2 },
    };
    const finishScope = { tenantSlug: scope.tenantSlug, domain: scope.domain, slug: scope.slug, baseVersionId: scope.versionId };
    expect(readDraftSandboxFinishReceipt(t, receipt, finishScope)).toMatchObject({ ok: true });
    expect(readDraftSandboxFinishReceipt(t, { ...receipt, versionId: scope.versionId }, finishScope)).toMatchObject({ ok: false });
    expect(readDraftSandboxFinishReceipt(t, { ...receipt, sandbox: { ...receipt.sandbox, cleanupVerified: false } }, finishScope)).toMatchObject({ ok: false });
    expect(readDraftSandboxFinishReceipt(t, { ...receipt, regressionReplay: { ...receipt.regressionReplay, results: 0 } }, finishScope)).toMatchObject({ ok: false });
  });

  it("accepts a persisted same-host diagnostic without treating it as a fresh regression version", () => {
    const receipt = {
      schema: "agent-factory-draft-sandbox-finish/v1",
      scope: {
        ...scope,
        versionId: scope.versionId,
        baseVersionId: scope.versionId,
      },
      baseVersionId: scope.versionId,
      versionId: scope.versionId,
      regressionReady: false,
      diagnosticOnly: true,
      qualification: "development_only",
      fingerprint: `sandbox-evidence:v6:${"e".repeat(64)}`,
      sandbox: {
        appId: "factory-test-af-sbx-diagnostic",
        attemptId: "attempt-diagnostic",
        cleanupVerified: true,
        functionsRegistered: 2,
        agentsRan: 2,
        qualification: "development_only",
        isolationTier: "same_host_container",
      },
      diagnosticEvidence: {
        schema: "agent-factory-draft-sandbox-diagnostic/v1",
        receiptId: "review-diagnostic",
        persisted: true,
        promotionBlockers: ["Independent execution plane is still required."],
      },
      regressionReplay: {
        pass: false,
        skipped: true,
        reason: "development-only diagnostic",
      },
    };
    const finishScope = {
      tenantSlug: scope.tenantSlug,
      domain: scope.domain,
      slug: scope.slug,
      baseVersionId: scope.versionId,
    };
    expect(
      readDraftSandboxFinishReceipt(t, receipt, finishScope),
    ).toMatchObject({
      ok: true,
      data: {
        regressionReady: false,
        diagnosticOnly: true,
        qualification: "development_only",
      },
    });
    expect(readDraftSandboxFinishReceipt(
      t,
      {
        ...receipt,
        qualification: "promotable",
      },
      finishScope,
    )).toMatchObject({ ok: false });
  });
});
