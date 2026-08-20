import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  canonicalEvidenceJson,
  gradeFunctionTest,
  SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION,
  sandboxCleanupReceiptIssues,
  sandboxDesignReviewSubjectDigest,
  sandboxExecutionReceiptIssues,
  sandboxRegistrationEvidenceIssues,
  generatedFleetModelRequirement,
  sandboxModelUsageEvidenceIssues,
  type AgentDraftRegressionEvidence,
  type AuthoritativeOntologyEvidence,
  type FunctionTestAssertions,
  type GeneratedAgentSpec,
  type SandboxCleanupReceipt,
  type SandboxBrokerRegistrationProof,
  type SandboxExecutionPlaneReceipt,
  type SandboxModelUsageEvidence,
  type SandboxToolDispatchReceipt,
  type TestCase,
} from "@agentic/agent-factory";
import {
  canonicalToolCassetteKey,
  type CanonicalCassetteDocument,
} from "@agentic/shared/cassette";
import {
  runGeneratedCodeIsolated,
  type CodeActDockerTransport,
} from "@agentic/runtime";

import { testGeneratedFunction } from "./function-tester-run";
import { containsFactoryFixtureAssetReference } from "./fixture-materializer";
import {
  authoritativeOntologyEvidenceIssues,
} from "./authoritative-ontology-evidence";
import {
  cassetteConfigHash,
  verifyCassetteEvidenceAttestation,
} from "./cassette-evidence-attestation";
import {
  sandboxToolBindingId,
} from "./sandbox-bundle-builder";

export const REGRESSION_ARTIFACT_SCHEMA = "agent-factory-regression/v3" as const;

export interface RegressionReplayCase {
  id: string;
  approvedTestCaseId?: string;
  kind: TestCase["kind"] | "structural";
  testEvent: { name: string; data: Record<string, unknown> };
  expectEmits: string[];
  assertions: FunctionTestAssertions;
  /** External tools that must have a definition-bound cassette before this
   * case is replayable. This list is immutable suite evidence, not inferred
   * again during promotion. */
  requiredEvidenceTools: string[];
  /** Human-readable fail-closed reasons captured while constructing the suite
   * (for example, an ambiguous multi-emit branch). */
  blockedReasons?: string[];
  fixture: {
    /** Legacy/manual structural fixtures remain readable, but promotion never
     * fabricates tool success into this map. External responses come from
     * exact-argument cassette matches at replay time. */
    toolResults?: Record<string, unknown>;
    toolCassettes?: Record<string, CanonicalCassetteDocument>;
    reasonResult?: Record<string, unknown>;
    invokeResults?: Record<string, unknown>;
    allowEvidenceFailures?: boolean;
  };
}

export interface RegressionArtifactAgent {
  slug: string;
  short: string;
  specFile: string;
  moduleFile: string;
  specHash: string;
  moduleHash: string;
  /** The byte-for-byte handler sent to production when codeExecuted=true.
   * The rendered Inngest module above remains a reviewable delivery artifact,
   * but is never substituted for this execution artifact during replay. */
  execution: "rendered-module" | "codeact-runtime";
  runtimeCodeFile?: string;
  runtimeCodeHash?: string;
  cases: RegressionReplayCase[];
}

export interface PersistedRegressionArtifact {
  schema: typeof REGRESSION_ARTIFACT_SCHEMA;
  versionId: string;
  domain: string;
  createdAt: string;
  /** Canonical sandbox-evidence identity accepted by finish. */
  evidenceFingerprint: string;
  /** Normalized identity of the authoritative tenant/domain Ontology that was
   * read both before and after this sandbox attempt. */
  authoritativeOntology: AuthoritativeOntologyEvidence;
  /** Content-addressed proof that the fresh sandbox app used for this exact
   * evidence was deleted before the draft became promotable. */
  sandboxCleanupReceipt: SandboxCleanupReceipt;
  /** Original exact registration evidence. Manifest IDs are candidate intent;
   * brokerRegistration is the independent control-plane readback. */
  sandboxAppId: string;
  committedManifestFunctionIds: string[];
  sandboxBrokerRegistration: SandboxBrokerRegistrationProof;
  /** Signed attestation from the isolated execution plane that loaded this
   * exact candidate. A local worker green result is not promotable. */
  sandboxExecutionReceipt: SandboxExecutionPlaneReceipt;
  /** Secret-free real model accounting; externalLiveCalls below is tools only. */
  sandboxModelUsage: SandboxModelUsageEvidence;
  modelRequired: boolean;
  modelRequiredAgentRefs: string[];
  /** Integrity identity of this JSON suite plus referenced spec/module hashes. */
  suiteFingerprint: string;
  scope: "structural-function-module" | "content-addressed-execution";
  approvedTestCases: TestCase[];
  effectiveTestCases: TestCase[];
  testCoverage?: NonNullable<AgentDraftRegressionEvidence["testCoverage"]>;
  testCoverageWaiver?: NonNullable<AgentDraftRegressionEvidence["testCoverageWaiver"]>;
  testDataOverrides: Record<string, unknown>;
  boundaryEvents: AgentDraftRegressionEvidence["boundaryEvents"];
  priorFunctionTester: NonNullable<AgentDraftRegressionEvidence["functionTester"]>;
  toolMode?: string;
  externalLiveCalls: 0;
  sandboxReplayEvidenceComplete: true;
  replayReceipts: SandboxToolDispatchReceipt[];
  sandboxDesignReview?: NonNullable<AgentDraftRegressionEvidence["sandboxDesignReview"]>;
  sandboxAutopilotReview?: NonNullable<AgentDraftRegressionEvidence["sandboxAutopilotReview"]>;
  cassetteRefs: NonNullable<AgentDraftRegressionEvidence["cassetteRefs"]>;
  /** Server-derived qualification sealed into suiteFingerprint. `candidate`
   * means only that this immutable, API-attested sandbox replay may enter the
   * independent commit-boundary production gate. It is never proof that the
   * production integration is ready: promotion re-reads the current registry
   * and HMAC-verifies an exact production-profile live probe (plus write
   * cleanup proof) immediately before mutation. Callers cannot supply this
   * qualification as a boolean. */
  evidenceQualification: {
    schema: "agent-factory-regression-evidence-qualification/v1";
    replay: "sandbox_verified";
    promotion: "candidate" | "blocked";
    blockers: Array<{
      code: "live_probe_required" | "write_probe_incomplete" | "tool_evidence_invalid";
      detail: string;
    }>;
  };
  /** Derived from the selected specs and sealed into suiteFingerprint. These
   * describe the risky tool bindings seen in sandbox. `requiresLiveProbe`
   * explicitly remains a commit-boundary production requirement; the sandbox
   * cassette may be an API-signed fixture because sandbox and production
   * profiles are deliberately different. */
  promotionToolEvidenceRequirements: Array<{
    bindingId: string;
    tool: string;
    specSlugs: string[];
    configHash: string;
    definitionHash: string;
    requiresLiveProbe: true;
    requiresWriteProbe: boolean;
  }>;
  agents: RegressionArtifactAgent[];
  replay: {
    runner: "@agentic/api#replay:factory-regression";
    command: string;
  };
}

export interface RegressionReplayResult {
  pass: boolean;
  /** True only when the immutable artifact is internally consistent and may
   * proceed to the separate, current production-profile gate. This is not a
   * production live-probe result and must never authorize mutation by itself. */
  promotionEvidenceReady?: boolean;
  promotionEvidenceErrors?: string[];
  artifact: string;
  versionId?: string;
  evidenceFingerprint?: string;
  authoritativeOntology?: AuthoritativeOntologyEvidence;
  suiteFingerprint?: string;
  sandboxCleanupReceiptHash?: string;
  sandboxCleanupReceipt?: SandboxCleanupReceipt;
  sandboxAppId?: string;
  committedManifestFunctionIds?: string[];
  sandboxBrokerRegistration?: SandboxBrokerRegistrationProof;
  sandboxExecutionReceipt?: SandboxExecutionPlaneReceipt;
  sandboxModelUsage?: SandboxModelUsageEvidence;
  sandboxExternalLiveCalls?: number | null;
  sandboxReplayEvidenceComplete?: boolean;
  sandboxReplayReceipts?: SandboxToolDispatchReceipt[];
  /** Approved effective entry events bound into the immutable suite fingerprint. Promotion uses
   * these to prove that external-platform triggers had explicit test inputs. */
  effectiveEntryEvents?: string[];
  results: Array<{
    slug: string;
    caseId: string;
    pass: boolean;
    ran: boolean;
    emitNames: string[];
    reasons: string[];
    tier: string;
    execution?: RegressionArtifactAgent["execution"];
    codeHash?: string;
  }>;
  errors: string[];
}

type RegressionEvidenceQualification = PersistedRegressionArtifact["evidenceQualification"];

function evidenceQualification(
  issues: readonly string[],
): RegressionEvidenceQualification {
  const blockers = [...new Set(issues)].sort().map((detail) => ({
    code: /live-probe/i.test(detail)
      ? "live_probe_required" as const
      : /write probe|write-probe|idempotency|cleanup|absence/i.test(detail)
        ? "write_probe_incomplete" as const
        : "tool_evidence_invalid" as const,
    detail,
  }));
  return {
    schema: "agent-factory-regression-evidence-qualification/v1",
    replay: "sandbox_verified",
    promotion: blockers.length === 0 ? "candidate" : "blocked",
    blockers,
  };
}

export interface RegressionReplayOptions {
  /** Trusted API-only adapter. Raw fixture bytes are returned directly to the
   * isolated replay worker and must never be persisted or sent to a model. */
  materializeTestPayload?: (input: {
    domain: string;
    conversationId: string;
    caseId: string;
    payload: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  /** Trusted executor seam used by focused tests. Production and CI omit it
   * and must provide the real Docker socket plus a digest-pinned image. */
  codeActContainerTransport?: CodeActDockerTransport;
  codeActCandidateImage?: string;
  /** Set only after `verifyFactoryRegressionExportBundle` authenticated the
   * exact copied bytes. CI never receives the API cassette signing key. */
  cassetteTrust?: "verified-regression-export";
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function regressionSpecHash(spec: GeneratedAgentSpec): string {
  return sha256(canonicalEvidenceJson(spec));
}

export function regressionModuleHash(code: string): string {
  return sha256(code);
}

/** The fingerprint omits only itself. Paths, replay inputs and cassette identities
 * are covered so editing any supposedly approved artifact invalidates promotion. */
export function regressionSuiteFingerprint(artifact: Omit<PersistedRegressionArtifact, "suiteFingerprint"> | PersistedRegressionArtifact): string {
  const { suiteFingerprint: _ignored, ...body } = artifact as PersistedRegressionArtifact;
  return `regression-suite:v1:${sha256(canonicalEvidenceJson(body))}`;
}

function applyOverrides(payload: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const effective = { ...payload };
  for (const [key, value] of Object.entries(overrides)) {
    if (key in effective) effective[key] = value;
  }
  return effective;
}

function collectFixtureTools(spec: GeneratedAgentSpec): string[] {
  const names = new Set(spec.tools ?? []);
  const walk = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const raw of steps) {
      if (!raw || typeof raw !== "object") continue;
      const step = raw as Record<string, unknown>;
      if (step.kind === "tool" && typeof step.tool === "string") names.add(step.tool);
      if (step.kind === "invoke" && typeof step.invoke === "string") names.add(`invoke:${step.invoke}`);
      if (step.kind === "foreach") walk(step.body);
    }
  };
  walk(spec.plan);
  return [...names].sort();
}

function promotionToolEvidenceRequirements(
  specs: GeneratedAgentSpec[],
  refs: NonNullable<AgentDraftRegressionEvidence["cassetteRefs"]>,
): {
  requirements: PersistedRegressionArtifact["promotionToolEvidenceRequirements"];
  issues: string[];
} {
  const grouped = new Map<string, {
    tool: string;
    configHash: string;
    specSlugs: Set<string>;
    external: boolean;
    write: boolean;
  }>();
  for (const spec of specs) {
    for (const tool of collectFixtureTools(spec).filter((name) => !name.startsWith("invoke:"))) {
      const policy = spec.toolPolicies?.[tool];
      const sideEffect = spec.toolSideEffects?.[tool];
      const external = policy?.effectScope === "external";
      const write = sideEffect === "write"
        || sideEffect === "dual"
        || policy?.operation === "write"
        || policy?.operation === "read_write";
      const configHash = cassetteConfigHash(spec.sandboxToolConfigs?.[tool] ?? {});
      const key = `${tool}\u0000${configHash}`;
      const prior = grouped.get(key) ?? {
        tool,
        configHash,
        specSlugs: new Set<string>(),
        external: false,
        write: false,
      };
      prior.specSlugs.add(spec.slug);
      prior.external ||= external;
      prior.write ||= write;
      grouped.set(key, prior);
    }
  }
  const issues: string[] = [];
  const requirements: PersistedRegressionArtifact["promotionToolEvidenceRequirements"] = [];
  for (const binding of [...grouped.values()]
    .filter((entry) => entry.external || entry.write)
    .sort((left, right) => left.tool.localeCompare(right.tool) || left.configHash.localeCompare(right.configHash))) {
    const specSlugs = [...binding.specSlugs].sort();
    const matches = refs.filter((ref) =>
      ref.tool === binding.tool
      && ref.configHash === binding.configHash
      && canonicalEvidenceJson([...(ref.specSlugs ?? [])].sort()) === canonicalEvidenceJson(specSlugs));
    const label = `${binding.tool}[${specSlugs.join(",")}]/${binding.configHash.slice(0, 12)}`;
    if (matches.length !== 1) {
      issues.push(`${label} requires exactly one immutable cassette binding`);
      continue;
    }
    const ref = matches[0]!;
    if (!ref.definitionHash || !/^[a-f0-9]{64}$/i.test(ref.definitionHash)) {
      issues.push(`${label} has no exact definition identity`);
      continue;
    }
    const expectedBindingId = sandboxToolBindingId({
      specSlugs,
      toolName: binding.tool,
      configHash: binding.configHash,
      definitionHash: ref.definitionHash,
    });
    if (ref.bindingId !== expectedBindingId) {
      issues.push(`${label} has an invalid bindingId`);
      continue;
    }
    requirements.push({
      bindingId: expectedBindingId,
      tool: binding.tool,
      specSlugs,
      configHash: binding.configHash,
      definitionHash: ref.definitionHash,
      requiresLiveProbe: true,
      requiresWriteProbe: binding.write,
    });
  }
  return { requirements, issues };
}

function promotionCassetteSummaryIssues(
  requirements: PersistedRegressionArtifact["promotionToolEvidenceRequirements"],
  refs: NonNullable<AgentDraftRegressionEvidence["cassetteRefs"]>,
): string[] {
  const issues: string[] = [];
  for (const requirement of requirements) {
    const matches = refs.filter((ref) => ref.bindingId === requirement.bindingId);
    if (matches.length !== 1) {
      issues.push(`${requirement.tool}/${requirement.bindingId} requires exactly one immutable cassette reference`);
      continue;
    }
    const ref = matches[0]!;
    if (
      ref.tool !== requirement.tool
      || ref.definitionHash !== requirement.definitionHash
      || ref.configHash !== requirement.configHash
      || canonicalEvidenceJson([...(ref.specSlugs ?? [])].sort()) !== canonicalEvidenceJson(requirement.specSlugs)
      || sandboxToolBindingId({
        specSlugs: requirement.specSlugs,
        toolName: requirement.tool,
        configHash: requirement.configHash,
        definitionHash: requirement.definitionHash,
      }) !== requirement.bindingId
    ) {
      issues.push(`${requirement.tool}/${requirement.bindingId} binding summary has drifted`);
      continue;
    }
    if (!ref.evidenceMode || !["live-probe", "signed-fixture", "runtime-record"].includes(ref.evidenceMode)) {
      issues.push(`${requirement.tool} has unsupported sandbox evidence mode ${String(ref.evidenceMode ?? "missing")}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(ref.configHash ?? "")) {
      issues.push(`${requirement.tool} has no signed config identity`);
    }
    if (!ref.attestationKeyId?.trim() || !ref.attestationExpiresAt?.trim()) {
      issues.push(`${requirement.tool} has no API attestation summary`);
    }
    // A sandbox fixture must never pretend it performed production writes.
    // Complete write-canary proof is checked against the exact production
    // profile by verifyProductionIntegrationProbeEvidence at commit time.
  }
  return issues;
}

function sandboxDispatchEvidenceIssues(
  evidence: Pick<AgentDraftRegressionEvidence,
    "toolMode" | "externalLiveCalls" | "sandboxReplayEvidenceComplete" | "replayReceipts" | "cleanupReceipt" | "cassetteRefs">,
): string[] {
  const issues: string[] = [];
  if (evidence.toolMode !== "evidence_replay") {
    issues.push(`toolMode must be evidence_replay, got ${String(evidence.toolMode ?? "missing")}`);
  }
  if (evidence.externalLiveCalls !== 0) {
    issues.push(`externalLiveCalls must be exactly 0, got ${String(evidence.externalLiveCalls ?? "unknown")}`);
  }
  if (evidence.sandboxReplayEvidenceComplete !== true) {
    issues.push("sandbox replay dispatch ledger is missing or incomplete");
  }
  const attemptId = evidence.cleanupReceipt?.sandboxAttemptId;
  const tenantSlug = evidence.cleanupReceipt?.sandboxTenantSlug;
  const cassetteRefs = evidence.cassetteRefs ?? [];
  for (const [index, receipt] of (evidence.replayReceipts ?? []).entries()) {
    const prefix = `replay receipt #${index + 1} (${String(receipt?.tool ?? "unknown")})`;
    if (receipt?.schema !== "agent-factory-sandbox-dispatch/v1") issues.push(`${prefix} has unsupported schema`);
    if (receipt?.kind !== "replay" || receipt?.effectScope !== "external") {
      issues.push(`${prefix} is not an external replay receipt`);
    }
    if (!attemptId || receipt?.attemptId !== attemptId || !tenantSlug || receipt?.tenantSlug !== tenantSlug) {
      issues.push(`${prefix} is not bound to the cleanup attempt`);
    }
    if (!/^[a-f0-9]{8}$/i.test(String(receipt?.argsHash ?? ""))) issues.push(`${prefix} has invalid argsHash`);
    if (!/^[a-f0-9]{8}$/i.test(String(receipt?.cassetteKey ?? ""))) issues.push(`${prefix} has invalid cassette key`);
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.definitionHash ?? ""))) issues.push(`${prefix} has invalid definition hash`);
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.contentHash ?? ""))) issues.push(`${prefix} has invalid content hash`);
    const ref = cassetteRefs.find((candidate) =>
      candidate.tool === receipt?.tool &&
      candidate.definitionHash === receipt?.definitionHash);
    if (!ref) issues.push(`${prefix} does not match an immutable cassette reference`);
    else if (!ref.contentHash || ref.contentHash !== receipt?.contentHash) {
      issues.push(`${prefix} does not match the exact immutable cassette content`);
    }
  }
  return issues;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

/** Validate the durable receipt structurally and bind it to this exact
 * candidate. The challenge was already atomically consumed before sandbox
 * creation, so replay deliberately does not require `expiresAt` to still be in
 * the future. It does require consumption to have occurred before expiry. */
function sandboxReviewEvidenceIssues(
  evidence: Pick<
    AgentDraftRegressionEvidence,
    "evidenceFingerprint" | "sandboxDesignReview" | "sandboxAutopilotReview"
  >,
  expectedSubjectDigest?: string,
): string[] {
  const review = evidence.sandboxDesignReview;
  const autopilot = evidence.sandboxAutopilotReview;
  if (review && autopilot) {
    return ["sandbox review contains both human and autopilot evidence"];
  }
  if (autopilot) {
    const issues: string[] = [];
    if (
      autopilot.schema !==
      "agent-factory-autopilot-sandbox-review/v1"
    ) {
      issues.push("autopilot sandbox review schema is invalid");
    }
    if (autopilot.policy !== "autopilot_safe") {
      issues.push("autopilot sandbox review policy is invalid");
    }
    if (autopilot.fingerprint !== evidence.evidenceFingerprint) {
      issues.push(
        "autopilot sandbox review fingerprint does not match the candidate evidence fingerprint",
      );
    }
    if (!SHA256_HEX_RE.test(autopilot.subjectDigest)) {
      issues.push("autopilot sandbox review subject digest is invalid");
    }
    if (
      expectedSubjectDigest &&
      autopilot.subjectDigest !== expectedSubjectDigest
    ) {
      issues.push(
        "autopilot sandbox review subject digest is not bound to the candidate domain/fingerprint/build",
      );
    }
    if (!autopilot.assumptionId?.trim()) {
      issues.push("autopilot sandbox review assumption id is missing");
    }
    if (!Number.isFinite(autopilot.appliedAt) || autopilot.appliedAt <= 0) {
      issues.push("autopilot sandbox review appliedAt is invalid");
    }
    return issues;
  }
  if (!review) return ["sandbox review evidence is missing"];
  const issues: string[] = [];
  if (review.fingerprint !== evidence.evidenceFingerprint) {
    issues.push("sandbox design review fingerprint does not match the candidate evidence fingerprint");
  }
  if (!SHA256_HEX_RE.test(review.subjectDigest)) {
    issues.push("sandbox design review subject digest is invalid");
  }
  if (expectedSubjectDigest && review.subjectDigest !== expectedSubjectDigest) {
    issues.push("sandbox design review subject digest is not bound to the candidate domain/fingerprint/build");
  }
  const receipt = review.receipt;
  if (!receipt || typeof receipt !== "object") {
    issues.push("sandbox design review authorization receipt is missing");
    return issues;
  }
  if (receipt.kind !== "sandbox_design_review") {
    issues.push(`sandbox design review receipt has the wrong kind: ${String(receipt.kind)}`);
  }
  if (receipt.protocolVersion !== SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION) {
    issues.push(`sandbox design review receipt has unsupported protocol version: ${String(receipt.protocolVersion)}`);
  }
  if (receipt.subjectDigest !== review.subjectDigest) {
    issues.push("sandbox design review receipt is not bound to the persisted subject digest");
  }
  if (!receipt.actor?.trim()) issues.push("sandbox design review receipt has no authenticated actor");
  if (!receipt.challengeId?.trim()) issues.push("sandbox design review receipt has no challenge id");
  if (!receipt.runId?.trim() || !receipt.conversationId?.trim()) {
    issues.push("sandbox design review receipt has incomplete execution scope");
  }
  if (!SHA256_HEX_RE.test(String(receipt.digest ?? ""))) {
    issues.push("sandbox design review receipt challenge digest is invalid");
  }
  if (!SHA256_HEX_RE.test(String(receipt.authorizationDigest ?? ""))) {
    issues.push("sandbox design review receipt authorization digest is invalid");
  }
  const consumedAt = Date.parse(receipt.consumedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(consumedAt) || !Number.isFinite(expiresAt)) {
    issues.push("sandbox design review receipt timestamps are invalid");
  } else if (consumedAt >= expiresAt) {
    issues.push("sandbox design review receipt was not consumed before challenge expiry");
  }
  return issues;
}

function replayCasesFor(spec: GeneratedAgentSpec, effectiveCases: TestCase[]): RegressionReplayCase[] {
  const matching = effectiveCases.filter((testCase) => (spec.trigger ?? []).includes(testCase.entryEvent));
  const inputs: Array<TestCase | null> = matching.length ? matching : [null];
  const requiredEvidenceTools = collectFixtureTools(spec).filter((name) => !name.startsWith("invoke:"));
  return inputs.map((testCase, index) => {
    const entryEvent = testCase?.entryEvent ?? spec.trigger?.[0] ?? "";
    const blockedReasons: string[] = [];
    if (!testCase) {
      blockedReasons.push(`Agent ${spec.slug} 没有与 trigger 匹配的已批准测试用例；不会自动伪造 structural success fixture`);
    }
    let expectedEvent = testCase?.expectedEvent;
    if (expectedEvent && !(spec.emit ?? []).includes(expectedEvent)) {
      blockedReasons.push(`测试用例 ${testCase?.id ?? index + 1} 的 expectedEvent=${expectedEvent} 不在 Agent 声明事件中`);
      expectedEvent = undefined;
    }
    if (!expectedEvent && (spec.emit ?? []).length === 1) expectedEvent = spec.emit![0];
    if (!expectedEvent && (spec.emit ?? []).length > 1) {
      blockedReasons.push(`测试用例 ${testCase?.id ?? index + 1} 面对多个可能事件却没有 expectedEvent；不能按 pass/reject 名称猜业务分支`);
    }
    const explicitAssertions = testCase?.functionAssertions ?? {};
    const exactEmits = explicitAssertions.exactEmits ?? Boolean(expectedEvent);
    const forbiddenEmits = explicitAssertions.forbiddenEmits ?? (
      exactEmits && expectedEvent ? (spec.emit ?? []).filter((event) => event !== expectedEvent) : []
    );
    return {
      id: testCase?.id ? `${spec.slug}:${testCase.id}` : `${spec.slug}:structural:${index + 1}`,
      ...(testCase ? { approvedTestCaseId: testCase.id } : {}),
      kind: testCase?.kind ?? "structural",
      testEvent: { name: entryEvent, data: testCase?.payload ?? {} },
      expectEmits: expectedEvent ? [expectedEvent] : [],
      assertions: { ...explicitAssertions, exactEmits, forbiddenEmits },
      requiredEvidenceTools,
      ...(blockedReasons.length ? { blockedReasons } : {}),
      fixture: {
        // The approved branch only controls the deterministic reason seam. It
        // does not pretend an external tool succeeded; those values are loaded
        // from definition-bound cassettes and matched by the actual args.
        ...(testCase && expectedEvent ? { reasonResult: { emit: expectedEvent, __approvedDecisionFixture: testCase.id } } : {}),
        ...(testCase?.kind === "fault" ? { allowEvidenceFailures: true } : {}),
      },
    };
  });
}

export function buildRegressionArtifact(args: {
  versionId: string;
  domain: string;
  createdAt: string;
  specs: GeneratedAgentSpec[];
  modules: Array<{ slug: string; code: string }>;
  evidence: AgentDraftRegressionEvidence;
  fileNameForSlug: (slug: string) => string;
}): PersistedRegressionArtifact {
  const ontologyIssues = authoritativeOntologyEvidenceIssues(
    args.evidence.authoritativeOntology,
    { domainId: args.domain },
  );
  if (ontologyIssues.length) {
    throw new Error(
      `authoritative ontology evidence is not promotable: ${ontologyIssues.join("; ")}`,
    );
  }
  const cleanupIssues = sandboxCleanupReceiptIssues(args.evidence.cleanupReceipt, {
    candidateFingerprint: args.evidence.evidenceFingerprint,
    targetDomainId: args.domain,
  });
  if (cleanupIssues.length) {
    throw new Error(`sandbox cleanup receipt is not promotable: ${cleanupIssues.join("; ")}`);
  }
  const registrationIssues = sandboxRegistrationEvidenceIssues({
    appId: args.evidence.sandboxAppId,
    committedManifestFunctionIds: args.evidence.committedManifestFunctionIds,
    brokerRegistration: args.evidence.brokerRegistration,
  }, args.specs.map((spec) => spec.slug));
  if (registrationIssues.length) {
    throw new Error(`sandbox registration evidence is not promotable: ${registrationIssues.join("; ")}`);
  }
  const executionIssues = sandboxExecutionReceiptIssues(
    args.evidence.executionReceipt,
    {
      candidateFingerprint: args.evidence.evidenceFingerprint,
      targetDomainId: args.domain,
      sandboxAttemptId: args.evidence.cleanupReceipt?.sandboxAttemptId,
      modelUsageHash: args.evidence.modelUsage?.evidenceHash,
    },
  );
  if (executionIssues.length) {
    throw new Error(`sandbox execution receipt is not promotable: ${executionIssues.join("; ")}`);
  }
  const modelRequirement = generatedFleetModelRequirement(args.specs);
  const modelRequired = modelRequirement.requiredAgentRefs.length > 0;
  const modelUsageIssues = [
    ...modelRequirement.issues,
    ...sandboxModelUsageEvidenceIssues(
    args.evidence.modelUsage,
    {
      sandboxAttemptId: args.evidence.cleanupReceipt?.sandboxAttemptId,
      modelRequired,
      requiredAgentRefs: modelRequirement.requiredAgentRefs,
    },
  )];
  if (modelUsageIssues.length) {
    throw new Error(`sandbox model usage is not promotable: ${modelUsageIssues.join("; ")}`);
  }
  const nonPromotableTester = (args.evidence.functionTester ?? []).filter(
    (entry) => entry.qualification !== "promotable",
  );
  if (nonPromotableTester.length) {
    throw new Error(
      `function tester did not run on the promotable execution plane: ${nonPromotableTester.map((entry) => entry.short).join(", ")}`,
    );
  }
  const dispatchIssues = sandboxDispatchEvidenceIssues(args.evidence);
  if (dispatchIssues.length) {
    throw new Error(`sandbox dispatch evidence is not promotable: ${dispatchIssues.join("; ")}`);
  }
  const promotion = promotionToolEvidenceRequirements(
    args.specs,
    args.evidence.cassetteRefs ?? [],
  );
  const promotionRequirements = promotion.requirements;
  // Missing/ambiguous exact bindings make even sandbox replay unverifiable.
  // A valid API-attested signed fixture is allowed here: it proves deterministic
  // sandbox replay, while the independent commit gate later requires a fresh,
  // exact production-profile live probe. This avoids coupling two intentionally
  // isolated profiles without weakening production authorization.
  if (promotion.issues.length) {
    throw new Error(`sandbox cassette evidence is invalid: ${promotion.issues.join("; ")}`);
  }
  const qualification = evidenceQualification(
    promotionCassetteSummaryIssues(
      promotionRequirements,
      args.evidence.cassetteRefs ?? [],
    ),
  );
  const designReviewIssues = sandboxReviewEvidenceIssues(
    args.evidence,
    sandboxDesignReviewSubjectDigest({
      domain: args.domain,
      fingerprint: args.evidence.evidenceFingerprint,
    }),
  );
  if (args.evidence.sandboxAutopilotReview) {
    if (
      (args.evidence.testCoverage?.uncoveredNeedingData.length ?? 0) > 0
      || args.evidence.testCoverageWaiver
    ) {
      designReviewIssues.push(
        "autopilot sandbox review cannot approve incomplete or waived coverage",
      );
    }
    const externalWrite = args.specs.some((spec) =>
      Object.values(spec.toolSideEffects ?? {}).some(
        (effect) => effect === "write" || effect === "dual",
      )
      || Object.values(spec.toolPolicies ?? {}).some(
        (policy) =>
          policy.effectScope === "external"
          && (
            policy.operation === "write"
            || policy.operation === "read_write"
            || policy.sandboxPolicy === "requires_attempt_grant"
          ),
      ));
    if (externalWrite) {
      designReviewIssues.push(
        "autopilot sandbox review cannot approve an external-write fleet",
      );
    }
  }
  if (designReviewIssues.length) {
    throw new Error(`sandbox design review evidence is not promotable: ${designReviewIssues.join("; ")}`);
  }
  const overrides = args.evidence.testDataOverrides ?? {};
  const effectiveTestCases = args.evidence.approvedTestCases.map((testCase) => ({
    ...testCase,
    payload: applyOverrides(testCase.payload, overrides),
  }));
  const moduleBySlug = new Map(args.modules.map((entry) => [entry.slug, entry.code]));
  const withoutFingerprint: Omit<PersistedRegressionArtifact, "suiteFingerprint"> = {
    schema: REGRESSION_ARTIFACT_SCHEMA,
    versionId: args.versionId,
    domain: args.domain,
    createdAt: args.createdAt,
    evidenceFingerprint: args.evidence.evidenceFingerprint,
    authoritativeOntology: args.evidence.authoritativeOntology,
    sandboxCleanupReceipt: args.evidence.cleanupReceipt!,
    sandboxAppId: args.evidence.sandboxAppId!,
    committedManifestFunctionIds: args.evidence.committedManifestFunctionIds!,
    sandboxBrokerRegistration: args.evidence.brokerRegistration!,
    sandboxExecutionReceipt: args.evidence.executionReceipt!,
    sandboxModelUsage: args.evidence.modelUsage!,
    modelRequired,
    modelRequiredAgentRefs: modelRequirement.requiredAgentRefs,
    scope: "content-addressed-execution",
    approvedTestCases: args.evidence.approvedTestCases,
    effectiveTestCases,
    ...(args.evidence.testCoverage ? { testCoverage: args.evidence.testCoverage } : {}),
    ...(args.evidence.testCoverageWaiver ? { testCoverageWaiver: args.evidence.testCoverageWaiver } : {}),
    testDataOverrides: overrides,
    boundaryEvents: args.evidence.boundaryEvents ?? [],
    priorFunctionTester: args.evidence.functionTester ?? [],
    ...(args.evidence.toolMode ? { toolMode: args.evidence.toolMode } : {}),
    externalLiveCalls: 0,
    sandboxReplayEvidenceComplete: true,
    replayReceipts: args.evidence.replayReceipts ?? [],
    ...(args.evidence.sandboxDesignReview
      ? { sandboxDesignReview: args.evidence.sandboxDesignReview }
      : {}),
    ...(args.evidence.sandboxAutopilotReview
      ? { sandboxAutopilotReview: args.evidence.sandboxAutopilotReview }
      : {}),
    cassetteRefs: (args.evidence.cassetteRefs ?? []).map((ref) => ({
      ...ref,
      // FsAgentDraftStore snapshots cassettes beside regression.json and
      // supplies a relative path. Keep it relative so the immutable version
      // can be moved to a CI runner without retaining a source-machine path.
      // Absolute paths remain readable for legacy artifacts only.
      path: path.isAbsolute(ref.path) ? path.resolve(ref.path) : ref.path,
    })),
    evidenceQualification: qualification,
    promotionToolEvidenceRequirements: promotionRequirements,
    agents: args.specs.map((spec) => {
      const file = args.fileNameForSlug(spec.slug);
      const code = moduleBySlug.get(spec.slug);
      if (code === undefined) throw new Error(`missing rendered module for ${spec.slug}`);
      const runtimeCode = spec.codeExecuted === true ? spec.generatedCode : undefined;
      if (spec.codeExecuted === true && !runtimeCode?.trim()) {
        throw new Error(`missing exact CodeAct runtime module for ${spec.slug}`);
      }
      return {
        slug: spec.slug,
        short: spec.short,
        specFile: `agents/${file}.json`,
        moduleFile: `agents/${file}.ts`,
        specHash: regressionSpecHash(spec),
        moduleHash: regressionModuleHash(code),
        execution: runtimeCode ? "codeact-runtime" : "rendered-module",
        ...(runtimeCode ? {
          runtimeCodeFile: `agents/${file}.codeact.ts`,
          runtimeCodeHash: regressionModuleHash(runtimeCode),
        } : {}),
        cases: replayCasesFor(spec, effectiveTestCases),
      };
    }),
    replay: {
      runner: "@agentic/api#replay:factory-regression",
      command: "pnpm --filter @agentic/api replay:factory-regression -- {artifact}",
    },
  };
  return { ...withoutFingerprint, suiteFingerprint: regressionSuiteFingerprint(withoutFingerprint) };
}

function resolveArtifactFile(artifactPath: string, relativeFile: string): string {
  const base = path.dirname(path.resolve(artifactPath));
  const target = path.resolve(base, relativeFile);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`artifact path escapes version directory: ${relativeFile}`);
  }
  return target;
}

async function loadCassetteEvidence(
  artifact: PersistedRegressionArtifact,
  artifactPath: string,
  trust?: RegressionReplayOptions["cassetteTrust"],
  attestationDataRoot?: string,
  attestationValidationTime?: Date,
): Promise<{
  errors: string[];
  documents: Record<string, CanonicalCassetteDocument>;
}> {
  const errors: string[] = [];
  const documents: Record<string, CanonicalCassetteDocument> = {};
  for (const ref of artifact.cassetteRefs ?? []) {
    try {
      const errorsBefore = errors.length;
      const bindingId = ref.bindingId ?? "";
      if (!/^tool-binding:v1:[a-f0-9]{64}$/i.test(bindingId)) {
        errors.push(`cassette binding identity missing: ${ref.tool}`);
      }
      if (!ref.specSlugs?.length) {
        errors.push(`cassette spec binding missing: ${ref.tool}`);
      }
      const cassettePath = path.isAbsolute(ref.path)
        ? path.resolve(ref.path)
        : resolveArtifactFile(artifactPath, ref.path);
      const raw = await fs.readFile(cassettePath, "utf8");
      if (ref.contentHash && sha256(raw) !== ref.contentHash) {
        errors.push(`cassette content drift: ${ref.tool}`);
      }
      if (!ref.contentHash) errors.push(`cassette content hash missing: ${ref.tool}`);
      const document = JSON.parse(raw) as CanonicalCassetteDocument;
      if (document.version !== 1 || !Array.isArray(document.entries)) {
        errors.push(`cassette contract invalid: ${ref.tool}`);
        continue;
      }
      if (document.tool?.name !== ref.tool) errors.push(`cassette tool mismatch: ${ref.tool}`);
      if (!ref.definitionHash || !document.tool?.definitionHash) errors.push(`cassette is not definition-bound: ${ref.tool}`);
      if (ref.definitionHash && document.tool?.definitionHash !== ref.definitionHash) {
        errors.push(`cassette definition drift: ${ref.tool}`);
      }
      if (ref.schemaHash && document.tool?.schemaHash !== ref.schemaHash) {
        errors.push(`cassette schema drift: ${ref.tool}`);
      }
      if (!document.evidence?.recordedAt || !["live-probe", "signed-fixture", "runtime-record"].includes(document.evidence.mode)) {
        errors.push(`cassette has no probe/record evidence: ${ref.tool}`);
      }
      if (!ref.configHash) {
        errors.push(`cassette signed config identity missing: ${ref.tool}`);
      } else {
        if (
          !ref.definitionHash
          || sandboxToolBindingId({
            specSlugs: ref.specSlugs ?? [],
            toolName: ref.tool,
            configHash: ref.configHash,
            definitionHash: ref.definitionHash,
          }) !== bindingId
        ) {
          errors.push(`cassette binding digest drift: ${ref.tool}`);
        }
        const verification = verifyCassetteEvidenceAttestation(document, {
          tenantId: artifact.authoritativeOntology.tenantId,
          tenantSlug: artifact.authoritativeOntology.tenantSlug,
          domainId: artifact.domain,
          toolName: ref.tool,
          definitionHash: ref.definitionHash ?? "",
          configHash: ref.configHash,
          allowedModes: ["live-probe", "signed-fixture", "runtime-record"],
        }, trust === "verified-regression-export"
          ? {
              trust: "verified-regression-export",
              ...(attestationValidationTime ? { now: attestationValidationTime } : {}),
            }
          : attestationDataRoot
            ? {
                dataRoot: attestationDataRoot,
                ...(attestationValidationTime ? { now: attestationValidationTime } : {}),
              }
            : undefined);
        if (!verification.valid || !verification.summary) {
          errors.push(`cassette API attestation invalid: ${ref.tool} (${verification.issues.slice(0, 3).join("; ")})`);
        } else {
          const summary = verification.summary;
          if (
            ref.evidenceMode !== summary.mode
            || ref.attestationKeyId !== summary.attestationKeyId
            || ref.attestationExpiresAt !== summary.attestationExpiresAt
            || ref.configHash !== summary.configHash
          ) {
            errors.push(`cassette attestation summary drift: ${ref.tool}`);
          }
          const expectedWrite = ref.writeProbe;
          const actualWrite = summary.writeProbe;
          if (Boolean(expectedWrite) !== Boolean(actualWrite) || (expectedWrite && actualWrite && (
            expectedWrite.schema !== actualWrite.schema
            || expectedWrite.createCompleted !== actualWrite.createCompleted
            || expectedWrite.cleanupCompleted !== actualWrite.cleanupCompleted
            || expectedWrite.absenceVerified !== actualWrite.absenceVerified
            || expectedWrite.idempotencyKeyHash !== actualWrite.idempotencyKeyHash
          ))) {
            errors.push(`cassette write probe summary drift: ${ref.tool}`);
          }
        }
      }
      const usable = document.entries.filter((entry) =>
        entry?.request?.kind === "tool" &&
        entry.request.toolName === ref.tool &&
        typeof entry.request.argsHash === "string" &&
        Boolean(entry.response) &&
        Object.prototype.hasOwnProperty.call(entry.response, "body"));
      if (!usable.length) errors.push(`cassette has no usable tool response: ${ref.tool}`);
      if (bindingId && documents[bindingId]) errors.push(`duplicate cassette binding: ${bindingId}`);
      if (errors.length === errorsBefore) {
        documents[bindingId] = document;
      }
    } catch (error) {
      errors.push(`cassette unavailable: ${ref.tool} (${String((error as Error)?.message ?? error)})`);
    }
  }
  return { errors, documents };
}

function cassetteDocumentsForAgent(
  artifact: PersistedRegressionArtifact,
  documentsByBinding: Record<string, CanonicalCassetteDocument>,
  spec: GeneratedAgentSpec,
): { documents: Record<string, CanonicalCassetteDocument>; errors: string[] } {
  const documents: Record<string, CanonicalCassetteDocument> = {};
  const errors: string[] = [];
  const selected = new Set(collectFixtureTools(spec).filter((name) => !name.startsWith("invoke:")));
  for (const ref of artifact.cassetteRefs ?? []) {
    if (!ref.specSlugs?.includes(spec.slug) || !selected.has(ref.tool)) continue;
    const document = ref.bindingId ? documentsByBinding[ref.bindingId] : undefined;
    if (!document) continue;
    if (documents[ref.tool]) {
      errors.push(`${spec.slug} has multiple cassette bindings for ${ref.tool}`);
      continue;
    }
    const expectedConfigHash = cassetteConfigHash(spec.sandboxToolConfigs?.[ref.tool] ?? {});
    if (ref.configHash !== expectedConfigHash) {
      errors.push(`${spec.slug}/${ref.tool} cassette config binding does not match the spec`);
      continue;
    }
    documents[ref.tool] = document;
  }
  return { documents, errors };
}

/** Export-side gate. It performs no generated-code execution, but it does
 * verify the API HMAC while the private trust root is still local. The export
 * manifest then signs the exact copied bytes so CI can replay with only the
 * independent regression-export secret. */
export async function assertRegressionArtifactCassetteEvidence(
  artifactPath: string,
  options?: { dataRoot?: string },
): Promise<void> {
  const resolved = path.resolve(artifactPath);
  const artifact = JSON.parse(await fs.readFile(resolved, "utf8")) as PersistedRegressionArtifact;
  if (artifact.schema !== REGRESSION_ARTIFACT_SCHEMA) {
    throw new Error(`unsupported regression schema: ${String(artifact.schema)}`);
  }
  const evidence = await loadCassetteEvidence(
    artifact,
    resolved,
    undefined,
    options?.dataRoot,
    new Date(artifact.createdAt),
  );
  const issues = [...evidence.errors];
  if (!Array.isArray(artifact.promotionToolEvidenceRequirements)) {
    issues.push("promotion cassette evidence requirements are missing");
  } else {
    const summaryIssues = promotionCassetteSummaryIssues(
      artifact.promotionToolEvidenceRequirements,
      artifact.cassetteRefs ?? [],
    );
    issues.push(...summaryIssues);
    const expectedQualification = evidenceQualification(summaryIssues);
    if (
      !artifact.evidenceQualification
      || canonicalEvidenceJson(artifact.evidenceQualification)
        !== canonicalEvidenceJson(expectedQualification)
      || artifact.evidenceQualification.promotion !== "candidate"
    ) {
      issues.push("server-derived evidence qualification is missing, stale, or blocked");
    }
    // Export authenticates the exact replay cassette bytes. Production live
    // probes deliberately stay outside the portable regression bundle and are
    // re-read from the target tenant at the commit boundary.
  }
  if (issues.length) {
    throw new Error(`regression cassette evidence cannot be exported: ${issues.slice(0, 8).join("; ")}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Execute CodeAct with the exact production one-shot container kernel. The dependencies
 * are replay fixtures, but module loading, RPC, timeout/memory containment and
 * ctx.emit capture are the same path used by production. */
async function replayExactCodeAct(args: {
  code: string;
  expectedHash: string;
  spec: GeneratedAgentSpec;
  replayCase: RegressionReplayCase;
  containerTransport?: CodeActDockerTransport;
  candidateImage?: string;
  tenantId: string;
  tenantSlug: string;
  runId: string;
  promotionVersionId: string;
  regressionSuiteFingerprint: string;
}): Promise<RegressionReplayResult["results"][number]> {
  const fixtureErrors: string[] = [];
  const memoryValues = new Map<string, unknown>();
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const fixture = args.replayCase.fixture;
  const inputData = asRecord(args.replayCase.testEvent.data);
  const payload = asRecord(inputData.payload);
  const input = Object.keys(payload).length ? payload : inputData;
  const has = (object: Record<string, unknown> | undefined, key: string): boolean =>
    Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  const run = await runGeneratedCodeIsolated(args.code, input, {
    agentName: args.spec.slug,
    tenantId: args.tenantId,
    tenantSlug: args.tenantSlug,
    runId: args.runId,
    correlationId: `regression:${args.replayCase.id}`,
    timeoutMs: 8_000,
    memoryMb: 128,
    allowedTools: args.spec.tools,
    toolPolicies: args.spec.toolPolicies,
    hostRuntimeKind: "fixture",
    production: {
      allowProduction: true,
      expectedCodeSha256: args.expectedHash,
      promotionVersionId: args.promotionVersionId,
      regressionSuiteFingerprint: args.regressionSuiteFingerprint,
    },
    executionPurpose: "regression_replay",
    memory: {
      async get<T = unknown>(key: string, scope = "run"): Promise<T | null> {
        const composite = `${scope}:${key}`;
        return memoryValues.has(composite) ? memoryValues.get(composite) as T : null;
      },
      async put<T = unknown>(key: string, value: T, scope = "run"): Promise<void> {
        memoryValues.set(`${scope}:${key}`, value);
      },
      async delete(key: string, scope = "run"): Promise<void> {
        memoryValues.delete(`${scope}:${key}`);
      },
      async search(): Promise<never[]> { return []; },
    },
    hostRuntime: {
      async reason() {
        if (fixture.reasonResult && typeof fixture.reasonResult === "object") return fixture.reasonResult;
        const message = "missing explicit reason fixture";
        fixtureErrors.push(message);
        throw new Error(message);
      },
      async tool(name, toolArgs) {
        toolCalls.push({ name, args: toolArgs });
        const cassette = fixture.toolCassettes?.[name];
        const cassetteEntry = cassette?.entries.find((entry) =>
          entry.request.kind === "tool" &&
          entry.request.toolName === name &&
          entry.key === canonicalToolCassetteKey(name, toolArgs));
        if (cassetteEntry) {
          if (cassetteEntry.response.status >= 200 && cassetteEntry.response.status < 300) return cassetteEntry.response.body;
          if (fixture.allowEvidenceFailures !== true) {
            fixtureErrors.push(`evidence cassette returned HTTP ${cassetteEntry.response.status} for ${name}`);
          }
          throw new Error(`[fixture] evidence cassette returned HTTP ${cassetteEntry.response.status} for ${name}`);
        }
        // Static toolResults are deliberately ignored for external calls in a
        // promotion replay. Older `{ok:true}` structural artifacts therefore
        // fail closed instead of remaining grandfathered green.
        const message = cassette
          ? `no evidence cassette matches tool arguments: ${name}`
          : `missing real cassette/probe evidence for tool: ${name}`;
        fixtureErrors.push(message);
        throw new Error(message);
      },
      async invoke(agentRef, invokeInput) {
        const name = `invoke:${agentRef}`;
        toolCalls.push({ name, args: invokeInput });
        if (has(fixture.invokeResults, agentRef)) return fixture.invokeResults![agentRef];
        if (has(fixture.toolResults, name)) return fixture.toolResults![name];
        const message = `missing explicit invoke fixture: ${agentRef}`;
        fixtureErrors.push(message);
        throw new Error(message);
      },
      log() { /* replay logs are represented by the structured result */ },
    },
    containerTransport: args.containerTransport,
    candidateImage: args.candidateImage,
  });
  const emitNames = run.ok ? run.emitted.map((entry) => entry.event) : [];
  const missing = args.replayCase.expectEmits.filter((event) => !emitNames.includes(event));
  const verdict = gradeFunctionTest({
    ok: true,
    result: {
      ran: run.ok && run.executorStarted,
      ...(!run.ok ? { error: run.error } : { result: run.data }),
      emits: run.ok ? run.emitted.map((entry) => ({ name: entry.event, data: entry.payload })) : [],
      emitNames,
      toolCalls,
      runSteps: [],
      state: Object.fromEntries(memoryValues),
      fixtureErrors,
    },
  }, {
    expectEmits: args.replayCase.expectEmits,
    assertions: args.replayCase.assertions,
  });
  const additionalReasons = [
    ...missing.map((event) => `expected emit not observed: ${event}`),
    ...(run.codeSha256 !== args.expectedHash ? [`runtime code hash mismatch: ${run.codeSha256}`] : []),
    ...run.toolDispatches
      .filter((dispatch) => dispatch.kind !== "fixture")
      .map((dispatch) => `regression tool ${dispatch.tool} used ${dispatch.kind} instead of fixture`),
  ];
  const reasons = [...verdict.reasons, ...additionalReasons];
  return {
    slug: args.spec.slug,
    caseId: args.replayCase.id,
    pass: verdict.pass && run.ok && run.executorStarted && additionalReasons.length === 0,
    ran: verdict.ran,
    emitNames,
    reasons,
    tier: "codeact-container",
    execution: "codeact-runtime",
    codeHash: run.codeSha256,
  };
}

/** Validate the immutable suite identity and execute its persisted TypeScript modules.
 * This is used both by the CLI and immediately before production promotion. */
export async function replayRegressionArtifact(
  artifactPath: string,
  selectedSlugs?: string[],
  options?: RegressionReplayOptions,
): Promise<RegressionReplayResult> {
  const result: RegressionReplayResult = {
    pass: false,
    promotionEvidenceReady: false,
    promotionEvidenceErrors: [],
    artifact: path.resolve(artifactPath),
    results: [],
    errors: [],
  };
  let artifact: PersistedRegressionArtifact;
  try {
    artifact = JSON.parse(await fs.readFile(result.artifact, "utf8")) as PersistedRegressionArtifact;
  } catch (error) {
    result.errors.push(`cannot read regression artifact: ${String((error as Error)?.message ?? error)}`);
    return result;
  }
  result.versionId = artifact.versionId;
  result.evidenceFingerprint = artifact.evidenceFingerprint;
  result.authoritativeOntology = artifact.authoritativeOntology;
  result.suiteFingerprint = artifact.suiteFingerprint;
  result.sandboxCleanupReceiptHash = artifact.sandboxCleanupReceipt?.absenceProbeHash;
  result.sandboxCleanupReceipt = artifact.sandboxCleanupReceipt;
  result.sandboxAppId = artifact.sandboxAppId;
  result.committedManifestFunctionIds = artifact.committedManifestFunctionIds;
  result.sandboxBrokerRegistration = artifact.sandboxBrokerRegistration;
  result.sandboxExecutionReceipt = artifact.sandboxExecutionReceipt;
  result.sandboxModelUsage = artifact.sandboxModelUsage;
  result.sandboxExternalLiveCalls = artifact.externalLiveCalls;
  result.sandboxReplayEvidenceComplete = artifact.sandboxReplayEvidenceComplete;
  result.sandboxReplayReceipts = artifact.replayReceipts ?? [];
  result.effectiveEntryEvents = [
    ...new Set(
      (artifact.effectiveTestCases ?? [])
        .map((testCase) => testCase.entryEvent)
        .filter((event): event is string => typeof event === "string" && event.length > 0),
    ),
  ].sort();
  if (artifact.schema !== REGRESSION_ARTIFACT_SCHEMA) result.errors.push(`unsupported regression schema: ${String(artifact.schema)}`);
  if (!artifact.evidenceFingerprint?.startsWith("sandbox-evidence:v")) result.errors.push("missing canonical sandbox evidence fingerprint");
  if (typeof artifact.modelRequired !== "boolean") result.errors.push("regression artifact does not declare whether semantic model execution is required");
  if (!Array.isArray(artifact.modelRequiredAgentRefs)) result.errors.push("regression artifact does not identify model-requiring agents");
  if (artifact.modelRequired !== ((artifact.modelRequiredAgentRefs?.length ?? 0) > 0)) result.errors.push("regression model requirement summary is inconsistent");
  result.errors.push(...authoritativeOntologyEvidenceIssues(
    artifact.authoritativeOntology,
    { domainId: artifact.domain },
  ).map((issue) => `authoritative ontology evidence: ${issue}`));
  result.errors.push(...sandboxCleanupReceiptIssues(artifact.sandboxCleanupReceipt, {
    candidateFingerprint: artifact.evidenceFingerprint,
    targetDomainId: artifact.domain,
  }));
  result.errors.push(...sandboxRegistrationEvidenceIssues({
    appId: artifact.sandboxAppId,
    committedManifestFunctionIds: artifact.committedManifestFunctionIds,
    brokerRegistration: artifact.sandboxBrokerRegistration,
  }, (artifact.agents ?? []).map((agent) => agent.slug)).map(
    (issue) => `sandbox registration evidence: ${issue}`,
  ));
  result.errors.push(...sandboxExecutionReceiptIssues(
    artifact.sandboxExecutionReceipt,
    {
      candidateFingerprint: artifact.evidenceFingerprint,
      targetDomainId: artifact.domain,
      sandboxAttemptId: artifact.sandboxCleanupReceipt?.sandboxAttemptId,
      modelUsageHash: artifact.sandboxModelUsage?.evidenceHash,
    },
  ).map((issue) => `sandbox execution evidence: ${issue}`));
  result.errors.push(...sandboxModelUsageEvidenceIssues(
    artifact.sandboxModelUsage,
    {
      sandboxAttemptId: artifact.sandboxCleanupReceipt?.sandboxAttemptId,
      modelRequired: artifact.modelRequired,
      requiredAgentRefs: artifact.modelRequiredAgentRefs,
    },
  ).map((issue) => `sandbox model usage: ${issue}`));
  for (const entry of artifact.priorFunctionTester ?? []) {
    if (entry.qualification !== "promotable") {
      result.errors.push(
        `sandbox function tester was not promotable for ${entry.short}`,
      );
    }
  }
  result.errors.push(...sandboxDispatchEvidenceIssues({
    toolMode: artifact.toolMode,
    externalLiveCalls: artifact.externalLiveCalls,
    sandboxReplayEvidenceComplete: artifact.sandboxReplayEvidenceComplete,
    replayReceipts: artifact.replayReceipts,
    cleanupReceipt: artifact.sandboxCleanupReceipt,
    cassetteRefs: artifact.cassetteRefs,
  }).map((issue) => `sandbox dispatch evidence: ${issue}`));
  result.errors.push(...sandboxReviewEvidenceIssues({
    evidenceFingerprint: artifact.evidenceFingerprint,
    sandboxDesignReview: artifact.sandboxDesignReview,
    sandboxAutopilotReview: artifact.sandboxAutopilotReview,
  }).map((issue) => `sandbox review evidence: ${issue}`));
  if (regressionSuiteFingerprint(artifact) !== artifact.suiteFingerprint) result.errors.push("regression suite fingerprint mismatch");
  const cassetteEvidence = await loadCassetteEvidence(
    artifact,
    result.artifact,
    options?.cassetteTrust,
    undefined,
    options?.cassetteTrust === "verified-regression-export"
      ? new Date(artifact.createdAt)
      : undefined,
  );
  result.errors.push(...cassetteEvidence.errors);
  const promotionEvidenceErrors: string[] = [];
  let expectedQualification: RegressionEvidenceQualification | undefined;
  if (!Array.isArray(artifact.promotionToolEvidenceRequirements)) {
    promotionEvidenceErrors.push("promotion cassette evidence requirements are missing");
  } else {
    const summaryIssues = promotionCassetteSummaryIssues(
      artifact.promotionToolEvidenceRequirements,
      artifact.cassetteRefs ?? [],
    );
    expectedQualification = evidenceQualification(summaryIssues);
    promotionEvidenceErrors.push(...summaryIssues.map((issue) =>
      `sandbox cassette evidence: ${issue}`));
    for (const requirement of artifact.promotionToolEvidenceRequirements) {
      if (!cassetteEvidence.documents[requirement.bindingId]) {
        promotionEvidenceErrors.push(
          `sandbox cassette evidence: ${requirement.tool} cassette is unavailable`,
        );
      }
    }
  }
  const storedQualification = artifact.evidenceQualification;
  if (!storedQualification) {
    promotionEvidenceErrors.unshift(
      "artifact has no server-derived evidence qualification; legacy artifacts are replayable but not promotable",
    );
  } else if (
    !expectedQualification
    || canonicalEvidenceJson(storedQualification) !== canonicalEvidenceJson(expectedQualification)
  ) {
    result.errors.push("server-derived evidence qualification has drifted");
  }
  result.promotionEvidenceErrors = [...new Set(promotionEvidenceErrors)];
  result.promotionEvidenceReady = Boolean(
    storedQualification
    && expectedQualification
    && storedQualification.promotion === "candidate"
    && canonicalEvidenceJson(storedQualification) === canonicalEvidenceJson(expectedQualification)
    && promotionEvidenceErrors.length === 0,
  );

  const wanted = selectedSlugs?.length ? new Set(selectedSlugs) : null;
  const selected = artifact.agents.filter((agent) => !wanted || wanted.has(agent.slug));
  if (wanted) {
    const found = new Set(selected.map((agent) => agent.slug));
    for (const slug of wanted) if (!found.has(slug)) result.errors.push(`regression suite does not cover ${slug}`);
  }

  for (const agent of selected) {
    let code: string;
    let runtimeCode: string | undefined;
    let spec: GeneratedAgentSpec;
    try {
      const persistedDraft = JSON.parse(await fs.readFile(resolveArtifactFile(result.artifact, agent.specFile), "utf8")) as {
        spec?: GeneratedAgentSpec;
      };
      if (!persistedDraft.spec) throw new Error("draft has no spec");
      spec = persistedDraft.spec;
      code = await fs.readFile(resolveArtifactFile(result.artifact, agent.moduleFile), "utf8");
      if (regressionSpecHash(spec) !== agent.specHash) throw new Error("spec hash mismatch");
      if (regressionModuleHash(code) !== agent.moduleHash) throw new Error("module hash mismatch");
      if (spec.slug !== agent.slug || spec.short !== agent.short) throw new Error("agent identity mismatch");
      if (spec.codeExecuted === true) {
        if (agent.execution !== "codeact-runtime" || !agent.runtimeCodeFile || !agent.runtimeCodeHash) {
          throw new Error("CodeAct regression artifact does not identify the exact runtime module");
        }
        runtimeCode = await fs.readFile(resolveArtifactFile(result.artifact, agent.runtimeCodeFile), "utf8");
        if (regressionModuleHash(runtimeCode) !== agent.runtimeCodeHash) throw new Error("runtime code hash mismatch");
        if (runtimeCode !== spec.generatedCode) throw new Error("runtime code differs from spec.generatedCode destined for production");
      } else if (agent.execution !== "rendered-module") {
        throw new Error("declarative draft unexpectedly references a CodeAct runtime artifact");
      }
    } catch (error) {
      result.errors.push(`${agent.slug}: ${String((error as Error)?.message ?? error)}`);
      continue;
    }
    if (!agent.cases.length) {
      result.errors.push(`${agent.slug}: no replay cases`);
      continue;
    }
    const agentCassetteEvidence = cassetteDocumentsForAgent(
      artifact,
      cassetteEvidence.documents,
      spec,
    );
    result.errors.push(...agentCassetteEvidence.errors);
    const requiredEvidenceTools = [...new Set(agent.cases.flatMap((entry) => entry.requiredEvidenceTools ?? []))];
    const missingEvidenceTools = requiredEvidenceTools.filter((tool) => !agentCassetteEvidence.documents[tool]);
    if (missingEvidenceTools.length) {
      result.errors.push(`${agent.slug}: 缺少真实 cassette/probe 证据，无法回放工具 ${missingEvidenceTools.join(", ")}`);
      continue;
    }
    for (const replayCase of agent.cases) {
      let materializedBinaryPayload = false;
      try {
        if (replayCase.blockedReasons?.length) {
          result.results.push({
            slug: agent.slug,
            caseId: replayCase.id,
            pass: false,
            ran: false,
            emitNames: [],
            reasons: replayCase.blockedReasons,
            tier: agent.execution === "codeact-runtime" ? "codeact-container" : "worker",
            execution: agent.execution,
            codeHash: agent.execution === "codeact-runtime" ? agent.runtimeCodeHash : agent.moduleHash,
          });
          continue;
        }
        let executableCase = replayCase;
        if (containsFactoryFixtureAssetReference(replayCase.testEvent.data)) {
          if (!replayCase.approvedTestCaseId) {
            throw new Error("binary fixture replay case is not bound to an approved test-case id");
          }
          const conversationId =
            artifact.sandboxDesignReview?.receipt?.conversationId
            ?? artifact.sandboxAutopilotReview?.conversationId;
          if (!conversationId?.trim()) {
            throw new Error("binary fixture replay has no approved conversation scope");
          }
          if (!options?.materializeTestPayload) {
            throw new Error("binary fixture replay requires the tenant-scoped server materializer");
          }
          const data = await options.materializeTestPayload({
            domain: artifact.domain,
            conversationId,
            caseId: replayCase.approvedTestCaseId,
            payload: replayCase.testEvent.data,
          });
          materializedBinaryPayload = true;
          executableCase = {
            ...replayCase,
            testEvent: { ...replayCase.testEvent, data },
          };
        }
        const fixture = {
          ...replayCase.fixture,
          // Promotion ignores historical `{ok:true}` toolResults and injects
          // only definition/content-validated cassette documents. The harness
          // then matches the actual call's argsHash.
          toolResults: Object.fromEntries(Object.entries(replayCase.fixture.toolResults ?? {}).filter(([name]) => name.startsWith("invoke:"))),
          toolCassettes: agentCassetteEvidence.documents,
        };
        if (runtimeCode) {
          const exact = await replayExactCodeAct({
            code: runtimeCode,
            expectedHash: agent.runtimeCodeHash!,
            spec,
            replayCase: { ...executableCase, fixture },
            containerTransport: options?.codeActContainerTransport,
            candidateImage: options?.codeActCandidateImage,
            tenantId: artifact.authoritativeOntology.tenantId,
            tenantSlug: artifact.authoritativeOntology.tenantSlug,
            runId: `regression:${artifact.versionId}:${replayCase.id}`,
            promotionVersionId: artifact.versionId,
            regressionSuiteFingerprint: artifact.suiteFingerprint,
          });
          result.results.push(materializedBinaryPayload
            ? {
                ...exact,
                emitNames: exact.emitNames.filter((event) => (spec.emit ?? []).includes(event)),
                reasons: exact.reasons.length
                  ? ["binary fixture replay failed inside the isolated container; execution details were withheld"]
                  : [],
              }
            : exact);
          continue;
        }
        const run = await testGeneratedFunction(spec, {
          code,
          testEvent: executableCase.testEvent,
          expectEmits: executableCase.expectEmits.length ? executableCase.expectEmits : undefined,
          assertions: executableCase.assertions,
          fixture,
        });
        const replayResult: RegressionReplayResult["results"][number] = {
          slug: agent.slug,
          caseId: replayCase.id,
          pass: run.verdict.pass,
          ran: run.verdict.ran,
          emitNames: materializedBinaryPayload
            ? run.verdict.emitNames.filter((event) => (spec.emit ?? []).includes(event))
            : run.verdict.emitNames,
          reasons: materializedBinaryPayload && run.verdict.reasons.length
            ? ["binary fixture replay failed inside the isolated container; execution details were withheld"]
            : run.verdict.reasons,
          tier: run.tier,
          execution: "rendered-module",
          codeHash: agent.moduleHash,
        };
        result.results.push(replayResult);
      } catch (error) {
        result.results.push({
          slug: agent.slug,
          caseId: replayCase.id,
          pass: false,
          ran: false,
          emitNames: [],
          reasons: [materializedBinaryPayload
            ? "binary fixture replay failed inside the isolated container; execution details were withheld"
            : String((error as Error)?.message ?? error)],
          tier: agent.execution === "codeact-runtime" ? "codeact-container" : "worker",
          execution: agent.execution,
          codeHash: agent.execution === "codeact-runtime" ? agent.runtimeCodeHash : agent.moduleHash,
        });
      }
    }
  }
  result.pass = result.errors.length === 0 && result.results.length > 0 && result.results.every((entry) => entry.pass && entry.ran);
  // Keep the convenience field impossible to misread in UI/API consumers: an
  // artifact that did not actually replay cannot enter the production gate,
  // even if its sealed cassette summary was otherwise well formed.
  if (!result.pass) result.promotionEvidenceReady = false;
  return result;
}
