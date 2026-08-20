import { defineConfig } from "vitest/config";

// Kenny's runtime-v2 suites are node:test-based (imported from "node:test") and
// cannot be collected by vitest. They run through the package's `test:node`
// script instead; `pnpm test` runs both runners.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "src/action-model-overrides.test.ts",
      "src/agent-execution.test.ts",
      "src/event-envelope.test.ts",
      "src/execution-trace.test.ts",
      "src/generated-agent-prompt.test.ts",
      "src/lint.test.ts",
      "src/manifest-v2.test.ts",
      "src/manual-task-payload.test.ts",
      "src/register-config.test.ts",
      "src/step-engine-v2.test.ts",
      "src/usage-attribution-envelope.test.ts",
    ],
  },
});
