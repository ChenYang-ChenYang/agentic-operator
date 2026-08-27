# Agentic Operator

Event-driven multi-agent runtime and operations console. The portal, REST API,
Inngest workers, SQLite system of record, append-only run logs, model gateway,
MCP/tool integrations, and observability views run as one workspace.

## Runtime contract

- Every run uses the configured real model provider; there is no demo mode and
  no synthetic-model substitute.
- Non-test API processes fail closed when the provider/model is mock-like or a
  required credential is missing.
- External systems are called only through configured tools or MCP servers.
  Missing credentials produce an explicit integration gap; the runtime does not
  invent upstream records or silently report success.
- Deterministic adapters, fixtures, and replay stubs are restricted to tests and
  explicit sandbox verification. They are never listed as production providers.
- SQLite, NDJSON/run-log files, SSE, and the observability APIs are fed by the
  same persisted execution records. The UI does not maintain a second sample
  dataset.

## Workspace

| Area                      | Responsibility                                                          |
| ------------------------- | ----------------------------------------------------------------------- |
| `apps/web`                | Next.js 16 + React 19 operator portal                                   |
| `apps/api`                | Fastify 5 REST API, auth, SSE, Inngest handlers, health and metrics     |
| `apps/cli`                | Operator CLI                                                            |
| `packages/agents`         | Canonical code-agent contract, registry, tool loop and execution engine |
| `packages/runtime`        | Manifest registration and workflow step engine                          |
| `packages/llm-gateway`    | Credentialed provider adapters, budgets, usage telemetry                |
| `packages/codex-harness`  | Fail-closed Codex app-server lifecycle and JSON-RPC adapter             |
| `packages/codex-protocol` | Generated bindings/schema for the pinned Codex app-server protocol      |
| `packages/tools`          | Real tool dispatch and credential gating                                |
| `packages/mcp`            | MCP process/server lifecycle                                            |
| `packages/db`             | Drizzle schema, migrations, seed and SQLite access                      |
| `packages/contracts`      | Shared API and stream schemas                                           |
| `packages/agent-factory`  | Domain-grounded agent generation and verification                       |
| `tenants/*`               | Tenant-specific agents, prompts, skills and real integrations           |
| `models/*`                | Versioned workflow/ontology manifests                                   |

Workflows and agents can also be authored from the portal: Agent Studio edits
per-agent V2 definitions, the workflow-authoring API drafts/validates/publishes
manifests, Settings → Tokens mints tenant API tokens, and Settings →
Integrations stores third-party credentials (e.g. GoHire) encrypted per tenant.
LLM traffic is routed per tenant through the gateway (providers include
Moonshot and Z.ai) and accounted in a usage ledger surfaced at `/v1/usage`.

The workspace requires exactly Node 26.5.0 and pnpm 11.21.0. Both versions are
pinned and enforced by the root lifecycle guards.

## Local development

```bash
pnpm install
cp .env.example .env
# Configure a unique AUTH_SESSION_SECRET, a real LLM provider/model and its
# credentials, plus explicit AGENTIC_BOOTSTRAP_ADMIN_EMAIL, _NAME and _PASSWORD
# values for the one-time seed. The repository contains no default account.
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm dev` starts one supervised stack and terminates stale processes from this
workspace before binding ports:

- portal: <http://localhost:3599>
- API/health: <http://localhost:3540/health>
- Inngest dev server: <http://localhost:8488>

Use `pnpm dev:restart` for a clean restart. Use `bash scripts/stop-dev.sh` to
stop only processes owned by this workspace.

The API loads `.env` first and `apps/api/.env.local` second. Never commit either
file. `.env.example` contains no usable upstream key or fake integration URL.

## Health and verification

```bash
curl --fail http://localhost:3540/health
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm codex:runtime:install
pnpm codex:protocol:check
pnpm verify:codex-harness
pnpm --filter @agentic/api verify:observability
```

`/health` reports the database, event broker, storage/fanout backends, selected
model provider/model and whether the gateway is mock-backed. A production-ready
local response must have `ok: true` and `llmGateway.mock: false`.

`verify:codex-harness` checks the exact Codex version and performs the required
app-server handshake using an isolated temporary `CODEX_HOME`. It does not make
a model call or inherit provider credentials. See
[`docs/design/codex-harness.md`](docs/design/codex-harness.md) for the runtime
boundary and upgrade procedure.

`verify:observability` is an isolated canary labelled as a test run. It uses
the configured real default provider/model (and refuses mock), then verifies
persistence, run logs, SSE replay, `llm_calls`, token accounting and agent-call
aggregation without claiming that an external business action occurred.

The Logs page exposes:

- operation, event and run logs;
- a live SSE terminal with persisted history backfill and reconnect;
- token usage by model, provider, agent and run;
- agent-to-agent/tool call traces;
- time-series, failure, latency and cost statistics.

## Authentication

The checked-in example defaults to `AUTH_MODE=production`, which requires real
authenticated sessions/tokens and a unique `AUTH_SESSION_SECRET` even during
local development. `AUTH_MODE=dev` is an explicit sandbox-only bypass: it also
requires `AGENTIC_DEV_TENANT`, selects a real active database user, and is
rejected whenever `NODE_ENV=production`. Tenant identity always comes from the
authenticated principal and verified memberships.

`pnpm db:seed` provisions the deployable tenant rows and exactly one bootstrap
superadmin from `AGENTIC_BOOTSTRAP_ADMIN_EMAIL`,
`AGENTIC_BOOTSTRAP_ADMIN_NAME`, and `AGENTIC_BOOTSTRAP_ADMIN_PASSWORD`. All
three are mandatory. Create additional administrators/operators/viewers through
the authenticated Access surface; seed never installs sample identities.

## Adding a tenant

1. Add a versioned manifest directory under `models/<tenant>-v1/` containing the
   workflow and domain ontology JSON files.
2. Add or update the tenant row through the supported tenant API/seed path.
3. If custom runtime code is required, add `tenants/<tenant>/`, declare the
   workspace dependency in `apps/api/package.json`, and register it in
   `apps/api/src/bootstrap.ts`.
4. Configure every external tool credential and validate it from Settings.
5. Restart the API and verify registration through `/health`, Agents,
   Workflows, Events and a real run trace.

Manifest-only tenants do not need a TypeScript package when global tools cover
their integrations. A missing ontology, tool binding or credential is a build or
runtime error, not a reason to synthesize data.

## Container preview

```bash
cp .env.production.example .env.production
# Fill every required secret/provider value.
docker compose --env-file .env.production up --build
```

The container network uses API port 3501 and Inngest port 8288; these differ
from the local `pnpm dev` ports so both stacks can coexist. Compose persists the
database, logs and artifacts in named volumes.

The release workflow publishes lower-case image names to the current GitHub
repository owner's GHCR namespace. It contains no placeholder registry.

## Data and safety

- Runtime state lives under `data/`; model manifests live under `models/`.
- `pnpm db:wipe-runtime` removes runtime traffic while preserving identity and
  configuration. Treat it as destructive.
- Run cancellation is exposed through `POST /v1/runs/:id/cancel` and is
  idempotent.
- Inbound provider webhooks require configured HMAC secrets.
- External write tools must advertise side effects and pass runtime policy and
  credential gates before dispatch.
- Do not treat generated sandbox manifests or historical test runs as evidence
  of a live upstream integration; use the run's test/provenance fields and live
  provider/tool trace.

Production variables and their validation rules are documented in
`.env.production.example`. Operational procedures live in `docs/RUNBOOK.md`.
