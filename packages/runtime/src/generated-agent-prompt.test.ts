import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import type {
  ChatRequest,
  ChatResponse,
  LLMGateway,
} from "@agentic/llm-gateway";
import { getRuntimeGateway, setRuntimeGateway } from "./llm-host";
import { runAction } from "./step-engine";

const previousGateway = getRuntimeGateway();
let request: ChatRequest | undefined;

const gateway = {
  async chat(input: ChatRequest): Promise<ChatResponse> {
    request = structuredClone(input);
    return {
      text: JSON.stringify({ match_found: true }),
      provider: input.provider ?? "mock",
      model: input.model ?? "unknown",
      tokensIn: 5,
      tokensOut: 4,
      finishReason: "stop",
      latencyMs: 1,
    };
  },
} as unknown as LLMGateway;

beforeEach(() => {
  request = undefined;
  setRuntimeGateway(gateway);
});

after(() => {
  if (previousGateway) setRuntimeGateway(previousGateway);
});

/**
 * The ontology compiler writes an action's full rubric — including the
 * fail-closed output contract that names every permitted top-level key — into
 * `action_prompt`, while `description` stays a one-line objective. A compiled
 * agent carries no hand-written tenant prompt, so the default generated-agent
 * user turn is the ONLY place that contract can reach the model. Dropping it
 * does not fail the run: the model answers with a self-invented schema, every
 * downstream conditional emission reads an absent key, and the business chain
 * stops while the run still reports ok.
 */
const OUTPUT_CONTRACT = [
  "输出契约（硬性）：仅输出一个 JSON 对象，不得输出任何其他文本。",
  "顶层键必须且只能是：`match_found`、`suspend` —— 不得增删、不得改名。",
].join("\n");

function v1GeneratedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "compiled-ontology-agent",
    name: "action-match-dormant-stock",
    description: "跨法人单位识别呆滞批次。",
    actor: ["Agent"] as Array<"Agent" | "Human">,
    trigger: ["PSCM_REQUISITION_SUBMITTED"],
    actions: [],
    triggered_event: ["PSCM_DORMANT_MATCH_FOUND"],
    generated: true,
    ontology_instructions: "按绑定规则判定。",
    tool_use: [],
    provider: "mock" as const,
    model: "mock-model",
    ...overrides,
  };
}

const logicAction = {
  order: "1",
  name: "analyze",
  description: "跨法人单位识别呆滞批次。",
  action_prompt: `跨法人单位识别呆滞批次。\n\n${OUTPUT_CONTRACT}`,
  type: "logic" as const,
};

describe("generated-agent default prompt carries the authored contract", () => {
  it("puts the v1 agent's action_prompt in the user turn, not just the description", async () => {
    const result = await runAction({
      ctx: {
        agentName: "action-match-dormant-stock",
        actionName: "analyze",
        correlationId: "cor-generated-contract",
        tenantSlug: "power-scm",
        event: {
          name: "power-scm/PSCM_REQUISITION_SUBMITTED",
          data: { requisition: { requisition_id: "REQ-1" } },
        },
      },
      action: logicAction,
      agent: v1GeneratedAgent(),
    });

    assert.equal(result.ok, true);
    const userTurn = String(
      request?.messages?.find((message) => message.role === "user")?.content ??
        "",
    );
    assert.ok(
      userTurn.includes("输出契约（硬性）"),
      "the authored output contract must reach the model",
    );
    assert.ok(
      userTurn.includes("顶层键必须且只能是"),
      "the hard key enumeration must reach the model",
    );
  });

  it("falls back to the description when the action has no action_prompt", async () => {
    const { action_prompt: _omitted, ...withoutPrompt } = logicAction;
    const result = await runAction({
      ctx: {
        agentName: "action-match-dormant-stock",
        actionName: "analyze",
        correlationId: "cor-generated-fallback",
        tenantSlug: "power-scm",
        event: { name: "power-scm/PSCM_REQUISITION_SUBMITTED", data: {} },
      },
      action: withoutPrompt,
      agent: v1GeneratedAgent(),
    });

    assert.equal(result.ok, true);
    const userTurn = String(
      request?.messages?.find((message) => message.role === "user")?.content ??
        "",
    );
    assert.ok(userTurn.includes("Action objective: 跨法人单位识别呆滞批次。"));
    assert.ok(!userTurn.includes("输出契约"));
  });

  it("leaves a hand-authored tenant prompt in control", async () => {
    const result = await runAction({
      ctx: {
        agentName: "action-match-dormant-stock",
        actionName: "analyze",
        correlationId: "cor-generated-tenant-prompt",
        tenantSlug: "power-scm",
        event: { name: "power-scm/PSCM_REQUISITION_SUBMITTED", data: {} },
      },
      action: logicAction,
      agent: v1GeneratedAgent(),
      tenantRegistry: {
        prompts: {
          analyze: {
            kind: "prompt",
            name: "analyze",
            template: () => "TENANT AUTHORED PROMPT",
          },
        },
      },
    });

    assert.equal(result.ok, true);
    const userTurn = String(
      request?.messages?.find((message) => message.role === "user")?.content ??
        "",
    );
    assert.equal(userTurn, "TENANT AUTHORED PROMPT");
  });

  // The v2 counterpart — an action-context block that keeps the short
  // description because v2 surfaces action_prompt through the system message —
  // is asserted in step-engine-v2.test.ts ("sends the Studio prompt as a real
  // user role..."), which is what catches an over-broad change to this branch.
});
