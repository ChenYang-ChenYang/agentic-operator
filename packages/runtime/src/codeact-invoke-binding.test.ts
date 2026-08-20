// #INVOKE-NO-SUBSTITUTE —— 沙箱里的 ctx.invoke 必须和生产一样【拒绝】，不许替身。
//
// 修掉的行为：没有 host 绑定时，沙箱会退到 `spawn("执行 <agentRef>", …)`——
// 也就是让一个 LLM 现编一个「大概叫这个名字」的 agent，把它的输出当成真子
// agent 的回答返回。沙箱证据正是晋升的门，所以一个幻觉替身可以为一个根本不
// 存在的子 agent 背书「跑通了」。两边行为不一致的沙箱，测的就不是将要上线的
// 那个东西。
//
// 两段各测一件事：
//   · dispatchInvokeRpc —— 那条缝【本身】。它只依赖 hostRuntime 与调用参数，
//     所以能脱离容器单测。
//   · 经 containerTransport 注入缝驱动【真实的 onRpc 闭包】——证明这条规则确实
//     接在 RPC 上。一个单元正确但没接线的修复，等于没修。
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchInvokeRpc, runGeneratedCodeIsolated } from "./codeact";
import type {
  CodeActDockerTransport,
  DockerCandidateAttach,
  DockerCandidateCreateConfig,
  DockerCandidateInspect,
} from "./codeact-container";

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


/**
 * 上面测的是那条缝本身；这一段测的是它【真的接在 RPC 上】——一个单元正确但没
 * 接线的修复，等于没修。
 *
 * 容器执行有一个已导出的注入缝 `containerTransport`，可以在不拉起 Docker 的
 * 前提下驱动真实的 onRpc 闭包：假传输按容器协议发一条 invoke RPC，然后断言
 * host 侧回给容器的是错误而不是一个编出来的子 agent 结果。
 */
class InvokeRpcTransport implements CodeActDockerTransport {
  createConfig?: DockerCandidateCreateConfig;
  /** host 对这条 invoke RPC 的答复——本测试要看的就是它。 */
  rpcReply?: Record<string, unknown>;
  private removed = false;
  private started = false;
  private readonly stdin = new PassThrough();
  private readonly stdout = new PassThrough();
  private readonly stderr = new PassThrough();
  private readonly exitPromise: Promise<{ statusCode: number }>;
  private exitResolve!: (value: { statusCode: number }) => void;
  private readonly closedPromise: Promise<void>;
  private closedResolve!: () => void;

  constructor() {
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
    this.closedPromise = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.kind === "execute") {
          this.stdout.write(
            `${JSON.stringify({
              kind: "rpc",
              id: 1,
              method: "invoke",
              args: ["realChild", { id: "cand-1" }],
            })}\n`,
          );
        } else if (message.kind === "rpc_result") {
          this.rpcReply = message;
          this.stdout.write(
            `${JSON.stringify({
              kind: "result",
              ok: true,
              result: {},
              emitted: [],
              rpcCount: 1,
            })}\n`,
          );
          this.exitResolve({ statusCode: 0 });
          this.stdout.end();
          this.stderr.end();
          this.closedResolve();
        }
      }
    });
  }

  async create(
    _name: string,
    config: DockerCandidateCreateConfig,
  ): Promise<{ id: string }> {
    this.createConfig = config;
    return { id: "b".repeat(64) };
  }

  async inspect(): Promise<DockerCandidateInspect | null> {
    if (this.removed) return null;
    const config = this.createConfig!;
    return {
      Id: "b".repeat(64),
      Image: `sha256:${"c".repeat(64)}`,
      Config: {
        Image: config.Image,
        User: config.User,
        Env: [],
        Entrypoint: config.Entrypoint,
      },
      HostConfig: { ...config.HostConfig },
      Mounts: [],
      State: { OOMKilled: false, ExitCode: this.started ? 0 : -1 },
    } as DockerCandidateInspect;
  }

  async attach(): Promise<DockerCandidateAttach> {
    return {
      input: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      closed: this.closedPromise,
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  wait(): Promise<{ statusCode: number }> {
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    this.exitResolve({ statusCode: 137 });
    this.closedResolve();
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}

const AGENT_CODE = `
  import { defineAgent } from "@agentic/runtime";
  export default defineAgent({
    handler: async (input: any, ctx: any) => ctx.invoke("realChild", { id: input.id }),
  });
`;

describe("the no-substitute rule is actually wired into the invoke RPC", () => {
  const previousGenerated = process.env.FACTORY_EXEC_GENERATED;
  const previousImage = process.env.FACTORY_CODEACT_CANDIDATE_IMAGE;

  beforeEach(() => {
    process.env.FACTORY_EXEC_GENERATED = "1";
    // 镜像固定检查只看字符串形状，不需要真镜像。
    process.env.FACTORY_CODEACT_CANDIDATE_IMAGE = `agentic-codeact-candidate@sha256:${"a".repeat(64)}`;
  });
  afterEach(() => {
    if (previousGenerated === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = previousGenerated;
    if (previousImage === undefined) delete process.env.FACTORY_CODEACT_CANDIDATE_IMAGE;
    else process.env.FACTORY_CODEACT_CANDIDATE_IMAGE = previousImage;
  });

  it("answers an unbound invoke with an error, never with an improvised result", async () => {
    const transport = new InvokeRpcTransport();
    await runGeneratedCodeIsolated(
      AGENT_CODE,
      { id: "cand-1" },
      {
        // 沙箱租户（-sb 结尾），且不提供 hostRuntime.invoke —— 这正是旧实现
        // 落进 spawn 幻觉分支的形状。
        tenantSlug: "af-sbx-probe-sb",
        containerTransport: transport,
        timeoutMs: 15_000,
      },
    );

    expect(transport.rpcReply).toBeTruthy();
    expect(transport.rpcReply!.ok).toBe(false);
    expect(String(transport.rpcReply!.error)).toMatch(
      /no durable host binding/,
    );
    // 没有任何"编出来的子 agent 结果"回到容器里。
    expect(transport.rpcReply!.value).toBeUndefined();
  }, 40_000);
});
