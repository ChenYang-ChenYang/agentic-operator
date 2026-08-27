import { describe, expect, it } from "vitest";
import type { WorkflowRunInputDescriptor } from "@agentic/contracts";
import {
  buildWorkflowPayloadGuide,
  buildWorkflowEventPayload,
  deriveWorkflowEntrypoints,
  parseWorkflowTestLimits,
  seedWorkflowInputValue,
  seedWorkflowPromptValue,
  validateWorkflowInputValues,
  workflowInputControl,
  workflowInputExampleValue,
  workflowInputSchemaSummary,
} from "./workflow-runner";

const promptPort = {
  id: "prompt",
  label: "Request",
  kind: "prompt" as const,
  required: true,
  schema: { type: "string", minLength: 1 },
  sensitivity: "none" as const,
};

function agent(
  id: string,
  trigger: string[],
  emitted: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    title: id,
    description: "Test agent",
    actor: ["Agent"],
    trigger,
    inputs: [promptPort],
    ontology_instructions:
      "Role mission inputs procedure tool policy output contract completion criteria safety privacy non-fabrication error recovery human escalation.",
    generated: true,
    tool_use: [],
    actions: [
      {
        order: "1",
        name: "execute",
        description: "Execute",
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "result",
        required: true,
        schema: { type: "string" },
        sensitivity: "none",
      },
    ],
    triggered_event: emitted,
    provider: "mock",
    model: "mock-model-v1",
    ...overrides,
  };
}

describe("workflow Run Console model", () => {
  it("recommends external triggers and retains internal branch entrypoints", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("intake", ["CASE_OPENED"], ["CASE_TRIAGED"]),
        agent("triage", ["CASE_TRIAGED"], ["CASE_DONE"]),
      ],
    });

    expect(result.entrypoints.map((entrypoint) => entrypoint.event)).toEqual([
      "CASE_OPENED",
      "CASE_TRIAGED",
    ]);
    expect(result.entrypoints[0]).toMatchObject({
      source: "external",
      recommended: true,
      listenerAgentIds: ["intake"],
    });
    expect(result.entrypoints[1]).toMatchObject({
      source: "internal",
      recommended: false,
    });
  });

  it("merges shared inputs and identifies conflicting listener contracts", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("alpha", ["START"], [], {
          inputs: [promptPort],
        }),
        agent("beta", ["START"], [], {
          inputs: [
            {
              ...promptPort,
              schema: { type: "string", maxLength: 10 },
            },
          ],
        }),
      ],
    });

    expect(result.entrypoints[0]?.inputs[0]).toMatchObject({
      id: "prompt",
      consumers: ["alpha", "beta"],
      conflict: true,
    });
    expect(
      validateWorkflowInputValues(result.entrypoints[0], {
        prompt: "hello",
      }),
    ).toContain(
      "Request has conflicting listener schemas; verify the raw event payload.",
    );
  });

  it("selects controls and seeds values from schemas", () => {
    const input = {
      id: "priority",
      label: "Priority",
      description: null,
      kind: "value" as const,
      required: true,
      schema: { type: "string", enum: ["normal", "urgent"] },
      sensitivity: "none" as const,
      consumers: ["agent"],
      bindings: [{ agentId: "agent", mode: "direct" as const }],
      conflict: false,
    };
    expect(workflowInputControl(input)).toBe("select");
    expect(seedWorkflowInputValue(input)).toBe("normal");
    expect(workflowInputExampleValue(input)).toBe("normal");
    expect(workflowInputSchemaSummary(input)).toBe("enum · normal | urgent");
  });

  it("builds a schema-guided example for path and template bindings", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("triage", ["SUPPORT_REQUESTED"], [], {
          trigger_bindings: {
            SUPPORT_REQUESTED: {
              prompt: {
                template: "Triage support request {{event.request_id}}.",
              },
              request_id: { path: "$.request_id" },
              customer_message: { path: "$.case.message" },
              priority_hint: { path: "$.priority_hint" },
            },
          },
          inputs: [
            promptPort,
            {
              id: "request_id",
              label: "Request ID",
              kind: "value",
              required: true,
              schema: { type: "string", minLength: 1 },
              sensitivity: "none",
            },
            {
              id: "customer_message",
              label: "Customer message",
              kind: "value",
              required: true,
              schema: { type: "string", minLength: 1 },
              sensitivity: "personal",
            },
            {
              id: "priority_hint",
              label: "Priority hint",
              kind: "value",
              required: true,
              schema: { type: "string", enum: ["normal", "urgent"] },
              sensitivity: "none",
            },
          ],
        }),
      ],
    });

    const guide = buildWorkflowPayloadGuide(result.entrypoints[0]!);
    expect(guide.inputValues).toMatchObject({
      request_id: "REQ-2026-001",
      priority_hint: "normal",
    });
    expect(guide.inputValues).not.toHaveProperty("prompt");
    expect(guide.rawPayload).toEqual({
      request_id: "REQ-2026-001",
      case: {
        message:
          "I was charged twice for invoice INV-2048. Please review the duplicate charge.",
      },
      priority_hint: "normal",
    });
    expect(guide.eventPayload.inputs).toEqual(guide.inputValues);
    expect(
      guide.fields.find((field) => field.inputId === "request_id"),
    ).toMatchObject({
      type: "string",
      locations: ["$.request_id"],
      example: "REQ-2026-001",
      exampleSource: "schema generated",
    });
    expect(
      guide.fields.find((field) => field.inputId === "prompt"),
    ).toMatchObject({
      required: false,
      runtimeProvided: true,
      locations: ["template reads $.request_id"],
      example: "Triage support request REQ-2026-001.",
      exampleSource: "binding generated",
    });
  });

  it("turns a whole-event object binding into a useful raw payload example", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("intake", ["CASE_OPENED"], [], {
          trigger_bindings: {
            CASE_OPENED: {
              payload: { path: "$" },
            },
          },
          inputs: [
            {
              id: "payload",
              label: "Event payload",
              description: "Complete caller-provided event data.",
              kind: "value",
              required: true,
              schema: {
                type: "object",
                required: ["case_id", "amount"],
                properties: {
                  case_id: { type: "string" },
                  amount: { type: "number", minimum: 1 },
                },
                additionalProperties: false,
              },
              default: {},
              sensitivity: "confidential",
            },
          ],
        }),
      ],
    });

    const guide = buildWorkflowPayloadGuide(result.entrypoints[0]!);
    expect(guide.rawPayload).toEqual({
      case_id: "CASE-2026-001",
      amount: 1,
    });
    expect(guide.eventPayload).toMatchObject({
      case_id: "CASE-2026-001",
      amount: 1,
      inputs: {
        payload: {
          case_id: "CASE-2026-001",
          amount: 1,
        },
      },
    });
    expect(guide.fields[0]).toMatchObject({
      locations: ["$"],
      type: "object",
      sensitivity: "confidential",
    });
  });

  it("preserves file policy and validates bounded test limits", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("documents", ["DOCUMENT_RECEIVED"], [], {
          inputs: [
            promptPort,
            {
              id: "documents",
              label: "Documents",
              kind: "file",
              required: true,
              schema: { type: "array" },
              sensitivity: "confidential",
              file: {
                media_types: ["application/pdf"],
                max_bytes: 5_000_000,
                multiple: true,
              },
            },
          ],
        }),
      ],
    });
    const documents = result.entrypoints[0]?.inputs.find(
      (input) => input.id === "documents",
    );
    expect(documents?.file).toEqual({
      media_types: ["application/pdf"],
      max_bytes: 5_000_000,
      multiple: true,
    });
    expect(seedWorkflowInputValue(documents!)).toEqual([]);
    expect(
      parseWorkflowTestLimits({
        maxAgentRuns: "100",
        maxEvents: "250",
        maxDepth: "50",
      }),
    ).toEqual({
      maxAgentRuns: 100,
      maxEvents: 250,
      maxDepth: 50,
    });
    expect(() =>
      parseWorkflowTestLimits({
        maxAgentRuns: "101",
        maxEvents: "75",
        maxDepth: "12",
      }),
    ).toThrow("Agent runs budget must be a whole number from 1 to 100.");
  });

  it("builds the same direct and nested input envelope for live events", () => {
    expect(
      buildWorkflowEventPayload(
        { prompt: "Run", priority: "normal" },
        { priority: "urgent", inputs: { prompt: "untrusted override" } },
      ),
    ).toEqual({
      prompt: "Run",
      priority: "urgent",
      inputs: { prompt: "Run", priority: "normal" },
    });
  });
});

describe("seedWorkflowPromptValue", () => {
  function promptPort(
    over: Partial<WorkflowRunInputDescriptor> = {},
  ): WorkflowRunInputDescriptor {
    return {
      id: "prompt",
      label: "Request",
      description: null,
      kind: "prompt",
      required: false,
      schema: { type: "string" },
      sensitivity: "none",
      consumers: ["a"],
      bindings: [],
      ...over,
    } as unknown as WorkflowRunInputDescriptor;
  }

  it("prefers an authored example over everything else", () => {
    expect(
      seedWorkflowPromptValue(promptPort({ example: "Authored example" }), {
        workflowDescription: "The purpose",
      }),
    ).toBe("Authored example");
  });

  it("uses the workflow's purpose instead of generator boilerplate", () => {
    // Templates and the generator both write this shape; it is a placeholder,
    // not something a person would send.
    const value = seedWorkflowPromptValue(
      promptPort({
        default: "Process the incoming SHORT_VIDEO_REQUEST event as Scriptwriter.",
      }),
      { workflowDescription: "Draft a marketing short-video script and shot list" },
    );
    expect(value).toBe("Draft a marketing short-video script and shot list");
  });

  it("keeps a genuinely authored default", () => {
    expect(
      seedWorkflowPromptValue(promptPort({ default: "Hello!" }), {
        workflowDescription: "The purpose",
      }),
    ).toBe("Hello!");
  });

  it("falls back to the listening agent's description", () => {
    expect(
      seedWorkflowPromptValue(
        promptPort({ default: "Process the incoming X event as Y." }),
        { agentDescriptions: ["Turns a request into a shot list."] },
      ),
    ).toBe("Turns a request into a shot list.");
  });

  it("never returns the boilerplate when nothing better exists", () => {
    const value = seedWorkflowPromptValue(
      promptPort({ default: "Process the incoming X event as Y." }),
      {},
    );
    expect(value).toBe("Process the incoming X event as Y.");
  });

  it("is used for the prompt port by seedWorkflowInputValue", () => {
    expect(
      seedWorkflowInputValue(
        promptPort({ default: "Process the incoming X event as Y." }),
        { workflowDescription: "Real purpose" },
      ),
    ).toBe("Real purpose");
  });
});
