"use client";
// OntoCode v10 · 会话页容器：把真实 /v1/ontocode 数据绑定到三栏工作台。
// 本文件是唯一发请求的地方；展示组件保持纯净。零 mock：所有内容来自服务端记录。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type {
  OntoCodeBuildSession,
  OntoCodeConfigurationTask,
  OntoCodeSessionEvent,
} from "@agentic/contracts";
import {
  ontocodeConfigurationTaskPrimaryHref,
  useDecideOntoCodeCommand,
  useOntoCodeAssistantRuns,
  useOntoCodeArtifacts,
  useOntoCodeCandidateHead,
  useOntoCodeChangeSet,
  useOntoCodeChangeSets,
  useOntoCodeCommands,
  useOntoCodeConfigurationTasks,
  useOntoCodeEvidence,
  useOntoCodeHarnessJobs,
  useOntoCodeMessages,
  useOntoCodeOntologyFreshness,
  useOntoCodeProjects,
  useOntoCodeSession,
  useCancelOntoCodeJob,
  useRetryOntoCodeJob,
  type OntoCodeSessionDeleteReceipt,
  useOntoCodeSessionEvents,
  useOntoCodeSessions,
  useOntoCodeSuiteOverview,
  useConfirmOntoCodeHumanBoundary,
  useCreateOntoCodeConfigurationTask,
  useDeleteOntoCodeSession,
  useSystemCoverage,
  useProbeSystemConnection,
  useMarkSystemsHumanBoundary,
  useSystemConnections,
  useSendOntoCodeAssistantTurn,
  useSendOntoCodeTurn,
  useUpdateOntoCodeSession,
  useVerifyOntoCodeConfigurationTask,
  type OntoCodeArtifactSummaryItem,
} from "@/lib/hooks/useOntoCodeWorkspace";
import { useHealth } from "@/lib/hooks/useHealth";
import {
  ArtifactInspectorConnected,
  buildIsInProgress,
  candidateLabelForBuildState,
  harnessJobIsInProgress,
  INSPECTOR_TABS,
  InspectorChangesView,
  InspectorEvidenceView,
  InspectorTabBar,
  InspectorTestsView,
  isInspectorFullscreenExitKey,
  makeEvidenceArtifactResolver,
  type ArtifactOpenRequest,
  type InspectorTab,
  type StageDocOpenRequest,
} from "./ArtifactInspector";
import { OntologyMapConnected } from "./OntologyMap";
import { ReasoningFlowView, SessionLogView } from "./SessionLog";
import { SystemConnectionsView } from "./SystemConnections";
import { systemConnectionsErrorText } from "./system-connections-error";
import { useOntoCodeSessionStream } from "@/lib/hooks/useOntoCodeSessionStream";
import styles from "./workbench.module.css";
import {
  isRegistrationRetiredMessage,
  projectFlow,
  projectSessionRow,
  RECOMMENDATION_COMMAND_ARGUMENT_KEY,
  REGISTRATION_RETIRED_SHORT_ZH,
  resumeActionForJobKind,
  type ActionCardVM,
  type FlowItemVM,
} from "./projection";
import { prepareToolAuthoringConfigurationTask } from "./tool-authoring-recommendation";
import {
  EMPTY_ANSWER_STREAM,
  answerHandedOff,
  answerStreamReplayEligible,
  dropAnswerStreamJob,
  reduceAnswerStream,
  selectLiveAnswers,
  type AnswerStreamState,
} from "./answer-stream";
import { CreateSessionPanel } from "./CreateSessionPanel";
import { WorkbenchShell } from "./WorkbenchShell";
import { useWorkbenchLayout } from "./use-workbench-layout";
import { SessionRail } from "./SessionRail";
import { ActionCardView } from "./ActionCards";
import { Composer, GuidedFlow } from "./GuidedFlow";
import { useAssistantWait } from "./use-assistant-wait";

const TONE_CHIP_CLASS: Record<string, string> = {
  ok: "",
  warn: "liveChipWarn",
  run: "liveChipRun",
  bad: "liveChipBad",
  idle: "",
};

function latestStageContextRefs(
  items: OntoCodeArtifactSummaryItem[],
): string[] {
  const latest = new Map<
    "analysis" | "scope" | "blueprint",
    OntoCodeArtifactSummaryItem
  >();
  for (const item of items) {
    const match = item.artifact.logicalName.match(
      /(?:^|\/)(ontology_analysis|analysis|scope|blueprint)(?:\/|$)/u,
    );
    if (!match) continue;
    const rawKind = match[1]!;
    const kind =
      rawKind === "ontology_analysis" || rawKind === "analysis"
        ? "analysis"
        : rawKind === "scope"
          ? "scope"
          : "blueprint";
    const previous = latest.get(kind);
    if (
      !previous ||
      item.latestVersion.createdAt > previous.latestVersion.createdAt
    ) {
      latest.set(kind, item);
    }
  }
  // Blueprint is the most specific review context, so it receives the byte
  // budget before the broader Scope / Ontology analysis receipts.
  return (["blueprint", "scope", "analysis"] as const).flatMap((kind) => {
    const item = latest.get(kind);
    return item
      ? [`artifact:${item.artifact.id}@${item.latestVersion.id}`]
      : [];
  });
}

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
            ontocodeConfigurationTaskPrimaryHref(props.tenant, props.task),
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
  const assistantRunsQ = useOntoCodeAssistantRuns(tenant, sessionId);
  const cancelJob = useCancelOntoCodeJob(tenant, sessionId);
  const retryJob = useRetryOntoCodeJob(tenant, sessionId);
  const configTasksQ = useOntoCodeConfigurationTasks(tenant, sessionId);
  const commandsQ = useOntoCodeCommands(tenant, sessionId);
  const candidateHeadQ = useOntoCodeCandidateHead(tenant, sessionId);
  const changeSetsQ = useOntoCodeChangeSets(tenant, sessionId);
  const latestChangeSet =
    [...(changeSetsQ.data?.items ?? [])].sort(
      (a, b) => b.createdAt - a.createdAt,
    )[0] ?? null;
  const changeSetQ = useOntoCodeChangeSet(
    tenant,
    sessionId,
    latestChangeSet?.id ?? "",
  );
  const artifactsQ = useOntoCodeArtifacts(tenant, sessionId);
  const evidenceQ = useOntoCodeEvidence(tenant, sessionId);
  const suiteQ = useOntoCodeSuiteOverview(tenant, sessionId);
  // 「锁定的本体现在还是源提供的那份吗、又是谁提供的」——服务端当场测量，低频复测。
  const ontologyFreshnessQ = useOntoCodeOntologyFreshness(tenant, sessionId);
  const healthQ = useHealth();

  // #ANSWER-STREAM —— 分析回答的实时缓冲。SSE 帧逐条并入纯 reducer；
  // 落库消息一到即整体交接（durable 永远是权威，绝不双份渲染）。
  const [answerStream, setAnswerStream] =
    useState<AnswerStreamState>(EMPTY_ANSWER_STREAM);
  const onStreamEvent = useCallback((event: OntoCodeSessionEvent) => {
    setAnswerStream((state) => reduceAnswerStream(state, event));
  }, []);
  useOntoCodeSessionStream(tenant, sessionId, { onEvent: onStreamEvent });

  const sendTurn = useSendOntoCodeAssistantTurn(tenant, sessionId);
  const sendRawTurn = useSendOntoCodeTurn(tenant, sessionId);
  const updateSession = useUpdateOntoCodeSession(tenant, sessionId);
  const decideCommand = useDecideOntoCodeCommand(tenant, sessionId);
  const confirmBoundary = useConfirmOntoCodeHumanBoundary(tenant, sessionId);
  const createConfigurationTask = useCreateOntoCodeConfigurationTask(
    tenant,
    sessionId,
  );
  const deleteSession = useDeleteOntoCodeSession(tenant);
  const probeSystem = useProbeSystemConnection(tenant);
  const markBoundary = useMarkSystemsHumanBoundary(tenant);

  const [draft, setDraft] = useState("");
  // 左右两栏的宽度与收起状态由这个 hook 独家持有，并按租户持久化。
  const workbench = useWorkbenchLayout(tenant);
  const setInspectorOpen = workbench.setInspectorOpen;
  const [inspectorFullscreen, setInspectorFullscreen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // 删除的结果必须落到界面上：成功要说清删了什么、保留了什么；失败要说话。
  const [deleteReceipt, setDeleteReceipt] =
    useState<OntoCodeSessionDeleteReceipt | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [autonomyError, setAutonomyError] = useState<string | null>(null);
  const [recommendationErrors, setRecommendationErrors] = useState<
    Record<string, string>
  >({});
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("artifacts");
  const [stageDocOpenRequest, setStageDocOpenRequest] =
    useState<StageDocOpenRequest | null>(null);
  const [artifactOpenRequest, setArtifactOpenRequest] =
    useState<ArtifactOpenRequest | null>(null);
  const [busySystem, setBusySystem] = useState<string | null>(null);

  const session: OntoCodeBuildSession | null = sessionQ.data?.session ?? null;
  const messages = messagesQ.data?.items ?? [];
  const jobs = jobsQ.data?.items ?? [];
  const events = eventsQ.data?.items ?? [];
  const configTasks = configTasksQ.data?.items ?? [];
  const assistantRuns = assistantRunsQ.data?.items ?? [];
  /*
   * 对话推理正在飞的那段空窗。中央网关单发、没有 token 流，所以模型思考期间
   * 中栏必然什么都不长——此前那段时间里唯一的信号是发送按钮上的「发送中…」。
   * 这一行说的只有真实经过的时间和真实到达过的最后一条过程记录。
   *
   * 事件是分页取的，助手运行行才是「这一轮结束没有」的权威，所以两者都给。
   */
  const assistantWait = useAssistantWait(events, assistantRuns);

  // 全屏是一扇必须能走回来的门：除了按钮，Esc 也退出。
  useEffect(() => {
    if (!inspectorFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isInspectorFullscreenExitKey(event.key)) {
        setInspectorFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorFullscreen]);

  useEffect(() => {
    setAutonomyError(null);
    setRecommendationErrors({});
    setStageDocOpenRequest(null);
    setArtifactOpenRequest(null);
    // 换 Session：上一个会话的直播缓冲不允许串场。
    setAnswerStream(EMPTY_ANSWER_STREAM);
  }, [sessionId]);

  const jobItems = jobsQ.data?.items;
  const messageItems = messagesQ.data?.items;
  const eventItems = eventsQ.data?.items;

  // 中途打开页面 / SSE 断档时，用 durable 事件回放重建「仍在产出」作业的
  // 直播缓冲；终局作业不回放——它们的答案已由落库消息承载，回放只会复活
  // 僵尸气泡。reducer 按 ordinal/事件 id 去重，重复回放无害。
  useEffect(() => {
    if (!eventItems?.length || !jobItems?.length) return;
    const eligible = new Set(
      jobItems
        .filter((job) => answerStreamReplayEligible(job.status))
        .map((job) => job.id),
    );
    if (eligible.size === 0) return;
    setAnswerStream((state) =>
      eventItems.reduce(
        (acc, event) =>
          event.harnessJobId && eligible.has(event.harnessJobId)
            ? reduceAnswerStream(acc, event)
            : acc,
        state,
      ),
    );
  }, [eventItems, jobItems]);

  // 交接后的内存清理：作业已终局且权威消息在场时丢弃缓冲。渲染侧还有一道
  // 同判据的过滤，所以这里晚一拍也不会双份渲染。
  useEffect(() => {
    setAnswerStream((state) => {
      let next = state;
      for (const streamJob of Object.values(state.jobs)) {
        const job = jobItems?.find(
          (candidate) => candidate.id === streamJob.harnessJobId,
        );
        if (!job || answerStreamReplayEligible(job.status)) continue;
        if (answerHandedOff(streamJob, jobItems ?? [], messageItems ?? [])) {
          next = dropAnswerStreamJob(next, streamJob.harnessJobId);
        }
      }
      return next;
    });
  }, [jobItems, messageItems]);

  // 进入聊天列的直播气泡：durable 答案（或作业终局）一到就整体让位。
  const liveAnswers = useMemo(() => {
    const vms = selectLiveAnswers(answerStream);
    if (vms.length === 0) return vms;
    return vms.filter((vm) => {
      const streamJob = answerStream.jobs[vm.jobId];
      return streamJob
        ? !answerHandedOff(streamJob, jobItems ?? [], messageItems ?? [])
        : false;
    });
  }, [answerStream, jobItems, messageItems]);

  const commands = commandsQ.data?.items ?? [];
  const sessions = sessionsQ.data?.items ?? [];
  const stageContextRefs = useMemo(
    () => latestStageContextRefs(artifactsQ.data?.items ?? []),
    [artifactsQ.data?.items],
  );
  const resolveEvidenceArtifact = useMemo(
    () => makeEvidenceArtifactResolver(artifactsQ.data?.items ?? []),
    [artifactsQ.data?.items],
  );

  const project = useMemo(
    () =>
      (projectsQ.data?.items ?? []).find((p) => p.id === session?.projectId) ??
      null,
    [projectsQ.data, session?.projectId],
  );

  // Every system the bound domain references — the blocker card only ever knows
  // about the one that stopped this build.
  const coverageQ = useSystemCoverage(tenant, project?.domain ?? null);

  const activeJob = jobs.find(harnessJobIsInProgress);
  const buildInProgress = buildIsInProgress(jobs);
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
                runningJobKind: activeJob?.kind,
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
  }, [
    sessions,
    sessionId,
    activeJob?.kind,
    waitingJob?.errorMessage,
    configTasks,
  ]);

  const activeRow = railRows.find((r) => r.id === sessionId) ?? null;

  const registrationRetired = useMemo(
    () =>
      messages.some(
        (m) =>
          m.role !== "user" &&
          typeof (m.content as { text?: unknown }).text === "string" &&
          isRegistrationRetiredMessage((m.content as { text: string }).text),
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
          origin: "workspace_notice",
          refId: "registration-retired",
          title: "会话已只读",
          why: "历史产物与证据保持可查；继续这项工作需要在当前活跃的域下新建会话。",
          options: [{ label: "用活跃域新建会话", value: "create" }],
        },
        at: Number.MAX_SAFE_INTEGER - 1,
      });
    }
    return items;
  }, [
    session,
    messages,
    jobs,
    events,
    configTasks,
    commands,
    registrationRetired,
  ]);

  const candidatePresentation = useMemo(() => {
    const head = candidateHeadQ.data?.head ?? null;
    const packageVersion = candidateHeadQ.data?.packageVersion ?? null;
    const suiteCandidate = suiteQ.data?.overview.candidate ?? null;
    const candidate =
      head && packageVersion
        ? { revision: head.revision, status: packageVersion.status }
        : suiteCandidate
          ? {
              revision: suiteCandidate.revision,
              status: suiteCandidate.status,
            }
          : null;
    if (candidate) {
      return {
        label: candidateLabelForBuildState(
          candidate.status,
          candidate.revision,
        ),
        status: candidate.status,
      };
    }
    const hasGeneratedUnverifiedDraft = (artifactsQ.data?.items ?? []).some(
      (item) => item.artifact.kind === "agent_code_draft",
    );
    return hasGeneratedUnverifiedDraft
      ? {
          label: candidateLabelForBuildState("generated_unverified"),
          status: "generated_unverified" as const,
        }
      : null;
  }, [
    artifactsQ.data?.items,
    candidateHeadQ.data?.head,
    candidateHeadQ.data?.packageVersion,
    suiteQ.data?.overview.candidate,
  ]);

  const goal = session
    ? {
        title: session.goal,
        chips: [
          session.ontologySnapshotHash ? "本体已锁定" : "待锁定",
          candidatePresentation?.label ?? "待生成",
        ],
      }
    : null;

  const readOnly =
    session?.activityState === "cancelled" ||
    session?.phase === "completed" ||
    registrationRetired;

  const renderCard = (item: Extract<FlowItemVM, { kind: "actionCard" }>) => {
    const card = item.card;
    const recommendation = card.recommendation;
    if (recommendation) {
      const action = recommendation.action;
      const recommendationError = recommendationErrors[card.refId] ?? null;
      if (action.type === "configure") {
        if (action.destination === "tool_authoring") {
          const prepared = session
            ? prepareToolAuthoringConfigurationTask({
                session,
                card,
                jobs,
              })
            : {
                ok: false as const,
                code: "invalid_task" as const,
                message: "会话尚未加载完成，当前不会创建工具任务。",
              };
          if (!prepared.ok) {
            return (
              <ActionCardView
                card={{
                  ...card,
                  kind: "decision",
                  options: [],
                  allowOther: true,
                  primaryLabel: undefined,
                }}
                busy={sendTurn.isPending}
                errorText={prepared.message}
                onAnswer={(answer) => {
                  setRecommendationErrors((current) => {
                    const next = { ...current };
                    delete next[card.refId];
                    return next;
                  });
                  sendTurn.mutate({
                    text: answer,
                    contextRefs: stageContextRefs,
                  });
                }}
              />
            );
          }
          return (
            <ActionCardView
              card={card}
              busy={createConfigurationTask.isPending}
              errorText={recommendationError}
              onPrimary={() => {
                setRecommendationErrors((current) => {
                  const next = { ...current };
                  delete next[card.refId];
                  return next;
                });
                createConfigurationTask.mutate(prepared.request, {
                  onSuccess: (receipt) => {
                    router.push(
                      ontocodeConfigurationTaskPrimaryHref(
                        tenant,
                        receipt.task,
                      ),
                    );
                  },
                  onError: (error) => {
                    setRecommendationErrors((current) => ({
                      ...current,
                      [card.refId]:
                        error instanceof Error ? error.message : String(error),
                    }));
                  },
                });
              }}
            />
          );
        }
        // Other configuration destinations remain visible. Re-entering the
        // assistant with the exact validated label is safer than inventing a
        // settings route that has no server-owned Configuration Task.
        return (
          <ActionCardView
            card={card}
            busy={sendTurn.isPending}
            errorText={
              recommendationError ??
              (sendTurn.error instanceof Error ? sendTurn.error.message : null)
            }
            onPrimary={() =>
              sendTurn.mutate({
                text: action.label,
                contextRefs: stageContextRefs,
              })
            }
          />
        );
      }
      if (action.type === "execute") {
        const duplicateBuild =
          action.turnAction === "generate_package" && buildInProgress;
        const resumableJob = jobs.find(
          (job) =>
            job.status === "waiting_user" &&
            resumeActionForJobKind(job.kind) === action.turnAction,
        );
        return (
          <ActionCardView
            card={card}
            busy={sendRawTurn.isPending || duplicateBuild}
            errorText={
              duplicateBuild
                ? "已在执行中"
                : sendRawTurn.error instanceof Error
                  ? sendRawTurn.error.message
                  : null
            }
            onPrimary={() => {
              if (duplicateBuild) return;
              sendRawTurn.mutate({
                text: action.label,
                behavior: "execute",
                action: action.turnAction,
                arguments: {
                  instruction: action.label,
                  source: "ontocode-assistant-recommendation",
                  // 归属凭证：让这张卡日后认得出「我发起的那次执行」。
                  // 服务端把 arguments 原样落库，所以这是浏览器唯一能留下的
                  // 可回读证据；后端给出一等来源字段后应改读那个字段。
                  [RECOMMENDATION_COMMAND_ARGUMENT_KEY]:
                    recommendation.blockerKey,
                  ...(resumableJob
                    ? {
                        clarificationAnswer: action.label,
                        resumeWaitingUserJobId: resumableJob.id,
                      }
                    : {}),
                },
                affectedSemanticPaths: stageContextRefs,
                requestedCapabilities: [],
              });
            }}
          />
        );
      }
      if (action.type === "reply") {
        return (
          <ActionCardView
            card={card}
            busy={sendTurn.isPending}
            errorText={
              sendTurn.error instanceof Error ? sendTurn.error.message : null
            }
            onAnswer={(answer) =>
              sendTurn.mutate({ text: answer, contextRefs: stageContextRefs })
            }
          />
        );
      }
      return (
        <ActionCardView
          card={card}
          onPrimary={() => {
            setInspectorOpen(true);
            setInspectorTab(card.inspectorTarget ?? "artifacts");
          }}
        />
      );
    }
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
          sendTurn.mutate({ text: answer, contextRefs: stageContextRefs });
        }
      };
      const systemLinks = (card.systems ?? []).map((system) => {
        const row = connectionsQ.data?.systems.find((r) => r.system === system);
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
            resumeBuild(
              "已配置真实工具，请重新校验并继续构建。",
              "credential-configured",
            )
          }
          onAnswer={(answer) => resumeBuild(answer, "ontology-updated")}
          onPrimary={() =>
            router.push(
              `/portal/${encodeURIComponent(tenant)}/settings?section=integrations&session=${encodeURIComponent(sessionId)}`,
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
              ? "生产部署执行器尚未接入；当前批准不会伪装成已上线。"
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
              : card.inspectorTarget
                ? () => {
                    setInspectorOpen(true);
                    setInspectorTab(card.inspectorTarget!);
                  }
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
          sendTurn.mutate({ text: answer, contextRefs: stageContextRefs });
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

  // #SESSION-PURGE —— 删除的结果必须落到界面上。一次静默成功和一次静默失败
  // 在界面上长得一模一样，而后者正是「无法真正删除」这个印象的由来。
  const deleteOutcome =
    deleteError || deleteReceipt ? (
      <div
        className={styles.overlayBackdrop}
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          setDeleteError(null);
          setDeleteReceipt(null);
        }}
      >
        <div className={styles.createPanel}>
          <div className={styles.goalLabel}>
            {deleteError ? "删除失败" : "已删除"}
          </div>
          {deleteError ? null : (
            <h2 className={styles.goalTitle}>
              {deleteReceipt?.title ?? "Session"}
            </h2>
          )}
          {deleteError ? (
            <div className={styles.cardError}>{deleteError}</div>
          ) : (
            <>
              <div className={styles.iEmpty} style={{ textAlign: "left" }}>
                {deleteReceipt?.purge
                  ? `数据库记录已随 Session 一并删除；另清除 ${deleteReceipt.purge.removed} 项外部存储（${Math.round((deleteReceipt.purge.bytesRemoved / 1024) * 10) / 10} KB）。`
                  : "数据库记录已随会话一并删除。"}
              </div>
              {deleteReceipt?.purge?.failures.length ? (
                <div className={styles.cardError}>
                  有 {deleteReceipt.purge.failures.length} 项外部存储未能清除，
                  已记为待重试：
                  {deleteReceipt.purge.failures
                    .slice(0, 3)
                    .map((f) => f.error)
                    .join("；")}
                </div>
              ) : null}
              {deleteReceipt?.purge?.retained.length ? (
                <div className={styles.iEmpty} style={{ textAlign: "left" }}>
                  <strong>刻意保留：</strong>
                  {deleteReceipt.purge.retained.map((r) => (
                    <div key={r.what}>
                      · {r.what} —— {r.why}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
          <div className={styles.cardBtns}>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setDeleteError(null);
                setDeleteReceipt(null);
              }}
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <>
      {deleteOutcome}
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
        layout={workbench.layout}
        viewportWidth={workbench.viewportWidth}
        inspectorFullscreen={inspectorFullscreen}
        onToggleRail={workbench.toggleRail}
        onToggleInspector={() => {
          setInspectorFullscreen(false);
          workbench.toggleInspector();
        }}
        onResizeRail={workbench.resizeRail}
        onResizeInspector={workbench.resizeInspector}
        rail={
          <SessionRail
            businessDomainLabel={tenant}
            ontologyDomainLabel={project?.domain ?? "未绑定"}
            snapshotShort={session?.ontologySnapshotHash?.slice(0, 6) ?? null}
            ontologyFreshness={ontologyFreshnessQ.data ?? null}
            sessions={railRows}
            activeSessionId={sessionId}
            onSelectSession={(id) =>
              router.push(
                `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(id)}`,
              )
            }
            onCreateSession={() => setCreateOpen(true)}
            deletingSessionId={
              deleteSession.isPending ? (deleteSession.variables ?? null) : null
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
                onSuccess: (receipt) => {
                  // 删除必须说清自己删了什么、【没】删什么——一次静默成功和一次
                  // 静默失败在界面上长得一模一样，而后者正是「无法真正删除」的
                  // 由来。
                  setDeleteReceipt(receipt);
                  if (id !== sessionId) return;
                  const next = railRows.find((r) => r.id !== id);
                  router.replace(
                    next
                      ? `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(next.id)}`
                      : `/portal/${encodeURIComponent(tenant)}/ontocode-workspace`,
                  );
                },
                onError: (error) => {
                  // 以前这里什么都没有：请求失败时按钮解禁、Session 还在、
                  // 没有任何提示——点了像没反应。
                  setDeleteError(
                    error instanceof Error ? error.message : String(error),
                  );
                },
              });
            }}
            onOpenSettings={() =>
              router.push(
                `/portal/${encodeURIComponent(tenant)}/settings?section=integrations&session=${encodeURIComponent(sessionId)}`,
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
              <div className={styles.cardImpact}>10 秒后重试</div>
              <div className={styles.cardBtns}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    void sessionQ.refetch();
                    void messagesQ.refetch();
                    // 手动刷新时一并重测本体新鲜度（服务端当场回源）。
                    void ontologyFreshnessQ.refetch();
                  }}
                >
                  立即重试
                </button>
              </div>
            </div>
          ) : (
            <GuidedFlow
              goal={goal}
              items={flowItems}
              liveAnswers={liveAnswers}
              waiting={assistantWait}
              renderCard={renderCard}
              onInspectStage={(kind) => {
                setInspectorOpen(true);
                setInspectorTab("artifacts");
                setStageDocOpenRequest((current) => ({
                  requestId: (current?.requestId ?? 0) + 1,
                  kind,
                }));
                // The succeeded job message can be visible a fraction before
                // React Query has refreshed the artifact page. A direct user
                // click is an explicit request, so refresh immediately rather
                // than waiting for the debounced SSE invalidation.
                void artifactsQ.refetch();
              }}
              onOpenCitation={(ref) => {
                // #ASSISTANT-CITE — open the exact artifact the answer named,
                // so a claim can be checked instead of trusted.
                setInspectorOpen(true);
                setInspectorTab("artifacts");
                setArtifactOpenRequest((current) => ({
                  requestId: (current?.requestId ?? 0) + 1,
                  artifactId: ref.artifactId,
                }));
                void artifactsQ.refetch();
              }}
              onRetryJob={(jobId) => retryJob.mutate({ jobId })}
              retryingJobId={
                retryJob.isPending ? (retryJob.variables?.jobId ?? null) : null
              }
              retryErrorJobId={
                retryJob.isError ? (retryJob.variables?.jobId ?? null) : null
              }
              retryError={
                retryJob.error instanceof Error
                  ? retryJob.error.message
                  : retryJob.error
                    ? String(retryJob.error)
                    : null
              }
              {...(activeJob
                ? {
                    onStop: () => cancelJob.mutate({ jobId: activeJob.id }),
                    stopping: cancelJob.isPending,
                  }
                : {})}
            />
          )
        }
        composer={
          <Composer
            value={draft}
            onChange={setDraft}
            sending={sendTurn.isPending || sendRawTurn.isPending}
            disabled={readOnly}
            disabledReason={
              registrationRetired ? REGISTRATION_RETIRED_SHORT_ZH : "只读"
            }
            autonomy={session?.autonomyMode ?? "copilot"}
            autonomyChanging={updateSession.isPending}
            autonomyError={autonomyError}
            onAutonomyChange={(mode) => {
              if (!session) return;
              setAutonomyError(null);
              updateSession.mutate(
                {
                  expectedRevision: session.revision,
                  autonomyMode: mode as OntoCodeBuildSession["autonomyMode"],
                },
                {
                  onError: (error) => {
                    setAutonomyError(
                      error instanceof Error ? error.message : String(error),
                    );
                  },
                },
              );
            }}
            contextTokens={[
              project?.domain ?? tenant,
              ...(session ? [session.title] : []),
            ]}
            quickActions={[
              {
                label: "业务全景",
                run: () =>
                  sendRawTurn.mutate({
                    text: "分析当前本体：读取真实关系图，说明核心实体、事件链与自动化边界。",
                    behavior: "execute",
                    action: "analyze_ontology" as never,
                    arguments: {
                      focus: ["objects", "actions", "events", "rules"],
                      presentation: [
                        "metrics",
                        "relationship",
                        "table",
                        "list",
                      ],
                    },
                    affectedSemanticPaths: [],
                    requestedCapabilities: [],
                  }),
              },
              {
                label: "数据与关系",
                run: () =>
                  sendRawTurn.mutate({
                    text: "分析当前本体的真实实例、核心对象和关系边；优先用指标、关系视图和表格展示，并明确区分真实 0 行与无法读取。",
                    behavior: "execute",
                    action: "analyze_ontology" as never,
                    arguments: {
                      focus: ["instances", "objects", "relationships"],
                      presentation: ["metrics", "relationship", "table"],
                    },
                    affectedSemanticPaths: [],
                    requestedCapabilities: [],
                  }),
              },
              {
                label: "工具与 API",
                run: () =>
                  sendRawTurn.mutate({
                    text: "逐业务动作检查当前本体所需工具与外部 API：哪些已覆盖、待配置、待探针、有歧义或真缺工具；用表格和风险列表展示。",
                    behavior: "execute",
                    action: "analyze_ontology" as never,
                    arguments: {
                      focus: ["tools", "external_systems", "readiness"],
                      presentation: ["table", "list", "metrics"],
                    },
                    affectedSemanticPaths: [],
                    requestedCapabilities: [],
                  }),
              },
              {
                label: "继续下一步",
                run: () =>
                  sendTurn.mutate({
                    text: "继续",
                    contextRefs: stageContextRefs,
                  }),
              },
            ]}
            onSend={() => {
              const text = draft.trim();
              if (!text) return;
              sendTurn.mutate(
                { text, contextRefs: stageContextRefs },
                { onSuccess: () => setDraft("") },
              );
            }}
          />
        }
        inspector={
          <div
            style={{ display: "flex", flexDirection: "column", height: "100%" }}
          >
            <InspectorTabBar
              tabs={INSPECTOR_TABS}
              activeTab={inspectorTab}
              fullscreen={inspectorFullscreen}
              onSelectTab={setInspectorTab}
              onToggleFullscreen={() => setInspectorFullscreen((v) => !v)}
            />
            <div className={styles.iTabBody}>
              {inspectorTab === "map" ? (
                <OntologyMapConnected
                  tenant={tenant}
                  items={artifactsQ.data?.items ?? []}
                  fullscreen={inspectorFullscreen}
                />
              ) : inspectorTab === "changes" ? (
                <InspectorChangesView
                  changeSet={changeSetQ.data?.changeSet ?? latestChangeSet}
                  operations={changeSetQ.data?.operations ?? []}
                  artifactCount={(artifactsQ.data?.items ?? []).length}
                  loading={changeSetsQ.isLoading || changeSetQ.isLoading}
                  errorText={
                    changeSetsQ.error instanceof Error
                      ? `无法读取变更：${changeSetsQ.error.message}`
                      : changeSetQ.error instanceof Error
                        ? `无法读取变更明细：${changeSetQ.error.message}`
                        : null
                  }
                />
              ) : inspectorTab === "tests" ? (
                <InspectorTestsView
                  overview={suiteQ.data?.overview ?? null}
                  jobs={jobs}
                  loading={suiteQ.isLoading}
                  errorText={
                    suiteQ.error instanceof Error
                      ? `无法读取测试结果：${suiteQ.error.message}`
                      : null
                  }
                />
              ) : inspectorTab === "evidence" ? (
                <InspectorEvidenceView
                  evidence={evidenceQ.data?.items ?? []}
                  jobs={jobs}
                  resolveArtifact={resolveEvidenceArtifact}
                  onOpenArtifact={(artifactId) => {
                    setArtifactOpenRequest((current) => ({
                      requestId: (current?.requestId ?? 0) + 1,
                      artifactId,
                    }));
                    setInspectorTab("artifacts");
                  }}
                  loading={evidenceQ.isLoading}
                  errorText={
                    evidenceQ.error instanceof Error
                      ? `无法读取证据：${evidenceQ.error.message}`
                      : null
                  }
                />
              ) : inspectorTab === "connections" ? (
                <SystemConnectionsView
                  domainLabel={project?.domain ?? ""}
                  rows={coverageQ.data?.systems ?? []}
                  totals={coverageQ.data?.totals}
                  loading={coverageQ.isLoading}
                  errorText={systemConnectionsErrorText(coverageQ.error)}
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
                  onOpenFactoryProfiles={() =>
                    router.push(
                      `/portal/${encodeURIComponent(tenant)}/tools?section=integration-profiles`,
                    )
                  }
                />
              ) : inspectorTab === "log" ? (
                <SessionLogView
                  messages={messages}
                  events={events}
                  jobs={jobs}
                  truncated={eventsQ.data?.truncated ?? false}
                />
              ) : inspectorTab === "reasoning" ? (
                <ReasoningFlowView
                  jobs={jobs}
                  events={events}
                  assistantRuns={assistantRuns}
                  llmRuntime={
                    healthQ.data?.llmGateway
                      ? {
                          ok: healthQ.data.llmGateway.ok,
                          reachable: healthQ.data.llmGateway.reachable,
                          provider: healthQ.data.llmGateway.defaultProvider,
                          model: healthQ.data.llmGateway.defaultModel,
                          latencyMs: healthQ.data.llmGateway.latencyMs,
                          mock: healthQ.data.llmGateway.mock,
                          lastCheckedAt: healthQ.data.llmGateway.lastCheckedAt,
                          factoryCentralRouting:
                            healthQ.data.llmGateway.factoryCentralRouting,
                        }
                      : null
                  }
                  truncated={eventsQ.data?.truncated ?? false}
                />
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
                  buildInProgress={buildInProgress}
                  candidateLabel={candidatePresentation?.label ?? null}
                  candidateStatus={candidatePresentation?.status ?? null}
                  overview={suiteQ.data?.overview ?? null}
                  items={artifactsQ.data?.items ?? []}
                  evidence={evidenceQ.data?.items ?? []}
                  openStageDocRequest={stageDocOpenRequest}
                  openArtifactRequest={artifactOpenRequest}
                  onCollapse={() => {
                    setInspectorFullscreen(false);
                    setInspectorOpen(false);
                  }}
                />
              </div>
            </div>
          </div>
        }
      />
    </>
  );
}
