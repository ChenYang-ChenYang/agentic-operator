/**
 * Drizzle schema for Agentic Operator.
 *
 * Conventions:
 *   - Primary keys are prefixed string IDs (run-, evt-, agt-, …) generated
 *     via @agentic/shared makeId().
 *   - Timestamps are unix-epoch milliseconds (integer mode timestamp_ms).
 *   - Payload/manifest blobs are stored as text in JSON mode for type safety.
 *   - Foreign keys are declared but cascade behavior is per-table.
 *   - Every user-visible table carries `tenant_id` — enforced at query time
 *     via with-tenant.ts helpers.
 */

import { relations, sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

// ─── Identity ────────────────────────────────────────────────────────────────

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    subtitle: text("subtitle"),
    color: text("color"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** P5-TEN-01 — tenant lifecycle. Archived tenants are hidden from the
     * default list and have their Inngest functions de-registered, but rows
     * remain so audit trails and prior runs stay readable. Restore by setting
     * back to null. Hard-delete is a separate platform-admin operation. */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    /** P5-TEN-01 — last time any tenant attribute (name/subtitle/color) or
     * lifecycle flag changed. Tracked separately from createdAt so the SPA
     * can show "Updated 3m ago" without inferring it from audit_log. */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    slugUq: uniqueIndex("tenants_slug_uq").on(t.slug),
    archivedAtIdx: index("tenants_archived_at_idx").on(t.archivedAt),
  }),
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /**
     * P6-AUTH — scrypt password hash (`scrypt$<N>$<saltB64>$<hashB64>`, see
     * password.ts). Null for legacy users seeded before auth landed and for
     * not-yet-activated accounts; a null hash can never satisfy login.
     */
    passwordHash: text("password_hash"),
    /**
     * P6-AUTH — cross-tenant platform role. `superadmin` bypasses per-tenant
     * RBAC and may manage tenants + users platform-wide; `none` is an ordinary
     * user whose authority comes solely from `memberships`.
     */
    platformRole: text("platform_role", { enum: ["none", "superadmin"] })
      .notNull()
      .default("none"),
    /** P6-AUTH — account lifecycle. `suspended` blocks login + new sessions. */
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** P6-AUTH — last credential/profile/role change. */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    emailUq: uniqueIndex("users_email_uq").on(t.email),
  }),
);

export const memberships = sqliteTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "operator", "viewer"] }).notNull(),
    /** P6-AUTH — when this membership was granted (for the Access tab). */
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** P6-AUTH — user id of the admin/superadmin who granted this membership. */
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.tenantId] }),
  }),
);

// ─── Workflow definitions ────────────────────────────────────────────────────

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSlugUq: uniqueIndex("workflows_tenant_slug_uq").on(
      t.tenantId,
      t.slug,
    ),
    tenantIdx: index("workflows_tenant_idx").on(t.tenantId),
  }),
);

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    manifestJson: text("manifest_json", { mode: "json" }).notNull(),
    actionsJson: text("actions_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => ({
    workflowVersionUq: uniqueIndex("wfv_workflow_version_uq").on(
      t.workflowId,
      t.version,
    ),
  }),
);

export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // SQLite stores the column as plain TEXT — the `enum` array is a
    // type-level constraint only, so widening it requires no SQL
    // migration. `tenant_code` was added in Phase 3 (V1.1 AR-GAP-02) to
    // distinguish tenant tarball uploads (see
    // `apps/api/src/routes/v1/tenant-code.ts`) from the pre-existing
    // `code_agent` (registry-based code agents under `packages/agents`).
    target: text("target", {
      enum: ["workflow", "agent", "runtime", "code_agent", "tenant_code"],
    }).notNull(),
    versionId: text("version_id").notNull(),
    status: text("status", {
      enum: ["live", "rolled_back", "pending"],
    }).notNull(),
    deployedBy: text("deployed_by").references(() => users.id),
    deployedAt: integer("deployed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    note: text("note"),
    /**
     * Expiry for `status='pending'` rows produced by the manifest-import
     * wizard. Set to `now + 1h` when validate inserts the pending row; nulled
     * out at commit. Boot-time `reconcileImports` drops expired rows along
     * with their `data/imports/<deployment_id>/` tmp dirs. Null for live
     * rows. (Per review A2: the deployment row's `id` IS the session token —
     * no separate `import_session_id` column.)
     */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /**
     * Path to the on-disk manifest backing this deployment. Between phases
     * 3 and 4 of the commit transaction this points at the tmp staging file
     * `data/imports/<deployment_id>/workflow.json`; after the atomic rename
     * in phase 4 it points at `models/<slug>-vN/workflow_v<N+1>.json`. The
     * boot-time reconciler queries this column to complete crashed renames
     * and detect missing on-disk files. Null for non-import deployments.
     */
    filePath: text("file_path"),
  },
  (t) => ({
    tenantStatusIdx: index("dpl_tenant_status_idx").on(t.tenantId, t.status),
    versionIdx: index("dpl_version_idx").on(t.versionId),
    expiresAtIdx: index("deployments_expires_at_idx").on(t.expiresAt),
    filePathIdx: index("deployments_file_path_idx").on(t.filePath),
  }),
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    /**
     * Direct tenant ownership for Studio lookups. Nullable at the Drizzle
     * boundary during the legacy transition: migration 0017 backfills it and
     * DB triggers derive it from workflow_id for old insert call sites.
     */
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    kebabId: text("kebab_id").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    actor: text("actor", { enum: ["Agent", "Human"] }).notNull(),
    kind: text("kind", { enum: ["manifest", "code"] })
      .notNull()
      .default("manifest"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lifecycle: text("lifecycle", {
      enum: ["draft", "active", "archived"],
    })
      .notNull()
      .default("active"),
    // P0-DB-01: temporal columns (migration 0003_temporal_columns.sql).
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    workflowKebabUq: uniqueIndex("agents_workflow_kebab_uq").on(
      t.workflowId,
      t.kebabId,
    ),
    workflowIdx: index("agents_workflow_idx").on(t.workflowId),
    tenantIdx: index("agents_tenant_idx").on(t.tenantId),
    tenantLifecycleIdx: index("agents_tenant_lifecycle_idx").on(
      t.tenantId,
      t.lifecycle,
    ),
  }),
);

export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    manifestJson: text("manifest_json", { mode: "json" }).notNull(),
    definitionSchemaVersion: integer("definition_schema_version")
      .notNull()
      .default(1),
    contentHash: text("content_hash"),
    createdBy: text("created_by").references(() => users.id),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    changeNote: text("change_note"),
    // P0-DB-01 added these columns in SQL but the original Drizzle mapping
    // omitted them. 0017 repairs zero-valued rows and insert-time defaults.
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    agentWfvUq: uniqueIndex("agv_agent_wfv_uq").on(
      t.agentId,
      t.workflowVersionId,
    ),
  }),
);

// ─── Agent Studio drafts + immutable draft revisions ───────────────────────

export const agentDrafts = sqliteTable(
  "agent_drafts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    baseAgentVersionId: text("base_agent_version_id").references(
      () => agentVersions.id,
    ),
    baseWorkflowVersionId: text("base_workflow_version_id").references(
      () => workflowVersions.id,
    ),
    definitionJson: text("definition_json", { mode: "json" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(2),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    validationStatus: text("validation_status", {
      enum: ["unvalidated", "valid", "invalid", "stale"],
    })
      .notNull()
      .default("unvalidated"),
    validationJson: text("validation_json", { mode: "json" }),
    validatedHash: text("validated_hash"),
    createdBy: text("created_by").references(() => users.id),
    updatedBy: text("updated_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantUpdatedIdx: index("agent_drafts_tenant_updated_idx").on(
      t.tenantId,
      t.updatedAt,
    ),
    agentUpdatedIdx: index("agent_drafts_agent_updated_idx").on(
      t.agentId,
      t.updatedAt,
    ),
    workflowIdx: index("agent_drafts_workflow_idx").on(t.workflowId),
    deletedAtIdx: index("agent_drafts_deleted_at_idx").on(t.deletedAt),
  }),
);

export const agentDraftRevisions = sqliteTable(
  "agent_draft_revisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => agentDrafts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    definitionJson: text("definition_json", { mode: "json" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(2),
    contentHash: text("content_hash").notNull(),
    reason: text("reason", {
      enum: ["run", "checkpoint", "publish"],
    }).notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    draftRevisionUq: uniqueIndex("agent_draft_revisions_draft_revision_uq").on(
      t.draftId,
      t.revision,
    ),
    tenantCreatedIdx: index("agent_draft_revisions_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

// ─── Events ──────────────────────────────────────────────────────────────────

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    sourceAgentId: text("source_agent_id").references(() => agents.id),
    subject: text("subject"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    payloadRef: text("payload_ref"),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantNameReceivedIdx: index("evt_tenant_name_received_idx").on(
      t.tenantId,
      t.name,
      t.receivedAt,
    ),
    deletedAtIdx: index("events_deleted_at_idx").on(t.deletedAt),
    // Event Tester SSE poll (GET /v1/events/stream without ?names=) uses
    // `WHERE tenantId = ? AND receivedAt > ?` — the (tenantId, name, ...)
    // index cannot serve that because `name` sits between the equality and
    // the range predicate. A covering (tenantId, receivedAt) index keeps
    // the 250ms poll query a B-tree seek even on tenants with 100k+ events.
    tenantReceivedIdx: index("evt_tenant_received_idx").on(
      t.tenantId,
      t.receivedAt,
    ),
    tenantSubjectIdx: index("evt_tenant_subject_idx").on(t.tenantId, t.subject),
  }),
);

export const eventListeners = sqliteTable(
  "event_listeners",
  {
    eventName: text("event_name").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventName, t.agentId] }),
    eventIdx: index("evtl_event_idx").on(t.eventName),
  }),
);

// ─── Agent Studio sessions + runs + steps ───────────────────────────────────

export const agentRunSessions = sqliteTable(
  "agent_run_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id),
    title: text("title"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantUpdatedIdx: index("agent_run_sessions_tenant_updated_idx").on(
      t.tenantId,
      t.updatedAt,
    ),
    agentUpdatedIdx: index("agent_run_sessions_agent_updated_idx").on(
      t.agentId,
      t.updatedAt,
    ),
  }),
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    agentVersionId: text("agent_version_id").references(() => agentVersions.id),
    draftRevisionId: text("draft_revision_id").references(
      () => agentDraftRevisions.id,
    ),
    sessionId: text("session_id").references(() => agentRunSessions.id, {
      onDelete: "set null",
    }),
    triggerEventId: text("trigger_event_id").references(() => events.id),
    /** P1-RT-04 — parent run id when this run was composed via `subflow`. */
    parentRunId: text("parent_run_id"),
    status: text("status", {
      enum: ["queued", "running", "ok", "failed", "waiting", "cancelled"],
    }).notNull(),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    provider: text("provider"),
    model: text("model"),
    emittedEventId: text("emitted_event_id"),
    /** Runtime receipt: the isolated generated handler completed successfully.
     * Null means no CodeAct receipt; false is a real preflight/worker failure. */
    codeRan: integer("code_ran", { mode: "boolean" }),
    /** Runtime receipt fields. Populated only from the structured CodeAct
     * isolation result, never from manifest `codeExecuted` configuration. */
    codeExecuted: integer("code_executed", { mode: "boolean" }),
    codeIsolation: text("code_isolation", {
      enum: ["worker_thread", "isolated_subprocess", "isolated_container"],
    }),
    codeSha256: text("code_sha256"),
    codeAttestation: text("code_attestation_status", {
      enum: [
        "production_verified",
        "sandbox_verified",
        "sandbox_not_required",
        "not_authorized",
        "missing",
        "mismatch",
        "not_checked",
      ],
    }),
    codeExecutionFailure: text("code_execution_failure"),
    errorMessage: text("error_message"),
    logPath: text("log_path"),
    correlationId: text("correlation_id").notNull(),
    subject: text("subject"),
    invocationSource: text("invocation_source", {
      enum: ["studio", "event", "api", "replay", "demo"],
    })
      .notNull()
      .default("event"),
    requestedBy: text("requested_by").references(() => users.id),
    requestId: text("request_id"),
    interactionId: text("interaction_id"),
    productSurface: text("product_surface"),
    productAction: text("product_action"),
    definitionHash: text("definition_hash"),
    outputValid: integer("output_valid", { mode: "boolean" }),
    sideEffectMode: text("side_effect_mode", {
      enum: ["suppressed", "safe", "live"],
    })
      .notNull()
      .default("live"),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    /**
     * Test-run marker. Set true when:
     *   • the synchronous code-agent invoke route accepts `testRun: true`, or
     *   • the manifest path sees `event.data.__test === true` (Event Tester
     *     publishes via `POST /v1/events` with `test: true`).
     * The column is indexed so dashboards can default to non-test traffic.
     */
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    tenantStartedIdx: index("runs_tenant_started_idx").on(
      t.tenantId,
      t.startedAt,
    ),
    tenantQueuedIdx: index("runs_tenant_queued_idx").on(t.tenantId, t.queuedAt),
    tenantStatusIdx: index("runs_tenant_status_idx").on(t.tenantId, t.status),
    tenantDeletedQueuedIdx: index("runs_tenant_deleted_queued_idx").on(
      t.tenantId,
      t.deletedAt,
      t.queuedAt,
    ),
    tenantDeletedStatusQueuedIdx: index(
      "runs_tenant_deleted_status_queued_idx",
    ).on(t.tenantId, t.deletedAt, t.status, t.queuedAt),
    tenantSourceQueuedIdx: index("runs_tenant_source_queued_idx").on(
      t.tenantId,
      t.invocationSource,
      t.queuedAt,
    ),
    agentIdx: index("runs_agent_idx").on(t.agentId),
    correlationIdx: index("runs_correlation_idx").on(t.correlationId),
    interactionIdx: index("runs_interaction_idx").on(t.interactionId),
    subjectIdx: index("runs_subject_idx").on(t.subject),
    deletedAtIdx: index("runs_deleted_at_idx").on(t.deletedAt),
    isTestIdx: index("runs_is_test_idx").on(t.isTest),
    sessionIdx: index("runs_session_idx").on(t.sessionId),
    draftRevisionIdx: index("runs_draft_revision_idx").on(t.draftRevisionId),
    agentSourceStartedIdx: index("runs_agent_source_started_idx").on(
      t.agentId,
      t.invocationSource,
      t.startedAt,
    ),
  }),
);

export const steps = sqliteTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    name: text("name").notNull(),
    type: text("type", {
      enum: [
        "tool",
        "logic",
        "manual",
        "condition",
        "delay",
        "subflow",
        "invoke",
        "foreach",
        "emit",
        "decision",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "ok", "failed", "skipped"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    inputRef: text("input_ref"),
    outputRef: text("output_ref"),
    error: text("error"),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    /** Exact per-step CodeAct runtime receipt; null for declarative steps. */
    codeRan: integer("code_ran", { mode: "boolean" }),
    codeExecuted: integer("code_executed", { mode: "boolean" }),
    codeIsolation: text("code_isolation", {
      enum: ["worker_thread", "isolated_subprocess", "isolated_container"],
    }),
    codeSha256: text("code_sha256"),
    codeAttestation: text("code_attestation_status", {
      enum: [
        "production_verified",
        "sandbox_verified",
        "sandbox_not_required",
        "not_authorized",
        "missing",
        "mismatch",
        "not_checked",
      ],
    }),
    codeExecutionFailure: text("code_execution_failure"),
    /**
     * Execution attempt count. Inngest retries a failed `step.run` body in
     * place; the runtime upserts by (run_id, ord) and bumps this so the run
     * viewer can show "attempt 2 of 3" instead of duplicate step rows.
     * Code-agent steps run synchronously and stay at 1.
     */
    attempts: integer("attempts").notNull().default(1),
  },
  (t) => ({
    runOrdIdx: index("steps_run_ord_idx").on(t.runId, t.ord),
  }),
);

// ─── LLM turns (W0) ──────────────────────────────────────────────────────────
// Raw per-turn capture of the deployed manifest agents' LLM tool-use loop: the
// model's response text, extracted reasoning/thinking, and the tools it
// requested — one row per loop iteration, keyed on run_id + step_id. This is
// what powers the run-detail reasoning surface and the 推理审计 page (production
// runs previously stored only token counts). Gated by AGENTIC_CAPTURE_LLM_TURNS
// with per-field size caps in the runtime. run_id FK cascade cleans these up on
// run delete/purge.
export const llmTurns = sqliteTable(
  "llm_turns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** The step this turn belongs to. Plain column — the step row is written
     *  immediately before, so no FK ordering hazard; run cascade covers GC. */
    stepId: text("step_id"),
    /** Turn index within the step's tool-use loop (0-based). */
    ord: integer("ord").notNull(),
    /** Bounded snapshot of the rendered prompt — only on the first turn. */
    promptPreview: text("prompt_preview"),
    /** The assistant's text reply (bounded). */
    responseText: text("response_text"),
    /** Extracted thinking/reasoning when the provider surfaced it (bounded). */
    reasoning: text("reasoning"),
    /** [{ name, input }] of the tools the model requested this turn. */
    toolCallsJson: text("tool_calls_json", { mode: "json" }),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    finishReason: text("finish_reason"),
    latencyMs: integer("latency_ms"),
    correlationId: text("correlation_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("llm_turns_run_idx").on(t.runId, t.ord),
    tenantCreatedIdx: index("llm_turns_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

// ─── Run summaries (W2) ──────────────────────────────────────────────────────
// Cached AI summary of a production run — a natural-language narrative + (on
// success) business details or (on failure) problem + likely-cause guesses.
// One row per run; generated lazily on first open and cached so re-opening
// doesn't re-spend tokens. run_id FK cascade cleans it up on run delete/purge.
export const runSummaries = sqliteTable(
  "run_summaries",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The serialized RunSummary object (narrative/problem/causes/suggestions/digest). */
    summaryJson: text("summary_json", { mode: "json" }).notNull(),
    /** The model that produced the critique ("" when digest-only). */
    model: text("model"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantIdx: index("run_summaries_tenant_idx").on(t.tenantId, t.createdAt),
  }),
);

/**
 * One row per provider attempt, including retries and failover. Token and
 * cost fields are finalized only when the provider returned authoritative
 * usage; failed/ambiguous attempts remain visible without inventing spend.
 */
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    logicalCallId: text("logical_call_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    purpose: text("purpose"),
    billingAccountId: text("billing_account_id"),
    providerAccountId: text("provider_account_id"),
    actorType: text("actor_type", {
      enum: ["user", "api_token", "system"],
    }),
    actorId: text("actor_id"),
    credentialId: text("credential_id"),
    providerCredentialId: text("provider_credential_id"),
    product: text("product"),
    productSurface: text("product_surface"),
    productAction: text("product_action"),
    interactionId: text("interaction_id"),
    functionName: text("function_name"),
    apiRoute: text("api_route"),
    httpMethod: text("http_method"),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    invocationSource: text("invocation_source"),
    provider: text("provider").notNull(),
    requestedModel: text("requested_model").notNull(),
    requestedRoute: text("requested_route"),
    effectiveRoute: text("effective_route"),
    gatewayInstanceId: text("gateway_instance_id"),
    gatewayKind: text("gateway_kind"),
    modelFamily: text("model_family"),
    taskType: text("task_type"),
    matchedTaskType: text("matched_task_type"),
    routingProfileId: text("routing_profile_id"),
    routingRevision: integer("routing_revision"),
    resolutionReason: text("resolution_reason"),
    fallbackIndex: integer("fallback_index"),
    transport: text("transport"),
    effectiveTimeoutMs: integer("effective_timeout_ms"),
    overallDeadlineMs: integer("overall_deadline_ms"),
    controlsJson: text("controls_json", { mode: "json" }),
    retryReason: text("retry_reason"),
    reasoningMode: text("reasoning_mode", { enum: ["standard", "pro"] }),
    reasoningEffort: text("reasoning_effort", {
      enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }),
    reasoningSummary: text("reasoning_summary", {
      enum: ["none", "auto", "concise", "detailed"],
    }),
    reasoningContext: text("reasoning_context", {
      enum: ["auto", "current_turn", "all_turns"],
    }),
    textVerbosity: text("text_verbosity", {
      enum: ["low", "medium", "high"],
    }),
    storeResponse: integer("store_response", { mode: "boolean" }),
    responseModel: text("response_model"),
    providerRequestId: text("provider_request_id"),
    attempt: integer("attempt").notNull(),
    status: text("status", { enum: ["started", "ok", "failed"] })
      .notNull()
      .default("started"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    cacheWriteInputTokens: integer("cache_write_input_tokens"),
    cacheWrite5mInputTokens: integer("cache_write_5m_input_tokens"),
    cacheWrite1hInputTokens: integer("cache_write_1h_input_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    inputAudioTokens: integer("input_audio_tokens"),
    outputAudioTokens: integer("output_audio_tokens"),
    costUsdNanos: integer("cost_usd_nanos"),
    inputUsdNanos: integer("input_usd_nanos"),
    cachedInputUsdNanos: integer("cached_input_usd_nanos"),
    cacheWriteUsdNanos: integer("cache_write_usd_nanos"),
    outputUsdNanos: integer("output_usd_nanos"),
    costSource: text("cost_source", {
      enum: ["provider", "catalog", "unpriced"],
    }),
    priceSource: text("price_source"),
    priceAsOf: text("price_as_of"),
    finishReason: text("finish_reason"),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    usageJson: text("usage_json", { mode: "json" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    logicalAttemptUq: uniqueIndex("llm_calls_logical_attempt_uq").on(
      t.logicalCallId,
      t.attempt,
    ),
    tenantStartedIdx: index("llm_calls_tenant_started_idx").on(
      t.tenantId,
      t.startedAt,
    ),
    runIdx: index("llm_calls_run_idx").on(t.runId),
    stepIdx: index("llm_calls_step_idx").on(t.stepId),
    accountStartedIdx: index("llm_calls_account_started_idx").on(
      t.billingAccountId,
      t.startedAt,
    ),
    requestIdx: index("llm_calls_request_idx").on(t.requestId),
    interactionIdx: index("llm_calls_interaction_idx").on(t.interactionId),
    taskStartedIdx: index("llm_calls_task_started_idx").on(
      t.tenantId,
      t.taskType,
      t.startedAt,
    ),
    gatewayStartedIdx: index("llm_calls_gateway_started_idx").on(
      t.tenantId,
      t.gatewayInstanceId,
      t.startedAt,
    ),
  }),
);

/**
 * Canonical append-only billing events. `llm_calls` remains the detailed
 * provider-attempt projection; this table is the normalized, versioned
 * source used for portable NDJSON exports and future non-LLM usage events.
 */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    schemaVersion: integer("schema_version").notNull().default(1),
    eventType: text("event_type", {
      enum: ["llm.attempt", "api.call", "tool.call", "product.interaction"],
    }).notNull(),
    status: text("status", {
      enum: ["ok", "failed", "rejected", "unknown", "reconciled"],
    }).notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    billingAccountId: text("billing_account_id").notNull(),
    actorType: text("actor_type", {
      enum: ["user", "api_token", "system"],
    }).notNull(),
    actorId: text("actor_id"),
    credentialId: text("credential_id"),
    providerCredentialId: text("provider_credential_id"),
    providerAccountId: text("provider_account_id"),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    interactionId: text("interaction_id"),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    product: text("product").notNull().default("agentic-operator"),
    productSurface: text("product_surface").notNull(),
    productAction: text("product_action").notNull(),
    functionName: text("function_name").notNull(),
    apiRoute: text("api_route"),
    httpMethod: text("http_method"),
    invocationSource: text("invocation_source"),
    llmCallId: text("llm_call_id").references(() => llmCalls.id, {
      onDelete: "set null",
    }),
    quantityJson: text("quantity_json", { mode: "json" }).notNull(),
    providerCostUsdNanos: integer("provider_cost_usd_nanos"),
    billableChargeUsdNanos: integer("billable_charge_usd_nanos"),
    costLiability: text("cost_liability", {
      enum: ["known", "unknown", "unpriced"],
    }).notNull(),
    currency: text("currency").notNull().default("USD"),
    rateCardVersion: text("rate_card_version")
      .notNull()
      .default("pass-through-v1"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    exportedAt: integer("exported_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    callUq: uniqueIndex("usage_events_llm_call_uq").on(t.llmCallId),
    tenantSequenceIdx: index("usage_events_tenant_sequence_idx").on(
      t.tenantId,
      t.sequence,
    ),
    accountOccurredIdx: index("usage_events_account_occurred_idx").on(
      t.billingAccountId,
      t.occurredAt,
    ),
    exportIdx: index("usage_events_export_idx").on(t.exportedAt, t.sequence),
    interactionIdx: index("usage_events_interaction_idx").on(t.interactionId),
  }),
);

/**
 * Explicit Studio session messages. Runs default to isolated context and use
 * these rows only for chat/history presentation. A run that explicitly opts
 * into session context snapshots bounded prior user/assistant turns before it
 * appends its own user message; later mutations therefore cannot change the
 * prompt used by that run or one of its replays.
 */
export const runMessages = sqliteTable(
  "run_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentRunSessions.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    role: text("role", {
      enum: ["system", "user", "assistant", "tool"],
    }).notNull(),
    contentJson: text("content_json", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionOrdUq: uniqueIndex("run_messages_session_ord_uq").on(
      t.sessionId,
      t.ord,
    ),
    tenantCreatedIdx: index("run_messages_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    runIdx: index("run_messages_run_idx").on(t.runId),
  }),
);

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    /** Durable causal link to the business event that created the owning run. */
    originEventId: text("origin_event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    /** Preserved even when an ingress path has no local events row. */
    originEventName: text("origin_event_name"),
    /** Exact manual step parked in Inngest's waitForEvent. */
    waitStepId: text("wait_step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    awaitingRole: text("awaiting_role"),
    awaitingUserId: text("awaiting_user_id").references(() => users.id),
    priority: text("priority", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    status: text("status", {
      enum: ["open", "resolving", "resolved", "snoozed", "failed"],
    })
      .notNull()
      .default("open"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedBy: text("resolved_by").references(() => users.id),
    payloadJson: text("payload_json", { mode: "json" }),
    resolutionJson: text("resolution_json", { mode: "json" }),
    /** Stable across transport retries; duplicate resume events carry this marker. */
    resumeMarker: text("resume_marker"),
    resumeState: text("resume_state", {
      enum: ["pending", "dispatching", "dispatched", "acknowledged", "failed"],
    })
      .notNull()
      .default("pending"),
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    resolutionRequestKey: text("resolution_request_key"),
    resolutionRequestedAt: integer("resolution_requested_at", {
      mode: "timestamp_ms",
    }),
    resumeDispatchedAt: integer("resume_dispatched_at", {
      mode: "timestamp_ms",
    }),
    resumeAcknowledgedAt: integer("resume_acknowledged_at", {
      mode: "timestamp_ms",
    }),
    resumeError: text("resume_error"),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantStatusIdx: index("tasks_tenant_status_idx").on(t.tenantId, t.status),
    runIdx: index("tasks_run_idx").on(t.runId),
    resumeMarkerUq: uniqueIndex("tasks_resume_marker_uq").on(t.resumeMarker),
    resumeStateIdx: index("tasks_resume_state_idx").on(t.resumeState),
    waitStepIdx: index("tasks_wait_step_idx").on(t.waitStepId),
    deletedAtIdx: index("tasks_deleted_at_idx").on(t.deletedAt),
  }),
);

// ─── Artifacts ───────────────────────────────────────────────────────────────

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    role: text("role", {
      enum: [
        "definition",
        "input",
        "output",
        "run_record",
        "raw_response",
        "step_input",
        "step_output",
        "trace",
        "attachment",
        "other",
      ],
    })
      .notNull()
      .default("other"),
    logicalName: text("logical_name"),
    contentType: text("content_type"),
    sha256: text("sha256"),
    schemaId: text("schema_id"),
    metadataJson: text("metadata_json", { mode: "json" }),
    redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
    retentionUntil: integer("retention_until", { mode: "timestamp_ms" }),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("art_run_idx").on(t.runId),
    runRoleIdx: index("art_run_role_idx").on(t.runId, t.role),
    stepIdx: index("art_step_idx").on(t.stepId),
    sha256Idx: index("art_sha256_idx").on(t.sha256),
    retentionIdx: index("art_retention_until_idx").on(t.retentionUntil),
  }),
);

/** Durable, append-only structured trace used by Studio history and SSE. */
export const runTraceEvents = sqliteTable(
  "run_trace_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    /** Self-parent id is intentionally not an FK so trace ingestion can append
     * children before a delayed parent update without disabling FK checks. */
    parentId: text("parent_id"),
    seq: integer("seq").notNull(),
    kind: text("kind", {
      enum: [
        "run",
        "input",
        "prompt",
        "step",
        "llm",
        "tool",
        "output_validation",
        "artifact",
        "event",
      ],
    }).notNull(),
    level: text("level", {
      enum: ["minimal", "standard", "debug"],
    })
      .notNull()
      .default("standard"),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["pending", "running", "ok", "failed", "skipped"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    summary: text("summary"),
    dataJson: text("data_json", { mode: "json" }),
    artifactId: text("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    visibility: text("visibility", {
      enum: ["user", "operator", "debug"],
    })
      .notNull()
      .default("user"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runSeqUq: uniqueIndex("run_trace_events_run_seq_uq").on(t.runId, t.seq),
    tenantCreatedIdx: index("run_trace_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    stepIdx: index("run_trace_events_step_idx").on(t.stepId),
    parentIdx: index("run_trace_events_parent_idx").on(t.parentId),
  }),
);

/** One-to-many link from a run to every downstream event it emitted. */
export const runEmittedEvents = sqliteTable(
  "run_emitted_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    outputPortId: text("output_port_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runEventPortUq: uniqueIndex("run_emitted_events_run_event_port_uq").on(
      t.runId,
      t.eventId,
      t.outputPortId,
    ),
    tenantCreatedIdx: index("run_emitted_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    eventIdx: index("run_emitted_events_event_idx").on(t.eventId),
  }),
);

// Durable business entities (candidate / resume / job_posting /
// candidate_match_result / candidate_identity_result / communication_log) — the new-arch-native replacement
// for the old AO's Neo4j / RAAS-Postgres instance write-back. Deliberately NOT
// under `artifacts` (whose run_id FK cascade-deletes with its run) nor
// `agent_memory_long` (a private per-agent KV): business entities must OUTLIVE
// the runs that produced them. Written by the `records.upsert` global tool.
export const businessRecords = sqliteTable(
  "business_records",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    recordKey: text("record_key").notNull(),
    subject: text("subject"),
    candidateId: text("candidate_id"),
    correlationId: text("correlation_id"),
    // Plain column, NOT a FK to runs — records survive run GC / soft-delete.
    runId: text("run_id"),
    sourceAgent: text("source_agent"),
    dataJson: text("data_json", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    identityUq: uniqueIndex("business_records_identity_uq").on(
      t.tenantId,
      t.recordType,
      t.recordKey,
    ),
    typeIdx: index("business_records_type_idx").on(
      t.tenantId,
      t.recordType,
      t.updatedAt,
    ),
    candidateIdx: index("business_records_candidate_idx").on(
      t.tenantId,
      t.candidateId,
    ),
    correlationIdx: index("business_records_correlation_idx").on(
      t.correlationId,
    ),
  }),
);

// ─── Ops ─────────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    at: integer("at", { mode: "timestamp_ms" }).notNull().default(now),
    metaJson: text("meta_json", { mode: "json" }),
  },
  (t) => ({
    tenantAtIdx: index("audit_tenant_at_idx").on(t.tenantId, t.at),
    targetIdx: index("audit_target_idx").on(t.targetType, t.targetId),
  }),
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    name: text("name").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    hashUq: uniqueIndex("tok_hash_uq").on(t.hash),
    tenantIdx: index("tok_tenant_idx").on(t.tenantId),
  }),
);

// ─── Ontology (RF-1.4): per-tenant event + entity catalogs ──────────────────

export const eventTypes = sqliteTable(
  "event_types",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    color: text("color"),
    description: text("description"),
    payloadJson: text("payload_json", { mode: "json" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.name] }),
  }),
);

export const entityTypes = sqliteTable(
  "entity_types",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    primaryKeyName: text("primary_key_name"),
    propertiesJson: text("properties_json", { mode: "json" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.entityId] }),
  }),
);

// ─── Budgets (P1-DB-01) ─────────────────────────────────────────────────────

export const tenantBudgets = sqliteTable("tenant_budgets", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  monthlyTokenCap: integer("monthly_token_cap"),
  monthlyUsdCap: integer("monthly_usd_cap"),
  usedTokensMonth: integer("used_tokens_month").notNull().default(0),
  usedUsdMonth: integer("used_usd_month").notNull().default(0),
  /** Exact accumulated spend; usedUsdMonth is retained as a cents projection. */
  usedUsdNanos: integer("used_usd_nanos").notNull().default(0),
  periodStart: integer("period_start", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

/** In-flight LLM budget reservations. Actual counters remain on
 * tenant_budgets; these rows make pre-call capacity checks atomic across
 * concurrent API processes and survive crashes until their lease expires. */
export const llmBudgetReservations = sqliteTable(
  "llm_budget_reservations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    reservedTokens: integer("reserved_tokens").notNull(),
    reservedUsdCents: integer("reserved_usd_cents").notNull(),
    status: text("status", {
      enum: ["active", "settled", "released", "expired"],
    })
      .notNull()
      .default("active"),
    actualTokens: integer("actual_tokens"),
    actualUsdCents: integer("actual_usd_cents"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    outcome: text("outcome"),
  },
  (t) => ({
    tenantStatusIdx: index("llm_budget_reservations_tenant_status_idx").on(
      t.tenantId,
      t.status,
    ),
    expiresIdx: index("llm_budget_reservations_expires_idx").on(t.expiresAt),
  }),
);

// ─── Schema metadata (P1-DB-02) ─────────────────────────────────────────────

export const meta = sqliteTable("_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

// ─── Webhook subscriptions (P3-RT-04) ───────────────────────────────────────

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    /** Versioned AES-256-GCM envelope bound to tenantId + source. */
    secretEncrypted: text("secret_encrypted").notNull(),
    signingAlgo: text("signing_algo").notNull().default("hmac-sha256"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSourceUq: uniqueIndex("webhook_sub_tenant_source_uq")
      .on(t.tenantId, t.source)
      .where(sql`${t.enabled} = 1`),
    sourceIdx: index("webhook_sub_source_idx")
      .on(t.source)
      .where(sql`${t.enabled} = 1`),
  }),
);

// ─── Agent memory (P3-DB-01) ────────────────────────────────────────────────

export const agentMemoryShort = sqliteTable(
  "agent_memory_short",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.key] }),
    runIdx: index("agent_memory_short_run_idx").on(t.runId),
  }),
);

export const agentMemoryLong = sqliteTable(
  "agent_memory_long",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    subject: text("subject").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    /** #SCALE-MEM — pre-computed embedding (JSON float array), written at put() time so search never
     *  re-embeds static values. NULL = compute-on-demand (back-compat / embedder changed). */
    embeddingJson: text("embedding_json"),
    /** #SCALE-MEM — TTL: rows past expiresAt are excluded from reads + GC'd lazily. NULL = no expiry. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.tenantId, t.agentName, t.subject, t.key],
    }),
    tenantAgentIdx: index("agent_memory_long_tenant_agent_idx").on(
      t.tenantId,
      t.agentName,
    ),
    subjectIdx: index("agent_memory_long_subject_idx").on(
      t.tenantId,
      t.subject,
    ),
  }),
);

/**
 * UC-V11-32 / PF-GAP-10 — persistent Idempotency-Key cache.
 *
 * The api routes that mutate state (`POST /v1/events`,
 * `POST /v1/agents/:name/invoke`, `POST /v1/tenants`, …) accept an
 * `Idempotency-Key` header. Before this table the only enforcement was a
 * per-process in-memory LRU in `apps/api/src/routes/v1/tenants.ts` —
 * restart the api or run >1 instance and the contract evaporated. This
 * table makes the cache durable + cross-instance:
 *
 *   - PK is (tenant_id, key) — each tenant gets a private keyspace.
 *   - response_json holds the response body verbatim (JSON-stringified),
 *     so a retry sees byte-identical output including any mint tokens.
 *   - status_code lets the route replay the original HTTP status.
 *   - TTL is 24h from insert; the retention sweep deletes expired rows in
 *     bulk via the `(expires_at)` index.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    responseJson: text("response_json").notNull(),
    statusCode: integer("status_code").notNull().default(200),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.key] }),
    expiresAtIdx: index("idempotency_keys_expires_at_idx").on(t.expiresAt),
  }),
);

/**
 * Cross-process operation leases.
 *
 * A primary-keyed resource name is a real SQLite arbitration point shared by
 * every API process. Factory mutexes and tenant lifecycle transitions use a
 * fixed resource key; detached Factory work uses a unique key per job and is
 * queried by `(tenant_id, kind)`. `expires_at` makes crashed owners recoverable
 * while live owners renew their lease from the API process.
 */
export const operationLeases = sqliteTable(
  "operation_leases",
  {
    resourceKey: text("resource_key").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ownerToken: text("owner_token").notNull(),
    kind: text("kind").notNull(),
    workId: text("work_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    tenantKindIdx: index("operation_leases_tenant_kind_idx").on(
      t.tenantId,
      t.kind,
    ),
    expiresAtIdx: index("operation_leases_expires_at_idx").on(t.expiresAt),
  }),
);

/**
 * External-service integrations configured per tenant in Settings →
 * Integrations (e.g. the GoHire ATS). One row per (tenant, provider).
 *
 * The API key is encrypted at rest with AES-256-GCM — only the ciphertext
 * (`key_cipher`), the 12-byte IV (`key_iv`), the 16-byte auth tag
 * (`key_tag`), and the per-row KDF salt (`key_salt`) are stored; the
 * plaintext never touches the DB. `key_masked` is a display-safe
 * `gh_ab…wxyz` fragment so the UI can show "a key is set" without
 * decrypting. The decrypt path lives in apps/api
 * (`services/integration-store.ts`); the GoHire tool family reads the
 * decrypted creds through the injected `resolveIntegrationCreds` seam.
 *
 * `base_url` + the key are both nullable so a row can exist half-configured
 * (e.g. base URL saved, key pending). `status` is the last connection-test
 * result so the Settings list can show a health pill without re-probing.
 */
export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Stable provider key, e.g. "gohire". Matches the GoHire tools' lookup. */
    provider: text("provider").notNull(),
    /** Human-readable display name shown in the Settings list. */
    name: text("name").notNull(),
    /** Operator-configured base URL (no trailing slash). */
    baseUrl: text("base_url"),
    /** AES-256-GCM ciphertext of the API key (hex). Null when unset. */
    keyCipher: text("key_cipher"),
    /** 12-byte IV (hex). */
    keyIv: text("key_iv"),
    /** 16-byte GCM auth tag (hex). */
    keyTag: text("key_tag"),
    /** Per-row scrypt salt (hex) used to derive the encryption key. */
    keySalt: text("key_salt"),
    /** Display-safe masked key (e.g. "gh_ab…wxyz"); never the plaintext. */
    keyMasked: text("key_masked"),
    /** Non-secret dynamic field values (JSON object, string→string) keyed by
     *  the System Profile's ConfigFieldSpec keys (region, org id…). */
    configJson: text("config_json"),
    /** AES-256-GCM ciphertext of the JSON secrets bag — every secret field
     *  beyond the first-class API key (client_secret, webhook secret…). Same
     *  per-row scrypt-derived key scheme as the primary key columns. */
    secretsCipher: text("secrets_cipher"),
    secretsIv: text("secrets_iv"),
    secretsTag: text("secrets_tag"),
    secretsSalt: text("secrets_salt"),
    /** Last connection-test outcome: "unconfigured" | "ok" | "error". */
    status: text("status").notNull().default("unconfigured"),
    /** When the connection was last tested. */
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
    /** Last connection-test message: the error when status="error", or an
     *  advisory note when status="ok" (e.g. reachable-but-no-health-route). */
    lastError: text("last_error"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantProviderUq: uniqueIndex("integration_tenant_provider_uq").on(
      t.tenantId,
      t.provider,
    ),
    tenantIdx: index("integration_tenant_idx").on(t.tenantId),
  }),
);

// ─── Relations (used by Drizzle's relational queries) ───────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  workflows: many(workflows),
  agents: many(agents),
  agentDrafts: many(agentDrafts),
  agentRunSessions: many(agentRunSessions),
  events: many(events),
  runs: many(runs),
  tasks: many(tasks),
  memberships: many(memberships),
  usageEvents: many(usageEvents),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [workflows.tenantId],
    references: [tenants.id],
  }),
  versions: many(workflowVersions),
  agents: many(agents),
  agentDrafts: many(agentDrafts),
}));

export const workflowVersionsRelations = relations(
  workflowVersions,
  ({ one, many }) => ({
    workflow: one(workflows, {
      fields: [workflowVersions.workflowId],
      references: [workflows.id],
    }),
    agentVersions: many(agentVersions),
  }),
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [agents.tenantId],
    references: [tenants.id],
  }),
  workflow: one(workflows, {
    fields: [agents.workflowId],
    references: [workflows.id],
  }),
  versions: many(agentVersions),
  drafts: many(agentDrafts),
  runSessions: many(agentRunSessions),
  runs: many(runs),
}));

export const agentVersionsRelations = relations(
  agentVersions,
  ({ one, many }) => ({
    agent: one(agents, {
      fields: [agentVersions.agentId],
      references: [agents.id],
    }),
    workflowVersion: one(workflowVersions, {
      fields: [agentVersions.workflowVersionId],
      references: [workflowVersions.id],
    }),
    basedDrafts: many(agentDrafts),
    runs: many(runs),
  }),
);

export const agentDraftsRelations = relations(agentDrafts, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [agentDrafts.tenantId],
    references: [tenants.id],
  }),
  workflow: one(workflows, {
    fields: [agentDrafts.workflowId],
    references: [workflows.id],
  }),
  agent: one(agents, {
    fields: [agentDrafts.agentId],
    references: [agents.id],
  }),
  baseAgentVersion: one(agentVersions, {
    fields: [agentDrafts.baseAgentVersionId],
    references: [agentVersions.id],
  }),
  baseWorkflowVersion: one(workflowVersions, {
    fields: [agentDrafts.baseWorkflowVersionId],
    references: [workflowVersions.id],
  }),
  revisions: many(agentDraftRevisions),
}));

export const agentDraftRevisionsRelations = relations(
  agentDraftRevisions,
  ({ one, many }) => ({
    draft: one(agentDrafts, {
      fields: [agentDraftRevisions.draftId],
      references: [agentDrafts.id],
    }),
    runs: many(runs),
  }),
);

export const agentRunSessionsRelations = relations(
  agentRunSessions,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [agentRunSessions.tenantId],
      references: [tenants.id],
    }),
    agent: one(agents, {
      fields: [agentRunSessions.agentId],
      references: [agents.id],
    }),
    runs: many(runs),
    messages: many(runMessages),
  }),
);

export const runsRelations = relations(runs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [runs.tenantId], references: [tenants.id] }),
  agent: one(agents, { fields: [runs.agentId], references: [agents.id] }),
  agentVersion: one(agentVersions, {
    fields: [runs.agentVersionId],
    references: [agentVersions.id],
  }),
  draftRevision: one(agentDraftRevisions, {
    fields: [runs.draftRevisionId],
    references: [agentDraftRevisions.id],
  }),
  session: one(agentRunSessions, {
    fields: [runs.sessionId],
    references: [agentRunSessions.id],
  }),
  triggerEvent: one(events, {
    fields: [runs.triggerEventId],
    references: [events.id],
  }),
  steps: many(steps),
  tasks: many(tasks),
  messages: many(runMessages),
  artifacts: many(artifacts),
  traceEvents: many(runTraceEvents),
  emittedEvents: many(runEmittedEvents),
  llmCalls: many(llmCalls),
}));

export const stepsRelations = relations(steps, ({ one }) => ({
  run: one(runs, { fields: [steps.runId], references: [runs.id] }),
}));

export const llmCallsRelations = relations(llmCalls, ({ one }) => ({
  tenant: one(tenants, {
    fields: [llmCalls.tenantId],
    references: [tenants.id],
  }),
  run: one(runs, { fields: [llmCalls.runId], references: [runs.id] }),
  step: one(steps, { fields: [llmCalls.stepId], references: [steps.id] }),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [usageEvents.tenantId],
    references: [tenants.id],
  }),
  run: one(runs, { fields: [usageEvents.runId], references: [runs.id] }),
  step: one(steps, { fields: [usageEvents.stepId], references: [steps.id] }),
  llmCall: one(llmCalls, {
    fields: [usageEvents.llmCallId],
    references: [llmCalls.id],
  }),
}));

export const runMessagesRelations = relations(runMessages, ({ one }) => ({
  session: one(agentRunSessions, {
    fields: [runMessages.sessionId],
    references: [agentRunSessions.id],
  }),
  run: one(runs, { fields: [runMessages.runId], references: [runs.id] }),
}));

export const artifactsRelations = relations(artifacts, ({ one, many }) => ({
  run: one(runs, { fields: [artifacts.runId], references: [runs.id] }),
  step: one(steps, { fields: [artifacts.stepId], references: [steps.id] }),
  traceEvents: many(runTraceEvents),
}));

export const runTraceEventsRelations = relations(runTraceEvents, ({ one }) => ({
  run: one(runs, {
    fields: [runTraceEvents.runId],
    references: [runs.id],
  }),
  step: one(steps, {
    fields: [runTraceEvents.stepId],
    references: [steps.id],
  }),
  artifact: one(artifacts, {
    fields: [runTraceEvents.artifactId],
    references: [artifacts.id],
  }),
}));

export const runEmittedEventsRelations = relations(
  runEmittedEvents,
  ({ one }) => ({
    run: one(runs, {
      fields: [runEmittedEvents.runId],
      references: [runs.id],
    }),
    event: one(events, {
      fields: [runEmittedEvents.eventId],
      references: [events.id],
    }),
  }),
);

export const tasksRelations = relations(tasks, ({ one }) => ({
  tenant: one(tenants, { fields: [tasks.tenantId], references: [tenants.id] }),
  run: one(runs, { fields: [tasks.runId], references: [runs.id] }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  tenant: one(tenants, {
    fields: [events.tenantId],
    references: [tenants.id],
  }),
  sourceAgent: one(agents, {
    fields: [events.sourceAgentId],
    references: [agents.id],
  }),
}));

// ─── Agent Factory (brain conversations + failure reflections) ──────────────
// The factory's durable state: a streaming-brain conversation (so a follow-up
// message resumes mid-build) + per-domain failure/success reflections (so the next
// run starts wiser). Backs the ConversationStore + ReflectionWriter ports.

/** Authoritative runtime Domain (tenant) ↔ ontology Domain binding. */
export const factoryDomainBindings = sqliteTable(
  "factory_domain_bindings",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ontologyDomainId: text("ontology_domain_id").notNull(),
    ontologyDomainName: text("ontology_domain_name"),
    source: text("source", { enum: ["explicit", "auto", "upload"] })
      .notNull()
      .default("explicit"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    ontologyIdx: index("factory_domain_bindings_ontology_idx").on(
      t.ontologyDomainId,
    ),
  }),
);

/**
 * Explicit product-visibility marker for historical execution namespaces.
 *
 * The referenced tenant keeps owning all of its historical rows. It is merely
 * removed from the default Business Domain switcher after a platform operator
 * deliberately attaches its reviewed adapter to a canonical Business Domain.
 */
export const tenantRuntimeNamespaces = sqliteTable(
  "tenant_runtime_namespaces",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessDomainTenantId: text("business_domain_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    ownerStatusIdx: index("tenant_runtime_namespaces_owner_status_idx").on(
      t.businessDomainTenantId,
      t.status,
    ),
  }),
);

/**
 * Tenant-owned logical execution profile. Profile rows are mutable only for
 * lifecycle; executable coordinates live in immutable version rows below.
 */
export const runtimeProfiles = sqliteTable(
  "runtime_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantNameUq: uniqueIndex("runtime_profiles_tenant_name_uq").on(
      t.tenantId,
      t.name,
    ),
    tenantStatusIdx: index("runtime_profiles_tenant_status_idx").on(
      t.tenantId,
      t.status,
      t.updatedAt,
    ),
  }),
);

/**
 * Immutable, secret-free execution coordinates. `adapter_registry_slug`
 * selects reviewed code only; tenant_id remains the sole authorization,
 * Integration, credential, data, filesystem and audit owner.
 */
export const runtimeProfileVersions = sqliteTable(
  "runtime_profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => runtimeProfiles.id, { onDelete: "restrict" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    adapterKind: text("adapter_kind", {
      enum: ["native", "tenant_registry_compat"],
    }).notNull(),
    adapterRegistrySlug: text("adapter_registry_slug").notNull(),
    adapterRegistryVersion: text("adapter_registry_version").notNull(),
    eventNamespace: text("event_namespace").notNull(),
    compatibilityTenantId: text("compatibility_tenant_id").references(
      () => tenants.id,
      { onDelete: "restrict" },
    ),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    profileVersionUq: uniqueIndex(
      "runtime_profile_versions_profile_version_uq",
    ).on(t.profileId, t.version),
    tenantIdx: index("runtime_profile_versions_tenant_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    compatibilityTenantIdx: index(
      "runtime_profile_versions_compat_tenant_idx",
    ).on(t.compatibilityTenantId),
  }),
);

/**
 * Tenant = Business Domain; this registry contains the concrete Ontology
 * Domains that the Business Domain is allowed to use. Unlike the legacy
 * `factory_domain_bindings` default pointer, this is intentionally one-to-many.
 */
export const businessOntologyDomains = sqliteTable(
  "business_ontology_domains",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runtimeProfileVersionId: text("runtime_profile_version_id").references(
      () => runtimeProfileVersions.id,
      { onDelete: "restrict" },
    ),
    runtimeBindingMode: text("runtime_binding_mode", {
      enum: ["legacy_native", "profile_pinned"],
    })
      .notNull()
      .default("legacy_native"),
    ontologyDomainId: text("ontology_domain_id").notNull(),
    displayName: text("display_name").notNull(),
    source: text("source", {
      enum: ["allmeta", "upload", "manifest_legacy"],
    }).notNull(),
    status: text("status", {
      enum: ["active", "unavailable", "archived"],
    })
      .notNull()
      .default("active"),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    ontologySnapshotHash: text("ontology_snapshot_hash"),
    catalogMetadataJson: text("catalog_metadata_json")
      .notNull()
      .default("{}"),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantDomainUq: uniqueIndex(
      "business_ontology_domains_tenant_source_domain_uq",
    ).on(t.tenantId, t.source, t.ontologyDomainId),
    oneDefaultPerTenantUq: uniqueIndex(
      "business_ontology_domains_one_default_per_tenant_uq",
    )
      .on(t.tenantId)
      .where(sql`${t.isDefault} = 1 AND ${t.archivedAt} IS NULL`),
    tenantStatusIdx: index(
      "business_ontology_domains_tenant_status_idx",
    ).on(t.tenantId, t.status, t.updatedAt),
    domainIdx: index("business_ontology_domains_domain_idx").on(
      t.ontologyDomainId,
    ),
    runtimeProfileVersionIdx: index(
      "business_ontology_domains_runtime_profile_version_idx",
    ).on(t.tenantId, t.runtimeProfileVersionId),
  }),
);

export const factoryConversations = sqliteTable(
  "factory_conversations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    domain: text("domain").notNull(),
    messagesJson: text("messages_json", { mode: "json" }).notNull(),
    ctxJson: text("ctx_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    domainIdx: index("factory_conversations_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_conversations_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

export const factoryReflections = sqliteTable(
  "factory_reflections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(), // failure | success | caveat
    summary: text("summary").notNull(),
    rootCause: text("root_cause"),
    lesson: text("lesson").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    domainIdx: index("factory_reflections_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_reflections_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

/** Human-confirmed factory memory.  It is intentionally distinct from
 * `agent_memory_long`: the latter is maintained by an LLM consolidation
 * policy, while rows here retain provenance/pinning and may only be mutated
 * through an authenticated human path or a HITL gate carrying a human reply. */
export const factoryHumanMemories = sqliteTable(
  "factory_human_memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    questionKey: text("question_key").notNull(),
    kind: text("kind", {
      enum: ["clarify", "boundary", "test_approval", "directive"],
    }).notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    context: text("context"),
    source: text("source", { enum: ["human"] })
      .notNull()
      .default("human"),
    conversationId: text("conversation_id"),
    confirmed: integer("confirmed", { mode: "boolean" })
      .notNull()
      .default(true),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantDomainQuestionUq: uniqueIndex(
      "factory_human_memories_tenant_domain_question_uq",
    ).on(t.tenantId, t.domain, t.questionKey),
    tenantDomainIdx: index("factory_human_memories_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
    conversationIdx: index("factory_human_memories_conversation_idx").on(
      t.conversationId,
    ),
  }),
);

// #P0-3 — raw LLM telemetry: one row per LLM call (the factory brain + its review/design tools).
// Closes the biggest observability gap from the architecture audit — per-call model / routing /
// latency / size were ephemeral (in-memory streaming only), so spend + regression + router validation
// weren't auditable. Also carries the model-routing decision (requested vs served + fallback) so a
// separate model_routing table isn't needed for single-instance.
export const llmCallTelemetry = sqliteTable(
  "llm_call_telemetry",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Durable runtime attribution. Null only for non-run calls and legacy
     * telemetry written before migration 0039. */
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    domain: text("domain"),
    /** the brain conversation / run this call belongs to. */
    conversationId: text("conversation_id"),
    /** caller tag: understand | plan | critique | design | review | codegen | fast | … */
    purpose: text("purpose"),
    /** model requested (first of the fallback chain) vs the one that actually served. */
    requestedModel: text("requested_model"),
    servedModel: text("served_model"),
    provider: text("provider"),
    /** true when the served model differs from the requested (a fallback occurred). */
    fallback: integer("fallback", { mode: "boolean" }),
    promptChars: integer("prompt_chars"),
    completionChars: integer("completion_chars"),
    /** approx token counts (chars/4) when exact usage isn't returned by the streaming path. */
    approxTokensIn: integer("approx_tokens_in"),
    approxTokensOut: integer("approx_tokens_out"),
    /** How the token values were obtained. A null value means the historic
     * row predates explicit measurement provenance and must not be presented
     * as exact provider usage. */
    tokenSource: text("token_source", {
      enum: ["provider", "estimated_chars"],
    }),
    latencyMs: integer("latency_ms"),
    ok: integer("ok", { mode: "boolean" }),
    failureReason: text("failure_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("llm_call_telemetry_run_idx").on(t.runId),
    domainIdx: index("llm_call_telemetry_domain_idx").on(t.domain),
    convIdx: index("llm_call_telemetry_conversation_idx").on(t.conversationId),
    modelIdx: index("llm_call_telemetry_served_model_idx").on(t.servedModel),
  }),
);

// #P1-1 — durable, queryable event store. The NDJSON ledger is per-instance/per-date and not
// queryable; this mirrors every emitted inter-agent event into a DB row with the FULL payload inline
// (small now thanks to content-addressed blob offload) + causation lineage (causationId), so
// cross-agent causality is queryable + replay-safe across restarts. Foundation for horizontal scale.
export const eventStore = sqliteTable(
  "event_store",
  {
    id: text("id").primaryKey(), // == the emitted event id (evt-…)
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    subject: text("subject"),
    sourceRunId: text("source_run_id"),
    sourceAgent: text("source_agent"),
    /** the event id that CAUSED this one (its trigger) — walk this to reconstruct a causality chain. */
    causationId: text("causation_id"),
    correlationId: text("correlation_id"),
    /** full assembled payload inline (blob offload keeps this small). */
    payloadJson: text("payload_json"),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    subjectIdx: index("event_store_subject_idx").on(t.subject),
    causationIdx: index("event_store_causation_idx").on(t.causationId),
    corrIdx: index("event_store_correlation_idx").on(t.correlationId),
  }),
);

// #SCALE-TOOLS — per-tool sandbox effectiveness (invoked/succeeded). A score is
// owned by runtime tenant + ontology domain; otherwise one customer's failures
// silently demote the same tool for every other tenant/domain.
export const toolStats = sqliteTable(
  "tool_stats",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(), // tenant id | shared | legacy quarantine
    domainKey: text("domain_key").notNull().default(""),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    toolName: text("tool_name").notNull(),
    invoked: integer("invoked").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDomainToolUq: uniqueIndex("tool_stats_scope_domain_tool_uq").on(
      t.scopeKey,
      t.domainKey,
      t.toolName,
    ),
    tenantDomainIdx: index("tool_stats_tenant_domain_idx").on(
      t.tenantId,
      t.domainKey,
    ),
  }),
);

// #P1-6 — denormalized acceptance verdicts, one row per criterion per run. Acceptance was computed
// on-demand from the transcript JSON (no table), so pass-rate trends required replaying transcripts.
export const acceptanceScores = sqliteTable(
  "acceptance_scores",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    tenantId: text("tenant_id"),
    domain: text("domain"),
    criterionKey: text("criterion_key").notNull(),
    label: text("label"),
    pass: integer("pass", { mode: "boolean" }).notNull(),
    detail: text("detail"),
    computedAt: integer("computed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("acceptance_scores_run_idx").on(t.runId),
    domainIdx: index("acceptance_scores_domain_idx").on(t.domain),
  }),
);

// ─── Agent Factory run history + skills library ─────────────────────────────
// factory_runs backs the 历史运行 sidebar (one row per brain run, with the full
// transcript for read-only replay). factory_skills is the persistent skills library
// (create_skill/use_skill + effectiveness scoring), backing the SkillStore port.

export const factoryRuns = sqliteTable(
  "factory_runs",
  {
    id: text("id").primaryKey(),
    // tenant_id is NOT NULL + cascades (0021): factory runs are tenant-scoped like every other
    // user-visible table, so listing/deleting can filter by tenant and deleting a tenant GCs its
    // runs. (Was nullable + unfiltered, which leaked runs across tenants — see runs.ts/list).
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /**
     * Exact Business Domain → Ontology Domain registration used by this run.
     * Legacy Agent Factory runs may remain null and continue to use the
     * singleton factory_domain_bindings compatibility path.
     */
    ontologyDomainRegistrationId: text("ontology_domain_registration_id").references(
      () => businessOntologyDomains.id,
      { onDelete: "cascade" },
    ),
    runtimeProfileVersionId: text("runtime_profile_version_id").references(
      () => runtimeProfileVersions.id,
      { onDelete: "restrict" },
    ),
    goal: text("goal").notNull(),
    status: text("status").notNull(), // running | waiting_human | done | failed | error | aborted
    tokensUsed: integer("tokens_used").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    agentsCount: integer("agents_count").notNull().default(0),
    reachedTerminal: integer("reached_terminal", { mode: "boolean" })
      .notNull()
      .default(false),
    errorMessage: text("error_message"),
    transcriptJson: text("transcript_json", { mode: "json" }),
    // Soft delete (0021): the 历史运行 trash/clear sets this; listRuns hides non-null rows and a
    // reconnect to a soft-deleted run replays a tombstone. Recoverable via restoreRun.
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    domainIdx: index("factory_runs_domain_idx").on(t.domain, t.createdAt),
    registrationIdx: index("factory_runs_registration_idx").on(
      t.tenantId,
      t.ontologyDomainRegistrationId,
      t.createdAt,
    ),
    runtimeProfileVersionIdx: index(
      "factory_runs_runtime_profile_version_idx",
    ).on(t.tenantId, t.runtimeProfileVersionId, t.createdAt),
    deletedAtIdx: index("factory_runs_deleted_at_idx").on(t.deletedAt),
  }),
);

export const factorySkills = sqliteTable(
  "factory_skills",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(), // tenant id | shared | legacy quarantine
    /** Non-null conflict key for ontology identity. `domain` remains nullable so
     * null can keep its public meaning (tenant/global general); SQLite UNIQUE
     * treats NULL values as distinct, so it cannot safely be used directly. */
    domainKey: text("domain_key").notNull().default(""),
    slug: text("slug").notNull(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    promptFragment: text("prompt_fragment").notNull().default(""),
    tools: text("tools", { mode: "json" }).notNull(),
    decisionRule: text("decision_rule").notNull().default(""),
    domain: text("domain"), // null = cross-domain (general)
    useCount: integer("use_count").notNull().default(0),
    evalCount: integer("eval_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDomainSlugUq: uniqueIndex("factory_skills_scope_domain_slug_uq").on(
      t.scopeKey,
      t.domainKey,
      t.slug,
    ),
    domainIdx: index("factory_skills_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_skills_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

// #KNOW-PACK (P1-A) — persisted domain analysis packs: understand_ontology's expensive deep read
// (the ontologyUnderstanding digest + coverage + perspective-lens account), keyed by
// (tenant, domain, ontology CONTENT hash) so a NEW session on an unchanged ontology reuses it
// instantly instead of re-burning a 1-3 minute deep read. Invalidation is implicit: a lookup by
// the current hash simply misses when the ontology changed. save() prunes to the newest N sigs
// per (tenant, domain). Deliberately NOT in db:wipe-runtime — accumulated knowledge, not traffic.
export const factoryDomainInsights = sqliteTable(
  "factory_domain_insights",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /** ontologyContentHash of the POST-HEAL working ontology — must match the sig
     * understand_ontology stamps (curUnderstandSig), never read_ontology's pre-heal counts#hash. */
    ontologySig: text("ontology_sig").notNull(),
    mode: text("mode", { enum: ["shallow", "deep"] }).notNull(), // skeleton is never persisted
    /** ctx.ontologyUnderstanding verbatim (≤10k chars, same cap as the ctx field). */
    digest: text("digest").notNull(),
    coverageJson: text("coverage_json", { mode: "json" }),
    /** ctx.ontologyPerspectives verbatim — restored on load so the pack stays lens-aware
     * for the #PERSPECTIVES-FIDELITY cache gate. */
    perspectivesJson: text("perspectives_json", { mode: "json" }),
    ambiguityCount: integer("ambiguity_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantDomainSigUq: uniqueIndex(
      "factory_domain_insights_tenant_domain_sig_uq",
    ).on(t.tenantId, t.domain, t.ontologySig),
    tenantDomainIdx: index("factory_domain_insights_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

export const factoryTools = sqliteTable(
  "factory_tools",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(), // tenant id | shared | legacy quarantine
    /** See factorySkills.domainKey: prevents a rebind from overwriting the
     * previous ontology's same-named tool while keeping null-domain tools
     * explicitly general. */
    domainKey: text("domain_key").notNull().default(""),
    name: text("name").notNull(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    description: text("description").notNull().default(""),
    method: text("method").notNull().default("GET"),
    urlTemplate: text("url_template").notNull().default(""),
    headers: text("headers", { mode: "json" }),
    bodyTemplate: text("body_template"),
    // 0038: executable, AI-authored HTTP contracts. Keep these structured
    // manifests separate from the legacy body template so multipart encoding,
    // response normalization/assertions and grounded examples round-trip.
    requestSpec: text("request_spec", { mode: "json" }),
    responseSpec: text("response_spec", { mode: "json" }),
    examples: text("examples", { mode: "json" }),
    // No read default: omitted policy metadata must fail at insert/runtime
    // boundaries instead of silently upgrading an unknown tool to live-read.
    sideEffect: text("side_effect").notNull(),
    // 0048: precise reviewed execution policy. These remain nullable at the
    // storage layer solely to quarantine historical rows without inventing a
    // migration default. Every save/load/runtime boundary rejects null.
    operation: text("operation"),
    effectScope: text("effect_scope"),
    sandboxPolicy: text("sandbox_policy"),
    domain: text("domain"),
    // R6 (0022): typed I/O contracts — the tool's args + return shape (also the egress contract
    // for an external-platform handoff), so the step-engine can validate and agents agree on shapes.
    paramsSchema: text("params_schema", { mode: "json" }),
    returnsSchema: text("returns_schema", { mode: "json" }),
    capabilities: text("capabilities", { mode: "json" }),
    probeStatus: text("probe_status").notNull().default("required"),
    definitionHash: text("definition_hash"),
    probeEvidence: text("probe_evidence", { mode: "json" }),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDomainNameUq: uniqueIndex("factory_tools_scope_domain_name_uq").on(
      t.scopeKey,
      t.domainKey,
      t.name,
    ),
    domainIdx: index("factory_tools_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_tools_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

/** Durable lifecycle ledger for one nonce-bearing Agent Factory sandbox app.
 * The row is inserted in the same local transaction as the ephemeral tenant,
 * before manifest commit can register anything remotely. Terminal rows remain
 * as audit evidence; only cloned tool rows are physically deleted. */
export const factorySandboxAttempts = sqliteTable(
  "factory_sandbox_attempts",
  {
    id: text("id").primaryKey(),
    ownerTenantId: text("owner_tenant_id").notNull(),
    ownerTenantSlug: text("owner_tenant_slug").notNull(),
    targetDomainId: text("target_domain_id").notNull(),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    sandboxTenantId: text("sandbox_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    sandboxTenantSlug: text("sandbox_tenant_slug").notNull(),
    appId: text("app_id").notNull(),
    status: text("status", {
      enum: [
        "prepared",
        "registering",
        "active",
        "cleanup_pending",
        "cleanup_failed",
        "cleanup_verified",
      ],
    }).notNull(),
    remoteMayExist: integer("remote_may_exist", { mode: "boolean" })
      .notNull()
      .default(false),
    toolSnapshotHash: text("tool_snapshot_hash"),
    toolSnapshotCount: integer("tool_snapshot_count").notNull().default(0),
    leaseOwner: text("lease_owner").notNull(),
    /** Per-claim unguessable capability. Process identity alone is not enough:
     * a stale async continuation in the same process must also be fenced. */
    leaseToken: text("lease_token").notNull(),
    /** Monotonic fencing epoch. Cleanup claim increments this atomically, so
     * every earlier owner/token remains permanently unable to mutate state. */
    fenceGeneration: integer("fence_generation").notNull().default(1),
    leaseExpiresAt: integer("lease_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
    cleanupReceipt: text("cleanup_receipt", { mode: "json" }),
    cleanupError: text("cleanup_error"),
    runDrainStatus: text("run_drain_status", {
      enum: ["not_started", "cancelling", "verified", "failed"],
    })
      .notNull()
      .default("not_started"),
    runDrainReceipt: text("run_drain_receipt", { mode: "json" }),
    runDrainError: text("run_drain_error"),
    runDrainStartedAt: integer("run_drain_started_at", {
      mode: "timestamp_ms",
    }),
    runDrainCompletedAt: integer("run_drain_completed_at", {
      mode: "timestamp_ms",
    }),
    cleanupStartedAt: integer("cleanup_started_at", { mode: "timestamp_ms" }),
    cleanedAt: integer("cleaned_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    appUq: uniqueIndex("factory_sandbox_attempts_app_uq").on(t.appId),
    slugUq: uniqueIndex("factory_sandbox_attempts_slug_uq").on(
      t.sandboxTenantSlug,
    ),
    statusLeaseIdx: index("factory_sandbox_attempts_status_lease_idx").on(
      t.status,
      t.leaseExpiresAt,
    ),
    ownerFenceIdx: index("factory_sandbox_attempts_owner_fence_idx").on(
      t.id,
      t.leaseOwner,
      t.leaseToken,
      t.fenceGeneration,
    ),
    ownerDomainIdx: index("factory_sandbox_attempts_owner_domain_idx").on(
      t.ownerTenantId,
      t.targetDomainId,
    ),
  }),
);

/** Content-addressed provenance for a temporary declarative-tool clone. The
 * clone itself is a tenant-owned factory_tools row, so runtime resolution can
 * use its normal path without reading the production/shared source row. Both
 * this row and the cloned factory_tools row are physically deleted at teardown. */
export const factorySandboxToolSnapshots = sqliteTable(
  "factory_sandbox_tool_snapshots",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => factorySandboxAttempts.id, { onDelete: "cascade" }),
    sandboxTenantId: text("sandbox_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    sandboxToolId: text("sandbox_tool_id")
      .notNull()
      .references(() => factoryTools.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    sourceToolId: text("source_tool_id").notNull(),
    sourceScopeKey: text("source_scope_key").notNull(),
    sourceDefinitionHash: text("source_definition_hash").notNull(),
    configHash: text("config_hash").notNull(),
    domainHash: text("domain_hash").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    attemptToolUq: uniqueIndex(
      "factory_sandbox_tool_snapshots_attempt_tool_uq",
    ).on(t.attemptId, t.toolName),
    sandboxToolUq: uniqueIndex(
      "factory_sandbox_tool_snapshots_sandbox_tool_uq",
    ).on(t.sandboxToolId),
    snapshotIdx: index("factory_sandbox_tool_snapshots_hash_idx").on(
      t.snapshotHash,
    ),
  }),
);

/** Short-lived, cross-process authorization for semantic model calls made by
 * the trusted external sandbox workload. The workload presents only the
 * attempt/bundle identity plus a service token; provider credentials remain
 * in the primary API. Calls are atomically consumed and the grant is revoked
 * as soon as the remote job settles. */
export const factorySandboxModelGrants = sqliteTable(
  "factory_sandbox_model_grants",
  {
    attemptId: text("attempt_id").primaryKey(),
    bundleHash: text("bundle_hash").notNull(),
    tenantId: text("tenant_id").notNull(),
    tenantSlug: text("tenant_slug").notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    maxCalls: integer("max_calls").notNull(),
    calls: integer("calls").notNull().default(0),
    /** Hard aggregate total-token envelope for this remote verification.
     * Each admitted call atomically reserves a conservative input-token upper
     * bound plus max output before the provider is contacted. Reservations
     * are deliberately not refunded so crashes cannot reopen spend capacity. */
    maxTotalTokens: integer("max_total_tokens").notNull(),
    reservedTotalTokens: integer("reserved_total_tokens").notNull().default(0),
    /** Provider-reported usage, retained separately from the conservative
     * reservation envelope for audit/attribution. */
    measuredInputTokens: integer("measured_input_tokens").notNull().default(0),
    measuredOutputTokens: integer("measured_output_tokens")
      .notNull()
      .default(0),
    unmeasuredUsageCalls: integer("unmeasured_usage_calls")
      .notNull()
      .default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    activeExpiryIdx: index("factory_sandbox_model_grants_active_expiry_idx").on(
      t.status,
      t.expiresAt,
    ),
    tenantIdx: index("factory_sandbox_model_grants_tenant_idx").on(
      t.tenantId,
      t.tenantSlug,
    ),
  }),
);

/** Per-call, secret-free provider usage backing the aggregate evidence copied
 * into the signed sandbox result. Prompts, responses and provider raw payloads
 * are never stored here. */
export const factorySandboxModelCallUsage = sqliteTable(
  "factory_sandbox_model_call_usage",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => factorySandboxModelGrants.attemptId, {
        onDelete: "cascade",
      }),
    bundleHash: text("bundle_hash").notNull(),
    callOrdinal: integer("call_ordinal"),
    status: text("status", {
      enum: ["succeeded", "failed", "rejected"],
    }).notNull(),
    agentRef: text("agent_ref").notNull(),
    reasonCode: text("reason_code"),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    totalTokens: integer("total_tokens"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    attemptOrdinalUq: uniqueIndex(
      "factory_sandbox_model_call_usage_attempt_ordinal_uq",
    ).on(t.attemptId, t.callOrdinal),
    attemptBundleIdx: index(
      "factory_sandbox_model_call_usage_attempt_bundle_idx",
    ).on(t.attemptId, t.bundleHash),
  }),
);

/** Definition/config-bound probe receipts for global, tenant-native and
 * persisted declarative tools. factory_tools retains one representative row
 * for backwards-compatible display only; exact binding and promotion always
 * resolve evidence from this tenant+Ontology+tool+definition hash store. */
export const factoryToolProbes = sqliteTable(
  "factory_tool_probes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainKey: text("domain_key").notNull().default(""),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull().default("required"),
    definitionHash: text("definition_hash").notNull(),
    schemaHash: text("schema_hash"),
    evidence: text("evidence", { mode: "json" }),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeToolDefinitionUq: uniqueIndex(
      "factory_tool_probes_scope_tool_definition_uq",
    ).on(t.tenantId, t.domainKey, t.toolName, t.definitionHash),
    tenantDomainIdx: index("factory_tool_probes_tenant_domain_idx").on(
      t.tenantId,
      t.domainKey,
    ),
  }),
);

/** Human-confirmed, non-secret runtime integration config. Secret material is
 * never stored here: `*_env` values are environment variable names only. */
export const factoryIntegrationProfiles = sqliteTable(
  "factory_integration_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainKey: text("domain_key").notNull().default(""),
    toolName: text("tool_name").notNull(),
    profileKey: text("profile_key").notNull(),
    environment: text("environment", { enum: ["sandbox", "production"] })
      .notNull()
      .default("production"),
    configJson: text("config_json", { mode: "json" }).notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    toolDefinitionDigest: text("tool_definition_digest").notNull().default(""),
    configDigest: text("config_digest").notNull().default(""),
    authorizationProtocolVersion: integer("authorization_protocol_version")
      .notNull()
      .default(0),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeKeyUq: uniqueIndex("factory_integration_profiles_scope_key_uq").on(
      t.tenantId,
      t.domainKey,
      t.toolName,
      t.profileKey,
      t.environment,
    ),
    tenantDomainIdx: index("factory_integration_profiles_tenant_domain_idx").on(
      t.tenantId,
      t.domainKey,
    ),
  }),
);

/** Server-issued, exact and one-shot human authorization challenges. The raw
 * token is never persisted—only its digest. Consumption and actor attribution
 * occur in one DB transaction before any authorized I/O begins. */
export const factoryAuthorizationChallenges = sqliteTable(
  "factory_authorization_challenges",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainKey: text("domain_key").notNull(),
    kind: text("kind").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    digest: text("digest").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    tokenDigest: text("token_digest").notNull(),
    question: text("question").notNull(),
    context: text("context").notNull(),
    optionsJson: text("options_json", { mode: "json" }).notNull(),
    runId: text("run_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    answeredBy: text("answered_by"),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDigestUq: uniqueIndex(
      "factory_authorization_challenges_scope_digest_uq",
    ).on(t.tenantId, t.domainKey, t.kind, t.digest),
    conversationIdx: index(
      "factory_authorization_challenges_conversation_idx",
    ).on(t.tenantId, t.domainKey, t.conversationId),
  }),
);

/** Durable authorization for one exact generated production Agent. The table
 * keeps its original CodeAct name for migration compatibility; declarative
 * rows store their exact agent-manifest hash in `codeSha256`, while CodeAct
 * rows store the exact handler hash. Rows are inserted only by Factory
 * promotion in the same transaction as the workflow deployment. */
export const factoryCodeActAuthorizations = sqliteTable(
  "factory_codeact_authorizations",
  {
    id: text("id").primaryKey(),
    promotionId: text("promotion_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tenantSlug: text("tenant_slug").notNull(),
    domainId: text("domain_id").notNull(),
    agentSlug: text("agent_slug").notNull(),
    promotionVersionId: text("promotion_version_id").notNull(),
    regressionSuiteFingerprint: text("regression_suite_fingerprint").notNull(),
    codeSha256: text("code_sha256").notNull(),
    agentManifestSha256: text("agent_manifest_sha256").notNull(),
    workflowManifestSha256: text("workflow_manifest_sha256").notNull(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    reviewReceiptId: text("review_receipt_id").notNull(),
    reviewSelectionHash: text("review_selection_hash").notNull(),
    regressionArtifact: text("regression_artifact").notNull(),
    promotionRecordHash: text("promotion_record_hash").notNull(),
    activationPromotionId: text("activation_promotion_id").notNull(),
    activationDomainId: text("activation_domain_id").notNull(),
    activationVersionId: text("activation_version_id").notNull(),
    activationReviewReceiptId: text("activation_review_receipt_id").notNull(),
    activationReviewSelectionHash: text(
      "activation_review_selection_hash",
    ).notNull(),
    activationPromotionRecordHash: text(
      "activation_promotion_record_hash",
    ).notNull(),
    status: text("status", { enum: ["committed"] })
      .notNull()
      .default("committed"),
    committedAt: integer("committed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    deploymentAgentUq: uniqueIndex(
      "factory_codeact_authorizations_deployment_agent_uq",
    ).on(t.deploymentId, t.agentSlug),
    tenantAgentIdx: index("factory_codeact_authorizations_tenant_agent_idx").on(
      t.tenantId,
      t.agentSlug,
    ),
    deploymentIdx: index("factory_codeact_authorizations_deployment_idx").on(
      t.deploymentId,
    ),
  }),
);

// ─── External system profiles (OntoCode 外部系统档案) ────────────────────────
// One row per (tenant, external platform): the human-confirmed, machine-readable
// declaration of a system's identity/aliases + api/events/data capabilities.
// The profile JSON is the @agentic/contracts SystemProfileV1 document.

export const systemProfiles = sqliteTable(
  "system_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    profileId: text("profile_id").notNull(),
    profileJson: text("profile_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantProfileUq: uniqueIndex("system_profiles_tenant_profile_uq").on(
      t.tenantId,
      t.profileId,
    ),
    tenantIdx: index("system_profiles_tenant_idx").on(t.tenantId),
  }),
);

// ─── OntoCode conversational engineering workspace ─────────────────────────
// These tables deliberately separate the long-lived FDE + AI collaboration
// session from individual Agent Factory / Harness executions. A session can
// therefore carry many commands, jobs, evidence events, and future artifact
// versions without reusing a runtime run id as product state.

export const ontocodeProjects = sqliteTable(
  "ontocode_projects",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ontologyDomainRegistrationId: text("ontology_domain_registration_id")
      .references(() => businessOntologyDomains.id, { onDelete: "cascade" }),
    runtimeProfileVersionId: text("runtime_profile_version_id").references(
      () => runtimeProfileVersions.id,
      { onDelete: "restrict" },
    ),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    activePackageVersionId: text("active_package_version_id"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantDomainIdx: index("ontocode_projects_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
    tenantRegistrationLegacyUq: uniqueIndex(
      "ontocode_projects_tenant_registration_legacy_uq",
    )
      .on(t.tenantId, t.ontologyDomainRegistrationId)
      .where(sql`${t.runtimeProfileVersionId} IS NULL`),
    tenantRegistrationRuntimeUq: uniqueIndex(
      "ontocode_projects_tenant_registration_runtime_uq",
    )
      .on(
        t.tenantId,
        t.ontologyDomainRegistrationId,
        t.runtimeProfileVersionId,
      )
      .where(sql`${t.runtimeProfileVersionId} IS NOT NULL`),
    tenantUpdatedIdx: index("ontocode_projects_tenant_updated_idx").on(
      t.tenantId,
      t.updatedAt,
    ),
  }),
);

export const ontocodeSessions = sqliteTable(
  "ontocode_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    runtimeProfileVersionId: text("runtime_profile_version_id").references(
      () => runtimeProfileVersions.id,
      { onDelete: "restrict" },
    ),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    phase: text("phase", {
      enum: [
        "intake",
        "scope",
        "configure",
        "blueprint",
        "build",
        "verify",
        "debug",
        "review",
        "release",
        "observe",
        "completed",
      ],
    })
      .notNull()
      .default("intake"),
    activityState: text("activity_state", {
      enum: [
        "idle",
        "ai_planning",
        "queued",
        "running",
        "needs_user",
        "blocked_external",
        "review_required",
        "failed_recoverable",
        "paused",
        "cancelled",
      ],
    })
      .notNull()
      .default("idle"),
    autonomyMode: text("autonomy_mode", {
      enum: ["guide", "copilot", "sandbox_autopilot"],
    })
      .notNull()
      .default("copilot"),
    revision: integer("revision").notNull().default(1),
    ontologySnapshotHash: text("ontology_snapshot_hash"),
    basePackageVersionId: text("base_package_version_id"),
    environmentProfileVersionId: text("environment_profile_version_id"),
    ownerUserId: text("owner_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantProjectUpdatedIdx: index(
      "ontocode_sessions_tenant_project_updated_idx",
    ).on(t.tenantId, t.projectId, t.updatedAt),
    tenantStateUpdatedIdx: index(
      "ontocode_sessions_tenant_state_updated_idx",
    ).on(t.tenantId, t.activityState, t.updatedAt),
    runtimeProfileVersionIdx: index(
      "ontocode_sessions_runtime_profile_version_idx",
    ).on(t.tenantId, t.runtimeProfileVersionId, t.updatedAt),
  }),
);

export const ontocodeCommands = sqliteTable(
  "ontocode_commands",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    expectedSessionRevision: integer("expected_session_revision").notNull(),
    baseOntologyHash: text("base_ontology_hash"),
    basePackageVersionId: text("base_package_version_id"),
    affectedSemanticPathsJson: text("affected_semantic_paths_json")
      .notNull()
      .default("[]"),
    requestedCapabilitiesJson: text("requested_capabilities_json")
      .notNull()
      .default("[]"),
    riskClass: text("risk_class", {
      enum: [
        "read_only",
        "draft_change",
        "sandbox_effect",
        "external_reversible",
        "external_irreversible",
        "production_deploy",
      ],
    })
      .notNull()
      .default("draft_change"),
    status: text("status", {
      enum: [
        "proposed",
        "awaiting_approval",
        "approved",
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "rejected",
      ],
    })
      .notNull()
      .default("proposed"),
    requiresHuman: integer("requires_human", { mode: "boolean" })
      .notNull()
      .default(false),
    rationaleSummary: text("rationale_summary").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_commands_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    tenantSessionCreatedIdx: index(
      "ontocode_commands_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    tenantStatusUpdatedIdx: index(
      "ontocode_commands_tenant_status_updated_idx",
    ).on(t.tenantId, t.status, t.updatedAt),
  }),
);

export const ontocodeHarnessJobs = sqliteTable(
  "ontocode_harness_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    commandId: text("command_id").references(() => ontocodeCommands.id, {
      onDelete: "set null",
    }),
    runtimeProfileVersionId: text("runtime_profile_version_id").references(
      () => runtimeProfileVersions.id,
      { onDelete: "restrict" },
    ),
    kind: text("kind").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "leased",
        "running",
        "waiting_user",
        "retry_scheduled",
        "failed_recoverable",
        "failed_terminal",
        "cancelled",
        "succeeded",
      ],
    })
      .notNull()
      .default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash"),
    budgetJson: text("budget_json"),
    candidatePackageVersionId: text("candidate_package_version_id"),
    candidateDependencyRoot: text("candidate_dependency_root"),
    candidateHeadId: text("candidate_head_id"),
    candidateHeadRevision: integer("candidate_head_revision"),
    testCasesJson: text("test_cases_json").notNull().default("[]"),
    errorMessage: text("error_message"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSessionCreatedIdx: index(
      "ontocode_harness_jobs_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    tenantStatusUpdatedIdx: index(
      "ontocode_harness_jobs_tenant_status_updated_idx",
    ).on(t.tenantId, t.status, t.updatedAt),
    commandIdx: index("ontocode_harness_jobs_command_idx").on(t.commandId),
    candidatePackageIdx: index(
      "ontocode_harness_jobs_candidate_package_idx",
    ).on(t.tenantId, t.candidatePackageVersionId),
    candidateHeadIdx: index("ontocode_harness_jobs_candidate_head_idx").on(
      t.tenantId,
      t.candidateHeadId,
      t.candidateHeadRevision,
    ),
    runtimeProfileVersionIdx: index(
      "ontocode_harness_jobs_runtime_profile_version_idx",
    ).on(t.tenantId, t.runtimeProfileVersionId, t.createdAt),
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_harness_jobs_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
  }),
);

/**
 * Durable, secret-free continuation boundary between an OntoCode
 * recommendation and a real configuration surface. The opaque id may appear
 * in a URL, but authorization always comes from tenant/session scope.
 *
 * target/requirement/policy JSON contain identifiers and field SHAPES only.
 * Credential values belong exclusively to their dedicated encrypted stores.
 */
export const ontocodeConfigurationTasks = sqliteTable(
  "ontocode_configuration_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    sourceCommandId: text("source_command_id").references(
      () => ontocodeCommands.id,
      { onDelete: "set null" },
    ),
    waitingHarnessJobId: text("waiting_harness_job_id").references(
      () => ontocodeHarnessJobs.id,
      { onDelete: "set null" },
    ),
    sourceRequirementId: text("source_requirement_id"),
    sourceActionName: text("source_action_name"),
    sourceReceiptDigest: text("source_receipt_digest"),
    blockerKey: text("blocker_key").notNull(),
    title: text("title").notNull(),
    targetKind: text("target_kind", {
      enum: [
        "integration",
        "system_profile",
        "tool",
        "tool_profile",
        "llm_gateway",
        "environment",
      ],
    }).notNull(),
    targetJson: text("target_json").notNull(),
    requirementJson: text("requirement_json").notNull(),
    verificationPolicyJson: text("verification_policy_json").notNull(),
    resumeAction: text("resume_action"),
    ontologyHash: text("ontology_hash").notNull(),
    status: text("status", {
      enum: ["open", "verifying", "satisfied", "cancelled", "superseded"],
    })
      .notNull()
      .default("open"),
    revision: integer("revision").notNull().default(1),
    lastVerificationJson: text("last_verification_json"),
    lastVerificationIdempotencyKey: text("last_verification_idempotency_key"),
    resolutionNote: text("resolution_note"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    verificationStartedAt: integer("verification_started_at", {
      mode: "timestamp_ms",
    }),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_configuration_tasks_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    tenantSessionUpdatedIdx: index(
      "ontocode_configuration_tasks_tenant_session_updated_idx",
    ).on(t.tenantId, t.sessionId, t.updatedAt),
    tenantStatusUpdatedIdx: index(
      "ontocode_configuration_tasks_tenant_status_updated_idx",
    ).on(t.tenantId, t.status, t.updatedAt),
    tenantSessionBlockerIdx: index(
      "ontocode_configuration_tasks_tenant_session_blocker_idx",
    ).on(t.tenantId, t.sessionId, t.blockerKey),
    sourceCommandIdx: index(
      "ontocode_configuration_tasks_source_command_idx",
    ).on(t.sourceCommandId),
    waitingHarnessJobIdx: index(
      "ontocode_configuration_tasks_waiting_job_idx",
    ).on(t.waitingHarnessJobId),
    waitingRequirementIdx: index(
      "ontocode_configuration_tasks_waiting_requirement_idx",
    ).on(t.tenantId, t.waitingHarnessJobId, t.sourceRequirementId),
  }),
);

export const ontocodeSessionMessages = sqliteTable(
  "ontocode_session_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    type: text("type", {
      enum: [
        "text",
        "recommendation",
        "receipt",
        "decision",
        "configuration",
        "error",
      ],
    })
      .notNull()
      .default("text"),
    contentJson: text("content_json").notNull(),
    idempotencyKey: text("idempotency_key"),
    commandId: text("command_id").references(() => ontocodeCommands.id, {
      onDelete: "set null",
    }),
    correlationId: text("correlation_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSessionCreatedIdx: index(
      "ontocode_session_messages_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    commandIdx: index("ontocode_session_messages_command_idx").on(t.commandId),
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_session_messages_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
  }),
);

export const ontocodeSessionEvents = sqliteTable(
  "ontocode_session_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    visibility: text("visibility", {
      enum: ["user", "debug", "audit"],
    })
      .notNull()
      .default("user"),
    payloadJson: text("payload_json").notNull(),
    commandId: text("command_id").references(() => ontocodeCommands.id, {
      onDelete: "set null",
    }),
    harnessJobId: text("harness_job_id").references(
      () => ontocodeHarnessJobs.id,
      { onDelete: "set null" },
    ),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionSeqUq: uniqueIndex("ontocode_session_events_session_seq_uq").on(
      t.tenantId,
      t.sessionId,
      t.seq,
    ),
    tenantSessionCreatedIdx: index(
      "ontocode_session_events_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    correlationIdx: index("ontocode_session_events_correlation_idx").on(
      t.correlationId,
    ),
  }),
);

export const ontocodeChangeSets = sqliteTable(
  "ontocode_changesets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    commandId: text("command_id").references(() => ontocodeCommands.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: ["proposed", "validated", "committed", "abandoned"],
    })
      .notNull()
      .default("proposed"),
    summary: text("summary").notNull(),
    baseOntologyHash: text("base_ontology_hash"),
    basePackageVersionId: text("base_package_version_id"),
    expectedSessionRevision: integer("expected_session_revision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    committedAt: integer("committed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_changesets_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    tenantSessionCreatedIdx: index(
      "ontocode_changesets_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    tenantStatusUpdatedIdx: index(
      "ontocode_changesets_tenant_status_updated_idx",
    ).on(t.tenantId, t.status, t.updatedAt),
    commandIdx: index("ontocode_changesets_command_idx").on(t.commandId),
  }),
);

export const ontocodeChangeSetOperations = sqliteTable(
  "ontocode_changeset_operations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    changeSetId: text("changeset_id")
      .notNull()
      .references(() => ontocodeChangeSets.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    operation: text("operation", {
      enum: ["add", "replace", "remove", "move"],
    }).notNull(),
    semanticPath: text("semantic_path").notNull(),
    fromSemanticPath: text("from_semantic_path"),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    sourceRefsJson: text("source_refs_json").notNull().default("[]"),
    invalidatesJson: text("invalidates_json").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    changeSetOrdinalUq: uniqueIndex(
      "ontocode_changeset_operations_changeset_ordinal_uq",
    ).on(t.tenantId, t.changeSetId, t.ordinal),
    semanticPathIdx: index(
      "ontocode_changeset_operations_semantic_path_idx",
    ).on(t.tenantId, t.semanticPath),
  }),
);

export const ontocodeArtifacts = sqliteTable(
  "ontocode_artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    logicalName: text("logical_name").notNull(),
    kind: text("kind").notNull(),
    semanticPath: text("semantic_path"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionLogicalNameUq: uniqueIndex(
      "ontocode_artifacts_session_logical_name_uq",
    ).on(t.tenantId, t.sessionId, t.logicalName),
    tenantSessionCreatedIdx: index(
      "ontocode_artifacts_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    tenantKindIdx: index("ontocode_artifacts_tenant_kind_idx").on(
      t.tenantId,
      t.kind,
    ),
  }),
);

export const ontocodeArtifactBlobs = sqliteTable(
  "ontocode_artifact_blobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentText: text("content_text").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantShaUq: uniqueIndex("ontocode_artifact_blobs_tenant_sha_uq").on(
      t.tenantId,
      t.sha256,
    ),
  }),
);

export const ontocodeArtifactVersions = sqliteTable(
  "ontocode_artifact_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => ontocodeArtifacts.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    changeSetId: text("changeset_id").references(() => ontocodeChangeSets.id, {
      onDelete: "set null",
    }),
    blobId: text("blob_id")
      .notNull()
      .references(() => ontocodeArtifactBlobs.id, {
        onDelete: "restrict",
      }),
    version: integer("version").notNull(),
    blobHash: text("blob_hash").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    artifactVersionUq: uniqueIndex(
      "ontocode_artifact_versions_artifact_version_uq",
    ).on(t.tenantId, t.artifactId, t.version),
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_artifact_versions_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    tenantSessionCreatedIdx: index(
      "ontocode_artifact_versions_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    blobIdx: index("ontocode_artifact_versions_blob_idx").on(t.blobId),
    changeSetIdx: index("ontocode_artifact_versions_changeset_idx").on(
      t.changeSetId,
    ),
  }),
);

export const ontocodeEvidenceRecords = sqliteTable(
  "ontocode_evidence_records",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    harnessJobId: text("harness_job_id").references(
      () => ontocodeHarnessJobs.id,
      { onDelete: "set null" },
    ),
    changeSetId: text("changeset_id").references(() => ontocodeChangeSets.id, {
      onDelete: "set null",
    }),
    artifactVersionId: text("artifact_version_id").references(
      () => ontocodeArtifactVersions.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").notNull(),
    outcome: text("outcome", {
      enum: ["passed", "failed", "inconclusive", "informational"],
    }).notNull(),
    state: text("state", { enum: ["valid", "stale"] })
      .notNull()
      .default("valid"),
    staleReason: text("stale_reason"),
    invalidatedByPackageVersionId: text(
      "invalidated_by_package_version_id",
    ),
    invalidatedAt: integer("invalidated_at", { mode: "timestamp_ms" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    dependencySetJson: text("dependency_set_json").notNull(),
    validityPredicateJson: text("validity_predicate_json").notNull(),
    refsJson: text("refs_json").notNull().default("[]"),
    summary: text("summary").notNull(),
    producer: text("producer").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    recordedBy: text("recorded_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_evidence_records_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    tenantSessionCreatedIdx: index(
      "ontocode_evidence_records_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    tenantKindOutcomeIdx: index(
      "ontocode_evidence_records_tenant_kind_outcome_idx",
    ).on(t.tenantId, t.kind, t.outcome),
    tenantStateCreatedIdx: index(
      "ontocode_evidence_records_tenant_state_created_idx",
    ).on(t.tenantId, t.state, t.createdAt),
    harnessJobIdx: index("ontocode_evidence_records_harness_job_idx").on(
      t.harnessJobId,
    ),
    subjectIdx: index("ontocode_evidence_records_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
  }),
);

export const ontocodePackageVersions = sqliteTable(
  "ontocode_package_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    parentVersionId: text("parent_version_id"),
    sourceHarnessJobId: text("source_harness_job_id").references(
      () => ontocodeHarnessJobs.id,
      { onDelete: "set null" },
    ),
    ontologyHash: text("ontology_hash").notNull(),
    dependencyRoot: text("dependency_root").notNull(),
    artifactRefsJson: text("artifact_refs_json").notNull(),
    executionOwnersJson: text("execution_owners_json").notNull(),
    status: text("status", {
      enum: [
        "candidate_ready",
        "verified_candidate",
        "release_ready",
        "released",
      ],
    })
      .notNull()
      .default("candidate_ready"),
    validationJson: text("validation_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_package_versions_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    tenantSessionCreatedIdx: index(
      "ontocode_package_versions_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    dependencyRootIdx: index(
      "ontocode_package_versions_dependency_root_idx",
    ).on(t.tenantId, t.dependencyRoot),
    sourceHarnessJobIdx: index(
      "ontocode_package_versions_source_harness_job_idx",
    ).on(t.sourceHarnessJobId),
  }),
);

export const ontocodeCandidateHeads = sqliteTable(
  "ontocode_candidate_heads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => ontocodePackageVersions.id, {
        onDelete: "restrict",
      }),
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSessionUq: uniqueIndex(
      "ontocode_candidate_heads_tenant_session_uq",
    ).on(t.tenantId, t.sessionId),
    packageVersionIdx: index("ontocode_candidate_heads_package_version_idx").on(
      t.packageVersionId,
    ),
    tenantProjectUpdatedIdx: index(
      "ontocode_candidate_heads_tenant_project_updated_idx",
    ).on(t.tenantId, t.projectId, t.updatedAt),
  }),
);

export const ontocodeEvidenceInvalidations = sqliteTable(
  "ontocode_evidence_invalidations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => ontocodeEvidenceRecords.id, { onDelete: "cascade" }),
    causedByChangeSetId: text("caused_by_changeset_id")
      .notNull()
      .references(() => ontocodeChangeSets.id, { onDelete: "cascade" }),
    causedByPackageVersionId: text("caused_by_package_version_id")
      .notNull()
      .references(() => ontocodePackageVersions.id, {
        onDelete: "restrict",
      }),
    reason: text("reason").notNull(),
    dependencyKeysJson: text("dependency_keys_json").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    evidencePackageUq: uniqueIndex(
      "ontocode_evidence_invalidations_evidence_package_uq",
    ).on(t.tenantId, t.evidenceId, t.causedByPackageVersionId),
    changeSetIdx: index(
      "ontocode_evidence_invalidations_changeset_idx",
    ).on(t.tenantId, t.causedByChangeSetId),
  }),
);

/**
 * OntoCode control-plane record for an exact Candidate Sandbox execution.
 * A remote runner owns its own lifecycle ledger, so factorySandboxAttemptId is
 * an attested identity rather than a cross-database foreign key.
 */
export const ontocodeSandboxAttempts = sqliteTable(
  "ontocode_sandbox_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => ontocodeProjects.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    harnessJobId: text("harness_job_id")
      .notNull()
      .references(() => ontocodeHarnessJobs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    packageVersionId: text("package_version_id")
      .notNull()
      .references(() => ontocodePackageVersions.id, {
        onDelete: "restrict",
      }),
    dependencyRoot: text("dependency_root").notNull(),
    ontologyHash: text("ontology_hash").notNull(),
    testSuiteHash: text("test_suite_hash").notNull(),
    environmentProfileVersionId: text("environment_profile_version_id"),
    factorySandboxAttemptId: text("factory_sandbox_attempt_id"),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    bundleHash: text("bundle_hash"),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "blocked",
        "cleanup_failed",
      ],
    })
      .notNull()
      .default("queued"),
    qualification: text("qualification", {
      enum: ["development_only", "promotable"],
    })
      .notNull()
      .default("development_only"),
    executionOrigin: text("execution_origin", {
      enum: ["local", "remote"],
    }),
    isolationTier: text("isolation_tier"),
    appId: text("app_id"),
    sandboxTenantSlug: text("sandbox_tenant_slug"),
    registrationReceiptJson: text("registration_receipt_json"),
    executionReceiptJson: text("execution_receipt_json"),
    testReceiptJson: text("test_receipt_json"),
    runDrainReceiptJson: text("run_drain_receipt_json"),
    cleanupReceiptJson: text("cleanup_receipt_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    harnessOrdinalUq: uniqueIndex(
      "ontocode_sandbox_attempts_harness_ordinal_uq",
    ).on(t.tenantId, t.harnessJobId, t.ordinal),
    remoteAttemptUq: uniqueIndex(
      "ontocode_sandbox_attempts_remote_attempt_uq",
    ).on(t.tenantId, t.factorySandboxAttemptId),
    tenantSessionCreatedIdx: index(
      "ontocode_sandbox_attempts_tenant_session_created_idx",
    ).on(t.tenantId, t.sessionId, t.createdAt),
    candidatePackageIdx: index(
      "ontocode_sandbox_attempts_candidate_package_idx",
    ).on(t.tenantId, t.packageVersionId, t.createdAt),
    statusIdx: index("ontocode_sandbox_attempts_status_idx").on(
      t.tenantId,
      t.status,
      t.updatedAt,
    ),
  }),
);

/**
 * Durable conversational orchestration state. Assistant runs are deliberately
 * not Harness jobs: they preserve the accepted user turn, exact compiled
 * context and planning/review observations even when no mutation is proposed
 * or when the model/provider fails.
 */
export const ontocodeAssistantRuns = sqliteTable(
  "ontocode_assistant_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    sourceMessageId: text("source_message_id")
      .notNull()
      .references(() => ontocodeSessionMessages.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["accepted", "planning", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("accepted"),
    autonomyMode: text("autonomy_mode", {
      enum: ["guide", "copilot", "sandbox_autopilot"],
    }).notNull(),
    policyJson: text("policy_json").notNull().default("{}"),
    contextHash: text("context_hash"),
    contextManifestJson: text("context_manifest_json").notNull().default("{}"),
    budgetJson: text("budget_json").notNull().default("{}"),
    model: text("model"),
    terminalResponseJson: text("terminal_response_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionIdempotencyUq: uniqueIndex(
      "ontocode_assistant_runs_session_idempotency_uq",
    ).on(t.tenantId, t.sessionId, t.idempotencyKey),
    sourceMessageUq: uniqueIndex(
      "ontocode_assistant_runs_source_message_uq",
    ).on(t.tenantId, t.sourceMessageId),
    tenantSessionUpdatedIdx: index(
      "ontocode_assistant_runs_tenant_session_updated_idx",
    ).on(t.tenantId, t.sessionId, t.updatedAt),
    tenantStatusUpdatedIdx: index(
      "ontocode_assistant_runs_tenant_status_updated_idx",
    ).on(t.tenantId, t.status, t.updatedAt),
  }),
);

export const ontocodeAssistantSteps = sqliteTable(
  "ontocode_assistant_steps",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    assistantRunId: text("assistant_run_id")
      .notNull()
      .references(() => ontocodeAssistantRuns.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind", {
      enum: ["context_compile", "model_plan", "policy_commit", "result_review"],
    }).notNull(),
    status: text("status", {
      enum: ["running", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("running"),
    attempt: integer("attempt").notNull().default(1),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    observationJson: text("observation_json").notNull().default("{}"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runOrdinalUq: uniqueIndex("ontocode_assistant_steps_run_ordinal_uq").on(
      t.tenantId,
      t.assistantRunId,
      t.ordinal,
    ),
    tenantRunUpdatedIdx: index(
      "ontocode_assistant_steps_tenant_run_updated_idx",
    ).on(t.tenantId, t.assistantRunId, t.updatedAt),
    tenantSessionUpdatedIdx: index(
      "ontocode_assistant_steps_tenant_session_updated_idx",
    ).on(t.tenantId, t.sessionId, t.updatedAt),
  }),
);

export const ontocodePinnedContextRefs = sqliteTable(
  "ontocode_pinned_context_refs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => ontocodeSessions.id, { onDelete: "cascade" }),
    assistantRunId: text("assistant_run_id")
      .notNull()
      .references(() => ontocodeAssistantRuns.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind", {
      enum: ["ontology", "artifact", "evidence", "changeset"],
    }).notNull(),
    requestedRef: text("requested_ref").notNull(),
    canonicalRef: text("canonical_ref").notNull(),
    artifactId: text("artifact_id").references(() => ontocodeArtifacts.id, {
      onDelete: "set null",
    }),
    artifactVersionId: text("artifact_version_id").references(
      () => ontocodeArtifactVersions.id,
      { onDelete: "set null" },
    ),
    evidenceId: text("evidence_id").references(
      () => ontocodeEvidenceRecords.id,
      { onDelete: "set null" },
    ),
    changeSetId: text("changeset_id").references(() => ontocodeChangeSets.id, {
      onDelete: "set null",
    }),
    contentHash: text("content_hash").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runOrdinalUq: uniqueIndex("ontocode_pinned_context_refs_run_ordinal_uq").on(
      t.tenantId,
      t.assistantRunId,
      t.ordinal,
    ),
    canonicalRefIdx: index("ontocode_pinned_context_refs_canonical_ref_idx").on(
      t.tenantId,
      t.sessionId,
      t.canonicalRef,
    ),
    artifactVersionIdx: index(
      "ontocode_pinned_context_refs_artifact_version_idx",
    ).on(t.artifactVersionId),
    evidenceIdx: index("ontocode_pinned_context_refs_evidence_idx").on(
      t.evidenceId,
    ),
  }),
);

/**
 * #SESSION-PURGE — the durable record of a deleted OntoCode Session.
 *
 * A Session's footprint spans four stores and a row delete reaches exactly one:
 * SQLite rows (cascade), the factory run NDJSON transcripts, the conversation
 * archive that `recall_conversation` searches, and the generated agent drafts.
 * Every one of those files is named by JOB id, and the job rows are the only
 * thing that maps a file back to a Session — the cascade deletes them first, so
 * anything not collected BEFORE the delete becomes permanently unattributable.
 *
 * This row is collected first and outlives the Session on purpose: it is both
 * the record of what the Session was, and the worklist that lets a partial
 * purge be finished later instead of quietly leaving orphans. It deliberately
 * carries no FK to the session — the whole point is that the session is gone.
 */
export const ontocodeSessionPurges = sqliteTable(
  "ontocode_session_purges",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    sessionTitle: text("session_title").notNull(),
    projectId: text("project_id").notNull(),
    domain: text("domain").notNull(),
    /** pending | completed | partial */
    status: text("status", {
      enum: ["pending", "completed", "partial"],
    })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by"),
    /** What the Session was, captured before its rows disappeared. */
    summaryJson: text("summary_json").notNull(),
    /** External targets, collected while the job rows still existed. */
    targetsJson: text("targets_json").notNull(),
    removedJson: text("removed_json").notNull().default("[]"),
    failuresJson: text("failures_json").notNull().default("[]"),
    bytesRemoved: integer("bytes_removed").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantStatusIdx: index("ontocode_session_purges_tenant_status_idx").on(
      t.tenantId,
      t.status,
      t.createdAt,
    ),
    sessionUq: uniqueIndex("ontocode_session_purges_session_uq").on(
      t.tenantId,
      t.sessionId,
    ),
  }),
);

// ─── Helper: full schema export for drizzle() ───────────────────────────────

export const schema = {
  tenants,
  users,
  memberships,
  workflows,
  workflowVersions,
  deployments,
  agents,
  agentVersions,
  agentDrafts,
  agentDraftRevisions,
  events,
  eventListeners,
  agentRunSessions,
  runs,
  steps,
  llmCalls,
  llmCallTelemetry,
  usageEvents,
  runMessages,
  tasks,
  artifacts,
  businessRecords,
  runTraceEvents,
  runEmittedEvents,
  auditLog,
  apiTokens,
  eventTypes,
  entityTypes,
  tenantBudgets,
  llmBudgetReservations,
  meta,
  webhookSubscriptions,
  agentMemoryShort,
  agentMemoryLong,
  idempotencyKeys,
  operationLeases,
  factoryDomainBindings,
  factoryConversations,
  factoryReflections,
  factoryRuns,
  factorySkills,
  factoryTools,
  factorySandboxAttempts,
  factorySandboxToolSnapshots,
  factorySandboxModelGrants,
  factorySandboxModelCallUsage,
  factoryToolProbes,
  factoryIntegrationProfiles,
  factoryAuthorizationChallenges,
  factoryCodeActAuthorizations,
  integrations,
  tenantsRelations,
  workflowsRelations,
  workflowVersionsRelations,
  agentsRelations,
  agentVersionsRelations,
  agentDraftsRelations,
  agentDraftRevisionsRelations,
  agentRunSessionsRelations,
  runsRelations,
  stepsRelations,
  llmCallsRelations,
  usageEventsRelations,
  runMessagesRelations,
  artifactsRelations,
  runTraceEventsRelations,
  runEmittedEventsRelations,
  tasksRelations,
  eventsRelations,
  systemProfiles,
  ontocodeProjects,
  ontocodeSessions,
  ontocodeCommands,
  ontocodeHarnessJobs,
  ontocodeConfigurationTasks,
  ontocodeSessionMessages,
  ontocodeSessionEvents,
  ontocodeChangeSets,
  ontocodeChangeSetOperations,
  ontocodeArtifacts,
  ontocodeArtifactBlobs,
  ontocodeArtifactVersions,
  ontocodeEvidenceRecords,
  ontocodePackageVersions,
  ontocodeCandidateHeads,
  ontocodeAssistantRuns,
  ontocodeAssistantSteps,
  ontocodePinnedContextRefs,
  ontocodeSessionPurges,
};
