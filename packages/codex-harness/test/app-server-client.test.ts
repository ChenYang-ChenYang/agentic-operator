import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { AppServerClient, AppServerError } from "../src/app-server-client";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-app-server.mjs",
);
const clients: AppServerClient[] = [];
const homes: string[] = [];

async function client(
  onRawLine?: (direction: "in" | "out", line: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<AppServerClient> {
  const codexHome = await mkdtemp(path.join(tmpdir(), "codex-client-test-"));
  homes.push(codexHome);
  const value = new AppServerClient({
    command: process.execPath,
    commandArgs: [fixture],
    codexHome,
    env,
    requestTimeoutMs: 1_000,
    onRawLine,
  });
  clients.push(value);
  return value;
}

async function start(value: AppServerClient) {
  return value.start({
    clientInfo: {
      name: "agentic-operator-test",
      title: "Agentic Operator test",
      version: "0.1.0",
    },
    capabilities: null,
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

test("performs one initialize handshake and routes notifications", async () => {
  const output: string[] = [];
  const value = await client((direction, line) => {
    if (direction === "out") output.push(line);
  });
  const warning = new Promise<string>((resolve) => {
    value.onNotification("warning", (params) => resolve(params.message));
  });

  const initialized = await start(value);

  assert.equal(initialized.userAgent, "fake-codex-app-server/0.150.1");
  assert.equal(await warning, "initialized once");
  assert.equal(
    output.filter((line) => JSON.parse(line).method === "initialize").length,
    1,
    "a JSON-RPC request must be written exactly once",
  );
  assert.equal(
    output.filter((line) => JSON.parse(line).method === "initialized").length,
    1,
  );
});

test("does not inherit ambient secrets and passes only explicit environment values", async () => {
  const secretName = "AGENTIC_CODEX_HARNESS_AMBIENT_SECRET";
  const allowedName = "AGENTIC_CODEX_HARNESS_ALLOWED_VALUE";
  process.env[secretName] = "must-not-cross-process-boundary";
  try {
    const value = await client(undefined, { [allowedName]: "allowed" });
    await start(value);
    const environment = await value.request<Record<string, string | null>>(
      "test/environment",
      { keys: [secretName, allowedName] },
    );
    assert.deepEqual(environment, {
      [secretName]: null,
      [allowedName]: "allowed",
    });
  } finally {
    delete process.env[secretName];
  }
});

test("bridges handled approvals and rejects unsupported privileged requests", async () => {
  const value = await client();
  await start(value);
  value.onServerRequest((request) => {
    if (request.method === "item/commandExecution/requestApproval") {
      return { decision: "decline" };
    }
    return undefined;
  });

  const approval = await value.request<{
    serverResponse: { decision: string };
  }>("test/server-request");
  assert.deepEqual(approval.serverResponse, { decision: "decline" });

  const unknown = await value.request<{
    serverError: { code: number; message: string };
  }>("test/unknown-server-request");
  assert.equal(unknown.serverError.code, -32601);
  assert.match(unknown.serverError.message, /unsupported server request/);
});

test("rejects timed-out requests and all pending work on process exit", async () => {
  const value = await client();
  await start(value);

  await assert.rejects(
    value.request("test/never", {}, 25),
    (error: unknown) =>
      error instanceof AppServerError && /timed out/.test(error.message),
  );

  await assert.rejects(
    value.request("test/exit"),
    /codex app-server exited \(code=23/,
  );
});
