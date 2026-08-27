import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeCodexAppServer, writeCodexHome } from "@agentic/codex-harness";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(apiDir, "..", "..");
const packagedCommand = path.join(
  root,
  "deploy",
  "codex",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);
const command =
  process.env.CODEX_CLI_PATH?.trim() ||
  (existsSync(packagedCommand) ? packagedCommand : "codex");
const codexHome = await mkdtemp(path.join(tmpdir(), "agentic-codex-home-"));

try {
  writeCodexHome({
    dir: codexHome,
    model: "gpt-5.4",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    shellTool: false,
    mcpServers: [],
  });
  const result = await probeCodexAppServer({
    codexHome,
    cwd: root,
    command,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        version: result.version,
        transport: result.transport,
        userAgent: result.userAgent,
        platformFamily: result.platformFamily,
        platformOs: result.platformOs,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(codexHome, { recursive: true, force: true });
}
