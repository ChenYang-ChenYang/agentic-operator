"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  OntoCodeSessionEventSchema,
  type OntoCodeSessionEvent,
} from "@agentic/contracts";
import { ONTOCODE_KEYS } from "./useOntoCodeWorkspace";

export type OntoCodeStreamState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface UseOntoCodeSessionStreamOptions {
  enabled?: boolean;
  onEvent?: (event: OntoCodeSessionEvent) => void;
  onStatusChange?: (status: OntoCodeStreamState) => void;
}

const MAX_BACKOFF_MS = 30_000;

export interface OntoCodeSseFrame {
  id: string;
  event: string;
  data: string;
}

/**
 * 实时流的可见度下限。
 *
 * 服务端默认 `user`，而对话推理与 Harness 的每一帧过程记录都以 `debug` 落库。
 * 不带这个参数，那些帧一条都不会走实时流——它们照样落库、刷新也照样看得见，
 * 但「一步一步长出来」当场落空。REST 的 events 查询早就带着 `debug` 了，实时流
 * 是这条链上唯一没跟上的一环。
 *
 * 不传 `audit`：那一档要另一套权限，服务端会 400 拒绝而不是降级——悄悄降级等于
 * 答了一个比问题更窄的问题。
 */
const STREAM_VISIBILITY = "debug";

export function ontocodeStreamPath(
  sessionId: string,
  lastEventId = "",
): string {
  const path =
    `/v1/ontocode/sessions/${encodeURIComponent(sessionId)}/stream` +
    `?visibility=${STREAM_VISIBILITY}`;
  if (!lastEventId) return path;
  return `${path}&lastEventId=${encodeURIComponent(lastEventId)}`;
}

export function parseOntoCodeSseFrame(frame: string): OntoCodeSseFrame | null {
  let id = "";
  let event = "message";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const rawValue = separator === -1 ? "" : rawLine.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return { id, event, data: data.join("\n") };
}

/**
 * 冲刷频率上限：一次 Harness 作业会连发数十个事件，逐事件全量失效 13 组查询
 * 会触发服务端读限流（每用户 600 读/分）。
 */
const INVALIDATE_MIN_INTERVAL_MS = 1_200;
const pendingInvalidations = new Map<string, ReturnType<typeof setTimeout>>();
const lastFlushAt = new Map<string, number>();

/**
 * 节流，不是防抖。
 *
 * 旧实现是尾随防抖：第一个事件只负责起一个 1.2 秒的定时器，安静了很久之后到达
 * 的那一条也要平白等满这 1.2 秒。对话路径改成真多回合之后这笔税是可见的——实测
 * 同一轮里四次模型返回的间隔是 1409 / 1603 / 1502 / 2105 毫秒，每一段都比窗口
 * 长，也就是**每一次到达都在等满 1.2 秒**，本来 2.1 秒的最长空窗被拉成 3.3 秒。
 *
 * 改成节流之后：安静期后的第一个事件立刻冲刷，同一窗口内后续的合批成一次尾随
 * 冲刷。冲刷频率上限一点没变（≤1 次/窗口），少掉的只是那笔恒定的等待。
 *
 * 这里没有、也不该有任何「让它看起来更流畅」的延时：上屏节奏必须等于事件真实
 * 到达的节奏。
 */
export function invalidateOntoCodeEvent(
  client: QueryClient,
  tenant: string,
  sessionId: string,
): void {
  const key = `${tenant}::${sessionId}`;
  if (pendingInvalidations.has(key)) return;
  const previous = lastFlushAt.get(key);
  const since = previous === undefined ? Infinity : Date.now() - previous;
  if (since >= INVALIDATE_MIN_INTERVAL_MS) {
    lastFlushAt.set(key, Date.now());
    flushOntoCodeInvalidations(client, tenant, sessionId);
    return;
  }
  pendingInvalidations.set(
    key,
    setTimeout(
      () => {
        pendingInvalidations.delete(key);
        lastFlushAt.set(key, Date.now());
        flushOntoCodeInvalidations(client, tenant, sessionId);
      },
      INVALIDATE_MIN_INTERVAL_MS - since,
    ),
  );
}

/** 事件端点返回的形状。与 `useOntoCodeSessionEvents` 的缓存值同形。 */
export interface OntoCodeLiveEventCache {
  items: OntoCodeSessionEvent[];
  lastSeq: number;
  hasMore: boolean;
  truncated: boolean;
}

/**
 * 把一条已经到达的持久事件并进事件缓存。
 *
 * 这不是「直播缓冲」：实时流转运的是**已落库**的行——服务端按 seq 游标读事件
 * 账本，只发已提交的记录，带着最终的 id 与 seq。并进去的就是刷新后会重新拿到
 * 的同一行，所以重放一致，也不存在与持久内容并排显示两个版本的问题。
 *
 * 不并的话，这一行明明已经在浏览器里，却要先等满一个节流窗口、再跑一趟最多
 * 八页的全量取回才可能上屏——多回合对话每一次工具返回都要白等这一趟。
 *
 * 三种情况保持沉默而不是硬并：
 *   1. 首次取回还没落地（缓存无值）——凭一条事件造一份列表，等于把「这一条」
 *      说成「全部」；
 *   2. 取回自己报了没取完（`truncated`）——手上是最早的一段，把一条新事件贴在
 *      它末尾会让它看起来紧挨着并不相邻的事件；
 *   3. 这条已经在里面（重连续传会重叠）——原样返回同一引用。
 */
export function mergeLiveOntoCodeEvent(
  cache: OntoCodeLiveEventCache | undefined,
  event: OntoCodeSessionEvent,
): OntoCodeLiveEventCache | undefined {
  if (!cache) return undefined;
  if (cache.truncated) return cache;
  if (cache.items.some((existing) => existing.id === event.id)) return cache;
  const items = [...cache.items, event].sort(
    (a, b) => a.seq - b.seq || a.createdAt - b.createdAt,
  );
  return {
    ...cache,
    items,
    lastSeq: Math.max(cache.lastSeq, event.seq),
  };
}

/** 事件缓存的 query key。与 `ONTOCODE_KEYS.events` 是同一份。 */
export function applyLiveOntoCodeEvent(
  client: QueryClient,
  tenant: string,
  sessionId: string,
  event: OntoCodeSessionEvent,
): void {
  client.setQueryData<OntoCodeLiveEventCache>(
    ONTOCODE_KEYS.events(tenant, sessionId),
    (cache) => mergeLiveOntoCodeEvent(cache, event),
  );
}

export function flushOntoCodeInvalidations(
  client: QueryClient,
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
    queryKey: ONTOCODE_KEYS.messages(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.commands(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.jobs(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.assistantRuns(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ONTOCODE_KEYS.candidateHead(tenant, sessionId),
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "changesets"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "artifacts"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "evidence"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "events"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "configuration-tasks"],
  });
  void client.invalidateQueries({
    queryKey: ["ontocode", tenant, "session", sessionId, "suite-overview"],
  });
}

/**
 * Live transport for committed OntoCode session events.
 *
 * The durable event sequence is carried across explicit reconnects. A fetch
 * stream is used instead of EventSource so the tenant selector can travel in
 * the same authenticated request as every other portal query. Query data
 * remains authoritative; SSE only invalidates projections after commit.
 */
export function useOntoCodeSessionStream(
  tenant: string,
  sessionId: string,
  options: UseOntoCodeSessionStreamOptions = {},
): void {
  const client = useQueryClient();
  const enabled = options.enabled ?? true;
  const onEventRef = useRef(options.onEvent);
  const onStatusRef = useRef(options.onStatusChange);

  useEffect(() => {
    onEventRef.current = options.onEvent;
    onStatusRef.current = options.onStatusChange;
  }, [options.onEvent, options.onStatusChange]);

  useEffect(() => {
    if (!enabled || !tenant || !sessionId) {
      onStatusRef.current?.("closed");
      return;
    }

    let controller: AbortController | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let lastEventId = "";

    const scheduleReconnect = () => {
      if (cancelled) return;
      attempt += 1;
      onStatusRef.current?.("reconnecting");
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (cancelled) return;
      onStatusRef.current?.(attempt ? "reconnecting" : "connecting");
      controller = new AbortController();
      try {
        const response = await fetch(
          ontocodeStreamPath(sessionId, lastEventId),
          {
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              Accept: "text/event-stream",
              "x-agentic-tenant": tenant,
              ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
            },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new Error(
            `OntoCode event stream failed with HTTP ${response.status}`,
          );
        }
        attempt = 0;
        onStatusRef.current?.("connected");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const result = await reader.read();
          buffer += decoder.decode(result.value, { stream: !result.done });
          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary >= 0) {
            const rawFrame = buffer.slice(0, boundary);
            const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0];
            buffer = buffer.slice(boundary + (delimiter?.length ?? 2));
            const frame = parseOntoCodeSseFrame(rawFrame);
            if (frame?.event === "stream.error") {
              throw new Error("OntoCode event stream reported a poll failure");
            }
            if (frame?.event === "message") {
              let payload: unknown;
              try {
                payload = JSON.parse(frame.data) as unknown;
              } catch (error) {
                console.warn("[ontocode.stream] dropped non-JSON event", error);
                boundary = buffer.search(/\r?\n\r?\n/);
                continue;
              }
              const parsed = OntoCodeSessionEventSchema.safeParse(payload);
              if (!parsed.success || parsed.data.sessionId !== sessionId) {
                console.warn(
                  "[ontocode.stream] dropped malformed or foreign event",
                  parsed.success ? parsed.data : parsed.error,
                );
              } else {
                if (frame.id) lastEventId = frame.id;
                // 这一行已经在手上了，先并进缓存——推理泳道当场长出来，不必
                // 等一个节流窗口再跑一趟全量取回。
                applyLiveOntoCodeEvent(client, tenant, sessionId, parsed.data);
                invalidateOntoCodeEvent(client, tenant, sessionId);
                onEventRef.current?.(parsed.data);
              }
            }
            boundary = buffer.search(/\r?\n\r?\n/);
          }
          if (result.done) break;
        }
        reader.releaseLock();
        if (!cancelled) scheduleReconnect();
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        console.warn(
          "[ontocode.stream] reconnecting after transport error",
          error,
        );
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
      onStatusRef.current?.("closed");
    };
  }, [client, enabled, sessionId, tenant]);
}
