import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { OntoCodeSessionEvent } from "@agentic/contracts";
import {
  flushOntoCodeInvalidations,
  invalidateOntoCodeEvent,
  mergeLiveOntoCodeEvent,
  ontocodeStreamPath,
  parseOntoCodeSseFrame,
  type OntoCodeLiveEventCache,
} from "./useOntoCodeSessionStream";

describe("OntoCode session stream helpers", () => {
  it("preserves the durable cursor across reconnects", () => {
    expect(ontocodeStreamPath("ocs-1")).toBe(
      "/v1/ontocode/sessions/ocs-1/stream?visibility=debug",
    );
    expect(ontocodeStreamPath("ocs/unsafe", "17")).toBe(
      "/v1/ontocode/sessions/ocs%2Funsafe/stream?visibility=debug&lastEventId=17",
    );
  });

  /*
   * 可达性闸门。
   *
   * 服务端 `parseStreamVisibility` 的默认值是 `user`，而对话推理的每一帧都以
   * `debug` 落库——不带这个参数，那些帧一条都不会走实时流，右栏只能靠刷新才
   * 长出来。REST 的 events 查询早就带了 `visibility=debug`，实时流没跟上，于是
   * 「发得出、存得住、却送不到」。
   *
   * `audit` 不许传：服务端会 400 拒绝（那一档要另一套权限），悄悄降级等于答了
   * 一个比问题更窄的问题。
   */
  it("asks the live tail for the debug tier the reasoning frames live in", () => {
    for (const path of [
      ontocodeStreamPath("ocs-1"),
      ontocodeStreamPath("ocs-1", "42"),
    ]) {
      expect(path).toContain("visibility=debug");
      expect(path).not.toContain("visibility=audit");
    }
  });

  it("decodes multiline SSE data while ignoring heartbeats and retry hints", () => {
    expect(parseOntoCodeSseFrame(": heartbeat 1\nretry: 1000")).toBeNull();
    expect(
      parseOntoCodeSseFrame(
        'id: 17\nevent: message\ndata: {"part":1,\ndata: "ok":true}',
      ),
    ).toEqual({
      id: "17",
      event: "message",
      data: '{"part":1,\n"ok":true}',
    });
  });

  /*
   * 节流，不是防抖。
   *
   * 这道闸门存在的理由只有一个：一次作业会连发数十个事件，逐事件失效 13 组查询
   * 会撞上服务端每用户 600 读/分的限流。它要保证的是**冲刷频率上限**，不是「先
   * 等 1.2 秒再说」。
   *
   * 旧实现是尾随防抖：安静了很久之后到达的第一个事件，也要平白等满 1.2 秒才上
   * 屏。对话路径改成真多回合之后这笔税是可见的——实测同一轮里模型返回的间隔是
   * 1.4/1.6/1.5/2.1 秒，每一段都比 1.2 秒长，也就是每一次到达都在等满这 1.2 秒。
   * 改成节流：安静期后的第一个事件立刻冲刷，随后的合批成尾随一次，上限不变。
   */
  it("flushes the first event of a quiet period immediately", () => {
    vi.useFakeTimers();
    try {
      const invalidateQueries = vi.fn().mockResolvedValue(undefined);
      const client = { invalidateQueries } as unknown as QueryClient;
      invalidateOntoCodeEvent(client, "raas", "ocs-lead");
      expect(invalidateQueries).toHaveBeenCalledTimes(13);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still coalesces a burst — at most one flush per rate window", () => {
    vi.useFakeTimers();
    try {
      const invalidateQueries = vi.fn().mockResolvedValue(undefined);
      const client = { invalidateQueries } as unknown as QueryClient;
      // 首个事件立刻冲刷，随后 20 个挤在同一窗口里的事件只换来一次尾随冲刷。
      for (let i = 0; i < 21; i += 1) {
        invalidateOntoCodeEvent(client, "raas", "ocs-burst");
      }
      expect(invalidateQueries).toHaveBeenCalledTimes(13);
      vi.advanceTimersByTime(1_300);
      expect(invalidateQueries).toHaveBeenCalledTimes(26);
      // 窗口过完再没有新事件，就不该再有冲刷。
      vi.advanceTimersByTime(5_000);
      expect(invalidateQueries).toHaveBeenCalledTimes(26);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never exceeds one flush per window even under a sustained stream", () => {
    vi.useFakeTimers();
    try {
      const invalidateQueries = vi.fn().mockResolvedValue(undefined);
      const client = { invalidateQueries } as unknown as QueryClient;
      // 6 秒里每 100ms 一个事件（比实测的多回合密得多）。
      for (let elapsed = 0; elapsed < 6_000; elapsed += 100) {
        invalidateOntoCodeEvent(client, "raas", "ocs-sustained");
        vi.advanceTimersByTime(100);
      }
      const flushes = invalidateQueries.mock.calls.length / 13;
      expect(Number.isInteger(flushes)).toBe(true);
      // 上界要有下界作陪：一次都不冲刷也满足「不超过 6 次」。
      expect(flushes).toBeGreaterThanOrEqual(4);
      // 6 秒 / 1.2 秒 = 5 个窗口，各一次；首个事件那次也在其中。
      expect(flushes).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates every live session projection", () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    flushOntoCodeInvalidations(
      { invalidateQueries } as unknown as QueryClient,
      "raas",
      "ocs-1",
    );
    expect(invalidateQueries).toHaveBeenCalledTimes(13);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "suite-overview"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "events"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        "ontocode",
        "raas",
        "session",
        "ocs-1",
        "configuration-tasks",
      ],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "jobs"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "artifacts"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "assistant-runs"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["ontocode", "raas", "session", "ocs-1", "candidate-head"],
    });
  });
});

/* -------------------------------------------------------------------------
 * 已经到达的持久事件直接并入事件缓存。
 *
 * 这不是「直播缓冲」：实时流转运的是**已落库**的行（服务端 `listOntoCodeEvents`
 * 按 seq 游标读账本，绝不发未提交的声明），带着最终的 id 与 seq。所以并进去的
 * 就是刷新后会拿到的同一行，重放一致。
 *
 * 不并的话，这一行明明已经在浏览器里，却要等满一个节流窗口、再跑一趟最多 8 页
 * 的全量取回才上屏——多回合对话的每一次工具返回都白等这一趟。
 * ---------------------------------------------------------------------- */

function liveEvent(seq: number, type: string): OntoCodeSessionEvent {
  return {
    id: `oce-${seq}`,
    seq,
    tenantId: "t",
    projectId: "p",
    sessionId: "ocs-1",
    harnessJobId: null,
    commandId: null,
    correlationId: "cor-1",
    causationId: null,
    type,
    visibility: "debug",
    payload: {},
    createdAt: 1_754_300_000_000 + seq,
  } as OntoCodeSessionEvent;
}

function cache(
  seqs: number[],
  overrides: Partial<OntoCodeLiveEventCache> = {},
): OntoCodeLiveEventCache {
  return {
    items: seqs.map((seq) => liveEvent(seq, "harness.assistant.model")),
    lastSeq: seqs.length > 0 ? Math.max(...seqs) : 0,
    hasMore: false,
    truncated: false,
    ...overrides,
  };
}

describe("live event merge", () => {
  it("appends the arrived event so the lane paints at arrival latency", () => {
    const merged = mergeLiveOntoCodeEvent(
      cache([1, 2]),
      liveEvent(3, "harness.assistant.tool_call"),
    )!;
    expect(merged.items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged.lastSeq).toBe(3);
  });

  it("keeps seq order when a frame arrives out of order", () => {
    const merged = mergeLiveOntoCodeEvent(
      cache([1, 4]),
      liveEvent(2, "harness.assistant.tool_result"),
    )!;
    expect(merged.items.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(merged.lastSeq).toBe(4);
  });

  it("is idempotent — a replayed frame does not double a row", () => {
    // 重连会带着 Last-Event-ID 续传，边界上同一条可能再来一次。
    const first = mergeLiveOntoCodeEvent(cache([1]), liveEvent(2, "x"))!;
    const second = mergeLiveOntoCodeEvent(first, liveEvent(2, "x"))!;
    expect(second.items.map((e) => e.seq)).toEqual([1, 2]);
    // 同一引用返回，React Query 才不会因为一次无变化的合并重渲染整棵树。
    expect(second).toBe(first);
  });

  it("does not fabricate a list before the first fetch has landed", () => {
    // 缓存还没有值时凭一条事件造一份列表，等于把「这条」说成「全部」。
    expect(mergeLiveOntoCodeEvent(undefined, liveEvent(1, "x"))).toBeUndefined();
  });

  it("leaves a truncated window alone rather than faking continuity", () => {
    // 取回在第 8 页停下时，手上是最早的一段。把一条新事件贴在它末尾，会让它
    // 看起来紧挨着并不相邻的事件——比不显示更糟。
    const truncated = cache([1, 2], { hasMore: true, truncated: true });
    expect(mergeLiveOntoCodeEvent(truncated, liveEvent(9_999, "x"))).toBe(
      truncated,
    );
  });

  it("keeps every timer in this file accounted for", () => {
    /*
     * 假流式的防线。
     *
     * 这条链上只允许两处定时器，各有其名：断线重连的指数退避、以及冲刷频率
     * 上限。第三处出现，多半就是「让它看起来更流畅」——把一条已经到达的记录
     * 压着晚点上屏，屏幕上的节奏就不再等于事情真实发生的节奏。
     */
    const source = readFileSync(
      fileURLToPath(new URL("./useOntoCodeSessionStream.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("requestAnimationFrame");
    expect(source.match(/setTimeout\(/g) ?? []).toHaveLength(2);
    expect(source).toContain("scheduleReconnect");
    expect(source).toContain("INVALIDATE_MIN_INTERVAL_MS");
  });

  it("carries the completeness flags through untouched", () => {
    // 合并一条已到达的事件，回答不了「取回是否取完了」——那是取回自己的回执。
    const merged = mergeLiveOntoCodeEvent(cache([1]), liveEvent(2, "x"))!;
    expect(merged.hasMore).toBe(false);
    expect(merged.truncated).toBe(false);
  });
});
