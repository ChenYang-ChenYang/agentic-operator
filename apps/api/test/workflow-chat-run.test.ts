/**
 * Chat continuity for the workflow draft test run.
 *
 * The load-bearing test here is "replays prior turns into the second call".
 * `executeAgent` calls BOTH `prepareAgentExecution` and `runAction`, but only
 * the latter's compiled messages reach the model — the former's result is
 * consumed solely as `prepared.inputs`. Wiring conversationHistory into the
 * wrong one type-checks, ships, and silently does nothing. This test is what
 * catches that.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CreateWorkflowBodySchema,
  WorkflowTestRunBodySchema,
} from "@agentic/contracts";
import { getDb, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { LLMGateway, type ProviderAdapter } from "@agentic/llm-gateway";
import { setRuntimeGateway } from "@agentic/runtime";
import type { ChatMessage } from "@agentic/llm-gateway";
import { createWorkflowDraft } from "../src/services/workflow-authoring";
import { instantiateBlankWorkflow } from "../src/services/workflow-templates";
import { runWorkflowDraftTest } from "../src/services/workflow-test-runner";
import { _setLLMGatewayForTests } from "../src/services/llm";
import { MAX_CONVERSATION_HISTORY_MESSAGES } from "../src/services/conversation-history";

const suffix = Date.now().toString(36).slice(-8);
const tenantSlug = `wf-chat-${suffix}`;
const tenantId = makeId("ten");
const ctx = {
  tenantId,
  tenantSlug,
  userId: null,
} as unknown as Parameters<typeof runWorkflowDraftTest>[2];

/** Every `messages` array the gateway was asked to complete, in order. */
let captured: ChatMessage[][] = [];

function captureGateway(reply: string): LLMGateway {
  const adapter: ProviderAdapter = {
    id: "custom",
    name: "Workflow chat capture provider",
    hasKey: true,
    defaultModel: "workflow-chat-test-model",
    async chat(request) {
      captured.push(request.messages as ChatMessage[]);
      return {
        text: JSON.stringify({ reply }),
        provider: "custom",
        model: "workflow-chat-test-model",
        tokensIn: 1,
        tokensOut: 1,
        raw: {},
      } as never;
    },
  };
  const gateway = new LLMGateway({
    defaultProvider: "custom",
    defaultModel: "workflow-chat-test-model",
    timeoutMs: 5_000,
  });
  gateway.registerProvider(adapter);
  // The step engine resolves its own gateway (setRuntimeGateway), which
  // apps/api wires at bootstrap; the api-side _setLLMGatewayForTests only
  // covers validation. Both must point at the capture adapter.
  setRuntimeGateway(gateway as never);
  return gateway;
}

function bodyFor(
  manifest: unknown,
  triggerEvent: string,
  prompt: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
) {
  return WorkflowTestRunBodySchema.parse({
    manifest,
    triggerEvent,
    inputs: { prompt },
    payload: {},
    toolPolicy: "safe",
    conversationHistory,
  });
}

beforeAll(() => {
  getDb()
    .insert(tenants)
    .values({ id: tenantId, slug: tenantSlug, name: "Workflow chat" })
    .run();
});

afterAll(() => {
  _setLLMGatewayForTests(null);
  getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
});

describe("workflow draft chat continuity", () => {
  it("defaults conversationHistory to an empty array for existing callers", () => {
    const parsed = WorkflowTestRunBodySchema.parse({
      manifest: { $schemaVersion: 2, agents: [] },
      triggerEvent: "ANYTHING",
    });
    expect(parsed.conversationHistory).toEqual([]);
  });

  it("caps history at the shared message budget", () => {
    const overLimit = Array.from(
      { length: MAX_CONVERSATION_HISTORY_MESSAGES + 5 },
      (_, index) => ({ role: "user" as const, content: `turn ${index}` }),
    );
    expect(() =>
      WorkflowTestRunBodySchema.parse({
        manifest: { $schemaVersion: 2, agents: [] },
        triggerEvent: "ANYTHING",
        conversationHistory: overLimit,
      }),
    ).toThrow();
  });

  it("replays prior turns into the second call, between system and user", async () => {
    const slug = `chat-${suffix}`;
    const created = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug,
        name: "Chat starter",
        source: { type: "blank" },
        model: { provider: "custom", model: "workflow-chat-test-model" },
      }),
      ctx,
    );
    const manifest = created.manifest;
    const trigger = manifest.agents[0]!.trigger[0]!;

    captured = [];
    _setLLMGatewayForTests(captureGateway("Long answer."));
    const first = await runWorkflowDraftTest(
      slug,
      bodyFor(manifest, trigger, "Explain invoices.", []),
      ctx,
    );
    expect(first.status).toBe("ok");
    // Turn 1 carries no history at all.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);

    captured = [];
    _setLLMGatewayForTests(captureGateway("Short answer."));
    await runWorkflowDraftTest(
      slug,
      bodyFor(manifest, trigger, "Shorter.", [
        { role: "user", content: "Explain invoices." },
        { role: "assistant", content: "Long answer." },
      ]),
      ctx,
    );
    expect(captured).toHaveLength(1);
    const second = captured[0]!;
    expect(second.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(second[1]!.content).toContain("Explain invoices.");
    expect(second[2]!.content).toContain("Long answer.");
    expect(second[3]!.content).toContain("Shorter.");
    // The system prompt keeps its place at the head of the window.
    expect(second[0]!.content).toContain("Hi, I am your AI Agent");
  });

  it("gives history only to the agents that listen to the trigger event", async () => {
    const slug = `chain-${suffix}`;
    const base = instantiateBlankWorkflow({ slug });
    const first = base.agents[0]!;
    const handoff = first.triggered_event[0]!;
    // A second agent downstream of the first, triggered by its completion
    // event. It must NOT receive the human transcript: it can fan out per item
    // and is answering agent 1's output, not the person.
    const downstream = {
      ...structuredClone(first),
      id: "downstream-agent",
      name: "downstreamAgent",
      title: "Downstream agent",
      trigger: [handoff],
      triggered_event: [`${handoff}_DONE`],
      output_bindings: { [`${handoff}_DONE`]: { reply: { output: "reply" } } },
      extensions: { canvas: { position: { x: 380, y: 120 } } },
    };
    const manifest = {
      ...base,
      agents: [first, downstream],
    } as typeof base;

    createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug,
        name: "Chain starter",
        source: { type: "manifest", manifest },
        model: { provider: "custom", model: "workflow-chat-test-model" },
      }),
      ctx,
    );

    captured = [];
    _setLLMGatewayForTests(captureGateway("Chained."));
    await runWorkflowDraftTest(
      slug,
      bodyFor(manifest, first.trigger[0]!, "Kick it off.", [
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
      ]),
      ctx,
    );

    expect(captured.length).toBeGreaterThanOrEqual(2);
    const [entryMessages, downstreamMessages] = captured;
    expect(entryMessages!.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    // depth > 0 — no transcript.
    expect(downstreamMessages!.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
  });
});
