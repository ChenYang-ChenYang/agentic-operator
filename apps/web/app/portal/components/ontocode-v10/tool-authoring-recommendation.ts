import {
  CreateOntoCodeConfigurationTaskRequestSchema,
  type CreateOntoCodeConfigurationTaskRequest,
  type OntoCodeBuildSession,
  type OntoCodeHarnessJob,
} from "@agentic/contracts";
import {
  resumeActionForJobKind,
  type ActionCardVM,
  type AssistantRecommendationActionVM,
} from "./projection";

type ConfigureAction = Extract<
  AssistantRecommendationActionVM,
  { type: "configure" }
>;

export type ToolAuthoringPreparationErrorCode =
  | "not_tool_authoring"
  | "missing_user_intent"
  | "missing_tool_identity"
  | "partial_waiting_binding"
  | "stale_waiting_binding"
  | "unsupported_readiness"
  | "secret_in_intent"
  | "invalid_task";

export type ToolAuthoringPreparation =
  | {
      ok: true;
      mode: "standalone" | "bound";
      request: CreateOntoCodeConfigurationTaskRequest;
    }
  | {
      ok: false;
      code: ToolAuthoringPreparationErrorCode;
      message: string;
    };

/**
 * 每个失败分支的用户可见文案，集中导出：engine-vocabulary 词汇闸门据此全量
 * 校验（含防御性分支），任何引擎内部称谓都进不了渲染输出。
 */
export const TOOL_AUTHORING_PREPARATION_MESSAGES = {
  not_tool_authoring:
    "这条建议不是经过结构化校验的工具创建请求，我没有创建任务。",
  missing_user_intent:
    "无法绑定提出这项需求的原始用户消息。请在会话中重新说明要连接的系统、工具名称和用途。",
  secret_in_intent:
    "检测到疑似密钥值；请先删除密钥，只保留环境变量名、接口用途和非敏感 contract 信息。",
  partial_waiting_binding:
    "这条建议缺少完整的等待作业、本体业务动作或 requirement 绑定。请让 OntoCode 重新检查 readiness。",
  unsupported_readiness:
    "当前阻塞不是完整的“缺少工具 contract”回执，不能据此创建工具任务。请重新执行 readiness 分析。",
  stale_waiting_binding:
    "绑定的等待作业已变化、已结束或不能确定性续跑。我没有创建过期任务；请刷新 readiness。",
  missing_tool_identity:
    "创建工具前还需要明确外部系统标识。请直接回复，例如“系统 <系统名>”；工具名会在创建流程中根据真实文档与 intent 提炼。",
  missing_tool_identity_generic:
    "缺少经过结构化校验的外部系统标识，我没有创建泛化工具任务。",
  invalid_task:
    "系统名、工具名、本体快照或任务版本不符合 Configuration Task contract；请让 OntoCode 重新生成建议。",
} as const;

const SECRET_VALUE_PATTERN =
  /(?:\b(?:bearer|token|password|passwd|secret)\s*[:=]\s*\S{8,}|\bapi[_-]?key\s*[:=]\s*\S{8,}|\bsk-[A-Za-z0-9_-]{12,})/iu;

function secretFree(value: string): boolean {
  return !SECRET_VALUE_PATTERN.test(value);
}

function taskAction(card: ActionCardVM): ConfigureAction | null {
  const action = card.recommendation?.action;
  return action?.type === "configure" && action.destination === "tool_authoring"
    ? action
    : null;
}

function invalid(
  code: ToolAuthoringPreparationErrorCode,
  message: string,
): ToolAuthoringPreparation {
  return { ok: false, code, message };
}

/**
 * Turns a user-confirmed recommendation into the exact server-owned
 * Configuration Task request. It never activates or saves a runnable tool.
 */
export function prepareToolAuthoringConfigurationTask(input: {
  session: Pick<
    OntoCodeBuildSession,
    "id" | "revision" | "ontologySnapshotHash"
  >;
  card: ActionCardVM;
  jobs: OntoCodeHarnessJob[];
}): ToolAuthoringPreparation {
  const action = taskAction(input.card);
  const recommendation = input.card.recommendation;
  if (!action || !recommendation) {
    return invalid(
      "not_tool_authoring",
      TOOL_AUTHORING_PREPARATION_MESSAGES.not_tool_authoring,
    );
  }
  const ontologyHash = input.session.ontologySnapshotHash?.trim() ?? "";
  const userIntent = recommendation.sourceUserIntent?.trim() ?? "";
  if (!userIntent || !recommendation.sourceUserMessageId) {
    return invalid(
      "missing_user_intent",
      TOOL_AUTHORING_PREPARATION_MESSAGES.missing_user_intent,
    );
  }
  const summary = action.toolIntent?.trim() || userIntent;
  if (!secretFree(userIntent) || !secretFree(summary)) {
    return invalid(
      "secret_in_intent",
      TOOL_AUTHORING_PREPARATION_MESSAGES.secret_in_intent,
    );
  }

  const boundSelectors = [
    action.waitingHarnessJobId,
    action.sourceActionName,
    action.sourceRequirementId,
  ];
  const boundSelectorCount = boundSelectors.filter(Boolean).length;
  const bound = boundSelectorCount > 0;
  if (boundSelectorCount > 0 && boundSelectorCount < boundSelectors.length) {
    return invalid(
      "partial_waiting_binding",
      TOOL_AUTHORING_PREPARATION_MESSAGES.partial_waiting_binding,
    );
  }

  let sourceJob: OntoCodeHarnessJob | undefined;
  let resumeAction: string | null = null;
  if (bound) {
    if (
      action.readinessStatus !== "missing" ||
      action.executionSurface ||
      !action.systemName ||
      !action.requirementKind ||
      !action.requirementRole
    ) {
      return invalid(
        "unsupported_readiness",
        TOOL_AUTHORING_PREPARATION_MESSAGES.unsupported_readiness,
      );
    }
    sourceJob = input.jobs.find(
      (job) =>
        job.id === action.waitingHarnessJobId &&
        job.sessionId === input.session.id &&
        job.status === "waiting_user",
    );
    resumeAction = sourceJob ? resumeActionForJobKind(sourceJob.kind) : null;
    if (!sourceJob || !resumeAction) {
      return invalid(
        "stale_waiting_binding",
        TOOL_AUTHORING_PREPARATION_MESSAGES.stale_waiting_binding,
      );
    }
  } else if (!action.systemName) {
    return invalid(
      "missing_tool_identity",
      TOOL_AUTHORING_PREPARATION_MESSAGES.missing_tool_identity,
    );
  }

  if (!action.systemName) {
    return invalid(
      "missing_tool_identity",
      TOOL_AUTHORING_PREPARATION_MESSAGES.missing_tool_identity_generic,
    );
  }

  const requestCandidate = {
    expectedSessionRevision: input.session.revision,
    ...(sourceJob?.commandId ? { sourceCommandId: sourceJob.commandId } : {}),
    ...(bound
      ? {
          waitingHarnessJobId: action.waitingHarnessJobId!,
          sourceRequirementId: action.sourceRequirementId!,
          sourceActionName: action.sourceActionName!,
        }
      : {}),
    blockerKey: recommendation.blockerKey,
    title: input.card.title,
    target: {
      kind: "tool" as const,
      system: action.systemName,
      desiredToolName: action.toolName ?? null,
      requirementKind: action.requirementKind ?? null,
      requirementRole: action.requirementRole ?? null,
    },
    requirement: {
      summary,
      // Keep the exact persisted user request even when the planner supplied a
      // shorter toolIntent for the summary.
      reason: userIntent,
      missingFields: [],
      sourceRefs: [
        `session-message:${recommendation.sourceUserMessageId}`,
        `assistant-recommendation:${recommendation.sourceMessageId}:${recommendation.id}`,
        ...(bound
          ? [
              `harness-job:${action.waitingHarnessJobId}`,
              `ontology-action:${action.sourceActionName}`,
              `integration-requirement:${action.sourceRequirementId}`,
            ]
          : []),
      ],
    },
    verificationPolicy: { kind: "tool_contract" as const },
    ...(bound && resumeAction
      ? {
          resumeAction:
            resumeAction as CreateOntoCodeConfigurationTaskRequest["resumeAction"],
        }
      : {}),
    ontologyHash,
    idempotencyKey: `configuration:${recommendation.blockerKey}`.slice(0, 256),
  };
  const parsed =
    CreateOntoCodeConfigurationTaskRequestSchema.safeParse(requestCandidate);
  if (!parsed.success) {
    return invalid(
      "invalid_task",
      TOOL_AUTHORING_PREPARATION_MESSAGES.invalid_task,
    );
  }
  return {
    ok: true,
    mode: bound ? "bound" : "standalone",
    request: parsed.data,
  };
}
