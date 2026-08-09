/**
 * Agent Studio history and observability read surfaces.
 *
 * Seeds persisted rows directly, then verifies the HTTP contracts, stable
 * cursor ordering, artifact loading, and cross-tenant non-disclosure. The
 * execution/dispatch path has separate runtime coverage and does not need a
 * live Inngest dev server here.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  GetRunSessionResponseSchema,
  GetRunResponse,
  GetRunTraceResponseSchema,
  ListAgentRunsResponseSchema,
  RunOutputResponseSchema,
} from "@agentic/contracts";
import {
  agentRunSessions,
  agents,
  artifacts,
  getDb,
  llmCalls,
  runMessages,
  runs,
  runTraceEvents,
  steps,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = Date.now().toString(36).slice(-8);
const TENANT_A = `hist-${SUFFIX}-a`.slice(0, 32);
const TENANT_B = `hist-${SUFFIX}-b`.slice(0, 32);
const tenantAId = makeId("ten");
const tenantBId = makeId("ten");
const workflowId = makeId("wf");
const agentId = makeId("agt");
const sessionId = makeId("ars");
const runNewestId = `run-hist-z-${SUFFIX}`;
const runOlderId = `run-hist-a-${SUFFIX}`;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe("Agent Studio history routes", () => {
  let env: TestEnv;
  let outputDir: string;
  let outputPath: string;
  const queuedAt = new Date("2026-07-15T01:02:03.000Z");

  beforeAll(async () => {
    outputDir = await mkdtemp(path.join(os.tmpdir(), "agent-studio-history-"));
    outputPath = path.join(outputDir, "output.json");
    const output = { result: { summary: "Persisted Studio result" } };
    const serialized = JSON.stringify(output, null, 2);
    await writeFile(outputPath, serialized, "utf8");

    const db = getDb();
    db.insert(tenants)
      .values([
        { id: tenantAId, slug: TENANT_A, name: "History test A" },
        { id: tenantBId, slug: TENANT_B, name: "History test B" },
      ])
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId: tenantAId,
        slug: `${TENANT_A}-default`,
        name: "Studio history workflow",
      })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        tenantId: tenantAId,
        workflowId,
        kebabId: `history-agent-${SUFFIX}`,
        name: `historyAgent${SUFFIX}`,
        title: "History Agent",
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        lifecycle: "active",
        createdAt: queuedAt,
        updatedAt: queuedAt,
      })
      .run();
    db.insert(agentRunSessions)
      .values({
        id: sessionId,
        tenantId: tenantAId,
        agentId,
        title: "Trace this run",
        createdAt: queuedAt,
        updatedAt: queuedAt,
        lastRunAt: queuedAt,
      })
      .run();
    db.insert(runs)
      .values([
        {
          id: runNewestId,
          tenantId: tenantAId,
          agentId,
          sessionId,
          status: "ok",
          queuedAt,
          startedAt: queuedAt,
          endedAt: new Date(queuedAt.getTime() + 125),
          durationMs: 125,
          tokensIn: 12,
          tokensOut: 7,
          provider: "mock",
          model: "mock-model-v1",
          correlationId: `cor-${SUFFIX}-z`,
          invocationSource: "studio",
          definitionHash: "sha256:newest",
          outputValid: true,
          sideEffectMode: "safe",
          isTest: true,
        },
        {
          id: runOlderId,
          tenantId: tenantAId,
          agentId,
          sessionId,
          status: "failed",
          // Same timestamp deliberately exercises the id tie-break cursor.
          queuedAt,
          startedAt: queuedAt,
          endedAt: new Date(queuedAt.getTime() + 50),
          durationMs: 50,
          correlationId: `cor-${SUFFIX}-a`,
          invocationSource: "studio",
          definitionHash: "sha256:older",
          outputValid: false,
          sideEffectMode: "suppressed",
          errorMessage: "expected test failure",
          isTest: true,
        },
      ])
      .run();
    db.insert(runMessages)
      .values([
        {
          id: makeId("msg"),
          tenantId: tenantAId,
          sessionId,
          runId: runNewestId,
          ord: 1,
          role: "user",
          contentJson: {
            prompt: "Summarize   this profile\nfor the operator.",
            inputs: { profile: { id: "p-1" } },
          },
        },
        {
          id: makeId("msg"),
          tenantId: tenantAId,
          sessionId,
          runId: runOlderId,
          ord: 2,
          role: "user",
          contentJson: { prompt: "Older attempt", inputs: {} },
        },
        {
          id: makeId("msg"),
          tenantId: tenantAId,
          sessionId,
          runId: runNewestId,
          ord: 3,
          role: "user",
          contentJson: {
            prompt: "A later message must not duplicate this run in history.",
            inputs: {},
          },
        },
      ])
      .run();
    db.insert(llmCalls)
      .values([
        {
          id: makeId("llm"),
          logicalCallId: `logical-${SUFFIX}-priced`,
          tenantId: tenantAId,
          runId: runNewestId,
          provider: "mock",
          requestedModel: "mock-model-v1",
          responseModel: "mock-model-v1",
          attempt: 1,
          status: "ok",
          inputTokens: 10,
          outputTokens: 6,
          cachedInputTokens: 2,
          reasoningTokens: 1,
          costUsdNanos: 123_456,
          startedAt: new Date(queuedAt.getTime() + 20),
          endedAt: new Date(queuedAt.getTime() + 80),
        },
        {
          id: makeId("llm"),
          logicalCallId: `logical-${SUFFIX}-failed`,
          tenantId: tenantAId,
          runId: runNewestId,
          provider: "mock",
          requestedModel: "mock-model-v1",
          attempt: 1,
          status: "failed",
          startedAt: new Date(queuedAt.getTime() + 10),
          endedAt: new Date(queuedAt.getTime() + 15),
          errorCode: "provider_error",
        },
      ])
      .run();
    db.insert(steps)
      .values({
        id: makeId("stp"),
        runId: runNewestId,
        ord: 1,
        name: "produceResult",
        type: "logic",
        status: "ok",
        startedAt: queuedAt,
        endedAt: new Date(queuedAt.getTime() + 100),
        durationMs: 100,
        inputRef: "/artifacts/input.json",
        outputRef: "/artifacts/output.json",
        provider: "mock",
        model: "mock-model-v1",
        tokensIn: 12,
        tokensOut: 7,
      })
      .run();
    db.insert(runTraceEvents)
      .values([
        {
          id: makeId("trc"),
          tenantId: tenantAId,
          runId: runNewestId,
          seq: 1,
          kind: "run",
          level: "minimal",
          name: "run.started",
          status: "running",
          summary: "Started",
          visibility: "user",
        },
        {
          id: makeId("trc"),
          tenantId: tenantAId,
          runId: runNewestId,
          seq: 2,
          kind: "output_validation",
          level: "standard",
          name: "output.validation",
          status: "ok",
          summary: "Output valid",
          dataJson: { valid: true },
          visibility: "user",
        },
      ])
      .run();
    db.insert(artifacts)
      .values({
        id: makeId("art"),
        tenantId: tenantAId,
        runId: runNewestId,
        kind: "application/json",
        role: "output",
        logicalName: "output.json",
        contentType: "application/json",
        path: outputPath,
        size: Buffer.byteLength(serialized),
      })
      .run();

    env = await buildTestEnv();
  });

  afterAll(async () => {
    const db = getDb();
    db.delete(runs)
      .where(and(eq(runs.tenantId, tenantAId), eq(runs.agentId, agentId)))
      .run();
    db.delete(tenants).where(eq(tenants.id, tenantAId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantBId)).run();
    await rm(outputDir, { recursive: true, force: true });
  });

  it("paginates deterministically when queued timestamps are equal", async () => {
    const first = await env.fetch(`/v1/agents/${agentId}/runs?limit=1`, {
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Envelope<unknown>;
    const firstPage = ListAgentRunsResponseSchema.parse(firstBody.data);
    expect(firstPage.runs.map((run) => run.id)).toEqual([runNewestId]);
    expect(firstPage.runs[0]?.promptPreview).toBe(
      "Summarize this profile for the operator.",
    );
    expect(firstPage.nextCursor).toBe(runNewestId);

    const second = await env.fetch(
      `/v1/agents/${agentId}/runs?limit=1&cursor=${runNewestId}`,
      { headers: { "x-agentic-tenant": TENANT_A } },
    );
    const secondBody = (await second.json()) as Envelope<unknown>;
    const secondPage = ListAgentRunsResponseSchema.parse(secondBody.data);
    expect(secondPage.runs.map((run) => run.id)).toEqual([runOlderId]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("reconstructs one session without injecting prior messages into runs", async () => {
    const res = await env.fetch(`/v1/run-sessions/${sessionId}`, {
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    const session = GetRunSessionResponseSchema.parse(body.data);
    expect(session.session.id).toBe(sessionId);
    expect(session.messages.map((message) => message.ord)).toEqual([1, 2, 3]);
    expect(session.runs.map((run) => run.id)).toEqual([
      runNewestId,
      runOlderId,
    ]);
  });

  it("returns ordered trace pages and the persisted JSON output", async () => {
    const traceRes = await env.fetch(
      `/v1/runs/${runNewestId}/trace?after=1&limit=10`,
      { headers: { "x-agentic-tenant": TENANT_A } },
    );
    expect(traceRes.status).toBe(200);
    const traceBody = (await traceRes.json()) as Envelope<unknown>;
    const trace = GetRunTraceResponseSchema.parse(traceBody.data);
    expect(trace.events.map((event) => event.seq)).toEqual([2]);
    expect(trace.events[0]?.data).toEqual({ valid: true });

    const outputRes = await env.fetch(`/v1/runs/${runNewestId}/output`, {
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(outputRes.status).toBe(200);
    const outputBody = (await outputRes.json()) as Envelope<unknown>;
    const output = RunOutputResponseSchema.parse(outputBody.data);
    expect(output.status).toBe("ok");
    expect(output.outputValid).toBe(true);
    expect(output.output).toEqual({
      result: { summary: "Persisted Studio result" },
    });
    expect(output.artifact?.logicalName).toBe("output.json");
  });

  it("enriches the shared run detail with Studio pinning and step artifact refs", async () => {
    const res = await env.fetch(`/v1/runs/${runNewestId}`, {
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    const detail = GetRunResponse.parse(body.data);
    expect(detail.run).toMatchObject({
      id: runNewestId,
      sessionId,
      invocationSource: "studio",
      definitionHash: "sha256:newest",
      outputValid: true,
      sideEffectMode: "safe",
      provider: "mock",
    });
    expect(detail.run.queuedAt).toEqual(queuedAt);
    expect(detail.steps[0]).toMatchObject({
      inputRef: "/artifacts/input.json",
      outputRef: "/artifacts/output.json",
    });
    expect(detail.usage).toEqual({
      logicalCalls: 2,
      attempts: 2,
      succeeded: 1,
      failed: 1,
      inFlight: 0,
      tokensIn: 10,
      tokensOut: 6,
      cachedInputTokens: 2,
      reasoningTokens: 1,
      costUsdNanos: 123_456,
      pricedCalls: 1,
      unpricedCalls: 0,
      providers: ["mock"],
      models: ["mock-model-v1"],
      latestProvider: "mock",
      latestModel: "mock-model-v1",
    });
  });

  it("routes Studio replay through persisted inputs instead of event replay", async () => {
    const res = await env.fetch(`/v1/runs/${runOlderId}/replay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({ version: "same" }),
    });
    // This fixture deliberately has no input artifact. Reaching the Studio-
    // specific 410 proves the route did not fall into legacy `no_trigger`.
    expect(res.status).toBe(410);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.error?.code).toBe("replay_input_missing");
  });

  it("does not disclose run/session/trace/output rows across tenants", async () => {
    for (const url of [
      `/v1/agents/${agentId}/runs`,
      `/v1/run-sessions/${sessionId}`,
      `/v1/runs/${runNewestId}/trace`,
      `/v1/runs/${runNewestId}/output`,
    ]) {
      const res = await env.fetch(url, {
        headers: { "x-agentic-tenant": TENANT_B },
      });
      expect(res.status, url).toBe(404);
      const body = (await res.json()) as Envelope<unknown>;
      expect(body.error?.code, url).toBe("not_found");
    }
  });
});
