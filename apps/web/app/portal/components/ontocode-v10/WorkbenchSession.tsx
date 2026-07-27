"use client";
// OntoCode v10 · 会话页容器：把真实 /v1/ontocode 数据绑定到三栏工作台。
// 本文件是唯一发请求的地方；展示组件保持纯净。零 mock：所有内容来自服务端记录。
import React, { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type {
  OntoCodeBuildSession,
  OntoCodeConfigurationTask,
} from "@agentic/contracts";
import {
  ontocodeConfigurationTaskSettingsHref,
  useDecideOntoCodeCommand,
  useOntoCodeArtifacts,
  useOntoCodeCandidateHead,
  useOntoCodeCommands,
  useOntoCodeConfigurationTasks,
  useOntoCodeEvidence,
  useOntoCodeHarnessJobs,
  useOntoCodeMessages,
  useOntoCodeProjects,
  useOntoCodeSession,
  useOntoCodeSessionEvents,
  useOntoCodeSessions,
  useSendOntoCodeAssistantTurn,
  useSendOntoCodeTurn,
  useUpdateOntoCodeSession,
  useVerifyOntoCodeConfigurationTask,
} from "@/lib/hooks/useOntoCodeWorkspace";
import { ArtifactInspectorConnected } from "./ArtifactInspector";
import { useOntoCodeSessionStream } from "@/lib/hooks/useOntoCodeSessionStream";
import styles from "./workbench.module.css";
import {
  projectFlow,
  projectSessionRow,
  resumeActionForJobKind,
  type ActionCardVM,
  type FlowItemVM,
} from "./projection";
import { WorkbenchShell } from "./WorkbenchShell";
import { SessionRail } from "./SessionRail";
import { ActionCardView } from "./ActionCards";
import { Composer, GuidedFlow } from "./GuidedFlow";

const TONE_CHIP_CLASS: Record<string, string> = {
  ok: "",
  warn: "liveChipWarn",
  run: "liveChipRun",
  bad: "liveChipBad",
  idle: "",
};

/** config 卡的数据绑定壳：每张卡自持 verify mutation（taskId 是 hook 参数）。 */
function BoundConfigCard(props: {
  tenant: string;
  card: ActionCardVM;
  task: OntoCodeConfigurationTask | undefined;
}) {
  const router = useRouter();
  const taskId = props.card.configTaskId ?? "";
  const verify = useVerifyOntoCodeConfigurationTask(props.tenant, taskId);
  const verifyError =
    verify.error instanceof Error ? verify.error.message : null;
  return (
    <ActionCardView
      card={props.card}
      busy={verify.isPending}
      errorText={verifyError}
      onPrimary={() => {
        if (props.task) {
          router.push(
            ontocodeConfigurationTaskSettingsHref(props.tenant, props.task),
          );
        }
      }}
      onSecondary={() => {
        if (taskId) verify.mutate(undefined);
      }}
    />
  );
}

export function WorkbenchSessionConnected() {
  const params = useParams<{ tenant: string; sessionId: string }>();
  const tenant = params?.tenant ?? "";
  const sessionId = params?.sessionId ?? "";
  const router = useRouter();

  const sessionsQ = useOntoCodeSessions(tenant);
  const sessionQ = useOntoCodeSession(tenant, sessionId);
  const projectsQ = useOntoCodeProjects(tenant);
  const messagesQ = useOntoCodeMessages(tenant, sessionId);
  const jobsQ = useOntoCodeHarnessJobs(tenant, sessionId);
  const eventsQ = useOntoCodeSessionEvents(tenant, sessionId);
  const configTasksQ = useOntoCodeConfigurationTasks(tenant, sessionId);
  const commandsQ = useOntoCodeCommands(tenant, sessionId);
  const candidateHeadQ = useOntoCodeCandidateHead(tenant, sessionId);
  const artifactsQ = useOntoCodeArtifacts(tenant, sessionId);
  const evidenceQ = useOntoCodeEvidence(tenant, sessionId);
  useOntoCodeSessionStream(tenant, sessionId);

  const sendTurn = useSendOntoCodeAssistantTurn(tenant, sessionId);
  const sendRawTurn = useSendOntoCodeTurn(tenant, sessionId);
  const updateSession = useUpdateOntoCodeSession(tenant, sessionId);
  const decideCommand = useDecideOntoCodeCommand(tenant, sessionId);

  const [draft, setDraft] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const session: OntoCodeBuildSession | null =
    sessionQ.data?.session ?? null;
  const messages = messagesQ.data?.items ?? [];
  const jobs = jobsQ.data?.items ?? [];
  const events = eventsQ.data?.items ?? [];
  const configTasks = configTasksQ.data?.items ?? [];
  const commands = commandsQ.data?.items ?? [];
  const sessions = sessionsQ.data?.items ?? [];

  const project = useMemo(
    () =>
      (projectsQ.data?.items ?? []).find((p) => p.id === session?.projectId) ??
      null,
    [projectsQ.data, session?.projectId],
  );

  const runningJob = jobs.find(
    (j) => j.status === "running" || j.status === "leased",
  );
  const waitingJob = jobs.find((j) => j.status === "waiting_user");

  const railRows = useMemo(() => {
    return [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) =>
        projectSessionRow(
          s,
          s.id === sessionId
            ? {
                runningJobKind: runningJob?.kind,
                latestQuestion: waitingJob?.errorMessage ?? undefined,
                openConfigCount: configTasks.filter(
                  (t) =>
                    (t as { status?: string }).status === "open" ||
                    (t as { status?: string }).status === "verifying",
                ).length,
              }
            : {},
        ),
      );
  }, [sessions, sessionId, runningJob?.kind, waitingJob?.errorMessage, configTasks]);

  const activeRow = railRows.find((r) => r.id === sessionId) ?? null;

  const flowItems: FlowItemVM[] = useMemo(() => {
    if (!session) return [];
    return projectFlow({
      session,
      messages,
      jobs,
      events,
      configTasks,
      commands,
    });
  }, [session, messages, jobs, events, configTasks, commands]);

  const goal = session
    ? {
        title: session.goal,
        chips: [
          session.ontologySnapshotHash
            ? `Ontology 已锁定 · 快照 #${session.ontologySnapshotHash.slice(0, 6)}`
            : "Ontology 快照待锁定",
          candidateHeadQ.data?.head
            ? `候选 v${(candidateHeadQ.data.head as { revision?: number }).revision ?? 1}`
            : "候选待生成",
        ],
      }
    : null;

  const readOnly =
    session?.activityState === "cancelled" || session?.phase === "completed";

  const renderCard = (item: Extract<FlowItemVM, { kind: "actionCard" }>) => {
    const card = item.card;
    if (card.kind === "config") {
      const task = configTasks.find(
        (t) => (t as { id?: string }).id === card.configTaskId,
      );
      return <BoundConfigCard tenant={tenant} card={card} task={task} />;
    }
    if (card.kind === "authorization" || card.kind === "deploy_confirm") {
      const isProductionDeploy = card.kind === "deploy_confirm";
      return (
        <ActionCardView
          card={card}
          busy={decideCommand.isPending}
          errorText={
            isProductionDeploy
              ? "生产部署执行器将在 M3 接入；当前批准不会伪装成已上线。"
              : decideCommand.error instanceof Error
                ? decideCommand.error.message
                : null
          }
          onPrimary={() => {
            if (isProductionDeploy || !card.commandId || !session) return;
            decideCommand.mutate({
              commandId: card.commandId,
              decision: "approve",
              request: { expectedSessionRevision: session.revision },
            });
          }}
          onSecondary={() => {
            if (!card.commandId || !session) return;
            decideCommand.mutate({
              commandId: card.commandId,
              decision: "reject",
              request: { expectedSessionRevision: session.revision },
            });
          }}
        />
      );
    }
    // 决策卡：若挂着等待中的作业，用低层 execute turn 确定性续跑
    // （clarificationAnswer + resumeWaitingUserJobId，服务端取消旧作业并入队新作业）；
    // 没有作业上下文时走常规对话。
    const waitingJobForCard = card.jobId
      ? jobs.find((j) => j.id === card.jobId && j.status === "waiting_user")
      : undefined;
    const resumeAction = waitingJobForCard
      ? resumeActionForJobKind(waitingJobForCard.kind)
      : null;
    return (
      <ActionCardView
        card={card}
        busy={sendTurn.isPending || sendRawTurn.isPending}
        errorText={
          sendRawTurn.error instanceof Error ? sendRawTurn.error.message : null
        }
        onAnswer={(answer) => {
          if (waitingJobForCard && resumeAction) {
            sendRawTurn.mutate({
              text: answer,
              behavior: "execute",
              action: resumeAction as never,
              arguments: {
                clarificationAnswer: answer,
                resumeWaitingUserJobId: waitingJobForCard.id,
                source: "decision-card",
              },
              affectedSemanticPaths: [],
              requestedCapabilities: [],
            });
            return;
          }
          sendTurn.mutate({ text: answer });
        }}
      />
    );
  };

  const anyLoading = sessionQ.isLoading || messagesQ.isLoading;
  const loadError =
    sessionQ.error instanceof Error ? sessionQ.error.message : null;

  return (
    <WorkbenchShell
      inspectorOpen={inspectorOpen}
      onToggleInspector={() => setInspectorOpen((v) => !v)}
      rail={
        <SessionRail
          businessDomainLabel={tenant}
          ontologyDomainLabel={project?.domain ?? "未绑定"}
          snapshotShort={session?.ontologySnapshotHash?.slice(0, 6) ?? null}
          sessions={railRows}
          activeSessionId={sessionId}
          onSelectSession={(id) =>
            router.push(
              `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(id)}`,
            )
          }
          onCreateSession={() =>
            router.push(
              `/portal/${encodeURIComponent(tenant)}/ontocode-workspace`,
            )
          }
          onOpenSettings={() =>
            router.push(
              `/portal/${encodeURIComponent(tenant)}/settings?section=integrations`,
            )
          }
        />
      }
      crumb={
        <>
          <span className={styles.crumbSeg}>{tenant}</span>
          <span className={styles.crumbSep}>/</span>
          <span className={styles.crumbHere}>
            {session?.title ?? (anyLoading ? "加载中…" : "Session")}
          </span>
          {activeRow ? (
            <span
              className={(() => {
                const toneClass = TONE_CHIP_CLASS[activeRow.tone];
                return toneClass
                  ? `${styles.liveChip} ${styles[toneClass] ?? ""}`
                  : styles.liveChip;
              })()}
            >
              {activeRow.label}
            </span>
          ) : null}
          <span className={styles.crumbSpacer} />
        </>
      }
      flow={
        loadError ? (
          <div className={styles.card}>
            <div className={styles.cardHead}>无法加载 Session</div>
            <div className={styles.cardWhy}>{loadError}</div>
          </div>
        ) : (
          <GuidedFlow goal={goal} items={flowItems} renderCard={renderCard} />
        )
      }
      composer={
        <Composer
          value={draft}
          onChange={setDraft}
          sending={sendTurn.isPending}
          disabled={readOnly}
          disabledReason={
            session?.phase === "completed"
              ? "该 Session 已完成，只读"
              : "该 Session 已结束，只读"
          }
          autonomy={session?.autonomyMode ?? "copilot"}
          onAutonomyChange={(mode) => {
            if (!session) return;
            updateSession.mutate({
              expectedRevision: session.revision,
              autonomyMode: mode as OntoCodeBuildSession["autonomyMode"],
            });
          }}
          contextTokens={[
            project?.domain ?? tenant,
            ...(session ? [session.title] : []),
          ]}
          onSend={() => {
            const text = draft.trim();
            if (!text) return;
            sendTurn.mutate(
              { text },
              { onSuccess: () => setDraft("") },
            );
          }}
        />
      }
      inspector={
        <ArtifactInspectorConnected
          tenant={tenant}
          sessionId={sessionId}
          candidateLabel={
            candidateHeadQ.data?.head
              ? `候选 v${(candidateHeadQ.data.head as { revision?: number }).revision ?? 1}`
              : null
          }
          items={artifactsQ.data?.items ?? []}
          evidence={evidenceQ.data?.items ?? []}
          onCollapse={() => setInspectorOpen(false)}
        />
      }
    />
  );
}
