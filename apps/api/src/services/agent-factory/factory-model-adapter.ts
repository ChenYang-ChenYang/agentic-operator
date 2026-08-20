import {
  setFactoryModelAdapter,
  type ChatMsg as FactoryChatMessage,
  type FactoryModelAdapterInput,
  type FactoryModelAdapterResult,
} from "@agentic/agent-factory";
import type {
  ChatContentBlock,
  ChatMessage,
  LLMGateway,
  ToolDef,
} from "@agentic/llm-gateway";

type GatewayChat = Pick<LLMGateway, "chat">;

function parseToolArguments(
  call: NonNullable<FactoryChatMessage["tool_calls"]>[number],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error(
      `Factory assistant tool call ${call.id} (${call.function.name}) contains invalid JSON arguments`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Factory assistant tool call ${call.id} (${call.function.name}) arguments must be a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

export function mapFactoryMessages(
  messages: FactoryChatMessage[],
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const blocks: ChatContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call),
        });
      }
      return {
        role: "assistant",
        content: blocks,
        ...(message.reasoning_content
          ? { reasoningContent: message.reasoning_content }
          : {}),
      };
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) {
        throw new Error("Factory tool result is missing tool_call_id");
      }
      return {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: message.content ?? "",
          },
        ],
      };
    }
    return {
      role: message.role,
      content: message.content ?? "",
      ...(message.role === "assistant" && message.reasoning_content
        ? { reasoningContent: message.reasoning_content }
        : {}),
    };
  });
}

function mapFactoryTools(input: FactoryModelAdapterInput): ToolDef[] {
  return input.tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description
      ? { description: tool.function.description }
      : {}),
    input_schema: tool.function.parameters,
  }));
}

export function createFactoryModelAdapter(
  gateway: GatewayChat,
): (input: FactoryModelAdapterInput) => Promise<FactoryModelAdapterResult> {
  return async (input) => {
    const tenantId = input.context.tenantId?.trim();
    if (!tenantId) {
      throw new Error(
        "Agent Factory model call is missing tenantId; refusing an unscoped central-gateway request",
      );
    }
    const purpose = input.purpose?.trim() || "brain.turn";
    const response = await gateway.chat({
      tenantId,
      ...(input.context.tenantSlug
        ? { tenantSlug: input.context.tenantSlug }
        : {}),
      purpose: `agent-factory:${purpose}`,
      routing: {
        taskType: "factory.brain",
        parameterPrecedence: "request",
        // Task-difficulty routing crosses this seam as a PREFERENCE, never as
        // `model`/`provider`. The tenant's routing policy still decides which
        // routes exist; the preference only ranks the ones it already allows,
        // so a process-wide Factory setting cannot escape the tenant boundary.
        ...(input.requestedModels?.length
          ? { modelPreference: input.requestedModels }
          : {}),
        ...(input.requestedTier ? { modelPreferenceTier: input.requestedTier } : {}),
      },
      // Do not manufacture a normalized provider-storage control here.
      // Responses transports default to `store:false` inside the gateway;
      // Chat Completions exposes no equivalent flag and correctly rejects
      // even an explicit `false`. Tenant routing remains authoritative for
      // any provider-specific storage policy it can actually enforce.
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.maxTokens === "number"
        ? { maxTokens: input.maxTokens }
        : {}),
      messages: mapFactoryMessages(input.messages),
      ...(input.tools.length ? { tools: mapFactoryTools(input) } : {}),
      attribution: {
        product: "ontocode",
        productSurface: "agent-factory",
        productAction: purpose,
        ...(input.context.conversationId
          ? { interactionId: input.context.conversationId }
          : {}),
        // `ChatRequest.runId` is a foreign key to the canonical runtime
        // `runs` table. Agent Factory executions live in `factory_runs`, so
        // forwarding their id as `runId` makes durable accounting fail before
        // the provider is called. Keep the Factory execution queryable without
        // pretending it is a runtime run; the Factory event stream still
        // carries the same id as its first-class `factoryRunId`.
        ...(input.context.factoryRunId
          ? { correlationId: input.context.factoryRunId }
          : {}),
        invocationSource: "agent-factory",
        functionName: "runBrain",
      },
    });
    if (
      response.provider === "mock" ||
      /(^|[\s/_-])mock([\s/_-]|$)/iu.test(response.model)
    ) {
      throw new Error(
        "Agent Factory refuses mock LLM output; configure a real tenant factory.brain route",
      );
    }
    return {
      text: response.text,
      provider: response.provider,
      model: response.model,
      ...(response.routing?.effectiveRoute
        ? { route: response.routing.effectiveRoute }
        : {}),
      // Hand the difficulty verdict back to the caller so an unmet preference
      // shows up on the turn receipt instead of looking like a normal turn.
      ...(input.requestedModels?.length &&
      response.routing?.modelPreferenceSatisfied !== undefined
        ? {
            preference: {
              requested: input.requestedModels,
              satisfied: response.routing.modelPreferenceSatisfied,
              reason: response.routing.modelPreferenceReason ?? "",
            },
          }
        : {}),
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      finishReason: response.finishReason,
      ...(response.reasoningContent
        ? { reasoningContent: response.reasoningContent }
        : {}),
      ...(response.toolCalls?.length
        ? {
            toolCalls: response.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          }
        : {}),
    };
  };
}

export function installFactoryModelAdapter(gateway: GatewayChat): void {
  setFactoryModelAdapter(createFactoryModelAdapter(gateway));
}
