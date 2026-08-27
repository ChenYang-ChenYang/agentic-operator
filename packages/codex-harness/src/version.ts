import { execFileSync } from "node:child_process";

export const CODEX_HARNESS_VERSION = "0.150.1" as const;

export function configuredCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CODEX_CLI_PATH?.trim() || "codex";
}

export function codexLaunch(command = configuredCodexCommand()): {
  command: string;
  commandArgs: string[];
} {
  return command.endsWith(".js")
    ? { command: process.execPath, commandArgs: [command] }
    : { command, commandArgs: [] };
}

export function assertCodexHarnessVersion(
  command = configuredCodexCommand(),
): string {
  const launch = codexLaunch(command);
  const output = execFileSync(
    launch.command,
    [...launch.commandArgs, "--version"],
    {
      encoding: "utf8",
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
      timeout: 10_000,
    },
  ).trim();
  const actual = /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-.][\w.-]+)?)/.exec(
    output,
  )?.[1];
  if (actual !== CODEX_HARNESS_VERSION) {
    throw new Error(
      `Codex harness version mismatch: expected ${CODEX_HARNESS_VERSION}, received ${
        actual ?? JSON.stringify(output)
      }`,
    );
  }
  return actual;
}
