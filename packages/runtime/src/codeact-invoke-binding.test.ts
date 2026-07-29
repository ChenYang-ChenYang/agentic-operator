// #INVOKE-NO-SUBSTITUTE —— 沙箱里的 ctx.invoke 必须和生产一样【拒绝】，不许替身。
//
// 修掉的行为：没有 host 绑定时，沙箱会退到 `spawn("执行 <agentRef>", …)`——
// 也就是让一个 LLM 现编一个「大概叫这个名字」的 agent，把它的输出当成真子
// agent 的回答返回。沙箱证据正是晋升的门，所以一个幻觉替身可以为一个根本不
// 存在的子 agent 背书「跑通了」。两边行为不一致的沙箱，测的就不是将要上线的
// 那个东西。
//
// 这里测的是 dispatchInvokeRpc —— 那条缝本身。它只依赖 hostRuntime 与调用
// 参数，所以能脱离容器单测；走 runGeneratedCodeIsolated 则需要固定镜像摘要，
// 测出来的是环境而不是不变量。
import { describe, expect, it, vi } from "vitest";
import { dispatchInvokeRpc } from "./codeact";

describe("dispatchInvokeRpc", () => {
  it("refuses when there is no host binding — no improvised stand-in", async () => {
    await expect(dispatchInvokeRpc(undefined, ["realChild", { id: 1 }])).rejects.toThrow(
      /invoke 'realChild' has no durable host binding/,
    );
  });

  it("refuses identically when the host runtime exists but carries no invoke", async () => {
    // 这是沙箱的真实形状：hostRuntime 在，但没有 invoke 绑定。旧实现正是在
    // 这里落进 spawn 的幻觉分支。
    const hostRuntime = { tool: vi.fn(), reason: vi.fn() } as never;
    await expect(dispatchInvokeRpc(hostRuntime, ["realChild", {}])).rejects.toThrow(
      /has no durable host binding/,
    );
  });

  it("calls the real child when a binding exists, passing input and timeout through", async () => {
    const invoke = vi.fn(async () => ({ matched: true }));
    await expect(
      dispatchInvokeRpc({ invoke } as never, [
        "realChild",
        { id: "cand-1" },
        { timeoutMs: 5_000 },
      ]),
    ).resolves.toEqual({ matched: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual([
      "realChild",
      { id: "cand-1" },
      { timeoutMs: 5_000 },
    ]);
  });

  it("rejects a missing or blank agentRef rather than inventing one", async () => {
    await expect(dispatchInvokeRpc(undefined, [])).rejects.toThrow(
      /agentRef is required/,
    );
    await expect(dispatchInvokeRpc(undefined, ["   "])).rejects.toThrow(
      /agentRef is required/,
    );
  });

  it("rejects a non-positive timeout instead of silently ignoring it", async () => {
    const invoke = vi.fn();
    await expect(
      dispatchInvokeRpc({ invoke } as never, ["child", {}, { timeoutMs: 0 }]),
    ).rejects.toThrow(/positive finite number/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("times out a hanging child with a named error", async () => {
    const invoke = vi.fn(
      () => new Promise(() => undefined) as Promise<unknown>,
    );
    await expect(
      dispatchInvokeRpc({ invoke } as never, ["slowChild", {}, { timeoutMs: 30 }]),
    ).rejects.toThrow(/invoke 'slowChild' exceeded timeout \(30ms\)/);
  });
});
