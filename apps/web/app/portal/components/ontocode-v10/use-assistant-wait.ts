"use client";
// OntoCode v10 · 等待期的时钟。
//
// 判定与文案全在 `assistant-wait.ts` 里（纯函数，单测覆盖）。这里只负责一件
// 事：在真的有一轮在飞的时候，每秒把「现在」推进一次。没有轮次在飞就不装
// 定时器——一个空转的心跳正是这一行要反对的东西。
import { useEffect, useMemo, useState } from "react";
import type { OntoCodeSessionEvent } from "@agentic/contracts";
import {
  selectAssistantWait,
  type AssistantWaitRunLike,
  type AssistantWaitVM,
} from "./assistant-wait";

export function useAssistantWait(
  events: readonly OntoCodeSessionEvent[],
  runs: readonly AssistantWaitRunLike[],
): AssistantWaitVM | null {
  /*
   * 0 而不是 `Date.now()`：首帧在服务端与客户端必须算出同一个数，否则一个
   * 「已 3 秒 / 已 4 秒」的水合不一致会把整棵树标红。0 让首帧恒为「已 0 秒」，
   * 下面的 effect 立刻把它换成真实时刻。
   */
  const [now, setNow] = useState(0);
  const wait = useMemo(
    () => selectAssistantWait({ events, runs, now }),
    [events, runs, now],
  );
  const waiting = wait !== null;
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);
  return wait;
}
