import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ChatMessage, ChatResponse } from "@agentic/llm-gateway";

const state = vi.hoisted(() => ({
  ids: 0,
  run: null as null | Record<string, unknown>,
  steps: [] as Array<Record<string, unknown>>,
  turns: [] as Array<Record<string, unknown>>,
  artifacts: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  logs: [] as string[],
  failLlmTurn: false,
  failLogEvent: "" as string,
  tables: {} as Record<string, { __table: string }>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (column: unknown) => ({ desc: column }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock("@agentic/shared", () => ({
  makeId: (prefix: string) => `${prefix}-${++state.ids}`,
}));

vi.mock("@agentic/runtime", () => ({
  logPathFor: () => "/tmp/agents-run-truth.log",
  registerStepArtifactEvidence: async (artifact: Record<string, unknown>) => {
    state.artifacts.push(artifact);
    return {
      ...artifact,
      id: `art-${state.artifacts.length}`,
      path: artifact.filePath,
      logicalName:
        String(artifact.filePath ?? "")
          .split("/")
          .at(-1) ?? "",
      contentType: "application/json",
      size: 0,
      sha256: "test",
      redacted: false,
    };
  },
  publishStreamEvent: (event: Record<string, unknown>) => {
    state.events.push(event);
  },
  writeRunLog: async (_ctx: unknown, _level: string, event: string) => {
    state.logs.push(event);
    if (state.failLogEvent === event) throw new Error(`log failed: ${event}`);
  },
}));

vi.mock("@agentic/db", () => {
  const table = (name: string) =>
    ({
      __table: name,
      id: `${name}.id`,
      slug: `${name}.slug`,
      tenantId: `${name}.tenantId`,
      agentId: `${name}.agentId`,
      workflowId: `${name}.workflowId`,
      kebabId: `${name}.kebabId`,
      versionId: `${name}.versionId`,
      target: `${name}.target`,
      status: `${name}.status`,
      deployedAt: `${name}.deployedAt`,
    }) as never;
  const tenants = table("tenants");
  const agents = table("agents");
  const agentVersions = table("agentVersions");
  const deployments = table("deployments");
  const runs = table("runs");
  const steps = table("steps");
  const workflows = table("workflows");
  const llmTurns = table("llmTurns");
  Object.assign(state.tables, {
    tenants,
    agents,
    agentVersions,
    deployments,
    runs,
    steps,
    workflows,
    llmTurns,
  });

  const db = {
    select() {
      let from: { __table: string } | undefined;
      const query = {
        from(tableValue: { __table: string }) {
          from = tableValue;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        all() {
          if (from === tenants) return [{ id: "ten-1", slug: "__system" }];
          if (from === agents) return [{ id: "agt-1" }];
          if (from === deployments) return [{ id: "agv-live" }];
          if (from === runs) return state.run ? [state.run] : [];
          return [];
        },
      };
      return query;
    },
    insert(tableValue: { __table: string }) {
      let value: Record<string, unknown>;
      return {
        values(input: Record<string, unknown>) {
          value = input;
          return this;
        },
        run() {
          if (tableValue === runs) state.run = { ...value };
          else if (tableValue === steps) state.steps.push({ ...value });
          else if (tableValue === llmTurns) {
            if (state.failLlmTurn)
              throw new Error("llm telemetry insert failed");
            state.turns.push({ ...value });
          }
        },
      };
    },
    update(tableValue: { __table: string }) {
      let patch: Record<string, unknown>;
      return {
        set(input: Record<string, unknown>) {
          patch = input;
          return this;
        },
        where() {
          return this;
        },
        run() {
          if (tableValue === runs) {
            state.run = { ...(state.run ?? {}), ...patch };
          } else if (tableValue === steps) {
            const current = state.steps.at(-1);
            if (current) Object.assign(current, patch);
          }
        },
      };
    },
  };

  return {
    agents,
    agentVersions,
    deployments,
    getDb: () => db,
    llmTurns,
    runs,
    steps,
    tenants,
    workflows,
  };
});

import { BaseAgent } from "./base-agent";
import { setGateway } from "./gateway-host";
import { RunCancelledError } from "./run-engine";

class TextAgent extends BaseAgent<void, string> {
  readonly name = "truth-agent";
  readonly description = "truth test";

  protected buildMessages(): ChatMessage[] {
    return [{ role: "user", content: "answer" }];
  }
}

class SchemaAgent extends BaseAgent<void, { ok: true }> {
  readonly name = "truth-agent";
  readonly description = "schema truth test";
  override readonly outputSchema = z.object({ ok: z.literal(true) });

  protected buildMessages(): ChatMessage[] {
    return [{ role: "user", content: "strict JSON" }];
  }
}

function response(text: string): ChatResponse {
  return {
    text,
    provider: "openai",
    model: "gpt-truth",
    tokensIn: 11,
    tokensOut: 7,
    latencyMs: 12,
    finishReason: "stop",
  };
}

let artifactRoot = "";
let originalArtifacts: string | undefined;

beforeEach(async () => {
  state.ids = 0;
  state.run = null;
  state.steps.length = 0;
  state.turns.length = 0;
  state.artifacts.length = 0;
  state.events.length = 0;
  state.logs.length = 0;
  state.failLlmTurn = false;
  state.failLogEvent = "";
  originalArtifacts = process.env.AGENTIC_ARTIFACTS_DIR;
  artifactRoot = await mkdtemp(path.join(tmpdir(), "agents-run-truth-"));
  process.env.AGENTIC_ARTIFACTS_DIR = artifactRoot;
});

afterEach(async () => {
  if (originalArtifacts === undefined) delete process.env.AGENTIC_ARTIFACTS_DIR;
  else process.env.AGENTIC_ARTIFACTS_DIR = originalArtifacts;
  if (artifactRoot !== "/dev/null") {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

const context = {
  tenantSlug: "__system",
  correlationId: "cor-truth",
};

describe.sequential("canonical code-agent execution truth", () => {
  it("refuses to overwrite the correlation of a reserved run", async () => {
    state.run = {
      id: "run-reserved",
      tenantId: "ten-1",
      agentId: "agt-1",
      agentVersionId: "agv-live",
      parentRunId: null,
      correlationId: "cor-reserved",
      status: "queued",
    };
    let calls = 0;
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        calls += 1;
        return response("done");
      },
    } as never);

    await expect(
      new TextAgent().run(undefined, {
        ...context,
        runId: "run-reserved",
        correlationId: "cor-overwrite-attempt",
      }),
    ).rejects.toThrow(/Reserved run/);
    expect(calls).toBe(0);
    expect(state.run).toMatchObject({
      correlationId: "cor-reserved",
      status: "queued",
    });
  });

  it("closes the run when the required start log cannot persist", async () => {
    let calls = 0;
    state.failLogEvent = "run.start";
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        calls += 1;
        return response("done");
      },
    } as never);

    await expect(new TextAgent().run(undefined, context)).rejects.toThrow(
      /log failed: run.start/,
    );
    expect(calls).toBe(0);
    expect(state.run).toMatchObject({ status: "failed" });
    expect(state.steps).toHaveLength(0);
  });

  it("persists provider evidence before honoring cancellation", async () => {
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        if (state.run) state.run.status = "cancelled";
        return response("done");
      },
    } as never);

    await expect(
      new TextAgent().run(undefined, context),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(state.run).toMatchObject({
      status: "cancelled",
      tokensIn: 11,
      tokensOut: 7,
      model: "gpt-truth",
    });
    expect(state.turns).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({
      status: "skipped",
      error: "cancelled_by_operator",
      provider: "openai",
      model: "gpt-truth",
    });
    expect(state.steps[0]?.inputRef).toEqual(expect.any(String));
    expect(state.steps[0]?.outputRef).toEqual(expect.any(String));
  });

  it("does not mask cancellation when the terminal cancellation log fails", async () => {
    state.failLogEvent = "run.cancelled";
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        if (state.run) state.run.status = "cancelled";
        return response("done");
      },
    } as never);

    await expect(
      new TextAgent().run(undefined, context),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(state.run).toMatchObject({
      status: "cancelled",
      errorMessage: expect.stringContaining(
        "log_persist_failed(run.cancelled)",
      ),
    });
  });

  it("does not mask the provider failure when the terminal failure log also fails", async () => {
    state.failLogEvent = "run.fail";
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        return response("   ");
      },
    } as never);

    await expect(new TextAgent().run(undefined, context)).rejects.toThrow(
      /empty response/,
    );
    expect(state.run).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("log_persist_failed(run.fail)"),
    });
  });

  it("decodes schema-validated artifacts through the same canonical contract", async () => {
    const agent = new SchemaAgent();
    await expect(
      agent._parsePersistedOutput('{"ok":true}', context),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      agent._parsePersistedOutput('{"ok":false}', context),
    ).rejects.toThrow(/no longer matches its schema/);
  });

  it("fails the run when required llm-turn telemetry cannot persist", async () => {
    state.failLlmTurn = true;
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        return response("done");
      },
    } as never);

    await expect(new TextAgent().run(undefined, context)).rejects.toThrow(
      /llm telemetry insert failed/,
    );
    expect(state.run).toMatchObject({
      status: "failed",
      tokensIn: 11,
      tokensOut: 7,
    });
    expect(state.steps[0]).toMatchObject({ status: "failed" });
    expect(state.steps[0]?.outputRef).toEqual(expect.any(String));
  });

  it("marks a schema repair failed when the repaired output is still invalid", async () => {
    const replies = [response('{"ok":false}'), response('{"ok":false}')];
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        return replies.shift()!;
      },
    } as never);

    await expect(new SchemaAgent().run(undefined, context)).rejects.toThrow(
      /output_parse_error/,
    );
    expect(state.turns).toHaveLength(2);
    expect(state.steps).toHaveLength(2);
    expect(state.steps[0]).toMatchObject({ status: "ok" });
    expect(state.steps[1]).toMatchObject({ status: "failed" });
    expect(state.steps[1]?.inputRef).toEqual(expect.any(String));
    expect(state.steps[1]?.outputRef).toEqual(expect.any(String));
    expect(
      state.events.some(
        (event) =>
          event.name === "llm.repair" &&
          event.type === "run.step.completed" &&
          event.status === "ok",
      ),
    ).toBe(false);
  });

  it("propagates artifact storage failures without calling the provider", async () => {
    let calls = 0;
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        calls += 1;
        return response("done");
      },
    } as never);
    await rm(artifactRoot, { recursive: true, force: true });
    artifactRoot = "/dev/null";
    process.env.AGENTIC_ARTIFACTS_DIR = artifactRoot;

    await expect(new TextAgent().run(undefined, context)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(state.run).toMatchObject({ status: "failed" });
    expect(state.steps[0]).toMatchObject({ status: "failed" });
  });

  it("retains llm telemetry when output artifact storage fails after the provider call", async () => {
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        // The input artifact has already been written. Replace the artifact
        // root with a regular file so only response-side persistence fails.
        await rm(artifactRoot, { recursive: true, force: true });
        await writeFile(artifactRoot, "blocked", "utf8");
        return response("done");
      },
    } as never);

    await expect(new TextAgent().run(undefined, context)).rejects.toThrow();
    expect(state.turns).toHaveLength(1);
    expect(state.run).toMatchObject({
      status: "failed",
      tokensIn: 11,
      tokensOut: 7,
    });
    expect(state.steps[0]).toMatchObject({
      status: "failed",
      provider: "openai",
      model: "gpt-truth",
      tokensIn: 11,
      tokensOut: 7,
    });
    expect(state.steps[0]?.outputRef).toBeUndefined();
  });

  it("propagates required run-log failures after preserving usage telemetry", async () => {
    state.failLogEvent = "llm.call";
    setGateway({
      defaultProvider: "openai",
      defaultModel: "gpt-truth",
      async chat() {
        return response("done");
      },
    } as never);

    await expect(new TextAgent().run(undefined, context)).rejects.toThrow(
      /log failed: llm.call/,
    );
    expect(state.turns).toHaveLength(1);
    expect(state.run).toMatchObject({
      status: "failed",
      tokensIn: 11,
      tokensOut: 7,
    });
    expect(state.steps[0]).toMatchObject({ status: "failed" });
  });
});
