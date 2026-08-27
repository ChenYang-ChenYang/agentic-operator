import { createInterface } from "node:readline";

let deferredRequest = null;
let initializeCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initializeCount += 1;
    if (initializeCount > 1) process.exit(91);
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex-app-server/0.150.1",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "test",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    send({
      method: "warning",
      params: { threadId: null, message: "initialized once" },
    });
    return;
  }
  if (message.method === "test/server-request") {
    deferredRequest = message.id;
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        environmentId: null,
      },
    });
    return;
  }
  if (message.method === "test/unknown-server-request") {
    deferredRequest = message.id;
    send({
      id: "auth-refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "test" },
    });
    return;
  }
  if (message.method === "test/exit") {
    process.exit(23);
  }
  if (message.method === "test/environment") {
    send({
      id: message.id,
      result: Object.fromEntries(
        message.params.keys.map((key) => [key, process.env[key] ?? null]),
      ),
    });
    return;
  }
  if (message.method === "test/never") return;

  if (message.id === "approval-1" && deferredRequest !== null) {
    send({
      id: deferredRequest,
      result: { serverResponse: message.result },
    });
    deferredRequest = null;
    return;
  }
  if (message.id === "auth-refresh-1" && deferredRequest !== null) {
    send({
      id: deferredRequest,
      result: { serverError: message.error },
    });
    deferredRequest = null;
    return;
  }

  if (message.id !== undefined && message.method) {
    send({ id: message.id, result: {} });
  }
});
