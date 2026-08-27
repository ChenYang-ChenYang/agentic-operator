/**
 * Typed Codex app-server client over newline-delimited JSON-RPC on stdio.
 *
 * This module is the only Agentic Operator code that speaks the wire protocol.
 * It deliberately has no model/provider policy: callers own tenant context,
 * credentials, persistence, approvals, and sandbox selection.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import type {
  InitializeParams,
  InitializeResponse,
  ModelListParams,
  ModelListResponse,
  ServerNotification,
  ServerRequest,
  ThreadForkParams,
  ThreadItem,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsage,
  Turn,
  TurnStartParams,
  TurnStartResponse,
} from "@agentic/codex-protocol";

export type JsonRpcId = number | string;

type ParamsOf<N, M> = N extends { method: M; params: infer P } ? P : never;
export type NotificationParams<M extends ServerNotification["method"]> =
  ParamsOf<ServerNotification, M>;

export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AppServerClientOptions {
  /** Executable to launch. Defaults to CODEX_CLI_PATH, then `codex` on PATH. */
  command?: string;
  /** Prefix arguments before `app-server`; useful for `node /path/codex.js`. */
  commandArgs?: string[];
  /** CODEX_HOME for this process. It contains config, auth, and thread state. */
  codexHome: string;
  /** Trusted operator-only `-c key=value` overrides passed to app-server. */
  configOverrides?: Record<string, string>;
  /** Environment values explicitly added to the child. */
  env?: NodeJS.ProcessEnv;
  /** Explicit opt-in to the parent environment. Defaults to false. */
  inheritEnv?: boolean;
  cwd?: string;
  requestTimeoutMs?: number;
  /** Raw protocol lines can contain sensitive prompts and tool output. */
  onRawLine?: (direction: "in" | "out", line: string) => void;
  onStderr?: (line: string) => void;
}

export type ServerRequestHandler = (
  request: ServerRequest,
) => Promise<unknown> | unknown;

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

export class AppServerError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number | undefined,
    message: string,
    public readonly data?: unknown,
  ) {
    super(
      `${method}: ${message}${code === undefined ? "" : ` (code ${code})`}`,
    );
    this.name = "AppServerError";
  }
}

export class AppServerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerProtocolError";
  }
}

export class AppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly serverRequestHandlers: ServerRequestHandler[] = [];
  private closing = false;
  private exited = false;

  readonly options: Readonly<
    AppServerClientOptions & {
      inheritEnv: boolean;
      requestTimeoutMs: number;
    }
  >;

  constructor(options: AppServerClientOptions) {
    super();
    this.setMaxListeners(0);
    this.options = {
      inheritEnv: false,
      requestTimeoutMs: 120_000,
      ...options,
    };
  }

  /** Launch app-server and perform its required initialize/initialized handshake. */
  async start(params: InitializeParams): Promise<InitializeResponse> {
    if (this.process)
      throw new Error("codex app-server has already been started");
    if (this.closing || this.exited) {
      throw new Error(
        "codex app-server client cannot be restarted after close",
      );
    }

    const command =
      this.options.command ?? (process.env.CODEX_CLI_PATH?.trim() || "codex");
    const args = [...(this.options.commandArgs ?? []), "app-server"];
    for (const [key, value] of Object.entries(
      this.options.configOverrides ?? {},
    )) {
      args.push("-c", `${key}=${value}`);
    }

    const childEnv = {
      ...(this.options.inheritEnv ? process.env : {}),
      ...this.options.env,
      CODEX_HOME: this.options.codexHome,
    };
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    child.once("error", (error) => this.failProcess(error));
    child.stdin.on("error", (error) => this.failProcess(error));
    child.once("exit", (code, signal) => {
      this.exited = true;
      const exit = { code, signal } satisfies AppServerExit;
      this.failPending(
        new Error(`codex app-server exited (code=${code}, signal=${signal})`),
      );
      this.emit("exit", exit);
    });
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.onLine(line),
    );
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.options.onStderr?.(line);
      this.emit("stderr", line);
    });

    const response = await this.request<InitializeResponse>(
      "initialize",
      params,
    );
    this.notify("initialized", {});
    return response;
  }

  /** First handler returning a value resolves a server-initiated request. */
  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.push(handler);
    return () => {
      const index = this.serverRequestHandlers.indexOf(handler);
      if (index >= 0) this.serverRequestHandlers.splice(index, 1);
    };
  }

  onNotification<M extends ServerNotification["method"]>(
    method: M,
    handler: (params: NotificationParams<M>) => void,
  ): () => void {
    const wrapped = (notification: ServerNotification): void => {
      if (notification.method !== method) return;
      handler(
        (notification as unknown as { params: NotificationParams<M> }).params,
      );
    };
    this.on("notification", wrapped);
    return () => this.off("notification", wrapped);
  }

  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    if (!this.isWritable()) {
      return Promise.reject(
        new Error(`codex app-server is not running (${method})`),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppServerError(
            method,
            undefined,
            `timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        reject,
        resolve: resolve as (value: unknown) => void,
        timer,
      });
      try {
        this.send({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.isWritable()) {
      throw new Error(`codex app-server is not running (${method})`);
    }
    this.send({ method, params });
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params);
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadStartResponse> {
    return this.request("thread/resume", params);
  }

  threadFork(params: ThreadForkParams): Promise<ThreadStartResponse> {
    return this.request("thread/fork", params);
  }

  threadRead(
    threadId: string,
    includeTurns = true,
  ): Promise<ThreadReadResponse> {
    return this.request("thread/read", { threadId, includeTurns });
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request("turn/start", params);
  }

  turnInterrupt(
    threadId: string,
    turnId: string,
  ): Promise<Record<string, never>> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  turnSteer(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<{ turnId: string }> {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  modelList(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.request("model/list", params);
  }

  async runTurn(
    params: TurnStartParams,
    hooks: {
      onItem?: (item: ThreadItem, phase: "started" | "completed") => void;
      turnTimeoutMs?: number;
    } = {},
  ): Promise<TurnResult> {
    const items: ThreadItem[] = [];
    let usage: ThreadTokenUsage | null = null;
    let turnId: string | null = null;
    let cleanup = (): void => {};

    const completed = new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `codex turn timed out after ${hooks.turnTimeoutMs ?? 600_000}ms`,
          ),
        );
      }, hooks.turnTimeoutMs ?? 600_000);
      timer.unref();

      const isCurrent = (thread: string, turn: string): boolean =>
        thread === params.threadId && (turnId === null || turn === turnId);
      const offStarted = this.onNotification("item/started", (value) => {
        if (!isCurrent(value.threadId, value.turnId)) return;
        hooks.onItem?.(value.item, "started");
      });
      const offCompleted = this.onNotification("item/completed", (value) => {
        if (!isCurrent(value.threadId, value.turnId)) return;
        items.push(value.item);
        hooks.onItem?.(value.item, "completed");
      });
      const offUsage = this.onNotification(
        "thread/tokenUsage/updated",
        (value) => {
          if (value.threadId === params.threadId) usage = value.tokenUsage;
        },
      );
      const offTurn = this.onNotification("turn/completed", (value) => {
        if (!isCurrent(value.threadId, value.turn.id)) return;
        cleanup();
        resolve(value.turn);
      });
      const onExit = (): void => {
        cleanup();
        reject(new Error("codex app-server exited mid-turn"));
      };
      this.once("exit", onExit);
      cleanup = () => {
        clearTimeout(timer);
        offStarted();
        offCompleted();
        offUsage();
        offTurn();
        this.off("exit", onExit);
      };
    });

    let started: TurnStartResponse;
    try {
      started = await this.turnStart(params);
      turnId = started.turn.id;
    } catch (error) {
      cleanup();
      throw error;
    }
    const turn = await completed;
    const messages = items.filter(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage",
    );
    const finalMessage =
      [...messages]
        .reverse()
        .find((message) => message.phase === "final_answer") ?? messages.at(-1);
    return {
      turn,
      items,
      finalText: finalMessage?.text ?? null,
      usage,
    };
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child || this.exited) return;
    if (this.closing) {
      await new Promise<void>((resolve) => this.once("exit", () => resolve()));
      return;
    }
    this.closing = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        if (!this.exited) child.kill("SIGKILL");
      }, 3_000);
      forceTimer.unref();
      const fallbackTimer = setTimeout(resolve, 4_000);
      fallbackTimer.unref();
      child.once("exit", () => {
        clearTimeout(forceTimer);
        clearTimeout(fallbackTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private isWritable(): boolean {
    return Boolean(
      this.process &&
      !this.closing &&
      !this.exited &&
      this.process.stdin.writable,
    );
  }

  private send(message: unknown): void {
    const child = this.process;
    if (!child?.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }
    const line = JSON.stringify(message);
    this.options.onRawLine?.("out", line);
    child.stdin.write(`${line}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    this.options.onRawLine?.("in", line);
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("message is not an object");
      }
      message = parsed as Record<string, unknown>;
    } catch (error) {
      this.emit(
        "protocolError",
        new AppServerProtocolError(
          `invalid app-server JSON: ${String(
            error instanceof Error ? error.message : error,
          ).slice(0, 160)}`,
        ),
      );
      return;
    }

    const hasId = Object.hasOwn(message, "id");
    const hasMethod = typeof message.method === "string";
    if (hasId && !hasMethod) {
      this.handleResponse(message);
      return;
    }
    if (hasId && hasMethod) {
      void this.handleServerRequest(message as unknown as ServerRequest);
      return;
    }
    if (hasMethod) {
      this.emit("notification", message as unknown as ServerNotification);
      return;
    }
    this.emit(
      "protocolError",
      new AppServerProtocolError(
        "app-server message has neither id nor method",
      ),
    );
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    const error = message.error;
    if (error && typeof error === "object") {
      const value = error as Record<string, unknown>;
      pending.reject(
        new AppServerError(
          pending.method,
          typeof value.code === "number" ? value.code : undefined,
          typeof value.message === "string"
            ? value.message
            : "app-server request failed",
          value.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    this.emit("serverRequest", request);
    for (const handler of this.serverRequestHandlers) {
      try {
        const result = await handler(request);
        if (result !== undefined) {
          this.send({ id: request.id, result });
          return;
        }
      } catch (error) {
        this.emit("protocolError", error);
      }
    }

    const decline = defaultDecline(request);
    if (decline !== undefined) {
      this.send({ id: request.id, result: decline });
      return;
    }
    this.send({
      id: request.id,
      error: {
        code: -32601,
        message: `unsupported server request: ${request.method}`,
      },
    });
  }

  private failProcess(error: Error): void {
    this.exited = true;
    this.failPending(error);
    this.emit("protocolError", error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface TurnResult {
  turn: Turn;
  items: ThreadItem[];
  finalText: string | null;
  usage: ThreadTokenUsage | null;
}

/** Explicitly decline only request shapes whose decline response is known. */
function defaultDecline(request: ServerRequest): unknown | undefined {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "abort" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/tool/call":
      return {
        success: false,
        contentItems: [
          { type: "inputText", text: "dynamic tools are not enabled" },
        ],
      };
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      return undefined;
  }
}
