/**
 * 等待期的诚实表达。
 *
 * 对话推理走中央网关单发，没有 token 流——模型思考期间**必然**有空窗，这是架构
 * 下限，不是缺陷。服务端本轮把最大空窗从 21848ms 压到 17130ms，压不到 0。这段
 * 时间里中栏此前什么都不显示，只有发送按钮写着「发送中…」；黑箱在屏幕上和
 * 「卡死了」长得一模一样。
 *
 * 这里只产出两种真实的东西：
 *   1. 真实经过的时间（受理时刻 → 现在）；
 *   2. 真实到达过的最后一条过程记录，以及它到达的时间。
 *
 * 不产出任何「进度」——没有百分比、没有预计剩余、没有分片计数。渲染侧同样不许
 * 有动画：一个转圈会把「什么都没发生」演成「正在推进」，那正是要消灭的东西。
 */
import type { OntoCodeSessionEvent } from "@agentic/contracts";
import { eventDetail, eventLabel } from "./SessionLog";

export interface AssistantWaitVM {
  runId: string;
  /** 受理到现在真实经过的毫秒数。 */
  elapsedMs: number;
  /**
   * 最近一条真实到达的过程记录，已经是人话。
   * `null` = 受理之后一帧都还没到——这正是实测里最长的那段空窗。
   */
  lastFact: string | null;
  /** 距那条记录到达过去了多久。`lastFact` 为 null 时同样为 null。 */
  sinceLastFactMs: number | null;
}

/** 轮次生命周期帧。它们说的是「这一轮开始/结束了」，不是过程记录。 */
const RUN_ACCEPTED = "assistant.run.accepted";
const RUN_TERMINAL: ReadonlySet<string> = new Set([
  "assistant.run.succeeded",
  "assistant.run.failed",
]);

/** 对话推理的过程记录命名空间。作业帧（harnessJobId 非空）不在这条路上。 */
const ASSISTANT_FRAME = /^harness\.assistant\./;

function runIdOf(event: OntoCodeSessionEvent): string | null {
  const payload = event.payload as Record<string, unknown> | null;
  const runId = payload?.assistantRunId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

function newerThan(
  candidate: OntoCodeSessionEvent,
  best: OntoCodeSessionEvent | null,
): boolean {
  if (!best) return true;
  return (
    candidate.createdAt > best.createdAt ||
    (candidate.createdAt === best.createdAt && candidate.seq > best.seq)
  );
}

/** 助手运行行上「这一轮已经结束了」的状态。 */
const TERMINAL_RUN_STATUS: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** 只读这一格：行的状态是这一轮结束没有的权威，其余字段与等待无关。 */
export interface AssistantWaitRunLike {
  id: string;
  status: string;
}

/**
 * 正在飞的那一轮，或 null。
 *
 * 只看**最新**的一次受理：上一轮崩在半路没留下终态事件时，等待说的必须是新的
 * 这一轮，而不是那条孤儿。归属一律按 `assistantRunId` 判，不按到达顺序——别的
 * 轮次留下的帧不许冒充这一轮的「最近一条记录」。
 *
 * 事件是分页取的（按 seq 升序、有页数上限），所以长会话上「受理」进得来而
 * 「完成」落在视野外是可能的。只看事件会让一条早就跑完的轮次永远挂着「等待
 * 中」——那不是诚实，那是一句过期的话。助手运行行自己的状态是权威，拿它兜底；
 * 行没取到时退回只看事件，绝不因为「查不到」就断言它还在跑。
 */
export function selectAssistantWait(input: {
  events: readonly OntoCodeSessionEvent[];
  runs?: readonly AssistantWaitRunLike[];
  now: number;
}): AssistantWaitVM | null {
  let accepted: OntoCodeSessionEvent | null = null;
  for (const event of input.events) {
    if (event.type !== RUN_ACCEPTED) continue;
    if (!runIdOf(event)) continue;
    if (newerThan(event, accepted)) accepted = event;
  }
  if (!accepted) return null;
  const runId = runIdOf(accepted)!;

  const row = input.runs?.find((candidate) => candidate.id === runId);
  if (row && TERMINAL_RUN_STATUS.has(row.status)) return null;

  let lastFrame: OntoCodeSessionEvent | null = null;
  for (const event of input.events) {
    if (runIdOf(event) !== runId) continue;
    if (RUN_TERMINAL.has(event.type)) return null;
    if (!ASSISTANT_FRAME.test(event.type)) continue;
    if (newerThan(event, lastFrame)) lastFrame = event;
  }

  // 服务端时钟可以略快于浏览器；负的「已 -2 秒」比不显示更糟。
  const since = (at: number): number => Math.max(0, input.now - at);
  const detail = lastFrame ? eventDetail(lastFrame) : "";
  return {
    runId,
    elapsedMs: since(accepted.createdAt),
    lastFact: lastFrame
      ? detail
        ? `${eventLabel(lastFrame.type)} · ${detail}`
        : eventLabel(lastFrame.type)
      : null,
    sinceLastFactMs: lastFrame ? since(lastFrame.createdAt) : null,
  };
}

/**
 * 真实经过的时间 → 人话。一律向下取整：向上取整会把 1 秒说成 2 秒，等待时长
 * 是这一行唯一的实质内容，多报一点就没有实质了。
 *
 * 两分钟以内数秒，之后数分钟——「已 7234 秒」是真话，但不是任何人读得出来的
 * 真话。
 */
export function formatWaitDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 120) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分钟`;
}
