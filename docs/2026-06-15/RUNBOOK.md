# Agentic Operator — Production Runbook

**Owner.** Platform / SRE.
**Last updated.** 2026-05-20 (Phase 4 — P4-OPS-09).
**Audience.** Whoever is on-call for the Operator stack.

This document is the single source of truth for running Agentic Operator
in production. Keep it short, opinionated, and accurate. When a procedure
here diverges from reality, update this file in the same PR.

## Table of Contents

1. [Architecture at a Glance](#1-architecture-at-a-glance)
2. [Environment Contract](#2-environment-contract)
3. [Secrets Rotation](#3-secrets-rotation)
4. [Deploy / Rollback](#4-deploy--rollback)
5. [Healthcheck Monitoring](#5-healthcheck-monitoring)
6. [Metrics + Log Shipping](#6-metrics--log-shipping)
7. [SQLite Backup + Restore](#7-sqlite-backup--restore)
8. [Common Incident Playbooks](#8-common-incident-playbooks)
9. [Capacity + Limits](#9-capacity--limits)
10. [Escalation Path](#10-escalation-path)

---

## 1. Architecture at a Glance

Three processes, one volume:

```
  ┌───────┐    /v1/*   ┌─────┐  inngest/*  ┌─────────┐
  │  web  │ ─────────▶ │ api │ ──────────▶ │ inngest │
  └───────┘            └──┬──┘             └────┬────┘
                          │                     │
                     SQLite (WAL)     async fn invocations
                          │
                     data/ volume
                  (logs/, artifacts/,
                   tenants/, agentic.db)
```

- **`apps/web`** — Next.js 16 standalone server. UI only; every read
  goes through `/v1/*` rewrites to `apps/api`. No DB access. Stateless.
- **`apps/api`** — Fastify 5 process. Owns SQLite, the LLM gateway, run
  orchestration, and the in-process Inngest function set (registered via
  `serve()` at `/inngest`).
- **`inngest`** — The official Inngest broker container. Queues events
  fired via `inngest.send()` and POSTs them back at `api:3501/inngest`.
  In production this can be swapped for Inngest Cloud — the api code
  doesn't care which broker is on the other end of the signing key.

State lives in **one place**: the `agentic-data` Docker volume (bind it
to a host path for off-host backups). Lose it and you lose the runs,
events, audit, and tenant code uploads — `models/` and the in-tree
tenant packages survive in git.

---

## 2. Environment Contract

The canonical list is in `.env.production.example`. Each variable in
that file has a comment explaining what it does and a safe production
default. Key dimensions:

| Group        | Variables                                                                                                                    | Notes                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Runtime mode | `NODE_ENV`, `AUTH_MODE`, `LOG_LEVEL`                                                                                         | `AUTH_MODE=production` outside dev.  |
| HTTP         | `PORT`, `HOST`, `WEB_ORIGIN`, `AGENTIC_API_URL`                                                                              | `WEB_ORIGIN` is the CORS allow-list. |
| Storage      | `DATABASE_URL`, `AGENTIC_DATA_DIR`, `AGENTIC_MODELS_DIR`, `AGENTIC_LOGS_DIR`, `AGENTIC_ARTIFACTS_DIR`, `AGENTIC_TENANTS_DIR` | All container-internal paths.        |
| Limits       | `AGENTIC_BODY_LIMIT_BYTES`, `AGENTIC_RATE_LIMIT_PER_MIN`, `AGENTIC_SHUTDOWN_TIMEOUT_MS`                                      | Defaults are fine for ≤8 vCPU.       |
| Inngest      | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_BASE_URL`                                                               | Both keys are 32-byte hex.           |
| Auth         | `JWT_SECRET`, `AUTH_SESSION_SECRET`, `RESEND_API_KEY`, `AUTH_FROM_EMAIL`                                                     | Required when AUTH_MODE=production.  |
| Webhooks     | `WEBHOOK_HMAC_SECRET_*` (per provider)                                                                                       | One per inbound webhook source.      |
| LLM gateway  | `LLM_DEFAULT_PROVIDER`, `LLM_DEFAULT_MODEL`, `LLM_REQUEST_TIMEOUT_MS`, per-provider keys                                     | `mock` for dry-runs only.            |
| Schedules    | `AGENTIC_SYSTEM_CRON`, `AGENTIC_SYSTEM_CRON_DISABLED`, `AGENTIC_RETENTION_DAYS`                                              | Retention sweep runs daily.          |

Validate the contract with `docker compose --env-file .env.production
config` before every deploy.

---

## 3. Secrets Rotation

Rotation is per-secret, on a 90-day cadence by default. Faster cadences
apply after a confirmed exposure.

### 3.1 LLM provider keys (Anthropic / OpenAI / etc.)

1. Issue a new key in the provider console.
2. Update `.env.production` (or your secret manager) — set both old and
   new keys side-by-side, e.g. `ANTHROPIC_API_KEY=<new>` and leave a
   `ANTHROPIC_API_KEY_OLD=<old>` reminder.
3. `docker compose up -d api` to roll the api container — Fastify reads
   env once per process boot.
4. Watch `llm_provider_errors_total` for 10 minutes; rate spikes on the
   new key code path indicate the swap didn't land.
5. Delete the old key in the provider console.

### 3.2 Inngest keys

Rotating the signing key invalidates pending events. Plan a maintenance
window (or quiesce inngest first via the broker UI's `pause inbox`).

1. Generate new key: `openssl rand -hex 32`.
2. Update `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` in both `api` and
   `inngest` env.
3. Drain in-flight events: `docker compose pause api` for 60s.
4. Restart both services. `/health` should report inngest.ok within 30s.

### 3.3 JWT / session secret

The session secret signs browser cookies. Rotating logs every user out.
Pre-announce. Run rotation during low-traffic hours.

1. Generate new secret: `openssl rand -hex 32`.
2. Replace `AUTH_SESSION_SECRET` (or `JWT_SECRET` when AUTH_MODE uses
   JWT bearer tokens).
3. Restart api. Audit log gets a `session.invalidated_all` entry.

### 3.4 Webhook HMAC secrets

Per-provider; rotate independently. Update the provider's webhook config
to send signatures with the new secret, then update
`WEBHOOK_HMAC_SECRET_<PROVIDER>`. The runtime supports a 60-second
overlap window for in-flight signed requests.

---

## 4. Deploy / Rollback

### 4.1 Standard deploy

```
git pull origin main
docker compose build           # rebuilds api + web images
docker compose up -d           # rolling restart of all 3 services
docker compose logs -f api | head -30   # watch for bootstrap completion
curl -sf http://localhost:3501/health | jq '.ok'
```

The api container waits for the inngest healthcheck before accepting
traffic (compose `depends_on`). The web container is stateless and can
be restarted at any time.

### 4.2 Rollback

```
# Tag your last-known-good image before each deploy (CI does this).
docker tag agentic-api:dev agentic-api:rollback
docker tag agentic-web:dev agentic-web:rollback

# To roll back:
docker compose down api web
docker tag agentic-api:rollback agentic-api:dev
docker tag agentic-web:rollback agentic-web:dev
docker compose up -d api web
```

If a migration was applied as part of the deploy, you may also need a
DB restore (§7). Migrations in this codebase are additive-only by
convention; rolling back the schema is unusual.

### 4.3 Graceful shutdown

The api installs a SIGTERM handler that:

1. Stops accepting new HTTP connections.
2. Drains in-flight handlers (cap: `AGENTIC_SHUTDOWN_TIMEOUT_MS`).
3. Closes the inngest connection.
4. Closes SQLite.
5. Exits 0.

`docker stop` sends SIGTERM and waits 10s by default. Configure
compose's `stop_grace_period` to match `AGENTIC_SHUTDOWN_TIMEOUT_MS` if
you raise the drain window above 10s.

---

## 5. Healthcheck Monitoring

- **Endpoint.** `GET /health` (unauthenticated, no rate limit).
- **Status code.** `200` when every subsystem is healthy; `503`
  otherwise. Always JSON.
- **Subsystems checked.** `sqlite` (open + journal mode), `inngest`
  (reachable when `INNGEST_BASE_URL` set), `disk` (logs dir mountable),
  `llmGateway` (provider registry populated).
- **Version surface.** `body.version` and `body.schemaVersion` for
  deploy-correlation in dashboards.

Wire a monitor (Uptime Robot, AWS CloudWatch synthetic, Grafana
synthetic, etc.) to `https://api.example.com/health` with a 30s
interval. Page when 3 consecutive checks return 503.

The same endpoint backs the Docker `HEALTHCHECK` directive, so
`docker compose ps` reflects subsystem health out of the box.

---

## 6. Metrics + Log Shipping

### 6.1 Prometheus `/metrics`

`GET /metrics` exposes Prometheus text-exposition v0.0.4. **It is
unauthenticated by design**; restrict access via:

- A reverse-proxy ACL (recommended).
- Binding the api to a private network and exposing only `/health` +
  `/v1/*` over the public network.

Series produced:

| Type      | Name                        | Labels                            |
| --------- | --------------------------- | --------------------------------- |
| Counter   | `runs_total`                | `tenant, agent, model, status`    |
| Counter   | `tokens_total`              | `tenant, agent, model, direction` |
| Counter   | `cost_usd_total`            | `tenant, agent, model`            |
| Counter   | `http_requests_total`       | `route, method, status`           |
| Counter   | `llm_provider_errors_total` | `tenant, provider, model, code`   |
| Histogram | `run_duration_ms`           | `tenant, agent`                   |
| Histogram | `http_request_duration_ms`  | `route, method`                   |

Bucket boundaries: see `apps/api/src/services/metrics.ts`. The run
histogram is exponential (100ms → 10m); the HTTP histogram covers
5ms → 10s.

Grafana template: `docs/dashboards/grafana-operator.json` (TBD —
contribute when you have a working board).

### 6.2 Pino → stdout

All processes log JSON to stdout. Pino redacts `authorization`,
`cookie`, `x-api-key`, and any field named `password|apiKey|secret`
before transport sees them.

To ship logs, the recommended pattern is:

- **Loki + Promtail/Vector.** Promtail tails container stdout and
  pushes to Loki; correlate via the `requestId` field already on every
  line. Grafana → Loki → derived fields for `tenantSlug` / `runId`.
- **CloudWatch.** Use the `awslogs` Docker log driver. CloudWatch Logs
  Insights queries on the same JSON keys.
- **Datadog / Splunk.** Tail container stdout with the agent of your
  choice. The same field names work everywhere — that's the whole point
  of standardized request-id propagation.

The request-id chain is: caller supplies `x-request-id` → Fastify uses
it as `req.id` → pino emits it as `requestId` on every line → 5xx
response body includes it.

---

## 7. SQLite Backup + Restore

### 7.1 Backup

`pnpm db:backup` (or `bash scripts/db-backup.sh`) runs `VACUUM INTO`
into `data/backups/agentic-YYYYMMDD-HHMMSS.db`, verifies the snapshot
has schema rows, snapshots append-only logs and step artifacts into the
matching `agentic-YYYYMMDD-HHMMSS-evidence/` directory, and prunes both
parts after 90 days (`BACKUP_RETENTION_DAYS` override).

Cron suggestion (host-side):

```
0 3 * * * /opt/agentic-operator/scripts/db-backup.sh >> /var/log/agentic-backup.log 2>&1
```

Inside the api container, an equivalent inngest cron lands as part of
Phase 4.5 once the production scheduler is wired (`AGENTIC_SYSTEM_CRON`).

### 7.2 Restore drill (rehearse quarterly)

```
docker compose stop api
cp data/backups/agentic-20260520-030000.db data/agentic.db
cp -R data/backups/agentic-20260520-030000-evidence/logs data/logs
cp -R data/backups/agentic-20260520-030000-evidence/artifacts data/artifacts
rm -f data/agentic.db-wal data/agentic.db-shm
docker compose start api
curl -sf http://localhost:3501/health | jq '.sqlite.ok'   # expect true
```

If WAL artifacts existed at backup time and you skip the `rm -f`,
SQLite tries to replay the (now-stale) journal and either errors or
returns inconsistent reads.

---

## 8. Common Incident Playbooks

### 8.1 `/health` 503 — sqlite.ok=false

- Check the volume mount: `docker exec agentic-api ls -lh /app/data`.
  If the file is missing, the volume didn't mount. Restart with the
  correct mount.
- Check disk space: `docker exec agentic-api df -h /app/data`.
- If the WAL got large: `docker exec agentic-api sqlite3
/app/data/agentic.db 'PRAGMA wal_checkpoint(TRUNCATE);'`.

### 8.2 `/health` 503 — inngest.ok=false

- Is the inngest container running? `docker compose ps inngest`.
- Network: `docker exec agentic-api wget -q -O - http://inngest:8288/health`.
- Signing key mismatch is the most common cause when the broker is
  reachable but the api still 503s — re-check both env vars match.

### 8.3 5xx burst

- `curl -s http://localhost:3501/metrics | grep http_requests_total |
grep 'status="5'` for the breakdown by route.
- Pull recent error logs: `docker compose logs --tail=200 api | grep
'"level":50'`.
- `requestId` from the customer ticket → grep into Loki/CloudWatch
  filtered on that field for the full request trace.

### 8.4 LLM provider errors spike

- `llm_provider_errors_total{provider="anthropic"}` rate over 5m on
  the dashboard. If clearly elevated, check the provider's status page.
- If it's specific to one tenant + model, that tenant likely hit a
  rate cap on their key. Triage in the tenant's budget view
  (`/v1/budgets`).
- Manual mitigation: set `LLM_DEFAULT_PROVIDER` to a fallback provider
  in `.env.production` and restart api. Tenant manifests that pin a
  specific provider still try it first.

### 8.5 Stuck "running" runs after crash

A run row marked `running` whose api crashed before completion stays
that way until the orphan sweeper runs. To force a sweep:

```
# Inside the api container:
docker exec agentic-api node -e "
  import('./packages/runtime/dist/sweepers.js')
    .then(m => m.runOrphanedRunsSweep())
    .then(r => console.log(r));
"
```

(Phase 4.5 lands an `Inngest cron + POST /v1/admin/sweep` for this; the
inline command is the bridge.)

### 8.6 Rate-limited tenants

`http_requests_total{status="429"}` rising for a specific route + tenant
means our `AGENTIC_RATE_LIMIT_PER_MIN` cap is too tight. Either:

- Set a per-tenant override (TBD — v2 work).
- Raise the global cap. Reload api.

---

## 9. Capacity + Limits

| Resource             | Default            | Tune via                      |
| -------------------- | ------------------ | ----------------------------- |
| HTTP body size       | 1 MiB              | `AGENTIC_BODY_LIMIT_BYTES`    |
| Rate limit           | 100 req/min/tenant | `AGENTIC_RATE_LIMIT_PER_MIN`  |
| SIGTERM drain window | 30 s               | `AGENTIC_SHUTDOWN_TIMEOUT_MS` |
| Run-log retention    | 30 days            | `AGENTIC_RETENTION_DAYS`      |
| LLM request timeout  | 60 s               | `LLM_REQUEST_TIMEOUT_MS`      |

SQLite handles roughly 10k writes/s on a modern SSD; the api's
concurrency is bounded by Fastify (default 1000 in-flight requests) and
Inngest's per-function concurrency (set in
`packages/runtime/src/register.ts`, keyed on `event.data.subject`).

---

## 10. Escalation Path

- **Tier 1 (the operator on shift).** Run through §8 playbooks. If a
  playbook resolves it, log the incident in the on-call tracker.
- **Tier 2 (platform engineer).** Paged when §8 doesn't apply or when
  a 5xx burst lasts > 10 minutes.
- **Tier 3 (architect).** Schema migration failures, security incidents,
  systemic LLM-gateway issues.

Page templates and contact info live in the on-call wiki — keep them
out of git.
