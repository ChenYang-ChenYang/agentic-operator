import { z } from "zod";

/** Aggregate counts for the sidebar + dashboard KPI strip. */
export const TenantCounts = z.object({
  agents: z.number(),
  runningRuns: z.number(),
  okRuns24h: z.number(),
  failedRuns24h: z.number(),
  events24h: z.number(),
  openTasks: z.number(),
  totalRuns: z.number(),
});
export type TenantCounts = z.infer<typeof TenantCounts>;

/**
 * Per-agent throughput for the dashboard. For the tenant's LIVE workflow,
 * each agent gets the count of DISTINCT subjects it processed and its run
 * count within the rolling window. This is honest across every tenant
 * shape (linear pipeline or not) — unlike a stage "funnel", which only made
 * sense for staged tenants. Sorted by subjects desc; test runs never count.
 */
export const ThroughputAgent = z.object({
  kebabId: z.string(),
  name: z.string(),
  title: z.string(),
  /** Distinct subjects this agent processed in the window. */
  subjects: z.number(),
  /** Total runs (incl. repeats on the same subject) in the window. */
  runs: z.number(),
});
export type ThroughputAgent = z.infer<typeof ThroughputAgent>;

export const ThroughputResult = z.object({
  /** Human window token echoed back: "1h" | "24h" | "7d". */
  window: z.string(),
  /** Window length in milliseconds (source of truth for the query). */
  windowMs: z.number(),
  agents: z.array(ThroughputAgent),
});
export type ThroughputResult = z.infer<typeof ThroughputResult>;

/** Health endpoint — unauthenticated, used by load balancers / `/api/health`. */
export const HealthReport = z.object({
  ok: z.boolean(),
  /** Server wall-clock timestamp at the moment the report was generated (ms). */
  ts: z.number().optional(),
  /** Process uptime in seconds. */
  uptime: z.number().optional(),
  /** apps/api package.json version. Surfaces on the Settings → System pane. */
  version: z.string().optional(),
  /** Package metadata itself is a readiness dependency; never synthesize 0.0.0. */
  build: z
    .object({
      ok: z.boolean(),
      version: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /**
   * Current workflow-manifest schema version this api understands. Bumped
   * in lockstep with `@agentic/runtime`'s `CURRENT_SCHEMA_VERSION` so the
   * manifest-import wizard can detect a forward-incompat manifest.
   */
  schemaVersion: z.string().optional(),
  inngest: z.object({
    ok: z.boolean(),
    /** Durable executor profile; `development` is never production-ready. */
    mode: z
      .enum(["development", "cloud", "self_hosted", "mixed", "invalid"])
      .optional(),
    reachable: z.boolean().optional(),
    note: z.string().optional(),
    readiness: z.enum(["ready", "degraded", "blocked"]).optional(),
    configuredTenants: z.number().int().nonnegative().optional(),
    degradedTenants: z.array(z.string()).optional(),
    blockedTenants: z.array(z.string()).optional(),
    registrationOk: z.boolean().optional(),
    expectedApps: z.number().int().nonnegative().optional(),
    syncedApps: z.number().int().nonnegative().optional(),
    /** Registered apps whose current function set is empty. They retain sync
     * acceptance proof but require no broker dispatch session. */
    emptyApps: z.array(z.string()).optional(),
    lastSyncAt: z.number().optional(),
  }),
  sqlite: z.object({
    ok: z.boolean(),
    sizeBytes: z.number().optional(),
    journalMode: z.string().optional(),
    note: z.string().optional(),
  }),
  disk: z.object({
    ok: z.boolean(),
    logsDir: z.string().optional(),
    freeBytes: z.number().optional(),
    note: z.string().optional(),
  }),
  /** Manifest-declared runtime schedules. Missing env-backed cadence is a
   * readiness failure; an explicitly disabled schedule remains visible. */
  schedules: z
    .object({
      ok: z.boolean(),
      configured: z.number().int().nonnegative(),
      disabled: z.number().int().nonnegative(),
      unconfigured: z.number().int().nonnegative(),
      configuredAgents: z.array(z.string()),
      disabledAgents: z.array(z.string()),
      unconfiguredAgents: z.array(z.string()),
    })
    .optional(),
  /**
   * LLM gateway subsystem — exposes the default provider/model so support
   * can confirm a hot-deploy actually picked up the env override (P4-API-04).
   */
  llmGateway: z
    .object({
      ok: z.boolean(),
      defaultProvider: z.string().optional(),
      defaultModel: z.string().optional(),
      providers: z.number().optional(),
      /** Result of a real, token-free upstream credential/connectivity probe. */
      reachable: z.boolean().optional(),
      lastCheckedAt: z.number().optional(),
      latencyMs: z.number().nonnegative().optional(),
      statusCode: z.number().int().nullable().optional(),
      note: z.string().optional(),
      /**
       * #NOMOCK — true when the CONSTRUCTED gateway is the mock (echo) provider, so a mock runtime
       * can never masquerade as real. Ops/UI can surface a persistent "MOCK LLM ACTIVE" banner from
       * one curl instead of trusting the boot log.
       */
      mock: z.boolean().optional(),
    })
    .optional(),
  /** Live MCP transport/tool-list readiness. Optional failures are explicit degradation. */
  mcp: z
    .object({
      ok: z.boolean(),
      degraded: z.boolean(),
      configured: z.number().int().nonnegative(),
      connected: z.number().int().nonnegative(),
      requiredUnavailable: z.array(z.string()),
      optionalUnavailable: z.array(z.string()),
      checkedAt: z.number(),
    })
    .optional(),
  /** Persistence health for the per-call LLM telemetry used by token/call logs. */
  llmTelemetry: z
    .object({
      ok: z.boolean(),
      degraded: z.boolean().optional(),
      storage: z.enum(["database", "spool", "unavailable"]).optional(),
      totalFailures: z.number(),
      consecutiveFailures: z.number(),
      durabilityFailures: z.number().optional(),
      spooledRecords: z.number().optional(),
      replayedRecords: z.number().optional(),
      pendingSpoolRecords: z.number().optional(),
      lastError: z.string().optional(),
      lastFailureAt: z.number().optional(),
      lastSuccessAt: z.number().optional(),
      lastSpoolAt: z.number().optional(),
      lastReplayAt: z.number().optional(),
      spoolPath: z.string().optional(),
    })
    .optional(),
  // #SCALE — which pluggable backends are live: blob "fs" | "fs+http" | "fs+s3" | "fs+<custom>";
  // fanout "local" | "redis". Lets ops confirm a config-flip took effect from one curl.
  blobBackend: z.string().optional(),
  fanout: z.string().optional(),
  memoryDriver: z.string().optional(),
  /** Configured optional backends are readiness dependencies, not silent fallbacks. */
  configuredBackends: z
    .object({
      ok: z.boolean(),
      redisFanout: z.object({
        configured: z.boolean(),
        ok: z.boolean(),
        driver: z.enum(["redis", "local"]),
        note: z.string().optional(),
      }),
      pgvectorMemory: z.object({
        configured: z.boolean(),
        ok: z.boolean(),
        driver: z.enum(["pgvector", "local", "none"]),
        embeddingConfigured: z.boolean().optional(),
        embeddingOk: z.boolean().optional(),
        embeddingDimensions: z.number().int().positive().optional(),
        note: z.string().optional(),
      }),
      sharedBlob: z.object({
        configured: z.boolean(),
        ok: z.boolean(),
        driver: z.string(),
        note: z.string().optional(),
      }),
    })
    .optional(),
  /** Isolated production CodeAct launcher. Disabled is healthy only when the
   * feature flag is explicitly off; an enabled but unreachable/mismatched
   * launcher blocks readiness. */
  productionCodeActExecutor: z
    .object({
      configured: z.boolean(),
      ok: z.boolean(),
      state: z.enum(["disabled", "ready", "busy", "blocked"]),
      executorId: z.string().optional(),
      buildId: z.string().optional(),
      candidateRef: z.string().optional(),
      candidateImageId: z.string().optional(),
      active: z.number().int().nonnegative().optional(),
      capacity: z.number().int().positive().optional(),
      removedOrphans: z.number().int().nonnegative().optional(),
      checkedAt: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /** External Agent Factory sandbox control plane. `busy` is a healthy
   * in-flight execution; cleanup_pending, failed jobs, orphans, reaper,
   * workload, broker and storage failures are readiness blockers. */
  factorySandboxRunner: z
    .object({
      configured: z.boolean(),
      ok: z.boolean(),
      state: z.enum(["disabled", "ready", "busy", "blocked"]),
      runnerId: z.string().optional(),
      buildId: z.string().optional(),
      runtimeImageDigest: z.string().optional(),
      isolationTier: z.enum(["same_host_container", "remote_container", "remote_vm"]).optional(),
      broker: z.enum(["ready", "unreachable"]).optional(),
      storage: z.enum(["ready", "unwritable"]).optional(),
      jobs: z.record(z.string(), z.number().int().nonnegative()).optional(),
      activeJobs: z.number().int().nonnegative().optional(),
      activeExecutions: z.number().int().nonnegative().optional(),
      outstandingAttempts: z.number().int().nonnegative().optional(),
      cleanupFailures: z.number().int().nonnegative().optional(),
      oldestOrphanAgeMs: z.number().int().nonnegative().nullable().optional(),
      reaperOk: z.boolean().optional(),
      controlLastReaperAt: z.string().nullable().optional(),
      workloadLastReaperAt: z.string().nullable().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /** Host-observed, Ed25519-signed identity proof for every curated production
   * image. In production, missing/expired/mismatched evidence blocks readiness. */
  productionImageTrust: z
    .object({
      configured: z.boolean(),
      ok: z.boolean(),
      state: z.enum(["disabled", "ready", "blocked"]),
      topology: z.enum(["external_sandbox", "single_host_compose"]).optional(),
      diagnosticOnly: z.boolean().optional(),
      keyId: z.string().optional(),
      buildId: z.string().optional(),
      candidateImageId: z.string().optional(),
      verifiedAt: z.string().optional(),
      expiresAt: z.string().optional(),
      evidenceHash: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});
export type HealthReport = z.infer<typeof HealthReport>;
