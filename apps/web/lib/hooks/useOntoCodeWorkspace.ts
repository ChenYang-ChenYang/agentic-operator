"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  CommitOntoCodeChangeSetRequest,
  CommitOntoCodeWorkspacePatchRequest,
  CloseOntoCodeSessionRequest,
  CreateOntoCodeArtifactRequest,
  CreateOntoCodeArtifactVersionRequest,
  CreateOntoCodeChangeSetRequest,
  CreateOntoCodeCommandRequest,
  CreateOntoCodeConfigurationTaskRequest,
  CreateOntoCodeEvidenceRecordRequest,
  CreateOntoCodeHarnessJobRequest,
  CreateOntoCodeProjectRequest,
  CreateOntoCodeSessionRequest,
  DecideOntoCodeCommandRequest,
  OntoCodeArtifact,
  OntoCodeArtifactVersion,
  OntoCodeAssistantRun,
  OntoCodeBuildSession,
  OntoCodeCandidateHead,
  OntoCodeChangeSet,
  OntoCodeChangeSetOperation,
  OntoCodeCommand,
  OntoCodeEvidenceRecord,
  OntoCodeHarnessJob,
  OntoCodeMessage,
  OntoCodePackageVersion,
  OntoCodeSandboxAttempt,
  OntoCodeWorkspacePatchCommitReceipt,
  OntoCodeProject,
  OntoCodeConfigurationTask,
  OntoCodeConfigurationTaskCreateReceipt,
  OntoCodeConfigurationTaskGetReceipt,
  OntoCodeConfigurationTaskVerifyReceipt,
  OntoCodeTurnReceipt,
  OntoCodeSessionCloseReceipt,
  OntoCodeSessionEvent,
  OntoCodeSuiteOverview,
  PostOntoCodeMessageRequest,
  PostOntoCodeTurnRequest,
  UpdateOntoCodeSessionRequest,
} from "@agentic/contracts";
import { fetchApiData } from "@/lib/api-response";

interface Page<T> {
  items: T[];
  count: number;
  nextOffset: number | null;
}

interface SessionCreateReceipt {
  session: OntoCodeBuildSession;
}

interface SessionGetReceipt {
  session: OntoCodeBuildSession;
}

interface SessionUpdateReceipt extends SessionGetReceipt {
  event: unknown;
}

interface ProjectCreateReceipt {
  project: OntoCodeProject;
  mode: "created" | "attached";
}

interface MessagePostReceipt {
  message: OntoCodeMessage;
  sessionRevision: number;
  mode: "created" | "attached";
}

interface CommandCreateReceipt {
  command: OntoCodeCommand;
  sessionRevision: number;
  mode: "created" | "attached";
}

interface CommandDecisionReceipt {
  command: OntoCodeCommand;
  sessionRevision: number;
  decision: "approve" | "reject";
  mode: "resolved" | "attached";
}

interface HarnessJobCreateReceipt {
  job: OntoCodeHarnessJob;
  sessionRevision: number;
  mode: "created" | "attached";
}

export interface BootstrapOntoCodeSessionInput {
  sessionId: string;
  goal: string;
  scopeMode?: "full_domain" | "scenario" | "selected_actions";
  actionIds?: string[];
}

export interface SendOntoCodeAssistantTurnInput {
  text: string;
  contextRefs?: string[];
}

interface BootstrapOntoCodeSessionReceipt {
  message: OntoCodeMessage;
  command: OntoCodeCommand;
  job: OntoCodeHarnessJob;
  sessionRevision: number;
}

export interface OntoCodeArtifactSummaryItem {
  artifact: OntoCodeArtifact;
  latestVersion: OntoCodeArtifactVersion;
}

interface ChangeSetGetReceipt {
  changeSet: OntoCodeChangeSet;
  operations: OntoCodeChangeSetOperation[];
}

interface ChangeSetCreateReceipt extends ChangeSetGetReceipt {
  sessionRevision: number;
  mode: "created" | "attached";
}

interface ChangeSetCommitReceipt {
  changeSet: OntoCodeChangeSet;
  sessionRevision: number;
  mode: "committed" | "attached";
}

interface ArtifactCreateReceipt {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  sessionRevision: number;
  mode: "created" | "attached";
}

export interface OntoCodeArtifactVersionContentReceipt {
  artifact: OntoCodeArtifact;
  version: OntoCodeArtifactVersion;
  content: string;
}

interface EvidenceCreateReceipt {
  evidence: OntoCodeEvidenceRecord;
  sessionRevision: number;
  mode: "created" | "attached";
}

interface CandidateHeadGetReceipt {
  head: OntoCodeCandidateHead | null;
  packageVersion: OntoCodePackageVersion | null;
}

function safeConfigurationSegment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized ||
    normalized.length > 160 ||
    /[\u0000-\u001f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Provider identity comes only from the tenant-scoped task returned by API. */
export function ontocodeConfigurationTaskProvider(
  task: OntoCodeConfigurationTask,
): string | null {
  switch (task.target.kind) {
    case "integration":
    case "llm_gateway":
    case "environment":
      return safeConfigurationSegment(task.target.provider);
    default:
      return null;
  }
}

export function ontocodeConfigurationTaskSystemName(
  task: OntoCodeConfigurationTask,
): string | null {
  switch (task.target.kind) {
    case "integration":
    case "system_profile":
    case "tool":
      return safeConfigurationSegment(task.target.system);
    default:
      return null;
  }
}

/** Return location is derived from the task, never from an open redirect. */
export function ontocodeConfigurationTaskSessionHref(
  tenant: string,
  task: Pick<OntoCodeConfigurationTask, "id" | "sessionId">,
): string {
  return `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(
    task.sessionId,
  )}?configTask=${encodeURIComponent(task.id)}`;
}

/**
 * Settings receives only the opaque task id. It resolves the provider from
 * the same server-owned task again so query-string tampering cannot select a
 * different credential form.
 */
export function ontocodeConfigurationTaskSettingsHref(
  tenant: string,
  task: Pick<OntoCodeConfigurationTask, "id">,
): string {
  return `/portal/${encodeURIComponent(
    tenant,
  )}/settings?section=integrations&configTask=${encodeURIComponent(task.id)}`;
}

function jsonHeaders(
  tenant: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-agentic-tenant": tenant,
    ...extra,
  };
}

async function callV1<T>(
  tenant: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { headers, ...rest } = init;
  return fetchApiData<T>(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      ...jsonHeaders(tenant),
      ...(headers as Record<string, string> | undefined),
    },
  });
}

function idempotencyKey(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export const ONTOCODE_KEYS = {
  projects: (tenant: string) => ["ontocode", tenant, "projects"] as const,
  sessions: (tenant: string) => ["ontocode", tenant, "sessions"] as const,
  session: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId] as const,
  messages: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "messages"] as const,
  assistantRuns: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "assistant-runs"] as const,
  commands: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "commands"] as const,
  jobs: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "jobs"] as const,
  changeSets: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "changesets"] as const,
  changeSet: (tenant: string, sessionId: string, changeSetId: string) =>
    [
      "ontocode",
      tenant,
      "session",
      sessionId,
      "changeset",
      changeSetId,
    ] as const,
  artifacts: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "artifacts"] as const,
  artifactVersions: (tenant: string, sessionId: string, artifactId: string) =>
    [
      "ontocode",
      tenant,
      "session",
      sessionId,
      "artifact",
      artifactId,
      "versions",
    ] as const,
  artifactVersionContent: (tenant: string, versionId: string) =>
    ["ontocode", tenant, "artifact-version", versionId, "content"] as const,
  evidence: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "evidence"] as const,
  candidateHead: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "candidate-head"] as const,
  sandboxAttempts: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "sandbox-attempts"] as const,
  configurationTask: (tenant: string, taskId: string) =>
    ["ontocode", tenant, "configuration-task", taskId] as const,
  configurationTasks: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "configuration-tasks"] as const,
  events: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "events"] as const,
  suiteOverview: (tenant: string, sessionId: string) =>
    ["ontocode", tenant, "session", sessionId, "suite-overview"] as const,
};

export function useOntoCodeProjects(
  tenant: string,
): UseQueryResult<Page<OntoCodeProject>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.projects(tenant),
    queryFn: () =>
      callV1<Page<OntoCodeProject>>(tenant, "/v1/ontocode/projects?limit=200"),
    enabled: Boolean(tenant),
    staleTime: 5_000,
  });
}

export function useOntoCodeSessions(
  tenant: string,
): UseQueryResult<Page<OntoCodeBuildSession>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.sessions(tenant),
    queryFn: () =>
      callV1<Page<OntoCodeBuildSession>>(
        tenant,
        "/v1/ontocode/sessions?limit=200",
      ),
    enabled: Boolean(tenant),
    staleTime: 2_000,
  });
}

export function useOntoCodeSession(
  tenant: string,
  sessionId: string,
): UseQueryResult<SessionGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
    queryFn: () =>
      callV1<SessionGetReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 1_000,
  });
}

export function useOntoCodeMessages(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeMessage>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.messages(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeMessage>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useConfirmOntoCodeHumanBoundary(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { waitingJobId?: string; note?: string }) =>
      callV1<{
        systems: string[];
        markedProfiles: string[];
        resumed: boolean;
        resumeAction: string | null;
        waitingJobId: string;
      }>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/confirm-human-boundary`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("human-boundary") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.messages(tenant, sessionId),
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.events(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useOntoCodeSuiteOverview(
  tenant: string,
  sessionId: string,
): UseQueryResult<{ overview: OntoCodeSuiteOverview }> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.suiteOverview(tenant, sessionId),
    queryFn: () =>
      callV1<{ overview: OntoCodeSuiteOverview }>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/suite-overview`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 1_000,
  });
}

export function useOntoCodeSessionEvents(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeSessionEvent>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.events(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeSessionEvent>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/events?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeConfigurationTasks(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeConfigurationTask>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.configurationTasks(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeConfigurationTask>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/configuration-tasks?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeAssistantRuns(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeAssistantRun>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeAssistantRun>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/assistant-runs?limit=20`,
      ),
    enabled: Boolean(tenant && sessionId),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (run) => run.status === "accepted" || run.status === "planning",
      )
        ? 1_500
        : false,
    staleTime: 2_500,
  });
}

export function useOntoCodeCandidateHead(
  tenant: string,
  sessionId: string,
): UseQueryResult<CandidateHeadGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.candidateHead(tenant, sessionId),
    queryFn: () =>
      callV1<CandidateHeadGetReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/candidate-head`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 1_000,
  });
}

export function useOntoCodeSandboxAttempts(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeSandboxAttempt>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.sandboxAttempts(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeSandboxAttempt>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/sandbox-attempts?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (attempt) =>
          attempt.status === "queued" || attempt.status === "running",
      )
        ? 2_000
        : false,
    staleTime: 1_000,
  });
}

export function useOntoCodeHarnessJobs(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeHarnessJob>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.jobs(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeHarnessJob>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/harness-jobs?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    refetchInterval: 4_000,
  });
}

export function useOntoCodeCommands(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeCommand>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeCommand>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/commands?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeChangeSets(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeChangeSet>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.changeSets(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeChangeSet>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/changesets?limit=100`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeChangeSet(
  tenant: string,
  sessionId: string,
  changeSetId: string,
): UseQueryResult<ChangeSetGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.changeSet(tenant, sessionId, changeSetId),
    queryFn: () =>
      callV1<ChangeSetGetReceipt>(
        tenant,
        `/v1/ontocode/changesets/${encodeURIComponent(changeSetId)}`,
      ),
    enabled: Boolean(tenant && sessionId && changeSetId),
    staleTime: 2_500,
  });
}

export function useOntoCodeArtifacts(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeArtifactSummaryItem>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.artifacts(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeArtifactSummaryItem>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/artifacts?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeArtifactVersions(
  tenant: string,
  sessionId: string,
  artifactId: string,
): UseQueryResult<Page<OntoCodeArtifactVersion>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.artifactVersions(tenant, sessionId, artifactId),
    queryFn: () =>
      callV1<Page<OntoCodeArtifactVersion>>(
        tenant,
        `/v1/ontocode/artifacts/${encodeURIComponent(artifactId)}/versions?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId && artifactId),
    staleTime: 1_000,
  });
}

export function fetchOntoCodeArtifactVersionContent(
  tenant: string,
  versionId: string,
): Promise<OntoCodeArtifactVersionContentReceipt> {
  return callV1<OntoCodeArtifactVersionContentReceipt>(
    tenant,
    `/v1/ontocode/artifact-versions/${encodeURIComponent(versionId)}`,
  );
}

/**
 * Loads immutable version content on demand. A content-addressed version
 * cannot change, so React Query can safely retain the successful response.
 */
export function useLoadOntoCodeArtifactVersionContent(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      client.fetchQuery({
        queryKey: ONTOCODE_KEYS.artifactVersionContent(tenant, versionId),
        queryFn: () => fetchOntoCodeArtifactVersionContent(tenant, versionId),
        staleTime: Number.POSITIVE_INFINITY,
      }),
  });
}

export function useOntoCodeEvidence(
  tenant: string,
  sessionId: string,
): UseQueryResult<Page<OntoCodeEvidenceRecord>> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.evidence(tenant, sessionId),
    queryFn: () =>
      callV1<Page<OntoCodeEvidenceRecord>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/evidence?limit=200`,
      ),
    enabled: Boolean(tenant && sessionId),
    staleTime: 2_500,
  });
}

export function useOntoCodeConfigurationTask(
  tenant: string,
  taskId: string,
): UseQueryResult<OntoCodeConfigurationTaskGetReceipt> {
  return useQuery({
    queryKey: ONTOCODE_KEYS.configurationTask(tenant, taskId),
    queryFn: () =>
      callV1<OntoCodeConfigurationTaskGetReceipt>(
        tenant,
        `/v1/ontocode/configuration-tasks/${encodeURIComponent(taskId)}`,
      ),
    enabled: Boolean(tenant && taskId),
    staleTime: 1_000,
  });
}

export function useCreateOntoCodeConfigurationTask(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeConfigurationTaskRequest) =>
      callV1<OntoCodeConfigurationTaskCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/configuration-tasks`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey("configuration-create"),
          },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (receipt) => {
      void client.setQueryData(
        ONTOCODE_KEYS.configurationTask(tenant, receipt.task.id),
        {
          task: receipt.task,
        } satisfies OntoCodeConfigurationTaskGetReceipt,
      );
      for (const queryKey of [
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
        ONTOCODE_KEYS.messages(tenant, sessionId),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useVerifyOntoCodeConfigurationTask(
  tenant: string,
  taskId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (expectedRevision?: number) => {
      const latest = await callV1<OntoCodeConfigurationTaskGetReceipt>(
        tenant,
        `/v1/ontocode/configuration-tasks/${encodeURIComponent(taskId)}`,
      );
      return callV1<OntoCodeConfigurationTaskVerifyReceipt>(
        tenant,
        `/v1/ontocode/configuration-tasks/${encodeURIComponent(taskId)}/verify`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey("configuration-verify"),
          },
          body: JSON.stringify({
            expectedRevision: expectedRevision ?? latest.task.revision,
          }),
        },
      );
    },
    onSuccess: (receipt) => {
      void client.setQueryData(
        ONTOCODE_KEYS.configurationTask(tenant, taskId),
        {
          task: receipt.task,
        } satisfies OntoCodeConfigurationTaskGetReceipt,
      );
      for (const queryKey of [
        ONTOCODE_KEYS.session(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.sessions(tenant),
        ONTOCODE_KEYS.messages(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.commands(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.jobs(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.artifacts(tenant, receipt.task.sessionId),
        ONTOCODE_KEYS.evidence(tenant, receipt.task.sessionId),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useCreateOntoCodeProject(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeProjectRequest) =>
      callV1<ProjectCreateReceipt>(tenant, "/v1/ontocode/projects", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ONTOCODE_KEYS.projects(tenant) }),
  });
}

export function useCreateOntoCodeSession(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeSessionRequest) =>
      callV1<SessionCreateReceipt>(tenant, "/v1/ontocode/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ONTOCODE_KEYS.sessions(tenant) }),
  });
}

/**
 * Starts the first real Ontology-scope job for a newly-created Session.
 * Keeping the three writes in one mutation makes the UI honest: a Session is
 * not presented as "running" until its user goal, auditable Command, and
 * durable Harness Job all exist.
 */
export function useBootstrapOntoCodeSession(tenant: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: BootstrapOntoCodeSessionInput,
    ): Promise<BootstrapOntoCodeSessionReceipt> => {
      const messageKey = `session-goal-${input.sessionId}`;
      const commandKey = `initial-scope-command-${input.sessionId}`;
      const jobKey = `initial-scope-job-${input.sessionId}`;
      const messageReceipt = await callV1<MessagePostReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": messageKey,
          },
          body: JSON.stringify({ text: input.goal }),
        },
      );
      const existingCommands = await callV1<Page<OntoCodeCommand>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/commands?limit=200`,
      );
      const attachedCommand = existingCommands.items.find(
        (command) => command.idempotencyKey === commandKey,
      );
      const commandReceipt = attachedCommand
        ? {
            command: attachedCommand,
            sessionRevision: (
              await callV1<SessionGetReceipt>(
                tenant,
                `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}`,
              )
            ).session.revision,
            mode: "attached" as const,
          }
        : await callV1<CommandCreateReceipt>(
            tenant,
            `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/commands`,
            {
              method: "POST",
              headers: {
                "Idempotency-Key": commandKey,
              },
              body: JSON.stringify({
                type: "analyze_scope",
                arguments: {
                  messageId: messageReceipt.message.id,
                  scenario: input.goal,
                  scopeMode: input.scopeMode ?? "scenario",
                  actionIds: input.actionIds ?? [],
                  source: "ontocode-session-create",
                },
                expectedSessionRevision: messageReceipt.sessionRevision,
                affectedSemanticPaths: (input.actionIds ?? []).map(
                  (actionId) => `actions.${actionId}`,
                ),
                riskClass: "read_only",
                requestedCapabilities: [],
                requiresHuman: false,
                rationaleSummary:
                  "读取租户已绑定的权威 Ontology，固定本 Session 的生成范围与不可变基线。",
              }),
            },
          );
      const existingJobs = await callV1<Page<OntoCodeHarnessJob>>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/harness-jobs?limit=100`,
      );
      const attachedJob = existingJobs.items.find(
        (job) => job.idempotencyKey === jobKey,
      );
      const jobReceipt = attachedJob
        ? {
            job: attachedJob,
            sessionRevision: commandReceipt.sessionRevision,
            mode: "attached" as const,
          }
        : await callV1<HarnessJobCreateReceipt>(
            tenant,
            `/v1/ontocode/sessions/${encodeURIComponent(input.sessionId)}/harness-jobs`,
            {
              method: "POST",
              headers: {
                "Idempotency-Key": jobKey,
              },
              body: JSON.stringify({
                commandId: commandReceipt.command.id,
                kind: "scope",
                expectedSessionRevision: commandReceipt.sessionRevision,
                budget: {
                  maxWallClockMs: 300_000,
                  maxModelCalls: 8,
                  maxToolCalls: 16,
                },
              }),
            },
          );
      return {
        message: messageReceipt.message,
        command: commandReceipt.command,
        job: jobReceipt.job,
        sessionRevision: jobReceipt.sessionRevision,
      };
    },
    onSuccess: (_receipt, input) => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, input.sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.messages(tenant, input.sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.commands(tenant, input.sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.jobs(tenant, input.sessionId),
      });
    },
  });
}

export function useUpdateOntoCodeSession(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOntoCodeSessionRequest) =>
      callV1<SessionUpdateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

export function useCloseOntoCodeSession(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CloseOntoCodeSessionRequest) =>
      callV1<OntoCodeSessionCloseReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/close`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("session-close") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

export function usePostOntoCodeMessage(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PostOntoCodeMessageRequest) =>
      callV1<MessagePostReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("message") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.messages(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

/**
 * Sends one durable conversational turn. The API owns command policy, risk,
 * approval, budget, and Message/Command/Job atomicity; the browser only
 * provides a conservative intent classification and renders the receipt.
 */
export function useSendOntoCodeTurn(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PostOntoCodeTurnRequest) =>
      callV1<OntoCodeTurnReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("turn") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.messages(tenant, sessionId),
        ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
        ONTOCODE_KEYS.commands(tenant, sessionId),
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.candidateHead(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * Canonical free-form chat entry. The browser sends only the user's text and
 * visible context refs; the server-side assistant plans the turn and the
 * existing policy atomically commits its Message/Command/Harness effects.
 */
export function useSendOntoCodeAssistantTurn(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SendOntoCodeAssistantTurnInput) =>
      callV1<OntoCodeTurnReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/assistant-turns`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey("assistant-turn"),
          },
          body: JSON.stringify({
            text: input.text,
            contextRefs: input.contextRefs ?? [],
          }),
        },
      ),
    onSuccess: () => {
      for (const queryKey of [
        ONTOCODE_KEYS.messages(tenant, sessionId),
        ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
        ONTOCODE_KEYS.commands(tenant, sessionId),
        ONTOCODE_KEYS.jobs(tenant, sessionId),
        ONTOCODE_KEYS.candidateHead(tenant, sessionId),
        ONTOCODE_KEYS.session(tenant, sessionId),
        ONTOCODE_KEYS.sessions(tenant),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useCreateOntoCodeCommand(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeCommandRequest) =>
      callV1<CommandCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/commands`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("command") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
    },
  });
}

export function useDecideOntoCodeCommand(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      commandId: string;
      decision: "approve" | "reject";
      request: DecideOntoCodeCommandRequest;
    }) =>
      callV1<CommandDecisionReceipt>(
        tenant,
        `/v1/ontocode/commands/${encodeURIComponent(input.commandId)}/${input.decision}`,
        {
          method: "POST",
          body: JSON.stringify(input.request),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.sessions(tenant),
      });
    },
  });
}

export function useCreateOntoCodeHarnessJob(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeHarnessJobRequest) =>
      callV1<HarnessJobCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/harness-jobs`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("job") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.jobs(tenant, sessionId),
      });
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
      });
    },
  });
}

function invalidateOntoCodeWorkspaceProjection(
  client: ReturnType<typeof useQueryClient>,
  tenant: string,
  sessionId: string,
): void {
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.session(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.sessions(tenant),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.changeSets(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.artifacts(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.evidence(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.candidateHead(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.sandboxAttempts(tenant, sessionId),
  });
}

/**
 * Applies full-content edits against the exact Candidate Head in one server
 * transaction. The API revalidates Session revision, Head revision, Package
 * dependency root, Artifact Version id, and blob hash before writing anything.
 */
export function useCommitOntoCodeWorkspacePatch(
  tenant: string,
  sessionId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CommitOntoCodeWorkspacePatchRequest) =>
      callV1<OntoCodeWorkspacePatchCommitReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/workspace-patches`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key":
              input.idempotencyKey ?? idempotencyKey("workspace-patch"),
          },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (receipt) => {
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId);
      void client.setQueryData(
        ONTOCODE_KEYS.candidateHead(tenant, sessionId),
        {
          head: receipt.head,
          packageVersion: receipt.packageVersion,
        } satisfies CandidateHeadGetReceipt,
      );
      for (const version of receipt.versions) {
        void client.invalidateQueries({
          queryKey: ONTOCODE_KEYS.artifactVersions(
            tenant,
            sessionId,
            version.artifactId,
          ),
        });
      }
    },
  });
}

export function useCreateOntoCodeChangeSet(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeChangeSetRequest) =>
      callV1<ChangeSetCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/changesets`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("changeset") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () =>
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId),
  });
}

export function useCommitOntoCodeChangeSet(
  tenant: string,
  sessionId: string,
  changeSetId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CommitOntoCodeChangeSetRequest) =>
      callV1<ChangeSetCommitReceipt>(
        tenant,
        `/v1/ontocode/changesets/${encodeURIComponent(changeSetId)}/commit`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId);
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.changeSet(tenant, sessionId, changeSetId),
      });
    },
  });
}

export function useCreateOntoCodeArtifact(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeArtifactRequest) =>
      callV1<ArtifactCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/artifacts`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("artifact") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () =>
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId),
  });
}

export function useCreateOntoCodeArtifactVersion(
  tenant: string,
  sessionId: string,
  artifactId: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeArtifactVersionRequest) =>
      callV1<ArtifactCreateReceipt>(
        tenant,
        `/v1/ontocode/artifacts/${encodeURIComponent(artifactId)}/versions`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("artifact-version") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId);
      void client.invalidateQueries({
        queryKey: ONTOCODE_KEYS.artifactVersions(tenant, sessionId, artifactId),
      });
    },
  });
}

export function useCreateOntoCodeEvidence(tenant: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOntoCodeEvidenceRecordRequest) =>
      callV1<EvidenceCreateReceipt>(
        tenant,
        `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/evidence`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey("evidence") },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () =>
      invalidateOntoCodeWorkspaceProjection(client, tenant, sessionId),
  });
}
