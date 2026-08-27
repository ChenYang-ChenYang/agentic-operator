import type { InitializeResponse } from "@agentic/codex-protocol";

import { AppServerClient } from "./app-server-client";
import {
  assertCodexHarnessVersion,
  codexLaunch,
  configuredCodexCommand,
} from "./version";

export interface CodexAppServerProbeOptions {
  codexHome: string;
  cwd?: string;
  command?: string;
  timeoutMs?: number;
}

export interface CodexAppServerProbeResult extends InitializeResponse {
  version: string;
  transport: "stdio";
}

/**
 * Performs a no-model-call app-server handshake with an isolated environment.
 * Provider credentials are intentionally not inherited by this diagnostic.
 */
export async function probeCodexAppServer(
  options: CodexAppServerProbeOptions,
): Promise<CodexAppServerProbeResult> {
  const command = options.command ?? configuredCodexCommand();
  const version = assertCodexHarnessVersion(command);
  const launch = codexLaunch(command);
  const client = new AppServerClient({
    ...launch,
    codexHome: options.codexHome,
    cwd: options.cwd,
    inheritEnv: false,
    requestTimeoutMs: options.timeoutMs ?? 15_000,
    env: {
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            PATHEXT: process.env.PATHEXT,
          }
        : {}),
    },
  });
  try {
    const initialized = await client.start({
      clientInfo: {
        name: "agentic-operator",
        title: "Agentic Operator",
        version: "0.1.0",
      },
      capabilities: null,
    });
    return { ...initialized, version, transport: "stdio" };
  } finally {
    await client.close();
  }
}
