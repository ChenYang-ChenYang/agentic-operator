// 阶段与状态的人话说法。日志/推理/证据/测试四个面板共用同一份，
// 免得同一个作业在两个面板里叫两个名字。
import type { OntoCodeHarnessJob } from "@agentic/contracts";
import { productFacingOntoCodeText } from "./product-vocabulary";

export const JOB_LABEL: Record<string, string> = {
  ontology_analysis: "本体理解",
  scope: "范围分析",
  blueprint: "蓝图",
  build: "代码生成",
  test: "测试",
  debug: "修复",
  regression: "回归",
  simulation: "推演",
  promotion: "上线准备",
  deploy: "部署",
  production_analysis: "线上分析",
};

export function jobKindLabel(kind: string): string {
  return JOB_LABEL[kind] ?? kind;
}

export const JOB_STATUS_TEXT: Record<string, string> = {
  succeeded: "完成",
  failed_terminal: "失败",
  failed_recoverable: "失败（可修复）",
  cancelled: "已取消",
  waiting_user: "等你回答",
  running: "进行中",
  leased: "进行中",
  queued: "排队中",
  retry_scheduled: "待重试",
};

export function jobStatusText(status: string): string {
  return JOB_STATUS_TEXT[status] ?? status;
}

const TERMINAL_STATUS = new Set([
  "succeeded",
  "failed_terminal",
  "failed_recoverable",
  "cancelled",
]);

export function jobIsTerminal(status: string): boolean {
  return TERMINAL_STATUS.has(status);
}

const FAILED_STATUS = new Set([
  "failed_terminal",
  "failed_recoverable",
  "cancelled",
]);

export function jobFailed(status: string): boolean {
  return FAILED_STATUS.has(status);
}

/**
 * 失败节点上的那一行。原因缺席时说「未记录」——绝不用一句「失败」把
 * 「我们没记下来」和「它没有原因」混成同一件事。
 */
export const MISSING_FAILURE_REASON = "未记录失败原因";

export function jobFailureReason(
  job: Pick<OntoCodeHarnessJob, "errorMessage">,
): string {
  const text = job.errorMessage?.trim();
  return text ? productFacingOntoCodeText(text) : MISSING_FAILURE_REASON;
}
