/**
 * `McpManager` — owns the lifecycle of all MCP servers a tenant registry
 * declares. Boot calls `connectAll(serverConfigs)` once per tenant; the
 * manager then exposes each server's tool list as a `ToolDescriptor` map
 * the step engine merges into `tenantRegistry.tools`.
 *
 * Lazy-connect: a server only connects when its first tool runs OR
 * `connectAll` is called eagerly. Failures are isolated per server —
 * one bad server doesn't fail boot when `optional: true`.
 *
 * The shim handler delegates to the upstream MCP `tools/call` and
 * marshals the result to the `ToolResult` shape the rest of the runtime
 * expects (text blocks concatenated; structured content kept verbatim).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "@agentic/agent-kit";
import type { ToolDescriptor } from "@agentic/agent-kit";

import type {
  McpServerConfig,
  McpServerStatus,
  McpToolSchemaIssue,
} from "./types";
import { sanitizeMcpInputSchema } from "./input-schema";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

interface RegisteredServer {
  scope: string;
  config: McpServerConfig;
  client: Client | null;
  tools: ToolDescriptor[];
  status: McpServerStatus;
  pendingConnect: Promise<void> | null;
}

export class McpManager {
  private readonly servers = new Map<string, RegisteredServer>();

  private serverKey(serverName: string, scope = "global"): string {
    return `${scope}\u0000${serverName}`;
  }

  /**
   * Register a server config without connecting. Re-registration overwrites
   * — useful for hot-reload paths after a tenant package edit.
   */
  register(config: McpServerConfig, scope = "global"): void {
    this.servers.set(this.serverKey(config.name, scope), {
      scope,
      config,
      client: null,
      tools: [],
      status: {
        name: config.name,
        scope,
        transport: config.transport,
        optional: config.optional,
        connected: false,
        toolCount: 0,
      },
      pendingConnect: null,
    });
  }

  /**
   * Connect every registered server in parallel. Non-optional servers
   * propagate failures; optional ones get their `status.lastError` set
   * and the rest of boot continues.
   */
  async connectAll(
    configs: McpServerConfig[],
    scope = "global",
  ): Promise<void> {
    const names = new Set<string>();
    for (const cfg of configs) {
      if (names.has(cfg.name)) {
        throw new Error(
          `mcp: duplicate server name '${cfg.name}' in scope '${scope}'`,
        );
      }
      names.add(cfg.name);
    }
    // The declaration is authoritative for this tenant. A removed MCP server
    // must not retain a live child/transport or leak stale tools into the next
    // hot-rebuilt registry.
    for (const [key, prior] of [...this.servers.entries()]) {
      if (prior.scope !== scope || names.has(prior.config.name)) continue;
      if (prior.client) {
        try {
          await prior.client.close();
        } catch {
          // The old transport may already have exited.
        }
      }
      this.servers.delete(key);
    }
    for (const cfg of configs) {
      const key = this.serverKey(cfg.name, scope);
      const prior = this.servers.get(key);
      if (prior && isDeepStrictEqual(prior.config, cfg)) continue;
      if (prior?.client) {
        try {
          await prior.client.close();
        } catch {
          // The replacement is authoritative; a dead prior transport may
          // already have closed itself.
        }
      }
      this.register(cfg, scope);
    }
    await Promise.all(
      configs.map(async (cfg) => {
        try {
          await this.ensureConnected(cfg.name, scope);
        } catch (err) {
          if (!cfg.optional) throw err;
          // Optional: leave status with lastError; tools array stays empty.
        }
      }),
    );
  }

  /**
   * Ensure a server is connected and its tool list has been fetched.
   * Concurrent callers share the same in-flight connect promise so the
   * MCP server only sees one handshake per process.
   */
  async ensureConnected(serverName: string, scope = "global"): Promise<void> {
    const reg = this.servers.get(this.serverKey(serverName, scope));
    if (!reg) throw new Error(`mcp: unknown server '${serverName}'`);
    if (reg.client && reg.status.connected) return;
    if (reg.pendingConnect) return reg.pendingConnect;

    reg.pendingConnect = (async () => {
      try {
        // MCP SDK >=1.29 dropped the (now no-op) `tools` capability slot
        // from the client `ClientCapabilities` union — capabilities now
        // only declares OPTIONAL client-side surfaces (sampling, roots,
        // elicitation). Servers advertise tools via their own capabilities;
        // the client just needs to be ready to receive them.
        const client = new Client(
          { name: "agentic-operator", version: "0.1.0" },
          { capabilities: {} },
        );
        if (reg.config.transport === "stdio") {
          const transport = new StdioClientTransport({
            command: reg.config.command,
            args: reg.config.args,
            env: {
              ...(process.env as Record<string, string>),
              ...(reg.config.env ?? {}),
            },
            cwd: reg.config.cwd
              ? resolve(process.cwd(), reg.config.cwd)
              : undefined,
            stderr: "inherit",
          });
          await client.connect(transport);
        } else {
          const transport = new StreamableHTTPClientTransport(
            new URL(reg.config.url),
            {
              requestInit: { headers: reg.config.headers },
            },
          );
          await client.connect(transport);
        }
        reg.client = client;
        const list = await client.listTools();
        const built = this.buildShims(reg, list.tools);
        reg.tools = built.tools;
        reg.status = {
          ...reg.status,
          connected: true,
          toolCount: reg.tools.length,
          connectedAt: Date.now(),
          lastError: undefined,
          schemaIssues: built.schemaIssues.length
            ? built.schemaIssues
            : undefined,
        };
      } catch (err) {
        reg.status = {
          ...reg.status,
          connected: false,
          lastError: safeMcpError(err),
        };
        throw err;
      } finally {
        reg.pendingConnect = null;
      }
    })();

    return reg.pendingConnect;
  }

  /**
   * Build a `ToolDescriptor` per MCP tool. Names are prefixed with the
   * server name so two servers can advertise a `search` tool without
   * collision (e.g. `robohire-mcp.search_candidates`).
   *
   * The handler routes `tools/call` requests through the cached client.
   * Structured content arrays are flattened to a single string for the
   * `ToolResult.data` slot the gateway feeds back as a `tool_result` block
   * — adapters that don't speak structured tool_result still see a
   * stringified body.
   *
   * #MCP-ARGS — the server's advertised `inputSchema` is carried onto the
   * descriptor. It used to be dropped here, so every MCP tool reached the model
   * with no argument contract unless a manifest author hand-copied the schema
   * into `tool_use[].input_schema` — a direct cause of hallucinated arguments.
   * A refused schema leaves the slot ABSENT (fail closed) and is reported on
   * the server status; it is never replaced with a permissive stand-in.
   */
  private buildShims(
    reg: RegisteredServer,
    mcpTools: ListedTool[],
  ): { tools: ToolDescriptor[]; schemaIssues: McpToolSchemaIssue[] } {
    const allow = reg.config.allowTools ? new Set(reg.config.allowTools) : null;
    const out: ToolDescriptor[] = [];
    const schemaIssues: McpToolSchemaIssue[] = [];
    for (const t of mcpTools) {
      if (allow && !allow.has(t.name)) continue;
      const shimName = qualify(reg.config.name, t.name);
      const argsContract = sanitizeMcpInputSchema(t.inputSchema);
      if (!argsContract.usable) {
        schemaIssues.push({ tool: shimName, reason: argsContract.reason });
      }
      const shim = defineTool({
        name: shimName,
        description:
          t.description ?? `MCP tool '${t.name}' on '${reg.config.name}'`,
        async handler(ctx) {
          const client = reg.client;
          if (!client) {
            throw new Error(
              `mcp: server '${reg.config.name}' is not connected`,
            );
          }
          const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
          const res = await client.callTool({
            name: t.name,
            arguments: args,
          });
          // `res.content` is typed loosely by the SDK; narrow at the
          // edge so the flattener doesn't need to know SDK shapes.
          const content = Array.isArray(res.content)
            ? (res.content as McpContentBlock[])
            : undefined;
          if (res.isError) {
            const detail = flattenMcpContent(content);
            throw new Error(
              `mcp: tool '${reg.config.name}.${t.name}' failed: ${
                typeof detail === "string" ? detail : JSON.stringify(detail)
              }`,
            );
          }
          return {
            data: flattenMcpContent(content),
            meta: {
              mcpServer: reg.config.name,
              mcpTool: t.name,
              isError: false,
            },
          };
        },
      });
      // `defineTool`'s input surface is owned by @agentic/agent-kit (an
      // args-contract slot is landing there separately), so the additive
      // descriptor field is attached here instead of through the builder.
      out.push(
        argsContract.usable
          ? { ...shim, inputSchema: argsContract.schema }
          : shim,
      );
    }
    return { tools: out, schemaIssues };
  }

  /**
   * Merge every connected server's shims into a single `{name: descriptor}`
   * map that the runtime can spread into `tenantRegistry.tools`. Later
   * servers don't shadow earlier ones because the qualified-name prefix
   * keeps each tool unique.
   */
  toolMap(opts: { scope?: string } = {}): Record<string, ToolDescriptor> {
    const out: Record<string, ToolDescriptor> = {};
    for (const reg of this.servers.values()) {
      if (opts.scope != null && reg.scope !== opts.scope) continue;
      for (const tool of reg.tools) out[tool.name] = tool;
    }
    return out;
  }

  /** Health/diagnostic snapshot. */
  describe(scope?: string): McpServerStatus[] {
    return Array.from(this.servers.values())
      .filter((r) => scope == null || r.scope === scope)
      .map((r) => ({
        ...r.status,
        // Detach the array so a diagnostics consumer can't mutate live state.
        schemaIssues: r.status.schemaIssues
          ? r.status.schemaIssues.map((issue) => ({ ...issue }))
          : undefined,
      }));
  }

  /**
   * Live readiness probe. A successful boot-time handshake is not permanent:
   * stdio children can exit and HTTP transports can disappear later. Re-list
   * tools to prove the connection still serves the declared capability. A
   * failed server is left disconnected so a later probe can reconnect it.
   */
  async probeAll(): Promise<McpServerStatus[]> {
    await Promise.all(
      Array.from(this.servers.values()).map(async (reg) => {
        try {
          if (!reg.client || !reg.status.connected) {
            await this.ensureConnected(reg.config.name, reg.scope);
            return;
          }
          const list = await reg.client.listTools();
          const built = this.buildShims(reg, list.tools);
          reg.tools = built.tools;
          reg.status = {
            ...reg.status,
            connected: true,
            toolCount: reg.tools.length,
            connectedAt: Date.now(),
            lastError: undefined,
            schemaIssues: built.schemaIssues.length
              ? built.schemaIssues
              : undefined,
          };
        } catch (error) {
          reg.status = {
            ...reg.status,
            connected: false,
            toolCount: 0,
            lastError: safeMcpError(error),
            // A disconnected server advertises nothing; stale per-tool schema
            // findings would read as current.
            schemaIssues: undefined,
          };
          const client = reg.client;
          reg.client = null;
          reg.tools = [];
          if (client) {
            try {
              await client.close();
            } catch {
              // Already disconnected.
            }
          }
        }
      }),
    );
    return this.describe();
  }

  /** Cleanly close every connected server (SIGTERM path). */
  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.values()).map(async (reg) => {
        if (reg.client) {
          try {
            await reg.client.close();
          } catch {
            // Already-closed transports throw; nothing actionable.
          }
          reg.client = null;
          reg.status.connected = false;
          reg.status.toolCount = 0;
          reg.status.schemaIssues = undefined;
          reg.tools = [];
        }
      }),
    );
  }
}

function safeMcpError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|authorization|secret|password|cookie|credential|session)\s*[:=]\s*)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .slice(0, 300);
}

/**
 * One-per-process manager so multiple tenants can share the same MCP
 * server connection when the slug matches. Most tenants will own their
 * own servers; the singleton is the cheapest way to expose `describe()`
 * to `/health` without threading the instance through everywhere.
 */
let singleton: McpManager | null = null;
export function getMcpManager(): McpManager {
  if (!singleton) singleton = new McpManager();
  return singleton;
}
/** Test-only: drop the singleton between specs. */
export function __resetMcpManagerForTest(): void {
  singleton = null;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: unknown;
}

function flattenMcpContent(content: McpContentBlock[] | undefined): unknown {
  if (!content || content.length === 0) return null;
  // Common case: a single text block. Return the raw text so JSON-y bodies
  // pass through unmolested (the LLM gateway will stringify when needed).
  if (content.length === 1 && content[0]!.type === "text") {
    return content[0]!.text ?? "";
  }
  // Mixed/multi block — keep the structure; the gateway's
  // `stringifyToolPayload` JSON-encodes it before sending as tool_result.
  return content;
}

function qualify(serverName: string, toolName: string): string {
  // Already qualified (e.g. operator hand-wrote a manifest with the prefix
  // baked in) — leave alone so the engine's lookup matches.
  if (toolName.startsWith(`${serverName}.`)) return toolName;
  return `${serverName}.${toolName}`;
}
