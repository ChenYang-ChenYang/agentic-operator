/**
 * @agentic/contracts — shared API request/response Zod schemas.
 *
 * Both apps/api (server) and apps/web (client) import from here. The same
 * schema validates a request on the api side and parses the response on the
 * web side — no client/server type drift.
 *
 * Convention: every resource gets its own file with the route paths,
 * request bodies, query strings, and response shapes co-located.
 */

export * from "./envelope";
export * from "./events";
export * from "./runs";
export * from "./tasks";
export * from "./agents";
export * from "./deployments";
export * from "./workflows";
export * from "./workflow-authoring";
export * from "./webhooks";
export * from "./reads";
export * from "./providers";
export * from "./llm";
export * from "./llm-settings";
export * from "./stream";
export * from "./tenants";
export * from "./permissions";
export * from "./access";
export * from "./agent-factory-draft-sandbox";
export * from "./integrations";
export * from "./agent-definition";
export * from "./agent-studio";
export * from "./operator-checks";
export * from "./api-tokens";
export * from "./agent-execution-live";
