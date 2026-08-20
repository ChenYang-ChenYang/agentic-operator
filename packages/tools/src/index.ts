/**
 * @agentic/tools — first-party tool implementations + global registry.
 *
 * One production surface:
 *
 *  1. **Global tool registry** (the canonical, configuration-driven surface) —
 *     `globalToolRegistry: Map<string, ToolDescriptor>` and
 *     `listGlobalTools(): ToolCatalogEntry[]` from `./registry`.
 *     Any agent in any tenant can reference these tools by name in its
 *     manifest's `tool_use[]`; no code change needed per tenant. Per-tenant
 *     configuration (API keys, paths) flows through `tool_use[].config`
 *     into `ctx.config`.
 *
 * Unresolved names fail closed in @agentic/runtime. This package deliberately
 * exposes no name-guessing/canned dispatcher: a workflow reports success only
 * after a tenant, global, or MCP handler actually ran.
 */

// ─── (1) global registry — canonical surface ───────────────────────────────

export {
  globalToolRegistry,
  globalWriteProbeLifecycleSourceIdentity,
  globalToolExecutionPolicy,
  globalToolSideEffect,
  getGlobalToolCatalogEntry,
  isToolExecutionPolicy,
  toolExecutionPoliciesEqual,
  listGlobalTools,
  type ToolCatalogEntry,
  type ToolEffectScope,
  type ToolExecutionPolicy,
  type ToolOperation,
  type ToolSandboxPolicy,
} from "./registry";

// ─── declarative HTTP tools (Phase 2 Tier A) — make brain-authored tools runtime-invocable ──
export {
  makeDeclarativeTool,
  resolveDeclarativeToolConfig,
  buildDeclarativeOverlay,
  type DeclarativeToolDef,
  type MakeDeclarativeToolOpts,
  type DeclarativeRequestSpec,
  type DeclarativeResponseSpec,
  type DeclarativeResponseAssertion,
  type DeclarativeMultipartFileSpec,
  type DeclarativeExchangeExample,
  type DeclarativeObservedExchange,
  DeclarativeToolExecutionError,
  type DeclarativeToolFailureKind,
} from "./declarative/http-tool";
export { isPrivateHost, assertPublicUrl, safeFetch } from "./declarative/ssrf";
export { validateToolSchema, type SchemaValidationIssue } from "./declarative/schema-validation";

// Re-export the category sub-packages so external consumers can import
// the descriptors directly when they want (e.g. for tests).
export * as robohire from "./robohire";
export * as gohire from "./gohire";
export * as fs from "./fs";
export * as http from "./http";
export * as meta from "./meta";
export * as metaerp from "./metaerp";
export * as search from "./search";
export * as ontology from "./ontology";
export * as records from "./records";
export * as viz from "./viz";
export * as report from "./report";
export * as objectStore from "./object-store";
export * as postgres from "./postgres";
export * as crypto from "./crypto";
export * as document from "./document";
export * as browser from "./browser";
export * as comms from "./comms";

// DI seam: apps/api injects a resolver at boot so DB-backed integration
// credentials (configured in Settings → Integrations) reach the GoHire tool
// family without `@agentic/tools` importing the database layer.
export {
  setIntegrationResolver,
  hasIntegrationResolver,
  resolveIntegrationCreds,
  type IntegrationCreds,
  type IntegrationResolver,
} from "./integrations";

// Named exports for server-side (non-tool) reuse — the report pipeline in
// apps/api renders charts + prints PDFs through these directly.
export { renderSvgChart, type SvgChartSpec, type ChartDatum } from "./viz";
export { htmlToPdf, htmlFileToPdf, findChrome, reportArchiveDir } from "./report";
