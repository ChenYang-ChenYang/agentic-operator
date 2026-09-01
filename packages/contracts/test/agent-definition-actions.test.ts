import { describe, expect, it } from "vitest";

import { normalizeAgentDefinition } from "../src/agent-definition";

describe("Agent Definition v2 runtime action preservation", () => {
  it.each(["invoke", "foreach", "emit"] as const)(
    "preserves the %s action type during normalization",
    (type) => {
      const definition = normalizeAgentDefinition({
        id: `agent-${type}`,
        name: `agent${type}`,
        actor: ["Agent"],
        trigger: ["RUN"],
        inputs: [
          {
            id: "prompt",
            kind: "prompt",
            required: true,
            schema: { type: "string" },
          },
        ],
        actions: [
          {
            id: `step-${type}`,
            order: "1",
            name: `${type}Step`,
            description: `${type} step`,
            type,
          },
        ],
        outputs: [
          {
            id: "result",
            required: true,
            schema: { type: "object" },
          },
        ],
      });

      expect(definition.actions[0]?.type).toBe(type);
    },
  );
});
