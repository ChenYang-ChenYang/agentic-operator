#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = path.join(root, "packages", "codex-protocol");
const version = readFileSync(path.join(root, "codex.version"), "utf8").trim();
const nestedCodex = path.join(
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
  (existsSync(nestedCodex) ? nestedCodex : "codex");
const checkOnly = process.argv.slice(2).includes("--check");

function runCodex(args, options = {}) {
  const isJavaScript = command.endsWith(".js");
  const executable = isJavaScript ? process.execPath : command;
  const commandArgs = isJavaScript ? [command, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || "no output"}`.trim();
    throw new Error(
      `Codex command failed (${result.status}): ${detail.slice(0, 2_000)}`,
    );
  }
  return `${result.stdout || ""}`.trim();
}

function assertPinnedVersion() {
  const output = runCodex(["--version"]);
  const actual = /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-.][\w.-]+)?)/.exec(
    output,
  )?.[1];
  if (actual !== version) {
    throw new Error(
      `Codex protocol generation requires ${version}; ${command} reports ${
        actual ?? JSON.stringify(output)
      }. Run \`pnpm codex:runtime:install\` or set CODEX_CLI_PATH to the pinned binary.`,
    );
  }
}

function filesBelow(directory, prefix = "") {
  const result = new Map();
  if (!existsSync(directory)) return result;
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.join(prefix, name);
    if (statSync(absolute).isDirectory()) {
      for (const [child, hash] of filesBelow(absolute, relative)) {
        result.set(child, hash);
      }
      continue;
    }
    result.set(
      relative,
      createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    );
  }
  return result;
}

function differences(expectedDir, actualDir) {
  const expected = filesBelow(expectedDir);
  const actual = filesBelow(actualDir);
  const names = new Set([...expected.keys(), ...actual.keys()]);
  return [...names]
    .sort()
    .filter((name) => expected.get(name) !== actual.get(name));
}

const scratch = mkdtempSync(path.join(tmpdir(), "agentic-codex-protocol-"));
try {
  assertPinnedVersion();
  const generated = path.join(scratch, "generated");
  const schema = path.join(scratch, "schema");
  runCodex(["app-server", "generate-ts", "--out", generated]);
  runCodex(["app-server", "generate-json-schema", "--out", schema]);

  if (checkOnly) {
    const changed = [
      ...differences(path.join(protocolRoot, "generated"), generated).map(
        (name) => `generated/${name}`,
      ),
      ...differences(path.join(protocolRoot, "schema"), schema).map(
        (name) => `schema/${name}`,
      ),
    ];
    if (changed.length > 0) {
      throw new Error(
        `Committed Codex protocol does not match ${version}:\n${changed
          .slice(0, 40)
          .map((name) => `  - ${name}`)
          .join(
            "\n",
          )}${changed.length > 40 ? `\n  ... ${changed.length - 40} more` : ""}`,
      );
    }
    console.log(`Codex ${version} protocol bindings are current.`);
  } else {
    for (const name of ["generated", "schema"]) {
      const target = path.join(protocolRoot, name);
      rmSync(target, { recursive: true, force: true });
      cpSync(path.join(scratch, name), target, { recursive: true });
    }
    console.log(`Generated Codex ${version} app-server protocol bindings.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
