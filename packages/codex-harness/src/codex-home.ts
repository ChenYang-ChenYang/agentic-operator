import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  httpHeaders?: Record<string, string>;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabledTools?: string[];
  defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
  toolApprovalModes?: Record<string, "auto" | "prompt" | "writes" | "approve">;
  required?: boolean;
  startupTimeoutSec?: number;
}

export interface CodexHomeSpec {
  dir: string;
  model: string;
  provider?: ModelProviderSpec;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "never";
  shellTool: boolean;
  mcpServers: McpServerSpec[];
  agentsMd?: string;
  modelInstructionsFile?: string;
  /** Trusted operator-only escape hatch; never pass tenant or model output. */
  trustedExtraToml?: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function setPrivateMode(path: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(path, mode);
}

export function renderCodexConfigToml(spec: CodexHomeSpec): string {
  const lines = [
    `model = ${tomlString(spec.model)}`,
    ...(spec.provider
      ? [`model_provider = ${tomlString(spec.provider.id)}`]
      : []),
    `sandbox_mode = ${tomlString(spec.sandboxMode)}`,
    `approval_policy = ${tomlString(spec.approvalPolicy)}`,
    "check_for_update_on_startup = false",
    ...(spec.modelInstructionsFile
      ? [`model_instructions_file = ${tomlString(spec.modelInstructionsFile)}`]
      : []),
    "",
    "[features]",
    `shell_tool = ${spec.shellTool}`,
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
  ];

  if (spec.provider) {
    lines.push(
      "",
      `[model_providers.${tomlString(spec.provider.id)}]`,
      `name = ${tomlString(spec.provider.name)}`,
      `base_url = ${tomlString(spec.provider.baseUrl)}`,
      `env_key = ${tomlString(spec.provider.envKey)}`,
      'wire_api = "responses"',
    );
    if (spec.provider.httpHeaders) {
      lines.push(
        `[model_providers.${tomlString(spec.provider.id)}.http_headers]`,
      );
      for (const [key, value] of Object.entries(spec.provider.httpHeaders)) {
        lines.push(`${tomlString(key)} = ${tomlString(value)}`);
      }
    }
  }

  for (const server of spec.mcpServers) {
    lines.push(
      "",
      `[mcp_servers.${tomlString(server.name)}]`,
      `command = ${tomlString(server.command)}`,
      `args = [${server.args.map(tomlString).join(", ")}]`,
    );
    if (server.required !== undefined) {
      lines.push(`required = ${server.required}`);
    }
    if (server.startupTimeoutSec !== undefined) {
      lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
    }
    if (server.enabledTools) {
      lines.push(
        `enabled_tools = [${server.enabledTools.map(tomlString).join(", ")}]`,
      );
    }
    if (server.defaultToolsApprovalMode) {
      lines.push(
        `default_tools_approval_mode = ${tomlString(
          server.defaultToolsApprovalMode,
        )}`,
      );
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`[mcp_servers.${tomlString(server.name)}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${tomlString(key)} = ${tomlString(value)}`);
      }
    }
    for (const [tool, mode] of Object.entries(server.toolApprovalModes ?? {})) {
      lines.push(
        `[mcp_servers.${tomlString(server.name)}.tools.${tomlString(tool)}]`,
        `approval_mode = ${tomlString(mode)}`,
      );
    }
  }

  if (spec.trustedExtraToml?.trim()) {
    lines.push("", spec.trustedExtraToml.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function writeCodexHome(spec: CodexHomeSpec): string {
  mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
  setPrivateMode(spec.dir, 0o700);
  const configPath = join(spec.dir, "config.toml");
  writeFileSync(configPath, renderCodexConfigToml(spec), {
    encoding: "utf8",
    mode: 0o600,
  });
  setPrivateMode(configPath, 0o600);
  if (spec.agentsMd !== undefined) {
    const agentsPath = join(spec.dir, "AGENTS.md");
    writeFileSync(agentsPath, spec.agentsMd, {
      encoding: "utf8",
      mode: 0o600,
    });
    setPrivateMode(agentsPath, 0o600);
  }
  return spec.dir;
}
