"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type {
  OntoCodeBuildSession,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodeSessionPhase,
  OntoCodeTurnAction,
  OntoCodeWorkspaceDirective as PersistedWorkspaceDirective,
  PostOntoCodeTurnRequest,
} from "@agentic/contracts";
import { Icon } from "@/app/portal/components/Icon";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import {
  useBootstrapOntoCodeSession,
  useCloseOntoCodeSession,
  useCommitOntoCodeWorkspacePatch,
  useCreateOntoCodeConfigurationTask,
  useCreateOntoCodeHarnessJob,
  useCreateOntoCodeProject,
  useCreateOntoCodeSession,
  useOntoCodeArtifacts,
  useOntoCodeChangeSet,
  useOntoCodeChangeSets,
  useOntoCodeCommands,
  useOntoCodeEvidence,
  useOntoCodeHarnessJobs,
  useLoadOntoCodeArtifactVersionContent,
  useOntoCodeAssistantRuns,
  useOntoCodeCandidateHead,
  useOntoCodeSandboxAttempts,
  useOntoCodeMessages,
  useOntoCodeConfigurationTask,
  useOntoCodeProjects,
  useOntoCodeSession,
  useOntoCodeSessions,
  useDecideOntoCodeCommand,
  useSendOntoCodeTurn,
  useSendOntoCodeAssistantTurn,
  useVerifyOntoCodeConfigurationTask,
} from "@/lib/hooks/useOntoCodeWorkspace";
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";
import {
  useBusinessOntologyDomainOntologies,
  useBusinessOntologyDomains,
} from "@/lib/hooks/useBusinessOntologyDomains";
import { useTenants } from "@/lib/hooks/useTenants";
import {
  useOntoCodeSessionStream,
  type OntoCodeStreamState,
} from "@/lib/hooks/useOntoCodeSessionStream";
import {
  phaseProgress,
  type ConversationRecommendation,
  type ConversationMessage,
  type CreateWorkspaceSessionInput,
  type HarnessStep,
  type SessionStatus,
  type WorkspacePhase,
  type SendWorkspaceMessageResult,
  type WorkspaceDirective,
  type WorkspaceGuidanceItem,
  type WorkspaceSession,
  workspaceSessionReadOnlyReason,
} from "./model";
import { OntoCodeSessionWorkspace } from "./OntoCodeSessionWorkspace";
import {
  isBusinessDomainScopedSessionMiss,
  SessionLoadErrorState,
} from "./SessionLoadErrorState";
import { WorkspaceSessionHub } from "./WorkspaceSessionHub";
import { buildWorkspaceProjection } from "./workspace-projection";
import styles from "./workspace.module.css";

const PHASE_TO_WORKSPACE: Record<OntoCodeSessionPhase, WorkspacePhase> = {
  intake: "scope",
  scope: "scope",
  configure: "blueprint",
  blueprint: "blueprint",
  build: "build",
  verify: "tests",
  debug: "debug",
  review: "review",
  release: "release",
  observe: "release",
  completed: "release",
};

const ONTOCODE_TURN_ACTIONS = new Set<OntoCodeTurnAction>([
  "analyze_scope",
  "propose_blueprint",
  "create_configuration_task",
  "verify_configuration",
  "generate_package",
  "patch_artifact",
  "generate_tests",
  "run_tests",
  "debug_failure",
  "compare_candidate",
  "prepare_release",
  "deploy_release",
]);

function sessionStatus(
  session: OntoCodeBuildSession,
  t: Translate,
): {
  status: SessionStatus;
  label: string;
} {
  if (session.phase === "completed") {
    return {
      status: "ready",
      label: t("ontocode.workspace.status.completed"),
    };
  }
  if (session.phase === "observe") {
    return {
      status: "ready",
      label: t("ontocode.workspace.status.observing"),
    };
  }
  if (
    session.activityState === "needs_user" ||
    session.activityState === "blocked_external" ||
    session.activityState === "failed_recoverable"
  ) {
    return {
      status: "needs_action",
      label: t("ontocode.workspace.status.needsAction"),
    };
  }
  if (session.activityState === "review_required") {
    return {
      status: "ready",
      label: t("ontocode.workspace.status.review"),
    };
  }
  if (
    session.activityState === "ai_planning" ||
    session.activityState === "queued" ||
    session.activityState === "running"
  ) {
    return {
      status: "running",
      label: t("ontocode.workspace.status.running"),
    };
  }
  if (
    session.activityState === "paused" ||
    session.activityState === "cancelled"
  ) {
    return {
      status: "paused",
      label: t("ontocode.workspace.status.paused"),
    };
  }
  return {
    status: "ready",
    label: t("ontocode.workspace.status.ready"),
  };
}

function toWorkspaceSession(
  session: OntoCodeBuildSession,
  domain: string,
  t: Translate,
  language: "en" | "zh",
  identity?: {
    tenantSlug?: string;
    tenantName?: string;
    ontologySource?: WorkspaceSession["ontologySource"];
  },
): WorkspaceSession {
  const phase = PHASE_TO_WORKSPACE[session.phase];
  const state = sessionStatus(session, t);
  return {
    id: session.id,
    title: session.title,
    ...(identity?.tenantSlug ? { tenantSlug: identity.tenantSlug } : {}),
    ...(identity?.tenantName ? { tenantName: identity.tenantName } : {}),
    domain,
    ...(identity?.ontologySource
      ? { ontologySource: identity.ontologySource }
      : {}),
    ontology: session.ontologySnapshotHash
      ? `${session.ontologySnapshotHash.slice(0, 15)}…`
      : "Snapshot pending",
    phase,
    status: state.status,
    statusLabel: state.label,
    updatedLabel: new Date(session.updatedAt).toLocaleString(
      language === "zh" ? "zh-CN" : "en-US",
      {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      },
    ),
    owner: session.ownerUserId ?? "Service actor",
    progress: phaseProgress(phase),
    agents: 0,
    testSummary:
      session.activityState === "failed_recoverable"
        ? t("ontocode.workspace.testSummary.blocked")
        : session.activityState === "needs_user"
          ? t("ontocode.workspace.testSummary.decision")
          : session.activityState === "blocked_external"
            ? t("ontocode.workspace.testSummary.configuration")
            : session.activityState === "review_required"
              ? t("ontocode.workspace.testSummary.review")
              : t("ontocode.workspace.testSummary.evidence"),
    goal: session.goal,
  };
}

function toConversationMessage(
  message: OntoCodeMessage,
  t: Translate,
  language: "en" | "zh",
): ConversationMessage {
  const rawText = message.content.text;
  const body =
    typeof rawText === "string"
      ? rawText
      : JSON.stringify(message.content, null, 2);
  const recommendations = Array.isArray(message.content.recommendations)
    ? message.content.recommendations.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const recommendation = raw as Record<string, unknown>;
        const id =
          typeof recommendation.id === "string" ? recommendation.id.trim() : "";
        const title =
          typeof recommendation.title === "string"
            ? recommendation.title.trim()
            : "";
        const reason =
          typeof recommendation.reason === "string"
            ? recommendation.reason.trim()
            : "";
        const kind = recommendation.kind;
        if (
          !id ||
          !title ||
          !reason ||
          ![
            "configuration",
            "decision",
            "execution",
            "inspection",
            "navigation",
          ].includes(String(kind))
        ) {
          return [];
        }
        const rawAction =
          recommendation.action &&
          typeof recommendation.action === "object" &&
          !Array.isArray(recommendation.action)
            ? (recommendation.action as Record<string, unknown>)
            : null;
        let action: ConversationRecommendation["action"];
        if (
          rawAction?.type === "configure" &&
          typeof rawAction.label === "string"
        ) {
          action = {
            label: rawAction.label,
            type: "open_configuration_task",
            variant: recommendation.recommended ? "primary" : "secondary",
            payload: {
              destination: rawAction.destination,
              providerId: rawAction.providerId,
              systemName: rawAction.systemName,
              system: rawAction.systemName,
              toolName: rawAction.toolName,
              ontologyDomain: rawAction.ontologyDomain,
              sourceWaitingJobId: rawAction.waitingHarnessJobId,
              actionName: rawAction.sourceActionName,
              requirementId: rawAction.sourceRequirementId,
              readinessStatus: rawAction.readinessStatus,
              executionSurface: rawAction.executionSurface,
              integrationKind: rawAction.requirementKind,
              integrationRole: rawAction.requirementRole,
            },
          };
        } else if (
          rawAction?.type === "execute" &&
          typeof rawAction.label === "string" &&
          typeof rawAction.turnAction === "string"
        ) {
          action = {
            label: rawAction.label,
            type: "execute_recommendation",
            variant: recommendation.recommended ? "primary" : "secondary",
            payload: {
              turnAction: rawAction.turnAction,
              instruction: rawAction.label,
            },
          };
        } else if (
          rawAction?.type === "navigate" &&
          typeof rawAction.label === "string" &&
          typeof rawAction.target === "string"
        ) {
          action = {
            label: rawAction.label,
            type: "navigate_recommendation",
            variant: recommendation.recommended ? "primary" : "secondary",
            payload: { target: rawAction.target },
          };
        } else if (
          rawAction?.type === "reply" &&
          typeof rawAction.label === "string" &&
          typeof rawAction.value === "string"
        ) {
          action = {
            label: rawAction.label,
            type: "reply_recommendation",
            variant: recommendation.recommended ? "primary" : "secondary",
            payload: { value: rawAction.value },
          };
        }
        return [
          {
            id,
            kind: kind as ConversationRecommendation["kind"],
            title,
            reason,
            ...(typeof recommendation.impact === "string"
              ? { impact: recommendation.impact }
              : {}),
            recommended: recommendation.recommended === true,
            ...(action ? { action } : {}),
          } satisfies ConversationRecommendation,
        ];
      })
    : [];
  return {
    id: message.id,
    actor: message.role === "user" ? "user" : "assistant",
    source:
      message.role === "tool"
        ? "tool"
        : message.role === "system"
          ? "system"
          : message.role === "assistant"
            ? "assistant"
            : undefined,
    status: "complete",
    name:
      message.role === "user"
        ? t("ontocode.workspace.you")
        : message.role === "assistant"
          ? "OntoCode"
          : message.role === "tool"
            ? "Harness Tool"
            : "System",
    time: new Date(message.createdAt).toLocaleTimeString(
      language === "zh" ? "zh-CN" : "en-US",
      {
        hour: "2-digit",
        minute: "2-digit",
      },
    ),
    body,
    receipt:
      message.type === "receipt" || message.type === "recommendation"
        ? message.type
        : undefined,
    ...(recommendations.length > 0 ? { recommendations } : {}),
  };
}

function jobTitle(job: OntoCodeHarnessJob, t: Translate): string {
  const keys: Record<OntoCodeHarnessJob["kind"], string> = {
    ontology_analysis: "ontocode.workspace.job.scope",
    scope: "ontocode.workspace.job.scope",
    blueprint: "ontocode.workspace.job.blueprint",
    build: "ontocode.workspace.job.build",
    simulation: "ontocode.workspace.job.simulation",
    test: "ontocode.workspace.job.test",
    debug: "ontocode.workspace.job.debug",
    regression: "ontocode.workspace.job.regression",
    promotion: "ontocode.workspace.job.promotion",
    deploy: "ontocode.workspace.job.deploy",
    production_analysis: "ontocode.workspace.job.productionAnalysis",
  };
  return t(keys[job.kind]);
}

function toHarnessSteps(
  jobs: OntoCodeHarnessJob[],
  t: Translate,
  language: "en" | "zh",
): HarnessStep[] {
  return [...jobs].reverse().map((job, index) => {
    const status: HarnessStep["status"] =
      job.status === "succeeded"
        ? "complete"
        : job.status === "running" || job.status === "leased"
          ? "running"
          : job.status === "queued" || job.status === "retry_scheduled"
            ? "queued"
            : "blocked";
    return {
      id: job.id,
      order: index + 1,
      title: jobTitle(job, t),
      detail: job.errorMessage ?? `${job.status} · ${job.id}`,
      time: new Date(job.createdAt).toLocaleTimeString(
        language === "zh" ? "zh-CN" : "en-US",
        {
          hour: "2-digit",
          minute: "2-digit",
        },
      ),
      status,
    };
  });
}

type PlannedTurn = Pick<
  PostOntoCodeTurnRequest,
  | "behavior"
  | "action"
  | "arguments"
  | "affectedSemanticPaths"
  | "requestedCapabilities"
>;

type WaitingTurnResume = {
  jobId: string;
  action: OntoCodeTurnAction;
};

function resumeActionForJob(
  kind: OntoCodeHarnessJob["kind"],
): OntoCodeTurnAction | null {
  const actions: Partial<
    Record<OntoCodeHarnessJob["kind"], OntoCodeTurnAction>
  > = {
    scope: "analyze_scope",
    blueprint: "propose_blueprint",
    build: "generate_package",
    simulation: "run_tests",
    test: "run_tests",
    debug: "debug_failure",
    regression: "compare_candidate",
    promotion: "prepare_release",
    deploy: "deploy_release",
  };
  return actions[kind] ?? null;
}

/**
 * Conservative browser-side intent hint. It never supplies risk, approval,
 * Job kind, or budget; those are derived by the server's exhaustive policy.
 * Unknown text clarifies instead of falling through to the current phase.
 */
function directiveForWorkspace(
  persisted: PersistedWorkspaceDirective,
  assistantText: string,
): WorkspaceDirective {
  const base = {
    id: persisted.id,
    sessionId: persisted.sessionId,
    sourceMessageId: persisted.sourceMessageId,
    eventSeq: persisted.eventSeq,
    behavior: persisted.behavior,
    notice: assistantText,
  } satisfies Pick<
    WorkspaceDirective,
    "id" | "sessionId" | "sourceMessageId" | "eventSeq" | "behavior" | "notice"
  >;

  if (persisted.behavior === "navigate") {
    const target = persisted.target.toLowerCase();
    if (/(收起.*执行|collapse.*harness)/i.test(target)) {
      return { ...base, harnessExpanded: false, focus: "chat" };
    }
    if (/(展开.*执行|harness|execution detail)/i.test(target)) {
      return {
        ...base,
        harnessExpanded: true,
        focus: "harness",
      };
    }
    if (
      target === "chat" ||
      /(回到.*对话|back to chat|conversation)/i.test(target)
    ) {
      return { ...base, mode: "conversation", focus: "chat" };
    }
    if (/(证据|evidence)/i.test(target)) {
      return {
        ...base,
        artifactView: "evidence",
        mode: "artifacts",
        focus: "workspace",
      };
    }
    if (/(测试|tests?)/i.test(target)) {
      return {
        ...base,
        artifactView: "tests",
        mode: "artifacts",
        focus: "workspace",
      };
    }
    if (/(改动|变更|changes?|diff)/i.test(target)) {
      return {
        ...base,
        artifactView: "changes",
        mode: "artifacts",
        focus: "workspace",
      };
    }
    return {
      ...base,
      artifactView: "map",
      mode: "artifacts",
      focus: "workspace",
    };
  }

  if (persisted.behavior !== "execute") {
    return { ...base, mode: "conversation", focus: "chat" };
  }

  const actionView: Record<
    OntoCodeTurnAction,
    Pick<WorkspaceDirective, "phase" | "artifactView">
  > = {
    analyze_ontology: { phase: "scope", artifactView: "map" },
    analyze_scope: { phase: "scope", artifactView: "map" },
    propose_blueprint: { phase: "blueprint", artifactView: "map" },
    create_configuration_task: {
      phase: "blueprint",
      artifactView: "evidence",
    },
    verify_configuration: { phase: "tests", artifactView: "evidence" },
    generate_package: { phase: "build", artifactView: "map" },
    patch_artifact: { phase: "build", artifactView: "changes" },
    generate_tests: { phase: "tests", artifactView: "tests" },
    run_tests: { phase: "tests", artifactView: "tests" },
    debug_failure: { phase: "debug", artifactView: "changes" },
    compare_candidate: { phase: "review", artifactView: "evidence" },
    prepare_release: { phase: "release", artifactView: "evidence" },
    deploy_release: { phase: "release", artifactView: "evidence" },
  };
  return {
    ...base,
    ...actionView[persisted.action],
    mode: "balanced",
    harnessExpanded: true,
    focus: "harness",
  };
}

function DataBanner({
  tone,
  children,
}: {
  tone: "connected" | "error";
  children: ReactNode;
}) {
  return (
    <div className={styles.dataBanner} data-tone={tone} role="status">
      <Icon name={tone === "error" ? "alert" : "check"} size={13} />
      <span>{children}</span>
    </div>
  );
}

export function OntoCodeWorkspaceHubConnected() {
  const { language, t } = useI18n();
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const router = useRouter();
  const projects = useOntoCodeProjects(tenant);
  const sessions = useOntoCodeSessions(tenant);
  const createProject = useCreateOntoCodeProject(tenant);
  const createSession = useCreateOntoCodeSession(tenant);
  const bootstrapSession = useBootstrapOntoCodeSession(tenant);
  const factoryOntology = useAgentFactoryDomains(tenant);
  const ontologyRegistry = useBusinessOntologyDomains(tenant, {
    includeArchived: false,
    includeUnavailable: true,
  });
  const tenants = useTenants();
  const activeRegistrations = useMemo(
    () =>
      (ontologyRegistry.data?.items ?? []).filter(
        (registration) =>
          registration.status === "active" &&
          (registration.source === "allmeta" ||
            registration.source === "upload"),
      ),
    [ontologyRegistry.data?.items],
  );
  const registrationOntologies = useBusinessOntologyDomainOntologies(
    tenant,
    activeRegistrations.map((registration) => registration.id),
  );
  const ontologyActionsByRegistrationId = useMemo(
    () =>
      Object.fromEntries(
        registrationOntologies.flatMap(({ registrationId, query }) =>
          query.data
            ? [
                [
                  registrationId,
                  query.data.ontology.actions
                    .filter((action) =>
                      action.actor.some(
                        (actor) => actor.trim().toLowerCase() === "agent",
                      ),
                    )
                    .map((action) => ({
                      id: action.id,
                      name: action.name,
                      description: action.description,
                      actors: action.actor,
                    })),
                ] as const,
              ]
            : [],
        ),
      ),
    [registrationOntologies],
  );
  const ontologyActionsStateByRegistrationId = useMemo<
    Record<string, "loading" | "ready" | "error">
  >(
    () =>
      Object.fromEntries(
        registrationOntologies.map(({ registrationId, query }) => {
          const state: "loading" | "ready" | "error" = query.isError
            ? "error"
            : query.isSuccess
              ? "ready"
              : "loading";
          return [registrationId, state];
        }),
      ),
    [registrationOntologies],
  );
  const defaultRegistration =
    activeRegistrations.find((registration) => registration.isDefault) ??
    activeRegistrations[0] ??
    null;
  const tenantRecord = (tenants.data?.items ?? []).find(
    (candidate) => candidate.slug === tenant || candidate.id === tenant,
  );

  const projectById = useMemo(
    () => new Map((projects.data?.items ?? []).map((item) => [item.id, item])),
    [projects.data?.items],
  );
  const registrationById = useMemo(
    () =>
      new Map(
        (ontologyRegistry.data?.items ?? []).map((registration) => [
          registration.id,
          registration,
        ]),
      ),
    [ontologyRegistry.data?.items],
  );
  const workspaceSessions = useMemo(
    () =>
      (sessions.data?.items ?? []).map((session) => {
        const project = projectById.get(session.projectId);
        const registration = project?.ontologyDomainRegistrationId
          ? registrationById.get(project.ontologyDomainRegistrationId)
          : null;
        return toWorkspaceSession(
          session,
          project?.domain ?? "Ontology Domain",
          t,
          language,
          {
            tenantSlug: tenantRecord?.slug ?? tenant,
            tenantName: tenantRecord?.name ?? tenant,
            ontologySource: registration
              ? registration.status === "active"
                ? registration.source === "allmeta" ||
                  registration.source === "upload"
                  ? registration.source
                  : "unknown"
                : "historical"
              : "historical",
          },
        );
      }),
    [
      language,
      registrationById,
      projectById,
      sessions.data?.items,
      t,
      tenant,
      tenantRecord?.name,
      tenantRecord?.slug,
    ],
  );

  async function handleCreate(input: CreateWorkspaceSessionInput) {
    const registration = activeRegistrations.find(
      (candidate) =>
        candidate.id === input.ontologyDomainRegistrationId &&
        candidate.ontologyDomainId === input.domain,
    );
    if (!registration) {
      throw new Error(
        language === "zh"
          ? "所选 Ontology Domain 不再属于当前 Business Domain，或已不可用。请刷新后重新选择。"
          : "The selected Ontology Domain is no longer active in this Business Domain. Refresh and select again.",
      );
    }
    if (!registration.executionReadiness.executable) {
      throw new Error(registration.executionReadiness.message);
    }
    if (factoryOntology.data?.gatewayConfigured === false) {
      throw new Error(
        language === "zh"
          ? "当前 Business Domain 尚未配置可用的 LLM Gateway。"
          : "This Business Domain has no usable LLM Gateway configuration.",
      );
    }
    const goal =
      input.goal ||
      (language === "zh"
        ? "根据当前 Ontology 分析业务范围并生成可测试的 Agent Package。"
        : "Analyze the business scope from the current Ontology and generate a testable Agent Package.");
    let project = (projects.data?.items ?? []).find(
      (candidate) => candidate.ontologyDomainRegistrationId === registration.id,
    );
    if (!project) {
      const receipt = await createProject.mutateAsync({
        domain: registration.ontologyDomainId,
        ontologyDomainRegistrationId: registration.id,
        name: registration.displayName || registration.ontologyDomainId,
        description:
          language === "zh"
            ? "由 OntoCode Build Sessions 管理的 Agent 工程项目。"
            : "Agent engineering Project managed by OntoCode Build Sessions.",
      });
      project = receipt.project;
    }
    const receipt = await createSession.mutateAsync({
      projectId: project.id,
      title:
        input.title ||
        (language === "zh"
          ? "新的 Ontology Agent 项目"
          : "New Ontology Agent Project"),
      goal,
      autonomyMode: input.autonomyMode,
    });
    // This surface has a real scope picker, so `full_domain`/`selected_actions`
    // keep the legacy analyze_scope bootstrap. A free-text `scenario` with no
    // chosen actions goes to the planner instead and may resolve to an
    // explanation with no Harness Job — navigation stays unconditional so that
    // Session opens on the assistant's reply rather than dead-ending.
    await bootstrapSession.mutateAsync({
      sessionId: receipt.session.id,
      goal,
      scopeMode: input.scopeMode,
      actionIds: input.actionIds,
    });
    router.push(
      `/portal/${tenant}/ontocode-workspace/${receipt.session.id}` as never,
    );
  }

  const hasError =
    projects.isError ||
    sessions.isError ||
    ontologyRegistry.isError ||
    factoryOntology.isError;
  return (
    <div className={styles.connectedPage}>
      <DataBanner tone={hasError ? "error" : "connected"}>
        {hasError
          ? t("ontocode.workspace.controlPlane.error")
          : sessions.isLoading
            ? t("ontocode.workspace.controlPlane.loading")
            : t("ontocode.workspace.controlPlane.connected", {
                count: workspaceSessions.length,
              })}
      </DataBanner>
      <WorkspaceSessionHub
        sessions={workspaceSessions}
        tenantIdentity={{
          id: tenantRecord?.id ?? tenant,
          slug: tenantRecord?.slug ?? tenant,
          name: tenantRecord?.name ?? tenant,
        }}
        boundOntology={
          defaultRegistration
            ? {
                registrationId: defaultRegistration.id,
                id: defaultRegistration.ontologyDomainId,
                name: defaultRegistration.displayName,
                source: defaultRegistration.source,
                isDefault: defaultRegistration.isDefault,
                runtimeProfileVersionId:
                  defaultRegistration.runtimeProfileVersionId,
                runtimeProfileLabel: defaultRegistration.runtimeProfileVersion
                  ? `${defaultRegistration.runtimeProfileVersion.adapter.adapterRegistrySlug}@${defaultRegistration.runtimeProfileVersion.adapter.adapterRegistryVersion} · v${defaultRegistration.runtimeProfileVersion.version}`
                  : null,
                runtimeExecutable:
                  defaultRegistration.executionReadiness.executable,
                runtimeReadinessState:
                  defaultRegistration.executionReadiness.state,
                runtimeReadinessMessage:
                  defaultRegistration.executionReadiness.message,
              }
            : null
        }
        availableOntologyDomains={activeRegistrations.map((registration) => {
          const ontology = registrationOntologies.find(
            (item) => item.registrationId === registration.id,
          )?.query.data?.ontology;
          return {
            registrationId: registration.id,
            id: registration.ontologyDomainId,
            name: registration.displayName,
            source: registration.source,
            isDefault: registration.isDefault,
            runtimeProfileVersionId: registration.runtimeProfileVersionId,
            runtimeProfileLabel: registration.runtimeProfileVersion
              ? `${registration.runtimeProfileVersion.adapter.adapterRegistrySlug}@${registration.runtimeProfileVersion.adapter.adapterRegistryVersion} · v${registration.runtimeProfileVersion.version}`
              : null,
            runtimeExecutable: registration.executionReadiness.executable,
            runtimeReadinessState: registration.executionReadiness.state,
            runtimeReadinessMessage: registration.executionReadiness.message,
            counts: ontology
              ? {
                  ...ontology.counts,
                  actions:
                    ontologyActionsByRegistrationId[registration.id]?.length ??
                    0,
                }
              : undefined,
          };
        })}
        ontologyActionsByRegistrationId={ontologyActionsByRegistrationId}
        ontologyActionsStateByRegistrationId={
          ontologyActionsStateByRegistrationId
        }
        readiness={{
          bindingState: ontologyRegistry.isLoading
            ? "loading"
            : ontologyRegistry.isError
              ? "error"
              : defaultRegistration
                ? "ready"
                : "missing",
          gatewayConfigured: factoryOntology.data?.gatewayConfigured === true,
          gatewayLabel:
            factoryOntology.data?.gatewayConfigured === true
              ? t("ontocode.hub.readinessItem.configured")
              : null,
          configurationState: "checked_in_session",
          configurationLabel: t("ontocode.hub.readinessItem.verifiedInSession"),
          ontologySettingsHref: `/portal/${tenant}/tenants#ontology-domains`,
          gatewaySettingsHref: `/portal/${tenant}/settings?section=ai`,
          configurationHref: `/portal/${tenant}/settings?section=integrations`,
          runtimeProfileSettingsHref: `/portal/${tenant}/tenants#runtime-profiles`,
        }}
        onCreateSession={handleCreate}
        onOpenSession={(session) =>
          router.push(
            `/portal/${tenant}/ontocode-workspace/${session.id}` as never,
          )
        }
      />
    </div>
  );
}

export function OntoCodeWorkspaceSessionConnected() {
  const { language, t } = useI18n();
  const params = useParams<{ tenant: string; sessionId: string }>();
  const tenant = params.tenant;
  const sessionId = params.sessionId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnedConfigurationTaskId = (() => {
    const value = searchParams.get("configTask")?.trim() ?? "";
    return /^ocfg-[a-f0-9]{32}$/.test(value) ? value : "";
  })();
  const sessionQuery = useOntoCodeSession(tenant, sessionId);
  const projectsQuery = useOntoCodeProjects(tenant);
  const ontologyRegistryQuery = useBusinessOntologyDomains(tenant, {
    includeArchived: true,
    includeUnavailable: true,
  });
  const tenantsQuery = useTenants();
  const messagesQuery = useOntoCodeMessages(tenant, sessionId);
  const assistantRunsQuery = useOntoCodeAssistantRuns(tenant, sessionId);
  const candidateHeadQuery = useOntoCodeCandidateHead(tenant, sessionId);
  const sandboxAttemptsQuery = useOntoCodeSandboxAttempts(tenant, sessionId);
  const jobsQuery = useOntoCodeHarnessJobs(tenant, sessionId);
  const commandsQuery = useOntoCodeCommands(tenant, sessionId);
  const changeSetsQuery = useOntoCodeChangeSets(tenant, sessionId);
  const latestChangeSetId = changeSetsQuery.data?.items[0]?.id ?? "";
  const changeSetQuery = useOntoCodeChangeSet(
    tenant,
    sessionId,
    latestChangeSetId,
  );
  const artifactsQuery = useOntoCodeArtifacts(tenant, sessionId);
  const evidenceQuery = useOntoCodeEvidence(tenant, sessionId);
  const loadArtifactVersion = useLoadOntoCodeArtifactVersionContent(tenant);
  const sendTurn = useSendOntoCodeTurn(tenant, sessionId);
  const sendAssistantTurn = useSendOntoCodeAssistantTurn(tenant, sessionId);
  const createConfigurationTask = useCreateOntoCodeConfigurationTask(
    tenant,
    sessionId,
  );
  const returnedConfigurationTask = useOntoCodeConfigurationTask(
    tenant,
    returnedConfigurationTaskId,
  );
  const verifyConfigurationTask = useVerifyOntoCodeConfigurationTask(
    tenant,
    returnedConfigurationTaskId,
  );
  const createJob = useCreateOntoCodeHarnessJob(tenant, sessionId);
  const closeSession = useCloseOntoCodeSession(tenant, sessionId);
  const commitWorkspacePatch = useCommitOntoCodeWorkspacePatch(
    tenant,
    sessionId,
  );
  const decideCommand = useDecideOntoCodeCommand(tenant, sessionId);
  const [streamState, setStreamState] =
    useState<OntoCodeStreamState>("connecting");
  useOntoCodeSessionStream(tenant, sessionId, {
    enabled: true,
    onStatusChange: setStreamState,
  });

  if (sessionQuery.isLoading) {
    return (
      <div className={styles.connectedPage}>
        <div className={styles.connectionState}>
          <Icon name="replay" size={18} />
          {t("ontocode.workspace.loadingSession")}
        </div>
      </div>
    );
  }
  if (sessionQuery.isError || !sessionQuery.data?.session) {
    const currentBusinessDomain =
      (tenantsQuery.data?.items ?? []).find(
        (candidate) => candidate.slug === tenant || candidate.id === tenant,
      ) ?? null;
    return (
      <SessionLoadErrorState
        tenantSlug={currentBusinessDomain?.slug ?? tenant}
        tenantName={currentBusinessDomain?.name ?? tenant}
        unavailable={
          !sessionQuery.data?.session &&
          (!sessionQuery.error ||
            isBusinessDomainScopedSessionMiss(sessionQuery.error))
        }
      />
    );
  }

  const persistedSession = sessionQuery.data.session;
  const project = (projectsQuery.data?.items ?? []).find(
    (candidate) => candidate.id === persistedSession.projectId,
  );
  const projectRegistration = project?.ontologyDomainRegistrationId
    ? ((ontologyRegistryQuery.data?.items ?? []).find(
        (candidate) => candidate.id === project.ontologyDomainRegistrationId,
      ) ?? null)
    : null;
  const activeRegistration =
    projectRegistration?.status === "active" ? projectRegistration : null;
  const bindingReadOnlyReason = workspaceSessionReadOnlyReason({
    verificationState:
      projectsQuery.isLoading || ontologyRegistryQuery.isLoading
        ? "loading"
        : projectsQuery.isError || ontologyRegistryQuery.isError
          ? "error"
          : "ready",
    projectRegistrationId: project?.ontologyDomainRegistrationId ?? null,
    activeRegistrationId: activeRegistration?.id ?? null,
    projectDomain: project?.domain ?? null,
  });
  const factQueries = [
    ["Ontology Domain registry", ontologyRegistryQuery],
    ["Messages", messagesQuery],
    ["Harness Jobs", jobsQuery],
    ["Commands", commandsQuery],
    ["Change Sets", changeSetsQuery],
    ...(latestChangeSetId
      ? ([["Change Set detail", changeSetQuery]] as const)
      : []),
    ["Artifacts", artifactsQuery],
    ["Evidence", evidenceQuery],
    ["Candidate Head", candidateHeadQuery],
    ["Sandbox Attempts", sandboxAttemptsQuery],
  ] as const;
  const loadingFact = factQueries.find(([, query]) => query.isLoading)?.[0];
  const failedFact = factQueries.find(([, query]) => query.isError)?.[0];
  const readOnlyReason =
    bindingReadOnlyReason ??
    (failedFact
      ? language === "zh"
        ? `${failedFact} 数据读取失败。为避免把缺失事实当作空数据或错误计算门禁，本 Session 已进入只读保护。`
        : `${failedFact} failed to load. This Session is read-only so missing facts cannot be mistaken for empty state or a valid gate.`
      : loadingFact
        ? language === "zh"
          ? `正在读取 ${loadingFact}；事实链完整前暂停写操作与发布判断。`
          : `Loading ${loadingFact}; writes and release decisions are paused until the fact chain is complete.`
        : null);
  const session = toWorkspaceSession(
    persistedSession,
    project?.domain ?? "Ontology Domain",
    t,
    language,
    {
      tenantSlug: tenant,
      tenantName:
        (tenantsQuery.data?.items ?? []).find(
          (candidate) => candidate.slug === tenant || candidate.id === tenant,
        )?.name ?? tenant,
      ontologySource: projectRegistration
        ? projectRegistration.status === "active"
          ? projectRegistration.source === "allmeta" ||
            projectRegistration.source === "upload"
            ? projectRegistration.source
            : "unknown"
          : "historical"
        : "historical",
    },
  );
  const persistedMessages = (messagesQuery.data?.items ?? []).map((message) =>
    toConversationMessage(message, t, language),
  );
  const messages = persistedMessages;
  const assistantRunActive = (assistantRunsQuery.data?.items ?? []).some(
    (run) => run.status === "accepted" || run.status === "planning",
  );
  const jobs = jobsQuery.data?.items ?? [];
  const waitingJob = jobs.find((job) => job.status === "waiting_user");
  const waitingAction = waitingJob ? resumeActionForJob(waitingJob.kind) : null;
  const waitingResume: WaitingTurnResume | null =
    waitingJob && waitingAction
      ? {
          jobId: waitingJob.id,
          action: waitingAction,
        }
      : null;
  const harnessSteps = toHarnessSteps(jobs, t, language);
  const workspaceProjection = buildWorkspaceProjection({
    session: persistedSession,
    phase: session.phase,
    project,
    commands: commandsQuery.data?.items ?? [],
    jobs,
    messages: messagesQuery.data?.items ?? [],
    changeSets: changeSetsQuery.data?.items ?? [],
    changeSetOperations: changeSetQuery.data?.operations ?? [],
    artifacts: artifactsQuery.data?.items ?? [],
    evidence: evidenceQuery.data?.items ?? [],
    candidateHead: candidateHeadQuery.data?.head ?? null,
    candidatePackage: candidateHeadQuery.data?.packageVersion ?? null,
    candidateHeadLoaded: candidateHeadQuery.isSuccess,
    sandboxAttempts: sandboxAttemptsQuery.data?.items ?? [],
    streamState,
    language,
  });
  const configurationTask = returnedConfigurationTask.data?.task;
  const configurationTaskBelongsToSession =
    configurationTask?.sessionId === sessionId;
  const configurationTaskItem: WorkspaceGuidanceItem | null =
    returnedConfigurationTaskId
      ? {
          id: `configuration-task:${returnedConfigurationTaskId}`,
          title:
            language === "zh"
              ? "配置完成后由 OntoCode 验证并续跑"
              : "OntoCode verifies configuration before resuming",
          detail: returnedConfigurationTask.isLoading
            ? language === "zh"
              ? "正在读取服务端 Configuration Task…"
              : "Loading the server-owned Configuration Task…"
            : returnedConfigurationTask.isError ||
                !configurationTaskBelongsToSession
              ? language === "zh"
                ? "无法验证该配置任务属于当前租户与 Session；不会继续 Harness。"
                : "This Configuration Task could not be verified for the current tenant and Session; Harness will not resume."
              : (configurationTask?.lastVerification?.summary ??
                configurationTask?.requirement.summary ??
                ""),
          statusLabel: returnedConfigurationTask.isLoading
            ? language === "zh"
              ? "读取中"
              : "Loading"
            : configurationTask?.status === "satisfied"
              ? language === "zh"
                ? "已验证"
                : "Verified"
              : configurationTask?.status === "verifying"
                ? language === "zh"
                  ? "验证中"
                  : "Verifying"
                : language === "zh"
                  ? "等待真实验证"
                  : "Awaiting real verification",
          status:
            configurationTask?.status === "satisfied"
              ? ("ready" as const)
              : configurationTask?.status === "verifying" ||
                  returnedConfigurationTask.isLoading
                ? ("running" as const)
                : ("configuration" as const),
          actions:
            configurationTaskBelongsToSession &&
            configurationTask?.status === "open"
              ? [
                  {
                    label:
                      language === "zh"
                        ? "已配置，验证并继续"
                        : "Configured — verify and continue",
                    type: "confirm_configuration" as const,
                    variant: "primary" as const,
                    payload: { configurationTaskId: configurationTask.id },
                  },
                  {
                    label: language === "zh" ? "继续配置" : "Continue setup",
                    type: "open_configuration_task" as const,
                    variant: "secondary" as const,
                    payload: {
                      configurationTaskId: configurationTask.id,
                      reopen: true,
                    },
                  },
                ]
              : undefined,
        }
      : null;
  const projection = configurationTaskItem
    ? {
        ...workspaceProjection.projection,
        guidance: workspaceProjection.projection.guidance
          ? {
              ...workspaceProjection.projection.guidance,
              items: [
                configurationTaskItem,
                ...(workspaceProjection.projection.guidance.items ?? []),
              ],
            }
          : {
              id: "configuration-return",
              title:
                language === "zh"
                  ? "OntoCode 配置续跑"
                  : "OntoCode configuration continuation",
              statusLabel:
                configurationTaskItem.statusLabel ??
                (language === "zh" ? "配置任务" : "Configuration Task"),
              status: "attention" as const,
              items: [configurationTaskItem],
            },
      }
    : workspaceProjection.projection;

  async function enqueueInstruction(
    message: string,
    _phase: WorkspacePhase,
    contextRefs: string[],
    planOverride?: PlannedTurn,
  ): Promise<SendWorkspaceMessageResult> {
    try {
      const receipt = planOverride
        ? await sendTurn.mutateAsync({
            text: message,
            ...planOverride,
          })
        : await sendAssistantTurn.mutateAsync({
            text: message,
            contextRefs,
          });
      const assistant = toConversationMessage(
        receipt.assistantMessage,
        t,
        language,
      );
      return {
        message: assistant,
        directive: directiveForWorkspace(receipt.directive, assistant.body),
      };
    } catch (error) {
      return {
        message: {
          id: `assistant-error-${Date.now()}`,
          actor: "assistant",
          source: "assistant",
          status: "failed",
          name: "OntoCode",
          time: t("ontocode.workspace.nowLabel"),
          body: t("ontocode.workspace.turnFailed"),
          receipt:
            error instanceof Error
              ? error.message
              : "unknown integration error",
        },
      };
    }
  }

  function assistantNotice(body: string, receipt?: string) {
    return {
      message: {
        id: `assistant-notice-${Date.now()}`,
        actor: "assistant" as const,
        name: "OntoCode",
        time: t("ontocode.workspace.nowLabel"),
        body,
        ...(receipt ? { receipt } : {}),
      },
    } satisfies SendWorkspaceMessageResult;
  }

  async function openConfigurationTask(
    payload: Record<string, unknown> | undefined,
  ): Promise<SendWorkspaceMessageResult | undefined> {
    const existingTaskId =
      typeof payload?.configurationTaskId === "string"
        ? payload.configurationTaskId.trim()
        : "";
    if (/^ocfg-[a-f0-9]{32}$/.test(existingTaskId)) {
      router.push(
        `/portal/${tenant}/configure/${encodeURIComponent(existingTaskId)}` as never,
      );
      return;
    }

    const sourceWaitingJobId =
      typeof payload?.sourceWaitingJobId === "string"
        ? payload.sourceWaitingJobId.trim()
        : "";
    const actionName =
      typeof payload?.actionName === "string" ? payload.actionName.trim() : "";
    const requirementId =
      typeof payload?.requirementId === "string"
        ? payload.requirementId.trim()
        : "";
    const system =
      typeof payload?.system === "string" ? payload.system.trim() : "";
    const readinessStatus =
      typeof payload?.readinessStatus === "string"
        ? payload.readinessStatus.trim()
        : "";
    const requirementKind =
      typeof payload?.integrationKind === "string"
        ? payload.integrationKind.trim()
        : "";
    const requirementRole =
      typeof payload?.integrationRole === "string"
        ? payload.integrationRole.trim()
        : "";
    const reason =
      typeof payload?.reason === "string" ? payload.reason.trim() : "";
    const sourceJob =
      waitingJob?.id === sourceWaitingJobId ? waitingJob : undefined;
    const ontologyHash = persistedSession.ontologySnapshotHash;
    if (
      !sourceJob ||
      !waitingResume ||
      !ontologyHash ||
      !actionName ||
      !requirementId ||
      !system ||
      !requirementKind ||
      !requirementRole ||
      !reason
    ) {
      return assistantNotice(
        language === "zh"
          ? "当前推荐缺少可验证的等待任务、Ontology snapshot 或 requirement 绑定。我没有打开泛化配置页；请先让 OntoCode 重新检查 readiness。"
          : "This recommendation is missing a verifiable waiting Job, Ontology snapshot, or requirement binding. I did not open a generic settings page; ask OntoCode to inspect readiness again.",
        "configuration_task_not_authorized",
      );
    }
    if (readinessStatus !== "missing" || payload?.executionSurface) {
      return assistantNotice(
        language === "zh"
          ? "该阻塞不是“缺少工具身份”类型，当前还不能安全推断具体配置页面。OntoCode 将保持阻塞，避免把凭证、Tool Profile 与 API contract 混为一谈。"
          : "This blocker is not a missing-tool identity gap, so OntoCode cannot safely infer its configuration surface yet. It remains blocked instead of conflating credentials, Tool Profiles, and API contracts.",
        "configuration_surface_unresolved",
      );
    }

    const receipt = await createConfigurationTask.mutateAsync({
      expectedSessionRevision: persistedSession.revision,
      ...(sourceJob.commandId ? { sourceCommandId: sourceJob.commandId } : {}),
      waitingHarnessJobId: sourceJob.id,
      sourceRequirementId: requirementId,
      sourceActionName: actionName,
      blockerKey: `${sourceJob.id}:${actionName}:${requirementId}`.slice(
        0,
        240,
      ),
      title:
        language === "zh"
          ? `为 ${actionName} 补充 ${system} API contract`
          : `Provide the ${system} API contract for ${actionName}`,
      target: {
        kind: "tool",
        system,
        desiredToolName: null,
        requirementKind,
        requirementRole,
      },
      requirement: {
        summary: reason,
        reason,
        missingFields: [],
        sourceRefs: [
          `harness-job:${sourceJob.id}`,
          `ontology-action:${actionName}`,
          `integration-requirement:${requirementId}`,
        ],
      },
      verificationPolicy: {
        kind: "tool_contract",
      },
      resumeAction: waitingResume.action,
      ontologyHash,
    });
    router.push(
      `/portal/${tenant}/configure/${encodeURIComponent(receipt.task.id)}` as never,
    );
    return;
  }

  return (
    <div className={styles.connectedPage}>
      <OntoCodeSessionWorkspace
        session={session}
        readOnlyReason={readOnlyReason}
        assistantRunActive={assistantRunActive}
        messages={messages}
        harnessSteps={harnessSteps}
        artifactLanes={workspaceProjection.artifactLanes}
        projection={projection}
        onRetireSession={async () => {
          await closeSession.mutateAsync({
            expectedRevision: persistedSession.revision,
            disposition: "retired",
            reason:
              language === "zh"
                ? "FDE 在 OntoCode 工作区明确结束未完成的 Session。"
                : "The FDE explicitly ended this unfinished Session from the OntoCode workspace.",
          });
          router.push(`/portal/${tenant}/ontocode-workspace` as never);
        }}
        onLoadArtifactVersion={loadArtifactVersion.mutateAsync}
        onSaveArtifactPatch={commitWorkspacePatch.mutateAsync}
        onSendMessage={({ message, phase, contextRefs }) =>
          enqueueInstruction(message, phase, contextRefs)
        }
        onPrimaryAction={async (action) => {
          const refs = workspaceProjection.projection.contextRefs ?? [];
          if (action.type === "reply_recommendation") {
            const value =
              typeof action.payload?.value === "string"
                ? action.payload.value.trim()
                : "";
            return value
              ? enqueueInstruction(value, session.phase, refs)
              : undefined;
          }
          if (action.type === "navigate_recommendation") {
            const target =
              typeof action.payload?.target === "string"
                ? action.payload.target.trim()
                : "";
            if (!target) return;
            return enqueueInstruction(target, session.phase, refs, {
              behavior: "navigate",
              arguments: {},
              affectedSemanticPaths: [],
              requestedCapabilities: [],
            });
          }
          if (action.type === "execute_recommendation") {
            const rawAction =
              typeof action.payload?.turnAction === "string"
                ? action.payload.turnAction
                : "";
            if (!ONTOCODE_TURN_ACTIONS.has(rawAction as OntoCodeTurnAction)) {
              return;
            }
            const turnAction = rawAction as OntoCodeTurnAction;
            const instruction =
              typeof action.payload?.instruction === "string" &&
              action.payload.instruction.trim()
                ? action.payload.instruction.trim()
                : turnAction;
            return enqueueInstruction(instruction, session.phase, refs, {
              behavior: "execute",
              action: turnAction,
              arguments: {
                instruction,
                source: "ontocode-assistant-recommendation",
                ...(waitingResume && waitingResume.action === turnAction
                  ? {
                      clarificationAnswer: instruction,
                      resumeWaitingUserJobId: waitingResume.jobId,
                    }
                  : {}),
              },
              affectedSemanticPaths: refs,
              requestedCapabilities: [],
            });
          }
          if (action.type === "open_configuration_task") {
            return openConfigurationTask(action.payload);
          }
          if (action.type === "configure") {
            const preciseAction = projection.guidance?.items
              ?.flatMap((item) => item.actions ?? [])
              .find(
                (candidate) => candidate.type === "open_configuration_task",
              );
            return preciseAction
              ? openConfigurationTask(preciseAction.payload)
              : waitingResume?.action === "generate_package"
                ? enqueueInstruction(
                    language === "zh"
                      ? "重新执行当前 Build 的只读 readiness 检查，生成结构化 requirement receipt 后再次暂停；不要使用 mock，不要跳过缺失 contract，也不要把任何未验证配置标记为完成。"
                      : "Re-run the current Build's read-only readiness inspection and pause again with a structured requirement receipt. Do not use mocks, skip the missing contract, or mark unverified configuration complete.",
                    session.phase,
                    refs,
                    {
                      behavior: "execute",
                      action: "generate_package",
                      arguments: {
                        instruction:
                          "Refresh structured readiness before opening an exact Configuration Task.",
                        source: "ontocode-configuration-readiness-refresh",
                        clarificationAnswer:
                          "Re-run readiness and persist the exact unresolved binding.",
                        resumeWaitingUserJobId: waitingResume.jobId,
                      },
                      affectedSemanticPaths: refs,
                      requestedCapabilities: [],
                    },
                  )
                : assistantNotice(
                    language === "zh"
                      ? "目前没有绑定到结构化 Harness requirement 的配置任务。我不会把你带到无法验证的泛化设置页。"
                      : "There is no Configuration Task bound to a structured Harness requirement. I will not send you to an unverifiable generic settings page.",
                    "configuration_requirement_missing",
                  );
          }
          if (action.type === "confirm_configuration") {
            const configurationTaskId =
              typeof action.payload?.configurationTaskId === "string"
                ? action.payload.configurationTaskId.trim()
                : "";
            if (
              !/^ocfg-[a-f0-9]{32}$/.test(configurationTaskId) ||
              configurationTaskId !== returnedConfigurationTaskId ||
              !configurationTaskBelongsToSession
            ) {
              return assistantNotice(
                language === "zh"
                  ? "配置任务身份与当前 Session 不匹配，已停止验证与续跑。"
                  : "The Configuration Task does not match this Session, so verification and continuation were stopped.",
                "configuration_task_mismatch",
              );
            }
            const result = await verifyConfigurationTask.mutateAsync(undefined);
            return assistantNotice(
              result.verification.summary,
              result.verification.outcome === "passed"
                ? result.resumed
                  ? "configuration_verified_and_resumed"
                  : "configuration_verified_resume_pending"
                : `configuration_${result.verification.outcome}`,
            );
          }
          if (action.type === "continue_ready_actions") {
            const deferredActionNames = Array.isArray(
              action.payload?.actionNames,
            )
              ? action.payload.actionNames
                  .map(String)
                  .map((name) => name.trim())
                  .filter(Boolean)
              : [];
            if (
              !waitingResume ||
              deferredActionNames.length === 0 ||
              waitingResume.action !== "generate_package"
            ) {
              return;
            }
            const instruction =
              language === "zh"
                ? `暂缓 ${deferredActionNames.join("、")}，先继续生成当前 Scope 中其余已就绪 Agent。保留缺失的真实 API contract 为 deferred integration；不要使用 mock，也不要宣称该 Action 已完成。`
                : `Defer ${deferredActionNames.join(", ")} and continue building the other ready Agents in the approved Scope. Keep the missing real API contract as a deferred integration; do not use mocks or claim that Action is complete.`;
            return enqueueInstruction(instruction, session.phase, refs, {
              behavior: "execute",
              action: "generate_package",
              arguments: {
                instruction,
                source: "ontocode-guidance",
                clarificationAnswer: instruction,
                resumeWaitingUserJobId: waitingResume.jobId,
                deferActionNames: deferredActionNames,
              },
              affectedSemanticPaths: refs,
              requestedCapabilities: [],
            });
            return;
          }
          if (action.type === "confirm_manual_boundary") {
            const system =
              typeof action.payload?.system === "string" &&
              action.payload.system.trim()
                ? action.payload.system.trim()
                : "the missing external integration";
            const instruction =
              language === "zh"
                ? `确认人工边界 ${system}。只继续生成明确标注该人工边界的设计稿；Sandbox、交付和晋升必须继续拦截，不能使用 mock。`
                : `Confirm a manual boundary for ${system}. Continue only with a draft that explicitly records this boundary; Sandbox, delivery, and promotion must remain blocked, with no mock substitution.`;
            return enqueueInstruction(instruction, session.phase, refs);
          }
          if (action.type === "reject_command") {
            const commandId =
              typeof action.payload?.commandId === "string"
                ? action.payload.commandId
                : "";
            if (!commandId) return;
            await decideCommand.mutateAsync({
              commandId,
              decision: "reject",
              request: {
                expectedSessionRevision: persistedSession.revision,
                note: "FDE rejected this command from the OntoCode workspace.",
              },
            });
            return;
          }
          if (action.type === "approve_command") {
            const commandId =
              typeof action.payload?.commandId === "string"
                ? action.payload.commandId
                : "";
            const pending = (commandsQuery.data?.items ?? []).find(
              (command) => command.id === commandId,
            );
            if (!pending || pending.riskClass === "production_deploy") return;
            const linkedJob = (jobsQuery.data?.items ?? []).find(
              (job) => job.commandId === commandId,
            );
            const decision = await decideCommand.mutateAsync({
              commandId,
              decision: "approve",
              request: {
                expectedSessionRevision: persistedSession.revision,
                note: "FDE approved this command after reviewing workspace evidence.",
              },
            });
            // Atomic chat turns already create a waiting Harness job beside a
            // human-gated command. The decision endpoint promotes that exact
            // row to queued so provenance and idempotency remain intact.
            if (linkedJob) return;
            const kind =
              pending.type === "propose_blueprint"
                ? "blueprint"
                : pending.type === "generate_package"
                  ? "build"
                  : pending.type === "run_tests" ||
                      pending.type === "generate_tests"
                    ? "test"
                    : pending.type === "debug_failure" ||
                        pending.type === "patch_artifact"
                      ? "debug"
                      : pending.type === "compare_candidate"
                        ? "regression"
                        : null;
            if (kind) {
              await createJob.mutateAsync({
                commandId,
                kind,
                expectedSessionRevision: decision.sessionRevision,
              });
            }
            return;
          }
          const instructions = {
            adjust_plan: t("ontocode.workspace.prompt.blueprint"),
            run_tests: t("ontocode.workspace.prompt.tests"),
            apply_patch: t("ontocode.workspace.prompt.debug"),
            prepare_release: t("ontocode.workspace.prompt.review"),
            deploy: t("ontocode.workspace.prompt.deploy"),
          } as const;
          const instruction =
            action.type in instructions
              ? instructions[action.type as keyof typeof instructions]
              : null;
          if (instruction) {
            return enqueueInstruction(instruction, session.phase, refs);
          }
        }}
      />
    </div>
  );
}
