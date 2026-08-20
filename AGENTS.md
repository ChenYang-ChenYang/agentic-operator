# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Toolchain

- **Node 26.5.0** (`.nvmrc` = 26.5.0). `better-sqlite3` (native module) is compiled against Node 26's MODULE_VERSION (ABI 147); running on a different major crashes with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. Run `nvm use` after switching shells.
  - **Exact-version guard:** `scripts/ensure-node-version.mjs` rejects any runtime other than 26.5.0 and verifies `.nvmrc` matches `package.json#engines.node`. `.npmrc#engine-strict=true` and the root lifecycle pre-scripts enforce it for install, dev, build, lint, typecheck, test, clean, format, database, and seed commands.
  - **Self-heal:** `scripts/ensure-native-modules.mjs` detects an ABI mismatch (via `process.dlopen` on the resolved `.node`) and rebuilds in-place. It's wired into `postinstall` + every runtime-sensitive pre-script (`predev`, `prebuild`, `pretest`, `predb:*`, `preseed:rich`), so a stale binary auto-rebuilds before the next command instead of crashing. Note: `pnpm rebuild <pkg>` is a silent no-op under pnpm 11 — the guard runs the package's own `prebuild-install || node-gyp` chain inside the package dir, then re-verifies in a child process (dlopen caches per-process).
- **pnpm 11** workspaces — `pnpm install`. Build approval for native deps lives in `pnpm-workspace.yaml` under `allowBuilds:` (the old `pnpm.onlyBuiltDependencies` field in `package.json` is no longer read by pnpm 11 and was removed — `pnpm-workspace.yaml` is the single source of truth).
- Node is pinned consistently in README, `.nvmrc`, CI, Docker, and `package.json#engines`.

## Common commands

```bash
pnpm dev                  # api :3501 first; web :3599 + pinned inngest :8288 follow; watchdog tears down the stack after a sustained api outage
./restart.sh              # gracefully stop the current local stack, then run pnpm dev under the pinned Node version
./restart.sh --check      # validate the restart harness without changing running processes
pnpm build                # turbo run build across all workspaces
pnpm lint                 # turbo run lint (Next.js ESLint on web only)
pnpm typecheck            # turbo run typecheck (every package has its own tsc --noEmit)
pnpm test                 # startup-gate unit tests, then turbo run test across workspaces
pnpm db:migrate           # apply drizzle migrations to data/agentic.db
pnpm db:seed              # 3 tenants + 1 admin
pnpm db:wipe-runtime      # truncate runtime traffic only (runs/steps/events/tasks/audit/artifacts); keeps tenants/users/workflows/agents/deployments/event_types/etc.
pnpm db:prune-deployments # GC superseded deployment rows + their import tmp dirs
pnpm seed:rich            # RAAS historical fixtures + English ontology overlay (idempotent)
pnpm db:generate          # drizzle-kit generate after editing packages/db/src/schema.ts
pnpm db:studio            # drizzle-kit studio
pnpm ensure:native        # manually run the native-module ABI guard
```

Single test (api workspace): `pnpm --filter @agentic/api exec vitest run test/tc-3-test-agent-happy.test.ts`. Vitest config uses `pool: "forks"` and `sequence.concurrent: false` because the SQLite handle isn't worker-thread safe and tests share `data/agentic.db`.

A single workspace's dev server: `pnpm --filter @agentic/api run dev` (or `@agentic/web`). The api `dev` script loads both `../../.env` and `apps/api/.env.local` via `tsx --env-file`. **`pnpm --filter @agentic/api run dev` alone does NOT start Inngest** — `inngest.send` (used by `POST /v1/events` and manifest-agent invocation) then fails with `fetch failed`. Use the full `pnpm dev` (or run the `inngest-cli` line separately) whenever events must actually dispatch.

## Architecture

**Two-process split with a shared Zod contract package.** `apps/web` (Next.js 16, React 19) is UI-only — it has zero database access. Every read goes through `/v1/*` to `apps/api` (Fastify 5). `next.config.mjs` rewrites `/v1/*` and `/health` to `http://localhost:3501`. `@agentic/contracts` Zod schemas are the single source of truth: api validates requests with them; web parses responses with them via `apps/web/lib/api-client.ts`.

**Two parallel agent execution paths share the same `runs`/`steps` schema and SSE log tail.**

1. **Declarative manifest agents** (`packages/runtime`). `models/<slug>-v<n>/workflow*.json` is loaded at boot; each `AgentSpec` becomes one Inngest function with `id = "${tenantSlug}.${agentName}"`, concurrency keyed on `event.data.subject`, retries=3. Events are namespaced `${tenantSlug}/${name}`. See `packages/runtime/src/register.ts` for the durability contract; the LLM tool-use loop + tool dispatch live in `packages/runtime/src/step-engine.ts`.
2. **Code-defined agents** (`packages/agents`). Subclass `BaseAgent`, register at import time via `agentRegistry.register(...)`. `BaseAgent.run()` is sealed; subclasses override `buildMessages()` and optionally `parseOutput()`. The run engine handles run-row + step-row + file-log + gateway dispatch. Invoked synchronously at `POST /v1/agents/:name/invoke`; async via Inngest is reserved for v2.

**Inngest durability discipline.** Inngest replays handlers; every DB write must be inside a `step.run("name", ...)` so exactly one row is produced per actual execution. `step.sendEvent` is the only idempotent way to emit downstream events — never `inngest.send` inside a step body. HITL: create a `tasks` row inside `step.run`, then `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })`. See `packages/runtime/src/register.ts:165-280`. Inngest dev mode is **not crash-safe** — if the api restarts mid-run (e.g. tsx watch reloading on a file edit) the in-flight handler can be dropped; re-fire under a fresh subject.

**LLM Gateway** (`packages/llm-gateway`) fronts 14 providers (`mock`, `anthropic`, `openai`, `openrouter`, `gemini`, `azure`, `groq`, `together`, `mistral`, `deepseek`, `qwen`, `bedrock`, `vertex`, `custom`). A single gateway singleton is constructed in `apps/api/src/services/llm.ts` and injected into both consumers at boot (`setAgentGateway` for BaseAgent, `setRuntimeGateway` for the manifest step engine's `logic`/`llmCall` action) — see `apps/api/src/bootstrap.ts`. Provider catalog metadata lives in `@agentic/contracts/providers`. Background design: `docs/design/llm-gateway-and-baseagent.md`.

**Tenant scoping.** Every user-visible table carries `tenant_id`. Use `tenantScope(ctx, table)` from `@agentic/db` to build the predicate — direct `getDb()` access leaks across tenants. In dev (`AUTH_MODE=dev` or `NODE_ENV !== "production"`) the auth plugin returns the tenant matching `AGENTIC_DEV_TENANT` (default `raas`). Tests set `AGENTIC_DEV_TENANT=__system`. The dev-only `x-agentic-tenant: <slug>` request header overrides the tenant per-request (advisory — never a 401; only consulted under `AUTH_MODE=dev`) — handy for hitting `/v1/*` for a non-default tenant via curl.

**Storage layout.** SQLite WAL at `data/agentic.db` (25 tables, see `packages/db/src/schema.ts`). Run logs are NDJSON-ish per-line at `data/logs/<tenant>/runs/<date>/<run-id>.log` and stream over SSE at `GET /v1/runs/:runId/logs?follow=1`. Event ledger NDJSON at `data/logs/<tenant>/events/<date>.ndjson`. Everything under `data/` is gitignored.

## Global tool registry (`packages/tools`)

**The canonical, configuration-driven way agents get tools.** Any tool exported into `globalToolRegistry` (`packages/tools/src/registry.ts`) is callable by **any agent in any tenant** — the workflow manifest just lists the tool name in an agent's `tool_use[]`. No per-tenant TypeScript required. Treat `packages/tools/` as the home for any new tool that more than one tenant could plausibly want.

**Resolution order** (in `step-engine.ts`, both the LLM tool-use loop and `type:"tool"` action dispatch):

```
tenantRegistry.tools[name]         // tenant-specific override wins
  ?? globalToolRegistry.get(name)  // global core registry
  ?? MCP server tools              // folded into tenantRegistry under "<server>.<tool>"
```

A tenant can ship a custom impl that shadows a global tool; everyone else gets the global default. The manifest's `tool_use[]` allow-list is the trust boundary — a tool isn't callable just because it's registered.

**Per-tenant configuration (no code).** A `tool_use[].config` object in the manifest is lifted into `ctx.config` (`ToolContext.config`, see `packages/agent-kit/src/types.ts`) on every handler call — how the same global tool gets per-tenant credentials/paths:

```json
"tool_use": [
  { "name": "parseResumeApi", "config": { "api_key_env": "TENANT_X_RH_KEY" } },
  { "name": "fs.readFromInbox", "config": { "subdir": "resumes" } },
  { "name": "writeJdToDisk",    "config": { "subdir": "jd-archive", "id_prefix": "jd" } }
]
```

Each tool reads `ctx.config?.<key> ?? <env default>`. The runtime never inspects this blob — each tool documents the keys it honours.

**Tool authoring.** `defineTool({ name, description, output?, handler })` from `@agentic/agent-kit` returns a plain descriptor (no DI, no decorators). Handlers read LLM-supplied args from `ctx.event.data` (the runtime overrides `event` with the tool-call `input` at dispatch — single read site whether invoked by the LLM or a `type:"tool"` manifest action). `throw` to fail — the runtime converts it to `tool_result: is_error` so the LLM can self-correct. `ctx.lastResult` carries the previous tool's output forward server-side; this is how `fs.readFromInbox` → `parseResumeApi` passes a multi-KB base64 PDF without the LLM re-quoting (and corrupting) it. To add a global tool: create it under `packages/tools/src/<category>/`, export from that category's `index.ts`, and add a `REGISTRATIONS` entry in `registry.ts` (name + category + summary + optional argsSchema/configSchema/returnsSchema/examples/aliases).

**Catalog surface.** `listGlobalTools()` returns full metadata; `GET /v1/tools` (`apps/api/src/routes/v1/tools.ts`) serves it; the **"Agentic Tools"** portal page at `/portal/<tenant>/tools` (`apps/web/app/portal/[tenant]/(views)/tools/page.tsx`, hook `apps/web/lib/hooks/useTools.ts`) renders it as API docs with copy-paste manifest snippets. Browse there before writing a new tool.

**Back-compat aliases.** A tool can answer to multiple names (e.g. `fs.writeHtmlToArchive` ← `writeReportToDisk`, `writeBriefToDisk`; `fs.readFromInbox` ← `readResumeFromDisk`; `meta.ping` ← `monitorAndFetchRequirement`, `pingProbe`). Aliases are declared in the catalog entry and all resolve to the same descriptor, so older manifests keep working. The matching `tenants/*/src/tools/*.ts` files are now ~3-line re-export shims — new tool work goes in `packages/tools/`, not the tenant packages.

**`fs.*` data root.** Filesystem tools write under `data/<subdir>/<tenant>/…`. The root resolves via `AGENTIC_DATA_ROOT` (pinned: `.env` = `./data`, `apps/api/.env.local` = `../../data`) → else a `pnpm-workspace.yaml` walk-up → else `<cwd>/data` (`packages/tools/src/fs/_shared.ts`). **Keep `AGENTIC_DATA_ROOT` pinned** — relying on the walk-up means file locations silently move when a tool changes packages (this bit us during the global-tools migration; legacy artifacts stranded under `apps/api/data/`).

## Frontend layout note

**One UI.** The production UI is the Next.js App Router portal at
`apps/web/app/portal/[tenant]/(views)/*` — TypeScript, react-query, the only
application surface. The historical Babel/React SPA prototype that once lived
at `/demo` (`apps/web/public/demo/`) was **deleted for good** in 663eca0
(2026-07-20) per `docs/merge/2026-07-20-kenny-merge-playbook.md`; it must not be
restored, and `apps/web/public/` intentionally does not exist. (The web
Dockerfile creates that directory at build time — see the note there and
`apps/api/test/dockerfile-copy-paths.test.ts`.)

Routing:

- `/` → App Router redirect (`apps/web/app/page.tsx`) → `/portal`.
- `/portal` → `apps/web/app/portal/page.tsx` redirects to `/portal/<tenant>/dashboard`.
- `/portal/<tenant>/*` → real production UI.
- `/v1/*`, `/health` → proxied to apps/api on :3501.

**CSS tokens.** `apps/web` uses inline CSS-in-JS with CSS custom properties from `apps/web/styles/tokens.css` (+ `apps/web/app/global.css` for pseudo-selectors / media queries / `@keyframes`). The real token names are `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--border`, `--border-2`, `--text`, `--text-2`, `--text-3`, `--signal`, `--red`, etc. There is **no** `--surface-1`/`--border-1`/`--text-1`/`--danger` — referencing an undefined `var()` makes the browser fall back to `transparent`/inherited, which surfaces as a "see-through modal" bug. Match an existing component's tokens when styling new UI.

## Demo mode（已删除）

**demo 模式不存在了。** `AGENTIC_DEMO_MODE`、`apps/api/src/config/demo-mode.ts`、
`apps/api/src/routes/v1/demo.ts`、`apps/api/src/services/demo-runner.ts` 与
`apps/web/public/demo/` 都在 2026-07-20 前后被整体删除，理由见
`docs/merge/2026-07-20-kenny-merge-playbook.md`（"DEMO-MODE MUST STAY DELETED
EVERYWHERE"）。此处保留标题只为拦住「文档里写着、就去把它加回来」这条路。

仍然有效的那条架构规则：**生产模式零 mock / 零种子 / 零合成数据**。看板上出现的
每一行都必须来自真实事件。要造演示数据，就发真实事件（`POST /v1/events`），
不要重新引入一个会静默兜底的模式开关。

## Adding a tenant

Pure-declarative (manifest-only): drop `models/<slug>-v<n>/` with the five JSON files, add a row to `packages/db/src/seed.ts`, `pnpm db:seed`, restart api. Bootstrap auto-discovers and registers Inngest functions; the new tenant appears in the sidebar switcher. With only global tools in `tool_use[]`, **no tenant TypeScript package is needed at all.**

With custom tools/prompts: also create `tenants/<slug>/` (copy `tenants/raas/`), declare `"@tenants/<slug>": "workspace:*"` in `apps/api/package.json`, and register it in `TENANT_REGISTRIES` in `apps/api/src/bootstrap.ts`. This wiring lives in the api (not in `@agentic/runtime`) because pnpm's isolated module resolution requires each package to own its own deps. Slug derivation: lowercase the folder, strip `-vN` suffix (`RAAS-v1` → `raas`). Prefer adding reusable tools to `packages/tools/` over a tenant package.

## Conventions worth knowing

- IDs are prefixed strings (`run-…`, `evt-…`, `agt-…`, `tsk-…`) generated by `makeId(prefix)` from `@agentic/shared`. Timestamps are unix-ms.
- The RAAS canonical workflow ships with Chinese titles. `pnpm seed:rich` overlays English from the handoff prototype via `seedAgentMetadata()`; rerun it after `db:seed` if you want English-labeled agents in the UI.
- Workflow DAG layout is hand-tuned (stage + lane per kebab id) in the legacy workflows page — do not replace with auto-packing if you ever revive it.
- **Cancelling a run:** `POST /v1/runs/:id/cancel` — manifest agents stop via Inngest `cancelOn` keyed on `${tenantSlug}/run.cancel` matching subject; code agents poll `runs.status` between checkpoints in `packages/agents/src/run-engine.ts` and throw `RunCancelledError`. Idempotent — re-cancelling a terminal run returns 200 with `cancelled:false`.
- **Wrapping a third-party API as a tool:** verify the real response envelope before trusting a nested-field read. RoboHire's `match-resume` wraps its analysis under `data.data.*`; the normalizer initially read one level too shallow and silently returned `matchScore: null` for every candidate (the rubric then marked everyone `ERROR`). Probe the live API with curl when a tool's output looks empty/null but the call "succeeded".
- **`/parse-resume` is multipart-only.** RoboHire's resume parser rejects JSON bodies (`400 "PDF file is required"`); the field must be named `file`. `parseResumeApi` sends `FormData` + `Blob`. General lesson: don't assume a vendor endpoint is JSON.
