# Agentic Operator × allmetaOntology — Ontology Execution Redesign

> 2026-08-19 · Status: APPROVED FOR IMPLEMENTATION · Owner: platform
> Goal: run the power-scm launch scenarios end-to-end — ontology package in, agents/workflows compiled, deployed, executed event-driven, monitored in realtime, evaluated in sandbox, at exact LLM cost.

## 0. Verdict from the code review (what we keep)

The current AO is NOT a prototype. We keep, unchanged:

| Capability | Where | Requirement it already satisfies |
|---|---|---|
| Durable event-driven engine (10 step types, HITL waitForEvent, cancel/replay, compensation, transactional outbox) | `packages/runtime/{register,step-engine,manifest}.ts` | engine core, human gates, rerun |
| Harness (tool-use loop, allowlist ∩, output repair, context folding, memory handles) | `packages/runtime/step-engine.ts callLLM`, `packages/agents/run-engine.ts`, `packages/runtime/memory.ts` | #1 harness — **decision: keep the in-house harness; do NOT embed pi/opencode** (pi is an embeddable coding-agent SDK, opencode is an app; both bring a file-edit tool surface we don't want in an ontology runtime. We borrow their ideas — session trees, per-call accounting — which AO already has) |
| LLM gateway: 15 providers, per-attempt `llm_calls` ledger, exact USD-nanos cost, budgets, task routing | `packages/llm-gateway`, `/v1/usage` | #5 LLM usage + cost |
| A2A: event emissions + `invoke` (sync sub-agent) + message envelope w/ BlobRef offload | `message-envelope.ts`, `register.ts` | #3 (plus one convenience tool, below) |
| Codegen substrate: factory plan-projection → manifests; attested CodeAct containers | `packages/agent-factory`, `codeact*.ts` | #2 substrate |
| Sandbox: in-process draft runner + gated tool dispatch + attested sandbox plane | `apps/api/services/workflow-test-runner.ts`, `sandbox-mode.ts` | #6 substrate |
| Deploy: manifest-import validate→commit→atomic rename→Inngest hot-swap + rollback; compose dev/prod/sandbox | `services/manifest-import.ts`, `docker-compose*.yml` | #2 redeploy, #7 substrate |
| Realtime fabric: 14-variant `RunStreamEvent` SSE with durable backfill/resume/RBAC | `contracts/stream.ts`, `routes/v1/stream.ts`, `useStream.ts` | #9 wire layer |

## 1. The six gaps we build

### G1 · Ontology→Manifest compiler (`packages/ontology-compiler`) — req #2
Deterministic compiler from an allmetaOntology domain export to an AO tenant manifest. Redeploy = recompile + manifest-import (existing validate/commit/hot-swap pipeline).

**Input** (path passed via CLI): allmetaOntology `demo-packages/power-scm/dist/`
- `studio-models/allmeta/allmeta-power-scm/{objects,rules,actions,events,links,workflows}_v*.json` (studio envelopes: objects/rules = `{metadata,payload}`, events = `{metadata,events}`, workflows = `{metadata,workflows}`, links = `{metadata,links}`, actions = bare array)
- `transform-maps/transform-maps.json` (`object_maps[]` fetch endpoints + `action_maps[]` write endpoints)
- optional per-domain **compiler overlay** `overlays/<domain>.json` (in this repo, versioned) for judgment calls the ontology can't express: conditional emissions, per-rule gate strategy, form schemas for manual steps, tool arg mappings.

**Output**: `models/<tenant>-v1/{workflow_v1.json, actions_v1.json, events_v1.json, objects_v1.json, rules_v1.json}` (AO five-file layout; workflow_v1.json load-bearing) + `models/<tenant>-v1/erp-operations.json` (operation catalog for the `metaerp.invoke` tool) + a tenant seed helper.

**Mapping spec** (normative):
1. **One AgentSpec per ontology Action** (19 agents for power-scm). `name` = ontology action id (e.g. `action-forecast-typhoon-impact`), `title` = Chinese name, `id` likewise. `trigger` = ontology `trigger[]` minus `"MANUAL"`; if that leaves zero triggers, add synthetic `MANUAL_<ACTION_ID_UPPER_SNAKE>` so every agent is event-invocable. `triggered_event` = ontology `triggered_event[]`. `retries` default 3.
2. **Per-kind step compilation**:
   - `implementation.kind === "prompt"` (analysis actions): one `logic` step. `action_prompt` composed from description + ontology action_steps (object_type logic) texts + an explicit JSON output contract naming the emitted-event payload sections. Agent-level `ontology_instructions` = compiled cards: target objects (name + 决策属性 list) + bound rules (id, name, 表达式/义务文). `allowed_tools` / `tool_use[]` = `metaerp.invoke` entries for each `side_effects.external_calls` **query** endpoint (read ops), each pinned via `config.operation`.
   - `implementation.kind === "external"` (ERP write actions): steps in order — (a) **rule gates**: for every `rule_bindings[]` with `phase==="precondition" && enforcement==="mandatory"`: jsonlogic rules → deterministic gate (prefer AO `condition` step if the predicate is expressible in `validateConditionSyntax` grammar, else a `logic` judge step); natural-language rules → `logic` judge step with strict JSON verdict `{ruleId,status:"pass"|"violation",reason}` and `on_error: terminal`; violation ⇒ terminal (block). Step name convention `rule-gate:<RULE_ID>` (the live window §G2 harvests these for `ruleEvaluations`). (b) ontology action_steps with `object_type==="manual"` → AO `manual` step (`form_schema` from overlay or a generic approve/reject template, `awaiting_role` from the ontology workflow roles). (c) the ERP write: `tool` step calling `metaerp.invoke` with `tool_arguments` mapped from trigger-event payload paths (defaults derived from `action_maps[].data_changes` + action inputs; overlay may pin exact arg maps). (d) `result_key` = action id slug.
   - Multi-emission analysis actions (e.g. `action-match-dormant-stock` emits `PSCM_DORMANT_MATCH_FOUND` + `PSCM_IMPAIRMENT_WARNING_RAISED`): overlay declares per-event emit conditions compiled to `decision`/`emit` steps reading the logic result (e.g. `lastResult.match_found`), so events fire only when真实命中.
3. **Events/objects/rules files**: pass-through projections of the studio payloads into the AO five-file metadata shape (bootstrap upserts event_types/entity_types catalogs).
4. **Determinism**: byte-stable output for identical input (sorted keys, no timestamps) so `workflow_versions.version = auto-<sha256>` is meaningful across recompiles.
5. **CLI**: `pnpm ontology:compile -- --source <dir> --tenant power-scm [--overlay overlays/power-scm.json] [--out models/]` + `--check` (compile to temp + diff). Unit tests: golden compile of power-scm committed as fixture snapshot.

### G2 · Agent-execution live window — req #6 hook + Studio eval-test reconnection
Implement the contract Studio already codes against (`allmetaOntology .../eval-test/lib/test-runner/ao-live-contract.ts`, v1.0):
- `GET /api/agent-execution/live/capabilities` — agents from the live manifest registry (`agent` = manifest agent name, `wsId` = same (ontology action id), `triggerEvent`, `emitsEvents`), `modelCapabilities` from the provider catalog for the tenant default route.
- `POST /api/agent-execution/live/executions` — validate strict body; new `agent_executions` table row (id, tenantSlug, agent, clientRequestId UNIQUE for idempotency, eventId, status); publish the tenant trigger event with `subject = executionId`, payload = `inputs.eventData` + (when `config.suppressDownstream`) `__eval_suppress_downstream: true`; respond `{executionId}`.
- `GET /api/agent-execution/live/executions/:id` — join run by triggerEventId/subject → envelope: status map (queued/running→running, ok→succeeded, failed→failed, waiting→running), `result.output` = run output artifact, `trace.steps` from steps rows (name/status/durationMs), `trace.emittedEvents` from run_emitted_events, `trace.ruleEvaluations` harvested from `rule-gate:*` step outputs, `meta.ontologyLoaded` = `{domain, version: manifest workflow version, ruleCount, snapshotDigest: echo of request digest}`.
- **suppressDownstream engine semantics**: in `register.ts` finalize, when trigger event payload carries `__eval_suppress_downstream`, still persist ledger/events/run_emitted_events but skip `step.sendEvent` fan-out.
- Auth: `AO_API_KEY` bearer/x-api-key (single-tenant window, mirroring Studio's client). Conformance gate: allmetaOntology `scripts/verify-ao-sandbox.mjs` must pass.

### G3 · Mock Meta ERP service (`apps/mock-erp`) — the ERP the demo operates
Fastify app, port **3620**, zero DB. Loads the power-scm `dist/mock-erp/*.json` stubs (24 query endpoints, generated from transform maps) at boot from a configured dir (`MOCK_ERP_DATA_DIR`).
- `POST /metaerp/openapi/v1/<queryOp>` → `{rows}` (optional body filters: exact-match on row fields).
- `POST /metaerp/openapi/v1/<writeOp>` for the 15 action_maps ops → mutates in-memory state (e.g. `createTransferOrder` appends a transfer row with generated id; `suspendRequisition` flips the row's STATUS), appends `{ts, op, payload, result}` to `data/mock-erp-journal.ndjson`, returns `{ok:true, id}`.
- `GET /__journal` (verification), `POST /__reset` (reload stubs), `GET /health`.
- `GET /ui` + `GET /ui/transfers` etc.: minimal server-rendered HTML pages (调拨单列表 + 创建调拨单表单 + 采购需求列表) — the **browser-use target** for G5. Forms post to the same write ops.
- New AO env: `METAERP_BASE_URL=http://localhost:3620` (root `.env`), consumed by the `metaerp.invoke` tool via `base_url_env`.

### G4 · Realtime workflow monitor — req #9
Evolve `apps/web .../workflows/page.tsx` canvas from decorative to live:
- Reducer over `useStream` frames: `run.started/step.*/completed/failed` keyed by agentName → node state (idle/running/ok/failed/**waiting-human**); `event.emitted` → edge pulse on the matching event edge; badges show live run count/tokens; node click → inspector with recent runs, step timeline, live log tail (`/v1/runs/:id/logs?follow=1`), IO artifacts.
- Controls per node/run: Cancel (`POST /v1/runs/:id/cancel`), Replay (`/replay`), **Pause/Resume** (new): add `paused` to `runs.status` enum; `POST /v1/runs/:id/pause|resume`; `register.ts` between-action check — when paused, park on `step.waitForEvent('${slug}/run.resume', if subject+runId, timeout 7d)` with stable step ids `pause-<ord>`.
- Human-wait: task.created frames → orange badge + deep-link to resolve UI (exists).

### G5 · Browser computer-use tools (`packages/tools/src/browser/`) — req #4
Session-based Playwright tools registered in the global registry (pattern: `document/convert.ts` — playwright-core + system Chromium, child-safe):
- `browser.openSession` (returns sessionId; headless configurable), `browser.navigate`, `browser.read` (accessibility-tree + text extraction), `browser.click` (selector or role/name), `browser.fill`, `browser.screenshot` (artifact sidecar), `browser.closeSession`. Session manager with TTL reaper; `execution_policy: {operation:"write", effect_scope:"external", sandbox_policy:"gated"}` so sandbox mode records-not-fires.
- Demo proof: an agent variant of `action-create-stock-transfer` (overlay-selectable `channel:"browser"`) fills the mock-erp `/ui/transfers` form instead of calling the API — "AI 操作 ERP 界面" moment.

### G6 · Scenario & package factory skills — req #8
In allmetaOntology `.claude/skills/`: `scenario-factory` (五能力×三时刻 method → scenario proposal + storyline numbers) and `ontology-package-factory` (single-source spec → build→validate→instances→neo4j→install → AO compile+deploy hook). Encodes the proven power-scm pipeline.

## 2. Environments — req #7
Existing compose dev/production/sandbox topologies are the substrate. Add `deploy/environments/{dev,sandbox,production}.env` profiles + `scripts/deploy-env.mjs` (select compose files + env profile, build, up, health-verify `/health` + `/metrics`), documented in `docs/runbook-environments.md`. Promotion path: compile → manifest-import(validate) → **sandbox tenant run via workflow-test-runner + gated tools** → manifest-import(commit) to prod tenant.

## 3. Phasing (each phase ends green: build + typecheck + tests)

| Phase | Contents | Proof |
|---|---|---|
| **P1** | G3 mock-erp + G1 compiler(+overlay power-scm) + `metaerp.invoke` tool + suppressDownstream flag + tenant seed | scenario-1 cascade E2E via workflow-test-runner (mock LLM): typhoon event → forecast → gap event → 4 subscribers (transfer w/ HITL park, PO w/ rule gates EMG-002/004, collab, lock) → logistics; journal shows ERP writes; `pnpm test` green |
| **P2** | G2 live window + agent_executions table | allmetaOntology `verify-ao-sandbox.mjs` passes against :3540 |
| **P3** | G4 monitor (canvas live + pause/resume) | visual check in Chrome: live node states during a real scenario-1 run |
| **P4** | G5 browser tools + mock-erp UI demo · A2A convenience tool `comms.sendToAgent` · G6 skills · env profiles | browser-driven 调拨单 creation captured; skills invocable |

Rules of engagement for implementers: follow `CLAUDE.md` (Node 26 pinning, Inngest durability discipline — every DB write inside `step.run`, `step.sendEvent` only), tools via `defineTool` + `REGISTRATIONS`, contracts in `@agentic/contracts` zod first, tests serial vitest in `apps/api`, no new deps without need (playwright-core already present). No git commits — working tree only.

## 4. Implementation status (2026-08-20) — COMPLETE, verified on the live stack

All phases landed. Proof chain:
- **Suites green**: root typecheck 26/26; apps/api vitest **1874 passed / 0 failed** (271 files); web 588 + build + lint; tools 157 (incl. real-Chrome browser E2E driving mock-erp /ui); runtime 226; contracts 67; ontology-compiler 16; mock-erp 10. Scenario-1 cascade E2E: `apps/api/test/power-scm-scenario1.e2e.test.ts` (3/3, incl. both rule-gate negative paths).
- **Live stack run** (pnpm dev + apps/mock-erp): `POST /v1/events PSCM_STOCK_GAP_IDENTIFIED` → real Inngest fan-out to 4 subscribers → EMG-002 condition gate + **EMG-004 judged by a real LLM** (openai/gpt-5.6-sol, 958/406 tokens, exact cost from the ledger) → two HITL 应急审批 tasks approved in the portal (task cards show the judge's verdict JSON as decision evidence) → ERP journal: lockInventoryLot → createEmergencyPo (PO-EMG-*) → createTransferOrder (TRF-*) → createShipmentTask referencing the same TRF id. Realtime canvas: live legend, RECENT RUNS scrubber, waiting-human badge, task deep-links — all observed live.
- Incidental repairs shipped: FactoryPorts missing ports (committed break), .gitignore accidental truncation restored (incl. security ignores), model-catalog 365-day aging test rot (3 tests realigned), mock-guard 409 ordering in agent-invoke, judge-verdict case tolerance in the compiler. Two product bugs filed as task chips: test runs contaminating apps/api/.env.local managed LLM-settings block; (earlier, in allmetaOntology) L2 lint vs package-validator source_object conflict.
- Known notes: /health inngest readiness shows "degraded" whenever any tenant's connect-gateway app (agents-generation) is disconnected — HTTP-mode dispatch works regardless; Studio's verify-ao-sandbox.mjs expects a RuleCheck agent + specific default model, so full conformance E2E against power-scm needs AO_VERIFY_* env alignment (wire shapes are validated in apps/api/test/agent-execution-live.test.ts).

## 5. Scenarios 2 and 3 on the live stack (2026-08-20, second pass)

Scenario 1 proved the cascade. Scenarios 3 (拦下一张采购单) and 2 (一眼穿透) then ran end to end on the same live stack and exposed three real defects, all fixed here.

**5.1 The authored output contract never reached the model (engine defect).**
A compiled ontology agent puts its fail-closed output contract (hard key enumeration + skeleton) in the logic step's `action_prompt`. The v2 execution path already preferred `action_prompt` over the one-line `description`, but the declarative *generated v1* path in `step-engine.ts` passed only `action.description` into `makeGeneratedAgentPrompt` — so the contract was silently dropped and the LLM invented its own top-level schema (`decision` / `recommended_transfer` / `financial_impact`). Every downstream conditional emission read `lastResult.match_found`, found `undefined`, and the business chain stopped with a green run. Fixed by giving the v1 path the same precedence, scoped by an explicit v2 check so v2 agents keep the description in their action-context block (`packages/runtime/src/step-engine.ts`, search `authoredLogicObjective`). This is the general lesson: **a compiler-authored contract is only real if the runtime actually renders it.**

**5.2 Dormancy was stored, not derived (package defect, design-law violation).**
`generate-instances.mjs` wrote `status: "dormant"` on the slow-moving lots, while rule PSCM-INV-001 defines dormancy as `age_days > 720 AND status == "available"`. The compiled INV-001 gate therefore refused every allocation. Storing a judgement as ERP state is exactly the mirror-smell the ontology is supposed to eliminate; the mock ERP now carries only the ERP-truthful `available` and the ontology derives 呆滞. (`demo-packages/power-scm/scripts/generate-instances.mjs`, `demo-queries.mjs`.)

**5.3 The related-party judgement had no evidence source (capability gap).**
RSK-002 ("替代供应商不得与风险供应商同一实控人") cannot be decided from Meta ERP: 实控人 is deliberately absent from the ERP because it comes from external 工商股权 data — it exists only in the ontology graph. Both the scanner and the RSK-002 judge correctly refused (fail-closed `violation`, "证据不足"), which is the right behavior but the wrong outcome. Closed by granting the existing read-only `ontology.query` tool through a new overlay key:

```json
"extra_tools": { "<agent-name>": [ { "name": "ontology.query", "description": "...", "grant_to_judges": true } ] }
```

The compiler appends a `tool_use` entry carrying the registry-mirrored reviewed policy `{operation:"read", effect_scope:"external", sandbox_policy:"live_external"}`, adds the tool to the analyze step's `allowed_tools`, and with `grant_to_judges` also to every `rule-gate:*` judge plus a prompt line telling the judge to fetch graph evidence before ruling and to stay fail-closed if it cannot. Only `ontology.query` is accepted; any other name throws, so no unreviewed policy can ship.

Operator wiring for the graph (`.env`): `NEO4J_QUERY_API_URL`, `NEO4J_USERNAME`/`NEO4J_PASSWORD`, `NEO4J_DATABASE`, `NEO4J_ALLOWED_PROPERTIES` (business fields the projection may return), and `NEO4J_ID_PROPERTY=instanceId`. The last one matters: `tenant_property`, `id_property` and `database` are **server-owned** in `ontology.query` and an agent-supplied `config` that merely *restates* them throws (`id_property is server-owned and cannot be overridden by an agent`) — so the overlay grant carries no config at all. The graph slice is scoped by a `tenant_slug` property stamped across the tenant+domain slice by `load-neo4j.mjs`, since the AO tenant slug (`power-scm`) differs from the allmeta tenant UUID and the studio TENANT_SLUG.

**Live results.**
- Scenario 3 (`s3-intercept-006`): `PSCM_REQUISITION_SUBMITTED` → contract-conformant analysis (`match_found`, `suspend`, `allocation`, `impairment_*`) → `suspendRequisition` + `createAllocation` (REQ-2026-1101 ← InventoryLot-008, 30 000 units, 1.35M savings) + the impairment branch's `createDisposal` → both 双边确认 HITL tasks approved in the portal → `confirmAllocation` on the same ALC id.
- Scenario 2 (`s2-xray-005`): `PSCM_LEGAL_DISHONEST_RECEIVED` (SUP-001) → scanner queries the ERP for exposure **and the graph for controllers** → screening output names both candidates with `controller_verified_by_graph: true`: SUP-003 → UC-001 `excluded_as_related_party` (the 马甲 trap — same controller as the risk supplier), SUP-009 → UC-007 `eligible_alternative` → RSK-002 judge **passes citing the graph** ("SUP-009 的 controller_id 为 UC-007，SUP-001 为 UC-001，不构成关联方假备选") → ERP journal: `sendExpediteNotice`, `createInspectionTask`, `addRiskFlag`, `createRfq` (SUP-009 / MAT-CAB-YJV / 22).
- Pause/resume demonstrated on a real in-flight run (`s2-xray-001`): `POST /v1/runs/:id/pause` parked it before its next action (`status: paused`), `resume` released it and the cascade completed.

**Operational traps worth remembering.** `apps/mock-erp` must be started *after* the main stack (the root `predev` kills workspace processes); the API's dev script reads `--env-file` only at supervisor start, so appended env vars need a full `stop-dev.sh` + `pnpm dev`, not a watch-triggered reload; and if mock-erp is down, write agents burn their Inngest retries and land in `failed` — restart it before firing, not after.

## 6. Adversarial review of the graph work (2026-08-20) — 5 confirmed defects, all fixed

An 18-agent review workflow (4 reviewers → per-finding refutation panel) ran over the session's diffs alongside a full build/test sweep. Ten findings were raised; five survived independent refutation and are fixed here. The refuted five are recorded in the run journal, not here.

**6.1 The compiled `ontology.query` schema omitted the only filters the tool reads.** `ontologyQueryInputSchema()` emitted `additionalProperties: false` while listing `labels`/`properties` — which the `neighbors` branch never reads — and omitting `relationship_types`/`neighbor_labels`, which are the only two arguments it does read. A closed schema makes an omitted argument unreachable, so the model could not narrow a neighbour scan at all: it passed `labels`, got every edge back, and retried. The live trace showed exactly that (three graph calls before it had what it needed). After the fix the same agent issues one precise call: `relationship_types:["CONTROLLED_BY"], neighbor_labels:["UltimateController"]`.

**6.2 An overlay could choose which server secret becomes the Neo4j password.** The overlay's `config` passed through verbatim, and `ontology.query` reads its credentials from whatever env names `username_env`/`password_env` point at. An overlay is tenant-authored config, not operator config, so it must not pick credential sources or endpoints. Config is now narrowed to an allow-list (`tenant_property`, `id_property`, `database`, `search_properties`, `timeout_ms`, `max_execution_time_ms`); anything else — `username_env`, `password_env`, `base_url` — throws at compile time. Tested per key.

**6.3 `truncated` was structurally always false.** Every generated statement ends in `LIMIT $limit`, so the server had already applied the cap and the client-side `slice` never dropped a row. The flag therefore reported "complete" even on a capped result. On a relationship scan the distinction is load-bearing — "no related party" and "capped, unverified" lead to opposite business conclusions — so it now reports whether the cap was reached. This was a pre-existing tool defect, not introduced by this work; `ontology.query` had no test file at all, so one was added covering this plus the tenant-predicate invariant across all five operations.

**6.4 `InventoryLot.status` still declared `dormant` as an ERP-sourced enum value.** §5.2 removed every producer of that value but left the schema asserting Meta ERP could hand the ontology a dormancy verdict. The enum is now `available | reserved | locked`.

**6.5 Nothing told the agent which properties it must derive.** PSCM-INV-001 gates on `age_days`, which is declared `is_computed` (`today() - inbound_date`) and has no ERP column — but the compiled instructions listed it as a bare property name alongside genuinely ERP-backed ones, so an agent reading the list as "fields I can query" gets nothing back and invents a value. Compiled instructions now mark derived properties with their derivation: `age_days（推导＝today() - inbound_date）`. This is general, not power-scm-specific: any domain with computed properties had the same silent failure.

Also fixed: a pre-existing red test at HEAD (`scripts/run-db-command.test.mjs` never learned about the deliberately-unsupervised `recover-writer-lease` op), and a brittle new test whose "no-grant baseline" read the live, operator-editable `overlays/power-scm.json`.

**Process finding worth keeping:** `corepack pnpm test` does NOT cover the repo on a red run. The root script is `node --test <5 files> && turbo run test`, so a failure in the node step short-circuits turbo entirely; and turbo's default `--continue=false` means one failing package hides every package after it — including `apps/api`, the largest suite. A red `pnpm test` is a partial result, never a complete one.

**Final state:** repo typecheck 26/26 Done (exit 0); `corepack pnpm test` green — 10/10 turbo tasks, `apps/api` 1878 passed / 0 failed / 5 skipped. Live: scenarios 1, 2 and 3 all complete end to end with real LLM calls, real graph queries, real HITL approvals and real ERP writes; pause/resume and replay both demonstrated on live runs (replay re-fires the trigger and produces fresh runs tagged `invocationSource: replay`).
