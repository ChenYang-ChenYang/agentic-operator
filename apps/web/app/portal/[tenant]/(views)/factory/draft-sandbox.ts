import {
  DRAFT_SANDBOX_TEST_SENTINELS,
  findDraftSandboxTestSentinel,
} from "@agentic/contracts";
import type { Translate } from "@/app/portal/lib/preferences-context";

import { draftEditContainsSensitiveData } from "./draft-editor";

export interface DraftSandboxScope {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  slug: string;
  versionId: string;
}

export interface DraftSandboxInputContract {
  schema: "agent-factory-draft-sandbox-input/v1";
  scope: DraftSandboxScope;
  specsCount: number;
  entryEvents: Array<{
    event: string;
    fields: Array<{ name: string; type: string; required?: boolean; targetObject?: string }>;
  }>;
  unresolvedBoundaries: Array<{ event: string; producers: string[] }>;
  testKinds: Array<"pass" | "reject" | "edge" | "fault">;
  note: string;
}

export interface DraftSandboxChallenge {
  id: string;
  kind: "sandbox_design_review";
  protocolVersion: number;
  digest: string;
  subjectDigest: string;
  token: string;
  question: string;
  context: string;
  options: Array<{ label: string; value: string; recommended: boolean }>;
  runId: string;
  conversationId: string;
  expiresAt: string;
}

export interface DraftSandboxReview {
  schema: "agent-factory-draft-sandbox-review/v1";
  scope: DraftSandboxScope;
  fingerprint: string;
  specsCount: number;
  testCoverage: {
    required: string[];
    covered: string[];
    backfilled: string[];
    uncoveredNeedingData: string[];
  };
  testCases: Array<Record<string, unknown>>;
  boundaryEvents: Array<Record<string, unknown>>;
  challenge: DraftSandboxChallenge;
}

interface DraftSandboxFinishReceiptBase {
  schema: "agent-factory-draft-sandbox-finish/v1";
  scope: DraftSandboxScope & { baseVersionId: string };
  baseVersionId: string;
  versionId: string;
  fingerprint: string;
  sandbox: {
    appId: string;
    attemptId: string;
    cleanupVerified: true;
    functionsRegistered: number;
    agentsRan: number;
    qualification: "development_only" | "promotable";
    isolationTier: "same_host_container" | "remote_container" | "remote_vm";
  };
}

export interface DraftSandboxPromotableFinishReceipt
  extends DraftSandboxFinishReceiptBase {
  regressionReady: true;
  diagnosticOnly: false;
  qualification: "promotable";
  regressionReplay: {
    pass: true;
    suiteFingerprint: string;
    results: number;
  };
}

export interface DraftSandboxDiagnosticFinishReceipt
  extends DraftSandboxFinishReceiptBase {
  regressionReady: false;
  diagnosticOnly: true;
  qualification: "development_only";
  diagnosticEvidence: {
    schema: "agent-factory-draft-sandbox-diagnostic/v1";
    receiptId: string;
    persisted: true;
    promotionBlockers: string[];
  };
  regressionReplay: {
    pass: false;
    skipped: true;
    reason: string;
  };
}

export type DraftSandboxFinishReceipt =
  | DraftSandboxPromotableFinishReceipt
  | DraftSandboxDiagnosticFinishReceipt;

export type DraftSandboxValidation<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function exactScope(value: unknown, expected: Omit<DraftSandboxScope, "tenantId">): value is DraftSandboxScope {
  return isRecord(value)
    && typeof value.tenantId === "string" && Boolean(value.tenantId)
    && value.tenantSlug === expected.tenantSlug
    && value.domain === expected.domain
    && value.slug === expected.slug
    && value.versionId === expected.versionId;
}

export function readDraftSandboxInputContract(
  t: Translate,
  value: unknown,
  expected: Omit<DraftSandboxScope, "tenantId">,
): DraftSandboxValidation<DraftSandboxInputContract> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-sandbox-input/v1" || !exactScope(value.scope, expected)) {
    return { ok: false, message: t("factory.draftSandbox.error.inputContractWrongVersion") };
  }
  if (!Number.isInteger(value.specsCount) || Number(value.specsCount) < 1 || !Array.isArray(value.entryEvents) || !Array.isArray(value.unresolvedBoundaries)) {
    return { ok: false, message: t("factory.draftSandbox.error.inputContractIncomplete") };
  }
  const entries = value.entryEvents.map((entry) => {
    if (!isRecord(entry) || typeof entry.event !== "string" || !entry.event || !Array.isArray(entry.fields)) return null;
    const fields = entry.fields.map((field) => {
      if (!isRecord(field) || typeof field.name !== "string" || !field.name || typeof field.type !== "string") return null;
      return {
        name: field.name,
        type: field.type,
        ...(typeof field.required === "boolean" ? { required: field.required } : {}),
        ...(typeof field.targetObject === "string" ? { targetObject: field.targetObject } : {}),
      };
    });
    return fields.some((field) => !field) ? null : { event: entry.event, fields: fields as DraftSandboxInputContract["entryEvents"][number]["fields"] };
  });
  const boundaries = value.unresolvedBoundaries.map((boundary) =>
    isRecord(boundary) && typeof boundary.event === "string" && boundary.event && isStringArray(boundary.producers)
      ? { event: boundary.event, producers: [...boundary.producers] }
      : null);
  if (entries.some((entry) => !entry) || boundaries.some((boundary) => !boundary)) {
    return { ok: false, message: t("factory.draftSandbox.error.inputContractBadFields") };
  }
  const kinds = value.testKinds;
  if (!Array.isArray(kinds) || !["pass", "reject", "edge", "fault"].every((kind) => kinds.includes(kind))) {
    return { ok: false, message: t("factory.draftSandbox.error.testKindsIncomplete") };
  }
  return {
    ok: true,
    data: {
      schema: "agent-factory-draft-sandbox-input/v1",
      scope: value.scope as unknown as DraftSandboxScope,
      specsCount: Number(value.specsCount),
      entryEvents: entries as DraftSandboxInputContract["entryEvents"],
      unresolvedBoundaries: boundaries as DraftSandboxInputContract["unresolvedBoundaries"],
      testKinds: ["pass", "reject", "edge", "fault"],
      note: typeof value.note === "string" ? value.note : t("factory.draftSandbox.note.default"),
    },
  };
}

function placeholder(type: string): unknown {
  return `${DRAFT_SANDBOX_TEST_SENTINELS.value}（${type || "unknown"}）`;
}

export function draftSandboxTestTemplate(t: Translate, contract: DraftSandboxInputContract): string {
  return JSON.stringify(contract.entryEvents.map((entry, index) => ({
    id: `manual_${index + 1}`,
    name: t("factory.draftSandbox.template.caseName", { event: entry.event }),
    scenario: DRAFT_SANDBOX_TEST_SENTINELS.scenario,
    kind: "pass",
    entryEvent: entry.event,
    payload: Object.fromEntries(entry.fields.map((field) => [field.name, placeholder(field.type)])),
    expectedOutcome: DRAFT_SANDBOX_TEST_SENTINELS.expectedOutcome,
  })), null, 2);
}

export function parseDraftSandboxSubmission(
  t: Translate,
  testCasesText: string,
  boundaryEventsText: string,
): DraftSandboxValidation<{ testCases: unknown[]; boundaryEvents: unknown[] }> {
  let testCases: unknown;
  let boundaryEvents: unknown;
  try {
    testCases = JSON.parse(testCasesText);
  } catch {
    return { ok: false, message: t("factory.draftSandbox.error.testCasesInvalidJson") };
  }
  try {
    boundaryEvents = JSON.parse(boundaryEventsText || "[]");
  } catch {
    return { ok: false, message: t("factory.draftSandbox.error.boundaryEventsInvalidJson") };
  }
  if (!Array.isArray(testCases) || testCases.length === 0) {
    return { ok: false, message: t("factory.draftSandbox.error.needAtLeastOneCase") };
  }
  if (!Array.isArray(boundaryEvents)) {
    return { ok: false, message: t("factory.draftSandbox.error.boundaryEventsNotArray") };
  }
  const sentinelPath = findDraftSandboxTestSentinel(testCases);
  if (sentinelPath) {
    return { ok: false, message: t("factory.draftSandbox.error.sentinelUntouched", { path: sentinelPath }) };
  }
  if (draftEditContainsSensitiveData(testCases) || draftEditContainsSensitiveData(boundaryEvents)) {
    return { ok: false, message: t("factory.draftSandbox.error.sensitiveData") };
  }
  return { ok: true, data: { testCases, boundaryEvents } };
}

function validChallenge(value: unknown): value is DraftSandboxChallenge {
  if (!isRecord(value) || value.kind !== "sandbox_design_review" || !Number.isInteger(value.protocolVersion)) return false;
  if (
    typeof value.id !== "string" || !value.id
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/i.test(value.digest)
    || typeof value.subjectDigest !== "string" || !/^[a-f0-9]{64}$/i.test(value.subjectDigest)
    || typeof value.token !== "string" || !value.token
    || typeof value.question !== "string" || !value.question
    || typeof value.context !== "string" || !value.context
    || typeof value.runId !== "string" || !value.runId
    || value.conversationId !== value.runId
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || !Array.isArray(value.options) || value.options.length !== 2
  ) return false;
  const options = value.options as unknown[];
  if (!options.every((option) => isRecord(option) && typeof option.label === "string" && typeof option.value === "string" && typeof option.recommended === "boolean")) return false;
  const typedOptions = options as DraftSandboxChallenge["options"];
  const confirm = typedOptions.filter((option) => option.value === value.token);
  const decline = typedOptions.filter((option) => option.value !== value.token);
  return confirm.length === 1
    && confirm[0]!.recommended === false
    && decline.length === 1
    && decline[0]!.recommended === true
    && new Set(typedOptions.map((option) => option.value)).size === 2;
}

export function readDraftSandboxReview(
  t: Translate,
  value: unknown,
  expected: Omit<DraftSandboxScope, "tenantId">,
): DraftSandboxValidation<DraftSandboxReview> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-sandbox-review/v1" || !exactScope(value.scope, expected)) {
    return { ok: false, message: t("factory.draftSandbox.error.reviewWrongVersion") };
  }
  if (
    typeof value.fingerprint !== "string" || !/^sandbox-evidence:v\d+:[a-f0-9]{64}$/i.test(value.fingerprint)
    || !Number.isInteger(value.specsCount) || Number(value.specsCount) < 1
    || !Array.isArray(value.testCases) || value.testCases.length === 0
    || !Array.isArray(value.boundaryEvents)
    || !isRecord(value.testCoverage)
    || !isStringArray(value.testCoverage.required)
    || !isStringArray(value.testCoverage.covered)
    || !isStringArray(value.testCoverage.backfilled)
    || !isStringArray(value.testCoverage.uncoveredNeedingData)
    || value.testCoverage.uncoveredNeedingData.length > 0
    || !validChallenge(value.challenge)
  ) {
    return { ok: false, message: t("factory.draftSandbox.error.reviewIncomplete") };
  }
  if (value.challenge.subjectDigest === "" || draftEditContainsSensitiveData(value.testCases) || draftEditContainsSensitiveData(value.boundaryEvents)) {
    return { ok: false, message: t("factory.draftSandbox.error.reviewSensitiveData") };
  }
  return { ok: true, data: value as unknown as DraftSandboxReview };
}

export function sandboxChallengeRef(challenge: DraftSandboxChallenge): Omit<DraftSandboxChallenge, "token" | "question" | "context" | "options"> {
  const { token: _token, question: _question, context: _context, options: _options, ...ref } = challenge;
  return ref;
}

export function readDraftSandboxFinishReceipt(
  t: Translate,
  value: unknown,
  expected: Omit<DraftSandboxScope, "tenantId" | "versionId"> & { baseVersionId: string },
): DraftSandboxValidation<DraftSandboxFinishReceipt> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-sandbox-finish/v1" || !isRecord(value.scope)) {
    return { ok: false, message: t("factory.draftSandbox.error.finishIncomplete") };
  }
  const scope = value.scope;
  if (!isRecord(value.sandbox)) {
    return { ok: false, message: t("factory.draftSandbox.error.finishMismatch") };
  }
  const sandbox = value.sandbox;
  const commonInvalid =
    typeof scope.tenantId !== "string" || !scope.tenantId
    || scope.tenantSlug !== expected.tenantSlug
    || scope.domain !== expected.domain
    || scope.slug !== expected.slug
    || scope.baseVersionId !== expected.baseVersionId
    || value.baseVersionId !== expected.baseVersionId
    || typeof value.versionId !== "string" || !value.versionId
    || scope.versionId !== value.versionId
    || typeof value.fingerprint !== "string" || !/^sandbox-evidence:v\d+:[a-f0-9]{64}$/i.test(value.fingerprint)
    || sandbox.cleanupVerified !== true
    || typeof sandbox.appId !== "string" || !sandbox.appId
    || typeof sandbox.attemptId !== "string" || !sandbox.attemptId
    || !Number.isInteger(sandbox.functionsRegistered) || Number(sandbox.functionsRegistered) < 1
    || !Number.isInteger(sandbox.agentsRan) || Number(sandbox.agentsRan) < 1;
  if (commonInvalid) {
    return { ok: false, message: t("factory.draftSandbox.error.finishMismatch") };
  }
  const replay = value.regressionReplay;
  const promotable =
    value.versionId !== expected.baseVersionId
    && value.regressionReady === true
    && value.diagnosticOnly === false
    && value.qualification === "promotable"
    && sandbox.qualification === "promotable"
    && (sandbox.isolationTier === "remote_container"
      || sandbox.isolationTier === "remote_vm")
    && isRecord(replay)
    && replay.pass === true
    && typeof replay.suiteFingerprint === "string"
    && Boolean(replay.suiteFingerprint)
    && Number.isInteger(replay.results)
    && Number(replay.results) > 0;
  const diagnostic = value.diagnosticEvidence;
  const developmentOnly =
    value.versionId === expected.baseVersionId
    && value.regressionReady === false
    && value.diagnosticOnly === true
    && value.qualification === "development_only"
    && sandbox.qualification === "development_only"
    && sandbox.isolationTier === "same_host_container"
    && isRecord(diagnostic)
    && diagnostic.schema === "agent-factory-draft-sandbox-diagnostic/v1"
    && typeof diagnostic.receiptId === "string"
    && Boolean(diagnostic.receiptId)
    && diagnostic.persisted === true
    && isStringArray(diagnostic.promotionBlockers)
    && diagnostic.promotionBlockers.length > 0
    && isRecord(replay)
    && replay.pass === false
    && replay.skipped === true
    && typeof replay.reason === "string"
    && Boolean(replay.reason);
  if (!promotable && !developmentOnly) {
    return { ok: false, message: t("factory.draftSandbox.error.finishMismatch") };
  }
  return { ok: true, data: value as unknown as DraftSandboxFinishReceipt };
}
