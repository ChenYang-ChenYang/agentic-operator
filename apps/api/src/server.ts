import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerEnvelope } from "./plugins/error";
import { registerAuth } from "./plugins/auth";
import { registerUsageAttribution } from "./plugins/usage-attribution";
import { registerSecurity } from "./plugins/security";
import { installGracefulShutdown } from "./plugins/shutdown";
import { healthRoute } from "./routes/health";
import { metricsRoute } from "./routes/metrics";
import { eventsRoutes } from "./routes/v1/events";
import { runsRoutes } from "./routes/v1/runs";
import { reasoningRoutes } from "./routes/v1/reasoning";
import { operatorChecksRoutes } from "./routes/v1/operator-checks";
import { runsLogsRoute } from "./routes/v1/runs-logs";
import { tasksRoutes } from "./routes/v1/tasks";
import { agentsRoutes } from "./routes/v1/agents";
import { agentAuthoringRoutes } from "./routes/v1/agent-authoring";
import { agentInvokeRoutes } from "./routes/v1/agent-invoke";
import { agentFactoryRoutes } from "./routes/v1/agent-factory";
import { agentStudioRoutes } from "./routes/v1/agent-studio";
import { deploymentsRoutes } from "./routes/v1/deployments";
import { webhooksRoutes } from "./routes/v1/webhooks";
import { artifactsRoutes } from "./routes/v1/artifacts";
import { recordsRoutes } from "./routes/v1/records";
import { readsRoutes } from "./routes/v1/reads";
import { llmRoutes } from "./routes/v1/llm";
import { manifestImportRoutes } from "./routes/v1/manifest-import";
import { tenantsRoutes } from "./routes/v1/tenants";
import { usageRoutes } from "./routes/v1/usage";
import { observabilityRoutes } from "./routes/v1/observability";
import { budgetsRoutes } from "./routes/v1/budgets";
import { auditRoutes } from "./routes/v1/audit";
import { streamRoutes } from "./routes/v1/stream";
import { tenantCodeRoutes } from "./routes/v1/tenant-code";
import { workflowRoutes } from "./routes/v1/workflow";
import { workflowAuthoringRoutes } from "./routes/v1/workflow-authoring";
import { toolsRoutes } from "./routes/v1/tools";
import { integrationsRoutes } from "./routes/v1/integrations";
import { systemProfilesRoutes } from "./routes/v1/system-profiles";
import { ontocodeRoutes } from "./routes/v1/ontocode";
import { ontocodeAssistantRoutes } from "./routes/v1/ontocode-assistant";
import { ontocodeStreamRoutes } from "./routes/v1/ontocode-stream";
import { businessOntologyDomainRoutes } from "./routes/v1/business-ontology-domains";
import { runtimeProfileRoutes } from "./routes/v1/runtime-profiles";
import { apiTokensRoutes } from "./routes/v1/api-tokens";
import { authRoutes } from "./routes/v1/auth";
import { membersRoutes } from "./routes/v1/members";
import { adminUsersRoutes } from "./routes/v1/admin-users";
import {
  startAppReconciler,
  stopAppReconciler,
  syncAllAppsWithRetry,
} from "./services/inngest-sync";
import {
  startRunReconciler,
  stopRunReconciler,
} from "./services/reconcile-runs";
import { inngestRoute } from "./routes/inngest";
import { bootstrapRuntime } from "./bootstrap";
import { getMcpManager } from "@agentic/mcp";
import { factorySandboxModelProxyRoutes } from "./services/agent-factory/factory-sandbox-model-proxy";
import { factorySandboxProbeRoutes } from "./services/agent-factory/factory-sandbox-probe-route";
import { productionCodeActRpcRoutes } from "./services/production-codeact-rpc-route";
import {
  assertInheritedSqliteWriterLease,
  checkpointAndCloseDb,
} from "@agentic/db";
import {
  startOntoCodeHarnessWorker,
  type OntoCodeHarnessWorkerController,
} from "./services/ontocode-harness-worker";

// Executable-entrypoint state only. `build()` never assigns this, so API tests
// and embedders get routes/storage without an unexpected background poller.
let executableOntoCodeHarnessWorker:
  | OntoCodeHarnessWorkerController
  | null = null;

function startupErrorSummary(error: unknown): {
  name: string;
  message: string;
} {
  const name =
    error instanceof Error && error.name ? error.name : "StartupError";
  const raw =
    error instanceof Error
      ? error.message
      : String(error ?? "unknown startup error");
  const message = raw
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|authorization|secret|password|cookie|credential|session)\s*[:=]\s*)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED_KEY]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .slice(0, 500);
  return { name, message };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function ontocodeHarnessWorkerEnabled(): boolean {
  const raw = process.env.ONTOCODE_HARNESS_WORKER_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `ONTOCODE_HARNESS_WORKER_ENABLED must be true or false; received ${JSON.stringify(raw)}`,
  );
}

function webOrigin(): string {
  const configured = process.env.WEB_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error(
      "WEB_ORIGIN is required in production; refusing a localhost CORS fallback",
    );
  }
  const value = configured || "http://localhost:3599";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WEB_ORIGIN must be an absolute http(s) URL");
  }
  return url.origin;
}

// Studio file controls encode uploads as data URLs in the run reservation
// request. Base64 adds roughly 33%, so the HTTP envelope must be larger than
// the old 1 MB default while still remaining globally bounded. Honour the
// canonical AGENTIC_BODY_LIMIT_BYTES first, then the enterprise-side
// AGENTIC_MAX_BODY_BYTES name, else 16 MB.
const MAX_BODY_BYTES = positiveIntegerEnv(
  "AGENTIC_BODY_LIMIT_BYTES",
  positiveIntegerEnv("AGENTIC_MAX_BODY_BYTES", 16 * 1024 * 1024),
);
const PORT = positiveIntegerEnv("PORT", 3540);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEB_ORIGIN = webOrigin();

export async function build() {
  const app = Fastify({
    // Honour any client-supplied `x-request-id` (so the web tier can stitch
    // its own trace ids together with ours), else mint a fresh UUID. The
    // value is mirrored back on every response via the `onSend` hook below
    // and is also the value pino emits as `reqId` on every log line.
    genReqId: () => randomUUID(),
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "reqId",
    bodyLimit: MAX_BODY_BYTES,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
          ? {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss.l", colorize: true },
            }
          : undefined,
    },
  });

  // Register resource cleanup before the first plugin/bootstrap operation.
  // If composition fails halfway through (for example after an MCP stdio
  // child or Redis client has opened), build() closes the partial app below
  // and this hook drains every resource instead of leaving the process alive.
  app.addHook("onClose", async () => {
    const shutdownErrors: unknown[] = [];
    const ontocodeWorker = executableOntoCodeHarnessWorker;
    executableOntoCodeHarnessWorker = null;
    if (ontocodeWorker) {
      try {
        // Abort only sandbox work, persist retry_scheduled, and relinquish its
        // fenced lease while SQLite is still writable.
        await ontocodeWorker.stop({ abortActive: true });
      } catch (error) {
        shutdownErrors.push(error);
      }
    }
    try {
      const { stopGovernanceRunner } =
        await import("./services/agent-factory/fleet-governance-runner");
      stopGovernanceRunner();
    } catch {
      /* best-effort */
    }
    try {
      const { stopRedisFanout } = await import("./services/fanout-redis");
      await stopRedisFanout();
    } catch {
      /* inert when never wired */
    }
    try {
      const { stopPgVectorMemory } = await import("./services/memory-pgvector");
      await stopPgVectorMemory();
    } catch {
      /* inert when never wired */
    }
    try {
      await getMcpManager().closeAll();
    } catch {
      /* transports may already have exited */
    }
    stopAppReconciler();
    stopRunReconciler();
    try {
      const { stopFactorySandboxReaper } = await import(
        "./services/agent-factory/sandbox-reaper"
      );
      stopFactorySandboxReaper();
    } catch {
      /* inert when never started */
    }
    // This is the durable writer hand-off boundary. Checkpoint/close failures
    // must reject Fastify shutdown; the outer supervisor will retain its
    // canonical lease instead of allowing a second writer to start.
    try {
      checkpointAndCloseDb();
    } catch (error) {
      shutdownErrors.push(error);
    }
    if (shutdownErrors.length === 1) throw shutdownErrors[0];
    if (shutdownErrors.length > 1) {
      throw new AggregateError(
        shutdownErrors,
        "OntoCode worker drain and SQLite shutdown both failed",
      );
    }
  });

  try {
    // Mirror the request id back to the caller on every response so the
    // browser devtools / e2e tests can grab it from response headers.
    // Skipped once the reply is already sent (e.g. SSE streams that flush
    // headers eagerly via `raw.writeHead`) — writing again would trip
    // `ERR_HTTP_HEADERS_SENT` and crash the process.
    app.addHook("onSend", async (req, reply) => {
      if (reply.sent || reply.raw.headersSent) return;
      reply.header("x-request-id", req.id);
    });

    await app.register(cors, {
      origin: WEB_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // No explicit allowedHeaders: @fastify/cors then reflects
      // Access-Control-Request-Headers, which covers both the portal's
      // headers (x-agentic-tenant, authorization) and the enterprise
      // attribution headers (If-Match, Idempotency-Key, Last-Event-ID,
      // X-Agentic-Product-Surface/-Action, X-Agentic-Interaction-Id).
      // CORS-restricted browsers strip non-safelisted response headers
      // unless explicitly exposed — without this the `x-request-id` echo
      // above is invisible to the web app, and studio optimistic-concurrency
      // (If-Match/etag) breaks.
      exposedHeaders: ["etag", "x-request-id"],
    });

    await registerEnvelope(app);
    await registerAuth(app);
    // Usage attribution (billing spine) — runs after auth so every ledger row
    // carries the authenticated billing account/actor, before any /v1 route.
    await registerUsageAttribution(app);
    await registerSecurity(app);

    // Health + Prometheus metrics — both unauthenticated; metrics is
    // top-level (no /v1 prefix) per Prometheus convention so scrapers don't
    // need to know about the API versioning.
    await app.register(healthRoute);
    await app.register(metricsRoute);
    // Service-authenticated semantic execution channel used only by the
    // isolated sandbox workload. It has its own attempt/bundle grant checks;
    // browser/user auth is intentionally neither accepted nor required.
    await app.register(factorySandboxModelProxyRoutes);
    await app.register(factorySandboxProbeRoutes);
    await app.register(productionCodeActRpcRoutes);

    // Runs boot: builds per-tenant Inngest apps + seeds the per-app registry that
    // the `/inngest[/:slug]` routes delegate to. The route reads the registry per
    // request, so it needs no bootstrap result handed in.
    await bootstrapRuntime();
    await inngestRoute(app);

    // /v1 REST surface
    await app.register(
      async (v1) => {
        await v1.register(eventsRoutes);
        await v1.register(runsRoutes);
        await v1.register(reasoningRoutes);
        await v1.register(runsLogsRoute);
        await v1.register(tasksRoutes);
        await v1.register(agentsRoutes);
        // Agent authoring + Agent Studio (enterprise): agent draft/spec
        // authoring endpoints and the studio run/observability surface.
        await v1.register(agentAuthoringRoutes);
        await v1.register(agentInvokeRoutes);
        await v1.register(agentStudioRoutes);
        // Operator checks — enterprise operational health-check surface.
        await v1.register(operatorChecksRoutes);
        // Agent Factory — autonomous brain SSE stream (generates business agents from
        // a domain's models/ ontology, streamed live to the portal factory tab).
        await v1.register(agentFactoryRoutes);
        await v1.register(deploymentsRoutes);
        await v1.register(webhooksRoutes);
        await v1.register(artifactsRoutes);
        await v1.register(recordsRoutes);
        await v1.register(readsRoutes);
        await v1.register(llmRoutes);
        await v1.register(manifestImportRoutes);
        await v1.register(tenantsRoutes);
        // Settings → Usage / Audit / Budgets surfaces. Previously dead-on-
        // arrival files (P0-LOG-D1 / 03-logging-audit.md).
        await v1.register(usageRoutes);
        await v1.register(observabilityRoutes);
        await v1.register(budgetsRoutes);
        await v1.register(auditRoutes);
        // Sprint 1 Phase 3 + Sprint 2 Obs: live SSE event stream, tenant
        // code-agent management, and workflow CRUD. These were registered
        // out-of-band by earlier sprints; restored here after a stash-pop
        // regression dropped them (REG-S2-03).
        await v1.register(streamRoutes);
        await v1.register(tenantCodeRoutes);
        await v1.register(workflowRoutes);
        // Workflow authoring (enterprise): draft/version/test-run authoring
        // endpoints layered on the workflow CRUD surface.
        await v1.register(workflowAuthoringRoutes);
        // Global tool catalog — drives the Tools view in the portal so
        // manifest authors can browse what's available without spelunking.
        await v1.register(toolsRoutes);
        // External-service integrations (Settings → Integrations). GoHire ATS
        // base URL + encrypted API key, read by the GoHire tool family.
        await v1.register(integrationsRoutes);
        // OntoCode 外部系统档案 — external platform declarations (aliases +
        // api/events/data capabilities) powering integration binding.
        await v1.register(systemProfilesRoutes);
        // Tenant-facing Business Domain → managed Ontology Domain registry.
        await v1.register(runtimeProfileRoutes);
        await v1.register(businessOntologyDomainRoutes);
        // OntoCode conversational engineering workspace — durable projects,
        // sessions, messages, typed commands, Harness jobs, and event history.
        await v1.register(ontocodeRoutes);
        await v1.register(ontocodeAssistantRoutes);
        await v1.register(ontocodeStreamRoutes);
        // Workspace API-token lifecycle for Settings → API tokens. Secrets are
        // returned once on create/rotate and stored only as bearer-compatible
        // SHA-256 hashes.
        await v1.register(apiTokensRoutes);
        // P6-AUTH — login + identity, tenant-scoped membership management, and
        // platform-wide user administration (the Access tab + sign-in/up flows).
        await v1.register(authRoutes);
        await v1.register(membersRoutes);
        await v1.register(adminUsersRoutes);
      },
      { prefix: "/v1" },
    );

    return app;
  } catch (error) {
    // `build()` is also used outside the executable entrypoint (tests and
    // embedders). It therefore owns cleanup for failures that occur before an
    // app instance can be returned to the caller.
    try {
      await app.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "API composition failed and SQLite shutdown did not complete safely",
      );
    }
    throw error;
  }
}

// Auto-start only when this file is the main entrypoint, not when imported by tests.
// Compare normalized file URLs so a project path containing spaces (which
// import.meta.url percent-encodes but a raw `file://` + argv concat does not)
// still matches.
const isMain =
  !!process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // build() remains importable by tests and read-only tooling. Executing the
  // writable server entrypoint directly is forbidden: only the supervisor
  // owns the lease spanning migration → listen → checkpoint/close.
  assertInheritedSqliteWriterLease(
    process.env.DATABASE_URL?.trim()
      || `file:${resolvePath(process.cwd(), "../../data/agentic.db")}`,
  );
  // #FATAL-LOG — durable last words. An uncaught exception / unhandled rejection thrown OUTSIDE a
  // request context (e.g. an SSE write racing a client disconnect, a timer callback) kills the whole
  // process; under `tsx watch` it silently restarts, so every /v1/* request in the gap surfaces as a
  // proxied 500 with a non-JSON body ("HTTP 500 返回了无效 JSON") and the crash stack only flashes by
  // in a terminal. Append the stack to <dataRoot>/api-fatal.log so post-mortems have first-party
  // evidence, then exit(1) preserving Node's fail-fast semantics (tsx watch restarts us).
  const fatalLog = (kind: string, err: unknown) => {
    try {
      const dataRoot = resolvePath(process.cwd(), process.env.AGENTIC_DATA_ROOT?.trim() || "../../data");
      mkdirSync(dataRoot, { recursive: true });
      const stack = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
      appendFileSync(resolvePath(dataRoot, "api-fatal.log"), `\n[${new Date().toISOString()}] ${kind} (pid ${process.pid}, uptime ${Math.round(process.uptime())}s)\n${stack}\n`);
    } catch {
      /* the log must never mask the original crash */
    }
  };
  process.on("uncaughtException", (err) => {
    fatalLog("uncaughtException", err);
    console.error("[fatal] uncaughtException", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    fatalLog("unhandledRejection", reason);
    console.error("[fatal] unhandledRejection", reason);
    process.exit(1);
  });
  // 'exit' fires for process.exit()/normal completion but NOT for terminating signals — so a death
  // that leaves NO line here and NO signal/fatal line above is an external SIGKILL/SIGHUP.
  process.on("exit", (code) => {
    try {
      const dataRoot = resolvePath(process.cwd(), process.env.AGENTIC_DATA_ROOT?.trim() || "../../data");
      mkdirSync(dataRoot, { recursive: true });
      appendFileSync(resolvePath(dataRoot, "api-fatal.log"), `[${new Date().toISOString()}] exit code=${code} (pid ${process.pid}, uptime ${Math.round(process.uptime())}s)\n`);
    } catch { /* best-effort */ }
  });
  let app: Awaited<ReturnType<typeof build>> | null = null;
  try {
    const runtimeApp = await build();
    app = runtimeApp;
    // Install signal handlers before listen() so a SIGTERM during a slow
    // network bind or initial broker sync still enters Fastify's close path.
    installGracefulShutdown(runtimeApp);
    await runtimeApp.listen({ port: PORT, host: HOST });
    runtimeApp.log.info(`api listening on http://${HOST}:${PORT}`);
    const syncResults = await syncAllAppsWithRetry({
      info: (msg) => runtimeApp.log.info(msg),
      warn: (msg) => runtimeApp.log.warn(msg),
    });
    const syncFailures = syncResults.filter((result) => !result.ok);
    if (syncFailures.length) {
      throw new Error(
        `initial Inngest app sync failed: ${syncFailures.map((result) => `${result.slug}(${result.error ?? result.status ?? "unknown"})`).join(", ")}`,
      );
    }
    if (ontocodeHarnessWorkerEnabled()) {
      if (executableOntoCodeHarnessWorker) {
        throw new Error("OntoCode Harness Worker is already running");
      }
      executableOntoCodeHarnessWorker = startOntoCodeHarnessWorker();
      runtimeApp.log.info(
        "OntoCode Harness Worker started after successful initial app sync",
      );
    } else {
      runtimeApp.log.info(
        "OntoCode Harness Worker disabled by ONTOCODE_HARNESS_WORKER_ENABLED=false",
      );
    }
    startAppReconciler({
      info: (msg) => runtimeApp.log.info(msg),
      warn: (msg) => runtimeApp.log.warn(msg),
    });
    startRunReconciler({
      info: (msg) => runtimeApp.log.info(msg),
      warn: (msg) => runtimeApp.log.warn(msg),
    });
    const { startFactorySandboxReaper } = await import(
      "./services/agent-factory/sandbox-reaper"
    );
    startFactorySandboxReaper({
      info: (msg) => runtimeApp.log.info(msg),
      warn: (msg) => runtimeApp.log.warn(msg),
    });
  } catch (err) {
    const error = startupErrorSummary(err);
    if (app) {
      app.log.error({ error }, "failed to start");
      try {
        await app.close();
      } catch (closeError) {
        app.log.error(
          { error: startupErrorSummary(closeError) },
          "startup cleanup failed",
        );
      }
    } else {
      // Fastify's logger does not exist when composition itself fails.
      console.error(`[startup] ${error.name}: ${error.message}`);
    }
    process.exitCode = 1;
  }
}
