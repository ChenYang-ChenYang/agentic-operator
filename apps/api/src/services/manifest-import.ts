/**
 * Manifest import service — the 6-step wizard's backend.
 *
 * Two modes share one pipeline:
 *
 *   validate — runtime migrate → Zod parse → lint → diff vs live. Inserts a
 *              `deployments(status='pending', expires_at=now+1h)` lock row
 *              whose `id` IS the import session token (per review A2). A
 *              second validate for the same tenant finds the lock and the
 *              route returns 423. The DB row holds the manifest in
 *              `workflow_versions.manifest_json` so resume-after-refresh
 *              works without disk staging.
 *
 *   commit   — same pipeline, then four atomic phases per review C1
 *              (see docs/design/import-workflow-manifest.md §"Commit
 *              transaction sequence"):
 *                PHASE 1 — preflight (no IO): migrate + parse + lint + diff
 *                          + apply resolutions + overwrite-guard.
 *                PHASE 2 — write
 *                          `AGENTIC_IMPORTS_DIR/<deployment_id>/workflow.json`
 *                          (and actions.json if present) + fsync.
 *                PHASE 3 — atomic SQLite tx: demote live, upsert
 *                          workflow_versions + deployment (file_path
 *                          pointing at the tmp file), upsert agents +
 *                          agent_versions, replace event_listeners, write
 *                          audit_log row.
 *                PHASE 4 — atomic `fs.rename()` into
 *                          `models/<slug>-vN/workflow_v<N+1>.json`, update
 *                          `deployments.file_path` to the final location,
 *                          re-register Inngest functions.
 *
 *              The order is load-bearing: `bootstrap.ts` rebuilds the
 *              Inngest function set from disk via `composeTenantRegistries`,
 *              so a crash between DB commit and disk rename used to leave
 *              the runtime stale forever (the DB said "new live" while the
 *              file_path pointed at a tmp file the loader never visited).
 *              `reconcileImports` (boot-time) now repairs that case.
 *
 * Observability:
 *   - Every validate / commit / cancel emits an `audit_log` row via the
 *     existing `writeAudit()` helper (per review O1). The `events` table is
 *     the Inngest event ledger and is no longer abused for audit traffic —
 *     a `WORKFLOW_DEPLOYED` row there would route through `event_listeners`
 *     and trigger any agent listening on the name.
 *   - Hot-swap and rename failures emit `manifest.import.fail_swap` /
 *     `.fail_rename` audit rows and `req.log.error` lines (per review O2).
 *
 * better-sqlite3 transactions are *synchronous*. Do not `await` DB calls;
 * wrap any multi-statement work in `db.transaction(() => { ... })()`.
 */

import {
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  agents,
  agentVersions,
  deployments,
  eventListeners,
  factoryCodeActAuthorizations,
  getDb,
  runs,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { eq, and, lt } from "drizzle-orm";
import { canonicalEvidenceJson, makeId } from "@agentic/shared";
import type {
  ManifestImportBody,
  ManifestImportPreview,
  ManifestImportCommit,
  ManifestImportOverwriteRequired,
  ManifestDiff,
  ConflictResolution,
  Conflict,
  Issue,
} from "@agentic/contracts";
// Value (not type) import: WorkflowManifestCompatSchema is a runtime Zod schema
// used below to re-derive the on-disk manifest form exactly as bootstrap does.
import { WorkflowManifestCompatSchema } from "@agentic/contracts";
import {
  WorkflowManifestSchema,
  ActionsManifestSchema,
  migrate,
  tenantSlugFromFolder,
  lint,
  publishStreamEvent,
  isSandboxTenant,
  productionCodeActManifestSha256,
  canonicalWorkflowVersionId,
  legacyWorkflowVersionId,
  workflowVersionContentMatches,
  type LintConflict,
  type LintIssue,
  type LiveWorkflowSnapshot,
  type AgentSpec,
  type WorkflowManifest,
} from "@agentic/runtime";
import { getLLMGateway } from "./llm";
import { reregisterInngest } from "./inngest-registry";
import {
  syncTenantApp,
  verifyTenantAppRegistration,
  type TenantAppRegistrationVerification,
} from "./inngest-sync";
import { writeAudit } from "../plugins/audit";
import type { HistoricalProductionGeneratedAgentAuthorization } from "./agent-factory/production-codeact-authorization";
import {
  findWorkflowSecretPolicyIssues,
  isWorkflowSecretPolicyIssueCode,
} from "./workflow-secret-policy";
import { attachReviewedToolExecutionPolicies } from "./workflow-authoring";

// Overwrite-guard knobs. The compound rule (per review C2 + PRD §"Overwrite
// guard") replaces the single-ratio "≥30% modified" check that under-fired
// on tiny manifests and over-fired on 1-agent flows. Tunable for fleet-wide
// experiments but the defaults match the PRD's worked-example table:
//   priorN=1   → mod≥1 or churn≥3
//   priorN=3   → mod≥1 or churn≥3
//   priorN=10  → mod≥3 or churn≥5
//   priorN=100 → mod≥30 or churn≥50
const OVERWRITE_MOD_RATIO = Number(
  process.env.AGENTIC_OVERWRITE_MOD_RATIO ?? "0.30",
);
const OVERWRITE_CHURN_RATIO = Number(
  process.env.AGENTIC_OVERWRITE_CHURN_RATIO ?? "0.50",
);
const OVERWRITE_MOD_FLOOR = Number(
  process.env.AGENTIC_OVERWRITE_MOD_FLOOR ?? "1",
);
const OVERWRITE_CHURN_FLOOR = Number(
  process.env.AGENTIC_OVERWRITE_CHURN_FLOOR ?? "3",
);

/** Opaque, process-local capability minted only after Agent Factory promotion
 * has verified its immutable human HMAC receipt and replayed regression suite.
 * It cannot cross JSON/HTTP boundaries: copied look-alike objects are rejected
 * by the module-private WeakSet identity check. */
export interface FactoryPromotionImportAuthorization {
  readonly tenantId: string;
  readonly workflowManifestSha256: string;
  readonly candidateManifestHash: string;
  readonly receiptId: string;
  readonly versionId: string;
  readonly selectionHash: string;
  readonly regressionSuiteFingerprint: string;
  readonly authorizedCode: Readonly<Record<string, string>>;
  readonly authorizedAgentManifestSha256: Readonly<Record<string, string>>;
  readonly promotion: Readonly<{
    promotionId: string;
    domain: string;
    artifact: string;
    recordHash: string;
    slugs: readonly string[];
  }>;
}

const factoryPromotionAuthorizations = new WeakSet<object>();

export function createFactoryPromotionImportAuthorization(args: {
  tenantId: string;
  workflow: unknown;
  receiptId: string;
  receiptSignature: string;
  versionId: string;
  selectionHash: string;
  candidateManifestHash: string;
  regressionSuiteFingerprint: string;
  selectedSlugs: string[];
  promotion: {
    promotionId: string;
    tenantId: string;
    domain: string;
    versionId: string;
    artifact: string;
    suiteFingerprint: string;
    reviewReceiptId: string;
    recordHash: string;
    slugs: string[];
  };
}): FactoryPromotionImportAuthorization {
  if (!/^review-[a-f0-9-]{8,80}$/.test(args.receiptId))
    throw new Error("invalid factory review receipt id");
  if (!/^[a-f0-9]{64}$/.test(args.receiptSignature))
    throw new Error("invalid factory review receipt signature");
  if (
    !args.versionId ||
    !args.selectionHash.startsWith("promotion-selection:v1:")
  ) {
    throw new Error("factory promotion identity is incomplete");
  }
  if (!args.regressionSuiteFingerprint.startsWith("regression-suite:v1:")) {
    throw new Error("factory regression replay identity is incomplete");
  }
  const selectedSlugs = [...new Set(args.selectedSlugs)].sort();
  if (
    !selectedSlugs.length ||
    selectedSlugs.length !== args.selectedSlugs.length
  ) {
    throw new Error("factory promotion selection is empty or duplicated");
  }
  if (
    args.promotion.tenantId !== args.tenantId ||
    args.promotion.versionId !== args.versionId ||
    args.promotion.suiteFingerprint !== args.regressionSuiteFingerprint ||
    args.promotion.reviewReceiptId !== args.receiptId ||
    JSON.stringify([...args.promotion.slugs].sort()) !==
      JSON.stringify(selectedSlugs)
  ) {
    throw new Error("factory promotion durable record identity mismatch");
  }
  const migrated = migrate(args.workflow);
  const parsed = WorkflowManifestSchema.safeParse(migrated.payload);
  if (!parsed.success)
    throw new Error("cannot authorize an invalid factory promotion manifest");
  const authorizedCode: Record<string, string> = {};
  const authorizedAgentManifestSha256: Record<string, string> = {};
  const selected = new Set(selectedSlugs);
  const foundSelected = new Set<string>();
  for (const agent of parsed.data) {
    if (!selected.has(agent.id)) continue;
    foundSelected.add(agent.id);
    if (
      agent.generated !== true ||
      agent.factory_domain_id !== args.promotion.domain ||
      agent.factory_target_domain_id !== args.promotion.domain ||
      agent.factory_execution_scope?.kind !== "production" ||
      agent.factory_execution_scope.target_domain_id !==
        args.promotion.domain ||
      agent.factory_promotion_version_id !== args.versionId ||
      agent.factory_regression_suite_fingerprint !==
        args.regressionSuiteFingerprint
    ) {
      throw new Error(
        `factory production generated-Agent provenance mismatch: ${agent.id}`,
      );
    }
    authorizedAgentManifestSha256[agent.id] =
      productionCodeActManifestSha256(agent);
    if (agent.codeExecuted !== true) continue;
    const code = agent.typescript_code;
    const attestation = agent.code_attestation;
    if (!code || attestation?.allow_production !== true) {
      throw new Error(
        `factory production CodeAct attestation is incomplete: ${agent.id}`,
      );
    }
    const actual = crypto
      .createHash("sha256")
      .update(code, "utf8")
      .digest("hex");
    if (attestation.expected_sha256.toLowerCase() !== actual) {
      throw new Error(`factory production CodeAct hash mismatch: ${agent.id}`);
    }
    authorizedCode[agent.id] = actual;
  }
  if (foundSelected.size !== selected.size) {
    throw new Error("factory promotion selection is absent from the workflow");
  }
  const workflowManifestSha256 = productionCodeActManifestSha256(parsed.data);
  if (args.candidateManifestHash !== `manifest:v1:${workflowManifestSha256}`) {
    throw new Error(
      "factory promotion review candidate manifest hash does not match the authorized workflow",
    );
  }
  const authorization: FactoryPromotionImportAuthorization = Object.freeze({
    tenantId: args.tenantId,
    workflowManifestSha256,
    candidateManifestHash: args.candidateManifestHash,
    receiptId: args.receiptId,
    versionId: args.versionId,
    selectionHash: args.selectionHash,
    regressionSuiteFingerprint: args.regressionSuiteFingerprint,
    authorizedCode: Object.freeze({ ...authorizedCode }),
    authorizedAgentManifestSha256: Object.freeze({
      ...authorizedAgentManifestSha256,
    }),
    promotion: Object.freeze({
      promotionId: args.promotion.promotionId,
      domain: args.promotion.domain,
      artifact: args.promotion.artifact,
      recordHash: args.promotion.recordHash,
      slugs: Object.freeze([...selectedSlugs]),
    }),
  });
  factoryPromotionAuthorizations.add(authorization);
  return authorization;
}

function isFactoryPromotionAuthorized(
  authorization: FactoryPromotionImportAuthorization | undefined,
  ctx: TenantCtx,
  workflow: unknown,
): authorization is FactoryPromotionImportAuthorization {
  return Boolean(
    authorization &&
    factoryPromotionAuthorizations.has(authorization) &&
    authorization.tenantId === ctx.tenantId &&
    authorization.workflowManifestSha256 ===
      productionCodeActManifestSha256(
        WorkflowManifestSchema.parse(migrate(workflow).payload),
      ),
  );
}

/**
 * Whether a `generated: true` agent carries Agent-Factory / CodeAct provenance
 * that subjects it to the production promotion gate.
 *
 * The `generated` flag is overloaded: the Agent Factory stamps it on real
 * factory artifacts (CodeAct handlers + ontology-grounded declarative agents
 * that must clear the promotion + regression-replay pipeline), while Agent
 * Studio also stamps it as a benign "derived from a legacy definition" marker
 * on human-authored declarative agents. Only the former needs a promotion
 * receipt. A generated agent that carries no executable `typescript_code`, no
 * CodeAct attestation, and no `factory_*` identity has no more capability than
 * any hand-authored declarative agent an operator could write directly (it runs
 * through the same declarative step-engine path), so quarantining it adds no
 * security value and would wrongly block the internal Agent Studio publish path.
 */
function generatedAgentCarriesFactoryProvenance(
  agent: WorkflowManifest[number],
): boolean {
  const a = agent as Record<string, unknown> & {
    codeExecuted?: unknown;
    typescript_code?: unknown;
    code_attestation?: unknown;
  };
  if (a.codeExecuted === true) return true;
  if (
    typeof a.typescript_code === "string" &&
    a.typescript_code.trim().length > 0
  ) {
    return true;
  }
  if (a.code_attestation != null) return true;
  // Any Agent-Factory identity field (domain, execution scope, promotion
  // version, regression fingerprint, contract/tool provenance, …) marks a real
  // factory artifact that must clear promotion even when it carries no code.
  return Object.entries(a).some(
    ([key, value]) => key.startsWith("factory_") && value != null,
  );
}

/** Pure production generated-Agent gate used by the import pipeline and focused
 * tests. Both CodeAct and declarative generated functions require the exact
 * Factory promotion capability or independently verified historical evidence. */
export function productionGeneratedAgentImportIssues(args: {
  manifest: WorkflowManifest;
  rawWorkflow: unknown;
  ctx: TenantCtx;
  authorization?: FactoryPromotionImportAuthorization;
  historicalAuthorizedAgentManifestSha256?: Readonly<Record<string, string>>;
}): Issue[] {
  const issues: Issue[] = [];
  const trustedFactoryPromotion = isFactoryPromotionAuthorized(
    args.authorization,
    args.ctx,
    args.rawWorkflow,
  );
  args.manifest.forEach((agent, index) => {
    if (agent.generated !== true) return;
    // Only real factory artifacts (generated code / CodeAct attestation /
    // `factory_*` identity) are subject to the promotion gate. A bare
    // declarative generated agent — e.g. an Agent Studio definition derived
    // from a legacy agent — is not, and must not be blocked here.
    if (!generatedAgentCarriesFactoryProvenance(agent)) return;
    let codeSha256: string | undefined;
    if (agent.codeExecuted === true) {
      const code = agent.typescript_code;
      const attestation = agent.code_attestation;
      if (!code || attestation?.allow_production !== true) {
        issues.push({
          path: `agents.${index}.code_attestation`,
          message:
            "production generated code requires an exact structured code_attestation",
          severity: "error",
          code: "production_generated_code_attestation_missing",
        });
        return;
      }
      codeSha256 = crypto
        .createHash("sha256")
        .update(code, "utf8")
        .digest("hex");
      if (attestation.expected_sha256.toLowerCase() !== codeSha256) {
        issues.push({
          path: `agents.${index}.code_attestation.expected_sha256`,
          message:
            "code_attestation expected_sha256 does not match exact typescript_code bytes",
          severity: "error",
          code: "production_generated_code_hash_mismatch",
        });
        return;
      }
    }
    const agentManifestSha256 = productionCodeActManifestSha256(agent);
    const selectedAuthorized =
      trustedFactoryPromotion &&
      args.authorization!.authorizedAgentManifestSha256[agent.id] ===
        agentManifestSha256 &&
      (agent.codeExecuted !== true ||
        args.authorization!.authorizedCode[agent.id] === codeSha256);
    const historicalAuthorized =
      args.historicalAuthorizedAgentManifestSha256?.[agent.id] ===
      agentManifestSha256;
    if (!selectedAuthorized && !historicalAuthorized) {
      issues.push({
        path: agent.codeExecuted === true
          ? `agents.${index}.code_attestation`
          : `agents.${index}.factory_promotion_version_id`,
        message:
          "production generated Agent is not backed by the verified Agent Factory promotion receipt and regression replay",
        severity: "error",
        code: agent.codeExecuted === true
          ? "production_generated_code_attestation_untrusted"
          : "production_generated_agent_promotion_untrusted",
      });
    }
  });
  return issues;
}

/** @deprecated Use productionGeneratedAgentImportIssues. */
export const productionGeneratedCodeImportIssues =
  productionGeneratedAgentImportIssues;

function factoryCodeActAuthorizationRows(args: {
  ctx: TenantCtx;
  authorization: FactoryPromotionImportAuthorization;
  historical: Readonly<
    Record<string, HistoricalProductionGeneratedAgentAuthorization>
  >;
  deploymentId: string;
  workflowVersionId: string;
}): Array<typeof factoryCodeActAuthorizations.$inferInsert> {
  const activation = {
    workflowManifestSha256: args.authorization.workflowManifestSha256,
    deploymentId: args.deploymentId,
    workflowVersionId: args.workflowVersionId,
    activationPromotionId: args.authorization.promotion.promotionId,
    activationDomainId: args.authorization.promotion.domain,
    activationVersionId: args.authorization.versionId,
    activationReviewReceiptId: args.authorization.receiptId,
    activationReviewSelectionHash: args.authorization.selectionHash,
    activationPromotionRecordHash: args.authorization.promotion.recordHash,
    status: "committed" as const,
  };
  const selected = Object.entries(
    args.authorization.authorizedAgentManifestSha256,
  ).map(
    ([agentSlug, agentManifestSha256]) => ({
      id: `fca-${crypto.randomUUID()}`,
      promotionId: args.authorization.promotion.promotionId,
      tenantId: args.ctx.tenantId,
      tenantSlug: args.ctx.tenantSlug,
      domainId: args.authorization.promotion.domain,
      agentSlug,
      promotionVersionId: args.authorization.versionId,
      regressionSuiteFingerprint: args.authorization.regressionSuiteFingerprint,
      // Legacy column name: CodeAct stores the exact handler hash; a
      // declarative generated Agent stores its exact manifest hash. The
      // verifier binds the latter to reviewed spec/module evidence.
      codeSha256:
        args.authorization.authorizedCode[agentSlug] ?? agentManifestSha256,
      agentManifestSha256,
      reviewReceiptId: args.authorization.receiptId,
      reviewSelectionHash: args.authorization.selectionHash,
      regressionArtifact: args.authorization.promotion.artifact,
      promotionRecordHash: args.authorization.promotion.recordHash,
      ...activation,
    }),
  );
  const historical = Object.values(args.historical).map((evidence) => ({
    id: `fca-${crypto.randomUUID()}`,
    promotionId: evidence.evidencePromotionId,
    tenantId: evidence.tenantId,
    tenantSlug: evidence.tenantSlug,
    domainId: evidence.domainId,
    agentSlug: evidence.agentSlug,
    promotionVersionId: evidence.promotionVersionId,
    regressionSuiteFingerprint: evidence.regressionSuiteFingerprint,
    codeSha256: evidence.codeSha256,
    agentManifestSha256: evidence.agentManifestSha256,
    reviewReceiptId: evidence.evidenceReviewReceiptId,
    reviewSelectionHash: evidence.evidenceReviewSelectionHash,
    regressionArtifact: evidence.regressionArtifact,
    promotionRecordHash: evidence.evidencePromotionRecordHash,
    ...activation,
  }));
  return [...selected, ...historical];
}

const PENDING_TTL_MS = Number(
  process.env.AGENTIC_IMPORT_PENDING_TTL_MS ?? String(60 * 60 * 1000),
);
const CONCURRENCY_MAX = Number(process.env.RUNTIME_CONCURRENCY_MAX ?? "8");

/**
 * Required fsync helper. The async `writeFile` resolves once the kernel
 * has accepted the bytes; a crash before fsync can lose them. Open the path
 * synchronously (we just wrote it), fsync, close. A deployment cannot claim
 * its staging phase succeeded when the filesystem rejected durability.
 */
function fsyncRequired(filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Persist directory-entry changes made by rename/unlink, not just file bytes. */
function fsyncDirectoryRequired(dirPath: string): void {
  const fd = openSync(dirPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class OverwriteRequiredError extends Error {
  constructor(public readonly payload: ManifestImportOverwriteRequired) {
    super("overwrite_required");
    this.name = "OverwriteRequiredError";
  }
}

export class BlockingIssuesError extends Error {
  constructor(public readonly issues: Issue[]) {
    super("blocking_issues");
    this.name = "BlockingIssuesError";
  }
}

/**
 * Thrown when a second `validate` collides with an existing pending lock.
 * The route maps this to HTTP 423 with the in-flight `deployment_id`.
 * Per review A2 the in-flight identifier is the `dpl-` id — there is no
 * separate `imp-` session prefix.
 */
export class PendingImportConflictError extends Error {
  constructor(public readonly deploymentId: string) {
    super("pending_import_in_flight");
    this.name = "PendingImportConflictError";
  }
}

/** The tenant live lane changed after this import captured its pre-image. */
export class ManifestImportConcurrencyConflictError extends Error {
  readonly code = "manifest_import_live_deployment_changed";
  readonly statusCode = 409;

  constructor(message = "manifest_import_live_deployment_changed") {
    super(message);
    this.name = "ManifestImportConcurrencyConflictError";
  }
}

/** A pending two-phase import row is missing, expired, or bound to another
 * workflow. The route maps `reason` onto a stable client-facing error. */
export class InvalidPendingImportError extends Error {
  constructor(
    public readonly reason: "not_found" | "expired" | "workflow_mismatch",
    public readonly deploymentId: string,
  ) {
    super(`pending_import_${reason}`);
    this.name = "InvalidPendingImportError";
  }
}

export interface TenantCtx {
  /** Internal tenants.id PK (e.g. `ten-…`). */
  tenantId: string;
  /** Tenant slug used in event namespacing, models folder, paths. */
  tenantSlug: string;
  /** Optional workflow identity used by the legacy /v1/agents deploy surface. */
  workflowSlug?: string;
  /**
   * Narrow internal validation mode for a nonce Factory sandbox whose every
   * generated function executes exact reviewed TypeScript bytes. Public
   * manifest routes never set this flag; runPipeline re-validates the whole
   * manifest shape before it may avoid constructing a production LLM gateway.
   */
  manifestValidationMode?: "sandbox_exact_code";
}

function workflowSlugFor(ctx: TenantCtx): string {
  return ctx.workflowSlug ?? `${ctx.tenantSlug}-default`;
}

/** Workflow identity for authoring flows: explicit body slug wins, then the
 * route-supplied ctx.workflowSlug, then the per-tenant default lane. */
function authoringWorkflowSlug(
  input: Pick<ManifestImportBody, "workflow_slug">,
  ctx: TenantCtx,
): string {
  return input.workflow_slug ?? workflowSlugFor(ctx);
}

function authoringWorkflowName(
  input: Pick<ManifestImportBody, "workflow_slug" | "workflow_name">,
  ctx: TenantCtx,
): string {
  return input.workflow_name ?? authoringWorkflowSlug(input, ctx);
}

/**
 * Optional audit context — when present the service emits structured error
 * logs via the route's pino logger so the SRE pipeline can correlate
 * disk-write / hot-swap failures with the audit_log row. Untyped because
 * services should not depend on `FastifyBaseLogger`.
 */
export interface AuditCtx {
  log?: {
    error: (obj: Record<string, unknown>, msg?: string) => void;
    info?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  actorUserId?: string;
}

/**
 * `writeAudit` may throw if the DB is closed (test teardown). Audit is
 * best-effort so we never want a logging failure to mask the real error.
 */
function writeAuditSafely(
  auditCtx: AuditCtx | undefined,
  entry: Parameters<typeof writeAudit>[0],
): void {
  try {
    writeAudit({
      ...entry,
      actorUserId: entry.actorUserId ?? auditCtx?.actorUserId,
    });
  } catch (err) {
    auditCtx?.log?.error?.(
      { err: (err as Error).message, action: entry.action },
      "audit write failed",
    );
  }
}

/**
 * Manifest deployment is a supervised operation. If its durable audit row
 * cannot be written, fail visibly instead of returning an untraceable success.
 */
function writeAuditRequired(
  auditCtx: AuditCtx | undefined,
  entry: Parameters<typeof writeAudit>[0],
): void {
  try {
    writeAudit({
      ...entry,
      actorUserId: entry.actorUserId ?? auditCtx?.actorUserId,
    });
  } catch (err) {
    auditCtx?.log?.error?.(
      { err: (err as Error).message, action: entry.action },
      "audit write failed",
    );
    throw new Error(`required audit write failed for ${entry.action}`, {
      cause: err,
    });
  }
}

/** Resolve the configured, durable import-staging directory. */
function importsRoot(): string {
  return process.env.AGENTIC_IMPORTS_DIR
    ? process.env.AGENTIC_IMPORTS_DIR
    : path.join(process.env.AGENTIC_DATA_DIR ?? "./data", "imports");
}

function modelsRoot(): string {
  const env = process.env.AGENTIC_MODELS_DIR;
  if (!env) {
    throw new Error(
      "AGENTIC_MODELS_DIR is not set — the api process must point at a models directory.",
    );
  }
  return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
}

type WorkflowRow = typeof workflows.$inferSelect;
type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type AgentVersionRow = typeof agentVersions.$inferSelect;
type EventListenerRow = typeof eventListeners.$inferSelect;

/**
 * Durable state that phase 3 is allowed to mutate before the runtime broker
 * has accepted the new manifest. A hot-swap is a distributed transaction
 * across SQLite, the models directory, the in-process registry, and Inngest;
 * keeping this complete pre-image lets the failure path restore the last-good
 * database view instead of leaving a deployment marked live when it never
 * became runnable.
 */
interface ManifestImportPreimage {
  workflow: WorkflowRow | null;
  workflowVersions: WorkflowVersionRow[];
  deployments: DeploymentRow[];
  agents: AgentRow[];
  agentVersions: AgentVersionRow[];
  eventListeners: EventListenerRow[];
}

function captureManifestImportPreimage(ctx: TenantCtx): ManifestImportPreimage {
  const db = getDb();
  const workflow =
    db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, ctx.tenantId),
          eq(workflows.slug, workflowSlugFor(ctx)),
        ),
      )
      .all()[0] ?? null;
  const workflowRows = workflow
    ? db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflow.id))
        .all()
    : [];
  const agentRows = workflow
    ? db.select().from(agents).where(eq(agents.workflowId, workflow.id)).all()
    : [];
  const versionRows: AgentVersionRow[] = [];
  const listenerRows: EventListenerRow[] = [];
  for (const agent of agentRows) {
    versionRows.push(
      ...db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agent.id))
        .all(),
    );
    listenerRows.push(
      ...db
        .select()
        .from(eventListeners)
        .where(eq(eventListeners.agentId, agent.id))
        .all(),
    );
  }
  return {
    workflow,
    workflowVersions: workflowRows,
    deployments: db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, ctx.tenantId),
          eq(deployments.target, "workflow"),
        ),
      )
      .all(),
    agents: agentRows,
    agentVersions: versionRows,
    eventListeners: listenerRows,
  };
}

interface DatabaseRestoreResult {
  retainedReferencedAgentVersions: string[];
}

function assertDeploymentOwnsLiveLane(
  ctx: TenantCtx,
  deploymentId: string,
  workflowVersionId?: string,
): void {
  const live = getDb()
    .select({ id: deployments.id, versionId: deployments.versionId })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
      ),
    )
    .all();
  if (
    live.length !== 1 ||
    live[0]!.id !== deploymentId ||
    (workflowVersionId !== undefined &&
      live[0]!.versionId !== workflowVersionId)
  ) {
    throw new ManifestImportConcurrencyConflictError(
      "manifest import deployment no longer owns the live lane",
    );
  }
}

function assertLiveDeploymentBaseline(
  ctx: TenantCtx,
  baselineDeployments: readonly Pick<
    DeploymentRow,
    "id" | "versionId" | "status"
  >[],
): void {
  const baselineLive = baselineDeployments
    .filter((row) => row.status === "live")
    .map((row) => ({ id: row.id, versionId: row.versionId }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const currentLive = getDb()
    .select({ id: deployments.id, versionId: deployments.versionId })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
      ),
    )
    .all()
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    canonicalEvidenceJson(currentLive) !== canonicalEvidenceJson(baselineLive)
  ) {
    throw new ManifestImportConcurrencyConflictError();
  }
}

/**
 * Restore the complete pre-import database view in one SQLite transaction.
 * Rows created solely by the failed attempt remain as non-live history where
 * deleting them would weaken the audit trail; newly-created agents are
 * disabled and cannot be invoked. Agent-version rows accidentally attached to
 * a previously-live workflow version are removed unless a concurrent run
 * already references one, in which case the immutable execution evidence wins
 * and the disabled agent keeps it quarantined from future dispatch.
 */
function restoreManifestImportPreimage(args: {
  ctx: TenantCtx;
  preimage: ManifestImportPreimage;
  failedWorkflowId: string;
  failedDeploymentId: string;
}): DatabaseRestoreResult {
  const { ctx, preimage, failedWorkflowId, failedDeploymentId } = args;
  const db = getDb();
  const retainedReferencedAgentVersions: string[] = [];

  db.transaction(() => {
    assertDeploymentOwnsLiveLane(ctx, failedDeploymentId);
    if (preimage.workflow) {
      const existing = db
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.id, preimage.workflow.id))
        .all()[0];
      if (existing) {
        db.update(workflows)
          .set({
            tenantId: preimage.workflow.tenantId,
            slug: preimage.workflow.slug,
            name: preimage.workflow.name,
            createdAt: preimage.workflow.createdAt,
          })
          .where(eq(workflows.id, preimage.workflow.id))
          .run();
      } else {
        db.insert(workflows).values(preimage.workflow).run();
      }
    }

    // Workflow versions must exist before deployments and agent versions can
    // be restored because both tables carry foreign keys to them.
    for (const row of preimage.workflowVersions) {
      const existing = db
        .select({ id: workflowVersions.id })
        .from(workflowVersions)
        .where(eq(workflowVersions.id, row.id))
        .all()[0];
      if (existing) {
        db.update(workflowVersions)
          .set({
            workflowId: row.workflowId,
            version: row.version,
            manifestJson: row.manifestJson,
            actionsJson: row.actionsJson,
            createdAt: row.createdAt,
            createdBy: row.createdBy,
          })
          .where(eq(workflowVersions.id, row.id))
          .run();
      } else {
        db.insert(workflowVersions).values(row).run();
      }
    }

    const deploymentPreimageById = new Map(
      preimage.deployments.map((row) => [row.id, row] as const),
    );
    const currentDeployments = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, ctx.tenantId),
          eq(deployments.target, "workflow"),
        ),
      )
      .all();
    for (const row of currentDeployments) {
      const prior = deploymentPreimageById.get(row.id);
      if (prior) {
        // The live lane has a partial unique index on (tenant_id, target).
        // A promoted pending row is currently live here, so restore its
        // non-live status before attempting to reactivate the prior live row.
        if (row.status === "live" && prior.status !== "live") {
          db.update(deployments)
            .set({ status: prior.status })
            .where(eq(deployments.id, row.id))
            .run();
        }
        continue;
      }
      db.update(deployments)
        .set({
          status: "rolled_back",
          expiresAt: null,
          filePath: null,
          note:
            (row.note ? `${row.note}; ` : "") +
            "auto: failed runtime hot-swap compensated",
        })
        .where(eq(deployments.id, row.id))
        .run();
    }
    // Restore non-live rows first and the single live row last. This ordering
    // keeps the partial live-lane unique constraint satisfied throughout the
    // transaction, including pending-promotion compensation.
    const orderedDeployments = [...preimage.deployments].sort((a, b) =>
      a.status === b.status ? 0 : a.status === "live" ? 1 : -1,
    );
    for (const row of orderedDeployments) {
      const existing = db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.id, row.id))
        .all()[0];
      if (existing) {
        db.update(deployments)
          .set({
            tenantId: row.tenantId,
            target: row.target,
            versionId: row.versionId,
            status: row.status,
            deployedBy: row.deployedBy,
            deployedAt: row.deployedAt,
            note: row.note,
            expiresAt: row.expiresAt,
            filePath: row.filePath,
          })
          .where(eq(deployments.id, row.id))
          .run();
      } else {
        db.insert(deployments).values(row).run();
      }
    }

    const workflowId = preimage.workflow?.id ?? failedWorkflowId;
    const agentIds = new Set(preimage.agents.map((row) => row.id));
    const currentAgents = db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, workflowId))
      .all();
    for (const row of currentAgents) {
      if (agentIds.has(row.id)) continue;
      db.update(agents)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(agents.id, row.id))
        .run();
    }
    for (const row of preimage.agents) {
      const existing = db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, row.id))
        .all()[0];
      if (existing) {
        db.update(agents)
          .set({
            workflowId: row.workflowId,
            kebabId: row.kebabId,
            name: row.name,
            title: row.title,
            actor: row.actor,
            kind: row.kind,
            enabled: row.enabled,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .where(eq(agents.id, row.id))
          .run();
      } else {
        db.insert(agents).values(row).run();
      }
    }

    const versionIds = new Set(preimage.agentVersions.map((row) => row.id));
    const preimageWorkflowVersionIds = new Set(
      preimage.workflowVersions.map((row) => row.id),
    );
    const restoredAndCurrentAgents = db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workflowId, workflowId))
      .all();
    for (const agent of restoredAndCurrentAgents) {
      const currentVersions = db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agent.id))
        .all();
      for (const row of currentVersions) {
        if (
          versionIds.has(row.id) ||
          !preimageWorkflowVersionIds.has(row.workflowVersionId)
        ) {
          continue;
        }
        const referenced = db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.agentVersionId, row.id))
          .limit(1)
          .all()[0];
        if (referenced) {
          retainedReferencedAgentVersions.push(row.id);
        } else {
          db.delete(agentVersions).where(eq(agentVersions.id, row.id)).run();
        }
      }
    }
    for (const row of preimage.agentVersions) {
      const existing = db
        .select({ id: agentVersions.id })
        .from(agentVersions)
        .where(eq(agentVersions.id, row.id))
        .all()[0];
      if (existing) {
        db.update(agentVersions)
          .set({
            agentId: row.agentId,
            workflowVersionId: row.workflowVersionId,
            manifestJson: row.manifestJson,
          })
          .where(eq(agentVersions.id, row.id))
          .run();
      } else {
        db.insert(agentVersions).values(row).run();
      }
    }

    // Listener replacement is an exact set restoration, including removal of
    // listeners created for agents that are now quarantined/disabled.
    for (const agent of restoredAndCurrentAgents) {
      db.delete(eventListeners)
        .where(eq(eventListeners.agentId, agent.id))
        .run();
    }
    for (const row of preimage.eventListeners) {
      db.insert(eventListeners).values(row).run();
    }

    const failed = db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, failedDeploymentId))
      .all()[0];
    if (failed?.status === "live") {
      throw new Error(
        `compensation invariant failed: deployment ${failedDeploymentId} is still live`,
      );
    }
    const liveCount = db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, ctx.tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all().length;
    const expectedLiveCount = preimage.deployments.filter(
      (row) => row.status === "live",
    ).length;
    if (liveCount !== expectedLiveCount) {
      throw new Error(
        `compensation invariant failed: expected ${expectedLiveCount} live workflow deployment(s), found ${liveCount}`,
      );
    }
  });

  return { retainedReferencedAgentVersions };
}

// (Per review O4: the NDJSON import log under
// `data/logs/<tenant>/imports/<date>.ndjson` was the v0 observability
// surface. It's removed in favour of `audit_log` rows with
// `action LIKE 'manifest.import.%'`. `GET /v1/audit-log?action=…` is the
// canonical read path; operators don't need shell access to inspect
// import history.)

/** Find tenant model dirs (mirrors workflowRoutes#findTenantDirs). */
async function findTenantDirs(
  slug: string,
): Promise<Array<{ folder: string; version: number; absDir: string }>> {
  const root = modelsRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`models root does not exist: ${root}`, { cause: error });
    }
    throw error;
  }
  const matches: Array<{ folder: string; version: number; absDir: string }> =
    [];
  for (const folder of entries) {
    if (folder.startsWith(".")) continue;
    const abs = path.join(root, folder);
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!isDir) continue;
    if (tenantSlugFromFolder(folder) !== slug) continue;
    const m = folder.match(/-v(\d+)$/i);
    const version = m ? Number(m[1]) : 1;
    matches.push({ folder, version, absDir: abs });
  }
  matches.sort((a, b) => b.version - a.version);
  return matches;
}

/**
 * B3 (sandbox teardown GC) — physically remove ALL versioned model folders for a
 * slug (`models/<slug>-v*`). Sandbox teardown calls this so a torn-down `-sb`
 * tenant stops being re-discovered by `bootstrapAllByTenant` on the next boot (a
 * lingering folder is the ROOT reason zombie sandbox apps reappear). Co-located
 * here so the models-dir layout stays single-sourced with the rest of import.
 * Returns the folders it removed. Removal is part of the teardown contract: an
 * unremovable directory must fail the caller so the sandbox is not reported as
 * deleted while its deployable source is still discoverable at the next boot.
 */
export async function removeTenantModelDirs(slug: string): Promise<string[]> {
  const dirs = await findTenantDirs(slug);
  const removed: string[] = [];
  for (const d of dirs) {
    await rm(d.absDir, { recursive: true, force: true });
    removed.push(d.folder);
  }
  return removed;
}

async function pickNextVersion(
  dir: string,
  prefix: "workflow" | "actions",
): Promise<{ filename: string; nextVersion: number }> {
  const files = await readdir(dir);
  let max = 0;
  const re = new RegExp(`^${prefix}(?:_v(\\d+))?\\.json$`, "i");
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const v = m[1] ? Number(m[1]) : 1;
    if (v > max) max = v;
  }
  const next = max + 1;
  return { filename: `${prefix}_v${next}.json`, nextVersion: next };
}

// ---- Diff -----------------------------------------------------------------

/**
 * Compare two manifests by `id`. JSON-stringify equality for "modified".
 * Order-insensitive; doesn't diff actions.json.
 */
export function diffManifests(
  prior: ReadonlyArray<AgentSpec> | ReadonlyArray<{ id: string }>,
  next: ReadonlyArray<AgentSpec> | ReadonlyArray<{ id: string }>,
  priorVersionString: string | null,
): ManifestDiff {
  const priorMap = new Map<string, string>();
  const nextMap = new Map<string, string>();
  for (const a of prior) priorMap.set(a.id, JSON.stringify(a));
  for (const a of next) nextMap.set(a.id, JSON.stringify(a));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [id, json] of nextMap) {
    const oldJson = priorMap.get(id);
    if (!oldJson) added.push(id);
    else if (oldJson !== json) modified.push(id);
  }
  for (const id of priorMap.keys()) {
    if (!nextMap.has(id)) removed.push(id);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    prior_version: priorVersionString,
  };
}

// ---- Lint adapter ---------------------------------------------------------

/**
 * Convert runtime LintIssue/Conflict (plain TS shape) to the contract
 * Zod-validated shape. Identity copy; the divergence is purely at the type
 * boundary — runtime can't import @agentic/contracts.
 */
function adaptIssues(issues: ReadonlyArray<LintIssue>): Issue[] {
  return issues.map((i) => ({
    path: i.path,
    message: i.message,
    severity: i.severity,
    code: i.code,
  }));
}
function adaptConflicts(conflicts: ReadonlyArray<LintConflict>): Conflict[] {
  return conflicts.map((c) => ({
    path: c.path,
    type: c.type,
    severity: c.severity,
    detail: c.detail,
    suggestion: c.suggestion,
    auto_fix: c.auto_fix
      ? {
          path: c.auto_fix.path,
          action: c.auto_fix.action,
          override_value: c.auto_fix.override_value,
        }
      : undefined,
  }));
}

// ---- Resolutions ----------------------------------------------------------

/**
 * Walk a JSON pointer of the form `agents[3].trigger[0]` against the bare
 * manifest array. Returns `{ obj, key }` for the *parent* of the leaf so
 * the caller can mutate `obj[key]`. Returns null for unresolvable paths.
 */
const FORBIDDEN_RESOLUTION_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function parseResolutionPath(pointer: string): Array<string | number> | null {
  if (!pointer || pointer.length > 1_024) return null;
  const tokens: Array<string | number> = [];
  for (const segment of pointer.split(".")) {
    const match = segment.match(
      /^([A-Za-z_$][A-Za-z0-9_$-]*)((?:\[(?:0|[1-9]\d*)\])*)$/,
    );
    if (!match || FORBIDDEN_RESOLUTION_KEYS.has(match[1]!)) return null;
    tokens.push(match[1]!);
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g)) {
      const value = Number(index[1]);
      if (!Number.isSafeInteger(value)) return null;
      tokens.push(value);
    }
  }
  return tokens;
}

function resolveJsonPath(
  manifest: WorkflowManifest,
  pointer: string,
): { obj: Record<string, unknown> | unknown[]; key: string | number } | null {
  const tokens = parseResolutionPath(pointer);
  if (!tokens || tokens.length === 0) return null;
  let cur: unknown = { agents: manifest };
  let parent: unknown = null;
  let parentKey: string | number = "";
  for (const token of tokens) {
    parent = cur;
    if (typeof token === "number") {
      parentKey = token;
      if (!Array.isArray(cur)) return null;
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return null;
      cur = cur[token];
    } else {
      parentKey = token;
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return null;
      cur = (cur as Record<string, unknown>)[token];
    }
    if (cur === undefined && tokens.indexOf(token) < tokens.length - 1)
      return null;
  }
  if (!parent || typeof parent !== "object") return null;
  return {
    obj: parent as Record<string, unknown> | unknown[],
    key: parentKey,
  };
}

/**
 * Mutate manifest in place per the operator's resolutions.
 *
 *   - `accept_suggestion` with `override_value=null` ⇒ drop the leaf (or
 *      delete the array element). The auto-fix encodes the intent.
 *   - `accept_suggestion` with a non-null `override_value` ⇒ set the leaf.
 *   - `skip` ⇒ drop the entire agent at the path's `agents[N]` prefix
 *      (matches the wizard's "Skip agent · don't import" label). For
 *      structural blockers like `orphan_actor` there is no per-field fix —
 *      skipping the conflict only makes sense if the agent is removed
 *      from the import, otherwise the re-lint at commit time reproduces
 *      the same blocker and the deploy is refused. Resolutions whose path
 *      doesn't start with `agents[N]` are ignored on skip (no agent to
 *      drop).
 *   - `override` ⇒ set the leaf to `override_value` (operator-chosen).
 *
 * Non-skip mutations are applied first against the cloned manifest so the
 * `agents[N]` indices in their paths still resolve. Skipped agents are
 * removed in a second pass, highest-index-first, so the splice doesn't
 * shift indices the first pass relied on.
 */
export function applyResolutions(
  manifest: WorkflowManifest,
  resolutions: ReadonlyArray<ConflictResolution>,
): { manifest: WorkflowManifest; appliedPaths: string[] } {
  // Copy first to keep the original input pristine. Deep-clone via JSON
  // is fine here: manifest is plain JSON.
  const cloned = JSON.parse(JSON.stringify(manifest)) as WorkflowManifest;
  const applied: string[] = [];

  // Pass 1 — apply accept_suggestion / override. Skip resolutions are
  // deferred so the per-field mutations below all see the original
  // `agents[N]` index space.
  const skipAgentIndices = new Set<number>();
  for (const r of resolutions) {
    if (r.action === "skip") {
      const tokens = parseResolutionPath(r.path);
      const index = tokens?.[0] === "agents" ? tokens[1] : undefined;
      if (typeof index === "number" && index >= 0 && index < cloned.length) {
        skipAgentIndices.add(index);
        applied.push(r.path);
      }
      continue;
    }
    const target = resolveJsonPath(cloned, r.path);
    if (!target) continue;
    const value =
      r.action === "accept_suggestion" || r.action === "override"
        ? r.override_value
        : undefined;
    if (Array.isArray(target.obj)) {
      const idx = Number(target.key);
      if (value === null || value === undefined) {
        target.obj.splice(idx, 1);
      } else {
        target.obj[idx] = value;
      }
    } else {
      const key = String(target.key);
      if (value === null || value === undefined) {
        delete (target.obj as Record<string, unknown>)[key];
      } else {
        (target.obj as Record<string, unknown>)[key] = value;
      }
    }
    applied.push(r.path);
  }

  // Pass 2 — drop skipped agents. High-to-low so earlier splices don't
  // shift the indices later splices rely on.
  const sortedDrops = Array.from(skipAgentIndices).sort((a, b) => b - a);
  for (const idx of sortedDrops) {
    if (idx >= 0 && idx < cloned.length) {
      cloned.splice(idx, 1);
    }
  }

  return { manifest: cloned, appliedPaths: applied };
}

// ---- Live snapshot --------------------------------------------------------

interface LiveSnapshot {
  versionString: string | null;
  agents: AgentSpec[];
  liveDeploymentId: string | null;
  workflowId: string;
  workflowVersionId: string | null;
}

function loadLiveSnapshot(ctx: TenantCtx): LiveSnapshot {
  const db = getDb();
  // The bootstrap path uses a per-tenant workflow slug `${tenantSlug}-default`.
  // Look it up here; an absent workflow means a first-time tenant (no prior live).
  const workflowSlug = workflowSlugFor(ctx);
  const wf = db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, ctx.tenantId),
        eq(workflows.slug, workflowSlug),
      ),
    )
    .all()[0];
  if (!wf) {
    return {
      versionString: null,
      agents: [],
      liveDeploymentId: null,
      workflowId: "",
      workflowVersionId: null,
    };
  }
  const liveRow = db
    .select({
      depId: deployments.id,
      versionId: deployments.versionId,
      version: workflowVersions.version,
      manifestJson: workflowVersions.manifestJson,
      workflowId: workflows.id,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
        eq(workflowVersions.workflowId, wf.id),
      ),
    )
    .all()[0];
  const storedManifest = liveRow?.manifestJson;
  const storedAgents = Array.isArray(storedManifest)
    ? (storedManifest as AgentSpec[])
    : storedManifest &&
        typeof storedManifest === "object" &&
        Array.isArray((storedManifest as { agents?: unknown }).agents)
      ? (storedManifest as { agents: AgentSpec[] }).agents
      : [];
  return {
    versionString: liveRow?.version ?? null,
    agents: storedAgents,
    liveDeploymentId: liveRow?.depId ?? null,
    workflowId: liveRow?.workflowId ?? "",
    workflowVersionId: liveRow?.versionId ?? null,
  };
}

/** The tenant's current LIVE workflow agents (the raw committed manifest array). Exported
 *  for the factory's draft-promotion merge: promoting agents must be ADDITIVE — keep all of
 *  the tenant's existing agents and only add/replace by id — never clobber the live workflow
 *  the way a throwaway sandbox tenant can be replaced. Empty array for a first-time tenant. */
export function loadLiveManifest(ctx: TenantCtx): unknown[] {
  return loadLiveSnapshot(ctx).agents as unknown[];
}

function liveSnapshotForLint(live: LiveSnapshot): LiveWorkflowSnapshot {
  const events = new Set<string>();
  for (const a of live.agents) {
    for (const ev of a.triggered_event ?? []) events.add(ev);
  }
  return {
    agents: live.agents.map((a) => ({
      id: a.id,
      name: a.name,
      trigger: a.trigger ?? [],
      triggered_event: a.triggered_event ?? [],
    })),
    events: [...events],
  };
}

// ---- Pipeline -------------------------------------------------------------

interface PipelineResult {
  /**
   * Canonical (Zod-parsed + strip-unknown) form of the manifest. This is
   * what gets persisted into `workflow_versions.manifest_json` and written
   * to disk; the runtime bootstrap rehydrates from exactly this shape, so
   * hashing this is what produces the `auto-<hash>` version string that
   * matches subsequent bootstrap passes.
   */
  migrated: WorkflowManifest;
  /**
   * Full object written to workflow_versions and disk. V2 workflow-envelope
   * metadata (for example authoring lineage and description) must survive
   * publication even though runtime reconciliation iterates the bare agents.
   */
  persistedManifest: unknown;
  /**
   * Enriched form: parsed manifest + any non-canonical extra fields the
   * fixture carried (e.g. `model`, `concurrency`, `tool_use`). The linter
   * inspects this so it can flag `model_not_configured` etc., even though
   * the canonical form drops those fields.
   */
  forLint: WorkflowManifest;
  actions: unknown[] | undefined;
  issues: Issue[];
  conflicts: Conflict[];
  diff: ManifestDiff;
  prior: LiveSnapshot;
  schemaVersion: number;
  /** Evidence rows for unchanged generated agents. Each will be copied into a
   * fresh activation row for this deployment; the old row is never reused. */
  historicalCodeActAuthorizations: Readonly<
    Record<string, HistoricalProductionGeneratedAgentAuthorization>
  >;
}

type ManifestProviderRow = { id: string; hasKey: boolean };

/**
 * Resolve the provider catalog used only by manifest linting. An exact-code
 * Factory sandbox has no model field and its runtime path is CodeAct-only, so
 * forcing production LLM credentials into that isolated workload would cross
 * the trust boundary without improving the verdict. The exemption is accepted
 * only when every agent independently proves the nonce sandbox + exact-code
 * shape; mixed/declarative manifests still construct and validate the real
 * gateway exactly as before.
 */
export function manifestLintProviderIds(
  manifest: WorkflowManifest,
  ctx: Pick<TenantCtx, "manifestValidationMode">,
  discover: () => ManifestProviderRow[] = () => getLLMGateway().listProviders(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (ctx.manifestValidationMode === "sandbox_exact_code") {
    const exactCodeOnly =
      manifest.length > 0 &&
      manifest.every((raw) => {
        const agent = raw as typeof raw & {
          generated?: unknown;
          codeExecuted?: unknown;
          typescript_code?: unknown;
          factory_execution_scope?: { kind?: unknown };
        };
        return (
          agent.generated === true &&
          agent.codeExecuted === true &&
          typeof agent.typescript_code === "string" &&
          agent.typescript_code.trim().length > 0 &&
          agent.factory_execution_scope?.kind === "sandbox"
        );
      });
    if (!exactCodeOnly) {
      throw new Error(
        "sandbox_exact_code validation requires every agent to carry exact generated code and a nonce sandbox execution scope",
      );
    }
    return [];
  }

  return discover()
    .filter((provider) =>
      env.NODE_ENV === "test"
        ? provider.hasKey
        : provider.hasKey &&
          provider.id !== "mock" &&
          provider.id !== "bedrock" &&
          provider.id !== "vertex",
    )
    .map((provider) => provider.id);
}

function persistedManifest(
  source: unknown,
  agents: WorkflowManifest,
  schemaVersion: number,
): unknown {
  if (
    source &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    Array.isArray((source as { agents?: unknown }).agents)
  ) {
    return {
      ...(source as Record<string, unknown>),
      $schemaVersion: schemaVersion,
      agents,
    };
  }
  return agents;
}

async function runPipeline(
  input: ManifestImportBody,
  ctx: TenantCtx,
  factoryAuthorization?: FactoryPromotionImportAuthorization,
): Promise<PipelineResult> {
  // 1. migrate raw → bare array
  const migration = migrate(input.workflow);
  // Canonicalize generated agents' tools with the reviewed execution_policy
  // triple from the registry before the schema check, so a template/model
  // produced generated manifest parses instead of failing the manifest
  // superRefine — a parse failure here would short-circuit the pipeline and
  // skip the persistence secret-policy scan below.
  const canonicalPayload = Array.isArray(migration.payload)
    ? attachReviewedToolExecutionPolicies(migration.payload as unknown[])
    : migration.payload;
  // 2. Zod-parse the migrated manifest
  const parsed = WorkflowManifestSchema.safeParse(canonicalPayload);
  if (!parsed.success) {
    const issues: Issue[] = parsed.error.issues.slice(0, 50).map((i) => ({
      path: "agents." + i.path.join("."),
      message: i.message,
      severity: "error" as const,
      code: i.code ?? "zod_invalid",
    }));
    // Even on parse failure we want to return a structured response with
    // every issue so the SPA can render them in step 2. Construct a best-
    // effort empty pipeline result.
    const live = loadLiveSnapshot(ctx);
    return {
      migrated: [],
      persistedManifest: [],
      forLint: [],
      actions: undefined,
      issues,
      conflicts: [],
      diff: {
        added: [],
        removed: [],
        modified: [],
        prior_version: live.versionString,
      },
      prior: live,
      schemaVersion: migration.toVersion,
      historicalCodeActAuthorizations: {},
    };
  }
  const manifestRaw = parsed.data as unknown as WorkflowManifest;
  // For lint, we keep the raw migrated payload alongside the parsed one. The
  // AgentSchema in this codebase strips unknown fields by default, so a
  // strict parse drops `model`, `concurrency`, `tool_use`, `cron`, etc — but
  // the linter needs to see them to flag `model_not_configured`,
  // `concurrency_excess`, and `orphan_actor`. Merge field-by-field.
  const rawArray = Array.isArray(migration.payload)
    ? (migration.payload as Array<Record<string, unknown>>)
    : [];
  const enriched: WorkflowManifest = (
    manifestRaw as unknown as Array<Record<string, unknown>>
  ).map((a, i) => {
    const rawAgent = rawArray[i];
    if (!rawAgent || typeof rawAgent !== "object")
      return a as unknown as AgentSpec;
    return { ...rawAgent, ...a } as unknown as AgentSpec;
  }) as unknown as WorkflowManifest;

  // 3. Apply operator resolutions BEFORE diff/lint so the displayed counts
  //    match what will be committed. We apply to both views so the canonical
  //    form stays in lockstep with the enriched lint view.
  const { manifest: canonical } = applyResolutions(
    manifestRaw,
    input.conflict_resolutions ?? [],
  );
  const { manifest } = applyResolutions(
    enriched,
    input.conflict_resolutions ?? [],
  );
  // The exact payload that will be persisted (manifest_json + on-disk file):
  // envelope-preserving when the caller uploaded a `{ agents: [...] }` object,
  // else the canonical agents array stamped with the schema version.
  const persisted = persistedManifest(
    input.workflow,
    canonical,
    migration.toVersion,
  );

  // 4. Validate actions (loose schema is intentional — actions.json is
  //    documentation-ish; only the workflow.json carries runtime contracts).
  let actions: unknown[] | undefined;
  if (input.actions !== undefined) {
    const ap = ActionsManifestSchema.safeParse(input.actions);
    if (!ap.success) {
      const live = loadLiveSnapshot(ctx);
      return {
        migrated: canonical,
        persistedManifest: persisted,
        forLint: manifest,
        actions: input.actions,
        issues: [
          ...ap.error.issues.slice(0, 50).map((i) => ({
            path: "actions." + i.path.join("."),
            message: i.message,
            severity: "error" as const,
            code: i.code ?? "actions_invalid",
          })),
          ...findWorkflowSecretPolicyIssues(persisted, input.actions, {
            tenantSlug: ctx.tenantSlug,
          }),
        ],
        conflicts: [],
        diff: {
          added: [],
          removed: [],
          modified: [],
          prior_version: live.versionString,
        },
        prior: live,
        schemaVersion: migration.toVersion,
        historicalCodeActAuthorizations: {},
      };
    }
    actions = ap.data as unknown[];
  }

  // 5. Diff against live FIRST so the linter knows which kebab_ids are about
  //    to be removed (used by `broken_subflow`).
  const live = loadLiveSnapshot(ctx);
  const diff = diffManifests(live.agents, canonical, live.versionString);
  const removedKebabIds = new Set(diff.removed);
  // Lint context: providers, concurrency cap, removedKebabIds, live id map.
  // Provider discovery is part of deployment validation. Invalid gateway
  // configuration must be visible; treating it as an empty catalog made a
  // broken runtime look like an ordinary manifest lint result.
  const providerIds = manifestLintProviderIds(manifest, ctx);
  // Build live kebab → id map (for silent_rename detection). Pre-review the
  // lint never saw the live `id` field so renames slipped through.
  const liveAgentIds = new Map<string, string>();
  for (const la of live.agents) liveAgentIds.set(la.id, la.id);
  // 6. Lint with the full context.
  const lintRes = lint(manifest, {
    liveWorkflow:
      live.agents.length > 0 ? liveSnapshotForLint(live) : undefined,
    llmProviders: providerIds,
    concurrencyMax: CONCURRENCY_MAX,
    removedKebabIds,
    liveAgentIds,
    configuredEnv: new Set(
      Object.entries(process.env)
        .filter(([, value]) => typeof value === "string" && value.trim() !== "")
        .map(([name]) => name),
    ),
    disabledScheduleEnv: new Set(
      Object.entries(process.env)
        .filter(
          ([, value]) =>
            typeof value === "string" &&
            /^(?:off|disabled)$/i.test(value.trim()),
        )
        .map(([name]) => name),
    ),
  });

  // Every generated production Agent is accepted only through the process-local Factory
  // promotion capability minted after human HMAC verification + exact regression replay.
  // Merely copying provenance or a CodeAct attestation into an HTTP import remains untrusted.
  const codeExecutionIssues: Issue[] = [];
  const historicalCodeActAuthorizations: Record<
    string,
    HistoricalProductionGeneratedAgentAuthorization
  > = {};
  if (!isSandboxTenant(ctx.tenantSlug) && input.target === "production") {
    const trustedFactoryPromotion = Boolean(
      factoryAuthorization &&
      isFactoryPromotionAuthorized(factoryAuthorization, ctx, input.workflow) &&
      factoryAuthorization.workflowManifestSha256 ===
        productionCodeActManifestSha256(canonical),
    );
    if (trustedFactoryPromotion && factoryAuthorization) {
      const { assertHistoricalProductionGeneratedAgentAuthorized } =
        await import("./agent-factory/production-codeact-authorization");
      for (const agent of canonical) {
        if (agent.generated !== true) continue;
        const agentManifestSha256 = productionCodeActManifestSha256(agent);
        const selectedByCurrentPromotion =
          factoryAuthorization.authorizedAgentManifestSha256[agent.id] ===
            agentManifestSha256 &&
          (agent.codeExecuted !== true ||
            factoryAuthorization.authorizedCode[agent.id] ===
              crypto
                .createHash("sha256")
                .update(agent.typescript_code ?? "", "utf8")
                .digest("hex"));
        if (selectedByCurrentPromotion) continue;
        try {
          historicalCodeActAuthorizations[agent.id] =
            await assertHistoricalProductionGeneratedAgentAuthorized({
              tenantId: ctx.tenantId,
              tenantSlug: ctx.tenantSlug,
              agent: agent as unknown as Record<string, unknown>,
            });
        } catch {
          // The pure gate below emits the stable, public-facing issue. Durable
          // verifier details intentionally stay on the trusted side.
        }
      }
    }
    codeExecutionIssues.push(
      ...productionGeneratedAgentImportIssues({
        manifest: canonical,
        rawWorkflow: input.workflow,
        ctx,
        authorization: factoryAuthorization,
        historicalAuthorizedAgentManifestSha256: Object.fromEntries(
          Object.entries(historicalCodeActAuthorizations).map(([slug, row]) => [
            slug,
            row.agentManifestSha256,
          ]),
        ),
      }),
    );
  }

  return {
    migrated: canonical,
    persistedManifest: persisted,
    forLint: manifest,
    actions,
    issues: [
      ...adaptIssues(lintRes.issues),
      ...codeExecutionIssues,
      // Canonical persistence policy: literal credentials, malformed secret
      // references, or forbidden endpoints in the exact payload that would be
      // persisted are blocking errors on every import surface.
      ...findWorkflowSecretPolicyIssues(persisted, actions, {
        tenantSlug: ctx.tenantSlug,
      }),
    ],
    conflicts: adaptConflicts(lintRes.conflicts),
    diff,
    prior: live,
    schemaVersion: migration.toVersion,
    historicalCodeActAuthorizations: Object.freeze({
      ...historicalCodeActAuthorizations,
    }),
  };
}

function eventsFromManifest(manifest: WorkflowManifest): Set<string> {
  const set = new Set<string>();
  for (const a of manifest) {
    for (const ev of a.trigger) set.add(ev);
    for (const ev of a.triggered_event) set.add(ev);
  }
  return set;
}

// ---- Overwrite guard ------------------------------------------------------

/**
 * Compound overwrite rule (per PRD §"Overwrite guard" + review C2):
 *   trip := removed ≥ 1
 *        || modified ≥ max(OVERWRITE_MOD_FLOOR, ceil(0.30 * priorN))
 *        || added + removed + modified
 *             ≥ max(OVERWRITE_CHURN_FLOOR, ceil(0.50 * priorN))
 *
 * The single-ratio "≥30% modified" check from the v0 draft fell apart on
 * small manifests: at priorN=1 the ratio rounds to 1 (any change trips),
 * at priorN=3 it trips on a single modification, but at priorN=100 it
 * silently let 29 modifications through. The compound rule layers absolute
 * floors on top of ratios so the guard fires sensibly across the size
 * spectrum. See PRD worked examples for n=1,3,10,100.
 */
export function overwriteGuard(
  diff: ManifestDiff,
  priorAgentCount: number,
  conflicts: Conflict[],
  opts: { confirmOverwrite: boolean },
): ManifestImportOverwriteRequired | null {
  if (opts.confirmOverwrite) return null;
  if (priorAgentCount === 0) return null; // first deploy — never trips
  // (1) Any removal trips, regardless of manifest size.
  if (diff.removed.length >= 1) {
    return {
      ok: false,
      requires_confirmation: true,
      reason: "removes_agents",
      diff,
      conflicts,
    };
  }
  // (2) Modification ratio with absolute floor.
  const modThreshold = Math.max(
    OVERWRITE_MOD_FLOOR,
    Math.ceil(OVERWRITE_MOD_RATIO * priorAgentCount),
  );
  if (diff.modified.length >= modThreshold) {
    return {
      ok: false,
      requires_confirmation: true,
      reason: "modifies_threshold",
      diff,
      conflicts,
    };
  }
  // (3) Total churn ratio with absolute floor.
  const churn = diff.added.length + diff.removed.length + diff.modified.length;
  const churnThreshold = Math.max(
    OVERWRITE_CHURN_FLOOR,
    Math.ceil(OVERWRITE_CHURN_RATIO * priorAgentCount),
  );
  if (churn >= churnThreshold) {
    return {
      ok: false,
      requires_confirmation: true,
      reason: "modifies_threshold",
      diff,
      conflicts,
    };
  }
  return null;
}

// ---- Public API: validate -------------------------------------------------

/**
 * Look up the in-flight pending deployment for a tenant, if any. Used by the
 * validate path to enforce the one-pending-per-tenant invariant (the
 * import-session lock) and by the route's 423 LOCKED response. A row past
 * its expires_at is treated as released — boot-time `reconcileImports`
 * sweeps stale rows but we don't want to wait for that.
 */
function findActivePendingImport(ctx: TenantCtx): {
  deploymentId: string;
  workflowVersionId: string;
  workflowId: string;
  workflowSlug: string;
} | null {
  const db = getDb();
  const pending = db
    .select({
      deploymentId: deployments.id,
      workflowVersionId: deployments.versionId,
      workflowId: workflowVersions.workflowId,
      workflowSlug: workflows.slug,
      expiresAt: deployments.expiresAt,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "pending"),
      ),
    )
    .all()[0];
  if (!pending) return null;
  if (pending.expiresAt && pending.expiresAt.getTime() < Date.now()) {
    // Past TTL — drop in line and let the new validate take over.
    db.transaction(() => {
      db.delete(deployments)
        .where(eq(deployments.id, pending.deploymentId))
        .run();
      db.delete(workflowVersions)
        .where(eq(workflowVersions.id, pending.workflowVersionId))
        .run();
    });
    return null;
  }
  return pending;
}

/**
 * validate(): run the pipeline, then upsert a `deployments(status='pending')`
 * lock row whose id IS the import session token (per review A2). The route
 * returns 423 LOCKED if a parallel validate finds an existing pending row.
 *
 * The pending row holds the canonical manifest in
 * `workflow_versions.manifest_json` so the SPA can survive a refresh by
 * re-fetching the deployment_id — no separate disk staging is needed.
 *
 * `validate` itself never writes to disk and never demotes the live row.
 */
export async function validate(
  input: ManifestImportBody,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
  factoryAuthorization?: FactoryPromotionImportAuthorization,
): Promise<ManifestImportPreview> {
  const started = Date.now();

  // New Workflow imports are authoring previews, not deployment sessions.
  // Run the exact migration/resolution/lint pipeline, but do not contend for
  // the tenant's pending-import lock and do not persist any workflow,
  // version, deployment, agent, or file row. The caller saves the returned
  // canonical payload through the ordinary immutable draft API.
  if (input.draft_only) {
    const result = await runPipeline(input, ctx);
    const secretBlocking = result.issues.filter((issue) =>
      isWorkflowSecretPolicyIssueCode(issue.code),
    );
    if (secretBlocking.length > 0) {
      throw new BlockingIssuesError(secretBlocking);
    }
    const elapsedMs = Date.now() - started;
    const preview: ManifestImportPreview = {
      ok: result.issues.every((issue) => issue.severity !== "error"),
      schema_version: result.schemaVersion,
      parsed: {
        agents: result.migrated.length,
        events: eventsFromManifest(result.migrated).size,
        actions: result.actions?.length ?? 0,
      },
      issues: result.issues,
      conflicts: result.conflicts,
      diff: result.diff,
      prior: {
        version: result.prior.versionString,
        agents: result.prior.agents.length,
        live_deployment_id: result.prior.liveDeploymentId,
      },
      normalized_workflow: result.persistedManifest,
      normalized_actions: result.actions ?? null,
      elapsed_ms: elapsedMs,
    };
    writeAuditSafely(auditCtx, {
      tenantId: ctx.tenantId,
      action: "manifest.import.validate_draft",
      targetType: "workflow",
      targetId: authoringWorkflowSlug(input, ctx),
      meta: {
        ok: preview.ok,
        agents: result.migrated.length,
        issues: result.issues.length,
        conflicts: result.conflicts.length,
        schema_version: result.schemaVersion,
        persisted: false,
        elapsed_ms: elapsedMs,
      },
    });
    return preview;
  }

  // One-pending-per-tenant lock policy:
  //   - No body.deployment_id + no pending row → fresh lock (new dpl- id)
  //   - No body.deployment_id + pending row    → auto-reuse the pending row
  //     (single-operator-iterating-in-wizard case; the SPA may have lost the
  //     id across a refresh, or this is the v0 client that doesn't thread it).
  //   - body.deployment_id matches pending row → resume (refresh content)
  //   - body.deployment_id ≠ pending row id     → 423 LOCKED (another operator)
  //
  // The 423 case is the only one that surfaces the in-flight id to the SPA
  // so it can offer a Resume/Cancel banner — see review C5 + design.md
  // §"Wizard back-navigation".
  const existingPending = findActivePendingImport(ctx);
  if (input.deployment_id && !existingPending) {
    throw new InvalidPendingImportError("not_found", input.deployment_id);
  }
  const targetWorkflowSlug = authoringWorkflowSlug(input, ctx);
  let reuseDeploymentId: string | null = null;
  if (existingPending) {
    // The single pending lock may only be auto-reused/resumed for the SAME
    // authoring workflow. A validate for a different workflow slug must 423
    // rather than silently rebinding another workflow's in-flight session —
    // otherwise one pending import overwrites another workflow's session.
    if (
      existingPending.workflowSlug === targetWorkflowSlug &&
      (!input.deployment_id ||
        input.deployment_id === existingPending.deploymentId)
    ) {
      reuseDeploymentId = existingPending.deploymentId;
    } else {
      throw new PendingImportConflictError(existingPending.deploymentId);
    }
  }

  const result = await runPipeline(input, ctx, factoryAuthorization);
  // Canonical persistence policy: a manifest carrying literal credentials,
  // malformed secret references, cross-tenant secret scope, or forbidden
  // endpoints must never open a pending import lock. Reject before any row is
  // written so the unsafe payload can neither be persisted nor resumed.
  const secretBlocking = result.issues.filter((issue) =>
    isWorkflowSecretPolicyIssueCode(issue.code),
  );
  if (secretBlocking.length > 0) {
    throw new BlockingIssuesError(secretBlocking);
  }
  const ok = result.issues.every((i) => i.severity !== "error");

  // Persist the pending lock row. Even when `ok=false` we keep the row —
  // the SPA may show the issues to the operator and they may correct them
  // in place by passing fresh conflict_resolutions to a subsequent validate.
  const deploymentId = reuseDeploymentId ?? makeId("dpl");
  const workflowVersionId = makeId("wfv");
  const db = getDb();
  db.transaction(() => {
    // Lazy-create the tenant workflow row (same shape as bootstrap).
    // Authoring may target a named workflow lane (`workflow_slug` in the
    // body); the ctx/default lane remains the fallback.
    const workflowSlug = targetWorkflowSlug;
    let wf = db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, ctx.tenantId),
          eq(workflows.slug, workflowSlug),
        ),
      )
      .all()[0];
    if (!wf) {
      const wfId = makeId("wf");
      db.insert(workflows)
        .values({
          id: wfId,
          tenantId: ctx.tenantId,
          slug: workflowSlug,
          name: authoringWorkflowName(input, ctx),
        })
        .run();
      wf = db.select().from(workflows).where(eq(workflows.id, wfId)).all()[0]!;
    }
    if (reuseDeploymentId) {
      // Refresh the pending row's workflow_version manifest in place.
      const oldRow = db
        .select()
        .from(deployments)
        .where(eq(deployments.id, reuseDeploymentId))
        .all()[0];
      if (oldRow) {
        db.update(workflowVersions)
          .set({
            // Expanded envelope (see bootstrapIdentityManifestJson) so a pending
            // row promoted to the canonical version at commit — its manifest is
            // NOT rewritten there — already matches what bootstrap re-derives.
            manifestJson: bootstrapIdentityManifestJson(
              result.persistedManifest,
            ) as object,
            actionsJson: (result.actions ?? null) as unknown as object,
          })
          .where(eq(workflowVersions.id, oldRow.versionId))
          .run();
        db.update(deployments)
          .set({
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          })
          .where(eq(deployments.id, reuseDeploymentId))
          .run();
      }
    } else {
      // Fresh pending row.
      db.insert(workflowVersions)
        .values({
          id: workflowVersionId,
          workflowId: wf.id,
          version: `pending-${deploymentId}`,
          // Expanded envelope (see bootstrapIdentityManifestJson) so the pending
          // row is byte-identical to what bootstrap re-derives once promoted.
          manifestJson: bootstrapIdentityManifestJson(
            result.persistedManifest,
          ) as object,
          actionsJson: (result.actions ?? null) as unknown as object,
        })
        .run();
      db.insert(deployments)
        .values({
          id: deploymentId,
          tenantId: ctx.tenantId,
          target: "workflow",
          versionId: workflowVersionId,
          status: "pending",
          note: input.note ?? null,
          expiresAt: new Date(Date.now() + PENDING_TTL_MS),
        })
        .run();
    }
  });

  // Resolve the workflow_version id we actually used (for the response).
  const actualWfvId = reuseDeploymentId
    ? (db
        .select({ versionId: deployments.versionId })
        .from(deployments)
        .where(eq(deployments.id, reuseDeploymentId))
        .all()[0]?.versionId ?? workflowVersionId)
    : workflowVersionId;

  const elapsedMs = Date.now() - started;
  const preview: ManifestImportPreview = {
    ok,
    schema_version: result.schemaVersion,
    parsed: {
      agents: result.migrated.length,
      events: eventsFromManifest(result.migrated).size,
      actions: result.actions?.length ?? 0,
    },
    issues: result.issues,
    conflicts: result.conflicts,
    diff: result.diff,
    prior: {
      version: result.prior.versionString,
      agents: result.prior.agents.length,
      live_deployment_id: result.prior.liveDeploymentId,
    },
    deployment_id: deploymentId,
    workflow_version_id: actualWfvId,
    elapsed_ms: elapsedMs,
  };

  // Audit row (per review O1) — smaller meta than commit.
  writeAuditRequired(auditCtx, {
    tenantId: ctx.tenantId,
    action: "manifest.import.validate",
    targetType: "deployment",
    targetId: deploymentId,
    meta: {
      ok,
      agents: result.migrated.length,
      issues: result.issues.length,
      conflicts: result.conflicts.length,
      schema_version: result.schemaVersion,
      reused_pending: Boolean(reuseDeploymentId),
      elapsed_ms: elapsedMs,
    },
  });

  return preview;
}

/**
 * cancel(): manually release a pending lock + remove the tmp staging dir.
 * Powers `DELETE /v1/tenants/:slug/manifest-import/:deployment_id` (review
 * C5). Refuses on rows that are not `status='pending'`.
 */
export async function cancel(
  deploymentId: string,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
): Promise<{ ok: true }> {
  const db = getDb();
  const row = db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .all()[0];
  if (!row) {
    throw new Error("not_found");
  }
  if (row.tenantId !== ctx.tenantId) {
    throw new Error("forbidden");
  }
  if (row.status !== "pending") {
    throw new Error("not_pending");
  }
  // Remove staging first. `force` makes a genuinely absent directory a
  // success, while permissions/I/O errors remain fatal and keep the lock so
  // reconciliation can retry instead of leaking untracked files.
  await rm(path.join(importsRoot(), deploymentId), {
    recursive: true,
    force: true,
  });
  db.transaction(() => {
    // Delete the pending row + its workflow_versions row (the version was
    // created for this pending lock specifically — it isn't pointed at by
    // any agent_versions because we never inserted those).
    db.delete(deployments).where(eq(deployments.id, deploymentId)).run();
    db.delete(workflowVersions)
      .where(eq(workflowVersions.id, row.versionId))
      .run();
  });
  writeAuditRequired(auditCtx, {
    tenantId: ctx.tenantId,
    action: "manifest.import.cancel",
    targetType: "deployment",
    targetId: deploymentId,
    meta: { tenant_slug: ctx.tenantSlug },
  });
  return { ok: true };
}

// ---- Public API: commit ---------------------------------------------------

/**
 * Pick the next workflow_v<N+1> filename in the tenant's models folder.
 * Atomic O_CREAT|O_EXCL retry on EEXIST per design.md (handles the race
 * where two near-simultaneous commits both pick the same N+1). The handle
 * is closed immediately — the actual content lands via `rename()` later.
 */
async function pickAndReserveNextFilename(
  slug: string,
  reserveActions: boolean,
): Promise<{
  targetDir: string;
  workflowPath: string;
  actionsPath: string;
  nextVersion: number;
}> {
  let targetDir: string;
  const dirs = await findTenantDirs(slug);
  if (dirs.length === 0) {
    targetDir = path.join(modelsRoot(), `${slug}-v1`);
    await mkdir(targetDir, { recursive: true });
  } else {
    targetDir = dirs[0]!.absDir;
  }
  // Atomic reservation: claim the workflow and (when present) actions paths
  // as one pair. `rename()` replaces its destination on POSIX, so reserving
  // only the workflow path allowed an orphan `actions_vN.json` to be silently
  // overwritten. Use the greater of both version lanes and retry the pair on
  // a concurrent claim.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [nextWorkflow, nextActions] = await Promise.all([
      pickNextVersion(targetDir, "workflow"),
      pickNextVersion(targetDir, "actions"),
    ]);
    const nextVersion = Math.max(
      nextWorkflow.nextVersion,
      nextActions.nextVersion,
    );
    const wfPath = path.join(targetDir, `workflow_v${nextVersion}.json`);
    const actionsPath = path.join(targetDir, `actions_v${nextVersion}.json`);
    let wfFd: number | null = null;
    let actionsFd: number | null = null;
    let createdWorkflow = false;
    let createdActions = false;
    try {
      wfFd = openSync(wfPath, "ax"); // O_CREAT|O_EXCL|O_WRONLY
      createdWorkflow = true;
      if (reserveActions) {
        actionsFd = openSync(actionsPath, "ax");
        createdActions = true;
      }
      if (actionsFd !== null) {
        closeSync(actionsFd);
        actionsFd = null;
      }
      closeSync(wfFd);
      wfFd = null;
      fsyncDirectoryRequired(targetDir);
      return {
        targetDir,
        workflowPath: wfPath,
        actionsPath,
        nextVersion,
      };
    } catch (err) {
      try {
        if (actionsFd !== null) closeSync(actionsFd);
      } catch {
        // The path is still removed below; preserve the reservation error.
      }
      try {
        if (wfFd !== null) closeSync(wfFd);
      } catch {
        // The path is still removed below; preserve the reservation error.
      }
      // Remove only paths this attempt created. Existing paths belong to an
      // earlier/concurrent deployment and must never be unlinked by a failed
      // claimant.
      if (createdActions) await rm(actionsPath, { force: true });
      if (createdWorkflow) await rm(wfPath, { force: true });
      if (createdActions || createdWorkflow) fsyncDirectoryRequired(targetDir);
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Someone else just claimed N+1; loop and bump.
    }
  }
  throw new Error(
    "could not reserve a unique workflow filename after 8 attempts",
  );
}

/**
 * The canonical runtime manifest as bootstrap re-derives it from the on-disk
 * file. Bootstrap's loadManifestFromDisk branches on Array.isArray and, for the
 * V2 envelope, compat-parses then schema-parses (expands) its `agents`. Mirror
 * that EXACT transform on the exact bytes we write to disk
 * (`result.persistedManifest`) so the version id and the stored manifest_json we
 * persist here are byte-identical to what bootstrap computes and stores. Hashing
 * or storing the minimal pre-parse `result.migrated` instead diverges from the
 * expanded on-disk form and trips bootstrap's version/content digest guard (a
 * 500 during hot-swap). Direct-parse and compat-parse expand differently, so
 * this must follow the same branch bootstrap does.
 */
function bootstrapIdentityAgents(persistedManifest: unknown): WorkflowManifest {
  return Array.isArray(persistedManifest)
    ? WorkflowManifestSchema.parse(persistedManifest)
    : WorkflowManifestSchema.parse(
        WorkflowManifestCompatSchema.parse(persistedManifest).agents,
      );
}

/**
 * The `manifest_json` payload to persist for a workflow_version row: the
 * expanded canonical agents (see {@link bootstrapIdentityAgents}) wrapped back
 * in the V2 envelope so top-level `$schemaVersion`/`extensions` survive, exactly
 * as bootstrap and the validate/promotion paths persist it.
 */
function bootstrapIdentityManifestJson(persistedManifest: unknown): unknown {
  const agents = bootstrapIdentityAgents(persistedManifest);
  return Array.isArray(persistedManifest)
    ? agents
    : { ...(persistedManifest as Record<string, unknown>), agents };
}

/**
 * Content-identity check that tolerates the persisted V2 envelope shape.
 *
 * `validate()` stores the full `{ $schemaVersion, extensions, agents }` envelope
 * in `workflow_versions.manifest_json` so authoring metadata survives a wizard
 * refresh, while `commit()` reconciles every workflow-version row against the
 * bare canonical agent array (`result.migrated`) — the exact form written to
 * disk and re-derived byte-for-byte by runtime bootstrap. Comparing an
 * envelope-shaped row against the bare array always fails, so a legitimate
 * pending-session promotion would spuriously 409. Normalize an envelope row to
 * its `agents` projection before delegating to the canonical comparison; bare
 * rows pass through unchanged.
 */
function storedWorkflowVersionMatchesMigrated(
  row: { manifestJson: unknown; actionsJson: unknown },
  migratedManifest: WorkflowManifest,
  actions: unknown,
): boolean {
  const stored = row.manifestJson;
  const normalizedManifest =
    stored &&
    typeof stored === "object" &&
    !Array.isArray(stored) &&
    Array.isArray((stored as { agents?: unknown }).agents)
      ? (stored as { agents: unknown }).agents
      : stored;
  return workflowVersionContentMatches(
    { manifestJson: normalizedManifest, actionsJson: row.actionsJson },
    migratedManifest,
    actions,
  );
}

export async function commit(
  input: ManifestImportBody,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
  factoryAuthorization?: FactoryPromotionImportAuthorization,
): Promise<ManifestImportCommit> {
  const started = Date.now();
  const result = await runPipeline(input, ctx, factoryAuthorization);
  const trustedFactoryPromotion = factoryAuthorization
    ? isFactoryPromotionAuthorized(factoryAuthorization, ctx, input.workflow) &&
      factoryAuthorization.workflowManifestSha256 ===
        productionCodeActManifestSha256(result.migrated)
    : false;
  if (factoryAuthorization && !trustedFactoryPromotion) {
    throw new Error(
      "factory promotion import authorization is invalid or stale",
    );
  }

  // PHASE 1 — preflight (no IO)
  // ─────────────────────────────────────────────────────────────────────
  // Hard-stop on parse/struct errors: nothing else will succeed.
  const blocking = result.issues.filter((i) => i.severity === "error");
  if (blocking.length > 0) {
    throw new BlockingIssuesError(blocking);
  }
  // Hard-stop on un-resolved `severity='block'` conflicts.
  const unresolvedBlocking = result.conflicts.filter(
    (c) => c.severity === "block",
  );
  if (unresolvedBlocking.length > 0) {
    throw new BlockingIssuesError(
      unresolvedBlocking.map((c) => ({
        path: c.path,
        message: c.detail,
        severity: "error" as const,
        code: c.type,
      })),
    );
  }
  // Overwrite guard. Returns the 409 envelope when tripped.
  const overwrite = overwriteGuard(
    result.diff,
    result.prior.agents.length,
    result.conflicts,
    { confirmOverwrite: input.confirm_overwrite },
  );
  if (overwrite) {
    throw new OverwriteRequiredError(overwrite);
  }

  const db = getDb();
  // A supplied session id is authoritative: never silently degrade a stale,
  // foreign-workflow, or mistyped id into a cold commit. Cold commit remains
  // available only when the caller intentionally omits deployment_id.
  const pendingDetails = input.deployment_id
    ? db
        .select({
          deploymentId: deployments.id,
          versionId: deployments.versionId,
          expiresAt: deployments.expiresAt,
          note: deployments.note,
          workflowId: workflowVersions.workflowId,
          workflowSlug: workflows.slug,
        })
        .from(deployments)
        .innerJoin(
          workflowVersions,
          eq(workflowVersions.id, deployments.versionId),
        )
        .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
        .where(
          and(
            eq(deployments.tenantId, ctx.tenantId),
            eq(deployments.id, input.deployment_id),
            eq(deployments.target, "workflow"),
            eq(deployments.status, "pending"),
          ),
        )
        .all()[0]
    : undefined;
  if (input.deployment_id && !pendingDetails) {
    throw new InvalidPendingImportError("not_found", input.deployment_id);
  }
  if (
    pendingDetails?.expiresAt &&
    pendingDetails.expiresAt.getTime() < Date.now()
  ) {
    db.transaction(() => {
      db.delete(deployments)
        .where(eq(deployments.id, pendingDetails.deploymentId))
        .run();
      db.delete(workflowVersions)
        .where(eq(workflowVersions.id, pendingDetails.versionId))
        .run();
    });
    throw new InvalidPendingImportError("expired", pendingDetails.deploymentId);
  }
  if (
    pendingDetails &&
    pendingDetails.workflowSlug !== authoringWorkflowSlug(input, ctx)
  ) {
    throw new InvalidPendingImportError(
      "workflow_mismatch",
      pendingDetails.deploymentId,
    );
  }
  const pendingLockRow = pendingDetails
    ? {
        id: pendingDetails.deploymentId,
        versionId: pendingDetails.versionId,
        note: pendingDetails.note,
      }
    : undefined;
  const deploymentId = pendingLockRow?.id ?? makeId("dpl");
  // Version identity MUST be byte-identical to what runtime bootstrap re-derives
  // from disk, or bootstrap treats the just-committed version as new, supersedes
  // this deployment, and assertDeploymentOwnsLiveLane 500s. Bootstrap loads the
  // on-disk workflow.json (the V2 envelope written below) via
  // loadManifestFromDisk, which branches on Array.isArray and, for the envelope,
  // compat-parses then schema-parses its `agents`. Mirror that EXACT transform
  // here on the EXACT bytes we write to disk (result.persistedManifest) so the
  // hashed form and the runtime-loaded form are the same object. Hashing the raw
  // pre-parse `result.migrated` instead (as before) diverged from the envelope's
  // compat+schema-parsed form and broke every cold commit. The stored
  // manifestJson reuses this parsed form for the content-collision guard.
  const migratedForIdentity = bootstrapIdentityAgents(result.persistedManifest);
  const identityManifestJson = bootstrapIdentityManifestJson(
    result.persistedManifest,
  );
  const desiredVersion = canonicalWorkflowVersionId(
    migratedForIdentity,
    result.actions,
  );
  const legacyDesiredVersion = legacyWorkflowVersionId(migratedForIdentity);
  // Capture the authoritative last-good view before the first durable write.
  // Phase-2 failure does not need it, but any later runtime activation failure
  // must restore this exact pre-image rather than merely demoting the new row.
  const preimage = captureManifestImportPreimage(ctx);
  const preimageLive = preimage.deployments.filter(
    (row) => row.status === "live",
  );
  if (
    preimageLive.length !== (result.prior.liveDeploymentId ? 1 : 0) ||
    (result.prior.liveDeploymentId !== null &&
      (preimageLive[0]?.id !== result.prior.liveDeploymentId ||
        preimageLive[0]?.versionId !== result.prior.workflowVersionId))
  ) {
    throw new ManifestImportConcurrencyConflictError(
      "manifest import live deployment changed after validation",
    );
  }

  // PHASE 2 — write tmp staging file + fsync
  // ─────────────────────────────────────────────────────────────────────
  // Per review C1: write the disk artifact BEFORE committing the DB so a
  // crash in phase 3 leaves no observable state mismatch — the new
  // workflow_version row points at `file_path` which is a tmp file the
  // reconciler can finish renaming. Failing in phase 2 leaves only an
  // orphan tmp dir (reconciler GCs it on next boot).
  const tmpDir = path.join(importsRoot(), deploymentId);
  const tmpWorkflowPath = path.join(tmpDir, "workflow.json");
  const tmpActionsPath = path.join(tmpDir, "actions.json");
  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      tmpWorkflowPath,
      // Persist the V2 envelope ($schemaVersion + extensions + agents) so
      // top-level authoring metadata survives on disk (asserted by
      // workflow-authoring-release-regressions). Bootstrap re-derives the exact
      // version from this envelope via bootstrapIdentityAgents' compat path.
      JSON.stringify(result.persistedManifest, null, 2) + "\n",
      "utf8",
    );
    fsyncRequired(tmpWorkflowPath);
    if (result.actions) {
      await writeFile(
        tmpActionsPath,
        JSON.stringify(result.actions, null, 2) + "\n",
        "utf8",
      );
      fsyncRequired(tmpActionsPath);
    }
  } catch (err) {
    // Disk write failed BEFORE any DB change — return 500. Audit + clean up.
    auditCtx?.log?.error?.(
      {
        err: (err as Error).message,
        deployment_id: deploymentId,
        phase: "tmp_write",
      },
      "manifest-import: tmp file write failed",
    );
    writeAuditRequired(auditCtx, {
      tenantId: ctx.tenantId,
      action: "manifest.import.fail_swap",
      targetType: "deployment",
      targetId: deploymentId,
      meta: {
        phase: "tmp_write",
        error: (err as Error).message,
        tenant_slug: ctx.tenantSlug,
      },
    });
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  // PHASE 3 — atomic SQLite tx
  // ─────────────────────────────────────────────────────────────────────
  let txOut: {
    workflowVersionId: string;
    deploymentId: string;
    workflowId: string;
    priorDeploymentId: string | null;
    isPromotion: boolean;
  };
  try {
    txOut = (() => {
      let workflowVersionId = "";
      let workflowId = "";
      let priorDeploymentId: string | null = null;
      let isPromotion = false;
      db.transaction(() => {
        // Optimistic CAS: no import may demote a deployment newer than the
        // authoritative pre-image captured before phase 2. Comparing both row
        // identity and version prevents ABA-style stale compensation.
        assertLiveDeploymentBaseline(ctx, preimage.deployments);

        // (a) ensure tenant workflow row. Honour an explicit authoring
        // `workflow_slug` (the Publish path targets a named immutable workflow
        // lane) instead of always collapsing onto the `<tenant>-default` lane —
        // otherwise the published version is owned by the legacy default row.
        const workflowSlug = authoringWorkflowSlug(input, ctx);
        let wf = db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.tenantId, ctx.tenantId),
              eq(workflows.slug, workflowSlug),
            ),
          )
          .all()[0];
        if (!wf) {
          const wfId = makeId("wf");
          db.insert(workflows)
            .values({
              id: wfId,
              tenantId: ctx.tenantId,
              slug: workflowSlug,
              name: workflowSlug,
            })
            .run();
          wf = db
            .select()
            .from(workflows)
            .where(eq(workflows.id, wfId))
            .all()[0]!;
        }
        workflowId = wf.id;

        // (b) demote prior live
        const liveRows = db
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.tenantId, ctx.tenantId),
              eq(deployments.target, "workflow"),
              eq(deployments.status, "live"),
            ),
          )
          .all();
        if (liveRows[0]) priorDeploymentId = liveRows[0].id;
        for (const r of liveRows) {
          db.update(deployments)
            .set({
              status: "rolled_back",
              note:
                (r.note ? r.note + "; " : "") + "auto: superseded by import",
            })
            .where(eq(deployments.id, r.id))
            .run();
        }

        // (c) Promote the pending lock or insert a fresh deployment row.
        if (pendingLockRow) {
          isPromotion = true;
          // If a prior commit already produced a workflow_version with the
          // same content hash, (workflow_id, desiredVersion) is already
          // taken by that row. A naive UPDATE on the pending wfv would
          // fail the `wfv_workflow_version_uq` index. Redirect the pending
          // deployment at the existing row instead — this mirrors the
          // cold-commit branch below.
          const fullExisting = db
            .select()
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.workflowId, wf.id),
                eq(workflowVersions.version, desiredVersion),
              ),
            )
            .all()[0];
          if (
            fullExisting &&
            !storedWorkflowVersionMatchesMigrated(
              fullExisting,
              migratedForIdentity,
              result.actions,
            )
          ) {
            throw new Error("full workflow version digest collision");
          }
          const legacyExisting = fullExisting
            ? undefined
            : db
                .select()
                .from(workflowVersions)
                .where(
                  and(
                    eq(workflowVersions.workflowId, wf.id),
                    eq(workflowVersions.version, legacyDesiredVersion),
                  ),
                )
                .all()[0];
          const reusableExisting =
            fullExisting ??
            (legacyExisting &&
            storedWorkflowVersionMatchesMigrated(
              legacyExisting,
              migratedForIdentity,
              result.actions,
            )
              ? legacyExisting
              : undefined);
          if (
            reusableExisting &&
            reusableExisting.id !== pendingLockRow.versionId
          ) {
            const pendingVersion = db
              .select()
              .from(workflowVersions)
              .where(eq(workflowVersions.id, pendingLockRow.versionId))
              .all()[0];
            if (
              !pendingVersion ||
              !storedWorkflowVersionMatchesMigrated(
                pendingVersion,
                migratedForIdentity,
                result.actions,
              )
            ) {
              throw new ManifestImportConcurrencyConflictError(
                "pending import content changed before commit",
              );
            }
            // Redirect the pending deployment at the existing wfv before
            // dropping the orphan, so nothing observable points at a
            // soon-to-be-deleted id even mid-transaction.
            db.update(deployments)
              .set({
                status: "live",
                deployedAt: new Date(),
                expiresAt: null,
                note: input.note ?? pendingLockRow.note ?? null,
                filePath: tmpWorkflowPath, // updated to final path in phase 4
                versionId: reusableExisting.id,
              })
              .where(eq(deployments.id, pendingLockRow.id))
              .run();
            // The pending wfv has no agent_versions referencing it yet
            // (those land in phase 3d below, after this branch). Safe to
            // drop. The wfv_workflow_version_uq index is freed first so
            // anything that might reference `pending-<dpl>` no longer can.
            db.delete(workflowVersions)
              .where(eq(workflowVersions.id, pendingLockRow.versionId))
              .run();
            workflowVersionId = reusableExisting.id;
          } else {
            const pendingVersion = db
              .select()
              .from(workflowVersions)
              .where(eq(workflowVersions.id, pendingLockRow.versionId))
              .all()[0];
            if (
              !pendingVersion ||
              !storedWorkflowVersionMatchesMigrated(
                pendingVersion,
                migratedForIdentity,
                result.actions,
              )
            ) {
              throw new ManifestImportConcurrencyConflictError(
                "pending import content changed before commit",
              );
            }
            // The pending row already contains the exact canonical bytes. Only
            // its temporary version label changes; immutable content is not
            // rewritten.
            db.update(workflowVersions)
              .set({
                version: desiredVersion,
              })
              .where(eq(workflowVersions.id, pendingLockRow.versionId))
              .run();
            db.update(deployments)
              .set({
                status: "live",
                deployedAt: new Date(),
                expiresAt: null,
                note: input.note ?? pendingLockRow.note ?? null,
                filePath: tmpWorkflowPath, // updated to final path in phase 4
              })
              .where(eq(deployments.id, pendingLockRow.id))
              .run();
            workflowVersionId = pendingLockRow.versionId;
          }
        } else {
          // Cold commit — reuse an existing workflow_version with the same
          // hash if present (bootstrap-style idempotency).
          const fullExisting = db
            .select()
            .from(workflowVersions)
            .where(
              and(
                eq(workflowVersions.workflowId, wf.id),
                eq(workflowVersions.version, desiredVersion),
              ),
            )
            .all()[0];
          if (
            fullExisting &&
            !storedWorkflowVersionMatchesMigrated(
              fullExisting,
              migratedForIdentity,
              result.actions,
            )
          ) {
            throw new Error("full workflow version digest collision");
          }
          const legacyExisting = fullExisting
            ? undefined
            : db
                .select()
                .from(workflowVersions)
                .where(
                  and(
                    eq(workflowVersions.workflowId, wf.id),
                    eq(workflowVersions.version, legacyDesiredVersion),
                  ),
                )
                .all()[0];
          const existing =
            fullExisting ??
            (legacyExisting &&
            storedWorkflowVersionMatchesMigrated(
              legacyExisting,
              migratedForIdentity,
              result.actions,
            )
              ? legacyExisting
              : undefined);
          if (existing) {
            workflowVersionId = existing.id;
          } else {
            workflowVersionId = makeId("wfv");
            db.insert(workflowVersions)
              .values({
                id: workflowVersionId,
                workflowId: wf.id,
                version: desiredVersion,
                // Persist the EXPANDED envelope (V2 $schemaVersion + extensions
                // + schema-parsed agents) so this row is byte-identical to what
                // bootstrap stores/re-derives from disk. Storing the minimal
                // pre-parse agents made bootstrap's content check throw a digest
                // collision. `storedWorkflowVersionMatchesMigrated` normalizes
                // the agents out for content comparison.
                manifestJson: identityManifestJson as object,
                actionsJson: (result.actions ?? null) as unknown as object,
              })
              .run();
          }
          db.insert(deployments)
            .values({
              id: deploymentId,
              tenantId: ctx.tenantId,
              target: "workflow",
              versionId: workflowVersionId,
              status: "live",
              note: input.note ?? null,
              filePath: tmpWorkflowPath, // updated to final path in phase 4
            })
            .run();
        }

        // (d) Commit per-agent generated-Artifact authority in the SAME SQLite
        // transaction as the exact workflow deployment. Selected agents carry fresh evidence
        // and activation provenance. Unchanged historical agents copy their
        // immutable evidence into a NEW row while binding activation to the
        // current promotion and complete workflow manifest.
        if (trustedFactoryPromotion && factoryAuthorization) {
          for (const row of factoryCodeActAuthorizationRows({
            ctx,
            authorization: factoryAuthorization,
            historical: result.historicalCodeActAuthorizations,
            deploymentId,
            workflowVersionId,
          })) {
            db.insert(factoryCodeActAuthorizations).values(row).run();
          }
        }

        // (e) Upsert agents + agent_versions, replace event_listeners.
        for (const a of result.migrated) {
          let agentRow = db
            .select()
            .from(agents)
            .where(and(eq(agents.workflowId, wf.id), eq(agents.kebabId, a.id)))
            .all()[0];
          if (!agentRow) {
            const aid = makeId("agt");
            const now = new Date();
            db.insert(agents)
              .values({
                id: aid,
                workflowId: wf.id,
                kebabId: a.id,
                name: a.name,
                title: a.title ?? a.name,
                actor: a.actor[0] === "Human" ? "Human" : "Agent",
                enabled: true,
                createdAt: now,
                updatedAt: now,
              })
              .run();
            agentRow = db
              .select()
              .from(agents)
              .where(eq(agents.id, aid))
              .all()[0]!;
          } else {
            db.update(agents)
              .set({
                name: a.name,
                title: a.title ?? a.name,
                actor: a.actor[0] === "Human" ? "Human" : "Agent",
                updatedAt: new Date(),
                enabled: true,
              })
              .where(eq(agents.id, agentRow.id))
              .run();
          }
          const existingAv = db
            .select()
            .from(agentVersions)
            .where(
              and(
                eq(agentVersions.agentId, agentRow.id),
                eq(agentVersions.workflowVersionId, workflowVersionId),
              ),
            )
            .all()[0];
          if (!existingAv) {
            db.insert(agentVersions)
              .values({
                id: makeId("agv"),
                agentId: agentRow.id,
                workflowVersionId,
                manifestJson: a as unknown as object,
              })
              .run();
          }
          db.delete(eventListeners)
            .where(eq(eventListeners.agentId, agentRow.id))
            .run();
          for (const trig of a.trigger) {
            db.insert(eventListeners)
              .values({ eventName: trig, agentId: agentRow.id })
              .run();
          }
        }
        // Disable agents removed by this import (preserve runs FK).
        for (const removedId of result.diff.removed) {
          db.update(agents)
            .set({ enabled: false })
            .where(
              and(eq(agents.workflowId, wf.id), eq(agents.kebabId, removedId)),
            )
            .run();
        }

        // (f) Record the durable prepare phase. This is deliberately not named
        //     `commit`: the local registry and Inngest broker have not accepted
        //     the version yet, and operation logs must not claim success for a
        //     deployment that is later compensated.
        writeAuditRequired(auditCtx, {
          tenantId: ctx.tenantId,
          action: "manifest.import.prepare",
          targetType: "workflow_version",
          targetId: workflowVersionId,
          actorUserId: auditCtx?.actorUserId,
          meta: {
            deployment_id: deploymentId,
            prior_deployment_id: priorDeploymentId,
            prior_version: result.prior.versionString,
            new_version: desiredVersion,
            diff: result.diff,
            conflicts_resolved: input.conflict_resolutions ?? [],
            file_path: tmpWorkflowPath,
            target: input.target,
            agents_count: result.migrated.length,
            schema_version: result.schemaVersion,
            tenant_slug: ctx.tenantSlug,
            promotion_of_pending: isPromotion,
            // inngest_fns_registered + final file_path + elapsed_ms are
            // appended after phase 4 via an audit follow-up row.
          },
        });
      });
      return {
        workflowVersionId,
        deploymentId,
        workflowId,
        priorDeploymentId,
        isPromotion,
      };
    })();
  } catch (err) {
    // Phase 3 is transactional, so a CAS/collision failure made no durable DB
    // change. Remove only this attempt's private staging tree.
    await rm(tmpDir, { recursive: true, force: true });
    fsyncDirectoryRequired(path.dirname(tmpDir));
    throw err;
  }

  // PHASE 4 — atomic rename + hot-swap
  // ─────────────────────────────────────────────────────────────────────
  // Reserve a target filename + rename from tmp. Atomic on POSIX. On failure
  // the DB is still consistent — the deployment row's `file_path` still
  // points at the tmp file under AGENTIC_IMPORTS_DIR, and `reconcileImports` will
  // finish the rename on next boot.
  let fileWritten = "";
  let actionsWritten = "";
  let reservedWorkflowPath = "";
  let reservedActionsPath = "";
  let renameOk = false;
  try {
    const picked = await pickAndReserveNextFilename(
      ctx.tenantSlug,
      Boolean(result.actions),
    );
    reservedWorkflowPath = picked.workflowPath;
    reservedActionsPath = result.actions ? picked.actionsPath : "";
    // The pick reserved an empty target file via O_CREAT|O_EXCL; rename
    // overwrites it atomically.
    await rename(tmpWorkflowPath, picked.workflowPath);
    fileWritten = picked.workflowPath;
    if (result.actions) {
      await rename(tmpActionsPath, picked.actionsPath);
      actionsWritten = picked.actionsPath;
    }
    fsyncDirectoryRequired(picked.targetDir);
    renameOk = true;
    db.update(deployments)
      .set({ filePath: fileWritten })
      .where(eq(deployments.id, txOut.deploymentId))
      .run();
    // A successful deployment must not leave an untracked staging tree.
    await rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    const renameError = err instanceof Error ? err : new Error(String(err));
    const recoveryErrors: Error[] = [];
    const cleanupPaths = [
      reservedWorkflowPath,
      reservedActionsPath,
      fileWritten,
      actionsWritten,
      tmpWorkflowPath,
      result.actions ? tmpActionsPath : "",
    ].filter(Boolean);
    for (const cleanupPath of new Set(cleanupPaths)) {
      try {
        await rm(cleanupPath, { force: true });
        fsyncDirectoryRequired(path.dirname(cleanupPath));
      } catch (cleanupError) {
        recoveryErrors.push(
          new Error(
            `failed to remove rejected manifest artifact ${cleanupPath}`,
            {
              cause: cleanupError,
            },
          ),
        );
      }
    }
    try {
      await rm(tmpDir, { recursive: true, force: true });
      fsyncDirectoryRequired(path.dirname(tmpDir));
    } catch (cleanupError) {
      recoveryErrors.push(
        new Error(
          `failed to remove rejected import staging directory ${tmpDir}`,
          {
            cause: cleanupError,
          },
        ),
      );
    }
    let databaseRestoreOk = false;
    try {
      restoreManifestImportPreimage({
        ctx,
        preimage,
        failedWorkflowId: txOut.workflowId,
        failedDeploymentId: txOut.deploymentId,
      });
      databaseRestoreOk = true;
    } catch (restoreError) {
      recoveryErrors.push(
        new Error("failed to restore database after manifest rename failure", {
          cause: restoreError,
        }),
      );
    }
    auditCtx?.log?.error?.(
      {
        err: renameError.message,
        deployment_id: txOut.deploymentId,
        phase: "rename",
        database_restore_ok: databaseRestoreOk,
        recovery_errors: recoveryErrors.map(
          (recoveryError) => recoveryError.message,
        ),
      },
      databaseRestoreOk && recoveryErrors.length === 0
        ? "manifest-import: atomic rename failed; last-good state restored"
        : "manifest-import: atomic rename failed; recovery incomplete",
    );
    try {
      writeAuditRequired(auditCtx, {
        tenantId: ctx.tenantId,
        action: "manifest.import.fail_rename",
        targetType: "deployment",
        targetId: txOut.deploymentId,
        meta: {
          phase: "rename",
          error: renameError.message,
          tenant_slug: ctx.tenantSlug,
          database_restore_ok: databaseRestoreOk,
          recovery_complete: databaseRestoreOk && recoveryErrors.length === 0,
          recovery_errors: recoveryErrors.map(
            (recoveryError) => recoveryError.message,
          ),
        },
      });
    } catch (auditError) {
      recoveryErrors.push(
        new Error("failed to persist manifest rename recovery audit", {
          cause: auditError,
        }),
      );
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [renameError, ...recoveryErrors],
        "manifest rename failed and last-good recovery was incomplete",
      );
    }
    throw new Error(
      "manifest rename failed; the previous deployment was restored",
      {
        cause: renameError,
      },
    );
  }

  // Hot-swap Inngest. Per inngest-registry semantics, this re-reads tenants
  // from DB so the new manifest takes effect. Per review P3: the scope is
  // already 'tenant' and `_reregisterImpl` rebuilds the full tenant set;
  // future work can scope the rebuild to a single slug.
  let inngestCount = -1;
  let activationVerification: TenantAppRegistrationVerification | undefined;
  try {
    // Dynamic import avoids a module-initialization cycle:
    // durable verifier -> review receipt -> manifest snapshot helpers.
    const { withPendingProductionGeneratedAgentActivation } =
      await import("./agent-factory/production-codeact-authorization");
    const r = await withPendingProductionGeneratedAgentActivation(
      trustedFactoryPromotion &&
        factoryAuthorization &&
        (Object.keys(factoryAuthorization.authorizedAgentManifestSha256).length > 0 ||
          Object.keys(result.historicalCodeActAuthorizations).length > 0)
        ? {
            promotionId: factoryAuthorization.promotion.promotionId,
            deploymentId: txOut.deploymentId,
            workflowVersionId: txOut.workflowVersionId,
          }
        : null,
      () =>
        reregisterInngest({
          tenantSlug: ctx.tenantSlug,
          scope: "tenant",
        }),
    );
    // #INNGEST-FIX(B1) — report THIS tenant's own app fn count, not the whole-fleet total. A scoped
    // reregister sets appFnCount = the tenant app's fns; using fnCount (all apps summed) made
    // inngest_fns_registered ~60+ instead of ~5, which broke the sandbox's waitForAppReady (its
    // per-app probe could never reach a fleet-wide expected count → appReady always false → real
    // agent failures misattributed as "environment problem, don't refine the agent"). No-slug full
    // rebuilds leave appFnCount undefined → falls back to fnCount (unchanged).
    inngestCount = r.appFnCount ?? r.fnCount;
    const sync = await syncTenantApp(ctx.tenantSlug, {
      info: (message) =>
        auditCtx?.log?.info?.({ message }, "inngest tenant sync"),
      warn: (message) =>
        auditCtx?.log?.error?.({ message }, "inngest tenant sync failed"),
    });
    if (!sync.ok) {
      throw new Error(
        `Inngest rejected tenant app sync${sync.status ? ` (${sync.status})` : ""}: ${sync.error ?? "unknown error"}`,
      );
    }
    const activation = await verifyTenantAppRegistration(
      ctx.tenantSlug,
      inngestCount,
    );
    if (!activation.verified) {
      throw new Error(
        `Inngest tenant app activation was not verified (expected=${activation.expectedFunctionCount}, observed=${String(activation.observedFunctionCount)}, connected=${activation.connected}): ${activation.error ?? "unknown error"}`,
      );
    }
    activationVerification = activation;
    assertDeploymentOwnsLiveLane(
      ctx,
      txOut.deploymentId,
      txOut.workflowVersionId,
    );
    // Success is auditable only after the database, model files, local
    // registry, and external broker all agree. An audit write failure enters
    // the same compensation path below, so the API never returns success for
    // an activation that cannot be supervised later.
    writeAuditRequired(auditCtx, {
      tenantId: ctx.tenantId,
      action: "manifest.import.commit",
      targetType: "deployment",
      targetId: txOut.deploymentId,
      meta: {
        deployment_id: txOut.deploymentId,
        workflow_version_id: txOut.workflowVersionId,
        prior_deployment_id: txOut.priorDeploymentId,
        new_version: desiredVersion,
        file_path: fileWritten,
        actions_path: actionsWritten || null,
        target: input.target,
        agents_count: result.migrated.length,
        inngest_fns_registered: inngestCount,
        inngest_app_id: activation.appId,
        inngest_activation_evidence: activation.evidence,
        inngest_activation_checked_at: activation.checkedAt,
        tenant_slug: ctx.tenantSlug,
        elapsed_ms: Date.now() - started,
      },
    });
  } catch (err) {
    // A deployment is not successful until BOTH the local registry and the
    // broker accept it. Restore disk + DB first, then rebuild/sync the prior
    // app. Recovery errors are reported but never undo an already-restored
    // database or put the failed deployment back into `live`.
    const activationError = err instanceof Error ? err : new Error(String(err));
    const recoveryErrors: Error[] = [];
    const removedArtifacts: string[] = [];
    let artifactCleanupOk = true;
    let databaseRestoreOk = false;
    let localRegistryRestoreOk = false;
    let brokerRestoreOk = false;
    let restoredFunctionCount = -1;
    let retainedReferencedAgentVersions: string[] = [];

    const artifactPaths = [
      ...new Set([fileWritten, actionsWritten].filter(Boolean)),
    ];
    for (const artifactPath of artifactPaths) {
      try {
        await rm(artifactPath, { force: true });
        fsyncDirectoryRequired(path.dirname(artifactPath));
        removedArtifacts.push(artifactPath);
      } catch (cleanupError) {
        artifactCleanupOk = false;
        recoveryErrors.push(
          new Error(
            `failed to remove rejected manifest artifact ${artifactPath}`,
            {
              cause: cleanupError,
            },
          ),
        );
      }
    }
    // Removing the artifacts can leave the model directory behind, empty. A
    // tenant folder with no workflow.json is worse than no folder at all:
    // bootstrap finds it and throws "[manifest] no workflow.json found in …",
    // which then fails every later attempt to enable the tenant's runtime —
    // a rolled-back publish would permanently brick the Domain.
    //
    // `rmdir` (not a recursive remove) can only succeed on an already-empty
    // directory, so a folder that still holds anything is left untouched.
    for (const directory of new Set(
      removedArtifacts.map((artifactPath) => path.dirname(artifactPath)),
    )) {
      try {
        await rmdir(directory);
        fsyncDirectoryRequired(path.dirname(directory));
      } catch {
        // Non-empty or already gone — both are fine.
      }
    }
    // A rename may have left an empty staging tree; removing it is part of
    // recovery but it is intentionally attempted even after an artifact error.
    try {
      await rm(tmpDir, { recursive: true, force: true });
      fsyncDirectoryRequired(path.dirname(tmpDir));
    } catch (cleanupError) {
      artifactCleanupOk = false;
      recoveryErrors.push(
        new Error(
          `failed to remove rejected import staging directory ${tmpDir}`,
          {
            cause: cleanupError,
          },
        ),
      );
    }

    try {
      const restored = restoreManifestImportPreimage({
        ctx,
        preimage,
        failedWorkflowId: txOut.workflowId,
        failedDeploymentId: txOut.deploymentId,
      });
      retainedReferencedAgentVersions =
        restored.retainedReferencedAgentVersions;
      databaseRestoreOk = true;
    } catch (restoreError) {
      recoveryErrors.push(
        new Error("failed to restore the last-good manifest database state", {
          cause: restoreError,
        }),
      );
    }

    if (databaseRestoreOk) {
      try {
        const restoredRegistry = await reregisterInngest({
          tenantSlug: ctx.tenantSlug,
          scope: "tenant",
        });
        restoredFunctionCount =
          restoredRegistry.appFnCount ?? restoredRegistry.fnCount;
        localRegistryRestoreOk = true;
      } catch (registryError) {
        recoveryErrors.push(
          new Error(
            "failed to restore the last-good in-process Inngest registry",
            {
              cause: registryError,
            },
          ),
        );
      }
    }

    if (localRegistryRestoreOk) {
      try {
        const recoveredSync = await syncTenantApp(ctx.tenantSlug, {
          info: (message) =>
            auditCtx?.log?.info?.({ message }, "inngest recovery sync"),
          warn: (message) =>
            auditCtx?.log?.error?.({ message }, "inngest recovery sync failed"),
        });
        if (!recoveredSync.ok) {
          throw new Error(
            `Inngest rejected recovery sync${
              recoveredSync.status ? ` (${recoveredSync.status})` : ""
            }: ${recoveredSync.error ?? "unknown error"}`,
          );
        }
        const recoveredActivation = await verifyTenantAppRegistration(
          ctx.tenantSlug,
          restoredFunctionCount,
        );
        if (!recoveredActivation.verified) {
          throw new Error(
            `Inngest recovery activation was not verified (expected=${recoveredActivation.expectedFunctionCount}, observed=${String(recoveredActivation.observedFunctionCount)}): ${recoveredActivation.error ?? "unknown error"}`,
          );
        }
        brokerRestoreOk = true;
      } catch (brokerError) {
        recoveryErrors.push(
          new Error(
            "failed to restore the last-good app in the Inngest broker",
            {
              cause: brokerError,
            },
          ),
        );
      }
    }

    const recoveryComplete =
      artifactCleanupOk &&
      databaseRestoreOk &&
      localRegistryRestoreOk &&
      brokerRestoreOk;
    auditCtx?.log?.error?.(
      {
        err: activationError.message,
        deployment_id: txOut.deploymentId,
        phase: "hot_swap",
        recovery_complete: recoveryComplete,
        recovery_errors: recoveryErrors.map(
          (recoveryError) => recoveryError.message,
        ),
      },
      recoveryComplete
        ? "manifest-import: hot-swap failed; last-good deployment restored"
        : "manifest-import: hot-swap failed; last-good recovery incomplete",
    );
    try {
      writeAuditRequired(auditCtx, {
        tenantId: ctx.tenantId,
        action: "manifest.import.fail_swap",
        targetType: "deployment",
        targetId: txOut.deploymentId,
        meta: {
          phase: "hot_swap",
          error: activationError.message,
          tenant_slug: ctx.tenantSlug,
          recovery_complete: recoveryComplete,
          artifact_cleanup_ok: artifactCleanupOk,
          database_restore_ok: databaseRestoreOk,
          local_registry_restore_ok: localRegistryRestoreOk,
          broker_restore_ok: brokerRestoreOk,
          removed_artifacts: removedArtifacts,
          retained_referenced_agent_versions: retainedReferencedAgentVersions,
          recovery_errors: recoveryErrors.map(
            (recoveryError) => recoveryError.message,
          ),
        },
      });
    } catch (auditError) {
      recoveryErrors.push(
        new Error("failed to persist manifest hot-swap recovery audit", {
          cause: auditError,
        }),
      );
    }

    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [activationError, ...recoveryErrors],
        "manifest hot-swap failed and last-good recovery was incomplete",
      );
    }
    throw new Error(
      "manifest hot-swap failed; the previous deployment was restored",
      { cause: activationError },
    );
  }

  // UC-V11-06 — emit `deployment.created` so connected portal sessions
  // refresh the deployments table without a manual reload. Manifest deploys
  // already get an explicit "Manifest deployed" toast at save time, so the
  // chrome only fires a hot-reload toast for `kind: 'tenant_code'`; this
  // event is mainly here for the TanStack query invalidation in
  // `apps/web/lib/hooks/useStream.ts`. Best-effort: a publish failure does
  // not roll back the commit.
  try {
    publishStreamEvent({
      type: "deployment.created",
      tenantId: ctx.tenantId,
      at: Date.now(),
      deploymentId: txOut.deploymentId,
      kind: "manifest",
      version: desiredVersion,
      workflowSlug: authoringWorkflowSlug(input, ctx),
    });
  } catch (err) {
    auditCtx?.log?.info?.(
      { err: (err as Error).message, deployment_id: txOut.deploymentId },
      "manifest-import: deployment.created publish failed (non-fatal)",
    );
  }

  const elapsedMs = Date.now() - started;
  // A concurrent successful promotion may have completed after the broker
  // receipt. Never return a stale success for a deployment that was already
  // superseded; its winner owns compensation and broker state.
  assertDeploymentOwnsLiveLane(
    ctx,
    txOut.deploymentId,
    txOut.workflowVersionId,
  );
  if (
    !activationVerification?.verified ||
    activationVerification.observedFunctionCount === null
  ) {
    throw new Error(
      "manifest activation completed without a durable Inngest registration receipt",
    );
  }
  const out: ManifestImportCommit = {
    ok: true,
    workflow_version_id: txOut.workflowVersionId,
    version: desiredVersion,
    deployment_id: txOut.deploymentId,
    target: input.target,
    inngest_fns_registered: inngestCount,
    inngest_activation: {
      verified: true,
      app_id: activationVerification.appId,
      expected_function_count: activationVerification.expectedFunctionCount,
      observed_function_count: activationVerification.observedFunctionCount,
      evidence: activationVerification.evidence,
      checked_at: activationVerification.checkedAt,
    },
    file_written: fileWritten,
    prior_deployment_id: txOut.priorDeploymentId,
    diff: result.diff,
    note: txOut.isPromotion
      ? "promoted from pending import; runtime hot-swapped"
      : "manifest imported and deployed; runtime hot-swapped",
    elapsed_ms: elapsedMs,
  };
  void renameOk; // tracked for audit clarity; not part of response shape

  return out;
}

// ---- Boot-time GC ---------------------------------------------------------

/**
 * Drop pending deployments past their TTL and remove their
 * `AGENTIC_IMPORTS_DIR/<deployment_id>/` staging dirs. Idempotent. Called from
 * `reconcileImports(...)` on api boot.
 *
 * (Naming preserved for the `bootstrap.ts` import; the heavy lifting
 * including crashed-rename recovery lives in `reconcile-imports.ts`.)
 */
export async function pruneExpiredImports(): Promise<{
  pruned: number;
  failures: number;
}> {
  const db = getDb();
  const cutoff = new Date(Date.now());
  const expired = db
    .select()
    .from(deployments)
    .where(
      and(eq(deployments.status, "pending"), lt(deployments.expiresAt, cutoff)),
    )
    .all();
  if (expired.length === 0) return { pruned: 0, failures: 0 };
  let failures = 0;
  for (const row of expired) {
    try {
      // Remove staging first. If the DB mutation fails, the durable row stays
      // discoverable and a later sweep can retry; deleting the row first left
      // filesystem orphans with no recovery key.
      await rm(path.join(importsRoot(), row.id), {
        recursive: true,
        force: true,
      });
      db.transaction(() => {
        db.delete(deployments).where(eq(deployments.id, row.id)).run();
        // The pending version is not referenced by any deployment after the
        // delete above, and validate does not create agent_versions for it.
        db.delete(workflowVersions)
          .where(eq(workflowVersions.id, row.versionId))
          .run();
      });
    } catch {
      failures += 1;
    }
  }
  return { pruned: expired.length - failures, failures };
}

// Re-export the helpers the route + tests + the agents.ts refactor need.
export const __test = {
  diffManifests,
  applyResolutions,
  overwriteGuard,
  importsRoot,
  pickNextVersion,
  captureManifestImportPreimage,
  restoreManifestImportPreimage,
  assertLiveDeploymentBaseline,
  assertDeploymentOwnsLiveLane,
  factoryCodeActAuthorizationRows,
};
