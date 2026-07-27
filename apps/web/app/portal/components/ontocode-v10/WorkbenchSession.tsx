"use client";
// OntoCode v10 · 会话页容器：把真实 /v1/ontocode 数据绑定到三栏工作台。
// 本文件是唯一发请求的地方；展示组件保持纯净。零 mock：所有内容来自服务端记录。
import React, { useEffect, useMemo, useState } from "react";
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
  useOntoCodeSuiteOverview,
  useConfirmOntoCodeHumanBoundary,
  useDeleteOntoCodeSession,
  useSystemCoverage,
  useProbeSystemConnection,
  useMarkSystemsHumanBoundary,
  useSystemConnections,
  useSendOntoCodeAssistantTurn,
  useSendOntoCodeTurn,
  useUpdateOntoCodeSession,
  useVerifyOntoCodeConfigurationTask,
} from "@/lib/hooks/useOntoCodeWorkspace";
import {
  ArtifactInspectorConnected,
  INSPECTOR_TABS,
  type InspectorTab,
} from "./ArtifactInspector";
import { ReasoningFlowView, SessionLogView } from "./SessionLog";
import { SystemConnectionsView } from "./SystemConnections";
import { useOntoCodeSessionStream } from "@/lib/hooks/useOntoCodeSessionStream";
import styles from "./workbench.module.css";
import {
  isRegistrationRetiredMessage,
  projectFlow,
  projectSessionRow,
  REGISTRATION_RETIRED_ZH,
  resumeActionForJobKind,
  type ActionCardVM,
  type FlowItemVM,
} from "./projection";
import { CreateSessionPanel } from "./CreateSessionPanel";
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
  const suiteQ = useOntoCodeSuiteOverview(tenant, sessionId);
  useOntoCodeSessionStream(tenant, sessionId);

  const sendTurn = useSendOntoCodeAssistantTurn(tenant, sessionId);
  const sendRawTurn = useSendOntoCodeTurn(tenant, sessionId);
  const updateSession = useUpdateOntoCodeSession(tenant, sessionId);
  const decideCommand = useDecideOntoCodeCommand(tenant, sessionId);
  const confirmBoundary = useConfirmOntoCodeHumanBoundary(tenant, sessionId);
  const deleteSession = useDeleteOntoCodeSession(tenant);
  const probeSystem = useProbeSystemConnection(tenant);
  const markBoundary = useMarkSystemsHumanBoundary(tenant);

  const [draft, setDraft] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorFullscreen, setInspectorFullscreen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("artifacts");
  const [busySystem, setBusySystem] = useState<string | null>(null);

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

  // Every system the bound domain references — the blocker card only ever knows
  // about the one that stopped this build.
  const coverageQ = useSystemCoverage(tenant, project?.domain ?? null);

  const runningJob = jobs.find(
    (j) => j.status === "running" || j.status === "leased",
  );
  const waitingJob = jobs.find((j) => j.status === "waiting_user");

  // 等待中的 config 阻塞涉及的系统（来自结构化问题）→ 查连接成熟度，
  // 让「去配置」直接指到具体 provider 的配置表单。
  const waitingSystems = useMemo(() => {
    const out = new Set<string>();
    for (const ev of events) {
      if (!/waiting_user$/.test(ev.type)) continue;
      const q = (ev.payload as { question?: { systems?: unknown } }).question;
      if (q && Array.isArray(q.systems)) {
        for (const s of q.systems) {
          if (typeof s === "string" && s.trim()) out.add(s.trim());
        }
      }
    }
    return [...out];
  }, [events]);
  const connectionsQ = useSystemConnections(
    tenant,
    project?.domain ?? null,
    waitingSystems,
  );

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
                overview: suiteQ.data?.overview
                  ? {
                      agents: suiteQ.data.overview.agents.length,
                      ready: suiteQ.data.overview.readiness.ready,
                      blocked: suiteQ.data.overview.readiness.pendingConfig,
                    }
                  : undefined,
              }
            : {},
        ),
      );
  }, [sessions, sessionId, runningJob?.kind, waitingJob?.errorMessage, configTasks]);

  const activeRow = railRows.find((r) => r.id === sessionId) ?? null;

  const registrationRetired = useMemo(
    () =>
      messages.some(
        (m) =>
          m.role !== "user" &&
          typeof (m.content as { text?: unknown }).text === "string" &&
          isRegistrationRetiredMessage(
            (m.content as { text: string }).text,
          ),
      ),
    [messages],
  );

  const flowItems: FlowItemVM[] = useMemo(() => {
    if (!session) return [];
    const items = projectFlow({
      session,
      messages,
      jobs,
      events,
      configTasks,
      commands,
    });
    if (registrationRetired) {
      items.push({
        kind: "actionCard",
        id: "card-registration-retired",
        card: {
          kind: "system",
          refId: "registration-retired",
          title: "该 Session 已只读——绑定的 Ontology 注册项被停用",
          why: "历史产物与证据保持可查；继续这项工作需要在当前活跃的域下新建 Session。",
          options: [{ label: "用活跃域新建 Session", value: "create" }],
        },
        at: Number.MAX_SAFE_INTEGER - 1,
      });
    }
    return items;
  }, [session, messages, jobs, events, configTasks, commands, registrationRetired]);

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
    session?.activityState === "cancelled" ||
    session?.phase === "completed" ||
    registrationRetired;

  const renderCard = (item: Extract<FlowItemVM, { kind: "actionCard" }>) => {
    const card = item.card;
    // 人工边界可确认的 config 阻塞（来自等待问题、无真实配置任务）：
    // 确认人工边界 → 标记系统 + resume build；已更新请重读 → resume；去配置 → 设置页。
    if (card.kind === "config" && card.boundaryEligible && !card.configTaskId) {
      const waitingJob = card.jobId
        ? jobs.find((j) => j.id === card.jobId && j.status === "waiting_user")
        : undefined;
      const resumeBuild = (answer: string, source: string) => {
        const resumeAction = waitingJob
          ? resumeActionForJobKind(waitingJob.kind)
          : null;
        if (waitingJob && resumeAction) {
          sendRawTurn.mutate({
            text: answer,
            behavior: "execute",
            action: resumeAction as never,
            arguments: {
              clarificationAnswer: answer,
              resumeWaitingUserJobId: waitingJob.id,
              source,
            },
            affectedSemanticPaths: [],
            requestedCapabilities: [],
          });
        } else {
          sendTurn.mutate({ text: answer });
        }
      };
      const systemLinks = (card.systems ?? []).map((system) => {
        const row = connectionsQ.data?.systems.find(
          (r) => r.system === system,
        );
        return {
          system,
          provider: row?.credentialProvider ?? null,
          configured: row?.credentialConfigured ?? false,
          probeOk: row?.probeOk ?? null,
          runtimeProvided: row?.runtimeProvided ?? false,
        };
      });
      return (
        <ActionCardView
          card={card}
          busy={confirmBoundary.isPending || sendRawTurn.isPending}
          errorText={
            confirmBoundary.error instanceof Error
              ? confirmBoundary.error.message
              : sendRawTurn.error instanceof Error
                ? sendRawTurn.error.message
                : null
          }
          systemLinks={systemLinks}
          onConfigureProvider={(provider) =>
            router.push(
              `/portal/${encodeURIComponent(tenant)}/settings?section=integrations&provider=${encodeURIComponent(provider)}`,
            )
          }
          onConfirmBoundary={() =>
            confirmBoundary.mutate({
              waitingJobId: waitingJob?.id ?? card.jobId,
            })
          }
          // 已配置完成，校验并继续：resume build——重跑会现读真实工具/凭证，
          // 若已配好则门自动放行；未配好则如实重新提示。
          onSecondary={() =>
            resumeBuild("已配置真实工具，请重新校验并继续构建。", "credential-configured")
          }
          onAnswer={(answer) => resumeBuild(answer, "ontology-updated")}
          onPrimary={() =>
            router.push(
              `/portal/${encodeURIComponent(tenant)}/settings?section=integrations`,
            )
          }
        />
      );
    }
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
    if (card.kind === "system") {
      return (
        <ActionCardView
          card={card}
          onPrimary={
            card.refId === "registration-retired"
              ? () => setCreateOpen(true)
              : undefined
          }
        />
      );
    }
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

  // 加载失败（含限流）不许成为死端：10 秒后自动重试，直到恢复。
  useEffect(() => {
    if (!sessionQ.isError) return;
    const timer = setTimeout(() => {
      void sessionQ.refetch();
      void messagesQ.refetch();
      void jobsQ.refetch();
    }, 10_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionQ.isError, sessionQ.errorUpdatedAt]);

  return (
    <>
    <CreateSessionPanel
      tenant={tenant}
      open={createOpen}
      onClose={() => setCreateOpen(false)}
      onCreated={(newSessionId) => {
        setCreateOpen(false);
        router.push(
          `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(newSessionId)}`,
        );
      }}
    />
    <WorkbenchShell
      inspectorOpen={inspectorOpen}
      inspectorFullscreen={inspectorFullscreen}
      onToggleInspector={() => {
        setInspectorFullscreen(false);
        setInspectorOpen((v) => !v);
      }}
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
          onCreateSession={() => setCreateOpen(true)}
          deletingSessionId={
            deleteSession.isPending ? deleteSession.variables ?? null : null
          }
          onDeleteSession={(id) => {
            const row = railRows.find((r) => r.id === id);
            if (
              !window.confirm(
                `删除「${row?.title ?? id}」？该 Session 的对话、产物与证据会一并移除，无法恢复。`,
              )
            ) {
              return;
            }
            deleteSession.mutate(id, {
              onSuccess: () => {
                if (id !== sessionId) return;
                const next = railRows.find((r) => r.id !== id);
                router.replace(
                  next
                    ? `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(next.id)}`
                    : `/portal/${encodeURIComponent(tenant)}/ontocode-workspace`,
                );
              },
            });
          }}
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
            <div className={styles.cardHead}>暂时无法加载 Session</div>
            <div className={styles.cardWhy}>{loadError}</div>
            <div className={styles.cardImpact}>10 秒后自动重试；也可以点右侧按钮立即重试。</div>
            <div className={styles.cardBtns}>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  void sessionQ.refetch();
                  void messagesQ.refetch();
                }}
              >
                立即重试
              </button>
            </div>
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
            registrationRetired
              ? REGISTRATION_RETIRED_ZH
              : session?.phase === "completed"
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
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div className={styles.tabs}>
            {INSPECTOR_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={
                  inspectorTab === tab.id
                    ? `${styles.tab} ${styles.tabOn}`
                    : styles.tab
                }
                onClick={() => setInspectorTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {inspectorTab === "connections" ? (
              <SystemConnectionsView
                domainLabel={project?.domain ?? ""}
                rows={coverageQ.data?.systems ?? []}
                totals={coverageQ.data?.totals}
                loading={coverageQ.isLoading}
                errorText={
                  coverageQ.error instanceof Error
                    ? `无法读取系统连接：${coverageQ.error.message}`
                    : null
                }
                busySystem={busySystem}
                onConfigure={(provider) =>
                  router.push(
                    `/portal/${encodeURIComponent(tenant)}/settings?section=integrations&provider=${encodeURIComponent(provider)}`,
                  )
                }
                onProbe={(profileId) => {
                  setBusySystem(profileId);
                  probeSystem.mutate(profileId, {
                    onSettled: () => setBusySystem(null),
                  });
                }}
                onMarkBoundary={(system) => {
                  setBusySystem(system);
                  markBoundary.mutate(
                    { systems: [system] },
                    { onSettled: () => setBusySystem(null) },
                  );
                }}
              />
            ) : inspectorTab === "log" ? (
              <SessionLogView
                messages={messages}
                events={events}
                jobs={jobs}
              />
            ) : inspectorTab === "reasoning" ? (
              <ReasoningFlowView jobs={jobs} events={events} />
            ) : null}
            <div
              style={{
                display: inspectorTab === "artifacts" ? "block" : "none",
                height: "100%",
              }}
            >
              <ArtifactInspectorConnected
          tenant={tenant}
          sessionId={sessionId}
          candidateLabel={
            suiteQ.data?.overview.candidate
              ? `候选 v${suiteQ.data.overview.candidate.revision}`
              : candidateHeadQ.data?.head
                ? `候选 v${(candidateHeadQ.data.head as { revision?: number }).revision ?? 1}`
                : null
          }
          overview={suiteQ.data?.overview ?? null}
          items={artifactsQ.data?.items ?? []}
          evidence={evidenceQ.data?.items ?? []}
          onCollapse={() => {
            setInspectorFullscreen(false);
            setInspectorOpen(false);
          }}
          fullscreen={inspectorFullscreen}
                onToggleFullscreen={() => setInspectorFullscreen((v) => !v)}
              />
            </div>
          </div>
        </div>
      }
    />
    </>
  );
}
