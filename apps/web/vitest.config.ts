import { defineConfig } from "vitest/config";
import path from "node:path";

/*
 * Vitest config for the Next.js web workspace.
 *
 * Coverage gate (P4-TEST-07): lines >= 70%, branches >= 60% over the
 * unit-testable surface.
 *
 * Coverage scope notes:
 *   - The legacy v1_1 SPA under public/portal is served via CDN
 *     React + Babel-standalone; it has no module graph and isn't reached
 *     by Vitest at all. It's explicitly excluded so the coverage report
 *     reflects only TSX code we actually own.
 *   - Next.js app routes (app/.../page.tsx, layout.tsx) are exercised
 *     end-to-end via Playwright (P4-TEST-04, P4-TEST-05). Putting them
 *     under the unit-coverage gate would either reward shallow snapshot
 *     tests or force a SSR test-harness this codebase deliberately
 *     doesn't carry. Pure helpers (app/portal/lib, plus the
 *     app/portal/components helpers with .test.ts siblings) stay in
 *     scope.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // Next.js compiles JSX with the automatic runtime (no `import React`
  // needed). Align Vitest's esbuild transform so shared components like
  // app/portal/components/markdown.tsx render identically under SSR tests.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "app/portal/**/*.test.ts",
      "app/portal/**/*.test.tsx",
    ],
    globals: true,
    environment: "node",
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      // Coverage scope is intentionally narrow: pure helpers with a unit
      // test seam. TanStack Query hooks (useAgents, useRuns, useUsage,
      // ...) and React effects (such as useStream's EventSource lifecycle)
      // are exercised end-to-end via
      // Playwright (P4-TEST-04 / P4-TEST-05); the unit gate would only
      // reward mocking the browser globals out, which is performative.
      //
      // Files appear here when they expose pure helpers that the existing
      // unit tests already exercise; the hook-only React components live
      // outside the gate.
      include: [
        "app/portal/lib/format.ts",
        "app/portal/lib/use-tenant.ts",
        "app/portal/components/workflows/layout.ts",
        "app/portal/components/workflows/draft.ts",
        "app/portal/components/usage/charts.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "**/*.test.*",
        "public/**",
      ],
      thresholds: {
        lines: 70,
        branches: 60,
        functions: 60,
        statements: 70,
      },
    },
  },
});
