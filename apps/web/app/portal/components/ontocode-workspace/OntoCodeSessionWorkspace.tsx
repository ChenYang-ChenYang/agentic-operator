"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon, type IconName } from "@/app/portal/components/Icon";
import { ApiResponseError } from "@/lib/api-response";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { LanguageToggle } from "@/app/portal/components/shell/appearance-controls";
import {
  PHASE_ICONS,
  PHASE_LABELS,
  SESSION_STATUS_ICONS,
  WORKSPACE_PHASES,
  defaultArtifactView,
  harnessStatusLabel,
  type ArtifactLane,
  type ArtifactView,
  type ConversationMessage,
  type HarnessStep,
  type SelectedArtifact,
  type SaveWorkspaceArtifactPatch,
  type SendWorkspaceMessageResult,
  type WorkspaceChangeSetView,
  type WorkspaceContextBar,
  type WorkspaceContextField,
  type WorkspaceEvidenceView,
  type WorkspaceGuidance,
  type WorkspaceGuidanceAction,
  type WorkspaceArtifactVersionContent,
  type WorkspaceMapOrigin,
  type WorkspaceMode,
  type WorkspacePhase,
  type WorkspacePhaseSummary,
  type WorkspacePrimaryAction,
  type WorkspaceProjection,
  type WorkspaceReceipt,
  type WorkspaceSandboxAttemptView,
  type WorkspaceDirective,
  type WorkspaceSession,
  type WorkspaceTestView,
} from "./model";
import styles from "./workspace.module.css";

export interface SendWorkspaceMessageInput {
  sessionId: string;
  message: string;
  phase: WorkspacePhase;
  contextRefs: string[];
}

export interface OntoCodeSessionWorkspaceProps {
  session: WorkspaceSession;
  /**
   * Historical Sessions stay inspectable, but every operation is disabled
   * when their Project's exact Business Domain registration is no longer active.
   */
  readOnlyReason?: string | null;
  /** Persisted server-side planning survives refreshes and API reconnects. */
  assistantRunActive?: boolean;
  messages?: ConversationMessage[];
  harnessSteps?: HarnessStep[];
  artifactLanes?: ArtifactLane[];
  /** Persisted control-plane data. An empty projection remains intentionally empty. */
  projection: WorkspaceProjection;
  onSendMessage?: (
    input: SendWorkspaceMessageInput,
  ) =>
    | void
    | ConversationMessage
    | SendWorkspaceMessageResult
    | Promise<void | ConversationMessage | SendWorkspaceMessageResult>;
  onPrimaryAction?: (
    action: WorkspacePrimaryAction,
  ) =>
    | void
    | SendWorkspaceMessageResult
    | Promise<void | SendWorkspaceMessageResult>;
  onPhaseChange?: (phase: WorkspacePhase) => void;
  onLoadArtifactVersion?: (
    versionId: string,
  ) => Promise<WorkspaceArtifactVersionContent>;
  /**
   * Commits a full-content CAS patch. The visual workspace only constructs
   * the exact request; the Connected boundary owns transport and cache truth.
   */
  onSaveArtifactPatch?: SaveWorkspaceArtifactPatch;
  /** Retires unfinished work without deleting its immutable history. */
  onRetireSession?: () => void | Promise<void>;
}

const ARTIFACT_TABS: Array<{ id: ArtifactView; label: string }> = [
  { id: "map", label: "Map" },
  { id: "changes", label: "Changes" },
  { id: "tests", label: "Tests" },
  { id: "evidence", label: "Evidence" },
];

const MACRO_STAGES: Array<{
  id: "understand" | "build" | "validate";
  phases: WorkspacePhase[];
  firstPhase: WorkspacePhase;
  labelKey: string;
}> = [
  {
    id: "understand",
    phases: ["scope", "blueprint"],
    firstPhase: "scope",
    labelKey: "ontocode.workspace.stage.understand",
  },
  {
    id: "build",
    phases: ["build"],
    firstPhase: "build",
    labelKey: "ontocode.workspace.stage.build",
  },
  {
    id: "validate",
    phases: ["tests", "debug", "review", "release"],
    firstPhase: "tests",
    labelKey: "ontocode.workspace.stage.validate",
  },
];

const RECOMMENDED_PROMPT_KEYS: Record<WorkspacePhase, string> = {
  scope: "ontocode.workspace.prompt.scope",
  blueprint: "ontocode.workspace.prompt.blueprint",
  build: "ontocode.workspace.prompt.build",
  tests: "ontocode.workspace.prompt.tests",
  debug: "ontocode.workspace.prompt.debug",
  review: "ontocode.workspace.prompt.review",
  release: "ontocode.workspace.prompt.release",
};

function isConversationMessage(
  value: ConversationMessage | SendWorkspaceMessageResult,
): value is ConversationMessage {
  return "actor" in value;
}

const EMPTY_MESSAGES: ConversationMessage[] = [];
const EMPTY_HARNESS_STEPS: HarnessStep[] = [];
const EMPTY_ARTIFACT_LANES: ArtifactLane[] = [];

export function mergePersistedMessages(
  persisted: ConversationMessage[],
  current: ConversationMessage[],
): ConversationMessage[] {
  const persistedIds = new Set(persisted.map((message) => message.id));
  const transient = current.filter((message) => {
    if (persistedIds.has(message.id)) return false;
    if (message.id.startsWith("local-user-")) {
      return !persisted.some(
        (candidate) =>
          candidate.actor === "user" && candidate.body === message.body,
      );
    }
    return message.status === "failed";
  });
  return [...persisted, ...transient];
}

type FailedTurn = {
  assistantMessageId: string;
  input: string;
};

type PendingWorkspaceAction = {
  type: WorkspacePrimaryAction["type"];
  payload?: Record<string, unknown>;
};

type FailedWorkspaceAction = PendingWorkspaceAction & {
  detail: string;
};

export type ArtifactContentState =
  | { status: "idle" }
  | { status: "loading"; versionId: string }
  | {
      status: "ready";
      versionId: string;
      payload: WorkspaceArtifactVersionContent;
    }
  | { status: "error"; versionId: string; message: string };

type ResolvedWorkspaceContext = {
  domain: WorkspaceContextField;
  project: WorkspaceContextField;
  session: WorkspaceContextField;
  ontologySnapshot: WorkspaceContextField;
  changeSet: WorkspaceContextField;
  environment: WorkspaceContextField;
  autonomy: WorkspaceContextField;
  activity: NonNullable<WorkspaceContextBar["activity"]>;
};

function contextField(
  field: WorkspaceContextField | undefined,
  value: string,
  options?: WorkspaceContextField["options"],
): WorkspaceContextField {
  return field ?? { value, options };
}

function workspaceContext(
  session: WorkspaceSession,
  phase: WorkspacePhase,
  projection: WorkspaceProjection,
): ResolvedWorkspaceContext {
  const projected = projection.context;
  const autonomy = contextField(projected?.autonomy, "Session policy");
  const statusTone =
    session.status === "needs_action"
      ? "warning"
      : session.status === "running"
        ? "running"
        : session.status === "released"
          ? "success"
          : "neutral";
  return {
    domain: contextField(projected?.domain, session.domain || "Domain pending"),
    project: contextField(projected?.project, session.title),
    session: contextField(projected?.session, session.id),
    ontologySnapshot: contextField(
      projected?.ontologySnapshot,
      session.ontology || "Snapshot pending",
    ),
    changeSet: contextField(projected?.changeSet, "No active Change Set"),
    environment: contextField(projected?.environment, "Not selected"),
    autonomy,
    activity:
      projected?.activity ??
      ({
        label: `${PHASE_LABELS[phase]} · ${session.statusLabel}`,
        detail: autonomy.value,
        tone: statusTone,
        icon: SESSION_STATUS_ICONS[session.status],
      } satisfies NonNullable<WorkspaceContextBar["activity"]>),
  };
}

function artifactDetailFromLanes(
  id: string,
  lanes: ArtifactLane[],
): SelectedArtifact | undefined {
  for (const lane of lanes) {
    const node = lane.nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    return {
      id: node.id,
      title: node.title,
      version: node.version ?? "Latest",
      source: lane.title,
      contract: node.subtitle,
      tests: node.meta ?? "No evidence linked yet",
      blockedBy: node.status === "blocked" ? node.meta : undefined,
    };
  }
  return undefined;
}

function projectedSelectedArtifact(
  projection: WorkspaceProjection,
): SelectedArtifact | null {
  if (projection.selectedArtifact !== undefined) {
    return projection.selectedArtifact;
  }
  // Keep the inspector quiet until the FDE (or a conversational directive)
  // deliberately selects a version. Auto-opening the first node made the
  // workspace feel like an editor the user had to understand up front.
  return null;
}

function workspaceTabCounts(
  projection: WorkspaceProjection,
  lanes: ArtifactLane[],
): Partial<Record<ArtifactView, number | string | null>> {
  const inferred: Partial<Record<ArtifactView, number | string | null>> = {
    map: lanes.reduce((total, lane) => total + lane.nodes.length, 0),
    changes: projection.changeSet?.rows.length ?? 0,
    tests:
      projection.tests?.suites.reduce((total, suite) => {
        const value =
          typeof suite.total === "number"
            ? suite.total
            : Number.parseInt(suite.total, 10);
        return Number.isFinite(value) ? total + value : total;
      }, 0) ?? 0,
    evidence: projection.evidence?.items.length ?? 0,
  };
  for (const view of ["map", "changes", "tests", "evidence"] as const) {
    if (
      projection.tabCounts &&
      Object.prototype.hasOwnProperty.call(projection.tabCounts, view)
    ) {
      inferred[view] = projection.tabCounts?.[view];
    }
  }
  return inferred;
}

export function OntoCodeSessionWorkspace({
  session,
  readOnlyReason,
  assistantRunActive = false,
  messages: providedMessages,
  harnessSteps: providedHarnessSteps,
  artifactLanes: providedArtifactLanes,
  projection,
  onSendMessage,
  onPrimaryAction,
  onPhaseChange,
  onLoadArtifactVersion,
  onSaveArtifactPatch,
  onRetireSession,
}: OntoCodeSessionWorkspaceProps) {
  const { t } = useI18n();
  const params = useParams<{ tenant?: string; sessionId?: string }>();
  const tenant = params.tenant ?? "raas";
  const sessionId = params.sessionId ?? session.id;
  const initialMessages = providedMessages ?? EMPTY_MESSAGES;
  const harnessSteps = providedHarnessSteps ?? EMPTY_HARNESS_STEPS;
  const artifactLanes = providedArtifactLanes ?? EMPTY_ARTIFACT_LANES;
  const readOnly = Boolean(readOnlyReason);

  const [phase, setPhase] = useState<WorkspacePhase>(session.phase);
  const [mode, setMode] = useState<WorkspaceMode>("balanced");
  const [artifactView, setArtifactView] = useState<ArtifactView>(
    defaultArtifactView(session.phase),
  );
  const [messages, setMessages] =
    useState<ConversationMessage[]>(initialMessages);
  const [messageText, setMessageText] = useState("");
  const [contextRefs, setContextRefs] = useState(projection.contextRefs ?? []);
  const [selectedArtifact, setSelectedArtifact] =
    useState<SelectedArtifact | null>(() =>
      projectedSelectedArtifact(projection),
    );
  const [harnessExpanded, setHarnessExpanded] = useState(false);
  const [showMessageHistory, setShowMessageHistory] = useState(false);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const lastAppliedDirectiveId = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failedTurn, setFailedTurn] = useState<FailedTurn | null>(null);
  const [pendingAction, setPendingAction] =
    useState<PendingWorkspaceAction | null>(null);
  const [failedAction, setFailedAction] =
    useState<FailedWorkspaceAction | null>(null);
  const testRunReady = projection?.testRun?.ready ?? Boolean(projection?.tests);
  const testRunBlocker =
    projection?.testRun?.blocker ?? t("ontocode.workspace.testBlocker");
  const [artifactContent, setArtifactContent] = useState<ArtifactContentState>({
    status: "idle",
  });
  const [artifactContentAttempt, setArtifactContentAttempt] = useState(0);
  const [retireConfirmationOpen, setRetireConfirmationOpen] = useState(false);
  const [retiringSession, setRetiringSession] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

  useEffect(() => {
    setMessages((current) => mergePersistedMessages(initialMessages, current));
  }, [initialMessages]);

  useEffect(() => {
    setPhase(session.phase);
    setArtifactView(defaultArtifactView(session.phase));
    setShowMessageHistory(false);
    setWorkspaceNotice(null);
    setHarnessExpanded(false);
    setFailedTurn(null);
    setPendingAction(null);
    setFailedAction(null);
    setRetireConfirmationOpen(false);
    setRetireError(null);
    lastAppliedDirectiveId.current = null;
  }, [session.id, session.phase]);

  useEffect(() => {
    setContextRefs(projection.contextRefs ?? []);
  }, [projection.contextRefs, session.id]);

  useEffect(() => {
    setSelectedArtifact((current) => {
      if (projection.selectedArtifact !== undefined) {
        return projection.selectedArtifact;
      }
      if (!current) return null;
      return (
        projection.artifactDetails?.[current.id] ??
        artifactDetailFromLanes(current.id, artifactLanes) ??
        null
      );
    });
  }, [
    artifactLanes,
    projection.artifactDetails,
    projection.selectedArtifact,
    session.id,
  ]);

  useEffect(() => {
    const artifactId = selectedArtifact?.id;
    const versionId = selectedArtifact?.versionId;
    if (!artifactId || !versionId || !onLoadArtifactVersion) {
      setArtifactContent({ status: "idle" });
      return;
    }

    let active = true;
    setArtifactContent({ status: "loading", versionId });
    void onLoadArtifactVersion(versionId)
      .then((payload) => {
        if (!active) return;
        if (
          payload.artifact.id !== artifactId ||
          payload.version.id !== versionId ||
          payload.version.artifactId !== artifactId
        ) {
          throw new Error(
            "Artifact version response does not match the selected artifact.",
          );
        }
        if (
          selectedArtifact.blobHash &&
          payload.version.blobHash !== selectedArtifact.blobHash
        ) {
          throw new Error(
            "Artifact content hash differs from the selected immutable version.",
          );
        }
        setArtifactContent({ status: "ready", versionId, payload });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setArtifactContent({
          status: "error",
          versionId,
          message:
            error instanceof Error
              ? error.message
              : "Unable to load immutable artifact content.",
        });
      });
    return () => {
      active = false;
    };
  }, [
    artifactContentAttempt,
    onLoadArtifactVersion,
    selectedArtifact?.blobHash,
    selectedArtifact?.id,
    selectedArtifact?.versionId,
  ]);

  const visibleHarnessSteps = useMemo(() => harnessSteps, [harnessSteps]);
  const activeHarnessSteps = useMemo(
    () => harnessSteps.filter((step) => step.status !== "complete"),
    [harnessSteps],
  );
  const hiddenMessageCount = Math.max(0, messages.length - 6);
  const visibleMessages =
    showMessageHistory || hiddenMessageCount === 0
      ? messages
      : messages.slice(-6);
  const phaseIndex = WORKSPACE_PHASES.indexOf(phase);
  const nextPhase =
    phaseIndex >= 0 && phaseIndex < WORKSPACE_PHASES.length - 1
      ? WORKSPACE_PHASES[phaseIndex + 1]
      : null;
  const phaseLabel = (value: WorkspacePhase) =>
    t(`ontocode.workspace.phase.${value}`);

  const context = workspaceContext(session, phase, projection);
  const receipts: WorkspaceReceipt[] = projection.receipts ?? [];
  const tabCounts = workspaceTabCounts(projection, artifactLanes);

  function choosePhase(next: WorkspacePhase) {
    setPhase(next);
    setArtifactView(defaultArtifactView(next));
    onPhaseChange?.(next);
  }

  function applyWorkspaceDirective(directive: WorkspaceDirective) {
    if (
      directive.sessionId !== sessionId ||
      lastAppliedDirectiveId.current === directive.id
    ) {
      return;
    }
    lastAppliedDirectiveId.current = directive.id;
    if (directive.phase) choosePhase(directive.phase);
    if (directive.artifactView) setArtifactView(directive.artifactView);
    if (directive.mode) setMode(directive.mode);
    if (directive.harnessExpanded !== undefined) {
      setHarnessExpanded(directive.harnessExpanded);
    }
    if (directive.artifactId) {
      const detail =
        projection.artifactDetails?.[directive.artifactId] ??
        artifactDetailFromLanes(directive.artifactId, artifactLanes);
      if (detail) {
        setSelectedArtifact(detail);
      } else {
        setWorkspaceNotice(
          t("ontocode.workspace.artifactNotFound", {
            id: directive.artifactId,
          }),
        );
      }
    }
    if (directive.focus === "harness") setHarnessExpanded(true);
    if (directive.notice) setWorkspaceNotice(directive.notice);
  }

  async function sendMessage(
    text = messageText,
    options: { appendUser?: boolean } = {},
  ) {
    const clean = text.trim();
    if (!clean || sending || readOnly || !onSendMessage) return;
    const appendUser = options.appendUser !== false;
    const userMessage: ConversationMessage = {
      id: `local-user-${messages.length + 1}`,
      actor: "user",
      name: t("ontocode.workspace.you"),
      time: t("ontocode.workspace.nowLabel"),
      body: clean,
    };
    if (appendUser) {
      setMessages((current) => [...current, userMessage]);
    }
    setMessageText("");
    setFailedTurn(null);
    setSending(true);

    try {
      const response = await onSendMessage({
        sessionId,
        message: clean,
        phase,
        contextRefs,
      });
      if (!response) {
        throw new Error(t("ontocode.workspace.noAssistantResponse"));
      }
      if (response) {
        const responseMessage = isConversationMessage(response)
          ? response
          : response.message;
        if (isConversationMessage(response)) {
          setMessages((current) =>
            current.some((item) => item.id === response.id)
              ? current
              : [...current, response],
          );
        } else {
          if (response.message) {
            setMessages((current) =>
              current.some((item) => item.id === response.message!.id)
                ? current
                : [...current, response.message!],
            );
          }
          if (response.directive) applyWorkspaceDirective(response.directive);
        }
        if (responseMessage?.status === "failed") {
          setFailedTurn({
            assistantMessageId: responseMessage.id,
            input: clean,
          });
        }
      }
    } catch (error) {
      const failure: ConversationMessage = {
        id: `assistant-client-error-${Date.now()}`,
        actor: "assistant",
        source: "assistant",
        status: "failed",
        name: "OntoCode",
        time: t("ontocode.workspace.nowLabel"),
        body: t("ontocode.workspace.turnFailed"),
        receipt:
          error instanceof Error
            ? error.message
            : t("ontocode.workspace.unknownError"),
      };
      setMessages((current) => [...current, failure]);
      setFailedTurn({
        assistantMessageId: failure.id,
        input: clean,
      });
    } finally {
      setSending(false);
    }
  }

  async function runAction(
    type: WorkspacePrimaryAction["type"],
    payload?: Record<string, unknown>,
  ) {
    if (readOnly || pendingAction || !onPrimaryAction) return;
    setFailedAction(null);
    setPendingAction({ type, payload });
    try {
      const response = await onPrimaryAction({
        type,
        sessionId,
        phase,
        payload,
      });
      if (response?.message) {
        setMessages((current) =>
          current.some((item) => item.id === response.message!.id)
            ? current
            : [...current, response.message!],
        );
        if (response.message.status === "failed") {
          setFailedAction({
            type,
            payload,
            detail:
              response.message.receipt ??
              t("ontocode.workspace.actionFailedDetail"),
          });
        }
      }
      if (response?.directive) applyWorkspaceDirective(response.directive);
    } catch (error) {
      setFailedAction({
        type,
        payload,
        detail:
          error instanceof Error
            ? error.message
            : t("ontocode.workspace.unknownError"),
      });
    } finally {
      setPendingAction(null);
    }
  }

  function removeContextRef(ref: string) {
    setContextRefs((current) => current.filter((value) => value !== ref));
  }

  return (
    <section className={styles.workspaceShell}>
      <header className={styles.contextBar}>
        <Link
          href={`/portal/${tenant}/ontocode-workspace`}
          className={styles.workspaceBrand}
        >
          <Icon name="chevron-left" size={14} />
          <span>
            <strong>OntoCode</strong>
            <small>{t("ontocode.workspace.sessionHub")}</small>
          </span>
        </Link>
        <div className={styles.sessionIdentity}>
          <span className={styles.sessionTenantIdentity}>
            <small>{t("ontocode.workspace.contextTenant")}</small>
            <b>{session.tenantName ?? tenant}</b>
            <code>{session.tenantSlug ?? tenant}</code>
          </span>
          <Icon name="chevron-right" size={11} />
          <span className={styles.sessionDomainIdentity}>
            <small>{t("ontocode.workspace.contextDomain")}</small>
            <b>{context.domain.value}</b>
            <em>
              {session.ontologySource === "allmeta"
                ? t("ontocode.workspace.sourceAllmeta")
                : session.ontologySource === "upload"
                  ? t("ontocode.workspace.sourceUpload")
                  : session.ontologySource === "historical"
                    ? t("ontocode.workspace.sourceHistorical")
                    : t("ontocode.workspace.sourceUnknown")}
            </em>
          </span>
          <Icon name="chevron-right" size={11} />
          <strong>{session.title}</strong>
          <code>{sessionId.toUpperCase()}</code>
        </div>
        <div className={styles.buildStatus} data-tone={context.activity.tone}>
          <Icon name={context.activity.icon ?? "replay"} size={14} />
          <span>
            <strong>{context.activity.label}</strong>
            <small>{context.activity.detail}</small>
          </span>
        </div>
        <div className={styles.workspaceLanguage}>
          <LanguageToggle />
        </div>
        <details className={styles.contextDetails}>
          <summary>
            <Icon name="settings" size={13} />
            {t("ontocode.workspace.context")}
          </summary>
          <div className={styles.contextDetailsPanel}>
            <ContextMeta
              label={t("ontocode.workspace.contextTenant")}
              value={`${session.tenantName ?? tenant} (${session.tenantSlug ?? tenant})`}
            />
            <ContextMeta
              label={t("ontocode.workspace.contextDomain")}
              value={`${context.domain.value} · ${
                session.ontologySource === "allmeta"
                  ? t("ontocode.workspace.sourceAllmeta")
                  : session.ontologySource === "upload"
                    ? t("ontocode.workspace.sourceUpload")
                    : session.ontologySource === "historical"
                      ? t("ontocode.workspace.sourceHistorical")
                      : t("ontocode.workspace.sourceUnknown")
              }`}
            />
            <ContextMeta
              label={t("ontocode.workspace.contextProject")}
              value={context.project.value}
            />
            <ContextMeta
              label={t("ontocode.workspace.contextOntology")}
              value={context.ontologySnapshot.value}
            />
            <ContextMeta
              label={t("ontocode.workspace.contextChangeSet")}
              value={context.changeSet.value}
            />
            <ContextMeta
              label={t("ontocode.workspace.contextEnvironment")}
              value={context.environment.value}
            />
            <ContextMeta
              label={t("ontocode.workspace.contextAutonomy")}
              value={context.autonomy.value}
            />
            {onRetireSession && !readOnly ? (
              <div className={styles.sessionLifecycle}>
                <div>
                  <strong>{t("ontocode.workspace.retireTitle")}</strong>
                  <span>{t("ontocode.workspace.retireDetail")}</span>
                </div>
                {retireConfirmationOpen ? (
                  <div
                    className={styles.sessionLifecycleConfirmation}
                    role="alertdialog"
                    aria-label={t("ontocode.workspace.retireConfirmTitle")}
                  >
                    <p>{t("ontocode.workspace.retireConfirmDetail")}</p>
                    {retireError ? (
                      <span
                        className={styles.sessionLifecycleError}
                        role="alert"
                      >
                        {retireError}
                      </span>
                    ) : null}
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setRetireConfirmationOpen(false);
                          setRetireError(null);
                        }}
                        disabled={retiringSession}
                      >
                        {t("ontocode.workspace.retireCancel")}
                      </button>
                      <button
                        type="button"
                        data-tone="danger"
                        disabled={retiringSession}
                        onClick={() => {
                          setRetiringSession(true);
                          setRetireError(null);
                          void Promise.resolve(onRetireSession())
                            .catch((error: unknown) => {
                              setRetireError(
                                error instanceof Error
                                  ? error.message
                                  : t("ontocode.workspace.retireFailed"),
                              );
                            })
                            .finally(() => setRetiringSession(false));
                        }}
                      >
                        {retiringSession
                          ? t("ontocode.workspace.retiring")
                          : t("ontocode.workspace.retireConfirm")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRetireConfirmationOpen(true)}
                  >
                    {t("ontocode.workspace.retireAction")}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </details>
      </header>

      {readOnlyReason ? (
        <div
          className={styles.readOnlyBanner}
          id="ontocode-session-read-only"
          role="alert"
        >
          <Icon name="alert" size={15} />
          <div>
            <strong>{t("ontocode.workspace.readOnlyTitle")}</strong>
            <span>{readOnlyReason}</span>
          </div>
          <Link href={`/portal/${tenant}/ontocode-workspace`}>
            {t("ontocode.workspace.readOnlyBack")}
          </Link>
        </div>
      ) : null}

      <div className={styles.phaseAndModeBar}>
        <nav
          className={styles.macroStageNav}
          aria-label={t("ontocode.workspace.buildJourney")}
        >
          {MACRO_STAGES.map((stage, index) => {
            const active = stage.phases.includes(phase);
            const complete = stage.phases.every(
              (item) => projection.completedPhases?.includes(item) === true,
            );
            return (
              <button
                type="button"
                key={stage.id}
                data-selected={active ? "true" : "false"}
                data-complete={complete ? "true" : "false"}
                onClick={() => choosePhase(stage.firstPhase)}
                aria-current={active ? "step" : undefined}
              >
                <span>
                  {complete ? <Icon name="check" size={11} /> : index + 1}
                </span>
                <strong>{t(stage.labelKey)}</strong>
              </button>
            );
          })}
        </nav>
        <div className={styles.nowNext}>
          <span>
            {t("ontocode.workspace.now")} <strong>{phaseLabel(phase)}</strong>
          </span>
          <Icon name="chevron-right" size={11} />
          <span>
            {t("ontocode.workspace.next")}{" "}
            <strong>
              {nextPhase
                ? phaseLabel(nextPhase)
                : t("ontocode.workspace.completed")}
            </strong>
          </span>
        </div>
        <details className={styles.advancedFlow}>
          <summary>{t("ontocode.workspace.fullFlow")}</summary>
          <nav className={styles.phaseNav}>
            {WORKSPACE_PHASES.map((item) => {
              const active = item === phase;
              const complete =
                projection.completedPhases?.includes(item) === true;
              return (
                <button
                  type="button"
                  key={item}
                  className={active ? styles.phaseActive : styles.phaseButton}
                  data-phase={item}
                  data-selected={active ? "true" : "false"}
                  data-persisted-complete={complete ? "true" : "false"}
                  onClick={() => choosePhase(item)}
                  aria-current={active ? "step" : undefined}
                >
                  <Icon
                    name={complete ? "check" : PHASE_ICONS[item]}
                    size={13}
                  />
                  {phaseLabel(item)}
                </button>
              );
            })}
          </nav>
        </details>
      </div>

      <main
        className={`${styles.sessionMain} ${styles[`mode_${mode}`]}`}
        data-mode={mode}
      >
        <section
          className={styles.chatPanel}
          aria-label={t("ontocode.workspace.chatAria")}
        >
          <header className={styles.panelHeader}>
            <div>
              <span className={styles.panelEyebrow}>
                <Icon name="spark" size={12} />
                {t("ontocode.workspace.aiCopilot")}
              </span>
              <h1>{t("ontocode.workspace.chatTitle")}</h1>
            </div>
            <div className={styles.chatHeaderActions}>
              <button
                type="button"
                onClick={() =>
                  setMode(mode === "artifacts" ? "conversation" : "artifacts")
                }
                title={t("ontocode.workspace.viewResults")}
              >
                <Icon name="library" size={15} />
                <span>{t("ontocode.workspace.viewResults")}</span>
              </button>
              <Link
                href={`/portal/${tenant}/ontocode-workspace`}
                title={t("ontocode.workspace.newSession")}
              >
                <Icon name="plus" size={15} />
              </Link>
            </div>
          </header>

          <div className={styles.messageList} aria-live="polite">
            {hiddenMessageCount > 0 && !showMessageHistory ? (
              <button
                type="button"
                className={styles.messageHistoryButton}
                onClick={() => setShowMessageHistory(true)}
              >
                <Icon name="replay" size={12} />
                {t("ontocode.workspace.earlierMessages", {
                  count: hiddenMessageCount,
                })}
              </button>
            ) : null}
            {visibleMessages.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                readOnly={readOnly}
                actionBusy={Boolean(pendingAction)}
                onAction={(action) =>
                  void runAction(action.type, action.payload)
                }
                onRetry={
                  failedTurn?.assistantMessageId === message.id
                    ? () => {
                        setMessages((current) =>
                          current.filter((item) => item.id !== message.id),
                        );
                        void sendMessage(failedTurn.input, {
                          appendUser: false,
                        });
                      }
                    : undefined
                }
              />
            ))}

            {sending || assistantRunActive ? <AssistantThinkingCard /> : null}

            {pendingAction ? (
              <ActionPendingCard actionType={pendingAction.type} />
            ) : null}

            {failedAction ? (
              <ActionFailureCard
                detail={failedAction.detail}
                onRetry={() =>
                  void runAction(failedAction.type, failedAction.payload)
                }
              />
            ) : null}

            {activeHarnessSteps.length > 0 ? (
              <HarnessActivityCard
                steps={activeHarnessSteps}
                onExpand={() => setHarnessExpanded(true)}
              />
            ) : null}

            {projection.guidance ? (
              <GuidanceCard
                guidance={projection.guidance}
                readOnly={readOnly}
                actionBusy={Boolean(pendingAction)}
                onAction={(action) =>
                  void runAction(action.type, action.payload)
                }
              />
            ) : null}

            {receipts.length > 0 ? (
              <div className={styles.receiptStrip}>
                {receipts.map((receipt) => (
                  <div
                    key={receipt.id}
                    data-status={receipt.status ?? "neutral"}
                    data-projected
                  >
                    <Icon
                      name={
                        receipt.icon ??
                        (receipt.status === "warning"
                          ? "alert"
                          : receipt.status === "running"
                            ? "replay"
                            : "check")
                      }
                      size={14}
                    />
                    <span>{receipt.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className={styles.composerArea}>
            <div className={styles.contextChips}>
              {contextRefs.map((ref) => (
                <button
                  type="button"
                  key={ref}
                  onClick={() => removeContextRef(ref)}
                  title={`${t("ontocode.workspace.removeContext")}: ${ref}`}
                >
                  <span>@</span>
                  {contextRefLabel(ref)}
                  <Icon name="x" size={10} />
                </button>
              ))}
            </div>
            <div className={styles.composer}>
              <textarea
                value={messageText}
                onChange={(event) => setMessageText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={t("ontocode.workspace.composerPlaceholder", {
                  phase: phaseLabel(phase),
                })}
                aria-label={t("ontocode.workspace.sendAria")}
                aria-describedby={
                  readOnly ? "ontocode-session-read-only" : undefined
                }
                disabled={readOnly}
              />
              <div className={styles.composerTools}>
                <span className={styles.autonomyLabel}>
                  <Icon name="spark" size={13} />
                  {context.autonomy.value}
                </span>
                <button
                  type="button"
                  className={styles.sendButton}
                  onClick={() => void sendMessage()}
                  disabled={
                    readOnly || !messageText.trim() || sending || !onSendMessage
                  }
                >
                  {sending
                    ? t("ontocode.workspace.sending")
                    : t("ontocode.workspace.send")}
                  <Icon name="chevron-right" size={14} />
                </button>
              </div>
            </div>
            <div className={styles.suggestionRow}>
              <button
                type="button"
                className={styles.recommendedPrompt}
                disabled={
                  readOnly ||
                  sending ||
                  !onSendMessage ||
                  (phase === "tests" && !testRunReady)
                }
                title={
                  phase === "tests" && !testRunReady
                    ? testRunBlocker
                    : undefined
                }
                onClick={() =>
                  void sendMessage(t(RECOMMENDED_PROMPT_KEYS[phase]))
                }
              >
                <Icon name="spark" size={12} />
                {t("ontocode.workspace.recommended")} ·{" "}
                {t(RECOMMENDED_PROMPT_KEYS[phase])}
              </button>
              <button
                type="button"
                disabled={readOnly || sending || !onSendMessage}
                onClick={() =>
                  void sendMessage(t("ontocode.workspace.prompt.openEvidence"))
                }
              >
                {t("ontocode.workspace.openEvidence")}
              </button>
              <button
                type="button"
                disabled={readOnly || sending || !onSendMessage}
                onClick={() =>
                  void sendMessage(t("ontocode.workspace.prompt.expandHarness"))
                }
              >
                {t("ontocode.workspace.executionDetails")}
              </button>
            </div>
            <p className={styles.chatControlHint}>
              {t("ontocode.workspace.chatControlHint")}
            </p>
          </div>
        </section>

        <section
          className={styles.artifactPanel}
          aria-label="Live Artifact Workspace"
        >
          <header className={styles.artifactHeader}>
            <div>
              <span className={styles.panelEyebrow}>
                {t("ontocode.workspace.currentResult")}
              </span>
              <h2>
                {projection?.artifactTitle ??
                  t("ontocode.workspace.artifactTitle")}
              </h2>
              <span role="status" aria-live="polite">
                {workspaceNotice ??
                  projection?.artifactSubtitle ??
                  t("ontocode.workspace.artifactSubtitle")}
              </span>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() =>
                setMode(mode === "artifacts" ? "conversation" : "artifacts")
              }
            >
              <Icon
                name={mode === "artifacts" ? "chevron-left" : "external"}
                size={14}
              />
              {mode === "artifacts"
                ? t("ontocode.workspace.backToChat")
                : t("ontocode.workspace.focusWorkspace")}
            </button>
          </header>

          <div className={styles.artifactTabs}>
            {ARTIFACT_TABS.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={
                  artifactView === tab.id
                    ? styles.artifactTabActive
                    : styles.artifactTab
                }
                onClick={() => setArtifactView(tab.id)}
              >
                {t(`ontocode.workspace.tab.${tab.id}`)}
                {tabCounts[tab.id] !== null &&
                tabCounts[tab.id] !== undefined ? (
                  <span>{tabCounts[tab.id]}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className={styles.artifactContent}>
            {artifactView === "map" ? (
              <PhaseMap
                phase={phase}
                lanes={artifactLanes}
                selectedId={selectedArtifact?.id ?? ""}
                summary={projection.phaseSummaries?.[phase]}
                origin={
                  projection.mapOrigin ?? {
                    title: session.title,
                    slug: session.id,
                  }
                }
                onSelect={(id) => {
                  const detail =
                    projection.artifactDetails?.[id] ??
                    artifactDetailFromLanes(id, artifactLanes);
                  setSelectedArtifact(detail ?? null);
                }}
              />
            ) : null}
            {artifactView === "changes" ? (
              <ChangesView view={projection.changeSet} />
            ) : null}
            {artifactView === "tests" ? (
              <TestsView
                view={projection.tests}
                readOnly={readOnly}
                canRun={testRunReady}
                blocker={testRunBlocker}
                onRun={() => void runAction("run_tests")}
                onDebug={() =>
                  void sendMessage(t("ontocode.workspace.prompt.debug"))
                }
              />
            ) : null}
            {artifactView === "evidence" ? (
              <EvidenceView
                view={projection.evidence}
                readOnly={readOnly}
                onAction={(action) =>
                  void runAction(action.type, action.payload)
                }
              />
            ) : null}
          </div>

          <ArtifactInspector
            artifact={selectedArtifact}
            content={artifactContent}
            readOnly={readOnly}
            onRetry={() => setArtifactContentAttempt((current) => current + 1)}
            onSave={onSaveArtifactPatch}
          />
        </section>
      </main>

      <HarnessTray
        steps={visibleHarnessSteps}
        expanded={harnessExpanded}
        activityLabel={context.activity.label}
        activityDetail={context.activity.detail}
        onToggle={() => setHarnessExpanded((value) => !value)}
        onEvidence={() => {
          setArtifactView("evidence");
          setMode("artifacts");
        }}
      />
    </section>
  );
}

function ContextMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.contextMeta}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function contextRefLabel(ref: string): string {
  if (ref.startsWith("ontology:")) {
    return `Ontology · ${ref.slice("ontology:".length, "ontology:".length + 10)}…`;
  }
  if (ref.startsWith("artifact:")) {
    const versionId = ref.split("@").at(-1) ?? ref;
    return `Artifact · ${versionId.slice(0, 18)}`;
  }
  if (ref.startsWith("changeset:")) {
    return `Change Set · ${ref.slice("changeset:".length, "changeset:".length + 18)}`;
  }
  if (ref.startsWith("evidence:")) {
    return `Evidence · ${ref.slice("evidence:".length, "evidence:".length + 18)}`;
  }
  return ref.length > 32 ? `${ref.slice(0, 29)}…` : ref;
}

export function MessageCard({
  message,
  readOnly,
  actionBusy = false,
  onAction,
  onRetry,
}: {
  message: ConversationMessage;
  readOnly: boolean;
  actionBusy?: boolean;
  onAction: (action: WorkspaceGuidanceAction) => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const failed = message.status === "failed";
  const source = message.source ?? "assistant";
  return (
    <article
      className={styles.messageCard}
      data-actor={message.actor}
      data-source={source}
      data-status={failed ? "failed" : "complete"}
    >
      <header>
        <span className={styles.messageActor}>
          <Icon
            name={
              failed
                ? "alert"
                : message.actor === "user"
                  ? "human"
                  : source === "tool"
                    ? "code"
                    : source === "system"
                      ? "settings"
                      : "spark"
            }
            size={15}
          />
        </span>
        <strong>{message.name}</strong>
        {failed ? (
          <span className={styles.messageStatus}>
            {t("ontocode.workspace.messageFailed")}
          </span>
        ) : null}
        <time>{message.time}</time>
      </header>
      <p>{message.body}</p>
      {message.recommendations && message.recommendations.length > 0 ? (
        <div className={styles.messageRecommendations}>
          {message.recommendations.map((recommendation) => (
            <section
              key={recommendation.id}
              data-recommended={recommendation.recommended ? "true" : "false"}
            >
              <div>
                <strong>{recommendation.title}</strong>
                {recommendation.recommended ? (
                  <small>{t("ontocode.workspace.recommended")}</small>
                ) : null}
              </div>
              <p>{recommendation.reason}</p>
              {recommendation.impact ? (
                <small>{recommendation.impact}</small>
              ) : null}
              {recommendation.action ? (
                <button
                  type="button"
                  className={
                    recommendation.action.variant === "primary"
                      ? styles.primaryButton
                      : styles.secondaryButton
                  }
                  onClick={() => onAction(recommendation.action!)}
                  disabled={
                    readOnly || actionBusy || recommendation.action.disabled
                  }
                >
                  {recommendation.action.label}
                  <Icon name="chevron-right" size={12} />
                </button>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
      {message.receipt ? (
        <div
          className={styles.messageReceipt}
          data-status={failed ? "failed" : "complete"}
        >
          <Icon name={failed ? "alert" : "check"} size={12} />
          {message.receipt}
        </div>
      ) : null}
      {failed && onRetry ? (
        <footer className={styles.messageFailureActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onRetry}
            disabled={readOnly || actionBusy}
          >
            <Icon name="replay" size={12} />
            {t("ontocode.workspace.retryTurn")}
          </button>
          <small>{t("ontocode.workspace.retryTurnHint")}</small>
        </footer>
      ) : null}
    </article>
  );
}

export function AssistantThinkingCard() {
  const { t } = useI18n();
  return (
    <article className={styles.thinkingCard} role="status" aria-live="polite">
      <span className={styles.thinkingIcon}>
        <Icon name="replay" size={15} />
      </span>
      <div>
        <strong>{t("ontocode.workspace.thinkingTitle")}</strong>
        <p>{t("ontocode.workspace.thinkingDetail")}</p>
        <small>{t("ontocode.workspace.thinkingTruth")}</small>
      </div>
    </article>
  );
}

function ActionPendingCard({
  actionType,
}: {
  actionType: WorkspacePrimaryAction["type"];
}) {
  const { t } = useI18n();
  return (
    <article className={styles.actionStateCard} data-status="running">
      <span>
        <Icon name="replay" size={14} />
      </span>
      <div>
        <strong>{t("ontocode.workspace.actionRunning")}</strong>
        <p>{actionType}</p>
      </div>
    </article>
  );
}

export function ActionFailureCard({
  detail,
  onRetry,
}: {
  detail: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <article
      className={styles.actionStateCard}
      data-status="failed"
      role="alert"
    >
      <span>
        <Icon name="alert" size={14} />
      </span>
      <div>
        <strong>{t("ontocode.workspace.actionFailed")}</strong>
        <p>{detail}</p>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onRetry}
        >
          <Icon name="replay" size={12} />
          {t("ontocode.workspace.retryAction")}
        </button>
      </div>
    </article>
  );
}

export function HarnessActivityCard({
  steps,
  onExpand,
}: {
  steps: HarnessStep[];
  onExpand: () => void;
}) {
  const { t } = useI18n();
  return (
    <article
      className={styles.harnessActivityCard}
      data-live-count={steps.length}
    >
      <header>
        <span>
          <Icon name="replay" size={14} />
        </span>
        <div>
          <strong>{t("ontocode.workspace.harnessActivityTitle")}</strong>
          <small>
            {t("ontocode.workspace.harnessActivityCount", {
              count: steps.length,
            })}
          </small>
        </div>
        <button type="button" onClick={onExpand}>
          {t("ontocode.workspace.executionDetails")}
          <Icon name="chevron-right" size={11} />
        </button>
      </header>
      <ol>
        {steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <Icon
              name={
                step.status === "blocked"
                  ? "alert"
                  : step.status === "running"
                    ? "replay"
                    : "dot"
              }
              size={12}
            />
            <span>
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </span>
            <em>{t(`ontocode.workspace.harnessStatus.${step.status}`)}</em>
          </li>
        ))}
      </ol>
    </article>
  );
}

function GuidanceCard({
  guidance,
  readOnly,
  actionBusy,
  onAction,
}: {
  guidance: WorkspaceGuidance;
  readOnly: boolean;
  actionBusy: boolean;
  onAction: (action: NonNullable<WorkspaceGuidance["actions"]>[number]) => void;
}) {
  const { t } = useI18n();
  const status = guidance.status ?? "informational";
  const resolved = status === "resolved";
  const rows = [
    guidance.reason
      ? [t("ontocode.workspace.guidance.reason"), guidance.reason]
      : null,
    guidance.impact
      ? [t("ontocode.workspace.guidance.impact"), guidance.impact]
      : null,
    guidance.recommendation
      ? [t("ontocode.workspace.guidance.next"), guidance.recommendation]
      : null,
  ].filter((row): row is [string, string] => row !== null);

  return (
    <article
      className={styles.configCard}
      data-resolved={resolved}
      data-guidance-status={status}
    >
      <header>
        <span className={styles.configIcon}>
          <Icon
            name={
              resolved ? "check" : status === "attention" ? "alert" : "spark"
            }
            size={15}
          />
        </span>
        <div>
          <strong>{guidance.title}</strong>
          <small>{guidance.statusLabel}</small>
        </div>
      </header>
      {rows.length > 0 ? (
        <dl>
          {rows.map(([label, detail]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {guidance.items && guidance.items.length > 0 ? (
        <div className={styles.guidanceItems}>
          {guidance.items.map((item) => (
            <section
              key={item.id}
              className={styles.guidanceItem}
              data-status={item.status ?? "configuration"}
            >
              <div className={styles.guidanceItemStatus}>
                <Icon
                  name={
                    item.status === "ready"
                      ? "check"
                      : item.status === "running"
                        ? "replay"
                        : item.status === "decision"
                          ? "human"
                          : "alert"
                  }
                  size={13}
                />
              </div>
              <div className={styles.guidanceItemBody}>
                <div>
                  <strong>{item.title}</strong>
                  {item.statusLabel ? <small>{item.statusLabel}</small> : null}
                </div>
                <p>{item.detail}</p>
                {item.actions && item.actions.length > 0 ? (
                  <footer>
                    {item.actions.map((action) => (
                      <button
                        type="button"
                        key={`${item.id}-${action.type}-${action.label}`}
                        className={
                          action.variant === "primary"
                            ? styles.primaryButton
                            : styles.secondaryButton
                        }
                        onClick={() => onAction(action)}
                        disabled={readOnly || actionBusy || action.disabled}
                      >
                        {action.variant === "primary" ? (
                          <Icon name="chevron-right" size={13} />
                        ) : null}
                        {action.label}
                      </button>
                    ))}
                  </footer>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      ) : null}
      {guidance.actions && guidance.actions.length > 0 ? (
        <footer>
          {guidance.actions.map((action) => (
            <button
              type="button"
              key={`${action.type}-${action.label}`}
              className={
                action.variant === "primary"
                  ? styles.primaryButton
                  : styles.secondaryButton
              }
              onClick={() => onAction(action)}
              disabled={readOnly || actionBusy || action.disabled}
            >
              {action.variant === "primary" ? (
                <Icon name={resolved ? "check" : "chevron-right"} size={14} />
              ) : null}
              {action.label}
            </button>
          ))}
        </footer>
      ) : null}
    </article>
  );
}

function PhaseMap({
  phase,
  lanes,
  selectedId,
  summary,
  origin,
  onSelect,
}: {
  phase: WorkspacePhase;
  lanes: ArtifactLane[];
  selectedId: string;
  summary?: WorkspacePhaseSummary;
  origin: WorkspaceMapOrigin;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  if (phase !== "build") {
    return (
      <ProjectedPhaseSurface
        phase={phase}
        summary={summary}
        artifactCount={lanes.reduce(
          (total, lane) => total + lane.nodes.length,
          0,
        )}
      />
    );
  }
  return (
    <div className={styles.mapCanvas}>
      <div className={styles.jobOrigin}>
        <span className={styles.nodeIcon}>
          <Icon name={origin.icon ?? "task"} size={15} />
        </span>
        <strong>{origin.title}</strong>
        <small>{origin.slug}</small>
      </div>
      <Icon name="chevron-right" size={18} color="var(--text-3)" />
      {lanes.length > 0 ? (
        <div className={styles.artifactLanes}>
          {lanes.map((lane, laneIndex) => (
            <div className={styles.artifactLane} key={lane.id}>
              <header>
                <strong>{lane.title}</strong>
                <span>{lane.subtitle}</span>
              </header>
              <div className={styles.laneNodes}>
                {lane.nodes.map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    className={`${styles.artifactNode} ${
                      selectedId === node.id ? styles.artifactNodeSelected : ""
                    }`}
                    data-status={node.status}
                    onClick={() => onSelect(node.id)}
                  >
                    <span className={styles.nodeIcon}>
                      <Icon name={node.icon} size={14} />
                    </span>
                    <span className={styles.nodeCopy}>
                      <strong>{node.title}</strong>
                      <small>{node.subtitle}</small>
                      {node.version ? <small>{node.version}</small> : null}
                    </span>
                    <span className={styles.nodeState}>
                      <Icon
                        name={
                          node.status === "blocked"
                            ? "alert"
                            : node.status === "running"
                              ? "replay"
                              : node.status === "queued"
                                ? "dot"
                                : "check"
                        }
                        size={12}
                      />
                      {node.meta ? <small>{node.meta}</small> : null}
                    </span>
                  </button>
                ))}
              </div>
              {laneIndex < lanes.length - 1 ? (
                <span className={styles.laneArrow} aria-hidden="true">
                  <Icon name="chevron-right" size={18} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.projectionEmpty}>
          <Icon name="library" size={18} />
          <strong>{t("ontocode.workspace.emptyArtifactTitle")}</strong>
          <span>{t("ontocode.workspace.emptyArtifactDetail")}</span>
        </div>
      )}
    </div>
  );
}

function ProjectedPhaseSurface({
  phase,
  summary,
  artifactCount,
}: {
  phase: WorkspacePhase;
  summary?: WorkspacePhaseSummary;
  artifactCount: number;
}) {
  const { t } = useI18n();
  const phaseLabel = t(`ontocode.workspace.phase.${phase}`);
  const resolved = summary ?? {
    title: `${phaseLabel} workspace`,
    description: t("ontocode.workspace.phaseEmptyDetail"),
    statusLabel:
      artifactCount > 0
        ? t("ontocode.workspace.linkedArtifacts", { count: artifactCount })
        : t("ontocode.workspace.waitingEvidence"),
    tone: "neutral" as const,
  };
  return (
    <div className={styles.projectedPhaseSurface} data-tone={resolved.tone}>
      <span className={styles.iconWell}>
        <Icon name={PHASE_ICONS[phase]} size={18} />
      </span>
      <div>
        <span>{phaseLabel}</span>
        <h3>{resolved.title}</h3>
        <p>{resolved.description}</p>
      </div>
      {resolved.statusLabel ? <small>{resolved.statusLabel}</small> : null}
    </div>
  );
}

function ChangesView({ view }: { view?: WorkspaceChangeSetView | null }) {
  const { t } = useI18n();
  if (!view) {
    return (
      <ProjectionEmptyState
        icon="git"
        title={t("ontocode.workspace.empty.changeSetTitle")}
        detail={t("ontocode.workspace.empty.changeSetDetail")}
      />
    );
  }

  const resolved = view;
  return (
    <div className={styles.tableSurface}>
      <header>
        <div>
          <h3>{resolved.title}</h3>
          <span>{resolved.subtitle}</span>
        </div>
      </header>
      {resolved.rows.length > 0 ? (
        <div className={styles.changeTable} role="table">
          {resolved.rows.map((row) => (
            <div role="row" key={row.id}>
              <span className={styles.operationType}>{row.operation}</span>
              <strong>{row.target}</strong>
              <small>{row.summary}</small>
              <span data-status={row.status}>
                <Icon
                  name={
                    row.status === "blocked"
                      ? "alert"
                      : row.status === "pending"
                        ? "dot"
                        : "check"
                  }
                  size={12}
                />
                {row.statusLabel ?? row.status}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.tableEmpty}>
          {resolved.emptyLabel ?? t("ontocode.workspace.empty.changeSetRows")}
        </div>
      )}
    </div>
  );
}

function TestsView({
  view,
  readOnly,
  canRun,
  blocker,
  onRun,
  onDebug,
}: {
  view?: WorkspaceTestView | null;
  readOnly: boolean;
  canRun: boolean;
  blocker: string;
  onRun: () => void;
  onDebug: () => void;
}) {
  const { t } = useI18n();
  if (!view) {
    return (
      <ProjectionEmptyState
        icon="task"
        title={
          canRun
            ? t("ontocode.workspace.empty.testsTitle")
            : t("ontocode.workspace.empty.testsBlockedTitle")
        }
        detail={canRun ? t("ontocode.workspace.empty.testsDetail") : blocker}
        action={
          canRun
            ? {
                label: t("ontocode.workspace.runTests"),
                onClick: onRun,
                disabled: readOnly,
              }
            : undefined
        }
      />
    );
  }

  const resolved = view;
  return (
    <div className={styles.tableSurface}>
      <header>
        <div>
          <h3>{resolved.title}</h3>
          <span>{resolved.subtitle}</span>
        </div>
        <div className={styles.headerActions}>
          {resolved.allowDebug ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onDebug}
              disabled={readOnly}
            >
              <Icon name="code" size={13} /> Debug
            </button>
          ) : null}
          {resolved.allowRun && canRun ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onRun}
              disabled={readOnly}
            >
              <Icon name="play" size={13} />
              {t("ontocode.workspace.runTests")}
            </button>
          ) : null}
        </div>
      </header>
      <div className={styles.testSummary}>
        {resolved.metrics.map((metric) => (
          <article key={metric.id} data-tone={metric.tone ?? "neutral"}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </article>
        ))}
      </div>
      {resolved.sandboxAttempts && resolved.sandboxAttempts.length > 0 ? (
        <SandboxAttemptCards attempts={resolved.sandboxAttempts} />
      ) : null}
      <div className={styles.testTable} role="table">
        <div role="row" className={styles.tableHead}>
          <span>Suite</span>
          <span>Total</span>
          <span>Passed</span>
          <span>Failed</span>
          <span>Blocked</span>
        </div>
        {resolved.suites.map((suite) => (
          <div role="row" key={suite.id}>
            <strong>{suite.name}</strong>
            <span>{suite.total}</span>
            <span>{suite.passed}</span>
            <span>{suite.failed}</span>
            <span>{suite.blocked}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EvidenceView({
  view,
  readOnly,
  onAction,
}: {
  view?: WorkspaceEvidenceView | null;
  readOnly: boolean;
  onAction: (action: WorkspaceGuidanceAction) => void;
}) {
  const { t } = useI18n();
  if (!view) {
    return (
      <ProjectionEmptyState
        icon="library"
        title={t("ontocode.workspace.empty.evidenceTitle")}
        detail={t("ontocode.workspace.empty.evidenceDetail")}
      />
    );
  }

  const resolved = view;
  const gate = resolved.gate;
  const gateAction = gate?.action;
  return (
    <div className={styles.tableSurface}>
      <header>
        <div>
          <h3>{resolved.title}</h3>
          <span>{resolved.subtitle}</span>
        </div>
      </header>
      <div className={styles.evidenceGrid}>
        {resolved.items.map((item) => (
          <article key={item.id} data-status={item.status}>
            <span className={styles.evidenceIcon}>
              <Icon
                name={
                  item.icon ??
                  (item.status === "complete"
                    ? "check"
                    : item.status === "warning"
                      ? "alert"
                      : "dot")
                }
                size={14}
              />
            </span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
            <Icon name="chevron-right" size={13} />
          </article>
        ))}
      </div>
      {resolved.sandboxAttempts && resolved.sandboxAttempts.length > 0 ? (
        <SandboxAttemptCards attempts={resolved.sandboxAttempts} />
      ) : null}
      {gate ? (
        <div className={styles.releaseGate} data-status={gate.status}>
          <div>
            <span>{gate.label}</span>
            <strong>{gate.title}</strong>
            <small>{gate.detail}</small>
          </div>
          {gateAction ? (
            <button
              type="button"
              className={
                gateAction.variant === "secondary"
                  ? styles.secondaryButton
                  : styles.primaryButton
              }
              onClick={() => onAction(gateAction)}
              disabled={readOnly || gateAction.disabled}
            >
              <Icon name="chevron-right" size={14} />
              {gateAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function shortArtifactIdentity(value: string, length = 18): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function SandboxAttemptCards({
  attempts,
}: {
  attempts: WorkspaceSandboxAttemptView[];
}) {
  const { language } = useI18n();
  return (
    <section
      className={styles.sandboxAttempts}
      aria-label={
        language === "zh"
          ? "精确 Candidate SandboxAttempt"
          : "Exact Candidate Sandbox attempts"
      }
    >
      <header>
        <div>
          <strong>
            {language === "zh"
              ? "精确 Candidate SandboxAttempt"
              : "Exact Candidate Sandbox attempts"}
          </strong>
          <span>
            {language === "zh"
              ? "以下资格与回执均来自持久化后端，不由 UI 推断"
              : "Qualification and receipts below are persisted backend facts, never UI inference"}
          </span>
        </div>
      </header>
      <div className={styles.sandboxAttemptList}>
        {attempts.map((attempt) => {
          const promotable = attempt.qualification === "promotable";
          return (
            <article
              key={attempt.id}
              className={styles.sandboxAttemptCard}
              data-qualification={attempt.qualification}
              data-status={attempt.status}
            >
              <header>
                <span
                  className={styles.sandboxAttemptIcon}
                  data-promotable={promotable ? "true" : "false"}
                >
                  <Icon name={promotable ? "check" : "alert"} size={14} />
                </span>
                <div>
                  <strong>
                    #{attempt.ordinal} · {shortArtifactIdentity(attempt.id)}
                  </strong>
                  <small>
                    {attempt.status} · {attempt.qualification}
                  </small>
                </div>
                <span
                  className={styles.sandboxQualification}
                  data-promotable={promotable ? "true" : "false"}
                >
                  {promotable
                    ? language === "zh"
                      ? "后端判定：可晋级"
                      : "Backend-qualified: promotable"
                    : language === "zh"
                      ? "仅开发验证 · 不可晋级"
                      : "Development only · cannot promote"}
                </span>
              </header>
              <dl className={styles.sandboxAttemptIdentity}>
                <div>
                  <dt>Package</dt>
                  <dd>{shortArtifactIdentity(attempt.packageVersionId)}</dd>
                </div>
                <div>
                  <dt>Dependency</dt>
                  <dd>{shortArtifactIdentity(attempt.dependencyRoot)}</dd>
                </div>
                <div>
                  <dt>Test Suite</dt>
                  <dd>{shortArtifactIdentity(attempt.testSuiteHash)}</dd>
                </div>
                <div>
                  <dt>Execution</dt>
                  <dd>
                    {attempt.executionOrigin ?? "pending"} ·{" "}
                    {attempt.isolationTier ?? "tier pending"}
                  </dd>
                </div>
              </dl>
              <div className={styles.sandboxReceiptGrid}>
                {attempt.receipts.map((receipt) => (
                  <div key={receipt.id} data-status={receipt.status}>
                    <Icon
                      name={receipt.status === "recorded" ? "check" : "alert"}
                      size={11}
                    />
                    <span>
                      <strong>{receipt.label}</strong>
                      <small>{receipt.detail}</small>
                    </span>
                  </div>
                ))}
              </div>
              {attempt.errorMessage ? (
                <p className={styles.sandboxAttemptError} role="alert">
                  {attempt.errorMessage}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export type ArtifactPatchSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | {
      status: "success";
      receipt: Awaited<ReturnType<SaveWorkspaceArtifactPatch>>;
    }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

export function buildWorkspaceArtifactPatchRequest(input: {
  artifact: SelectedArtifact;
  content: WorkspaceArtifactVersionContent;
  editedContent: string;
}): Parameters<SaveWorkspaceArtifactPatch>[0] {
  const { artifact, content, editedContent } = input;
  const candidate = artifact.candidatePatchContext;
  if (!candidate) {
    throw new Error(
      "The exact Candidate Head does not include this Artifact Version.",
    );
  }
  if (
    !artifact.versionId ||
    !artifact.blobHash ||
    content.artifact.id !== artifact.id ||
    content.version.id !== artifact.versionId ||
    content.version.artifactId !== artifact.id ||
    content.version.blobHash !== artifact.blobHash
  ) {
    throw new Error(
      "The loaded immutable content does not match the selected Candidate Artifact Version.",
    );
  }
  if (editedContent === content.content) {
    throw new Error("The edited content is unchanged.");
  }
  return {
    expectedSessionRevision: candidate.expectedSessionRevision,
    expectedCandidateHeadRevision: candidate.expectedCandidateHeadRevision,
    basePackageVersionId: candidate.basePackageVersionId,
    baseDependencyRoot: candidate.baseDependencyRoot,
    summary: `FDE Workspace edit: ${artifact.title} from ${artifact.version}`,
    patches: [
      {
        artifactId: artifact.id,
        baseArtifactVersionId: content.version.id,
        baseBlobHash: content.version.blobHash,
        content: editedContent,
        contentType: content.version.contentType,
        metadata: {
          source: "ontocode_workspace_editor",
          baseArtifactVersionId: content.version.id,
        },
      },
    ],
  };
}

function isWorkspacePatchConflict(error: unknown): boolean {
  if (error instanceof ApiResponseError) {
    return (
      error.status === 409 || error.code === "ontocode_workspace_cas_conflict"
    );
  }
  return (
    error instanceof Error &&
    /(?:\b409\b|cas[ _-]?conflict|head moved|version changed)/i.test(
      error.message,
    )
  );
}

export function ArtifactInspector({
  artifact,
  content,
  readOnly = false,
  onRetry,
  onSave,
}: {
  artifact: SelectedArtifact | null;
  content: ArtifactContentState;
  readOnly?: boolean;
  onRetry: () => void;
  onSave?: SaveWorkspaceArtifactPatch;
}) {
  const { language, t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<ArtifactPatchSaveState>({
    status: "idle",
  });

  const loadedVersionId = content.status === "ready" ? content.versionId : null;
  useEffect(() => {
    setEditing(false);
    setSaveState({ status: "idle" });
    setDraft(content.status === "ready" ? content.payload.content : "");
  }, [artifact?.id, artifact?.versionId, content, loadedVersionId]);

  if (!artifact) {
    return (
      <footer className={styles.artifactInspectorEmpty}>
        <Icon name="library" size={15} />
        <span>{t("ontocode.workspace.inspector.select")}</span>
      </footer>
    );
  }
  return (
    <footer className={styles.artifactInspector}>
      <div className={styles.inspectorTitle}>
        <strong>{artifact.title}</strong>
        <span>{artifact.version}</span>
        {artifact.blockedBy ? (
          <em>{t("ontocode.workspace.inspector.blocked")}</em>
        ) : (
          <small>Ready</small>
        )}
      </div>
      <dl>
        <div>
          <dt>{t("ontocode.workspace.inspector.source")}</dt>
          <dd>{artifact.source}</dd>
        </div>
        <div>
          <dt>{t("ontocode.workspace.inspector.contract")}</dt>
          <dd>{artifact.contract}</dd>
        </div>
        <div>
          <dt>{t("ontocode.workspace.inspector.tests")}</dt>
          <dd>{artifact.tests}</dd>
        </div>
        {artifact.blockedBy ? (
          <div>
            <dt>{t("ontocode.workspace.inspector.conversation")}</dt>
            <dd>{artifact.blockedBy}</dd>
          </div>
        ) : null}
      </dl>
      <section
        className={styles.artifactVersionViewer}
        aria-label={`${artifact.title} immutable version content`}
        aria-live="polite"
      >
        <header>
          <div>
            <Icon name="code" size={13} />
            <span>
              <strong>
                {editing
                  ? language === "zh"
                    ? "基于不可变版本创建补丁"
                    : "Create patch from immutable version"
                  : "Immutable version content"}
              </strong>
              <small>
                {editing
                  ? language === "zh"
                    ? "保存会创建新版本并以 CAS 移动 Candidate Head"
                    : "Save creates a new version and moves Candidate Head with CAS"
                  : t("ontocode.workspace.inspector.readOnly")}
              </small>
            </span>
          </div>
          <div className={styles.artifactVersionHeaderActions}>
            <div className={styles.artifactVersionMeta}>
              <span>{artifact.contentType ?? "Content type pending"}</span>
              {artifact.sizeBytes !== undefined ? (
                <span>{formatArtifactBytes(artifact.sizeBytes)}</span>
              ) : null}
            </div>
            {content.status === "ready" && !editing ? (
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={
                  readOnly ||
                  !onSave ||
                  !artifact.candidatePatchContext ||
                  saveState.status === "saving"
                }
                title={
                  readOnly
                    ? language === "zh"
                      ? "当前 Session 为只读"
                      : "This Session is read-only"
                    : artifact.editBlockedReason
                }
                onClick={() => {
                  setDraft(content.payload.content);
                  setSaveState({ status: "idle" });
                  setEditing(true);
                }}
              >
                <Icon name="code" size={12} />
                {language === "zh"
                  ? "编辑并创建新版本"
                  : "Edit into new version"}
              </button>
            ) : null}
          </div>
        </header>
        {content.status === "loading" ? (
          <div className={styles.artifactContentStatus} data-tone="loading">
            <Icon name="replay" size={14} />
            {t("ontocode.workspace.inspector.loading", {
              version: artifact.version,
            })}
          </div>
        ) : content.status === "error" ? (
          <div className={styles.artifactContentStatus} data-tone="error">
            <Icon name="alert" size={14} />
            <span>
              <strong>{t("ontocode.workspace.inspector.loadFailed")}</strong>
              <small>{content.message}</small>
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onRetry}
            >
              <Icon name="replay" size={12} />
              {t("ontocode.workspace.inspector.retry")}
            </button>
          </div>
        ) : content.status === "ready" && editing ? (
          <div className={styles.artifactPatchEditor}>
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (
                  saveState.status === "conflict" ||
                  saveState.status === "error" ||
                  saveState.status === "success"
                ) {
                  setSaveState({ status: "idle" });
                }
              }}
              spellCheck={false}
              aria-label={`${artifact.title} full-content patch`}
              disabled={saveState.status === "saving"}
            />
            <footer>
              <span>
                {language === "zh"
                  ? "将使用当前 Session、Candidate Head、Package 与 Artifact Version 的精确版本条件提交。"
                  : "The commit is guarded by exact Session, Candidate Head, Package, and Artifact Version identities."}
              </span>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={saveState.status === "saving"}
                onClick={() => {
                  setDraft(content.payload.content);
                  setSaveState({ status: "idle" });
                  setEditing(false);
                }}
              >
                {language === "zh" ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={
                  !onSave ||
                  saveState.status === "saving" ||
                  draft === content.payload.content
                }
                onClick={() => {
                  if (!onSave) return;
                  let request: Parameters<SaveWorkspaceArtifactPatch>[0];
                  try {
                    request = buildWorkspaceArtifactPatchRequest({
                      artifact,
                      content: content.payload,
                      editedContent: draft,
                    });
                  } catch (error) {
                    setSaveState({
                      status: "error",
                      message:
                        error instanceof Error
                          ? error.message
                          : "Unable to construct the exact patch request.",
                    });
                    return;
                  }
                  setSaveState({ status: "saving" });
                  void onSave(request)
                    .then((receipt) => {
                      setSaveState({ status: "success", receipt });
                      setEditing(false);
                    })
                    .catch((error: unknown) => {
                      const message =
                        error instanceof ApiResponseError
                          ? (error.serverText ?? error.message)
                          : error instanceof Error
                            ? error.message
                            : "Workspace patch failed.";
                      setSaveState({
                        status: isWorkspacePatchConflict(error)
                          ? "conflict"
                          : "error",
                        message,
                      });
                    });
                }}
              >
                <Icon
                  name={saveState.status === "saving" ? "replay" : "check"}
                  size={12}
                />
                {saveState.status === "saving"
                  ? language === "zh"
                    ? "CAS 保存中"
                    : "Saving with CAS"
                  : language === "zh"
                    ? "保存为新 Candidate"
                    : "Save as new Candidate"}
              </button>
            </footer>
          </div>
        ) : content.status === "ready" ? (
          <>
            <div className={styles.artifactContentIdentity}>
              <span>Content-Type</span>
              <code>{content.payload.version.contentType}</code>
              <span>SHA-256</span>
              <code>{content.payload.version.blobHash}</code>
            </div>
            <pre
              className={styles.artifactContentCode}
              tabIndex={0}
              aria-label={`${artifact.title} read-only source`}
            >
              <code>{content.payload.content}</code>
            </pre>
            {!artifact.candidatePatchContext ? (
              <div className={styles.artifactEditGuard} role="note">
                <Icon name="alert" size={12} />
                <span>
                  {artifact.editBlockedReason ??
                    (language === "zh"
                      ? "只有精确 Candidate Head 中的版本可以创建 Workspace 补丁。"
                      : "Only a version in the exact Candidate Head can create a Workspace patch.")}
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <div className={styles.artifactContentStatus}>
            <Icon name="library" size={14} />
            {artifact.versionId
              ? t("ontocode.workspace.inspector.readerUnavailable")
              : t("ontocode.workspace.inspector.noVersion")}
          </div>
        )}
        {saveState.status === "saving" ? (
          <div className={styles.artifactPatchStatus} data-status="saving">
            <Icon name="replay" size={13} />
            {language === "zh"
              ? "正在校验 CAS 条件并原子创建 Change Set、新 Artifact Version 与 Candidate Head…"
              : "Validating CAS conditions and atomically creating the Change Set, Artifact Version, and Candidate Head…"}
          </div>
        ) : saveState.status === "conflict" ? (
          <div
            className={styles.artifactPatchStatus}
            data-status="conflict"
            role="alert"
          >
            <Icon name="alert" size={13} />
            <span>
              <strong>
                {language === "zh"
                  ? "Candidate 已变化，未保存任何内容"
                  : "Candidate changed; nothing was saved"}
              </strong>
              <small>{saveState.message}</small>
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                setEditing(false);
                setSaveState({ status: "idle" });
                onRetry();
              }}
            >
              {language === "zh" ? "重新加载精确版本" : "Reload exact version"}
            </button>
          </div>
        ) : saveState.status === "error" ? (
          <div
            className={styles.artifactPatchStatus}
            data-status="error"
            role="alert"
          >
            <Icon name="alert" size={13} />
            <span>
              <strong>
                {language === "zh" ? "补丁未提交" : "Patch not committed"}
              </strong>
              <small>{saveState.message}</small>
            </span>
          </div>
        ) : saveState.status === "success" ? (
          <div
            className={styles.artifactPatchStatus}
            data-status="success"
            role="status"
          >
            <Icon name="check" size={13} />
            <span>
              <strong>
                {language === "zh"
                  ? "已原子创建新 Candidate"
                  : "New Candidate committed atomically"}
              </strong>
              <small>
                {`Head r${saveState.receipt.head.revision} · ${saveState.receipt.packageVersion.id} · Change Set ${saveState.receipt.changeSet.id}`}
              </small>
            </span>
          </div>
        ) : null}
      </section>
    </footer>
  );
}

function formatArtifactBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) {
    return `${Math.max(1, Math.round(value / 1_024))} KB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function ProjectionEmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: IconName;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div className={styles.projectionEmptyState}>
      <span className={styles.iconWell}>
        <Icon name={icon} size={17} />
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action ? (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          <Icon name="play" size={13} />
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function HarnessTray({
  steps,
  expanded,
  activityLabel,
  activityDetail,
  onToggle,
  onEvidence,
}: {
  steps: HarnessStep[];
  expanded: boolean;
  activityLabel: string;
  activityDetail: string;
  onToggle: () => void;
  onEvidence: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className={styles.harnessTray} data-expanded={expanded}>
      <header>
        <button
          type="button"
          className={styles.harnessTitle}
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <strong>{t("ontocode.workspace.harnessTitle")}</strong>
          <span className={styles.harnessRunning}>
            <Icon name="replay" size={12} />
            {activityLabel} · {steps.length} jobs · {activityDetail}
          </span>
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={13} />
        </button>
        <div className={styles.harnessActions}>
          <button type="button" onClick={onEvidence}>
            <Icon name="library" size={13} />
            {t("ontocode.workspace.openEvidence")}
          </button>
          <button type="button" onClick={onToggle}>
            <Icon name="external" size={13} />
            {expanded
              ? t("ontocode.workspace.collapse")
              : t("ontocode.workspace.expand")}
          </button>
        </div>
      </header>
      {expanded ? (
        steps.length > 0 ? (
          <div className={styles.harnessSteps}>
            {steps.map((step, index) => (
              <div className={styles.harnessStepWrap} key={step.id}>
                <article
                  className={styles.harnessStep}
                  data-status={step.status}
                >
                  <header>
                    <span>{step.order}</span>
                    <strong>{step.title}</strong>
                    <Icon
                      name={
                        step.status === "complete"
                          ? "check"
                          : step.status === "blocked"
                            ? "alert"
                            : step.status === "running"
                              ? "replay"
                              : "dot"
                      }
                      size={13}
                    />
                  </header>
                  <time>{step.time}</time>
                  <small>
                    {harnessStatusLabel(step.status)} · {step.detail}
                  </small>
                </article>
                {index < steps.length - 1 ? (
                  <Icon name="chevron-right" size={16} color="var(--text-3)" />
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.harnessEmpty}>
            <Icon name="replay" size={14} />
            {t("ontocode.workspace.noHarnessJobs")}
          </div>
        )
      ) : null}
    </aside>
  );
}
