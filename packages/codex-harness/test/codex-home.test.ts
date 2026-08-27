import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { renderCodexConfigToml, writeCodexHome } from "../src/codex-home";

const spec = (dir: string) => ({
  dir,
  model: "gpt-5.6-terra",
  provider: {
    id: "agentic_gateway",
    name: "Agentic Operator gateway",
    baseUrl: "https://gateway.example.invalid/v1",
    envKey: "AGENTIC_CODEX_GATEWAY_TOKEN",
  },
  sandboxMode: "read-only" as const,
  approvalPolicy: "on-request" as const,
  shellTool: false,
  mcpServers: [
    {
      name: "ontology",
      command: "node",
      args: ["/app/mcp/ontology.mjs"],
      required: true,
      enabledTools: ["search"],
      defaultToolsApprovalMode: "writes" as const,
    },
  ],
  agentsMd: "# Tenant policy\n",
});

test("renders a fail-closed Codex home", () => {
  const rendered = renderCodexConfigToml(spec("/tmp/unused"));
  assert.match(rendered, /sandbox_mode = "read-only"/);
  assert.match(rendered, /approval_policy = "on-request"/);
  assert.match(rendered, /shell_tool = false/);
  assert.match(rendered, /inherit = "none"/);
  assert.match(rendered, /wire_api = "responses"/);
  assert.match(rendered, /default_tools_approval_mode = "writes"/);
  assert.match(rendered, /\[model_providers\."agentic_gateway"\]/);
  assert.match(rendered, /\[mcp_servers\."ontology"\]/);
  assert.doesNotMatch(rendered, /AGENTIC_CODEX_GATEWAY_TOKEN\s*=/);
});

test("writes private config and policy files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-home-test-"));
  const home = path.join(root, "home");
  try {
    await mkdir(home, { mode: 0o755 });
    await writeFile(path.join(home, "config.toml"), "stale = true\n", {
      mode: 0o644,
    });
    await writeFile(path.join(home, "AGENTS.md"), "stale policy\n", {
      mode: 0o644,
    });
    if (process.platform !== "win32") {
      await chmod(home, 0o755);
      await chmod(path.join(home, "config.toml"), 0o644);
      await chmod(path.join(home, "AGENTS.md"), 0o644);
    }
    writeCodexHome(spec(home));
    assert.match(
      await readFile(path.join(home, "config.toml"), "utf8"),
      /read-only/,
    );
    assert.equal(
      await readFile(path.join(home, "AGENTS.md"), "utf8"),
      "# Tenant policy\n",
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(home)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(home, "config.toml"))).mode & 0o777,
        0o600,
      );
      assert.equal(
        (await stat(path.join(home, "AGENTS.md"))).mode & 0o777,
        0o600,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
