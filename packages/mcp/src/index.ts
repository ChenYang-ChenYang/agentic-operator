/**
 * @agentic/mcp — Model Context Protocol client integration.
 *
 * Tenants declare MCP servers via the `mcpServers` slot on their
 * `TenantRegistry`. The runtime connects each at boot, lists the tools
 * the server advertises, and registers a `defineTool` shim per tool
 * under the qualified name `<serverName>.<toolName>`. Manifest agents
 * reference the shimmed tools the same way they reference native ones
 * — `agent.tool_use[*].name`.
 *
 * Each shim also carries the server's advertised `inputSchema` on
 * `ToolDescriptor.inputSchema` when that schema passes the trust boundary in
 * `./input-schema`, so the model sees the tool's real argument contract instead
 * of a contentless one.
 *
 * Public API:
 *   - `McpServerConfig` / `McpServerConfigSchema` — declarative server spec
 *   - `McpManager` — lifecycle owner; usually accessed via the singleton
 *   - `getMcpManager()` — process-wide singleton
 *   - `sanitizeMcpInputSchema()` — argument-contract trust boundary
 */

export {
  McpServerConfigSchema,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolSchemaIssue,
} from "./types";

export {
  sanitizeMcpInputSchema,
  type McpInputSchemaDecision,
} from "./input-schema";

export { McpManager, getMcpManager, __resetMcpManagerForTest } from "./manager";
