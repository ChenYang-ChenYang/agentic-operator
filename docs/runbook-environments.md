# Runbook — Environment Profiles (dev / sandbox / production)

> Companion to `docs/redesign-ontology-execution-2026-08-19.md` §2 (req #7).
> Profiles live in `deploy/environments/<env>.env`; the driver is
> `scripts/deploy-env.mjs`.

## TL;DR

```bash
# Inspect + validate a topology (DEFAULT is a safe dry-run: docker compose config)
node scripts/deploy-env.mjs --env sandbox
node scripts/deploy-env.mjs --env production --build

# Actually deploy (health checks run automatically after up)
DEPLOY_DRY_RUN=0 node scripts/deploy-env.mjs --env production --build

# Tear down
DEPLOY_DRY_RUN=0 node scripts/deploy-env.mjs --env production --down
```

## How environments map to compose topologies

| Env | Compose files | What runs where |
|---|---|---|
| **dev** | *(none — host stack)* | `corepack pnpm dev`: web `:3599`, api `:3540`, `inngest dev` `:8488` on the host; mock Meta ERP `:3620` via `corepack pnpm --filter @agentic/mock-erp dev`. The profile only documents ports/env and health URLs; `deploy-env.mjs` prints the host commands and verifies `/health`. |
| **sandbox** | `docker-compose.yml` + `docker-compose.dev-sandbox.yml` (`--profile factory-sandbox`, services `sandbox-inngest sandbox-workload sandbox-runner`) | Host-run dev api + the containerized factory-sandbox plane, with the control runner published to loopback (`FACTORY_SB_RUNNER_URL=http://127.0.0.1:3560`). This is the evaluation stage: compiled manifests execute under the workflow-test-runner with **gated tools** — external writes are recorded, not fired. `docker-compose.dev-sandbox.yml` must never be used in production. |
| **production** | `docker-compose.yml` + `docker-compose.production.yml` | Fully containerized: api `:3501` and web `:3599` bound to loopback (front with a reverse proxy), durable `inngest start` brokers backed by PostgreSQL + Redis, immutable image digests required (`AGENTIC_API_IMAGE`, broker/store digests — supplied via `.env.production`). |

Secrets never live in the profiles. Profiles carry **non-secret defaults and
placeholders** (ports, `METAERP_BASE_URL`, `AO_API_KEY`/`AO_EXECUTION_TENANT`,
`AGENTIC_SELF_BASE_URL`/`AGENTIC_SELF_API_TOKEN`, LLM defaults,
`BROWSER_TOOLS_EXECUTABLE`); real credentials stay in the untracked root
`.env` / `.env.production` / `apps/api/.env.local`. At compose time the
ambient environment wins over profile values on conflicts.

## Driver semantics (`scripts/deploy-env.mjs`)

- `--env dev|sandbox|production` — selects the profile.
- `--build` — production runs `corepack pnpm build` before `up --build`.
- `--down` — `docker compose … down` for compose-backed envs; prints
  `./scripts/stop-dev.sh` for dev.
- **Dry-run by default.** Without `DEPLOY_DRY_RUN=0` the script runs
  `docker compose … config --quiet` (topology + interpolation check) and
  prints the exact `up` command it would execute. `DEPLOY_DRY_RUN=1` forces
  dry-run even in automation.
- After a real `up`, every URL in the profile's `DEPLOY_HEALTH_URLS` is
  fetched; any non-200 sets a non-zero exit code.

## Promotion path (compile → sandbox eval → prod import)

Per the redesign §2, an ontology domain reaches production in three gates:

1. **Compile** — `pnpm ontology:compile -- --source <dist> --tenant <slug>
   [--overlay overlays/<slug>.json]` produces `models/<slug>-v1/` (five-file
   manifest + `erp-operations.json`). Determinism: identical input ⇒
   byte-stable output ⇒ stable `workflow_versions.version = auto-<sha256>`.
2. **Sandbox eval** — import with validate-only, then execute the scenario
   suite in the **sandbox** environment: the workflow-test-runner drives the
   compiled agents with gated tool dispatch (writes recorded, not fired) and
   Studio's eval-test window (`/api/agent-execution/live/*`, authenticated by
   `AO_API_KEY`) replays scenarios with `suppressDownstream` so a single agent
   can be scored without cascading. `metaerp.invoke` targets the mock ERP
   (`METAERP_BASE_URL=http://localhost:3620`).
3. **Prod import** — `manifest-import` commit against the production tenant:
   validate → staged commit → atomic rename → Inngest hot-swap, with rollback.
   Only after this gate does `METAERP_BASE_URL` point at a real ERP origin and
   do attempt-grant tools (`metaerp.invoke` writes, `browser.click/fill`,
   `comms.sendToAgent`) fire for real.

## Env vars the new tool families need per environment

| Variable | dev | sandbox | production |
|---|---|---|---|
| `METAERP_BASE_URL` | `http://localhost:3620` | `http://localhost:3620` | real ERP origin |
| `AO_API_KEY` | optional (local Studio) | required for eval-test | required |
| `AO_EXECUTION_TENANT` | `power-scm` | `power-scm` | live tenant slug |
| `AGENTIC_SELF_BASE_URL` | `http://localhost:3540` | `http://localhost:3540` | api origin (`http://127.0.0.1:3501` behind the proxy) |
| `AGENTIC_SELF_API_TOKEN` | Settings → Tokens token | Settings → Tokens token | Settings → Tokens token |
| `BROWSER_TOOLS_EXECUTABLE` | unset (auto-resolve Chrome) | unset | pinned in-image chromium path |
