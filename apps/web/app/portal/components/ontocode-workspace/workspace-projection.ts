import type {
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeBuildSession,
  OntoCodeCandidateHead,
  OntoCodeChangeSet,
  OntoCodeChangeSetOperation,
  OntoCodeCommand,
  OntoCodeEvidenceRecord,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeProject,
  OntoCodePackageVersion,
  OntoCodeSandboxAttempt,
} from "@agentic/contracts";
import {
  WORKSPACE_PHASES,
  type ArtifactLane,
  type SelectedArtifact,
  type WorkspaceSandboxAttemptView,
  type WorkspacePhase,
  type WorkspaceProjection,
} from "./model";

export interface OntoCodeArtifactSummaryProjection {
  artifact: OntoCodeArtifact;
  latestVersion: OntoCodeArtifactVersion;
}

export interface BuildWorkspaceProjectionInput {
  session: OntoCodeBuildSession;
  phase: WorkspacePhase;
  project?: OntoCodeProject;
  commands: OntoCodeCommand[];
  jobs: OntoCodeHarnessJob[];
  messages?: OntoCodeMessage[];
  changeSets: OntoCodeChangeSet[];
  changeSetOperations: OntoCodeChangeSetOperation[];
  artifacts: OntoCodeArtifactSummaryProjection[];
  evidence: OntoCodeEvidenceRecord[];
  candidateHead?: OntoCodeCandidateHead | null;
  candidatePackage?: OntoCodePackageVersion | null;
  /** Distinguishes an exact null Head response from a query not loaded yet. */
  candidateHeadLoaded?: boolean;
  sandboxAttempts?: OntoCodeSandboxAttempt[];
  streamState: string;
  language?: "en" | "zh";
}

interface ProjectedReadinessBinding {
  requirementId: string;
  system: string;
  kind: string | null;
  role: string | null;
  status: string;
  executionSurface: string | null;
  reason: string;
}

interface ProjectedReadinessAction {
  action: string;
  ready: boolean;
  stages: {
    authoring: boolean;
    sandbox: boolean;
    promotion: boolean;
  };
  unresolvedBindings: ProjectedReadinessBinding[];
}

interface ProjectedFactoryReadiness {
  totals: {
    total: number;
    ready: number;
    blocked: number;
    readyActions: string[];
    blockedActions: string[];
  };
  actions: ProjectedReadinessAction[];
}

const AUTONOMY_LABELS: Record<OntoCodeBuildSession["autonomyMode"], string> = {
  guide: "仅分析 · Analysis only",
  copilot: "每步确认 · Confirm each step",
  sandbox_autopilot: "自主执行 · Autonomous",
};

const JOB_STATUS_LABELS: Record<OntoCodeHarnessJob["status"], string> = {
  queued: "Queued",
  leased: "Leased",
  running: "Running",
  waiting_user: "Needs input",
  retry_scheduled: "Retry scheduled",
  failed_recoverable: "Recoverable failure",
  failed_terminal: "Failed",
  cancelled: "Cancelled",
  succeeded: "Succeeded",
};

function shortId(value: string, length = 14): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function latestByCreatedAt<T extends { createdAt: number }>(
  items: T[],
): T | undefined {
  return [...items].sort((left, right) => right.createdAt - left.createdAt)[0];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = textValue(item);
        return text ? [text] : [];
      })
    : [];
}

interface ProjectedCandidateBlocker {
  stage: "runtime" | "verification";
  reason: string;
  system: string | null;
  toolName: string | null;
}

function projectCandidateBlockers(
  packageVersion: OntoCodePackageVersion | null | undefined,
): ProjectedCandidateBlocker[] {
  const validation = objectValue(packageVersion?.validation);
  if (validation?.schema !== "ontocode-candidate-validation/v2") return [];
  const rows = [
    ...(Array.isArray(validation.runtimeBlockers)
      ? validation.runtimeBlockers
      : []),
    ...(Array.isArray(validation.verificationBlockers)
      ? validation.verificationBlockers
      : []),
  ];
  return rows.flatMap((raw) => {
    const blocker = objectValue(raw);
    const stage =
      blocker?.stage === "runtime" || blocker?.stage === "verification"
        ? blocker.stage
        : null;
    const reason = textValue(blocker?.reason);
    if (!blocker || !stage || !reason) return [];
    return [
      {
        stage,
        reason,
        system: textValue(blocker.system),
        toolName: textValue(blocker.toolName),
      } satisfies ProjectedCandidateBlocker,
    ];
  });
}

function projectFactoryReadiness(
  messages: OntoCodeMessage[] | undefined,
): ProjectedFactoryReadiness | null {
  const ordered = [...(messages ?? [])].sort(
    (left, right) => right.createdAt - left.createdAt,
  );
  for (const message of ordered) {
    const receipt = objectValue(message.content.receipt);
    const readiness = objectValue(receipt?.readiness);
    if (readiness?.schema !== "ontocode-factory-readiness/v1") continue;
    const totals = objectValue(readiness.totals);
    if (!totals) continue;
    const actions = Array.isArray(readiness.actions)
      ? readiness.actions.flatMap((rawAction) => {
          const action = objectValue(rawAction);
          const actionName = textValue(action?.action);
          const stages = objectValue(action?.stages);
          if (!action || !actionName || !stages) return [];
          const unresolvedBindings = Array.isArray(action.unresolvedBindings)
            ? action.unresolvedBindings.flatMap((rawBinding) => {
                const binding = objectValue(rawBinding);
                const requirementId = textValue(binding?.requirementId);
                const system = textValue(binding?.system);
                const status = textValue(binding?.status);
                const reason = textValue(binding?.reason);
                if (!requirementId || !system || !status || !reason) return [];
                return [
                  {
                    requirementId,
                    system,
                    kind: textValue(binding?.kind),
                    role: textValue(binding?.role),
                    status,
                    executionSurface: textValue(binding?.executionSurface),
                    reason,
                  } satisfies ProjectedReadinessBinding,
                ];
              })
            : [];
          return [
            {
              action: actionName,
              ready: action?.ready === true,
              stages: {
                authoring: stages.authoring === true,
                sandbox: stages.sandbox === true,
                promotion: stages.promotion === true,
              },
              unresolvedBindings,
            } satisfies ProjectedReadinessAction,
          ];
        })
      : [];
    const count = (value: unknown): number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
    return {
      totals: {
        total: count(totals.total),
        ready: count(totals.ready),
        blocked: count(totals.blocked),
        readyActions: textArray(totals.readyActions),
        blockedActions: textArray(totals.blockedActions),
      },
      actions,
    };
  }
  return null;
}

function artifactLaneKey(
  kind: string,
  language: BuildWorkspaceProjectionInput["language"] = "en",
): {
  id: string;
  title: string;
  icon: ArtifactLane["nodes"][number]["icon"];
  order: number;
} {
  if (/(ontology|scope|rule|blueprint)/i.test(kind)) {
    return {
      id: "ontology",
      title: localized(language, "Ontology / 蓝图", "Ontology / Blueprint"),
      icon: "workflow",
      order: 0,
    };
  }
  if (/(agent|code|package|manifest|prompt)/i.test(kind)) {
    return {
      id: "agents",
      title: localized(language, "Agent 代码", "Agent Code"),
      icon: "agent",
      order: 1,
    };
  }
  if (/(test|simulation|regression|coverage)/i.test(kind)) {
    return {
      id: "tests",
      title: localized(language, "工具 / 测试", "Tools / Tests"),
      icon: "task",
      order: 2,
    };
  }
  if (/(environment|config|tool|binding|profile)/i.test(kind)) {
    return {
      id: "environment",
      title: localized(language, "运行环境", "Environment"),
      icon: "deploy",
      order: 3,
    };
  }
  if (/(harness.?receipt|execution.?receipt|receipt)/i.test(kind)) {
    return {
      id: "receipts",
      title: localized(language, "Harness 执行回执", "Harness Receipts"),
      icon: "library",
      order: 4,
    };
  }
  return {
    id: "artifacts",
    title: localized(language, "其他产物", "Other Artifacts"),
    icon: "library",
    order: 5,
  };
}

function artifactStatus(
  version: OntoCodeArtifactVersion,
): ArtifactLane["nodes"][number]["status"] {
  const raw = version.metadata.status;
  if (raw === "blocked" || raw === "running" || raw === "queued") return raw;
  if (raw === "failed") return "blocked";
  return "complete";
}

function bytesLabel(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1_024))} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function localized(
  language: BuildWorkspaceProjectionInput["language"],
  chinese: string,
  english: string,
): string {
  return language === "zh" ? chinese : english;
}

export function projectArtifactLanes(
  items: OntoCodeArtifactSummaryProjection[],
  language: BuildWorkspaceProjectionInput["language"] = "en",
): ArtifactLane[] {
  const groups = new Map<
    string,
    {
      title: string;
      icon: ArtifactLane["nodes"][number]["icon"];
      order: number;
      nodes: ArtifactLane["nodes"];
    }
  >();
  for (const item of items) {
    const lane = artifactLaneKey(item.artifact.kind, language);
    const group = groups.get(lane.id) ?? {
      title: lane.title,
      icon: lane.icon,
      order: lane.order,
      nodes: [],
    };
    group.nodes.push({
      id: item.artifact.id,
      title: item.artifact.logicalName,
      subtitle: item.artifact.semanticPath ?? item.artifact.kind,
      version: `v${item.latestVersion.version}`,
      status: artifactStatus(item.latestVersion),
      icon: lane.icon,
      meta: `${bytesLabel(item.latestVersion.sizeBytes)} · ${item.latestVersion.contentType}`,
    });
    groups.set(lane.id, group);
  }
  return [...groups.entries()]
    .sort(([, left], [, right]) => left.order - right.order)
    .map(([id, group]) => ({
      id,
      title: group.title,
      subtitle: localized(
        language,
        `${group.nodes.length} 个产物`,
        `${group.nodes.length} artifact${group.nodes.length === 1 ? "" : "s"}`,
      ),
      nodes: group.nodes,
    }));
}

export function projectArtifactDetails(
  items: OntoCodeArtifactSummaryProjection[],
  evidence: OntoCodeEvidenceRecord[],
  candidate?: {
    loaded: boolean;
    sessionRevision: number;
    head: OntoCodeCandidateHead | null;
    packageVersion: OntoCodePackageVersion | null;
  },
): Record<string, SelectedArtifact> {
  const exactCandidate =
    candidate?.loaded === true &&
    candidate.head !== null &&
    candidate.packageVersion !== null &&
    candidate.head.packageVersionId === candidate.packageVersion.id &&
    candidate.head.sessionId === candidate.packageVersion.sessionId
      ? {
          head: candidate.head,
          packageVersion: candidate.packageVersion,
        }
      : null;
  return Object.fromEntries(
    items.map(({ artifact, latestVersion }) => {
      const linked = evidence.filter(
        (item) => item.artifactVersionId === latestVersion.id,
      );
      const failures = linked.filter((item) => item.outcome === "failed");
      const candidateRef = exactCandidate?.packageVersion.artifactRefs.find(
        (item) =>
          item.artifactId === artifact.id &&
          item.artifactVersionId === latestVersion.id &&
          item.blobHash === latestVersion.blobHash,
      );
      const editBlockedReason =
        candidate?.loaded !== true
          ? "Exact Candidate Head is still loading."
          : !exactCandidate
            ? "This Session has no exact Candidate Head to patch."
            : !candidateRef
              ? "This immutable version is not a member of the exact Candidate Head."
              : candidateRef.kind === "agent_manifest"
                ? "The Candidate manifest is managed by the Workspace service and cannot be edited directly."
                : null;
      const detail: SelectedArtifact = {
        id: artifact.id,
        title: artifact.logicalName,
        version: `v${latestVersion.version}`,
        versionId: latestVersion.id,
        contentType: latestVersion.contentType,
        blobHash: latestVersion.blobHash,
        sizeBytes: latestVersion.sizeBytes,
        source: artifact.semanticPath ?? `Generated ${artifact.kind}`,
        contract: `${latestVersion.contentType} · ${shortId(latestVersion.blobHash, 20)}`,
        tests: linked.length
          ? `${linked.length} evidence · ${failures.length} failed`
          : "No evidence linked yet",
        ...(failures[0] ? { blockedBy: failures[0].summary } : {}),
        ...(candidateRef && !editBlockedReason && candidate
          ? {
              candidatePatchContext: {
                expectedSessionRevision: candidate.sessionRevision,
                expectedCandidateHeadRevision: exactCandidate!.head.revision,
                basePackageVersionId: exactCandidate!.packageVersion.id,
                baseDependencyRoot:
                  exactCandidate!.packageVersion.dependencyRoot,
              },
            }
          : {}),
        ...(editBlockedReason ? { editBlockedReason } : {}),
      };
      return [artifact.id, detail];
    }),
  );
}

function receiptDetail(
  receipt: Record<string, unknown> | null,
  preferredKeys: string[],
): string {
  if (!receipt) return "Not recorded";
  const fragments: string[] = [];
  for (const key of preferredKeys) {
    const value = receipt[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      fragments.push(`${key}=${String(value)}`);
    } else if (Array.isArray(value)) {
      fragments.push(`${key}=${value.length}`);
    }
    if (fragments.length === 2) break;
  }
  return fragments.length > 0 ? fragments.join(" · ") : "Receipt recorded";
}

function nestedObject(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return nested !== null &&
    typeof nested === "object" &&
    !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
}

export function projectSandboxAttempts(
  attempts: OntoCodeSandboxAttempt[],
): WorkspaceSandboxAttemptView[] {
  return [...attempts]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((attempt) => {
      const caseVerdicts = nestedObject(attempt.testReceipt, "caseVerdicts");
      const testDetail = attempt.testReceipt
        ? [
            typeof caseVerdicts?.allPass === "boolean"
              ? `allPass=${String(caseVerdicts.allPass)}`
              : null,
            Array.isArray(caseVerdicts?.results)
              ? `cases=${caseVerdicts.results.length}`
              : null,
            Array.isArray(attempt.testReceipt.functionTester)
              ? `functions=${attempt.testReceipt.functionTester.length}`
              : null,
          ]
            .filter((value): value is string => Boolean(value))
            .join(" · ") || "Receipt recorded"
        : "Not recorded";
      const receipts: WorkspaceSandboxAttemptView["receipts"] = [
        {
          id: "registration",
          label: "Registration",
          detail: receiptDetail(attempt.registrationReceipt, [
            "appId",
            "observedFunctionCount",
            "manifestFunctionCount",
          ]),
          status: attempt.registrationReceipt ? "recorded" : "missing",
        },
        {
          id: "execution",
          label: "Execution",
          detail: receiptDetail(attempt.executionReceipt, [
            "executionOrigin",
            "isolationTier",
            "sandboxAttemptId",
          ]),
          status: attempt.executionReceipt ? "recorded" : "missing",
        },
        {
          id: "test",
          label: "Candidate tests",
          detail: testDetail,
          status: attempt.testReceipt ? "recorded" : "missing",
        },
        {
          id: "drain",
          label: "Run drain",
          detail: receiptDetail(attempt.runDrainReceipt, [
            "observedRuns",
            "completedAt",
          ]),
          status: attempt.runDrainReceipt ? "recorded" : "missing",
        },
        {
          id: "cleanup",
          label: "Cleanup",
          detail: receiptDetail(attempt.cleanupReceipt, [
            "deletedAt",
            "absenceProbeHash",
          ]),
          status: attempt.cleanupReceipt ? "recorded" : "missing",
        },
      ];
      return {
        id: attempt.id,
        ordinal: attempt.ordinal,
        packageVersionId: attempt.packageVersionId,
        dependencyRoot: attempt.dependencyRoot,
        testSuiteHash: attempt.testSuiteHash,
        status: attempt.status,
        qualification: attempt.qualification,
        executionOrigin: attempt.executionOrigin,
        isolationTier: attempt.isolationTier,
        candidateFingerprint: attempt.candidateFingerprint,
        bundleHash: attempt.bundleHash,
        errorMessage: attempt.errorMessage,
        receipts,
      };
    });
}

function evidenceStatus(
  outcome: OntoCodeEvidenceRecord["outcome"],
): "complete" | "warning" | "pending" {
  if (outcome === "passed") return "complete";
  if (outcome === "failed") return "warning";
  return "pending";
}

function normalizedSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function evidenceOntologyHash(item: OntoCodeEvidenceRecord): string | null {
  return normalizedSha256(item.dependencySet.ontologyHash);
}

function isHarnessVerificationEvidence(item: OntoCodeEvidenceRecord): boolean {
  return (
    (item.kind === "harness_test" || item.kind === "harness_regression") &&
    item.state === "valid" &&
    item.subjectType === "candidate_package" &&
    item.producer.startsWith("ontocode-harness-worker/") &&
    item.dependencySet.sandboxQualification === "promotable" &&
    item.validityPredicate.sandboxQualification === "promotable" &&
    typeof item.dependencySet.ontocodeSandboxAttemptId === "string" &&
    item.dependencySet.ontocodeSandboxAttemptId.length > 0 &&
    typeof item.dependencySet.testSuiteHash === "string" &&
    item.dependencySet.testSuiteHash.length > 0 &&
    item.validityPredicate.verificationVerdict === "all_cases_passed"
  );
}

const BLOCKING_SESSION_ACTIVITIES = new Set<
  OntoCodeBuildSession["activityState"]
>([
  "ai_planning",
  "queued",
  "running",
  "needs_user",
  "blocked_external",
  "failed_recoverable",
  "paused",
  "cancelled",
]);

const BLOCKING_JOB_STATUSES = new Set<OntoCodeHarnessJob["status"]>([
  "queued",
  "leased",
  "running",
  "waiting_user",
  "retry_scheduled",
  "failed_recoverable",
  "failed_terminal",
]);

export interface WorkspaceReleaseReadiness {
  ready: boolean;
  blockers: string[];
  candidateArtifactVersionIds: string[];
  verificationEvidenceIds: string[];
}

/**
 * A release candidate is evidence-backed, not merely "later in the UI".
 * Informational Scope/Blueprint/Build receipts can never satisfy this gate.
 */
export function evaluateWorkspaceReleaseReadiness(
  input: BuildWorkspaceProjectionInput,
): WorkspaceReleaseReadiness {
  const blockers: string[] = [];
  const ontologyHash = normalizedSha256(input.session.ontologySnapshotHash);
  const environmentProfileVersionId = input.session.environmentProfileVersionId;
  const legacyCandidateArtifacts = input.artifacts.filter(
    ({ artifact, latestVersion }) =>
      artifact.kind === "agent_code" &&
      latestVersion.sizeBytes > 0 &&
      normalizedSha256(latestVersion.metadata.ontologyHash) === ontologyHash,
  );
  const candidatePackage =
    input.candidateHead &&
    input.candidatePackage &&
    input.candidateHead.packageVersionId === input.candidatePackage.id &&
    input.candidatePackage.sessionId === input.session.id
      ? input.candidatePackage
      : null;
  const candidateArtifactVersionIds = candidatePackage
    ? candidatePackage.artifactRefs
        .filter((artifact) => artifact.kind === "agent_code")
        .map((artifact) => artifact.artifactVersionId)
    : input.candidatePackage === undefined
      ? legacyCandidateArtifacts.map(({ latestVersion }) => latestVersion.id)
      : [];
  const candidateBlockers = projectCandidateBlockers(candidatePackage);
  const currentVerification = ontologyHash
    ? input.evidence.filter(
        (item) =>
          (item.kind === "harness_test" ||
            item.kind === "harness_regression") &&
          item.state === "valid" &&
          evidenceOntologyHash(item) === ontologyHash &&
          item.dependencySet.environmentProfileVersionId ===
            environmentProfileVersionId &&
          (!candidatePackage ||
            (item.dependencySet.candidatePackageVersionId ===
              candidatePackage.id &&
              item.dependencySet.candidateDependencyRoot ===
                candidatePackage.dependencyRoot)),
      )
    : [];
  const conclusivePassedVerification = currentVerification.filter(
    (item) => item.outcome === "passed" && isHarnessVerificationEvidence(item),
  );
  const latestJob = latestByCreatedAt(input.jobs);
  const hasPendingCommand = input.commands.some(
    (command) =>
      command.status === "proposed" ||
      command.status === "awaiting_approval" ||
      command.status === "queued" ||
      command.status === "running",
  );

  if (!ontologyHash) {
    blockers.push(
      localized(
        input.language,
        "当前 Session 尚未固定 Ontology snapshot。",
        "This Session has not pinned an Ontology snapshot.",
      ),
    );
  }
  if (!environmentProfileVersionId) {
    blockers.push(
      localized(
        input.language,
        "当前 Session 尚未绑定经过验证的 Environment profile。",
        "This Session has no verified Environment profile.",
      ),
    );
  }
  if (!candidatePackage && input.candidatePackage !== undefined) {
    blockers.push(
      localized(
        input.language,
        "尚无后端验收并移动 Candidate Head 的完整 Agent Package（Spec、Code、Manifest、Config 与 Execution Owner）。",
        "No backend-validated Candidate Head exists with a complete Agent Package (Spec, Code, Manifest, Config, and Execution Owner).",
      ),
    );
  } else if (
    candidatePackage &&
    normalizedSha256(candidatePackage.ontologyHash) !== ontologyHash
  ) {
    blockers.push(
      localized(
        input.language,
        "当前 Candidate Package 不属于本 Session 固定的 Ontology snapshot。",
        "The current Candidate Package is not bound to this Session's pinned Ontology snapshot.",
      ),
    );
  } else if (
    candidatePackage &&
    candidatePackage.status !== "verified_candidate"
  ) {
    blockers.push(
      localized(
        input.language,
        "当前 Candidate 仅完成构建或开发级诊断；尚未通过具备远程隔离与完整回执的 Sandbox 验证。",
        "The current Candidate is only built or development-diagnosed; it has not passed a remotely isolated Sandbox with complete receipts.",
      ),
    );
  } else if (candidateArtifactVersionIds.length === 0) {
    blockers.push(
      localized(
        input.language,
        "Candidate Package 中没有可验证的 Agent code Artifact Version。",
        "The Candidate Package contains no verifiable Agent code Artifact Version.",
      ),
    );
  }
  for (const candidateBlocker of candidateBlockers) {
    const target =
      candidateBlocker.system ??
      candidateBlocker.toolName ??
      localized(input.language, "外部集成", "external integration");
    blockers.push(
      localized(
        input.language,
        `Candidate ${candidateBlocker.stage === "runtime" ? "运行" : "验证"}阻塞 · ${target}：${candidateBlocker.reason}`,
        `Candidate ${candidateBlocker.stage} blocker · ${target}: ${candidateBlocker.reason}`,
      ),
    );
  }
  if (conclusivePassedVerification.length === 0) {
    blockers.push(
      localized(
        input.language,
        "尚无与当前 Ontology hash 绑定、结论明确且全部通过的 Harness test/regression evidence。",
        "No conclusive, fully passing Harness test/regression evidence is bound to the current Ontology hash.",
      ),
    );
  }
  if (
    currentVerification.some(
      (item) =>
        item.outcome !== "passed" || !isHarnessVerificationEvidence(item),
    )
  ) {
    blockers.push(
      localized(
        input.language,
        "当前 Ontology snapshot 仍有失败或不确定的 test/regression evidence。",
        "The current Ontology snapshot still has failed or inconclusive test/regression evidence.",
      ),
    );
  }
  if (BLOCKING_SESSION_ACTIVITIES.has(input.session.activityState)) {
    blockers.push(
      localized(
        input.language,
        `Session 当前活动状态为 ${input.session.activityState}，需先完成或解除阻塞。`,
        `The Session activity is ${input.session.activityState}; finish or resolve it first.`,
      ),
    );
  }
  if (latestJob && BLOCKING_JOB_STATUSES.has(latestJob.status)) {
    blockers.push(
      localized(
        input.language,
        `最新 Harness job 状态为 ${JOB_STATUS_LABELS[latestJob.status]}。`,
        `The latest Harness Job is ${JOB_STATUS_LABELS[latestJob.status]}.`,
      ),
    );
  }
  if (hasPendingCommand) {
    blockers.push(
      localized(
        input.language,
        "仍有尚未完成的 Command。",
        "A Command is still incomplete.",
      ),
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    candidateArtifactVersionIds,
    verificationEvidenceIds: conclusivePassedVerification.map(
      (item) => item.id,
    ),
  };
}

export function projectPersistedCompletedPhases(
  input: BuildWorkspaceProjectionInput,
): WorkspacePhase[] {
  const completed = new Set<WorkspacePhase>();
  const add = (...phases: WorkspacePhase[]) => {
    for (const phase of phases) completed.add(phase);
  };

  switch (input.session.phase) {
    case "configure":
    case "blueprint":
      add("scope");
      break;
    case "build":
      add("scope", "blueprint");
      break;
    case "verify":
    case "debug":
      add("scope", "blueprint", "build");
      break;
    case "review":
      add("scope", "blueprint", "build", "tests");
      break;
    case "release":
    case "observe":
    case "completed":
      add("scope", "blueprint", "build", "tests", "review");
      break;
    default:
      break;
  }

  for (const job of input.jobs) {
    if (job.status !== "succeeded") continue;
    if (job.kind === "scope") add("scope");
    if (job.kind === "blueprint") add("blueprint");
    if (job.kind === "build") add("build");
    if (job.kind === "debug") add("debug");
    if (job.kind === "promotion") add("review");
    if (job.kind === "deploy") add("release");
  }
  if (
    input.evidence.some(
      (item) =>
        item.state === "valid" &&
        item.outcome === "passed" &&
        isHarnessVerificationEvidence(item),
    )
  ) {
    add("tests");
  }
  if (
    input.evidence.some(
      (item) =>
        item.kind === "harness_regression" &&
        item.state === "valid" &&
        item.outcome === "passed" &&
        isHarnessVerificationEvidence(item),
    )
  ) {
    add("review");
  }

  return WORKSPACE_PHASES.filter((phase) => completed.has(phase));
}

function buildGuidance(
  session: OntoCodeBuildSession,
  phase: WorkspacePhase,
  latestJob: OntoCodeHarnessJob | undefined,
  pendingCommand: OntoCodeCommand | undefined,
  readiness: ProjectedFactoryReadiness | null,
  language: BuildWorkspaceProjectionInput["language"],
): WorkspaceProjection["guidance"] {
  if (session.activityState === "needs_user") {
    const waitingMessage = latestJob?.errorMessage ?? "";
    const deferredActionNames = [
      ...waitingMessage.matchAll(/动作「([^」]+)」/g),
    ]
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean)
      .filter((name, index, values) => values.indexOf(name) === index);
    const structuredBlockedActions =
      readiness?.actions.filter(
        (action) => !action.ready && action.unresolvedBindings.length > 0,
      ) ?? [];
    const structuredDeferredActionNames = structuredBlockedActions.map(
      (action) => action.action,
    );
    const actionableDeferredActionNames =
      structuredDeferredActionNames.length > 0
        ? structuredDeferredActionNames
        : deferredActionNames;
    const isMissingIntegrationContract =
      structuredBlockedActions.length > 0 ||
      (deferredActionNames.length > 0 &&
        /catalog_readiness_requires_authoritative_input|integration_bindings|尚无任何已授权的工具|no authorized tool/i.test(
          waitingMessage,
        ));
    const readinessItems = structuredBlockedActions.flatMap((action) =>
      action.unresolvedBindings.map((binding) => {
        const statusLabel =
          binding.status === "missing"
            ? localized(language, "缺少真实契约", "Missing real contract")
            : binding.status === "needs_probe"
              ? localized(language, "需要真实 Probe", "Real probe required")
              : localized(language, "需要配置", "Configuration required");
        return {
          id: `${action.action}:${binding.requirementId}`,
          title: `${action.action} · ${binding.system}`,
          detail: binding.reason,
          statusLabel,
          status: "configuration" as const,
          actions: [
            {
              label:
                binding.status === "missing"
                  ? localized(
                      language,
                      "补充 API contract",
                      "Provide API contract",
                    )
                  : localized(language, "前往精准配置", "Open exact setup"),
              type: "open_configuration_task" as const,
              variant: "primary" as const,
              payload: {
                sourceWaitingJobId: latestJob?.id ?? null,
                actionName: action.action,
                requirementId: binding.requirementId,
                system: binding.system,
                integrationKind: binding.kind,
                integrationRole: binding.role,
                readinessStatus: binding.status,
                executionSurface: binding.executionSurface,
                reason: binding.reason,
              },
            },
            ...(binding.status === "missing"
              ? [
                  {
                    label: localized(
                      language,
                      "保留为人工边界",
                      "Keep manual boundary",
                    ),
                    type: "confirm_manual_boundary" as const,
                    variant: "secondary" as const,
                    payload: {
                      actionNames: [action.action],
                      system: binding.system,
                    },
                  },
                ]
              : []),
          ],
        };
      }),
    );
    return {
      id: "needs-fde-answer",
      title: localized(
        language,
        "OntoCode 正在等待 FDE 回答",
        "OntoCode is waiting for an FDE answer",
      ),
      statusLabel: localized(language, "需要决策", "Decision required"),
      status: "attention",
      reason:
        latestJob?.errorMessage ??
        localized(
          language,
          "Harness 已保存问题与上下文，并暂停依赖该答案的执行。",
          "Harness persisted the question and context and paused the dependent execution.",
        ),
      impact: latestJob
        ? `${latestJob.kind} · ${latestJob.id}`
        : localized(language, "当前 Build Session", "Current Build Session"),
      recommendation: localized(
        language,
        isMissingIntegrationContract
          ? `推荐先继续生成其余已就绪 Agent，并把 ${actionableDeferredActionNames.join("、")} 作为同一 Session 内可追踪的 deferred integration；不会使用 mock，也不会把缺失契约标成已完成。`
          : "请直接在左侧对话中回答 OntoCode 的问题。答案会先持久化，再进入下一次 Harness/Factory goal；系统不会自动替你选择推荐项。",
        isMissingIntegrationContract
          ? `Continue the other ready Agents first and keep ${actionableDeferredActionNames.join(", ")} as a traceable deferred integration in this Session. No mock is used, and the missing contract is never marked complete.`
          : "Answer OntoCode directly in chat. The answer is persisted before it enters the next Harness/Factory goal; the system will not choose a recommended option for you.",
      ),
      ...(readinessItems.length > 0
        ? {
            items: [
              ...(readiness && readiness.totals.ready > 0
                ? [
                    {
                      id: "ready-actions",
                      title: localized(
                        language,
                        `${readiness.totals.ready} 个 Action 已可生成草稿`,
                        `${readiness.totals.ready} Actions are ready for authoring`,
                      ),
                      detail: readiness.totals.readyActions.join(" · "),
                      statusLabel: localized(
                        language,
                        "可继续",
                        "Ready to continue",
                      ),
                      status: "ready" as const,
                      actions: [
                        {
                          label: localized(
                            language,
                            "先生成这些 Agent",
                            "Build these Agents first",
                          ),
                          type: "continue_ready_actions" as const,
                          variant: "primary" as const,
                          payload: {
                            actionNames: actionableDeferredActionNames,
                          },
                        },
                      ],
                    },
                  ]
                : []),
              ...readinessItems,
            ],
          }
        : {}),
      ...(isMissingIntegrationContract
        ? {
            actions: [
              {
                label: localized(
                  language,
                  "先生成其余已就绪 Agent",
                  "Build the other ready Agents",
                ),
                type: "continue_ready_actions" as const,
                variant: "primary" as const,
                payload: { actionNames: actionableDeferredActionNames },
              },
              {
                label: localized(
                  language,
                  readiness ? "接入真实 API contract" : "重新检查并定位配置",
                  readiness
                    ? "Connect the real API contract"
                    : "Recheck and locate configuration",
                ),
                type: "configure" as const,
                variant: "secondary" as const,
              },
              {
                label: localized(
                  language,
                  "保留为人工边界",
                  "Keep as a manual boundary",
                ),
                type: "confirm_manual_boundary" as const,
                variant: "secondary" as const,
                payload: {
                  actionNames: actionableDeferredActionNames,
                  system: waitingMessage.includes("Internal_Recruitment_System")
                    ? "Internal_Recruitment_System"
                    : null,
                },
              },
            ],
          }
        : {}),
    };
  }
  if (session.activityState === "blocked_external") {
    return {
      id: "needs-input",
      title: localized(
        language,
        "OntoCode 需要 FDE 补充外部配置",
        "OntoCode needs external configuration from the FDE",
      ),
      statusLabel: localized(language, "配置阻塞", "Configuration blocked"),
      status: "attention",
      reason:
        latestJob?.errorMessage ??
        localized(
          language,
          "Harness 已暂停依赖外部配置的步骤，其余可安全工作仍可继续。",
          "Harness paused steps that depend on external configuration; other safe work may continue.",
        ),
      impact: latestJob
        ? `${latestJob.kind} · ${latestJob.id}`
        : localized(language, "当前 Build Session", "Current Build Session"),
      recommendation: localized(
        language,
        "前往真实 Integration Settings 完成配置；不要在聊天中粘贴 secret。",
        "Complete the setup in real Integration Settings; never paste secrets into chat.",
      ),
      actions: [
        {
          label: localized(language, "前往配置", "Open configuration"),
          type: "configure",
          variant: "primary",
        },
        {
          label: localized(language, "调整计划", "Adjust plan"),
          type: "adjust_plan",
          variant: "secondary",
        },
      ],
    };
  }
  if (session.activityState === "failed_recoverable") {
    const canRerunTests =
      latestJob?.kind === "test" ||
      latestJob?.kind === "simulation" ||
      latestJob?.kind === "regression";
    return {
      id: "recoverable-failure",
      title: localized(
        language,
        "Harness 发现可恢复问题",
        "Harness found a recoverable issue",
      ),
      statusLabel: localized(language, "可继续调试", "Debugging available"),
      status: "attention",
      reason:
        latestJob?.errorMessage ??
        localized(
          language,
          "执行未完成，但状态与证据已保存。",
          "Execution did not complete, but its state and evidence were saved.",
        ),
      impact: latestJob
        ? `${latestJob.kind} · ${latestJob.id}`
        : localized(language, "当前执行", "Current execution"),
      recommendation: localized(
        language,
        "让 OntoCode 分析失败证据并生成最小修复方案。",
        "Ask OntoCode to analyze failure evidence and generate the smallest repair.",
      ),
      actions: [
        {
          label: localized(language, "分析失败并修复", "Analyze and repair"),
          type: "adjust_plan",
          variant: "primary",
        },
        ...(canRerunTests
          ? [
              {
                label: localized(language, "重新运行测试", "Run tests again"),
                type: "run_tests" as const,
                variant: "secondary" as const,
              },
            ]
          : []),
      ],
    };
  }
  if (session.activityState === "review_required") {
    const productionDeploy = pendingCommand?.riskClass === "production_deploy";
    return {
      id: "review-required",
      title: localized(
        language,
        "候选变更正在等待 FDE 审批",
        "Candidate changes are waiting for FDE approval",
      ),
      statusLabel: "Human gate",
      status: "informational",
      reason:
        pendingCommand?.rationaleSummary ??
        localized(
          language,
          "OntoCode 不会自动跨过需要人工授权的外部写入或发布门禁。",
          "OntoCode never crosses external-write or release gates that require human authorization.",
        ),
      impact: pendingCommand
        ? `${pendingCommand.type} · ${shortId(pendingCommand.id, 18)} · ${pendingCommand.riskClass}`
        : localized(language, "当前 Build Session", "Current Build Session"),
      recommendation: productionDeploy
        ? localized(
            language,
            "当前版本尚未接入生产部署执行器；可以拒绝该请求或先完成真实部署配置，不能把审批伪装成已上线。",
            "No production deployment executor is connected. Reject the request or configure a real deployment first; approval cannot be presented as a completed release.",
          )
        : localized(
            language,
            "检查 Changes、Tests 与 Evidence 后，再批准或拒绝对应 Command。",
            "Review Changes, Tests, and Evidence before approving or rejecting the Command.",
          ),
      actions: pendingCommand
        ? [
            ...(productionDeploy
              ? [
                  {
                    label: localized(
                      language,
                      "配置部署能力",
                      "Configure deployment",
                    ),
                    type: "configure" as const,
                    variant: "primary" as const,
                  },
                ]
              : [
                  {
                    label: localized(
                      language,
                      "批准 Command",
                      "Approve Command",
                    ),
                    type: "approve_command" as const,
                    payload: { commandId: pendingCommand.id },
                    variant: "primary" as const,
                  },
                ]),
            {
              label: localized(language, "拒绝 Command", "Reject Command"),
              type: "reject_command" as const,
              payload: { commandId: pendingCommand.id },
              variant: "secondary" as const,
            },
          ]
        : undefined,
    };
  }
  const recommendations: Record<
    WorkspacePhase,
    Pick<
      NonNullable<WorkspaceProjection["guidance"]>,
      "title" | "recommendation"
    >
  > = {
    scope: {
      title: localized(
        language,
        "从目标中固定 Ontology 范围",
        "Pin Ontology scope from the goal",
      ),
      recommendation: localized(
        language,
        "描述要实现的业务结果；OntoCode 会先澄清边界，再调用 Harness。",
        "Describe the desired business outcome. OntoCode will clarify boundaries before invoking Harness.",
      ),
    },
    blueprint: {
      title: localized(
        language,
        "把 Ontology Action 编译成 Agent Blueprint",
        "Compile Ontology Actions into an Agent Blueprint",
      ),
      recommendation: localized(
        language,
        "确认 Agent 边界、事件契约、工具与人工决策点。",
        "Confirm Agent boundaries, event contracts, tools, and human decision points.",
      ),
    },
    build: {
      title: localized(
        language,
        "生成可测试的 Agent Package",
        "Generate a testable Agent Package",
      ),
      recommendation: localized(
        language,
        "继续在对话中描述修改；每次执行都会形成可审计 Command 与版本。",
        "Describe changes in chat. Every execution creates an auditable Command and version.",
      ),
    },
    tests: {
      title: localized(
        language,
        "补齐并运行验证矩阵",
        "Complete and run the verification matrix",
      ),
      recommendation: localized(
        language,
        "优先生成契约、Simulation 与回归证据，再处理真实系统 E2E。",
        "Generate contract, simulation, and regression evidence before real-system E2E.",
      ),
    },
    debug: {
      title: localized(
        language,
        "从失败证据生成最小补丁",
        "Generate the smallest patch from failure evidence",
      ),
      recommendation: localized(
        language,
        "让 OntoCode 关联失败、Ontology rule 与工具配置，再迭代版本。",
        "Let OntoCode connect the failure, Ontology rule, and tool configuration before iterating.",
      ),
    },
    review: {
      title: localized(
        language,
        "审查候选版本与上线门禁",
        "Review the candidate and release gates",
      ),
      recommendation: localized(
        language,
        "确认变更、风险、测试、Evidence 和回滚方案。",
        "Confirm changes, risks, tests, Evidence, and the rollback plan.",
      ),
    },
    release: {
      title: localized(
        language,
        "准备不可变 Release Candidate",
        "Prepare an immutable Release Candidate",
      ),
      recommendation: localized(
        language,
        "生产部署必须经过单独的人工批准与部署执行器。",
        "Production deployment requires separate human approval and a real deployment executor.",
      ),
    },
  };
  return {
    id: `next-${phase}`,
    title: recommendations[phase].title,
    statusLabel: latestJob
      ? JOB_STATUS_LABELS[latestJob.status]
      : localized(language, "AI 建议", "AI recommendation"),
    status: "informational",
    reason: latestJob
      ? `${latestJob.kind} · ${shortId(latestJob.id)}`
      : localized(
          language,
          "当前还没有 Harness job。",
          "There is no Harness Job yet.",
        ),
    recommendation: recommendations[phase].recommendation,
  };
}

export function buildWorkspaceProjection(
  input: BuildWorkspaceProjectionInput,
): {
  projection: WorkspaceProjection;
  artifactLanes: ArtifactLane[];
} {
  const latestJob = latestByCreatedAt(input.jobs);
  const readiness = projectFactoryReadiness(input.messages);
  const pendingCommand = input.commands.find(
    (command) =>
      command.status === "awaiting_approval" || command.status === "proposed",
  );
  const latestChangeSet = latestByCreatedAt(input.changeSets);
  const details = projectArtifactDetails(input.artifacts, input.evidence, {
    loaded: input.candidateHeadLoaded === true,
    sessionRevision: input.session.revision,
    head: input.candidateHead ?? null,
    packageVersion: input.candidatePackage ?? null,
  });
  const artifactLanes = projectArtifactLanes(input.artifacts, input.language);
  const sandboxAttempts = projectSandboxAttempts(input.sandboxAttempts ?? []);
  // Selection is interaction state, not a persisted fact. Keep the inspector
  // closed until the FDE (or an explicit conversational navigation receipt)
  // chooses an immutable version.
  const selectedArtifact = null;
  const passed = input.evidence.filter(
    (item) => item.outcome === "passed",
  ).length;
  const failed = input.evidence.filter(
    (item) => item.outcome === "failed",
  ).length;
  const pending = input.evidence.length - passed - failed;
  const testEvidence = input.evidence.filter((item) =>
    /(test|simulation|regression|coverage)/i.test(item.kind),
  );
  const ontologyHash = normalizedSha256(input.session.ontologySnapshotHash);
  const runnableAgentVersions = input.artifacts.filter(
    ({ artifact, latestVersion }) =>
      artifact.kind === "agent_code" &&
      latestVersion.sizeBytes > 0 &&
      normalizedSha256(latestVersion.metadata.ontologyHash) === ontologyHash,
  );
  const candidateBlockers = projectCandidateBlockers(input.candidatePackage);
  const exactCandidateRunnable =
    input.candidateHead !== null &&
    input.candidatePackage !== null &&
    input.candidateHead !== undefined &&
    input.candidatePackage !== undefined &&
    input.candidateHead.packageVersionId === input.candidatePackage.id &&
    runnableAgentVersions.some(({ latestVersion }) =>
      input.candidatePackage!.artifactRefs.some(
        (ref) =>
          ref.kind === "agent_code" &&
          ref.artifactVersionId === latestVersion.id &&
          ref.blobHash === latestVersion.blobHash,
      ),
    );
  const candidateCanEnterVerification =
    exactCandidateRunnable && candidateBlockers.length === 0;
  const operationStatus =
    latestChangeSet?.status === "committed"
      ? "applied"
      : latestChangeSet?.status === "abandoned"
        ? "blocked"
        : "ready";
  const releaseReadiness = evaluateWorkspaceReleaseReadiness(input);
  const releaseReady = releaseReadiness.ready;

  const projection: WorkspaceProjection = {
    context: {
      domain: { value: input.project?.domain ?? "Ontology Domain" },
      project: { value: input.project?.name ?? input.session.title },
      session: { value: shortId(input.session.id, 18) },
      ontologySnapshot: {
        value: input.session.ontologySnapshotHash
          ? shortId(input.session.ontologySnapshotHash, 18)
          : "Snapshot pending",
      },
      changeSet: {
        value: latestChangeSet
          ? `${latestChangeSet.status} · ${shortId(latestChangeSet.id, 16)}`
          : "No active Change Set",
      },
      environment: {
        value: input.session.environmentProfileVersionId
          ? shortId(input.session.environmentProfileVersionId, 18)
          : "Environment not bound",
      },
      autonomy: { value: AUTONOMY_LABELS[input.session.autonomyMode] },
      activity: {
        label: `${input.phase[0]!.toUpperCase()}${input.phase.slice(1)} · ${
          latestJob
            ? JOB_STATUS_LABELS[latestJob.status]
            : input.session.activityState
        }`,
        detail: `Session stream ${input.streamState}`,
        tone:
          input.session.activityState === "needs_user" ||
          input.session.activityState === "blocked_external" ||
          input.session.activityState === "failed_recoverable"
            ? "warning"
            : latestJob?.status === "running" || latestJob?.status === "leased"
              ? "running"
              : input.session.phase === "completed"
                ? "success"
                : "neutral",
      },
    },
    contextRefs: [
      ...(input.session.ontologySnapshotHash
        ? [
            `ontology:${input.session.ontologySnapshotHash.replace(
              /^sha256:/,
              "",
            )}`,
          ]
        : []),
      ...(latestChangeSet ? [`changeset:${latestChangeSet.id}`] : []),
      ...input.artifacts
        .slice(0, 2)
        .map((item) => `artifact:${item.artifact.id}@${item.latestVersion.id}`),
    ],
    completedPhases: projectPersistedCompletedPhases(input),
    guidance: buildGuidance(
      input.session,
      input.phase,
      latestJob,
      pendingCommand,
      readiness,
      input.language,
    ),
    receipts: [
      {
        id: "ontology",
        label: input.session.ontologySnapshotHash
          ? "Ontology snapshot pinned"
          : "Ontology snapshot pending",
        status: input.session.ontologySnapshotHash ? "complete" : "warning",
      },
      {
        id: "candidate",
        label: input.candidatePackage
          ? localized(
              input.language,
              `Candidate · ${input.candidatePackage.status}${
                candidateBlockers.length > 0
                  ? ` · ${candidateBlockers.length} 项阻塞`
                  : ""
              } · ${shortId(
                input.candidatePackage.dependencyRoot,
                12,
              )}`,
              `Candidate · ${input.candidatePackage.status}${
                candidateBlockers.length > 0
                  ? ` · ${candidateBlockers.length} blocker(s)`
                  : ""
              } · ${shortId(
                input.candidatePackage.dependencyRoot,
                12,
              )}`,
            )
          : localized(
              input.language,
              "Candidate Package 尚未就绪",
              "Candidate Package not ready",
            ),
        status:
          input.candidatePackage && candidateBlockers.length === 0
            ? "complete"
            : "warning",
      },
      {
        id: "changeset",
        label: latestChangeSet
          ? `Change Set ${shortId(latestChangeSet.id)} · ${latestChangeSet.status}`
          : "No Change Set yet",
        status: latestChangeSet ? "complete" : "neutral",
      },
      {
        id: "harness",
        label: latestJob
          ? `Harness ${shortId(latestJob.id)} · ${JOB_STATUS_LABELS[latestJob.status]}`
          : "Harness waiting for a command",
        status:
          latestJob?.status === "succeeded"
            ? "complete"
            : latestJob?.status === "running" || latestJob?.status === "leased"
              ? "running"
              : latestJob?.status.startsWith("failed") ||
                  latestJob?.status === "waiting_user"
                ? "warning"
                : "neutral",
      },
    ],
    tabCounts: {
      map: input.artifacts.length,
      changes: input.changeSetOperations.length,
      tests: testEvidence.length + sandboxAttempts.length,
      evidence: input.evidence.length + sandboxAttempts.length,
    },
    testRun: {
      ready: candidateCanEnterVerification,
      ...(candidateCanEnterVerification
        ? {}
        : {
            blocker: localized(
              input.language,
              candidateBlockers[0]
                ? `Candidate 已保存，但 ${candidateBlockers[0].stage === "runtime" ? "运行" : "验证"}仍被阻塞：${candidateBlockers[0].reason}`
                : "请先完成 Build，并生成与当前 Ontology snapshot 绑定的精确 Agent code Candidate。",
              candidateBlockers[0]
                ? `The Candidate is saved, but ${candidateBlockers[0].stage} is blocked: ${candidateBlockers[0].reason}`
                : "Finish Build and generate an exact Agent code Candidate bound to the current Ontology snapshot.",
            ),
          }),
    },
    changeSet: latestChangeSet
      ? {
          title: `Change Set ${shortId(latestChangeSet.id, 20)}`,
          subtitle: `${latestChangeSet.status} · ${input.changeSetOperations.length} operations · base ${shortId(
            latestChangeSet.baseOntologyHash ?? "unbound",
            18,
          )}`,
          rows: input.changeSetOperations.map((operation) => ({
            id: operation.id,
            operation: operation.operation,
            target: operation.semanticPath,
            summary:
              operation.operation === "move" && operation.fromSemanticPath
                ? `from ${operation.fromSemanticPath}`
                : `${operation.sourceRefs.length} source refs · ${operation.invalidates.length} invalidations`,
            status: operationStatus,
            statusLabel: latestChangeSet.status,
          })),
        }
      : null,
    tests: testEvidence.length
      ? {
          title: "Harness test evidence",
          subtitle: `${testEvidence.filter((item) => item.outcome === "passed").length} passed · ${
            testEvidence.filter((item) => item.outcome === "failed").length
          } failed`,
          metrics: [
            {
              id: "passed",
              label: "Passed",
              value: String(passed),
              tone: "success",
            },
            {
              id: "failed",
              label: "Failed",
              value: String(failed),
              tone: failed ? "danger" : "neutral",
            },
            {
              id: "pending",
              label: "Pending",
              value: String(pending),
              tone: pending ? "warning" : "neutral",
            },
            {
              id: "total",
              label: "Evidence",
              value: String(input.evidence.length),
            },
          ],
          suites: testEvidence.map((item) => ({
            id: item.id,
            name: item.kind,
            total: 1,
            passed: item.outcome === "passed" ? 1 : 0,
            failed: item.outcome === "failed" ? 1 : 0,
            blocked: item.outcome === "inconclusive" ? 1 : 0,
          })),
          sandboxAttempts,
          allowRun: true,
          allowDebug: failed > 0,
        }
      : sandboxAttempts.length
        ? {
            title: localized(
              input.language,
              "精确 Candidate Sandbox",
              "Exact Candidate Sandbox",
            ),
            subtitle: localized(
              input.language,
              `${sandboxAttempts.length} 次持久化尝试 · 不从位置推断晋级资格`,
              `${sandboxAttempts.length} persisted attempt${sandboxAttempts.length === 1 ? "" : "s"} · qualification is never inferred from location`,
            ),
            metrics: [],
            suites: [],
            sandboxAttempts,
            allowRun: true,
            allowDebug: sandboxAttempts.some(
              (attempt) =>
                attempt.status === "failed" ||
                attempt.status === "blocked" ||
                attempt.status === "cleanup_failed",
            ),
          }
        : null,
    evidence: input.evidence.length || sandboxAttempts.length
      ? {
          title: "Immutable Evidence Records",
          subtitle: `${input.evidence.length} records · ${sandboxAttempts.length} Sandbox attempts`,
          items: input.evidence.slice(0, 12).map((item) => ({
            id: item.id,
            title: item.kind,
            detail: `${item.summary} · ${shortId(item.subjectDigest, 16)}`,
            status: evidenceStatus(item.outcome),
          })),
          sandboxAttempts,
          gate: {
            label: "Candidate Gate",
            title:
              input.session.phase === "completed"
                ? "Session workflow completed"
                : releaseReady
                  ? "Ready for FDE review"
                  : "Not ready for review",
            detail: releaseReady
              ? "Current-hash Agent code and conclusive Harness verification are present. Production deployment is not configured."
              : sandboxAttempts.some(
                    (attempt) =>
                      attempt.qualification === "development_only",
                  )
                ? localized(
                    input.language,
                    "当前 SandboxAttempt 仅为 development_only，不能晋级或作为发布凭据。",
                    "The current SandboxAttempt is development_only and cannot be promoted or used as release evidence.",
                  )
                : (releaseReadiness.blockers[0] ??
                  "More evidence or FDE input is required"),
            status:
              input.session.phase === "completed"
                ? "complete"
                : releaseReady
                  ? "ready"
                  : "conditional",
            ...(input.phase === "release" && releaseReady
              ? {
                  action: {
                    label: localized(
                      input.language,
                      "准备发布评审",
                      "Prepare release review",
                    ),
                    type: "prepare_release" as const,
                    variant: "primary" as const,
                  },
                }
              : {}),
          },
        }
      : null,
    selectedArtifact,
    artifactDetails: details,
    mapOrigin: {
      title: input.session.title,
      slug: input.project?.domain ?? input.session.projectId,
    },
    phaseSummaries: {
      scope: {
        title: "Ontology scope",
        description: input.session.goal,
        statusLabel: input.session.ontologySnapshotHash
          ? "Snapshot pinned"
          : "Snapshot pending",
        tone: input.session.ontologySnapshotHash ? "success" : "warning",
      },
      blueprint: {
        title: "Agent blueprint",
        description: `${input.artifacts.length} persisted artifacts are linked to this session.`,
        statusLabel: latestJob
          ? JOB_STATUS_LABELS[latestJob.status]
          : "Awaiting command",
      },
      tests: {
        title: "Verification matrix",
        description: `${testEvidence.length} test-related evidence records are available.`,
        statusLabel: failed ? `${failed} failed` : `${passed} passed`,
        tone: failed ? "warning" : passed ? "success" : "neutral",
      },
      debug: {
        title: "Evidence-driven debug",
        description:
          latestJob?.errorMessage ?? "No recoverable failure is active.",
        statusLabel: input.session.activityState,
        tone:
          input.session.activityState === "failed_recoverable"
            ? "warning"
            : "neutral",
      },
      review: {
        title: "Candidate review",
        description: `${input.changeSetOperations.length} changes · ${input.evidence.length} evidence records.`,
        statusLabel: releaseReady ? "Ready for FDE review" : "Gate blocked",
        tone: releaseReady ? "success" : "warning",
      },
      release: {
        title: "Release candidate",
        description:
          "Production deployment remains separately approval-gated and requires an explicit executor.",
        statusLabel:
          input.session.phase === "completed"
            ? "Workflow complete · deployment unverified"
            : "Not deployed",
        tone: "neutral",
      },
    },
    artifactTitle: "Live Artifact Workspace",
    artifactSubtitle: `${input.artifacts.length} immutable versions · ${input.streamState}`,
  };
  return { projection, artifactLanes };
}
