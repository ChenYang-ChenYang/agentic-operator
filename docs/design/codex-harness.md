# Codex app-server harness

## Status

Agentic Operator packages Codex `0.150.1` from the upstream
[`rust-v0.150.1`](https://github.com/openai/codex/releases/tag/rust-v0.150.1)
release (`90854393966b21e9ebfd21b122334eb09a20c93d`) and integrates through
`codex app-server`, the product-integration surface for thread lifecycle,
streamed items, approvals, and history. The existing declarative runtime,
code-defined agents, Agent Factory, and CodeAct executor remain unchanged.
Codex is an additional execution boundary, not an alternate route around
tenant policy, the LLM gateway, persistence, or sandbox controls.

## Boundary

```text
Agentic Operator API/orchestrator
  -> @agentic/codex-harness
      -> newline-delimited JSON-RPC over stdio
          -> pinned @openai/codex app-server

codex.version
  -> deploy/codex/package-lock.json
  -> generated TypeScript + JSON Schema
  -> Docker version assertion + CI probe
```

The pieces have deliberately narrow responsibilities:

- `codex.version` is the human-readable source-of-truth version pin.
- `deploy/codex/package.json` and `package-lock.json` install the exact npm
  release plus its integrity-pinned platform package.
- `packages/codex-protocol/generated/` and `schema/` come only from that pinned
  binary's official generators. `index.ts` exposes the subset used by the
  adapter.
- `packages/codex-harness` owns process lifecycle, the required
  `initialize`/`initialized` handshake, typed notifications, server-request
  handling, turn helpers, private `CODEX_HOME` creation, and version checks.
- `apps/api/scripts/probe-codex-harness.ts` starts the real binary with a
  temporary home and performs no model call.
- `apps/api/Dockerfile` copies `/opt/codex` only into the full API runtime.

## Security contract

- Child environment inheritance is off by default. Callers explicitly pass the
  minimum required variables; the diagnostic passes only process-launch values.
- Unknown server-initiated requests return JSON-RPC `-32601`. Known approval,
  permission, elicitation, user-input, and dynamic-tool requests are declined
  unless an application handler answers them.
- `CODEX_HOME` config and policy files are written with private permissions.
- `shell_environment_policy.inherit` is `none`; shell, sandbox, approval, MCP,
  provider, and model settings are explicit inputs.
- A manifest/tool allow-list remains the trust boundary. Registering or
  discovering a Codex/MCP tool does not itself authorize a tenant to call it.
- The Codex binary is absent from Factory control, workload, production
  CodeAct, and candidate images. Those roles keep their existing constrained
  execution contract.
- Production model credentials must use a scoped provider configuration routed
  through the Agentic Operator gateway. Do not pass a developer's ambient
  OpenAI, cloud, GitHub, or shell credentials to app-server.

The adapter intentionally does not persist platform runs or choose tenant
credentials on its own. An orchestration service must bind Codex thread/turn
events to the existing `runs`, `steps`, logs, usage ledger, cancellation, and
approval model before enabling Codex as a selectable production execution
path.

## Upgrade procedure

1. Set the reviewed stable release in `codex.version` and the exact same value
   for `@openai/codex` in `deploy/codex/package.json`.
2. Refresh the nested lockfile with `npm install --prefix deploy/codex
--package-lock-only --ignore-scripts` and inspect every resolved URL,
   integrity, OS, CPU, and version entry.
3. Run `pnpm codex:runtime:install`.
4. Run `pnpm codex:protocol:generate`. Never hand-edit generated files.
5. Review protocol additions/removals, especially approval, permission,
   authentication, attestation, dynamic-tool, thread, and turn variants. Update
   the curated exports and fail-closed request handling when needed.
6. Run:

   ```bash
   pnpm codex:protocol:check
   pnpm --filter @agentic/codex-harness test
   pnpm typecheck
   pnpm verify:codex-harness
   pnpm test
   ```

7. Build the `codex-harness-runtime` Docker target on each supported release
   architecture. The Docker stage independently asserts that its packaged CLI
   reports the reviewed version.

The CI `Codex harness` leaf repeats the generated-code drift check, adapter
tests, exact-version contract, and real app-server handshake without provider
credentials or a model request.
