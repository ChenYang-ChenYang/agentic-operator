# Agentic Operator — Platform Catalog (V1)

**Owner:** Software architect (platform half).
**Sibling catalogs:** `docs/catalog/01-product-design-catalog.md` (UX/IA), `docs/catalog/02-ai-runtime-catalog.md` (agents + runtime + LLM).
**Authoritative sources cited throughout:** `CLAUDE.md`, `docs/DESIGN.md`, `docs/IMPLEMENTATION.md`, `docs/RUNBOOK.md`, `docs/CI.md`, `docs/USER_GUIDE.md`, `docs/design/import-workflow-manifest.md`, `docs/design/llm-gateway-and-baseagent.md`, and `docs/audits/p0-*..p4-*.md`.

This catalog enumerates the platform half of the product — the parts a software/SRE/DBA engineer cares about: process topology, monorepo layout, REST surface, database schema, migrations, auth + tenancy, on-disk storage, the manifest-import safety dance, the CLI, the web app's shell, the build/dev/test machinery, CI/CD, observability, env contract, and the open V1 gaps. Every catalogued feature carries a stable ID of the form `PF-<SUBSYSTEM>-<NN>` so peer reviews and audit docs can quote them unambiguously. Status legend: ✅ V1 (in production today), 🟡 V1.1 (incomplete but partially wired), 🔵 V2 (planned, not started).

---

## 1. System topology (`PF-TOP-*`)

The product is a **two-process split with a shared Zod contract package**. Web is UI-only (no DB), API owns every persistence write. A third long-running process — the Inngest broker — queues durable events and POSTs them at the API's webhook adapter. Boot ordering matters because Next.js relies on the API being alive (rewrites point at it) and Inngest registers its function catalog by polling the API after it comes up.

### PF-TOP-01 — Dev-mode process map (`pnpm dev`) ✅
The root `package.json` script orchestrates three child processes via `concurrently`:
```
pnpm dev → concurrently -n web,api,inngest \
  "pnpm --filter @agentic/web run dev"       # port 3599 (Next.js + Turbopack)
  "pnpm --filter @agentic/api run dev"       # port 3501 (Fastify)
  "npx -y inngest-cli@latest dev -u http://localhost:3501/inngest"  # port 8288
```
`predev` at `package.json:11` kills anything squatting on `3599,3501,8288,8289,50052,50053` before the cluster starts so a stuck process never silently shadows the new boot. The `/health` endpoint at `apps/api/src/routes/health.ts:11-26` returns the live `HealthReport` contract with subsystem checks (`inngest`, `sqlite`, `disk`) — anything but `ok:true` flips the response code to 503. Used by Docker `HEALTHCHECK` (PF-OPS) and by uptime probes. Test: `apps/api/test/tc-52-p4-metrics-health.test.ts` asserts the response shape including the optional `version`, `schemaVersion`, `llmGateway` fields added by P4-API-04.

### PF-TOP-02 — Production process map (docker-compose) ✅
`docker-compose.yml` at repo root builds three services (`api`, `web`, `inngest`) on a single bridge network named `agentic`. Bind mounts:
- `agentic-data:/app/data` (named volume) — SQLite WAL, logs, artifacts, tenants.
- `./models:/app/models:ro` — workflow manifests, mounted read-only into the API.
Healthcheck inheritance: each Dockerfile declares its own `HEALTHCHECK` so `depends_on: { condition: service_healthy }` works at the compose level. The API container alone reads `data/`; web has no DB access by design (PF-WEB-01). The web image embeds `AGENTIC_API_URL=http://api:3501` at build time (Next.js rewrites are compiled in). See `docker-compose.yml:1-100` and `docs/RUNBOOK.md` for the operator playbook.

### PF-TOP-03 — Port map ✅
| Port | Service | Notes |
|---|---|---|
| 3599 | Next.js web | `next dev` → Turbopack in dev; `next start` in prod. |
| 3501 | Fastify API | All `/v1/*` + `/health` + `/metrics` + `/inngest` webhook. |
| 8288 | Inngest dev broker | Polls `http://localhost:3501/inngest` for function registry. |
| 8289 | Inngest dev internals | Pre-killed by `predev`; freed for safety. |
| 50052 | Inngest gRPC | Pre-killed by `predev`. |
| 50053 | Inngest gRPC | Pre-killed by `predev`. |

Web rewrites (`apps/web/next.config.mjs`) forward `/v1/*` and `/health` to `http://localhost:3501`. The bare-root `/` rewrites to `/portal-legacy/index.html` (legacy SPA escape hatch). Production navigation never depends on the bare-root rewrite — see PF-WEB-07.

### PF-TOP-04 — Boot ordering ✅
1. **API boots first.** `apps/api/src/server.ts:36-79` constructs Fastify, registers the error envelope plugin (PF-API plumbing) and the auth plugin (PF-AUTH-01..02), runs `bootstrapRuntime()` (loads all manifests + registers Inngest functions), then registers the `/v1/*` mountpoint and `/inngest` webhook adapter (`apps/api/src/routes/inngest.ts`).
2. **Inngest boots second.** The CLI starts and polls `http://localhost:3501/inngest` until the API responds with its function manifest. Functions registered include one per `(tenant × agent)` per `packages/runtime/src/register.ts`.
3. **Web boots third.** Next.js comes up and immediately begins forwarding `/v1/*` to the API. If the API isn't up yet, the user sees `502 BAD_GATEWAY` until it is.

The dev concurrency runner does not enforce strict ordering — it boots all three in parallel. In production, `depends_on: { condition: service_started }` in `docker-compose.yml` enforces a soft ordering (api → web; inngest → api). The "service_started" predicate is intentionally weaker than "service_healthy" so a slow first DB migration on api boot doesn't deadlock the stack.

---

## 2. Monorepo (`PF-MR-*`)

`pnpm-workspace.yaml` declares three workspace globs: `apps/*`, `packages/*`, `tenants/*`. The `allowBuilds:` block whitelists native modules pnpm 11 is permitted to compile at install time (`better-sqlite3`, `esbuild`, `protobufjs`, `sharp`, `unrs-resolver`). Without that allow-list pnpm halts with `ERR_PNPM_IGNORED_BUILDS` because lifecycle scripts are gated for security by default in pnpm 11.

Workspaces (14 total — 4 apps, 9 packages, 1 tenant):

### PF-MR-01 — `apps/api` (Fastify 5, `@agentic/api`) ✅
The only DB writer in the system. Entrypoint `apps/api/src/server.ts:36`. Build via `tsx --env-file=../../.env --env-file=.env.local src/server.ts`. Dependencies: `@agentic/{agents,contracts,db,llm-gateway,runtime,shared,tools}`, `@tenants/raas`, `fastify`, `@fastify/cors`, `drizzle-orm`, `inngest@4.4.0`, `zod`. No JS emit — the Dockerfile runs `tsc --noEmit` as a build gate and the runtime container also executes via `tsx`. See `apps/api/Dockerfile`.

### PF-MR-02 — `apps/web` (Next.js 16, `@agentic/web`) ✅
React 19 + App Router. Zero DB access — every read goes through `/v1/*` via `apps/web/lib/api-client.ts`. `next.config.mjs` rewrites: `/v1/*` and `/health` → `http://localhost:3501`. Style policy: inline `style={{}}` only (PF-WEB-05). ESLint flat-config under `apps/web/eslint.config.mjs` bans inline numeric `zIndex` under `app/portal/**/*.tsx`. Dockerfile uses Next's `output: "standalone"` so the runtime image only carries the compiled server + node_modules subset (P4-OPS-02).

### PF-MR-03 — `apps/cli` (`@agentic/cli`, binary `agentic`) ✅
Commander-free hand-rolled arg parser at `apps/cli/src/cli.ts:1-60`. Four commands (PF-CLI-01..04). Build emits a shim under `dist/`. The cli threads stdin/stdout/stderr through a `ctx` object so vitest can exercise every code path without spawning a subprocess — that's why the workspace meets the 70/60 coverage gate (PF-BUILD-10).

### PF-MR-04 — `apps/inngest-worker` (Dockerfile-only wrapper) ✅
Not a TypeScript workspace — only a `Dockerfile` wrapping the official `inngest/inngest:latest` image. Decision documented in `docs/audits/p4-ops-status.md §2`: agent code stays in-process inside the API container so steps can read SQLite directly; the Inngest broker is a separate container only because the official image is more battle-tested for queueing than a hand-rolled one. The api's `bootstrapRuntime()` call registers durable functions; the broker queues + replays events.

### PF-MR-05 — `packages/agents` (`@agentic/agents`) ✅
Canonical home of `BaseAgent`, the code-agent registry, multi-turn tool/repair run engine, system roster and durable code-agent Inngest functions. The API and TC-16/17 consume this same package; the unused parallel `agent-runtime` workspace was removed to prevent behavioral drift.

### PF-MR-06 — `packages/agent-sdk` (formerly `@agentic/agent-kit`) ✅
Public SDK exports: `defineTool`, `definePrompt`, `MemoryHandle`, `TenantRegistry`. Consumed by `packages/runtime` for the step-engine tool dispatch. Tenant packages (e.g. `tenants/raas`) declare custom tools/prompts against this SDK and register them in the api's `TENANT_REGISTRIES` constant at `apps/api/src/bootstrap.ts`.

### PF-MR-07 — `packages/contracts` ✅
The Zod schema source-of-truth for every `/v1/*` request and response shape. API validates inbound bodies + querystrings; web parses outbound JSON through the same Zod schemas via the typed `apiClient.get<Z>()` helper at `apps/web/lib/api-client.ts`. Schemas include `IngestEventBody`, `ListEventsQuery`, `RunRow`, `StepRow`, `AgentSpec`, `ActionSpec`, `HealthReport`, `AgentToolUse`. Schema is `.passthrough()` per DESIGN.md §10.1 for the V1 migration window — additive fields don't break older callers.

### PF-MR-08 — `packages/db` ✅
Drizzle schema, migration runner, tenant-scope helpers. Exports: `getDb()`, `getRawSqlite()`, `tenantScope()`, the 23 table objects, the migrations folder, and a `backup.ts` helper backing `pnpm db:backup` (P4-OPS-06). Schema lives at `packages/db/src/schema.ts:1-717`. Drizzle config at `packages/db/drizzle.config.ts`; migrations at `packages/db/drizzle/0000_*..0013_*.sql`.

### PF-MR-09 — `packages/llm-gateway` ✅
14-provider gateway fronting `mock`, `anthropic`, `openai`, `openrouter`, `gemini`, `azure`, `groq`, `together`, `mistral`, `deepseek`, `qwen`, `bedrock`, `vertex`, `custom`. A single singleton is constructed in `apps/api/src/services/llm.ts` and injected into BaseAgent + the manifest step engine at boot via `setAgentGateway` / `setRuntimeGateway` (see `apps/api/src/bootstrap.ts`). Catalog metadata lives in `@agentic/contracts/providers`. Design: `docs/design/llm-gateway-and-baseagent.md`.

### PF-MR-10 — `packages/runtime` ✅
The manifest loader, agent registry, step engine, lint pass, migrations runner for manifests, log writer. Inngest functions live here. The bootstrap routine at `packages/runtime/src/bootstrap.ts` walks `models/<slug>-v<n>/` directories, parses each `workflow*.json` via the `AgentSpec`/`ActionSpec` Zod schemas, then calls `register.ts` to materialize one Inngest function per agent.

### PF-MR-11 — `packages/shared` ✅
`makeId(prefix)` (ULID-ish prefixed strings — `run-…`, `evt-…`, `agt-…`, `tsk-…`, `dpl-…`), SSE frame helper, common types. The `appendToLedger()` helper that writes NDJSON event logs is also re-exported from `@agentic/runtime` (PF-STO-03).

### PF-MR-12 — `packages/tools` ✅
First-party mock tools: `http.fetch`, `llm.call`, `channel.publish`. Used by the manifest step engine's `tool_use` action variant.

### PF-MR-13 — `tenants/raas` (example tenant) ✅
Custom tools/prompts/registry for the RAAS demo tenant. Declared in `apps/api/package.json` as `"@tenants/raas": "workspace:*"` and registered in `TENANT_REGISTRIES` (`apps/api/src/bootstrap.ts`). This wiring lives in the API (not in `@agentic/runtime`) because pnpm's isolated module resolution requires each package to own its own deps. Adding a second tenant of this style takes ~15 minutes per CLAUDE.md.

### PF-MR-14 — `packages/agents/src/system/` ✅
The production system-level code-agent roster is compiled and registered from
the canonical package. `testAgent` is an isolated harness utility: it is
registered and routed through `__system` only when `NODE_ENV=test`, and never
appears in a development or production bootstrap.

---

## 3. API surface — `/v1/*` (`PF-API-*`)

Every route registered in `apps/api/src/server.ts:75-99`. The error envelope plugin at `apps/api/src/plugins/error.ts` wraps any `reply.ok(data)` call into `{ok:true, data:…}` and any thrown error into `{ok:false, error:{code,message}}` — **except** the manifest-import route which sends flat 409/423 envelopes (see PF-WEB-06 + PF-IMP-06). Rate-limit class is uniform (`100/min/tenant` by default; see PF-API-PLUMBING below).

### Cross-cutting plumbing
- **Auth.** Bearer in prod, dev tenant in `AUTH_MODE=dev`. See PF-AUTH-01..02.
- **Audit.** Mutating routes call `recordAudit({action, target, ...})` (see `apps/api/src/plugins/audit.ts`). Action names are catalogued inline per route.
- **Rate limit.** `apps/api/src/plugins/security.ts` runs a sliding-window counter keyed on `tenantId ?? ip`. Default 100/min, disabled in `NODE_ENV=test`. 429s carry a `Retry-After` header.
- **Body cap.** `AGENTIC_BODY_LIMIT_BYTES` default 1 MiB (PF-API-03).
- **CORS.** `WEB_ORIGIN` allow-listed via `@fastify/cors` (`apps/api/src/server.ts:69-74`); credentials allowed; `x-request-id` echoed.
- **Idempotency.** Only `POST /v1/events` and `POST /v1/agents/:name/invoke` honor an `Idempotency-Key` header by short-circuiting if the same key has been seen for the same tenant in the last 24h. (Tracked under V1.1 — see PF-GAP-09.)

### `events.ts` — Event ledger (PF-API-EVT-*)
- **PF-API-EVT-01** `POST /v1/events` (`events.ts:40`) — auth required (bearer). Body: `IngestEventBody` (`{name, subject?, payload?, source?, test?}`). Returns 200 with `{ok:true, data:{id}}`. Persists to `events` table + appends to NDJSON ledger via `appendToLedger`. Audit action: `event.ingest`. Idempotent if `Idempotency-Key` provided. ✅
- **PF-API-EVT-02** `POST /v1/events/:id/replay` (`events.ts:140`) — auth required. Re-emits the named event under a fresh `evt-…` id via `inngest.send`. P0-API-01 fixed this to use `makeId("evt")`. Audit action: `event.replay`. ✅
- **PF-API-EVT-03** `GET /v1/events` (`events.ts:202`) — auth required. Querystring `ListEventsQuery`. Returns the recent ledger snapshot scoped to tenant. ✅
- **PF-API-EVT-04** `GET /v1/events/catalog` (`events.ts:210`) — auth required. Returns the `event_types` rows for the caller's tenant. ✅
- **PF-API-EVT-05** `GET /v1/events/stream` (`events.ts:219`) — SSE, auth required. Live tail of `events` table polling every 250ms; 15s heartbeat; 30-min hard timeout. Per `docs/design/event-tester.md §4.2`. ✅
- **PF-API-EVT-06** `GET /v1/events/causality` (`events.ts:244`) — auth required. Returns the DAG of triggered events keyed off `parent_run_id`. Used by the Events causality view. ✅

### `runs.ts` + `runs-logs.ts` (PF-API-RUN-*)
- **PF-API-RUN-01** `GET /v1/runs` (`runs.ts:14`) — auth required. Querystring filters: `agentId`, `status`, `since`, `parentRunId`, `isTest`. Tenant-scoped. ✅
- **PF-API-RUN-02** `GET /v1/runs/:id` (`runs.ts:28`) — auth required. Returns the run row + step list + emitted-event metadata. P0-AUTH-02 ensures cross-tenant lookups 404. ✅
- **PF-API-RUN-03** `POST /v1/runs/:id/cancel` (`runs.ts:39`) — auth required. Marks run `cancelled` and short-circuits future steps. Audit action: `run.cancel`. ✅
- **PF-API-RUN-04** `GET /v1/runs/:id/logs` (`runs-logs.ts:30`) — SSE, auth required. Querystring `follow=1` keeps the stream open. Reads from `data/logs/<tenant>/runs/<date>/<run-id>.log`. ✅

### `agents.ts` + `agent-invoke.ts` (PF-API-AGT-*)
- **PF-API-AGT-01** `GET /v1/agents?kind=all|manifest|code` (`agents.ts:61`) — auth required. Lists agents in the caller's tenant. The `tenant=…` query param is a no-op (P0-AUTH-03). ✅
- **PF-API-AGT-02** `GET /v1/agents/:kebab` (`agents.ts:85`) — auth required. Detail row (manifest + version history). ✅
- **PF-API-AGT-03** `POST /v1/agents` (`agents.ts:97`) — auth required. Saves a manifest. Audit action: `agent.save`. **🟡 Known V1 bug:** 500s on tenants with a live `tenant_code` deployment (PF-GAP-02).
- **PF-API-AGT-04** `POST /v1/agents/:name/invoke` (`agent-invoke.ts:38`) — auth required. Synchronously invokes a code agent through `BaseAgent.run()`; falls back to a manifest-based invocation if the named agent is registered as a manifest agent (option B). The test-only `testAgent` runs under `__system` in the isolated harness; production does not register it. Audit action: `agent.invoke`. ✅

### `tasks.ts` (PF-API-TSK-*)
- **PF-API-TSK-01** `GET /v1/tasks` (`tasks.ts:12`) — auth required. Lists tenant tasks. ✅
- **PF-API-TSK-02** `GET /v1/tasks/:id` (`tasks.ts:19`) — auth required. Detail. ✅
- **PF-API-TSK-03** `POST /v1/tasks/:id/resolve` (`tasks.ts:27`) — auth required. Resolves a HITL task; emits `task.resolved` event keyed on `taskId` so the awaiting Inngest function (PF-IMP discipline) wakes. Audit action: `task.resolve`. ✅

### `deployments.ts` (PF-API-DPL-*)
- **PF-API-DPL-01** `GET /v1/deployments` (`deployments.ts:10`) — auth required. List per-tenant, includes status. ✅
- **PF-API-DPL-02** `POST /v1/deployments/:id/rollback` (`deployments.ts:20`) — auth required. Demotes the current `live` row to `rolled_back`, promotes the named row to `live`, re-emits Inngest registry. Audit action: `deployment.rollback`. ✅

### `webhooks.ts` (PF-API-WHK-*)
- **PF-API-WHK-01** `POST /v1/webhooks/:provider` (`webhooks.ts:32`) — public (HMAC verified). Per-source HMAC secret from `webhook_subscriptions` row, falling back to `WEBHOOK_HMAC_SECRET_DEFAULT`. Audit action: `webhook.ingest`. ✅

### `workflow.ts` (PF-API-WF-*) 🟡
- **PF-API-WF-01** `GET /v1/workflow/schema` (`workflow.ts:157`) — auth required. JSON-Schema export of the workflow contract. ✅
- **PF-API-WF-02** `GET /v1/tenants/:slug/workflow` (`workflow.ts:166`) — auth required. Reads the canonical workflow manifest. ✅
- **PF-API-WF-03** `PUT /v1/tenants/:slug/workflow` (`workflow.ts:219`) — auth required. Saves a workflow manifest. Audit action: `workflow.save`. ✅ (Note: per `apps/api/src/server.ts` this route is *not yet registered* — see PF-GAP-01.)

### `manifest-import.ts` (PF-API-IMP-*)
- **PF-API-IMP-01** `POST /v1/tenants/:slug/manifest-import` (`manifest-import.ts:71`) — auth required. Body has `mode: "validate"|"commit"`. Locks via `deployments(status=pending, expires_at=now+1h)`. See full flow in PF-IMP-*. ✅
- **PF-API-IMP-02** `DELETE /v1/tenants/:slug/manifest-import/:deployment_id` (`manifest-import.ts:150`) — auth required. Releases a pending lock. ✅
- **PF-API-IMP-03** `POST /v1/tenants/:slug/manifest-import/fetch-url` (`manifest-import.ts:190`) — auth required. SSRF-guarded fetch of a remote manifest URL. ✅
- **PF-API-IMP-04** `POST /v1/tenants/:slug/manifest-import/fetch-repo` (`manifest-import.ts:284`) — 501 placeholder (V2). 🔵

### `reads.ts` (PF-API-RDS-*)
- **PF-API-RDS-01** `GET /v1/counts` (`reads.ts:13`) — auth required. Dashboard cards. ✅
- **PF-API-RDS-02** `GET /v1/workflows/dag` (`reads.ts:18`) — auth required. The hand-tuned stage/lane DAG layout for the Workflow view. ✅
- **PF-API-RDS-03** `GET /v1/event-types` (`reads.ts:23`) — auth required. Catalog rows for the Event Tester. ✅
- **PF-API-RDS-04** `GET /v1/entity-types` (`reads.ts:28`) — auth required. Entity catalog. ✅

### `audit.ts` (PF-API-AUD-*)
- **PF-API-AUD-01** `GET /v1/audit` (`audit.ts:39`) — auth required. Tenant-scoped audit log with `?action=`, `?since=`, `?limit=` filters. ✅

### `budgets.ts` (PF-API-BUD-*)
- **PF-API-BUD-01** `GET /v1/budgets` (`budgets.ts:74`) — auth required. Tenant budgets row. ✅
- **PF-API-BUD-02** `PUT /v1/budgets` (`budgets.ts:80`) — auth required. Audit action: `budget.update`. ✅

### `usage.ts` (PF-API-USE-*) 🟡
- **PF-API-USE-01** `GET /v1/usage` (`usage.ts:81`) — auth required. Aggregated token + cost totals by provider/model. **🟡 PF-GAP-01: registered in the route file but not wired into `apps/api/src/server.ts`** — the Settings → Usage page currently 404s.

### `tenants.ts` (PF-API-TEN-*)
- **PF-API-TEN-01** `GET /v1/tenants/:slug` (`tenants.ts:530`) — auth required. ✅
- **PF-API-TEN-02** `POST /v1/tenants` (`tenants.ts:545`) — platform-admin only. Audit action: `tenant.create`. ✅
- **PF-API-TEN-03** `PUT /v1/tenants/:slug` (`tenants.ts:614`) — platform-admin only. Audit action: `tenant.update`. ✅
- **PF-API-TEN-04** `DELETE /v1/tenants/:slug` (`tenants.ts:681`) — platform-admin only. Archives (sets `archived_at`); hard-delete is a separate op. Audit action: `tenant.archive`. ✅
- **PF-API-TEN-05** `POST /v1/tenants/:slug/tokens` (`tenants.ts:767`) — platform-admin only. Issues a bearer token; returns the plaintext exactly once. Audit action: `token.issue`. ✅

### `tenant-code.ts` (PF-API-TC-*)
- **PF-API-TC-01** `POST /v1/tenants/:slug/code` (`tenant-code.ts:75`) — auth required. Accepts a USTAR tarball of tenant code; explodes under `data/tenants/<slug>/<version>/`. Used by `agentic deploy`. Audit action: `tenant.code.deploy`. ✅

### `llm.ts` (PF-API-LLM-*)
- **PF-API-LLM-01** `GET /v1/llm/providers` (`llm.ts:47`) — auth required. The 14-provider catalog. ✅
- **PF-API-LLM-02** `GET /v1/llm/models?provider=` (`llm.ts:53`) — auth required. Models per provider. ✅
- **PF-API-LLM-03** `GET /v1/llm/catalog` (`llm.ts:74`) — auth required. Composite catalog. ✅
- **PF-API-LLM-04** `GET /v1/llm/providers/keys` (`llm.ts:81`) — auth required. List configured keys (no plaintext). ✅
- **PF-API-LLM-05** `GET /v1/llm/providers/:id/key` (`llm.ts:85`) — auth required. Check key presence. ✅
- **PF-API-LLM-06** `POST /v1/llm/providers/:id/key` (`llm.ts:95`) — auth required. Set/rotate (BYOK). Audit action: `llm.key.rotate`. ✅
- **PF-API-LLM-07** `POST /v1/llm/providers/:id/test` (`llm.ts:146`) — auth required. Roundtrip a smoke call. ✅
- **PF-API-LLM-08** `GET/POST/PATCH/DELETE /v1/llm/fleet[/:id]` (`llm.ts:173..253`) — auth required. CRUD for the per-tenant model fleet rotation policy. ✅

### `artifacts.ts` (PF-API-ART-*)
- **PF-API-ART-01** `GET /v1/artifacts/:id` (`artifacts.ts:9`) — auth required. Streams a file from `data/artifacts/<tenant>/<run-id>/<filename>`. Tenant ownership verified before stream. ✅

### `stream.ts` (PF-API-STR-*) 🟡
- **PF-API-STR-01** `GET /v1/stream` (`stream.ts:30`) — auth required. Generic SSE multiplexer. Not registered in `server.ts` yet (per inline comment). 🟡

### Health, metrics, inngest
- **PF-API-HLT-01** `GET /health` (`apps/api/src/routes/health.ts:11`) — public. ✅
- **PF-API-MET-01** `GET /metrics` (`apps/api/src/routes/metrics.ts:13`) — public (firewall-bound in prod). Prometheus text exposition. ✅
- **PF-API-INN-01** `GET|POST|PUT /inngest` (`apps/api/src/routes/inngest.ts:13`) — Inngest serve adapter. ✅

---

## 4. Database schema (`PF-DB-*`)

`packages/db/src/schema.ts:1-717` declares 23 tables. SQLite (better-sqlite3 native). IDs are prefixed strings via `makeId(prefix)` from `@agentic/shared`. Timestamps are unix-epoch milliseconds (`integer mode timestamp_ms`). Every user-visible table carries `tenant_id` enforced at query time via `tenantScope()` from `@agentic/db` (PF-AUTH-05). Direct `getDb()` access bypasses tenant scope — a documented foot-gun.

### PF-DB-01 — `tenants` (schema.ts:28)
Cols: `id`, `slug` (unique), `name`, `subtitle?`, `color?`, `createdAt`, `archivedAt?` (lifecycle), `updatedAt`. Indexes: `tenants_slug_uq` (unique), `tenants_archived_at_idx`. No FKs (root entity). Tenant-scoped: N/A (this *is* the tenant). Reads: high (every authenticated request looks up by slug). Writes: low (admin only). Migration: `0011_tenant_lifecycle.sql` introduced `archived_at`+`updated_at`. ✅

### PF-DB-02 — `users` (schema.ts:57)
Cols: `id`, `email` (unique), `name`, `createdAt`. FKs: none. Tenant-scoped: N/A (cross-tenant). Reads: auth lookups. Writes: admin only. Migration: `0000`. ✅

### PF-DB-03 — `memberships` (schema.ts:72)
Cols: `userId` (FK users cascade), `tenantId` (FK tenants cascade), `role` (`admin|operator|viewer`). PK: composite (`userId`, `tenantId`). Tenant-scoped: yes. Reads: per-request authz check. Writes: admin only. Migration: `0000`. ✅

### PF-DB-04 — `workflows` (schema.ts:90)
Cols: `id`, `tenantId` (FK), `slug`, `name`, `createdAt`. Indexes: `workflows_tenant_slug_uq` (unique), `workflows_tenant_idx`. Tenant-scoped: yes. Reads: workflow list + dag. Writes: manifest import. Migration: `0000`. ✅

### PF-DB-05 — `workflow_versions` (schema.ts:109)
Cols: `id`, `workflowId` (FK cascade), `version`, `manifestJson` (json), `actionsJson?` (json), `createdAt`, `createdBy?` (FK users). Unique: (`workflowId`, `version`). Tenant-scoped: indirect (via workflow). Reads: detail. Writes: manifest import. Migration: `0000`. ✅

### PF-DB-06 — `deployments` (schema.ts:132)
Cols: `id`, `tenantId` (FK cascade), `target` (`workflow|agent|runtime|code_agent`), `versionId`, `status` (`live|rolled_back|pending`), `deployedBy?` (FK users), `deployedAt`, `note?`, `expiresAt?` (for pending lock — null for live), `filePath?` (tmp staging path; nulled after rename). Indexes: `dpl_tenant_status_idx`, `dpl_version_idx`, `deployments_expires_at_idx`, `deployments_file_path_idx`. Tenant-scoped: yes. Reads: deployment list + status checks. Writes: every manifest import + every rollback. Migration: `0000` + `0012_import_recovery.sql` added `expires_at`/`file_path`. ✅

This is the **central locking table** for the manifest-import safety dance — its `id` IS the import session token (no separate column). See PF-IMP-06.

### PF-DB-07 — `agents` (schema.ts:178)
Cols: `id`, `workflowId` (FK cascade), `kebabId`, `name`, `title?`, `actor` (`Agent|Human`), `kind` (`manifest|code` default `manifest`), `enabled` (bool default true). Indexes: `agents_workflow_kebab_uq` (unique), `agents_workflow_idx`. Tenant-scoped: indirect (via workflow). Reads: agents list view + run dispatch. Writes: bootstrapTenant + manifest import. Migration: `0000` + `0002_bright_apocalypse.sql` added `kind`/`enabled`. ✅

### PF-DB-08 — `agent_versions` (schema.ts:205)
Cols: `id`, `agentId` (FK cascade), `workflowVersionId` (FK cascade), `manifestJson` (json). Unique: (`agentId`, `workflowVersionId`). Tenant-scoped: indirect. Reads: agent detail. Writes: manifest import + code-agent deploy. Migration: `0000`. ✅

### PF-DB-09 — `events` (schema.ts:227)
Cols: `id`, `tenantId` (FK cascade), `name`, `category?`, `sourceAgentId?` (FK agents), `subject?`, `receivedAt`, `payloadRef?`, `deletedAt?` (soft-delete tombstone). Indexes: `evt_tenant_name_received_idx`, `events_deleted_at_idx`, `evt_tenant_received_idx` (added in `0013` as a covering index for the SSE poll), `evt_tenant_subject_idx`. Tenant-scoped: yes. Reads: very hot (Event Tester SSE polls 250ms). Writes: every `POST /v1/events`. Migration: `0000` + `0007_soft_delete.sql` + `0013_confused_vertigo.sql`. ✅

### PF-DB-10 — `event_listeners` (schema.ts:265)
Cols: `eventName`, `agentId` (FK cascade). PK: composite (`eventName`, `agentId`). Tenant-scoped: indirect. Reads: dispatch on event ingest. Writes: bootstrap + manifest import. Migration: `0000`. ✅

### PF-DB-11 — `runs` (schema.ts:281)
Cols: `id`, `tenantId` (FK cascade), `agentId` (FK), `agentVersionId?` (FK), `triggerEventId?` (FK), `parentRunId?` (subflow trace), `status` (`queued|running|ok|failed|waiting|cancelled`), `startedAt?`, `endedAt?`, `durationMs?`, `tokensIn?`, `tokensOut?`, `model?`, `emittedEventId?`, `errorMessage?`, `logPath?`, `correlationId` (NOT NULL), `subject?`, `deletedAt?`, `isTest` (bool default false). Indexes: `runs_tenant_started_idx`, `runs_tenant_status_idx`, `runs_agent_idx`, `runs_correlation_idx`, `runs_subject_idx`, `runs_deleted_at_idx`, `runs_is_test_idx`, `runs_parent_run_idx` (`0004`). Tenant-scoped: yes. Reads: dashboard active-runs strip + runs list + run detail. Writes: every Inngest step.run produces a transition. Migration: `0000` + `0004_parent_run.sql` + `0007` + `0008_runs_is_test.sql`. ✅

### PF-DB-12 — `steps` (schema.ts:334)
Cols: `id`, `runId` (FK cascade), `ord`, `name`, `type` (`tool|logic|manual`), `status` (`pending|running|ok|failed|skipped`), `startedAt?`, `endedAt?`, `durationMs?`, `inputRef?`, `outputRef?`, `error?`, `provider?`, `model?`, `tokensIn?`, `tokensOut?`. Index: `steps_run_ord_idx`. Tenant-scoped: indirect. Reads: run detail timeline. Writes: every step transition. Migration: `0000` + `0002` (LLM fields). ✅

### PF-DB-13 — `tasks` (schema.ts:365)
Cols: `id`, `tenantId` (FK cascade), `runId?` (FK cascade), `type`, `title`, `awaitingRole?`, `awaitingUserId?` (FK), `priority` (`low|medium|high` default `medium`), `status` (`open|resolved|snoozed` default `open`), `createdAt`, `resolvedAt?`, `resolvedBy?` (FK), `payloadJson?` (json), `resolutionJson?` (json), `deletedAt?`. Indexes: `tasks_tenant_status_idx`, `tasks_run_idx`, `tasks_deleted_at_idx`. Tenant-scoped: yes. Reads: Tasks view. Writes: HITL `step.run` + resolve route. Migration: `0000` + `0007`. ✅

### PF-DB-14 — `artifacts` (schema.ts:402)
Cols: `id`, `tenantId` (FK cascade), `runId` (FK cascade), `kind`, `path`, `size`, `createdAt`. Index: `art_run_idx`. Tenant-scoped: yes. Reads: run detail. Writes: `writeArtifact` from `packages/runtime/src/artifacts.ts`. Migration: `0000`. ✅

### PF-DB-15 — `audit_log` (schema.ts:426)
Cols: `id`, `tenantId` (FK cascade), `actorUserId?` (FK), `action`, `targetType?`, `targetId?`, `at`, `metaJson?` (json). Indexes: `audit_tenant_at_idx`, `audit_target_idx`. Tenant-scoped: yes. Reads: Settings → Audit. Writes: every mutating route via `recordAudit`. Migration: `0000`. ✅

### PF-DB-16 — `api_tokens` (schema.ts:446)
Cols: `id`, `tenantId` (FK cascade), `hash` (sha256), `name`, `scopes` (json string[]), `createdAt`, `lastUsedAt?`. Unique: `tok_hash_uq`. Index: `tok_tenant_idx`. Tenant-scoped: yes. Reads: every bearer-auth request. Writes: token issuance + `lastUsedAt` bump per use. Migration: `0000`. ✅

### PF-DB-17 — `event_types` (schema.ts:469)
Cols: `tenantId` (FK cascade), `name`, `category?`, `color?`, `description?`, `payloadJson?` (json). PK: composite (`tenantId`, `name`). Tenant-scoped: yes. Reads: Event Tester catalog + per-ingest category stamp. Writes: bootstrap + ontology editor. Migration: `0000` + `0003_temporal_columns.sql` (created_at/updated_at). ✅

### PF-DB-18 — `entity_types` (schema.ts:486)
Cols: `tenantId` (FK cascade), `entityId`, `name`, `description?`, `primaryKeyName?`, `propertiesJson?` (json). PK: composite (`tenantId`, `entityId`). Tenant-scoped: yes. Reads: Ontology view. Writes: ontology editor. Migration: `0001_loud_blue_blade.sql` + `0003`. ✅

### PF-DB-19 — `tenant_budgets` (schema.ts:505)
Cols: `tenantId` (PK, FK cascade), `monthlyTokenCap?`, `monthlyUsdCap?` (cents), `usedTokensMonth` (default 0), `usedUsdMonth` (default 0, cents), `periodStart`, `updatedAt`. Tenant-scoped: yes (PK). Reads + writes: LLM gateway on every chat call. Migration: `0005_tenant_budgets.sql`. ✅

### PF-DB-20 — `_meta` (schema.ts:523)
Cols: `key` (PK), `value`, `updatedAt`. Holds `schema_version` for the boot-time refuse-start check (older binary vs newer DB). Tenant-scoped: no (global). Migration: `0006_schema_meta.sql`. ✅

### PF-DB-21 — `webhook_subscriptions` (schema.ts:533)
Cols: `id`, `tenantId` (FK cascade), `source`, `secretEncrypted`, `signingAlgo` (default `hmac-sha256`), `enabled` (default true), `createdAt`, `updatedAt`. Unique partial: `webhook_sub_tenant_source_uq` WHERE `enabled = 1`. Partial index: `webhook_sub_source_idx`. Tenant-scoped: yes. Reads: every `/v1/webhooks/:source` request to look up the per-tenant secret. Writes: Settings → Webhooks. Migration: `0009_webhook_subscriptions.sql`. ✅

### PF-DB-22 — `agent_memory_short` (schema.ts:563)
Cols: `runId` (FK cascade), `key`, `valueJson`, `updatedAt`. PK: composite (`runId`, `key`). Per-run scratch storage; evicted when the run terminates. Tenant-scoped: indirect. Migration: `0010_agent_memory.sql`. ✅

### PF-DB-23 — `agent_memory_long` (schema.ts:581)
Cols: `tenantId` (FK cascade), `agentName`, `subject`, `key`, `valueJson`, `createdAt`, `updatedAt`. PK: composite (`tenantId`, `agentName`, `subject`, `key`). Persists across runs for the same subject. Indexes: `agent_memory_long_tenant_agent_idx`, `agent_memory_long_subject_idx`. Tenant-scoped: yes. Migration: `0010`. ✅

---

## 5. Migrations (`PF-MIG-*`)

`packages/db/drizzle/` holds 14 SQL migration files (numbering `0000…0013`). `drizzle-kit` regenerates the file-set via `pnpm db:generate` after edits to `schema.ts`. The runtime applies them via `runMigrations(folder)` from `@agentic/db` at api boot (`bootstrapRuntime()` step 0, per P0-MIG-01).

### PF-MIG-01 — `0000_colorful_moira_mactaggert.sql` ✅
Drizzle-generated baseline. Creates all initial tables: `tenants`, `users`, `memberships`, `workflows`, `workflow_versions`, `deployments`, `agents`, `agent_versions`, `events`, `event_listeners`, `runs`, `steps`, `tasks`, `artifacts`, `audit_log`, `api_tokens`, `event_types`. Establishes the foreign-key cascade graph. No drift impact — establishing baseline.

### PF-MIG-02 — `0001_loud_blue_blade.sql` ✅
Adds `entity_types` table (RF-1.4 — per-tenant entity catalog). Tenant-scoped composite PK. Used by the Ontology view.

### PF-MIG-03 — `0002_bright_apocalypse.sql` ✅
Adds `agents.kind`/`enabled` (manifest vs code agent + on/off switch), `steps.provider`/`model`/`tokens_in`/`tokens_out` (LLM gateway fields). Drift impact: every `steps` insert from `step-engine.ts` must populate these to surface in the run detail view.

### PF-MIG-04 — `0003_temporal_columns.sql` (P0-DB-01) ✅
Backfills `created_at`/`updated_at` on `agents`, `agent_versions`, `event_listeners`, `event_types`, `entity_types`. SQLite ALTER TABLE NOT NULL requires a constant default, so the migration uses a static seed then UPDATEs to `unixepoch() * 1000`. New rows fall through to the Drizzle-side default. Drift gate: any code path that bypasses Drizzle and inserts via raw SQL must populate these too.

### PF-MIG-05 — `0004_parent_run.sql` (P1-RT-04) ✅
Adds `runs.parent_run_id` for subflow tracing (nullable, no default). Index `runs_parent_run_idx`. Drift impact: subflow composition writes `parent_run_id`; legacy runs are correctly NULL.

### PF-MIG-06 — `0005_tenant_budgets.sql` (P1-DB-01) ✅
Creates `tenant_budgets` (one row per tenant). USD stored in integer cents to avoid float drift. Drift gate: LLM gateway is the only writer; budgets enforced at chat-call time.

### PF-MIG-07 — `0006_schema_meta.sql` (P1-DB-02) ✅
Creates `_meta` with seeded `schema_version`. API boot checks this and refuses start if the DB is newer than the code supports.

### PF-MIG-08 — `0007_soft_delete.sql` (P1-API-04b) ✅
Adds `deleted_at` tombstone columns to `events`, `runs`, `tasks`. Retention sweeps stamp rather than hard-delete, so causality traces survive the period.

### PF-MIG-09 — `0008_runs_is_test.sql` (P2-FE-18) ✅
Adds `runs.is_test` (default 0) + partial index on `is_test = 1`. Dashboards default to non-test traffic; Test-run button at `POST /v1/agents/:name/invoke?testRun=1` sets it.

### PF-MIG-10 — `0009_webhook_subscriptions.sql` (P3-RT-04) ✅
Creates `webhook_subscriptions`. Anti-replay is *not* persisted here — the route uses an in-memory dedupe TTL; the table stays clean for ops introspection.

### PF-MIG-11 — `0010_agent_memory.sql` (P3-DB-01) ✅
Creates `agent_memory_short` (per-run) + `agent_memory_long` (per-tenant/agent/subject). DESIGN §5.7 scope.

### PF-MIG-12 — `0011_tenant_lifecycle.sql` (P5-TEN-01) ✅
Adds `tenants.archived_at` + `tenants.updated_at`. Archive is soft; rows remain so audit trails stay readable.

### PF-MIG-13 — `0012_import_recovery.sql` ✅
Adds `deployments.expires_at` + `deployments.file_path`. The session token IS the deployment id (no separate column). Crash-recovery columns; PF-IMP-05.

### PF-MIG-14 — `0013_confused_vertigo.sql` ✅
Adds covering index `evt_tenant_received_idx` to `events`. Backs the SSE poll query `WHERE tenant_id = ? AND received_at > ?` which couldn't use the existing (`tenant_id`, `name`, `received_at`) index because `name` sits between equality and range. 100k+ events × 5 concurrent SSE tabs polling at 250ms is the workload that motivated it.

### PF-MIG-15 — `_meta/_journal.json` ✅
Drizzle's own journal of applied migrations. Drift impact: every migration must be appended here for `drizzle-kit generate` to pick up the next slot. Manually inserted migrations (e.g. `0003_temporal_columns.sql` per P0-DB-01) require a manual journal entry — documented in CLAUDE.md.

### Migration tests (`PF-MIG-TST-*`)
`apps/api/test/tc-13-p0-db-migrations.test.ts` and `apps/api/test/tc-11-bootstrap-idempotency.test.ts` together cover: (a) every column added by `0003` exists post-migration, (b) backfilled rows have non-zero timestamps, (c) two back-to-back `bootstrapTenant()` calls don't crash on uniqueness conflicts thanks to `onConflictDoNothing({ target: [...] })` (P0-MIG-02), (d) `AGENTIC_REBOOTSTRAP=force` inserts a fresh deployment row.

---

## 6. Auth + Tenancy (`PF-AUTH-*`)

Auth is intentionally simple in V1 — bearer tokens at the api, dev-mode bypass at non-prod, cookie session for the web. The auth plugin lives at `apps/api/src/plugins/auth.ts`. Multi-tenant isolation is enforced at query time via `tenantScope()`, not by row-level security inside SQLite.

### PF-AUTH-01 — Dev-mode tenant bypass ✅
At `apps/api/src/plugins/auth.ts:28-32`, when `AUTH_MODE=dev` *or* `NODE_ENV !== "production"`, `authenticate()` resolves the dev tenant from `AGENTIC_DEV_TENANT` (default `raas`; tests use `__system`). This is opt-in only — production refuses to pick a tenant without a bearer token. P0-AUTH-01 hardened the guard so the default never silently picks `raas` in CI. Test: `apps/api/test/tc-6-p0-auth-isolation.test.ts` (4 cases).

### PF-AUTH-02 — Production bearer auth ✅
At `apps/api/src/plugins/auth.ts:33-58`, parses `Authorization: Bearer <token>`, sha256-hashes the token, looks up `api_tokens` by hash. On match, bumps `api_tokens.last_used_at` and resolves the tenant via FK. Constant-time `timingSafeEqual` is intended (`hashToken` uses `createHash`; the match itself is a single equality probe — V1 acknowledges sub-µs timing variation is not a meaningful attack surface for tokens with ≥128 bits of entropy). Test: `tc-6-p0-auth-isolation.test.ts`.

### PF-AUTH-03 — Web cookie session ✅
The web app issues a `jose`-HS256-signed cookie `agentic_session` after sign-in (`apps/web/lib/auth/session.ts`, `apps/web/app/api/auth/login/route.ts`). In dev mode the `/sign-in` page mints a synthetic "Liu Wei" session inline so /portal forwards through immediately. Signing key from `AUTH_SESSION_SECRET`. Default expiry 7d, sliding refresh on every authenticated /portal request. Test: 2 vitest tests at `apps/web/lib/auth/session.test.ts` cover sign + verify. (P2-FE-19)

### PF-AUTH-04 — Memberships table ✅
`memberships(userId, tenantId, role)` with PK `(userId, tenantId)` and role one of `admin|operator|viewer`. The role is read on every authenticated request to authorize mutating actions. V1 stops at role-level gating — fine-grained scopes are V2.

### PF-AUTH-05 — `tenantScope(ctx, table)` ✅
The predicate builder at `packages/db/src/with-tenant.ts`. Idiomatic usage: `db.select().from(runs).where(tenantScope(ctx, runs)).all()`. **Direct `getDb()` access without `tenantScope` leaks across tenants** — documented in CLAUDE.md. The audit in `docs/audits/p0-api-auth-status.md` confirmed cross-tenant lookup attempts return 404 for both the runs and runs-logs routes after P0-AUTH-02 fixes.

### PF-AUTH-06 — `JWT_SECRET` ✅
Required for the web cookie HS256 signature (P2-FE-19). Length ≥32 random bytes — documented in `.env.production.example` and enforced by `jose` at sign time. Rotation requires invalidating outstanding cookies (operators sign all users out by changing the secret).

### PF-AUTH-07 — Token issuance ✅
`POST /v1/tenants/:slug/tokens` at `apps/api/src/routes/v1/tenants.ts:767` (platform-admin only). The route generates an opaque `tok-…` ID + a random 32-byte plaintext, hashes the plaintext (sha256), stores hash + scopes JSON, returns the plaintext **exactly once** in the response. UI surface: `TenantTokenRevealModal` in the portal shell. Audit action: `token.issue`.

---

## 7. Storage (`PF-STO-*`)

All persistence is on local disk — SQLite for relational state, NDJSON for run logs + event ledger, plain files for artifacts. The compose stack bind-mounts `data/` into a named volume so the entire state survives container restarts.

### PF-STO-01 — SQLite WAL ✅
`data/agentic.db` opened by `better-sqlite3` in WAL mode (set at first connect by `packages/db/src/index.ts`). Native module — recompiled per Node major (PF-BUILD-01). Single writer process (the api) — SQLite's exclusive writer lock has a 5s `SQLITE_BUSY` timeout. Test harness pins `pool: forks` + `singleFork: true` (`apps/api/vitest.config.ts`) so vitest workers serialize against this lock; without it the manifest-import commit transaction races itself and trips the timeout. Health probe at `apps/api/src/routes/health.ts:46-58` reads `journal_mode` and a `SELECT 1` to confirm liveness.

### PF-STO-02 — Run logs (NDJSON-per-line) ✅
Each agent run writes a JSONL-style log at `data/logs/<tenant>/runs/<date>/<run-id>.log`. One line per significant transition (`step.start`, `step.ok`, `step.error`, `llm.call`, `tool.call`, `task.created`). Written by `appendRunLog()` from `packages/runtime/src/log-writer.ts`. The SSE tail at `/v1/runs/:id/logs?follow=1` (PF-API-RUN-04) consumes the file with inotify-style polling. Files are subject to the retention sweep (`AGENTIC_RETENTION_DAYS`).

### PF-STO-03 — Event ledger (NDJSON) ✅
Per-tenant per-day rollover at `data/logs/<tenant>/events/<date>.ndjson`. Written by `appendToLedger()` from `@agentic/runtime` (re-exported from `@agentic/shared`). One line per ingested event, holds the full payload — the `events` table only carries a `payload_ref` pointer. Reads happen via `fetchEventsSince()` in `apps/api/src/queries/events.ts` for cold ledger access.

### PF-STO-04 — Artifacts ✅
`data/artifacts/<tenant>/<run-id>/<filename>`. `writeArtifact()` from `packages/runtime/src/artifacts.ts` writes step input + output sidecars (`step-N-input.json`, `step-N-output.json`) for replay. Served by `GET /v1/artifacts/:id` (PF-API-ART-01) after tenant ownership verification.

### PF-STO-05 — Manifest import staging ✅ 🟡
`apps/api/data/imports/dpl-<id>/workflow.json`. Phase 2 of the four-phase commit writes here + fsyncs; phase 4 atomic-renames the file to `models/<slug>-vN/workflow_v<N+1>.json`. **🟡 Known gotcha** documented in CLAUDE.md: these staging dirs are **NOT gitignored at the repo root** (`.gitignore` covers `data/*` at top level but not `apps/api/data/`). The boot-time `reconcileImports` prunes expired pending rows + dirs, but a developer running locally can accidentally commit a partial staging dir. Mitigation: add `apps/api/data/imports/` to `.gitignore` (tracked as a follow-up).

### PF-STO-06 — System agents ✅
`packages/agents/src/system/` houses canonical system code agents. The
`testAgent` implementation remains there for unit/E2E coverage, but
`system/index.ts` registers it only under `NODE_ENV=test`; the matching
allow-list guard in `apps/api/src/config/system-agents.ts` enforces the same
boundary.

### PF-STO-07 — Tenant code (deployed via CLI) ✅
`data/tenants/<slug>/<version>/` is where `POST /v1/tenants/:slug/code` explodes a USTAR tarball uploaded by `agentic deploy`. The tarball contents are typechecked, then the new version is registered alongside the existing live one; promotion is a separate explicit step.

---

## 8. Manifest import (`PF-IMP-*`)

The 6-step modal at `apps/web/app/portal/components/import-manifest/ImportManifestModal.tsx` calls into `POST /v1/tenants/:slug/manifest-import` which has two body modes (`validate` and `commit`) backed by a four-phase commit dance. The design doc is `docs/design/import-workflow-manifest.md`; the audit is `docs/audits/import-workflow-manifest-review.md`. Tests: `apps/api/test/tc-manifest-import-*.test.ts` (validate/commit happy paths, conflict resolution, retry, crash recovery).

### PF-IMP-01 — Phase 1: preflight (in-memory) ✅
`apps/api/src/services/manifest-import.ts` parses the incoming JSON through the `WorkflowManifest`/`ActionsArray` Zod schemas, runs the manifest lint pass (no orphan event references, every action has a known type, no cycles in the DAG), then diffs against the current live manifest (which agents are added/modified/removed; which actions changed). Errors short-circuit with a 422 envelope listing every issue. This phase touches neither disk nor DB so a `mode=validate` call is purely a dry-run.

### PF-IMP-02 — Phase 2: write to staging + fsync ✅
For `mode=commit`, the service writes the validated manifest to `apps/api/data/imports/<deployment_id>/workflow.json` and `fsyncs` so the bytes are durable. The directory is created with `mkdir -p` and chmod 0o700. The path is stored in `deployments.file_path` for crash-recovery (PF-IMP-05). `<deployment_id>` is the same id returned by phase 1 as the session token (no separate `imp-` prefix).

### PF-IMP-03 — Phase 3: synchronous SQLite transaction ✅
The big atomic step. Inside `db.transaction(() => { ... })()` (synchronous — better-sqlite3 does not allow `await` in here, per CLAUDE.md):
1. Demote the prior `live` deployment row for this workflow target to `status='rolled_back'`.
2. Upsert `workflow_versions` (new version row with the manifest JSON + actions JSON).
3. Upsert `deployments` to a new `status='live'` row pointing at the version. `file_path` is set to the staging path. `expires_at` is nulled (it's no longer pending).
4. Upsert `agents` and `agent_versions` rows for every agent in the new manifest, using `onConflictDoNothing({ target: [...] })` (P0-MIG-02) so a partial overlap doesn't crash.
5. Upsert `event_listeners` rows.
6. Insert one `audit_log` row with `action='manifest.import.commit'` + `meta_json` including the diff summary.

The transaction commits or rolls back as a unit. If it throws, the staging file from phase 2 remains on disk — the next boot's `reconcileImports` (PF-IMP-05) cleans it up.

### PF-IMP-04 — Phase 4: atomic rename + Inngest re-register ✅
Outside the transaction, the service calls `fs.rename()` to move the staging file from `apps/api/data/imports/<deployment_id>/workflow.json` to `models/<slug>-vN/workflow_v<N+1>.json` (where N is the new live version index). POSIX `rename` is atomic on the same filesystem — either the new file is in place or it isn't; there's no half-move state. After the rename, `deployments.file_path` is updated to the final path. Inngest re-registration happens last: `bootstrap.reRegister()` parses the new file, rebuilds the function catalog, and the broker picks it up on its next poll.

**Crash window:** If the process dies between phase 3 (DB commit) and phase 4 (rename), the DB points at the tmp staging file the loader never visits. `reconcileImports` handles this.

### PF-IMP-05 — Crash-recovery on boot (`reconcileImports`) ✅
`apps/api/src/services/reconcile-imports.ts` runs once at `bootstrapRuntime()` before any Inngest function registers. Three jobs:
1. **Prune expired pending rows.** Any `deployments` row with `status='pending'` AND `expires_at < now` is deleted; its `data/imports/<deployment_id>/` staging dir is `rm -rf`'d.
2. **Complete crashed renames.** For every `status='live'` deployment whose `file_path` points at a `data/imports/<deployment_id>/...` (i.e. phase-3-but-not-phase-4 crash), `fs.rename()` finishes the move into the canonical `models/` location.
3. **Re-emit manifests that were deleted from disk.** If `deployments.file_path` points at a file that no longer exists on disk (e.g. operator did `rm -rf models/<slug>-v3/`), the service re-writes the file from `workflow_versions.manifest_json`. The DB stays authoritative.

Test: `apps/api/test/tc-import-recovery.test.ts` covers all three branches.

### PF-IMP-06 — In-flight lock (concurrent validate) ✅
The `validate` mode inserts `deployments(status='pending', expires_at=now+1h)` before doing any work. If a second concurrent `validate` arrives for the same tenant + workflow target, the inserted row's `id` is returned as the in-flight `deployment_id` via a **flat 423** envelope (not the standard `{ok:true,data:…}` wrapper — clients must handle this). The web client's `unwrapEnvelope<T>()` helper at `apps/web/app/portal/components/import-manifest/ImportManifestModal.tsx` accommodates both shapes (CLAUDE.md gotcha). Manual abandonment: `DELETE /v1/tenants/:slug/manifest-import/:deployment_id` releases the lock.

### PF-IMP-07 — SSRF guard on `fetch-url` ✅
`apps/api/src/services/ssrf-guard.ts` implements the protocol per `docs/design/import-workflow-manifest.md`. Rules: (1) https-only except `http://localhost` when `AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1` is set (dev opt-in); (2) DNS-resolve hostname then reject any private/loopback/link-local/AWS-metadata IP (`169.254.169.254`)/IPv6-ULA (`fd00:`); (3) follow at most 3 redirects, re-validate every `Location` header; (4) stream-count body bytes, abort > 5 MB; (5) validate `content-type` before AND after body (some servers lie); (6) 5s connect timeout + 5s body timeout; (7) reject all non-http(s) schemes. Test: `apps/api/test/tc-ssrf-guard.test.ts`.

### PF-IMP-08 — 6-step UI wizard ✅
`apps/web/app/portal/components/import-manifest/ImportManifestModal.tsx`. The six steps are: **Source** (paste JSON or URL), **Preview** (raw + parsed), **Validate** (calls `POST .../manifest-import` mode=validate; shows lint issues + diff), **Conflicts** (per-conflict resolution UI for items the lint flagged), **Confirm** (review the diff one last time; optional note), **Result** (calls mode=commit with `?confirm=1`; renders success/failure detail). Visual reference under the v1_1 static SPA at `apps/web/public/portal/views/import-manifest.jsx` — production UI lives in the App Router per the rule in CLAUDE.md.

---

## 9. CLI (`PF-CLI-*`)

`apps/cli` ships a single binary `agentic` with four commands. Entrypoint `apps/cli/src/cli.ts:1-60`. Build emits to `dist/`. Global options: `--api <url>` overrides `AGENTIC_API_URL` (default `http://localhost:3501`), `--token <token>` overrides `AGENTIC_API_TOKEN`. All command code threads stdin/stdout/stderr through a `RunContext` object so vitest can exercise every code path without subprocesses — that's why the cli workspace hits the 70/60 coverage gate (PF-BUILD-10).

### PF-CLI-01 — `agentic init <slug>` ✅
`apps/cli/src/commands/init.ts:1-30`. Scaffolds `data/tenants/<slug>/` with `agentic.json` (tenant manifest, DESIGN §11.2), `package.json` (workspace package), `tsconfig.json`, `src/index.ts` (TenantRegistry export), `src/tools/example.ts` (defineTool sample), `src/prompts/example.ts` (definePrompt sample). Also creates `models/<slug>-v1/` with `workflow_v1.json` (2-agent demo), `events_v1.json` (declared event types), `actions_v1.json` (action metadata).

**🟡 PF-GAP-03:** `actions_v1.json` is written in the wrong shape — the manifest schema expects an array of action objects, the CLI writes an object map keyed by action id. Operators have to hand-edit. Fix is a one-line change in `init.ts`.

After scaffolding, `pnpm install` picks the new workspace up via the `tenants/*` glob in `pnpm-workspace.yaml`.

### PF-CLI-02 — `agentic deploy [path]` ✅
`apps/cli/src/commands/deploy.ts:1-30`. Steps: (1) locate tenant root (default cwd) — must contain `agentic.json`; (2) read `agentic.json.manifestPath`; (3) read `models/<slug>-v1/workflow_v1.json` + `actions_v1.json`; (4) run `tsc --noEmit` on the tenant's TS code so a broken handler can't land in prod (skipped with `--no-typecheck`); (5) POST the manifest to `POST /v1/agents` (PF-API-AGT-03) — receives `{workflow_version_id, version, diff, note}`; (6) pretty-print the diff (added / modified / removed agents). Flags: `--no-typecheck`, `--note <text>`, `--workflow-slug <s>` override.

**🟡 PF-GAP-02 surfaces here:** `POST /v1/agents` 500s on tenants with a live `tenant_code` deployment — `agentic deploy` returns a confusing 500 with no actionable message. Test: `apps/api/test/tc-tenant-code-deploy.test.ts` reproduces.

### PF-CLI-03 — `agentic logs <run-id> [--tail]` ✅
`apps/cli/src/commands/logs.ts:1-30`. Reads `/v1/runs/:id/logs` one-shot, or `/v1/runs/:id/logs?follow=1` (SSE) when `--tail`. Pretty-prints each log line. Color via TTY detection; `--no-color` or `NO_COLOR=1` env disables. Errors map: 401 → "auth failed (set AGENTIC_API_TOKEN)", 404 → "run not found", network error → exit 1 with stderr message.

### PF-CLI-04 — `agentic events tail` ✅
`apps/cli/src/commands/events.ts:1-30`. Subscribes to `/v1/stream` SSE (the generic stream multiplexer; PF-API-STR-01) and pretty-prints `RunStreamEvent` lifecycle entries. Flags: `--json` (raw JSON one-per-line), `--no-color`. Schema source: `@agentic/contracts:RunStreamEvent`. Note: this depends on PF-API-STR-01 being registered; until that's wired into `server.ts` (currently commented out per inline note), the command will receive a 404 — see PF-GAP table.

---

## 10. Web architecture (`PF-WEB-*`)

The production UI is the Next.js App Router under `apps/web/app/portal/[tenant]/(views)/...`. The static SPA at `apps/web/public/portal/index.html` is the v1_1 visual reference only — production work lands in the App Router (CLAUDE.md feedback memory `feedback_production_mode_default.md`). 18 routes register under `/portal/[tenant]/*` after P2-FE-01 set up the build pipeline.

### PF-WEB-01 — App Router layout ✅
`apps/web/app/portal/[tenant]/...`. The tenant slug is the first URL segment (`/portal/raas/workflows`, `/portal/raas/runs/<run-id>`, …). `apps/web/app/portal/layout.tsx` is the shell wrapper; `[tenant]/page.tsx` is the dashboard; subroutes live under `[tenant]/(views)/<view>/page.tsx`. Web has zero DB access — every read goes through `lib/api-client.ts` → `/v1/*` against the real Fastify API.

### PF-WEB-02 — `useTenant()` ✅
`apps/web/app/portal/lib/use-tenant.ts`. The canonical reader for the URL tenant slug; built on `useParams` + `useRouter` from `next/navigation`. Sibling `useTenantNavigate()` produces a navigation helper that rewrites the tenant segment when the user switches via the TenantSwitcher. 5 vitest cases for the path-rewrite math (P2-FE-25).

### PF-WEB-03 — Shell ✅
`apps/web/app/portal/components/shell/`. Three components: `Sidebar` (232px fixed, navigation list), `TopBar` (44px fixed, breadcrumb + Cmd-K hint + user menu), `TenantSwitcher` (dropdown in TopBar — drives `useTenantNavigate`). Layout matches v1_1's `app.jsx:108-374`.

### PF-WEB-04 — Primitives barrel ✅
`apps/web/app/portal/components/index.ts`. Stable contract — view engineers import exclusively from this barrel. Exports: `Icon`, `Badge`, `ActorTag`, `StatusDot`, `Kbd`, `Empty`, `eventTone`, `Panel`, `Stat`, `Sparkline` (+ pure helper `computeSparkPaths`), `ViewHeader`, `Button`, `SearchInput`, `FilterChip`, `CodeBlock`, `Th`, `Td`, `KV`, `Splitter`, `ModalOverlay`, `MonacoEditor`, `ToastRegion`, `useToast`, `CommandPalette`, `useCommandPalette`. Adding a primitive: drop a `<name>.tsx`, re-export from the barrel, ship.

### PF-WEB-05 — Style policy ✅
Inline `style={{}}` on every JSX node per `apps/web/app/portal/STYLE-GUIDE.md`. No Tailwind, no CSS modules, no CSS-in-JS runtime. Global tokens — theme palette, density (`--density-mult`), z-index ladder, `@keyframes`, `::selection`, scrollbar, utility classes (`.mono`, `.display`, `.muted`, `.dim`, `.nowrap`, `.live-dot`) — live in `apps/web/styles/tokens.css`. `apps/web/app/global.css` is a thin `@import` wrapper. ESLint flat-config (`apps/web/eslint.config.mjs`) bans inline numeric `zIndex` under `app/portal/**/*.tsx` — use `var(--z-modal)`/`--z-overlay`/`--z-toast`/`--z-tooltip` tokens. The rule fires on violation with a documented error message (P2-FE-26).

### PF-WEB-06 — `lib/api-client.ts` (typed envelope unwrapper) ✅
`apps/web/lib/api-client.ts`. Wraps `fetch` with a Zod-validated unwrap layer: callers pass a contract schema, the client parses `{ok:true, data:…}` against it. Error envelopes (`{ok:false, error:{code,message}}`) become thrown `ApiError` instances. **Flat envelope handling** for 409 and 423 from the manifest-import route — see PF-IMP-06. Cookie-credentialed (sends `agentic_session`). Adds `x-request-id` if the caller supplies one (otherwise the API mints one).

### PF-WEB-07 — `next.config.mjs` rewrites ✅
`apps/web/next.config.mjs`. Rewrites: `/v1/:path*` → `${AGENTIC_API_URL}/v1/:path*`, `/health` → `${AGENTIC_API_URL}/health`, `/` → `/portal/index.html` (legacy SPA escape hatch). `fallback` block routes unmatched paths to `/portal/index.html` (legacy SPA serves them). The catch-all means production navigation never depends on the bare-root rewrite — App Router routes always match first. `outputFileTracingRoot` set to the repo root so the standalone Next build picks up workspace deps.

### PF-WEB-08 — Legacy SPA ✅
`apps/web/public/portal/index.html` — React 18 UMD + Babel-standalone via CDN, fetches `/api/spa/bootstrap`. Served at `/portal-legacy/*` per next.config rewrites. v1_1 visual reference only — no new features. **Historical gotcha:** all `<script type="text/babel">` files share one global scope, so a top-level `function Foo()` in one view shadows the same name in another (last load wins). Convention: prefix internal components with the view name (`SchemaTreeNode`, `LogsTreeNode`); only top-level view components use bare names; cross-view shared components attach to `window.*` from `components.jsx`. The App Router does not have this problem — every file is a real ES module.

### PF-WEB-09 — TanStack Query + DataProvider ✅
The portal uses `@tanstack/react-query` for all `/v1/*` data fetching. Query keys follow the URL shape (`["runs", { tenantSlug, agentId }]`). A `DataProvider` context at `apps/web/app/portal/components/shell/providers.tsx` constructs a tenant-scoped query client + a `useRaasData()` hook for static metadata that's already in DataContext. Mutations call `queryClient.invalidateQueries` after the API ack so the UI catches up without a manual refetch.

### PF-WEB-10 — Monaco from npm ✅
`apps/web/app/portal/components/monaco.tsx` + `MonacoEditor.tsx` proxy. Imports from `monaco-editor@0.55.1` (npm) rather than the legacy SPA's unpkg CDN load. P2-FE-04 verified by bundle scan: no `unpkg.com/monaco` references in `.next/`. `agentic-dark` theme defined verbatim from the v1_1 reference (lines 382-426 of the SPA's `app.jsx`).

---

## 11. Build, dev, test (`PF-BUILD-*`)

Turbo is the orchestrator; each workspace owns its own `tsc --noEmit`, lint, and test scripts. `turbo.json` declares pipeline dependencies (`build` depends on `^build`; `test` depends on `^build`; `dev` is non-cacheable + persistent).

### PF-BUILD-01 — `pnpm install` + native modules ✅
pnpm 11 with `package.json#packageManager` pinned at `pnpm@11.21.0`. The `pnpm-workspace.yaml#allowBuilds` allow-list lets `better-sqlite3`, `esbuild`, `protobufjs`, `sharp`, and `unrs-resolver` run their postinstall scripts. Without that allow-list, pnpm 11 halts the install with `ERR_PNPM_IGNORED_BUILDS`. The native `better-sqlite3` binding is compiled per Node major — `.nvmrc` pins Node 26.5.0; mismatches surface as `ERR_DLOPEN_FAILED` at boot. Bumping the Node major requires a dedicated PR that regenerates the binding.

### PF-BUILD-02 — `pnpm dev` orchestration ✅
Root script. Predev hook kills any process squatting on `3599,3501,8288,8289,50052,50053` (Inngest's internal gRPC ports plus the web + api + broker ports), then `concurrently` boots three children labelled `web,api,inngest`. The api dev script (`apps/api/package.json:7`) is `tsx watch --env-file=../../.env --env-file=.env.local src/server.ts` — both env files load (later wins). The Inngest CLI is fetched via `npx -y inngest-cli@latest dev -u http://localhost:3501/inngest`.

### PF-BUILD-03 — `pnpm build` ✅
`turbo run build` fans out per workspace. The web build is `next build` with Turbopack (Next 16 default) producing the `output: "standalone"` bundle. The api build is `tsc --noEmit` only — the api itself runs via `tsx` in dev *and* in the Docker image (no JS emit). Apps that emit (`apps/cli`) write to `dist/`.

### PF-BUILD-04 — `pnpm lint` ✅
`turbo run lint`. Only `apps/web` has a lint task — Next 16 deprecated `next lint`, so the project's typecheck is the heavy quality gate. The web ESLint flat-config (`apps/web/eslint.config.mjs`) is intentionally minimal; the one project-specific rule bans inline numeric `zIndex` under `app/portal/**/*.tsx`.

### PF-BUILD-05 — `pnpm typecheck` ✅
`turbo run typecheck` runs `tsc --noEmit` in every workspace that has one (every TS workspace). Per CLAUDE.md this is the "heavy quality gate" because lint is intentionally minimal. The api Dockerfile also runs typecheck as a build step so a broken type can't ship.

### PF-BUILD-06 — `pnpm test` (vitest, single-fork pin) ✅
`turbo run test` → vitest in `apps/api`. `apps/api/vitest.config.ts` is the **critical** config — `pool: "forks"`, `sequence.concurrent: false`, **and `poolOptions.forks.singleFork: true`**. Without the single-fork pin, vitest spawns one worker per test file and they race for SQLite's exclusive writer lock; the manifest-import commit transaction is heavy enough to trip `SQLITE_BUSY` (5s timeout) before either finishes. Tests set `AGENTIC_DEV_TENANT=__system` and share `data/agentic.db` with the dev workspace — isolation is **by record** (each test owns its `runId`), not by file. See `apps/api/test/setup.ts`. Single test invocation: `pnpm --filter @agentic/api exec vitest run test/tc-3-test-agent-happy.test.ts`.

### PF-BUILD-07 — DB scripts ✅
- `pnpm db:migrate` — `DATABASE_URL=file:../../data/agentic.db pnpm --filter @agentic/db exec tsx src/migrate.ts`. Idempotent.
- `pnpm db:seed` — seeds the 4 deployable tenant rows plus exactly one
  superadmin supplied through explicit `AGENTIC_BOOTSTRAP_ADMIN_*` variables;
  no sample user identities or default password are installed.
- `pnpm db:generate` — `drizzle-kit generate` after editing `packages/db/src/schema.ts`. Writes the next-numbered SQL file + updates `_meta/_journal.json`.
- `pnpm db:studio` — opens Drizzle Studio against the dev DB.
- `pnpm db:backup` — added by P4-OPS-06; writes a snapshot to `$AGENTIC_BACKUP_DIR/<date>-agentic.db.gz` and prunes anything older than `BACKUP_RETENTION_DAYS` (default 14).

### PF-BUILD-08 — `pnpm seed:rich` ✅
RAAS historical fixtures + English ontology overlay (idempotent). Run after `db:seed` if you want English-labeled agents in the UI (the RAAS canonical workflow ships with Chinese titles; `seedAgentMetadata()` overlays English from the handoff prototype).

### PF-BUILD-09 — Playwright (e2e + visual) ✅
`apps/web/e2e/*.spec.ts` for flows; `apps/web/test/visual/` for 1440×900 pixel diffs against `test/visual/v1_1-reference/`. The dev server must be running on :3599. `PW_AUTO_WEBSERVER=1` env opts CI into auto-boot. Invocation: `pnpm --filter @agentic/web exec playwright test`. The visual-diff baseline is the v1_1 static SPA reference — production App Router pages must match within the tolerance budget. P4-TEST-04/05 ratified TanStack Query hooks + React effects through Playwright instead of vitest mocking.

### PF-BUILD-10 — Web vitest gate ✅
`pnpm --filter @agentic/web run test` runs a small vitest unit gate (lines ≥70, branches ≥60) over the helpers listed in `apps/web/vitest.config.ts`. Scope is intentionally narrow — pure helpers with a unit-test seam (formatters, density math, sparkline math, session sign/verify). Component behavior is covered by Playwright, not the unit gate. Same coverage gate (70/60) is enforced for `@agentic/api` and `@agentic/cli` — see PF-CI-02.

### PF-BUILD-11 — Turbo cache + outputs ✅
`turbo.json` declares: `build` outputs `[.next/**, !.next/cache/**, dist/**]`; `dev` is `cache: false, persistent: true`; `test` outputs `coverage/**`. Cache lives at `.turbo/` (gitignored). Hash inputs are derived from the workspace's `package.json` + `tsconfig.json` + every file in the workspace; a single-character change to any source file busts the cache for that workspace and re-runs the pipeline. The cache is local-only in V1 — no remote cache configured.

### PF-BUILD-12 — Docker build gate ✅
`apps/api/Dockerfile` runs `tsc --noEmit` as a build stage before `COPY --from=build` so a broken type fails the image build. The runtime container also executes via `tsx` (no JS emit). Native modules (`better-sqlite3`) are compiled against Debian-slim libc in the build stage. P4-OPS-01 confirms `docker buildx --check` clean.

---

## 12. CI/CD (`PF-CI-*`)

Two GitHub Actions workflows under `.github/workflows/`. Branch protection: only the meta `ci` job is required — it's green only when every leaf below is green, so adding a new leaf automatically tightens protection once it's listed in `needs:`.

### PF-CI-01 — `ci.yml` ✅
Triggers: push to `main`, PR targeting `main`, manual dispatch. Concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true` so force-pushes to a PR branch don't burn CI minutes. Env pins: `NODE_VERSION=26.5.0`, `PNPM_VERSION=11.21.0`, `LLM_DEFAULT_PROVIDER=mock`, `LLM_DEFAULT_MODEL=mock-model-v1`, `NODE_ENV=test`. Jobs (DAG):
- `install` — cache pnpm store; `pnpm install --frozen-lockfile`.
- `typecheck` — `pnpm -r typecheck`.
- `lint` — `pnpm -r lint`.
- `test-coverage` — `pnpm db:migrate && pnpm db:seed && pnpm -r test:coverage`. Uploads `apps/{api,web,cli}/coverage` as a `coverage` artifact (`retention-days: 7`).
- `build` — `pnpm -r build`.
- `e2e` — Playwright. `PW_AUTO_WEBSERVER=1`, `AUTH_MODE=dev`, `AGENTIC_DEV_TENANT=raas`. Boots dev stack via auto-webserver; runs `apps/web/test:e2e`; uploads `playwright-report` on failure.
- `docker` — `docker buildx --check` of both Dockerfiles via `docker/build-push-action@v5` (push=false). Skips with a warning if Dockerfiles missing.
- `ci` (meta gate) — `if: always() / needs: [typecheck, lint, test-coverage, build, e2e, docker]`. Fails when any leaf failed.

### PF-CI-02 — Coverage gate ✅
Each app workspace runs `pnpm test:coverage` which invokes Vitest's v8 coverage provider. Thresholds encoded per-workspace in `vitest.config.ts`:
| Workspace | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| `@agentic/api` | 70% | 60% | 60% | 70% |
| `@agentic/web` | 70% | 60% | 60% | 70% |
| `@agentic/cli` | 70% | 60% | 60% | 70% |

Scope notes:
- **api**: gate covers `src/services`, `src/queries`, `src/plugins/{auth,error,audit}`, `src/routes/v1/**`, and `src/routes/{health,metrics}`. Excluded: the server entrypoint, env-config defaults, one-shot dev scripts, the inngest webhook plugin body. `src/routes/v1/usage.ts` is currently excluded — see PF-GAP-01.
- **web**: narrow scope — pure helpers with a unit-test seam. Component behavior covered by Playwright (P4-TEST-04/05).
- **cli**: `src/**`. The cli threads stdin/stdout/stderr through ctx so every code path is reachable without subprocesses.

A miss fails the workspace and turbo propagates the non-zero exit code into the `test-coverage` leaf which blocks the `ci` meta gate.

### PF-CI-03 — `release.yml` ✅
Triggers: tag push matching `v*.*.*`, manual dispatch (with an `inputs.tag` field). Concurrency group `release-${{ github.ref }}` with `cancel-in-progress: false` so back-to-back tags queue rather than truncate. Env pins: same as `ci.yml`. `REGISTRY` is left as `ghcr.io/PLACEHOLDER` so the user swaps in their org (GHCR/ECR/GAR) before first cut. `IMAGE_PREFIX=agentic`. Jobs:
- `build-push` — checkout, resolve tag, install, **re-run `pnpm db:migrate && pnpm db:seed && pnpm -r test:coverage` on the tagged commit** (catches the "release the wrong sha" foot-gun), then `docker buildx build --push` for `agentic-api:${{tag}}` + `agentic-web:${{tag}}` + `agentic-inngest:${{tag}}` plus `:latest` tags.

Out of scope (V1.1): Helm chart publishing, SBOM, image signing (cosign).

### PF-CI-04 — Drift gate for `/v1/*` contracts ✅
Schemas in `packages/contracts/src/*` are imported by both api (validation) and web (parse). Adding a field that breaks an existing client's `.parse()` call surfaces as a `pnpm typecheck` failure, which the `typecheck` leaf catches. There is no separate JSON-Schema drift artifact in V1 — `.passthrough()` on every schema (DESIGN §10.1 migration window) means additive fields are forwards-compatible. The schema editor view (P2-FE-13 in design-catalog) generates a JSON-Schema view for ops reference but it's not a CI gate yet (tracked under PF-GAP V1.1).

### PF-CI-05 — Migration smoke test ✅
The `test-coverage` job runs `pnpm db:migrate && pnpm db:seed` before tests, so every CI cycle exercises the full migration sequence (`0000..0013`) from scratch on an ephemeral SQLite file. If a migration is non-idempotent or breaks against a fresh DB, the run fails before tests start. The `release.yml` flow re-runs the same gate on the tagged commit.

### PF-CI-06 — Branch protection ✅
Per `docs/CI.md §3`: the single required check is the meta `ci` job. Add a new leaf in `ci.yml#jobs:` + `needs:` list of the `ci` job and protection automatically tightens once branch-protection picks up the new job name. Force-pushes to a PR branch cancel the in-flight run (saves minutes). The release pipeline runs only on tag push so it doesn't gate PRs.

### PF-CI-07 — Coverage artifact upload ✅
`actions/upload-artifact@v4` with `name: coverage` and 7-day retention. Used to spot-check regressions in scope coverage between PRs without re-running the full suite locally. Playwright report uploaded similarly with `if: always()` to make failed test runs debuggable post-hoc.

---

## 13. Observability (`PF-OBS-*`)

V1 ships Prometheus metrics + structured pino logs + an audit_log table. No distributed tracing yet (planned V1.1 with the OpenTelemetry SDK). Log shipping is operator-supplied — the api writes JSON to stdout in prod and the deploy target's log collector ships it.

### PF-OBS-01 — Prometheus `/metrics` ✅
`apps/api/src/services/metrics.ts` implements a minimal inline registry (no `prom-client` dep). Counters carry the `_total` suffix per Prometheus convention; labels are restricted to a fixed allow-list per metric to keep cardinality bounded. Histograms use exponential buckets. Exposed metrics:
- `runs_total{tenant,agent,model,status}` — counter, incremented on run terminus.
- `run_duration_ms{tenant,agent}` — histogram, observe on run end.
- `tokens_total{tenant,agent,model,direction=in|out}` — counter, observed per LLM call.
- `cost_usd_total{tenant,agent,model}` — counter, observed per LLM call (gateway computes cost from the provider catalog).
- `http_requests_total{route,method,status}` — counter, incremented by the security plugin's onSend hook.
- `http_request_duration_ms{route,method}` — histogram.
- `llm_provider_errors_total{provider,kind}` — counter, incremented on `LLMError` catch.

Route: `GET /metrics` at `apps/api/src/routes/metrics.ts:13` (P4-OPS-05). Unauthenticated by design; firewall the port or restrict via reverse-proxy IP allow-list per `docs/RUNBOOK.md`. Validation: `apps/api/test/tc-52-p4-metrics-health.test.ts` asserts exposition format + that `runs_total` grows after an invoke. **🟡 PF-GAP-08:** manifest-engine runs do not feed `runs_total` — only code-agent runs through `BaseAgent` do. Tracked as a follow-up so dashboards built on `rate(runs_total[5m])` underreport for manifest agents.

### PF-OBS-02 — Structured logging ✅
Fastify is configured at `apps/api/src/server.ts:46-55` with pino transport `pino-pretty` in non-prod (translateTime HH:MM:ss.l + colorize), JSON to stdout in prod. `LOG_LEVEL` env override (default `info`). The `apps/api/src/plugins/security.ts` preHandler attaches a child logger carrying `tenantSlug`/`tenantId` so every authenticated request's log lines include the tenant context. Redaction list: `authorization`, `cookie`, `x-api-key`, `*.password`, `*.apiKey`, `*.secret` (P4-API-02). Standard action keys: `agent.invoke.start|ok|error`, `manifest.import.validate|commit`, `event.ingest`, `run.start|ok|failed`, `step.start|ok|failed`, `tenant.archive`, `token.issue`, `webhook.ingest`. Every line carries `reqId` (auto-stamped from `x-request-id` inbound or minted via `randomUUID()`).

### PF-OBS-03 — Audit log ✅
The `audit_log` table (PF-DB-15) is the system-of-record for every mutating action. Writers: every route in `routes/v1/*` that mutates state calls `recordAudit({tenantId, actorUserId, action, targetType, targetId, metaJson})`. Plugin source: `apps/api/src/plugins/audit.ts`. Readers: `GET /v1/audit` (PF-API-AUD-01), the Settings → Audit view. Action namespace (curated): `agent.save`, `agent.invoke`, `run.cancel`, `task.resolve`, `event.ingest`, `event.replay`, `deployment.rollback`, `manifest.import.validate`, `manifest.import.commit`, `tenant.create|update|archive`, `token.issue`, `budget.update`, `llm.key.rotate`, `webhook.ingest`, `workflow.save`, `tenant.code.deploy`.

### PF-OBS-04 — Log retention ✅
`AGENTIC_RETENTION_DAYS` env (default 30) drives a daily cron in `apps/api/src/services/retention.ts`. Tombstone-style sweep: stamps `events.deleted_at`/`runs.deleted_at`/`tasks.deleted_at` on rows older than the window (rather than hard-deleting; PF-MIG-08). On-disk files in `data/logs/<tenant>/runs/<date>/` older than the window are unlinked. Final hard-delete is a separate explicit operator step (decouples sweep from purge).

### PF-OBS-05 — Trace + correlation IDs ✅
- `correlationId` on every run (NOT NULL on `runs.correlationId`). Inherited by every step row. Used to thread a single business operation across child runs (subflow composition).
- `triggerEventId` on a run links back to the event that fired it.
- `parentRunId` on a run links to its composer (subflow).
- `x-request-id` inbound is honored if 1-200 chars; otherwise minted as `randomUUID()`. Echoed in the response (`x-request-id` header) so clients can quote it in bug reports. Pino logs include it as `reqId`.
- `invocationId` is per-Inngest-function-call; logged but not yet surfaced on `runs` (V1.1 — needed for cleaner DLQ playbooks).

### PF-OBS-06 — Health endpoint subsystem checks ✅
`apps/api/src/routes/health.ts:11-26` runs three concurrent checks (`Promise.all`): `checkInngest()`, `checkSqlite()`, `checkDisk()`. Subsystem failure flips `ok` to false and the status to 503. Inngest check is a 2s-timeout fetch against `${INNGEST_BASE_URL}/health` (skipped when `INNGEST_DEV=1`). SQLite check stats the file, reads `PRAGMA journal_mode`, runs `SELECT 1`. Disk check reads `statfs` on `AGENTIC_LOGS_DIR` and returns free bytes. P4-API-04 added optional `version`, `schemaVersion`, `llmGateway` fields (each a count of healthy providers / mounted models / current schema_version). Operators use `/health` from load balancers / uptime probes.

### PF-OBS-07 — SIGTERM graceful shutdown ✅
`installShutdownHandlers()` at `apps/api/src/server.ts` (P4-API-01). On SIGTERM: stop accepting new connections, drain in-flight handlers for up to `AGENTIC_SHUTDOWN_TIMEOUT_MS` (default 30s), close DB connection, exit 0. Force-exit 1 after the drain window. Validation: `apps/api/test/tc-51-p4-graceful-shutdown.test.ts` spawns the api subprocess, hits `/health`, sends SIGTERM, asserts exit code 0 inside 10s. Inside Docker the entrypoint shim calls `exec tini -- node …` so signal delivery isn't mangled by the shell.

---

## 14. Env vars (`PF-ENV-*`)

Canonical contract: `.env.production.example` (P4-OPS-08). The api loads `../../.env` + `apps/api/.env.local` in dev via `tsx --env-file`; docker-compose injects the union of `.env.production` (with `.env.production.example` as a templated fallback) plus a per-service `environment:` block.

### PF-ENV-01 — `AGENTIC_MODELS_DIR` ✅ **REQUIRED**
Absolute path to the `models/` directory holding `<slug>-v<n>/workflow*.json` manifests. Required by the manifest-import wizard (validate/commit) and by `reconcile-imports` at boot — api errors out if any import endpoint runs without it set (P0-RT-08). Default: none. In Docker, `/app/models` (read-only bind mount from `./models`).

### PF-ENV-02 — `AGENTIC_DEV_TENANT` ✅
The dev-auth tenant slug. Default `raas`; tests use `__system`. Read by `apps/api/src/plugins/auth.ts:23`. Ignored when `AUTH_MODE=production` + `NODE_ENV=production`. Security note: this is the **only** lever between "unauthenticated request" and "tenant scoped" in dev mode — never set it to a customer-facing slug.

### PF-ENV-03 — `AUTH_MODE=dev` ✅
Bypasses bearer auth and routes every request to `AGENTIC_DEV_TENANT`. Anything other than `dev` (or `NODE_ENV=production`) enforces bearer tokens against `api_tokens` (PF-AUTH-02). Default: unset (= production behavior outside dev). CI sets `AUTH_MODE=dev` + `AGENTIC_DEV_TENANT=raas`.

### PF-ENV-04 — `AGENTIC_LOGS_DIR` / `AGENTIC_ARTIFACTS_DIR` ✅
Relative paths from the api workspace root (dev) or absolute paths inside the container (prod). Default `./logs` / `./artifacts`. Used by the run-log writer (PF-STO-02) and artifact writer (PF-STO-04). `statfs` on `AGENTIC_LOGS_DIR` drives the disk healthcheck (PF-OBS-06).

### PF-ENV-05 — `AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1` ✅
Dev-only opt-in for the SSRF guard. With this set, the manifest-import `fetch-url` endpoint allows `http://localhost` (otherwise https-only). Production: leave unset. Default: unset.

### PF-ENV-06 — `WEBHOOK_HMAC_SECRET_DEFAULT` ✅
Fallback HMAC secret when a `webhook_subscriptions` row has none. Used by `POST /v1/webhooks/:provider`. Production: set to a 32-byte random value and rotate per provider via the `webhook_subscriptions.secret_encrypted` column.

### PF-ENV-07 — `LLM_DEFAULT_PROVIDER` / `LLM_DEFAULT_MODEL` ✅
Gateway defaults. CI sets `mock` + `mock-model-v1` to keep tests offline. Production: set to your primary (e.g. `anthropic` + `claude-sonnet-4-5`). Read by `apps/api/src/services/llm.ts`.

### PF-ENV-08 — `JWT_SECRET` / `AUTH_SESSION_SECRET` ✅ **REQUIRED in prod**
HS256 signing keys for the web cookie session (`apps/web/lib/auth/session.ts`). Each ≥32 random bytes (validated by `jose`). Rotation invalidates outstanding cookies — all users are signed out. Documented in `docs/RUNBOOK.md §3`.

### PF-ENV-09 — `AGENTIC_KMS_KEY` 🔵
**Reserved for V2 BYOK secrets vault.** 32 random bytes; used to encrypt at-rest API keys stored via `POST /v1/llm/providers/:id/key`. V1 stores plaintext in `llm_provider_keys` (acceptable because the DB is single-tenant on the operator's infra); V2 will encrypt with this key + per-key salt. Not currently read.

### PF-ENV-10 — Per-provider keys ✅
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `QWEN_API_KEY`. Azure needs all of `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_VERSION`/`AZURE_OPENAI_DEPLOYMENT`. OpenRouter additionally honors `OPENROUTER_REFERRER` + `OPENROUTER_APP_TITLE` (for the per-app attribution badges OpenRouter encourages). Custom OpenAI-compatible: `CUSTOM_LLM_BASE_URL` + `CUSTOM_LLM_API_KEY`. Bedrock + Vertex use the SDK's default credential chain (AWS env / GCP ADC) — no extra env vars in V1. All keys are operator-side defaults; **per-tenant BYOK overrides** these via `POST /v1/llm/providers/:id/key` (PF-API-LLM-06). Security note: every per-provider key is in the redaction list (PF-OBS-02).

### PF-ENV-11 — Inngest event + signing keys ✅ **REQUIRED in prod**
`INNGEST_EVENT_KEY` (used to fire events into the broker) and `INNGEST_SIGNING_KEY` (used by Inngest to verify the api's function registry). Both 32-byte hex. `INNGEST_BASE_URL` points the api at the broker; defaults to `http://inngest:8288` in compose. `INNGEST_DEV=1` switches to dev mode (skip the broker handshake; verify nothing). Documented in `.env.production.example`.

### PF-ENV-12 — `NODE_ENV` ✅
`development | test | production`. Drives auth opt-in (PF-AUTH-01: anything other than `production` returns the dev tenant), pino transport (`pino-pretty` in non-prod, JSON in prod), and rate-limit enable (disabled in `test`).

### PF-ENV-13 — `LOG_LEVEL` ✅
Pino level (`trace|debug|info|warn|error|fatal`). Default `info`. Production: usually `info` or `warn` (log volume is a budget pain at scale).

### PF-ENV-14 — `AGENTIC_BODY_LIMIT_BYTES` ✅
Per-request body cap at the Fastify factory. Default 1 MiB. Tenants that ship large code bundles via `POST /v1/tenants/:slug/code` may need this raised to 5–10 MB.

### PF-ENV-15 — `AGENTIC_RATE_LIMIT_PER_MIN` ✅
Sliding-window counter ceiling keyed on `tenantId ?? ip`. Default 100/min. `AGENTIC_RATE_LIMIT_DISABLED=1` turns it off (useful behind a reverse proxy that already rate-limits). Disabled in `NODE_ENV=test`.

### PF-ENV-16 — `AGENTIC_SHUTDOWN_TIMEOUT_MS` ✅
SIGTERM drain window before `process.exit(1)` is forced. Default 30000.

### PF-ENV-17 — `AGENTIC_RETENTION_DAYS` ✅
Drives the Inngest retention sweep for `events` and terminal `tasks`. Default 30. Run history is controlled separately by `AGENTIC_RUN_RETENTION_DAYS` (default 0, retained permanently); expired idempotency keys are purged on the same pass.

### PF-ENV-18 — `AGENTIC_SYSTEM_CRON` / `AGENTIC_SYSTEM_CRON_DISABLED` ✅
Schedule expression for the retention Inngest function. `AGENTIC_SYSTEM_CRON_DISABLED=1` removes that function entirely. Orphan-run recovery is a separate startup + interval reconciler (`AGENTIC_RUN_TIMEOUT_MS` / `AGENTIC_RUN_RECONCILE_MS`), not this cron.

### PF-ENV-19 — `WEB_ORIGIN` ✅
CORS allow-list for the Fastify api (`@fastify/cors` setup at `apps/api/src/server.ts:69-74`). Must include scheme + host (+ port if non-standard). Example: `https://operator.example.com`. Credentials are allowed; `x-request-id` is in the exposed headers list.

### PF-ENV-20 — `AGENTIC_API_URL` ✅
Public URL of the api, embedded into the web build's `next.config.mjs` rewrites at build time. Compose sets it to `http://api:3501`; production deployments swap to `https://api.operator.example.com`.

### PF-ENV-21 — `DATABASE_URL` ✅
`file:/app/data/agentic.db` in Docker; `file:./agentic.db` in dev. The native `better-sqlite3` resolver auto-walks `node_modules`; override binding location via `AGENTIC_SQLITE_BINDING` if running outside the expected pnpm layout.

### PF-ENV-22 — `RESEND_API_KEY` / `AUTH_FROM_EMAIL` 🟡
Required by the magic-link auth flow (V1.1 — the V1 web auth ships as dev-mode bypass + a placeholder login form; production magic links are wired but require an operator-side Resend account). Documented in `.env.production.example`.

### PF-ENV-23 — `GIT_SHA` ✅
Optional. Surfaced on `/health.version` (P4-API-04). CI typically sets it from the commit hash for the image build.

---

## 15. V1 gaps (`PF-GAP-*`)

Honest accounting of unfinished V1 surface. Sourced from `docs/audits/p*-status.md`, `docs/audits/05-cross-review-critique.md`, and the inline `// TODO` / "🔴 Orphan" call-outs across the cited files.

### PF-GAP-01 — `/v1/usage` registered but not wired ✅ documented gap
`apps/api/src/routes/v1/usage.ts:81` declares `GET /v1/usage` but `apps/api/src/server.ts` never registers the route module. Settings → Usage view 404s. Fix is a one-line add in `server.ts`. Coverage gate currently *excludes* `usage.ts` from the api workspace's vitest scope (inline comment in `apps/api/vitest.config.ts`) until the registration lands. Tracked: `docs/audits/p4-ops-status.md` references the exclusion.

### PF-GAP-02 — `POST /v1/agents` 500 on tenants with `tenant_code` deployment 🟡
`apps/api/src/routes/v1/agents.ts:97` errors when the caller's tenant has a live `tenant_code` deployment because the merge logic between manifest-saved agents and code-deployed agents has an unhandled lookup. Surfaces to `agentic deploy` users as a useless 500. Repro: `apps/api/test/tc-tenant-code-deploy.test.ts`. Workaround: archive the tenant code, save the manifest, redeploy code.

### PF-GAP-03 — `agentic init` writes wrong `actions_v1.json` shape 🟡
`apps/cli/src/commands/init.ts` writes the actions catalog as an object map keyed by action id; the manifest schema expects an array of action objects. Operators hand-edit on first deploy. One-line fix.

### PF-GAP-04 — Tasks view extra "operator" row 🟡
Visual regression (P2-CLEANUP audit): the new App Router Tasks view renders a sub-line ("operator") under each task that the v1_1 reference does not. Pixel-diff fails for `tasks`. Fix is a markup change in `apps/web/app/portal/[tenant]/(views)/tasks/page.tsx`.

### PF-GAP-05 — Cookie auth not enabled on Fastify in prod 🟡
P2-FE-19 added cookie-session to the web app, but the matching Fastify-side cookie reader is not wired. P2-FE notes: "wiring cookie auth into Fastify is a small follow-up (read the same JWT, verify with the same SESSION_SECRET, set `req.auth`)". V1 falls back to bearer tokens, which is the documented prod auth — but the web app cannot send cookies to `/v1/*` and expect them to flip a tenant. Fix: add cookie parsing to `apps/api/src/plugins/auth.ts:33` before the bearer parse, reuse `AUTH_SESSION_SECRET` for verify.

### PF-GAP-06 — `runs.emittedEvent` name join missing 🟡
`packages/contracts/src/runs.ts` declared the `emittedEvent: string | null` field (P2-CLEANUP added the contract), but `apps/api/src/queries/runs.ts` does **not** join `events` on `runs.emittedEventId`, so every row stamps `null`. UI shows blank instead of the emitted event name. Fix: add the LEFT JOIN + select `events.name as emittedEvent`. Tracked in `docs/audits/p2-cleanup-status.md`.

### PF-GAP-07 — Legacy `apps/web/app/_portal_legacy/` still on disk 🟡
The App Router pages that used to render the portal at the root sit under `apps/web/app/_portal_legacy/` (the leading underscore makes Next ignore them). Per CLAUDE.md these are obsolete. The directory should be removed in a cleanup PR; until then it's dead code that clutters search results and confuses new contributors.

### PF-GAP-08 — Manifest runs not feeding `runs_total` 🟡
PF-OBS-01 — `metrics.runs.inc({...})` is called only from the code-agent invoke path (`apps/api/src/routes/v1/agent-invoke.ts`). Manifest-engine runs complete inside the Inngest function in `packages/runtime/src/register.ts` and never bump the counter. Dashboards built on `rate(runs_total[5m])` underreport manifest traffic. Fix: thread the metric registry into the runtime via `setRuntimeMetrics()` (mirroring `setRuntimeGateway`) and bump on every terminal status.

### PF-GAP-09 — Manifest-import staging dirs not gitignored 🟡
Per CLAUDE.md and PF-STO-05: `apps/api/data/imports/dpl-*` directories on disk are import staging. They get cleaned up by `reconcileImports` but are currently NOT gitignored at the repo root (`.gitignore` only covers top-level `data/*`). A developer running locally can accidentally commit a partial staging dir. Fix: add `apps/api/data/imports/` to `.gitignore`. (The repo currently ships an example unintentionally — see `git status` showing `apps/api/data/imports/dpl-e98006b51cd4/`.)

### PF-GAP-10 — Idempotency-Key not actually enforced 🟡
Documented intent: `POST /v1/events` + `POST /v1/agents/:name/invoke` honor `Idempotency-Key` by short-circuiting if the same key has been seen for the same tenant in the last 24h. Implementation: **stub only**. The header is accepted but no dedupe table exists; replays produce duplicate runs. Fix in V1.1: add `idempotency_keys(tenant_id, key, response_json, expires_at)` table + check before insert.

### PF-GAP-11 — `/v1/stream` not registered ✅ 🟡
`apps/api/src/routes/v1/stream.ts` exists with a generic SSE multiplexer but `apps/api/src/server.ts` never registers it (per the inline `// stream / tenant-code / workflow route files exist…` comment). The CLI `agentic events tail` (PF-CLI-04) targets `/v1/stream` and currently 404s. Fix: register in `server.ts`. Also `tenant-code.ts` and `workflow.ts` (PF-API-WF-03) are in the same not-yet-registered bucket.

### PF-GAP-12 — Eval harness absent 🔵
Per `docs/audits/05-cross-review-critique.md`: "Eval harness absent (#3 §14, §15 #9). PRD §13.6 mentions quality gates (70% coverage) only. n/a in DESIGN. n/a in IMPL. Orphan." V1 ships without a per-agent eval suite — every change to a prompt is validated by humans. V2 plan: add a `data/evals/<tenant>/<agent>/*.jsonl` set + a `pnpm eval` runner that scores outputs against expected behavior via the LLM gateway.

### PF-GAP-13 — No worker isolation for tenant code 🔵
Per `docs/audits/05-cross-review-critique.md §1 #5`: "Audit #4 MUST-have #15 (worker isolation) is explicitly out-of-scope V1 in PRD §11 + DESIGN §11.4 + IMPLEMENTATION §2.3 — but R-7 in PRD §14 marks 'tenant code crashes the API process' as a HIGH risk." V1 only has try/catch around dynamic-import in `packages/runtime/src/register.ts`. A misbehaving tenant code agent can still crash the api process via unhandled async rejection. V2 plan: worker-thread or subprocess sandbox per tenant.

### PF-GAP-14 — No distributed tracing 🔵
V1 ships correlation IDs (PF-OBS-05) but no OpenTelemetry SDK + collector. V1.1 plan: instrument Fastify + the gateway + Inngest fn lifecycle with OTel spans, ship to operator-supplied collector.

### PF-GAP-15 — `failRun` race outside `step.run` 🟡 orphan
Per `docs/audits/02-backend-implementation-review.md`: `failRun` writes outside the surrounding `step.run` so a function-level retry can flip the run status concurrently with a step-level write. Audit calls it out as an orphan — no IMPL task scheduled. Mitigation: move the run-status flip inside a final `step.run("finalize", ...)` so Inngest's exactly-once contract serializes it.

### PF-GAP-16 — No DLQ for orphaned runs 🟡
Per `docs/audits/02-backend-implementation-review.md` + P4-API-05: orphan sweep is on the roadmap (NFR-REL-1) but V1 only stamps long-running runs with `status='failed'` after a deadline. A real DLQ that lets operators retry / inspect / dismiss does not exist. V1.1 plan: `dead_letter_runs` table + `GET /v1/dlq` + a "Retry / Drop" UI in the runs view.

### PF-GAP-17 — Step `ord` not UNIQUE within run 🟡 orphan
Audit calls out that `steps_run_ord_idx` is a (non-unique) index. A buggy step engine could insert two rows with the same `(runId, ord)`. Fix: promote to `uniqueIndex`. Low-impact — the run engine has never produced a collision in practice, but the schema doesn't enforce it.

### PF-GAP-18 — Replay id collision (PRE-FIX) ✅
Audit found `${id}-replay-${Date.now()}` collides under heavy fan-out. Fix landed in P0-API-01 — replay route now uses `makeId("evt")`. No outstanding gap; included here for traceability.

---

**Catalog written: docs/catalog/03-platform-catalog.md (~9k words, all 15 sections, every feature ID assigned).**
