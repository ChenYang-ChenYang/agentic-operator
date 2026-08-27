import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const json = (name) => JSON.parse(read(name));

test("Codex app-server version is pinned consistently", () => {
  const version = read("codex.version").trim();
  const runtime = json("deploy/codex/package.json");
  const lock = json("deploy/codex/package-lock.json");
  const api = json("apps/api/package.json");
  const versionSource = read("packages/codex-harness/src/version.ts");
  const protocolIndex = read("packages/codex-protocol/index.ts");

  assert.equal(version, "0.150.1");
  assert.equal(runtime.dependencies["@openai/codex"], version);
  assert.equal(lock.packages[""].dependencies["@openai/codex"], version);
  assert.equal(lock.packages["node_modules/@openai/codex"].version, version);
  assert.equal(api.dependencies["@agentic/codex-harness"], "workspace:*");
  assert.match(
    versionSource,
    new RegExp(`CODEX_HARNESS_VERSION = "${version.replaceAll(".", "\\.")}"`),
  );
  assert.match(
    protocolIndex,
    new RegExp(`Codex ${version.replaceAll(".", "\\.")} app-server`),
  );

  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name.startsWith("node_modules/@openai/codex-")) continue;
    assert.match(
      entry.version,
      new RegExp(`^${version.replaceAll(".", "\\.")}-`),
    );
    assert.match(entry.integrity, /^sha512-/);
  }
});

test("only the full API image receives the Codex runtime", () => {
  const dockerfile = read("apps/api/Dockerfile");
  const runtimeStart = dockerfile.indexOf("FROM ${NODE_BASE_IMAGE} AS runtime");
  const sandboxStart = dockerfile.indexOf(
    "FROM ${NODE_BASE_IMAGE} AS sandbox-common",
  );
  const runtime = dockerfile.slice(runtimeStart, sandboxStart);
  const sandboxTargets = dockerfile.slice(sandboxStart);

  assert.match(
    dockerfile,
    /FROM \$\{NODE_BASE_IMAGE\} AS codex-harness-runtime/,
  );
  assert.match(
    runtime,
    /COPY --from=codex-harness-runtime .* \/opt\/codex \/opt\/codex/,
  );
  assert.match(
    runtime,
    /CODEX_CLI_PATH=\/opt\/codex\/node_modules\/@openai\/codex\/bin\/codex\.js/,
  );
  assert.doesNotMatch(sandboxTargets, /COPY --from=codex-harness-runtime/);
  assert.doesNotMatch(sandboxTargets, /CODEX_CLI_PATH/);
});

test("the app-server adapter writes each JSON-RPC frame once", () => {
  const client = read("packages/codex-harness/src/app-server-client.ts");
  assert.equal(
    client.match(/child\.stdin\.write\(`/g)?.length,
    1,
    "duplicating a frame can duplicate turns, approvals, or mutations",
  );
});
