/**
 * MCP integration types — declarative server configs that a tenant package
 * exports as part of its `TenantRegistry.mcpServers` slot.
 *
 * The runtime resolves each entry at bootstrap (or first use), starts the
 * transport, calls `list_tools` once, and shims every advertised MCP tool
 * into the existing `defineTool` contract so the step engine and the
 * tool-use loop see MCP tools identically to native ones.
 */

import { z } from "zod";

/**
 * Configures a single MCP server the tenant wants to expose.
 *
 * `transport: "stdio"` spawns `command + args` (+ optional `env`) and
 * communicates over stdio per the MCP spec. `cwd` is resolved relative
 * to the tenant package's directory when relative; absolute paths pass
 * through.
 *
 * `transport: "http"` connects to a streamable-HTTP MCP endpoint at
 * `url`. Useful for hosted MCP servers — no process management on our side.
 */
export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({
    name: z.string().min(1),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    /** Tools to surface; when omitted the runtime exposes ALL tools the server lists. */
    allowTools: z.array(z.string()).optional(),
    /** Explicit opt-out from fail-closed startup. Required by default. */
    optional: z.boolean().default(false),
  }),
  z.object({
    name: z.string().min(1),
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    allowTools: z.array(z.string()).optional(),
    optional: z.boolean().default(false),
  }),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Diagnostic info captured the first time the runtime touches an MCP
 * server. Surfaced via `getMcpManager().describe()` so `/health` and the
 * runs UI can render server status without re-listing tools every render.
 */
export interface McpServerStatus {
  name: string;
  /** Runtime tenant scope that owns this connection. */
  scope?: string;
  transport: McpServerConfig["transport"];
  /** Optional servers may degrade without making the whole API ready=false. */
  optional?: boolean;
  connected: boolean;
  toolCount: number;
  connectedAt?: number;
  lastError?: string;
  /**
   * Tools whose advertised `inputSchema` was refused at the trust boundary.
   * They are still callable (the server owns the real validation), but the
   * model sees no argument contract for them — so the refusal must be visible
   * rather than silent. Undefined means every listed schema was usable.
   */
  schemaIssues?: McpToolSchemaIssue[];
}

/** One refused argument contract. `reason` is structural only — schema payload
 *  never enters it, because this rides on a diagnostics surface. */
export interface McpToolSchemaIssue {
  /** Qualified shim name (`<server>.<tool>`), matching the tool map key. */
  tool: string;
  reason: string;
}
